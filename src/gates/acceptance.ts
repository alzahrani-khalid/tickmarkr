import { z } from "zod";
import { channelKey, shq, type WorkerAdapter } from "../adapters/types.js";
import { DEFAULT_DIFF_CAP } from "../config/config.js";
import { renderAcceptanceItem, type AcceptanceItem, type Task } from "../graph/schema.js";
import { sh } from "../run/git.js";
import { checkDiffCap, fetchTaskDiff } from "./review.js";
import { COMPLETION_FAKING_CHECKLIST, extractVerdictJson, generateVerdictNonce, type LlmVia, runLlm, verdictNonceLine } from "./llm.js";
import type { GateResult } from "./types.js";

// Fable F4: acceptance judge shares review's 900s timeout — 300s default killed frontier judges on cap-sized diffs.
const JUDGE_TIMEOUT_MS = 900_000;

// v1.70: evidence is a structured {path, line} citation into a line the judged diff actually changed
// (checked against real hunks below), so a real judge can no longer ground a ruling in an unchanged
// context line or a coincidental repeat elsewhere in the diff text. A plain string is still accepted as
// the legacy free-text quote — pre-v1.70 fixtures and the zero-token fake seam (llm.ts injectFakeEvidence,
// out of this module's scope) still emit one — and keeps v1.64's substring check.
export interface EvidenceCitation { path: string; line: number }
export interface JudgeVerdict {
  pass: boolean;
  criteria: Array<{ criterion: string; met: boolean; reason: string; evidence: string | EvidenceCitation }>;
}

const CitationSchema = z.object({ path: z.string(), line: z.number().int() });
const JudgeVerdictRowSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  reason: z.string(),
  // Required, either form: a row omitting evidence is malformed and fails closed like any other shape
  // violation. Object → structured citation; string → legacy quote.
  evidence: z.union([CitationSchema, z.string()]),
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
  raw: unknown,
  expectedIds: readonly string[],
): { verdict: JudgeVerdict; inconsistencies: string[] } {
  const parsed = JudgeVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: { pass: false, criteria: [] },
      inconsistencies: ["judge verdict inconsistent: malformed verdict shape"],
    };
  }
  const v = parsed.data;
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

  return { verdict: v, inconsistencies };
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

// OBS-55: when the base command already contains `--`, append -t after forwarded args — a second `--`
// makes vitest treat -t as a positional file filter and the name filter is dropped.
export function testFiltered(testCmd: string, name: string): string {
  const pattern = escapeRegExp(name);
  const wrapped = /^\s*(npm|yarn|pnpm|npx)\b/.test(testCmd);
  if (wrapped && /\s--\s/.test(testCmd)) return `${testCmd} -t ${shq(pattern)}`;
  const fwd = wrapped ? "-- " : "";
  return `${testCmd} ${fwd}-t ${shq(pattern)}`;
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
// caller passes a --no-prefix diff.
function changedLinesByFile(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) { inHunk = false; path = null; continue; }
    if (!inHunk && raw.startsWith("--- ")) continue;
    if (!inHunk && raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      path = p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
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
    } else if (c !== "-") {
      inHunk = false; // "\ No newline", a trailing blank, or the next section — hunk body ended
    }
  }
  return byFile;
}

