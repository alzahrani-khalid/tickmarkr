import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Assignment, type BillingChannel, channelKey, type WorkerAdapter } from "../adapters/types.js";
import { DEFAULT_DIFF_CAP, type TickmarkrConfig, TIER_RANK } from "../config/config.js";
import { renderAcceptanceItem, type Task } from "../graph/schema.js";
import { getAdapter } from "../adapters/registry.js";
import { shOk } from "../run/git.js";
import { redactSecrets } from "../run/redact.js";
import { marginalCostRank } from "../route/router.js";
import { appendAnchoredReview, COMPLETION_FAKING_CHECKLIST, extractVerdictJson, generateVerdictNonce, type GateVia, runLlm, verdictNonceLine } from "./llm.js";
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

// v1.82 T1 — the cap bounds what a READER MUST READ, not what a run must write. A regeneration of the
// frame corpora is ~134KB of `-U0` measurement before a source line changes, and nobody reads it: those
// frames are asserted byte-for-byte by the corpus tests. Counting them is the category error this
// removes. The two artifacts stay two (OBS-48: the cap measures -U0, the reader receives the full diff);
// the exclusion is applied to both, identically, right here so BOTH measuring gates inherit it.
//
// Clause 1 — membership is an EXACT PATH match against the shipped capture manifest, the same lists the
// regeneration path itself uses. Location, directory depth and file extension confer nothing: an
// unmanifested file sitting beside real frames is measured and shown in full. (The anchors deliberately
// share basenames with the frames; only the full path separates the oracle from its regenerable twin.)
//
// The members are LISTED here rather than imported from the manifest module, for one measured reason:
// that module is the Ink/React renderer, and importing it puts the whole TUI in every gate's module
// graph — which also memoises chalk's colour level at import time and turns the fleet suite red. A
// drift test in tests/gates/diff-cap.test.ts asserts this list is exactly GOLDEN_FRAME_CASES +
// COLOUR_FRAME_CASES and that every entry exists on disk, so it is a copy that cannot drift rather
// than a second source of truth: add or rename a frame case and that test goes red until this matches.
export const REGENERABLE_CAPTURE_PATHS: readonly string[] = [
  "tests/fixtures/cockpit/frames/run.width-stacked.80x24.txt",
  "tests/fixtures/cockpit/frames/run.width-folded-keys.100x24.txt",
  "tests/fixtures/cockpit/frames/run.width-three-column.140x24.txt",
  "tests/fixtures/cockpit/frames/run.height-14.140x14.txt",
  "tests/fixtures/cockpit/frames/run.height-18.140x18.txt",
  "tests/fixtures/cockpit/frames/run.height-24.140x24.txt",
  "tests/fixtures/cockpit/frames/run.height-40.140x40.txt",
  "tests/fixtures/cockpit/frames/run.no-colour.140x24.txt",
  "tests/fixtures/cockpit/frames/run.non-tty.140x24.txt",
  "tests/fixtures/cockpit/frames/run.ci.140x24.txt",
  "tests/fixtures/cockpit/frames/setup.width-stacked.80x24.txt",
  "tests/fixtures/cockpit/frames/setup.width-folded-keys.100x24.txt",
  "tests/fixtures/cockpit/frames/setup.width-three-column.140x24.txt",
  "tests/fixtures/cockpit/frames/setup.height-14.140x14.txt",
  "tests/fixtures/cockpit/frames/setup.height-18.140x18.txt",
  "tests/fixtures/cockpit/frames/setup.height-24.140x24.txt",
  "tests/fixtures/cockpit/frames/setup.height-40.140x40.txt",
  "tests/fixtures/cockpit/frames/setup.no-colour.140x24.txt",
  "tests/fixtures/cockpit/frames/setup.non-tty.140x24.txt",
  "tests/fixtures/cockpit/frames/setup.ci.140x24.txt",
  "tests/fixtures/cockpit/colour/run-20260718-000943.colour.140x24.txt",
  "tests/fixtures/cockpit/colour/run-20260718-000943.no-colour.140x24.txt",
  "tests/fixtures/cockpit/colour/run-20260725-025004.interrupted.colour.140x24.txt",
];
const CAPTURE_MANIFEST: ReadonlySet<string> = new Set(REGENERABLE_CAPTURE_PATHS);

