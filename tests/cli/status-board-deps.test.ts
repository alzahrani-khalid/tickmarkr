import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The rows one task's card actually occupies: its identity row and everything drawn under it up to
 * the blank separator — wrapped continuation rows included. Read as rows (so a wrap is countable)
 * and as one whitespace-normalised string (so a name split across a wrap still reads whole, which
 * is exactly what "wraps rather than truncates" has to mean at a narrow board).
 */
const cardRows = (frame: string, title: string): string[] => {
  const lines = stripAnsi(frame).split("\n");
  const start = lines.findIndex((line) => line.includes(title));
  expect(start, `no card drawn for ${title}`).toBeGreaterThanOrEqual(0);
  const blank = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start, blank === -1 ? undefined : blank);
};

const cardText = (frame: string, title: string): string =>
  cardRows(frame, title).join("").replace(/\s+/gu, " ").trim();

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
      const card = cardText(frame, "Blocker one");
      // Both dependents, named, in the graph's own order — never a count, a tail or an ellipsis.
      expect(card, `${columns} columns`).toContain("blocks t2, t3");
      expect(card, `${columns} columns`).not.toMatch(/blocks \d/u);
      expect(card, `${columns} columns`).not.toMatch(/\+\d|…|\.\.\./u);
      // Narrowing costs rows, never columns past the board: every drawn row fits.
      for (const line of stripAnsi(frame).split("\n")) {
        expect(cellWidth(line), `${columns} columns: ${line}`).toBeLessThanOrEqual(columns);
      }
      // The reverse direction still stands on the waiters' own cards.
      expect(cardText(frame, "Waiter alpha"), `${columns} columns`).toContain("dep-waiting on t1");
    }

    // Lower-priority segments still occupy columns beside the dependents: the element is not funded
    // by evicting the machinery below it, and the phrase above it is untouched.
    const wideCard = cardText(wide, "Blocker one");
    expect(wideCard).toContain("ctx 42000");
    expect(wideCard).toContain("gate build running");
    // Narrowing pays in rows: the same card is taller at 80 columns than at 110.
    expect(cardRows(narrow, "Blocker one").length)
      .toBeGreaterThan(cardRows(wide, "Blocker one").length);
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
    const blocker = cardText(frame, "Blocker one");
    expect(blocker).toContain("blocks t3");
    expect(blocker).not.toContain("t2");
    // Every dependent done ⇒ no element at all, not an empty or zero-count one.
    const settled = cardText(frame, "Blocker two");
    expect(settled).not.toContain("blocks");
    expect(settled).not.toContain("t5");

    // Source citation fence: the fold reads the journal-folded statuses (`effective`), never the
    // compiled graph's, and the segment enters through the existing DetailSegment vocabulary — no
    // second shed order, and no width measured outside the cockpit's width authority.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/cli/commands/status.ts", import.meta.url)),
      "utf8",
    );
    const foldStart = source.indexOf("const dependents = new Map<string, string[]>();");
    expect(foldStart).toBeGreaterThanOrEqual(0);
    const foldHunk = source.slice(foldStart, source.indexOf("const unicode = visual();", foldStart));
    expect(foldHunk).toContain("for (const task of effective.tasks)");
    expect(foldHunk).toContain('if (task.status === "done") continue;');
    expect(foldHunk).not.toMatch(/g\.tasks|cellWidth|padEnd|slice\(/u);
    expect(source).toContain('[{ element: "journal" as const, text: `blocks ${blocking.join(", ")}` }]');
    // One shed order, stated once, and it is the cockpit's layout priority — not a local list.
    expect(source.match(/LAYOUT_PRIORITY\.slice/gu)).toHaveLength(1);
  });
});
