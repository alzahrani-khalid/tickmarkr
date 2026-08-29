import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tickmarkrDir } from "../../graph/graph.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_DEFAULT_THRESHOLD_PCT,
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
const VALUE_OPTIONS = ["--seat", "--arm-id", "--pct", "--threshold-pct"] as const;

export async function beat(argv: string[], cwd = process.cwd()): Promise<string> {
  const standDown = argv.includes("--stand-down");
  const seat = seatOf(argv);
  const pct = percentageOf(argv, "--pct");
  const thresholdPct = percentageOf(argv, "--threshold-pct") ?? SUPERVISION_DEFAULT_THRESHOLD_PCT;
  const armId = optionOf(argv, "--arm-id");
  const named = argv.find((a, i) =>
    !a.startsWith("--") && !(VALUE_OPTIONS as readonly string[]).includes(argv[i - 1] ?? "")
  );
  if (!isTier(named)) {
    throw new Error(
      `usage: tickmarkr beat <${SUPERVISION_TIERS.join("|")}> --seat <identity> ` +
        `[--arm-id <identity> --pct <0..100> --threshold-pct <0..100>] [--stand-down] — ` +
        `got ${named ? `\`${named}\`` : "no tier"}`,
    );
  }
  // SUP-05: NO SEAT, NO BEAT — and the refusal comes before any write, so a refused invocation leaves
  // the tier exactly as it found it. This verb is one-shot: the exitedWriterPid it records has
  // already exited by the time anyone reads the record, so tier + writer + instant is a beat nobody can
  // attribute to a seat. Measured 2026-08-26: a consult seat ran the documented loop verbatim and the
  // board read that tier ARMED with no seat of that tier having armed anything, and a seatless ARMED
  // reads as coverage — worse than ABSENT, because ABSENT sends someone to look.
  if (!seat) {
    throw new Error(
      `${named} needs --seat <identity> — a beat that names no seat arms a tier nobody occupies` +
        " (pass the seat's own pane id or agent name)",
    );
  }
  if (standDown) return standDownTier(cwd, named, seat);
  // Clear a stand-down marker left by an earlier session BEFORE beating: a valid marker outranks every
  // beat that does not strictly follow it, and two writes landing in the same millisecond do not. An
  // uncleared marker would render DISARMED while this verb claimed ARMED, so the removal is unguarded
  // too — `force` makes the ordinary "no marker" case a no-op, and anything else is a real failure.
  rmSync(supervisionStandDownPath(cwd, named), { force: true, recursive: true });
  beatSupervision(cwd, named, seat, pct === undefined ? undefined : { armId: armId ?? seat, pct, thresholdPct });
  return `${named} ARMED as ${seat} — beat again every ${SUPERVISION_BEAT_MS / 1_000}s; the tier reads STALE ${SUPERVISION_STALE_MS / 1_000}s after the last beat`;
}

/** `--seat <identity>` or `--seat=<identity>`; blank and missing are the same answer — none. */
function seatOf(argv: string[]): string | undefined {
  const seat = optionOf(argv, "--seat")?.trim();
  return seat && !seat.startsWith("--") ? seat : undefined;
}

/** A `--name value` or `--name=value` option, excluding a missing value or the next flag. */
function optionOf(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1).trim();
  const spaced = argv[argv.indexOf(name) + 1]?.trim();
  const value = inline ?? (argv.includes(name) ? spaced : undefined);
  return value && !value.startsWith("--") ? value : undefined;
}

function percentageOf(argv: string[], name: "--pct" | "--threshold-pct"): number | undefined {
  const raw = optionOf(argv, name);
  if (raw === undefined) {
    if (argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`))) {
      throw new Error(`${name} needs a number from 0 through 100`);
    }
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number from 0 through 100`);
  }
  return value;
}

// Stand-down is a RECORDED act, not a silence: the marker tells a reader this watcher left on purpose,
// so the tier reads DISARMED rather than ageing out as a death. Published atomically — written aside,
// renamed over — because a torn marker is rejected by the reader, and a rejected stand-down reports a
// deliberate hand-off as a death.
function standDownTier(repoRoot: string, tier: SupervisionTier, seat: string): string {
  tickmarkrDir(repoRoot); // the write path DOES create — markers land inside the gitignored state dir
  const p = supervisionStandDownPath(repoRoot, tier);
  const tmp = `${p}.${process.pid}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  // The marker names the seat for the same reason the beat does: "someone stood this tier down" is not
  // a hand-off anyone can act on, and on a seat tier the reader rejects an anonymous one outright.
  writeFileSync(tmp, JSON.stringify({
    tier, seat, exitedWriterPid: process.pid, disarmedAt: new Date().toISOString(),
  }) + "\n");
  renameSync(tmp, p);
  return `${tier} DISARMED — ${seat} handed off; status reads it stood down, not dead`;
}

const isTier = (v: string | undefined): v is SupervisionTier =>
  (SUPERVISION_TIERS as readonly string[]).includes(v ?? "");
