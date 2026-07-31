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

import { redeem, describeError } from './lib/redeem.js';

const args = Object.fromEntries(
  process.argv.slice(2).map(arg => {
    const at = arg.indexOf('=');
    return [arg.slice(0, at), arg.slice(at + 1)];
  }),
);

if (!args.tx || !args.privKey) {
  console.error('uso: node index.js tx=<hash> privKey=<clave del que paga>');
  process.exit(1);
}

redeem(args.tx, args.privKey, console.log).catch(error => {
  console.error(`error: ${describeError(error)}`);
  if (error.logs) console.error(error.logs.slice(-6).join('\n'));
  process.exit(1);
});
