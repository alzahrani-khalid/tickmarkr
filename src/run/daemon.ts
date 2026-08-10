import { createHash, type Hash, randomBytes } from "node:crypto";
import { shq } from "../adapters/types.js";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { classifyDeadChannel, NO_TRAILER_SUMMARY, trailerPattern, UNPARSEABLE_TRAILER_SUMMARY, writePrompt } from "../adapters/prompt.js";
import { allAdapters, getAdapter, probeAll, readDoctor, rolePools } from "../adapters/registry.js";
import { type Assignment, addUsage, channelKey, matchesTrustDialog, QUOTA_RE, type TokenUsage, type WorkerAdapter, type WorkerResult } from "../adapters/types.js";
import { bannerShell, paneDispatchCommand } from "../brand.js";
import {
  DEFAULT_DIFF_CAP, globalConfigDir, loadConfigWithMode, readOverlayFile, repoOverlayPath,
  type ModeResolution, type RoutingMode, type TickmarkrConfig,
} from "../config/config.js";
import { DeliveryReadinessError } from "../drivers/herdr.js";
import { herdrSealShellPrefix, SubprocessDriver } from "../drivers/subprocess.js";
import { formatOwnedName, type ExecutorDriver, type Slot } from "../drivers/types.js";
import { type Baseline, captureBaseline, detectGateCommands, detectVacuousOracles } from "../gates/baseline.js";
import { runGates, type GateEvent } from "../gates/run-gates.js";
import type { GateResult } from "../gates/types.js";
import { addEvidence, attributeBlocked, blockedTasks, getTask, graphDefinitionHash, loadGraph, pendingTasks, readyTasks, saveGraph, setStatus } from "../graph/graph.js";
import { GATE_NAMES, type GateName, type Task } from "../graph/schema.js";
import { augmentRetryBrief, consult, renderRetryGuidance, type ConsultVerdict } from "./consult.js";
import { runEnvironment } from "./environment.js";
import { cleanupRunWorktrees, gitHead, linkNodeModules, npmDependencyInstallCommand, npmDependencyManifestChanged, runWithForkBudget, sh, shGit, WORKTREE_LAYOUT_CONTRACT, worktreePath } from "./git.js";
import { runInteractiveSeed, type InteractiveSeedResult } from "./interactive-seed.js";
import { activeRetryBan, classifyTaskFailure, classifyWorkerResultCause, engagementComparable, GATE_FINGERPRINT_CAP, GATE_SATISFIED_RELEASE, identicalGateFailures, journaledFailureBrief, Journal, loadRoutingProfile, newRunId, normalizeGateFailure, pendingRepairFindings, phaseForGate, recordedTaskFailureKind, repairsSinceApproval, reviewRoundsSinceApproval, runHasEnded, structuredFindings, upheldFeedbackByTask, type CurrentAttemptGateReplay, type JournalEvent, type ParkKind, type ResumeState, type RetryMode } from "./journal.js";
import { isDiffCapPark } from "../gates/review.js";
import { acquireApprovalSerialization, acquireRunLock, releaseRunLock } from "./lock.js";
import { ensureIntegration, integrationBranch, integrationHead, mergeTask, verifyIntegrationTip } from "./merge.js";
import { nextChannel, route } from "../route/router.js";
import { desiredPanes } from "./reconcile.js";
import { NUDGEABLE_ADAPTERS, PANE_READ_ROWS, StallProgressTracker, stallSnapshotBannerRows } from "./stall.js";
import { armSupervision, type ArmedSupervision } from "./supervision.js";

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
  driver?: ExecutorDriver;
  adapters?: WorkerAdapter[];
  globalDir?: string;
  // v1.51 T2: run-flag routing mode (--mode / the --quality alias) — the strongest mode source.
  mode?: RoutingMode;
  narrate?: (event: JournalEvent) => void;
  // v1.54 T2: test seam — replaces process.exit in the termination reaper (the vitest process must
  // survive a synthetic signal). Production omits it and the reaper exits the process.
  exit?: (code: number) => void;
  // T16: arm the orchestrator supervision tier for the life of the run. Defaults ON — production
  // never sets it. `false` is the CONTROL: a run that is otherwise identical and arms nothing, so a
  // tier that reads ARMED under a real run proves the RUNTIME armed it rather than something else
  // in the fixture having written a beat.
  supervise?: boolean;
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
  lastMergedTask?: string;
  /** T14: did every approval this run accepted actually get enacted, or did the run end over one? */
  approvalDisposition?: "complete" | "outstanding";
  /** the accepted approvals that never reached a dispatch — named, never left to the park buckets */
  outstandingApprovals?: string[];
}

// T14: the events that prove an approval was ENACTED — narrowly causal, never merely subsequent.
// An ordinary approval (no release, attempt-cap, recheck, review-upheld) all buy a WORKER, so the
// proof is a dispatch. Generic terminal events are deliberately NOT proof: an approved human-gate
// task can fail in routing before task-dispatch, and the catch appends task-failed — treating that
// as enactment reports "complete" over an approval that never ran (the exact silent-completion this
// task exists to kill).
const DISPATCH_ENACTMENT = new Set(["task-dispatch", "repair-dispatch"]);
// The ONE approval that enacts without buying a worker: GATE_SATISFIED_RELEASE resumes from the
// persisted task branch after the approved gate (execTask's satisfiedGate branch), whose first act
// for the task is worktree-recreation. That event is causal for this path, not incidental.
const GATE_SATISFIED_ENACTMENT = "worktree-recreation";

/**
 * T14: approvals the run accepted and never acted on. `approved` above is built ONCE at startup —
 * deliberately, replay determinism depends on it — so an approval written while the daemon is live is
 * inert for that run. Without this the run-end record stated only buckets and tipVerify, both
 * accurate, over a milestone that was silently incomplete: run …230 ended tipVerify "passed" with two
 * upheld approvals and zero subsequent dispatches. Scored per task on its NEWEST approval: a later
 * approval is the live decision, and the events that answer it are the ones after it.
 */
