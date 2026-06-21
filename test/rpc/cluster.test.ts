/**
 * SPEC: ClusterDetector + mismatch guard (issue #5). Detection maps genesis
 * hashes to clusters, never throws on RPC failure, and is cached. The sender's
 * guard blocks (throw) or warns (event) on a definitive mismatch before any
 * broadcast.
 */
import { describe, it, expect, vi } from "vitest";
import { createSolanaRpcFromTransport, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { ClusterDetector } from "../../src/rpc/cluster.js";
import { ClusterMismatchError } from "../../src/errors.js";
import { TransactionSender } from "../../src/tx/sender.js";
import { LifecycleEmitter } from "../../src/events.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

function rpcFor(genesisHash?: string, faults?: { offline?: boolean }): {
  rpc: Rpc<SolanaRpcApi>;
  ep: MockEndpoint;
  cluster: MockCluster;
} {
  const cluster = new MockCluster(genesisHash !== undefined ? { genesisHash } : {});
  const ep = new MockEndpoint(cluster, { faults });
  return { rpc: createSolanaRpcFromTransport(ep.transport), ep, cluster };
}

describe("ClusterDetector", () => {
  it("detects mainnet-beta / devnet / testnet, and unknown otherwise", async () => {
    const d = new ClusterDetector();
    expect((await d.detectFromRpc(rpcFor(GENESIS["mainnet-beta"]).rpc)).cluster).toBe("mainnet-beta");
    expect((await d.detectFromRpc(rpcFor(GENESIS.devnet).rpc)).cluster).toBe("devnet");
    expect((await d.detectFromRpc(rpcFor(GENESIS.testnet).rpc)).cluster).toBe("testnet");
    expect((await d.detectFromRpc(rpcFor("SomeUnknownGenesisHash1111111111111111111").rpc)).cluster).toBe("unknown");
  });

  it("never throws on RPC failure (returns unknown)", async () => {
    const d = new ClusterDetector();
    const { rpc } = rpcFor(undefined, { offline: true });
    const info = await d.detectFromRpc(rpc);
    expect(info.cluster).toBe("unknown");
    expect(info.genesisHash).toBeNull();
  });

  it("caches a successful detection (one getGenesisHash per client)", async () => {
    const d = new ClusterDetector();
    const { rpc, ep } = rpcFor(GENESIS.devnet);
    await d.detectFromRpc(rpc);
    await d.detectFromRpc(rpc);
    await d.detectFromRpc(rpc);
    expect(ep.rpcCalls.getGenesisHash).toBe(1);
  });
});

describe("TransactionSender cluster guard", () => {
  it("throw guard blocks the send on mismatch and never broadcasts", async () => {
    const { rpc, ep } = rpcFor(GENESIS.devnet); // RPC is devnet
    const sender = new TransactionSender(rpc, {
      sleep: async () => {},
      clusterGuard: { expected: "mainnet-beta", mode: "throw" },
    });

    await expect(
      sender.sendAndConfirm({ wireTransaction: "S", signature: "S", lastValidBlockHeight: 1200n }),
    ).rejects.toBeInstanceOf(ClusterMismatchError);
    expect(ep.stats.sends).toBe(0); // nothing was broadcast
  });

  it("warn guard emits connection:cluster-mismatch and proceeds", async () => {
    const { rpc, cluster } = rpcFor(GENESIS.devnet);
    const events = new LifecycleEmitter();
    const mismatches: Array<{ expected: string; actual: string }> = [];
    events.on("connection:cluster-mismatch", (p) => mismatches.push({ expected: p.expected, actual: p.actual }));
    const sender = new TransactionSender(rpc, {
      sleep: async () => cluster.advanceSlots(1),
      events,
      clusterGuard: { expected: "mainnet-beta", mode: "warn" },
    });

    const res = await sender.sendAndConfirm({ wireTransaction: "S", signature: "S", lastValidBlockHeight: 1200n });
    expect(res.outcome).toBe("confirmed"); // proceeded despite mismatch
    expect(mismatches).toEqual([{ expected: "mainnet-beta", actual: "devnet" }]);
  });

  it("mode 'off' does nothing (no detection, no block)", async () => {
    const { rpc, ep, cluster } = rpcFor(GENESIS.devnet);
    const sender = new TransactionSender(rpc, {
      sleep: async () => cluster.advanceSlots(1),
      clusterGuard: { expected: "mainnet-beta", mode: "off" },
    });
    const res = await sender.sendAndConfirm({ wireTransaction: "S", signature: "S", lastValidBlockHeight: 1200n });
    expect(res.outcome).toBe("confirmed");
    expect(ep.rpcCalls.getGenesisHash ?? 0).toBe(0); // guard disabled → no lookup
  });

  it("matching cluster proceeds and emits cluster-detected", async () => {
    const { rpc, cluster } = rpcFor(GENESIS["mainnet-beta"]);
    const events = new LifecycleEmitter();
    const detected: string[] = [];
    events.on("connection:cluster-detected", (p) => detected.push(p.cluster));
    const sender = new TransactionSender(rpc, {
      sleep: async () => cluster.advanceSlots(1),
      events,
      clusterGuard: { expected: "mainnet-beta", mode: "throw" },
    });
    const res = await sender.sendAndConfirm({ wireTransaction: "S", signature: "S", lastValidBlockHeight: 1200n });
    expect(res.outcome).toBe("confirmed");
    expect(detected).toEqual(["mainnet-beta"]);
  });
});
