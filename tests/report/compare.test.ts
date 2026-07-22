import { describe, expect, test } from "vitest";
import {
  compareRuns,
  environmentComparable,
  recordedEnvironment,
  type EnvironmentCompare,
} from "../../src/report/compare.js";
import type { RunEnvironment } from "../../src/run/environment.js";
import type { JournalEvent, TelemetryRow } from "../../src/run/journal.js";

// v1.70 T3: report --compare pure surface — cost/gate/duration delta + environment
// comparability guard shaped like engagementComparable (comparable | mismatch | unbound).

const env = (over: Partial<RunEnvironment> & { configHash: string }): RunEnvironment => ({
  tickmarkrVersion: over.tickmarkrVersion ?? "1.70.0",
  configHash: over.configHash,
  adapterVersions: over.adapterVersions ?? { fake: "fake" },
});

const start = (environment?: RunEnvironment, ts = "2026-07-22T10:00:00.000Z"): JournalEvent => ({
  ts,
  event: "run-start",
  data: environment ? { environment, baseRef: "abc" } : { baseRef: "abc" },
});

const end = (ts = "2026-07-22T10:01:30.000Z"): JournalEvent => ({
  ts,
  event: "run-end",
  data: { done: ["T1"], failed: [], human: [] },
});

const gate = (pass: boolean, gateName = "test", ts = "2026-07-22T10:00:30.000Z"): JournalEvent => ({
  ts,
  event: "gate-result",
  taskId: "T1",
  data: { gate: gateName, pass, details: pass ? "ok" : "fail" },
});

const row = (over: Partial<TelemetryRow> = {}): TelemetryRow => ({
  taskId: over.taskId ?? "T1",
  shape: over.shape ?? "implement",
  adapter: over.adapter ?? "api",
  model: over.model ?? "metered",
  channel: over.channel ?? "api",
  attempts: over.attempts ?? 1,
  outcome: over.outcome ?? "done",
  durationMs: over.durationMs ?? 1000,
  ...over,
});

