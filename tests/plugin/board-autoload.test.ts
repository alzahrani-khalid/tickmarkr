import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { POLL_MS, READY_HINT, boardController, boardStatusLine, shown, type BoardDeps } from "../../hooks/board/model.js";
import type { BoardState, RunSnapshot } from "../../hooks/board/state.js";

// Queue row 343 (D-2180): the real boardController over the same fake host as board-register.test.ts. Wire variants
// are the golden snapshot with ended left null or replaced by its object form — never a boolean.
const GOLDENS = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/board/goldens.json"), "utf8")) as {
  io: { expected: Record<string, unknown> }[];
};
const BASE = { ...GOLDENS.io[0]!.expected, version: 1, readAt: "10:00:00", spec: null } as unknown as RunSnapshot;
type Ran = Awaited<ReturnType<BoardDeps["run"]>>;
type Ended = NonNullable<RunSnapshot["ended"]>;
type Answer = Ran | "reject";

const endedOf = (owed: number | null): Ended => ({
  done: ["T1"], failed: [], human: [], blocked: [], pending: [],
  tipVerify: owed === null || owed > 0 ? null : "passed", owed,
});
const snap = (patch: Partial<RunSnapshot>): RunSnapshot => ({ ...BASE, ...patch });
const ok = (snapshot: RunSnapshot): Ran => ({ exitCode: 0, stdout: `${JSON.stringify(snapshot)}\n`, stderr: "" });
const EMPTY: Ran = { exitCode: 0, stdout: '{"version":1,"empty":"no tickmarkr run under /work/repo/.tickmarkr"}\n', stderr: "" };
const FAILED: Ran = { exitCode: 1, stdout: "", stderr: "board: cannot read /work/repo/.tickmarkr\n" };
const MALFORMED: Ran = { exitCode: 0, stdout: "{", stderr: "" };
const flush = (): Promise<void> => new Promise(done => setImmediate(done));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

type Folder = "dir" | "file" | "missing" | "rejected";

