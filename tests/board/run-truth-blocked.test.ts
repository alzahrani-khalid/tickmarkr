// Queue row 398 (c), D-2187 add.24 (PORT-RULES R13 (c)): readRunBoard, the production seam, over run folders this test
// writes, and over a journal a real runDaemon wrote with the fake adapter. The base is the unchanged summarize over the
// same journal and graph: the reader's rows before the blocked state existed.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { readRunBoard } from "../../src/board/read.js";
import { summarize } from "../../src/board/summarize.js";
import { attributeBlocked, blockedTasks, tickmarkrDir } from "../../src/graph/graph.js";
import type { RunGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { parseBoard } from "../../hooks/board/model.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const RUN = "run-20261108-150000-0000000000002406";
const T0 = Date.parse("2026-11-08T15:00:00Z") / 1000;
const NOW = T0 + 40 * 60;
const at = (min: number): string => new Date((T0 + min * 60) * 1000).toISOString();
type Ev = { ts: string; event: string; taskId?: string; data: Record<string, unknown> };
const ev = (min: number, event: string, taskId?: string, data: Record<string, unknown> = {}): Ev =>
  ({ ts: at(min), event, ...(taskId ? { taskId } : {}), data });
type Task = { id: string; title: string; deps: string[] };
const task = (id: string, ...deps: string[]): Task => ({ id, title: `task ${id}`, deps });
type Row = { id: string; state: string; now: string; nowSince: number | null };
type Board = { tasks: Row[] };

function put(path: string, body: string, mtime: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, mtime, mtime);
}
const jsonl = (events: readonly object[]): string => events.map((e) => JSON.stringify(e) + "\n").join("");
const lined = (events: readonly object[]) => events.map((e, i) => ({ ...e, _line: i + 1 }));

/** A live run (no run-end) under a fresh repository, read at NOW, beside the base summarize of the same journal. */
function read(tasks: readonly Task[], events: readonly Ev[]): { board: Board; base: Row[]; raw: string } {
  const tmp = makeTestTempDir("tkr-blocked-");
  mkdirSync(join(tmp, ".git")); // its own repository, so the walk never reaches an enclosing checkout
  const journal = [ev(0, "run-start", undefined, { runId: RUN }), ...events];
  const graph = { tasks };
  put(join(tmp, ".tickmarkr", "runs", RUN, "journal.jsonl"), jsonl(journal), NOW);
  put(join(tmp, ".tickmarkr", "runs", RUN, "graph.json"), JSON.stringify(graph), NOW);
  const board = readRunBoard(tmp, [], [], NOW);
  return { board: board as unknown as Board, base: summarize(lined(journal), graph, null, false, NOW).tasks as Row[], raw: JSON.stringify(board) };
}
const states = (rows: readonly Row[]) => Object.fromEntries(rows.map((t) => [t.id, t.state]));
const nows = (rows: readonly Row[]) => Object.fromEntries(rows.map((t) => [t.id, t.now]));
/** graph.ts's own buckets over the board's rows: failed stays failed, parked is human, worker/waiting/gates run. */
const asGraph = (rows: readonly Row[], tasks: readonly Task[]): RunGraph => ({
  tasks: tasks.map((t) => {
    const s = rows.find((r) => r.id === t.id)?.state;
    return { ...t, status: s === "parked" ? "human" : s === "blocked" ? "pending" : ["worker", "waiting", "gates"].includes(s as string) ? "running" : s };
  }),
}) as unknown as RunGraph;

// …2405's shape: four failed roots (T2, T8, T12, T20) and sixteen dependents, T21 behind T20 directly and T2 four deep.
const SHAPE_2405 = [task("T1"), task("T2", "T1"), task("T3", "T2"), task("T4", "T2"), task("T5", "T3"), task("T6", "T4"),
  task("T7", "T5", "T6"), task("T8", "T1"), task("T9", "T8"), task("T10", "T9"), task("T11", "T9"), task("T12"),
  task("T13", "T12"), task("T14", "T13"), task("T15", "T13"), task("T16", "T14"), task("T17", "T16"), task("T18", "T17"),
  task("T19", "T18"), task("T20"), task("T21", "T20", "T7")];
const EVENTS_2405 = [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(9, "task-done", "T1"),
  ...["T2", "T8", "T12", "T20"].flatMap((id, k) => [ev(10 + k, "task-dispatch", id, { attempt: 0 }),
    ev(20 + k, "task-failed", id, { error: `${id}: routing.map.implement.pool has no live channel at task floor frontier` })])];
