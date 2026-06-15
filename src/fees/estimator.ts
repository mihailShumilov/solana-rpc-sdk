/**
 * FeeEstimator — turns a transaction into a (compute-unit limit, priority-fee
 * price) pair. CU limit comes from simulation (unitsConsumed) plus a safety
 * margin; the priority-fee price comes from a pluggable FeeOracle. Correct CU
 * sizing matters because the fee is charged on the *requested* limit.
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { NotImplementedError } from "../errors.js";
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
  constructor(
    _rpc: Rpc<SolanaRpcApi>,
    _oracle: FeeOracle,
  ) {}

  /** Simulates the tx and returns unitsConsumed (no margin applied). */
  simulateComputeUnits(_wireTransaction: string): Promise<number> {
    throw new NotImplementedError("FeeEstimator.simulateComputeUnits");
  }

  /** Full compute-budget recommendation (CU limit + price + resulting fee). */
  estimate(_config: EstimateConfig): Promise<ComputeBudget> {
    throw new NotImplementedError("FeeEstimator.estimate");
  }
}
