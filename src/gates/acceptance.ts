import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { channelKey, shq, type WorkerAdapter } from "../adapters/types.js";
import { compileNative } from "../compile/native.js";
import { DEFAULT_DIFF_CAP } from "../config/config.js";
import { type Effort, renderAcceptanceItem, type AcceptanceItem, type Task } from "../graph/schema.js";
import { sh } from "../run/git.js";
import { checkTaskDiffCaps, fetchTaskDiff, isProtectedEvidence, setAsideReceiptPath } from "./review.js";
import { appendAnchoredReview, COMPLETION_FAKING_CHECKLIST, extractVerdictJson, generateVerdictNonce, type LlmVia, runLlm, SeatLaunchError, verdictNonceLine } from "./llm.js";
import type { GateResult } from "./types.js";
import { classifyVerdictCause } from "./verdict-cause.js";
import { reviewableLogicDiff } from "./artifact-manifest.js";
import { diffSidePath } from "./git-paths.js";
import { classifyFailureOutput } from "./baseline.js";
import { operationFactsAtHead, readOperationFacts } from "./operation-facts.js";

// Fable F4: acceptance judge shares review's 900s timeout — 300s default killed frontier judges on cap-sized diffs.
const JUDGE_TIMEOUT_MS = 900_000;

// Queue row 23 (ANL-021 S23): only a structured {path, line} citation inside the changed map validates — a line of a
// changed hunk, or line 0 of a recorded operation fact (a set-aside receipt, a removed protected file, a typed fact).
// No option accepts a string: a quote of the diff (even a verbatim changed hunk, even "+") is a malformed verdict,
// because any substring of the diff text, its own framing included, matched the retired v1.64 legacy-quote check.
export interface EvidenceCitation { path: string; line: number }
export interface JudgeVerdict {
  pass: boolean;
  criteria: Array<{ criterion: string; met: boolean; reason: string; evidence: EvidenceCitation }>;
  comments?: Array<{ path: string; line: number; body: string }>;
}

const CitationSchema = z.object({ path: z.string(), line: z.number().int() });
const JudgeVerdictRowSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  reason: z.string(),
  // Required: a row omitting evidence is malformed and fails closed like any other shape violation.
  evidence: CitationSchema,
});

const JudgeVerdictSchema = z.object({
  pass: z.boolean(),
  criteria: z.array(JudgeVerdictRowSchema),
});

export function judgeCriterionId(index: number): string {
  return `c${index + 1}`;
}

function renderJudgeCriterion(item: AcceptanceItem, index: number): string {
  return `[${judgeCriterionId(index)}] ${renderAcceptanceItem(item)}`;
}