// Compact a sorted set of line numbers into "3, 7-9, 14" form for the judge's citable-lines index.
function compressLines(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

// A citation is valid evidence iff the cited line falls inside a changed hunk of the cited file (OBS-129:
// changed-hunk span, not exact-added-line). A legacy free-text quote (string) keeps v1.64's substring
// check — non-empty and present somewhere in the diff.
function citesChangedLocation(evidence: string | EvidenceCitation, changed: Map<string, Set<number>>, diff: string): boolean {
  if (typeof evidence === "string") return evidence.trim().length > 0 && diff.includes(evidence);
  return changed.get(evidence.path)?.has(evidence.line) ?? false;
}

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
  judge: { adapter: WorkerAdapter; model: string },
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
        return { gate: "acceptance", pass: false,
          details: `oracle failed: $ ${a.command} (exit ${r.code})${tail(r.stderr || r.stdout)}` };
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
        return { gate: "acceptance", pass: false,
          details: `oracle failed: test "${a.test}" (exit ${r.code})${tail(r.stderr || r.stdout)}` };
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

  const { full: diff, forCap } = await fetchTaskDiff(worktree, baseRef);
  const diffCap = opts.diffCap ?? DEFAULT_DIFF_CAP;
  const capFail = checkDiffCap("acceptance", forCap.length, diffCap, warn + detBlock);
  if (capFail) return capFail;
  const expectedIds = judgeItems.map((_, index) => judgeCriterionId(index));
  // OBS-129: give the judge the exact citable new-file line numbers per changed file, so it grounds each
  // citation in a real changed line instead of miscounting. Validated below against this same `changed`.
  const changed = changedLinesByFile(diff);
  const citable = [...changed.entries()].map(([p, set]) => `- ${p}: ${compressLines([...set])}`).join("\n");
  const nonce = generateVerdictNonce();
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
${citable || "(the diff changes no lines)"}

${verdictNonceLine(nonce)}

Respond with ONLY this JSON (no prose before or after):
{"nonce": "${nonce}", "pass": true|false, "criteria": [{"criterion": "c1", "met": true|false, "reason": "...", "evidence": {"path": "path/to/file", "line": 42}}]}
Each criteria[].criterion MUST be the stable id from the rubric (c1, c2, ...) exactly once.
Each criteria[].evidence MUST be a structured citation {"path", "line"} whose "path" and "line" appear in the "Citable evidence lines" list above (a new-file line number inside a changed hunk); a citation outside every changed hunk or to an untouched file voids the whole verdict.
`;
  const raw = await runLlm(judge.adapter, judge.model, prompt, worktree, via, JUDGE_TIMEOUT_MS);
  const extracted = extractVerdictJson<JudgeVerdict>(raw, nonce);
  if (!extracted) {
    // GATE-09: structured meta names the flaked judge channel (mirrors review.ts:99 meta precedent) so
    // run-gates can retry the judge on a failover channel without string-matching details (D-03).
    // The parsed-verdict paths below are untouched — the flake signal is exactly extractJson→null here.
    return { gate: "acceptance", pass: false,
      details: warn + detBlock + "judge output unparseable — failing closed",
      meta: { unparseable: true, judge: channelKey({ adapter: judge.adapter.id, model: judge.model }) } };
  }
  const { verdict: v, inconsistencies } = checkJudgeVerdict(extracted, expectedIds);
  // v1.70 / OBS-129: each citation must fall inside a changed hunk of `diff` (the exact string embedded in
  // the prompt above and enumerated in the citable-lines index), never the worktree or any other artifact.
  // A citation to an untouched file or outside every changed hunk is a hallucinated verdict: treated as
  // unparseable so GATE-09 retries the judge on a failover channel. (A legacy free-text quote still
  // validates by substring, for the fake seam and pre-v1.70 fixtures.) `changed` is computed above.
  const fabricated = v.criteria.filter((row) => !citesChangedLocation(row.evidence, changed, diff));
  if (fabricated.length) {
    return { gate: "acceptance", pass: false,
      details: warn + detBlock + `judge verdict cites evidence absent from the judged diff (${fabricated.map((row) => row.criterion).join(", ")}) — treating as unparseable, failing closed`,
      meta: { unparseable: true, judge: channelKey({ adapter: judge.adapter.id, model: judge.model }) } };
  }
  const pass = v.pass === true && inconsistencies.length === 0 && v.criteria.every((row) => row.met);
  const lines = v.criteria.map((row) => `${row.met ? "✓" : "✗"} ${row.criterion}: ${row.reason}`);
  if (!v.pass) lines.push("judge verdict pass=false");
  lines.push(...inconsistencies);
  return { gate: "acceptance", pass, details: warn + detBlock + (lines.join("\n") || "judge passed") };
}
