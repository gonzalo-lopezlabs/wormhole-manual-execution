/**
 * The SDK builds instructions and hands them to a `Transport` to sign and send.
 * The front end's transport delegates to a browser wallet; this one signs with a
 * keypair, so the redeemer and the sender share it.
 */

import { TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export class KeypairTransport {
  constructor(keypair, provider) {
    this.keypair = keypair;
    this.provider = provider;
  }

  async submit([instructions, signers = [], lutAddresses = []], connection) {
    const luts = (
      await Promise.all(lutAddresses.map(address => connection.getAddressLookupTable(address)))
    )
      .map(result => result.value)
      .filter(Boolean);

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(luts),
    );
    tx.sign([this.keypair, ...signers]);

    // Preflight simulates, so a doomed transaction costs nothing.
    const signature = await connection.sendTransaction(tx);
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  }

  isInstant() {
    return true;
  }

  walletAddress() {
    return this.keypair.publicKey;
  }

  walletKeypair() {
    return this.keypair;
  }

  async getProvider() {
    return this.provider;
  }
}
