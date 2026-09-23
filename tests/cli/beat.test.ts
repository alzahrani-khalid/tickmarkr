import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { beat, standDownTier } from "../../src/cli/commands/beat.js";
import { dispatch } from "../../src/cli/index.js";
import { status } from "../../src/cli/commands/status.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  readSupervision,
  readTierLiveness,
  supervisionBeatPath,
  supervisionArmPath,
  supervisionStandDownPath,
  supervisionStatus,
  supervisionText,
} from "../../src/run/supervision.js";

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
    expect(await runner.exited, runner.errors()).toBe(0);
    expect(runner.output()).toContain("DISARMED");
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
