import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { collateralLints, sourceScopeLints } from "../../compile/collateral.js";
import { compileSource } from "../../compile/index.js";
import { saveGraph, stateDirName } from "../../graph/graph.js";
import { acquireRunLock, releaseRunLock } from "../../run/lock.js";
import { harnessLine, resolveHarness } from "../harness.js";

// v1.89 T4: harnessFrom is the resolver's INPUT (see plan.ts); the default is the INVOKED entrypoint
// (`process.argv[1]`, the bin symlink), never this module's own url — that names an internal module.
export async function compile(argv: string[], cwd = process.cwd(), harnessFrom: string | undefined = process.argv[1]): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      type: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const src = positionals[0];
  if (!src) throw new Error("usage: tickmarkr compile <spec-dir-or-md> [--type speckit|prd|gsd|native] [--dry-run]");
  // resolve against the target repo, not the process cwd (the CLI test passes a tmp repo)
  // Both modes reach the same pure compiler; --dry-run only removes the lock/write side effect below.
  const g = compileSource(
    isAbsolute(src) ? src : join(cwd, src),
    values.type as "speckit" | "prd" | "gsd" | "native" | undefined,
    cwd, // repo root: gsd stores context[0] repo-relative so workers resolve it inside their worktree
  );
  const stateDir = stateDirName(cwd);
  if (!values["dry-run"]) {
    // HARD-01 / Sol #3: hold the same link(2) run lock as the daemon around saveGraph so compile
    // cannot swap graph.json under an active run between the daemon's read and act.
    acquireRunLock(cwd, "compile");
    try {
      saveGraph(cwd, g);
    } finally {
      releaseRunLock(cwd);
    }
  }
  const summary = values["dry-run"]
    ? `validated ${src} (${g.tasks.length} tasks, source ${g.spec.source}, hash ${g.spec.hash.slice(0, 12)}) — dry run; no graph written`
    : `compiled ${src} → ${stateDir}/graph.json (${g.tasks.length} tasks, source ${g.spec.source}, hash ${g.spec.hash.slice(0, 12)})`;
  const scopeLints = [...collateralLints(g.tasks, cwd), ...sourceScopeLints(g.tasks, cwd)];
  const diagnostics = scopeLints.length
    ? `\nscope lints:\n${scopeLints.map((lint) => `  ! ${lint}`).join("\n")}`
    : "";
  return `${harnessLine(resolveHarness(harnessFrom))}\n${summary}${diagnostics}`;
}
