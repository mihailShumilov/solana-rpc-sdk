/**
 * FeeEstimator — turns a transaction into a (compute-unit limit, priority-fee
 * price) pair. CU limit comes from simulation (unitsConsumed) plus a safety
 * margin; the priority-fee price comes from a pluggable FeeOracle. Correct CU
 * sizing matters because the fee is charged on the *requested* limit.
 */
import type { Base64EncodedWireTransaction, Rpc, SolanaRpcApi } from "@solana/kit";
import type { FeeOracle, FeeLevel } from "./oracles.js";

export interface ComputeBudget {
  /** Recommended setComputeUnitLimit value. */
  computeUnitLimit: number;
  /** Recommended setComputeUnitPrice value (micro-lamports per CU). */
  computeUnitPrice: number;
  /** Resulting priority fee in lamports = ceil(limit * price / 1e6). */
  priorityFeeLamports: number;
}

export interface EstimateConfig {
  /** Base64 wire transaction to simulate for unitsConsumed. */
  wireTransaction: string;
  writableAccounts: string[];
  level?: FeeLevel;
  /** Multiplier applied to simulated CU (default 1.1 = +10% margin). */
  cuMargin?: number;
}

export class FeeEstimator {
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly oracle: FeeOracle;

  constructor(rpc: Rpc<SolanaRpcApi>, oracle: FeeOracle) {
    this.rpc = rpc;
    this.oracle = oracle;
  }

  /**
   * Simulates the tx and returns unitsConsumed (no margin applied).
   *
   * We use `replaceRecentBlockhash: true` so the simulation does not fail on a
   * stale/expired blockhash, and we never verify signatures — the only thing we
   * care about here is the compute-unit count the program would burn.
   */
  async simulateComputeUnits(wireTransaction: string): Promise<number> {
    const { value } = await this.rpc
      .simulateTransaction(wireTransaction as Base64EncodedWireTransaction, {
        encoding: "base64",
        replaceRecentBlockhash: true,
      })
      .send();

    return Number(value.unitsConsumed ?? 0);
  }

  /**
   * Full compute-budget recommendation (CU limit + price + resulting fee).
   *
   * The CU limit is the simulated consumption scaled by a safety margin
   * (`Math.round`, not `ceil` — `6000 * 1.1` is `6600.000000000001` in IEEE-754,
   * and rounding lands on the intended 6600). The price comes from the oracle at
   * the requested level. The resulting fee is `ceil(limit * price / 1e6)` because
   * the network charges priority fee on the *requested* limit in micro-lamports.
   */
  async estimate(config: EstimateConfig): Promise<ComputeBudget> {
    const units = await this.simulateComputeUnits(config.wireTransaction);
    const cuMargin = config.cuMargin ?? 1.1;
    const computeUnitLimit = Math.round(units * cuMargin);

    const level = config.level ?? "medium";
    const est = await this.oracle.getPriorityFee(config.writableAccounts);
    const computeUnitPrice = est.levels[level];

    const priorityFeeLamports = Math.ceil(
      (computeUnitLimit * computeUnitPrice) / 1_000_000,
    );

    return { computeUnitLimit, computeUnitPrice, priorityFeeLamports };
  }
}
