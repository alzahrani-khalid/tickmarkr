import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { AcceptanceItem } from "../graph/schema.js";
import { DEFAULT_SHELL_TIMEOUT_MS, describeCapacity, type RunCapacity, sameCapacity, sh, type ShResult } from "../run/git.js";
import type { GateResult } from "./types.js";

/**
 * T7: the capacity a gate's own command ran under rides the RESULT, beside the verdict it explains,
 * rather than inside `meta` — `meta` is a machine-readable extras bag several callers compare
 * wholesale, and identity that a later session keys reuse on does not belong in a bag. Declared here,
 * at the one producer, because only a battery gate has a command whose child received a fork cap:
 * every other gate leaves the field absent, which is the honest reading of "this gate divided
 * nothing". The daemon lifts it verbatim onto the journal's gate row (src/run/daemon.ts).
 */
declare module "./types.js" {
  interface GateResult {
    capacity?: RunCapacity;
  }
}

export interface BaselineCommand {
  /**
   * Absent when the capture returned no verdict — see `infra`. A pre-v1.90 baseline can also lack it
   * (legacy entries read as red-at-baseline, the `?? 1` default both readers share).
   */
  exitCode?: number;
  fingerprints: string[];
  missingCommand?: boolean;
  /** What this command actually took at capture, on a pristine tree. Absent in pre-v1.90 baselines. */
  durationMs?: number;
  /** Sum of the per-file durations named by the runner; null when its output names none. */
  fileDurationSumMs?: number | null;
  /** fileDurationSumMs / durationMs — average implied file concurrency, not a configured fork count. */
  impliedParallelism?: number | null;
  /** The slowest per-file entry named by the runner; null when per-file timing is unavailable. */
  longestFile?: BaselineFileDuration | null;
  /** The ceiling that measurement implies, persisted so every later battery uses the same number. */
  ceilingMs?: number;
  /**
   * T7: the capacity this command's capture child ran under — the fork cap it received and the cores
   * that cap was divided from. Absent in every pre-T7 baseline, which is exactly what makes those
   * entries keep their current forgiveness; a MALFORMED one fails closed instead (git.ts readCapacity).
   */
  capacity?: RunCapacity;
  /**
   * The capture did not return a trustworthy verdict: it was SIGKILLed at its ceiling, or its output
   * proves the machine was exhausted while it ran. The entry therefore carries a CAUSE and no
   * verdict: no exit code, no fingerprints, nothing forgivable.
   */
  infra?: true;
}

