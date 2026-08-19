import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tickmarkrDir } from "../../graph/graph.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  beatSupervision,
  supervisionStandDownPath,
  type SupervisionTier,
} from "../../run/supervision.js";

// SUP-04: the writer side of supervision, as a VERB. `beatSupervision` and `SUPERVISION_BEAT_MS` shipped
// with exactly one in-repo caller — the daemon, on one tier — so `status` printed
// `orchestrator ARMED / overseer ABSENT / watch ABSENT` while a real overseer worked the run: two thirds
// of a supervision claim were constants dressed as measurements. A seat that supervises from a shell
// (the overseer skill's watcher loop) has no way into a node module; a command does.
//
// ONE-SHOT AND ERROR-PROPAGATING, deliberately not `armSupervision`. That helper is the right shape for
// a long-lived node process and the wrong shape here twice over. Its recurring interval would outlive
// the invocation — in a long-lived dispatcher a later `--stand-down` would disarm only its own timer
// while an earlier one kept writing, flipping DISARMED back to ARMED ten seconds later: the exact
// fail-open this instrument exists to catch. And it swallows write failures by design (an unwritten
// beat ages out, which is the truth for a watcher that must not be crashed by its own instrument) —
// but a CLI that swallows them PRINTS a state nothing recorded, so `beat` says ARMED while `status`
// reads UNREADABLE. Here the writes are unguarded: a failure leaves the process with a non-zero exit
// and a message instead of a claim. The LOOP belongs to the caller, which is what makes the beat
// evidence: stop calling it and the tier ages into STALE on its own.
export async function beat(argv: string[], cwd = process.cwd()): Promise<string> {
  const standDown = argv.includes("--stand-down");
  const named = argv.find((a) => !a.startsWith("--"));
  if (!isTier(named)) {
    throw new Error(
      `usage: tickmarkr beat <${SUPERVISION_TIERS.join("|")}> [--stand-down] — got ${named ? `\`${named}\`` : "no tier"}`,
    );
  }
  if (standDown) return standDownTier(cwd, named);
  // Clear a stand-down marker left by an earlier session BEFORE beating: a valid marker outranks every
  // beat that does not strictly follow it, and two writes landing in the same millisecond do not. An
  // uncleared marker would render DISARMED while this verb claimed ARMED, so the removal is unguarded
  // too — `force` makes the ordinary "no marker" case a no-op, and anything else is a real failure.
  rmSync(supervisionStandDownPath(cwd, named), { force: true, recursive: true });
  beatSupervision(cwd, named);
  return `${named} ARMED — beat again every ${SUPERVISION_BEAT_MS / 1_000}s; the tier reads STALE ${SUPERVISION_STALE_MS / 1_000}s after the last beat`;
}

// Stand-down is a RECORDED act, not a silence: the marker tells a reader this watcher left on purpose,
// so the tier reads DISARMED rather than ageing out as a death. Published atomically — written aside,
// renamed over — because a torn marker is rejected by the reader, and a rejected stand-down reports a
// deliberate hand-off as a death.
function standDownTier(repoRoot: string, tier: SupervisionTier): string {
  tickmarkrDir(repoRoot); // the write path DOES create — markers land inside the gitignored state dir
  const p = supervisionStandDownPath(repoRoot, tier);
  const tmp = `${p}.${process.pid}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, JSON.stringify({ tier, pid: process.pid, disarmedAt: new Date().toISOString() }) + "\n");
  renameSync(tmp, p);
  return `${tier} DISARMED — hand-off recorded; status reads it stood down, not dead`;
}

const isTier = (v: string | undefined): v is SupervisionTier =>
  (SUPERVISION_TIERS as readonly string[]).includes(v ?? "");
