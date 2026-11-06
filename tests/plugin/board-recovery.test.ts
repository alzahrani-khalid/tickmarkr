import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { POLL_MS, READY_HINT, boardController, boardStatusLine, shown, type BoardDeps } from "../../hooks/board/model.js";
import type { BoardState, RunSnapshot } from "../../hooks/board/state.js";

// Contract C (D-2184): the real boardController over a fake host. A thrown folder check is not the same
// answer as "not a directory", and only the newest read may publish.
const GOLDENS = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/board/goldens.json"), "utf8")) as {
  io: { expected: Record<string, unknown> }[];
};
const BASE = { ...GOLDENS.io[0]!.expected, version: 1, readAt: "10:00:00", spec: null } as unknown as RunSnapshot;
type Ran = Awaited<ReturnType<BoardDeps["run"]>>;
type Folder = "dir" | "file" | "rejected";

const snap = (runId: string, readAt: string): RunSnapshot => ({ ...BASE, runId, readAt, alive: true, ended: null });
const ok = (snapshot: RunSnapshot): Ran => ({ exitCode: 0, stdout: `${JSON.stringify(snapshot)}\n`, stderr: "" });
const EMPTY_RUN: Ran = { exitCode: 0, stdout: '{"version":1,"empty":"no tickmarkr run under /work/repo/.tickmarkr"}\n', stderr: "" };
const flush = (): Promise<void> => new Promise(done => setImmediate(done));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function host(folder: Folder = "dir") {
  const fs: { kind: Folder; cwd: string } = { kind: folder, cwd: "/work/repo/" };
  const runs: { argv: readonly string[]; cwd: string; answer: Deferred<Ran> }[] = [];
  const timers: { ms: number; tick: () => void; cancelled: boolean }[] = [];
  const published: BoardState[] = [];
  const opens: number[] = [];
  const deps: BoardDeps = {
    cwd: async () => fs.cwd,
    isDirectory: async () => {
      if (fs.kind === "rejected") throw new Error("EACCES: permission denied");
      return fs.kind === "dir";
    },
    run: (argv, cwd) => {
      const answer = deferred<Ran>();
      runs.push({ argv, cwd, answer });
      return answer.promise;
    },
    open: async () => { opens.push(opens.length); return true; },
    status: () => {},
    every: (ms, tick) => {
      const timer = { ms, tick, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    publish: async state => { published.push(state); },
  };
  const live = () => timers.filter(timer => !timer.cancelled);
  return { fs, runs, timers, published, opens, live, controller: boardController(deps) };
}

test("a rejected folder check keeps polling while not-a-directory stops it, the board command re-arms exactly one timer and starts a fresh read, a read in flight for twelve ticks is replaced and only the newest read publishes (contract C rows)", async () => {
  const h = host();
  const started = h.controller.start(true);
  await flush();
  expect(h.runs).toHaveLength(1);
  h.runs[0]!.answer.resolve(ok(snap("run-boot", "10:00:00")));
  await started;
  expect(h.timers.map(timer => timer.ms)).toEqual([POLL_MS]);
  expect(h.live()).toHaveLength(1);
  const first = h.timers[0]!;

  // While that timer is armed, the command keeps it and starts a fresh read.
  const whileArmed = h.controller.command();
  await flush();
  expect(h.timers).toHaveLength(1);
  expect(first.cancelled).toBe(false);
  expect(h.runs).toHaveLength(2);
  h.runs[1]!.answer.resolve(ok(snap("run-boot", "10:00:01")));
  await whileArmed;
  expect(h.opens).toHaveLength(2);

  // A thrown folder check reads nothing and leaves the one timer armed. The next healthy tick reads again.
  h.fs.kind = "rejected";
  first.tick();
  await flush();
  first.tick();
  await flush();
  expect(h.runs).toHaveLength(2);
  expect(h.timers).toHaveLength(1);
  expect(h.live()).toEqual([first]);
  h.fs.kind = "dir";
  first.tick();
  await flush();
  expect(h.runs).toHaveLength(3);
  // Same run id: the poll must not open again. A new id here would hide a command open in the count below.
  h.runs[2]!.answer.resolve(ok(snap("run-boot", "10:00:05")));
  await flush();
  expect(h.opens).toHaveLength(2);

  // An answer that the path is not a directory stops that same timer and starts no read.
  h.fs.kind = "file";
  first.tick();
  await flush();
  expect(h.runs).toHaveLength(3);
  expect(h.live()).toHaveLength(0);
  expect(first.cancelled).toBe(true);

  // The stopped poll is armed again: exactly one new timer, and a fresh read even with no directory.
  const asked = h.controller.command();
  await flush();
  expect(h.timers).toHaveLength(2);
  expect(h.live()).toHaveLength(1);
  expect(h.live()[0]!.ms).toBe(POLL_MS);
  expect(h.live()[0]).not.toBe(first);
  expect(first.cancelled).toBe(true);
  expect(h.runs).toHaveLength(4);
  h.runs[3]!.answer.resolve(ok(snap("run-command", "10:00:10")));
  await asked;
  expect(h.opens).toHaveLength(3);

  // A second command, while that new timer is armed, keeps it and starts another fresh read.
  const armed = h.live()[0]!;
  const again = h.controller.command();
  await flush();
  expect(h.timers).toHaveLength(2);
  expect(h.live()).toEqual([armed]);
  expect(h.runs).toHaveLength(5);
  h.runs[4]!.answer.resolve(ok(snap("run-command-2", "10:00:15")));
  await again;

  // Hold one read. Eleven further ticks share it; the twelfth starts a fresh read.
  h.fs.kind = "dir";
  armed.tick();
  await flush();
  const stuck = h.runs.length - 1;
  expect(h.runs).toHaveLength(stuck + 1);
  for (let i = 0; i < 11; i += 1) {
    armed.tick();
    await flush();
    expect(h.runs, `tick ${i + 1} shares the read`).toHaveLength(stuck + 1);
  }
  armed.tick();
  await flush();
  expect(h.runs, "the twelfth in-flight tick replaces the read").toHaveLength(stuck + 2);
  expect(h.live()).toEqual([armed]);

  // The command also refuses to share a read that is still in flight, and still leaves exactly one timer.
  const during = h.controller.command();
  await flush();
  expect(h.runs).toHaveLength(stuck + 3);
  expect(h.live()).toEqual([armed]);

  const older = snap("run-older", "10:00:20");
  const newer = snap("run-newer", "10:00:25");
  const newest = snap("run-newest", "10:00:30");
  const before = h.published.length;
  const opensBefore = h.opens.length;
  // The held read and the read that replaced it settle after the command's read has started. Neither publishes or opens.
  h.runs[stuck]!.answer.resolve(ok(older));
  h.runs[stuck + 1]!.answer.resolve(ok(newer));
  await flush();
  expect(h.published.slice(before)).toEqual([]);
  expect(h.opens).toHaveLength(opensBefore);
  h.runs[stuck + 2]!.answer.resolve(ok(newest));
  await during;
  await flush();
  expect(h.published.slice(before).map(state => state.snapshot?.runId)).toEqual(["run-newest"]);
  expect(h.opens).toHaveLength(opensBefore + 1);
});

/**
 * Same controller, with a folder check that can be held and a placement that resolves only when the test says so.
 * Contract C's age is bound to the read in flight when the tick starts; the ready hint is part of that read's status.
 */
function heldHost() {
  const fs: { kind: Folder; cwd: string } = { kind: "dir", cwd: "/work/repo/" };
  const runs: { argv: readonly string[]; cwd: string; answer: Deferred<Ran> }[] = [];
  const timers: { ms: number; tick: () => void; cancelled: boolean }[] = [];
  const published: BoardState[] = [];
  const statuses: (string | undefined)[] = [];
  const openCalls: Deferred<boolean>[] = [];
  let probeGate: Deferred<void> | undefined;
  const deps: BoardDeps = {
    cwd: async () => fs.cwd,
    isDirectory: async () => {
      if (probeGate) await probeGate.promise;
      if (fs.kind === "rejected") throw new Error("EACCES: permission denied");
      return fs.kind === "dir";
    },
    run: (argv, cwd) => {
      const answer = deferred<Ran>();
      runs.push({ argv, cwd, answer });
      return answer.promise;
    },
    open: () => {
      const answer = deferred<boolean>();
      openCalls.push(answer);
      return answer.promise;
    },
    status: text => { statuses.push(text); },
    every: (ms, tick) => {
      const timer = { ms, tick, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    publish: async state => { published.push(state); },
  };
  const live = () => timers.filter(timer => !timer.cancelled);
  return {
    fs, runs, timers, published, statuses, openCalls, live,
    holdProbe(): Deferred<void> {
      probeGate = deferred<void>();
      return probeGate;
    },
    releaseProbe(): void {
      const gate = probeGate;
      probeGate = undefined;
      gate?.resolve();
    },
    controller: boardController(deps),
  };
}

type Held = ReturnType<typeof heldHost>;

/** An armed poll and one unresolved read. The boot placement has already succeeded, so later opens are new. */
async function armHeldRead(h: Held): Promise<{ timer: Held["timers"][number]; stuck: number }> {
  const started = h.controller.start(true);
  await flush();
  expect(h.runs).toHaveLength(1);
  h.runs[0]!.answer.resolve(ok(snap("run-boot", "10:00:00")));
  await flush();
  expect(h.openCalls).toHaveLength(1);
  h.openCalls[0]!.resolve(true);
  await started;
  const timer = h.live()[0]!;
  timer.tick();
  await flush();
  expect(h.runs).toHaveLength(2);
  return { timer, stuck: 1 };
}

test("eleven rejected folder checks keep polling without reading and the next eligible tick replaces the read they aged", async () => {
  const h = heldHost();
  const { timer, stuck } = await armHeldRead(h);
  h.fs.kind = "rejected";
  for (let i = 0; i < 11; i += 1) {
    timer.tick();
    await flush();
    expect(h.runs, `rejected tick ${i + 1} reads nothing`).toHaveLength(stuck + 1);
    expect(h.live(), `rejected tick ${i + 1} keeps the poll`).toEqual([timer]);
  }
  h.fs.kind = "dir";
  timer.tick();
  await flush();
  expect(h.runs, "eleven rejected ticks plus one eligible tick replace the 60s read").toHaveLength(stuck + 2);
  expect(h.live()).toEqual([timer]);
});

test("twelve folder checks held across a command settle without replacing that command read or publishing the read they aged", async () => {
  const h = heldHost();
  const { timer, stuck } = await armHeldRead(h);
  h.holdProbe();
  for (let i = 0; i < 12; i += 1) timer.tick();
  await flush();
  expect(h.runs, "held checks have not read yet").toHaveLength(stuck + 1);

  const during = h.controller.command();
  await flush();
  expect(h.runs).toHaveLength(stuck + 2);
  expect(h.live()).toEqual([timer]);
  const commandRead = stuck + 1;

  h.releaseProbe();
  await flush();
  expect(h.runs, "probes that resolve after the command do not replace its read").toHaveLength(stuck + 2);

  const before = h.published.length;
  h.runs[stuck]!.answer.resolve(ok(snap("run-aged", "10:00:20")));
  await flush();
  expect(h.published.slice(before), "the aged read publishes nothing once the command read exists").toEqual([]);
  h.runs[commandRead]!.answer.resolve(ok(snap("run-command", "10:00:30")));
  await flush();
  for (const pending of h.openCalls) pending.resolve(true);
  await during;
  await flush();
  expect(h.published.slice(before).map(state => state.snapshot?.runId)).toEqual(["run-command"]);
  expect(h.runs).toHaveLength(stuck + 2);
});

test("a held automatic open resolving false after a newer empty read clears status leaves that cleared status", async () => {
  const h = heldHost();
  const run = snap("run-open", "10:00:00");
  const started = h.controller.start(true);
  await flush();
  h.runs[0]!.answer.resolve(ok(run));
  await flush();
  expect(h.openCalls).toHaveLength(1);
  expect(h.statuses).toEqual([boardStatusLine(shown(run))]);

  // The newer read is an automatic tick, published while the first placement is still held.
  h.live()[0]!.tick();
  await flush();
  expect(h.runs).toHaveLength(2);
  h.runs[1]!.answer.resolve(EMPTY_RUN);
  await flush();
  expect(h.statuses.at(-1)).toBeUndefined();

  h.openCalls[0]!.resolve(false);
  await flush();
  await started;
  expect(h.statuses, "the superseded placement must not restore the ready hint").toEqual([
    boardStatusLine(shown(run)),
    undefined,
  ]);
  expect(h.statuses).not.toContain(READY_HINT);

  // The read that is still current latches a successful placement, so the next poll does not open it again.
  const latched = heldHost();
  const boot = latched.controller.start(true);
  await flush();
  latched.runs[0]!.answer.resolve(ok(snap("run-latch", "10:00:01")));
  await flush();
  latched.openCalls[0]!.resolve(true);
  await boot;
  latched.live()[0]!.tick();
  await flush();
  latched.runs[1]!.answer.resolve(ok(snap("run-latch", "10:00:02")));
  await flush();
  expect(latched.openCalls, "a successful placement still latches the run").toHaveLength(1);
});

test("a superseded automatic placement cannot replace a newer same-run status with the ready hint", async () => {
  const h = heldHost();
  const first = snap("run-same", "10:00:00");
  const newer = { ...snap("run-same", "10:00:05"), alive: false };
  const started = h.controller.start(true);
  await flush();
  h.runs[0]!.answer.resolve(ok(first));
  await flush();
  expect(h.openCalls).toHaveLength(1);

  h.live()[0]!.tick();
  await flush();
  h.runs[1]!.answer.resolve(ok(newer));
  await flush();
  expect(boardStatusLine(shown(newer))).not.toBe(boardStatusLine(shown(first)));
  expect(h.statuses).toEqual([boardStatusLine(shown(first)), boardStatusLine(shown(newer))]);

  h.openCalls[0]!.resolve(false);
  await started;
  expect(h.statuses).toEqual([boardStatusLine(shown(first)), boardStatusLine(shown(newer))]);
  expect(h.statuses).not.toContain(READY_HINT);
});

test("a superseded automatic placement cannot write the ready hint while a newer read is unresolved", async () => {
  const h = heldHost();
  const first = snap("run-same", "10:00:00");
  const newer = { ...snap("run-same", "10:00:05"), alive: false };
  const started = h.controller.start(true);
  await flush();
  h.runs[0]!.answer.resolve(ok(first));
  await flush();
  expect(h.openCalls).toHaveLength(1);

  h.live()[0]!.tick();
  await flush();
  expect(h.runs).toHaveLength(2);
  h.openCalls[0]!.resolve(false);
  await started;
  expect(h.statuses, "a pending newer read leaves only the earlier published status").toEqual([
    boardStatusLine(shown(first)),
  ]);
  expect(h.statuses).not.toContain(READY_HINT);

  h.runs[1]!.answer.resolve(ok(newer));
  await flush();
  expect(h.statuses).toEqual([boardStatusLine(shown(first)), boardStatusLine(shown(newer))]);
});

test("a delayed failed placement leaves the newest status intact across snapshot, empty and failed reads", async () => {
  const newerCases: { name: string; result: Ran; status: string | undefined }[] = [
    { name: "same run", result: ok(snap("run-same", "10:00:05")), status: boardStatusLine(shown(snap("run-same", "10:00:05"))) },
    { name: "different run", result: ok(snap("run-other", "10:00:05")), status: boardStatusLine(shown(snap("run-other", "10:00:05"))) },
    { name: "empty", result: EMPTY_RUN, status: undefined },
    { name: "failed", result: { exitCode: 1, stdout: "", stderr: "board failed" }, status: undefined },
  ];
  for (const entry of newerCases) {
    const h = heldHost();
    const first = snap("run-same", "10:00:00");
    const started = h.controller.start(true);
    await flush();
    h.runs[0]!.answer.resolve(ok(first));
    await flush();
    h.live()[0]!.tick();
    await flush();
    h.runs[1]!.answer.resolve(entry.result);
    await flush();
    h.openCalls[0]!.resolve(false);
    await started;
    expect(h.statuses, entry.name).toEqual([boardStatusLine(shown(first)), entry.status]);
  }
});

test("a successful delayed placement still latches its run after a newer read starts", async () => {
  const h = heldHost();
  const started = h.controller.start(true);
  await flush();
  h.runs[0]!.answer.resolve(ok(snap("run-latched", "10:00:00")));
  await flush();
  expect(h.openCalls).toHaveLength(1);

  h.live()[0]!.tick();
  await flush();
  h.openCalls[0]!.resolve(true);
  await started;
  h.runs[1]!.answer.resolve(ok(snap("run-latched", "10:00:05")));
  await flush();
  expect(h.openCalls).toHaveLength(1);
  h.live()[0]!.tick();
  await flush();
  h.runs[2]!.answer.resolve(ok(snap("run-latched", "10:00:10")));
  await flush();
  expect(h.openCalls, "the successful older placement still records the run id").toHaveLength(1);
});

test("rejected checks age only the read in flight when they began and one later eligible tick replaces it once those ticks reach twelve", async () => {
  for (const rejected of [0, 10, 11, 12]) {
    const h = heldHost();
    const { timer, stuck } = await armHeldRead(h);
    h.fs.kind = "rejected";
    for (let i = 0; i < rejected; i += 1) {
      timer.tick();
      await flush();
    }
    expect(h.runs, `${rejected} rejected checks read nothing`).toHaveLength(stuck + 1);
    expect(timer.cancelled, `${rejected} rejected checks keep polling`).toBe(false);
    h.fs.kind = "dir";
    timer.tick();
    await flush();
    const replaced = rejected + 1 >= 12;
    expect(h.runs, `${rejected} rejected then one eligible`).toHaveLength(stuck + 1 + (replaced ? 1 : 0));
    expect(h.live()).toEqual([timer]);
  }
});
