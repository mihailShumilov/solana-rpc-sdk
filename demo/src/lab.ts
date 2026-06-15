/**
 * lab.ts — the engine behind the RPC Resilience Lab.
 *
 * Two networks:
 *  - "sim": the REAL SDK (ResilientRpcPool, TransactionSender, JitoRouter,
 *    InMemoryMetrics) against the REAL simulation harness (MockCluster,
 *    MockEndpoint, MockJitoEngine). Fault scenarios mutate the mocks.
 *  - "devnet": the same SDK against a real Solana devnet RPC. With a funded
 *    keypair it builds, signs, sends, and confirms a real transfer and exposes
 *    the explorer link.
 *
 * The "SDK enabled" toggle swaps the resilient pipeline for a naive baseline
 * (one endpoint, single broadcast, no failover / rebroadcast / fallback) so the
 * value of the kit is directly comparable.
 */
import {
  InMemoryMetrics,
  JitoRouter,
  ResilientRpcPool,
  TipEstimator,
  TransactionSender,
} from "../../src/index.js";
import type { Metrics } from "../../src/observability/metrics.js";
import type { JitoEngineClient } from "../../src/jito/router.js";
import {
  appendTransactionMessageInstruction,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  MockCluster,
  MockEndpoint,
  MockJitoEngine,
  type EndpointFaultProfile,
} from "../../test/harness/index.js";

export type Network = "sim" | "devnet";
export type Scenario = "healthy" | "drop" | "429" | "lag" | "jito-fail" | "congestion";

export type StepStatus = "idle" | "active" | "done" | "failed" | "skipped";
export type StepId = "submit" | "route" | "pin" | "bundle" | "broadcast" | "rebroadcast" | "confirm" | "outcome";

type Outcome = "confirmed" | "expired" | "failed";

export interface PipelineStep {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
}

export type EndpointState = "healthy" | "degraded" | "down";

export interface EndpointView {
  name: string;
  state: EndpointState;
  slot: number | null;
  latencyMs: number;
  consecutiveFailures: number;
  routing: boolean;
  faults: string[];
}

export interface MetricsView {
  requests: number;
  failovers: number;
  rebroadcasts: number;
  expired: number;
}

export interface Tally {
  confirmed: number;
  total: number;
  rate: number;
}

export interface ScenarioInfo {
  id: Scenario;
  fault: string;
  without: string;
  withKit: string;
}

export interface DevnetView {
  hasKey: boolean;
  address: string | null;
  balanceSol: number | null;
  loadingBalance: boolean;
  keyError: string | null;
  lastSignature: string | null;
  explorerUrl: string | null;
}

export type LogKind = "accent" | "info" | "good" | "warn" | "error" | "muted";
export interface LogLine {
  id: number;
  t: string;
  kind: LogKind;
  msg: string;
}

export interface LabState {
  network: Network;
  scenario: Scenario;
  viaJito: boolean;
  sdkEnabled: boolean;
  running: boolean;
  slot: number;
  blockHeight: number;
  endpoints: EndpointView[];
  steps: PipelineStep[];
  metrics: MetricsView;
  info: ScenarioInfo;
  comparison: { sdk: Tally; naive: Tally };
  devnet: DevnetView;
  log: LogLine[];
}

const ENDPOINT_NAMES = ["rpc-aurora", "rpc-borealis", "rpc-citadel"] as const;
const DEVNET_URL = "https://api.devnet.solana.com";
const STORAGE_KEY = "rpc-lab-devnet-key";
const TRANSFER_LAMPORTS = 100_000n; // 0.0001 SOL self-transfer

