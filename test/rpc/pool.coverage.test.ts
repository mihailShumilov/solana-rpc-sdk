/**
 * Coverage-completing cases for ResilientRpcPool: the non-freshness routing
 * path, the rate-limiter dry-bucket soft-failure, and the health() snapshot.
 */
import { describe, it, expect } from "vitest";
import { ResilientRpcPool } from "../../src/rpc/pool.js";
import { CreditRateLimiter } from "../../src/rpc/rate-limit.js";
import { HealthMonitor } from "../../src/rpc/health.js";
import { AllEndpointsFailedError } from "../../src/errors.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("ResilientRpcPool (non-freshness + rate limiting)", () => {
  it("serves from config order when freshnessAware is off, and exposes health()", async () => {
    const cluster = new MockCluster({ initialSlot: 777n });
    const ep = new MockEndpoint(cluster, { name: "only" });
    const pool = new ResilientRpcPool({
      endpoints: [{ name: "only", transport: ep.transport }],
      freshnessAware: false,
    });
    const slot = await pool.rpc().getSlot().send();
    expect(slot).toBe(777n);
    expect(pool.health()).toHaveLength(1);
  });

  it("uses an injected health monitor and a permissive rate limiter on the freshness-probe path", async () => {
    const cluster = new MockCluster({ initialSlot: 555n });
    const ep = new MockEndpoint(cluster, { name: "only" });
    const hm = new HealthMonitor({ endpointNames: ["only"] });
    const limiter = new CreditRateLimiter({ creditsPerWindow: 1000, windowMs: 1000, now: () => 0 });
    const pool = new ResilientRpcPool({
      endpoints: [{ name: "only", transport: ep.transport }],
      healthMonitor: hm,
      rateLimiter: limiter,
      // freshnessAware defaults to true -> exercises the probe + ranking path
    });
    const slot = await pool.rpc().getSlot().send();
    expect(slot).toBe(555n);
    expect(hm.snapshot()).toHaveLength(1);
  });

  it("treats a dry credit bucket as a soft failure and fails over to AllEndpointsFailedError", async () => {
    const cluster = new MockCluster();
    const ep = new MockEndpoint(cluster, { name: "only" });
    const limiter = new CreditRateLimiter({ creditsPerWindow: 0, windowMs: 1000, now: () => 0 });
    const pool = new ResilientRpcPool({
      endpoints: [{ name: "only", transport: ep.transport }],
      rateLimiter: limiter,
      freshnessAware: false,
    });
    await expect(pool.rpc().getSlot().send()).rejects.toBeInstanceOf(AllEndpointsFailedError);
  });
});
