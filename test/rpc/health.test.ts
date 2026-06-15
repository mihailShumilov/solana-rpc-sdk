/**
 * SPEC (red until implemented): HealthMonitor must rank endpoints by freshness,
 * eject endpoints after repeated failures, and treat slot-laggards as unhealthy.
 */
import { describe, it, expect } from "vitest";
import { HealthMonitor } from "../../src/rpc/health.js";

describe("HealthMonitor", () => {
  it("ranks healthy endpoints freshest-slot first", () => {
    const hm = new HealthMonitor({ endpointNames: ["a", "b"] });
    hm.recordSuccess("a", 12, 1000n);
    hm.recordSuccess("b", 12, 1005n);
    expect(hm.rankByFreshness()[0]).toBe("b");
  });

  it("breaks freshness ties by lower latency", () => {
    const hm = new HealthMonitor({ endpointNames: ["a", "b"] });
    hm.recordSuccess("a", 50, 1000n);
    hm.recordSuccess("b", 5, 1000n);
    expect(hm.rankByFreshness()[0]).toBe("b");
  });

  it("ejects an endpoint after the failure threshold", () => {
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 3 });
    hm.recordFailure("a", new Error("x"));
    hm.recordFailure("a", new Error("x"));
    expect(hm.isHealthy("a")).toBe(true);
    hm.recordFailure("a", new Error("x"));
    expect(hm.isHealthy("a")).toBe(false);
  });

  it("recovers an endpoint after a success", () => {
    const hm = new HealthMonitor({ endpointNames: ["a"], failureThreshold: 1 });
    hm.recordFailure("a", new Error("x"));
    expect(hm.isHealthy("a")).toBe(false);
    hm.recordSuccess("a", 10, 2000n);
    expect(hm.isHealthy("a")).toBe(true);
  });

  it("marks a slot-laggard beyond maxSlotLag as unhealthy", () => {
    const hm = new HealthMonitor({ endpointNames: ["fresh", "stale"], maxSlotLag: 50n });
    hm.recordSuccess("fresh", 10, 10_000n);
    hm.recordSuccess("stale", 10, 9_900n); // 100 slots behind > 50
    expect(hm.isHealthy("fresh")).toBe(true);
    expect(hm.isHealthy("stale")).toBe(false);
  });

  it("exposes a snapshot with one entry per endpoint", () => {
    const hm = new HealthMonitor({ endpointNames: ["a", "b"] });
    hm.recordSuccess("a", 10, 1n);
    const snap = hm.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });
});
