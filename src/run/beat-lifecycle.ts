import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDirName, tickmarkrDir } from "../graph/graph.js";
import {
  SUPERVISION_BEAT_MS, isSeatTier, publishStandDown, readSupervisionArm, supervisionArmPath, supervisionBeatPath, supervisionStandDownPath,
  supervisionStatus, type SupervisionArm, type SupervisionTier,
} from "./supervision.js";

// H + D-1001: the detached beat is OWNED by the product, not by a shell recipe. One claim file per
// (repository, tier) serializes start, stop and the legacy arm-mutating writers; one owner record names
// the exact generation (seat, armId, pid, process birth/argv/cwd) that start launched. Every signal and
// removal rechecks that generation first and reads the result back afterwards, so an older invocation can
// never retire a replacement, and a pid that now belongs to another process is a mismatch, never a target.
// Status takes no claim and writes nothing. Uncertain state is RETAINED and refused (nonzero), never guessed.
// Claims — the closed actor table. IN: compliant claim contenders (start, stop and every legacy write through this CLI;
// status takes no claim), a crashed owner (holder ESRCH or a zombie, its claim and records left behind) and a killed
// compliant recovery or release taker (dead at any step of the one removal path). OUT, the one residual: an external
// writer editing, replacing or deleting claim, lock or record files outside this CLI — nothing is promised under it
// beyond the identity MISMATCH refusals (e.g. its edit between a final check and the mutation's own syscall is not
// seen; POSIX has no compare-and-rename). A claim records its holder pid and birth (its runtime's own record, read with no
// process probe) and, for a launch claim, the launched writer publishing under it (namePublisher, before that writer's first act). EVERY claimant takes over a held
// claim only when every pid parsed from the very bytes checked is confirmed dead (ESRCH or a zombie) — the legacy
// {tier, token, pid, claimedAt} schema included — so a legacy writer killed inside its claimed tick never strands the
// printed migration step, while a live, reused or unreadable holder or writer is never taken over (BUSY). A launched
// writer whose launcher is dead releases the launch claim itself once settled (releaseDeadLaunch) and refuses while
// launching; one whose dead launcher never bound its arm epoch exits after that release, leaving an ABANDONED launch
// for ordinary recovery. Under its launcher's claim nothing is checked after its last act (each act verified the claim
// last), so the launcher releasing after its read-back never ends the loop it launched. A claim is removed in exactly
// ONE way, by recovery and release alike (takeClaim): under a per-claim removal lock that appears atomically WITH its
// owner (pid, birth) and only once no claimed act is running under those bytes, the checked bytes are moved aside into
// that lock and kept only when they are exactly those bytes — anything else is put straight back, and a claim linked
// meanwhile holds nothing until the lock is gone: its claimant withdraws it and refuses BUSY. Bytes a claimant could
// not remove (another live taker held or moved them aside, even on a mistaken death proof) stay provably ITS STRAND
// wherever they are — its pid, checked birth and a token no invocation of that process still holds (strandOf) — so its
// own next start, stop or legacy write withdraws them from the claim path (withdrawStrand) or discards them from a
// killed taker's lock (recoverLock), its status reports them wherever they are — the claim path or moved aside into a
// live or dead taker's lock, naming that taker — with the recovery command (strandsNamed), and once it exits they are
// a dead claim: even a
// long-lived caller never needs to exit for recovery to proceed. A lock whose owner is confirmed dead (a killed
// taker) is recovered by the next start, stop or legacy write (recoverLock) with a notice, as is the pid-named entry of
// a taker killed while assembling or releasing it; a live or unprovable owner's lock is never taken (BUSY). Every
// claimed mutation — owner record renames, the log open, spawn, signals, removals, and each record a STAGED supervision
// write changed (supervised) — is ONE claimed act (claimedAct): marked beside the claim, its owner-generation barrier
// (and, staged, a compare of every supervision record with what it was staged from) re-run inside it, the claim
// verified LAST, immediately before the mutation. So no claim removal lands inside an act, and a claim, owner or arm
// replaced before that final check lands nothing further — nothing more is written, signalled or removed and the
// invocation refuses nonzero at its next check, release included. What a dead invocation leaves (act marker, removal
// lock, moved-aside bytes, stage directory) is cleared only by a start, stop or legacy write that proves its owner
// dead; status reports it with that command, and names every live holder — the claim's and each removal lock's taker. Owners likewise: a generation whose recorded pid is confirmed dead
// (OWN-DEAD), or an unbound owner no launch holds (ABANDONED: its launcher died before binding pid or arm epoch, no
// recorded process alive), is retired — owner removed, nothing signalled — by the next stop or start (both stand its
// arm down; start then launches) or legacy write (whose requested write then proceeds on that arm: a one-shot records
// its beat) (retireDead).

/** start's whole budget — launch, read-back and any overrun — before it must refuse and roll back. */
export const BEAT_STARTUP_CEILING_MS = 60_000;
/** The generation a started child carries; it lets the child act under its launcher's claim only. */
export const BEAT_GENERATION_ENV = "TICKMARKR_BEAT_GENERATION";

export interface ProcessIdentity { birth: string; command: string; cwd: string; pgid: number }
/** `UNKNOWN — <why>` is UNKNOWN that names its cause (Darwin's lsof missing or unusable): never life, never death. */
export type IdentityRead = ProcessIdentity | "DEAD" | "UNKNOWN" | `UNKNOWN — ${string}`;
/** The host the production reader inspects through; Darwin (and every non-Linux host) reads cwd only via lsof. */
export interface IdentityHost { platform?: NodeJS.Platform; lsof?: string }

/** Every boundary the lifecycle crosses, injectable so failures are exercised where they really occur. */
export interface BeatLifecycleDeps {
  /** Command prefix that re-executes this same CLI (node, its flags, the entry the launcher ran). */
  cli: readonly string[];
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  identity: (pid: number) => IdentityRead;
  openLog: (path: string) => number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
}

export function defaultBeatDeps(host: IdentityHost = {}): BeatLifecycleDeps {
  return {
    cli: [process.execPath, ...process.execArgv, process.argv[1] ?? ""],
    spawn: nodeSpawn,
    kill: (pid, signal) => { process.kill(pid, signal); },
    identity: (pid) => readProcessIdentity(pid, host),
    openLog: (path) => openSync(path, "a"),
    now: Date.now,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    env: process.env,
  };
}

/** A named, nonzero refusal: dispatch renders the message and exits 1. `notice` is a reclaim it must not lose. */
export class BeatRefusal extends Error {
  constructor(message: string, readonly notice?: string) { super(message); }
}
function refuse(message: string): never { throw new BeatRefusal(message); }

/** Death the kernel confirms: ESRCH, or a zombie awaiting its reaper. Anything else — a non-positive pid too — is not proof. */
function confirmedDead(pid: number): boolean {
  if (!positive(pid)) return false;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim().startsWith("Z") === true;
}

/**
 * The live process behind a pid: birth (lstart), full argv, cwd and process group. A missing process is
 * DEAD only when the kernel says so (ESRCH or a zombie) — also when it exits between ps and the cwd read;
 * anything unreadable is UNKNOWN, never DEAD. Linux reads cwd from /proc and never needs lsof; every other
 * host reads it through lsof, so a missing or unusable lsof beside a LIVE pid is UNKNOWN that names lsof.
 */
export function readProcessIdentity(pid: number, host: IdentityHost = {}): IdentityRead {
  const platform = host.platform ?? process.platform;
  const lsofBin = host.lsof ?? "lsof";
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "DEAD" : "UNKNOWN";
  }
  const ps = spawnSync("ps", ["-ww", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  const row = /^\s*(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*\S)\s*$/s.exec(ps.stdout ?? "");
  if (ps.status !== 0 || !row) return confirmedDead(pid) ? "DEAD" : "UNKNOWN";
  if (row[2].startsWith("Z")) return "DEAD";
  let cwd: string | undefined;
  let why: string | undefined;
  if (platform === "linux") {
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { cwd = undefined; }
  } else {
    const lsof = spawnSync(lsofBin, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    cwd = lsof.stdout?.split("\n").find((line) => line.startsWith("n"))?.slice(1) || undefined;
    if (!cwd) {
      why = lsof.error ? `lsof is missing or unusable (${lsofBin}: ${(lsof.error as NodeJS.ErrnoException).code ?? lsof.error.message})`
        : `lsof (${lsofBin}) exited ${lsof.status ?? lsof.signal} without pid ${pid}'s cwd`;
    }
  }
  if (cwd) return { pgid: Number(row[1]), birth: row[3], command: row[4], cwd };
  if (confirmedDead(pid)) return "DEAD";
  return why ? `UNKNOWN — ${why}; ${platform} reads a process's cwd only through lsof — restore it` : "UNKNOWN";
}

const supervisionDirOf = (repoRoot: string, tier: SupervisionTier) => dirname(supervisionBeatPath(repoRoot, tier));
export const beatClaimPath = (repoRoot: string, tier: SupervisionTier) => join(supervisionDirOf(repoRoot, tier), `${tier}.claim`);
export const beatOwnerPath = (repoRoot: string, tier: SupervisionTier) => join(supervisionDirOf(repoRoot, tier), `${tier}.owner`);
export const beatLogPath = (repoRoot: string, tier: SupervisionTier) => join(supervisionDirOf(repoRoot, tier), `${tier}.log`);

/**
 * The exact generation start launched. pid/birth/command/pgid are absent only while it is launching;
 * priorArmId/priorArmEpoch name the (already fenced) arm on disk at launch, which the child's own arm then
 * replaces; armEpoch is bound from the exact child's checked beat, and ownership is the COMPLETE durable arm
 * generation (armId AND armEpoch) — a same-id arm with another epoch is a replacement.
 */
export interface BeatOwner {
  tier: SupervisionTier; seat: string; generation: string; armId: string; cwd: string; startedAt: string;
  armEpoch?: string; priorArmId?: string; priorArmEpoch?: string; pid?: number; birth?: string; command?: string; pgid?: number;
}

type Read<T> = T | "NONE" | "UNREADABLE";
const OWNER_CHANGED = "the owner record changed during inspection";

function readJson(path: string): Read<Record<string, unknown>> {
  let bytes: string;
  try { bytes = readFileSync(path, "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "NONE" : "UNREADABLE";
  }
  return parseJson(bytes);
}

function parseJson(bytes: string): Read<Record<string, unknown>> {
  try {
    const value = JSON.parse(bytes) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : "UNREADABLE";
  } catch { return "UNREADABLE"; }
}

const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);
const positive = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const percent = (v: unknown) => typeof v === "number" && v >= 0 && v <= 100;

/** The beat record's own schema (what writeSupervisionBeat publishes), checked independently of any marker. */
const validBeat = (rec: Record<string, unknown>, tier: SupervisionTier): boolean =>
  rec.tier === tier && text(rec.beatAt) && !Number.isNaN(Date.parse(rec.beatAt)) &&
  (isSeatTier(tier) ? text(rec.seat) : optional(rec.seat, text)) && optional(rec.armId, text) &&
  optional(rec.armEpoch, (v) => text(v) && !Number.isNaN(Date.parse(v as string))) && optional(rec.markerFence, (v) => typeof v === "string") &&
  optional(rec.pct, percent) && optional(rec.thresholdPct, percent) &&
  (rec.pid === undefined ? positive(rec.exitedWriterPid) : positive(rec.pid) && rec.exitedWriterPid === undefined);

export function readBeatOwner(repoRoot: string, tier: SupervisionTier): Read<BeatOwner> {
  const rec = readJson(beatOwnerPath(repoRoot, tier));
  if (typeof rec !== "object") return rec;
  const launched = rec.pid === undefined && rec.birth === undefined && rec.command === undefined && rec.pgid === undefined;
  const running = positive(rec.pid) && text(rec.birth) && text(rec.command) && positive(rec.pgid);
  if (rec.tier !== tier || !text(rec.seat) || !text(rec.generation) || !text(rec.armId) || !text(rec.cwd) ||
      !text(rec.startedAt) || Number.isNaN(Date.parse(rec.startedAt)) || (rec.priorArmId !== undefined && !text(rec.priorArmId)) || (!launched && !running) ||
      [rec.armEpoch, rec.priorArmEpoch].some((epoch) => epoch !== undefined && (!text(epoch) || Number.isNaN(Date.parse(epoch))))) return "UNREADABLE";
  return rec as unknown as BeatOwner;
}

/** A claim names its holder pid and, for a launch claim, the launched writer pid that publishes under it. */
type Claim = { token: string; pid: number; publisher?: number };

/**
 * This process's birth as its own runtime recorded it at start (performance.timeOrigin, sub-millisecond), carried beside
 * its pid by every claim and removal lock it publishes — a later process reusing the pid carries another; the legacy
 * claim schema carries none. Checked from the process itself, never through a process probe: a claim write lists or
 * names no process (the SUP-02 supervision tripwire), and ps lstart is only second-granular.
 */
const birth = String(performance.timeOrigin);

function readClaim(repoRoot: string, tier: SupervisionTier): Read<Claim> {
  return claimOf(readJson(beatClaimPath(repoRoot, tier)));
}

/** Every recorded pid is a POSITIVE integer; absent (holder), 0, negative, fractional or non-numeric is unreadable. */
function claimOf(rec: Read<Record<string, unknown>>): Read<Claim> {
  if (typeof rec !== "object") return rec;
  if (!text(rec.token) || !positive(rec.pid) || !optional(rec.publisher, positive) || ![rec.birth, rec.publisherBirth].every((b) => optional(b, text))) return "UNREADABLE";
  return { token: rec.token, pid: rec.pid as number, ...(rec.publisher === undefined ? {} : { publisher: rec.publisher as number }) };
}

/** Runs `mutate` as ONE claimed act (claimedAct); `check` is the act's own barrier (owner generation, records). */
export type ClaimGuard = <T>(mutate: () => T, check?: () => void) => T;
/** Outside any claim (a direct call): the barrier, then the mutation. */
export const unclaimed: ClaimGuard = (mutate, check) => { check?.(); return mutate(); };
/** `guard` with `barrier` run ahead of each act's own check, inside the act. */
const barred = (guard: ClaimGuard, barrier: () => void): ClaimGuard => (mutate, check) => guard(mutate, () => { barrier(); check?.(); });

/** Publish atomically: the temporary file, then the rename as one claimed act whose barrier is `check`. */
function publish(path: string, value: unknown, guard: ClaimGuard, check?: () => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value) + "\n"); guard(() => renameSync(tmp, path), check); }
  finally { rmSync(tmp, { force: true }); }
}

