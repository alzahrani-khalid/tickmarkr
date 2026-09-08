import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tickmarkrDir, stateDirName } from "../graph/graph.js";
import { parseRunId } from "./journal.js";

// HARD-01/02: coarse per-run advisory lock over .tickmarkr/graph.json. LOCK-02: the lock is created by
// the link(2) idiom — write the full payload to graph.lock.<pid>.tmp, then linkSync(tmp, lockPath),
// which is atomic and throws EEXIST if the lock already exists (the mutual-exclusion primitive).
// rename() was REJECTED: it silently clobbers an existing destination, destroying that mutual
// exclusion (two daemons would both "acquire"). LOCK-02 (OBS-05): a PROVABLY-dead holder (ESRCH)
// self-clears immediately — expiry is NOT required. ESRCH is proof-positive death; the PID-reuse
// hazard runs the OTHER way (a reused pid reads ALIVE and refuses until `tickmarkr unlock`). mtime stays
// the heartbeat — it feeds the reclaim race guard (ino+mtime re-stat) and the reclaimed audit value.
// Zero new deps — node:fs stdlib.
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 60_000; // 6× heartbeat headroom; PITFALLS floor is ≥5s beat / ~30s staleness

// T-10-01: the payload is a trust boundary — parse with zod, fail closed on garbage. Only
// pid/runId/startedAt are ever read; anything else is ignored (info-disclosure surface).
const PayloadSchema = z.object({ pid: z.number().int().positive(), runId: z.string(), startedAt: z.number() });

const lockPath = (repoRoot: string) => join(tickmarkrDir(repoRoot), "graph.lock");
const approvalSerializationPath = (repoRoot: string) => join(tickmarkrDir(repoRoot), "approval.lock");

let heartbeat: NodeJS.Timeout | undefined;
let heldPath: string | undefined;
let approvalSequence = 0;

// Best-effort release if the daemon exits without hitting its finally (crash mid-body). NO
// SIGINT/SIGTERM handlers — those change kill semantics and leak listeners across the test
// suite's many runDaemon calls; signal-death is exactly what stale-reclaim exists for.
process.once("exit", () => { if (heldPath) unlinkIfOurs(heldPath); });

export interface Inspection { pid?: number; runId?: string; garbage: boolean; dead: boolean; expired: boolean; mtimeMs: number; ino: number }
export type RunLineEvent = { event: string; ts: string };

// LOCK-04: the ONE decision table. Both acquireRunLock and isRunLockLive consume this — the two
// hand-maintained copies of the rule cannot drift. The table changes HERE, once. previewUnlock /
// commitUnlock (below) read the SAME underlying snapshot shape with their own eligibility rules
// (matching run ID, provably dead, not garbage) — they are the escape hatch, not a second copy of
// the rule.
// LOCK-02 (OBS-05): refuse iff garbage OR alive. dead (ESRCH) self-clears through the reclaim branch
// below — no 60s heartbeat wait. Expiry no longer participates in the DECISION (Inspect still carries
// `expired` for the race guard + reclaim audit); the heartbeat mechanism itself is untouched.
// ponytail: a pid REUSED by an unrelated live process reads ALIVE (kill(pid,0) succeeds) and now
// refuses indefinitely instead of expiring out in ≤60s — that is the fail-closed direction; the
// escape hatch is `tickmarkr unlock`. Acceptable for a single-machine tool (ESRCH is the only
// proof-positive death; narrowing further needs pid-start-time correlation, out of scope here).
// LOCK-01: garbage ⇒ always refuse (mtime irrelevant). It short-circuits before dead can matter —
// so inspect()'s `dead = pid === undefined` fallback for the garbage row stays harmless. Safe post-16-01:
// the atomic link(2) write means tickmarkr can no longer mint garbage itself; a garbage payload can only
// come from external corruption, which is exactly what must refuse. Only `tickmarkr unlock` removes it
// — a self-heal reclaim would silently overwrite whatever corrupted the file.
export function shouldRefuse(i: Pick<Inspection, "garbage" | "dead">): boolean {
  return i.garbage || !i.dead;
}

