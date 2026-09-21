import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Assignment, type BillingChannel, channelKey, shq, type WorkerAdapter } from "../adapters/types.js";
import {
  criticalPathHits, DEFAULT_DIFF_CAP, DEFAULT_REVIEW_CRITICAL_PATHS, declaredReviewPolicy,
  isReviewLeafPath, raiseReviewPolicy, type ReviewPolicy, REVIEW_VERSION_MIRRORS,
  type TickmarkrConfig, TIER_RANK, type Tier,
} from "../config/config.js";
import { filesGlob } from "../graph/files-glob.js";
import { renderAcceptanceItem, type Task, TIERS } from "../graph/schema.js";
import { getAdapter } from "../adapters/registry.js";
import { shOk } from "../run/git.js";
import { structuredFindings, type StructuredFinding } from "../run/journal.js";
import { redactSecrets } from "../run/redact.js";
import { marginalCostRank } from "../route/router.js";
import { modelProvider } from "../route/preference.js";
import { resolveStateDir } from "./cache.js";
import { appendAnchoredReview, COMPLETION_FAKING_CHECKLIST, extractVerdictJson, generateVerdictNonce, type GateVia, runLlmDetailed, verdictNonceLine } from "./llm.js";
import type { GateResult } from "./types.js";
import { classifyVerdictCause, type VerdictUnparseableCause } from "./verdict-cause.js";
import {
  captureDiffCapFor,
  measureArtifactDiff,
  reviewableLogicDiff,
  type ArtifactDiffMeasurement,
  type ArtifactDiffSection,
} from "./artifact-manifest.js";

export {
  isProtectedEvidence,
  PROTECTED_EVIDENCE_PREFIXES,
  REGENERABLE_CAPTURE_PATHS,
  setAsideReceiptPath,
  setAsideRegenerableCaptures,
} from "./artifact-manifest.js";

export type ReviewSeverity = "material" | "minor";

// v1.70 T5 (review-convergence): one classified finding. Only `material` findings block approval;
// `minor` findings never block. `defer` is the reviewer's channel for a concern it saw but chose not
// to block on — a deferred finding never blocks and MUST carry a `rationale`, which is recorded in the
// gate details rather than silently dropped.
export interface ReviewFinding {
  note: string;
  severity: ReviewSeverity;
  defer?: boolean;
  rationale?: string;
}

// `approve`/`issues` is the legacy flat shape (every issue blocks). `findings` is the classified shape;
// a verdict carrying it is decided by severity and the advisory `approve` flag is ignored for the gate.
export interface ReviewVerdict {
  approve?: boolean;
  resolved?: string[];
  reraised?: string[];
  issues?: string[];
  findings?: ReviewFinding[];
  comments?: Array<{ path: string; line: number; body: string }>;
}

interface ReviewDecision { pass: boolean; headline: string; lines: string[] }

// legacy flat `issues` shape — every issue blocks; the approve flag must agree with the list.
function classifyReviewIssues(approve: boolean, issues: unknown[]): ReviewDecision {
  const inconsistencies: string[] = [];
  issues.forEach((issue, i) => {
    if (typeof issue !== "string") inconsistencies.push(`review verdict inconsistent: issues[${i}] must be a string`);
  });
  if (approve && issues.length) {
    inconsistencies.push("review verdict inconsistent: approve=true requires issues to be empty");
  } else if (!approve && !issues.length) {
    inconsistencies.push("review verdict inconsistent: approve=false requires at least one issue");
  }
  const pass = approve === true && inconsistencies.length === 0;
  const lines = issues.map((issue) => `- ${typeof issue === "string" ? issue : JSON.stringify(issue)}`);
  lines.push(...inconsistencies);
  return { pass, headline: pass ? "approved" : approve ? "approval rejected" : "requested changes", lines };
}

// v1.70 T5: classified findings — only material (non-deferred) findings block approval. Deferred
// findings carry their rationale into the details (never dropped). Malformed rows fail closed like any
// other shape violation, so a garbage "findings" array can never fake an approval.
function classifyReviewFindings(findings: unknown[]): ReviewDecision {
  const inconsistencies: string[] = [];
  const lines: string[] = [];
  let material = 0;
  let deferred = 0;
  findings.forEach((f, i) => {
    if (!f || typeof f !== "object") {
      inconsistencies.push(`review finding inconsistent: findings[${i}] must be an object`);
      return;
    }
    const { note, severity, defer, rationale } = f as Record<string, unknown>;
    if (typeof note !== "string") inconsistencies.push(`review finding inconsistent: findings[${i}].note must be a string`);
    if (severity !== "material" && severity !== "minor") inconsistencies.push(`review finding inconsistent: findings[${i}].severity must be "material" or "minor"`);
    if (defer !== undefined && typeof defer !== "boolean") inconsistencies.push(`review finding inconsistent: findings[${i}].defer must be a boolean`);
    const isDeferred = defer === true;
    if (isDeferred && (typeof rationale !== "string" || !rationale.trim())) {
      inconsistencies.push(`review finding inconsistent: deferred findings[${i}] requires a rationale`);
    }
    if (severity === "material" && !isDeferred) material++;
    if (isDeferred) deferred++;
    const label = isDeferred ? `deferred/${severity ?? "?"}` : String(severity ?? "?");
    const why = isDeferred && typeof rationale === "string" ? ` — rationale: ${rationale}` : "";
    lines.push(`- [${label}] ${typeof note === "string" ? note : JSON.stringify(note)}${why}`);
  });
  const pass = material === 0 && inconsistencies.length === 0;
  lines.push(...inconsistencies);
  const headline = pass
    ? deferred ? `approved (${deferred} deferred)` : "approved"
    : `requested changes (${material} material)`;
  return { pass, headline, lines };
}

