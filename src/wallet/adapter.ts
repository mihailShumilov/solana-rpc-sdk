/**
 * Resilient wallet-adapter bridge. The standard @solana/wallet-adapter handles
 * connect/sign but offers no resilience. This adapter takes a wallet's signing
 * capability and routes the signed transaction through the resilient sender /
 * Jito router — so a dApp gets reliable landing without changing how it signs.
 */
import { NotImplementedError } from "../errors.js";
import type { TransactionSender, SendResult } from "../tx/sender.js";

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
  constructor(_config: ResilientWalletConfig) {}

  /**
   * Signs the given wire transaction with the wallet, then sends it through the
   * resilient pipeline. `lastValidBlockHeight` must come from the blockhash the
   * transaction was built with.
   */
  signAndSend(_unsignedWireTransaction: string, _lastValidBlockHeight: bigint): Promise<SendResult> {
    throw new NotImplementedError("ResilientWalletAdapter.signAndSend");
  }
}
