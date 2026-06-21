/**
 * Wallet-adapter bridge — bring your own `@solana/wallet-adapter` wallet
 * (Phantom / Solflare / Backpack) and land its signed transactions through the
 * resilient pipeline (and through Jito with RPC fallback when a router is given).
 * It signs, then routes the SIGNED bytes through the `TransactionSender` — never
 * re-signing — and surfaces a wallet rejection as a typed `USER_REJECTED` error.
 * `signAndSendAll` signs a batch in one approval prompt and lands each in order.
 *
 * The default `TTransaction = string` treats the signed value as both wire and
 * signature (matching the harness); in production you pass an `encode` that
 * returns base64 wire + signature via kit's getBase64EncodedWireTransaction /
 * getSignatureFromTransaction.
 */
import { WalletAdapterBridge, TransactionSender } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialBlockHeight: 600n });
  const endpoint = new MockEndpoint(cluster, { name: "rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);
  const sleep = async () => cluster.advanceSlots(1);
  const sender = new TransactionSender(rpc, { sleep });
  const lvbh = cluster.blockHeight + 50n;

  // A standard wallet-adapter signer (the slice the bridge needs).
  const wallet = {
    publicKey: "Wa11etPubKey1111111111111111111111111111111",
    signTransaction: async (tx: string) => `signed-${tx}`,
  };
  const bridge = new WalletAdapterBridge({ wallet, sender });
  log(`connected wallet: ${bridge.address}`);

  const one = await bridge.signAndSend("tx-single", { lastValidBlockHeight: lvbh });
  log(`signAndSend → ${one.outcome}`);

  const batch = await bridge.signAndSendAll(["tx-1", "tx-2"], { lastValidBlockHeight: lvbh });
  log(`signAndSendAll → [${batch.map((r) => r.outcome).join(", ")}]`);

  // A wallet rejection becomes a typed USER_REJECTED error (ErrorTranslator).
  const rejecting = {
    publicKey: "Wa11etPubKey1111111111111111111111111111111",
    signTransaction: async (_tx: string): Promise<string> => {
      throw new Error("User rejected the request.");
    },
  };
  const rejectingBridge = new WalletAdapterBridge({ wallet: rejecting, sender });
  let rejectionCode = "—";
  try {
    await rejectingBridge.signAndSend("tx-rejected", { lastValidBlockHeight: lvbh });
  } catch (err) {
    rejectionCode = (err as { code?: string }).code ?? (err as Error).name;
    log(`rejection surfaced as: ${rejectionCode}`);
  }

  return {
    logs,
    result: {
      address: bridge.address ?? "—",
      "single outcome": one.outcome,
      "batch outcomes": batch.map((r) => r.outcome).join(", "),
      "rejection code": rejectionCode,
    },
  };
}
