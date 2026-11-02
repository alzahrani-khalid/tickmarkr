import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

// The visual header prints load1; pin it so two renders of one fixture compare byte for byte.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, loadavg: () => [1.23, 0, 0] }, loadavg: () => [1.23, 0, 0] };
});

// v2.17.0 T2: the TTY board's one next action, right after the lead rows and before the header.
// Zero-token fixtures adapted from the status suites: a temporary graph and journal per case, no
// daemon, no agent CLI, a fixed frame clock, and an empty global config home.

const at = "2026-11-01T08:00:00.000Z";
const FRAME_NOW = Date.parse("2026-11-01T08:10:00.000Z");
const fixedNow = (): number => FRAME_NOW;
const RUN = "run-story";
const BRANCH = "tickmarkr/run-story";
const MERGE_ADVICE = `next: review the work on ${BRANCH} and merge it yourself — tickmarkr never merges to main`;
const WATCH_ADVICE = "next: follow it live — tickmarkr status --watch";
const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];

const stripSgr = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");

const graphFor = (ids: readonly string[], hash = "story", statuses: Record<string, string> = {}): RunGraph => validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["story"], hash },
  tasks: ids.map((id, index) => ({
    id,
    ...(statuses[id] === undefined ? {} : { status: statuses[id] }),
    title: `Story task ${id}`,
    goal: `Tell part ${index + 1} of the story.`,
    shape: "implement",
    complexity: 3,
    acceptance: ["the story is told"],
    gates: mandatoryGates,
  })),
});

const runStart = (graph: RunGraph, pid: unknown): JournalEvent =>
  ({ ts: at, event: "run-start", data: { pid, graphDefinitionHash: graphDefinitionHash(graph) } });
const dispatch = (taskId: string): JournalEvent => ({
  ts: at,
  event: "task-dispatch",
  taskId,
  data: { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" } },
});
const finishedTask = (taskId: string): JournalEvent[] => [
  dispatch(taskId),
  { ts: at, event: "worker-result", taskId, data: { ok: true, finished: true } },
  { ts: at, event: "task-done", taskId, data: {} },
  { ts: at, event: "merge", taskId, data: { branch: `tickmarkr/${RUN}--${taskId}`, commit: "abc1234" } },
];
const runEnd = (data: Record<string, unknown>): JournalEvent => ({
  ts: at,
  event: "run-end",
  data: { done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [], ...data },
});
const park = (taskId: string, data: Record<string, unknown>): JournalEvent =>
  ({ ts: at, event: "task-human", taskId, data });

const seed = (graph: RunGraph, events: readonly JournalEvent[]): string => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-status-story-"));
  saveGraph(repo, graph);
  const runDir = join(tickmarkrDir(repo), "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return repo;
};

const FINISHED_GRAPH = graphFor(["T1", "T2"]);
const finishedEvents = (end: Record<string, unknown> = { branch: BRANCH, tipVerify: "passed" }): JournalEvent[] => [
  runStart(FINISHED_GRAPH, "not-a-pid"),
  ...finishedTask("T1"),
  ...finishedTask("T2"),
  runEnd(end),
];
const finishedFixture = (end?: Record<string, unknown>): string => seed(FINISHED_GRAPH, finishedEvents(end));

// Graph order T1..T4; journal order parks T3 before T2, so graph order — not record order — must win.
const PARKED_GRAPH = graphFor(["T1", "T2", "T3", "T4"]);
const parkedFixture = (pid: unknown): string => seed(PARKED_GRAPH, [
  runStart(PARKED_GRAPH, pid),
  dispatch("T1"),
  park("T1", { kind: "scope-request", reason: "needs src/other.ts" }),
  dispatch("T3"),
  park("T3", { kind: "attempt-cap", reason: "three attempts spent" }),
  dispatch("T2"),
  park("T2", { kind: "human-gate", reason: "Please decide", role: "reviewer" }),
  ...finishedTask("T4"),
]);

type Surface = { tty: boolean; columns: number; noColor?: boolean };
const withSurface = async <T>({ tty, columns, noColor = false }: Surface, body: () => Promise<T>): Promise<T> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const priorNoColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  if (noColor) process.env.NO_COLOR = "1";
  else delete process.env.NO_COLOR;
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

const oneShot = (repo: string, surface: Surface): Promise<string> =>
  withSurface(surface, () => status([], repo, { now: fixedNow }));

// A bounded one-frame watch writes its frame to stdout as well as returning it; the write is muted.
const watchFrame = async (repo: string, surface: Surface): Promise<string> => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await withSurface(surface, () =>
      status(["--watch"], repo, { iterations: 1, now: fixedNow, sleep: async () => undefined }));
  } finally {
    write.mockRestore();
  }
};

