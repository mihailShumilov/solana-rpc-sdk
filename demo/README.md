# RPC Resilience Lab

An interactive, **backend-free** browser app that runs the *real*
`solana-resilience-kit` SDK against the *real* simulation harness. Inject faults
into mock RPC endpoints and watch the SDK route, fail over, rebroadcast, and
confirm — with live health cards, a pipeline stepper, telemetry, and an event
log.

It imports the actual modules — nothing is reimplemented for the demo:

- `ResilientRpcPool`, `TransactionSender`, `JitoRouter`, `TipEstimator`,
  `InMemoryMetrics` from [`../src`](../src)
- `MockCluster`, `MockEndpoint`, `MockJitoEngine` from
  [`../test/harness`](../test/harness)

## Run it

```bash
cd demo
npm install
npm run dev        # http://localhost:5173
```

Build / preview a production bundle:

```bash
npm run build      # → demo/dist
npm run preview    # serves the built bundle
```

> The dev server is configured with `server.fs.allow: ['..']` so Vite can read
> the SDK and harness sources from the repository root. Vite resolves the SDK's
> `.js` ESM imports to their `.ts` sources automatically.

## Deploy (Cloudflare Pages / static host)

This app is fully self-contained: `@solana/kit` and `@opentelemetry/api` (the
SDK source's runtime deps) are declared here and aliased to this package's own
`node_modules` in [`vite.config.ts`](./vite.config.ts), so a build that installs
only `demo/` resolves everything. The full repository is still cloned, so the
build can read the SDK/harness sources from `../`.

Cloudflare Pages settings:

| Setting | Value |
|---|---|
| **Root directory** | `demo` |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Node version** | 22 (pinned by [`.nvmrc`](./.nvmrc)) |

The output is a static SPA — any static host (Netlify, GitHub Pages, S3, …)
works the same way: install in `demo/`, `npm run build`, serve `demo/dist`.

## Two networks

- **Simulation** (default) — the SDK runs against the in-memory fault-injection
  harness. Deterministic, offline, instantly reproducible.
- **Devnet** — the SDK builds, signs, sends, and confirms a *real* transaction
  on Solana devnet, and links it in the explorer (see below).

## What you can do (simulation)

- **Fault scenarios** — `healthy`, `drop`, `429`, `lag`, `jito-fail`,
  `congestion`. Each mutates the `EndpointFaultProfile` of the mock endpoints
  (and, for `jito-fail`, the Block Engine), and a panel explains the injected
  fault, what a naive client does, and what the kit does:
  - `drop` — silent drops on every node → the sender rebroadcasts then reports
    `expired` (the classic "looks healthy, tx vanishes" failure).
  - `429` — one node rate-limits → the pool fails over to a healthy node.
  - `lag` — one node is >150 slots behind → `HealthMonitor` deprioritizes it.
  - `jito-fail` — the bundle never lands → `JitoRouter` falls back to RPC.
  - `congestion` — latency + partial drops/429s across nodes.
- **SDK on/off** — flip the `Library` toggle to bypass the kit and run a naive
  baseline (one endpoint, a single broadcast, no failover / rebroadcast / Jito
  fallback). The scoreboard tracks landing rate **with kit vs without kit** so
  the difference is measurable — run a scenario both ways and compare.
- **Route via Jito** — push sends through `JitoRouter` (with automatic RPC
  fallback) instead of the plain sender.
- **Send transaction** — runs an actual `sendAndConfirm` / `sendWithFallback`
  pipeline. The injected `sleep` advances the mock cluster one slot per tick and
  paces the animation (adjust with the speed slider).

## Devnet mode (real transactions)

Switch the network to **devnet** to land a real transaction. Wallet connection
uses the standard Solana **wallet-adapter** (`WalletMultiButton` top-right +
the usual selection modal; any Wallet-Standard wallet such as Phantom is
auto-detected):

1. Click **Select Wallet** (top right) and connect — the panel shows the wallet
   address and its devnet balance (fund it via the linked faucet if empty). Set
   the wallet to **Devnet**.
2. **Send devnet tx** — the wallet signs a 0.001 SOL transfer from your wallet
   to a fixed recipient (`C29D7kTebateDoX7Y1qCugRu5AaY2j34fHZnAkY2fNhK`). The
   amount clears the rent-exempt minimum so the first transfer can create the
   recipient account. The
   signed bytes are then landed by the real `TransactionSender` against
   `api.devnet.solana.com` (the SDK does the broadcast/rebroadcast/confirm — the
   wallet only signs, the kit never sees the key).
3. The event log prints the confirmed signature and an **explorer link**; the
   `Library` toggle still works, so you can compare the resilient sender against
   a naive single broadcast on the real network.

> ⚠️ **Devnet only.** The transaction is built with `@solana/web3.js` v1 (what
> the wallet signs) and sent by the kit. Relies on the public devnet RPC's
> permissive CORS.

## How the live telemetry works

A single emitting `Metrics` sink is shared by the pool and the sender. Every
`recordRequest` / `recordRateLimited` / `recordRebroadcast` / `recordLanding`
call both accumulates in `InMemoryMetrics` (driving the landing-rate, failover,
rebroadcast, and expired tiles) and streams a line into the event log. The
endpoint cards read `pool.health()` (the SDK's `HealthMonitor` snapshot) plus
the live cluster slot.

## Notes

- **No network, no keys.** Everything runs in-memory against the deterministic
  harness — the same one the SDK's test suite uses.
- **Browser `Buffer`.** The harness's base58 helper decodes base64 with Node's
  `Buffer`. The lab only sends short signature strings (never hitting that path),
  but [`src/polyfills.ts`](./src/polyfills.ts) installs a browser `Buffer` global
  from the `buffer` package so the harness works unmodified regardless.
- Type-checking of the SDK itself lives in the root project (`npm run typecheck`);
  this app builds with Vite/esbuild.
