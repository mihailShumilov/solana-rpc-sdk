/**
 * Reliable send — a single broadcast can be silently dropped (Solana has no
 * mempool, so a dropped send returns no error and simply never lands). The
 * TransactionSender sends with `maxRetries: 0` and runs its OWN rebroadcast
 * loop, resending the SAME signed bytes (never re-signing → no double-charge)
 * and bounded by `lastValidBlockHeight`, until the transaction confirms.
 */
import { TransactionSender } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialBlockHeight: 700n });
  const endpoint = new MockEndpoint(cluster, { name: "rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);

  // The injected sleep is where the mock clock advances — one slot per
  // rebroadcast cycle. In production this is a real timer; tests stay instant.
  const sleep = async () => cluster.advanceSlots(1);

  // Model a tx that doesn't land on the first shot: the cluster only lands it a
  // few slots later, so the sender has to keep rebroadcasting to get it in.
  const signature = "5xReliableSendDemoSignature";
  cluster.scheduleLanding(signature, 4);

  const sender = new TransactionSender(rpc, { sleep });

  log("sendTransaction with maxRetries: 0 — we own the rebroadcast loop");
  const res = await sender.sendAndConfirm({
    wireTransaction: signature, // already-signed wire tx — the same bytes resent
    signature,
    lastValidBlockHeight: 800n,
  });
  log(`resent the SAME signed bytes ${res.rebroadcasts}× (never re-signed)`);
  log(`outcome: ${res.outcome}`);

  return {
    logs,
    result: {
      outcome: res.outcome,
      rebroadcasts: res.rebroadcasts,
      "signature unchanged": res.signature === signature,
      "landed at slot": res.slot === null ? "—" : Number(res.slot),
    },
  };
}