export interface BaselineFileDuration {
  file: string;
  durationMs: number;
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
// T5: package.json selecting oxlint's stylish format is this repository's local remedy because the
// existing LINTER_ERROR_RE already reads it. PATH_FIRST_LINTER_ERROR_RE is the shipped fix: it reads
// the default `path:line:column: error …` form for every user without requiring their script to change.
// Keep the path at line start — accepting a position mid-sentence turns ordinary runner prose into a
// manufactured fresh failure.
const PATH_FIRST_LINTER_ERROR_RE = /^\s*\S+:(?:\d+|#):(?:\d+|#):\s+error\b(?:\s+\S)?/;
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
// vitest's default reporter draws the same glyph protocol with × (U+00D7, verbatim capture,
// GATE-FIX-4 drill: `intake-backend:test:  × GF4BE deliberate failure — probe only`). It is a
// fingerprintable SHAPE (isFailureShaped) but deliberately NOT in namesFailure: vitest prints a
// FAIL twin naming the same test, and the HYG-08 meta.failingTests pin (tests/gates/baseline.test.ts)
// keeps headline naming to one line per failure — duplicating each failure as glyph + FAIL would
// re-headline the noise HYG-08 removed, while dropping the × from the fingerprint set would shrink
// the per-test discriminators DEFECT 4 exists to harvest.
const X_GLYPH_FAIL_RE = /^\s*(?:(?:[\w@./-]+:\s*)*)×\s+\S/;
// Q137s (verbatim capture, dossier run-2 consult dossier, turbo 2.9.14 + pnpm 10): monorepo
// drivers prefix child output and summarize failures in their own grammar. Four shapes, all
// positional — `<pkg>:<task>:` prefixes reuse GLYPH_FAIL_RE's prefix idiom; `Failed:`/`ERROR`
// require the driver's own `pkg#task` identifier or its literal terminus, so prose or drawn
// chrome containing the words matches nothing (OBS-278 discipline):
//   `intake-frontend:lint:  ELIFECYCLE  Command failed with exit code 1.`
//   `Failed:    intake-frontend#lint`
//   ` ERROR  intake-frontend#lint: command (…) … exited (1)`
//   ` ERROR  run failed: command  exited (1)`
const TURBO_FAIL_RE = /^\s*(?:[\w@./-]+:\s*)*ELIFECYCLE\s+Command failed\b|^\s*Failed:\s+\S+#\S+|^\s*ERROR\s+(?:\S+#\S+:|run failed\b)/;
// GATE-FIX-4 DEFECT 4 (dossier drill, control 3): turbo prefixes every child line with
// `<pkg>:<task>:  `, so the per-test shapes above (FAIL_ANCHOR_RE etc.) — all anchored at line
// START — never fingerprinted; forgiveness compared only TURBO_FAIL_RE's package-level lines, and a
// package with one tolerated pre-existing red was blind to every NEW failure inside it (a deliberate
// failing test came back green). The counts route is closed too: normalizeLine masks digits, so
// `Tests 3 failed` vs `Tests 2 failed` is not a discriminator — per-test lines, which carry file
// paths and test names, are. This prefix is deliberately narrower than TURBO_FAIL_RE's label idiom:
// at least TWO colon-joined segments (`<pkg>:<task>:`, tasks may nest — `pkg:test:unit:`), every
// segment after the first starting with a letter — so `Error: boom` (one segment), `src/x.ts:12:`
// (digit segment) and `12:34 error` (eslint stylish) are never stripped.
const TURBO_PREFIX_RE = /^\s*[\w@./-]+(?::[A-Za-z_][\w.-]*)+:\s+/;
const stripTurboPrefix = (l: string): string | undefined => {
  const m = TURBO_PREFIX_RE.exec(l);
  return m ? l.slice(m[0].length) : undefined;
};
// Lines that NAME a failing test — the ones worth headlining to the operator. One list, so recognition
// and reporting cannot drift apart (a shape that blocks but never gets named cost 3 attempts once).
const namesFailure = (l: string) => FAIL_ANCHOR_RE.test(l) || RUNNER_FAIL_RE.test(l) || TRAILING_FAIL_RE.test(l) || GLYPH_FAIL_RE.test(l) || TURBO_FAIL_RE.test(l);
// The stripped form is a second READ of the same line, for the recognition/headline paths that ask
// "does anything here name a failure" — verdict classification (isInfraLine/namesRegression) keeps
// reading the raw line only, so infra/regression verdicts are byte-unchanged by the prefix pass.
const namesFailureEitherForm = (l: string): boolean => {
  if (namesFailure(l)) return true;
  const stripped = stripTurboPrefix(l);
  return stripped !== undefined && namesFailure(stripped);
};
const isFailureShaped = (l: string) =>
  namesFailure(l) || SUMMARY_FAIL_RE.test(l) || ERROR_ANCHOR_RE.test(l)
  || TSC_ERROR_RE.test(l) || LINTER_ERROR_RE.test(l) || PATH_FIRST_LINTER_ERROR_RE.test(l) || X_GLYPH_FAIL_RE.test(l);
const VOCAB_RE = /\b(?:error|fail(?:ed|ure|ing)?)\b/i;

// T9 — the infra/regression discriminator. A runner that died because the MACHINE ran out of
// processes, file descriptors or memory never finished asking the question, so its nonzero exit is
// not evidence about the work. But the reverse mistake is the expensive one: a real regression that
// happens to be printed next to an errno token must never be laundered into "infra" and forgiven.
// So the errno tokens below classify a line as infra only when NOTHING on that line also names a
// test-level failure — "AssertionError after spawn EAGAIN" names one and is a regression; "spawn
// EAGAIN" and "Error: spawn EAGAIN" name none and are infra. One regression line anywhere in the
// output makes the whole output a regression, whatever else the runner printed.
// OBS-540: command-oracle startup failures are execution evidence too. These two Playwright/keyring
// shapes are emitted by the process that was asked to run the oracle; they are deliberately kept in
// this runner-output classifier rather than applied to any judge-authored reason text. A real test
// failure still dominates below because one regression-shaped line makes the whole output regression.
const INFRA_RE = /\bE(?:AGAIN|MFILE|NFILE|NOMEM|NOSPC)\b|JavaScript heap out of memory|Cannot allocate memory|Resource temporarily unavailable|Token not found in system keyring|Process from config\.webServer was not able to start/i;
// Capture invalidation is deliberately narrower than the gate's infrastructure vocabulary above:
// keyring/config-webServer startup failures remain gate concerns, while this policy is specifically
// for evidence that the capture ran while the machine was resource-starved.
const CAPTURE_EXHAUSTION_RE = /\bE(?:AGAIN|MFILE|NFILE|NOMEM|NOSPC)\b|JavaScript heap out of memory|Cannot allocate memory|Resource temporarily unavailable/i;
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

/**
 * Capture validity asks a different question from gate classification. At a gate, one genuine
 * regression line must outrank adjacent errno evidence so a real defect is never laundered as infra.
 * At capture, any such evidence invalidates the whole measurement: once the machine was exhausted,
 * no failure in that incomplete environment can safely become pre-existing forgiveness. Keep this
 * separate from `classifyFailureOutput` so changing capture policy cannot move gate verdicts.
 */
const captureHasInvalidatingInfra = (output: string): boolean => output
  .split("\n")
  .map((l) => l.replace(ANSI_RE, ""))
  .filter((l) => !PASS_LINE_RE.test(l))
  .some((l) => CAPTURE_EXHAUSTION_RE.test(l));

const normalizeLine = (l: string) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// Vitest's default reporter names file durations as
// `✓ |project| tests/example.test.ts (12 tests) 1.23s` (❯ for a red file). The runner may be
// turbo-prefixed, but a test-name timing has no parenthesized file tally and therefore cannot enter
// this measurement. These are observations of runner output, not a promise that every runner exposes
// them — callers record null, never zero, when no line matches.
const FILE_DURATION_RE = /^\s*(?:(?:[\w@./-]+:\s*)*)[✓✔×❯]\s+(?:\|[^|\r\n]+\|\s+)?(\S+)\s+\([^\r\n)]*\)\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b/;

const durationUnitMs = (unit: string): number => unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;

function fileTiming(output: string, wallClockMs: number): Pick<BaselineCommand, "fileDurationSumMs" | "impliedParallelism" | "longestFile"> {
  const files: BaselineFileDuration[] = [];
  for (const line of output.split("\n")) {
    const match = FILE_DURATION_RE.exec(line.replace(ANSI_RE, ""));
    if (!match) continue;
    const durationMs = Number(match[2]) * durationUnitMs(match[3]);
    if (Number.isFinite(durationMs)) files.push({ file: match[1], durationMs });
  }
  if (!files.length) return { fileDurationSumMs: null, impliedParallelism: null, longestFile: null };
  const fileDurationSumMs = files.reduce((sum, entry) => sum + entry.durationMs, 0);
  const longestFile = files.reduce((longest, entry) => entry.durationMs > longest.durationMs ? entry : longest);
  return {
    fileDurationSumMs,
    impliedParallelism: wallClockMs > 0 ? fileDurationSumMs / wallClockMs : null,
    longestFile,
  };
}

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
  // GATE-FIX-4 DEFECT 4: every line is read twice — as printed, and with a turbo `<pkg>:<task>:`
  // prefix removed. A recognized stripped line fingerprints as its STRIPPED text, so the same
  // failure fingerprints identically whether turbo prefixed it or a bare runner printed it; the
  // prefixed form keeps fingerprinting too (baseline-recorded package-level reds stay forgivable).
  const shaped: string[] = [];
  for (const l of lines) {
    if (isFailureShaped(l)) shaped.push(l);
    const stripped = stripTurboPrefix(l);
    if (stripped !== undefined && !PASS_LINE_RE.test(stripped) && isFailureShaped(stripped)) shaped.push(stripped);
  }
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
  // OBS-534 (T2): an infra-recorded entry is a KILL, not a verdict — whatever fingerprints it carries
  // came from output flushed before the kill, over a suite that never finished. Nothing there is
  // "pre-existing", so it forgives nothing. The rule lives here rather than in either caller, so the
  // battery and tip verify inherit it from the one helper they already share.
  const known = new Set(entry?.infra === true ? [] : (entry?.fingerprints ?? []).map(renormalize));
  // OBS-42: diagnostic headings enrich fingerprints but cannot invalidate legacy baselines.
  const current = fingerprint(raw);
  const fresh = current.filter(
    (f) => !known.has(f) && (!FAIL_ANCHOR_RE.test(f) || f.startsWith("FAIL ")),
  );
  return { failing: fresh.filter((f) => f !== UNRECOGNIZED_FAILURE), unreadable: current.includes(UNRECOGNIZED_FAILURE) };
}
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Operator directive 2026-08-12 (D-OBS-10): tickmarkr is package-manager agnostic.
 * The `packageManager` field is authoritative (corepack's own contract); lockfiles
 * break ties; npm is only the LAST resort. Dossier exhibit: auto-detected
 * `npm run -s test` on a repo whose engines said `"npm": "please-use-pnpm"` — turbo
 * then failed to resolve pnpm and every gate died on environment, not code.
 */
export function detectPackageManager(repoRoot: string): PackageManager {
  const pkgPath = join(repoRoot, "package.json");
  try {
    const pm = (JSON.parse(readFileSync(pkgPath, "utf8")) as { packageManager?: string }).packageManager;
    const name = pm?.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") return name;
  } catch { /* no or unparseable manifest: lockfiles decide */ }
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun";
  return "npm";
}

// Silent where the manager supports it everywhere (npm -s; pnpm's global -s), bare
// where a flag would break a major version (yarn berry rejects run -s; bun is quiet).
const RUN_PREFIX: Record<PackageManager, string> = {
  npm: "npm run -s",
  pnpm: "pnpm -s run",
  yarn: "yarn run",
  bun: "bun run",
};

export function detectGateCommands(repoRoot: string, cfg: TickmarkrConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const pkgPath = join(repoRoot, "package.json");
  const scripts: Record<string, string> = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {})
    : {};
  const runPrefix = RUN_PREFIX[detectPackageManager(repoRoot)];
  for (const name of ["build", "test", "lint"] as const) {
    if (cfg.gates[name]) out[name] = cfg.gates[name]!;
    else if (scripts[name]) out[name] = `${runPrefix} ${name}`;
  }
  return out;
}

