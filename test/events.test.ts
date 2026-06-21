/**
 * SPEC: the typed lifecycle event stream (issue #3). Unit semantics of the
 * emitter (on/once/off, no-listener no-op, error isolation) plus end-to-end
 * emission from TransactionSender and ResilientRpcPool.
 */
import { describe, it, expect, vi } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { LifecycleEmitter } from "../src/events.js";
import { TransactionSender } from "../src/tx/sender.js";
import { ResilientRpcPool } from "../src/rpc/pool.js";
import { HealthMonitor } from "../src/rpc/health.js";
import { MockCluster, MockEndpoint } from "./harness/index.js";

describe("TypedEventEmitter semantics", () => {
  it("on receives every emit; emitting with no listeners is a no-op", () => {
    const events = new LifecycleEmitter();
    expect(() => events.emit("transaction:sent", { txId: "a", signature: "a", attempt: 0, durationMs: 0 })).not.toThrow();

    const seen: string[] = [];
    events.on("transaction:sent", (p) => seen.push(p.txId));
    events.emit("transaction:sent", { txId: "x", signature: "x", attempt: 0, durationMs: 1 });
    events.emit("transaction:sent", { txId: "y", signature: "y", attempt: 1, durationMs: 2 });
    expect(seen).toEqual(["x", "y"]);
  });

  it("once fires exactly once then auto-removes", () => {
    const events = new LifecycleEmitter();
    const cb = vi.fn();
    events.once("connection:failover", cb);
    events.emit("connection:failover", { from: "a", to: "b", reason: "x" });
    events.emit("connection:failover", { from: "b", to: "c", reason: "y" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("off removes a listener; the returned unsubscribe also removes", () => {
    const events = new LifecycleEmitter();
    const cb = vi.fn();
    const unsub = events.on("transaction:confirmed", cb);
    unsub();
    events.emit("transaction:confirmed", { txId: "a", signature: "a", attempt: 0, durationMs: 0, slot: 1n });
    expect(cb).not.toHaveBeenCalled();

    const cb2 = vi.fn();
    events.on("transaction:confirmed", cb2);
    events.off("transaction:confirmed", cb2);
    events.emit("transaction:confirmed", { txId: "a", signature: "a", attempt: 0, durationMs: 0, slot: 1n });
    expect(cb2).not.toHaveBeenCalled();
  });

  it("isolates a throwing listener so other listeners still run", () => {
    const events = new LifecycleEmitter();
    const ok = vi.fn();
    events.on("transaction:expired", () => {
      throw new Error("buggy UI handler");
    });
    events.on("transaction:expired", ok);
    expect(() => events.emit("transaction:expired", { txId: "a", signature: "a", attempt: 0, durationMs: 0 })).not.toThrow();
    expect(ok).toHaveBeenCalledOnce();
  });

  it("removeAllListeners clears handlers", () => {
    const events = new LifecycleEmitter();
    const cb = vi.fn();
    events.on("transaction:pending", cb);
    events.removeAllListeners();
    events.emit("transaction:pending", { txId: "a", signature: "a", attempt: 0, durationMs: 0 });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("TransactionSender lifecycle emissions", () => {
  function setup(initialBlockHeight = 700n) {
    const cluster = new MockCluster({ initialBlockHeight });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    const sleep = async () => {
      cluster.advanceSlots(1);
    };
    return { cluster, rpc, sleep };
  }

  it("emits pending → sent → confirmed with a consistent txId", async () => {
    const { rpc, sleep } = setup();
    const events = new LifecycleEmitter();
    const seq: string[] = [];
    const ids = new Set<string>();
    for (const t of ["transaction:pending", "transaction:sent", "transaction:confirmed"] as const) {
      events.on(t, (p) => {
        seq.push(t);
        ids.add(p.txId);
      });
    }
    const sender = new TransactionSender(rpc, { sleep, events });
    await sender.sendAndConfirm({ wireTransaction: "SigEv1", signature: "SigEv1", lastValidBlockHeight: 800n });

    expect(seq).toEqual(["transaction:pending", "transaction:sent", "transaction:confirmed"]);
    expect(ids.size).toBe(1); // one stable txId across the sequence
  });

  it("emits transaction:expired when the blockhash expires", async () => {
    const { cluster, rpc, sleep } = setup(700n);
    cluster.scheduleLanding("SigEv2", -1);
    const events = new LifecycleEmitter();
    const expired = vi.fn();
    events.on("transaction:expired", expired);
    const sender = new TransactionSender(rpc, { sleep, events });
    await sender.sendAndConfirm({ wireTransaction: "SigEv2", signature: "SigEv2", lastValidBlockHeight: 710n });
    expect(expired).toHaveBeenCalledOnce();
  });
});

describe("ResilientRpcPool connection emissions", () => {
  it("emits connection:failover {from,to,reason} on endpoint drop", async () => {
    const cluster = new MockCluster();
    const a = new MockEndpoint(cluster, { name: "A", faults: { offline: true } });
    const b = new MockEndpoint(cluster, { name: "B" });
    const events = new LifecycleEmitter();
    const failovers: Array<{ from: string; to: string }> = [];
    events.on("connection:failover", (p) => failovers.push({ from: p.from, to: p.to }));

    // freshnessAware:false keeps the static [A,B] order so A is tried first.
    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "A", transport: a.transport },
        { name: "B", transport: b.transport },
      ],
      freshnessAware: false,
      events,
    });
    await pool.rpc().getSlot().send();

    expect(failovers).toEqual([{ from: "A", to: "B" }]);
  });

  it("emits connection:health when an endpoint is ejected", async () => {
    const cluster = new MockCluster();
    const a = new MockEndpoint(cluster, { name: "A", faults: { offline: true } });
    const b = new MockEndpoint(cluster, { name: "B" });
    const events = new LifecycleEmitter();
    const healthEvents: Array<{ endpoint: string; healthy: boolean }> = [];
    events.on("connection:health", (p) => healthEvents.push({ endpoint: p.endpoint, healthy: p.healthy }));

    const pool = new ResilientRpcPool({
      endpoints: [
        { name: "A", transport: a.transport },
        { name: "B", transport: b.transport },
      ],
      freshnessAware: false,
      healthMonitor: new HealthMonitor({ endpointNames: ["A", "B"], failureThreshold: 1 }),
      events,
    });
    await pool.rpc().getSlot().send();

    expect(healthEvents).toContainEqual({ endpoint: "A", healthy: false });
  });
});