const SCENARIO_FAULTS: Record<Scenario, EndpointFaultProfile[]> = {
  healthy: [{}, {}, {}],
  drop: [{ dropRate: 1 }, { dropRate: 1 }, { dropRate: 1 }],
  "429": [{ rate429Rate: 1 }, {}, {}],
  lag: [{ slotLag: 420 }, {}, {}],
  "jito-fail": [{}, {}, {}],
  congestion: [
    { latencyMs: [220, 640], rate429Rate: 0.6 },
    { latencyMs: [220, 640], dropRate: 0.4 },
    { latencyMs: [140, 360] },
  ],
};

export const SCENARIO_INFO: Record<Scenario, ScenarioInfo> = {
  healthy: {
    id: "healthy",
    fault: "All three endpoints are nominal and in sync.",
    without: "A single RPC works fine — there's nothing to recover from.",
    withKit: "The pool routes to the freshest healthy node and confirms by block height. Baseline behaviour.",
  },
  drop: {
    id: "drop",
    fault: "Every node silently drops the transaction — no error, no on-chain trace (Solana has no mempool).",
    without: "The one broadcast vanishes; a naive client polls a few times then gives up, or polls forever with no bound.",
    withKit: "TransactionSender rebroadcasts the SAME signed bytes (never re-signs → no double-charge) and bounds the loop by lastValidBlockHeight, returning a clean expired. Even the kit can't beat a 100% drop — but it fails safely and predictably.",
  },
  "429": {
    id: "429",
    fault: "The primary node rate-limits every request with HTTP 429.",
    without: "Pinned to that node, the send hard-fails — the user sees an error and the transaction never goes out.",
    withKit: "The health-aware pool (with CreditRateLimiter) detects the 429 and fails over to a healthy node → confirmed.",
  },
  lag: {
    id: "lag",
    fault: "The primary node is 420 slots behind the cluster (a stale/lagging RPC).",
    without: "A naive client may fetch a blockhash from — or send to — the stale node, risking a silently dropped transaction.",
    withKit: "HealthMonitor ranks endpoints by slot freshness, flags the laggard, and routes to an up-to-date node (see the degraded card).",
  },
  "jito-fail": {
    id: "jito-fail",
    fault: "The Jito bundle never lands. A bundle_id is only a receipt, not a landing guarantee.",
    without: "With no fallback, the transaction is stuck and expires.",
    withKit: "JitoRouter polls the bundle, then automatically falls back to normal RPC submission → confirmed.",
  },
  congestion: {
    id: "congestion",
    fault: "High, variable latency plus partial drops and 429s across all nodes (a demand spike).",
    without: "A single best-effort shot is likely to fail under load.",
    withKit: "Failover plus a bounded rebroadcast loop ride out the congestion → usually confirmed.",
  },
};

const STEP_LABELS: Record<StepId, string> = {
  submit: "Submit",
  route: "Route & failover",
  pin: "Pin 1 endpoint",
  bundle: "Jito bundle",
  broadcast: "Broadcast",
  rebroadcast: "Rebroadcast",
  confirm: "Confirm",
  outcome: "Outcome",
};

const MAX_LOG = 200;
const NAIVE_POLLS = 8;

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function short(sig: string): string {
  return sig.length > 14 ? `${sig.slice(0, 8)}…${sig.slice(-4)}` : sig;
}

