/**
 * Browser shims for Node-isms reached by the harness's base58 helper, by
 * @solana/web3.js v1, and by the wallet-adapter. This module is imported first
 * in main.tsx, so the globals are present before any of those modules evaluate.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
if (typeof g.global === "undefined") g.global = globalThis;
if (typeof g.process === "undefined") g.process = { env: {} };
