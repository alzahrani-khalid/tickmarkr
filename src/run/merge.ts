import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import { fingerprint } from "../gates/baseline.js";
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

// OBS-34: strict exit-code verify on the integration tip — no baseline forgiveness.
export async function verifyIntegrationTip(
  intWt: string,
  commands: Record<string, string>,
  runDir: string,
): Promise<TipVerifyResult[]> {
  const results: TipVerifyResult[] = [];
  for (const [gate, cmd] of Object.entries(commands)) {
    const r = await sh(cmd, intWt);
    const raw = r.stdout + "\n" + r.stderr;
    const artifact = r.code !== 0 ? join(runDir, `tip-verify-${gate}.log`) : undefined;
    if (artifact) writeFileSync(artifact, raw);
    results.push({
      gate,
      cmd,
      pass: r.code === 0,
      exitCode: r.code,
      fingerprints: r.code !== 0 ? fingerprint(raw.split(intWt).join("")) : [],
      details: r.code === 0 ? "exit 0" : `exit ${r.code}`,
      ...(artifact ? { artifact } : {}),
    });
  }
  return results;
}
