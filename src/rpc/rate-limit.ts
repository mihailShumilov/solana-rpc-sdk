/**
 * CreditRateLimiter — token-bucket limiter that meters by *weighted credits*,
 * not raw request count, because providers charge heavy methods (e.g.
 * getProgramAccounts) many times a getBalance. Avoiding 429s requires modeling
 * that weighting client-side.
 */
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
  private readonly weights: Record<string, number>;
  private readonly creditsPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private availableCredits: number;
  private windowStart: number;

  constructor(config: RateLimiterConfig) {
    this.weights = { ...DEFAULT_METHOD_WEIGHTS, ...config.weights };
    this.creditsPerWindow = config.creditsPerWindow;
    this.windowMs = config.windowMs;
    this.now = config.now ?? Date.now;
    this.availableCredits = config.creditsPerWindow;
    this.windowStart = this.now();
  }

  /** Credit cost of a method under the configured weights. */
  cost(method: string): number {
    return this.weights[method] ?? 1;
  }

  /**
   * Lazily replenishes the bucket: if a full window has elapsed since
   * `windowStart`, reset credits and anchor a new window. No timers.
   */
  private refill(): void {
    const elapsed = this.now() - this.windowStart;
    if (elapsed >= this.windowMs) {
      this.availableCredits = this.creditsPerWindow;
      this.windowStart = this.now();
    }
  }

  /** Attempts to spend credits for `method`; returns false if the bucket is dry. */
  tryAcquire(method: string): boolean {
    this.refill();
    const c = this.cost(method);
    if (this.availableCredits >= c) {
      this.availableCredits -= c;
      return true;
    }
    return false;
  }

  /** Credits currently available (after refill). */
  available(): number {
    this.refill();
    return this.availableCredits;
  }
}
