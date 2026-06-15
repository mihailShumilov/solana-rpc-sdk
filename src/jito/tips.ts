/**
 * TipEstimator — sizes a Jito tip from live tip-floor percentiles, clamped to
 * the protocol minimum (1000 lamports). Tips are economically distinct from
 * priority fees and drive bundle auction priority.
 */
export const MIN_TIP_LAMPORTS = 1000;

const DEFAULT_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

/** Shape of a single Jito tip_floor record (percentiles are in SOL). */
interface RawTipFloor {
  landed_tips_25th_percentile?: number;
  landed_tips_50th_percentile?: number;
  landed_tips_75th_percentile?: number;
  landed_tips_95th_percentile?: number;
  landed_tips_99th_percentile?: number;
}

export type TipPercentile = "p25" | "p50" | "p75" | "p95" | "p99";

export interface TipFloor {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
}

export interface TipEstimatorConfig {
  /** Endpoint serving tip-floor data (default Jito public tip_floor REST). */
  tipFloorUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TipEstimator {
  constructor(private readonly config?: TipEstimatorConfig) {}

  /**
   * Fetches current tip-floor percentiles and returns them in lamports.
   *
   * The Jito public tip_floor REST endpoint returns an array whose first
   * element carries `landed_tips_*_percentile` fields denominated in SOL. We
   * are defensive about array-vs-object shape and convert SOL -> lamports.
   */
  async getTipFloor(): Promise<TipFloor> {
    const fetchImpl = this.config?.fetchImpl ?? globalThis.fetch;
    const url = this.config?.tipFloorUrl ?? DEFAULT_TIP_FLOOR_URL;

    const res = await fetchImpl(url);
    const body: unknown = await res.json();
    const record: RawTipFloor = (Array.isArray(body) ? body[0] : body) ?? {};

    const toLamports = (sol: number | undefined): number =>
      Math.round((sol ?? 0) * 1e9);

    return {
      p25: toLamports(record.landed_tips_25th_percentile),
      p50: toLamports(record.landed_tips_50th_percentile),
      p75: toLamports(record.landed_tips_75th_percentile),
      p95: toLamports(record.landed_tips_95th_percentile),
      p99: toLamports(record.landed_tips_99th_percentile),
    };
  }

  /** Recommends a tip (lamports) at the chosen percentile, clamped to minimum. */
  async recommendTip(percentile: TipPercentile = "p50"): Promise<number> {
    const floor = await this.getTipFloor();
    return Math.max(floor[percentile], MIN_TIP_LAMPORTS);
  }
}
