// v1.51 T5: staff-led economics guards. The evidence lint is plan-time ADVISORY only, and every
// escalation mechanism (the complexity-threshold auto-frontier delivered as a task-hint floor, the
// in-run retry ladder) applies AFTER mode resolution — staff-led never dampens either. No code path
// raises a staff-led floor on prediction alone: the profile warns via lint; only journaled evidence
// triggers (hint provenance, real failed attempts) move bands.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { type BillingChannel, channelKey } from "../../src/adapters/types.js";
import { plan } from "../../src/cli/commands/plan.js";
import { loadConfigWithMode } from "../../src/config/config.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  buildProfile, MIN_SAMPLES, type ProfileRow, STAFF_LED_MARGIN, staffLedEvidence,
} from "../../src/route/profile.js";
import { nextChannel, NO_EXPLORE_ENV, QUALITY_ENV, route } from "../../src/route/router.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

// A daemon launched with `run --quality` exports TICKMARKR_QUALITY=1 (run.ts) and its gate `npm test`
// inherits it, silently raising every route() floor a band — the same ambient-inheritance leak class
// vitest.config.ts seals for HERDR_ENV (that file is outside T5 scope, so seal here). Every band
// assertion below is about MODE floors; ambient quality must not reshape them.
for (const k of [QUALITY_ENV, NO_EXPLORE_ENV]) delete process.env[k];

// one channel per band, single adapter — the band picture stays unambiguous
const CH: BillingChannel[] = [
  { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  { adapter: "claude-code", vendor: "anthropic", model: "haiku", channel: "sub", tier: "cheap" },
];

function staffLedCfg() {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-t5-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-t5-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "routing:\n  mode: staff-led\n");
  return loadConfigWithMode(repo, { globalDir });
}

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

// warm evidence: cheap band (haiku) merges degraded every time, mid band (sonnet) merges clean —
// quality terms 0 vs +0.25 with identical perf terms ⇒ mid leads by 0.25 ≥ STAFF_LED_MARGIN.
const implRows = (model: string, gateFails: number): ProfileRow[] =>
  Array.from({ length: MIN_SAMPLES + 1 }, () => ({
    shape: "implement", adapter: "claude-code", model, channel: "sub",
    attempts: 1, outcome: "done" as const, durationMs: 60_000, gateFails, consults: 0,
  }));
const warmProfile = () => buildProfile([...implRows("haiku", 2), ...implRows("sonnet", 0)]);

// plan-path fixtures: real repo + doctor + staff-led overlay + journal telemetry
const DOCTOR_CLAUDE = {
  "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(["fable", "opus", "sonnet", "haiku"]) },
};

function mkGuardRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR_CLAUDE);
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  mode: staff-led\n");
  return repo;
}

const telemetryRow = (model: string, gateFails: number) => ({
  taskId: "T0", shape: "implement", adapter: "claude-code", model, channel: "sub",
  attempts: 1, outcome: "done", durationMs: 60_000, gateFails, consults: 0,
});

