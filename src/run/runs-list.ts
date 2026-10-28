import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDirName } from "../graph/graph.js";
import { parseRunId } from "./journal.js";

export type ListedRun = { runId: string; title?: string; updatedAt: string };

/** Runs are journals, not ACP state. A directory awaiting its first append is not a session. */
export function listRuns(cwd: string): ListedRun[] {
  const root = join(cwd, stateDirName(cwd), "runs");
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.sort().reverse().flatMap(runId => {
    try { if (parseRunId(runId) !== runId) return []; } catch { return []; }
    let updatedAt: string;
    try {
      const journal = statSync(join(root, runId, "journal.jsonl"));
      if (!journal.isFile()) return [];
      updatedAt = journal.mtime.toISOString();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return []; throw error; }
    let title: string | undefined;
    try {
      const graph = JSON.parse(readFileSync(join(root, runId, "graph.json"), "utf8"));
      const path = graph?.spec?.paths?.[0];
      if (typeof path === "string" && path) title = basename(path);
    } catch { /* Old or incomplete runs remain listable without a graph title. */ }
    return [{ runId, updatedAt, ...(title === undefined ? {} : { title }) }];
  });
}
