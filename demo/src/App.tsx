import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Lab,
  type EndpointView,
  type LabState,
  type LogLine,
  type MetricsView,
  type PipelineStep,
  type Scenario,
} from "./lab";

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "healthy", label: "healthy" },
  { id: "drop", label: "drop" },
  { id: "429", label: "429" },
  { id: "lag", label: "lag" },
  { id: "jito-fail", label: "jito-fail" },
  { id: "congestion", label: "congestion" },
];

type Theme = "dark" | "light";

export function App() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const labRef = useRef<Lab | null>(null);
  if (labRef.current === null) labRef.current = new Lab(() => force());
  const lab = labRef.current;
  const state = lab.getState();

  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.getAttribute("data-theme") as Theme) ?? "dark",
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <h1>RPC Resilience Lab</h1>
          <span className="tag">solana-resilience-kit · live</span>
        </div>
        <div className="topbar-right">
          <Clock slot={state.slot} />
          <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "◐ light" : "◑ dark"}
          </button>
        </div>
      </header>

      <p className="intro">
        The real SDK runs in your browser against a deterministic Solana simulator — no backend, no
        network. Inject faults into the mock endpoints, then <code>Send transaction</code> to watch{" "}
        <code>ResilientRpcPool</code>, <code>TransactionSender</code>, and <code>JitoRouter</code>{" "}
        route, fail over, rebroadcast, and confirm. Telemetry below is read straight from{" "}
        <code>InMemoryMetrics</code>.
      </p>

      <ControlDeck lab={lab} state={state} />

      <div className="grid">
        <div className="col">
          <section className="card">
            <header>
              <h2>Endpoints</h2>
              <span className="meta">block {state.blockHeight.toLocaleString()}</span>
            </header>
            <div className="card-body">
              <div className="endpoints">
                {state.endpoints.map((ep) => (
                  <EndpointCard key={ep.name} ep={ep} />
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <header>
              <h2>Pipeline</h2>
              <span className="meta">{state.running ? "running…" : "idle"}</span>
            </header>
            <div className="card-body">
              <Pipeline steps={state.steps} />
            </div>
          </section>
        </div>

        <div className="col">
          <section className="card">
            <header>
              <h2>Metrics</h2>
              <span className="meta">cumulative</span>
            </header>
            <div className="card-body">
              <MetricsPanel m={state.metrics} />
            </div>
          </section>

          <section className="card">
            <header>
              <h2>Event log</h2>
              <span className="meta">{state.log.length} lines</span>
            </header>
            <EventLog log={state.log} />
          </section>
        </div>
      </div>

      <footer className="footer">
        <span>real SDK · real harness · deterministic fault injection</span>
        <a href="https://github.com/mihailShumilov/solana-rpc-sdk" target="_blank" rel="noreferrer">
          github.com/mihailShumilov/solana-rpc-sdk
        </a>
      </footer>
    </div>
  );
}

function ControlDeck({ lab, state }: { lab: Lab; state: LabState }) {
  const busy = state.running;
  return (
    <div className="deck">
      <div className="field">
        <label>Fault scenario</label>
        <div className="scenarios">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              className="chip mono"
              data-active={state.scenario === s.id}
              disabled={busy}
              onClick={() => void lab.applyScenario(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Route</label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={state.viaJito}
            disabled={busy}
            onChange={(e) => lab.setViaJito(e.target.checked)}
          />
          via Jito
        </label>
      </div>

      <div className="field">
        <label>Tick speed</label>
        <div className="speed">
          <input
            type="range"
            min={60}
            max={600}
            step={20}
            defaultValue={220}
            onChange={(e) => lab.setSpeed(Number(e.target.value))}
          />
          <span className="val">{lab.speedMs}ms/slot</span>
        </div>
      </div>

      <div className="deck-actions">
        <button className="btn-ghost mono" disabled={busy} onClick={() => lab.reset()}>
          reset
        </button>
        <button className="btn-send" disabled={busy} onClick={() => void lab.send()}>
          {busy ? "Sending…" : "Send transaction"}
        </button>
      </div>
    </div>
  );
}

function EndpointCard({ ep }: { ep: EndpointView }) {
  return (
    <div className="ep" data-state={ep.state}>
      {ep.routing && <span className="routing">routing</span>}
      <div className="ep-top">
        <span className="ep-name">{ep.name}</span>
        <span className="ep-state">{ep.state}</span>
      </div>
      <div className="ep-readout">
        <div className="ro">
          <span>slot</span>
          <b>{ep.slot === null ? "—" : ep.slot.toLocaleString()}</b>
        </div>
        <div className="ro">
          <span>latency</span>
          <b>{ep.latencyMs > 0 ? `${ep.latencyMs}ms` : "—"}</b>
        </div>
        <div className="ro">
          <span>fails</span>
          <b>{ep.consecutiveFailures}</b>
        </div>
        <div className="ro">
          <span>signal</span>
          <b>{ep.state === "healthy" ? "nominal" : ep.state === "degraded" ? "degraded" : "down"}</b>
        </div>
      </div>
      <div className="ep-faults">
        {ep.faults.length === 0 ? (
          <span className="fault" style={{ color: "var(--faint)", background: "transparent" }}>
            no faults
          </span>
        ) : (
          ep.faults.map((f) => (
            <span key={f} className="fault">
              {f}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function Pipeline({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="pipe">
      {steps.map((s) => (
        <div key={s.id} className="pstep" data-status={s.status}>
          <span className="node" />
          <span className="label">{s.label}</span>
          {s.detail && <span className="detail">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function MetricsPanel({ m }: { m: MetricsView }) {
  const pct = Math.round(m.landingRate * 100);
  return (
    <>
      <div className="tiles">
        <div className="tile wide">
          <div className="k">landing rate</div>
          <div className="v accent">
            {pct}
            <small>% · {m.confirmed}/{m.landings || 0} confirmed</small>
          </div>
          <div className="bar">
            <i style={{ width: `${pct}%`, background: pct >= 80 ? "var(--accent)" : pct >= 50 ? "var(--amber)" : "var(--coral)" }} />
          </div>
        </div>
        <div className="tile">
          <div className="k">failovers</div>
          <div className="v">{m.failovers}</div>
        </div>
        <div className="tile">
          <div className="k">rebroadcasts</div>
          <div className="v">{m.rebroadcasts}</div>
        </div>
        <div className="tile">
          <div className="k">expired</div>
          <div className="v" style={{ color: m.expired > 0 ? "var(--coral)" : undefined }}>
            {m.expired}
          </div>
        </div>
        <div className="tile">
          <div className="k">rpc requests</div>
          <div className="v">{m.requests}</div>
        </div>
      </div>
    </>
  );
}

function EventLog({ log }: { log: LogLine[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  const lines = useMemo(() => log, [log]);
  return (
    <div
      className="log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.map((l) => (
        <div key={l.id} className="log-line" data-kind={l.kind}>
          <span className="lt">{l.t}</span>
          <span className="lm">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}
