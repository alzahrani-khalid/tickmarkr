import { describe, expect, test } from "vitest";
import { estimateCosts, type ChannelCost, type CostConfig } from "../../src/report/cost.js";
import type { TelemetryRow } from "../../src/run/journal.js";

// Minimal valid telemetry row; tests override only what matters. The estimator reads fields directly
// (it does not re-validate), so a full-shape object keeps the type honest without per-test boilerplate.
function row(over: Partial<TelemetryRow> & { adapter: string; model: string }): TelemetryRow {
  return {
    taskId: over.taskId ?? "T1",
    shape: over.shape ?? "implement",
    adapter: over.adapter,
    model: over.model,
    channel: over.channel ?? "api",
    attempts: over.attempts ?? 1,
    outcome: over.outcome ?? "done",
    durationMs: over.durationMs ?? 1000,
    ...over,
  } as TelemetryRow;
}

const find = (out: ChannelCost[], adapter: string, model: string) =>
  out.find((c) => c.adapter === adapter && c.model === model)!;

const API_RATE = { inPerMtok: 5, outPerMtok: 25, cacheReadPerMtok: 0.5, rateDate: "2026-07-13" };

describe("estimateCosts — API channels", () => {
  test("tokens × per-Mtok rate yields a dollar estimate carrying tokens + rate + rateDate as basis", () => {
    const out = estimateCosts(
      [row({ adapter: "claude-code", model: "opus", channel: "api", tokens: { input: 1_000_000, output: 1_000_000 } })],
      { models: { opus: API_RATE } },
    );
    const c = find(out, "claude-code", "opus");
    expect(c.measurable).toBe(true);
    // (1M/1M)*5 + (1M/1M)*25 = 30
    expect(c.apiUsd).toBe(30);
    expect(c.tokens).toEqual({ input: 1_000_000, output: 1_000_000 });
    expect(c.rate).toEqual(API_RATE);
    expect(c.rate?.rateDate).toBe("2026-07-13");
  });

  test("cacheRead is priced only when the rate carries cacheReadPerMtok", () => {
    const withCache = estimateCosts(
      [row({ adapter: "a", model: "m", tokens: { input: 0, output: 0, cacheRead: 2_000_000 } })],
      { models: { m: API_RATE } },
    )[0];
    // 2M/1M * 0.5 = 1
    expect(withCache.apiUsd).toBe(1);

    const noCacheRate = estimateCosts(
      [row({ adapter: "a", model: "m", tokens: { input: 0, output: 0, cacheRead: 2_000_000 } })],
      { models: { m: { inPerMtok: 5, outPerMtok: 25 } } },
    )[0];
    // no cacheReadPerMtok ⇒ cacheRead counted in basis but unpriced
    expect(noCacheRate.apiUsd).toBe(0);
    expect(noCacheRate.tokens?.cacheRead).toBe(2_000_000);
  });

  test("partial metering flags the tokens total as a floor", () => {
    const out = estimateCosts(
      [
        row({ taskId: "T1", adapter: "a", model: "m", tokens: { input: 500_000, output: 0 } }),
        row({ taskId: "T2", adapter: "a", model: "m" }), // unmetered
      ],
      { models: { m: { inPerMtok: 4, outPerMtok: 0 } } },
    );
    const c = out[0];
    expect(c.partialMetering).toBe(true);
    expect(c.tasks).toBe(2);
    expect(c.tokens?.input).toBe(500_000); // only the metered row
  });

  test("no rate configured ⇒ not measurable, names the model, never $0", () => {
    const out = estimateCosts(
      [row({ adapter: "a", model: "mystery", tokens: { input: 100, output: 100 } })],
      { models: {} },
    );
    const c = out[0];
    expect(c.measurable).toBe(false);
    expect(c.apiUsd).toBeUndefined();
    expect(c.reason).toContain("mystery");
  });

  test("unmetered API row ⇒ not measurable, never $0", () => {
    const out = estimateCosts([row({ adapter: "a", model: "m" })], { models: { m: API_RATE } });
    expect(out[0].measurable).toBe(false);
    expect(out[0].apiUsd).toBeUndefined();
    expect(out[0].tokens).toBeUndefined();
    expect(out[0].reason).toMatch(/unmetered/);
  });
});