function checkJudgeVerdict(
  v: JudgeVerdict,
  expectedIds: readonly string[],
): string[] {
  const inconsistencies: string[] = [];
  const counts = new Map<string, number>();

  for (const row of v.criteria) {
    counts.set(row.criterion, (counts.get(row.criterion) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) inconsistencies.push(`judge verdict inconsistent: duplicate criterion id ${id}`);
    if (!expectedIds.includes(id)) inconsistencies.push(`judge verdict inconsistent: unknown criterion id ${id}`);
  }
  for (const id of expectedIds) {
    if (!counts.has(id)) inconsistencies.push(`judge verdict inconsistent: missing criterion id ${id}`);
  }
  for (const row of v.criteria) {
    if (!row.met && v.pass) {
      inconsistencies.push(`judge verdict inconsistent: pass=true contradicts unmet criterion ${row.criterion}`);
    }
  }
  if (!v.pass && v.criteria.every((row) => row.met) && inconsistencies.length === 0 && v.criteria.length === expectedIds.length) {
    inconsistencies.push("judge verdict inconsistent: pass=false contradicts all criteria met");
  }

  return inconsistencies;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// S23: the RAW verdict's citation shape, checked before the schema so a string, null or absent evidence, or a
// non-array criteria, is a protocol failure rather than a charged red. Reads fields only, never converts one.
function rawCitationsWellFormed(raw: Record<string, unknown>): boolean {
  return Array.isArray(raw.criteria) && raw.criteria.every((row) => isRecord(row) && isRecord(row.evidence)
    && typeof row.evidence.path === "string" && Number.isSafeInteger(row.evidence.line));
}

// v1.19 (T2): deterministic oracles run mechanically, fail-closed, BEFORE any LLM judge dispatch.
// A judge verdict can NEVER override a failed command/test — the judge simply does not run if one failed
// (the gate returns on the first deterministic failure, below the only runLlm call). Plain-string
// acceptance items are the read-old/write-new compat form of a judge oracle (schema.ts §2).
type CommandOracle = Extract<AcceptanceItem, { oracle: "command" }>;
type TestOracle = Extract<AcceptanceItem, { oracle: "test" }>;
const isCommand = (a: AcceptanceItem): a is CommandOracle => typeof a === "object" && a.oracle === "command";
const isTest = (a: AcceptanceItem): a is TestOracle => typeof a === "object" && a.oracle === "test";
const isJudge = (a: AcceptanceItem) => typeof a === "string" || (typeof a === "object" && a.oracle === "judge");

// npm/yarn/pnpm/npx script wrappers need `--` to forward -t to the underlying vitest/jest runner; a bare
// runner (vitest/jest) takes -t directly. -t is the shared testNamePattern shorthand both honor.
// OBS-62: vitest -t treats the name as a regex — escape metachars so a verbatim-titled test matches.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// v1.89 T6: Vitest applies -t to the runner-visible full name (enclosing describe titles and the test
// title, space-joined). Escaping preserves literal criteria; the leaf anchor makes trailing-title
// equality, rather than substring containment, the named-test contract.
// OBS-511 (runs 1013+1027, one full attempt lost in EACH): two independent workers nested the verbatim
// criterion under a describe, the old `^…$` full-name equality matched zero tests, and the gate parked a
// green suite. `(^| )` accepts any describe prefix while keeping the criterion as the complete trailing
// segment — equality still matches (empty prefix), and a title merely CONTAINING the criterion still
// selects zero. ponytail: a leaf title that itself ENDS with " <criterion>" also matches — vitest -t sees
// only the space-joined full name, so true leaf-boundary precision needs the runner's --list JSON
// (auditAcceptanceCorpus has it at doctor time); upgrade there if this window is ever exploited.
export function testFilterPattern(name: string): string {
  return `(^| )${escapeRegExp(name)}$`;
}

// OBS-55: when the base command already contains `--`, append -t after forwarded args — a second `--`
// makes vitest treat -t as a positional file filter and the name filter is dropped.
export function testFiltered(testCmd: string, name: string): string {
  const pattern = testFilterPattern(name);
  const wrapped = /^\s*(npm|yarn|pnpm|npx)\b/.test(testCmd);
  if (wrapped && /\s--\s/.test(testCmd)) return `${testCmd} -t ${shq(pattern)}`;
  const fwd = wrapped ? "-- " : "";
  return `${testCmd} ${fwd}-t ${shq(pattern)}`;
}

export interface VitestListedTest {
  name: string;
  file: string;
  projectName?: string;
}

export type VitestListResult =
  | { status: "listed"; tests: VitestListedTest[] }
  | { status: "failed"; error: string };

const VitestListedTestsSchema = z.array(z.object({
  name: z.string(),
  file: z.string(),
  projectName: z.string().optional(),
}));

export async function listVitestTests(cwd: string): Promise<VitestListResult> {
  const result = await sh(`${shq(join(cwd, "node_modules/.bin/vitest"))} list --json`, cwd);
  if (result.code !== 0) {
    return { status: "failed", error: (result.stderr || result.stdout || `exit ${result.code}`).trim() };
  }
  try {
    const start = result.stdout.indexOf("[");
    if (start < 0) return { status: "failed", error: "runner emitted no JSON test listing" };
    const parsed = VitestListedTestsSchema.safeParse(JSON.parse(result.stdout.slice(start)));
    return parsed.success
      ? { status: "listed", tests: parsed.data }
      : { status: "failed", error: z.prettifyError(parsed.error) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export interface NamedTestAudit {
  criterion: string;
  matches: VitestListedTest[];
}

export function auditNamedTestOracles(
  items: readonly AcceptanceItem[],
  listedTests: readonly VitestListedTest[],
): NamedTestAudit[] {
  const runnerNames = listedTests.map((listed) => ({
    listed,
    fullName: listed.name.split(" > ").join(" "),
  }));
  return items.flatMap((item) => {
    if (typeof item !== "object" || item.oracle !== "test") return [];
    return [{
      criterion: item.test,
      // OBS-511: mirror the gate's leaf-anchored suffix rule — this denominator must count
      // exactly the tests the shipped -t filter would select.
      matches: runnerNames
        .filter(({ fullName }) => fullName === item.test || fullName.endsWith(` ${item.test}`))
        .map(({ listed }) => listed),
    }];
  });
}

export type AcceptanceCorpusAuditResult =
  | {
    specPath: string;
    status: "parse-failed";
    error: string;
  }
  | {
    specPath: string;
    status: "parsed";
    item: AcceptanceItem;
    namedTest?: {
      criterion: string;
      matches: VitestListedTest[];
    };
  };

function corpusSpecPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".spec.md")) paths.push(path);
    }
  };
  visit(root);
  return paths;
}

