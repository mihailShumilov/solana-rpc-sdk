/**
 * SPEC (red until implemented): the Diagnostics core powers the `diagnose` CLI.
 * It (a) probes provider health across endpoints (reusing HealthMonitor for the
 * freshness ranking) and (b) explains, point-in-time, why a transaction did or
 * did not land — the two questions the bounty's diagnostic CLI must answer.
 *
 * The argv/console/real-RPC wiring of the binary is integration-only; this spec
 * pins the injectable, deterministic core.
 */
import { describe, it, expect } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { Diagnostics } from "../../src/cli/diagnose.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("Diagnostics.probeEndpoints", () => {
  it("ranks healthy providers by freshness and flags the offline one", async () => {
    const cluster = new MockCluster({ initialSlot: 4242n });
    const good = new MockEndpoint(cluster, { name: "good" });
    const bad = new MockEndpoint(cluster, { name: "bad", faults: { offline: true } });

    const diag = new Diagnostics();
    const report = await diag.probeEndpoints([
      { name: "good", rpc: createSolanaRpcFromTransport(good.transport) },
      { name: "bad", rpc: createSolanaRpcFromTransport(bad.transport) },
    ]);

    expect(report.healthyCount).toBe(1);
    expect(report.freshest).toBe("good");

    const goodProbe = report.endpoints.find((e) => e.name === "good");
    expect(goodProbe?.ok).toBe(true);
    expect(goodProbe?.slot).toBe(4242n);

    const badProbe = report.endpoints.find((e) => e.name === "bad");
    expect(badProbe?.ok).toBe(false);
    expect(badProbe?.slot).toBeNull();
  });
});

describe("Diagnostics.explainTransaction", () => {
  it("reports confirmed for a tx that has landed", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 500n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    cluster.rpcSendTransaction("SigDiag1"); // lands after 1 slot
    cluster.advanceSlots(1); // -> blockHeight 501, tx lands

    const diag = new Diagnostics();
    const res = await diag.explainTransaction(rpc, {
      signature: "SigDiag1",
      lastValidBlockHeight: 650n,
    });
    expect(res.status).toBe("confirmed");
  });

  it("explains an expired tx once block height passed lastValidBlockHeight", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 500n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    cluster.scheduleLanding("SigDiag2", -1); // silent drop, never lands
    cluster.rpcSendTransaction("SigDiag2");
    cluster.advanceSlots(10); // -> blockHeight 510 > deadline 505

    const diag = new Diagnostics();
    const res = await diag.explainTransaction(rpc, {
      signature: "SigDiag2",
      lastValidBlockHeight: 505n,
    });
    expect(res.status).toBe("expired");
  });
});
