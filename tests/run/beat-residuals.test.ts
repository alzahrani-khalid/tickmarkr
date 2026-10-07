import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { beat } from "../../src/cli/commands/beat.js";
import { dispatch } from "../../src/cli/index.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import {
  BEAT_CLAIM_WAIT, BEAT_GENERATION_ENV, acquireBeatClaim, beatClaimPath, beatOwnerPath, defaultBeatDeps, readProcessIdentity, releaseBeatClaim, withLegacyClaim,
  type BeatLifecycleDeps, type IdentityHost, type ProcessIdentity,
} from "../../src/run/beat-lifecycle.js";
import { supervisionArmPath, supervisionBeatPath, supervisionStandDownPath, supervisionStatus, type SupervisionTier } from "../../src/run/supervision.js";

// v2.6.8 T5 closed beat residual tables, driven through dispatch -> registered beat -> beat-lifecycle with owned
// fixture processes; failures are injected at the production boundaries (identity, kill, sleep, lsof binary).
// Row                                              | Required CLI consequence / false-clean discriminator
// teardown argv [comm] (same birth/group/cwd)      | UNREADABLE before any signal; complete read or death decides
// foreign birth / full argv / cwd                  | MISMATCH, nothing signalled or removed
// legacy unowned arm, recorded seat S (pid N)      | `tickmarkr beat <tier> --seat <S> --stand-down` (+ "stop pid N first")
// legacy arm with no seat / foreign owner          | refused, no invented seat, no recipe, no signal
// claim holder ESRCH                               | exact claim reclaimed with notice; live/unreadable/replaced: BUSY
// status / --status over a dead claim or leftovers | no file changes; nonzero; dead pids + the printed stop recovers
// recovery/release taker SIGKILLed at each step    | next start/stop/legacy write recovers with notice; live taker: BUSY
// claimant linked into a live taker's gap          | withdraws its own claim with its BUSY (a bridge caller holds nothing)
// its linked bytes locked/moved by a mistaken taker | its strand: its next write withdraws or discards it; its status names it
// dead or abandoned (unbound) owned generation     | start retires it and reaches ARMED; stop / legacy --stand-down DISARMED
// 12 one-shots / stop inside a held tick           | wait the 20 x 250 ms policy, then exit 0; held through 20: BUSY
// child dies mid-read / final read-back            | "died before its beat read back", no signal
// live unreadable child / Darwin lsof missing      | UNREADABLE naming the cause; restored lsof restores start/status/stop
// claim replaced at any boundary or temp file      | owner, arm, beat and marker land nothing further (supervision staged); nonzero
// rival recovery at every claim read               | inside a claimed act: BUSY, the act lands; else every record, signal, spawn frozen
// owner + arm replaced inside any staged write     | replacement kept exactly; nothing further committed; nonzero
// launch claim: launcher dead, its writer alive    | recovery and stop BUSY (never stolen); writer releases it when settled (not stranded)

// The rename boundary, so a claimant can be placed inside a claim removal's move/put-back gap; the read boundary, so
// one claim read can see a transient claim or be followed by a replacement; the write boundary, so a claim can be
// replaced right after a publication's temporary file is written.
const fsHooks = vi.hoisted(() => ({
  rename: undefined as ((from: string, to: string, move: () => void) => void) | undefined,
  read: undefined as ((path: string, real: () => unknown) => unknown) | undefined,
  write: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = ((from: PathLike, to: PathLike) => fsHooks.rename
    ? fsHooks.rename(String(from), String(to), () => actual.renameSync(from, to)) : actual.renameSync(from, to)) as typeof actual.renameSync;
  const readFileSync = ((path: PathLike, ...rest: unknown[]) => {
    const real = () => (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    return fsHooks.read ? fsHooks.read(String(path), real) : real();
  }) as typeof actual.readFileSync;
  const writeFileSync = ((path: PathLike, ...rest: unknown[]) => {
    (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
    fsHooks.write?.(String(path));
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, renameSync, readFileSync, writeFileSync }, renameSync, readFileSync, writeFileSync };
});

const ROOT = join(import.meta.dirname, "../..");
const TSX = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const CLI = [process.execPath, "--import", TSX, join(ROOT, "src/cli/index.ts")];

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

const mkRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-beat-residual-")));
  mkdirSync(join(repo, ".git"));
  tickmarkrDir(repo);
  return repo;
};
const env = () => { const e = { ...process.env }; delete e[BEAT_GENERATION_ENV]; return e; };
const deps = (over: Partial<BeatLifecycleDeps> = {}, host: IdentityHost = {}): BeatLifecycleDeps => ({
  ...defaultBeatDeps(host), cli: CLI, env: env(),
  spawn: (command, args, options) => { const child = spawn(command, args, options); spawned.push(child); return child; },
  ...over,
});
const run = (repo: string, argv: string[], d: BeatLifecycleDeps = deps()) => dispatch("beat", argv, { beat: (a) => beat(a, repo, d) });
const put = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
const bytes = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
const owner = (repo: string, tier: SupervisionTier) => JSON.parse(readFileSync(beatOwnerPath(repo, tier), "utf8")) as { pid: number; generation: string };
const alive = (pid: number) => readProcessIdentity(pid) !== "DEAD";
/** Synchronise on a recorded filesystem/process event; the deadline is only a safety ceiling. */
const until = async (event: () => boolean, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!event()) {
    if (Date.now() > deadline) throw new Error("event never recorded");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const killAndReap = async (child: ChildProcess) => {
  child.kill("SIGKILL");
  await until(() => child.exitCode !== null || child.signalCode !== null);
};
/** Kill a pid and return only once the kernel confirms it (ESRCH or a zombie) — a process event, not a delay. */
const killConfirmed = (pid: number) => spawnSync("/bin/sh", ["-c",
  `kill -9 ${pid}; while kill -0 ${pid} 2>/dev/null && [ "$(ps -o stat= -p ${pid} | cut -c1)" != Z ]; do :; done`]);

const protectedState = (repo: string) => [beatOwnerPath(repo, "overseer"), supervisionArmPath(repo, "overseer"),
  supervisionBeatPath(repo, "overseer"), supervisionStandDownPath(repo, "overseer")].map(bytes);
const stagesLeft = (repo: string) => readdirSync(dirname(beatClaimPath(repo, "overseer"))).filter((name) => name.includes(".stage."));
const reclaimLeftovers = (repo: string) => readdirSync(dirname(beatClaimPath(repo, "overseer"))).filter((name) => name.includes(".reclaim"));
/** Removal locks, act markers and stage directories: every one is gone once an invocation ends. */
const claimLeftovers = (repo: string) => readdirSync(dirname(beatClaimPath(repo, "overseer"))).filter((name) => /\.(reclaim|act|stage)\./.test(`${name}.`));
/** Every entry under the supervision directory with its bytes and mtime: a status read leaves it identical. */
const tree = (repo: string) => {
  const dir = dirname(beatClaimPath(repo, "overseer"));
  return readdirSync(dir, { recursive: true }).map(String).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return [name, stat.isDirectory() ? "dir" : [readFileSync(join(dir, name), "utf8"), stat.mtimeMs]];
  });
};

// A real compliant taker or writer this test owns, held at ONE step: `recover` takes the dead claim at the claim path,
// `release` takes then releases its own, `write` is a legacy one-shot. Steps: acts (waiting out a live act), lock (lock
// held, before the move-aside), moved (after it), putback (after putting back bytes swapped in, before the lock's
// removal), commit (between a staged write and its commit), assemble (its lock directory made, before its owner entry),
// released (its owner entry moved out, before the emptied lock's removal). It writes `paused.<pid>` there — holding its
// birth as its runtime recorded it — and blocks until killed. `mistaken` is a recovery taker whose identity reader proves every pid dead — the most hostile compliant taker.
const TAKER = `
import fs from "node:fs"; import { createHash } from "node:crypto"; import { syncBuiltinESMExports } from "node:module";
const [root, repo, mode, step] = process.argv.slice(1);
const l = await import(root + "/src/run/beat-lifecycle.ts");
const claim = l.beatClaimPath(repo, "overseer");
const { renameSync, mkdirSync } = fs; const wait = Atomics.wait;
const hold = () => { fs.writeFileSync(repo + "/paused." + process.pid, String(performance.timeOrigin)); for (;;) wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
fs.renameSync = (from, to) => {
  const moving = from === claim && to.includes(".reclaim/claim.");
  if ((moving && step === "lock") || (step === "commit" && from.includes(".stage.") && !to.includes(".stage."))) hold();
  if (moving && step === "putback") fs.writeFileSync(claim, JSON.stringify({ tier: "overseer", token: "swapped", pid: process.pid }) + "\\n");
  renameSync(from, to);
  if ((moving && step === "moved") || (step === "putback" && to === claim) || (step === "released" && from.includes(".reclaim/owner."))) hold();
};
fs.mkdirSync = (path, ...a) => {
  const made = mkdirSync(path, ...a);
  if (step === "assemble" && String(path).includes(".reclaim.") && String(path).endsWith(".tmp")) hold();
  return made;
};
Atomics.wait = (...a) => step === "acts" && a[3] === 10 ? hold() : wait(...a);
syncBuiltinESMExports();
if (mode === "write") await (await import(root + "/src/cli/commands/beat.ts")).beat(["overseer", "--seat", "s"], repo, l.defaultBeatDeps());
else if (mode === "recover") l.acquireBeatClaim(repo, "overseer", "taker", l.defaultBeatDeps());
else if (mode === "mistaken") l.acquireBeatClaim(repo, "overseer", "mistaken", { ...l.defaultBeatDeps(), identity: () => "DEAD" });
else {
  l.acquireBeatClaim(repo, "overseer", "taker");
  const own = fs.readFileSync(claim, "utf8");
  if (step === "acts") fs.writeFileSync(claim + "." + createHash("sha256").update(own).digest("hex").slice(0, 16) + ".act." + process.ppid + ".fixture", "");
  l.releaseBeatClaim(repo, "overseer", "taker");
}`;
type TakerMode = "recover" | "release" | "write" | "mistaken";
const spawnTaker = (repo: string, mode: TakerMode, step: string) => {
  const child = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", TAKER, ROOT, repo, mode, step], { stdio: "ignore", env: env() });
  spawned.push(child);
  return child;
};
async function pausedTaker(repo: string, mode: TakerMode, step: string) {
  const child = spawnTaker(repo, mode, step);
  await until(() => existsSync(join(repo, `paused.${child.pid}`)) || child.exitCode !== null);
  expect([mode, step, child.exitCode]).toEqual([mode, step, null]);
  return child;
}

/**
 * Displace the tier claim at the k-th production boundary call (identity, now, sleep) of one CLI invocation and
 * freeze the protected records, signals and spawns at that instant: from then on the invocation must write, spawn,
 * signal and remove nothing, and refuse. Undefined once k is past the invocation's last boundary call.
 */
async function displacedAt(k: number, repo: string, argv: string[], over: Partial<BeatLifecycleDeps> = {}) {
  const claim = beatClaimPath(repo, "overseer");
  const replacement = JSON.stringify({ tier: "overseer", token: "replacement", pid: process.pid }) + "\n";
  const acts = { kills: 0, spawns: 0 };
  let calls = 0;
  let frozen: [Array<string | undefined>, typeof acts] | undefined;
  const at = <T>(real: () => T): T => {
    if (++calls === k) { put(claim, replacement); frozen = [protectedState(repo), { ...acts }]; }
    return real();
  };
  const base = deps(over);
  const result = await run(repo, argv, {
    ...base, identity: (p) => at(() => base.identity(p)), now: () => at(() => base.now()), sleep: (ms) => at(() => base.sleep(ms)),
    kill: (p, signal) => { acts.kills++; base.kill(p, signal); },
    spawn: (command, args, options) => { acts.spawns++; return base.spawn(command, args, options); },
  });
  if (!frozen) return undefined;
  expect(result.code).toBe(1);
  expect([protectedState(repo), acts]).toEqual(frozen);
  expect(bytes(claim)).toBe(replacement);
  return result.out;
}

/** A launch child carrying start's argv, for which the test writes the arm and advancing beat a beating child would. */
const launchFixture = (repo: string, detached: boolean): Partial<BeatLifecycleDeps> => ({
  spawn: (_command, args, options) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { ...options, detached });
    spawned.push(child);
    const arm = { armId: args[args.indexOf("--arm-id") + 1], armEpoch: new Date().toISOString(), markerFence: "NONE" };
    put(supervisionArmPath(repo, "overseer"), JSON.stringify(arm) + "\n");
    put(supervisionBeatPath(repo, "overseer"), JSON.stringify({ tier: "overseer", seat: "s", ...arm, pid: child.pid, beatAt: new Date().toISOString() }) + "\n");
    return child;
  },
});

