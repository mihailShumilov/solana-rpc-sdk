/**
 * Transaction-building helpers. The connected wallet (via the wallet-adapter)
 * signs @solana/web3.js v1 transactions, so we build the transfer with v1
 * primitives. The SDK then lands the signed wire bytes — it never sees the key.
 */
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

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
