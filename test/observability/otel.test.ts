/**
 * SPEC (red until implemented): OtelMetrics bridges the SDK's `Metrics` surface
 * to OpenTelemetry instruments (counters / histogram / gauge), so client-side
 * telemetry — request latency, failures, rate-limits, rebroadcasts, landings,
 * and observed slot — is exported to any OTel/Datadog backend. A `Meter` is
 * injected here for deterministic testing; in production it defaults to the
 * global OTel meter, which becomes a live exporter once the host app registers
 * a MeterProvider.
 *
 * The instrument NAMES asserted below are part of the observability contract
 * (dashboards/alerts bind to them), so they are pinned by this spec.
 */
import { describe, it, expect } from "vitest";
import type { Meter } from "@opentelemetry/api";
import { OtelMetrics } from "../../src/observability/metrics.js";

interface Call {
  value: number;
  attributes?: Record<string, unknown>;
}

/** A minimal capturing Meter: every instrument records {value, attributes}. */
function fakeMeter() {
  const calls: Record<string, Call[]> = {};
  const instrument = (name: string) => {
    const bucket: Call[] = (calls[name] = calls[name] ?? []);
    const push = (value: number, attributes?: Record<string, unknown>) => {
      bucket.push({ value, attributes });
    };
    return { add: push, record: push };
  };
  const meter = {
    createCounter: (name: string) => instrument(name),
    createHistogram: (name: string) => instrument(name),
    createGauge: (name: string) => instrument(name),
    createUpDownCounter: (name: string) => instrument(name),
  } as unknown as Meter;
  return { meter, calls };
}

describe("OtelMetrics", () => {
  it("records request latency for every request and counts only failures", () => {
    const { meter, calls } = fakeMeter();
    const m = new OtelMetrics({ meter });
    m.recordRequest("a", "getSlot", 10, true);
    m.recordRequest("a", "getSlot", 12, false);

    const latency = calls["rpc.request.latency_ms"] ?? [];
    expect(latency.map((c) => c.value)).toEqual([10, 12]);
    expect(latency[0]?.attributes).toMatchObject({ endpoint: "a", method: "getSlot", ok: true });

    const failures = calls["rpc.request.failures"] ?? [];
    expect(failures).toHaveLength(1); // only the ok:false request increments failures
    expect(failures[0]?.attributes).toMatchObject({ endpoint: "a", method: "getSlot" });
  });

  it("counts rate-limits, rebroadcasts and landings with attributes", () => {
    const { meter, calls } = fakeMeter();
    const m = new OtelMetrics({ meter });
    m.recordRateLimited("a");
    m.recordRebroadcast("sig");
    m.recordLanding("sig", "confirmed", 2);

    expect(calls["rpc.rate_limited"]?.[0]?.attributes).toMatchObject({ endpoint: "a" });
    expect(calls["tx.rebroadcasts"]).toHaveLength(1);
    expect(calls["tx.landings"]?.[0]?.attributes).toMatchObject({ outcome: "confirmed" });
  });

  it("records the observed slot as a gauge (bigint -> number)", () => {
    const { meter, calls } = fakeMeter();
    const m = new OtelMetrics({ meter });
    m.recordSlot("a", 1234n);

    const slot = calls["rpc.endpoint.slot"] ?? [];
    expect(slot[0]?.value).toBe(1234);
    expect(slot[0]?.attributes).toMatchObject({ endpoint: "a" });
  });
});
