import { unlockRun } from "../../run/lock.js";

// LOCK-03: thin formatter over unlockRun. A live-holder refusal propagates as the throw — the
// dispatcher prints `tickmarkr unlock: …` and exits 1 (src/cli/index.ts).
export async function unlock(_argv: string[], cwd = process.cwd()): Promise<string> {
  const r = unlockRun(cwd);
  if (!r.held) return "no lock held — nothing to remove";
  if (r.garbage) return "removed garbage lock (unparseable payload)";
  return `removed stale lock — holder pid ${r.pid}${r.runId ? ` (run ${r.runId})` : ""} is dead`;
}
