import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters } from "../../src/adapters/registry.js";
import { type BillingChannel, channelKey, channelsFromConfig } from "../../src/adapters/types.js";
import { ConfigError, type TickmarkrConfig, loadConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { SHAPES, validateGraph } from "../../src/graph/schema.js";
import { buildProfile, learnedScore, type ProfileRow } from "../../src/route/profile.js";
import { route } from "../../src/route/router.js";
import { loadRoutingProfile } from "../../src/run/journal.js";

// derive channels from ALL 5 adapters (incl. pi) — never the stale 4-list at matrix.test.ts:12
const channelsOf = (cfg: TickmarkrConfig): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));

// copied verbatim from tests/config/config.test.ts:7-13 (not exported)
function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}
const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-g-")) });

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

// n warm CLEAN v1.6 rows warming (shape, adapter:model) — enough to cross MIN_SAMPLES (5)
const warmRows = (shape: string, adapter: string, model: string, n = 6): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "done" as const,
    durationMs: 1000, gateFails: 0, consults: 0,
  }));
const seedTelemetry = (repo: string, runId: string, rows: ProfileRow[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  const line = (r: ProfileRow) => JSON.stringify({ taskId: "T1", ...r });
  writeFileSync(join(dir, "telemetry.jsonl"), rows.map(line).join("\n") + "\n");
  return join(dir, "telemetry.jsonl");
};

describe("ROUTE-07 golden parity (Test A): absent ≡ undefined ≡ empty profile", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir });
  const channels = channelsOf(cfg);

  test.each([...SHAPES])("%s: full Route deep-equal across the three forms", (shape) => {
    const t = mkTask(shape);
    const base = route(t, cfg, channels); // 3-arg — the v1.5 call
    expect(base.deviation).toBeUndefined();
    expect(route(t, cfg, channels, undefined)).toEqual(base);
    expect(route(t, cfg, channels, buildProfile([]))).toEqual(base);
  });
});

describe("ROUTE-09 kill switch (Test B): learned:off ⇒ loader undefined, telemetry untouched", () => {
  const { repo, globalDir } = repoWithOverlay("routing:\n  learned: off\n");
  const cfg = loadConfig(repo, { globalDir });
  const channels = channelsOf(cfg);
  const path = seedTelemetry(repo, "run-20260101-000000", warmRows("chore", "codex", "gpt-5.6-luna"));

  test("loader returns undefined and does not modify telemetry", () => {
    const before = readFileSync(path);
    expect(loadRoutingProfile(repo, cfg)).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  test.each([...SHAPES])("%s: routing through the off-loader deep-equals the 3-arg call", (shape) => {
    const t = mkTask(shape);
    expect(route(t, cfg, channels, loadRoutingProfile(repo, cfg))).toEqual(route(t, cfg, channels));
  });
});

describe("ROUTE-14 default is ON (Test B2): no-overlay repo defaults to on", () => {
  // ROUTE-14 (2026-07-11, operator-adopted): the default flipped off→on. The OFF-inertness contract
  // (undefined loader, static routing) is still tested above via the EXPLICIT learned:off overlay (Test B);
  // this block now pins the new default and its cold-start safety.
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir });
  const channels = channelsOf(cfg);
  seedTelemetry(repo, "run-20260101-000000", warmRows("chore", "codex", "gpt-5.6-luna"));

  test("loadConfig defaults routing.learned to on (ROUTE-14 adopted 2026-07-11; positive value assertion)", () => {
    expect(cfg.routing.learned).toBe("on");
  });
  test("loadRoutingProfile builds a defined profile on the default path when telemetry exists (learning is live)", () => {
    const p = loadRoutingProfile(repo, cfg);
    expect(p).toBeDefined();
    expect(p!.cells.size).toBeGreaterThan(0);
  });
  test.each([...SHAPES])("%s: cold-start byte-identity — an EMPTY profile deep-equals the 3-arg call even under default on (ROUTE-07)", (shape) => {
    const t = mkTask(shape);
    expect(route(t, cfg, channels, buildProfile([]))).toEqual(route(t, cfg, channels));
  });
});

describe("ROUTE-09 typo fails loud (Test C)", () => {
  test("learned: offf ⇒ ConfigError, never a silent default", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  learned: offf\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });
});

