/**
 * SPEC (red until implemented): CreditRateLimiter meters by weighted credits and
 * refills per window. Heavy methods cost more, and the bucket must dry out and
 * then refill on the injected clock.
 */
import { describe, it, expect } from "vitest";
import { CreditRateLimiter } from "../../src/rpc/rate-limit.js";

describe("CreditRateLimiter", () => {
  it("weights heavy methods above cheap ones", () => {
    const rl = new CreditRateLimiter({ creditsPerWindow: 100, windowMs: 1000 });
    expect(rl.cost("getBalance")).toBe(1);
    expect(rl.cost("simulateTransaction")).toBe(10);
    expect(rl.cost("totallyUnknownMethod")).toBe(1);
  });

  it("spends credits and refuses once the bucket is dry", () => {
    const rl = new CreditRateLimiter({ creditsPerWindow: 10, windowMs: 1000, now: () => 0 });
    expect(rl.tryAcquire("simulateTransaction")).toBe(true); // costs 10 -> empties
    expect(rl.tryAcquire("getBalance")).toBe(false); // nothing left
    expect(rl.available()).toBe(0);
  });

  it("refills after the window elapses", () => {
    let t = 0;
    const rl = new CreditRateLimiter({ creditsPerWindow: 10, windowMs: 1000, now: () => t });
    expect(rl.tryAcquire("simulateTransaction")).toBe(true);
    expect(rl.tryAcquire("getBalance")).toBe(false);
    t = 1000;
    expect(rl.tryAcquire("getBalance")).toBe(true);
  });
});