/**
 * Dossier GATE-FIX-4 §3 (2026-08-13): turbo schedules per-package tasks and ABORTS the whole
 * run at the first failing package, so every package after the abort goes unverified — and the
 * baseline gate then forgives the truncated output as "matching". The class appeared in three
 * gates and four syntaxes on one repo (turbo's scheduler, `&&`, a JS for-loop process.exit, and
 * turbo nested inside two of them). This preflight names only what it can see textually: the
 * resolved gate command, and — for the synthesized `<pm> run <script>` form — that script's own
 * body. The remedy deliberately demands a forwarding check first: the same repo's lint wrapper
 * branched on argv.length, so a blind `-- --continue` silently replaced the gate with a
 * different command (the trap their overseer caught by reading, not by symmetry).
 */
export function turboContinueFindings(repoRoot: string, cfg: TickmarkrConfig): Array<{ gate: string; detail: string }> {
  const pkgPath = join(repoRoot, "package.json");
  const scripts: Record<string, string> = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {})
    : {};
  const findings: Array<{ gate: string; detail: string }> = [];
  for (const [gate, cmd] of Object.entries(detectGateCommands(repoRoot, cfg))) {
    // The command text plus every package.json script it invokes by name — one level, textual.
    const referenced = Object.keys(scripts).filter((name) =>
      new RegExp(`\\brun\\s+(?:-s\\s+)?${reEscape(name)}(?:\\s|$)`).test(cmd));
    const surface = [cmd, ...referenced.map((name) => scripts[name]!)].join("\n");
    if (/\bturbo\s+run\b/.test(surface) && !surface.includes("--continue")) {
      findings.push({
        gate,
        detail: `runs turbo without --continue — turbo aborts at the first failing package, so later packages go unverified yet baseline-forgiven. Append --continue where turbo is invoked, and verify forwarding first (\`run ${gate} -- --continue --dry=text\` must echo it): wrappers that branch on argv can silently swap the gated command`,
      });
    }
  }
  return findings;
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