const seedTelemetry = (repo: string, rows: object[]) => {
  const dir = join(tickmarkrDir(repo), "runs", "run-20200101-000000");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "telemetry.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

describe("v1.51 T5 staff-led economics guards", () => {
  test("the evidence lint fires when the cheap band scores materially below the mid incumbent", async () => {
    const repo = mkGuardRepo();
    seedTelemetry(repo, [...Array(6).fill(telemetryRow("haiku", 2)), ...Array(6).fill(telemetryRow("sonnet", 0))]);
    const out = await plan([], repo);
    // names the shape, BOTH scores, and the sample count — and stays advisory
    expect(out).toMatch(
      /staff-led may cost more than risk-based on implement \(cheap best [+-]\d\.\d{3} vs mid [+-]\d\.\d{3}, n=12\)/,
    );
    expect(out).toContain("advisory only, floor stays cheap");
    // the lint changed NOTHING about routing: the task still dispatches at the cheap band
    expect(out).toMatch(/T1.*claude-code:haiku \[sub\/cheap\]/);
  });

  test("the evidence lint stays silent on a cold profile", async () => {
    // (a) no telemetry at all
    expect(await plan([], mkGuardRepo())).not.toContain("staff-led may cost more");
    // (b) telemetry below MIN_SAMPLES per cell — cold cells are not evidence
    const thin = mkGuardRepo();
    seedTelemetry(thin, [
      ...Array(MIN_SAMPLES - 1).fill(telemetryRow("haiku", 2)),
      ...Array(MIN_SAMPLES - 1).fill(telemetryRow("sonnet", 0)),
    ]);
    expect(await plan([], thin)).not.toContain("staff-led may cost more");
    // (c) warm cheap but cold mid — no warm incumbent to compare against, still silent
    const half = mkGuardRepo();
    seedTelemetry(half, Array(6).fill(telemetryRow("haiku", 2)));
    expect(await plan([], half)).not.toContain("staff-led may cost more");
  });

  test("a complexity seven task under staff-led still routes frontier", () => {
    const { cfg, mode } = staffLedCfg();
    expect(mode.mode).toBe("staff-led");
    expect(cfg.routing.floors.implement).toBe("cheap"); // the mode lowered the shape floor…
    expect(cfg.review.complexityThreshold).toBe(7); // …seven is the one premium boundary in the product…
    // …and the complexity-threshold auto-frontier (complexity ≥ threshold ⇒ frontier task-hint floor)
    // applies AFTER mode resolution: route() maxes the hint against the resolved floor, so staff-led
    // can never dampen it — the raise arrives with journaled provenance naming its trigger.
    const t = mkTask({
      complexity: 7,
      routingHints: { floor: "frontier", source: "complexity 7 >= review.complexityThreshold 7" },
    });
    const r = route(t, cfg, CH);
    expect(r.assignment.tier).toBe("frontier");
    expect(r.provenance).toContain("floor frontier (task hint, complexity 7 >= review.complexityThreshold 7)");
  });

  test("the retry ladder still climbs a band per failed attempt under staff-led", () => {
    const { cfg } = staffLedCfg();
    const t = mkTask();
    const first = route(t, cfg, CH);
    expect(first.assignment.tier).toBe("cheap"); // staff-led start: cheapest sufficient band
    expect(first.ladder).toEqual(["retry", "escalate", "consult", "human"]);
    const second = nextChannel(first.assignment, t, cfg, CH, [channelKey(first.assignment)]);
    expect(second?.tier).toBe("mid"); // one band per failed attempt — never a two-band jump
    const third = nextChannel(second!, t, cfg, CH, [channelKey(first.assignment), channelKey(second!)]);
    expect(third?.tier).toBe("frontier");
    const exhausted = nextChannel(third!, t, cfg, CH, [first.assignment, second!, third!].map(channelKey));
    expect(exhausted).toBeNull(); // top of the ladder: consult/human next — still no silent raise
  });

  test("no floor is raised without a journaled evidence trigger", () => {
    const { cfg } = staffLedCfg();
    const t = mkTask();
    const profile = warmProfile(); // the profile PREDICTS the cheap band will do worse…
    const withEvidence = route(t, cfg, CH, profile);
    const withoutProfile = route(t, cfg, CH);
    // …but prediction alone raises nothing: identical assignment to the profile-free route, at cheap
    expect(withEvidence.assignment).toEqual(withoutProfile.assignment);
    expect(withEvidence.assignment.tier).toBe("cheap");
    expect(withEvidence.provenance).toContain("floor cheap");
    // the raise paths that DO exist each carry journaled provenance: a task-hint floor names its
    // source in the dispatch record, and the ladder climbs only on real failed attempts (test above)
    const hinted = route(mkTask({ routingHints: { floor: "mid", source: "operator floor hint" } }), cfg, CH, profile);
    expect(hinted.assignment.tier).toBe("mid");
    expect(hinted.provenance).toContain("floor mid (task hint, operator floor hint)");
  });

  test("staff-led guards are advisory and evidence-driven with no anticipatory raise anywhere", async () => {
    // evidence-driven: no profile ⇒ silent; warm-but-tied bands ⇒ silent (no material lead)
    expect(staffLedEvidence(undefined, "implement", CH)).toBeNull();
    const tied = buildProfile([...implRows("haiku", 0), ...implRows("sonnet", 0)]);
    expect(staffLedEvidence(tied, "implement", CH)).toBeNull();
    const ev = staffLedEvidence(warmProfile(), "implement", CH);
    expect(ev).not.toBeNull();
    expect(ev!.midBest - ev!.cheapBest).toBeGreaterThanOrEqual(STAFF_LED_MARGIN);
    expect(ev!.n).toBe(2 * (MIN_SAMPLES + 1));
    // advisory: the firing lint coexists with an unraised cheap dispatch in the same plan output
    const repo = mkGuardRepo();
    seedTelemetry(repo, [...Array(6).fill(telemetryRow("haiku", 2)), ...Array(6).fill(telemetryRow("sonnet", 0))]);
    const out = await plan([], repo);
    expect(out).toContain("staff-led may cost more than risk-based on implement");
    expect(out).toMatch(/T1.*claude-code:haiku \[sub\/cheap\]/);
  });
});
