import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { wallBudget, WALL_PRIORITY } from "../../src/run/wall-budget.js";
import { makeRepo } from "../helpers/tmprepo.js";

// v1.53 T5: supersession renders in the report header on BOTH runs — `superseded by` from the prior
// run's appended superseded event, `supersedes` from the superseding run's own run-start stamp.
describe("v1.53 supersession in the report header", () => {
  test("the report header of a superseded run names the superseding run", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-old");
    j.append("run-start", undefined, { baseRef: "x" });
    j.append("superseded", undefined, { by: "run-new" });
    const out = await report(["run-old"], repo);
    expect(out.split("\n\n")[0]).toContain("superseded by run-new"); // header block, before any section
    const md = await report(["run-old", "--md"], repo);
    expect(md).toContain("**superseded by:** run-new");
  });

  test("the report header of the superseding run names the run it supersedes", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-new");
    j.append("run-start", undefined, { baseRef: "x", supersedes: "run-old" });
    const out = await report(["run-new"], repo);
    expect(out.split("\n\n")[0]).toContain("supersedes run-old");
    const md = await report(["run-new", "--md"], repo);
    expect(md).toContain("**supersedes:** run-old");
  });
});

describe("tickmarkr report --md usage and efficiency", () => {
  test("renders measured and unmetered channels, deterministic efficiency, and routing evidence", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-record");
    writeFileSync(join(j.dir, "journal.jsonl"), [
      { ts: "2026-07-13T10:00:00.000Z", event: "run-start", data: {} },
      { ts: "2026-07-13T10:00:01.000Z", event: "task-dispatch", taskId: "T1", data: { provenance: "floor cheap (config floors), marginal-cost auto (via learned score 0.750 (n=6) over api:static 0.100)" } },
      { ts: "2026-07-13T10:00:02.000Z", event: "route-deviation", taskId: "T1", data: { static: "api:static", chosen: "api:metered", score: 0.75, staticScore: 0.1, n: 6 } },
      { ts: "2026-07-13T10:00:03.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: false } },
      { ts: "2026-07-13T10:00:04.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: false } },
      { ts: "2026-07-13T10:00:05.000Z", event: "consult-verdict", taskId: "T1", data: { action: "retry" } },
      { ts: "2026-07-13T10:00:06.000Z", event: "escalation", taskId: "T1", data: { step: "escalate" } },
      { ts: "2026-07-13T10:01:30.000Z", event: "run-end", data: {} },
    ].map(JSON.stringify).join("\n") + "\n");
    j.telemetry({ taskId: "T1", shape: "implement", adapter: "api", model: "metered", channel: "api", attempts: 1, outcome: "done", durationMs: 1, firstAttemptOk: true, tokens: { input: 1_000_000, output: 1_000_000 }, meteredAttempts: 1 });
    j.telemetry({ taskId: "T2", shape: "implement", adapter: "claude-code", model: "sub", channel: "sub", attempts: 2, outcome: "done", durationMs: 1, firstAttemptOk: false, tokens: { input: 1_000_000, output: 0 }, meteredAttempts: 2 });
    j.telemetry({ taskId: "T3", shape: "implement", adapter: "legacy", model: "unmetered", channel: "sub", attempts: 4, outcome: "done", durationMs: 1 });
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `cost:
  models:
    metered: { inPerMtok: 5, outPerMtok: 25, rateDate: 2026-07-13 }
    sub: { inPerMtok: 3, outPerMtok: 15, rateDate: 2026-07-13 }
  subs:
    claude-code: { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 }
`);

    const journalBefore = readFileSync(join(j.dir, "journal.jsonl"));
    const telemetryBefore = readFileSync(join(j.dir, "telemetry.jsonl"));
    const out = await report(["run-record", "--md"], repo);

    expect(readFileSync(join(j.dir, "journal.jsonl"))).toEqual(journalBefore);
    expect(readFileSync(join(j.dir, "telemetry.jsonl"))).toEqual(telemetryBefore);
    expect(out).toContain("## Usage & efficiency");
    expect(out).toMatch(/api:metered[^\n]*tokens: in 1,000,000[^\n]*\$30[^\n]*basis:[^\n]*2026-07-13/);
    expect(out).toMatch(/claude-code:sub[^\n]*windows: 2[^\n]*\$0\.333333–\$1[^\n]*basis:/);
    expect(out).toMatch(/legacy:unmetered[^\n]*attempts\/windows: 4[^\n]*not measurable/);
    expect(out).toContain("**first-attempt rate:** 1/2 (50%)");
    expect(out).toContain("**gate failures:** build: 2");
    expect(out).toContain("**consults:** 1");
    expect(out).toContain("**escalations:** 1");
    expect(out).toContain("**wall-clock:** 1m 30s");
    expect(out).toContain("**routing:** floor cheap (config floors), marginal-cost auto (via learned score 0.750 (n=6) over api:static 0.100)");
    expect(out).toContain("**route deviation:** api:metered learned score 0.75 (n=6) vs static api:static 0.1");
  });
});


