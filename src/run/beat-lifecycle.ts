import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SUPERVISION_BEAT_MS, isSeatTier, publishStandDown, readSupervisionArm, supervisionArmPath, supervisionBeatPath, supervisionStatus,
  type SupervisionArm, type SupervisionTier,
} from "./supervision.js";

// H + D-1001: the detached beat is OWNED by the product, not by a shell recipe. One claim file per
// (repository, tier) serializes start, stop and the legacy arm-mutating writers; one owner record names
// the exact generation (seat, armId, pid, process birth/argv/cwd) that start launched. Every signal and
// removal rechecks that generation first and reads the result back afterwards, so an older invocation can
// never retire a replacement, and a pid that now belongs to another process is a mismatch, never a target.
// Status takes no claim and writes nothing. Uncertain state is RETAINED and refused (nonzero), never
// guessed: a stale beat is not proof of death and a foreign or stale claim is never stolen.

/** start's whole budget — launch, read-back and any overrun — before it must refuse and roll back. */
export const BEAT_STARTUP_CEILING_MS = 60_000;
/** The generation a started child carries; it lets the child act under its launcher's claim only. */
export const BEAT_GENERATION_ENV = "TICKMARKR_BEAT_GENERATION";

export interface ProcessIdentity { birth: string; command: string; cwd: string; pgid: number }
export type IdentityRead = ProcessIdentity | "DEAD" | "UNKNOWN";

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

export function defaultBeatDeps(): BeatLifecycleDeps {
  return {
    cli: [process.execPath, ...process.execArgv, process.argv[1] ?? ""],
    spawn: nodeSpawn,
    kill: (pid, signal) => { process.kill(pid, signal); },
    identity: readProcessIdentity,
    openLog: (path) => openSync(path, "a"),
    now: Date.now,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    env: process.env,
  };
}

/** A named, nonzero refusal: dispatch renders the message and exits 1. */
export class BeatRefusal extends Error {}
function refuse(message: string): never { throw new BeatRefusal(message); }

/**
 * The live process behind a pid: birth (lstart), full argv, cwd and process group. A missing process is
 * DEAD only when the kernel says so (ESRCH or a zombie); anything unreadable is UNKNOWN, never DEAD.
 */
export function readProcessIdentity(pid: number): IdentityRead {
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "DEAD" : "UNKNOWN";
  }
  const ps = spawnSync("ps", ["-ww", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  const row = /^\s*(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*\S)\s*$/.exec(ps.stdout ?? "");
  if (ps.status !== 0 || !row) {
    try { process.kill(pid, 0); return "UNKNOWN"; } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "DEAD" : "UNKNOWN";
    }
  }
  if (row[2].startsWith("Z")) return "DEAD";
  let cwd: string | undefined;
  try {
    if (process.platform === "linux") cwd = readlinkSync(`/proc/${pid}/cwd`);
    else {
      const lsof = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
      cwd = lsof.stdout?.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    }
  } catch { cwd = undefined; }
  return cwd ? { pgid: Number(row[1]), birth: row[3], command: row[4], cwd } : "UNKNOWN";
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

function readClaim(repoRoot: string, tier: SupervisionTier): Read<{ token: string; pid: number }> {
  const rec = readJson(beatClaimPath(repoRoot, tier));
  if (typeof rec !== "object") return rec;
  return text(rec.token) && Number.isInteger(rec.pid) ? { token: rec.token, pid: rec.pid as number } : "UNREADABLE";
}

function publish(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value) + "\n"); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}

