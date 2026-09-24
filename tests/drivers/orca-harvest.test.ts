import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { trailerPattern } from "../../src/adapters/prompt.js";
import { classifyHost } from "../../src/drivers/index.js";
import { casBoard, OrcaDriver, OrcaUnavailableError, type OrcaExec } from "../../src/drivers/orca.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { stateDirName } from "../../src/graph/graph.js";
import { observeNamedRun, readWatchBoard, type WatchBoardOwner } from "../../src/run/supervision.js";
import { FakeOrca, ORCA_FIXTURE_NONCE, steppedTime, type FakeOrcaOpts } from "../helpers/fake-orca.js";
import { makeRepo } from "../helpers/tmprepo.js";

// v2.5.6 T2 — harvest truth on Orca (OBS-1011 add.1, OBS-1016, OBS-1009): the cursor stream of a LIVE
// Orca terminal can answer the dead-record shape (status exited, empty tail) while the rendered frame
// still carries the trailer. Liveness is decided by show + screen, never by that one stream page.

const WT = "/tmp/orca-harvest/T1";
const TITLE = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId: "run-harvest" });
const TRAILER = trailerPattern(ORCA_FIXTURE_NONCE);
/** The nonce-bound trailer as the renderer paints it: three hard-wrapped rows behind margin chrome. */
const SCREEN_TRAILER = [
  `TICKMARKR_RESULT_${ORCA_FIXTURE_NONCE} {"ok":`,
  `│ true,"summary":"painted on the`,
  `│ screen only","deviations":[]}`,
];

function rig(opts: FakeOrcaOpts = {}, exec?: (fake: FakeOrca) => OrcaExec): { fake: FakeOrca; driver: OrcaDriver; clock: ReturnType<typeof steppedTime> } {
  const fake = new FakeOrca({ trackedWorktrees: [WT], ...opts });
  const clock = steppedTime();
  return { fake, clock, driver: new OrcaDriver({ exec: exec ? exec(fake) : fake.exec, time: clock, launchingHandle: "term_launch" }) };
}

/** A bound worker slot whose stream answers the OBS-1011 add.1 incident shape. */
async function blindSlot(driver: OrcaDriver, fake: FakeOrca, over: Record<string, unknown> = {}): Promise<Slot> {
  const slot = await driver.slot(WT, TITLE);
  await driver.run(slot, "bash");
  Object.assign(fake.last()!, {
    status: "exited", lines: [], connected: true, orphaned: false,
    screenStatus: "running", screenLines: ["$ claude", "⏺ done", ...SCREEN_TRAILER],
    ...over,
  });
  return slot;
}

const screenReads = (fake: FakeOrca) => fake.calls.filter((c) => c[1] === "read" && c.includes("--screen")).length;

/** Rewrites one field of the fake's show record — a lookalike answering for another handle or runtime. */
function showRewrite(patch: (env: Record<string, unknown>) => void): (fake: FakeOrca) => OrcaExec {
  return (fake) => async (args, cwd, timeoutMs) => {
    const r = await fake.exec(args, cwd, timeoutMs);
    if (args[1] !== "show" || r.code !== 0) return r;
    const env = JSON.parse(r.stdout) as Record<string, unknown>;
    patch(env);
    return { ...r, stdout: JSON.stringify(env) };
  };
}

