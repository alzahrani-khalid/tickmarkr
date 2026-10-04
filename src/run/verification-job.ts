import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { ShellReceipt } from "./protocol.js";
import type { GateEvidenceOptions } from "../gates/baseline.js";
import { assertGitTrust, protectedGitEnv } from "./git-trust.js";
import { executionSignal } from "./execution-budget.js";
import { hasRepositoryLeaseOwnership, REPOSITORY_LEASE_TOKEN_ENV, reentrantHolder, repositoryLeasePath, reapRepositoryChildren, withCommandLease, withFreshCommandLease, withRepositoryLease, type RepositoryLeaseHolder } from "./lease.js";

// closed job table: command admission precedes repository admission; the standalone wrapper
// acquires that same scheduler reservation before its outer repository reservation. Both hold until the first pass and at most
// one exact stranded continuation cease. An unrelated infrastructure retry is a new FIFO job.
// closed capability table: each entry creates a private async capability, even in the same pid.
// Only shell descendants receive its environment token; no manifest job exports process.env.
// closed timing table: producer stamps are related spans, never summed service. Child admission
// starts phase/hang clocks; queued time buys no command service. Reports remain separate proof.
export interface VerificationPhase {
  phase: "discovery" | "first-pass" | "continuation-discovery" | "continuation";
  nonce: string;
  reportPath: string;
  parentNonce?: string;
  startedAt?: number;
  endedAt?: number;
  pid?: number;
  outcome?: ShellReceipt["outcome"];
  state: "pending" | "running" | "completed" | "cancelled" | "failed";
}
export interface VerificationJobReport {
  version: 1;
  id: string;
  command: string;
  cwd: string;
  subject: { commit: string | null; runId: string; taskId: string | null; attempt: number | null };
  scope: string;
  reason: string;
  queuedAt: number;
  repositoryAdmittedAt?: number;
  admittedAt?: number;
  reapedAt?: number;
  repositoryReleasedAt?: number;
  releasedAt?: number;
  reservationReused?: boolean;
  reservation?: RepositoryLeaseHolder;
  waitingOn?: RepositoryLeaseHolder;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  phases: VerificationPhase[];
}
interface Job { report: VerificationJobReport; path: string; persist: () => void; phase?: VerificationPhase }
const jobs = new AsyncLocalStorage<Job>();
export const VERIFICATION_JOB_TOKEN_ENV = "TICKMARKR_VERIFICATION_JOB_TOKEN";
export function verificationJobEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const job = jobs.getStore();
  return job ? { ...env, [VERIFICATION_JOB_TOKEN_ENV]: job.report.id } : { ...env };
}
let clock = () => Date.now();
export const setVerificationJobClockForTests = (now: () => number): void => { clock = now; };
export const resetVerificationJobClockForTests = (): void => { clock = () => Date.now(); };
export function observeVerificationSpawn(pid: number | undefined): void {
  const job = jobs.getStore();
  if (!job?.phase) return;
  job.phase.startedAt ??= clock();
  job.phase.pid = pid;
  job.phase.state = "running";
  job.persist();
}
export function observeVerificationReceipt(receipt: ShellReceipt): void {
  const job = jobs.getStore();
  if (!job?.phase) return;
  job.phase.outcome = receipt.outcome;
  job.persist();
}
export async function verificationPhase<T>(phase: VerificationPhase["phase"], nonce: string, reportPath: string,
  run: () => Promise<T>, parentNonce?: string): Promise<T> {
  const job = jobs.getStore();
  if (!job) return run();
  const span: VerificationPhase = { phase, nonce, reportPath, state: "pending", ...(parentNonce ? { parentNonce } : {}) };
  job.report.phases.push(span); job.phase = span; job.persist();
  try {
    const value = await run();
    span.state = executionSignalSafely()?.aborted || span.outcome === "cancelled" ? "cancelled" : span.outcome === "timed-out" || span.outcome === "spawn-failed" ? "failed" : "completed";
    return value;
  } catch (error) {
    span.state = executionSignalSafely()?.aborted ? "cancelled" : "failed";
    throw error;
  } finally {
    span.endedAt = clock(); job.phase = undefined; job.persist();
  }
}
// executionSignal() checks the budget and can throw during cleanup; the initial signal is retained.
const signals = new AsyncLocalStorage<AbortSignal | undefined>();
const executionSignalSafely = () => signals.getStore();
export async function withVerificationJob<T extends { pass: boolean; meta: Record<string, unknown>; reportPath?: string }>(
  command: string, cwd: string, reportPath: string, evidence: GateEvidenceOptions | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const signal = executionSignal();
  let commit = evidence?.subjectCommit ?? null;
  if (!commit) {
    try { assertGitTrust(cwd); commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, env: protectedGitEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* unknown remains explicit */ }
  }
  const report: VerificationJobReport = { version: 1, id: randomUUID(), command, cwd,
    subject: { commit, runId: evidence?.runId ?? "standalone", taskId: evidence?.taskId ?? null, attempt: evidence?.attempt ?? null },
    scope: command, reason: "manifest verification", queuedAt: clock(), state: "queued", phases: [] };
  const path = `${reportPath}.job.json`;
  const job: Job = { report, path, persist: () => {
    // Timing persistence is observational, just like gate receipts; failure cannot change proof.
    const draft = `${path}.${report.id}.draft`;
    try { writeFileSync(draft, JSON.stringify(report, null, 2) + "\n"); renameSync(draft, path); }
    catch { /* report proof remains authoritative */ }
    finally { try { rmSync(draft, { force: true }); } catch { /* observational */ } }
  } };
  job.persist();
  let outcome: T | undefined;
  try {
    report.reservationReused = hasRepositoryLeaseOwnership() && !jobs.getStore();
    // A process descendant may share its ancestor's scheduler capability only after the file
    // generation and strict ancestry have been verified. A same-pid sibling always queues fresh.
    const inherited = !hasRepositoryLeaseOwnership()
      && await reentrantHolder(await repositoryLeasePath(cwd), process.env[REPOSITORY_LEASE_TOKEN_ENV]);
    const reserveCommand = report.reservationReused || inherited ? withCommandLease : withFreshCommandLease;
    outcome = await reserveCommand(command, () => withRepositoryLease(cwd, () => {
      signal?.throwIfAborted();
      report.admittedAt = clock(); report.state = "running"; job.persist();
      return signals.run(signal, () => jobs.run(job, async () => {
        try { return await run(); }
        finally {
          await reapRepositoryChildren({ pid: process.pid, cwd, at: report.queuedAt, token: report.id }, 20, VERIFICATION_JOB_TOKEN_ENV);
          report.reapedAt = clock(); job.persist();
        }
      }));
    }, { isolated: true, protectOrphans: true, independent: !!jobs.getStore(), signal, pollMs: 20,
      onWait: holder => { report.waitingOn = { ...holder }; job.persist(); },
      onAdmission: holder => { report.repositoryAdmittedAt = clock(); report.reservation = { ...holder }; job.persist(); },
      onRelease: () => { report.reapedAt ??= clock(); report.repositoryReleasedAt = clock(); job.persist(); } }));
    report.releasedAt = clock();
    report.state = signal?.aborted ? "cancelled" : outcome.pass ? "completed" : "failed";
    outcome.meta = { ...outcome.meta, verificationJobPath: path, verificationJob: report };
    // Existing tip callers retain only reportPath: its sidecar is the additive producer envelope.
    if (outcome.reportPath && `${outcome.reportPath}.job.json` !== path) {
      try { writeFileSync(`${outcome.reportPath}.job.json`, JSON.stringify(report, null, 2) + "\n"); } catch { /* observational */ }
    }
    return outcome;
  } catch (error) {
    if (report.repositoryReleasedAt !== undefined) report.releasedAt = clock();
    report.state = signal?.aborted ? "cancelled" : "failed";
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { verificationJobPath: path, verificationJob: report });
  } finally { job.persist(); }
}