// Clause 2 — the frozen appearance anchors and the captured engagement journals are NEVER set aside and
// are exempt from every other reduction too (clause 5): they are reviewed, immutable evidence. The
// anchors are the oracle this milestone declares, and the fixture law bans editing a captured journal to
// satisfy an assertion — so both keep counting toward the cap and keep reaching a reader verbatim.
export const PROTECTED_EVIDENCE_PREFIXES = [
  "tests/fixtures/cockpit/anchors/",
  "tests/fixtures/cockpit/sources/",
  "tests/fixtures/cockpit/colour/sources/",
] as const;

export function isProtectedEvidence(path: string): boolean {
  return PROTECTED_EVIDENCE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const SET_ASIDE_RECEIPT = /^set aside: regenerable capture (.+?) — \d+ bytes withheld\b/m;

/** The `{path}` a set-aside receipt names, or null if this section carries no receipt. */
export function setAsideReceiptPath(section: string): string | null {
  return SET_ASIDE_RECEIPT.exec(section)?.[1] ?? null;
}

// `--- a/x` / `+++ b/x` → "x"; "/dev/null" → null, which is the ABSENCE of a side, not a membership
// failure (clause 3). git quotes paths carrying specials, so unquote before stripping the a/ b/ prefix.
function diffSidePath(raw: string): string | null {
  const v = raw.trim();
  if (v === "/dev/null") return null;
  const unquoted = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  return unquoted.replace(/^[ab]\//, "");
}

interface DiffSection { lines: string[]; minus: number; sides: [string | null, string | null]; body: string[] }

// The `--- a/x` / `+++ b/x` header pair and the hunk lines below it. Clause 4 — null when the section
// carries NO content hunk at all (a mode-only change, a pure rename, a binary marker): such a section is
// left exactly as git wrote it rather than handed a manufactured receipt.
function parseSection(section: string): DiffSection | null {
  const lines = section.split("\n");
  const minus = lines.findIndex((l) => l.startsWith("--- "));
  if (minus === -1 || !lines[minus + 1]?.startsWith("+++ ")) return null;
  const body = lines.slice(minus + 2);
  if (!body.some((l) => l.startsWith("@@ "))) return null;
  return { lines, minus, sides: [diffSidePath(lines[minus]!.slice(4)), diffSidePath(lines[minus + 1]!.slice(4))], body };
}

// The content a one-sided section carries: its hunk lines with the sign stripped, keeping git's
// `\ No newline at end of file` markers so a trailing-newline difference still reads as a content
// difference. Hunk headers are dropped — a delete and an add of the same bytes never share them.
function hunkPayload(body: string[], sign: "+" | "-"): string {
  return body.filter((l) => l.startsWith(sign) || l.startsWith("\\")).map((l) => (l[0] === sign ? l.slice(1) : l)).join("\n");
}

// Clause 4 — a hunk is NOT proof of a content change. Git spells a KIND change (regular file ⇄ symlink)
// as a delete plus an add of the SAME path, each carrying a hunk, so when the regular file's bytes are
// exactly the link target both halves carry identical payloads: the kind changed and the content did
// not. Nothing was withheld, so neither half earns a receipt — and neither half can see the other, so
// the pairing is found across sections before any one of them is set aside.
function kindOnlyPaths(sections: string[]): ReadonlySet<string> {
  const removed = new Map<string, string>();
  const added = new Map<string, string>();
  for (const section of sections) {
    const parsed = parseSection(section);
    if (!parsed) continue;
    const [a, b] = parsed.sides;
    if (a && !b) removed.set(a, hunkPayload(parsed.body, "-"));
    else if (b && !a) added.set(b, hunkPayload(parsed.body, "+"));
  }
  return new Set([...removed].filter(([path, payload]) => added.get(path) === payload).map(([path]) => path));
}

function setAsideSection(section: string, kindOnly: ReadonlySet<string>): string {
  const parsed = parseSection(section);
  if (!parsed) return section;
  const { lines, minus, sides } = parsed;
  // Clause 3 — the test is over the sides that name a real file. Requiring BOTH sides to be members
  // makes every corpus addition (a-side /dev/null) and deletion (b-side /dev/null) ineligible, which is
  // exactly the frames this milestone adds. A rename crossing the boundary in either direction has two
  // real sides and one of them is not a member, so it stays whole — `rename from` line included.
  const named = sides.filter((p): p is string => p !== null);
  if (!named.length || !named.every((p) => CAPTURE_MANIFEST.has(p))) return section;
  // Clause 4 — both halves of a content-identical kind change are left exactly as git wrote them. A
  // kind change that DID move bytes is an ordinary content change and is set aside like any other.
  if (named.some((p) => kindOnly.has(p))) return section;
  const withheld = lines.slice(minus).join("\n");
  // Clause 6 — the claimed size is the UTF-8 BYTE length of what was withheld (the file headers and
  // hunks this receipt replaces), never a JavaScript string length: box-drawing frames make the two
  // disagree. And the receipt itself is part of the measured artifact, so N set-aside sections can never
  // measure as nothing while producing an arbitrarily large reader payload.
  const receipt = `set aside: regenerable capture ${named.at(-1)} — ${Buffer.byteLength(withheld, "utf8")} bytes withheld (regenerable frame corpus: asserted byte-for-byte by the corpus tests, never read)`;
  // Clause 4 — everything git said happened survives verbatim: old/new mode, new file mode, deleted file
  // mode, similarity index, rename from/to, index. Only content is replaced, so a deletion is never
  // presented as a file that still exists and an addition is never presented as a modification.
  return `${lines.slice(0, minus).join("\n")}\n${receipt}\n`;
}

/** Replace the content of every section confined to the regenerable frame corpora with a receipt. */
export function setAsideRegenerableCaptures(diff: string): string {
  if (!diff.includes("diff --git ")) return diff;
  const sections = diff.split(/(?=^diff --git )/m);
  const kindOnly = kindOnlyPaths(sections);
  return sections.map((s) => setAsideSection(s, kindOnly)).join("");
}

export async function fetchTaskDiff(worktree: string, baseRef: string): Promise<{ full: string; forCap: string }> {
  const full = setAsideRegenerableCaptures(await shOk(`git diff '${baseRef}..HEAD'`, worktree));
  const forCap = setAsideRegenerableCaptures(await shOk(`git diff -U0 '${baseRef}..HEAD'`, worktree));
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

// OBS-196: the two observed unparseable causes are different defects — a cutoff/empty output is
// reviewer infrastructure dying mid-flight; a malformed verdict is a parse defect. Neither is
// evidence about the WORK, which is why run-gates retries the review, never the worker (OBS-193).
export type ReviewUnparseableCause = "empty-output" | "no-verdict" | "malformed-verdict";

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
  if (task.complexity < cfg.review.complexityThreshold) {
    return { gate: "review", pass: true, details: `skipped — complexity ${task.complexity} < threshold ${cfg.review.complexityThreshold}`, meta: { skipped: true } };
  }
  const reviewer = pickReviewer(author, channels, excludeReviewers ?? [], cfg.review.prefer ?? []);
  if (!reviewer) {
    // meta.noEligibleReviewer lets run-gates' review-retry keep the ORIGINAL unparseable result when
    // the retry finds no second seat — a truthful cause beats a synthetic no-reviewer failure.
    return cfg.review.required
      ? { gate: "review", pass: false, details: "no cross-vendor reviewer available (diversity rule); set review.required:false to waive", meta: { noEligibleReviewer: true } }
      : { gate: "review", pass: true, details: "WARNING: no cross-vendor reviewer available — review waived by config", meta: { noEligibleReviewer: true } };
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
    const cause: ReviewUnparseableCause = raw.trim().length === 0
      ? "empty-output"
      : !raw.includes(nonce) ? "no-verdict" : "malformed-verdict";
    let saved: string | undefined;
    if (artifactDir) {
      try {
        saved = join(artifactDir, `review-raw-${task.id}-${Date.now()}.txt`);
        writeFileSync(saved, redactSecrets(raw));
      } catch {
        saved = undefined; // persistence is evidence, not a gate input — never fail the gate on it
      }
    }
    return {
      gate: "review",
      pass: false,
      details: `review output unparseable (reviewer ${reviewer.adapter}:${reviewer.model}; cause: ${cause}${saved ? `; raw saved: ${saved}` : ""}) — failing closed`,
      meta: { reviewer: channelKey(reviewer), unparseable: true, cause },
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
    meta: { reviewer: channelKey(reviewer) },
  };
}
