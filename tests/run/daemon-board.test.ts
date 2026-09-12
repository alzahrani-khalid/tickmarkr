// WB-1 (OBS-988): the daemon watches its own cockpit. A stale watch beat, a missing presence for the
// recorded arm, or a dead owner pid is a lost board; the daemon journals it, reopens through the same
// narrator path (bounded), and run-end retires the reopened pane — never the ghost.
import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { readWatchBoard, reserveWatchBoard, supervisionBeatPath, SUPERVISION_STALE_MS } from "../../src/run/supervision.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

/** A pid that once existed and is now certainly dead. */
const deadPid = (): number => {
  const pid = spawnSync("true").pid;
  if (!pid) throw new Error("could not mint a dead pid");
  return pid;
};

/** What a fake herdr does when it places a board: reserve the owner record, then act as the UI would. */
interface BoardState { pid?: number; armId?: string; beat?: "fresh" | "stale" }

/** Leg-2 T7: cached — the narrator answers with its last slot (as HerdrDriver does when the pane name and
 *  owner token still match) until `retireLostWatch` drops it; seam — whether that method exists at all;
 *  reopenThrows — every narrator call after the first placement rejects. */
interface DriverOpts { cached?: boolean; seam?: boolean; reopenThrows?: boolean }

function boardDriver(runId: string, states: BoardState[], driverOpts: DriverOpts = {}) {
  const inner = new SubprocessDriver();
  const opened: Slot[] = [];
  const closed: string[] = [];
  const retired: string[] = [];
  let cache: Slot | undefined;
  const name = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
  const driver = {
    ...(driverOpts.seam ? { async retireLostWatch(s: Slot) { retired.push(s.id); cache = undefined; } } : {}),
    id: "herdr",
    interactive: true,
    status: inner.status.bind(inner),
    slot: inner.slot.bind(inner),
    async run(s: Slot, cmd: string) {
      if (cmd.includes(" ui ")) return; // the narrator is a live loop — never actually run it
      return inner.run(s, cmd);
    },
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    async close(s: Slot) { closed.push(s.id); return inner.close(s); },
    worktree: inner.worktree.bind(inner),
    async narrator(cwd: string, _command: string, id?: string) {
      if (driverOpts.cached && cache) return cache; // nothing launched: the cache answers
      if (driverOpts.reopenThrows && opened.length > 0) throw new Error("herdr watch split failed: no caller pane");
      const slot = await inner.slot(cwd, name);
      cache = slot;
      const state = states[Math.min(opened.length, states.length - 1)]!;
      opened.push(slot);
      const owner = reserveWatchBoard({ repo: cwd, runId: id!, driver: "herdr", workspace: "wZ", pane: slot.id, name });
      const dir = dirname(supervisionBeatPath(cwd, "watch"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `watch-board.${id}.json`), JSON.stringify({ ...owner, ...(state.pid !== undefined ? { pid: state.pid } : {}), ...(state.armId ? { armId: state.armId } : {}) }) + "\n");
      if (state.armId) {
        writeFileSync(join(dir, `watch.live.${state.armId}`), JSON.stringify({ tier: "watch", id: state.armId }) + "\n");
        const beat = supervisionBeatPath(cwd, "watch");
        writeFileSync(beat, JSON.stringify({ tier: "watch", armId: state.armId }) + "\n");
        if (state.beat === "stale") {
          const aged = (Date.now() - SUPERVISION_STALE_MS - 5_000) / 1000; // aged by mtime, never waited for
          utimesSync(beat, aged, aged);
        }
      }
      return slot;
    },
  };
  return { driver, opened, closed, retired };
}

const boardRepo = (shell = `echo ok > ok.txt && ${COMMIT} ok`) => setupRepo(
  [T("T1"), T("T2", { deps: ["T1"] })],
  { tasks: { T1: [{ shell, result: { ok: true, summary: "ok" } }], T2: [{ shell: `echo two > two.txt && ${COMMIT} two`, result: { ok: true, summary: "two" } }] } },
);

