# Project: solana-resilience-kit

Vendor-neutral, client-side resilience + observability layer for Solana dApps,
built on @solana/kit (web3.js v2). Developed TEST-FIRST.

## Commands
- npm test            # run all tests (harness green, module specs red until implemented)
- npm run test:cov    # coverage (90% thresholds in vitest.config.ts)
- npm run typecheck   # tsc --noEmit, must stay at 0 errors

## Layout
- src/**            public API (implement here)
- test/harness/**   deterministic Solana cluster simulator (DO NOT weaken)
- test/**/*.test.ts behavioral specs = the source of truth

## The TDD rule (non-negotiable)
- The way to "make progress" is: pick a red spec, implement src/ until it is green.
- NEVER edit a test to make it pass. NEVER weaken the harness. If a spec seems wrong,
  flag it explicitly and explain before changing it.
- Keep typecheck at 0 errors and never regress a green test.

## Solana correctness invariants (most submissions get these wrong)
- Fetch blockhash at `confirmed`; preflightCommitment must match the blockhash commitment.
- Send with `maxRetries: 0`; run our own rebroadcast loop.
- Bound the rebroadcast/confirm loop by `lastValidBlockHeight` — never poll forever.
- NEVER re-sign or mutate a transaction (double-charge risk). Outcome is decided by
  current block height vs lastValidBlockHeight.
- Pool must avoid the "fresh blockhash from advanced node, send to lagging node" drop:
  route by slot freshness (HealthMonitor).
- A Jito bundle_id is a receipt, not a landing guarantee — always fall back to RPC.

## Code conventions
- Strict TypeScript, ESM. Relative imports use the `.js` extension.
- Unimplemented surface throws `NotImplementedError` (src/errors.ts).
- Time-based loops take an injected `sleep` so tests advance the mock clock.
