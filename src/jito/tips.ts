/**
 * TipEstimator — sizes a Jito tip from live tip-floor percentiles, clamped to
 * the protocol minimum (1000 lamports). Tips are economically distinct from
 * priority fees and drive bundle auction priority.
 */
import { NotImplementedError } from "../errors.js";

export const MIN_TIP_LAMPORTS = 1000;

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
  constructor(_config?: TipEstimatorConfig) {}

  /** Fetches current tip-floor percentiles (lamports). */
  getTipFloor(): Promise<TipFloor> {
    throw new NotImplementedError("TipEstimator.getTipFloor");
  }

  /** Recommends a tip (lamports) at the chosen percentile, clamped to minimum. */
  recommendTip(_percentile?: TipPercentile): Promise<number> {
    throw new NotImplementedError("TipEstimator.recommendTip");
  }
}
