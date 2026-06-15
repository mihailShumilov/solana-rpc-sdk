/**
 * Shared shape every cookbook example returns. `logs` narrates what the SDK did,
 * in order; `result` is the structured outcome the example produced. The Docs
 * view renders both. Examples are the single source of truth — the same file is
 * executed (via `run`) and displayed (via `?raw`).
 */
export interface ExampleResult {
  /** Human-readable narration of what happened, in order. */
  logs: string[];
  /** Final structured result the SDK produced. */
  result: Record<string, string | number | boolean>;
}
