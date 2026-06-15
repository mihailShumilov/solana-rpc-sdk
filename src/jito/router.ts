/**
 * JitoRouter — routes a transaction/bundle through the Jito Block Engine for MEV
 * protection, polls in-flight status, and FALLS BACK to normal RPC submission
 * if the bundle does not land before the deadline. A bundle_id is only a receipt,
 * not a landing guarantee, so fallback is mandatory for reliable confirmation.
 */
import { NotImplementedError } from "../errors.js";
import type { TransactionSender, SendConfig, SendResult } from "../tx/sender.js";
import type { TipEstimator, TipPercentile } from "./tips.js";

export interface JitoEngineClient {
  getTipAccounts(): Promise<string[]>;
  sendBundle(wireTransactions: string[]): Promise<string>;
  getInflightBundleStatuses(ids: string[]): Promise<Array<{ bundle_id: string; status: string }>>;
}

export interface JitoRouteConfig extends SendConfig {
  /** Tip percentile to target (default "p50"). */
  tipPercentile?: TipPercentile;
  /** Max status polls before falling back to RPC (default 10). */
  maxBundlePolls?: number;
}

export interface JitoRouteResult extends SendResult {
  /** "jito" if the bundle landed, "rpc" if we fell back. */
  route: "jito" | "rpc";
  bundleId: string | null;
}

export interface JitoRouterDeps {
  sleep?: (ms: number) => Promise<void>;
}

export class JitoRouter {
  constructor(
    _engine: JitoEngineClient,
    _tipEstimator: TipEstimator,
    _fallbackSender: TransactionSender,
    _deps?: JitoRouterDeps,
  ) {}

  /** Submit via Jito; fall back to RPC sender if the bundle doesn't land. */
  sendWithFallback(_config: JitoRouteConfig): Promise<JitoRouteResult> {
    throw new NotImplementedError("JitoRouter.sendWithFallback");
  }
}
