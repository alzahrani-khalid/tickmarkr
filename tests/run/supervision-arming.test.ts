import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  supervisionBeatPath,
  supervisionStandDownPath,
  supervisionStatus,
  type TierLiveness,
} from "../../src/run/supervision.js";
import { makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// T16. T3 shipped this instrument's reader wired into both status surfaces and its writer called by
// NOTHING but T3's own tests, so every real run read ABSENT — an armed-looking gauge with no needle.
// This file is written as an INDEPENDENT OBSERVER of that arming: it never imports armSupervision or
// beatSupervision, so no state it reads can have come from the test. Every beat below was written by
// a real run's runtime, and every death below is a real daemon process that stopped existing.
//
// The heartbeat writer is deliberately absent from the import list above. Adding it back would let a
// test manufacture the very state the instrument exists to detect.

const TIER = "orchestrator" as const;

/** The reading an operator gets. `now` is the reader's clock, never the record's. */
const state = (repo: string, now?: number): TierLiveness["state"] => supervisionStatus(repo, TIER, now).state;

const activeChildren = new Set<ChildProcess>();
afterEach(() => {
  for (const child of activeChildren) child.kill("SIGKILL");
  activeChildren.clear();
});

const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs: number,
  detail: () => string = () => "",
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

interface Fixture {
  repo: string;
  scriptPath: string;
  fake: FakeAdapter;
  /** Touch this file to release the worker the run holds open. */
  stop: string;
}

/**
 * A run whose single worker blocks until `stop` appears, so the run stays LIVE for as long as the
 * observer needs it. Nothing here writes to the supervision tree.
 */
const fixture = (): Fixture => {
  const stop = join(makeTestTempDir("tickmarkr-sup-stop-"), "stop");
  const { repo, scriptPath, fake } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `while [ ! -f ${shq(stop)} ]; do sleep 0.05; done` }] } },
    "taskTimeoutMinutes: 10\n",
  );
  return { repo, scriptPath, fake, stop };
};

/**
 * A real daemon in its OWN process — the only way to observe a watcher that DIES, because a death is
 * exactly the case where the dying seat cannot record anything. SIGKILL leaves no finally, no signal
 * handler and no stand-down: only whatever the runtime had already written to disk.
 */
