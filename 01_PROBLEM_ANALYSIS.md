# Solana RPC & Transaction Reliability — Problem Analysis

**Prepared for:** Superteam Ukraine bounty — *Build a systems-grade SDK that improves RPC and transaction reliability for Solana dApps*
**Date:** 15 June 2026
**Purpose:** Establish, with current evidence, what is actually broken in Solana's RPC/transaction layer, where existing tooling falls short, and where a new SDK can win. This is the pre-build groundwork; the architecture and implementation follow from it.

---

## 1. Executive summary

Solana's reliability problems are not random bugs — they are direct, predictable consequences of its architecture. Because the chain has **no public mempool**, a transaction is not "pending" anywhere; an RPC node forwards it straight to the current/next slot leader over QUIC, and if it doesn't arrive and land before its blockhash expires (~150 blocks, roughly 60–90 seconds), it simply vanishes with no on-chain trace. Layered on top are connection-capacity rationing (stake-weighted QoS), localized fee-market auctions, RPC nodes that silently lag the cluster, aggressive provider rate limits, and an active MEV/sandwich economy. Each of these is a distinct failure mode, and each requires a distinct client-side mitigation.

The decisive finding from the prior-art survey: **every robust mitigation that exists today is either (a) deliberately left as a do-it-yourself recipe by the official SDK, or (b) locked inside a single provider's walled garden or server-side service.** `@solana/kit` (the renamed `@solana/web3.js v2`) ships failover, round-robin, and retry only as copy-paste transport snippets, not features. Helius, QuickNode, Triton, and Jito each solve reliability well — but only on their own gateway and with their own API keys. The wallet-adapter ecosystem handles signing, not resilience. No Solana-specific OpenTelemetry/Datadog client instrumentation exists at all.

That leaves a genuine, fundable white space: **a vendor-neutral, client-side, systems-grade resilience + observability layer** that unifies multi-RPC failover, freshness-aware routing, correct retry/rebroadcast, dynamic fee/CU estimation, Jito/MEV routing with fallback, and standardized telemetry — behind one clean API that works on top of `@solana/kit` and any set of providers. The bounty is, in effect, asking for exactly the library the ecosystem is missing.

---

## 2. Why this is hard: the architecture that creates the pain

Four structural facts explain almost every reliability problem below:

1. **No mempool.** RPC nodes forward transactions directly to the upcoming leader; there is no shared pending pool, so a dropped transaction has no record and no automatic safety net. ([Solana docs — Retry](https://solana.com/developers/guides/advanced/retry))
2. **Blockhash expiry.** A recent blockhash is valid for only ~150 blocks (~60–90 s). After that the transaction is permanently rejected and can never execute. ([Helius](https://www.helius.dev/blog/how-to-land-transactions-on-solana), [Solana docs — Confirmation](https://solana.com/developers/guides/advanced/confirmation))
3. **Stake-weighted QoS (SWQoS).** A leader caps inbound QUIC connections, reserving ~80% (~2,000) for stake-weighted validators and ~20% (~500) shared across *all* unstaked nodes — so unstaked submission is structurally disadvantaged during congestion. ([Helius — SWQoS](https://www.helius.dev/blog/stake-weighted-quality-of-service-everything-you-need-to-know))
4. **Localized fee markets.** Contention attaches to specific write-locked accounts, so a transaction touching a hot account can be starved even when the network at large looks quiet — and a global fee number is a poor proxy for what *your* transaction needs. ([Helius — local fee markets](https://www.helius.dev/blog/solana-local-fee-markets))

The 2024 congestion episode is the cautionary tale: in late March–early April 2024, non-vote transaction **failure rates peaked near 75%**, driven by a QUIC networking bottleneck in the Agave client that let spam crowd out legitimate traffic. Patches (v1.17.31) improved staked/unstaked packet handling and brought the peak down, but failure rates remained materially elevated for months. ([Cointelegraph](https://cointelegraph.com/news/solana-struggling-record-seventy-five-percent-trasnactions-fail-memecoin-mania), [The Block](https://www.theblock.co/post/286868/solana-network-congestion)) By early 2025 the network was far healthier — median confirmation ~450 ms, ~100% uptime for over a year — but the *failure modes never went away*; they are dormant until the next demand spike. ([Helius — Agave v2.1](https://www.helius.dev/blog/agave-v21-update-all-you-need-to-know))

> **Implication for the SDK:** reliability cannot be "best effort." It has to be engineered around each of these four facts explicitly. That is what "systems-grade" means here, and it maps directly to the 40%-weighted *Correctness* and 25%-weighted *Resilience* judging criteria.

---

## 3. The pain-point catalog

Each pain below is rated by **severity**, **who it affects**, and backed by current sources.

### 3.1 Transactions silently dropped (no error, no trace)

A successful `sendTransaction` response only means the RPC node *received* the transaction — not that it will land. ([Solana docs — Retry](https://solana.com/developers/guides/advanced/retry)) Transactions die from: QUIC/UDP packet loss with no delivery guarantee; the leader's `tpu_forwards` path being single-hop and volume-bounded under load; the RPC node dropping new submissions once its rebroadcast queue exceeds **10,000**; or a blockhash that lived only on an abandoned minority fork. This is the single most damaging UX problem on Solana because it is *silent*.

- **Severity:** High · **Affects:** end users, dApp devs · **Source:** [Solana — Retry](https://solana.com/developers/guides/advanced/retry)

### 3.2 Blockhash expiry and commitment-level traps

`getLatestBlockhash` defaults to `finalized`, which trails `confirmed` by ≥32 slots — effectively shaving ~13 seconds off the validity window before the user has even signed. Use `processed` for a longer window and you risk a blockhash from a fork (~5% of blocks never finalize) that can never confirm. The official sweet spot is `confirmed`, and the `preflightCommitment` must match the blockhash commitment or you get spurious "Blockhash not found" errors. ([Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation)) A subtle but expensive trap: **re-signing a transaction before its blockhash expires can cause both copies to land, double-charging the user** — safe re-signing only happens after block height passes `lastValidBlockHeight`. ([Solana — Retry](https://solana.com/developers/guides/advanced/retry))

- **Severity:** High · **Affects:** end users, dApp devs · **Source:** [Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation)

### 3.3 RPC rate limiting (HTTP 429) and credit exhaustion

The public mainnet endpoint allows only ~100 requests / 10 s per IP (40 / 10 s per method) and is explicitly "not intended for production." ([Solana — Clusters](https://solana.com/docs/references/clusters)) A 429 is a *gateway* error from the provider's load balancer — the request never reached the chain, so developers often debug the wrong layer. ([Carbium](https://carbium.io/blog/fixing-429-too-many-requests-on-solana-why-rpcs-fail/)) Providers meter by **weighted credits**, where heavy methods like `getProgramAccounts` cost ~10× a `getBalance`, so a tight polling loop can exhaust a multi-million-credit quota in minutes. "Noisy neighbor" effects on shared nodes throttle you for *others'* traffic.

- **Severity:** High · **Affects:** any dApp on public/free/shared endpoints, indexers, bots · **Source:** [Carbium](https://carbium.io/blog/fixing-429-too-many-requests-on-solana-why-rpcs-fail/)

### 3.4 Node state inconsistency across an RPC pool

RPC nodes naturally lag the cluster (≥1 block, more under load), and a node only stops responding once it is **>150 slots behind** — meaning just below that threshold it still hands out blockhashes that are about to expire. The classic multi-RPC bug: fetch a fresh blockhash from an "advanced" node, submit to a "lagging" node that doesn't recognize it yet, and the transaction is silently dropped. Robust failover therefore **must health-check node freshness** (compare `getSlot` context across nodes) and pin blockhash-fetch + send to the same or freshness-verified node — this is not optional. ([Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation), [Solana — Retry](https://solana.com/developers/guides/advanced/retry))

- **Severity:** High · **Affects:** every multi-provider / load-balanced dApp · **Source:** [Solana — Confirmation](https://solana.com/developers/guides/advanced/confirmation)

### 3.5 Priority-fee and compute-unit estimation

Priority fee = **CU price × CU limit**, charged on the *requested* limit, not on CUs consumed. The default 200,000-CU-per-instruction budget is ~30× what a simple transfer (~6,000 CU) actually needs, so leaving defaults in place directly overpays — and priority fees are now **>97.5% of total transaction cost**. ([Anza](https://www.anza.xyz/blog/why-solana-transaction-costs-and-compute-units-matter-for-developers), [Helius — fees](https://www.helius.dev/blog/solana-fees-in-theory-and-practice)) Estimation is hard because the native `getRecentPrioritizationFees` is a backward-looking minimum over ~150 blocks, and local fee markets mean a network-wide number misses your specific hot account. Too low → dropped during congestion; too high or CU over-provisioned → overpayment. The canonical fix is **simulate to read `unitsConsumed`, pad ~10%, and pull account-aware percentile estimates** (Helius `getPriorityFeeEstimate`, QuickNode `qn_estimatePriorityFees`).

- **Severity:** High · **Affects:** all devs, wallets, traders · **Source:** [Anza](https://www.anza.xyz/blog/why-solana-transaction-costs-and-compute-units-matter-for-developers)

### 3.6 MEV / frontrunning and the Jito routing decision

Even without a public mempool, sandwiching is profitable: one bot ran ~1.55M sandwich transactions in 30 days for **~65,880 SOL (~$13.4M)**, per Helius's MEV report. Jito disabled its public mempool in March 2024, but MEV actors now run private mempools, so the threat persists — and memecoin traders with high slippage are the most exposed. ([Helius — MEV report](https://www.helius.dev/blog/solana-mev-report), [CoinDesk](https://www.coindesk.com/business/2024/03/08/solana-client-developer-jito-announces-end-of-mempool-function)) Jito bundles (≤5 txs, atomic, tip-gated) provide MEV/revert protection and now matter enormously: **>90% of Solana stake runs the Jito-Solana client.** ([Helius — MEV report](https://www.helius.dev/blog/solana-mev-report)) But a `bundle_id` is not a landing guarantee, Jito's default limit is 1 req/s/IP/region, and "uncle-bandit" rebroadcasts can break atomicity — so any Jito integration **needs dynamic tip sizing (`tip_floor` percentiles), status polling, and automatic fallback to normal RPC.**

- **Severity:** High · **Affects:** DEX/memecoin swappers, arbitrage/liquidation bots · **Source:** [Helius — MEV report](https://www.helius.dev/blog/solana-mev-report), [Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)

### 3.7 Observability blind spot

The metrics that matter — error rate, slot lag, confirmation latency, landing success, WebSocket reconnects, per-method latency distributions — are re-implemented by hand at every team, because neither `@solana/web3.js` nor `@solana/kit` emits structured client-side telemetry. OpenTelemetry has generic JSON-RPC semantic conventions and Datadog ingests OTLP, but **no Solana-specific OTel exporter or auto-instrumentation library exists**. The worst part: RPC degradation usually shows up as *silent* failure (a signature that never lands), which provider dashboards and server-side monitoring don't catch.

- **Severity:** High (this is the core diagnostics white space) · **Affects:** dApp infra/frontend engineers, wallets · **Source:** [Solana RPC observability (practitioner)](https://yavorovych.medium.com/solana-rpc-observability-what-i-actually-monitor-in-production-ebdf52a70243), [OTel JSON-RPC conventions](https://opentelemetry.io/docs/specs/semconv/rpc/json-rpc/)

---

## 4. Prior-art landscape — and the white space

| Tool / layer | What it solves | Where it falls short |
|---|---|---|
| **`@solana/kit` (web3.js v2)** | Composable transports; better confirmation primitives; tree-shakable | Failover / round-robin / retry shipped only as **DIY recipes**; no Jito routing, no health-aware multi-RPC, no telemetry ([kit README](https://github.com/anza-xyz/kit)) |
| **Helius SDK** (`sendSmartTransaction`, staked send) | Excellent landing via staked connections + priority-fee API | **Provider lock-in** — needs Helius key + Helius RPC ([helius-sdk](https://github.com/helius-labs/helius-sdk)) |
| **QuickNode / Triton** add-ons | Smart routing, staked send, bundle simulation | Server-side / gateway-bound; lock-in; don't unify across providers |
| **Jito** (bundles, low-latency send) | MEV protection, atomicity, tips | A provider service; `bundle_id` ≠ landing; needs fallback + tip logic the dev must build ([Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)) |
| **`@solana/wallet-adapter`** | Wallet connect / sign / send handoff | **No resilience** — failover/retry/confirmation are explicitly the app's job |
| **OSS multi-RPC libs** (`solana-fallback-connection`, AurFlow) | Thin failover wrapper / infra load balancer | Narrow; none combine retry + confirmation + Jito + observability ([npm](https://www.npmjs.com/package/solana-fallback-connection)) |
| **OTel / Datadog** | Generic JSON-RPC spans, OTLP ingest | **No Solana-specific client instrumentation exists** |

**Conclusion — the gap we can own:** a *vendor-neutral, client-side, systems-grade* SDK that unifies, behind one clean API on top of `@solana/kit`: (1) health-/freshness-aware multi-RPC failover and hedging; (2) correct retry/rebroadcast bounded by `lastValidBlockHeight` with safe (non-double-charging) resend; (3) simulate-based CU sizing + account-aware dynamic fee estimation (pluggable across Helius/QuickNode/native); (4) Jito/MEV routing with dynamic tips and automatic RPC fallback; (5) standardized OTel/Datadog client telemetry and a diagnostics CLI. No single existing tool does all of this without lock-in.

---

## 5. How the SDK addresses each pain (mapped to bounty scope)

| Bounty scope item | Pain it answers (§) | SDK design response |
|---|---|---|
| **web3.js v2.0 / kit compatibility** | foundation | Build natively on `@solana/kit`'s composable `RpcTransport`; ship the resilience layer kit deliberately omits |
| **Wallet adapter integration** | 3.1, 3.6 | Plug-and-play adapter so wallet-signed txs flow through the resilience + Jito pipeline (wallet-adapter provides none of this) |
| **MEV relay routing + automatic RPC fallback** | 3.6 | Route via Jito (region-pinned), poll `getInflightBundleStatuses`, fall back to normal `sendTransaction` before blockhash expiry; dynamic tips from `tip_floor` percentiles |
| **Dynamic external fee estimates** | 3.5 | Pluggable fee oracle (Helius/QuickNode/native percentile) + simulate-then-pad CU sizing |
| **Intelligent traffic distribution across healthy nodes** | 3.3, 3.4 | Freshness-aware routing (compare `getSlot` context), weighted/hedged requests, credit-aware (method-weighted) rate limiting to avoid 429s |
| **Export RPC metrics to OpenTelemetry / Datadog** | 3.7 | First-class OTel instrumentation: latency, failures, slot lag, landing success — the missing Solana client telemetry |
| **Real-time RPC health & tx-status monitoring** | 3.1, 3.4, 3.7 | Live health monitor + diagnostics surfacing silent drops |
| **Diagnostics CLI** | 3.1–3.7 | CLI to probe provider health, simulate failures, and explain why a tx didn't land |
| **90%+ coverage via network drop/latency simulation** | all | Deterministic fault-injection harness (drop, lag, 429, fork, blockhash-expiry) as the test backbone |

---

## 6. Mapping to the judging criteria

- **Correctness (40%).** The win condition is getting the *subtle* mechanics exactly right where most submissions won't: `confirmed`-commitment blockhash + matching `preflightCommitment`; `maxRetries: 0` + custom rebroadcast bounded by `lastValidBlockHeight`; never re-sign before expiry (no double-charge); pin blockhash+send to a freshness-verified node. Each is documented and testable.
- **Resilience quality (25%).** Directly addressed by health-aware failover, hedged requests, credit-aware rate limiting, and Jito-with-fallback — and *proven* under the simulation harness rather than asserted.
- **Developer experience (20%).** The differentiator vs. provider SDKs is **vendor neutrality + one clean API**: a developer adds the resilience layer without rewriting around a single provider, and gets telemetry for free.
- **Test & simulation quality (15%).** The fault-injection harness (drop/latency/429/fork/expiry) is both the path to 90% coverage *and* the evidence for the Correctness and Resilience scores — it does double duty.

> Strategic note: because Correctness + Resilience are 65% of the score, the highest-leverage engineering is the **transaction sender + confirmation state machine** and the **fault-injection test harness** — not feature breadth. Build those to a professional standard first.

---

## 7. Recommended next step

Proceed to architecture design and a phased build plan that sequences the modules by judging leverage: (1) kit-based RPC client with freshness-aware failover + telemetry hooks; (2) transaction sender/confirmation state machine with correct retry semantics; (3) fee/CU estimation; (4) Jito routing + fallback; (5) wallet adapter; (6) observability exporters + diagnostics CLI; (7) the simulation harness threaded throughout to hit 90% coverage. Each ships with simulation tests so Correctness and Resilience are demonstrable, not claimed.

---

## Sources

**Transaction landing & architecture**
- [Solana — Retrying Transactions](https://solana.com/developers/guides/advanced/retry)
- [Solana — Transaction Confirmation & Expiration](https://solana.com/developers/guides/advanced/confirmation)
- [Helius — How to Land Transactions on Solana](https://www.helius.dev/blog/how-to-land-transactions-on-solana)
- [Helius — Stake-Weighted QoS](https://www.helius.dev/blog/stake-weighted-quality-of-service-everything-you-need-to-know)
- [Helius — Agave v2.1 Update](https://www.helius.dev/blog/agave-v21-update-all-you-need-to-know)
- [Cointelegraph — 75% of Solana transactions failing (Apr 2024)](https://cointelegraph.com/news/solana-struggling-record-seventy-five-percent-trasnactions-fail-memecoin-mania)
- [The Block — Solana network congestion](https://www.theblock.co/post/286868/solana-network-congestion)

**RPC layer**
- [Solana — Clusters / public endpoints](https://solana.com/docs/references/clusters)
- [Carbium — Fixing 429 Too Many Requests on Solana](https://carbium.io/blog/fixing-429-too-many-requests-on-solana-why-rpcs-fail/)
- [Chainstack — Multiple RPC endpoints](https://docs.chainstack.com/docs/solana-how-to-use-multiple-rpc-endpoints-optimize-dapp-performance)
- [QuickNode — Best Solana RPC Providers 2026](https://blog.quicknode.com/best-solana-rpc-providers-2026/)
- [QuickNode — web3.js 2.0 transport](https://blog.quicknode.com/solana-web3-js-2-0-a-new-chapter-in-solana-development/)

**Fees & compute units**
- [Anza — Why transaction costs and compute units matter](https://www.anza.xyz/blog/why-solana-transaction-costs-and-compute-units-matter-for-developers)
- [Helius — Solana Fees in Theory and Practice](https://www.helius.dev/blog/solana-fees-in-theory-and-practice)
- [Helius — getPriorityFeeEstimate](https://helius.mintlify.app/api-reference/priority-fee/getpriorityfeeestimate)
- [QuickNode — qn_estimatePriorityFees](https://www.quicknode.com/docs/solana/qn_estimatePriorityFees)
- [Helius — Local fee markets](https://www.helius.dev/blog/solana-local-fee-markets)

**MEV & Jito**
- [Jito — Low Latency Transaction Send](https://docs.jito.wtf/lowlatencytxnsend/)
- [Helius — Solana MEV Report](https://www.helius.dev/blog/solana-mev-report)
- [CoinDesk — Jito ends mempool function](https://www.coindesk.com/business/2024/03/08/solana-client-developer-jito-announces-end-of-mempool-function)
- [Solana — MEV Protection with jitodontfront](https://solana.com/developers/guides/advanced/mev-protection)
- [QuickNode — Jito Bundles](https://www.quicknode.com/guides/solana-development/transactions/jito-bundles)

**Observability & prior art**
- [Solana RPC observability in production (practitioner)](https://yavorovych.medium.com/solana-rpc-observability-what-i-actually-monitor-in-production-ebdf52a70243)
- [OpenTelemetry — JSON-RPC semantic conventions](https://opentelemetry.io/docs/specs/semconv/rpc/json-rpc/)
- [Datadog — What is OpenTelemetry](https://www.datadoghq.com/knowledge-center/opentelemetry/)
- [anza-xyz/kit (GitHub README)](https://github.com/anza-xyz/kit)
- [helius-labs/helius-sdk (GitHub)](https://github.com/helius-labs/helius-sdk)
- [solana-fallback-connection (npm)](https://www.npmjs.com/package/solana-fallback-connection)
- [Triton — Intro to the new Solana Kit](https://blog.triton.one/intro-to-the-new-solana-kit-formerly-web3-js-2/)

*Caveats on figures: the ~75% April-2024 peak failure rate and the ~39% average come from different measurement windows and are not directly comparable; the >90% Jito-Solana stake share and the ~$13.4M/30-day sandwich figure are point-in-time statistics from the Helius MEV report. Treat all as directional, not exact.*