test("test: a run whose opened board's beat is aged past the stale bound or whose owner pid is dead journals watch-board-lost naming the pane and pid then reopens through the narrator and journals watch-board-reopened naming a new pane that the owner record now names before the next task boundary, while a run whose board beats fresh journals neither row, so a dead board the daemon never notices fails", async () => {
  const alive = { pid: process.pid, armId: "arm-live", beat: "fresh" as const };
  const cases: Record<string, BoardState[]> = {
    stale: [{ pid: process.pid, armId: "arm-dead", beat: "stale" }, alive],
    "dead-pid": [{ pid: deadPid() }, alive],
    fresh: [alive],
  };
  for (const [mode, states] of Object.entries(cases)) {
    const { repo, fake } = boardRepo();
    const runId = `run-board-${mode}`;
    const { driver, opened } = boardDriver(runId, states);
    const summary = await runDaemon(repo, { adapters: [fake], runId, driver, concurrency: 1 });
    expect(summary.done.sort()).toEqual(["T1", "T2"]);
    const events = Journal.open(repo, runId).read();
    const lost = events.filter((e) => e.event === "watch-board-lost");
    const reopened = events.filter((e) => e.event === "watch-board-reopened");
    if (mode === "fresh") {
      expect(lost, mode).toEqual([]);
      expect(reopened, mode).toEqual([]);
      expect(opened, mode).toHaveLength(1);
      continue;
    }
    expect(opened, mode).toHaveLength(2);
    expect(lost, mode).toHaveLength(1);
    expect(lost[0]!.data, mode).toMatchObject({ pane: opened[0]!.id, pid: states[0]!.pid });
    expect(lost[0]!.data.boardless, mode).toBeUndefined();
    if (mode === "stale") expect(lost[0]!.data.beatAgeMs as number, mode).toBeGreaterThan(SUPERVISION_STALE_MS);
    expect(reopened, mode).toHaveLength(1);
    expect(reopened[0]!.data, mode).toEqual({ pane: opened[1]!.id, attempt: 1 });
    expect(readWatchBoard(repo, runId)?.pane, mode).toBe(opened[1]!.id);
    // noticed and reopened before the next task boundary: no dispatch sits between the two rows
    const lostAt = events.indexOf(lost[0]!);
    const reopenedAt = events.indexOf(reopened[0]!);
    expect(reopenedAt, mode).toBeGreaterThan(lostAt);
    expect(events.slice(lostAt, reopenedAt).some((e) => e.event === "task-dispatch"), mode).toBe(false);
    expect(reopenedAt, mode).toBeLessThan(events.findIndex((e) => e.event === "task-dispatch" && e.taskId === "T2"));
  }
}, 120_000);

test("test: a board lost a fourth time in one run journals watch-board-lost with boardless true and no further narrator call, and run-end retires the reopened board's slot with the ghost pane never closed, so a retire aimed at the pane the owner record no longer names fails", async () => {
  // every board this fake places names a pid that is already dead, so each poll tick loses it again
  const { repo, fake } = boardRepo(`sleep 3; echo ok > ok.txt && ${COMMIT} ok`);
  const runId = "run-board-bound";
  const { driver, opened, closed } = boardDriver(runId, [{ pid: deadPid() }]);
  const summary = await runDaemon(repo, { adapters: [fake], runId, driver, concurrency: 1 });
  expect(summary.done.sort()).toEqual(["T1", "T2"]);
  const events = Journal.open(repo, runId).read();
  const lost = events.filter((e) => e.event === "watch-board-lost");
  const reopened = events.filter((e) => e.event === "watch-board-reopened");
  expect(opened).toHaveLength(4); // the first board and three bounded reopens — never a fourth
  expect(reopened.map((e) => e.data.attempt)).toEqual([1, 2, 3]);
  expect(reopened.map((e) => e.data.pane)).toEqual(opened.slice(1).map((s) => s.id));
  expect(lost).toHaveLength(4);
  expect(lost.slice(0, 3).every((e) => e.data.boardless === undefined)).toBe(true);
  expect(lost[3]!.data).toMatchObject({ pane: opened[3]!.id, boardless: true });
  expect(events.indexOf(lost[3]!)).toBeGreaterThan(events.indexOf(reopened[2]!));
  // run-end retires the slot the owner record names — the last reopened pane — and no ghost
  const owned = readWatchBoard(repo, runId)!;
  expect(owned.pane).toBe(opened[3]!.id);
  const boards = new Set(opened.map((s) => s.id));
  expect(closed.filter((id) => boards.has(id))).toEqual([opened[3]!.id]);
}, 120_000);

