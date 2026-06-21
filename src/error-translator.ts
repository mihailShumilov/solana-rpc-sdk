/**
 * ErrorTranslator — maps raw, opaque upstream errors (RPC strings, program
 * custom-error codes, wallet rejections, HTTP 429s) into a friendly, actionable
 * {@link TranslatedError}: a stable `code`, a `category`, a human `userMessage`,
 * and a concrete `suggestion` — while preserving the `originalError`.
 *
 * Design:
 *  - PURE and dependency-free: no I/O, no clock, no network. `translate()` never
 *    throws — a malformed or circular input still yields the generic fallback.
 *  - The dictionary ({@link ERROR_PATTERNS}) is an ORDERED table; the first
 *    matching pattern wins, so more specific patterns are listed first.
 *  - Matching runs against a lower-cased "searchable" projection of the error
 *    that folds in the message, any HTTP status, and any Solana program
 *    `Custom` error code rendered as hex (so `{ Custom: 6001 }` matches `0x1771`).
 *  - The SAME dictionary backs the diagnostics CLI, so SDK errors and CLI output
 *    stay consistent (no duplicated copy).
 */
import { SdkError } from "./errors.js";

export type ErrorCode =
  | "USER_REJECTED"
  | "WALLET_NOT_CONNECTED"
  | "NETWORK_MISMATCH"
  | "INSUFFICIENT_FUNDS"
  | "BLOCKHASH_EXPIRED"
  | "SLIPPAGE_EXCEEDED"
  | "RATE_LIMITED"
  | "SIMULATION_FAILED"
  | "UNKNOWN";

export type ErrorCategory =
  | "user"
  | "wallet"
  | "network"
  | "funds"
  | "blockhash"
  | "slippage"
  | "rate-limit"
  | "simulation"
  | "unknown";

/** Optional extra signal folded into matching (e.g. the RPC method or phase). */
export interface TranslateContext {
  extra?: string;
}

/**
 * A normalized, user-facing error. Extends {@link SdkError} so it flows through
 * the existing taxonomy; carries the originating error for debugging/telemetry.
 */
export class TranslatedError extends SdkError {
  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    readonly userMessage: string,
    readonly suggestion: string,
    readonly originalError: unknown,
  ) {
    super(userMessage);
  }
}

interface ErrorPattern {
  code: ErrorCode;
  category: ErrorCategory;
  pattern: RegExp;
  userMessage: string;
  suggestion: string;
}

/**
 * Ordered most-specific-first. Slippage precedes insufficient-funds so a swap's
 * `0x1771` is never misread; both use word-boundaried hex so `0x1` does not
 * swallow `0x1771`.
 */
export const ERROR_PATTERNS: readonly ErrorPattern[] = [
  {
    code: "USER_REJECTED",
    category: "user",
    pattern: /user rejected|user denied|user cancell?ed|rejected the request|reject(ed)? the transaction|signature request (denied|rejected)|approval denied/,
    userMessage: "You rejected the request in your wallet.",
    suggestion: "Re-initiate the action and approve the transaction in your wallet to continue.",
  },
  {
    code: "WALLET_NOT_CONNECTED",
    category: "wallet",
    pattern: /wallet not connected|walletnotconnected|wallet is not connected|no wallet (connected|selected|found)/,
    userMessage: "No wallet is connected.",
    suggestion: "Connect a wallet (e.g. Phantom or Solflare) before sending a transaction.",
  },
  {
    code: "NETWORK_MISMATCH",
    category: "network",
    pattern: /network mismatch|wrong network|cluster mismatch|connected to the wrong (network|cluster)|different (cluster|network)/,
    userMessage: "Your wallet is on a different network than this app expects.",
    suggestion: "Switch your wallet to the correct cluster (mainnet-beta / devnet / testnet) and retry.",
  },
  {
    code: "SLIPPAGE_EXCEEDED",
    category: "slippage",
    pattern: /slippage|0x1771\b|\b0x26\b|price moved|exceeds desired|max(imum)? slippage/,
    userMessage: "The price moved beyond your slippage tolerance before the trade landed.",
    suggestion: "Increase your slippage tolerance or retry with a fresh quote.",
  },
  {
    code: "INSUFFICIENT_FUNDS",
    category: "funds",
    pattern: /insufficient (funds|lamports|balance|sol)|insufficientfunds|\b0x1\b|attempt to debit an account but found no record|not enough (sol|lamports|balance)/,
    userMessage: "Your account does not have enough SOL/tokens for this transaction.",
    suggestion: "Add funds to cover the transfer plus fees and rent, then retry.",
  },
  {
    code: "BLOCKHASH_EXPIRED",
    category: "blockhash",
    pattern: /block height exceeded|blockhash (not found|expired|too old)|blockhashnotfound|transaction expired|last valid block|lastvalidblockheight|expired before/,
    userMessage: "The transaction's blockhash expired before it landed.",
    suggestion: "Rebuild the transaction with a fresh blockhash and sign again — never re-send the expired one.",
  },
  {
    code: "RATE_LIMITED",
    category: "rate-limit",
    pattern: /\b429\b|rate.?limit|too many requests|requests per second|slow down/,
    userMessage: "The RPC endpoint is rate-limiting requests (HTTP 429).",
    suggestion: "Back off and retry, or fail over to another endpoint in the pool.",
  },
  {
    code: "SIMULATION_FAILED",
    category: "simulation",
    pattern: /simulation failed|failed to simulate|transaction simulation failed/,
    userMessage: "The transaction failed simulation and was not sent.",
    suggestion: "Inspect the simulation logs to find the failing instruction, fix the inputs, and retry.",
  },
];

const GENERIC = {
  userMessage: "An unexpected error occurred while processing the transaction.",
  suggestion: "Check the original error for details and retry; if it persists, try another RPC endpoint.",
} as const;

export class ErrorTranslator {
  /**
   * Translate any error into a {@link TranslatedError}. Pure and total: it never
   * throws and never performs I/O. Already-translated errors are returned
   * unchanged (idempotent), so wrapping at multiple boundaries is safe.
   */
  static translate(error: unknown, context?: TranslateContext): TranslatedError {
    if (error instanceof TranslatedError) return error;

    const text = `${searchableText(error)} ${context?.extra ?? ""}`.toLowerCase();
    for (const p of ERROR_PATTERNS) {
      if (p.pattern.test(text)) {
        return new TranslatedError(p.code, p.category, p.userMessage, p.suggestion, error);
      }
    }
    return new TranslatedError("UNKNOWN", "unknown", GENERIC.userMessage, GENERIC.suggestion, error);
  }
}

/** A best-effort, lower-case-able projection of an arbitrary error for matching. */
function searchableText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const parts: string[] = [];
  const e = error as Record<string, unknown>;
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.statusCode === "number") parts.push(`status ${e.statusCode}`);
  if (typeof e.code === "string" || typeof e.code === "number") parts.push(String(e.code));
  for (const custom of customCodes(error)) parts.push(`0x${custom.toString(16)}`);
  try {
    parts.push(JSON.stringify(error));
  } catch {
    // circular / non-serializable — the message + codes above still drive matching.
  }
  return parts.join(" ");
}

/** Collect every Solana program `Custom` error code anywhere in the structure. */
function customCodes(value: unknown, acc: number[] = [], seen = new Set<unknown>()): number[] {
  if (value == null || typeof value !== "object" || seen.has(value)) return acc;
  seen.add(value);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "Custom" && typeof child === "number") acc.push(child);
    else customCodes(child, acc, seen);
  }
  return acc;
}
