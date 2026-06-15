/**
 * ConfirmationTracker — polls a transaction to a terminal outcome using the
 * correct Solana semantics: confirmation is decided by comparing current block
 * height against the transaction's `lastValidBlockHeight`, NOT by a timeout.
 * Once block height passes the deadline and the signature still has no status,
 * the transaction is expired (terminal) and must never be retried as-is.
 */
import type { Rpc, Signature, SolanaRpcApi } from "@solana/kit";

export type TerminalOutcome = "confirmed" | "expired";

export interface TrackConfig {
  signature: string;
  lastValidBlockHeight: bigint;
  /** Target commitment for "confirmed" (default "confirmed"). */
  commitment?: "confirmed" | "finalized";
  /** Delay between polls in ms (default 500). */
  pollIntervalMs?: number;
}

export interface TrackResult {
  signature: string;
  outcome: TerminalOutcome;
  slot: bigint | null;
  polls: number;
}

export interface ConfirmationDeps {
  /** Injected sleep so tests can advance the mock clock deterministically. */
  sleep?: (ms: number) => Promise<void>;
}

/** Commitment ordering: a higher rank satisfies a lower target. */
const COMMITMENT_RANK = { processed: 0, confirmed: 1, finalized: 2 } as const;

export class ConfirmationTracker {
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(rpc: Rpc<SolanaRpcApi>, deps?: ConfirmationDeps) {
    this.rpc = rpc;
    this.sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Polls until the tx is confirmed or its blockhash expires.
   *
   * Termination is the canonical Solana rule: the loop is bounded solely by
   * `lastValidBlockHeight` (block height passing the deadline), never an
   * arbitrary poll cap that could mask the real bound.
   */
  async track(config: TrackConfig): Promise<TrackResult> {
    const target = config.commitment ?? "confirmed";
    const targetRank = COMMITMENT_RANK[target];
    const pollIntervalMs = config.pollIntervalMs ?? 500;
    let polls = 0;

    for (;;) {
      polls++;

      // Check the signature status FIRST: a tx can land exactly at the deadline
      // block, so this must win over the expiry bound below.
      const signature = config.signature as Signature;
      const status = (
        await this.rpc.getSignatureStatuses([signature]).send()
      ).value[0];
      if (
        status != null &&
        status.err == null &&
        status.confirmationStatus != null &&
        COMMITMENT_RANK[status.confirmationStatus] >= targetRank
      ) {
        return {
          signature: config.signature,
          outcome: "confirmed",
          slot: status.slot,
          polls,
        };
        // NOTE: a landed-but-failed tx (status.err != null) is not a
        // TerminalOutcome here; on-chain error-state handling is the sender's
        // responsibility, not the confirmation tracker's.
      }

      // Termination bound: once current block height passes the caller-supplied
      // lastValidBlockHeight, the blockhash is dead and the tx can never land.
      const blockHeight = await this.rpc.getBlockHeight().send();
      if (blockHeight > config.lastValidBlockHeight) {
        return {
          signature: config.signature,
          outcome: "expired",
          slot: null,
          polls,
        };
      }

      await this.sleep(pollIntervalMs);
    }
  }
}
