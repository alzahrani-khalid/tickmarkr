import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { stateDirName, tickmarkrDir } from "../graph/graph.js";

// SUP-01: supervision liveness as FILE STATE, not as a report — lock.ts's proven shape, one file per
// tier. A watcher beats its OWN file; every other seat derives that tier's state by stat()ing it. So
// "watchers alive" stops being the one claim only the seat that already lost it could make: the reader
// is never the watcher, and a watcher that dies stops writing without having to notice it died.
//
// BOTH polarities are distinguishable by construction, because collapsing them IS the defect: a seat
// that never armed reads exactly like one that armed and then died. No record at all ⇒ ABSENT (never
// armed). A record whose beat has aged past the ceiling ⇒ STALE (armed, then died). A fresh one ⇒
// ARMED. ABSENT is its own branch below and carries no age — STALE always carries one.
//
// SUP-02: the beat mtime is the ONLY input. Nothing here reads a process table and nothing matches a
// process name — a poll-grep watcher carries `grep` in its own argv, so the filter that removes the
// probing grep removes the watched one. The payload records a pid for an OPERATOR to read off a STALE
// record; the derivation never consults it, so a reused, dead or unreadable pid changes no state.
// Zero new deps — node:fs stdlib, exactly as lock.ts.

/** How often a watcher rewrites its own tier's beat. */
export const SUPERVISION_BEAT_MS = 10_000;
/** Ceiling before a beat reads STALE: SIX beats, lock.ts's ratio — five may be missed before alarm. */
export const SUPERVISION_STALE_MS = 6 * SUPERVISION_BEAT_MS;
// SUP-03: the ONLY legitimate reason a beat's mtime may lead the reader's clock is that the two are
// not the same clock and not the same resolution — a filesystem stamps sub-millisecond, Date.now()
// truncates to whole milliseconds, so a beat written this instant can read a fraction of a
// millisecond into the future. A second of slack covers even a coarse filesystem. Anything past it
// is SKEW, and skew is the one direction this instrument may not fail in: see readTierLiveness.
export const SUPERVISION_FUTURE_GRACE_MS = 1_000;

// The supervision seats this harness has. An unlisted tier is an INVISIBLE tier, which is the failure
// mode itself — an auditor read "no watchers were ever armed" off a surface that named none. Adding a
// seat means adding it here, and `status` then renders it whether or not it has ever beaten.
// SUP-05: CONTEXT is per SEAT, so its tiers are per seat too. One shared `context` tier would be read
// by both supervising seats and beaten by whichever of them still had a watcher, so a live overseer
// watcher would render the dead orchestrator one as armed — the mask this whole instrument exists to
// remove. The enumeration is CLOSED at one tier per supervising seat: orchestrator and overseer.
// `watch` beats nowhere on this tree and stays ABSENT, which is what ABSENT means.
export const SUPERVISION_TIERS = [
  "orchestrator", "orchestrator-context", "overseer", "overseer-context", "watch",
] as const;

export type SupervisionTier = (typeof SUPERVISION_TIERS)[number];

// The tiers whose records must NAME the seat behind them. A one-shot `tickmarkr beat` records a pid
// that has already exited by the time anyone reads it, and an instant — nothing a reader can attribute
// to a seat. Measured 2026-08-26: a consult seat of another tier ran the documented beat loop and the
// board read that tier armed with no seat of that tier having armed anything. ARMED-and-seatless reads
// as coverage, which is worse than ABSENT, so on these tiers a record that names no seat is not a beat.
export const SUPERVISION_SEAT_TIERS = ["orchestrator-context", "overseer-context"] as const;

export type SeatTier = (typeof SUPERVISION_SEAT_TIERS)[number];

/** Does this tier's record have to name the seat it speaks for? */
export const isSeatTier = (tier: string): tier is SeatTier =>
  (SUPERVISION_SEAT_TIERS as readonly string[]).includes(tier);
