import { createInterface } from "node:readline/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters } from "../../adapters/registry.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { loadConfig } from "../../config/config.js";
import type { ExecutorDriver } from "../../drivers/types.js";
import { formatScopePreview, previewScope, scopeIntent } from "../../plan/scope.js";

// R11/R16/R45 (C10): --preview is a read-only disclosure (cached candidate, destination, call
// budget) — it never probes, never calls a model, and never writes. Active scope reuses that same
// disclosure to build a confirmation question, then requires TTY "y" or --yes before it invokes the
// unchanged production authoring path (scopeIntent); a non-TTY shell without --yes refuses rather
// than silently proceeding (the unlock.ts confirm() convention).
export async function scope(
  argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  driver?: ExecutorDriver,
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { force: { type: "boolean" }, preview: { type: "boolean" }, yes: { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error("usage: tickmarkr scope <intent-file> [--preview] [--yes] [--force]");
  const source = positionals[0];
  const intentFile = isAbsolute(source) ? source : join(cwd, source);
  const cfg = loadConfig(cwd);

  const preview = previewScope(intentFile, cwd, { cfg, adapters });
  if (values.preview) return formatScopePreview(preview);

  const confirm = async (question: string): Promise<boolean> => {
    if (values.yes) return true;
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^(?:y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  };
  const candidateLabel = preview.candidate
    ? `${preview.candidate.adapter}:${preview.candidate.model}`
    : `an unknown candidate (${preview.cached ? "no verified channel in the doctor cache" : "no doctor cache"})`;
  const question = `Draft ${relative(cwd, preview.specFile)} via ${candidateLabel} using up to ${preview.authoringBudget} authoring call${preview.authoringBudget === 1 ? "" : "s"} plus ${preview.probeCalls} probe call${preview.probeCalls === 1 ? "" : "s"}?`;
  if (!(await confirm(question))) {
    throw new Error("scope: not confirmed (pass --yes or confirm at a TTY)");
  }

  // Bind dispatch to exactly the candidate just disclosed and confirmed (R11/R45 repair) — scopeIntent
  // fails loud rather than silently authoring against a different channel a fresh probe turns up.
  const result = await scopeIntent(intentFile, cwd, { cfg, adapters, driver, force: values.force, candidate: preview.candidate });
  const tasks = `${result.tasks} task${result.tasks === 1 ? "" : "s"}`;
  const calls = `${result.attempts} LLM call${result.attempts === 1 ? "" : "s"}`;
  return `scoped ${source} → ${relative(cwd, result.specFile)} (${tasks}, ${calls})`;
}