/**
 * OBS-612: the capture gets its OWN ceiling, thirty minutes, and it is not the shell default.
 *
 * `captureBaseline` used to call `sh(cmd, cwd)` with no ceiling argument, so it inherited
 * `DEFAULT_SHELL_TIMEOUT_MS` (600s) — while every CONSUMER of the result sizes its ceiling with
 * `effectiveCeilingMs`. A repo whose suite runs longer than ten minutes therefore had its capture
 * SIGKILLed every single time, recording `{infra: true, fingerprints: []}`, and `freshFailures`
 * correctly forgives nothing for an infra entry. The result is a baseline that forgives nothing on a
 * repo that has pre-existing failures — every task gate reds on failures the diff did not cause.
 *
 * Measured before it was fixed: EIGHT consecutive runs of this repository, 2026-08-20 to 2026-08-25,
 * every one killed within 325ms of 600000ms on a suite that needs ~700s. That tight a cluster is a
 * hard timeout, not variable failure. Each of those captures dutifully computed and stored
 * `ceilingMs ≈ 1800000` — the right answer — which the next run never read.
 *
 * A capture is a MEASUREMENT of how long the suite takes; giving it the same ceiling as an ordinary
 * shell asks it to finish faster than the thing it is measuring.
 */
export const CAPTURE_CEILING_MS = 1_800_000;