describe("estimateCosts — sub channels", () => {
  const PLAN = { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 };

  test("amortized range = attempts × [plan/high, plan/low], carrying the plan as basis", () => {
    // 3 attempts: per-window low = 200/1200 = 0.1667; high = 200/400 = 0.5
    // range = [3*0.1667, 3*0.5] = [0.5, 1.5]
    const out = estimateCosts(
      [row({ adapter: "claude-code", model: "opus", channel: "sub", attempts: 3 })],
      { subs: { "claude-code": PLAN } },
    );
    const c = out[0];
    expect(c.measurable).toBe(true);
    expect(c.amortizedUsd).toEqual([0.5, 1.5]);
    expect(c.subPlan).toEqual(PLAN);
    expect(c.counterfactualUsd).toBeUndefined(); // no tokens/rate ⇒ no counterfactual
  });

  test("with metered tokens + model API rate, adds an API-equivalent counterfactual", () => {
    const out = estimateCosts(
      [row({ adapter: "claude-code", model: "opus", channel: "sub", tokens: { input: 1_000_000, output: 1_000_000 } })],
      { subs: { "claude-code": PLAN }, models: { opus: API_RATE } },
    );
    const c = out[0];
    expect(c.amortizedUsd).toBeDefined();
    expect(c.counterfactualUsd).toBe(30); // same math as the API test
    expect(c.rate?.rateDate).toBe("2026-07-13");
  });

  test("tokens + rate but no plan ⇒ counterfactual only, still measurable", () => {
    const out = estimateCosts(
      [row({ adapter: "claude-code", model: "opus", channel: "sub", tokens: { input: 1_000_000, output: 1_000_000 } })],
      { models: { opus: API_RATE } },
    );
    const c = out[0];
    expect(c.measurable).toBe(true);
    expect(c.amortizedUsd).toBeUndefined();
    expect(c.counterfactualUsd).toBe(30);
  });

  test("no plan, unmetered, no rate ⇒ not measurable, names both gaps", () => {
    const out = estimateCosts([row({ adapter: "claude-code", model: "opus", channel: "sub" })], {});
    const c = out[0];
    expect(c.measurable).toBe(false);
    expect(c.reason).toContain("claude-code");
    expect(c.reason).toMatch(/unmetered/);
  });

  test("no plan but metered tokens and no API rate ⇒ not measurable, names both gaps", () => {
    const out = estimateCosts(
      [row({ adapter: "claude-code", model: "opus", channel: "sub", tokens: { input: 10, output: 10 } })],
      {},
    );
    const c = out[0];
    expect(c.measurable).toBe(false);
    expect(c.reason).toContain("claude-code");
    expect(c.reason).toContain("opus");
  });
});

describe("estimateCosts — grouping & absence", () => {
  test("groups by adapter:model and sums attempts across tasks", () => {
    const out = estimateCosts(
      [
        row({ taskId: "T1", adapter: "a", model: "m", channel: "api", attempts: 2, tokens: { input: 1_000_000, output: 0 } }),
        row({ taskId: "T2", adapter: "a", model: "m", channel: "api", attempts: 1, tokens: { input: 1_000_000, output: 0 } }),
        row({ taskId: "T3", adapter: "a", model: "other", channel: "api", attempts: 1, tokens: { input: 0, output: 0 } }),
      ],
      { models: { m: { inPerMtok: 5, outPerMtok: 0 } } },
    );
    expect(out).toHaveLength(2);
    const m = find(out, "a", "m");
    expect(m.attempts).toBe(3);
    expect(m.tasks).toBe(2);
    expect(m.tokens?.input).toBe(2_000_000);
    expect(m.apiUsd).toBe(10); // 2M/1M * 5
  });

  test("empty price table ⇒ every channel not measurable, never a zero cost", () => {
    const out = estimateCosts(
      [
        row({ adapter: "a", model: "m", channel: "api", tokens: { input: 5, output: 5 } }),
        row({ adapter: "s", model: "n", channel: "sub" }),
      ],
      {},
    );
    expect(out.every((c) => !c.measurable)).toBe(true);
    expect(out.every((c) => c.apiUsd === undefined && c.amortizedUsd === undefined && c.counterfactualUsd === undefined)).toBe(true);
    expect(out.every((c) => c.reason)).toBe(true);
  });

  test("deterministic sorted order by adapter:model", () => {
    const out = estimateCosts(
      [row({ adapter: "z", model: "z" }), row({ adapter: "a", model: "m" }), row({ adapter: "a", model: "b" })],
      {},
    );
    expect(out.map((c) => `${c.adapter}:${c.model}`)).toEqual(["a:b", "a:m", "z:z"]);
  });

  test("pure: no mutation of inputs, no config needed", () => {
    const rows = [row({ adapter: "a", model: "m", tokens: { input: 1, output: 1 } })];
    const snapshot = JSON.stringify(rows);
    estimateCosts(rows, { models: { m: API_RATE } });
    expect(JSON.stringify(rows)).toBe(snapshot); // rows untouched
  });
});

describe("estimateCosts — CostConfig shape", () => {
  test("accepts an empty/undefined cost config without throwing", () => {
    expect(() => estimateCosts([], undefined as unknown as CostConfig)).not.toThrow();
    expect(estimateCosts([], {})).toEqual([]);
  });
});
