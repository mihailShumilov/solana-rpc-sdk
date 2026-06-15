import { useState } from "react";
import { EXAMPLES, type Example } from "./examples";
import type { ExampleResult } from "./examples/types";

/**
 * Docs & Examples — a cookbook of runnable recipes. Every card shows the real
 * source of an example (single source of truth: the same file is executed) with
 * a Copy button, and a Run button that calls its `run()` against the simulation
 * harness and renders the log + structured result. No backend, no network.
 */
export function Docs() {
  return (
    <>
      <p className="intro">
        A cookbook of <strong>runnable</strong> recipes. Each one is a single file that imports the{" "}
        <em>real</em> SDK from <code>solana-resilience-kit</code> and runs it against the in-memory
        simulation harness from <code>solana-resilience-kit/testing</code> — the code you read is exactly
        the code that runs. Hit <strong>Run ▶</strong> to execute it in your browser, or <strong>Copy</strong> it
        into your project. For full type signatures see the{" "}
        <a href="/api/" target="_blank" rel="noreferrer">
          API reference ↗
        </a>
        .
      </p>
      <div className="docs">
        {EXAMPLES.map((ex) => (
          <ExampleCard key={ex.id} ex={ex} />
        ))}
      </div>
    </>
  );
}

function ExampleCard({ ex }: { ex: Example }) {
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState<ExampleResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ex.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1300);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  const run = async () => {
    setRunning(true);
    setErr(null);
    setOut(null);
    try {
      // Defer one frame so the "running…" label paints before synchronous work.
      await new Promise((r) => setTimeout(r, 0));
      setOut(await ex.run());
    } catch (e) {
      setErr((e as Error)?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="card ex-card">
      <header>
        <h2>{ex.title}</h2>
        <span className="meta mono">{ex.tag}</span>
      </header>
      <div className="card-body ex-card-body">
        <p className="ex-desc">{ex.description}</p>

        <div className="code-wrap">
          <button className="copy-btn mono" onClick={() => void copy()}>
            {copied ? "copied ✓" : "copy"}
          </button>
          <pre className="code">
            <code>{ex.code}</code>
          </pre>
        </div>

        <div className="ex-run">
          <button className="btn-send" onClick={() => void run()} disabled={running}>
            {running ? "running…" : "Run ▶"}
          </button>
          <span className="ex-run-hint mono">runs against the simulation harness</span>
        </div>

        {err && <div className="run-err mono">✗ {err}</div>}
        {out && <RunOutput out={out} />}
      </div>
    </section>
  );
}

function RunOutput({ out }: { out: ExampleResult }) {
  return (
    <div className="run-out">
      <div className="run-log mono">
        {out.logs.map((line, i) => (
          <div key={i} className="run-log-line">
            <span className="run-arrow">›</span>
            {line}
          </div>
        ))}
      </div>
      <div className="run-result">
        {Object.entries(out.result).map(([k, v]) => (
          <div key={k} className="run-kv">
            <span className="run-k mono">{k}</span>
            <span className="run-v mono">{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