const invalidCaptureEntry = (durationMs: number): BaselineCommand => ({
  infra: true,
  fingerprints: [],
  durationMs,
  fileDurationSumMs: null,
  impliedParallelism: null,
  longestFile: null,
  ceilingMs: effectiveCeilingMs({ durationMs }),
});

export async function captureBaseline(cwd: string, commands: Record<string, string>): Promise<Baseline> {
  const base: Baseline = { commands: {} };
  for (const [name, cmd] of Object.entries(commands)) {
    const r = await sh(cmd, cwd, CAPTURE_CEILING_MS);
    // ponytail: strip the executing cwd so repo-root capture and worktree compare fingerprint identically; /private-vs-/tmp symlink variance is out of scope
    // ponytail: a capture that was itself killed records the ceiling as its "measurement", which
    // scales the next ceiling up — the right direction for a suite that never finished once.
    const durationMs = r.durationMs ?? 0;
    // OBS-534 (T2): a capture SIGKILLed at its ceiling never returned a verdict, so `r.code` is the
    // kill and not evidence about the command. Run 1501 recorded `test: {durationMs: 600007,
    // exitCode: 1}` for exactly this — a kill written down as a red baseline. There the accident
    // helped (the inflated ceiling is why every task gate passed); the same accident can mark a
    // GREEN command permanently red-at-baseline and hand every later gate free forgiveness for
    // failures the diff really did cause. So record the cause and nothing forgivable: no exit code,
    // and none of the partial output the runner had flushed before the kill. The measurement stays —
    // it is the one thing the kill did establish — and still scales the next ceiling up.
    // `timedOut` is set in exactly one place (git.ts's kill timer), so no ordinary exit reaches here.
    if (r.timedOut === true) {
      // OBS-612: SAY SO. An unbaselinable command is invisible on every surface — `status` reports
      // gates and supervision, never "your baseline forgives nothing" — so eight runs of this repo
      // passed through here in silence while every later gate paid for it. The operator reads this
      // line at run start, BEFORE any task gate reds, which is the whole point: the failure is
      // otherwise indistinguishable from a repo that simply has flaky tests.
      console.error(
        `tickmarkr: baseline capture for "${name}" was killed at its ${CAPTURE_CEILING_MS}ms ceiling — `
        + `it recorded NO fingerprints, so nothing is forgiven and every gate will treat a pre-existing `
        + `failure as a fresh one. Raise the ceiling or shorten the command.`,
      );
      base.commands[name] = invalidCaptureEntry(durationMs);
      continue;
    }
    const raw = (r.stdout + "\n" + r.stderr).split(cwd).join("");
    // Run 2137: the child exited and printed ordinary FAIL/AssertionError lines, so the gate-side
    // discriminator correctly called the mixed output a regression. But the same output also said
    // `spawn EAGAIN`: the machine had run out of processes while the pristine-tree measurement was
    // being taken. A capture cannot know which red lines predated that shortage and which it caused,
    // so none may become a fingerprint every later task gets to forgive.
    if (captureHasInvalidatingInfra(raw)) {
      console.error(
        `tickmarkr: baseline capture for "${name}" completed with process/resource-exhaustion evidence — `
        + `it recorded NO exit-code verdict and NO fingerprints, so nothing is forgiven for this command; `
        + `the measurement cannot distinguish a pre-existing failure from one caused by exhaustion.`,
      );
      base.commands[name] = invalidCaptureEntry(durationMs);
      continue;
    }
    base.commands[name] = {
      exitCode: r.code,
      // a command that exits 0 has no failures to fingerprint — recording any would be a lie the
      // compare step then has to forgive
      fingerprints: r.code === 0 ? [] : fingerprint(raw),
      missingCommand: missingConfiguredCommand(cmd, r),
      durationMs,
      ...fileTiming(raw, durationMs),
      ceilingMs: effectiveCeilingMs({ durationMs }),
      // T7: the world this measurement was taken in, so a later reader can ask whether its own world
      // is the same one. Recorded from THIS command's own shell result, never re-derived here.
      ...(r.capacity ? { capacity: r.capacity } : {}),
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
    .filter((l) => namesFailureEitherForm(l) || SUMMARY_FAIL_RE.test(l));
  if (!headlines.length) return { details: `new failures vs baseline:\n${fresh.join("\n")}` };
  return {
    details: `failing tests:\n${headlines.join("\n")}\n\nnew failure fingerprints vs baseline (secondary):\n${fresh.join("\n")}`,
    meta: { failingTests: headlines.filter(namesFailureEitherForm) },
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
    const entry = baseline.commands[name];
    const ceilingMs = effectiveCeilingMs(entry);
    const r = await sh(cmd, cwd, ceilingMs);
    // T7: every verdict below carries the capacity ITS OWN command ran under, taken off the shell
    // result rather than re-derived after the fact. The skip row above ran no command and therefore
    // states no capacity — a row that never divided the machine must not claim that it did.
    const record = (g: GateResult): void => {
      results.push(r.capacity ? { ...g, capacity: r.capacity } : g);
    };
    // …and whether the entry that would forgive this command was measured in the same world. A
    // baseline captured under a different fork cap forgives nothing: its fingerprints describe a
    // machine divided by a different number. Absent capacity (every pre-T7 baseline) still forgives
    // exactly as it does today; a malformed one fails closed (git.ts sameCapacity).
    const comparable = sameCapacity(entry?.capacity, r.capacity);
    // Q24: the kill is read BEFORE the exit code is interpreted at all. A SIGKILLed battery has
    // whatever partial output it had flushed — typically no failure shape — so every path below
    // would otherwise turn a timeout into a claim about the work: "no recognizable failure lines"
    // when the baseline was green, or a forgiven pre-existing red when it was not. Neither is true.
    const killed = ceilingKillResult(name, r, ceilingMs);
    if (killed) {
      record(killed);
      continue;
    }
    if (r.code === 0) {
      record({ gate: name, pass: true, details: "exit 0" });
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
      record({
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
    const { failing, unreadable } = freshFailures(entry, raw);
    // OBS-534 (T2): only a recorded VERDICT can be forgiven. A green baseline has no red to forgive,
    // and neither has a capture that was killed at its ceiling — it recorded a cause instead, so it
    // fails closed on the same branch rather than reading as "only pre-existing failures". Legacy
    // entries with no exitCode keep the `?? 1` red default both readers share (merge.ts:131).
    const baselineRed = entry?.infra !== true && (entry?.exitCode ?? 1) !== 0;
    if (!failing.length && !baselineRed) {
      const closed = entry?.infra === true
        ? `the baseline capture for this command was killed at its ceiling and recorded no verdict, so nothing here is forgivable — it now exits ${r.code} with no recognizable failure lines — failing closed`
        : `command was green at baseline but now exits ${r.code} with no recognizable failure lines — failing closed`;
      const evidence = unrecognizedEvidence(raw);
      record({
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
      record({ gate: name, pass: false, details: headlined.details, ...(Object.keys(meta).length ? { meta } : {}) });
      continue;
    }
    // T7: everything below this line is forgiveness, and forgiveness is the one verdict that reads a
    // record from another session. The failures are all baseline-recorded — but recorded under a
    // capacity this command did not run under, so they are not evidence that these failures
    // pre-existed the diff. A red does not become a green on fingerprints from a world it was not
    // measured in; the operator gets both worlds named.
    if (!comparable) {
      record({
        gate: name,
        pass: false,
        details: `exit ${r.code}; every failure is recorded in the baseline, but that capture ran under `
          + `${describeCapacity(entry?.capacity)} and this command ran under ${describeCapacity(r.capacity)} — `
          + `forgiveness across a changed capacity is not evidence, so this fails closed`,
        meta: { capacityMismatch: true, ...(classification ? { classification } : {}) },
      });
      continue;
    }
    record({
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
