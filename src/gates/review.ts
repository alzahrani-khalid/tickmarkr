import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Assignment, type BillingChannel, channelKey, shq, type WorkerAdapter } from "../adapters/types.js";
import {
  criticalPathHits, DEFAULT_DIFF_CAP, DEFAULT_REVIEW_CRITICAL_PATHS, declaredReviewPolicy,
  isReviewLeafPath, raiseReviewPolicy, type ReviewPolicy, REVIEW_VERSION_MIRRORS,
  type TickmarkrConfig, TIER_RANK,
} from "../config/config.js";
import { renderAcceptanceItem, type Task } from "../graph/schema.js";
import { getAdapter } from "../adapters/registry.js";
import { shOk } from "../run/git.js";
import { redactSecrets } from "../run/redact.js";
import { marginalCostRank } from "../route/router.js";
import { appendAnchoredReview, COMPLETION_FAKING_CHECKLIST, extractVerdictJson, generateVerdictNonce, type GateVia, runLlm, verdictNonceLine } from "./llm.js";
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
    diff = await shOk(`git diff -U0 '${baseRef}..HEAD' -- ${shq(path)}`, worktree);
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

export async function fetchTaskDiff(worktree: string, baseRef: string): Promise<TaskDiffMeasurement> {
  const [rawFull, rawForCap] = await Promise.all([
    shOk(`git diff '${baseRef}..HEAD'`, worktree),
    shOk(`git diff -U0 '${baseRef}..HEAD'`, worktree),
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
    // daemon/run-gates: park('human') immediately — the diff cannot shrink by retrying (OBS-48).
    meta: { park: "human" },
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
    meta: { park: "human" },
  };
}

export function isDiffCapPark(result: GateResult): boolean {
  return result.pass === false
    && result.meta?.park === "human"
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

// v1.53 T2: same entry grammar as routing.map.prefer (router.ts preferIndex — router is out of this
// module's dependency direction for a private fn, so the 3 lines live here too): `adapter` matches
// every channel of that adapter, `adapter:model` exactly one; unmatched channels sort after all entries.
function reviewPreferIndex(c: BillingChannel, prefer: string[]): number {
  const i = prefer.findIndex((p) => p === c.adapter || p === channelKey(c));
  return i === -1 ? prefer.length : i;
}

export function pickReviewer(
  author: Assignment,
  channels: BillingChannel[],
  exclude: string[] = [], // v1.1 failover: reviewer channels that already produced garbage for this task
  prefer: string[] = [], // v1.53 T2: review.prefer — reorders eligible channels, never changes eligibility
): BillingChannel | null {
  // FLEET-05 success criterion 2: an author not resolvable in the channel list yields NO reviewer.
  // The old `?? author.adapter` fallback compared an adapter id to vendor names, matched nothing, and
  // admitted every reviewer — including the author's own channel (fail-OPEN). null lands on reviewGate's
  // fail-closed branch under review.required.
  const authorChannel = channels.find((c) => c.adapter === author.adapter && c.model === author.model);
  if (!authorChannel) return null;
  return (
    channels
      // two independent axes: different vendor AND different base-model identity (ADDED TO the vendor
      // rule, never replacing it — a future edit can't silently drop either). The diversity filter runs
      // BEFORE preference ranking: prefer sorts survivors only, so no entry can resurrect an excluded channel.
      .filter((c) => c.vendor !== authorChannel.vendor && modelId(c.model) !== modelId(author.model) && !exclude.includes(channelKey(c)))
      .sort((a, b) => reviewPreferIndex(a, prefer) - reviewPreferIndex(b, prefer) || TIER_RANK[b.tier] - TIER_RANK[a.tier] || marginalCostRank(a) - marginalCostRank(b))[0] ?? null
  );
}

// OBS-196: the two observed unparseable causes are different defects — a cutoff/empty output is
// reviewer infrastructure dying mid-flight; a malformed verdict is a parse defect. Neither is
// evidence about the WORK, which is why run-gates retries the review, never the worker (OBS-193).
export type ReviewUnparseableCause = VerdictUnparseableCause;

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
  const declaredPolicy = declaredReviewPolicy(task.files);
  const policy = raiseReviewPolicy(declaredPolicy, cfg.review.policy);
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
  const reviewer = pickReviewer(author, channels, excludeReviewers ?? [], cfg.review.prefer ?? []);
  if (!reviewer) {
    // meta.noEligibleReviewer lets run-gates' review-retry keep the ORIGINAL unparseable result when
    // the retry finds no second seat — a truthful cause beats a synthetic no-reviewer failure.
    return cfg.review.required
      ? { gate: "review", pass: false, details: "no cross-vendor reviewer available (diversity rule); set review.required:false to waive", meta: { noEligibleReviewer: true } }
      : { gate: "review", pass: true, details: "WARNING: no cross-vendor reviewer available — review waived by config", meta: { noEligibleReviewer: true } };
  }
  const measuredDiff = await fetchTaskDiff(worktree, baseRef);
  // Keep the reader payload identical to the text charged to the strict cap:
  // whole-file source deletions are represented by their citable operation fact.
  const diff = reviewableLogicDiff(measuredDiff.full);
  const diffCap = cfg.gates.diffCap ?? DEFAULT_DIFF_CAP;
  const capFail = checkTaskDiffCaps("review", measuredDiff, diffCap);
  if (capFail) return capFail;
  const nonce = generateVerdictNonce();
  const prompt = `TICKMARKR-REVIEW
You are a skeptical cross-vendor code reviewer. Another agent (vendor: ${author.adapter}) authored this diff.
Look for correctness bugs, security issues, and acceptance-criteria gaps. Approve only if you would merge it.

${COMPLETION_FAKING_CHECKLIST}

## Task ${task.id}: ${task.title} (complexity ${task.complexity})
## Acceptance criteria
${task.acceptance.map((a) => `- ${renderAcceptanceItem(a)}`).join("\n")}

## Diff
\`\`\`diff
${diff}
\`\`\`

${verdictNonceLine(nonce)}

Classify every concern as "material" (a correctness, security, or acceptance-criteria defect that must
block the merge) or "minor" (style, naming, or preference that should not block). ONLY material findings
block approval. For a minor concern you have decided not to block on, set "defer": true and give a
one-line "rationale" — it is recorded in the review, never dropped.

Respond with ONLY this JSON:
{"nonce": "${nonce}", "approve": true|false, "findings": [{"note": "...", "severity": "material"|"minor", "defer": false, "rationale": ""}], "comments": [{"path": "path/to/file", "line": 42, "body": "actionable feedback"}]}
Approve iff no material finding remains; an empty findings list is a clean approval.
The top-level comments array is optional. Use it only for actionable line-anchored feedback.
`;
  const raw = await runLlm(
    getAdapter(reviewer.adapter, adapters),
    reviewer.model,
    prompt,
    worktree,
    via ? { driver: via.driver, keep: via.keep, onSlot: via.onSlot, name: via.nameFor("review", reviewer.adapter), label: via.labelFor("review") } : undefined,
    // frontier reviewers routinely need >5min on a configured-cap-sized diff, and `claude -p` buffers all
    // output until completion — runLlm's 300s default killed reviews mid-flight, returning empty
    // stdout that read as "unparseable" and escalated to re-implementation of green code
    // (run-20260709-104447 P87-09). ponytail: literal 15min; make it cfg.review.timeoutMs if a
    // second knob-turner appears.
    900_000,
  );
  const v = extractVerdictJson<ReviewVerdict>(raw, nonce);
  const findings = v && Array.isArray(v.findings) ? (v.findings as unknown[]) : null;
  // findings decides the verdict on its own; the legacy path still needs approve + issues to parse.
  if (!v || (findings === null && (typeof v.approve !== "boolean" || !Array.isArray(v.issues)))) {
    // OBS-196: name the cause and persist the raw bytes — a ruled-on "unparseable" without its
    // evidence cannot be audited, and a cutoff must never be indistinguishable from a parse defect.
    const cause: ReviewUnparseableCause = classifyVerdictCause(raw, nonce, "approve");
    let saved: string | undefined;
    if (artifactDir) {
      try {
        saved = join(artifactDir, `review-raw-${task.id}-${Date.now()}.txt`);
        writeFileSync(saved, redactSecrets(raw));
      } catch {
        saved = undefined; // persistence is evidence, not a gate input — never fail the gate on it
      }
    }
    const failure = cause === "malformed-verdict"
      ? "review output unparseable"
      : "review dispatch failed — no structurally valid nonce-bound response; output unparseable";
    return {
      gate: "review",
      pass: false,
      details: `${failure} (reviewer ${reviewer.adapter}:${reviewer.model}; cause: ${cause}${saved ? `; raw saved: ${saved}` : ""}) — failing closed`,
      meta: { ...policyMeta, reviewer: channelKey(reviewer), unparseable: true, cause },
    };
  }
  const decided = findings !== null
    ? classifyReviewFindings(findings)
    : classifyReviewIssues(v.approve as boolean, v.issues as unknown[]);
  const prose = `reviewer ${reviewer.adapter}:${reviewer.model} (${reviewer.vendor}): ${decided.headline}${decided.lines.length ? "\n" + decided.lines.join("\n") : ""}`;
  return {
    gate: "review",
    pass: decided.pass,
    details: appendAnchoredReview(prose, v),
    meta: { ...policyMeta, reviewer: channelKey(reviewer) },
  };
}
