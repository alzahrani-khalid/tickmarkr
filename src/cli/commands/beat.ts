import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tickmarkrDir } from "../../graph/graph.js";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_DEFAULT_THRESHOLD_PCT,
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  beatSupervision,
  newSupervisionArm,
  resolveSupervisionRoot,
  supervisionStandDownPath,
  type SupervisionTier,
} from "../../run/supervision.js";

// One-shot ticks reuse a durable arm; only --new-arm (or --loop) acknowledges a stand-down.
// The loop runs in this process, so its recorded pid belongs to the actual repeating writer.
// Writes are unguarded and a refused ONE-SHOT tick THROWS: the shipped watcher gates on the exit
// code with stdout discarded, so a refusal that exits 0 leaves a live watcher believing it is armed
// while status reads DISARMED. Only the loop returns on stand-down — exiting is its designed end.
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
        `[--new-arm] [--loop] [--arm-id <identity> --pct <0..100> --threshold-pct <0..100>] [--stand-down] — ` +
        `got ${named ? `\`${named}\`` : "no tier"}`,
    );
  }
  // SUP-05: NO SEAT, NO BEAT — and the refusal comes before any write, so a refused invocation leaves
  // the tier exactly as it found it. In one-shot mode the exitedWriterPid it records has
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
  // A beat names repository state, never the caller's incidental directory. Resolution is read-only
  // and happens before every write, so a non-repository invocation cannot create the state it claims.
  const repoRoot = resolveSupervisionRoot(cwd);
  if (standDown) return standDownTier(repoRoot, named, seat);
  const loop = argv.includes("--loop");
  const arm = argv.includes("--new-arm") || loop ? newSupervisionArm(repoRoot, named, armId) : undefined;
  // Context arm ids retain their existing obligation semantics; they do not implicitly re-arm liveness.
  const observation = pct === undefined ? undefined : { armId: armId ?? arm?.armId ?? seat, pct, thresholdPct };
  do {
    if (!beatSupervision(repoRoot, named, seat, observation, { arm, armId, loop })) {
      const refusal = `${named} DISARMED — stood down; use --new-arm to resume beating`;
      if (loop) return refusal;
      throw new Error(refusal);
    }
    if (!loop) break;
    await new Promise<void>((resolve) => setTimeout(resolve, SUPERVISION_BEAT_MS));
  } while (loop);
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
export function standDownTier(repoRoot: string, tier: SupervisionTier, seat: string): string {
  tickmarkrDir(repoRoot); // the write path DOES create — markers land inside the gitignored state dir
  const p = supervisionStandDownPath(repoRoot, tier);
  const tmp = `${p}.${randomUUID()}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  // The marker names the seat for the same reason the beat does: "someone stood this tier down" is not
  // a hand-off anyone can act on, and on a seat tier the reader rejects an anonymous one outright.
  writeFileSync(tmp, JSON.stringify({
    tier, seat, standDownId: randomUUID(), exitedWriterPid: process.pid, disarmedAt: new Date().toISOString(),
  }) + "\n");
  renameSync(tmp, p);
  return `${tier} DISARMED — ${seat} handed off; status reads it stood down, not dead`;
}

const isTier = (v: string | undefined): v is SupervisionTier =>
  (SUPERVISION_TIERS as readonly string[]).includes(v ?? "");
