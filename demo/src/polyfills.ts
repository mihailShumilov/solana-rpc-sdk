/**
 * The simulation harness's base58 helper (test/harness/base58.ts) decodes a
 * base64 wire transaction with Node's `Buffer`. The lab only ever sends short
 * signature strings (which the mock treats as raw signatures, never touching
 * that path), but we install a browser `Buffer` global anyway so the harness
 * works unmodified even if a full wire transaction is ever fed through it.
 */
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
}
