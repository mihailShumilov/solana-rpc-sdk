/**
 * JitoRouter — routes a transaction/bundle through the Jito Block Engine for MEV
 * protection, polls in-flight status, and FALLS BACK to normal RPC submission
 * if the bundle does not land before the deadline. A bundle_id is only a receipt,
 * not a landing guarantee, so fallback is mandatory for reliable confirmation.
 */
import type { TransactionSender, SendConfig, SendResult } from "../tx/sender.js";
import type { TipEstimator, TipPercentile } from "./tips.js";

export interface JitoEngineClient {
  getTipAccounts(): Promise<string[]>;
  sendBundle(wireTransactions: string[]): Promise<string>;
  getInflightBundleStatuses(ids: string[]): Promise<Array<{ bundle_id: string; status: string }>>;
}

export interface JitoRouteConfig extends SendConfig {
  /** Tip percentile to target (default "p50"). */
  tipPercentile?: TipPercentile;
  /** Max status polls before falling back to RPC (default 10). */
  maxBundlePolls?: number;
}

export interface JitoRouteResult extends SendResult {
  /** "jito" if the bundle landed, "rpc" if we fell back. */
  route: "jito" | "rpc";
  bundleId: string | null;
}

export interface JitoRouterDeps {
  sleep?: (ms: number) => Promise<void>;
}

export class JitoRouter {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly engine: JitoEngineClient,
    private readonly tipEstimator: TipEstimator,
    private readonly fallbackSender: TransactionSender,
    deps?: JitoRouterDeps,
  ) {
    this.sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Submit via Jito; fall back to RPC sender if the bundle doesn't land.
   *
   * Correctness invariants (see CLAUDE.md):
   *  - A `bundle_id` is a receipt, NOT a landing guarantee. We poll in-flight
   *    status a bounded number of times (`maxBundlePolls`) and, on anything
   *    other than a confirmed "Landed", hand the SAME already-signed wire
   *    transaction to the RPC `TransactionSender`. The fallback inherits the
   *    sender's invariants (maxRetries:0, no re-sign, LVBH-bounded loop), so
   *    there is no double-charge and the path is idempotent by signature.
   *  - On the Jito-landed path we do NOT poll the cluster for confirmation:
   *    a "Landed" bundle IS the confirmation. The transaction may never have
   *    been broadcast to the RPC, so a getSignatureStatuses poll would falsely
   *    expire it. We return outcome "confirmed" with slot null directly.
   */
  async sendWithFallback(config: JitoRouteConfig): Promise<JitoRouteResult> {
    const maxBundlePolls = config.maxBundlePolls ?? 10;
    const bundleId = await this.engine.sendBundle([config.wireTransaction]);

    for (let i = 0; i < maxBundlePolls; i++) {
      const statuses = await this.engine.getInflightBundleStatuses([bundleId]);
      const status = statuses[0]?.status;
      if (status === "Landed") {
        return {
          signature: config.signature,
          outcome: "confirmed",
          slot: null,
          rebroadcasts: 0,
          route: "jito",
          bundleId,
        };
      }
      // Unrecoverable on Jito -> stop polling and fall back to RPC.
      if (status === "Failed" || status === "Invalid") break;
      await this.sleep(config.rebroadcastIntervalMs ?? 1000);
    }

    // Bundle never landed -> RPC fallback (the mandatory invariant). The
    // sender owns the rebroadcast/confirm loop on the identical signed bytes.
    const r = await this.fallbackSender.sendAndConfirm(config);
    return { ...r, route: "rpc", bundleId };
  }
}
