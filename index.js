#!/usr/bin/env node
'use strict';

/**
 * Redeem a stuck Securitize bridge transfer, in whichever direction it got stuck.
 *
 *   node index.js tx=0x<sepolia tx> privKey=<solana key>   # mints on Solana
 *   node index.js tx=<solana sig>   privKey=<evm key>      # mints on Sepolia
 *
 * The source chain comes from the hash format, so the direction is implied: a
 * `0x` hash left Sepolia and has to be redeemed on Solana, anything else left
 * Solana and has to be redeemed on Sepolia. The key is the one that pays the
 * fees on the chain being redeemed; tokens always go to the recipient named in
 * the VAA. Everything else is read from the VAA and from chain.
 */

const fs = require('fs');
const anchor = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const { ethers } = require('ethers');
const {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} = require('@solana/web3.js');
const { postVaaSolana } = require('@certusone/wormhole-sdk/lib/cjs/solana');

const { findVaaByTxHash, parseVaa, decodePayload } = require('./lib/vaa');
const { WORMHOLE_CORE, pda, findMintForEmitter, findEvmBridgeForEmitter, resolveAccounts } = require('./lib/resolve');

const SOLANA_RPC = 'https://api.devnet.solana.com';
const EVM_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const BRIDGE_PROGRAM = new PublicKey('8Ki16KJ5WqV3D749GaxYPzLNzuewCeAKVTpq6xPJjp5B');
const EVM_RELAYER = '0x13b62003C8b126Ec0748376e7ab22F79Fb8bbDF2';
const LOOKUP_TABLE = 'DFJCyMo3Kij88o8eRnPTCx3pM4XqrQ8j5KqywDJPqcjd';
const SEPOLIA_CHAIN = 10002;
const SOLANA_CHAIN = 1;

const IDL = require('./lib/securitize-bridge-idl.json');
const EVM_ABI = require('./lib/securitize-bridge-evm-abi.json');
const RELAYER_ABI = [
  'function receiveMessage(address contractAddr, bytes message, address payeeAddress, uint256 dropOffValue)',
];

/** Accepts a base58 secret key, a JSON byte array, or a path to either. */
function solanaKeypair(value) {
  const raw = fs.existsSync(value) ? fs.readFileSync(value, 'utf8').trim() : value;
  const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

/** Turn a revert selector into the bridge's own error name. */
function describeRevert(error) {
  let data = null;
  for (let current = error; current && !data; current = current.error) {
    const raw = typeof current.data === 'string' ? current.data : current.data?.data;
    if (typeof raw === 'string' && raw.length >= 10) data = raw;
  }
  if (!data) return null;
  const selector = data.slice(0, 10).toLowerCase();
  for (const item of EVM_ABI) {
    if (item.type !== 'error') continue;
    const signature = `${item.name}(${item.inputs.map(i => i.type).join(',')})`;
    if (ethers.utils.id(signature).slice(0, 10).toLowerCase() === selector) return signature;
  }
  return null;
}

/** Sepolia -> Solana: post the VAA, then mint through execute_vaa_v1_spl. */
async function redeemOnSolana(vaaBytes, vaa, payload, privKey) {
  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const payer = solanaKeypair(privKey);

  const mint = await findMintForEmitter(conn, BRIDGE_PROGRAM, IDL, vaa.emitterChain, vaa.emitterAddress);
  if (!mint) throw new Error('ninguna config del bridge corresponde al emitter del VAA');

  const config = await conn.getAccountInfo(pda([Buffer.from('config'), mint.toBuffer()], BRIDGE_PROGRAM));
  const tokenConfig = new anchor.BorshAccountsCoder(IDL).decode('BridgeConfig', config.data).token_config;
  if (!tokenConfig.Spl) throw new Error('este mint es DS, usa execute_vaa_v1, otro flujo');

  const accounts = await resolveAccounts(conn, {
    bridgeProgram: BRIDGE_PROGRAM,
    mint,
    payer: payer.publicKey,
    recipient: payload.destinationWallet,
    emitterChain: vaa.emitterChain,
    sequence: vaa.sequence,
    vaaHash: vaa.hash,
    aclProgram: tokenConfig.Spl.acl_program_id,
    registryProgram: tokenConfig.Spl.spl_token_registry_program_id,
  });

  console.log(`mint ${mint.toBase58()} | paga ${payer.publicKey.toBase58()}`);
  console.log(`${payload.value} a ${payload.destinationWallet.toBase58()} (investor ${payload.investorId})`);

  if (!(await conn.getAccountInfo(accounts.posted))) {
    await postVaaSolana(
      conn,
      async tx => { tx.partialSign(payer); return tx; },
      WORMHOLE_CORE.toBase58(),
      payer.publicKey,
      vaaBytes,
    );
    console.log('VAA posteado');
  }

  const program = new anchor.Program(
    { ...IDL, address: BRIDGE_PROGRAM.toBase58() },
    new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: 'confirmed' }),
  );
  const ix = await program.methods
    .executeVaaV1Spl(Array.from(vaa.hash), vaa.emitterChain, new anchor.BN(vaa.sequence))
    .accountsPartial(accounts)
    .instruction();

  const lut = (await conn.getAddressLookupTable(new PublicKey(LOOKUP_TABLE))).value;
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ix],
    }).compileToV0Message(lut ? [lut] : []),
  );
  tx.sign([payer]);

  const signature = await conn.sendTransaction(tx);
  await conn.confirmTransaction(signature, 'confirmed');
  return signature;
}

