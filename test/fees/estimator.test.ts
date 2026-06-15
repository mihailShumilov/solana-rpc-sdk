/**
 * SPEC (red until implemented): FeeEstimator sizes CU from simulation + margin
 * and prices priority fee from a pluggable oracle. NativeFeeOracle derives
 * percentiles from getRecentPrioritizationFees.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { FeeEstimator } from "../../src/fees/estimator.js";
import { NativeFeeOracle } from "../../src/fees/oracles.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster();
  const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
  return { cluster, rpc };
}

describe("NativeFeeOracle", () => {
  it("derives the medium level from the median recent prioritization fee", async () => {
    const { cluster, rpc } = setup();
    cluster.setPrioritizationFees([10_000n, 20_000n, 30_000n, 40_000n, 50_000n]);
    const oracle = new NativeFeeOracle(rpc);
    const est = await oracle.getPriorityFee([]);
    expect(est.levels.medium).toBe(30_000); // median
    expect(est.levels.high).toBeGreaterThan(est.levels.medium);
  });
});

describe("FeeEstimator", () => {
  it("reads unitsConsumed from simulation", async () => {
    const { rpc } = setup();
    const est = new FeeEstimator(rpc, new NativeFeeOracle(rpc));
    expect(await est.simulateComputeUnits("anyWire")).toBe(6000);
  });

  it("applies a CU margin and computes the resulting priority fee", async () => {
    const { cluster, rpc } = setup();
    cluster.setPrioritizationFees([50_000n]);
    const est = new FeeEstimator(rpc, new NativeFeeOracle(rpc));
    const budget = await est.estimate({
      wireTransaction: "anyWire",
      writableAccounts: [],
      level: "medium",
      cuMargin: 1.1,
    });
    expect(budget.computeUnitLimit).toBe(6600); // 6000 * 1.1
    expect(budget.computeUnitPrice).toBe(50_000);
    // fee = ceil(6600 * 50000 / 1e6) = ceil(330) = 330 lamports
    expect(budget.priorityFeeLamports).toBe(330);
  });
});
