import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import { foldActivity, type ActivityTask } from "../../src/run/activity.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { Journal } from "../../src/run/journal.js";

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-status-"));

const seedJournal = (repo: string, runId: string, events: JournalEvent[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const row = (out: string, taskId: string) => out.split("\n").find((line) => new RegExp(`\\b${taskId}\\b`).test(line))!;

// T3: seed a run-start whose recorded graphDefinitionHash matches the saved graph (comparable), so the
// non-hash assertions (dep-waiting, context-sample, skipped gates) see the real replayed states rather
// than the not-comparable notice. The unbound case below seeds a plain run-start with no hash.
const startFor = (g: RunGraph, extra: Record<string, unknown> = {}): JournalEvent => ({
  ts: new Date().toISOString(),
  event: "run-start",
  data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(g), ...extra },
});

// VIS-03: tickmarkr status classifies pending tasks dep-waiting vs starved using the SAME
// closure predicate as run-end (blockedTasks/pendingTasks) — never a separate reimplementation.
describe("tickmarkr status: dep-waiting vs starved classification", () => {
  test("pending behind a failed dep → starved", async () => {
    const repo = mkRepo();
    saveGraph(
      repo,
      validateGraph({
        version: 1,
        spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [
          { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"], status: "failed" },
          { id: "T2", title: "b", goal: "b", shape: "implement", complexity: 3, deps: ["T1"], acceptance: ["b"] },
        ],
      }),
    );
    const out = await status([], repo);
    const t2Row = row(out, "T2");
    expect(t2Row).toContain("starved");
    expect(t2Row).not.toContain("dep-waiting");
  });

  test("pending behind a merely-running dep → dep-waiting, zero starved (status never cries wolf)", async () => {
    const repo = mkRepo();
    saveGraph(
      repo,
      validateGraph({
        version: 1,
        spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [
          { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"], status: "running" },
          { id: "T2", title: "b", goal: "b", shape: "implement", complexity: 3, deps: ["T1"], acceptance: ["b"] },
        ],
      }),
    );
    const out = await status([], repo);
    const t2Row = row(out, "T2");
    expect(t2Row).toContain("dep-waiting");
    expect(out).not.toContain("starved"); // zero starved anywhere in the report
  });
});

// v1.65 T4 (OBS-104): the pure journal→activity fold, tested at the fold seam. Lives beside its
// consumer suite (not as a new tests/run file) so the docs-truth structure counts stay honest —
// docs/codebase/TESTING.md pins per-directory *.test.ts tallies and is outside this task's scope.
const GATES = ["build", "test", "lint", "evidence", "scope", "acceptance", "review"];
const foldTask = (id: string, over: Partial<ActivityTask> = {}): ActivityTask =>
  ({ id, gates: GATES, deps: [], status: "pending", ...over });

const ets = "2026-07-22T08:00:00.000Z";
const ev = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: ets, event, ...(taskId ? { taskId } : {}), data });
const dispatch = (taskId: string, attempt = 0): JournalEvent =>
  ev("task-dispatch", taskId, { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt });
const workerOk = (taskId: string): JournalEvent => ev("worker-result", taskId, { ok: true, finished: true });
const gate = (taskId: string, name: string, pass: boolean): JournalEvent =>
  ev("gate-result", taskId, { gate: name, pass });

describe("activity fold (OBS-104)", () => {
  test("a task with a live worker attempt shows the channel and attempt in its activity cell", () => {
    const { cells } = foldActivity([ev("run-start"), dispatch("T1", 1)], [foldTask("T1")]);
    expect(cells.get("T1")).toBe("attempt 2 in flight on fake:fake-1 since 08:00:00");
  });

  test("a task whose gate is running shows the gate name in its activity cell", () => {
    const { cells } = foldActivity(
      [ev("run-start"), dispatch("T1"), workerOk("T1"), gate("T1", "build", true)],
      [foldTask("T1")],
    );
    expect(cells.get("T1")).toBe("gate test running");
  });

  test("the fold is a pure function of journal events with no filesystem or process access", () => {
    // static fence: the module touches no runtime ambient — no node builtins, no process, no clock
    const source = readFileSync(fileURLToPath(new URL("../../src/run/activity.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/node:|child_process|process\.|Date\.now|new Date|Math\.random/);
    // behavioral fence: deterministic on identical inputs, and inputs come back byte-identical
    const events = [ev("run-start"), dispatch("T1"), workerOk("T1"), gate("T1", "build", false)];
    const tasks = [foldTask("T1"), foldTask("T2", { deps: ["T1"] })];
    const eventsBefore = JSON.stringify(events);
    const tasksBefore = JSON.stringify(tasks);
    const a = foldActivity(events, tasks);
    const b = foldActivity(events, tasks);
    expect(b).toEqual(a);
    expect(JSON.stringify(events)).toBe(eventsBefore);
    expect(JSON.stringify(tasks)).toBe(tasksBefore);
  });

  test("a failing gate keeps the next declared gate running, and a fully-failed chain reads retrying", () => {
    const mid = foldActivity(
      [ev("run-start"), dispatch("T1"), workerOk("T1"), gate("T1", "build", true), gate("T1", "test", false)],
      [foldTask("T1")],
    );
    expect(mid.cells.get("T1")).toBe("gate lint running"); // gates continue after a failure (OBS-104 v1.64 datum)
    const all = GATES.map((g) => gate("T1", g, g !== "test"));
    const done = foldActivity([ev("run-start"), dispatch("T1"), workerOk("T1"), ...all], [foldTask("T1")]);
    expect(done.cells.get("T1")).toBe("retrying");
  });

  test("an all-pass gate chain reads merging until the task lands", () => {
    const all = GATES.map((g) => gate("T1", g, true));
    const merging = foldActivity([ev("run-start"), dispatch("T1"), workerOk("T1"), ...all], [foldTask("T1")]);
    expect(merging.cells.get("T1")).toBe("merging");
    const landed = foldActivity(
      [ev("run-start"), dispatch("T1"), workerOk("T1"), ...all, ev("task-done", "T1")],
      [foldTask("T1", { status: "done" })],
    );
    expect(landed.cells.has("T1")).toBe(false); // terminal tasks are idle, not animated
  });

  test("consult verdicts and escalations read retrying; a park names its kind and survives a daemon restart", () => {
    const events = [
      ev("run-start"),
      dispatch("T1"), ev("consult-verdict", "T1", { action: "retry" }),
      dispatch("T2"), ev("task-human", "T2", { kind: "attempt-cap" }),
      ev("run-resume"),
    ];
    const { cells } = foldActivity(events, [foldTask("T1"), foldTask("T2", { status: "human" })]);
    expect(cells.get("T1")).toBeUndefined(); // run-resume cleared the stale transient — nothing is in flight
    expect(cells.get("T2")).toBe("parked (attempt-cap)"); // parks persist across restarts
  });

  test("dep-waiting cells name unmet deps only, and the fold carries a now line naming the last event", () => {
    const snap = foldActivity(
      [ev("run-start"), dispatch("T1"), gate("T1", "build", true)],
      [foldTask("T1"), foldTask("T2", { deps: ["T1", "T0"] }), foldTask("T0", { status: "done" }), foldTask("T3")],
    );
    expect(snap.cells.get("T2")).toBe("dep-waiting on T1"); // T0 is done — never named
    expect(snap.cells.has("T3")).toBe(false); // no deps ⇒ no dep-waiting (OBS-104 fix 1)
    expect(snap.now).toBe("gate-result — T1 — build passed");
    expect(foldActivity([], [foldTask("T1")]).now).toBeUndefined();
  });
});

// v1.65 T4 (OBS-104): dep-waiting is reserved for genuinely unmet deps and names them; a task with
// a live attempt shows its activity instead of a blanket dep-waiting.
describe("v1.65 activity cells on the status surface", () => {
  test("a task with unmet dependencies names the unmet dependencies and no other pending task shows dep-waiting", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] },
        { id: "T2", title: "b", goal: "b", shape: "implement", complexity: 3, deps: ["T1"], acceptance: ["b"] },
        { id: "T3", title: "c", goal: "c", shape: "implement", complexity: 3, acceptance: ["c"] },
      ],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-activity", [
      startFor(g),
      {
        ts: "2026-07-22T08:00:00.000Z", event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 },
      },
    ]);
    const out = await status([], repo);
    expect(row(out, "T2")).toContain("dep-waiting on T1"); // the unmet dep is named
    expect(out.match(/dep-waiting/g)).toHaveLength(1); // no other pending task shows dep-waiting
    expect(row(out, "T1")).toContain("attempt 1 in flight on fake:fake-1 since 08:00:00"); // live attempt, not dep-waiting
    expect(row(out, "T3")).not.toContain("dep-waiting"); // pending with no deps stays unlabeled
  });
});

