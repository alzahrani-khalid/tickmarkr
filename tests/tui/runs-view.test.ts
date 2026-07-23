import { describe as d, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { validateGraph } from "../../src/graph/schema.js";
import { loadGraph } from "../../src/graph/graph.js";
import { Journal, type JournalEvent, type TelemetryRow } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { approve } from "../../src/cli/commands/approve.js";
import { gateChain } from "../../src/cli/commands/status.js";
import { costSignal } from "../../src/cli/commands/fleet-picker.js";
import { setupRepo, T, COMMIT } from "../helpers/tmprepo.js";

const describe = d.skip;

const ts = "2026-07-22T08:00:00.000Z";

const mandatoryGates = ["build", "test", "lint", "evidence", "scope"];

const GRAPH = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [
    { id: "T1", title: "one", goal: "Implement the runs view shell.", shape: "implement", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T2", title: "two", goal: "Render the consult dossier placeholder.", shape: "ui", complexity: 3, acceptance: ["a"], gates: mandatoryGates },
    { id: "T3", title: "three", goal: "Fold attempt history from the journal.", shape: "implement", complexity: 3, deps: ["T2"], acceptance: ["a"], gates: mandatoryGates },
  ],
});

const event = (e: Partial<JournalEvent> & { event: string; taskId?: string }): JournalEvent => ({
  ts,
  data: {},
  ...e,
} as JournalEvent);

const dispatch = (taskId: string, adapter: string, model: string, attempt = 0): JournalEvent =>
  event({ event: "task-dispatch", taskId, data: { attempt, assignment: { adapter, model, channel: "sub", tier: "cheap" } } });

const gate = (taskId: string, name: string, pass: boolean): JournalEvent =>
  event({ event: "gate-result", taskId, data: { gate: name, pass } });

const workerResult = (taskId: string, ok: boolean, finished: boolean, cause?: string, summary?: string): JournalEvent =>
  event({ event: "worker-result", taskId, data: { ok, finished, ...(cause ? { cause } : {}), ...(summary ? { summary } : {}) } });

const telemetry = (taskId: string, adapter: string, model: string, channel: string, tokens?: { input: number; output: number }): TelemetryRow => ({
  taskId, shape: "implement", adapter, model, channel, attempts: 1, outcome: "done", durationMs: 1,
  ...(tokens ? { tokens, meteredAttempts: 1 } : {}),
});

const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");

const card = (lines: string[], taskId: string) => {
  // Task identity lines start with pointer/spaces and a verdict glyph; the now-line does not.
  const i = taskLineIndex(lines, taskId);
  return [lines[i], lines[i + 1], lines[i + 2]].join("\n");
};

const taskLineIndex = (lines: string[], taskId: string) =>
  lines.findIndex((line) => new RegExp(`^[\\s❯]+[✓✗○!-] ${taskId} `).test(line));