describe("OrcaDriver harvest truth", () => {
  test("test: a fake Orca whose cursor-paged stream page for a live handle answers the captured incident shape of status exited with an empty tail and zero returned lines while its show record for the same handle and runtime reports connected true and orphaned false and its screen read reports running and paints a nonce-bound trailer across three wrapped rows satisfies the driver's output wait within one poll and its tail read returns the screen text, a stream page that returns lines is matched with no screen call issued, and the same stream shape over a show record reporting disconnected or orphaned, a show record naming another handle or runtime, or a screen read that is unavailable or reports exited satisfies nothing and is refused as unavailable, so a driver that throws on the exited-shaped stream record before reading the screen, that demands a status field on the show record, or that harvests a disconnected, orphaned or mismatched terminal fails", async () => {
    // blind stream, live show, running screen: the frame is the terminal's bytes
    const live = rig();
    const slot = await blindSlot(live.driver, live.fake);
    const streamPage = JSON.parse((await live.fake.exec(["terminal", "read", "--terminal", live.fake.last()!.handle, "--limit", "500", "--json"], WT)).stdout).result.terminal;
    expect(streamPage).toMatchObject({ status: "exited", tail: [], returnedLineCount: 0 });
    const showRecord = JSON.parse((await live.fake.exec(["terminal", "show", "--terminal", live.fake.last()!.handle, "--json"], WT)).stdout).result.terminal;
    expect(showRecord).toMatchObject({ connected: true, orphaned: false });
    expect(showRecord.status).toBeUndefined(); // show carries no status field; none is demanded
    const before = live.clock.now();
    expect(await live.driver.waitOutput(slot, TRAILER, 60_000, { regex: true })).toBe(true);
    expect(live.clock.now()).toBe(before); // satisfied within one poll: no sleep was taken
    expect(screenReads(live.fake)).toBeGreaterThan(0);
    expect(await live.driver.read(slot, 300)).toBe(["$ claude", "⏺ done", ...SCREEN_TRAILER].join("\n"));

    // a stream page that returns lines is matched from the stream alone
    const streaming = rig();
    const streamSlot = await streaming.driver.slot(WT, TITLE);
    await streaming.driver.run(streamSlot, "bash");
    streaming.fake.last()!.lines = ["working", ...SCREEN_TRAILER];
    expect(await streaming.driver.waitOutput(streamSlot, TRAILER, 60_000, { regex: true })).toBe(true);
    expect(screenReads(streaming.fake)).toBe(0);

    // the same stream shape over anything less than a live, running, matching terminal is unavailable
    const refused: Array<[string, FakeOrcaOpts, Record<string, unknown>, ((fake: FakeOrca) => OrcaExec) | undefined]> = [
      ["disconnected", {}, { connected: false }, undefined],
      ["orphaned", {}, { orphaned: true }, undefined],
      ["another handle", {}, {}, showRewrite((env) => { ((env.result as Record<string, unknown>).terminal as Record<string, unknown>).handle = "term_lookalike"; })],
      ["another runtime", {}, {}, showRewrite((env) => { (env._meta as Record<string, unknown>).runtimeId = "rt-other"; })],
      ["screen unavailable", {}, { screenSource: "screen-unavailable" }, undefined],
      ["screen exited", {}, { screenStatus: "exited" }, undefined],
    ];
    for (const [label, opts, over, exec] of refused) {
      const r = rig(opts, exec);
      const s = await blindSlot(r.driver, r.fake, over);
      await expect(r.driver.waitOutput(s, TRAILER, 60_000, { regex: true }), label).rejects.toBeInstanceOf(OrcaUnavailableError);
      await expect(r.driver.read(s, 300), label).rejects.toBeInstanceOf(OrcaUnavailableError);
    }
  });

  test("test: nudge on a fake whose send receipt carries prompt stages including turn_started returns true with no echo sweep, a receipt without that stage whose screen read shows the composer emptied returns true, and an accepted receipt whose screen still shows the text in the composer returns false at the echo timeout, so a nudge proven by stream echo fails", async () => {
    const message = "continue now";
    const staged = rig({ sendStages: ["input_accepted", "turn_started"], echoSends: false });
    const stagedSlot = await staged.driver.slot(WT, TITLE);
    await staged.driver.run(stagedSlot, "bash");
    staged.fake.last()!.tuiIdle = true;
    expect(await staged.driver.nudge(stagedSlot, message)).toBe(true);
    const sendAt = staged.fake.families().indexOf("send");
    expect(sendAt).toBeGreaterThan(0);
    expect(staged.fake.calls[sendAt]).toContain("--wait-submit");
    expect(staged.fake.calls[sendAt]![staged.fake.calls[sendAt]!.indexOf("--wait-submit") + 1]).toBe("15");
    expect(staged.fake.calls.slice(sendAt + 1).filter((c) => c[1] === "read")).toEqual([]); // no echo sweep, no screen read
    expect(staged.fake.sent.get(staged.fake.last()!.handle)).toEqual([message]);

    // no stage on the receipt: the composer emptied on the screen read proves delivery
    const emptied = rig({ echoSends: false });
    const emptiedSlot = await emptied.driver.slot(WT, TITLE);
    await emptied.driver.run(emptiedSlot, "bash");
    const afterEmptiedLaunch = emptied.fake.calls.length;
    Object.assign(emptied.fake.last()!, { tuiIdle: true, lines: ["> "], screenLines: ["⏺ working on it", "> "] });
    expect(await emptied.driver.nudge(emptiedSlot, message)).toBe(true);
    expect(screenReads(emptied.fake)).toBe(1);
    expect(emptied.fake.calls.slice(afterEmptiedLaunch).some((c) => c[1] === "read" && c.includes("--cursor"))).toBe(false);

    // accepted, but the frame still shows the text in the composer: false at the echo timeout —
    // and the stream DOES carry the echo here, so a driver proving delivery from the echo says true
    const stuck = rig();
    const stuckSlot = await stuck.driver.slot(WT, TITLE);
    await stuck.driver.run(stuckSlot, "bash");
    stuck.fake.last()!.tuiIdle = true;
    const t0 = stuck.clock.now();
    expect(await stuck.driver.nudge(stuckSlot, message)).toBe(false);
    expect(stuck.fake.last()!.lines).toContain(message); // the stream echo that must not count
    expect(stuck.clock.now() - t0).toBeGreaterThanOrEqual(2_000);
    expect(screenReads(stuck.fake)).toBeGreaterThan(1);
  });

  test("test: classifyHost with a whitespace-only terminal handle classifies none; two driver instances racing the board owner lock where the first crashes after its reservation write leave the canonical record present and readable at every step, the second binds after it recovers the dead holder's lock within one injected tick when that holder's observer is dead, and while the crashed holder's observer is still alive the second is refused and neither replaces nor acts on the record until that observer's acknowledged stop arrives on injected time, after which it binds; a live holder is refused after the bounded wait with the record untouched; a fixture observer that claims after two injected ticks is bound, one that never claims leaves a tombstone so the next narrator call issues a fresh split, and a split whose receipt is malformed or handle-less rejects naming placement, tombstones the reservation and never closes a guessed handle, so a lock without staleness recovery, a crash that orphans the record, a replacement before the observer's acknowledged stop, a wall-clock claim wait, or an accepted malformed receipt fails", async () => {
    expect(classifyHost({ TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: " \t " })).toBe("none");
    expect(classifyHost({ TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term_x" })).toBe("orca");

    const repo = makeRepo({ "base.txt": "base\n" });
    const launching = "term_launching";
    const boardFile = (runId: string) => join(repo, stateDirName(repo), "supervision", `watch-board.${runId}.json`);
    const bytes = (runId: string) => readFileSync(boardFile(runId), "utf8");
    const command = (runId: string) => `tickmarkr run --view run-board --run-id ${runId}`;
    const observers: Array<ReturnType<typeof observeNamedRun>> = [];
    const deadPid = spawnSync("true").pid!; // a process that has exited: its pid is dead
    expect(() => process.kill(deadPid, 0)).toThrow();

    // one clock for every driver: claims, stops and lock waits all run on injected time
    const clock = steppedTime();
    const rigFor = (opts: FakeOrcaOpts = {}) => {
      const fake = new FakeOrca({ terminals: [{ handle: launching, title: "launching-tab", worktree: repo }], trackedWorktrees: [repo], ...opts });
      return { fake, driver: () => new OrcaDriver({ exec: fake.exec, time: clock, launchingHandle: launching }) };
    };
    const { fake, driver } = rigFor();
    const hooks = { claimAfter: 0, crashAfterClaim: false, crashBeforeClaim: false, ackStop: false, runId: "", observer: undefined as ReturnType<typeof observeNamedRun> | undefined, readable: [] as string[] };
    const claim = () => {
      hooks.observer = observeNamedRun(repo, hooks.runId, { TICKMARKR_WATCH_OWNER: readWatchBoard(repo, hooks.runId)!.token });
      observers.push(hooks.observer);
    };
    const sleep = clock.sleep;
    clock.sleep = async (ms) => {
      if (hooks.runId && existsSync(boardFile(hooks.runId))) hooks.readable.push(bytes(hooks.runId));
      if (hooks.ackStop && hooks.observer?.stopRequested()) hooks.observer.close();
      if (hooks.crashBeforeClaim && readWatchBoard(repo, hooks.runId)?.pid === undefined) { hooks.crashBeforeClaim = false; throw new Error("driver one crashed before any claim"); }
      // the fixture observer claims only an unclaimed reservation — never during a stop wait
      if (hooks.claimAfter > 0 && readWatchBoard(repo, hooks.runId)?.pid === undefined && --hooks.claimAfter === 0) {
        claim();
        if (hooks.crashAfterClaim) { hooks.crashAfterClaim = false; throw new Error("driver one crashed after its reservation write"); }
      }
      return sleep(ms);
    };
    const splits = () => fake.countOf("split");
    const closes = () => fake.calls.filter((c) => c[1] === "close").map((c) => c[3]);

    // the placing narrator's pid is the record's `placer`; a crashed placer is a dead pid
    const placerDied = (runId: string) => writeFileSync(boardFile(runId), JSON.stringify({ ...JSON.parse(bytes(runId)), placer: deadPid }) + "\n");

    // --- overlapping narrator calls: a claimed record whose placer LIVES is a normal intermediate
    // state — refused untouched, its healthy observer never asked to stop, no split, no retire ---
    const overlapRun = "run-overlap-live-placer";
    hooks.runId = overlapRun;
    hooks.claimAfter = 1;
    hooks.crashAfterClaim = true;
    await expect(driver().narrator(repo, command(overlapRun), overlapRun)).rejects.toThrow(/driver one crashed/);
    const claimedLive = bytes(overlapRun);
    expect(JSON.parse(claimedLive)).toMatchObject({ pane: "", pid: process.pid, placer: process.pid });
    const overlapObserver = hooks.observer!;
    const splitsBeforeOverlap = splits();
    await expect(driver().narrator(repo, command(overlapRun), overlapRun)).rejects.toThrow(/remains unresolved .*claimed/);
    expect(bytes(overlapRun)).toBe(claimedLive);
    expect(overlapObserver.stopRequested()).toBe(false);
    expect(splits()).toBe(splitsBeforeOverlap);

    // --- crash between reservation and CLAIM (no observer yet), holder's lock left behind: the
    // second recovers the dead placer's reservation and binds within one injected tick ---
    const earlyRun = "run-crash-before-claim";
    hooks.runId = earlyRun;
    hooks.claimAfter = 0;
    hooks.crashBeforeClaim = true;
    await expect(driver().narrator(repo, command(earlyRun), earlyRun)).rejects.toThrow(/driver one crashed before any claim/);
    expect(JSON.parse(bytes(earlyRun))).toMatchObject({ pane: "", placer: process.pid });
    expect(JSON.parse(bytes(earlyRun)).pid).toBeUndefined();
    placerDied(earlyRun);
    const earlyLock = `${boardFile(earlyRun)}.lock`;
    mkdirSync(earlyLock);
    writeFileSync(join(earlyLock, "pid"), String(deadPid));
    hooks.claimAfter = 1;
    hooks.readable = [];
    const tEarly = clock.now();
    const boundAfterEarly = await driver().narrator(repo, command(earlyRun), earlyRun);
    expect(clock.now() - tEarly).toBeLessThanOrEqual(20);
    expect(hooks.readable.length).toBeGreaterThan(0);
    for (const raw of hooks.readable) expect(JSON.parse(raw)).toMatchObject({ runId: earlyRun });
    expect(readWatchBoard(repo, earlyRun)).toMatchObject({ pane: boundAfterEarly.id, pid: process.pid });
    expect(existsSync(earlyLock)).toBe(false);

    // --- crash between claim and bind, observer LIVE: refused until the acknowledged stop ---
    const crashRun = "run-crash-live";
    hooks.runId = crashRun;
    hooks.claimAfter = 1;
    hooks.crashAfterClaim = true;
    await expect(driver().narrator(repo, command(crashRun), crashRun)).rejects.toThrow(/driver one crashed/);
    placerDied(crashRun);
    const claimed = bytes(crashRun);
    expect(JSON.parse(claimed)).toMatchObject({ driver: "orca", pane: "", pid: process.pid, placer: deadPid });
    // the crash left the holder's lock behind, pid and all
    const lock = `${boardFile(crashRun)}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(deadPid));
    const liveObserver = hooks.observer!;
    hooks.observer = liveObserver;
    hooks.ackStop = false;
    const splitsBefore = splits();
    await expect(driver().narrator(repo, command(crashRun), crashRun)).rejects.toThrow(/live observer unacknowledged/);
    expect(bytes(crashRun)).toBe(claimed); // neither replaced nor acted on
    expect(splits()).toBe(splitsBefore);
    expect(existsSync(lock)).toBe(true);
    hooks.ackStop = true;
    hooks.claimAfter = 1;
    hooks.readable = [];
    const boundAfterAck = await driver().narrator(repo, command(crashRun), crashRun);
    expect(hooks.readable.length).toBeGreaterThan(0);
    for (const raw of hooks.readable) expect(JSON.parse(raw)).toMatchObject({ runId: crashRun }); // present and readable at every step
    expect(readWatchBoard(repo, crashRun)).toMatchObject({ pane: boundAfterAck.id, pid: process.pid });
    expect(readWatchBoard(repo, crashRun)?.token).not.toBe(JSON.parse(claimed).token);
    expect(existsSync(lock)).toBe(false);
    expect(splits()).toBe(splitsBefore + 1);

    // --- crash between claim and bind, observer DEAD: the lock is recovered within one tick ---
    const deadRun = "run-crash-dead";
    hooks.runId = deadRun;
    hooks.claimAfter = 1;
    hooks.crashAfterClaim = true;
    await expect(driver().narrator(repo, command(deadRun), deadRun)).rejects.toThrow(/driver one crashed/);
    const deadObserver = hooks.observer!;
    // the observer is gone: its record names a dead pid (the process that claimed it no longer runs)
    const orphaned = { ...(JSON.parse(bytes(deadRun)) as WatchBoardOwner), pid: deadPid, placer: deadPid };
    writeFileSync(boardFile(deadRun), JSON.stringify(orphaned) + "\n");
    const deadLock = `${boardFile(deadRun)}.lock`;
    mkdirSync(deadLock);
    writeFileSync(join(deadLock, "pid"), String(deadPid));
    hooks.observer = undefined;
    hooks.claimAfter = 1;
    hooks.readable = [];
    const t0 = clock.now();
    const boundAfterDead = await driver().narrator(repo, command(deadRun), deadRun);
    expect(clock.now() - t0).toBeLessThanOrEqual(20); // one injected tick: the claim poll, none for the lock
    for (const raw of hooks.readable) expect(JSON.parse(raw)).toMatchObject({ runId: deadRun });
    expect(readWatchBoard(repo, deadRun)).toMatchObject({ pane: boundAfterDead.id, pid: process.pid });
    expect(existsSync(deadLock)).toBe(false);

    // --- crashes before a valid owner marker is published are recoverable too. A pid-less lock and
    // a legacy malformed pid generation are both superseded atomically, without a wall-clock wait. ---
    for (const [label, malformed] of [["pid-less", false], ["malformed", true]] as const) {
      const crashWindowLock = `${boardFile(deadRun)}.lock`;
      mkdirSync(crashWindowLock);
      if (malformed) writeFileSync(join(crashWindowLock, "pid"), "not-a-pid");
      const beforeCrashRecovery = bytes(deadRun);
      const tCrash = clock.now();
      const recovered = await casBoard("split", boardFile(deadRun), beforeCrashRecovery, {
        ...JSON.parse(beforeCrashRecovery), token: `recovered-${label}`,
      }, clock);
      expect(clock.now() - tCrash, label).toBe(0);
      expect(bytes(deadRun), label).toBe(recovered);
      expect(existsSync(crashWindowLock), label).toBe(false);
    }

    // --- simultaneous stale-lock contenders in distinct processes: a dead lock is taken over in
    // place, never recursively removed, so no release can consume another process's fresh marker ---
    const staleLock = `${boardFile(deadRun)}.lock`;
    mkdirSync(staleLock);
    writeFileSync(join(staleLock, "pid"), String(deadPid));
    const contended = bytes(deadRun);
    const start = join(repo, "cas-contenders.start");
    const moduleUrl = new URL("../../src/drivers/orca.ts", import.meta.url).href;
    const childCode = `
      import { existsSync, writeFileSync } from "node:fs";
      import { casBoard } from ${JSON.stringify(moduleUrl)};
      writeFileSync(process.env.TKR_CAS_READY, "ready");
      while (!existsSync(process.env.TKR_CAS_START)) await new Promise((resolve) => setTimeout(resolve, 1));
      const expected = process.env.TKR_CAS_EXPECTED;
      try {
        const value = await casBoard("split", process.env.TKR_CAS_PATH, expected, {
          ...JSON.parse(expected), token: process.env.TKR_CAS_TOKEN,
        });
        console.log(JSON.stringify({ status: "fulfilled", expected, value }));
      } catch (error) {
        console.log(JSON.stringify({ status: "rejected", expected, message: String(error?.message ?? error) }));
      }
    `;
    const children = Array.from({ length: 8 }, (_, i) => {
      const ready = join(repo, `cas-contender-${i}.ready`);
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TKR_CAS_READY: ready,
          TKR_CAS_START: start,
          TKR_CAS_PATH: boardFile(deadRun),
          TKR_CAS_EXPECTED: contended,
          TKR_CAS_TOKEN: `contender-${i}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child, ready, stdout: "", stderr: "" };
    });
    try {
      for (const contender of children) {
        contender.child.stdout.on("data", (chunk) => { contender.stdout += String(chunk); });
        contender.child.stderr.on("data", (chunk) => { contender.stderr += String(chunk); });
      }
      const readyDeadline = Date.now() + 10_000;
      while (children.some((c) => !existsSync(c.ready))) {
        if (Date.now() >= readyDeadline) throw new Error(`CAS contenders did not become ready: ${children.map((c) => c.stderr).join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(start, "go");
      await Promise.all(children.map(({ child }) => new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      })));
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
    }
    const contenders = children.map(({ stdout, stderr }) => {
      expect(stderr).toBe("");
      return JSON.parse(stdout.trim()) as { status: "fulfilled" | "rejected"; expected: string; value?: string; message?: string };
    });
    const winners = contenders.filter((c) => c.status === "fulfilled");
    expect(winners).toHaveLength(1); // no two processes can succeed against the same expected bytes
    expect(contenders.filter((c) => c.status === "rejected").every((c) => /changed underneath/.test(c.message ?? ""))).toBe(true);
    expect(contenders.every((c) => !/ENOTEMPTY/.test(c.message ?? ""))).toBe(true);
    expect(bytes(deadRun)).toBe(winners[0]!.value);
    expect(existsSync(staleLock)).toBe(false);
    // a dead generation beneath a LIVE takeover is somebody's lock: bounded wait, refused, untouched
    mkdirSync(staleLock);
    writeFileSync(join(staleLock, "pid"), String(deadPid));
    writeFileSync(join(staleLock, "pid.1"), String(process.pid));
    const taken = bytes(deadRun);
    await expect(casBoard("split", boardFile(deadRun), taken, { ...JSON.parse(taken), retired: true }, clock)).rejects.toThrow(/lock not acquired; current record kept/);
    expect(bytes(deadRun)).toBe(taken);
    expect(readFileSync(join(staleLock, "pid.1"), "utf8")).toBe(String(process.pid));
    rmSync(staleLock, { recursive: true, force: true });

    // --- a LIVE lock holder is refused after the bounded wait, record untouched ---
    const heldLock = `${boardFile(deadRun)}.lock`;
    mkdirSync(heldLock);
    writeFileSync(join(heldLock, "pid"), String(process.pid));
    const untouched = bytes(deadRun);
    const t1 = clock.now();
    await expect(casBoard("split", boardFile(deadRun), untouched, { ...JSON.parse(untouched), retired: true }, clock)).rejects.toThrow(/lock not acquired; current record kept/);
    expect(clock.now() - t1).toBeGreaterThanOrEqual(2_000);
    expect(bytes(deadRun)).toBe(untouched);
    expect(existsSync(heldLock)).toBe(true);

    // --- a fixture observer that claims after two injected ticks is bound ---
    const lateRun = "run-late-claim";
    hooks.runId = lateRun;
    hooks.claimAfter = 2;
    const t2 = clock.now();
    const late = await driver().narrator(repo, command(lateRun), lateRun);
    expect(clock.now() - t2).toBe(40);
    expect(readWatchBoard(repo, lateRun)).toMatchObject({ pane: late.id, pid: process.pid });

    // --- one that never claims leaves a tombstone; the next call splits afresh ---
    const neverRun = "run-never-claims";
    hooks.runId = neverRun;
    hooks.claimAfter = 0;
    const splitsBeforeNever = splits();
    await expect(driver().narrator(repo, command(neverRun), neverRun)).rejects.toThrow(/unclaimed board/);
    const tombstone = JSON.parse(bytes(neverRun)) as WatchBoardOwner & { retired?: true };
    expect(tombstone).toMatchObject({ driver: "orca", retired: true });
    expect(tombstone.pid).toBeUndefined();
    hooks.claimAfter = 1;
    const fresh = await driver().narrator(repo, command(neverRun), neverRun);
    expect(splits()).toBe(splitsBeforeNever + 2);
    expect(readWatchBoard(repo, neverRun)).toMatchObject({ pane: fresh.id, pid: process.pid });
    expect(readWatchBoard(repo, neverRun)?.token).not.toBe(tombstone.token);

    // --- a malformed or handle-less split receipt: rejected, tombstoned, no guessed close ---
    for (const [label, receipt] of [["handle-less", { tabId: "launching-tab" }], ["malformed", { handle: "term_forged" }]] as const) {
      const malformedRun = `run-malformed-${label}`;
      const bad = rigFor({ splitReceipt: receipt });
      hooks.runId = malformedRun;
      await expect(bad.driver().narrator(repo, command(malformedRun), malformedRun), label).rejects.toThrow(/placement failed .*malformed or handle-less/);
      expect(JSON.parse(bytes(malformedRun)), label).toMatchObject({ driver: "orca", pane: "", retired: true });
      expect(bad.fake.calls.filter((c) => c[1] === "close"), label).toEqual([]);
      expect(bad.fake.countOf("split"), label).toBe(1);
    }
    expect(closes()).not.toContain("term_forged");

    for (const o of [overlapObserver, liveObserver, deadObserver, ...observers]) { try { o.close(); } catch { /* already stopped or superseded */ } }
  });
});
