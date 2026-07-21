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

export interface JudgeVerdict {
  pass: boolean;
  criteria: Array<{ criterion: string; met: boolean; reason: string; evidence: string }>;
}

const JudgeVerdictRowSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  reason: z.string(),
  // v1.64: a verbatim quote from the judged diff grounding the ruling — required; a verdict
  // omitting it is malformed and fails closed like any other shape violation.
  evidence: z.string(),
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

${verdictNonceLine(nonce)}

Respond with ONLY this JSON (no prose before or after):
{"nonce": "${nonce}", "pass": true|false, "criteria": [{"criterion": "c1", "met": true|false, "reason": "...", "evidence": "..."}]}
Each criteria[].criterion MUST be the stable id from the rubric (c1, c2, ...) exactly once.
Each criteria[].evidence MUST be a short verbatim quote copied from the diff above that grounds the ruling; a quote not found in the diff voids the whole verdict.
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
  // v1.64: quoted evidence must appear verbatim in `diff` — the exact string embedded in the prompt
  // above, never the worktree or any other artifact. A quote the diff doesn't contain is a
  // hallucinated verdict: treated as unparseable so GATE-09 retries the judge on a failover channel.
  const fabricated = v.criteria.filter((row) => !row.evidence.trim() || !diff.includes(row.evidence));
  if (fabricated.length) {
    return { gate: "acceptance", pass: false,
      details: warn + detBlock + `judge verdict quotes evidence absent from the judged diff (${fabricated.map((row) => row.criterion).join(", ")}) — treating as unparseable, failing closed`,
      meta: { unparseable: true, judge: channelKey({ adapter: judge.adapter.id, model: judge.model }) } };
  }
  const pass = v.pass === true && inconsistencies.length === 0 && v.criteria.every((row) => row.met);
  const lines = v.criteria.map((row) => `${row.met ? "✓" : "✗"} ${row.criterion}: ${row.reason}`);
  if (!v.pass) lines.push("judge verdict pass=false");
  lines.push(...inconsistencies);
  return { gate: "acceptance", pass, details: warn + detBlock + (lines.join("\n") || "judge passed") };
}
