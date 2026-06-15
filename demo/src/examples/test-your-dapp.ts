/**
 * Test your dApp — the simulation harness ships in the published package under
 * `solana-resilience-kit/testing`. Build a deterministic cluster you fully
 * control (no network, no flakiness, manual clock) and script both the happy
 * path and the failure paths your code must survive. This is exactly how the
 * kit's own test suite is written — drop it straight into Vitest/Jest.
 */
import { TransactionSender } from "solana-resilience-kit";
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const checks: boolean[] = [];
  const assert = (name: string, cond: boolean) => {
    logs.push(`${cond ? "✓" : "✗"} ${name}`);
    checks.push(cond);
  };

  // A cluster + endpoint you own. `advanceSlots` is the only clock — fully
  // deterministic, so these assertions never flake.
  const cluster = new MockCluster({ initialBlockHeight: 1000n });
  const endpoint = new MockEndpoint(cluster, { name: "test-rpc" });
  const rpc = createSolanaRpcFromTransport(endpoint.transport);
  const sleep = async () => cluster.advanceSlots(1);
  const sender = new TransactionSender(rpc, { sleep });

  // 1) Happy path — a tx that lands confirms.
  const ok = await sender.sendAndConfirm({
    wireTransaction: "HappyPathTx",
    signature: "HappyPathTx",
    lastValidBlockHeight: 1100n,
  });
  assert("a landing tx confirms", ok.outcome === "confirmed");

  // 2) Failure path — script a silent drop and assert your code reports expired.
  cluster.scheduleLanding("DroppedTx", -1);
  const dropped = await sender.sendAndConfirm({
    wireTransaction: "DroppedTx",
    signature: "DroppedTx",
    lastValidBlockHeight: 1010n,
  });
  assert("a dropped tx expires (bounded, no hang)", dropped.outcome === "expired");
  assert("the dropped tx was never re-signed", dropped.signature === "DroppedTx");

  const passed = checks.filter(Boolean).length;
  return {
    logs,
    result: {
      passed: `${passed}/${checks.length}`,
      "all green": passed === checks.length,
      "happy path": ok.outcome,
      "drop path": dropped.outcome,
    },
  };
}
