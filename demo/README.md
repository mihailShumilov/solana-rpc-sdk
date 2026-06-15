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

## What you can do

- **Fault scenarios** — `healthy`, `drop`, `429`, `lag`, `jito-fail`,
  `congestion`. Each mutates the `EndpointFaultProfile` of the mock endpoints
  (and, for `jito-fail`, the Block Engine), so the SDK reacts to genuine
  conditions:
  - `drop` — silent drops on every node → the sender rebroadcasts then reports
    `expired` (the classic "looks healthy, tx vanishes" failure).
  - `429` — one node rate-limits → the pool fails over to a healthy node.
  - `lag` — one node is >150 slots behind → `HealthMonitor` deprioritizes it.
  - `jito-fail` — the bundle never lands → `JitoRouter` falls back to RPC.
  - `congestion` — latency + partial drops/429s across nodes.
- **Route via Jito** — toggle to push sends through `JitoRouter` (with automatic
  RPC fallback) instead of the plain sender.
- **Send transaction** — runs an actual `sendAndConfirm` / `sendWithFallback`
  pipeline. The injected `sleep` advances the mock cluster one slot per tick and
  paces the animation (adjust with the speed slider).

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