/** A fake host: every dep a plain function, every effect recorded, every process read held until answered. */
function host(folder: Folder = "dir") {
  const fs: { kind: Folder; cwd: string; placed: boolean } = { kind: folder, cwd: "/work/repo/", placed: true };
  const checks: string[] = [];
  const runs: { argv: readonly string[]; cwd: string; answer: Deferred<Ran> }[] = [];
  const timers: { ms: number; tick: () => void; cancelled: boolean }[] = [];
  const effects: string[] = [];
  const published: BoardState[] = [];
  const statuses: (string | undefined)[] = [];
  const hold: { publish?: Deferred<void>; check?: Deferred<boolean>; open?: Deferred<boolean> } = {};
  const deps: BoardDeps = {
    cwd: async () => fs.cwd,
    isDirectory: async path => {
      checks.push(path);
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
    open: async () => {
      effects.push("open");
      const pending = hold.open;
      hold.open = undefined;
      if (pending) return pending.promise;
      return fs.placed;
    },
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

type Host = ReturnType<typeof host>;
const opens = (h: Host): number => h.effects.filter(effect => effect === "open").length;

function settle(run: Host["runs"][number], answer: Answer): void {
  if (answer === "reject") run.answer.reject(new Error("spawn tickmarkr ENOENT"));
  else run.answer.resolve(answer);
}

/** Start, prove the read lands before any placement, then deliver the answer. */
async function boot(h: Host, answer: Answer): Promise<void> {
  const started = h.controller.start(true);
  await flush();
  expect(h.runs).toHaveLength(1);
  expect(opens(h)).toBe(0);
  settle(h.runs[0]!, answer);
  await started;
}

/** One poll of the single live timer. A second read beside an in-flight one is a failure. */
async function poll(h: Host, answer: Answer): Promise<void> {
  const before = h.runs.length;
  const timer = h.timers.at(-1)!;
  expect(timer.cancelled).toBe(false);
  timer.tick();
  await flush();
  expect(h.runs).toHaveLength(before + 1);
  expect(h.timers.filter(item => !item.cancelled)).toHaveLength(1);
  settle(h.runs[before]!, answer);
  await flush();
}

test("eligible start opens once for a run without an end whether its daemon is alive or down while ended empty and failed reads stay closed and polling", async () => {
  for (const alive of [true, false, null] as const) {
    const h = host();
    const run = snap({ runId: `run-alive-${String(alive)}`, alive, ended: null });
    await boot(h, ok(run));
    expect(opens(h), String(alive)).toBe(1);
    expect(h.timers.map(timer => timer.ms), String(alive)).toEqual([POLL_MS]);
    expect(h.published.at(-1)?.snapshot, String(alive)).toMatchObject({ runId: run.runId, alive, ended: null });
    expect(h.statuses.at(-1), String(alive)).toMatch(alive === true ? / live · / : / daemon down · /);
    if (alive === true) {
      expect(h.runs[0]!.argv).toEqual(["tickmarkr", "board", "--json", "--root", "/elsewhere/.tickmarkr"]);
      expect(h.runs[0]!.cwd).toBe("/work/repo/");
    }
    await poll(h, ok(run));
    expect(opens(h), `${String(alive)} again`).toBe(1);
    expect(h.timers[0]!.cancelled, String(alive)).toBe(false);
  }

  const closed = async (label: string, answer: Answer, kind: "ended" | "empty" | "error"): Promise<void> => {
    const h = host();
    await boot(h, answer);
    expect(opens(h), label).toBe(0);
    expect(h.timers.map(timer => [timer.ms, timer.cancelled]), label).toEqual([[POLL_MS, false]]);
    const state = h.published.at(-1)!;
    if (kind === "ended") {
      expect(state.snapshot?.ended, label).toEqual(expect.any(Object));
      expect(h.statuses.at(-1), label).toMatch(/ ended · /);
    } else expect(state.snapshot, label).toBeNull();
    if (kind === "empty") expect(state.empty, label).toContain("no tickmarkr run");
    if (kind === "error") expect(state.error, label).toEqual(expect.any(String));
    if (kind !== "ended") expect(h.statuses, label).toEqual([undefined]);
    await poll(h, answer === "reject" ? FAILED : answer);
    expect(opens(h), `${label} still closed`).toBe(0);
    expect(h.runs, label).toHaveLength(2);
    expect(h.timers[0]!.cancelled, label).toBe(false);
  };

  await closed("ended", ok(snap({ runId: "run-ended", alive: true, ended: endedOf(0) })), "ended");
  await closed("owed", ok(snap({ runId: "run-owed", alive: false, ended: endedOf(4) })), "ended");
  await closed("empty", EMPTY, "empty");
  await closed("failed", FAILED, "error");
  await closed("malformed", MALFORMED, "error");
  await closed("rejected", "reject", "error");
});

test("eligible closed-pane polling opens each newly observed unfinished run once while an already opened run never reopens after operator close", async () => {
  const h = host();
  const wire = (id: string, alive: boolean | null, ended: RunSnapshot["ended"]): Ran => ok(snap({ runId: id, alive, ended }));
  // The first read is empty, so the pane stays closed and the poll is what can open a later run.
  await boot(h, EMPTY);
  expect(opens(h)).toBe(0);

  await poll(h, wire("run-a", true, null));
  expect(opens(h)).toBe(1);
  // No close event arrives. The successful open is what keeps an operator-closed pane shut for that id.
  await poll(h, wire("run-a", true, null));
  await poll(h, wire("run-a", false, null));
  await poll(h, wire("run-a", null, null));
  expect(opens(h)).toBe(1);

  await poll(h, wire("run-b", null, null));
  expect(opens(h)).toBe(2);
  await poll(h, wire("run-b", true, null));
  expect(opens(h)).toBe(2);

  await poll(h, wire("run-b", true, endedOf(2)));
  await poll(h, EMPTY);
  await poll(h, FAILED);
  expect(opens(h)).toBe(2);
  expect(h.statuses.at(-1)).toBeUndefined();
  expect(h.timers).toHaveLength(1);

  // A narrow miss leaves the id unlatched. The command that then places the snapshot records it, so the
  // pane the operator closes afterwards is not opened again.
  const narrow = host();
  narrow.fs.placed = false;
  const shownRun = snap({ runId: "run-narrow", alive: null, ended: null });
  await boot(narrow, ok(shownRun));
  expect(opens(narrow)).toBe(1);
  expect(narrow.statuses.at(-1)).toBe(READY_HINT);
  narrow.fs.placed = true;
  const asked = narrow.controller.command();
  await flush();
  expect(narrow.runs).toHaveLength(2);
  narrow.runs[1]!.answer.resolve(ok(shownRun));
  await asked;
  expect(opens(narrow)).toBe(2);
  await poll(narrow, ok(shownRun));
  await poll(narrow, ok({ ...shownRun, alive: false }));
  expect(opens(narrow)).toBe(2);
  // The command kept the one armed poll (B7, D-2184): a live timer is not replaced.
  expect(narrow.timers).toHaveLength(1);
  expect(narrow.timers[0]!.cancelled).toBe(false);
});

test("an unplaced automatic attempt keeps the ready hint and poll without latching while a later placed poll records the run once", async () => {
  const h = host();
  h.fs.placed = false;
  const run = snap({ runId: "run-narrow", alive: true, ended: null });
  await boot(h, ok(run));
  expect(opens(h)).toBe(1);
  expect(h.timers.map(timer => [timer.ms, timer.cancelled])).toEqual([[POLL_MS, false]]);
  expect(h.statuses.slice(0, 2)).toEqual([boardStatusLine(shown(h.published[0]!.snapshot!)), READY_HINT]);

  // The miss did not latch: the next poll is a new attempt, still one, and the hint stays.
  await poll(h, ok(run));
  expect(opens(h)).toBe(2);
  expect(h.statuses.at(-1)).toBe(READY_HINT);

  // Two ticks, one shared completion, and a further completion while placement is in flight: one attempt.
  const gate = deferred<boolean>();
  h.hold.open = gate;
  const before = h.runs.length;
  h.timers[0]!.tick();
  h.timers[0]!.tick();
  await flush();
  expect(h.runs).toHaveLength(before + 1);
  h.runs[before]!.answer.resolve(ok(run));
  await flush();
  expect(opens(h)).toBe(3);
  const during = h.runs.length;
  h.timers[0]!.tick();
  await flush();
  expect(h.runs).toHaveLength(during + 1);
  h.runs[during]!.answer.resolve(ok(run));
  await flush();
  expect(opens(h)).toBe(3);
  // This placement belongs to the previous read. Its miss cannot overwrite the newer read's status (contract C).
  gate.resolve(false);
  await flush();
  expect(opens(h)).toBe(3);
  expect(h.statuses.at(-1)).toBe(boardStatusLine(shown(run)));
  expect(h.timers).toHaveLength(1);

  h.fs.placed = true;
  await poll(h, ok(run));
  expect(opens(h)).toBe(4);
  expect(h.statuses.at(-1)).toMatch(/ live · /);
  await poll(h, ok(run));
  await poll(h, ok({ ...run, alive: false }));
  expect(opens(h)).toBe(4);
  expect(h.timers[0]!.cancelled).toBe(false);
});

test("the explicit command opens ended empty and failed snapshots while automatic starts outside eligible interactive sessions have no effect", async () => {
  for (const folder of ["missing", "file", "rejected"] as const) {
    const h = host(folder);
    await h.controller.start(true);
    expect(h.checks, folder).toEqual(["/work/repo/.tickmarkr"]);
    expect([h.runs.length, h.timers.length, h.effects], folder).toEqual([0, 0, []]);
  }
  const quiet = host();
  await quiet.controller.start(false);
  expect([quiet.checks, quiet.runs.length, quiet.timers.length, quiet.effects]).toEqual([[], 0, 0, []]);

  // The command does not inherit the autoload condition, including in a folder that start refused.
  const outside = host("missing");
  await outside.controller.start(true);
  expect(outside.effects).toEqual([]);
  const forced = outside.controller.command();
  await flush();
  expect(outside.runs).toHaveLength(1);
  outside.runs[0]!.answer.resolve(FAILED);
  await forced;
  expect(opens(outside)).toBe(1);
  // The folder check still throws. B7 (D-2184): that rejection reads nothing and does not stop the poll.
  outside.timers[0]!.tick();
  await flush();
  outside.timers[0]!.tick();
  await flush();
  expect([outside.runs.length, outside.timers[0]!.cancelled]).toEqual([1, false]);

  const ended = host();
  const endedSnap = snap({ runId: "run-ended", alive: true, ended: endedOf(3) });
  await boot(ended, ok(endedSnap));
  expect(opens(ended)).toBe(0);
  const asked = ended.controller.command();
  await flush();
  expect(ended.runs).toHaveLength(2);
  ended.runs[1]!.answer.resolve(ok(endedSnap));
  await asked;
  expect(opens(ended)).toBe(1);
  // The placed snapshot's run id is recorded, so the same id does not auto-open once it looks unfinished.
  await poll(ended, ok(snap({ runId: "run-ended", alive: false, ended: null })));
  expect(opens(ended)).toBe(1);
  await poll(ended, ok(snap({ runId: "run-other", alive: null, ended: null })));
  expect(opens(ended)).toBe(2);

  const emptied = host();
  const askedEmpty = emptied.controller.command();
  await flush();
  emptied.runs[0]!.answer.resolve(EMPTY);
  await askedEmpty;
  expect(opens(emptied)).toBe(1);
  expect(emptied.published.at(-1)?.snapshot).toBeNull();
  await poll(emptied, ok(snap({ runId: "run-after-empty", alive: true, ended: null })));
  expect(opens(emptied)).toBe(2);

  const failed = host();
  const askedFailed = failed.controller.command();
  await flush();
  failed.runs[0]!.answer.resolve(FAILED);
  await askedFailed;
  expect(opens(failed)).toBe(1);
  expect(failed.published.at(-1)).toMatchObject({ snapshot: null, error: expect.any(String) });
  await poll(failed, ok(snap({ runId: "run-after-failed", alive: null, ended: null })));
  expect(opens(failed)).toBe(2);

  const rejected = host();
  const askedRejected = rejected.controller.command();
  await flush();
  rejected.runs[0]!.answer.reject(new Error("spawn tickmarkr ENOENT"));
  await askedRejected;
  expect(opens(rejected)).toBe(1);
  expect(rejected.published.at(-1)?.snapshot).toBeNull();
});

test("closed-pane observation shares one timer and read while folder loss or session end suppresses later effects and a new session starts fresh", async () => {
  const h = host();
  const run = snap({ runId: "run-shared", alive: true, ended: null });
  await boot(h, EMPTY);
  expect(opens(h)).toBe(0);
  expect(h.timers).toHaveLength(1);

  const before = h.runs.length;
  h.timers[0]!.tick();
  h.timers[0]!.tick();
  await flush();
  expect(h.runs).toHaveLength(before + 1);
  expect(h.timers).toHaveLength(1);
  h.runs[before]!.answer.resolve(ok(run));
  await flush();
  // Two completions of one read place the new unfinished run once.
  expect(opens(h)).toBe(1);

  // Not a directory: the unchanged stop. A thrown "missing" check is a rejection and keeps polling (B7, D-2184).
  h.fs.kind = "file";
  h.timers[0]!.tick();
  await flush();
  expect([h.runs.length, h.timers[0]!.cancelled, opens(h)]).toEqual([before + 1, true, 1]);
  expect(h.checks.at(-1)).toBe("/work/repo/.tickmarkr");

  const late = host();
  const pending = late.controller.start(true);
  await flush();
  late.controller.end();
  late.runs[0]!.answer.resolve(ok(run));
  await pending;
  expect([late.effects, late.timers.length]).toEqual([[], 0]);

  const midCheck = host();
  const held = deferred<boolean>();
  midCheck.hold.check = held;
  const checking = midCheck.controller.start(true);
  await flush();
  midCheck.controller.end();
  held.resolve(true);
  await checking;
  expect([midCheck.runs.length, midCheck.timers.length, midCheck.effects]).toEqual([0, 0, []]);

  // A late successful placement from the ended session must not consume the new session's fresh latch.
  const raced = host();
  const firstGate = deferred<boolean>();
  raced.hold.open = firstGate;
  const first = raced.controller.start(true);
  await flush();
  raced.runs[0]!.answer.resolve(ok(run));
  await flush();
  expect(opens(raced)).toBe(1);
  raced.controller.end();
  const secondGate = deferred<boolean>();
  raced.hold.open = secondGate;
  const second = raced.controller.start(true);
  await flush();
  raced.runs[1]!.answer.resolve(ok(run));
  await flush();
  expect(opens(raced)).toBe(2);
  const marked = raced.statuses.length;
  const published = raced.published.length;
  firstGate.resolve(false);
  await first;
  await flush();
  expect(raced.statuses).toHaveLength(marked);
  expect(raced.published).toHaveLength(published);
  const live = raced.timers.at(-1)!;
  expect(live.cancelled).toBe(false);
  const reads = raced.runs.length;
  live.tick();
  await flush();
  expect(raced.runs).toHaveLength(reads + 1);
  raced.runs[reads]!.answer.resolve(ok(run));
  await flush();
  expect(opens(raced)).toBe(2);
  secondGate.resolve(true);
  await second;
  await flush();
  expect(opens(raced)).toBe(2);
  expect(raced.statuses.at(-1)).not.toBe(READY_HINT);
  await poll(raced, ok(run));
  expect(opens(raced)).toBe(2);
  expect(raced.published.every(state => state.snapshot?.runId === "run-shared")).toBe(true);
});