// LOCK-04, PID-SCOPED: the same decision table, in the shape a caller holding only a pid can consume.
// Every other liveness export here takes a repository root, so a reader with a pid off a journal row
// had no seam to reach and wrote the four lines itself — twice. One copy was faithful; the other
// treated ANY thrown error as death, so a daemon owned by another user (EPERM) read dead there and
// alive here. A rule that forbids a second `process.kill(pid, 0)` without exporting a usable
// predicate produces exactly those copies, so this is the predicate. no throw ⇒ ALIVE; ESRCH ⇒ the
// only proof-positive death; ANY other errno (EPERM = alive-but-not-ours, EINVAL, …) ⇒ ALIVE,
// because none of them is evidence of death and this table fails closed toward alive.
export function isPidLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (k) { return (k as NodeJS.ErrnoException).code !== "ESRCH"; }
}

// statSync throws ENOENT when no lock exists — callers treat that as "not held".
function inspect(p: string): Inspection {
  const st = statSync(p); // single stat: both the heartbeat mtime and the reclaim-guard inode
  const mtimeMs = st.mtimeMs;
  const expired = Date.now() - mtimeMs > STALE_MS;
  const parsed = PayloadSchema.safeParse(readPayload(p));
  const garbage = !parsed.success; // LOCK-01: its own state — shouldRefuse refuses it unconditionally; only `tickmarkr unlock` removes it
  const pid = parsed.success ? parsed.data.pid : undefined;
  // harmless fallback for the garbage row — garbage short-circuits shouldRefuse before this is read
  const dead = pid === undefined ? true : !isPidLive(pid);
  return { pid, runId: parsed.success ? parsed.data.runId : undefined, garbage, dead, expired, mtimeMs, ino: st.ino };
}

function readPayload(p: string): unknown {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function unlinkIfOurs(p: string): void {
  try {
    const parsed = PayloadSchema.safeParse(readPayload(p));
    if (parsed.success && parsed.data.pid === process.pid) unlinkSync(p);
  } catch { /* ENOENT — nothing to release */ }
}

export function acquireRunLock(repoRoot: string, runId: string): { reclaimed?: { pid: number; mtimeMs: number } } {
  const p = lockPath(repoRoot);
  const tmp = join(tickmarkrDir(repoRoot), `graph.lock.${process.pid}.tmp`);
  try {
    try { unlinkSync(tmp); } catch { /* W6: best-effort clean of our own stray tmp from a prior SIGKILL */ }
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, runId, startedAt: Date.now() }));
    try {
      linkSync(tmp, p); // atomic: exists ⇒ EEXIST — replaces the old exclusive-create open, no write window on the lock path
    } finally {
      unlinkSync(tmp); // the link survives; tmp is just a handle. finally ⇒ no litter, even for the EEXIST loser
    }
    heldPath = p;
    heartbeat = setInterval(() => { try { const now = new Date(); utimesSync(p, now, now); } catch { /* released */ } }, HEARTBEAT_MS);
    heartbeat.unref(); // never hold the daemon's event loop open
    return {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const insp = inspect(p);
    const { pid, runId: heldRun, garbage, mtimeMs } = insp;
    if (!shouldRefuse(insp)) {
      // ponytail: inode+mtime guard NARROWS but does not close the cross-process reclaim double-unlink
      // race; a real fix needs unlink-by-inode (no POSIX primitive) or a lock-directory rename dance.
      // Single-machine tool — this is the ceiling.
      const st = statSync(p); // re-stat immediately before removing — abort if replaced since inspect()
      if (st.ino !== insp.ino || st.mtimeMs !== insp.mtimeMs) return acquireRunLock(repoRoot, runId); // loser path
      try { unlinkSync(p); } catch (e2) { if ((e2 as NodeJS.ErrnoException).code !== "ENOENT") throw e2; } // successor already took it
      const again = acquireRunLock(repoRoot, runId); // re-serializes two stealers through linkSync
      return { reclaimed: { pid: pid ?? -1, mtimeMs }, ...again };
    }
    const stateDir = stateDirName(repoRoot);
    if (garbage) throw new Error(`${stateDir}/graph.lock holds an unreadable/garbage payload — refusing to reclaim it; run \`tickmarkr unlock --garbage\` to remove it`);
    // LOCK-02: shouldRefuse is false whenever dead, so this throw is reached only for a LIVE holder
    // (incl. EPERM = alive-but-not-ours). The dead-but-fresh case self-clears via the reclaim branch.
    throw new Error(`${stateDir}/graph.lock held by pid ${pid ?? "?"}${heldRun ? ` (run ${heldRun})` : ""} — another tickmarkr run? (operator escape: \`tickmarkr unlock ${heldRun ?? "<run-id>"}\`)`);
  }
}