/** A real process this test owns that never beats, recorded as the tier's owned generation. */
async function ownedFixture(repo: string, tier: SupervisionTier, seat: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "gen-fixture"], { cwd: repo, detached: true, stdio: "ignore" });
  spawned.push(child);
  await until(() => typeof readProcessIdentity(child.pid!) === "object");
  const id = readProcessIdentity(child.pid!) as ProcessIdentity;
  recordOwner(repo, tier, seat, child.pid!, id);
  return { child, pid: child.pid!, id };
}

/** Record `pid` (identity `id`) as the tier's owned, bound generation "gen-fixture". */
function recordOwner(repo: string, tier: SupervisionTier, seat: string, pid: number, id: ProcessIdentity) {
  const armEpoch = new Date().toISOString();
  put(supervisionArmPath(repo, tier), JSON.stringify({ armId: "gen-fixture", armEpoch, markerFence: "NONE" }) + "\n");
  put(beatOwnerPath(repo, tier), JSON.stringify({
    tier, seat, generation: "gen-fixture", armId: "gen-fixture", cwd: repo, startedAt: new Date().toISOString(), armEpoch,
    pid, birth: id.birth, command: id.command, pgid: id.pgid,
  }) + "\n");
}

/** A Darwin-shaped lsof: `fail` names a pid it cannot read, `doom` a pid it kills between ps and the cwd read. */
function lsofFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-lsof-"));
  const bin = join(dir, "lsof"); const fail = join(dir, "fail"); const doom = join(dir, "doom");
  const real = spawnSync("/bin/sh", ["-c", "command -v lsof"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(bin, `#!/bin/sh
pid="$3"
if [ -f '${fail}' ] && [ "$(cat '${fail}')" = "$pid" ]; then exit 1; fi
if [ -f '${doom}' ] && [ "$(cat '${doom}')" = "$pid" ]; then
  rm -f '${doom}'; kill -9 "$pid"
  while kill -0 "$pid" 2>/dev/null && [ "$(ps -o stat= -p "$pid" | cut -c1)" != Z ]; do :; done
  exit 1
fi
if [ -d /proc/self ]; then printf 'p%s\\nfcwd\\nn%s\\n' "$pid" "$(readlink "/proc/$pid/cwd")"; exit 0; fi
exec ${real ? `'${real}'` : "false"} "$@"
`);
  chmodSync(bin, 0o755);
  return { bin, fail, doom, missing: join(dir, "absent-lsof") };
}

test("test: production beat pre-signal readers treat Linux teardown argv as unknown versus a genuine foreign identity in the closed beat table", async () => {
  const repo = mkRepo();
  const { pid, id } = await ownedFixture(repo, "overseer", "s");
  const kills: Array<[number, string]> = [];
  const kill = (p: number, signal: NodeJS.Signals) => { kills.push([p, signal]); process.kill(p, signal); };
  const seen = (shape: (real: ProcessIdentity) => ProcessIdentity) => deps({ kill, identity: (p) => p === pid ? shape(id) : readProcessIdentity(p) });
  const teardown = (real: ProcessIdentity) => ({ ...real, command: "[node]" });
  const ownerBytes = bytes(beatOwnerPath(repo, "overseer"));
  // Teardown argv beside the same birth, group and cwd: status, repeat-start and stop read UNKNOWN, never MISMATCH.
  for (const verb of ["status", "start", "stop"]) {
    const result = await run(repo, [verb, "overseer", "--seat", "s"], seen(teardown));
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining(`UNREADABLE — identity of recorded pid ${pid} is unreadable (pid ${pid} shows teardown argv [node]`) });
    expect(result.out).not.toContain("MISMATCH");
  }
  // Genuine foreign identities — birth, full argv or cwd changed — still refuse MISMATCH with no signal or removal.
  const foreign = [
    (real: ProcessIdentity) => ({ ...real, birth: "Thu Jan  1 00:00:00 1970", command: "[node]" }),
    (real: ProcessIdentity) => ({ ...real, command: "node another-program" }),
    (real: ProcessIdentity) => ({ ...real, command: "[node]", cwd: "/" }),
  ];
  for (const shape of foreign) {
    for (const verb of ["status", "start", "stop"]) {
      expect(await run(repo, [verb, "overseer", "--seat", "s"], seen(shape)))
        .toMatchObject({ code: 1, out: expect.stringContaining(`MISMATCH — recorded pid ${pid} now belongs to another process`) });
    }
  }
  expect(kills).toEqual([]);
  expect(bytes(beatOwnerPath(repo, "overseer"))).toBe(ownerBytes);
  expect(existsSync(supervisionStandDownPath(repo, "overseer"))).toBe(false);
  expect(alive(pid)).toBe(true);
  // A complete read decides: the same never-beating process reads STALE, not UNREADABLE.
  expect(await run(repo, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 1, out: expect.stringContaining(`STALE (s) — detached pid ${pid} is alive`) });

  // stop's live recheck after stand-down: teardown then confirmed death needs no signal; teardown then a complete read signals.
  for (const dies of [true, false]) {
    const after = mkRepo();
    const fixture = await ownedFixture(after, "overseer", "s");
    let reads = 0;
    const result = await run(after, ["stop", "overseer", "--seat", "s"], deps({
      kill,
      identity: (p) => {
        if (p !== fixture.pid || !existsSync(supervisionStandDownPath(after, "overseer")) || reads++ > 0) return readProcessIdentity(p);
        if (dies) killConfirmed(p);
        return teardown(fixture.id);
      },
    }));
    expect(result).toMatchObject({ code: 0, out: expect.stringContaining(dies ? `pid ${fixture.pid} exited on its stand-down` : `retired detached pid ${fixture.pid}`) });
    expect(kills.filter(([p]) => p === fixture.pid)).toEqual(dies ? [] : [[fixture.pid, "SIGTERM"]]);
    expect(supervisionStatus(after, "overseer").state).toBe("DISARMED");
    expect(existsSync(beatOwnerPath(after, "overseer"))).toBe(false);
  }

  // The barrier holds across the wait: teardown resolves to a complete read, and a replacement generation and arm
  // queued before the wait's await resumes is caught by the fresh barrier — the earlier authorisation signals nothing.
  const raced = mkRepo();
  const racedFixture = await ownedFixture(raced, "overseer", "s");
  const replacement = JSON.stringify({ ...JSON.parse(bytes(beatOwnerPath(raced, "overseer"))!), generation: "gen-replacement", armId: "arm-replacement" }) + "\n";
  let afterStandDown = 0;
  const barrier = await run(raced, ["stop", "overseer", "--seat", "s"], deps({
    kill,
    identity: (p) => {
      if (p !== racedFixture.pid || !existsSync(supervisionStandDownPath(raced, "overseer"))) return readProcessIdentity(p);
      if (++afterStandDown === 1) return teardown(racedFixture.id);
      if (afterStandDown === 2) {
        queueMicrotask(() => {
          put(supervisionArmPath(raced, "overseer"), JSON.stringify({ armId: "arm-replacement", armEpoch: new Date().toISOString(), markerFence: "NONE" }) + "\n");
          put(beatOwnerPath(raced, "overseer"), replacement);
        });
      }
      return readProcessIdentity(p);
    },
  }));
  expect(barrier.code).toBe(1);
  expect(barrier.out).not.toContain("DISARMED");
  expect(afterStandDown).toBeGreaterThanOrEqual(3); // the fresh read after the await ran
  expect(kills.filter(([p]) => p === racedFixture.pid)).toEqual([]);
  expect(bytes(beatOwnerPath(raced, "overseer"))).toBe(replacement);
  expect(alive(racedFixture.pid)).toBe(true);

  // Initial proof: a just-launched child showing teardown argv is unproven — UNREADABLE, never signalled.
  const initial = mkRepo();
  let first = true;
  const unproven = await run(initial, ["start", "overseer", "--seat", "s"], deps({
    kill, identity: (p) => {
      const real = readProcessIdentity(p);
      if (p === process.pid || !first || typeof real !== "object") return real;
      first = false;
      return teardown(real);
    },
  }));
  expect(unproven).toMatchObject({ code: 1, out: expect.stringContaining("shows teardown argv [node]") });
  expect(unproven.out).toContain("not signalled");
  const launched = spawned.at(-1)!;
  expect(kills.filter(([p]) => p === launched.pid)).toEqual([]);

  // Rollback (a same-session child is refused): teardown before its signal waits for death or a complete read.
  for (const dies of [true, false]) {
    const rolled = mkRepo();
    let child: ChildProcess | undefined;
    let reads = 0;
    const result = await run(rolled, ["start", "overseer", "--seat", "s"], deps({
      kill,
      // A same-session child carrying the launch argv that never arms: the rollback is the only actor on it.
      spawn: (_command, args, options) => {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { ...options, detached: false });
        spawned.push(child);
        return child;
      },
      identity: (p) => {
        const real = readProcessIdentity(p);
        if (p !== child?.pid || ++reads !== 2 || typeof real !== "object") return real;
        if (dies) killConfirmed(p);
        return teardown(real);
      },
    }));
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining("is not detached") });
    expect(result.out).toContain("rolled back this generation only");
    expect(kills.filter(([p]) => p === child!.pid)).toEqual(dies ? [] : [[child!.pid, "SIGTERM"]]);
    expect(existsSync(beatOwnerPath(rolled, "overseer"))).toBe(false);
  }
}, 120_000);

