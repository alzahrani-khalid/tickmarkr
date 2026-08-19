import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import {
  type Baseline,
  ceilingKillResult,
  classifyFailureOutput,
  effectiveCeilingMs,
  type FailureClassification,
  fingerprint,
  freshFailures,
} from "../gates/baseline.js";
import { tickmarkrDir } from "../graph/graph.js";
import { gitHead, linkNodeModules, resolveIntegrationBranch, sh, shGit, shGitOk, WORKTREES_DIR } from "./git.js";

export interface TipVerifyResult {
  gate: string;
  cmd: string;
  pass: boolean;
  exitCode: number;
  fingerprints: string[];
  details: string;
  artifact?: string;
  /** Q121s: nonzero exit whose failures are ALL baseline-recorded — forgiven exactly as the battery forgives. */
  forgiven?: boolean;
  /**
   * OBS-534: what a nonzero exit is evidence OF, taken from the battery's own readers — `ceilingKillResult`
   * for a kill, `classifyFailureOutput` for everything else. `infra` means nothing was verified.
   */
  cause?: FailureClassification;
}

export function integrationBranch(cfg: TickmarkrConfig, runId: string): string {
  return `${cfg.integrationBranchPrefix}${runId}`;
}

const sanitize = (branch: string) => branch.replace(/[^\w.-]+/g, "-");

export async function ensureIntegration(repo: string, branch: string, baseRef: string): Promise<string> {
  branch = await resolveIntegrationBranch(repo, branch);
  const dir = join(tickmarkrDir(repo), WORKTREES_DIR, sanitize(branch));
  if (!existsSync(join(dir, ".git"))) {
    const exists = (await shGit(`git rev-parse --verify refs/heads/${shq(branch)}`, repo)).code === 0;
    if (exists) {
      await shGitOk(`git worktree add ${shq(dir)} ${shq(branch)}`, repo);
    } else {
      await shGitOk(`git worktree add -b ${shq(branch)} ${shq(dir)} ${shq(baseRef)}`, repo);
    }
  }
  linkNodeModules(repo, dir);
  return dir;
}

export function integrationHead(intWt: string): Promise<string> {
  return gitHead(intWt);
}

export async function mergeTask(
  intWt: string,
  taskBranch: string,
  message: string,
  gatedCommit: string,
): Promise<{ ok: boolean; conflict?: string; tipMoved?: { gatedCommit: string; branchTip: string } }> {
  const tip = await shGit(`git rev-parse --verify ${shq(`refs/heads/${taskBranch}`)}`, intWt);
  if (tip.code !== 0) return { ok: false, conflict: tip.stderr || tip.stdout };
  const branchTip = tip.stdout.trim();
  if (branchTip !== gatedCommit) return { ok: false, tipMoved: { gatedCommit, branchTip } };

  // Merge the verified hash, not the mutable branch name: a move after the comparison cannot land ungated content.
  const r = await shGit(`git merge --no-ff ${shq(gatedCommit)} -m ${shq(message)}`, intWt);
  if (r.code === 0) return { ok: true };
  const conflict = (await shGit("git status --porcelain", intWt)).stdout
    .split("\n")
    .filter((l) => l.startsWith("UU") || l.startsWith("AA"))
    .join("\n") || r.stderr || r.stdout;
  await shGit("git merge --abort", intWt);
  return { ok: false, conflict };
}

