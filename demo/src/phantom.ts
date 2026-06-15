/**
 * Phantom wallet glue. Phantom's injected provider speaks @solana/web3.js v1,
 * so we build the transfer it signs with v1 primitives. The SDK then lands the
 * signed wire bytes — the kit never needs the secret key.
 */
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toString(): string } | null;
  isConnected?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

/** The injected Phantom provider, or null if the extension isn't present
 * (also null outside a browser, e.g. SSR or a Node smoke test). */
export function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const p = w.phantom?.solana ?? w.solana;
  return p && p.isPhantom ? p : null;
}

/** An unsigned v0 transfer the connected wallet can sign. */
export function buildTransfer(from: string, to: string, lamports: number, blockhash: string): VersionedTransaction {
  const fromPubkey = new PublicKey(from);
  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(to), lamports })],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Browser-native base64 encode of raw transaction bytes (no Buffer needed). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
