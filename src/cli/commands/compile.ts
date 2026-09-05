import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import {
  collateralLints, sourceScopeFindings, sourceScopeLints, type SourceScopeFinding,
} from "../../compile/collateral.js";
import { CompileError } from "../../compile/common.js";
import { compileSource } from "../../compile/index.js";
import { clearCompileRefusal, saveCompileRefusal, saveGraph, stateDirName } from "../../graph/graph.js";
import { formatPriorFindingEvidence, readPriorRunEvidence, type PriorMergeEvidence } from "../../run/journal.js";
import { shGit } from "../../run/git.js";
import { acquireRunLock, releaseRunLock } from "../../run/lock.js";
import { harnessLine, resolveHarness } from "../harness.js";

export function nativeSourceScopeErrors(
  graph: ReturnType<typeof compileSource>,
  findings: readonly SourceScopeFinding[],
): string[] {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const errors: string[] = [];
  for (const finding of findings) {
    const task = byId.get(finding.taskId);
    if (!task) continue;
    for (const path of finding.paths) {
      if (task.goal.includes(`scope-waiver: ${path}`)) continue;
      errors.push(`${task.id}: ${path} requires scope-waiver: ${path} in the task goal`);
    }
  }
  return errors;
}

async function mergedPendingDiagnostics(
  cwd: string,
  pending: ReadonlySet<string>,
  merges: readonly PriorMergeEvidence[],
): Promise<string[]> {
  const head = await shGit("git rev-parse HEAD", cwd);
  const base = head.code === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/i.test(base)) return [];
  const lines: string[] = [];
  for (const taskId of pending) {
    const candidates = merges.filter((merge) => merge.taskId === taskId).reverse();
    for (const merge of candidates) {
      const ancestor = await shGit(`git merge-base --is-ancestor ${merge.commit} ${base}`, cwd);
      if (ancestor.code !== 0) continue;
      lines.push(`${taskId}: merged in run ${merge.runId}; compiles as pending (plan not marked done) — this dispatch rebuilds it`);
      break; // one pure-information line per pending task, newest reachable merge wins
    }
  }
  return lines;
}

// v1.89 T4: harnessFrom is the resolver's INPUT (see plan.ts); the default is the INVOKED entrypoint
// (`process.argv[1]`, the bin symlink), never this module's own url — that names an internal module.
export async function compile(argv: string[], cwd = process.cwd(), harnessFrom: string | undefined = process.argv[1]): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      type: { type: "string" },
      "dry-run": { type: "boolean" },
      strict: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const src = positionals[0];
  if (!src) throw new Error("usage: tickmarkr compile <spec-dir-or-md> [--type speckit|prd|gsd|native] [--dry-run] [--strict]");
  const sourcePath = isAbsolute(src) ? src : join(cwd, src);
  let stateWriteStarted = false;
  try {
    // Resolve against the target repo, not the process cwd (the CLI test passes a tmp repo).
    // Both modes reach the same pure compiler; --dry-run removes every state write below.
    const g = compileSource(
      sourcePath,
      values.type as "speckit" | "prd" | "gsd" | "native" | undefined,
      cwd, // repo root: gsd stores context[0] repo-relative so workers resolve it inside their worktree
      (plan) => plan,
      { strict: values.strict },
    );
    const sourceFindings = sourceScopeFindings(g.tasks, cwd);
    const scopeLints = [
      ...collateralLints(g.tasks, cwd),
      ...sourceScopeLints(g.tasks, cwd, sourceFindings),
    ];
    const diagnostics = scopeLints.length
      ? `\nscope lints:\n${scopeLints.map((lint) => `  ! ${lint}`).join("\n")}`
      : "";
    const unwaived = g.spec.source === "native" ? nativeSourceScopeErrors(g, sourceFindings) : [];
    if (unwaived.length > 0) {
      throw new CompileError(`${src} has unwaived native source-scope authoring errors:\n${unwaived.map((line) => `  - ${line}`).join("\n")}${diagnostics}`);
    }
    // One bounded read supplies both cross-run surfaces: unresolved findings below and merge facts for
    // the ancestry check. Neither fact mutates the compiled graph; status and every readiness predicate
    // remain the source compiler's answer.
    const prior = readPriorRunEvidence(cwd, g.tasks);
    const mergedPending = await mergedPendingDiagnostics(
      cwd,
      new Set(g.tasks.filter((task) => task.status === "pending").map((task) => task.id)),
      prior.merges,
    );
    const stateDir = stateDirName(cwd);
    if (!values["dry-run"]) {
      // HARD-01 / Sol #3: hold the same link(2) run lock as the daemon around both truth records so
      // compile cannot swap graph.json under an active run between the daemon's read and act.
      stateWriteStarted = true;
      acquireRunLock(cwd, "compile");
      try {
        saveGraph(cwd, g);
        clearCompileRefusal(cwd);
      } finally {
        releaseRunLock(cwd);
      }
    }
    const summary = values["dry-run"]
      ? `validated ${src} (${g.tasks.length} tasks, source ${g.spec.source}, hash ${g.spec.hash.slice(0, 12)}) — dry run; no graph written`
      : `compiled ${src} → ${stateDir}/graph.json (${g.tasks.length} tasks, source ${g.spec.source}, hash ${g.spec.hash.slice(0, 12)})`;
    const priorFindings = prior.findings.length
      ? `\nprior-run evidence:\n${prior.findings.map((finding) => `  ${formatPriorFindingEvidence(finding)}`).join("\n")}`
      : "";
    const mergeHistory = mergedPending.length
      ? `\nmerge history:\n${mergedPending.map((line) => `  ${line}`).join("\n")}`
      : "";
    return `${harnessLine(resolveHarness(harnessFrom))}\n${summary}${diagnostics}${priorFindings}${mergeHistory}`;
  } catch (error) {
    // A dry run is a pure validation query. A real authoring refusal records the negative result
    // without replacing the last good graph; run treats this sibling as newer truth than that graph.
    // State-write failures are excluded: a live daemon's lock refusal is not a verdict on the spec.
    if (!values["dry-run"] && !stateWriteStarted) {
      try {
        acquireRunLock(cwd, "compile-refusal");
        try {
          saveCompileRefusal(cwd, {
            refusedAt: new Date().toISOString(),
            source: sourcePath,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          releaseRunLock(cwd);
        }
      } catch {
        // The refusal record is best-effort when a live run owns the state boundary. That lock
        // verdict must never replace the compile error that tells the operator what to repair.
      }
    }
    throw error;
  }
}
