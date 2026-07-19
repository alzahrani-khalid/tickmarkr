// v1.47 T4: per-shape SLA advisory lints. The v1.47 run --quality one-band floor raise is RETIRED:
// v1.51 T2 redefined --quality as a pure compatibility alias for --mode partner-led that carries no
// floor raise of its own (see tests/cli/mode-sources), so its old raise pins are removed here.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allAdapters } from "../../src/adapters/registry.js";
import { type BillingChannel, channelsFromConfig } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  buildProfile, learnedScore, learnedScoreTerms, MIN_SAMPLES, PERF_WEIGHT, REF_MS,
  type ProfileRow, type RoutingProfile,
} from "../../src/route/profile.js";
import { route } from "../../src/route/router.js";
import { channelKey } from "../../src/adapters/types.js";
import { plan } from "../../src/cli/commands/plan.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

const channelsOf = (cfg: ReturnType<typeof loadConfig>): BillingChannel[] =>
  allAdapters().map((a) => a.id).filter((id) => id !== "fake").flatMap((id) => channelsFromConfig(id, cfg));

function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-sla-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-sla-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}

const mkTask = (shape: string, over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"], ...over }],
  }).tasks[0];

const warmRows = (shape: string, adapter: string, model: string, durationMs: number, n = MIN_SAMPLES): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "done" as const,
    durationMs, gateFails: 0, consults: 0,
  }));

const badRows = (shape: string, adapter: string, model: string, n: number): ProfileRow[] =>
  Array.from({ length: n }, () => ({
    shape, adapter, model, channel: "sub", attempts: 1, outcome: "human" as const,
    parkKind: "gate-fail", durationMs: 1000, gateFails: 1, consults: 0,
  }));

const probeProfile = (shape = "implement", durationMs = 1000): RoutingProfile => buildProfile([
  ...warmRows(shape, "cursor-agent", "composer-2.5", durationMs, 6),
  ...badRows(shape, "codex", "gpt-5.6-terra", 2),
]);

describe("v1.47 T4 SLA lints (v1.51: --quality aliases --mode partner-led; the one-band raise is retired)", () => {
  test("a shape breaching its declared sla appears as a plan lint", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  sla:\n    chore: 15");
    const cfg = loadConfig(repo, { globalDir });
    const channels = channelsOf(cfg);
    const profile = buildProfile(warmRows("chore", "codex", "gpt-5.6-luna", 20 * 60_000, 6));
    const r = route(mkTask("chore"), cfg, channels, profile, undefined, undefined, { noExplore: true });
    expect(channelKey(r.assignment)).toBe("codex:gpt-5.6-luna");
    expect(r.lints.join("\n")).toMatch(/median 20m exceeds sla 15m/);
    expect(r.lints.join("\n")).toMatch(/learned perf term references sla 15m ref/);
  });

  test("absent sla config produces no lint", () => {
    const { repo, globalDir } = repoWithOverlay("");
    const cfg = loadConfig(repo, { globalDir });
    const channels = channelsOf(cfg);
    const profile = probeProfile("implement", 20 * 60_000);
    const r = route(mkTask("implement"), cfg, channels, profile);
    expect(r.lints).toEqual([]);
  });

  test("sla is advisory at plan time and never reroutes on its own", () => {
    const slaMin = 15;
    // Two warm rivals: slow/high-quality vs fast/lower-quality — sla ref would change learned ranking if wired in.
    const profile = buildProfile([
      ...warmRows("chore", "claude-code", "opus", 20 * 60_000, 6),
      ...Array.from({ length: 6 }, () => ({
        shape: "chore", adapter: "cursor-agent", model: "composer-2.5", channel: "sub" as const,
        attempts: 1, outcome: "done" as const, durationMs: 5 * 60_000, gateFails: 1, consults: 0,
      })),
    ]);
    const slow = learnedScore(profile, "chore", "claude-code:opus", "sub");
    const fast = learnedScore(profile, "chore", "cursor-agent:composer-2.5", "sub");
    const slowSla = learnedScore(profile, "chore", "claude-code:opus", "sub", { slaMinutes: slaMin });
    const fastSla = learnedScore(profile, "chore", "cursor-agent:composer-2.5", "sub", { slaMinutes: slaMin });
    expect(slowSla - fastSla).not.toBe(slow - fast); // proves the regression oracle is not vacuous

    const { repo, globalDir } = repoWithOverlay(`routing:\n  sla:\n    chore: ${slaMin}`);
    const cfg = loadConfig(repo, { globalDir });
    const channels = channelsOf(cfg);
    const task = mkTask("chore");
    const withoutSla = loadConfig(repoWithOverlay("", globalDir).repo, { globalDir });
    const base = route(task, withoutSla, channels, profile, undefined, undefined, { noExplore: true });
    const withSla = route(task, cfg, channels, profile, undefined, undefined, { noExplore: true });
    expect(withSla.assignment).toEqual(base.assignment);
  });

  test("sla lint references perf term at declared ref without affecting route scores", () => {
    const slaMin = 15;
    const slaMs = slaMin * 60_000;
    const profile = buildProfile(warmRows("implement", "cursor-agent", "composer-2.5", slaMs, 6));
    const termsAtSla = learnedScoreTerms(profile, "implement", "cursor-agent:composer-2.5", "sub", { slaMinutes: slaMin });
    const termsDefault = learnedScoreTerms(profile, "implement", "cursor-agent:composer-2.5", "sub");
    expect(termsAtSla.perf).toBe(0);
    expect(termsDefault.perf).toBe(PERF_WEIGHT * (REF_MS / (REF_MS + slaMs) - 0.5));
    const { repo, globalDir } = repoWithOverlay(`routing:\n  sla:\n    implement: ${slaMin}`);
    const cfg = loadConfig(repo, { globalDir });
    const routed = route(mkTask("implement"), cfg, channelsOf(cfg), profile, undefined, undefined, { noExplore: true });
    expect(learnedScore(profile, "implement", channelKey(routed.assignment), routed.assignment.channel))
      .toBe(learnedScoreTerms(profile, "implement", channelKey(routed.assignment), routed.assignment.channel).quality
        + termsDefault.perf + termsDefault.avail + termsDefault.overrun);
  });

  test("plan surfaces sla breach in routing lints section", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  sla:\n    chore: 15\n");
    const verified = (id: string) => authedModels(Object.keys(loadConfig(repo).tiers[id]?.models ?? {}));
    writeDoctor(repo, Object.fromEntries(
      ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [
        id, { installed: true, authed: true, models: [], modelAuth: verified(id) },
      ]),
    ));
    const dir = join(tickmarkrDir(repo), "runs", "run-20200101-000000");
    mkdirSync(dir, { recursive: true });
    const row = JSON.stringify({
      taskId: "T0", shape: "chore", adapter: "codex", model: "gpt-5.6-luna", channel: "sub",
      attempts: 1, outcome: "done", durationMs: 20 * 60_000, gateFails: 0, consults: 0,
    });
    writeFileSync(join(dir, "telemetry.jsonl"), Array(6).fill(row).join("\n") + "\n");
    const out = await plan([], repo);
    expect(out).toContain("routing lints:");
    expect(out).toMatch(/median 20m exceeds sla 15m/);
  });
});
