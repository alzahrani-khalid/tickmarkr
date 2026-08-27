import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { COCKPIT_COLUMN_FLOOR } from "../../src/tui/cockpit/layout.js";

const RUN_ID = "run-live-phase";
const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const PHASE_STARTED = NOW - 8 * 60 * 60 * 1000;

// Every width the board can be asked to draw: the widest that holds the longest reading whole,
// down to the cockpit's own floor — the authority, never a literal copied out of it.
const BOARD_WIDTHS = Array.from(
  { length: 121 - COCKPIT_COLUMN_FLOOR + 1 },
  (_, index) => 121 - index,
);

const mkRepo = (): string => mkdtempSync(join(tmpdir(), "tickmarkr-status-live-phase-"));

const seedGraph = (repo: string) => {
  const graph = validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["plan.md"], hash: "status-live-phase" },
    tasks: [{
      id: "T1",
      title: "Ship the task",
      goal: "Ship the task.",
      shape: "implement",
      complexity: 3,
      acceptance: ["done"],
    }],
  });
  saveGraph(repo, graph);
  return graph;
};

const phaseJournal = (hash: string, pid: unknown, includePid = true): JournalEvent[] => [
  {
    ts: new Date(PHASE_STARTED - 2_000).toISOString(),
    event: "run-start",
    data: { ...(includePid ? { pid } : {}), graphDefinitionHash: hash },
  },
  {
    ts: new Date(PHASE_STARTED - 1_000).toISOString(),
    event: "task-dispatch",
    taskId: "T1",
    data: { attempt: 0, assignment: { adapter: "fake", model: "fake-1" } },
  },
  {
    ts: new Date(PHASE_STARTED).toISOString(),
    event: "phase-start",
    taskId: "T1",
    data: { phase: "worker", attempt: 0 },
  },
];

