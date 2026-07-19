import { describe, expect, test } from "vitest";
import {
  buildProfile, learnedScore, NEUTRAL, resolveHygieneWeight,
  type ProfileDiscount, type ProfileRow,
} from "../../src/route/profile.js";
import { channelKey } from "../../src/adapters/types.js";

const mkRow = (o: Partial<ProfileRow> = {}): ProfileRow => ({
  taskId: "T1", shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
  attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0, runId: "run-20200101-000000", ...o,
});
const keyOf = (r: ProfileRow) => `${r.shape}|${channelKey(r)}|${r.channel}`;
const cell = (p: ReturnType<typeof buildProfile>, r: ProfileRow) => p.cells.get(keyOf(r));

const cleanRows = (n: number, runId = "run-20200101-000000", taskId = "T1") =>
  Array.from({ length: n }, () => mkRow({ runId, taskId, outcome: "done", gateFails: 0, consults: 0, durationMs: NaN }));

describe("T5 profile discount — evidence fold", () => {
  test("a weight-zero discount removes that run's evidence from the folded score", () => {
    const rows = cleanRows(6);
    const base = buildProfile(rows);
    const discounted = buildProfile(rows, { discounts: [{ runId: "run-20200101-000000", weight: 0, reason: "vacuous oracle" }] });
    const c0 = cell(base, rows[0])!;
    const c1 = cell(discounted, rows[0])!;
    expect(c0.n).toBe(6);
    expect(c1.n).toBe(0);
    expect(c1.qSum).toBe(0);
    expect(c1.nRaw).toBe(6); // raw count preserved for visibility
    expect(learnedScore(base, "implement", "claude-code:sonnet", "sub")).not.toBe(NEUTRAL);
    expect(learnedScore(discounted, "implement", "claude-code:sonnet", "sub")).toBe(NEUTRAL);
  });

  test("a weight-half discount halves that run's evidence in the folded score", () => {
    const rows = cleanRows(12);
    const base = buildProfile(rows);
    const half = buildProfile(rows, { discounts: [{ runId: "run-20200101-000000", weight: 0.5, reason: "OBS-51" }] });
    const c0 = cell(base, rows[0])!;
    const c1 = cell(half, rows[0])!;
    expect(c0.n).toBe(12);
    expect(c1.n).toBe(6);
    expect(c1.qSum).toBe(6);
    expect(c1.discounted).toBe(12);
    const s0 = learnedScore(base, "implement", "claude-code:sonnet", "sub");
    const s1 = learnedScore(half, "implement", "claude-code:sonnet", "sub");
    expect(s1).not.toBe(s0);
    expect(s1).toBe((6 + 3) / (6 + 6) - 0.5); // n=6 ≥ MIN_SAMPLES; perf=0 (NaN durations)
  });

  test("a cell dropping below MIN_SAMPLES after discounting scores exactly neutral", () => {
    const rows = cleanRows(5);
    const p = buildProfile(rows, { discounts: [{ runId: "run-20200101-000000", weight: 0.5, reason: "half" }] });
    expect(cell(p, rows[0])!.n).toBe(2.5);
    expect(learnedScore(p, "implement", "claude-code:sonnet", "sub")).toBe(NEUTRAL);
  });

  test("an absent discounts file changes no score", () => {
    const rows = cleanRows(6);
    const noOpts = buildProfile(rows);
    const empty = buildProfile(rows, { discounts: [] });
    expect(noOpts).toEqual(empty);
    expect(Object.is(
      learnedScore(noOpts, "implement", "claude-code:sonnet", "sub"),
      learnedScore(empty, "implement", "claude-code:sonnet", "sub"),
    )).toBe(true);
  });

  test("task-level discount is selective; run-level applies to all tasks in the run", () => {
    const rows = [
      mkRow({ taskId: "T1", runId: "run-20200101-000000" }),
      mkRow({ taskId: "T2", runId: "run-20200101-000000" }),
    ];
    const taskOnly: ProfileDiscount[] = [{ runId: "run-20200101-000000", taskId: "T1", weight: 0, reason: "poison" }];
    expect(resolveHygieneWeight(rows[0], taskOnly)).toBe(0);
    expect(resolveHygieneWeight(rows[1], taskOnly)).toBe(1);
    const runWide: ProfileDiscount[] = [{ runId: "run-20200101-000000", weight: 0.5, reason: "window" }];
    expect(resolveHygieneWeight(rows[0], runWide)).toBe(0.5);
    expect(resolveHygieneWeight(rows[1], runWide)).toBe(0.5);
  });

  test("the dyadic weights keep the fold order-insensitive", () => {
    const discounts: ProfileDiscount[] = [{ runId: "run-20200101-000000", weight: 0.5, reason: "x" }];
    const rows = cleanRows(4).concat(cleanRows(4, "run-20200102-000000"));
    const forward = buildProfile(rows, { discounts });
    const reversed = buildProfile([...rows].reverse(), { discounts });
    expect(forward).toEqual(reversed);
  });

  test("discount folds at the single evidence-fold site only — dispatches/quotaHits unchanged", () => {
    const rows = [
      mkRow({ outcome: "human", parkKind: "quota", durationMs: 0 }),
      ...cleanRows(5),
    ];
    const base = buildProfile(rows);
    const disc = buildProfile(rows, { discounts: [{ runId: "run-20200101-000000", weight: 0, reason: "z" }] });
    const c0 = cell(base, rows[1])!;
    const c1 = cell(disc, rows[1])!;
    expect(c1.dispatches).toBe(c0.dispatches);
    expect(c1.quotaHits).toBe(c0.quotaHits);
    expect(c1.n).toBe(0);
    expect(c0.n).toBe(5);
  });
});
