/**
 * lab.ts — the engine behind the RPC Resilience Lab.
 *
 * It runs the REAL SDK (ResilientRpcPool, TransactionSender, JitoRouter,
 * InMemoryMetrics) against the REAL simulation harness (MockCluster,
 * MockEndpoint, MockJitoEngine). Fault-injection scenarios mutate the mock
 * endpoints' fault profiles; "Send" drives an actual send/confirm pipeline.
 *
 * A single emitting `Metrics` sink is shared by the pool and sender so that
 * every request, rebroadcast, and landing both accumulates in InMemoryMetrics
 * and streams into the live event log / pipeline stepper.
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
  MockCluster,
  MockEndpoint,
  MockJitoEngine,
  type EndpointFaultProfile,
} from "../../test/harness/index.js";

export type Scenario = "healthy" | "drop" | "429" | "lag" | "jito-fail" | "congestion";

export type StepStatus = "idle" | "active" | "done" | "failed" | "skipped";
export type StepId = "submit" | "route" | "bundle" | "broadcast" | "rebroadcast" | "confirm" | "outcome";

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
  landings: number;
  confirmed: number;
  expired: number;
  landingRate: number;
}

export type LogKind = "accent" | "info" | "good" | "warn" | "error" | "muted";
export interface LogLine {
  id: number;
  t: string;
  kind: LogKind;
  msg: string;
}

export interface LabState {
  scenario: Scenario;
  viaJito: boolean;
  running: boolean;
  slot: number;
  blockHeight: number;
  endpoints: EndpointView[];
  steps: PipelineStep[];
  metrics: MetricsView;
  log: LogLine[];
}

const ENDPOINT_NAMES = ["rpc-aurora", "rpc-borealis", "rpc-citadel"] as const;

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

const STEP_LABELS: Record<StepId, string> = {
  submit: "Submit",
  route: "Route",
  bundle: "Jito bundle",
  broadcast: "Broadcast",
  rebroadcast: "Rebroadcast",
  confirm: "Confirm",
  outcome: "Outcome",
};

const MAX_LOG = 200;

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function short(sig: string): string {
  return sig.length > 14 ? `${sig.slice(0, 8)}…${sig.slice(-4)}` : sig;
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

  private steps: PipelineStep[] = [];
  private log: LogLine[] = [];
  private logSeq = 0;
  private txSeq = 0;
  private failovers = 0;

  scenario: Scenario = "healthy";
  viaJito = false;
  jitoShouldFail = false;
  running = false;
  speedMs = 220;

  constructor(private readonly onUpdate: () => void) {
    this.reset();
  }

  /** Tear down and rebuild the whole SDK + harness stack (also clears metrics). */
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
    this.failovers = 0;
    this.scenario = "healthy";
    this.viaJito = false;
    this.jitoShouldFail = false;
    this.running = false;
    this.log = [];
    this.logSeq = 0;
    this.txSeq = 0;
    this.line("lab ready · 3 endpoints · scenario=healthy", "muted");
  }

  // ---- public state ------------------------------------------------------

  getState(): LabState {
    return {
      scenario: this.scenario,
      viaJito: this.viaJito,
      running: this.running,
      slot: Number(this.cluster.slot),
      blockHeight: Number(this.cluster.blockHeight),
      endpoints: this.endpointViews(),
      steps: this.steps,
      metrics: this.metricsView(),
      log: this.log,
    };
  }

  // ---- controls ----------------------------------------------------------

  async applyScenario(scenario: Scenario): Promise<void> {
    if (this.running) return;
    this.scenario = scenario;
    const faults = SCENARIO_FAULTS[scenario];
    this.endpoints.forEach((ep, i) => {
      ep.faults = { ...faults[i] };
    });
    this.jitoShouldFail = scenario === "jito-fail";
    if (scenario === "jito-fail") this.viaJito = true;
    this.line(`scenario → ${scenario.toUpperCase()}`, "accent");
    const summary = this.endpoints
      .map((ep) => `${ep.name}:[${faultLabels(ep.faults).join(",") || "ok"}]`)
      .join("  ");
    this.line(summary, "muted");
    await this.probe();
    this.onUpdate();
  }

  setViaJito(v: boolean): void {
    if (this.running) return;
    this.viaJito = v;
    this.onUpdate();
  }

  setSpeed(ms: number): void {
    this.speedMs = ms;
    this.onUpdate();
  }

  /** Lightweight read so the HealthMonitor (and the endpoint cards) reflect the
   * current faults without sending a transaction. */
  private async probe(): Promise<void> {
    try {
      await this.pool.rpc().getSlot().send();
    } catch {
      /* all endpoints unhealthy for a read — fine, cards still render */
    }
  }

  // ---- the pipeline ------------------------------------------------------

  async send(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.txSeq += 1;
    const viaJito = this.viaJito;
    const sig = `tx${String(this.txSeq).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
    this.steps = this.freshSteps(viaJito);
    this.onUpdate();

    this.line(`SEND #${this.txSeq} · ${short(sig)} · ${this.scenario}${viaJito ? " · via Jito" : ""}`, "accent");

    const startBH = this.cluster.blockHeight;
    const lastValidBlockHeight = startBH + 14n; // short validity window for a snappy demo
    this.mark("submit", "done");
    this.mark("route", "active");

    const sleep = async () => {
      this.cluster.advanceSlots(1);
      this.tick("confirm");
      this.onUpdate();
      await sleepReal(this.speedMs);
    };

    const sender = new TransactionSender(this.pool.rpc(), { sleep, metrics: this.sink });

    try {
      let outcome: "confirmed" | "expired";
      let route: "jito" | "rpc" | null = null;
      let rebroadcasts = 0;

      if (viaJito) {
        this.mark("bundle", "active");
        const engine = this.makeJitoClient();
        const router = new JitoRouter(engine, new TipEstimator(), sender, { sleep });
        this.line("submitting bundle to Block Engine…", "info");
        const res = await router.sendWithFallback({
          wireTransaction: sig,
          signature: sig,
          lastValidBlockHeight,
          maxBundlePolls: 4,
        });
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
      this.mark("broadcast", this.steps.find((s) => s.id === "broadcast")?.status === "skipped" ? "skipped" : "done");
      this.mark("confirm", "done");
      this.mark("outcome", outcome === "confirmed" ? "done" : "failed", `${outcome} · ${rebroadcasts} rebroadcast${rebroadcasts === 1 ? "" : "s"}`);
      this.line(
        `OUTCOME: ${outcome.toUpperCase()}${route ? ` (route=${route})` : ""} · ${rebroadcasts} rebroadcast${rebroadcasts === 1 ? "" : "s"}`,
        outcome === "confirmed" ? "good" : "error",
      );
    } catch (err) {
      this.mark("route", "failed");
      this.mark("outcome", "failed", "all endpoints failed");
      this.line(`FAILED: ${(err as Error)?.message ?? String(err)}`, "error");
    } finally {
      this.running = false;
      this.onUpdate();
    }
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
          if (!ok) {
            this.failovers += 1;
            this.line(`✗ broadcast via ${endpoint} failed → failover`, "warn");
          } else {
            this.line(`✓ broadcast via ${endpoint} · ${Math.round(latencyMs)}ms`, "info");
          }
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
    const ranked = health
      .filter((h) => h.healthy && h.slot !== null)
      .sort((a, b) => Number((b.slot ?? 0n) - (a.slot ?? 0n)));
    const freshest = ranked[0]?.name ?? null;

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
        routing: ep.name === freshest && state !== "down",
        faults: faultLabels(f),
      };
    });
  }

  private metricsView(): MetricsView {
    const m = this.metrics;
    const sendReqs = m.requests.filter((r) => r.method === "sendTransaction");
    const confirmed = m.landings.filter((l) => l.outcome === "confirmed").length;
    const expired = m.landings.filter((l) => l.outcome === "expired").length;
    const landings = confirmed + expired;
    return {
      requests: m.requests.length,
      failovers: sendReqs.filter((r) => !r.ok).length,
      rebroadcasts: m.rebroadcasts.length,
      landings,
      confirmed,
      expired,
      landingRate: landings === 0 ? 1 : confirmed / landings,
    };
  }

  // ---- step + log helpers ------------------------------------------------

  private freshSteps(viaJito = this.viaJito): PipelineStep[] {
    const ids: StepId[] = viaJito
      ? ["submit", "route", "bundle", "broadcast", "rebroadcast", "confirm", "outcome"]
      : ["submit", "route", "broadcast", "rebroadcast", "confirm", "outcome"];
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
      step.detail = id === "rebroadcast" ? `×${n}` : `slot ${Number(this.cluster.slot)}`;
    }
  }

  private line(msg: string, kind: LogKind = "info"): void {
    this.log = [...this.log, { id: this.logSeq++, t: ts(), kind, msg }].slice(-MAX_LOG);
  }
}
