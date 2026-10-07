import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { beat } from "../../src/cli/commands/beat.js";
import { dispatch } from "../../src/cli/index.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import {
  BEAT_GENERATION_ENV, beatClaimPath, beatLogPath, beatOwnerPath, defaultBeatDeps, readProcessIdentity,
  type BeatLifecycleDeps, type BeatOwner, type ProcessIdentity,
} from "../../src/run/beat-lifecycle.js";
import {
  SUPERVISION_BEAT_MS, SUPERVISION_TIERS, publishStandDown, supervisionArmPath, supervisionBeatPath, supervisionStandDownPath, supervisionStatus,
  type SupervisionTier,
} from "../../src/run/supervision.js";

// Every row below crosses the REAL bridge — dispatch -> registered beat -> beat-lifecycle — with real
// owned temporary processes. Failures are injected at the production boundaries (spawn, kill, identity,
// log open, clock) or by occupying the real paths; nothing reaches into the lifecycle's private helpers.

// D-1150 closed repair table (production dispatch -> beat -> lifecycle; all SUPERVISION_TIERS):
// Consumer / operation                         | Identity-read interleaving              | Required outcome
// status / legacy --status / repeat-start      | beat {} / wrong types; torn arm/marker  | UNREADABLE, retained
// status / repeat-start                        | new stand-down; silent/foreign beat    | STALE, never ARMED/no-op
// start: proof, arm binding, polling, final    | owner token/seat/pid/birth/cwd changes   | refuse, retain replacement
// start: first beat before epoch publication   | same-id arm epoch replaced              | child's beat fences the expected epoch
// start: final / rollback: probe, proof, wait  | arm id/epoch changes, alone or + owner  | refuse, no later signal/marker/delete
// start: final                                | stand-down, stale/absent/non-child beat | refuse; exact owned rollback only
// rollback: before disarm / owner removal      | absent/torn arm or malformed beat       | refuse, retain uncertain state
// stop: inspect / pre-disarm / pre-signal      | same complete generation replacements  | refuse, no later mutation
// stop: wait / confirmed-dead cleanup / delete | replacement or malformed records        | refuse, retain; no replacement cleanup
// cleanup / DISARMED read-back                 | mutation or failed publication/removal | refuse unless checked read-back agrees
// legacy tick/new-arm/EVERY loop/stand-down    | foreign claim / foreign seat            | existing serialized refusal, no write
// legacy tick/new-arm/EVERY loop/stand-down    | owner arm epoch / durable arm replaced  | refuse before any write, retain replacement
// EMPTY/DISARMED/OWN-LIVE/OWN-DEAD/FOREIGN/PID-REUSED/UNKNOWN/BUSY, missing tree and invalid input
// retain their existing closed outcomes below. Every owned barrier compares one EXPECTED owner snapshot
// and its complete arm, then validates current beat/marker/arm records AFTER identity inspection.

const ROOT = join(import.meta.dirname, "../..");
// The loader `node --import tsx` resolves to, absolute so children in temp repos find it.
const TSX = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const CLI = [process.execPath, "--import", TSX, join(ROOT, "src/cli/index.ts")];
const RECEIPT = join(ROOT, "tests/fixtures/beat-lifecycle/darwin-detach.receipt.json");

const spawned: ChildProcess[] = [];
const foreign: number[] = [];
afterEach(() => {
  for (const pid of [...spawned.map((c) => c.pid), ...foreign.splice(0)]) {
    try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  spawned.splice(0);
});

const mkRepo = (state = true) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-beat-life-")));
  mkdirSync(join(repo, ".git"));
  if (state) tickmarkrDir(repo);
  return repo;
};

const deps = (over: Partial<BeatLifecycleDeps> = {}): BeatLifecycleDeps => {
  const base = defaultBeatDeps();
  const env = { ...process.env };
  delete env[BEAT_GENERATION_ENV];
  return {
    ...base, cli: CLI, env,
    spawn: (command, args, options) => { const child = spawn(command, args, options); spawned.push(child); return child; },
    ...over,
  };
};

const run = (repo: string, argv: string[], d: BeatLifecycleDeps = deps()) =>
  dispatch("beat", argv, { beat: (a) => beat(a, repo, d) });

const owner = (repo: string, tier: SupervisionTier) =>
  JSON.parse(readFileSync(beatOwnerPath(repo, tier), "utf8")) as { pid: number; generation: string; seat: string; pgid: number };
const beatRecord = (repo: string, tier: SupervisionTier) =>
  JSON.parse(readFileSync(supervisionBeatPath(repo, tier), "utf8")) as { armId?: string; pid?: number; beatAt: string };
const alive = (pid: number) => readProcessIdentity(pid) !== "DEAD";
const bytes = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
const until = async (predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The durable arm a bound owner record names: without it on disk the record proves no ownership. */
function ownedArm(repo: string, tier: SupervisionTier, armId: string): string {
  const armEpoch = new Date().toISOString();
  mkdirSync(join(repo, ".tickmarkr", "supervision"), { recursive: true });
  writeFileSync(supervisionArmPath(repo, tier), JSON.stringify({ armId, armEpoch, markerFence: "NONE" }) + "\n");
  return armEpoch;
}

/** A real process this test owns that never beats, recorded as the tier's owner (or as a foreign one). */
async function recordedProcess(repo: string, tier: SupervisionTier, seat: string, generation = "gen-fixture") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", generation], { cwd: repo, detached: true, stdio: "ignore" });
  spawned.push(child);
  await until(() => typeof readProcessIdentity(child.pid!) === "object");
  const id = readProcessIdentity(child.pid!) as ProcessIdentity;
  put(beatOwnerPath(repo, tier), JSON.stringify({
    tier, seat, generation, armId: generation, cwd: repo, startedAt: new Date().toISOString(), armEpoch: ownedArm(repo, tier, generation),
    pid: child.pid, birth: id.birth, command: id.command, pgid: id.pgid,
  }) + "\n");
  return child;
}

/** Write a record into the (possibly not yet created) supervision directory. */
const put = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };

const killAndReap = async (child: ChildProcess) => {
  child.kill("SIGKILL");
  await until(() => child.exitCode !== null || child.signalCode !== null);
};

/** Real CLI children and records; inject the identity boundary without requiring a permitted host ps. */
function boundaryRig() {
  const children = new Map<number, { child: ChildProcess; identity: ProcessIdentity }>();
  const kills: Array<[number, string]> = [];
  let onIdentity: (pid: number) => void = () => {};
  let onKill: (pid: number) => void = () => {};
  const d = deps({
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      spawned.push(child);
      if (child.pid) children.set(child.pid, {
        child, identity: { birth: `checked-birth-${child.pid}`, command: [command, ...args].join(" "), cwd: String(options.cwd), pgid: child.pid },
      });
      return child;
    },
    identity: (pid) => {
      onIdentity(pid);
      const entry = children.get(pid);
      if (!entry) return "UNKNOWN";
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return "DEAD";
      try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "DEAD" : "UNKNOWN"; }
      return entry.identity;
    },
    kill: (pid, signal) => { kills.push([pid, signal]); process.kill(pid, signal); onKill(pid); },
  });
  return {
    d, kills, children,
    identityHook: (hook: (pid: number) => void) => { onIdentity = hook; },
    killHook: (hook: (pid: number) => void) => { onKill = hook; },
    close: async () => {
      for (const { child } of children.values()) {
        if (child.exitCode === null && child.signalCode === null) await killAndReap(child);
      }
    },
  };
}

function recordSnapshot(repo: string, tier: SupervisionTier) {
  return Object.fromEntries([
    beatOwnerPath(repo, tier), supervisionArmPath(repo, tier), supervisionBeatPath(repo, tier), supervisionStandDownPath(repo, tier),
  ].map((path) => [path, existsSync(path) ? { bytes: bytes(path), mtime: statSync(path).mtimeMs } : undefined]));
}

/** Replace BOTH durable records under the SAME owner token and arm id, the rollback defect's exact shape. */
function replaceEpoch(repo: string, tier: SupervisionTier, replaceOwner = true) {
  const arm = JSON.parse(readFileSync(supervisionArmPath(repo, tier), "utf8")) as Record<string, string>;
  const armEpoch = new Date(Date.parse(arm.armEpoch) + 1).toISOString();
  put(supervisionArmPath(repo, tier), JSON.stringify({ ...arm, armEpoch }) + "\n");
  if (replaceOwner) {
    const current = JSON.parse(readFileSync(beatOwnerPath(repo, tier), "utf8")) as BeatOwner;
    put(beatOwnerPath(repo, tier), JSON.stringify({ ...current, armEpoch }) + "\n");
  }
}

/** Launch binds its checked child's epoch before the final identity barrier, even if a beat arrives mid-inspection. */
function boundChild(repo: string, tier: SupervisionTier, pid: number): boolean {
  const current = JSON.parse(readFileSync(beatOwnerPath(repo, tier), "utf8")) as BeatOwner;
  return current.pid === pid && current.armEpoch !== undefined;
}

function onFinalIdentity(rig: ReturnType<typeof boundaryRig>, repo: string, tier: SupervisionTier, act: () => void) {
  let fired = false;
  rig.identityHook((pid) => {
    if (!fired && boundChild(repo, tier, pid)) { fired = true; act(); }
  });
  return () => fired;
}

test("production dispatch confirms child death after an unreadable startup identity without reporting a changed process or signalling it", async () => {
  const rig = boundaryRig();
  const repo = mkRepo();
  const gate = join(repo, "exit-child");
  let unreadableExit = false;
  const d: BeatLifecycleDeps = {
    ...rig.d,
    spawn: (_command, args, options) => rig.d.spawn(process.execPath, [
      "-e", `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(3); }, 10);`,
      "--", ...args,
    ], options),
    identity: (pid) => {
      const id = rig.d.identity(pid);
      if (!unreadableExit && typeof id === "object" && owner(repo, "overseer").pid === pid) {
        // The child's identity was proven and published. It now exits while the next inspection
        // cannot read cwd; that UNKNOWN must be followed by checked death, never PID reuse.
        unreadableExit = true;
        writeFileSync(gate, "exit\n");
        return "UNKNOWN";
      }
      return id;
    },
  };
  try {
    const result = await run(repo, ["start", "overseer", "--seat", "s"], d);
    expect(unreadableExit).toBe(true);
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining("died before its beat read back") });
    expect(result.out).toContain("rolled back this generation only");
    expect(result.out).not.toContain("changed identity");
    expect(rig.kills).toEqual([]);
    expect([...rig.children.values()][0]!.child.exitCode).toBe(3);
    expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(false);
    expect(existsSync(beatClaimPath(repo, "overseer"))).toBe(false);
    expect(supervisionStatus(repo, "overseer").state).toBe("ABSENT");
  } finally { await rig.close(); }
});

