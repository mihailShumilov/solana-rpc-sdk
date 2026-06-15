/**
 * Blockhash expiry — the tx is silently dropped and never lands. The naive
 * mistake is to poll forever (or re-sign and resend, risking a double-charge).
 * The correct Solana rule: a tx is dead once block height passes its
 * `lastValidBlockHeight`. The sender's loop is bounded by exactly that — it
 * stops at expiry, returns a clean `expired`, and never re-signs.
 */
import { TransactionSender } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialBlockHeight: 1000n });
  const endpoint = new MockEndpoint(cluster, { name: "rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);
  const sleep = async () => cluster.advanceSlots(1);

  const signature = "DroppedForeverSignature11111";
  cluster.scheduleLanding(signature, -1); // silent drop: this tx never lands

  const sender = new TransactionSender(rpc, { sleep });

  log("broadcasting a tx the network silently drops…");
  const res = await sender.sendAndConfirm({
    wireTransaction: signature,
    signature,
    lastValidBlockHeight: 1010n, // ~10 slots of validity, then give up
  });
  log(`bounded by lastValidBlockHeight — stopped at expiry, no infinite poll`);
  log(`outcome: ${res.outcome} after ${res.rebroadcasts} rebroadcasts`);

  return {
    logs,
    result: {
      outcome: res.outcome,
      rebroadcasts: res.rebroadcasts,
      "bounded (no infinite loop)": true,
      "signature unchanged (no re-sign)": res.signature === signature,
    },
  };
}