// hand-derived nearest roots (level order over deps): T21 meets T20 at depth one before T2 at depth four
const ROOTS_2405: Record<string, string> = {
  T3: "T2", T4: "T2", T5: "T2", T6: "T2", T7: "T2", T9: "T8", T10: "T8", T11: "T8", T13: "T12", T14: "T12", T15: "T12",
  T16: "T12", T17: "T12", T18: "T12", T19: "T12", T21: "T20",
};

test("a dependent of a failed task reads blocked by that task as failed", () => {
  // a failed root with a chain behind it: the base read `waits on`, the board reads blocked by the root as failed
  const chain = read([task("T1"), task("T2", "T1"), task("T3", "T2")],
    [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(5, "task-failed", "T1", { error: "worker crashed" })]);
  expect(nows(chain.base)).toMatchObject({ T2: "waits on T1", T3: "waits on T2 ← T1" }); // the control: the base's rows
  expect(states(chain.base)).toEqual({ T1: "failed", T2: "pending", T3: "pending" });
  expect(chain.board.tasks.map(({ id, state, now, nowSince }) => ({ id, state, now, nowSince })).slice(1)).toEqual([
    { id: "T2", state: "blocked", now: "blocked by T1 (failed)", nowSince: null },
    { id: "T3", state: "blocked", now: "blocked by T1 (failed)", nowSince: null }]);
  // every other field of a blocked row is the base's
  chain.board.tasks.forEach((t, i) => expect({ ...t, state: 0, now: 0 }).toStrictEqual({ ...chain.base[i], state: 0, now: 0 }));

  // the nearest root, by level order: T4 waits on T3 ← T1 (the base's first-dependency chain), but its other
  // dependency T2 is parked one step away, so it is blocked by T2 as parked; T3 is blocked by T1 as failed
  const near = read([task("T1"), task("T2"), task("T3", "T1"), task("T4", "T3", "T2")],
    [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(2, "task-dispatch", "T2", { attempt: 0 }),
      ev(5, "task-failed", "T1", { error: "worker crashed" }), ev(6, "task-human", "T2", { kind: "human", reason: "scope" })]);
  expect(nows(near.base).T4).toBe("waits on T3 ← T1");
  expect(nows(near.board.tasks)).toMatchObject({ T3: "blocked by T1 (failed)", T4: "blocked by T2 (parked)" });
  expect(states(near.board.tasks)).toEqual({ T1: "failed", T2: "parked", T3: "blocked", T4: "blocked" });

  // …2405's shape, live: sixteen blocked rows, each naming its nearest failed root
  const big = read(SHAPE_2405, EVENTS_2405);
  const blocked = big.board.tasks.filter((t) => t.state === "blocked");
  expect(Object.fromEntries(blocked.map((t) => [t.id, t.now]))).toEqual(
    Object.fromEntries(Object.entries(ROOTS_2405).map(([id, root]) => [id, `blocked by ${root} (failed)`])));
  expect(big.base.filter((t) => t.state === "pending").map((t) => t.id)).toEqual(Object.keys(ROOTS_2405)); // the control
  // graph.ts's own rules agree: blockedTasks names the same rows, attributeBlocked counts the same nearest roots
  const g = asGraph(big.base, SHAPE_2405);
  expect(blockedTasks(g).map((t) => t.id)).toEqual(blocked.map((t) => t.id));
  const counts = new Map<string, number>();
  for (const root of Object.values(ROOTS_2405)) counts.set(root, (counts.get(root) ?? 0) + 1);
  expect(attributeBlocked(g)).toEqual(counts);

  // the plugin's shape check accepts the blocked state and still rejects a state outside the wire contract
  const snap = parseBoard({ exitCode: 0, stdout: big.raw }).snapshot;
  expect(snap?.tasks.filter((t) => t.state === "blocked")).toHaveLength(16);
  const stuck = big.raw.replace('"state":"blocked"', '"state":"stuck"');
  expect(parseBoard({ exitCode: 0, stdout: stuck }).error).toBe("tickmarkr board printed a misshapen snapshot");
});

