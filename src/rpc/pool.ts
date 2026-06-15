/**
 * ResilientRpcPool — the heart of the RPC layer. Wraps N endpoints behind a
 * single `@solana/kit`-compatible RpcTransport that:
 *   - routes to the freshest healthy endpoint (via HealthMonitor),
 *   - fails over to the next endpoint on 429 / transport error,
 *   - meters weighted credits to pre-empt 429s (CreditRateLimiter),
 *   - emits per-request metrics.
 *
 * Because it exposes a real RpcTransport, callers build a normal kit RPC with
 * `pool.rpc()` and use it exactly like any kit RPC — that is the web3.js-v2
 * compatibility guarantee plus DX win.
 */
import type { RpcTransport } from "@solana/rpc-spec";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { NotImplementedError } from "../errors.js";
import type { HealthMonitor } from "./health.js";
import type { CreditRateLimiter } from "./rate-limit.js";
import type { Metrics } from "../observability/metrics.js";

export interface ResilientEndpoint {
  name: string;
  /** A kit-compatible transport (HTTP transport in prod, MockEndpoint in tests). */
  transport: RpcTransport;
  /** Relative routing weight among equally-fresh endpoints (default 1). */
  weight?: number;
}

export interface ResilientRpcConfig {
  endpoints: ResilientEndpoint[];
  /** Max endpoint attempts per logical request (default = endpoints.length). */
  maxAttempts?: number;
  /** Route to the freshest healthy node first (default true). */
  freshnessAware?: boolean;
  /** Send the same read to N endpoints and take the first response (default 1). */
  hedge?: number;
  healthMonitor?: HealthMonitor;
  rateLimiter?: CreditRateLimiter;
  metrics?: Metrics;
}

export class ResilientRpcPool {
  constructor(_config: ResilientRpcConfig) {}

  /** The failover transport. Plug into `createSolanaRpcFromTransport`. */
  get transport(): RpcTransport {
    throw new NotImplementedError("ResilientRpcPool.transport");
  }

  /** A ready-to-use kit RPC backed by the resilient transport. */
  rpc(): Rpc<SolanaRpcApi> {
    throw new NotImplementedError("ResilientRpcPool.rpc");
  }

  /** Current per-endpoint health snapshot (for monitoring / CLI). */
  health() {
    throw new NotImplementedError("ResilientRpcPool.health");
  }
}
