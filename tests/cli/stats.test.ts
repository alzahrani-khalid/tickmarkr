import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectChannelStats, stats } from "../../src/cli/commands/stats.js";
import { dispatch } from "../../src/cli/index.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const assignment = (adapter: string, model: string) => ({ adapter, model, channel: "sub", tier: "mid" });

const rowFor = (repo: string, author: string) =>
  collectChannelStats(repo).channels.find((channel) => channel.author === author);

describe("tickmarkr stats", () => {
  test("test: a channel dispatched twice and delivered once over a two-run fixture reports the dispatch and delivery counts its task-dispatch and task-done rows carry", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const first = Journal.create(repo, "run-first");
    first.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 0 });
    first.append("task-done", "T1", { assignment: assignment("codex", "gpt-5"), attempts: 1 });
    const second = Journal.create(repo, "run-second");
    second.append("task-dispatch", "T2", { assignment: assignment("codex", "gpt-5"), attempt: 0 });

    expect(rowFor(repo, "codex:gpt-5")).toMatchObject({ dispatches: 2, deliveries: 1, deliveryRate: 0.5 });
    expect(await stats([], repo)).toContain("codex:gpt-5 | — | 2 | 1 | 50%");
  });

  test("test: a channel dispatched but never delivered is reported at a zero delivery rate, so a channel that only ever failed is never omitted from the table", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-red");
    journal.append("task-dispatch", "T1", { assignment: assignment("pi", "glm-5"), attempt: 0 });
    journal.append("gate-result", "T1", { gate: "test", pass: false, details: "FAIL tests/one.test.ts" });

    expect(rowFor(repo, "pi:glm-5")).toMatchObject({ dispatches: 1, deliveries: 0, deliveryRate: 0 });
    expect(await stats([], repo)).toContain("pi:glm-5 | — | 1 | 0 | 0% | —");
  });

  test("test: a task failed on one channel and delivered on another is reported as a within-task rescue naming both channels, so difficulty is controlled where a raw rate cannot", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-rescue");
    journal.append("task-dispatch", "T1", { assignment: assignment("pi", "glm-5"), attempt: 0 });
    journal.append("gate-result", "T1", { gate: "test", pass: false, attempt: 0, details: "FAIL tests/one.test.ts" });
    journal.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 1 });
    journal.append("gate-result", "T1", { gate: "review", pass: true, attempt: 1, details: "reviewer claude-code:sonnet (anthropic): approved" });
    journal.append("task-done", "T1", { assignment: assignment("codex", "gpt-5"), attempts: 2 });

    const delivered = rowFor(repo, "codex:gpt-5");
    expect(delivered?.reviewers).toEqual(["claude-code:sonnet"]);
    expect(delivered?.rescues).toEqual(["pi:glm-5 → codex:gpt-5 (run-rescue/T1)"]);
    expect(await stats([], repo)).toContain("pi:glm-5 → codex:gpt-5");
  });

  test("test: a run whose only red carried an infra fingerprint reports zero real reds against one infra red, using the classifier the gate itself applies", () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const journal = Journal.create(repo, "run-infra");
    journal.append("task-dispatch", "T1", { assignment: assignment("codex", "gpt-5"), attempt: 0 });
    journal.append("gate-result", "T1", {
      gate: "test", pass: false, attempt: 0, fingerprints: ["Error: spawn EAGAIN"], details: "exit 1",
    });

    expect(rowFor(repo, "codex:gpt-5")).toMatchObject({ realReds: 0, infraReds: 1 });
  });

  test("test: stats over an empty state directory exits zero reporting no channels, so an absent directory is a lawful zero rather than a failure", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const stateDir = join(repo, ".tickmarkr");
    expect(existsSync(stateDir)).toBe(false);

    const result = await dispatch("stats", [], { stats: (argv) => stats(argv, repo) });
    expect(result).toEqual({ out: "tickmarkr stats — 0 runs\nno channels", code: 0 });
    expect(existsSync(stateDir)).toBe(false);
  });
});
