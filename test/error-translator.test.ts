/**
 * SPEC: ErrorTranslator (issue #2) maps raw RPC/program/wallet errors to a
 * stable code + category + non-empty userMessage + suggestion, is pure and
 * total (never throws), preserves the original error, and is idempotent.
 */
import { describe, it, expect } from "vitest";
import { ErrorTranslator, TranslatedError, type ErrorCode } from "../src/error-translator.js";

describe("ErrorTranslator.translate", () => {
  const cases: Array<[string, unknown, ErrorCode]> = [
    ["user rejection (wallet)", new Error("User rejected the request."), "USER_REJECTED"],
    ["user denied", "Transaction was denied: user denied", "USER_REJECTED"],
    ["wallet not connected", new Error("WalletNotConnectedError: wallet not connected"), "WALLET_NOT_CONNECTED"],
    ["network mismatch", new Error("cluster mismatch: expected mainnet"), "NETWORK_MISMATCH"],
    ["slippage by name", new Error("Slippage tolerance exceeded"), "SLIPPAGE_EXCEEDED"],
    ["slippage by hex 0x1771", { InstructionError: [0, { Custom: 6001 }] }, "SLIPPAGE_EXCEEDED"],
    ["insufficient funds by text", new Error("insufficient funds for transaction"), "INSUFFICIENT_FUNDS"],
    ["insufficient funds by 0x1", { err: "custom program error: 0x1" }, "INSUFFICIENT_FUNDS"],
    ["blockhash expired", new Error("block height exceeded"), "BLOCKHASH_EXPIRED"],
    ["blockhash not found", new Error("Blockhash not found"), "BLOCKHASH_EXPIRED"],
    ["rate limited 429", { statusCode: 429, message: "Too Many Requests" }, "RATE_LIMITED"],
    ["simulation failed", new Error("Transaction simulation failed: blah"), "SIMULATION_FAILED"],
  ];

  it.each(cases)("maps %s -> expected code", (_label, raw, expected) => {
    const t = ErrorTranslator.translate(raw);
    expect(t.code).toBe(expected);
    expect(t.userMessage.length).toBeGreaterThan(0);
    expect(t.suggestion.length).toBeGreaterThan(0);
    expect(t.category).not.toBe("unknown");
  });

  it("0x1 does not shadow 0x1771 (slippage wins over funds)", () => {
    expect(ErrorTranslator.translate({ InstructionError: [0, { Custom: 6001 }] }).code).toBe("SLIPPAGE_EXCEEDED");
    expect(ErrorTranslator.translate({ InstructionError: [0, { Custom: 1 }] }).code).toBe("INSUFFICIENT_FUNDS");
  });

  it("maps unknown errors to a safe generic fallback that preserves originalError", () => {
    const raw = new Error("some totally novel failure mode 12345");
    const t = ErrorTranslator.translate(raw);
    expect(t.code).toBe("UNKNOWN");
    expect(t.category).toBe("unknown");
    expect(t.userMessage.length).toBeGreaterThan(0);
    expect(t.suggestion.length).toBeGreaterThan(0);
    expect(t.originalError).toBe(raw);
  });

  it("is idempotent: translating an already-translated error returns it unchanged", () => {
    const once = ErrorTranslator.translate(new Error("User rejected the request."));
    const twice = ErrorTranslator.translate(once);
    expect(twice).toBe(once);
  });

  it("is total: never throws on null / circular / non-serializable inputs", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => ErrorTranslator.translate(null)).not.toThrow();
    expect(() => ErrorTranslator.translate(undefined)).not.toThrow();
    expect(() => ErrorTranslator.translate(42)).not.toThrow();
    expect(() => ErrorTranslator.translate(circular)).not.toThrow();
    expect(ErrorTranslator.translate(circular)).toBeInstanceOf(TranslatedError);
  });

  it("folds context.extra into matching", () => {
    expect(ErrorTranslator.translate("opaque", { extra: "rate limit exceeded" }).code).toBe("RATE_LIMITED");
  });
});
