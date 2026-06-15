/**
 * Self-tests for the simulation harness itself. These MUST be green: they prove
 * the mock cluster is wired correctly to real `@solana/kit` RPC objects and that
 * each fault behaves as documented. The SDK specs build on top of this contract.
 */
import { describe, it, expect } from "vitest";
import {
  createSolanaRpcFromTransport,
  generateKeyPairSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  MockCluster,
  MockEndpoint,
  MockJitoEngine,
  HttpTransportError,
  TransportDroppedError,
  firstSignatureFromWireBase64,
} from "./index.js";

function rpcFor(endpoint: MockEndpoint) {
  return createSolanaRpcFromTransport(endpoint.transport);
}

describe("MockCluster + kit RPC integration", () => {
  it("returns the cluster slot as a bigint through a real kit RPC", async () => {
    const cluster = new MockCluster({ initialSlot: 5000n });
    const rpc = rpcFor(new MockEndpoint(cluster));
    const slot = await rpc.getSlot().send();
    expect(slot).toBe(5000n);
  });

  it("issues a blockhash with lastValidBlockHeight = blockHeight + 150", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 2000n });
    const rpc = rpcFor(new MockEndpoint(cluster));
    const { value } = await rpc.getLatestBlockhash().send();
    expect(value.lastValidBlockHeight).toBe(2150n);
    expect(typeof value.blockhash).toBe("string");
  });
});

describe("transaction landing semantics", () => {
  it("lands a tx after the default delay once slots advance", () => {
    const cluster = new MockCluster();
    cluster.rpcSendTransaction("Sig11111landing");
    expect(cluster.getTx("Sig11111landing")?.status).toBe("pending");
    cluster.advanceSlots(1);
    expect(cluster.getTx("Sig11111landing")?.status).toBe("landed");
    const status = cluster.rpcGetSignatureStatuses(["Sig11111landing"]).value[0];
    expect(status?.confirmationStatus).toBe("confirmed");
  });

  it("silently drops a tx that never lands no matter how many slots pass", () => {
    const cluster = new MockCluster();
    cluster.scheduleLanding("SigDrop", -1);
    cluster.rpcSendTransaction("SigDrop");
    cluster.advanceSlots(200);
    expect(cluster.getTx("SigDrop")?.status).toBe("pending");
    expect(cluster.rpcGetSignatureStatuses(["SigDrop"]).value[0]).toBeNull();
  });

  it("expires a tx once blockHeight passes lastValidBlockHeight", () => {
    const cluster = new MockCluster();
    cluster.scheduleLanding("SigSlow", 1000); // would land far in the future
    cluster.rpcSendTransaction("SigSlow");
    cluster.advanceSlots(151);
    expect(cluster.getTx("SigSlow")?.status).toBe("expired");
    expect(cluster.rpcGetSignatureStatuses(["SigSlow"]).value[0]).toBeNull();
  });
});

describe("endpoint fault profiles", () => {
  it("reports a lagging slot for a lagged endpoint", async () => {
    const cluster = new MockCluster({ initialSlot: 9000n });
    const healthy = rpcFor(new MockEndpoint(cluster, { name: "fast" }));
    const lagged = rpcFor(new MockEndpoint(cluster, { name: "slow", faults: { slotLag: 120 } }));
    expect(await healthy.getSlot().send()).toBe(9000n);
    expect(await lagged.getSlot().send()).toBe(8880n);
  });

  it("throws a 429 when rate-limited", async () => {
    const cluster = new MockCluster();
    const rpc = rpcFor(new MockEndpoint(cluster, { faults: { rate429Rate: 1 } }));
    await expect(rpc.getSlot().send()).rejects.toBeInstanceOf(HttpTransportError);
  });

  it("rejects every request when offline", async () => {
    const cluster = new MockCluster();
    const rpc = rpcFor(new MockEndpoint(cluster, { faults: { offline: true } }));
    await expect(rpc.getSlot().send()).rejects.toBeInstanceOf(TransportDroppedError);
  });
});

describe("MockJitoEngine", () => {
  it("exposes 8 tip accounts and tip-floor percentiles", () => {
    const jito = new MockJitoEngine();
    expect(jito.getTipAccounts()).toHaveLength(8);
    expect(jito.getTipFloor().landed_tips_50th_percentile).toBeGreaterThan(0);
  });

  it("lands a bundle after the default poll count", () => {
    const jito = new MockJitoEngine({ defaultLandsAfterPolls: 1 });
    const id = jito.sendBundle(["sigA", "sigB"]);
    expect(jito.getInflightBundleStatuses([id])[0]!.status).toBe("Landed");
  });

  it("keeps a never-lands bundle Pending forever", () => {
    const jito = new MockJitoEngine();
    const id = jito.sendBundle(["sigC"]);
    jito.scheduleBundleNeverLands(id);
    for (let i = 0; i < 10; i++) jito.getInflightBundleStatuses([id]);
    expect(jito.getInflightBundleStatuses([id])[0]!.status).toBe("Pending");
  });

  it("enforces a rate limit", () => {
    const jito = new MockJitoEngine({ rateLimit: 1 });
    jito.sendBundle(["s1"]);
    expect(() => jito.sendBundle(["s2"])).toThrow(/429/);
  });
});

describe("wire-format signature extraction matches kit", () => {
  it("derives the same signature kit reports for a real signed transaction", async () => {
    const cluster = new MockCluster();
    const rpc = rpcFor(new MockEndpoint(cluster));
    const signer = await generateKeyPairSigner();
    const { value: latest } = await rpc.getLatestBlockhash().send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const kitSig = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);

    expect(firstSignatureFromWireBase64(wire)).toBe(kitSig);
  });
});