// UNREADABLE is the fourth honest answer: something occupies the beat path but no beat can be derived
// from it (an unreadable inode, or a directory someone dropped there). Folding that into ABSENT would
// report "never armed" about a seat that may well be armed — the same lie in a new costume — and
// folding it into ARMED would call any stat-able inode a heartbeat.
// DISARMED is the fifth: a watcher that STOOD DOWN. T3's three states never asked what a clean
// stand-down reads as, so it read STALE once the ceiling passed — a deliberate hand-off rendered
// with the value that means "this watcher died". A stand-down is an act the watcher can record,
// and a death is exactly the case where nothing can be recorded, so the two are told apart by the
// presence of that record and never by the beat's age.
export type SupervisionState = "ABSENT" | "STALE" | "ARMED" | "UNREADABLE" | "DISARMED";
export interface TierLiveness {
  tier: SupervisionTier;
  state: SupervisionState;
  /** Absent for ABSENT, UNREADABLE and DISARMED — no beat to age. Always present for STALE and ARMED. */
  beatAgeMs?: number;
  /** The seat the record names, when it names one. Always present on a seat tier that is not ABSENT. */
  seat?: string;
}

// PURE path math: stateDirName, never tickmarkrDir — the latter mkdirs the state dir and writes its
// .gitignore, so routing a READER through it would make status create the very tree it reports on.
export const supervisionBeatPath = (repoRoot: string, tier: SupervisionTier): string =>
  join(repoRoot, stateDirName(repoRoot), "supervision", `${tier}.beat`);

/** Where a watcher records that it STOOD DOWN. Its own file: the beat keeps meaning only "alive". */
export const supervisionStandDownPath = (repoRoot: string, tier: SupervisionTier): string =>
  join(repoRoot, stateDirName(repoRoot), "supervision", `${tier}.standdown`);

// WRITER — a watcher's own call, on its own tier, every SUPERVISION_BEAT_MS. Never a reader's: the
// purity fence (status --watch leaves the state dir byte-identical) is the test that catches a reader
// that beats on the watcher's behalf, which would report every dead tier as healthy.
export function beatSupervision(repoRoot: string, tier: SupervisionTier, seat?: string): void {
  // A seat tier may not be armed anonymously, and the refusal belongs HERE rather than only in the
  // verb: any caller that could write a seatless record could arm a tier nobody occupies.
  if (isSeatTier(tier) && !seat?.trim()) {
    throw new Error(`${tier} is a per-seat tier — a beat must declare the seat identity it speaks for`);
  }
  tickmarkrDir(repoRoot); // the write path DOES create — beats land inside the gitignored state dir
  const p = supervisionBeatPath(repoRoot, tier);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ tier, ...(seat ? { seat } : {}), pid: process.pid, beatAt: new Date().toISOString() }) + "\n",
  );
}

/** Handle a watcher holds for as long as it is supervising; disarm stands it down and is idempotent. */
export interface ArmedSupervision {
  disarm: () => void;
}

