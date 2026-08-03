/**
 * Start a bridge transfer out of Solana, mirroring `BridgeContract.bridge` in
 * the redemption front end (`wrappers/solana/solana.bridge.ts`): same SDK, same
 * parameter object, same DS / SPL branch. The only intentional difference is
 * the transport, which signs with a keypair instead of a browser wallet, so a
 * failure here means the front end would fail the same way.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ethers } from 'ethers';

import { KeypairTransport } from './transport.js';
import { SecuritizeBridgeClient } from './sdk.js';
import {
  SOLANA_RPC,
  EVM_RPC,
  LOOKUP_TABLE,
  SEPOLIA_CHAIN,
  SOLANA_CHAIN,
  solanaKeypair,
} from './config.js';

const { AnchorProvider, Wallet } = anchor;

/** The bridge takes the recipient as 32 bytes; an EVM address is left-padded. */
function encodeRecipient(recipient) {
  return ethers.utils.arrayify(ethers.utils.hexZeroPad(ethers.utils.getAddress(recipient), 32));
}

/**
 * Bridge `amount` of `mint` (in token units, not raw) from the wallet behind
 * `privKey` to an EVM `recipient` on Sepolia. The sender pays the Wormhole fee
 * plus the Executor quote, and must hold the tokens and be registered for the
 * token. `investorId` is required for DS tokens and ignored for SPL; `lut`
 * overrides the lookup table when the token has its own.
 */
async function sendFromSolana(mint, amount, recipient, privKey, options, log) {
  if (!recipient.startsWith('0x')) throw new Error('the recipient must be an EVM address');

  const { investorId, lut = LOOKUP_TABLE } = options;
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const payer = solanaKeypair(privKey);
  const mintKey = new PublicKey(mint);

  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });
  const client = await SecuritizeBridgeClient.from(
    mintKey,
    new KeypairTransport(payer, provider),
    provider,
  );

  const mintInfo = await connection.getParsedAccountInfo(mintKey);
  const tokenProgram = mintInfo.value.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const { decimals } = mintInfo.value.data.parsed.info;
  const rawAmount = BigInt(ethers.utils.parseUnits(String(amount), decimals).toString());

  let quote = await client.getExecutionQuote({ targetChain: SEPOLIA_CHAIN });

  const params = {
    targetChain: SEPOLIA_CHAIN,
    amount: rawAmount,
    recipient: encodeRecipient(recipient),
    execAmount: quote.execAmount,
    lutAddresses: lut ? [new PublicKey(lut)] : undefined,
    signedQuoteBytes: quote.signedQuoteBytes,
    options: {
      customAccounts: {
        tokenProgram,
      },
    },
    retry: {
      // The quote expires; refresh it if the first attempt raced a sequence bump.
      refreshExecutorQuote: async () => {
        quote = await client.getExecutionQuote({ targetChain: SEPOLIA_CHAIN });
        return { signedQuoteBytes: quote.signedQuoteBytes, execAmount: quote.execAmount };
      },
    },
  };

  // BridgeConfig.tokenConfig is a Ds | Spl discriminated union set at initialize
  const isDsToken = 'ds' in client.bridgeConfigState.tokenConfig;

  log(`${isDsToken ? 'DS' : 'SPL'} token | sender ${payer.publicKey.toBase58()}`);
  log(`${rawAmount} of ${mint} to ${recipient} on Sepolia | executor fee ${quote.execAmount}`);

  let signature;
  if (isDsToken) {
    if (!investorId) throw new Error('investorId is required to bridge DS tokens');
    signature = await client.bridgeDsTokens({ ...params, investorId });
  } else {
    signature = await client.bridgeSplTokens(params);
  }

  log(`sent: ${signature}`);
  return signature;
}

const EVM_BRIDGE_ABI = [
  'function dsToken() view returns (address)',
  'function quoteBridge(uint16 targetChain) view returns (uint256)',
  'function bridgeDSTokens(uint16 targetChain, uint256 amount) payable',
  'function bridgeDSTokensToAddress(uint16 targetChain, uint256 amount, bytes32 destination) payable',
];

/**
 * Sepolia -> Solana, mirroring `BridgeContract.bridge` in wrappers/evm: read the
 * DS token for its decimals, quote the bridge, and call the `ToAddress` variant
 * because a Solana target always needs an explicit destination. The EVM side is
 * the same call for a DS or an SPL counterpart: which instruction runs on Solana
 * is the Executor's choice, from the mint's bridge config.
 */
async function sendFromEvm(bridgeAddress, amount, recipient, privKey, log) {
  const wallet = new ethers.Wallet(
    privKey.startsWith('0x') ? privKey : `0x${privKey}`,
    new ethers.providers.JsonRpcProvider(EVM_RPC),
  );
  const bridge = new ethers.Contract(bridgeAddress, EVM_BRIDGE_ABI, wallet);

  const token = await bridge.dsToken();
  const decimals = await new ethers.Contract(
    token,
    ['function decimals() view returns (uint8)'],
    wallet,
  ).decimals();
  const rawAmount = ethers.utils.parseUnits(String(amount), decimals);
  const cost = await bridge.quoteBridge(SOLANA_CHAIN);

  log(`bridge ${bridgeAddress} (token ${token}) | sender ${wallet.address}`);
  log(`${rawAmount} to ${recipient} on Solana | bridge cost ${ethers.utils.formatEther(cost)} ETH`);

  const destination = ethers.utils.hexlify(new PublicKey(recipient).toBytes());
  const tx = await bridge.bridgeDSTokensToAddress(SOLANA_CHAIN, rawAmount, destination, {
    value: cost,
  });
  const receipt = await tx.wait();

  log(`sent: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

/**
 * Bridge `amount` of `token` (in token units, not raw) to `recipient`, in the
 * direction implied by the token format. `privKey` signs on the source chain.
 * `investorId` is required for DS tokens leaving Solana and ignored otherwise;
 * `lut` overrides the lookup table on the Solana side.
 */
export async function send(token, amount, recipient, privKey, options = {}, log = () => {}) {
  return token.startsWith('0x')
    ? sendFromEvm(token, amount, recipient, privKey, log)
    : sendFromSolana(token, amount, recipient, privKey, options, log);
}
