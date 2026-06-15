# solana-resilience-kit

A vendor-neutral, client-side **resilience and observability layer for Solana dApps**, built on `@solana/kit` (web3.js v2). It unifies the reliability work that today is either left as a DIY exercise by the official SDK or locked inside a single provider: health-aware multi-RPC failover, a correct transaction send/confirm state machine, dynamic fee/CU estimation, Jito/MEV routing with automatic RPC fallback, and standardized OpenTelemetry/Datadog telemetry — behind one clean API.

> Built for the Superteam Ukraine bounty. The motivating problem analysis (with sources) is in [`01_PROBLEM_ANALYSIS.md`](./01_PROBLEM_ANALYSIS.md) (English) / [`01_PROBLEM_ANALYSIS_RU.md`](./01_PROBLEM_ANALYSIS_RU.md) (Russian).

## Status: test-first scaffold

This repository is being built **test-first**. The simulation harness and the full behavioral test suite exist *before* the implementation, so every module has an executable specification to build against.

| Layer | State |
|---|---|
| Simulation harness (`test/harness`) | ✅ implemented + self-tested (13 green) |
| Metrics infrastructure (`InMemoryMetrics`) | ✅ implemented (3 green) |
| SDK modules (`src/**`) | ⏳ interface stubs — specs are **red** pending implementation (27 specs) |

Run `npm test` and you should see the harness green and the module specs failing with `NotImplementedError`. Turning each red spec green is the implementation task.

## Why a simulation harness first

Solana's reliability failures (silent transaction drops, blockhash expiry, RPC 429s, lagging-node desync, MEV) are network conditions that are impossible to reproduce reliably against live infrastructure. So the SDK is tested against an in-memory, deterministic model of a Solana cluster that injects exactly these faults — which is also what the bounty's "network drop and latency simulation" requirement rewards.

Key design points:

- **Real `@solana/kit` integration.** Each simulated endpoint exposes a real kit `RpcTransport`; tests build a normal kit RPC on top. A harness self-test signs an actual kit transaction and verifies our wire-format signature extraction matches `getSignatureFromTransaction` — so "web3.js v2 compatibility" is proven, not assumed.
- **Manual clock.** Nothing advances unless a test calls `cluster.advanceSlots(n)`. Blockhash expiry and rebroadcast timing become deterministic instead of wall-clock dependent.
- **Deterministic faults.** A seeded PRNG drives drops/429s, so every failing sequence is reproducible.
- **Injected `sleep`.** Time-based loops (rebroadcast, confirmation polling, bundle status) take a `sleep` dependency; tests pass a `sleep` that advances the mock clock, making the whole state machine run instantly and deterministically.

## Modules (the public API)

| Module | File | Responsibility |
|---|---|---|
| `ResilientRpcPool` | `src/rpc/pool.ts` | Failover + freshness-aware routing + hedging behind one kit transport |
| `HealthMonitor` | `src/rpc/health.ts` | Per-endpoint freshness/latency/error tracking; ejects laggards |
| `CreditRateLimiter` | `src/rpc/rate-limit.ts` | Weighted-credit limiter to pre-empt 429s |
| `TransactionSender` | `src/tx/sender.ts` | Send/confirm state machine: `maxRetries:0`, bounded rebroadcast, no re-sign |
| `ConfirmationTracker` | `src/tx/confirmation.ts` | Outcome by block height vs `lastValidBlockHeight` |
| `FeeEstimator` + oracles | `src/fees/*` | Simulate-based CU sizing + pluggable percentile fee oracle |
| `JitoRouter` + `TipEstimator` | `src/jito/*` | Bundle routing, dynamic tips, automatic RPC fallback |
| `Metrics` (`InMemoryMetrics`/`OtelMetrics`) | `src/observability/metrics.ts` | Client-side telemetry → OTel/Datadog |
| `ResilientWalletAdapter` | `src/wallet/adapter.ts` | Wallet-signed txs through the resilient pipeline |

## Getting started

```bash
npm install
npm test          # harness + metrics green; module specs red (NotImplemented)
npm run test:cov  # coverage (90% thresholds enforced once modules land)
npm run typecheck # tsc --noEmit, currently clean
```

## Implementation roadmap (ordered by judging leverage)

Correctness (40%) + Resilience (25%) are 65% of the score, so build the core first:

1. `HealthMonitor` + `CreditRateLimiter` (pure logic, fast wins).
2. `ResilientRpcPool` (failover, freshness routing, metrics).
3. `ConfirmationTracker` then `TransactionSender` — the highest-value correctness work.
4. `FeeEstimator` + `NativeFeeOracle`.
5. `JitoRouter` + `TipEstimator` (automatic fallback).
6. `ResilientWalletAdapter`.
7. `OtelMetrics` exporter + diagnostics CLI.

Each step = turn its red spec green without weakening the harness. When all specs pass, raise coverage to the 90% threshold already configured in `vitest.config.ts`.

## License

MIT