test("test: production beat start prints the recorded-seat legacy exit and migration reaches ARMED versus a missing-seat or foreign owner", async () => {
  const repo = mkRepo();
  const recipe = "`tickmarkr beat overseer --seat legacy:seat --stand-down`";
  // A pre-lifecycle --loop writer this test owns independently of tickmarkr.
  const legacy = spawn(CLI[0], [...CLI.slice(1), "beat", "overseer", "--seat", "legacy:seat", "--loop"], { cwd: repo, stdio: "ignore", env: env() });
  spawned.push(legacy);
  await until(() => {
    try { return JSON.parse(readFileSync(supervisionBeatPath(repo, "overseer"), "utf8")).pid === legacy.pid; } catch { return false; }
  });
  const kills: number[] = [];
  const watched = deps({ kill: (p, signal) => { kills.push(p); process.kill(p, signal); } });
  const live = await run(repo, ["start", "overseer", "--seat", "new:seat"], watched);
  expect(live.code).toBe(1);
  expect(live.out).toContain(`stop pid ${legacy.pid} first`);
  expect(live.out).toContain(recipe);
  expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(false);
  expect(alive(legacy.pid!)).toBe(true); // tickmarkr claims no signal authority over a writer it did not launch
  expect((await run(repo, ["status", "overseer"], watched)).out).toContain(recipe);
  // The fixture retires only its own child; the dead writer's refusal is the bare recorded-seat exit.
  await killAndReap(legacy);
  const dead = await run(repo, ["start", "overseer", "--seat", "new:seat"], watched);
  expect(dead.code).toBe(1);
  expect(dead.out).toContain(recipe);
  expect(dead.out).not.toContain("stop pid");
  // Execute the printed recipe as written, then start owns the tier with a new advancing generation.
  const printed = /`tickmarkr beat ([^`]+)`/.exec(dead.out)![1].split(" ");
  expect(await run(repo, printed, watched)).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED") });
  expect(await run(repo, ["start", "overseer", "--seat", "new:seat"], watched)).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as new:seat") });
  const started = owner(repo, "overseer");
  spawned.push({ pid: started.pid } as ChildProcess);
  expect(await run(repo, ["status", "overseer", "--seat", "new:seat"], watched))
    .toMatchObject({ code: 0, out: `overseer ARMED (new:seat) — detached pid ${started.pid}, generation ${started.generation}` });
  expect(started.pid).not.toBe(legacy.pid);
  expect(kills).toEqual([]);

  // A legacy writer stopped INSIDE its claimed tick does not strand the printed step. A real --loop writer is held in
  // its claimed tick (its ownership read blocks on a FIFO the fixture puts at the owner path): while it lives, the
  // printed --stand-down waits and refuses BUSY with its claim untouched — a live claim is never taken; killed there,
  // it leaves that claim behind, which the same printed step reclaims with the notice before standing the tier down.
  const stranded = mkRepo();
  const writer = spawn(CLI[0], [...CLI.slice(1), "beat", "overseer", "--seat", "legacy:seat", "--loop"], { cwd: stranded, stdio: "ignore", env: env() });
  spawned.push(writer);
  const recordedBy = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")).pid === writer.pid; } catch { return false; } };
  await until(() => recordedBy(supervisionBeatPath(stranded, "overseer")));
  const advice = await run(stranded, ["start", "overseer", "--seat", "new:seat"], watched);
  expect(advice.out).toContain(`stop pid ${writer.pid} first`);
  expect(advice.out).toContain(recipe);
  const step = /`tickmarkr beat ([^`]+)`/.exec(advice.out)![1].split(" ");
  const strandedClaim = beatClaimPath(stranded, "overseer");
  expect(spawnSync("mkfifo", [beatOwnerPath(stranded, "overseer")]).status).toBe(0);
  await until(() => recordedBy(strandedClaim)); // its next tick took the claim and is blocked inside it
  const heldClaim = bytes(strandedClaim);
  const waited = await run(stranded, step, deps({ sleep: async () => {} }));
  expect(waited).toMatchObject({ code: 1, out: expect.stringContaining(`overseer BUSY — pid ${writer.pid} holds`) });
  expect(waited.out).toContain("still held after 20 attempts");
  expect(waited.out).not.toContain("reclaimed");
  expect(bytes(strandedClaim)).toBe(heldClaim);
  expect(existsSync(supervisionStandDownPath(stranded, "overseer"))).toBe(false);
  await killAndReap(writer);
  expect(bytes(strandedClaim)).toBe(heldClaim); // killed holding it
  rmSync(beatOwnerPath(stranded, "overseer")); // the fixture's FIFO, never tickmarkr state
  const migrated = await run(stranded, step, watched);
  expect(migrated).toMatchObject({ code: 0, out: expect.stringContaining(`overseer reclaimed the claim of dead pid ${writer.pid}`) });
  expect(migrated.out).toContain("overseer DISARMED — legacy:seat handed off");
  expect(existsSync(strandedClaim)).toBe(false);
  expect(await run(stranded, ["start", "overseer", "--seat", "new:seat"], watched)).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as new:seat") });
  spawned.push({ pid: owner(stranded, "overseer").pid } as ChildProcess);
  expect(kills).toEqual([]);
  // POSITIVE COMPATIBILITY CONTROL: the unchanged old-format {tier, token, pid, claimedAt} bytes a pre-2.6.8 legacy
  // writer publishes, left by its real process killed holding them, are reclaimed by the same printed step on
  // confirmed death alone — no birth is required of the legacy schema.
  const oldFormat = mkRepo();
  const oldClaim = beatClaimPath(oldFormat, "overseer");
  mkdirSync(dirname(oldClaim), { recursive: true });
  const oldWriter = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify({ tier: 'overseer', token: 'legacy', " +
    "pid: process.pid, claimedAt: new Date().toISOString() }) + '\\n'); setInterval(() => {}, 1000)", oldClaim], { stdio: "ignore" });
  spawned.push(oldWriter);
  await until(() => existsSync(oldClaim));
  const oldBytes = bytes(oldClaim)!;
  expect(Object.keys(JSON.parse(oldBytes))).toEqual(["tier", "token", "pid", "claimedAt"]);
  await killAndReap(oldWriter);
  expect(bytes(oldClaim)).toBe(oldBytes);
  const oldMigrated = await run(oldFormat, step, watched);
  expect(oldMigrated).toMatchObject({ code: 0, out: expect.stringContaining(`overseer reclaimed the claim of dead pid ${oldWriter.pid} (token legacy)`) });
  expect(oldMigrated.out).toContain("overseer DISARMED — legacy:seat handed off");
  expect(existsSync(oldClaim)).toBe(false);

  // A recorded seat beginning with a dash rides the --seat=<seat> form, and that printed step executes as written.
  const dashed = mkRepo();
  expect((await run(dashed, ["overseer", "--seat=--legacy"], watched)).code).toBe(0);
  const dashExit = await run(dashed, ["start", "overseer", "--seat", "new:seat"], watched);
  expect(dashExit.code).toBe(1);
  expect(dashExit.out).toContain("`tickmarkr beat overseer --seat=--legacy --stand-down`");
  const dashStep = /`tickmarkr beat ([^`]+)`/.exec(dashExit.out)![1].split(" ");
  expect(await run(dashed, dashStep, watched)).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED — --legacy handed off") });
  expect(await run(dashed, ["start", "overseer", "--seat", "new:seat"], watched)).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as new:seat") });
  spawned.push({ pid: owner(dashed, "overseer").pid } as ChildProcess);

  // Missing seat: a seatless legacy arm gets no invented seat and no recipe.
  const seatless = mkRepo();
  put(supervisionBeatPath(seatless, "watch"), JSON.stringify({ tier: "watch", beatAt: new Date().toISOString(), exitedWriterPid: 4242 }) + "\n");
  const noSeat = await run(seatless, ["start", "watch", "--seat", "caller"], watched);
  expect(noSeat).toMatchObject({ code: 1, out: expect.stringContaining("recorded no seat — none is invented") });
  expect(noSeat.out).not.toContain("--stand-down");
  expect(existsSync(beatOwnerPath(seatless, "watch"))).toBe(false);
  // Foreign owner: refused without a recipe and without any signal.
  const foreignRepo = mkRepo();
  const other = await ownedFixture(foreignRepo, "overseer", "other");
  const foreignStart = await run(foreignRepo, ["start", "overseer", "--seat", "s"], watched);
  expect(foreignStart).toMatchObject({ code: 1, out: expect.stringContaining("MISMATCH — owned by seat other, not s") });
  expect(foreignStart.out).not.toContain("--stand-down");
  expect(alive(other.pid)).toBe(true);
  expect(kills).toEqual([]);
}, 120_000);

test("test: production beat start/stop/legacy writers reclaim the exact dead claim and recover a killed compliant recovery taker with notice versus a file-preserving status read or a live unreadable or compliant-contender-held claim", async () => {
  const deadPid = () => {
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    return Number(gone.stdout);
  };
  const claimOf = (pid: unknown, token = "dead-token") => JSON.stringify({ tier: "overseer", token, pid, claimedAt: new Date().toISOString() }) + "\n";
  const repo = mkRepo();
  const corpse = deadPid();
  put(beatClaimPath(repo, "overseer"), claimOf(corpse));
  const started = await run(repo, ["start", "overseer", "--seat", "s"]);
  expect(started).toMatchObject({ code: 0, out: expect.stringContaining(`overseer reclaimed the claim of dead pid ${corpse} (token dead-token)`) });
  expect(started.out).toContain("ARMED as s");
  spawned.push({ pid: owner(repo, "overseer").pid } as ChildProcess);
  expect(existsSync(beatClaimPath(repo, "overseer"))).toBe(false);
  const stopCorpse = deadPid();
  put(beatClaimPath(repo, "overseer"), claimOf(stopCorpse, "stop-dead"));
  // STATUS-PURE: both spellings over the dead claim change no file, exit nonzero naming the dead holder and the exact
  // recovery command, and that printed command, executed verbatim, is what recovers.
  const before = tree(repo);
  let printed: string[] = [];
  for (const argv of [["status", "overseer", "--seat", "s"], ["overseer", "--seat", "s", "--status"]]) {
    const read = await run(repo, argv);
    expect(read).toMatchObject({ code: 1, out: expect.stringContaining(`BUSY (claim held by dead pid ${stopCorpse})`) });
    expect(read.out).toContain("`tickmarkr beat stop overseer --seat s` to recover it (status reports, never recovers)");
    expect(tree(repo)).toEqual(before);
    printed = /`tickmarkr beat ([^`]+)`/.exec(read.out)![1].split(" ");
  }
  const stopped = await run(repo, printed);
  expect(stopped).toMatchObject({ code: 0, out: expect.stringContaining(`reclaimed the claim of dead pid ${stopCorpse} (token stop-dead)`) });
  expect(stopped.out).toContain("DISARMED");
  // Every legacy write reclaims the same way — the printed --stand-down migration step included — and the notice
  // leads its result, or its refusal when the tier then refuses that writer.
  for (const [argv, outcome] of [
    [["overseer", "--seat", "s", "--stand-down"], "overseer DISARMED — s handed off"],
    [["overseer", "--seat", "s"], "overseer ARMED as s"], [["overseer", "--seat", "s", "--new-arm"], "overseer ARMED as s"],
  ] as const) {
    const legacyRepo = mkRepo();
    const legacyCorpse = deadPid();
    put(beatClaimPath(legacyRepo, "overseer"), claimOf(legacyCorpse, "legacy-dead"));
    const result = await run(legacyRepo, [...argv]);
    expect(result).toMatchObject({ code: 0, out: expect.stringContaining(`overseer reclaimed the claim of dead pid ${legacyCorpse} (token legacy-dead)`) });
    expect(result.out).toContain(outcome);
    expect(existsSync(beatClaimPath(legacyRepo, "overseer"))).toBe(false);
  }
  const ownedTier = mkRepo();
  await ownedFixture(ownedTier, "overseer", "other");
  const ownedCorpse = deadPid();
  put(beatClaimPath(ownedTier, "overseer"), claimOf(ownedCorpse, "owned-dead"));
  const refusedStandDown = await run(ownedTier, ["overseer", "--seat", "s", "--stand-down"]);
  expect(refusedStandDown).toMatchObject({ code: 1, out: expect.stringContaining(`overseer reclaimed the claim of dead pid ${ownedCorpse}`) });
  expect(refusedStandDown.out).toContain("owned by a detached beat");
  expect(existsSync(supervisionStandDownPath(ownedTier, "overseer"))).toBe(false);

  // Live holder, an unreadable identity, and every malformed pid stay BUSY with the claim bytes untouched — for every
  // claimant: start, stop and each legacy write.
  const claimants = [["start", "overseer", "--seat", "s"], ["stop", "overseer", "--seat", "s"], ["overseer", "--seat", "s"],
    ["overseer", "--seat", "s", "--new-arm"], ["overseer", "--seat", "s", "--stand-down"]];
  const held = mkRepo();
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(holder);
  const fast = { sleep: async () => {} };
  const rows: Array<[string, BeatLifecycleDeps, string]> = [
    [claimOf(holder.pid, "live"), deps(fast), `pid ${holder.pid} holds`],
    [claimOf(deadPid(), "blind"), deps({ ...fast, identity: () => "UNKNOWN" }), "holds"],
    ...[0, -1, 1.5, "7", null].map((pid): [string, BeatLifecycleDeps, string] => [claimOf(pid, "malformed"), deps(fast), "an unreadable claim occupies"]),
    [JSON.stringify({ tier: "overseer", token: "no-pid" }) + "\n", deps(fast), "an unreadable claim occupies"],
  ];
  for (const [claim, d, why] of rows) {
    for (const argv of claimants) {
      put(beatClaimPath(held, "overseer"), claim);
      const result = await run(held, argv, d);
      expect(result).toMatchObject({ code: 1, out: expect.stringContaining(why) });
      expect(result.out).toContain("BUSY");
      expect(result.out).not.toContain("reclaimed");
      expect(bytes(beatClaimPath(held, "overseer"))).toBe(claim);
    }
  }
  expect(protectedState(held)).toEqual([undefined, undefined, undefined, undefined]);
  // A claim replaced between the death check and the removal is put back, never removed.
  const replaced = mkRepo();
  const replacement = claimOf(holder.pid, "replacement");
  for (const argv of claimants) {
    const corpsePid = deadPid();
    put(beatClaimPath(replaced, "overseer"), claimOf(corpsePid));
    const result = await run(replaced, argv, deps({
      ...fast,
      identity: (p) => {
        if (p === corpsePid) put(beatClaimPath(replaced, "overseer"), replacement);
        return readProcessIdentity(p);
      },
    }));
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining("BUSY") });
    expect(result.out).not.toContain("reclaimed");
    expect(bytes(beatClaimPath(replaced, "overseer"))).toBe(replacement);
  }
  // Live A, a transient dead B at exactly ONE claim read, then A again. Wherever B lands — the claimant's own-token
  // check, the recoverer's snapshot, or the read right after it — the death that authorises a removal is proven for
  // the pid inside the checked bytes, so live A is never removed, through start, stop and the --stand-down step alike.
  const transient = mkRepo();
  const transientClaim = beatClaimPath(transient, "overseer");
  for (const [n, argv] of [claimants[0], claimants[1], claimants[4]].entries()) { // start, stop and the --stand-down step
    for (let at = 1; at <= 6; at++) {
      const a = claimOf(holder.pid, `live-${n}-${at}`);
      const b = claimOf(deadPid(), "transient");
      put(transientClaim, a);
      let reads = 0;
      fsHooks.read = (path, real) => path === transientClaim && ++reads === at ? b : real();
      let result: Awaited<ReturnType<typeof run>>;
      try { result = await run(transient, argv, deps(fast)); } finally { fsHooks.read = undefined; }
      expect(result).toMatchObject({ code: 1, out: expect.stringContaining("BUSY") });
      expect(result.out).not.toContain("reclaimed");
      expect(bytes(transientClaim)).toBe(a);
      expect(reclaimLeftovers(transient)).toEqual([]);
    }
  }
  expect(protectedState(transient)).toEqual([undefined, undefined, undefined, undefined]);
  // A competing recovery that completes first owns the claim; the later recovery re-reads under its lock and refuses.
  const rivals = mkRepo();
  for (const [n, argv] of claimants.entries()) {
    const corpsePid = deadPid();
    put(beatClaimPath(rivals, "overseer"), claimOf(corpsePid));
    let rival: string | undefined;
    const result = await run(rivals, argv, deps({
      ...fast,
      identity: (p) => {
        if (p === corpsePid && rival === undefined) rival = acquireBeatClaim(rivals, "overseer", `rival-${n}`, deps());
        return readProcessIdentity(p);
      },
    }));
    expect(rival).toContain(`reclaimed the claim of dead pid ${corpsePid}`);
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining(`BUSY — pid ${process.pid} holds`) });
    expect(result.out).not.toContain("reclaimed");
    releaseBeatClaim(rivals, "overseer", `rival-${n}`); // still the rival's own claim
    expect(reclaimLeftovers(rivals)).toEqual([]);
  }
  // KILLED COMPLIANT TAKER: a real recovery or release taker held at each step of the one removal path. While it lives,
  // a claimant (its own CLI process) is BUSY naming it and its lock is untouched; SIGKILLed and joined, status (both
  // spellings) changes no file and names it with the recovery command, and the next start, stop or legacy write — the
  // printed stop verbatim — recovers with a notice naming it, every leftover gone and that verb's own lifecycle done.
  const lockOf = (r: string) => readdirSync(dirname(beatClaimPath(r, "overseer"))).filter((name) => name.endsWith(".reclaim"))
    .map((name) => join(dirname(beatClaimPath(r, "overseer")), name));
  const lockBytes = (r: string) => lockOf(r).map((lock) => readdirSync(lock).map((name) => [name, bytes(join(lock, name))]));
  const recovery: Array<["recover" | "release", string, string]> = [["recover", "lock", "stop"], ["recover", "moved", "start"],
    ["recover", "putback", "legacy"], ["release", "acts", "legacy"], ["release", "lock", "start"], ["release", "moved", "stop"]];
  for (const [mode, step, verb] of recovery) {
    const r = mkRepo();
    if (mode === "recover") put(beatClaimPath(r, "overseer"), claimOf(deadPid(), "killed"));
    const taker = await pausedTaker(r, mode, step);
    const held = lockBytes(r);
    // The lock names its live taker by pid and birth (its runtime's own start record) — as does its own new-format claim.
    const born = readFileSync(join(r, `paused.${taker.pid}`), "utf8");
    const entry = held[0].find(([name]) => name!.startsWith(`owner.${taker.pid}.`));
    expect([mode, step, held.length, JSON.parse(entry![1]!)]).toEqual([mode, step, 1, expect.objectContaining({ pid: taker.pid, birth: born })]);
    if (mode === "release" && step !== "moved") expect(JSON.parse(bytes(beatClaimPath(r, "overseer"))!)).toMatchObject({ pid: taker.pid, birth: born });
    const contender = spawnSync(CLI[0], [...CLI.slice(1), "beat", "start", "overseer", "--seat", "s"], { cwd: r, encoding: "utf8", env: env() });
    expect([mode, step, contender.status, contender.stderr + contender.stdout]).toEqual([mode, step, 1, expect.stringMatching(new RegExp(`BUSY — .*pid ${taker.pid}`))]);
    expect(lockBytes(r)).toEqual(held);
    await killAndReap(taker);
    if (step === "acts") rmSync(lockOf(r)[0].replace(/\.reclaim$/, `.act.${process.pid}.fixture`)); // the fixture's live act ends
    const left = tree(r);
    for (const argv of [["status", "overseer", "--seat", "s"], ["overseer", "--seat", "s", "--status"]]) {
      const read = await run(r, argv);
      expect([mode, step, read.code, tree(r)]).toEqual([mode, step, 1, left]);
      expect(read.out).toContain(`.reclaim of dead pid ${taker.pid}`);
      expect(read.out).toContain("run `tickmarkr beat stop overseer --seat s` to recover it");
    }
    const argv = { stop: ["stop", "overseer", "--seat", "s"], start: ["start", "overseer", "--seat", "s"], legacy: ["overseer", "--seat", "s"] }[verb]!;
    const recovered = await run(r, argv);
    expect([mode, step, recovered.code]).toEqual([mode, step, 0]);
    expect(recovered.out).toContain(`overseer recovered the removal lock of killed taker pid ${taker.pid}`);
    expect(recovered.out).toContain(verb === "stop" ? "overseer DISARMED" : "ARMED as s");
    if (verb === "start") spawned.push({ pid: owner(r, "overseer").pid } as ChildProcess);
    expect([mode, step, claimLeftovers(r), existsSync(beatClaimPath(r, "overseer"))]).toEqual([mode, step, [], false]);
  }
  // No ownerless instant: a removal lock first appears by the rename of a directory already holding its owner entry.
  const atomic = mkRepo();
  put(beatClaimPath(atomic, "overseer"), claimOf(deadPid(), "atomic"));
  const appeared: string[][] = [];
  fsHooks.rename = (from, to, move) => { if (to.endsWith(".reclaim")) appeared.push(readdirSync(from)); move(); };
  try { expect((await run(atomic, ["stop", "overseer", "--seat", "s"])).code).toBe(0); } finally { fsHooks.rename = undefined; }
  const ownerOnly = [expect.stringMatching(new RegExp(`^owner\\.${process.pid}\\.`))];
  expect(appeared).toEqual([ownerOnly, ownerOnly]); // the dead claim's recovery, then stop's own release
  // A claimant that linked into a live taker's gap withdraws its own claim and waits; the taker is killed during that
  // wait, and the same stop links again, recovers the lock and reads back DISARMED.
  const gapped = mkRepo();
  put(beatClaimPath(gapped, "overseer"), claimOf(deadPid(), "gapped"));
  const gapTaker = await pausedTaker(gapped, "recover", "moved");
  let waits = 0;
  const resumedStop = await run(gapped, ["stop", "overseer", "--seat", "s"], deps({ sleep: async () => { if (waits++ === 0) await killAndReap(gapTaker); } }));
  expect(resumedStop).toMatchObject({ code: 0, out: expect.stringContaining(`recovered the removal lock of killed taker pid ${gapTaker.pid} at `) });
  expect(resumedStop.out).toContain(", discarding the claim of dead pid");
  expect(resumedStop.out).toContain("overseer DISARMED — published DISARMED");
  expect([claimLeftovers(gapped), existsSync(beatClaimPath(gapped, "overseer"))]).toEqual([[], false]);
  // A release taker killed while ASSEMBLING its lock (directory made, owner entry not yet written) or while RELEASING it
  // (owner entry moved out, emptied lock not yet removed) leaves an entry named for its pid: status (both spellings)
  // changes no file and names it with the recovery command; the printed stop removes it with a notice naming that pid.
  for (const step of ["assemble", "released"]) {
    const r = mkRepo();
    const taker = await pausedTaker(r, "release", step);
    await killAndReap(taker);
    const left = tree(r);
    let printed: string[] = [];
    for (const argv of [["status", "overseer", "--seat", "s"], ["overseer", "--seat", "s", "--status"]]) {
      const read = await run(r, argv);
      expect([step, read.code, tree(r)]).toEqual([step, 1, left]);
      expect(read.out).toMatch(new RegExp(`\\.reclaim\\.${taker.pid}\\.\\S+\\.${step === "assemble" ? "tmp" : "released"} of dead pid ${taker.pid}`));
      printed = /`tickmarkr beat ([^`]+)`/.exec(read.out)![1].split(" ");
    }
    const recovered = await run(r, printed);
    expect([step, recovered.code]).toEqual([step, 0]);
    expect(recovered.out).toMatch(new RegExp(`overseer removed \\S+\\.reclaim\\.${taker.pid}\\.\\S+, left by dead pid ${taker.pid}`));
    expect(recovered.out).toContain("overseer DISARMED");
    expect([step, claimLeftovers(r), existsSync(beatClaimPath(r, "overseer"))]).toEqual([step, [], false]);
  }
  // A LIVE caller (this process, a bridge) whose start links into a live release taker's gap withdraws its own claim
  // with its BUSY — it holds nothing afterwards — so once the taker is killed, the same caller's stop recovers its lock.
  const bridge = mkRepo();
  const bridgeTaker = await pausedTaker(bridge, "release", "moved");
  const bridged = await run(bridge, ["start", "overseer", "--seat", "s"]);
  expect(bridged).toMatchObject({ code: 1, out: expect.stringContaining("overseer BUSY — a claim removal (dead-claim recovery or release) is under way at") });
  expect(existsSync(beatClaimPath(bridge, "overseer"))).toBe(false);
  await killAndReap(bridgeTaker);
  const bridgeStop = await run(bridge, ["stop", "overseer", "--seat", "s"]);
  expect(bridgeStop).toMatchObject({ code: 0, out: expect.stringContaining(`overseer recovered the removal lock of killed taker pid ${bridgeTaker.pid}`) });
  expect(bridgeStop.out).toContain("overseer DISARMED");
  expect([claimLeftovers(bridge), existsSync(beatClaimPath(bridge, "overseer"))]).toEqual([[], false]);
  // CONTESTED withdrawal: before the bridge withdraws the bytes it linked into the release taker's gap, a second live
  // compliant taker acting on a mistaken death proof takes exactly those bytes and is held — at `lock` (its lock on them,
  // before the move-aside) or at `moved` (they sit moved aside in its lock, so the bridge never sees them again). The
  // bridge refuses BUSY saying its bytes are still out and are its strand; while either taker lives its next start stays
  // BUSY with both locks untouched. Both takers killed: status (both spellings, in the bridge) changes no file and names
  // the stranded claim or dead locks with the recovery command, and that printed command, run by the SAME live caller,
  // withdraws its strand from the claim path or discards it from the dead taker's lock, recovers both locks with notices
  // naming them and reads back DISARMED — it never had to exit. `other`: another process's ordinary start recovers the
  // dead locks first, restoring the bridge's bytes to the claim path (a live holder to it) and refusing BUSY; the
  // bridge's status then names its own stranded claim and its printed stop withdraws it.
  for (const [step, first] of [["lock", "self"], ["moved", "self"], ["moved", "other"]] as const) {
    const contested = mkRepo();
    const contestedClaim = beatClaimPath(contested, "overseer");
    const releaser = await pausedTaker(contested, "release", "moved");
    let mistaken: ChildProcess | undefined;
    fsHooks.read = (path, real) => {
      const value = real();
      if (mistaken || path !== contestedClaim || JSON.parse(String(value)).pid !== process.pid) return value;
      mistaken = spawnTaker(contested, "mistaken", step); // it takes the bridge's linked bytes, then holds
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(contested, `paused.${mistaken.pid}`))) {
        if (Date.now() > deadline) throw new Error("mistaken taker never paused");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return value;
    };
    let contestedStart: Awaited<ReturnType<typeof run>>;
    try { contestedStart = await run(contested, ["start", "overseer", "--seat", "s"]); } finally { fsHooks.read = undefined; }
    expect([step, first, contestedStart.code, contestedStart.out]).toEqual([step, first, 1, expect.stringContaining("its own unsettled claim is still out at ")]);
    expect(contestedStart.out).toContain("it is this process's strand");
    const strandAt = step === "lock" ? contestedClaim : undefined;
    expect([step, first, bytes(contestedClaim) && JSON.parse(bytes(contestedClaim)!).pid]).toEqual([step, first, strandAt && process.pid]);
    const locked = lockBytes(contested);
    // NEGATIVE CONTROL while both takers live: status (both spellings, in the bridge) changes no file, exits nonzero and
    // names the bridge's strand — on the claim path under the mistaken taker's lock, or moved aside into it — with that
    // live taker, the releaser's removal under way, and the recovery command to run once the taker is gone.
    const held = tree(contested);
    for (const argv of [["status", "overseer", "--seat", "s"], ["overseer", "--seat", "s", "--status"]]) {
      const read = await run(contested, argv);
      expect([step, first, read.code, tree(contested)]).toEqual([step, first, 1, held]);
      expect(read.out).toContain(`this process's own stranded claim (token `);
      expect(read.out).toContain(`${step === "moved" ? " moved aside into " : `held by no invocation of pid ${process.pid})`}`);
      expect(read.out).toContain(`under the removal lock of live taker pid ${mistaken!.pid}`);
      expect(read.out).toContain(`a claim removal under way at `);
      expect(read.out).toContain(`by pid ${releaser.pid}`);
      expect(read.out).toContain(`run \`tickmarkr beat stop overseer --seat s\` to recover it once live taker pid ${mistaken!.pid}`);
    }
    const live = await run(contested, ["start", "overseer", "--seat", "s"]);
    expect([step, first, live.code, live.out.includes("BUSY"), lockBytes(contested)]).toEqual([step, first, 1, true, locked]);
    await killAndReap(mistaken!);
    await killAndReap(releaser);
    if (first === "other") {
      const otherStart = spawnSync(CLI[0], [...CLI.slice(1), "beat", "start", "overseer", "--seat", "s"], { cwd: contested, encoding: "utf8", env: env() });
      expect([step, first, otherStart.status, otherStart.stderr + otherStart.stdout]).toEqual([step, first, 1, expect.stringContaining(`BUSY — pid ${process.pid} holds`)]);
      expect(otherStart.stderr + otherStart.stdout).toContain(`, restoring the claim it had moved aside to ${contestedClaim}`);
    }
    const left = tree(contested);
    let printed: string[] = [];
    for (const argv of [["status", "overseer", "--seat", "s"], ["overseer", "--seat", "s", "--status"]]) {
      const read = await run(contested, argv);
      expect([step, first, read.code, tree(contested)]).toEqual([step, first, 1, left]);
      expect(read.out).toContain("run `tickmarkr beat stop overseer --seat s` to recover it");
      if (step === "lock" || first === "other") expect(read.out).toContain(`this process's own stranded claim (token `);
      if (first === "self") expect(read.out).toContain(`.reclaim of dead pid ${mistaken!.pid}`);
      printed = /`tickmarkr beat ([^`]+)`/.exec(read.out)![1].split(" ");
    }
    const contestedStop = await run(contested, printed);
    expect([step, first, contestedStop.code, contestedStop.out]).toEqual([step, first, 0, expect.stringContaining("overseer DISARMED — published DISARMED")]);
    if (first === "self") {
      expect(contestedStop.out).toContain(`overseer recovered the removal lock of killed taker pid ${mistaken!.pid}`);
      expect(contestedStop.out).toContain(`overseer recovered the removal lock of killed taker pid ${releaser.pid}`);
    }
    expect(contestedStop.out).toContain(step === "moved" && first === "self"
      ? ", discarding this process's own stranded claim (token " : "overseer withdrew this process's own stranded claim (token ");
    expect([step, first, claimLeftovers(contested), existsSync(contestedClaim)]).toEqual([step, first, [], false]);
  }
  // A DEAD OWNER through every ordinary writer: a launch abandoned when its launcher was killed after publishing the
  // owner (no pid), or killed with its child after publishing the child's pid (no arm epoch), and a fully bound
  // generation whose launcher and child are dead. Status names the recovery; start reclaims the dead launch claim,
  // retires that generation (nothing signalled) and reaches ARMED; stop reads back DISARMED; the legacy --stand-down
  // completes.
  const deadOwner = async (shape: "unpublished" | "unbound" | "bound") => {
    const r = mkRepo();
    const { child, pid, id } = await ownedFixture(r, "overseer", "s");
    const bound = JSON.parse(bytes(beatOwnerPath(r, "overseer"))!) as Record<string, unknown>;
    const { pid: _p, birth: _b, command: _c, pgid: _g, armEpoch: _e, ...unpublished } = bound;
    if (shape === "unpublished") { rmSync(supervisionArmPath(r, "overseer")); put(beatOwnerPath(r, "overseer"), JSON.stringify(unpublished) + "\n"); }
    if (shape === "unbound") put(beatOwnerPath(r, "overseer"), JSON.stringify({ ...unpublished, pid, birth: id.birth, command: id.command, pgid: id.pgid }) + "\n");
    await killAndReap(child);
    put(beatClaimPath(r, "overseer"), JSON.stringify({ tier: "overseer", token: "gen-fixture", pid: deadPid(), ...(shape === "unpublished" ? {} : { publisher: pid }) }) + "\n");
    return r;
  };
  for (const shape of ["unpublished", "unbound", "bound"] as const) {
    for (const verb of ["start", "stop", "legacy", "one-shot"] as const) {
      const r = await deadOwner(shape);
      const kills: number[] = [];
      const d = deps({ kill: (p) => { kills.push(p); } });
      const read = await run(r, ["status", "overseer", "--seat", "s"], d);
      expect([shape, verb, read.code, read.out]).toEqual([shape, verb, 1, expect.stringContaining("`tickmarkr beat stop overseer --seat s`")]);
      const argv = {
        start: ["start", "overseer", "--seat", "s"], stop: ["stop", "overseer", "--seat", "s"], legacy: ["overseer", "--seat", "s", "--stand-down"], "one-shot": ["overseer", "--seat", "s"],
      }[verb];
      const result = await run(r, argv, d);
      expect([shape, verb, result.code, result.out]).toEqual([shape, verb, 0, expect.stringContaining("overseer reclaimed the claim of dead pid")]);
      expect(result.out).toContain("overseer recovered dead generation gen-fixture");
      expect(result.out).toContain({ start: "ARMED as s", stop: "overseer DISARMED", legacy: "overseer DISARMED — s handed off", "one-shot": "overseer ARMED as s" }[verb]);
      if (verb === "start") spawned.push({ pid: owner(r, "overseer").pid } as ChildProcess);
      else {
        // The ordinary one-shot records the beat it was asked for (on the dead generation's arm, or a new initial one).
        expect([shape, verb, existsSync(beatOwnerPath(r, "overseer")), supervisionStatus(r, "overseer").state])
          .toEqual([shape, verb, false, verb === "one-shot" ? "ARMED" : "DISARMED"]);
        if (verb === "one-shot") expect(JSON.parse(bytes(supervisionBeatPath(r, "overseer"))!)).toMatchObject({ seat: "s" });
      }
      expect([shape, verb, kills, claimLeftovers(r)]).toEqual([shape, verb, [], []]);
    }
  }
  // A recorded seat with a space rides one quoted argument: the printed recovery commands execute as printed.
  const words = (command: string) => spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${command}`], { encoding: "utf8" }).stdout.split("\0").slice(0, -1);
  const spaced = mkRepo();
  const silentSeat = await ownedFixture(spaced, "overseer", "pane 1");
  const silentStart = await run(spaced, ["start", "overseer", "--seat", "pane 1"]);
  expect(silentStart).toMatchObject({ code: 1, out: expect.stringContaining("run `tickmarkr beat stop overseer --seat 'pane 1'` first") });
  expect(await run(spaced, words(/`tickmarkr beat ([^`]+)`/.exec(silentStart.out)![1])))
    .toMatchObject({ code: 0, out: expect.stringContaining(`retired detached pid ${silentSeat.pid}`) });
  const spacedDead = mkRepo();
  await killAndReap((await ownedFixture(spacedDead, "overseer", "pane 1")).child);
  const spacedStatus = await run(spacedDead, ["status", "overseer"]);
  expect(spacedStatus).toMatchObject({ code: 1, out: expect.stringContaining("run `tickmarkr beat stop overseer --seat 'pane 1'`") });
  expect(await run(spacedDead, words(/`tickmarkr beat ([^`]+)`/.exec(spacedStatus.out)![1])))
    .toMatchObject({ code: 0, out: expect.stringContaining("overseer DISARMED") });
  // An owner killed between a staged write and its commit, inside its claimed act: status names every leftover and
  // changes nothing; the next legacy write reclaims the claim, and its dead act marker and stage directory are gone.
  const crashed = mkRepo();
  const killedWriter = await pausedTaker(crashed, "write", "commit");
  await killAndReap(killedWriter);
  const crashedTree = tree(crashed);
  const report = await run(crashed, ["status", "overseer", "--seat", "s"]);
  expect([report.code, tree(crashed)]).toEqual([1, crashedTree]);
  expect(report.out).toContain("left behind: the dead claim, ");
  expect(report.out).toMatch(new RegExp(`\\.act\\.${killedWriter.pid}\\.\\S+ of dead pid ${killedWriter.pid}`));
  expect(report.out).toMatch(new RegExp(`overseer\\.stage\\.${killedWriter.pid}\\.\\S+ of dead pid ${killedWriter.pid}`));
  const rewritten = await run(crashed, ["overseer", "--seat", "s"]);
  expect(rewritten).toMatchObject({ code: 0, out: expect.stringContaining(`overseer reclaimed the claim of dead pid ${killedWriter.pid}`) });
  expect(rewritten.out).toMatch(new RegExp(`overseer removed overseer\\.stage\\.${killedWriter.pid}\\.\\S+, left by dead pid ${killedWriter.pid}`));
  expect([claimLeftovers(crashed), supervisionStatus(crashed, "overseer").state]).toEqual([[], "ARMED"]);
  // Third claimant: A becomes live B the instant before it is moved aside, and C's own CLI start/stop links into the
  // vacated canonical path before B is put back. C's claim is never settled while the recovery lock exists: C withdraws
  // exactly its own linked bytes, writes nothing, and B — the only claim anyone acted under — keeps the canonical path.
  const gap = mkRepo();
  const gapClaim = beatClaimPath(gap, "overseer");
  for (const [verb, cVerb] of [["start", "stop"], ["stop", "stop"], ["start", "start"], ["stop", "start"]]) {
    put(gapClaim, claimOf(deadPid()));
    const b = claimOf(holder.pid, `b-${verb}-${cVerb}`);
    let fired = false;
    let c: Promise<Awaited<ReturnType<typeof run>>> | undefined;
    fsHooks.rename = (from, to, move) => {
      if (fired || from !== gapClaim || !to.includes(".reclaim")) return move();
      fired = true;
      put(gapClaim, b);
      move();
      const linked: string[] = [];
      fsHooks.write = (path) => { if (path.startsWith(`${gapClaim}.`) && path.endsWith(".tmp")) linked.push(path); };
      try { c = run(gap, [cVerb, "overseer", "--seat", "c"], deps(fast)); } finally { fsHooks.write = undefined; } // links, then withdraws, synchronously
      expect(linked.length).toBeGreaterThan(0);
      expect(bytes(gapClaim)).toBeUndefined(); // withdrawn: the gap holds no claim C could leave behind
    };
    let result: Awaited<ReturnType<typeof run>>;
    try { result = await run(gap, [verb, "overseer", "--seat", "s"], deps(fast)); } finally { fsHooks.rename = undefined; }
    expect(fired).toBe(true);
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining(`BUSY — pid ${holder.pid} holds`) });
    expect(result.out).not.toContain("reclaimed");
    const cResult = await c!;
    expect(cResult.code).toBe(1);
    expect(cResult.out).toContain(cVerb === "start" ? "overseer BUSY — a claim removal (dead-claim recovery or release) is under way" : `overseer BUSY — pid ${holder.pid} holds`);
    expect(cResult.out).not.toContain("DISARMED");
    expect(protectedState(gap)).toEqual([undefined, undefined, undefined, undefined]);
    expect(bytes(gapClaim)).toBe(b);
    expect(reclaimLeftovers(gap)).toEqual([]);
  }
  // The same gap after a TRUE dead-claim removal: C's claim linked into it is withdrawn — never acted under, never
  // stranded in a live caller — so the recoverer links after its removal and completes with its reclaim notice; C's
  // stop, retried once the recoverer is done, takes the claim and completes its own lifecycle.
  for (const verb of ["start", "stop"]) {
    const resumed = mkRepo();
    const resumedClaim = beatClaimPath(resumed, "overseer");
    const corpse2 = deadPid();
    put(resumedClaim, claimOf(corpse2));
    let deferred: Promise<Awaited<ReturnType<typeof run>>> | undefined;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    let fired = false;
    fsHooks.rename = (from, to, move) => {
      move();
      if (fired || from !== resumedClaim || !to.includes(".reclaim")) return;
      fired = true;
      deferred = run(resumed, ["stop", "overseer", "--seat", "s"], deps({ sleep: () => done }));
    };
    let recoverer: Awaited<ReturnType<typeof run>>;
    try { recoverer = await run(resumed, [verb, "overseer", "--seat", "s"]); } finally { fsHooks.rename = undefined; finished(); }
    expect(recoverer.out).toContain(`overseer reclaimed the claim of dead pid ${corpse2}`);
    expect(recoverer).toMatchObject({ code: 0, out: expect.stringContaining(verb === "start" ? "overseer ARMED as s" : "overseer DISARMED — published DISARMED") });
    const child = verb === "start" ? owner(resumed, "overseer").pid : undefined;
    if (child) spawned.push({ pid: child } as ChildProcess);
    expect(await deferred!).toMatchObject({ code: 0, out: expect.stringContaining(verb === "start" ? `retired detached pid ${child}` : "already stood down; checked no-op") });
    expect(existsSync(resumedClaim)).toBe(false);
    expect(existsSync(beatOwnerPath(resumed, "overseer"))).toBe(false);
    expect(reclaimLeftovers(resumed)).toEqual([]);
  }

  // Claimed mutations: the claim displaced at EVERY boundary call of stop (empty tier, owned live child retired,
  // owned dead child cleaned up) and of start (a launch that arms, and one rolled back after its child is recorded)
  // — during an identity read, a records check, a wait — and from that instant nothing is published, spawned,
  // signalled or removed. Covers the stand-down after retire's identity recheck, the dead-owner cleanup, the
  // rollback's signal after its identity read, and every owner publication and removal.
  const sweeps: Array<[string, () => Promise<[string, string[], Partial<BeatLifecycleDeps>?]>]> = [
    ["stop empty", async () => [mkRepo(), ["stop", "overseer", "--seat", "s"]]],
    ["stop live", async () => { const r = mkRepo(); await ownedFixture(r, "overseer", "s"); return [r, ["stop", "overseer", "--seat", "s"]]; }],
    ["stop dead", async () => { const r = mkRepo(); await killAndReap((await ownedFixture(r, "overseer", "s")).child); return [r, ["stop", "overseer", "--seat", "s"]]; }],
    ["start armed", async () => { const r = mkRepo(); return [r, ["start", "overseer", "--seat", "s"], launchFixture(r, true)]; }],
    ["start rolled back", async () => { const r = mkRepo(); return [r, ["start", "overseer", "--seat", "s"], launchFixture(r, false)]; }],
  ];
  for (const [name, fixture] of sweeps) {
    const refusals: string[] = [];
    for (let k = 1; ; k++) {
      const [repo, argv, over] = await fixture();
      const out = await displacedAt(k, repo, argv, over);
      if (out === undefined) break;
      refusals.push(out);
    }
    expect([name, refusals.some((out) => /claim is no longer held/.test(out))]).toEqual([name, true]);
  }

  // Every claimed mutation flow: the lifecycle verbs, every legacy form, and a launched generation writing under its
  // launcher's claim (no release follows it, so its own final check decides).
  const launcherClaim = (form: string[]) => async (): Promise<[string, string[], Partial<BeatLifecycleDeps>]> => {
    const r = mkRepo();
    recordOwner(r, "overseer", "s", process.pid, readProcessIdentity(process.pid) as ProcessIdentity);
    put(beatClaimPath(r, "overseer"), JSON.stringify({ tier: "overseer", token: "gen-fixture", pid: process.pid }) + "\n");
    return [r, ["overseer", "--seat", "s", ...form], { env: { ...env(), [BEAT_GENERATION_ENV]: "gen-fixture" } }];
  };
  type Flow = [string, () => Promise<[string, string[], Partial<BeatLifecycleDeps>?]>];
  const publicationFlows: Flow[] = [
    ["start armed", async () => { const r = mkRepo(); return [r, ["start", "overseer", "--seat", "s"], launchFixture(r, true)]; }],
    ["start rolled back", async () => { const r = mkRepo(); return [r, ["start", "overseer", "--seat", "s"], launchFixture(r, false)]; }],
    ["stop empty", async () => [mkRepo(), ["stop", "overseer", "--seat", "s"]]],
    ["stop live", async () => { const r = mkRepo(); await ownedFixture(r, "overseer", "s"); return [r, ["stop", "overseer", "--seat", "s"]]; }],
    ["stop dead", async () => { const r = mkRepo(); await killAndReap((await ownedFixture(r, "overseer", "s")).child); return [r, ["stop", "overseer", "--seat", "s"]]; }],
    ["legacy one-shot", async () => [mkRepo(), ["overseer", "--seat", "s"]]],
    ["legacy existing-arm beat", async () => { const r = mkRepo(); expect((await run(r, ["overseer", "--seat", "s"])).code).toBe(0); return [r, ["overseer", "--seat", "s"]]; }],
    ["legacy new-arm", async () => [mkRepo(), ["overseer", "--seat", "s", "--new-arm"]]],
    ["legacy stand-down", async () => [mkRepo(), ["overseer", "--seat", "s", "--stand-down"]]],
    ["launcher-claim one-shot", launcherClaim([])],
    ["launcher-claim new-arm", launcherClaim(["--new-arm"])],
    ["launcher-claim stand-down", launcherClaim(["--stand-down"])],
  ];
  /** Run one flow with its kills and spawns counted. */
  const counted = async (r: string, argv: string[], over: Partial<BeatLifecycleDeps> | undefined, acts: { kills: number; spawns: number }) => {
    const base = deps({ ...fast, ...over });
    return run(r, argv, {
      ...base, kill: (p, signal) => { acts.kills++; base.kill(p, signal); },
      spawn: (command, args, options) => { acts.spawns++; return base.spawn(command, args, options); },
    });
  };

  // No claim removal lands inside a claimed act. At EVERY read of the claim, a rival claimant whose identity reader
  // proves every recorded pid dead (a mistaken proof — the most hostile replacement a tickmarkr claimant can make)
  // tries to take the claim: inside a claimed act — or inside a release — it is refused BUSY with the claim untouched,
  // and the act lands under the claim it verified; anywhere else it takes the claim, and from that instant the
  // invocation writes, spawns, signals and removes nothing further (owner, arm, beat and marker frozen) and leaves the
  // rival's claim in place — its release and the DISARMED no-op included — refusing nonzero at its next check of the
  // claim. Only a take after the invocation's LAST check (a launched writer's final check: no release follows it)
  // finds nothing left to refuse: everything it landed, it landed under its verified claim.
  const rivalFlows: Flow[] = [
    ["stop disarmed no-op", async () => { const r = mkRepo(); await run(r, ["stop", "overseer", "--seat", "s"]); return [r, ["stop", "overseer", "--seat", "s"]]; }],
    ...publicationFlows,
  ];
  for (const [name, fixture] of rivalFlows) {
    const seen = { taken: 0, excluded: 0 };
    for (let k = 1; ; k++) {
      const [r, argv, over] = await fixture();
      const claim = beatClaimPath(r, "overseer");
      const acts = { kills: 0, spawns: 0 };
      let reads = 0;
      let fired = false;
      let frozen: { state: Array<string | undefined>; acts: typeof acts; claim: string | undefined } | undefined;
      let excluded: string | undefined;
      let later = 0; // the invocation's own reads of the claim after the rival took it
      fsHooks.read = (path, real) => {
        const value = real();
        if (fired && frozen && path === claim) later++;
        if (fired || path !== claim || ++reads !== k) return value;
        fired = true;
        const held = bytes(claim);
        try {
          acquireBeatClaim(r, "overseer", "rival", deps({ identity: () => "DEAD" }));
          frozen = { state: protectedState(r), acts: { ...acts }, claim: bytes(claim) };
        } catch (error) {
          excluded = (error as Error).message;
          expect([name, k, bytes(claim)]).toEqual([name, k, held]);
        }
        return value;
      };
      let result: Awaited<ReturnType<typeof run>>;
      try { result = await counted(r, argv, over, acts); } finally { fsHooks.read = undefined; }
      if (!fired) break;
      if (frozen) {
        seen.taken++;
        expect([name, k, result.code, protectedState(r), acts, bytes(claim), claimLeftovers(r)])
          .toEqual([name, k, later > 0 ? 1 : 0, frozen.state, frozen.acts, frozen.claim, []]);
      } else {
        seen.excluded++;
        expect([name, k, excluded]).toEqual([name, k, expect.stringMatching(/BUSY — (pid \d+ is inside a claimed act|.* is already under way)/)]);
        expect([name, k, claimLeftovers(r)]).toEqual([name, k, []]);
      }
    }
    expect([name, seen.taken > 0, seen.excluded > 0]).toEqual([name, true, true]);
  }

  // Publication: the claim replaced right after ANY temporary file is written — an owner record's, or one inside a
  // supervision write (stand-down, arm, initial arm and its beat, a loop's existing-arm beat) — lands NOTHING: each
  // rename is one claimed act whose final check reads the claim after the temporary file, and supervision writes are
  // staged and committed only through such acts. No protected record changes, nothing is signalled or spawned, the
  // replacement stays, and the invocation refuses nonzero.
  let ownerCommits = 0;
  for (const [name, fixture] of publicationFlows) {
    let hits = 0;
    for (let k = 1; ; k++) {
      const [r, argv, over] = await fixture();
      const claim = beatClaimPath(r, "overseer");
      const acts = { kills: 0, spawns: 0 };
      let frozen: { state: Array<string | undefined>; acts: typeof acts } | undefined;
      let writes = 0;
      fsHooks.write = (path) => {
        if (!path.endsWith(".tmp") || path.startsWith(claim) || ++writes !== k) return;
        put(claim, replacement);
        frozen = { state: protectedState(r), acts: { ...acts } };
        if (path.startsWith(beatOwnerPath(r, "overseer"))) ownerCommits++;
      };
      let result: Awaited<ReturnType<typeof run>>;
      try { result = await counted(r, argv, over, acts); } finally { fsHooks.write = undefined; }
      if (!frozen) break;
      hits++;
      expect([name, k, result.code, result.out.includes("no longer held"), bytes(claim), acts, protectedState(r), stagesLeft(r)])
        .toEqual([name, k, 1, true, replacement, frozen.acts, frozen.state, []]);
    }
    expect([name, hits > 0]).toEqual([name, true]);
  }
  expect(ownerCommits).toBeGreaterThanOrEqual(3); // the launch record, its pid binding and its arm-epoch binding

  // Generation barriers hold through staged writes: the owner record and the durable arm replaced by ANOTHER generation
  // while the claim is retained — at EVERY temporary file written, a supervision write's staged ones included — and the
  // invocation commits nothing further. Each commit is a claimed act that re-runs its owner barrier and compares every
  // record with what the write was staged from: the replacement owner and arm stay exactly as placed, beat and marker
  // are untouched from that instant, nothing is signalled or spawned, and it refuses nonzero — the unowned initial and
  // existing-arm one-shots, re-arm and stand-down, generation-bearing ones, every stop path and the rollback alike.
  for (const [name, fixture] of publicationFlows) {
    let hits = 0;
    for (let k = 1; ; k++) {
      const [r, argv, over] = await fixture();
      const [ownerPath, armPath] = [beatOwnerPath(r, "overseer"), supervisionArmPath(r, "overseer")];
      const id = readProcessIdentity(process.pid) as ProcessIdentity;
      const otherOwner = JSON.stringify({
        tier: "overseer", seat: "s", generation: "gen-replacement", armId: "arm-replacement", cwd: r, startedAt: new Date().toISOString(),
        armEpoch: new Date().toISOString(), pid: process.pid, birth: id.birth, command: id.command, pgid: id.pgid,
      }) + "\n";
      const otherArm = JSON.stringify({ armId: "arm-replacement", armEpoch: new Date().toISOString(), markerFence: "NONE" }) + "\n";
      const claim = beatClaimPath(r, "overseer");
      const acts = { kills: 0, spawns: 0 };
      let frozen: { state: Array<string | undefined>; acts: typeof acts } | undefined;
      let writes = 0;
      fsHooks.write = (path) => {
        if (!path.endsWith(".tmp") || path.startsWith(claim) || ++writes !== k) return;
        put(ownerPath, otherOwner);
        put(armPath, otherArm);
        frozen = { state: protectedState(r), acts: { ...acts } };
      };
      let result: Awaited<ReturnType<typeof run>>;
      try { result = await counted(r, argv, over, acts); } finally { fsHooks.write = undefined; }
      if (!frozen) break;
      hits++;
      expect([name, k, result.code, bytes(ownerPath), bytes(armPath), acts, protectedState(r), stagesLeft(r)])
        .toEqual([name, k, 1, otherOwner, otherArm, frozen.acts, frozen.state, []]);
    }
    expect([name, hits > 0]).toEqual([name, true]);
  }

  // A launched writer racing recovery of its dead launcher's claim. In process: the writer records itself as the launch
  // claim's publisher before its first act; then, at EVERY later read of the claim, its launcher is killed and a rival
  // with a truthful identity reader tries to recover the claim — refused BUSY naming the live publisher, the claim
  // untouched — and the writer lands exactly what it would have (exit 0).
  for (const [name, form] of [["one-shot", []], ["new-arm", ["--new-arm"]], ["stand-down", ["--stand-down"]]] as const) {
    let raced = 0;
    for (let k = 1; ; k++) {
      const r = mkRepo();
      const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      spawned.push(launcher);
      recordOwner(r, "overseer", "s", process.pid, readProcessIdentity(process.pid) as ProcessIdentity);
      const claim = beatClaimPath(r, "overseer");
      put(claim, JSON.stringify({ tier: "overseer", token: "gen-fixture", pid: launcher.pid }) + "\n");
      let reads = 0;
      let fired = false;
      fsHooks.read = (path, real) => {
        const value = real();
        if (fired || path !== claim || ++reads !== k || JSON.parse(String(value)).publisher !== process.pid) return value;
        fired = true;
        killConfirmed(launcher.pid!);
        const held = bytes(claim);
        expect(() => acquireBeatClaim(r, "overseer", "rival", deps()))
          .toThrow(`BUSY — pid ${launcher.pid} holds ${claim} with its launched writer pid ${process.pid}`);
        expect([name, k, bytes(claim)]).toEqual([name, k, held]);
        return value;
      };
      let result: Awaited<ReturnType<typeof run>>;
      try { result = await run(r, ["overseer", "--seat", "s", ...form], deps({ env: { ...env(), [BEAT_GENERATION_ENV]: "gen-fixture" } })); }
      finally { fsHooks.read = undefined; }
      if (reads < k) break;
      if (!fired) continue;
      raced++;
      expect([name, k, result.code, JSON.parse(bytes(claim)!).publisher]).toEqual([name, k, 0, process.pid]);
      expect(supervisionStatus(r, "overseer").state).toBe(form[0] === "--stand-down" ? "DISARMED" : "ARMED");
    }
    expect([name, raced > 0]).toEqual([name, true]);
  }
  // Real processes: once its launcher is confirmed dead, recovery and stop stay BUSY while the launched writer lives —
  // never stolen — and the writer itself reclaims the launch claim at its next settled tick, after which stop retires
  // it — never stranded. A launch claim whose launcher is already dead and that names no publisher is never acted
  // under: its writer refuses having published nothing, and recovery takes the claim.
  const racing = mkRepo();
  const racingClaim = beatClaimPath(racing, "overseer");
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(launcher);
  const launchOwner = (r: string, generation: string) => put(beatOwnerPath(r, "overseer"), JSON.stringify({
    tier: "overseer", seat: "s", generation, armId: generation, cwd: r, startedAt: new Date().toISOString(),
  }) + "\n");
  const launched = (r: string, generation: string) => {
    const child = spawn(CLI[0], [...CLI.slice(1), "beat", "overseer", "--seat", "s", "--loop", "--arm-id", generation],
      { cwd: r, stdio: ["ignore", "pipe", "pipe"], env: { ...env(), [BEAT_GENERATION_ENV]: generation } });
    spawned.push(child);
    let out = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { out += chunk; });
    return { child, out: () => out };
  };
  put(racingClaim, JSON.stringify({ tier: "overseer", token: "gen-racing", pid: launcher.pid }) + "\n");
  launchOwner(racing, "gen-racing");
  const { child: writer } = launched(racing, "gen-racing");
  const beatOf = () => { try { return JSON.parse(readFileSync(supervisionBeatPath(racing, "overseer"), "utf8")) as { pid: number; beatAt: string; armEpoch: string }; } catch { return undefined; } };
  await until(() => beatOf()?.pid === writer.pid);
  const named = bytes(racingClaim)!;
  expect(JSON.parse(named).publisher).toBe(writer.pid);
  // What its launcher would have bound next: the writer's pid and identity, and its arm epoch.
  const writerId = readProcessIdentity(writer.pid!) as ProcessIdentity;
  put(beatOwnerPath(racing, "overseer"), JSON.stringify({
    ...JSON.parse(bytes(beatOwnerPath(racing, "overseer"))!), pid: writer.pid, birth: writerId.birth, command: writerId.command, pgid: writerId.pgid, armEpoch: beatOf()!.armEpoch,
  }) + "\n");
  await killAndReap(launcher);
  expect(() => acquireBeatClaim(racing, "overseer", "rival", deps())).toThrow(`with its launched writer pid ${writer.pid}`);
  const racingKills: number[] = [];
  const busyStop = await run(racing, ["stop", "overseer", "--seat", "s"], deps({ ...fast, kill: (p) => { racingKills.push(p); } }));
  expect(busyStop).toMatchObject({ code: 1, out: expect.stringContaining(`BUSY — pid ${launcher.pid} holds`) });
  expect(busyStop.out).not.toContain("reclaimed");
  expect([bytes(racingClaim), racingKills, alive(writer.pid!)]).toEqual([named, [], true]);
  const firstBeat = beatOf()!.beatAt;
  await until(() => bytes(racingClaim) !== named && beatOf()!.beatAt !== firstBeat, 40_000); // its next settled tick
  expect(beatOf()!.pid).toBe(writer.pid);
  expect(await run(racing, ["stop", "overseer", "--seat", "s"])).toMatchObject({ code: 0, out: expect.stringContaining(`retired detached pid ${writer.pid}`) });
  expect(alive(writer.pid!)).toBe(false);
  // Abandoned: the launcher already dead and the claim naming no publisher.
  const abandoned = mkRepo();
  const abandonedCorpse = deadPid();
  put(beatClaimPath(abandoned, "overseer"), JSON.stringify({ tier: "overseer", token: "gen-abandoned", pid: abandonedCorpse }) + "\n");
  launchOwner(abandoned, "gen-abandoned");
  const orphan = launched(abandoned, "gen-abandoned");
  await until(() => orphan.child.exitCode !== null);
  expect(orphan.child.exitCode).toBe(1);
  expect(orphan.out()).toContain("superseded — the launch claim for generation gen-abandoned is gone, names another writer, or its launcher is dead");
  expect([existsSync(supervisionArmPath(abandoned, "overseer")), existsSync(supervisionBeatPath(abandoned, "overseer"))]).toEqual([false, false]);
  expect(acquireBeatClaim(abandoned, "overseer", "rival", deps())).toContain(`reclaimed the claim of dead pid ${abandonedCorpse} (token gen-abandoned)`);
  releaseBeatClaim(abandoned, "overseer", "rival");
  // Launcher killed after publishing its writer's pid but BEFORE binding the arm epoch: the live writer, once settled,
  // releases the dead launcher's claim and exits — it never beats on unbound — so status names the abandoned launch
  // with its recovery command, and that printed stop retires it (nothing signalled).
  const unbound = mkRepo();
  const unboundLauncher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(unboundLauncher);
  put(beatClaimPath(unbound, "overseer"), JSON.stringify({ tier: "overseer", token: "gen-unbound", pid: unboundLauncher.pid }) + "\n");
  launchOwner(unbound, "gen-unbound");
  const unboundWriter = launched(unbound, "gen-unbound");
  const unboundPid = unboundWriter.child.pid!;
  await until(() => { try { return JSON.parse(readFileSync(supervisionBeatPath(unbound, "overseer"), "utf8")).pid === unboundPid; } catch { return false; } });
  const unboundId = readProcessIdentity(unboundPid) as ProcessIdentity;
  put(beatOwnerPath(unbound, "overseer"), JSON.stringify({
    ...JSON.parse(bytes(beatOwnerPath(unbound, "overseer"))!), pid: unboundPid, birth: unboundId.birth, command: unboundId.command, pgid: unboundId.pgid,
  }) + "\n");
  await killAndReap(unboundLauncher);
  await until(() => unboundWriter.child.exitCode !== null, 40_000);
  expect([unboundWriter.child.exitCode, existsSync(beatClaimPath(unbound, "overseer"))]).toEqual([1, false]);
  expect(unboundWriter.out()).toContain(`overseer released the launch claim of dead launcher pid ${unboundLauncher.pid}`);
  expect(unboundWriter.out()).toContain("died before binding generation gen-unbound's arm epoch; this writer exits");
  const unboundStatus = await run(unbound, ["status", "overseer"]);
  expect(unboundStatus).toMatchObject({ code: 1, out: expect.stringContaining(`recorded pid ${unboundPid} is gone — its launch was abandoned; run \`tickmarkr beat stop overseer --seat s\``) });
  const unboundKills: number[] = [];
  expect(await run(unbound, /`tickmarkr beat ([^`]+)`/.exec(unboundStatus.out)![1].split(" "), deps({ kill: (p) => { unboundKills.push(p); } })))
    .toMatchObject({ code: 0, out: expect.stringContaining("generation gen-unbound's abandoned launch cleaned up, nothing signalled") });
  expect([unboundKills, existsSync(beatOwnerPath(unbound, "overseer")), supervisionStatus(unbound, "overseer").state]).toEqual([[], false, "DISARMED"]);
}, 900_000);

test("test: production beat admits twelve concurrent one-shots and stop after tick release versus BUSY at the twentieth held attempt", async () => {
  expect(BEAT_CLAIM_WAIT).toEqual({ tries: 20, intervalMs: 250 });
  const repo = mkRepo();
  const claim = beatClaimPath(repo, "overseer");
  // An owned loop tick holds the claim while twelve legacy one-shots arrive.
  put(claim, JSON.stringify({ tier: "overseer", token: "tick", pid: process.pid, claimedAt: new Date().toISOString() }) + "\n");
  const waits: number[] = [];
  let allWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { allWaiting = resolve; });
  let releaseTick!: () => void;
  const released = new Promise<void>((resolve) => { releaseTick = resolve; });
  const sleep = async (ms: number) => {
    waits.push(ms);
    if (waits.length === 12) allWaiting();
    await released;
    await new Promise((resolve) => setImmediate(resolve)); // one retry per macrotask: each holder finishes its write first
  };
  const writers = Array.from({ length: 12 }, () => run(repo, ["overseer", "--seat", "s"], deps({ sleep })));
  await waiting; // every writer recorded a refused acquisition against the held tick
  expect(waits).toEqual(Array(12).fill(250));
  rmSync(claim); // the tick releases
  releaseTick();
  const results = await Promise.all(writers);
  for (const result of results) expect(result).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as s") });
  expect(existsSync(claim)).toBe(false);
  expect(supervisionStatus(repo, "overseer").state).toBe("ARMED");

  // stop arriving inside an owned loop tick waits for the tick's release, then reads back DISARMED.
  const owned = mkRepo();
  expect((await run(owned, ["start", "overseer", "--seat", "s"])).code).toBe(0);
  const child = owner(owned, "overseer");
  spawned.push({ pid: child.pid } as ChildProcess);
  const ownedClaim = beatClaimPath(owned, "overseer");
  put(ownedClaim, JSON.stringify({ tier: "overseer", token: "tick", pid: child.pid, claimedAt: new Date().toISOString() }) + "\n");
  const stopWaits: number[] = [];
  const stopped = await run(owned, ["stop", "overseer", "--seat", "s"], deps({ sleep: async (ms) => { stopWaits.push(ms); if (stopWaits.length === 1) rmSync(ownedClaim); } }));
  expect(stopped).toMatchObject({ code: 0, out: expect.stringContaining(`overseer DISARMED — retired detached pid ${child.pid}`) });
  expect(stopWaits[0]).toBe(250);

  // Released before the final attempt: the twentieth acquisition succeeds.
  const late = mkRepo();
  const lateClaim = beatClaimPath(late, "overseer");
  put(lateClaim, JSON.stringify({ tier: "overseer", token: "tick", pid: process.pid }) + "\n");
  const lateWaits: number[] = [];
  expect(await run(late, ["overseer", "--seat", "s"], deps({ sleep: async (ms) => { lateWaits.push(ms); if (lateWaits.length === 19) rmSync(lateClaim); } })))
    .toMatchObject({ code: 0, out: expect.stringContaining("ARMED as s") });
  expect(lateWaits).toHaveLength(19);
  // Held through the twentieth attempt: a named BUSY with every byte protected, for a one-shot and for stop.
  const stuck = mkRepo();
  const fixture = await ownedFixture(stuck, "overseer", "s");
  const stuckClaim = beatClaimPath(stuck, "overseer");
  put(stuckClaim, JSON.stringify({ tier: "overseer", token: "tick", pid: fixture.pid }) + "\n");
  const frozen = () => [stuckClaim, beatOwnerPath(stuck, "overseer"), supervisionArmPath(stuck, "overseer"), supervisionBeatPath(stuck, "overseer"), supervisionStandDownPath(stuck, "overseer")].map(bytes);
  const before = frozen();
  for (const argv of [["overseer", "--seat", "s"], ["stop", "overseer", "--seat", "s"]]) {
    const held: number[] = [];
    const kills: number[] = [];
    const result = await run(stuck, argv, deps({ sleep: async (ms) => { held.push(ms); }, kill: (p) => { kills.push(p); } }));
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining(`overseer BUSY — pid ${fixture.pid} holds`) });
    expect(result.out).toContain("still held after 20 attempts 250 ms apart");
    expect(held).toEqual(Array(19).fill(250));
    expect(kills).toEqual([]);
    expect(frozen()).toEqual(before);
  }
  // An invalid wait seam refuses before any claim or write.
  for (const bad of [{ tries: 0 }, { tries: -1 }, { tries: 1.5 }, { tries: Number.NaN }, { tries: Number.POSITIVE_INFINITY },
    { intervalMs: 0 }, { intervalMs: -250 }, { intervalMs: 2.5 }, { intervalMs: Number.NaN }, { intervalMs: Number.POSITIVE_INFINITY }]) {
    const seam = mkRepo();
    let acted = false;
    await expect(withLegacyClaim(seam, "overseer", { seat: "s", deps: deps() }, () => { acted = true; }, { ...bad, sleep: async () => {} }))
      .rejects.toThrow("claim wait refused");
    expect(acted).toBe(false);
    expect(existsSync(beatClaimPath(seam, "overseer"))).toBe(false);
  }
  // The same refusal for a generation-bearing writer already holding its launch claim over a valid owner — the
  // shortcut that acts under that claim — while a valid policy on the same records does act.
  const launched = mkRepo();
  recordOwner(launched, "overseer", "s", process.pid, readProcessIdentity(process.pid) as ProcessIdentity);
  put(beatClaimPath(launched, "overseer"), JSON.stringify({ tier: "overseer", token: "gen-fixture", pid: process.pid }) + "\n");
  const records = () => [beatClaimPath(launched, "overseer"), beatOwnerPath(launched, "overseer"), supervisionArmPath(launched, "overseer"),
    supervisionBeatPath(launched, "overseer"), supervisionStandDownPath(launched, "overseer")].map(bytes);
  const untouched = records();
  const writer = { generation: "gen-fixture", seat: "s", deps: deps() };
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].flatMap((v) => [{ tries: v }, { intervalMs: v }])) {
    let acted = false;
    await expect(withLegacyClaim(launched, "overseer", writer, () => { acted = true; }, { ...bad, sleep: async () => {} }))
      .rejects.toThrow("claim wait refused");
    expect(acted).toBe(false);
    expect(records()).toEqual(untouched);
  }
  let acted = false;
  await withLegacyClaim(launched, "overseer", writer, (recheck) => { recheck(); acted = true; }, { sleep: async () => {} });
  expect(acted).toBe(true);
}, 120_000);

test("test: production beat readback reports confirmed death and missing Darwin lsof versus live unreadable identity in the closed residual table", async () => {
  const lsof = lsofFixture();
  const darwin = { platform: "darwin" as const, lsof: lsof.bin };
  const kills: number[] = [];
  const kill = (p: number, signal: NodeJS.Signals) => { kills.push(p); process.kill(p, signal); };
  // The child dies between ps and its cwd read at the initial proof: confirmed death, named, never signalled.
  const dies = mkRepo();
  const diedEarly = await run(dies, ["start", "overseer", "--seat", "s"], deps({
    kill, spawn: (command, args, options) => { const child = spawn(command, args, options); spawned.push(child); writeFileSync(lsof.doom, String(child.pid)); return child; },
  }, darwin));
  expect(diedEarly).toMatchObject({ code: 1, out: expect.stringContaining("died before its beat read back") });
  expect(diedEarly.out).toContain("rolled back this generation only");
  expect(existsSync(beatOwnerPath(dies, "overseer"))).toBe(false);
  // The child dies at the final read-back (owner bound): confirmed death, named, never signalled.
  const final = mkRepo();
  let child: ChildProcess | undefined;
  const diedLate = await run(final, ["start", "overseer", "--seat", "s"], deps({
    kill,
    spawn: (command, args, options) => { child = spawn(command, args, options); spawned.push(child); return child; },
    identity: (p) => {
      const bound = existsSync(beatOwnerPath(final, "overseer")) && JSON.parse(readFileSync(beatOwnerPath(final, "overseer"), "utf8")).armEpoch;
      if (p === child?.pid && bound) killConfirmed(p);
      return readProcessIdentity(p, darwin);
    },
  }));
  expect(diedLate).toMatchObject({ code: 1, out: expect.stringContaining("died before its beat read back") });
  expect(existsSync(beatOwnerPath(final, "overseer"))).toBe(false);
  expect(kills).toEqual([]);
  // A live child whose cwd cannot be read stays UNREADABLE, names lsof, and is never signalled.
  const blind = mkRepo();
  const unreadable = await run(blind, ["start", "overseer", "--seat", "s"], deps({
    kill, spawn: (command, args, options) => { const c = spawn(command, args, options); spawned.push(c); writeFileSync(lsof.fail, String(c.pid)); return c; },
  }, darwin));
  expect(unreadable).toMatchObject({ code: 1, out: expect.stringContaining("UNREADABLE — child pid") });
  expect(unreadable.out).toContain(`lsof (${lsof.bin}) exited 1`);
  expect(unreadable.out).toContain("not signalled");
  expect(kills).toEqual([]);
  rmSync(lsof.fail);

  // Darwin with lsof missing: start refuses naming lsof before anything is written; restored lsof starts, reads and stops.
  const repo = mkRepo();
  const missing = deps({ kill }, { platform: "darwin", lsof: lsof.missing });
  const refused = await run(repo, ["start", "overseer", "--seat", "s"], missing);
  expect(refused).toMatchObject({ code: 1, out: expect.stringContaining(`lsof is missing or unusable (${lsof.missing}`) });
  expect(refused.out).toContain("nothing started");
  expect(existsSync(beatOwnerPath(repo, "overseer"))).toBe(false);
  expect(existsSync(beatClaimPath(repo, "overseer"))).toBe(false);
  const restored = deps({ kill }, darwin);
  expect(await run(repo, ["start", "overseer", "--seat", "s"], restored)).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as s") });
  const armed = owner(repo, "overseer");
  spawned.push({ pid: armed.pid } as ChildProcess);
  expect(await run(repo, ["status", "overseer", "--seat", "s"], restored)).toMatchObject({ code: 0, out: expect.stringContaining("ARMED (s)") });
  // lsof lost under a live owned beat: status and stop name lsof, nothing is signalled or removed.
  for (const verb of ["status", "stop"]) {
    expect(await run(repo, [verb, "overseer", "--seat", "s"], missing)).toMatchObject({ code: 1, out: expect.stringContaining("lsof is missing or unusable") });
  }
  expect(kills).toEqual([]);
  expect(alive(armed.pid)).toBe(true);
  expect(owner(repo, "overseer").pid).toBe(armed.pid);
  expect(await run(repo, ["stop", "overseer", "--seat", "s"], restored)).toMatchObject({ code: 0, out: expect.stringContaining(`retired detached pid ${armed.pid}`) });
  expect(alive(armed.pid)).toBe(false);

  // The Linux path never needs lsof: it never invokes one, and never reports lsof as its cause.
  const recorder = join(mkdtempSync(join(tmpdir(), "tickmarkr-lsof-rec-")), "lsof");
  writeFileSync(recorder, `#!/bin/sh\ntouch '${recorder}.ran'\nexit 1\n`);
  chmodSync(recorder, 0o755);
  const linux = readProcessIdentity(process.pid, { platform: "linux", lsof: recorder });
  expect(existsSync(`${recorder}.ran`)).toBe(false);
  expect(String(linux)).not.toContain("lsof");
  if (process.platform === "linux") expect(typeof linux).toBe("object");

  // Read-back HANDOFF: the launched child is paused right after its first beat's claimed act ends (its act marker
  // removed), before that tick returns; start reads back, binds, releases its claim and exits 0 meanwhile. Resumed, the
  // child keeps its loop — nothing it checks after its last act can end it: it stays alive, beats again under its own
  // claim, status reads ARMED and stop retires it.
  const handoff = mkRepo();
  const gate = mkdtempSync(join(tmpdir(), "tickmarkr-handoff-"));
  const hook = join(gate, "pause.mjs");
  writeFileSync(hook, `
import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const gate = process.env.BEAT_HANDOFF_GATE; const { renameSync, rmSync } = fs; let beat = false, held = false;
fs.renameSync = (from, to) => {
  renameSync(from, to);
  if (String(from).includes(".stage.") && !String(to).includes(".stage.") && String(to).endsWith(${JSON.stringify(basename(supervisionBeatPath(handoff, "overseer")))})) beat = true;
};
fs.rmSync = (path, ...rest) => {
  rmSync(path, ...rest);
  if (beat && !held && String(path).includes(".act.")) {
    held = true; fs.writeFileSync(gate + "/paused", "");
    while (!fs.existsSync(gate + "/resume")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
syncBuiltinESMExports();`);
  const handoffDeps = deps({ cli: [...CLI.slice(0, 3), "--import", pathToFileURL(hook).href, CLI[3]], env: { ...env(), BEAT_HANDOFF_GATE: gate } });
  const handedOff = await run(handoff, ["start", "overseer", "--seat", "s"], handoffDeps);
  expect(handedOff).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as s") });
  const handoffOwner = owner(handoff, "overseer");
  spawned.push({ pid: handoffOwner.pid } as ChildProcess);
  // start returned while its child sat between its first beat and that tick's return; the launch claim is released.
  expect([existsSync(join(gate, "paused")), existsSync(join(gate, "resume")), existsSync(beatClaimPath(handoff, "overseer"))]).toEqual([true, false, false]);
  const beatAt = () => JSON.parse(bytes(supervisionBeatPath(handoff, "overseer"))!) as { pid: number; beatAt: string };
  const first = beatAt().beatAt;
  writeFileSync(join(gate, "resume"), "");
  await until(() => beatAt().beatAt !== first, 30_000);
  expect([beatAt().pid, alive(handoffOwner.pid)]).toEqual([handoffOwner.pid, true]);
  expect(await run(handoff, ["status", "overseer", "--seat", "s"])).toMatchObject({ code: 0, out: expect.stringContaining(`ARMED (s) — detached pid ${handoffOwner.pid}`) });
  expect(await run(handoff, ["stop", "overseer", "--seat", "s"])).toMatchObject({ code: 0, out: expect.stringContaining(`retired detached pid ${handoffOwner.pid}`) });
}, 120_000);
