/**
 * SPEC: multi-endpoint confirmation polling (issue #4). The tracker fans out
 * getSignatureStatuses across the top-K freshest healthy endpoints, confirms as
 * soon as ANY reports the target commitment, fails fast on a definitive on-chain
 * error, tolerates a dead endpoint, and REUSES the pooled clients every round.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { ConfirmationTracker } from "../../src/tx/confirmation.js";
import { HealthMonitor } from "../../src/rpc/health.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function endpoint(cluster: MockCluster, name: string) {
  const ep = new MockEndpoint(cluster, { name });
  return { ep, name, rpc: createSolanaRpcFromTransport(ep.transport) };
}

describe("ConfirmationTracker multi-endpoint polling", () => {
  it("confirms when only the freshest node knows, lagging node still pending", async () => {
    const lagging = new MockCluster({ initialBlockHeight: 500n });
    const fresh = new MockCluster({ initialBlockHeight: 500n });
    const A = endpoint(lagging, "A");
    const B = endpoint(fresh, "B");
    fresh.rpcSendTransaction("Sig");
    fresh.advanceSlots(1); // landed on B only; A never sees it

    const hm = new HealthMonitor({ endpointNames: ["A", "B"] });
    hm.recordSuccess("A", 5, 100n);
    hm.recordSuccess("B", 5, 101n); // B is fresher → ranked first

    const tracker = new ConfirmationTracker(A.rpc, {
      sleep: async () => {},
      multiEndpoint: { endpoints: [A, B], healthMonitor: hm, k: 2 },
    });
    const res = await tracker.track({ signature: "Sig", lastValidBlockHeight: 650n });
    expect(res.outcome).toBe("confirmed");
  });

  it("fails fast on a definitive on-chain error from any endpoint", async () => {
    const failing = new MockCluster({ initialBlockHeight: 500n });
    const pending = new MockCluster({ initialBlockHeight: 500n });
    const A = endpoint(failing, "A");
    const B = endpoint(pending, "B");
    failing.scheduleFailure("Sig");
    failing.rpcSendTransaction("Sig");
    failing.advanceSlots(1); // A: landed-but-failed

    const hm = new HealthMonitor({ endpointNames: ["A", "B"] });
    const tracker = new ConfirmationTracker(A.rpc, {
      sleep: async () => {},
      multiEndpoint: { endpoints: [A, B], healthMonitor: hm, k: 2 },
    });
    const res = await tracker.track({ signature: "Sig", lastValidBlockHeight: 650n });
    expect(res.outcome).toBe("failed");
    expect(res.err).not.toBeNull();
  });

  it("tolerates a dead endpoint as long as one succeeds", async () => {
    const fresh = new MockCluster({ initialBlockHeight: 500n });
    const downCluster = new MockCluster({ initialBlockHeight: 500n });
    const down = new MockEndpoint(downCluster, { name: "A", faults: { offline: true } });
    const A = { ep: down, name: "A", rpc: createSolanaRpcFromTransport(down.transport) };
    const B = endpoint(fresh, "B");
    fresh.rpcSendTransaction("Sig");
    fresh.advanceSlots(1);

    const hm = new HealthMonitor({ endpointNames: ["A", "B"] });
    hm.recordSuccess("A", 5, 100n);
    hm.recordSuccess("B", 5, 200n); // B ranked first (also used for block height)

    const tracker = new ConfirmationTracker(B.rpc, {
      sleep: async () => {},
      multiEndpoint: { endpoints: [A, B], healthMonitor: hm, k: 2 },
    });
    const res = await tracker.track({ signature: "Sig", lastValidBlockHeight: 650n });
    expect(res.outcome).toBe("confirmed");
  });

  it("reuses the same pooled clients across every poll round (no churn)", async () => {
    const idle = new MockCluster({ initialBlockHeight: 500n });
    const lands = new MockCluster({ initialBlockHeight: 500n });
    const A = endpoint(idle, "A"); // never sees the tx → always pending
    const B = endpoint(lands, "B");
    lands.scheduleLanding("Sig", 3);
    lands.rpcSendTransaction("Sig");

    const hm = new HealthMonitor({ endpointNames: ["A", "B"] });
    hm.recordSuccess("A", 5, 100n);
    hm.recordSuccess("B", 5, 200n);

    const tracker = new ConfirmationTracker(B.rpc, {
      sleep: async () => {
        lands.advanceSlots(1);
      },
      multiEndpoint: { endpoints: [A, B], healthMonitor: hm, k: 2 },
    });
    const res = await tracker.track({ signature: "Sig", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    // Both endpoints were polled once per round on the SAME instances.
    expect(A.ep.rpcCalls.getSignatureStatuses).toBe(res.polls);
    expect(B.ep.rpcCalls.getSignatureStatuses).toBe(res.polls);
    expect(res.polls).toBeGreaterThan(1);
  });

  it("K=1 polls only the single freshest endpoint", async () => {
    const fresh = new MockCluster({ initialBlockHeight: 500n });
    const other = new MockCluster({ initialBlockHeight: 500n });
    const A = endpoint(other, "A");
    const B = endpoint(fresh, "B");
    fresh.rpcSendTransaction("Sig");
    fresh.advanceSlots(1);

    const hm = new HealthMonitor({ endpointNames: ["A", "B"] });
    hm.recordSuccess("A", 5, 100n);
    hm.recordSuccess("B", 5, 200n); // B freshest → the only one polled at K=1

    const tracker = new ConfirmationTracker(A.rpc, {
      sleep: async () => {},
      multiEndpoint: { endpoints: [A, B], healthMonitor: hm, k: 1 },
    });
    const res = await tracker.track({ signature: "Sig", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(A.ep.rpcCalls.getSignatureStatuses ?? 0).toBe(0); // never polled
  });
});
