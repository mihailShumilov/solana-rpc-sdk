/**
 * SPEC (red until implemented): ResilientRpcPool fails over across endpoints,
 * routes to the freshest healthy node, surfaces AllEndpointsFailedError when
 * everything is down, and feeds health + metrics.
 */
import { describe, it, expect } from "vitest";
import { ResilientRpcPool } from "../../src/rpc/pool.js";
import { AllEndpointsFailedError } from "../../src/errors.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("ResilientRpcPool", () => {
  it("fails over to a healthy endpoint when the first 429s", async () => {
    const cluster = new MockCluster({ initialSlot: 4242n });
    const bad = new MockEndpoint(cluster, { name: "bad", faults: { rate429Rate: 1 } });
    const good = new MockEndpoint(cluster, { name: "good" });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "bad", transport: bad.transport },
        { name: "good", transport: good.transport },
      ],
    });
    const slot = await pool.rpc().getSlot().send();
    expect(slot).toBe(4242n);
  });

  it("throws AllEndpointsFailedError when every endpoint is offline", async () => {
    const cluster = new MockCluster();
    const a = new MockEndpoint(cluster, { name: "a", faults: { offline: true } });
    const b = new MockEndpoint(cluster, { name: "b", faults: { offline: true } });
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "a", transport: a.transport },
        { name: "b", transport: b.transport },
      ],
    });
    await expect(pool.rpc().getSlot().send()).rejects.toBeInstanceOf(AllEndpointsFailedError);
  });

  it("routes to the freshest node when freshnessAware is on", async () => {
    const cluster = new MockCluster({ initialSlot: 10_000n });
    const stale = new MockEndpoint(cluster, { name: "stale", faults: { slotLag: 200 } });
    const fresh = new MockEndpoint(cluster, { name: "fresh" });
    const pool = new ResilientRpcPool({
      freshnessAware: true,
      endpoints: [
        // deliberately list the stale one first
        { name: "stale", transport: stale.transport },
        { name: "fresh", transport: fresh.transport },
      ],
    });
    // warm health up so the monitor knows each node's slot
    await pool.rpc().getSlot().send();
    const slot = await pool.rpc().getSlot().send();
    expect(slot).toBe(10_000n); // fresh node, not the lagged 9_800
  });

  it("records per-request metrics", async () => {
    const cluster = new MockCluster();
    const metrics = new InMemoryMetrics();
    const ep = new MockEndpoint(cluster, { name: "only" });
    const pool = new ResilientRpcPool({
      endpoints: [{ name: "only", transport: ep.transport }],
      metrics,
    });
    await pool.rpc().getSlot().send();
    expect(metrics.requests.length).toBeGreaterThan(0);
    expect(metrics.requests.at(-1)?.ok).toBe(true);
  });
});
