/**
 * Freshness routing — a lagging RPC is the classic "looks up, drops your tx"
 * trap: it answers requests fine but is hundreds of slots behind, so a blockhash
 * fetched from it (or a tx sent to it) silently dies. The HealthMonitor probes
 * every node's slot, ranks by freshness, and routes around the laggard — even
 * when the laggard is listed first.
 */
import { ResilientRpcPool, InMemoryMetrics } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialSlot: 300_000_000n, initialBlockHeight: 300_000_000n });
  const lagging = new MockEndpoint(cluster, { name: "rpc-lagging", faults: { slotLag: 400 } });
  const fresh = new MockEndpoint(cluster, { name: "rpc-fresh" });

  const metrics = new InMemoryMetrics();
  const pool = new ResilientRpcPool({
    // Laggard listed FIRST on purpose — freshness routing must still skip it.
    endpoints: [
      { name: lagging.name, transport: lagging.transport },
      { name: fresh.name, transport: fresh.transport },
    ],
    metrics, // freshnessAware defaults to true
  });

  log("getSlot() — the pool probes both nodes' slots first…");
  const slot = await pool.rpc().getSlot().send();

  const health = pool.health();
  const laggard = health.find((h) => h.name === "rpc-lagging");
  const servedBy = metrics.requests.find((r) => r.ok)?.endpoint ?? "—";
  log(`rpc-lagging is 400 slots behind (> 150 max) → healthy=${laggard?.healthy}`);
  log(`routed to ${servedBy}; served slot ${slot}`);

  return {
    logs,
    result: {
      "served by": servedBy,
      "served slot": Number(slot),
      "laggard slot": laggard?.slot === null || laggard?.slot === undefined ? "—" : Number(laggard.slot),
      "laggard healthy": Boolean(laggard?.healthy),
    },
  };
}
