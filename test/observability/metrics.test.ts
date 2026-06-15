/**
 * InMemoryMetrics is implemented test infrastructure, so these are GREEN now.
 * They lock the metrics contract the SDK emits against (used by pool/sender
 * specs and, later, the OTel/Datadog exporter).
 */
import { describe, it, expect } from "vitest";
import { InMemoryMetrics } from "../../src/observability/metrics.js";

describe("InMemoryMetrics", () => {
  it("records requests and computes a success rate", () => {
    const m = new InMemoryMetrics();
    m.recordRequest("a", "getSlot", 10, true);
    m.recordRequest("a", "getSlot", 12, false);
    expect(m.requests).toHaveLength(2);
    expect(m.successRate()).toBe(0.5);
  });

  it("tracks rate-limits, rebroadcasts, landings and slots", () => {
    const m = new InMemoryMetrics();
    m.recordRateLimited("a");
    m.recordRebroadcast("sig");
    m.recordLanding("sig", "confirmed", 2);
    m.recordSlot("a", 1234n);
    expect(m.rateLimited).toEqual(["a"]);
    expect(m.rebroadcasts).toEqual(["sig"]);
    expect(m.landings[0]?.outcome).toBe("confirmed");
    expect(m.slots[0]?.slot).toBe(1234n);
  });

  it("returns a perfect success rate when no requests were recorded", () => {
    expect(new InMemoryMetrics().successRate()).toBe(1);
  });
});
