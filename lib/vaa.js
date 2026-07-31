import https from 'node:https';
import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';

const WORMHOLESCAN = {
  testnet: 'https://api.testnet.wormholescan.io',
  mainnet: 'https://api.wormholescan.io',
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (error) {
            reject(new Error(`${url} -> ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Wormholescan can return more than one attestation for the same source tx (a
 * mainnet-numbered one shows up as an indexing quirk). Keep the one whose
 * emitter chain matches the chain the transfer actually left from.
 */
export async function findVaaByTxHash(network, txHash, expectedChain) {
  const base = WORMHOLESCAN[network];
  const { json } = await getJson(`${base}/api/v1/operations?txHash=${txHash}`);
  const operations = json.operations ?? (Array.isArray(json) ? json : []);
  if (!operations.length) return null;

  const matches = operations.filter(op => Number(op.emitterChain) === expectedChain);
  const chosen = matches[0] ?? operations[0];
  if (matches.length === 0) {
    console.warn(
      `warning: no attestation from chain ${expectedChain}; falling back to chain ${chosen.emitterChain}`,
    );
  }

  return {
    emitterChain: Number(chosen.emitterChain),
    emitterHex: chosen.emitterAddress.hex,
    sequence: Number(chosen.sequence),
    vaa: chosen.vaa?.raw ? Buffer.from(chosen.vaa.raw, 'base64') : null,
  };
}

export async function fetchVaa(network, emitterChain, emitterHex, sequence) {
  const base = WORMHOLESCAN[network];
  const { status, json } = await getJson(
    `${base}/api/v1/vaas/${emitterChain}/${emitterHex}/${sequence}`,
  );
  if (status !== 200 || !json.data?.vaa) return null;
  return Buffer.from(json.data.vaa, 'base64');
}

/** Split a VAA into its signature block and body; the body hash keys the PDAs. */
export function parseVaa(vaa) {
  const signatureCount = vaa[5];
  const body = vaa.slice(6 + signatureCount * 66);
  const hash = Buffer.from(keccak_256(body));

  return {
    version: vaa[0],
    guardianSetIndex: vaa.readUInt32BE(1),
    signatureCount,
    emitterChain: body.readUInt16BE(8),
    emitterAddress: body.slice(10, 42).toString('hex'),
    sequence: Number(body.readBigUInt64BE(42)),
    consistencyLevel: body[50],
    payload: body.slice(51),
    hash,
  };
}

/**
 * The bridge payload is Solidity
 * `abi.encode(uint16, string, uint256, bytes32, bytes32, string, uint256[], uint256[])`,
 * so every head word is 32 bytes and the two wallets sit in words 3 and 4.
 */
export function decodePayload(payload) {
  const word = i => payload.slice(i * 32, (i + 1) * 32);
  const readString = offsetWord => {
    const start = Number(BigInt('0x' + word(offsetWord).toString('hex')));
    const length = Number(BigInt('0x' + payload.slice(start, start + 32).toString('hex')));
    return payload.slice(start + 32, start + 32 + length).toString('utf8');
  };

  return {
    targetChain: payload.readUInt16BE(30),
    investorId: readString(1),
    value: BigInt('0x' + word(2).toString('hex')).toString(),
    investorWallet: new PublicKey(word(3)),
    destinationWallet: new PublicKey(word(4)),
    country: readString(5),
  };
}
