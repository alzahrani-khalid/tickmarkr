import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";

// Counts the journal reads one frame performs. The wrapper calls straight through, so every other
// test in this file sees the real filesystem — only the tally is added.
const journalReads = vi.hoisted(() => ({ count: 0 }));
const foldFailure = vi.hoisted(() => ({ enabled: false }));
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

const row = (out: string, taskId: string) => out.split("\n").find((line) => new RegExp(`\\b${taskId}\\b`).test(line))!;
// v1.67: the TTY frame renders each task as a two-line card — line 1 identity+verdict, line 2
// gate chain + machinery. card() joins both lines; row() still fences what belongs on line 1.
const card = (out: string, taskId: string) => {
  const lines = out.split("\n");
  const i = lines.findIndex((line) => new RegExp(`\\b${taskId}\\b`).test(line));
  return `${lines[i]}\n${lines[i + 1] ?? ""}`;
};
// the v1.34 ledger frame colorizes chips and task boxes — strip ANSI to fence glyphs/order, not styling
const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
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
    expect(stale).toContain("task states not comparable");
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
      const unmergedTty = strip(await status(["--watch"], unmergedRepo, { iterations: 1 }));
      const mergedTty = strip(await status(["--watch"], mergedRepo, { iterations: 1 }));
      expect(row(unmergedTty, "T1")).not.toContain("✓");
      expect(row(mergedTty, "T1")).toContain("✓");
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
      expect(strip(row(out, "T2"))).toContain("pending"); // data plain — no off-palette status color
      expect(card(out, "T2")).not.toContain("\x1b[36m");
      expect(card(out, "T2").match(/fake:fake-2/g)).toHaveLength(1); // channel once per card, never repeated
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
        expect(strip(row(out, "T1"))).toContain("✓ T1 done");
        expect(strip(row(out, "T2"))).toContain("- T2 mixed");
        // machinery lives on the card's second line, never crowding the title on line 1
        expect(strip(card(out, "T2"))).toContain("attempt 1 in flight on fake:fake-2 since 08:00:00");
        expect(strip(row(out, "T2"))).not.toContain("attempt 1 in flight");
        expect(strip(row(out, "T3"))).toContain("- T3 waiting");
        expect(card(out, "T3")).toContain("dep-waiting on T2"); // the unmet dep is named (OBS-104)
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
      expect(plain.split("gates: build · test · lint · evidence · scope · acceptance · review")).toHaveLength(2); // exactly once
      expect(plain).not.toContain("B build"); // letter keys are gone from the TTY legend
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
      expect(strip(row(out, "T2"))).toContain("failed · test");
      expect(strip(row(out, "T1"))).not.toContain("done ·"); // healthy rows carry no gate words
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
      // v1.67 cards: the verdict line carries the approval hint; the park kind is line-2 machinery
      expect(strip(row(out, "T1"))).toContain("parked · awaiting approval");
      expect(strip(card(out, "T1"))).toContain("parked (human-gate)");
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
      expect(strip(row(out, "T2"))).toContain("! T2");
      expect(strip(row(out, "T2"))).not.toMatch(/✗|failed/);
      expect(row(out, "T2")).not.toContain("\x1b[31m");
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
      expect(strip(row(out, "T2"))).toContain("✗ T2");
      expect(strip(row(out, "T2"))).toContain("failed");
      expect(row(out, "T2")).toContain("\x1b[31m");
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
        expect(strip(row(out, id))).toContain(`✗ ${id}`);
        expect(strip(row(out, id))).toContain("failed");
        expect(row(out, id)).toContain("\x1b[31m");
      }
    });
  });

  test("test: the two-line card's second line names the task's recorded typed cause word for a warn-tier row", async () => {
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
      expect(strip(row(out, "T2"))).not.toContain("dispatch");
      expect(strip(card(out, "T2")).split("\n")[1]).toContain("dispatch");
    });
  });

  test("test: the progress gauge fills red only when a red-tier row is present among the tasks, never for a set that is only running or warn-tier parked", async () => {
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

    await withTty(async () => {
      const warnHeader = (await status([], warnRepo)).split("\n").find((line) => line.includes("run run-watch"))!;
      const redHeader = (await status([], redRepo)).split("\n").find((line) => line.includes("run run-watch"))!;
      expect(warnHeader).not.toContain("\x1b[31m");
      expect(redHeader).toContain("\x1b[31m");
    });
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
    expect(strip(header)).toContain("tip-verify: FAILED (test)");
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
      const header = (await status(["--watch"], repo, { iterations: 1, sleep: async () => {} })).split("\n")[0]!;
      expect(strip(header)).toContain("tip-verify: FAILED (test) → re-verifying (run attempt 2)");
      expect(strip(header)).not.toContain("3/3 done");
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
        const header = (await status([], repo)).split("\n").find((line) => line.includes("run run-watch"))!;
        expect(strip(header)).toContain(`tip-verify: ${phase}`);
        expect(strip(header)).toContain("3/3 tasks done · run not verified");
        expect(strip(header)).not.toContain("3/3 done");
        expect(header).not.toContain("\x1b[32m██████████");
        expect(header).not.toContain("\x1b[32m3/3");
      }
    });
  });

  test("test: a run whose tip verification passed renders exactly as today", async () => {
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
      const legacy = await status([], legacyRepo, { now: () => Date.parse(ts) });
      const passed = await status([], passedRepo, { now: () => Date.parse(ts) });
      expect(passed).toBe(legacy);
      expect(strip(passed)).toContain("3/3 done");
      expect(strip(passed)).not.toContain("tip-verify:");
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
      expect(strip(row(first!, "T2"))).toContain("⠋ T2");
      expect(strip(row(second!, "T2"))).toContain("⠙ T2");
    });
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
      expect(strip(row(out, "T2"))).toContain("⠋ T2");
      expect(strip(row(out, "T2"))).toContain("running");
      expect(strip(row(out, "T2"))).not.toContain("pending");
      expect(strip(card(out, "T2"))).toContain("worker · 4s elapsed · no output 4s");
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
      expect(strip(row(out, "T1"))).toContain("awaiting approval");
    });
  });

  // deterministic fixture: events backdated exactly 10 minutes (age renders "10m"), a garbage
  // pid (renders "unknown", never probes), fixed 120 columns — the status-brand golden idiom
  const seedGoldenFixture = (repo: string): void => {
    const old = new Date(Date.now() - 600_000).toISOString();
    const at = (e: JournalEvent): JournalEvent => ({ ...e, ts: old });
    seed(repo, [
      { ts: old, event: "run-start", data: { pid: "not-a-pid", graphDefinitionHash: DEF_HASH } },
      at(dispatch("T1", "fake-1")), at(gate("T1", "build", true)), at(gate("T1", "test", true)), { ts: old, event: "task-done", taskId: "T1", data: {} },
      at(dispatch("T2", "fake-2")), at(gate("T2", "build", true)), at(gate("T2", "test", false)), { ts: old, event: "task-failed", taskId: "T2", data: {} },
    ]);
  };

  // Both surfaces are pinned over the SAME fixture: the plain one to its byte golden, the watch
  // one to agreement across the tty/NO_COLOR pair. Neither pin substitutes for the other.
  const overGoldenFixture = async (
    render: (repo: string) => Promise<string>,
    check: (out: string) => void,
  ): Promise<void> => {
    const repo = mkRepo();
    seedGoldenFixture(repo);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const noColor = process.env.NO_COLOR;
    try {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
      for (const [ttyValue, noColorValue] of [[false, undefined], [true, "1"]] as const) {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ttyValue });
        if (noColorValue === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColorValue;
        check(await render(repo));
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
    const golden =
      "tickmarkr status / run run-watch / last event 10m ago / daemon pid unknown / 1/3 done\n" +
      "  gates: B build / T test / L lint / E evidence / S scope / A acceptance / R review\n" +
      "  [x] T1 done  B[x] T[x] L[ ] E[ ] S[ ] A. R.  done  fake:fake-1\n" +
      "  [!] T2 mixed  B[x] T[!] L[ ] E[ ] S[ ] A. R.  failed  fake:fake-2\n" +
      "  [ ] T3 waiting  B[ ] T[ ] L[ ] E[ ] S[ ] A. R.  pending starved  -";
    await overGoldenFixture(
      (repo) => status([], repo),
      (out) => expect(out).toBe(golden),
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
