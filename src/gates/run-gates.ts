import { createHash, randomUUID } from "node:crypto";
import type { CommandReceiptAttribution, ShellReceipt } from "../run/protocol.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { type Assignment, type AuthHealth, type BillingChannel, channelKey, configuredEffort, shq, type WorkerAdapter, type WorkerResult } from "../adapters/types.js";
import { type TickmarkrConfig, TIER_RANK } from "../config/config.js";
import { getAdapter } from "../adapters/registry.js";
import { type Effort, GATE_NAMES, type GateName, type Task } from "../graph/schema.js";
import { acceptanceGate, type JudgedCriterion } from "./acceptance.js";
import { type Baseline, type RetryOptions, type GateEvidenceOptions, classifiedFileDurations, compareToBaseline, effectiveCeilingMs, waitForCalmWindow, calmWindowReady } from "./baseline.js";
import { evidenceGate } from "./evidence.js";
import { captureLlmOutput, type GateVia, SeatLaunchError } from "./llm.js";
import { withLaunchGuard } from "../drivers/orca.js";
import type { Slot } from "../drivers/types.js";
import { disallowedBy, observedSeat } from "../route/preference.js";
import { marginalCostRank } from "../route/router.js";
import { carriedAuthorVendors, gateReviewerFloor, pickReviewer, type PriorReviewer, reviewGate } from "./review.js";
import { scopeGate } from "./scope.js";
import { discoverTestManifest, evaluateManifestedTest, isVitestTestCommand, manifestChildEnv } from "./test-manifest.js";
import { RUNNER_INFRA_DIAGNOSTIC_RE, timeoutShaped } from "./timeout-shaped.js";
import type { GateResult } from "./types.js";
import { executionSignal } from "../run/execution-budget.js";
import { failureDisposition, type VerificationRetryCause } from "../run/recovery.js";
import { dependencyLinkRefusal, preserveWorktree, type PreserveProducer, producerFields, readCapacity, shGit, resolvedCapacity, sameCapacity, verificationProtocol } from "../run/git.js";
import { type StructuredFinding, type JudgeInvocationEvidence, withJudgeInvocationEvidence } from "../run/journal.js";
import {
  computeVerificationIdentity,
  verificationIdentityKey,
  formatReusedRow,
  getVerdictStore,
  isInfraResult,
  resolveStateDir,
  reusedIdentity,
  type VerificationIdentity,
  type VerificationScope,
} from "./cache.js";

// v2.0 T2 (OBS-554): the host one-minute load average — the decision variable the parked load-aware
// scheduler would key on. Injectable so a test can state the load a gate ran under; production always
// reads os.loadavg. Windows reports [0,0,0] and that is what gets recorded: an honest "unmeasurable
// here" beats a number this module would have to invent.
export type LoadProvider = () => number;
const productionLoadProvider: LoadProvider = () => loadavg()[0] ?? 0;
let loadProvider: LoadProvider = productionLoadProvider;

/** Test seam — inject deterministic load samples; production always reads os.loadavg. */
export function setLoadProviderForTests(provider: LoadProvider): void {
  loadProvider = provider;
}

export function resetLoadProviderForTests(): void {
  loadProvider = productionLoadProvider;
}

interface LlmDispatchClock {
  channel: string;
  effort?: Effort;
  preparedAt: number;
  startedAtPath: string;
  completedAtPath: string;
  dir: string;
}

interface LlmDispatchSpan {
  channel: string;
  // OBS-1182: the effort the adapter command was actually built with; absent = the CLI's default.
  effort?: Effort;
  durationMs: number;
}

/**
 * Instrument the adapter command itself, which is the first adapter-owned operation runLlm performs.
 * acceptanceGate/reviewGate deliberately retain ownership of deterministic oracles, policy checks,
 * diff reads and prompt construction; none of that preprocessing belongs to an LLM invocation span.
 *
 * Both stamps are written by the same shell immediately around the adapter command. That excludes
 * pane-slot acquisition as well as runLlm's scratch cleanup and verdict parsing, without changing
 * llm.ts's output contract. The subshell keeps an adapter command's `exit` from bypassing the end
 * stamp, and the original exit status is preserved.
 */
function instrumentLlmAdapter(adapter: WorkerAdapter, clocks: LlmDispatchClock[]): WorkerAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "headlessCommand") {
        return (promptFile: string, model: string, effort?: Effort): string => {
          const command = target.headlessCommand(promptFile, model, effort);
          const dir = mkdtempSync(join(tmpdir(), "tickmarkr-gate-invocation-"));
          const startedAtPath = join(dir, "started-at");
          const completedAtPath = join(dir, "completed-at");
          clocks.push({
            channel: channelKey({ adapter: target.id, model }),
            ...(effort ? { effort } : {}),
            preparedAt: Date.now(),
            startedAtPath,
            completedAtPath,
            dir,
          });
          const stamp = (path: string) => `${shq(process.execPath)} -e ${shq('require("node:fs").writeFileSync(process.argv[1], String(Date.now()))')} ${shq(path)}`;
          // End with a status-bearing subshell, not `exit`: pane mode appends its nonce-bound
          // completion trailer on the next script line and must remain able to run it.
          return `${stamp(startedAtPath)}; ( ${command} ); __tickmarkr_invocation_status=$?; ${stamp(completedAtPath)}; (exit $__tickmarkr_invocation_status)`;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      // Real adapters may use private fields; bind their methods to the target rather than the Proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function finishLlmDispatches(clocks: LlmDispatchClock[]): LlmDispatchSpan[] {
  return clocks.map((clock) => {
    let startedAt = clock.preparedAt;
    let completedAt = Date.now();
    try {
      const stampedStart = Number(readFileSync(clock.startedAtPath, "utf8"));
      const stamped = Number(readFileSync(clock.completedAtPath, "utf8"));
      if (Number.isFinite(stampedStart)) startedAt = stampedStart;
      if (Number.isFinite(stamped) && stamped >= startedAt) completedAt = stamped;
    } catch {
      // A killed command may never reach its stamp; the gate return is the honest upper boundary.
    } finally {
      rmSync(clock.dir, { recursive: true, force: true });
    }
    return { channel: clock.channel, ...(clock.effort ? { effort: clock.effort } : {}), durationMs: completedAt - startedAt };
  });
}

async function captureLlmDispatches<T>(
  adapters: WorkerAdapter[],
  run: (instrumented: WorkerAdapter[]) => Promise<T>,
): Promise<{ value: T; outputs: string[]; invocations: LlmDispatchSpan[] }> {
  const clocks: LlmDispatchClock[] = [];
  try {
    const captured = await captureLlmOutput(() => run(adapters.map((a) => instrumentLlmAdapter(a, clocks))));
    return { ...captured, invocations: finishLlmDispatches(clocks) };
  } catch (error) {
    finishLlmDispatches(clocks);
    throw error;
  }
}

/**
 * One gate's own measurement, taken WHERE THE GATE RUNS. `durationMs` sums that gate's execution
 * intervals and nothing between them, so the composite `test` gate (a selected screen, then other
 * gates, then the full suite) reports the two suites' cost rather than the span containing them
 * (split across the two rows when the screen is published before semantic gates, OBS-1176) —
 * and no consumer has to re-derive a duration by subtracting journal timestamps, which measures the
 * queue as well as the work. Load is sampled at each interval's endpoints and every second within it;
 * start preserves the scheduling input while max and mean retain sustained interior saturation.
 */
export interface GateTelemetry {
  durationMs: number;
  load1Start: number;
  load1End: number;
  load1Max: number;
  load1Mean: number;
}

export type GateEvent =
  // T4 (OBS-265): `parentAt` stamps the two verdict gates that a round launches TOGETHER — judge and
  // review share one parent timestamp, so a surface can tell "ran in parallel" from "ran in sequence"
  // without inferring it from wall-clock. Deterministic gates carry no parent: they are the sequence.
  | { phase: "start"; gate: GateName; index: number; total: number; parentAt?: number }
  | { phase: "end"; gate: GateName; result: GateResult }
  | { phase: "note"; gate: GateName; name: string; payload: Record<string, unknown>; result?: GateResult };

export interface GateContext {
  evidence?: GateEvidenceOptions;
  buildReceiptIdentity?: Omit<CommandReceiptAttribution, "invocation">;
  authorizeInfraRetry?: (subject: string, cause?: VerificationRetryCause) => boolean;
  verificationScope?: VerificationScope;
  worktree: string;
  baseRef: string;
  result: WorkerResult;
  author: Assignment;
  commands: Record<string, string>;
  baseline: Baseline;
  channels: BillingChannel[];
  // v1.87 T2: the judge-role pool for the GATE-09 failover pick. Absent means no alternate seat;
  // the configured judge remains the only truthful fallback and review channels are never judges.
  judgeChannels?: BillingChannel[];
  /** OBS-1186: doctor's cached verdict — the observed identity of the configured judge seat. Absent ⇒ unknown (conservative deny). */
  health?: Record<string, AuthHealth> | null;
  adapters: WorkerAdapter[];
  cfg: TickmarkrConfig;
  via?: GateVia; // v1.1: present → judge/review run as visible named agents through the driver
  carriedFindings?: readonly StructuredFinding[];
  /** Approval reason bound to this attempt; guidance, never criterion or closure authority. */
  operatorContext?: string;
  /** OBS-1151: this task's earlier parsed judgments, newest first (the journal's, so they survive resume). */
  priorJudgments?: readonly PriorJudgment[];
  excludeReviewers?: string[]; // v1.1: reviewer channels that produced garbage for this task (failover)
  // v2.6.8 T1: a SOFT preference only — a demoted seat ranks last and stays seatable (live or replayed on resume).
  demotedReviewers?: Set<string>;
  // OBS-1025 add.2 / v2.6.8 T1: run-scoped REAL no-verdict causes per reviewer seat (a launch failure never
  // enters it); a seat at two is RETIRED for the run — a hard exclusion read live at every pick, never soft.
  reviewNoVerdicts?: Map<string, string[]>;
  /** v2.6.8 T1: review seats whose one same-seat launch retry this candidate already spent (the daemon
   * replays them from the journal), so a resume or recheck never re-grants it by forgetting. */
  launchRetried?: readonly string[];
  // OBS-1055: this round is an operator recheck — it re-MEASURES, so a cached RED verdict is discarded
  // and the gate re-runs (a cached green is not what the recheck questions and may replay).
  recheck?: boolean;
  /** Explicit worker funding requires fresh red measurements, never a gate waiver. OBS-1106: so does
   * a retry that landed nothing on a timeout-class red — its one fresh re-observation. C: and one whose
   * unchanged red is attributed wholly outside the task's files[] — its one fresh re-execution. */
  cachedRedBypass?: "operator-rerun" | "timeout-fresh" | "out-of-scope-fresh";
  // OBS-1033: channel keys of the seats that authored the carried commits (the task's tried list) —
  // a reviewer of that vendor is excluded for the round, never handed its own work to approve.
  carriedAuthors?: readonly string[];
  /** The attempt whose worker last wrote the gated checkout; a dirty-tree refusal stamps it on the
   * preserve commit and its row. Absent (standalone verify, gate-only restores) preserves as "unknown". */
  producer?: PreserveProducer;
  reviewHistory?: string[]; // run-scoped LRU reviewer rotation; mutated synchronously when a seat is reserved
  priorReviewers?: PriorReviewer[]; // RF-1: seats THIS task's earlier review rows name, with their journaled dispatch tier — the floor a later round holds
  artifactDir?: string; // OBS-196: run dir for raw reviewer-output persistence on unparseable verdicts
  // This round may select tests covering its diff; the caller applies recorded repair history
  // and distrust before enabling it. Never a licence to merge on a subset: the merge-candidate round
  // re-runs the FULL suite on the same gated commit before this function reports green.
  selectTests?: boolean;
  requiredRepairTests?: readonly string[];
  selectionReason?: string;
  // OBS-547: this task's slice of the run's ONE full collateral map (uncapped, computed at run start
  // in the daemon). The gate classifies its red against it; absent ⇒ no classification.
  collateral?: ReadonlyArray<string>;
  onGate?: (e: GateEvent) => void | Promise<void>;
  stateDir?: string;
}

// A porcelain -z record: `status` is the 2-char XY code, `path` is that entry's current path.
// -z suppresses git's octal-escape quoting entirely (the newline form c-quotes any non-ASCII byte,
// which JSON.parse cannot decode — it uses a different escape grammar), so this is the only lossless
// way to read a status line's path.
interface DirtEntry {
  status: string;
  path: string;
}

interface DirtSnapshot {
  text: string;
  entries: DirtEntry[];
}

/** Parse `git status --porcelain --untracked-files=all -z` output. A rename/copy carries its
 * ORIGINAL path in a second NUL field immediately after the current one; skip it — dirt only
 * cares about paths that exist in the worktree now. */
function parseStatusZ(stdout: string): DirtEntry[] {
  const fields = stdout.split("\0");
  const entries: DirtEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    if (!rec) continue;
    const status = rec.slice(0, 2);
    entries.push({ status, path: rec.slice(3) });
    if (status.includes("R") || status.includes("C")) i++; // consume the paired original-path field
  }
  return entries;
}

