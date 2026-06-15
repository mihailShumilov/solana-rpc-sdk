/**
 * Coverage-completing case for HealthMonitor.rankByFreshness: the slot-vs-slot
 * comparator branches, exercised with two HEALTHY endpoints whose slots differ
 * by less than maxSlotLag (so neither is ejected as a laggard).
 */
import { describe, it, expect } from "vitest";
import { HealthMonitor } from "../../src/rpc/health.js";

describe("HealthMonitor.rankByFreshness (both endpoints healthy)", () => {
  it("ranks a fresher first-inserted endpoint ahead of a slightly staler one", () => {
    const hm = new HealthMonitor({ endpointNames: ["x", "y"] });
    hm.recordSuccess("x", 10, 2000n); // fresher
    hm.recordSuccess("y", 10, 1950n); // 50 slots behind (< default maxSlotLag) -> still healthy
    expect(hm.rankByFreshness()).toEqual(["x", "y"]);
  });

  it("ranks a fresher second-inserted endpoint ahead of a staler first one", () => {
    const hm = new HealthMonitor({ endpointNames: ["p", "q"] });
    hm.recordSuccess("p", 10, 1950n); // staler
    hm.recordSuccess("q", 10, 2000n); // fresher
    expect(hm.rankByFreshness()).toEqual(["q", "p"]);
  });
});
