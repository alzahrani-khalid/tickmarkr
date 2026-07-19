import { loadConfig } from "../../config/config.js";
import { pickDriver } from "../../drivers/index.js";
import { type RunSummary, formatSummary, runDaemon } from "../../run/daemon.js";
import { formatJournalNarration } from "../../run/journal.js";

const summaryGreen = (s: RunSummary) =>
  s.failed.length === 0 && s.human.length === 0 && s.blocked.length === 0 && s.pending.length === 0
  && s.tipVerify !== "failed";

export async function resume(argv: string[], cwd = process.cwd()): Promise<{ out: string; code: number }> {
  const runId = argv[0];
  if (!runId) throw new Error("usage: tickmarkr resume <run-id>");
  // T3: --graph-changed is the operator's audited release of the engagement-identity guard (Sol #2 /
  // Fable F2) — the daemon refuses a mismatched/unbound journal unless this is set, then journals a
  // graph-rehash event naming both hashes. Strip the flag before runId resolution so a bare id still wins.
  const graphChanged = argv.includes("--graph-changed");
  const s = await runDaemon(cwd, { runId, resume: true, graphChanged, driver: pickDriver(loadConfig(cwd)), narrate: (event) => console.log(formatJournalNarration(event)) });
  const out = `resumed ${s.runId} — ${formatSummary(s)}`;
  return { out, code: summaryGreen(s) ? 0 : 2 };
}
