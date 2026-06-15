/**
 * Coverage-completing case for Diagnostics.explainTransaction: a tx that is
 * neither landed nor past its deadline is still "pending".
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { Diagnostics } from "../../src/cli/diagnose.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("Diagnostics.explainTransaction (pending)", () => {
  it("reports pending while still within the validity window", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 500n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    cluster.scheduleLanding("SigPending", -1); // never lands
    cluster.rpcSendTransaction("SigPending");
    // do NOT advance: blockHeight 500 stays <= lastValidBlockHeight 650

    const res = await new Diagnostics().explainTransaction(rpc, {
      signature: "SigPending",
      lastValidBlockHeight: 650n,
    });
    expect(res.status).toBe("pending");
  });
});
