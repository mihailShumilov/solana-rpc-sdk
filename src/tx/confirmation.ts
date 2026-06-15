/**
 * ConfirmationTracker — polls a transaction to a terminal outcome using the
 * correct Solana semantics: confirmation is decided by comparing current block
 * height against the transaction's `lastValidBlockHeight`, NOT by a timeout.
 * Once block height passes the deadline and the signature still has no status,
 * the transaction is expired (terminal) and must never be retried as-is.
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { NotImplementedError } from "../errors.js";

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

export class ConfirmationTracker {
  constructor(
    _rpc: Rpc<SolanaRpcApi>,
    _deps?: ConfirmationDeps,
  ) {}

  /** Polls until the tx is confirmed or its blockhash expires. */
  track(_config: TrackConfig): Promise<TrackResult> {
    throw new NotImplementedError("ConfirmationTracker.track");
  }
}
