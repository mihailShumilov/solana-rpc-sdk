/**
 * Coverage-completing case for JitoRouter: a bundle reported "Failed" is
 * unrecoverable on Jito, so the router breaks immediately and falls back to RPC.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { JitoRouter, type JitoEngineClient } from "../../src/jito/router.js";
import { TransactionSender } from "../../src/tx/sender.js";
import { TipEstimator } from "../../src/jito/tips.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("JitoRouter (Failed bundle status)", () => {
  it("falls back to RPC when the bundle status is Failed", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 900n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    const sleep = async () => {
      cluster.advanceSlots(1);
    };
    const sender = new TransactionSender(rpc, { sleep });
    const sig = "SigFail1";
    cluster.rpcSendTransaction(sig); // the RPC path lands it

    const engine: JitoEngineClient = {
      getTipAccounts: async () => [],
      sendBundle: async () => "bundle_x",
      getInflightBundleStatuses: async (ids) => ids.map((id) => ({ bundle_id: id, status: "Failed" })),
    };
    const router = new JitoRouter(engine, new TipEstimator(), sender, { sleep });
    const res = await router.sendWithFallback({
      wireTransaction: sig,
      signature: sig,
      lastValidBlockHeight: 1000n,
    });
    expect(res.route).toBe("rpc");
    expect(res.outcome).toBe("confirmed");
  });
});
