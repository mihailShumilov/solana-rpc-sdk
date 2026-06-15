/**
 * solana-resilience-kit — vendor-neutral, client-side resilience + observability
 * layer for Solana dApps, built on @solana/kit (web3.js v2).
 *
 * Public API surface. Implementations are filled in during the build phase;
 * the test suite under /test encodes the required behavior of every export.
 */

// Errors
export * from "./errors.js";

// RPC layer
export { ResilientRpcPool } from "./rpc/pool.js";
export type { ResilientEndpoint, ResilientRpcConfig } from "./rpc/pool.js";
export { HealthMonitor } from "./rpc/health.js";
export type { EndpointHealth, HealthMonitorConfig } from "./rpc/health.js";
export { CreditRateLimiter, DEFAULT_METHOD_WEIGHTS } from "./rpc/rate-limit.js";
export type { RateLimiterConfig } from "./rpc/rate-limit.js";

// Transactions
export { TransactionSender } from "./tx/sender.js";
export type { SendConfig, SendResult, SenderDeps } from "./tx/sender.js";
export { ConfirmationTracker } from "./tx/confirmation.js";
export type { TrackConfig, TrackResult, TerminalOutcome } from "./tx/confirmation.js";

// Fees
export { FeeEstimator } from "./fees/estimator.js";
export type { ComputeBudget, EstimateConfig } from "./fees/estimator.js";
export { NativeFeeOracle, HeliusFeeOracle } from "./fees/oracles.js";
export type { FeeOracle, FeeLevel, PriorityFeeEstimate, HttpFeeOracleConfig } from "./fees/oracles.js";

// Jito / MEV
export { JitoRouter } from "./jito/router.js";
export type { JitoEngineClient, JitoRouteConfig, JitoRouteResult } from "./jito/router.js";
export { TipEstimator, MIN_TIP_LAMPORTS } from "./jito/tips.js";
export type { TipFloor, TipPercentile, TipEstimatorConfig } from "./jito/tips.js";

// Observability
export { InMemoryMetrics, OtelMetrics } from "./observability/metrics.js";
export type { Metrics, OtelMetricsConfig } from "./observability/metrics.js";

// Wallet
export { ResilientWalletAdapter } from "./wallet/adapter.js";
export type { WalletSigner, ResilientWalletConfig } from "./wallet/adapter.js";

// Diagnostics
export { Diagnostics } from "./cli/diagnose.js";
export type {
  ProbeTarget,
  EndpointProbe,
  ProbeReport,
  TxDiagnosis,
  DiagnosticsDeps,
} from "./cli/diagnose.js";
