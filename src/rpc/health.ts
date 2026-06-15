/**
 * HealthMonitor — tracks per-endpoint freshness and reliability so the pool can
 * route to healthy, up-to-date nodes and avoid the "lagging node drops your tx"
 * failure mode. Freshness is judged by comparing observed slots across
 * endpoints; an endpoint more than `maxSlotLag` behind the best is unhealthy.
 */
import { NotImplementedError } from "../errors.js";

export interface EndpointHealth {
  name: string;
  healthy: boolean;
  slot: bigint | null;
  /** Exponentially-weighted mean latency in ms. */
  latencyMs: number;
  /** Rolling error rate in [0,1]. */
  errorRate: number;
  consecutiveFailures: number;
  lastError: unknown | null;
}

export interface HealthMonitorConfig {
  endpointNames: string[];
  /** Slots behind the freshest node before an endpoint is deemed stale. */
  maxSlotLag?: bigint;
  /** Consecutive failures before an endpoint is ejected. */
  failureThreshold?: number;
  /** EWMA smoothing factor for latency (0..1). */
  latencyAlpha?: number;
}

export class HealthMonitor {
  constructor(_config: HealthMonitorConfig) {}

  recordSuccess(_endpoint: string, _latencyMs: number, _slot?: bigint): void {
    throw new NotImplementedError("HealthMonitor.recordSuccess");
  }

  recordFailure(_endpoint: string, _error: unknown): void {
    throw new NotImplementedError("HealthMonitor.recordFailure");
  }

  isHealthy(_endpoint: string): boolean {
    throw new NotImplementedError("HealthMonitor.isHealthy");
  }

  /** Healthy endpoints ordered best-first (freshest slot, then lowest latency). */
  rankByFreshness(): string[] {
    throw new NotImplementedError("HealthMonitor.rankByFreshness");
  }

  snapshot(): EndpointHealth[] {
    throw new NotImplementedError("HealthMonitor.snapshot");
  }
}