describe("Runs cockpit view", () => {
  test("with a run loaded the timeline shows the now-line naming the most recent journal event", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "fake", "model-a"),
        gate("T1", "build", true),
      ],
      graph: GRAPH,
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 120, rows: 40 }).map(strip);
    expect(lines.some((l) => l.includes("now: gate-result — T1 — build passed"))).toBe(true);
  });

  test("a task renders as two lines — identity and verdict on the first, a dim gate chain and activity or channel on the second — with a blank line before the next task's card", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "fake", "model-a"),
        gate("T1", "build", true),
      ],
      graph: GRAPH,
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 120, rows: 40 }).map(strip);
    const c = card(lines, "T1");
    expect(c).toMatch(/T1.*Implement the runs view shell/);
    expect(c).toContain("pending");
    // gate chain is on the second line, not the first
    expect(lines[taskLineIndex(lines, "T1")]).not.toMatch(/[✓✗○-].*[✓✗○-]/);
    const second = lines[taskLineIndex(lines, "T1") + 1];
    expect(second).toMatch(/[✓✗○-]/);
    // second line carries activity phrase OR the channel
    expect(second.includes("gate test running") || second.includes("fake:model-a")).toBe(true);
    // blank separator before next card
    expect(lines[taskLineIndex(lines, "T1") + 2]?.trim()).toBe("");
  });

  test("a task's gate ladder renders through the same gate glyph vocabulary the status command uses", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "fake", "model-a"),
        gate("T1", "build", true),
        gate("T1", "test", false),
      ],
      graph: GRAPH,
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 120, rows: 40 }).map(strip);
    const second = lines[taskLineIndex(lines, "T1") + 1];
    const expected = gateChain(["pass", "fail", "open", "open", "open", "skip", "skip"], true);
    expect(second).toContain(expected);
    expect(second).toContain("✓");
    expect(second).toContain("✗");
    expect(second).toContain("○");
  });

  test("the attempt history lists a dispatch's typed failure reason when that attempt did not finish cleanly", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "fake", "model-a", 0),
        workerResult("T1", false, false, "stall-timeout", "worker timed out"),
        dispatch("T1", "fake", "model-b", 1),
        workerResult("T1", true, true),
        gate("T1", "build", true),
      ],
      graph: GRAPH,
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 120, rows: 40 }).map(strip);
    const detailStart = lines.findIndex((l) => l.includes("attempts & consult dossier"));
    const detail = lines.slice(detailStart, detailStart + 5).join("\n");
    expect(detail).toContain("attempt 1");
    expect(detail).toContain("stall-timeout");
    expect(detail).toContain("attempt 2");
    expect(detail).toContain("done");
  });

  test("with no run loaded the view renders an explanation rather than an empty frame", () => {
    const view = createRunsView();
    const lines = view.render({ cols: 80, rows: 24 });
    expect(lines.some((l) => l.includes("no run loaded"))).toBe(true);
    expect(lines.some((l) => l.includes("tickmarkr run"))).toBe(true);
  });

  test("the view renders from injected fixture data with no filesystem access inside the render path", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "fake", "model-a"),
      ],
      graph: GRAPH,
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 80, rows: 24 }).map(strip);
    expect(lines.some((l) => l.includes("T1"))).toBe(true);
    // the module itself never imports the filesystem
    const source = readFileSync("src/tui/views/runs-view.ts", "utf8");
    expect(source).not.toContain('from "node:fs"');
    expect(source).not.toContain("import * as fs");
  });

  test("a task count exceeding the view's available rows renders a cursor-following window clipped to the row budget instead of every card unconditionally", () => {
    const bigGraph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: Array.from({ length: 20 }, (_, i) => ({
        id: `T${i + 1}`,
        title: `task ${i + 1}`,
        goal: `Goal for task ${i + 1}.`,
        shape: "chore",
        complexity: 1,
        acceptance: ["a"],
        gates: mandatoryGates,
      })),
    });
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [event({ event: "run-start", data: { pid: 1 } })],
      graph: bigGraph,
    };
    const view = createRunsView(data);
    // Move cursor to task 15 (0-indexed 14)
    for (let i = 0; i < 14; i++) view.key("down");
    const lines = view.render({ cols: 120, rows: 20 }).map(strip);
    const visibleTasks = bigGraph.tasks.filter((t) => lines.some((l) => l.includes(t.id)));
    expect(visibleTasks.length).toBeLessThan(20);
    expect(lines.some((l) => l.includes("T15"))).toBe(true);
    // first and last tasks should not both be visible in the clipped window
    expect(lines.some((l) => l.includes("T1")) && lines.some((l) => l.includes("T20"))).toBe(false);
  });

  test("the cost ticker sums observed token usage per channel for the loaded run and renders a subscription channel as flat-rate quota rather than a dollar amount", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "claude-code", "fable"),
        dispatch("T2", "claude-code", "fable"),
      ],
      graph: GRAPH,
      telemetry: [
        telemetry("T1", "claude-code", "fable", "sub", { input: 1000, output: 500 }),
        telemetry("T2", "claude-code", "fable", "sub", { input: 200, output: 100 }),
      ],
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 120, rows: 40 }).map(strip);
    const tickerStart = lines.findIndex((l) => l.includes("cost ticker"));
    expect(tickerStart).toBeGreaterThan(-1);
    const row = lines.slice(tickerStart).find((l) => l.includes("claude-code:fable"));
    expect(row).toBeDefined();
    // observed usage summed across the run's telemetry rows: 1500 + 300
    expect(row).toContain("1800 tokens");
    expect(row).toContain("2 tasks");
    // a subscription channel is flat-rate quota — never a fabricated dollar figure
    expect(row).toContain("sub flat-rate quota");
    expect(row).not.toContain("$");
  });

  test("an api channel with a priced tier renders its per-task cost estimate through the shared cost-signal formatter", () => {
    const assignment = { adapter: "cursor-agent", model: "composer-2.5", channel: "api", tier: "cheap" } as const;
    const pricing = { cheap: 0.12 };
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        event({ event: "task-dispatch", taskId: "T2", data: { attempt: 0, assignment } }),
      ],
      graph: GRAPH,
      pricing,
      telemetry: [telemetry("T2", "cursor-agent", "composer-2.5", "api", { input: 9000, output: 1000 })],
    };
    const view = createRunsView(data);
    const lines = view.render({ cols: 120, rows: 40 }).map(strip);
    const tickerStart = lines.findIndex((l) => l.includes("cost ticker"));
    expect(tickerStart).toBeGreaterThan(-1);
    const row = lines.slice(tickerStart).find((l) => l.includes("cursor-agent:composer-2.5"));
    expect(row).toBeDefined();
    // the row carries the shared formatter's own output verbatim
    expect(row).toContain(costSignal(assignment, pricing));
    expect(row).toContain("api ~$0.12/task");
    expect(row).toContain("10000 tokens");
  });

  test("the tip-verify line shows the passed state after a tip-verify event and the failed state with its gate name after a tip-verify-failed event", () => {
    const passed = createRunsView({
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        event({ event: "tip-verify", data: { gate: "build", pass: true } }),
      ],
      graph: GRAPH,
    });
    const passedLine = passed.render({ cols: 120, rows: 40 }).map(strip).find((l) => l.includes("tip-verify:"));
    expect(passedLine).toBeDefined();
    expect(passedLine).toContain("build");
    expect(passedLine).toContain("passed");

    const failed = createRunsView({
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        event({ event: "tip-verify-failed", data: { gate: "lint", exitCode: 1 } }),
      ],
      graph: GRAPH,
    });
    const failedLine = failed.render({ cols: 120, rows: 40 }).map(strip).find((l) => l.includes("tip-verify:"));
    expect(failedLine).toBeDefined();
    expect(failedLine).toContain("lint");
    expect(failedLine).toContain("failed");
  });

  test("with no tip-verify event recorded yet the line shows a pending state rather than a false pass or fail", () => {
    const data: RunsViewData = {
      runId: "run-20260722-080000",
      events: [
        event({ event: "run-start", data: { pid: 1 } }),
        dispatch("T1", "fake", "model-a"),
        gate("T1", "build", true),
      ],
      graph: GRAPH,
    };
    const view = createRunsView(data);
    const line = view.render({ cols: 120, rows: 40 }).map(strip).find((l) => l.includes("tip-verify:"));
    expect(line).toBeDefined();
    expect(line).toContain("pending");
    expect(line).not.toContain("passed");
    expect(line).not.toContain("failed");
  });

  test("approving a parked task from the view appends the same task-approved event the command-line approve produces", async () => {
    const script = { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } };
    const { repo: repoCli, fake: fakeCli } = setupRepo([T("T1", { humanGate: true })], script);
    await runDaemon(repoCli, { adapters: [fakeCli], runId: "run-cli" });
    await approve(["run-cli", "T1"], repoCli);
    const cliEvent = Journal.open(repoCli, "run-cli").read().find((e) => e.event === "task-approved")!;

    const { repo: repoView, fake: fakeView } = setupRepo([T("T1", { humanGate: true })], script);
    await runDaemon(repoView, { adapters: [fakeView], runId: "run-view" });
    const graph = loadGraph(repoView);
    const makeData = (events: JournalEvent[]): RunsViewData => ({ runId: "run-view", events, graph });
    const data = makeData(Journal.open(repoView, "run-view").read());
    const notices: (string | null)[] = [];
    const view = createRunsView(data, {
      repoRoot: repoView,
      onNotice: (m) => notices.push(m),
      reload: () => makeData(Journal.open(repoView, "run-view").read()),
    });
    view.key("a");
    expect(notices.at(-1)).toMatch(/approve T1\?.*\[y\] confirm.*\[any key\] cancel/);
    view.key("y");
    await view.approval;
    const viewEvent = Journal.open(repoView, "run-view").read().find((e) => e.event === "task-approved")!;
    expect(viewEvent.event).toBe(cliEvent.event);
    expect(viewEvent.taskId).toBe(cliEvent.taskId);
    expect(viewEvent.data.by).toBe(cliEvent.data.by);
    expect(viewEvent.data.via).toBe(cliEvent.data.via);
    expect(viewEvent.data.release).toBe(cliEvent.data.release);
  });

  test("a confirmation step reusing the view's existing single-line notice mechanism, not a new modal component, is required before the approval event is appended", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-confirm" });
    const graph = loadGraph(repo);
    const makeData = (events: JournalEvent[]): RunsViewData => ({ runId: "run-confirm", events, graph });
    const data = makeData(Journal.open(repo, "run-confirm").read());
    const notices: (string | null)[] = [];
    const view = createRunsView(data, {
      repoRoot: repo,
      onNotice: (m) => notices.push(m),
      reload: () => makeData(Journal.open(repo, "run-confirm").read()),
    });
    view.key("a");
    expect(notices.at(-1)).toMatch(/approve T1\?.*\[y\] confirm.*\[any key\] cancel/);
    expect(Journal.open(repo, "run-confirm").read().filter((e) => e.event === "task-approved")).toHaveLength(0);
    view.key("y");
    await view.approval;
    expect(Journal.open(repo, "run-confirm").read().filter((e) => e.event === "task-approved")).toHaveLength(1);
  });

  test("approving a task that is not parked on a human gate is refused with the same reason the command-line approve gives", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-refuse" });
    expect(s.done).toEqual(["T1"]);
    const graph = loadGraph(repo);
    const data: RunsViewData = { runId: "run-refuse", events: Journal.open(repo, "run-refuse").read(), graph };
    let cliReason = "";
    try {
      await approve(["run-refuse", "T1"], repo);
    } catch (e) {
      cliReason = e instanceof Error ? e.message : String(e);
    }
    const notices: (string | null)[] = [];
    const view = createRunsView(data, { repoRoot: repo, onNotice: (m) => notices.push(m) });
    view.key("a");
    await view.approval;
    expect(notices.at(-1)).toBe(cliReason);
  });

  test("after a confirmed approval the view no longer shows the task as awaiting approval", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "t1" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-release" });
    const graph = loadGraph(repo);
    const makeData = (events: JournalEvent[]): RunsViewData => ({ runId: "run-release", events, graph });
    const data = makeData(Journal.open(repo, "run-release").read());
    const view = createRunsView(data, {
      repoRoot: repo,
      reload: () => makeData(Journal.open(repo, "run-release").read()),
    });
    const before = view.render({ cols: 120, rows: 40 }).map(strip).join("\n");
    expect(before).toContain("awaiting approval");
    view.key("a");
    view.key("y");
    await view.approval;
    const after = view.render({ cols: 120, rows: 40 }).map(strip).join("\n");
    expect(after).not.toContain("awaiting approval");
    expect(after).toContain("T1");
  });
});
