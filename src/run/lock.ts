import { linkSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tickmarkrDir, stateDirName } from "../graph/graph.js";

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

// LOCK-04: the ONE decision table. Both acquireRunLock and isRunLockLive consume this — the two
// hand-maintained copies of the rule cannot drift. The table changes HERE, once. unlockRun uses the
// SAME inspect() with its own live-holder refusal (`!dead && !garbage`) — it is the escape hatch, not
// a second copy of the rule.
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
    if (garbage) throw new Error(`${stateDir}/graph.lock holds an unreadable/garbage payload — refusing to reclaim it; run \`tickmarkr unlock\` to remove it`);
    // LOCK-02: shouldRefuse is false whenever dead, so this throw is reached only for a LIVE holder
    // (incl. EPERM = alive-but-not-ours). The dead-but-fresh case self-clears via the reclaim branch.
    throw new Error(`${stateDir}/graph.lock held by pid ${pid ?? "?"}${heldRun ? ` (run ${heldRun})` : ""} — another tickmarkr run? (operator escape: \`tickmarkr unlock\`)`);
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
  try { insp = inspect(lockPath(repoRoot)); }
  catch { return undefined; } // statSync ENOENT ⇒ not held
  // `runId` is carried so a caller can name the run the live owner is actually executing — the lock is
  // REPOSITORY-wide, so a live pid here is not proof it is running the run the caller cares about.
  return { pid: insp.pid, runId: insp.runId, live: shouldRefuse(insp) };
}

// Read-only predicate: true iff a lock exists that the decision table would REFUSE on (alive,
// EPERM, or ANY garbage). A provably-dead holder (ESRCH) reads not-live (LOCK-02/OBS-05). Never
// mutates the lock. compile now acquires via acquireRunLock; this remains for drift oracles/tests.
export function isRunLockLive(repoRoot: string): boolean {
  return runLockOwner(repoRoot)?.live ?? false;
}

// LOCK-03: operator escape hatch. Liveness-checked delete — removes a dead-holder or garbage lock,
// REFUSES to remove one whose holder is alive (incl. EPERM = alive-but-not-ours). No --force: the
// refusal names the pid; the operator kills the process. Liveness logic stays here (LOCK-04
// discipline extends to this caller) — the CLI command is a thin formatter.
// W4 TOCTOU: liveness is checked, THEN unlinked — a live holder that dies (or a dead pid reused)
// between inspect() and unlinkSync is a window this does NOT close. Acceptable: unlock is
// operator-initiated on an already-parked run; worst case is removing a lock a just-reborn process
// would want, which the operator triggered and can recover by re-running. NOT an atomic re-check.
export function unlockRun(repoRoot: string): { held: false } | { held: true; removed: true; pid?: number; runId?: string; garbage: boolean } {
  const p = lockPath(repoRoot);
  let insp: Inspection;
  try { insp = inspect(p); }
  catch { return { held: false }; } // statSync ENOENT ⇒ no lock
  if (!insp.dead && !insp.garbage) {
    throw new Error(`${stateDirName(repoRoot)}/graph.lock held by LIVE pid ${insp.pid}${insp.runId ? ` (run ${insp.runId})` : ""} — refusing to unlock; stop that run first`);
  }
  try { unlinkSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return { held: true, removed: true, pid: insp.pid, runId: insp.runId, garbage: insp.garbage };
}
