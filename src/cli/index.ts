#!/usr/bin/env node
/**
 * solana-resilience-diagnose — the executable CLI over the {@link Diagnostics} core.
 *
 * Two commands map 1:1 to the two questions an operator asks when a Solana dApp
 * misbehaves:
 *
 *   probe   --rpc <url> [--rpc <url> ...]            → which providers are healthy, and which is freshest?
 *   explain --rpc <url> --sig <signature> --lvbh <n> → did this tx land, expire, or is it still pending?
 *
 * Layering: {@link parseArgs} is a PURE, network-free function (turns argv into a
 * typed command or throws {@link CliUsageError}); {@link formatProbeReport} /
 * {@link formatDiagnosis} are pure renderers; {@link run} wires kit RPC + stdout
 * through injectable deps so it stays deterministic under the harness. Only the
 * process bootstrap at the very bottom touches process.argv / real RPC, and is
 * integration-only — nothing else executes at import time.
 *
 * Exit codes: 0 success · 1 a substantive failure (no healthy endpoint / expired
 * tx) · 2 a usage error.
 */
import { createSolanaRpc } from "@solana/kit";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { pathToFileURL } from "node:url";
import { SdkError } from "../errors.js";
import { Diagnostics } from "./diagnose.js";
import type { ProbeReport, TxDiagnosis } from "./diagnose.js";

/** A malformed invocation (unknown command, missing/invalid flag). Message carries usage text. */
export class CliUsageError extends SdkError {}

export interface ProbeCommand {
  command: "probe";
  rpcUrls: string[];
}

export interface ExplainCommand {
  command: "explain";
  rpcUrl: string;
  signature: string;
  lastValidBlockHeight: bigint;
}

export type ParsedCommand = ProbeCommand | ExplainCommand;

export const USAGE = `solana-resilience-diagnose — probe RPC health and explain transaction outcomes

Usage:
  solana-resilience-diagnose probe   --rpc <url> [--rpc <url> ...]
  solana-resilience-diagnose explain --rpc <url> --sig <signature> --lvbh <lastValidBlockHeight>

Commands:
  probe     Probe each endpoint's slot / latency / health and report the freshest.
  explain   Point-in-time verdict (confirmed | expired | pending) for one signature.

Flags:
  --rpc <url>     RPC endpoint URL. Repeat for probe; exactly one for explain.
  --sig <sig>     Transaction signature to explain.
  --lvbh <n>      lastValidBlockHeight the transaction was built against.

Examples:
  solana-resilience-diagnose probe --rpc https://api.mainnet-beta.solana.com --rpc https://my-backup.rpc
  solana-resilience-diagnose explain --rpc https://api.mainnet-beta.solana.com --sig 5xRe... --lvbh 287654321`;

/**
 * Pure argv parser. Accepts argv WITHOUT the `node script` prefix (i.e.
 * `process.argv.slice(2)`). Supports `--flag value` and `--flag=value`. Throws
 * {@link CliUsageError} (with help text) on anything malformed. No I/O.
 */
export function parseArgs(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    throw usage();
  }
  switch (command) {
    case "probe":
      return parseProbe(rest);
    case "explain":
      return parseExplain(rest);
    default:
      throw usage(`unknown command "${command}".`);
  }
}

function parseProbe(args: string[]): ProbeCommand {
  const flags = collectFlags(args);
  const rpcUrls = flags.get("rpc") ?? [];
  if (rpcUrls.length === 0) {
    throw usage('"probe" requires at least one --rpc <url>.');
  }
  return { command: "probe", rpcUrls };
}

function parseExplain(args: string[]): ExplainCommand {
  const flags = collectFlags(args);
  const rpcUrl = single(flags, "rpc");
  const signature = single(flags, "sig");
  const lvbhRaw = single(flags, "lvbh");

  let lastValidBlockHeight: bigint;
  try {
    lastValidBlockHeight = BigInt(lvbhRaw);
  } catch {
    throw usage(`--lvbh must be an integer, got "${lvbhRaw}".`);
  }
  if (lastValidBlockHeight < 0n) {
    throw usage(`--lvbh must be non-negative, got "${lvbhRaw}".`);
  }

  return { command: "explain", rpcUrl, signature, lastValidBlockHeight };
}