/** Atomic first-writer-wins claim; a held claim is BUSY and is never taken over. */
export function acquireBeatClaim(repoRoot: string, tier: SupervisionTier, token: string): void {
  const path = beatClaimPath(repoRoot, tier);
  const tmp = `${path}.${token}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ tier, token, pid: process.pid, claimedAt: new Date().toISOString() }) + "\n");
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* the path that failed holds nothing to remove */ }
    refuse(`${tier} claim failed at ${path}: ${(error as Error).message}`);
  }
  try {
    linkSync(tmp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") refuse(`${tier} claim failed at ${path}: ${(error as Error).message}`);
    const holder = readClaim(repoRoot, tier);
    refuse(`${tier} BUSY — ${typeof holder === "object" ? `pid ${holder.pid} holds` : "an unreadable claim occupies"} ${path}; ` +
      "retry after it finishes (a claim is never taken over automatically)");
  } finally { rmSync(tmp, { force: true }); }
}

export function releaseBeatClaim(repoRoot: string, tier: SupervisionTier, token: string): void {
  const claim = readClaim(repoRoot, tier);
  if (typeof claim !== "object" || claim.token !== token) refuse(`${tier} claim changed before release — left in place`);
  try { rmSync(beatClaimPath(repoRoot, tier)); }
  catch (error) { refuse(`${tier} claim release failed: ${(error as Error).message}`); }
}

/**
 * A legacy writer: the launch generation it carries (if any), its seat, the arm a running loop holds, and the
 * boundaries its checks read through.
 */
export interface LegacyWriter { generation?: string; seat: string; settled?: boolean; arm?: SupervisionArm; deps: BeatLifecycleDeps }
/**
 * The recheck a legacy write calls immediately before it mutates; `arm` is the arm the writer itself holds, and
 * `created` says this writer published that arm under this claim a moment ago (an owned re-arm).
 */
export type LegacyRecheck = (arm?: SupervisionArm, created?: boolean) => void;

/**
 * Run one legacy write (one-shot tick, new arm, EVERY loop tick, stand-down) under the tier claim. A launched
 * child acts under its launcher's claim while that claim is still held for its generation; afterwards it takes
 * the tier claim itself like every other writer. `act` receives the recheck it must call immediately before it
 * writes: the claim still names this holder and the tier's ownership still admits this writer. A claim held by
 * anyone else refuses with nothing written — `waits` only lets a running loop's tick outlast a brief holder.
 */
export async function withLegacyClaim<T>(
  repoRoot: string, tier: SupervisionTier, writer: LegacyWriter,
  act: (recheck: LegacyRecheck) => T | Promise<T>, waits: { tries: number; sleep: (ms: number) => Promise<void> } = { tries: 1, sleep: async () => {} },
): Promise<T> {
  const { generation, settled = false } = writer;
  const held = (token: string): LegacyRecheck => {
    // The exact owner this claim's previous recheck validated: the generation every later recheck is held to.
    let checked: BeatOwner | undefined;
    return (arm = writer.arm, created) => {
      const claim = readClaim(repoRoot, tier);
      if (typeof claim !== "object" || claim.token !== token) refuse(`${tier} claim is no longer held by this writer — nothing written`);
      checked = assertLegacyOwnership(repoRoot, tier, writer, arm, created, checked);
    };
  };
  if (generation !== undefined) {
    const claim = readClaim(repoRoot, tier);
    if (typeof claim === "object" && claim.token === generation) {
      const recheck = held(generation);
      recheck();
      return act(recheck);
    }
    if (!settled) refuse(`${tier} superseded — the launch claim for generation ${generation} is gone`);
  }
  const token = randomUUID();
  for (let attempt = 1; ; attempt++) {
    try { acquireBeatClaim(repoRoot, tier, token); break; } catch (error) {
      if (attempt >= waits.tries || !(error instanceof BeatRefusal) || !error.message.includes(" BUSY — ")) throw error;
      await waits.sleep(250);
    }
  }
  let result: T;
  try {
    const recheck = held(token);
    recheck();
    result = await act(recheck);
  } finally { releaseBeatClaim(repoRoot, tier, token); }
  return result;
}

/** The ownership a legacy writer needs before each mutation: its own COMPLETE launched generation, or no owner at all. */
export function assertLegacyOwnership(
  repoRoot: string, tier: SupervisionTier, writer: LegacyWriter, arm?: SupervisionArm, created = false, held?: BeatOwner,
): BeatOwner | undefined {
  if (writer.generation !== undefined) return assertOwnedGeneration(repoRoot, tier, { ...writer, generation: writer.generation }, arm, created, held);
  const owner = readBeatOwner(repoRoot, tier);
  if (owner !== "NONE") {
    refuse(`${tier} is owned by a detached beat (${typeof owner === "object" ? `seat ${owner.seat}, generation ${owner.generation}` : "unreadable owner record"})` +
      ` — run \`tickmarkr beat stop ${tier} --seat <seat>\` first`);
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
  held?: BeatOwner, pid = process.pid,
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
      const records = checkedRecords(repoRoot, tier, deps);
      if (records.kind === "UNKNOWN") refuse(`${tier} UNREADABLE — ${records.reason}; owner left in place`);
      if (records.arm?.armId !== arm.armId || records.arm.armEpoch !== arm.armEpoch) {
        refuse(`${tier} superseded — durable arm ${records.arm ? `${records.arm.armId} (epoch ${records.arm.armEpoch})` : "(absent)"} replaced the arm ${arm.armId} (epoch ${arm.armEpoch}) generation ${generation} just created; owner left in place`);
      }
      const current = readBeatOwner(repoRoot, tier);
      if (!sameOwner(owner, current)) changed(current);
      const next = { ...owner, armId: arm.armId, armEpoch: arm.armEpoch };
      publish(beatOwnerPath(repoRoot, tier), next);
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
  | { kind: "FOREIGN"; reason: string }
  | { kind: "PID-REUSED"; owner: BeatOwner & { pid: number } }
  | { kind: "UNKNOWN"; reason: string };