/** Names derived from exact claim bytes: `<stem>.reclaim` locks their removal, `<stem>.act.<pid>.<id>` marks an act under them. */
const claimStem = (path: string, bytes: string) => `${path}.${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** The pids inside a claimed act under the bytes `stem` names; a confirmed-dead actor's marker is inert and removed. */
function liveActs(stem: string): number[] {
  const prefix = `${basename(stem)}.act.`;
  return readdirSync(dirname(stem)).filter((name) => name.startsWith(prefix)).flatMap((name) => {
    const pid = Number(name.slice(prefix.length).split(".")[0]);
    if (!confirmedDead(pid)) return [pid];
    rmSync(join(dirname(stem), name), { force: true });
    return [];
  });
}

/**
 * ONE claimed act — every publication, spawn, signal and removal made under a claim. The claim must name `token`;
 * a marker naming this pid is created beside exactly those claim bytes, `check` (the act's own barrier) runs, and
 * LAST the claim is re-verified — no removal of those bytes under way, still the canonical claim — immediately
 * before `mutate`. takeClaim never removes bytes a live act marker names, so no tickmarkr recovery or release lands
 * inside an act; a claim lost before the final check refuses with nothing further done.
 * ponytail: an OUTSIDE edit of the claim landing between that final read and `mutate`'s own syscall is not seen (POSIX
 * has no compare-and-rename); the next act, or the release, refuses on it.
 */
function claimedAct<T>(repoRoot: string, tier: SupervisionTier, token: string, who: string, check: (() => void) | undefined, mutate: () => T): T {
  const path = beatClaimPath(repoRoot, tier);
  const lost = (): never => refuse(`${tier} claim is no longer held by this ${who} — nothing further written, signalled or removed`);
  const bytes = readBytes(path);
  const claim = bytes === undefined ? "NONE" : claimOf(parseJson(bytes));
  if (typeof claim !== "object" || claim.token !== token) lost();
  const stem = claimStem(path, bytes!);
  const marker = `${stem}.act.${process.pid}.${randomUUID()}`;
  writeFileSync(marker, "", { flag: "wx" });
  try {
    check?.();
    // A dead taker's lock is inert here: the claim is re-read below, and a dead taker moves nothing again.
    const taker = lockOwner(`${stem}.reclaim`);
    if (taker && !confirmedDead(taker.pid)) refuse(`${tier} BUSY — a removal of this ${who}'s claim is under way at ${stem}.reclaim by pid ${taker.pid}; nothing further written, signalled or removed`);
    if (readBytes(path) !== bytes) lost();
    return mutate();
  } finally { rmSync(marker, { force: true }); }
}

/**
 * This tier's HELD claim-removal locks (recovery or release), each one whose taker is confirmed dead recovered first
 * (recoverLock; `told` gets the notice): while one is held, a newly linked claim is not yet settled.
 */
function heldLocks(repoRoot: string, tier: SupervisionTier, told: (notice: string) => void): string[] {
  const path = beatClaimPath(repoRoot, tier);
  const prefix = `${basename(path)}.`;
  return readdirSync(dirname(path)).filter((name) => name.startsWith(prefix) && name.endsWith(".reclaim")).flatMap((name) => {
    const lock = join(dirname(path), name);
    const notice = recoverLock(repoRoot, tier, lock);
    if (notice) told(notice);
    const taker = lockOwner(lock);
    return taker ? [`${lock} by pid ${taker.pid}`] : [];
  });
}

/** The owner a removal lock holds — its `owner.<pid>.<nonce>` entry — or undefined: an absent or emptied lock holds nothing. */
function lockOwner(lock: string): { pid: number; nonce: string } | undefined {
  let names: string[];
  try { names = readdirSync(lock); } catch { return undefined; }
  const owner = names.find((name) => name.startsWith("owner."))?.split(".");
  return owner && { pid: Number(owner[1]), nonce: owner[2] };
}

/**
 * Take a removal lock: a directory that appears by ONE rename already holding `owner.<pid>.<nonce>` (this pid's birth
 * inside), so no instant shows it ownerless; it is assembled as `<lock>.<pid>.<nonce>.tmp`, so a taker killed while
 * assembling it leaves a directory named for its pid. A held lock is recovered first when its taker is confirmed dead
 * (`told` gets the notice); a live or unprovable taker refuses BUSY naming it. An emptied lock — released, its owner
 * entry moved out first — holds nothing and the rename simply replaces it. Returns the nonce naming this taker's entries.
 */
