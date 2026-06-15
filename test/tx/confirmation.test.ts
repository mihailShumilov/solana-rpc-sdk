/**
 * SPEC (red until implemented): ConfirmationTracker decides outcome by block
 * height vs lastValidBlockHeight, returns "confirmed" when the tx lands, and
 * "expired" once the deadline passes — bounded, never an infinite poll.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { ConfirmationTracker } from "../../src/tx/confirmation.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster({ initialBlockHeight: 500n });
  const ep = new MockEndpoint(cluster);
  const rpc = createSolanaRpcFromTransport(ep.transport);
  // sleep advances the cluster one slot per poll -> deterministic, instant.
  const sleep = async () => {
    cluster.advanceSlots(1);
  };
  return { cluster, rpc, sleep };
}

describe("ConfirmationTracker", () => {
  it("returns confirmed once the tx lands", async () => {
    const { cluster, rpc, sleep } = setup();
    cluster.rpcSendTransaction("SigOK"); // lands after 1 slot by default
    const tracker = new ConfirmationTracker(rpc, { sleep });
    const res = await tracker.track({ signature: "SigOK", lastValidBlockHeight: 650n });
    expect(res.outcome).toBe("confirmed");
    expect(res.slot).not.toBeNull();
  });

  it("returns expired once block height passes lastValidBlockHeight", async () => {
    const { cluster, rpc, sleep } = setup();
    cluster.scheduleLanding("SigDead", -1); // never lands
    cluster.rpcSendTransaction("SigDead");
    const tracker = new ConfirmationTracker(rpc, { sleep });
    const res = await tracker.track({ signature: "SigDead", lastValidBlockHeight: 505n });
    expect(res.outcome).toBe("expired");
  });

  it("terminates within a bounded number of polls", async () => {
    const { cluster, rpc, sleep } = setup();
    cluster.scheduleLanding("SigDead2", -1);
    cluster.rpcSendTransaction("SigDead2");
    const tracker = new ConfirmationTracker(rpc, { sleep });
    const res = await tracker.track({ signature: "SigDead2", lastValidBlockHeight: 510n });
    // deadline is 10 slots out; should give up close to that, not spin.
    expect(res.polls).toBeLessThanOrEqual(15);
  });
});
