/**
 * MockJitoEngine — a deterministic stand-in for the Jito Block Engine, covering
 * the surface the SDK's MEV router needs: tip accounts, tip-floor percentiles,
 * bundle submission, and in-flight status polling. Landing is poll-driven and
 * configurable so tests can force the "bundle never lands -> fall back to RPC"
 * path that the bounty's automatic-fallback requirement demands.
 */
export type BundleState = "Pending" | "Landed" | "Failed" | "Invalid";

const TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export interface MockJitoOptions {
  /** Poll cycles before a bundle reports Landed (default 1). */
  defaultLandsAfterPolls?: number;
  /** Requests allowed before a 429 (models 1 req/s/region). 0 = unlimited. */
  rateLimit?: number;
}

interface BundleRecord {
  id: string;
  remainingPolls: number;
  state: BundleState;
  neverLands: boolean;
}

export class MockJitoEngine {
  private readonly bundles = new Map<string, BundleRecord>();
  private readonly defaultLandsAfterPolls: number;
  private readonly rateLimit: number;
  private requestCount = 0;
  readonly stats = { bundlesSent: 0, rateLimited: 0 };
  /** Live tip-floor percentiles in lamports: [25th, 50th, 75th, 95th, 99th]. */
  tipFloorLamports: [number, number, number, number, number] = [
    1_000, 10_000, 100_000, 500_000, 1_000_000,
  ];

  constructor(opts: MockJitoOptions = {}) {
    this.defaultLandsAfterPolls = opts.defaultLandsAfterPolls ?? 1;
    this.rateLimit = opts.rateLimit ?? 0;
  }

  getTipAccounts(): string[] {
    return [...TIP_ACCOUNTS];
  }

  getTipFloor(): {
    landed_tips_25th_percentile: number;
    landed_tips_50th_percentile: number;
    landed_tips_75th_percentile: number;
    landed_tips_95th_percentile: number;
    landed_tips_99th_percentile: number;
  } {
    const [p25, p50, p75, p95, p99] = this.tipFloorLamports;
    const sol = (l: number) => l / 1e9;
    return {
      landed_tips_25th_percentile: sol(p25),
      landed_tips_50th_percentile: sol(p50),
      landed_tips_75th_percentile: sol(p75),
      landed_tips_95th_percentile: sol(p95),
      landed_tips_99th_percentile: sol(p99),
    };
  }

  /** Force the next bundle with this id to never land (drives fallback tests). */
  scheduleBundleNeverLands(id: string): void {
    const existing = this.bundles.get(id);
    if (existing) existing.neverLands = true;
    else
      this.bundles.set(id, {
        id,
        remainingPolls: Number.MAX_SAFE_INTEGER,
        state: "Pending",
        neverLands: true,
      });
  }

  sendBundle(signatures: string[]): string {
    if (this.rateLimit > 0 && this.requestCount >= this.rateLimit) {
      this.stats.rateLimited += 1;
      const err = new Error("HTTP 429: bundle rate limit exceeded") as Error & { statusCode: number };
      err.statusCode = 429;
      throw err;
    }
    this.requestCount += 1;
    this.stats.bundlesSent += 1;
    const id = bundleId(signatures);
    const existing = this.bundles.get(id);
    this.bundles.set(id, {
      id,
      remainingPolls: this.defaultLandsAfterPolls,
      state: "Pending",
      neverLands: existing?.neverLands ?? false,
    });
    return id;
  }

  getInflightBundleStatuses(ids: string[]): Array<{ bundle_id: string; status: BundleState }> {
    return ids.map((id) => {
      const b = this.bundles.get(id);
      if (!b) return { bundle_id: id, status: "Invalid" as BundleState };
      if (!b.neverLands && b.state === "Pending") {
        b.remainingPolls -= 1;
        if (b.remainingPolls <= 0) b.state = "Landed";
      }
      return { bundle_id: id, status: b.state };
    });
  }
}

/** Deterministic bundle id derived from member signatures (mirrors "hash of signatures"). */
export function bundleId(signatures: string[]): string {
  let h = 0x811c9dc5;
  const s = signatures.join(",");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `bundle_${h.toString(16).padStart(8, "0")}`;
}