// Leg-2 T7 M1 (OBS-988): HerdrDriver.narrator returns its CACHED slot while the pane name and owner token
// still match — exactly the state a dead cockpit whose pane survived leaves behind. A reopen that answers
// with the lost pane has reopened nothing.
test("test: a lost board whose driver's narrator answers from its cache is retired through retireLostWatch before the narrator is called again so the reopened row names a pane different from the lost one, while a driver without that seam that answers with the lost pane journals watch-board-reopen-failed and never watch-board-reopened for the lost pane, so a cached ghost reported as a reopened board fails", async () => {
  const stale: BoardState[] = [{ pid: process.pid, armId: "arm-dead", beat: "stale" }, { pid: process.pid, armId: "arm-live", beat: "fresh" }];
  for (const seam of [true, false]) {
    const { repo, fake } = boardRepo(`sleep 3; echo ok > ok.txt && ${COMMIT} ok`);
    const runId = `run-board-cached-${seam ? "seam" : "noseam"}`;
    const { driver, opened, retired } = boardDriver(runId, stale, { cached: true, seam });
    const summary = await runDaemon(repo, { adapters: [fake], runId, driver, concurrency: 1 });
    expect(summary.done.sort(), `seam=${seam}`).toEqual(["T1", "T2"]);
    const events = Journal.open(repo, runId).read();
    const lost = events.filter((e) => e.event === "watch-board-lost");
    const reopened = events.filter((e) => e.event === "watch-board-reopened");
    const failed = events.filter((e) => e.event === "watch-board-reopen-failed");
    expect(lost, `seam=${seam}`).toHaveLength(1);
    expect(lost[0]!.data.pane, `seam=${seam}`).toBe(opened[0]!.id);
    // never: a reopened row naming the pane that was lost
    expect(reopened.filter((e) => e.data.pane === opened[0]!.id), `seam=${seam}`).toEqual([]);
    if (seam) {
      expect(retired, "seam").toEqual([opened[0]!.id]); // the ghost was retired before the narrator was asked again
      expect(opened, "seam").toHaveLength(2);
      expect(reopened.map((e) => e.data), "seam").toEqual([{ pane: opened[1]!.id, attempt: 1 }]);
      expect(opened[1]!.id, "seam").not.toBe(opened[0]!.id);
      expect(failed, "seam").toEqual([]);
      expect(readWatchBoard(repo, runId)?.pane, "seam").toBe(opened[1]!.id);
    } else {
      expect(opened, "noseam").toHaveLength(1); // the cache answered every time; nothing was launched
      expect(reopened, "noseam").toEqual([]);
      expect(failed.map((e) => e.data.attempt), "noseam").toEqual([1, 2, 3]); // bounded like a real reopen
      expect(failed.every((e) => e.data.pane === opened[0]!.id && /lost pane/.test(String(e.data.error))), "noseam").toBe(true);
      expect(failed[2]!.data.boardless, "noseam").toBe(true);
      expect(lost[0]!.data.boardless, "noseam").toBeUndefined();
    }
  }
}, 120_000);

// Leg-2 T7 M2 (OBS-988): a reopen that fails leaves the same dead owner record in place. That is ONE loss,
// not one per poll: the lost row is journaled once, each attempt journals its own failure, and the bound
// retires the run boardless from the last failed attempt.
test("test: a board whose owner pid is dead and whose narrator throws on every reopen journals exactly one watch-board-lost row across the run's polls and one watch-board-reopen-failed row per bounded attempt with the last marked boardless, never a watch-board-reopened row, and run-end closes no ghost, so a single failed recovery journaled as four losses fails", async () => {
  const { repo, fake } = boardRepo(`sleep 3; echo ok > ok.txt && ${COMMIT} ok`);
  const runId = "run-board-reopen-throws";
  const { driver, opened, closed } = boardDriver(runId, [{ pid: deadPid() }], { reopenThrows: true });
  const summary = await runDaemon(repo, { adapters: [fake], runId, driver, concurrency: 1 });
  expect(summary.done.sort()).toEqual(["T1", "T2"]);
  const events = Journal.open(repo, runId).read();
  const lost = events.filter((e) => e.event === "watch-board-lost");
  const reopened = events.filter((e) => e.event === "watch-board-reopened");
  const failed = events.filter((e) => e.event === "watch-board-reopen-failed");
  expect(opened).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]!.data).toMatchObject({ pane: opened[0]!.id });
  expect(lost[0]!.data.boardless).toBeUndefined();
  expect(reopened).toEqual([]);
  expect(failed.map((e) => e.data.attempt)).toEqual([1, 2, 3]);
  expect(failed.every((e) => e.data.pane === opened[0]!.id && /split failed/.test(String(e.data.error)))).toBe(true);
  expect(failed.slice(0, 2).every((e) => e.data.boardless === undefined)).toBe(true);
  expect(failed[2]!.data.boardless).toBe(true);
  // the polls kept coming after the bound (T1 sleeps well past three ticks) and journaled nothing more
  expect(events.filter((e) => e.event.startsWith("watch-board")).length).toBe(4);
  expect(closed).not.toContain(opened[0]!.id); // the ghost is never closed
}, 120_000);