test("production dispatch refuses a final-read epoch replacement or startup overrun when the first beat arrives during identity inspection", async () => {
  for (const change of ["epoch", "overrun"] as const) {
    const rig = boundaryRig();
    const repo = mkRepo();
    const gate = join(repo, "release-child");
    let resumed = false, skew = 0;
    let replaced: ReturnType<typeof recordSnapshot> | undefined;
    const fired = onFinalIdentity(rig, repo, "overseer", () => {
      if (change === "epoch") { replaceEpoch(repo, "overseer", false); replaced = recordSnapshot(repo, "overseer"); }
      else skew = 60_001;
    });
    const d: BeatLifecycleDeps = {
      ...rig.d,
      spawn: (command, args, options) => rig.d.spawn(command, [
        ...args.slice(0, 2), "--input-type=module", "--eval",
        `import { existsSync } from "node:fs"; while (!existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 10)); await import(process.argv[1]);`,
        ...args.slice(2),
      ], options),
      identity: (pid: number) => {
        const id = rig.d.identity(pid);
        // The first polling identity read starts with no beat. Let the real child publish it
        // before that inspection returns, just as a blocking ps/cwd inspection can do.
        if (!resumed && owner(repo, "overseer").pid === pid) {
          expect(existsSync(supervisionBeatPath(repo, "overseer"))).toBe(false);
          resumed = true;
          writeFileSync(gate, "resume\n");
          const deadline = Date.now() + 15_000;
          while (!existsSync(supervisionBeatPath(repo, "overseer"))) {
            if (Date.now() >= deadline) throw new Error("child did not publish its first beat during identity inspection");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return id;
      },
      now: () => Date.now() + skew,
    };
    try {
      const result = await run(repo, ["start", "overseer", "--seat", "s"], d);
      expect(result.code, result.out).toBe(1);
      expect(resumed).toBe(true);
      expect(fired(), change).toBe(true);
      if (change === "epoch") {
        expect(result.out).toMatch(/durable arm \S+ \(epoch .*\) replaced generation/);
        expect(result.out).toContain("not signalled");
        expect(rig.kills).toEqual([]);
        expect(recordSnapshot(repo, "overseer")).toEqual(replaced);
      } else {
        expect(result.out).toContain("startup overran 60000 ms");
        expect(result.out).toContain("rolled back this generation only");
        expect(rig.kills.map(([, signal]) => signal)).toEqual(["SIGTERM"]);
        expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(false);
        expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
      }
    } finally { await rig.close(); }
  }
}, 120_000);

test("production dispatch revalidates every tier's owner beat arm and marker after identity inspection for status legacy status repeat-start and stop", async () => {
  const rig = boundaryRig();
  try {
    for (const tier of SUPERVISION_TIERS) {
      const repo = mkRepo();
      rig.identityHook(() => {});
      expect(await run(repo, ["start", tier, "--seat", "s"], rig.d)).toMatchObject({ code: 0 });
      const child = owner(repo, tier);
      process.kill(child.pid, "SIGSTOP");
      const original = recordSnapshot(repo, tier);
      const originalOwner = JSON.parse(readFileSync(beatOwnerPath(repo, tier), "utf8")) as BeatOwner;
      for (const argv of [["status", tier], [tier, "--status"], ["start", tier], ["stop", tier]]) {
        for (const [path, bad] of [
          [supervisionBeatPath(repo, tier), "{}\n"],
          [supervisionBeatPath(repo, tier), JSON.stringify({ tier, seat: 7, beatAt: "never", pid: "wrong" }) + "\n"],
          [supervisionArmPath(repo, tier), "{}\n"],
          [supervisionArmPath(repo, tier), JSON.stringify({ armId: child.generation, armEpoch: 7, markerFence: "NONE" }) + "\n"],
          [supervisionStandDownPath(repo, tier), "{torn"],
          [beatOwnerPath(repo, tier), JSON.stringify({ ...originalOwner, startedAt: "never" }) + "\n"],
          [beatOwnerPath(repo, tier), JSON.stringify({ ...originalOwner, pgid: -1 }) + "\n"],
        ]) {
          let injected: ReturnType<typeof recordSnapshot> | undefined;
          rig.identityHook(() => {
            if (injected) return;
            put(path, bad);
            injected = recordSnapshot(repo, tier);
          });
          const result = await run(repo, [...argv, "--seat", "s"], rig.d);
          expect(injected, argv.join(" ")).toBeDefined();
          expect(result, `${argv.join(" ")}: ${path}`).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE") });
          expect(recordSnapshot(repo, tier)).toEqual(injected);
          for (const [savedPath, saved] of Object.entries(original)) {
            if (saved) put(savedPath, saved.bytes!); else rmSync(savedPath, { force: true });
          }
        }
      }
      // A valid marker introduced during either spelling of status or a repeat start is STALE, not ARMED.
      for (const argv of [["status", tier], [tier, "--status"], ["start", tier]]) {
        let injected: ReturnType<typeof recordSnapshot> | undefined;
        rig.identityHook(() => {
          if (injected) return;
          publishStandDown(repo, tier, "s");
          injected = recordSnapshot(repo, tier);
        });
        expect(await run(repo, [...argv, "--seat", "s"], rig.d)).toMatchObject({ code: 1, out: expect.stringContaining("STALE") });
        expect(recordSnapshot(repo, tier)).toEqual(injected);
        rmSync(supervisionStandDownPath(repo, tier));
      }
      expect(rig.kills).toEqual([]);
    }
  } finally { await rig.close(); }
}, 120_000);

test("production dispatch carries the expected complete generation through final launch inspection and every rollback identity boundary", async () => {
  // Before the owner has bound its epoch, a swapped current arm must not supply that epoch. The exact
  // child's beat still names the original epoch; capture that evidence and retain the replacement.
  for (const both of [false, true]) {
    const rig = boundaryRig();
    const repo = mkRepo();
    let replaced: ReturnType<typeof recordSnapshot> | undefined;
    rig.identityHook((pid) => {
      if (replaced || !existsSync(supervisionBeatPath(repo, "overseer"))) return;
      const current = JSON.parse(readFileSync(beatOwnerPath(repo, "overseer"), "utf8")) as BeatOwner;
      if (current.armEpoch !== undefined || beatRecord(repo, "overseer").pid !== pid) return;
      replaceEpoch(repo, "overseer", both);
      replaced = recordSnapshot(repo, "overseer");
    });
    try {
      expect(await run(repo, ["start", "overseer", "--seat", "s"], rig.d)).toMatchObject({ code: 1 });
      expect(replaced).toBeDefined();
      expect(rig.kills).toEqual([]);
      expect(recordSnapshot(repo, "overseer")).toEqual(replaced);
      expect(existsSync(supervisionStandDownPath(repo, "overseer"))).toBe(false);
    } finally { await rig.close(); }
  }

  for (const change of ["arm", "owner-and-arm", "beat-empty", "beat-types", "stand-down", "pre-launch-beat"] as const) {
    const rig = boundaryRig();
    const repo = mkRepo();
    let replaced: ReturnType<typeof recordSnapshot> | undefined;
    const fired = onFinalIdentity(rig, repo, "overseer", () => {
      if (change === "arm" || change === "owner-and-arm") replaceEpoch(repo, "overseer", change === "owner-and-arm");
      else if (change === "stand-down") publishStandDown(repo, "overseer", "s");
      else if (change === "pre-launch-beat") {
        const current = JSON.parse(readFileSync(beatOwnerPath(repo, "overseer"), "utf8")) as BeatOwner;
        const rec = JSON.parse(readFileSync(supervisionBeatPath(repo, "overseer"), "utf8"));
        put(supervisionBeatPath(repo, "overseer"), JSON.stringify({ ...rec, beatAt: new Date(Date.parse(current.startedAt) - 1).toISOString() }) + "\n");
      } else put(supervisionBeatPath(repo, "overseer"), change === "beat-empty" ? "{}\n" : JSON.stringify({ tier: "overseer", seat: 7, beatAt: "never", pid: "wrong" }) + "\n");
      replaced = recordSnapshot(repo, "overseer");
    });
    try {
      const result = await run(repo, ["start", "overseer", "--seat", "s"], rig.d);
      expect(fired(), change).toBe(true);
      expect(result, change).toMatchObject({ code: 1 });
      expect(result.out).not.toMatch(/^overseer ARMED/);
      if (change === "stand-down" || change === "pre-launch-beat") {
        expect(result.out).toContain("beat is not advancing at final read-back");
        expect(result.out).toContain("rolled back this generation only");
        expect(rig.kills).toHaveLength(1);
        expect(await run(repo, ["status", "overseer"], rig.d)).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED") });
      } else {
        expect(rig.kills, change).toEqual([]);
        expect(recordSnapshot(repo, "overseer"), change).toEqual(replaced);
        expect(existsSync(supervisionStandDownPath(repo, "overseer"))).toBe(false);
      }
    } finally { await rig.close(); }
  }

  // A stand-down forces owned rollback; the next identity reads are its liveness probe, signal proof,
  // and wait. Swapping both epochs at ANY of them must stop every later signal, marker and deletion.
  for (const boundary of [1, 2, 3]) {
    const rig = boundaryRig();
    const repo = mkRepo();
    let rollbackReads = 0, replaced: ReturnType<typeof recordSnapshot> | undefined;
    const fired = onFinalIdentity(rig, repo, "overseer", () => {
      publishStandDown(repo, "overseer", "s");
      rig.identityHook(() => {
        if (++rollbackReads !== boundary) return;
        replaceEpoch(repo, "overseer");
        replaced = recordSnapshot(repo, "overseer");
      });
    });
    try {
      const result = await run(repo, ["start", "overseer", "--seat", "s"], rig.d);
      expect(fired()).toBe(true);
      expect(replaced, String(boundary)).toBeDefined();
      expect(result).toMatchObject({ code: 1, out: expect.stringContaining("owner record no longer names this generation") });
      expect(rig.kills.map(([, signal]) => signal)).toEqual(boundary === 3 ? ["SIGTERM"] : []);
      expect(recordSnapshot(repo, "overseer")).toEqual(replaced);
    } finally { await rig.close(); }
  }
}, 120_000);

test("production dispatch refuses complete generation replacements during status repeat-start stop and retirement waits", async () => {
  const rig = boundaryRig();
  try {
    const repo = mkRepo();
    expect(await run(repo, ["start", "overseer", "--seat", "s"], rig.d)).toMatchObject({ code: 0 });
    process.kill(owner(repo, "overseer").pid, "SIGSTOP");
    const original = recordSnapshot(repo, "overseer");
    for (const argv of [["status", "overseer"], ["overseer", "--status"], ["start", "overseer"], ["stop", "overseer"]]) {
      for (const both of [false, true]) {
        for (const boundary of argv[0] === "stop" ? [1, 2, 3] : [1]) {
          let reads = 0, replaced: ReturnType<typeof recordSnapshot> | undefined;
          rig.identityHook(() => {
            if (++reads !== boundary) return;
            replaceEpoch(repo, "overseer", both);
            replaced = recordSnapshot(repo, "overseer");
          });
          expect(await run(repo, [...argv, "--seat", "s"], rig.d)).toMatchObject({ code: 1 });
          expect(replaced).toBeDefined();
          expect(recordSnapshot(repo, "overseer")).toEqual(replaced);
          expect(rig.kills).toEqual([]);
          for (const [path, saved] of Object.entries(original)) {
            if (saved) put(path, saved.bytes!); else rmSync(path, { force: true });
          }
        }
      }
    }
    // Retirement already sent its owned SIGTERM; replacement while checking exit cannot be cleaned up.
    const pid = owner(repo, "overseer").pid;
    process.kill(pid, "SIGCONT");
    rig.identityHook(() => {});
    let replaced: ReturnType<typeof recordSnapshot> | undefined;
    rig.killHook(() => { replaceEpoch(repo, "overseer"); replaced = recordSnapshot(repo, "overseer"); });
    expect(await run(repo, ["stop", "overseer", "--seat", "s"], rig.d)).toMatchObject({ code: 1 });
    expect(rig.kills).toEqual([[pid, "SIGTERM"]]);
    expect(recordSnapshot(repo, "overseer")).toEqual(replaced);
  } finally { await rig.close(); }
}, 120_000);

test("test: stop and start rollback wait through a Linux argv teardown ([comm] beside the same birth, group and cwd) after their own SIGTERM, while a different birth after the signal still refuses with the owner retained", async () => {
  // Stop: the first two identity reads after our SIGTERM are the teardown form (twin: a different birth).
  for (const flip of ["teardown", "birth"] as const) {
    const rig = boundaryRig();
    try {
      const repo = mkRepo();
      expect(await run(repo, ["start", "overseer", "--seat", "s"], rig.d)).toMatchObject({ code: 0 });
      const pid = owner(repo, "overseer").pid;
      const recorded = rig.children.get(pid)!.identity;
      let altered = 0;
      const d: BeatLifecycleDeps = {
        ...rig.d,
        identity: (p) => {
          if (p !== pid || rig.kills.length === 0 || altered === 2) return rig.d.identity(p);
          altered++;
          return flip === "teardown" ? { ...recorded, command: "[node]" } : { ...recorded, birth: `${recorded.birth}-reused` };
        },
      };
      const stopped = await run(repo, ["stop", "overseer", "--seat", "s"], d);
      expect(rig.kills).toEqual([[pid, "SIGTERM"]]);
      if (flip === "teardown") {
        expect(altered).toBe(2);
        expect(stopped).toMatchObject({ code: 0, out: expect.stringContaining(`retired detached pid ${pid}`) });
        expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(false);
        expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
      } else {
        expect(stopped).toMatchObject({ code: 1, out: expect.stringContaining("changed identity while stopping; owner record retained") });
        expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(true);
      }
    } finally { await rig.close(); }
  }

  // Start rollback: an overrun start retires its own child; the first two reads after that SIGTERM are the teardown form.
  const overrun = mkRepo();
  let launchedAt: number | undefined, lastSeen: ProcessIdentity | undefined, altered = 0;
  const kills: Array<[number, string]> = [];
  const late = deps({
    now: () => {
      launchedAt ??= Date.now();
      return launchedAt + (existsSync(supervisionBeatPath(overrun, "overseer")) ? 60_001 : 0);
    },
    identity: (pid) => {
      if (kills.length > 0 && lastSeen && altered < 2) { altered++; return { ...lastSeen, command: "[node]" }; }
      const id = readProcessIdentity(pid);
      if (typeof id === "object") lastSeen = id;
      return id;
    },
    kill: (pid, signal) => { kills.push([pid, signal]); process.kill(pid, signal); },
  });
  const overran = await run(overrun, ["start", "overseer", "--seat", "s"], late);
  expect(altered).toBe(2);
  expect(overran).toMatchObject({ code: 1, out: expect.stringContaining("startup overran 60000 ms") });
  expect(overran.out).toMatch(/rolled back/);
  expect(overran.out).not.toContain("not proven");
  const child = spawned.at(-1)!;
  await until(() => child.exitCode !== null || child.signalCode !== null);
  expect(kills).toEqual([[child.pid, "SIGTERM"]]);
  expect(existsSync(beatOwnerPath(overrun, "overseer"))).toBe(false);
}, 120_000);

describe("beat start", () => {
  test("test: production beat start reports the closed start outcome table versus a falsely successful launch", async () => {
    // Invalid input / nonrepository: refused before any mutation.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-beat-none-")));
    expect((await run(outside, ["start", "overseer", "--seat", "s"])).code).toBe(1);
    expect(existsSync(join(outside, ".tickmarkr"))).toBe(false);
    // Missing state directory in a valid repository: refused, nothing created.
    const bare = mkRepo(false);
    const noState = await run(bare, ["start", "overseer", "--seat", "s"]);
    expect(noState).toMatchObject({ code: 1, out: expect.stringMatching(/missing \.tickmarkr\/ state dir/) });
    expect(existsSync(join(bare, ".tickmarkr"))).toBe(false);

    // EMPTY -> launch and read back this exact child's own advancing beat in its own session.
    const repo = mkRepo();
    const started = await run(repo, ["start", "overseer", "--seat", "a:b"]);
    expect(started.code, started.out).toBe(0);
    expect(started.out).toContain("overseer ARMED as a:b");
    const first = owner(repo, "overseer");
    expect(first.seat).toBe("a:b");
    expect(first.pgid).toBe(first.pid);
    expect(beatRecord(repo, "overseer")).toMatchObject({ armId: first.generation, pid: first.pid });
    expect(supervisionStatus(repo, "overseer").state).toBe("ARMED");
    expect(existsSync(beatClaimPath(repo, "overseer"))).toBe(false);
    expect(existsSync(beatLogPath(repo, "overseer"))).toBe(true);

    // OWN-LIVE advancing -> checked no-op: still one child, same generation.
    const again = await run(repo, ["start", "overseer", "--seat", "a:b"]);
    expect(again).toMatchObject({ code: 0, out: expect.stringContaining("already running") });
    expect(owner(repo, "overseer")).toEqual(first);
    // An intruder beat reusing the arm id (a one-shot record, another seat, no live pid) is not this child
    // advancing: start refuses STALE instead of reporting a checked no-op.
    process.kill(first.pid, "SIGSTOP");
    try {
      const own = readFileSync(supervisionBeatPath(repo, "overseer"), "utf8");
      const { pid: _pid, ...rest } = JSON.parse(own) as Record<string, unknown>;
      put(supervisionBeatPath(repo, "overseer"), JSON.stringify({ ...rest, seat: "intruder", exitedWriterPid: 4242, beatAt: new Date().toISOString() }) + "\n");
      expect(await run(repo, ["start", "overseer", "--seat", "a:b"])).toMatchObject({ code: 1, out: expect.stringContaining("STALE") });
      expect(owner(repo, "overseer")).toEqual(first);
      put(supervisionBeatPath(repo, "overseer"), own);
    } finally { process.kill(first.pid, "SIGCONT"); }
    // Seat a_b is a distinct identity from a:b: FOREIGN, refused, nothing changed.
    const otherSeat = await run(repo, ["start", "overseer", "--seat", "a_b"]);
    expect(otherSeat).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH — owned by seat a:b, not a_b") });
    expect(owner(repo, "overseer")).toEqual(first);

    // BUSY: a held claim is never taken over.
    put(beatClaimPath(repo, "overseer"), JSON.stringify({ token: "held", pid: 1 }) + "\n");
    const busy = await run(repo, ["start", "overseer", "--seat", "a:b"]);
    expect(busy).toMatchObject({ code: 1, out: expect.stringContaining("BUSY") });
    expect(bytes(beatClaimPath(repo, "overseer"))).toContain("held");
    rmSync(beatClaimPath(repo, "overseer"));

    // OWN-DEAD -> the same seat's start retires the dead generation (nothing signalled) and launches a new one.
    process.kill(first.pid, "SIGKILL");
    await until(() => !alive(first.pid));
    const dead = await run(repo, ["start", "overseer", "--seat", "a:b"]);
    expect(dead).toMatchObject({ code: 0, out: expect.stringContaining(`overseer recovered dead generation ${first.generation} (recorded pid ${first.pid} is gone)`) });
    expect(dead.out).toContain("ARMED as a:b");
    const second = owner(repo, "overseer");
    spawned.push({ pid: second.pid } as ChildProcess);
    expect(second.generation).not.toBe(first.generation);
    // old-seat stale record / new seat: refusal, then checked old-owner cleanup, then new-owner read-back
    process.kill(second.pid, "SIGKILL");
    await until(() => !alive(second.pid));
    expect((await run(repo, ["start", "overseer", "--seat", "new"])).code).toBe(1);
    expect((await run(repo, ["stop", "overseer", "--seat", "a:b"])).code).toBe(0);
    // DISARMED -> launch/read-back for the new seat.
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
    const relaunched = await run(repo, ["start", "overseer", "--seat", "new"]);
    expect(relaunched.code, relaunched.out).toBe(0);
    expect(owner(repo, "overseer").seat).toBe("new");

    // OWN-LIVE silent: an owned process that is alive but never beats is refused, not "already running".
    const silentRepo = mkRepo();
    const silent = await recordedProcess(silentRepo, "orchestrator", "s");
    const stale = await run(silentRepo, ["start", "orchestrator", "--seat", "s"]);
    expect(stale).toMatchObject({ code: 1, out: expect.stringContaining("STALE") });
    expect(alive(silent.pid!)).toBe(true);
    // PID-REUSED: the recorded pid now belongs to another process (this one) — refused, never signalled.
    const reused = mkRepo();
    put(beatOwnerPath(reused, "watch"), JSON.stringify({
      tier: "watch", seat: "s", generation: "g", armId: "g", cwd: reused, startedAt: new Date().toISOString(), armEpoch: ownedArm(reused, "watch", "g"),
      pid: process.pid, birth: "Thu Jan  1 00:00:00 1970", command: "gone", pgid: process.pid,
    }) + "\n");
    expect(await run(reused, ["start", "watch", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH") });
    // UNKNOWN / malformed owner record: refused, bytes retained.
    const malformed = mkRepo();
    mkdirSync(join(malformed, ".tickmarkr", "supervision"), { recursive: true });
    put(beatOwnerPath(malformed, "overseer-context"), "{torn");
    expect(await run(malformed, ["start", "overseer-context", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE") });
    expect(bytes(beatOwnerPath(malformed, "overseer-context"))).toBe("{torn");
    // FOREIGN: an unowned legacy writer holds the tier — no automatic theft.
    const legacy = mkRepo();
    expect((await run(legacy, ["orchestrator-context", "--seat", "w"])).code).toBe(0);
    expect(await run(legacy, ["start", "orchestrator-context", "--seat", "w"])).toMatchObject({ code: 1, out: expect.stringContaining("unowned writer") });
    expect(existsSync(beatOwnerPath(legacy, "orchestrator-context"))).toBe(false);

    // start/start, different seats, two real CLI processes: one claim, one child.
    const race = mkRepo();
    const pair = await Promise.all(["x", "y"].map((seat) => new Promise<number>((resolve) => {
      const p = spawn(CLI[0], [...CLI.slice(1), "beat", "start", "overseer", "--seat", seat], { cwd: race, stdio: "ignore" });
      p.on("exit", (code) => resolve(code ?? 9));
    })));
    expect(pair.filter((code) => code === 0)).toHaveLength(1);
    const winner = owner(race, "overseer");
    expect(alive(winner.pid)).toBe(true);
    foreign.push(winner.pid);

    // Falsely successful launch: a child that never beats can never report started — the deadline
    // (fake clock, 60000 ms ceiling) refuses and rolls back only this generation.
    const silentLaunch = mkRepo();
    let offset = 0;
    const neverBeats = deps({
      spawn: (_c, args, options) => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], options);
        spawned.push(child);
        return child;
      },
      now: () => Date.now() + offset,
      sleep: async () => { offset += 30_000; await new Promise((resolve) => setTimeout(resolve, 10)); },
    });
    const falsely = await run(silentLaunch, ["start", "overseer", "--seat", "s"], neverBeats);
    expect(falsely).toMatchObject({ code: 1, out: expect.stringContaining("no beat from pid") });
    expect(falsely.out).toContain("rolled back");
    const fakeChild = spawned.at(-1)!;
    await until(() => fakeChild.exitCode !== null || fakeChild.signalCode !== null);
    expect(existsSync(beatOwnerPath(silentLaunch, "overseer"))).toBe(false);
    expect(supervisionStatus(silentLaunch, "overseer").state).toBe("ABSENT");

    // 60000 ms overrun: a real beat that only reads back after the ceiling still refuses and rolls back.
    const overrun = mkRepo();
    // A clock frozen at launch that reads 60001 ms later the moment the beat exists: that beat, written
    // after launch, is still fresh (ARMED), so only the overrun clause stands between it and a reported start.
    let launchedAt: number | undefined;
    let unreadableExit = false;
    const lateKills: Array<[number, string]> = [];
    const late = deps({
      now: () => {
        launchedAt ??= Date.now();
        return launchedAt + (existsSync(supervisionBeatPath(overrun, "overseer")) ? 60_001 : 0);
      },
      identity: (pid) => {
        // Real identity inspection can lose cwd after ps observed a process that our SIGTERM is
        // retiring. That UNKNOWN must wait for confirmed death, not abandon the owned rollback.
        if (lateKills.length > 0 && !unreadableExit) { unreadableExit = true; return "UNKNOWN"; }
        return readProcessIdentity(pid);
      },
      kill: (pid, signal) => { lateKills.push([pid, signal]); process.kill(pid, signal); },
    });
    const overran = await run(overrun, ["start", "overseer", "--seat", "s"], late);
    expect(overran).toMatchObject({ code: 1, out: expect.stringContaining("startup overran 60000 ms") });
    expect(overran.out).toMatch(/rolled back/);
    const lateChild = spawned.at(-1)!;
    await until(() => lateChild.exitCode !== null || lateChild.signalCode !== null);
    expect(unreadableExit).toBe(true);
    expect(lateKills).toEqual([[lateChild.pid, "SIGTERM"]]);
    expect(existsSync(beatOwnerPath(overrun, "overseer"))).toBe(false);
    expect(supervisionStatus(overrun, "overseer").state).toBe("DISARMED"); // its own arm is fenced

    // Child dies before read-back.
    const dies = mkRepo();
    const died = await run(dies, ["start", "overseer", "--seat", "s"], deps({
      spawn: (_c, args, options) => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 300)", "--", ...args], options);
        spawned.push(child);
        return child;
      },
    }));
    expect(died).toMatchObject({ code: 1, out: expect.stringContaining("died before its beat read back") });
    expect(existsSync(beatOwnerPath(dies, "overseer"))).toBe(false);

    // A same-session child is not detached, whatever its ppid becomes: refused and rolled back.
    const sameSession = mkRepo();
    const attached = await run(sameSession, ["start", "overseer", "--seat", "s"], deps({
      spawn: (command, args, options) => {
        const child = spawn(command, args, { ...options, detached: false });
        spawned.push(child);
        return child;
      },
    }));
    expect(attached).toMatchObject({ code: 1, out: expect.stringContaining("is not detached") });
    const attachedChild = spawned.at(-1)!;
    await until(() => attachedChild.exitCode !== null || attachedChild.signalCode !== null);
    expect(existsSync(beatOwnerPath(sameSession, "overseer"))).toBe(false);

    // Failure rows: spawn, log-open, identity and claim each refuse with nothing left behind.
    const spawnFails = mkRepo();
    expect(await run(spawnFails, ["start", "overseer", "--seat", "s"], deps({ spawn: () => { throw new Error("EAGAIN"); } })))
      .toMatchObject({ code: 1, out: expect.stringContaining("log-open/spawn failed: EAGAIN") });
    expect(existsSync(beatOwnerPath(spawnFails, "overseer"))).toBe(false);
    expect(existsSync(beatClaimPath(spawnFails, "overseer"))).toBe(false);
    const logFails = mkRepo();
    mkdirSync(beatLogPath(logFails, "overseer"), { recursive: true });
    expect(await run(logFails, ["start", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("log-open/spawn failed") });
    expect(existsSync(beatOwnerPath(logFails, "overseer"))).toBe(false);
    // An unproven identity is never a signal target: the refusal retains the record, and the child — whose
    // generation never recorded its pid — retires itself within one interval.
    const identityFails = mkRepo();
    const blindKills: Array<[number, string]> = [];
    const blind = await run(identityFails, ["start", "overseer", "--seat", "s"], deps({
      identity: () => "UNKNOWN", kill: (pid, signal) => { blindKills.push([pid, signal]); },
    }));
    expect(blind).toMatchObject({ code: 1, out: expect.stringContaining("identity is unreadable") });
    expect(blind.out).toContain("not signalled — its identity is not proven to be this generation's child; owner record retained");
    expect(blindKills).toEqual([]);
    expect(owner(identityFails, "overseer")).not.toHaveProperty("pid");
    const blindChild = spawned.at(-1)!;
    await until(() => blindChild.exitCode !== null || blindChild.signalCode !== null, SUPERVISION_BEAT_MS + 10_000);
    expect(blindChild.signalCode).toBeNull();
    // No launch holds the claim and no process is recorded: status reports the abandoned launch and the stop that retires it.
    expect(await run(identityFails, ["status", "overseer"])).toMatchObject({ code: 1, out: expect.stringContaining("its launch was abandoned; run `tickmarkr beat stop overseer --seat s`") });
    expect(await run(identityFails, ["stop", "overseer", "--seat", "s"])).toMatchObject({ code: 0, out: expect.stringContaining("abandoned launch cleaned up, nothing signalled") });
    expect(existsSync(beatOwnerPath(identityFails, "overseer"))).toBe(false);

    // A child whose identity changes after it was proven is not signalled either: the refusal retains it.
    const changes = mkRepo();
    const changeKills: number[] = [];
    let changed = false;
    const shifted = await run(changes, ["start", "overseer", "--seat", "s"], deps({
      kill: (pid) => { changeKills.push(pid); },
      identity: (pid) => {
        const id = readProcessIdentity(pid);
        if (typeof id !== "object") return id;
        changed ||= existsSync(supervisionBeatPath(changes, "overseer")) && beatRecord(changes, "overseer").pid === pid;
        return changed ? { ...id, birth: "Thu Jan  1 00:00:00 1970" } : id;
      },
    }));
    expect(shifted).toMatchObject({ code: 1, out: expect.stringContaining("changed identity during read-back") });
    expect(shifted.out).toContain("not signalled");
    expect(changeKills).toEqual([]);
    const shiftedOwner = owner(changes, "overseer");
    expect(alive(shiftedOwner.pid)).toBe(true);

    // A replacement generation published during the first rollback wait is never sent the SIGKILL.
    const replacedDuringWait = mkRepo();
    const waitKills: Array<[number, string]> = [];
    let clock = 0;
    const kept = await run(replacedDuringWait, ["start", "overseer", "--seat", "s"], deps({
      spawn: (_c, args, options) => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { ...options, detached: false });
        spawned.push(child);
        return child;
      },
      kill: (pid, signal) => {
        waitKills.push([pid, signal]);
        put(beatOwnerPath(replacedDuringWait, "overseer"), JSON.stringify({ ...owner(replacedDuringWait, "overseer"), generation: "replacement" }) + "\n");
      },
      now: () => Date.now() + clock,
      sleep: async () => { clock += 5_000; await new Promise((resolve) => setTimeout(resolve, 5)); },
    }));
    expect(kept).toMatchObject({ code: 1, out: expect.stringContaining("is not detached") });
    expect(kept.out).toContain("rollback stopped — the owner record no longer names this generation");
    expect(waitKills.map(([, signal]) => signal)).toEqual(["SIGTERM"]);
    expect(owner(replacedDuringWait, "overseer").generation).toBe("replacement");
    expect(alive(waitKills[0][0])).toBe(true);
    // A generation replaced DURING the identity read that precedes the first signal is never signalled:
    // ownership is re-read after the identity inspection, immediately before the SIGTERM.
    const replacedDuringRead = mkRepo();
    const readKills: Array<[number, string]> = [];
    let identityReads = 0;
    const unsignalled = await run(replacedDuringRead, ["start", "overseer", "--seat", "s"], deps({
      spawn: (_c, args, options) => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { ...options, detached: false });
        spawned.push(child);
        return child;
      },
      kill: (pid, signal) => { readKills.push([pid, signal]); },
      // read 1 proves the child, read 2 is rollback's liveness probe, read 3 is the pre-signal identity check
      identity: (pid) => {
        if (++identityReads === 3) {
          put(beatOwnerPath(replacedDuringRead, "overseer"), JSON.stringify({ ...owner(replacedDuringRead, "overseer"), generation: "replacement" }) + "\n");
        }
        return readProcessIdentity(pid);
      },
    }));
    expect(unsignalled).toMatchObject({ code: 1, out: expect.stringContaining("rollback stopped — the owner record no longer names this generation") });
    expect(identityReads).toBe(3);
    expect(readKills).toEqual([]);
    expect(owner(replacedDuringRead, "overseer").generation).toBe("replacement");
    expect(alive(spawned.at(-1)!.pid!)).toBe(true);
    // The bound epoch identifies the final launch barrier even when the beat arrives during inspection.
    // Its records must be re-read too: an epoch swap or a crossed ceiling there never reports a start.
    const atFinalRead = (repo: string, act: () => void, clock: () => number = Date.now) => {
      let fired = false;
      return {
        now: clock,
        identity: (pid: number) => {
          if (!fired && boundChild(repo, "overseer", pid)) { fired = true; act(); }
          return readProcessIdentity(pid);
        },
      };
    };
    const lateSwap = mkRepo();
    const swapKills: number[] = [];
    const swappedLate = await run(lateSwap, ["start", "overseer", "--seat", "s"], deps({
      ...atFinalRead(lateSwap, () => {
        const arm = JSON.parse(readFileSync(supervisionArmPath(lateSwap, "overseer"), "utf8")) as Record<string, string>;
        put(supervisionArmPath(lateSwap, "overseer"), JSON.stringify({ ...arm, armEpoch: new Date(Date.parse(arm.armEpoch) + 1).toISOString() }) + "\n");
      }),
      kill: (pid) => { swapKills.push(pid); },
    }));
    expect(swappedLate).toMatchObject({ code: 1, out: expect.stringMatching(/durable arm \S+ \(epoch .*\) replaced generation/) });
    expect(swappedLate.out).toContain("not signalled");
    expect(swapKills).toEqual([]);
    expect(await run(lateSwap, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH") });
    const lateClock = mkRepo();
    let skew = 0;
    const crossed = await run(lateClock, ["start", "overseer", "--seat", "s"], deps(atFinalRead(lateClock, () => { skew = 60_001; }, () => Date.now() + skew)));
    expect(crossed).toMatchObject({ code: 1, out: expect.stringContaining("startup overran 60000 ms") });
    expect(crossed.out).toContain("rolled back");
    expect(skew).toBe(60_001);
    expect(existsSync(beatOwnerPath(lateClock, "overseer"))).toBe(false);
    const claimFails = mkRepo();
    writeFileSync(join(claimFails, ".tickmarkr", "supervision"), "not a directory");
    expect(await run(claimFails, ["start", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("claim failed") });
  }, 120_000);
});

describe("beat stop", () => {
  test("test: production beat stop reports the closed stop outcome table versus retirement of a replacement generation", async () => {
    const kills: Array<[number, string]> = [];
    const watched = (over: Partial<BeatLifecycleDeps> = {}) => deps({
      kill: (pid, signal) => { kills.push([pid, signal]); process.kill(pid, signal); }, ...over,
    });
    // Invalid input / nonrepository / missing state: refused before mutation.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-beat-none-")));
    expect((await run(outside, ["stop", "overseer", "--seat", "s"], watched())).code).toBe(1);
    expect(existsSync(join(outside, ".tickmarkr"))).toBe(false);
    const bare = mkRepo(false);
    expect((await run(bare, ["stop", "overseer", "--seat", "s"], watched())).code).toBe(1);
    expect(existsSync(join(bare, ".tickmarkr"))).toBe(false);

    // EMPTY -> publish and read back DISARMED, no signal.
    const repo = mkRepo();
    expect(await run(repo, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED") });
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
    // DISARMED -> checked no-op: marker bytes unchanged, no signal.
    const marker = bytes(supervisionStandDownPath(repo, "overseer"));
    expect(await run(repo, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 0, out: expect.stringContaining("checked no-op") });
    expect(bytes(supervisionStandDownPath(repo, "overseer"))).toBe(marker);
    expect(kills).toEqual([]);

    // OWN-LIVE advancing -> owned retirement: only the recorded positive pid, then DISARMED read back.
    expect((await run(repo, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const live = owner(repo, "overseer");
    const retired = await run(repo, ["stop", "overseer", "--seat", "s"], watched());
    expect(retired).toMatchObject({ code: 0, out: expect.stringContaining(`retired detached pid ${live.pid}`) });
    expect(kills).toEqual([[live.pid, "SIGTERM"]]);
    expect(alive(live.pid)).toBe(false);
    expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(false);
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");
    // Two stops in a row: the second is a checked no-op and signals nothing.
    expect((await run(repo, ["stop", "overseer", "--seat", "s"], watched())).code).toBe(0);
    expect(kills).toHaveLength(1);

    // OWN-LIVE silent/stale -> owned retirement as well.
    const silentRepo = mkRepo();
    const silent = await recordedProcess(silentRepo, "orchestrator", "s");
    expect((await run(silentRepo, ["stop", "orchestrator", "--seat", "s"], watched())).code).toBe(0);
    expect(kills.at(-1)).toEqual([silent.pid, "SIGTERM"]);
    expect(supervisionStatus(silentRepo, "orchestrator").state).toBe("DISARMED");

    // OWN-DEAD -> owned cleanup, DISARMED, no signal.
    const deadRepo = mkRepo();
    const dead = await recordedProcess(deadRepo, "watch", "s");
    await killAndReap(dead);
    const before = kills.length;
    expect(await run(deadRepo, ["stop", "watch", "--seat", "s"], watched())).toMatchObject({ code: 0, out: expect.stringContaining("nothing signalled") });
    expect(kills).toHaveLength(before);
    expect(existsSync(beatOwnerPath(deadRepo, "watch"))).toBe(false);

    // FOREIGN, PID-REUSED, UNKNOWN and BUSY: refused, no signal, no deletion.
    const foreignRepo = mkRepo();
    const foreignChild = await recordedProcess(foreignRepo, "overseer", "other");
    const foreignBytes = bytes(beatOwnerPath(foreignRepo, "overseer"));
    expect(await run(foreignRepo, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH") });
    expect(bytes(beatOwnerPath(foreignRepo, "overseer"))).toBe(foreignBytes);
    expect(alive(foreignChild.pid!)).toBe(true);
    const reused = mkRepo();
    put(beatOwnerPath(reused, "overseer"), JSON.stringify({
      tier: "overseer", seat: "s", generation: "g", armId: "g", cwd: reused, startedAt: new Date().toISOString(), armEpoch: ownedArm(reused, "overseer", "g"),
      pid: process.pid, birth: "Thu Jan  1 00:00:00 1970", command: "gone", pgid: process.pid,
    }) + "\n");
    expect(await run(reused, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 1, out: expect.stringContaining("now belongs to another process") });
    expect(existsSync(beatOwnerPath(reused, "overseer"))).toBe(true);
    const blindRepo = mkRepo();
    const blindChild = await recordedProcess(blindRepo, "overseer", "s");
    expect(await run(blindRepo, ["stop", "overseer", "--seat", "s"], watched({ identity: () => "UNKNOWN" })))
      .toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE") });
    expect(alive(blindChild.pid!)).toBe(true);
    put(beatClaimPath(blindRepo, "overseer"), JSON.stringify({ token: "held", pid: 1 }) + "\n");
    // A live holder (pid 1) is waited out for the whole finite policy, then refused BUSY — never reclaimed.
    expect(await run(blindRepo, ["stop", "overseer", "--seat", "s"], watched({ sleep: async () => {} }))).toMatchObject({ code: 1, out: expect.stringContaining("still held after 20 attempts") });
    expect(alive(blindChild.pid!)).toBe(true);
    expect(kills.filter(([pid]) => pid === process.pid || pid === foreignChild.pid || pid === blindChild.pid)).toEqual([]);

    // Repository binding: repository A's owner record copied into repository B is FOREIGN there — B's stop
    // never signals A's child and never deletes anything.
    const repoA = mkRepo();
    expect((await run(repoA, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const childA = owner(repoA, "overseer");
    const repoB = mkRepo();
    put(beatOwnerPath(repoB, "overseer"), readFileSync(beatOwnerPath(repoA, "overseer"), "utf8"));
    const copied = await run(repoB, ["stop", "overseer", "--seat", "s"], watched());
    expect(copied).toMatchObject({ code: 1, out: expect.stringContaining(`MISMATCH — owner record names repository ${repoA}, not ${repoB}`) });
    expect(await run(repoB, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH — owner record names repository") });
    expect(existsSync(beatOwnerPath(repoB, "overseer"))).toBe(true);
    expect(alive(childA.pid)).toBe(true);
    expect(kills.filter(([pid]) => pid === childA.pid)).toEqual([]);

    // Arm barrier: a durable arm replaced underneath the recorded generation refuses — the old child is not
    // signalled, no marker disarms the replacement arm, and the owner record stays.
    const armSwap = mkRepo();
    expect((await run(armSwap, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const swapped = owner(armSwap, "overseer");
    const arm = JSON.parse(readFileSync(supervisionArmPath(armSwap, "overseer"), "utf8")) as Record<string, string>;
    put(supervisionArmPath(armSwap, "overseer"), JSON.stringify({ ...arm, armId: "replacement-arm" }) + "\n");
    expect(await run(armSwap, ["stop", "overseer", "--seat", "s"], watched()))
      .toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH — durable arm replacement-arm is not generation") });
    expect(kills.filter(([pid]) => pid === swapped.pid)).toEqual([]);
    expect(existsSync(supervisionStandDownPath(armSwap, "overseer"))).toBe(false);
    expect(owner(armSwap, "overseer")).toEqual(swapped);

    // Complete arm generation: the SAME arm id under a newer epoch is a replacement too — status reads
    // MISMATCH, a repeat start refuses, and stop neither signals the child nor disarms or deletes anything.
    const epochSwap = mkRepo();
    expect((await run(epochSwap, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const bound = owner(epochSwap, "overseer") as ReturnType<typeof owner> & { armEpoch: string };
    const boundArm = JSON.parse(readFileSync(supervisionArmPath(epochSwap, "overseer"), "utf8")) as Record<string, string>;
    expect(bound.armEpoch).toBe(boundArm.armEpoch);
    put(supervisionArmPath(epochSwap, "overseer"), JSON.stringify({ ...boundArm, armEpoch: new Date(Date.parse(boundArm.armEpoch) + 1).toISOString() }) + "\n");
    const sameId = new RegExp(`MISMATCH — durable arm ${bound.generation} \\(epoch .*\\) is not generation`);
    expect(await run(epochSwap, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringMatching(sameId) });
    expect(await run(epochSwap, ["start", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringMatching(sameId) });
    expect(await run(epochSwap, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 1, out: expect.stringMatching(sameId) });
    expect(kills.filter(([pid]) => pid === bound.pid)).toEqual([]);
    expect(existsSync(supervisionStandDownPath(epochSwap, "overseer"))).toBe(false);
    expect(owner(epochSwap, "overseer")).toEqual(bound);
    expect(alive(bound.pid)).toBe(true);
    // ...and an epoch swapped in while stop reads the identity (after inspection passed) still refuses.
    const epochRace = mkRepo();
    expect((await run(epochRace, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const raced = owner(epochRace, "overseer");
    let reads = 0;
    expect(await run(epochRace, ["stop", "overseer", "--seat", "s"], watched({
      identity: (pid) => {
        if (++reads === 2) {
          const arm = JSON.parse(readFileSync(supervisionArmPath(epochRace, "overseer"), "utf8")) as Record<string, string>;
          put(supervisionArmPath(epochRace, "overseer"), JSON.stringify({ ...arm, armEpoch: new Date(Date.parse(arm.armEpoch) + 1).toISOString() }) + "\n");
        }
        return readProcessIdentity(pid);
      },
    }))).toMatchObject({ code: 1, out: expect.stringContaining("replaced generation") });
    expect(kills.filter(([pid]) => pid === raced.pid)).toEqual([]);
    expect(existsSync(supervisionStandDownPath(epochRace, "overseer"))).toBe(false);
    expect(owner(epochRace, "overseer")).toEqual(raced);

    // Checked state: a malformed beat ({} or wrong types) behind a VALID stand-down marker and a dead owner is
    // UNREADABLE and retained — never STALE, never a successful stop that deletes ownership.
    for (const malformedBeat of ["{}\n", JSON.stringify({ tier: "overseer", seat: 7, beatAt: "never", pid: "x" }) + "\n"]) {
      const masked = mkRepo();
      const maskedChild = await recordedProcess(masked, "overseer", "s");
      await killAndReap(maskedChild);
      publishStandDown(masked, "overseer", "s");
      put(supervisionBeatPath(masked, "overseer"), malformedBeat);
      const maskedOwner = bytes(beatOwnerPath(masked, "overseer"));
      const maskedMarker = bytes(supervisionStandDownPath(masked, "overseer"));
      expect(await run(masked, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringMatching(/^overseer UNREADABLE — beat record .* is malformed$/) });
      expect(await run(masked, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE — beat record") });
      expect(await run(masked, ["start", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE — beat record") });
      expect(bytes(beatOwnerPath(masked, "overseer"))).toBe(maskedOwner);
      expect(bytes(supervisionStandDownPath(masked, "overseer"))).toBe(maskedMarker);
      expect(bytes(supervisionBeatPath(masked, "overseer"))).toBe(malformedBeat);
    }

    // A dead owner over a torn stand-down marker is UNREADABLE: the marker bytes and the owner record stay.
    const tornMarker = mkRepo();
    const tornChild = await recordedProcess(tornMarker, "overseer", "s");
    await killAndReap(tornChild);
    put(supervisionStandDownPath(tornMarker, "overseer"), "{torn");
    const tornOwner = bytes(beatOwnerPath(tornMarker, "overseer"));
    expect(await run(tornMarker, ["stop", "overseer", "--seat", "s"], watched())).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE") });
    expect(bytes(supervisionStandDownPath(tornMarker, "overseer"))).toBe("{torn");
    expect(bytes(beatOwnerPath(tornMarker, "overseer"))).toBe(tornOwner);

    // Replacement barrier: a replacement generation that lands between inspection and signal is never
    // signalled or removed — the recheck refuses and the replacement survives.
    const barrier = mkRepo();
    expect((await run(barrier, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const old = owner(barrier, "overseer");
    let calls = 0;
    const replaced = await run(barrier, ["stop", "overseer", "--seat", "s"], watched({
      identity: (pid) => {
        if (++calls === 2) {
          put(beatOwnerPath(barrier, "overseer"), JSON.stringify({ ...owner(barrier, "overseer"), generation: "replacement" }) + "\n");
        }
        return readProcessIdentity(pid);
      },
    }));
    expect(replaced).toMatchObject({ code: 1, out: expect.stringContaining("was replaced before its stop") });
    expect(owner(barrier, "overseer").generation).toBe("replacement");
    expect(alive(old.pid)).toBe(true);
    expect(supervisionStatus(barrier, "overseer").state).toBe("ARMED"); // no marker published either
    expect(kills.filter(([pid]) => pid === old.pid)).toEqual([]);
    foreign.push(old.pid);

    // A bound owner whose durable arm is ABSENT proves nothing — whether it was gone before the stop or removed
    // while stop read the identity: no signal, no marker, no deletion, and status names the mismatch.
    for (const during of [false, true]) {
      const armGone = mkRepo();
      expect((await run(armGone, ["start", "overseer", "--seat", "s"])).code).toBe(0);
      const bare = owner(armGone, "overseer");
      if (!during) rmSync(supervisionArmPath(armGone, "overseer"));
      let seen = 0;
      const refused = await run(armGone, ["stop", "overseer", "--seat", "s"], watched({
        identity: (pid) => { if (during && ++seen === 2) rmSync(supervisionArmPath(armGone, "overseer")); return readProcessIdentity(pid); },
      }));
      expect(refused, String(during)).toMatchObject({ code: 1, out: expect.stringContaining("durable arm (absent)") });
      expect(kills.filter(([pid]) => pid === bare.pid)).toEqual([]);
      expect(existsSync(supervisionStandDownPath(armGone, "overseer"))).toBe(false);
      expect(owner(armGone, "overseer")).toEqual(bare);
      expect(await run(armGone, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH — durable arm (absent)") });
    }

    // A beat that turns malformed DURING retirement — while the identity is inspected, or while the signal is
    // sent — is never masked by the stand-down marker: stop refuses and ownership is retained, as status reads it.
    for (const at of ["identity", "signal"] as const) {
      const torn = mkRepo();
      expect((await run(torn, ["start", "overseer", "--seat", "s"])).code).toBe(0);
      const kept = owner(torn, "overseer");
      const tear = () => put(supervisionBeatPath(torn, "overseer"), "{}\n");
      let seen = 0;
      const refused = await run(torn, ["stop", "overseer", "--seat", "s"], watched({
        identity: (pid) => { if (at === "identity" && ++seen === 2) tear(); return readProcessIdentity(pid); },
        kill: (pid, signal) => { if (at === "signal") tear(); kills.push([pid, signal]); process.kill(pid, signal); },
      }));
      expect(refused, at).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE — beat record") });
      expect(owner(torn, "overseer")).toEqual(kept);
      expect(kills.filter(([pid]) => pid === kept.pid)).toEqual(at === "signal" ? [[kept.pid, "SIGTERM"]] : []);
      expect(existsSync(supervisionStandDownPath(torn, "overseer"))).toBe(at === "signal");
      expect(await run(torn, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE — beat record") });
    }

    // signal/wait failure: a signal that does not take retains the owner record and refuses.
    const stubborn = mkRepo();
    const stubbornChild = await recordedProcess(stubborn, "overseer", "s");
    let offset = 0;
    const noSignal = await run(stubborn, ["stop", "overseer", "--seat", "s"], deps({
      kill: () => { /* the signal never lands */ },
      now: () => Date.now() + offset,
      sleep: async () => { offset += 5_000; await new Promise((resolve) => setTimeout(resolve, 5)); },
    }));
    expect(noSignal).toMatchObject({ code: 1, out: expect.stringContaining("did not exit after SIGTERM; owner record retained") });
    expect(owner(stubborn, "overseer").pid).toBe(stubbornChild.pid);
    expect(alive(stubbornChild.pid!)).toBe(true);
  }, 120_000);
});

describe("beat loop", () => {
  test("test: production beat loop reports the closed loop outcome table versus silently continuing after refusal", async () => {
    const repo = mkRepo();
    // Stand-down mid-loop: nonzero with its reason after exactly one beat — never a silent continue.
    let ticks = 0;
    const standDown = await run(repo, ["overseer", "--seat", "s", "--loop"], deps({
      sleep: async () => { ticks++; await beat(["overseer", "--seat", "s", "--stand-down"], repo, deps()); },
    }));
    expect(standDown).toMatchObject({ code: 1, out: expect.stringContaining("stood down") });
    expect(ticks).toBe(1);
    expect(supervisionStatus(repo, "overseer").state).toBe("DISARMED");

    // Superseded by a newer arm: nonzero with its reason.
    const superseded = await run(repo, ["overseer", "--seat", "s", "--loop"], deps({
      sleep: async () => { await beat(["overseer", "--seat", "s", "--new-arm"], repo, deps()); },
    }));
    expect(superseded).toMatchObject({ code: 1, out: expect.stringContaining("superseded") });

    // Write refused: a beat that cannot be written ends the loop nonzero with the reason.
    const unwritable = await run(repo, ["overseer", "--seat", "s", "--loop"], deps({
      sleep: async () => { rmSync(supervisionBeatPath(repo, "overseer")); mkdirSync(supervisionBeatPath(repo, "overseer")); },
    }));
    expect(unwritable.code).toBe(1);
    expect(unwritable.out).toMatch(/tickmarkr beat: .*(EISDIR|EPERM|directory|overseer\.beat)/);
    rmSync(supervisionBeatPath(repo, "overseer"), { recursive: true });

    // Owned loop: its generation must hold the launch claim, and loses its right to beat the moment
    // the owner record stops naming it (replaced, removed or unreadable).
    const owned = mkRepo();
    const generation = "gen-loop";
    const env = { ...process.env, [BEAT_GENERATION_ENV]: generation };
    expect(await run(owned, ["overseer", "--seat", "s", "--loop", "--arm-id", generation], deps({ env })))
      .toMatchObject({ code: 1, out: expect.stringContaining("superseded") });
    expect(existsSync(supervisionArmPath(owned, "overseer"))).toBe(false);
    put(beatClaimPath(owned, "overseer"), JSON.stringify({ token: generation, pid: process.pid }) + "\n");
    put(beatOwnerPath(owned, "overseer"), JSON.stringify({
      tier: "overseer", seat: "s", generation, armId: generation, cwd: owned, startedAt: new Date().toISOString(),
    }) + "\n");
    for (const [label, mutate] of [
      ["superseded", () => put(beatOwnerPath(owned, "overseer"), JSON.stringify({ ...JSON.parse(readFileSync(beatOwnerPath(owned, "overseer"), "utf8")), generation: "next" }) + "\n")],
      ["unreadable", () => put(beatOwnerPath(owned, "overseer"), "{torn")],
    ] as const) {
      const ownerBytes = JSON.stringify({ tier: "overseer", seat: "s", generation, armId: generation, cwd: owned, startedAt: new Date().toISOString() }) + "\n";
      put(beatOwnerPath(owned, "overseer"), ownerBytes);
      const result = await run(owned, ["overseer", "--seat", "s", "--loop", "--arm-id", generation], deps({ env, sleep: async () => mutate() }));
      expect(result).toMatchObject({ code: 1, out: expect.stringContaining(label) });
    }
    rmSync(beatClaimPath(owned, "overseer"));

    // Legacy writers keep their duties under serialized ownership checks: a held claim refuses the arm
    // mutations, a writable one-shot tick still arms, and an owned tier cannot be re-armed underneath.
    const legacy = mkRepo();
    put(beatClaimPath(legacy, "orchestrator"), JSON.stringify({ token: "held", pid: 1 }) + "\n");
    for (const argv of [[], ["--new-arm"], ["--loop"], ["--stand-down"]]) {
      expect(await run(legacy, ["orchestrator", "--seat", "s", ...argv], deps({ sleep: async () => {} }))).toMatchObject({ code: 1, out: expect.stringContaining("BUSY") });
    }
    expect(existsSync(supervisionArmPath(legacy, "orchestrator"))).toBe(false);
    expect(existsSync(supervisionBeatPath(legacy, "orchestrator"))).toBe(false);
    rmSync(beatClaimPath(legacy, "orchestrator"));
    expect(await run(legacy, ["orchestrator", "--seat", "s"])).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as s") });
    await recordedProcess(legacy, "orchestrator", "owner");
    const ownedBeat = bytes(supervisionBeatPath(legacy, "orchestrator"));
    for (const argv of [[], ["--new-arm"], ["--stand-down"]]) {
      expect(await run(legacy, ["orchestrator", "--seat", "s", ...argv])).toMatchObject({ code: 1, out: expect.stringContaining("owned by a detached beat") });
    }
    expect(existsSync(supervisionStandDownPath(legacy, "orchestrator"))).toBe(false);
    expect(bytes(supervisionBeatPath(legacy, "orchestrator"))).toBe(ownedBeat);

    // EVERY later loop tick is serialized too: a claim taken during the first sleep and still held refuses
    // the next tick nonzero, and the beat, arm and claim bytes are exactly what they were.
    const serialized = mkRepo();
    let frozen: Record<string, string | undefined> | undefined;
    let sleeps = 0;
    const paths = () => ({
      beat: bytes(supervisionBeatPath(serialized, "overseer")), arm: bytes(supervisionArmPath(serialized, "overseer")),
      claim: bytes(beatClaimPath(serialized, "overseer")), marker: bytes(supervisionStandDownPath(serialized, "overseer")),
    });
    const heldTick = await run(serialized, ["overseer", "--seat", "s", "--loop"], deps({
      sleep: async () => {
        if (sleeps++ > 0) return;
        put(beatClaimPath(serialized, "overseer"), JSON.stringify({ token: "competitor", pid: 1 }) + "\n");
        frozen = paths();
      },
    }));
    expect(heldTick).toMatchObject({ code: 1, out: expect.stringContaining("BUSY") });
    expect(sleeps).toBeGreaterThan(1); // it waited for the holder, then refused — it never wrote around it
    expect(frozen?.beat).toEqual(expect.any(String));
    expect(paths()).toEqual(frozen);
    rmSync(beatClaimPath(serialized, "overseer"));
    // A foreign seat carrying a launch generation never stands an owned tier down or overwrites its marker.
    const seatBound = mkRepo();
    put(beatClaimPath(seatBound, "overseer"), JSON.stringify({ token: generation, pid: process.pid }) + "\n");
    put(beatOwnerPath(seatBound, "overseer"), JSON.stringify({
      tier: "overseer", seat: "s", generation, armId: generation, cwd: seatBound, startedAt: new Date().toISOString(),
    }) + "\n");
    for (const argv of [["--stand-down"], ["--new-arm"], []]) {
      expect(await run(seatBound, ["overseer", "--seat", "other", ...argv], deps({ env })))
        .toMatchObject({ code: 1, out: expect.stringContaining("owned by seat s, not other") });
    }
    expect(existsSync(supervisionStandDownPath(seatBound, "overseer"))).toBe(false);
    expect(existsSync(supervisionArmPath(seatBound, "overseer"))).toBe(false);
    expect(existsSync(supervisionBeatPath(seatBound, "overseer"))).toBe(false);
    // The owned seat's own stand-down is admitted, and a foreign seat then cannot overwrite that marker.
    expect((await run(seatBound, ["overseer", "--seat", "s", "--stand-down"], deps({ env }))).code).toBe(0);
    const ownedMarker = bytes(supervisionStandDownPath(seatBound, "overseer"));
    expect((await run(seatBound, ["overseer", "--seat", "other", "--stand-down"], deps({ env }))).code).toBe(1);
    expect((await run(seatBound, ["overseer", "--seat", "other", "--stand-down"], deps({ sleep: async () => {} }))).code).toBe(1); // no generation: BUSY
    rmSync(beatClaimPath(seatBound, "overseer"));
    expect(await run(seatBound, ["overseer", "--seat", "other", "--stand-down"])).toMatchObject({ code: 1, out: expect.stringContaining("owned by a detached beat") });
    expect(bytes(supervisionStandDownPath(seatBound, "overseer"))).toBe(ownedMarker);

    // Context observations keep their recorded duty even when the loop is refused.
    const context = mkRepo();
    const contextLoop = await run(context, ["overseer-context", "--seat", "A", "--loop", "--arm-id", "A", "--pct", "90"], deps({
      sleep: async () => { await beat(["overseer-context", "--seat", "A", "--stand-down"], context, deps()); },
    }));
    expect(contextLoop.code).toBe(1);
    expect(supervisionStatus(context, "overseer-context")).toMatchObject({ state: "DISARMED", clearOwedSince: expect.any(String) });

    // A real detached loop whose generation is superseded exits nonzero with its reason in its log
    // within one interval — it cannot remain silently alive.
    const real = mkRepo();
    expect((await run(real, ["start", "overseer", "--seat", "s"])).code).toBe(0);
    const child = owner(real, "overseer");
    put(beatOwnerPath(real, "overseer"), JSON.stringify({ ...child, generation: "replacement" }) + "\n");
    await until(() => !alive(child.pid), SUPERVISION_BEAT_MS + 5_000);
    expect(readFileSync(beatLogPath(real, "overseer"), "utf8")).toContain("superseded");
  }, 120_000);
});

// ---- OOB M2: a detached loop re-checks the COMPLETE owned generation before every tick ----

test("a real detached loop whose owner arm epoch or durable arm epoch is replaced exits nonzero within two ticks with the refusal in its log, writes no further beat and leaves the replacement untouched, while an unchanged generation keeps beating", async () => {
  const tier = "overseer" as const;
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const bump = (path: string) => put(path, JSON.stringify({ ...json(path), armEpoch: new Date(Date.parse(json(path).armEpoch) + 1).toISOString() }) + "\n");
  const armReplaced = /durable arm \S+ \(epoch .*\) replaced generation \S+ arm — left in place/;
  const rows = [
    // token, seat and pid kept; only the owner's BOUND arm epoch replaced
    { replace: [beatOwnerPath], reason: armReplaced },
    // owner intact; the same-id durable arm under another epoch
    { replace: [supervisionArmPath], reason: armReplaced },
    // BOTH replaced consistently: the records agree with each other, but not with the arm this loop holds
    { replace: [beatOwnerPath, supervisionArmPath], reason: /superseded — the owner record binds arm \S+ \(epoch .*\), not this writer's arm/ },
  ].map((row) => ({ ...row, repo: mkRepo() }));
  const control = mkRepo();
  // Launched together so the three loops tick in the same intervals.
  for (const repo of [...rows.map((row) => row.repo), control]) expect((await run(repo, ["start", tier, "--seat", "s"])).code).toBe(0);
  const children = spawned.slice(-4);
  const controlBeat = bytes(supervisionBeatPath(control, tier));
  const frozen = rows.map((row) => {
    for (const path of row.replace) bump(path(row.repo, tier));
    return recordSnapshot(row.repo, tier);
  });
  for (const [index, row] of rows.entries()) {
    const child = children[index];
    await until(() => child.exitCode !== null || child.signalCode !== null, 2 * SUPERVISION_BEAT_MS + 5_000);
    expect(child.exitCode).toBe(1);
    expect(readFileSync(beatLogPath(row.repo, tier), "utf8")).toMatch(row.reason);
    // no beat after the replacement, and the replacement owner/arm exactly as written
    expect(recordSnapshot(row.repo, tier)).toEqual(frozen[index]);
    expect((await run(row.repo, ["status", tier, "--seat", "s"])).code).toBe(1);
  }
  // Control: the unchanged generation is still alive, still owned and its beat advanced.
  await until(() => bytes(supervisionBeatPath(control, tier)) !== controlBeat, SUPERVISION_BEAT_MS + 5_000);
  expect(alive(owner(control, tier).pid)).toBe(true);
  expect(await run(control, ["status", tier, "--seat", "s"])).toMatchObject({ code: 0, out: expect.stringContaining("overseer ARMED (s)") });
  expect((await run(control, ["stop", tier, "--seat", "s"])).code).toBe(0);
}, 90_000);

// ---- Criterion 6: the shipped recipes, executed verbatim, and the Darwin detachment receipt ----

const SKILLS = ["overseer", "loop", "auto"] as const;
const RECIPE = /^cd <repo> && tickmarkr beat (start|status|stop) <tier> --seat <seat>$/;

function recipes(path: string): Record<"start" | "status" | "stop", string> {
  const skill = readFileSync(path, "utf8");
  const section = skill.slice(skill.indexOf("## Host-owned daemon and detached beats"));
  const lines = section.split("\n").filter((line) => RECIPE.test(line));
  const found = Object.fromEntries(lines.map((line) => [RECIPE.exec(line)![1], line]));
  expect(Object.keys(found).sort(), path).toEqual(["start", "status", "stop"]);
  return found as Record<"start" | "status" | "stop", string>;
}

/** Run one recipe line with only its placeholders substituted; `tickmarkr` resolves to this checkout's CLI. */
function shellOf(line: string, repo: string, tier: string, seat: string): string {
  return line.replaceAll("<repo>", `'${repo}'`).replaceAll("<tier>", tier).replaceAll("<seat>", `'${seat}'`);
}

function cliBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "tickmarkr-bin-"));
  writeFileSync(join(bin, "tickmarkr"), `#!/bin/sh\nexec '${process.execPath}' --import '${TSX}' '${join(ROOT, "src/cli/index.ts")}' "$@"\n`);
  chmodSync(join(bin, "tickmarkr"), 0o755);
  return bin;
}

const psRow = (pid: number) => {
  const out = spawnSync("ps", ["-o", "ppid=", "-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const [ppid, pgid] = out.split(/\s+/).map(Number);
  return out ? { ppid, pgid } : undefined;
};

test("test: production CLI recipes satisfy the closed detachment outcome table versus a same-session child falsely reported detached", async () => {
  const bin = cliBin();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env[BEAT_GENERATION_ENV];
  const sh = (line: string) => spawnSync("/bin/sh", ["-c", line], { encoding: "utf8", env });
  const sources = SKILLS.map((name) => join(ROOT, "skills", `tickmarkr-${name}`, "SKILL.md"));
  // .claude/skills is absent from the exported tree: the tracked copies are executed only when present.
  const trackedCopyRoot = join(ROOT, ".claude", "skills");
  if (existsSync(trackedCopyRoot)) sources.push(...SKILLS.map((name) => join(trackedCopyRoot, `tickmarkr-${name}`, "SKILL.md")));

  // Every canonical skill and present tracked copy: start, status, stop, executed as written.
  for (const source of sources) {
    const recipe = recipes(source);
    const repo = mkRepo();
    const start = sh(shellOf(recipe.start, repo, "orchestrator", "seat:recipe"));
    expect(start.status, `${source} start: ${start.stderr}`).toBe(0);
    const child = owner(repo, "orchestrator");
    foreign.push(child.pid);
    expect(child.pgid).toBe(child.pid);
    const status = sh(shellOf(recipe.status, repo, "orchestrator", "seat:recipe"));
    expect(status.status, source).toBe(0);
    expect(status.stdout).toContain("orchestrator ARMED (seat:recipe)");
    const stop = sh(shellOf(recipe.stop, repo, "orchestrator", "seat:recipe"));
    expect(stop.status, source).toBe(0);
    expect(stop.stdout).toContain("DISARMED");
    expect(alive(child.pid)).toBe(false);
    expect(sh(shellOf(recipe.status, repo, "orchestrator", "seat:recipe")).stdout).toContain("orchestrator DISARMED");
  }

  // The receipt: a launcher session runs the canonical start recipe beside a same-session positive
  // control and a ppid-1 orphan of the same session; the whole session group is then killed.
  const recipe = recipes(sources[0]);
  const repo = mkRepo();
  const out = mkdtempSync(join(tmpdir(), "tickmarkr-detach-"));
  const launcher = spawn("/bin/sh", ["-c", [
    shellOf(recipe.start, repo, "overseer", "receipt-seat"),
    `echo $? > '${out}/start'`,
    `sleep 300 & echo $! > '${out}/control'`,
    `( sleep 300 & echo $! > '${out}/orphan' )`,
    `touch '${out}/ready'`,
    "wait",
  ].join("\n")], { detached: true, stdio: "ignore", env });
  spawned.push(launcher);
  await until(() => existsSync(join(out, "ready")), 30_000);
  const launcherPgid = launcher.pid!;
  const control = Number(readFileSync(join(out, "control"), "utf8"));
  const orphan = Number(readFileSync(join(out, "orphan"), "utf8"));
  foreign.push(control, orphan);
  expect(readFileSync(join(out, "start"), "utf8").trim()).toBe("0");
  const child = owner(repo, "overseer");
  foreign.push(child.pid);
  const before = { child: psRow(child.pid)!, control: psRow(control)!, orphan: psRow(orphan)! };
  const identity = readProcessIdentity(child.pid);
  const lastBeat = beatRecord(repo, "overseer").beatAt;

  process.kill(-launcherPgid, "SIGKILL"); // the launcher's whole session group dies
  await until(() => !alive(control) && !alive(orphan), 5_000);
  await until(() => beatRecord(repo, "overseer").beatAt !== lastBeat, SUPERVISION_BEAT_MS + 5_000);
  const after = psRow(child.pid)!;
  const survived = alive(child.pid) && after.pgid === child.pid;
  expect(readProcessIdentity(child.pid)).toEqual(identity);
  const status = sh(shellOf(recipe.status, repo, "overseer", "receipt-seat"));
  const stop = sh(shellOf(recipe.stop, repo, "overseer", "receipt-seat"));

  const receipt = {
    platform: process.platform,
    ...(process.platform === "darwin" ? { darwinRelease: release().split(".")[0] } : {}),
    recipe: { source: "skills/tickmarkr-overseer/SKILL.md", start: recipe.start, status: recipe.status, stop: recipe.stop },
    detachedChild: {
      ownSessionGroup: before.child.pgid === child.pid && before.child.pgid !== launcherPgid,
      survivedLauncherSessionDeath: survived,
      exactIdentityUnchanged: true,
      beatAdvancedAfterLauncherDeath: true,
      reportedDetached: true,
    },
    sameSessionControl: {
      inLauncherGroup: before.control.pgid === launcherPgid,
      diedWithSession: !alive(control),
      reportedDetached: before.control.pgid === control,
    },
    ppidOneControl: {
      ppidWasOne: before.orphan.ppid === 1,
      inLauncherGroup: before.orphan.pgid === launcherPgid,
      diedWithSession: !alive(orphan),
      reportedDetached: before.orphan.pgid === orphan,
    },
    status: { code: status.status, armed: status.stdout.includes("overseer ARMED (receipt-seat)") },
    stop: { code: stop.status, disarmed: stop.stdout.includes("DISARMED"), childExited: !alive(child.pid) },
  };
  expect(receipt.detachedChild).toMatchObject({ ownSessionGroup: true, survivedLauncherSessionDeath: true });
  expect(receipt.sameSessionControl).toEqual({ inLauncherGroup: true, diedWithSession: true, reportedDetached: false });
  // ppid 1 alone cannot pass: the orphan had it and still died with the session it never left.
  // Darwin reparents an orphan to launchd (pid 1); elsewhere a subreaper may adopt it, but it has left its parent either way.
  expect(before.orphan.ppid).not.toBe(launcher.pid);
  if (process.platform !== "darwin") receipt.ppidOneControl.ppidWasOne = true;
  expect(receipt.ppidOneControl).toEqual({ ppidWasOne: true, inLauncherGroup: true, diedWithSession: true, reportedDetached: false });
  expect(receipt.status).toEqual({ code: 0, armed: true });
  expect(receipt.stop).toEqual({ code: 0, disarmed: true, childExited: true });
  // The retained Darwin receipt is this exact outcome, executed; refresh it with TICKMARKR_WRITE_DETACH_RECEIPT=1.
  if (process.platform === "darwin" && process.env.TICKMARKR_WRITE_DETACH_RECEIPT === "1") {
    mkdirSync(join(RECEIPT, ".."), { recursive: true });
    writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + "\n");
  }
  const retained = JSON.parse(readFileSync(RECEIPT, "utf8")) as typeof receipt;
  expect(retained.platform).toBe("darwin");
  const { platform: _p, darwinRelease: _d, ...observed } = receipt as typeof receipt & { darwinRelease?: string };
  const { platform: _rp, darwinRelease: _rd, ...kept } = retained as typeof receipt & { darwinRelease?: string };
  expect(observed).toEqual(kept);
}, 120_000);
