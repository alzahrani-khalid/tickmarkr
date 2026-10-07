import { parseArgs } from "node:util";
import {
  SUPERVISION_BEAT_MS,
  SUPERVISION_DEFAULT_THRESHOLD_PCT,
  SUPERVISION_STALE_MS,
  SUPERVISION_TIERS,
  beatSupervision,
  locateSupervisionRoot,
  newSupervisionArm,
  publishStandDown,
  readSupervisionArm,
  resolveSupervisionRoot,
  supervisionStatus,
  type SupervisionArm,
  type SupervisionTier,
} from "../../run/supervision.js";
import {
  BEAT_GENERATION_ENV,
  beatStatus,
  defaultBeatDeps,
  startBeat,
  stopBeat,
  supervised,
  unclaimed,
  withLegacyClaim,
  type BeatLifecycleDeps,
  type ClaimGuard,
  type LegacyRecheck,
} from "../../run/beat-lifecycle.js";

// Two forms share one strict parser. The lifecycle verbs `start|stop|status <tier>` own a DETACHED loop
// (src/run/beat-lifecycle.ts); the legacy `<tier>` form keeps its duties: one-shot ticks reuse a durable
// arm, only --new-arm (or --loop) acknowledges a stand-down, and --status is the read-only status verb.
// Every refusal is NONZERO: the shipped watcher gates on the exit code with stdout discarded, so a refusal
// that exits 0 leaves a live watcher believing it is armed while status reads DISARMED — and a loop that is
// stood down, superseded or cannot write exits nonzero with its reason instead of going silently quiet.
const VERBS = ["start", "stop", "status"] as const;
type Verb = (typeof VERBS)[number];
const LEGACY_WRITER_OPTIONS = ["new-arm", "loop", "arm-id", "pct", "threshold-pct", "stand-down"] as const;

