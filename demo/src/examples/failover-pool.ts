/**
 * Failover pool — one endpoint rate-limits (HTTP 429), the other is healthy.
 * A read (`getSlot`) hits the throttled node first, the pool fails over, and the
 * call still succeeds through the backup. No retries to write, no try/catch in
 * your app code: `pool.rpc()` is a normal @solana/kit RPC.
 */
import { ResilientRpcPool, InMemoryMetrics } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  // One shared ledger; two endpoints in front of it.
  const cluster = new MockCluster({ initialSlot: 250_000_000n });
  const throttled = new MockEndpoint(cluster, { name: "rpc-throttled", faults: { rate429Rate: 1 } });
  const healthy = new MockEndpoint(cluster, { name: "rpc-healthy" });

  const metrics = new InMemoryMetrics();
  const pool = new ResilientRpcPool({
    endpoints: [
      { name: throttled.name, transport: throttled.transport },
      { name: healthy.name, transport: healthy.transport },
    ],
    // Try endpoints in the listed order so the 429 is hit first and the failover
    // is visible. (Freshness-aware routing is its own example.)
    freshnessAware: false,
    metrics,
  });

  log("getSlot() through the pool — primary returns HTTP 429…");
  const slot = await pool.rpc().getSlot().send();
  log("primary rate-limited → failed over to the healthy node");
  log(`slot ${slot} served by the backup`);

  const servedByBackup = metrics.requests.some((r) => r.endpoint === "rpc-healthy" && r.ok);
  return {
    logs,
    result: {
      slot: Number(slot),
      "429 responses": metrics.rateLimited.length,
      "endpoints tried": metrics.requests.length,
      "served by backup": servedByBackup,
    },
  };
}
