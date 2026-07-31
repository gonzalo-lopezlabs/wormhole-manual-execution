# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone CLI that manually redeems a stuck Securitize bridge transfer in whichever direction it got stuck, for when the Wormhole Executor aborts. The source side has already burned; redeeming the VAA is permissionless, so any funded key can finish the job. Sepolia to Solana posts the VAA and calls `execute_vaa_v1_spl` (mints). Solana to Sepolia calls `receiveMessage` on the Executor's relayer contract. See README.md for the operational background and the Executor status curl.

## Commands

```bash
node index.js tx=<hash> privKey=<key>
```

Arguments are `key=value` pairs. The direction is implied by the hash format: a `0x` hash left Sepolia and is redeemed on Solana, anything else is a Solana signature redeemed on Sepolia. `privKey` is the fee payer on the destination chain: for Solana a base58 secret key, a JSON byte array, or a path to either (`solanaKeypair` accepts all three); for EVM a hex private key with or without `0x`. Tokens always go to the recipient named in the VAA, never to the signer.

There is no dry run flag, no tests, and no linter: every run executes. Still, nothing is sent until the transaction passes simulation on the destination chain: Solana through preflight (`sendTransaction` default), Sepolia because the EVM path deliberately omits `gasLimit`, so ethers estimates gas first and a revert surfaces with its reason before anything is paid. The Solana path also posts the VAA only if the `posted` PDA does not already exist, so re-running after a partial failure is safe.

Network constants (devnet/testnet only) are hardcoded at the top of `index.js`: Solana devnet RPC, Sepolia public RPC, bridge program `8Ki16KJ5WqV3D749GaxYPzLNzuewCeAKVTpq6xPJjp5B`, the Executor's relayer address, and the lookup table used to keep the Solana transaction under the size limit.

### Web UI

`ui/` is a minimal Astro app (own `package.json`, Node adapter) wrapping the CLI:

```bash
cd ui && npm install && npm run dev   # http://localhost:4322
```

`src/pages/index.astro` is the form; `src/pages/api/redeem.js` spawns `node index.js tx=... privKey=...` with cwd at the project root and streams the process output back as `text/plain`, so the browser shows the same log the terminal would. The endpoint resolves the project root as `path.resolve(process.cwd(), '..')`, which assumes the server is started from inside `ui/`. If the page disconnects mid-run the child is deliberately left to finish, killing a redemption between posting the VAA and minting would be worse. The UI adds no logic of its own; any behavior change belongs in the CLI.

## Architecture

`index.js` orchestrates: fetch the VAA from Wormholescan, decode the payload, then branch into `redeemOnSolana` or `redeemOnEvm`. Everything else is derived from the VAA and from chain state, nothing is configured per token.

- `lib/vaa.js`: Wormholescan lookups, raw VAA parsing (the keccak of the VAA body is the hash that keys the PDAs), and payload decoding. The payload is Solidity `abi.encode(uint16, string, uint256, bytes32, bytes32, string, uint256[], uint256[])`; the recipient wallet is head word 4. Trust the payload for the recipient, not any other source.
- `lib/resolve.js`: PDA derivations (seeds in `SEED`) and the discovery logic in both directions. `findMintForEmitter` (EVM to Solana): the VAA does not carry the mint, so it walks the bridge's `BridgeConfig` accounts and matches each one's `bridge_address` PDA for the emitter chain against the VAA emitter. `findEvmBridgeForEmitter` (Solana to EVM): the VAA emitter is the Solana emitter PDA (seed `emitter` + mint), so it matches that to find the mint, then reads the `bridge_address` for the target chain; the EVM contract is the last 20 bytes. `resolveAccounts` derives the full account list for `execute_vaa_v1_spl`.
- `lib/securitize-bridge-idl.json`: vendored bridge IDL from `@securitize/blockchain-contracts` 4.23.0, so the tool works without the private registry. Refresh with `cp node_modules/@securitize/blockchain-contracts/dist/solana-idls/securitize-bridge-idl.json lib/`.
- `lib/securitize-bridge-evm-abi.json`: vendored EVM bridge ABI, used only by `describeRevert` to map a revert selector to the bridge's own error name (e.g. `MessageAlreadyConsumed()`). Ethers buries the revert data at varying depths, so `describeRevert` walks the nested `error` chain to find it.

## Non-obvious facts baked into the code

- Wormholescan can return two attestations for one source transaction (one spuriously numbered as mainnet); `findVaaByTxHash` keeps the one whose emitter chain matches the origin.
- Redemption failures are program-enforced, and the error tells you which: `account already in use` on the `received` PDA means already redeemed; a missing `investor_registry` means the recipient is not provisioned; `InvestorRegistryInvestorIdMismatch` (6074) means the wallet belongs to another investor; `MessageAlreadyConsumed()` means the EVM side already minted; `DestinationWalletNotWhitelisted()` speaks for itself.
- Byte layouts read manually: `BridgeAddress` is 8 discriminator + 2 chain + 32 address + 1 bump; the ACL keeps one state account per mint with the mint at offset 40.
- The ACL authority is the mint's actual mint authority, read from the chain, and the ACL state account is found by memcmp against the ACL program.
- `BridgeConfig` decoding tolerates two shapes: fields can be snake_case or camelCase depending on the Anchor version that produced the IDL (`config.asset_mint ?? config.assetMint` in `resolve.js`), and accounts from older program layouts fail to decode and are skipped.
- Token accounts use Token-2022, not the legacy token program.
- SPL flow only. A mint whose `BridgeConfig.token_config` is DS needs `execute_vaa_v1` (different instruction, different accounts); the tool refuses it deliberately.

## Conventions

User-facing console output is in Spanish; code, comments, and errors aimed at programmers are in English. Keep that split.