const spawnDaemon = (f: Fixture, runId: string): { child: ChildProcess; stderr: () => string } => {
  const root = join(import.meta.dirname, "..", "..");
  const daemonUrl = pathToFileURL(join(root, "src", "run", "daemon.ts")).href;
  const fakeUrl = pathToFileURL(join(root, "src", "adapters", "fake.ts")).href;
  const childCode = `
    import { runDaemon } from ${JSON.stringify(daemonUrl)};
    import { FakeAdapter } from ${JSON.stringify(fakeUrl)};
    await runDaemon(${JSON.stringify(f.repo)}, {
      adapters: [new FakeAdapter(${JSON.stringify(f.scriptPath)})],
      runId: ${JSON.stringify(runId)},
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  return { child, stderr: () => (err ? `\nchild stderr:\n${err}` : "") };
};

const killDaemon = async (f: Fixture, child: ChildProcess): Promise<void> => {
  child.kill("SIGKILL");
  await once(child, "exit");
  activeChildren.delete(child);
  writeFileSync(f.stop, "stop\n"); // the orphaned worker shell has no parent left to reap it
};

/** A real run that armed the tier and was then killed outright: an armed record, no stand-down. */
const armedThenDead = async (runId: string): Promise<{ repo: string; beatMs: number }> => {
  const f = fixture();
  expect(state(f.repo), "nothing armed before the run").toBe("ABSENT");
  const { child, stderr } = spawnDaemon(f, runId);
  const beatPath = supervisionBeatPath(f.repo, TIER);
  await waitFor(() => existsSync(beatPath), `${runId} to arm its own tier`, 90_000, stderr);
  expect(state(f.repo)).toBe("ARMED");
  await killDaemon(f, child);
  // the process that owned the beat is gone, so the record is frozen at whatever it last wrote
  expect(existsSync(supervisionStandDownPath(f.repo, TIER)), "a killed run records no stand-down").toBe(false);
  return { repo: f.repo, beatMs: statSync(beatPath).mtimeMs };
};

test("start runDaemon and read supervisionStatus from disk before start and during execution; it reports ABSENT then ARMED without the test invoking arm or writing a beat, while a control run with arming disabled remains ABSENT, so test-made or stale state cannot pass", async () => {
  // Two runs identical but for arming. The armed one must gain the beat; the control must not — which
  // is what makes the ARMED reading evidence about the RUNTIME rather than about the fixture.
  const armed = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
  const control = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
  expect(state(armed.repo)).toBe("ABSENT");
  expect(state(control.repo)).toBe("ABSENT");
  expect(existsSync(supervisionBeatPath(armed.repo, TIER)), "no beat exists before the run").toBe(false);

  // read from disk on every journal append — i.e. WHILE the run is executing, from another callback
  const duringArmed: TierLiveness[] = [];
  await runDaemon(armed.repo, {
    adapters: [armed.fake], runId: "run-sup-armed",
    narrate: () => duringArmed.push(supervisionStatus(armed.repo, TIER)),
  });
  expect(duringArmed.length).toBeGreaterThan(0);
  expect(new Set(duringArmed.map((t) => t.state))).toEqual(new Set(["ARMED"]));
  // a beat is only evidence if it is FRESH — a record left over from anything else would age out
  expect(duringArmed[0].beatAgeMs).toBeLessThan(SUPERVISION_STALE_MS);

  const duringControl: TierLiveness[] = [];
  await runDaemon(control.repo, {
    adapters: [control.fake], runId: "run-sup-control", supervise: false,
    narrate: () => duringControl.push(supervisionStatus(control.repo, TIER)),
  });
  expect(duringControl.length).toBeGreaterThan(0);
  expect(new Set(duringControl.map((t) => t.state))).toEqual(new Set(["ABSENT"]));
  expect(state(control.repo)).toBe("ABSENT");
  // and the control wrote nothing at all under the supervision tree — not an empty or aged record
  expect(existsSync(join(tickmarkrDir(control.repo), "supervision"))).toBe(false);
  expect(existsSync(supervisionBeatPath(armed.repo, TIER)), "the armed run's runtime wrote the beat").toBe(true);
}, 120_000);

test("the tier a real run armed reads STALE once its beat stops advancing past the staleness ceiling, exercised by stopping the production beat rather than by manufacturing a record, and reads ARMED while that beat is still advancing", async () => {
  const f = fixture();
  const { child, stderr } = spawnDaemon(f, "run-sup-advancing");
  const beatPath = supervisionBeatPath(f.repo, TIER);
  await waitFor(() => existsSync(beatPath), "the run's own first beat", 90_000, stderr);
  const first = readFileSync(beatPath, "utf8");
  expect(state(f.repo)).toBe("ARMED");

  // The production loop re-beats on its own: a second payload lands with nothing in this process
  // touching that path. ARMED here is a reading of a beat that is still ADVANCING, not a stuck one.
  await waitFor(
    () => readFileSync(beatPath, "utf8") !== first,
    "the run's next production beat",
    SUPERVISION_BEAT_MS * 6,
    stderr,
  );
  expect(state(f.repo)).toBe("ARMED");

  // Stop the beat the only way a beat truly stops: the process writing it ceases to exist. No record
  // is manufactured, backdated or hand-written — the real last beat simply stays the last beat.
  await killDaemon(f, child);
  const frozen = statSync(beatPath).mtimeMs;
  expect(readFileSync(beatPath, "utf8")).not.toBe(first); // the frozen record is the ADVANCED one
  expect(state(f.repo, frozen + SUPERVISION_STALE_MS)).toBe("ARMED"); // the ceiling's far edge is inside it
  expect(state(f.repo, frozen + SUPERVISION_STALE_MS + 1)).toBe("STALE");
}, 120_000);

test("a beat whose recorded time is ahead of the reader's clock reads UNREADABLE rather than ARMED, exercised at one beat interval ahead and at six, so clock skew in either magnitude cannot make a dead watcher look alive", async () => {
  // A watcher that IS dead. Every reading below is about hiding that death behind a future stamp.
  const dead = await armedThenDead("run-sup-skew");
  const beatPath = supervisionBeatPath(dead.repo, TIER);
  const now = dead.beatMs; // the reader's clock, pinned so no second clock reading can drift
  expect(state(dead.repo, now)).toBe("ARMED");

  for (const ahead of [SUPERVISION_BEAT_MS, 6 * SUPERVISION_BEAT_MS]) {
    const future = new Date(now + ahead);
    utimesSync(beatPath, future, future);
    expect(state(dead.repo, now), `${ahead}ms ahead of the reader`).toBe("UNREADABLE");
    expect(supervisionStatus(dead.repo, TIER, now).beatAgeMs).toBeUndefined(); // no age was derivable

    // The SAME magnitude BEHIND the reader still derives an age: this is a skew guard, not a blanket
    // refusal to read a record whose stamp differs from the reader's clock.
    const past = new Date(now - ahead);
    utimesSync(beatPath, past, past);
    const behind = supervisionStatus(dead.repo, TIER, now);
    expect(behind.state, `${ahead}ms behind the reader`).not.toBe("UNREADABLE");
    expect(behind.beatAgeMs, `${ahead}ms behind the reader`).toBeGreaterThanOrEqual(ahead - 1);
  }
  // one beat behind is the healthy case and must still read ARMED — the guard is one-sided
  const oneBehind = new Date(now - SUPERVISION_BEAT_MS);
  utimesSync(beatPath, oneBehind, oneBehind);
  expect(state(dead.repo, now)).toBe("ARMED");

  // The whole point: as the reader's clock catches up, the dead watcher shows as dead. The old
  // clamp-to-zero made a future stamp read ARMED forever, no matter how far the clock advanced.
  const far = new Date(now + 6 * SUPERVISION_BEAT_MS);
  utimesSync(beatPath, far, far);
  expect(state(dead.repo, now + 10 * SUPERVISION_STALE_MS)).toBe("STALE");
}, 120_000);

test("a watcher that stands down cleanly is distinguishable from one that died, exercised over a disarm and over a stopped beat, and neither state is reported using the other's value", async () => {
  // Stand-down: a real run the runtime carried to its own end and disarmed on the way out.
  const clean = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
  await runDaemon(clean.repo, { adapters: [clean.fake], runId: "run-sup-standdown" });
  const stoodDown = state(clean.repo);
  expect(stoodDown).toBe("DISARMED");
  expect(existsSync(supervisionStandDownPath(clean.repo, TIER))).toBe(true);
  // and it STAYS a stand-down as the clock runs on. The stood-down seat's last beat ages out exactly
  // like a dead one's, so an age-derived answer would turn a deliberate hand-off into a death report.
  const cleanBeat = statSync(supervisionBeatPath(clean.repo, TIER)).mtimeMs;
  expect(state(clean.repo, cleanBeat + SUPERVISION_STALE_MS + 1)).toBe("DISARMED");
  expect(state(clean.repo, cleanBeat + 10 * SUPERVISION_STALE_MS)).toBe("DISARMED");

  // DISARMED is what a watcher RECORDED, never what merely occupies the path: fault-inject the record
  // the real run wrote and neither shape may be reported as that run's clean hand-off.
  const markerPath = supervisionStandDownPath(clean.repo, TIER);
  const marker = readFileSync(markerPath, "utf8");
  writeFileSync(markerPath, marker.slice(0, 12)); // a torn write is not a stand-down anyone can read
  expect(state(clean.repo)).toBe("UNREADABLE");
  rmSync(markerPath);
  mkdirSync(markerPath); // nor is a directory somebody dropped where the marker goes
  expect(state(clean.repo)).toBe("UNREADABLE");
  rmSync(markerPath, { recursive: true });
  writeFileSync(markerPath, marker); // the run's own record, back as written
  expect(state(clean.repo)).toBe("DISARMED");

  // And a stand-down only outranks the beat it FOLLOWED: a beat stamped after it belongs to a watcher
  // that armed again, so a marker a failed cleanup left behind cannot report a live tier as gone.
  const rearmed = new Date(statSync(markerPath).mtimeMs + SUPERVISION_BEAT_MS);
  utimesSync(supervisionBeatPath(clean.repo, TIER), rearmed, rearmed);
  expect(state(clean.repo, rearmed.getTime())).toBe("ARMED");
  utimesSync(supervisionBeatPath(clean.repo, TIER), new Date(cleanBeat), new Date(cleanBeat)); // as it was
  expect(state(clean.repo)).toBe("DISARMED");

  // Death: a real run of the same shape whose process was killed — a stopped beat, nothing recorded.
  const dead = await armedThenDead("run-sup-death");
  const died = state(dead.repo, dead.beatMs + SUPERVISION_STALE_MS + 1);
  expect(died).toBe("STALE");

  // Neither state is reported using the other's value, and neither collapses into never-armed.
  expect(stoodDown).not.toBe(died);
  expect(stoodDown).not.toBe("STALE");
  expect(stoodDown).not.toBe("ABSENT");
  expect(died).not.toBe("DISARMED");
  expect(died).not.toBe("ABSENT");
}, 120_000);

test("supervisionStatus reports ABSENT before runDaemon starts and ARMED after it starts from the same state directory; stopping the production beat later reports STALE, so a reader hardcoded to ABSENT or an arming change that collapses never-armed state fails", async () => {
  const f = fixture();
  // ONE state directory, read three times as the run's life passes through it. Every reading is kept:
  // the discrimination below is asserted on what was OBSERVED, never on literals.
  const observed: TierLiveness["state"][] = [];
  const stateDir = join(tickmarkrDir(f.repo), "supervision");
  observed.push(state(f.repo));
  expect(observed[0]).toBe("ABSENT");
  expect(existsSync(stateDir)).toBe(false);

  const { child, stderr } = spawnDaemon(f, "run-sup-lifecycle");
  await waitFor(() => existsSync(supervisionBeatPath(f.repo, TIER)), "the run to arm its tier", 90_000, stderr);
  observed.push(state(f.repo));
  expect(observed[1]).toBe("ARMED");
  expect(existsSync(stateDir)).toBe(true); // the SAME directory the ABSENT reading was taken from
  // whose process wrote that beat: the daemon's, not this observer's — the record names its author
  const beaten = JSON.parse(readFileSync(supervisionBeatPath(f.repo, TIER), "utf8")) as { pid: number };
  expect(beaten.pid).toBe(child.pid);
  expect(beaten.pid).not.toBe(process.pid);

  await killDaemon(f, child);
  const frozen = statSync(supervisionBeatPath(f.repo, TIER)).mtimeMs;
  observed.push(state(f.repo, frozen + SUPERVISION_STALE_MS + 1));
  expect(observed[2]).toBe("STALE");
  // three READINGS, three distinct values — a reader hardcoded to any one of them, or an arming change
  // that collapses two of these states together, fails here on the observations themselves.
  expect(new Set(observed).size).toBe(3);
}, 120_000);

test("start runDaemon through its production entry and observe ARMED, then exercise normal completion and an early controlled exit and observe DISARMED in both; call neither arm nor disarm from the test, so a test-only caller or cleanup reachable on one path cannot pass", async () => {
  // Path 1 — normal completion.
  const finished = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
  const duringFinished: string[] = [];
  await runDaemon(finished.repo, {
    adapters: [finished.fake], runId: "run-sup-complete",
    narrate: () => duringFinished.push(state(finished.repo)),
  });
  expect(new Set(duringFinished)).toEqual(new Set(["ARMED"]));
  expect(state(finished.repo)).toBe("DISARMED");

  // Path 2 — an early controlled exit through the daemon's own signal reaper. That reaper EXITS the
  // process, so the run's finally never executes in production: a stand-down written only there would
  // pass this test in-process and leave every real interrupted run reading STALE. The reading is
  // therefore taken INSIDE the injected exit — the last instant the daemon controls.
  const f = fixture();
  let atExit: string | undefined;
  const before = process.listeners("SIGTERM");
  const interrupted = runDaemon(f.repo, {
    adapters: [f.fake], runId: "run-sup-interrupted",
    exit: () => { atExit ??= state(f.repo); },
  });
  interrupted.catch(() => { /* asserted below */ });
  const journalPath = join(tickmarkrDir(f.repo), "runs", "run-sup-interrupted", "journal.jsonl");
  await waitFor(
    () => existsSync(journalPath) && readFileSync(journalPath, "utf8").includes('"event":"worker-launch"'),
    "the interrupted run to reach a live worker",
    90_000,
  );
  expect(state(f.repo)).toBe("ARMED");

  const handler = process.listeners("SIGTERM").find((l) => !before.includes(l)) as ((sig: string) => void) | undefined;
  expect(handler, "the daemon registered its SIGTERM handler").toBeDefined();
  handler!("SIGTERM");
  await expect(interrupted).rejects.toThrow(/terminated by SIGTERM/);
  writeFileSync(f.stop, "stop\n");

  expect(atExit, "the reaper reached the injected exit").toBe("DISARMED");
  expect(state(f.repo)).toBe("DISARMED");
}, 120_000);
