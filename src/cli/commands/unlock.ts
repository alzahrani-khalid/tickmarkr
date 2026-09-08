import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { commitGarbageUnlock, commitUnlock, previewGarbageUnlock, previewUnlock } from "../../run/lock.js";

// LOCK-03/R16-17: thin formatter over lock.ts's preview/commit pair. `tickmarkr unlock <run-id>`
// recovers a valid, provably-dead lock naming exactly that run (R17: a run ID is required — no
// bare "unlock whatever is there"); `tickmarkr unlock --garbage` recovers an unparseable snapshot
// identified by bytes/inode instead, never inventing a run ID. Both mutate only after TTY
// confirmation or --yes, and both re-check fresh at commit time — this command never trusts the
// preview it showed the operator for the removal itself.
export async function unlock(argv: string[], cwd = process.cwd()): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { garbage: { type: "boolean" }, yes: { type: "boolean" } },
    allowPositionals: true,
  });

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

  if (values.garbage) {
    const preview = previewGarbageUnlock(cwd);
    if (!preview.held) return "no lock held — nothing to remove";
    if (!preview.eligible) throw new Error(preview.reason);
    const bytes = preview.raw.length === 0 ? "empty" : `${preview.raw.length} byte${preview.raw.length === 1 ? "" : "s"}`;
    const digest = createHash("sha256").update(preview.raw).digest("hex");
    if (!(await confirm(`Remove garbage lock (${bytes}, inode ${preview.ino}, sha256 ${digest})?`))) {
      throw new Error("unlock --garbage: not confirmed (pass --yes or confirm at a TTY)");
    }
    const commit = commitGarbageUnlock(cwd, { ino: preview.ino, raw: preview.raw });
    if (!commit.removed) throw new Error(commit.reason);
    return "removed garbage lock (unparseable payload)";
  }

  const runId = positionals[0];
  if (!runId) throw new Error("usage: tickmarkr unlock <run-id> [--yes] | tickmarkr unlock --garbage [--yes]");

  const preview = previewUnlock(cwd, runId);
  if (!preview.held) return "no lock held — nothing to remove";
  if (!preview.eligible) throw new Error(preview.reason);
  if (!(await confirm(`Remove lock held by dead pid ${preview.pid} (run ${preview.runId})?`))) {
    throw new Error("unlock: not confirmed (pass --yes or confirm at a TTY)");
  }
  const commit = commitUnlock(cwd, preview);
  if (!commit.removed) throw new Error(commit.reason);
  return `removed stale lock — holder pid ${commit.pid} (run ${commit.runId}) is dead`;
}
