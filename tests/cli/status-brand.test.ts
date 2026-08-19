import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BANNER } from "../../src/brand.js";
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
    fitCells: (text: string, cells: number) =>
      widthCalls.codeUnits ? widthCalls.localFit(text, cells) : actual.fitCells(text, cells),
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
/** Wrapping inserts whitespace and nothing else, so a squashed frame reassembles a wrapped run. */
const squash = (frame: string): string => strip(frame).replace(/\s+/gu, "");
// The card's IDENTITY row: the id in its own column, right after the row's verdict box or glyph.
// A card also names the dependents waiting on it, so a bare ` id ` search answers a blocker's
// machinery line for the task it blocks — a line with no status word to measure an offset against.
const cardHead = (frame: string, taskId: string): string =>
  frame.split("\n").find((line) => new RegExp(`^\\s*(?:\\[.\\]|\\S+)\\s+${taskId}\\b`).test(strip(line)))!;
/** Where a card's status word starts — the same offset in cells, a different one in code units. */
const statusOffset = (line: string, word: string): { cells: number; codeUnits: number } => {
  const bare = strip(line);
  const prefix = bare.slice(0, bare.lastIndexOf(word));
  return { cells: cellWidth(prefix), codeUnits: prefix.length };
};

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

  test("the watch frame renders the run title with emphasis on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await watchFrame(repo);
      expect(out).toContain(BANNER); // banner plus dominant run title
      expect(out).toContain("\x1b[1mrun run-brand\x1b[0m"); // title() emphasis on the run id
    });
  });

  test("a done task row renders the ok glyph and a failed task row renders the fail glyph on a tty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-brand-"));
    seed(repo);
    await withStdout(true, async () => {
      const out = await status([], repo);
      const row = (id: string) => out.split("\n").find((line) => new RegExp(`\\b${id}\\b`).test(line))!;
      expect(row("T1")).toContain("\x1b[38;5;41m✓\x1b[0m T1"); // ok() brand-green tickmark leads the done row
      expect(row("T2")).toContain("\x1b[31m✗\x1b[0m T2"); // fail() red cross leads the failed row
    });
  });

  test("status --watch renders one journal at 40 and 220 columns for a two-character task id and a schema-maximum 64-character ASCII id whose title carries wide and combining clusters, measuring every rendered line with the shared cockpit width authority rather than any local helper, and requiring structural dependency rows, so code-unit width, short-id fixtures or a helper the shipped command never calls all fail", async () => {
    expect(BOARD_LONG_ID).toHaveLength(64); // the schema's maximum task id, whole
    expect(cellWidth(BOARD_WIDE_TITLE)).not.toBe(BOARD_WIDE_TITLE.length); // the two models disagree
    const repo = boardRepo();

    for (const columns of [40, 220]) {
      widthCalls.measured.length = 0;
      const frame = await boardFrame(repo, columns);
      const measuredByRenderer = [...widthCalls.measured];

      // Every drawn line, measured in display cells by the shared authority — the cells a terminal
      // actually advances, not bytes and not UTF-16 code units.
      for (const line of frame.split("\n")) {
        expect(cellWidth(line), `${columns} cols: ${strip(line)}`).toBeLessThanOrEqual(columns);
      }
      // The measurement is the SHIPPED renderer's: it handed this title and this id to the
      // authority itself. A local helper, or one the command never calls, records nothing.
      expect(measuredByRenderer).toContain(BOARD_WIDE_TITLE);
      expect(measuredByRenderer).toContain(BOARD_LONG_ID);
      // Blocking dependencies are structural: every blocker is named at both widths, wrapped
      // across rows when it must be, and never reduced to a `+N` count.
      expect(squash(frame)).toContain(`dep-waitingonT9,${BOARD_LONG_ID}`);
    }

    // Column alignment is a cell fact. The wide/combining row lands its status word on the same
    // cell as the ASCII rows and on a different code-unit offset — so a code-unit width model, or
    // a fixture whose ids are all short enough to hide the id column, fails right here.
    const wide = await boardFrame(repo, 220);
    const heads: Array<[string, string]> = [["T9", "running"], [BOARD_LONG_ID, "running"], ["T3", "pending"]];
    const offsets = heads.map(([id, word]) => statusOffset(cardHead(wide, id), word));
    expect(new Set(offsets.map(({ cells }) => cells)).size).toBe(1);
    expect(new Set(offsets.map(({ codeUnits }) => codeUnits)).size).toBeGreaterThan(1);
  });

  test("instrument the production status renderer at 40 and 220 columns and record calls into the exported cockpit width and layout authorities for every wide/combining line. Compare with a control using local code-unit width so copied constants, unused imports or local helpers produce a different frame", async () => {
    const repo = boardRepo();
    const frames = new Map<number, string>();
    const controls = new Map<number, string>();
    /** Real display cells of a frame's widest drawn line — measured by the authority, never bytes. */
    const widest = (text: string): number =>
      Math.max(...text.split("\n").map((line) => cellWidth(line)));

    for (const columns of [40, 220]) {
      widthCalls.measured.length = 0;
      widthCalls.wrapped.length = 0;
      const frame = await boardFrame(repo, columns);
      frames.set(columns, frame);
      const measured = [...widthCalls.measured];
      const wrapped = [...widthCalls.wrapped];

      // Recorded calls into the width authority for the wide/combining row and for the row whose
      // dependencies are named: measured for its columns, then wrapped for its rows.
      expect(measured).toContain(BOARD_WIDE_TITLE);
      expect(wrapped.some((line) => line.includes(BOARD_LONG_ID))).toBe(true);
      expect(wrapped.some((line) => line.includes("dep-waiting on T9"))).toBe(true);

      // THE CONTROL FRAME: the same journal through the same shipped command, with a local
      // code-unit width model armed in place of the authority — the hand-rolled `vw`/`pad`/`fit`
      // this task refuses to carry. It draws a DIFFERENT frame at this width, in bytes and in
      // shape: a copied constant, an unused import or a local helper cannot produce the board
      // above.
      const control = await controlFrame(repo, columns);
      controls.set(columns, control);
      expect(control, `${columns} cols`).not.toBe(frame);
      expect(control.split("\n").length, `${columns} cols rows`).not.toBe(frame.split("\n").length);
      // Different by being WRONG: the code-unit model bills every ANSI byte and every combining
      // mark cells they never draw and under-bills wide clusters, so its board occupies a
      // different number of REAL cells than the one the authority planned — while production's
      // widest line still fits the columns it was given.
      expect(widest(control), `${columns} cols control`).not.toBe(widest(frame));
      expect(widest(frame), `${columns} cols production`).toBeLessThanOrEqual(columns);
    }

    // At the floor — the width where the model's error has nowhere to hide — the control's
    // under-billed wide clusters overrun the terminal the frame was asked to fit; at 220 the same
    // model instead wraps a line the authority knows fits, since zero-cell controls cost it bytes.
    expect(widest(controls.get(40)!)).toBeGreaterThan(40);
    expect(widest(controls.get(220)!)).toBeLessThan(widest(frames.get(220)!));

    // The column floor is READ from the layout authority, never copied: moving it redraws the
    // 40-column board at the floor the authority now states.
    layoutOverride.columnFloor = 64;
    const floored = await boardFrame(repo, 40);
    layoutOverride.columnFloor = undefined;
    expect(floored).not.toBe(frames.get(40));
    expect(Math.max(...floored.split("\n").map(cellWidth))).toBeGreaterThan(40);
    expect(Math.max(...frames.get(40)!.split("\n").map(cellWidth))).toBeLessThanOrEqual(40);

    // The shed order is the layout authority's too. Lifting the context tile above the journal
    // keeps it on a 40-column row that surrendered it before — and the dependency row, which sits
    // above the shed tail either way, is named in full in both frames.
    layoutOverride.priority = [
      "keybar", "statusStrip", "primaryHeader", "progressBar",
      "statTiles", "secondaryHeader", "journal", "progressCaption",
    ];
    const reordered = await boardFrame(repo, 40);
    layoutOverride.priority = undefined;
    expect(reordered).not.toBe(frames.get(40));
    expect(squash(reordered)).toContain("ctx12345");
    expect(squash(frames.get(40)!)).not.toContain("ctx12345");
    for (const frame of [reordered, frames.get(40)!]) {
      expect(squash(frame)).toContain(`dep-waitingonT9,${BOARD_LONG_ID}`);
      for (const line of frame.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(40);
    }
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
