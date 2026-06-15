/**
 * Observability — one `Metrics` sink, shared by the pool and the sender, records
 * every request, rate-limit, rebroadcast, and landing. After a series of sends
 * through a flaky endpoint, `InMemoryMetrics` gives you landing rate, failovers,
 * and rebroadcast counts with zero extra instrumentation. Swap it for
 * `OtelMetrics` to ship the same signals to OpenTelemetry / Datadog.
 */
import { ResilientRpcPool, TransactionSender, InMemoryMetrics } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster({ initialBlockHeight: 800n });
  const flaky = new MockEndpoint(cluster, { name: "rpc-a", faults: { rate429Rate: 0.5 }, rngSeed: 7 });
  const backup = new MockEndpoint(cluster, { name: "rpc-b" });

  const metrics = new InMemoryMetrics(); // ONE sink, shared everywhere
  const pool = new ResilientRpcPool({
    endpoints: [
      { name: flaky.name, transport: flaky.transport },
      { name: backup.name, transport: backup.transport },
    ],
    freshnessAware: false,
    metrics,
  });
  const sleep = async () => cluster.advanceSlots(1);
  const sender = new TransactionSender(pool.rpc(), { sleep, metrics });

  const SENDS = 5;
  log(`sending ${SENDS} transactions through a 50%-rate-limited primary…`);
  for (let i = 0; i < SENDS; i++) {
    const sig = `obs-tx-${i}`;
    await sender.sendAndConfirm({
      wireTransaction: sig,
      signature: sig,
      lastValidBlockHeight: cluster.blockHeight + 50n,
    });
  }

  const landed = metrics.landings.filter((l) => l.outcome === "confirmed").length;
  const failovers = metrics.requests.filter((r) => r.method === "sendTransaction" && !r.ok).length;
  log(`${landed}/${SENDS} landed; ${failovers} failovers absorbed`);

  return {
    logs,
    result: {
      sends: SENDS,
      landed,
      "landing rate": `${Math.round((landed / SENDS) * 100)}%`,
      failovers,
      rebroadcasts: metrics.rebroadcasts.length,
      "429s seen": metrics.rateLimited.length,
      "rpc requests": metrics.requests.length,
      "success rate": `${Math.round(metrics.successRate() * 100)}%`,
    },
  };
}
