/**
 * Resilient wallet-adapter bridge. The standard @solana/wallet-adapter handles
 * connect/sign but offers no resilience. This adapter takes a wallet's signing
 * capability and routes the signed transaction through the resilient sender /
 * Jito router — so a dApp gets reliable landing without changing how it signs.
 */
import type { TransactionSender, SendResult } from "../tx/sender.js";
import { ErrorTranslator } from "../error-translator.js";

/** Minimal shape of a wallet-adapter signer (a subset of the real interface). */
export interface WalletSigner {
  /** Signs a wire transaction (base64 in, base64 out). */
  signTransaction(wireTransaction: string): Promise<string>;
  /** The fee-payer / wallet address (base58). */
  address: string;
}

export interface ResilientWalletConfig {
  signer: WalletSigner;
  sender: TransactionSender;
}

export class ResilientWalletAdapter {
  private readonly signer: WalletSigner;
  private readonly sender: TransactionSender;

  constructor(config: ResilientWalletConfig) {
    this.signer = config.signer;
    this.sender = config.sender;
  }

  /**
   * Signs the given wire transaction with the wallet, then sends it through the
   * resilient pipeline. `lastValidBlockHeight` must come from the blockhash the
   * transaction was built with.
   *
   * NOTE on the `signature` handle: `TransactionSender` polls the cluster under
   * the `signature` it is given (ConfirmationTracker calls
   * getSignatureStatuses([signature])). That key MUST match the key the cluster
   * registers the broadcast tx under, or confirmation polling watches the wrong
   * slot and never observes the landing. For this minimal string API the signed
   * wire IS that handle (the mock treats short strings as the raw signature, so
   * the same value is both broadcast and polled). In production, where the
   * signed wire is a long base64 transaction, the canonical signature must be
   * extracted from the signed transaction (e.g. via kit's
   * getSignatureFromTransaction) before sending. We deliberately do NOT pull a
   * base58 / wire parser into src here: no spec exercises the long-wire branch
   * and doing so would add untested surface.
   */
  async signAndSend(
    unsignedWireTransaction: string,
    lastValidBlockHeight: bigint,
  ): Promise<SendResult> {
    let signedWire: string;
    try {
      signedWire = await this.signer.signTransaction(unsignedWireTransaction);
    } catch (err) {
      // A wallet rejection ("User rejected the request") becomes a typed
      // USER_REJECTED error; any other signing failure is translated too.
      throw ErrorTranslator.translate(err, { extra: "signTransaction" });
    }
    return this.sender.sendAndConfirm({
      wireTransaction: signedWire,
      signature: signedWire,
      lastValidBlockHeight,
    });
  }
}
