import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { profile } from "../../src/cli/commands/profile.js";
import { loadConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { learnedScore, learnedScoreTerms } from "../../src/route/profile.js";
import { loadRoutingProfile } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const row = (o: Record<string, unknown>) =>
  JSON.stringify({
    taskId: "T", shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
    attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0, ...o,
  });

const seedRun = (repo: string, runId: string, lines: string[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "telemetry.jsonl"), lines.join("\n") + "\n");
};

const seedWarmAndCold = (repo: string) => {
  seedRun(repo, "run-20200101-000000", Array(6).fill(row({})));
  seedRun(repo, "run-20200102-000000", Array(2).fill(row({ shape: "chore", adapter: "codex", model: "gpt" })));
};

const parseTerm = (out: string, name: string) => {
  const m = out.match(new RegExp(`^\\s+${name}\\s+([+-]?\\d+\\.\\d+)`, "m"));
  expect(m, `missing ${name} term line`).not.toBeNull();
  return Number(m![1]);
};

describe("T6 profile --explain", () => {
  test("profile --explain prints a per-term decomposition for a warm cell", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    const out = await profile(["--explain", "implement", "claude-code:sonnet"], repo);
    expect(out).toContain("implement × claude-code:sonnet (sub)");
    expect(out).toMatch(/^\s+quality\s+[+-]\d+\.\d+/m);
    expect(out).toMatch(/^\s+perf\s+[+-]\d+\.\d+/m);
    expect(out).toMatch(/^\s+avail\s+[+-]\d+\.\d+/m);
    expect(out).toMatch(/^\s+overrun\s+[+-]\d+\.\d+/m);
    expect(out).toMatch(/^\s+score\s+[+-]\d+\.\d+/m);
    expect(out).toContain("explore");
    expect(out).not.toContain("n_eff");
  });

  test("the printed terms sum exactly to the learnedScore the table shows", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    const table = await profile([], repo);
    const tableScore = table.match(/implement\s+claude-code:sonnet[^\n]*score=([-\d.]+)/)?.[1];
    expect(tableScore).toBeDefined();
    const out = await profile(["--explain", "implement", "claude-code:sonnet"], repo);
    const sum = ["quality", "perf", "avail", "overrun"].reduce((acc, term) => acc + parseTerm(out, term), 0);
    const scoreLine = parseTerm(out, "score");
    expect(sum).toBe(scoreLine);
    expect(scoreLine).toBe(Number(tableScore));
    const cfg = loadConfig(repo);
    const p = loadRoutingProfile(repo, cfg, { preview: true });
    const tuning = { availWeight: cfg.routing.learnedTuning?.availWeight };
    const t = learnedScoreTerms(p, "implement", "claude-code:sonnet", "sub", tuning);
    expect(t.quality + t.perf + t.avail + t.overrun).toBe(learnedScore(p, "implement", "claude-code:sonnet", "sub", tuning));
  });

  test("a cold cell prints neutral terms", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    seedWarmAndCold(repo);
    const out = await profile(["--explain", "chore", "codex:gpt"], repo);
    expect(out).toContain("chore × codex:gpt (sub)");
    for (const term of ["quality", "perf", "avail", "overrun", "score"]) {
      expect(parseTerm(out, term)).toBe(0);
    }
    expect(out).toMatch(/cold/);
  });
});
