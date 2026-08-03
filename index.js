#!/usr/bin/env node

/**
 * Redeem a stuck Securitize bridge transfer, in whichever direction it got stuck.
 *
 *   node index.js tx=0x<sepolia tx> privKey=<solana key>   # mints on Solana
 *   node index.js tx=<solana sig>   privKey=<evm key>      # mints on Sepolia
 *
 * Thin CLI over lib/redeem.js, which the web UI shares. See that file and
 * README.md for what actually happens.
 */

import { parseArgs } from './lib/config.js';
import { redeem, describeError } from './lib/redeem.js';

const args = parseArgs(process.argv.slice(2));

if (!args.tx || !args.privKey) {
  console.error('usage: node index.js tx=<hash> privKey=<key that pays the fees>');
  process.exit(1);
}

redeem(args.tx, args.privKey, console.log).catch(error => {
  console.error(`error: ${describeError(error)}`);
  if (error.logs) console.error(error.logs.slice(-6).join('\n'));
  process.exit(1);
});
