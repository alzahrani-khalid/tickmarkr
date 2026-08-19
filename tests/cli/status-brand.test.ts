import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { brandChip } from "../../src/brand.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";

// T8: the cockpit's width and layout authorities are INSTRUMENTED here, never re-implemented. Both
// wrappers call straight through, so every suite in this file sees the real frame; the recordings
// and the two overrides below are what a copied constant, an unused import or a local helper the
// shipped command never calls cannot produce.
const widthCalls = vi.hoisted(() => ({
  measured: [] as string[],
  wrapped: [] as string[],
  fitted: [] as string[],
  // The NEGATIVE CONTROL, armed per render: the shipped renderer draws through a local UTF-16
  // code-unit width model — the measure this task deletes — instead of the cockpit authority. It
  // bills ANSI bytes and combining marks cells they never draw and under-bills a wide cluster.
  codeUnits: false,
  localWidth: (text: string) => text.length,
  localWrap: (text: string, maxCells: number): string[] => {
    const budget = Math.max(1, Math.floor(maxCells));
    const rows: string[] = [];
    for (let at = 0; at < text.length; at += budget) rows.push(text.slice(at, at + budget));
    return rows.length > 0 ? rows : [""];
  },
  localFit: (text: string, cells: number): string =>
    cells < 1 ? "" : text.slice(0, cells).padEnd(cells),
}));
vi.mock("../../src/tui/cockpit/width.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/cockpit/width.js")>();
  return {
    ...actual,
    cellWidth: (text: string) => {
      widthCalls.measured.push(text);
      return widthCalls.codeUnits ? widthCalls.localWidth(text) : actual.cellWidth(text);
    },
    wrapCells: (
      text: string,
      maxCells: number,
      options?: Parameters<typeof actual.wrapCells>[2],
    ) => {
      widthCalls.wrapped.push(text);
      return widthCalls.codeUnits
        ? widthCalls.localWrap(text, maxCells)
        : actual.wrapCells(text, maxCells, options);
    },
    fitCells: (text: string, cells: number) => {
      widthCalls.fitted.push(text);
      return widthCalls.codeUnits ? widthCalls.localFit(text, cells) : actual.fitCells(text, cells);
    },
  };
});
const layoutOverride = vi.hoisted(() => ({
  columnFloor: undefined as number | undefined,
  priority: undefined as readonly string[] | undefined,
}));
vi.mock("../../src/tui/cockpit/layout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/cockpit/layout.js")>();
  return {
    ...actual,
    get COCKPIT_COLUMN_FLOOR() {
      return layoutOverride.columnFloor ?? actual.COCKPIT_COLUMN_FLOOR;
    },
    get LAYOUT_PRIORITY() {
      return (layoutOverride.priority ?? actual.LAYOUT_PRIORITY) as typeof actual.LAYOUT_PRIORITY;
    },
  };
});

// T3 (v1.50): the watch cockpit restyles the TTY frame through src/brand.ts. The non-TTY
// surface is machine-consumed and byte-pinned; its task column follows the graph title contract.

const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];
const GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "done", goal: "Finish report, then archive it.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T2", title: "failed", goal: "Run mixed gates; stop on failure.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T3", title: "starved", goal: "Queue the undispatched follow-up.", shape: "implement", complexity: 3, deps: ["T2"], acceptance: ["a"], gates: mandatoryGates },
  ],
});

