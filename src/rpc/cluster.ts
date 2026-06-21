/**
 * ClusterDetector — identifies which Solana cluster an RPC points at via its
 * genesis hash (issue #5), so the SDK can guard against the classic "sent a
 * mainnet-intended transaction to devnet" mistake. The genesis hash uniquely
 * and immutably identifies a cluster, so the result is cached per RPC client:
 * exactly one `getGenesisHash` call per endpoint.
 *
 * `detectFromRpc` NEVER throws: an RPC failure yields `{ cluster: "unknown" }`.
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "unknown";

/** Canonical genesis hash → cluster. These are fixed constants of each cluster. */
export const CLUSTER_GENESIS_HASHES: Readonly<Record<string, Exclude<Cluster, "unknown">>> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

export interface ClusterInfo {
  cluster: Cluster;
  /** The raw genesis hash, or null when detection failed. */
  genesisHash: string | null;
}

export class ClusterDetector {
  /** Per-RPC cache. Genesis hash is immutable, so one lookup per client suffices. */
  private readonly cache = new WeakMap<object, Promise<ClusterInfo>>();

  /**
   * Resolve the cluster behind an RPC client. Cached per client; a failed
   * detection is NOT cached, so a transient RPC outage can be retried.
   */
  async detectFromRpc(rpc: Rpc<SolanaRpcApi>): Promise<ClusterInfo> {
    const key = rpc as unknown as object;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const pending = this.detect(rpc).then((info) => {
      if (info.genesisHash === null) this.cache.delete(key); // don't cache failures
      return info;
    });
    this.cache.set(key, pending);
    return pending;
  }

  private async detect(rpc: Rpc<SolanaRpcApi>): Promise<ClusterInfo> {
    try {
      const genesisHash = (await rpc.getGenesisHash().send()) as string;
      return { cluster: CLUSTER_GENESIS_HASHES[genesisHash] ?? "unknown", genesisHash };
    } catch {
      return { cluster: "unknown", genesisHash: null };
    }
  }
}

/** How the sender/pool reacts to a detected cluster mismatch. */
export type ClusterGuardMode = "warn" | "throw" | "off";

export interface ClusterGuardConfig {
  /** The cluster the caller intends to transact on. */
  expected: Cluster;
  /** `throw` (default) blocks the send; `warn` emits and proceeds; `off` disables. */
  mode?: ClusterGuardMode;
  /** Share a detector so the genesis lookup is cached across senders. */
  detector?: ClusterDetector;
}
