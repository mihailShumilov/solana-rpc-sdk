/**
 * SPEC: the argv parser behind the `solana-resilience-diagnose` binary.
 *
 * parseArgs is a PURE, network-free function — it turns process argv (minus the
 * `node script` prefix) into a typed command, or throws CliUsageError with help
 * text. No RPC, no console, no clock: this spec pins exactly that contract so the
 * binary's wiring stays a thin shell over it.
 */
import { describe, it, expect } from "vitest";
import { parseArgs, CliUsageError } from "../../src/cli/index.js";

describe("parseArgs — probe", () => {
  it("collects a single --rpc into a one-element list", () => {
    const cmd = parseArgs(["probe", "--rpc", "https://a.rpc"]);
    expect(cmd).toEqual({ command: "probe", rpcUrls: ["https://a.rpc"] });
  });

  it("collects repeated --rpc flags in order", () => {
    const cmd = parseArgs([
      "probe",
      "--rpc",
      "https://a.rpc",
      "--rpc",
      "https://b.rpc",
      "--rpc",
      "https://c.rpc",
    ]);
    expect(cmd).toEqual({
      command: "probe",
      rpcUrls: ["https://a.rpc", "https://b.rpc", "https://c.rpc"],
    });
  });

  it("accepts the --rpc=value form", () => {
    const cmd = parseArgs(["probe", "--rpc=https://a.rpc"]);
    expect(cmd).toEqual({ command: "probe", rpcUrls: ["https://a.rpc"] });
  });

  it("rejects probe with no --rpc", () => {
    expect(() => parseArgs(["probe"])).toThrow(CliUsageError);
  });
});

describe("parseArgs — explain", () => {
  it("parses rpc, sig and a bigint lvbh", () => {
    const cmd = parseArgs([
      "explain",
      "--rpc",
      "https://a.rpc",
      "--sig",
      "5xSig",
      "--lvbh",
      "287654321",
    ]);
    expect(cmd).toEqual({
      command: "explain",
      rpcUrl: "https://a.rpc",
      signature: "5xSig",
      lastValidBlockHeight: 287654321n,
    });
  });

  it("accepts --key=value forms and flag order independence", () => {
    const cmd = parseArgs([
      "explain",
      "--lvbh=100",
      "--sig=Sig",
      "--rpc=https://a.rpc",
    ]);
    expect(cmd).toEqual({
      command: "explain",
      rpcUrl: "https://a.rpc",
      signature: "Sig",
      lastValidBlockHeight: 100n,
    });
  });

  it("requires --rpc", () => {
    expect(() => parseArgs(["explain", "--sig", "S", "--lvbh", "1"])).toThrow(
      CliUsageError,
    );
  });

  it("requires --sig", () => {
    expect(() =>
      parseArgs(["explain", "--rpc", "https://a.rpc", "--lvbh", "1"]),
    ).toThrow(CliUsageError);
  });

  it("requires --lvbh", () => {
    expect(() =>
      parseArgs(["explain", "--rpc", "https://a.rpc", "--sig", "S"]),
    ).toThrow(CliUsageError);
  });

  it("rejects a non-integer --lvbh", () => {
    expect(() =>
      parseArgs(["explain", "--rpc", "https://a.rpc", "--sig", "S", "--lvbh", "not-a-number"]),
    ).toThrow(CliUsageError);
  });

  it("rejects a negative --lvbh", () => {
    expect(() =>
      parseArgs(["explain", "--rpc", "https://a.rpc", "--sig", "S", "--lvbh", "-5"]),
    ).toThrow(CliUsageError);
  });

  it("rejects a flag given more than once where a single value is expected", () => {
    expect(() =>
      parseArgs([
        "explain",
        "--rpc",
        "https://a.rpc",
        "--rpc",
        "https://b.rpc",
        "--sig",
        "S",
        "--lvbh",
        "1",
      ]),
    ).toThrow(CliUsageError);
  });
});

describe("parseArgs — framing", () => {
  it("throws usage for an unknown command", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(CliUsageError);
  });

  it("throws usage when no command is given", () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
  });

  it.each(["--help", "-h", "help"])("throws usage for %s", (token) => {
    try {
      parseArgs([token]);
      throw new Error("expected parseArgs to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliUsageError);
      expect((err as CliUsageError).message).toContain("Usage:");
    }
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["probe", "--rpc"])).toThrow(CliUsageError);
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseArgs(["probe", "oops", "--rpc", "https://a.rpc"])).toThrow(
      CliUsageError,
    );
  });
});