test("a dependent of a running task still reads waits on", () => {
  // T1 runs, T2 and T3 wait behind it; an unrelated failed task T4 and its dependent T5 do not reach them
  const tasks = [task("T1"), task("T2", "T1"), task("T3", "T2"), task("T4"), task("T5", "T4")];
  const live = read(tasks, [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(1, "phase-start", "T1", { phase: "worker" }),
    ev(2, "task-dispatch", "T4", { attempt: 0 }), ev(6, "task-failed", "T4", { error: "worker crashed" })]);
  expect(states(live.board.tasks)).toEqual({ T1: "worker", T2: "pending", T3: "pending", T4: "failed", T5: "blocked" });
  expect(nows(live.board.tasks)).toMatchObject({ T2: "waits on T1", T3: "waits on T2 ← T1", T5: "blocked by T4 (failed)" });
  // the dependents of the running task are the base's rows exactly
  expect(live.board.tasks.slice(0, 4)).toStrictEqual(live.base.slice(0, 4));
  // a run with no failed or parked task: every row is the base's
  const reachable = read(tasks.slice(0, 3), [ev(1, "task-dispatch", "T1", { attempt: 0 }), ev(5, "worker-result", "T1")]);
  expect(states(reachable.board.tasks)).toEqual({ T1: "waiting", T2: "pending", T3: "pending" });
  expect(reachable.board.tasks).toStrictEqual(reachable.base);
});

test("the live board's per task states over a journal equal the run end row's buckets for that journal", async () => {
  // T1 (chore) has a map pin to a channel that does not exist, so it fails before dispatch; T4 parks at its human
  // gate; T6 and T7 merge; T2, T3, T5 and T8 are stranded behind the failed and parked roots: a NOT GREEN end
  const { repo, fake } = setupRepo(
    [T("T1", { shape: "chore" }), T("T2", { deps: ["T1"] }), T("T3", { deps: ["T2"] }), T("T4", { humanGate: true }),
      T("T5", { deps: ["T4"] }), T("T6"), T("T7", { deps: ["T6"] }), T("T8", { deps: ["T6", "T1"] })],
    { tasks: {
      T6: [{ shell: `echo six > t6.txt && ${COMMIT} t6`, result: { ok: true, summary: "t6" } }],
      T7: [{ shell: `test -f t6.txt && echo seven > t7.txt && ${COMMIT} t7`, result: { ok: true, summary: "t7" } }],
    } },
    "routing:\n  map:\n    chore:\n      pin:\n        via: ghost\n        model: none\n",
  );
  const runId = "run-20261108-160000-0000000000002407";
  const summary = await runDaemon(repo, { adapters: [fake], runId });
  expect(summary.failed).toEqual(["T1"]);

  const runDir = join(tickmarkrDir(repo), "runs", runId);
  const lines = readFileSync(join(runDir, "journal.jsonl"), "utf8").split("\n").filter(Boolean);
  const endAt = lines.findIndex((l) => (JSON.parse(l) as Ev).event === "run-end");
  expect(endAt).toBe(lines.length - 1);
  const end = JSON.parse(lines[endAt]) as Ev;
  const buckets = end.data as Record<"done" | "failed" | "human" | "blocked" | "pending", string[]>;
  expect(buckets).toMatchObject({ done: ["T6", "T7"], failed: ["T1"], human: ["T4"], pending: [] });
  expect([...buckets.blocked].sort()).toEqual(["T2", "T3", "T5", "T8"]);

  // the journal cut just before the run-end row: the board a reader saw at the last live moment
  writeFileSync(join(runDir, "journal.jsonl"), lines.slice(0, endAt).map((l) => l + "\n").join(""));
  const now = Date.parse(end.ts) / 1000;
  const board = readRunBoard(repo, [], [], now) as unknown as Board & { runId: string; ended: unknown };
  expect([board.runId, board.ended]).toEqual([runId, null]);
  const live = states(board.tasks);
  const want = { done: ["done"], failed: ["failed"], human: ["parked"], blocked: ["blocked"], pending: ["pending", "worker", "waiting", "gates"] };
  const filed = Object.entries(want).flatMap(([bucket, allowed]) => buckets[bucket as keyof typeof buckets].map((id) => {
    expect(allowed, `${bucket} ${id}`).toContain(live[id]);
    return id;
  }));
  // every task the board shows is filed in exactly one bucket
  expect([...filed].sort()).toEqual(Object.keys(live).sort());
  expect(nows(board.tasks)).toMatchObject({
    T2: "blocked by T1 (failed)", T3: "blocked by T1 (failed)", T5: "blocked by T4 (parked)", T8: "blocked by T1 (failed)" });

  // the control: the base summarize over the same cut journal read every blocked task as pending
  const events = lines.slice(0, endAt).map((l) => JSON.parse(l) as object);
  const graph = JSON.parse(readFileSync(join(runDir, "graph.json"), "utf8")) as unknown;
  const base = states(summarize(lined(events), graph, null, false, now).tasks as Row[]);
  expect(buckets.blocked.map((id) => base[id])).toEqual(buckets.blocked.map(() => "pending"));
}, 180_000);
