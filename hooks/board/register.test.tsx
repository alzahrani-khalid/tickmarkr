import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { RunSnapshot } from "./state";

// Supplementary to tests/plugin/board-manifest.test.ts: the same register through the host's own harness, where the
// mounted pane, the frame clock and the Copy posts are real. The manifest test holds the exhaustive wiring pins.
type Engine = Parameters<TestBody>[0];
type On = Parameters<TestBody>[1];
type Found = { text?: string; props: Record<string, unknown>; children: Found[] };

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const NOW_S = NOW / 1000;
const COMMAND = "tickmarkr approve run-x T1 --waive --gate review";
const SNAPSHOT: RunSnapshot = {
  version: 1, runId: "run-x881", alive: true, pid: 4242, elapsedMin: 3, ended: null,
  tasks: [{
    id: "T1", title: "Park a review red", state: "parked", attempt: 0, dispatched: true, budget: 1, launches: 1,
    gates: { build: "pass", test: "fail" }, note: "", deps: [], blocks: [],
    worker: "codex:gpt-6.1", judge: "", reviewer: "", suiteWaiting: false,
    now: "waits on the review gate", nowSince: null,
    history: [{ att: 0, start: "09:57:00", parts: [{ text: "worker", tone: "pass" }, { text: "review", tone: "fail", reason: "red diff" }] }],
    startEpoch: NOW_S - 180, endEpoch: null, startedAt: "2026-11-02 09:57:00", endedAt: "", tokens: null,
  }],
  needsYou: [{ task: "T1", kind: "gate-fail", reason: "review", since: NOW_S - 60, blocks: [], cmd: COMMAND }],
  approvalWindow: null, eta: null, atEpoch: NOW_S, startEpoch: NOW_S - 180, endEpoch: null,
  readAt: "10:00:00", release: null, spec: null,
};
const EMPTY = { version: 1, empty: "no tickmarkr run under /work/session/.tickmarkr" };
type Wire = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean };
const wire = (answer: unknown = SNAPSHOT): Wire => ({ exitCode: 0, stdout: JSON.stringify(answer), stderr: "", isStdoutTruncated: false, isStderrTruncated: false });

function world(on: On) {
  const clock = mock.clock(on, { now: NOW });
  const copied: string[] = [];
  const runs: { argv: readonly string[]; cwd?: string; timeoutMs?: number }[] = [];
  const stats: string[] = [];
  const statuses: string[] = [];
  const opens: Record<string, unknown>[] = [];
  const folder: { kind: "dir" | "file" | "reject" } = { kind: "dir" };
  const answer: { run: () => Wire | Promise<Wire> } = { run: () => wire() };
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/work/session" }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("fs.stat", (_$, e) => {
    stats.push(e.path);
    return folder.kind === "reject" ? Promise.reject(new Error("stat refused")) : { value: { kind: folder.kind } };
  });
  on("process.run", async (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs });
    return { value: await answer.run() };
  });
  on("ui.open", (_$, e) => { opens.push(e); return { value: { isPlaced: true } }; });
  on("ui.status", (_$, e) => { statuses.push(e.text ?? ""); return { value: undefined }; });
  on("ui.copy", (_$, e) => { copied.push(e.text); return { value: { isCopied: true } }; });
  return { clock, copied, runs, stats, statuses, opens, folder, answer };
}