/** Solana -> Sepolia: call receiveMessage on the Executor's relayer. */
async function redeemOnEvm(vaaBytes, vaa, payload, privKey) {
  const wallet = new ethers.Wallet(
    privKey.startsWith('0x') ? privKey : `0x${privKey}`,
    new ethers.providers.JsonRpcProvider(EVM_RPC),
  );
  const recipient = ethers.utils.getAddress(
    '0x' + Buffer.from(payload.destinationWallet.toBytes()).slice(12).toString('hex'),
  );

  // The pairing lives on Solana: emitter PDA -> mint -> bridge_address(target chain).
  const { mint, bridge } = await findEvmBridgeForEmitter(
    new Connection(SOLANA_RPC, 'confirmed'),
    BRIDGE_PROGRAM,
    IDL,
    vaa.emitterAddress,
    payload.targetChain,
  );
  if (!bridge) throw new Error('no se pudo resolver el bridge EVM desde la config de Solana');

  console.log(`bridge ${bridge} (mint ${mint.toBase58()}) | paga ${wallet.address}`);
  console.log(`${payload.value} a ${recipient} (investor ${payload.investorId})`);

  const relayer = new ethers.Contract(EVM_RELAYER, RELAYER_ABI, wallet);
  // No explicit gasLimit on purpose: ethers estimates gas first, so a revert
  // surfaces with its reason before anything is sent or paid for.
  const tx = await relayer.receiveMessage(
    bridge,
    ethers.utils.hexlify(vaaBytes),
    ethers.constants.AddressZero,
    0,
  );
  return (await tx.wait()).transactionHash;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(arg => {
      const at = arg.indexOf('=');
      return [arg.slice(0, at), arg.slice(at + 1)];
    }),
  );
  if (!args.tx || !args.privKey) {
    throw new Error('uso: node index.js tx=<hash> privKey=<clave del que paga>');
  }

  const fromSepolia = args.tx.startsWith('0x');
  const sourceChain = fromSepolia ? SEPOLIA_CHAIN : SOLANA_CHAIN;

  const found = await findVaaByTxHash('testnet', args.tx, sourceChain);
  if (!found?.vaa) throw new Error('los guardianes todavia no firmaron el VAA');

  const vaa = parseVaa(found.vaa);
  const payload = decodePayload(vaa.payload);
  console.log(`origen ${fromSepolia ? 'Sepolia' : 'Solana'} | sequence ${vaa.sequence}`);

  const signature = fromSepolia
    ? await redeemOnSolana(found.vaa, vaa, payload, args.privKey)
    : await redeemOnEvm(found.vaa, vaa, payload, args.privKey);

  console.log(`redimido: ${signature}`);
}

main().catch(error => {
  const revert = describeRevert(error);
  const short = error.reason || error.message.split('\n')[0].slice(0, 200);
  console.error(`error: ${revert || short}`);
  if (error.logs) console.error(error.logs.slice(-6).join('\n'));
  process.exit(1);
});
