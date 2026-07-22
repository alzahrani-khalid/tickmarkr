import { type Assignment, type BillingChannel, channelKey, type WorkerAdapter } from "../adapters/types.js";
import { DEFAULT_DIFF_CAP, type TickmarkrConfig, TIER_RANK } from "../config/config.js";
import { renderAcceptanceItem, type Task } from "../graph/schema.js";
import { getAdapter } from "../adapters/registry.js";
import { shOk } from "../run/git.js";
import { marginalCostRank } from "../route/router.js";
import { COMPLETION_FAKING_CHECKLIST, extractVerdictJson, generateVerdictNonce, type GateVia, runLlm, verdictNonceLine } from "./llm.js";
import type { GateResult } from "./types.js";

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
export interface ReviewVerdict { approve?: boolean; issues?: string[]; findings?: ReviewFinding[] }

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

export async function fetchTaskDiff(worktree: string, baseRef: string): Promise<{ full: string; forCap: string }> {
  const full = await shOk(`git diff '${baseRef}..HEAD'`, worktree);
  const forCap = await shOk(`git diff -U0 '${baseRef}..HEAD'`, worktree);
  return { full, forCap };
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

export function isDiffCapPark(result: GateResult): boolean {
  return result.pass === false && result.meta?.park === "human" && /diff exceeds verifiable cap/i.test(result.details);
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
): Promise<GateResult> {
  if (task.complexity < cfg.review.complexityThreshold) {
    return { gate: "review", pass: true, details: `skipped — complexity ${task.complexity} < threshold ${cfg.review.complexityThreshold}`, meta: { skipped: true } };
  }
  const reviewer = pickReviewer(author, channels, excludeReviewers ?? [], cfg.review.prefer ?? []);
  if (!reviewer) {
    return cfg.review.required
      ? { gate: "review", pass: false, details: "no cross-vendor reviewer available (diversity rule); set review.required:false to waive" }
      : { gate: "review", pass: true, details: "WARNING: no cross-vendor reviewer available — review waived by config" };
  }
  const { full: diff, forCap } = await fetchTaskDiff(worktree, baseRef);
  const diffCap = cfg.gates.diffCap ?? DEFAULT_DIFF_CAP;
  const capFail = checkDiffCap("review", forCap.length, diffCap);
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
{"nonce": "${nonce}", "approve": true|false, "findings": [{"note": "...", "severity": "material"|"minor", "defer": false, "rationale": ""}]}
Approve iff no material finding remains; an empty findings list is a clean approval.
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
    return {
      gate: "review",
      pass: false,
      details: `review output unparseable (reviewer ${reviewer.adapter}:${reviewer.model}) — failing closed`,
      meta: { reviewer: channelKey(reviewer) },
    };
  }
  const decided = findings !== null
    ? classifyReviewFindings(findings)
    : classifyReviewIssues(v.approve as boolean, v.issues as unknown[]);
  return {
    gate: "review",
    pass: decided.pass,
    details: `reviewer ${reviewer.adapter}:${reviewer.model} (${reviewer.vendor}): ${decided.headline}${decided.lines.length ? "\n" + decided.lines.join("\n") : ""}`,
    meta: { reviewer: channelKey(reviewer) },
  };
}