describe("report --compare with comparability guards (v1.70 T3)", () => {
  test("test: comparing a run against itself reports no delta and full comparability", () => {
    const identity = env({ configHash: "aaaaaaaaaaaaaaaa" });
    const events: JournalEvent[] = [
      start(identity, "2026-07-22T10:00:00.000Z"),
      gate(true),
      gate(false, "lint"),
      end("2026-07-22T10:01:30.000Z"),
    ];
    const rows = [row({ tokens: { input: 1_000_000, output: 500_000 }, meteredAttempts: 1 })];
    const cost = { models: { metered: { inPerMtok: 5, outPerMtok: 25 } } };

    const out = compareRuns({
      runId: "run-self",
      baselineRunId: "run-self",
      events,
      baselineEvents: events,
      rows,
      baselineRows: rows,
      cost,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.comparability).toEqual({ comparable: true, recorded: "aaaaaaaaaaaaaaaa" } satisfies EnvironmentCompare);
    expect(out.delta.durationMs).toBe(0);
    expect(out.delta.gateFail).toBe(0);
    expect(out.delta.costUsd).toBe(0);
    expect(out.delta.tokensTotal).toBe(0);
    expect(out.text).toMatch(/full comparability/i);
    expect(out.text).toMatch(/\| duration \|[^\n]*\| 0s \|/);
    expect(out.text).toMatch(/\| gate failures \|[^\n]*\| 0 \|/);
  });

  test("test: comparing two runs whose recorded config hash differs renders the delta with an explicit comparability caveat rather than a silent apples-to-apples table", () => {
    const baseEnv = env({ configHash: "bbbbbbbbbbbbbbbb" });
    const curEnv = env({ configHash: "cccccccccccccccc" }); // config hash differs
    const baselineEvents: JournalEvent[] = [
      start(baseEnv, "2026-07-22T09:00:00.000Z"),
      gate(false, "test", "2026-07-22T09:00:10.000Z"),
      end("2026-07-22T09:02:00.000Z"), // 120s
    ];
    const events: JournalEvent[] = [
      start(curEnv, "2026-07-22T10:00:00.000Z"),
      gate(false, "test", "2026-07-22T10:00:10.000Z"),
      gate(false, "build", "2026-07-22T10:00:20.000Z"),
      end("2026-07-22T10:01:00.000Z"), // 60s
    ];
    const baselineRows = [row({ tokens: { input: 2_000_000, output: 0 }, meteredAttempts: 1 })];
    const rows = [row({ tokens: { input: 1_000_000, output: 0 }, meteredAttempts: 1 })];
    const cost = { models: { metered: { inPerMtok: 5, outPerMtok: 25 } } };

    const out = compareRuns({
      runId: "run-cur",
      baselineRunId: "run-base",
      events,
      baselineEvents,
      rows,
      baselineRows,
      cost,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.comparability.comparable).toBe(false);
    if (out.comparability.comparable) return;
    expect(out.comparability.reason).toBe("mismatch");
    expect(out.comparability.recorded).toBe("bbbbbbbbbbbbbbbb");
    // Delta is still rendered (not suppressed)…
    expect(out.delta.durationMs).toBe(-60_000);
    expect(out.delta.gateFail).toBe(1); // 2 − 1
    expect(out.text).toMatch(/duration/i);
    expect(out.text).toMatch(/gate failures/i);
    // …but with an explicit comparability caveat, not a silent apples-to-apples table.
    expect(out.text).toMatch(/comparability caveat/i);
    expect(out.text).toMatch(/not apples-to-apples/i);
    expect(out.text).not.toMatch(/full comparability/i);
    expect(out.text).toContain("bbbbbbbbbbbbbbbb");
    expect(out.text).toContain("cccccccccccccccc");
  });

  test("test: comparing against a baseline run id with no recorded run-start event fails closed with a clear reason instead of rendering a partial or fabricated comparison", () => {
    const identity = env({ configHash: "dddddddddddddddd" });
    const events: JournalEvent[] = [start(identity), end()];
    // Baseline journal exists but never recorded run-start (e.g. torn / pre-daemon garbage).
    const baselineEvents: JournalEvent[] = [
      { ts: "2026-07-22T08:00:00.000Z", event: "task-dispatch", taskId: "T1", data: {} },
      { ts: "2026-07-22T08:01:00.000Z", event: "run-end", data: {} },
    ];

    const out = compareRuns({
      runId: "run-cur",
      baselineRunId: "run-orphan",
      events,
      baselineEvents,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/run-orphan/i);
    expect(out.reason).toMatch(/no recorded run-start/i);
    expect(out.reason).toMatch(/cannot compare/i);
    // Fail closed: no rendered comparison body at all.
    expect(out).not.toHaveProperty("text");
    expect(out).not.toHaveProperty("delta");
  });

  test("test: the rendered comparison names both run ids so the reader always knows which run is the baseline", () => {
    const identity = env({ configHash: "eeeeeeeeeeeeeeee" });
    const events: JournalEvent[] = [start(identity), end()];
    const out = compareRuns({
      runId: "run-20260722-current",
      baselineRunId: "run-20260722-baseline",
      events,
      baselineEvents: events,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain("run-20260722-current");
    expect(out.text).toContain("run-20260722-baseline");
    // Explicit baseline label — the reader must not guess which id is the reference.
    expect(out.text).toMatch(/\*\*baseline:\*\*\s*run-20260722-baseline/);
    expect(out.text).toMatch(/\*\*run:\*\*\s*run-20260722-current/);
    expect(out.text).toContain(`baseline (${"run-20260722-baseline"})`);
    expect(out.text).toContain(`current (${"run-20260722-current"})`);
  });

  // Judge pin: shape reuses engagementComparable (comparable | mismatch+recorded | unbound).
  test("environmentComparable reuses the engagementComparable shape over run-start environment identity", () => {
    const a = env({ configHash: "ffffffffffffffff" });
    const b = env({ configHash: "0000000000000001" });
    expect(environmentComparable(a, a)).toEqual({ comparable: true, recorded: "ffffffffffffffff" });
    expect(environmentComparable(a, b)).toEqual({
      comparable: false,
      reason: "mismatch",
      recorded: "ffffffffffffffff",
    });
    expect(environmentComparable(undefined, a)).toEqual({ comparable: false, reason: "unbound" });
    expect(environmentComparable(a, undefined)).toEqual({ comparable: false, reason: "unbound" });
    expect(recordedEnvironment([start(a)])).toEqual(a);
    expect(recordedEnvironment([{ ts: "t", event: "run-start", data: {} }])).toBeUndefined();
  });
});
