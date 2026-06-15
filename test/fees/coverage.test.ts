/**
 * Coverage-completing cases for the fees layer: default estimate config, the
 * empty-fee guard in NativeFeeOracle, and the not-yet-implemented HeliusFeeOracle.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { FeeEstimator } from "../../src/fees/estimator.js";
import { NativeFeeOracle, HeliusFeeOracle } from "../../src/fees/oracles.js";
import { NotImplementedError } from "../../src/errors.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function setup() {
  const cluster = new MockCluster();
  const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
  return { cluster, rpc };
}

describe("FeeEstimator (default config)", () => {
  it("defaults cuMargin to 1.1 and level to medium when omitted", async () => {
    const { cluster, rpc } = setup();
    cluster.setPrioritizationFees([50_000n]);
    const est = new FeeEstimator(rpc, new NativeFeeOracle(rpc));
    const budget = await est.estimate({ wireTransaction: "anyWire", writableAccounts: [] });
    expect(budget.computeUnitLimit).toBe(6600); // 6000 * default 1.1
    expect(budget.computeUnitPrice).toBe(50_000); // default level "medium"
  });
});

describe("NativeFeeOracle (empty fees)", () => {
  it("returns all-zero levels when no recent prioritization fees exist", async () => {
    const { cluster, rpc } = setup();
    cluster.setPrioritizationFees([]);
    const oracle = new NativeFeeOracle(rpc);
    const est = await oracle.getPriorityFee([]);
    expect(est.levels).toEqual({ min: 0, low: 0, medium: 0, high: 0, veryHigh: 0 });
  });
});

describe("HeliusFeeOracle", () => {
  it("is not implemented yet and throws", () => {
    const oracle = new HeliusFeeOracle({ url: "https://example.invalid" });
    expect(() => oracle.getPriorityFee([])).toThrow(NotImplementedError);
  });
});