// OBS-48: cap on zero-context diff bytes (git diff -U0), not context-padded full diff — scattered
// one-line hunks no longer trip at ~370 diff-bytes per changed line. Full diff still goes to the judge.
const DIFF_CAP_REMEDY = "split the task, or raise gates.diffCap";

/**
 * The paths this task's diff ACTUALLY touched. `-z` so a path carrying spaces or non-ASCII bytes is
 * never mangled by git's quoting, `--no-renames` so a rename reports BOTH sides: a file renamed OUT of
 * the leaf class must be visible to the promotion test, and rename detection would hide the old side.
 */
export async function changedPaths(worktree: string, baseRef: string): Promise<string[]> {
  const out = await shOk(`git diff --name-only --no-renames -z '${baseRef}..HEAD'`, worktree);
  return [...new Set(out.split("\0").map((p) => p.trim()).filter(Boolean))].sort();
}

/**
 * A root manifest is a version MIRROR only when the bump is all it changed. `package.json` carries the
 * gate commands and the dependency set, so a diff that moves `scripts` or `dependencies` is executable
 * behaviour wearing a leaf-class path — the one thing a path predicate can never see for itself. Every
 * added or removed line must be a `"version":` line (a lockfile bump rewrites several of them); a
 * manifest whose diff cannot be read at all fails closed, out of the class.
 */
const VERSION_FIELD_LINE_RE = /^[+-]\s*"version":\s*"[^"]*",?\s*$/;

export async function mirrorsVersionOnly(worktree: string, baseRef: string, path: string): Promise<boolean> {
  let diff: string;
  try {
    diff = await shOk(`git diff --full-index -U0 '${baseRef}..HEAD' -- ${shq(path)}`, worktree);
  } catch {
    return false;
  }
  const changed = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(?:\+\+\+|---)/.test(l));
  return changed.length > 0 && changed.every((l) => VERSION_FIELD_LINE_RE.test(l));
}

export type TaskDiffMeasurement = {
  readonly full: string;
  readonly forCap: string;
  /** Strict-cap UTF-8 bytes left after capture payloads become receipts. */
  readonly logicBytes: number;
  /** UTF-8 bytes withheld by those receipts and charged to the larger cap. */
  readonly captureBytes: number;
  readonly classifications: readonly ArtifactDiffSection[];
  readonly fullMeasurement: ArtifactDiffMeasurement;
  readonly capMeasurement: ArtifactDiffMeasurement;
};

export async function fetchTaskDiff(worktree: string, baseRef: string, files: readonly string[] = []): Promise<TaskDiffMeasurement> {
  // --full-index: abbreviated index lines vary with object-store density, so two measurements of
  // the same diff could disagree by a few bytes between invocations (CI-only red, release 1.89.0).
  const matched = files.length ? (await changedPaths(worktree, baseRef)).filter(filesGlob([...files])) : [];
  const pathspec = matched.length ? ` -- ${matched.map(shq).join(" ")}` : "";
  const [rawFull, rawForCap] = files.length && matched.length === 0 ? ["", ""] : await Promise.all([
    shOk(`git diff --full-index '${baseRef}..HEAD'${pathspec}`, worktree),
    shOk(`git diff --full-index -U0 '${baseRef}..HEAD'${pathspec}`, worktree),
  ]);
  const fullMeasurement = measureArtifactDiff(rawFull);
  const capMeasurement = measureArtifactDiff(rawForCap);
  return {
    full: fullMeasurement.rendered,
    forCap: capMeasurement.rendered,
    logicBytes: Buffer.byteLength(reviewableLogicDiff(capMeasurement.rendered), "utf8"),
    captureBytes: capMeasurement.captureBytes,
    classifications: capMeasurement.sections,
    fullMeasurement,
    capMeasurement,
  };
}

export function checkDiffCap(gate: string, measured: number, cap: number, prefix = ""): GateResult | null {
  if (measured <= cap) return null;
  return {
    gate,
    pass: false,
    details: prefix + `diff exceeds verifiable cap (${measured} > ${cap}) — ${DIFF_CAP_REMEDY}`,
    meta: {
      park: "diff-cap",
      parkKind: "diff-cap",
      measuredBytes: measured,
      permittedBytes: cap,
      measured,
      permitted: cap,
    },
  };
}

/** Apply the strict reviewable-logic cap and the finite, larger capture cap independently. */
export function checkTaskDiffCaps(
  gate: string,
  measured: Pick<TaskDiffMeasurement, "logicBytes" | "captureBytes">,
  logicCap: number,
  prefix = "",
): GateResult | null {
  const logicFail = checkDiffCap(gate, measured.logicBytes, logicCap, prefix);
  if (logicFail) return logicFail;
  const captureCap = captureDiffCapFor(logicCap);
  if (measured.captureBytes <= captureCap) return null;
  return {
    gate,
    pass: false,
    details: prefix
      + `captured artifact diff exceeds verifiable capture cap (${measured.captureBytes} > ${captureCap}) — ${DIFF_CAP_REMEDY}`,
    meta: {
      park: "diff-cap",
      parkKind: "diff-cap",
      measuredBytes: measured.captureBytes,
      permittedBytes: captureCap,
      measured: measured.captureBytes,
      permitted: captureCap,
    },
  };
}

