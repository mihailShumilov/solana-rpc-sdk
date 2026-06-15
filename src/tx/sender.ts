/**
 * TransactionSender — the resilient send/confirm state machine. Implements the
 * landing best-practices the docs prescribe and most submissions get wrong:
 *   - send with maxRetries: 0 (disable the RPC's generic retry),
 *   - run our own rebroadcast loop at a fixed interval,
 *   - bound the loop by lastValidBlockHeight (stop, don't spin forever),
 *   - NEVER re-sign / mutate the transaction (no double-charge risk),
 *   - decide the outcome via ConfirmationTracker.
 *
 * Input is an already-signed wire transaction plus its signature and
 * lastValidBlockHeight, so signing (and wallet integration) stays decoupled.
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { NotImplementedError } from "../errors.js";
import type { Metrics } from "../observability/metrics.js";
import type { TerminalOutcome } from "./confirmation.js";

export interface SendConfig {
  /** Base64 wire transaction (from getBase64EncodedWireTransaction). */
  wireTransaction: string;
  /** Its signature (from getSignatureFromTransaction). */
  signature: string;
  lastValidBlockHeight: bigint;
  /** Interval between rebroadcasts in ms (default 1000). */
  rebroadcastIntervalMs?: number;
  /** Commitment for confirmation (default "confirmed"). */
  commitment?: "confirmed" | "finalized";
}

export interface SendResult {
  signature: string;
  outcome: TerminalOutcome;
  slot: bigint | null;
  rebroadcasts: number;
}

export interface SenderDeps {
  /** Injected sleep so tests advance the mock clock per loop iteration. */
  sleep?: (ms: number) => Promise<void>;
  metrics?: Metrics;
}

export class TransactionSender {
  constructor(
    _rpc: Rpc<SolanaRpcApi>,
    _deps?: SenderDeps,
  ) {}

  /** Sends and rebroadcasts until confirmed or blockhash expiry. */
  sendAndConfirm(_config: SendConfig): Promise<SendResult> {
    throw new NotImplementedError("TransactionSender.sendAndConfirm");
  }
}