test("test: the report's review row for an approval that closed carried materials names the resolved fingerprints beside the reviewer and an approval that carried none prints no resolved list, so a report that renders the approval without the closure it certified fails", async () => {
  const repo = makeRepo({ "keep.txt": "x\n" });
  const journal = Journal.create(repo, "run-closure");
  const resolved = ["review:material|src/pointer.ts|register", "review:material|src/model.ts|reconcile"];
  for (const [taskId, ids] of [["T1", resolved], ["T2", []]] as const) {
    journal.append("task-dispatch", taskId, { adapter: "codex", model: "gpt-5" });
    journal.append("gate-result", taskId, {
      gate: "review", pass: true, reviewer: "claude-code:opus", resolved: ids,
      details: "reviewer claude-code:opus (vendor: anthropic; provider: anthropic): approved",
    });
  }
  const md = await report(["run-closure", "--md"], repo);
  const rows = md.split("\n").filter((line) => line.includes("- review: pass"));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("reviewer claude-code:opus");
  expect(rows[0]).toContain("approved");
  for (const id of resolved) expect(rows[0]).toContain(id);
  expect(rows[1]).toContain("approved");
  expect(rows[1]).not.toContain("resolved:");
});

// OBS-1201: a hundred-second journal whose buckets are known by construction. Gate rows are journaled
// when their round settles (acceptance, review and test share t70), so each span is anchored at its
// gate's first phase-start. The test gate's measured 43s includes the 3s it queued for its command
// (t17–t20, under T2's worker), so its service is t20–t60. Every copy below would move a bucket if
// it were counted.
describe("OBS-1201 disjoint wall budget", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-28T00:00:00.000Z") + s * 1_000).toISOString();
  const graph = validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["wall-budget"], hash: "wall-budget" },
    tasks: ["T1", "T2"].map((id) => ({ id, title: `task ${id}`, goal: `task ${id}`, shape: "implement", complexity: 3, acceptance: ["a"], status: "done" })),
  });
  const copies: JournalEvent[] = [
    { ts: t(80), event: "gate-result", taskId: "T2", data: { gate: "test", pass: true, reused: true, durationMs: 43_000, evidenceReceipt: { invocationId: "n-test" } } },
    { ts: t(85), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, replayedFromAttempt: 0, durationMs: 43_000, nonce: "n-test" } },
    { ts: t(88), event: "gate-result", taskId: "T2", data: { gate: "build", pass: true, durationMs: 5_000, nonce: "n-build" } },
  ];
  const journal: JournalEvent[] = [
    { ts: t(0), event: "run-start", data: { baseRef: "base", graphDefinitionHash: graphDefinitionHash(graph) } },
    { ts: t(0), event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0 } },
    { ts: t(0), event: "worker-launch", taskId: "T1", data: { attempt: 0 } },
    { ts: t(5), event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" }, attempt: 0 } },
    { ts: t(5), event: "worker-launch", taskId: "T2", data: { attempt: 0 } },
    { ts: t(17), event: "worker-result", taskId: "T1", data: { ok: true } },
    { ts: t(17), event: "phase-start", taskId: "T1", data: { phase: "gates" } },
    { ts: t(17), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
    { ts: t(17), event: "suite-wait", taskId: "T1", data: { count: 1, gate: "test" } },
    { ts: t(19), event: "suite-wait", taskId: "T1", data: { count: 2, gate: "test" } },
    { ts: t(20), event: "worker-result", taskId: "T2", data: { ok: true } },
    { ts: t(20), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test", admitted: true } },
    { ts: t(50), event: "suite-wait", taskId: "T2", data: { count: 1 } },
    { ts: t(60), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
    { ts: t(60), event: "phase-start", taskId: "T1", data: { phase: "review", gate: "review" } },
    { ts: t(70), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 10_000 } },
    { ts: t(70), event: "gate-result", taskId: "T1", data: { gate: "review", pass: true, durationMs: 8_000 } },
    { ts: t(70), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 43_000, nonce: "n-test" } },
    { ts: t(75), event: "suite-admitted", taskId: "T2", data: {} },
    { ts: t(75), event: "phase-start", taskId: "T2", data: { phase: "gates" } },
    { ts: t(75), event: "phase-start", taskId: "T2", data: { phase: "gate:build", gate: "build" } },
    { ts: t(80), event: "gate-result", taskId: "T2", data: { gate: "build", pass: true, durationMs: 5_000, nonce: "n-build" } },
    ...copies,
    { ts: t(90), event: "exit-cause", data: { cause: "deliberate", signal: "SIGTERM" } },
    { ts: t(95), event: "task-approved", taskId: "T2", data: { by: "operator", reason: "outside the engagement" } },
    { ts: t(100), event: "run-resume", data: { pid: 1 } },
    { ts: t(100), event: "run-end", data: { done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [] } },
  ];
  const seconds = (text: string) => text.trim().split(/\s+/u)
    .reduce((sum, part) => sum + Number(part.slice(0, -1)) * (part.endsWith("h") ? 3_600 : part.endsWith("m") ? 60 : 1), 0);
  // The same parse for every surface: "<bucket>[:**] <span> (<pct>%) · task-time <span>".
  const bucketsOf = (out: string) => Object.fromEntries(WALL_PRIORITY.map((bucket) => {
    const match = new RegExp(`(?:^|[\\s*])${bucket}(?::\\*\\*)?\\s+(\\d[\\dhms ]*?) \\(\\d+%\\) · task-time (\\d[\\dhms ]*?)(?: ·|$)`, "mu").exec(out);
    expect(match, `${bucket} in\n${out}`).not.toBeNull();
    return [bucket, { exposed: seconds(match![1]!), task: seconds(match![2]!) }];
  }));
  const residualOf = (out: string) => seconds(/residual(?::\*\*)?\s+(\d[\dhms ]*?) \(\d+%\)/mu.exec(out)![1]!);

  test("production report/status partitions a hundred-second journal as interruption10 test40 semantics10 worker20 queue5 other-gate5 residual10 versus concurrent task-hours, so copied evidence adding service or wall buckets exceeding one hundred fails", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, graph);
    const j = Journal.create(repo, "run-wall");
    writeFileSync(join(j.dir, "journal.jsonl"), journal.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const surfaces = {
      text: await report(["run-wall"], repo),
      md: await report(["run-wall", "--md"], repo),
      status: await status(["run-wall"], repo),
    };
    for (const [surface, out] of Object.entries(surfaces)) {
      const buckets = bucketsOf(out);
      expect(Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, v.exposed])), surface).toEqual({
        interruption: 10, test: 40, semantics: 10, worker: 20, queue: 5, "other-gate": 5,
      });
      expect(residualOf(out), surface).toBe(10);
      // Exposed wall is disjoint: it sums to the hundred-second window, never more.
      expect(Object.values(buckets).reduce((sum, v) => sum + v.exposed, 0) + residualOf(out), surface).toBe(100);
      // Task-time keeps concurrent service apart: two workers, two waits, acceptance beside review.
      expect(Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, v.task])), surface).toEqual({
        interruption: 10, test: 40, semantics: 18, worker: 32, queue: 28, "other-gate": 5,
      });
      expect(Object.values(buckets).reduce((sum, v) => sum + v.task, 0), surface).toBeGreaterThan(100);
      expect(out, surface).toContain("fresh 4 · replay 2 · reuse 1 · unknown 0");
    }
    expect(surfaces.md).toMatch(/\*\*window:\*\* 1m 40s — each instant counted once, by priority interruption › test › semantics › worker › queue › other-gate › residual/u);
    expect(surfaces.status).toContain("wall budget 1m 40s");

    // The copies are inert: removing them changes no span, only the evidence tally.
    const without = wallBudget(journal.filter((e) => !copies.includes(e)))!;
    const withCopies = wallBudget(journal)!;
    expect(withCopies.exposedMs).toEqual(without.exposedMs);
    expect(withCopies.taskMs).toEqual(without.taskMs);
    expect(without.evidence).toEqual({ fresh: 4, replay: 0, reuse: 0, unknown: 0 });
    expect(withCopies.wallMs).toBe(100_000);
  });

  test("a merge-candidate test row places its selected run at the gate's first phase-start and its full suite at the row, so a span read back from the row alone swallows the judge that ran between them", () => {
    const b = wallBudget([
      { ts: t(0), event: "run-start", data: {} },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gates" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(5), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(8), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 3_000 } },
      { ts: t(10), event: "gate-provisioned", taskId: "T1", data: { gate: "build", durationMs: 2_000 } },
      { ts: t(10), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(30), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, fullSuite: true, durationMs: 25_000, selectedDurationMs: 5_000, fullDurationMs: 20_000, nonce: "n-full" } },
      { ts: t(30), event: "run-end", data: {} },
    ])!;
    expect(b.exposedMs).toEqual({ interruption: 0, test: 25_000, semantics: 3_000, worker: 0, queue: 0, "other-gate": 2_000 });
    expect(b.residualMs).toBe(0);
    expect(b.evidence).toEqual({ fresh: 2, replay: 0, reuse: 0, unknown: 0 });
  });
});

