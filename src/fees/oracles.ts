/**
 * Fee oracles — pluggable sources of priority-fee estimates. The native oracle
 * uses `getRecentPrioritizationFees` (free, backward-looking minimum); the
 * Helius/QuickNode oracles call account-aware percentile APIs. Vendor neutrality
 * means the SDK works with any of them behind one interface.
 */
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";

export type FeeLevel = "min" | "low" | "medium" | "high" | "veryHigh";

export interface PriorityFeeEstimate {
  /** micro-lamports per compute unit, keyed by level. */
  levels: Record<FeeLevel, number>;
}

export interface FeeOracle {
  /** Estimate priority fee given the writable accounts the tx will touch. */
  getPriorityFee(writableAccounts: string[]): Promise<PriorityFeeEstimate>;
}

/** Native estimate from getRecentPrioritizationFees over recent slots. */
export class NativeFeeOracle implements FeeOracle {
  private readonly rpc: Rpc<SolanaRpcApi>;

  constructor(rpc: Rpc<SolanaRpcApi>) {
    this.rpc = rpc;
  }

  /**
   * Derives micro-lamports-per-CU percentiles from the cluster's recent
   * prioritization-fee samples (`getRecentPrioritizationFees`). This is the
   * free, backward-looking source: the node returns the smallest fee paid by a
   * landed tx per recent slot. We sort the samples and pick percentiles by
   * nearest-rank so the levels are monotonic.
   */
  async getPriorityFee(writableAccounts: string[]): Promise<PriorityFeeEstimate> {
    const recent = await this.rpc
      .getRecentPrioritizationFees(writableAccounts as unknown as readonly Address[])
      .send();

    // Samples may arrive as bigint (kit MicroLamports) or number; normalize and
    // sort ascending so percentile-by-rank produces monotonic levels.
    const sorted = recent
      .map((entry) => Number(entry.prioritizationFee))
      .sort((a, b) => a - b);

    if (sorted.length === 0) {
      return {
        levels: { min: 0, low: 0, medium: 0, high: 0, veryHigh: 0 },
      };
    }

    // Nearest-rank percentile over (n - 1): p=0 -> first, p=100 -> last. The
    // computed index is always in [0, n-1]; the `?? 0` only satisfies
    // noUncheckedIndexedAccess and is never reached for a non-empty array.
    const percentile = (p: number): number =>
      sorted[Math.round((p / 100) * (sorted.length - 1))] ?? 0;

    return {
      levels: {
        min: percentile(0),
        low: percentile(25),
        medium: percentile(50),
        high: percentile(75),
        veryHigh: percentile(100),
      },
    };
  }
}

export interface HttpFeeOracleConfig {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Helius `getPriorityFeeEstimate` — account-aware percentile estimates. Helius
 * already returns micro-lamports-per-CU figures keyed by the same level names we
 * expose (`priorityFeeLevels`), so the mapping is direct. `fetchImpl` is
 * injectable for deterministic tests and defaults to the global `fetch`; the
 * API key, when provided, is appended to the request URL.
 */
export class HeliusFeeOracle implements FeeOracle {
  private readonly config: HttpFeeOracleConfig;

  constructor(config: HttpFeeOracleConfig) {
    this.config = config;
  }

  async getPriorityFee(writableAccounts: string[]): Promise<PriorityFeeEstimate> {
    const fetchImpl = this.config.fetchImpl ?? globalThis.fetch;
    const url = this.config.apiKey
      ? `${this.config.url}?api-key=${this.config.apiKey}`
      : this.config.url;

    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys: writableAccounts,
            options: { includeAllPriorityFeeLevels: true },
          },
        ],
      }),
    });

    const body = (await res.json()) as {
      result?: { priorityFeeLevels?: Partial<Record<FeeLevel, number>> };
    };
    const fees = body.result?.priorityFeeLevels ?? {};
    const microLamports = (v: number | undefined): number => Math.round(Number(v ?? 0));

    return {
      levels: {
        min: microLamports(fees.min),
        low: microLamports(fees.low),
        medium: microLamports(fees.medium),
        high: microLamports(fees.high),
        veryHigh: microLamports(fees.veryHigh),
      },
    };
  }
}
