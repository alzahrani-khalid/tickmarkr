import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters } from "../../adapters/registry.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { loadConfig } from "../../config/config.js";
import type { ExecutorDriver } from "../../drivers/types.js";
import { scopeIntent } from "../../plan/scope.js";

export async function scope(
  argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  driver?: ExecutorDriver,
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { force: { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error("usage: tickmarkr scope <intent-file> [--force]");
  const source = positionals[0];
  const intentFile = isAbsolute(source) ? source : join(cwd, source);
  const result = await scopeIntent(intentFile, cwd, {
    cfg: loadConfig(cwd), adapters, driver, force: values.force,
  });
  const tasks = `${result.tasks} task${result.tasks === 1 ? "" : "s"}`;
  const calls = `${result.attempts} LLM call${result.attempts === 1 ? "" : "s"}`;
  return `scoped ${source} → ${relative(cwd, result.specFile)} (${tasks}, ${calls})`;
}
