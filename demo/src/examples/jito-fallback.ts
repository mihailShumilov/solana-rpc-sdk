/**
 * Jito with fallback — a `bundle_id` is a receipt, not a landing guarantee. The
 * JitoRouter submits the bundle to the Block Engine, polls in-flight status a
 * bounded number of times, and — when the bundle does not land — automatically
 * falls back to normal RPC submission with the SAME signed bytes. Here the
 * bundle never lands, so the router falls back and the tx still confirms.
 */
import { JitoRouter, TipEstimator, TransactionSender } from "solana-resilience-kit";
import type { JitoEngineClient } from "solana-resilience-kit";
import { MockCluster, MockEndpoint, MockJitoEngine } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialBlockHeight: 500n });
  const endpoint = new MockEndpoint(cluster, { name: "rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);
  const sleep = async () => cluster.advanceSlots(1);

  // A Block Engine whose bundles take 99 polls to land — i.e. never, within our
  // budget — so the mandatory RPC fallback kicks in.
  const jito = new MockJitoEngine({ defaultLandsAfterPolls: 99 });
  const engine: JitoEngineClient = {
    getTipAccounts: async () => jito.getTipAccounts(),
    sendBundle: async (txs) => jito.sendBundle(txs),
    getInflightBundleStatuses: async (ids) => jito.getInflightBundleStatuses(ids),
  };

  const sender = new TransactionSender(rpc, { sleep });
  const router = new JitoRouter(engine, new TipEstimator(), sender, { sleep });

  const signature = "JitoFallbackDemoSignature999";
  log("submitting bundle to the Block Engine…");
  const res = await router.sendWithFallback({
    wireTransaction: signature,
    signature,
    lastValidBlockHeight: 600n,
    maxBundlePolls: 4,
  });
  log(`bundle did not land in 4 polls → falling back to RPC`);
  log(`route=${res.route} · outcome=${res.outcome}`);

  return {
    logs,
    result: {
      route: res.route,
      outcome: res.outcome,
      "bundle id": res.bundleId ?? "—",
      "fallback rebroadcasts": res.rebroadcasts,
    },
  };
}