const writeJournal = (repo: string, events: JournalEvent[]): void => {
  const dir = join(tickmarkrDir(repo), "runs", RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
};

const plain = (value: string): string => value
  .replace(/\x1b\][^\x07]*\x07/gu, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");

const flattened = (value: string): string => plain(value).replace(/\s+/gu, " ");

// ── WHICH LAYER THIS REPAIR TOOK, AND WHY THE OTHER NEEDED NO CHANGE ────────────────────────────
//
// TAKEN: this case. `src/cli/commands/status.ts` is unchanged and correct.
//
// The board header is a TWO-COLUMN layout. The brand lockup owns a fixed gutter on the left — the
// chip on the first row, the running binary's version on the row directly beneath it — and the
// run's facts occupy the column to its right, wrapping under themselves. So the instant a fact is
// long enough to wrap across those first two rows, the version text sits physically BETWEEN the
// two halves of that fact, and a reader that whitespace-flattens the WHOLE frame splices `v2.1.3`
// into the middle of `daemon pid <n> alive`. That is a defect in the READING: the operator's
// terminal shows two columns side by side, never one stream, and the frame is right at every width.
//
// The renderer could not have owned it either, because the two invariants `status-brand.test.ts`
// pins on this surface — the lockup is two rows at EVERY width with the version starting in the
// brand's own column, and no rendered line may exceed the measured width — together force the
// version onto row two at column zero with fact row two beside it, at every width. Any fact that
// wraps across rows one and two is therefore split by the version BY CONSTRUCTION. Moving the
// version off row two, collapsing the lockup to one row, or letting the fact column overrun the
// measured width are the only ways out, and each breaks one of those pinned invariants.
//
// So the case reads the fact COLUMN rather than the frame: find the gutter from where the first
// fact begins on the brand row, then join that column across the header block. Wrapping inserts
// whitespace and nothing else, so re-joining the column reassembles the reading verbatim — at every
// width, and for a process id of any length.
const factColumn = (frame: string): string => {
  const lines = plain(frame).split("\n");
  const brandRow = lines.findIndex((line) => line.trimStart().startsWith("tickmarkr "));
  expect(brandRow, "the frame draws no brand lockup").toBeGreaterThanOrEqual(0);
  // The first fact on the brand row is the run id, so it locates the gutter without the case having
  // to re-derive the lockup's own width from the version string it happens to be built against.
  const gutter = lines[brandRow]!.indexOf(RUN_ID);
  expect(gutter, "the brand row names no run").toBeGreaterThan(0);
  // The lockup is two rows; every further fact row that continues beneath it has a blank gutter,
  // and the first line that puts anything of its own there has left the header block.
  const rows = lines.slice(brandRow, brandRow + 2);
  for (let at = brandRow + 2; at < lines.length && lines[at]!.slice(0, gutter).trim() === ""; at += 1) {
    rows.push(lines[at]!);
  }
  return rows.map((line) => line.slice(gutter)).join(" ").replace(/\s+/gu, " ").trim();
};

const watchFrame = async (
  repo: string,
  boardColumns = 120,
  readWorkerOutput?: () => Promise<string | undefined>,
): Promise<{ frame: string; writes: string }> => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  const writes: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: boardColumns });
  delete process.env.NO_COLOR;
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    const frame = await status(["--watch", RUN_ID], repo, {
      iterations: 2,
      sleep: async () => {},
      now: () => NOW,
      ...(readWorkerOutput ? { readWorkerOutput } : {}),
    });
    return { frame, writes: writes.join("") };
  } finally {
    write.mockRestore();
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

describe("status live phases require a daemon that is not proved dead", () => {
  test("test: a journal whose recorded daemon process id is provably dead and whose newest phase marker has no matching outcome renders no live phase in any task cell or terminal title; the same journal recording this live process renders it; a fold that never consults the liveness the same frame prints fails", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const deadPid = spawnSync("true").pid!;
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), deadPid));
    const deadScrape = vi.fn(async () => "stale pane output");

    const dead = await watchFrame(repo, 120, deadScrape);
    expect(factColumn(dead.frame)).toContain(`daemon pid ${deadPid} dead`);
    expect(flattened(dead.frame)).not.toContain("worker · 8h0m0s elapsed");
    expect(dead.writes).not.toContain("\x1b]0;⏳ T1 worker");
    expect(deadScrape).not.toHaveBeenCalled();

    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), process.pid));
    const liveScrape = vi.fn(async () => "live pane output");
    const live = await watchFrame(repo, 120, liveScrape);
    expect(factColumn(live.frame)).toContain(`daemon pid ${process.pid} alive`);
    expect(flattened(live.frame)).toContain("worker · 8h0m0s elapsed");
    expect(live.writes).toContain("\x1b]0;⏳ T1 worker 8h0m0s\x07");
    expect(liveScrape).toHaveBeenCalled();
  });

  test("test: the reading a live daemon's watch frame prints is recovered at every board width from one hundred and twenty-one columns down to the cockpit's own floor, including the width one cell below the one where it currently survives; a case exercising only the width where the fact column happens to hold it whole passes today and fails wherever a process id needs one more digit", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), process.pid));

    // 121 down to the floor, one cell at a time: the sweep walks straight through the width one
    // below whichever one happens to hold this machine's identifier whole, so no digit count can
    // leave the wrap unexercised.
    let wrapped = 0;
    for (const columns of BOARD_WIDTHS) {
      const { frame } = await watchFrame(repo, columns);
      expect(factColumn(frame), `${columns} cols`).toContain(`daemon pid ${process.pid} alive`);
      if (!flattened(frame).includes(`daemon pid ${process.pid} alive`)) wrapped += 1;
    }
    // …and the sweep is not vacuous: at some of those widths the fact really does wrap around the
    // lockup, which is the case a fixed-width reading never reaches.
    expect(wrapped, "no swept width wraps the reading — the sweep proves nothing").toBeGreaterThan(0);
  });

  test("test: at each of those widths the same journal recording a provably dead process id still yields the dead reading and never the live one, so a case that stopped telling the two apart in order to survive the wrap fails", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const deadPid = spawnSync("true").pid!;
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), deadPid));

    for (const columns of BOARD_WIDTHS) {
      const { frame } = await watchFrame(repo, columns);
      const reading = factColumn(frame);
      expect(reading, `${columns} cols`).toContain(`daemon pid ${deadPid} dead`);
      // Recovering the reading may not be bought by ceasing to read it: the live word is absent
      // from the whole frame, not merely absent from the column the recovery happens to join.
      expect(reading, `${columns} cols`).not.toContain("alive");
      expect(flattened(frame), `${columns} cols`).not.toContain("alive");
      expect(flattened(frame), `${columns} cols`).not.toContain("worker · 8h0m0s elapsed");
    }
  });

  test("test: a journal recording a six-digit process id renders that reading recoverable at the width where a five-digit one survives; an assertion exercised only against the identifiers this machine issues passes here and fails on a runner whose identifiers are longer", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    // Six digits, written into the journal rather than borrowed from this machine — the hosted
    // runner issues identifiers this long and the developer laptop that authored the failing case
    // did not, which is the entire difference between the red there and the green here.
    const sixDigitPid = 424_242;
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), sixDigitPid));
    // Liveness is decided here rather than by whatever happens to own that identifier on the host:
    // an unthrown probe is the shared predicate's own definition of alive.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const { frame } = await watchFrame(repo, 120);
      expect(factColumn(frame)).toContain(`daemon pid ${sixDigitPid} alive`);
      // One hundred and twenty is exactly the width at which a five-digit identifier is held whole,
      // and one more digit pushes this one around the lockup — so the whole-frame reading the
      // failing case used cannot see it here, and the column reading can.
      expect(flattened(frame)).not.toContain(`daemon pid ${sixDigitPid} alive`);
      expect(flattened(frame)).toContain("worker · 8h0m0s elapsed");
    } finally {
      kill.mockRestore();
    }
  });

  test("test: a journal whose recorded daemon process id is absent or is not a positive integer still renders its unmatched phase marker; a guard suppressing on anything short of a proved death blanks every pre-identity journal and fails", async () => {
    for (const reading of [
      { includePid: false, pid: undefined },
      { includePid: true, pid: 0 },
      { includePid: true, pid: -7 },
      { includePid: true, pid: 1.5 },
      { includePid: true, pid: "123" },
    ]) {
      const repo = mkRepo();
      const graph = seedGraph(repo);
      writeJournal(repo, phaseJournal(graphDefinitionHash(graph), reading.pid, reading.includePid));

      const frame = plain(await status([RUN_ID], repo, { now: () => NOW }));
      expect(frame).toContain("daemon pid unknown");
      expect(frame).toContain("worker · 8h0m0s elapsed");
    }
  });

  test("test: a process id whose signal probe is refused for permission still renders its live phase because the shared liveness predicate calls it alive; a locally written probe treating any thrown error as death fails", async () => {
    const repo = mkRepo();
    const graph = seedGraph(repo);
    const refusedPid = 424_242;
    writeJournal(repo, phaseJournal(graphDefinitionHash(graph), refusedPid));
    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw permissionError; });
    try {
      const frame = plain(await status([RUN_ID], repo, { now: () => NOW }));
      expect(frame).toContain(`daemon pid ${refusedPid} alive`);
      expect(frame).toContain("worker · 8h0m0s elapsed");
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
    }
  });

  test("the live-phase fold and the daemon liveness line read one derived liveness value, so a diff leaving each of them to probe the process id on its own fails", () => {
    const source = readFileSync(new URL("../../src/cli/commands/status.ts", import.meta.url), "utf8");

    expect(source.match(/\bdaemonLiveness\(events\)/gu)).toHaveLength(1);
    expect(source.match(/\bisPidLive\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/process\.kill\s*\(/u);
    expect(source).toMatch(/const phases = comparable && daemon\.state !== "dead" \? livePhases\(events\)/u);
    expect(source.match(/liveness\(events, daemon, now\)/gu)).toHaveLength(2);
  });
});