const sameIdentity = (a: { birth?: string; command?: string; cwd: string }, id: IdentityRead): id is ProcessIdentity =>
  typeof id === "object" && id.birth === a.birth && id.command === a.command && id.cwd === a.cwd;
const sameProcess = (owner: BeatOwner, id: IdentityRead): id is ProcessIdentity => sameIdentity(owner, id);

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

type OwnedCheck =
  | { kind: "OWNED"; records: CheckedRecords; identity: IdentityRead }
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
  let identity: IdentityRead = "UNKNOWN";
  if (pid !== undefined) {
    try { identity = deps.identity(pid); } catch { /* an inspection failure proves neither life nor death */ }
  }
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
  return { kind: "OWNED", records, identity };
}

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
 */
export function inspectBeat(repoRoot: string, tier: SupervisionTier, seat: string | undefined, deps: BeatLifecycleDeps): CheckedBeat {
  const owner = readBeatOwner(repoRoot, tier);
  if (owner === "UNREADABLE") return { kind: "UNKNOWN", reason: `malformed owner record ${beatOwnerPath(repoRoot, tier)}` };
  const initial = checkedRecords(repoRoot, tier, deps);
  if (initial.kind === "UNKNOWN") return initial;
  const tierState = initial.state;
  if (owner === "NONE") {
    if (tierState.state === "ABSENT") return { kind: "EMPTY" };
    if (tierState.state === "DISARMED") return { kind: "DISARMED", ...(tierState.seat ? { seat: tierState.seat } : {}) };
    return { kind: "FOREIGN", reason: `${tierState.state} by an unowned writer${tierState.seat ? ` (seat ${tierState.seat})` : ""}` };
  }
  const root = realpathSync(repoRoot);
  if (owner.cwd !== root) return { kind: "FOREIGN", reason: `owner record names repository ${owner.cwd}, not ${root}` };
  if (seat !== undefined && owner.seat !== seat) return { kind: "FOREIGN", reason: `owned by seat ${owner.seat}, not ${seat}` };
  const checked = checkOwnedGeneration(repoRoot, tier, expectedGeneration(owner), deps, owner.pid);
  if (checked.kind !== "OWNED") return checked;
  const id = checked.identity;
  if (owner.pid === undefined) return { kind: "UNKNOWN", reason: `generation ${owner.generation} recorded no process (launch in progress or abandoned)` };
  if (owner.armEpoch === undefined) return { kind: "UNKNOWN", reason: `generation ${owner.generation} never bound its arm epoch (launch in progress or abandoned)` };
  const owned = owner as BeatOwner & { pid: number };
  if (id === "DEAD") return { kind: "OWN-DEAD", owner: owned };
  if (id === "UNKNOWN") return { kind: "UNKNOWN", reason: `identity of recorded pid ${owned.pid} is unreadable` };
  if (!sameProcess(owned, id)) return { kind: "PID-REUSED", owner: owned };
  // Advancing means THIS child wrote the fresh beat — tier, seat, arm and its own live pid. A one-shot record
  // (exitedWriterPid) or any other writer reusing the arm id is not the owned child beating.
  return { kind: "OWN-LIVE", owner: owned, advancing: advancingBeat(checked.records, owned) };
}

