import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { compileSource } from "../../compile/index.js";
import { saveGraph, stateDirName } from "../../graph/graph.js";
import { acquireRunLock, releaseRunLock } from "../../run/lock.js";

export async function compile(argv: string[], cwd = process.cwd()): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { type: { type: "string" } },
    allowPositionals: true,
  });
  const src = positionals[0];
  if (!src) throw new Error("usage: tickmarkr compile <spec-dir-or-md> [--type speckit|prd|gsd|native]");
  // resolve against the target repo, not the process cwd (the CLI test passes a tmp repo)
  const g = compileSource(
    isAbsolute(src) ? src : join(cwd, src),
    values.type as "speckit" | "prd" | "gsd" | "native" | undefined,
    cwd, // repo root: gsd stores context[0] repo-relative so workers resolve it inside their worktree
  );
  // HARD-01 / Sol #3: hold the same link(2) run lock as the daemon around saveGraph so compile
  // cannot swap graph.json under an active run between the daemon's read and act.
  const stateDir = stateDirName(cwd);
  acquireRunLock(cwd, "compile");
  try {
    saveGraph(cwd, g);
  } finally {
    releaseRunLock(cwd);
  }
  return `compiled ${src} → ${stateDir}/graph.json (${g.tasks.length} tasks, source ${g.spec.source}, hash ${g.spec.hash.slice(0, 12)})`;
}
