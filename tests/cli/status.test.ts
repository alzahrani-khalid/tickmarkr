import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { dispatch as dispatchCommand } from "../../src/cli/index.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import { foldActivity, type ActivityTask } from "../../src/run/activity.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { Journal } from "../../src/run/journal.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-status-"));

const seedJournal = (repo: string, runId: string, events: JournalEvent[]) => {
  const dir = join(tickmarkrDir(repo), "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const row = (out: string, taskId: string) =>
  out.split("\n").find((line) => {
    const plain = line.replace(/\x1b\[[0-9;]*m/gu, "");
    return new RegExp(`^ {4}${taskId}(?:\\s|$)`).test(plain)
      || new RegExp(`^\\s+(?:\\[.\\]|[|/\\\\-])\\s+${taskId}\\b`).test(plain);
  })!;
const taskBlock = (out: string, taskId: string): string => {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {4}${taskId}(?:\\s|$)`).test(line));
  if (start < 0) return "";
  const blank = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start, blank < 0 ? undefined : blank).join("\n");
};

// T3: seed a run-start whose recorded graphDefinitionHash matches the saved graph (comparable), so the
// non-hash assertions (dep-waiting, context-sample, skipped gates) see the real replayed states rather
// than the not-comparable notice. The unbound case below seeds a plain run-start with no hash.
const startFor = (g: RunGraph, extra: Record<string, unknown> = {}): JournalEvent => ({
  ts: new Date().toISOString(),
  event: "run-start",
  data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(g), ...extra },
});

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");

const withStatusSurface = async <T>(tty: boolean, columns: number, fn: () => Promise<T>): Promise<T> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  if (tty) delete process.env.NO_COLOR;
  try {
    return await fn();
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (oldColumns) Object.defineProperty(process.stdout, "columns", oldColumns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

const boardGraph = (tasks: Array<Record<string, unknown>>): RunGraph => validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["status-title-fixture"], hash: "status-title-fixture" },
  tasks: tasks.map((task) => ({
    shape: "implement",
    complexity: 3,
    acceptance: ["status title fixture"],
    status: "done",
    ...task,
  })),
});

const renderBoard = async (g: RunGraph, tty: boolean, columns: number): Promise<string> => {
  const repo = mkRepo();
  saveGraph(repo, g);
  return withStatusSurface(tty, columns, () => status([], repo));
};

describe("task titles on the status board", () => {
  test("every approved-table task renders its title rather than its goal, including titles that wrap at the narrow layout", async () => {
    const shortTitle = "Short title";
    const atWidthTitle = "W".repeat(67);
    const overWidthTitle = "O".repeat(68);
    const longGoal = `LONG_GOAL_MUST_NOT_RENDER ${"paragraph ".repeat(60)}`;
    const g = boardGraph([
      { id: "T1", title: shortTitle, goal: "SHORT_GOAL_MUST_NOT_RENDER" },
      { id: "T2", title: atWidthTitle, goal: "AT_WIDTH_GOAL_MUST_NOT_RENDER" },
      { id: "T3", title: overWidthTitle, goal: "OVER_WIDTH_GOAL_MUST_NOT_RENDER" },
      { id: "T4", title: "Long goal has a compact title", goal: longGoal },
    ]);

    const out = stripAnsi(await renderBoard(g, true, 80));
    for (const task of g.tasks) {
      const block = taskBlock(out, task.id).replace(/\s+/gu, "");
      expect(block).toContain(task.title.replace(/\s+/gu, ""));
      expect(out).not.toContain(task.goal);
    }
  });

  test("the approved table keeps every drawn line within the terminal and renders one identity row per task", async () => {
    const width = 120;
    const tasks = Array.from({ length: 13 }, (_, index) => {
      const n = index + 1;
      return {
        id: `T${n}`,
        title: `Task ${n.toString().padStart(2, "0")} title ${"t".repeat(28 + index)}`,
        goal: index < 6
          ? `WRAPPING_GOAL_${n} ${"paragraph ".repeat(50)}`
          : `compact goal ${n}. Additional detail is deliberately outside the first clause.`,
      };
    });
    const g = boardGraph(tasks);
    const out = stripAnsi(await renderBoard(g, true, width));
    const table = out.slice(out.indexOf("area"), out.indexOf("gates   bu"));

    for (const line of out.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(width);
    for (const task of g.tasks) {
      expect(row(out, task.id)).toBeDefined();
      expect(table.match(new RegExp(`^ {4}${task.id}(?:\\s|$)`, "gmu"))).toHaveLength(1);
      expect(out).not.toContain(task.goal);
    }
  });

  test("the piped non-TTY bytes change only in the goal-to-title substitution, proven by a byte comparison whose sole diff is that column", async () => {
    const oldColumn = "legacy task column";
    const newColumn = "current task title";
    expect(newColumn).toHaveLength(oldColumn.length);
    const control = boardGraph([{ id: "T1", title: oldColumn, goal: `${oldColumn}, paragraph detail` }]);
    const candidate = boardGraph([{ id: "T1", title: newColumn, goal: `${oldColumn}, paragraph detail` }]);

    const before = await renderBoard(control, false, 140);
    const after = await renderBoard(candidate, false, 140);
    expect(after).not.toBe(before);
    expect(after).toBe(before.replace(oldColumn, newColumn));
  });


  test("task titles sanitize tabs and ECMA-48 controls before column measurement", async () => {
    // The printable form is exactly the 67-cell column. Raw control bytes must neither steal
    // capacity nor reach a machine-consumed surface.
    const controlledTitle = `${"S".repeat(32)}\t\x1b[31m${"T".repeat(34)}\x1b[0m`;
    const printableTitle = `${"S".repeat(32)} ${"T".repeat(34)}`;
    const g = boardGraph([{ id: "T1", title: controlledTitle, goal: "CONTROL_GOAL_MUST_NOT_RENDER" }]);

    const piped = await renderBoard(g, false, 140);
    expect(piped).toContain(printableTitle);
    expect(piped).not.toMatch(/[\t\x1b\u009b]/u);
    expect(stripAnsi(await renderBoard(g, true, 80))).toContain(printableTitle);
  });
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

  // OBS-536: on a 41-task graph with 8-way fan-in, `dep-waiting on …` plus the pane name pushed the
  // machine row past the terminal width and the row paid for it out of the TITLE — 20 rows named no
  // task at all. The cockpit card forbids exactly that trade (identity on line 1, machinery on line 2).
  test("a machine row never sheds the task title to pay for its machinery, however many blockers it names", async () => {
    const repo = mkRepo();
    const blockers = Array.from({ length: 9 }, (_, i) => `T${i + 1}`);
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [
        ...blockers.map((id) => ({ id, title: `${id} blocker`, goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] })),
        {
          id: "T-last", title: "Land the residual rewrite for the long tail", goal: "g",
          shape: "implement", complexity: 3, deps: blockers, acceptance: ["a"],
        },
      ],
    });
    saveGraph(repo, g);
    seedJournal(repo, "run-identity", [startFor(g)]);
    const out = await status([], repo);
    expect(row(out, "T-last")).toContain(`dep-waiting on ${blockers.join(", ")}`); // no blocker becomes a +N count
    expect(row(out, "T-last")).toContain("Land the residual"); // and identity survives beside it
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

// T2: `status <runId>` reports the run you named — an explicit id resolves that run's journal or
// fails loudly naming the id; the no-argument form keeps the latest-run behaviour byte-identical.
describe("status <runId> reports the run you named", () => {
  const fixedNow = () => Date.parse("2026-08-01T00:00:00.000Z");
  const oneTaskRepo = () => {
    const repo = mkRepo();
    const g = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
    });
    saveGraph(repo, g);
    return { repo, g };
  };

  test("an explicit runId renders that run's frame and a nonexistent id fails loudly naming the id rather than rendering any frame", async () => {
    const { repo, g } = oneTaskRepo();
    seedJournal(repo, "run-20260101-000000", [startFor(g), { ts: "2026-07-31T23:59:00.000Z", event: "task-done", taskId: "T1", data: { attempts: 1 } }]);
    seedJournal(repo, "run-20260102-000000", [startFor(g)]); // the latest run: T1 still pending
    const out = await status(["run-20260101-000000"], repo, { now: fixedNow });
    expect(out).toContain("run run-20260101-000000");
    expect(out).not.toContain("run-20260102-000000");
    expect(row(out, "T1")).toMatch(/\bdone\b/); // the NAMED run's journal folded, not the latest's
    await expect(status(["run-DOESNOTEXIST"], repo, { now: fixedNow })).rejects.toThrow(/run-DOESNOTEXIST/);
  });

  test("omitting the argument renders the latest run byte-identically to the pre-change output", async () => {
    const { repo, g } = oneTaskRepo();
    seedJournal(repo, "run-20260101-000000", [startFor(g)]);
    seedJournal(repo, "run-20260102-000000", [startFor(g)]);
    // the pre-change output IS the latest-run resolution: naming that same run explicitly must
    // reproduce the no-argument frame byte-for-byte, on the plain surface and under --watch.
    const implicit = await status([], repo, { now: fixedNow });
    const explicit = await status(["run-20260102-000000"], repo, { now: fixedNow });
    expect(implicit).toBe(explicit);
    const implicitWatch = await status(["--watch"], repo, { iterations: 1, now: fixedNow, sleep: async () => {} });
    const explicitWatch = await status(["--watch", "run-20260102-000000"], repo, { iterations: 1, now: fixedNow, sleep: async () => {} });
    expect(implicitWatch).toBe(explicitWatch);
  });

  test("watch mode follows the named run across refreshes and never re-resolves to latest, proven over the closed set of refresh shapes — a newer-run-starting fixture, an ended-run fixture and an unchanged-run fixture", async () => {
    // shape 1: a newer run starts mid-watch — the frames keep reporting the named run
    {
      const { repo, g } = oneTaskRepo();
      seedJournal(repo, "run-20260101-000000", [startFor(g)]);
      let seeded = false;
      const out = await status(["--watch", "run-20260101-000000"], repo, {
        iterations: 2,
        now: fixedNow,
        sleep: async () => {
          if (seeded) return;
          seeded = true;
          seedJournal(repo, "run-20260103-000000", [startFor(g)]); // newer run appears between refreshes
        },
      });
      const frames = out.split("\n---\n");
      expect(frames).toHaveLength(2);
      for (const frame of frames) {
        expect(frame).toContain("run run-20260101-000000");
        expect(frame).not.toContain("run-20260103-000000");
      }
    }
    // shape 2: the named run ends mid-watch — the refresh re-reads THAT run's journal
    {
      const { repo, g } = oneTaskRepo();
      seedJournal(repo, "run-20260101-000000", [
        { ts: "2026-07-31T23:59:01.000Z", event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(g) } },
      ]);
      let ended = false;
      const out = await status(["--watch", "run-20260101-000000"], repo, {
        iterations: 2,
        now: fixedNow,
        sleep: async () => {
          if (ended) return;
          ended = true;
          appendFileSync(
            join(tickmarkrDir(repo), "runs", "run-20260101-000000", "journal.jsonl"),
            JSON.stringify({ ts: "2026-08-01T00:00:00.000Z", event: "run-end", data: {} }) + "\n",
          );
        },
      });
      const frames = out.split("\n---\n");
      expect(frames).toHaveLength(2);
      expect(frames[0]).toContain("run run-20260101-000000");
      expect(frames[1]).toContain("run run-20260101-000000");
      expect(frames[0]).toContain("last event 59s ago");
      expect(frames[1]).toContain("last event 0s ago"); // the same run's newer event, re-read
    }
    // shape 3: an unchanged run renders the identical frame on every refresh
    {
      const { repo, g } = oneTaskRepo();
      seedJournal(repo, "run-20260101-000000", [startFor(g)]);
      const out = await status(["--watch", "run-20260101-000000"], repo, { iterations: 2, now: fixedNow, sleep: async () => {} });
      const frames = out.split("\n---\n");
      expect(frames).toHaveLength(2);
      expect(frames[0]).toContain("run run-20260101-000000");
      expect(frames[1]).toBe(frames[0]);
    }
  });

  test("the exit code distinguishes a resolved run from an unresolvable id, and no unresolvable id exits zero", async () => {
    const { repo, g } = oneTaskRepo();
    seedJournal(repo, "run-20260101-000000", [startFor(g)]);
    mkdirSync(join(tickmarkrDir(repo), "runs", "run-20260101-000100"), { recursive: true }); // run dir without a journal
    const commands = { status: (argv: string[]) => status(argv, repo, { now: fixedNow }) };
    const resolved = await dispatchCommand("status", ["run-20260101-000000"], commands);
    expect(resolved.code).toBe(0);
    expect(resolved.out).toContain("run run-20260101-000000");
    const missing = await dispatchCommand("status", ["run-DOESNOTEXIST"], commands);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("run-DOESNOTEXIST"); // fails loudly naming the id
    const journalless = await dispatchCommand("status", ["run-20260101-000100"], commands);
    expect(journalless.code).not.toBe(0);
    expect(journalless.out).toContain("run-20260101-000100");
  });
});
