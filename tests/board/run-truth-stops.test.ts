// Queue row 398 (a) and (b), D-2187 add.24 (PORT-RULES R13): readRunBoard, the production seam, over disposable run
// folders this test writes. The base is the unchanged summarize over the same journal, graph, lock and history: the
// reader's snapshot before run-truth existed.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readRunBoard } from "../../src/board/read.js";
import { summarize } from "../../src/board/summarize.js";
import { parseBoard } from "../../hooks/board/model.js";

const RUN = "run-20261108-130000-0000000000002405";
const T0 = Date.parse("2026-11-08T13:00:00Z") / 1000;
const NOW = T0 + 40 * 60;
const at = (min: number): string => new Date((T0 + min * 60) * 1000).toISOString();
type Ev = { ts: string; event: string; taskId?: string; data: Record<string, unknown> };
const ev = (min: number, event: string, taskId: string | undefined, data: Record<string, unknown> = {}): Ev =>
  ({ ts: at(min), event, ...(taskId ? { taskId } : {}), data });
type Task = { id: string; title: string; deps: string[] };
const task = (id: string, ...deps: string[]): Task => ({ id, title: `task ${id}`, deps });

// One earlier run: a 10 minute worker, a 5 minute semantic round and a 2 minute suite, so the base has an ETA (R6b).
const HISTORY = [ev(-90, "phase-start", "H1", { phase: "worker" }), ev(-80, "worker-result", "H1"),
  ev(-80, "phase-start", "H1", { phase: "judge" }), ev(-77, "gate-result", "H1", { gate: "acceptance", pass: true }),
  ev(-75, "gate-result", "H1", { gate: "review", pass: true }), ev(-74, "gate-result", "H1", { gate: "test", pass: true, durationMs: 120000 })];
const HIST = { worker: 600, semantics: 300, test: 120 };

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
function put(path: string, body: string, mtime: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, mtime, mtime);
}
const jsonl = (events: readonly Ev[]): string => events.map((e) => JSON.stringify(e) + "\n").join("");

type Need = { task: string; kind: string; reason: string; since: number; blocks: string[]; cmd: string };
type Eta = { cleanMin: number; oneRepairMin: number; criticalPath: string[]; stoppedBy: string[]; cannotFinish?: boolean };
type Board = { runId: string; eta: Eta | null; needsYou: Need[]; tasks: Array<{ id: string; state: string; note: string; blocks: string[] }> };

/** Write a live run (no run-end) and an older history run under a fresh repository, then read the board at NOW. */
/** `history: false` writes no earlier run, so the reader has no worker sample (R6b). */
function read(tasks: readonly Task[], events: readonly Ev[], history = true): { board: Board; base: { eta: Eta | null; needsYou: Need[] } } {
  const tmp = mkdtempSync(join(tmpdir(), "tkr-run-truth-"));
  scratch.push(tmp);
  mkdirSync(join(tmp, ".git")); // its own repository, so the walk never reaches an enclosing checkout
  const runs = join(tmp, ".tickmarkr", "runs");
  if (history) put(join(runs, "run-20261108-110000-0000000000002404", "journal.jsonl"), jsonl(HISTORY), NOW - 3600);
  const journal = [ev(0, "run-start", undefined, { runId: RUN }), ...events];
  const graph = { tasks };
  put(join(runs, RUN, "journal.jsonl"), jsonl(journal), NOW);
  put(join(runs, RUN, "graph.json"), JSON.stringify(graph), NOW);
  const board = readRunBoard(tmp, [], [], NOW) as unknown as Board;
  const s = summarize(journal.map((e, i) => ({ ...e, _line: i + 1 })), graph, null, false, NOW, history ? HIST : null, [], {});
  // the base reader dropped the ETA without a worker sample (R6b)
  return { board, base: { eta: history ? s.eta : null, needsYou: s.needsYou.map((n) => ({ ...n, cmd: n.cmd.replaceAll("{run}", RUN) })) } };
}

// …2405's shape: four failed roots (T2, T8, T12, T20) and sixteen dependents, T21 behind two of them.
const SHAPE_2405 = [task("T1"), task("T2", "T1"), task("T3", "T2"), task("T4", "T2"), task("T5", "T3"), task("T6", "T4"),
  task("T7", "T5", "T6"), task("T8", "T1"), task("T9", "T8"), task("T10", "T9"), task("T11", "T9"), task("T12"),
  task("T13", "T12"), task("T14", "T13"), task("T15", "T13"), task("T16", "T14"), task("T17", "T16"), task("T18", "T17"),
  task("T19", "T18"), task("T20"), task("T21", "T20", "T7")];
const FAILED_2405 = ["T2", "T8", "T12", "T20"];
const EVENTS_2405 = [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(9, "task-done", "T1"),
  ...FAILED_2405.flatMap((id, k) => [ev(10 + k, "task-dispatch", id, { attempt: 0 }),
    ev(20 + k, "task-failed", id, { error: `${id}: routing.map.implement.pool has no live channel at task floor frontier` })])];
// A parked root and a failed root, each with a dependent, beside a reachable pending task.
const PARK_AND_FAIL = [task("T1"), task("T2"), task("T3", "T1"), task("T4", "T2"), task("T5")];
const EVENTS_PARK_AND_FAIL = [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(2, "task-dispatch", "T2", { attempt: 0 }),
  ev(5, "task-human", "T1", { kind: "human", reason: "scope" }), ev(6, "task-failed", "T2", { error: "worker crashed" })];
