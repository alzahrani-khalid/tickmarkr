import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import {
  beatSupervision,
  publishStandDown,
  readSupervision,
  supervisionBeatPath,
  supervisionText,
  type SupervisionTier,
} from "../../src/run/supervision.js";

// The visual header prints load1; pin it so two renders of one fixture compare byte for byte.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, loadavg: () => [1.23, 0, 0] }, loadavg: () => [1.23, 0, 0] };
});

// v2.17.0 T3: the TTY board hides quiet supervision and prints only recorded evidence under a task.
// Zero-token fixtures, as in status-board-story: a temporary graph and journal per case, no daemon,
// no agent CLI, and an empty global config home. 80 columns is the stacked layout, 120 the wide one.

const at = "2026-11-01T08:00:00.000Z";
const FRAME_NOW = Date.parse("2026-11-01T08:10:00.000Z");
const RUN = "run-quiet";

const stripSgr = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");
const squash = (text: string): string => text.replace(/\s+/gu, " ").trim();

const GRAPH: RunGraph = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["quiet"], hash: "quiet" },
  tasks: ["T1", "T2", "T3"].map((id) => ({
    id,
    title: `Quiet task ${id}`,
    goal: `Work ${id}.`,
    shape: "implement",
    complexity: 3,
    acceptance: ["the work is done"],
    gates: ["build", "test", "lint", "evidence", "scope"],
  })),
});

const dispatch = (taskId: string): JournalEvent =>
  ({ ts: at, event: "task-dispatch", taskId, data: { attempt: 0, assignment: { adapter: "fake", model: "fake-1" } } });

/** T1 merged; T2 parked owing a decision with a recorded role; T3 parked owing one with no role recorded. */
const boardEvents = (role: string): JournalEvent[] => [
  { ts: at, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: graphDefinitionHash(GRAPH) } },
  dispatch("T1"),
  { ts: at, event: "worker-result", taskId: "T1", data: { ok: true, finished: true } },
  { ts: at, event: "task-done", taskId: "T1", data: {} },
  { ts: at, event: "merge", taskId: "T1", data: { branch: `tickmarkr/${RUN}--T1`, commit: "abc1234" } },
  dispatch("T2"),
  { ts: at, event: "task-human", taskId: "T2", data: { kind: "human-gate", reason: "Please decide", role } },
  dispatch("T3"),
  { ts: at, event: "task-human", taskId: "T3", data: { kind: "attempt-cap", reason: "three attempts spent" } },
];
// The park tokens are each park's journal line (1-based) and timestamp.
const T2_PARK = `7@${at}`;
const T3_PARK = `9@${at}`;

const seed = (events: readonly JournalEvent[]): string => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-status-quiet-"));
  saveGraph(repo, GRAPH);
  const runDir = join(tickmarkrDir(repo), "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return repo;
};

const withSurface = async <T>(tty: boolean, columns: number, body: () => Promise<T>): Promise<T> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const priorNoColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  delete process.env.NO_COLOR;
  try {
    return await body();
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (oldColumns) Object.defineProperty(process.stdout, "columns", oldColumns);
    else delete (process.stdout as { columns?: number }).columns;
    if (priorNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = priorNoColor;
  }
};

// `now` omitted reads the real clock, which a freshly written supervision beat needs to read ARMED.
const oneShot = (repo: string, tty: boolean, columns: number, now?: () => number): Promise<string> =>
  withSurface(tty, columns, () => status([], repo, now ? { now } : {}));

// A bounded one-frame watch writes its frame to stdout as well as returning it; the write is muted.
const watchFrame = async (repo: string, columns: number, now?: () => number): Promise<string> => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await withSurface(true, columns, () =>
      status(["--watch"], repo, { iterations: 1, sleep: async () => undefined, ...(now ? { now } : {}) }));
  } finally {
    write.mockRestore();
  }
};

const VISUAL = [
  { name: "one-shot", render: (repo: string, columns: number, now?: () => number) => oneShot(repo, true, columns, now) },
  { name: "bounded watch", render: watchFrame },
] as const;

