/**
 * The whole redemption, as a library. `index.js` (CLI) and the Astro endpoint
 * both call `redeem`, so the two surfaces cannot drift apart. Progress lines
 * go through the `log` callback; the caller decides where they end up.
 */

import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import anchor from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import wormholeSolana from '@certusone/wormhole-sdk/lib/cjs/solana/index.js';

// CJS packages without an exports map reach Node as CommonJS everywhere (CLI,
// Vite dev, Vercel), so named imports depend on what the lexer detects.
// Default import plus destructuring behaves the same in every environment.
const { Program, AnchorProvider, Wallet, BN } = anchor;
const { postVaaSolana } = wormholeSolana;
const { SecuritizeBridgeClient, fetchLookupTablesByAuthority } = createRequire(import.meta.url)(
  '@securitize/solana-bridge-sdk',
);

import { findVaaByTxHash, parseVaa, decodePayload } from './vaa.js';
import { WORMHOLE_CORE, pda, findMintForEmitter, findEvmBridgeForEmitter, resolveAccounts } from './resolve.js';
import { KeypairTransport } from './transport.js';
import {
  SOLANA_RPC,
  EVM_RPC,
  BRIDGE_PROGRAM,
  EVM_RELAYER,
  LOOKUP_TABLE,
  SEPOLIA_CHAIN,
  SOLANA_CHAIN,
  solanaKeypair,
} from './config.js';

import IDL from './securitize-bridge-idl.json' with { type: 'json' };
import EVM_ABI from './securitize-bridge-evm-abi.json' with { type: 'json' };

const RELAYER_ABI = [
  'function receiveMessage(address contractAddr, bytes message, address payeeAddress, uint256 dropOffValue)',
];

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

/** One line for humans out of whatever the SDKs throw. */
export function describeError(error) {
  return describeRevert(error) || error.reason || error.message.split('\n')[0].slice(0, 200);
}

/**
 * Each token has its own lookup table, created by the same authority that owns
 * the bridge config, so the right one is the authority's table that lists the
 * mint. The DS redemption does not fit in a transaction without it.
 */
async function findLookupTable(connection, mint, authority) {
  for (const address of await fetchLookupTablesByAuthority(connection, authority)) {
    const table = (await connection.getAddressLookupTable(address)).value;
    if (table?.state.addresses.some(entry => entry.equals(mint))) return address;
  }
  return null;
}

/** Sepolia -> Solana: post the VAA, then mint through the flow the mint's config asks for. */
async function redeemOnSolana(vaaBytes, vaa, payload, privKey, log) {
  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const payer = solanaKeypair(privKey);

  const mint = await findMintForEmitter(conn, BRIDGE_PROGRAM, IDL, vaa.emitterChain, vaa.emitterAddress);
  if (!mint) throw new Error('no bridge config matches the VAA emitter');

  const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' });
  const client = await SecuritizeBridgeClient.from(
    mint,
    new KeypairTransport(payer, provider),
    provider,
  );
  const { tokenConfig } = client.bridgeConfigState;
  const isDsToken = 'ds' in tokenConfig;

  log(`${isDsToken ? 'DS' : 'SPL'} mint ${mint.toBase58()} | payer ${payer.publicKey.toBase58()}`);
  log(`${payload.value} to ${payload.destinationWallet.toBase58()} (investor ${payload.investorId})`);

  const posted = pda([Buffer.from('PostedVAA'), vaa.hash], WORMHOLE_CORE);
  if (!(await conn.getAccountInfo(posted))) {
    await postVaaSolana(
      conn,
      async tx => { tx.partialSign(payer); return tx; },
      WORMHOLE_CORE.toBase58(),
      payer.publicKey,
      vaaBytes,
    );
    log('VAA posted');
  }

  if (isDsToken) {
    // The SDK derives the RBAC accounts, and the investor id travels in the payload.
    const lut = await findLookupTable(conn, mint, client.bridgeConfigState.owner);
    if (!lut) throw new Error('no lookup table lists this mint; the DS redemption will not fit');
    return client.executeVaaV1({
      vaaHash: Array.from(vaa.hash),
      emitterChain: vaa.emitterChain,
      sequence: vaa.sequence,
      investorId: payload.investorId,
      recipientWallet: payload.destinationWallet,
      lutAddresses: [lut],
    });
  }

  const accounts = await resolveAccounts(conn, {
    bridgeProgram: BRIDGE_PROGRAM,
    mint,
    payer: payer.publicKey,
    recipient: payload.destinationWallet,
    emitterChain: vaa.emitterChain,
    sequence: vaa.sequence,
    vaaHash: vaa.hash,
    aclProgram: tokenConfig.spl.aclProgramId,
    registryProgram: tokenConfig.spl.splTokenRegistryProgramId,
  });

  const program = new Program({ ...IDL, address: BRIDGE_PROGRAM.toBase58() }, provider);
  const ix = await program.methods
    .executeVaaV1Spl(Array.from(vaa.hash), vaa.emitterChain, new BN(vaa.sequence))
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
async function redeemOnEvm(vaaBytes, vaa, payload, privKey, log) {
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
  if (!bridge) throw new Error('could not resolve the EVM bridge from the Solana config');

  log(`bridge ${bridge} (mint ${mint.toBase58()}) | payer ${wallet.address}`);
  log(`${payload.value} to ${recipient} (investor ${payload.investorId})`);

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

/**
 * Redeem the transfer sent by `tx`, in whichever direction it got stuck. The
 * source chain comes from the hash format: a `0x` hash left Sepolia and is
 * redeemed on Solana, anything else left Solana and is redeemed on Sepolia.
 * `privKey` pays the fees on the destination chain; tokens always go to the
 * recipient named in the VAA.
 */
export async function redeem(tx, privKey, log = () => {}) {
  // Hashes get pasted with surrounding punctuation more often than not.
  const hash = tx.trim().replace(/[^0-9a-zA-Z]+$/, '');
  const fromSepolia = hash.startsWith('0x');
  const sourceChain = fromSepolia ? SEPOLIA_CHAIN : SOLANA_CHAIN;

  const found = await findVaaByTxHash('testnet', hash, sourceChain);
  if (!found) throw new Error(`no Wormhole operation for ${hash}; check the transaction hash`);
  if (!found.vaa) throw new Error('the guardians have not signed this VAA yet');

  const vaa = parseVaa(found.vaa);
  const payload = decodePayload(vaa.payload);
  log(`origin ${fromSepolia ? 'Sepolia' : 'Solana'} | sequence ${vaa.sequence}`);

  const signature = fromSepolia
    ? await redeemOnSolana(found.vaa, vaa, payload, privKey, log)
    : await redeemOnEvm(found.vaa, vaa, payload, privKey, log);

  log(`redeemed: ${signature}`);
  return signature;
}
