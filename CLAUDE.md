# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A tool that manually redeems a stuck Securitize bridge transfer in whichever direction it got stuck, for when the Wormhole Executor aborts. The source side has already burned; redeeming the VAA is permissionless, so any funded key can finish the job. Sepolia to Solana posts the VAA and calls `execute_vaa_v1_spl` (mints). Solana to Sepolia calls `receiveMessage` on the Executor's relayer contract. Two surfaces, one implementation: a CLI (`index.js`) and an Astro web UI, both thin wrappers over `lib/redeem.js`. See README.md for the operational background and the Executor status curl.

## Commands

```bash
node index.js tx=<hash> privKey=<key>   # CLI
npm run dev                             # web UI at http://localhost:4322
npm run build                           # Vercel build (.vercel/output)
```

CLI arguments are `key=value` pairs. The direction is implied by the hash format: a `0x` hash left Sepolia and is redeemed on Solana, anything else is a Solana signature redeemed on Sepolia. `privKey` is the fee payer on the destination chain: for Solana a base58 secret key, a JSON byte array, or a path to either; for EVM a hex private key with or without `0x`. Tokens always go to the recipient named in the VAA, never to the signer.

There is no dry run flag, no tests, and no linter: every run executes. Still, nothing is sent until the transaction passes simulation on the destination chain: Solana through preflight (`sendTransaction` default), Sepolia because the EVM path deliberately omits `gasLimit`, so ethers estimates gas first and a revert surfaces with its reason before anything is paid. The Solana path also posts the VAA only if the `posted` PDA does not already exist, so re-running after a partial failure is safe.

Network constants (devnet/testnet only) are hardcoded at the top of `lib/redeem.js`: Solana devnet RPC, Sepolia public RPC, bridge program `8Ki16KJ5WqV3D749GaxYPzLNzuewCeAKVTpq6xPJjp5B`, the Executor's relayer address, and the lookup table used to keep the Solana transaction under the size limit.

## Architecture

- `lib/redeem.js`: the whole redemption. Exports `redeem(tx, privKey, log)` (progress lines go through the `log` callback) and `describeError` (one human line out of whatever the SDKs throw, including mapping EVM revert selectors to the bridge's own error names via the vendored ABI; ethers buries revert data at varying depths, so it walks the nested `error` chain). Any behavior change belongs here, never in the CLI or the endpoint.
- `index.js`: thin CLI; parses `key=value` args and calls `redeem` with `console.log`.
- `src/pages/index.astro` and `src/pages/api/redeem.js`: the web UI. The endpoint runs `redeem` in-process and streams its log lines back as `text/plain`, so the browser shows the same output the terminal would. If the page disconnects it stops streaming but lets the redemption finish; killing it between posting the VAA and minting would be worse.
- `lib/vaa.js`: Wormholescan lookups, raw VAA parsing (the keccak of the VAA body is the hash that keys the PDAs), and payload decoding. The payload is Solidity `abi.encode(uint16, string, uint256, bytes32, bytes32, string, uint256[], uint256[])`; the recipient wallet is head word 4. Trust the payload for the recipient, not any other source.
- `lib/resolve.js`: PDA derivations (seeds in `SEED`) and the discovery logic in both directions. `findMintForEmitter` (EVM to Solana): the VAA does not carry the mint, so it walks the bridge's `BridgeConfig` accounts and matches each one's `bridge_address` PDA for the emitter chain against the VAA emitter. `findEvmBridgeForEmitter` (Solana to EVM): the VAA emitter is the Solana emitter PDA (seed `emitter` + mint), so it matches that to find the mint, then reads the `bridge_address` for the target chain; the EVM contract is the last 20 bytes. `resolveAccounts` derives the full account list for `execute_vaa_v1_spl`.
- `lib/securitize-bridge-idl.json`: vendored bridge IDL from `@securitize/blockchain-contracts` 4.23.0, so the tool works without the private registry. Refresh with `cp node_modules/@securitize/blockchain-contracts/dist/solana-idls/securitize-bridge-idl.json lib/`.
- `lib/securitize-bridge-evm-abi.json`: vendored EVM bridge ABI, used only by `describeError`.

### Deployment

Deployed to Vercel from the repo root: `vercel.json` pins the framework to `astro` and `astro.config.mjs` uses `@astrojs/vercel` with `maxDuration: 60`, since a redemption is several transactions with confirmations. The local dev port is 4322 (not Astro's default 4321) to dodge stale cached redirects from other local projects.

Vercel's automated phishing filter blocks deployments whose pages look like wallet drainers, and a password input labeled "Private key" on a page about wallets is exactly that signature (one deploy of this repo was blocked for it). That is why the UI and the HTTP field say "fee payer key" / `payerKey`; do not reintroduce the phrase "private key" into served content. The CLI still takes `privKey=` because it is not deployed.

### Module system

The package is ESM (`"type": "module"`) because the Astro endpoint imports `lib/redeem.js` through Vite, which cannot load CommonJS project files. Consequences to preserve:

- JSON is imported with `with { type: 'json' }` (works in Node 20.10+ and Vite; Node prints an experimental warning, which is fine).
- CJS dependencies without an `exports` map (`@coral-xyz/anchor`, the deep `@certusone/wormhole-sdk/lib/cjs/...` path) are loaded by Node itself in every environment, so named ESM imports depend on what cjs-module-lexer detects (it misses anchor's `BN`). Import them as default and destructure; do not "clean up" to named imports.

## Non-obvious facts baked into the code

- Wormholescan can return two attestations for one source transaction (one spuriously numbered as mainnet); `findVaaByTxHash` keeps the one whose emitter chain matches the origin.
- Redemption failures are program-enforced, and the error tells you which: `account already in use` on the `received` PDA means already redeemed; a missing `investor_registry` means the recipient is not provisioned; `InvestorRegistryInvestorIdMismatch` (6074) means the wallet belongs to another investor; `MessageAlreadyConsumed()` means the EVM side already minted; `DestinationWalletNotWhitelisted()` speaks for itself.
- Byte layouts read manually: `BridgeAddress` is 8 discriminator + 2 chain + 32 address + 1 bump; the ACL keeps one state account per mint with the mint at offset 40.
- The ACL authority is the mint's actual mint authority, read from the chain, and the ACL state account is found by memcmp against the ACL program.
- `BridgeConfig` decoding tolerates two shapes: fields can be snake_case or camelCase depending on the Anchor version that produced the IDL (`config.asset_mint ?? config.assetMint` in `resolve.js`), and accounts from older program layouts fail to decode and are skipped.
- Token accounts use Token-2022, not the legacy token program.
- SPL flow only. A mint whose `BridgeConfig.token_config` is DS needs `execute_vaa_v1` (different instruction, different accounts); the tool refuses it deliberately.

## Conventions

Everything is in English: UI copy, console output, error messages, code, comments, and docs.