export function outstandingApprovals(events: JournalEvent[]): string[] {
  const newest = new Map<string, number>();
  events.forEach((e, i) => { if (e.event === "task-approved" && e.taskId) newest.set(e.taskId, i); });
  return [...newest]
    .filter(([taskId, i]) => {
      const noWorker = events[i]!.data.release === GATE_SATISFIED_RELEASE;
      return !events.slice(i + 1).some((e) => e.taskId === taskId
        && (DISPATCH_ENACTMENT.has(e.event) || (noWorker && e.event === GATE_SATISFIED_ENACTMENT)));
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
  return `done: ${s.done.length}, failed: ${s.failed.length}, human: ${s.human.length}, blocked: ${s.blocked.length}, pending: ${s.pending.length}\nintegration branch: ${s.branch}${tip}${outstanding}`;
}

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

/** The fix-only contract: the findings verbatim, then the diff content of the work already landed. */
function repairBrief(findings: string, diff: string, baseRef: string): string {
  const repair = { findings, diff };
  return [
    "## Repair attempt — fix ONLY what these findings name",
    "The commits from your prior attempt are already in this worktree and their diff is reproduced"
    + " below. Do NOT re-implement that work, do not start over, and do not revert it: make the"
    + " smallest change that resolves every finding, then commit.",
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

// OBS-419: the newest approval starts the current engagement, so it is also the sole authority for
// that engagement's optional ceiling. Stop at the newest approval even when the field is absent: a
// later ordinary release restores the module default instead of inheriting an older operator limit.
function approvedReviewRoundCeiling(events: JournalEvent[], taskId: string): number | undefined {
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
const PROVIDER_DEATH_REQUEUE_CAP = 2; // v1.46 T1: requeue same assignment twice, then fall through to the normal ladder
const PROVIDER_DEATH_BACKOFF_MS = 500; // short backoff before provider-death requeue
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
// rules can never catch it and the post-loop QUOTA_RE check only runs after the full window. Two
// consecutive matching slices plus this much monotonic-tracker silence classify (a worker whose
// diff merely quotes "rate limit" keeps working undisturbed).
const QUOTA_BANNER_SILENT_MS = 3 * 60_000;
let quotaBannerSilentMs = QUOTA_BANNER_SILENT_MS;
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
// A CPU delta needs two samples separated in WALL CLOCK, and the CPU clock is QUANTIZED: darwin's
// `ps` prints hundredths ("0:00.03"), linux's prints whole seconds ("00:00:01"). Equality across a
// window shorter than the quantum is not evidence of anything — a worker throttled to a low duty
// cycle accrues less than one tick per sample and reads flat while genuinely working. So the flat
// observation must span the LARGER of a floor and this many ticks of the clock actually in use:
// crossing 30 ticks means the tree burned <1 tick in 30, i.e. under ~3% of one core. On a
// hundredths host that is a 3s window; on a whole-second host it is 30s — still nothing against the
// ~15m redispatch it replaces. Resolution is read off the sampled rows, never assumed.
const HARVEST_CPU_FLAT_MS = 3_000;
const HARVEST_CPU_FLAT_TICKS = 30;
// Once the flat window opens, retain descendants often enough to observe brief tool processes that
// can start and exit between the daemon's ordinary wait slices. This sampler exists only during an
// eligible silence window; it is stopped on progress or as soon as the worker wait concludes.
const HARVEST_CPU_ACCOUNTING_POLL_MS = 100;
// T2 review (material): that 100ms cadence forks a shell plus `ps` ten times a second, and on a host
// where `ps` is unsupported or denied (the managed-sandbox class) EVERY sample fails — tens of
// thousands of processes per silent attempt, multiplied by daemon concurrency, for a probe that can
// never conclude anything. Persistent failure is structural, not transient, so the sampler STOPS
// after this many consecutive unreadable snapshots. It stays stopped for the silence window it was
// started for: read() then reports no CPU, the triad refuses to conclude and journals the gap, and a
// later window (after real progress clears the accountant) starts a fresh one that pays the same
// bounded probe again.
const HARVEST_CPU_UNMEASURABLE_SAMPLE_CAP = 20;
let harvestCpuFlatMs: number | undefined;
export function harvestCpuFlatWindowMs(resolutionMs: number): number {
  return harvestCpuFlatMs ?? Math.max(HARVEST_CPU_FLAT_MS, resolutionMs * HARVEST_CPU_FLAT_TICKS);
}
/** Test seam — pin the flat window so a probe case need not sit through a real one. */
export function setHarvestCpuFlatMsForTests(ms: number): void {
  harvestCpuFlatMs = ms;
}
export function resetHarvestCpuFlatMsForTests(): void {
  harvestCpuFlatMs = undefined;
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
function lastVerifyCycle(events: JournalEvent[]): { tip: string; cmdHash: string; gates: Set<string>; failed: boolean } | undefined {
  let cur: { tip: string; cmdHash: string; gates: Set<string>; failed: boolean } | undefined;
  let afterRunEnd = false;
  for (const e of events) {
    // New journals delimit every attempt explicitly. run-end is the legacy delimiter: it starts a
    // new cycle only when another verify event follows, while preserving the just-closed cycle as
    // the cache candidate for an otherwise unmoved next run-end.
    if (e.event === "tip-verify-start") {
      const { tip, cmdHash } = e.data;
      cur = typeof tip === "string" && typeof cmdHash === "string"
        ? { tip, cmdHash, gates: new Set(), failed: false }
        : undefined;
      afterRunEnd = false;
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
      cur = { tip, cmdHash, gates: new Set(), failed: false };
    }
    afterRunEnd = false;
    if (e.event === "tip-verify-failed") cur.failed = true;
    else cur.gates.add(gate);
  }
  return cur;
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
  opts: { lastMergedTask?: string } = {},
): Promise<boolean> {
  const cmdHash = commandsHash(commands);
  const tip = await gitHead(intWt);
  const porcelain = await shGit("git status --porcelain", intWt);
  const clean = porcelain.code === 0 && porcelain.stdout.trim() === "";
  const last = lastVerifyCycle(journal.read());
  const cached = last !== undefined && !last.failed && last.tip === tip && last.cmdHash === cmdHash
    && Object.keys(commands).every((g) => last.gates.has(g));
  // A pair can be verified red and then green without either SHA or command hash changing (for
  // example, an external service or ignored fixture recovers). Delimit attempts explicitly so that
  // the earlier red cannot remain latched into the later complete green cycle.
  journal.append("tip-verify-start", undefined, { tip, cmdHash, gates: Object.keys(commands), cached: clean && cached });
  if (clean && cached) {
    journal.append("tip-verify-cached", undefined, { tip, cmdHash, gates: Object.keys(commands) });
    // The skip must not read as a red. Every surface derives the tip's verdict from this cycle's
    // `tip-verify` events (cockpit derive.ts tipVerificationPassed: a run-end claiming "passed" with
    // ZERO events is fail-closed to FALSE), so a carried-forward green still journals its per-gate
    // pass — `cached: true` keeps it honest about not having re-run the command.
    for (const gate of Object.keys(commands)) {
      journal.append("tip-verify", undefined, { gate, cmd: commands[gate], pass: true, exitCode: 0, cached: true, tip, cmdHash });
    }
    return false;
  }
  let tipFailed = false;
  for (const r of await verifyIntegrationTip(intWt, commands, journal.dir)) {
    if (r.pass) {
      journal.append("tip-verify", undefined, { gate: r.gate, cmd: r.cmd, pass: true, exitCode: r.exitCode, details: r.details, tip, cmdHash });
    } else {
      journal.append("tip-verify-failed", undefined, {
        gate: r.gate,
        cmd: r.cmd,
        exitCode: r.exitCode,
        fingerprints: r.fingerprints,
        artifact: r.artifact,
        lastMergedTask: opts.lastMergedTask,
        tip,
        cmdHash,
      });
      tipFailed = true;
    }
  }
  return tipFailed;
}

// `ps` CPU time: "[[dd-]hh:]mm:ss[.frac]" (darwin prints "0:00.03", linux "00:00:01", both print
// "1-02:03:04" past a day). Anything else is a header or a row this parser must not guess at.
// `frac` reports whether THIS host prints sub-second digits — the quantum the flat window is sized
// against, measured rather than assumed (a darwin sample is 10ms, a linux one 1000ms).
function parsePsCpu(raw: string): { ms: number; frac: boolean } | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) return undefined;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60_000 + Math.round(Number(m[4]!) * 1000);
  return { ms, frac: m[4]!.includes(".") };
}

interface WorkerTreeCpuSnapshot {
  processes: Map<string, number>;
  resolutionMs: number;
}

let linuxClockTickMs: Promise<number | undefined> | undefined;
function linuxProcessCpuMs(pid: string, cwd: string): Promise<{ ms: number; resolutionMs: number } | undefined> {
  if (!existsSync("/proc/self/stat")) return Promise.resolve(undefined);
  // shGit, not sh: the accountant samples this path at a 100ms cadence, and a LOGIN shell would
  // re-run the operator's profile (nvm/pyenv/direnv side effects included) on every sample.
  linuxClockTickMs ??= shGit("getconf CLK_TCK", cwd, 15_000).then((r) => {
    const ticks = r.code === 0 ? Number(r.stdout.trim()) : Number.NaN;
    return Number.isFinite(ticks) && ticks > 0 ? 1_000 / ticks : undefined;
  });
  return linuxClockTickMs.then((resolutionMs) => {
    if (resolutionMs === undefined) return undefined;
    try {
      // `/proc/<pid>/stat` fields 14-17 are user/system jiffies for the process and its waited-for
      // children. The child totals retain tools that start and exit wholly between live-tree polls.
      // Split after the LAST ')' because comm may contain spaces or parentheses; field 3 is rest[0].
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const ticks = Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]);
      return Number.isFinite(ticks) ? { ms: ticks * resolutionMs, resolutionMs } : undefined;
    } catch {
      return undefined; // process exited between ps ancestry capture and the precise CPU read
    }
  });
}

// T2 (OBS-264): the triad's CPU leg. Every non-seeded process of an attempt descends from that
// attempt's own dispatch script, whose path is unique — print, argv-interactive and resume launches
// all start there. (interactive-seed is intentionally fail-open below because its adapter-owned
// launch bypasses this script.) ONE `ps` snapshot finds the root and all current descendants:
// the agent CLI is a CHILD of the script's shell, so the root's own TIME never moves while the CLI
// thinks. `resolutionMs` is the sampled clock's quantum, which sizes the caller's flat window.
// Returns 0 when nothing matches: a worker whose process tree is gone is the strongest possible
// "not working". Returns undefined when the snapshot itself failed or parsed to nothing —
// unmeasurable CPU is never evidence a worker stopped, and the caller refuses to conclude on it.
async function workerTreeCpuSnapshot(marker: string, cwd: string): Promise<WorkerTreeCpuSnapshot | undefined> {
  // shGit, not sh: same login-shell cost as the CLK_TCK probe above — `ps` needs no profile.
  const snapshot = await shGit("ps -Awwo pid=,ppid=,time=,command=", cwd, 15_000);
  if (snapshot.code !== 0) return undefined;
  const rows: { pid: string; ppid: string; cpuMs: number; frac: boolean; cmd: string }[] = [];
  for (const line of snapshot.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cpu = parsePsCpu(m[3]!);
    if (cpu !== undefined) rows.push({ pid: m[1]!, ppid: m[2]!, cpuMs: cpu.ms, frac: cpu.frac, cmd: m[4]! });
  }
  if (rows.length === 0) return undefined;
  const tree = new Set(rows.filter((p) => p.cmd.includes(marker)).map((p) => p.pid));
  // `ps` output is not topologically ordered — relax the parent→child closure until it stops growing.
  for (let grew = true; grew;) {
    grew = false;
    for (const p of rows) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; }
    }
  }
  const precise = new Map<string, number>();
  let preciseResolutionMs: number | undefined;
  for (const p of rows) {
    if (!tree.has(p.pid)) continue;
    const cpu = await linuxProcessCpuMs(p.pid, cwd);
    precise.set(p.pid, cpu?.ms ?? p.cpuMs);
    if (cpu !== undefined) preciseResolutionMs = cpu.resolutionMs;
  }
  // Even an empty worker tree needs the host's actual measurement quantum: on Linux the /proc
  // jiffy clock remains available after the worker exits, while `ps time` only prints whole seconds.
  if (preciseResolutionMs === undefined && existsSync("/proc/self/stat")) {
    preciseResolutionMs = (await linuxProcessCpuMs(String(process.pid), cwd))?.resolutionMs;
  }
  return {
    processes: precise,
    resolutionMs: preciseResolutionMs ?? (rows.some((p) => p.frac) ? 10 : 1_000),
  };
}

export async function workerTreeCpuMs(marker: string, cwd: string): Promise<{ ms: number; resolutionMs: number } | undefined> {
  const snapshot = await workerTreeCpuSnapshot(marker, cwd);
  if (snapshot === undefined) return undefined;
  return {
    ms: [...snapshot.processes.values()].reduce((sum, cpuMs) => sum + cpuMs, 0),
    resolutionMs: snapshot.resolutionMs,
  };
}

// Sparse live-tree totals forget a tool's CPU as soon as that tool exits. This attempt-local
// accountant instead adds each observed process's CPU DELTA to a monotonic total and replaces only
// the live-PID cursor on each sample. When a PID disappears, its contribution stays in `totalMs`;
// if that PID is later reused, its fresh total is added from zero because it left `live` in between.
class WorkerTreeCpuAccountant {
  private active = false;
  private loop: Promise<void> | undefined;
  private live = new Map<string, number>();
  private totalMs = 0;
  private gaps = 0;
  private consecutiveGaps = 0;
  private latest: { ms: number; resolutionMs: number } | undefined;

  constructor(private marker: string, private cwd: string) {}

  private async sample(): Promise<void> {
    const snapshot = await workerTreeCpuSnapshot(this.marker, this.cwd);
    if (snapshot === undefined) {
      this.gaps++;
      this.live.clear();
      this.latest = undefined;
      // Stop forking `ps` at 10Hz once the host has proved it cannot answer — see the cap's comment.
      if (++this.consecutiveGaps >= HARVEST_CPU_UNMEASURABLE_SAMPLE_CAP) this.active = false;
      return;
    }
    this.consecutiveGaps = 0;
    for (const [pid, cpuMs] of snapshot.processes) {
      const prior = this.live.get(pid);
      this.totalMs += prior === undefined || cpuMs < prior ? cpuMs : cpuMs - prior;
    }
    this.live = snapshot.processes;
    this.latest = { ms: this.totalMs, resolutionMs: snapshot.resolutionMs };
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.sample();
    this.loop = (async () => {
      while (this.active) {
        await new Promise((resolve) => setTimeout(resolve, HARVEST_CPU_ACCOUNTING_POLL_MS));
        if (this.active) await this.sample();
      }
    })();
  }

  read(): { cpu: { ms: number; resolutionMs: number } | undefined; gaps: number } {
    return { cpu: this.latest, gaps: this.gaps };
  }