export function isDiffCapPark(result: GateResult): boolean {
  return result.pass === false
    && result.meta?.parkKind === "diff-cap"
    && /diff exceeds verifiable (?:capture )?cap/i.test(result.details);
}

// ponytail: single policy hook for callers after runGates — skips the escalation ladder on diff-cap trips.
export function diffCapParkReason(results: GateResult[]): string | null {
  return results.find(isDiffCapPark)?.details ?? null;
}

// FLEET-05: canonical model identity = the segment after the last "/". Provider-prefixed ids name ONE
// base model behind two harnesses (zai-coding-plan/glm-5.2, zai/glm-5.2 → "glm-5.2"); vendor alone (mixed vs
// zhipu) is not a diversity signal. Suffix-stripping over-excludes only if two genuinely different
// models share a bare suffix — that errs fail-closed, acceptable per "gates never trust". Local to
// review.ts (not a global identity concept).
export function modelId(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

export { modelProvider };

/**
 * One function decides whether a reviewer's `resolved` or `reraised` id names a carried fingerprint,
 * comparing both sides with every whitespace run removed (`s.replace(/\s+/g, "")`).
 */
export function matchClosureId(candidate: unknown, fingerprint: string): boolean;
export function matchClosureId(candidate: unknown, fingerprints: Iterable<string>): string | undefined;
export function matchClosureId(candidate: unknown, target: string | Iterable<string>): boolean | string | undefined {
  if (typeof candidate !== "string") return typeof target === "string" ? false : undefined;
  // OBS-1068: the brief's copy block printed each id as `Fingerprint: <id>` and told the seat to copy
  // it EXACTLY — three faithful approvals in one run were discarded as closure-mismatch. A leading
  // `Fingerprint:` label is the brief's own wording, never the reviewer's id; strip it before comparing.
  const normCandidate = candidate.replace(/^\s*fingerprint\s*:\s*/i, "").replace(/\s+/g, "");
  if (typeof target === "string") {
    return normCandidate === target.replace(/\s+/g, "");
  }
  for (const fp of target) {
    if (typeof fp === "string" && normCandidate === fp.replace(/\s+/g, "")) return fp;
  }
  return undefined;
}

/**
 * Validates closure ids in a review verdict: membership, duplication, and coverage of every prior id
 * all route through matchClosureId.
 */
export function isReviewClosureInvalid(
  v: Pick<ReviewVerdict, "resolved" | "reraised"> | null | undefined,
  priorIds: ReadonlySet<string> | readonly string[],
): boolean {
  const priors = priorIds instanceof Set ? priorIds : new Set(priorIds);
  const closureLists = [v?.resolved, v?.reraised];
  const allCandidateIds = [...(v?.resolved ?? []), ...(v?.reraised ?? [])];
  return !!v && (priors.size > 0 || closureLists.some((list) => list !== undefined)) && (
    closureLists.some((list) => !Array.isArray(list) || list.some((id) => !matchClosureId(id, priors)))
    || new Set(allCandidateIds.map((id) => matchClosureId(id, priors) ?? id)).size !== allCandidateIds.length
    || [...priors].some((id) => !allCandidateIds.some((candidate) => matchClosureId(candidate, id)))
  );
}

/**
 * OBS-1013 add.3: the reviewer ECHOED closure ids and at least one matches no carried fingerprint —
 * it answered about the materials and missed the id (a retyped, truncated or paraphrased fingerprint).
 * That is a no-verdict about the carried work (re-route), not a parse defect. A verdict that omits a
 * list, carries a non-string or duplicates an id stays malformed: its shape, not its ids, is wrong.
 */
export function isReviewClosureMismatch(
  v: Pick<ReviewVerdict, "resolved" | "reraised"> | null | undefined,
  priorIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (!v || !Array.isArray(v.resolved) || !Array.isArray(v.reraised)) return false;
  const ids = [...v.resolved, ...v.reraised];
  if (!ids.every((id) => typeof id === "string")) return false;
  const priors = priorIds instanceof Set ? priorIds : new Set(priorIds);
  return ids.some((id) => matchClosureId(id, priors) === undefined);
}

// v1.53 T2: same entry grammar as routing.map.prefer (router.ts preferIndex — router is out of this
// module's dependency direction for a private fn, so the 3 lines live here too): `adapter` matches
// every channel of that adapter, `adapter:model` exactly one; unmatched channels sort after all entries.
function reviewPreferIndex(c: BillingChannel, prefer: string[]): number {
  const i = prefer.findIndex((p) => p === c.adapter || p === channelKey(c));
  return i === -1 ? prefer.length : i;
}

export type ReviewerFloorCause = "author-tier" | "task-floor" | "config" | "prior-reviewer";

/**
 * RF-1 (OBS-922 add.2/3): the tier a reviewer must meet is the maximum of the author's tier, the
 * task-declared floor, a configured `review.floor` tier and, on a second round or a retry, the prior
 * reviewer's tier. The cause names the input that reached the maximum (earlier inputs win a tie, so a
 * floor the author's tier already satisfies is attributed to the author).
 */
export function resolveReviewerFloor(
  authorTier: Tier,
  taskFloor?: Tier,
  configFloor?: Tier,
  priorReviewerTier?: Tier,
): { floor: Tier; cause: ReviewerFloorCause } {
  const inputs: [Tier | undefined, ReviewerFloorCause][] = [
    [authorTier, "author-tier"], [taskFloor, "task-floor"], [configFloor, "config"], [priorReviewerTier, "prior-reviewer"],
  ];
  let best: { floor: Tier; cause: ReviewerFloorCause } = { floor: authorTier, cause: "author-tier" };
  for (const [tier, cause] of inputs) {
    if (tier !== undefined && TIER_RANK[tier] > TIER_RANK[best.floor]) best = { floor: tier, cause };
  }
  return best;
}

/** A prior reviewer of THIS task: a channel key, or a journaled row's key plus the tier it was DISPATCHED at. */
export type PriorReviewer = string | { reviewer: string; tier?: unknown };

/**
 * The highest tier among the task's prior reviewers — the prior reviewer's tier for RF-1. A recorded
 * dispatch tier is historical evidence and wins over the current pool; an unrecorded one falls back to
 * the seat's channel; a seat neither establishes (it left the pool on resume, or the journal holds
 * garbage) holds frontier — fail closed, never silently dropped.
 */
export function priorReviewerTier(channels: BillingChannel[], priorReviewers: readonly PriorReviewer[] = []): Tier | undefined {
  let top: Tier | undefined;
  for (const p of priorReviewers) {
    const key = typeof p === "string" ? p : p.reviewer;
    const seen = (typeof p === "string" ? undefined : p.tier) ?? channels.find((ch) => channelKey(ch) === key)?.tier;
    const tier: Tier = (TIERS as readonly unknown[]).includes(seen) ? seen as Tier : "frontier";
    if (top === undefined || TIER_RANK[tier] > TIER_RANK[top]) top = tier;
  }
  return top;
}

/**
 * The gate's floor: author tier, task floor, review.floor (a tier — `worker` names none) and the seats
 * the caller names as THIS TASK's prior reviewers (earlier rounds' seats, a flaked seat). Eligibility
 * exclusions are NOT evidence — a retry bans a flaked seat's whole adapter, and those sibling channels
 * never reviewed — and neither is the run-scoped LRU rotation history, which names unrelated tasks' seats.
 */
export function gateReviewerFloor(
  task: Pick<Task, "routingHints">, cfg: TickmarkrConfig, author: Assignment, channels: BillingChannel[],
  priorReviewers: readonly PriorReviewer[] = [],
): { floor: Tier; cause: ReviewerFloorCause } {
  return resolveReviewerFloor(
    author.tier, task.routingHints?.floor, cfg.review.floor === "worker" ? undefined : cfg.review.floor,
    priorReviewerTier(channels, priorReviewers),
  );
}

export function pickReviewer(
  author: Assignment,
  channels: BillingChannel[],
  exclude: string[] = [], // v1.1 failover: reviewer channels that already produced garbage for this task
  prefer: string[] = [], // v1.53 T2: review.prefer — reorders eligible channels, never changes eligibility
  floor?: Tier, // task/config/prior floor from the caller; the author's own tier is ALWAYS applied here (RF-1)
  history: string[] = [], // run-scoped picks, oldest to newest; empty preserves the established ranking
  onSeat?: (seat: number, count: number) => void,
  demoted: ReadonlySet<string> = new Set(),
  // OBS-1033: vendors that authored a carried commit inside the accumulated diff — excluded for the round.
  excludeVendors: ReadonlySet<string> = new Set(),
): BillingChannel | null {
  // FLEET-05 success criterion 2: an author not resolvable in the channel list yields NO reviewer.
  // The old `?? author.adapter` fallback compared an adapter id to vendor names, matched nothing, and
  // admitted every reviewer — including the author's own channel (fail-OPEN). null lands on reviewGate's
  // fail-closed branch under review.required.
  const authorChannel = channels.find((c) => c.adapter === author.adapter && c.model === author.model);
  if (!authorChannel) return null;
  const authorProvider = modelProvider(author.model, authorChannel.vendor);
  // RF-1: every caller inherits the author-tier floor — a reviewer is never seated below its author.
  const effectiveFloor = resolveReviewerFloor(author.tier, floor).floor;
  const ranked = channels
    // Three independent axes: different vendor, different resolved provider identity (OBS-946: on initial pick
    // as well as failover, so an aggregator channel stamped "mixed" never seats the author's own provider),
    // and different base-model identity (ADDED TO the vendor rule, never replacing it). The diversity
    // filter runs BEFORE preference ranking, so prefer cannot resurrect an excluded channel.
    .filter((c) => c.vendor !== authorChannel.vendor
      && modelProvider(c.model, c.vendor) !== authorProvider
      && modelId(c.model) !== modelId(author.model)
      && !exclude.includes(channelKey(c))
      && !excludeVendors.has(c.vendor)
      && TIER_RANK[c.tier] >= TIER_RANK[effectiveFloor])
    .sort((a, b) => reviewPreferIndex(a, prefer) - reviewPreferIndex(b, prefer) || TIER_RANK[b.tier] - TIER_RANK[a.tier] || marginalCostRank(a) - marginalCostRank(b));
  const reviewer = [...ranked].sort((a, b) =>
    Number(demoted.has(channelKey(a))) - Number(demoted.has(channelKey(b)))
    || history.lastIndexOf(channelKey(a)) - history.lastIndexOf(channelKey(b))
    || ranked.indexOf(a) - ranked.indexOf(b))[0] ?? null;
  if (reviewer) onSeat?.(ranked.indexOf(reviewer) + 1, ranked.length);
  return reviewer;
}

// OBS-196: the two observed unparseable causes are different defects — a cutoff/empty output is
// reviewer infrastructure dying mid-flight; a malformed verdict is a parse defect. Neither is
// evidence about the WORK, which is why run-gates retries the review, never the worker (OBS-193).
// OBS-1013 add.3: a parseable verdict whose closure ids match no carried fingerprint is a
// `closure-mismatch` — a no-verdict about the carried materials (infra: re-route), never a parse defect.
export type ReviewUnparseableCause = VerdictUnparseableCause | "launch-never-started" | "truncated" | "silent" | "closure-mismatch";

/**
 * This shows the reviewer what the task DECLARED, never what the diff may actually reach. The diff
 * remains a separate stated input, so whether its touched paths fit the declaration stays a reviewer
 * judgement rather than a guarantee made by this renderer.
 */
export function renderDeclaredWriteScope(files: ReadonlyArray<string>): string {
  if (files.length === 0) {
    return "## Declared write scope\nUnrestricted: this task declared no write-scope patterns.";
  }
  return `## Declared write scope
The task DECLARED these write-scope patterns:
${files.map((path) => `- ${path}`).join("\n")}`;
}

/**
 * OBS-1033: the vendors of the seats that authored commits inside the accumulated diff. A seat is
 * never handed its own earlier work to approve. A prior author not resolvable in the pool excludes
 * its adapter's vendors instead (fail closed: the seat is known, its vendor is whatever it bills as).
 */
export function carriedAuthorVendors(channels: BillingChannel[], carriedAuthors: readonly string[] = []): Set<string> {
  const vendors = new Set<string>();
  for (const key of carriedAuthors) {
    const adapter = key.split(":")[0]!;
    const exact = channels.filter((c) => channelKey(c) === key);
    for (const c of exact.length ? exact : channels.filter((c) => c.adapter === adapter)) vendors.add(c.vendor);
  }
  return vendors;
}

/**
 * OBS-1020: the compiled goal is the contract. After `resume --graph-changed` the worktree's copy of
 * the spec is the pre-change text on the integration branch, so a reviewer that reads it grades a
 * superseded contract. The daemon's repository root is where specs and planning records are current.
 */
export function renderGoalSection(goal: string, repoRoot?: string): string {
  return `## Goal (authoritative — compiled from the sealed graph; the worktree's spec file may be stale after resume --graph-changed)
${goal}
${repoRoot ? `Specs and planning records are read in the daemon's repository root ${repoRoot} (its specs/ and .planning/), never this worktree's copies.` : ""}`;
}

/**
 * The daemon's repository root: the parent of the state dir the run's artifacts live under. Named
 * only when that state dir exists — a guessed one would send the reviewer to a path that holds nothing.
 */
function daemonRepoRoot(worktree: string, artifactDir?: string): string | undefined {
  try {
    const stateDir = resolveStateDir(worktree, artifactDir);
    return stateDir.endsWith("/.tickmarkr") && existsSync(stateDir) ? dirname(stateDir) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OBS-1013 add.3: each carried id is printed ONCE, verbatim, inside a fenced block the reviewer can
 * copy; the notes follow in the same order. A reviewer that retyped a 600-byte id from prose lost
 * closure on a typo and that read as malformed — the block is what a closure list is copied from.
 */
export function renderPriorMaterials(priorMaterials: readonly StructuredFinding[]): string {
  return `## Prior materials this attempt must close
Copy each fingerprint below EXACTLY (they appear once, in this block) into resolved or reraised:
\`\`\`text
${priorMaterials.map((finding) => `Fingerprint: ${finding.fingerprint}`).join("\n")}
\`\`\`
${priorMaterials.map((finding, i) => `${i + 1}. ${finding.note}`).join("\n\n")}`;
}

export async function reviewGate(
  task: Task,
  worktree: string,
  baseRef: string,
  author: Assignment,
  channels: BillingChannel[],
  adapters: WorkerAdapter[],
  cfg: TickmarkrConfig,
  via?: GateVia,
  excludeReviewers?: string[],
  // OBS-196: run dir for raw-output persistence on an unparseable verdict; absent (older callers,
  // direct tests) skips persistence and changes nothing else.
  artifactDir?: string,
  reviewHistory?: string[],
  demotedReviewers?: ReadonlySet<string>,
  carriedFindings: readonly StructuredFinding[] = [],
  // RF-1: channel keys of THIS task's prior reviewers (earlier rounds, a flaked seat) — task-scoped,
  // never the run-wide rotation history nor excludeReviewers; the seat holds the highest of their tiers.
  priorReviewers: readonly PriorReviewer[] = [],
  // OBS-1033: channel keys of the seats that authored the carried commits (the daemon's tried list).
  carriedAuthors: readonly string[] = [],
): Promise<GateResult> {
  // R3 (OBS-186): participation is keyed on PATHS. The compiler's assignment comes from the DECLARED
  // files[]; the operator's floor may RAISE it to full and can never lower it. `complexityThreshold` is
  // retired — the branch that returned a green skip on a complexity comparison is gone, and with it the
  // "a law caps complexity at 3, the gate starts at 7" unreachability OBS-186 measured.
  //
  // COLLATERAL this rescoped task closed: the run-gates/daemon participation assertions are rewritten
  // path-keyed, the NamedFake review fixtures author their own nonce-bound verdict (a renamed fake is
  // a distinct responder and does not inherit the registered fake's producer contract — the check is
  // not weakened, the fixture is fixed), the merge decision reads `gateSatisfied`, and the daemon writes a
  // parallel round's gate-result rows in GATE_NAMES order (src/run/daemon.ts).
  //
  // That last one is why: retiring the switch makes fixtures that used to SKIP review journal TWO
  // verdict rows per round instead of one, and judge ‖ review publish in COMPLETION order — so the
  // three journal-determinism oracles (tests/run/narration.test.ts's byte comparison and its
  // throwing-sink event-order check, tests/run/notify-identity.test.ts's two-run equality, and this
  // repo's own phase-start/gate-result pairing in tests/run/daemon.test.ts) start seeing a race.
  // LATENT, not introduced: the operator's config has run `complexityThreshold: 0` since 2026-07-31,
  // so production rounds have journaled both siblings all along — only the fixtures were blind to it.
  // Fixed in the ledger rather than in the oracles, because determinism run-to-run is a property of
  // the journal, not of three test files that happen to assert it.
  const priorMaterials = carriedFindings.filter((finding) => finding.class === "review:material");
  const declaredPolicy = declaredReviewPolicy(task.files);
  const policy = priorMaterials.length ? "full" : raiseReviewPolicy(declaredPolicy, cfg.review.policy);
  // PROMOTION: the declared assignment is a claim about paths, and the diff is the evidence. A
  // judge-only task whose diff left the leaf class is reviewed in full — the claim never outranks
  // what actually happened, and an empty diff promotes too (a skip earned by an absence is not earned).
  let promotedBy: string[] | null = null;
  if (policy === "judge-only") {
    const touched = await changedPaths(worktree, baseRef);
    // Two ways a path leaves the leaf class. It is not a member (`docs/tool.ts`, `docs/Makefile`) — or
    // it is a root version mirror whose diff moved more than the version field, which no path predicate
    // can see. `package.json` carries the gate commands, so a scripts edit hiding behind a leaf-class
    // path is exactly the promotion this buys.
    const nonMembers = touched.filter((p) => !isReviewLeafPath(p));
    const impostorMirrors = (await Promise.all(
      touched.filter((p) => REVIEW_VERSION_MIRRORS.has(p))
        .map(async (p) => await mirrorsVersionOnly(worktree, baseRef, p) ? null : p),
    )).filter((p): p is string => p !== null);
    // The fail-closed backstop for the compile lint. reviewParticipationErrors runs at a repo root the
    // compile seam cannot always name (collateral.ts); THIS gate is handed the run's real config, so a
    // critical path that reached dispatch is reviewed here whatever the lint saw. The shipped defaults
    // are unioned in for the same reason they are there: a config that names none still has a floor.
    const criticalHits = criticalPathHits(
      [...task.files, ...touched],
      [...new Set([...DEFAULT_REVIEW_CRITICAL_PATHS, ...(cfg.review.criticalPaths ?? [])])],
    );
    const escaped = [...new Set([...nonMembers, ...impostorMirrors, ...criticalHits])].sort();
    if (touched.length > 0 && escaped.length === 0) {
      // A declined review makes NO green claim. types.ts's T11 note ("pass stays true so enforcement is
      // unchanged") describes the baseline skips — a build/test/lint command the repo never configured.
      // R3 overrules it here: a cross-vendor review that did not run cannot report a pass, so the record
      // carries verdict "skipped" with the policy that declined it and the reason, and pass is never
      // true. The merge-predicate seam this opens is named in the collateral note above.
      return {
        gate: "review",
        pass: false,
        details: `skipped — reviewPolicy judge-only: every declared path is docs/CHANGELOG/RELEASING/version-mirror leaf work and the diff stayed in that class (${touched.join(", ")})`,
        meta: {
          skipped: true,
          verdict: "skipped",
          policy: "judge-only" satisfies ReviewPolicy,
          reason: "every declared path and every path this diff touched is provably leaf-class work",
          paths: touched,
        },
      };
    }
    promotedBy = escaped.length > 0 ? escaped : [];
  }
  // Every verdict this gate reports from here on was produced under `full` — either declared full, or
  // promoted here. `promotedBy` names the paths that bought the promotion, so the record shows WHY.
  const policyMeta: Record<string, unknown> = {
    policy: "full" satisfies ReviewPolicy,
    ...(promotedBy ? { promotedFrom: declaredPolicy, promotedBy } : {}),
  };
  // RF-1: the floor is max(author tier, task floor, review.floor tier, prior reviewer's tier). Only
  // review.floor is read from config — cfg.routing.floors governs workers and never moves review seats.
  const { floor: reviewerFloor, cause: reviewerFloorCause } = gateReviewerFloor(task, cfg, author, channels, priorReviewers);
  const floorMeta = { reviewerFloor, reviewerFloorCause };
  let rotationSeat: number | undefined;
  const reviewer = pickReviewer(
    author, channels, excludeReviewers ?? [], cfg.review.prefer ?? [], reviewerFloor,
    reviewHistory, reviewHistory ? (seat) => { rotationSeat = seat; } : undefined, demotedReviewers,
    carriedAuthorVendors(channels, carriedAuthors),
  );
  if (!reviewer) {
    // meta.noEligibleReviewer lets run-gates' review-retry keep the ORIGINAL unparseable result when
    // the retry finds no second seat — a truthful cause beats a synthetic no-reviewer failure.
    const reason = `no cross-vendor reviewer available at or above ${reviewerFloor} floor (${reviewerFloorCause}; diversity rule)`;
    return cfg.review.required || priorMaterials.length > 0
      ? { gate: "review", pass: false, details: `unreadable — ${reason}; ${priorMaterials.length ? "carried materials require a review verdict" : "set review.required:false to waive"}`, meta: { noEligibleReviewer: true, unreadable: true, ...floorMeta } }
      : { gate: "review", pass: true, details: `WARNING: ${reason} — review waived by config`, meta: { noEligibleReviewer: true, ...floorMeta } };
  }
  reviewHistory?.push(channelKey(reviewer));
  const rotationMeta = rotationSeat === undefined ? {} : { rotationSeat };
  const measuredDiff = await fetchTaskDiff(worktree, baseRef, task.files);
  // Keep the reader payload identical to the text charged to the strict cap:
  // whole-file source deletions are represented by their citable operation fact.
  const diff = reviewableLogicDiff(measuredDiff.full);
  const diffCap = cfg.gates.diffCap ?? DEFAULT_DIFF_CAP;
  const capFail = checkTaskDiffCaps("review", measuredDiff, diffCap);
  if (capFail) return capFail;
  const nonce = generateVerdictNonce();
  const repoRoot = daemonRepoRoot(worktree, artifactDir);
  // OBS-880 add.1: guidance only. Do not expand scope globs into permission to run suites.
  const ownTestFiles = [...new Set(task.files.filter((file) =>
    !/[*?[\]{}()!]/.test(file) && /(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
  ))];
  const suiteBudget = ownTestFiles.length
    ? `You may run at most the task's own test files explicitly named in files[]; these are the only suites you may run: ${ownTestFiles.map((file) => `\`${file}\``).join(", ")}.`
    : "No suite may be run: files[] names no explicit test file owned by this task.";
  const prompt = `TICKMARKR-REVIEW
You are a skeptical cross-vendor code reviewer. Another agent (vendor: ${author.adapter}) authored this diff.
Look for correctness bugs, security issues, and acceptance-criteria gaps. Approve only if you would merge it.

${COMPLETION_FAKING_CHECKLIST}

## Task ${task.id}: ${task.title} (complexity ${task.complexity})
${renderGoalSection(task.goal, repoRoot)}
## Acceptance criteria
${task.acceptance.map((a) => `- ${renderAcceptanceItem(a)}`).join("\n")}

${renderDeclaredWriteScope(task.files)}

## Reviewer suite budget
${suiteBudget} Never run the whole suite (including an unfiltered npm test or vitest run). The gate suite owns the runner lease; a parallel full suite starves the gate.

${priorMaterials.length ? `${renderPriorMaterials(priorMaterials)}

` : ""}## Diff
\`\`\`diff
${diff}
\`\`\`

${verdictNonceLine(nonce)}

Classify every concern as "material" (a correctness, security, or acceptance-criteria defect that must
block the merge) or "minor" (style, naming, or preference that should not block). ONLY material findings
block approval. For a minor concern you have decided not to block on, set "defer": true and give a
one-line "rationale" — it is recorded in the review, never dropped.
A fix you prescribe that would break suites outside the task's declared write scope (files[]) is a scope finding, never a material one.

Respond with ONLY this JSON:
{"nonce": "${nonce}", "approve": true|false, "resolved": [], "reraised": [], "findings": [{"note": "...", "severity": "material"|"minor", "defer": false, "rationale": ""}], "comments": [{"path": "path/to/file", "line": 42, "body": "actionable feedback"}]}
For every prior material, put its fingerprint in exactly one of resolved (verified fixed) or reraised
(still a blocking defect). Use only the listed fingerprints; never omit one or put it in both lists.
Approve iff no material finding remains and every prior material is resolved.
The top-level comments array is optional. Use it only for actionable line-anchored feedback.
`;
  // Filenames are journaled (daemon.ts lifts meta.rawPath/briefPath onto the gate-result row), so they
  // must be reproducible from the same inputs — the verdict nonce is cryptographically random and would
  // make two otherwise-identical runs diverge in their journal bytes. The reviewer channel already
  // disambiguates every call that matters: a retry always excludes the flaked channel (run-gates.ts),
  // so it can never collide with the attempt it replaces.
  const baseArtifactId = `${task.id}-${channelKey(reviewer).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  let artifactId = baseArtifactId;
  if (artifactDir) {
    if (
      existsSync(join(artifactDir, `review-brief-${baseArtifactId}.md`)) ||
      existsSync(join(artifactDir, `review-raw-${baseArtifactId}.txt`))
    ) {
      let counter = 2;
      while (
        existsSync(join(artifactDir, `review-brief-${baseArtifactId}-${counter}.md`)) ||
        existsSync(join(artifactDir, `review-raw-${baseArtifactId}-${counter}.txt`))
      ) {
        counter++;
      }
      artifactId = `${baseArtifactId}-${counter}`;
    }
  }
  const briefPath = artifactDir ? join(artifactDir, `review-brief-${artifactId}.md`) : undefined;
  // Persistence is evidence, not a gate input: a full disk or a removed run dir never fails the gate.
  let savedBrief: string | undefined;
  if (briefPath) {
    try { writeFileSync(briefPath, redactSecrets(prompt)); savedBrief = briefPath; } catch { savedBrief = undefined; }
  }
  const llm = await runLlmDetailed(
    getAdapter(reviewer.adapter, adapters),
    reviewer.model,
    prompt,
    worktree,
    via ? {
      driver: via.driver,
      keep: via.keep,
      onSlot: via.onSlot,
      name: via.nameFor("review", reviewer.adapter),
      label: via.labelFor("review"),
    } : undefined,
    // frontier reviewers routinely need >5min on a configured-cap-sized diff, and `claude -p` buffers all
    // output until completion — runLlm's 300s default killed reviews mid-flight, returning empty
    // stdout that read as "unparseable" and escalated to re-implementation of green code
    // (run-20260709-104447 P87-09). The configured ceiling defaults to that measured 15 minutes.
    cfg.review.timeoutMs,
  );
  const raw = llm.output;
  let saved: string | undefined;
  if (artifactDir) {
    try {
      saved = join(artifactDir, `review-raw-${artifactId}.txt`);
      writeFileSync(saved, redactSecrets(raw));
    } catch {
      saved = undefined; // persistence is evidence, not a gate input — never fail the gate on it
    }
  }
  const provider = modelProvider(reviewer.model, reviewer.vendor);
  const v = extractVerdictJson<ReviewVerdict>(raw, nonce);
  const findings = v && Array.isArray(v.findings) ? (v.findings as unknown[]) : null;
  const priorIds = new Set(priorMaterials.map((finding) => finding.fingerprint));
  const closureInvalid = isReviewClosureInvalid(v, priorIds);
  const closureMismatch = closureInvalid && isReviewClosureMismatch(v, priorIds);
  // findings decides the verdict on its own; the legacy path still needs approve + issues to parse.
  if (!v || closureInvalid || (findings === null && (typeof v.approve !== "boolean" || !Array.isArray(v.issues)))) {
    // OBS-196: name the cause and persist the raw bytes — a ruled-on "unparseable" without its
    // evidence cannot be audited, and a cutoff must never be indistinguishable from a parse defect.
    const bytes = llm.seatAuthoredBytes ?? Buffer.byteLength(raw.trim(), "utf8");
    const cause: ReviewUnparseableCause = closureMismatch ? "closure-mismatch" : closureInvalid ? "malformed-verdict"
      : llm.launchNeverStarted ? "launch-never-started"
      : llm.silentAtBeat ? "silent"
      : llm.timedOut ? (bytes > 0 ? "truncated" : "silent")
      : classifyVerdictCause(raw, nonce, "approve", llm);
    const failure = cause === "malformed-verdict"
      ? "review output unparseable"
      : cause === "closure-mismatch"
        ? "review verdict closes no carried fingerprint — closure ids match none of the carried materials"
        : "review dispatch failed — no structurally valid nonce-bound response";
    return {
      gate: "review",
      pass: false,
      details: `${failure} (reviewer ${reviewer.adapter}:${reviewer.model}; vendor: ${reviewer.vendor}; provider: ${provider}; cause: ${cause}${llm.timedOut ? `; killed at configured review timeout ${cfg.review.timeoutMs}ms` : ""}${saved ? `; raw saved: ${saved}` : ""}) — failing closed`,
      meta: {
        ...policyMeta,
        ...rotationMeta,
        ...floorMeta,
        reviewer: channelKey(reviewer),
        reviewerTier: reviewer.tier,
        vendor: reviewer.vendor,
        provider,
        ...(cause === "malformed-verdict" ? { unparseable: true } : { noVerdict: true, classification: "infra", infra: true }),
        cause,
        ...(closureMismatch ? { resolved: v?.resolved, reraised: v?.reraised, carriedFingerprints: [...priorIds] } : {}),
        bytes, seatAuthoredBytes: bytes,
        ...(saved ? { rawPath: saved } : {}),
        ...(savedBrief ? { briefPath: savedBrief } : {}),
        ...(llm.timedOut ? { timeoutMs: cfg.review.timeoutMs } : {}),
      },
    };
  }
  const decided = findings !== null
    ? classifyReviewFindings(findings)
    : classifyReviewIssues(v.approve as boolean, v.issues as unknown[]);
  const reraised = priorMaterials.filter((finding) =>
    v.reraised?.some((id) => matchClosureId(id, finding.fingerprint)),
  );
  if (reraised.length) {
    if (decided.pass) decided.headline = "requested changes";
    decided.pass = false;
    // A reviewer may also restate a re-raised material in findings. Preserve the original
    // prose once so an unchanged defect keeps the same failure brief across repair rounds.
    for (const finding of reraised) {
      const line = `- [material] ${finding.note}`;
      if (!decided.lines.includes(line)) decided.lines.push(line);
    }
  }
  const prose = `reviewer ${reviewer.adapter}:${reviewer.model} (vendor: ${reviewer.vendor}; provider: ${provider}): ${decided.headline}${decided.lines.length ? "\n" + decided.lines.join("\n") : ""}`;
  const details = appendAnchoredReview(prose, v);
  return {
    gate: "review",
    pass: decided.pass,
    details,
    meta: {
      ...policyMeta, ...rotationMeta, ...floorMeta, reviewer: channelKey(reviewer), reviewerTier: reviewer.tier, vendor: reviewer.vendor, provider,
      // OBS-990 b: the verbatim ids plus ONE normalised copy of each list — never a third alias.
      ...(priorMaterials.length ? {
        resolved: v.resolved,
        reraised: v.reraised,
        resolvedMatches: (v.resolved ?? []).map((id) => matchClosureId(id, priorIds)).filter((id): id is string => id !== undefined),
        reraisedMatches: (v.reraised ?? []).map((id) => matchClosureId(id, priorIds)).filter((id): id is string => id !== undefined),
      } : {}),
      ...(reraised.length ? { findings: [
        ...structuredFindings("review", details).filter((finding) => !reraised.some((prior) => prior.note === finding.note)),
        ...reraised,
      ] } : {}),
      ...(saved ? { rawPath: saved } : {}),
      ...(savedBrief ? { briefPath: savedBrief } : {}),
    },
  };
}