// Deterministic fixture: events backdated exactly 10 minutes (age renders "10m" for the next
// ~50s of wall clock), a garbage pid (renders "unknown", never probes), fixed 120 columns.
const seed = (repo: string) => {
  saveGraph(repo, GRAPH);
  const ts = new Date(Date.now() - 600_000).toISOString();
  const events: JournalEvent[] = [
    { ts, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: graphDefinitionHash(GRAPH) } },
    { ts, event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" } } },
    { ts, event: "gate-result", taskId: "T1", data: { gate: "build", pass: true } },
    { ts, event: "gate-result", taskId: "T1", data: { gate: "test", pass: true } },
    { ts, event: "task-done", taskId: "T1", data: {} },
    { ts, event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" } } },
    { ts, event: "gate-result", taskId: "T2", data: { gate: "build", pass: true } },
    { ts, event: "gate-result", taskId: "T2", data: { gate: "test", pass: false } },
    { ts, event: "task-failed", taskId: "T2", data: {} },
    { ts, event: "context-sample", taskId: "T2", data: { tokens: 1234, threshold: 170_000, attempt: 0 } },
  ];
  const dir = join(tickmarkrDir(repo), "runs", "run-brand");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const withStdout = async (tty: boolean, fn: () => Promise<void>) => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  delete process.env.NO_COLOR;
  try {
    await fn();
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

// ── T8 board fixture: the two ids the id column must be sized by (the shortest the schema allows
// and the longest), a title carrying wide clusters and a combining mark, and a task whose two
// blockers are both unlanded — the structure a narrowing board must keep naming.
const BOARD_LONG_ID = "T_cockpit_width_authority_at_the_schema_maximum_identifier_lengt";
const BOARD_WIDE_TITLE = `日本語の幅 e${"́"} combining title`;
const BOARD_GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T9", title: "compile the graph", goal: "Compile the graph.", shape: "implement", complexity: 3, acceptance: ["a"] },
    { id: BOARD_LONG_ID, title: BOARD_WIDE_TITLE, goal: "Migrate the width call sites.", shape: "implement", complexity: 3, acceptance: ["a"] },
    { id: "T3", title: "waits on both", goal: "Land behind both.", shape: "implement", complexity: 3, deps: ["T9", BOARD_LONG_ID], acceptance: ["a"] },
  ],
});

