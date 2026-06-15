/**
 * Observability surface. The SDK emits a small, fixed set of client-side
 * signals — the metrics the ecosystem currently re-implements by hand. The
 * `Metrics` interface decouples the SDK from any backend; `InMemoryMetrics` is
 * a real implementation used by tests to assert the SDK emits the right
 * signals, and `OtelMetrics` (to be implemented) bridges to OpenTelemetry /
 * Datadog via the OTLP exporter.
 */
import { NotImplementedError } from "../errors.js";

export interface Metrics {
  /** Per-endpoint request latency (ms) with success/failure outcome. */
  recordRequest(endpoint: string, method: string, latencyMs: number, ok: boolean): void;
  /** A request was rate-limited (HTTP 429). */
  recordRateLimited(endpoint: string): void;
  /** A transaction was (re)broadcast to the network. */
  recordRebroadcast(signature: string): void;
  /** Terminal transaction outcome. */
  recordLanding(signature: string, outcome: "confirmed" | "expired", slots: number): void;
  /** Observed slot for an endpoint (drives slot-lag dashboards). */
  recordSlot(endpoint: string, slot: bigint): void;
}

/** Trivial, fully-implemented metrics sink for tests and local debugging. */
export class InMemoryMetrics implements Metrics {
  readonly requests: Array<{ endpoint: string; method: string; latencyMs: number; ok: boolean }> = [];
  readonly rateLimited: string[] = [];
  readonly rebroadcasts: string[] = [];
  readonly landings: Array<{ signature: string; outcome: "confirmed" | "expired"; slots: number }> = [];
  readonly slots: Array<{ endpoint: string; slot: bigint }> = [];

  recordRequest(endpoint: string, method: string, latencyMs: number, ok: boolean): void {
    this.requests.push({ endpoint, method, latencyMs, ok });
  }
  recordRateLimited(endpoint: string): void {
    this.rateLimited.push(endpoint);
  }
  recordRebroadcast(signature: string): void {
    this.rebroadcasts.push(signature);
  }
  recordLanding(signature: string, outcome: "confirmed" | "expired", slots: number): void {
    this.landings.push({ signature, outcome, slots });
  }
  recordSlot(endpoint: string, slot: bigint): void {
    this.slots.push({ endpoint, slot });
  }

  /** Convenience aggregations the diagnostics CLI / dashboard will reuse. */
  successRate(): number {
    if (this.requests.length === 0) return 1;
    return this.requests.filter((r) => r.ok).length / this.requests.length;
  }
}

export interface OtelMetricsConfig {
  serviceName?: string;
  /** OTLP endpoint, e.g. a Datadog Agent or OTel Collector. */
  otlpEndpoint?: string;
}

/** OpenTelemetry/Datadog-backed metrics. Implementation phase. */
export class OtelMetrics implements Metrics {
  constructor(_config?: OtelMetricsConfig) {}
  recordRequest(): void {
    throw new NotImplementedError("OtelMetrics.recordRequest");
  }
  recordRateLimited(): void {
    throw new NotImplementedError("OtelMetrics.recordRateLimited");
  }
  recordRebroadcast(): void {
    throw new NotImplementedError("OtelMetrics.recordRebroadcast");
  }
  recordLanding(): void {
    throw new NotImplementedError("OtelMetrics.recordLanding");
  }
  recordSlot(): void {
    throw new NotImplementedError("OtelMetrics.recordSlot");
  }
}
