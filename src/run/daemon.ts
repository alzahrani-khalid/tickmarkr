import { HOST_PROBE_SAMPLE_MS, HOST_PROBE_SAMPLES, HostDegradedError, hostDegraded, observeHost, type HostObservation } from "./host-health.js";
import { runWithInterruptionSink, VITEST_CACHE_ENV, worktreeVitestCache, type HostInterruption } from "../gates/test-manifest.js";
import { COMMAND_LEASE_TOKEN_ENV, commandLeaseEnvironment, CommandLeases, currentCommandLeaseToken, isRunnerCommand, runWithCommandLease, withCommandLease } from "./lease.js";
import { execFileSync, spawn } from "node:child_process";
import { createHash, type Hash, randomBytes } from "node:crypto";
import { shq } from "../adapters/types.js";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { batchedProcessProbes, runnerPids } from "./suite-census.js";
import { stringify } from "yaml";
import { BOOTSTRAP_FAILURE_RE, classifyDeadChannel, classifyTransientCapacity, trailerPattern, writePrompt } from "../adapters/prompt.js";
import { allAdapters, getAdapter, probeAll, readDoctor, rolePools } from "../adapters/registry.js";
import { type Assignment, SettledTrailerTracker, addUsage, CAPACITY_RE, channelKey, matchesInputBox, matchesTrustDialog, quotaSignal, type TokenUsage, type WorkerAdapter, type WorkerResult } from "../adapters/types.js";
import { bannerShell, paneDispatchCommand } from "../brand.js";
import { collateralHits, type ScopeCollateralVerdict } from "../compile/collateral.js";
import {
  ExecutionPolicySchema, DEFAULT_DIFF_CAP, globalConfigDir, loadConfigWithMode, readOverlayFile, repoOverlayPath,
  type ModeResolution, type RoutingMode, type TickmarkrConfig,
} from "../config/config.js";
import { DeliveryReadinessError } from "../drivers/herdr.js";
import { driverEvidence, type DriverChoice } from "../drivers/index.js";
import { herdrSealShellPrefix, MAX_BUF, SubprocessDriver } from "../drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver, type Slot } from "../drivers/types.js";
import { type Baseline, type BaselineProvenance, captureBaseline, detectGateCommands, detectVacuousOracles, type GateEvidenceOptions } from "../gates/baseline.js";
import { reobserveTestFiles, runGates, type GateContext, type GateEvent } from "../gates/run-gates.js";
import { isInfraResult } from "../gates/cache.js";
import { RUNNER_INFRA_DIAGNOSTIC_RE, timeoutShaped } from "../gates/timeout-shaped.js";
import type { GateResult } from "../gates/types.js";
import { filesGlob } from "../graph/files-glob.js";
import { addEvidence, attributeBlocked, batteryPriority, blockedTasks, getTask, graphDefinitionHash, loadGraph, pendingTasks, readyTasks, saveGraph, setStatus, taskContentDigest, tickmarkrDir } from "../graph/graph.js";
import { GATE_NAMES, type GateName, type RunGraph, type Task } from "../graph/schema.js";
import { distFingerprint } from "../cli/commands/version.js";
import { augmentRetryBrief, consult, renderRetryGuidance, type ConsultInvocation, type ConsultVerdict } from "./consult.js";
import { executionSignal, remainingExecutionMs, withExecutionBudget, withoutExecutionBudget, ExecutionBudgetExceeded } from "./execution-budget.js";
import { repairSelectionDecision, repairSelectionEnabled } from "./repair-selection.js";
import { failureDisposition, reserveInfrastructureRetry } from "./recovery.js";
import { runEnvironment } from "./environment.js";
import { addDetachedWorktree, changeRepresented, cleanupRunWorktrees, deriveForkCap, FORK_CAP_ENV, gitHead, linkNodeModules, npmDependencyInstallCommand, npmDependencyManifestChanged, PRESERVE_COMMIT_SUBJECT, PRESERVE_PRODUCER_TRAILER, preserveWorktree, type PreserveProducer, producerFields, removeWorktree, resolvedCapacity, runWithForkBudget, runWithVerificationBudget, type RunCapacity, sameCapacity, sameVerification, sh, shell, shGit, SUITE_PARENT_ENV, verificationProtocol, WORKTREE_LAYOUT_CONTRACT, WORKTREES_DIR, worktreePath } from "./git.js";
import { MASK } from "./redact.js";
import { runInteractiveSeed, type InteractiveSeedResult } from "./interactive-seed.js";
import { classifyRepairDisposition, resolveScopeHints } from "./repair-disposition.js";
import { applyScopeAmendments, activeRetryBan, interruptedAttempt, RESUME_HARVEST_SOURCE, resumeHarvestAuthor, approvalAction, APPROVAL_REFUSED, bindingToken, effectiveEvents, foldDecisions, physicalLine, staleApprovals, classifyTaskFailure, classifyWorkerResultCause, deferredReviewFindings, engagementComparable, formatPriorFindingEvidence, GATE_FINGERPRINT_CAP, GATE_SATISFIED_RELEASE, identicalGateFailures, isDeferredFinding, journaledFailureBrief, Journal, loadRoutingProfile, newRunId, normalizeGateFailure, outstandingConsultGuidance, readableExcerpt, receiptOrigin, outstandingReviewFindings, pendingApprovalActions, pendingRechecks, pendingRepairFindings, phaseForGate, priorJudgments, readPriorRunEvidence, recordedTaskFailureKind, reraisedReviewChains, RECHECK_RELEASE, renderStructuredReviewFinding, repairReachSinceApproval, repairsSinceApproval, reviewRoundsSinceApproval, runHasEnded, standingRulings, structuredFindings, upheldFeedbackByTask, type CurrentAttemptGateReplay, type JournalEvent, type ParkKind, type ResumeState, type RetryMode, type StructuredFinding } from "./journal.js";
import { carriedAuthorVendors, gateReviewerFloor, isDiffCapPark, isGarbageReview, pickReviewer } from "../gates/review.js";
import { acquireApprovalSerialization, acquireRunLock, isPidLive, releaseRunLock } from "./lock.js";
import { ensureIntegration, integrationBranch, integrationHead, mergeTask, reusedTipEvidence, verifyIntegrationTip } from "./merge.js";
import { channelExclusion, climbChannel, inTaskPool, marginalCostRank, nextChannel, poolExhaustion, route, taskPool } from "../route/router.js";
import { desiredPanes } from "./reconcile.js";
import { readTierLiveness, readWatchBoard, supervisionPresencePath } from "./supervision.js";
import {
  harvestCpuFlatWindowMs,
  NUDGEABLE_ADAPTERS,
  PANE_READ_ROWS,
  StallProgressTracker,
  stallSnapshotBannerRows,
  WorkerTreeCpuAccountant,
  reapOwnedProcessGroup,
  readOwnedProcessGroup,
} from "./stall.js";

// The live set is also the ownership claim shared by task cleanup and termination.
export async function closeLiveSlot(liveSlots: Set<Slot>, driver: Pick<ExecutorDriver, "close">, slot: Slot): Promise<void> {
  if (!liveSlots.delete(slot)) return;
  try {
    await driver.close(slot);
  } catch (error) {
    liveSlots.add(slot);
    throw error;
  }
}

// A transport timeout says nothing about whether a mutation reached the terminal.
class HeldProbeExhausted extends Error {}
// OBS-1108: an owned slot whose contact stayed latched unreadable past its deadline. Same terminal
// path as an exhausted transport probe — worktree preserved, one infra park (recheck-able) — with
// its own disposition, so the park names what was actually lost.
class ContactUnreadableExhausted extends HeldProbeExhausted {}

// OBS-1108: how long one owned slot's contact may stay latched unreadable before its attempt parks.
// Default: the attempt's own stall window — the latch holds the stall kill down, so without this
// only the 4x hard deadline bounded a blind wait (2.5.8: 22k rows; 2.6.1: ~12k rows/h per worker).
let contactUnreadableDeadlineMs: number | undefined;
export function setContactUnreadableDeadlineMsForTests(ms: number): void { contactUnreadableDeadlineMs = ms; }
export function resetContactUnreadableDeadlineMsForTests(): void { contactUnreadableDeadlineMs = undefined; }
const CONTACT_BACKOFF_BASE_MS = 1_000; // the pre-latch retry pause, doubled per latched retry
const CONTACT_BACKOFF_DOUBLINGS = 5; // ponytail: 32 s ceiling; the poll slice caps it lower anyway

function isTransportTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { code?: string; timedOut?: boolean; reason?: string };
  return e.timedOut === true || ["ETIMEDOUT", "transport_timeout", "timeout"].includes(e.code ?? "")
    || /\b(?:timed? out|timeout)\b/i.test(e.reason ?? e.message);
}

/** Optional authoritative transport receipt. Screen text can prove execution, never nonacceptance. */
export interface DispatchObservation {
  slotId: string;
  command: string;
  dispatchId: string;
  outcome: "accepted" | "not-accepted";
  authoritative: true;
}

export function heldWorkerTransport(driver: ExecutorDriver, slot: Slot, dispatchId: string,
  held: (data: Record<string, unknown>) => void,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Pick<ExecutorDriver, "run" | "read" | "status" | "waitOutput" | "waitAgentStatus" | "transportState"> {
  const delays = [250, 500, 1_000];
  const probe = async <T>(operation: string, call: () => Promise<T>): Promise<T> => {
    for (let retry = 0; ; retry++) {
      try { return await call(); }
      catch (error) {
        if (!isTransportTimeout(error)) throw error;
        held({ operation, retry, state: "held", error: String(error), backoffMs: delays[retry] });
        if (retry === delays.length) throw new HeldProbeExhausted(`${operation} transport retry budget exhausted`);
        await sleep(delays[retry]!);
      }
    }
  };
  return {
    read: (s, n) => probe("read", () => driver.read(s, n)),
    status: (s) => probe("status", () => driver.status(s)),
    waitOutput: (s, p, ms, o) => probe("waitOutput", () => driver.waitOutput(s, p, ms, o)),
    waitAgentStatus: (s, st, ms) => probe("waitAgentStatus", () => driver.waitAgentStatus(s, st, ms)),
    // row 108: forwarded only when the driver answers; absent stays absent, so the park reads it as unknown
    ...(driver.transportState ? { transportState: (s: Slot) => probe("transportState", () => driver.transportState!(s)) } : {}),
    run: async (s, command) => {
      const observer = driver as ExecutorDriver & {
        observeDispatch?: (slot: Slot, command: string, dispatchId: string) => Promise<DispatchObservation | undefined>;
      };
      // A second delivery needs a receipt for THIS mutation, not an empty or idle terminal.
      for (let delivery = 0; delivery < 2; delivery++) {
        try { await driver.run(s, command); return; }
        catch (error) {
          if (!isTransportTimeout(error)) throw error;
          let notAccepted = false;
          for (let retry = 0; retry <= delays.length; retry++) {
            held({ operation: "run", retry, delivery, state: "held", dispatchId, error: String(error), backoffMs: delays[retry] });
            try {
              const receipt = await observer.observeDispatch?.(slot, command, dispatchId);
              if (receipt?.authoritative === true && receipt.slotId === slot.id
                  && receipt.command === command && receipt.dispatchId === dispatchId) {
                if (receipt.outcome === "accepted") return;
                if (receipt.outcome === "not-accepted") { notAccepted = true; break; }
              }
              const text = await driver.read(slot, PANE_READ_ROWS);
              if (text.split(/\r?\n/).some((line) => line === `TICKMARKR_DISPATCH_${dispatchId}`)) return;
            } catch { /* failed observations prove neither acceptance nor nonacceptance */ }
            if (retry < delays.length) await sleep(delays[retry]!);
          }
          if (!notAccepted) break;
        }
      }
      throw new HeldProbeExhausted("dispatch outcome remained uncertain; no delivery authorized");
    },
  };
}

// A fixed attempt ceiling is independent of the rolling inactivity clock.
let attemptHardTimeoutMs: number | undefined;
export function setAttemptHardTimeoutMsForTests(ms: number): void { attemptHardTimeoutMs = ms; }
export function resetAttemptHardTimeoutMsForTests(): void { attemptHardTimeoutMs = undefined; }

// Compatibility exports: gate dispatch can import stall.ts without importing the daemon.
export {
  harvestCpuFlatWindowMs,
  resetHarvestCpuFlatMsForTests,
  setHarvestCpuFlatMsForTests,
  workerTreeCpuMs,
} from "./stall.js";

export interface RunOptions {
  runId?: string;
  resume?: boolean;
  // v1.53 T5: prior run this run supersedes. Validated before any state for the new run exists;
  // the prior journal gains ONE appended `superseded` event (append-only, never rewritten).
  supersedes?: string;
  // T3 (Sol #2 / Fable F2): operator's audited release of the engagement-identity guard so the
  // sanctioned stop-amend-resume workflow keeps working — the daemon refuses a mismatched/unbound
  // journal unless this is set, then journals a graph-rehash event naming both hashes.
  graphChanged?: boolean;
  // OBS-123: explicit recovery for tasks terminally failed during dispatch. Resume keeps every other
  // failure terminal and clears this task's replayed attempt seed so the new dispatch is fresh.
  retryFailed?: boolean;
  concurrency?: number;
  /** Bounded wait at a drain caused solely by parked tasks. */
  approvalWindowMs?: number;
  driver?: ExecutorDriver;
  driverOverride?: DriverChoice;
  adapters?: WorkerAdapter[];
  globalDir?: string;
  // v1.51 T2: run-flag routing mode (--mode / the --quality alias) — the strongest mode source.
  mode?: RoutingMode;
  narrate?: (event: JournalEvent) => void;
  // v1.54 T2: test seam — replaces process.exit in the termination reaper (the vitest process must
  // survive a synthetic signal). Production omits it and the reaper exits the process.
  exit?: (code: number) => void;
}

// v1.51 T2: mode sources — run flag > spec front-matter > repo config > global config > default.
export type ModeSource = "run flag" | "spec" | "repo config" | "global config" | "default";

const MODE_RANK: Record<RoutingMode, number> = { "staff-led": 0, "risk-based": 1, "partner-led": 2 };

export interface ResolvedRunMode {
  cfg: TickmarkrConfig;
  /** effective mode + per-floor provenance + standing lints, from the ONE preset compiler in config.ts */
  mode: ModeResolution;
  source: ModeSource;
  /** set when the run flag picked a mode below the spec-declared mode (loud warn; --route-strict refuses) */
  conflict?: string;
}

// An override (flag/spec) re-resolves through loadConfigWithMode itself, via a synthesized repo overlay
// carrying routing.mode — floors, explore, lints, and provenance all come from config.ts's preset
// compiler, never duplicated mode math here (the quality-silently-loses defense holds by construction).
function withOverlayMode(repoRoot: string, mode: RoutingMode, globalDir?: string): { cfg: TickmarkrConfig; mode: ModeResolution } {
  const overlay = readOverlayFile(repoOverlayPath(repoRoot));
  const tmp = mkdtempSync(join(tmpdir(), "tickmarkr-mode-"));
  try {
    mkdirSync(join(tmp, ".tickmarkr"), { recursive: true });
    writeFileSync(
      join(tmp, ".tickmarkr", "config.yaml"),
      stringify({ ...overlay, routing: { ...(overlay.routing as Record<string, unknown> | undefined), mode } }),
    );
    return loadConfigWithMode(tmp, { globalDir });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function resolveRunMode(
  repoRoot: string,
  opts: { flag?: RoutingMode; spec?: RoutingMode; globalDir?: string } = {},
): ResolvedRunMode {
  const overlayMode = (path: string): unknown =>
    (readOverlayFile(path) as { routing?: { mode?: unknown } }).routing?.mode;
  const source: ModeSource = opts.flag !== undefined ? "run flag"
    : opts.spec !== undefined ? "spec"
    : overlayMode(repoOverlayPath(repoRoot)) !== undefined ? "repo config"
    : overlayMode(join(opts.globalDir ?? globalConfigDir(), "config.yaml")) !== undefined ? "global config"
    : "default";
  const override = opts.flag ?? opts.spec;
  const base = loadConfigWithMode(repoRoot, { globalDir: opts.globalDir });
  const resolved = override === undefined || override === base.mode.mode
    ? base
    : withOverlayMode(repoRoot, override, opts.globalDir);
  const conflict = opts.flag !== undefined && opts.spec !== undefined && MODE_RANK[opts.flag] < MODE_RANK[opts.spec]
    ? `mode conflict: run flag ${opts.flag} selects a mode below the spec-declared ${opts.spec} — the run flag wins this run`
    : undefined;
  return { cfg: resolved.cfg, mode: resolved.mode, source, ...(conflict ? { conflict } : {}) };
}

export interface RunSummary {
  runId: string;
  branch: string;
  done: string[];
  failed: string[];
  human: string[];
  pending: string[];
  blocked: string[];
  tipVerify?: "passed" | "failed";
  /** additive beside the legacy tipVerify enum: HOW the close's latest verification cycle earned its verdict */
  tipProof?: TipProof;
  lastMergedTask?: string;
  /** T14: did every approval this run accepted actually get enacted, or did the run end over one? */
  approvalDisposition?: "complete" | "outstanding";
  /** the accepted approvals that never reached a dispatch — named, never left to the park buckets */
  outstandingApprovals?: string[];
  /** OBS-1123: every baseline-recorded red a standing green carried, with the capture that recorded it */
  forgiven?: ForgivenFingerprints[];
}

/** OBS-1123: one forgiveness — the fingerprints a green carried and the capture that recorded them. */
export interface ForgivenFingerprints {
  /** the task whose gate forgave them; absent for the integration tip */
  taskId?: string;
  gate: string;
  /** absent: a legacy row that named no fingerprints */
  fingerprints?: string[];
  /** absent: a legacy capture or row that recorded no provenance — rendered unknown, never dated */
  baseline?: BaselineProvenance;
}

/** Journal rows are untrusted input: a malformed field reads as not recorded, never as a value. */
export const fingerprintsOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
export const baselineProvenanceOf = (v: unknown): BaselineProvenance | undefined => {
  const { baseRef, capturedAt } = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return typeof baseRef === "string" && typeof capturedAt === "string" ? { baseRef, capturedAt } : undefined;
};
/** A forgiven battery green: the structured field, or the battery's own "(forgiven)" wording on a legacy row. */
export const forgivenGateRow = (data: Record<string, unknown>): boolean =>
  data.pass === true && (Array.isArray(data.forgivenFingerprints) || /\(forgiven\)/u.test(String(data.details ?? "")));

/**
 * OBS-1123: the forgiveness standing at this point in the journal — each task gate's LATEST verdict
 * where it is a forgiven green, then the latest verification cycle's forgiven tip rows. A legacy row
 * keeps what it never recorded absent, so the reader says "unknown" instead of borrowing a date.
 */
export function forgivenFingerprints(events: readonly JournalEvent[]): ForgivenFingerprints[] {
  const latest = new Map<string, JournalEvent>();
  for (const e of events) {
    if (e.event === "gate-result" && e.taskId && typeof e.data.gate === "string") latest.set(`${e.taskId}\0${e.data.gate}`, e);
  }
  const tasks = [...latest.values()].filter((e) => forgivenGateRow(e.data));
  const start = events.map((e) => e.event).lastIndexOf("tip-verify-start");
  const tip = events.slice(start + 1).filter((e) => e.event === "tip-verify" && e.data.pass === true
    && e.data.forgiven === true && typeof e.data.gate === "string");
  return [...tasks, ...tip].map((e) => {
    const fingerprints = fingerprintsOf(e.event === "tip-verify" ? e.data.fingerprints : e.data.forgivenFingerprints);
    const baseline = baselineProvenanceOf(e.data.baselineProvenance);
    return { ...(e.taskId ? { taskId: e.taskId } : {}), gate: e.data.gate as string,
      ...(fingerprints ? { fingerprints } : {}), ...(baseline ? { baseline } : {}) };
  });
}

/** The capture a forgiveness rests on, or an explicit unknown — never a time read off another clock. */
export function formatBaselineProvenance(p: BaselineProvenance | undefined): string {
  return p ? `baseline ${p.baseRef.slice(0, 12)} captured ${p.capturedAt}`
    : "baseline provenance unknown (legacy: no capture identity or time recorded)";
}

export function formatFingerprints(fingerprints: string[] | undefined): string {
  return fingerprints === undefined ? "fingerprints not recorded"
    : fingerprints.length ? fingerprints.join(" | ") : "no fingerprint recognized";
}

export function formatForgiven(f: ForgivenFingerprints): string {
  return `${f.taskId ?? "tip"} ${f.gate}: ${formatFingerprints(f.fingerprints)} — ${formatBaselineProvenance(f.baseline)}`;
}

// OBS-1150: the reviewer reads the same standing rulings the worker brief carries, oldest first. A
// later approval, with or without a reason, adds to them and never supersedes an earlier one.
function approvalReviewContext(events: JournalEvent[], taskId: string): string | undefined {
  const rulings = standingRulings(events, taskId);
  return rulings.length ? rulings.map((ruling) => `- ${ruling}`).join("\n") : undefined;
}

// T14: the events that prove an approval was ENACTED — narrowly causal, never merely subsequent.
// Ordinary, attempt-cap and review-upheld approvals buy a WORKER, so their proof is a dispatch;
// recheck has its own battery enactment below. Generic terminal events are deliberately NOT proof: an approved human-gate
// task can fail in routing before task-dispatch, and the catch appends task-failed — treating that
// as enactment reports "complete" over an approval that never ran (the exact silent-completion this
// task exists to kill).
const DISPATCH_ENACTMENT = new Set(["task-dispatch", "repair-dispatch", "resume-restore"]);
const RECHECK_ENACTMENT = "recheck-battery";

// The ONE approval that enacts without buying a worker: GATE_SATISFIED_RELEASE resumes from the
// persisted task branch after the approved gate (execTask's satisfiedGate branch), whose first act
// for the task is worktree-recreation. That event is causal for this path, not incidental.
const GATE_SATISFIED_ENACTMENT = "worktree-recreation";

// Older daemons enacted rechecks through worker-launch, before recheck-battery existed.
// Preserve that consumption at every scheduling read without changing continuing permission.
// OBS-1158: exported so plan folds battery priority through the SAME consumption-aware seam.
export function pendingDaemonApprovalActions(events: JournalEvent[]) {
  const actions = pendingApprovalActions(events);
  const rechecks = pendingRechecks(events);
  for (const [id, action] of actions) {
    if (action.authority === "battery" && !rechecks.has(id)) actions.delete(id);
  }
  return actions;
}

/**
 * T14, amended by v2.2 T3: approvals the run accepted and never acted on. `approved` above is still
 * built ONCE at startup — replay determinism depends on it — but a live approval is no longer inert:
 * the boundary sweep in the task loop releases what lands while the daemon runs, so an approval
 * written mid-run is enacted at a boundary, during the approval window, or by cancelling tip verify.
 * This fold still exposes decisions that could not enact, including a failure before dispatch.
 * Without this the run-end record stated only buckets and tipVerify, both accurate, over a milestone
 * that was silently incomplete: run …230 ended tipVerify "passed" with two upheld approvals and zero
 * subsequent dispatches. Scored per task on its NEWEST approval: a later approval is the live
 * decision, and the events that answer it are the ones after it.
 */
export function outstandingApprovals(events: JournalEvent[]): string[] {
  const newest = new Map<string, number>();
  // OBS-1178: this reports ANSWERS, not effects — a refused row was answered; an unsound one the daemon
  // has not yet refused (approved, then failed before any dispatch) is still an unanswered decision.
  const { refused } = foldDecisions(events);
  events.forEach((e, i) => { if (e.event === "task-approved" && e.taskId && !refused.has(physicalLine(events, i))) newest.set(e.taskId, i); });
  return [...newest]
    .filter(([taskId, i]) => {
      const release = events[i]!.data.release;
      const noWorker = release === GATE_SATISFIED_RELEASE;
      const recheck = release === RECHECK_RELEASE;
      return !events.slice(i + 1).some((e) => e.taskId === taskId
        && (DISPATCH_ENACTMENT.has(e.event)
          || (noWorker && e.event === GATE_SATISFIED_ENACTMENT)
          || (recheck && e.event === RECHECK_ENACTMENT)));
    })
    .map(([taskId]) => taskId)
    .sort();
}

// VIS-01: one formatter, four readers (run-end journal event, run/resume CLI, run-end notify).
// Parity by construction — every caller renders the same complete bucket line.
export function formatSummary(s: RunSummary): string {
  const tip = s.tipVerify === "failed"
    ? `\ntip verify: FAILED${s.lastMergedTask ? ` (last merged: ${s.lastMergedTask})` : ""}`
    : s.tipVerify === "passed" ? "\ntip verify: passed" : "";
  // T14: an accepted decision this run never enacted is part of the outcome, not a footnote the
  // operator has to reconstruct from the journal — every reader of the record gets it.
  //
  // The recovery command is NOT advertised over all of them (reviewer finding 3). An approval whose
  // task then FAILED before any dispatch replays as `failed`, which plain resume leaves parked, and
  // `--retry-failed` skips it too: classifyTaskFailure returns "infra" when no task-dispatch precedes
  // the failure, and only kind "dispatch" is re-opened (daemon.ts, opts.retryFailed). Naming a command
  // that cannot enact the approval is worse than naming none, so those ids are listed as what they
  // are and the command is claimed only over the ids it actually releases.
  const stalled = s.outstandingApprovals?.filter((id) => s.failed.includes(id)) ?? [];
  const resumable = s.outstandingApprovals?.filter((id) => !s.failed.includes(id)) ?? [];
  const outstanding = s.approvalDisposition === "outstanding" && s.outstandingApprovals?.length
    ? `\napprovals outstanding: ${s.outstandingApprovals.join(", ")} — accepted, never dispatched`
      + (resumable.length ? `; \`tickmarkr resume ${s.runId}\` enacts ${resumable.join(", ")}` : "")
      + (stalled.length ? `; ${stalled.join(", ")} failed before any dispatch — neither resume nor \`--retry-failed\` re-dispatches that` : "")
    : "";
  // OBS-1123: a green that carried baseline reds names each one and the capture that recorded it.
  const forgiven = (s.forgiven ?? []).map((f) => `\nforgiven vs baseline — ${formatForgiven(f)}`).join("");
  return `done: ${s.done.length}, failed: ${s.failed.length}, human: ${s.human.length}, blocked: ${s.blocked.length}, pending: ${s.pending.length}\nintegration branch: ${s.branch}${tip}${outstanding}${forgiven}`;
}

/** The narrator enters the production Run cockpit for this exact run. The
 *  completed static/growing four-hour records precede this default cutover;
 *  an explicit ID prevents a newer journal from redirecting the owned board. */
export const daemonEntrypoint = fileURLToPath(new URL("../cli/index.js", import.meta.url));
export const watchCommand = (runId: string): string =>
  `${shq(process.execPath)} ${shq(daemonEntrypoint)} ui ${shq(runId)} --view run`;

const MAX_ATTEMPTS = 10; // ponytail: hard cap so a pathological ladder can never loop forever

// v1.85 T3 (retry economics): two repairs per engagement, then the fresh ladder. A repair re-uses the
// findings and the landed diff instead of re-buying onboarding; when two of them have not closed the
// battery, the cheaper next move is the ladder's channel change, not a third fix-only pass.
const MAX_REPAIRS = 2;

/** A named oracle decided this acceptance failure — deterministic, unlike an LLM judge verdict. */
const isOracleFailure = (g: GateResult) => g.details.startsWith("oracle failed:");

/**
 * R3 (OBS-186): a gate that DECLINED to run is not a gate that failed. The review gate's skip branch
 * no longer forges `pass: true` to buy passage, so the merge decision has to read the same predicate
 * the run surfaces already read (src/run/activity.ts): pass, or an honest declared skip. Without this
 * the honesty change would silently park every judge-only task at merge — an unrun gate blocking work
 * it was never asked to review. `skipped` is set only by a gate that says so about ITSELF; a red
 * verdict from a review that actually ran still fails here, exactly as before.
 *
 * ONE pair of predicates, every fold. `!g.pass` was correct only while the sole `pass:false` producer
 * was a gate that actually failed; the moment a decline can be recorded red, every `!g.pass` in this
 * file — the retry feedback brief, the review-fix eligibility test, the failing-battery list the
 * ladder and the fingerprint cap are scored on, the structured findings attached to a blocking
 * verdict — reads an unrun gate as a defect. `gateFailed` is the seam they now share, and the journal
 * write below is the seam every OUT-of-file fold shares.
 */
/**
 * T9: `meta.infra === true` overrides BOTH clauses above. A runner that died on the machine
 * (spawn EAGAIN, OOM) without completing a suite answered nothing about the work, so the honest
 * report of that fact must not double as authorization to merge — and it is the merge predicate,
 * not the gate, that has to say so: classifying the failure into infra metadata while still
 * reporting `pass: true` is exactly how a run that never verified anything gets merged. A declared
 * skip stays satisfied; a gate that ran and passed stays satisfied.
 */
export const gateSatisfied = (g: GateResult) => (g.pass || g.meta?.skipped === true) && g.meta?.infra !== true;
const gateFailed = (g: GateResult) => !gateSatisfied(g);

const SIGNAL_EXIT_RE = /\b(?:SIGTERM|SIGKILL|signal\s+(?:9|15)|exit(?:s|ed|\s+code)?\s+(?:137|143))\b/i;
const FAILURE_IDENTITY_RE = /\b(?:AssertionError|FAIL\s+\S|Tests?\s+\d+\s+failed|expected\s+.+\s+to\s+)\b/i;

/** A signalled test runner with no failure identity produced no verdict about HEAD. Baseline owns the
 * ordinary infra vocabulary; this daemon-only rider handles the signal-shaped non-verdict before its
 * journal row and repair accounting are written. */
function classifySignalOnlyTest(g: GateResult): void {
  if (g.gate !== "test" || g.pass || g.meta?.infra === true || !SIGNAL_EXIT_RE.test(g.details)) return;
  const named = Array.isArray(g.meta?.failingTests) && g.meta.failingTests.length > 0;
  if (named || FAILURE_IDENTITY_RE.test(g.details)) return;
  g.meta = { ...g.meta, classification: "infra", infra: true, retryable: false, kind: "signal-exit" };
}

/** OBS-1106: ONE infrastructure predicate for classification, persistence and repair admission. A red
 * that carries an infra fingerprint or classification without `meta.infra` (a legacy journal row, an
 * oracle that named only its classification) is still a non-verdict about the work: it is normalized
 * here BEFORE its journal row and before any park/repair seam reads it, so those seams can key on the
 * same `isInfraResult` the gate cache keys on and never on one metadata field alone. */
function classifyInfraResult(g: GateResult): void {
  classifySignalOnlyTest(g);
  if (g.pass || g.meta?.infra === true || !isInfraResult(g)) return;
  g.meta = { ...g.meta, classification: "infra", infra: true };
}

// OBS-1106 residual: a red whose assertion is a timeout or a wall-clock budget, and the runner-level
// diagnostics (never-started files, a worker RPC timeout) that make such a red infrastructure-SHAPED.
// Shape alone never parks anything: it only buys one isolated re-observation before a charge. A
// fresh-fingerprint section masks digits to `#`, so both spellings of a number are read.
/** v2.6.8 T1: a seat that never LAUNCHED (any launchCause — checkout-proof-timeout, none, or other
 * detail) is not a seat that failed to answer — the same predicate run-gates applies to its run-scoped
 * tally, read here for the live task strike and the resume reconstruction. It never strikes. */
const launchFailureNote = (data: Record<string, unknown>): boolean => data.cause === "seat-launch-failed";
/** v2.6.8 T1: a journaled review-pool-demotion a launch failure caused. The pre-2.6.8 engine struck seats
 * that never launched, so an older journal can carry a demotion whose trigger was a launch failure, or whose
 * two-strike pair counted one beside a single real no-verdict that was not silent on its own. */
const launchCausedDemotion = (data: Record<string, unknown>): boolean => {
  if (launchFailureNote(data)) return true;
  const silent = data.seatAuthoredBytes === 0 || data.cause === "silent" || data.cause === "launch-never-started";
  return Array.isArray(data.causes) && !silent && data.causes.filter((cause) => cause !== "seat-launch-failed").length < 2;
};
/** OBS-1010 / v2.6.8 T1: the review seats a journal's demotions carry into a resumed run as a SOFT
 * preference (ranked last, never excluded) — every review-pool-demotion except the launch-caused ones, which
 * never demote a seat (live or replayed). plan.ts previews a resume with this same fold. */
export function replayedReviewerDemotions(events: readonly JournalEvent[]): Set<string> {
  return new Set(events.filter((event) => event.event === "review-pool-demotion" && typeof event.data.reviewer === "string"
    && !launchCausedDemotion(event.data)).map((event) => event.data.reviewer as string));
}
/** C: the gate-fresh-forced reason that bounds the out-of-scope re-execution, one per journaled subject. */
const OUTSIDE_SCOPE_RED = "no-commit-out-of-scope-red";
const NAMED_FAILURE_FILE_RE = /^\s*(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+>/gm;
/** D-854: the runner certificate the vitest manifest path appends to a red (test-manifest.ts). */
const RUNNER_CERTIFICATE_RE = /runner-level diagnostic: never-started ([^;\s]+); reporter errors ([^;\s]+)/g;
/** C: a journaled test red whose failing-file attribution is nonempty, trustworthy and complete (repair
 * selection's own rule: a behavioral red on a real subject from a full suite or a screen that names
 * every failure), POSITIVELY certified complete by its runner, uncontradicted by the files its own text
 * names, and wholly outside a declared files[]. Empty files[] is unrestricted and never qualifies;
 * every other shape keeps its replay. */
export function outsideScopeRed(t: Task, taskId: string, data: Record<string, unknown>, commit: string): boolean {
  if (!t.files.length || data.gate !== "test" || data.pass !== false || data.skipped === true || data.commit !== commit
    // a failed producer — an infra row, a dirty-tree refusal, a recovery the runner could not finish —
    // never attributes anything, whatever files it lists
    || data.infra === true || data.dirtyWorktree === true || data.recoveryBlocked !== undefined) return false;
  const attribution = repairSelectionDecision([{ event: "gate-result", taskId, data }], taskId, true);
  if (attribution.reason !== "known-failing-files" || attribution.requiredFiles.length === 0) return false;
  const text = readableExcerpt(String(data.details ?? ""));
  // D-854: validate, never filter. A collection failure has no module record, so failingFiles omits it
  // and it lives only in the certificate's counts; any never-started file or reporter error, an unknown
  // count, or no certificate at all leaves the attribution unproven.
  // ponytail: a nonzero count never qualifies, even when each diagnostic names an outside file — the
  // details interleave diagnostics with the stdout tail; map them only if outside-scope collection reds need it.
  const certificates = [...text.matchAll(RUNNER_CERTIFICATE_RE)];
  if (!certificates.length || certificates.some((m) => m[1] !== "0" || m[2] !== "0")) return false;
  const named = [...text.matchAll(ATTRIBUTED_FILE_RE), ...text.matchAll(NAMED_FAILURE_FILE_RE)].map((m) => m[1]!.replace(/^\.\//, ""));
  if (named.some((file) => !attribution.requiredFiles.includes(file))) return false; // contradictory
  const inScope = filesGlob(t.files);
  return attribution.requiredFiles.every((file) => !inScope(file));
}
/** C: every test red a round journaled on `commit` is an out-of-scope red (none means none). */
const allOutsideScopeReds = (t: Task, rows: readonly JournalEvent[], commit: string): boolean => {
  const reds = rows.filter((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === false
    && e.data.skipped !== true && e.data.commit === commit);
  return reds.length > 0 && reds.every((e) => outsideScopeRed(t, e.taskId ?? t.id, e.data, commit));
};
const ATTRIBUTED_FILE_RE = /^\s*(?:FAIL|×|✗)\s+(?:\|[^|\n]*\|\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/gm;
/** The failing files a red attributes to itself: the runner's own list, else its FAIL headlines. */
const attributedFailingFiles = (g: GateResult): string[] => [...new Set(
  Array.isArray(g.meta?.failingFiles) && g.meta.failingFiles.length
    ? g.meta.failingFiles.filter((f): f is string => typeof f === "string")
    : [...readableExcerpt(g.details).matchAll(ATTRIBUTED_FILE_RE)].map((m) => m[1]!.replace(/^\.\//, "")),
)].sort();
const metaFiles = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((f): f is string => typeof f === "string") : undefined;
/** D-607: the files a rerun OBSERVABLY ran — the runner's manifest, the only complete selection
 * evidence. Never the requested selection, and never the per-file lines a runner printed: a runner that
 * ignores file arguments and reports only its failures looks isolated while it ran the whole suite.
 * Undefined without a manifest, and the rerun is then ambiguous. */
const observedSelection = (g: GateResult): string[] | undefined => {
  const ran = metaFiles(g.meta?.manifest);
  return ran?.length ? [...new Set(ran)].sort() : undefined;
};
/** D-607: on the manifest path only the reporter's own attribution counts — a `FAIL path` line inside
 * captured stdout is text, not attribution. Headline lexing is for runners without a reporter. */
const rerunFailingFiles = (g: GateResult): string[] =>
  metaFiles(g.meta?.manifest) ? [...new Set(metaFiles(g.meta?.failingFiles) ?? [])].sort() : attributedFailingFiles(g);
/** OBS-1106 residual, D-607: what ONE isolated rerun of a timeout-shaped red's attributed `files` says about that
 * red. Lifted unchanged out of adjudicateInfraShapedRed (queue row 102) so its closed outcome table runs on this
 * function in-process. Pure: it reads only its arguments; the caller classifies the rerun first. */
export function reobservationOutcome(files: readonly string[], rerun: GateResult): { outcome: "reproduced" | "passed" | "ambiguous"; selection: string[] | undefined } {
  // Reproduced only by failure evidence the rerun ATTRIBUTES to one of exactly these files, from an
  // OBSERVED selection that was exactly these files (D-607): a path merely printed in output, a
  // positional filter that also collected another file, or a runner that ignored the file
  // arguments and reported no manifest of its selection, says nothing about the original red.
  const failing = rerunFailingFiles(rerun);
  const selection = observedSelection(rerun);
  const isolated = selection !== undefined && selection.length === files.length
    && files.every((file) => selection!.includes(file)) && failing.every((file) => files.includes(file));
  const outcome = rerun.pass ? "passed" : isolated && !isInfraResult(rerun) && failing.length ? "reproduced" : "ambiguous";
  return { outcome, selection };
}

// v1.85 T3: the gates whose failure IS a deterministic measurement — a machine re-ran a command over a
// tree and printed the same bytes. Those are the failures the fingerprint cap governs (the ruling names
// it a "deterministic-gate" cap): a third identical answer to a question already answered twice is the
// ~663m-across-5-runs loop, whatever rung the ladder happens to stand on. An LLM verdict is a different
// object — two reviewers, or a judge asked twice, can restate one another without the question being
// closed — and each already carries a tighter bound of its own: REVIEW_ROUND_CAP parks review at the
// OPERATOR in two rounds, and a judge verdict rides the ladder and the attempt cap. The boundary is a
// property of the GATE, never of the ladder rung or of the move that would follow the failure.
const DETERMINISTIC_GATES = new Set<string>(["build", "test", "lint", "evidence", "scope"]);
const isDeterministicFailure = (g: GateResult) =>
  DETERMINISTIC_GATES.has(g.gate) || (g.gate === "acceptance" && isOracleFailure(g));

/**
 * Is the failing battery narrow enough that a fix-only pass can close it? The ruling's three cases:
 * review-only, a single deterministic test/lint gate, or acceptance decided by a named oracle.
 * Unparseable verdicts and diff-cap trips are excluded exactly as they are from the review-fix retry —
 * neither names anything a worker can fix.
 */
function narrowRepairBattery(failing: GateResult[]): boolean {
  if (failing.length !== 1) return false;
  const g = failing[0]!;
  if (g.gate === "review") return g.meta?.unparseable !== true && !isDiffCapPark(g);
  if (g.gate === "test" || g.gate === "lint") return true;
  if (g.gate === "acceptance") return isOracleFailure(g) && g.meta?.unparseable !== true;
  return false;
}

// OBS-1182: re-seating copies the channel's identity AND its launch effort — the four-field copy
// this replaced silently reverted a climbed or pinned seat to the CLI's default effort.
const seatAssignment = (c: Assignment): Assignment => ({
  adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier,
  ...(c.effort ? { effort: c.effort } : {}),
});

// v2.0 T2 (OBS-554): the measurement keys run-gates stamps on a GateResult, lifted verbatim onto the
// gate row. One list, one lift — both onGate sites record through the same helper.
const GATE_TELEMETRY_KEYS = ["durationMs", "load1Start", "load1End", "load1Max", "load1Mean", "selectedDurationMs", "fullDurationMs", "invocations"] as const;

const gateMeasurement = (meta: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries(GATE_TELEMETRY_KEYS.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));

/**
 * T4 (OBS-265): the journal with the review objections a round did NOT hinge on removed. Judge and
 * review are now launched together, so a round can journal a failed review that the serial walk would
 * never have asked for — it returned at the judge. Those verdicts stay on the record (they are real,
 * and the retry brief carries them), but they must not spend the OPERATOR-facing review round budget:
 * otherwise concurrency alone parks a task rounds early for objections the old pipeline never bought.
 * A round is the gate-result span opened by each `gates` phase-start, per task.
 */
export function decisiveReviewRounds(events: JournalEvent[]): JournalEvent[] {
  const open = new Map<string, JournalEvent[]>();
  const spent = new Set<JournalEvent>();
  const close = (taskId: string) => {
    const round = open.get(taskId) ?? [];
    if (round.some((e) => e.data.gate !== "review" && e.data.pass === false)) {
      for (const e of round) if (e.data.gate === "review" && e.data.pass === false) spent.add(e);
    }
    open.delete(taskId);
  };
  for (const e of events) {
    if (!e.taskId) continue;
    if (e.event === "phase-start" && e.data.phase === "gates") close(e.taskId);
    else if (e.event === "gate-result") open.set(e.taskId, [...(open.get(e.taskId) ?? []), e]);
  }
  for (const taskId of open.keys()) close(taskId); // Map iteration tolerates deleting the current key
  return events.filter((e) => !spent.has(e));
}

/** OBS-1034: the files a byte cap drops from a repair diff — every file whose header starts at or past the cap, plus the one the cut lands inside.
 * Offsets are UTF-8 BYTES (the cap's unit), never UTF-16 code units. `names` is the NUL-delimited `git diff --name-only` list in
 * header order, so quoted headers (tabs, quotes, non-ASCII) still name their file. */
function repairDiffFilesCut(diff: Buffer, cap: number, names: readonly string[]): string[] {
  const files: string[] = [];
  const header = Buffer.from("\ndiff --git ");
  const starts: number[] = diff.subarray(0, header.length - 1).equals(header.subarray(1)) ? [0] : [];
  for (let at = diff.indexOf(header); at !== -1; at = diff.indexOf(header, at + 1)) starts.push(at + 1);
  starts.forEach((start, i) => {
    const end = starts[i + 1] === undefined ? diff.length : starts[i + 1]! - 1;
    if (start >= cap || end > cap) files.push(names[i] ?? "(unnamed)");
  });
  return files;
}

/** Assertion evidence is context, never part of the normalized failure identity. */
function repairFindingsBrief(results: GateResult[]): string {
  return results.filter(gateFailed).map((g) => {
    const evidence = g.meta?.failureEvidence;
    return `${g.gate}: ${readableExcerpt(g.details)}` + (Array.isArray(evidence) && evidence.length
      ? `\nAssertion evidence:\n${JSON.stringify(evidence, null, 2)}` : "");
  }).join("\n\n");
}

// OBS-1019 add.2: the order a repeated review chain earns in place of the smallest-edit order.
const REPAIR_CLASS_SENTENCE = "Before editing a chain reraised more than once, enumerate the in-scope consumers,"
  + " bridges, operations and event sequences as a closed case table; repair every implicated member and verify"
  + " the accumulated diff against that table.";

/**
 * The fix-only contract: the findings verbatim, then the diff content of the work already landed.
 * OBS-1019 add.2: a first finding stays bounded to the smallest edit. A chain a review has re-raised
 * more than once was chased edge by edge while every round re-judged the accumulated diff, so it owes
 * the whole class instead: a closed case table inside the declared bounds, never beyond them.
 */
function repairBrief(findings: string, diff: string, baseRef: string, repeated: ReadonlyArray<{ finding: StructuredFinding; reraises: number }> = []): string {
  const repair = { findings, diff };
  return [
    repeated.length ? "## Repair attempt — repair the whole class these findings name" : "## Repair attempt — fix ONLY what these findings name",
    "The commits from your prior attempt are already in this worktree and their diff is reproduced"
    + " below. Do NOT re-implement that work, do not start over, and do not revert it: "
    + (repeated.length ? "resolve every member of the case table below, then commit." : "make the smallest change that resolves every finding, then commit."),
    ...(repeated.length ? [
      "",
      "### Repeated review chains — repair the class, not the next edge",
      // Fingerprint and count only: the finding's prose is already quoted once, below or under its heading.
      ...repeated.map(({ finding, reraises }) => `- \`${finding.fingerprint}\` re-raised ${reraises} times`),
      REPAIR_CLASS_SENTENCE,
      "The table stays inside the task's declared write scope (files[]) and never narrows its goal or an"
      + " acceptance criterion; the reviewer judges the accumulated diff, not the table.",
    ] : []),
    "",
    "### Failing gate findings (verbatim)",
    repair.findings,
    "",
    `### The work under review (git diff ${baseRef.slice(0, 12)}..HEAD)`,
    "```diff",
    repair.diff,
    "```",
  ].join("\n");
}
// v1.70 T5: default request-changes rounds a task may draw before it parks. OBS-419 keeps this as the
// no-ceiling behavior; an operator may narrow only the next engagement on the approval that releases it.
const REVIEW_ROUND_CAP = 2;

// T2: one heading per fact. The first is owed a passing review; the second already drew one and was
// accepted with the reviewer's own rationale, which travels beside (but never changes) its identity.
const OUTSTANDING_FINDINGS_HEADING = "## Outstanding review findings — a review has NOT passed on these yet";
const DEFERRED_FINDINGS_HEADING = "## Deferred review findings — a reviewer ACCEPTED these with a rationale and did NOT block on them; do not re-litigate, fix only if your change touches them";

// OBS-419: the newest approval starts the current engagement, so it is also the sole authority for
// that engagement's optional ceiling. Stop at the newest approval even when the field is absent: a
// later ordinary release restores the module default instead of inheriting an older operator limit.
function approvedReviewRoundCeiling(journaled: JournalEvent[], taskId: string): number | undefined {
  const events = effectiveEvents(journaled); // OBS-1178: a refused or unsound approval sets no ceiling
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.event !== "task-approved" || event.taskId !== taskId) continue;
    const ceiling = event.data.reviewRoundCeiling;
    return typeof ceiling === "number" && Number.isSafeInteger(ceiling) && ceiling > 0
      ? ceiling
      : undefined;
  }
  return undefined;
}
const BLOCKED_POLL_MS = 30_000; // between trailer-wait slices, check whether the pane is blocked on a prompt
export const SUITE_POLL_MS = 250;
// ponytail: one fixed ceiling on the live-suite wait; the baseline's test ceilingMs is the upgrade path
export const SUITE_WAIT_CEILING_MS = 600_000;
let suiteWaitCeilingMs = SUITE_WAIT_CEILING_MS;
export const setSuiteWaitCeilingForTests = (ms: number): void => { suiteWaitCeilingMs = ms; };
export const resetSuiteWaitCeilingForTests = (): void => { suiteWaitCeilingMs = SUITE_WAIT_CEILING_MS; };
export const APPROVAL_POLL_MS = 250;
export const APPROVAL_WINDOW_MS = 120_000;
// Keep ordinary park tests off the operator's production wait. Explicit timing tests
// use the same setter/reset pattern as the suite wait ceiling above.
const DEFAULT_APPROVAL_WINDOW_MS = process.env.VITEST ? 1 : APPROVAL_WINDOW_MS;
let approvalWindowMs = DEFAULT_APPROVAL_WINDOW_MS;
export const setApprovalWindowForTests = (ms: number): void => { approvalWindowMs = ms; };
export const resetApprovalWindowForTests = (): void => { approvalWindowMs = DEFAULT_APPROVAL_WINDOW_MS; };
const PROVIDER_DEATH_REQUEUE_CAP = 2; // v1.46 T1: requeue same assignment twice, then fall through to the normal ladder
const PROVIDER_DEATH_BACKOFF_MS = 500; // short backoff before provider-death requeue
// OBS-1161: transient capacity ("Selected model is at capacity") — bounded same-seat requeues with a
// real wait between them, THEN a same-floor failover; never a demotion. The budget is per task and
// seat, counted from the journal's own capacity-requeue rows so a resume continues it, never restarts it.
const CAPACITY_REQUEUE_CAP = 2;
const CAPACITY_BACKOFF_MS = 60_000;
let capacityBackoffMs = CAPACITY_BACKOFF_MS;
/** Test seam — shrink the capacity backoff without minute-long sleeps. */
export function setCapacityBackoffMsForTests(ms: number): void { capacityBackoffMs = ms; }
export function resetCapacityBackoffMsForTests(): void { capacityBackoffMs = CAPACITY_BACKOFF_MS; }
// OBS-1169: a CLI bootstrap failure buys ONE same-channel retry after a bounded wait — journal-counted
// per task and seat like capacity — and then the adapter is escalated away from, never retried forever.
const BOOTSTRAP_RETRY_CAP = 1;
const BOOTSTRAP_BACKOFF_MS = 5_000;
let bootstrapBackoffMs = BOOTSTRAP_BACKOFF_MS;
/** Test seam — shrink the bootstrap backoff. */
export function setBootstrapBackoffMsForTests(ms: number): void { bootstrapBackoffMs = ms; }
export function resetBootstrapBackoffMsForTests(): void { bootstrapBackoffMs = BOOTSTRAP_BACKOFF_MS; }
const NO_TRAILER_DEMOTION_STREAK = 2; // OBS-57: consecutive no-trailer windows demote a channel for the rest of the run
// OBS-117 (v1.71 T6): a worker pane that never prints a byte by T+60s after dispatch is a dead
// channel — don't burn the full stall window waiting for a silent launch failure. Checked on the
// existing stall-wait poll cadence only (no new timer). Spinner/ANSI repaints count as output.
export const EARLY_LAUNCH_LIVENESS_MS = 60_000;
let earlyLaunchLivenessMs = EARLY_LAUNCH_LIVENESS_MS;
/** Test seam — lowers the empty-pane liveness window without sleeping 60s per case. */
export function setEarlyLaunchLivenessMsForTests(ms: number): void {
  earlyLaunchLivenessMs = ms;
}
export function resetEarlyLaunchLivenessMsForTests(): void {
  earlyLaunchLivenessMs = EARLY_LAUNCH_LIVENESS_MS;
}

// OBS-201 + T1 (OBS-262): the liveness nudge — the daemon's ACTIVE response to a worker holding no
// trailer, replacing page-a-human-then-burn-the-window (289 of 692 worker-minutes in one measured
// day). Gate: NUDGE_AFTER_SILENT_MS of monotonic-tracker silence, regardless of the herdr status
// reading (unknown/working no longer suppress it — a wedged TUI often scrapes as either); a
// `blocked` pane still pages instead, since nudging a dialog prompt can't help. One nudge per
// attempt; if the grace passes with no progress, the wait concludes as a stall NOW and the consult
// sees the un-answered nudge instead of an hour of silence. Scope allowlist lives in stall.ts
// (claude-code only; widening is a fixture-capture chore). The message builder takes no nonce — the
// self-reference guard holds by construction, an echoed bare token can never match the wait regex.
export { NUDGEABLE_ADAPTERS } from "./stall.js";
export const WORKER_NUDGE_MESSAGE =
  "tickmarkr liveness check: if the task is complete, print your TICKMARKR_RESULT completion trailer exactly as specified in your prompt now. If not, state your next concrete action and continue working.";
const NUDGE_AFTER_SILENT_MS = 10 * 60_000; // T1 (OBS-262): >=10m tracker silence — was 3m behind an unreachable status gate
const WORKER_NUDGE_GRACE_MS = 4 * 60_000;
// T1 review: a false return from driver.nudge is a DELIVERY outcome (missing pin, readiness
// stable-frame timeout, read-back hiccup), not proof of an unreachable channel — so one failure
// is retried once in-slice after this settle, and only a failed retry latches nudgeFailed.
const NUDGE_REDELIVER_MS = 2_000;
let nudgeAfterSilentMs = NUDGE_AFTER_SILENT_MS;
let workerNudgeGraceMs = WORKER_NUDGE_GRACE_MS;
/** Test seam — shrink the nudge gate and grace without minute-long sleeps. */
export function setNudgeTimingForTests(silentMs: number, graceMs: number): void {
  nudgeAfterSilentMs = silentMs;
  workerNudgeGraceMs = graceMs;
}
export function resetNudgeTimingForTests(): void {
  nudgeAfterSilentMs = NUDGE_AFTER_SILENT_MS;
  workerNudgeGraceMs = WORKER_NUDGE_GRACE_MS;
}

// T1 (OBS-263): in-loop quota-banner classification — the banner IS output, so the empty-output
// rules can never catch it and the post-loop quota check only runs after the full window. Two
// consecutive matching slices plus this much monotonic-tracker silence classify (a worker whose
// diff merely quotes "rate limit" keeps working undisturbed).
const QUOTA_BANNER_SILENT_MS = 3 * 60_000;
let quotaBannerSilentMs = QUOTA_BANNER_SILENT_MS;
const WORKER_STARTUP_FAILURE_RE = /(?:not logged in|authentication(?:[ _-](?:required|failed|error))|401 unauthorized|model[_ -]?not[_ -]?found|(?:model|deployment)[^\n]{0,80}(?:not found|does not exist|is unavailable)|(?:404|not[_ -]?found)[^\n]{0,80}(?:model|deployment))/i;
// A startup banner is evidence only while the process is starting. Applying this matcher to every
// later poll let ordinary worker prose (including a diff that mentions model-not-found handling)
// condemn a live attempt. Bound both dimensions: time prevents a late line from becoming startup
// evidence, and bytes prevent a chatty launch from keeping an ever-growing classification surface.
export const WORKER_STARTUP_WINDOW_MS = EARLY_LAUNCH_LIVENESS_MS;
export const WORKER_STARTUP_WINDOW_BYTES = 64 * 1024;
let workerStartupWindowMs = WORKER_STARTUP_WINDOW_MS;
/** Test seam — exercises both sides of the startup boundary without a production-length fixture. */
export function setWorkerStartupWindowMsForTests(ms: number): void {
  workerStartupWindowMs = ms;
}
export function resetWorkerStartupWindowMsForTests(): void {
  workerStartupWindowMs = WORKER_STARTUP_WINDOW_MS;
}

export interface StartupFailureEvidence {
  matchedBytes: string;
  offset: number;
  row: string;
  rowNumber: number;
}

/** One seat, one startup prefix. Once execution or its input box is seen, later panes are ineligible. */
export class StartupFailureDetector {
  private closed = false;
  constructor(
    private readonly adapter: Pick<WorkerAdapter, "inputBox" | "harnessBannerRows">,
    private readonly pattern: RegExp = WORKER_STARTUP_FAILURE_RE, // OBS-1169: or known bootstrap text
    // OBS-1169: bootstrap evidence must own the WHOLE bounded prefix — a match followed by a tool frame
    // or an input box anywhere later in the sample is a worker that ran, not a CLI that died starting.
    private readonly wholePrefix = false,
  ) {}

  sample(output: string, launchedAt: number | undefined): StartupFailureEvidence | undefined {
    if (this.closed || launchedAt === undefined || Date.now() - launchedAt > workerStartupWindowMs) return;
    // read() returns a tail, not a guaranteed transcript origin. A saturated read cannot
    // establish startup ownership: the first tool frame may already have scrolled out.
    if (Buffer.byteLength(output) >= WORKER_STARTUP_WINDOW_BYTES || output.split("\n").length >= 500) {
      this.closed = true;
      return;
    }
    const bounded = output;
    const rows = bounded.split("\n");
    let inputStart = rows.length;
    const input = this.adapter.inputBox;
    if (input && matchesInputBox(bounded, input)) {
      // Locate the beginning, including multi-row composers whose footer proves the matcher.
      let end = rows.length;
      let low = 1;
      while (low < end) {
        const mid = Math.floor((low + end) / 2);
        if (matchesInputBox(rows.slice(0, mid).join("\n"), input)) end = mid;
        else low = mid + 1;
      }
      inputStart = 0;
      let high = end;
      while (inputStart + 1 < high) {
        const mid = Math.floor((inputStart + high) / 2);
        if (matchesInputBox(rows.slice(mid, end).join("\n"), input)) inputStart = mid;
        else high = mid;
      }
    }
    let offset = 0;
    let found: StartupFailureEvidence | undefined;
    for (const [index, row] of rows.entries()) {
      const cleanRow = row.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      // Structured tool frames and the terminal's tool headings close the prefix BEFORE their body.
      const toolFrame = /"(?:type|role)"\s*:\s*"(?:tool[^" ]*|function_call[^" ]*|command_execution)"|^\s*(?:[•⏺]\s*(?:Ran|Explored|Searched|Called|Bash|Read|Write|Edit|Shell|Exec|Tool)\b|⎋ |(?:tool[-_ ](?:call|output|result)|function_call)\b)/i.test(cleanRow);
      if (toolFrame || index >= inputStart) {
        this.closed = true;
        return;
      }
      if (!found && !this.adapter.harnessBannerRows?.includes(cleanRow)) {
        const match = this.pattern.exec(row);
        if (match) {
          found = {
            matchedBytes: match[0], offset: offset + Buffer.byteLength(row.slice(0, match.index)),
            row, rowNumber: index + 1,
          };
          if (!this.wholePrefix) return found;
        }
      }
      offset += Buffer.byteLength(row) + 1;
    }
    return found;
  }
}

// OBS-901/906: one daemon-owned writer for every execution surface. Drivers expose one retained
// stream through read(); the daemon persists that exact surface before any close/reconcile can make
// it disappear. MAX_BUF is the execution layer's existing two-MiB retention contract; truncate the
// encoded bytes from the head so the completion/error tail is always the part that survives.
async function captureWorkerStream(
  journalDir: string,
  taskId: string,
  attempt: number,
  driver: ExecutorDriver,
  slot: Slot,
  fallback: string,
): Promise<{ path: string; output: string }> {
  let captured = fallback;
  try {
    captured = await driver.read(slot, PANE_READ_ROWS);
  } catch (error) {
    if (error instanceof HeldProbeExhausted) throw error;
    // Earlier successful reads are still a captured stream. Persist them rather than losing the
    // only failure evidence because the pane vanished between its terminal read and this snapshot.
  }
  const bytes = Buffer.from(captured);
  const tail = bytes.length > MAX_BUF ? bytes.subarray(bytes.length - MAX_BUF) : bytes;
  const path = posix.join("prompts", `${taskId}-a${attempt}.out`);
  writeFileSync(join(journalDir, path), tail);
  return { path, output: captured };
}
/** Test seam — shrink the quota-banner silence gate without minute-long sleeps. */
export function setQuotaBannerSilentMsForTests(ms: number): void {
  quotaBannerSilentMs = ms;
}
export function resetQuotaBannerSilentMsForTests(): void {
  quotaBannerSilentMs = QUOTA_BANNER_SILENT_MS;
}

// T1 (OBS-262): the operator page is UNLATCHED — every eligible slice journals a page, and the
// notification is delivered again on a status change or once this cadence elapses. The cadence is
// an operator-spam guard only; it can no longer turn a stall into a single page forever. It sits
// BELOW the dead-channel fast-kill window on purpose (T1 review): at 5m == 5m the second delivery
// raced the kill on the same slice boundary, so an idle non-nudgeable pane holding no delta — the
// exact class the repeat exists for — got exactly one page in production.
const PAGE_REPEAT_MS = 2 * 60_000;
let pageRepeatMs = PAGE_REPEAT_MS;
/** Test seam — shrink the repeat-page cadence without minute-long sleeps. */
export function setPageRepeatMsForTests(ms: number): void {
  pageRepeatMs = ms;
}
export function resetPageRepeatMsForTests(): void {
  pageRepeatMs = PAGE_REPEAT_MS;
}

// T1 (R1 dead-channel fast-kill): a worker with no trailer, no worktree delta, and no output
// growth for this long is dead — conclude immediately instead of burning the rolling window.
// Per-task timeoutMinutes stays the escape valve for slow-but-live workers.
const DEAD_CHANNEL_FAST_KILL_MS = 5 * 60_000;
let deadChannelFastKillMs = DEAD_CHANNEL_FAST_KILL_MS;
/** Test seam — shrink the fast-kill window without minute-long sleeps. */
export function setDeadChannelFastKillMsForTests(ms: number): void {
  deadChannelFastKillMs = ms;
}
export function resetDeadChannelFastKillMsForTests(): void {
  deadChannelFastKillMs = DEAD_CHANNEL_FAST_KILL_MS;
}

// T2 (OBS-264): finished work is harvested, never redone. 18 of 18 observed stalls carried 2-33
// commits, and the redispatch then re-bought verification of work that had already landed. The
// liveness triad — commits made by this attempt, a FLAT worker-tree CPU delta, and this much
// monotonic-tracker silence — CONCLUDES the wait. Conclude, never kill: the pane is harvested by
// the same tail a window expiry uses, and the carried worktree goes straight to gates. Set at the
// fast-kill's window on purpose (the OBS-264 arithmetic is "a ~36m stall + ~15m redo becomes a
// ~5m gate pass"); a worker that is merely thinking still burns CPU and is never concluded here.
const HARVEST_SILENT_MS = 5 * 60_000;
let harvestSilentMs = HARVEST_SILENT_MS;
/** Test seam — shrink the harvest silence gate without minute-long sleeps. */
export function setHarvestSilentMsForTests(ms: number): void {
  harvestSilentMs = ms;
}
export function resetHarvestSilentMsForTests(): void {
  harvestSilentMs = HARVEST_SILENT_MS;
}
// Once the silence gate is met the CPU probe owns the poll cadence: the trailer-wait slice is 30s,
// so two samples would otherwise cost a minute of wall clock apiece. Below the gate the only rule
// is not to sleep PAST it — at the shipped 5m gate that changes no slice a worker sees today.
const HARVEST_POLL_MS = 2_000;
function harvestSliceMs(silentMs: number): number {
  return Math.max(100, silentMs >= harvestSilentMs ? HARVEST_POLL_MS : harvestSilentMs - silentMs);
}

// The synthesized result a carried no-trailer harvest hands to the gates. Distinct from anything a
// worker can claim: it never comes from adapter.parse, and it is journaled under its own event.
export const HARVESTED_RESULT_SUMMARY = "harvested: the worktree carries committed work; the worker emitted no TICKMARKR_RESULT trailer";

/** T4 (OBS-266): identity of the command SET a tip verify ran — a changed command is a different verify. */
export function commandsHash(commands: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(commands).sort())).digest("hex").slice(0, 12);
}

/**
 * T7: a cycle also carries EVERY capacity its own rows recorded — the start row's and each verdict
 * row's, one entry per row, never a single value the start row speaks for. A start row states the
 * world the cycle INTENDED to run in; the row that carries a green is the one that measured it, and
 * a cycle whose rows disagree (or whose verdict row is malformed) is not a cycle whose green anyone
 * can carry forward. A pre-T7 cycle contributes `undefined`s, which is why an older journal keeps
 * carrying its green forward exactly as it does today.
 */
interface VerifyCycle {
  tip: string;
  cmdHash: string;
  gates: Set<string>;
  failed: boolean;
  forgiven: boolean;
  capacities: unknown[];
  evidenceByGate: Map<string, JournalEvent["data"]>;
}

/**
 * T4 (OBS-266): the journal's LAST verification cycle — the (tip, cmdHash) pair the most recent run
 * of the verify commands spoke for, the gates it got a pass from, and whether anything failed in it.
 *
 * The LAST one, never a history of every pair ever green. "The last GREEN verified SHA" is what the
 * spec licenses a skip against, and only the last cycle is a statement about the state the run is in
 * now: after A→B→A the tip really moved, and after commands A→B→A the last thing that ran on this
 * SHA was command set B — both re-verify. A cycle is the contiguous run of events sharing one pair,
 * so a cycle cut short by a killed process is missing gates and can never satisfy the caller. A
 * legacy event (no tip/cmdHash) is unattributable and breaks the chain outright.
 */
function lastVerifyCycle(events: JournalEvent[]): VerifyCycle | undefined {
  let cur: VerifyCycle | undefined;
  let afterRunEnd = false;
  for (const e of events) {
    // New journals delimit every attempt explicitly. run-end is the legacy delimiter: it starts a
    // new cycle only when another verify event follows, while preserving the just-closed cycle as
    // the cache candidate for an otherwise unmoved next run-end.
    if (e.event === "tip-verify-start") {
      const { tip, cmdHash } = e.data;
      cur = typeof tip === "string" && typeof cmdHash === "string"
        ? { tip, cmdHash, gates: new Set(), failed: false, forgiven: false, capacities: [e.data.capacity], evidenceByGate: new Map() }
        : undefined;
      afterRunEnd = false;
      continue;
    }
    if (e.event === "tip-verify-cancelled") {
      if (cur) cur.failed = true;
      continue;
    }
    if (e.event === "run-end") {
      afterRunEnd = true;
      continue;
    }
    if (e.event !== "tip-verify" && e.event !== "tip-verify-failed") continue;
    const { tip, gate, cmdHash } = e.data;
    if (typeof tip !== "string" || typeof gate !== "string" || typeof cmdHash !== "string") {
      cur = undefined;
      afterRunEnd = false;
      continue;
    }
    if (!cur || afterRunEnd || cur.tip !== tip || cur.cmdHash !== cmdHash) {
      cur = { tip, cmdHash, gates: new Set(), failed: false, forgiven: false, capacities: [], evidenceByGate: new Map() };
    }
    afterRunEnd = false;
    // T7: EVERY verdict row's own capacity, not just the start row's. The start row is a statement of
    // intent written before a single command ran; the green this cache would carry forward lives on
    // these rows, so a row whose capacity differs from the session's — or which is malformed — has to
    // be able to sink the cycle by itself.
    cur.capacities.push(e.data.capacity);
    if (e.event === "tip-verify-failed") cur.failed = true;
    else {
      cur.gates.add(gate);
      cur.evidenceByGate.set(gate, e.data);
      // Q121s review M1: a forgiven green depends on the baseline that forgave it. Baselines are not
      // part of the cache key, so a forgiven cycle is NEVER cache-eligible — an unchanged tip whose
      // baseline later vanishes or changes must re-run the full verify, not inherit the green.
      if (e.data.forgiven === true) cur.forgiven = true;
    }
  }
  return cur;
}

export interface TipProof {
  kind: "fresh" | "reused" | "failed" | "incomplete";
  /** Each completed gate keeps its own execution provenance, even in a mixed cycle. */
  gates?: Array<{ gate: string; kind: "fresh" | "reused" }>;
  /** the commit the cycle's start row spoke for */
  tip?: string;
}

/**
 * OBS-1077 close rider: what the engagement's LATEST verification cycle proved — its
 * `tip-verify-start` row and what followed, never a commit comparison. Exactly one kind per close:
 * fresh (every tip command ran AND passed), reused (an eligible cached cycle carried forward),
 * failed, or incomplete (cancelled, cut short or undelimited). Completed mixed cycles retain each
 * gate's kind beside the whole-cycle reused kind. Nothing before the start row
 * is read, so an unfinished cycle inherits nothing from an earlier green one.
 */
export function runEndTipProof(events: readonly JournalEvent[]): TipProof {
  const start = events.map((e) => e.event).lastIndexOf("tip-verify-start");
  if (start < 0) return { kind: "incomplete" };
  const { tip: rawTip, gates: rawGates } = events[start]!.data;
  const tip = typeof rawTip === "string" ? rawTip : undefined;
  const proof = (kind: TipProof["kind"]): TipProof => ({ kind, ...(tip ? { tip } : {}) });
  const after = events.slice(start + 1);
  if (after.some((e) => e.event === "tip-verify-failed")) return proof("failed");
  if (after.some((e) => e.event === "tip-verify-cancelled")) return proof("incomplete");
  const rows = after.filter((e) => e.event === "tip-verify" && e.data.pass === true && e.data.tip === tip);
  const gates = Array.isArray(rawGates) ? rawGates as unknown[] : [];
  if (!tip || gates.length === 0 || !gates.every((g) => rows.some((r) => r.data.gate === g))) return proof("incomplete");
  const carried = rows.filter((r) => r.data.cached === true).length;
  const cachedRow = after.some((e) => e.event === "tip-verify-cached");
  // A whole-cycle carry must be declared by the start row, stated by the cache row and borne by every verdict row.
  if ((events[start]!.data.cached === true) !== cachedRow || (cachedRow && carried !== rows.length)) return proof("incomplete");
  // D-131: fresh only when EVERY command executed; one per-gate persisted verdict makes the cycle reused.
  return {
    ...proof(carried > 0 ? "reused" : "fresh"),
    gates: gates.map((gate) => ({
      gate: String(gate),
      kind: rows.some((r) => r.data.gate === gate && r.data.cached === true) ? "reused" : "fresh",
    })),
  };
}

/** The close notification's statement of the proof — one clause per kind. */
export function formatTipProof(p: TipProof): string {
  const at = p.tip ? ` ${p.tip.slice(0, 12)}` : "";
  const gateReading = p.gates?.map(({ gate, kind }) =>
    `${gate}: ${kind === "fresh" ? "verified fresh" : "cached (reused) — carried, not re-run"}`).join("; ");
  const suffix = gateReading ? `; ${gateReading}` : "";
  if (p.kind === "reused" && p.gates?.some(({ kind }) => kind === "fresh")) {
    return `tip proof: ${p.kind} — commit${at}; ${gateReading}`;
  }
  switch (p.kind) {
    case "fresh": return `tip proof: fresh — every tip command ran and passed on${at || " the integration tip"}${suffix}`;
    case "reused": return `tip proof: reused — carried from verified commit${at}, commands not re-run${suffix}`;
    case "failed": return `tip proof: failed —${at ? ` commit${at}` : ""} latest verification cycle is red`;
    case "incomplete": return `tip proof: incomplete —${at ? ` commit${at}` : ""} latest verification cycle did not finish`;
  }
}

// Isolate the battery so cancellation can stop its control flow as well as its shell children.
// The child uses the same verifier and capacity; only the daemon writes lifecycle verdict rows.
async function cancellableTipBattery(
  intWt: string, commands: Record<string, string>, runDir: string,
  baseline: Baseline | undefined, signal: AbortSignal, evidence: GateEvidenceOptions = {},
): Promise<Awaited<ReturnType<typeof verifyIntegrationTip>>> {
  signal.throwIfAborted();
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const shells = new Set();
    let cancelled = false;
    const spawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      // Preserve the owning daemon's census identity across this implementation subprocess.
      if (args[2]?.env) args[2] = { ...args[2], env: { ...args[2].env, ${JSON.stringify(SUITE_PARENT_ENV)}: ${JSON.stringify(String(process.pid))} } };
      const child = spawn(...args);
      if (child.pid && args[2]?.detached) shells.add(child.pid);
      child.once('close', () => shells.delete(child.pid));
      return child;
    };
    syncBuiltinESMExports();
    process.on('SIGTERM', () => {
      cancelled = true;
      for (const pid of shells) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') { console.error(error); process.exit(1); } }
      }
      // Reap the shell pipes before exiting; no verifier continuation may start another gate.
      childProcess.spawn = () => { throw new Error('tip verify cancelled'); };
      syncBuiltinESMExports();
      const reaped = () => { if (!shells.size) process.exit(143); else setTimeout(reaped, 10); };
      reaped();
    });
    const { verifyIntegrationTip } = await import(${JSON.stringify(new URL(`./merge.${extension}`, import.meta.url).href)});
    const { runWithVerificationBudget } = await import(${JSON.stringify(new URL(`./git.${extension}`, import.meta.url).href)});
    const { runWithCommandLease } = await import(${JSON.stringify(new URL(`./lease.${extension}`, import.meta.url).href)});
    let sequence = 0;
    const grants = new Map();
    const commandCapacities = new Map();
    process.on('message', (message) => {
      if (message.type === 'lease-grant') { grants.get(message.id)?.(message); grants.delete(message.id); }
    });
    const lease = async (command, execute) => {
      const id = ++sequence;
      const grant = new Promise(resolve => grants.set(id, resolve));
      process.send({ type: 'lease-acquire', id, command });
      const { capacity, token } = await grant;
      commandCapacities.set(command, capacity);
      try { return await runWithVerificationBudget(capacity, () => execute(token)); }
      finally { process.send({ type: 'lease-release', id }); }
    };
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const { intWt, commands, runDir, baseline, capacity, evidence } = JSON.parse(input);
    try {
      const result = await runWithVerificationBudget(capacity, () => runWithCommandLease(lease, () => verifyIntegrationTip(intWt, commands, runDir, baseline, evidence)));
      if (!cancelled) process.stdout.write(JSON.stringify(result.map(row => ({ ...row, capacity: [...commandCapacities].reverse().find(([command]) => command === row.cmd || command.startsWith(row.cmd + " "))?.[1] ?? capacity }))));
    } catch (error) { if (!cancelled) throw error; }
    finally { process.disconnect(); }
  `;
  const child = spawn(process.execPath, [
    ...(extension === "ts" ? ["--import", createRequire(import.meta.url).resolve("tsx")] : []),
    "--input-type=module", "-e", script,
  ], { env: commandLeaseEnvironment(process.env), stdio: ["pipe", "pipe", "pipe", "ipc"], detached: true });
  const releases = new Map<number, () => void>();
  const leases = new Set<Promise<unknown>>();
  let closed = false;
  child.on("message", (message: { type: string; id: number; command: string }) => {
    if (message.type === "lease-release") { releases.get(message.id)?.(); releases.delete(message.id); }
    if (message.type !== "lease-acquire") return;
    const held = withCommandLease(message.command, async () => {
      if (closed || signal.aborted) return;
      const released = new Promise<void>((resolve) => releases.set(message.id, resolve));
      child.send({ type: "lease-grant", id: message.id, capacity: resolvedCapacity(), token: currentCommandLeaseToken() });
      await released;
    });
    leases.add(held);
    void held.catch(() => {}).finally(() => leases.delete(held));
  });
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { errors += chunk; });
  const cancel = () => { child.kill("SIGTERM"); };
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      for (const release of releases.values()) release();
      releases.clear();
      if (signal.aborted && (code === 143 || code === null)) reject(signal.reason);
      else if (code !== 0) reject(new Error(`tip verifier exited ${code}: ${errors}`));
      else resolve();
    });
  });
  signal.addEventListener("abort", cancel, { once: true });
  child.stdin!.on("error", () => { /* exit/abort is reported by finished */ });
  child.stdin!.end(JSON.stringify({ intWt, commands, runDir, baseline, capacity: resolvedCapacity(), evidence }));
  try {
    if (signal.aborted) cancel();
    await finished;
    return JSON.parse(output);
  } finally {
    signal.removeEventListener("abort", cancel);
    await Promise.allSettled(leases);
  }
}

/**
 * OBS-34's strict tip verify, but it stops re-paying for an unmoved tip (~334m corpus-wide; 69.5m in
 * one park-heavy run whose 18 resume cycles merged nothing new). The verify journals the SHA it
 * verified and the hash of the command set, so a later run-end can recognize the same verified state:
 * head equals the LAST green verified SHA, commands unchanged, tree clean → journal
 * `tip-verify-cached` and skip. ANY doubt — moved head, changed commands, dirty tree, a gate missing
 * from that cycle's green set, a failure recorded in it, a cycle older than the last one — runs the
 * full verify. The tip-verify-before-green law is untouched: a cached green is a verified green OF
 * THAT EXACT COMMIT, established by the most recent real run of the same commands.
 * Returns whether the tip is failing.
 */
export async function verifyIntegrationTipCached(
  intWt: string,
  commands: Record<string, string>,
  journal: Journal,
  opts: { lastMergedTask?: string; baseline?: Baseline; signal?: AbortSignal; evidence?: GateEvidenceOptions } = {},
): Promise<boolean> {
  opts.signal?.throwIfAborted();
  const cmdHash = commandsHash(commands);
  const tip = await gitHead(intWt);
  // T7: the capacity this session's verify children WOULD run under — the third thing a carried
  // green must match, beside the tip and the command set. A cached verdict is the one place a green
  // crosses a session boundary with nothing re-run, and a session resumed at a different capacity
  // divides the machine by a different number: that green was established in another world, so it is
  // not carried forward and the commands run again. A pre-T7 cycle records no capacity and keeps
  // exactly the behaviour it has today.
  const capacity = resolvedCapacity();
  const porcelain = await shGit("git status --porcelain", intWt);
  const clean = porcelain.code === 0 && porcelain.stdout.trim() === "";
  const last = lastVerifyCycle(journal.read());
  const gates = Object.keys(commands).filter((g) => g !== "tipTest");
  if (!gates.includes("test") && commands.tipTest) gates.push("test");
  const cached = last !== undefined && !last.failed && !last.forgiven && last.tip === tip && last.cmdHash === cmdHash
    && gates.every((g) => last.gates.has(g))
    && last.capacities.every((recorded) => sameCapacity(recorded, capacity));
  // A pair can be verified red and then green without either SHA or command hash changing (for
  // example, an external service or ignored fixture recovers). Delimit attempts explicitly so that
  // the earlier red cannot remain latched into the later complete green cycle.
  journal.append("tip-verify-start", undefined, { tip, cmdHash, capacity, gates, cached: clean && cached });
  opts.signal?.throwIfAborted();
  if (clean && cached) {
    journal.append("tip-verify-cached", undefined, { tip, cmdHash, capacity, gates });
    // The skip must not read as a red. Every surface derives the tip's verdict from this cycle's
    // `tip-verify` events (cockpit derive.ts tipVerificationPassed: a run-end claiming "passed" with
    // ZERO events is fail-closed to FALSE), so a carried-forward green still journals its per-gate
    // pass — `cached: true` keeps it honest about not having re-run the command.
    for (const gate of gates) {
      const cmd = gate === "test" && commands.tipTest ? commands.tipTest : commands[gate]!;
      journal.append("tip-verify", undefined, { ...reusedTipEvidence(last.evidenceByGate.get(gate) ?? {}), gate, cmd, pass: true, exitCode: 0, cached: true, tip, cmdHash, capacity });
    }
    return false;
  }
  let tipFailed = false;
  for (const r of await runWithInterruptionSink(journalInterruption(journal, undefined), () => opts.signal
    ? cancellableTipBattery(intWt, commands, journal.dir, opts.baseline, opts.signal, opts.evidence)
    : verifyIntegrationTip(intWt, commands, journal.dir, opts.baseline, opts.evidence))) {
    const measuredCapacity = (r as typeof r & { capacity?: RunCapacity }).capacity ?? capacity;
    const evidence = r.reused ? reusedTipEvidence(r) : {
      ...(r.originRunRoot ? { originRunRoot: r.originRunRoot } : {}),
      ...(r.cause ? { cause: r.cause } : {}),
      ...(r.evidenceReceipt ? { evidenceReceipt: r.evidenceReceipt } : {}),
      ...(r.evidenceReceipts ? { evidenceReceipts: r.evidenceReceipts } : {}),
      ...(r.evidenceAbsence ? { evidenceAbsence: r.evidenceAbsence } : {}),
      ...Object.fromEntries(["nonce", "stdoutPath", "stderrPath"]
        .filter(key => r[key as keyof typeof r] !== undefined).map(key => [key, r[key as keyof typeof r]])),
    };
    if (r.pass) {
      // Q121s: a forgiven pass journals its fingerprints — honest about what was carried, never a silent green.
      journal.append("tip-verify", undefined, { ...evidence, gate: r.gate, cmd: r.cmd, pass: true, exitCode: r.exitCode, details: r.details, ...(r.reused ? { cached: true } : {}), ...(r.forgiven ? { forgiven: true, fingerprints: r.fingerprints, ...(r.baselineProvenance ? { baselineProvenance: r.baselineProvenance } : {}) } : {}), tip, cmdHash, capacity: measuredCapacity });
    } else {
      journal.append("tip-verify-failed", undefined, {
        ...evidence,
        gate: r.gate,
        cmd: r.cmd,
        exitCode: r.exitCode,
        fingerprints: r.fingerprints,
        artifact: r.artifact,
        ...(r.details ? { details: r.details } : {}),
        lastMergedTask: opts.lastMergedTask,
        tip,
        cmdHash,
        capacity: measuredCapacity,
      });
      tipFailed = true;
    }
  }
  return tipFailed;
}

/** OBS-953: a detected wall-over-monotonic discontinuity journals `host-suspend` (its offset was
 * subtracted from active test time); an overdue poll whose clocks advanced together journals
 * `host-poll-overdue` (recorded, never subtracted). */
const journalInterruption = (journal: Journal, taskId: string | undefined) => (interruption: HostInterruption): void => {
  journal.append(interruption.kind === "host-suspend" ? "host-suspend" : "host-poll-overdue", taskId, { ...interruption });
};

async function commitsAheadOfRef(base: string, head: string, cwd: string): Promise<string[]> {
  if (head === base) return [];
  const r = await shGit(`git log --reverse --format=%H ${shq(base)}..${shq(head)}`, cwd);
  return r.code === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
}

async function commitsAheadOf(base: string, wt: string): Promise<string[]> {
  const head = await gitHead(wt);
  if (head === base) return [];
  const r = await shGit(`git log --reverse --format=%H ${shq(base)}..${shq(head)}`, wt);
  if (r.code !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean);
}

// Gate reuse needs a commit-scoped token, but raw Git object ids also contain wall-clock commit
// metadata. Two byte-identical attempts in independent repositories therefore get different ids,
// which would make an otherwise observational daemon option change the journal. Canonicalize the
// task's commit series from the full tree at each commit plus its stable author/message identity.
// This still changes for content edits, reordered/squashed commits and empty commits, while remaining
// identical for the same logical commit series reproduced in another repository.
async function gateCommitSubject(base: string, head: string, wt: string): Promise<string> {
  const history = await shGit(
    `git log --reverse --format='%T%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e' ${shq(base)}..${shq(head)}`,
    wt,
  );
  if (history.code !== 0) return head; // fail closed to the exact object id if canonicalization fails
  return createHash("sha256").update(history.stdout).digest("hex");
}

type WorktreeObservation =
  | { state: "READABLE"; signature: string }
  | { state: "UNREADABLE" };

type WorktreeComparison = "changed" | "unchanged" | "unreadable";

type WorkerProcessTree = "empty" | "running" | "unmeasurable";

// A CPU total cannot prove a tree empty: a newly launched live process can still have a measured
// total of zero at the host's clock resolution. This probe asks the narrower cardinality question
// OBS-737 needs. A readable process table with no marker root is measured empty; a failed or empty
// table is unmeasurable. Descendants are closed over PPID because not every child retains the
// dispatch-script marker in its own argv.
export async function observeWorkerProcessTree(marker: string, cwd: string): Promise<WorkerProcessTree> {
  // queue row 113: `ps` is not git, so the payload entry — the own-git entry's pin probes are two SYNC git spawns per call
  const snapshot = await shell("ps -Awwo pid=,ppid=,command=", cwd, 15_000);
  if (snapshot.code !== 0) return "unmeasurable";
  const rows: { pid: string; ppid: string; command: string }[] = [];
  for (const line of snapshot.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: match[1]!, ppid: match[2]!, command: match[3]! });
  }
  if (rows.length === 0) return "unmeasurable";
  const tree = new Set(rows.filter((row) => row.command.includes(marker)).map((row) => row.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return tree.size === 0 ? "empty" : "running";
}

interface ProcessRow { pid: number; ppid: number; command: string }

type SuitePidProbe = (pid: number) => number | undefined;

const pathAtOrBelow = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Count full-suite roots in one process-table snapshot. The probes are arguments so the ownership
 * rules remain testable on hosts that forbid process inspection; production supplies cwd and the
 * inherited TICKMARKR_SUITE_PARENT marker from one batched async probe (suite-census.ts, queue row 103). */
export function countLiveSuites(
  snapshot: string,
  repoRoot: string,
  daemonPid: number,
  cwdForPid: (pid: number) => string | undefined,
  suiteParentForPid: SuitePidProbe,
): number {
  const rows: ProcessRow[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match && !match[3]!.startsWith("Z")) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[4]! });
    }
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors = new Set<number>();
  for (let pid = daemonPid; pid && !ancestors.has(pid); pid = byPid.get(pid)?.ppid ?? 0) ancestors.add(pid);
  const descendants = new Set<number>([daemonPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
      descendants.add(row.pid);
      grew = true;
    }
  }
  const root = realpathSync(repoRoot);
  // OBS-889 (run 3372): a bare-codex worker carries its whole prompt in argv and the prompt names the
  // runner ("…as a vitest test whose…"), so a finished interactive worker counted as a live suite and
  // held a task's gates for 9 min 46 s. A runner is named in a command's HEAD — `node <bin>`,
  // `npm test`, `npx vitest`, `sh -c npm test` — never 140 KB into it: read the first four tokens only.
  const candidates = rows.filter((row) => !ancestors.has(row.pid) && isRunnerCommand(row.command));
  const attributable = new Set(candidates.filter((row) => {
    if (descendants.has(row.pid)) return true;
    const cwd = cwdForPid(row.pid);
    if (cwd !== undefined && pathAtOrBelow(root, cwd)) return true;
    const suiteParent = suiteParentForPid(row.pid);
    if (suiteParent === daemonPid) return true;
    const parentCwd = suiteParent === undefined ? undefined : cwdForPid(suiteParent);
    return parentCwd !== undefined && pathAtOrBelow(root, parentCwd);
  }).map((row) => row.pid));
  // npm/npx + vitest + pool workers are one suite. Count only attributable suite processes with no
  // attributable suite ancestor, while still following ordinary non-suite parents between them.
  return [...attributable].filter((pid) => {
    for (let parent = byPid.get(pid)?.ppid; parent; parent = byPid.get(parent)?.ppid) {
      if (attributable.has(parent)) return false;
    }
    return true;
  }).length;
}

let liveSuiteCountForTests: ((repoRoot: string) => Promise<number>) | undefined;
export const setLiveSuiteCountForTests = (probe: (repoRoot: string) => Promise<number>): void => {
  liveSuiteCountForTests = probe;
};
export const resetLiveSuiteCountForTests = (): void => { liveSuiteCountForTests = undefined; };

/** Live full-suite roots attributable to this repository or this daemon. Ancestors are excluded so
 * a daemon invoked by vitest does not wait on its own test harness forever. */
export async function liveSuiteCount(repoRoot: string): Promise<number> {
  if (liveSuiteCountForTests) return liveSuiteCountForTests(repoRoot);
  // queue row 113: `ps` is not git, so the payload entry — the own-git entry's pin probes are two SYNC git spawns per call
  const snapshot = await shell("ps -Aww -o pid=,ppid=,state=,command=", repoRoot, 15_000);
  if (snapshot.code !== 0) return 0;
  // row 103: one batched async probe per snapshot — a synchronous lsof/ps per pid held this loop 44–46 s
  const probes = await batchedProcessProbes(runnerPids(snapshot.stdout));
  return countLiveSuites(snapshot.stdout, repoRoot, process.pid, probes.cwd, probes.suiteParent);
}

const OBSERVE_CHUNK_BYTES = 64 * 1024;
const OBSERVE_BUDGET_BYTES = 256 * 1024 * 1024;
let observeBudgetBytes = OBSERVE_BUDGET_BYTES;

/** Test seam — exercise the production observer's total read bound with a small real tree. */
export function setObserveBudgetBytesForTests(bytes: number): void {
  observeBudgetBytes = bytes;
}

export function resetObserveBudgetBytesForTests(): void {
  observeBudgetBytes = OBSERVE_BUDGET_BYTES;
}

function isInsideWorktree(worktree: string, path: string): boolean {
  const fromRoot = relative(worktree, path);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function observedPath(worktree: string, path: string): string {
  const root = resolve(worktree);
  const fullPath = resolve(root, path);
  if (!isInsideWorktree(root, fullPath)) throw new Error(`observation path escapes worktree: ${path}`);
  return fullPath;
}

// Worker-controlled paths are never followed. A regular file is opened with O_NOFOLLOW and
// revalidated through its descriptor before its mode and bytes enter the signature. A symlink is
// identified by its link text only, and a target outside the worker worktree makes the observation
// unreadable. Every byte is charged to the one observation budget.
function hashObservedPath(hash: Hash, worktree: string, path: string, budget: number): number {
  const fullPath = observedPath(worktree, path);
  let entry;
  try {
    entry = lstatSync(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hash.update("missing\0");
    return 0;
  }
  if (entry.isSymbolicLink()) {
    const target = readlinkSync(fullPath);
    const targetPath = resolve(dirname(fullPath), target);
    if (!isInsideWorktree(resolve(worktree), targetPath)) {
      throw new Error(`symlink target escapes worktree: ${path}`);
    }
    const bytes = Buffer.byteLength(target);
    if (bytes > budget) throw new Error(`observation budget spent reading ${path}`);
    hash.update("symlink\0").update(target);
    return bytes;
  }
  if (!entry.isFile() || (entry.mode & 0o444) === 0) {
    throw new Error(`path is not a readable regular file: ${path}`);
  }
  const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`path is not a regular file: ${path}`);
    hash.update("file\0").update(String(stat.mode & 0o777)).update("\0");
    const buffer = Buffer.allocUnsafe(OBSERVE_CHUNK_BYTES);
    let spent = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) return spent;
      spent += read;
      if (spent > budget) throw new Error(`observation budget spent reading ${path}`);
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
}

// Git output is worker-controlled in size too. The pipe closes after one byte beyond the remaining
// allowance; pipefail turns either a failed git probe or that truncated stream into UNREADABLE.
async function boundedGitObservation(command: string, worktree: string, budget: number): Promise<string | undefined> {
  if (budget < 0) return undefined;
  const result = await shGit(`set -o pipefail; ${command} | head -c ${budget + 1}`, worktree);
  if (result.code !== 0 || Buffer.byteLength(result.stdout) > budget) return undefined;
  return result.stdout;
}

// "No worktree delta" means no staged/unstaged/untracked bytes AND no commits beyond the task's
// dispatch base. Both reads are bounded and preserve the observer's third state: a failed probe is
// unreadable, never clean.
async function observeWorktreeDelta(base: string, worktree: string): Promise<WorktreeComparison> {
  let budget = observeBudgetBytes;
  const status = await boundedGitObservation(
    "GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1 -z --untracked-files=all",
    worktree,
    budget,
  );
  if (status === undefined) return "unreadable";
  budget -= Buffer.byteLength(status);
  const ahead = await boundedGitObservation(
    `GIT_OPTIONAL_LOCKS=0 git rev-list --count ${shq(base)}..HEAD`,
    worktree,
    budget,
  );
  if (ahead === undefined || !/^\d+$/.test(ahead.trim())) return "unreadable";
  return status.length === 0 && ahead.trim() === "0" ? "unchanged" : "changed";
}

// The signature has four git-owned inputs: HEAD, staged blob/mode/path identity, porcelain path and
// state, and the set of worktree paths whose bytes Git cannot supply. Those paths contribute their
// filesystem identity, mode, symlink text, and content. A failed or over-budget leg is a third
// state; it can never be compared as unchanged.
async function observeWorktree(worktree: string): Promise<WorktreeObservation> {
  let budget = observeBudgetBytes;
  const hash = createHash("sha256");
  let contentPaths = "";
  for (const [label, command] of [
    ["head", "GIT_OPTIONAL_LOCKS=0 git rev-parse HEAD"],
    ["index", "GIT_OPTIONAL_LOCKS=0 git ls-files --stage -z"],
    ["status", "GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1 -z --untracked-files=all"],
    ["content-paths", "GIT_OPTIONAL_LOCKS=0 git ls-files --modified --others --exclude-standard -z"],
  ] as const) {
    const view = await boundedGitObservation(command, worktree, budget);
    if (view === undefined) return { state: "UNREADABLE" };
    budget -= Buffer.byteLength(view);
    if (label === "content-paths") contentPaths = view;
    hash.update(label).update("\0").update(view).update("\0");
  }
  try {
    for (const path of new Set(contentPaths.split("\0").filter(Boolean))) {
      hash.update("content\0").update(path).update("\0");
      budget -= hashObservedPath(hash, worktree, path, budget);
      hash.update("\0");
    }
  } catch {
    return { state: "UNREADABLE" };
  }
  return { state: "READABLE", signature: hash.digest("hex") };
}

function compareWorktrees(before: WorktreeObservation, after: WorktreeObservation): WorktreeComparison {
  if (before.state === "UNREADABLE" || after.state === "UNREADABLE") return "unreadable";
  return before.signature === after.signature ? "unchanged" : "changed";
}

const CONTEXT_GLOB_CHARS = /[*?{[]/;
const MATERIALIZED_CONTEXT_BYTES = 256 * 1024 * 1024;

type MaterializedContextOutcome =
  | { kind: "keep"; entry: string }
  | { kind: "materialized"; entry: string; normalized: string; destination: string; bytes: number }
  | { kind: "missing"; path: string; reason: string };

function containedIn(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function normalizeContextPath(entry: string): string | undefined {
  if (entry.includes("\0")) return undefined;
  const repositoryPath = entry.replace(/\\/g, "/");
  if (posix.isAbsolute(repositoryPath) || repositoryPath.split("/").includes("..")) return undefined;
  const normalized = posix.normalize(repositoryPath).replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function workerFilesystemEntries(worktree: string): string[] {
  const entries: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const rel = relative(worktree, dir).split(sep).join(posix.sep) || ".";
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`context filesystem observation failed at ${rel}: ${message}`);
    }
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      entries.push(rel);
      if (dirent.isDirectory()) visit(join(dir, dirent.name), rel);
    }
  };
  visit(worktree, "");
  return entries;
}

function exactContextResolvesInWorktree(entry: string, normalized: string, worktree: string): boolean {
  const fullPath = join(worktree, normalized);
  try {
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) return true;
    return !/\/+$/.test(entry) && stat.isFile() && worktreeHeadHasRegularBlob(worktree, normalized);
  } catch (error) {
    if (["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function patternContextResolvesInWorktree(normalized: string, worktree: string): boolean {
  const match = filesGlob(normalized);
  return workerFilesystemEntries(worktree).some((path) => match(path));
}

function regularBlobObjectId(repoRoot: string, ref: string, normalized: string): string | undefined {
  let tree = "";
  try {
    tree = execFileSync("git", ["-C", repoRoot, "ls-tree", "-z", ref, "--", normalized], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  const row = tree.split("\0")
    .filter(Boolean)
    .map((line) => /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(line))
    .find((match) => match?.[4] === normalized);
  if (!row || row[2] !== "blob" || (row[1] !== "100644" && row[1] !== "100755")) return undefined;
  return row[3]!;
}

function worktreeHeadHasRegularBlob(worktree: string, normalized: string): boolean {
  return regularBlobObjectId(worktree, "HEAD", normalized) !== undefined;
}

function committedRegularBlob(repoRoot: string, normalized: string): { bytes: Buffer } | undefined {
  const objectId = regularBlobObjectId(repoRoot, "HEAD", normalized);
  if (!objectId) return undefined;
  try {
    const bytes = execFileSync("git", ["-C", repoRoot, "cat-file", "blob", objectId], {
      encoding: "buffer",
      maxBuffer: MATERIALIZED_CONTEXT_BYTES,
    });
    return { bytes };
  } catch {
    return undefined;
  }
}

function materializedContextDestination(root: string, task: Task, attempt: number, normalized: string): string {
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const leaf = basename(normalized).replace(/[^A-Za-z0-9._-]/g, "_") || "context";
  const destination = join(root, task.id, `a${attempt}`, `${key}-${leaf}`);
  if (!containedIn(root, destination)) throw new Error(`materialized context destination escapes context subtree: ${normalized}`);
  return destination;
}

function ensureDirectoryWithoutSymlink(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink()) throw new Error(`materialized context destination ancestor is a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`materialized context destination ancestor is not a directory: ${path}`);
}

function ensureContainedContextParent(root: string, destination: string): void {
  const rootAbs = resolve(root);
  const destAbs = resolve(destination);
  if (!containedIn(rootAbs, destAbs)) throw new Error("materialized context destination escapes context subtree");
  const parent = dirname(destAbs);

  ensureDirectoryWithoutSymlink(rootAbs);
  const relParent = relative(rootAbs, parent);
  let current = rootAbs;
  for (const segment of relParent.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensureDirectoryWithoutSymlink(current);
  }

  if (!containedIn(realpathSync(rootAbs), realpathSync(parent))) {
    throw new Error("materialized context destination realpath escapes context subtree");
  }
}

function writeContainedContextFile(root: string, destination: string, bytes: Buffer): void {
  if (!containedIn(root, destination)) throw new Error("materialized context destination escapes context subtree");
  ensureContainedContextParent(root, destination);
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

async function materializeContextEntry(
  repoRoot: string,
  worktree: string,
  contextRoot: string,
  task: Task,
  attempt: number,
  entry: string,
): Promise<MaterializedContextOutcome> {
  const normalized = normalizeContextPath(entry);
  if (!normalized) return { kind: "missing", path: entry, reason: "invalid-path" };

  if (exactContextResolvesInWorktree(entry, normalized, worktree)) return { kind: "keep", entry };

  const blob = committedRegularBlob(repoRoot, normalized);
  if (blob) {
    const destination = materializedContextDestination(contextRoot, task, attempt, normalized);
    writeContainedContextFile(contextRoot, destination, blob.bytes);
    return { kind: "materialized", entry: destination, normalized, destination, bytes: blob.bytes.length };
  }

  if (CONTEXT_GLOB_CHARS.test(entry)) {
    if (patternContextResolvesInWorktree(normalized, worktree)) return { kind: "keep", entry };
    return { kind: "missing", path: entry, reason: "unresolved-pattern" };
  }
  if (/\/+$/.test(entry)) return { kind: "missing", path: entry, reason: "unresolved-pattern" };

  return { kind: "missing", path: entry, reason: "no-committed-regular-blob" };
}

async function taskWithMaterializedContext(repoRoot: string, journal: Journal, worktree: string, task: Task, attempt: number): Promise<Task> {
  if (task.context.length === 0) return task;
  const contextRoot = resolve(journal.dir, "context");
  const context: string[] = [];
  for (const entry of task.context) {
    const prepared = await materializeContextEntry(repoRoot, worktree, contextRoot, task, attempt, entry);
    if (prepared.kind === "missing") {
      journal.append("context-missing", task.id, { path: prepared.path, reason: prepared.reason });
    } else {
      context.push(prepared.entry);
      if (prepared.kind === "materialized") {
        journal.append("context-materialized", task.id, {
          path: entry,
          normalized: prepared.normalized,
          destination: prepared.destination,
          bytes: prepared.bytes,
        });
      }
    }
  }
  return { ...task, context };
}

// OBS-1107: a refused pick is not lost work by that fact alone. A commit whose own change the
// destination already holds (content-empty, or a patch represented there under another hash) is
// accounted for and skipped; the carry stops only at a nonempty change the destination lacks.
async function cherryPickCommits(wt: string, commits: string[]): Promise<{ carried: string[]; accounted: string[] }> {
  const carried: string[] = [];
  const accounted: string[] = [];
  for (const hash of commits) {
    const r = await shGit(`git cherry-pick --no-gpg-sign ${shq(hash)}`, wt);
    if (r.code === 0) {
      carried.push(hash);
      continue;
    }
    await shGit("git cherry-pick --abort", wt);
    if (!(await changeRepresented(wt, hash))) break;
    accounted.push(hash);
  }
  return { carried, accounted };
}

const PRESERVED_REF_PREFIX = "refs/tickmarkr/preserved/";
const preservedRefOf = (data: Record<string, unknown>): string | undefined =>
  [data.ref, data.preservedRef].find((v): v is string => typeof v === "string" && v.startsWith(PRESERVED_REF_PREFIX));

/** The attempt whose worker last launched into the task's current checkout; "unknown" once a
 * recreation replaced that tree without a new launch (recheck, gate-only restore) or when no
 * dispatch assignment is on record. Never the newest dispatch by itself. */
export function knownProducer(events: readonly JournalEvent[], taskId: string): PreserveProducer {
  let dispatched: PreserveProducer = "unknown";
  let producer: PreserveProducer = "unknown";
  for (const row of events) {
    if (row.taskId !== taskId) continue;
    if (row.event === "task-dispatch") {
      const a = row.data.assignment as Partial<Assignment> | undefined;
      dispatched = typeof a?.adapter === "string" && typeof a?.model === "string"
        ? { channel: `${a.adapter}:${a.model}`, attempt: typeof row.data.attempt === "number" ? row.data.attempt : 0 } : "unknown";
    } else if (row.event === "worker-launch") producer = dispatched;
    else if (row.event === "worktree-recreation") producer = "unknown";
  }
  return producer;
}

/** Distinct author channels of the subject for task-done/status/board rows: "unknown" replaces every
 * unresolvable owner (legacy unattributed preservation, dispatch without assignment). */
const mergedAuthors = (authors: readonly string[]): string[] =>
  [...new Set(authors.map((a) => a.startsWith("unknown author") ? "unknown" : a))].sort();

/** Fold lifetime dispatch/carry evidence, independent of attempt budgets and routing exclusions.
 * Recreation rows name SOURCE hashes, so ownership is joined by stable patch identity. Each
 * attempt owns only what the next carry (or current subject) adds beyond its own incoming set.
 * Gate-only recreations do not start an attempt or transfer authorship to the restored seat.
 */
async function subjectAuthors(events: readonly JournalEvent[], taskId: string, wt: string, base: string): Promise<string[]> {
  const cache = new Map<string, string | undefined>();
  const patches = async (commits: readonly string[]): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const commit of commits) {
      if (!cache.has(commit)) {
        const diff = await shGit(`git show --format= --binary ${shq(commit)}`, wt);
        if (diff.code !== 0) throw new Error(`cannot read author patch ${commit}`);
        const id = execFileSync("git", ["patch-id", "--stable"], {
          cwd: wt, input: diff.stdout, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        }).trim().split(/\s+/)[0];
        cache.set(commit, id || undefined); // an empty commit authored no patch
      }
      const id = cache.get(commit);
      if (id) ids.add(id);
    }
    return ids;
  };
  type Attempt = { author: string; incoming: Set<string> };
  let current: Attempt | undefined;
  let previous: Attempt | undefined;
  let awaitingCarry = false;
  const owners = new Map<string, Set<string>>();
  // Preserved engine commits carry their producing attempt on the row; a row without one is legacy
  // and stays explicitly unknown rather than inheriting the seat that later carried the patch.
  const preservedOwner = new Map<string, string>();
  const attribute = (ids: Set<string>, attempt: Attempt | undefined) => {
    for (const id of ids) {
      if (attempt?.incoming.has(id)) continue;
      const authors = owners.get(id) ?? new Set<string>();
      authors.add(preservedOwner.get(id) ?? attempt?.author ?? "unknown author (missing task-dispatch assignment)");
      owners.set(id, authors);
    }
  };
  try {
    for (const row of events) {
      if (row.taskId !== taskId) continue;
      const preserved = preservedRefOf(row.data);
      if (preserved) {
        // Only an engine preserve commit is owned by its row; a ref naming a worker's own commit keeps
        // that commit's dispatch attribution.
        const shown = await shGit(`git show -s ${shq(`--format=%H%n%s%n%(trailers:key=${PRESERVE_PRODUCER_TRAILER},valueonly)`)} ${shq(`${preserved}^{commit}`)}`, wt);
        const [commit, subject, trailer] = shown.stdout.trim().split("\n");
        if (shown.code === 0 && commit && subject === PRESERVE_COMMIT_SUBJECT) {
          // A row that merely mentions the ref (a park naming it) defers to the commit's own trailer;
          // only a commit with neither is legacy. A known owner is never downgraded by a later mention.
          const owner = typeof row.data.producer === "string" ? row.data.producer
            : trailer?.trim().replace(/ attempt \d+$/, "") || "unknown author (legacy unattributed preservation)";
          for (const id of await patches([commit])) {
            const prior = preservedOwner.get(id);
            if (prior === undefined || prior === "unknown" || prior.startsWith("unknown author")) preservedOwner.set(id, owner);
          }
        }
      }
      if (row.event === "task-dispatch") {
        previous = current;
        const a = row.data.assignment as Partial<Assignment> | undefined;
        current = { author: typeof a?.adapter === "string" && typeof a?.model === "string"
          ? `${a.adapter}:${a.model}` : "unknown author (missing task-dispatch assignment)", incoming: new Set() };
        awaitingCarry = true;
      } else if (row.event === "worktree-recreation") {
        const carried = await patches(Array.isArray(row.data.carried) ? row.data.carried as string[] : []);
        attribute(carried, awaitingCarry ? previous : current);
        if (awaitingCarry && current) current.incoming = carried;
        awaitingCarry = false;
      } else if (["worker-launch", "worker-result", "gate-result", "task-human"].includes(row.event)) {
        // The initial checkout has no recreation row. Once work/gates start, a later
        // recreation is a restore of this attempt, not the input of a new dispatch.
        awaitingCarry = false;
      }
    }
    const subject = await patches(await commitsAheadOf(base, wt));
    attribute(subject, current);
    return [...new Set([...subject].flatMap((id) => [...(owners.get(id) ?? [])]))];
  } catch (error) {
    // An unreadable history cannot silently remove an author from the exclusion set.
    return [`unknown author (${String(error)})`];
  }
}

// T7 (v1.86): a first run-end append that fails AFTER partial bytes landed leaves a torn tail at
// EOF with no newline; a blind retry would glue the run-end line onto those bytes and readJsonl's
// torn-line tolerance would drop the retry too — no terminal record despite a successful write.
// Terminating the torn fragment keeps it on disk (dropped as a malformed line, never truncated) so
// the retried run-end lands on a line of its own.
const terminateTornJournalTail = (journalPath: string): void => {
  if (!existsSync(journalPath)) return;
  const size = statSync(journalPath).size;
  if (size === 0) return;
  const fd = openSync(journalPath, "r");
  try {
    const tail = Buffer.alloc(1);
    if (readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 0x0a) appendFileSync(journalPath, "\n");
  } finally {
    closeSync(fd);
  }
};

// T7 (v1.86): the fatal handler must never eat the error it reports. Both journal calls are guarded,
// so a sink failure is reported ALONGSIDE the original error (console.error — the dispatcher's
// operator-visible line stays the one-line form), never instead of it: a read failure degrades the
// duplicate-run-end check to "unknown" and fails toward recording; the append is retried ONCE; and
// a persistently unwritable sink reports a crash naming the journal path and carrying NO terminal
// record, rather than fabricating an ended run on evidence the harness could not write. (OBS-313:
// with the sink dead the crash CAUSE is unrecordable — recorded as an observation, not papered over.)
export function recordFatalRunEnd(
  journal: Journal, runId: string, branch: string, err: unknown,
  graph?: RunGraph, phase = "setup",
): TipProof | undefined {
  const original = err instanceof Error ? err.message : String(err);
  // A fatal close never finished a cycle: fresh/reused green is withheld, a recorded red still stands.
  let tipProof: TipProof = { kind: "incomplete" };
  let forgiven: ForgivenFingerprints[] = [];
  try {
    // Only the latest engagement can already own this terminal outcome.
    const events = journal.read();
    let from = events.length;
    while (from > 0) {
      const event = events[--from]!;
      if (event.event === "run-start" || event.event === "run-resume") break;
      if (event.event === "run-end") return undefined;
    }
    const latest = runEndTipProof(events.slice(from));
    tipProof = { ...latest, kind: latest.kind === "failed" ? "failed" : "incomplete" };
    // OBS-1123: the same fold the normal close records, so a crash never drops what a green carried.
    forgiven = forgivenFingerprints(events);
  } catch (readErr) {
    console.error(`tickmarkr ${runId}: journal read failed while recording the fatal run-end (${readErr instanceof Error ? readErr.message : String(readErr)}) — original error: ${original}`);
  }
  const record = {
    runId,
    branch,
    done: graph?.tasks.filter((t) => t.status === "done").map((t) => t.id) ?? [],
    failed: graph?.tasks.filter((t) => t.status === "failed").map((t) => t.id) ?? [],
    human: graph?.tasks.filter((t) => t.status === "human").map((t) => t.id) ?? [],
    blocked: graph ? blockedTasks(graph).map((t) => t.id) : [],
    pending: graph ? pendingTasks(graph).map((t) => t.id) : [],
    phase,
    fatal: true,
    error: original,
    tipProof,
    ...(forgiven.length ? { forgiven } : {}),
  };
  try {
    journal.append("run-end", undefined, record);
    return tipProof;
  } catch {
    // one retry below — the first failure is reported only if the retry also fails
  }
  const journalPath = join(journal.dir, "journal.jsonl");
  try {
    terminateTornJournalTail(journalPath);
    journal.append("run-end", undefined, record);
    return tipProof;
  } catch (retryErr) {
    console.error(`tickmarkr ${runId}: run crashed — no terminal record written; journal sink unwritable at ${journalPath} (${retryErr instanceof Error ? retryErr.message : String(retryErr)}) — original error: ${original}`);
  }
}

// OBS-777: the fleet fold cannot distinguish an orphan from another repository's live worker. Give
// it one repository-scoped snapshot instead: terminal journals are ended, and an open lifecycle is
// ended only when the shared lock predicate can prove its last recorded daemon pid dead.
function endedRunIdsForReconcile(repoRoot: string): Set<string> {
  const ended = new Set<string>();
  const dir = join(tickmarkrDir(repoRoot), "runs");
  if (!existsSync(dir)) return ended;
  let runIds: string[];
  try { runIds = readdirSync(dir); } catch { return ended; }
  for (const runId of runIds) {
    try {
      const events = Journal.open(repoRoot, runId).read();
      if (runHasEnded(events)) {
        ended.add(runId);
        continue;
      }
      const lifecycle = [...events].reverse().find((event) =>
        (event.event === "run-start" || event.event === "run-resume")
        && Number.isInteger(event.data.pid) && (event.data.pid as number) > 0);
      if (lifecycle && !isPidLive(lifecycle.data.pid as number)) ended.add(runId);
    } catch { /* incomplete or foreign run directory — it proves nothing */ }
  }
  return ended;
}

export async function runDaemon(repoRoot: string, opts: RunOptions = {}): Promise<RunSummary> {
  // OBS-1045: a daemon launched from inside a leased command (a nested runner, an operator's test
  // shell) inherits its ancestor's lease token through the environment, and every gate it ran would
  // ride that lease instead of taking its own. Clear it at run-start so the first gate leases itself.
  if (process.env[COMMAND_LEASE_TOKEN_ENV]) {
    delete process.env[COMMAND_LEASE_TOKEN_ENV];
  }
  // v1.51 T2 / OBS-89 (v1.60): retired --quality env seam. Mode resolution owns premium routing;
  // route() no longer reads the retired env at all, so the old entrypoint scrub is gone with it.
  const adapters = opts.adapters ?? allAdapters();
  const health = readDoctor(repoRoot) ?? (await probeAll(adapters));
  const driver: ExecutorDriver = opts.driver ?? new SubprocessDriver();

  // HARD-01/02: hold the run lock across the whole read-modify-write of graph.json. Acquire
  // BEFORE loadGraph; release in the finally below (every exit path, incl. throws).
  const runId = opts.runId ?? newRunId();
  // v1.53 T5: an unknown --supersedes id must fail BEFORE any run starts — Journal.open throws and
  // no lock, journal, or baseline for the new run has been created yet. Opened without a narrate
  // sink: the prior journal append below is silent bookkeeping, not this run's narration.
  const prior = opts.supersedes !== undefined ? Journal.open(repoRoot, opts.supersedes) : undefined;
  // T6 narrator: one live status surface per run (herdr only — driver.narrator is undefined on
  // subprocess, so the optional-chain open below is a no-op there). Cosmetic-only: any failure is
  // swallowed (never affects the run); the operator closes a surviving watch pane.
  const lock = acquireRunLock(repoRoot, runId);
  const endedRunIds = endedRunIdsForReconcile(repoRoot); // one snapshot for every sweep this caller makes
  // D10: the lock is this daemon's liveness record and already carries its pid; status prints that
  // identity beside the supervision row. The `orchestrator` tier belongs exclusively to the seated
  // supervisor, so a run never beats or stands down that seat's record on the daemon's behalf.
  // v1.54 T2: declared before the try so the finally can always deregister (a throw before
  // registration leaves it undefined — the guard below covers that path).
  let onTermination: ((sig: NodeJS.Signals) => void) | undefined;
  let journal!: Journal;
  let runStarted = false;
  let taskLoopStarted = false;
  let graph!: RunGraph;
  let fatalPhase = "setup";
  let deliberateTermination = false;
  const fatalStop = new AbortController();
  const hostStop = new AbortController();
  const hostChecks = new Set<Promise<unknown>>();
  const inflight = new Map<string, Promise<void>>();
  let retireFatalSlots: (() => Promise<void>) | undefined;
  let branch = "";
  let releaseApprovalSerialization: (() => void) | undefined;
  let baselineCapture: Promise<void> = Promise.resolve();
  let baselineFailed = false;
  try {
  graph = loadGraph(repoRoot);
  // One bounded snapshot supplies every dispatch. On resume the current journal still participates
  // in the fold so its task-done/ordinary-approval events can retire older evidence, but findings it
  // produced are suppressed: same-run feedback already replays those bytes and must not deliver them
  // twice. Evidence from genuinely earlier runs remains available to a resumed fresh dispatch.
  const priorRunEvidence = readPriorRunEvidence(repoRoot, graph.tasks, { suppressRunId: runId });
  // GATE-FIX-4 defect 4 (no-op run refusal): a fresh run on a graph with nothing dispatchable used
  // to journal {run-start, run-end} with zero dispatches — and downstream readers (greenness exit,
  // status, notify) treat that run-end as completion, so an all-terminal graph "went green" having
  // done nothing. Refuse HERE, the earliest seam where the graph is known and BEFORE Journal.create
  // makes the run dir: no run-start row, no run dir, and the error exits nonzero through the CLI's
  // ordinary catch. Dispatchability reuses graph.ts's status math rather than restating it: a task
  // is dispatchable iff it is ready now (readyTasks) or can still become ready — pending with a
  // non-parked closure (pendingTasks), or unblocked later by in-flight running/gated residue.
  // FRESH runs only: a resume where everything is terminal already owns its run-end and keeps its
  // current replay-then-quiesce behavior (the run-narrate test pins run-resume → run-end).
  if (!opts.resume && readyTasks(graph).length === 0 && pendingTasks(graph).length === 0
      && !graph.tasks.some((t) => t.status === "running" || t.status === "gated")) {
    // Every pending task here is blocked-on-terminal by construction (pendingTasks(graph) is empty),
    // so the count is labeled truthfully instead of as still-runnable "pending".
    const counts = new Map<string, number>();
    for (const t of graph.tasks) {
      const bucket = t.status === "pending" ? "blocked-on-terminal" : t.status;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const breakdown = counts.size === 0 ? "graph has zero tasks"
      : [...counts.entries()].map(([s, n]) => `${s} ${n}`).join(", ");
    throw new Error(
      `nothing to dispatch — no task is ready and none can become ready (${breakdown}). `
      + "Refusing to start a run that would journal run-start/run-end with zero dispatches. "
      + "Release parked tasks with `tickmarkr approve <runId> <taskId>`, or compile a fresh graph with `tickmarkr compile`.",
    );
  }
  // v1.51 T2: the routing mode resolves BEFORE any routing input is built — run flag > spec front-matter
  // > repo > global > default. The resolved cfg carries mode-compiled floors; route() never sees the mode.
  const rm = resolveRunMode(repoRoot, { flag: opts.mode, spec: graph.mode, globalDir: opts.globalDir });
  const cfg = rm.cfg;
  // OBS-1199: the effective repair-selection default is resolved apart from the optional execution
  // budget, so an absent policy selects on every driver; a resume keeps what the run recorded.
  let repairSelection = repairSelectionEnabled(cfg);
  if (opts.resume) {
    const start = Journal.open(repoRoot, runId).read().find((e) => e.event === "run-start");
    const snapshot = start?.data.effectivePolicy;
    if (snapshot !== undefined && (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
        || !("config" in snapshot) || !snapshot.config || typeof snapshot.config !== "object" || Array.isArray(snapshot.config))) {
      throw new Error("cannot restore malformed recorded execution policy");
    }
    const recorded = snapshot as { config?: { executionPolicy?: unknown } } | undefined;
    // Historical runs did not opt in; current settings cannot grant them a new allowance.
    cfg.executionPolicy = recorded?.config?.executionPolicy === undefined
      ? undefined : ExecutionPolicySchema.parse(recorded.config.executionPolicy);
    const recordedGates = (recorded?.config as { gates?: { repairSelection?: unknown } } | undefined)?.gates;
    if (recordedGates?.repairSelection !== undefined && typeof recordedGates.repairSelection !== "boolean") {
      throw new Error("cannot restore malformed recorded repair selection");
    }
    repairSelection = repairSelectionEnabled({ executionPolicy: cfg.executionPolicy, gates: recordedGates });
  }
  if (cfg.executionPolicy && driver.id !== "subprocess") {
    throw new Error("experimental executionPolicy currently requires the subprocess driver");
  }
  // Resolve both budgets once: worker fan-out divides by dispatch concurrency; verification
  // divides by one runner command holding a lease. Explicit operator caps still win.
  const concurrency = opts.concurrency ?? cfg.concurrency;
  return await runWithForkBudget(concurrency, async () => {
  const conservativeCapacity = resolvedCapacity();
  const occupancyCapacity: RunCapacity = {
    cores: conservativeCapacity.cores,
    forkCap: FORK_CAP_ENV in process.env
      ? conservativeCapacity.forkCap : deriveForkCap(1, conservativeCapacity.cores),
  };
  return await runWithVerificationBudget(occupancyCapacity, async () => {
  // v1.51 T4: every dispatch provenance line begins with the mode and its source; when a pin won
  // the route (the final "→ " segment is a pin, not a degraded-to-auto tail) it names the mode it bypassed.
  const dispatchProvenance = (p: string): string =>
    `mode ${rm.mode.mode} (${rm.source})${p.split("→ ").pop()!.startsWith("pin ") && !p.includes("not re-tried") ? ` — pin bypasses mode ${rm.mode.mode}` : ""} · ${p}`;
  // v1.87 T2: one pool per seat role, built once. `channels` stays the WORKER pool — every routing
  // call below reads it exactly as before — while the judge, review and consult seats each receive
  // the pool their own deny scope allows, so routing.deny.workers benches a channel for dispatch
  // without also removing it from the seats that verify the work.
  const pools = rolePools(cfg, adapters, health);
  const channels = pools.worker;
  // v1.6 ROUTE-06: build the learned profile ONCE at startup (never per task, never in the comparator).
  // No preview — the daemon honors routing.learned:off and gets undefined; this snapshot is immutable
  // for the run, so this run's own telemetry never feeds back into its own routing.
  const profile = loadRoutingProfile(repoRoot, cfg);

  // v1.54 T2 (OBS-71): signal reaper — a killed daemon closes its own panes and releases the lock.
  // Every slot this run opens stays in liveSlots until closed: the worker path opens through
  // trackedDriver below, and gates/consults receive trackedDriver as THEIR driver, so their pane
  // opens/closes keep the ledger exact. Termination then closes exactly what is still live — and a
  // slot closed once (task-done, quota reroute, gate self-clean) can never be closed twice.
  const liveSlots = new Set<Slot>();
  // A driver handle identifies the physical slot even if a retry returns a new Slot object.
  const trustAnsweredSlots = new Set<string>();
  const workerOwners = new Map<Slot, { taskId: string; attempt: number; groupFile: string; marker: string;
    identities: Map<number, string>; descendants: Map<number, string> }>();
  const reapReports = new Map<Slot, { processGroup: number | null; strays: number[]; survivors: number[] | null }>();
  const reapWorker = async (slot: Slot): Promise<void> => {
    const owner = workerOwners.get(slot);
    if (owner) {
      const processGroup = readOwnedProcessGroup(owner.groupFile);
      let survivors: number[] | null;
      const strays: number[] = [];
      let session: string | undefined;
      try {
        const shared = processGroup !== undefined && [...workerOwners].some(([other, otherOwner]) =>
          other !== slot && liveSlots.has(other) && readOwnedProcessGroup(otherOwner.groupFile) === processGroup);
        if (shared) throw new Error(`worker group ${processGroup} is shared with another live attempt`);
        try { session = readFileSync(`${owner.groupFile}.session`, "utf8").trim() || undefined; } catch { /* pre-launch or older driver */ }
        let parent: { pid: number; startedAt: string } | undefined;
        try {
          const row = /^\s*(\d+)\s+(.+)$/.exec(readFileSync(`${owner.groupFile}.parent`, "utf8").trim());
          if (row) parent = { pid: Number(row[1]), startedAt: row[2]!.trim().replace(/\s+/g, " ") };
        } catch { /* a live dispatch root can still prove its parent */ }
        const others = [...workerOwners].filter(([other]) => other !== slot && liveSlots.has(other));
        survivors = await reapOwnedProcessGroup(processGroup, slot.cwd, {
          marker: owner.marker, session, parent, identities: owner.identities, descendants: owner.descendants, strays,
          excludedGroups: others.flatMap(([, other]) => {
            const group = readOwnedProcessGroup(other.groupFile);
            return group === undefined ? [] : [group];
          }),
          excludedWorktrees: others.map(([other]) => other.cwd).filter((cwd) => cwd !== slot.cwd),
        });
      } catch (error) {
        journal.append("worker-process-reaped", owner.taskId, { slot: slot.name, attempt: owner.attempt,
          processGroup: processGroup ?? null, strays, survivors: null, error: String(error) });
        workerOwners.delete(slot); // one reap row per attempt: a later close never re-sweeps
        throw error;
      }
      reapReports.set(slot, { processGroup: processGroup ?? null, strays, survivors });
      journal.append("worker-process-reaped", owner.taskId, {
        slot: slot.name, attempt: owner.attempt, processGroup: processGroup ?? null, strays, survivors,
      });
      // Every outcome retires the claim: one reap row per attempt, whatever the verdict.
      workerOwners.delete(slot);
      // Pre-launch and in-process drivers have no OS dispatch claim; their close owns retirement.
      // Once any dispatch ownership exists, an unreadable sweep must block the next gate.
      if (survivors === null && (processGroup !== undefined || session !== undefined || owner.descendants.size > 0)) {
        throw new Error(`worker group ${processGroup} cleanup unknown`);
      }
      if (survivors && survivors.length > 0) throw new Error(`worker group ${processGroup} survivors: ${survivors.join(", ")}`);
    }
  };
  const closeSlot = (s: Slot): Promise<void> => closeLiveSlot(liveSlots, { close: async (slot) => {
    await reapWorker(slot);
    await driver.close(slot);
  } }, s);
  retireFatalSlots = async () => {
    for (const slot of Array.from(liveSlots)) {
      try { await closeSlot(slot); } catch { /* preserve the original fatal error */ }
    }
  };
  const budgetSlots = new Map<AbortSignal, Set<Slot>>();
  const trackedDriver: ExecutorDriver = {
    id: driver.id,
    interactive: driver.interactive,
    ...(driver.readSource ? { readSource: driver.readSource } : {}),
    ...(driver.describe ? { describe: driver.describe.bind(driver) } : {}),
    ...(driver.focus ? { focus: driver.focus.bind(driver) } : {}),
    slot: async (cwd, name, o) => {
      fatalStop.signal.throwIfAborted();
      const signal = executionSignal();
      signal?.throwIfAborted();
      const s = await driver.slot(cwd, name, o);
      liveSlots.add(s);
      if (signal) budgetSlots.get(signal)?.add(s);
      if (signal?.aborted || fatalStop.signal.aborted) {
        await withoutExecutionBudget(() => closeSlot(s));
        fatalStop.signal.throwIfAborted();
        signal?.throwIfAborted();
      }
      return s;
    },
    run: (s, cmd) => {
      fatalStop.signal.throwIfAborted();
      return driver.run(s, cmd);
    },
    waitOutput: (s, p, ms, o) => driver.waitOutput(s, p, ms, o),
    waitAgentStatus: (s, st, ms) => driver.waitAgentStatus(s, st, ms),
    status: (s) => driver.status(s),
    read: (s, n) => driver.read(s, n),
    ...(driver.sendKey ? { sendKey: driver.sendKey.bind(driver) } : {}),
    ...(driver.nudge ? { nudge: driver.nudge.bind(driver) } : {}),
    ...(driver.narrator ? { narrator: async (cwd: string, command: string, id?: string) => {
      const s = await driver.narrator!(cwd, command, id);
      liveSlots.add(s);
      return s;
    } } : {}),
    ...(driver.retireLostWatch ? { retireLostWatch: driver.retireLostWatch.bind(driver) } : {}),
    ...(driver.project ? { project: driver.project.bind(driver) } : {}),
    ...(driver.reconcile ? { reconcile: driver.reconcile.bind(driver) } : {}),
    notify: (m, o) => driver.notify(m, o),
    close: closeSlot,
    worktree: (r, b, base) => driver.worktree(r, b, base),
  };
  const absentCapabilities = new Set<string>();
  const noteCapabilityAbsent = (capability: string) => {
    if (absentCapabilities.has(capability)
        || journal.read().some((event) => event.event === "driver-capability-absent" && event.data.capability === capability)) return;
    absentCapabilities.add(capability);
    journal.append("driver-capability-absent", undefined, { driver: driver.id, capability });
  };
  // Termination (SIGINT/SIGTERM): record the daemon-controlled exit before closing every live slot,
  // reconcile owned panes against an EMPTY
  // desired set (herdr panes not in memory; panesToClose spares foreign names, watch panes, and
  // live/unknown other runs' panes by construction), release the run lock, then exit. There is still no run-end,
  // so stop-amend-resume keeps resuming; exit-cause distinguishes this deliberate stop from an
  // observer-classified abrupt death. keepPanes:"forever" (the
  // keep-everything debug override) preserves panes but still releases the lock and exits.
  let termSignal: NodeJS.Signals | undefined;
  let activeTipVerify: { controller: AbortController; settled: Promise<void> } | undefined;
  let abortRun: (err: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { abortRun = reject; });
  aborted.catch(() => { /* pre-handled: a signal after the loop drained must not crash as unhandled */ });
  let reaping = false;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  onTermination = (sig: NodeJS.Signals) => {
    termSignal = sig;
    deliberateTermination = true;
    void (async () => {
      if (!reaping) {
        reaping = true;
        try { journal?.append("exit-cause", undefined, { cause: "deliberate", signal: sig }); }
        catch (error) {
          console.error(`tickmarkr ${runId}: deliberate exit cause could not be journalled (${error instanceof Error ? error.message : String(error)})`);
        }
        // Stop the scheduler before the first awaited retirement. Otherwise a freed slot can fund a
        // new attempt while this reaper is still closing the old ones.
        const termination = new Error(`terminated by ${sig}`);
        abortRun(termination);
        hostStop.abort(termination);
        await Promise.allSettled(hostChecks);
        if (activeTipVerify) {
          activeTipVerify.controller.abort(termination);
          await activeTipVerify.settled;
        }
        if (cfg.visibility.keepPanes === "forever") {
          for (const s of Array.from(liveSlots)) {
            try { await reapWorker(s); } catch { /* survivor evidence is retained by the reaper */ }
          }
        }
        if (cfg.visibility.keepPanes !== "forever") {
          for (const s of Array.from(liveSlots)) { // snapshot: failed closes restore membership for the next sweep
            try { await closeSlot(s); } catch { /* cosmetic — reconcile is the backstop */ }
          }
          try { await driver.reconcile?.(new Set(), runId, { endedRunIds }); } catch { /* cosmetic — visibility is never a gate */ }
        }
        releaseRunLock(repoRoot); // the process dies at exit() below — the finally never runs on this path
      }
      exit(sig === "SIGINT" ? 130 : 143);
    })();
  };
  process.on("SIGINT", onTermination);
  process.on("SIGTERM", onTermination);

  journal = opts.resume ? Journal.open(repoRoot, runId, opts.narrate) : Journal.create(repoRoot, runId, opts.narrate);
  // OBS-1010 / v2.6.8 T1: a demotion the JOURNAL carries into this session is replayed as what it was
  // live — a SOFT preference (reviewer role only; the worker channel is untouched — channel-demotion is
  // the worker fold, replayExcludedChannels). The seat ranks last, even over prefer, and may still be
  // re-tried at the end of the rotation; a resume never hardens one strike into an exclusion. Retirement
  // is the only hard rule: two real no-verdict strikes (the tally below) put a seat out for the run,
  // in-session and after resume alike, whatever prefer or history say. A launch-caused demotion an older
  // engine journaled is not replayed at all — neither soft nor hard.
  const demotedReviewers = replayedReviewerDemotions(journal.read());
  // OBS-1025 add.2 / OBS-1052 (Leg-2): the run-scoped no-verdict tally run-gates retires a seat from at two
  // strikes. execTask's badReviewers already excludes a seat after ONE strike within a task, so this map
  // is what bounds a seat that flakes once per task (or once per session) across the run. Seeded from the
  // journal's review-no-verdict rows — the same notes noteReviewEvent appends — so a resumed daemon keeps
  // the count; run-gates appends to it in place, exactly as it does demotedReviewers.
  // v2.6.8 T1: a launch failure never struck the live tally (run-gates), so a resume never seeds one.
  const reviewNoVerdicts = new Map<string, string[]>();
  for (const event of journal.read()) {
    if (event.event !== "review-no-verdict" || event.data.noVerdict !== true || typeof event.data.reviewer !== "string") continue;
    if (launchFailureNote(event.data)) continue;
    reviewNoVerdicts.set(event.data.reviewer, [...(reviewNoVerdicts.get(event.data.reviewer) ?? []), String(event.data.cause)]);
  }
  const reviewHistory = journal.read()
    .filter((event) => event.event === "gate-result" && event.data.gate === "review" && typeof event.data.reviewer === "string")
    .map((event) => event.data.reviewer as string);
  // RF-1 (OBS-922 add.3): the seats THIS task's review rows name — the prior reviewers a later round's
  // floor holds. Task-scoped on purpose: reviewHistory rotates seats run-wide and is never floor evidence.
  // Each row's journaled dispatch tier travels with it, so a seat that left the pool on resume still counts.
  // Leg-2 T4 M2: a `review-no-verdict` note is dispatch evidence too — it lands BEFORE the in-gate retry's
  // gate-result, so a daemon killed between the two leaves it as the task's only record of that seat.
  const taskReviewers = (taskId: string) => journal.read()
    .filter((event) => event.taskId === taskId && typeof event.data.reviewer === "string"
      && ((event.event === "gate-result" && event.data.gate === "review") || event.event === "review-no-verdict"))
    .map((event) => ({ reviewer: event.data.reviewer as string, tier: event.data.reviewerTier }));
  // Capture this before this observer appends run-resume. A prior run-end belongs to a completed
  // lifecycle and must use the ordinary resume/redispatch rules; only an interrupted live attempt
  // owns reusable measurements or unclean-death residue.
  const resumeLifecycleOpen = opts.resume && !runHasEnded(journal.read());
  const branchEvent = opts.resume
    ? [...journal.read()].reverse().find((e) => (e.event === "run-start" || e.event === "run-end" || e.event === "merge") && typeof e.data.branch === "string")
    : undefined;
  const recordedBranch = typeof branchEvent?.data.branch === "string" ? branchEvent.data.branch : undefined;
  branch = recordedBranch
    ? branchEvent!.event === "merge" ? recordedBranch.slice(0, recordedBranch.lastIndexOf("--")) : recordedBranch
    : integrationBranch(cfg, runId);
  if (lock.reclaimed) {
    // T15: SIGKILL/the kernel/power loss cannot ask the dead daemon to append a cause. The next live
    // observer owns that classification: a reclaimed durable lock plus an open journal lifecycle is
    // positive residue of an unclean exit. A completed lifecycle is not mislabeled on later resume.
    if (resumeLifecycleOpen) {
      journal.append("exit-cause", undefined, {
        cause: "unclean", priorPid: lock.reclaimed.pid, evidence: "reclaimed-lock-with-open-journal",
      });
    }
    journal.append("lock-reclaimed", undefined, lock.reclaimed); // HARD-02 audit trail
  }
  // GATE-08 (v1.12): the humanGate guard consults this run's journaled approvals, not just the compiled
  // flag. Startup approvals seed the first scheduling pass; live approvals are folded at task
  // boundaries below so a sibling can release parked work without waiting for run-end + resume.
  //
  // OBS-1178: revalidate every open approval before anything can enact it. The decision fold already
  // gives an unsound one no effect; the approval-refused row records that answer and consumes it, so
  // every fold and every operator reads the task as still parked — a stale waive never satisfies a newer gate.
  const refuseStaleApprovals = (): void => {
    for (const [taskId, stale] of staleApprovals(journal.read())) {
      // `lines` names the voided rows, so a sound decision beside a stale one survives the refusal.
      journal.append(APPROVAL_REFUSED, taskId, { reason: `stale or unbound decision refused before enactment — ${stale.reason}`, lines: stale.lines });
    }
  };
  refuseStaleApprovals();
  const approvalStartupEvents = journal.read();
  // Continuing human-gate permission survives enactment; malformed, refused or unsound releases grant none.
  const validApproval = (e: JournalEvent) => e.event === "task-approved" && e.taskId !== undefined
    && approvalAction(e.taskId, e).authority !== "inert";
  const approved = new Set(effectiveEvents(approvalStartupEvents).filter(validApproval).map((e) => e.taskId!));
  const startupActions = pendingDaemonApprovalActions(approvalStartupEvents);
  let approvalSweepCursor = approvalStartupEvents.length;
  const commands = detectGateCommands(repoRoot, cfg);
  const watchName = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
  let watchSlot: Slot | undefined;
  let boardOpened = false; // WB-1: only a board this daemon placed is watched below
  // Leg-2 T7 M1 (OBS-988): a reopen first retires the ghost through the driver's seam so the narrator
  // launches a NEW pane; a driver that answers with the lost pane anyway (no seam, or a cache it
  // would not drop) has not reopened anything, and that answer is a FAILED reopen, never a success.
  const openBoard = async (ghost?: { slot?: Slot; pane: string }): Promise<{ ok: true; slot: Slot } | { ok: false; error: string }> => {
    try {
      if (ghost?.slot) await trackedDriver.retireLostWatch?.(ghost.slot);
      const slot = await trackedDriver.narrator!(repoRoot, watchCommand(runId), runId);
      if (ghost && slot.id === ghost.pane) {
        liveSlots.delete(slot); // the ghost again: no close is ever aimed at it
        return { ok: false, error: `narrator answered with the lost pane ${ghost.pane}` };
      }
      watchSlot = slot;
      boardOpened = true;
      return { ok: true, slot };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const placeBoard = async (): Promise<Slot | undefined> => {
    if (!trackedDriver.narrator) {
      noteCapabilityAbsent("narrator");
      return undefined;
    }
    const placed = await openBoard();
    if (placed.ok) return placed.slot;
    journal.append("watch-placement-failed", undefined, { error: placed.error });
    console.error(`tickmarkr: narrator not opened: ${placed.error}`);
    return undefined;
  };
  // WB-1 (OBS-988): the daemon watches its own cockpit. A board is lost when its owner pid is dead, the
  // recorded arm has no presence, or its beat aged past the supervision stale bound with no owner pid
  // to consult. OBS-1110: a stale beat under a LIVE MATCHING OWNER — its pid answers and the arm it
  // claimed is present — is a slow board, not a lost one: journaled once per episode as
  // `watch-board-slow` and never spending a reopen. The beat and presence checks wait for the UI to
  // have armed (armId recorded) — a freshly reopened board that has not armed yet is not a second
  // loss. Reopens are bounded per run; past the bound the loss is journaled `boardless` and the
  // narrator is never called again.
  // Leg-2 T7 M2: one `watch-board-lost` row per LOSS. A loss is identified by the pane and pid the
  // owner record names; a reopen that fails leaves that record in place, so the next poll sees the
  // same loss, journals only its own reopen attempt, and the bound retires the run boardless from the
  // last failed attempt rather than from a repeated lost row.
  const MAX_BOARD_REOPENS = 3;
  let boardReopens = journal.read().filter((e) => e.event === "watch-board-reopened" || e.event === "watch-board-reopen-failed").length;
  let boardless = false;
  let journaledLoss: string | undefined;
  let journaledSlow: string | undefined;
  // Per claim: the next adoption offer, backed off (doubling from the poll cadence to a small cap) but
  // never exhausted; and whether a reservation is unresolved, so the loop must keep waking to watch it.
  const MAX_HELD_OFFER_GAP_MS = 4 * APPROVAL_POLL_MS;
  let heldOffer: { id: string; gapMs: number; nextAt: number } | undefined;
  let heldRetry = false;
  const boardHealth = (): { lost: Record<string, unknown> } | { slow: Record<string, unknown> } | undefined => {
    const owner = readWatchBoard(repoRoot, runId);
    if (!owner) return undefined;
    const named = { pane: owner.pane, ...(owner.pid !== undefined ? { pid: owner.pid } : {}) };
    const beat = owner.armId !== undefined ? readTierLiveness(repoRoot, "watch") : undefined;
    const row = beat?.state === "STALE" ? { ...named, beatAgeMs: beat.beatAgeMs } : named;
    if (owner.pid !== undefined && !isPidLive(owner.pid)) return { lost: row };
    if (owner.armId !== undefined && !existsSync(supervisionPresencePath(repoRoot, "watch", owner.armId))) return { lost: row };
    if (beat?.state === "STALE") return owner.pid !== undefined ? { slow: row } : { lost: row };
    return undefined;
  };
  // OBS-1172: a placement the driver HELD after an indeterminate split receipt has no slot here. While
  // the reservation stays unresolved the loop keeps polling it — even with every worker slot busy — so
  // a claim landing mid-task is seen. Once a live observer has claimed, the narrator is offered it
  // again, backed off per claim (doubling from the poll cadence to MAX_HELD_OFFER_GAP_MS) but never
  // exhausted: a listing that is unavailable or not yet showing the handle is retried until it proves
  // the board or the run ends; only success latches (the slot). The driver adopts the proven pane —
  // tracked from then on like any board — or keeps holding it, and never splits a second board over it.
  // This spends no reopen: nothing was lost.
  const adoptHeldBoard = async (): Promise<void> => {
    heldRetry = false;
    const owner = readWatchBoard(repoRoot, runId);
    if (watchSlot || owner?.pane !== "" || owner.retired) return;
    heldRetry = true;
    if (owner.pid === undefined || !isPidLive(owner.pid)) return; // unclaimed, or claimant dead: keep watching
    const id = `${owner.token}:${owner.pid}`;
    const now = Date.now();
    const offer = heldOffer?.id === id ? heldOffer : { id, gapMs: APPROVAL_POLL_MS, nextAt: now };
    if (now < offer.nextAt) { heldOffer = offer; return; }
    const adopted = await openBoard();
    if (adopted.ok) {
      heldOffer = undefined;
      heldRetry = false;
      journal.append("watch-board-adopted", undefined, { pane: adopted.slot.id });
      return;
    }
    heldOffer = { id, gapMs: Math.min(offer.gapMs * 2, MAX_HELD_OFFER_GAP_MS), nextAt: Date.now() + offer.gapMs };
  };
  const watchBoard = async (): Promise<void> => {
    if (boardless || !trackedDriver.narrator) return;
    if (!boardOpened) return adoptHeldBoard();
    const health = boardHealth();
    if (health && "slow" in health) {
      const identity = `${health.slow.pane}:${health.slow.pid}`;
      if (identity !== journaledSlow) {
        journaledSlow = identity;
        journal.append("watch-board-slow", undefined, health.slow);
      }
      return;
    }
    journaledSlow = undefined;
    if (!health) {
      journaledLoss = undefined;
      return adoptHeldBoard();
    }
    const loss = health.lost;
    const identity = `${loss.pane}:${loss.pid ?? ""}`;
    if (identity !== journaledLoss) {
      journaledLoss = identity;
      boardless = boardReopens >= MAX_BOARD_REOPENS;
      journal.append("watch-board-lost", undefined, { ...loss, ...(boardless ? { boardless: true } : {}) });
      if (boardless) return;
    }
    const attempt = ++boardReopens;
    // The ghost pane is gone: drop it from this run's live set so no close is ever aimed at it.
    const ghost = watchSlot;
    if (ghost) liveSlots.delete(ghost);
    watchSlot = undefined;
    const reopened = await openBoard({ slot: ghost, pane: loss.pane as string });
    if (reopened.ok) {
      journal.append("watch-board-reopened", undefined, { pane: readWatchBoard(repoRoot, runId)?.pane ?? reopened.slot.id, attempt });
      return;
    }
    boardless = attempt >= MAX_BOARD_REOPENS;
    journal.append("watch-board-reopen-failed", undefined, { pane: loss.pane, attempt, error: reopened.error, ...(boardless ? { boardless: true } : {}) });
    console.error(`tickmarkr: board not reopened (attempt ${attempt}): ${reopened.error}`);
  };

  // Reference rows are the durable source of truth; old journals establish one on first resume.
  const priorReference = opts.resume ? [...journal.read()].reverse().find(e =>
    ["host-reference", "host-reference-reset"].includes(e.event)
    && typeof e.data.medianMs === "number" && Number.isFinite(e.data.medianMs) && e.data.medianMs > 0) : undefined;
  let hostReferenceMs = priorReference?.data.medianMs as number | undefined;
  const hostSignal = (signal?: AbortSignal) => AbortSignal.any(
    [hostStop.signal, fatalStop.signal, signal, executionSignal()].filter((s): s is AbortSignal => !!s));
  const trackHost = <T>(promise: Promise<T>): Promise<T> => {
    hostChecks.add(promise);
    void promise.finally(() => hostChecks.delete(promise)).catch(() => {});
    return promise;
  };
  // OBS-1190: every admission poll still probes (the probe gates admission), but the journal keeps only
  // the first observation and each change of state or reference — healthy, degraded, unreadable,
  // recovered — the way suite-wait already dedupes by count. A steady wait no longer floods the journal.
  let journaledHost: string | undefined;
  const journalObservation = (taskId: string | undefined, observation: HostObservation, resuming: boolean) => {
    const state = observation.medianMs === null ? "unreadable"
      : hostReferenceMs !== undefined && hostDegraded(observation, hostReferenceMs) ? "degraded" : "healthy";
    const key = `${state}:${hostReferenceMs ?? ""}`;
    if (key === journaledHost) return;
    journaledHost = key;
    journal.append("host-observation", taskId, { ...observation, referenceMs: hostReferenceMs ?? null, resuming, state });
  };
  const recordReference = (observation: HostObservation) => {
    if (observation.medianMs === null) return;
    journal.append("host-reference", undefined, { ...observation });
    hostReferenceMs = observation.medianMs;
  };
  // Health and occupancy share a deadline, but only healthy occupancy gets the bounded fallback.
  const admitHost = async (taskId: string | undefined, signal: AbortSignal, initial?: HostObservation,
    resuming = false, gate?: GateName, onWait?: () => void): Promise<number> => {
    const startedAt = Date.now();
    let lastCount = -1;
    let observation = initial;
    let first = true;
    let resetEligible = resuming && hostReferenceMs !== undefined;
    for (;;) {
      signal.throwIfAborted();
      const count = await liveSuiteCount(repoRoot);
      signal.throwIfAborted();
      const remaining = suiteWaitCeilingMs - (Date.now() - startedAt);
      // Reserve a full bounded batch. A partial last batch would manufacture an unreadable
      // host at an otherwise healthy occupancy deadline. Retain the latest complete observation.
      const probeBudget = HOST_PROBE_SAMPLE_MS * HOST_PROBE_SAMPLES;
      if (!observation || (!first && remaining >= probeBudget)) {
        observation = await observeHost(signal, remaining > 0 ? Math.min(probeBudget, remaining) : undefined);
        journalObservation(taskId, observation, resuming);
      }
      first = false;
      if (hostReferenceMs === undefined && observation.medianMs !== null) recordReference(observation);
      const degraded = hostDegraded(observation, hostReferenceMs);
      resetEligible &&= count === 0 && observation.medianMs !== null && degraded;
      if (!degraded && (count === 0 || resuming)) return count;
      onWait?.();
      if (degraded) journal.append("host-degraded", taskId, {
        ...observation, referenceMs: hostReferenceMs ?? null, ...(gate ? { gate } : {}), count, waitedMs: Date.now() - startedAt,
      });
      else if (count !== lastCount) journal.append("suite-wait", taskId, { count, ...(gate ? { gate } : {}) });
      lastCount = count;
      if (Date.now() - startedAt >= suiteWaitCeilingMs) {
        if (degraded) {
          if (resetEligible) {
            // Append BOTH medians before adoption. An unreadable sample or live suite vetoes reset.
            journal.append("host-reference-reset", undefined, {
              referenceMs: hostReferenceMs, medianMs: observation.medianMs, waitedMs: Date.now() - startedAt,
            });
            hostReferenceMs = observation.medianMs!;
            return count;
          }
          throw new HostDegradedError("host latency remained degraded or unreadable through suite-wait deadline");
        }
        journal.append("suite-wait-ceiling", taskId, { count, waitedMs: Date.now() - startedAt });
        return count;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); },
          Math.min(SUITE_POLL_MS, Math.max(0, suiteWaitCeilingMs - (Date.now() - startedAt))));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  };
  const initializeHost = () => trackHost((async () => {
    const signal = hostSignal();
    const observation = await observeHost(signal);
    journalObservation(undefined, observation, !!opts.resume);
    if (hostReferenceMs === undefined) recordReference(observation);
    if (opts.resume || observation.medianMs === null) await admitHost(undefined, signal, observation, !!opts.resume);
  })());
  // Context carries attribution through gates and remote inference; only shell commands acquire.
  const commandLeases = new CommandLeases();
  // Only an unambiguous, currently open phase can attribute a command wait. Parallel siblings
  // deliberately leave gate absent; neither the last phase nor the last red is a safe substitute.
  const activeGatePhases = new Map<string, Set<GateName>>();
  const withCommandContext = <T>(taskId: string | undefined, run: () => Promise<T>, signal: AbortSignal | undefined = executionSignal()): Promise<T> => {
    let hostFailure: HostDegradedError | undefined;
    return runWithCommandLease((_command, execute) => {
      const active = taskId ? activeGatePhases.get(taskId) : undefined;
      const gate = active?.size === 1 ? [...active][0] : undefined;
      let waited = false;
      return commandLeases.run(async () => {
        if (hostFailure) throw hostFailure;
        let count: number;
        try { count = await trackHost(admitHost(taskId, hostSignal(signal), undefined, false, gate, () => { waited = true; })); }
        catch (error) {
          if (error instanceof HostDegradedError) hostFailure = error;
          throw error;
        }
        if (waited && taskId) {
          if (gate) journal.phaseStart(taskId, phaseForGate(gate), { gate, admitted: true });
          else journal.append("suite-admitted", taskId, {});
        }
        if (count > 0) {
          journal.append("suite-budget", taskId, {
            count, occupancyCap: occupancyCapacity.forkCap, conservativeCap: conservativeCapacity.forkCap,
          });
          return await runWithVerificationBudget(conservativeCapacity, execute);
        }
        return await execute();
      }, (count) => {
        waited = true;
        journal.append("suite-wait", taskId, { count, ...(gate ? { gate } : {}) });
      }, SUITE_POLL_MS, signal);
    }, () => runWithInterruptionSink(journalInterruption(journal, taskId), async () => {
      try {
        const result = await run();
        // Some command oracles turn launch errors into results. Admission failure still parks infra.
        if (hostFailure) throw hostFailure;
        return result;
      } finally { if (taskId) activeGatePhases.delete(taskId); }
    }));
  };

  let baseRef: string;
  let baseline!: Baseline;
  let baselinePending = false;
  const waitForBaseline = async (taskId: string) => {
    if (baselinePending) journal.append("baseline-wait", taskId, { baseRef });
    const signal = executionSignal();
    if (!signal) { await baselineCapture; return; }
    signal.throwIfAborted();
    // Capture is run-owned; stop this task waiting without cancelling another task's baseline.
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      baselineCapture.then(() => { signal.removeEventListener("abort", abort); resolve(); },
        (error) => { signal.removeEventListener("abort", abort); reject(error); });
    });
  };
  // Phase 46 (RES-01/RES-02): the resume-state map is built ONCE here so execTask closes over it.
  // Empty Map on fresh runs — every seed below conditions on resume.get(t.id), never on opts.resume (the
  // GATE-08 lesson at the humanGate guard: condition on the data, not the code path). Dead-code
  // equivalence to the router.ts:194 profile⇒undefined pattern: no map entry ⇒ today's literal.
  const resume = opts.resume ? journal.replayResumeState() : new Map<string, ResumeState>();
  const satisfiedGates = opts.resume ? journal.replaySatisfiedGates() : new Map<string, GateName>();
  const replayedGateResults = resumeLifecycleOpen
    ? journal.replayCurrentAttemptGateResults()
    : new Map<string, CurrentAttemptGateReplay>();
  for (const [taskId, action] of startupActions) {
    if (action.authority === "worker") replayedGateResults.delete(taskId);
  }
  // T7: the capacity THIS session resolved — read inside the run's fork budget, so it is the number
  // every shell this run spawns will divide the machine by. Recorded evidence from another session
  // is only reusable against this.
  const sessionCapacity: RunCapacity = resolvedCapacity();
  // R41: run-start/run-resume provenance — the protocol + effective lifecycle policy measured at
  // the repository root when this session began. Gate-result rows do NOT carry this value: each row
  // carries what run-gates measured for the task worktree the gate ran in (meta.verification), and
  // the replay guard below compares against a fresh measurement for the recreated worktree.
  const sessionVerification = verificationProtocol(process.env, repoRoot);
  const replayedExclusions = opts.resume ? journal.replayExcludedChannels() : new Set<string>();
  // Stamp each daemon session, including resumes with changed configuration or CLI overrides.
  // Keep the loaded-config hash's existing meaning; resolved execution inputs are explicit beside it.
  // Journal.append applies the normal credential redaction to the readable policy snapshot.
  const sessionMetadata = {
    environment: runEnvironment(cfg, channels, health),
    distFingerprint: distFingerprint(),
    verification: sessionVerification,
    effectivePolicy: { config: cfg, concurrency, driver: driver.id, commands },
    mode: rm.mode.mode,
    modeSource: rm.source,
  };
  if (opts.resume) {
    // v1.53 T5: a superseded run is dead — resuming it beside its successor is the exact
    // two-concurrent-runs hazard supersession exists to prevent. Fail closed, naming the successor.
    const superseded = [...journal.read()].reverse().find((e) => e.event === "superseded" && typeof e.data.by === "string");
    if (superseded) throw new Error(`refusing to resume ${runId}: superseded by ${superseded.data.by as string}`);
    const start = journal.read().find((e) => e.event === "run-start");
    if (!start) throw new Error(`journal for ${runId} has no run-start event`);
    baseRef = start.data.baseRef as string;
    // T3 (Sol #2 / Fable F2): refuse to replay this journal's task states onto a graph it does not
    // belong to — overlapping ids would inherit foreign done/human/approval state, missing ids throw.
    // The SAME comparator status uses (engagementComparable); one decision, two consumers. Fail closed:
    // no resume path silently accepts a mismatched or unbound journal. --graph-changed is the operator's
    // audited release for the stop-amend-resume workflow, journaling a graph-rehash naming both hashes.
    graph = applyScopeAmendments(graph, journal, true, opts.graphChanged === true);
    const loadedHash = graphDefinitionHash(graph);
    const cmp = engagementComparable(journal.read(), loadedHash);
    if (!cmp.comparable) {
      if (!opts.graphChanged) {
        throw new Error(cmp.reason === "unbound"
          ? `refusing to resume ${runId}: journal has no recorded graph definition hash (older tickmarkr) — pass --graph-changed to override`
          : `refusing to resume ${runId}: graph changed since this run (recorded ${cmp.recorded} ≠ loaded ${loadedHash}) — pass --graph-changed to override`);
      }
      journal.append("graph-rehash", undefined, {
        from: cmp.reason === "mismatch" ? cmp.recorded : null,
        to: loadedHash,
      });
    }
    // B (D-812): a daemon interrupted inside its capture leaves run-start without baseline.json. Only
    // that absence recaptures; existing bytes that do not parse fail closed and are never written over.
    const baselinePath = join(journal.dir, "baseline.json");
    let recapture = false;
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`refusing to resume ${runId}: existing baseline.json is unreadable (${error instanceof Error ? error.message : String(error)}) — it is never recaptured over`);
      }
      // The recapture measures run-start's commands; current config is no authority for that base.
      // Only unmasked bytes prove equality: redaction maps a changed credential onto the same mask, so a
      // journaled command carrying the mask cannot be proven unchanged and is refused like a change.
      const recorded = (typeof start.data.commands === "object" && start.data.commands !== null ? start.data.commands : {}) as Record<string, unknown>;
      const effective: Record<string, unknown> = commands;
      const changed = [...new Set([...Object.keys(recorded), ...Object.keys(effective)])]
        .filter((name) => recorded[name] !== effective[name] || String(recorded[name]).includes(MASK)).sort();
      if (changed.length > 0) {
        throw new Error(`refusing to resume ${runId}: baseline recapture refused — effective commands differ from (or are masked in) run-start's journaled commands: ${changed.join(", ")}`);
      }
      recapture = true;
    }
    const replayEvents = journal.read();
    // journal.replayStatuses predates typed releases and re-pends even inert rows. Keep that
    // legacy reader intact; scheduling accepts only the fold's recognised authorities.
    const statuses = new Map<string, Task["status"]>();
    for (const e of effectiveEvents(replayEvents)) { // OBS-1178: a refused or unsound decision released nothing
      if (!e.taskId) continue;
      if (e.event === "task-dispatch") statuses.set(e.taskId, "pending");
      else if (e.event === "task-done") statuses.set(e.taskId, "done");
      else if (e.event === "task-failed") statuses.set(e.taskId, "failed");
      else if (e.event === "task-human") statuses.set(e.taskId, "human");
      else if (validApproval(e)) statuses.set(e.taskId, "pending");
    }
    for (const [id, action] of startupActions) {
      // Legacy gate-only approvals can finish and merge without a dispatch consuming funding.
      if (action.authority !== "inert" && statuses.get(id) !== "done") statuses.set(id, "pending");
    }
    for (const [id, st] of statuses) {
      if (opts.retryFailed && st === "failed" && recordedTaskFailureKind(replayEvents, id) === "dispatch") {
        graph = setStatus(graph, id, "pending");
        // OBS-254: clear ATTEMPT AND CHANNEL STATE ONLY. Deleting the whole entry also deleted
        // upheldFeedback — the operator's funded brief — and the next dispatch advertised an empty
        // "fix these specifically" heading. A dispatch that died before worker-result then re-ran the
        // worker with the uphold's findings silently gone.
        const prior = resume.get(id);
        resume.set(id, { attempts: 0, tried: [], ...(prior?.upheldFeedback ? { upheldFeedback: prior.upheldFeedback } : {}) });
        continue;
      }
      // operator release: a graph.json edit back to "pending" beats a replayed human/failed park (locked decision 12)
      if ((st === "human" || st === "failed") && getTask(graph, id).status === "pending") continue;
      graph = setStatus(graph, id, st);
    }
    journal.append("run-resume", undefined, {
      ...sessionMetadata,
      pid: process.pid, // v1.13 (VIS-11): record the live daemon pid for status liveness
      ...(replayedExclusions.size > 0 ? { excludedChannels: [...replayedExclusions].sort() } : {}),
      ...(opts.retryFailed ? { retryFailed: true } : {}),
      ...(opts.graphChanged ? { graphChanged: true } : {}), // OBS-1073: the release is the engagement's
    });
    runStarted = true;
    await placeBoard();
    if (recapture) {
      // Moved HEAD is never baseline authority: measure the journaled base in a detached checkout this
      // daemon owns, and publish by rename so any interruption leaves no baseline.json or a whole one.
      journal.append("baseline-recapture-start", undefined, { baseRef, commands, capacity: resolvedCapacity() });
      baselinePending = true;
      baselineCapture = withCommandContext(undefined, async () => {
        const parent = join(tickmarkrDir(repoRoot), WORKTREES_DIR);
        mkdirSync(parent, { recursive: true });
        // A killed daemon never reaches the finally below; sweep checkouts whose owner is dead.
        for (const entry of readdirSync(parent)) {
          const owner = /^baseline-recapture-(\d+)-\w{6}$/.exec(entry)?.[1];
          if (owner && !isPidLive(Number(owner))) await removeWorktree(repoRoot, join(parent, entry));
        }
        const pristine = mkdtempSync(join(parent, `baseline-recapture-${process.pid}-`));
        const staged = `${baselinePath}.${process.pid}.tmp`;
        try {
          // the detached worktree capability (see addDetachedWorktree); a commondir moved while it ran is refused
          const added = await addDetachedWorktree(repoRoot, pristine, baseRef);
          if (added.code !== 0) throw new Error(`baseline recapture: journaled base ${baseRef} cannot be checked out: ${added.stderr.trim()}`);
          if (!linkNodeModules(repoRoot, pristine, { force: true })) throw new Error("baseline recapture: pristine node_modules link could not be provisioned");
          await initializeHost();
          const captured: Baseline = { ...await captureBaseline(pristine, commands),
            provenance: { baseRef, capturedAt: new Date().toISOString() } };
          writeFileSync(staged, JSON.stringify(captured, null, 2));
          renameSync(staged, baselinePath);
          baseline = captured;
          journal.append("baseline-recapture-complete", undefined, { provenance: captured.provenance });
          for (const warning of captured.warnings ?? []) journal.append("baseline-warning", undefined, { ...warning });
        } finally {
          rmSync(staged, { force: true });
          await removeWorktree(repoRoot, pristine);
        }
      }).finally(() => { baselinePending = false; });
      void baselineCapture.catch(() => { baselineFailed = true; });
    } else if (Object.keys(commands).length > 0 || graph.tasks.some(t => ["pending", "running", "gated"].includes(t.status))) {
      // A terminal resume with no commands has no execution to admit.
      baselineCapture = initializeHost();
      void baselineCapture.catch(() => { baselineFailed = true; });
    }
  } else {
    baseRef = await gitHead(repoRoot);
    journal.append("baseline-start", undefined, { baseRef, commands, capacity: resolvedCapacity() });
    await placeBoard();
    baselinePending = true;
    // Workers can run beside capture, but no gate may observe an absent or partial baseline.
    // Keep publication and warnings inside the same barrier as the suite's final verdict.
    baselineCapture = withCommandContext(undefined, async () => {
      // With no commands, capture is already complete: persist it before the probe can wait.
      // Otherwise a kill during startup can strand a resumable run without baseline.json.
      const emptyCapture = Object.keys(commands).length === 0 ? await captureBaseline(repoRoot, commands) : undefined;
      if (emptyCapture) writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(emptyCapture, null, 2));
      await initializeHost();
      // OBS-1123: the capture's identity and publication time ride the measurement every forgiveness reads.
      const captured: Baseline = { ...(emptyCapture ?? await captureBaseline(repoRoot, commands)),
        provenance: { baseRef, capturedAt: new Date().toISOString() } };
      writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(captured, null, 2));
      baseline = captured;
      for (const warning of captured.warnings ?? []) journal.append("baseline-warning", undefined, { ...warning });
      // These warning-only command oracles also run on the pristine repo before gates begin.
      for (const w of await detectVacuousOracles(repoRoot, graph.tasks)) journal.append("baseline-warning", w.taskId, { ...w });
    }).finally(() => { baselinePending = false; });
    // Attach a rejection handler immediately; gate and run-close awaits still propagate the error.
    void baselineCapture.catch(() => { baselineFailed = true; });
    writeFileSync(join(journal.dir, "graph.json"), readFileSync(join(tickmarkrDir(repoRoot), "graph.json")));
    journal.append("run-start", undefined, {
      ...sessionMetadata,
      pid: process.pid, baseRef, commands, channels: channels.map(channelKey),
      channelsByRole: {
        worker: pools.worker.map(channelKey),
        judge: pools.judge.map(channelKey),
        review: pools.review.map(channelKey),
        consult: pools.consult.map(channelKey),
      },
      driver: driver.id,
      driverEvidence: driverEvidence(cfg, driver, opts.driverOverride),
      branch, graphDefinitionHash: graphDefinitionHash(graph),
      ...(prior ? { supersedes: prior.runId } : {}),
    }); // graphDefinitionHash: T3 engagement identity (status+resume share it); pid: v1.13 (VIS-11) liveness; mode/modeSource: v1.51 T2; supersedes: v1.53 T5
    runStarted = true;
    // v1.53 T5: mark the prior run AFTER this run's run-start exists, so the prior journal never
    // names a successor that has no journal. Append-only — the prior journal is never rewritten.
    prior?.append("superseded", undefined, { by: runId });
  }

  // OBS-547: ONE full per-task collateral prediction for the whole run, computed here — uncapped, and
  // handed whole to every scope gate below (never recomputed at a red, never the plan's 20-item view).
  // Persisted beside baseline.json and RELOADED on resume (same reason baseline is): the prediction is
  // pre-dispatch state, and rescanning a repository the run has since edited would let an offender flip
  // between predicted and missed across stop/amend/resume. Missing file (pre-OBS-547 journal) ⇒ scan and
  // pin it now, so every later resume of this run agrees with this one.
  const collateralPath = join(journal.dir, "collateral.json");
  const pinnedCollateral = opts.resume && existsSync(collateralPath)
    ? new Map<string, string[]>(Object.entries(JSON.parse(readFileSync(collateralPath, "utf8")) as Record<string, string[]>))
    : null;
  const collateral = pinnedCollateral ?? collateralHits(graph.tasks, repoRoot);
  if (!pinnedCollateral) writeFileSync(collateralPath, JSON.stringify(Object.fromEntries(collateral), null, 2));

  const intWt = await ensureIntegration(repoRoot, branch, baseRef);

  // v1.1 visibility: role-named slots; panes persist per keepPanes (attempt = v1 close-after-harvest)
  const keepOpen = cfg.visibility.keepPanes !== "attempt";
  // D-07 (HYG-09) fleet hygiene — ephemeral panes self-clean + done means gone. keepLlm decouples the
  // judge/review/consult panes from the worker-oriented keepOpen: they close when their result is read
  // unless the operator opts into "forever" (the keep-everything debug override). Reproduces the
  // leftover-judge-pane incident (under keepPanes:"run" the run-end sweep left them open until the end).
  const keepForever = cfg.visibility.keepPanes === "forever";
  const keepLlm = keepForever;
  const keptSlots: Slot[] = [];
  const runTag = runId.replace(/^run-/, ""); // full date-time — cross-run unique even across days
  // OBS-57: per-run in-run demotion — channels that burn consecutive no-trailer windows route around for later attempts.
  // v1.71 OBS-119: on resume, re-seed from the journal fold (replayedExclusions) before any dispatch.
  const demotedChannels = new Set(replayedExclusions);
  const noTrailerStreak = new Map<string, number>();

  // OBS-17 T2: reconcile at every safe point — run start/resume (just journaled above), each task
  // terminal event, and run-end. The desired set is the pure journal fold (reconcile.ts); the driver
  // owns listing/parsing/closing. Cosmetic by contract: failures are swallowed and subprocess has no
  // reconcile (optional chain → no-op), so gates and the oracle suite never feel this. keepPanes
  // "forever" is the keep-everything debug override — it disables the sweep entirely.
  // OBS-1109: an interrupted attempt's pane is evidence — its nonce-bound trailer decides whether
  // the attempt is harvested, declined as foreign, or recovered — so the fold's run-resume clear
  // must not reach it before harvestInterruptedAttempt has read it and reaped its processes. Only a
  // resumed daemon can hold such an attempt: a fresh run's sweep is the baseline sweep.
  // OBS-1204: the set is FROZEN here, once, from the rows up to this daemon's own run-resume row: an
  // attempt launched after it is this daemon's own and reconciles exactly as in a fresh run. Each
  // frozen spare lapses for good once its harvest, decline or a superseding dispatch is journaled.
  const resumeInterrupted = new Map<string, { attempt: number; nonce: string }>();
  if (opts.resume) {
    const rows = journal.read();
    let resumedAt = rows.length - 1;
    while (resumedAt >= 0 && rows[resumedAt]!.event !== "run-resume") resumedAt--;
    const prior = rows.slice(0, resumedAt + 1);
    for (const t of graph.tasks) {
      const owned = interruptedAttempt(prior, t.id);
      if (owned?.launch) resumeInterrupted.set(t.id, { attempt: owned.attempt, nonce: owned.launch.nonce });
    }
  }
  const reconcile = async (sweep?: { spareLiveLlm?: boolean }) => {
    if (keepForever) return;
    try {
      const rows = journal.read();
      const desired = desiredPanes(rows, runId);
      for (const [taskId, frozen] of resumeInterrupted) {
        const owned = interruptedAttempt(rows, taskId);
        if (owned?.launch?.nonce !== frozen.nonce) resumeInterrupted.delete(taskId);
        else desired.add(formatOwnedName({ role: "worker", taskId, attempt: frozen.attempt, runId }));
      }
      // The watch pane is never the DRIVER sweep's candidate (panesToClose spares role "watch":
      // herdr's watches bookkeeping lives in close(), and a raw pane-close in the sweep would
      // leave narrator() a stale cache) — the driver always sees it as desired; its lifecycle is
      // decided here from the fold alone.
      await driver.reconcile?.(new Set([...desired, watchName]), runId, { ...sweep, endedRunIds });
      // OBS-103: when the fold retires the watch (run-end boundary), close the narrator. The
      // decision keys on the run identity in the pane name — narrator() adopts a prior daemon
      // instance's pane under the same owned name, so a stop→resume cycle's leftover narrator
      // closes exactly like one this instance opened. A narrator carrying a non-canonical name
      // (no run identity) is never this run's to sweep.
      if (watchSlot && watchSlot.name === watchName && !desired.has(watchName)) {
        const w = watchSlot;
        await trackedDriver.close(w);
        watchSlot = undefined;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      journal.append("watch-cleanup-failed", undefined, { error: reason });
      console.error(`tickmarkr: ${reason}`);
    }
  };
  // run start/resume boundary: nothing in flight, so the sweep takes this run's judge/review/consult
  // panes too. OBS-777: the one startup snapshot lets it reclaim only older runs proven ended, while
  // every live or unknown run remains spared.
  await reconcile();

  // v1.4 self-reference guard: a random nonce on the worker trailer AND exit marker. Displayed
  // source/diffs (e.g. a worker editing tickmarkr's own prompt.ts/daemon.ts) can't know it, so an echoed
  // TICKMARKR_RESULT/TICKMARKR_EXIT literal can never premature-harvest the worker. Quote-split keeps the
  // echoed command line itself from matching the marker it prints.
  //
  // v1.13 (VIS-09 safety, 43-02): the nonce is per-ATTEMPT, declared at the top of the attempt loop
  // below — NOT here at run scope. A run-scoped nonce is a latent hazard: HerdrDriver.read() is
  // `pane read --lines 1000` over scrollback and SubprocessDriver never clears s.buf, so any transcript
  // retention across attempts would let attempt N harvest attempt N-1's TICKMARKR_RESULT out of scrollback
  // as its OWN completion — silently LYING about a worker's outcome. Pinned by the stale-trailer oracle
  // in tests/run/daemon.test.ts ("a retained prior-attempt trailer cannot complete a retry"); a future
  // hoist back to run scope reddens it.
  // merges are serialized — two concurrent `git merge`s in one worktree would corrupt each other
  let mergeChain: Promise<unknown> = Promise.resolve();
  const mergeSerial = (taskBranch: string, t: Task, gated: string) => {
    const next = mergeChain.then(() => {
      fatalStop.signal.throwIfAborted();
      executionSignal()?.throwIfAborted();
      journal.phaseStart(t.id, "merge");
      return mergeTask(intWt, taskBranch, `tickmarkr: merge ${t.id} ${t.title}`, gated);
    });
    mergeChain = next.catch(() => undefined);
    return next;
  };

  // gateFails/consults are execTask-scoped counters passed in so a park row is a rich verified-failure
  // observation (e.g. ladder-exhausted + gateFails:4); every task-human row has a closed kind, never prose alone.
  const gateFailApprovalReason = (taskId: string, identity: string, includeUphold = false): string => {
    const commands = [
      `tickmarkr approve ${runId} ${taskId} --waive`,
      `tickmarkr approve ${runId} ${taskId} --recheck`,
      ...(includeUphold ? [`tickmarkr approve ${runId} ${taskId} --uphold`] : []),
    ];
    return `${identity} — release with ${commands.map((command) => `\`${command}\``).join(" or ")}`;
  };

  // Lexing never starts in the middle of a word. Resolution is separate so missing hints
  // remain visible evidence without becoming executable approval advice.
  const namedPaths = (text: string): string[] => [...text.matchAll(/(?:^|[\s`'"])((?:[A-Za-z0-9_@.()[\]-]+\/)+[A-Za-z0-9_@.[\]-]+|[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_-]+)+)(?=$|[\s`'"),:;.!?])/g)]
    .map((match) => match[1]!.replace(/^\.\//, "").replace(/\.$/, ""))
    .filter((path) => !path.split("/").includes(".."));
  const diffPaths = async (base: string, wt: string): Promise<Set<string>> => {
    const out = await shGit(`git diff --name-only -z ${shq(base)}..HEAD`, wt);
    return new Set(out.code === 0 ? out.stdout.split("\0").filter(Boolean) : []);
  };
  /** The paths a gate diagnostic may name: the gated worktree's tracked tree plus its diff — never the main checkout. */
  const treeOrDiffPaths = async (base: string, wt: string): Promise<Set<string>> => {
    const tree = await shGit("git ls-files -z", wt);
    return new Set([...(tree.code === 0 ? tree.stdout.split("\0").filter(Boolean) : []), ...await diffPaths(base, wt)]);
  };

  // The base each task was dispatched on: the integration branch moves when a sibling merges, the pin does not.
  const taskBases = new Map<string, string>();

  const park = async (t: Task, reason: string, kind: ParkKind, assignment: Assignment | null, attempts: number, startMs: number, gateFails = 0, consults = 0, tokens?: TokenUsage, metered = 0, retryMode: RetryMode = "fresh", details: Record<string, unknown> = {}) => {
    // OBS-979: a worker refusal can identify the missing authoring scope even when gates
    // subsequently supply the park's disposition. Keep that actionable path on the park itself.
    const worker = journal.read().reverse().find((e) => e.taskId === t.id && e.event === "worker-result");
    if (!details.approveCommand && t.files.length > 0 && worker?.data.ok === false && typeof worker.data.summary === "string") {
      const allowed = filesGlob(t.files);
      // OBS-1072 residual: the same inventory as the main path — the task tree and its diff from the
      // task's PINNED base, never the main checkout and never the moving integration branch.
      const wt = worktreePath(repoRoot, `${branch}--${t.id}`);
      const inventory = existsSync(wt) ? await treeOrDiffPaths(taskBases.get(t.id) ?? "HEAD", wt) : new Set<string>();
      const paths = resolveScopeHints(namedPaths(worker.data.summary).filter((path) => !allowed(path)), inventory)
        .resolved.filter((path) => !allowed(path));
      if (paths.length) reason += ` — files[] repair hint: ${paths.join(", ")}`;
    }
    graph = setStatus(graph, t.id, "human");
    saveGraph(repoRoot, graph);
    journal.append("task-human", t.id, { ...details, reason, kind });
    // OBS-1178: the notice carries the park token an approval binds to (`approve --park <token>`).
    const parked = journal.newestBinding(t.id);
    const token = parked && bindingToken(parked);
    if (assignment) {
      // OBS-547: `metered` counts CHARGEABLE metered attempts, so an unchargeable dispatch passes 0 and
      // the count is omitted rather than written as 0 or as `1` beside `attempts: 0` — a row claiming
      // more metered attempts than it charges reports as "floor: 1/0 attempts metered". tokens stay
      // (the spend was real); tokens-without-a-count is the already-modelled degraded ⇒ floor row.
      journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts, outcome: "human", durationMs: Date.now() - startMs, parkKind: kind, gateFails, consults, tokens, meteredAttempts: tokens && metered ? metered : undefined, retryMode });
    }
    await reconcile({ spareLiveLlm: true }); // task-human is a terminal event — sweep, sparing sibling tasks' live LLM panes
    await driver.notify(`tickmarkr ${runId}: ${t.id} needs a human — ${reason}${token ? `\npark ${token} — bind the decision with \`--park ${token}\`` : ""}`, { tier: "attention" });
  };

  // OBS-1106 residual: a retry that landed nothing on a timeout-class red re-observes it ONCE fresh:
  // neither a journal replay nor the verdict cache may re-state that red. Owed when the prior round's
  // test red sits on this very subject, is timeout-shaped, and has not yet been observed twice
  // independently — once it has, the fingerprint cap owns the next move. Read from the journal alone,
  // so the live gate loop and a resume battery decide alike.
  const owesTimeoutRefresh = (t: Task, priorRows: JournalEvent[], commit: string): boolean => {
    const red = priorRows.find((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === false
      && e.data.skipped !== true && e.data.commit === commit && typeof e.data.details === "string" && timeoutShaped(e.data.details));
    return red !== undefined
      && identicalGateFailures(journal.read(), t.id, "test", normalizeGateFailure(String(red.data.details))) < GATE_FINGERPRINT_CAP;
  };
  // C: an unchanged cached test red attributed wholly outside files[] is re-executed ONCE per journaled
  // subject — the worker cannot repair those files, so a copy of the red would only buy another round.
  const owesOutsideScopeRefresh = (t: Task, priorRows: JournalEvent[], commit: string): boolean =>
    allOutsideScopeReds(t, priorRows, commit)
    && !journal.read().some((e) => e.taskId === t.id && e.event === "gate-fresh-forced"
      && e.data.reason === OUTSIDE_SCOPE_RED && e.data.commit === commit);
  // C: the forced re-execution's own round failed again only outside files[]: independent evidence the
  // worker cannot act on. It keeps its red row and parks gate-fail before any cap, consult or repair move.
  const freshOutsideScopeRed = (t: Task, commit: string): boolean => {
    const own = journal.read().filter((e) => e.taskId === t.id);
    return allOutsideScopeReds(t, own.slice(own.map((e) => e.event === "phase-start" && e.data.phase === "gates").lastIndexOf(true) + 1), commit);
  };
  const outsideScopePark = (t: Task) => gateFailApprovalReason(t.id,
    "test: a fresh re-execution of the unchanged subject failed again only in files outside files[] — no repair can reach them");

  // OBS-1106 residual: before a timeout or wall-budget red accompanied by runner infra diagnostics is
  // charged, its attributed failing files are re-run ONCE, on the same checkout, under the suite
  // lease. Only a reproduced assertion is charged. A pass, an infra rerun, a rerun naming none of the
  // files, or an unattributable red parks with the ORIGINAL red journaled and unresolved: the rerun is
  // diagnostic, never a verdict, so it can neither green the gate nor permit a merge. Returns true
  // when it parked.
  const adjudicateInfraShapedRed = async (t: Task, results: GateResult[], wt: string, subject: string, attempt: number,
    replayed: boolean, parkInfra: (reason: string) => Promise<void>): Promise<boolean> => {
    const red = results.find((g) => g.gate === "test" && gateFailed(g) && !isInfraResult(g)
      && timeoutShaped(g.details) && RUNNER_INFRA_DIAGNOSTIC_RE.test(g.details));
    if (!red || commands.test === undefined) return false;
    // The observation this red states: its subject, its fingerprint and, when it carries one, its
    // receipt's invocation. A copy (journal replay, cache hit) is never re-run when THAT observation's
    // adjudication is on the ledger — its recorded outcome decides, so a crash after the adjudication
    // but before its park still parks. A crash before the adjudication leaves none, so the copy is
    // adjudicated now. A fresh red always is.
    const fingerprint = normalizeGateFailure(red.details);
    const observation = receiptOrigin({ evidenceReceipt: red.evidenceReceipt ?? red.meta?.evidenceReceipt,
      evidenceReceipts: red.evidenceReceipts ?? red.meta?.evidenceReceipts });
    const recorded = replayed || red.meta?.reused === true
      ? journal.read().reverse().find((e) => e.taskId === t.id && e.event === "gate-reobserved"
        && e.data.commit === subject && e.data.fingerprint === fingerprint
        && (observation === undefined || e.data.observation === undefined || e.data.observation === observation))
      : undefined;
    let files: string[] = [];
    let outcome: "reproduced" | "passed" | "ambiguous" | "unattributed" = "unattributed";
    let selection: string[] | undefined;
    if (recorded) {
      files = Array.isArray(recorded.data.files) ? recorded.data.files.filter((f): f is string => typeof f === "string") : [];
      outcome = ["reproduced", "passed", "unattributed"].includes(String(recorded.data.outcome)) ? recorded.data.outcome as typeof outcome : "ambiguous";
    } else {
      for (const file of attributedFailingFiles(red)) {
        if (posix.normalize(file) === file && !file.startsWith("../") && !file.startsWith("/") && existsSync(join(wt, file))) files.push(file);
      }
      let rerun: GateResult | undefined;
      if (files.length) {
        rerun = await withCommandContext(t.id, () => reobserveTestFiles(wt, commands.test!, baseline, files, journal.dir))
          .catch((error: unknown): GateResult => ({ gate: "test", pass: false, details: `infra: rerun failed: ${error instanceof Error ? error.message : String(error)}`, meta: { infra: true } }));
        classifyInfraResult(rerun);
        const judged = reobservationOutcome(files, rerun);
        outcome = judged.outcome;
        selection = judged.selection;
      }
      journal.append("gate-reobserved", t.id, {
        gate: "test", attempt, commit: subject, fingerprint, ...(observation ? { observation } : {}), files, outcome,
        ...(selection ? { selection } : {}),
        ...(rerun ? { pass: rerun.pass, details: rerun.details } : {}),
        ...(rerun?.evidenceReceipt ? { evidenceReceipt: rerun.evidenceReceipt } : {}),
      });
    }
    if (outcome === "reproduced") return false;
    await parkInfra(`test: timeout-shaped red with runner infra diagnostics was not reproduced by one isolated rerun of ${files.length ? files.join(", ") : "its attributed files (none attributable)"} (${outcome}); the original red stands unresolved — recheck to re-measure:\n${readableExcerpt(red.details)}`);
    return true;
  };

  // OBS-547: cross-reference a scope red against the prediction this run already computed. Every hard
  // offender predicted ⇒ an AUTHORING defect whose repair is pre-written: journal the classification
  // with the verbatim files[] lines and park unchargeable. It owes nothing to the quality machinery —
  // no chargeable attempt, no gateFails, no escalation, no ladder rung — and `scope-authoring` is what
  // makes a resume replay agree (journal.ts replayResumeState). One unpredicted offender keeps today's
  // chargeable behaviour and records the miss, so the lint's blind spots accumulate as evidence rather
  // than folklore. ONE disposition for BOTH paths that observe a red — the ordinary attempt and the
  // resume gate replay: which code path noticed the red must never decide who pays for it. Returns
  // true when it parked; the caller then returns without charging anything.
  // `attempts` is the count of CHARGEABLE attempts before this dispatch — never this dispatch's own
  // count. The two callers arrive at it differently (the attempt loop's index already excludes the
  // dispatch in flight; a gate replay's rs.attempts already includes it), and the ordinal journaled
  // below is derived from it here so both paths number the same dispatch identically.
  const dispositionScopeRed = async (t: Task, results: GateResult[], assignment: Assignment | null,
    attempts: number, startMs: number, gateFails: number, consults: number, tokens: TokenUsage | undefined,
    metered: number, retryMode: RetryMode, changed: ReadonlySet<string> = new Set()): Promise<boolean> => {
    const scopeRed = results.find((g) => g.gate === "scope" && gateFailed(g));
    const verdict = scopeRed?.meta?.collateral as ScopeCollateralVerdict | undefined;
    const worker = journal.read().reverse().find((e) => e.taskId === t.id && e.event === "worker-result");
    const disposition = classifyRepairDisposition({
      // OBS-1072 add.2: hints are lexed from the readable excerpt, never from terminal control bytes.
      results: results.map((g) => ({ ...g, details: readableExcerpt(g.details) })), files: t.files, inventory: changed,
      refusalSummary: worker?.data.ok === false && typeof worker.data.summary === "string" ? worker.data.summary : undefined,
    });
    for (const diagnostic of disposition.diagnostics) {
      journal.append("scope-hint-unresolved", t.id, {
        paths: [diagnostic.candidate], reason: diagnostic.reason, diagnostic, attempt: attempts + 1,
      });
    }
    if (disposition.blocker === "infra") return false;
    if (!disposition.blocker && (disposition.kind === "scope-request" || disposition.kind === "authoring")) {
      const paths = disposition.paths;
      const scopeRequest = disposition.kind === "scope-request";
      const classification = {
        gate: disposition.source, paths, repair: `files[] repair hint: ${paths.join(", ")}`,
        attempt: attempts + 1, chargeable: false, source: "diagnostic",
      };
      if (scopeRequest) journal.append("scope-request", t.id, classification);
      else journal.append("scope-authoring", t.id, classification);
      const approveCommand = `tickmarkr approve ${runId} ${t.id} --files ${paths.map((path) => /^[\w./-]+$/.test(path) ? path : shq(path)).join(",")}`;
      await park(t, `${scopeRequest ? "scope request" : "authoring defect"} — files[] repair hint: ${paths.join(", ")}; current files[]: ${t.files.join(", ")}${scopeRequest ? `\n${approveCommand}` : ""}`,
        scopeRequest ? "scope-request" : "authoring", assignment, attempts, startMs, gateFails, consults, tokens, 0, retryMode,
        scopeRequest ? { paths, approveCommand, graphDefinitionHash: graphDefinitionHash(graph) } : {});
      return true;
    }
    // A detection site permits the ordinary chargeable policy; it does not itself grant budget.
    if (!verdict) return false;
    if (verdict.authoring) {
      journal.append("scope-authoring", t.id, {
        gate: "scope",
        predicted: verdict.predicted,
        repair: verdict.repair,
        attempt: attempts + 1,
        chargeable: false,
        // The dispatch was PHYSICALLY metered even though nobody is charged for it. Physical metering
        // is recorded here, separately, so the telemetry row can stay chargeable-consistent: passing
        // this count on would print `meteredAttempts: 1` beside `attempts: 0`.
        ...(tokens ? { tokens, meteredDispatches: metered } : {}),
        ...(assignment ? { channel: channelKey(assignment) } : {}),
      });
      await driver.notify(`tickmarkr ${runId}: ${t.id} scope red was PREDICTED — authoring defect, no attempt charged`, { tier: "attention" });
      await park(t, `scope: every out-of-scope path was predicted by the collateral lint before dispatch — authoring defect, not a worker failure. Repair:\n${verdict.repair}`,
        "authoring", assignment, attempts, startMs, gateFails, consults, tokens, 0, retryMode);
      return true;
    }
    if (verdict.missed.length) {
      journal.append("collateral-miss", t.id, {
        gate: "scope",
        unpredicted: verdict.missed,
        predicted: verdict.predicted,
        attempt: attempts + 1,
      });
    }
    return false;
  };

  // OBS-1158: admission reads the same journal snapshot the sweep folded, through the shared seam.
  let admissionPriority = batteryPriority(startupActions.values());
  const admissible = () => readyTasks(graph, admissionPriority);
  const sweepLiveApprovals = (): void => {
    let events = journal.read();
    if (events.slice(approvalSweepCursor).some((e) => e.event === "task-approved")) {
      refuseStaleApprovals();
      events = journal.read();
    }
    admissionPriority = batteryPriority(pendingDaemonApprovalActions(events).values());
    const approvals = events.slice(approvalSweepCursor)
      .filter((e) => e.event === "task-approved" && e.taskId);
    approvalSweepCursor = events.length;
    if (approvals.length === 0) return;

    // Replay every authority from this pass's single snapshot. In particular, helper reads must
    // neither rescan the file under load nor observe approvals beyond approvalSweepCursor.
    // Keep audit writes on the live journal so narration and persistence retain their owner.
    const sweepJournal = Journal.open(repoRoot, runId);
    sweepJournal.read = () => events;
    sweepJournal.append = journal.append.bind(journal);
    graph = applyScopeAmendments(graph, sweepJournal, false, opts.graphChanged === true); // OBS-1073: same release as launch
    const actions = pendingDaemonApprovalActions(events);
    const nextResume = sweepJournal.replayResumeState();
    const nextSatisfied = sweepJournal.replaySatisfiedGates();
    let changed = false;
    for (const taskId of new Set(approvals.map((e) => e.taskId!))) {
      const action = actions.get(taskId);
      if (!action || action.authority === "inert") continue;
      approved.add(taskId);
      const state = nextResume.get(taskId);
      if (state) resume.set(taskId, state);
      else resume.delete(taskId);
      const gate = nextSatisfied.get(taskId);
      if (gate) satisfiedGates.set(taskId, gate);
      else satisfiedGates.delete(taskId);
      if (action.authority !== "waiver") replayedGateResults.delete(taskId);
      try {
        const task = getTask(graph, taskId);
        if (task.status === "human" || task.status === "failed") {
          graph = setStatus(graph, taskId, "pending");
          changed = true;
        }
      } catch {
        // Unknown task in a stale journal: approval replay is inert, like the other journal folds.
      }
    }
    if (changed) saveGraph(repoRoot, graph);
  };

  // OBS-1168(c): every gate callback is bound to the engagement that asked for it. Once the scheduler
  // settles that engagement (done, parked or failed), a late sibling's event is dropped, never journaled.
  const engagements = new Map<string, object>();
  const execTask = async (t: Task): Promise<void> => {
    const engagement = {};
    engagements.set(t.id, engagement);
    const liveEngagement = () => engagements.get(t.id) === engagement;
    const approvalAction = pendingDaemonApprovalActions(journal.read()).get(t.id);
    const fundedRerun = approvalAction?.authority === "worker";
    const startMs = Date.now();
    let stallSeat: string | undefined;
    let stallReaps = 0;
    let reapedWorktreeRef: string | undefined;
    const taskTimeoutMinutes = t.timeoutMinutes ?? cfg.taskTimeoutMinutes;
    if (t.humanGate && !approved.has(t.id)) {
      // GATE-08: the condition is the APPROVAL, never the code path. `!opts.resume` (or any run-phase
      // term) would silently dispatch every unapproved gate that becomes ready during a resume — pinned
      // by the resume-path guard pin in tests/run/daemon.test.ts (the only test that reaches this guard
      // on the resume path; a park-then-resume task is filtered out by readyTasks() and never gets here).
      await park(t, `humanGate: "${t.title}" requires approval before dispatch`, "human-gate", null, 0, startMs);
      return;
    }

    // The driver owns how a checkout is created, but runDaemon owns the destructive transition:
    // every task-checkout recreation passes through this wrapper before any driver can remove the
    // old path. A preservation failure throws and therefore leaves the old checkout in place. The
    // row is deliberately written before the later worktree-recreation row so the journal cannot
    // describe only the commits it carried while omitting uncommitted work the removal destroyed.
    const producerNow = (): PreserveProducer => knownProducer(journal.read(), t.id);
    const recreateTaskWorktree = async (taskBranch: string, taskBase: string, priorWt: string) => {
      const producer = producerNow();
      const ref = await preserveWorktree(priorWt, producer);
      if (ref) journal.append("worktree-preserved", t.id, { ref, ...producerFields(producer) });
      return driver.worktree(repoRoot, taskBranch, taskBase);
    };

    // A dead worker with a clean checkout still needs a durable recovery handle: there may be no
    // pane left to identify even the commit it was dispatched from. preserveWorktree deliberately
    // creates no ref for ordinary clean recreations, so this exceptional terminal path pins HEAD
    // explicitly under the same recovery namespace. Reconfirm the delta immediately before the
    // ref write; a change or unreadable recheck withdraws the park.
    const preserveDeadWorker = async (worktree: string, taskBase: string): Promise<{
      state: WorktreeComparison;
      ref?: string;
    }> => {
      const state = await observeWorktreeDelta(taskBase, worktree);
      if (state !== "unchanged") return { state };
      const head = await gitHead(worktree);
      const ref = `refs/tickmarkr/preserved/${head}`;
      const updated = await shGit(`git update-ref ${shq(ref)} ${shq(head)}`, worktree);
      if (updated.code !== 0) throw new Error(`could not preserve dead worker HEAD at ${ref}: ${updated.stderr || updated.stdout}`);
      return { state, ref };
    };

    const r = route(t, cfg, channels, profile, undefined, demotedChannels);
    for (const lint of r.lints) journal.append("routing-lint", t.id, { lint });
    // VIS-02: journal a deviation from the static choice ONLY when one occurred (greppable absence = no deviation)
    if (r.deviation) journal.append("route-deviation", t.id, { ...r.deviation, provenance: r.provenance });
    let assignment = r.assignment;
    // Phase 46 (RES-01/RES-02, incident run-20260711-185020 L57-58): resume continues the escalation
    // ladder. Replaying `tried` alone does NOT fix the incident — the first post-resume assignment comes
    // from route() above, which is history-free by design and statically re-picked the consult-banned
    // channel 2 ms after run-resume (daemon.ts:160, the incident's exact mechanism). The override below
    // IS the fix; the tried seed and the attempt-loop start close RES-01/RES-02 alongside it.
    //
    // v1.24 OBS-18: a task-approved{release:attempt-cap} zeros rs.attempts (fresh budget) and clears
    // lastAssignment while keeping tried, so the restore below is skipped — after a
    // fresh-budget release, prefer nextChannel over the surviving tried-list so burned channels are
    // not re-tried first (consult bans / prior failovers survive the release).
    const rs = resume.get(t.id);
    let bootstrapExhausted: string | undefined;
    const contentDigest = taskContentDigest(t);
    const previousDispatch = journal.read().reverse().find((e) => e.taskId === t.id && e.event === "task-dispatch");
    const recordedGraphPath = join(journal.dir, "graph.json");
    const recordedTask = existsSync(recordedGraphPath)
      ? (JSON.parse(readFileSync(recordedGraphPath, "utf8")) as { tasks: Task[] }).tasks.find((task) => task.id === t.id)
      : undefined;
    const previousHints = previousDispatch && "routingHints" in previousDispatch.data
      ? previousDispatch.data.routingHints as Task["routingHints"] : recordedTask?.routingHints;
    const hintsChanged = !!rs && (!!recordedTask || !!previousDispatch && "routingHints" in previousDispatch.data)
      && (JSON.stringify(previousHints?.pin) !== JSON.stringify(t.routingHints?.pin)
        || previousHints?.floor !== t.routingHints?.floor);
    if (hintsChanged) journal.append("restore-rerouted", t.id, {
      from: rs.lastAssignment ? channelKey(rs.lastAssignment) : rs.tried.at(-1) ?? null,
      to: channelKey(assignment),
      reason: JSON.stringify(previousHints?.pin) !== JSON.stringify(t.routingHints?.pin) ? "pin changed" : "floor changed",
    });
    // OBS-1161: no `attempts > 0` guard — every release already clears lastAssignment in the replay,
    // and a lastAssignment at zero attempts is a first dispatch whose capacity requeue was taken back:
    // the seat is still in force, so restore it instead of failing over its own tried[] entry early.
    // OBS-1187: a restored seat must still be a member of the task's pool (the operator may have closed it).
    // F/W (D-718): and not excluded under the router's one meaning — its raw key, or a probed identity
    // it shares with an excluded channel; an unprobed seat is excluded by its raw key alone.
    if (!hintsChanged && rs?.lastAssignment
        && channels.some((c) => channelKey(c) === channelKey(rs.lastAssignment!))
        && inTaskPool(t, cfg, channelKey(rs.lastAssignment))
        && !channelExclusion(channels, demotedChannels)(rs.lastAssignment)) {
      assignment = rs.lastAssignment; // restore the consult-chosen assignment (bypasses route()'s static re-pick)
    } else if (!hintsChanged && rs && rs.tried.length && !t.routingHints?.pin) {
      // trailing-reroute edge (kill between verdict and dispatch), a stale fleet, OR a fresh-budget
      // release (attempts 0 + non-empty tried): pick a failover over the replayed exclusions via the
      // EXISTING nextChannel `tried` parameter — zero router changes (D-03).
      // OBS-1034: a PIN is exempt — route() already returned it, and a review-upheld repair of the diff
      // the pin produced belongs on the pin, not on the next seat its own tried[] entry would pick.
      // OBS-1169: an adapter a bootstrap failover escalated away from stays out, sibling or none.
      const escalatedOut = channels.filter((c) => rs.escalatedAdapters?.includes(c.adapter)).map(channelKey);
      const next = nextChannel(assignment, t, cfg, channels, [...rs.tried, ...Object.keys(rs.escalated ?? {}), ...escalatedOut], profile, demotedChannels);
      if (next) assignment = next;
      // ponytail: nextChannel null (every channel already tried / none available) — keep the static
      // assignment and proceed. Dispatching on a previously-tried channel beats deadlocking a resumed
      // run; a park-instead policy can come later if it ever bites.
      // OBS-1169: …except onto an escalated adapter — that relaunches the broken bootstrap, so it parks infra below.
      else if (rs.escalatedAdapters?.includes(assignment.adapter)) bootstrapExhausted = channelKey(assignment);
    }
    const taskHistory = effectiveEvents(journal.read()).filter((e) => e.taskId === t.id); // OBS-1178: only an effective decision opens an engagement
    // Lifetime identity counts every dispatch, including legacy and unchargeable rows. Releases
    // reset the budget below, never this counter; observational annotations do not consume it.
    let nextWorkerDispatchOrdinal = taskHistory.filter((e) => e.event === "task-dispatch").length;
    const lastApproval = taskHistory.map((e) => e.event).lastIndexOf("task-approved");
    const priorClimb = taskHistory.slice(lastApproval + 1).reverse().find((e) => e.event === "tier-escalated");
    if (!hintsChanged && priorClimb && taskHistory.indexOf(priorClimb) > taskHistory.map((e) => e.event).lastIndexOf("task-dispatch")) {
      const target = channels.find((c) => channelKey(c) === priorClimb.data.to && !demotedChannels.has(channelKey(c))
        && inTaskPool(t, cfg, channelKey(c)));
      if (target) assignment = seatAssignment(target);
    }
    // pre-kill invariant: tried always contains the current assignment. Spread, never alias the
    // journal-derived array (no hidden mutation of replayed state).
    const tried = rs?.tried.length ? [...rs.tried] : [channelKey(assignment)];
    if (!tried.includes(channelKey(assignment))) tried.push(channelKey(assignment));
    // OBS-1169 add.1: channels excluded because their whole adapter was escalated away from ride
    // `tried` (nextChannel's one exclusion input) but were never launched — keep the true reason so
    // the dispatch row never labels an unlaunched sibling "already tried".
    const vendorEscalated = new Map<string, string>();
    // …and a resume restores them with their reasons, apart from the channels actually dispatched.
    for (const [k, why] of Object.entries(rs?.escalated ?? {})) {
      if (tried.includes(k)) continue;
      tried.push(k);
      vendorEscalated.set(k, why);
    }
    // OBS-1169 add.2: the ADAPTER exclusion itself, apart from any sibling channel — a single-channel
    // adapter has no untried sibling to carry it, yet its exhausted channel must stay out of the
    // recycle pool (and a resume's) until the release that clears `tried`.
    const escalatedAdapters = new Set<string>(rs?.escalatedAdapters ?? []);
    const escalateAdapter = (adapter: string, reason: string) => {
      escalatedAdapters.add(adapter);
      for (const c of channels) {
        const k = channelKey(c);
        if (c.adapter !== adapter || tried.includes(k)) continue;
        tried.push(k);
        vendorEscalated.set(k, reason);
      }
    };
    // VIS-02 convention: absence = no seeding happened. The observable surface for criterion 2's
    // exclusion-list-equality oracle. Daemon-side append only — no journal.ts write-path change (Phase 48
    // stays unblocked); inert to replayStatuses (unknown events ignored, pinned at journal.test.ts:70-80).
    if (rs) journal.append("resume-restore", t.id, {
      attempts: rs.attempts, tried: [...tried], assignment,
      workerDispatchOrdinal: previousDispatch?.data.workerDispatchOrdinal ?? null,
    });
    if (bootstrapExhausted === channelKey(assignment)) { // a later tier-climb restore may have moved it off
      await park(t, `${bootstrapExhausted} failed at bootstrap and no eligible channel remains after resume${poolExhaustion(t, cfg)}`, "infra",
        assignment, rs?.attempts ?? 0, startMs, 0, 0, undefined, 0, "fresh", { cause: "bootstrap", channel: bootstrapExhausted });
      return;
    }
    // Keep one live list: recovery retries must see exclusions added by onGate during the round. It starts
    // empty on resume too: a replayed demotion is soft (demotedReviewers), retirement is the run tally.
    const badReviewers: string[] = [];
    // v2.6.8 T1: a seat that failed to launch (any launchCause) is excluded for the CURRENT round only —
    // after its one bounded same-seat launch retry (run-gates), so an always-refusing pool still ends the
    // round — and is never struck task-wide or run-wide: a later round may seat it again.
    let roundTimeouts: string[] = [];
    const noteReviewEvent = (note: Extract<GateEvent, { phase: "note" }>) => {
      // The same-seat launch retry is bounded per candidate: its row carries the commit it was spent on.
      const e = note.name === "review-infra-retry" && gateSubject ? { ...note, payload: { ...note.payload, commit: gateSubject.commit } } : note;
      journal.append(e.name, t.id, e.payload);
      if (e.name === "review-no-verdict" && typeof e.payload.reviewer === "string") {
        const strikes = launchFailureNote(e.payload) ? roundTimeouts : badReviewers;
        if (!strikes.includes(e.payload.reviewer)) strikes.push(e.payload.reviewer);
      }
      // OBS-1196: a seat whose same-subject re-emission delivered a valid verdict was a delivery flake,
      // not a bad reviewer — it stays seatable for this task's later rounds.
      if (e.name === "review-reemission" && e.payload.delivered === true && typeof e.payload.reviewer === "string") {
        const at = badReviewers.indexOf(e.payload.reviewer);
        if (at >= 0) badReviewers.splice(at, 1);
      }
    };
    // Keep the measured siblings, including a red judge, while replacing only a missing review.
    // Every seat that returned no verdict is excluded for this task — a launch failure for this round only,
    // after its one bounded relaunch — and a retired seat for the run, so the loop is bounded by the eligible pool.
    const runReviewRecovery = async (task: Task, ctx: GateContext, allowSelection = true) => {
      ctx.authorizeInfraRetry = cfg.executionPolicy?.boundedInfrastructure
        ? (subject, cause) => reserveInfrastructureRetry(journal.read(), task.id, subject, journal.append.bind(journal), cause) : undefined;
      if (repairSelection && allowSelection) {
        const decision = repairSelectionDecision(journal.read(), task.id, true);
        ctx.selectTests = decision.selectTests;
        ctx.requiredRepairTests = decision.requiredFiles;
        ctx.selectionReason = decision.reason;
      } else if (repairSelection) {
        // A recheck runs the full suite; its recorded scope keeps a red there attributable.
        ctx.selectTests = false;
        ctx.selectionReason = "recheck-full-suite";
      }
      // OBS-1151: every round judges fresh; the journal's earlier judgments (this run and before a
      // resume) are only the subjects a reversed ruling is compared against.
      ctx.priorJudgments = priorJudgments(journal.read(), task.id);
      // Resume and ordinary verification share this boundary. Count persisted rounds so a
      // resumed daemon cannot reuse a previous round's identity within the same attempt.
      ctx.buildReceiptIdentity = {
        runId, taskId: task.id, attempt: gateSubject?.attempt ?? 0,
        gateRound: journal.read().filter((row) => row.taskId === task.id
          && row.event === "phase-start" && row.data.phase === "gates").length,
      };
      roundTimeouts = [];
      // v2.6.8 T1: the same-seat launch retries this candidate already spent, replayed from the journal so
      // a recovery round, a recheck or a resume never re-grants one (and never turns one into a strike).
      const launchRetried = () => journal.read().filter((row) => row.taskId === task.id && row.event === "review-infra-retry"
        && row.data.sameSeat === true && row.data.commit === gateSubject?.commit && typeof row.data.reviewer === "string")
        .map((row) => row.data.reviewer as string);
      // C: every gate-round boundary — a returned or a THROWN round — publishes the one row held behind
      // a still-pending sibling and forgets the pending set, before any park or task-failed row lands.
      // v2.6.8 T1: a review result whose recovery pool is retired-only is classified BEFORE it is published
      // (retiredOnly), and the round returns that same parked result, so the journal row and the result the
      // park reads state one outcome — an infrastructure no-verdict, never a failed review.
      const gateRound = async (subject: Task) => {
        const parked = new Map<GateResult, GateResult>();
        try {
          const done = await runGates(subject, { ...ctx, excludeReviewers: [...badReviewers, ...roundTimeouts], launchRetried: launchRetried(),
            onGate: async (e) => {
              const park = e.phase === "end" && e.gate === "review" ? retiredOnly(e.result) : undefined;
              if (park === undefined || e.phase !== "end") return ctx.onGate?.(e);
              parked.set(e.result, park);
              return ctx.onGate?.({ ...e, result: park });
            } });
          return { ...done, results: done.results.map((g) => parked.get(g) ?? g) };
        } finally {
          settleParallelRound();
        }
      };
      // The recovery pick carries every preserved author, exactly as reviewGate's own pick does.
      const authors = ctx.carriedAuthors?.length ? [...ctx.carriedAuthors] : [channelKey(ctx.author)];
      // Recovery must honor the gate's floor, including the seats that just failed to
      // return a verdict; a below-floor alternative cannot replace the infra result. This round's
      // launch failures count too — runGates folds every excluded seat into its own floor.
      const pick = (exclude: string[]) => pickReviewer(ctx.author, ctx.channels, exclude, cfg.review.prefer ?? [],
        gateReviewerFloor(task, ctx.cfg, ctx.author, ctx.channels, [...(ctx.priorReviewers ?? []), ...badReviewers, ...roundTimeouts]).floor,
        reviewHistory, undefined, demotedReviewers, carriedAuthorVendors(ctx.channels, authors), authors);
      // v2.6.8 T1: soft preference is not retirement. demotedReviewers — live or replayed on resume — only
      // ranks a seat last, so a once-demoted seat stays seatable; a seat two REAL no-verdict strikes retired
      // is out for the run, so every recovery pick excludes it outright — prefer and history can never
      // resurrect it, and runGates would refuse it anyway. A launch failure is neither: it buys one bounded
      // same-seat relaunch per candidate (launchRetried) and then leaves the seat out of THIS round only.
      const retiredSeats = () => [...reviewNoVerdicts].filter(([, causes]) => causes.length >= 2).map(([seat]) => seat);
      // The retired-only recovery park: when retirement is what empties the pool (the pick without the
      // retired exclusion would seat a retired seat), record the seat the pool cannot seat and why, buy
      // no dispatch, and park infrastructure naming it out for the run — never a soft-ranked pick that
      // dispatches it again, never a gate-fail. The tally is seeded from the journal, so every resume
      // or recheck replays this same row and park, whether its round dispatched a seat or found none.
      // It is decided where the review result is published (gateRound): a round that found no eligible
      // reviewer, or a no-verdict no recovery pick can replace — and once more after the round,
      // should another task retire a seat in between. The parked result is the same no-verdict shape every
      // review.ts no-verdict has: in memory `pass: false` (GateResult.pass is a boolean, and an unreviewed
      // candidate fails closed — it never merges), `noVerdict` + `infra`; the gate-result row written for a
      // noVerdict review below drops `pass` and adds `skipped`, so outcome readers, round budgets and
      // failure counters read one infrastructure outcome, and the infra park — not the gate-fail one — is
      // what the task gets.
      const retiredOnly = (r: GateResult): GateResult | undefined => {
        if (r.meta?.cannotSeat !== undefined || (r.meta?.noEligibleReviewer !== true && (r.meta?.noVerdict !== true
          || pick([...badReviewers, ...roundTimeouts, ...retiredSeats()])))) return undefined;
        const retired = retiredSeats();
        const blocked = pick([...badReviewers, ...roundTimeouts].filter((seat) => !retired.includes(seat)));
        if (!blocked || !retired.includes(channelKey(blocked))) return undefined;
        const seat = channelKey(blocked);
        const causes = reviewNoVerdicts.get(seat) ?? [];
        journal.append("review-infra-retry", t.id, { reviewer: seat, cause: "retired", cannotSeat: true, causes });
        const { noEligibleReviewer: _none, ...meta } = r.meta ?? {};
        return { ...r, pass: false, meta: { cause: "retired", ...meta, noVerdict: true, cannotSeat: seat, infra: true, classification: "infra" },
          details: `${r.details}\nreview recovery cannot seat ${seat}: two real no-verdicts (${causes.join(", ")}) retired it — it is out for the run, and no other eligible seat remains` };
      };
      const round = await gateRound(task);
      let review = round.results.find((g) => g.gate === "review");
      while (review?.meta?.noVerdict === true && review.meta.cannotSeat === undefined) {
        const next = pick([...badReviewers, ...roundTimeouts, ...retiredSeats()]);
        if (!next) {
          const parked = retiredOnly(review);
          if (parked) round.results = round.results.map((g) => g === review ? parked : g);
          break;
        }
        journal.append("review-infra-retry", t.id, { reviewer: channelKey(next), cause: review.meta.cause });
        const retried = await gateRound({ ...task, gates: ["review"] });
        const replacement = retried.results.find((g) => g.gate === "review");
        // A dirty tree or another pre-dispatch refusal must still fail closed.
        if (!replacement) {
          round.results.push(...retried.results.filter((g) => !gateSatisfied(g)));
          break;
        }
        round.results = round.results.map((g) => g.gate === "review" ? replacement : g);
        review = replacement;
      }
      return round;
    };
    // v1.70 T5 (review-convergence): failed review rounds this task has drawn, counted from the per-task
    // review history already in the journal — the SAME review gate-result stream onGate reads to grow the
    // reviewer-exclusion list (badReviewers), never a second parallel counter. OBS-189: scoped to the
    // current engagement — an operator approval (uphold or accept) resets the round budget, so an upheld
    // task can dispatch its funded attempt instead of re-parking against the whole journal's history.
    const reviewRoundsDrawn = () => reviewRoundsSinceApproval(journal.read(), t.id, decisiveReviewRounds);
    // OBS-193: journal the in-gate review retry (mirrors judge-retry) and exclude the flaked seat from
    // later attempts' reviewer picks. One helper, called from both onGate sites (satisfied-gate + main).
    const noteReviewRetry = (g: GateResult) => {
      const rr = g.meta?.reviewRetry as { flaked?: unknown; retried?: unknown } | undefined;
      if (g.gate === "review" && rr && typeof rr.flaked === "string" && typeof rr.retried === "string") {
        journal.append("review-retry", t.id, {
          gate: "review", flaked: rr.flaked, retried: rr.retried,
          ...(g.meta?.unparseable === true ? { secondUnparseable: true } : {}),
        });
        // v2.6.8 T1: a seat re-routed after a launch failure is excluded for this round only.
        if (!roundTimeouts.includes(rr.flaked)) badReviewers.push(rr.flaked);
      }
    };
    // v1.85 T3 (ruling R4): every BLOCKING review/judge result lands its findings in the journal
    // structured — class + canonical path + stable symbol — so a retry, a consult or an auto-uphold
    // decision reads identity instead of re-parsing prose, and line-number churn is not a new finding.
    // One helper, both onGate sites (satisfied-gate resume + main attempt loop).
    // `journaledGates` narrows replayMeasurement to the gates an interrupted round already journaled (C).
    let gateSubject: { commit: string; attempt: number; replayMeasurement?: true; journaledGates?: readonly string[]; replayedFromAttempt?: number } | undefined;
    const journalGateResult = (g: GateResult) => {
      const blocking = g.meta?.infra !== true && gateFailed(g) && (g.gate === "review" || g.gate === "acceptance");
      // T2: a review that PASSED while DEFERRING a concern still recorded a defect — the prompt
      // promises the deferral is recorded and never dropped, and a details string is not a record a
      // later round can match. The blocking projection above is the only writer of structured
      // findings today, so on this row it writes nothing and every structured reader goes blind.
      // Same shape, same identity, on the passing row: the verdict is untouched (`pass` stays true),
      // only the projection widens to the rows the reviewer itself classified as deferred.
      const deferred = !blocking && g.gate === "review" && g.pass === true
        ? deferredReviewFindings(g.details)
        : [];
      // R3 (OBS-186): a gate that DECLINED has no verdict to state, and this row is the ONE seam every
      // fold outside this file shares. Writing `pass: false` for a decline is what turned a skip into
      // a failure at all of them at once — the engagement round budget (reviewRoundsSinceApproval,
      // journal.ts), the operator's failed-gate list (cli/commands/approve.ts), the record's
      // gate-failure total (cli/commands/report.ts), the cockpit's gate rows (tui/cockpit/derive.ts).
      // Each keys on `pass === false`; none of them is reachable from this task's file scope, and
      // patching five copies of the same question would be the wrong fix even if they were. So the
      // ledger simply does not claim a verdict it does not have.
      // The legacy baseline declines (a build command the repo never configured) have always written
      // `pass: true` beside `skipped: true` and every consumer already reads them right, so their row
      // is untouched: only a decline that would otherwise be recorded RED changes shape here.
      // A no-verdict review is journaled `infra` + `skipped` with NO `pass`: the canonical reader
      // (outcome.ts) files it as infra regardless, the `pass === false` readers (rounds, briefs,
      // park kind) never charge it, and outstandingReviewFindings (journal.ts:816) skips a `skipped`
      // row instead of reading a missing `pass` as a PASS that settles every open blocking finding.
      const noVerdictReview = g.gate === "review" && g.meta?.noVerdict === true;
      const unverdicted = (g.meta?.skipped === true && !g.pass) || noVerdictReview;
      journal.append("gate-result", t.id, {
        gate: g.gate, ...(unverdicted ? {} : { pass: g.pass }), details: g.details,
        // R41: the protocol + effective lifecycle policy the gate MEASURED under, stamped by run-gates
        // for the worktree it ran in; absent only for a row that never went through the battery.
        ...(g.meta?.verification !== undefined ? { verification: g.meta.verification } : {}),
        ...(gateSubject ? { commit: gateSubject.commit, attempt: gateSubject.attempt } : {}),
        ...(gateSubject?.replayMeasurement && (gateSubject.journaledGates?.includes(g.gate) ?? true) ? { replayMeasurement: true } : {}),
        ...(gateSubject?.replayedFromAttempt !== undefined ? { replayedFromAttempt: gateSubject.replayedFromAttempt } : {}),
        ...(g.meta?.skipped === true || noVerdictReview ? { skipped: true } : {}),
        // T9: an infra-only exit is journaled AS one. The operator reading a red `test` row has to
        // be able to tell "the suite found a defect" from "the runner never ran", and the merge
        // predicate's reason for refusing has to be legible in the ledger it refused from.
        ...(g.meta?.infra === true ? { infra: true } : {}),
        // OBS-1030: a dirty-tree refusal names its litter, its culprit command and the recovery ref ON
        // THE ROW — the ledger is where an operator looks for the ref before a recheck, not the prose.
        ...(g.meta?.dirtyWorktree === true ? {
          dirtyWorktree: true, dirtyPaths: g.meta.paths,
          ...(typeof g.meta.culprit === "string" ? { culprit: g.meta.culprit } : {}),
          ...(typeof g.meta.preservedRef === "string" ? { preservedRef: g.meta.preservedRef } : {}),
          ...(typeof g.meta.producer === "string" ? { producer: g.meta.producer } : {}),
          ...(typeof g.meta.producerAttempt === "number" ? { producerAttempt: g.meta.producerAttempt } : {}),
        } : {}),
        ...((cfg.executionPolicy || repairSelection) && !g.pass ? { disposition: failureDisposition(g) } : {}),
        ...Object.fromEntries(["runnerInfraRerun", "hostStarvedRerun", "recoveryBlocked", "failingFiles", "selectionDecision", "failureEvidence",
          "forgivenFingerprints", "freshFingerprints", "baselineProvenance", "judgment", "adjudication", "judgeDisagreement", "interruptions"]
          .filter((key) => g.meta?.[key] !== undefined).map((key) => [key, g.meta![key]])),
        // OBS-540: preserve terminal-vs-retryable infra exactly. normalizeGateOutcome deliberately
        // defaults a legacy infra row to retryable, so dropping an explicit false here reverses the
        // oracle's recorded verdict when any journal-backed reader reconstructs it.
        ...(g.meta?.infra === true && typeof g.meta.retryable === "boolean"
          ? { retryable: g.meta.retryable }
          : {}),
        // R3 (OBS-186): a declined review is journal truth, not an absence. `skipped: true` alone
        // says a gate did not run; these say WHICH policy declined it and WHY, so a reader of the
        // ledger never has to infer participation from a details string. The green-skip branch that
        // made this row indistinguishable from a pass is gone (src/gates/review.ts).
        ...(g.meta?.verdict === "skipped"
          ? { verdict: "skipped", policy: g.meta.policy, reason: g.meta.reason }
          : {}),
        // T4 (OBS-265): a test verdict says WHICH suite spoke. A round runs the selected subset as a
        // screen and the full suite as the verdict, so without these two the journal would carry a
        // `test` row whose scope no consumer could recover.
        ...(Array.isArray(g.meta?.selectedTests) ? { selectedTests: g.meta.selectedTests } : {}),
        ...(g.meta?.fullSuite === true ? { fullSuite: true } : {}),
        ...(g.meta?.reapedGroup === true ? { reapedGroup: true } : {}),
        ...(g.gate === "review" && g.meta?.noEligibleReviewer === true ? {
          noEligibleReviewer: true, authorVendors: g.meta.authorVendors, unresolvedAuthors: g.meta.unresolvedAuthors,
        } : {}),
        ...(g.gate === "review" && typeof g.meta?.reviewer === "string" ? {
          reviewer: g.meta.reviewer,
          ...Object.fromEntries(["cause", "seatAuthoredBytes", "bytes", "rawPath", "briefPath", "timeoutMs", "unparseable", "noVerdict", "resolved", "reraised", "settledAnchors", "reviewerFloor", "reviewerFloorCause", "reviewerTier"]
            .filter((key) => g.meta?.[key] !== undefined).map((key) => [key, g.meta![key]])),
          ...(typeof g.meta.vendor === "string" ? { vendor: g.meta.vendor } : {}),
          ...(typeof g.meta.provider === "string" ? { provider: g.meta.provider } : {}),
          ...(typeof g.meta.rotationSeat === "number" ? { rotationSeat: g.meta.rotationSeat } : {}),
          ...(typeof g.meta.timeoutMs === "number" ? { timeoutMs: g.meta.timeoutMs } : {}),
        } : {}),
        // A finding's path is its own evidence path. Do not pass task scope here: a declaration says
        // where work is allowed, not where this verdict found the defect.
        ...(blocking ? {
          taskContentDigest: contentDigest,
          findings: Array.isArray(g.meta?.findings) ? g.meta.findings : structuredFindings(g.gate, g.details),
        } : deferred.length > 0 ? {
          taskContentDigest: contentDigest,
          findings: deferred,
        } : {}),
        // v2.0 T2 (OBS-554): the gate's OWN measurement, lifted verbatim from the meta run-gates
        // stamped WHERE THE GATE RAN. Nothing here re-derives a duration by subtracting journal
        // timestamps — that would measure this row's queue as well as its work. It rides the
        // gate-result row itself because that IS the row a recalibration reads: a measurement kept
        // in a side stream is one join away from the verdict it explains, and the two can drift.
        // A gate run-gates did not measure contributes NO field rather than a fabricated zero — for
        // every recalibration this telemetry funds, a gap is honest and a zero is a lie. The
        // seven-gate closed set is asserted end-to-end in tests/run/gate-telemetry.test.ts.
        ...gateMeasurement(g.meta),
        // Carried receipts retain their original invocation and artifact root.
        ...(g.evidenceReceipt ? { evidenceReceipt: g.evidenceReceipt } : {}),
        ...(g.evidenceReceipts ? { evidenceReceipts: g.evidenceReceipts } : {}),
        ...(g.meta?.reused ? {
          reused: true,
          ...(g.originRunRoot ? { originRunRoot: g.originRunRoot } : {}),
        } : Object.fromEntries(["nonce", "stdoutPath", "stderrPath", "classification"]
          .filter(key => g.meta?.[key] !== undefined).map(key => [key, g.meta![key]]))),
        // T7: the capacity the gate's own command child ran under, lifted verbatim from the result
        // the battery produced — read where the shell built that child's environment, never
        // re-derived from the run's own budget, which would answer a different number than the
        // operator's export did. It is this row's only COMPARABLE identity: the load samples describe
        // contention while capacity describes how the command divided the machine, and matching
        // capacity never claims the machine was calm. A gate that ran
        // no command carries nothing — it divided nothing.
        //
        // `dirtiedBy` is the one hole in that lift: run-gates REPLACES a green battery verdict with
        // a refusal when the command left the worktree dirty (run-gates.ts, three sites: the legacy
        // batch, the per-command loop and the merge-candidate full suite), and the refusal is a
        // fresh verdict object carrying nothing off the result it replaced. That command's child DID
        // run, so its row still owes the world it ran in. the active round capacity is that world and not a
        // re-derivation of it: it applies the same precedence `shell` does — an operator export
        // first — and was read inside the same fork budget every gate child of this run is spawned
        // under, so it is by construction the number that child received. The flag is set only where
        // a command of THIS gate ran and dirtied the tree, so the round-entry refusal (no command
        // ran) and the round-end withdrawal (lands on a gate that runs no command) still carry
        // nothing.
        ...(g.capacity ? { capacity: g.capacity }
          : g.meta?.dirtiedBy === g.gate ? { capacity: resolvedCapacity() } : {}),
      });
    };
    // R3 (OBS-186): judge ‖ review are launched together and publish in COMPLETION order
    // (run-gates.ts) — a race. Three oracles assert the opposite: a scripted run's journal is
    // byte-identical run to run (tests/run/narration.test.ts, tests/run/notify-identity.test.ts), and
    // a round's gate-result order matches its phase-start order (tests/run/daemon.test.ts). Retiring
    // complexityThreshold is what REACHES this, not what introduces it: those fixtures used to skip
    // review and journal ONE verdict row per round, so the pair's order was never exercised — and the
    // operator's config has run `complexityThreshold: 0` since 2026-07-31, so production rounds have
    // journaled both siblings all along.
    //
    // Ordering is the LEDGER's job, not the pipeline's. run-gates still reports each completion the
    // instant it happens; the daemon writes its ledger in GATE_NAMES order. Only the LATER gate is
    // ever held, and only while an earlier sibling is still in flight — a review that finishes first
    // waits for acceptance, never the reverse. That keeps T4's durability where it pays (the first
    // verdict to land is still published immediately) and bounds the exposure to one row for the
    // remainder of one already-running gate. A gate that THROWS still ends its round: C publishes the
    // row held behind it at that boundary (settleParallelRound), so it is never lost or carried over.
    const parallelPending = new Set<GateName>();
    let heldParallel: (() => void) | undefined;
    const settleParallelRound = () => {
      parallelPending.clear();
      const held = heldParallel;
      heldParallel = undefined;
      if (liveEngagement()) held?.();
    };
    const notePhaseStart = (e: Extract<GateEvent, { phase: "start" }>) => {
      const active = activeGatePhases.get(t.id) ?? new Set<GateName>();
      active.add(e.gate);
      activeGatePhases.set(t.id, active);
      if (e.parentAt !== undefined) parallelPending.add(e.gate);
    };
    const inParallelOrder = (gate: GateName, publish: () => void) => {
      parallelPending.delete(gate);
      const rank = GATE_NAMES.indexOf(gate);
      if ([...parallelPending].some((p) => GATE_NAMES.indexOf(p) < rank)) {
        heldParallel = publish;
        return;
      }
      publish();
      const held = heldParallel;
      heldParallel = undefined;
      held?.();
    };
    // OBS-189: the operator upheld the reviewer — the findings ARE the brief for this funded attempt.
    // OBS-254: RE-DERIVED from the journal here, at prompt-build time, rather than trusted to survive
    // in resume state. The journal already holds the upheld review's bytes; no reset of attempt or
    // channel state can take them away, on any path, including `resume --retry-failed`.
    const upheldFeedback = upheldFeedbackByTask(effectiveEvents(journal.read())).get(t.id) ?? rs?.upheldFeedback; // OBS-1178: a refused uphold funds no brief
    const carriedEvidence = priorRunEvidence.findings
      .filter((finding) => finding.taskId === t.id)
      .map(formatPriorFindingEvidence)
      .join("\n\n");
    const withCarriedEvidence = (brief: string): string => {
      if (!carriedEvidence || brief.includes(carriedEvidence)) return brief;
      return brief ? `${brief}\n\n${carriedEvidence}` : carriedEvidence;
    };
    let feedback = withCarriedEvidence(upheldFeedback
      ? `The operator UPHELD the reviewer's findings — address them without discarding landed work.\nreview: ${upheldFeedback}`
      : "");
    let ladderIdx = 0;
    const engagementRows = () => {
      const rows = effectiveEvents(journal.read()).filter((e) => e.taskId === t.id);
      const approval = rows.map((e) => e.event).lastIndexOf("task-approved");
      return rows.slice(approval + 1);
    };
    let ownedGateFailures = engagementRows().filter((e) => e.event === "escalation" && e.data.workerAttributed === true).length;
    let climbProvenance = !hintsChanged && priorClimb
      ? `tier-escalated ${priorClimb.data.from} → ${priorClimb.data.to} (${priorClimb.data.cause})` : "";
    const climbSkips = new Set<string>(!hintsChanged && priorClimb
      ? channels.filter((c) => c.tier === priorClimb.data.fromTier).map(channelKey) : []);
    const climb = async (cause: string, gate: GateResult, attempt: number): Promise<"climbed" | "parked" | undefined> => {
      if (cfg.routing.escalateTier === "off" || engagementRows().some((e) => e.event === "tier-escalated")) return;
      const pin = t.routingHints?.pin;
      if (pin) {
        await park(t, `pin ${pin.via}:${pin.model} held: ${cause}`, "gate-fail", assignment, attempt,
          startMs, gateFails, consults, tokens, metered, retryMode);
        return "parked";
      }
      const next = climbChannel(assignment, t, cfg, channels, tried, profile, demotedChannels);
      if (!next?.climbed) return;
      const from = channelKey(assignment);
      const to = channelKey(next);
      const poolBefore = channels.filter((c) => !tried.includes(channelKey(c)) && !demotedChannels.has(channelKey(c))
        && inTaskPool(t, cfg, channelKey(c))).map(channelKey);
      journal.append("tier-escalated", t.id, {
        attempt, cause, gate: gate.gate, fingerprint: normalizeGateFailure(gate.details).slice(0, 500),
        from, to, fromTier: assignment.tier, toTier: next.tier, poolBefore,
        costDelta: marginalCostRank(channels.find((c) => channelKey(c) === to)!) - marginalCostRank(channels.find((c) => channelKey(c) === from)!),
      });
      for (const c of channels) if (c.tier === assignment.tier && channelKey(c) !== to) climbSkips.add(channelKey(c));
      climbProvenance = `tier-escalated ${from} → ${to} (${cause})`;
      assignment = seatAssignment(next);
      tried.push(to);
      return "climbed";
    };
    let modeFallbackNoted = false; // v1.2: journal the interactive→print fallback once per task, not per attempt
    let gateFails = 0; // TEL-02: incremented ONLY where feedback is built from failing gates — never derived from attempts (quota failovers bump attempts too, Pitfall 6)
    let consults = 0; // TEL-02: bumped in the runConsult wrapper so one counter covers all three trigger sites, across the attempt loop
    let tokens: TokenUsage | undefined; // SPEND-02: accumulated across attempts — parked spend is still spend
    let metered = 0; // SPEND-02: attempts that returned a usage record; distinguishes unmetered from measured-zero
    let tipMoves = 0; // OBS-15: one re-gate allowance per task, never reset by a worker retry
    // T4 (OBS-265): a task whose test gate has failed once stops selecting tests for good — the
    // selector already proved it cannot speak for this diff, so every later round runs full. SEEDED
    // FROM THE JOURNAL, not from process memory: a park, a `resume`, or a daemon restart must not
    // hand the selector a clean slate it did not earn, and the journal is the only state that
    // survives all three (same read as upheldFeedbackByTask above).
    let testGateFailed = journal.read().some((e) =>
      e.event === "gate-result" && e.taskId === t.id && e.data.gate === "test" && e.data.pass === false
      && !(cfg.executionPolicy?.boundedInfrastructure && e.data.disposition === "infrastructure"));
    let retryMode: RetryMode = "fresh";
    // v2.6.6 A: the ONE post-result settlement both gate loops call. Order is the contract:
    // satisfied → merge (tip-moved once regates, twice parks; a conflict goes back to the caller), else
    // noEligible → infra → diff-cap → adjudication → outside-scope → disposition, and whatever survives
    // is the caller's "red". Every declared resume/live difference arrives as a parameter; nothing here
    // normalizes one. Preparation, replay, conflict handling, repair funding, feedback and cleanup stay
    // in the callers.
    const settleResults = async (results: GateResult[], p: {
      wt: string; taskBase: string; taskBranch: string; gated: string; commit: string; outsideScopeForced: boolean;
      author: Assignment; attempts: number; infraReason: (g: GateResult) => string;
      reobserve: { attempt: number; replayed: boolean };
      disposition: () => { author: Assignment; attempt: number };
      beforeMerge?: () => void; firstAttemptOk: boolean;
      metering: { tokens?: TokenUsage | undefined; meteredAttempts?: number | undefined };
    }): Promise<{ kind: "merged" | "regate" | "parked" | "red" } | { kind: "conflict"; conflict: string | undefined }> => {
      const parkAs = (reason: string, kind: ParkKind) =>
        park(t, reason, kind, p.author, p.attempts, startMs, gateFails, consults, tokens, metered, retryMode);
      if (results.every(gateSatisfied)) {
        p.beforeMerge?.();
        const m = await mergeSerial(p.taskBranch, t, p.gated);
        if (m.tipMoved) {
          journal.append("tip-moved", t.id, m.tipMoved);
          if (tipMoves++ === 0) return { kind: "regate" };
          await parkAs("task branch tip moved twice after gating", "tip-moved");
          return { kind: "parked" };
        }
        if (!m.ok) {
          journal.append("merge-conflict", t.id, { conflict: m.conflict });
          return { kind: "conflict", conflict: m.conflict };
        }
        graph = setStatus(graph, t.id, "done");
        saveGraph(repoRoot, graph);
        journal.append("task-done", t.id, {
          attempts: p.attempts, assignment: p.author, taskContentDigest: contentDigest,
          authors: mergedAuthors(await subjectAuthors(journal.read(), t.id, p.wt, p.taskBase)),
        });
        journal.append("merge", t.id, { branch: p.taskBranch, commit: await integrationHead(intWt) });
        await trackedDriver.project?.(t.id, "completed");
        // firstAttemptOk/gateFails/consults are recorded FACTS, not policy — a parkKind:"stall" row is
        // recorded but NOT quality-negative in v1.6; Phase 12 owns reward policy, so flipping it later needs zero data migration.
        journal.telemetry({
          taskId: t.id, shape: t.shape, adapter: p.author.adapter, model: p.author.model,
          channel: p.author.channel, attempts: p.attempts, outcome: "done",
          durationMs: Date.now() - startMs, firstAttemptOk: p.firstAttemptOk, gateFails, consults, ...p.metering, retryMode,
        });
        return { kind: "merged" };
      }
      // OBS-540: infra is a fail-closed NON-verdict, not quality degradation. Park with the blocker
      // already journaled by onGate, before gateFails and before any ladder selection can fund an
      // identical retry in the same environment. Parsed judge refusals never carry infra and keep
      // flowing through the chargeable quality path below.
      const unavailableReview = results.find((g) => gateFailed(g) && g.meta?.noEligibleReviewer === true);
      if (unavailableReview) {
        await parkAs(gateFailApprovalReason(t.id, unavailableReview.details, true), "gate-fail");
        return { kind: "parked" };
      }
      // OBS-1106: same predicate as classification — an infra replay is parked, never repaired.
      const infra = results.find((g) => gateFailed(g) && isInfraResult(g));
      if (infra) {
        await parkAs(p.infraReason(infra), "infra");
        return { kind: "parked" };
      }
      // OBS-1007: a cap trip is a typed park of its own — the diff cannot shrink by retrying and the
      // only honest verb is a recheck under a raised cap. Decided BEFORE the authoring classifier, which
      // used to lift `gates.diffCap` out of the cap prose as a files[] hint.
      const capTrip = results.find(isDiffCapPark);
      if (capTrip) {
        await parkAs(`${capTrip.gate}: ${capTrip.details}`, "diff-cap");
        return { kind: "parked" };
      }
      if (await adjudicateInfraShapedRed(t, results, p.wt, p.commit, p.reobserve.attempt, p.reobserve.replayed,
        (reason) => parkAs(reason, "infra"))) return { kind: "parked" };
      if (p.outsideScopeForced && freshOutsideScopeRed(t, p.commit)) {
        await parkAs(outsideScopePark(t), "gate-fail");
        return { kind: "parked" };
      }
      // OBS-547: who pays for this red is decided by the run's collateral prediction (see
      // dispositionScopeRed) — an authoring defect parks unchargeable before any accounting below.
      const d = p.disposition();
      if (await dispositionScopeRed(t, results, d.author, d.attempt, startMs, gateFails, consults, tokens, metered,
        retryMode, await treeOrDiffPaths(p.taskBase, p.wt))) return { kind: "parked" };
      return { kind: "red" };
    };
    let lastContextTokens: number | undefined; // v1.23 reset signal, including stalled/quota attempts
    // v1.29: only a gate-failed attempt can seed same-session retry. The next attempt consumes this
    // once; a changed channel, unknown context, or missing resumeCommand falls back to fresh.
    let retrySession: { channel: string; id: string; contextTokens?: number } | undefined;

    // ROUTE-13: learned within-band failover + deviation audit. nextChannel stays pure (route/ never
    // journals); the daemon compares the learned pick against the static pick and owns the journal write.
    const failover = (site: "consult-reroute" | "quota-failover" | "capacity-failover" | "bootstrap-failover" | "dead-channel" | "escalate"): Assignment | null => {
      const next = nextChannel(assignment, t, cfg, channels, tried, profile, demotedChannels);
      if (profile && next) {
        const staticNext = nextChannel(assignment, t, cfg, channels, tried, undefined, demotedChannels);
        if (staticNext && channelKey(next) !== channelKey(staticNext)) {
          journal.append("failover-deviation", t.id, { site, static: channelKey(staticNext), chosen: channelKey(next) });
        }
      }
      return next;
    };

    // OBS-1161: capacity requeues (OBS-1169: and bootstrap retries) spent on a seat for this task since
    // its last operator release — journal-derived so the budget survives a resume instead of restarting.
    const requeuesOn = (event: "capacity-requeue" | "bootstrap-retry", channel: string): number => {
      const rows = effectiveEvents(journal.read()).filter((e) => e.taskId === t.id);
      const since = rows.map((e) => e.event).lastIndexOf("task-approved");
      return rows.slice(since + 1).filter((e) => e.event === event && e.data.channel === channel).length;
    };

    // OBS-202 (operator law: "you can spawn as many as you want"): channels are session FACTORIES,
    // not consumed seats — a tried channel can always host a fresh worker session, and a fresh
    // session carries none of the failed attempt's baggage. When the untried pool is empty, recycle
    // the best LIVE channel (preferring a different seat than the current one) instead of parking
    // on artificial scarcity; MAX_ATTEMPTS and the review round cap are the real bounds. Only a
    // fleet whose every channel is DEMOTED (verified dead: auth/setup/provider outage) has nothing
    // left to spawn — that case alone still parks.
    // OBS-1187: shared with the demotion seam's pooled recycle so neither relaunches an escalated adapter.
    const recycleExcluded = (): string[] =>
      [channelKey(assignment), ...channels.filter((c) => escalatedAdapters.has(c.adapter)).map(channelKey)];
    const failoverOrRecycle = (site: "consult-reroute" | "dead-channel"): Assignment | null => {
      const next = failover(site);
      if (next) return next;
      // OBS-1169: a vendor escalated away from stays out of the recycle pool until its release —
      // recycling any of its channels, launched or not, would launch the broken bootstrap again.
      const recycled = nextChannel(assignment, t, cfg, channels, recycleExcluded(), profile, demotedChannels)
        ?? (demotedChannels.has(channelKey(assignment)) ? null : assignment);
      if (recycled) journal.append("channel-recycle", t.id, { site, channel: channelKey(recycled) });
      return recycled;
    };

    const runConsult = async (trigger: string, transcript: string, diffOrFeedback: string, gates: GateResult[]): Promise<ConsultVerdict> => {
      consults++;
      // OBS-1182: every launched consult seat, failed ones included, rides the verdict into the journal.
      const invocations: ConsultInvocation[] = [];
      const v = await consult(
        {
          taskId: t.id, trigger,
          journalTail: JSON.stringify(journal.read().slice(-20)),
          transcript: transcript.slice(-8000),
          diff: diffOrFeedback, gates,
        },
        cfg, adapters, trackedDriver, repoRoot, journal.dir,
        // D-07: consult panes self-clean when the verdict is read (keepLlm) — only "forever" keeps them.
        // v1.54 T1: channels = this run's doctor-filtered live list — consult.prefer seat liveness
        // is judged against it, never rebuilt from config (installed-but-unauthed seats would stall).
        { keep: keepLlm, onSlot: keepLlm ? (s: Slot) => keptSlots.push(s) : undefined, onInvocation: (inv) => invocations.push(inv), runId, channels: pools.consult, health },
      );
      // A lone answering seat is already the row's adapter/model/vendor/effort; the list is journaled
      // only when a seat failed, so the row never repeats itself and a failed seat never vanishes.
      return invocations.some((inv) => inv.outcome === "failed") ? { ...v, invocations } : v;
    };

    // returns true → continue attempting, false → task is terminal (parked)
    // trigger (why the consult ran) is threaded in so the decompose/human park keeps its cause —
    // rows 6/10/11 of the mapping (gate-fail vs stall vs merge-conflict) would otherwise conflate.
    const applyVerdict = async (v: ConsultVerdict, attempts: number, trigger: ParkKind): Promise<boolean> => {
      journal.append("consult-verdict", t.id, {
        action: v.action, notes: v.notes,
        adapter: v.adapter ?? "unknown", model: v.model ?? "unknown", vendor: v.vendor ?? "unknown",
        ...(v.effort ? { effort: v.effort } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
        ...(v.guidance ? { guidance: v.guidance } : {}),
        ...(v.excludeAdapter ? { excludeAdapter: v.excludeAdapter } : {}),
        ...(v.invocations?.length ? { invocations: v.invocations } : {}),
      });
      await driver.notify(`tickmarkr ${runId}: ${t.id} consult verdict: ${v.action}`, { tier: "attention" });
      if (v.action === "retry") {
        // The guidance is ADDED to the brief, never swapped for it: the failure bytes the journal
        // already holds are the one thing the next attempt cannot rediscover for free. The
        // fingerprint cap's ban on an identical retry is NOT enforced here — a verdict is only one
        // of several ways this task reaches a re-dispatch, so the ban is enforced at the dispatch
        // seam every one of them passes through (see enforceRetryBan).
        const guidance = renderRetryGuidance(v);
        if (guidance && !feedback.includes(guidance)) feedback = feedback ? `${feedback}\n\n${guidance}` : guidance;
        return true;
      }
      if (v.action === "reroute") {
        // OBS-20 / v1.24 T1: adapter-scoped exclusion for environmental CLI failures. Expand the
        // task-local tried list with every available channel of the named adapter, then reuse
        // nextChannel's existing tried parameter — zero router changes (D-03). Unknown adapter
        // (zero matches) is a no-op expansion ⇒ ordinary channel-level reroute. Task-scoped:
        // `tried` lives inside execTask, so a sibling task is unaffected.
        if (v.excludeAdapter) escalateAdapter(v.excludeAdapter, `vendor escalated: consult excluded ${v.excludeAdapter}`);
        const next = failoverOrRecycle("consult-reroute");
        if (next) {
          assignment = next;
          const k = channelKey(next);
          if (!tried.includes(k)) tried.push(k);
          return true;
        }
        await park(t, `consult said reroute but every channel is demoted (verified dead) — nothing left to spawn${poolExhaustion(t, cfg)}`, "reroute-exhausted", assignment, attempts, startMs, gateFails, consults, tokens, metered, retryMode);
        return false;
      }
      await park(t, `consult verdict: ${v.action} — ${v.notes}`, trigger, assignment, attempts, startMs, gateFails, consults, tokens, metered, retryMode); // decompose|human
      return false;
    };

    // OBS-130/T15: both gate-resume paths consume the persisted task branch with no worker dispatch.
    // An operator approval skips its exact failed gate by authority; observed results skip only the
    // contiguous green prefix whose recorded commit is still the task branch tip.
    let satisfiedGate = satisfiedGates.get(t.id);
    const replayedGates = fundedRerun ? undefined : replayedGateResults.get(t.id);
    const recheck = approvalAction?.authority === "battery";
    // OBS-1109: finished work is harvested, never redone — on resume too. A daemon that died while its
    // worker ran leaves an owned attempt between worker-launch and worker-result: its pane may hold the
    // attempt's own nonce-bound trailer, its branch the committed work. Only after the attempt's owned
    // processes are reaped is either read as its result — a matching trailer as the worker's claim,
    // commits without one as the same no-trailer evidence the live harvest synthesizes — and the gate
    // replay below then judges it under the PRODUCING attempt's author, with no new dispatch. An
    // unfinished attempt, a pane holding another attempt's trailer, or cleanup that cannot be proven
    // is declined onto the ordinary recovery path. A harvest an earlier resume recorded is gated again,
    // never recorded twice.
    const harvestInterruptedAttempt = async (): Promise<Assignment | undefined> => {
      const found = interruptedAttempt(journal.read(), t.id);
      if (!found || (!found.launch && !found.result)) return found?.assignment;
      const { attempt } = found;
      const wt = worktreePath(repoRoot, `${branch}--${t.id}`);
      const recordHarvest = (commits: string[], finished: boolean, summary: string) =>
        journal.append("worker-result-harvested", t.id, {
          attempt, commits, summary: finished ? summary : HARVESTED_RESULT_SUMMARY, source: RESUME_HARVEST_SOURCE, trailer: finished,
        });
      // A declined attempt leaves the fold's spare (interruptedAttempt closes on this row), so its pane
      // is swept here, before the ordinary recovery path dispatches beside it — the baseline sweep, late.
      const decline = async (reason: string): Promise<undefined> => {
        journal.append("resume-harvest-declined", t.id, { attempt, reason });
        await reconcile({ spareLiveLlm: true });
        return undefined;
      };
      // Owned-process cleanup before any result is read as final: the attempt's own process group and
      // dispatch marker, reaped through the same reapWorker a live harvest uses. Uncertain is declined.
      const reapOwned = async (key: Slot, launch: NonNullable<typeof found.launch>): Promise<string | undefined> => {
        workerOwners.set(key, { taskId: t.id, attempt, groupFile: `${launch.dispatchScript}.${launch.nonce}.pgid`,
          marker: launch.dispatchScript, identities: new Map(), descendants: new Map() });
        try {
          await reapWorker(key);
          return undefined;
        } catch (error) {
          return `owned-process cleanup uncertain: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      if (found.result) {
        // A daemon recorded this attempt's result, then died before its harvest row (a live daemon
        // before its no-trailer synthesis, or a resume between its two rows): finish that record from
        // the result it wrote — the pane is never re-read, the result never rewritten. A resume wrote
        // its result only after reaping; a live daemon writes it BEFORE handling a failed reap, so its
        // owned processes are reaped again here. A result that neither finished nor left commits has
        // nothing to gate: the ordinary recovery path owns it.
        if (!found.result.reaped) {
          if (!found.launch) return decline("owned-process cleanup unproven: the launch recorded no ownership evidence");
          const uncertain = await reapOwned(found.launch.slot, found.launch);
          if (uncertain) return decline(uncertain);
        }
        const commits = existsSync(wt) ? await commitsAheadOf(await integrationHead(intWt), wt) : [];
        if (!found.result.finished && commits.length === 0) return decline("unfinished");
        recordHarvest(commits, found.result.finished, found.result.summary);
        return found.assignment;
      }
      const launch = found.launch!;
      const { nonce, slot } = launch;
      if (!existsSync(wt)) return decline("task worktree missing");
      const adapter = adapters.find((a) => a.id === found.assignment.adapter);
      if (!adapter) return decline(`adapter ${found.assignment.adapter} unavailable to read the trailer`);
      // The journaled slot is read through THIS daemon's driver, a fresh instance since the last one
      // died. A pane the driver cannot read is DECLINED, never classified: an unreadable pane proves
      // neither a matching trailer nor the absence of a foreign one, so it is neither harvested nor
      // gated as trailerless evidence. A driver whose terminals outlive it (Orca) adopts the owned
      // terminal (Orca) or pane (Herdr, OBS-1203): bound only on ownership evidence — the journaled owned
      // name AND the task checkout — never a name alone. The journaled slot.id is NEVER trusted across
      // daemon instances: a fresh driver numbers its slots from one again, so an interrupted task's old
      // id can name whatever terminal THIS instance bound under that id (another task's adoption or allocation).
      // A driver with no read-only adoption is declined BEFORE anything is bound: slot() allocates —
      // herdr's reclaims the same-named pane (closing the evidence unread) and holds a dispatch lease
      // only run() releases — so it is never an adoption fallback; that driver keeps ordinary recovery.
      if (!driver.adopt) return decline("no read-only adoption on this driver");
      let ownedSlot: Slot;
      let pane: string;
      try {
        ownedSlot = await driver.adopt(slot);
        pane = await driver.read(ownedSlot, PANE_READ_ROWS);
      } catch (error) {
        return decline(`pane unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const parsed = adapter.parse(pane, nonce);
      const finished = parsed.cause === undefined;
      const foreign = !finished && [...pane.matchAll(/TICKMARKR_RESULT_([0-9a-z]+)/g)]
        .some(([, other]) => other !== nonce && adapter.parse(pane, other!).cause === undefined);
      if (foreign) return decline("foreign-nonce");
      const taskBase = await integrationHead(intWt);
      if (!finished && (await commitsAheadOf(taskBase, wt)).length === 0) return decline("unfinished");
      const uncertain = await reapOwned(ownedSlot, launch);
      if (uncertain) return decline(uncertain);
      const commits = await commitsAheadOf(taskBase, wt); // re-measured: the reaped writer is gone now
      // The source tag makes a death between these two rows recoverable: the next resume finishes the record.
      journal.append("worker-result", t.id, {
        ok: parsed.ok, summary: parsed.summary, deviations: parsed.deviations, finished, exitCode: null, attempt,
        source: RESUME_HARVEST_SOURCE, ...(parsed.cause ? { cause: parsed.cause } : {}),
      });
      recordHarvest(commits, finished, parsed.summary);
      return found.assignment;
    };
    const harvestAuthor = rs && !satisfiedGate && !replayedGates && !recheck ? await harvestInterruptedAttempt() : undefined;
    // OBS-1202: a recheck bound to a stall park that recorded a reapFailure re-verifies the parked
    // attempt's owned census through the same reapWorker a live harvest uses, BEFORE any gate reads
    // its tree. Only a complete, empty census releases the harvested commits to the battery; an
    // unreadable (null) or surviving census keeps the task parked on the same kind — a stall carrying
    // the fresh reapFailure, bound by its own new token — and no worker is funded either way. Plain
    // approve on that park keeps its dispatch semantics.
    if (recheck) {
      const approvalRow = effectiveEvents(journal.read()).reverse()
        .find((e) => e.taskId === t.id && e.event === "task-approved" && e.data.release === RECHECK_RELEASE);
      if (typeof approvalRow?.data.reapFailure === "string") {
        const launch = [...journal.read()].reverse().find((e) => e.taskId === t.id && e.event === "worker-launch");
        const owned = launch?.data.slot as Slot | undefined;
        let uncertain: string | undefined;
        if (typeof launch?.data.nonce !== "string" || typeof launch.data.dispatchScript !== "string"
          || typeof owned?.name !== "string" || typeof owned.cwd !== "string") {
          uncertain = "the parked attempt recorded no launch ownership evidence";
        } else {
          const key: Slot = { ...owned };
          workerOwners.set(key, { taskId: t.id, attempt: Number(launch.data.attempt ?? 0),
            groupFile: `${launch.data.dispatchScript}.${launch.data.nonce}.pgid`, marker: launch.data.dispatchScript,
            identities: new Map(), descendants: new Map() });
          try {
            await reapWorker(key);
            // reapWorker returns normally for a null census when no ownership file was readable (a
            // missing .pgid/.session with no descendants); recovery needs a RECORDED empty census.
            const census = reapReports.get(key)?.survivors;
            if (!Array.isArray(census) || census.length > 0) {
              uncertain = `worker group ${reapReports.get(key)?.processGroup ?? "unknown"} census unrecorded`;
            }
          } catch (error) {
            uncertain = error instanceof Error ? error.message : String(error);
          }
        }
        if (uncertain !== undefined) {
          await park(t, `worker could not be reaped before recheck: ${uncertain}`, "stall", null,
            rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode, { reapFailure: uncertain });
          return;
        }
      }
    }
    resumeGateReplay: if (satisfiedGate || replayedGates || recheck || harvestAuthor) {
      const taskBase = await integrationHead(intWt);
      taskBases.set(t.id, taskBase);
      const taskBranch = `${branch}--${t.id}`;
      const priorWt = worktreePath(repoRoot, taskBranch);
      // OBS-1022: the ref `approve --recheck` validated (commits ahead of the base) is the tree the
      // battery gates — read from the pending approval row, never re-selected here, so the tree
      // approve counted and the tree the daemon gates are one and the same, checkout present or not.
      const preservedRef = recheck
        ? effectiveEvents(journal.read()).reverse().find((e) => e.taskId === t.id && e.event === "task-approved" && e.data.release === RECHECK_RELEASE)?.data.recheckedRef as string | undefined
        : undefined;
      if (!existsSync(priorWt) && !preservedRef) {
        if (satisfiedGate || recheck) throw new Error(`${recheck ? "recheck" : `approved gate ${satisfiedGate}`} cannot resume: task worktree is missing`);
        // Observed passes are an optimization, never authority: without the task worktree there is no
        // commit to compare and no landed work to gate, so fall through to the ordinary worker path.
        replayedGateResults.delete(t.id);
        break resumeGateReplay;
      }
      const resumeReason = recheck
        ? "operator recheck"
        : harvestAuthor
          ? "harvested interrupted attempt"
          : satisfiedGate
            ? `approved gate ${satisfiedGate}`
            : `recorded gates on ${replayedGates!.commit.slice(0, 10)}`;
      const priorTaskTip = preservedRef ? (await shGit(`git rev-parse ${shq(preservedRef)}`, repoRoot)).stdout.trim() : await gitHead(priorWt);
      const priorTaskSubject = await gateCommitSubject(taskBase, priorTaskTip, preservedRef ? repoRoot : priorWt);
      const commitsToCarry = preservedRef ? await commitsAheadOfRef(taskBase, priorTaskTip, repoRoot) : await commitsAheadOf(taskBase, priorWt);
      const wt = await recreateTaskWorktree(taskBranch, taskBase, priorWt);
      const { carried: carriedCommits, accounted: accountedCommits } = await cherryPickCommits(wt, commitsToCarry);
      // Reuse is about the tree the gates will actually inspect. The integration tip may have moved
      // while the daemon was down, so compare after recreating the task on today's taskBase rather
      // than against the stale worktree whose task-only history cannot see newly merged dependencies.
      const currentTaskTip = await gitHead(wt);
      const currentTaskSubject = await gateCommitSubject(taskBase, currentTaskTip, wt);
      // Recheck carries only review authority for the exact subject being gated, never tool greens.
      if (recheck) {
        satisfiedGate = journal.replaySatisfiedGates(new Map([[t.id, currentTaskSubject]])).get(t.id);
      }
      journal.append("worktree-recreation", t.id, {
        attempted: commitsToCarry, carried: carriedCommits, ...(accountedCommits.length > 0 ? { accounted: accountedCommits } : {}),
      });
      // OBS-212: same fail-closed rule as the dispatch path — but this path is worse, because it runs
      // ONLY the gates after the approved one and then MERGES. T3 took it on run-20260728-110135:
      // approved past review at 11:22, recreated at 12:50, and phase-start{gates} / phase-start{merge}
      // landed in the same second with zero gate-result events. Work missing here is merged unverified.
      {
        const present = new Set([...carriedCommits, ...accountedCommits]);
        for (const h of commitsToCarry) {
          if (!present.has(h) && (await shGit(`git merge-base --is-ancestor ${shq(h)} HEAD`, wt)).code === 0) {
            present.add(h);
          }
        }
        const lost = commitsToCarry.filter((h) => !present.has(h));
        if (lost.length > 0) {
          await park(t,
            `carry lost ${lost.length} of ${commitsToCarry.length} verified commit(s) recreating the worktree for ${resumeReason} (first missing: ${lost[0]!.slice(0, 10)}) — refusing to merge a tree that is missing landed work`,
            "infra", assignment, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
      }
      if (!linkNodeModules(repoRoot, wt, { force: true })) {
        await park(t, "environmental: node_modules link could not be re-asserted before gates (OBS-47)", "setup",
          assignment, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      if (await npmDependencyManifestChanged(wt, taskBase)) {
        const installCommand = npmDependencyInstallCommand(wt);
        const installed = await sh(installCommand, repoRoot, 10 * 60_000);
        if (installed.code !== 0) {
          throw new Error(`dependency install failed (exit ${installed.code}): ${installed.stderr || installed.stdout}`);
        }
      }

      const workerEvent = [...journal.read()].reverse()
        .find((e) => e.event === "worker-result" && e.taskId === t.id);
      // OBS-1022: a task that FAILED before its harvest has no worker-result; a recheck judges the
      // committed tree on its own evidence, so the missing claim is recorded as exactly that.
      if (!workerEvent && !recheck) throw new Error(`${resumeReason} cannot resume: worker result is missing`);
      const priorResult: WorkerResult = workerEvent ? {
        ok: workerEvent.data.ok === true,
        summary: typeof workerEvent.data.summary === "string" ? workerEvent.data.summary : "",
        deviations: Array.isArray(workerEvent.data.deviations)
          ? workerEvent.data.deviations.filter((d): d is string => typeof d === "string")
          : [],
        raw: "",
      } : { ok: false, summary: "no worker result recorded (task failed before harvest); recheck gates the committed tree", deviations: [], raw: "" };
      const parkedAuthor = recheck
        ? [...journal.read()].reverse().find((e) => e.event === "task-dispatch" && e.taskId === t.id)?.data.assignment as Assignment | undefined
        : undefined;
      // OBS-1109: a harvested attempt's author is read from the journal, not from this resume's path —
      // a later resume that replays the harvest's recorded gates still gates it under its producer.
      const gateAuthor = parkedAuthor ?? resumeHarvestAuthor(journal.read(), t.id) ?? rs?.lastAssignment ?? assignment;
      const satisfiedIndex = satisfiedGate ? GATE_NAMES.indexOf(satisfiedGate) : -1;
      // The serial pipeline could have at most one blocking result, so "everything after the
      // approved gate" was enough. v1.85 can record both verdict siblings red in one round, and a
      // selected test screen can be green without a complete suite. Approval waives exactly its
      // named gate: every other red from that round is re-run, and test is forced unless the prior
      // journal proves a full suite completed.
      const priorEvents = journal.read();
      let priorRoundStart = -1;
      for (let i = priorEvents.length - 1; i >= 0; i--) {
        const e = priorEvents[i]!;
        if (e.event === "phase-start" && e.taskId === t.id && e.data.phase === "gates") {
          priorRoundStart = i;
          break;
        }
      }
      const priorResults = new Map<GateName, JournalEvent>();
      for (const e of priorEvents.slice(priorRoundStart + 1)) {
        if (e.event !== "gate-result" || e.taskId !== t.id || typeof e.data.gate !== "string"
            || !(GATE_NAMES as readonly string[]).includes(e.data.gate)) continue;
        priorResults.set(e.data.gate as GateName, e);
      }
      const declaredGates = GATE_NAMES.filter((gate) => t.gates.includes(gate));
      const reused: GateName[] = [];
      let remainingGates: GateName[];
      if (recheck) {
        remainingGates = declaredGates.filter((gate) => gate !== satisfiedGate);
      } else if (harvestAuthor) {
        remainingGates = declaredGates; // the harvested attempt was never gated: every declared gate runs
      } else if (satisfiedGate) {
        remainingGates = t.gates.filter((gate) => {
          if (gate === satisfiedGate) return false;
          const prior = priorResults.get(gate)?.data;
          const followsApproved = GATE_NAMES.indexOf(gate) > satisfiedIndex;
          const otherRed = prior?.pass === false;
          const needsFullSuite = gate === "test" && prior?.fullSuite !== true;
          // W: a red evidence/scope screen ends the round before the battery, so a gate that PRECEDES
          // the waived one may never have run: no prior-round row is no verdict — run it as declared.
          const unobserved = prior === undefined;
          return followsApproved || otherRed || needsFullSuite || unobserved;
        });
      } else {
        // T15: reuse only a contiguous green prefix from the current attempt on the exact task tip.
        // The first failed/missing gate and everything after it re-enters runGates, so neither an
        // inert resume nor a blanket skip can pass. A changed tip re-runs the complete declared set.
        // Raw object ids remain valid for hand-written/older rows; daemon-written rows use the
        // canonical commit subject so equivalent repositories retain journal identity.
        const exactCurrentCommit = currentTaskTip === replayedGates!.commit;
        const canonicalCurrentCommit = currentTaskSubject === replayedGates!.commit;
        const recreatedLegacyCommit = priorTaskTip === replayedGates!.commit
          && priorTaskSubject === currentTaskSubject;
        // T7: the commit says the gates would inspect the same TREE; it says nothing about the
        // machine they measured it on. A resume is a new session and may have resolved a different
        // concurrency, so the rows behind a replayed green must also have been measured under the
        // capacity this session resolved — otherwise a contiguous green prefix spans two worlds.
        // Rows from before this stamp carry no capacity and replay exactly as they do today.
        const replayedCapacities = priorEvents
          .filter((e) => e.event === "gate-result" && e.taskId === t.id && e.data.commit === replayedGates!.commit)
          .map((e) => e.data.capacity);
        const sameWorld = replayedCapacities.every((recorded) => sameCapacity(recorded, sessionCapacity));
        if (!sameWorld) {
          journal.append("gate-replay-capacity-changed", t.id, {
            commit: replayedGates!.commit, recorded: replayedCapacities, resolved: sessionCapacity,
          });
        }
        // R41: the same rule for the verification protocol, measured for the RECREATED worktree
        // the re-run would gate in (its project npmrc included) — but a row with NO stamp is an OLDER
        // row from a different (pre-stamp) implementation, never "unchanged": it is re-run.
        const replayVerification = verificationProtocol(process.env, wt);
        const replayedVerifications = priorEvents
          .filter((e) => e.event === "gate-result" && e.taskId === t.id && e.data.commit === replayedGates!.commit)
          .map((e) => e.data.verification);
        const sameProtocol = replayedVerifications.every((recorded) => sameVerification(recorded, replayVerification));
        if (!sameProtocol) {
          journal.append("gate-replay-verification-changed", t.id, {
            commit: replayedGates!.commit, recorded: replayedVerifications, resolved: replayVerification,
          });
        }
        let reusable = sameWorld && sameProtocol && (exactCurrentCommit || canonicalCurrentCommit || recreatedLegacyCommit);
        for (const gate of declaredGates) {
          if (!reusable || replayedGates!.results.get(gate) !== true) reusable = false;
          else reused.push(gate);
        }
        remainingGates = declaredGates.slice(reused.length);
      }
      // OBS-1094/1049: every replay recreates the checkout, but build outputs are not commits.
      // Provision whenever build will not run as a gate, including an operator waiver restore.
      // Defer reuse rows until provisioning succeeds: green keeps reuse-then-provision order;
      // red records only provisioning and puts build and every declared successor back in gates,
      // unless build itself was waived: provisioning must not undo the operator's release.
      let provisionedRow: Record<string, unknown> | undefined;
      if (!remainingGates.includes("build") && commands.build !== undefined) {
        await waitForBaseline(t.id);
        const startedAt = Date.now();
        const provisioned = await withCommandContext(t.id, () => sh(commands.build, wt));
        provisionedRow = {
          gate: "build", commit: !satisfiedGate && !recheck && replayedGates ? replayedGates.commit : currentTaskSubject,
          exitCode: provisioned.code, durationMs: Date.now() - startedAt,
        };
        if (provisioned.code !== 0 && satisfiedGate !== "build") {
          reused.length = 0;
          remainingGates = ["build", ...declaredGates.filter((gate) => gate !== "build")];
        }
      }
      for (const gate of reused) {
        journal.append("gate-reused", t.id, { gate, commit: replayedGates!.commit });
      }
      if (provisionedRow !== undefined) journal.append("gate-provisioned", t.id, provisionedRow);
      const resumedTask = { ...t, gates: remainingGates };
      const operatorContext = approvalReviewContext(journal.read(), t.id);
      let outsideScopeForced = false;

      gateLoop: while (true) {
        fatalStop.signal.throwIfAborted();
        executionSignal()?.throwIfAborted();
        const gated = await gitHead(wt);
        gateSubject = {
          commit: await gateCommitSubject(taskBase, gated, wt),
          attempt: rs?.attempts ?? 0,
          // This suffix is re-measured to decide whether resume may advance, but the interrupted
          // attempt already paid for its red result. The next worker-backed round remains the next
          // deterministic-fingerprint occurrence/review round for budget accounting.
          ...(!satisfiedGate && !recheck && !harvestAuthor ? { replayMeasurement: true as const } : {}),
        };
        if (recheck && satisfiedGate === "review" && gateSubject.commit !== currentTaskSubject) {
          satisfiedGate = undefined;
          resumedTask.gates = declaredGates;
        }
        if (recheck && satisfiedGate === "review" && !resumedTask.gates.includes("review")) {
          journal.append("gate-waiver-carried", t.id, { gate: "review", commit: gateSubject.commit, carried: true, release: RECHECK_RELEASE });
        }
        await trackedDriver.project?.(t.id, "in-review");
        await waitForBaseline(t.id);
        // OBS-1106 residual: the live loop's timeout refresh, decided again from the journal, so a crash
        // cannot launder the copy it forbids. A harvested retry that landed nothing owes it exactly as
        // the live loop would have; a crash inside a forced battery before its test row still owes it.
        const lastRound = (() => {
          const own = journal.read().filter((e) => e.taskId === t.id);
          return own.slice(own.map((e) => e.event === "phase-start" && e.data.phase === "gates").lastIndexOf(true) + 1);
        })();
        // C: a passing selected-test screen is never a forced round's conclusive test result (the
        // journal's own replay rule): its full suite is still owed, fresh, under the round's bypass.
        const measured = lastRound.filter((e) => e.event === "gate-result" && !(e.data.gate === "test"
          && Array.isArray(e.data.selectedTests) && e.data.fullSuite !== true && e.data.pass !== false));
        const forcedUnmeasured = (outside: boolean) => lastRound.some((e) => e.event === "gate-fresh-forced"
          && e.data.commit === gateSubject!.commit && (e.data.reason === OUTSIDE_SCOPE_RED) === outside)
          && !measured.some((e) => e.data.gate === "test");
        // C: a crash after the forced re-execution journaled its red but before its park still owes that
        // park — restored from the journaled subject and result, never re-measured, replayed or repaired.
        // Infra adjudication stays authoritative, exactly as it is ahead of the live park.
        if (!recheck && !satisfiedGate && lastRound.some((e) => e.event === "gate-fresh-forced"
          && e.data.reason === OUTSIDE_SCOPE_RED && e.data.commit === gateSubject!.commit)
          && allOutsideScopeReds(t, lastRound, gateSubject.commit)) {
          const restored = lastRound.filter((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === false)
            .map((e): GateResult => ({ gate: "test", pass: false, details: String(e.data.details ?? ""), meta: e.data }));
          if (await adjudicateInfraShapedRed(t, restored, wt, gateSubject.commit, rs?.attempts ?? 0, true, (reason) =>
            park(t, reason, "infra", gateAuthor, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode))) return;
          await park(t, outsideScopePark(t), "gate-fail", gateAuthor, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
        // C: the same out-of-scope re-execution the live loop owes, and a crash inside it still owes it. It
        // takes precedence over a timeout refresh: a qualifying red keeps its own bypass and park.
        outsideScopeForced = !recheck && !satisfiedGate && (
          (harvestAuthor !== undefined && owesOutsideScopeRefresh(t, lastRound, gateSubject.commit)) || forcedUnmeasured(true));
        const freshTimeout = !recheck && !satisfiedGate && !outsideScopeForced && (
          (harvestAuthor !== undefined && owesTimeoutRefresh(t, lastRound, gateSubject.commit)) || forcedUnmeasured(false));
        // C: a measurement this forced round EXECUTES fresh — its forced test above all — is independent
        // evidence, never a replay measurement; only a gate the interrupted round already journaled is.
        if (outsideScopeForced) {
          gateSubject = { ...gateSubject, journaledGates: measured.map((e) => String(e.data.gate)) };
        }
        journal.phaseStart(t.id, "gates");
        if (freshTimeout) {
          journal.append("gate-fresh-forced", t.id, { gate: "test", attempt: gateSubject.attempt, commit: gateSubject.commit, reason: "no-commit-timeout-red", resumed: true });
        }
        if (outsideScopeForced) {
          journal.append("gate-fresh-forced", t.id, { gate: "test", attempt: gateSubject.attempt, commit: gateSubject.commit, reason: OUTSIDE_SCOPE_RED, resumed: true });
        }
        const { results } = await withCommandContext(t.id,
          async () => runReviewRecovery(resumedTask, {
          carriedAuthors: await subjectAuthors(journal.read(), t.id, wt, taskBase),
          producer: producerNow(),
          carriedFindings: outstandingReviewFindings(journal.read(), t.id),
          operatorContext,
          worktree: wt, baseRef: taskBase, result: priorResult, author: gateAuthor,
          commands, baseline, channels: pools.review, judgeChannels: pools.judge, health, adapters, cfg, artifactDir: journal.dir,
          collateral: collateral.get(t.id) ?? [],
          // a recheck re-verifies a human's release: it never selects tests down, it runs the suite.
          via: cfg.visibility.llm === "pane"
            ? {
                driver: trackedDriver,
                keep: keepLlm,
                onSlot: keepLlm ? (s: Slot) => keptSlots.push(s) : undefined,
                nameFor: (role) => formatOwnedName({ role, taskId: t.id, attempt: 0, runId }),
                labelFor: (role) => `${role.toUpperCase()} ${t.id}`,
              }
            : undefined,
          excludeReviewers: badReviewers,
          reviewHistory, demotedReviewers, priorReviewers: taskReviewers(t.id),
          // Leg-2 (OBS-1052): the run-scoped two-strike tally — without it retirement is inert and a
          // flaking seat is re-asked on every task.
          reviewNoVerdicts,
          recheck, // OBS-1055: a recheck discards cached reds — the battery re-measures what the operator questioned
          cachedRedBypass: freshTimeout ? "timeout-fresh" : outsideScopeForced ? "out-of-scope-fresh" : undefined,
          onGate: async (e) => {
            if (!liveEngagement()) return;
            if (e.phase === "start") {
              notePhaseStart(e);
              journal.phaseStart(t.id, phaseForGate(e.gate), { gate: e.gate, index: e.index, total: e.total, ...(e.parentAt === undefined ? {} : { parallel: true }) });
              return;
            }
            if (e.phase === "note") {
              noteReviewEvent(e);
              return;
            }
            const g = e.result;
            activeGatePhases.get(t.id)?.delete(e.gate);
            classifyInfraResult(g);
            inParallelOrder(g.gate as GateName, () => {
              journalGateResult(g);
              noteReviewRetry(g);
              if (isGarbageReview(g)) badReviewers.push(g.meta.reviewer);
            });
          },
        }, false));
        results.forEach(classifyInfraResult);
        if (pendingDaemonApprovalActions(journal.read()).get(t.id)?.authority === "battery") {
          journal.append("recheck-battery", t.id, {
            commit: gateSubject.commit,
            gates: resumedTask.gates,
            pass: results.every(gateSatisfied),
          });
        }
        const approvedCommits = await commitsAheadOf(taskBase, wt);
        graph = addEvidence(graph, t.id, { commits: approvedCommits, gateResults: results });
        saveGraph(repoRoot, graph);
        const n = rs?.attempts ?? 0;
        const settled = await settleResults(results, {
          wt, taskBase, taskBranch, gated, commit: gateSubject.commit, outsideScopeForced,
          author: gateAuthor, attempts: n, infraReason: (g) => `${g.gate}: ${g.details}`,
          reobserve: { attempt: n, replayed: false }, firstAttemptOk: false, metering: {},
          // OBS-547: disposition FIRST, and through the same helper the ordinary attempt path uses. A
          // crash between a journaled scope red and its classification must not turn a predicted red
          // into a charged one just because a resume is what observed it.
          // rs.attempts COUNTS the interrupted dispatch this replay is judging; the chargeable
          // attempts behind it are one fewer. Passing the count itself would number the same dispatch
          // one higher here than on the ordinary path and bill an attempt the fresh path forgives.
          // UNLESS an earlier resume already journaled the classification and died before its park:
          // replayResumeState() has then ALREADY taken that dispatch back, so subtracting again would
          // erase an EARLIER chargeable attempt and attribute the park to the assignment the rewind
          // restored. Ask the journal which state this is, and take the classified dispatch's own
          // assignment back with it.
          disposition: () => {
            const classified = journal.classifiedDispatch(t.id);
            return { author: classified?.assignment ?? gateAuthor, attempt: classified ? n : Math.max(0, n - 1) };
          },
        });
        if (settled.kind === "red") {
          gateFails++;
          // Observed green gates are only measurements. If the resumed suffix is red, preserve that
          // result in the journal and return to the ordinary attempt/consult ladder, which rebuilds
          // feedback from those rows. Only an operator-authorized gate release parks on a new red.
          if (!satisfiedGate || recheck) {
            // OBS-1055: a recheck red funds a repair of the pin's own work. A pinned task's repair sits
            // on the pin (OBS-1034's exemption keeps the tried list from excluding it); a pin the fleet
            // cannot seat parks naming the pin — never the ladder.
            const pin = recheck ? t.routingHints?.pin : undefined;
            if (pin) {
              const seat = channels.find((c) => c.adapter === pin.via && c.model === pin.model && !demotedChannels.has(channelKey(c)));
              if (!seat) {
                await park(t, `recheck red: pinned ${pin.via}:${pin.model} is unavailable to host the repair — refusing the ladder`,
                  "gate-fail", gateAuthor, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
                return;
              }
              assignment = seatAssignment(seat);
            }
            // Carry completeness was verified before this replay battery. Apply the ordinary
            // repair bounds here too; a restored red must fund the same findings-bearing dispatch.
            // Funding is durable intent only: repairReachSinceApproval charges it after launch
            // reaches a funded gate, and a restart before launch must not duplicate that intent.
            const failing = results.filter(gateFailed);
            const battery = failing.some((g) => g.gate !== "review") ? failing.filter((g) => g.gate !== "review") : failing;
            const landed = await commitsAheadOf(taskBase, wt);
            const events = journal.read();
            const drawn = repairsSinceApproval(events, t.id);
            const repeated = failing.some((g) => isDeterministicFailure(g)
              && identicalGateFailures(events, t.id, g.gate, normalizeGateFailure(g.details)) >= GATE_FINGERPRINT_CAP);
            if (narrowRepairBattery(battery) && landed.length > 0 && drawn < MAX_REPAIRS
                && (rs?.attempts ?? 0) < MAX_ATTEMPTS && !repeated
                && pendingRepairFindings(events, t.id) === undefined) {
              journal.append("repair-attempt", t.id, {
                repair: repairReachSinceApproval(events, t.id).length + 1, charge: drawn + 1, of: MAX_REPAIRS,
                gates: failing.map((g) => g.gate), commits: landed.length,
                findings: withCarriedEvidence(repairFindingsBrief(results)),
              });
            }
            break gateLoop;
          }
          await park(t, gateFailApprovalReason(t.id, "post-approval gate failed", results.some((g) => g.gate === "review" && gateFailed(g))), "gate-fail", gateAuthor, rs?.attempts ?? 0,
            startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }

        if (settled.kind === "regate") continue gateLoop;
        if (settled.kind === "parked") return;
        if (settled.kind === "conflict") {
          await park(t, `merge conflict after ${resumeReason}: ${settled.conflict ?? "unknown conflict"}`,
            "merge-conflict", gateAuthor, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
        await reconcile({ spareLiveLlm: true });
        return;
      }
    }

    // Phase 46 (RES-01): start at the replayed attempt count; a replayed count ≥ MAX_ATTEMPTS parks via
    // the existing attempt-cap check below with zero new code. Fresh path: rs is undefined ⇒ 0.
    // v1.24 OBS-18: after task-approved{release:attempt-cap}, replay zeros attempts so this loop
    // starts at 0 (fresh budget) instead of re-parking at the cap in the same tick.
    let providerDeathRequeues = 0;
    let providerDeathAttempt = -1;
    // A completed attempt may keep its pane for gate-failure context, but once another worker is
    // funded that context is superseded and — more importantly — must not remain a second writer on
    // the same worktree. The next loop iteration retires it before reading/recreating the tree.
    let supersededWorkerSlot: Slot | undefined;
    attempts: for (let attempt = rs?.attempts ?? 0; ; attempt++) {
      // Funding belongs to the next attempt. Later automatic repairs retain ordinary red reuse.
      const explicitlyFundedAttempt = fundedRerun && attempt === (rs?.attempts ?? 0);
      fatalStop.signal.throwIfAborted();
      executionSignal()?.throwIfAborted();
      if (attempt !== providerDeathAttempt) {
        providerDeathRequeues = 0;
        providerDeathAttempt = attempt;
      }
      // v1.13 (VIS-09 safety): one FRESH nonce per attempt — see the run-scope comment above. A retained
      // prior-attempt trailer (herdr scrollback / subprocess buffer) must never satisfy this attempt.
      const nonce = randomBytes(4).toString("hex");
      const exitMarkerCmd = `printf '\\nTICKMARKR_''EXIT_${nonce}:%s\\n' $?`;
      const exitRe = new RegExp(`TICKMARKR_EXIT_${nonce}:(\\d+)`);
      if (attempt >= MAX_ATTEMPTS) {
        await park(t, `attempt cap (${MAX_ATTEMPTS}) reached`, "attempt-cap", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      if (supersededWorkerSlot && !keepForever) {
        const prior = supersededWorkerSlot;
        supersededWorkerSlot = undefined;
        const idx = keptSlots.indexOf(prior);
        if (idx >= 0) keptSlots.splice(idx, 1);
        try {
          await closeSlot(prior);
        } catch (error) {
          await park(
            t,
            `superseded worker could not be swept before dispatch: ${error instanceof Error ? error.message : String(error)}`,
            "stall", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode,
          );
          return;
        }
      }
      // OBS-419: read the approval-carried ceiling at the funding boundary, after every escalation
      // decision but before the sole task-dispatch below. Both interactive and headless worker-launch
      // branches are dominated by this check, so no route can fund another worker without consulting it.
      // reviewRoundsSinceApproval resets the DRAWN count at approval; the ceiling on that same approval
      // survives the reset and governs only those further rounds. Absence preserves the module default.
      const reviewRoundCap = approvedReviewRoundCeiling(journal.read(), t.id) ?? REVIEW_ROUND_CAP;
      if (attempt > 0 && reviewRoundsDrawn() >= reviewRoundCap) {
        await park(t, gateFailApprovalReason(t.id, `review round cap (${reviewRoundCap}) reached this engagement`, true), "gate-fail", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      // OBS-57: a demoted channel must not be re-dispatched on consult retry or provider requeue.
      if (demotedChannels.has(channelKey(assignment))) {
        // OBS-1187: a pooled task recycles a live pool member (OBS-202) before it may park naming the pool;
        // it never keeps a demoted seat and never leaves the pool.
        const pooled = taskPool(t, cfg) !== undefined;
        const next = nextChannel(assignment, t, cfg, channels, tried, profile, demotedChannels)
          ?? (pooled ? nextChannel(assignment, t, cfg, channels, recycleExcluded(), profile, demotedChannels) : null);
        if (next) {
          assignment = next;
          const k = channelKey(next);
          if (!tried.includes(k)) tried.push(k);
        } else if (pooled) {
          await park(t, `${channelKey(assignment)} is demoted (verified dead) and no live pool member remains${poolExhaustion(t, cfg)}`,
            "reroute-exhausted", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
      }
      // v1.29: consume the prior gate-failed session once. Same channel + known under-threshold context
      // + adapter capability resumes; every other path is today's fresh dispatch.
      // v1.53 T3: an adapter with no context surface at all (kimi, KIMI-03) may declare
      // resumeUnknownContext to loosen ONLY the contextTokens-known requirement — a KNOWN
      // over-threshold context still forces fresh, and the escalation ladder bounds the chain.
      const priorSession = retrySession;
      retrySession = undefined;
      // v1.85 T3: the fingerprint cap banned an IDENTICAL retry — this task+gate already produced the
      // same failure bytes twice, so re-running the same channel on the same brief is a paid
      // re-measurement of an answer the journal already holds. Enforced HERE, at the one seam every
      // re-dispatch passes through, and NOT at the consult verdict that set it: a terminal verdict
      // falling through to the cap's own `retry` rung, a review-fix round and the ladder itself all
      // reach a dispatch without ever consulting again, and worker-launch below would then expire a
      // ban nothing had honoured. Bound to the channel the cap fired on, so a move that already went
      // elsewhere is not refused for a ban that was never about it; with no untried channel left the
      // task parks naming the ban rather than buying a third round.
      const banned = activeRetryBan(journal.read(), t.id, channelKey(assignment));
      if (banned) {
        const next = failover("escalate");
        journal.append("retry-same-banned", t.id, {
          gate: banned, from: channelKey(assignment), to: next ? channelKey(next) : null,
        });
        if (!next) {
          await park(t, gateFailApprovalReason(t.id, `identical ${banned} failure twice this engagement — an identical retry is banned and no untried channel is left${poolExhaustion(t, cfg)}`),
            "gate-fail", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
        assignment = next;
        if (!tried.includes(channelKey(next))) tried.push(channelKey(next));
      }
      const retryAdapter = adapters.find((a) => a.id === assignment.adapter);
      // v1.85 T3: a repair attempt is dispatched FRESH by construction — the whole point is that the
      // brief, not a surviving session, carries the findings and the diff. It therefore outranks the
      // session-resume choice, and the mode is journaled so the ledger can price repairs against
      // fresh re-dispatches. Read from the JOURNAL, before this dispatch's own event lands: a run that
      // stopped between funding the repair and sending it resumes still carrying the findings.
      const journaledSoFar = journal.read(); // read BEFORE this dispatch's own event lands
      const operatorContext = approvalReviewContext(journaledSoFar, t.id);
      let repairFindings = pendingRepairFindings(journaledSoFar, t.id);
      // OBS-254, one layer below the upheld brief: the ordinary gate-fail brief was loop-local, so any
      // path that rebuilt this task's state (a resume, `--retry-failed`, a fresh daemon) dispatched a
      // retry that had forgotten why it was retrying. Re-derived from the journal here, at prompt-build
      // time, and MERGED rather than substituted — a retry never discards what the journal already
      // holds. Row-wise, because the live brief may already quote one of them (a delivery-readiness
      // failure the loop just wrote) and repeating it helps no worker.
      const journaledRows = journaledFailureBrief(journaledSoFar, t.id).filter((row) => !feedback.includes(row));
      if (journaledRows.length > 0) {
        const brief = journaledRows.join("\n\n");
        feedback = feedback ? `${brief}\n\n${feedback}` : brief;
      }
      // T6: both carries above are ATTEMPT-scoped — the funded repair is spent at the next
      // worker-launch (and budgeted at two), and the journaled brief is reset there too, so it hands
      // this dispatch only the LAST attempt's bytes. An unresolved review finding is a property of the
      // TASK: the moment one attempt fails for an unrelated reason — a red build, a refused tree, or a
      // death that journals no gate row at all — the finding is in neither carry and the next worker
      // re-derives the task from the spec and lands on the same gap the reviewer already anchored.
      // Re-derived from the journal on EVERY dispatch and retired only by a review that passes on this
      // task (journal.ts `outstandingReviewFindings`). Appended row-wise, because this round's own
      // feedback or a repair brief may already quote a finding and repeating it helps no worker.
      const outstandingFindings = outstandingReviewFindings(journaledSoFar, t.id);
      // T2: the two are different facts about the work and no one heading is true of both. A finding
      // the reviewer DEFERRED was accepted with a rationale by a review that did not block on it; a
      // blocking one is still waiting for a review to pass. Filing the deferral under the blocking
      // heading tells the next worker a passing review is owed on a concern that already drew one —
      // the exact falsehood this carry exists to remove, restated in the brief that carries it.
      //
      // The de-dup below is BLOCKING-ONLY on purpose. A review round's raw bytes quote every finding
      // it recorded, deferrals included, and those bytes ride into the very next dispatch under the
      // repair brief's "fix ONLY what these findings name" — so on the ordinary immediate retry the
      // deferral is already stated, and stated AS BLOCKING. Suppressing its heading there because it
      // is "already quoted" leaves exactly the falsehood. A quoted BLOCKING finding is quoted
      // truthfully, so that one still de-dups; a deferral is instead CUT from the raw bytes and
      // restated once, under the only heading true of it.
      const deferredRows = outstandingFindings.filter(isDeferredFinding);
      const withoutDeferrals = (text: string) => deferredRows.reduce(
        (brief, finding) => brief.replaceAll(renderStructuredReviewFinding(finding), ""),
        text,
      ).replace(/\n{3,}/g, "\n\n").trim();
      feedback = withoutDeferrals(feedback);
      if (repairFindings !== undefined) repairFindings = withoutDeferrals(repairFindings);
      const briefs: Array<[string, StructuredFinding[]]> = [
        [OUTSTANDING_FINDINGS_HEADING, outstandingFindings.filter((f) => !isDeferredFinding(f) && !feedback.includes(f.note))],
        [DEFERRED_FINDINGS_HEADING, deferredRows],
      ];
      for (const [heading, rows] of briefs) {
        if (rows.length === 0) continue;
        const brief = [heading, ...rows.map((f) => {
          const rationale = f.rationale === undefined
            ? ""
            : `\n  Rationale: ${f.rationale}`;
          return `- ${f.path}: ${f.note}${rationale}`;
        })].join("\n");
        feedback = feedback ? `${feedback}\n\n${brief}` : brief;
      }
      const carriedConsultGuidance = outstandingConsultGuidance(journaledSoFar, t.id);
      if (carriedConsultGuidance) {
        const consultBrief = renderRetryGuidance({ ...carriedConsultGuidance, notes: "" });
        if (consultBrief && !feedback.includes(consultBrief)) {
          feedback = feedback ? `${feedback}\n\n${consultBrief}` : consultBrief;
        }
      }
      const scopeApproval = effectiveEvents(journaledSoFar).reverse().find((e) => e.taskId === t.id && (e.event === "task-approved" || e.event === "task-dispatch"));
      retryMode = scopeApproval?.data.release === "scope-request" ? "fresh" : repairFindings
        ? "repair"
        : priorSession
        && priorSession.channel === channelKey(assignment)
        && (priorSession.contextTokens !== undefined
          ? priorSession.contextTokens < cfg.contextWarnTokens
          : retryAdapter?.resumeUnknownContext === true)
        && retryAdapter?.resumeCommand
        ? "resume"
        : "fresh";
      // v1.23 T3: over-threshold context still forces fresh at the retry boundary; never interrupt a
      // running attempt. Unknown/below emits no reset event.
      if (attempt > 0 && lastContextTokens !== undefined && lastContextTokens >= cfg.contextWarnTokens) {
        journal.append("session-reset", t.id, {
          tokens: lastContextTokens,
          threshold: cfg.contextWarnTokens,
          attempt, // the fresh attempt about to dispatch
        });
      }
      lastContextTokens = undefined;
      graph = setStatus(graph, t.id, "running");
      saveGraph(repoRoot, graph);
      await trackedDriver.project?.(t.id, "in-progress");
      // T6: a dispatch that carries an outstanding finding says so, and names it. Without this the
      // ledger cannot tell a carried dispatch from an amnesiac one — the exact question a run that
      // spends two frontier attempts re-deriving a known defect has to be able to answer afterwards.
      fatalStop.signal.throwIfAborted();
      const workerDispatchOrdinal = nextWorkerDispatchOrdinal++;
      vendorEscalated.delete(channelKey(assignment)); // dispatched now: from here on it IS tried
      journal.append("task-dispatch", t.id, {
        ...(scopeApproval?.data.release === "scope-request" ? { files: t.files, graphDefinitionHash: graphDefinitionHash(graph) } : {}),
        assignment, attempt, workerDispatchOrdinal, provenance: dispatchProvenance([
          channelKey(assignment) === channelKey(r.assignment) ? r.provenance
            : t.routingHints?.pin ? `pin ${t.routingHints.pin.via}:${t.routingHints.pin.model} not re-tried` : "ladder assignment",
          `dispatch ${channelKey(assignment)}`, climbProvenance,
        ].filter(Boolean).join(" · ")), retryMode,
        routingHints: t.routingHints ?? {},
        excludedChannels: [...new Set([...demotedChannels, ...tried, ...climbSkips])]
          .filter((key) => key !== channelKey(assignment)).sort(),
        exclusionReasons: Object.fromEntries([...new Set([...demotedChannels, ...tried, ...climbSkips])]
          .filter((key) => key !== channelKey(assignment))
          .map((key) => [key, demotedChannels.has(key) ? "demoted"
            : vendorEscalated.get(key) ?? (tried.includes(key) ? "already tried" : "tier climb skipped")])),
        ...(outstandingFindings.length > 0 ? { carriedFindings: outstandingFindings } : {}),
        ...(carriedConsultGuidance ? { carriedConsultGuidance } : {}),
      });
      journal.phaseStart(t.id, "worker", { attempt, assignment });

      const taskBase = await integrationHead(intWt); // deps are merged → visible to this task

      taskBases.set(t.id, taskBase);
      const taskBranch = `${branch}--${t.id}`; // "--": a ref can't nest under the existing integration branch (locked decision 10)
      const priorWt = worktreePath(repoRoot, taskBranch);
      const recreating = existsSync(priorWt);
      // Carry the interrupted worker's snapshot, never incidental files created by later gates.
      const preserved = recreating ? reapedWorktreeRef : undefined;
      reapedWorktreeRef = undefined;
      const commitsToCarry = recreating ? await commitsAheadOf(taskBase, priorWt) : [];
      if (preserved) commitsToCarry.push(preserved);
      const wt = await recreateTaskWorktree(taskBranch, taskBase, priorWt);
      // OBS-58: quota-failover and every retry recreate the task worktree from the integration tip —
      // cherry-pick prior attempts' landed commits forward so a failover dispatch cannot silently
      // orphan work a consult already verified as landed.
      const { carried: carriedCommits, accounted: accountedCommits } = commitsToCarry.length > 0
        ? await cherryPickCommits(wt, commitsToCarry) : { carried: [], accounted: [] };
      if (recreating) {
        journal.append("worktree-recreation", t.id, {
          attempted: commitsToCarry, carried: carriedCommits, ...(accountedCommits.length > 0 ? { accounted: accountedCommits } : {}),
        });
      }
      // T2 review (material): harvest eligibility is "does this WORKTREE carry unverified work",
      // measured against taskBase — the same base the fast-kill's delta probe and the gates
      // themselves use. It was measured against this attempt's post-carry HEAD, which excluded
      // every commit cherry-picked forward: attempt 0 commits and walls, attempt 1 receives that
      // commit and goes silent, and the silent retry — whose worktree already held the whole
      // deliverable — was NOT harvested, took the stall consult, and could be redispatched to
      // re-produce it. The routing branches that "starting HEAD" was protecting no longer need it:
      // quota, dead-channel and provider-death all classify the PRE-HARVEST outcome below and fire
      // BEFORE the synthesis, so carried-only work reaches gates without bypassing any failover.
      const priorNamed = [...new Set([...commitsToCarry, ...carriedCommits])];
      const presentCommits = new Set([...carriedCommits, ...accountedCommits]);
      for (const h of commitsToCarry) {
        if (!presentCommits.has(h) && (await shGit(`git merge-base --is-ancestor ${shq(h)} HEAD`, wt)).code === 0) {
          presentCommits.add(h);
        }
      }
      // OBS-212: losing carried work is WORK DESTRUCTION, never an ordinary continue. Every commit in
      // commitsToCarry is one a prior attempt landed and the gates verified. If a commit is neither
      // cherry-picked nor already an ancestor of the new base, dispatching a worker onto this tree
      // silently makes it re-buy verified work — the failure this cherry-pick exists to prevent
      // (OBS-58, comment above) happening silently inside the mechanism itself. Measured on
      // run-20260728-110135: T2 carried 0 of 17 at 17:07 and T1 carried 0 of 15 at 21:37, twenty
      // minutes after T2's merge advanced the integration tip. Nothing failed and nothing parked;
      // the run simply re-paid for the work. Fail closed instead — a visible park beats a silent loss.
      // On the DISPATCH path a drop is not always a defect: a human can re-pend a task with new
      // intent, and the superseded commit then SHOULD be left behind (pinned by the worktree-cleanup
      // resume test, where T1 and T2 both write shared.txt and the loser is re-scripted). We cannot
      // tell supersession from destruction here, so this path stays loud rather than fail-closed —
      // the harm that cost this run ~9 hours was the SILENCE, not the drop. The merge path, where a
      // drop is never legitimate, does fail closed (see the satisfied-gate site above).
      const lostCommits = commitsToCarry.filter((h) => !presentCommits.has(h));
      if (lostCommits.length > 0) {
        journal.append("work-loss", t.id, {
          site: "dispatch", base: taskBase, attempted: commitsToCarry, carried: carriedCommits, lost: lostCommits,
        });
        await driver.notify(
          `tickmarkr ${runId}: ${t.id} lost ${lostCommits.length} of ${commitsToCarry.length} landed commit(s) recreating its worktree — it will re-do that work`,
          { tier: "attention" });
      }
      // v1.85 T3: "fully carried commits" is a repair PRECONDITION, and it is re-validated here —
      // the eligibility test ran one attempt ago, but the carry that decides it happens above, on
      // this dispatch. A tree that lost part of the prior attempt's work cannot be repaired: a
      // fix-only contract ("do NOT re-implement that work") over a diff whose implementation is
      // missing would have the worker patch an incomplete tree and forbid it from rebuilding the
      // rest. The fresh ladder owns this dispatch instead. `retryMode` is corrected before
      // worker-launch records it, so the ledger's launch event names what the worker actually got.
      if (repairFindings !== undefined && lostCommits.length > 0) {
        journal.append("repair-cancelled", t.id, { reason: "carry incomplete", attempted: commitsToCarry, lost: lostCommits });
        repairFindings = undefined;
        retryMode = "fresh";
      }
      // v1.85 T3: a repair dispatch replaces the bare gate-fail brief with a fix-only contract that
      // carries the failing findings VERBATIM and the diff CONTENT of the work already in this
      // worktree. The measured loss it removes: 62 of 68 re-dispatches were fresh, each re-buying
      // ~20m of onboarding to rediscover a diff and a finding the journal already held.
      // The diff is measured HERE, from the worktree the worker will actually open, after the carry —
      // never from the pre-recreation tree, so what the brief quotes is what the worker has.
      if (repairFindings) {
        const raw = await shGit(`git diff ${shq(taskBase)}..HEAD`, wt);
        const cap = cfg.gates.diffCap ?? DEFAULT_DIFF_CAP; // same fallback the measuring gates use
        // OBS-1034: a capped brief says WHAT it cut — the files whose hunks start at or past the cap
        // (the file the cut lands inside is partial too) — on the row and in the worker's prompt.
        const rawBytes = Buffer.from(raw.stdout, "utf8"); // the cap is BYTES: measure and cut in UTF-8, not code units
        const capped = rawBytes.length > cap;
        const droppedFiles = capped ? repairDiffFilesCut(rawBytes, cap, [...await diffPaths(taskBase, wt)]) : [];
        const diff = capped
          ? `${new TextDecoder().decode(rawBytes.subarray(0, cap))}\n… diff truncated at gates.diffCap (${cap} bytes)`
          + `\nPARTIAL DIFF: the diff above is incomplete; files cut by the cap: ${droppedFiles.join(", ") || "(unknown)"}`
          : raw.stdout;
        const repeated = reraisedReviewChains(journaledSoFar, t.id).filter((chain) => chain.reraises > 1);
        const brief = repairBrief(repairFindings, diff, taskBase, repeated);
        // anything the live brief holds beyond the journaled findings (a consult's guidance) is kept:
        // a repair adds the diff and the fix-only contract, it never subtracts what was already known.
        // OBS-1195: a resumed upheld repair re-derives the same review bytes on both carries; when the
        // repair already quotes them verbatim they are said once, and the operator's uphold line stays.
        // Both carries had their deferrals cut above, so the quote is compared after the same cut.
        const upheldQuote = upheldFeedback ? withoutDeferrals(`review: ${upheldFeedback}`) : undefined;
        const rest = upheldQuote && brief.includes(upheldQuote)
          ? feedback.replace(upheldQuote, "").replace(/\n{3,}/g, "\n\n").trim()
          : feedback;
        feedback = rest && !brief.includes(rest) ? `${brief}\n\n${rest}` : brief;
        journal.append("repair-dispatch", t.id, { workerDispatchOrdinal, diffBytes: Buffer.byteLength(diff, "utf8"), capped, ...(capped ? { droppedFiles } : {}) });
      }
      if (feedback || priorNamed.length > 0) {
        feedback = augmentRetryBrief(feedback, { attempted: commitsToCarry, carried: carriedCommits, present: presentCommits });
      }
      if (cfg.setup) {
        // v1.22 T3: setup runs inside the task worktree — seal herdr control vars so a setup script
        // cannot mutate the operator's panes. Worker/judge/review/consult are sealed at the driver
        // boundary (SubprocessDriver spawn env / HerdrDriver pane seed); this is the remaining
        // daemon-owned child shell that is not a driver.slot.
        const sr = await sh(`${herdrSealShellPrefix()}${cfg.setup}`, wt, 10 * 60_000);
        journal.append("worktree-setup", t.id, { code: sr.code });
        if (sr.code !== 0) {
          await park(t, `worktree setup failed (exit ${sr.code}): ${cfg.setup}`, "setup", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
      }
      const promptTask = await taskWithMaterializedContext(repoRoot, journal, wt, t, attempt);
      const promptFile = writePrompt(journal.dir, promptTask, attempt, feedback, nonce);
      // OBS-56: state the non-interactive, one-pass finish contract and the OBS-54 stall budget in every
      // worker prompt, not only consult retry guidance. Prepended so prompt.ts's completion trailer stays last.
      const workerContract = `## Harness contract\n- This harness is non-interactive: make one continuous pass; do not stop for questions or follow-up input.\n- You have a ${taskTimeoutMinutes} minute stall window. The gates run the full suite for you — never spend this window on one; commit your work and emit the completion trailer inside it.\n- Each test: acceptance criterion must exist as a vitest test whose OWN title (the leaf, not counting enclosing describe titles) is the criterion string verbatim — never shortened, never decorated. Nesting under describe() is allowed.`; // OBS-64; OBS-511: leaf-title rule stated where the worker reads it; OBS-548: the suite is the GATES' job — this repo's own suite outlasts the output-silence windows the daemon polices, so a worker obeying "budget the full suite" was killed by construction
      // OBS-47: state the worktree layout contract in the worker prompt (cheap-tier workers were
      // committing/deleting node_modules and tripping the scope gate). The harness re-asserts the link
      // itself before gates regardless of what the worker does with it.
      writeFileSync(promptFile, `${WORKTREE_LAYOUT_CONTRACT}\n\n${workerContract}\n\n${readFileSync(promptFile, "utf8")}`);
      const adapter = getAdapter(assignment.adapter, adapters);
      if (adapter.trustDialog && !trackedDriver.sendKey) noteCapabilityAbsent("sendKey");

      // VIS-04: workers share one role tab. T2: `owned` names the pane canonically (ownership contract);
      // the legacy name stays the fallback for drivers without owned handling (subprocess spies).
      const workerSlotOpts = {
        group: "workers",
        owned: { role: "worker" as const, taskId: t.id, attempt, runId },
      };
      // Keep the established enumerable slot-options shape consumed by legacy drivers while making
      // the adapter hook available as an own request field to execution surfaces such as Orca.
      Object.defineProperty(workerSlotOpts, "agent", { value: assignment.adapter });
      const slot = await trackedDriver.slot(
        wt,
        `${t.id}-worker-${assignment.adapter}-a${attempt}-${runTag}`,
        workerSlotOpts,
      );
      const sessionId = retryMode === "resume" ? priorSession!.id : slot.name;
      const readResumeTranscript = () => {
        try {
          const sample = adapter.readSessionTranscript?.({ cwd: wt, id: sessionId });
          return sample && Number.isSafeInteger(sample.bytes) && sample.bytes >= 0 ? sample : null;
        } catch {
          return null;
        }
      };
      const resumeBaseline = retryMode === "resume" ? readResumeTranscript() : null;
      if (retryMode === "resume") journal.append("worker-resume-requested", t.id, {
        sessionId, attempt, workerDispatchOrdinal, baselineBytes: resumeBaseline?.bytes ?? null,
      });
      const icmd = retryMode === "resume"
        ? adapter.resumeCommand!(sessionId, promptFile, assignment.model, assignment.effort)
        : cfg.visibility.worker === "interactive" && driver.interactive
          ? adapter.interactiveCommand(promptFile, assignment.model, assignment.effort)
          : null;
      // v1.69 T6: adapters that declare interactiveSeed launch the real TUI and inject the prompt as a
      // user turn; they do NOT need the argv-seeding surface that interactiveCommand represents.
      const hasSeed = retryMode !== "resume" && cfg.visibility.worker === "interactive" && driver.interactive && !!adapter.interactiveSeed;
      if (cfg.visibility.worker === "interactive" && icmd === null && !hasSeed && !modeFallbackNoted) {
        modeFallbackNoted = true;
        journal.append("worker-mode-fallback", t.id, { reason: driver.interactive ? "adapter" : "driver" });
      }

      const interactive = icmd !== null || hasSeed;
      // OBS-85 (v1.62 T1): both dispatch branches deliver ONE short script invocation — banner,
      // adapter command, and nonce exit marker live in a per-attempt script beside the prompt
      // artifact (the same paneDispatchCommand pattern judge/review/consult dispatches use). The
      // delivered pane line carries no command substitution and no trailing shell text, so paste
      // timing can never interleave a `$(…)` with what follows it (the codex corruption class).
      const workerCmd = interactive
        ? (hasSeed ? ":" : icmd)
        : adapter.invoke(t, wt, assignment, { promptFile }).command;
      const dispatchScript = promptFile.replace(/\.md$/, ".sh");
      // Approval can reset the attempt counter while the old pane remains retained.
      // Its ownership claim must survive a new engagement reusing the script path.
      const groupFile = `${dispatchScript}.${nonce}.pgid`;
      workerOwners.set(slot, { taskId: t.id, attempt, groupFile, marker: dispatchScript, identities: new Map(), descendants: new Map() });
      writeFileSync(dispatchScript, [
        // Shell startup can swallow the driver's leading cd; the payload owns its checkout too.
        `cd ${shq(wt)} || exit 1`,
        `export ${VITEST_CACHE_ENV}=${shq(worktreeVitestCache(wt))}`,
        // A driver may launch inside the daemon's group. That group is never worker-owned.
        `worker_pgid=$(ps -o pgid= -p $$ 2>/dev/null); daemon_pgid=$(ps -o pgid= -p ${process.pid} 2>/dev/null)`,
        `if [ -n "$worker_pgid" ] && [ -n "$daemon_pgid" ] && [ "$worker_pgid" != "$daemon_pgid" ]; then printf '%s\\n' "$worker_pgid" > ${shq(groupFile)}; fi`,
        `ps -o sess= -p $$ > ${shq(`${groupFile}.session`)} 2>/dev/null`,
        `ps -o pid=,lstart= -p $PPID > ${shq(`${groupFile}.parent`)} 2>/dev/null`,
        "export BASH_SILENCE_DEPRECATION_WARNING=1",
        bannerShell(),
        `printf '%s\\n' 'TICKMARKR_DISPATCH_${nonce}'`,
        workerCmd,
        exitMarkerCmd,
      ].join("\n"));
      const workerTransport = heldWorkerTransport(driver, slot, nonce,
        (data) => journal.append("held-probe", t.id, { ...data, slot: slot.id, attempt }));
      // T2 (OBS-264): the liveness triad, shared by BOTH wait loops (a headless worker stalls on
      // finished work exactly as a visible one does — and rode the whole window before this). It
      // sits ABOVE the fast-kill and the nudge because the population it governs is the opposite
      // one: the kill condemns a pane holding NOTHING, while every one of the 18 observed stalls
      // held 2-33 commits that the redispatch then re-bought. Concluding is not killing — the
      // post-loop tail harvests this attempt exactly as a window expiry does, and the carried
      // worktree goes to gates. The probe runs only once the tracker is ALREADY silent, so a
      // working worker never pays for it, and an unreadable snapshot RESETS the observation:
      // unmeasurable CPU is never evidence a worker stopped.
      // v1.85 T3: the prompt has now actually reached a worker. The journal-derived retry decisions (a
      // funded repair's findings, an identical-retry ban) expire HERE and nowhere earlier: everything
      // between task-dispatch and this line — worktree recreation, setup, prompt write, slot allocation,
      // the launch itself — can still die with no worker having seen the brief, and `--retry-failed`
      // must then re-send that same brief rather than a fresh prompt on a possibly banned channel.
      let workerLaunchedAt: number | undefined;
      const noteLaunched = async () => {
        // Startup evidence begins when the worker exists, not while prompt preparation, slot
        // allocation, or interactive readiness is still consuming the attempt wall clock.
        workerLaunchedAt ??= Date.now();
        journal.append("worker-launch", t.id, {
          attempt,
          retryMode,
          // OBS-1109: the attempt's own ownership evidence, so a resumed daemon can harvest it.
          nonce, dispatchScript,
          ...(retryMode === "resume" ? { sessionId, workerDispatchOrdinal } : {}),
          driver: trackedDriver.id,
          slot: { ...slot },
          workspace: driver.id === "herdr" ? process.env.HERDR_WORKSPACE_ID : undefined,
          ...(trackedDriver.describe ? await trackedDriver.describe(slot) : {}),
        });
      };
      const noteWorkerLiveness = (event: "worker-dead" | "worker-dead-held", data: Record<string, unknown>) =>
        journal.append(event, t.id, { ...data, source: trackedDriver.readSource ?? "driver.read" });
      let cpuFlat: { ms: number; since: number } | undefined;
      let cpuAccountant: WorkerTreeCpuAccountant | undefined;
      let cpuGapCount = 0;
      let unmeasurableNoted = false;
      // One line per attempt, whichever way the CPU leg turns out to be unmeasurable. A triad that
      // can never conclude is this feature silently ABSENT — on a host whose `ps` the probe cannot
      // read, every stall would ride its whole window out again with nothing saying why. Named once
      // per attempt, not per slice: the condition is structural, and a per-slice line would bury it.
      const noteUnmeasurable = (reason: string) => {
        if (unmeasurableNoted) return;
        unmeasurableNoted = true;
        journal.append("worker-harvest-unmeasurable", t.id, { slot: slot.name, attempt, reason });
      };
      // OBS-548: ONE instrument, TWO readers. The harvest triad asks this accountant whether a
      // COMMITTED worker is at rest; the dead-channel fast-kill asks whether a SILENT worker is
      // alive at all — and until v1.97 the kill asked nothing, so a tree holding 219,290 ms of
      // CPU accruing at ~90 ms/s was declared dead while this very accountant ran beside it in the
      // same loop. Both readers arm through `armCpuLeg` and read through `readCpuLeg`: a per-reader
      // lifecycle would let one tear the sampler down inside the other's window, and a restarted
      // accountant re-bases its monotonic total and can then never read flat.
      // "accruing" also covers NOT YET PROVEN FLAT — until the flat window closes, the tree has not
      // been observed at rest, and no reader may conclude on it.
      type CpuLeg =
        | { state: "flat"; cpu: { ms: number; resolutionMs: number } }
        | { state: "accruing" | "unmeasurable" };
      // The CPU leg needs a marker in the worker's own argv, and every launch path puts this
      // attempt's dispatch script there EXCEPT interactiveSeed: runInteractiveSeed launches the
      // TUI directly, by a command the ADAPTER owns (seed.launch(model)) which tickmarkr cannot
      // make attempt-unique and must deliver verbatim. A marker that matches nothing reads as
      // zero CPU — precisely the false "flat" that would harvest a worker mid-turn — so a seeded
      // attempt has no measurable CPU leg and neither reader ever concludes it. The other half of
      // OBS-264 is untouched there: when its window does expire with commits on the worktree, the
      // no-trailer tail gates them instead of buying a fresh worker to re-produce them.
      const armCpuLeg = async (armed: boolean): Promise<void> => {
        if (!armed) {
          await cpuAccountant?.stop();
          cpuAccountant = undefined;
          cpuFlat = undefined;
          cpuGapCount = 0;
          return;
        }
        if (hasSeed || cpuAccountant !== undefined) return;
        cpuAccountant = new WorkerTreeCpuAccountant(dispatchScript, wt, () => readOwnedProcessGroup(groupFile), workerOwners.get(slot)!.descendants);
        await cpuAccountant.start();
      };
      const readCpuLeg = (): CpuLeg => {
        if (hasSeed) {
          noteUnmeasurable("interactive-seed launch is not in the probed process tree");
          return { state: "unmeasurable" };
        }
        if (cpuAccountant === undefined) return { state: "unmeasurable" }; // no window open: nothing measured yet
        const observation = cpuAccountant.read();
        if (observation.gaps !== cpuGapCount) {
          cpuGapCount = observation.gaps;
          cpuFlat = undefined;
          noteUnmeasurable("one or more worker process snapshots could not be read");
        }
        const cpu = observation.cpu;
        if (cpu === undefined) {
          // Unmeasurable CPU is never evidence a worker stopped: RESET the observation rather than
          // conclude on it, and name the gap — a probe whose snapshot never parses is the same
          // structural hole as the seeded launch, and must not be the one that stays silent.
          cpuFlat = undefined;
          noteUnmeasurable("the worker process snapshot could not be read");
          return { state: "unmeasurable" };
        }
        const now = Date.now();
        if (cpu.ms !== cpuFlat?.ms) {
          cpuFlat = { ms: cpu.ms, since: now };
          return { state: "accruing" };
        }
        return now - cpuFlat.since < harvestCpuFlatWindowMs(cpu.resolutionMs)
          ? { state: "accruing" }
          : { state: "flat", cpu };
      };
      const harvestConcludes = async (silentMs: number): Promise<boolean> => {
        if (silentMs < harvestSilentMs) return false;
        const leg = readCpuLeg();
        if (leg.state !== "flat") return false;
        const carried = await commitsAheadOf(taskBase, wt);
        if (carried.length === 0) return false; // nothing landed: not this branch's population
        journal.append("worker-harvest", t.id, {
          slot: slot.name, attempt, commits: carried.length,
          silentMs, cpuMs: leg.cpu.ms, cpuResolutionMs: leg.cpu.resolutionMs,
        });
        return true;
      };
      // SPEND-01: this attempt's dispatch wall-clock — the usage collect cursor. Captured once here, the
      // single site, so a test can reason about it; keep Date.now() out of profile.ts (still pure) and
      // out of adapter module scope (the cursor is a parameter, threaded from the daemon).
      const attemptStart = Date.now();
      // v1.23 T2: once-per-attempt latch for context threshold crossing. Sample ONLY at existing worker
      // wait slices — never a new timer loop. null/unknown usage fails OPEN
      // (never treated as over-threshold). Journal + notify fire at most once while the value stays high.
      let contextWarned = false;
      let contextTokens: number | undefined;
      const sampleContext = async () => {
        if (!adapter.contextUsage) return;
        let usage: { tokens: number; limit?: number } | null = null;
        try {
          // SessionRef id stays stable across resume attempts; adapters return null on a store miss.
          usage = adapter.contextUsage({ cwd: wt, id: sessionId });
        } catch {
          return; // fail-open: a broken reader never blocks the attempt
        }
        if (!usage || typeof usage.tokens !== "number" || !Number.isFinite(usage.tokens)) return;
        contextTokens = usage.tokens; // last known valid sample, including under-threshold resume candidates
        if (contextWarned || usage.tokens < cfg.contextWarnTokens) return;
        contextWarned = true;
        lastContextTokens = usage.tokens;
        journal.append("context-sample", t.id, {
          tokens: usage.tokens,
          ...(usage.limit !== undefined ? { limit: usage.limit } : {}),
          threshold: cfg.contextWarnTokens,
          attempt,
        });
        await driver.notify(
          `tickmarkr ${runId}: ${t.id} context ${usage.tokens} tokens ≥ ${cfg.contextWarnTokens}`,
          { tier: "attention" },
        );
      };
      let finished: boolean;
      let output: string;
      let exitCode: number | null;
      let timedOut = false;
      // OBS-548 addendum: the mechanism that fired is what the repair brief and the consult read.
      // A fast-kill lands with the rolling window nowhere near expiry (measured: 693 s of silence
      // inside a 1,800,000 ms window), so the trailer-less tail's stall-timeout fallback named a
      // window that could not have killed anything and briefed the next worker to fix a stall that
      // never happened. Fourth conflation in the taxonomy OBS-53 opened.
      let deadChannelKilled = false;
      let hardTimedOut = false;
      let quotaBannerKilled = false;
      let capacityBannerKilled = false; // OBS-1161: same banner filter and gates, transient outcome
      let driverProbeFailed = false;
      let heldLegs: string[] = [];
      // OBS-1108: contact uncertainty is LATCHED per owned slot and dispatch (this attempt's slot): one
      // row when contact is lost and one when it returns, never one per retry. Retries back off while
      // latched, and a latch held past its deadline throws into the transport-uncertain park, which
      // preserves the worktree for a recheck. A read that recovers inside the deadline charges nothing.
      let contactLost: { since: number; retries: number } | undefined;
      const contactDeadlineMs = contactUnreadableDeadlineMs ?? taskTimeoutMinutes * 60_000;
      const noteDriverUnreadable = (error: unknown) => {
        if (error instanceof HeldProbeExhausted) throw error;
        driverProbeFailed = true;
        heldLegs = ["quota:driver-unreadable", "stall:driver-unreadable"];
        const message = error instanceof Error ? error.message : String(error);
        if (contactLost) {
          contactLost.retries++;
          const unreadableMs = Date.now() - contactLost.since;
          if (unreadableMs >= contactDeadlineMs) {
            throw new ContactUnreadableExhausted(`contact with ${slot.name} unreadable for ${unreadableMs}ms, past its ${contactDeadlineMs}ms deadline, after ${contactLost.retries} retries: ${message}`);
          }
          return;
        }
        contactLost = { since: Date.now(), retries: 0 };
        journal.append("contact-unreadable", t.id, { slot: slot.name, attempt, source: "driver", state: "unreadable",
          concludes: false, deadlineMs: contactDeadlineMs, error: message });
      };
      const noteContactReadable = () => {
        if (!contactLost) return;
        journal.append("contact-recovered", t.id, { slot: slot.name, attempt, source: "driver", state: "readable",
          unreadableMs: Date.now() - contactLost.since, retries: contactLost.retries });
        contactLost = undefined;
      };
      // The pause after a slice whose contact probe failed. Unlatched: the unspent slice, at most 1 s.
      // Latched: a next-contact-at schedule of its own — doubling per retry, bounded by the contact and
      // hard deadlines and NEVER by the poll slice, which clamps to 100 ms once the stall clock expires
      // and would otherwise collapse the backoff into ~10 orca calls a second for the rest of the window.
      const contactPauseMs = (sliceStart: number, slice: number, hardDeadline: number): number => {
        const now = Date.now();
        if (!contactLost) return Math.max(0, Math.min(slice - (now - sliceStart), CONTACT_BACKOFF_BASE_MS));
        return Math.max(1, Math.min(CONTACT_BACKOFF_BASE_MS * 2 ** Math.min(contactLost.retries, CONTACT_BACKOFF_DOUBLINGS),
          contactLost.since + contactDeadlineMs - now, hardDeadline - now));
      };
      // T2 review: print mode's "the exit marker appeared". Kept apart from `finished` (the
      // trailer) but still needed by the keepPanes decision below, whose contract is about a
      // subprocess tree that REACHED its exit marker, not about what the worker claimed.
      let processExited = false;
      let earlyLaunchDead = false;
      let startupFailure = false;
      let startupEvidence: StartupFailureEvidence | undefined;
      const startupDetector = new StartupFailureDetector(adapter);
      // OBS-1169: bootstrap text is evidence only inside the same startup prefix — every sample below
      // feeds it, so a tool frame, an input box or a saturated read seen at ANY poll closes it for good.
      const bootstrapDetector = new StartupFailureDetector(adapter, BOOTSTRAP_FAILURE_RE, true);
      const startupFailureInWindow = (text: string, launchedAt: number | undefined): boolean => {
        bootstrapDetector.sample(text, launchedAt);
        startupEvidence ??= startupDetector.sample(text, launchedAt);
        return startupEvidence !== undefined;
      };
      let deadWorkerPark: { ref: string; reason: string } | undefined;
      let settleParsed: WorkerResult | undefined;
      const trailerFrames = interactive && adapter.busyFrameMarkers
        ? new SettledTrailerTracker(adapter.busyFrameMarkers) : undefined;
      const sampleTrailer = (frame: string) => {
        const parsed = adapter.parse(frame, nonce);
        // OBS-1175: the parser's cause, never the summary — a parsed trailer may carry a sentinel string.
        const trailer = new RegExp(trailerPattern(nonce)).test(frame) && parsed.cause === undefined;
        return trailerFrames ? trailerFrames.sample(frame, trailer) : trailer;
      };
      let seedResult: InteractiveSeedResult | undefined;
      // v1.22 T5 / OBS-19: auto-answer a fingerprint-matched trust dialog exactly once per slot.
      // Any other blocked/idle dialog pages the operator (unlatched since T1 — see below).
      // v1.89 T19: the latch is PER SLOT, and the seed launch shares this slot — it answers the
      // startup modal before the readiness banner the loop below can only run after. So it is
      // declared HERE, above every exit from the launch, and armed by the seed's own report the
      // instant the key is spent. Review round 8 (material): initializing it from the RETURNED
      // result only was not every path — the seed line delivered after the answer throws
      // DeliveryReadinessError, and that catch continues or returns with no result to read, so a
      // latch built from one would start false with the key already sent, and the next modal on
      // this slot would get the free Enter this contract exists to prevent.
      let trustAnswered = trustAnsweredSlots.has(slot.id);
      const noteSeedTrustAnswered = () => {
        if (trustAnswered) return;
        trustAnswered = true;
        trustAnsweredSlots.add(slot.id);
        // Same audit line the loop below writes, so a live run shows the answer wherever it happened.
        journal.append("trust-auto-answer", t.id, { slot: slot.name, adapter: adapter.id, phase: "seed" });
      };
      const handleDeliveryReadiness = async (error: DeliveryReadinessError): Promise<boolean> => {
        journal.append("delivery-readiness-failed", t.id, {
          attempt,
          waitedMs: error.waitedMs,
          transcript: error.transcript,
        });
        if (keepOpen) keptSlots.push(slot);
        else await closeSlot(slot);
        feedback = withCarriedEvidence(`delivery readiness failed after ${error.waitedMs}ms; pane transcript:\n${error.transcript}`);
        const step = r.ladder[Math.min(ladderIdx++, r.ladder.length - 1)];
        journal.append("escalation", t.id, { step, attempt: attempt + 1 });
        await driver.notify(`tickmarkr ${runId}: ${t.id} escalation: ${step}`, { tier: "attention" });

        if (step === "retry") return true;
        if (step === "escalate") {
          const next = failover("escalate");
          if (next) {
            assignment = next;
            tried.push(channelKey(next));
            return true;
          }
          // no channel left — fall through to a consult
        }
        if (step === "escalate" || step === "consult") {
          const v = await runConsult("delivery-readiness", error.transcript, feedback, []);
          return applyVerdict(v, attempt + 1, "dispatch");
        }
        await park(t, "escalation ladder exhausted", "ladder-exhausted", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
        return false;
      };
      // OBS-1169: the tree this worker receives — commits past it are this attempt's own work; the
      // carried ones beneath it are not, and must not make a bootstrap death look like work.
      const launchHead = await gitHead(wt);
      try {
      if (interactive) {
        // v1.2 interactive: the TUI doesn't exit on completion — the trailer is the finish line.
        // The exit wrapper still fires if the TUI dies (crash/quit): fast-fail instead of burning the timeout.
        finished = false;
        exitCode = null;
        // Snapshot the exact tree the worker is about to receive. This immutable launch observation
        // answers the fast-kill's worktree clause; a separate rolling observation below identifies
        // each new worker change so it can rearm the stall clock exactly once.
        const launchWorktreeObservation = await observeWorktree(wt);
        let priorWorktreeObservation = launchWorktreeObservation;
        let worktreeUnreadableNoted = false;
        if (adapter.interactiveSeed) {
          // v1.69 T6: launch the real TUI without a prompt, wait for readiness, inject one seed turn,
          // then fall through to the normal trailer harvest. A failed seed is recorded as a finished
          // failure rather than allowed to race the trailer wait.
          try {
            seedResult = await runInteractiveSeed({
              driver: trustAnswered ? {
                run: workerTransport.run.bind(workerTransport), waitOutput: workerTransport.waitOutput.bind(workerTransport), read: workerTransport.read.bind(workerTransport),
              } : { ...trackedDriver, ...workerTransport },
              slot, adapter, assignment, promptFile, taskTimeoutMinutes,
              onTrustAnswered: noteSeedTrustAnswered,
            });
          } catch (error) {
            if (!(error instanceof DeliveryReadinessError)) throw error;
            if (await handleDeliveryReadiness(error)) continue attempts;
            return;
          }
          await noteLaunched();
          output = seedResult.output;
        } else {
          try {
            await workerTransport.run(slot, paneDispatchCommand(dispatchScript));
          } catch (error) {
            if (!(error instanceof DeliveryReadinessError)) throw error;
            if (await handleDeliveryReadiness(error)) continue attempts;
            return;
          }
          await noteLaunched();
          // OBS-1108: the first owned-slot read joins the contact latch — an unreadable launch read is
          // retried by the wait loop below under the same deadline, never a task failure on its own.
          output = await workerTransport.read(slot, PANE_READ_ROWS).catch((error) => { noteDriverUnreadable(error); return ""; });
        }
        // The returning paths report the same fact on the result; both callbacks land on the one
        // latch, and the second is a no-op. A seed that answered is never re-answered by the loop.
        if (seedResult?.trustAnswered) noteSeedTrustAnswered();
        startupFailure = startupFailureInWindow(output, workerLaunchedAt);
        if (seedResult?.seedFailed || startupFailure) {
          finished = false;
        } else {
          // OBS-201: one liveness nudge per attempt; the grace deadline is its OWN timer, never the
          // stall window (the nudge's pane echo is absorbed before it starts, or the echo itself
          // would reset the window and make the early conclusion unreachable).
          let nudged = false;
          let nudgeFailed = false; // T1: an undeliverable nudge — the operator, not the daemon, is the actor
          let nudgeDeadline: number | undefined;
          // T1: page cadence, NOT a latch — a second page fires on a status change or once
          // pageRepeatMs elapses, so an operator who missed the first one is paged again.
          let lastPagedStatus: string | undefined;
          let lastPagedAt = 0;
          let pagesSuppressed = 0; // OBS-1006: pageable slices swallowed by the cadence since the last row
          // T1 review: worker-status is journaled on CHANGE, not per slice — every journal append
          // is narrated to the run's live surface (cli/commands/run.ts) and feeds activity.ts's
          // `now:` cell, so a per-slice append wrote a status line per worker per ~30s slice and
          // pinned `now` to worker-status. On-change keeps post-hoc analysis at a fraction of the
          // volume while still recording which gate held.
          let lastStatus: string | undefined;
          finished = false;
          exitCode = null;
          // OBS-54: reaping keys on new pane output, not dispatch wall clock. Poll at least twice per
          // stall window (and at the existing 30s cadence for normal windows) so an active worker resets it.
          const stallWindowMs = taskTimeoutMinutes * 60_000;
          // v1.76: only monotonic work (seed submission, transcript growth, or context growth) resets
          // the stall clock. Raw pane differences are terminal chrome until proven otherwise.
          let everHadOutput = output.length > 0;
          const stallProgress = new StallProgressTracker();
          stallProgress.observe({ paneText: output, seedSubmitted: true, contextTokens });
          let lastProgressAt = Date.now();
          // T1: in-loop detector state — consecutive quota-banner slices. The dead-channel fast-kill
          // reads the tracker's RAW row-growth clock (lastRowGrowthAt), not the re-arm-suppressed
          // lastProgressAt — see the kill below.
          let quotaStreak = 0;
          let rowSaturationHeld = false; // journaled once per attempt when the kill stands down
          let cpuHeld = false; // likewise for the CPU leg's stand-down (OBS-548)
          let paneReadHeld = false;
          let transportHeldNoted = false; // row 108: an open transport is journaled once per attempt
          let paneStatusHeld = false;
          const hardDeadline = attemptStart + (attemptHardTimeoutMs ?? stallWindowMs * 4);
          await armCpuLeg(true);
          while (Date.now() < hardDeadline) {
            if (termSignal) throw new Error(`terminated by ${termSignal}`);
            fatalStop.signal.throwIfAborted();
            executionSignal()?.throwIfAborted();
            driverProbeFailed = false;
            const sliceStart = Date.now();
            const remaining = Math.max(100, Math.min(stallWindowMs - (sliceStart - lastProgressAt), hardDeadline - sliceStart));
            let slice = Math.min(BLOCKED_POLL_MS, Math.max(100, Math.min(stallWindowMs / 2, remaining)));
            const startupLeft = workerLaunchedAt === undefined
              ? 0
              : workerStartupWindowMs - (sliceStart - workerLaunchedAt);
            if (startupLeft > 0) slice = Math.min(slice, Math.max(1, startupLeft));
            if (!everHadOutput) {
              const earlyLeft = earlyLaunchLivenessMs - (sliceStart - attemptStart);
              if (earlyLeft > 0) slice = Math.min(slice, earlyLeft);
            }
            // T2 (OBS-264): never sleep PAST the instant the harvest probe becomes eligible, and past
            // it let the probe own the cadence (HARVEST_POLL_MS) — a 30s trailer slice would
            // otherwise cost a minute per pair of CPU samples. At the shipped 5m gate this leaves
            // every slice before the gate exactly as long as it already was.
            slice = Math.min(slice, harvestSliceMs(sliceStart - lastProgressAt));
            slice = Math.min(slice, remainingExecutionMs() ?? slice);
            if (await workerTransport.waitOutput(slot, `(${trailerPattern(nonce)})|TICKMARKR_EXIT_${nonce}:\\d`, slice, { regex: true }).catch((error) => { noteDriverUnreadable(error); return false; })) {
              // verify before accepting: a worker that merely DISPLAYS a marker (e.g. editing tickmarkr's
              // own source, where "TICKMARKR_EXIT:" is a string literal) must not end the wait. Only a
              // parseable trailer or a digit-suffixed exit marker in the harvest is completion.
              output = await workerTransport.read(slot, PANE_READ_ROWS).catch((error) => { noteDriverUnreadable(error); return output; }); // TUI transcripts carry chrome — read deeper than print's 500
              finished = sampleTrailer(output);
              const exit = exitRe.exec(output);
              if (finished || (exit && !(trailerFrames && new RegExp(trailerPattern(nonce)).test(output)))) {
                exitCode = exit ? Number(exit[1]) : null; // null ⇔ the TUI is still alive
                processExited = exit !== null;
                await sampleContext(); // final poll-seam sample before leaving the wait
                break;
              }
              if (adapter.parse(output, nonce).cause === "malformed-verdict") break;
              if (trailerFrames && new RegExp(trailerPattern(nonce)).test(output)) {
                // A matching busy frame is still a live turn. Preserve the rolling progress budget.
                await sampleContext();
                if (stallProgress.observe({ paneText: output, contextTokens })) lastProgressAt = Date.now();
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
                continue;
              }
            }
            // A failed pane read is absence of evidence, never evidence of an absent pane. Keep the
            // rolling taskTimeoutMinutes window as the backstop and name the held probe once.
            let paneText: string;
            try {
              paneText = await workerTransport.read(slot, PANE_READ_ROWS);
            } catch (error) {
              noteDriverUnreadable(error);
              if (!paneReadHeld) {
                paneReadHeld = true;
                noteWorkerLiveness("worker-dead-held", {
                  slot: slot.name, attempt, reason: "pane-read-unreadable",
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              await armCpuLeg(true);
              await new Promise((r) => setTimeout(r, contactPauseMs(sliceStart, slice, hardDeadline)));
              continue;
            }
            // waitOutput is only a wake hint; a driver may miss a trailer already painted.
            if (sampleTrailer(paneText)) {
              output = paneText;
              finished = true;
              const exit = exitRe.exec(output);
              exitCode = exit ? Number(exit[1]) : null;
              processExited = exit !== null;
              await sampleContext();
              break;
            }
            if (adapter.parse(paneText, nonce).cause === "malformed-verdict") {
              output = paneText;
              break;
            }
            if (driverProbeFailed) {
              await new Promise((resolve) => setTimeout(resolve, contactPauseMs(sliceStart, slice, hardDeadline)));
              continue;
            }
            if (paneText.length > 0) everHadOutput = true;
            if (startupFailureInWindow(paneText, workerLaunchedAt)) {
              startupFailure = true;
              output = paneText;
              break;
            }
            // OBS-117 (v1.71 T6): zero raw output by the early-launch deadline is a dead channel now.
            if (!everHadOutput && Date.now() - attemptStart >= earlyLaunchLivenessMs) {
              earlyLaunchDead = true;
              output = paneText;
              break;
            }
            // v1.23 T2: piggyback on this poll slice — same cadence as blocked/idle checks, no new timer.
            await sampleContext();
            if (stallProgress.observe({ paneText, contextTokens })) {
              lastProgressAt = Date.now();
              // T1 review fix: progress AFTER a delivered nudge means the worker answered it —
              // disarm the grace deadline. Without this the expiry below fires at the next
              // quiet patch ≥ the grace (4m) measured from the rolling lastProgressAt, so the
              // exact population the nudge rescued (workers prone to long silences, e.g. a 6m
              // test run) was force-concluded as if it had ignored the nudge. The answered
              // worker returns to the full rolling window, and the consult sees the truth.
              if (nudged && nudgeDeadline !== undefined) {
                nudgeDeadline = undefined;
                journal.append("worker-nudge-answered", t.id, { slot: slot.name, attempt });
              }
            }
            // This observation is independent of panes, scraped status and daemon delivery. The
            // immutable comparison says whether this attempt changed the launch tree; the rolling
            // comparison says whether a new filesystem/git change happened during this slice.
            const currentWorktreeObservation = await observeWorktree(wt);
            const worktreeSinceLaunch = compareWorktrees(launchWorktreeObservation, currentWorktreeObservation);
            const worktreeSincePriorRead = compareWorktrees(priorWorktreeObservation, currentWorktreeObservation);
            priorWorktreeObservation = currentWorktreeObservation;
            if (worktreeSincePriorRead === "changed") {
              lastProgressAt = Date.now();
              worktreeUnreadableNoted = false;
              journal.append("worker-contact", t.id, { slot: slot.name, attempt, evidence: "worktree" });
            } else if (worktreeSincePriorRead === "unreadable") {
              if (!worktreeUnreadableNoted) {
                worktreeUnreadableNoted = true;
                journal.append("contact-unreadable", t.id, { slot: slot.name, attempt, source: "worktree", concludes: false });
              }
            } else {
              worktreeUnreadableNoted = false;
            }
            const sliceNow = Date.now();
            // T1 (OBS-263): quota banners are classified IN-LOOP — two consecutive matching slices
            // plus >=3m tracker silence — then the post-loop quota failover runs NOW, not after the
            // window. The match reads the chrome-filtered tail: the bottom of a rendered TUI frame
            // is fixed composer/welcome chrome (codex pins a "usage limit resets available" line
            // there — it matched every frame of the wedged-MCP fixture), so the known chrome is
            // filtered by identity, never by novelty — a banner already on screen at launch
            // classifies exactly like one printed mid-attempt (T1 review: a novelty baseline
            // exculpated the launch-throttle case forever).
            // OBS-1161: a transient-capacity banner rides the SAME filter, streak and silence gates,
            // and concludes the attempt the same way — only its post-loop outcome differs (bounded
            // requeue on this seat, then same-floor failover, never demotion). Quota wins a tie.
            const bannerRows = stallSnapshotBannerRows(paneText);
            const quotaBanner = quotaSignal(bannerRows);
            const bannerMatch = quotaBanner ?? CAPACITY_RE.exec(bannerRows);
            if (bannerMatch) quotaStreak++;
            else quotaStreak = 0;
            if (bannerMatch && !quotaBanner && !stallProgress.rowSignalSaturated && !nudgeFailed
                && !(driver.nudge && NUDGEABLE_ADAPTERS.has(adapter.id) && (!nudged || nudgeDeadline !== undefined))
                && readCpuLeg().state === "flat"
                && quotaStreak >= 2 && sliceNow - lastProgressAt >= quotaBannerSilentMs) {
              capacityBannerKilled = true;
              journal.append("capacity-banner", t.id, { slot: slot.name, attempt, silentMs: sliceNow - lastProgressAt, matched: bannerMatch[0], excerpt: bannerMatch.input, regex: CAPACITY_RE.source });
              break;
            }
            if (quotaBanner && !stallProgress.rowSignalSaturated && !nudgeFailed
                && !(driver.nudge && NUDGEABLE_ADAPTERS.has(adapter.id) && (!nudged || nudgeDeadline !== undefined))
                && readCpuLeg().state === "flat"
                && quotaStreak >= 2 && sliceNow - lastProgressAt >= quotaBannerSilentMs) {
              // no `output =` here: the post-loop no-trailer tail re-reads the pane anyway, so an
              // assignment would only split the classification read from the verdict read.
              quotaBannerKilled = true;
              journal.append("quota-banner", t.id, { slot: slot.name, attempt, silentMs: sliceNow - lastProgressAt, matched: quotaBanner[0], excerpt: quotaBanner.input, regex: quotaBanner.source });
              break;
            }
            // T1 (OBS-262): the `paged` latch is deleted — status is sampled EVERY slice (and
            // journaled on change — see lastStatus above), so post-hoc analysis can see which
            // gate held. page on "idle" too: herdr's blocked-scrape is strict and proved flaky
            // for TUI dialogs (live check: cursor's trust dialog scraped as idle).
            // "unknown"/"working" never page.
            let st: string;
            try {
              st = await workerTransport.status(slot);
            } catch (error) {
              noteDriverUnreadable(error);
              if (!paneStatusHeld) {
                paneStatusHeld = true;
                noteWorkerLiveness("worker-dead-held", {
                  slot: slot.name, attempt, reason: "pane-status-unreadable",
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              await armCpuLeg(true);
              await new Promise((r) => setTimeout(r, contactPauseMs(sliceStart, slice, hardDeadline)));
              continue;
            }
            // OBS-1108: every contact probe of this slice answered (a failed wait or read continues
            // above), so only here — never after one probe while another stays latched — has contact returned.
            noteContactReadable();
            if (st !== lastStatus) {
              lastStatus = st;
              journal.append("worker-status", t.id, { slot: slot.name, status: st, attempt });
            }
            if (st === "blocked" || st === "idle") {
              // T5: once-per-slot auto-answer when the adapter declares a trust dialog and the pane
              // text matches. tickmarkr created the worktree from the operator's own repo — safe by construction.
              if (!trustAnswered && adapter.trustDialog && driver.sendKey) {
                try {
                  const paneText = await workerTransport.read(slot, 80);
                  if (matchesTrustDialog(paneText, adapter.trustDialog)) {
                    trustAnswered = true;
                    trustAnsweredSlots.add(slot.id);
                    // v1.25 T1: audit trail for live runs — prove the dialog appeared and was answered.
                    // Latch + sendKey + no-page continue stay byte-identical; this append is additive only.
                    journal.append("trust-auto-answer", t.id, { slot: slot.name, adapter: adapter.id });
                    await driver.sendKey(slot, adapter.trustDialog.key);
                    const spent = Date.now() - sliceStart;
                    if (spent < slice) await new Promise((r) => setTimeout(r, Math.min(slice - spent, 1_000)));
                    continue; // do not page — keep waiting for the trailer
                  }
                } catch (error) {
                  if (error instanceof HeldProbeExhausted) throw error;
                  /* read/send failed — fall through to page the operator */
                }
              }
            }
            // T1 (OBS-262): the daemon ACTS on a silent worker before paging anyone. Gate: monotonic
            // tracker silent ≥ the nudge threshold — the herdr status reading (idle/unknown/working)
            // no longer holds the gate hostage; only `blocked` stays page-only (nudging a dialog
            // prompt can't help). One nudge per attempt, then the grace timer owns the conclusion.
            const nudgeable = st !== "blocked" && !!driver.nudge && NUDGEABLE_ADAPTERS.has(adapter.id);
            // T1 review (answer-then-die): `nudgeable` is a per-slice property of the adapter and
            // status — it is NOT "a daemon action is pending". An action is pending only while the
            // nudge can still fire (un-nudged) or its grace window is armed; once the worker
            // ANSWERS, the disarm above clears nudgeDeadline while `nudged` stays latched, and the
            // daemon has nothing left to do — the pane falls back under the fast-kill and page
            // watchdogs like any other, instead of riding the whole rolling window untended.
            const nudgePending = nudgeable && (!nudged || nudgeDeadline !== undefined);

            // OBS-737: disposition for the one fully measured death state. `unknown` alone is not
            // absence (status parsing can fail), and an empty read alone is not absence (a live pane
            // can be quiet); together they are the existing driver-level pane absence witness. The
            // process probe and both worktree observations retain their own third states. Only the
            // explicit conjunction parks; every other state falls through to the unchanged rolling
            // timeout below. Seeded launches are excluded because their process marker is knowingly
            // unmeasurable (armCpuLeg documents that contract above).
            const paneAbsentCandidate = st === "unknown" && paneText.trim().length === 0;
            // A subprocess can exit between waitOutput and read while its stdout is still draining.
            // Confirm emptiness in this same poll before paying for `ps`; then confirm once more
            // after the process probe yielded the event loop. Any bytes or read error withdraw the
            // absence witness, so a fast completed worker cannot be parked in that drain race.
            let paneAbsent = paneAbsentCandidate;
            if (paneAbsent) {
              try {
                const confirmation = await workerTransport.read(slot, PANE_READ_ROWS);
                paneAbsent = confirmation.trim().length === 0;
                if (!paneAbsent) {
                  everHadOutput = true;
                  if (stallProgress.observe({ paneText: confirmation, contextTokens })) lastProgressAt = Date.now();
                }
              } catch (error) {
                if (error instanceof HeldProbeExhausted) throw error;
                paneAbsent = false;
                if (!paneReadHeld) {
                  paneReadHeld = true;
                  noteWorkerLiveness("worker-dead-held", {
                    slot: slot.name, attempt, reason: "pane-read-unreadable",
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
            const processTree = paneAbsent && worktreeSinceLaunch === "unchanged" && !hasSeed
              ? await observeWorkerProcessTree(dispatchScript, wt)
              : "unmeasurable";
            if (processTree === "empty") {
              try {
                const confirmation = await workerTransport.read(slot, PANE_READ_ROWS);
                paneAbsent = confirmation.trim().length === 0;
                if (!paneAbsent) {
                  everHadOutput = true;
                  if (stallProgress.observe({ paneText: confirmation, contextTokens })) lastProgressAt = Date.now();
                }
              } catch (error) {
                if (error instanceof HeldProbeExhausted) throw error;
                paneAbsent = false;
                if (!paneReadHeld) {
                  paneReadHeld = true;
                  noteWorkerLiveness("worker-dead-held", {
                    slot: slot.name, attempt, reason: "pane-read-unreadable",
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
            const worktreeDelta = processTree === "empty"
              && paneAbsent ? await observeWorktreeDelta(taskBase, wt)
              : "unreadable";
            // The first process snapshot can race a just-starting child after the dispatch pane
            // disappeared. Re-read it after the pane and worktree legs have both held: preservation
            // is terminal, so a process appearing in that interval must withdraw the park rather
            // than be orphaned by it. The final worktree recheck remains inside preserveDeadWorker.
            const confirmedProcessTree = worktreeDelta === "unchanged"
              ? await observeWorkerProcessTree(dispatchScript, wt)
              : "unmeasurable";
            // Queue row 108 (D-1619): the transport's own CLOSED fact. A subprocess 'exit' precedes its stdio 'close', so a
            // just-finished worker can look gone — no pane bytes, no process, an unchanged worktree — with its trailer still
            // in flight. Not closed, or a driver with no answer, never parks: the rolling timeout continues, as for every
            // other unproven leg. Pane drivers answer closed (their closure is the pane gone, already required above).
            // ORDER MATTERS: the closed fact is read FIRST, then the pane once more. Closed means every byte is already in
            // the read surface, so an empty read AFTER it proves the worker wrote nothing; the earlier empty reads may
            // predate the close and are not that proof (the stale-empty race this row's own test caught).
            const transport = confirmedProcessTree === "empty" ? await workerTransport.transportState?.(slot) : undefined;
            let drainedEmpty = false;
            if (transport?.closed === true) {
              try {
                const drained = await workerTransport.read(slot, PANE_READ_ROWS);
                drainedEmpty = drained.trim().length === 0;
                if (!drainedEmpty) {
                  everHadOutput = true;
                  if (stallProgress.observe({ paneText: drained, contextTokens })) lastProgressAt = Date.now();
                }
              } catch (error) {
                if (error instanceof HeldProbeExhausted) throw error;
              }
            }
            const deathCertain = paneAbsent
              && processTree === "empty"
              && confirmedProcessTree === "empty"
              && worktreeDelta === "unchanged"
              && transport?.closed === true
              && drainedEmpty;
            if (confirmedProcessTree === "empty" && transport?.closed !== true && !transportHeldNoted) {
              transportHeldNoted = true;
              noteWorkerLiveness("worker-dead-held", {
                slot: slot.name, attempt, reason: transport ? "transport-open" : "transport-unknown", ...(transport ? { transport } : {}),
              });
            }
            if (deathCertain) {
              const preservation = await preserveDeadWorker(wt, taskBase);
              if (!preservation.ref) {
                noteWorkerLiveness("worker-dead-held", {
                  slot: slot.name, attempt, reason: `worktree-${preservation.state}`,
                });
                continue;
              }
              const ref = preservation.ref;
              const reason = `worker is unambiguously dead: pane absent, process tree empty, and worktree unchanged; preserved at ${ref}`;
              deadWorkerPark = { ref, reason };
              journal.append("worktree-preserved", t.id, { ref, ...producerFields(producerNow()) });
              noteWorkerLiveness("worker-dead-held", {
                // row 108 legibility: the transport's closed state, byte count and exit code/signal (a kill shows its signal)
                slot: slot.name, attempt, reason: "unambiguous-worker-death", ref, transport,
              });
              break;
            }
            // T1 review fix: the kill's "no output growth" leg clocks off the RAW growth signals,
            // never lastProgressAt alone — the flat-token rule (stall.ts) deliberately suppresses
            // the re-arm report on row growth once tokens stick, and contextTokens is sticky across
            // read misses, so a metered non-nudgeable adapter (pi) streaming rows under a stale
            // counter presented a frozen lastProgressAt and was killed mid-work. lastRowGrowthAt is
            // recorded on every high-water advance, suppressed or not; token growth already rides
            // lastProgressAt. Either one advancing is output growth.
            const lastOutputGrowthAt = Math.max(stallProgress.lastRowGrowthAt ?? 0, lastProgressAt);
            // Everything the fast-kill can decide from the CHANNEL, evaluated before the CPU leg is
            // asked for a conclusion. The shared CPU reading is consulted at the kill below.
            const fastKillEligible = !nudgePending && !nudgeFailed
              && sliceNow - lastOutputGrowthAt >= deadChannelFastKillMs
              && worktreeSinceLaunch === "unchanged";

            // All silent conclusions share the attempt's continuous CPU ledger. A nudge
            // hold or a saturated pane must not reset its history before the stall boundary.
            await armCpuLeg(true);
            // T2 (OBS-264): the liveness triad CONCLUDES the wait on finished work — commits ahead
            // of the task base (this attempt's own AND any carried forward — see the eligibility
            // comment at the dispatch site), a flat worker-tree CPU delta, and >= harvestSilentMs
            // of monotonic tracker silence (defined once, above, and run identically by the print loop).
            // T2 review (material): it carries the SAME nudge hold as the fast-kill below, by the
            // same clause and for the same reason. The CPU leg cannot tell "idle because finished"
            // from "idle because holding an unsubmitted turn in its input box" — both read flat CPU
            // under a silent tracker — and the nudge is the one signal that can. Under the shipped
            // constants (harvest 5m < nudge 10m) an unheld harvest concluded every committed
            // claude-code worker before the rescue could fire, leaving T1's nudge dead code for
            // exactly the committed-and-stalled population OBS-264 is about. Holding concludes at
            // ~14m (nudge + grace) rather than ~36m — nearly all of the OBS-264 win, and a worker
            // that only needed a submit answers with a full trailer instead of partial work.
            // An ANSWERED nudge leaves nothing pending, so the triad governs again; the hold is on a
            // pending daemon ACTION, never on the adapter being nudgeable.
            // OBS-548: an UNDELIVERABLE nudge holds too. A worker inside one long foreground command
            // has no input box, so it is the population that CANNOT be nudged and is also the one
            // most likely to be legitimately silent — letting its delivery failure lift the hold made
            // the failure itself the trigger. `:357-359` already reads a false driver.nudge return as
            // a delivery outcome, "not proof of an unreachable channel"; unreachable is not at rest.
            if (!nudgePending && !nudgeFailed && await harvestConcludes(sliceNow - lastProgressAt)) break;
            // T1 (R1 dead-channel fast-kill): no trailer, an unchanged launch tree, and no output growth
            // for the fast-kill window — the channel is dead, so conclude NOW
            // (journaled) and let the existing no-trailer tail classify and route the attempt.
            // The tracker is the growth signal on purpose: raw pane bytes grow on cosmetic repaint
            // (an elapsed "9s"→"10s" lengthens the read and would hide a frozen pane). But the
            // tracker SHARES the read window's ceiling: its row signal saturates once a sample
            // FILLS a PANE_READ_ROWS read on raw lines (blanks/chrome included — see stall.ts),
            // and past that point a flat tracker means "unmeasurable", not "dead". Journal that
            // unreadability once, then let the independent CPU and worktree legs decide: accruing or
            // unreadable CPU preserves the worker; flat CPU beside an unchanged tree may conclude.
            // A saturated row alone is never a death verdict.
            // The triad has NO status exemption: a pane that herdr reports as blocked, idle, working
            // or unknown dies alike once it holds no trailer, an unchanged tree and no growth — waiting the
            // rolling window out on a status reading is exactly the blindness T1 removes. A matched
            // trust dialog is auto-answered above and `continue`s before ever reaching here.
            // The NUDGE gets first crack at a nudgeable pane: the fast-kill holds while the daemon
            // still has an action of its own pending (un-nudged, or inside the grace window) —
            // under the shipped constants (kill 5m < nudge 10m) a delta-less pane would otherwise
            // die before the rescue could ever fire. An ANSWERED nudge leaves nothing pending, so
            // the hold lifts and the triad governs again. Delivery success or failure never
            // supplies worktree evidence: only the immutable launch observation and the current
            // filesystem/git observation answer that clause.
            if (stallProgress.rowSignalSaturated && !rowSaturationHeld) {
              rowSaturationHeld = true;
              journal.append("contact-unreadable", t.id, {
                slot: slot.name, attempt, source: "pane-rows", reason: "row-signal-saturated", concludes: false,
              });
            }
            // OBS-548: the FOURTH leg, and the one the daemon already measured. The three legs above
            // are all channel-side: they say a pane stopped talking. The tree's CPU says whether
            // anything is still WORKING, and the harvest triad forty lines up refuses exactly this
            // conclusion without it — "a worker that is merely thinking still burns CPU and is never
            // concluded here". A live CPU delta is a live worker, by construction; an UNMEASURABLE
            // reading keeps the fail-open contract the probe already states (undefined is never
            // evidence a worker stopped), so on a host whose `ps` cannot be read the fast-kill stands
            // down and the fixed attempt ceiling bounds the hold.
            if (fastKillEligible) {
              const leg = readCpuLeg();
              if (leg.state === "flat") {
                deadChannelKilled = true;
                journal.append("worker-dead", t.id, {
                  slot: slot.name, attempt, silentMs: sliceNow - lastOutputGrowthAt,
                  cpuMs: leg.cpu.ms, cpuResolutionMs: leg.cpu.resolutionMs,
                  source: trackedDriver.readSource ?? "driver.read",
                });
                break;
              }
              if (!cpuHeld) {
                cpuHeld = true;
                noteWorkerLiveness("worker-dead-held", {
                  slot: slot.name, attempt, reason: leg.state === "accruing" ? "cpu-accruing" : "cpu-unmeasurable",
                });
              }
            }
            const stallCpu = readCpuLeg();
            heldLegs = [
              ...(stallProgress.rowSignalSaturated ? ["quota:row-signal-saturated", "stall:row-signal-saturated"] : []),
              ...(stallCpu.state !== "flat" ? [`stall:cpu-${stallCpu.state}`] : []),
              ...(nudgeFailed || nudgePending ? ["quota:nudge", "stall:nudge"] : []),
              ...(worktreeSincePriorRead === "unreadable" ? ["stall:worktree-unreadable"] : []),
            ];
            if (sliceNow - lastProgressAt >= stallWindowMs && heldLegs.length === 0) {
              timedOut = true;
              break;
            }
            if (nudgeable && !nudged && sliceNow - lastProgressAt >= nudgeAfterSilentMs) {
              nudged = true;
              // T1 review: a false return is a driver-delivery outcome (missing pin, readiness
              // stable-frame timeout, read-back hiccup), not proof of an unreachable channel — so
              // one failure is a flake class, retried once in-slice after a short settle. Only a
              // failed RETRY condemns the channel. Both failures happen inside this slice, so the
              // latch stays immediate and exactly one failure is journaled per attempt.
              let delivered = await driver.nudge!(slot, WORKER_NUDGE_MESSAGE).catch((error) => { noteDriverUnreadable(error); return false; });
              if (!delivered) {
                await new Promise((r) => setTimeout(r, NUDGE_REDELIVER_MS));
                delivered = await driver.nudge!(slot, WORKER_NUDGE_MESSAGE).catch((error) => { noteDriverUnreadable(error); return false; });
              }
              if (delivered) {
                // absorb the nudge's own echo BEFORE arming the grace timer — post-nudge progress
                // is measured against this baseline, not against the echo.
                const echo = await workerTransport.read(slot, PANE_READ_ROWS).catch((error) => { noteDriverUnreadable(error); return undefined; });
                if (echo !== undefined) stallProgress.observe({ paneText: echo, contextTokens });
                nudgeDeadline = Date.now() + workerNudgeGraceMs;
                journal.append("worker-nudge", t.id, { slot: slot.name, attempt });
              } else {
                // Delivery failure is journal evidence about the daemon's contact attempt only.
                // The fast-kill's worktree clause remains wholly filesystem/git-derived above.
                nudgeFailed = true;
                journal.append("worker-nudge-failed", t.id, { slot: slot.name, attempt, cause: "delivery-refused-or-unconfirmed" });
              }
            }
            if (!stallProgress.rowSignalSaturated && readCpuLeg().state === "flat" && nudged && nudgeDeadline !== undefined && sliceNow >= nudgeDeadline && sliceNow - lastProgressAt >= workerNudgeGraceMs) {
              // grace spent, still no post-nudge progress: re-harvest once (the trailer may have
              // landed between polls), then conclude the wait as a stall NOW — the consult sees the
              // un-answered nudge instead of the remainder of the window.
              const finalPane = await workerTransport.read(slot, PANE_READ_ROWS).catch((error) => { noteDriverUnreadable(error); return undefined; });
              if (finalPane === undefined) continue;
              nudgeDeadline = undefined;
              output = finalPane;
              finished = sampleTrailer(output);
              const exit = exitRe.exec(output);
              if (finished || (exit && !(trailerFrames && new RegExp(trailerPattern(nonce)).test(output)))) {
                exitCode = exit ? Number(exit[1]) : null;
                processExited = exit !== null;
                await sampleContext();
                break;
              }
              journal.append("worker-nudge-expired", t.id, { slot: slot.name, attempt, graceMs: workerNudgeGraceMs });
              timedOut = true;
              break;
            }
            // Unlatched page (T1): the page DECISION fires and is journaled every slice the
            // operator is the right actor — i.e. the nudge path doesn't own it (non-allowlisted
            // adapter, no nudge surface, or a blocked dialog) or the nudge was attempted and
            // FAILED. A nudgeable worker below the silence threshold waits for its nudge; a
            // DELIVERED nudge's pending grace suppresses the page — the daemon already acted. An
            // ANSWERED nudge has no action pending (the disarm cleared the deadline), so a pane
            // that then reads blocked/idle is the operator's again.
            // Delivery is unlatched too: the operator is notified again on a status change or
            // once pageRepeatMs elapses, so a missed first page is not the last one.
            const pageable = (st === "blocked" || st === "idle")
              && (!nudgePending || nudgeFailed);
            // OBS-1006: the row is appended INSIDE the delivery guard — one row per page delivered, never
            // one per slice — and it carries how many pageable slices were suppressed since the last one.
            if (pageable) {
              if (st !== lastPagedStatus || sliceNow - lastPagedAt >= pageRepeatMs) {
                journal.append("operator-page", t.id, { slot: slot.name, attempt, status: st, suppressed: pagesSuppressed });
                pagesSuppressed = 0;
                lastPagedStatus = st;
                lastPagedAt = sliceNow;
                const why = st === "blocked" ? "is blocked on a prompt — approve in its pane" : "looks idle without finishing — check its pane";
                await driver.notify(`tickmarkr ${runId}: ${slot.name} ${why}`, { tier: "attention" });
              } else {
                pagesSuppressed++;
              }
            }
            // a dead pane or a false-positive marker display returns fast — sleep the unspent slice, never hot-spin
            const spent = Date.now() - sliceStart;
            if (spent < slice) await new Promise((r) => setTimeout(r, Math.min(slice - spent, 1_000)));
          }
          // A wait that concludes on a clean slice's read (trailer, exit, startup failure) has contact back too.
          if (!driverProbeFailed) noteContactReadable();
          if (!finished && exitCode === null && adapter.parse(output, nonce).cause !== "malformed-verdict") {
            // OBS-1108: the hard deadline ended an attempt whose contact was still latched (its last
            // probe failed). That is contact loss, not a stall: keep the one infra park and the preserved
            // worktree instead of the hard-timeout classification and its repair charge.
            if (contactLost && driverProbeFailed && Date.now() >= hardDeadline) {
              throw new ContactUnreadableExhausted(`contact with ${slot.name} unreadable for ${Date.now() - contactLost.since}ms, still latched at the attempt's hard deadline after ${contactLost.retries} retries`);
            }
            // timed out (or only ever saw false positives): harvest whatever the pane holds now
            hardTimedOut = Date.now() >= hardDeadline;
            timedOut ||= hardTimedOut;
            if (hardTimedOut) journal.append("worker-hard-timeout", t.id, { slot: slot.name, attempt, heldLegs });
            try {
              output = await workerTransport.read(slot, PANE_READ_ROWS);
            } catch (error) {
              if (error instanceof HeldProbeExhausted) throw error;
              // The poll loop already recorded the unreadable pane. Retain the last readable bytes
              // so this ambiguous path still reaches the ordinary timeout/consult backstop.
            }
            finished = sampleTrailer(output);
            const exit = exitRe.exec(output);
            exitCode = exit ? Number(exit[1]) : null;
            processExited = exit !== null;
          }
          if (finished && !trailerFrames) {
            await workerTransport.waitAgentStatus(slot, "idle", 5_000).catch(noteDriverUnreadable);
            const settled = await workerTransport.read(slot, PANE_READ_ROWS).catch((error) => { noteDriverUnreadable(error); return output; });
            if (sampleTrailer(settled)) output = settled;
          }
          // T5 / OBS-111: an interactive harvest can race the TUI's final paint. When the pane
          // contains the nonce token but the JSON hasn't balanced yet, settle and re-read through
          // the existing pane-read seam once or twice before recording a malformed-trailer cause.
          if (interactive) {
            const stallWindowMs = taskTimeoutMinutes * 60_000;
            const settleDeadline = attemptStart + stallWindowMs;
            const settleDelayMs = 1_000;
            const maxSettleRetries = 2;
            let settleTries = 0;
            settleParsed = adapter.parse(output, nonce);
            while (settleParsed.cause === "malformed-verdict" && settleTries < maxSettleRetries) {
              const remaining = settleDeadline - Date.now();
              if (remaining <= 0) break;
              await new Promise((r) => setTimeout(r, Math.min(settleDelayMs, remaining)));
              output = await workerTransport.read(slot, PANE_READ_ROWS);
              trailerFrames?.sample(output, new RegExp(trailerPattern(nonce)).test(output));
              settleParsed = adapter.parse(output, nonce);
              settleTries++;
            }
            if (settleParsed.cause !== "malformed-verdict") {
              finished = settleParsed.cause === undefined && (!trailerFrames || trailerFrames.settled);
            }
          }
        }
      } else {
        try {
          await workerTransport.run(slot, paneDispatchCommand(dispatchScript));
        } catch (error) {
          if (!(error instanceof DeliveryReadinessError)) throw error;
          if (await handleDeliveryReadiness(error)) continue attempts;
          return;
        }
        await noteLaunched();
        // OBS-54: headless workers have the same output-inactivity budget as visible panes.
        // v1.76: same monotonic-progress measure as the interactive site; harvest stays raw.
        const stallWindowMs = taskTimeoutMinutes * 60_000;
        const initialPane = await workerTransport.read(slot, 500);
        startupFailure = startupFailureInWindow(initialPane, workerLaunchedAt);
        let everHadOutput = initialPane.length > 0;
        const stallProgress = new StallProgressTracker();
        stallProgress.observe({ paneText: initialPane, seedSubmitted: true, contextTokens });
        let lastProgressAt = Date.now();
        finished = false;
        // T2 review (material): the exit marker proves the PROCESS EXITED, never that the worker
        // emitted a trailer — the two were the same flag here, so a headless worker that committed
        // and exited cleanly without one entered the tail as finished:true, skipping the harvest
        // synthesis entirely and reaching gates with the worker's own ok:false and no
        // worker-result-harvested row. The interactive site has always kept them apart (`finished`
        // there is the trailer regex; the exit marker only sets exitCode), and the cause taxonomy
        // already names this shape "clean-exit-no-trailer" — unreachable in print mode until now.
        while (!startupFailure && Date.now() - lastProgressAt < stallWindowMs) {
          fatalStop.signal.throwIfAborted();
          executionSignal()?.throwIfAborted();
          const remaining = stallWindowMs - (Date.now() - lastProgressAt);
          let slice = Math.min(BLOCKED_POLL_MS, Math.max(100, Math.min(stallWindowMs / 2, remaining)));
          const startupLeft = workerLaunchedAt === undefined
            ? 0
            : workerStartupWindowMs - (Date.now() - workerLaunchedAt);
          if (startupLeft > 0) slice = Math.min(slice, Math.max(1, startupLeft));
          if (!everHadOutput) {
            const earlyLeft = earlyLaunchLivenessMs - (Date.now() - attemptStart);
            if (earlyLeft > 0) slice = Math.min(slice, earlyLeft);
          }
          // T2 (OBS-264): same probe cadence the interactive loop uses — see harvestSliceMs.
          slice = Math.min(slice, harvestSliceMs(Date.now() - lastProgressAt));
          slice = Math.min(slice, remainingExecutionMs() ?? slice);
          if (await workerTransport.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, slice, { regex: true })) {
            processExited = true;
            break;
          }
          const paneText = await workerTransport.read(slot, 500);
          if (paneText.length > 0) everHadOutput = true;
          if (startupFailureInWindow(paneText, workerLaunchedAt)) {
            startupFailure = true;
            break;
          }
          if (!everHadOutput && Date.now() - attemptStart >= earlyLaunchLivenessMs) {
            earlyLaunchDead = true;
            break;
          }
          await sampleContext();
          if (stallProgress.observe({ paneText, contextTokens })) lastProgressAt = Date.now();
          // T2 (OBS-264): the same liveness triad the interactive loop runs. A headless worker that
          // committed and went quiet is finished work too, and before this it rode the entire
          // window out before anything looked at its commits.
          // No nudge hold here, deliberately: print mode has no nudge surface at all (no pane to
          // steer, driver.nudge is never consulted on this path), so there is no pending daemon
          // action for the triad to preempt — the asymmetry with the interactive call site above is
          // the absence of the thing being held for, not an oversight.
          await armCpuLeg(Date.now() - lastProgressAt >= harvestSilentMs);
          if (await harvestConcludes(Date.now() - lastProgressAt)) break;
        }
        output = await workerTransport.read(slot, 500);
        exitCode = Number(exitRe.exec(output)?.[1] ?? 1);
        // Completion is the trailer, exactly as in the interactive loop. A process that exited
        // without one is finished:false with a non-null exitCode — the harvest synthesis then owns
        // it when the worktree carries work, and classifyWorkerResultCause names it otherwise.
        finished = new RegExp(trailerPattern(nonce)).test(output);
        timedOut = !processExited && !finished && Date.now() - lastProgressAt >= stallWindowMs;
      }
      } finally {
        await cpuAccountant?.stop();
      }
      // OBS-1169: the final pane read decides, at exit, whether the prefix is still the CLI's own startup.
      const bootstrapEvidence = processExited ? bootstrapDetector.sample(output, workerLaunchedAt) : undefined;
      // SPEND-01 interactive metering race: the harvest loop breaks on the trailer, but the worker
      // shell may still be running post-trailer bookkeeping (session-store flush, fake usage stamp,
      // exit wrapper). Print mode already waits for TICKMARKR_EXIT, which follows that tail; drain
      // interactive attempts to the same exit marker before close and the post-hoc usage disk read
      // so a writer never races the reader (real CLIs can flush usage asynchronously after the trailer).
      if (interactive && finished && !exitRe.test(output)) {
        await workerTransport.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, 2_000, { regex: true }).catch(noteDriverUnreadable);
      }
      // Free availability reroutes deliberately reuse the charged-attempt ordinal. Stream artifacts
      // cannot: every dispatch owns bytes that must remain independently recoverable, so derive the
      // append-only dispatch ordinal from the journal instead of overwriting an earlier a<n>.out.
      const streamAttempt = journal.read().filter((event) => event.event === "task-dispatch" && event.taskId === t.id).length - 1;
      const capturedStream = await captureWorkerStream(journal.dir, t.id, streamAttempt, { ...trackedDriver, ...workerTransport }, slot, output);
      // An interactive settle already selected the bounded parse it is allowed to use. Every other
      // path parses the common final stream snapshot — notably envelope adapters whose trailer is
      // encoded and therefore invisible to the raw wait regex. Keep `output` bounded: every text
      // classifier below retains its pre-artifact tail surface.
      let result = settleParsed ?? adapter.parse(capturedStream.output, nonce);
      const unsettledTrailer = trailerFrames && !trailerFrames.settled
        && (trailerFrames.busyMarkersSeen.size > 0 || new RegExp(trailerPattern(nonce)).test(capturedStream.output));
      if (unsettledTrailer) {
        result = { ok: false, summary: `premature-idle: trailer did not settle; busy markers: ${[...trailerFrames.busyMarkersSeen].join(", ") || "awaiting two idle samples"}`, deviations: [], raw: output };
      }
      const adapterCause = result.cause;
      // Law 46: there is one completion fact. A classified adapter result with no parse-failure cause
      // means its decoder found the nonce-bound trailer even when the raw JSON envelope escaped it.
      const workerFinished = !unsettledTrailer && (finished || adapterCause === undefined);
      finished = workerFinished;
      const adapterStartupFailure = adapterCause === "startup-failure";
      const workerCause = unsettledTrailer ? "premature-idle" : adapterStartupFailure
        ? "startup-failure"
        : startupFailure
          ? "startup-failure"
          : classifyWorkerResultCause({ output, ok: result.ok, finished: workerFinished, exitCode, summary: result.summary, timedOut, deadChannel: deadChannelKilled });

      // OBS-897/889(4): neither a timeout/quiet-harvest nor a trailer is a verdict on a tree while
      // its writer remains alive. Reap through the same driver lifecycle every execution surface
      // already implements, then (and only then) permit commitsAheadOf/gates below to read the tree.
      // A failed reap is a stall disposition, never permission to gate a moving branch.
      let reapFailure: string | undefined;
      if (!processExited && !deadWorkerPark) {
        try {
          await closeSlot(slot);
          if (!workerFinished) {
            const producer = producerNow();
            const ref = await preserveWorktree(wt, producer);
            if (ref) {
              journal.append("worktree-preserved", t.id, { ref, ...producerFields(producer) });
              reapedWorktreeRef = ref;
            }
            journal.append("worker-reaped-before-harvest", t.id, {
              slot: slot.name, attempt, cause: hardTimedOut ? "hard-timeout" : workerCause ?? "stall-timeout",
              ...reapReports.get(slot),
              ...(hardTimedOut ? { heldLegs } : {}),
              ...(startupEvidence ? { evidence: startupEvidence } : {}),
            });
          }
        } catch (error) {
          reapFailure = error instanceof Error ? error.message : String(error);
        }
      } else {
        // A worker that exited cleanly can still leave a census the reap cannot read. That is the
        // same stall disposition as above, never a silent task failure; a kept slot is recorded
        // first so run end still closes it (public CI 37324617042, D-1278).
        try {
          if (keepOpen && (workerFinished || processExited || driver.id !== "subprocess")) {
            keptSlots.push(slot);
            supersededWorkerSlot = slot;
            await reapWorker(slot);
          } else {
            await closeSlot(slot);
          }
        } catch (error) {
          reapFailure = error instanceof Error ? error.message : String(error);
        }
      }
      if (retryMode === "resume") {
        const transcript = readResumeTranscript();
        const identity = resumeBaseline === null || transcript === null
          ? "unknown" : transcript.bytes > resumeBaseline.bytes ? "confirmed" : "unconfirmed";
        journal.append("worker-resume-identity", t.id, {
          sessionId, attempt, workerDispatchOrdinal, identity,
          baselineBytes: resumeBaseline?.bytes ?? null, observedBytes: transcript?.bytes ?? null,
          // This is evidence of file growth, not an independent runtime identity handshake.
          assumption: "external runtime appends to the requested session's own transcript",
        });
      }
      // SPEND-01: usage from the harness's own cwd-keyed structured store, read POST-HOC from disk —
      // `wt` is this task's private worktree, so the path is unique; the read is sliced to records
      // stamped at/after this attempt's dispatch instant. Never the harvested pane text, never the
      // parsed worker trailer. No interactive branch: a TUI writes the same store. undefined ⇒ unmetered.
      // SPEND-02: fold this attempt's slice into the task accumulator only when it's a real observation —
      // an absent record leaves `tokens`/`metered` untouched (never a materialized zero).
      const attemptUsage = adapter.collectUsage?.(wt, attemptStart);
      if (attemptUsage) { tokens = addUsage(tokens, attemptUsage); metered++; }
      // An unreadable cleanup outranks a dead-worker park: only the reapFailure park re-verifies the census.
      if (deadWorkerPark && !reapFailure) {
        await park(
          t, deadWorkerPark.reason, "stall", assignment, attempt + 1, startMs,
          gateFails, consults, tokens, metered, retryMode, { ref: deadWorkerPark.ref },
        );
        return;
      }
      journal.append("worker-result", t.id, {
        ok: result.ok, summary: result.summary, deviations: result.deviations, finished: workerFinished, exitCode,
        mode: interactive ? "interactive" : "print", stream: capturedStream.path,
        ...(workerCause ? { cause: workerCause } : {}),
      });
      if (reapFailure) {
        await park(
          t, `worker could not be reaped before harvest: ${reapFailure}`, "stall", assignment,
          attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode,
          { reapFailure },
        );
        return;
      }
      // T2 review (routing precedence): provider-death, quota and dead-channel classification
      // derive from ONE rule — the worker's OWN outcome, workerFinished and this PRE-HARVEST
      // parse — never from the synthesized result below. A worker that committed and then walled
      // (provider outage, quota banner, dead CLI) must still route; the harvest synthesis only
      // decides whether THIS attempt's worktree goes to gates, and when routing wins instead, the
      // commits survive via the existing commitsToCarry/cherryPickCommits carry-forward.
      if (workerFinished && !result.ok && await dispositionScopeRed(t, [], assignment, attempt,
        startMs, gateFails, consults, tokens, metered, retryMode, await treeOrDiffPaths(taskBase, wt))) return;
      if (!workerFinished && !processExited && (timedOut || deadChannelKilled || quotaBannerKilled)) {
        const seat = channelKey(assignment);
        stallReaps = stallSeat === seat ? stallReaps + 1 : 1;
        stallSeat = seat;
        if (stallReaps >= 2) {
          const producer = producerNow();
          const ref = await preserveWorktree(wt, producer);
          if (ref) journal.append("worktree-preserved", t.id, { ref, ...producerFields(producer) });
          await park(t, `two consecutive stall reaps without a gate on seat ${seat}`, "stall", assignment,
            attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode, { seat, stallReaps });
          return;
        }
      } else { stallReaps = 0; stallSeat = undefined; }
      // OBS-1169: a CLI that died in its own bootstrap never read the brief. Startup-owned evidence
      // (known bootstrap text in the startup prefix StartupFailureDetector owns: inside the window, before
      // any tool frame or input box, in an unsaturated read), and only when it exited nonzero with no
      // parsed trailer and no commit of its own: the carried commits
      // beneath launchHead are an earlier attempt's, and harvesting them would replay that attempt's
      // red as a second fingerprint occurrence. One same-channel retry after a bounded backoff charges
      // no attempt, repair or fingerprint; after that the whole adapter shares the broken bootstrap,
      // so its channels are escalated away from and the existing failover moves on or parks infra.
      const bootstrap = !workerFinished && exitCode !== null && exitCode !== 0 && bootstrapEvidence
        && (await commitsAheadOf(launchHead, wt)).length === 0 ? bootstrapEvidence.matchedBytes : undefined;
      if (bootstrap) {
        const from = channelKey(assignment);
        const retries = requeuesOn("bootstrap-retry", from);
        if (retries < BOOTSTRAP_RETRY_CAP) {
          journal.append("bootstrap-retry", t.id, {
            attempt, retry: retries + 1, of: BOOTSTRAP_RETRY_CAP, channel: from, assignment,
            matched: bootstrap, exitCode, backoffMs: bootstrapBackoffMs,
          });
          await new Promise((r) => setTimeout(r, bootstrapBackoffMs));
          attempt--;
          continue;
        }
        const reason = `vendor escalated: ${assignment.adapter} bootstrap failed on ${from}`;
        escalateAdapter(assignment.adapter, reason);
        const next = failover("bootstrap-failover");
        // `toAssignment` and `reason` let a resume replay this routing disposition, not only its refund.
        journal.append("bootstrap-failover", t.id, {
          from, to: next ? channelKey(next) : null, ...(next ? { toAssignment: next } : {}), matched: bootstrap, retries,
          escalated: [...vendorEscalated].filter(([, why]) => why === reason).map(([k]) => k), reason,
        });
        if (next) {
          await driver.notify(`tickmarkr ${runId}: ${t.id} bootstrap failover`, { tier: "attention" });
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              try { await closeSlot(slot); } catch { /* cosmetic — reconcile is the backstop */ }
            }
            if (supersededWorkerSlot === slot) supersededWorkerSlot = undefined;
          }
          assignment = next;
          tried.push(channelKey(next));
          attempt--; // the dead bootstrap bought no worker turn
          continue;
        }
        await park(t, `${from} failed at bootstrap after ${retries} same-channel retry and no eligible channel remains${poolExhaustion(t, cfg)}`, "infra",
          assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode, { cause: "bootstrap", channel: from, retries });
        return;
      }
      const preHarvestResult = result;
      // T2 (OBS-264): recognize committed no-trailer work BEFORE any no-trailer streak, provider,
      // quota or dead-channel routing. Gates never trusted the trailer, so this successful synthesis
      // must enter exactly where a worker-claimed ok enters. Preserve the parsed worker truth in the
      // worker-result row above and name the synthesized gate input in its own harvested event.
      let harvestedCommits: string[] = [];
      if (!workerFinished) {
        harvestedCommits = await commitsAheadOf(taskBase, wt);
        if (harvestedCommits.length > 0) {
          result = { ok: true, summary: HARVESTED_RESULT_SUMMARY, deviations: [], raw: output };
          finished = true;
          journal.append("worker-result-harvested", t.id, {
            attempt, commits: harvestedCommits, summary: HARVESTED_RESULT_SUMMARY, source: "harvest",
          });
        }
      }
      // T2 review: provider-death is the THIRD routing branch that must read the pre-harvest
      // outcome — the synthesis must not null it. A worker that committed and then printed the
      // outage banner without exiting (workerFinished false, so the harvest fires) still takes
      // the capped same-channel requeue below; nulling the cause here would skip that branch and
      // let classifyDeadChannel(preHarvestResult) demote the channel run-wide on a transient blip.
      const cause = harvestedCommits.length > 0 && workerCause !== "provider-death" ? undefined : workerCause;
      // T2 review (family): the no-trailer streak is accounted on the SAME ONE rule the routing
      // branches above use — workerFinished and the PRE-HARVEST parse — never the synthesized
      // result. A channel that commits but never emits a parseable trailer still burned a
      // no-trailer window (OBS-57): the synthesis decides whether THIS worktree goes to gates, it
      // never certifies the channel. Reading the synthesized `finished`/`ok` here reset the streak
      // on every harvest, so a CLI that produces commits and swallows every trailer was immune to
      // the two-window demotion and stayed first pick for the rest of the run.
      // Q-1 (OBS-926): BOTH branches read the same tail — a print stream tested whole failed a
      // pinned codex worker over for a diff line number (`429:`) 41 985 bytes before EOF and for
      // this repository's own fixture prose. The matched bytes and their stream offset ride the
      // row so a false positive is legible from the record alone.
      const quotaMatch = (interactive ? !workerFinished : exitCode !== 0)
        ? quotaSignal(stallSnapshotBannerRows(output))
        : null;
      // OBS-1161: transient capacity reads the SAME tail under the same guards — a live idle banner
      // and a no-trailer capacity exit classify identically — through the parse-boundary rule that a
      // parsed verdict (either way) is work, so a trailer QUOTING the phrase never lands here.
      const capacityMatch = !quotaMatch && (interactive ? !workerFinished : exitCode !== 0)
        ? classifyTransientCapacity({ ...preHarvestResult, raw: stallSnapshotBannerRows(output) })
        : null;
      // Q-1: a graph pin is an operator instruction — a quota match ALONE never overrides it; only a
      // channel-attributed error (auth/setup/outage/timeout, the typed dead-channel classes) may.
      const pin = t.routingHints?.pin;
      const onPin = !!pin && assignment.adapter === pin.via && assignment.model === pin.model;
      const channelError = quotaMatch && onPin ? classifyDeadChannel({ ...preHarvestResult, raw: output }) : undefined;
      const pinRefusesQuota = !!quotaMatch && onPin && !channelError;
      // a refused quota window is not a no-trailer verdict on the pinned channel: counting it would
      // demote the pin two tails in and the demotion re-dispatch would move the task off it.
      if (preHarvestResult.ok && workerFinished) noTrailerStreak.set(channelKey(assignment), 0);
      else if (!workerFinished && cause !== "provider-death" && !pinRefusesQuota && !capacityMatch) {
        const ck = channelKey(assignment);
        const streak = (noTrailerStreak.get(ck) ?? 0) + 1;
        noTrailerStreak.set(ck, streak);
        // OBS-57: two consecutive no-trailer windows in one run demote the channel for later attempts.
        if (streak >= NO_TRAILER_DEMOTION_STREAK && !demotedChannels.has(ck)) {
          demotedChannels.add(ck);
          journal.append("channel-demotion", t.id, { channel: ck, streak });
        }
      }

      // v1.46 T1: provider-outage requeue — same assignment, no attempt burn, no consult, capped.
      if (cause === "provider-death" && providerDeathRequeues < PROVIDER_DEATH_REQUEUE_CAP) {
        providerDeathRequeues++;
        journal.append("provider-death-requeue", t.id, { attempt, requeue: providerDeathRequeues, assignment });
        await new Promise((r) => setTimeout(r, PROVIDER_DEATH_BACKOFF_MS));
        attempt--;
        continue;
      }

      // OBS-1161: transient capacity → bounded same-seat requeue with backoff (no attempt burn, no
      // consult), then a same-floor failover exactly like quota — but the seat is NEVER demoted or
      // excluded: it is busy, not dead, and a later task may find it free. The budget is read from
      // the journal, never a loop-local counter, so a resume continues the count it left off at.
      if (capacityMatch) {
        const from = channelKey(assignment);
        const requeues = requeuesOn("capacity-requeue", from);
        const source = capacityBannerKilled ? "banner" : "exit";
        if (requeues < CAPACITY_REQUEUE_CAP) {
          journal.append("capacity-requeue", t.id, {
            attempt, requeue: requeues + 1, of: CAPACITY_REQUEUE_CAP, channel: from, assignment,
            matched: capacityMatch[0], source, backoffMs: capacityBackoffMs,
          });
          await new Promise((r) => setTimeout(r, capacityBackoffMs));
          attempt--;
          continue;
        }
        const next = failover("capacity-failover");
        journal.append("capacity-failover", t.id, {
          from, to: next ? channelKey(next) : null, matched: capacityMatch[0], source, requeues, cause: "capacity",
        });
        if (next) {
          await driver.notify(`tickmarkr ${runId}: ${t.id} capacity failover`, { tier: "attention" });
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              try { await closeSlot(slot); } catch { /* cosmetic — reconcile is the backstop */ }
            }
            if (supersededWorkerSlot === slot) supersededWorkerSlot = undefined;
          }
          assignment = next;
          tried.push(channelKey(next));
          continue;
        }
        await park(t, `capacity exhausted on ${from} after ${requeues} requeues and no eligible channel at floor${poolExhaustion(t, cfg)}`, "quota",
          assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode, { cause: "capacity", channel: from, requeues });
        return;
      }

      // quota exhaustion → failover within floor; does NOT consume the ladder (spec §4)
      // print: guarded on exit code — exit-0 output that merely MENTIONS "rate limit" must not failover
      // interactive: a worker-CLAIMED trailer beats quota mentions; without one, quota text fails over
      // (spec v1.2 §2) — matched on the chrome-filtered tail, the exact discrimination the in-loop
      // classifier makes, so the two can never disagree. A TUI harvest is the whole retained pane:
      // an unscoped match failed a worker over for quoting "rate limit" in its own diff (tail
      // scoping kills that — the mention sits ABOVE the tail), and a raw-tail match fires on fixed
      // chrome (codex's welcome line — filtered by identity, so a launch-time banner this backstop
      // exists to catch is never exculpated). Print output keeps the exit-code guard.
      // T2 review: the gate is `workerFinished`, not the harvest-synthesized `finished` — a
      // committed-but-quota-walled attempt routes here FIRST (its commits ride the carry-forward
      // into the next attempt's recreated worktree), it never buys a gate run on throttled work.
      // Q-1 review: NO cap and NO fall-through to the consult ladder (failoverOrRecycle ignores the
      // pin) — the attempt is counted, so a pin that never clears parks at MAX_ATTEMPTS on its own
      // channel; only a channel-attributed error below may leave it.
      if (pinRefusesQuota) {
        journal.append("quota-failover-refused", t.id, {
          pin: `${pin!.via}:${pin!.model}`, channel: channelKey(assignment), matched: quotaMatch![0],
          reason: "pinned channel; no channel-attributed error", attempt,
        });
        await new Promise((r) => setTimeout(r, PROVIDER_DEATH_BACKOFF_MS));
        continue;
      }
      if (quotaMatch && (!onPin || channelError)) {
        const next = failover("quota-failover");
        // byte offset inside the PERSISTED stream (the journaled `stream` file) — the capture keeps
        // only its last MAX_BUF bytes, so the file's origin may sit past the buffer's.
        const streamBytes = Buffer.byteLength(capturedStream.output);
        const idx = capturedStream.output.lastIndexOf(quotaMatch[0]);
        const offset = idx >= 0 ? Buffer.byteLength(capturedStream.output.slice(0, idx)) - Math.max(0, streamBytes - MAX_BUF) : null;
        journal.append("quota-failover", t.id, {
          from: channelKey(assignment), to: next ? channelKey(next) : null,
          matched: quotaMatch[0], offset, stream: capturedStream.path, streamBytes: Math.min(streamBytes, MAX_BUF),
          ...(onPin ? { pin: `${pin!.via}:${pin!.model}`, channelError } : {}),
        });
        if (next) {
          await driver.notify(`tickmarkr ${runId}: ${t.id} quota failover`, { tier: "attention" });
          // OBS-17 T2: the superseded slot's pane closes AT REROUTE TIME — it holds a throttled
          // dead-end, not failure context; the next safe-point reconcile catches a missed close.
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              try { await closeSlot(slot); } catch { /* cosmetic — reconcile is the backstop */ }
            }
            if (supersededWorkerSlot === slot) supersededWorkerSlot = undefined;
          }
          // v1.8 TEL-05 — FROM-channel attribution for mid-task quota failover: `assignment` is still the
          // throttled-away-FROM channel here (before the reassign below). durationMs:0 marks this as a
          // failover FACT, not a timed attempt. The park branch is deliberately NOT written here — park()
          // already records parkKind:"quota", so writing here too would double-count in Phase 26 ROUTE-12.
          journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts: attempt + 1, outcome: "failed", durationMs: 0, quotaFailover: true, retryMode });
          assignment = next;
          tried.push(channelKey(next));
          continue;
        }
        await park(t, `quota exhausted on every eligible channel${poolExhaustion(t, cfg)}`, "quota", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      // v1.65 T1: typed dead-channel failure — the parse boundary classified this no-trailer result
      // as auth-required / setup-required / provider-outage / timeout (classifyDeadChannel; the
      // daemon consumes the type, never re-derives it from raw text). Same free failover as quota —
      // no escalation-ladder step — plus run-wide exclusion via demotedChannels: unlike a quota
      // window that may reset, a dead channel stays dead for this run (OBS-57 class). Strictly
      // AFTER the quota check so quota behavior stays byte-identical (a quota hit returns/continues
      // before reaching here); provider-outage lands here only once the v1.46 same-channel requeue
      // cap above is spent, so a transient blip still recovers in place.
      // OBS-117 (v1.71 T6): a silent launch failure has no CLI signature to parse — the same
      // setup-required typed dead-channel path a late-harvest "command not found" would take.
      // T2 review: classify the PRE-HARVEST parse — classifyDeadChannel bails on any ok:true
      // result, so reading the synthesized harvest result would swallow auth-required /
      // setup-required / provider-outage for every committed-but-walled attempt (in both modes).
      const dead = classifyDeadChannel({ ...preHarvestResult, raw: output })
        ?? (earlyLaunchDead || startupFailure || adapterStartupFailure ? "setup-required" : undefined);
      if (dead) {
        const from = channelKey(assignment);
        demotedChannels.add(from); // excluded for later attempts AND later tasks in this run
        journal.append("channel-exclusion", t.id, { channel: from, reason: dead, kind: "dead-channel" });
        const next = failoverOrRecycle("dead-channel");
        journal.append("dead-channel-failover", t.id, { reason: dead, from, to: next ? channelKey(next) : null });
        if (next) {
          await driver.notify(`tickmarkr ${runId}: ${t.id} dead channel (${dead}) failover`, { tier: "attention" });
          // OBS-17 T2 (quota parity): the superseded slot holds a dead-end, not failure context.
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              try { await closeSlot(slot); } catch { /* cosmetic — reconcile is the backstop */ }
            }
            if (supersededWorkerSlot === slot) supersededWorkerSlot = undefined;
          }
          assignment = next;
          tried.push(channelKey(next));
          // Startup failures bought no worker turn: preserve the attempt ordinal/budget while the
          // verified-dead channel remains excluded for every later dispatch in this run.
          if (adapterStartupFailure || startupFailure) attempt--;
          continue;
        }
        const chargedAttempts = adapterStartupFailure || startupFailure ? attempt : attempt + 1;
        await park(t, `dead channel (${dead}) and no eligible channel remains${poolExhaustion(t, cfg)}`, "reroute-exhausted", assignment, chargedAttempts, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      if (!finished) {
        // ROUTE-18 (OBS-04): the channel burned a window without emitting a trailer (no-trailer timeout
        // OR trailer-less crash-exit — both finished:false). durationMs:0 marks a FACT row, not a timed
        // attempt; attributed to the still-current assignment (the TEL-05 quotaFailover:382 shape, field
        // swapped). Strictly AFTER the quota check above — the quota branch returns/continues before
        // reaching here, so a quota hit can never also carry overrun (no double-count). Read side: 48-01.
        journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts: attempt + 1, outcome: "failed", durationMs: 0, overrun: true, retryMode });
        const v = await runConsult(
          "stall",
          output,
          exitCode !== null && interactive
            ? `worker process exited (code ${exitCode}) without a trailer`
            : `no completion marker within ${taskTimeoutMinutes}m`,
          [],
        );
        if (await applyVerdict(v, attempt + 1, "stall")) continue;
        return;
      }

      // Provisioning can mutate the shared dependency tree the pristine capture is still using.
      await waitForBaseline(t.id);
      stallReaps = 0; stallSeat = undefined;
      graph = setStatus(graph, t.id, "gated");
      saveGraph(repoRoot, graph);
      // OBS-47: re-assert the node_modules link BEFORE gates run on any attempt. A worker may have
      // deleted/replaced the symlink provisioned at worktree creation (run-20260717-004803 T5 lost two
      // attempts + a consult to this); restore it harness-side so a prior attempt's environment damage
      // can never fail a later attempt's gates. Gates never trust worker claims — this runs
      // unconditionally, never on worker say-so. Restoration can fail (EPERM/busy); fail closed with a
      // named environmental verdict instead of letting the test gate mask it as a code red.
      if (!linkNodeModules(repoRoot, wt, { force: true })) {
        await park(t, "environmental: node_modules link could not be re-asserted before gates (OBS-47)", "setup", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      // OBS-126: workers cannot write the provisioned node_modules target outside their sandbox.
      // Once the link is known-good, the daemon installs only attempts whose npm manifest differs
      // from the integration-tip baseline. Keep lock/package manifests untouched: the worker's
      // committed files are the deliverable, while this step only provisions the gate-visible tree.
      if (await npmDependencyManifestChanged(wt, taskBase)) {
        const installCommand = npmDependencyInstallCommand(wt);
        const installed = await sh(installCommand, repoRoot, 10 * 60_000);
        if (installed.code !== 0) {
          throw new Error(`dependency install failed (exit ${installed.code}): ${installed.stderr || installed.stdout}`);
        }
      }
      const onGate = async (e: GateEvent) => {
        if (!liveEngagement()) return;
        if (e.phase === "start") {
          notePhaseStart(e);
          journal.phaseStart(t.id, phaseForGate(e.gate), { gate: e.gate, index: e.index, total: e.total, ...(e.parentAt === undefined ? {} : { parallel: true }) });
          return;
        }
        if (e.phase === "note") {
          noteReviewEvent(e);
          return;
        }
        const g = e.result;
        activeGatePhases.get(t.id)?.delete(e.gate);
        classifyInfraResult(g);
        inParallelOrder(g.gate as GateName, () => {
          // GATE-09 (ROADMAP SC-4): journal every judge retry as an attributable event — which gate flaked,
          // which channel flaked, which channel retried — so `tickmarkr journal`/report can distinguish "judge
          // flaked, retried" from "worker failed" (run-20260711-185020 P43-03 L70-72 billed a judge flake as
          // a worker attempt; 47-01 fixed WHO retries, this closes the audit-trail half). The condition is
          // META-ONLY (D-03): gate === "acceptance" + typeof-shape guards on meta.judgeRetry — never a
          // details-regex. The v1.1 review regex below is grandfathered, not precedent. Appended BEFORE the
          // gate-result so attribution precedes the verdict in the stream. secondUnparseable is derived from
          // the final result's meta.unparseable (set by run-gates when the retry ALSO flaked — double-garbage).
          if (g.gate === "acceptance" && typeof g.meta?.judgeRetry === "object" && g.meta.judgeRetry !== null) {
            const jr = g.meta.judgeRetry as Record<string, unknown>;
            if (typeof jr.flaked === "string" && typeof jr.retried === "string") {
              journal.append("judge-retry", t.id, {
                gate: "acceptance", flaked: jr.flaked, retried: jr.retried,
                ...(g.meta.unparseable === true ? { secondUnparseable: true } : {}),
              });
            }
          }
          journalGateResult(g);
          noteReviewRetry(g);
          // v1.1 failover: never re-ask a reviewer channel that produced garbage for this task
          if (isGarbageReview(g)) badReviewers.push(g.meta.reviewer);
        });
      };
      let results: GateResult[] = [];
      let commits: string[] = [];
      let outsideScopeForced = false;
      gateLoop: while (true) {
        fatalStop.signal.throwIfAborted();
        executionSignal()?.throwIfAborted();
        const gated = await gitHead(wt);
        gateSubject = { commit: await gateCommitSubject(taskBase, gated, wt), attempt };
        await trackedDriver.project?.(t.id, "in-review");
        // Only the immediately preceding attempt can lend a red. Re-journal its results
        // as this attempt's verdicts so all existing disposition and fingerprint accounting
        // sees the replay, without buying another command or reviewer invocation.
        const taskEvents = journal.read().filter((e) => e.taskId === t.id);
        const previousRound = taskEvents.map((e) => e.event === "phase-start" && e.data.phase === "gates").lastIndexOf(true);
        const lastRoundRows = taskEvents.slice(previousRound + 1).filter((e) => e.event === "gate-result"
          && e.data.attempt === attempt - 1);
        const previousRows = retryMode === "repair" ? lastRoundRows : [];
        // OBS-1106 residual: see owesTimeoutRefresh — the replay below and the verdict cache are both refused.
        // C: an unchanged red wholly outside files[] is re-executed once instead of copied (journal or cache);
        // it outranks the timeout refresh, so a timeout-shaped qualifying red keeps its own bypass and park.
        outsideScopeForced = !explicitlyFundedAttempt && owesOutsideScopeRefresh(t, lastRoundRows, gateSubject.commit);
        const freshTimeout = !explicitlyFundedAttempt && !outsideScopeForced && owesTimeoutRefresh(t, lastRoundRows, gateSubject.commit);
        journal.phaseStart(t.id, "gates");
        if (freshTimeout) {
          journal.append("gate-fresh-forced", t.id, { gate: "test", attempt, priorAttempt: attempt - 1, commit: gateSubject.commit, reason: "no-commit-timeout-red" });
        }
        if (outsideScopeForced) {
          journal.append("gate-fresh-forced", t.id, { gate: "test", attempt, priorAttempt: attempt - 1, commit: gateSubject.commit, reason: OUTSIDE_SCOPE_RED });
        }
        const replay = !explicitlyFundedAttempt && !freshTimeout && !outsideScopeForced && previousRows.length > 0
          && previousRows.every((e) => e.data.commit === gateSubject!.commit)
          && previousRows.some((e) => e.data.pass === false && e.data.skipped !== true);
        if (replay) {
          gateSubject.replayedFromAttempt = attempt - 1;
          results = previousRows.map(({ data }) => ({
            gate: String(data.gate), pass: data.pass === true, details: String(data.details),
            // The verdict is reused; its old timing is not a measurement of this attempt.
            meta: Object.fromEntries(Object.entries(data).filter(([key]) =>
              !(GATE_TELEMETRY_KEYS as readonly string[]).includes(key) && key !== "capacity")),
          }));
          commits = await commitsAheadOf(taskBase, wt);
          // OBS-1106: a replayed legacy infra row lacking `infra` is re-classified before it is
          // re-journaled and before the infra park below reads it.
          results.forEach(classifyInfraResult);
          for (const g of results) {
            journal.append("gate-replayed", t.id, {
              attempt, priorAttempt: attempt - 1, gate: g.gate, commit: gateSubject.commit,
              ...(g.meta?.skipped === true ? { skipped: true } : { pass: g.pass }),
              details: g.details,
            });
            journalGateResult(g);
          }
        } else {
          ({ results, commits } = await withCommandContext(t.id,
            async () => runReviewRecovery(t, {
            carriedAuthors: await subjectAuthors(journal.read(), t.id, wt, taskBase),
            producer: producerNow(),
            carriedFindings: outstandingFindings,
            operatorContext,
            worktree: wt, baseRef: taskBase, result, author: assignment,
            commands, baseline, channels: pools.review, judgeChannels: pools.judge, health, adapters, cfg, artifactDir: journal.dir,
            collateral: collateral.get(t.id) ?? [],
            selectTests: !testGateFailed,
            cachedRedBypass: explicitlyFundedAttempt ? "operator-rerun" : freshTimeout ? "timeout-fresh" : outsideScopeForced ? "out-of-scope-fresh" : undefined,
            via: cfg.visibility.llm === "pane"
              ? {
                  driver: trackedDriver,
                  // D-07: judge/review panes self-clean when their verdict is read (keepLlm) — only "forever" keeps them.
                  keep: keepLlm,
                  onSlot: keepLlm ? (s: Slot) => keptSlots.push(s) : undefined,
                  // T2 ownership contract: canonical names (tickmarkr:<role>:<task>:0:<runId>) so reconcile
                  // owns judge/review panes; run-gates' -r1 retry suffix becomes attempt 1 in llm.ts.
                  // Same-name reuse across worker attempts is safe: panes self-clean when read (keepLlm),
                  // and herdr's DEFECT-01 reclaim covers a kept holdover under keepPanes:forever.
                  nameFor: (role) => formatOwnedName({ role, taskId: t.id, attempt: 0, runId }),
                  // role-tab label (SUP-01): role-first + task id, unique per concurrent instance within a run.
                  // Duplicate labels from a resumed run or operator-made tabs are accepted (per-process state).
                  labelFor: (role) => `${role.toUpperCase()} ${t.id}`,
                }
              : undefined,
            excludeReviewers: badReviewers,
            reviewHistory, demotedReviewers, priorReviewers: taskReviewers(t.id),
            reviewNoVerdicts, // Leg-2 (OBS-1052): see the recheck site above
            onGate,
          })));
        }
        results.forEach(classifyInfraResult);
        graph = addEvidence(graph, t.id, { commits, gateResults: results, artifacts: [promptFile] });
        saveGraph(repoRoot, graph);
        if (results.some((g) => g.gate === "test" && !g.pass
          && !(cfg.executionPolicy?.boundedInfrastructure && failureDisposition(g) === "infrastructure"))) testGateFailed = true;

        const live = assignment;
        const settled = await settleResults(results, {
          wt, taskBase, taskBranch, gated, commit: gateSubject.commit, outsideScopeForced,
          author: live, attempts: attempt + 1,
          infraReason: (g) => `${g.gate}: ${g.details}${g.meta?.recoveryBlocked ? ` — ${g.meta.recoveryBlocked}` : ""}`,
          reobserve: { attempt, replayed: gateSubject.replayedFromAttempt !== undefined },
          disposition: () => ({ author: live, attempt }),
          firstAttemptOk: attempt === 0, metering: { tokens, meteredAttempts: tokens ? metered : undefined },
          // T6: every gate — the review included — is satisfied on this commit, so the failure brief
          // this loop is still holding describes nothing outstanding. It is dropped HERE, before the
          // merge, because a conflict below sends the task around the attempt loop again: a brief kept
          // across that retry hands the next worker findings a later review has since passed on, while
          // `carriedFindings` — re-derived from the journal, which retired them — is correctly empty,
          // leaving that dispatch's row indistinguishable from an amnesiac one. Rebuilt exactly as the
          // gate-fail brief is, so prior-RUN evidence (retired by its own rule, not by this reviewer)
          // survives and only this run's settled findings go.
          beforeMerge: () => {
            feedback = withCarriedEvidence("");
            fatalStop.signal.throwIfAborted();
            executionSignal()?.throwIfAborted();
          },
        });
        if (settled.kind === "regate") continue gateLoop;
        if (settled.kind === "parked") return;
        if (settled.kind === "conflict") {
          const v = await runConsult("merge-conflict", output, settled.conflict ?? "", results);
          if (await applyVerdict(v, attempt + 1, "merge-conflict")) continue attempts;
          return;
        }
        if (settled.kind === "merged") {
          // D-07 done means gone (merged-P42-01-worker incident): a merged task's worker pane closes on
          // the task-done path, not at run end. Only THIS successful attempt's `slot` is in scope — prior
          // failed attempts' slots stay in keptSlots governed by keepPanes (they hold failure context the
          // operator may need). keepPanes:"forever" is the keep-everything debug override. Removing from
          // keptSlots guarantees the run-end sweep cannot double-close; the indexOf guard also covers
          // "attempt" (slot already closed per-attempt at the worker line above) — close only what you own (Pitfall 5).
          if (!keepForever) {
            const idx = keptSlots.indexOf(slot);
            if (idx >= 0) {
              keptSlots.splice(idx, 1);
              await closeSlot(slot);
            }
          }
          await reconcile({ spareLiveLlm: true }); // task-done is a terminal event — sweep this task's leftovers
          return;
        }
        break gateLoop;
      }

      gateFails++; // this attempt's gates failed — the one place quality degradation is verified (never inferred from attempts)
      // v1.53 T3: prefer the CLI's own session id captured from this attempt's output (kimi's resume
      // trailer) over the harness slot name; absent hook or no capture keeps today's slot-name id.
      retrySession = { channel: channelKey(assignment), id: adapter.sessionIdFrom?.(output) ?? sessionId, contextTokens };
      feedback = withCarriedEvidence(repairFindingsBrief(results));
      // OBS-189/G3 (park-economics patch): a request-changes review is a findings brief, not a worker
      // defect — the fix attempt stays on the same channel with the findings as feedback and consumes
      // no escalation-ladder rung. Bounded by the engagement round cap at the top of this loop.
      // Unparseable verdicts (already retried in-gate, OBS-193) and diff-cap trips (the diff cannot
      // shrink by retrying, OBS-48) fall through to the ladder unchanged. Review runs last, so a
      // failed review with every other gate green is exactly "the work landed, the reviewer objects".
      const reviewFail = results.find((g) => g.gate === "review" && gateFailed(g));
      const reviewFixRetry = reviewFail !== undefined
        && reviewFail.meta?.unparseable !== true
        && !isDiffCapPark(reviewFail)
        && results.every((g) => gateSatisfied(g) || g.gate === "review");
      const failing = results.filter(gateFailed);
      const deterministic = failing.find(isDeterministicFailure);
      if (deterministic) ownedGateFailures++;
      // Decided before the cap, because the cap's question is whether the NEXT move would re-buy a
      // measurement already made — and a funded repair is one of the moves that would.
      const landed = await commitsAheadOf(taskBase, wt);
      // T4 (OBS-265): judge and review are now ONE round, so a round can report both failing where the
      // serial walk returned at the judge and review never ran. Eligibility is scored on the battery
      // the serial contract would have surfaced — review only speaks for a round nothing else failed —
      // so removing the waiting does not re-price the ladder. The journal below still names every
      // failing gate, and `feedback` still carries every one of them to the next attempt.
      const repairBattery = failing.some((g) => g.gate !== "review") ? failing.filter((g) => g.gate !== "review") : failing;
      const repairable = narrowRepairBattery(repairBattery) && lostCommits.length === 0 && landed.length > 0;
      const repairHistory = repairReachSinceApproval(journal.read(), t.id);
      const repairsDrawn = repairsSinceApproval(journal.read(), t.id);
      const repair = repairable && repairsDrawn < MAX_REPAIRS && attempt + 1 < MAX_ATTEMPTS;

      // v1.85 T3: the fingerprint cap. Two normalized-identical failures of one DETERMINISTIC gate on
      // one task (volatile tokens — worktree prefixes, line refs, durations, run ids — are not
      // information) mean the round about to be bought is a re-measurement: ~663m across 5 runs went to
      // exactly this loop. The threshold is a property of the FAILURE, never of the move that would
      // follow it, so it is evaluated on EVERY such gate at EVERY ladder position — including a rung
      // that would change channel, and including a review-fix round. Conditioning it on the next rung
      // was the first shape of this and let a second identical failure buy an escalate/consult round
      // the criterion says it may not buy. What the cap does NOT reach is an LLM verdict, which is a
      // different object with its own tighter bound (see isDeterministicFailure).
      //
      // It fires on the CROSSING, not as a latch: the consult it forces and the ban it sets govern the
      // next move, so re-firing on the third identical failure would only re-buy the round it just paid
      // for — and the ladder, whose rung this failure still spends, bounds the rest.
      const repeated = failing.find((g) => isDeterministicFailure(g)
        && identicalGateFailures(journal.read(), t.id, g.gate, normalizeGateFailure(g.details)) === GATE_FINGERPRINT_CAP);
      // The rung the cap spent, when it fired — the move below executes THIS instead of drawing a
      // second one, so a cap costs exactly the rung the failure would have cost anyway.
      let capStep: (typeof r.ladder)[number] | undefined;
      if (repeated) {
        const normalized = normalizeGateFailure(repeated.details);
        journal.append("gate-fingerprint-cap", t.id, {
          gate: repeated.gate,
          occurrences: GATE_FINGERPRINT_CAP,
          fingerprint: normalized.slice(0, 500),
          retrySameBanned: true,
          channel: channelKey(assignment), // the ban is bound to the channel that produced the repeat
          attempt: attempt + 1,
        });
        await driver.notify(`tickmarkr ${runId}: ${t.id} ${repeated.gate} failed identically twice — identical retry banned`, { tier: "attention" });
        // The cap takes the ladder's MOVE, never its accounting: this failure still spends the rung it
        // would have spent, so a task that cannot converge still reaches ladder exhaustion on exactly
        // the budget it always had and the cap can never hand a stuck task extra rounds.
        capStep = r.ladder[Math.min(ladderIdx++, r.ladder.length - 1)];
        journal.append("escalation", t.id, { step: capStep, attempt: attempt + 1, fingerprintCap: true, workerAttributed: !!deterministic });
        await driver.notify(`tickmarkr ${runId}: ${t.id} escalation: ${capStep}`, { tier: "attention" });
        const climbed = await climb("gate-fingerprint-cap", repeated, attempt + 1);
        if (climbed === "parked") return;
        if (climbed === "climbed") continue;
        const v = await runConsult("gate-fail-repeat", output, feedback, results);
        // Rule: a terminal cap consult vetoes a same-channel retry, but cannot veto an `escalate`
        // rung that already satisfies retry-same-banned by changing channel. Thus terminal+retry
        // parks through the shared verdict boundary, while terminal+escalate records the consult as
        // advisory and executes the already-spent rung below. Recoverable verdicts still control the
        // move directly. The paired fixture asserts both directions of this boundary.
        const recoverable = v.action === "retry" || v.action === "reroute";
        if (recoverable || capStep !== "escalate") {
          if (await applyVerdict(v, attempt + 1, "gate-fail")) continue;
          return;
        }
        journal.append("consult-verdict", t.id, {
          action: v.action, notes: v.notes,
          adapter: v.adapter ?? "unknown", model: v.model ?? "unknown", vendor: v.vendor ?? "unknown",
          ...(v.effort ? { effort: v.effort } : {}),
          ...(v.invocations?.length ? { invocations: v.invocations } : {}),
          capAdvisory: true,
        });
      }

      // v1.85 T3: a narrow battery over fully carried commits earns a REPAIR (decided above) — the
      // next dispatch carries the findings verbatim and the diff content instead of re-onboarding a
      // fresh worker. Budget is engagement-scoped and journal-derived, so a resume inherits it rather
      // than refunding it; the third repair-eligible failure falls back to the fresh ladder.
      //
      // `landed` is measured from the worktree rather than read from runGates: runGates returns at
      // the first failure, so a red test or lint gate never reaches the evidence stage and its
      // `commits` come back empty — reading them would make the ruling's test/lint case unreachable.
      //
      // Budget spent means the FRESH LADDER owns this failure — including a review-only one, whose
      // same-channel fix retry is exactly the round the budget just declared too expensive to repeat.
      const repairExhausted = repairable && !repair;

      if (repair && !capStep) {
        journal.append("repair-attempt", t.id, {
          repair: repairHistory.length + 1, charge: repairsDrawn + 1, of: MAX_REPAIRS,
          gates: failing.map((g) => g.gate),
          commits: landed.length,
          findings: feedback, // the failure bytes this repair must carry, replayable across a resume
        });
      } else if (repairExhausted && !capStep) {
        journal.append("repair-exhausted", t.id, {
          repairs: repairsDrawn, of: MAX_REPAIRS, gates: failing.map((g) => g.gate),
          reached: repairHistory,
        });
      }

      const step = capStep ?? (repair || (reviewFixRetry && !repairExhausted)
        ? "retry"
        : r.ladder[Math.min(ladderIdx++, r.ladder.length - 1)]);
      if (!capStep) { // a capped failure already journaled and announced the rung it spent
        journal.append("escalation", t.id, {
          step, attempt: attempt + 1, workerAttributed: !!deterministic,
          ...(reviewFixRetry && !repairExhausted ? { reviewFix: true } : {}),
          ...(repair ? { repair: repairHistory.length + 1, repairCharge: repairsDrawn + 1 } : {}),
        });
        await driver.notify(`tickmarkr ${runId}: ${t.id} escalation: ${step}`, { tier: "attention" });
      }

      const climbCause = repairExhausted ? "repair-exhausted"
        : deterministic && ownedGateFailures === 2 ? "gate-fail" : undefined;
      if (climbCause) {
        const climbed = await climb(climbCause, deterministic ?? failing[0]!, attempt + 1);
        if (climbed === "parked") return;
        if (climbed === "climbed") continue;
      }

      if (step === "retry") continue;
      if (step === "escalate") {
        const next = failover("escalate");
        if (next) {
          assignment = next;
          tried.push(channelKey(next));
          continue;
        }
        // no channel left — fall through to a consult
      }
      if (step === "escalate" || step === "consult") {
        const v = await runConsult("gate-fail", output, feedback, results);
        if (await applyVerdict(v, attempt + 1, "gate-fail")) continue;
        return;
      }
      await park(t, "escalation ladder exhausted", "ladder-exhausted", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
      return;
    }
  };

  const executeWithPolicy = async (t: Task): Promise<void> => {
    const policy = cfg.executionPolicy;
    if (!policy || (t.humanGate && !approved.has(t.id))) return execTask(t);
    await withExecutionBudget({ limitMs: policy.taskExecutionLimitMs, taskId: t.id,
      readEvents: () => journal.read(), append: journal.append.bind(journal) }, async () => {
      const signal = executionSignal()!;
      const slots = new Set<Slot>();
      budgetSlots.set(signal, slots);
      let closing: Promise<void> | undefined;
      const closeOwned = () => withoutExecutionBudget(async () => {
        for (const slot of slots) await closeSlot(slot);
      });
      const stop = () => {
        closing = closeOwned();
        // Awaited again below; prevent an unhandled rejection while the worker unwinds.
        void closing.catch(() => {});
      };
      signal.addEventListener("abort", stop, { once: true });
      try { await execTask(t); }
      finally {
        signal.removeEventListener("abort", stop);
        if (signal.aborted) { await closing; await closeOwned(); }
        budgetSlots.delete(signal);
      }
    });
  };

  taskLoopStarted = true;
  fatalPhase = "scheduler";
  // A settled worker can release a dependency or an approval in the same poll tick.
  // Audit the current graph at every empty-flight boundary, never a prior ready snapshot.
  // WB-1 rider: `end-condition-held` names a CLOSE the daemon refused, so only a close attempt journals
  // it — the post-race sweep still dispatches what it finds but says nothing.
  const holdEndCondition = (closing = true): boolean => {
    sweepLiveApprovals();
    const freeSlots = Math.max(0, concurrency - inflight.size);
    const dispatchable = admissible().filter((t) => !inflight.has(t.id));
    if (freeSlots === 0 || dispatchable.length === 0) return false;
    if (closing) {
      for (const task of dispatchable) {
        journal.append("end-condition-held", task.id, { deps: task.deps, freeSlots });
      }
    }
    return true;
  };
  closeLoop: while (true) {
    fatalPhase = "scheduler";
    let approvalDeadline: number | undefined;
    while (true) {
      // v1.54 T2: a signal that landed while nothing was racing `aborted` (empty inflight window)
      // must still stop the run before it can dispatch more work or write run-end.
      if (termSignal) throw new Error(`terminated by ${termSignal}`);
      await watchBoard();
      sweepLiveApprovals();
      const ready = admissible()
        .filter((t) => !inflight.has(t.id))
        .slice(0, Math.max(0, concurrency - inflight.size));
      for (const t of ready) {
        const p = executeWithPolicy(t)
          .catch(async (err) => {
            engagements.delete(t.id);
            const cleanupErrors: { slot: string; attempt: number; error: string }[] = [];
            for (const [slot, owner] of workerOwners) {
              if (owner.taskId !== t.id || !liveSlots.has(slot)) continue;
              try {
                await withoutExecutionBudget(() => closeSlot(slot));
              } catch (error) {
                // Cleanup evidence must not replace the task's original failure or abort siblings.
                cleanupErrors.push({ slot: slot.name, attempt: owner.attempt, error: String(error) });
              }
            }
            if (fatalStop.signal.aborted) return;
            const cleanupEvidence = cleanupErrors.length ? { cleanupErrors } : {};
            if (err instanceof HostDegradedError) {
              await park(t, err.message, "infra", null, 0, Date.now(), 0, 0, undefined, 0, "fresh",
                { disposition: "host-degraded", ...cleanupEvidence });
              return;
            }
            if (err instanceof HeldProbeExhausted) {
              const wt = worktreePath(repoRoot, `${branch}--${t.id}`);
              const producer = knownProducer(journal.read(), t.id);
              let ref = await withoutExecutionBudget(() => preserveWorktree(wt, producer));
              if (!ref) {
                const head = await gitHead(wt);
                ref = `refs/tickmarkr/preserved/${head}`;
                const saved = await shGit(`git update-ref ${shq(ref)} ${shq(head)}`, wt);
                if (saved.code !== 0) throw new Error(`could not preserve ${head}: ${saved.stderr}`);
              }
              journal.append("worktree-preserved", t.id, { ref, ...producerFields(producer) });
              await park(t, err.message, "infra", null, 0, Date.now(), 0, 0, undefined, 0, "fresh",
                { disposition: err instanceof ContactUnreadableExhausted ? "contact-unreadable" : "transport-uncertain", ref, ...cleanupEvidence });
              return;
            }
            if (err instanceof ExecutionBudgetExceeded) {
              const wt = worktreePath(repoRoot, `${branch}--${t.id}`);
              const producer = knownProducer(journal.read(), t.id);
              const ref = await preserveWorktree(wt, producer);
              if (ref) journal.append("worktree-preserved", t.id, { ref, ...producerFields(producer) });
              const dispatch = journal.read().reverse().find((e) => e.taskId === t.id && e.event === "task-dispatch");
              await park(t, err.message, "infra", null, 0, Date.now(), 0, 0, undefined, 0, "fresh",
                { disposition: "execution-budget-exhausted", limitMs: cfg.executionPolicy!.taskExecutionLimitMs,
                  ...cleanupEvidence,
                  ...(Number.isInteger(dispatch?.data.attempt) ? { attempt: dispatch!.data.attempt } : {}),
                  ...(dispatch?.data.assignment ? { assignment: dispatch.data.assignment } : {}) });
              return;
            }
            const taskEvents = journal.read().filter((e) => e.taskId === t.id);
            const dispatch = [...taskEvents].reverse().find((e) => e.event === "task-dispatch");
            // OBS-206: shared rule with `resume --retry-failed` — see classifyTaskFailure.
            const kind: ParkKind = classifyTaskFailure(taskEvents);
            const attempts = dispatch && Number.isInteger(dispatch.data.attempt) ? dispatch.data.attempt as number : 0;
            graph = setStatus(graph, t.id, "failed");
            saveGraph(repoRoot, graph);
            journal.append("task-failed", t.id, { error: String(err), kind, attempts, ...cleanupEvidence });
            journal.telemetry({ taskId: t.id, shape: t.shape, adapter: "-", model: "-", channel: "-", attempts: 0, outcome: "failed", durationMs: 0 });
            await reconcile({ spareLiveLlm: true }); // task-failed is a terminal event
          })
          .finally(() => { inflight.delete(t.id); engagements.delete(t.id); });
        inflight.set(t.id, p);
      }
      if (inflight.size === 0) {
        const parked = new Set(graph.tasks.filter((t) => t.status === "human").map((t) => t.id));
        const behindPark = (task: Task): boolean => task.deps.some((id) =>
          parked.has(id) || behindPark(getTask(graph, id)));
        const onlyParks = parked.size > 0 && graph.tasks
          .filter((t) => t.status === "pending").every(behindPark);
        if (onlyParks) {
          if (approvalDeadline === undefined) {
            const windowMs = opts.approvalWindowMs ?? approvalWindowMs;
            approvalDeadline = Date.now() + windowMs;
            journal.append("approval-window-start", undefined, { windowMs, parked: [...parked] });
            // The narrator may itself append a decision at this boundary.
            sweepLiveApprovals();
            if (admissible().length) { approvalDeadline = undefined; continue; }
          }
          if (Date.now() < approvalDeadline) {
            await Promise.race([aborted, new Promise((wake) => setTimeout(wake,
              Math.min(APPROVAL_POLL_MS, approvalDeadline! - Date.now())))]);
            continue;
          }
          journal.append("approval-window-expired", undefined, { parked: [...parked] });
        }
        if (holdEndCondition()) { approvalDeadline = undefined; continue; }
        break;
      }
      approvalDeadline = undefined;
      const waiters: Promise<unknown>[] = [...inflight.values(), aborted];
      // A free slot is itself a scheduling boundary: poll the append-only approval stream instead of
      // sleeping until an unrelated long-running task settles.
      // An open board is polled on the same cadence, so a dead cockpit is noticed mid-task; so is a
      // held reservation still awaiting its claim or its adoption.
      if (inflight.size < concurrency || boardOpened || heldRetry) {
        waiters.push(new Promise((wake) => setTimeout(wake, APPROVAL_POLL_MS)));
      }
      await Promise.race(waiters); // aborted rejects on termination — unwinds the run
      if (inflight.size === 0) holdEndCondition(false);
    }

    // D-07: the sweep now closes only what's LEFT in keptSlots — done-closed worker slots were removed
    // (no double-close) and self-cleaned LLM/consult panes were never added under keepLlm:false. This
    // leaves failed/parked attempts' worker slots, which keep their failure context until run end.
    if (cfg.visibility.keepPanes === "run") {
      for (const s of keptSlots) await closeSlot(s); // panes persist for the run's duration, then clean up
    }

    saveGraph(repoRoot, graph);
    const byStatus = (s: string) => graph.tasks.filter((t) => t.status === s).map((t) => t.id);
    // buckets derived from the graph at summary time (D-01/D-02); the loop has exited with
    // inflight.size === 0, so the five buckets sum to graph.tasks.length by construction.
    const summary: RunSummary = {
      runId,
      branch,
      done: byStatus("done"),
      failed: byStatus("failed"),
      human: byStatus("human"),
      blocked: blockedTasks(graph).map((t) => t.id),
      pending: pendingTasks(graph).map((t) => t.id),
    };

    fatalPhase = "baseline";
    await baselineCapture.catch(error => {
      // A host park is resumable only after baseline publication. Before that, retain the
      // fatal baseline failure: resume requires baseline.json and cannot recover this capture.
      if (!(error instanceof HostDegradedError) || !existsSync(join(journal.dir, "baseline.json"))) throw error;
    });

    fatalPhase = "tip-verify";
    // OBS-34: post-merge integration-tip verify — strict exit codes, no baseline forgiveness.
    const lastMergedTask = [...journal.read()].reverse().find((e) => e.event === "merge" && e.taskId)?.taskId;
    if (summary.done.length > 0 && Object.keys(commands).length > 0) {
      const controller = new AbortController();
      const cancellation = new Error("tip verify cancelled by approval");
      const checkApprovals = () => {
        try {
          sweepLiveApprovals();
          if (admissible().length) controller.abort(cancellation);
          if (termSignal) controller.abort(new Error(`terminated by ${termSignal}`));
        } catch (error) { controller.abort(error); }
      };
      // One timeout belongs to this verification and is retired when it settles.
      let poll: ReturnType<typeof setTimeout> | undefined;
      const pollApprovals = () => {
        checkApprovals();
        if (!controller.signal.aborted) poll = setTimeout(pollApprovals, APPROVAL_POLL_MS);
      };
      poll = setTimeout(pollApprovals, APPROVAL_POLL_MS);
      let tipFailed: boolean;
      try {
        const verification = withCommandContext(undefined,
          () => verifyIntegrationTipCached(intWt, commands, journal, { lastMergedTask, baseline, signal: controller.signal, evidence: { quotaBytes: cfg.gates?.evidenceQuotaBytes } }), controller.signal);
        activeTipVerify = { controller, settled: verification.then(() => {}, () => {}) };
        tipFailed = await verification;
      } catch (error) {
        if (error !== cancellation) throw error;
        journal.append("tip-verify-cancelled", undefined, { reason: "approval", lastMergedTask });
        continue closeLoop;
      } finally {
        activeTipVerify = undefined;
        clearTimeout(poll);
      }
      summary.tipVerify = tipFailed ? "failed" : "passed";
      summary.tipProof = runEndTipProof(journal.read());
      if (tipFailed && lastMergedTask) summary.lastMergedTask = lastMergedTask;
    } else {
      // Exactly one proof per close: no cycle ran for THIS close, and an earlier one is not inherited.
      summary.tipProof = { kind: "incomplete" };
    }

    // T14: read the journal, not the startup `approved` set — an approval appended DURING this run is
    // exactly the one the set cannot see, and it is the one the record has to name.
    //
    // Serialize this sample WITH the run-end append. The daemon holds the boundary through its final
    // graph.lock release in the outer finally: an approval that wins first is included below, while an
    // approval that loses cannot append until the live owner is gone and reports recorded-no-owner.
    // Thus no accepted approval can land after this sample while still being attributed to this run.
    fatalPhase = "scheduler";
    const approvalSerialization = await acquireApprovalSerialization(repoRoot, runId);
    releaseApprovalSerialization = approvalSerialization.release;
    // Close the last poll-to-run-end race while holding the same serializer as approve.
    if (holdEndCondition()) {
      releaseApprovalSerialization();
      releaseApprovalSerialization = undefined;
      // Verification has settled: retain its verdict. The cache key will require a
      // new battery if dispatch actually moves the tip or changes its commands.
      continue closeLoop;
    }
    const outstanding = outstandingApprovals(journal.read());
    summary.approvalDisposition = outstanding.length === 0 ? "complete" : "outstanding";
    if (outstanding.length > 0) summary.outstandingApprovals = outstanding;
    const forgiven = forgivenFingerprints(journal.read());
    if (forgiven.length > 0) summary.forgiven = forgiven;

    journal.append("run-end", undefined, { ...summary });
    await reconcile(); // run-end boundary: nothing in flight — full sweep (empty desired set)
    // OBS-28: lingering worktrees starve CLI probes; keepPanes:forever is the debug override.
    if (!keepForever) {
      const green = summary.failed.length === 0 && summary.human.length === 0
        && summary.blocked.length === 0 && summary.pending.length === 0
        && summary.tipVerify !== "failed";
      await cleanupRunWorktrees(repoRoot, branch, { removeIntegration: green, removeTaskIds: summary.done });
    }
    // VIS-02: name each blocked subtree by its nearest parked/failed root, e.g. "3 blocked behind P40-02".
    const attribution = [...attributeBlocked(graph).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([root, count]) => `${count} blocked behind ${root}`)
      .join(", ");
    const tipFail = summary.tipVerify === "failed"
      ? ` — TIP VERIFY FAILED on ${summary.lastMergedTask ? `last merge ${summary.lastMergedTask}` : "integration tip"}`
      : "";
    await driver.notify(
      `tickmarkr ${runId}: ${summary.done.length} done, ${summary.failed.length} failed, ${summary.human.length} awaiting human, ${summary.blocked.length} blocked, ${summary.pending.length} pending${attribution ? ` (${attribution})` : ""}${tipFail} — ${formatTipProof(summary.tipProof)} — integration branch ${branch} (merge to main is yours)`,
      { tier: summary.tipVerify === "failed" ? "attention" : "routine" },
    );
    return summary;
  }
  });
  });
  } catch (err) {
    // T7 (v1.86): guarded — a journal read/append failure while recording the fatal run-end is
    // reported alongside err, never instead of it; recordFatalRunEnd never throws, so the original
    // error (message, stack, cause) always reaches the caller verbatim.
    // Freeze failure-time buckets, stop new dispatch, and drain all journal writers before closing.
    if (!deliberateTermination) {
      const failedGraph = graph;
      const phase = taskLoopStarted ? (baselineFailed ? "baseline" : fatalPhase) : "setup";
      fatalStop.abort(err);
      await retireFatalSlots?.();
      await Promise.allSettled(inflight.values());
      await baselineCapture.catch(() => {});
      if (runStarted && !deliberateTermination) {
        const tipProof = recordFatalRunEnd(journal, runId, branch, err,
          taskLoopStarted || opts.resume ? failedGraph : undefined, phase);
        // The fatal close states its proof too; a dead notifier never replaces the original error.
        if (tipProof) {
          await driver.notify(`tickmarkr ${runId}: run crashed — ${formatTipProof(tipProof)} — integration branch ${branch}`,
            { tier: "attention" }).catch(() => {});
        }
      }
    }
    throw err;
  } finally {
    // Startup/dispatch errors must not leave a capture running after its daemon releases the lock.
    await baselineCapture.catch(() => {});
    // v1.54 T2: deregister on EVERY exit (normal run end, throw, termination unwind) — the daemon
    // test suite runs runDaemon dozens of times in one process; a leaked handler would close a
    // later run's slots.
    if (onTermination) {
      process.removeListener("SIGINT", onTermination);
      process.removeListener("SIGTERM", onTermination);
    }
    try {
      releaseRunLock(repoRoot);
    } finally {
      releaseApprovalSerialization?.();
    }
  }
}
