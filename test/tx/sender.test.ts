/**
 * SPEC (red until implemented): TransactionSender is the landing state machine.
 * It must send with maxRetries:0, rebroadcast on a loop, confirm via block
 * height, give up at expiry, and NEVER mutate/re-sign the transaction.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { TransactionSender } from "../../src/tx/sender.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster({ initialBlockHeight: 700n });
  const ep = new MockEndpoint(cluster);
  const rpc = createSolanaRpcFromTransport(ep.transport);
  const sleep = async () => {
    cluster.advanceSlots(1);
  };
  return { cluster, ep, rpc, sleep };
}

describe("TransactionSender", () => {
  it("confirms a tx that lands, rebroadcasting at least once", async () => {
    const { rpc, sleep } = setup();
    const sender = new TransactionSender(rpc, { sleep });
    // short string -> mock treats it as a raw signature
    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSend1",
      signature: "SigSend1",
      lastValidBlockHeight: 800n,
    });
    expect(res.outcome).toBe("confirmed");
    expect(res.rebroadcasts).toBeGreaterThanOrEqual(1);
  });

  it("sends with maxRetries:0 (disables the RPC's own retry)", async () => {
    const { ep, rpc, sleep } = setup();
    const sender = new TransactionSender(rpc, { sleep });
    await sender.sendAndConfirm({
      wireTransaction: "SigSend2",
      signature: "SigSend2",
      lastValidBlockHeight: 800n,
    });
    expect(ep.lastSendParams?.maxRetries).toBe(0);
  });

  it("returns expired for a dropped tx and stops at the deadline", async () => {
    const { cluster, rpc, sleep } = setup();
    cluster.scheduleLanding("SigSend3", -1); // silent drop
    const sender = new TransactionSender(rpc, { sleep });
    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSend3",
      signature: "SigSend3",
      lastValidBlockHeight: 710n,
    });
    expect(res.outcome).toBe("expired");
  });

  it("never changes the signature (no re-sign / no double-charge)", async () => {
    const { rpc, sleep } = setup();
    const sender = new TransactionSender(rpc, { sleep });
    const res = await sender.sendAndConfirm({
      wireTransaction: "SigSend4",
      signature: "SigSend4",
      lastValidBlockHeight: 800n,
    });
    expect(res.signature).toBe("SigSend4");
  });

  it("emits landing metrics", async () => {
    const { rpc, sleep } = setup();
    const metrics = new InMemoryMetrics();
    const sender = new TransactionSender(rpc, { sleep, metrics });
    await sender.sendAndConfirm({
      wireTransaction: "SigSend5",
      signature: "SigSend5",
      lastValidBlockHeight: 800n,
    });
    expect(metrics.landings.at(-1)?.outcome).toBe("confirmed");
  });
});
