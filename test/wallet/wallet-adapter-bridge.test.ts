/**
 * SPEC: WalletAdapterBridge (issue #6) signs with a standard wallet-adapter
 * signer, lands the tx through the resilient sender (and via the Jito router
 * when enabled), supports signAllTransactions, and surfaces a wallet rejection
 * as a USER_REJECTED translated error.
 */
import { describe, it, expect, vi } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { WalletAdapterBridge, type WalletAdapterSigner } from "../../src/wallet/wallet-adapter-bridge.js";
import { TransactionSender } from "../../src/tx/sender.js";
import { JitoRouter, type JitoEngineClient } from "../../src/jito/router.js";
import { TipEstimator } from "../../src/jito/tips.js";
import { TranslatedError } from "../../src/error-translator.js";
import { MockCluster, MockEndpoint, MockJitoEngine } from "../harness/index.js";

function senderOn(cluster: MockCluster): TransactionSender {
  const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
  return new TransactionSender(rpc, { sleep: async () => cluster.advanceSlots(1) });
}

/** A wallet-adapter-shaped signer whose "signing" prefixes the wire (mock). */
function mockWallet(overrides: Partial<WalletAdapterSigner> = {}): WalletAdapterSigner {
  return {
    publicKey: { toString: () => "Wa11etPubkey1111111111111111111111111111111" },
    signTransaction: vi.fn(async (tx: string) => tx),
    ...overrides,
  };
}

describe("WalletAdapterBridge", () => {
  it("signs via a wallet-adapter signer and lands through the resilient sender", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const wallet = mockWallet();
    const bridge = new WalletAdapterBridge({ wallet, sender: senderOn(cluster) });

    const res = await bridge.signAndSend("SigWab1", { lastValidBlockHeight: 400n });

    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(res.outcome).toBe("confirmed");
    expect(bridge.address).toBe("Wa11etPubkey1111111111111111111111111111111");
  });

  it("routes through Jito with RPC fallback when a router is supplied", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 900n });
    const sender = senderOn(cluster);
    const jitoEngine = new MockJitoEngine();
    const engineClient: JitoEngineClient = {
      getTipAccounts: async () => jitoEngine.getTipAccounts(),
      sendBundle: async (sigs) => jitoEngine.sendBundle(sigs),
      getInflightBundleStatuses: async (ids) => jitoEngine.getInflightBundleStatuses(ids),
    };
    const id = jitoEngine.sendBundle(["SigWab2"]);
    jitoEngine.scheduleBundleNeverLands(id);
    cluster.rpcSendTransaction("SigWab2"); // RPC fallback lands it

    const router = new JitoRouter(engineClient, new TipEstimator(), sender, {
      sleep: async () => cluster.advanceSlots(1),
    });
    const bridge = new WalletAdapterBridge({ wallet: mockWallet(), sender, jito: router });

    const res = await bridge.signAndSend("SigWab2", { lastValidBlockHeight: 1000n, rebroadcastIntervalMs: 1000 });
    expect(res.outcome).toBe("confirmed");
    expect((res as { route?: string }).route).toBe("rpc");
  });

  it("surfaces a wallet rejection as a USER_REJECTED translated error", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const wallet = mockWallet({
      signTransaction: vi.fn(async () => {
        throw new Error("User rejected the request.");
      }),
    });
    const bridge = new WalletAdapterBridge({ wallet, sender: senderOn(cluster) });

    const err = await bridge.signAndSend("Sig", { lastValidBlockHeight: 400n }).catch((e) => e);
    expect(err).toBeInstanceOf(TranslatedError);
    expect(err.code).toBe("USER_REJECTED");
  });

  it("supports signAllTransactions and returns N results in order", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const signAllTransactions = vi.fn(async (txs: string[]) => txs);
    const wallet = mockWallet({ signAllTransactions });
    const bridge = new WalletAdapterBridge({ wallet, sender: senderOn(cluster) });

    const sigs = ["SigA", "SigB", "SigC"];
    const results = await bridge.signAndSendAll(sigs, { lastValidBlockHeight: 400n });

    expect(signAllTransactions).toHaveBeenCalledOnce();
    expect(results.map((r) => r.signature)).toEqual(sigs); // order preserved
    expect(results.every((r) => r.outcome === "confirmed")).toBe(true);
  });

  it("falls back to per-transaction signing when signAllTransactions is absent", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const signTransaction = vi.fn(async (tx: string) => tx);
    const wallet = mockWallet({ signTransaction });
    const bridge = new WalletAdapterBridge({ wallet, sender: senderOn(cluster) });

    const results = await bridge.signAndSendAll(["SigX", "SigY"], { lastValidBlockHeight: 400n });
    expect(signTransaction).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.signature)).toEqual(["SigX", "SigY"]);
  });

  it("exposes a null address when the wallet has no public key", () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const bridge = new WalletAdapterBridge({ wallet: mockWallet({ publicKey: null }), sender: senderOn(cluster) });
    expect(bridge.address).toBeNull();
  });
});
