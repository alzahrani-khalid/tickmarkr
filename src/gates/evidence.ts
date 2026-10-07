import { shGitOk } from "../run/git.js";
import type { GateResult } from "./types.js";

export async function evidenceGate(
  worktree: string,
  baseRef: string,
): Promise<GateResult & { commits: string[] }> {
  const commits = (await shGitOk(`git rev-list '${baseRef}..HEAD'`, worktree)).trim().split("\n").filter(Boolean);
  if (!commits.length) {
    return { gate: "evidence", pass: false, details: "no commits — worker claimed work but committed nothing", commits: [] };
  }
  const stat = (await shGitOk(`git diff --stat '${baseRef}..HEAD'`, worktree)).trim();
  if (!stat) {
    return { gate: "evidence", pass: false, details: "commits exist but the cumulative diff is empty", commits };
  }
  return { gate: "evidence", pass: true, details: `${commits.length} commit(s):\n${stat}`, commits };
}