function errMsg(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function faultLabels(f: EndpointFaultProfile): string[] {
  const out: string[] = [];
  if (f.offline) out.push("offline");
  if (f.dropRate) out.push(f.dropRate >= 1 ? "drop" : `drop ${Math.round(f.dropRate * 100)}%`);
  if (f.rate429Rate) out.push(f.rate429Rate >= 1 ? "429" : `429 ${Math.round(f.rate429Rate * 100)}%`);
  if (f.errorRate) out.push(`err ${Math.round(f.errorRate * 100)}%`);
  if (f.slotLag) out.push(`lag ${f.slotLag}`);
  if (f.latencyMs) out.push(Array.isArray(f.latencyMs) ? `lat ${f.latencyMs[0]}-${f.latencyMs[1]}ms` : `lat ${f.latencyMs}ms`);
  return out;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Lab {
  private cluster!: MockCluster;
  private endpoints!: MockEndpoint[];
  private metrics!: InMemoryMetrics;
  private sink!: Metrics;
  private pool!: ResilientRpcPool;
  private devnetPool: ResilientRpcPool | null = null;

  private steps: PipelineStep[] = [];
  private log: LogLine[] = [];
  private logSeq = 0;
  private txSeq = 0;
  private tally = { sdk: { confirmed: 0, total: 0 }, naive: { confirmed: 0, total: 0 } };

  // devnet
  private signer: KeyPairSigner | null = null;
  private devnetAddress: string | null = null;
  private balanceSol: number | null = null;
  private loadingBalance = false;
  private keyError: string | null = null;
  private lastSignature: string | null = null;

  network: Network = "sim";
  scenario: Scenario = "healthy";
  viaJito = false;
  sdkEnabled = true;
  jitoShouldFail = false;
  running = false;
  speedMs = 220;

  constructor(private readonly onUpdate: () => void) {
    this.reset();
    void this.restoreKey();
  }

  /** Tear down and rebuild the SDK + harness stack (also clears metrics). */
  reset(): void {
    this.cluster = new MockCluster({ initialSlot: 318_244_000n, initialBlockHeight: 318_244_000n });
    this.endpoints = ENDPOINT_NAMES.map((name, i) => new MockEndpoint(this.cluster, { name, rngSeed: 0xc0ffee + i }));
    this.metrics = new InMemoryMetrics();
    this.sink = this.makeSink();
    this.pool = new ResilientRpcPool({
      endpoints: this.endpoints.map((e) => ({ name: e.name, transport: e.transport })),
      metrics: this.sink,
    });
    this.steps = this.freshSteps();
    this.scenario = "healthy";
    this.viaJito = false;
    this.sdkEnabled = true;
    this.jitoShouldFail = false;
    this.running = false;
    this.tally = { sdk: { confirmed: 0, total: 0 }, naive: { confirmed: 0, total: 0 } };
    this.lastSignature = null;
    this.log = [];
    this.logSeq = 0;
    this.txSeq = 0;
    this.line(`lab ready · ${this.network === "devnet" ? "devnet" : "3 mock endpoints · scenario=healthy"} · SDK on`, "muted");
  }

  // ---- public state ------------------------------------------------------

  getState(): LabState {
    return {
      network: this.network,
      scenario: this.scenario,
      viaJito: this.viaJito,
      sdkEnabled: this.sdkEnabled,
      running: this.running,
      slot: Number(this.cluster.slot),
      blockHeight: Number(this.cluster.blockHeight),
      endpoints: this.endpointViews(),
      steps: this.steps,
      metrics: this.metricsView(),
      info: SCENARIO_INFO[this.scenario],
      comparison: { sdk: this.toTally(this.tally.sdk), naive: this.toTally(this.tally.naive) },
      devnet: {
        hasKey: this.signer !== null,
        address: this.devnetAddress,
        balanceSol: this.balanceSol,
        loadingBalance: this.loadingBalance,
        keyError: this.keyError,
        lastSignature: this.lastSignature,
        explorerUrl: this.lastSignature ? explorerTx(this.lastSignature) : null,
      },
      log: this.log,
    };
  }

  // ---- controls ----------------------------------------------------------

  setNetwork(network: Network): void {
    if (this.running || this.network === network) return;
    this.network = network;
    this.steps = this.freshSteps(false, !this.sdkEnabled);
    this.line(network === "devnet" ? "network → DEVNET (real transactions)" : "network → SIMULATION", "accent");
    if (network === "devnet") {
      this.viaJito = false;
      this.ensureDevnetPool();
      void this.refreshBalance();
    }
    this.onUpdate();
  }

  async applyScenario(scenario: Scenario): Promise<void> {
    if (this.running || this.network !== "sim") return;
    this.scenario = scenario;
    const faults = SCENARIO_FAULTS[scenario];
    this.endpoints.forEach((ep, i) => {
      ep.faults = { ...faults[i] };
    });
    this.jitoShouldFail = scenario === "jito-fail";
    this.viaJito = scenario === "jito-fail"; // jito-fail implies the Jito route; others reset it
    this.line(`scenario → ${scenario.toUpperCase()}`, "accent");
    this.line(this.endpoints.map((ep) => `${ep.name}:[${faultLabels(ep.faults).join(",") || "ok"}]`).join("  "), "muted");
    await this.probe();
    this.onUpdate();
  }

  setViaJito(v: boolean): void {
    if (this.running || this.network !== "sim") return;
    this.viaJito = v;
    this.onUpdate();
  }

  setSdkEnabled(v: boolean): void {
    if (this.running) return;
    this.sdkEnabled = v;
    this.line(v ? "SDK ENABLED · resilient pipeline" : "SDK BYPASSED · naive baseline (1 endpoint, no failover/rebroadcast/fallback)", v ? "good" : "warn");
    this.onUpdate();
  }

  setSpeed(ms: number): void {
    this.speedMs = ms;
    this.onUpdate();
  }

  private async probe(): Promise<void> {
    try {
      await this.pool.rpc().getSlot().send();
    } catch {
      /* all endpoints unhealthy for a read — fine */
    }
  }

  // ---- devnet key management --------------------------------------------

  private async restoreKey(): Promise<void> {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;
      await this.useSecretBytes(Uint8Array.from(JSON.parse(raw) as number[]), false);
    } catch {
      /* ignore a bad stored key */
    }
  }

  async setSecretKey(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    let bytes: Uint8Array;
    try {
      const arr = JSON.parse(trimmed) as number[];
      if (!Array.isArray(arr) || arr.length !== 64) throw new Error("expected a JSON array of 64 bytes");
      bytes = Uint8Array.from(arr);
    } catch (e) {
      this.keyError = `invalid key: ${errMsg(e)}`;
      this.onUpdate();
      return;
    }
    await this.useSecretBytes(bytes, true);
  }

  async generateKeypair(): Promise<void> {
    try {
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
      const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const secret = new Uint8Array([...pkcs8.slice(-32), ...pub]); // 64-byte seed||pubkey
      await this.useSecretBytes(secret, true);
      this.line("generated a fresh devnet keypair — fund the address below, then send", "warn");
    } catch (e) {
      this.keyError = `generate failed (browser may lack WebCrypto Ed25519): ${errMsg(e)} — paste a key instead`;
      this.onUpdate();
    }
  }

  private async useSecretBytes(bytes: Uint8Array, persist: boolean): Promise<void> {
    try {
      const signer = await createKeyPairSignerFromBytes(bytes);
      this.signer = signer;
      this.devnetAddress = signer.address;
      this.keyError = null;
      if (persist) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Array.from(bytes)));
      this.line(`devnet key loaded · ${signer.address}`, "good");
      this.onUpdate();
      await this.refreshBalance();
    } catch (e) {
      this.keyError = `could not import key: ${errMsg(e)}`;
      this.onUpdate();
    }
  }

  clearKey(): void {
    this.signer = null;
    this.devnetAddress = null;
    this.balanceSol = null;
    this.keyError = null;
    globalThis.localStorage?.removeItem(STORAGE_KEY);
    this.line("devnet key cleared", "muted");
    this.onUpdate();
  }

  async refreshBalance(): Promise<void> {
    if (!this.signer) return;
    this.loadingBalance = true;
    this.onUpdate();
    try {
      const rpc = this.ensureDevnetPool().rpc();
      const { value } = await rpc.getBalance(this.signer.address).send();
      this.balanceSol = Number(value) / 1e9;
    } catch (e) {
      this.line(`balance check failed: ${errMsg(e)}`, "warn");
    } finally {
      this.loadingBalance = false;
      this.onUpdate();
    }
  }

  private ensureDevnetPool(): ResilientRpcPool {
    if (!this.devnetPool) {
      this.devnetPool = new ResilientRpcPool({
        endpoints: [{ name: "devnet", transport: createDefaultRpcTransport({ url: DEVNET_URL }) }],
        metrics: this.sink,
        freshnessAware: false,
      });
    }
    return this.devnetPool;
  }

  // ---- the pipeline ------------------------------------------------------

  async send(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.txSeq += 1;
    const sdk = this.sdkEnabled;
    const viaJito = this.network === "sim" && this.viaJito;
    this.steps = this.freshSteps(viaJito, !sdk);
    this.onUpdate();

    const sleep = async () => {
      if (this.network === "sim") this.cluster.advanceSlots(1);
      this.tick("confirm");
      this.onUpdate();
      await sleepReal(this.speedMs);
    };

    let outcome: Outcome = "failed";
    try {
      if (this.network === "devnet") {
        this.line(`SEND #${this.txSeq} · devnet · ${sdk ? "SDK" : "NO-SDK baseline"}`, "accent");
        this.mark("submit", "done");
        outcome = await this.runDevnet(sleep, sdk);
      } else {
        const sig = `tx${String(this.txSeq).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
        this.line(`SEND #${this.txSeq} · ${short(sig)} · ${this.scenario}${viaJito ? " · via Jito" : ""} · ${sdk ? "SDK" : "NO-SDK baseline"}`, "accent");
        this.mark("submit", "done");
        outcome = sdk
          ? await this.runSdk(sig, this.cluster.blockHeight + 14n, sleep, viaJito)
          : await this.runNaive(sig, sleep, viaJito);
      }
    } catch (err) {
      this.mark("outcome", "failed", "unhandled");
      this.line(`FAILED: ${errMsg(err)}`, "error");
      outcome = "failed";
    } finally {
      this.recordOutcome(sdk, outcome);
      this.running = false;
      this.onUpdate();
    }
  }

  /** Resilient simulation pipeline: pool routing + failover, sender rebroadcast,
   * Jito routing with RPC fallback. */
  private async runSdk(sig: string, lastValidBlockHeight: bigint, sleep: () => Promise<void>, viaJito: boolean): Promise<Outcome> {
    this.mark("route", "active");
    const sender = new TransactionSender(this.pool.rpc(), { sleep, metrics: this.sink });

    let outcome: Outcome;
    let route: "jito" | "rpc" | null = null;
    let rebroadcasts = 0;

    if (viaJito) {
      this.mark("bundle", "active");
      const router = new JitoRouter(this.makeJitoClient(), new TipEstimator(), sender, { sleep });
      this.line("submitting bundle to Block Engine…", "info");
      const res = await router.sendWithFallback({ wireTransaction: sig, signature: sig, lastValidBlockHeight, maxBundlePolls: 4 });
      route = res.route;
      outcome = res.outcome;
      rebroadcasts = res.rebroadcasts;
      if (route === "jito") {
        this.mark("bundle", "done", "landed");
        this.mark("broadcast", "skipped");
        this.mark("rebroadcast", "skipped");
        this.line("bundle landed via Jito", "good");
      } else {
        this.mark("bundle", "failed", "no land → fallback");
        this.line("bundle did not land → falling back to RPC", "warn");
      }
    } else {
      const res = await sender.sendAndConfirm({ wireTransaction: sig, signature: sig, lastValidBlockHeight });
      outcome = res.outcome;
      rebroadcasts = res.rebroadcasts;
    }

    this.mark("route", "done");
    if (this.stepStatus("broadcast") !== "skipped") this.mark("broadcast", "done");
    this.mark("confirm", "done");
    this.mark("outcome", outcome === "confirmed" ? "done" : "failed", `${outcome} · ${rebroadcasts} rebroadcast${rebroadcasts === 1 ? "" : "s"}`);
    this.line(`OUTCOME: ${outcome.toUpperCase()}${route ? ` (route=${route})` : ""} · ${rebroadcasts} rebroadcast${rebroadcasts === 1 ? "" : "s"}`, outcome === "confirmed" ? "good" : "error");
    return outcome;
  }

  /** The baseline a developer writes without the kit. */
  private async runNaive(sig: string, sleep: () => Promise<void>, viaJito: boolean): Promise<Outcome> {
    const endpoint = this.endpoints[0]!;
    this.line(`baseline: pinned to ${endpoint.name} · no pool, no failover, no rebroadcast`, "muted");
    const rpc = createSolanaRpcFromTransport(endpoint.transport);

    if (viaJito) {
      this.mark("bundle", "active");
      const jito = new MockJitoEngine({ defaultLandsAfterPolls: this.jitoShouldFail ? 99 : 1 });
      const id = jito.sendBundle([sig]);
      for (let i = 0; i < 4; i++) {
        if (jito.getInflightBundleStatuses([id])[0]?.status === "Landed") {
          this.mark("bundle", "done", "landed");
          this.mark("confirm", "done");
          this.mark("outcome", "done", "confirmed (jito)");
          this.line("bundle landed via Jito", "good");
          return "confirmed";
        }
        await sleep();
      }
      this.mark("bundle", "failed", "no land · no fallback");
      this.mark("outcome", "failed", "expired");
      this.line("bundle never landed · baseline has NO fallback → expired", "error");
      return "expired";
    }

    this.mark("pin", "done", endpoint.name);
    this.mark("broadcast", "active", "single shot");
    try {
      await rpc.sendTransaction(sig as unknown as Base64EncodedWireTransaction, { encoding: "base64" }).send();
      this.mark("broadcast", "done");
      this.line(`broadcast via ${endpoint.name} (single shot, no rebroadcast)`, "info");
    } catch (e) {
      this.mark("broadcast", "failed");
      this.mark("outcome", "failed", "transport error");
      this.line(`broadcast failed: ${errMsg(e)} · baseline has NO failover → giving up`, "error");
      return "failed";
    }

    for (let i = 0; i < NAIVE_POLLS; i++) {
      this.tick("confirm");
      this.onUpdate();
      let landed = false;
      try {
        const st = (await rpc.getSignatureStatuses([sig as unknown as Signature]).send()).value[0];
        landed = Boolean(st && st.confirmationStatus != null && st.err == null);
      } catch (e) {
        this.line(`status poll failed: ${errMsg(e)}`, "warn");
      }
      if (landed) {
        this.mark("confirm", "done");
        this.mark("outcome", "done", "confirmed");
        this.line("confirmed via single endpoint", "good");
        return "confirmed";
      }
      await sleep();
    }
    this.mark("confirm", "done");
    this.mark("outcome", "failed", `no confirmation in ${NAIVE_POLLS} polls`);
    this.line(`no confirmation after ${NAIVE_POLLS} polls · baseline gives up (no rebroadcast) → dropped`, "error");
    return "expired";
  }

  /** Build, sign, send and confirm a REAL transfer on devnet. */
  private async runDevnet(sleep: () => Promise<void>, sdk: boolean): Promise<Outcome> {
    if (!this.signer) {
      this.mark("outcome", "failed", "no key");
      this.line("load or generate a funded devnet keypair first", "error");
      return "failed";
    }
    if (this.balanceSol !== null && this.balanceSol <= 0) {
      this.mark("outcome", "failed", "unfunded");
      this.line(`${this.devnetAddress} has 0 SOL — fund it on devnet first`, "error");
      return "failed";
    }

    const signer = this.signer;
    const pool = this.ensureDevnetPool();
    const rpc = pool.rpc();
    this.mark(sdk ? "route" : "pin", "active");
    this.line("fetching recent blockhash from devnet…", "info");
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) =>
        appendTransactionMessageInstruction(
          getTransferSolInstruction({ source: signer, destination: signer.address, amount: lamports(TRANSFER_LAMPORTS) }),
          m,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    const wireTransaction = getBase64EncodedWireTransaction(signed);
    this.lastSignature = signature;
    this.mark(sdk ? "route" : "pin", "done");
    this.line(`signed self-transfer · ${short(signature)}`, "muted");

    let outcome: Outcome;
    if (sdk) {
      const sender = new TransactionSender(rpc, { sleep, metrics: this.sink });
      const res = await sender.sendAndConfirm({ wireTransaction, signature, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight });
      outcome = res.outcome;
      this.mark("broadcast", "done");
      this.mark("confirm", "done");
      this.mark("outcome", outcome === "confirmed" ? "done" : "failed", `${outcome} · ${res.rebroadcasts} rebroadcast${res.rebroadcasts === 1 ? "" : "s"}`);
    } else {
      const naiveRpc = createSolanaRpcFromTransport(createDefaultRpcTransport({ url: DEVNET_URL }));
      this.mark("broadcast", "active", "single shot");
      try {
        await naiveRpc.sendTransaction(wireTransaction, { encoding: "base64" }).send();
        this.mark("broadcast", "done");
        this.line("broadcast once (no rebroadcast)", "info");
      } catch (e) {
        this.mark("broadcast", "failed");
        this.mark("outcome", "failed", "transport error");
        this.line(`broadcast failed: ${errMsg(e)}`, "error");
        return "failed";
      }
      outcome = "expired";
      for (let i = 0; i < NAIVE_POLLS; i++) {
        this.tick("confirm");
        this.onUpdate();
        const st = (await naiveRpc.getSignatureStatuses([signature]).send()).value[0];
        if (st && st.confirmationStatus != null && st.err == null) {
          outcome = "confirmed";
          break;
        }
        await sleep();
      }
      this.mark("confirm", "done");
      this.mark("outcome", outcome === "confirmed" ? "done" : "failed", outcome);
    }

    if (outcome === "confirmed") {
      this.line(`CONFIRMED on devnet · ${short(signature)}`, "good");
      this.line(`explorer → ${explorerTx(signature)}`, "accent");
    } else {
      this.line(`OUTCOME: ${outcome}`, "error");
    }
    void this.refreshBalance();
    return outcome;
  }

  private recordOutcome(sdk: boolean, outcome: Outcome): void {
    const t = sdk ? this.tally.sdk : this.tally.naive;
    t.total += 1;
    if (outcome === "confirmed") t.confirmed += 1;
  }

  // ---- emitting metrics sink --------------------------------------------

  private makeSink(): Metrics {
    const inner = this.metrics;
    return {
      recordRequest: (endpoint, method, latencyMs, ok) => {
        inner.recordRequest(endpoint, method, latencyMs, ok);
        if (method === "sendTransaction") {
          if (this.stepStatus("route") === "active") this.mark("route", "done");
          this.mark("broadcast", "active");
          if (!ok) this.line(`✗ broadcast via ${endpoint} failed → failover`, "warn");
          else this.line(`✓ broadcast via ${endpoint} · ${Math.round(latencyMs)}ms`, "info");
        }
      },
      recordRateLimited: (endpoint) => {
        inner.recordRateLimited(endpoint);
        this.line(`429 rate-limited · ${endpoint}`, "error");
      },
      recordRebroadcast: (signature) => {
        inner.recordRebroadcast(signature);
        this.mark("broadcast", "done");
        this.tick("rebroadcast");
        this.line(`↻ rebroadcast · ${short(signature)}`, "muted");
      },
      recordLanding: (signature, landingOutcome, slots) => {
        inner.recordLanding(signature, landingOutcome, slots);
        this.line(`landing · ${landingOutcome} · ${short(signature)} · ${slots} slot${slots === 1 ? "" : "s"}`, landingOutcome === "confirmed" ? "good" : "error");
      },
      recordSlot: (endpoint, slot) => {
        inner.recordSlot(endpoint, slot);
      },
    };
  }

  private makeJitoClient(): JitoEngineClient {
    const jito = new MockJitoEngine({ defaultLandsAfterPolls: this.jitoShouldFail ? 99 : 1 });
    return {
      getTipAccounts: async () => jito.getTipAccounts(),
      sendBundle: async (sigs) => jito.sendBundle(sigs),
      getInflightBundleStatuses: async (ids) => jito.getInflightBundleStatuses(ids),
    };
  }

  // ---- view derivation ---------------------------------------------------

  private endpointViews(): EndpointView[] {
    const health = this.pool.health();
    const byName = new Map(health.map((h) => [h.name, h]));
    const ranked = health.filter((h) => h.healthy && h.slot !== null).sort((a, b) => Number((b.slot ?? 0n) - (a.slot ?? 0n)));
    const freshest = this.sdkEnabled ? ranked[0]?.name ?? null : this.endpoints[0]!.name;

    return this.endpoints.map((ep) => {
      const h = byName.get(ep.name);
      const f = ep.faults;
      const lag = f.slotLag ?? 0;
      const impaired = Boolean(f.dropRate || f.rate429Rate || f.errorRate || lag > 150);
      const state: EndpointState = f.offline ? "down" : impaired || h?.healthy === false ? "degraded" : "healthy";
      return {
        name: ep.name,
        state,
        slot: Number(this.cluster.slot) - lag,
        latencyMs: Math.round(h?.latencyMs ?? 0),
        consecutiveFailures: h?.consecutiveFailures ?? 0,
        routing: ep.name === freshest && (this.sdkEnabled ? state !== "down" : true),
        faults: faultLabels(f),
      };
    });
  }

  private metricsView(): MetricsView {
    const m = this.metrics;
    const sendReqs = m.requests.filter((r) => r.method === "sendTransaction");
    return {
      requests: m.requests.length,
      failovers: sendReqs.filter((r) => !r.ok).length,
      rebroadcasts: m.rebroadcasts.length,
      expired: m.landings.filter((l) => l.outcome === "expired").length,
    };
  }

  private toTally(t: { confirmed: number; total: number }): Tally {
    return { confirmed: t.confirmed, total: t.total, rate: t.total === 0 ? 0 : t.confirmed / t.total };
  }

  // ---- step + log helpers ------------------------------------------------

  private freshSteps(viaJito = this.viaJito, naive = !this.sdkEnabled): PipelineStep[] {
    let ids: StepId[];
    if (naive) {
      ids = viaJito ? ["submit", "bundle", "confirm", "outcome"] : ["submit", "pin", "broadcast", "confirm", "outcome"];
    } else {
      ids = viaJito
        ? ["submit", "route", "bundle", "broadcast", "rebroadcast", "confirm", "outcome"]
        : ["submit", "route", "broadcast", "rebroadcast", "confirm", "outcome"];
    }
    return ids.map((id) => ({ id, label: STEP_LABELS[id], status: "idle" as StepStatus }));
  }

  private stepStatus(id: StepId): StepStatus | undefined {
    return this.steps.find((s) => s.id === id)?.status;
  }

  private mark(id: StepId, status: StepStatus, detail?: string): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
  }

  private tick(id: StepId): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    if (step.status === "idle" || step.status === "active") {
      step.status = "active";
      const n = Number(step.detail?.replace(/\D/g, "") || 0) + 1;
      step.detail = id === "rebroadcast" ? `×${n}` : this.network === "sim" ? `slot ${Number(this.cluster.slot)}` : `poll ${n}`;
    }
  }

  private line(msg: string, kind: LogKind = "info"): void {
    this.log = [...this.log, { id: this.logSeq++, t: ts(), kind, msg }].slice(-MAX_LOG);
  }
}
