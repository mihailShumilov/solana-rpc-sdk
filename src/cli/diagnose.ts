/**
 * Diagnostics — the injectable, deterministic core behind the `diagnose` CLI.
 *
 * It answers the two questions an operator asks when a Solana dApp misbehaves:
 *   1. probeEndpoints — which providers are healthy and which is freshest?
 *      (reuses HealthMonitor so the freshness ranking matches the pool's own
 *       routing logic — the "fresh blockhash from an advanced node sent to a
 *       lagging node drops the tx" failure mode is judged the same way here.)
 *   2. explainTransaction — point-in-time, did a transaction land, expire, or is
 *      it still in its validity window? The verdict is the canonical Solana rule
 *      (current block height vs lastValidBlockHeight), mirrored from
 *      ConfirmationTracker, with NO polling loop.
 *
 * The argv/console/real-RPC wiring of the binary is integration-only; nothing in
 * this module executes at import time.
 */
import type { Rpc, Signature, SolanaRpcApi } from "@solana/kit";
import { HealthMonitor } from "../rpc/health.js";

export interface ProbeTarget {
  name: string;
  rpc: Rpc<SolanaRpcApi>;
}

export interface EndpointProbe {
  name: string;
  ok: boolean;
  slot: bigint | null;
  latencyMs: number;
  error?: string;
}

export interface ProbeReport {
  endpoints: EndpointProbe[];
  /** Name of the freshest healthy endpoint, or null when none are healthy. */
  freshest: string | null;
  /** Endpoints that responded successfully in this probe round. */
  healthyCount: number;
}

export type TxDiagnosis =
  | { status: "confirmed"; slot: bigint }
  | { status: "expired"; reason: string }
  | { status: "pending"; reason: string };

export interface DiagnosticsDeps {
  /** Inject a shared HealthMonitor to fold probe results into existing state. */
  healthMonitor?: HealthMonitor;
}

export interface ExplainTxOptions {
  signature: string;
  lastValidBlockHeight: bigint;
  /** Target commitment (informational; landing is decided by status presence). */
  commitment?: "confirmed" | "finalized";
}

export class Diagnostics {
  constructor(private readonly deps?: DiagnosticsDeps) {}

  /**
   * Probes every target's current slot, recording latency and health into a
   * HealthMonitor so the freshness ranking is identical to the pool's. An
   * endpoint that throws (offline / errored) is flagged ok:false with slot null
   * and never ranked.
   */
  async probeEndpoints(targets: ProbeTarget[]): Promise<ProbeReport> {
    const hm =
      this.deps?.healthMonitor ??
      new HealthMonitor({ endpointNames: targets.map((t) => t.name) });

    const endpoints: EndpointProbe[] = await Promise.all(
      targets.map(async (target): Promise<EndpointProbe> => {
        const startedAt = Date.now();
        try {
          const slot = await target.rpc.getSlot().send();
          const latencyMs = Date.now() - startedAt;
          hm.recordSuccess(target.name, latencyMs, slot);
          return { name: target.name, ok: true, slot, latencyMs };
        } catch (err) {
          const latencyMs = Date.now() - startedAt;
          hm.recordFailure(target.name, err);
          return {
            name: target.name,
            ok: false,
            slot: null,
            latencyMs,
            error: String((err as Error)?.message ?? err),
          };
        }
      }),
    );

    const freshest = hm.rankByFreshness()[0] ?? null;
    const healthyCount = endpoints.filter((e) => e.ok).length;

    return { endpoints, freshest, healthyCount };
  }

  /**
   * Point-in-time verdict on a transaction. No polling: it inspects the current
   * signature status and current block height once.
   *
   * Order matters — a status check wins over the expiry bound, because a tx can
   * land exactly at the deadline block (same precedence as ConfirmationTracker).
   */
  async explainTransaction(
    rpc: Rpc<SolanaRpcApi>,
    opts: ExplainTxOptions,
  ): Promise<TxDiagnosis> {
    const signature = opts.signature as Signature;
    const status = (await rpc.getSignatureStatuses([signature]).send()).value[0];

    if (
      status != null &&
      status.confirmationStatus != null &&
      status.err == null
    ) {
      return { status: "confirmed", slot: status.slot };
    }

    const blockHeight = await rpc.getBlockHeight().send();
    if (blockHeight > opts.lastValidBlockHeight) {
      return {
        status: "expired",
        reason:
          `block height ${blockHeight} exceeded lastValidBlockHeight ${opts.lastValidBlockHeight}; ` +
          "the blockhash expired before the transaction landed (silent drop or congestion). " +
          "Rebuild with a fresh blockhash — do NOT re-sign the same one.",
      };
    }

    return {
      status: "pending",
      reason:
        `still within the validity window (height ${blockHeight} <= ${opts.lastValidBlockHeight}); ` +
        "keep rebroadcasting the same signed transaction until it lands or expires.",
    };
  }
}