/** Parse repeated `--flag value` / `--flag=value` tokens into a multimap. */
function collectFlags(args: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  const queue = [...args];
  while (queue.length > 0) {
    const tok = queue.shift() as string;
    if (!tok.startsWith("--")) {
      throw usage(`unexpected argument "${tok}".`);
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = queue[0];
      if (next !== undefined && !next.startsWith("--")) {
        value = queue.shift();
      }
    }
    if (value === undefined || value === "") {
      throw usage(`flag --${key} requires a value.`);
    }
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  }
  return flags;
}

/** Read a flag expected exactly once. */
function single(flags: Map<string, string[]>, key: string): string {
  const values = flags.get(key);
  if (values === undefined || values.length === 0) {
    throw usage(`"explain" requires --${key} <value>.`);
  }
  if (values.length > 1) {
    throw usage(`--${key} may be given only once.`);
  }
  return values[0] as string;
}

function usage(detail?: string): CliUsageError {
  return new CliUsageError(detail ? `${detail}\n\n${USAGE}` : USAGE);
}

/** Render a {@link ProbeReport} as an aligned text table plus a summary line. */
export function formatProbeReport(report: ProbeReport): string {
  const header = ["ENDPOINT", "HEALTH", "SLOT", "LATENCY", "FRESHEST"];
  const rows = report.endpoints.map((e) => [
    e.name,
    e.ok ? "ok" : "down",
    e.slot === null ? "-" : e.slot.toString(),
    `${e.latencyMs}ms`,
    e.ok && e.name === report.freshest ? "*" : "",
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ").trimEnd();

  const lines = [fmt(header), ...rows.map(fmt), ""];
  lines.push(
    report.healthyCount === 0
      ? `No healthy endpoints (0/${report.endpoints.length} up).`
      : `Freshest: ${report.freshest}  ·  ${report.healthyCount}/${report.endpoints.length} healthy.`,
  );
  for (const e of report.endpoints) {
    if (!e.ok && e.error) lines.push(`  ${e.name}: ${e.error}`);
  }
  return lines.join("\n");
}

/** Render an {@link TxDiagnosis} as a human verdict. */
export function formatDiagnosis(signature: string, diag: TxDiagnosis): string {
  const head = `Signature: ${signature}`;
  switch (diag.status) {
    case "confirmed":
      return `${head}\nVerdict: CONFIRMED  (landed in slot ${diag.slot})`;
    case "expired":
      return `${head}\nVerdict: EXPIRED\n${diag.reason}`;
    case "pending":
      return `${head}\nVerdict: PENDING\n${diag.reason}`;
  }
}

export interface CliDeps {
  /** Build a kit RPC from a URL. Defaults to `createSolanaRpc`. */
  createRpc?: (url: string) => Rpc<SolanaRpcApi>;
  /** Sink for output lines. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Override the diagnostics core (tests inject a shared HealthMonitor here). */
  diagnostics?: Diagnostics;
}

/* v8 ignore start -- real-RPC + stdout wiring; exercised by the installed binary, not unit-tested */
const defaultCreateRpc = (url: string): Rpc<SolanaRpcApi> => createSolanaRpc(url);
const defaultLog = (line: string): void => {
  console.log(line);
};
/* v8 ignore stop */

/**
 * Execute one parsed command. Returns the process exit code. All side effects
 * (RPC, stdout) go through {@link CliDeps}, so tests run it network-free.
 */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? defaultLog;
  /* v8 ignore next -- default RPC factory is real-network, covered via the binary */
  const createRpc = deps.createRpc ?? defaultCreateRpc;

  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      log(err.message);
      return 2;
    }
    throw err;
  }

  const diag = deps.diagnostics ?? new Diagnostics();

  if (parsed.command === "probe") {
    const targets = parsed.rpcUrls.map((url) => ({ name: url, rpc: createRpc(url) }));
    const report = await diag.probeEndpoints(targets);
    log(formatProbeReport(report));
    return report.healthyCount > 0 ? 0 : 1;
  }

  const result = await diag.explainTransaction(createRpc(parsed.rpcUrl), {
    signature: parsed.signature,
    lastValidBlockHeight: parsed.lastValidBlockHeight,
  });
  log(formatDiagnosis(parsed.signature, result));
  return result.status === "expired" ? 1 : 0;
}

/* v8 ignore start -- process bootstrap; only runs when invoked as the binary */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
/* v8 ignore stop */