// v1.23 T2: context tokens render beside assignment when known; never perturb task state/phase.
describe("v1.23 status context-sample (informational only)", () => {
  test("context tokens render beside assignment when a context-sample is journaled", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"], status: "running" },
      ],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-ctx-status", [
      startFor(g),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 },
      },
      {
        ts: new Date().toISOString(), event: "context-sample", taskId: "T1",
        data: { tokens: 180_000, threshold: 170_000, attempt: 0 },
      },
    ]);
    const out = await status([], repo);
    const t1Row = row(out, "T1");
    expect(t1Row).toContain("fake:fake-1");
    expect(t1Row).toContain("ctx 180000");
    // Informational only — context is a channel suffix and never rewrites replayed status or gates.
    expect(t1Row).toMatch(/\bpending\b/);
    expect(t1Row).toContain("B[ ]");
    // Prove the sample did not invent a gate failure or terminal state.
    expect(t1Row).not.toMatch(/done|failed|human/);
  });

  test("absent context-sample leaves assignment bare when graph hash matches; pre-v1.44 journals without a recorded graph definition hash are not comparable in status", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] },
      ],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-ctx-match", [
      startFor(g, { baseRef: "abc" }),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: { attempts: 1 } },
    ]);
    const matched = await status([], repo);
    const matchedRow = row(matched, "T1");
    expect(matchedRow).toContain("fake:fake-1");
    expect(matchedRow).not.toContain("ctx ");
    expect(matchedRow).toMatch(/\bdone\b/);

    const repoOld = mkRepo();
    saveGraph(
      repoOld,
      validateGraph({
        version: 1,
        spec: { source: "prd", paths: ["p"], hash: "h" },
        tasks: [
          { id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] },
        ],
      }),
    );
    seedJournal(repoOld, "run-ctx-old", [
      { ts: new Date().toISOString(), event: "run-start", data: { pid: process.pid, baseRef: "abc" } },
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "task-done", taskId: "T1", data: { attempts: 1 } },
    ]);
    const old = await status([], repoOld);
    expect(old).toContain("not comparable");
    const oldRow = row(old, "T1");
    expect(oldRow).not.toContain("fake:fake-1");
    expect(oldRow).toMatch(/\bpending\b/);
    const st = Journal.open(repoOld, "run-ctx-old").replayStatuses();
    expect(st.get("T1")).toBe("done");
  });
});

