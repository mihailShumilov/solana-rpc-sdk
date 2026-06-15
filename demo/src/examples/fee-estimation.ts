/**
 * Fee / CU estimation — the priority fee is charged on the CU limit you REQUEST,
 * so sizing matters. The FeeEstimator simulates the tx for its actual
 * compute-unit usage, adds a safety margin (default +10%), and pairs it with a
 * percentile priority-fee price from a pluggable oracle (here the free,
 * native `getRecentPrioritizationFees` source).
 */
import { FeeEstimator, NativeFeeOracle } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  const cluster = new MockCluster();
  const endpoint = new MockEndpoint(cluster, { name: "rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);

  const estimator = new FeeEstimator(rpc, new NativeFeeOracle(rpc));

  // The accounts the tx will write to (drives the priority-fee percentile).
  const writableAccounts = ["SysvarC1ock11111111111111111111111111111111"];

  log("simulateTransaction → unitsConsumed (no margin)…");
  const simulatedCU = await estimator.simulateComputeUnits("BASE64_WIRE_TX_PLACEHOLDER");

  log("estimate → CU limit (+10%) + p50 priority fee…");
  const budget = await estimator.estimate({
    wireTransaction: "BASE64_WIRE_TX_PLACEHOLDER",
    writableAccounts,
    level: "medium", // p50 of recent prioritization fees
  });
  log(`setComputeUnitLimit(${budget.computeUnitLimit}), setComputeUnitPrice(${budget.computeUnitPrice})`);
  log(`priority fee ≈ ${budget.priorityFeeLamports} lamports`);

  return {
    logs,
    result: {
      "simulated CU": simulatedCU,
      "CU limit (+10%)": budget.computeUnitLimit,
      "price (µLamports/CU)": budget.computeUnitPrice,
      "priority fee (lamports)": budget.priorityFeeLamports,
    },
  };
}
