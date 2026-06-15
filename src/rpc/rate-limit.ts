/**
 * CreditRateLimiter — token-bucket limiter that meters by *weighted credits*,
 * not raw request count, because providers charge heavy methods (e.g.
 * getProgramAccounts) many times a getBalance. Avoiding 429s requires modeling
 * that weighting client-side.
 */
import { NotImplementedError } from "../errors.js";

/** Default method weights, modeled on common provider credit tables. */
export const DEFAULT_METHOD_WEIGHTS: Readonly<Record<string, number>> = {
  getBalance: 1,
  getSlot: 1,
  getBlockHeight: 1,
  getLatestBlockhash: 1,
  getSignatureStatuses: 1,
  sendTransaction: 1,
  simulateTransaction: 10,
  getRecentPrioritizationFees: 10,
  getProgramAccounts: 10,
  getSignaturesForAddress: 10,
};

export interface RateLimiterConfig {
  /** Credits replenished per window. */
  creditsPerWindow: number;
  /** Window length in ms. */
  windowMs: number;
  /** Per-method weights; falls back to 1 for unknown methods. */
  weights?: Record<string, number>;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export class CreditRateLimiter {
  constructor(_config: RateLimiterConfig) {}

  /** Credit cost of a method under the configured weights. */
  cost(_method: string): number {
    throw new NotImplementedError("CreditRateLimiter.cost");
  }

  /** Attempts to spend credits for `method`; returns false if the bucket is dry. */
  tryAcquire(_method: string): boolean {
    throw new NotImplementedError("CreditRateLimiter.tryAcquire");
  }

  /** Credits currently available (after refill). */
  available(): number {
    throw new NotImplementedError("CreditRateLimiter.available");
  }
}
