import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { GLYPHS, LIVE } from "../../src/brand.js";
import { STATUS_HELP, status } from "../../src/cli/commands/status.js";
import { VERIFY_HELP, verify } from "../../src/cli/commands/verify.js";
import { narrationRow } from "../../src/cli/commands/run.js";
import { USAGE } from "../../src/cli/index.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { GATE_NAMES, validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

// Counts the journal reads one frame performs. The wrapper calls straight through, so every other
// test in this file sees the real filesystem — only the tally is added.
const journalReads = vi.hoisted(() => ({ count: 0 }));
const foldFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, loadavg: () => [1.23, 0, 0] }, loadavg: () => [1.23, 0, 0] };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const counted = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith("journal.jsonl")) journalReads.count += 1;
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync: counted }, readFileSync: counted };
});
vi.mock("../../src/tui/cockpit/derive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/cockpit/derive.js")>();
  return {
    ...actual,
    deriveRunCockpitData: (...args: Parameters<typeof actual.deriveRunCockpitData>) => {
      if (foldFailure.enabled) throw new Error("unexpected cockpit fold failure");
      return actual.deriveRunCockpitData(...args);
    },
  };
});

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-repo-"));
const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];

// T3: the graph is fixed across this suite — hoist it so run-start can record its real graphDefinitionHash
// (comparable), keeping these rendering assertions on the replayed states rather than the notice.
const GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "done", goal: "Finish report, then archive it.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T2", title: "mixed", goal: "Run mixed gates; stop on failure.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T3", title: "waiting", goal: "Queue the undispatched follow-up.", shape: "implement", complexity: 3, deps: ["T2"], acceptance: ["a"], gates: mandatoryGates },
  ],
});
const DEF_HASH = graphDefinitionHash(GRAPH);

// T6 (v1.61): a graph whose task parks at a DESIGNED human gate — pre-dispatch, so no gate
// result ever exists for it. Separate from GRAPH: the byte-pinned golden below must not drift.
const HUMAN_GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "gated", goal: "Ship the risky migration safely.", shape: "migration", complexity: 3, acceptance: ["a"], gates: mandatoryGates, humanGate: true },
  ],
});
const HUMAN_DEF_HASH = graphDefinitionHash(HUMAN_GRAPH);

const seed = (repo: string, events: JournalEvent[], graph = GRAPH) => {
  saveGraph(repo, graph);
  const dir = join(tickmarkrDir(repo), "runs", "run-watch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const v184Journal = (): string => {
  const source = readFileSync(
    fileURLToPath(new URL("../cockpit/derive.test.ts", import.meta.url)),
    "utf8",
  );
  const encoded = source.match(/const V184_GZIP_BASE64 = `([\s\S]*?)`;/u)?.[1];
  if (encoded === undefined) throw new Error("v1.84 fixture capture is missing");
  return gunzipSync(Buffer.from(encoded.replace(/\s+/gu, ""), "base64")).toString("utf8");
};

const graphForEvents = (events: readonly JournalEvent[]) => validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [...new Set(events.flatMap((event) => {
    const summaryIds = [event.data.done, event.data.failed, event.data.human]
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((value): value is string => typeof value === "string");
    return [...(event.taskId === undefined ? [] : [event.taskId]), ...summaryIds];
  }))].map((id) => ({
    id,
    title: id,
    goal: `Render recorded task ${id}.`,
    shape: "implement" as const,
    complexity: 3,
    acceptance: ["recorded"],
    gates: mandatoryGates,
  })),
});

const seedRaw = (repo: string, raw: string, graph: ReturnType<typeof graphForEvents>): string => {
  saveGraph(repo, graph);
  const path = join(tickmarkrDir(repo), "runs", "run-watch", "journal.jsonl");
  mkdirSync(join(tickmarkrDir(repo), "runs", "run-watch"), { recursive: true });
  writeFileSync(path, raw);
  return path;
};

/** Independent host-zone oracle: a fixed UTC instant converted by a named IANA rule set. */
const clockInZone = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

