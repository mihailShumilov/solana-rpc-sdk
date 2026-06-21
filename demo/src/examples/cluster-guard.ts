/**
 * Cluster guard — the classic footgun is sending a mainnet-intended transaction
 * to a devnet RPC (or vice-versa). `ClusterDetector` identifies the cluster from
 * its immutable genesis hash (one cached `getGenesisHash` per client), and the
 * `TransactionSender`'s `clusterGuard` blocks a wrong-network send BEFORE any
 * broadcast leaves the client — throwing a typed `ClusterMismatchError`.
 */
import { TransactionSender, ClusterDetector, ClusterMismatchError } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  // The RPC actually points at DEVNET (it reports devnet's genesis hash)…
  const cluster = new MockCluster({
    initialBlockHeight: 700n,
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", // devnet
  });
  const endpoint = new MockEndpoint(cluster, { name: "rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);

  // …but the app intends to transact on mainnet-beta.
  const detector = new ClusterDetector();
  const detected = await detector.detectFromRpc(rpc);
  log(`ClusterDetector resolved the RPC's genesis hash → ${detected.cluster}`);

  // The guard runs before the first broadcast. Sharing the detector reuses the
  // cached genesis lookup (exactly one getGenesisHash per client).
  const sender = new TransactionSender(rpc, {
    sleep: async () => cluster.advanceSlots(1),
    clusterGuard: { expected: "mainnet-beta", mode: "throw", detector },
  });

  let blocked = false;
  let errorType = "—";
  try {
    await sender.sendAndConfirm({
      wireTransaction: "wrong-network-tx",
      signature: "wrong-network-tx",
      lastValidBlockHeight: 800n,
    });
    log("send proceeded (unexpected)");
  } catch (err) {
    blocked = err instanceof ClusterMismatchError;
    errorType = (err as Error).name;
    log(`send BLOCKED before broadcast: ${(err as Error).message}`);
  }

  return {
    logs,
    result: {
      "detected cluster": detected.cluster,
      "expected cluster": "mainnet-beta",
      "blocked before broadcast": blocked,
      "error type": errorType,
    },
  };
}