// A released human gate leaves T3 pending with both deps still in flight — a real journal in which
// the board owes the operator the blockers by name.
const boardRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-board-"));
  saveGraph(repo, BOARD_GRAPH);
  const at = new Date(Date.now() - 600_000).toISOString();
  const events: JournalEvent[] = [
    // A live daemon: with no run-end and a dead pid the fold would read both dispatches as
    // interrupted, which starves T3 and retires the dependency naming this fixture exists for.
    { ts: at, event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(BOARD_GRAPH) } },
    { ts: at, event: "task-dispatch", taskId: "T9", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0 } },
    { ts: at, event: "task-dispatch", taskId: BOARD_LONG_ID, data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" }, attempt: 0 } },
    { ts: at, event: "gate-result", taskId: BOARD_LONG_ID, data: { gate: "build", pass: true } },
    { ts: at, event: "context-sample", taskId: "T9", data: { tokens: 12_345, threshold: 170_000, attempt: 0 } },
    { ts: at, event: "task-human", taskId: "T3", data: { kind: "designed-gate" } },
    { ts: at, event: "task-approved", taskId: "T3", data: { gate: "human" } },
  ];
  const dir = join(tickmarkrDir(repo), "runs", "run-board");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return repo;
};

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");
const taskBlock = (frame: string, taskId: string): string => {
  const lines = strip(frame).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {4}${taskId}(?:\\s|$)`).test(line));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^ {4}T/u.test(lines[end]!)) end += 1;
  return lines.slice(start, end).join("\n");
};
const taskHead = (frame: string, taskId: string): string =>
  frame.split("\n").find((line) => new RegExp(`^ {4}(?:\\x1b\\[[\\d;]*m)*${taskId}(?:\\s|$)`).test(line))!;

/** One bounded watch frame at a named terminal width, with the cockpit's own writes swallowed. */
const boardFrame = async (repo: string, columns: number): Promise<string> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const cols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  delete process.env.NO_COLOR;
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await status(["--watch"], repo, { iterations: 1, sleep: async () => {} });
  } finally {
    spy.mockRestore();
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (cols) Object.defineProperty(process.stdout, "columns", cols);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

/**
 * The negative control: the SAME journal drawn by the SAME shipped command, with the local
 * code-unit width model armed in place of the cockpit authority. Whatever this returns is what a
 * copied helper, a hand-rolled `vw`/`pad`/`fit` or an unused import would have drawn.
 */
const controlFrame = async (repo: string, columns: number): Promise<string> => {
  widthCalls.codeUnits = true;
  try {
    return await boardFrame(repo, columns);
  } finally {
    widthCalls.codeUnits = false;
  }
};

describe("T3 watch cockpit brand restyle", () => {
  test("status non-tty output remains byte-pinned around the task-title column", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(false, async () => {
      const out = await status([], repo);
      expect(out).toBe(
        "tickmarkr status / run run-brand / last event 10m ago / daemon pid unknown / 1/3 done\n" +
        "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review\n" +
        // no watcher has ever beaten in this fixture, and every tier says so rather than being omitted
        "  supervision: orchestrator ABSENT / overseer ABSENT / watch ABSENT\n" +
        "  [x] T1 done  B[x] T[x] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1\n" +
        "  [!] T2 failed  B[x] T[!] L[ ] E[ ] S[ ] A. R.  failed  fake:fake-2 / ctx 1234\n" +
        "  [ ] T3 starved  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  pending starved  -",
      );
    });
  });

  // one bounded watch frame with stdout captured — the cockpit write is banner + frame + footer
  const watchFrame = async (repo: string): Promise<string> => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await status(["--watch"], repo, { iterations: 1, sleep: async () => {} });
    } finally {
      spy.mockRestore();
    }
    return writes.join("");
  };

  test("the watch frame uses the approved themed-green chip and a dominant run id without the old four-row banner", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      expect(out).toContain(brandChip(" tickmarkr "));
      expect(out).toContain("\x1b[1mrun-brand\x1b[0m");
      expect(out).not.toContain("spec in, verified work out.");
    });
  });

  test("the approved table colors the done task id green and the failed task id red", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await status([], repo);
      expect(taskHead(out, "T1")).toContain("\x1b[38;5;41m");
      expect(taskHead(out, "T2")).toContain("\x1b[31m");
    });
  });

  test("the shipped task table keeps its dependency column and every task identity at 40, 110 and 220 columns through the cockpit width authority", async () => {
    expect(BOARD_LONG_ID).toHaveLength(64);
    expect(cellWidth(BOARD_WIDE_TITLE)).not.toBe(BOARD_WIDE_TITLE.length);
    const repo = boardRepo();

    for (const columns of [40, 110, 220]) {
      widthCalls.measured.length = 0;
      widthCalls.wrapped.length = 0;
      widthCalls.fitted.length = 0;
      const frame = await boardFrame(repo, columns);
      const plain = strip(frame);

      for (const line of frame.split("\n")) {
        expect(cellWidth(line), `${columns} cols: ${strip(line)}`).toBeLessThanOrEqual(columns);
      }
      expect(plain).toContain("deps");
      expect(plain).toContain("WHERE THE EFFORT WENT");
      const waiter = taskBlock(frame, "T3").replace(/\s+/gu, "");
      expect(waiter).toContain("T9");
      if (columns >= 110) expect(widthCalls.fitted).toContain(BOARD_WIDE_TITLE);
      expect(widthCalls.wrapped.some((text) => text.includes(BOARD_LONG_ID))).toBe(true);
    }

    // The control arms the exact deleted failure mode: local UTF-16 clipping on the same production
    // path. Wide/combining data must produce different bytes from the grapheme-aware renderer.
    expect(await controlFrame(repo, 110)).not.toBe(await boardFrame(repo, 110));
  });

  test("the watch footer renders as a single dim legend line on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      const footer = out.split("\n").at(-1)!;
      expect(footer).toBe("\x1b[2m watching · refresh 2s · ^C to quit\x1b[0m"); // legend(): one dim line, nothing after it
    });
  });
});
