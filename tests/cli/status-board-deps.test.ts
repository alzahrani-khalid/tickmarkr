import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const at = "2026-08-18T08:00:00.000Z";
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");

type Spec = { id: string; title: string; deps?: readonly string[] };

const graphFor = (specs: readonly Spec[]): RunGraph => validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["deps-board"], hash: "deps-board" },
  tasks: specs.map(({ id, title, deps }) => ({
    id,
    title,
    goal: `Render dependents for ${id}.`,
    shape: "implement",
    complexity: 3,
    deps: deps ?? [],
    acceptance: ["dependents are visible"],
  })),
});

const startFor = (graph: RunGraph): JournalEvent => ({
  ts: at,
  event: "run-start",
  data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) },
});

const dispatch = (taskId: string): JournalEvent => ({
  ts: at,
  event: "task-dispatch",
  taskId,
  data: { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" } },
});

const workerResult = (taskId: string): JournalEvent =>
  ({ ts: at, event: "worker-result", taskId, data: { ok: true, finished: true } });

const contextSample = (taskId: string, tokens: number): JournalEvent =>
  ({ ts: at, event: "context-sample", taskId, data: { tokens } });

const doneEvent = (taskId: string): JournalEvent =>
  ({ ts: at, event: "task-done", taskId, data: {} });

const seed = (graph: RunGraph, events: readonly JournalEvent[]): string => {
  // Through the test temp seam so tests/setup.ts reaps these fixtures (OBS-385).
  const repo = makeTestTempDir("tickmarkr-status-deps-");
  saveGraph(repo, graph);
  const runDir = join(tickmarkrDir(repo), "runs", "run-deps");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"),
    [startFor(graph), ...events].map((event) => JSON.stringify(event)).join("\n") + "\n");
  return repo;
};

const ttyFrame = async (repo: string, columns: number): Promise<string> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  delete process.env.NO_COLOR;
  try {
    return await status([], repo);
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (oldColumns) Object.defineProperty(process.stdout, "columns", oldColumns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

/** One approved-table task block: populated id cell plus its wrapped continuation rows. */
const taskRows = (frame: string, taskId: string): string[] => {
  const lines = stripAnsi(frame).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {4}${taskId}(?:\\s|$)`).test(line));
  expect(start, `no row drawn for ${taskId}`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^ {4}t\d+\b/u.test(lines[end]!)) end += 1;
  return lines.slice(start, end);
};

const taskText = (frame: string, taskId: string): string =>
  taskRows(frame, taskId).join("").replace(/\s+/gu, " ").trim();
describe("status board dependents", () => {
  test("test: an unfinished task blocking two others names both dependents on its card at 110 and at 80 columns wrapping rather than reducing them to a count while lower-priority segments still occupy columns, so a dependents element that narrowing truncates into a tail fails", async () => {
    const repo = seed(
      graphFor([
        { id: "t1", title: "Blocker one" },
        { id: "t2", title: "Waiter alpha", deps: ["t1"] },
        { id: "t3", title: "Waiter beta", deps: ["t1"] },
      ]),
      // A blocker mid-gates carries the journal-tier activity phrase and its still-open pane AND the
      // lower-priority ctx segment, so the dependents element is funded under real width pressure
      // beside the rest of the machinery rather than alone in an empty budget.
      [dispatch("t1"), workerResult("t1"), contextSample("t1", 42000)],
    );

    const wide = await ttyFrame(repo, 110);
    const narrow = await ttyFrame(repo, 80);

    for (const [columns, frame] of [[110, wide], [80, narrow]] as const) {
      const card = taskText(frame, "t1");
      // Both dependents, named, in the graph's own order — never a count, a tail or an ellipsis.
      expect(card, `${columns} columns`).toContain("blocks t2, t3");
      expect(card, `${columns} columns`).not.toMatch(/blocks \d/u);
      expect(card, `${columns} columns`).not.toMatch(/\+\d|…|\.\.\./u);
      // Narrowing costs rows, never columns past the board: every drawn row fits.
      for (const line of stripAnsi(frame).split("\n")) {
        expect(cellWidth(line), `${columns} columns: ${line}`).toBeLessThanOrEqual(columns);
      }
      // The reverse direction still stands on the waiters' own cards.
      expect(taskText(frame, "t2"), `${columns} columns`).toContain("dep-waiting on t1");
    }

    // Lower-priority segments still occupy columns beside the dependents: the element is not funded
    // by evicting the machinery below it, and the phrase above it is untouched.
    const wideCard = taskText(wide, "t1");
    expect(wideCard).toContain("ctx 42000");
    expect(wideCard).toContain("gate build running");
  });

  test("test: a dependent recorded done in the journal leaves the blocker's dependents element and a task all of whose dependents are done carries none, so a fold reading graph deps without the journal done set fails", async () => {
    const repo = seed(
      graphFor([
        { id: "t1", title: "Blocker one" },
        { id: "t2", title: "Waiter alpha", deps: ["t1"] },
        { id: "t3", title: "Waiter beta", deps: ["t1"] },
        { id: "t4", title: "Blocker two" },
        { id: "t5", title: "Waiter gamma", deps: ["t4"] },
      ]),
      // The graph says t1 blocks two tasks and t4 blocks one. The journal says otherwise.
      [dispatch("t2"), doneEvent("t2"), dispatch("t5"), doneEvent("t5")],
    );

    const frame = await ttyFrame(repo, 110);

    // A dependent the record says is done waits on nobody: it leaves the element, which survives
    // naming only the dependent still waiting.
    const blocker = taskText(frame, "t1");
    expect(blocker).toContain("blocks t3");
    expect(blocker).not.toContain("t2");
    // Every dependent done ⇒ no element at all, not an empty or zero-count one.
    const settled = taskText(frame, "t4");
    expect(settled).not.toContain("blocks");
    expect(settled).not.toContain("t5");

    // Dependencies are a dedicated structural column for every task, not only a waiting note.
    expect(stripAnsi(frame)).toMatch(/\barea\s+deps\s+task\b/u);
    expect(taskText(frame, "t3")).toMatch(/\bt1\b/u);
  });
});
