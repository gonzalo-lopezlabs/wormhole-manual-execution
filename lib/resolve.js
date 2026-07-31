import bs58 from 'bs58';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import anchor from '@coral-xyz/anchor';

const { BorshAccountsCoder } = anchor;

export const WORMHOLE_CORE = new PublicKey('3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export const SEED = {
  config: Buffer.from('config'),
  bridgeAuthority: Buffer.from('bridge_authority'),
  emitter: Buffer.from('emitter'),
  emitterAddress: Buffer.from('emitter_address'),
  bridgeAddress: Buffer.from('bridge_address'),
  consumed: Buffer.from('consumed'),
  received: Buffer.from('received'),
  postedVaa: Buffer.from('PostedVAA'),
  investorRegistry: Buffer.from('investor_registry'),
  eventAuthority: Buffer.from('__event_authority'),
};

export const u16le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
export const u64le = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/**
 * The Solana side is configured per token, so the mint is what ties a VAA to a
 * BridgeConfig. The VAA payload does not carry it, so we walk the bridge's
 * BridgeConfig accounts and keep the one whose bridge_address for the emitter
 * chain matches the VAA emitter. Pass `mint` to skip the lookup.
 */
export async function findMintForEmitter(conn, bridgeProgram, idl, emitterChain, emitterHex) {
  for (const { mint } of await listConfigs(conn, bridgeProgram, idl)) {
    const addr = pda([SEED.bridgeAddress, mint.toBuffer(), u16le(emitterChain)], bridgeProgram);
    const info = await conn.getAccountInfo(addr);
    if (!info) continue;

    // BridgeAddress: 8 disc + 2 chain + 32 address + 1 bump
    const remote = info.data.slice(10, 42).toString('hex');
    if (remote === emitterHex.toLowerCase()) return mint;
  }
  return null;
}

/** Every mint the bridge program has a config for, decoded. */
export async function listConfigs(conn, bridgeProgram, idl) {
  const coder = new BorshAccountsCoder(idl);
  const entry = idl.accounts.find(a => a.name === 'BridgeConfig');
  if (!entry?.discriminator) throw new Error('the IDL carries no discriminator for BridgeConfig');
  const accounts = await conn.getProgramAccounts(bridgeProgram, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(entry.discriminator)) } }],
  });

  const out = [];
  for (const { account } of accounts) {
    try {
      const config = coder.decode('BridgeConfig', account.data);
      const mint = config.asset_mint ?? config.assetMint;
      if (mint) out.push({ mint, config });
    } catch {
      // older layout from a previous program version
    }
  }
  return out;
}

/**
 * Going the other way (Solana -> EVM) the VAA emitter is the Solana emitter PDA,
 * derived from the mint. Match it to find the mint, then read the remote bridge
 * the config trusts for the target chain: that is the EVM contract to call.
 */
export async function findEvmBridgeForEmitter(conn, bridgeProgram, idl, emitterHex, targetChain) {
  const wanted = Buffer.from(emitterHex, 'hex');

  for (const { mint } of await listConfigs(conn, bridgeProgram, idl)) {
    const emitter = pda([SEED.emitter, mint.toBuffer()], bridgeProgram);
    if (!emitter.toBuffer().equals(wanted)) continue;

    const addr = pda([SEED.bridgeAddress, mint.toBuffer(), u16le(targetChain)], bridgeProgram);
    const info = await conn.getAccountInfo(addr);
    if (!info) return { mint, bridge: null };

    // BridgeAddress: 8 disc + 2 chain + 32 address + 1 bump; EVM uses the last 20 bytes
    const bridge = '0x' + info.data.slice(10, 42).toString('hex').slice(24);
    return { mint, bridge };
  }
  return { mint: null, bridge: null };
}

/** Every account `execute_vaa_v1_spl` needs, derived rather than hardcoded. */
export async function resolveAccounts(conn, opts) {
  const { bridgeProgram, mint, payer, recipient, emitterChain, sequence, vaaHash, aclProgram, registryProgram } = opts;

  const mintInfo = await conn.getParsedAccountInfo(mint);
  const mintAuthority = mintInfo.value?.data?.parsed?.info?.mintAuthority;
  if (!mintAuthority) throw new Error(`cannot read the mint authority of ${mint.toBase58()}`);

  // The ACL keeps one state account per mint, with the mint at offset 40.
  const aclAccounts = await conn.getProgramAccounts(aclProgram, {
    filters: [{ memcmp: { offset: 40, bytes: mint.toBase58() } }],
  });
  if (aclAccounts.length !== 1) {
    throw new Error(`expected 1 ACL state account for the mint, found ${aclAccounts.length}`);
  }

  return {
    payer,
    config: pda([SEED.config, mint.toBuffer()], bridgeProgram),
    bridgeAuthority: pda([SEED.bridgeAuthority, mint.toBuffer()], bridgeProgram),
    emitterAddress: pda([SEED.emitterAddress, mint.toBuffer(), u16le(emitterChain)], bridgeProgram),
    consumedVaa: pda([SEED.consumed, vaaHash], bridgeProgram),
    received: pda([SEED.received, mint.toBuffer(), u16le(emitterChain), u64le(sequence)], bridgeProgram),
    posted: pda([SEED.postedVaa, vaaHash], WORMHOLE_CORE),
    assetMint: mint,
    recipientWallet: recipient,
    investorRegistry: pda([SEED.investorRegistry, mint.toBuffer(), recipient.toBuffer()], registryProgram),
    recipientTokenAccount: getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    aclProgram,
    accessControlAuthority: new PublicKey(mintAuthority),
    accessControlState: aclAccounts[0].pubkey,
    aclEventAuthority: pda([SEED.eventAuthority], aclProgram),
    eventAuthority: pda([SEED.eventAuthority], bridgeProgram),
    program: bridgeProgram,
  };
}
