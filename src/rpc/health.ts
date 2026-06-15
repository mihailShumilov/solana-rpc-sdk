/**
 * HealthMonitor — tracks per-endpoint freshness and reliability so the pool can
 * route to healthy, up-to-date nodes and avoid the "lagging node drops your tx"
 * failure mode. Freshness is judged by comparing observed slots across
 * endpoints; an endpoint more than `maxSlotLag` behind the best is unhealthy.
 */

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

/** Internal mutable state. `latencySeeded` distinguishes "no sample yet" from a
 * genuine 0ms sample so the EWMA can take the first sample verbatim. */
interface EndpointState {
  name: string;
  slot: bigint | null;
  latencyMs: number;
  latencySeeded: boolean;
  errorRate: number;
  consecutiveFailures: number;
  lastError: unknown | null;
}

/** Step applied to errorRate per success (down) / failure (up). Keeps the rate
 * a bounded [0,1] rolling signal without needing a full window of samples. */
const ERROR_RATE_STEP = 0.1;

export class HealthMonitor {
  private readonly maxSlotLag: bigint;
  private readonly failureThreshold: number;
  private readonly latencyAlpha: number;
  private readonly states = new Map<string, EndpointState>();

  constructor(config: HealthMonitorConfig) {
    this.maxSlotLag = config.maxSlotLag ?? 150n;
    this.failureThreshold = config.failureThreshold ?? 3;
    this.latencyAlpha = config.latencyAlpha ?? 0.3;

    for (const name of config.endpointNames) {
      this.states.set(name, {
        name,
        slot: null,
        latencyMs: 0,
        latencySeeded: false,
        errorRate: 0,
        consecutiveFailures: 0,
        lastError: null,
      });
    }
  }

  recordSuccess(endpoint: string, latencyMs: number, slot?: bigint): void {
    const state = this.states.get(endpoint);
    if (state === undefined) return; // guard unknown endpoint names

    state.consecutiveFailures = 0;

    if (!state.latencySeeded) {
      state.latencyMs = latencyMs;
      state.latencySeeded = true;
    } else {
      state.latencyMs =
        this.latencyAlpha * latencyMs + (1 - this.latencyAlpha) * state.latencyMs;
    }

    if (slot !== undefined) {
      state.slot = slot;
    }

    state.errorRate = clamp01(state.errorRate - ERROR_RATE_STEP);
    state.lastError = null;
  }

  recordFailure(endpoint: string, error: unknown): void {
    const state = this.states.get(endpoint);
    if (state === undefined) return; // guard unknown endpoint names

    state.consecutiveFailures += 1;
    state.lastError = error;
    state.errorRate = clamp01(state.errorRate + ERROR_RATE_STEP);
  }

  isHealthy(endpoint: string): boolean {
    const state = this.states.get(endpoint);
    if (state === undefined) return false; // unknown endpoint is never healthy

    if (state.consecutiveFailures >= this.failureThreshold) return false;

    if (state.slot !== null) {
      const lag = this.freshestSlot() - state.slot;
      if (lag > this.maxSlotLag) return false;
    }

    return true;
  }

  /** Healthy endpoints ordered best-first (freshest slot, then lowest latency). */
  rankByFreshness(): string[] {
    return [...this.states.values()]
      .filter((s) => this.isHealthy(s.name))
      .sort((a, b) => {
        // Freshest slot first; nulls sort last.
        if (a.slot !== b.slot) {
          if (a.slot === null) return 1;
          if (b.slot === null) return -1;
          if (a.slot > b.slot) return -1;
          if (a.slot < b.slot) return 1;
        }
        // Tie-break: lower latency first.
        return a.latencyMs - b.latencyMs;
      })
      .map((s) => s.name);
  }

  snapshot(): EndpointHealth[] {
    return [...this.states.values()].map((s) => ({
      name: s.name,
      healthy: this.isHealthy(s.name),
      slot: s.slot,
      latencyMs: s.latencyMs,
      errorRate: s.errorRate,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
    }));
  }

  /** Max of all non-null observed slots across endpoints; 0n when none seen. */
  private freshestSlot(): bigint {
    let max = 0n;
    for (const state of this.states.values()) {
      if (state.slot !== null && state.slot > max) {
        max = state.slot;
      }
    }
    return max;
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