test("an interactive session over a .tickmarkr folder registers the command, reads board json once with a 20000 ms timeout, opens the pane with no focus field, sets the status line and starts one 5000 ms poll", async ($, on) => {
  const w = world(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/session" });
  expect(w.stats).toEqual(["/work/session/.tickmarkr"]);
  expect(w.runs).toEqual([{ argv: ["tickmarkr", "board", "--json"], cwd: "/work/session", timeoutMs: 20000 }]);
  expect(w.opens).toEqual([{ id: "tickmarkr-board", title: "tickmarkr run" }]);
  expect(w.opens[0]).not.toHaveProperty("focus");
  expect(w.statuses).toHaveLength(1);
  expect(w.statuses[0]).toContain("NEEDS YOU T1");
  await w.clock.advance(10000);
  expect(w.runs).toHaveLength(3);
});

/** Each case in its own test: `on()` may not be called after the test first called `$`, so one world per test. */
const neverBoards = async ($: Engine, on: On, kind: "dir" | "file" | "reject", isInteractive: boolean, stats: string[]): Promise<void> => {
  const w = world(on);
  w.folder.kind = kind;
  await $.session.start({ surface: "terminal", isInteractive, cwd: "/work/session" });
  expect(w.stats).toEqual(stats);
  expect(w.runs).toHaveLength(0);
  expect(w.opens).toHaveLength(0);
  expect(w.statuses).toHaveLength(0);
  await w.clock.advance(10000);
  expect(w.runs).toHaveLength(0);
};

test("a non-interactive session over a .tickmarkr folder never reads, opens or polls", async ($, on) => {
  await neverBoards($, on, "dir", false, []);
});

test("a session whose own folder holds a .tickmarkr file never reads, opens or polls", async ($, on) => {
  await neverBoards($, on, "file", true, ["/work/session/.tickmarkr"]);
});

test("a session whose .tickmarkr check rejects never reads, opens or polls", async ($, on) => {
  await neverBoards($, on, "reject", true, ["/work/session/.tickmarkr"]);
});

test("the command answers Tickmarkr board opened., reuses the session's single poll, and the session's end stops it", async ($, on) => {
  const w = world(on);
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/session" });
  const answer = await $.command.run({ command: "tickmarkr-board", args: "" } as never) as { text?: string };
  expect(answer.text).toBe("Tickmarkr board opened.");
  expect(w.runs).toHaveLength(2);
  expect(w.opens).toHaveLength(2);
  await w.clock.advance(10000);
  expect(w.runs).toHaveLength(4);
  await $.session.end({ reason: "prompt_input_exit", sessionId: "board-session", resume: { id: "board-session" } });
  await w.clock.advance(15000);
  expect(w.runs).toHaveLength(4);
});

test("a poll that finds the session folder's .tickmarkr gone stops polling and reads nowhere else", async ($, on) => {
  const w = world(on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/session" });
  w.folder.kind = "file";
  await w.clock.advance(5000);
  expect(w.stats).toEqual(["/work/session/.tickmarkr", "/work/session/.tickmarkr"]);
  expect(w.runs).toHaveLength(1);
  await w.clock.advance(10000);
  expect(w.runs).toHaveLength(1);
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`${surface}: the pane draws the board and Copy copies only the current snapshot's command`, async ($, on) => {
    const w = world(on);
    await $.session.start({ surface, isInteractive: true, cwd: "/work/session" });
    const ui = await $.ui.mount({ plugin: "tickmarkr", surface, component: "Pane", requestId: "tickmarkr-board", props: {} as never });
    await ui.resize({ columns: 180, rows: 80, in: "board" });
    // find({key}) does not see keys inside a Client module's tree, so the pane is asserted by its drawn text.
    const drawn = await ui.findAll({ type: "Text", in: "board" }) as unknown as Found[];
    expect(drawn.some(text => text.text?.includes("/tickmarkr-board reopens"))).toBe(true);
    await ui.post({ copy: COMMAND }, { in: "board" });
    expect(w.copied).toEqual([COMMAND]);
    w.answer.run = () => wire(EMPTY);
    await w.clock.advance(5000);
    const emptied = await ui.findAll({ type: "Text" }) as unknown as Found[];
    expect(emptied.some(text => text.text?.includes("No tickmarkr runs found."))).toBe(true);
    expect(emptied.some(text => text.text?.includes("/tickmarkr-board reopens"))).toBe(false);
    // the emptied pane draws no Client, so its Copy refusal is pinned in tests/plugin/board-manifest.test.ts
  });
}
