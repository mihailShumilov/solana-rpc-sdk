/**
 * Fee oracles — pluggable sources of priority-fee estimates. The native oracle
 * uses `getRecentPrioritizationFees` (free, backward-looking minimum); the
 * Helius/QuickNode oracles call account-aware percentile APIs. Vendor neutrality
 * means the SDK works with any of them behind one interface.
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { NotImplementedError } from "../errors.js";

export type FeeLevel = "min" | "low" | "medium" | "high" | "veryHigh";

export interface PriorityFeeEstimate {
  /** micro-lamports per compute unit, keyed by level. */
  levels: Record<FeeLevel, number>;
}

export interface FeeOracle {
  /** Estimate priority fee given the writable accounts the tx will touch. */
  getPriorityFee(writableAccounts: string[]): Promise<PriorityFeeEstimate>;
}

/** Native estimate from getRecentPrioritizationFees over recent slots. */
export class NativeFeeOracle implements FeeOracle {
  constructor(_rpc: Rpc<SolanaRpcApi>) {}
  getPriorityFee(_writableAccounts: string[]): Promise<PriorityFeeEstimate> {
    throw new NotImplementedError("NativeFeeOracle.getPriorityFee");
  }
}

export interface HttpFeeOracleConfig {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Helius getPriorityFeeEstimate (account-aware percentiles). */
export class HeliusFeeOracle implements FeeOracle {
  constructor(_config: HttpFeeOracleConfig) {}
  getPriorityFee(_writableAccounts: string[]): Promise<PriorityFeeEstimate> {
    throw new NotImplementedError("HeliusFeeOracle.getPriorityFee");
  }
}
