/**
 * WalletAdapterBridge — bridges a standard `@solana/wallet-adapter` signer
 * (Phantom / Solflare / Backpack, or any wallet-standard signer) into the
 * resilient send pipeline (issue #6). It signs with the wallet, then routes the
 * SIGNED, already-serialized transaction through the resilient `TransactionSender`
 * — and through the `JitoRouter` (with RPC fallback) when one is supplied.
 *
 * It is generic over the transaction representation `TTransaction`:
 *  - In production, `TTransaction` is a kit/web3 transaction and you supply an
 *    `encode` that returns its base64 wire + signature (e.g. via kit's
 *    `getBase64EncodedWireTransaction` + `getSignatureFromTransaction`).
 *  - The default `TTransaction = string` treats the signed value as both the
 *    wire and the signature, matching the deterministic test harness.
 *
 * We never re-sign or mutate the transaction after the wallet signs it, and a
 * wallet rejection is surfaced through {@link ErrorTranslator} as USER_REJECTED.
 */
import type { TransactionSender, SendConfig, SendResult } from "../tx/sender.js";
import type { JitoRouter } from "../jito/router.js";
import { ErrorTranslator } from "../error-translator.js";

/** The slice of a wallet-adapter / wallet-standard signer the bridge needs. */
export interface WalletAdapterSigner<TTransaction = string> {
  /** Wallet public key (wallet-adapter exposes a PublicKey with toString/toBase58). */
  publicKey?: { toString(): string } | string | null;
  signTransaction(transaction: TTransaction): Promise<TTransaction>;
  /** Optional batch signing; the bridge falls back to per-tx signing if absent. */
  signAllTransactions?(transactions: TTransaction[]): Promise<TTransaction[]>;
}

/** A signed transaction reduced to what the sender needs. */
export interface EncodedTransaction {
  wireTransaction: string;
  signature: string;
}

export type TransactionEncoder<TTransaction> = (signed: TTransaction) => EncodedTransaction;

export interface WalletAdapterBridgeConfig<TTransaction = string> {
  wallet: WalletAdapterSigner<TTransaction>;
  sender: TransactionSender;
  /** When provided, signed transactions route through Jito (with RPC fallback). */
  jito?: JitoRouter;
  /** Serialize a signed transaction to its wire + signature. Defaults to identity (string). */
  encode?: TransactionEncoder<TTransaction>;
}

/** Per-send parameters (the blockhash bound the tx was built against, etc.). */
export interface BridgeSendOptions {
  lastValidBlockHeight: bigint;
  commitment?: "confirmed" | "finalized";
  rebroadcastIntervalMs?: number;
}

const identityEncoder: TransactionEncoder<string> = (signed) => ({
  wireTransaction: signed,
  signature: signed,
});

export class WalletAdapterBridge<TTransaction = string> {
  private readonly wallet: WalletAdapterSigner<TTransaction>;
  private readonly sender: TransactionSender;
  private readonly jito: JitoRouter | undefined;
  private readonly encode: TransactionEncoder<TTransaction>;

  constructor(config: WalletAdapterBridgeConfig<TTransaction>) {
    this.wallet = config.wallet;
    this.sender = config.sender;
    this.jito = config.jito;
    // The default identity encoder only type-checks for the string default; a
    // non-string TTransaction must supply its own encoder.
    this.encode = config.encode ?? (identityEncoder as unknown as TransactionEncoder<TTransaction>);
  }

  /** The connected wallet address as a base58 string, or null. */
  get address(): string | null {
    const key = this.wallet.publicKey;
    if (key == null) return null;
    return typeof key === "string" ? key : key.toString();
  }

  /** Sign one transaction with the wallet and land it through the resilient pipeline. */
  async signAndSend(transaction: TTransaction, options: BridgeSendOptions): Promise<SendResult> {
    const signed = await this.signOne(transaction);
    return this.dispatch(this.toConfig(signed, options));
  }

  /**
   * Sign and send a batch IN ORDER, returning one result per input transaction.
   * Uses the wallet's `signAllTransactions` when available (one approval prompt),
   * otherwise signs each transaction individually.
   */
  async signAndSendAll(transactions: TTransaction[], options: BridgeSendOptions): Promise<SendResult[]> {
    const signed = await this.signMany(transactions);
    const results: SendResult[] = [];
    for (const tx of signed) {
      results.push(await this.dispatch(this.toConfig(tx, options)));
    }
    return results;
  }

  private async signOne(transaction: TTransaction): Promise<TTransaction> {
    try {
      return await this.wallet.signTransaction(transaction);
    } catch (err) {
      throw ErrorTranslator.translate(err, { extra: "signTransaction" });
    }
  }

  private async signMany(transactions: TTransaction[]): Promise<TTransaction[]> {
    try {
      if (this.wallet.signAllTransactions !== undefined) {
        return await this.wallet.signAllTransactions(transactions);
      }
      const signed: TTransaction[] = [];
      for (const tx of transactions) signed.push(await this.wallet.signTransaction(tx));
      return signed;
    } catch (err) {
      throw ErrorTranslator.translate(err, { extra: "signAllTransactions" });
    }
  }

  private toConfig(signed: TTransaction, options: BridgeSendOptions): SendConfig {
    const { wireTransaction, signature } = this.encode(signed);
    return {
      wireTransaction,
      signature,
      lastValidBlockHeight: options.lastValidBlockHeight,
      commitment: options.commitment,
      rebroadcastIntervalMs: options.rebroadcastIntervalMs,
    };
  }

  private dispatch(config: SendConfig): Promise<SendResult> {
    return this.jito !== undefined
      ? this.jito.sendWithFallback(config)
      : this.sender.sendAndConfirm(config);
  }
}