// v1.89 T6: mechanically bind the complete spec-corpus denominator to the runner's all-project JSON
// listing. Every discovered path contributes either all parser-produced acceptance items or one named
// parse failure; exceptions are evidence, never permission to shrink the corpus silently.
export function auditAcceptanceCorpus(
  corpusRoot: string,
  listedTests: readonly VitestListedTest[],
): AcceptanceCorpusAuditResult[] {
  const results: AcceptanceCorpusAuditResult[] = [];
  for (const specPath of corpusSpecPaths(corpusRoot)) {
    try {
      const graph = compileNative(specPath);
      for (const task of graph.tasks) {
        for (const item of task.acceptance) {
          const namedTest = auditNamedTestOracles([item], listedTests)[0];
          results.push({
            specPath,
            status: "parsed",
            item,
            ...(namedTest ? { namedTest } : {}),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ specPath, status: "parse-failed", error: `${specPath}: ${message}` });
    }
  }
  return results;
}

// vitest/jest summary: "Tests  N passed | M skipped (T)" — count passed+failed as actually ran.
function testsRan(output: string): number | null {
  const lines = output.replace(/\x1b\[[\d;#]*[A-Za-z]/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    const m = line.match(/^Tests\s+(.+?)\s*\(\d+\)\s*$/);
    if (!m) continue;
    let ran = 0;
    for (const chunk of m[1].split("|").map((s) => s.trim())) {
      const n = chunk.match(/^(\d+)\s+(passed|failed)\b/);
      if (n) ran += Number(n[1]);
    }
    return ran;
  }
  return null;
}

// last few non-empty output lines, for context on a failing oracle (capped so details stay readable)
function tail(out: string, n = 8): string {
  const t = out.trim();
  if (!t) return "";
  return "\n" + t.split("\n").slice(-n).join("\n");
}

/**
 * OBS-540/551: classify only execution evidence produced by the deterministic oracle process. That
 * includes its output, exit status and runner-reported test count — never judge-authored prose. A
 * nonzero command with an infra-only output shape, one of the enumerated signal exits, or a zero-run
 * report without a failure identity returned no product verdict, so it remains fail-closed but cannot
 * be billed as a diff failure. A parsed judge refusal is an evaluated quality verdict whatever its
 * prose says. As in baseline classification, a named regression remains a verdict even if teardown
 * later exits through a signal.
 */
function oracleExecutionFailure(label: string, code: number, stdout: string, stderr: string): GateResult {
  const output = [stderr, stdout].filter((part) => part.length > 0).join("\n");
  const classification = classifyFailureOutput(output);
  const signalName = code === 143 ? "SIGTERM" : code === 137 ? "SIGKILL" : undefined;
  const signalKilled = signalName !== undefined && classification !== "regression";
  const signalEvidence = signalKilled
    ? `signal-shaped exit ${code} (${signalName}); `
    : "";
  const zeroRun = testsRan(output) === 0 && classification !== "regression";
  const zeroRunEvidence = zeroRun ? "the runner reported zero tests run and no failure identity; " : "";
  if (classification === "infra" || signalKilled || zeroRun) {
    return {
      gate: "acceptance",
      pass: false,
      details: `oracle failed: ${label} (exit ${code}) — ${signalEvidence || zeroRunEvidence}infrastructure blocked execution before a verdict; this oracle verified nothing${tail(output)}`,
      meta: { cause: "oracle-execution", classification: "infra", infra: true, retryable: false },
    };
  }
  return {
    gate: "acceptance",
    pass: false,
    details: `oracle failed: ${label} (exit ${code})${tail(stderr || stdout)}`,
  };
}

// v1.70 / OBS-129: the new-file line numbers each changed HUNK spans, per path — parsed from the
// unified-diff so a citation is validated against real changed regions, not a substring of the whole
// diff text (which also matches the diff's own +++/@@ headers). A hunk's span is every new-file line it
// carries: the added (`+`) lines AND the context lines git includes around them.
// OBS-129: this is a changed-HUNK check, not an exact-added-LINE check. Requiring the exact `+` line made
// honest judges fail closed on correct work — two frontier judges cited an adjacent line of the same
// change (LLMs miscount exact line numbers), voiding the whole verdict. The anti-hallucination property
// holds: a citation outside every hunk, or to an untouched file, still fails (matching the documented
// "outside every changed hunk → rejected" contract in acceptance.test.ts).
// ponytail: assumes git's default a/ b/ prefixes (fetchTaskDiff uses plain `git diff`); revisit if a
// caller passes a --no-prefix diff. Queue row 71b: a +++ side is decoded by the shared git-paths reader (git's
// C-quoting and the tab that ends a space-holding name), so a non-ASCII file's lines are citable by its real name.
export function changedLinesByFile(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) { inHunk = false; path = null; continue; }
    if (!inHunk && raw.startsWith("--- ")) continue;
    if (!inHunk && raw.startsWith("+++ ")) {
      path = diffSidePath(raw.slice(4));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || path === null) continue;
    const c = raw[0];
    if (c === "+" || c === " ") {
      // OBS-129: record every new-file line the hunk spans — added AND context — so a citation to an
      // adjacent line of the same change validates, not only the exact `+` line.
      let set = byFile.get(path);
      if (!set) { set = new Set(); byFile.set(path, set); }
      set.add(newLine);
      newLine++;
    } else if (c !== "-" && c !== "\\") {
      // S23 (A04): "\ No newline at end of file" annotates the row above it and is skipped — it never ends the
      // hunk, so a replaced last line's `+` row after `-old` and its marker stays citable.
      inHunk = false; // a trailing blank or the next section — hunk body ended
    }
  }
  return byFile;
}

// S23: the citable index is one JSON line per changed path between nonce-framed markers. JSON escapes every
// line terminator but U+2028/U+2029, which are written as their six-character ASCII escapes, so no name can end
// an entry line, forge a marker or a heading, and JSON.parse of the line gives the name back exactly.
function citableIndexEntry(path: string, lines: Iterable<number>): string {
  return JSON.stringify({ path, lines: [...lines].sort((a, b) => a - b) })
    .replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

// Queue rows 128/129: "\n"-only line semantics — the m flag would also split a line at U+2028/U+2029.
const DIFF_SECTIONS = /(?<=^|\n)(?=diff --git )/;

// the a-side path of a whole-file deletion section, or null if this section is not one.
function deletedPath(section: string): string | null {
  if (!/(?<=^|\n)deleted file mode /.test(section)) return null;
  const oldPath = /(?<=^|\n)--- ([^\r\n]+)/.exec(section)?.[1]
    ?? /(?<=^|\n)Binary files ([^\r\n]+) and \/dev\/null differ(?=[\r\n]|$)/.exec(section)?.[1];
  // S23 (A05): decoded by the shared side reader (C-quoting, the tab after a spaced name), as artifact-manifest does.
  return oldPath ? diffSidePath(oldPath) : null;
}

// v1.82 T1 clause 7: the two shapes this task creates carry no changed hunk, so a judge asked to cite a
// changed line has nothing to cite — three review rounds died here. Each yields ONE citable operation
// fact, `{path, line: 0}`, read back from the judged text itself. Queue row 142 adds the three typed git
// facts (operation-facts.ts: a pure rename, an empty add, a mode-only change), measured from NUL-delimited
// raw output and never from this text. Only these RECORDED facts make line 0 citable; a zero line on any
// other path is still rejected as fabricated. Ordinary whole-file deletions stay uncitable deliberately:
// the relevance filter collapses them before this runs, and repairing that pre-existing limitation is
// outside this contract.
const OPERATION_FACT_LINE = 0;
function operationFactPaths(diff: string): string[] {
  return diff.split(DIFF_SECTIONS).flatMap((section) => {
    const receipt = setAsideReceiptPath(section);
    if (receipt) return [receipt];
    const path = deletedPath(section);
    return path && isProtectedEvidence(path) ? [path] : [];
  });
}

// A citation is valid evidence iff its pair is in the changed map: a line inside a changed hunk of the cited file
// (OBS-129: changed-hunk span, not exact-added-line) or line 0 of a recorded operation fact.
function citesChangedLocation(evidence: EvidenceCitation, changed: Map<string, Set<number>>): boolean {
  return changed.get(evidence.path)?.has(evidence.line) ?? false;
}

/** OBS-1151: one criterion of a parsed judge verdict, as the contradiction check compares it. */
export interface JudgedCriterion { id: string; criterion: string; met: boolean; paths: string[] }

export interface AcceptanceGateOpts {
  // the repo's test command (detectGateCommands); named-test oracles filter through it via -t.
  // Absent ⇒ a test oracle fails closed (cannot run a named test deterministically without a runner).
  testCmd?: string;
  diffCap?: number;
}

export async function acceptanceGate(
  task: Task,
  worktree: string,
  baseRef: string,
  // OBS-1182: the judge seat's OWN effort (absent = CLI default) — never the worker's.
  judge: { adapter: WorkerAdapter; model: string; effort?: Effort },
  via?: LlmVia,
  opts: AcceptanceGateOpts = {},
): Promise<GateResult> {
  // 1. deterministic oracles — exit code decides, fail-closed, zero LLM calls (spec §2, T2).
  //    A failure returns here, before any runLlm() call: a judge can never override it.
  const passedDet: string[] = [];
  for (const a of task.acceptance) {
    if (isCommand(a)) {
      const r = await sh(a.command, worktree);
      if (r.code !== 0) {
        return oracleExecutionFailure(`$ ${a.command}`, r.code, r.stdout, r.stderr);
      }
      passedDet.push(`✓ $ ${a.command} (exit 0)`);
    } else if (isTest(a)) {
      if (!opts.testCmd) {
        return { gate: "acceptance", pass: false,
          details: `oracle failed: test "${a.test}" — no test command configured to run it (failing closed)` };
      }
      const r = await sh(testFiltered(opts.testCmd, a.test), worktree);
      const out = (r.stderr || "") + "\n" + (r.stdout || "");
      if (r.code !== 0) {
        return oracleExecutionFailure(`test "${a.test}"`, r.code, r.stdout, r.stderr);
      }
      // OBS-55: exit 0 alone is vacuous when the name filter matched zero tests — fail closed.
      const ran = testsRan(out);
      if (ran === null || ran < 1) {
        return { gate: "acceptance", pass: false,
          details: `oracle failed: test "${a.test}" — name filter matched zero tests (filter: ${a.test})${tail(out)}` };
      }
      passedDet.push(`✓ test: ${a.test} (exit 0)`);
    }
  }

  // 2. judge items — only after every deterministic oracle passed (a failed one returned above).
  const judgeItems = task.acceptance.filter(isJudge);
  const detBlock = passedDet.length ? passedDet.join("\n") + "\n" : "";
  if (!judgeItems.length) {
    // deterministic oracles alone decided the gate — no LLM spend.
    return { gate: "acceptance", pass: true, details: passedDet.join("\n") || "no acceptance oracles" };
  }

  // spec §2: deterministic oracles preferred; an only-judge task gets an explicit warning in details.
  const onlyJudge = passedDet.length === 0;
  const warn = onlyJudge
    ? "WARNING: only judge oracles — no deterministic command/test oracle guards this task (deterministic preferred, spec §2).\n"
    : "";

  // queue row 142: the typed facts are bound to the commit HEAD resolves to BEFORE the judged diff is read,
  // and kept below only while HEAD still resolves to it after that read (fetchTaskDiff reads HEAD itself).
  const typed = await readOperationFacts(worktree, baseRef);
  const fetched = await fetchTaskDiff(worktree, baseRef);
  const diff = reviewableLogicDiff(fetched.full);
  const diffCap = opts.diffCap ?? DEFAULT_DIFF_CAP;
  const capFail = checkTaskDiffCaps("acceptance", fetched, diffCap, warn + detBlock);
  if (capFail) return capFail;
  const expectedIds = judgeItems.map((_, index) => judgeCriterionId(index));
  // OBS-129: give the judge the exact citable new-file line numbers per changed file, so it grounds each
  // citation in a real changed line instead of miscounting. Validated below against this same `changed`.
  const changed = changedLinesByFile(diff);
  // clause 7: fold the recorded operation facts into the same index the validator checks, so a change
  // made only of set-aside captures, removed protected evidence or a typed git fact still yields citable evidence.
  const typedPaths = (await operationFactsAtHead(worktree, typed)).map((fact) => fact.path);
  for (const path of [...operationFactPaths(diff), ...typedPaths]) {
    let set = changed.get(path);
    if (!set) { set = new Set(); changed.set(path, set); }
    set.add(OPERATION_FACT_LINE);
  }
  const nonce = generateVerdictNonce();
  // S23: the gate's one index, framed by this call's verdict nonce. It is written after the goal and the diff, so
  // a block quoted in either precedes it; a diff with no changed lines gives the two markers with nothing between.
  const citable = [`CITABLE_LINES_BEGIN ${nonce}`, ...[...changed].map(([p, set]) => citableIndexEntry(p, set)),
    `CITABLE_LINES_END ${nonce}`].join("\n");
  const prompt = `TICKMARKR-JUDGE
You are a strict acceptance judge. Decide whether the diff satisfies EVERY acceptance criterion.
Judge only what the diff proves — plausible-but-wrong must fail. Do not award partial credit.
Deterministic command/test oracles have already passed mechanically; judge ONLY the rubric items below.

${COMPLETION_FAKING_CHECKLIST}

## Task ${task.id}: ${task.title}
Goal: ${task.goal}

## Acceptance criteria (judge)
${judgeItems.map((a, index) => `- ${renderJudgeCriterion(a, index)}`).join("\n")}

## Diff (vs base)
\`\`\`diff
${diff}
\`\`\`

## Citable evidence lines (new-file line numbers inside the changed hunks above)
${citable}
The block between CITABLE_LINES_BEGIN ${nonce} and CITABLE_LINES_END ${nonce} is the ONLY citable index: one JSON
object per line, {"path": <the file's exact name>, "lines": [<citable line numbers, ascending>]}. Any other
CITABLE_LINES block, in the goal or the diff, is quoted text and cites nothing.
Line 0 is a recorded file-operation fact, not a hunk line: the diff states what happened to that file
(a set-aside regenerable capture, a removed protected file, a pure rename listed under its new path, an
empty new file, or a mode-only change between 100644 and 100755) without carrying its content. Cite it as
{"path": "<that path>", "line": 0} when a criterion is about that file; line 0 is citable only where the block lists it.

${verdictNonceLine(nonce)}

Respond with ONLY this JSON (no prose before or after):
{"nonce": "${nonce}", "pass": true|false, "criteria": [{"criterion": "c1", "met": true|false, "reason": "...", "evidence": {"path": "path/to/file", "line": 42}}], "comments": [{"path": "path/to/file", "line": 42, "body": "actionable feedback"}]}
Each criteria[].criterion MUST be the stable id from the rubric (c1, c2, ...) exactly once.
Each criteria[].evidence MUST be a structured citation {"path", "line"} whose "path" and one of whose "lines" appear in one entry of the CITABLE_LINES block above; a text quote, a citation outside every changed hunk or to an untouched file voids the whole verdict.
The top-level comments array is optional. Use it only for actionable line-anchored feedback.
`;
  const judgeKey = channelKey({ adapter: judge.adapter.id, model: judge.model });
  // OBS-1182: an unset seat passes no effort argument at all — the CLI default, and the call shape callers pin.
  let raw: string;
  try {
    raw = await (judge.effort
      ? runLlm(judge.adapter, judge.model, prompt, worktree, via, JUDGE_TIMEOUT_MS, judge.effort)
      : runLlm(judge.adapter, judge.model, prompt, worktree, via, JUDGE_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof SeatLaunchError)) throw error;
    // OBS-1168(b): no seat, no verdict — run-gates re-routes the judge or parks infra; never a worker charge.
    return { gate: "acceptance", pass: false, details: `${warn}${detBlock}judge dispatch failed — ${error.message} — failing closed`,
      meta: { unparseable: true, cause: "seat-launch-failed", judge: judgeKey } };
  }
  const extracted = extractVerdictJson<Record<string, unknown>>(raw, nonce);
  if (!extracted) {
    const cause = classifyVerdictCause(raw, nonce, "pass");
    // GATE-09: structured meta names the flaked judge channel (mirrors review.ts:99 meta precedent) so
    // run-gates can retry the judge on a failover channel without string-matching details (D-03).
    const failure = cause === "malformed-verdict"
      ? "judge output unparseable — failing closed"
      : "judge dispatch failed — no structurally valid nonce-bound response; output unparseable — failing closed";
    return { gate: "acceptance", pass: false,
      details: warn + detBlock + failure,
      meta: { unparseable: true, cause, judge: judgeKey } };
  }
  // S23: every protocol failure — the raw citation shape, the schema, or a citation outside `changed` (the exact
  // index embedded in the prompt above, never the worktree) — is one malformed verdict: unparseable, so GATE-09
  // retries the judge on a failover channel, and named by THIS call's own dispatch arguments, never by model
  // output. The diagnostics are constant: no model value is converted to text, so none can throw here.
  const malformed = (why: string): GateResult => ({ gate: "acceptance", pass: false,
    details: `${warn}${detBlock}${why} — treating as unparseable, failing closed`,
    meta: { unparseable: true, cause: "malformed-verdict", judge: judgeKey } });
  if (!rawCitationsWellFormed(extracted)) return malformed("judge verdict malformed: malformed verdict shape (each criterion's evidence must be a {path, line} citation)");
  const parsed = JudgeVerdictSchema.safeParse(extracted);
  if (!parsed.success) return malformed("judge verdict malformed: malformed verdict shape");
  const v = parsed.data;
  if (!v.criteria.every((row) => citesChangedLocation(row.evidence, changed))) {
    return malformed("judge verdict cites evidence absent from the judged diff");
  }
  const inconsistencies = checkJudgeVerdict(v, expectedIds);
  const pass = v.pass === true && inconsistencies.length === 0 && v.criteria.every((row) => row.met);
  const lines = v.criteria.map((row) => `${row.met ? "✓" : "✗"} ${row.criterion}: ${row.reason}`);
  if (!v.pass) lines.push("judge verdict pass=false");
  lines.push(...inconsistencies);
  const prose = warn + detBlock + (lines.join("\n") || "judge passed");
  // OBS-1151: each criterion's canonical text, ruling and the path its evidence cites. An inconsistent verdict
  // (a duplicate row ruling both ways, a missing id) carries NO judgment: it is not a comparable subject, and as
  // an adjudicator it can confirm nothing — run-gates parks it infra.
  const judgment: JudgedCriterion[] | undefined = inconsistencies.length ? undefined : v.criteria.flatMap((row) => {
    const index = expectedIds.indexOf(row.criterion);
    if (index < 0) return [];
    return [{ id: row.criterion, criterion: renderAcceptanceItem(judgeItems[index]!), met: row.met,
      paths: [row.evidence.path] }];
  });
  return { gate: "acceptance", pass, details: appendAnchoredReview(prose, extracted),
    meta: { judge: judgeKey, ...(judgment ? { judgment } : {}) } };
}