const usage = (got: string | undefined) =>
  `usage: tickmarkr beat <start|stop|status> <tier> --seat <identity> | tickmarkr beat <${SUPERVISION_TIERS.join("|")}> --seat <identity> ` +
  `[--new-arm] [--loop] [--arm-id <identity> --pct <0..100> --threshold-pct <0..100>] [--stand-down] [--status] — ` +
  `got ${got ? `\`${got}\`` : "no tier"}`;

export async function beat(
  argv: string[], cwd = process.cwd(), deps: BeatLifecycleDeps = defaultBeatDeps(),
): Promise<string | { out: string; code: number }> {
  const parsed = parseBeat(argv);
  const { verb, tier, seat, values } = parsed;
  if (verb === "status" || values.status) {
    // Read-only by construction: locating the root never creates it, and a repository without a state
    // dir has, truthfully, no beat recorded.
    const { root, state } = locateSupervisionRoot(cwd);
    return state ? beatStatus(root, tier, seat, deps) : { out: `${tier} ABSENT — no state directory`, code: 0 };
  }
  // SUP-05: NO SEAT, NO BEAT — and the refusal comes before any write, so a refused invocation leaves
  // the tier exactly as it found it. Tier + writer + instant is a beat nobody can attribute to a seat
  // (measured 2026-08-26), and a seatless ARMED reads as coverage — worse than ABSENT.
  if (!seat) {
    throw new Error(
      `${verb ? `${verb} ${tier}` : tier} needs --seat <identity> — a beat that names no seat arms a tier nobody occupies` +
        " (pass the seat's own pane id or agent name)",
    );
  }
  // A beat names repository state, never the caller's incidental directory. Resolution is read-only
  // and happens before every write, so a non-repository invocation cannot create the state it claims.
  const repoRoot = resolveSupervisionRoot(cwd);
  if (verb === "start") return startBeat(repoRoot, tier, seat, deps);
  if (verb === "stop") return stopBeat(repoRoot, tier, seat, deps);
  // Every legacy writer reclaims a claim whose recorded pids are all confirmed dead (a writer killed inside its claimed
  // tick), recovers what a killed taker or writer left (its removal lock or pid-named lock entry, act marker, stage
  // directory) and retires a dead or abandoned generation recorded for its seat (stood down, owner removed, nothing
  // signalled); each such notice leads the final result or refusal, so a recovery is never reported as a plain write.
  const notices: string[] = [];
  const told = (message: string) => [...notices, message].join("\n");
  try {
    return told(await legacyWrite(repoRoot, tier, seat, values, deps, (notice) => { notices.push(notice); }));
  } catch (error) {
    throw notices.length > 0 && error instanceof Error ? new Error(told(error.message)) : error;
  }
}

async function legacyWrite(
  repoRoot: string, tier: SupervisionTier, seat: string, values: ParsedBeat["values"], deps: BeatLifecycleDeps, noticed: (notice: string) => void,
): Promise<string> {
  const generation = deps.env[BEAT_GENERATION_ENV]?.trim() || undefined;
  const writer = (settled = false, arm?: SupervisionArm) => ({ generation, seat, settled, arm, deps, noticed });
  if (values["stand-down"]) {
    return withLegacyClaim(repoRoot, tier, writer(), (recheck, held) => { recheck(); return standDownTier(repoRoot, tier, seat, held); });
  }
  const loop = values.loop === true;
  const armId = values["arm-id"];
  const pct = percentage(values.pct, "--pct");
  const thresholdPct = percentage(values["threshold-pct"], "--threshold-pct") ?? SUPERVISION_DEFAULT_THRESHOLD_PCT;
  // Context arm ids retain their existing obligation semantics; they do not implicitly re-arm liveness.
  const observe = (arm?: SupervisionArm) =>
    pct === undefined ? undefined : { armId: armId ?? arm?.armId ?? seat, pct, thresholdPct };
  // EVERY mutation — the one-shot tick, the arm, and each later loop tick — runs under the tier claim, and
  // `recheck` re-reads that claim and the tier's ownership immediately before the write: a generation-carrying
  // writer mutates only while its COMPLETE generation (token, seat, pid once settled, and the owner's durable
  // arm id + epoch) is on record; every other writer only while no detached beat owns the tier. `created` marks
  // the arm this same claim just published: an owned re-arm rebinds the owner record to it — only while that arm
  // and the owner checked before it are still the ones on disk — and is checked again as that new generation
  // before its beat. A running loop carries its arm into every check. Each supervision write (arm, beat, marker)
  // is staged and committed record by record, each rename one claimed act under `held` (supervised): inside it this
  // same ownership check runs again, every record must still be what the write was staged from, and the claim is
  // verified last — a claim lost, or an owner or arm replaced, before a commit lands nothing further. A claim someone
  // else holds is waited out under the ONE finite policy (BEAT_CLAIM_WAIT: 20 attempts 250 ms apart, shared with
  // stop), then refuses BUSY with no bytes changed — unless every pid it records is confirmed dead, when it is
  // reclaimed with a notice.
  const tick = (recheck: LegacyRecheck, held: ClaimGuard, arm?: SupervisionArm, created = false) => {
    recheck(arm, created);
    // The fence travels with the beat: a stand-down that landed while this beat was committed still dominates it.
    if (supervised(repoRoot, tier, held, (root) => beatSupervision(root, tier, seat, observe(arm), { arm, armId, loop })) &&
      supervisionStatus(repoRoot, tier).state !== "DISARMED") return;
    const current = arm && readSupervisionArm(repoRoot, tier);
    if (arm && (current?.armId !== arm.armId || current.armEpoch !== arm.armEpoch)) {
      throw new Error(`${tier} superseded — a newer arm replaced this loop's arm ${arm.armId}; exiting`);
    }
    throw new Error(`${tier} DISARMED — stood down; use --new-arm to resume beating`);
  };
  if (values["new-arm"] || loop) {
    const arm = await withLegacyClaim(repoRoot, tier, writer(), (recheck, held) => {
      recheck();
      const created = supervised(repoRoot, tier, held, (root) => newSupervisionArm(root, tier, armId));
      tick(recheck, held, created, true);
      return created;
    });
    // ponytail: every tick outlasts a brief claim holder (a repeat start, a stop) for ~5 s of retries, then
    // refuses nonzero; a per-tick deadline if holders ever legitimately run longer.
    while (loop) {
      await deps.sleep(SUPERVISION_BEAT_MS);
      await withLegacyClaim(repoRoot, tier, writer(true, arm), (recheck, held) => tick(recheck, held, arm));
    }
  } else await withLegacyClaim(repoRoot, tier, writer(), (recheck, held) => tick(recheck, held));
  return `${tier} ARMED as ${seat} — beat again every ${SUPERVISION_BEAT_MS / 1_000}s; the tier reads STALE ${SUPERVISION_STALE_MS / 1_000}s after the last beat`;
}

