/**
 * examples/otel-setup.ts — how `OtelMetrics` actually exports to a backend.
 *
 * `OtelMetrics` by itself only writes to the GLOBAL OpenTelemetry meter, which is
 * a no-op until a real `MeterProvider` (with a reader + exporter) is registered.
 * This is the part that "observability is wired up" claims usually skip. Below is
 * the ~10-line pipeline that makes exports real: a `MeterProvider` with a
 * `PeriodicExportingMetricReader` feeding an OTLP/HTTP exporter, pointed at a
 * local OTel Collector or Datadog Agent via `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * It then hands `OtelMetrics` to a `ResilientRpcPool` + `TransactionSender`, drives
 * a few SIMULATED sends against the in-memory harness (no network, fully
 * deterministic), and flushes — so you can watch the six SDK instruments export.
 *
 * Run (these packages are devDependencies only — none of this ships in the
 * published library, whose only OTel dependency is `@opentelemetry/api`):
 *
 *   # optional — point at your collector / Datadog Agent (defaults to localhost:4318)
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 *   export OTEL_SERVICE_NAME=solana-resilience-kit
 *   npm run example:otel
 *
 * With no collector listening you STILL see every exported data point: a
 * `ConsoleMetricExporter` is attached alongside the OTLP one, purely for this demo.
 */
import { metrics } from "@opentelemetry/api";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

import { OtelMetrics, ResilientRpcPool, TransactionSender } from "../src/index.js";
import { MockCluster, MockEndpoint } from "../test/harness/index.js";

const SERVICE = process.env.OTEL_SERVICE_NAME ?? "solana-resilience-kit";
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
  "http://localhost:4318 (OTLP default)";

async function main(): Promise<void> {
  // 1. THE EXPORT PIPELINE — this is what turns OtelMetrics from a no-op into
  //    real exported metrics. A PeriodicExportingMetricReader pulls the
  //    instruments on an interval and hands the batch to the OTLP/HTTP exporter,
  //    which POSTs to OTEL_EXPORTER_OTLP_ENDPOINT (+ "/v1/metrics").
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT itself
        exportIntervalMillis: 10_000,
      }),
      // Demo-only: prints each export batch so the run is visible with no collector.
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: 10_000,
      }),
    ],
  });

  // Register globally BEFORE constructing OtelMetrics: OtelMetrics grabs the
  // global meter at construction time, so the provider must exist first.
  metrics.setGlobalMeterProvider(meterProvider);

  const sdkMetrics = new OtelMetrics({ serviceName: SERVICE });

  // 2. A deterministic in-memory cluster — no sockets, manual clock. One
  //    always-429 endpoint and one healthy one, in fixed order so EVERY request
  //    fails over flaky -> primary. That single path exercises rpc.rate_limited,
  //    rpc.request.failures, rpc.request.latency_ms and rpc.endpoint.slot at once.
  const cluster = new MockCluster({ initialBlockHeight: 700n });
  const flaky = new MockEndpoint(cluster, { name: "flaky", faults: { rate429Rate: 1 } });
  const primary = new MockEndpoint(cluster, { name: "primary" });

  const pool = new ResilientRpcPool({
    endpoints: [
      { name: "flaky", transport: flaky.transport },
      { name: "primary", transport: primary.transport },
    ],
    freshnessAware: false, // deterministic attempt order for the demo
    metrics: sdkMetrics,
  });
  const rpc = pool.rpc(); // a normal @solana/kit RPC, metered underneath

  // A couple of reads: each hits flaky (429 -> rate_limited + failure) then
  // primary (-> latency + endpoint.slot).
  await rpc.getSlot().send();
  await rpc.getSlot().send();

  // 3. Simulated sends through the resilient sender. The injected `sleep`
  //    advances the MOCK clock, so confirmation / expiry resolve instantly and
  //    deterministically instead of waiting on wall-clock time.
  const sleep = async (): Promise<void> => {
    cluster.advanceSlots(1);
  };
  const sender = new TransactionSender(rpc, { sleep, metrics: sdkMetrics });

  // 3a. A tx that lands -> tx.landings{outcome=confirmed} + tx.rebroadcasts.
  const landed = await sender.sendAndConfirm({
    wireTransaction: "DemoSigLands",
    signature: "DemoSigLands",
    lastValidBlockHeight: cluster.blockHeight + 100n,
  });
  console.log(`send #1 (lands):   outcome=${landed.outcome} rebroadcasts=${landed.rebroadcasts}`);

  // 3b. A silently-dropped tx -> bounded by lastValidBlockHeight -> expired
  //     (never re-signed; the outcome is decided by block height, not a timeout).
  cluster.scheduleLanding("DemoSigDrops", -1);
  const dropped = await sender.sendAndConfirm({
    wireTransaction: "DemoSigDrops",
    signature: "DemoSigDrops",
    lastValidBlockHeight: cluster.blockHeight + 4n,
  });
  console.log(`send #2 (dropped): outcome=${dropped.outcome} rebroadcasts=${dropped.rebroadcasts}`);

  // 4. Flush so the exporters ship immediately (don't wait for the interval),
  //    then shut the provider down cleanly.
  console.log("\ninstruments emitted this run:");
  console.log("  rpc.request.latency_ms, rpc.request.failures, rpc.rate_limited,");
  console.log("  tx.rebroadcasts, tx.landings, rpc.endpoint.slot");
  console.log(`exporting via OTLP to: ${otlpEndpoint}\n`);

  try {
    await meterProvider.forceFlush();
    console.log("OTLP flush ok.");
  } catch (err) {
    console.warn(
      `OTLP flush to ${otlpEndpoint} failed (is a collector / Datadog Agent listening?):`,
      String((err as Error)?.message ?? err),
    );
    console.warn("The ConsoleMetricExporter output above shows the exact data points that would ship.");
  }
  await meterProvider.shutdown();
  console.log("done — metrics flushed and provider shut down.");
}

main().catch((err) => {
  console.error("otel-setup example failed:", err);
  process.exitCode = 1;
});