export function releaseRunLock(repoRoot: string): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  unlinkIfOurs(lockPath(repoRoot)); // never delete a reclaiming successor's lock — only ours
  heldPath = undefined;
}

export interface ApprovalSerialization {
  /** true when another approval or run-end already owned the boundary before this caller */
  contended: boolean;
  release(): void;
}

// T14: task-approved append and the terminal outstandingApprovals sample + run-end append are one
// cross-process critical section. The daemon keeps this boundary until AFTER it releases graph.lock:
// an approval wins first and is necessarily in run-end, or run-end wins first and the command cannot
// append until there is no live owner. There is no interval in which an accepted approval can land
// behind the completion sample while graph.lock still makes it look deferred to that daemon.
//
// The boundary uses the same atomic link(2) idiom and the same inspect() authority as graph.lock.
// A dead holder is reclaimed with the same inode+mtime guard; a live holder is waited out; garbage
// fails closed. No caller re-derives pid liveness.
export async function acquireApprovalSerialization(repoRoot: string, runId: string): Promise<ApprovalSerialization> {
  const p = approvalSerializationPath(repoRoot);
  let contended = false;
  while (true) {
    const tmp = join(tickmarkrDir(repoRoot), `approval.lock.${process.pid}.${approvalSequence++}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, runId, startedAt: Date.now() }));
      try {
        linkSync(tmp, p);
      } finally {
        unlinkSync(tmp);
      }
      let released = false;
      return {
        contended,
        release: () => {
          if (released) return;
          released = true;
          unlinkIfOurs(p);
        },
      };
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* link loser already cleaned its private temporary */ }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      contended = true;
      let insp: Inspection;
      try { insp = inspect(p); }
      catch (inspectError) {
        if ((inspectError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectError;
      }
      if (insp.garbage) {
        throw new Error(`${stateDirName(repoRoot)}/approval.lock holds an unreadable/garbage payload — refusing to cross the run-end boundary`);
      }
      if (insp.dead) {
        let st;
        try { st = statSync(p); }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (st.ino !== insp.ino || st.mtimeMs !== insp.mtimeMs) continue;
        try { unlinkSync(p); } catch (e2) { if ((e2 as NodeJS.ErrnoException).code !== "ENOENT") throw e2; }
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

// LOCK-04: the owner the decision table sees, read-only, for callers that need the pid as well as
// the answer. inspect() owns pid-liveness (ESRCH dead / EPERM alive / garbage fail-closed) and reads
// it from isPidLive above; a second `process.kill(pid, 0)` anywhere else would be a second copy of
// that rule, free to drift — a caller holding only a pid consumes isPidLive, never its own probe.
// undefined ⇒ no lock at all — never conflate that with a lock whose recorded owner is dead.
export function runLockOwner(repoRoot: string): { pid?: number; runId?: string; live: boolean } | undefined {
  let insp: Inspection;
  try { insp = inspect(join(repoRoot, stateDirName(repoRoot), "graph.lock")); }
  catch { return undefined; } // statSync ENOENT ⇒ not held
  // `runId` is carried so a caller can name the run the live owner is actually executing — the lock is
  // REPOSITORY-wide, so a live pid here is not proof it is running the run the caller cares about.
  return { pid: insp.pid, runId: insp.runId, live: shouldRefuse(insp) };
}

export function runLockRunId(repoRoot: string): string | undefined {
  const runId = runLockOwner(repoRoot)?.runId;
  if (runId === undefined) return undefined;
  try { return parseRunId(runId); } catch { return undefined; }
}

export function runStatusLine(repoRoot: string, runId: string, events: readonly RunLineEvent[]): string | null {
  let parsedRunId: string;
  try { parsedRunId = parseRunId(runId); } catch { return null; }
  const owner = runLockOwner(repoRoot);
  const ownerRunId = owner?.runId === undefined ? undefined : (() => {
    try { return parseRunId(owner.runId); } catch { return undefined; }
  })();
  if (owner && ownerRunId === parsedRunId) {
    if (owner.live) return `run ${parsedRunId} active`;
    return owner.pid === undefined
      ? `run ${parsedRunId} stale lock`
      : `run ${parsedRunId} stale lock naming dead holder pid ${owner.pid}`;
  }
  if (events.some((event) => event.event === "run-end")) return null;
  return `run ${parsedRunId} abandoned since ${events.at(-1)?.ts ?? "unknown"}`;
}

// Read-only predicate: true iff a lock exists that the decision table would REFUSE on (alive,
// EPERM, or ANY garbage). A provably-dead holder (ESRCH) reads not-live (LOCK-02/OBS-05). Never
// mutates the lock. compile now acquires via acquireRunLock; this remains for drift oracles/tests.
export function isRunLockLive(repoRoot: string): boolean {
  return runLockOwner(repoRoot)?.live ?? false;
}

// LOCK-03/R16-17/R41: operator escape hatch, split into the two routes a snapshot's trustworthiness
// actually supports. A valid (parseable) payload carries a trustworthy run ID, so its recovery
// (previewUnlock/commitUnlock) REQUIRES the operator to name that run and refuses any other. A
// garbage payload has NO trustworthy run ID (R17) — its recovery (previewGarbageUnlock/
// commitGarbageUnlock) identifies it by raw bytes + inode instead and never invents one.
//
// Both routes split into preview (read-only) and commit (mutating): the CLI shows the preview,
// gets TTY confirmation or --yes, then calls commit. Commit atomically renames the entry into a
// private directory, reads that captured file and repeats the identity/liveness checks. Only the
// captured entry can be unlinked; a successor at graph.lock is never a removal target. A rejected
// capture is restored with link(2), which cannot overwrite a successor. No caller trusts the
// confirmed preview's verdict for the removal itself.
export interface LockSnapshot { pid?: number; runId?: string; garbage: boolean; unreadable: boolean; dead: boolean; ino: number; mtimeMs: number; raw: Buffer }

// Unlike inspect() (owned by the acquire/reclaim path this task must not change), a stat failure
// here is never silently read as "no lock" — only ENOENT is. Any other stat error (e.g. EACCES)
// propagates so the CLI fails closed and loud instead of returning the neutral "nothing to remove"
// receipt over a lock it could not actually see (R41).
//
// A content READ failure (stat succeeds, the bytes don't — e.g. EACCES) is its OWN `unreadable`
// state, distinct from `garbage`: we never observed the bytes, so we cannot confirm the payload is
// malformed, and a well-formed live lock made merely unreadable must never become eligible for
// either recovery route. `raw` stays a Buffer (never decoded) for identity: decoding invalid UTF-8
// collapses distinct byte sequences to the same replacement-character string, which would let a
// changed-bytes attack slip past a text-equality check (AC2's byte-confirmation requirement).
function readLockSnapshot(p: string): LockSnapshot | undefined {
  let st: Stats;
  try { st = lstatSync(p); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  const unreadable = (): LockSnapshot => ({ garbage: false, unreadable: true, dead: true, ino: st.ino, mtimeMs: st.mtimeMs, raw: Buffer.alloc(0) });
  if (!st.isFile()) return unreadable();
  let raw: Buffer;
  let fd: number | undefined;
  try {
    // Read bytes and inode from the same open file. Refuse symlinks/non-files even if the path
    // changes after lstat; NONBLOCK prevents a substituted FIFO from hanging the command.
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    st = fstatSync(fd);
    if (!st.isFile()) return unreadable();
    raw = readFileSync(fd);
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // raced away between stat and read
    return unreadable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let parsedJson: unknown = null;
  try { parsedJson = JSON.parse(raw.toString("utf8")); } catch { /* not JSON ⇒ garbage below */ }
  const parsed = PayloadSchema.safeParse(parsedJson);
  const pid = parsed.success ? parsed.data.pid : undefined;
  return {
    pid,
    runId: parsed.success ? parsed.data.runId : undefined,
    garbage: !parsed.success,
    unreadable: false,
    dead: pid === undefined ? true : !isPidLive(pid),
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    raw,
  };
}

export type UnlockPreview =
  | { held: false }
  | { held: true; eligible: false; reason: string; pid?: number; runId?: string }
  | { held: true; eligible: true; pid: number; runId: string; ino: number; mtimeMs: number; raw: Buffer };

type UnlockRefusal = { removed: false; reason: string };

// rename is the single capture operation, not a snapshot followed by an unlink of graph.lock.
// mkdtemp gives this commit a private destination on the same filesystem. All validation and
// deletion happens there, so a later acquisition at graph.lock survives even during the read.
function commitCapturedLock(
  repoRoot: string,
  validate: (snap: LockSnapshot) => string | undefined,
): { removed: true; snap: LockSnapshot } | UnlockRefusal {
  const p = lockPath(repoRoot);
  const dir = mkdtempSync(`${p}.unlock-`);
  const captured = join(dir, "graph.lock");
  const restore = (reason: string): UnlockRefusal => {
    try {
      // Never rename back: that would clobber a successor installed while we validated.
      linkSync(captured, p);
    } catch (e) {
      return { removed: false, reason: `${reason}; could not restore graph.lock (${(e as NodeJS.ErrnoException).code}) — captured entry retained at ${captured}` };
    }
    try { unlinkSync(captured); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return { removed: false, reason: `${reason}; graph.lock restored, additional captured link retained at ${captured}: ${(e as Error).message}` };
      }
    }
    return { removed: false, reason };
  };
  try {
    try { renameSync(p, captured); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, reason: "graph.lock no longer exists — nothing captured or removed" };
      throw e;
    }
    try {
      const snap = readLockSnapshot(captured);
      if (!snap) return { removed: false, reason: "captured graph.lock no longer exists — not removed" };
      const reason = validate(snap);
      if (reason) return restore(reason);
      unlinkSync(captured);
      return { removed: true, snap };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, reason: "captured graph.lock no longer exists — not removed" };
      return restore(`graph.lock could not be removed: ${(e as Error).message}`);
    }
  } finally {
    // Best-effort empty-directory cleanup only. Never recursively delete a refused capture that
    // could not be restored, or obscure its recovery path with a cleanup error.
    try { rmdirSync(dir); } catch { /* retained capture or directory cleanup failure */ }
  }
}

// AC1: eligible only for a matching-run, provably-dead, non-garbage lock. Live, EPERM and any other
// signal-probe error all read `dead: false` through the one shared isPidLive predicate — never a
// second copy that would treat an unknown errno as death. A different run ID refuses even when the
// holder is dead: the operator named a run, and this is not it.
export function previewUnlock(repoRoot: string, runId: string): UnlockPreview {
  const snap = readLockSnapshot(lockPath(repoRoot));
  if (!snap) return { held: false };
  const stateDir = stateDirName(repoRoot);
  if (snap.unreadable) {
    return { held: true, eligible: false, reason: `${stateDir}/graph.lock content could not be read — refusing to unlock without observing its payload` };
  }
  if (snap.garbage) {
    return { held: true, eligible: false, reason: `${stateDir}/graph.lock holds an unreadable/garbage payload — run \`tickmarkr unlock --garbage\` to recover it, not a named unlock`, pid: snap.pid, runId: snap.runId };
  }
  if (snap.runId !== runId) {
    return { held: true, eligible: false, reason: `${stateDir}/graph.lock is held for run ${snap.runId ?? "?"}, not ${runId} — refusing to unlock a different run`, pid: snap.pid, runId: snap.runId };
  }
  if (!snap.dead) {
    return { held: true, eligible: false, reason: `${stateDir}/graph.lock held by LIVE pid ${snap.pid}${snap.runId ? ` (run ${snap.runId})` : ""} — refusing to unlock; stop that run first`, pid: snap.pid, runId: snap.runId };
  }
  return { held: true, eligible: true, pid: snap.pid!, runId: snap.runId!, ino: snap.ino, mtimeMs: snap.mtimeMs, raw: snap.raw };
}

