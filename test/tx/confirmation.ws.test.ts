/**
 * SPEC: ConfirmationTracker's optional WebSocket fast-path (issue #1).
 *
 * The subscription races the poll loop and resolves on whichever fires first,
 * but the poll loop stays the sole authority for the EXPIRY bound. WS is
 * best-effort: any error/close falls back to pure polling with no regression.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { ConfirmationTracker } from "../../src/tx/confirmation.js";
import { MockCluster, MockEndpoint, MockSubscriptions } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster({ initialBlockHeight: 500n });
  const ep = new MockEndpoint(cluster);
  const rpc = createSolanaRpcFromTransport(ep.transport);
  const subs = new MockSubscriptions();
  const sleep = async () => {
    cluster.advanceSlots(1);
  };
  return { cluster, ep, rpc, subs, sleep };
}

describe("ConfirmationTracker WebSocket fast-path", () => {
  it("confirms via WS before the first poll fires (poll-count 0)", async () => {
    const { rpc, ep, subs, sleep } = setup();
    // Notification is already available when track() subscribes.
    subs.notify("SigWs", { err: null, slot: 777n });
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const res = await tracker.track({ signature: "SigWs", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.slot).toBe(777n);
    // Resolved from the WS event, so no poll was counted as completed.
    expect(res.polls).toBe(0);
    // At most the single in-flight first poll; the WS path then wins and aborts.
    expect(ep.rpcCalls.getSignatureStatuses ?? 0).toBeLessThanOrEqual(1);
  });

  it("treats a WS notification with err != null exactly like a failed status", async () => {
    const { rpc, subs, sleep } = setup();
    const onChainErr = { InstructionError: [0, { Custom: 6001 }] };
    subs.notify("SigBad", { err: onChainErr, slot: 12n });
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const res = await tracker.track({ signature: "SigBad", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("failed");
    expect(res.err).toEqual(onChainErr);
  });

  it("issues no further status poll after the WS notification arrives", async () => {
    const { cluster, rpc, ep, subs, sleep } = setup();
    // The tx never lands on the poll path, so only WS can resolve it.
    cluster.scheduleLanding("SigRace", -1);
    cluster.rpcSendTransaction("SigRace");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const trackPromise = tracker.track({ signature: "SigRace", lastValidBlockHeight: 600n });
    // Deliver after a microtask so at least the first poll may be in flight.
    await Promise.resolve();
    subs.notify("SigRace", { err: null, slot: 5n });

    const res = await trackPromise;
    expect(res.outcome).toBe("confirmed");

    // After resolution the poll loop is aborted: no further status poll fires.
    const callsAtResolve = ep.rpcCalls.getSignatureStatuses ?? 0;
    await Promise.resolve();
    await Promise.resolve();
    expect(ep.rpcCalls.getSignatureStatuses ?? 0).toBe(callsAtResolve);
  });

  it("falls back to polling when the subscription never delivers", async () => {
    const { cluster, rpc, subs, sleep } = setup();
    cluster.rpcSendTransaction("SigPoll"); // lands after 1 slot via the poll path
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const res = await tracker.track({ signature: "SigPoll", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.polls).toBeGreaterThan(0); // resolved by the poll loop, not WS
    expect(subs.stats.subscribes).toBe(1);
  });

  it("falls back to polling when subscribe() rejects (no unhandled rejection)", async () => {
    const { cluster, rpc, subs, sleep } = setup();
    subs.failSubscription("SigErr");
    cluster.rpcSendTransaction("SigErr");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const res = await tracker.track({ signature: "SigErr", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("confirmed");
    expect(res.polls).toBeGreaterThan(0);
  });

  it("falls back to polling when the stream closes empty", async () => {
    const { cluster, rpc, subs, sleep } = setup();
    cluster.rpcSendTransaction("SigClose");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const trackPromise = tracker.track({ signature: "SigClose", lastValidBlockHeight: 650n });
    await Promise.resolve();
    subs.endStream("SigClose"); // socket closed without a notification

    const res = await trackPromise;
    expect(res.outcome).toBe("confirmed");
    expect(res.polls).toBeGreaterThan(0);
  });

  it("expires via the poll bound even when WS never delivers", async () => {
    const { cluster, rpc, subs, sleep } = setup();
    cluster.scheduleLanding("SigGone", -1); // never lands
    cluster.rpcSendTransaction("SigGone");
    const tracker = new ConfirmationTracker(rpc, { sleep, subscriptions: subs });

    const res = await tracker.track({ signature: "SigGone", lastValidBlockHeight: 505n });

    expect(res.outcome).toBe("expired");
    expect(res.slot).toBeNull();
  });

  it("reports a landed-but-failed status from the poll path too", async () => {
    const { cluster, rpc, sleep } = setup();
    cluster.scheduleFailure("SigRevert");
    cluster.rpcSendTransaction("SigRevert"); // lands after 1 slot, but with err
    const tracker = new ConfirmationTracker(rpc, { sleep }); // pure polling, no WS

    const res = await tracker.track({ signature: "SigRevert", lastValidBlockHeight: 650n });

    expect(res.outcome).toBe("failed");
    expect(res.err).not.toBeNull();
  });
});
