import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { READY_HINT, boardController, boardStatusLine, shown, type BoardDeps } from "../../hooks/board/model.js";
import type { BoardState, RunSnapshot } from "../../hooks/board/state.js";

// Fixed wire fixture: the reference summarizer's own output for the golden main layout, as wire version 1.
const GOLDENS = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/board/goldens.json"), "utf8")) as {
  io: { expected: Record<string, unknown> }[];
};
const SNAPSHOT = { ...GOLDENS.io[0]!.expected, version: 1, readAt: "10:00:00", spec: null } as unknown as RunSnapshot;
type Ran = Awaited<ReturnType<BoardDeps["run"]>>;
const OK: Ran = { exitCode: 0, stdout: `${JSON.stringify(SNAPSHOT)}\n`, stderr: "" };
const EMPTY: Ran = { exitCode: 0, stdout: '{"version":1,"empty":"no tickmarkr run under /work/repo/.tickmarkr"}\n', stderr: "" };
const FAILED: Ran = { exitCode: 1, stdout: "", stderr: "board: cannot read /work/repo/.tickmarkr\n" };
const flush = () => new Promise<void>(done => setImmediate(done));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

/** A fake host: every dep a plain function, every effect recorded, every process read held until answered. */
function host(folder: "dir" | "file" | "missing" | "rejected" = "dir", placed = true) {
  const fs = { kind: folder, cwd: "/work/repo/" };
  const checks: string[] = [];
  const runs: { argv: readonly string[]; cwd: string; answer: Deferred<Ran> }[] = [];
  const timers: { ms: number; tick: () => void; cancelled: boolean }[] = [];
  const effects: string[] = [];
  const published: BoardState[] = [];
  const statuses: (string | undefined)[] = [];
  const hold: { publish?: Deferred<void>; check?: Deferred<boolean> } = {};
  const deps: BoardDeps = {
    cwd: async () => fs.cwd,
    isDirectory: async path => {
      checks.push(path);
      // a held check answers once: the next check reads the folder again
      const held = hold.check;
      hold.check = undefined;
      if (held) return held.promise;
      if (fs.kind === "rejected") throw new Error("EACCES: permission denied");
      if (fs.kind === "missing") throw new Error("ENOENT: no such file or directory");
      return fs.kind === "dir";
    },
    run: (argv, cwd) => {
      const answer = deferred<Ran>();
      runs.push({ argv, cwd, answer });
      return answer.promise;
    },
    open: async () => { effects.push("open"); return placed; },
    status: text => { effects.push("status"); statuses.push(text); },
    every: (ms, tick) => {
      const timer = { ms, tick, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    publish: async state => {
      effects.push("publish");
      published.push(state);
      if (hold.publish) await hold.publish.promise;
    },
    args: ["--root", "/elsewhere/.tickmarkr"],
  };
  return { deps, fs, checks, runs, timers, effects, published, statuses, hold, controller: boardController(deps) };
}

test("the controller has no effect for a missing, non-directory or rejected-check folder or a non-interactive start; an eligible start and repeated commands share one timer and one read, an unplaced open sets the ready hint, folder loss stops polling, snapshot, empty and error results each publish a complete replacement, and end suppresses pending publication, status and pane effects", async () => {
  // no board effect: a folder without a .tickmarkr directory, a rejected check, or a non-interactive session
  for (const folder of ["missing", "file", "rejected"] as const) {
    const h = host(folder);
    await h.controller.start(true);
    expect(h.checks, folder).toEqual(["/work/repo/.tickmarkr"]);
    expect([h.runs.length, h.timers.length, h.effects], folder).toEqual([0, 0, []]);
  }
  const quiet = host("dir");
  await quiet.controller.start(false);
  expect([quiet.checks, quiet.runs.length, quiet.timers.length, quiet.effects]).toEqual([[], 0, 0, []]);

  // an eligible start and repeated commands: one timer, one read in flight, the board json argv in the session folder
  const h = host("dir");
  const started = h.controller.start(true);
  await flush();
  const first = h.controller.command();
  const second = h.controller.command();
  await flush();
  expect(h.runs).toHaveLength(1);
  expect(h.runs[0]!.argv).toEqual(["tickmarkr", "board", "--json", "--root", "/elsewhere/.tickmarkr"]);
  expect(h.runs[0]!.cwd).toBe("/work/repo/");
  expect(h.timers.map(timer => timer.ms)).toEqual([5000]);
  h.runs[0]!.answer.resolve(OK);
  await Promise.all([started, first, second]);
  expect(h.runs).toHaveLength(1);
  expect(h.timers).toHaveLength(1);
  expect(h.published).toEqual([{ snapshot: SNAPSHOT, empty: null, error: null }]);
  expect(h.statuses).toEqual([boardStatusLine(shown(SNAPSHOT))]);
  expect(h.effects).toEqual(["publish", "status", "open", "open", "open"]);
  // a tick while a read is in flight shares it
  h.timers[0]!.tick();
  h.timers[0]!.tick();
  await flush();
  expect(h.runs).toHaveLength(2);

  // snapshot, empty and error results each publish one complete replacement; empty and error clear the status line
  h.published.length = 0;
  h.statuses.length = 0;
  h.runs[1]!.answer.resolve(EMPTY);
  await flush();
  h.timers[0]!.tick();
  await flush();
  h.runs[2]!.answer.resolve(FAILED);
  await flush();
  h.timers[0]!.tick();
  await flush();
  h.runs[3]!.answer.reject(new Error("spawn tickmarkr ENOENT"));
  await flush();
  h.timers[0]!.tick();
  await flush();
  h.runs[4]!.answer.resolve(OK);
  await flush();
  expect(h.published).toEqual([
    { snapshot: null, empty: "no tickmarkr run under /work/repo/.tickmarkr", error: null },
    { snapshot: null, empty: null, error: "board: cannot read /work/repo/.tickmarkr" },
    { snapshot: null, empty: null, error: "spawn tickmarkr ENOENT" },
    { snapshot: SNAPSHOT, empty: null, error: null },
  ]);
  for (const state of h.published) expect(Object.keys(state).sort()).toEqual(["empty", "error", "snapshot"]);
  expect(h.statuses).toEqual([undefined, undefined, undefined, boardStatusLine(shown(SNAPSHOT))]);
  // after the command too, each tick rechecks the folder: its loss stops polling and starts no read
  h.fs.kind = "missing";
  h.timers[0]!.tick();
  await flush();
  expect([h.runs.length, h.timers[0]!.cancelled]).toEqual([5, true]);

  // an autoloaded board: an unplaced open sets the ready hint and keeps the eligible poll (queue row 343 — a narrow
  // miss does not latch and does not stop the timer). A placed one polls until the folder goes.
  const narrow = host("dir", false);
  const hinted = narrow.controller.start(true);
  await flush();
  narrow.runs[0]!.answer.resolve(OK);
  await hinted;
  expect(narrow.statuses).toEqual([boardStatusLine(shown(SNAPSHOT)), READY_HINT]);
  expect(READY_HINT).toBe("Run board ready — /tickmarkr-board opens it");
  expect(narrow.timers).toHaveLength(1);
  expect(narrow.timers[0]!.cancelled).toBe(false);
  const asked = narrow.controller.command();
  await flush();
  narrow.runs[1]!.answer.resolve(OK);
  await asked;
  expect([narrow.timers.length, narrow.effects.filter(effect => effect === "open").length]).toEqual([1, 2]);

  const auto = host("dir");
  const loaded = auto.controller.start(true);
  await flush();
  auto.runs[0]!.answer.resolve(OK);
  await loaded;
  expect(auto.timers).toHaveLength(1);
  auto.timers[0]!.tick();
  await flush();
  expect(auto.runs).toHaveLength(2);
  auto.runs[1]!.answer.resolve(OK);
  await flush();
  auto.fs.kind = "file";
  auto.timers[0]!.tick();
  await flush();
  expect([auto.runs.length, auto.timers[0]!.cancelled]).toEqual([2, true]);
  expect(auto.checks).toEqual(Array(3).fill("/work/repo/.tickmarkr"));

  // end: a late read publishes nothing, sets no status and opens no pane; a pending check starts nothing; the timer stops
  const late = host("dir");
  const pending = late.controller.start(true);
  await flush();
  late.controller.end();
  late.runs[0]!.answer.resolve(OK);
  await pending;
  expect([late.effects, late.timers.length]).toEqual([[], 0]);

  const midPublish = host("dir");
  midPublish.hold.publish = deferred<void>();
  const publishing = midPublish.controller.command();
  await flush();
  midPublish.runs[0]!.answer.resolve(OK);
  await flush();
  expect(midPublish.effects).toEqual(["publish"]);
  midPublish.controller.end();
  expect(midPublish.timers[0]!.cancelled).toBe(true);
  midPublish.hold.publish.resolve();
  await publishing;
  expect(midPublish.effects).toEqual(["publish"]);

  const midCheck = host("dir");
  const held = deferred<boolean>();
  midCheck.hold.check = held;
  const checking = midCheck.controller.start(true);
  await flush();
  midCheck.controller.end();
  held.resolve(true);
  await checking;
  expect([midCheck.runs.length, midCheck.timers.length, midCheck.effects]).toEqual([0, 0, []]);

  // a new session after end starts its own read rather than sharing the dead one
  const again = host("dir");
  void again.controller.start(true);
  await flush();
  again.controller.end();
  const fresh = again.controller.start(true);
  await flush();
  expect(again.runs).toHaveLength(2);
  again.runs[0]!.answer.resolve(FAILED);
  again.runs[1]!.answer.resolve(OK);
  await fresh;
  expect(again.published).toEqual([{ snapshot: SNAPSHOT, empty: null, error: null }]);
  expect(again.effects).toEqual(["publish", "status", "open"]);
});

// queue row 280, the whole class: every automatic refresh, whichever entry armed the timer, rechecks the session folder
// and reads only in the folder it checked; a lost folder stops polling with no read.
test("every automatic refresh after a start, a command or both rechecks the session folder, reads only in the checked folder and stops polling once its .tickmarkr is gone", async () => {
  const ENTRIES = ["start", "command", "start then command"] as const;
  const opened = async (entry: (typeof ENTRIES)[number]) => {
    const h = host("dir");
    if (entry !== "command") {
      const started = h.controller.start(true);
      await flush();
      h.runs.at(-1)!.answer.resolve(OK);
      await started;
    }
    if (entry !== "start") {
      const asked = h.controller.command();
      await flush();
      h.runs.at(-1)!.answer.resolve(OK);
      await asked;
    }
    expect(h.timers, entry).toHaveLength(1);
    return h;
  };

  for (const entry of ENTRIES) {
    for (const loss of ["missing", "file", "rejected"] as const) {
      const h = await opened(entry);
      const reads = h.runs.length;
      h.timers[0]!.tick();
      await flush();
      expect(h.runs.length, `${entry}, eligible tick`).toBe(reads + 1);
      h.runs.at(-1)!.answer.resolve(OK);
      await flush();
      h.fs.kind = loss;
      h.timers[0]!.tick();
      await flush();
      expect([h.runs.length, h.timers[0]!.cancelled], `${entry}, ${loss}`).toEqual([reads + 1, true]);
      expect(h.checks.at(-1)).toBe("/work/repo/.tickmarkr");
    }

    // the session folder moves between the check and the read: the tick's read stays in the folder it checked
    const moving = await opened(entry);
    const check = deferred<boolean>();
    moving.hold.check = check;
    moving.timers[0]!.tick();
    await flush();
    moving.fs.cwd = "/unrelated";
    check.resolve(true);
    await flush();
    expect(moving.runs.at(-1)!.cwd, entry).toBe("/work/repo/");
    expect(moving.checks.at(-1)).toBe("/work/repo/.tickmarkr");
    moving.runs.at(-1)!.answer.resolve(OK);
    await flush();
    // the next tick checks the folder the session is in now, and that one holds no .tickmarkr
    moving.fs.kind = "missing";
    const reads = moving.runs.length;
    moving.timers[0]!.tick();
    await flush();
    expect(moving.checks.at(-1)).toBe("/unrelated/.tickmarkr");
    expect([moving.runs.length, moving.timers[0]!.cancelled], entry).toEqual([reads, true]);
  }

  // the same race on an autoload start: the read and the pane follow the checked folder, never the new one
  const start = host("dir");
  const check = deferred<boolean>();
  start.hold.check = check;
  const started = start.controller.start(true);
  await flush();
  start.fs.cwd = "/unrelated";
  check.resolve(true);
  await flush();
  expect(start.runs.map(run => run.cwd)).toEqual(["/work/repo/"]);
  start.runs[0]!.answer.resolve(OK);
  await started;
  expect(start.effects).toEqual(["publish", "status", "open"]);
});
