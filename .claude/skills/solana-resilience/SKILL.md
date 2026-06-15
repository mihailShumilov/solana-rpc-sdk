---
name: solana-resilience
description: House skill for the solana-resilience-kit SDK. Use whenever implementing or reviewing any src/ module, writing tests, or reasoning about Solana RPC/transaction reliability. Encodes the Solana correctness invariants, the simulation-harness contract, and the test-first workflow so every implementation run agrees.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
effort: medium
---

# solana-resilience house skill

Read this before touching any module so implementation stays consistent.

## Workflow (test-first)
1. Run `npm test` to see current red/green state.
2. Pick ONE red spec file. Read it fully — it is the contract.
3. Implement the corresponding src/ file until that spec is green.
4. Run `npm test` + `npm run typecheck`. Do not regress any green test.
5. Never edit tests or the harness to pass. Flag genuinely-wrong specs instead.

## Harness contract (test/harness)
- `MockCluster` — manual clock via `advanceSlots(n)`; issues blockhashes with
  lastValidBlockHeight = blockHeight + 150; tracks tx landing / silent-drop / expiry.
- `MockEndpoint(cluster, { faults })` — exposes a real @solana/kit `RpcTransport`;
  faults: latencyMs, dropRate, errorRate, rate429Rate, slotLag, offline.
  `endpoint.lastSendParams` captures the last sendTransaction config (assert maxRetries:0).
- `MockJitoEngine` — getTipAccounts / getTipFloor / sendBundle / getInflightBundleStatuses;
  `scheduleBundleNeverLands(id)` drives the fallback path.
- Tests inject `sleep = async () => cluster.advanceSlots(1)` so loops run instantly
  and deterministically. Implement loops to accept that injected `sleep`.

## Solana invariants
(see CLAUDE.md "Solana correctness invariants" — they are authoritative)

## Implementation order (by judging leverage: Correctness 40% + Resilience 25%)
HealthMonitor → CreditRateLimiter → ResilientRpcPool → ConfirmationTracker →
TransactionSender → FeeEstimator/oracles → JitoRouter/TipEstimator →
ResilientWalletAdapter → OtelMetrics → CLI.
