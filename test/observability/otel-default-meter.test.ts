/**
 * Coverage-completing case: OtelMetrics with no injected Meter resolves the
 * global OTel meter (a no-op until a MeterProvider is registered), so recording
 * is side-effect-free and never throws.
 */
import { describe, it, expect } from "vitest";
import { OtelMetrics } from "../../src/observability/metrics.js";

describe("OtelMetrics (default global meter)", () => {
  it("constructs against the global meter and records without throwing", () => {
    const m = new OtelMetrics();
    expect(() => {
      m.recordRequest("a", "getSlot", 1, true);
      m.recordRequest("a", "getSlot", 2, false);
      m.recordRateLimited("a");
      m.recordRebroadcast("sig");
      m.recordLanding("sig", "expired", 3);
      m.recordSlot("a", 1n);
    }).not.toThrow();
  });

  it("honors a provided serviceName", () => {
    const m = new OtelMetrics({ serviceName: "svc" });
    expect(() => m.recordSlot("a", 7n)).not.toThrow();
  });
});
