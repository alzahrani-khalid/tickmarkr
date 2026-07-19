import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { profile } from "../../src/cli/commands/profile.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { readProfileDiscounts } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const row = (o: Record<string, unknown>) =>
  JSON.stringify({
    taskId: "T1", shape: "implement", adapter: "claude-code", model: "sonnet", channel: "sub",
    attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0, ...o,
  });

const seedRun = (repo: string, runId: string, lines: string[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "telemetry.jsonl"), lines.join("\n") + "\n");
};

describe("T5 profile discount CLI", () => {
  test("the profile discount CLI writes runId weight and reason to the state file", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const out = await profile(["discount", "run-20260717-030615", "--weight", "0", "--reason", "vacuous test oracle"], repo);
    expect(out).toContain("profile discount");
    const marks = readProfileDiscounts(repo);
    expect(marks).toEqual([{ runId: "run-20260717-030615", weight: 0, reason: "vacuous test oracle" }]);
    expect(readFileSync(join(tickmarkrDir(repo), "profile-discounts"), "utf8")).toBe(
      "run-20260717-030615 0 # vacuous test oracle\n",
    );
  });

  test("task-level discount writes taskId to the state file", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    await profile(["discount", "run-20260717-030615", "T2", "--weight", "0.5", "--reason", "OBS-51"], repo);
    expect(readProfileDiscounts(repo)).toEqual([
      { runId: "run-20260717-030615", taskId: "T2", weight: 0.5, reason: "OBS-51" },
    ]);
  });

  test("the profile table shows a discounted-cell counter", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const runId = "run-20200101-000000";
    seedRun(repo, runId, Array(6).fill(row({ runId })));
    await profile(["discount", runId, "--weight", "0.5", "--reason", "half"], repo);
    const out = await profile([], repo);
    expect(out).toContain("disc=6");
  });

  test("profile discounts lists marks", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    await profile(["discount", "run-20200101-000000", "--weight", "0", "--reason", "x"], repo);
    const out = await profile(["discounts"], repo);
    expect(out).toContain("run-20200101-000000");
    expect(out).toContain("weight=0");
    expect(out).toContain("x");
  });

  test("discount requires --reason", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    await expect(profile(["discount", "run-20200101-000000", "--weight", "0"], repo)).rejects.toThrow(/reason/i);
  });
});
