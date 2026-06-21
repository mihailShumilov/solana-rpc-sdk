# solana-resilience-kit

[![npm version](https://img.shields.io/npm/v/solana-resilience-kit.svg)](https://www.npmjs.com/package/solana-resilience-kit)
[![npm downloads](https://img.shields.io/npm/dm/solana-resilience-kit.svg)](https://www.npmjs.com/package/solana-resilience-kit)
[![types included](https://img.shields.io/npm/types/solana-resilience-kit.svg)](https://www.npmjs.com/package/solana-resilience-kit)
[![coverage ≥90% (CI-enforced)](https://img.shields.io/badge/coverage-%E2%89%A590%25%20CI--gated-brightgreen)](./.github/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/solana-resilience-kit.svg)](./LICENSE)

A vendor-neutral, **client-side resilience and observability layer for Solana dApps**, built on `@solana/kit` (web3.js v2). It unifies the reliability work that is today either left as a do-it-yourself recipe by the official SDK or locked inside a single provider: health-aware multi-RPC failover, a correct transaction send/confirm state machine, simulate-based fee/CU estimation, Jito/MEV routing with automatic RPC fallback, and standardized OpenTelemetry/Datadog telemetry — behind one clean API that works on top of any set of providers.

> **🔬 Live demo: [solana-resilience-kit.pages.dev](https://solana-resilience-kit.pages.dev)** — the *RPC Resilience Lab* runs the real SDK in your browser: inject faults against the simulation harness, flip the kit on/off to compare landing rates, or connect a wallet and land a real transaction on devnet. ([source](./demo))

- **Vendor-neutral** — works with any RPC provider; no gateway, no proprietary key required.
- **Correct by construction** — implements the send/confirm semantics most clients get wrong (no double-charge, bounded by `lastValidBlockHeight`).
- **Built on `@solana/kit`** — the pool *is* a kit `RpcTransport`, so it drops into existing kit code.
- **Deterministically tested** — an in-memory fault-injection cluster reproduces drops, expiry, 429s, desync, and MEV failures; 102 specs, coverage-gated.
- **Observable** — first-class client telemetry to OpenTelemetry / Datadog.

## Problem

Solana's reliability failures are not random bugs — they are direct consequences of four structural facts, and each needs a distinct client-side mitigation:

1. **No mempool.** RPC nodes forward a transaction straight to the upcoming leader over QUIC; there is no shared pending pool, so a dropped transaction leaves no trace and gets no automatic retry. ([Solana — Retry](https://solana.com/developers/guides/advanced/retry))
2. **Blockhash expiry.** A recent blockhash is valid for only ~150 blocks (~60–90 s); after that the transaction is permanently rejected. Re-signing *before* expiry can land both copies and **double-charge the user** — safe resend only happens once block height passes `lastValidBlockHeight`. ([Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation))
3. **Stake-weighted QoS (SWQoS).** Leaders reserve ~80% of inbound QUIC connections for staked validators and ~20% shared across all unstaked nodes, so unstaked submission is structurally disadvantaged under congestion. ([Helius — SWQoS](https://www.helius.dev/blog/stake-weighted-quality-of-service-everything-you-need-to-know))
4. **Localized fee markets.** Contention attaches to specific write-locked accounts, so a global fee number is a poor proxy for what *your* transaction needs. ([Helius — local fee markets](https://www.helius.dev/blog/solana-local-fee-markets))

These modes are dormant in calm conditions and resurface on every demand spike — the March–April 2024 congestion drove non-vote failure rates near 75%. ([Cointelegraph](https://cointelegraph.com/news/solana-struggling-record-seventy-five-percent-trasnactions-fail-memecoin-mania)) Reliability therefore has to be engineered around each fact explicitly, not treated as best-effort.

## Pain points

| Pain | Who it hits | What this SDK does |
|---|---|---|
| Silent transaction drop (no error, no trace) | end users, dApp devs | `TransactionSender` with bounded rebroadcast and block-height confirmation |
| Blockhash expiry / double-charge on resign | end users, dApp devs | outcome bounded by `lastValidBlockHeight`; never re-signs the transaction |
| 429 / credit exhaustion | anyone on public/shared RPC, indexers, bots | `CreditRateLimiter` (per-method weights) + pool failover |
| Node desync inside an RPC pool | every multi-provider dApp | `HealthMonitor` (slot-freshness ranking), routes to a fresh node |
| Priority-fee / compute-unit estimation | all devs, wallets, traders | `simulate → unitsConsumed + ~10%`, percentile fee oracle |
| MEV / frontrunning | DEX/memecoin swappers, bots | `JitoRouter` + dynamic tip + automatic fallback to RPC |
| Observability blind spot | infra/frontend engineers, wallets | client telemetry exported to OpenTelemetry / Datadog |

## Existing solutions & their shortcomings

The decisive finding: every robust mitigation today is **either a DIY recipe in the official SDK, or locked inside one provider's walled garden.**

| Tool / layer | Solves | Falls short |
|---|---|---|
| **`@solana/kit`** (web3.js v2) | Composable transports, better confirmation primitives, tree-shakable | Failover / round-robin / retry shipped only as **copy-paste recipes**; no Jito routing, no health-aware multi-RPC, no telemetry |
| **Helius / QuickNode / Triton** | Excellent landing (staked send), priority-fee & bundle APIs | **Provider lock-in** — needs their key and their gateway; server-side; doesn't unify across providers |
| **Jito** (bundles, low-latency send) | MEV protection, atomicity, tips | A provider service; a `bundle_id` is a receipt, **not a landing guarantee** — needs fallback + tip logic the dev must build |
| **`@solana/wallet-adapter`** | Wallet connect / sign / send handoff | **No resilience** — failover/retry/confirmation are explicitly the app's job |
| **OSS multi-RPC libs** | Thin failover wrappers | Narrow; none combine retry + confirmation + Jito + observability |
| **OpenTelemetry / Datadog** | Generic JSON-RPC spans, OTLP ingest | **No Solana-specific client instrumentation exists** |

**The white space:** a *vendor-neutral, client-side, systems-grade* layer that unifies all of the above behind one API on top of `@solana/kit` — which is exactly what this package provides.

## Modules

| Module | File | Responsibility |
|---|---|---|
| `ResilientRpcPool` | `src/rpc/pool.ts` | Failover + freshness-aware routing behind one kit `RpcTransport`; per-request metrics |
| `HealthMonitor` | `src/rpc/health.ts` | Per-endpoint freshness/latency/error tracking; ejects laggards beyond `maxSlotLag` |
| `CreditRateLimiter` | `src/rpc/rate-limit.ts` | Weighted-credit token bucket to pre-empt 429s |
| `TransactionSender` | `src/tx/sender.ts` | Send/confirm state machine: `maxRetries:0`, bounded rebroadcast, **no re-sign** |
| `ConfirmationTracker` | `src/tx/confirmation.ts` | Decides outcome by block height vs `lastValidBlockHeight`, never polls forever |
| `FeeEstimator` + `NativeFeeOracle` / `HeliusFeeOracle` | `src/fees/*` | Simulate-based CU sizing + pluggable percentile fee oracle (native or Helius) |
| `JitoRouter` + `TipEstimator` | `src/jito/*` | Bundle routing, dynamic tips, automatic RPC fallback |
| `OtelMetrics` / `InMemoryMetrics` | `src/observability/metrics.ts` | Client telemetry (latency, failures, slot lag, landings) → OTel/Datadog |
| `ResilientWalletAdapter` | `src/wallet/adapter.ts` | Wallet-signed transactions through the resilient pipeline |
| `WalletAdapterBridge` (+ `useResilientSender`) | `src/wallet/wallet-adapter-bridge.ts`, `src/react/*` | Bridge a standard `@solana/wallet-adapter` signer into the resilient sender + Jito router; optional React hook (see [Wallet-adapter bridge](#wallet-adapter-bridge--react-hook)) |
| `ErrorTranslator` | `src/error-translator.ts` | Map raw RPC/program/wallet errors to a stable `code` + actionable `userMessage`/`suggestion` |
| `LifecycleEmitter` | `src/events.ts` | Typed, browser-safe `transaction:*` / `connection:*` event stream for dApp UIs |
| `ClusterDetector` | `src/rpc/cluster.ts` | Identify the cluster via genesis hash; guard against sending to the wrong network |
| `Diagnostics` + `solana-resilience-diagnose` CLI | `src/cli/diagnose.ts`, `src/cli/index.ts` | Probe provider health; explain why a transaction did or didn't land (see [Diagnostics CLI](#diagnostics-cli)) |

## Architecture

```mermaid
flowchart LR
  dApp[dApp] --> WA[ResilientWalletAdapter]
  WA -->|signed wire tx| TS[TransactionSender]
  TS <-->|send / confirm| POOL[ResilientRpcPool]
  subgraph POOL_INTERNALS [ResilientRpcPool]
    HM[HealthMonitor]
    RL[CreditRateLimiter]
    FO[failover + freshness routing]
  end
  POOL --> EP[(RPC endpoints)]
  FE[FeeEstimator] -.priority fee / CU.-> TS

  dApp --> JR[JitoRouter]
  JR -->|bundle + tip| BE[Jito Block Engine]
  JR -.fallback when bundle does not land.-> TS

  TS --> M[OtelMetrics → OpenTelemetry / Datadog]
  POOL --> M
```

The pool exposes a real `@solana/kit` `RpcTransport`, so callers build a normal kit RPC with `pool.rpc()` and use it like any other — failover, freshness routing, and metrics happen underneath. The Jito path runs in parallel and **always falls back** to the resilient sender when a bundle does not land.

## Install

```bash
npm install solana-resilience-kit @solana/kit
```

Requires Node ≥ 20. The package is ESM-only and ships compiled JS with type declarations. **`@solana/kit` is a required peer dependency** (`^6.9.0`): install it alongside so your app and the SDK resolve to a *single* kit instance — this keeps kit's branded types (`Address`, `Signature`, `Base64EncodedWireTransaction`, …) compatible across the boundary. `@opentelemetry/api` is an **optional** peer, needed only if you use `OtelMetrics` (and is already pulled in transitively by the OpenTelemetry SDK packages — see [Wiring observability to OpenTelemetry / Datadog](#wiring-observability-to-opentelemetry--datadog)).

## Quickstart

Build a failover pool from two RPC endpoints and use it as a normal kit RPC:

```ts
import { createDefaultRpcTransport } from "@solana/kit";
import { ResilientRpcPool, TransactionSender } from "solana-resilience-kit";

const pool = new ResilientRpcPool({
  endpoints: [
    { name: "primary", transport: createDefaultRpcTransport({ url: PRIMARY_URL }) },
    { name: "backup",  transport: createDefaultRpcTransport({ url: BACKUP_URL }) },
  ],
});

const rpc = pool.rpc();                 // a normal @solana/kit RPC, failover underneath
const slot = await rpc.getSlot().send();
```

Send a signed transaction with correct confirmation semantics:

```ts
const sender = new TransactionSender(rpc);

const result = await sender.sendAndConfirm({
  wireTransaction,        // base64, already signed (from getBase64EncodedWireTransaction)
  signature,              // from getSignatureFromTransaction
  lastValidBlockHeight,   // from the blockhash the tx was built with
});

// result.outcome is "confirmed", "failed" (landed but reverted), or "expired" —
// decided by block height, not a timeout. The sender uses maxRetries:0,
// rebroadcasts the *same* signed bytes, never re-signs (so it can never
// double-charge), and treats a resend error on an already-landed tx as
// non-terminal.
```

## Wallet-adapter bridge + React hook

Bring your own `@solana/wallet-adapter` wallet (Phantom, Solflare, Backpack…) and
land its signed transactions through the resilient sender — and through Jito with
automatic RPC fallback when a router is supplied. `react` and
`@solana/wallet-adapter-*` are **optional** peer deps; the React hook lives behind
the `solana-resilience-kit/react` subpath, so the core bundle stays framework-agnostic.

```ts
import { WalletAdapterBridge } from "solana-resilience-kit";
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
} from "@solana/kit";

// `wallet` is a standard wallet-adapter signer, e.g. Phantom via
// useWallet() from @solana/wallet-adapter-react.
const bridge = new WalletAdapterBridge({
  wallet,                 // { publicKey, signTransaction, signAllTransactions? }
  sender,                 // TransactionSender (built on a ResilientRpcPool)
  jito: router,           // optional: route via Jito, fall back to RPC
  // Turn the wallet-signed kit transaction into wire + signature:
  encode: (signed) => ({
    wireTransaction: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  }),
});

const result = await bridge.signAndSend(transaction, { lastValidBlockHeight });
// A wallet rejection surfaces as a typed USER_REJECTED error (ErrorTranslator).
```

React ergonomic with live status sourced from the lifecycle event stream:

```tsx
import { useWallet } from "@solana/wallet-adapter-react";
import { useResilientSender } from "solana-resilience-kit/react";

function SendButton({ sender, transaction, lastValidBlockHeight }) {
  const wallet = useWallet(); // Phantom / Solflare / Backpack …
  const { signAndSend, status, error, address } = useResilientSender({ wallet, sender });

  return (
    <button
      disabled={!address || status === "pending"}
      onClick={() => signAndSend(transaction, { lastValidBlockHeight })}
    >
      {status === "pending" ? "Sending…" : `Send (${status})`}
      {error ? ` — ${String(error)}` : ""}
    </button>
  );
}
```

## Diagnostics CLI

The package ships an executable, `solana-resilience-diagnose`, built on the same
`Diagnostics` core (`src/cli/diagnose.ts`). It answers the two questions an
operator asks when a Solana dApp misbehaves — *which of my providers is healthy
and freshest?* and *did this transaction land, expire, or is it still pending?* —
without writing any code. Run it zero-install with `npx`, or — once the package
is a dependency — call `solana-resilience-diagnose` directly (it is on your
`node_modules/.bin`):

```bash
# Probe provider health across one or more endpoints (reuses the pool's own
# slot-freshness ranking, so "freshest" matches what routing would pick):
npx -p solana-resilience-kit solana-resilience-diagnose probe \
  --rpc https://api.mainnet-beta.solana.com \
  --rpc https://my-backup.rpc
```

```
ENDPOINT                            HEALTH  SLOT       LATENCY  FRESHEST
https://api.mainnet-beta.solana.com ok      287654812  142ms    *
https://my-backup.rpc               down    -          19ms

Freshest: https://api.mainnet-beta.solana.com  ·  1/2 healthy.
  https://my-backup.rpc: fetch failed
```

```bash
# Explain a transaction's outcome point-in-time (no polling loop): it compares
# the current signature status and block height against lastValidBlockHeight —
# the canonical Solana rule — and never re-signs.
npx -p solana-resilience-kit solana-resilience-diagnose explain \
  --rpc https://api.mainnet-beta.solana.com \
  --sig 5xRe...your-signature \
  --lvbh 287654321
```

```
Signature: 5xRe...your-signature
Verdict: EXPIRED
block height 287654400 exceeded lastValidBlockHeight 287654321; the blockhash
expired before the transaction landed (silent drop or congestion). Rebuild with
a fresh blockhash — do NOT re-sign the same one.
```

| Flag | Command | Meaning |
|---|---|---|
| `--rpc <url>` | both | RPC endpoint URL. Repeat for `probe`; exactly one for `explain`. Accepts `--rpc=<url>` too. |
| `--sig <sig>` | `explain` | Transaction signature to explain. |
| `--lvbh <n>` | `explain` | `lastValidBlockHeight` the transaction was built against. |

**Exit codes:** `0` success · `1` a substantive failure (no healthy endpoint, or an
expired transaction) · `2` a usage error. Run with no command, `help`, or
`--help` to print usage. The argv parser is a pure, network-free function and is
unit-tested in isolation (`test/cli/argv.test.ts`).

## Wiring observability to OpenTelemetry / Datadog

The library depends on **only `@opentelemetry/api`** — `OtelMetrics` writes to the
*global* OpenTelemetry meter, which is a **no-op until your app registers a real
`MeterProvider`** with a reader + exporter. The OTel SDK and OTLP exporter are
your application's dependencies, not the SDK's, so you choose the backend. The
~10 lines that make exports real:

```ts
import { metrics } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OtelMetrics, ResilientRpcPool } from "solana-resilience-kit";

// 1. Register a working MeterProvider — without this, OtelMetrics is inert.
metrics.setGlobalMeterProvider(
  new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        // Reads OTEL_EXPORTER_OTLP_ENDPOINT, e.g. an OTel Collector or the
        // Datadog Agent's OTLP intake (http://localhost:4318).
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 10_000,
      }),
    ],
  }),
);

// 2. Hand OtelMetrics to the SDK — now every signal below is exported.
const pool = new ResilientRpcPool({ endpoints, metrics: new OtelMetrics({ serviceName: "my-dapp" }) });
```

Install the exporter side in your app (devtime/runtime, not in this library):

```bash
npm install @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
```

**For Datadog**, point `OTEL_EXPORTER_OTLP_ENDPOINT` at the Datadog Agent's OTLP
endpoint (enable OTLP ingestion in the Agent); no separate Collector needed.

The SDK emits a small, fixed set of client-side instruments:

| Instrument | Type | Attributes | Emitted when |
|---|---|---|---|
| `rpc.request.latency_ms` | histogram | `endpoint`, `method`, `ok` | every RPC request attempt (per endpoint) |
| `rpc.request.failures` | counter | `endpoint`, `method` | a request attempt fails |
| `rpc.rate_limited` | counter | `endpoint` | an attempt is rejected with HTTP 429 |
| `tx.rebroadcasts` | counter | `signature` | the sender rebroadcasts the signed transaction |
| `tx.landings` | counter | `signature`, `outcome`, `slots` | a transaction reaches a terminal outcome (`confirmed` / `expired`) |
| `rpc.endpoint.slot` | gauge | `endpoint` | a `getSlot` response is observed (slot-lag dashboards) |

A runnable end-to-end demo is in [`examples/otel-setup.ts`](./examples/otel-setup.ts):
`npm run example:otel` wires `OtelMetrics` into a pool + sender, drives simulated
sends against the harness, and exports all six instruments — with a console
exporter attached so you see every data point even without a collector running.

## Testing your own code against the fault harness

The deterministic Solana cluster simulator the SDK is tested with is shipped as a
secondary entry point, so you can drive *your* code through the same injected
faults (drops, expiry, 429s, slot lag) — no network, fully reproducible:

```ts
import { MockCluster, MockEndpoint } from "solana-resilience-kit/testing";
import { createSolanaRpcFromTransport } from "@solana/kit";

const cluster = new MockCluster({ initialBlockHeight: 700n });
const endpoint = new MockEndpoint(cluster, { name: "sim" });
endpoint.faults = { dropRate: 1 };               // silently drop every send
const rpc = createSolanaRpcFromTransport(endpoint.transport);

// ...exercise your sender; advance time deterministically:
cluster.advanceSlots(160);                        // push past lastValidBlockHeight
```

## Interactive demo

**Live at [solana-resilience-kit.pages.dev](https://solana-resilience-kit.pages.dev)** · source in [`demo/`](./demo)

**RPC Resilience Lab** is a backend-free Vite + React app that runs the *real* SDK in your browser. In **simulation** mode it drives the fault harness (inject drops / 429s / lag / Jito failure and flip the SDK on/off to compare landing rates against a naive client); in **devnet** mode it connects a standard wallet (`@solana/wallet-adapter`), signs a real transfer, and lands it through the SDK with an explorer link.

```bash
cd demo && npm install && npm run dev
```

A headless Node example is in [`examples/devnet-demo.ts`](./examples/devnet-demo.ts) (`npx tsx examples/devnet-demo.ts`).

## Testing & simulation

Solana's failure modes — silent drops, blockhash expiry, 429s, lagging-node desync, MEV — cannot be reproduced reliably against live infrastructure, so the SDK is tested against an in-memory, deterministic model of a Solana cluster that injects exactly these faults.

- **Real `@solana/kit` integration.** Each simulated endpoint exposes a real kit `RpcTransport`; a harness self-test signs an actual kit transaction and verifies our wire-format signature extraction matches `getSignatureFromTransaction` — so web3.js-v2 compatibility is *proven*, not assumed.
- **Manual clock.** Nothing advances unless a test calls `cluster.advanceSlots(n)`, making blockhash-expiry and rebroadcast timing deterministic.
- **Seeded faults.** A seeded PRNG drives drops / 429s / latency / slot lag, so every failing sequence is reproducible.
- **Injected `sleep`.** Time-based loops take a `sleep` dependency; tests pass one that advances the mock clock, so the whole state machine runs instantly and deterministically.

```bash
npm test          # full suite (harness + all modules), 102 specs
npm run test:cov  # coverage with the thresholds enforced
npm run typecheck # tsc --noEmit
```

Coverage thresholds (`vitest.config.ts`) are **lines 90 / functions 90 / branches 85 / statements 90**, and the suite passes them. **CI enforces this gate on every push and PR** — the `docker compose run --rm cov` step in [`ci.yml`](./.github/workflows/ci.yml) runs `npm run test:cov`, which exits non-zero (failing the build) if coverage drops below those thresholds. A fully reproducible Docker environment is available via the [`Makefile`](./Makefile):

```bash
make verify   # typecheck + always-green harness/metrics tests, in Docker
make test     # typecheck + full suite, in Docker
make cov      # coverage report (writes ./coverage)
```

## Building from source

```bash
npm run build   # emit dist/ — compiled JS + .d.ts for `.` and `./testing`
```

The published package contains only `dist/`, `README.md`, and `LICENSE`. `prepublishOnly` re-runs typecheck + tests + build before any publish.

## Project layout

```
src/        public API — the SDK modules
test/       behavioral specs + test/harness/ (the simulation cluster)
demo/       RPC Resilience Lab (Vite + React browser app)
examples/   headless devnet example
```

## License

[MIT](./LICENSE)
</content>
</invoke>
