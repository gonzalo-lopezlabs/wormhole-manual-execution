#!/usr/bin/env node

/**
 * Start a bridge transfer, the same request the redemption front end makes. The
 * direction comes from the token format.
 *
 *   node send.js token=<solana mint>   amount=<n> recipient=0x<evm>      privKey=<solana key>
 *   node send.js token=0x<evm bridge>  amount=<n> recipient=<solana pubkey> privKey=<evm key>
 *
 * `investorId=` is required for DS tokens leaving Solana, `lut=` overrides the
 * lookup table. Thin CLI over lib/send.js. See that file and README.md.
 */

import { parseArgs } from './lib/config.js';
import { send } from './lib/send.js';
import { describeError } from './lib/redeem.js';

const args = parseArgs(process.argv.slice(2));

if (!args.token || !args.amount || !args.recipient || !args.privKey) {
  console.error(
    'usage: node send.js token=<mint|0x bridge> amount=<tokens> recipient=<destination> privKey=<key> [investorId=<id>] [lut=<table>]',
  );
  process.exit(1);
}

send(
  args.token,
  args.amount,
  args.recipient,
  args.privKey,
  { investorId: args.investorId, lut: args.lut },
  console.log,
).catch(error => {
  console.error(`error: ${describeError(error)}`);
  if (error.logs) console.error(error.logs.slice(-6).join('\n'));
  process.exit(1);
});