// OBS-34 ruled strict exit-code verify; Q121s (TRIAL T-OBS-1) narrows it: a red whose failure
// fingerprints are ALL recorded in the run's baseline is forgiven with the battery's own math
// (freshFailures) — on any repo whose main carries a pre-existing red, strict verify made a green
// terminus unreachable by construction and misattributed the red to the last merged task.
// Fail-closed edges kept: no baseline → strict; baseline green for that gate → strict; any fresh
// fingerprint, or output with no recognizable failure shape, → failed.
export async function verifyIntegrationTip(
  intWt: string,
  commands: Record<string, string>,
  runDir: string,
  baseline?: Baseline,
): Promise<TipVerifyResult[]> {
  const results: TipVerifyResult[] = [];
  for (const [gate, cmd] of Object.entries(commands)) {
    const entry = baseline?.commands[gate];
    // OBS-534: the ceiling is the BATTERY's, derived by effectiveCeilingMs from the same baseline entry
    // this loop already reads for forgiveness two lines down — never the flat DEFAULT_SHELL_TIMEOUT_MS
    // `sh` defaults to. A suite whose capture measured 600007ms carries a recorded 1800021ms ceiling;
    // running it under 600000ms here SIGKILLed a green tip three times while every per-task gate passed.
    const ceilingMs = effectiveCeilingMs(entry);
    const r = await sh(cmd, intWt, ceilingMs);
    const raw = r.stdout + "\n" + r.stderr;
    const stripped = raw.split(intWt).join("");
    const artifact = join(runDir, `tip-verify-${gate}.log`);
    // Battery parity on the ceiling too (baseline.ts Q24): the kill is read BEFORE the exit code is
    // interpreted at all. A SIGKILLed battery never returned a verdict, so no line of its partial
    // output is one — fingerprinting it is what produced the `<unrecognized failure output>` an
    // operator cannot act on. The kill reader's own text (ceiling + elapsed) and cause replace it.
    const killed = ceilingKillResult(gate, r, ceilingMs);
    if (killed) {
      writeFileSync(artifact, raw);
      results.push({
        gate,
        cmd,
        pass: false,
        exitCode: r.code,
        fingerprints: [],
        details: killed.details,
        cause: killed.meta?.classification as FailureClassification,
        artifact,
      });
      continue;
    }
    const { failing, unreadable } = freshFailures(entry, stripped);
    const cause = r.code === 0 ? undefined : classifyFailureOutput(stripped);
    // `?? 1` is the battery's own default (baseline.ts compareToBaseline): an exitCode-less legacy
    // entry reads as red-at-baseline there, so it must read the same here or old baselines silently
    // lose forgiveness. OBS-534 (T2): a capture killed at its ceiling now records a CAUSE and no
    // verdict, and that default must not launder the missing exit code back into red-at-baseline.
    // Only a recorded verdict is forgivable, so this reads the same predicate the battery does
    // (baseline.ts `baselineRed`) — `infra` first, the legacy default only after it. freshFailures
    // already drops the killed capture's flushed fingerprints, but it cannot close this alone: an
    // output whose only shape is a diagnostic HEADING (vitest's "Unhandled Errors" banner) is
    // fingerprintable yet OBS-42-exempt from rejecting, so `failing` comes back empty, `unreadable`
    // false and the cause reads "regression" — every other guard satisfied, and a real red forgiven
    // against a capture that never finished asking the question.
    const baselineRed = entry !== undefined && entry.infra !== true && (entry.exitCode ?? 1) !== 0;
    // Battery parity on the infra rule too (T9): infrastructure-only output means the runner never
    // completed a suite — nothing was verified, so nothing is forgivable, however familiar its
    // fingerprints. Stricter-than-battery edge kept: unreadable output never forgives.
    const forgiven = r.code !== 0 && baselineRed && failing.length === 0 && !unreadable && cause !== "infra";
    const pass = r.code === 0 || forgiven;
    if (!pass) writeFileSync(artifact, raw);
    results.push({
      gate,
      cmd,
      pass,
      exitCode: r.code,
      fingerprints: r.code !== 0 ? fingerprint(stripped) : [],
      details: r.code === 0 ? "exit 0"
        : forgiven ? `exit ${r.code} but only baseline-recorded failures (forgiven vs baseline)`
        : `exit ${r.code}`,
      ...(forgiven ? { forgiven: true } : {}),
      ...(cause ? { cause } : {}),
      ...(pass ? {} : { artifact }),
    });
  }
  return results;
}