// The approved table starts each task at column four. Continuation rows keep that id column blank,
// so a task block runs until the next row whose first cell is populated.
const taskRowIndex = (out: string, taskId: string): number =>
  out.split("\n").findIndex((line) => {
    const plain = line.replace(/\x1b\[[\d;]*m/g, "");
    return new RegExp(`^ {4}${taskId}(?:\\s|$)`).test(plain)
      || new RegExp(`^\\s+(?:\\[.\\]|[|/\\\\-])\\s+${taskId}\\b`).test(plain);
  });
const row = (out: string, taskId: string) => out.split("\n")[taskRowIndex(out, taskId)]!;
const card = (out: string, taskId: string) => {
  const lines = out.split("\n");
  const start = taskRowIndex(out, taskId);
  if (start < 0) return "";
  const plainStart = lines[start]!.replace(/\x1b\[[\d;]*m/g, "");
  if (!/^ {4}T\d+\b/u.test(plainStart)) return plainStart;
  let end = start + 1;
  while (end < lines.length && !/^ {4}T\d+\b/u.test(lines[end]!.replace(/\x1b\[[\d;]*m/g, ""))) end += 1;
  return lines.slice(start, end).join(" ").replace(/\x1b\[[\d;]*m/g, "").replace(/\s+/gu, " ");
};
// the v1.34 ledger frame colorizes chips and task boxes — strip ANSI to fence glyphs/order, not styling
const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
const liveOpen = (token: (text: string) => string): string => token("").replace("\x1b[0m", "");
const ts = "2026-07-14T08:00:00.000Z";
const runStart = (): JournalEvent => ({ ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: DEF_HASH } });
const dispatch = (taskId: string, model: string): JournalEvent => ({
  ts,
  event: "task-dispatch",
  taskId,
  data: { assignment: { adapter: "fake", model, channel: "sub", tier: "cheap" } },
});
const gate = (taskId: string, name: string, pass: boolean): JournalEvent => ({
  ts,
  event: "gate-result",
  taskId,
  data: { gate: name, pass },
});
const phaseStart = (taskId: string, phase: string, at: string): JournalEvent => ({
  ts: at,
  event: "phase-start",
  taskId,
  data: { phase },
});
const tipRunStart = (): JournalEvent => ({
  ...runStart(),
  data: { ...runStart().data, commands: { test: "npm test" } },
});
const completedTaskEvents = (): JournalEvent[] => GRAPH.tasks.flatMap((task, index) => [
  dispatch(task.id, `fake-${index + 1}`),
  { ts, event: "task-done", taskId: task.id, data: {} },
]);
const tipFailure = (gateName = "test"): JournalEvent => ({
  ts,
  event: "tip-verify-failed",
  data: { gate: gateName, fingerprints: ["timeout:1", "timeout:2"] },
});
const failedTipRunEnd = (): JournalEvent => ({
  ts,
  event: "run-end",
  data: { done: GRAPH.tasks.map((task) => task.id), failed: [], human: [], blocked: [], pending: [], tipVerify: "failed", lastMergedTask: "T3" },
});

const withTty = async (fn: () => Promise<void>) => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  delete process.env.NO_COLOR;
  try {
    await fn();
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

describe("status checklist rendering", () => {
  test("test: every rendered row on the watch surface maps to a journal line when rendering the v1.84 fixture journal", async () => {
    const repo = mkRepo();
    const fixtureEvents = v184Journal().trimEnd().split("\n")
      .map((line) => JSON.parse(line) as JournalEvent);
    const recordedGraph = graphForEvents(fixtureEvents);
    const graph = validateGraph({
      ...recordedGraph,
      tasks: [
        ...recordedGraph.tasks,
        {
          id: "T999",
          title: "silent graph task",
          goal: "Never author a row from graph silence.",
          shape: "implement",
          complexity: 3,
          acceptance: ["recorded"],
          gates: mandatoryGates,
        },
      ],
    });
    // The committed fixture predates this synthetic graph. Append the same audited graph-rehash
    // release the daemon records after an operator-authorized recompile, so the watch is consuming
    // a usable fold instead of exercising the forbidden non-comparable fallback.
    const recordedHash = fixtureEvents.find((event) => event.event === "run-start")
      ?.data.graphDefinitionHash;
    const events = [
      ...fixtureEvents,
      {
        ts: fixtureEvents.at(-1)!.ts,
        event: "graph-rehash",
        data: { from: recordedHash, to: graphDefinitionHash(graph) },
      },
    ] satisfies JournalEvent[];
    const raw = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    seedRaw(repo, raw, graph);

    const out = await status(["--watch"], repo, { iterations: 1 });
    const renderedTaskIds = out.split("\n").flatMap((line) => {
      const match = line.match(/^\s+(?:\[[x! ]\]|[|/\\-])\s+(T\d+)\b/u);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    const recordedTaskIds = new Set(events.flatMap((event) => {
      const summaryIds = [event.data.done, event.data.failed, event.data.human]
        .flatMap((value) => Array.isArray(value) ? value : [])
        .filter((value): value is string => typeof value === "string");
      return [...(event.taskId === undefined ? [] : [event.taskId]), ...summaryIds];
    }));

    expect(renderedTaskIds.length).toBeGreaterThan(0);
    for (const taskId of renderedTaskIds) expect(recordedTaskIds, taskId).toContain(taskId);
  });

  test("watch renders no task row without a usable comparable journal fold", async () => {
    const withoutRun = mkRepo();
    saveGraph(withoutRun, GRAPH);

    const empty = await status(["--watch"], withoutRun, { iterations: 1 });
    expect(GRAPH.tasks.some((task) => row(empty, task.id) !== undefined)).toBe(false);

    const nonComparable = mkRepo();
    seed(nonComparable, [runStart(), dispatch("T1", "recorded")]);
    const changed = validateGraph({
      ...GRAPH,
      spec: { ...GRAPH.spec, hash: "changed-after-recording" },
      tasks: GRAPH.tasks.map((task, index) => ({
        ...task,
        status: index === 0 ? "done" as const : task.status,
      })),
    });
    saveGraph(nonComparable, changed);

    const stale = await status(["--watch"], nonComparable, { iterations: 1 });
    expect(stale).toContain("graph not comparable");
    expect(stale).toContain("0/3 done");
    expect(stale).not.toContain("1/3 done");
    expect(row(stale, "T1")).toBeUndefined();
  });

  test("watch keeps rendering while the daemon-owned journal is empty, torn, or still precedes run-start", async () => {
    const snapshots = [
      "",
      '{"ts":"2026-07-14T08:00:00.000Z","event":"run-',
      `${JSON.stringify({
        ts: "2026-07-14T08:00:00.000Z",
        event: "lock-reclaimed",
        data: { priorPid: 123 },
      })}\n`,
    ];

    for (const raw of snapshots) {
      const repo = mkRepo();
      seedRaw(repo, raw, GRAPH);

      const out = await status(["--watch"], repo, { iterations: 1 });

      expect(out).toContain("0/3 done");
      for (const task of GRAPH.tasks) expect(row(out, task.id)).toBeUndefined();
    }
  });

  test("watch lets unexpected cockpit fold failures surface", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T1", "recorded")]);
    foldFailure.enabled = true;
    try {
      await expect(status(["--watch"], repo, { iterations: 1 }))
        .rejects.toThrow("unexpected cockpit fold failure");
    } finally {
      foldFailure.enabled = false;
    }
  });

  test("watch tally counts the whole compiled graph while rows remain journal-backed", async () => {
    const repo = mkRepo();
    const graph = validateGraph({
      ...GRAPH,
      tasks: [
        ...GRAPH.tasks,
        { id: "T4", title: "planned four", goal: "Wait for a later wave.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
        { id: "T5", title: "planned five", goal: "Wait for a later wave.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
      ],
    });
    const start: JournalEvent = {
      ...runStart(),
      data: { ...runStart().data, graphDefinitionHash: graphDefinitionHash(graph) },
    };
    seed(repo, [
      start,
      dispatch("T1", "recorded-1"),
      { ts, event: "task-done", taskId: "T1", data: {} },
      { ts, event: "merge", taskId: "T1", data: {} },
      dispatch("T2", "recorded-2"),
      { ts, event: "task-done", taskId: "T2", data: {} },
    ], graph);

    const out = strip(await status(["--watch"], repo, { iterations: 1 }));

    expect(out).toContain("2/5 done");
    expect(row(out, "T1")).toBeDefined();
    expect(row(out, "T2")).toMatch(/\bcompleted\b/u);
    expect(row(out, "T2")).not.toMatch(/\bdone\b/u);
    for (const taskId of ["T3", "T4", "T5"]) expect(row(out, taskId)).toBeUndefined();
  });

  test("watch leaves task-done unchecked until the journal records a merge", async () => {
    const unmergedRepo = mkRepo();
    const mergedRepo = mkRepo();
    const completed: JournalEvent[] = [
      runStart(),
      dispatch("T1", "recorded"),
      { ts, event: "task-done", taskId: "T1", data: {} },
    ];
    seed(unmergedRepo, completed);
    seed(mergedRepo, [...completed, { ts, event: "merge", taskId: "T1", data: {} }]);

    const unmergedMachine = await status(["--watch"], unmergedRepo, { iterations: 1 });
    const mergedMachine = await status(["--watch"], mergedRepo, { iterations: 1 });
    expect(row(unmergedMachine, "T1")).toContain("[ ] T1");
    expect(row(unmergedMachine, "T1")).toMatch(/\bcompleted\b/u);
    expect(row(mergedMachine, "T1")).toContain("[x] T1");

    await withTty(async () => {
      const unmergedTty = await status(["--watch"], unmergedRepo, { iterations: 1 });
      const mergedTty = await status(["--watch"], mergedRepo, { iterations: 1 });
      expect(row(unmergedTty, "T1")).not.toContain(`${liveOpen(LIVE.pass)}T1`);
      expect(row(mergedTty, "T1")).toContain(`${liveOpen(LIVE.pass)}T1`);
    });
  });

  test("test: timestamps render in the host zone with the zone named once per screen, and the journal file bytes remain UTC", async () => {
    const repo = mkRepo();
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Riyadh";
    try {
      const instant = "2026-07-14T08:00:00.000Z";
      const events = [
        runStart(),
        {
          ts: instant,
          event: "task-dispatch",
          taskId: "T1",
          data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 },
        },
      ] satisfies JournalEvent[];
      const raw = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      const path = seedRaw(repo, raw, GRAPH);

      const out = await status(["--watch"], repo, { iterations: 1 });

      expect(out).toContain(clockInZone(instant, "Asia/Riyadh"));
      expect(out).not.toContain("since 08:00:00");
      expect(out.match(/zone \+03/gu)).toHaveLength(1);
      expect(readFileSync(path, "utf8")).toBe(raw);
      expect(readFileSync(path, "utf8")).toContain("2026-07-14T08:00:00.000Z");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  // Each event keeps its complete UTC instant and is independently converted under the named host
  // zone. The expected clocks come from Intl's named-zone rules, never from a label or offset the
  // surface emitted.
  test("a screen names the host zone once and converts every complete instant under its daylight-saving rules", async () => {
    const repo = mkRepo();
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const before = "2026-03-08T06:00:00.000Z"; // 01:00 EST — before the 02:00 local jump
      const after = "2026-03-08T18:00:00.000Z"; // 14:00 EDT — after it
      const events = [
        { ts: before, event: "run-start", data: { pid: process.pid, graphDefinitionHash: DEF_HASH } },
        { ts: before, event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 } },
        { ts: after, event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2" }, attempt: 0 } },
      ] satisfies JournalEvent[];
      const raw = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      const path = seedRaw(repo, raw, GRAPH);

      const out = await status(["--watch"], repo, { iterations: 1 });

      expect(out.match(/zone -04/gu)).toHaveLength(1);
      expect(out).toContain(`since ${clockInZone(before, "America/New_York")}`);
      expect(out).toContain(`since ${clockInZone(after, "America/New_York")}`);
      expect(readFileSync(path, "utf8")).toBe(raw);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("surfaces render folds they did not author and re-derive nothing", async () => {
    const repo = mkRepo();
    const graph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T1",
        title: "graph says done",
        goal: "Keep the journal authoritative.",
        shape: "implement",
        complexity: 3,
        acceptance: ["recorded"],
        gates: mandatoryGates,
        status: "done",
      }],
    });
    const events = [
      {
        ts,
        event: "run-start",
        data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) },
      },
      {
        ts,
        event: "run-end",
        data: { done: [], failed: [], human: ["T1"], blocked: [], pending: [] },
      },
    ] satisfies JournalEvent[];
    seed(repo, events, graph);

    journalReads.count = 0;
    const out = await status(["--watch"], repo, { iterations: 1 });
    const task = row(out, "T1");

    expect(task).toContain("parked");
    expect(task).toContain("[!]");
    expect(task).not.toContain("[x]");
    expect(task).not.toContain("  done  ");
    // ONE byte snapshot per frame. A second read is what lets a line the daemon appends mid-frame
    // pair newer folded task rows against older activity, phase, gate and tip readings; with a
    // single read that pairing cannot happen at all.
    expect(journalReads.count).toBe(1);
  });

  test("renders mixed gate outcomes in order and a channel once", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), { ts, event: "worker-result", taskId: "T2", data: { ok: true } }, gate("T2", "build", true), gate("T2", "test", false),
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(card(out, "T2"))).toMatch(/✓ ✗ ○ ○ ○ - -/);
      expect(card(out, "T2")).toContain("gate lint running");
      expect(card(out, "T2")).not.toContain("\x1b[36m");
      expect(card(out, "T2").match(/fake:fake-/g)).toHaveLength(1); // clipped channel column, still rendered once
    });
  });

  test("test: the narration tone and the board filter derive the same kind for a row whose explicit outcome field disagrees with its bare fields", async () => {
    const gateResult = {
      ts,
      event: "gate-result",
      taskId: "T1",
      data: {
        gate: "build",
        pass: true,
        outcome: { kind: "failed", reason: "explicit failure beats stale pass" },
      },
    } satisfies JournalEvent;
    const rail = strip(narrationRow(gateResult, "run-watch", 160)!);
    expect(rail.startsWith(`${GLYPHS.fail} `)).toBe(true);
    expect(rail).toContain("build failed");

    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T1", "fake-1"), gateResult]);
    await withTty(async () => {
      const task = card(await status([], repo), "T1");
      expect(task).toMatch(/✗ ○ ○ ○ ○ - -/u);
      expect(task).not.toMatch(/✓ ○ ○ ○ ○ - -/u);
      expect(task).toContain("failed · build");
    });
  });

  test("lists completed, dep-waiting, and undispatched tasks with tally and titles", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"),
    ]);

    // v1.65 T4: T2's live-attempt activity cell widens the status column — give the frame room
    // so the title column keeps its full text for this assertion.
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 180 });
    try {
      await withTty(async () => {
        const out = await status([], repo);
        expect(out).toContain("1/3 done");
        expect(strip(row(out, "T1"))).toContain("T1");
        expect(strip(row(out, "T1"))).toContain("done");
        expect(strip(row(out, "T2"))).toContain("T2");
        expect(strip(row(out, "T2"))).toContain("mixed");
        expect(card(out, "T2")).toContain("attempt 1 in flight on fake:fake-2 since 08:00:00");
        expect(strip(row(out, "T3"))).toContain("T3");
        expect(card(out, "T3")).toContain("dep-waiting on T2");
      });
    } finally {
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  test("uses ASCII boxes without ANSI when NO_COLOR or stdout is not a TTY", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), gate("T2", "build", true), gate("T2", "test", false), { ts, event: "task-failed", taskId: "T2", data: {} },
    ]);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const noColor = process.env.NO_COLOR;
    try {
      for (const [ttyValue, noColorValue] of [[false, undefined], [true, "1"]] as const) {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ttyValue });
        if (noColorValue === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColorValue;
        const out = await status([], repo);
        expect(out).not.toMatch(/\x1b\[/);
        expect(out).not.toMatch(/[☐✓✗⏸]/);
        expect(out.split("\n")[0]).not.toContain("zone ");
        expect(row(out, "T1")).toContain("[x] T1");
        expect(row(out, "T2")).toContain("[!] T2");
        expect(row(out, "T3")).toContain("[ ] T3");
        expect(row(out, "T2")).toContain("B[x] T[!]");
      }
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
    }
  });

  test("a TTY gate chain renders as glyph-only cells with no letter prefix on any cell", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), gate("T2", "build", true), gate("T2", "test", false),
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(card(out, "T1"))).toContain("✓ ✓ ○ ○ ○ - -");
      expect(strip(card(out, "T2"))).toContain("✓ ✗ ○ ○ ○ - -");
      expect(strip(card(out, "T3"))).toContain("○ ○ ○ ○ ○ - -");
      // no letter+glyph (or letter+dash) chip survives anywhere in the frame
      expect(strip(out)).not.toMatch(/[A-Z][✓✗○]|\b[A-Z]-/);
    });
  });

  test("the TTY frame legend names all seven gates in fixed order once per frame", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T1", "fake-1")]);

    await withTty(async () => {
      const plain = strip(await status([], repo));
      expect(plain.split("gates   bu build  te test  li lint  ev evidence  sc scope  ac acceptance  re review")).toHaveLength(2);
      expect(plain).not.toContain("B build");
    });
  });

  test("a task with a failed gate names that gate in words in its own status cell", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"), gate("T1", "build", true), gate("T1", "test", true), { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), gate("T2", "build", true), gate("T2", "test", false), { ts, event: "task-failed", taskId: "T2", data: {} },
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(card(out, "T2")).toContain("failed · test");
      expect(card(out, "T1")).not.toContain("failed ·");
    });
  });

  test("a task parked at a designed human gate names that gate in words in its own status cell", async () => {
    const repo = mkRepo();
    seed(repo, [
      { ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: HUMAN_DEF_HASH } },
      { ts, event: "task-human", taskId: "T1", data: { reason: 'humanGate: "gated" requires approval before dispatch', kind: "human-gate" } },
    ], HUMAN_GRAPH);

    await withTty(async () => {
      const out = await status([], repo);
      expect(card(out, "T1")).toContain("parked");
      expect(card(out, "T1")).toContain("awaiting approval");
      expect(card(out, "T1")).toContain("parked (human-gate)");
    });
  });

  test("test: a task parked on a zero-attempt infra or dispatch cause while the run is still live renders as a warn-tier row rather than the red failed glyph or word", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      { ts, event: "task-failed", taskId: "T2", data: { error: "delivery refused", kind: "dispatch", attempts: 0 } },
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(card(out, "T2")).toContain("warn · infra");
      expect(card(out, "T2")).not.toContain("failed");
      expect(row(out, "T2")).toContain(liveOpen(LIVE.attention));
    });
  });

  test("test: a task parked after its escalation ladder is exhausted renders as the red failed row", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      { ts, event: "task-human", taskId: "T2", data: { reason: "escalation ladder exhausted", kind: "ladder-exhausted" } },
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(card(out, "T2")).toContain("failed");
      expect(card(out, "T2")).toContain("parked (ladder-exhausted)");
      expect(row(out, "T2")).toContain(liveOpen(LIVE.failure));
    });
  });

  test("test: a task still parked or failed once the run itself has ended renders as the red failed row regardless of its recorded cause", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      { ts, event: "task-human", taskId: "T2", data: { reason: "quota exhausted", kind: "quota" } },
      { ts, event: "task-failed", taskId: "T3", data: { error: "delivery refused", kind: "dispatch", attempts: 0 } },
      { ts, event: "run-end", data: { done: [], failed: ["T3"], human: ["T2"] } },
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      for (const id of ["T2", "T3"]) {
        expect(card(out, id)).toContain("failed");
        expect(row(out, id)).toContain(liveOpen(LIVE.failure));
      }
    });
  });

  test("test: the approved table's note column names the task's recorded typed cause word for a warn-tier row", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      // OBS-206: a "dispatch" failure requires the dispatch that died — without it the journal
      // describes a task that failed delivery while never having been delivered, which the daemon
      // classifies (and now re-derives) as infra. Fixtures must be journals the daemon can write.
      dispatch("T2", "fake-2"),
      { ts, event: "task-failed", taskId: "T2", data: { error: "delivery refused", kind: "dispatch", attempts: 0 } },
    ]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(card(out, "T2")).toContain("dispatch");
    });
  });

  test("the red and warn tiers share the one attention role and are told apart by their words, while a running row wears the running role", async () => {
    const warnRepo = mkRepo();
    seed(warnRepo, [
      runStart(),
      dispatch("T1", "fake-1"),
      { ts, event: "task-done", taskId: "T1", data: {} },
      dispatch("T2", "fake-2"), // OBS-206: the dispatch that died — see the cause-word test above
      { ts, event: "task-failed", taskId: "T2", data: { error: "delivery refused", kind: "dispatch", attempts: 0 } },
      dispatch("T3", "fake-3"),
    ]);
    const redRepo = mkRepo();
    seed(redRepo, [
      runStart(),
      dispatch("T1", "fake-1"),
      { ts, event: "task-done", taskId: "T1", data: {} },
      { ts, event: "task-human", taskId: "T2", data: { reason: "escalation ladder exhausted", kind: "ladder-exhausted" } },
      dispatch("T3", "fake-3"),
    ]);
    const runningRepo = mkRepo();
    seed(runningRepo, [
      runStart(),
      dispatch("T1", "fake-1"),
      phaseStart("T1", "worker", ts),
    ]);

    await withTty(async () => {
      const warnRow = row(await status([], warnRepo), "T2");
      const redRow = row(await status([], redRepo), "T2");
      const runningRow = row(await status([], runningRepo, { now: () => Date.parse(ts) + 4_000 }), "T1");
      expect(warnRow).toContain(liveOpen(LIVE.attention));
      expect(redRow).toContain(liveOpen(LIVE.failure));
      expect(liveOpen(LIVE.attention)).toBe(liveOpen(LIVE.failure));
      expect(strip(warnRow)).toContain(`${GLYPHS.attention} warn`);
      expect(strip(redRow)).toContain(`${GLYPHS.fail} failed`);
      expect(runningRow).toContain(liveOpen(LIVE.running));
    });
  });

  test("test: attention and failure remain distinguishable by glyph under the shared amethyst color and NO_COLOR keeps every live token plain; a color-only distinction or styled plain output fails", async () => {
    const warnRepo = mkRepo();
    seed(warnRepo, [
      runStart(),
      dispatch("T2", "fake-2"), // OBS-206: the dispatch that died — see the cause-word test above
      { ts, event: "task-failed", taskId: "T2", data: { error: "delivery refused", kind: "dispatch", attempts: 0 } },
    ]);
    const redRepo = mkRepo();
    seed(redRepo, [
      runStart(),
      { ts, event: "task-human", taskId: "T2", data: { reason: "escalation ladder exhausted", kind: "ladder-exhausted" } },
    ]);

    // The colour-only control is an INSTANCE of the substitution it must catch: under this palette
    // attention and failure ARE one colour, so a row that leaned on hue alone would be byte-identical
    // to its counterpart. Colour cannot carry this distinction; only the glyph can.
    expect(LIVE.attention("x")).toBe(LIVE.failure("x"));

    await withTty(async () => {
      const warn = card(await status([], warnRepo), "T2");
      const red = card(await status([], redRepo), "T2");
      // `card` already strips ANSI: these are the shipped rows with the amethyst taken off.
      expect(warn).toContain(`${GLYPHS.attention} warn`);
      expect(warn).not.toContain(`${GLYPHS.fail} failed`);
      expect(red).toContain(`${GLYPHS.fail} failed`);
      expect(red).not.toContain(`${GLYPHS.attention} warn`);
      expect(new Set([warn, red]).size).toBe(2);
    });

    // The header is the OTHER live attention/failure call site, and it has two of them: the done
    // tally and the separate verify segment. Both wear the one amethyst whether the tip is merely
    // unverified or verifiably failed, so both lead with their own glyph — otherwise the identical
    // `tasks done · run not verified` text is all an operator gets from either state.
    const pendingRepo = mkRepo();
    seed(pendingRepo, [tipRunStart(), ...completedTaskEvents(), { ts, event: "merge", taskId: "T3", data: {} }]);
    const failedRepo = mkRepo();
    seed(failedRepo, [
      tipRunStart(),
      ...completedTaskEvents(),
      { ts, event: "merge", taskId: "T3", data: {} },
      tipFailure("test"),
      failedTipRunEnd(),
    ]);
    // The lockup gutter drops out the same way the tally tests above drop it: the version cell
    // beside a wrapped fact is layout, not a break in the claim.
    const headerText = (frame: string): string => strip(frame)
      .split("\n")
      .map((line) => line.replace(/^ v\d+\.\d+\.\d+\S*/u, ""))
      .join("\n")
      .replace(/\s+/gu, " ");

    await withTty(async () => {
      const pending = headerText(await status([], pendingRepo));
      const failed = headerText(await status([], failedRepo));
      expect(pending).toContain(`${GLYPHS.attention} 3/3 tasks done`);
      expect(pending).toContain(`${GLYPHS.attention} verify pending`);
      expect(pending).not.toContain(GLYPHS.fail);
      expect(failed).toContain(`${GLYPHS.fail} 3/3 tasks done`);
      expect(failed).toContain(`${GLYPHS.fail} verify FAILED`);
      expect(failed).not.toContain(`${GLYPHS.attention} 3/3 tasks done`);
    });

    // The same law on the live effort panel, where the review and park segments are ADJACENT. The law
    // is that a reviewer's rounds stay separable from a human park; what CARRIES it depends on what the
    // surface has. OPERATOR 2026-08-25: shade glyphs pull a taller fallback cell, so a row holding them
    // rendered visibly taller than a dispatch-only row. Resolved by mode rather than by trade — COLOUR
    // carries the distinction where there is colour (uniform full blocks, equal heights), SHAPE carries
    // it under NO_COLOR, where "a row that had leaned on the amethyst would arrive indistinguishable".
    // Both halves are asserted below; dropping either one restores a defect this file already paid for.
    const effortRepo = mkRepo();
    seed(effortRepo, [
      runStart(),
      dispatch("T2", "fake-2"),
      gate("T2", "review", true),
      gate("T2", "review", false),
      { ts, event: "task-human", taskId: "T2", data: { reason: "escalation ladder exhausted", kind: "ladder-exhausted" } },
    ]);
    // Every styled run of a line as (opening escape, text): the amethyst runs are the segments the
    // colour cannot tell apart, read off the rendered frame rather than off the implementation.
    const amethystShapes = (line: string): Set<string> => new Set(
      [...line.matchAll(/\x1b\[([\d;]*)m([^\x1b]*)/gu)]
        .filter((run) => `\x1b[${run[1]!}m` === liveOpen(LIVE.attention))
        .flatMap((run) => [...run[2]!.trim()]),
    );
    const panelLines = (frame: string): { bar: string; legend: string } => {
      const lines = frame.split("\n");
      const bar = lines.find((line) => /1 dispatch · 2 review · 1 park/u.test(strip(line)))!;
      const legendLine = lines.find((line) => /dispatch {2}.*review round {2}.*human park/u.test(strip(line)))!;
      expect(bar, "effort bar row").toBeDefined();
      expect(legendLine, "effort legend row").toBeDefined();
      return { bar, legend: legendLine };
    };

    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 110 });
    try {
      await withTty(async () => {
        const { bar, legend: legendRow } = panelLines(await status([], effortRepo));
        // ONE glyph on the styled surface: this is the equal-height requirement, and it is what a
        // shade-based bar cannot satisfy.
        const barGlyphs = new Set(strip(bar).replace(/[^\u2580-\u259f]/gu, ""));
        expect(barGlyphs.size, "one bar glyph under colour — equal row heights").toBe(1);
        // …and the three segments stay separable, now by COLOUR: three distinct styled runs.
        const styledRuns = (line: string): Set<string> => new Set(
          [...line.matchAll(/\x1b\[([\d;]*)m([^\x1b]*)/gu)]
            .filter((run) => /[\u2580-\u259f]/u.test(run[2] ?? ""))
            .map((run) => run[1]!),
        );
        expect(styledRuns(bar).size, "dispatch, review and park bar colours").toBe(3);
        expect(styledRuns(legendRow).size, "dispatch, review and park legend colours").toBe(3);
        // review has left the amethyst — that departure IS what makes it separable from park by colour,
        // so the amethyst now marks exactly one segment.
        expect(amethystShapes(bar).size, "only park wears the amethyst now").toBe(1);
      });
    } finally {
      if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
      else delete (process.stdout as { columns?: number }).columns;
    }

    // NO_COLOR on a TTY hands the operator the byte-pinned plain surface, which is preserved as it
    // was. Read off the RENDERED rows, not off tokens handed their own text: this is the surface an
    // operator actually sees, and the law is that it stays plain AND stays legible. Its glyph
    // vocabulary is ASCII by pin — "uses ASCII boxes without ANSI when NO_COLOR or stdout is not a
    // TTY" forbids ✗ here outright — so what separates the two tiers on this surface is the tier
    // word the renderer already writes. A token that styled here would corrupt plain output exactly
    // as it corrupts a pipe, and a row that had leaned on the amethyst would arrive indistinguishable.
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const previous = process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    process.env.NO_COLOR = "1";
    try {
      for (const [name, token] of Object.entries(LIVE)) expect(token("sample"), name).toBe("sample");
      expect(LIVE.attention(GLYPHS.attention)).toBe(GLYPHS.attention);
      expect(LIVE.failure(GLYPHS.fail)).toBe(GLYPHS.fail);
      const plainWarn = row(await status([], warnRepo), "T2");
      const plainRed = row(await status([], redRepo), "T2");
      for (const [name, plain] of [["warn", plainWarn], ["failure", plainRed]] as const) {
        expect(plain, name).not.toContain("\x1b[");
        expect(plain, name).not.toMatch(/[\u2713\u2717]/u); // the ASCII pin: no ✓/✗ on this surface
      }
      expect(plainWarn).toContain("failed");
      expect(plainRed).toContain("parked");
      expect(plainWarn).not.toBe(plainRed);
      for (const repo of [warnRepo, redRepo, pendingRepo, failedRepo]) {
        expect(await status([], repo)).not.toContain("\x1b[");
      }
      // NOTE the assertion deliberately NOT made here: that the plain surface keeps three bar SHAPES.
      // It cannot be made, because this surface has no bar. renderFrame sets `unicode = visual()` and
      // EARLY-RETURNS the ASCII machine surface at `if (!unicode)`, above the effortPanel call — so
      // NO_COLOR never builds the panel. Verified by render, not by reading: a frame with isTTY=true and
      // NO_COLOR=1 contains no "WHERE THE EFFORT WENT" and no block glyph. The shape scheme this test
      // used to enforce was protecting a colourless reader of a panel that never renders colourless.
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }

    // …and a pipe, the other nonvisual surface, is byte-consumed the same way.
    for (const [name, token] of Object.entries(LIVE)) expect(token("sample"), name).toBe("sample");
  });

  test("test: a journal whose last run-end carries a failed tip verification renders the failed gate by name in the status header", async () => {
    const repo = mkRepo();
    seed(repo, [
      tipRunStart(),
      ...completedTaskEvents(),
      { ts, event: "merge", taskId: "T3", data: {} },
      tipFailure("test"),
      failedTipRunEnd(),
    ]);

    const header = (await status([], repo)).split("\n")[0]!;
    expect(strip(header)).toContain("verify FAILED (test)");
    expect(strip(header)).toContain("2 fingerprints");
  });

  test("test: a resume in progress after a failed tip verification renders as a re-verification in progress rather than a completed run", async () => {
    const repo = mkRepo();
    seed(repo, [
      tipRunStart(),
      ...completedTaskEvents(),
      { ts, event: "merge", taskId: "T3", data: {} },
      tipFailure("test"),
      failedTipRunEnd(),
      { ts, event: "run-resume", data: { pid: process.pid } },
    ]);

    await withTty(async () => {
      // The brand lockup occupies a two-row gutter on the left of the header; the run's facts are
      // its right column. Drop that gutter so this reads the fact column itself — the version cell
      // sitting beside a wrapped fact is layout, not a break in the claim.
      const frame = strip(await status(["--watch"], repo, { iterations: 1, sleep: async () => {} }))
        .split("\n")
        .map((line) => line.replace(/^ v\d+\.\d+\.\d+\S*/u, ""))
        .join("\n")
        .replace(/\s+/gu, " ");
      expect(frame).toContain("verify FAILED (test) → re-verifying (run attempt 2)");
      expect(frame).not.toContain("3/3 done");
    });
  });

  test("test: the done-count presentation never reads as terminal success while tip verification is failed or pending", async () => {
    const failedRepo = mkRepo();
    seed(failedRepo, [
      tipRunStart(),
      ...completedTaskEvents(),
      { ts, event: "merge", taskId: "T3", data: {} },
      tipFailure("test"),
      failedTipRunEnd(),
    ]);
    const pendingRepo = mkRepo();
    seed(pendingRepo, [
      tipRunStart(),
      ...completedTaskEvents(),
      { ts, event: "merge", taskId: "T3", data: {} },
    ]);

    await withTty(async () => {
      for (const [repo, phase] of [[failedRepo, "FAILED (test)"], [pendingRepo, "pending"]] as const) {
        // Same lockup-gutter drop as the sibling test above: the version cell sitting beside a
        // wrapped fact is layout, not a break in the claim.
        const frame = strip(await status([], repo))
          .split("\n")
          .map((line) => line.replace(/^ v\d+\.\d+\.\d+\S*/u, ""))
          .join("\n")
          .replace(/\s+/gu, " ");
        expect(frame).toContain(`verify ${phase}`);
        expect(frame).toContain("3/3 tasks done · run not verified");
        expect(frame).not.toContain("3/3 done");
      }
    });
  });

  // SUPERSEDES "a run whose tip verification passed renders exactly as today" (v1.77), which pinned
  // a passed tip to render byte-identically to a run-end that recorded no verdict at all. Silence
  // reads the same from a board that hides the verdict as from one that never had it, so the board
  // now STATES what the record says — and these two journals, which differ in exactly that field,
  // must no longer render the same bytes.
  test("test: a run whose tip verification passed says so, and a run-end recording no verdict is never presented as one", async () => {
    const legacyRepo = mkRepo();
    const passedRepo = mkRepo();
    const baseEvents = [
      tipRunStart(),
      ...completedTaskEvents(),
      { ts, event: "merge", taskId: "T3", data: {} },
    ];
    const endData = { done: GRAPH.tasks.map((task) => task.id), failed: [], human: [], blocked: [], pending: [] };
    seed(legacyRepo, [...baseEvents, { ts, event: "run-end", data: endData }]);
    seed(passedRepo, [
      ...baseEvents,
      { ts, event: "tip-verify", data: { gate: "test", pass: true } },
      { ts, event: "run-end", data: { ...endData, tipVerify: "passed" } },
    ]);

    await withTty(async () => {
      const legacy = strip(await status([], legacyRepo, { now: () => Date.parse(ts) }));
      const passed = strip(await status([], passedRepo, { now: () => Date.parse(ts) }));
      expect(passed).toContain("verify passed");
      expect(legacy).toContain("verify unrecorded");
      expect(legacy).not.toContain("verify passed");
      // the tally and every task row still read as they did — only the verdict segment differs
      for (const frame of [legacy, passed]) expect(frame).toContain("3/3 done");
      for (const id of ["T1", "T2", "T3"]) expect(card(passed, id)).toBe(card(legacy, id));
    });
  });

  // v1.65 T4 (OBS-104): the cockpit carries a run-level now line so the operator can tell
  // dispatching from gating from merging without tailing the journal.
  test("the surface carries a run-level line naming the most recent journal event", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T2", "fake-2"), { ts, event: "worker-result", taskId: "T2", data: { ok: true, finished: true } }, gate("T2", "build", true)]);

    await withTty(async () => {
      const out = await status([], repo);
      expect(strip(out)).toContain("now: gate-result — T2 — build passed");
      expect(strip(card(out, "T2"))).toContain("gate test running"); // and the watched task names its running gate
    });
  });

  test("test: while a phase-start event has no matching outcome the frame renders that task's phase with an elapsed indication that advances between consecutive frames", async () => {
    const repo = mkRepo();
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    seed(repo, [
      runStart(),
      dispatch("T2", "fake-2"),
      { ts: new Date(startedAt - 1_000).toISOString(), event: "worker-result", taskId: "T2", data: { ok: true, finished: true } },
      phaseStart("T2", "judge", new Date(startedAt).toISOString()),
    ]);
    const times = [startedAt + 2_000, startedAt + 5_000];
    let clock = 0;

    await withTty(async () => {
      const out = await status(["--watch"], repo, {
        iterations: 2,
        sleep: async () => {},
        now: () => times[clock++]!,
      });
      const [first, second] = out.split("\n---\n");
      expect(strip(card(first!, "T2"))).toContain("judge · 2s elapsed");
      expect(strip(card(second!, "T2"))).toContain("judge · 5s elapsed");
      expect(card(first!, "T2")).toContain("⠋ judge · 2s elapsed");
      expect(card(second!, "T2")).toContain("⠙ judge · 5s elapsed");
    });
  });

  // The daemon writes the phase word it chose (phaseForGate) and the gate itself in the same row.
  // The gate is the fact; the phase word cannot tell an acceptance round from a review one, and the
  // journals this board is judged on carry BOTH gates under a phase of "judge".
  test("test: status --watch renders the journal gate field for build, acceptance and review as those exact names; use identical phase \"judge\" for acceptance and review so reading the phase word, special-casing build or testing an uncalled helper fails", async () => {
    const repo = mkRepo();
    const gatedGraph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: ["T1", "T2", "T3"].map((id) => ({
        id, title: id, goal: `Gate ${id}.`, shape: "implement" as const, complexity: 3,
        acceptance: ["a"], gates: [...GATE_NAMES],
      })),
    });
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    const phaseAt = (taskId: string, phase: string, gate: string): JournalEvent => ({
      ts: new Date(startedAt).toISOString(),
      event: "phase-start",
      taskId,
      data: { phase, gate, index: 1, total: 7 },
    });
    seed(repo, [
      { ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(gatedGraph) } },
      dispatch("T1", "fake-1"), dispatch("T2", "fake-2"), dispatch("T3", "fake-3"),
      phaseAt("T1", "gate:build", "build"),
      // Both rounds under the SAME phase word — only the gate field separates them.
      phaseAt("T2", "judge", "acceptance"),
      phaseAt("T3", "judge", "review"),
    ], gatedGraph);

    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 140 });
    try {
      await withTty(async () => {
        const out = strip(await status(["--watch"], repo, {
          iterations: 1,
          sleep: async () => {},
          now: () => startedAt + 3_000,
        }));
        expect(card(out, "T1")).toContain("gate build · 3s elapsed");
        expect(card(out, "T2")).toContain("gate acceptance · 3s elapsed");
        expect(card(out, "T3")).toContain("gate review · 3s elapsed");
        // The phase word the daemon happened to choose never reaches the operator's board.
        expect(out).not.toContain("judge");
      });
    } finally {
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  test("test: a task between its phase start and that phase's outcome never renders with an idle presentation", async () => {
    const repo = mkRepo();
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    seed(repo, [
      runStart(),
      dispatch("T2", "fake-2"),
      phaseStart("T2", "worker", new Date(startedAt).toISOString()),
    ]);

    await withTty(async () => {
      const out = await status(["--watch"], repo, {
        iterations: 1,
        sleep: async () => {},
        now: () => startedAt + 4_000,
      });
      expect(card(out, "T2")).toContain("⠋ worker · 4s elapsed");
      expect(card(out, "T2")).not.toContain("pending");
      expect(card(out, "T2")).toContain("worker · 4s elapsed · no output 4s");
    });
  });

  test("test: the watch updates its terminal title to name the hottest running phase and restores the title on exit", async () => {
    const repo = mkRepo();
    const startedAt = Date.parse("2026-07-23T08:00:00.000Z");
    seed(repo, [
      runStart(),
      dispatch("T1", "fake-1"),
      phaseStart("T1", "worker", new Date(startedAt - 1_000).toISOString()),
      dispatch("T2", "fake-2"),
      phaseStart("T2", "judge", new Date(startedAt).toISOString()),
    ]);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await withTty(async () => {
        await status(["--watch"], repo, {
          iterations: 1,
          sleep: async () => {},
          now: () => startedAt + 2_000,
        });
      });
    } finally {
      spy.mockRestore();
    }

    const output = writes.join("");
    const saved = output.indexOf("\x1b[22;0t");
    const titled = output.indexOf("\x1b]0;⏳ T2 judge 2s\x07");
    const restored = output.lastIndexOf("\x1b[23;0t");
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(titled).toBeGreaterThan(saved);
    expect(restored).toBeGreaterThan(titled);
  });

  test("watching a journal without phase-start events still omits graph-only rows", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T2", "fake-2")]);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      const before = await status([], repo, { now: () => Date.parse(ts) });
      const watched = await status(["--watch"], repo, {
        iterations: 1,
        sleep: async () => {},
        now: () => Date.parse(ts),
      });
      expect(watched).toContain("T2");
      expect(watched).not.toContain("T1");
      expect(watched).not.toContain("T3");
      expect(before).toContain("T1");
      expect(before).toContain("T3");
    } finally {
      spy.mockRestore();
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  test("the parked human-gate label renders before any gate result exists for the task", async () => {
    const repo = mkRepo();
    // the daemon parks a designed human gate BEFORE dispatch — this fixture mirrors that exactly:
    // no task-dispatch, no gate-result anywhere in the journal
    const events: JournalEvent[] = [
      { ts, event: "run-start", data: { pid: process.pid, graphDefinitionHash: HUMAN_DEF_HASH } },
      { ts, event: "task-human", taskId: "T1", data: { kind: "human-gate" } },
    ];
    expect(events.some((e) => e.event === "gate-result")).toBe(false);
    seed(repo, events, HUMAN_GRAPH);

    await withTty(async () => {
      const out = await status([], repo);
      expect(card(out, "T1")).toContain("awaiting approval");
    });
  });

  // deterministic fixture: events backdated exactly 10 minutes (age renders "10m"), a garbage
  // pid (renders "unknown", never probes), fixed 120 columns — the status-brand golden idiom
  const seedGoldenFixture = (repo: string): string => {
    const old = new Date(Date.now() - 600_000).toISOString();
    const at = (e: JournalEvent): JournalEvent => ({ ...e, ts: old });
    seed(repo, [
      { ts: old, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: DEF_HASH } },
      at(dispatch("T1", "fake-1")), at(gate("T1", "build", true)), at(gate("T1", "test", true)), { ts: old, event: "task-done", taskId: "T1", data: {} },
      at(dispatch("T2", "fake-2")), at(gate("T2", "build", true)), at(gate("T2", "test", false)), { ts: old, event: "task-failed", taskId: "T2", data: {} },
    ]);
    return old;
  };

  // Both surfaces are pinned over the SAME fixture: the plain one to its byte golden, the watch
  // one to agreement across the tty/NO_COLOR pair. Neither pin substitutes for the other.
  const overGoldenFixture = async (
    render: (repo: string) => Promise<string>,
    check: (out: string, lastRowTime: string) => void,
  ): Promise<void> => {
    const repo = mkRepo();
    const lastRowTime = seedGoldenFixture(repo);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const noColor = process.env.NO_COLOR;
    try {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
      for (const [ttyValue, noColorValue] of [[false, undefined], [true, "1"]] as const) {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ttyValue });
        if (noColorValue === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColorValue;
        check(await render(repo), lastRowTime);
      }
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as { columns?: number }).columns;
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
    }
  };

  test("non-TTY and NO_COLOR output is byte-pinned around the task-title column", async () => {
    // The literal pins every machine byte after the deliberate goal-to-title substitution.
    await overGoldenFixture(
      (repo) => status([], repo),
      (out, lastRowTime) => {
        const golden =
          `tickmarkr status / run run-watch abandoned since ${lastRowTime} / last event 10m ago / daemon pid unknown / 1/3 done\n` +
          "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review\n" +
          "  supervision: orchestrator ABSENT / orchestrator-context ABSENT / overseer ABSENT / overseer-context ABSENT / watch ABSENT\n" +
          "  [x] T1 done  B[x] T[x] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1\n" +
          "  [!] T2 mixed  B[x] T[!] L[ ] E[ ] S[ ] A. R.  failed  fake:fake-2\n" +
          "  [ ] T3 waiting  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  pending starved  -";
        expect(out).toBe(golden);
      },
    );
  });

  test("non-TTY and NO_COLOR --watch output agree on the local-time journal fold", async () => {
    const frames: string[] = [];
    await overGoldenFixture(
      (repo) => status(["--watch"], repo, { iterations: 1 }),
      (out) => {
        frames.push(out);
        expect(out.match(/zone (?:UTC|[+-]\d{2}(?::\d{2})?)/gu)).toHaveLength(1);
        expect(row(out, "T1")).toContain("[ ] T1");
      },
    );
    expect(frames).toHaveLength(2);
    expect(frames[1]).toBe(frames[0]);
  });

  test("bounded --watch returns every frame and streams non-TTY output", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T2", "fake-2")]);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      const out = await status(["--watch"], repo, { iterations: 2, sleep: async () => {} });
      expect(out.split("\n---\n")).toHaveLength(2);
      expect(writes.join("")).toContain("[ ] T2");
      expect(writes.join("")).not.toContain("[ ] T3");
    } finally {
      spy.mockRestore();
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  // ── v1.99 T1: the board's two clocks. The journal frame is cheap and redraws on a 500ms cadence;
  // scraping a worker's pane crosses the herdr socket, keeps its own 2s budget, and runs off the
  // redraw path entirely. Both tests state their assertion once and then apply that same assertion
  // to the shape this task deletes, so a reverted implementation fails them rather than passing.

  test("test: two watched journal frames are scheduled five hundred milliseconds apart while the old two-second interval fails the cadence assertion", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T1", "fake-1")]);
    const scheduled: number[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await status(["--watch"], repo, {
        iterations: 3,
        sleep: async (ms) => { scheduled.push(ms); },
      });
    } finally {
      write.mockRestore();
    }

    const fiveHundredApart = (gaps: readonly number[]): void => {
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) expect(gap).toBe(500);
    };
    expect(scheduled).toHaveLength(2); // three frames, two gaps between them
    fiveHundredApart(scheduled);
    // the same assertion against the cadence this task replaces — a 2s loop is not a 500ms one
    expect(() => fiveHundredApart([2000, 2000])).toThrow();
  });

  test("test: a worker-output scrape delayed beyond one frame cannot delay the next journal redraw and no second scrape overlaps it; a loop that awaits scraping before redrawing fails", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), dispatch("T1", "fake-1"), phaseStart("T1", "worker", ts)]);

    // A scrape that hangs far beyond one frame — the wedged pane this design exists for.
    let release = (): void => {};
    const hung = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let overlaps = 0;
    let scrapes = 0;
    const scrape = async (): Promise<string> => {
      scrapes += 1;
      inFlight += 1;
      if (inFlight > 1) overlaps += 1;
      await hung;
      inFlight -= 1;
      return "worker output";
    };

    let clock = Date.parse(ts);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let rendered: string[] = [];
    try {
      rendered = (await status(["--watch"], repo, {
        iterations: 8, // 3.5s of frames — the 2s scrape budget elapses twice while the first hangs
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        readWorkerOutput: scrape,
      })).split("\n---\n");
    } finally {
      write.mockRestore();
    }

    expect(rendered).toHaveLength(8); // every frame drew while the first scrape was still hanging
    expect(scrapes).toBe(1); // the budget came round twice and refused to start a second read
    expect(overlaps).toBe(0);

    // The control: a loop that awaits the scrape before its next redraw. Given the SAME hung
    // scrape it never reaches frame two, however many frame budgets elapse.
    let redraws = 0;
    const awaitingLoop = (async () => {
      for (let frame = 0; frame < 8; frame += 1) {
        redraws += 1;
        await hung;
      }
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(redraws).toBe(1);

    release();
    await awaitingLoop;

    // TWO workers, not one: the first pane read rejects immediately while the second stays hung.
    // A fail-fast join (Promise.all) settles on the rejection and drops the single-flight guard
    // with a read still outstanding, so the next budget starts an overlapping scrape.
    const twoWorkerRepo = mkRepo();
    seed(twoWorkerRepo, [
      runStart(),
      dispatch("T1", "fake-1"),
      dispatch("T2", "fake-2"),
      phaseStart("T1", "worker", ts),
      phaseStart("T2", "worker", ts),
    ]);

    let releaseSecond = (): void => {};
    const stillHung = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let pending = 0;
    let secondOverlaps = 0;
    const reads: string[] = [];
    const mixed = async (taskId: string): Promise<string> => {
      reads.push(taskId);
      if (taskId === "T1") throw new Error("pane read failed"); // rejects at once
      pending += 1;
      if (pending > 1) secondOverlaps += 1;
      await stillHung; // …while this one never returns
      pending -= 1;
      return "worker output";
    };

    let mixedClock = Date.parse(ts);
    const mixedWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await status(["--watch"], twoWorkerRepo, {
        iterations: 8, // the 2s budget elapses twice while T2's read is still outstanding
        sleep: async (ms) => { mixedClock += ms; },
        now: () => mixedClock,
        readWorkerOutput: mixed,
      });
    } finally {
      mixedWrite.mockRestore();
    }

    expect(reads).toEqual(["T1", "T2"]); // one batch only — no later budget joined the hung read
    expect(secondOverlaps).toBe(0);

    releaseSecond();
    await stillHung;
  });

  test("test: a required human decision emits one machine-readable event carrying the exact approval command and an evidence pointer", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      {
        ts,
        event: "task-human",
        taskId: "T1",
        data: { kind: "human-gate", reason: "operator approval required" },
      },
    ]);

    const out = await status(["--watch", "--events"], repo, {
      iterations: 1,
      sleep: async () => {},
    });
    const events = out.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      sequence: 2,
      type: "human-decision-required",
      tier: "decision",
      runId: "run-watch",
      taskId: "T1",
      approvalCommand: "tickmarkr approve run-watch T1",
      evidence: ".tickmarkr/runs/run-watch/journal.jsonl#L2",
    });
  });

  test("test: the stream replays identically from the same journal so a reconnecting consumer reaches the same state", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      phaseStart("T2", "worker", ts),
      gate("T2", "build", false),
      { ts, event: "escalation", taskId: "T2", data: { step: "consult", attempt: 2 } },
      { ts, event: "task-human", taskId: "T2", data: { kind: "gate-fail", reason: "review evidence" } },
      { ts, event: "run-end", data: { done: ["T1"], failed: [], human: ["T2"], blocked: ["T3"], pending: [] } },
    ]);

    const connect = () => status(["--watch", "--events"], repo, {
      iterations: 1,
      sleep: async () => {},
    });
    const first = await connect();
    const replay = await connect();

    expect(replay).toBe(first);
    expect(first.trim().split("\n").map((line) => JSON.parse(line).type)).toEqual([
      "phase-change",
      "gate-verdict",
      "escalation",
      "human-decision-required",
      "run-end",
    ]);
  });

  test("test: a bounded status --watch --events run writes one JSON document per decision event and nothing else to stdout and its keepalive lines to stderr and the help text names stdout as the document stream and stderr as the keepalive stream for status and the verdict stream for verify whereas a watch that interleaves a keepalive on stdout or help that names no stream fails", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), phaseStart("T1", "worker", ts)]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    let out = "";
    try {
      out = await status(["--watch", "--events"], repo, { iterations: 2, sleep: async () => {} });
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(stdout.join("")).toBe(`${out}\n`);
    expect(stdout.join("").trim().split("\n").map((line) => JSON.parse(line).type)).toEqual(["phase-change"]);
    expect(stderr).toEqual(["status: keepalive\n"]);
    expect(await status(["--help"], repo)).toBe(STATUS_HELP);
    expect((await verify(["--help"], repo)).out).toBe(VERIFY_HELP);
    for (const help of [STATUS_HELP, USAGE]) {
      expect(help).toMatch(/stdout.*JSON|JSON documents.*stdout/u);
      expect(help).toMatch(/keepalive.*stderr|stderr.*keepalive/u);
      expect(help).toMatch(/(?:never|not) merge|Do not merge|2>&1.*corrupt/iu);
    }
    for (const help of [VERIFY_HELP, USAGE]) {
      expect(help).toMatch(/verdict(?:\/JSON)? (?:and JSON result )?(?:are |on )?stdout|verdict.*stdout/iu);
      expect(help).toMatch(/stderr/u);
      expect(help).toMatch(/(?:never|not) merge|Do not merge|2>&1.*corrupt/iu);
    }
  });

  test("test: a status watch that receives a termination signal writes the leave-alternate-screen sequence and exits only after the write is flushed and its event stream writes a keepalive only on an iteration that emitted no decision event whereas an exit that drops the sequence on a pipe or a keepalive on every tick fails", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), phaseStart("T1", "worker", ts)]);
    const stderr: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await status(["--watch", "--events"], repo, { iterations: 2, sleep: async () => {} });
    } finally {
      errSpy.mockRestore();
    }
    expect(stderr).toEqual(["status: keepalive\n"]);

    await withTty(async () => {
      const writes: string[] = [];
      const before = new Set(process.rawListeners("SIGTERM"));
      let flush: (() => void) | undefined;
      const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk, cb?: (error?: Error | null) => void) => {
        writes.push(String(chunk));
        if (String(chunk) === "\x1b[?1049l" && typeof cb === "function") flush = () => cb();
        return true;
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((actualCode?: string | number | null) => {
        throw new Error(`exit ${actualCode}`);
      }) as never);
      let caught: unknown;
      try {
        await status(["--watch"], repo, {
          sleep: async () => {
            const handler = process.rawListeners("SIGTERM").find((candidate) => !before.has(candidate));
            expect(handler).toBeDefined();
            (handler as () => void)();
            expect(writes).toContain("\x1b[?1049l");
            expect(exitSpy).not.toHaveBeenCalled();
            expect(flush).toBeDefined();
            flush!();
          },
        });
      } catch (error) {
        caught = error;
      } finally {
        outSpy.mockRestore();
        exitSpy.mockRestore();
      }
      expect(caught).toMatchObject({ message: "exit 143" });
    });
  });

  test("test: an unbounded tty watch writes the alternate-screen enter sequence before its first frame and the leave sequence when it ends while a bounded render and an event stream write neither whereas a watch that repaints with clear-and-home on the main screen fails", async () => {
    const repo = mkRepo();
    seed(repo, [runStart(), phaseStart("T1", "worker", ts)]);
    const capture = async (args: string[], opts: Parameters<typeof status>[2]) => {
      const writes: string[] = [];
      const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await status(args, repo, opts).catch(() => "");
      } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
      }
      return writes.join("");
    };
    const captureSignalExit = async (signal: "SIGINT" | "SIGTERM", code: number) => {
      const writes: string[] = [];
      const before = new Set(process.rawListeners(signal));
      const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk, cb?: (error?: Error | null) => void) => {
        writes.push(String(chunk));
        if (typeof cb === "function") cb();
        return true;
      });
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((actualCode?: string | number | null) => {
        throw new Error(`exit ${actualCode}`);
      }) as never);
      let caught: unknown;
      let exitCalls: unknown[] = [];
      try {
        await status(["--watch"], repo, {
          sleep: async () => {
            const handler = process.rawListeners(signal).find((candidate) => !before.has(candidate));
            expect(handler).toBeDefined();
            (handler as () => void)();
          },
        });
      } catch (error) {
        caught = error;
      } finally {
        exitCalls = exitSpy.mock.calls.map(([actualCode]) => actualCode);
        outSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
      expect(caught).toMatchObject({ message: `exit ${code}` });
      expect(exitCalls).toEqual([code]);
      return writes.join("");
    };

    await withTty(async () => {
      const live = await capture(["--watch"], { sleep: async () => { throw new Error("board closed"); } });
      expect(live.startsWith("\x1b[?1049h")).toBe(true);
      expect(live.indexOf("\x1b[2J\x1b[H")).toBeGreaterThan(live.indexOf("\x1b[?1049h"));
      expect(live.endsWith("\x1b[?1049l")).toBe(true);
      for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
        const signaled = await captureSignalExit(signal, code);
        expect(signaled.startsWith("\x1b[?1049h")).toBe(true);
        expect(signaled.endsWith("\x1b[?1049l")).toBe(true);
      }

      const bounded = await capture(["--watch"], { iterations: 1, sleep: async () => {} });
      const boundedEvents = await capture(["--watch", "--events"], { iterations: 1, sleep: async () => {} });
      const unboundedEvents = await capture(["--watch", "--events"], {
        sleep: async () => { throw new Error("event stream closed"); },
      });
      for (const output of [bounded, boundedEvents, unboundedEvents]) {
        expect(output).not.toContain("\x1b[?1049h");
        expect(output).not.toContain("\x1b[?1049l");
      }
    });
  });

  test("test: a configured webhook sink receives decision-tier events and its failure never affects the run or the stream", async () => {
    const repo = mkRepo();
    seed(repo, [
      runStart(),
      phaseStart("T2", "worker", ts),
      gate("T2", "build", true),
      gate("T2", "test", false),
      { ts, event: "escalation", taskId: "T2", data: { step: "consult", attempt: 2 } },
      { ts, event: "task-human", taskId: "T2", data: { kind: "gate-fail", reason: "review evidence" } },
      { ts, event: "run-end", data: { done: ["T1"], failed: [], human: ["T2"], blocked: ["T3"], pending: [] } },
    ]);
    const delivered: { url: string; type: string }[] = [];

    const baseline = await status(["--watch", "--events"], repo, {
      iterations: 1,
      sleep: async () => {},
    });
    const withWebhook = await status(["--watch", "--events", "--webhook", "https://hooks.example.test/tickmarkr"], repo, {
      iterations: 1,
      sleep: async () => {},
      postWebhook: async (url, event) => {
        delivered.push({ url, type: event.type });
        throw new Error("offline");
      },
    });
    await Promise.resolve();

    expect(withWebhook).toBe(baseline);
    expect(delivered).toEqual([
      { url: "https://hooks.example.test/tickmarkr", type: "gate-verdict" },
      { url: "https://hooks.example.test/tickmarkr", type: "escalation" },
      { url: "https://hooks.example.test/tickmarkr", type: "human-decision-required" },
      { url: "https://hooks.example.test/tickmarkr", type: "run-end" },
    ]);
  });
});