// THE WATCHER-FACING ENTRY POINT — the loop SUPERVISION_BEAT_MS actually drives. A supervising seat
// calls this once at the top of its watch and holds the handle for the duration; a seat that dies,
// hangs or is SIGKILLed stops beating without having to notice, which is the whole point. lock.ts's
// heartbeat shape exactly: an immediate first write (ARMED from instant zero, not one interval later),
// an unref'd interval that never holds the watcher's event loop open, and a beat failure that is
// swallowed rather than crashing the watcher — an unwritten beat ages out and reads STALE, which is
// the truth. The FIRST beat is swallowed on the same rule: a cosmetic instrument that could not write
// must not take the run down with it. NOT called from `status`: status is a reader (its purity fence
// is a test); the in-repo callsite is runDaemon, which arms the orchestrator tier for the life of
// the run. A tier nobody arms reads ABSENT — exactly what ABSENT means, not a false "healthy".
//
// Arming CLEARS any prior stand-down record: a tier that stood down and armed again is armed, and a
// marker left behind by the last run would otherwise report the live one as stood down forever.
export function armSupervision(
  repoRoot: string,
  tier: SupervisionTier,
  beatMs: number = SUPERVISION_BEAT_MS,
  seat?: string,
): ArmedSupervision {
  // The clearing gets its OWN try: a cleanup that cannot complete (a directory dropped at the marker
  // path, a permission) must not cost the first beat. Sharing one try did exactly that — the tier armed
  // with NO beat while the old marker stayed on disk, the one combination that reports a live watcher
  // as stood down. Recursive because the path is ours: whatever occupies it is not our marker.
  try { rmSync(supervisionStandDownPath(repoRoot, tier), { force: true, recursive: true }); }
  catch { /* uncleared: the reader validates the marker and a newer beat outranks it — never masked */ }
  try { beatSupervision(repoRoot, tier, seat); }
  catch { /* repo gone / disk full / no seat — the tier reads ABSENT rather than crashing its watcher */ }
  const timer = setInterval(() => {
    try { beatSupervision(repoRoot, tier, seat); } catch { /* repo gone / disk full — let the beat expire */ }
  }, beatMs);
  timer.unref();
  let stoodDown = false;
  return {
    // Stand down: stop beating AND say so. Idempotent because the daemon disarms from more than one
    // exit path (its signal reaper exits the process before the finally can run), and the recorded
    // instant belongs to the first stand-down.
    disarm: () => {
      if (stoodDown) return;
      stoodDown = true;
      clearInterval(timer);
      // Published ATOMICALLY — written aside, renamed over — so no reader can ever meet a half-written
      // marker. A torn marker is rejected anyway (see readStandDown), but a stand-down that reads as
      // garbage is a stand-down that reports as a death, and the rename costs one line.
      const p = supervisionStandDownPath(repoRoot, tier);
      const tmp = `${p}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(tmp, JSON.stringify({
          tier, ...(seat ? { seat } : {}), pid: process.pid, disarmedAt: new Date().toISOString(),
        }) + "\n");
        renameSync(tmp, p);
      } catch { /* unrecordable stand-down ages out as STALE — pessimistic, which is the safe way to fail */ }
    },
  };
}

// BEAT DERIVATION — pure, and the only thing that reads the beat. One statSync: never creates,
// touches or reaps the record it reports on, and never creates the directory that holds it. ONLY a
// missing path is ABSENT: ENOENT (no beat file) and ENOTDIR (nothing that could hold one) mean no
// record was ever written. Every other stat failure is a record we could not read, and a stat-able
// inode that is not a regular file is not a beat — both are UNREADABLE, never silently ABSENT and
// never silently ARMED. Callers wanting the TIER's state want supervisionStatus below; this answers
// the narrower question "does the beat say alive", which is all a beat can ever say.
export function readTierLiveness(repoRoot: string, tier: SupervisionTier, now = Date.now()): TierLiveness {
  return beatLiveness(tier, readBeat(repoRoot, tier), now);
}

/** What a beat record yields: when it was written, and the seat it names when it names one. */
type BeatRecord = { mtimeMs: number; seat?: string } | "ABSENT" | "UNREADABLE";

// The beat's inode, or why there is no age to derive from it. Split out so the stand-down ranking below
// reads the SAME mtime this derivation does rather than a second, later stat of a moving record.
function readBeat(repoRoot: string, tier: SupervisionTier): BeatRecord {
  const p = supervisionBeatPath(repoRoot, tier);
  let st: Stats;
  try {
    st = statSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // never armed — reachable without anything having been written
    return code === "ENOENT" || code === "ENOTDIR" ? "ABSENT" : "UNREADABLE";
  }
  if (!st.isFile()) return "UNREADABLE"; // a directory at the beat path is not a heartbeat
  // SUP-05: the payload is read for ONE field — the seat — and never for the age, which stays the
  // mtime. On the legacy tiers an unparseable payload is still a beat (a record that cannot be parsed
  // is not evidence that nobody armed the tier). On a SEAT tier it is the opposite: a record naming no
  // seat leaves the tier armed and unattributable, which reads as coverage no seat is providing, so
  // it is UNREADABLE — something is there and no beat any reader can attribute comes out of it.
  const seat = beatSeat(p);
  if (isSeatTier(tier) && seat === undefined) return "UNREADABLE";
  return { mtimeMs: st.mtimeMs, ...(seat !== undefined ? { seat } : {}) };
}

/** The seat a record declares, or undefined for any record that declares none this reader can use. */
function beatSeat(path: string): string | undefined {
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as { seat?: unknown };
    return typeof rec?.seat === "string" && rec.seat.trim() ? rec.seat : undefined;
  } catch { return undefined; } // unparseable bytes name no seat — the caller decides what that means
}

function beatLiveness(tier: SupervisionTier, beat: BeatRecord, now: number): TierLiveness {
  if (typeof beat !== "object") return { tier, state: beat };
  const { mtimeMs, seat } = beat;
  const named = seat !== undefined ? { seat } : {};
  const age = now - mtimeMs;
  // SUP-03: a beat dated AHEAD of the reader's clock past the grace above is not a fresh beat — it is
  // a record whose age cannot be derived. Clamping it to zero (what this line used to do) made any
  // future stamp read ARMED forever, so filesystem skew or one bad utimes froze a DEAD watcher as
  // alive: fail-OPEN in the instrument built to catch exactly that, in the one direction it may not
  // fail. UNREADABLE says what is true — something is there and its age is not knowable — and, unlike
  // ARMED, it never claims a watcher is alive.
  if (age < -SUPERVISION_FUTURE_GRACE_MS) return { tier, state: "UNREADABLE" };
  const beatAgeMs = Math.max(0, age); // inside the grace: the two clocks' resolutions, not skew
  return { tier, state: beatAgeMs > SUPERVISION_STALE_MS ? "STALE" : "ARMED", beatAgeMs, ...named };
}

// A stand-down is only what a watcher RECORDED, so the record has to READ as one: a regular file whose
// payload names this tier and the instant it stood down. Path existence is not proof — a directory, a
// torn write or a stray file at that path says nothing about any watcher, and calling one of those a
// clean hand-off would hide a death behind whatever happened to be lying there. Pure: one stat, one
// read, and neither creates the record or the directory holding it.
function readStandDown(
  repoRoot: string,
  tier: SupervisionTier,
): { mtimeMs: number; seat?: string } | "NONE" | "UNREADABLE" {
  const p = supervisionStandDownPath(repoRoot, tier);
  let st: Stats;
  try {
    st = statSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "NONE" : "UNREADABLE";
  }
  if (!st.isFile()) return "UNREADABLE";
  let seat: string | undefined;
  try {
    const rec = JSON.parse(readFileSync(p, "utf8")) as { tier?: unknown; disarmedAt?: unknown; seat?: unknown };
    if (rec?.tier !== tier) return "UNREADABLE";
    if (typeof rec.disarmedAt !== "string" || Number.isNaN(Date.parse(rec.disarmedAt))) return "UNREADABLE";
    seat = typeof rec.seat === "string" && rec.seat.trim() ? rec.seat : undefined;
    // A seat tier's hand-off names WHICH seat left, on the same rule as its beat: an anonymous
    // stand-down on a per-seat tier says a watcher left without saying whose, so it is no record.
    if (isSeatTier(tier) && seat === undefined) return "UNREADABLE";
  } catch { return "UNREADABLE"; } // unparseable or unreadable bytes — not a stand-down anyone can read
  return { mtimeMs: st.mtimeMs, ...(seat !== undefined ? { seat } : {}) };
}

// THE TIER'S STATE — what every surface and every operator reads. A valid stand-down outranks the beat:
// the watcher that wrote it is gone ON PURPOSE, and its last beat ages out exactly like a dead one's
// would. It outranks the beat it FOLLOWED and no other — a beat stamped after the marker was written by
// a watcher that armed again, so a marker some failed cleanup left behind can never mask a live tier.
export function supervisionStatus(repoRoot: string, tier: SupervisionTier, now = Date.now()): TierLiveness {
  const beat = readBeat(repoRoot, tier);
  const standDown = readStandDown(repoRoot, tier);
  if (standDown === "UNREADABLE") return { tier, state: "UNREADABLE" };
  if (standDown !== "NONE" && !(typeof beat === "object" && beat.mtimeMs > standDown.mtimeMs)) {
    // the seat that stood down is named by the marker, falling back to whatever its last beat named
    const seat = standDown.seat ?? (typeof beat === "object" ? beat.seat : undefined);
    return { tier, state: "DISARMED", ...(seat !== undefined ? { seat } : {}) };
  }
  return beatLiveness(tier, beat, now);
}

/** Every KNOWN tier, always — a tier omitted from this list would read as one that is fine. */
export const readSupervision = (repoRoot: string, now = Date.now()): TierLiveness[] =>
  SUPERVISION_TIERS.map((tier) => supervisionStatus(repoRoot, tier, now));

/** One line, one word per tier. Shared by both status surfaces so neither can render a state twice. */
// The seat is rendered BESIDE the state, never instead of it: `overseer-context ARMED (w3:p2)` says
// both that something is beating and who is behind it, which is the pair an operator needs to act. A
// row with no seat to name renders exactly as it always did.
export const supervisionText = (tiers: readonly TierLiveness[], divider = " · "): string =>
  `supervision: ${tiers.map((t) => `${t.tier} ${t.state}${t.seat ? ` (${t.seat})` : ""}`).join(divider)}`;