interface ParsedBeat {
  verb?: Verb;
  tier: SupervisionTier;
  seat?: string;
  values: Partial<Record<"seat" | "arm-id" | "pct" | "threshold-pct", string> & Record<"new-arm" | "loop" | "stand-down" | "status", boolean>>;
}

/** Unknown, duplicate, conflicting or empty options refuse here — before anything is read or written. */
function parseBeat(argv: string[]): ParsedBeat {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true, tokens: true,
      options: {
        seat: { type: "string" }, "new-arm": { type: "boolean" }, loop: { type: "boolean" },
        "arm-id": { type: "string" }, pct: { type: "string" }, "threshold-pct": { type: "string" },
        "stand-down": { type: "boolean" }, status: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new Error(`${(error as Error).message} — ${usage(undefined).replace(/ — got .*$/, "")}`);
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`duplicate --${token.name} — pass each option once`);
    seen.add(token.name);
    if (typeof token.value === "string" && !token.value.trim()) throw new Error(`--${token.name} needs a non-empty value`);
  }
  const values = parsed.values as ParsedBeat["values"];
  const [first, ...rest] = parsed.positionals;
  const verb = (VERBS as readonly string[]).includes(first ?? "") ? first as Verb : undefined;
  const named = verb ? rest[0] : first;
  if (!isTier(named)) throw new Error(usage(verb && named === undefined ? `${verb} with no tier` : named));
  const extra = (verb ? rest.slice(1) : rest)[0];
  if (extra !== undefined) throw new Error(`unexpected argument \`${extra}\` — ${usage(named).replace(/ — got .*$/, "")}`);
  const readOnly = verb !== undefined || values.status;
  const writer = LEGACY_WRITER_OPTIONS.find((name) => values[name] !== undefined);
  if (readOnly && writer) throw new Error(`--${writer} conflicts with ${verb ? `beat ${verb}` : "--status"}`);
  if (verb && values.status) throw new Error(`--status conflicts with beat ${verb}`);
  const withStandDown = values["stand-down"] && LEGACY_WRITER_OPTIONS.find((name) => name !== "stand-down" && values[name] !== undefined);
  if (withStandDown) throw new Error(`--${withStandDown} conflicts with --stand-down`);
  return { ...(verb ? { verb } : {}), tier: named, ...(values.seat ? { seat: values.seat.trim() } : {}), values };
}

function percentage(raw: string | undefined, name: "--pct" | "--threshold-pct"): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number from 0 through 100`);
  }
  return value;
}

/** Record an explicit hand-off: the tier reads DISARMED, a stood-down tier, not a dead one. `held`: the writer's claimed-act guard. */
export function standDownTier(repoRoot: string, tier: SupervisionTier, seat: string, held: ClaimGuard = unclaimed): string {
  supervised(repoRoot, tier, held, (root) => publishStandDown(root, tier, seat));
  return `${tier} DISARMED — ${seat} handed off; status reads it stood down, not dead`;
}

const isTier = (v: string | undefined): v is SupervisionTier =>
  (SUPERVISION_TIERS as readonly string[]).includes(v ?? "");