// Every task reachable: one done, one running, its dependent waiting, and a task whose park was approved.
const REACHABLE = [task("T1"), task("T2", "T1"), task("T3", "T2"), task("T4")];
const EVENTS_REACHABLE = [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(2, "task-dispatch", "T4", { attempt: 0 }),
  ev(4, "task-human", "T4", { kind: "human", reason: "scope" }), ev(6, "task-approved", "T4", { release: "fine" }),
  ev(9, "task-done", "T1"), ev(10, "task-dispatch", "T2", { attempt: 0 }), ev(10, "phase-start", "T2", { phase: "worker" })];

test("a run with an unreachable task reports cannot finish and names its failed and parked roots instead of a time", () => {
  for (const [tasks, events, roots] of [[SHAPE_2405, EVENTS_2405, FAILED_2405], [PARK_AND_FAIL, EVENTS_PARK_AND_FAIL, ["T1", "T2"]]] as const) {
    const { board, base } = read(tasks, events);
    // the control: the base promised a time and named no failed root
    expect(base.eta?.cleanMin, roots.join()).toBeGreaterThan(0);
    expect(base.eta?.stoppedBy, roots.join()).toEqual(roots.filter((id) => board.tasks.find((t) => t.id === id)?.state === "parked"));
    expect(board.eta, roots.join()).toStrictEqual({ ...base.eta, cleanMin: 0, oneRepairMin: 0, stoppedBy: roots, cannotFinish: true });
    // the plugin's shape check accepts the new field, and only as a boolean
    expect(parseBoard({ exitCode: 0, stdout: JSON.stringify(board) }).snapshot?.eta?.cannotFinish, roots.join()).toBe(true);
    const misshapen = { ...board, eta: { ...board.eta, cannotFinish: "yes" } };
    expect(parseBoard({ exitCode: 0, stdout: JSON.stringify(misshapen) }).error, roots.join()).toBe("tickmarkr board printed a misshapen snapshot");
  }
  // a live run with no worker sample yet (R6b) still says it cannot finish: a failed root, then a parked root, each
  // holding back its dependent (the reviewer's reproducer); the base read showed no ETA at all
  const CHAIN = [task("T1"), task("T2", "T1")];
  const start = [ev(1, "task-dispatch", "T1", { attempt: 0 })];
  for (const stop of [ev(2, "task-failed", "T1", { error: "worker crashed" }), ev(2, "task-human", "T1", { kind: "human", reason: "scope" })]) {
    const { board, base } = read(CHAIN, [...start, stop], false);
    expect(base.eta, stop.event).toBeNull();
    expect(board.tasks.map((t) => t.state), stop.event).toEqual([stop.event === "task-failed" ? "failed" : "parked", "blocked"]);
    expect(board.eta, stop.event).toStrictEqual({ cleanMin: 0, oneRepairMin: 0, criticalPath: ["T1", "T2"], stoppedBy: ["T1"], cannotFinish: true });
  }
});

test("a run with every task reachable keeps its estimate exactly as at the base", () => {
  const { board, base } = read(REACHABLE, EVENTS_REACHABLE);
  expect(board.tasks.map((t) => t.state)).toEqual(["done", "worker", "pending", "pending"]);
  expect(base.eta?.cleanMin).toBeGreaterThan(0);
  expect(board.eta).toStrictEqual(base.eta);
  expect(Object.hasOwn(board.eta as object, "cannotFinish")).toBe(false);
  expect(board.needsYou).toStrictEqual(base.needsYou);
  // without a worker sample a reachable run still has no ETA (R6b), and an ended run with a stop has none either
  expect(read(REACHABLE, EVENTS_REACHABLE, false).board.eta).toBeNull();
  const ended = read(PARK_AND_FAIL, [...EVENTS_PARK_AND_FAIL, ev(30, "run-end", undefined, { ok: false })]);
  expect([ended.base.eta, ended.board.eta]).toEqual([null, null]);
});

test("each failed task adds one needs you entry with its retry verb beside the park entries", () => {
  for (const [tasks, events, failed] of [[SHAPE_2405, EVENTS_2405, FAILED_2405], [PARK_AND_FAIL, EVENTS_PARK_AND_FAIL, ["T2"]]] as const) {
    const { board, base } = read(tasks, events);
    const fail = (id: string) => events.findLast((e) => e.event === "task-failed" && e.taskId === id) as Ev;
    const row = (id: string) => board.tasks.find((t) => t.id === id) as Board["tasks"][number];
    expect(board.needsYou, failed.join()).toStrictEqual([...base.needsYou, ...failed.map((id) => ({
      task: id, kind: "failed", reason: row(id).note, since: Date.parse(fail(id).ts) / 1000, blocks: row(id).blocks,
      cmd: `tickmarkr resume ${RUN} --retry-failed`,
    }))]);
  }
  // the park entry is kept exactly, with its own approve verb, before the failed task's entry
  const { board } = read(PARK_AND_FAIL, EVENTS_PARK_AND_FAIL);
  expect(board.needsYou.map((n) => [n.task, n.kind, n.cmd])).toEqual([
    ["T1", "human", `tickmarkr approve ${RUN} T1 --park 4@${at(5)}`], ["T2", "failed", `tickmarkr resume ${RUN} --retry-failed`]]);
  expect(board.needsYou[1]).toMatchObject({ reason: "worker crashed", blocks: ["T4"] });
});

test("a run with no failed or parked task has no needs you entry", () => {
  expect(read(REACHABLE, EVENTS_REACHABLE).board.needsYou).toEqual([]);
  expect(read(REACHABLE, []).board.needsYou).toEqual([]); // nothing dispatched yet
});
