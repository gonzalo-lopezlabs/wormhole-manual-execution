# wormhole-manual-execution

Completes a stuck Securitize bridge transfer, in either direction between Sepolia and
Solana (SPL flow), when the Wormhole Executor gives up.

## Why this exists

An inbound bridge burns on the EVM side and pre-pays the Wormhole Executor. The
Executor is then supposed to run three Solana transactions on its own: verify the
guardian signatures, post the VAA, and call `execute_vaa_v1_spl`, which mints.

When the Executor aborts, the burn already happened and the mint never lands. The
holder is left short and there is no automatic retry: the request stays `aborted`
forever. Redeeming a VAA is permissionless, so anyone with a funded Solana keypair
can finish the job, which is what this tool does.

Observed failure on devnet (2026-07-30 and 2026-07-31, three requests):

```
status       : aborted
failureCause : svm_simulation_failed
             Transfer: insufficient lamports 225952649806, need 225953836045
             Program 11111111111111111111111111111111 failed: custom program error: 0x1
```

The failing instruction is a System transfer of nearly the Executor's whole
balance, short by ~0.0012 SOL. It looks like a bug on their side, not something
the bridge or the token can cause. It has not been reported yet.

Check the Executor's own view of a request with:

```bash
curl -s -X POST https://executor-testnet.labsapis.com/v0/status/tx \
  -H 'Content-Type: application/json' \
  -d '{"chainId":10002,"txHash":"0x<source tx>"}' | jq '.[0] | {status, failureCause, txs}'
```

`chainId` is the Wormhole id of the **origin** chain (10002 Sepolia, 1 Solana).
`status: aborted` with `txs: []` means nothing was delivered.

## Usage

Two arguments: the transaction that sent the tokens, and the key that pays the fees
on the chain being redeemed. The command redeems, there is no separate check step.

```bash
# Sepolia -> Solana: posts the VAA and mints on Solana
node index.js tx=0x<sepolia tx> privKey=<solana key>

# Solana -> Sepolia: calls receiveMessage on the Executor's relayer
node index.js tx=<solana signature> privKey=<evm key>
```

The direction is implied by the hash format: `0x` means the transfer left Sepolia and
has to be redeemed on Solana, anything else left Solana. The Solana key accepts a
base58 secret key, a JSON byte array, or a path to either. No environment variables.

The signer only pays fees: the tokens always go to the recipient named in the VAA.
Nothing is sent until the transaction passes simulation, Solana through preflight and
Sepolia through gas estimation, so a doomed redemption costs nothing.

## What it works out on its own

Only the source transaction is required. From it the tool derives:

- the VAA, keeping the attestation whose emitter chain matches the origin, since
  Wormholescan sometimes returns a second one numbered as mainnet;
- the recipient wallet, the investor id and the amount, read from the ABI encoded
  bridge payload (the recipient sits in word 4);
- the mint, by matching the VAA emitter against each `BridgeConfig`'s
  `bridge_address` for that chain;
- the ACL and registry programs, read from the mint's `BridgeConfig`;
- the ACL authority (the mint's real mint authority) and the ACL state account
  (the one holding that mint), so nothing is hardcoded per token;
- every PDA: `config`, `bridge_authority`, `emitter_address`, `consumed`,
  `received`, the posted VAA, and `investor_registry`.

## What makes a redemption fail

The program enforces these, so a failed run means one of them:

| condition | error |
|---|---|
| the VAA was already redeemed | `account already in use` on the `received` PDA |
| the recipient is not provisioned | the `investor_registry` account is missing |
| the recipient belongs to another investor | `InvestorRegistryInvestorIdMismatch` (6074) |
| the EVM side already minted | `MessageAlreadyConsumed()` |
| the EVM recipient is not whitelisted | `DestinationWalletNotWhitelisted()` |

That third one is worth reading twice: a wallet can be provisioned and still be the
wrong destination. The recipient comes from the VAA payload, never from anywhere
else.

## After redeeming

The scanner picks the transaction up on its next tick and emits two events,
`Issue` from the token row and `DSTokenBridgeReceive` from the bridge row. The
`Issue` is the one that moves the balance, and it is only captured when the token
is registered in `contracts` with `contract_name = 'token'`. Being the bridge
row's `token_address` is not enough.

## Scope

SPL flow only. A DS token uses `execute_vaa_v1`, a different instruction with its
own account list, and the tool stops with a clear message when the mint's config
turns out to be DS.

The bridge IDL is vendored in `lib/securitize-bridge-idl.json`, copied from
`@securitize/blockchain-contracts` 4.23.0, so the tool runs without access to the
private registry. When that package is resolvable it is preferred, since the
vendored copy can drift from the deployed program. Refresh it with:

```bash
cp node_modules/@securitize/blockchain-contracts/dist/solana-idls/securitize-bridge-idl.json lib/
```