// D-639: a wait is the test gate's queue, never a sibling semantic gate's, and a long wait history is
// swept once — not doubled per wait.
describe("OBS-1201 queue subtraction (D-639)", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-28T00:00:00.000Z") + s * 1_000).toISOString();
  test("a matched suite wait is cut only from the gate that owns it, and a thousand waits stay linear", () => {
    const b = wallBudget([
      { ts: t(0), event: "run-start", data: {} },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(0), event: "suite-wait", taskId: "T1", data: { count: 1 } },
      { ts: t(4), event: "suite-admitted", taskId: "T1", data: {} },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "run-end", data: {} },
    ])!;
    expect(b.taskMs.semantics).toBe(10_000); // the judge kept running through the sibling's wait
    expect(b.taskMs.test).toBe(6_000);
    expect(b.taskMs.queue).toBe(4_000);

    // A wait the daemon attributes to another gate is cut from THAT gate: acceptance owning a wait
    // reads semantics 6s and queue 4s, and the sibling test span keeps its full ten.
    const owned = wallBudget([
      { ts: t(0), event: "run-start", data: {} },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(0), event: "suite-wait", taskId: "T1", data: { count: 1, gate: "acceptance" } },
      { ts: t(4), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance", admitted: true } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "run-end", data: {} },
    ])!;
    expect(owned.taskMs.semantics).toBe(6_000);
    expect(owned.taskMs.queue).toBe(4_000);
    expect(owned.taskMs.test).toBe(10_000);

    const many: JournalEvent[] = [{ ts: t(0), event: "run-start", data: {} }];
    for (let i = 0; i < 1_000; i++) {
      many.push({ ts: t(2 * i), event: "suite-wait", taskId: "T1", data: { count: 1 } });
      many.push({ ts: t(2 * i + 1), event: "suite-admitted", taskId: "T1", data: {} });
    }
    many.push({ ts: t(2_000), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 2_000_000 } });
    many.push({ ts: t(2_000), event: "run-end", data: {} });
    const started = Date.now();
    const big = wallBudget(many)!;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(big.taskMs.queue).toBe(1_000_000);
    expect(big.taskMs.test).toBe(1_000_000);
  });
});