export function commitUnlock(
  repoRoot: string,
  target: { pid: number; runId: string; ino: number; mtimeMs: number; raw: Buffer },
): { removed: true; pid: number; runId: string } | { removed: false; reason: string } {
  const commit = commitCapturedLock(repoRoot, (snap) => {
    if (snap.unreadable || snap.garbage || snap.ino !== target.ino || snap.mtimeMs !== target.mtimeMs || snap.pid !== target.pid || !snap.raw.equals(target.raw)) {
      return "graph.lock changed since preview — refusing to remove the new holder";
    }
    if (snap.runId !== target.runId) return `graph.lock now names run ${snap.runId ?? "?"}, not ${target.runId}`;
    if (!snap.dead) return `holder pid ${snap.pid} is alive`;
  });
  if (!commit.removed) return commit;
  return { removed: true, pid: commit.snap.pid!, runId: commit.snap.runId! };
}

export type UnlockGarbagePreview =
  | { held: false }
  | { held: true; eligible: false; reason: string; pid?: number; runId?: string }
  | { held: true; eligible: true; ino: number; raw: Buffer };

// AC2: eligible only for an ACTUALLY malformed snapshot — a well-formed payload (dead or live) is
// refused here and pointed at the ordinary named route instead, so --garbage can never become a
// second, run-ID-free way to remove a legitimate lock. An unreadable payload is refused too: its
// bytes were never observed, so it is neither confirmed malformed nor confirmed well-formed.
export function previewGarbageUnlock(repoRoot: string): UnlockGarbagePreview {
  const snap = readLockSnapshot(lockPath(repoRoot));
  if (!snap) return { held: false };
  if (snap.unreadable) {
    return { held: true, eligible: false, reason: `${stateDirName(repoRoot)}/graph.lock content could not be read — refusing to treat it as garbage without observing its bytes` };
  }
  if (!snap.garbage) {
    return { held: true, eligible: false, reason: `${stateDirName(repoRoot)}/graph.lock holds a well-formed payload — run \`tickmarkr unlock ${snap.runId ?? "<run-id>"}\` instead of --garbage`, pid: snap.pid, runId: snap.runId };
  }
  return { held: true, eligible: true, ino: snap.ino, raw: snap.raw };
}

export function commitGarbageUnlock(
  repoRoot: string,
  target: { ino: number; raw: Buffer },
): { removed: true } | { removed: false; reason: string } {
  const commit = commitCapturedLock(repoRoot, (snap) => {
    if (snap.unreadable) return "graph.lock content became unreadable since preview — refusing to remove it blind";
    if (!snap.garbage) return "graph.lock now holds a well-formed payload — refusing to remove a valid holder";
    if (snap.ino !== target.ino || !snap.raw.equals(target.raw)) {
      return "graph.lock bytes/inode changed since preview — refusing to remove the new file";
    }
  });
  return commit.removed ? { removed: true } : commit;
}