const TEST_FILE_RE = /(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/;
// relative specifiers only — `from "./x.js"`, `import("./x.js")`, `require("./x.js")`
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;
const SELECTION_FILE_CAP = 3000;
// v2.6.7 T1: the paths the import scan can analyze — the cap bounds THESE, never every tracked path, so
// planning files, fixtures and docs cannot push an attributable source/test change over it.
const ANALYZABLE_RE = /\.[cm]?[jt]sx?$/;

/**
 * T4: the tests covering this round's diff, or undefined when the diff cannot be attributed with
 * certainty — a rename or delete (the old path's coverage is gone), or a changed file no test
 * reaches. Coverage: a test file covers itself; a test covers every file reachable from it through
 * relative imports, directly or transitively.
 *
 * ponytail: ceiling — relative specifiers only (no tsconfig paths, no bare aliases, no computed
 * specifiers), and an import cycle contributes only what it had resolved when re-entered. So this
 * CAN miss. The miss is bounded by construction, not by care: the merge-candidate round re-runs the
 * full suite on the same commit, so a miss costs one round and can never merge. Teach it a resolver
 * (tsconfig paths, package exports) if selection ever misses often enough to be worth a round.
 */
async function coveringTests(worktree: string, baseRef: string): Promise<{ files?: string[]; reason?: string }> {
  const unsupported = { reason: "unsupported-attribution" };
  // -z: NUL-delimited and never C-quoted, so a non-ASCII path keeps its real extension (v2.6.7 T1 review)
  const diff = await shGit(`git diff -z --name-status ${shq(baseRef)} HEAD`, worktree);
  if (diff.code !== 0) return unsupported;
  const changed: string[] = [];
  const fields = diff.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i]!;
    if (!status) continue;
    // R (rename) and D (delete): whatever used to cover the old path is unattributable now — full suite.
    if (status[0] === "R" || status[0] === "D") return unsupported;
    if (status[0] === "C") i++; // a copy carries its source path first; attribute the destination
    const path = fields[++i];
    if (!path) return unsupported;
    changed.push(path);
  }
  if (!changed.length) return unsupported;
  const listed = await shGit("git ls-files -z", worktree);
  if (listed.code !== 0) return unsupported;
  const tracked = listed.stdout.split("\0").filter(Boolean);
  // ponytail: a huge repo pays the full suite rather than a long scan — counted over analyzable paths only
  if (tracked.filter((p) => ANALYZABLE_RE.test(p)).length > SELECTION_FILE_CAP) return { reason: "analyzable-path-cap" };
  const trackedSet = new Set(tracked);
  const tests = tracked.filter((p) => TEST_FILE_RE.test(p));
  if (!tests.length) return { reason: "no-covering-tests" };

  const resolveSpec = (from: string, spec: string): string | undefined => {
    const base = posix.join(posix.dirname(from), spec);
    // ESM-TS writes ".js" for a ".ts" source; a directory specifier means its index.
    const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.jsx$/, ".tsx"),
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`];
    return candidates.find((c) => trackedSet.has(c));
  };
  const reachCache = new Map<string, Set<string>>();
  const reachOf = (file: string): Set<string> => {
    const cached = reachCache.get(file);
    if (cached) return cached;
    const out = new Set<string>();
    reachCache.set(file, out); // cycle guard: a re-entered file contributes what it has so far
    let src: string;
    try {
      src = readFileSync(posix.join(worktree, file), "utf8");
    } catch {
      return out;
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const dep = m[1] ? resolveSpec(file, m[1]) : undefined;
      if (!dep || out.has(dep)) continue;
      out.add(dep);
      for (const t of reachOf(dep)) out.add(t);
    }
    return out;
  };

  const selected = new Set<string>();
  for (const file of changed) {
    if (TEST_FILE_RE.test(file)) {
      selected.add(file);
      continue;
    }
    const covering = tests.filter((t) => reachOf(t).has(file));
    // A changed source no test reaches is unattributable: a diagnostic over the rest would screen around
    // it, so the whole selection is unsupported. A non-source path (docs, planning) carries no imports.
    if (!covering.length && ANALYZABLE_RE.test(file)) return unsupported;
    for (const t of covering) selected.add(t);
  }
  return selected.size ? { files: [...selected].sort() } : { reason: "no-covering-tests" };
}

/**
 * The configured test command narrowed to these files. Mirrors testFiltered's `--` rule (acceptance.ts:104):
 * npm/yarn/pnpm/npx script wrappers need one `--` to forward positional filters to the underlying runner;
 * a command that already has `--` takes them directly. Every path is quoted — config flows into a shell.
 */
export function testCommandForFiles(testCmd: string, files: string[]): string {
  const wrapped = /^\s*(?:npm|yarn|pnpm|npx)\b/.test(testCmd);
  const fwd = wrapped && !/\s--\s/.test(testCmd) ? " --" : "";
  return `${testCmd}${fwd} ${files.map(shq).join(" ")}`;
}

/** v2.6.7 T1 (closed order table): an attributed test-red diagnostic is admitted only when BOTH hold. */
export const DIAGNOSTIC_MAX_RATIO = 0.15;
export const DIAGNOSTIC_MAX_ESTIMATE_MS = 60_000;

export interface DiagnosticAdmission {
  admitted: boolean;
  reason: "diagnostic-admitted" | "diagnostic-unknown-cost" | "diagnostic-capacity-mismatch" | "diagnostic-cost-ratio" | "diagnostic-cost-estimate";
  costRatio?: number;
  estimatedMs?: number;
}

/**
 * The diagnostic's admission evidence, from the per-file durations the harness measured at baseline
 * capture — never a worker's timing. Unknown (any selected file unmeasured, any measurement that is not a
 * finite number > 0 ms, an infra baseline, or no positive total) skips: an expensive or unknown screen must
 * never become a full suite before semantics.
 * So does timing recorded under a malformed or different capacity (git.ts sameCapacity): it divided the
 * machine by another number, so it is not comparable evidence about this one.
 * `estimatedMs` is the serial sum of those files: admission evidence, not a kill ceiling and not a
 * claim about the parallel-plus-serial wall time the runner will actually take.
 */
export function diagnosticAdmission(baseline: Baseline, selected: readonly string[]): DiagnosticAdmission {
  const entry = baseline.commands.test;
  // The CURRENT capacity is validated on its own first: an unstamped (absent) baseline capacity is comparable
  // to anything, so it must never wave through a zero, negative, NaN, infinite or fractional current one.
  const current = resolvedCapacity();
  if (readCapacity(current).state !== "present" || !sameCapacity(entry?.capacity, current)) return { admitted: false, reason: "diagnostic-capacity-mismatch" };
  const raw: unknown = entry?.infra ? [] : classifiedFileDurations(entry) ?? [];
  const unknown = { admitted: false, reason: "diagnostic-unknown-cost" } as const;
  // Every input is checked BEFORE any arithmetic touches it: an entry that is not an object whose duration
  // is a finite number > 0 (0 ms, negative, NaN, non-numeric, an object with no primitive value), selected
  // or not, is unknown cost — never a free screen and never a throw.
  const measured = (f: unknown): f is { file: string; durationMs: number } => {
    const d = typeof f === "object" && f !== null ? (f as { durationMs?: unknown }).durationMs : undefined;
    return typeof d === "number" && Number.isFinite(d) && d > 0;
  };
  if (!Array.isArray(raw) || !raw.every(measured) || !selected.length) return unknown;
  const files = raw as { file: string; durationMs: number }[];
  // Baseline capture keeps one entry per (project, file): a file's cost is the sum of its measurements.
  const cost = new Map<string, number>();
  for (const f of files) cost.set(f.file, (cost.get(f.file) ?? 0) + f.durationMs);
  const total = files.reduce((sum, f) => sum + f.durationMs, 0);
  // Finite inputs can still overflow: a non-finite total or estimate is no comparable evidence either.
  if (!(total > 0) || !Number.isFinite(total) || selected.some((file) => !((cost.get(file) ?? 0) > 0))) return unknown;
  // A selected file that was RED in the baseline ended early there: its cost is unknown, never cheap.
  if (files.some((f) => (f as { failed?: unknown }).failed === true && selected.includes(f.file))) return unknown;
  const estimatedMs = selected.reduce((sum, file) => sum + cost.get(file)!, 0);
  if (!Number.isFinite(estimatedMs)) return unknown;
  const costRatio = estimatedMs / total;
  const reason = costRatio > DIAGNOSTIC_MAX_RATIO ? "diagnostic-cost-ratio"
    : estimatedMs > DIAGNOSTIC_MAX_ESTIMATE_MS ? "diagnostic-cost-estimate" : "diagnostic-admitted";
  return { admitted: reason === "diagnostic-admitted", reason, costRatio, estimatedMs };
}

/** OBS-635: the full manifest the runner lists NOW, under the environment evaluateManifestedTest's own
 * discovery receives (test-manifest.ts manifestEnvironment), so it compares with the one a verdict
 * certified. Undefined when the runner cannot list — an unlisted manifest certifies nothing. */
async function listFullManifest(cmd: string, worktree: string): Promise<string[] | undefined> {
  const env = manifestChildEnv(worktree);
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-full-manifest-"));
  try {
    return (await discoverTestManifest(cmd, worktree, { dir, nonce: randomUUID(), env })).files;
  } catch { return undefined; } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The manifest-report path for a detected vitest test command — never the stdout-count/file-count path.
 * ONE outer latch (`retried`) buys at most one more measurement of the exact same selection: the bounded
 * infrastructure retry, or — v2.6.6 C (D-873), default-on — a behavioral timeout red carrying runner
 * infra diagnostics, read by the daemon's own predicate (timeout-shaped.ts). Either waits for calm and
 * spends the bounded allowance when one is configured; neither follows a receipt-backed recovery
 * (retryable:false) or a diagnostic re-observation, and the second sample never stacks the stranded
 * single-fork recovery. The second sample is authoritative; the first keeps its receipts beside it. */
async function runVitestManifestGate(
  worktree: string,
  cmd: string,
  baseline: Baseline,
  selected: readonly string[] | undefined,
  artifactDir?: string,
  retry: RetryOptions & { evidence?: GateEvidenceOptions; retryBaseCommand?: string } = {},
  retried = false,
): Promise<GateResult> {
  const entry = baseline.commands.test;
  const outcome = await evaluateManifestedTest(cmd, worktree, {
    baselineDurations: classifiedFileDurations(entry),
    longestFile: entry?.longestFile,
    overallCeilingMs: effectiveCeilingMs(entry),
    artifactDir,
    evidence: retry.evidence,
    retryBaseCommand: retry.retryBaseCommand, // OBS-1166: the un-narrowed command for a selected screen's stranded retry
    allowStrandedRecovery: !retried,
  });
  const reportPath = outcome.reportPath;
  const evidence = { evidenceReceipt: outcome.evidenceReceipt, evidenceReceipts: outcome.evidenceReceipts };
  const disposition = failureDisposition(outcome);
  const shaped = disposition === "behavioral" && timeoutShaped(outcome.details) && RUNNER_INFRA_DIAGNOSTIC_RE.test(outcome.details);
  if (!retried && outcome.meta?.retryable !== false && retry.retryBaseCommand !== REOBSERVATION_RETRY_BASE
      && (shaped || (retry.authorizeRetry && disposition === "infrastructure"))) {
    const waitedMs = await waitForCalmWindow(executionSignal());
    if (!calmWindowReady()) return { ...evidence, gate: "test", pass: false, details: outcome.details,
      meta: { ...outcome.meta, reportPath, recoveryBlocked: "calm window unavailable within the existing wait ceiling" } };
    if (retry.authorizeRetry && !retry.authorizeRetry("infra")) {
      return { ...evidence, gate: "test", pass: false, details: outcome.details,
        meta: { ...outcome.meta, reportPath, recoveryBlocked: "infrastructure retry allowance exhausted or subject unavailable" } };
    }
    const result = await runVitestManifestGate(worktree, cmd, baseline, selected, artifactDir, retry, true);
    const rerun = { count: 1, waitedMs, firstReportPath: reportPath };
    return { ...result, evidenceReceipts: [...(outcome.evidenceReceipts ?? []), ...(result.evidenceReceipts ?? [])],
      meta: { ...result.meta, ...(shaped
        ? { remeasured: { ...rerun, first: { pass: outcome.pass, details: outcome.details, meta: outcome.meta } } }
        : { runnerInfraRerun: rerun }) } };
  }
  return {
    ...evidence,
    gate: "test",
    pass: outcome.pass,
    details: outcome.details,
    meta: { ...outcome.meta, reportPath, ...(selected ? { selectedTests: [...selected] } : {}) },
  };
}

/** A retry base no runner invocation parses. evaluateManifestedTest builds its stranded single-fork
 * retry from the base it is handed, and one it cannot parse throws before any spawn — so this base
 * disables that inner recovery: a worker-RPC-stranded re-observation comes back infra (the caller
 * parks it as ambiguous) instead of launching a second execution. runVitestManifestGate reads it as
 * the mark of a diagnostic subset, which never buys the outer timeout-shaped remeasurement either. */
export const REOBSERVATION_RETRY_BASE = "tickmarkr-reobservation-refuses-stranded-retry";

/** OBS-1106 residual: ONE isolated re-observation of a timeout-shaped red's attributed failing files on
 * the same checkout, narrowed exactly as a screen is. Never cached and never a verdict: the caller
 * keeps the original red and reads this only to decide whether that red is chargeable. Exactly one
 * execution — the bounded infra/host-starved retries and the stranded single-fork recovery are all
 * refused, so a diagnostic never buys more. */
export async function reobserveTestFiles(worktree: string, testCmd: string, baseline: Baseline, files: string[], artifactDir?: string): Promise<GateResult> {
  const cmd = testCommandForFiles(testCmd, files);
  if (!isVitestTestCommand(testCmd, worktree))
    return (await compareToBaseline(worktree, { test: cmd }, baseline, ["test"], { selected: files, authorizeRetry: () => false }))[0]!;
  const r = await runVitestManifestGate(worktree, cmd, baseline, files, artifactDir, { retryBaseCommand: REOBSERVATION_RETRY_BASE });
  // fail closed whatever a recovery did: a re-observation never reads a recovered verdict
  return r.meta?.recovery === undefined ? r
    : { ...r, pass: false, meta: { ...r.meta, classification: "infra", infra: true, retryable: false, recoveryRefused: true } };
}

const SIGNAL_EXIT_RE = /\b(?:SIGTERM|SIGKILL|signal\s+(?:9|15)|exit(?:s|ed|\s+code)?\s+(?:137|143))\b/i;
const FAILURE_IDENTITY_RE = /\b(?:AssertionError|FAIL\s+\S|Tests?\s+\d+\s+failed|expected\s+.+\s+to\s+)\b/i;

/** D1: apply the daemon's signal-only rider before either battery cache read or write. Its onGate
 * classification happens after persistence, too late to keep a scripted runner's non-verdict out.
 * Keep named failures as work verdicts and preserve details for failure-policy fingerprinting.
 * A baseline-forgiven "green" whose runner was signal-killed is the same non-verdict: a killed job
 * completed no suite, so forgiveness never publishes or caches it green. The authoritative termination
 * receipt decides, never the verdict text: a signal-terminated job is killed whatever its details say, and
 * a green stands only on a receipt showing a normal exit — a receiptless CACHED one (an older or planted
 * entry) is unavailable proof, so a fresh job measures instead. A fresh row is this invocation's own: every
 * production runner attaches its receipt, and the manifest path's verdict already requires a clean exit
 * (test-manifest.ts verifyManifestReport). A no-command skip ran nothing and claims none. */
function classifySignalOnlyTest(g: GateResult, cached = false): void {
  const termination = g.evidenceReceipt?.termination.kind;
  const exitCode = g.evidenceReceipt?.termination.exitCode;
  const killed = termination === "signal" || exitCode === 137 || exitCode === 143 || (!g.pass && SIGNAL_EXIT_RE.test(g.details));
  const unproven = g.pass && g.meta?.skipped !== true && termination !== "exit" && (cached || termination !== undefined);
  if (g.gate !== "test" || g.meta?.infra === true || !(killed || unproven)) return;
  const named = Array.isArray(g.meta?.failingTests) && g.meta.failingTests.length > 0;
  if (!g.pass && (named || FAILURE_IDENTITY_RE.test(g.details))) return;
  g.pass = false;
  g.meta = { ...g.meta, classification: "infra", infra: true, retryable: false, kind: killed || termination ? "signal-exit" : "no-exit-receipt" };
}

/** OBS-1151: one parsed judgment as the journal keeps it — the judged commit, the seat, and per criterion
 * its subject key, ruling and cited paths. Never a verdict to reuse: only a subject to compare against. */
export interface PriorJudgment {
  commit: string;
  judge?: string;
  criteria: ReadonlyArray<{ id: string; key: string; met: boolean; paths: readonly string[] }>;
}

/** OBS-1151: a criterion's comparable subject — its canonical text, the task's declared bounds and the
 * operator context. The cited files' blobs are compared separately, over the union of both citations. */
export function judgmentSubjectKey(task: Pick<Task, "files" | "outOfScope">, criterion: string, operatorContext?: string): string {
  return createHash("sha256").update(JSON.stringify([criterion, [...task.files].sort(), [...(task.outOfScope ?? [])].sort(), operatorContext ?? ""])).digest("hex");
}

async function blobAt(worktree: string, commit: string, path: string): Promise<string | undefined> {
  const r = await shGit(`git rev-parse --verify --quiet ${shq(`${commit}:${path}`)}`, worktree);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

export interface JudgeContradiction { id: string; met: boolean; priorMet: boolean; priorCommit: string; paths: string[] }

/** OBS-1151: the criteria whose fresh ruling reverses the newest prior ruling on the same subject key whose
 * cited paths hold the identical blob at both commits (older comparable priors are still found behind a
 * newer prior on different blobs). A citation-less side or an
 * unreadable blob is unknown, never identical — that criterion's fresh ruling is simply fresh. */
export async function judgeContradictions(
  worktree: string, head: string,
  fresh: PriorJudgment["criteria"], priors: readonly PriorJudgment[],
): Promise<JudgeContradiction[]> {
  const found: JudgeContradiction[] = [];
  for (const c of fresh) {
    if (!c.paths.length) continue;
    // C-3 (D-669): the comparable prior is the NEWEST one on identical cited blobs, not the newest one
    // carrying the key — PASS(A) → FAIL(B) → fresh FAIL(A) must still be adjudicated against PASS(A).
    for (const prior of priors) {
      const was = prior.criteria.find((q) => q.key === c.key);
      if (!was || !was.paths.length) continue;
      const paths = [...new Set([...was.paths, ...c.paths])].sort();
      let identical = true;
      for (const path of paths) {
        const [before, now] = await Promise.all([blobAt(worktree, prior.commit, path), blobAt(worktree, head, path)]);
        if (!before || !now || before !== now) { identical = false; break; }
      }
      if (!identical) continue;
      if (was.met !== c.met) found.push({ id: c.id, met: c.met, priorMet: was.met, priorCommit: prior.commit, paths });
      break;
    }
  }
  return found;
}

export async function runGates(
  task: Task,
  ctx: GateContext,
): Promise<{ results: GateResult[]; commits: string[] }> {
  const results: GateResult[] = [];
  const evidence: GateEvidenceOptions = {
    artifactDir: ctx.artifactDir,
    runId: ctx.buildReceiptIdentity?.runId ?? ctx.artifactDir ?? "standalone",
    taskId: task.id, attempt: ctx.buildReceiptIdentity?.attempt ?? 0,
    // OBS-1140: task and standalone gates honour the configured quota, not the built-in default.
    quotaBytes: ctx.cfg.gates?.evidenceQuotaBytes,
    ...ctx.evidence,
  };
  // Receipt identity belongs to this round, never to a cached verdict. Each call from the shell
  // allocates a new invocation, including retries whose local spawn counter starts at one again.
  let currentBuild: CommandReceiptAttribution | undefined;
  let buildStarted = false;
  let receiptNotes = Promise.resolve();
  const beginBuild = (): CommandReceiptAttribution => {
    buildStarted = false;
    currentBuild = { ...(ctx.buildReceiptIdentity ?? {
      runId: ctx.artifactDir ?? "standalone", taskId: task.id, attempt: 0, gateRound: 0,
    }), invocation: randomUUID() };
    return { ...currentBuild };
  };
  const buildReceipt = (receipt: ShellReceipt, reason?: string): void => {
    const matches = currentBuild !== undefined && receipt.attribution !== undefined
      && (Object.keys(currentBuild) as Array<keyof CommandReceiptAttribution>)
        .every((key) => receipt.attribution![key] === currentBuild![key]);
    const attributed = matches && (receipt.outcome === "started" || !receipt.confirmedStart || buildStarted);
    if (attributed) buildStarted = receipt.outcome === "started";
    const { attribution, ...observation } = receipt;
    const payload = attributed ? { ...receipt, gate: "build", ...(reason ? { reason, freshBuildRan: false } : {}) } : {
      ...observation, gate: "build", attributionStatus: "unattributed",
      reportedAttribution: attribution,
    };
    // Shell observers are synchronous. Serialize asynchronous note sinks and drain before the
    // verdict (also on cancellation), without letting an observer change execution or retry policy.
    receiptNotes = receiptNotes.then(async () => {
      await ctx.onGate?.({ phase: "note", gate: "build", name: "build-receipt", payload });
    }).catch(() => {});
  };
  const noBuild = async (outcome: "reused-result" | "skipped" | "refused", reason: string) => {
    buildReceipt({ outcome, confirmedStart: false, attribution: beginBuild() }, reason);
    await receiptNotes;
  };
  let selectionDecision: Record<string, unknown> | undefined;
  // OBS-635: a stale in-battery full green buys one fresh merge-candidate job (see answersNow).
  let rerunFull = false;
  let commits: string[] = [];
  // Check before cache identity, npm policy probes, or any gate command.
  const dependencyRefusal = dependencyLinkRefusal(ctx.worktree);
  if (dependencyRefusal) {
    const gate = GATE_NAMES.find(g => task.gates.includes(g)) ?? "build";
    const result: GateResult = { gate, pass: false, details: dependencyRefusal,
      meta: { infra: true, classification: "infra", retryable: false, kind: "workspace-dependency" } };
    await noBuild("refused", dependencyRefusal);
    await ctx.onGate?.({ phase: "end", gate, result });
    return { results: [result], commits: [] };
  }
  const stateDir = ctx.stateDir ?? resolveStateDir(ctx.worktree, ctx.artifactDir);
  const verdictStore = getVerdictStore(stateDir);
  // R41: the verification protocol and the EFFECTIVE npm lifecycle policy measured for THIS
  // checkout — the policy its runner children receive (an explicit process export, else npm's own
  // resolved config for this worktree, project npmrc included). Every result leaves through
  // withTelemetry carrying it, so the daemon's gate-result row records what the gate measured under
  // rather than a session-wide value resolved somewhere else.
  const verification = verificationProtocol(process.env, ctx.worktree);
  // VC-1: a reused verdict is journaled as its own row (the daemon appends every note by name) so
  // the ledger names the reuse and the identity even where the gate-result row's details must stay
  // the fresh verdict's (see formatReusedRow).
  const noteReuse = (gate: GateName, r: GateResult, id: VerificationIdentity) =>
    ctx.onGate?.({ phase: "note", gate, name: "gate-reused-verdict", payload: { gate, pass: r.pass, details: r.meta?.reusedDetails, ...reusedIdentity(id) }, result: r });
  // OBS-1055: on a recheck a cached red is the answer the operator just said was wrongly given; it is
  // journaled as discarded and the gate runs. Returns true when the hit must NOT be reused.
  const discardCachedRed = async (gate: GateName, hit: GateResult): Promise<boolean> => {
    const reason = ctx.recheck ? "recheck" : ctx.cachedRedBypass;
    if (!reason || hit.pass) return false;
    await ctx.onGate?.({ phase: "note", gate, name: reason === "recheck" ? "recheck-rerun" : "gate-rerun",
      payload: { gate, reason: "cached-red-discarded", ...(reason === "recheck" ? {} : { bypass: reason }) }, result: hit });
    return true;
  };
  // OBS-1168(c): every judge/review seat this round opens, so a failed sibling can cancel the other.
  // A cancelled round dispatches, re-routes and publishes nothing more; its closed seats' own errors
  // are consequences of the cancel, never a second failure.
  // A seat whose creation was still pending at the cancel is refused before dispatch: onSlot runs inside
  // llm.ts's launch guard, so the throw closes (and awaits) that half-launched pane and never runs it.
  const semanticSlots = new Set<Slot>();
  const closing: Promise<unknown>[] = [];
  const via: GateVia | undefined = ctx.via && {
    ...ctx.via, onSlot: (slot) => {
      semanticSlots.add(slot);
      ctx.via!.onSlot?.(slot);
      if (cancelled) throw new Error("semantic round cancelled before dispatch");
    },
  };
  let cancelled = false;
  const cancelSemantic = () => {
    if (cancelled) return;
    cancelled = true;
    for (const slot of semanticSlots) closing.push(via!.driver.close(slot).catch(() => {}));
  };
  const shapeGates = ctx.cfg.gates.byShape?.[task.shape];
  const enabled = (g: GateName) =>
    task.gates.includes(g) && (g !== "acceptance" && g !== "review" || shapeGates?.[g] !== false);
  const semantic = enabled("acceptance") || enabled("review");
  // v2.6.7 T1 (closed order table): after the cheap build/lint/evidence/scope checks, acceptance and
  // review run BEFORE any test-gate payload for every candidate — fresh, semantic repair, or a test-red
  // repair without an admitted diagnostic — so a decisive semantic red costs zero test starts. Only a
  // concrete attributed behavioral test-red repair may buy one cheap diagnostic first (see below).
  // A review that returned NO verdict is not a red that ends the round before its test proof: the
  // daemon re-asks only the review (runReviewRecovery) and merges on the rows beside it, so the round
  // still buys its full job. The row stays red; the round is unsatisfied until that recovery answers.
  // A gate that DECLINED (meta.skipped, R3) is no red either: a declined review no longer ends the round
  // just because it now precedes the test gate.
  const failed = () => results.some((r) => !r.pass && r.meta?.skipped !== true && !(r.gate === "review" && r.meta?.noVerdict === true));
  // D-974: set once the cheap checks pass. From then on an enabled gate the round leaves unrun is owed
  // proof (done()) unless a decisive red already decided the round.
  let proofOwed = false;
  // v2.0 T2 (OBS-554): this round's per-gate measurement. Every interval a gate actually spends
  // executing is added HERE, at the call site that runs it, so a gate that runs twice (the test
  // gate's screen and its full suite) sums to its own cost and never to the span between them.
  const spans = new Map<string, GateTelemetry>();
  const loadSamples = new Map<string, number[]>();
  // The test gate's two halves, kept apart as well as summed: `durationMs` alone cannot say whether
  // a slow round was a slow subset or a slow full suite, and the parked scheduler's threshold is
  // defined over the full-suite cost.
  let selectedDurationMs: number | undefined;
  let fullDurationMs: number | undefined;
  const startMeasurement = () => {
    const at = Date.now();
    const samples = [loadProvider()];
    const timer = setInterval(() => samples.push(loadProvider()), 1_000);
    timer.unref();
    return () => {
      clearInterval(timer);
      samples.push(loadProvider());
      return { durationMs: Date.now() - at, samples };
    };
  };
  const addMeasurement = (gate: string, measured: { durationMs: number; samples: number[] }) => {
    const prior = spans.get(gate);
    const samples = [...(loadSamples.get(gate) ?? []), ...measured.samples];
    loadSamples.set(gate, samples);
    spans.set(gate, {
      durationMs: (prior?.durationMs ?? 0) + measured.durationMs,
      load1Start: samples[0]!,
      load1End: samples[samples.length - 1]!,
      load1Max: Math.max(...samples),
      load1Mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    });
  };
  const measure = async <T>(gate: string, run: () => Promise<T>): Promise<T> => {
    const finish = startMeasurement();
    try {
      return await run();
    } finally {
      addMeasurement(gate, finish());
    }
  };
  // The measurement is attached at the ONE seam every result leaves this function through, so a
  // path that forgets to measure is visibly missing its telemetry rather than carrying a fabricated
  // zero. The daemon lifts these off `meta` onto the gate-result row (src/run/daemon.ts).
  const withTelemetry = (result: GateResult): GateResult => {
    if (result.gate === "test" && selectionDecision) {
      result = { ...result, meta: { ...result.meta, selectionDecision } };
    }
    const span = spans.get(result.gate);
    if (!span) return { ...result, meta: { ...result.meta, verification } };
    return {
      ...result,
      meta: {
        ...result.meta,
        verification,
        ...span,
        ...(result.gate === "test" && selectedDurationMs !== undefined ? { selectedDurationMs } : {}),
        ...(result.gate === "test" && fullDurationMs !== undefined ? { fullDurationMs } : {}),
      },
    };
  };

  const sequence = GATE_NAMES.filter((g) => enabled(g));
  const total = sequence.length;
  const indexOf = (gate: GateName) => sequence.indexOf(gate) + 1;

  // The stamp lands here, on the ONE object that is both pushed and published, so the round's record
  // and its event stream carry byte-identical results — an invariant the fixtures pin.
  const record = async (result: GateResult) => {
    const stamped = withTelemetry(result);
    results.push(stamped);
    await ctx.onGate?.({ phase: "end", gate: stamped.gate as GateName, result: stamped });
  };

  const emitStart = async (gate: GateName, parentAt?: number) => {
    await ctx.onGate?.({ phase: "start", gate, index: indexOf(gate), total, ...(parentAt === undefined ? {} : { parentAt }) });
  };

  // The returned array stays in GATE_NAMES order however few gates a short-circuiting round reached.
  const done = async () => {
    const sorted = [...results].sort((a, b) => GATE_NAMES.indexOf(a.gate as GateName) - GATE_NAMES.indexOf(b.gate as GateName));
    // v1.87 T5: no round returns a MERGEABLE GREEN on a dirty tree. The battery is not the only gate
    // that executes shell in this worktree — the acceptance gate runs command and named-test oracles
    // (acceptance.ts:264,275) and both verdict gates dispatch a vendor CLI here — so the last word on
    // cleanliness has to be the round's last act rather than the battery's. `results` is what the
    // daemon merges on (daemon.ts `results.every(gateSatisfied)`), so the withdrawal lands there; the
    // journal keeps both the green and its retraction, the honest record of a verdict that did not
    // survive its own round.
    const last = sorted[sorted.length - 1];
    if (last && sorted.every((r) => r.pass || r.meta?.skipped === true)) {
      const dirt = await dirtyWorktree();
      if (dirt) {
        const refusal = withTelemetry(await dirtyRoundRefusal(last.gate as GateName, dirt));
        results[results.indexOf(last)] = refusal;
        sorted[sorted.length - 1] = refusal;
        await ctx.onGate?.({ phase: "end", gate: refusal.gate as GateName, result: refusal });
      }
    }
    // D-974 (closed missing-proof table): owed rows land ONLY when the round holds no decisive red —
    // every unsatisfied row is infra or no-verdict and could be recovered — so a review-only recovery
    // can never merge over a gate the round never ran. After a decisive rejection the gates it left
    // unrun owe nothing. A selected diagnostic green is not full proof, so it is owed too. Gates the
    // task omits or its shape disables are outside `sequence` and create no debt.
    const unsatisfied = results.filter((r) => !(r.pass || r.meta?.skipped === true) || r.meta?.infra === true);
    if (proofOwed && unsatisfied.length && unsatisfied.every((r) => r.meta?.infra === true || r.meta?.noVerdict === true)) {
      for (const gate of sequence) {
        if (gate === "test" && ctx.commands.test === undefined) continue;
        const at = results.findIndex((r) => r.gate === gate);
        const diagnosticOnly = gate === "test" && at >= 0 && results[at]!.pass
          && Array.isArray(results[at]!.meta?.selectedTests) && results[at]!.meta?.fullSuite !== true;
        if (at >= 0 && !diagnosticOnly) continue;
        if (at >= 0) results.splice(at, 1);
        await record({ gate, pass: false, details: `${gate} not run — the round ended on a recoverable non-verdict before `
          + `${gate === "test" ? "its full verification job" : "this gate published a verdict"}; that proof is still owed on this subject`,
        meta: { skipped: true, infra: true, classification: "infra", retryable: false, gateOwed: gate, ...(gate === "test" ? { testOwed: true } : {}) } });
      }
      return { results: [...results].sort((a, b) => GATE_NAMES.indexOf(a.gate as GateName) - GATE_NAMES.indexOf(b.gate as GateName)), commits };
    }
    return { results: sorted, commits };
  };

  const toolGates = (["build", "lint"] as const).filter(enabled);

  /**
   * v1.87 T5: the shell gates run their commands against the WORKING TREE, while evidence, scope,
   * the judged diff and the merge all read COMMITS. Uncommitted work is therefore visible to
   * build/test/lint and invisible to everything that decides what ships — a green battery on a dirty
   * tree certifies a tree nobody will ever merge, and the committed diff it stands for was never run.
   *
   * That is not gatable-with-a-caveat, so the battery refuses it rather than gating it and hoping.
   * An unreadable `git status` is refused on the same rule: a tree that cannot be proven clean is not
   * proven clean. Returns the dirt (porcelain lines) to name in the refusal, or undefined when clean.
   *
   * The one exemption is tickmarkr's OWN droppings — root-level `.tickmarkr-*` (the adapters' usage
   * record). The harness wrote those, not the worker; they are not work anyone meant to merge, and
   * refusing a tree for the harness's own litter would fail every metered run. Nothing else is
   * exempt: an untracked source file is uncommitted work by every reading git offers.
   */
  const dirtyWorktree = async (): Promise<DirtSnapshot | undefined> => {
    const r = await shGit("GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all -z", ctx.worktree);
    if (r.code !== 0) return { text: `git status failed (exit ${r.code}) — the worktree cannot be proven clean`, entries: [] };
    const entries = parseStatusZ(r.stdout).filter((e) => !/^\.tickmarkr-[^/]*$/.test(e.path));
    if (!entries.length) return undefined;
    return { text: entries.map((e) => `${e.status} ${e.path}`).join("\n"), entries };
  };

  const DIRTY_WHY = `refusing to gate a dirty worktree: the shell gates run against the working tree while `
    + `evidence, scope and the merge read commits, so these uncommitted changes would be gated `
    + `and never merged (and the committed diff would never be run)`;

  // `left` names the command that CREATED the dirt when one did; a round-entry refusal has no culprit.
  const dirtyRefusal = async (gate: GateName, dirt: DirtSnapshot, left?: string): Promise<GateResult> => {
    let preservedRef: string | undefined;
    let preservationError: string | undefined;
    try {
      preservedRef = await preserveWorktree(ctx.worktree, ctx.producer);
    } catch (error) {
      // Never masks the refusal, but never pretends a snapshot exists either — surfaced below.
      preservationError = error instanceof Error ? error.message : String(error);
    }

    const dirtyPaths: string[] = [];
    let allUntracked = true;
    let totalBytes = 0;

    for (const { status, path } of dirt.entries) {
      dirtyPaths.push(path);
      if (status !== "??") {
        allUntracked = false;
      }
      try {
        const st = statSync(join(ctx.worktree, path));
        if (st.isFile()) {
          totalBytes += st.size;
        }
      } catch {
        // ignore deleted or unreadable
      }
    }

    let allAbsentFromDiff = true;
    if (ctx.baseRef) {
      try {
        const diffOut = await shGit(`git diff --name-only -z ${shq(ctx.baseRef)}..HEAD`, ctx.worktree);
        if (diffOut.code === 0) {
          // Paths in Git's newline output are C-quoted, which is not a lossless path encoding
          // (and must never be parsed as JSON). `-z` lets this comparison retain arbitrary
          // filenames exactly, including whitespace and non-ASCII bytes.
          const touched = new Set(diffOut.stdout.split("\0").filter(Boolean));
          for (const p of dirtyPaths) {
            if (touched.has(p)) {
              allAbsentFromDiff = false;
              break;
            }
          }
        } else {
          // An unreadable committed diff cannot prove the litter is unrelated to the worker.
          allAbsentFromDiff = false;
        }
      } catch {
        allAbsentFromDiff = false;
      }
    }

    const isInfra = Boolean(left && allUntracked && allAbsentFromDiff);
    const primaryFile = dirtyPaths[0] ?? "";

    const meta: Record<string, unknown> = {
      dirtyWorktree: true,
      ref: preservedRef,
      preservedRef,
      ...producerFields(ctx.producer),
      paths: dirtyPaths,
      files: dirtyPaths,
      path: primaryFile,
      file: primaryFile,
      bytes: totalBytes,
      byteCount: totalBytes,
    };

    if (left) {
      meta.dirtiedBy = gate;
      meta.culprit = left;
      meta.culpritCommand = left;
      meta.command = left;
    }

    if (isInfra) {
      meta.infra = true;
      meta.classification = "infra";
    }

    if (preservationError) {
      meta.preservationFailed = true;
      meta.preservationError = preservationError;
      // A refusal without a durable snapshot must never enter the ordinary repair/escalation
      // path: the daemon recognizes infra rows as terminal parks for this attempt. This also
      // overrides a chargeable entry/tracked-dirt classification, because retrying could lose
      // the only remaining copy of the worktree state.
      meta.infra = true;
      meta.classification = "infra";
      meta.retryable = false;
      meta.recoveryBlocked = "dirty worktree preservation failed; no recovery ref exists";
    }

    return {
      gate,
      pass: false,
      details: DIRTY_WHY
        + (left ? `. The ${gate} command (${left}) left them behind, so every gate after it would judge a tree nobody will merge:\n` : `:\n`)
        + dirt.text
        + (preservationError ? `\npreservation failed — the litter could not be snapshotted onto a recovery ref: ${preservationError}` : ""),
      meta,
    };
  };

  // The round-end withdrawal (see `done`). It blames no command: whatever dirtied the tree ran after
  // the last cleanliness check, and naming a culprit this function cannot identify would be a worse
  // record than naming the fact. `gate` is the verdict being withdrawn, not an accusation about who wrote.
  const dirtyRoundRefusal = async (gate: GateName, dirt: DirtSnapshot): Promise<GateResult> => {
    let preservedRef: string | undefined;
    let preservationError: string | undefined;
    try {
      preservedRef = await preserveWorktree(ctx.worktree, ctx.producer);
    } catch (error) {
      preservationError = error instanceof Error ? error.message : String(error);
    }

    const dirtyPaths: string[] = [];
    let totalBytes = 0;
    for (const { path } of dirt.entries) {
      dirtyPaths.push(path);
      try {
        const st = statSync(join(ctx.worktree, path));
        if (st.isFile()) {
          totalBytes += st.size;
        }
      } catch {}
    }

    const primaryFile = dirtyPaths[0] ?? "";
    return {
      gate,
      pass: false,
      details: `${DIRTY_WHY}. Every gate of this round was satisfied and the round ended dirty — something after `
        + `the last cleanliness check (the acceptance gate's command/test oracles, or a verdict gate's `
        + `vendor CLI) wrote into the worktree — so this mergeable result is withdrawn rather than merged. `
        + `Uncommitted at round end:\n${dirt.text}`
        + (preservationError ? `\npreservation failed — the litter could not be snapshotted onto a recovery ref: ${preservationError}` : ""),
      meta: {
        dirtyWorktree: true,
        dirtyAtRoundEnd: true,
        ref: preservedRef,
        preservedRef,
        ...producerFields(ctx.producer),
        paths: dirtyPaths,
        files: dirtyPaths,
        path: primaryFile,
        file: primaryFile,
        bytes: totalBytes,
        byteCount: totalBytes,
        ...(preservationError ? {
          preservationFailed: true,
          preservationError,
          infra: true,
          classification: "infra",
          retryable: false,
          recoveryBlocked: "dirty worktree preservation failed; no recovery ref exists",
        } : {}),
      },
    };
  };

  const fullTestIdentity = () => computeVerificationIdentity({
    worktree: ctx.worktree,
    gate: "test",
    scope: ctx.verificationScope,
    command: ctx.commands.test!,
    baseline: ctx.baseline,
    selectedSet: undefined,
    capacity: resolvedCapacity(),
  });
  // OBS-635: a full green answers only for the manifest it certified. The tree identity cannot see an
  // ignored generated test the runner would collect, so every full-green check rediscovers the
  // runner's listing NOW and requires the verdict's to equal it; a runner without a listing is bound by
  // its identity alone. So is a FRESH green that certified no manifest beside a runner that lists none
  // now: neither side holds a manifest that could have moved. A cached one certifies nothing (no reuse).
  // OOB M1: the listing is itself a command — one that creates an ignored collectable test AFTER taking
  // its own snapshot returns the manifest it just made stale, and neither cleanliness nor the identity
  // sees an ignored file. So an agreeing listing certifies only when STABLE: one more listing, taken
  // after the first one's side effects, must return the same set (one extra listing per proof, and only
  // on the agreeing path). An unstable listing is stale proof like any other moved manifest.
  const certifiesFullManifest = async (verdict: { pass: boolean; meta?: Record<string, unknown> }, fresh = false): Promise<boolean> => {
    if (!verdict.pass || !isVitestTestCommand(ctx.commands.test!, ctx.worktree)) return true;
    const certified = verdict.meta?.manifest;
    const current = await listFullManifest(ctx.commands.test!, ctx.worktree);
    if (fresh && certified === undefined && current === undefined) return true;
    if (!Array.isArray(certified) || current === undefined
      || certified.length !== current.length || ![...certified].sort().every((file, i) => file === current[i])) return false;
    const settled = await listFullManifest(ctx.commands.test!, ctx.worktree);
    return settled !== undefined && settled.length === current.length && settled.every((file, i) => file === current[i]);
  };
  // OBS-635: a full green — fresh or cached — answers only while the identity it measured and the complete
  // manifest the runner lists NOW still hold — the job's own command may have written an ignored lockfile or
  // a test the runner now collects. Checked before that green is cached, reused or published. `strict` (the in-battery job,
  // which may still buy a fresh one) adds D-598: an unmeasurable lifecycle on either side is not comparable
  // to anything (VerdictStore R41 refuses it), so two `unknown`s hashing equal is no unchanged identity.
  const answersNow = async (before: VerificationIdentity | undefined, verdict: GateResult, strict: boolean, fresh = strict): Promise<boolean> => {
    // The listing is a command too (it may write an ignored lockfile or a tracked byte), so it runs FIRST
    // and cleanliness and identity are sampled after it — never before.
    if (!(await certifiesFullManifest(verdict, fresh)) || await dirtyWorktree()) return false;
    const now = await fullTestIdentity();
    const measurable = (id: VerificationIdentity) => !strict || id.envParts?.verification?.lifecycle !== "unknown";
    return !!now && !!before && measurable(now) && measurable(before)
      && verificationIdentityKey(now) === verificationIdentityKey(before);
  };
  // A stale green is never green: an infra row naming why, unverdicted (skipped) while a fresh job supersedes it.
  const staleProof = (r: GateResult, superseded: boolean): GateResult => ({ ...r, pass: false,
    details: `stale full proof: this job's own command moved the verification identity or the complete manifest the runner `
      + `lists now, so its green answers an earlier subject — ${superseded ? "one fresh full job measures this one" : "failing closed"}\n${r.details}`,
    meta: { ...r.meta, infra: true, classification: "infra", retryable: false, staleProof: true, ...(superseded ? { skipped: true } : {}) } });

  // shell tools vs the shared baseline
  const retryOptions = (identity: VerificationIdentity | undefined): RetryOptions => ctx.authorizeInfraRetry
    ? { authorizeRetry: (cause) => ctx.authorizeInfraRetry!(identity ? verificationIdentityKey(identity) : "",
      cause === "infra" ? "infrastructure" : "host-starved") }
    : {};

  const runBattery = async (commands: Record<string, string>, selected?: string[], gates: readonly GateName[] = toolGates): Promise<void> => {
    if (!gates.length) return;
    // T4 (OBS-265): one command at a time, stopping at the first red — a failed build no longer buys
    // any later tool before anyone reads its verdict.
    for (const g of gates) {
      await emitStart(g);
      const cmd = commands[g];
      let r: GateResult | undefined;
      let cached = false;
      let identity: VerificationIdentity | undefined;
      if (cmd !== undefined) {
        identity = await computeVerificationIdentity({
          worktree: ctx.worktree,
          gate: g,
          scope: ctx.verificationScope,
          command: cmd,
          baseline: ctx.baseline,
          selectedSet: g === "test" ? selected : undefined,
          capacity: resolvedCapacity(),
        });
        const hit = verdictStore.get(identity);
        if (hit) classifySignalOnlyTest(hit, true); // Older entries predate classification at the write seam.
        if (hit && identity && !isInfraResult(hit) && (hit.pass || (ctx.verificationScope ?? "battery") === "battery")
            && !(await discardCachedRed(g, hit))) {
          // RE-PROOF: a cached FULL green is reused only after the current manifest listing, then cleanliness
          // and the identity sampled after it, agree with it. Stale, it is never relabelled: the fresh job
          // measures under the identity sampled now.
          if (g !== "test" || selected !== undefined || !hit.pass || await answersNow(identity, hit, false)) {
            r = formatReusedRow(hit, identity);
            cached = true;
            if (g === "build") await noBuild("reused-result", "verdict reused; no fresh build ran in this invocation");
            await noteReuse(g, r, identity);
          } else identity = await fullTestIdentity();
        }
      }
      if (!r) {
        if (g === "build" && !cmd) await noBuild("skipped", "no build command detected");
        try {
          // VL-1: a detected vitest test command is judged by its own invocation-bound report — the
          // stdout-count/file-count path (compareToBaseline's fileCountDeficit) never runs for it. Any
          // other scripted test command keeps today's exit-code contract byte-identically.
          const useManifest = g === "test" && commands.test !== undefined && isVitestTestCommand(commands.test, ctx.worktree);
          r = useManifest
            ? await measure(g, () => runVitestManifestGate(ctx.worktree, commands.test!, ctx.baseline, selected, ctx.artifactDir, { ...retryOptions(identity), evidence, ...(selected ? { retryBaseCommand: ctx.commands.test } : {}) }))
            : (await measure(g, () => compareToBaseline(ctx.worktree, commands, ctx.baseline, [g], { ...retryOptions(identity), evidence, ...(g === "build" ? { onReceipt: buildReceipt, taskBuildAttribution: beginBuild } : {}), ...(g === "test" && selected ? { selected } : {}) })))[0];
        } finally { await receiptNotes; }
      }
      // the screen's interval IS the test gate's first interval, so the split needs no second clock
      if (g === "test" && selected) selectedDurationMs = spans.get("test")?.durationMs ?? 0;
      // The pre-battery check proves the tree clean ONCE; a command that exits 0 having rewritten a
      // tracked file makes it dirty again, and every gate after it — including the next shell gate,
      // which would then run against bytes HEAD does not hold — inherits that. So re-check after each
      // command, the last one included, and fail the gate whose command did it. (A red command needs
      // no check: it already ends the round, and its own output is the truer verdict.)
      if (!cached && r!.pass && commands[g]) {
        const dirt = await dirtyWorktree();
        if (dirt) {
          await record({ ...await dirtyRefusal(g, dirt, commands[g]!), evidenceReceipt: r!.evidenceReceipt, evidenceReceipts: r!.evidenceReceipts });
          return;
        }
      }
      if (r) classifySignalOnlyTest(r);
      // Every round's in-battery full job is its first — test-only verification included: stale, it is
      // published unverdicted and buys one fresh merge-candidate job below, whose own stale green fails closed.
      if (g === "test" && !selected && cmd !== undefined && !cached && r!.pass && !(await answersNow(identity, r!, true))) {
        r = staleProof(r!, true);
        rerunFull = true;
      }
      if (!cached && identity && r && !isInfraResult(r)) {
        verdictStore.set(identity, { ...r, meta: { ...r.meta, source: "gate", runDir: ctx.artifactDir } });
      }
      if (g === "test" && selected) {
        // v2.6.7 T1: the attributed diagnostic. A behavioral red IS the round's verdict and ends it
        // before semantics. An infrastructure red is no verdict either way: it is published UNVERDICTED
        // (skipped — the journal row keeps its infra evidence and receipts but no `pass`, so the review
        // round counter never reads it as a decisive test red) and never enters the round's results, so
        // it can neither end the round nor become green — semantics and the full job decide. A green is
        // published as its own selected row; the full job afterwards replaces it in the results.
        const inconclusive = !r!.pass && isInfraResult(r!);
        const screened = withTelemetry({ ...r!, meta: { ...r!.meta, selectedTests: selected, ...(inconclusive ? { skipped: true } : {}) } });
        if (!inconclusive) results.push(screened);
        await ctx.onGate?.({ phase: "end", gate: "test", result: screened });
        // The diagnostic's interval now lives on its own row; the full job measures from zero.
        spans.delete("test");
        loadSamples.delete("test");
        selectedDurationMs = undefined;
      } else {
        await record(r!);
      }
      if (failed()) return;
    }
  };

  // The two sub-second git checks, as pure verdicts: no journal, no results push. Both read committed
  // state only (commits ahead of base, `git diff --name-only base..HEAD`), so neither can be moved by
  // anything the battery does to the worktree — which is what lets the screen below trust them early.
  const evidenceResult = async (): Promise<GateResult> => {
    const e = await evidenceGate(ctx.worktree, ctx.baseRef);
    commits = e.commits;
    return { gate: e.gate, pass: e.pass, details: e.details };
  };

  /**
   * v1.87 T5: the allowlist is read ONCE — at entry, before any gate of this round runs — copied out
   * of `ctx.cfg` and frozen. Both halves are the enforcement: the copy means a later write to the
   * daemon's live config object cannot reach the gate mid-round (the screen at line ~296 and the
   * canonical scope gate below are two separate reads of it), and the freeze means nothing this file
   * hands to `scopeGate` can be widened in flight either. Nothing anywhere writes it back.
   *
   * The boundary, stated rather than implied: this binds the allowlist for the lifetime of a round,
   * which is the largest unit this function owns. It cannot speak for a `tickmarkr resume`, which is
   * a new process whose config the daemon resolves afresh (src/run/daemon.ts) — binding an allowlist
   * across a restart would have to live there, is outside this task's file scope, and is claimed
   * neither here nor in the worker prompt. What the prompt does claim is what holds: a WORKER has no
   * way to change this list, mid-round or otherwise.
   */
  const allowDeviations = [...(ctx.cfg.scope?.allowDeviations ?? [])];
  Object.freeze(allowDeviations);

  const scopeResult = (): Promise<GateResult> =>
    scopeGate(ctx.worktree, ctx.baseRef, task.files, ctx.result, allowDeviations,
      ctx.collateral ? { taskId: task.id, predicted: ctx.collateral } : undefined);

  const runGate = async (gate: GateName, compute: () => Promise<GateResult>): Promise<void> => {
    await emitStart(gate);
    await record(await measure(gate, compute));
  };

  /**
   * T4 (OBS-265): the deterministic git checks run BEFORE the battery, as a screen — they answer
   * "is this diff worth starting a ~3.7m tool battery for?" before the first command runs. A red
   * screen IS the round's verdict: what it produced is journaled (in the order it ran) and the round
   * ends there, so a drive-by out-of-scope edit costs <1s instead of the whole battery.
   *
   * A green screen changes nothing downstream. The returned record stays in GATE_NAMES order while
   * the event stream reports the order gates actually ran; resume's GATE_NAMES walk over satisfied
   * records therefore keeps declaration order without making the live stream lie about execution.
   *
   * ponytail: the price of that is re-reading two git checks (~40ms) in their canonical positions
   * rather than teaching every consumer of the gate stream a second order. Both reads see the same
   * commits — the battery never moves HEAD — so the screen cannot disagree with the gate it screens
   * for. Charge it only when there IS a battery command to protect.
   */
  const screenBlocks = async (): Promise<boolean> => {
    if (!toolGates.some((g) => ctx.commands[g]) && !(enabled("test") && ctx.commands.test)) return false;
    const screened: GateResult[] = [];
    for (const [gate, compute] of [["evidence", evidenceResult], ["scope", scopeResult]] as const) {
      if (!enabled(gate)) continue;
      screened.push(await measure(gate, compute));
      if (screened[screened.length - 1]!.pass) continue;
      for (const r of screened) {
        await emitStart(r.gate as GateName);
        await record(r);
      }
      return true;
    }
    return false;
  };

  // acceptance judge — LLM spend, so everything deterministic has already passed when this runs
  const runAcceptance = async (): Promise<{ result: GateResult; invocations: JudgeInvocationEvidence[] }> => {
    // v1.87 T2: the judge is a configured seat like any other — check it against the operator's
    // policy BEFORE spending a dispatch on it. disallowedBy carries the whole deny grammar (adapter,
    // model, or adapter:model), so a model-scoped deny cannot slip past an adapter-id-only read.
    // OBS-1186: under the exact cached identity of that channel, as compile, doctor and route read it.
    const judgeSeat = observedSeat(ctx.health, ctx.cfg.judge.adapter, ctx.cfg.judge.model);
    const judgeDenied = disallowedBy(judgeSeat, ctx.cfg.routing, "judge");
    if (judgeDenied) {
      return {
        result: {
          gate: "acceptance",
          pass: false,
          details: `judge ${channelKey({ adapter: ctx.cfg.judge.adapter, model: ctx.cfg.judge.model })} is disallowed by routing.${judgeDenied.by} (${judgeDenied.entry}) — remove the ${judgeDenied.by} entry or re-point cfg.judge at an allowed channel`,
          meta: { judgeDisallowed: { by: judgeDenied.by, entry: judgeDenied.entry } },
        },
        invocations: [],
      };
    }
    const judgeAdapter = getAdapter(ctx.cfg.judge.adapter, ctx.adapters);
    const jvia = via
      ? { driver: via.driver, keep: via.keep, onSlot: via.onSlot, name: via.nameFor("judge", judgeAdapter.id), label: via.labelFor("judge") }
      : undefined;
    // v1.19 (T2): testCmd threads the detected test runner to the gate so named-test oracles run
    // deterministically (filtered via -t) before any LLM judge dispatch.
    const invocations: JudgeInvocationEvidence[] = [];
    // v2.0 T2 (OBS-554): one entry per JUDGE DISPATCH — primary and the GATE-09 retry alike. The gate's
    // own durationMs is the pair's envelope and cannot answer what the parked ceiling recalibration
    // asks ("how long does ONE healthy judge invocation take?"), so the invocations are kept apart.
    // Separate from `invocations` above deliberately: that array is transcript evidence and records
    // one entry per CAPTURED OUTPUT, so a dispatch that produced none contributes nothing to it.
    const invocationSpans: LlmDispatchSpan[] = [];
    const invokeJudge = async (
      adapter: WorkerAdapter,
      model: string,
      via: typeof jvia,
      effort: Effort | undefined,
    ): Promise<GateResult> => {
      const captured = await captureLlmDispatches([adapter], ([instrumented]) =>
        acceptanceGate(
          task,
          ctx.worktree,
          ctx.baseRef,
          { adapter: instrumented!, model, effort },
          via,
          { testCmd: ctx.commands.test, diffCap: ctx.cfg.gates.diffCap },
        ));
      // The instrumented adapter is reached only by runLlm. Deterministic oracles and diff-cap exits
      // never call headlessCommand, so they produce no clock and cannot manufacture an invocation.
      invocationSpans.push(...captured.invocations);
      const unparseable = captured.value.meta?.unparseable === true;
      // acceptanceGate has exactly one runLlm call. Keep the map shape so a future deterministic early
      // return (zero outputs) stays telemetry-free instead of manufacturing a judge invocation.
      for (const [index, output] of captured.outputs.entries()) {
        const span = captured.invocations[index];
        if (!span) continue;
        invocations.push({
          taskId: task.id,
          channel: span.channel,
          outcome: unparseable ? "failed" : "done",
          judgeOutcome: unparseable ? "unparseable" : "parseable",
          durationMs: span.durationMs,
          ...(unparseable ? { transcript: output } : {}),
        });
      }
      return captured.value;
    };
    const judgePool = () => (ctx.judgeChannels ?? []).filter((c) => disallowedBy(c, ctx.cfg.routing, "judge") === null);
    const rankJudges = (pool: BillingChannel[]) => [...pool]
      .sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier] || marginalCostRank(x) - marginalCostRank(y));
    // OBS-1151 (+add.1): the fresh judgment always stands on its own reading — a prior PASS is never
    // reused. Only a criterion that REVERSES the newest prior ruling on the same subject key over
    // identical cited blobs needs a second, distinct judge; agreement stands (a sound FAIL included),
    // and a split, no distinct eligible seat or an unreadable adjudication parks for the operator.
    const adjudicate = async (fresh: GateResult): Promise<GateResult> => {
      const primary = String(fresh.meta?.judge ?? channelKey({ adapter: ctx.cfg.judge.adapter, model: ctx.cfg.judge.model }));
      const head = await shGit("git rev-parse HEAD", ctx.worktree);
      const commit = head.code === 0 ? head.stdout.trim() : "";
      const criteria = (fresh.meta!.judgment as JudgedCriterion[]).map((c) => ({
        id: c.id, key: judgmentSubjectKey(task, c.criterion, ctx.operatorContext), met: c.met, paths: c.paths,
      }));
      const record: PriorJudgment = { commit, judge: primary, criteria };
      const stamped: GateResult = { ...fresh, meta: { ...fresh.meta, judgment: record } };
      if (!commit || !ctx.priorJudgments?.length) return commit ? stamped : { ...fresh, meta: { ...fresh.meta, judgment: undefined } };
      const disputed = await judgeContradictions(ctx.worktree, commit, criteria, ctx.priorJudgments);
      if (!disputed.length) return stamped;
      await ctx.onGate?.({ phase: "note", gate: "acceptance", name: "judge-disagreement", payload: { primary, commit, disputed } });
      const park = (why: string, adjudicator?: string): GateResult => ({
        gate: "acceptance", pass: false,
        details: `judge disagreement on ${disputed.map((d) => d.id).join(", ")}: ${primary} reverses an earlier ruling over identical cited blobs (${[...new Set(disputed.flatMap((d) => d.paths))].join(", ")}) — ${why}; parked for an operator ruling, no worker charge`,
        meta: { classification: "infra", infra: true, retryable: false, cause: "judge-disagreement", judge: primary,
          judgeDisagreement: { primary, ...(adjudicator ? { adjudicator } : {}), disputed, outcome: why } },
      });
      const primaryAdapter = primary.slice(0, primary.indexOf(":"));
      // One DISTINCT seat: never the primary channel, a different adapter when the pool has one.
      const pool = judgePool().filter((c) => channelKey(c) !== primary);
      const seat = rankJudges(pool.filter((c) => c.adapter !== primaryAdapter))[0] ?? rankJudges(pool)[0];
      if (!seat) return park("no distinct eligible judge is available");
      const adjudicator = channelKey(seat);
      const seatAdapter = getAdapter(seat.adapter, ctx.adapters);
      const seatVia = via
        ? { driver: via.driver, keep: via.keep, onSlot: via.onSlot, name: via.nameFor("judge", seatAdapter.id) + "-r2", label: via.labelFor("judge") }
        : undefined;
      const second = await invokeJudge(seatAdapter, seat.model, seatVia, configuredEffort(ctx.cfg, seat));
      const rulings = Array.isArray(second.meta?.judgment) ? second.meta.judgment as JudgedCriterion[] : undefined;
      // A citation-less ruling cannot be compared, so it confirms nothing (invented evidence is already unparseable,
      // and an internally inconsistent verdict carries no judgment rows at all).
      if (second.meta?.unparseable === true || !rulings) return park("the adjudicating judge returned no readable verdict", adjudicator);
      const agreed = disputed.every((d) => rulings.some((r) => r.id === d.id && r.met === d.met && r.paths.length > 0));
      if (!agreed) return park("the adjudicating judge split from the fresh ruling", adjudicator);
      return { ...stamped, meta: { ...stamped.meta, adjudication: { primary, adjudicator, criteria: disputed.map((d) => d.id), agreed: true } } };
    };
    // OBS-1182: every judge seat launches at its OWN configured effort, never the worker's.
    let a = await invokeJudge(judgeAdapter, ctx.cfg.judge.model, jvia, configuredEffort(ctx.cfg, ctx.cfg.judge));
    // GATE-09: an unparseable judge verdict retries the JUDGE exactly once on a failover channel — never
    // the worker (run-20260711-185020 P43-03 L70-72 billed a judge flake as a worker attempt). The flaked
    // first verdict NEVER enters results (no false gate-result journal event, no operator notify, no stale
    // failed() short-circuit — research Pitfall 5). Detection is meta-only (D-03), never string-matching
    // details. The v1.1 badReviewers precedent's TIMING can't transfer: its failover lands on the NEXT
    // worker attempt — exactly what this fix forbids; only its meta-carries-channel pattern is mirrored.
    // Straight-line single `if` — NO loop/counter/knob: exactly-once by construction (a knob is a
    // fail-closed weakening vector); a second garbage verdict fails the gate closed exactly as today.
    // T6: exclusion mirrors consult reroute semantics — the flaked channel's whole adapter is banned, not
    // just its exact channel key, so an outage window cannot re-select the vendor being routed around.
    // If no other adapter is live, the exclusion degrades to a channel-level reroute within the same
    // adapter so a single-adapter fleet still retries (matching the daemon's unknown-excludeAdapter
    // degradation path).
    if (!cancelled && a.meta?.unparseable === true && typeof a.meta.judge === "string") {
      const flakedKey = a.meta.judge;
      const flakedAdapter = flakedKey.slice(0, flakedKey.indexOf(":"));
      const pick = (pool: BillingChannel[]) => pool
        // pickReviewer's sort (review.ts:37): TIER_RANK desc, marginalCostRank asc — proven ordering; both
        // symbols already imported by a sibling gate file.
        .sort((x, y) => TIER_RANK[y.tier] - TIER_RANK[x.tier] || marginalCostRank(x) - marginalCostRank(y))[0];
      // v1.87 T2: the failover seat obeys the same policy the primary judge just passed — a denied
      // channel is refused here too, never reached by falling through the exclusion arms below.
      const judgePool = (ctx.judgeChannels ?? []).filter((c) => disallowedBy(c, ctx.cfg.routing, "judge") === null);
      const crossAdapter = pick(judgePool.filter((c) => c.adapter !== flakedAdapter));
      const sameAdapter = pick(judgePool.filter((c) => c.adapter === flakedAdapter && channelKey(c) !== flakedKey));
      // Prefer a different adapter; if the fleet only has one adapter, retry on a different channel of
      // that adapter; if the fleet has only one channel, fall back to the original judge config.
      const retry = crossAdapter ?? sameAdapter ?? judgeSeat;
      const retryAdapter = getAdapter(retry.adapter, ctx.adapters);
      const retryJvia = via
        // unconditional -r1 suffix: under keepPanes:forever a same-channel retry cannot collide with the
        // still-open first pane (herdr agent_name_taken regression, research Pitfall 4)
        ? { driver: via.driver, keep: via.keep, onSlot: via.onSlot, name: via.nameFor("judge", retryAdapter.id) + "-r1", label: via.labelFor("judge") }
        : undefined;
      // the retry IS a second acceptanceGate call: one code path, one parser, zero new parse leniency.
      a = await invokeJudge(retryAdapter, retry.model, retryJvia, configuredEffort(ctx.cfg, retry));
      a = { ...a, meta: { ...a.meta, judgeRetry: { flaked: flakedKey, retried: channelKey({ adapter: retry.adapter, model: retry.model }) } } };
    }
    // OBS-1168(b): the re-routed seat could not launch either — no seat produced a verdict, so this is
    // an infra park over whatever the deterministic gates proved, never a charge against the worker.
    if (a.meta?.cause === "seat-launch-failed") a = { ...a, meta: { ...a.meta, classification: "infra", infra: true, retryable: false } };
    else if (!cancelled && Array.isArray(a.meta?.judgment)) a = await adjudicate(a);
    // No dispatch, no key: a deterministic-oracle round writes no `invocations` field rather than an
    // empty array a reader could mistake for "measured, and it cost nothing".
    return { result: invocationSpans.length ? { ...a, meta: { ...a.meta, invocations: invocationSpans } } : a, invocations };
  };

  // cross-vendor review
  const runReview = async (): Promise<GateResult> => {
    // v2.0 T2: per-dispatch spans, exactly as the judge keeps them. A round that re-asks a second
    // seat spends two invocations, and one blended span cannot tell a slow reviewer from two.
    // A pick that found NO eligible seat dispatched nothing, so it contributes no invocation.
    const invocations: LlmDispatchSpan[] = [];
    const retiredNow = () => [...(ctx.reviewNoVerdicts ?? [])].filter(([, causes]) => causes.length >= 2).map(([seat]) => seat);
    // v2.6.8 T1: retirement is live through the LAUNCH, not only the pick. reviewGate awaits its diff read
    // after it picks, and a pane seat awaits its slot, so another task can retire the picked seat inside
    // either await. The seat is named when its command is built and checked against the live tally there and
    // again as its pane is bound (onSlot runs inside llm.ts's launch guard, which closes that pane unrun), and
    // a driver that still awaits lookups before it submits the terminal (Orca's runtime probe and worktree
    // lookup) re-reads it at that submission (withLaunchGuard): a retired seat is never launched, and dispatch
    // picks again under the live exclusions (atPick) — the next eligible seat, or none. Bounded: each
    // withdrawal is a seat newly retired, and the pool is finite.
    let launching: { seat?: string; withdrawn?: boolean } = {};
    const refuseRetired = () => {
      if (launching.seat === undefined || !retiredNow().includes(launching.seat)) return;
      launching.withdrawn = true;
      throw new SeatLaunchError(launching.seat, new Error("retired for the run before it launched"));
    };
    const reviewVia: GateVia | undefined = via && { ...via, onSlot: (slot) => { via.onSlot?.(slot); refuseRetired(); } };
    const guarded = (adapter: WorkerAdapter): WorkerAdapter => new Proxy(adapter, {
      get(target, property) {
        if (property === "headlessCommand") {
          return (promptFile: string, model: string, effort?: Effort): string => {
            launching.seat = channelKey({ adapter: target.id, model });
            refuseRetired();
            return target.headlessCommand(promptFile, model, effort);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Dispatch is PROVEN, never inferred: captureLlmOutput records one output per runLlm return, so an
    // empty capture means reviewGate returned before asking anyone — a policy skip, a pre-dispatch diff
    // cap, or no eligible seat. Reading `noEligibleReviewer` alone missed the first two and invented
    // an "unknown" span for each.
    const dispatch = async (run: (adapters: WorkerAdapter[]) => Promise<GateResult>): Promise<GateResult> => {
      const withdrawn: string[] = [];
      let picked: GateResult;
      for (;;) {
        launching = {};
        const captured = await withLaunchGuard(refuseRetired, () => captureLlmDispatches(ctx.adapters.map(guarded), run));
        invocations.push(...captured.invocations);
        picked = captured.value;
        if (cancelled || !launching.withdrawn) break;
        withdrawn.push(launching.seat!);
      }
      const rv = withdrawn.length === 0 ? picked : { ...picked, details: `${withdrawn.map((seat) =>
        `review dispatch withdrawn: ${seat} was retired for the run (two real no-verdicts) after it was picked, before it launched; picked again`).join("\n")}\n${picked.details}` };
      if (cancelled) return rv; // a cancelled seat's non-answer says nothing about the seat
      if (rv.meta?.noVerdict === true || rv.meta?.unparseable === true) {
        await ctx.onGate?.({ phase: "note", gate: "review", name: "review-no-verdict", payload: { ...rv.meta }, result: rv });
        // v2.6.8 T1: a seat that never LAUNCHED (any launchCause, checkout-proof-timeout or none) said
        // nothing about the work or about itself: no run-scoped strike and no soft demotion. It gets one
        // bounded same-seat launch retry below and is excluded for the rest of THIS round only.
        if (typeof rv.meta.reviewer === "string" && rv.meta.cause !== "seat-launch-failed") {
          const reviewer = rv.meta.reviewer;
          const cause = String(rv.meta.cause);
          // OBS-1025 add.2: the run-scoped tally of REAL no-verdicts (silent, truncated, closure-mismatch,
          // no nonce …); two of them retire the seat for the run — a hard exclusion, never a soft ranking.
          const causes = rv.meta.noVerdict === true && ctx.reviewNoVerdicts
            ? [...(ctx.reviewNoVerdicts.get(reviewer) ?? []), cause] : undefined;
          if (causes) ctx.reviewNoVerdicts!.set(reviewer, causes);
          // OBS-1039: a seat below the byte floor at the beat is silent — demoted like a zero-byte seat.
          const silent = rv.meta.seatAuthoredBytes === 0 || cause === "silent" || cause === "launch-never-started";
          const twice = (causes?.length ?? 0) >= 2;
          if ((silent || twice) && !ctx.demotedReviewers?.has(reviewer)) {
            ctx.demotedReviewers?.add(reviewer);
            await ctx.onGate?.({ phase: "note", gate: "review", name: "review-pool-demotion",
              payload: { reviewer, cause, seatAuthoredBytes: rv.meta.seatAuthoredBytes ?? 0, ...(twice ? { causes } : {}) }, result: rv });
          }
        }
      }
      return rv;
    };
    // OBS-1025 add.2: seats with two REAL no-verdicts this run (launch failures never strike) are RETIRED:
    // out of every pick below for the rest of the run, and a resumed daemon re-seeds the tally from the
    // journal. demotedReviewers is only a soft preference, live or replayed on resume — it ranks a seat
    // last and never excludes or retires it; history or prefer can never resurrect a retired seat.
    // The tally is shared across the run's tasks, so it is read LIVE at every pick — after every awaited
    // notification and inside reviewGate after its promotion reads (atPick), since another task can retire a
    // seat inside any await: a seat retired while this round's dispatch, note or read is pending is out of
    // the initial pick, the launch retry, the re-emission and the re-route alike — and one retired after its
    // pick is refused at launch (dispatch, above).
    const retired = retiredNow();
    // reviewGate awaits its promotion path reads BEFORE it picks, and another task can retire a seat inside
    // that await too. So the exclusions every reviewGate call is handed are a live view: each read — the pick's
    // included — answers from `fixed` plus the tally as it stands at that read, never a copy taken before.
    // ponytail: a read-through Proxy because review.ts takes a plain list; a live-exclusion parameter there retires it.
    const atPick = (fixed: readonly string[]): string[] => new Proxy<string[]>([], {
      get: (_target, prop) => {
        const now = [...new Set([...fixed, ...retiredNow()])];
        const value: unknown = Reflect.get(now, prop);
        return typeof value === "function" ? value.bind(now) : value;
      },
    });
    // RF-1: THIS task's prior reviewers — earlier rounds' seats plus the seats that produced garbage for
    // it (excludeReviewers names only dispatched seats). Kept apart from the eligibility exclusions the
    // retry below adds for a flaked seat's whole adapter: those sibling channels never reviewed.
    const priorReviewers = [...(ctx.priorReviewers ?? []), ...(ctx.excludeReviewers ?? [])];
    const carriedAuthors = ctx.carriedAuthors ?? [];
    let exclusions = [...(ctx.excludeReviewers ?? []), ...retired];
    let rv = await dispatch((adapters) => reviewGate(task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, adapters, ctx.cfg, reviewVia, atPick(exclusions), ctx.artifactDir, ctx.reviewHistory, ctx.demotedReviewers, ctx.carriedFindings, priorReviewers, carriedAuthors, ctx.operatorContext));
    // OBS-193/574: an unparseable review verdict retries the REVIEW, preferring a different adapter. Only
    // a single-adapter eligible pool may fall back to another channel on the flaked adapter. The flaked
    // verdict never enters results; an exhausted pool preserves its cause.
    // OBS-1013 add.3: the re-route LOOPS while seats return no verdict — a closure mismatch or a silent
    // seat is re-routed to a third seat of another vendor, and only an exhausted pool ends the round,
    // as a terminal infra result that keeps the carried materials. Never a worker.
    let retryPrior = [...priorReviewers];
    const routes: string[] = [];
    let hop = 0;
    // OBS-1196: seats already re-asked after a malformed verdict — once per seat, so never unbounded.
    const reemitted = new Set<string>();
    // v2.6.8 T1: seats already relaunched after a launch failure — once per seat per candidate (the
    // daemon replays the spent ones), so a launch retry is bounded and never a second malformed allowance.
    const launchRetried = new Set(ctx.launchRetried ?? []);
    while (!cancelled && (rv.meta?.unparseable === true || rv.meta?.noVerdict === true) && typeof rv.meta.reviewer === "string") {
      hop++;
      const flaked = rv.meta.reviewer;
      const retryVia = reviewVia
        ? { ...reviewVia, nameFor: (role: "judge" | "review", adapter: string) => reviewVia.nameFor(role, adapter) + `-r${hop}` }
        : undefined;
      // v2.6.8 T1: bounded same-seat launch retry. A seat that could not launch is launched ONCE more
      // (fresh launch identity, fresh nonce, same subject) before any other seat is picked, journaled as
      // the review-infra-retry naming that seat; its verdict decides. A second refusal re-routes below. A
      // seat two real no-verdicts retired — before the note, while it was awaited, or during the relaunch's
      // own promotion read (atPick) — is never relaunched: the withdrawn retry is said in the round's
      // details, and the re-route below excludes the seat.
      if (rv.meta.cause === "seat-launch-failed" && !launchRetried.has(flaked) && !retiredNow().includes(flaked)) {
        launchRetried.add(flaked);
        await ctx.onGate?.({ phase: "note", gate: "review", name: "review-infra-retry", payload: { reviewer: flaked, cause: "seat-launch-failed",
          sameSeat: true, ...(rv.meta.launchCause ? { launchCause: rv.meta.launchCause } : {}) }, result: rv });
        const others = ctx.channels.map(channelKey).filter((key) => key !== flaked);
        const again = retiredNow().includes(flaked) ? undefined : await dispatch((adapters) => reviewGate(
          task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, adapters, ctx.cfg,
          retryVia, atPick(others), ctx.artifactDir, ctx.reviewHistory, ctx.demotedReviewers, ctx.carriedFindings, retryPrior, carriedAuthors, ctx.operatorContext,
        ));
        if (again && again.meta?.noEligibleReviewer !== true) {
          // The relaunch that completes a malformed verdict's re-emission (the re-emission was what failed to
          // launch) publishes that delivery, so the seat is a delivery flake again, not a bad reviewer.
          const reemission = (rv.meta.reviewReemission as { reviewer?: unknown } | undefined)?.reviewer === flaked;
          if (reemission && again.meta?.unparseable !== true && again.meta?.noVerdict !== true) {
            await ctx.onGate?.({ phase: "note", gate: "review", name: "review-reemission", payload: { reviewer: flaked, cause: "malformed-verdict",
              delivered: true, launchRetry: true }, result: again });
          }
          routes.push(`review launch retry (same seat, fresh launch): ${flaked} failed to launch; launched once more`);
          rv = { ...again, details: `${routes.join("\n")}\n${again.details}`, meta: { ...again.meta, reviewLaunchRetry: { reviewer: flaked } } };
          continue;
        }
        if (retiredNow().includes(flaked)) {
          routes.push(`review launch retry withdrawn: ${flaked} was retired for the run (two real no-verdicts) while its relaunch was pending`);
        }
      }
      // OBS-1196: a malformed (unparseable) verdict is a delivery defect of THIS seat, not a reason to drop it. Ask the
      // same seat once more on the same subject; reviewGate mints a fresh nonce, so only a new, whole,
      // nonce-bound verdict can answer — the malformed bytes are never salvaged into one.
      if (rv.meta.cause === "malformed-verdict" && rv.meta.closureInvalid !== true && !reemitted.has(flaked) && !retiredNow().includes(flaked)) {
        reemitted.add(flaked);
        const others = ctx.channels.map(channelKey).filter((key) => key !== flaked);
        const again = await dispatch((adapters) => reviewGate(
          task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, adapters, ctx.cfg,
          retryVia, atPick(others), ctx.artifactDir, ctx.reviewHistory, ctx.demotedReviewers, ctx.carriedFindings, retryPrior, carriedAuthors, ctx.operatorContext,
        ));
        if (again.meta?.noEligibleReviewer !== true) {
          await ctx.onGate?.({ phase: "note", gate: "review", name: "review-reemission", payload: { reviewer: flaked, cause: "malformed-verdict",
            delivered: again.meta?.unparseable !== true && again.meta?.noVerdict !== true }, result: again });
          routes.push(`review re-emission (same seat, fresh nonce): ${flaked} produced a malformed verdict; asked once more`);
          rv = { ...again, details: `${routes.join("\n")}\n${again.details}`, meta: { ...again.meta, reviewReemission: { reviewer: flaked } } };
          continue;
        }
        if (retiredNow().includes(flaked)) {
          routes.push(`review re-emission withdrawn: ${flaked} was retired for the run (two real no-verdicts) while its re-emission was pending`);
        }
      }
      const emptyOutput = rv.meta.cause === "empty-output";
      if (emptyOutput) {
        await ctx.onGate?.({
          phase: "note", gate: "review", name: "reviewer-empty-output",
          payload: { reviewer: flaked, bytes: typeof rv.meta.bytes === "number" ? rv.meta.bytes : 0 },
          result: { ...rv, meta: { ...rv.meta, skipped: true } },
        });
      }
      const flakedAdapter = flaked.slice(0, flaked.indexOf(":"));
      const adapterExclusions = ctx.channels.filter((c) => c.adapter === flakedAdapter).map(channelKey);
      // RF-1: the retry filters by the floor reviewGate resolves — author tier, task floor, review.floor
      // and the prior reviewers' tiers, the flaked seat's own included, so a retry never drops a tier.
      retryPrior = [...retryPrior, flaked];
      const retryFloor = gateReviewerFloor(task, ctx.cfg, ctx.author, ctx.channels, retryPrior).floor;
      exclusions = [...new Set([...exclusions, ...retiredNow()])];
      const crossAdapter = pickReviewer(
        ctx.author, ctx.channels, [...exclusions, ...adapterExclusions],
        ctx.cfg.review.prefer ?? [], retryFloor, undefined, undefined, undefined, carriedAuthorVendors(ctx.channels, carriedAuthors),
      );
      const exclusion = crossAdapter ? "adapter" : "channel";
      exclusions = [...exclusions, ...(crossAdapter ? adapterExclusions : [flaked])];
      const second = await dispatch((adapters) => reviewGate(
        task, ctx.worktree, ctx.baseRef, ctx.author, ctx.channels, adapters, ctx.cfg,
        retryVia, atPick(exclusions), ctx.artifactDir, ctx.reviewHistory, ctx.demotedReviewers, ctx.carriedFindings, retryPrior, carriedAuthors, ctx.operatorContext,
      ));
      if (second.meta?.noEligibleReviewer !== true) {
        const retried = typeof second.meta?.reviewer === "string" ? second.meta.reviewer : "none";
        const route = exclusion === "adapter"
          ? `different-adapter retry; excluded flaked adapter ${flakedAdapter}`
          : `same-adapter fallback; excluded flaked channel ${flaked}`;
        const produced = emptyOutput ? "EMPTY output" : rv.meta.cause === "closure-mismatch" ? "a verdict closing no carried fingerprint"
          : rv.meta.cause === "seat-launch-failed" ? "no verdict (it failed to launch)" : "no parseable verdict";
        // `details` is lifted onto the journal's gate-result row; meta.reviewRetry is not. Keep every
        // re-route visible in the result text a reader actually opens, including on a red retry.
        routes.push(`review re-route (${route}): ${flaked} produced ${produced}; replaced by ${retried}`);
        rv = {
          ...second,
          details: `${routes.join("\n")}\n${second.details}`,
          meta: { ...second.meta, reviewRetry: { flaked, retried, exclusion } },
        };
      } else {
        // Preserve the original no-answer cause when no replacement exists, but name the resolved
        // floor that correctly refused a lower-tier fallback — in details AND in the row's meta.
        const { reviewerFloor, reviewerFloorCause } = second.meta ?? {};
        rv = { ...rv, details: `${rv.details}\nreview re-route refused: ${second.details}`, meta: { ...rv.meta, reviewerFloor, reviewerFloorCause } };
        break;
      }
    }
    if (rv.meta?.noVerdict === true
        || (rv.meta?.unparseable === true && rv.meta.closureInvalid !== true && typeof rv.meta.reviewer === "string")) {
      // Terminal: every eligible seat returned no verdict. The carried materials stay open — an infra
      // row is not a passing review — and the sibling judge result is untouched beside it.
      // OBS-1196: an exhausted pool of UNDELIVERED (unparseable) verdicts is the same non-verdict: an infra
      // park, never a worker retry. A delivered verdict that breaks the closure protocol keeps its path.
      const carried = (ctx.carriedFindings ?? []).filter((f) => f.class === "review:material").map((f) => f.fingerprint);
      rv = { ...rv, meta: { ...rv.meta, noVerdict: true, classification: "infra", infra: true, carriedFindings: carried } };
    }
    return invocations.length ? { ...rv, meta: { ...rv.meta, invocations } } : rv;
  };

  // v1.87 T5: the refusal is the FIRST thing a round does, whatever that round is configured to run.
  // Guarding only the configured build/test/lint commands left the hole this repairs: the battery is
  // not the only gate that executes shell in this worktree — the acceptance gate runs command and
  // named-test oracles — so a task with NO tool command configured skipped the check entirely and its
  // oracles judged uncommitted state, on a commit whose diff nobody had run. One check at the top, and
  // no shell-executing gate path is reachable on a dirty tree. It lands on the first gate of this
  // round's sequence: the round dies there, exactly as it does on a red command.
  // The check runs BEFORE any gate, so on a clean tree it belongs to no gate: charging every round's
  // first gate for it would inflate the one measurement the parked recalibrations key on. It becomes
  // that gate's interval only on the path where it IS what the gate did — the refusal below.
  const finishEntry = startMeasurement();
  const entryDirt = sequence.length ? await dirtyWorktree() : undefined;
  const entryMeasurement = finishEntry();
  if (entryDirt) {
    addMeasurement(sequence[0]!, entryMeasurement);
    await emitStart(sequence[0]!);
    if (enabled("build")) await noBuild("refused", "dirty worktree; no build start confirmed");
    await record(await dirtyRefusal(sequence[0]!, entryDirt));
    return done();
  }

  if (await screenBlocks()) return done();

  await runBattery(ctx.commands);
  if (failed()) return done();
  if (enabled("evidence")) {
    await runGate("evidence", evidenceResult);
    if (failed()) return done();
  }
  if (enabled("scope")) {
    await runGate("scope", scopeResult);
    if (failed()) return done();
  }
  // The judge and the reviewer, together. Returns true when the round ends here: a red, or a
  // cancelled sibling — a cancelled seat's round never goes on to borrow a test row.
  const runSemantics = async (): Promise<boolean> => {
    // Judge and review are launched TOGETHER (96m of serialization over 5 runs). Enforcement is
    // unchanged — it is still the AND of both, both still fail closed, and neither reads the other's
    // verdict: each gets the same commit and the same brief it always got, and neither promise is
    // reachable from inside the other. Only the waiting is gone.
    const parentAt = Date.now();
    // Both starts are emitted before either gate is launched, so the stream's order is the round's
    // order and not a race between two dispatches. BOTH ARE IN FLIGHT BEFORE EITHER IS AWAITED:
    // whichever adapter is slower no longer decides when the other one runs.
    if (enabled("acceptance")) await emitStart("acceptance", parentAt);
    if (enabled("review")) await emitStart("review", parentAt);
    const judging = enabled("acceptance") ? measure("acceptance", runAcceptance) : undefined;
    const reviewing = enabled("review") ? measure("review", runReview) : undefined;
    // Attach BOTH publication handlers before awaiting either. Dispatch concurrency alone is not
    // enough: an acceptance-first await withholds a completed review behind a slow/hung judge and a
    // process death can lose that already-earned verdict. The returned result is still sorted into
    // GATE_NAMES order by done(); the event stream truthfully records each independent completion.
    // OBS-1168(c): a sibling that throws, or a seatless JUDGE (no seat could launch, so the round can
    // only park infra), cancels the other — its seats are closed — and the round still AWAITS it, with
    // or without an execution policy, so no verdict of a settled round publishes after its engagement.
    // v2.6.7 T1: a seatless REVIEW is recoverable (runReviewRecovery re-asks it alone), so it cancels
    // nothing — acceptance finishes independently and publishes its own result.
    const seatless = (r: GateResult) => r.meta?.cause === "seat-launch-failed" && r.meta?.infra === true;
    let failure: { reason: unknown } | undefined;
    const fail = (reason: unknown) => {
      if (!cancelled) failure ??= { reason };
      cancelSemantic();
    };
    const judged = judging?.then(async (outcome) => {
      if (cancelled) return;
      // D-974: a seatless judge beside an already-settled no-verdict review has no sibling to cancel —
      // acceptance is MISSING proof: its row is owed and the round still buys its full job.
      const missing = seatless(outcome.result) && results.some((r) => r.gate === "review" && r.meta?.noVerdict === true);
      await withJudgeInvocationEvidence(outcome.invocations, () => record(missing
        ? { ...outcome.result, meta: { ...outcome.result.meta, skipped: true, gateOwed: "acceptance" } } : outcome.result));
      if (seatless(outcome.result) && !missing) cancelSemantic();
    }).catch(fail);
    const reviewed = reviewing?.then(async (outcome) => {
      if (cancelled) return;
      await record(outcome);
    }).catch(fail);
    // ponytail: a headless seat has no slot to close; it is awaited to its own timeout, never abandoned.
    await Promise.all([judged, reviewed]);
    await Promise.all(closing);
    if (failure) throw failure.reason;
    executionSignal()?.throwIfAborted();
    return cancelled || failed();
  };

  proofOwed = true;
  const testRuns = enabled("test") && ctx.commands.test !== undefined;
  // v2.6.7 T1 (closed order table): the ONE diagnostic a round may buy before semantics — a concrete
  // attributed behavioral test-red repair (the caller's known failing files) whose diagnostic covers
  // every required failing file plus the conservatively selected tests reaching its diff, admitted only
  // on comparable harness timing with ratio <= 0.15 AND estimate <= 60000 ms. Selection disabled,
  // unsupported attribution, the analyzable-path cap or unknown/over-bound timing skip it: semantics
  // then precede the one full job, never an expensive screen standing in front of them. Test-only
  // verification (no semantic gate) or an explicit full recheck (no selection) keeps its full scope.
  let diagnostic: string[] | undefined;
  let decision: { reason: string; costRatio?: number; estimatedMs?: number } | undefined;
  const required = ctx.requiredRepairTests ?? [];
  if (testRuns && ctx.selectTests === true && required.length && !semantic) decision = { reason: "test-only-verification" };
  else if (testRuns && ctx.selectTests === true && required.length) {
    const safe = required.every((path) => posix.normalize(path) === path && !path.startsWith("../")
      && !path.startsWith("/") && TEST_FILE_RE.test(path) && existsSync(join(ctx.worktree, path)));
    const listed = safe ? await shGit(`git ls-files -z -- ${required.map(shq).join(" ")}`, ctx.worktree) : undefined;
    const tracked = new Set(listed?.stdout.split("\0").filter(Boolean));
    const covering = await coveringTests(ctx.worktree, ctx.baseRef);
    if (!listed || listed.code !== 0 || required.some((path) => !tracked.has(path))) decision = { reason: "required-repair-test-unavailable" };
    else if (!covering.files) decision = { reason: covering.reason! };
    else {
      const files = [...new Set([...covering.files, ...required])].sort();
      // An exact full green already answers the full job; reusing it is the full job, not a screen.
      const id = await fullTestIdentity();
      const hit = verdictStore.get(id);
      if (hit) classifySignalOnlyTest(hit, true);
      if (hit?.pass === true && !isInfraResult(hit) && await answersNow(id, hit, false)) decision = { reason: "full-green-cache" };
      else {
        decision = diagnosticAdmission(ctx.baseline, files);
        if ((decision as DiagnosticAdmission).admitted) diagnostic = files;
      }
    }
  }
  // The recorded reason is the one that actually decided scope: with no decision above, it is the
  // eligibility check that failed. Selection off: the caller's reason is what turned it off (an explicit
  // full recheck, a distrusted history) — unless it names selection itself, which cannot have disabled it.
  if (ctx.selectionReason) selectionDecision = {
    scope: diagnostic ? "selected" : "full",
    reason: decision?.reason ?? (ctx.selectTests !== true
      ? (ctx.selectionReason === "known-failing-files" ? "selection-disabled" : ctx.selectionReason)
      : !required.length ? "no-required-repair-tests" : "test-gate-disabled"),
    requiredFiles: [...required],
    ...(decision?.costRatio !== undefined ? { costRatio: decision.costRatio } : {}),
    ...(decision?.estimatedMs !== undefined ? { estimatedMs: decision.estimatedMs } : {}),
  };
  let diagnosed = false;
  if (diagnostic) {
    await runBattery({ ...ctx.commands, test: testCommandForFiles(ctx.commands.test!, diagnostic) }, diagnostic, ["test"]);
    if (failed()) return done();
    diagnosed = results.some((r) => r.gate === "test");
    // An inconclusive (infrastructure) diagnostic answered nothing: the full job's row says so.
    if (!diagnosed && selectionDecision) selectionDecision = { ...selectionDecision, scope: "full", reason: "diagnostic-inconclusive" };
  }

  if (semantic) {
    // A cancelled round starts no test; done() records its proof OWED (D-974), never a verdict.
    if (await runSemantics()) return done();
    // Subject freshness: the semantic gates ran oracles and vendor CLIs in this worktree. Their dirt is
    // not the committed subject, so no full job measures it and no cached green row answers for it.
    const dirt = testRuns ? await dirtyWorktree() : undefined;
    if (dirt) {
      const at = results.findIndex((r) => r.gate === "test");
      if (at >= 0) results.splice(at, 1);
      await emitStart("test");
      await record(await dirtyRefusal("test", dirt));
      return done();
    }
  }
  if (!diagnosed) {
    await runBattery(ctx.commands, undefined, enabled("test") ? ["test"] : []);
    if (failed()) return done();
  }

  if (rerunFull) {
    // The superseded in-battery row keeps its own interval; the replacement measures from zero.
    spans.delete("test");
    loadSamples.delete("test");
  }

  // The merge-candidate round: every other gate is green, so THIS round is the one that can merge —
  // the full suite runs on the exact gated commit before the pipeline reports green. Nothing merges
  // on a subset (spec: "nothing merges without a complete green suite"). Its verdict replaces the
  // screen's entry in the returned record (one `test` entry), and `fullSuite` says which suite spoke
  // while `selectedTests` keeps what the screen ran. In the stream the diagnostic keeps its own
  // earlier event and this is the second.
  // OBS-635 (answersNow): a diagnosed round's full job is its first, so, like the in-battery job, a stale
  // green buys one fresh job (published unverdicted); a stale last job fails closed. Neither is cached.
  let spare = diagnosed ? 1 : 0;
  while (diagnosed || rerunFull) {
    await emitStart("test");
    // This is the last shell command a round can run — the judge's named-test oracle (acceptance.ts)
    // may have run one before it, and every gate between the battery and here reads commits only, so
    // a clean tree HERE is what makes "the gated commit is the tested tree" true at merge time.
    // VL-1: the merge-candidate's manifest is the FULL set — a full suite whose report lacks one
    // manifest file never reaches the pass branch below, so a selected-only green can never merge.
    let full: GateResult | undefined;
    let cached = false;
    let identity: VerificationIdentity | undefined;
    if (ctx.commands.test !== undefined) {
      identity = await fullTestIdentity();
      const hit = verdictStore.get(identity);
      if (hit) classifySignalOnlyTest(hit, true);
      if (hit && identity && !isInfraResult(hit) && (hit.pass || (ctx.verificationScope ?? "battery") === "battery")
          && !(await discardCachedRed("test", hit))) {
        // RE-PROOF, as in the battery: listing, then cleanliness and identity; stale, a fresh job measures now.
        if (!hit.pass || await answersNow(identity, hit, false)) {
          full = formatReusedRow(hit, identity);
          cached = true;
          await noteReuse("test", full, identity);
        } else identity = await fullTestIdentity();
      }
    }
    if (!full) {
      const fullUsesManifest = ctx.commands.test !== undefined && isVitestTestCommand(ctx.commands.test, ctx.worktree);
      full = fullUsesManifest
        ? await measure("test", () => runVitestManifestGate(ctx.worktree, ctx.commands.test!, ctx.baseline, undefined, ctx.artifactDir, { ...retryOptions(identity), evidence }))
        : (await measure("test", () => compareToBaseline(ctx.worktree, ctx.commands, ctx.baseline, ["test"], { ...retryOptions(identity), evidence })))[0];
    }
    fullDurationMs = spans.get("test") ? spans.get("test")!.durationMs - (selectedDurationMs ?? 0) : 0;
    const dirt = (!cached && full!.pass) ? await dirtyWorktree() : undefined;
    if (full) classifySignalOnlyTest(full);
    const stale = !cached && !dirt && full!.pass && !(await answersNow(identity, full!, false, true));
    if (!cached && identity && full && !dirt && !stale && !isInfraResult(full)) {
      verdictStore.set(identity, { ...full, meta: { ...full.meta, source: "gate", runDir: ctx.artifactDir } });
    }
    const spoke = stale ? staleProof(full!, spare > 0) : full!;
    const merged = withTelemetry(dirt
      ? { ...await dirtyRefusal("test", dirt, ctx.commands.test!), evidenceReceipt: full!.evidenceReceipt, evidenceReceipts: full!.evidenceReceipts }
      : { ...spoke, meta: { ...spoke.meta, fullSuite: true, selectedTests: diagnosed ? diagnostic : undefined } });
    merged.evidenceReceipts = [...(full?.evidenceReceipts ?? [])];
    if (stale && spare-- > 0) {
      await ctx.onGate?.({ phase: "end", gate: "test", result: merged });
      // The superseded job keeps its own interval; the replacement measures from zero.
      spans.delete("test");
      loadSamples.delete("test");
      continue;
    }
    results[results.findIndex((r) => r.gate === "test")] = merged;
    await ctx.onGate?.({ phase: "end", gate: "test", result: merged });
    break;
  }
  return done();
}
