/**
 * SPEC: TipEstimator turns the Jito tip_floor REST percentiles (denominated in
 * SOL) into lamports and recommends a tip clamped to the protocol minimum.
 * fetch is injected so the test is deterministic and offline.
 */
import { describe, it, expect } from "vitest";
import { TipEstimator, MIN_TIP_LAMPORTS } from "../../src/jito/tips.js";

/** A fetch stand-in whose Response.json() resolves to `body`. */
function fetchReturning(body: unknown): typeof fetch {
  return (async () => ({ json: async () => body })) as unknown as typeof fetch;
}

describe("TipEstimator.getTipFloor", () => {
  it("converts SOL percentiles to lamports from the array response shape", async () => {
    const est = new TipEstimator({
      fetchImpl: fetchReturning([
        {
          landed_tips_25th_percentile: 0.000001, // 1_000 lamports
          landed_tips_50th_percentile: 0.00001, // 10_000
          landed_tips_75th_percentile: 0.0001, // 100_000
          landed_tips_95th_percentile: 0.0005, // 500_000
          landed_tips_99th_percentile: 0.001, // 1_000_000
        },
      ]),
    });
    const floor = await est.getTipFloor();
    expect(floor).toEqual({
      p25: 1_000,
      p50: 10_000,
      p75: 100_000,
      p95: 500_000,
      p99: 1_000_000,
    });
  });

  it("handles a plain object response and defaults missing percentiles to 0", async () => {
    const est = new TipEstimator({
      fetchImpl: fetchReturning({ landed_tips_50th_percentile: 0.00002 }),
    });
    const floor = await est.getTipFloor();
    expect(floor.p50).toBe(20_000);
    expect(floor.p25).toBe(0); // missing field -> 0
  });

  it("returns all zeros when the body is empty/null", async () => {
    const est = new TipEstimator({ fetchImpl: fetchReturning(null) });
    const floor = await est.getTipFloor();
    expect(floor).toEqual({ p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 });
  });
});

describe("TipEstimator.recommendTip", () => {
  it("defaults to p50 and clamps up to the protocol minimum", async () => {
    const est = new TipEstimator({
      fetchImpl: fetchReturning([{ landed_tips_50th_percentile: 0.0000005 }]), // 500 < 1000
    });
    expect(await est.recommendTip()).toBe(MIN_TIP_LAMPORTS); // clamped to 1000
  });

  it("returns the floor value at an explicit percentile when above the minimum", async () => {
    const est = new TipEstimator({
      fetchImpl: fetchReturning([{ landed_tips_99th_percentile: 0.001 }]), // 1_000_000
    });
    expect(await est.recommendTip("p99")).toBe(1_000_000);
  });
});