/** Status: the recorded liveness, rendered without writing; healthy states exit 0, the rest nonzero. */
export function beatStatus(repoRoot: string, tier: SupervisionTier, seat: string | undefined, deps: BeatLifecycleDeps): { out: string; code: number } {
  const checked = inspectBeat(repoRoot, tier, seat, deps);
  const claim = readClaim(repoRoot, tier);
  const busy = claim === "NONE" ? "" : ` · BUSY (${typeof claim === "object" ? `claim held by pid ${claim.pid}` : "unreadable claim"})`;
  const row = ((): [string, number] => {
    switch (checked.kind) {
      case "EMPTY": return ["ABSENT — no beat recorded", 0];
      case "DISARMED": return [`DISARMED${checked.seat ? ` (${checked.seat})` : ""}`, 0];
      case "OWN-LIVE": return checked.advancing
        ? [`ARMED (${checked.owner.seat}) — detached pid ${checked.owner.pid}, generation ${checked.owner.generation}`, 0]
        : [`STALE (${checked.owner.seat}) — detached pid ${checked.owner.pid} is alive but its beat is not advancing`, 1];
      case "OWN-DEAD": return [`STALE (${checked.owner.seat}) — recorded pid ${checked.owner.pid} is gone; run \`tickmarkr beat stop ${tier} --seat ${checked.owner.seat}\``, 1];
      case "FOREIGN": return [`MISMATCH — ${checked.reason}`, 1];
      case "PID-REUSED": return [`MISMATCH — recorded pid ${checked.owner.pid} now belongs to another process`, 1];
      case "UNKNOWN": return [`UNREADABLE — ${checked.reason}`, 1];
    }
  })();
  return { out: `${tier} ${row[0]}${busy}`, code: row[1] };
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** start: one claim, one child; exit zero only after this exact child's own advancing beat reads back. */
export async function startBeat(repoRoot: string, tier: SupervisionTier, seat: string, deps: BeatLifecycleDeps): Promise<string> {
  const generation = randomUUID();
  acquireBeatClaim(repoRoot, tier, generation);
  let result: string;
  try {
    const checked = inspectBeat(repoRoot, tier, seat, deps);
    switch (checked.kind) {
      case "EMPTY": case "DISARMED": result = await launch(repoRoot, tier, seat, generation, deps); break;
      case "OWN-LIVE":
        if (!checked.advancing) refuse(`${tier} STALE — owned pid ${checked.owner.pid} is alive but silent; run \`tickmarkr beat stop ${tier} --seat ${seat}\` first`);
        result = `${tier} already running as ${seat} — detached pid ${checked.owner.pid}, generation ${checked.owner.generation}; checked no-op`;
        break;
      case "OWN-DEAD": refuse(`${tier} STALE — owned pid ${checked.owner.pid} is gone; run \`tickmarkr beat stop ${tier} --seat ${seat}\` first`); break;
      case "FOREIGN": refuse(`${tier} MISMATCH — ${checked.reason}; nothing started`); break;
      case "PID-REUSED": refuse(`${tier} MISMATCH — recorded pid ${checked.owner.pid} now belongs to another process; nothing started`); break;
      case "UNKNOWN": refuse(`${tier} UNREADABLE — ${checked.reason}; nothing started`); break;
    }
  } finally { releaseBeatClaim(repoRoot, tier, generation); }
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
  try {
    publish(beatOwnerPath(repoRoot, tier), base);
    requireOwned(checkOwnedGeneration(repoRoot, tier, snapshot(), deps, undefined, true), tier);
  } catch (error) {
    return rollback(repoRoot, tier, snapshot(), undefined, undefined, deps, `owner publication failed: ${(error as Error).message}`);
  }
  const log = beatLogPath(repoRoot, tier);
  let child: ChildProcess;
  try {
    const fd = deps.openLog(log);
    try {
      child = deps.spawn(deps.cli[0], [...deps.cli.slice(1), "beat", tier, "--seat", seat, "--loop", "--arm-id", generation], {
        cwd: repoRoot, detached: true, stdio: ["ignore", fd, fd], env: { ...deps.env, [BEAT_GENERATION_ENV]: generation },
      });
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
  if (id === "UNKNOWN") return rollback(repoRoot, tier, snapshot(), child, undefined, deps, `child pid ${pid} identity is unreadable`);
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
    requireOwned(checkOwnedGeneration(repoRoot, tier, snapshot(), deps, undefined, true), tier);
    // If publication or its read-back fails, the attempted snapshot remains the rollback authority.
    expected = { ...expected, owner: next };
    publish(beatOwnerPath(repoRoot, tier), next);
    return requireOwned(checkOwnedGeneration(repoRoot, tier, snapshot(), deps, undefined, true), tier).records;
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
      if (deps.now() >= deadline) return fail(`UNREADABLE — child pid ${pid} identity is unreadable during read-back`);
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
  if (final.identity === "UNKNOWN") return fail(`UNREADABLE — child pid ${pid} identity is unreadable during read-back`);
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
 */
async function rollback(
  repoRoot: string, tier: SupervisionTier, expected: ExpectedGeneration, child: ChildProcess | undefined,
  proven: ProcessIdentity | undefined, deps: BeatLifecycleDeps, why: string,
): Promise<never> {
  const failed = (what: string): never => refuse(`${tier} start refused: ${why}; ${what}`);
  const ownerRead = () => readBeatOwner(repoRoot, tier);
  const check = (phase: string, pid?: number) => {
    const checked = checkOwnedGeneration(repoRoot, tier, expected, deps, pid);
    if (checked.kind !== "OWNED") failed(`${phase} stopped — ${checked.mutationReason ?? `UNREADABLE — ${checked.reason}`}; ${pid ? `pid ${pid} not signalled` : "left in place"}`);
    return checked as Extract<OwnedCheck, { kind: "OWNED" }>;
  };
  const pid = child?.pid;
  if (child && pid) {
    const gone = () => {
      const checked = check("rollback", pid);
      if (checked.identity === "DEAD") return true;
      // A process exiting after our signal can disappear between its ps and cwd reads. UNKNOWN
      // proves neither death nor a changed identity: wait for checked death, and still require a
      // matching live identity at the separate barrier before any further signal.
      if (proven && checked.identity !== "UNKNOWN" && !sameIdentity(proven, checked.identity)) failed(`pid ${pid} not signalled — its identity is not proven to be this generation's child; owner record retained`);
      return false;
    };
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (gone()) break;
      // identity FIRST, ownership re-read after it: a generation replaced during the identity read is not signalled
      const checked = check("rollback", pid);
      if (!proven || !sameIdentity(proven, checked.identity)) {
        failed(`pid ${pid} not signalled — its identity is not proven to be this generation's child; owner record retained`);
      }
      try { deps.kill(pid, signal); } catch { /* the wait below decides */ }
      await waitFor(gone, 3_000, deps);
    }
    if (!gone()) failed(`pid ${pid} did not exit — owner record retained`);
  }
  if (ownerRead() === "NONE") failed("no owner record was published; nothing to roll back");
  try {
    const checked = check("cleanup");
    if (checked.records.arm?.armId === expected.owner.armId) {
      publishStandDown(repoRoot, tier, expected.owner.seat);
      check("cleanup");
      if (checkedRecords(repoRoot, tier, deps).kind === "UNKNOWN" || supervisionStatus(repoRoot, tier, deps.now()).state !== "DISARMED") failed("rollback stand-down read-back failed; owner retained");
    }
    removeOwner(repoRoot, tier, expected, deps);
  } catch (error) {
    if (error instanceof BeatRefusal) throw error;
    failed(`rollback cleanup failed: ${(error as Error).message}`);
  }
  if (ownerRead() !== "NONE") failed("owner record could not be removed");
  return failed("rolled back this generation only");
}

/** stop: retire only the recorded generation, signalling its exact pid, then read back DISARMED. */
export async function stopBeat(repoRoot: string, tier: SupervisionTier, seat: string, deps: BeatLifecycleDeps): Promise<string> {
  const token = randomUUID();
  acquireBeatClaim(repoRoot, tier, token);
  let result: string;
  try {
    const checked = inspectBeat(repoRoot, tier, seat, deps);
    switch (checked.kind) {
      case "EMPTY":
        publishStandDown(repoRoot, tier, seat);
        result = readBackDisarmed(repoRoot, tier, deps, "published DISARMED; nothing signalled");
        break;
      case "DISARMED": result = `${tier} DISARMED — already stood down; checked no-op`; break;
      case "OWN-LIVE": result = await retire(repoRoot, tier, checked.owner, deps); break;
      case "OWN-DEAD": {
        recheckOwned(repoRoot, tier, checked.owner, deps, false);
        const state = supervisionStatus(repoRoot, tier, deps.now()).state;
        if (state === "UNREADABLE") refuse(`${tier} UNREADABLE — the tier's supervision records became unreadable; nothing removed`);
        if (state !== "DISARMED") publishStandDown(repoRoot, tier, checked.owner.seat);
        recheckOwned(repoRoot, tier, checked.owner, deps, false);
        removeOwner(repoRoot, tier, expectedGeneration(checked.owner), deps);
        result = readBackDisarmed(repoRoot, tier, deps, `pid ${checked.owner.pid} was already gone; cleaned up, nothing signalled`);
        break;
      }
      case "FOREIGN": refuse(`${tier} MISMATCH — ${checked.reason}; nothing signalled or removed`); break;
      case "PID-REUSED": refuse(`${tier} MISMATCH — recorded pid ${checked.owner.pid} now belongs to another process; nothing signalled or removed`); break;
      case "UNKNOWN": refuse(`${tier} UNREADABLE — ${checked.reason}; nothing signalled or removed`); break;
    }
  } finally { releaseBeatClaim(repoRoot, tier, token); }
  return result!;
}

/**
 * The generation barrier before every publication, signal and removal. Identity first (while the process is
 * meant to be live), then the owner record, then the durable arm: a replacement published while the identity
 * was being read still refuses, and so does an arm that is no longer this generation's (or is gone).
 */
function recheckOwned(repoRoot: string, tier: SupervisionTier, owner: BeatOwner & { pid: number }, deps: BeatLifecycleDeps, live = true): void {
  const checked = requireOwned(checkOwnedGeneration(repoRoot, tier, expectedGeneration(owner), deps, live ? owner.pid : undefined), tier);
  if (live && !sameProcess(owner, checked.identity)) refuse(`${tier} pid ${owner.pid} no longer matches its recorded identity — nothing further signalled`);
}

async function retire(repoRoot: string, tier: SupervisionTier, owner: BeatOwner & { pid: number }, deps: BeatLifecycleDeps): Promise<string> {
  recheckOwned(repoRoot, tier, owner, deps);
  publishStandDown(repoRoot, tier, owner.seat);
  recheckOwned(repoRoot, tier, owner, deps);
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) refuse(`${tier} recorded pid ${owner.pid} is not a positive pid`);
  const gone = () => {
    const { identity } = requireOwned(checkOwnedGeneration(repoRoot, tier, expectedGeneration(owner), deps, owner.pid), tier);
    if (identity !== "DEAD" && identity !== "UNKNOWN" && !sameProcess(owner, identity)) refuse(`${tier} MISMATCH — pid ${owner.pid} changed identity while stopping; owner record retained`);
    return identity === "DEAD";
  };
  try { deps.kill(owner.pid, "SIGTERM"); } catch (error) {
    if (!gone()) refuse(`${tier} signal to pid ${owner.pid} failed: ${(error as Error).message}; owner record retained`);
  }
  if (!await waitFor(gone, SUPERVISION_BEAT_MS, deps)) refuse(`${tier} pid ${owner.pid} did not exit after SIGTERM; owner record retained`);
  recheckOwned(repoRoot, tier, owner, deps, false);
  removeOwner(repoRoot, tier, expectedGeneration(owner), deps);
  return readBackDisarmed(repoRoot, tier, deps, `retired detached pid ${owner.pid} (generation ${owner.generation})`);
}

function removeOwner(repoRoot: string, tier: SupervisionTier, expected: ExpectedGeneration, deps: BeatLifecycleDeps): void {
  requireOwned(checkOwnedGeneration(repoRoot, tier, expected, deps), tier);
  rmSync(beatOwnerPath(repoRoot, tier));
  if (readBeatOwner(repoRoot, tier) !== "NONE") refuse(`${tier} owner record could not be removed — cleanup unacknowledged`);
}

function readBackDisarmed(repoRoot: string, tier: SupervisionTier, deps: BeatLifecycleDeps, what: string): string {
  const checked = checkedRecords(repoRoot, tier, deps);
  if (checked.kind === "UNKNOWN") refuse(`${tier} stop read back UNREADABLE — ${checked.reason}`);
  const state = checked.state.state;
  if (state !== "DISARMED" || readBeatOwner(repoRoot, tier) !== "NONE") refuse(`${tier} stop read back ${state}, not DISARMED`);
  return `${tier} DISARMED — ${what}`;
}
