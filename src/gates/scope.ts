import picomatch from "picomatch";
import type { WorkerResult } from "../adapters/types.js";
import { shGitOk } from "../run/git.js";
import type { GateResult } from "./types.js";

// OBS-61: the live integration tip can advance between attempts (sibling merge) while a resumed
// worktree stays parented on the old base — merge-base(tip, HEAD) pins the diff to the worktree's
// creation ancestor so sibling edits cannot leak into scope as false out-of-scope offenders.
export async function scopeDiffBase(worktree: string, integrationTip: string): Promise<string> {
  const head = (await shGitOk("git rev-parse HEAD", worktree)).trim();
  if (head === integrationTip) return integrationTip;
  return (await shGitOk(`git merge-base '${integrationTip}' '${head}'`, worktree)).trim();
}

/** Pure offender split — corpus-replay oracle exercises this exact decision logic. */
export function dispositionOffenders(offenders: string[], allowDeviations: string[]): { hard: string[]; allowed: string[] } {
  const allowedMatch = allowDeviations.length ? picomatch(allowDeviations, { dot: true }) : () => false;
  const allowed: string[] = [];
  const hard: string[] = [];
  for (const f of offenders) {
    if (allowedMatch(f)) allowed.push(f);
    else hard.push(f);
  }
  return { hard, allowed };
}

export async function scopeGate(
  worktree: string,
  integrationTip: string,
  files: string[],
  result: WorkerResult,
  allowDeviations: string[] = [],
): Promise<GateResult> {
  if (!files.length) return { gate: "scope", pass: true, details: "no file scope declared — unrestricted" };
  const baseRef = await scopeDiffBase(worktree, integrationTip);
  const changed = (await shGitOk(`git diff --name-only '${baseRef}..HEAD'`, worktree)).trim().split("\n").filter(Boolean);
  const inScope = picomatch(files, { dot: true }); // byte-identical options to assertWriteScope in src/compile/common.ts
  const offenders = changed.filter((f) => !inScope(f));
  if (!offenders.length) return { gate: "scope", pass: true, details: `all ${changed.length} changed files in scope` };
  // HARD-08: a worker's declared deviation is an audit note, NEVER a pass — the gate decides against
  // operator config only (invariant: gates never trust worker claims).
  const { hard, allowed } = dispositionOffenders(offenders, allowDeviations);
  const note = result.deviations.length ? `\nworker-declared deviations (audit note, not authority): ${result.deviations.join("; ")}` : "";
  if (!hard.length) {
    return { gate: "scope", pass: true, details: `out-of-scope but operator-allowlisted:\n${allowed.join("\n")}${note}` };
  }
  return { gate: "scope", pass: false, details: `out-of-scope edits not covered by scope.allowDeviations:\n${hard.join("\n")}${note}` };
}