function lockRemoval(repoRoot: string, tier: SupervisionTier, lock: string, what: string, told?: (notice: string) => void): string {
  const nonce = randomUUID();
  const tmp = `${lock}.${process.pid}.${nonce}.tmp`;
  try {
    try {
      mkdirSync(tmp);
      writeFileSync(join(tmp, `owner.${process.pid}.${nonce}`), JSON.stringify({ pid: process.pid, birth, takenAt: new Date().toISOString() }) + "\n");
    } catch (error) { refuse(`${tier} ${what} failed at ${lock}: ${(error as Error).message}`); }
    for (let retried = false; ; retried = true) {
      try { renameSync(tmp, lock); return nonce; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") refuse(`${tier} ${what} failed at ${lock}: ${(error as Error).message}`);
      }
      const notice = retried ? undefined : recoverLock(repoRoot, tier, lock);
      if (notice) told?.(notice);
      const taker = lockOwner(lock);
      if (!retried && (notice || !taker)) continue;
      refuse(`${tier} BUSY — ${what} is already under way at ${lock}${taker ? ` by pid ${taker.pid}` : ""}; retry — a removal lock is never taken ` +
        "from a live or unprovable taker, and the next start, stop or legacy write recovers it once its taker is confirmed dead");
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * Release a removal lock: its owner entry is moved OUT beside the lock as `<lock>.<pid>.<nonce>.released` (the lock now
 * holds nothing), then the emptied directory goes (a new taker's lock already in its place stays), then that entry. A
 * taker killed between any two steps leaves the entry named for its pid: status reports it, and the next start, stop
 * or legacy write removes it with the emptied lock (acquireBeatClaim). Only this owner's own entry is ever moved.
 */
function unlock(lock: string, pid: number, nonce: string): void {
  const released = `${lock}.${pid}.${nonce}.released`;
  try { renameSync(join(lock, `owner.${pid}.${nonce}`), released); } catch { return; /* a racing recovery released it first */ }
  try { rmdirSync(lock); } catch { /* not empty: another taker's lock replaced the emptied one */ }
  rmSync(released, { force: true });
}

/**
 * Recover a removal lock whose taker is confirmed dead — killed at any step: bytes it moved aside are discarded when
 * every pid they record is confirmed dead or they are this process's own strand (strandOf: nobody acts under them, and
 * restoring them would only block its own retry), else renamed back over the claim path (as that taker's own put-back
 * would have, displacing only an unsettled claimant); then its owner entry and the emptied lock go. Every step names entries
 * unique to that dead taker, so a racing recovery or a new taker's lock is never touched. Undefined, with nothing
 * done, while the taker is live, unprovable or absent.
 */
function recoverLock(repoRoot: string, tier: SupervisionTier, lock: string): string | undefined {
  const owner = lockOwner(lock);
  if (!owner || !confirmedDead(owner.pid)) return undefined;
  const path = beatClaimPath(repoRoot, tier);
  const aside = join(lock, `claim.${owner.nonce}`);
  const moved = readBytes(aside);
  let fate = "";
  if (moved !== undefined) {
    const held = claimOf(parseJson(moved));
    const dead = typeof held === "object" && confirmedDead(held.pid) && (held.publisher === undefined || confirmedDead(held.publisher));
    const strand = strandOf(path, moved);
    try { if (dead || strand) rmSync(aside); else renameSync(aside, path); } catch { /* a racing recovery resolved it first */ }
    fate = strand ? `, discarding this process's own stranded claim (token ${strand}) it had moved aside`
      : dead ? `, discarding the claim of dead pid ${held.pid} it had moved aside` : `, restoring the claim it had moved aside to ${path}`;
  }
  unlock(lock, owner.pid, owner.nonce);
  return `${tier} recovered the removal lock of killed taker pid ${owner.pid} at ${lock}${fate}`;
}

/**
 * What confirmed-dead invocations left beside the tier's claim — removal locks (by their owner entry), a lock still
 * being assembled or a released lock's owner entry (by the pid in its name), act markers, stage directories — and
 * each owner pid.
 */
function deadLeftovers(repoRoot: string, tier: SupervisionTier): Array<{ path: string; pid: number }> {
  const dir = supervisionDirOf(repoRoot, tier);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const owned = new RegExp(`^${tier}\\.(?:claim\\.[0-9a-f]{16}\\.(?:act|reclaim)|stage)\\.(\\d+)\\.`);
  return names.flatMap((name) => {
    const path = join(dir, name);
    const pid = name.startsWith(`${tier}.claim.`) && name.endsWith(".reclaim") ? lockOwner(path)?.pid : Number(owned.exec(name)?.[1]);
    return pid !== undefined && confirmedDead(pid) ? [{ path, pid }] : [];
  });
}

/**
 * Atomic first-writer-wins claim. A held claim is BUSY unless `reclaim` (every claimant passes its boundaries) confirms
 * DEAD every pid parsed from the claim's own bytes — its holder and any launched writer publishing under it
 * (reclaimDeadClaim): then exactly those bytes are removed (takeClaim) and the claim is taken; the returned notice says
 * so (on a refusal, `BeatRefusal.notice` does). A live, reused or unreadable holder or publisher is never taken over.
 * A linked claim is SETTLED (returned) only when no claim removal is under way and it is still the canonical claim: a
 * removal's put-back may replace a claim linked into its gap, so until that removal ends the claim holds nothing — the
 * claimant withdraws exactly its own linked bytes (takeClaim) and refuses BUSY, so no caller, a long-lived bridge
 * included, is left holding a live claim nobody acts under; its next attempt links afresh. When another live taker
 * holds or has moved aside those very bytes (a mistaken death proof included), the withdrawal cannot land then; once
 * this attempt refuses, its token is no longer in use, so the bytes are this process's STRAND wherever they are
 * (strandOf), proven from the bytes alone: every later attempt in this process withdraws them from the claim path
 * first (withdrawStrand) and discards them from a killed taker's lock instead of restoring them (recoverLock) — so
 * recovery never waits for the caller to exit.
 */
export function acquireBeatClaim(repoRoot: string, tier: SupervisionTier, token: string, reclaim?: BeatLifecycleDeps): string | undefined {
  const path = beatClaimPath(repoRoot, tier);
  const tmp = `${path}.${token}.tmp`;
  const key = `${path}\n${token}`;
  inUse.add(key); // until this attempt refuses or its release ends: bytes under this token are not yet a strand
  let own = "";
  try {
    mkdirSync(dirname(path), { recursive: true });
    own = JSON.stringify({ tier, token, pid: process.pid, birth, claimedAt: new Date().toISOString() }) + "\n";
    writeFileSync(tmp, own);
  } catch (error) {
    inUse.delete(key);
    try { rmSync(tmp, { force: true }); } catch { /* the path that failed holds nothing to remove */ }
    refuse(`${tier} claim failed at ${path}: ${(error as Error).message}`);
  }
  const link = () => {
    try { linkSync(tmp, path); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") refuse(`${tier} claim failed at ${path}: ${(error as Error).message}`);
      return false;
    }
  };
  const ours = () => { const claim = readClaim(repoRoot, tier); return typeof claim === "object" && claim.token === token; };
  const notices: string[] = [];
  const told = (notice: string) => { notices.push(notice); };
  try {
    withdrawStrand(repoRoot, tier, told);
    const linked = link() || ours();
    const reclaimed = !linked && reclaim !== undefined && reclaimDeadClaim(repoRoot, tier, reclaim, told);
    const busy = (why: string): never => refuse(`${tier} BUSY — ${why}`);
    if (linked || (reclaimed && link())) {
      const pending = heldLocks(repoRoot, tier, told);
      if (pending.length > 0) {
        // Unsettled: withdraw the claim this attempt linked (exactly its own bytes, takeClaim), so a caller that lives on
        // — a bridge, not only an exiting CLI — never leaves a live claim nobody acts under; a retry links afresh.
        // The bytes under this token wherever they are — re-read, never `own`: the linked bytes may be an earlier
        // attempt's under the same token. Any still out once this refusal ends the token's use are this process's strand.
        let left = "";
        const current = readBytes(path);
        try { if (current !== undefined && ours()) takeClaim(repoRoot, tier, current, "withdrawal of an unsettled claim", false, told); } catch (error) {
          if (!(error instanceof BeatRefusal)) throw error;
          left = ` (${error.message})`;
        }
        const out = tokenBytesAt(repoRoot, tier, token);
        if (out.length > 0) {
          left = `; its own unsettled claim is still out at ${out.join(", ")}${left} — it is this process's strand: once no live taker holds it, ` +
            "this process's next start, stop or legacy write withdraws it wherever a taker left it, and once this process exits any of them reclaims it";
        }
        busy(`a claim removal (dead-claim recovery or release) is under way at ${pending[0]}; a claim linked before it ends holds nothing yet — retry ` +
          `(the next start, stop or legacy write recovers that lock once its taker is confirmed dead)${left}`);
      }
      if (ours()) {
        // Settled: clear what confirmed-dead invocations left — act markers, stage directories, a half-assembled lock, a
        // released lock's owner entry with its emptied lock (an empty lock is nobody's) — their held locks: recoverLock.
        const swept = deadLeftovers(repoRoot, tier).filter(({ path: left }) => !left.endsWith(".reclaim"));
        for (const { path: left } of swept) {
          if (left.endsWith(".released")) try { rmdirSync(left.replace(/\.\d+\.[\w-]+\.released$/, "")); } catch { /* absent, or a taker holds it */ }
          rmSync(left, { recursive: true, force: true });
        }
        for (const { path: left, pid } of swept) told(`${tier} removed ${basename(left)}, left by dead pid ${pid}`);
        return notices.length > 0 ? notices.join("\n") : undefined;
      }
    }
    const holderBytes = readBytes(path);
    const strand = strandOf(path, holderBytes);
    const cover = strand ? lockOwner(`${claimStem(path, holderBytes!)}.reclaim`) : undefined;
    if (strand) busy(`this process's own stranded claim (token ${strand}) occupies ${path}${cover ? ` under the removal lock of pid ${cover.pid}` : ""}; ` +
      "retry — this process's next start, stop or legacy write withdraws it once no live taker holds it");
    const holder = holderBytes === undefined ? "NONE" : claimOf(parseJson(holderBytes));
    const publisher = typeof holder === "object" && holder.publisher !== undefined ? ` with its launched writer pid ${holder.publisher}` : "";
    busy(`${typeof holder === "object" ? `pid ${holder.pid} holds` : "an unreadable claim occupies"} ${path}${publisher}; ` +
      "retry after it finishes (a live, reused or unreadable holder is never taken over; only a claim whose recorded pids are all confirmed dead is taken over)");
  } catch (error) {
    inUse.delete(key);
    // A reclaim or recovery this attempt performed rides on its refusal, so the caller can still report it.
    throw notices.length > 0 && error instanceof BeatRefusal ? new BeatRefusal(error.message, notices.join("\n")) : error;
  } finally { rmSync(tmp, { force: true }); }
}

const readBytes = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return undefined; } };

/** `${claim path}\n${token}` of every claim an invocation in this process is acquiring or still holds. */
const inUse = new Set<string>();

/**
 * The token of claim `bytes` that are this process's STRAND, else undefined: they record this process's own pid and
 * checked birth (so this process wrote them) under a token no invocation of it is acquiring or holding (so nobody acts
 * under them). Proven from the bytes alone, wherever a compliant taker left them — linked, moved aside, put back or
 * restored — never from having seen a withdrawal run. Only this process can prove it; to any other process the
 * holder is live until this process exits, when they are a dead claim.
 */
function strandOf(path: string, bytes: string | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const rec = parseJson(bytes);
  return typeof rec === "object" && rec.pid === process.pid && rec.birth === birth && text(rec.token) && !inUse.has(`${path}\n${rec.token}`)
    ? rec.token : undefined;
}

/**
 * Withdraw this process's strand from the claim path — exactly those bytes (takeClaim, which first recovers a lock
 * whose taker is confirmed dead). A live taker holding them leaves them in place; the claimant's BUSY then names them.
 */
function withdrawStrand(repoRoot: string, tier: SupervisionTier, told: (notice: string) => void): void {
  const path = beatClaimPath(repoRoot, tier);
  const bytes = readBytes(path);
  const strand = strandOf(path, bytes);
  if (!strand) return;
  try {
    if (takeClaim(repoRoot, tier, bytes!, "withdrawal of this process's stranded claim", false, told)) told(`${tier} withdrew this process's own stranded claim (token ${strand}) at ${path}`);
  } catch (error) { if (!(error instanceof BeatRefusal)) throw error; }
}

/**
 * Every copy of claim bytes, read-only: the claim path, and each one moved aside inside a removal lock — each with the
 * lock that holds it or, for the claim path, the lock its exact bytes would be removed under (absent: no taker).
 */
function claimCopies(repoRoot: string, tier: SupervisionTier): Array<{ file: string; bytes: string; lock: string }> {
  const path = beatClaimPath(repoRoot, tier);
  const list = (dir: string) => { try { return readdirSync(dir).map((name) => join(dir, name)); } catch { return []; } };
  const locks = list(dirname(path)).filter((lock) => basename(lock).startsWith(`${basename(path)}.`) && lock.endsWith(".reclaim"));
  const at = (file: string, lock?: string) => {
    const bytes = readBytes(file);
    return bytes === undefined ? [] : [{ file, bytes, lock: lock ?? `${claimStem(path, bytes)}.reclaim` }];
  };
  return [...at(path), ...locks.flatMap((lock) => list(lock).filter((file) => basename(file).startsWith("claim.")).flatMap((file) => at(file, lock)))];
}

/** Where bytes under `token` still are: the claim path, or moved aside inside a removal lock. */
function tokenBytesAt(repoRoot: string, tier: SupervisionTier, token: string): string[] {
  return claimCopies(repoRoot, tier).filter(({ bytes }) => { const claim = claimOf(parseJson(bytes)); return typeof claim === "object" && claim.token === token; })
    .map(({ file }) => file);
}

/**
 * This process's strands (strandOf) wherever a compliant taker left them, read-only: each named with where it is and
 * the taker whose removal lock holds or covers it; `live` collects the pids of those takers not confirmed dead.
 */
function strandsNamed(repoRoot: string, tier: SupervisionTier, live: number[]): string[] {
  const path = beatClaimPath(repoRoot, tier);
  return claimCopies(repoRoot, tier).flatMap(({ file, bytes, lock }) => {
    const token = strandOf(path, bytes);
    if (!token) return [];
    const taker = lockOwner(lock);
    const dead = taker !== undefined && confirmedDead(taker.pid);
    if (taker && !dead) live.push(taker.pid);
    return [`this process's own stranded claim (token ${token}, held by no invocation of pid ${process.pid})${file === path ? "" : ` moved aside into ${basename(lock)}`}` +
      (taker ? ` under the removal lock of ${dead ? "dead" : "live"} taker pid ${taker.pid}` : "")];
  });
}

/**
 * The ONE way a claim is ever removed — dead-claim recovery and a holder's own release alike: ONLY when the canonical
 * claim is still exactly `checked`, and never inside a claimed act under those bytes. One taker per checked bytes: the
 * lock named by their digest appears atomically WITH its owner (lockRemoval); a live act marker under them refuses BUSY
 * (a release first waits up to 2 s for its launched writer's act to finish); then the claim is re-read under the lock
 * and moved aside into it atomically, and bytes that are not `checked` once moved are renamed straight back. That
 * put-back displaces no holder: a claimant that linked into the gap finds this lock and is not settled
 * (acquireBeatClaim), so it never acted under that claim, and its next attempt finds the restored claim BUSY. An act
 * starting meanwhile finds the lock and refuses (claimedAct). True when exactly `checked` was removed; false when the
 * claim was not those bytes (left or put back). A taker killed at ANY step leaves a lock naming its dead pid — and the
 * moved-aside bytes once it got that far — which the next start, stop or legacy write recovers (recoverLock); one
 * killed while assembling or releasing the lock leaves an entry named for its pid, which that writer removes
 * (acquireBeatClaim). A claimant that linked into the gap withdraws its own unsettled claim before it refuses.
 */
function takeClaim(repoRoot: string, tier: SupervisionTier, checked: string, what: string, waitActs = false, told?: (notice: string) => void): boolean {
  const path = beatClaimPath(repoRoot, tier);
  const stem = claimStem(path, checked);
  const lock = `${stem}.reclaim`;
  const nonce = lockRemoval(repoRoot, tier, lock, what, told);
  const aside = join(lock, `claim.${nonce}`);
  let kept = false;
  try {
    for (let spins = 0; ; spins++) {
      const acting = liveActs(stem);
      if (acting.length === 0) break;
      if (!waitActs || spins >= 200) refuse(`${tier} BUSY — pid ${acting[0]} is inside a claimed act under this claim; ${what} left it in place — retry`);
      Atomics.wait(PAUSE, 0, 0, 10);
    }
    if (readBytes(path) !== checked) return false;
    try { renameSync(path, aside); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      refuse(`${tier} ${what} failed at ${path}: ${(error as Error).message}`);
    }
    if (readBytes(aside) === checked) { rmSync(aside); return true; }
    try { renameSync(aside, path); } catch {
      kept = true;
      refuse(`${tier} BUSY — the claim was replaced during ${what} and could not be put back; it is kept at ${aside}, ` +
        `and the next start, stop or legacy write restores it once pid ${process.pid} has exited`);
    }
    return false;
  } finally { if (!kept) unlock(lock, process.pid, nonce); }
}

/**
 * Take over the claim ONLY when every pid parsed from the checked bytes — the holder, and the launched writer recorded
 * as publishing under a launch claim — is confirmed dead and the claim is still exactly those bytes (takeClaim). The
 * pids are parsed from these checked bytes, never from a second read, so the death proven belongs to exactly the
 * snapshot removed. A settled writer recorded as a launch claim's publisher releases it itself (releaseDeadLaunch).
 */
function reclaimDeadClaim(repoRoot: string, tier: SupervisionTier, deps: BeatLifecycleDeps, told: (notice: string) => void): boolean {
  const path = beatClaimPath(repoRoot, tier);
  const checked = readBytes(path);
  if (checked === undefined) return false;
  const holder = claimOf(parseJson(checked));
  if (typeof holder !== "object") return false;
  const dead = (pid: number) => { try { return deps.identity(pid) === "DEAD"; } catch { return false; } }; // a failed inspection proves nothing
  const publisher = holder.publisher === undefined ? "" : ` and its launched writer pid ${holder.publisher}`;
  if (!dead(holder.pid) || (holder.publisher !== undefined && !dead(holder.publisher))) return false;
  if (!takeClaim(repoRoot, tier, checked, `recovery of dead pid ${holder.pid}'s claim`, false, told)) return false;
  told(`${tier} reclaimed the claim of dead pid ${holder.pid}${publisher} (token ${holder.token}) at ${path} — its holder exited without releasing it`);
  return true;
}

/** The ONE finite contention policy shared by every waiting claimant: loop ticks, legacy one-shots and stop. */
export const BEAT_CLAIM_WAIT = { tries: 20, intervalMs: 250 } as const;
export interface ClaimWait { tries?: number; intervalMs?: number; sleep: (ms: number) => Promise<void> }

/** The wait policy a claimant runs under: absent fields default to BEAT_CLAIM_WAIT; anything else refuses first. */
function claimWait(tier: SupervisionTier, waits: ClaimWait): { tries: number; intervalMs: number } {
  const { tries = BEAT_CLAIM_WAIT.tries, intervalMs = BEAT_CLAIM_WAIT.intervalMs } = waits;
  const whole = (v: number) => Number.isSafeInteger(v) && v > 0;
  if (!whole(tries) || !whole(intervalMs)) refuse(`${tier} claim wait refused — tries ${tries} and interval ${intervalMs} ms must be positive integers; nothing written`);
  return { tries, intervalMs };
}

/**
 * Acquire under the wait policy; a holder still there at the last attempt refuses with the named BUSY. Every
 * reclaim notice an attempt produced — also one whose own link then lost — is kept and leads the final
 * success or refusal, so a recovery is never reported as a plain no-op.
 */
async function acquireWaiting(
  repoRoot: string, tier: SupervisionTier, token: string, waits: ClaimWait, reclaim?: BeatLifecycleDeps,
): Promise<string | undefined> {
  const { tries, intervalMs } = claimWait(tier, waits);
  const notices: string[] = [];
  const told = (message: string) => [...notices, message].join("\n");
  for (let attempt = 1; ; attempt++) {
    try {
      const notice = acquireBeatClaim(repoRoot, tier, token, reclaim);
      if (notice) notices.push(notice);
      return notices.length > 0 ? notices.join("\n") : undefined;
    } catch (error) {
      if (!(error instanceof BeatRefusal)) throw error;
      if (error.notice) notices.push(error.notice);
      if (!error.message.includes(" BUSY — ")) refuse(told(error.message));
      if (attempt >= tries) refuse(told(tries > 1 ? `${error.message}; still held after ${tries} attempts ${intervalMs} ms apart` : error.message));
      await waits.sleep(intervalMs);
    }
  }
}

/** The claim this invocation acquired still names it — the check before reporting success under a launcher's claim. */
function stillHeld(repoRoot: string, tier: SupervisionTier, token: string, who = "invocation"): void {
  const claim = readClaim(repoRoot, tier);
  if (typeof claim !== "object" || claim.token !== token) refuse(`${tier} claim is no longer held by this ${who} — nothing further written, signalled or removed`);
}

/**
 * Release removes exactly the bytes that name this token (takeClaim), after any claimed act under them — a launched
 * writer's included — has finished: a replacement found at any instant is left in place. However it ends, the token is
 * then no longer in use: bytes under it that a live taker kept or moved aside are this process's strand (strandOf),
 * withdrawn or discarded by its next attempt. `told` gets the notice of a dead taker's lock recovered on the way.
 */
export function releaseBeatClaim(repoRoot: string, tier: SupervisionTier, token: string, told?: (notice: string) => void): void {
  const path = beatClaimPath(repoRoot, tier);
  try {
    const checked = readBytes(path);
    const claim = checked === undefined ? "NONE" : claimOf(parseJson(checked));
    if (typeof claim !== "object" || claim.token !== token || !takeClaim(repoRoot, tier, checked!, "release", true, told)) {
      refuse(`${tier} claim changed before release — left in place`);
    }
  } catch (error) {
    if (!(error instanceof BeatRefusal) || tokenBytesAt(repoRoot, tier, token).length === 0) throw error;
    refuse(`${error.message}; its bytes are this process's strand — its next start, stop or legacy write withdraws them, and once it exits any of them reclaims them`);
  } finally { inUse.delete(`${path}\n${token}`); }
}

const DIR = Symbol("directory");
/** What occupies a record path: its bytes, DIR (mirrored so a staged writer refuses it exactly as it would), or nothing. */
function recordAt(path: string): Buffer | typeof DIR | undefined {
  try { return statSync(path).isDirectory() ? DIR : readFileSync(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * Run ONE supervision.ts writer (stand-down, arm or beat) under a claim without letting it touch the tier: it writes
 * into a STAGED copy of the tier's records (arm, clear-duty latch, beat, stand-down marker), then every record it
 * changed is committed by one rename — a discharged latch by one removal — as ONE claimed act each (`guard`), in the
 * writers' own order (arm, raised latch, beat, marker, discharged latch). Compare-and-commit: inside each act, after
 * the caller's own barrier (its owner generation) and before the final claim check, every record must still be
 * exactly what this write was staged from (or what it committed itself) — a record replaced meanwhile, the owner by
 * the caller's barrier, refuses with nothing further committed. A claim lost, or a record or owner replaced, before
 * the first commit therefore lands nothing; one lost between two commits lands nothing further; either refuses. What a
 * failing writer published before its failure is committed the same way, then the failure is rethrown.
 * ponytail: staging stands in for a commit guard supervision.ts's atomic writers do not take; a writer killed mid-write
 * leaves an inert `<tier>.stage.<pid>.<uuid>` directory (no reader lists it), which the next start, stop or legacy
 * write removes once that pid is confirmed dead (acquireBeatClaim).
 */
export function supervised<T>(repoRoot: string, tier: SupervisionTier, guard: ClaimGuard, write: (root: string) => T): T {
  const stage = join(supervisionDirOf(repoRoot, tier), `${tier}.stage.${process.pid}.${randomUUID()}`);
  // supervision.ts's record names; its clear-duty latch path is private there, so it is spelled here.
  const records = (root: string) => [
    supervisionArmPath(root, tier), join(supervisionDirOf(root, tier), `${tier}.clear-owed`), supervisionBeatPath(root, tier), supervisionStandDownPath(root, tier),
  ];
  const [real, staged] = [records(repoRoot), records(stage)];
  const same = (a: ReturnType<typeof recordAt>, b: ReturnType<typeof recordAt>) => a === b || (a instanceof Buffer && b instanceof Buffer && a.equals(b));
  try {
    mkdirSync(dirname(staged[0]), { recursive: true });
    const before = real.map((path, i) => {
      const found = recordAt(path);
      if (found === DIR) mkdirSync(staged[i]); else if (found) writeFileSync(staged[i], found);
      return found;
    });
    let result: T | undefined;
    let failure: { error: unknown } | undefined;
    try { result = write(stage); } catch (error) { failure = { error }; }
    if (existsSync(join(stage, stateDirName(stage), ".gitignore"))) tickmarkrDir(repoRoot); // the writer creates the ignore file
    const after = staged.map(recordAt);
    const expected = [...before];
    const unchanged = () => {
      const moved = real.find((path, i) => !same(recordAt(path), expected[i]));
      if (moved) refuse(`${tier} superseded — ${moved} changed while this write was staged (the tier reads ${supervisionStatus(repoRoot, tier).state}); nothing further committed`);
    };
    for (const i of after[1] === undefined ? [0, 2, 3, 1] : [0, 1, 2, 3]) {
      if (same(before[i], after[i])) continue;
      guard(() => { if (after[i] === undefined) rmSync(real[i], { force: true }); else renameSync(staged[i], real[i]); }, unchanged);
      expected[i] = after[i];
    }
    if (failure) throw failure.error;
    return result as T;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/**
 * A legacy writer: the launch generation it carries (if any), its seat, the arm a running loop holds, the
 * boundaries its checks read through, and where the notice of a dead claim it reclaimed goes.
 */
export interface LegacyWriter {
  generation?: string; seat: string; settled?: boolean; arm?: SupervisionArm; deps: BeatLifecycleDeps; noticed?: (notice: string) => void;
}
/**
 * The recheck a legacy write calls immediately before it mutates; `arm` is the arm the writer itself holds, and
 * `created` says this writer published that arm under this claim a moment ago (an owned re-arm).
 */
export type LegacyRecheck = (arm?: SupervisionArm, created?: boolean) => void;

/**
 * Run one legacy write (one-shot tick, new arm, EVERY loop tick, stand-down) under the tier claim. A launched
 * child acts under its launcher's claim (underLaunchClaim) while that claim is still held for its generation, names
 * this child as its publisher and its launcher is not confirmed dead; afterwards it takes the tier claim itself like
 * every other writer. `act` receives the recheck it must call before it writes (the tier's ownership still admits
 * this writer, then the claim still names this holder) and the guard every supervision write it makes commits under
 * (supervised): each commit is one claimed act whose barrier re-runs that same ownership check. A claim held by
 * anyone else is waited out under BEAT_CLAIM_WAIT (20 attempts 250 ms apart, absent `waits` fields default to it)
 * and then refuses BUSY with nothing written; invalid tries/interval refuse before any claim or write. Like start
 * and stop, the writer reclaims a claim whose recorded pids are all confirmed dead (`noticed` receives the notice): a
 * legacy --loop writer killed inside its claimed tick never strands the --stand-down migration step, and a live
 * writer's claim is never taken. Under its own claim, the release that follows `act` is the claim's last check: a claim
 * lost by then refuses, never reports success. Under the launcher's claim no release follows and nothing is checked
 * after the last act — each act verified the claim last — so the launcher's release after its read-back never ends
 * the loop it launched. A dead or abandoned generation recorded for this writer's seat is retired first (retireDead).
 */
export async function withLegacyClaim<T>(
  repoRoot: string, tier: SupervisionTier, writer: LegacyWriter,
  act: (recheck: LegacyRecheck, held: ClaimGuard) => T | Promise<T>, waits: ClaimWait = { sleep: writer.deps.sleep },
): Promise<T> {
  claimWait(tier, waits); // before every branch, the launch-claim shortcut included: an invalid policy writes nothing
  const { generation, settled = false } = writer;
  const held = (token: string): [LegacyRecheck, ClaimGuard] => {
    // The exact owner this claim's previous recheck validated: the generation every later recheck is held to.
    let checked: BeatOwner | undefined;
    let last: [SupervisionArm | undefined, boolean | undefined] = [writer.arm, false];
    const claimOnly: ClaimGuard = (mutate, check) => claimedAct(repoRoot, tier, token, "writer", check, mutate);
    const owned = () => { checked = assertLegacyOwnership(repoRoot, tier, writer, last[0], last[1], checked, claimOnly); };
    return [(arm = writer.arm, created) => {
      last = [arm, created];
      owned();
      stillHeld(repoRoot, tier, token, "writer");
    }, barred(claimOnly, owned)];
  };
  if (generation !== undefined) {
    if (underLaunchClaim(repoRoot, tier, generation, writer.deps)) {
      const [recheck, guard] = held(generation);
      recheck();
      // Before its first claimed act, this writer is recorded as the launch claim's publisher (namePublisher).
      let named = false;
      // No check follows the last act: every act verified the claim LAST, so what landed, landed under it — and the
      // launcher releasing its claim after its read-back (start returning ARMED) never ends the loop it launched.
      return act(recheck, (mutate, check) => {
        if (!named) { namePublisher(repoRoot, tier, generation); named = true; }
        return guard(mutate, check);
      });
    }
    if (!settled) refuse(`${tier} superseded — the launch claim for generation ${generation} is gone, names another writer, or its launcher is dead`);
    releaseDeadLaunch(repoRoot, tier, generation, writer);
  }
  const token = randomUUID();
  const notice = await acquireWaiting(repoRoot, tier, token, waits, writer.deps);
  if (notice) writer.noticed?.(notice);
  return holding(repoRoot, tier, token, async () => {
    const [recheck, guard] = held(token);
    if (generation === undefined && readBeatOwner(repoRoot, tier) !== "NONE") {
      // A dead or abandoned generation recorded for this seat is retired first (retireDead) — its owner removed, its arm
      // left to the write asked for (a one-shot records its beat on it) — then that write proceeds as an unowned one.
      const checked = inspectBeat(repoRoot, tier, writer.seat, writer.deps, true);
      if (checked.kind === "OWN-DEAD" || checked.kind === "ABANDONED") {
        writer.noticed?.(retireDead(repoRoot, tier, checked, writer.deps, (mutate, check) => claimedAct(repoRoot, tier, token, "writer", check, mutate), false));
      }
    }
    recheck();
    return act(recheck, guard);
  }, writer.noticed);
}

/**
 * Whether a launched writer may act under its launcher's claim for `generation`: only while the launcher it names is
 * not confirmed dead and the claim names no other publisher. Read-only: before its first claimed act the writer is
 * recorded as that claim's publisher (namePublisher), so no recovery takes the claim while it publishes under it
 * (reclaimDeadClaim). Once its launcher is dead, a settled writer releases that claim (releaseDeadLaunch) and takes
 * the tier claim itself; an unsettled one refuses, its launch abandoned.
 */
function underLaunchClaim(repoRoot: string, tier: SupervisionTier, generation: string, deps: BeatLifecycleDeps): boolean {
  const claim = readClaim(repoRoot, tier);
  if (typeof claim !== "object" || claim.token !== generation || (claim.publisher ?? process.pid) !== process.pid) return false;
  let launcher: IdentityRead = "UNKNOWN";
  try { launcher = deps.identity(claim.pid); } catch { /* an inspection failure proves nothing */ }
  return launcher !== "DEAD";
}

/**
 * A settled launched writer recorded as publishing under a launch claim whose launcher is confirmed dead is that
 * claim's last live party: it removes exactly those bytes (takeClaim) with a notice, so neither recovery nor stop is
 * left waiting on a claim nobody will release. A launcher killed before it bound this generation's arm epoch left an
 * owner nobody can prove or stop: the writer then exits (refuses) once that claim is released, so the next start, stop
 * or legacy write finds an ABANDONED launch — no claim, its recorded pid dead — and retires it (retireDead).
 */
function releaseDeadLaunch(repoRoot: string, tier: SupervisionTier, generation: string, writer: LegacyWriter): void {
  const path = beatClaimPath(repoRoot, tier);
  const bytes = readBytes(path);
  const claim = bytes === undefined ? "NONE" : claimOf(parseJson(bytes));
  if (typeof claim !== "object" || claim.token !== generation || claim.publisher !== process.pid) return;
  let launcher: IdentityRead = "UNKNOWN";
  try { launcher = writer.deps.identity(claim.pid); } catch { /* an inspection failure proves nothing */ }
  if (launcher !== "DEAD" || !takeClaim(repoRoot, tier, bytes!, `release of dead launcher pid ${claim.pid}'s claim`, false, writer.noticed)) return;
  writer.noticed?.(`${tier} released the launch claim of dead launcher pid ${claim.pid} (token ${generation}) it published under at ${path}`);
  const owner = readBeatOwner(repoRoot, tier);
  if (typeof owner === "object" && owner.generation === generation && owner.armEpoch === undefined) {
    refuse(`${tier} superseded — launcher pid ${claim.pid} died before binding generation ${generation}'s arm epoch; this writer exits, ` +
      `and the next start, stop or legacy write retires the abandoned launch`);
  }
}

/** Record this process as the launch claim's publisher, by one claimed act that replaces exactly the bytes it read. */
function namePublisher(repoRoot: string, tier: SupervisionTier, generation: string): void {
  const path = beatClaimPath(repoRoot, tier);
  const bytes = readBytes(path);
  const rec = bytes === undefined ? "NONE" : parseJson(bytes);
  const claim = claimOf(rec);
  if (typeof claim === "object" && claim.publisher === process.pid) return;
  if (typeof rec !== "object" || typeof claim !== "object" || claim.token !== generation || claim.publisher !== undefined) {
    refuse(`${tier} claim is no longer held by this launched writer — the launch claim for generation ${generation} changed before it published under it; nothing written`);
  }
  publish(path, { ...rec, publisher: process.pid, publisherBirth: birth }, (mutate, check) => claimedAct(repoRoot, tier, generation, "launched writer", check, mutate),
    () => { if (readBytes(path) !== bytes) refuse(`${tier} superseded — the launch claim for generation ${generation} changed; nothing written`); });
}

/** The ownership a legacy writer needs before each mutation: its own COMPLETE launched generation, or no owner at all. */
export function assertLegacyOwnership(
  repoRoot: string, tier: SupervisionTier, writer: LegacyWriter, arm?: SupervisionArm, created = false, held?: BeatOwner,
  claimed: ClaimGuard = unclaimed,
): BeatOwner | undefined {
  if (writer.generation !== undefined) return assertOwnedGeneration(repoRoot, tier, { ...writer, generation: writer.generation }, arm, created, held, claimed);
  const owner = readBeatOwner(repoRoot, tier);
  if (owner !== "NONE") {
    refuse(`${tier} is owned by a detached beat (${typeof owner === "object" ? `seat ${owner.seat}, generation ${owner.generation}` : "unreadable owner record"})` +
      ` — run \`tickmarkr beat stop ${tier} ${typeof owner === "object" ? seatFlag(owner.seat) : "--seat <seat>"}\` first`);
  }
  return undefined;
}

const sameOwner = (a: BeatOwner, b: Read<BeatOwner>) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The ONE owner change a writer accepts from someone else: its launcher completing an UNBOUND owner — publishing
 * this writer's own pid and/or binding the epoch of the arm this writer itself holds. Verified field by field
 * against the record the writer last checked; everything else the record says must be unchanged.
 */
function launcherBound(before: BeatOwner, after: BeatOwner, pid: number, arm?: SupervisionArm): boolean {
  if (before.armEpoch !== undefined) return false;
  const fixed = (o: BeatOwner) => JSON.stringify([o.tier, o.seat, o.generation, o.armId, o.cwd, o.startedAt, o.priorArmId, o.priorArmEpoch]);
  const proc = (o: BeatOwner) => JSON.stringify([o.pid, o.birth, o.command, o.pgid]);
  const published = before.pid === undefined && after.pid === pid;
  const bound = after.armEpoch !== undefined;
  return fixed(before) === fixed(after) && (published || proc(before) === proc(after)) && (published || bound) &&
    (!bound || (after.pid === pid && arm !== undefined && after.armId === arm.armId && after.armEpoch === arm.armEpoch));
}

/**
 * ONE RULE: every legacy write is preceded by the shared complete owned-generation check of the CURRENT owner
 * record and durable arm against the EXACT generation this writer holds — token, seat, pid (once settled), armId
 * and armEpoch. `held` is the owner this claim's previous check validated and `arm` the arm the writer holds (a
 * loop's own arm; before the launcher binds the epoch that arm is the evidence). The first check of a claim by a
 * writer holding neither takes the generation on record; from then on the held generation changes in exactly
 * two verified ways, and any other change — also one between this check's own reads — refuses with no write:
 *  (i) the writer's OWN re-arm (`created`: it published `arm` under this claim after the complete check): the
 *      arm on disk must be exactly that arm and the owner exactly the owner checked before the arm write; only
 *      then is the owner rebound to the arm (same token, seat, process), and the complete check runs AGAIN as
 *      the new generation before the beat. After any mismatch the owner is never rewritten.
 * (ii) the launcher completing an UNBOUND owner for this writer (launcherBound) — never adopted from disk.
 * Once `settled` (past its first beat) the record must name its pid: a launch that refused without proving it
 * could signal its child leaves no pid behind, and that child retires itself.
 */
export function assertOwnedGeneration(
  repoRoot: string, tier: SupervisionTier, writer: LegacyWriter & { generation: string }, arm = writer.arm, created = false,
  held?: BeatOwner, claimed: ClaimGuard = unclaimed, pid = process.pid,
): BeatOwner {
  const { generation, seat, settled = false, deps } = writer;
  const otherArm = (owner: BeatOwner) => arm !== undefined && (arm.armId !== owner.armId || (owner.armEpoch !== undefined && arm.armEpoch !== owner.armEpoch));
  const binds = (owner: BeatOwner) => `${tier} superseded — the owner record binds arm ${owner.armId} (epoch ${owner.armEpoch ?? "unbound"}), not this writer's arm ${arm?.armId} (epoch ${arm?.armEpoch}); nothing written`;
  const changed = (owner: Read<BeatOwner>): never => refuse(typeof owner === "object" && otherArm(owner) ? binds(owner)
    : `${tier} superseded — the owner record changed under generation ${generation} while it was checked; nothing written`);
  let expected = held;
  for (let moved = false; ; moved = true) {
    const owner = readBeatOwner(repoRoot, tier);
    if (owner === "UNREADABLE") refuse(`${tier} owner record is unreadable — this loop cannot prove it is still owned`);
    // The generation speaks for its recorded seat only: another seat carrying the same generation is foreign.
    if (owner !== "NONE" && owner.generation === generation && owner.seat !== seat) refuse(`${tier} is owned by seat ${owner.seat}, not ${seat} — nothing written`);
    if (owner === "NONE" || owner.generation !== generation || (owner.pid !== undefined && owner.pid !== pid)) {
      refuse(`${tier} superseded — the owner record no longer names generation ${generation}`);
    }
    if (settled && owner.pid === undefined) refuse(`${tier} superseded — generation ${generation} never recorded pid ${pid}; its launch was abandoned`);
    // `moved`: the shared check below saw the owner change between its reads — only the launcher's step passes.
    if (expected !== undefined && (moved || !sameOwner(expected, owner)) && !launcherBound(expected, owner, pid, arm)) changed(owner);
    expected = owner;
    if (arm && created && owner.armEpoch !== undefined && otherArm(owner)) {
      if (held === undefined) refuse(`${tier} superseded — generation ${generation} re-armed without its complete check; owner left in place`);
      const next = { ...owner, armId: arm.armId, armEpoch: arm.armEpoch };
      // The rebind's own claimed act: inside it, the arm is exactly the arm just created and the owner exactly the one checked.
      publish(beatOwnerPath(repoRoot, tier), next, claimed, () => {
        const records = checkedRecords(repoRoot, tier, deps);
        if (records.kind === "UNKNOWN") refuse(`${tier} UNREADABLE — ${records.reason}; owner left in place`);
        if (records.arm?.armId !== arm.armId || records.arm.armEpoch !== arm.armEpoch) {
          refuse(`${tier} superseded — durable arm ${records.arm ? `${records.arm.armId} (epoch ${records.arm.armEpoch})` : "(absent)"} replaced the arm ${arm.armId} (epoch ${arm.armEpoch}) generation ${generation} just created; owner left in place`);
        }
        const current = readBeatOwner(repoRoot, tier);
        if (!sameOwner(owner, current)) changed(current);
      });
      requireOwned(checkOwnedGeneration(repoRoot, tier, expectedGeneration(next), deps, undefined, true), tier);
      return next;
    }
    const check = checkOwnedGeneration(repoRoot, tier, { owner, armEpoch: owner.armEpoch ?? arm?.armEpoch }, deps, undefined, true);
    if (check.kind === "UNKNOWN" && check.reason === OWNER_CHANGED) continue;
    requireOwned(check, tier);
    // Records that agree with each other are still another generation when they are not the arm this writer holds.
    if (otherArm(owner)) refuse(binds(owner));
    return owner;
  }
}

export type CheckedBeat =
  | { kind: "EMPTY" }
  | { kind: "DISARMED"; seat?: string }
  | { kind: "OWN-LIVE"; owner: BeatOwner & { pid: number }; advancing: boolean }
  | { kind: "OWN-DEAD"; owner: BeatOwner & { pid: number } }
  | { kind: "ABANDONED"; owner: BeatOwner; reason: string }
  | { kind: "FOREIGN"; reason: string; migrate?: string }
  | { kind: "PID-REUSED"; owner: BeatOwner & { pid: number } }
  | { kind: "UNKNOWN"; reason: string };

const sameIdentity = (a: { birth?: string; command?: string; cwd: string }, id: IdentityRead): id is ProcessIdentity =>
  typeof id === "object" && id.birth === a.birth && id.command === a.command && id.cwd === a.cwd;
const sameProcess = (owner: BeatOwner, id: IdentityRead): id is ProcessIdentity => sameIdentity(owner, id);
/**
 * Linux frees an exiting process's memory (its argv) before its cwd and before it is a zombie, so in that window ps prints
 * `[comm]` beside the same birth, group and cwd. Before AND after any signal that reading is UNKNOWN — never an accepted
 * identity, never death: a subsequent complete read or confirmed death decides. A generation not yet bound to a birth
 * can only be torn down; once bound, a `[comm]` with another birth, group or cwd is a genuine foreign identity (MISMATCH).
 */
const tearingDown = (a: { birth?: string; pgid?: number; cwd: string }, id: ProcessIdentity): boolean =>
  /^\[.+\]$/.test(id.command) && (a.birth === undefined || (id.birth === a.birth && id.pgid === a.pgid && id.cwd === a.cwd));

/** The durable arm, or UNREADABLE for a torn one — never mistaken for no arm. */
function armOf(repoRoot: string, tier: SupervisionTier): SupervisionArm | undefined | "UNREADABLE" {
  try { return readSupervisionArm(repoRoot, tier); } catch { return "UNREADABLE"; }
}

/**
 * The authoritative records' own fault, or undefined when beat, marker and durable arm all validate. Read
 * independently of each other: a valid stand-down marker never masks a malformed beat ({} or wrong types).
 */
type RecordsFault = { kind: "UNKNOWN"; reason: string };
type CheckedRecords = {
  kind: "RECORDS";
  writer: Read<Record<string, unknown>>;
  arm: SupervisionArm | undefined;
  state: ReturnType<typeof supervisionStatus>;
};

function checkedRecords(repoRoot: string, tier: SupervisionTier, deps: BeatLifecycleDeps): CheckedRecords | RecordsFault {
  const writer = readJson(supervisionBeatPath(repoRoot, tier));
  if (typeof writer === "object" && !validBeat(writer, tier)) return { kind: "UNKNOWN", reason: `beat record ${supervisionBeatPath(repoRoot, tier)} is malformed` };
  const state = supervisionStatus(repoRoot, tier, deps.now());
  if (writer === "UNREADABLE" || state.state === "UNREADABLE") return { kind: "UNKNOWN", reason: "the tier's supervision records are unreadable" };
  const arm = armOf(repoRoot, tier);
  if (arm === "UNREADABLE") return { kind: "UNKNOWN", reason: `durable arm ${supervisionArmPath(repoRoot, tier)} is unreadable` };
  return { kind: "RECORDS", writer, arm, state };
}

/**
 * An arm that is neither this generation's COMPLETE arm (armId and, once bound, armEpoch) nor — only while the
 * launch has not yet bound its epoch — the fenced arm it launched over, has replaced it.
 */
const replacedArm = (arm: SupervisionArm | undefined, owner: BeatOwner): string | undefined => {
  // Once the epoch is bound, an ABSENT arm proves nothing: ownership is the durable arm, so it is a mismatch.
  if (arm === undefined) return owner.armEpoch === undefined ? undefined : "(absent)";
  if (arm.armId === owner.armId) {
    return owner.armEpoch === undefined || arm.armEpoch === owner.armEpoch ? undefined : `${arm.armId} (epoch ${arm.armEpoch})`;
  }
  const prior = owner.armEpoch === undefined && arm.armId === owner.priorArmId && arm.armEpoch === owner.priorArmEpoch;
  return prior ? undefined : arm.armId;
};

/** An identity after the barrier: reasoned UNKNOWN and teardown argv are UNKNOWN, with `unreadable` saying why. */
type SettledIdentity = ProcessIdentity | "DEAD" | "UNKNOWN";
type OwnedCheck =
  | { kind: "OWNED"; records: CheckedRecords; identity: SettledIdentity; unreadable?: string }
  | { kind: "UNKNOWN" | "FOREIGN"; reason: string; mutationReason?: string };

// The child's beat can prove its arm epoch before the owner publication binds it. Keep that evidence
// separately from the expected owner bytes so a failed publication never promotes the current arm.
type ExpectedGeneration = { owner: BeatOwner; armEpoch?: string };
const expectedGeneration = (owner: BeatOwner): ExpectedGeneration => ({ owner, armEpoch: owner.armEpoch });

/**
 * ONE owned-generation barrier for inspection, launch, retirement and rollback. `expected` is the snapshot
 * the caller owns, never a replacement read from disk. Every identity inspection goes through this barrier:
 * identity FIRST, then fresh, independently validated beat/marker/arm records and the exact expected owner.
 * A caller without a process to inspect still uses the same barrier immediately before publishing/removing.
 */
function checkOwnedGeneration(
  repoRoot: string, tier: SupervisionTier, snapshot: ExpectedGeneration, deps: BeatLifecycleDeps, pid?: number, launching = false,
): OwnedCheck {
  const expected = snapshot.owner;
  let read: IdentityRead = "UNKNOWN";
  if (pid !== undefined) {
    try { read = deps.identity(pid); } catch { /* an inspection failure proves neither life nor death */ }
  }
  const unreadable = typeof read === "object" ? (tearingDown(expected, read) ? `pid ${pid} shows teardown argv ${read.command}; a complete read or confirmed death decides` : undefined)
    : read.startsWith("UNKNOWN — ") ? read.slice("UNKNOWN — ".length) : undefined;
  const identity: SettledIdentity = unreadable !== undefined ? "UNKNOWN" : read as SettledIdentity;
  const records = checkedRecords(repoRoot, tier, deps);
  if (records.kind === "UNKNOWN") return records;
  const current = readBeatOwner(repoRoot, tier);
  if (current === "UNREADABLE") return { kind: "UNKNOWN", reason: `malformed owner record ${beatOwnerPath(repoRoot, tier)}` };
  if (JSON.stringify(current) !== JSON.stringify(expected)) return {
    kind: "UNKNOWN", reason: OWNER_CHANGED,
    mutationReason: `the owner record no longer names this generation; generation ${expected.generation} was replaced before its stop — left in place`,
  };
  const armOwner = { ...expected, armEpoch: snapshot.armEpoch ?? expected.armEpoch };
  const replaced = replacedArm(records.arm, armOwner);
  if (replaced) return {
    kind: "FOREIGN", reason: `durable arm ${replaced} is not generation ${expected.generation}'s arm`,
    mutationReason: `durable arm ${replaced} replaced generation ${expected.generation}'s arm — left in place`,
  };
  if (!launching && armOwner.armEpoch === undefined && records.arm?.armId === expected.armId) return {
    kind: "UNKNOWN", reason: `generation ${expected.generation} never proved its arm epoch; the current arm cannot authorize cleanup`,
  };
  return { kind: "OWNED", records, identity, ...(unreadable !== undefined ? { unreadable } : {}) };
}

const why = (check: { unreadable?: string }) => check.unreadable ? ` (${check.unreadable})` : "";

function requireOwned(check: OwnedCheck, tier: SupervisionTier): Extract<OwnedCheck, { kind: "OWNED" }> {
  if (check.kind !== "OWNED") refuse(`${tier} ${check.mutationReason ?? `${check.kind === "UNKNOWN" ? "UNREADABLE" : "MISMATCH"} — ${check.reason}; left in place`}`);
  return check;
}

/** Freshness retains the existing mtime boundaries; payload attribution also requires a post-launch beat. */
function advancingBeat(records: CheckedRecords, owner: BeatOwner): boolean {
  const w = typeof records.writer === "object" ? records.writer : {};
  return records.state.state === "ARMED" && owner.armEpoch !== undefined &&
    records.arm?.armId === owner.armId && records.arm.armEpoch === owner.armEpoch &&
    w.tier === owner.tier && w.seat === owner.seat && w.armId === owner.armId && w.armEpoch === owner.armEpoch &&
    w.pid === owner.pid && w.exitedWriterPid === undefined &&
    Date.parse(w.beatAt as string) >= Date.parse(owner.startedAt);
}

/**
 * The checked state of one tier, read-only: no claim, no write, no signal. Every authoritative record —
 * owner, marker, beat and durable arm — is validated before any outcome is selected, and ownership binds to
 * this repository's canonical root, the recorded seat and the recorded arm before the process is consulted.
 * An UNBOUND owner (no pid, or no arm epoch) is a launch in progress only while a claim is held: a launch publishes and
 * binds only under its own claim. So when the caller holds the tier claim (`held`), or no claim exists before and after
 * the owner is read (status), an unbound owner with no live recorded process is ABANDONED — its launcher died — and
 * the next start, stop or legacy write retires it (retireDead); a live recorded process keeps it UNKNOWN.
 */
export function inspectBeat(repoRoot: string, tier: SupervisionTier, seat: string | undefined, deps: BeatLifecycleDeps, held = false): CheckedBeat {
  const unclaimedBefore = held || readClaim(repoRoot, tier) === "NONE";
  const owner = readBeatOwner(repoRoot, tier);
  if (owner === "UNREADABLE") return { kind: "UNKNOWN", reason: `malformed owner record ${beatOwnerPath(repoRoot, tier)}` };
  const initial = checkedRecords(repoRoot, tier, deps);
  if (initial.kind === "UNKNOWN") return initial;
  const tierState = initial.state;
  if (owner === "NONE") {
    if (tierState.state === "ABSENT") return { kind: "EMPTY" };
    if (tierState.state === "DISARMED") return { kind: "DISARMED", ...(tierState.seat ? { seat: tierState.seat } : {}) };
    const migrate = legacyExit(tier, tierState.seat, initial.writer, deps);
    return {
      kind: "FOREIGN", reason: `${tierState.state} by an unowned writer${tierState.seat ? ` (seat ${tierState.seat})` : " that recorded no seat — none is invented"}`,
      ...(migrate ? { migrate } : {}),
    };
  }
  const root = realpathSync(repoRoot);
  if (owner.cwd !== root) return { kind: "FOREIGN", reason: `owner record names repository ${owner.cwd}, not ${root}` };
  if (seat !== undefined && owner.seat !== seat) return { kind: "FOREIGN", reason: `owned by seat ${owner.seat}, not ${seat}` };
  const unbound = owner.pid === undefined || owner.armEpoch === undefined;
  const idle = unbound && unclaimedBefore && (held || readClaim(repoRoot, tier) === "NONE");
  const checked = checkOwnedGeneration(repoRoot, tier, expectedGeneration(owner), deps, owner.pid, idle);
  if (checked.kind !== "OWNED") return checked;
  const id = checked.identity;
  if (unbound) {
    const what = owner.pid === undefined ? "recorded no process" : "never bound its arm epoch";
    if (idle && (owner.pid === undefined || id === "DEAD")) return {
      kind: "ABANDONED", owner, reason: `generation ${owner.generation} ${what} and no launch holds the claim${owner.pid === undefined ? "" : `; recorded pid ${owner.pid} is gone`} — its launch was abandoned`,
    };
    return { kind: "UNKNOWN", reason: `generation ${owner.generation} ${what} (launch in progress or abandoned)` };
  }
  const owned = owner as BeatOwner & { pid: number };
  if (id === "DEAD") return { kind: "OWN-DEAD", owner: owned };
  if (id === "UNKNOWN") return { kind: "UNKNOWN", reason: `identity of recorded pid ${owned.pid} is unreadable${checked.unreadable ? ` (${checked.unreadable})` : ""}` };
  if (!sameProcess(owned, id)) return { kind: "PID-REUSED", owner: owned };
  // Advancing means THIS child wrote the fresh beat — tier, seat, arm and its own live pid. A one-shot record
  // (exitedWriterPid) or any other writer reusing the arm id is not the owned child beating.
  return { kind: "OWN-LIVE", owner: owned, advancing: advancingBeat(checked.records, owned) };
}

const shellWord = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The exit for a legacy (unowned, pre-lifecycle) arm: stand it down under its RECORDED seat, then start owns the
 * tier. A loop writer's own pid is named for the operator to stop first when it is not confirmed dead — tickmarkr
 * never signals a process it did not launch, nor takes its live claim. A writer stopped inside its claimed tick
 * leaves a confirmed-dead claim, which the printed --stand-down reclaims (withLegacyClaim). No recorded seat: no
 * recipe, never an invented one.
 */
function legacyExit(tier: SupervisionTier, seat: string | undefined, writer: Read<Record<string, unknown>>, deps: BeatLifecycleDeps): string | undefined {
  if (seat === undefined) return undefined;
  const pid = typeof writer === "object" && positive(writer.pid) ? writer.pid as number : undefined;
  let id: IdentityRead = "DEAD";
  if (pid !== undefined) try { id = deps.identity(pid); } catch { id = "UNKNOWN"; }
  const first = id === "DEAD" ? "" : typeof id === "object" ? `stop pid ${pid} first (its legacy --loop writer; the stand-down reclaims a claim it dies holding), then `
    : `pid ${pid}'s identity is unreadable — confirm it is gone or stop it first, then `;
  return `migrate the legacy writer: ${first}run \`tickmarkr beat ${tier} ${seatFlag(seat)} --stand-down\` and start again`;
}
// A seat beginning with a dash would parse as an option after a bare --seat: it rides the --seat=<seat> form.
const seatFlag = (seat: string) => seat.startsWith("-") ? `--seat=${shellWord(seat)}` : `--seat ${shellWord(seat)}`;
const migrating = (checked: { migrate?: string }) => checked.migrate ? ` — ${checked.migrate}` : "";

/**
 * Status: the recorded liveness, rendered without writing; healthy states exit 0, the rest nonzero. It is observation
 * only: a claim whose recorded pids are all dead, what a killed taker or writer left, or — read in the process that
 * stranded it (a bridge) — that process's own strand (strandOf), is REPORTED (nonzero) with the pids and the exact
 * command that recovers it — never recovered here, and no file is touched.
 */
export function beatStatus(repoRoot: string, tier: SupervisionTier, seat: string | undefined, deps: BeatLifecycleDeps): { out: string; code: number } {
  const checked = inspectBeat(repoRoot, tier, seat, deps);
  const claim = readClaim(repoRoot, tier);
  const dead = (pid: number) => { try { return deps.identity(pid) === "DEAD"; } catch { return false; } };
  const deadClaim = typeof claim === "object" && dead(claim.pid) && (claim.publisher === undefined || dead(claim.publisher));
  const publisher = typeof claim === "object" && claim.publisher !== undefined ? ` with its launched writer pid ${claim.publisher}` : "";
  // Every holder is named: the claim's, and each removal lock's taker not confirmed dead (a removal under way).
  const dir = supervisionDirOf(repoRoot, tier);
  const names = (() => { try { return readdirSync(dir); } catch { return []; } })();
  const removing = names.filter((name) => name.startsWith(`${tier}.claim.`) && name.endsWith(".reclaim")).flatMap((name) => {
    const taker = lockOwner(join(dir, name));
    return taker && !confirmedDead(taker.pid) ? [`a claim removal under way at ${name} by pid ${taker.pid}`] : [];
  });
  const holders = [...(claim === "NONE" ? [] : [typeof claim === "object" ? `claim held by ${deadClaim ? "dead " : ""}pid ${claim.pid}${publisher}` : "unreadable claim"]), ...removing];
  const busy = holders.length > 0 ? ` · BUSY (${holders.join("; ")})` : "";
  const live: number[] = [];
  const left = [...strandsNamed(repoRoot, tier, live), ...deadLeftovers(repoRoot, tier).map(({ path, pid }) => `${basename(path)} of dead pid ${pid}`)];
  const owner = readBeatOwner(repoRoot, tier);
  const recorded = typeof owner === "object" ? owner.seat : supervisionStatus(repoRoot, tier, deps.now()).seat ?? seat;
  const waiting = live.length > 0 ? ` once live taker pid ${[...new Set(live)].join(", ")} has finished or exited (until then it refuses BUSY naming it)` : "";
  const recover = deadClaim || left.length > 0
    ? ` · left behind: ${[...(deadClaim ? ["the dead claim"] : []), ...left].join(", ")} — run \`tickmarkr beat stop ${tier} ${recorded ? seatFlag(recorded) : "--seat <seat>"}\` ` +
      `to recover it${waiting} (status reports, never recovers)` : "";
  const row = ((): [string, number] => {
    switch (checked.kind) {
      case "EMPTY": return ["ABSENT — no beat recorded", 0];
      case "DISARMED": return [`DISARMED${checked.seat ? ` (${checked.seat})` : ""}`, 0];
      case "OWN-LIVE": return checked.advancing
        ? [`ARMED (${checked.owner.seat}) — detached pid ${checked.owner.pid}, generation ${checked.owner.generation}`, 0]
        : [`STALE (${checked.owner.seat}) — detached pid ${checked.owner.pid} is alive but its beat is not advancing`, 1];
      case "OWN-DEAD": return [`STALE (${checked.owner.seat}) — recorded pid ${checked.owner.pid} is gone; run \`tickmarkr beat stop ${tier} ${seatFlag(checked.owner.seat)}\``, 1];
      case "ABANDONED": return [`STALE (${checked.owner.seat}) — ${checked.reason}; run \`tickmarkr beat stop ${tier} ${seatFlag(checked.owner.seat)}\``, 1];
      case "FOREIGN": return [`MISMATCH — ${checked.reason}${migrating(checked)}`, 1];
      case "PID-REUSED": return [`MISMATCH — recorded pid ${checked.owner.pid} now belongs to another process`, 1];
      case "UNKNOWN": return [`UNREADABLE — ${checked.reason}`, 1];
    }
  })();
  return { out: `${tier} ${row[0]}${busy}${recover}`, code: recover ? 1 : row[1] };
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Every reclaim and recovery notice — the claim's, and its release's — leads the lifecycle's outcome, success or refusal alike. */
async function noticed(notices: string[], run: () => Promise<string>): Promise<string> {
  try {
    const out = await run();
    return [...notices, out].join("\n");
  } catch (error) {
    if (error instanceof BeatRefusal && notices.length > 0) throw new BeatRefusal([...notices, error.message].join("\n"));
    throw error;
  }
}

/**
 * The identity reader's own tool, proven on this live process before start writes anything: a reader that
 * names its missing cause (Darwin's lsof) could never prove the child, so start refuses with nothing to undo.
 */
function readerPreflight(tier: SupervisionTier, deps: BeatLifecycleDeps): void {
  let self: IdentityRead = "UNKNOWN";
  try { self = deps.identity(process.pid); } catch { return; }
  if (typeof self === "string" && self.startsWith("UNKNOWN — ")) refuse(`${tier} UNREADABLE — ${self.slice("UNKNOWN — ".length)}; nothing started`);
}

/**
 * Run `body` under the claim `token` and release it. A refusal from the body is never masked by the release
 * refusal that follows a lost claim: both are reported.
 */
async function holding<T>(repoRoot: string, tier: SupervisionTier, token: string, body: () => Promise<T>, told?: (notice: string) => void): Promise<T> {
  let result: T;
  try { result = await body(); } catch (error) {
    try { releaseBeatClaim(repoRoot, tier, token, told); } catch (release) {
      if (error instanceof BeatRefusal) throw new BeatRefusal(`${error.message}; ${(release as Error).message}`);
    }
    throw error;
  }
  releaseBeatClaim(repoRoot, tier, token, told);
  return result;
}

/** start: one claim (a single attempt), one child; exit zero only after this exact child's own advancing beat reads back. */
export async function startBeat(repoRoot: string, tier: SupervisionTier, seat: string, deps: BeatLifecycleDeps): Promise<string> {
  readerPreflight(tier, deps);
  const generation = randomUUID();
  const notices = [await acquireWaiting(repoRoot, tier, generation, { tries: 1, sleep: deps.sleep }, deps)].filter((n) => n !== undefined);
  return noticed(notices, () => holding(repoRoot, tier, generation, () => startClaimed(repoRoot, tier, seat, generation, deps), (n) => notices.push(n)));
}

async function startClaimed(repoRoot: string, tier: SupervisionTier, seat: string, generation: string, deps: BeatLifecycleDeps): Promise<string> {
  let result: string;
  const checked = inspectBeat(repoRoot, tier, seat, deps, true);
  switch (checked.kind) {
    case "EMPTY": case "DISARMED": result = await launch(repoRoot, tier, seat, generation, deps); break;
    case "OWN-LIVE":
      if (!checked.advancing) refuse(`${tier} STALE — owned pid ${checked.owner.pid} is alive but silent; run \`tickmarkr beat stop ${tier} ${seatFlag(seat)}\` first`);
      result = `${tier} already running as ${seat} — detached pid ${checked.owner.pid}, generation ${checked.owner.generation}; checked no-op`;
      break;
    // A dead or abandoned generation is retired first, exactly as stop retires it, then this start launches over it.
    case "OWN-DEAD": case "ABANDONED": {
      const guard: ClaimGuard = (mutate, check) => claimedAct(repoRoot, tier, generation, "start", check, mutate);
      result = await noticed([retireDead(repoRoot, tier, checked, deps, guard)], () => launch(repoRoot, tier, seat, generation, deps));
      break;
    }
    case "FOREIGN": refuse(`${tier} MISMATCH — ${checked.reason}; nothing started${migrating(checked)}`); break;
    case "PID-REUSED": refuse(`${tier} MISMATCH — recorded pid ${checked.owner.pid} now belongs to another process; nothing started`); break;
    case "UNKNOWN": refuse(`${tier} UNREADABLE — ${checked.reason}; nothing started`); break;
  }
  return result!;
}

async function launch(repoRoot: string, tier: SupervisionTier, seat: string, generation: string, deps: BeatLifecycleDeps): Promise<string> {
  const startedAt = deps.now();
  const deadline = startedAt + BEAT_STARTUP_CEILING_MS;
  const prior = armOf(repoRoot, tier);
  const base: BeatOwner = {
    tier, seat, generation, armId: generation, cwd: realpathSync(repoRoot), startedAt: new Date(startedAt).toISOString(),
    ...(typeof prior === "object" ? { priorArmId: prior.armId, priorArmEpoch: prior.armEpoch } : {}),
  };
  // This launch's expected snapshot is carried through EVERY failure, including rollback. Never replace
  // it with a reread owner: even the same token under a different arm epoch is another generation.
  let expected = expectedGeneration(base);
  const snapshot = () => expected;
  // Every mutation below is one claimed act under this launch's claim, its generation barrier inside the act.
  const guard: ClaimGuard = (mutate, check) => claimedAct(repoRoot, tier, generation, "start", check, mutate);
  const owned = () => requireOwned(checkOwnedGeneration(repoRoot, tier, snapshot(), deps, undefined, true), tier);
  try {
    publish(beatOwnerPath(repoRoot, tier), base, guard, () => {
      if (readBeatOwner(repoRoot, tier) !== "NONE") refuse(`${tier} superseded — an owner record appeared before generation ${generation} published its own`);
    });
    owned();
  } catch (error) {
    return rollback(repoRoot, tier, snapshot(), undefined, undefined, deps, `owner publication failed: ${(error as Error).message}`);
  }
  const log = beatLogPath(repoRoot, tier);
  let child: ChildProcess;
  try {
    const fd = guard(() => deps.openLog(log), owned);
    try {
      child = guard(() => deps.spawn(deps.cli[0], [...deps.cli.slice(1), "beat", tier, "--seat", seat, "--loop", "--arm-id", generation], {
        cwd: repoRoot, detached: true, stdio: ["ignore", fd, fd], env: { ...deps.env, [BEAT_GENERATION_ENV]: generation },
      }), owned);
    } finally { closeSync(fd); }
  } catch (error) {
    return rollback(repoRoot, tier, snapshot(), undefined, undefined, deps, `log-open/spawn failed: ${(error as Error).message}`);
  }
  child.on("error", () => { /* surfaced below as a child without a pid or one that exited */ });
  child.unref();
  const pid = child.pid;
  if (!pid) return rollback(repoRoot, tier, snapshot(), child, undefined, deps, "spawn produced no process");
  // Until its identity proves it is this generation's child (this cwd, this generation in its argv), the pid
  // is never a signal target: an unproven rollback retains the record and the child retires itself.
  const proof = checkOwnedGeneration(repoRoot, tier, snapshot(), deps, pid, true);
  if (proof.kind !== "OWNED") return rollback(repoRoot, tier, snapshot(), child, undefined, deps, proof.mutationReason ?? proof.reason);
  const id = proof.identity;
  if (exited(child) || id === "DEAD") return rollback(repoRoot, tier, snapshot(), child, undefined, deps, `child pid ${pid} died before its beat read back (log ${log})`);
  if (id === "UNKNOWN") return rollback(repoRoot, tier, snapshot(), child, undefined, deps, `UNREADABLE — child pid ${pid} identity is unreadable${why(proof)}`);
  if (id.cwd !== base.cwd || !id.command.includes(generation)) {
    return rollback(repoRoot, tier, snapshot(), child, undefined, deps, `child pid ${pid} is not the launched generation (cwd ${id.cwd})`);
  }
  const fail = (why: string) => rollback(repoRoot, tier, snapshot(), child, id, deps, why);
  const captureArm = (records: CheckedRecords) => {
    const w = typeof records.writer === "object" ? records.writer : {};
    if (expected.armEpoch === undefined && w.tier === tier && w.seat === seat && w.armId === generation &&
        w.pid === pid && w.exitedWriterPid === undefined && text(w.armEpoch)) {
      expected = { ...expected, armEpoch: w.armEpoch };
    }
    return requireOwned(checkOwnedGeneration(repoRoot, tier, snapshot(), deps, undefined, true), tier).records;
  };
  try { captureArm(proof.records); } catch (error) { return fail((error as Error).message); }
  // Detached means its OWN session and process group, never "ppid 1": an orphan of a dying session has
  // ppid 1 too and still dies with that session's group.
  if (id.pgid !== pid) return fail(`child pid ${pid} is not detached (process group ${id.pgid})`);
  const record = (next: BeatOwner) => {
    const prior = snapshot();
    const verified = () => requireOwned(checkOwnedGeneration(repoRoot, tier, prior, deps, undefined, true), tier);
    verified();
    // If publication or its read-back fails, the attempted snapshot remains the rollback authority.
    expected = { ...expected, owner: next };
    publish(beatOwnerPath(repoRoot, tier), next, guard, verified); // the prior generation, re-verified inside the act
    return owned().records;
  };
  try { record({ ...base, pid, birth: id.birth, command: id.command, pgid: id.pgid }); } catch (error) {
    return fail(`owner publication failed: ${(error as Error).message}`);
  }
  for (;;) {
    const live = checkOwnedGeneration(repoRoot, tier, snapshot(), deps, pid, true);
    if (live.kind !== "OWNED") return fail(live.mutationReason ?? `UNREADABLE — ${live.reason}`);
    if (exited(child) || live.identity === "DEAD") return fail(`child pid ${pid} died before its beat read back (log ${log})`);
    // Exit can fall between ps and cwd reads. UNKNOWN proves no identity change: yield so the
    // exit is observable, then repeat the full generation/records check within the startup budget.
    if (live.identity === "UNKNOWN") {
      if (deps.now() >= deadline) return fail(`UNREADABLE — child pid ${pid} identity is unreadable during read-back${why(live)}`);
      await deps.sleep(Math.min(100, Math.max(0, deadline - deps.now())));
      continue;
    }
    if (!sameProcess(expected.owner, live.identity)) return fail(`child pid ${pid} changed identity during read-back`);
    let records = live.records;
    if (expected.owner.armEpoch === undefined) {
      // Bind the epoch from the exact child's independently validated beat, never from whatever arm is
      // current after an identity read. A same-id replacement cannot become this launch's authority.
      try {
        records = captureArm(records);
        if (expected.armEpoch !== undefined) records = record({ ...expected.owner, armEpoch: expected.armEpoch });
      } catch (error) { return fail(`owner publication failed: ${(error as Error).message}`); }
    }
    // the read-back is the checked state itself: this exact child, advancing, over validated records
    if (advancingBeat(records, expected.owner)) break;
    if (deps.now() >= deadline) return fail(`no beat from pid ${pid} within ${BEAT_STARTUP_CEILING_MS} ms (log ${log})`);
    await deps.sleep(Math.min(100, Math.max(0, deadline - deps.now())));
  }
  // The final barrier, in order: identity, then the owner record and the COMPLETE durable arm re-read after it,
  // then the records' own schema — and the ceiling LAST, so time spent in these blocking reads counts too.
  const final = checkOwnedGeneration(repoRoot, tier, snapshot(), deps, pid);
  if (final.kind !== "OWNED") return fail(final.mutationReason ?? `UNREADABLE — ${final.reason}`);
  if (exited(child) || final.identity === "DEAD") return fail(`child pid ${pid} died before its beat read back (log ${log})`);
  if (final.identity === "UNKNOWN") return fail(`UNREADABLE — child pid ${pid} identity is unreadable during read-back${why(final)}`);
  if (!sameProcess(expected.owner, final.identity)) return fail(`child pid ${pid} changed identity during read-back`);
  const advancing = advancingBeat(final.records, expected.owner);
  if (deps.now() - startedAt > BEAT_STARTUP_CEILING_MS) return fail(`startup overran ${BEAT_STARTUP_CEILING_MS} ms`);
  if (!advancing) return fail(`STALE — child pid ${pid}'s beat is not advancing at final read-back`);
  return `${tier} ARMED as ${seat} — detached pid ${pid}, generation ${generation}; log ${log}`;
}

/** Wait until `gone()` holds or the deadline passes; true when it held. */
async function waitFor(gone: () => boolean, ms: number, deps: BeatLifecycleDeps): Promise<boolean> {
  const deadline = deps.now() + ms;
  while (!gone()) {
    if (deps.now() >= deadline) return false;
    await deps.sleep(50);
  }
  return true;
}

/**
 * Undo only what this generation did; anything it cannot prove stays in place and the refusal says so.
 * EVERY signal is preceded by a recheck of both the owner generation and the child's live identity against
 * the identity proven at launch: a replaced generation or an unproven or changed identity is never signalled.
 * Every signal, stand-down commit and removal is then one claimed act under the launch claim (token = this
 * generation) with the owner generation re-verified inside it (the stand-down staged: supervised): a rollback that
 * lost its claim, or whose generation was replaced, signals, writes and removes nothing further and retains the owner.
 */
async function rollback(
  repoRoot: string, tier: SupervisionTier, expected: ExpectedGeneration, child: ChildProcess | undefined,
  proven: ProcessIdentity | undefined, deps: BeatLifecycleDeps, why: string,
): Promise<never> {
  const failed = (what: string): never => refuse(`${tier} start refused: ${why}; ${what}`);
  const guard: ClaimGuard = (mutate, check) => {
    try { return claimedAct(repoRoot, tier, expected.owner.generation, "start", check, mutate); } catch (error) {
      if (error instanceof BeatRefusal && !error.message.startsWith(`${tier} start refused`)) failed(`${error.message}; owner record retained`);
      throw error;
    }
  };
  const ownerRead = () => readBeatOwner(repoRoot, tier);
  const check = (phase: string, pid?: number) => {
    const checked = checkOwnedGeneration(repoRoot, tier, expected, deps, pid);
    if (checked.kind !== "OWNED") failed(`${phase} stopped — ${checked.mutationReason ?? `UNREADABLE — ${checked.reason}`}; ${pid ? `pid ${pid} not signalled` : "left in place"}`);
    return checked as Extract<OwnedCheck, { kind: "OWNED" }>;
  };
  const pid = child?.pid;
  if (child && pid) {
    const unproven = `pid ${pid} not signalled — its identity is not proven to be this generation's child; owner record retained`;
    const gone = () => {
      const checked = check("rollback", pid);
      if (checked.identity === "DEAD") return true;
      // A process exiting can disappear between its ps and cwd reads or show teardown argv. UNKNOWN
      // proves neither death nor a changed identity: wait for checked death, and still require a
      // matching live identity at the separate barrier before any further signal.
      if (proven && checked.identity !== "UNKNOWN" && !sameIdentity(proven, checked.identity)) failed(unproven);
      return false;
    };
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (gone()) break;
      // identity FIRST, ownership re-read after it: a generation replaced during the identity read is not signalled
      let checked = check("rollback", pid);
      // Before a signal, UNKNOWN is decided only by a later complete read or confirmed death — never guessed.
      if (proven && checked.identity === "UNKNOWN") {
        await waitFor(() => check("rollback", pid).identity !== "UNKNOWN", 3_000, deps);
        checked = check("rollback", pid);
      }
      if (checked.identity === "DEAD") break; // confirmed death between the probe and the proof needs no signal
      if (!proven || !sameIdentity(proven, checked.identity)) failed(unproven);
      guard(() => { try { deps.kill(pid, signal); } catch { /* the wait below decides */ } }, () => check("rollback"));
      await waitFor(gone, 3_000, deps);
    }
    if (!gone()) failed(`pid ${pid} did not exit — owner record retained`);
  }
  if (ownerRead() === "NONE") failed("no owner record was published; nothing to roll back");
  try {
    const checked = check("cleanup");
    if (checked.records.arm?.armId === expected.owner.armId) {
      supervised(repoRoot, tier, barred(guard, () => check("cleanup")), (root) => publishStandDown(root, tier, expected.owner.seat));
      check("cleanup");
      if (checkedRecords(repoRoot, tier, deps).kind === "UNKNOWN" || supervisionStatus(repoRoot, tier, deps.now()).state !== "DISARMED") failed("rollback stand-down read-back failed; owner retained");
    }
    removeOwner(repoRoot, tier, expected, deps, guard);
  } catch (error) {
    if (error instanceof BeatRefusal) throw error;
    failed(`rollback cleanup failed: ${(error as Error).message}`);
  }
  if (ownerRead() !== "NONE") failed("owner record could not be removed");
  return failed("rolled back this generation only");
}

/**
 * The ONE recovery of a dead generation — OWN-DEAD (its recorded pid confirmed gone) or ABANDONED (an unbound owner no
 * launch holds, no recorded process alive) — shared by stop, start and every legacy write, under the caller's claim:
 * stand its arm down unless already DISARMED (`standDown`: stop and start; a legacy write leaves the arm to the write it
 * was asked for — a one-shot records its beat on it, --stand-down stands it down, --new-arm/--loop replace it), then
 * remove its owner record, each one claimed act (`held`) with this exact generation re-verified inside it. Nothing is
 * signalled: no live process of that generation is on record (an unrecorded child of an abandoned launch refuses at its
 * next check and exits). Returns the notice naming it.
 */
function retireDead(
  repoRoot: string, tier: SupervisionTier, checked: Extract<CheckedBeat, { kind: "OWN-DEAD" | "ABANDONED" }>, deps: BeatLifecycleDeps, held: ClaimGuard,
  standDown = true,
): string {
  const { owner } = checked;
  const snapshot = expectedGeneration(owner);
  const unbound = owner.armEpoch === undefined;
  const owned = () => { requireOwned(checkOwnedGeneration(repoRoot, tier, snapshot, deps, undefined, unbound), tier); };
  owned();
  const state = supervisionStatus(repoRoot, tier, deps.now()).state;
  if (state === "UNREADABLE") refuse(`${tier} UNREADABLE — the tier's supervision records became unreadable; nothing removed`);
  if (standDown && state !== "DISARMED") supervised(repoRoot, tier, barred(held, owned), (root) => publishStandDown(root, tier, owner.seat));
  owned();
  removeOwner(repoRoot, tier, snapshot, deps, held, unbound);
  return `${tier} recovered dead generation ${owner.generation} (${checked.kind === "OWN-DEAD" ? `recorded pid ${owner.pid} is gone` : checked.reason}): ` +
    `${standDown ? "stood down and removed its owner record" : "removed its owner record, its arm left to this write"}, nothing signalled`;
}

/**
 * stop: retire only the recorded generation, signalling its exact pid, then read back DISARMED. A loop tick
 * holding the claim is waited out under BEAT_CLAIM_WAIT; a claim whose recorded pids are all confirmed dead is
 * reclaimed. Every stand-down commit (supervised), signal and removal is one claimed act under stop's claim (`held`)
 * with the owner generation it acts on re-verified inside it.
 */
export async function stopBeat(repoRoot: string, tier: SupervisionTier, seat: string, deps: BeatLifecycleDeps): Promise<string> {
  const token = randomUUID();
  const notices = [await acquireWaiting(repoRoot, tier, token, { sleep: deps.sleep }, deps)].filter((n) => n !== undefined);
  const guard: ClaimGuard = (mutate, check) => claimedAct(repoRoot, tier, token, "stop", check, mutate);
  return noticed(notices, () => holding(repoRoot, tier, token, () => stopClaimed(repoRoot, tier, seat, guard, deps), (n) => notices.push(n)));
}

async function stopClaimed(repoRoot: string, tier: SupervisionTier, seat: string, held: ClaimGuard, deps: BeatLifecycleDeps): Promise<string> {
  let result: string;
  const checked = inspectBeat(repoRoot, tier, seat, deps, true);
  switch (checked.kind) {
    case "EMPTY":
      supervised(repoRoot, tier, barred(held, () => {
        if (readBeatOwner(repoRoot, tier) !== "NONE") refuse(`${tier} superseded — an owner record appeared during stop; nothing further written`);
      }), (root) => publishStandDown(root, tier, seat));
      result = readBackDisarmed(repoRoot, tier, deps, "published DISARMED; nothing signalled");
      break;
    case "DISARMED": result = `${tier} DISARMED — already stood down; checked no-op`; break;
    case "OWN-LIVE": result = await retire(repoRoot, tier, checked.owner, held, deps); break;
    case "OWN-DEAD": case "ABANDONED": {
      const notice = retireDead(repoRoot, tier, checked, deps, held);
      result = `${notice}\n${readBackDisarmed(repoRoot, tier, deps, checked.kind === "OWN-DEAD" ? `pid ${checked.owner.pid} was already gone; cleaned up, nothing signalled`
        : `generation ${checked.owner.generation}'s abandoned launch cleaned up, nothing signalled`)}`;
      break;
    }
    case "FOREIGN": refuse(`${tier} MISMATCH — ${checked.reason}; nothing signalled or removed${migrating(checked)}`); break;
    case "PID-REUSED": refuse(`${tier} MISMATCH — recorded pid ${checked.owner.pid} now belongs to another process; nothing signalled or removed`); break;
    case "UNKNOWN": refuse(`${tier} UNREADABLE — ${checked.reason}; nothing signalled or removed`); break;
  }
  return result!;
}

/**
 * The generation barrier before every publication, signal and removal. Identity first (while the process is
 * meant to be live), then the owner record, then the durable arm: a replacement published while the identity
 * was being read still refuses, and so does an arm that is no longer this generation's (or is gone).
 */
function recheckOwned(repoRoot: string, tier: SupervisionTier, owner: BeatOwner & { pid: number }, deps: BeatLifecycleDeps, live = true): void {
  const checked = requireOwned(checkOwnedGeneration(repoRoot, tier, expectedGeneration(owner), deps, live ? owner.pid : undefined), tier);
  if (live && checked.identity === "UNKNOWN") refuse(`${tier} UNREADABLE — pid ${owner.pid} identity is unreadable${why(checked)}; nothing signalled`);
  if (live && !sameProcess(owner, checked.identity)) refuse(`${tier} pid ${owner.pid} no longer matches its recorded identity — nothing further signalled`);
}

async function retire(repoRoot: string, tier: SupervisionTier, owner: BeatOwner & { pid: number }, held: ClaimGuard, deps: BeatLifecycleDeps): Promise<string> {
  recheckOwned(repoRoot, tier, owner, deps);
  // Each act below re-verifies this generation (owner, durable arm, records) inside it.
  const owned = barred(held, () => recheckOwned(repoRoot, tier, owner, deps, false));
  supervised(repoRoot, tier, owned, (root) => publishStandDown(root, tier, owner.seat));
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) refuse(`${tier} recorded pid ${owner.pid} is not a positive pid`);
  const read = () => requireOwned(checkOwnedGeneration(repoRoot, tier, expectedGeneration(owner), deps, owner.pid), tier);
  const gone = () => {
    const { identity } = read();
    if (identity !== "DEAD" && identity !== "UNKNOWN" && !sameProcess(owner, identity)) refuse(`${tier} MISMATCH — pid ${owner.pid} changed identity while stopping; owner record retained`);
    return identity === "DEAD";
  };
  // The live recheck after stand-down: the loop may already be exiting on it. Confirmed death needs no signal;
  // UNKNOWN (teardown argv, unreadable cwd) waits for a complete read or confirmed death, never a guess.
  // The await yields: only a fresh complete barrier read after it, with no await before the signal, authorises it.
  let last = read();
  if (last.identity === "UNKNOWN") {
    await waitFor(() => read().identity !== "UNKNOWN", SUPERVISION_BEAT_MS, deps);
    last = read();
  }
  if (last.identity === "UNKNOWN") refuse(`${tier} UNREADABLE — pid ${owner.pid} identity is unreadable after stand-down${why(last)}; nothing signalled, owner record retained`);
  if (last.identity !== "DEAD") {
    if (!sameProcess(owner, last.identity)) refuse(`${tier} pid ${owner.pid} no longer matches its recorded identity — nothing further signalled`);
    let failure: Error | undefined;
    owned(() => { try { deps.kill(owner.pid, "SIGTERM"); } catch (error) { failure = error as Error; } });
    if (failure && !gone()) refuse(`${tier} signal to pid ${owner.pid} failed: ${failure.message}; owner record retained`);
    if (!await waitFor(gone, SUPERVISION_BEAT_MS, deps)) refuse(`${tier} pid ${owner.pid} did not exit after SIGTERM; owner record retained`);
  }
  recheckOwned(repoRoot, tier, owner, deps, false);
  removeOwner(repoRoot, tier, expectedGeneration(owner), deps, held);
  return readBackDisarmed(repoRoot, tier, deps, last.identity === "DEAD"
    ? `pid ${owner.pid} exited on its stand-down (generation ${owner.generation}); nothing signalled`
    : `retired detached pid ${owner.pid} (generation ${owner.generation})`);
}

/** Remove the owner record as one claimed act: the generation barrier inside it, then the final claim check, then the removal. */
function removeOwner(repoRoot: string, tier: SupervisionTier, expected: ExpectedGeneration, deps: BeatLifecycleDeps, held: ClaimGuard, unbound = false): void {
  held(() => rmSync(beatOwnerPath(repoRoot, tier)), () => requireOwned(checkOwnedGeneration(repoRoot, tier, expected, deps, undefined, unbound), tier));
  if (readBeatOwner(repoRoot, tier) !== "NONE") refuse(`${tier} owner record could not be removed — cleanup unacknowledged`);
}

function readBackDisarmed(repoRoot: string, tier: SupervisionTier, deps: BeatLifecycleDeps, what: string): string {
  const checked = checkedRecords(repoRoot, tier, deps);
  if (checked.kind === "UNKNOWN") refuse(`${tier} stop read back UNREADABLE — ${checked.reason}`);
  const state = checked.state.state;
  if (state !== "DISARMED" || readBeatOwner(repoRoot, tier) !== "NONE") refuse(`${tier} stop read back ${state}, not DISARMED`);
  return `${tier} DISARMED — ${what}`;
}
