/**
 * Endpoints, well-known accounts and the two helpers every surface needs, so
 * the CLIs, the Astro endpoint and the sender cannot drift apart.
 */

import fs from 'node:fs';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';

export const SOLANA_RPC = 'https://api.devnet.solana.com';
export const EVM_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
export const BRIDGE_PROGRAM = new PublicKey('8Ki16KJ5WqV3D749GaxYPzLNzuewCeAKVTpq6xPJjp5B');
export const EVM_RELAYER = '0x13b62003C8b126Ec0748376e7ab22F79Fb8bbDF2';
export const LOOKUP_TABLE = 'DFJCyMo3Kij88o8eRnPTCx3pM4XqrQ8j5KqywDJPqcjd';
export const SEPOLIA_CHAIN = 10002;
export const SOLANA_CHAIN = 1;

/** Accepts a base58 secret key, a JSON byte array, or a path to either. */
export function solanaKeypair(value) {
  const raw = fs.existsSync(value) ? fs.readFileSync(value, 'utf8').trim() : value;
  const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

/** `key=value` command line arguments, as an object. */
export function parseArgs(argv) {
  return Object.fromEntries(
    argv.map(arg => {
      const at = arg.indexOf('=');
      return [arg.slice(0, at), arg.slice(at + 1)];
    }),
  );
}
