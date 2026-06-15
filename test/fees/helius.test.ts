/**
 * SPEC: HeliusFeeOracle calls Helius `getPriorityFeeEstimate` and maps its
 * `priorityFeeLevels` (already micro-lamports-per-CU, keyed by the same level
 * names) onto our PriorityFeeEstimate. fetch is injected, so the test is
 * deterministic and offline.
 */
import { describe, it, expect, vi } from "vitest";
import { HeliusFeeOracle } from "../../src/fees/oracles.js";

/** A capturing fetch stand-in whose Response.json() resolves to `body`. */
function fetchMock(body: unknown) {
  const mock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({ json: async () => body } as unknown as Response),
  );
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}

describe("HeliusFeeOracle.getPriorityFee", () => {
  it("maps Helius priorityFeeLevels onto our level scale", async () => {
    const { fetchImpl } = fetchMock({
      jsonrpc: "2.0",
      id: "1",
      result: {
        priorityFeeLevels: {
          min: 0,
          low: 1_000,
          medium: 10_000,
          high: 100_000,
          veryHigh: 1_000_000,
          unsafeMax: 5_000_000, // ignored — not one of our levels
        },
      },
    });
    const oracle = new HeliusFeeOracle({ url: "https://helius.test", fetchImpl });
    const est = await oracle.getPriorityFee(["Acct1"]);
    expect(est.levels).toEqual({
      min: 0,
      low: 1_000,
      medium: 10_000,
      high: 100_000,
      veryHigh: 1_000_000,
    });
  });

  it("POSTs getPriorityFeeEstimate with the writable accounts, all-levels option, and api key", async () => {
    const { mock, fetchImpl } = fetchMock({ result: { priorityFeeLevels: { medium: 5 } } });
    const oracle = new HeliusFeeOracle({ url: "https://helius.test", apiKey: "KEY123", fetchImpl });
    await oracle.getPriorityFee(["AcctA", "AcctB"]);

    const [url, init] = mock.mock.calls[0] ?? [];
    expect(url).toBe("https://helius.test?api-key=KEY123");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(String(init?.body)) as {
      method: string;
      params: Array<{ accountKeys: string[]; options: { includeAllPriorityFeeLevels: boolean } }>;
    };
    expect(sent.method).toBe("getPriorityFeeEstimate");
    expect(sent.params[0]?.accountKeys).toEqual(["AcctA", "AcctB"]);
    expect(sent.params[0]?.options.includeAllPriorityFeeLevels).toBe(true);
  });

  it("defaults missing levels to 0 when the response has no priorityFeeLevels", async () => {
    const { fetchImpl } = fetchMock({ result: {} });
    const oracle = new HeliusFeeOracle({ url: "https://helius.test", fetchImpl });
    const est = await oracle.getPriorityFee([]);
    expect(est.levels).toEqual({ min: 0, low: 0, medium: 0, high: 0, veryHigh: 0 });
  });
});