describe("T-13-05 legacy-telemetry safety (Test D)", () => {
  // (1) v1.5 done rows with gateFails undefined AND attempts>1 are EXCLUDED (classify ⇒ null)
  test("v1.5 attempts>1 rows warm nothing ⇒ score exactly 0", () => {
    const rows: ProfileRow[] = Array.from({ length: 10 }, () => ({
      shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
      attempts: 3, outcome: "done", durationMs: 1000, // gateFails undefined, attempts>1 ⇒ null
    }));
    const p = buildProfile(rows);
    expect(p.cells.get("implement|claude-code:sonnet|sub")?.n).toBe(0);
    expect(Object.is(learnedScore(p, "implement", "claude-code:sonnet", "sub"), 0)).toBe(true);
  });

  // (2) all-DEGRADED identity: (0.5n+3)/(n+6) − 0.5 ≡ 0, via constructible v1.6 rows
  test.each([5, 6, 50])("all-DEGRADED cell scores exactly 0 (n=%i)", (n) => {
    const rows: ProfileRow[] = Array.from({ length: n }, () => ({
      shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
      attempts: 1, outcome: "done", durationMs: -1, gateFails: 1, consults: 0, // degraded, perf excluded
    }));
    const p = buildProfile(rows);
    expect(p.cells.get("implement|claude-code:sonnet|sub")?.n).toBe(n);
    expect(Object.is(learnedScore(p, "implement", "claude-code:sonnet", "sub"), 0)).toBe(true);
  });

  // (3) v1.5 attempts===1 rows DO classify CLEAN and warm a cell — but deviation is confined to the
  // static tie: warming a non-tied, prefer-losing channel cannot cross the prefer boundary.
  test("v1.5 clean rows warm a cell yet cannot cross a prefer boundary", () => {
    const { repo, globalDir } = emptyRepo();
    const cfg = loadConfig(repo, { globalDir });
    const channels = channelsOf(cfg);
    // implement: map prefer [cursor-agent, codex] ⇒ static winner cursor-agent:composer-2.5
    const staticPick = route(mkTask("implement"), cfg, channels).assignment;
    expect(channelKey(staticPick)).toBe("cursor-agent:composer-2.5");
    // warm claude-code:sonnet (mid, NOT preferred) with v1.5 clean rows — it scores > 0 but loses on prefer
    const rows: ProfileRow[] = Array.from({ length: 8 }, () => ({
      shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
      attempts: 1, outcome: "done", durationMs: 1000, // v1.5 clean ⇒ classify 1
    }));
    const profile = buildProfile(rows);
    expect(learnedScore(profile, "implement", "claude-code:sonnet", "sub")).toBeGreaterThan(0);
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(r.assignment).toEqual(staticPick); // prefer still wins
    expect(r.deviation).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 26-A′ ROUTE-12 cold-start parity (differential ONLY — proves byte-identity to the pre-ROUTE-12
// baseline, NEVER cited as routing-correctness evidence). A cold profile must route exactly like
// no profile across all three cold classes: (i) thin-dispatch all-quota cells, (ii) empty cells,
// (iii) dispatches≥MIN / n<MIN / doneCount≥MIN cells (the doneCount>n class revision #2 exists for —
// same shape as Test D(1)). All cold ⇒ every learnedScore is 0 ⇒ 4-arg deep-equals 3-arg.
// ═══════════════════════════════════════════════════════════════════════════

// class (iii): ≥5 null-classified done rows (v1.5 attempts>1, gateFails undefined ⇒ classify null) —
// dispatches 6 (≥ EXPLORE_CAP ⇒ exploration bonus 0), n 0, doneCount 6, doneMedianMs 1000, quotaHits 0.
// Placed on a cheap-sub channel of `chore` (tied with codex:gpt-5.6-luna on prefer/cost/tier) so that
// under drill (5)'s mutation a leaked perf (+0.0249) breaks the static tie ⇒ this block goes RED.
const coldCorpus = (): ProfileRow[] => {
  const nullDone = (adapter: string, model: string): ProfileRow[] =>
    Array.from({ length: 6 }, () => ({
      shape: "chore", adapter, model, channel: "sub" as const,
      attempts: 2, outcome: "done" as const, durationMs: 1000, // gateFails undefined ⇒ classify null
    }));
  // class (i): thin-dispatch all-quota (mix of both sources) on a frontier channel — loses on tier,
  // inert to the winner; dispatches 4 < MIN_SAMPLES.
  const thinQuota: ProfileRow[] = [
    { shape: "chore", adapter: "claude-code", model: "opus", channel: "sub", attempts: 1, outcome: "failed", durationMs: 0, quotaFailover: true },
    { shape: "chore", adapter: "claude-code", model: "opus", channel: "sub", attempts: 1, outcome: "human", durationMs: 0, parkKind: "quota" },
    { shape: "chore", adapter: "claude-code", model: "opus", channel: "sub", attempts: 1, outcome: "failed", durationMs: 0, quotaFailover: true },
    { shape: "chore", adapter: "claude-code", model: "opus", channel: "sub", attempts: 1, outcome: "human", durationMs: 0, parkKind: "quota" },
  ];
  return [...nullDone("claude-code", "haiku"), ...thinQuota]; // class (ii): every other shape has no cell
};

describe("26-A′ cold-start parity: cold profile ≡ no profile (empty + thin-dispatch + doneCount>n)", () => {
  const { repo, globalDir } = emptyRepo();
  const cfg = loadConfig(repo, { globalDir });
  const channels = channelsOf(cfg);

  test.each([...SHAPES])("(a) empty profile: %s full Route deep-equals the 3-arg call", (shape) => {
    const t = mkTask(shape);
    expect(route(t, cfg, channels, buildProfile([]))).toEqual(route(t, cfg, channels));
  });

  test.each([...SHAPES])("(b) cold-corpus profile (all 3 classes): %s deep-equals the 3-arg call", (shape) => {
    const t = mkTask(shape);
    const cold = buildProfile(coldCorpus());
    expect(route(t, cfg, channels, cold)).toEqual(route(t, cfg, channels));
  });
});