type Renderer = { name: string; render: (repo: string, columns: number) => Promise<string> };
const VISUAL: readonly Renderer[] = [
  { name: "one-shot", render: (repo, columns) => oneShot(repo, { tty: true, columns }) },
  { name: "bounded watch", render: (repo, columns) => watchFrame(repo, { tty: true, columns }) },
];

/**
 * Splits a visual frame at its seams: the lead rows (identical to the plain print's lead at the same
 * width), whatever sits between them and the two-row brand lockup, and the lockup's first row.
 */
const seams = async (repo: string, frame: string, columns: number) => {
  const plain = (await oneShot(repo, { tty: false, columns })).split("\n");
  const plainLead = plain.slice(0, plain.findIndex((line) => line.startsWith("tickmarkr status")));
  const lines = stripSgr(frame).split("\n");
  const header = lines.findIndex((line) => line.startsWith(" tickmarkr "));
  expect(plainLead.length, "the plain print opens with lead rows").toBeGreaterThan(0);
  expect(header, "the visual frame draws its brand lockup").toBeGreaterThan(0);
  return {
    lines,
    lead: lines.slice(0, plainLead.length),
    plainLead,
    story: lines.slice(plainLead.length, header),
    header,
  };
};

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "tickmarkr-story-config-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const PARK_ADVICE = "next: T2 needs you — Choose a decision: approve: tickmarkr approve run-story T2 --park 7@2026-11-01T08:00:00.000Z";

