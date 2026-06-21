/**
 * Error translation — raw Solana errors are opaque (RPC strings, program
 * `Custom` codes as hex, wallet rejections, HTTP 429s). `ErrorTranslator` maps
 * them to a stable `code`, a `category`, a human `userMessage`, and a concrete
 * `suggestion`, while preserving the original error. It is pure and total: it
 * never throws and never does I/O, and is idempotent (translating twice is a
 * no-op). The SAME dictionary backs the diagnostics CLI.
 */
import { ErrorTranslator } from "solana-resilience-kit";
import type { ExampleResult } from "./types.js";

export async function run(): Promise<ExampleResult> {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  // A grab-bag of the raw shapes upstream actually throws.
  const rawErrors: Array<{ label: string; error: unknown }> = [
    { label: "wallet popup", error: new Error("User rejected the request.") },
    { label: "swap revert", error: { InstructionError: [0, { Custom: 6001 }] } }, // 0x1771 → slippage
    { label: "low balance", error: { InstructionError: [0, { Custom: 1 }] } }, // 0x1 → insufficient funds
    { label: "stale tx", error: new Error("block height exceeded") },
    { label: "throttled", error: { statusCode: 429, message: "Too Many Requests" } },
    { label: "mystery", error: new Error("kaboom") },
  ];

  const rows: Record<string, string | number | boolean> = {};
  for (const { label, error } of rawErrors) {
    const t = ErrorTranslator.translate(error);
    log(`${label}: ${t.code} — ${t.userMessage}`);
    rows[label] = t.code;
  }

  // Idempotent: translating an already-translated error returns it unchanged.
  const once = ErrorTranslator.translate(new Error("User denied"));
  const twice = ErrorTranslator.translate(once);
  log(`idempotent re-translate: ${twice === once}`);

  return {
    logs,
    result: { ...rows, idempotent: twice === once },
  };
}
