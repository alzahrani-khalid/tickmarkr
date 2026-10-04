import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { beat, standDownTier } from "../../src/cli/commands/beat.js";
import { dispatch } from "../../src/cli/index.js";
import { status } from "../../src/cli/commands/status.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  readSupervision,
  readTierLiveness,
  supervisionBeatPath,
  supervisionArmPath,
  supervisionStandDownPath,
  supervisionStatus,
  supervisionText,
  type SupervisionTier,
} from "../../src/run/supervision.js";
import {
  BEAT_GENERATION_ENV, beatClaimPath, beatOwnerPath, defaultBeatDeps, readProcessIdentity,
  type BeatLifecycleDeps, type ProcessIdentity,
} from "../../src/run/beat-lifecycle.js";

// SUP-04: the writer verb. Every assertion below is made through `status`'s rendered line rather than
// through the module's own reader — the defect this task exists to close is that the SURFACE claimed
// three tiers while one writer existed, so a test that read the module back would prove nothing about
// what an operator sees. Real temp repos, real files: the beat is file state, and faking it would fake
// the instrument.

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-beat-"));

const seedRepo = (repo: string) => {
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "a", goal: "a", shape: "implement", complexity: 3, acceptance: ["a"] }],
  }));
  const dir = join(tickmarkrDir(repo), "runs", "run-beat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/journal.jsonl",
    JSON.stringify({ ts: new Date().toISOString(), event: "run-start", data: { pid: process.pid } }) + "\n");
  return repo;
};

const supervisionLine = (out: string) => out.split("\n").find((l) => l.includes("supervision:"))!;

describe("SUP-04 tickmarkr beat", () => {
  test("test: beating the overseer tier makes status render that tier armed, so a supervision row that stays absent while a seat beats fails", async () => {
    const repo = seedRepo(mkRepo());
    // control first: with nothing beating, the row an overseer would occupy reads ABSENT — the exact
    // line the P99 run printed for a whole milestone while a live overseer watched it.
    expect(supervisionLine(await status([], repo))).toContain("overseer ABSENT");

    const out = await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);

    expect(out).toContain("overseer");
    const line = supervisionLine(await status([], repo));
    expect(line).toContain("overseer ARMED");
    expect(line).not.toContain("overseer ABSENT");
    // the verb writes ONE tier: a beat that armed every row would make the surface unfalsifiable
    expect(line).toContain("watch ABSENT");
  });

  test("test: a beat record written by a one-shot beat names its writer under a field whose name states the writer has exited, and liveness derives from beat freshness alone, so two reads seconds apart cannot disagree about a tier that never stopped", async () => {
    const repo = seedRepo(mkRepo());
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);

    const path = supervisionBeatPath(repo, "overseer");
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(record.exitedWriterPid).toBe(process.pid);
    expect(record).not.toHaveProperty("pid");

    const writtenAt = statSync(path).mtimeMs;
    expect(readTierLiveness(repo, "overseer", writtenAt + 1_000).state).toBe("ARMED");
    expect(readTierLiveness(repo, "overseer", writtenAt + 3_000).state).toBe("ARMED");
  });

  test("test: a tier whose newest beat has aged past the staleness ceiling of six beat intervals renders stale, while one aged past a single interval still renders armed, so a renderer that alarms on one missed beat or never leaves absent fails", async () => {
    const repo = seedRepo(mkRepo());
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);

    // BOTH sides of the module's forgiveness window, because each side falsifies a DIFFERENT renderer.
    // One interval past the last beat the seat has missed its cadence and nothing more: a renderer that
    // ALARMS here is the false-positive half — SUPERVISION_STALE_MS is SIX beat intervals (lock.ts's
    // ratio: five may be missed before alarm), and the command's own message names that ceiling rather
    // than the cadence, so no surface promises a flip at one. It may not read ABSENT either: ABSENT is
    // reserved, by construction, for a tier nobody ever armed.
    const missedOne = new Date(Date.now() - SUPERVISION_BEAT_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "overseer"), missedOne, missedOne);
    const early = supervisionLine(await status([], repo));
    expect(early).not.toContain("overseer ABSENT");
    expect(early).toContain("overseer ARMED");

    // Past the ceiling, the seat has stopped for good — the never-leaves-absent half, and the queue's
    // own red control: STALE says armed-then-lost, ABSENT would say nobody was ever watching.
    const stopped = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "overseer"), stopped, stopped);

    const line = supervisionLine(await status([], repo));

    expect(line).toContain("overseer STALE");
    expect(line).not.toContain("overseer ABSENT");
    expect(line).not.toContain("overseer ARMED");
  });

  test("test: beating with the stand-down flag stops the row claiming armed, so a stood-down tier still rendering armed fails", async () => {
    const repo = seedRepo(mkRepo());
    // The normal beat must leave NOTHING beating behind it, or this whole assertion is worthless: a
    // recurring beater surviving the invocation would rewrite the beat ten seconds after the
    // stand-down and flip DISARMED back to ARMED, with the immediate check below none the wiser.
    const scheduled = vi.spyOn(globalThis, "setInterval");
    await beat(["overseer", "--seat", "OVSR-w1:p2"], repo);
    expect(scheduled).not.toHaveBeenCalled();
    scheduled.mockRestore();
    expect(supervisionLine(await status([], repo))).toContain("overseer ARMED");

    await beat(["overseer", "--stand-down", "--seat", "OVSR-w1:p2"], repo);

    const line = supervisionLine(await status([], repo));
    expect(line).not.toContain("overseer ARMED");
    expect(line).toContain("overseer DISARMED"); // a recorded hand-off, not a death ageing out as STALE
    // and it still reads stood down once the beat interval has passed — the same renderer `status`
    // uses, read at a later instant, so nothing here is true only in the millisecond after the call
    const later = supervisionText(readSupervision(repo, Date.now() + 3 * SUPERVISION_BEAT_MS));
    expect(later).toContain("overseer DISARMED");
    expect(later).not.toContain("overseer ARMED");
    // Only explicit arming acknowledges the marker left behind.
    await beat(["overseer", "--seat", "OVSR-w1:p2", "--new-arm"], repo);
    expect(supervisionLine(await status([], repo))).toContain("overseer ARMED");
  });

  test("a beat that cannot be written fails the command instead of announcing a tier it never armed", async () => {
    const repo = seedRepo(mkRepo());
    // Something occupying the beat path is the cheapest instance of the whole write-failure class
    // (permissions, a full disk, a vanished repo): `status` renders UNREADABLE for it. The verb must
    // not disagree with the surface — a swallowed failure would print `overseer ARMED` about state
    // that was never recorded, which is the same fail-open the tier exists to catch, one layer up.
    mkdirSync(supervisionBeatPath(repo, "overseer"), { recursive: true });

    await expect(beat(["overseer", "--seat", "OVSR-w1:p2"], repo)).rejects.toThrow();

    expect(supervisionLine(await status([], repo))).toContain("overseer UNREADABLE");
  });

  test("an unknown tier is refused with the usage line rather than writing a beat nobody reads", async () => {
    const repo = seedRepo(mkRepo());
    await expect(beat(["nonesuch"], repo)).rejects.toThrow(/orchestrator-context/);
    await expect(beat([], repo)).rejects.toThrow(/no tier/);
    expect(supervisionLine(await status([], repo))).toContain("overseer ABSENT");
  });

  test("test: the beat verb refuses a tier carrying no declared seat identity and writes no beat file; a beat that declares one makes status name that seat beside the tier's state; a record holding only the tier its one-shot process id and an instant leaves armed unattributable and fails", async () => {
    const refusedRepo = seedRepo(mkRepo());
    const refusedPath = supervisionBeatPath(refusedRepo, "overseer-context");

    await expect(beat(["overseer-context"], refusedRepo)).rejects.toThrow(/--seat <identity>/);
    expect(existsSync(refusedPath)).toBe(false);
    expect(supervisionLine(await status([], refusedRepo))).toContain("overseer-context ABSENT");

    const named = await beat(["overseer-context", "--seat", "OVSR-w1:p2"], refusedRepo);
    expect(named).toContain("ARMED as OVSR-w1:p2");
    expect(supervisionLine(await status([], refusedRepo)))
      .toContain("overseer-context ARMED (OVSR-w1:p2)");

    // The measured false-positive shape: tier + a one-shot pid + an instant cannot identify a seat.
    // Something does occupy the path, so the reader reports it as unreadable evidence rather than
    // claiming either ARMED coverage or that the tier was never armed.
    const legacyRepo = seedRepo(mkRepo());
    const legacyPath = supervisionBeatPath(legacyRepo, "orchestrator-context");
    mkdirSync(join(tickmarkrDir(legacyRepo), "supervision"), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      tier: "orchestrator-context", pid: 424242, beatAt: new Date().toISOString(),
    }) + "\n");
    const line = supervisionLine(await status([], legacyRepo));
    expect(line).toContain("orchestrator-context UNREADABLE");
    expect(line).not.toContain("orchestrator-context ARMED");
  });

  test("test: a beat issued from a subdirectory of a repository lands in that repository's root supervision file and a beat issued from a directory under no repository exits non-zero naming the missing state dir and creates no supervision tree whereas the shipped beat that writes relative to cwd and prints ARMED fails", async () => {
    const repo = seedRepo(mkRepo());
    const nested = join(repo, "packages", "worker", "src");
    mkdirSync(nested, { recursive: true });

    const armed = await beat(["overseer", "--seat", "OVSR-w1:p2"], nested);
    expect(armed).toContain("overseer ARMED");
    expect(existsSync(supervisionBeatPath(repo, "overseer"))).toBe(true);
    expect(existsSync(join(nested, ".tickmarkr", "supervision"))).toBe(false);

    const outside = mkRepo();
    const outsideChild = join(outside, "some", "directory");
    mkdirSync(outsideChild, { recursive: true });
    const refused = await dispatch("beat", ["overseer", "--seat", "OVSR-w1:p2"], {
      beat: (argv) => beat(argv, outsideChild),
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/missing \.tickmarkr\/ state dir/);
    expect(existsSync(join(outside, ".tickmarkr"))).toBe(false);
    expect(existsSync(join(outsideChild, ".tickmarkr", "supervision"))).toBe(false);
  });
});