describe("status board story: one next action after the lead rows", () => {
  test("a comparable finished fixture whose tasks all have task-done and merge records, whose newest run-end records the branch tickmarkr/run-story and a passed tip verify, and whose daemon is not alive shows the exact review-and-merge message naming that branch directly after the lead rows and before the header", async () => {
    const repo = finishedFixture();
    for (const { name, render } of VISUAL) {
      for (const columns of [120, 220]) {
        const frame = await render(repo, columns);
        const { lead, plainLead, story } = await seams(repo, frame, columns);
        // The complete lead comes first, unchanged; the message alone follows it, then the lockup.
        expect(lead, `${name} ${columns}`).toEqual(plainLead);
        expect(story, `${name} ${columns}`).toEqual([MERGE_ADVICE]);
        expect(stripSgr(frame).split("\n").filter((line) => line.includes("merge it yourself")), `${name} ${columns}`)
          .toEqual([MERGE_ADVICE]);
      }
      // Narrow: the same message, wrapped by the board's own rows — never cut, never moved.
      const narrow = await render(repo, 80);
      const { lead, plainLead, story } = await seams(repo, narrow, 80);
      expect(lead, `${name} 80`).toEqual(plainLead);
      expect(story.length, `${name} 80`).toBeGreaterThan(1);
      expect(story.map((row) => row.trim()).join(" "), `${name} 80`).toBe(MERGE_ADVICE);
    }
  });

  test("an unmerged parked task whose blocker requires a decision and records a next action supplies the next message ahead of a live daemon, the first of two eligible parks in graph order wins, and a park lacking either condition supplies no message", async () => {
    // Live daemon (this process), three parks: T1 owes no decision, T3 was parked before T2, and
    // graph order puts T2 first — so T2's decision is the one next action, ahead of the watch line.
    const parked = parkedFixture(process.pid);
    for (const { name, render } of VISUAL) {
      for (const columns of [120, 220]) {
        const frame = await render(parked, columns);
        const { lead, plainLead, story } = await seams(parked, frame, columns);
        expect(lead, `${name} ${columns}`).toEqual(plainLead);
        expect(story, `${name} ${columns}`).toEqual([PARK_ADVICE]);
        expect(stripSgr(frame), `${name} ${columns}`).not.toContain(WATCH_ADVICE);
        expect(stripSgr(frame), `${name} ${columns}`).not.toContain("next: T3");
      }
    }

    // A park that owes no decision (scope-request: no verb, a recorded next action) and a park with no
    // recorded next action (a parked graph status with no park row) supply nothing: a live daemon's
    // watch line follows, and without one nothing is said.
    const lacking = (pid: unknown): string => {
      const graph = graphFor(["T1", "T2"], "story", { T2: "human" });
      return seed(graph, [
        runStart(graph, pid),
        dispatch("T1"),
        park("T1", { kind: "scope-request", reason: "needs src/other.ts" }),
      ]);
    };
    const live = lacking(process.pid);
    const quiet = lacking("not-a-pid");
    for (const { name, render } of VISUAL) {
      for (const columns of [120, 220]) {
        expect((await seams(live, await render(live, columns), columns)).story, `${name} ${columns}`).toEqual([WATCH_ADVICE]);
        const silent = await render(quiet, columns);
        expect((await seams(quiet, silent, columns)).story, `${name} ${columns}`).toEqual([]);
        expect(stripSgr(silent), `${name} ${columns}`).not.toContain("next: ");
      }
    }
    // The fixture's T1 really is a park with a recorded next action and no decision owed, and its T2
    // really is parked with no recorded next action.
    const plain = (await oneShot(quiet, { tty: false, columns: 120 })).split("\n");
    const evidence = (id: string): string => plain[plain.findIndex((line) => line.startsWith(`  [!] ${id} `)) + 1]!;
    expect(evidence("T1")).toContain("blocker human-decision · next action scope-request requires");
    expect(evidence("T1")).toMatch(/ · human-decision no$/u);
    expect(evidence("T2")).toMatch(/ · blocker unknown · next action unrecorded · human-decision no$/u);
  });

  test("at 80 and 220 columns, one-shot visual status and a bounded one-frame visual watch show the watch message for a live daemon and no message when none applies; changing the finished fixture to a failed or unrecorded tip, an incomparable graph, a later resume without a new run-end, or a newest run-end without a branch never yields merge advice; and a hostile branch string emits no terminal control sequence and no extra logical row", async () => {
    const liveGraph = graphFor(["T1", "T2"]);
    const live = seed(liveGraph, [runStart(liveGraph, process.pid), dispatch("T1")]);
    const quiet = seed(liveGraph, [runStart(liveGraph, "not-a-pid"), dispatch("T1")]);

    const incomparable = finishedFixture();
    saveGraph(incomparable, graphFor(["T1", "T2"], "changed-after-recording"));
    const resumed = seed(FINISHED_GRAPH, [
      ...finishedEvents(),
      { ts: at, event: "run-resume", data: { pid: "not-a-pid" } },
    ]);
    const branchless = seed(FINISHED_GRAPH, [
      ...finishedEvents(),
      { ts: at, event: "run-resume", data: { pid: "not-a-pid" } },
      runEnd({ tipVerify: "passed" }),
    ]);
    const noMergeAdvice: [string, string][] = [
      ["failed tip", finishedFixture({ branch: BRANCH, tipVerify: "failed" })],
      ["unrecorded tip", finishedFixture({ branch: BRANCH })],
      ["incomparable graph", incomparable],
      ["later resume without a new run-end", resumed],
      ["newest run-end without a branch", branchless],
      ["empty branch", finishedFixture({ branch: "", tipVerify: "passed" })],
    ];

    // Hostile: OSC title, BEL, CR/LF, an erase-display CSI, a C1 CSI and a tab. Sanitized, it reads
    // exactly as the benign branch below, so the two frames must be byte-identical.
    const hostile = finishedFixture({ branch: "tickmarkr/run-\u001b]0;owned\u0007story\r\n\u001b[2J\u009b31mx\tend", tipVerify: "passed" });
    const benign = finishedFixture({ branch: "tickmarkr/run-story x end", tipVerify: "passed" });
    const control = finishedFixture();

    for (const { name, render } of VISUAL) {
      for (const columns of [80, 220]) {
        const where = `${name} ${columns}`;
        const liveFrame = await render(live, columns);
        const liveSeams = await seams(live, liveFrame, columns);
        expect(liveSeams.lead, where).toEqual(liveSeams.plainLead);
        expect(liveSeams.story, where).toEqual([WATCH_ADVICE]);

        const quietFrame = await render(quiet, columns);
        expect((await seams(quiet, quietFrame, columns)).story, where).toEqual([]);
        expect(stripSgr(quietFrame), where).not.toContain("next: ");

        // Control: the unchanged finished fixture does advise merging, so each variant below is a real negative.
        const controlStory = (await seams(control, await render(control, columns), columns)).story;
        expect(controlStory.map((row) => row.trim()).join(" "), where).toBe(MERGE_ADVICE);
        for (const [variant, repo] of noMergeAdvice) {
          const frame = await render(repo, columns);
          expect(stripSgr(frame), `${where} ${variant}`).not.toContain("merge it yourself");
          expect((await seams(repo, frame, columns)).story, `${where} ${variant}`).toEqual([]);
        }

        const hostileFrame = await render(hostile, columns);
        const benignFrame = await render(benign, columns);
        expect(hostileFrame, where).toBe(benignFrame);
        expect(stripSgr(hostileFrame), where).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
        expect(hostileFrame.split("\n").length, where).toBe(benignFrame.split("\n").length);
        const hostileStory = (await seams(hostile, hostileFrame, columns)).story;
        expect(hostileStory.map((row) => row.trim()).join(" "), where)
          .toBe("next: review the work on tickmarkr/run-story x end and merge it yourself — tickmarkr never merges to main");
      }
    }
  });

  test("at 120 columns the finished and parked fixtures rendered through non-TTY status and through TTY status with NO_COLOR set equal literal expected bytes for the whole output, lead rows, supervision, task rows and full evidence rows, with no next message", async () => {
    const finished = [
      "finished 2/2 done · tip verify passed · end-to-end first pass unknown (2 without lineage)",
      "time 0s wall, each instant once",
      "needs you: outstanding 0 · 0 parked · 0 failed",
      "tickmarkr status / run run-story / last event 10m ago / daemon pid unknown / verify passed / 2/2 done",
      "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review",
      "  supervision: orchestrator ABSENT / orchestrator-context ABSENT / overseer ABSENT / overseer-context ABSENT / watch ABSENT",
      "  [x] T1 Story task T1  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1",
      "    phase terminal · last evidence 2026-11-01T08:00:00.000Z · responsible unrecorded · blocker none · next action unrecorded · human-decision no",
      "  [x] T2 Story task T2  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1",
      "    phase terminal · last evidence 2026-11-01T08:00:00.000Z · responsible unrecorded · blocker none · next action unrecorded · human-decision no",
    ].join("\n");
    const parked = [
      "finished 1/4 done · tip verify pending · end-to-end first pass unknown (1 without lineage)",
      "time 0s wall, each instant once",
      "needs you: outstanding 0 · 3 parked · 0 failed",
      "tickmarkr status / run run-story abandoned since 2026-11-01T08:00:00.000Z / last event 10m ago / daemon pid unknown / 1/4 done",
      "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review",
      "  supervision: orchestrator ABSENT / orchestrator-context ABSENT / overseer ABSENT / overseer-context ABSENT / watch ABSENT",
      "  [!] T1 Story task T1  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  parked parked (scope-request)  fake:fake-1",
      "    phase terminal · last evidence 2026-11-01T08:00:00.000Z · responsible unrecorded · blocker human-decision · next action scope-request requires --files <glob,…> to widen files[], or --reason <text> to refuse the expansion and continue within the current files[] · human-decision no",
      "  [!] T2 Story task T2  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  parked parked (human-gate)  fake:fake-1",
      "    phase terminal · last evidence 2026-11-01T08:00:00.000Z · responsible reviewer · blocker human-decision · next action Choose a decision: approve: tickmarkr approve run-story T2 --park 7@2026-11-01T08:00:00.000Z · human-decision yes",
      "  [!] T3 Story task T3  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  parked parked (attempt-cap)  fake:fake-1",
      "    phase terminal · last evidence 2026-11-01T08:00:00.000Z · responsible unrecorded · blocker human-decision · next action Choose a decision: approve: tickmarkr approve run-story T3 --park 5@2026-11-01T08:00:00.000Z · human-decision yes",
      "  [x] T4 Story task T4  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1",
      "    phase terminal · last evidence 2026-11-01T08:00:00.000Z · responsible unrecorded · blocker none · next action unrecorded · human-decision no",
    ].join("\n");

    for (const [fixture, repo, expected] of [
      ["finished", finishedFixture(), finished],
      ["parked", parkedFixture("not-a-pid"), parked],
    ] as const) {
      const piped = await oneShot(repo, { tty: false, columns: 120 });
      const noColor = await oneShot(repo, { tty: true, columns: 120, noColor: true });
      expect(piped, `${fixture} non-TTY`).toBe(expected);
      expect(noColor, `${fixture} TTY NO_COLOR`).toBe(expected);
      expect(piped, fixture).not.toContain("next: ");
    }
  });
});
