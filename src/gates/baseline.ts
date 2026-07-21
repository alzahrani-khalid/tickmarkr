import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { AcceptanceItem } from "../graph/schema.js";
import { sh } from "../run/git.js";
import type { GateResult } from "./types.js";

export interface Baseline {
  commands: Record<string, { exitCode: number; fingerprints: string[]; missingCommand?: boolean }>;
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
const SUMMARY_FAIL_RE = /^\s*Tests?\s+(?:Files?\s+)?\d+\s+failed/; // " Tests  N failed | M passed (T)"
const normalizeLine = (l: string) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

export function fingerprint(output: string): string[] {
  const lines = output
    .split("\n")
    .map((l) => l.replace(ANSI_RE, ""))
    .filter((l) => !PASS_LINE_RE.test(l) && (FAIL_ANCHOR_RE.test(l) || /\b(error|fail(ed|ure|ing)?)\b/i.test(l)))
    .map(normalizeLine);
  return [...new Set(lines)];
}

// stored baselines may predate ANSI/pass-marker hardening — renormalize at compare time so existing
// on-disk baseline.json files stay comparable without recapture (compat invariant, CLAUDE.md)
const renormalize = (fp: string) => normalizeLine(fp.replace(ANSI_RE, ""));

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

export async function captureBaseline(cwd: string, commands: Record<string, string>): Promise<Baseline> {
  const base: Baseline = { commands: {} };
  for (const [name, cmd] of Object.entries(commands)) {
    const r = await sh(cmd, cwd);
    // ponytail: strip the executing cwd so repo-root capture and worktree compare fingerprint identically; /private-vs-/tmp symlink variance is out of scope
    base.commands[name] = {
      exitCode: r.code,
      fingerprints: fingerprint((r.stdout + "\n" + r.stderr).split(cwd).join("")),
      missingCommand: missingConfiguredCommand(cmd, r),
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
    .filter((l) => FAIL_ANCHOR_RE.test(l) || SUMMARY_FAIL_RE.test(l));
  if (!headlines.length) return { details: `new failures vs baseline:\n${fresh.join("\n")}` };
  return {
    details: `failing tests:\n${headlines.join("\n")}\n\nnew failure fingerprints vs baseline (secondary):\n${fresh.join("\n")}`,
    meta: { failingTests: headlines.filter((l) => FAIL_ANCHOR_RE.test(l)) },
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
    const r = await sh(cmd, cwd);
    if (r.code === 0) {
      results.push({ gate: name, pass: true, details: "exit 0" });
      continue;
    }
    const raw = (r.stdout + "\n" + r.stderr).split(cwd).join("");
    const known = new Set((baseline.commands[name]?.fingerprints ?? []).map(renormalize));
    // OBS-42: diagnostic headings enrich fingerprints but cannot invalidate legacy baselines.
    const fresh = fingerprint(raw).filter(
      (f) => !known.has(f) && (!FAIL_ANCHOR_RE.test(f) || f.startsWith("FAIL ")),
    );
    if (!fresh.length && (baseline.commands[name]?.exitCode ?? 1) === 0) {
      results.push({
        gate: name,
        pass: false,
        details: `command was green at baseline but now exits ${r.code} with no recognizable failure lines — failing closed`,
      });
      continue;
    }
    results.push(
      fresh.length
        ? { gate: name, pass: false, ...headlineDetails(raw, fresh) }
        : { gate: name, pass: true, details: `exit ${r.code} but only pre-existing failures (forgiven)` },
    );
  }
  return results;
}
