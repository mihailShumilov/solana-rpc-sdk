/**
 * SPEC (red until implemented): JitoRouter routes via the Block Engine and falls
 * back to the RPC sender when a bundle does not land. This automatic fallback is
 * a hard submission requirement.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { JitoRouter, type JitoEngineClient } from "../../src/jito/router.js";
import { TransactionSender } from "../../src/tx/sender.js";
import { TipEstimator } from "../../src/jito/tips.js";
import { MockCluster, MockEndpoint, MockJitoEngine } from "../harness/index.js";

/** Adapts the (sync) MockJitoEngine to the async JitoEngineClient interface. */
function engineClient(jito: MockJitoEngine): JitoEngineClient {
  return {
    getTipAccounts: async () => jito.getTipAccounts(),
    sendBundle: async (sigs) => jito.sendBundle(sigs),
    getInflightBundleStatuses: async (ids) => jito.getInflightBundleStatuses(ids),
  };
}

function setup(jito: MockJitoEngine) {
  const cluster = new MockCluster({ initialBlockHeight: 900n });
  const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
  const sleep = async () => {
    cluster.advanceSlots(1);
  };
  const sender = new TransactionSender(rpc, { sleep });
  const router = new JitoRouter(engineClient(jito), new TipEstimator(), sender, { sleep });
  return { cluster, router };
}

describe("JitoRouter", () => {
  it("returns route 'jito' when the bundle lands", async () => {
    const jito = new MockJitoEngine({ defaultLandsAfterPolls: 1 });
    const { router } = setup(jito);
    const res = await router.sendWithFallback({
      wireTransaction: "SigJito1",
      signature: "SigJito1",
      lastValidBlockHeight: 1000n,
    });
    expect(res.route).toBe("jito");
    expect(res.outcome).toBe("confirmed");
  });

  it("falls back to RPC when the bundle never lands", async () => {
    const jito = new MockJitoEngine();
    const { cluster, router } = setup(jito);
    const sig = "SigJito2";
    const id = jito.sendBundle([sig]); // pre-register so we can mark it
    jito.scheduleBundleNeverLands(id);
    // the RPC path should still land it
    cluster.rpcSendTransaction(sig);
    const res = await router.sendWithFallback({
      wireTransaction: sig,
      signature: sig,
      lastValidBlockHeight: 1000n,
      maxBundlePolls: 3,
    });
    expect(res.route).toBe("rpc");
    expect(res.outcome).toBe("confirmed");
  });
});
