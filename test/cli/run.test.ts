/**
 * SPEC: the run()/formatter shell of the diagnose binary, driven through the
 * deterministic harness instead of the network. createRpc and log are injected,
 * so this exercises the real command dispatch, table/verdict rendering and exit
 * codes with zero sockets and zero wall-clock.
 */
import { describe, it, expect, vi } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { run, formatProbeReport, formatDiagnosis } from "../../src/cli/index.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

function rpcMap(entries: Record<string, Rpc<SolanaRpcApi>>) {
  return (url: string): Rpc<SolanaRpcApi> => {
    const rpc = entries[url];
    if (!rpc) throw new Error(`no mock rpc for ${url}`);
    return rpc;
  };
}

describe("run — probe", () => {
  it("renders a table, marks the freshest endpoint, and exits 0 when one is healthy", async () => {
    const cluster = new MockCluster({ initialSlot: 1000n });
    const good = new MockEndpoint(cluster, { name: "good" });
    const bad = new MockEndpoint(cluster, { name: "bad", faults: { offline: true } });
    const out: string[] = [];

    const code = await run(["probe", "--rpc", "https://good", "--rpc", "https://bad"], {
      createRpc: rpcMap({
        "https://good": createSolanaRpcFromTransport(good.transport),
        "https://bad": createSolanaRpcFromTransport(bad.transport),
      }),
      log: (l) => out.push(l),
    });

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("https://good");
    expect(text).toContain("1000");
    expect(text).toContain("down");
    expect(text).toContain("Freshest: https://good");
  });

  it("exits 1 when no endpoint is healthy", async () => {
    const cluster = new MockCluster();
    const a = new MockEndpoint(cluster, { name: "a", faults: { offline: true } });
    const out: string[] = [];

    const code = await run(["probe", "--rpc", "https://a"], {
      createRpc: rpcMap({ "https://a": createSolanaRpcFromTransport(a.transport) }),
      log: (l) => out.push(l),
    });

    expect(code).toBe(1);
    expect(out.join("\n")).toContain("No healthy endpoints");
  });
});

describe("run — explain", () => {
  function explainRun(args: string[], rpc: Rpc<SolanaRpcApi>, out: string[]) {
    return run(args, { createRpc: () => rpc, log: (l) => out.push(l) });
  }

  it("prints CONFIRMED and exits 0 for a landed tx", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 500n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    cluster.rpcSendTransaction("SigOk");
    cluster.advanceSlots(1);
    const out: string[] = [];

    const code = await explainRun(
      ["explain", "--rpc", "https://x", "--sig", "SigOk", "--lvbh", "650"],
      rpc,
      out,
    );

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("CONFIRMED");
  });

  it("prints EXPIRED and exits 1 once past lastValidBlockHeight", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 500n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    cluster.scheduleLanding("SigGone", -1);
    cluster.rpcSendTransaction("SigGone");
    cluster.advanceSlots(10);
    const out: string[] = [];

    const code = await explainRun(
      ["explain", "--rpc", "https://x", "--sig", "SigGone", "--lvbh", "505"],
      rpc,
      out,
    );

    expect(code).toBe(1);
    expect(out.join("\n")).toContain("EXPIRED");
  });

  it("prints PENDING and exits 0 while still in the validity window", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 500n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    cluster.scheduleLanding("SigWait", -1);
    cluster.rpcSendTransaction("SigWait");
    const out: string[] = [];

    const code = await explainRun(
      ["explain", "--rpc", "https://x", "--sig", "SigWait", "--lvbh", "650"],
      rpc,
      out,
    );

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("PENDING");
  });
});

describe("run — usage", () => {
  it("logs usage and exits 2 on a bad invocation (with injected log)", async () => {
    const out: string[] = [];
    const code = await run(["nonsense"], { log: (l) => out.push(l) });
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("Usage:");
  });

  it("falls back to console.log when no log is injected", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await run([]);
      expect(code).toBe(2);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("formatters are pure", () => {
  it("formatProbeReport lays out columns and a freshest marker", () => {
    const text = formatProbeReport({
      endpoints: [
        { name: "alpha", ok: true, slot: 42n, latencyMs: 12 },
        { name: "beta", ok: false, slot: null, latencyMs: 9, error: "offline" },
      ],
      freshest: "alpha",
      healthyCount: 1,
    });
    expect(text).toContain("ENDPOINT");
    expect(text).toContain("alpha");
    expect(text).toContain("42");
    expect(text).toContain("beta");
    expect(text).toContain("offline");
  });

  it("formatDiagnosis renders each verdict", () => {
    expect(formatDiagnosis("S", { status: "confirmed", slot: 7n })).toContain("CONFIRMED");
    expect(formatDiagnosis("S", { status: "expired", reason: "gone" })).toContain("EXPIRED");
    expect(formatDiagnosis("S", { status: "pending", reason: "wait" })).toContain("PENDING");
  });
});
