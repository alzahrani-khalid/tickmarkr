import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { AcceptanceItem } from "../graph/schema.js";
import { DEFAULT_SHELL_TIMEOUT_MS, sh, type ShResult } from "../run/git.js";
import type { GateResult } from "./types.js";

export interface BaselineCommand {
  exitCode: number;
  fingerprints: string[];
  missingCommand?: boolean;
  /** What this command actually took at capture, on a pristine tree. Absent in pre-v1.90 baselines. */
  durationMs?: number;
  /** The ceiling that measurement implies, persisted so every later battery uses the same number. */
  ceilingMs?: number;
}

export interface Baseline {
  commands: Record<string, BaselineCommand>;
  warnings?: BaselineWarning[];
}

export interface BaselineWarning {
  kind: "wrong-environment";
  commands: string[];
  reason: string;
}

// incident #2 (run-20260709-104447): a vitest ✓ PASS line with "error" in the test NAME, wrapped in ANSI
// codes that varied between baseline and worktree runs, was reported as a "new failure". Strip ANSI first;
// a pass-marker line is never a failure. [\d;#] covers raw ANSI and digit-normalized ANSI ("\x1b[#m") from
// baselines stored by pre-hardening code.
const ANSI_RE = /\x1b\[[\d;#]*[A-Za-z]/g;
// ponytail: only leading ✓/✔ after optional "label:" prefixes (turbo/vitest), or tickmarkr's own run
// summary, counts as a pass line — other runners' pass markers (PASS, ok) stay fingerprintable
const PASS_LINE_RE = /^\s*(?:(?:[\w@./-]+:\s*)*[✓✔]|(?:\[tickmarkr\]\s+)?(?:tickmarkr\s+[\w.-]+:\s+)?(?:\d+|#)\s+done,\s+(?:\d+|#)\s+failed(?:,\s+(?:\d+|#)\s+awaiting human)?\b)/;
// HYG-08 (D-01, incident run-20260711-154920): a failing test went unnamed for 3 attempts because details
// headlined benign fingerprint-diff noise. These anchors harvest the runner's OWN failure naming from fresh
// output to headline it. \s is fine in a TS regex — the BSD [[:space:]] rule binds shell grep only.
// OBS-42: vitest's diagnostic failure headings are shared anchors for baseline and tip verification.
const FAIL_ANCHOR_RE = /^\s*(?:FAIL\s+|[^\w]*(?:Unhandled Errors|Uncaught Exception)\b)/;
// OBS-278: a failure fingerprint is a SHAPE — the way a runner reports a failure — never error/fail
// vocabulary. A status surface that draws those words (zone +N, run attempt N, "1 failed") used to
// fingerprint as a fresh failure on every attempt, rejecting a task for rendering what it was chartered
// to render. Digits are written (?:\d+|#) so a shape matches both raw and digit-normalized lines.
// Run summaries: " Tests  N failed | M passed (T)" (vitest), "# fail N" (TAP / node:test),
// "ℹ fail N" (node:test's spec reporter) and "test result: FAILED. …" (cargo / libtest).
const SUMMARY_FAIL_RE = /^\s*(?:Tests?\s+(?:Files?\s+)?(?:\d+|#)\s+failed|#\s+fail\s+(?!0\b)(?:\d+|#)\b|ℹ\s+fail\s+(?!0\b)(?:\d+|#)\b|test result:\s+FAILED\b)/;
const ERROR_ANCHOR_RE = /^\s*(?:Error|[A-Za-z_$][\w$]*Error):\s+\S/;
const TSC_ERROR_RE = /^\s*\S.*\((?:\d+|#),(?:\d+|#)\):\s+error\s+[A-Z]+(?:\d+|#):/i; // tsc
const LINTER_ERROR_RE = /^\s*(?:\d+|#):(?:\d+|#)\s+error\s+\S/; // eslint stylish
// The failure shapes non-Vitest runners name their tests with: pytest's short summary
// (`FAILED tests/t.py::test_x - AssertionError`, `ERROR tests/t.py::fixture`), go test
// (`--- FAIL: TestFoo (0.00s)`), TAP / node:test (`not ok 1 - name`, whose summary line lands in
// SUMMARY_FAIL_RE) and python unittest's failure-block header (`FAIL: test_x (mod.Class.test_x)`,
// verbatim capture, python3 -m unittest -v). Each anchors the runner's token at line START; the
// pytest/go forms also require a file/test identifier after it (`::`, a path separator, or an
// extension) — so a surface drawing "FAILED" mid-line, or a plain sentence like "FAILED to reach
// the zone", still matches nothing. Without these a genuinely new pytest/go/TAP/unittest failure on
// an already-red baseline was forgiven as pre-existing, because only shaped lines can reject.
const RUNNER_FAIL_RE = /^\s*(?:(?:FAILED|ERROR)\s+\S*(?:::|[/\\]|\.[A-Za-z]\w*\b)|FAIL:\s+\S|---\s+FAIL:\s+\S|not ok\b)/;
// The other half of the position rule: runners that put the verdict LAST. cargo/libtest names each
// failing test as `test tests::name ... FAILED` (verbatim capture, cargo 1.95.0) and details it with
// `thread 'tests::name' (81651804) panicked at src/lib.rs:7:24:`; python unittest -v writes
// `test_x (mod.Class.test_x) ... FAIL` (and `... ERROR`) — the same rule with the runner's
// qualified-name token between identifier and separator, and the short verdict spelling (verbatim
// capture, python3 -m unittest -v). Recognition is positional, not a vendor name: an identifier, the
// runner's own separator, then the verdict ENDING the line. A drawn status strip ("│ ✗ tip-verify
// FAILED · zone +3 │") has the verdict mid-line inside chrome, so it matches nothing here — which is
// why this can generalize without re-opening OBS-278.
const TRAILING_FAIL_RE = /^\s*(?:test\s+)?\S+(?:\s+\([^)]*\))?\s+(?:\.{3}|-{3,})\s+(?:FAIL(?:ED)?|ERROR)\s*$|^\s*thread\s+'[^']*'\s+.*panicked at\s+\S/;
// node:test's spec reporter speaks glyphs, not words: a failure is named by a leading ✖ (verbatim
// capture, Node v22 `--test-reporter=spec`: `✖ old failure (0.585875ms)`, totalled as `ℹ fail 1` in
// SUMMARY_FAIL_RE) — the exact counterpart of the ✓/✔ pass markers PASS_LINE_RE drops, with the same
// optional label prefixes. Recognition is positional — the runner's own marker at line start — so any
// runner sharing the glyph protocol is read without being enumerated; a status strip drawing ✖
// mid-line inside chrome matches nothing, the same position rule as the other shapes.
const GLYPH_FAIL_RE = /^\s*(?:(?:[\w@./-]+:\s*)*)✖\s+\S/;
// Lines that NAME a failing test — the ones worth headlining to the operator. One list, so recognition
// and reporting cannot drift apart (a shape that blocks but never gets named cost 3 attempts once).
const namesFailure = (l: string) => FAIL_ANCHOR_RE.test(l) || RUNNER_FAIL_RE.test(l) || TRAILING_FAIL_RE.test(l) || GLYPH_FAIL_RE.test(l);
const isFailureShaped = (l: string) =>
  namesFailure(l) || SUMMARY_FAIL_RE.test(l) || ERROR_ANCHOR_RE.test(l)
  || TSC_ERROR_RE.test(l) || LINTER_ERROR_RE.test(l);
const VOCAB_RE = /\b(?:error|fail(?:ed|ure|ing)?)\b/i;

// T9 — the infra/regression discriminator. A runner that died because the MACHINE ran out of
// processes, file descriptors or memory never finished asking the question, so its nonzero exit is
// not evidence about the work. But the reverse mistake is the expensive one: a real regression that
// happens to be printed next to an errno token must never be laundered into "infra" and forgiven.
// So the errno tokens below classify a line as infra only when NOTHING on that line also names a
// test-level failure — "AssertionError after spawn EAGAIN" names one and is a regression; "spawn
// EAGAIN" and "Error: spawn EAGAIN" name none and are infra. One regression line anywhere in the
// output makes the whole output a regression, whatever else the runner printed.
const INFRA_RE = /\bE(?:AGAIN|MFILE|NFILE|NOMEM|NOSPC)\b|JavaScript heap out of memory|Cannot allocate memory|Resource temporarily unavailable/;
// A named error CLASS ("AssertionError", "TypeError", "MyDomainError") — never bare "Error", which
// is what an errno report itself is headed with (`Error: spawn EAGAIN`). The prefix is required.
const ERROR_CLASS_RE = /\b[A-Za-z][A-Za-z0-9]*Error\b/;
const isInfraLine = (l: string) =>
  INFRA_RE.test(l) && !ERROR_CLASS_RE.test(l) && !namesFailure(l) && !SUMMARY_FAIL_RE.test(l);
const namesRegression = (l: string) => (isFailureShaped(l) || ERROR_CLASS_RE.test(l)) && !isInfraLine(l);

export type FailureClassification = "regression" | "infra";

/**
 * What a nonzero runner exit is evidence OF. `undefined` when the output names neither — the
 * unreadable-runner case the existing fail-closed path already owns.
 */
export function classifyFailureOutput(output: string): FailureClassification | undefined {
  const lines = output.split("\n").map((l) => l.replace(ANSI_RE, "")).filter((l) => !PASS_LINE_RE.test(l));
  if (lines.some(namesRegression)) return "regression";
  return lines.some(isInfraLine) ? "infra" : undefined;
}

const normalizeLine = (l: string) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// A failing command whose output holds no shape any runner here names. The marker is content-free and
// constant: downstream consumers (tip verify journals fingerprint counts) still see that the command
// failed, while no line of the output — narration, status strip, stack trace — can enter the set. Being
// constant it is identical on every attempt, so it can never surface as a fresh fingerprint either.
export const UNRECOGNIZED_FAILURE = "<unrecognized failure output>";

// OBS-278 dies here: only a failure SHAPE is fingerprintable. Vocabulary is not a shape — a surface that
// renders "zone +3 · run attempt 2 · 1 failed" (what T9 is chartered to draw) contributes nothing, with
// or without box glyphs, so it cannot manufacture a fresh-fingerprint rejection on any future attempt.
export function fingerprint(output: string): string[] {
  const lines = output
    .split("\n")
    .map((l) => l.replace(ANSI_RE, ""))
    .filter((l) => !PASS_LINE_RE.test(l));
  const shaped = lines.filter(isFailureShaped);
  if (!shaped.length) return lines.some((l) => l.trim()) ? [UNRECOGNIZED_FAILURE] : [];
  return [...new Set(shaped.map(normalizeLine))];
}

// The diagnostic channel for a runner we cannot read: raw output lines, never fingerprints, never a
// verdict. They exist so the operator sees SOMETHING when a green command turns red unrecognizably.
const unrecognizedEvidence = (raw: string): string =>
  raw
    .split("\n")
    .map((l) => l.replace(ANSI_RE, "").trimEnd())
    .filter((l) => VOCAB_RE.test(l))
    .slice(0, 10)
    .join("\n");

// stored baselines may predate ANSI/pass-marker hardening — renormalize at compare time so existing
// on-disk baseline.json files stay comparable without recapture (compat invariant, CLAUDE.md)
const renormalize = (fp: string) => normalizeLine(fp.replace(ANSI_RE, ""));

/**
 * Q121s: the battery's forgiveness math, exported so tip-verify applies the IDENTICAL rule.
 * Returns the failure fingerprints of `raw` that are NOT in the baseline entry (fresh), and
 * whether the output carried no recognizable failure shape at all.
 */
export function freshFailures(entry: BaselineCommand | undefined, raw: string): { failing: string[]; unreadable: boolean } {
  const known = new Set((entry?.fingerprints ?? []).map(renormalize));
  // OBS-42: diagnostic headings enrich fingerprints but cannot invalidate legacy baselines.
  const current = fingerprint(raw);
  const fresh = current.filter(
    (f) => !known.has(f) && (!FAIL_ANCHOR_RE.test(f) || f.startsWith("FAIL ")),
  );
  return { failing: fresh.filter((f) => f !== UNRECOGNIZED_FAILURE), unreadable: current.includes(UNRECOGNIZED_FAILURE) };
}

export function detectGateCommands(repoRoot: string, cfg: TickmarkrConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const pkgPath = join(repoRoot, "package.json");
  const scripts: Record<string, string> = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {})
    : {};
  for (const name of ["build", "test", "lint"] as const) {
    if (cfg.gates[name]) out[name] = cfg.gates[name]!;
    else if (scripts[name]) out[name] = `npm run -s ${name}`;
  }
  return out;
}

const shellToken = (cmd: string): string | undefined => {
  for (const raw of cmd.trim().split(/\s+/)) {
    if (!raw || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    if (raw === "env") continue;
    return raw.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
};

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function missingConfiguredCommand(cmd: string, result: { code: number; stdout: string; stderr: string }): boolean {
  if (result.code !== 127) return false;
  const token = shellToken(cmd);
  if (!token) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return new RegExp(`(?:^|[:\\s])${reEscape(token)}:\\s+(?:command not found|No such file or directory)`, "i").test(output);
}

/**
 * How much longer than the baseline a battery may legitimately take. Gate batteries run inside a
 * worktree beside up to `concurrency` siblings, so the same suite is genuinely slower than its
 * pristine-tree capture — 3× is the headroom, not a performance budget.
 */
const CEILING_SLACK = 3;

/**
 * The ceiling a battery runs under: whichever is larger of the shipped constant and the slack applied
 * to what this command actually measured. A pre-v1.90 baseline (no measurement) gets exactly the
 * shipped constant, so nothing regresses on an existing on-disk baseline.json — the same read-old
 * compat rule the fingerprint renormalizer follows.
 */
export const effectiveCeilingMs = (entry?: Pick<BaselineCommand, "durationMs" | "ceilingMs">): number =>
  entry?.ceilingMs ?? Math.max(DEFAULT_SHELL_TIMEOUT_MS, CEILING_SLACK * (entry?.durationMs ?? 0));

/**
 * The ONLY producer of a `ceiling-kill` gate result. It is gated on `timedOut`, which git.ts sets in
 * exactly one place — inside the timer callback that issues the SIGKILL — so a process that exited on
 * its own can never reach this text however it exited: a slow red suite, an unreadable runner, exit
 * 137 from a kill somebody ELSE sent. Returning `undefined` rather than a result keeps that structural:
 * every caller must go on to the ordinary verdict path, it cannot fall through into this one.
 *
 * A kill is not a verdict. The battery was still running when the machine took it away, so its exit
 * code is evidence about the ceiling and nothing about the work — which is why this reports `infra`
 * and never enters baseline forgiveness (there is no runner output to forgive).
 */
export function ceilingKillResult(gate: string, r: ShResult, ceilingMs: number): GateResult | undefined {
  if (r.timedOut !== true) return undefined;
  // no measurement only when a caller synthesized the result; a real kill fires AT the ceiling
  const durationMs = r.durationMs ?? ceilingMs;
  return {
    gate,
    pass: false,
    details: `ceiling-kill: SIGKILLed after ${durationMs}ms at the configured ${ceilingMs}ms ceiling — `
      + `the battery never returned a verdict, so this gate verified nothing (exit ${r.code} is the kill, not a test result)`,
    meta: { classification: "infra" satisfies FailureClassification, infra: true, kind: "ceiling-kill", durationMs, ceilingMs },
  };
}

export async function captureBaseline(cwd: string, commands: Record<string, string>): Promise<Baseline> {
  const base: Baseline = { commands: {} };
  for (const [name, cmd] of Object.entries(commands)) {
    const r = await sh(cmd, cwd);
    // ponytail: strip the executing cwd so repo-root capture and worktree compare fingerprint identically; /private-vs-/tmp symlink variance is out of scope
    // ponytail: a capture that was itself killed records the ceiling as its "measurement", which
    // scales the next ceiling up — the right direction for a suite that never finished once.
    const durationMs = r.durationMs ?? 0;
    base.commands[name] = {
      exitCode: r.code,
      // a command that exits 0 has no failures to fingerprint — recording any would be a lie the
      // compare step then has to forgive
      fingerprints: r.code === 0 ? [] : fingerprint((r.stdout + "\n" + r.stderr).split(cwd).join("")),
      missingCommand: missingConfiguredCommand(cmd, r),
      durationMs,
      ceilingMs: effectiveCeilingMs({ durationMs }),
    };
  }
  const names = Object.keys(commands);
  const missing = names.filter((name) => base.commands[name]?.missingCommand === true);
  if (names.length > 0 && missing.length === names.length) {
    base.warnings = [{
      kind: "wrong-environment",
      commands: missing,
      reason: `wrong environment: every configured baseline command was missing (${missing.join(", ")})`,
    }];
  }
  return base;
}

export interface VacuousOracleWarning {
  kind: "vacuous-oracle";
  taskId: string;
  oracles: string[];
  reason: string;
}

// Tier A #3 (2026-07-21 repo-scan reconciliation): a command oracle that already exits 0 before any
// work exists cannot falsify the work — surface it at baseline capture. Observational only: journaled
// warning, never a gate input, and an oracle that fails at baseline changes nothing. Judge oracles
// (including plain-string compat judges) are never executed; test oracles stay gate-only (they need
// the detected runner and the worker's diff to mean anything).
export async function detectVacuousOracles(
  cwd: string,
  tasks: ReadonlyArray<{ id: string; acceptance: AcceptanceItem[] }>,
): Promise<VacuousOracleWarning[]> {
  const out: VacuousOracleWarning[] = [];
  for (const t of tasks) {
    const vacuous: string[] = [];
    for (const a of t.acceptance) {
      if (typeof a !== "object" || a.oracle !== "command") continue;
      if ((await sh(a.command, cwd)).code === 0) vacuous.push(a.command);
    }
    if (vacuous.length) {
      out.push({
        kind: "vacuous-oracle",
        taskId: t.id,
        oracles: vacuous,
        reason: `vacuous acceptance oracle on ${t.id}: already passes before any work exists — ${vacuous.map((c) => `$ ${c}`).join("; ")}`,
      });
    }
  }
  return out;
}

// HYG-08 (D-01): headline the runner's own failure naming; demote the fingerprint diff to a secondary
// section. Extracts from `raw` — the SAME cwd-stripped, per-line ANSI_RE-stripped string that was
// fingerprinted, digits UN-normalized (Pitfall 2: normalization mangles test names, and the diff set could
// drop a FAIL line that fingerprint-collides with baseline noise). No headline anchors → byte-identical
// fallback to today's text (non-vitest runners lose nothing). RED-pinned by tests/gates/baseline.test.ts
// "HYG-08: details headlines the failing test, not the noise".
function headlineDetails(raw: string, fresh: string[]): { details: string; meta?: { failingTests: string[] } } {
  const headlines = raw
    .split("\n")
    .map((l) => l.replace(ANSI_RE, ""))
    .filter((l) => namesFailure(l) || SUMMARY_FAIL_RE.test(l));
  if (!headlines.length) return { details: `new failures vs baseline:\n${fresh.join("\n")}` };
  return {
    details: `failing tests:\n${headlines.join("\n")}\n\nnew failure fingerprints vs baseline (secondary):\n${fresh.join("\n")}`,
    meta: { failingTests: headlines.filter(namesFailure) },
  };
}

export async function compareToBaseline(
  cwd: string,
  commands: Record<string, string>,
  baseline: Baseline,
  enabled: string[],
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const name of enabled) {
    const cmd = commands[name];
    if (!cmd) {
      // nothing detected for this gate in the target repo — journal an explicit skip instead of
      // vanishing silently (a lint gate with no lint script rendered as forever-open in status)
      results.push({ gate: name, pass: true, details: `no ${name} command detected — skipped`, meta: { skipped: true } });
      continue;
    }
    const ceilingMs = effectiveCeilingMs(baseline.commands[name]);
    const r = await sh(cmd, cwd, ceilingMs);
    // Q24: the kill is read BEFORE the exit code is interpreted at all. A SIGKILLed battery has
    // whatever partial output it had flushed — typically no failure shape — so every path below
    // would otherwise turn a timeout into a claim about the work: "no recognizable failure lines"
    // when the baseline was green, or a forgiven pre-existing red when it was not. Neither is true.
    const killed = ceilingKillResult(name, r, ceilingMs);
    if (killed) {
      results.push(killed);
      continue;
    }
    if (r.code === 0) {
      results.push({ gate: name, pass: true, details: "exit 0" });
      continue;
    }
    const raw = (r.stdout + "\n" + r.stderr).split(cwd).join("");
    // T9: classify BEFORE the baseline diff, and record it on every nonzero result. An infra-only
    // exit means the runner never completed a suite, so there is nothing to forgive and nothing
    // verified — it fails, and `meta.infra` marks it so the merge predicate cannot read it as a
    // satisfied gate even if some future producer reports it as a pass. Baseline forgiveness stays
    // exactly where it belongs: on failures the runner actually reported and the baseline already had.
    const classification = classifyFailureOutput(raw);
    if (classification === "infra") {
      results.push({
        gate: name,
        pass: false,
        details: `exit ${r.code} on infrastructure alone — the runner never completed a suite, so this gate verified nothing:\n${unrecognizedEvidence(raw) || raw.trim().split("\n").slice(0, 10).join("\n")}`,
        meta: { classification, infra: true },
      });
      continue;
    }
    // OBS-278: only a failure SHAPE is a verdict — everything fingerprint() keeps is one, except the
    // unrecognized-output marker, which is evidence for the operator and never grounds to reject.
    // ponytail: ceiling — a runner whose failure output holds no shape above and whose baseline is
    // already red has its new failures forgiven, so forgiveness that rests on the marker SAYS so
    // below rather than reading as a verified green. Raise the ceiling by teaching isFailureShaped
    // that runner's position rule (leading verdict + identifier, or identifier + separator + trailing
    // verdict); loosening back to vocabulary re-opens OBS-278.
    const { failing, unreadable } = freshFailures(baseline.commands[name], raw);
    if (!failing.length && (baseline.commands[name]?.exitCode ?? 1) === 0) {
      const closed = `command was green at baseline but now exits ${r.code} with no recognizable failure lines — failing closed`;
      const evidence = unrecognizedEvidence(raw);
      results.push({
        gate: name,
        pass: false,
        details: evidence ? `${closed}\nunrecognized output:\n${evidence}` : closed,
        ...(classification ? { meta: { classification } } : {}),
      });
      continue;
    }
    if (failing.length) {
      const headlined = headlineDetails(raw, failing);
      const meta = { ...headlined.meta, ...(classification ? { classification } : {}) };
      results.push({ gate: name, pass: false, details: headlined.details, ...(Object.keys(meta).length ? { meta } : {}) });
      continue;
    }
    results.push({
      gate: name,
      pass: true,
      details: `exit ${r.code} but only pre-existing failures (forgiven)${
        unreadable ? " — no failure shape recognized in this output, so a new failure from this runner is invisible to the baseline gate" : ""
      }`,
      ...(classification ? { meta: { classification } } : {}),
    });
  }
  return results;
}
