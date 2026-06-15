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

Switch the network to **devnet** to land a real transaction:

1. Provide a funded devnet keypair — paste a 64-byte secret-key JSON array (e.g.
   the repo's `.devnet-keypair.json` from `examples/devnet-demo.ts`), or click
   **generate** to mint one in-browser (then fund the shown address via the
   linked faucet). The key is kept only in this browser's `localStorage`.
2. **Send devnet tx** signs a 0.0001 SOL self-transfer and lands it through the
   real `TransactionSender` against `api.devnet.solana.com`.
3. The event log prints the confirmed signature and an **explorer link**; the
   `Library` toggle still works, so you can compare the resilient sender against
   a naive single broadcast on the real network.

> ⚠️ **Devnet only** — never paste a mainnet secret key into a web page.
> Requires a modern browser (the kit signs via WebCrypto Ed25519) and the public
> devnet RPC's permissive CORS.

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