// Real processes exercise the wrapper failure: a new Node process does not imply a new arm.
function beatChild(repo: string, args: string[], prelude = "") {
  const url = pathToFileURL(join(import.meta.dirname, "../../src/cli/commands/beat.ts")).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    ${prelude}
    const { beat } = await import(${JSON.stringify(url)});
    console.log(await beat(${JSON.stringify(args)}, ${JSON.stringify(repo)}));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    child, exited, output: () => out, errors: () => err,
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; },
  };
}
const awaitDisk = async (predicate: () => boolean, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for beat process");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test("test: beat with loop creates a durable arm identity then beats the tier until a stand-down marker newer than that arm appears whereupon it exits within one interval, so a loop that clears the marker to re-arm fails", async () => {
  const repo = seedRepo(mkRepo());
  const runner = beatChild(repo, ["overseer", "--seat", "loop-seat", "--loop"]);
  try {
    const path = supervisionBeatPath(repo, "overseer");
    await awaitDisk(() => existsSync(path));
    const first = JSON.parse(readFileSync(path, "utf8"));
    const armBytes = readFileSync(supervisionArmPath(repo, "overseer"), "utf8");
    const arm = JSON.parse(armBytes);
    expect(arm.armId).toBeTruthy();
    expect(Number.isFinite(Date.parse(arm.armEpoch))).toBe(true);
    expect(first).toMatchObject({ ...arm, pid: runner.child.pid });
    expect(first).not.toHaveProperty("exitedWriterPid");
    await awaitDisk(() => JSON.parse(readFileSync(path, "utf8")).beatAt !== first.beatAt, SUPERVISION_BEAT_MS + 2_000);
    expect(readFileSync(supervisionArmPath(repo, "overseer"), "utf8")).toBe(armBytes);
    standDownTier(repo, "overseer", "loop-seat");
    const marker = readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8");
    const stoppedAt = Date.now();
    await awaitDisk(() => runner.child.exitCode !== null, SUPERVISION_BEAT_MS + 1_000);
    expect(Date.now() - stoppedAt).toBeLessThanOrEqual(SUPERVISION_BEAT_MS + 500);
    // a stood-down loop ends NONZERO with its reason: a refusal never reads as a quiet, healthy exit
    expect(await runner.exited).not.toBe(0);
    expect(runner.errors()).toContain("DISARMED — stood down");
    expect(readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8")).toBe(marker);
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
  } finally { await runner.close(); }
}, 30_000);