/** A task's rows on the board: its id row up to the next task row, the gates legend or a blank row. */
const taskBlock = (frame: string, id: string): string[] => {
  const lines = stripSgr(frame).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {4}${id}\\s`, "u").test(line));
  expect(start, `${id} has a task row`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) =>
    index > start && (line === "" || /^ {4}T\d+\s/u.test(line) || /^ {4}gates /u.test(line)));
  return lines.slice(start, end < 0 ? undefined : end);
};
/** The evidence row of a block, rejoined across its wraps; undefined when the block has none. */
const evidenceOf = (block: readonly string[]): string | undefined => {
  const start = block.findIndex((line) => /^ {4}phase /u.test(line));
  return start < 0 ? undefined : squash(block.slice(start).join(" "));
};
const tasksSection = (frame: string): string => {
  const plain = stripSgr(frame);
  return plain.slice(plain.indexOf("TASKS"), plain.indexOf("    gates "));
};

const obligationPath = (repo: string, tier: SupervisionTier): string =>
  join(dirname(supervisionBeatPath(repo, tier)), `${tier}.clear-owed`);

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "tickmarkr-quiet-config-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("status board story: quiet supervision and recorded-only evidence", () => {
  test("the TTY board hides the supervision legend for all-absent and for absent-or-disarmed-only supervision without obligations, and keeps the complete legend for an armed watch and for a disarmed tier carrying a recorded or an unreadable clear obligation", async () => {
    const allAbsent = seed(boardEvents("reviewer"));
    const disarmedOnly = seed(boardEvents("reviewer"));
    publishStandDown(disarmedOnly, "overseer", "w1:p1");
    publishStandDown(disarmedOnly, "watch", "board");
    const armedWatch = seed(boardEvents("reviewer"));
    beatSupervision(armedWatch, "watch");
    const recordedObligation = seed(boardEvents("reviewer"));
    publishStandDown(recordedObligation, "overseer-context", "w1:p2");
    writeFileSync(obligationPath(recordedObligation, "overseer-context"), JSON.stringify({
      tier: "overseer-context", clearOwedSince: at, armId: "arm-quiet", thresholdPct: 75,
    }) + "\n");
    const unreadableObligation = seed(boardEvents("reviewer"));
    publishStandDown(unreadableObligation, "overseer-context", "w1:p2");
    writeFileSync(obligationPath(unreadableObligation, "overseer-context"), "not a record\n");

    // Controls: each fixture reads as named, so a hidden or kept legend below is about the board.
    const states = (repo: string) => readSupervision(repo).map((tier) => tier.state);
    expect(states(allAbsent)).toEqual(["ABSENT", "ABSENT", "ABSENT", "ABSENT", "ABSENT"]);
    expect(states(disarmedOnly)).toEqual(["ABSENT", "ABSENT", "DISARMED", "ABSENT", "DISARMED"]);
    const kept: [string, string, string][] = [
      ["armed watch", armedWatch, "watch ARMED"],
      ["recorded obligation", recordedObligation, `overseer-context DISARMED (w1:p2) CLEAR-OWED since ${at}`],
      ["unreadable obligation", unreadableObligation, "overseer-context DISARMED (w1:p2) CLEAR-OWED unreadable"],
    ];
    for (const [variant, repo, token] of kept) expect(supervisionText(readSupervision(repo)), variant).toContain(token);

    for (const { name, render } of VISUAL) {
      for (const columns of [80, 120]) {
        const where = `${name} ${columns}`;
        for (const [variant, repo] of [["all absent", allAbsent], ["disarmed only", disarmedOnly]] as const) {
          const frame = stripSgr(await render(repo, columns));
          expect(frame, `${where} ${variant}`).toContain("TASKS");
          expect(frame, `${where} ${variant}`).not.toContain("supervision:");
          expect(frame, `${where} ${variant}`).not.toMatch(/\b(?:ABSENT|DISARMED)\b/u);
          // The plain print is unchanged: the same fixture still prints its supervision row there.
          expect(await oneShot(repo, false, columns), `${where} ${variant} plain`).toContain("  supervision: ");
        }
        for (const [variant, repo, token] of kept) {
          const frame = stripSgr(await render(repo, columns));
          const complete = supervisionText(readSupervision(repo));
          expect(frame.split("supervision:").length - 1, `${where} ${variant}`).toBe(1);
          expect(squash(frame), `${where} ${variant}`).toContain(squash(complete));
          expect(squash(frame), `${where} ${variant}`).toContain(token);
        }
      }
    }
  });

  test("in the stacked and the wide TTY layouts, through one-shot visual status and a bounded one-frame visual watch, a merged task keeps its task row without an evidence row, while an unmerged parked task's evidence row keeps its recorded phase, timestamp, responsibility, blocker, next action and needs your decision, with no placeholder for an absent fact", async () => {
    const repo = seed(boardEvents("reviewer"));
    const now = (): number => FRAME_NOW;
    for (const { name, render } of VISUAL) {
      for (const [columns, layout] of [[80, "stacked"], [120, "wide"]] as const) {
        const where = `${name} ${columns} ${layout}`;
        const frame = await render(repo, columns, now);
        // Control: the width really selects the named layout (only the wide one draws a column header).
        expect(/^\s+area\s+deps\s+task\s/mu.test(stripSgr(frame)), where).toBe(layout === "wide");

        const merged = taskBlock(frame, "T1");
        const rows = merged.filter((line) => line.trim());
        expect(rows[0], where).toMatch(/^ {4}T1\s.*Quiet task T1/u);
        expect(rows, where).toHaveLength(layout === "stacked" ? 2 : 1);
        if (layout === "stacked") expect(rows[1], where).toMatch(/^ {4}deps /u);
        // An empty evidence text emits nothing — not an indented or styled empty row. The only blank row
        // a merged task keeps is the stacked layout's own (empty) note row.
        expect(merged.filter((line) => !line.trim()), where).toHaveLength(layout === "stacked" ? 1 : 0);
        expect(evidenceOf(merged), where).toBeUndefined();
        expect(squash(merged.join(" ")), where).not.toMatch(/phase|evidence|responsible|blocker|next action|decision/u);

        expect(evidenceOf(taskBlock(frame, "T2")), where).toBe(
          `phase terminal · last evidence ${at} · responsible reviewer · blocker human-decision`
          + ` · next action Choose a decision: approve: tickmarkr approve ${RUN} T2 --park ${T2_PARK} · needs your decision`,
        );
        // No role was recorded for T3: the fact is omitted, never rendered as a placeholder.
        expect(evidenceOf(taskBlock(frame, "T3")), where).toBe(
          `phase terminal · last evidence ${at} · blocker human-decision`
          + ` · next action Choose a decision: approve: tickmarkr approve ${RUN} T3 --park ${T3_PARK} · needs your decision`,
        );
        expect(squash(tasksSection(frame)), where)
          .not.toMatch(/unrecorded|blocker none|human-decision (?:yes|no)|responsible ·/u);
      }
    }
  });

  test("a hostile recorded responsibility string on the TTY board emits no terminal control sequence and no extra logical row", async () => {
    // OSC title, BEL, CR/LF, an erase-display CSI, a C1 CSI and a tab. Sanitized, it reads exactly as
    // the benign role below, so the two frames must be byte-identical.
    const hostile = seed(boardEvents("rev\u001b]0;owned\u0007iewer\r\n\u001b[2J\u009b31mx\tend"));
    const benign = seed(boardEvents("reviewer x end"));
    const now = (): number => FRAME_NOW;
    for (const { name, render } of VISUAL) {
      for (const columns of [80, 120]) {
        const where = `${name} ${columns}`;
        const hostileFrame = await render(hostile, columns, now);
        const benignFrame = await render(benign, columns, now);
        expect(stripSgr(hostileFrame), where).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
        expect(hostileFrame.split("\n").length, where).toBe(benignFrame.split("\n").length);
        expect(hostileFrame, where).toBe(benignFrame);
        // Control: the recorded role really reaches the board, sanitized, in T2's evidence row.
        expect(evidenceOf(taskBlock(hostileFrame, "T2")), where).toContain("responsible reviewer x end · blocker human-decision");
      }
    }
  });
});