// v1.53 T5: a superseded run is dead — its status header must say who replaced it.
describe("v1.53 supersession in the status header", () => {
  test("status of a superseded run names the superseding run", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-old", [
      startFor(g),
      { ts: new Date().toISOString(), event: "superseded", data: { by: "run-new" } },
    ]);
    const out = await status([], repo);
    expect(out.split("\n")[0]).toContain("superseded by run-new"); // header line, not a task row
  });
});

describe("skipped gate-result renders as skip, not pass or forever-open", () => {
  test("review skipped by complexity threshold → 'R.' in the chain", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-review-skip", [
      startFor(g),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "review", pass: true, details: "skipped — complexity 3 < threshold 5", skipped: true } },
    ]);
    const out = await status([], repo);
    const t1Row = row(out, "T1");
    expect(t1Row).toContain("R."); // skip glyph, not R[x] (pass) and not R[ ] (open)
    expect(t1Row).not.toContain("R[x]");
  });

  test("review that ran and passed → 'R[x]' in the chain", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 8, acceptance: ["a"] }],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-review-pass", [
      startFor(g),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "review", pass: true, details: "reviewer fake:fake-2 (fake-b): approved" } },
    ]);
    const out = await status([], repo);
    const t1Row = row(out, "T1");
    expect(t1Row).toContain("R[x]");
    expect(t1Row).not.toContain("R.");
  });

  test("lint gate-result with skipped:true → 'L.' in the chain", async () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-skip", [
      startFor(g),
      {
        ts: new Date().toISOString(), event: "task-dispatch", taskId: "T1",
        data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" }, attempt: 0 },
      },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "build", pass: true, details: "exit 0" } },
      { ts: new Date().toISOString(), event: "gate-result", taskId: "T1", data: { gate: "lint", pass: true, details: "no lint command detected — skipped", skipped: true } },
    ]);
    const out = await status([], repo);
    const t1Row = row(out, "T1");
    expect(t1Row).toContain("B[x]");
    expect(t1Row).toContain("L."); // skip glyph, not L[x] (pass) and not L[ ] (open)
  });
});