test("test: a fresh one shot process ticking an arm created before stand down preserves the marker and reports DISARMED even when that process starts later while only an explicit new arm can resume beating, so using process start time to let a surviving wrapper rearm fails", async () => {
  const repo = seedRepo(mkRepo());
  await beat(["overseer", "--seat", "seat", "--new-arm", "--arm-id", "old-arm"], repo);
  const original = readFileSync(supervisionArmPath(repo, "overseer"), "utf8");
  standDownTier(repo, "overseer", "seat");
  const marker = readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8");
  const fresh = beatChild(repo, ["overseer", "--seat", "seat"]);
  try {
    await awaitDisk(() => fresh.child.exitCode !== null);
    // a refused tick exits NON-ZERO: the shipped watcher gates on the exit code with stdout discarded
    expect(await fresh.exited).not.toBe(0);
    expect(fresh.errors()).toContain("DISARMED");
    expect(readFileSync(supervisionArmPath(repo, "overseer"), "utf8")).toBe(original);
    expect(readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8")).toBe(marker);
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
    await beat(["overseer", "--seat", "seat", "--new-arm"], repo);
    expect(supervisionStatus(repo, "overseer").state).toBe("ARMED");
    expect(readFileSync(supervisionArmPath(repo, "overseer"), "utf8")).not.toBe(original);
    expect(readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8")).toBe(marker);
    standDownTier(repo, "overseer", "seat");
    await expect(beat(["overseer", "--seat", "seat"], repo)).rejects.toThrow(/DISARMED/);
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
  } finally { await fresh.close(); }
});

test("test: a beat racing a concurrently published stand-down leaves the tier reading DISARMED because marker and beat writes are fenced so stand-down dominates, so a liveness reader that lets the racing beat outrank the marker fails", async () => {
  const repo = seedRepo(mkRepo());
  await beat(["overseer", "--seat", "seat"], repo);
  const ready = join(repo, "ready");
  const release = join(repo, "release");
  // Pause the actual writer just before its atomic beat publication, then publish stand-down
  // from this process. The delayed rename must land AFTER the marker and remain disarmed.
  const racer = beatChild(repo, ["overseer", "--seat", "seat"], `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("overseer.beat")) {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
  `);
  try {
    await awaitDisk(() => existsSync(ready));
    standDownTier(repo, "overseer", "seat");
    const marker = readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8");
    writeFileSync(release, "release");
    await awaitDisk(() => racer.child.exitCode !== null);
    expect(await racer.exited).not.toBe(0);
    expect(racer.errors()).toContain("DISARMED");
    expect(readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8")).toBe(marker);
    // Even a beat timestamp strictly newer than the marker cannot override the arm fence.
    const later = new Date(statSync(supervisionStandDownPath(repo, "overseer")).mtimeMs + 100);
    utimesSync(supervisionBeatPath(repo, "overseer"), later, later);
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
  } finally { await racer.close(); }
});

test("test: an untagged legacy one shot beat on a tier with no arm identity arms it as today while the same beat after a stand-down reports stood down, so a legacy tick that re-arms over a marker fails", async () => {
  const repo = seedRepo(mkRepo());
  const args = ["overseer", "--seat", "legacy-seat"];
  expect(existsSync(supervisionArmPath(repo, "overseer"))).toBe(false);
  expect(await beat(args, repo)).toContain("ARMED as legacy-seat");
  expect(supervisionStatus(repo, "overseer").state).toBe("ARMED");
  const bytes = readFileSync(supervisionBeatPath(repo, "overseer"), "utf8");
  standDownTier(repo, "overseer", "legacy-seat");
  await expect(beat(args, repo)).rejects.toThrow(/stood down/);
  expect(readFileSync(supervisionBeatPath(repo, "overseer"), "utf8")).toBe(bytes);
  expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
  const neverArmed = seedRepo(mkRepo());
  standDownTier(neverArmed, "overseer", "legacy-seat");
  await expect(beat(args, neverArmed)).rejects.toThrow(/stood down/);
  expect(existsSync(supervisionArmPath(neverArmed, "overseer"))).toBe(false);
});

test("a stand-down published while a new arm is being stamped dominates that arm's first tick", async () => {
  const repo = seedRepo(mkRepo());
  await beat(["overseer", "--seat", "seat"], repo);
  const ready = join(repo, "stamping-arm");
  const release = join(repo, "release-arm");
  const racer = beatChild(repo, ["overseer", "--seat", "seat", "--new-arm"], `
    import fs from "node:fs";
    const now = Date.now;
    Date.now = () => {
      const instant = now();
      if (new Error().stack?.includes("newSupervisionArm")) {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return instant;
    };
  `);
  try {
    await awaitDisk(() => existsSync(ready));
    standDownTier(repo, "overseer", "seat");
    const marker = readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8");
    writeFileSync(release, "release");
    await awaitDisk(() => racer.child.exitCode !== null);
    expect(await racer.exited).not.toBe(0);
    expect(racer.errors()).toContain("DISARMED");
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
    expect(readFileSync(supervisionStandDownPath(repo, "overseer"), "utf8")).toBe(marker);
    // A later one-shot process cannot acknowledge the marker missed by the racing arm.
    await expect(beat(["overseer", "--seat", "seat"], repo)).rejects.toThrow(/DISARMED/);
    expect(await beat(["overseer", "--seat", "seat", "--new-arm"], repo)).toContain("ARMED as seat");
  } finally { await racer.close(); }
});

test("a refused one-shot tick exits non-zero through dispatch, and --arm-id without --pct never refuses a tick on a tier with no marker", async () => {
  const repo = seedRepo(mkRepo());
  expect(await beat(["overseer-context", "--seat", "S"], repo)).toContain("ARMED as S");
  // an arm-id mismatch is not a stand-down: nothing recorded one, so the verb may not print one
  expect(await beat(["overseer-context", "--seat", "S", "--arm-id", "mine"], repo)).toContain("ARMED as S");
  expect(supervisionStatus(repo, "overseer-context").state).toBe("ARMED");
  expect(existsSync(supervisionStandDownPath(repo, "overseer-context"))).toBe(false);
  standDownTier(repo, "overseer-context", "S");
  const refused = await dispatch("beat", ["overseer-context", "--seat", "S"], { beat: (argv) => beat(argv, repo) });
  expect(refused.code).toBe(1);
  expect(refused.out).toMatch(/stood down/);
});

test("context observations still raise and discharge the clear duty on a stood-down tier", async () => {
  const repo = seedRepo(mkRepo());
  standDownTier(repo, "overseer-context", "A");
  // the raise side must not fail open after a stand-down
  await expect(beat(["overseer-context", "--seat", "A", "--arm-id", "A", "--pct", "82", "--threshold-pct", "75"], repo))
    .rejects.toThrow(/stood down/);
  expect(supervisionStatus(repo, "overseer-context")).toMatchObject({ state: "DISARMED", clearOwedSince: expect.any(String) });
  // the canonical hand-off: a DIFFERENT arm observed below threshold discharges it, even while refused
  await expect(beat(["overseer-context", "--seat", "B", "--arm-id", "B", "--pct", "9"], repo)).rejects.toThrow(/stood down/);
  expect(supervisionStatus(repo, "overseer-context")).not.toHaveProperty("clearOwedSince");
  expect(supervisionStatus(repo, "overseer-context").state).toBe("DISARMED");
});

// ---- H + D-1001: the lifecycle verbs and the strict parser, through the real dispatch bridge ----

const LIFECYCLE_CLI = [process.execPath, "--import", pathToFileURL(join(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs")).href, join(import.meta.dirname, "../../src/cli/index.ts")];
const lifecycleChildren: ChildProcess[] = [];
afterEach(() => {
  for (const child of lifecycleChildren.splice(0)) { try { process.kill(child.pid!, "SIGKILL"); } catch { /* gone */ } }
});
const lifecycleDeps = (): BeatLifecycleDeps => {
  const env = { ...process.env };
  delete env[BEAT_GENERATION_ENV];
  return {
    ...defaultBeatDeps(), cli: LIFECYCLE_CLI, env,
    spawn: (command, args, options) => { const child = spawn(command, args, options); lifecycleChildren.push(child); return child; },
  };
};
const lifecycleRepo = (state = true) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-beat-verbs-")));
  mkdirSync(join(repo, ".git"));
  if (state) tickmarkrDir(repo);
  return repo;
};
const runBeat = (repo: string, argv: string[]) => dispatch("beat", argv, { beat: (a) => beat(a, repo, lifecycleDeps()) });

/** Every path under `root` with its bytes and mtime — the read-only fence's evidence. */
function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const rel of ["", ...readdirSync(root, { recursive: true, encoding: "utf8" })]) {
    const path = join(root, rel);
    const st = statSync(path);
    out[rel] = `${st.mtimeMs}:${st.isFile() ? readFileSync(path, "base64") : "dir"}`;
  }
  return out;
}

/** The durable arm a bound owner record names: without it on disk the record proves no ownership. */
function ownedArm(repo: string, tier: SupervisionTier, armId: string): string {
  const armEpoch = new Date().toISOString();
  mkdirSync(join(repo, ".tickmarkr", "supervision"), { recursive: true });
  writeFileSync(supervisionArmPath(repo, tier), JSON.stringify({ armId, armEpoch, markerFence: "NONE" }) + "\n");
  return armEpoch;
}

/** A real owned process that never beats, recorded as the tier's owner. */
async function recordOwner(repo: string, tier: SupervisionTier, seat: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "gen-fixture"], { cwd: repo, detached: true, stdio: "ignore" });
  lifecycleChildren.push(child);
  await awaitDisk(() => typeof readProcessIdentity(child.pid!) === "object");
  const id = readProcessIdentity(child.pid!) as ProcessIdentity;
  mkdirSync(join(repo, ".tickmarkr", "supervision"), { recursive: true });
  writeFileSync(beatOwnerPath(repo, tier), JSON.stringify({
    tier, seat, generation: "gen-fixture", armId: "gen-fixture", cwd: repo, startedAt: new Date().toISOString(), armEpoch: ownedArm(repo, tier, "gen-fixture"),
    pid: child.pid, birth: id.birth, command: id.command, pgid: id.pgid,
  }) + "\n");
  return child;
}

test("test: production beat dispatch accepts start stop status and legacy forms across SUPERVISION_TIERS while unknown duplicate conflicting or empty options refuse before mutation and legacy status returns the same read-only result", async () => {
  const repo = lifecycleRepo();
  for (const tier of SUPERVISION_TIERS) {
    const before = snapshot(repo);
    for (const argv of [
      ["start", tier, "--seat", "s", "--bogus"], ["status", tier, "--unknown=1"], [tier, "--seat", "s", "-x"],
      ["start", tier, "--seat", "a", "--seat", "b"], [tier, "--seat", "s", "--loop", "--loop"], ["status", tier, "--seat=a", "--seat", "a"],
      ["start", tier, "--seat", "s", "--loop"], ["stop", tier, "--seat", "s", "--stand-down"], ["status", tier, "--status"],
      [tier, "--status", "--new-arm"], [tier, "--seat", "s", "--stand-down", "--loop"], [tier, "--seat", "s", "--stand-down", "--pct", "5"],
      ["start", tier, "--seat="], ["stop", tier, "--seat", ""], [tier, "--seat", "  "], [tier, "--seat", "s", "--arm-id", ""],
      [tier, "--seat", "s", "--pct="], [tier, "--seat"], ["start", tier, "extra", "--seat", "s"], ["start"], ["start", tier], ["stop", tier],
    ]) {
      const refused = await runBeat(repo, argv);
      expect(refused.code, argv.join(" ")).toBe(1);
      expect(refused.out, argv.join(" ")).toMatch(/^tickmarkr beat: /);
    }
    expect(snapshot(repo), `${tier} refusals mutated state`).toEqual(before);

    // status and its legacy spelling: one read-only result, identical bytes, nothing written.
    const absent = await runBeat(repo, ["status", tier]);
    expect(absent).toEqual({ code: 0, out: `${tier} ABSENT — no beat recorded` });
    expect(await runBeat(repo, [tier, "--status"])).toEqual(absent);
    expect(snapshot(repo)).toEqual(before);

    // The lifecycle verbs.
    const started = await runBeat(repo, ["start", tier, "--seat", "seat"]);
    expect(started.code, started.out).toBe(0);
    const armed = await runBeat(repo, ["status", tier, "--seat", "seat"]);
    expect(armed).toMatchObject({ code: 0, out: expect.stringContaining(`${tier} ARMED (seat) — detached pid`) });
    expect(await runBeat(repo, [tier, "--status", "--seat", "seat"])).toEqual(armed);
    expect(await runBeat(repo, ["stop", tier, "--seat", "seat"])).toMatchObject({ code: 0, out: expect.stringContaining(`${tier} DISARMED`) });

    // The legacy forms keep working.
    expect(await runBeat(repo, [tier, "--seat", "seat", "--new-arm"])).toMatchObject({ code: 0, out: expect.stringContaining(`${tier} ARMED as seat`) });
    expect(await runBeat(repo, [tier, "--seat=seat"])).toMatchObject({ code: 0, out: expect.stringContaining(`${tier} ARMED as seat`) });
    expect(await runBeat(repo, [tier, "--seat", "seat", "--stand-down"])).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED") });
    const disarmed = await runBeat(repo, [tier, "--status"]);
    expect(disarmed).toEqual({ code: 0, out: `${tier} DISARMED (seat)` });
    expect(await runBeat(repo, ["status", tier])).toEqual(disarmed);
  }
}, 120_000);

test("test: production beat status and legacy status preserve byte and mtime snapshots over the closed state table including a completely absent state directory while reporting recorded liveness rather than creating a healthy beat", async () => {
  const check = async (repo: string, tier: SupervisionTier, seat: string | undefined, code: number, out: RegExp) => {
    const before = snapshot(repo);
    const withSeat = seat ? ["--seat", seat] : [];
    const verb = await runBeat(repo, ["status", tier, ...withSeat]);
    const legacy = await runBeat(repo, [tier, "--status", ...withSeat]);
    expect(snapshot(repo), `${tier} status wrote`).toEqual(before);
    expect(legacy).toEqual(verb);
    expect(verb.code, verb.out).toBe(code);
    expect(verb.out).toMatch(out);
    return verb.out;
  };

  // A completely absent state directory in a valid repository: ABSENT, and still no tree afterwards.
  const absentTree = lifecycleRepo(false);
  await check(absentTree, "overseer", "s", 0, /^overseer ABSENT — no state directory$/);
  expect(existsSync(join(absentTree, ".tickmarkr"))).toBe(false);
  // A nonrepository: refused without mutation.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-beat-none-")));
  await check(outside, "overseer", undefined, 1, /no tickmarkr repository found/);
  expect(existsSync(join(outside, ".tickmarkr"))).toBe(false);

  // EMPTY: ABSENT and no beat appears — status never beats on a watcher's behalf.
  const repo = lifecycleRepo();
  await check(repo, "orchestrator", "s", 0, /^orchestrator ABSENT — no beat recorded$/);
  expect(existsSync(supervisionBeatPath(repo, "orchestrator"))).toBe(false);
  // BUSY: the checked state, read without taking or touching the claim.
  mkdirSync(join(repo, ".tickmarkr", "supervision"), { recursive: true });
  writeFileSync(beatClaimPath(repo, "orchestrator"), JSON.stringify({ token: "t", pid: 4242 }) + "\n");
  await check(repo, "orchestrator", "s", 0, /^orchestrator ABSENT — no beat recorded · BUSY \(claim held by pid 4242\)$/);
  rmSync(beatClaimPath(repo, "orchestrator"));
  // DISARMED.
  standDownTier(repo, "orchestrator", "s");
  await check(repo, "orchestrator", "s", 0, /^orchestrator DISARMED \(s\)$/);

  // OWN-LIVE advancing: a real detached child, held still while the fence is read.
  const live = lifecycleRepo();
  expect((await runBeat(live, ["start", "overseer", "--seat", "s"])).code).toBe(0);
  const owner = JSON.parse(readFileSync(beatOwnerPath(live, "overseer"), "utf8")) as { pid: number };
  lifecycleChildren.push({ pid: owner.pid } as ChildProcess);
  process.kill(owner.pid, "SIGSTOP");
  try {
    await check(live, "overseer", "s", 0, new RegExp(`^overseer ARMED \\(s\\) — detached pid ${owner.pid}`));
    // An intruder beat reusing the child's arm id — a one-shot record of another seat with no live pid — is
    // not the recorded child advancing: STALE, nonzero, never ARMED for the owner.
    const ownBeat = readFileSync(supervisionBeatPath(live, "overseer"), "utf8");
    const { pid: _pid, ...rest } = JSON.parse(ownBeat) as Record<string, unknown>;
    writeFileSync(supervisionBeatPath(live, "overseer"), JSON.stringify({ ...rest, seat: "intruder", exitedWriterPid: 4242, beatAt: new Date().toISOString() }) + "\n");
    await check(live, "overseer", "s", 1, /^overseer STALE \(s\) — detached pid \d+ is alive but its beat is not advancing$/);
    writeFileSync(supervisionBeatPath(live, "overseer"), ownBeat);
    // A torn durable arm under a live owner is UNREADABLE, never ARMED.
    const armBytes = readFileSync(supervisionArmPath(live, "overseer"), "utf8");
    writeFileSync(supervisionArmPath(live, "overseer"), "{torn");
    await check(live, "overseer", "s", 1, /^overseer UNREADABLE — durable arm .*overseer\.arm is unreadable$/);
    writeFileSync(supervisionArmPath(live, "overseer"), armBytes);
  } finally { process.kill(owner.pid, "SIGCONT"); }
  // FOREIGN by seat: a:b is not a_b.
  await check(live, "overseer", "a_b", 1, /^overseer MISMATCH — owned by seat s, not a_b$/);
  // OWN-DEAD: the beat file is still fresh, but the recorded process is gone — STALE, never ARMED.
  process.kill(owner.pid, "SIGKILL");
  await awaitDisk(() => readProcessIdentity(owner.pid) === "DEAD");
  expect(supervisionStatus(live, "overseer").state).toBe("ARMED");
  await check(live, "overseer", "s", 1, new RegExp(`^overseer STALE \\(s\\) — recorded pid ${owner.pid} is gone`));

  // OWN-LIVE silent: alive, owned, not beating.
  const silent = lifecycleRepo();
  await recordOwner(silent, "watch", "s");
  await check(silent, "watch", "s", 1, /^watch STALE \(s\) — detached pid \d+ is alive but its beat is not advancing$/);
  // FOREIGN: an unowned legacy writer holds the tier.
  const legacy = lifecycleRepo();
  await beat(["overseer-context", "--seat", "w"], legacy);
  await check(legacy, "overseer-context", undefined, 1, /^overseer-context MISMATCH — ARMED by an unowned writer \(seat w\)$/);
  // PID-REUSED.
  const reused = lifecycleRepo();
  mkdirSync(join(reused, ".tickmarkr", "supervision"), { recursive: true });
  writeFileSync(beatOwnerPath(reused, "orchestrator-context"), JSON.stringify({
    tier: "orchestrator-context", seat: "s", generation: "g", armId: "g", cwd: reused, startedAt: new Date().toISOString(), armEpoch: ownedArm(reused, "orchestrator-context", "g"),
    pid: process.pid, birth: "Thu Jan  1 00:00:00 1970", command: "gone", pgid: process.pid,
  }) + "\n");
  await check(reused, "orchestrator-context", "s", 1, /^orchestrator-context MISMATCH — recorded pid \d+ now belongs to another process$/);
  // OWN-DEAD over a torn stand-down marker: UNREADABLE, the derived state is never bypassed.
  const tornMarker = lifecycleRepo();
  const tornChild = await recordOwner(tornMarker, "watch", "s");
  tornChild.kill("SIGKILL");
  await awaitDisk(() => readProcessIdentity(tornChild.pid!) === "DEAD");
  writeFileSync(supervisionStandDownPath(tornMarker, "watch"), "{torn");
  await check(tornMarker, "watch", "s", 1, /^watch UNREADABLE — the tier's supervision records are unreadable$/);
  // A malformed beat behind a VALID stand-down marker and a dead owner: UNREADABLE, never STALE or DISARMED.
  const masked = lifecycleRepo();
  const maskedChild = await recordOwner(masked, "overseer", "s");
  maskedChild.kill("SIGKILL");
  await awaitDisk(() => readProcessIdentity(maskedChild.pid!) === "DEAD");
  standDownTier(masked, "overseer", "s");
  writeFileSync(supervisionBeatPath(masked, "overseer"), "{}\n");
  await check(masked, "overseer", "s", 1, /^overseer UNREADABLE — beat record .*overseer\.beat is malformed$/);
  // The same arm id under a newer epoch is not the recorded generation: MISMATCH, never ARMED.
  const epoch = lifecycleRepo();
  expect((await runBeat(epoch, ["start", "watch", "--seat", "s"])).code).toBe(0);
  const epochArm = JSON.parse(readFileSync(supervisionArmPath(epoch, "watch"), "utf8")) as Record<string, string>;
  writeFileSync(supervisionArmPath(epoch, "watch"), JSON.stringify({ ...epochArm, armEpoch: new Date(Date.parse(epochArm.armEpoch) + 1).toISOString() }) + "\n");
  await check(epoch, "watch", "s", 1, /^watch MISMATCH — durable arm \S+ \(epoch .*\) is not generation/);
  // UNKNOWN: a malformed owner record, and an unreadable beat path.
  writeFileSync(beatOwnerPath(reused, "orchestrator-context"), "{torn");
  await check(reused, "orchestrator-context", "s", 1, /^orchestrator-context UNREADABLE — malformed owner record/);
  mkdirSync(supervisionBeatPath(reused, "orchestrator"), { recursive: true });
  await check(reused, "orchestrator", undefined, 1, /^orchestrator UNREADABLE — the tier's supervision records are unreadable$/);
}, 120_000);

// ---- OOB M2: every legacy writer authorizes through the COMPLETE owned generation (token + armId + armEpoch) ----

test("a generation-carrying legacy tick, new arm and stand-down refuse a replaced arm epoch or a rebound owner epoch before any write, while one unchanged generation ticks, re-arms, ticks again, reads ARMED and stands down on the same repo", async () => {
  const tier = "overseer" as const;
  const generation = "gen-legacy";
  const deps = () => ({ ...lifecycleDeps(), env: { ...process.env, [BEAT_GENERATION_ENV]: generation } });
  const run = (repo: string, argv: string[]) => dispatch("beat", [tier, "--seat", "s", ...argv], { beat: (a) => beat(a, repo, deps()) });
  const later = (epoch: string) => new Date(Date.parse(epoch) + 1_000).toISOString();
  /** A bound generation this process owns: owner, its durable arm, its last loop beat, and its launch claim. */
  const owned = () => {
    const repo = lifecycleRepo();
    const armEpoch = ownedArm(repo, tier, generation);
    writeFileSync(beatOwnerPath(repo, tier), JSON.stringify({
      tier, seat: "s", generation, armId: generation, armEpoch, cwd: repo, startedAt: armEpoch,
      pid: process.pid, birth: "birth", command: "command", pgid: process.pid,
    }) + "\n");
    writeFileSync(supervisionBeatPath(repo, tier), JSON.stringify({
      tier, seat: "s", armId: generation, armEpoch, markerFence: "NONE", pid: process.pid, beatAt: armEpoch,
    }) + "\n");
    writeFileSync(beatClaimPath(repo, tier), JSON.stringify({ token: generation, pid: process.pid }) + "\n");
    return { repo, armEpoch };
  };
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;

  for (const form of [[], ["--new-arm"], ["--stand-down"]]) {
    const label = form[0] ?? "tick";
    // A same-id durable arm under another epoch is a replacement generation: refused, named, nothing mutated.
    const replaced = owned();
    writeFileSync(supervisionArmPath(replaced.repo, tier), JSON.stringify({ armId: generation, armEpoch: later(replaced.armEpoch), markerFence: "NONE" }) + "\n");
    const beforeArm = snapshot(replaced.repo);
    const armRefusal = await run(replaced.repo, form);
    expect(armRefusal.code, `${label}: ${armRefusal.out}`).toBe(1);
    expect(armRefusal.out, label).toMatch(/^tickmarkr beat: overseer durable arm gen-legacy \(epoch .*\) replaced generation gen-legacy's arm — left in place$/);
    expect(snapshot(replaced.repo), `${label} mutated a replacement arm's state`).toEqual(beforeArm);

    // An owner whose BOUND arm epoch changed (token, seat and pid kept) is another generation too.
    const rebound = owned();
    writeFileSync(beatOwnerPath(rebound.repo, tier), JSON.stringify({ ...json(beatOwnerPath(rebound.repo, tier)), armEpoch: later(rebound.armEpoch) }) + "\n");
    const beforeOwner = snapshot(rebound.repo);
    const ownerRefusal = await run(rebound.repo, form);
    expect(ownerRefusal.code, `${label}: ${ownerRefusal.out}`).toBe(1);
    expect(ownerRefusal.out, label).toMatch(/^tickmarkr beat: overseer durable arm gen-legacy \(epoch .*\) replaced generation gen-legacy's arm — left in place$/);
    expect(snapshot(rebound.repo), `${label} mutated a rebound owner's state`).toEqual(beforeOwner);
  }

  // Control, on ONE repo and one generation: an owned re-arm is an ownership transition, so the same generation
  // keeps every legacy duty AFTER it — the owner record is rebound to the new arm, never left naming the old one.
  const control = owned();
  const { repo } = control;
  const identity = () => ({ birth: "birth", command: "command", cwd: repo, pgid: process.pid });
  const status = () => dispatch("beat", ["status", tier, "--seat", "s"], { beat: (a) => beat(a, repo, { ...deps(), identity }) });
  const owner0 = json(beatOwnerPath(repo, tier));
  const beat0 = readFileSync(supervisionBeatPath(repo, tier), "utf8");
  expect(await run(repo, [])).toMatchObject({ code: 0, out: expect.stringContaining("overseer ARMED as s") });
  const beat1 = readFileSync(supervisionBeatPath(repo, tier), "utf8");
  expect(beat1).not.toBe(beat0);
  expect(json(supervisionArmPath(repo, tier))).toMatchObject({ armId: generation, armEpoch: control.armEpoch });
  expect(await run(repo, ["--new-arm"])).toMatchObject({ code: 0, out: expect.stringContaining("overseer ARMED as s") });
  const rearmed = json(supervisionArmPath(repo, tier));
  expect(rearmed.armEpoch).not.toBe(control.armEpoch);
  expect(json(supervisionBeatPath(repo, tier))).toMatchObject({ armId: rearmed.armId, armEpoch: rearmed.armEpoch });
  // same token, seat and process; only the bound arm moved
  expect(json(beatOwnerPath(repo, tier))).toEqual({ ...owner0, armId: rearmed.armId, armEpoch: rearmed.armEpoch });
  const beat2 = readFileSync(supervisionBeatPath(repo, tier), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5)); // beatAt has millisecond resolution
  const next = await run(repo, []);
  expect(next, next.out).toMatchObject({ code: 0, out: expect.stringContaining("overseer ARMED as s") });
  expect(readFileSync(supervisionBeatPath(repo, tier), "utf8")).not.toBe(beat2);
  expect(json(supervisionBeatPath(repo, tier))).toMatchObject({ armId: rearmed.armId, armEpoch: rearmed.armEpoch });
  expect(supervisionStatus(repo, tier).state).toBe("ARMED");
  // The checked status owns the re-armed generation too (never MISMATCH); a one-shot beat is just not a loop advancing.
  expect((await status()).out).toMatch(/^overseer STALE \(s\) — detached pid \d+ is alive but its beat is not advancing · BUSY/);
  // A loop re-arm by the same generation (held at its first sleep) beats as the owner's own process: checked ARMED.
  const looped = await dispatch("beat", [tier, "--seat", "s", "--loop"], {
    beat: (a) => beat(a, repo, { ...deps(), sleep: () => Promise.reject(new Error("loop held after its first beat")) }),
  });
  expect(looped.out).toMatch(/loop held after its first beat$/);
  const loopArm = json(supervisionArmPath(repo, tier));
  expect(loopArm.armEpoch).not.toBe(rearmed.armEpoch);
  expect(json(beatOwnerPath(repo, tier))).toEqual({ ...owner0, armId: loopArm.armId, armEpoch: loopArm.armEpoch });
  expect(await status()).toMatchObject({ code: 0, out: expect.stringMatching(/^overseer ARMED \(s\) — detached pid \d+, generation gen-legacy/) });
  const down = await run(repo, ["--stand-down"]);
  expect(down, down.out).toMatchObject({ code: 0, out: expect.stringContaining("overseer DISARMED") });
  expect(supervisionStatus(repo, tier).state).toBe("DISARMED");

  // An owner rebound by ANOTHER writer between this writer's arm creation and its beat: the re-armed generation
  // is checked again as the new generation, so the beat is refused, named, and the other writer's owner stays.
  const raced = owned();
  const racedBeat = readFileSync(supervisionBeatPath(raced.repo, tier), "utf8");
  let foreign: string | undefined;
  const racing = await dispatch("beat", [tier, "--seat", "s", "--new-arm"], {
    beat: (a) => beat(a, raced.repo, {
      ...deps(),
      now: () => {
        if (foreign === undefined && json(supervisionArmPath(raced.repo, tier)).armEpoch !== raced.armEpoch) {
          const mine = json(beatOwnerPath(raced.repo, tier));
          foreign = JSON.stringify({ ...mine, armEpoch: later(mine.armEpoch) }) + "\n";
          writeFileSync(beatOwnerPath(raced.repo, tier), foreign);
        }
        return Date.now();
      },
    }),
  });
  expect(foreign, "the race never ran: the new generation was not re-checked before its beat").toBeDefined();
  expect(racing.code, racing.out).toBe(1);
  expect(racing.out).toMatch(/^tickmarkr beat: overseer superseded — the owner record binds arm \S+ \(epoch .*\), not this writer's arm \S+ \(epoch .*\); nothing written$/);
  expect(readFileSync(supervisionBeatPath(raced.repo, tier), "utf8")).toBe(racedBeat);
  expect(readFileSync(beatOwnerPath(raced.repo, tier), "utf8")).toBe(foreign);
});

// ---- OOB M2 repair 2: ONE rule — the held generation changes only by the writer's own re-arm or its launcher's binding ----

const GEN = "gen-legacy";
const readRecord = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
const laterEpoch = (epoch: string) => new Date(Date.parse(epoch) + 1_000).toISOString();
const generationDeps = (over: Partial<BeatLifecycleDeps> = {}): BeatLifecycleDeps =>
  ({ ...lifecycleDeps(), env: { ...process.env, [BEAT_GENERATION_ENV]: GEN }, ...over });
/** A generation this process owns under its launch claim; `bound` adds the pid, the arm epoch, the arm and a loop beat. */
function generationFixture(tier: SupervisionTier, bound = true) {
  const repo = lifecycleRepo();
  const startedAt = new Date().toISOString();
  const armEpoch = bound ? ownedArm(repo, tier, GEN) : undefined;
  mkdirSync(join(repo, ".tickmarkr", "supervision"), { recursive: true });
  writeFileSync(beatOwnerPath(repo, tier), JSON.stringify({
    tier, seat: "s", generation: GEN, armId: GEN, cwd: repo, startedAt,
    ...(bound ? { armEpoch, pid: process.pid, birth: "birth", command: "command", pgid: process.pid } : {}),
  }) + "\n");
  if (bound) writeFileSync(supervisionBeatPath(repo, tier), JSON.stringify({ tier, seat: "s", armId: GEN, armEpoch, markerFence: "NONE", pid: process.pid, beatAt: armEpoch }) + "\n");
  writeFileSync(beatClaimPath(repo, tier), JSON.stringify({ token: GEN, pid: process.pid }) + "\n");
  return { repo, armEpoch: armEpoch ?? "" };
}

test("a generation-carrying legacy tick, new arm and stand-down refuse when BOTH the owner's bound arm epoch and the durable arm epoch are replaced during a check, leaving every record's bytes and mtime unchanged", async () => {
  const tier = "overseer" as const;
  for (const form of [[], ["--new-arm"], ["--stand-down"]]) {
    // the replacement lands inside the claim's first check, or inside the recheck immediately before the write
    for (const at of [1, 2]) {
      const { repo, armEpoch } = generationFixture(tier);
      let calls = 0;
      let replaced: Record<string, string> | undefined;
      const refusal = await dispatch("beat", [tier, "--seat", "s", ...form], {
        beat: (a) => beat(a, repo, generationDeps({
          now: () => {
            if (++calls === at) {
              // token, seat and pid kept; the two records agree with each other — only not with the generation held
              writeFileSync(beatOwnerPath(repo, tier), JSON.stringify({ ...readRecord(beatOwnerPath(repo, tier)), armEpoch: laterEpoch(armEpoch) }) + "\n");
              writeFileSync(supervisionArmPath(repo, tier), JSON.stringify({ armId: GEN, armEpoch: laterEpoch(armEpoch), markerFence: "NONE" }) + "\n");
              replaced = snapshot(repo);
            }
            return Date.now();
          },
        })),
      });
      const label = `${form[0] ?? "tick"} (check ${at})`;
      expect(replaced, `${label}: the replacement never ran`).toBeDefined();
      expect(refusal.code, `${label}: ${refusal.out}`).toBe(1);
      expect(refusal.out, label).toBe("tickmarkr beat: overseer superseded — the owner record changed under generation gen-legacy while it was checked; nothing written");
      expect(snapshot(repo), `${label} wrote after adopting a replacement`).toEqual(replaced);
    }
  }
});

test("a generation-carrying new arm whose durable arm is replaced right after its own arm publication refuses before the owner rebind, leaving the owner record, the beat and the replacement arm untouched", async () => {
  const tier = "overseer" as const;
  const { repo, armEpoch } = generationFixture(tier);
  const ownerBefore = snapshot(repo)[join(".tickmarkr", "supervision", "overseer.owner")];
  const beatBefore = readFileSync(supervisionBeatPath(repo, tier), "utf8");
  let replacement: string | undefined;
  const refusal = await dispatch("beat", [tier, "--seat", "s", "--new-arm"], {
    beat: (a) => beat(a, repo, generationDeps({
      now: () => {
        const created = readRecord(supervisionArmPath(repo, tier));
        if (replacement === undefined && created.armEpoch !== armEpoch) {
          replacement = JSON.stringify({ ...created, armEpoch: laterEpoch(created.armEpoch) }) + "\n";
          writeFileSync(supervisionArmPath(repo, tier), replacement);
        }
        return Date.now();
      },
    })),
  });
  expect(replacement, "the replacement never ran: the created arm was not re-read before the owner rebind").toBeDefined();
  expect(refusal.code, refusal.out).toBe(1);
  expect(refusal.out).toMatch(/^tickmarkr beat: overseer superseded — durable arm \S+ \(epoch .*\) replaced the arm \S+ \(epoch .*\) generation gen-legacy just created; owner left in place$/);
  expect(ownerBefore).toBeDefined();
  expect(snapshot(repo)[join(".tickmarkr", "supervision", "overseer.owner")]).toBe(ownerBefore);
  expect(readFileSync(supervisionBeatPath(repo, tier), "utf8")).toBe(beatBefore);
  expect(readFileSync(supervisionArmPath(repo, tier), "utf8")).toBe(replacement);
});

test("a launching loop accepts its launcher publishing its pid and binding its own arm epoch during a check and keeps beating, while an unbound owner bound to any other epoch is refused with no further beat", async () => {
  const tier = "overseer" as const;
  for (const own of [true, false]) {
    const { repo } = generationFixture(tier, false);
    const ownerPath = beatOwnerPath(repo, tier);
    let step: "publish" | "idle" | "bind" | "done" = "publish";
    let firstBeat = "";
    let boundOwner = "";
    const out = await dispatch("beat", [tier, "--seat", "s", "--loop", "--arm-id", GEN], {
      beat: (a) => beat(a, repo, generationDeps({
        now: () => {
          if (step === "publish") {
            // the launcher's first publication lands inside the child's first check, before any arm exists
            step = "idle";
            writeFileSync(ownerPath, JSON.stringify({ ...readRecord(ownerPath), pid: process.pid, birth: "birth", command: "command", pgid: process.pid }) + "\n");
          } else if (step === "bind") {
            // its second lands inside the next tick's check: the epoch of the child's own arm — or another one
            step = "done";
            const epoch = readRecord(supervisionArmPath(repo, tier)).armEpoch;
            boundOwner = JSON.stringify({ ...readRecord(ownerPath), armEpoch: own ? epoch : laterEpoch(epoch) }) + "\n";
            writeFileSync(ownerPath, boundOwner);
          }
          return Date.now();
        },
        sleep: async () => {
          if (step === "done") throw new Error("loop held after its second beat");
          firstBeat = readFileSync(supervisionBeatPath(repo, tier), "utf8");
          await new Promise((resolve) => setTimeout(resolve, 5)); // beatAt has millisecond resolution
          step = "bind";
        },
      })),
    });
    expect(step, out.out).toBe("done");
    expect(readRecord(supervisionBeatPath(repo, tier))).toMatchObject({ armId: GEN, pid: process.pid });
    expect(readFileSync(ownerPath, "utf8")).toBe(boundOwner);
    if (own) {
      expect(out.out).toMatch(/loop held after its second beat$/);
      expect(readFileSync(supervisionBeatPath(repo, tier), "utf8")).not.toBe(firstBeat);
      expect(supervisionStatus(repo, tier).state).toBe("ARMED");
    } else {
      expect(out.code, out.out).toBe(1);
      expect(out.out).toMatch(/^tickmarkr beat: overseer superseded — the owner record binds arm gen-legacy \(epoch .*\), not this writer's arm gen-legacy \(epoch .*\); nothing written$/);
      expect(readFileSync(supervisionBeatPath(repo, tier), "utf8")).toBe(firstBeat);
    }
  }
});