  async stop(): Promise<void> {
    this.active = false;
    await this.loop;
  }
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

async function cherryPickCommits(wt: string, commits: string[]): Promise<string[]> {
  const carried: string[] = [];
  for (const hash of commits) {
    const r = await shGit(`git cherry-pick --no-gpg-sign ${shq(hash)}`, wt);
    if (r.code !== 0) {
      await shGit("git cherry-pick --abort", wt);
      break;
    }
    carried.push(hash);
  }
  return carried;
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
function recordFatalRunEnd(journal: Journal, runId: string, branch: string, err: unknown): void {
  const original = err instanceof Error ? err.message : String(err);
  try {
    if (journal.read().some((e) => e.event === "run-end")) return; // already terminal — nothing to add
  } catch (readErr) {
    console.error(`tickmarkr ${runId}: journal read failed while recording the fatal run-end (${readErr instanceof Error ? readErr.message : String(readErr)}) — original error: ${original}`);
  }
  const record = {
    runId,
    branch,
    done: [],
    failed: [],
    human: [],
    blocked: [],
    pending: [],
    phase: "setup",
    fatal: true,
    error: original,
  };
  try {
    journal.append("run-end", undefined, record);
    return;
  } catch {
    // one retry below — the first failure is reported only if the retry also fails
  }
  const journalPath = join(journal.dir, "journal.jsonl");
  try {
    terminateTornJournalTail(journalPath);
    journal.append("run-end", undefined, record);
  } catch (retryErr) {
    console.error(`tickmarkr ${runId}: run crashed — no terminal record written; journal sink unwritable at ${journalPath} (${retryErr instanceof Error ? retryErr.message : String(retryErr)}) — original error: ${original}`);
  }
}

export async function runDaemon(repoRoot: string, opts: RunOptions = {}): Promise<RunSummary> {
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
  // T16: the orchestrator seat IS this daemon, so this is where the tier gets armed — the writer half
  // T3 shipped had no caller outside its own tests, which made the reader honest and useless: it read
  // ABSENT for the entire life of every run. Armed immediately after the lock (the first instant this
  // process owns the run) and held to the last, so the beat's span is the run's span. armSupervision
  // never throws, so an unwritable beat can never take a run down; it is deregistered in BOTH exits
  // below, because the signal reaper exits the process before the finally can run.
  const supervision: ArmedSupervision | undefined =
    opts.supervise === false ? undefined : armSupervision(repoRoot, "orchestrator");
  // v1.54 T2: declared before the try so the finally can always deregister (a throw before
  // registration leaves it undefined — the guard below covers that path).
  let onTermination: ((sig: NodeJS.Signals) => void) | undefined;
  let journal!: Journal;
  let runStarted = false;
  let taskLoopStarted = false;
  let branch = "";
  let releaseApprovalSerialization: (() => void) | undefined;
  try {
  let graph = loadGraph(repoRoot);
  // v1.51 T2: the routing mode resolves BEFORE any routing input is built — run flag > spec front-matter
  // > repo > global > default. The resolved cfg carries mode-compiled floors; route() never sees the mode.
  const rm = resolveRunMode(repoRoot, { flag: opts.mode, spec: graph.mode, globalDir: opts.globalDir });
  const cfg = rm.cfg;
  // T9: the run's concurrency is resolved HERE, once, and this single value is both what the
  // dispatch loop enforces below and what the fork budget divides the machine by. Resolving it
  // twice (or re-reading argv/the overlay at spawn time) is how a run ends up enforcing one number
  // while its shells are sized for another. The budget wraps the whole body — baseline capture,
  // every gate battery, tip verify and every worker environment — so no shell this run launches
  // can predate it, and it is entered per-call so a concurrent run never inherits this one's.
  const concurrency = opts.concurrency ?? cfg.concurrency;
  return await runWithForkBudget(concurrency, async () => {
  // v1.51 T4: every dispatch provenance line begins with the mode and its source; when a pin won
  // the route (the final "→ " segment is a pin, not a degraded-to-auto tail) it names the mode it bypassed.
  const dispatchProvenance = (p: string): string =>
    `mode ${rm.mode.mode} (${rm.source})${p.split("→ ").pop()!.startsWith("pin ") ? ` — pin bypasses mode ${rm.mode.mode}` : ""} · ${p}`;
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
  const closeSlot = async (s: Slot): Promise<void> => {
    if (!liveSlots.delete(s)) return; // already closed — never twice
    await driver.close(s);
  };
  const trackedDriver: ExecutorDriver = {
    id: driver.id,
    interactive: driver.interactive,
    slot: async (cwd, name, o) => { const s = await driver.slot(cwd, name, o); liveSlots.add(s); return s; },
    run: (s, cmd) => driver.run(s, cmd),
    waitOutput: (s, p, ms, o) => driver.waitOutput(s, p, ms, o),
    waitAgentStatus: (s, st, ms) => driver.waitAgentStatus(s, st, ms),
    status: (s) => driver.status(s),
    read: (s, n) => driver.read(s, n),
    ...(driver.sendKey ? { sendKey: driver.sendKey.bind(driver) } : {}),
    ...(driver.nudge ? { nudge: driver.nudge.bind(driver) } : {}),
    notify: (m, o) => driver.notify(m, o),
    close: closeSlot,
    worktree: (r, b, base) => driver.worktree(r, b, base),
  };
  // Termination (SIGINT/SIGTERM): record the daemon-controlled exit before closing every live slot,
  // reconcile owned panes against an EMPTY
  // desired set (herdr panes not in memory; panesToClose spares foreign names, watch panes, and
  // other runs' panes by construction), release the run lock, then exit. There is still no run-end,
  // so stop-amend-resume keeps resuming; exit-cause distinguishes this deliberate stop from an
  // observer-classified abrupt death. keepPanes:"forever" (the
  // keep-everything debug override) preserves panes but still releases the lock and exits.
  let termSignal: NodeJS.Signals | undefined;
  let abortRun: (err: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { abortRun = reject; });
  aborted.catch(() => { /* pre-handled: a signal after the loop drained must not crash as unhandled */ });
  let reaping = false;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  onTermination = (sig: NodeJS.Signals) => {
    termSignal = sig;
    void (async () => {
      if (!reaping) {
        reaping = true;
        try { journal?.append("exit-cause", undefined, { cause: "deliberate", signal: sig }); }
        catch (error) {
          console.error(`tickmarkr ${runId}: deliberate exit cause could not be journalled (${error instanceof Error ? error.message : String(error)})`);
        }
        if (cfg.visibility.keepPanes !== "forever") {
          for (const s of liveSlots) { // closeSlot only deletes the element being visited — safe during Set iteration
            try { await closeSlot(s); } catch { /* cosmetic — reconcile is the backstop */ }
          }
          try { await driver.reconcile?.(new Set(), runId); } catch { /* cosmetic — visibility is never a gate */ }
        }
        supervision?.disarm(); // T16: same reason as the lock — this seat stood down, it did not die
        releaseRunLock(repoRoot); // the process dies at exit() below — the finally never runs on this path
      }
      abortRun(new Error(`terminated by ${sig}`));
      exit(sig === "SIGINT" ? 130 : 143);
    })();
  };
  process.on("SIGINT", onTermination);
  process.on("SIGTERM", onTermination);

  journal = opts.resume ? Journal.open(repoRoot, runId, opts.narrate) : Journal.create(repoRoot, runId, opts.narrate);
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
  // flag. Built ONCE at startup from the journal; a fresh run's journal is empty ⇒ empty set ⇒ unapproved
  // gates park exactly as today. (D-02 step 3 — the load-bearing change: a command + event WITHOUT this
  // guard change ships a no-op; the task replays to pending, re-enters execTask, and re-parks.)
  const approved = new Set(journal.read().filter((e) => e.event === "task-approved" && e.taskId).map((e) => e.taskId as string));
  const commands = detectGateCommands(repoRoot, cfg);

  let baseRef: string;
  let baseline: Baseline;
  // Phase 46 (RES-01/RES-02): the resume-state map is built ONCE here so execTask closes over it.
  // Empty Map on fresh runs — every seed below conditions on resume.get(t.id), never on opts.resume (the
  // GATE-08 lesson at the humanGate guard: condition on the data, not the code path). Dead-code
  // equivalence to the router.ts:194 profile⇒undefined pattern: no map entry ⇒ today's literal.
  const resume = opts.resume ? journal.replayResumeState() : new Map<string, ResumeState>();
  const satisfiedGates = opts.resume ? journal.replaySatisfiedGates() : new Map<string, GateName>();
  const replayedGateResults = resumeLifecycleOpen
    ? journal.replayCurrentAttemptGateResults()
    : new Map<string, CurrentAttemptGateReplay>();
  const replayedExclusions = opts.resume ? journal.replayExcludedChannels() : new Set<string>();
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
    baseline = JSON.parse(readFileSync(join(journal.dir, "baseline.json"), "utf8"));
    const replayEvents = journal.read();
    for (const [id, st] of journal.replayStatuses()) {
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
      pid: process.pid, // v1.13 (VIS-11): record the live daemon pid for status liveness
      ...(replayedExclusions.size > 0 ? { excludedChannels: [...replayedExclusions].sort() } : {}),
      ...(opts.retryFailed ? { retryFailed: true } : {}),
    });
  } else {
    baseRef = await gitHead(repoRoot);
    baseline = await captureBaseline(repoRoot, commands);
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline, null, 2));
    // v1.70 T2: environment identity beside the graph/branch identity — running tickmarkr version,
    // loaded-config hash, and the probed CLI version of each adapter holding a channel in the run,
    // gathered through the existing probe/config-load paths (no second mechanism).
    const environment = runEnvironment(cfg, channels, health);
    journal.append("run-start", undefined, { pid: process.pid, baseRef, commands, channels: channels.map(channelKey), branch, graphDefinitionHash: graphDefinitionHash(graph), mode: rm.mode.mode, modeSource: rm.source, environment, ...(prior ? { supersedes: prior.runId } : {}) }); // graphDefinitionHash: T3 engagement identity (status+resume share it); pid: v1.13 (VIS-11) liveness; mode/modeSource: v1.51 T2; supersedes: v1.53 T5
    runStarted = true;
    // v1.53 T5: mark the prior run AFTER this run's run-start exists, so the prior journal never
    // names a successor that has no journal. Append-only — the prior journal is never rewritten.
    prior?.append("superseded", undefined, { by: runId });
    for (const warning of baseline.warnings ?? []) journal.append("baseline-warning", undefined, { ...warning });
    // Tier A #3: run each task's command-typed acceptance oracles against the pristine baseline —
    // one that already exits 0 verifies nothing. Warning only, taskId-stamped; never a gate input.
    for (const w of await detectVacuousOracles(repoRoot, graph.tasks)) journal.append("baseline-warning", w.taskId, { ...w });
  }

  // T6: open the narrator AFTER run-start/run-resume is journaled so the watch surface has a run to
  // show. driver.narrator is undefined on subprocess → no-op (subprocess spawns nothing). Swallowed:
  // a failed-to-open or later-dead watch pane never affects the run.
  // OBS-103: hold the returned slot — narrator() adopts an already-open watch by its owned name
  // (a prior daemon instance's, after a stop→resume cycle), so the run-end sweep below can retire
  // it regardless of which instance split the pane.
  const watchName = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
  let watchSlot: Slot | undefined;
  try {
    watchSlot = await driver.narrator?.(repoRoot, "tickmarkr status --watch", runId);
  } catch {
    /* cosmetic-only — the run proceeds without a live surface */
  }

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
  const reconcile = async (opts?: { spareLiveLlm?: boolean }) => {
    if (keepForever) return;
    try {
      const desired = desiredPanes(journal.read(), runId);
      // The watch pane is never the DRIVER sweep's candidate (panesToClose spares role "watch":
      // herdr's watches bookkeeping lives in close(), and a raw pane-close in the sweep would
      // leave narrator() a stale cache) — the driver always sees it as desired; its lifecycle is
      // decided here from the fold alone.
      await driver.reconcile?.(new Set([...desired, watchName]), runId, opts);
      // OBS-103: when the fold retires the watch (run-end boundary), close the narrator. The
      // decision keys on the run identity in the pane name — narrator() adopts a prior daemon
      // instance's pane under the same owned name, so a stop→resume cycle's leftover narrator
      // closes exactly like one this instance opened. A narrator carrying a non-canonical name
      // (no run identity) is never this run's to sweep.
      if (watchSlot && watchSlot.name === watchName && !desired.has(watchName)) {
        const w = watchSlot;
        watchSlot = undefined;
        await driver.close(w);
      }
    } catch {
      /* cosmetic — visibility is never a gate */
    }
  };
  await reconcile(); // run start/resume boundary: nothing in flight — full sweep, incl. older runs' leftovers

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
      journal.phaseStart(t.id, "merge");
      return mergeTask(intWt, taskBranch, `tickmarkr: merge ${t.id} ${t.title}`, gated);
    });
    mergeChain = next.catch(() => undefined);
    return next;
  };

  // gateFails/consults are execTask-scoped counters passed in so a park row is a rich verified-failure
  // observation (e.g. ladder-exhausted + gateFails:4); every task-human row has a closed kind, never prose alone.
  const park = async (t: Task, reason: string, kind: ParkKind, assignment: Assignment | null, attempts: number, startMs: number, gateFails = 0, consults = 0, tokens?: TokenUsage, metered = 0, retryMode: RetryMode = "fresh") => {
    graph = setStatus(graph, t.id, "human");
    saveGraph(repoRoot, graph);
    journal.append("task-human", t.id, { reason, kind });
    if (assignment) {
      journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts, outcome: "human", durationMs: Date.now() - startMs, parkKind: kind, gateFails, consults, tokens, meteredAttempts: tokens ? metered : undefined, retryMode });
    }
    await reconcile({ spareLiveLlm: true }); // task-human is a terminal event — sweep, sparing sibling tasks' live LLM panes
    await driver.notify(`tickmarkr ${runId}: ${t.id} needs a human — ${reason}`, { tier: "attention" });
  };

  const execTask = async (t: Task): Promise<void> => {
    const startMs = Date.now();
    const taskTimeoutMinutes = t.timeoutMinutes ?? cfg.taskTimeoutMinutes;
    if (t.humanGate && !approved.has(t.id)) {
      // GATE-08: the condition is the APPROVAL, never the code path. `!opts.resume` (or any run-phase
      // term) would silently dispatch every unapproved gate that becomes ready during a resume — pinned
      // by the resume-path guard pin in tests/run/daemon.test.ts (the only test that reaches this guard
      // on the resume path; a park-then-resume task is filtered out by readyTasks() and never gets here).
      await park(t, `humanGate: "${t.title}" requires approval before dispatch`, "human-gate", null, 0, startMs);
      return;
    }

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
    // lastAssignment while keeping tried. Only restore lastAssignment when attempts > 0 — after a
    // fresh-budget release, prefer nextChannel over the surviving tried-list so burned channels are
    // not re-tried first (consult bans / prior failovers survive the release).
    const rs = resume.get(t.id);
    if (rs?.lastAssignment && rs.attempts > 0
        && channels.some((c) => channelKey(c) === channelKey(rs.lastAssignment!))
        && !demotedChannels.has(channelKey(rs.lastAssignment!))) {
      assignment = rs.lastAssignment; // restore the consult-chosen assignment (bypasses route()'s static re-pick)
    } else if (rs && rs.tried.length) {
      // trailing-reroute edge (kill between verdict and dispatch), a stale fleet, OR a fresh-budget
      // release (attempts 0 + non-empty tried): pick a failover over the replayed exclusions via the
      // EXISTING nextChannel `tried` parameter — zero router changes (D-03).
      const next = nextChannel(assignment, t, cfg, channels, rs.tried, profile, demotedChannels);
      if (next) assignment = next;
      // ponytail: nextChannel null (every channel already tried / none available) — keep the static
      // assignment and proceed. Dispatching on a previously-tried channel beats deadlocking a resumed
      // run; a park-instead policy can come later if it ever bites.
    }
    // pre-kill invariant: tried always contains the current assignment. Spread, never alias the
    // journal-derived array (no hidden mutation of replayed state).
    const tried = rs?.tried.length ? [...rs.tried] : [channelKey(assignment)];
    if (!tried.includes(channelKey(assignment))) tried.push(channelKey(assignment));
    // VIS-02 convention: absence = no seeding happened. The observable surface for criterion 2's
    // exclusion-list-equality oracle. Daemon-side append only — no journal.ts write-path change (Phase 48
    // stays unblocked); inert to replayStatuses (unknown events ignored, pinned at journal.test.ts:70-80).
    if (rs) journal.append("resume-restore", t.id, { attempts: rs.attempts, tried: [...tried], assignment });
    const badReviewers: string[] = []; // v1.1: reviewer channels that produced unparseable output for this task
    // v1.70 T5 (review-convergence): failed review rounds this task has drawn, counted from the per-task
    // review history already in the journal — the SAME review gate-result stream onGate reads to grow the
    // reviewer-exclusion list (badReviewers), never a second parallel counter. OBS-189: scoped to the
    // current engagement — an operator approval (uphold or accept) resets the round budget, so an upheld
    // task can dispatch its funded attempt instead of re-parking against the whole journal's history.
    const reviewRoundsDrawn = () => reviewRoundsSinceApproval(decisiveReviewRounds(journal.read()), t.id);
    // OBS-193: journal the in-gate review retry (mirrors judge-retry) and exclude the flaked seat from
    // later attempts' reviewer picks. One helper, called from both onGate sites (satisfied-gate + main).
    const noteReviewRetry = (g: GateResult) => {
      const rr = g.meta?.reviewRetry as { flaked?: unknown; retried?: unknown } | undefined;
      if (g.gate === "review" && rr && typeof rr.flaked === "string" && typeof rr.retried === "string") {
        journal.append("review-retry", t.id, {
          gate: "review", flaked: rr.flaked, retried: rr.retried,
          ...(g.meta?.unparseable === true ? { secondUnparseable: true } : {}),
        });
        badReviewers.push(rr.flaked);
      }
    };
    // v1.85 T3 (ruling R4): every BLOCKING review/judge result lands its findings in the journal
    // structured — class + canonical path + stable symbol — so a retry, a consult or an auto-uphold
    // decision reads identity instead of re-parsing prose, and line-number churn is not a new finding.
    // One helper, both onGate sites (satisfied-gate resume + main attempt loop).
    let gateSubject: { commit: string; attempt: number; replayMeasurement?: true } | undefined;
    const journalGateResult = (g: GateResult) => {
      const blocking = gateFailed(g) && (g.gate === "review" || g.gate === "acceptance");
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
      const unverdicted = g.meta?.skipped === true && !g.pass;
      journal.append("gate-result", t.id, {
        gate: g.gate, ...(unverdicted ? {} : { pass: g.pass }), details: g.details,
        ...(gateSubject ? { commit: gateSubject.commit, attempt: gateSubject.attempt } : {}),
        ...(gateSubject?.replayMeasurement ? { replayMeasurement: true } : {}),
        ...(g.meta?.skipped === true ? { skipped: true } : {}),
        // T9: an infra-only exit is journaled AS one. The operator reading a red `test` row has to
        // be able to tell "the suite found a defect" from "the runner never ran", and the merge
        // predicate's reason for refusing has to be legible in the ledger it refused from.
        ...(g.meta?.infra === true ? { infra: true } : {}),
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
        // A finding's path is its own evidence path. Do not pass task scope here: a declaration says
        // where work is allowed, not where this verdict found the defect.
        ...(blocking ? { findings: structuredFindings(g.gate, g.details) } : {}),
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
    // remainder of one already-running gate. A gate that THROWS kills the round before merge, so a
    // row held behind it is lost with the round it belonged to — not a verdict that could have merged.
    const parallelPending = new Set<GateName>();
    let heldParallel: (() => void) | undefined;
    const notePhaseStart = (e: Extract<GateEvent, { phase: "start" }>) => {
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
    const upheldFeedback = upheldFeedbackByTask(journal.read()).get(t.id) ?? rs?.upheldFeedback;
    let feedback = upheldFeedback
      ? `The operator UPHELD the reviewer's findings — address them without discarding landed work.\nreview: ${upheldFeedback}`
      : "";
    let ladderIdx = 0;
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
      e.event === "gate-result" && e.taskId === t.id && e.data.gate === "test" && e.data.pass === false);
    let retryMode: RetryMode = "fresh";
    let lastContextTokens: number | undefined; // v1.23 reset signal, including stalled/quota attempts
    // v1.29: only a gate-failed attempt can seed same-session retry. The next attempt consumes this
    // once; a changed channel, unknown context, or missing resumeCommand falls back to fresh.
    let retrySession: { channel: string; id: string; contextTokens?: number } | undefined;

    // ROUTE-13: learned within-band failover + deviation audit. nextChannel stays pure (route/ never
    // journals); the daemon compares the learned pick against the static pick and owns the journal write.
    const failover = (site: "consult-reroute" | "quota-failover" | "dead-channel" | "escalate"): Assignment | null => {
      const next = nextChannel(assignment, t, cfg, channels, tried, profile, demotedChannels);
      if (profile && next) {
        const staticNext = nextChannel(assignment, t, cfg, channels, tried, undefined, demotedChannels);
        if (staticNext && channelKey(next) !== channelKey(staticNext)) {
          journal.append("failover-deviation", t.id, { site, static: channelKey(staticNext), chosen: channelKey(next) });
        }
      }
      return next;
    };

    // OBS-202 (operator law: "you can spawn as many as you want"): channels are session FACTORIES,
    // not consumed seats — a tried channel can always host a fresh worker session, and a fresh
    // session carries none of the failed attempt's baggage. When the untried pool is empty, recycle
    // the best LIVE channel (preferring a different seat than the current one) instead of parking
    // on artificial scarcity; MAX_ATTEMPTS and the review round cap are the real bounds. Only a
    // fleet whose every channel is DEMOTED (verified dead: auth/setup/provider outage) has nothing
    // left to spawn — that case alone still parks.
    const failoverOrRecycle = (site: "consult-reroute" | "dead-channel"): Assignment | null => {
      const next = failover(site);
      if (next) return next;
      const recycled = nextChannel(assignment, t, cfg, channels, [channelKey(assignment)], profile, demotedChannels)
        ?? (demotedChannels.has(channelKey(assignment)) ? null : assignment);
      if (recycled) journal.append("channel-recycle", t.id, { site, channel: channelKey(recycled) });
      return recycled;
    };

    const runConsult = (trigger: string, transcript: string, diffOrFeedback: string, gates: GateResult[]) => {
      consults++;
      return consult(
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
        { keep: keepLlm, onSlot: keepLlm ? (s: Slot) => keptSlots.push(s) : undefined, runId, channels: pools.consult },
      );
    };

    // returns true → continue attempting, false → task is terminal (parked)
    // trigger (why the consult ran) is threaded in so the decompose/human park keeps its cause —
    // rows 6/10/11 of the mapping (gate-fail vs stall vs merge-conflict) would otherwise conflate.
    const applyVerdict = async (v: ConsultVerdict, attempts: number, trigger: ParkKind): Promise<boolean> => {
      journal.append("consult-verdict", t.id, {
        action: v.action, notes: v.notes,
        ...(v.reason ? { reason: v.reason } : {}),
        ...(v.guidance ? { guidance: v.guidance } : {}),
        ...(v.excludeAdapter ? { excludeAdapter: v.excludeAdapter } : {}),
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
        if (v.excludeAdapter) {
          for (const c of channels) {
            if (c.adapter === v.excludeAdapter) {
              const k = channelKey(c);
              if (!tried.includes(k)) tried.push(k);
            }
          }
        }
        const next = failoverOrRecycle("consult-reroute");
        if (next) {
          assignment = next;
          const k = channelKey(next);
          if (!tried.includes(k)) tried.push(k);
          return true;
        }
        await park(t, "consult said reroute but every channel is demoted (verified dead) — nothing left to spawn", "reroute-exhausted", assignment, attempts, startMs, gateFails, consults, tokens, metered, retryMode);
        return false;
      }
      await park(t, `consult verdict: ${v.action} — ${v.notes}`, trigger, assignment, attempts, startMs, gateFails, consults, tokens, metered, retryMode); // decompose|human
      return false;
    };

    // OBS-130/T15: both gate-resume paths consume the persisted task branch with no worker dispatch.
    // An operator approval skips its exact failed gate by authority; observed results skip only the
    // contiguous green prefix whose recorded commit is still the task branch tip.
    const satisfiedGate = satisfiedGates.get(t.id);
    const replayedGates = replayedGateResults.get(t.id);
    resumeGateReplay: if (satisfiedGate || replayedGates) {
      const taskBase = await integrationHead(intWt);
      const taskBranch = `${branch}--${t.id}`;
      const priorWt = worktreePath(repoRoot, taskBranch);
      if (!existsSync(priorWt)) {
        if (satisfiedGate) throw new Error(`approved gate ${satisfiedGate} cannot resume: task worktree is missing`);
        // Observed passes are an optimization, never authority: without the task worktree there is no
        // commit to compare and no landed work to gate, so fall through to the ordinary worker path.
        replayedGateResults.delete(t.id);
        break resumeGateReplay;
      }
      const resumeReason = satisfiedGate
        ? `approved gate ${satisfiedGate}`
        : `recorded gates on ${replayedGates!.commit.slice(0, 10)}`;
      const priorTaskTip = await gitHead(priorWt);
      const priorTaskSubject = await gateCommitSubject(taskBase, priorTaskTip, priorWt);
      const commitsToCarry = await commitsAheadOf(taskBase, priorWt);
      const wt = await driver.worktree(repoRoot, taskBranch, taskBase);
      const carriedCommits = await cherryPickCommits(wt, commitsToCarry);
      // Reuse is about the tree the gates will actually inspect. The integration tip may have moved
      // while the daemon was down, so compare after recreating the task on today's taskBase rather
      // than against the stale worktree whose task-only history cannot see newly merged dependencies.
      const currentTaskTip = await gitHead(wt);
      const currentTaskSubject = await gateCommitSubject(taskBase, currentTaskTip, wt);
      journal.append("worktree-recreation", t.id, { attempted: commitsToCarry, carried: carriedCommits });
      // OBS-212: same fail-closed rule as the dispatch path — but this path is worse, because it runs
      // ONLY the gates after the approved one and then MERGES. T3 took it on run-20260728-110135:
      // approved past review at 11:22, recreated at 12:50, and phase-start{gates} / phase-start{merge}
      // landed in the same second with zero gate-result events. Work missing here is merged unverified.
      {
        const present = new Set(carriedCommits);
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
      if (!workerEvent) throw new Error(`${resumeReason} cannot resume: worker result is missing`);
      const priorResult: WorkerResult = {
        ok: workerEvent.data.ok === true,
        summary: typeof workerEvent.data.summary === "string" ? workerEvent.data.summary : "",
        deviations: Array.isArray(workerEvent.data.deviations)
          ? workerEvent.data.deviations.filter((d): d is string => typeof d === "string")
          : [],
        raw: "",
      };
      const gateAuthor = rs?.lastAssignment ?? assignment;
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
      let remainingGates: GateName[];
      if (satisfiedGate) {
        remainingGates = t.gates.filter((gate) => {
          if (gate === satisfiedGate) return false;
          const prior = priorResults.get(gate)?.data;
          const followsApproved = GATE_NAMES.indexOf(gate) > satisfiedIndex;
          const otherRed = prior?.pass === false;
          const needsFullSuite = gate === "test" && prior?.fullSuite !== true;
          return followsApproved || otherRed || needsFullSuite;
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
        let reusable = exactCurrentCommit || canonicalCurrentCommit || recreatedLegacyCommit;
        const reused: GateName[] = [];
        const declaredGates = GATE_NAMES.filter((gate) => t.gates.includes(gate));
        for (const gate of declaredGates) {
          if (!reusable || replayedGates!.results.get(gate) !== true) reusable = false;
          else reused.push(gate);
        }
        for (const gate of reused) {
          journal.append("gate-reused", t.id, { gate, commit: replayedGates!.commit });
        }
        remainingGates = declaredGates.slice(reused.length);
      }
      const resumedTask = { ...t, gates: remainingGates };

      gateLoop: while (true) {
        const gated = await gitHead(wt);
        gateSubject = {
          commit: await gateCommitSubject(taskBase, gated, wt),
          attempt: rs?.attempts ?? 0,
          // This suffix is re-measured to decide whether resume may advance, but the interrupted
          // attempt already paid for its red result. The next worker-backed round remains the next
          // deterministic-fingerprint occurrence/review round for budget accounting.
          ...(!satisfiedGate ? { replayMeasurement: true as const } : {}),
        };
        journal.phaseStart(t.id, "gates");
        const { results } = await runGates(resumedTask, {
          worktree: wt, baseRef: taskBase, result: priorResult, author: gateAuthor,
          commands, baseline, channels: pools.review, judgeChannels: pools.judge, adapters, cfg, artifactDir: journal.dir,
          // a recheck re-verifies a human's release: it never selects tests down, it runs the suite.
          pipeline: "v185",
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
          onGate: async (e) => {
            if (e.phase === "start") {
              notePhaseStart(e);
              journal.phaseStart(t.id, phaseForGate(e.gate), { gate: e.gate, index: e.index, total: e.total, ...(e.parentAt === undefined ? {} : { parallel: true }) });
              return;
            }
            const g = e.result;
            inParallelOrder(g.gate as GateName, () => {
              journalGateResult(g);
              noteReviewRetry(g);
              if (g.gate === "review" && !g.pass && /unparseable/.test(g.details)
                  && typeof g.meta?.reviewer === "string") {
                badReviewers.push(g.meta.reviewer);
              }
            });
          },
        });
        const approvedCommits = await commitsAheadOf(taskBase, wt);
        graph = addEvidence(graph, t.id, { commits: approvedCommits, gateResults: results });
        saveGraph(repoRoot, graph);
        if (!results.every(gateSatisfied)) {
          gateFails++;
          // Observed green gates are only measurements. If the resumed suffix is red, preserve that
          // result in the journal and return to the ordinary attempt/consult ladder, which rebuilds
          // feedback from those rows. Only an operator-authorized gate release parks on a new red.
          if (!satisfiedGate) break gateLoop;
          await park(t, "post-approval gate failed", "gate-fail", gateAuthor, rs?.attempts ?? 0,
            startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }

        const m = await mergeSerial(taskBranch, t, gated);
        if (m.tipMoved) {
          journal.append("tip-moved", t.id, m.tipMoved);
          if (tipMoves++ === 0) continue gateLoop;
          await park(t, "task branch tip moved twice after gating", "tip-moved", gateAuthor,
            rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }
        if (!m.ok) {
          journal.append("merge-conflict", t.id, { conflict: m.conflict });
          await park(t, `merge conflict after ${resumeReason}: ${m.conflict ?? "unknown conflict"}`,
            "merge-conflict", gateAuthor, rs?.attempts ?? 0, startMs, gateFails, consults, tokens, metered, retryMode);
          return;
        }

        graph = setStatus(graph, t.id, "done");
        saveGraph(repoRoot, graph);
        journal.append("task-done", t.id, { attempts: rs?.attempts ?? 0, assignment: gateAuthor });
        journal.append("merge", t.id, { branch: taskBranch, commit: await integrationHead(intWt) });
        journal.telemetry({
          taskId: t.id, shape: t.shape, adapter: gateAuthor.adapter, model: gateAuthor.model,
          channel: gateAuthor.channel, attempts: rs?.attempts ?? 0, outcome: "done",
          durationMs: Date.now() - startMs, firstAttemptOk: false, gateFails, consults, retryMode,
        });
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
    attempts: for (let attempt = rs?.attempts ?? 0; ; attempt++) {
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
      // OBS-419: read the approval-carried ceiling at the funding boundary, after every escalation
      // decision but before the sole task-dispatch below. Both interactive and headless worker-launch
      // branches are dominated by this check, so no route can fund another worker without consulting it.
      // reviewRoundsSinceApproval resets the DRAWN count at approval; the ceiling on that same approval
      // survives the reset and governs only those further rounds. Absence preserves the module default.
      const reviewRoundCap = approvedReviewRoundCeiling(journal.read(), t.id) ?? REVIEW_ROUND_CAP;
      if (attempt > 0 && reviewRoundsDrawn() >= reviewRoundCap) {
        await park(t, `review round cap (${reviewRoundCap}) reached this engagement — \`tickmarkr approve\` accepts the diff past review; \`tickmarkr approve --uphold\` funds one fixed attempt carrying the findings`, "gate-fail", assignment, attempt, startMs, gateFails, consults, tokens, metered, retryMode);
        return;
      }
      // OBS-57: a demoted channel must not be re-dispatched on consult retry or provider requeue.
      if (demotedChannels.has(channelKey(assignment))) {
        const next = nextChannel(assignment, t, cfg, channels, tried, profile, demotedChannels);
        if (next) {
          assignment = next;
          const k = channelKey(next);
          if (!tried.includes(k)) tried.push(k);
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
          await park(t, `identical ${banned} failure twice this engagement — an identical retry is banned and no untried channel is left`,
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
      retryMode = repairFindings
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
      journal.append("task-dispatch", t.id, { assignment, attempt, provenance: dispatchProvenance(r.provenance), retryMode });
      journal.phaseStart(t.id, "worker", { attempt, assignment });

      const taskBase = await integrationHead(intWt); // deps are merged → visible to this task
      const taskBranch = `${branch}--${t.id}`; // "--": a ref can't nest under the existing integration branch (locked decision 10)
      const priorWt = worktreePath(repoRoot, taskBranch);
      const commitsToCarry = existsSync(priorWt) ? await commitsAheadOf(taskBase, priorWt) : [];
      const wt = await driver.worktree(repoRoot, taskBranch, taskBase);
      // OBS-58: quota-failover and every retry recreate the task worktree from the integration tip —
      // cherry-pick prior attempts' landed commits forward so a failover dispatch cannot silently
      // orphan work a consult already verified as landed.
      let carriedCommits: string[] = [];
      if (commitsToCarry.length > 0) {
        carriedCommits = await cherryPickCommits(wt, commitsToCarry);
        journal.append("worktree-recreation", t.id, { attempted: commitsToCarry, carried: carriedCommits });
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
      const presentCommits = new Set(carriedCommits);
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
        const diff = raw.stdout.length > cap
          ? `${raw.stdout.slice(0, cap)}\n… diff truncated at gates.diffCap (${cap} bytes)`
          : raw.stdout;
        const brief = repairBrief(repairFindings, diff, taskBase);
        // anything the live brief holds beyond the journaled findings (a consult's guidance) is kept:
        // a repair adds the diff and the fix-only contract, it never subtracts what was already known.
        feedback = feedback && !brief.includes(feedback) ? `${brief}\n\n${feedback}` : brief;
        journal.append("repair-dispatch", t.id, { diffBytes: diff.length, capped: raw.stdout.length > cap });
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
      const promptFile = writePrompt(journal.dir, t, attempt, feedback, nonce);
      // OBS-56: state the non-interactive, one-pass finish contract and the OBS-54 stall budget in every
      // worker prompt, not only consult retry guidance. Prepended so prompt.ts's completion trailer stays last.
      const workerContract = `## Harness contract\n- This harness is non-interactive: make one continuous pass; do not stop for questions or follow-up input.\n- You have a ${taskTimeoutMinutes} minute stall window. Budget the full suite once, then commit and emit the completion trailer before it expires.\n- Each test: acceptance criterion must exist as a vitest test whose title matches the criterion string verbatim.`; // OBS-64
      // OBS-47: state the worktree layout contract in the worker prompt (cheap-tier workers were
      // committing/deleting node_modules and tripping the scope gate). The harness re-asserts the link
      // itself before gates regardless of what the worker does with it.
      writeFileSync(promptFile, `${WORKTREE_LAYOUT_CONTRACT}\n\n${workerContract}\n\n${readFileSync(promptFile, "utf8")}`);
      const adapter = getAdapter(assignment.adapter, adapters);

      // VIS-04: workers share one role tab. T2: `owned` names the pane canonically (ownership contract);
      // the legacy name stays the fallback for drivers without owned handling (subprocess spies).
      const slot = await trackedDriver.slot(wt, `${t.id}-worker-${assignment.adapter}-a${attempt}-${runTag}`, { group: "workers", owned: { role: "worker", taskId: t.id, attempt, runId } });
      const sessionId = retryMode === "resume" ? priorSession!.id : slot.name;
      const icmd = retryMode === "resume"
        ? adapter.resumeCommand!(sessionId, promptFile, assignment.model)
        : cfg.visibility.worker === "interactive" && driver.interactive
          ? adapter.interactiveCommand(promptFile, assignment.model)
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
      writeFileSync(dispatchScript, [
        "export BASH_SILENCE_DEPRECATION_WARNING=1",
        bannerShell(),
        workerCmd,
        exitMarkerCmd,
      ].join("\n"));
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
      const noteLaunched = () => journal.append("worker-launch", t.id, { attempt, retryMode });
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
      const harvestConcludes = async (silentMs: number): Promise<boolean> => {
        if (silentMs < harvestSilentMs) {
          await cpuAccountant?.stop();
          cpuAccountant = undefined;
          cpuFlat = undefined;
          cpuGapCount = 0;
          return false;
        }
        // The CPU leg needs a marker in the worker's own argv, and every launch path puts this
        // attempt's dispatch script there EXCEPT interactiveSeed: runInteractiveSeed launches the
        // TUI directly, by a command the ADAPTER owns (seed.launch(model)) which tickmarkr cannot
        // make attempt-unique and must deliver verbatim. A marker that matches nothing reads as
        // zero CPU — precisely the false "flat" that would harvest a worker mid-turn — so a seeded
        // attempt has no measurable CPU leg and the triad never concludes it. The other half of
        // OBS-264 is untouched there: when its window does expire with commits on the worktree, the
        // no-trailer tail gates them instead of buying a fresh worker to re-produce them.
        if (hasSeed) {
          noteUnmeasurable("interactive-seed launch is not in the probed process tree");
          return false;
        }
        if (cpuAccountant === undefined) {
          cpuAccountant = new WorkerTreeCpuAccountant(dispatchScript, wt);
          await cpuAccountant.start();
        }
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
          return false;
        }
        const now = Date.now();
        if (cpu.ms !== cpuFlat?.ms) {
          cpuFlat = { ms: cpu.ms, since: now };
          return false;
        }
        if (now - cpuFlat.since < harvestCpuFlatWindowMs(cpu.resolutionMs)) return false;
        const carried = await commitsAheadOf(taskBase, wt);
        if (carried.length === 0) return false; // nothing landed: not this branch's population
        journal.append("worker-harvest", t.id, {
          slot: slot.name, attempt, commits: carried.length,
          silentMs, cpuMs: cpu.ms, cpuResolutionMs: cpu.resolutionMs,
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
      // T2 review: print mode's "the exit marker appeared". Kept apart from `finished` (the
      // trailer) but still needed by the keepPanes decision below, whose contract is about a
      // subprocess tree that REACHED its exit marker, not about what the worker claimed.
      let processExited = false;
      let earlyLaunchDead = false;
      let settleParsed: WorkerResult | undefined;
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
      let trustAnswered = false;
      const noteSeedTrustAnswered = () => {
        if (trustAnswered) return;
        trustAnswered = true;
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
        feedback = `delivery readiness failed after ${error.waitedMs}ms; pane transcript:\n${error.transcript}`;
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
              driver, slot, adapter, assignment, promptFile, taskTimeoutMinutes,
              onTrustAnswered: noteSeedTrustAnswered,
            });
          } catch (error) {
            if (!(error instanceof DeliveryReadinessError)) throw error;
            if (await handleDeliveryReadiness(error)) continue attempts;
            return;
          }
          noteLaunched();
          output = seedResult.output;
        } else {
          try {
            await driver.run(slot, paneDispatchCommand(dispatchScript));
          } catch (error) {
            if (!(error instanceof DeliveryReadinessError)) throw error;
            if (await handleDeliveryReadiness(error)) continue attempts;
            return;
          }
          noteLaunched();
          output = await driver.read(slot, PANE_READ_ROWS);
        }
        // The returning paths report the same fact on the result; both callbacks land on the one
        // latch, and the second is a no-op. A seed that answered is never re-answered by the loop.
        if (seedResult?.trustAnswered) noteSeedTrustAnswered();
        if (seedResult?.seedFailed) {
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
          while (Date.now() - lastProgressAt < stallWindowMs) {
            const sliceStart = Date.now();
            const remaining = stallWindowMs - (sliceStart - lastProgressAt);
            let slice = Math.min(BLOCKED_POLL_MS, Math.max(100, Math.min(stallWindowMs / 2, remaining)));
            if (!everHadOutput) {
              const earlyLeft = earlyLaunchLivenessMs - (sliceStart - attemptStart);
              if (earlyLeft > 0) slice = Math.min(slice, earlyLeft);
            }
            // T2 (OBS-264): never sleep PAST the instant the harvest probe becomes eligible, and past
            // it let the probe own the cadence (HARVEST_POLL_MS) — a 30s trailer slice would
            // otherwise cost a minute per pair of CPU samples. At the shipped 5m gate this leaves
            // every slice before the gate exactly as long as it already was.
            slice = Math.min(slice, harvestSliceMs(sliceStart - lastProgressAt));
            if (await driver.waitOutput(slot, `(${trailerPattern(nonce)})|TICKMARKR_EXIT_${nonce}:\\d`, slice, { regex: true })) {
              // verify before accepting: a worker that merely DISPLAYS a marker (e.g. editing tickmarkr's
              // own source, where "TICKMARKR_EXIT:" is a string literal) must not end the wait. Only a
              // parseable trailer or a digit-suffixed exit marker in the harvest is completion.
              output = await driver.read(slot, PANE_READ_ROWS); // TUI transcripts carry chrome — read deeper than print's 500
              finished = new RegExp(trailerPattern(nonce)).test(output);
              const exit = exitRe.exec(output);
              if (finished || exit) {
                exitCode = exit ? Number(exit[1]) : null; // null ⇔ the TUI is still alive
                await sampleContext(); // final poll-seam sample before leaving the wait
                break;
              }
            }
            const paneText = await driver.read(slot, PANE_READ_ROWS);
            if (paneText.length > 0) everHadOutput = true;
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
            if (QUOTA_RE.test(stallSnapshotBannerRows(paneText))) quotaStreak++;
            else quotaStreak = 0;
            if (quotaStreak >= 2 && sliceNow - lastProgressAt >= quotaBannerSilentMs) {
              // no `output =` here: the post-loop no-trailer tail re-reads the pane anyway, so an
              // assignment would only split the classification read from the verdict read.
              journal.append("quota-banner", t.id, { slot: slot.name, attempt, silentMs: sliceNow - lastProgressAt });
              break;
            }
            // T1 (OBS-262): the `paged` latch is deleted — status is sampled EVERY slice (and
            // journaled on change — see lastStatus above), so post-hoc analysis can see which
            // gate held. page on "idle" too: herdr's blocked-scrape is strict and proved flaky
            // for TUI dialogs (live check: cursor's trust dialog scraped as idle).
            // "unknown"/"working" never page.
            const st = await driver.status(slot);
            if (st !== lastStatus) {
              lastStatus = st;
              journal.append("worker-status", t.id, { slot: slot.name, status: st, attempt });
            }
            if (st === "blocked" || st === "idle") {
              // T5: once-per-slot auto-answer when the adapter declares a trust dialog and the pane
              // text matches. tickmarkr created the worktree from the operator's own repo — safe by construction.
              if (!trustAnswered && adapter.trustDialog && driver.sendKey) {
                try {
                  const paneText = await driver.read(slot, 80);
                  if (matchesTrustDialog(paneText, adapter.trustDialog)) {
                    trustAnswered = true;
                    // v1.25 T1: audit trail for live runs — prove the dialog appeared and was answered.
                    // Latch + sendKey + no-page continue stay byte-identical; this append is additive only.
                    journal.append("trust-auto-answer", t.id, { slot: slot.name, adapter: adapter.id });
                    await driver.sendKey(slot, adapter.trustDialog.key);
                    const spent = Date.now() - sliceStart;
                    if (spent < slice) await new Promise((r) => setTimeout(r, Math.min(slice - spent, 1_000)));
                    continue; // do not page — keep waiting for the trailer
                  }
                } catch {
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
            // that only needed a submit answers with a full trailer instead of partial work. An
            // ANSWERED or twice-undeliverable nudge leaves nothing pending, so the triad governs
            // again; the hold is on a pending daemon ACTION, never on the adapter being nudgeable.
            if ((!nudgePending || nudgeFailed) && await harvestConcludes(sliceNow - lastProgressAt)) break;
            // T1 (R1 dead-channel fast-kill): no trailer, an unchanged launch tree, and no output growth
            // for the fast-kill window — the channel is dead, so conclude NOW
            // (journaled) and let the existing no-trailer tail classify and route the attempt.
            // The tracker is the growth signal on purpose: raw pane bytes grow on cosmetic repaint
            // (an elapsed "9s"→"10s" lengthens the read and would hide a frozen pane). But the
            // tracker SHARES the read window's ceiling: its row signal saturates once a sample
            // FILLS a PANE_READ_ROWS read on raw lines (blanks/chrome included — see stall.ts),
            // and past that point a flat tracker means "unmeasurable", not "dead". For unmetered
            // adapters (codex, cursor-agent, grok, opencode — no contextUsage, so the token signal
            // never fires) rows are the ONLY
            // signal, and those are exactly the non-nudgeable adapters this kill governs — a live
            // worker past the ceiling would be concluded dead mid-work. So the kill STANDS DOWN on
            // a saturated row signal (journaled once per attempt); the rolling window still owns
            // that pane, exactly as pre-T1. Token growth counts as life either way, so a metered
            // worker thinking through a long tool run survives.
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
              journal.append("worker-dead-held", t.id, { slot: slot.name, attempt, reason: "row-signal-saturated" });
            }
            // T1 review fix: the kill's "no output growth" leg clocks off the RAW growth signals,
            // never lastProgressAt alone — the flat-token rule (stall.ts) deliberately suppresses
            // the re-arm report on row growth once tokens stick, and contextTokens is sticky across
            // read misses, so a metered non-nudgeable adapter (pi) streaming rows under a stale
            // counter presented a frozen lastProgressAt and was killed mid-work. lastRowGrowthAt is
            // recorded on every high-water advance, suppressed or not; token growth already rides
            // lastProgressAt. Either one advancing is output growth.
            const lastOutputGrowthAt = Math.max(stallProgress.lastRowGrowthAt ?? 0, lastProgressAt);
            if (!stallProgress.rowSignalSaturated
              && (!nudgePending || nudgeFailed)
              && sliceNow - lastOutputGrowthAt >= deadChannelFastKillMs
              && worktreeSinceLaunch === "unchanged") {
              journal.append("worker-dead", t.id, { slot: slot.name, attempt, silentMs: sliceNow - lastOutputGrowthAt });
              break;
            }
            if (nudgeable && !nudged && sliceNow - lastProgressAt >= nudgeAfterSilentMs) {
              nudged = true;
              // T1 review: a false return is a driver-delivery outcome (missing pin, readiness
              // stable-frame timeout, read-back hiccup), not proof of an unreachable channel — so
              // one failure is a flake class, retried once in-slice after a short settle. Only a
              // failed RETRY condemns the channel. Both failures happen inside this slice, so the
              // latch stays immediate and exactly one failure is journaled per attempt.
              let delivered = await driver.nudge!(slot, WORKER_NUDGE_MESSAGE);
              if (!delivered) {
                await new Promise((r) => setTimeout(r, NUDGE_REDELIVER_MS));
                delivered = await driver.nudge!(slot, WORKER_NUDGE_MESSAGE);
              }
              if (delivered) {
                // absorb the nudge's own echo BEFORE arming the grace timer — post-nudge progress
                // is measured against this baseline, not against the echo.
                const echo = await driver.read(slot, PANE_READ_ROWS);
                stallProgress.observe({ paneText: echo, contextTokens });
                nudgeDeadline = Date.now() + workerNudgeGraceMs;
                journal.append("worker-nudge", t.id, { slot: slot.name, attempt });
              } else {
                // Delivery failure is journal evidence about the daemon's contact attempt only.
                // The fast-kill's worktree clause remains wholly filesystem/git-derived above.
                nudgeFailed = true;
                journal.append("worker-nudge-failed", t.id, { slot: slot.name, attempt });
              }
            }
            if (nudged && nudgeDeadline !== undefined && sliceNow >= nudgeDeadline && sliceNow - lastProgressAt >= workerNudgeGraceMs) {
              // grace spent, still no post-nudge progress: re-harvest once (the trailer may have
              // landed between polls), then conclude the wait as a stall NOW — the consult sees the
              // un-answered nudge instead of the remainder of the window.
              nudgeDeadline = undefined;
              output = await driver.read(slot, PANE_READ_ROWS);
              finished = new RegExp(trailerPattern(nonce)).test(output);
              const exit = exitRe.exec(output);
              if (finished || exit) {
                exitCode = exit ? Number(exit[1]) : null;
                await sampleContext();
                break;
              }
              journal.append("worker-nudge-expired", t.id, { slot: slot.name, attempt, graceMs: workerNudgeGraceMs });
              lastProgressAt = Date.now() - stallWindowMs; // the existing harvest/classify tail runs unmodified
              continue; // conclude via the loop condition — never page over an acted-on nudge
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
            if (pageable) {
              journal.append("operator-page", t.id, { slot: slot.name, attempt, status: st });
              if (st !== lastPagedStatus || sliceNow - lastPagedAt >= pageRepeatMs) {
                lastPagedStatus = st;
                lastPagedAt = sliceNow;
                const why = st === "blocked" ? "is blocked on a prompt — approve in its pane" : "looks idle without finishing — check its pane";
                await driver.notify(`tickmarkr ${runId}: ${slot.name} ${why}`, { tier: "attention" });
              }
            }
            // a dead pane or a false-positive marker display returns fast — sleep the unspent slice, never hot-spin
            const spent = Date.now() - sliceStart;
            if (spent < slice) await new Promise((r) => setTimeout(r, Math.min(slice - spent, 1_000)));
          }
          if (!finished && exitCode === null) {
            // timed out (or only ever saw false positives): harvest whatever the pane holds now
            timedOut = Date.now() - lastProgressAt >= stallWindowMs;
            output = await driver.read(slot, PANE_READ_ROWS);
            finished = new RegExp(trailerPattern(nonce)).test(output);
            const exit = exitRe.exec(output);
            exitCode = exit ? Number(exit[1]) : null;
          }
          if (finished) {
            await driver.waitAgentStatus(slot, "idle", 5_000); // settle, then re-harvest the final render
            output = await driver.read(slot, PANE_READ_ROWS);
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
            while (settleParsed.summary === UNPARSEABLE_TRAILER_SUMMARY && settleTries < maxSettleRetries) {
              const remaining = settleDeadline - Date.now();
              if (remaining <= 0) break;
              await new Promise((r) => setTimeout(r, Math.min(settleDelayMs, remaining)));
              output = await driver.read(slot, PANE_READ_ROWS);
              settleParsed = adapter.parse(output, nonce);
              settleTries++;
            }
            if (settleParsed.summary !== UNPARSEABLE_TRAILER_SUMMARY) {
              finished = settleParsed.summary !== NO_TRAILER_SUMMARY;
            }
          }
        }
      } else {
        try {
          await driver.run(slot, paneDispatchCommand(dispatchScript));
        } catch (error) {
          if (!(error instanceof DeliveryReadinessError)) throw error;
          if (await handleDeliveryReadiness(error)) continue attempts;
          return;
        }
        noteLaunched();
        // OBS-54: headless workers have the same output-inactivity budget as visible panes.
        // v1.76: same monotonic-progress measure as the interactive site; harvest stays raw.
        const stallWindowMs = taskTimeoutMinutes * 60_000;
        const initialPane = await driver.read(slot, 500);
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
        while (Date.now() - lastProgressAt < stallWindowMs) {
          const remaining = stallWindowMs - (Date.now() - lastProgressAt);
          let slice = Math.min(BLOCKED_POLL_MS, Math.max(100, Math.min(stallWindowMs / 2, remaining)));
          if (!everHadOutput) {
            const earlyLeft = earlyLaunchLivenessMs - (Date.now() - attemptStart);
            if (earlyLeft > 0) slice = Math.min(slice, earlyLeft);
          }
          // T2 (OBS-264): same probe cadence the interactive loop uses — see harvestSliceMs.
          slice = Math.min(slice, harvestSliceMs(Date.now() - lastProgressAt));
          if (await driver.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, slice, { regex: true })) {
            processExited = true;
            break;
          }
          const paneText = await driver.read(slot, 500);
          if (paneText.length > 0) everHadOutput = true;
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
          if (await harvestConcludes(Date.now() - lastProgressAt)) break;
        }
        output = await driver.read(slot, 500);
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
      // SPEND-01 interactive metering race: the harvest loop breaks on the trailer, but the worker
      // shell may still be running post-trailer bookkeeping (session-store flush, fake usage stamp,
      // exit wrapper). Print mode already waits for TICKMARKR_EXIT, which follows that tail; drain
      // interactive attempts to the same exit marker before close and the post-hoc usage disk read
      // so a writer never races the reader (real CLIs can flush usage asynchronously after the trailer).
      if (interactive && finished && !exitRe.test(output)) {
        await driver.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, 2_000, { regex: true });
      }
      // keepPanes retains visible context, not a timed-out subprocess tree. Close before consult/retry
      // can recreate the worktree; Herdr and subprocesses that reached their exit marker stay unchanged.
      if (keepOpen && (finished || processExited || driver.id !== "subprocess")) keptSlots.push(slot);
      else await closeSlot(slot);
      // SPEND-01: usage from the harness's own cwd-keyed structured store, read POST-HOC from disk —
      // `wt` is this task's private worktree, so the path is unique; the read is sliced to records
      // stamped at/after this attempt's dispatch instant. Never the harvested pane text, never the
      // parsed worker trailer. No interactive branch: a TUI writes the same store. undefined ⇒ unmetered.
      // SPEND-02: fold this attempt's slice into the task accumulator only when it's a real observation —
      // an absent record leaves `tokens`/`metered` untouched (never a materialized zero).
      const attemptUsage = adapter.collectUsage?.(wt, attemptStart);
      if (attemptUsage) { tokens = addUsage(tokens, attemptUsage); metered++; }
      let result = settleParsed ?? adapter.parse(output, nonce);
      const workerFinished = finished;
      const workerCause = classifyWorkerResultCause({ output, ok: result.ok, finished, exitCode, summary: result.summary, timedOut });
      journal.append("worker-result", t.id, {
        ok: result.ok, summary: result.summary, deviations: result.deviations, finished: workerFinished, exitCode,
        mode: interactive ? "interactive" : "print", ...(workerCause ? { cause: workerCause } : {}),
      });
      // T2 review (routing precedence): provider-death, quota and dead-channel classification
      // derive from ONE rule — the worker's OWN outcome, workerFinished and this PRE-HARVEST
      // parse — never from the synthesized result below. A worker that committed and then walled
      // (provider outage, quota banner, dead CLI) must still route; the harvest synthesis only
      // decides whether THIS attempt's worktree goes to gates, and when routing wins instead, the
      // commits survive via the existing commitsToCarry/cherryPickCommits carry-forward.
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
      if (preHarvestResult.ok && workerFinished) noTrailerStreak.set(channelKey(assignment), 0);
      else if (!workerFinished && cause !== "provider-death") {
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
      const quotaHit = interactive
        ? !workerFinished && QUOTA_RE.test(stallSnapshotBannerRows(output))
        : exitCode !== 0 && QUOTA_RE.test(output);
      if (quotaHit) {
        const next = failover("quota-failover");
        journal.append("quota-failover", t.id, { from: channelKey(assignment), to: next ? channelKey(next) : null });
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
        await park(t, "quota exhausted on every eligible channel", "quota", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
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
      const dead = classifyDeadChannel(preHarvestResult) ?? (earlyLaunchDead ? "setup-required" : undefined);
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
          }
          assignment = next;
          tried.push(channelKey(next));
          continue;
        }
        await park(t, `dead channel (${dead}) and no eligible channel remains`, "reroute-exhausted", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
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
        if (e.phase === "start") {
          notePhaseStart(e);
          journal.phaseStart(t.id, phaseForGate(e.gate), { gate: e.gate, index: e.index, total: e.total, ...(e.parentAt === undefined ? {} : { parallel: true }) });
          return;
        }
        const g = e.result;
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
          if (g.gate === "review" && !g.pass && /unparseable/.test(g.details) && typeof g.meta?.reviewer === "string") {
            badReviewers.push(g.meta.reviewer);
          }
        });
      };
      let results: GateResult[] = [];
      let commits: string[] = [];
      gateLoop: while (true) {
        const gated = await gitHead(wt);
        gateSubject = { commit: await gateCommitSubject(taskBase, gated, wt), attempt };
        journal.phaseStart(t.id, "gates");
        ({ results, commits } = await runGates(t, {
          worktree: wt, baseRef: taskBase, result, author: assignment,
          commands, baseline, channels: pools.review, judgeChannels: pools.judge, adapters, cfg, artifactDir: journal.dir,
          pipeline: "v185", selectTests: !testGateFailed,
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
          onGate,
        }));
        graph = addEvidence(graph, t.id, { commits, gateResults: results, artifacts: [promptFile] });
        saveGraph(repoRoot, graph);
        if (results.some((g) => g.gate === "test" && !g.pass)) testGateFailed = true;

        if (results.every(gateSatisfied)) {
          const m = await mergeSerial(taskBranch, t, gated);
          if (m.tipMoved) {
            journal.append("tip-moved", t.id, m.tipMoved);
            if (tipMoves++ === 0) continue gateLoop;
            await park(t, "task branch tip moved twice after gating", "tip-moved", assignment, attempt + 1, startMs, gateFails, consults, tokens, metered, retryMode);
            return;
          }
          if (!m.ok) {
            journal.append("merge-conflict", t.id, { conflict: m.conflict });
            const v = await runConsult("merge-conflict", output, m.conflict ?? "", results);
            if (await applyVerdict(v, attempt + 1, "merge-conflict")) continue attempts;
            return;
          }
          graph = setStatus(graph, t.id, "done");
          saveGraph(repoRoot, graph);
          journal.append("task-done", t.id, { attempts: attempt + 1, assignment });
          journal.append("merge", t.id, { branch: taskBranch, commit: await integrationHead(intWt) });
          // firstAttemptOk/gateFails/consults are recorded FACTS, not policy — a parkKind:"stall" row is
          // recorded but NOT quality-negative in v1.6; Phase 12 owns reward policy, so flipping it later needs zero data migration.
          journal.telemetry({ taskId: t.id, shape: t.shape, adapter: assignment.adapter, model: assignment.model, channel: assignment.channel, attempts: attempt + 1, outcome: "done", durationMs: Date.now() - startMs, firstAttemptOk: attempt === 0, gateFails, consults, tokens, meteredAttempts: tokens ? metered : undefined, retryMode });
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
      feedback = results.filter(gateFailed).map((g) => `${g.gate}: ${g.details}`).join("\n\n");
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
      const repairsDrawn = repairsSinceApproval(journal.read(), t.id);
      const repair = repairable && repairsDrawn < MAX_REPAIRS;

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
        await driver.notify(`tickmarkr ${runId}: ${t.id} ${repeated.gate} failed identically twice — consulting, identical retry banned`, { tier: "attention" });
        // The cap takes the ladder's MOVE, never its accounting: this failure still spends the rung it
        // would have spent, so a task that cannot converge still reaches ladder exhaustion on exactly
        // the budget it always had and the cap can never hand a stuck task extra rounds.
        capStep = r.ladder[Math.min(ladderIdx++, r.ladder.length - 1)];
        journal.append("escalation", t.id, { step: capStep, attempt: attempt + 1, fingerprintCap: true });
        await driver.notify(`tickmarkr ${runId}: ${t.id} escalation: ${capStep}`, { tier: "attention" });
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
        journal.append("consult-verdict", t.id, { action: v.action, notes: v.notes, capAdvisory: true });
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
          repair: repairsDrawn + 1, of: MAX_REPAIRS, gates: failing.map((g) => g.gate),
          commits: landed.length,
          findings: feedback, // the failure bytes this repair must carry, replayable across a resume
        });
      } else if (repairExhausted && !capStep) {
        journal.append("repair-exhausted", t.id, { repairs: repairsDrawn, of: MAX_REPAIRS, gates: failing.map((g) => g.gate) });
      }

      const step = capStep ?? (repair || (reviewFixRetry && !repairExhausted)
        ? "retry"
        : r.ladder[Math.min(ladderIdx++, r.ladder.length - 1)]);
      if (!capStep) { // a capped failure already journaled and announced the rung it spent
        journal.append("escalation", t.id, {
          step, attempt: attempt + 1,
          ...(reviewFixRetry && !repairExhausted ? { reviewFix: true } : {}),
          ...(repair ? { repair: repairsDrawn + 1 } : {}),
        });
        await driver.notify(`tickmarkr ${runId}: ${t.id} escalation: ${step}`, { tier: "attention" });
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

  taskLoopStarted = true;
  const inflight = new Map<string, Promise<void>>();
  while (true) {
    // v1.54 T2: a signal that landed while nothing was racing `aborted` (empty inflight window)
    // must still stop the run before it can dispatch more work or write run-end.
    if (termSignal) throw new Error(`terminated by ${termSignal}`);
    const ready = readyTasks(graph)
      .filter((t) => !inflight.has(t.id))
      .slice(0, Math.max(0, concurrency - inflight.size));
    for (const t of ready) {
      const p = execTask(t)
        .catch(async (err) => {
          const taskEvents = journal.read().filter((e) => e.taskId === t.id);
          const dispatch = [...taskEvents].reverse().find((e) => e.event === "task-dispatch");
          // OBS-206: shared rule with `resume --retry-failed` — see classifyTaskFailure.
          const kind: ParkKind = classifyTaskFailure(taskEvents);
          const attempts = dispatch && Number.isInteger(dispatch.data.attempt) ? dispatch.data.attempt as number : 0;
          graph = setStatus(graph, t.id, "failed");
          saveGraph(repoRoot, graph);
          journal.append("task-failed", t.id, { error: String(err), kind, attempts });
          journal.telemetry({ taskId: t.id, shape: t.shape, adapter: "-", model: "-", channel: "-", attempts: 0, outcome: "failed", durationMs: 0 });
          await reconcile({ spareLiveLlm: true }); // task-failed is a terminal event
        })
        .finally(() => inflight.delete(t.id));
      inflight.set(t.id, p);
    }
    if (inflight.size === 0) break;
    await Promise.race([...inflight.values(), aborted]); // aborted rejects on termination — unwinds the run
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

  // OBS-34: post-merge integration-tip verify — strict exit codes, no baseline forgiveness.
  const lastMergedTask = [...journal.read()].reverse().find((e) => e.event === "merge" && e.taskId)?.taskId;
  if (summary.done.length > 0 && Object.keys(commands).length > 0) {
    const tipFailed = await verifyIntegrationTipCached(intWt, commands, journal, { lastMergedTask });
    summary.tipVerify = tipFailed ? "failed" : "passed";
    if (tipFailed && lastMergedTask) summary.lastMergedTask = lastMergedTask;
  }

  // T14: read the journal, not the startup `approved` set — an approval appended DURING this run is
  // exactly the one the set cannot see, and it is the one the record has to name.
  //
  // Serialize this sample WITH the run-end append. The daemon holds the boundary through its final
  // graph.lock release in the outer finally: an approval that wins first is included below, while an
  // approval that loses cannot append until the live owner is gone and reports recorded-no-owner.
  // Thus no accepted approval can land after this sample while still being attributed to this run.
  const approvalSerialization = await acquireApprovalSerialization(repoRoot, runId);
  releaseApprovalSerialization = approvalSerialization.release;
  const outstanding = outstandingApprovals(journal.read());
  summary.approvalDisposition = outstanding.length === 0 ? "complete" : "outstanding";
  if (outstanding.length > 0) summary.outstandingApprovals = outstanding;

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
    `tickmarkr ${runId}: ${summary.done.length} done, ${summary.failed.length} failed, ${summary.human.length} awaiting human, ${summary.blocked.length} blocked, ${summary.pending.length} pending${attribution ? ` (${attribution})` : ""}${tipFail} — integration branch ${branch} (merge to main is yours)`,
    { tier: summary.tipVerify === "failed" ? "attention" : "routine" },
  );
  return summary;
  });
  } catch (err) {
    // T7 (v1.86): guarded — a journal read/append failure while recording the fatal run-end is
    // reported alongside err, never instead of it; recordFatalRunEnd never throws, so the original
    // error (message, stack, cause) always reaches the caller verbatim.
    if (runStarted && !taskLoopStarted) recordFatalRunEnd(journal, runId, branch, err);
    throw err;
  } finally {
    // v1.54 T2: deregister on EVERY exit (normal run end, throw, termination unwind) — the daemon
    // test suite runs runDaemon dozens of times in one process; a leaked handler would close a
    // later run's slots.
    if (onTermination) {
      process.removeListener("SIGINT", onTermination);
      process.removeListener("SIGTERM", onTermination);
    }
    // T16: every other exit — normal end, throw, termination unwind. disarm() is idempotent, so the
    // signal path having already stood the tier down changes nothing here.
    supervision?.disarm();
    try {
      releaseRunLock(repoRoot);
    } finally {
      releaseApprovalSerialization?.();
    }
  }
}
