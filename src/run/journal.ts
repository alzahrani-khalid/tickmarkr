import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { channelKey, TokenUsageSchema, type Assignment } from "../adapters/types.js";
import type { TickmarkrConfig } from "../config/config.js";
import { stateDirName, tickmarkrDir } from "../graph/graph.js";
import { GATE_NAMES, TIERS, type GateName, type TaskStatus } from "../graph/schema.js";
import { buildProfile, classify, type ProfileDiscount, type RoutingProfile } from "../route/profile.js";
import { redactSecrets } from "./redact.js";

export interface JournalEvent {
  ts: string;
  event: string;
  taskId?: string;
  data: Record<string, unknown>;
}

export type TaskPhase = "worker" | "gates" | `gate:${GateName}` | "judge" | "review" | "merge";

export function phaseForGate(gate: GateName): TaskPhase {
  if (gate === "acceptance") return "judge";
  if (gate === "review") return "review";
  return `gate:${gate}`;
}

export function formatJournalNarration({ event, taskId, data }: JournalEvent): string {
  const assignment = data.assignment as Record<string, unknown> | undefined;
  const direct = [data.summary, data.reason, data.error, data.step, data.action, data.lint, data.branch, data.from]
    .find((value) => typeof value === "string" || typeof value === "number");
  const detail = Array.isArray(data.done)
    ? `done ${data.done.length}, failed ${Array.isArray(data.failed) ? data.failed.length : 0}`
    : typeof data.gate === "string"
      ? event === "tip-verify-failed"
        ? `${data.gate} failed${typeof data.lastMergedTask === "string" ? ` after ${data.lastMergedTask}` : ""}`
        : event === "tip-verify"
          ? `${data.gate} passed`
          : `${data.gate}${data.pass === true ? " passed" : data.pass === false ? " failed" : ""}`
      : typeof data.code === "number" ? `exit ${data.code}`
        : typeof data.pid === "number" ? `pid ${data.pid}`
          : typeof data.baseRef === "string" ? `base ${data.baseRef.slice(0, 12)}`
            : direct === undefined
              ? typeof assignment?.adapter === "string" && typeof assignment.model === "string" ? `${assignment.adapter}:${assignment.model}` : undefined
              : String(direct);
  return [event, taskId, detail?.replace(/\s+/g, " ").slice(0, 120)].filter(Boolean).join(" — ");
}

// Phase 46 (RES-01/RES-02): per-task resume state derived from EXISTING journal events. A companion to
// the status replay (which is byte-untouched) — consumed by the daemon under resume:true (Phase 47) to
// re-seed execTask's loop-local attempt/tried/assignment state that otherwise dies with the process.
export interface ResumeState {
  attempts: number;
  tried: string[];
  lastAssignment?: Assignment;
}

// v1.71 OBS-119: run-wide channel exclusions derived from journal events — companion to
// replayResumeState(), consumed by the daemon on resume to re-seed demotedChannels.
export const CHANNEL_EXCLUSION_KINDS = ["dead-channel"] as const;
export type ChannelExclusionKind = (typeof CHANNEL_EXCLUSION_KINDS)[number];

// v1.24 OBS-18: explicit data on task-approved when the operator releases an attempt-cap park.
// Approve stamps this; replayResumeState zeros the attempt counter (fresh budget) while keeping
// tried (consult bans / burned channels). Absent on pre-v1.24 events ⇒ inert (corpus outcome-identical).
export const ATTEMPT_CAP_RELEASE = "attempt-cap" as const;
// OBS-130: task-approved carries the exact failed gate the operator satisfied. The release tag keeps
// ordinary humanGate and attempt-cap approvals byte-compatible while making this authority explicit.
export const GATE_SATISFIED_RELEASE = "gate-satisfied" as const;

// Fail-closed shape for a dispatched assignment (journal.ts:75-90 posture): a malformed assignment in
// one dispatch degrades that single task toward today's behavior — counts toward attempts, contributes
// nothing to tried, poisons only lastAssignment — never crashes resume, never poisons other tasks.
const DispatchAssignmentSchema = z.object({
  adapter: z.string(),
  model: z.string(),
  channel: z.enum(["sub", "api"]),
  tier: z.enum(TIERS),
});

export const PARK_KINDS = ["human-gate", "ladder-exhausted", "attempt-cap", "gate-fail", "quota",
  "reroute-exhausted", "setup", "stall", "merge-conflict", "tip-moved", "infra", "dispatch"] as const;
export type ParkKind = (typeof PARK_KINDS)[number];
export const RETRY_MODES = ["resume", "fresh"] as const;
export type RetryMode = (typeof RETRY_MODES)[number];

export const WORKER_RESULT_CAUSES = ["provider-death", "stall-timeout", "malformed-trailer", "clean-exit-no-trailer"] as const;
export type WorkerResultCause = (typeof WORKER_RESULT_CAUSES)[number];

// Status consumes the routing profile's existing quality split directly: verified park kinds classify
// to 0, while availability/recovery noise classifies to null. Keep the synthetic row here at the
// run↔route seam so presentation code never grows a second list of "bad" park kinds.
export function isQualityFailureParkKind(kind: ParkKind): boolean {
  return classify({
    shape: "", adapter: "-", model: "-", channel: "-", attempts: 0,
    outcome: "human", durationMs: 0, parkKind: kind,
  }) === 0;
}

// The newest terminal event owns the cause. Unknown/malformed kinds fail toward undefined so a
// task-failed row keeps the legacy red treatment instead of being mistaken for recoverable noise.
export function recordedTaskFailureKind(events: JournalEvent[], taskId: string): ParkKind | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.taskId !== taskId || (e.event !== "task-human" && e.event !== "task-failed")) continue;
    return typeof e.data.kind === "string" && (PARK_KINDS as readonly string[]).includes(e.data.kind)
      ? e.data.kind as ParkKind
      : undefined;
  }
  return undefined;
}

// Runs can end and later resume in the same journal. The newest lifecycle marker decides whether
// an unresolved task is still recoverable by this live daemon or belongs to an ended run.
export function runHasEnded(events: JournalEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!.event;
    if (event === "run-end" || event === "superseded") return true;
    if (event === "run-start" || event === "run-resume") return false;
  }
  return false;
}

// OBS-53: provider-outage signatures in dead worker output ("Unable to reach the model provider" and kin).
const PROVIDER_OUTAGE_RE = /Unable to reach the model provider|cannot reach the model provider|model provider.*(?:unavailable|unreachable)/i;

/** OBS-53: classify worker-result failures so retries and routing see the true signal, not one lumped bucket. */
export function classifyWorkerResultCause(opts: {
  output: string;
  ok: boolean;
  finished: boolean;
  exitCode: number | null;
  summary: string;
  timedOut: boolean;
}): WorkerResultCause | undefined {
  if (opts.ok && opts.finished) return undefined;
  if (PROVIDER_OUTAGE_RE.test(opts.output)) return "provider-death";
  if (opts.summary === "unparseable TICKMARKR_RESULT trailer") return "malformed-trailer";
  if (!opts.finished && opts.timedOut) return "stall-timeout";
  if (!opts.finished && opts.exitCode !== null) return "clean-exit-no-trailer";
  if (!opts.finished) return "stall-timeout";
  return undefined;
}

export const TelemetryRowSchema = z.object({
  // v1.5 core — required; every old row has all eight (daemon.ts writes all eight)
  taskId: z.string(), shape: z.string(), adapter: z.string(), model: z.string(), channel: z.string(),
  attempts: z.number(), outcome: z.enum(["done", "failed", "human"]), durationMs: z.number(),
  // v1.6 additive (TEL-01/02) — OPTIONAL: a v1.5 row parses with these === undefined ("unobserved"),
  // never false/0. Phase 12 readers must branch on === true / === false; `?? false` is the poisoning bug.
  firstAttemptOk: z.boolean().optional(),
  gateFails: z.number().optional(),
  consults: z.number().optional(),
  parkKind: z.enum(PARK_KINDS).optional(),
  // v1.7 additive (SPEND-02) — OPTIONAL: absent = unmetered, never 0. .catch(undefined): a MALFORMED
  // tokens sub-object degrades to unmetered instead of safeParse-dropping the whole row — a metering
  // bug must never remove a row from profile derivation (that would let metering perturb routing).
  tokens: TokenUsageSchema.optional().catch(undefined),
  // v1.7 (SPEND-02): count of attempts that produced a usage record. Present IFF tokens is present.
  // meteredAttempts < attempts ⇒ tokens is a FLOOR (partially metered task) — Phase 18 must label it,
  // never print it as a total. Absent ⇒ the row is unmetered entirely.
  meteredAttempts: z.number().int().positive().optional().catch(undefined),
  // v1.8 additive (TEL-05) — OPTIONAL, z.literal(true) so `false` is UNREPRESENTABLE: absent = "no
  // mid-task quota failover observed" (never false), present = attributed to the channel throttled
  // away FROM. Phase 26 ROUTE-12 (utilization axis) consumes this; only the if(next) branch writes it.
  quotaFailover: z.literal(true).optional(),
  // v1.13 additive (ROUTE-18) — OPTIONAL, z.literal(true) so `false` is UNREPRESENTABLE: absent = "no
  // overrun observed" (never false), present = the channel burned a window without emitting a trailer
  // (worker-result ok:false, finished:false — no-trailer timeout OR trailer-less crash-exit). Written
  // only at the daemon's !finished site (after the quota check, quota-disjoint); 48-01's ProfileRow
  // (src/route/profile.ts) consumes the field-name contract `overrun`. Mirrors quotaFailover exactly.
  overrun: z.literal(true).optional(),
  // v1.29 additive: mode of the attempt represented by this row. Absent on old telemetry.
  retryMode: z.enum(RETRY_MODES).optional(),
  // v1.46 additive (T5): gate-signal quality for routing hygiene — OPTIONAL, absent = legacy (0.25 at fold).
  signalQuality: z.union([z.literal(0), z.literal(0.25), z.literal(0.5), z.literal(0.75), z.literal(1)]).optional(),
  signalBasis: z.enum(["proved", "review-agree", "judge-only", "legacy", "vacuous", "skipped"]).optional(),
});
export type TelemetryRow = z.infer<typeof TelemetryRowSchema>;

// v1.46 T5 (Sol signal telemetry): gate-result rows carry explicit signalQuality so future defect windows
// are identifiable without forensics. Basis is the provenance claim; quality is the dyadic h-fold weight.
export const SIGNAL_BASIS = ["proved", "review-agree", "judge-only", "legacy", "vacuous", "skipped"] as const;
export type SignalBasis = (typeof SIGNAL_BASIS)[number];

export const SIGNAL_QUALITY: Record<SignalBasis, 0 | 0.25 | 0.5 | 0.75 | 1> = {
  proved: 1,
  "review-agree": 0.75,
  "judge-only": 0.5,
  legacy: 0.25,
  vacuous: 0,
  skipped: 0,
};

export function signalQualityFromBasis(basis: SignalBasis): 0 | 0.25 | 0.5 | 0.75 | 1 {
  return SIGNAL_QUALITY[basis];
}

export function deriveSignalBasis(
  gate: string, pass: boolean, details: string, meta: Record<string, unknown> = {},
): SignalBasis {
  if (meta.skipped === true) return "skipped";
  if (meta.unparseable === true) return "vacuous";
  if (gate === "acceptance") return "judge-only";
  if (gate === "review") return pass ? "review-agree" : "vacuous";
  if (gate === "test" || gate === "build") {
    if (!pass) return "vacuous";
    if (/no test files|0 tests|tests\s+0\s/i.test(details)) return "vacuous";
    return "proved";
  }
  return pass ? "proved" : "vacuous";
}

// The canonical gate-result journal payload — daemon should spread this into append("gate-result", …).
export function gateResultJournalData(
  gate: string, pass: boolean, details: string, meta: Record<string, unknown> = {},
): { gate: string; pass: boolean; details: string; signalBasis: SignalBasis; signalQuality: number } & Record<string, unknown> {
  const signalBasis = deriveSignalBasis(gate, pass, details, meta);
  return { gate, pass, details, ...meta, signalBasis, signalQuality: signalQualityFromBasis(signalBasis) };
}

// T3 (Sol #2 / Fable F2): one canonical engagement identity, shared by status AND resume. The run-start
// event records graphDefinitionHash (over compiled task definitions only — see graph.graphDefinitionHash);
// this is the single field both consumers read, and the single comparator below is the single place the
// journal↔graph join is decided. unbound (no recorded definition hash, e.g. a pre-v1.44 journal) and
// mismatch are both not-comparable — status renders the notice either way; resume refuses either way and
// distinguishes the reason only for its message and the --graph-changed release event.
export function recordedGraphDefinitionHash(events: JournalEvent[]): string | undefined {
  for (const e of events) {
    if (e.event === "run-start" && typeof e.data.graphDefinitionHash === "string") return e.data.graphDefinitionHash;
  }
  return undefined;
}

export type EngagementCompare =
  | { comparable: true; recorded: string }
  | { comparable: false; reason: "mismatch"; recorded: string }
  | { comparable: false; reason: "unbound" };

// THE shared comparator (criterion: status and resume decide through one comparator). status reads
// .comparable; resume reads .comparable plus .reason/.recorded for its refusal message and the release.
export function engagementComparable(events: JournalEvent[], loadedHash: string): EngagementCompare {
  const recorded = recordedGraphDefinitionHash(events);
  if (recorded === undefined) return { comparable: false, reason: "unbound" };
  return recorded === loadedHash ? { comparable: true, recorded } : { comparable: false, reason: "mismatch", recorded };
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `run-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// Sol #4: one strict parser for every journal open/create path — generated run-… ids plus test
// suffix chars only; forbid path separators, dot-segments, and empty ids.
export function parseRunId(runId: string): string {
  const id = runId.trim();
  if (!id) throw new Error("invalid run id: empty");
  if (id.includes("/") || id.includes("\\")) throw new Error(`invalid run id: ${runId}`);
  for (const seg of id.split(/[/\\]/)) {
    if (seg === "." || seg === "..") throw new Error(`invalid run id: ${runId}`);
  }
  if (!/^run-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`invalid run id: ${runId}`);
  return id;
}

const runsDir = (repoRoot: string) => join(repoRoot, stateDirName(repoRoot), "runs");

// One JSONL reader for every append-only log: skip blanks, drop any line that
// won't parse, keeping everything before it intact.
function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn trailing write after a crash — ignore; everything before it is intact
    }
  }
  return out;
}

// Cross-run telemetry for Phase-12 profile derivation: the last K runs' rows, each
// tagged with its runId (runIds are zero-padded run-YYYYMMDD-HHMMSS ⇒ plain .sort() is
// chronological, same as latestRunId). Rows are facts, not classifications — Phase 12
// owns the quality-denominator/reward policy. A safeParse failure drops that one row
// (same posture as a torn line); a garbage row must never crash profile derivation.
// Note: a per-task row attributes to the FINAL channel — a channel escalated away from
// mid-task contributes no row; accepted for v1.6.
export function readAllTelemetry(repoRoot: string, lastK: number, opts: { after?: string } = {}): (TelemetryRow & { runId: string })[] {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return [];
  let runIds = readdirSync(dir).filter((d) => d.startsWith("run-")).sort();
  // VIS-03 reset cursor: runIds are zero-padded run-YYYYMMDD-HHMMSS ⇒ string > is chronological
  if (opts.after) runIds = runIds.filter((id) => id > opts.after!);
  runIds = runIds.slice(-lastK);
  const out: (TelemetryRow & { runId: string })[] = [];
  for (const runId of runIds) {
    for (const raw of readJsonl(join(dir, runId, "telemetry.jsonl"))) {
      const r = TelemetryRowSchema.safeParse(raw);
      if (r.success) out.push({ ...r.data, runId });
    }
  }
  return out;
}

// ponytail: fixed 50-run window; promote to a routing.learned.* config knob only if operators need to tune it.
export const RUNS_WINDOW = 50;

// VIS-03 reset cursor — one trimmed runId line at .tickmarkr/profile-since; absent/empty ⇒ undefined.
// Opaque: used ONLY in the runId > comparison above, never a shell or path join beyond .tickmarkr/.
export function readProfileCursor(repoRoot: string): string | undefined {
  const path = join(repoRoot, stateDirName(repoRoot), "profile-since");
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

// v1.46 T5 evidence hygiene state — one line per mark: `<runId> [<taskId>] <weight> # <reason>`.
// Follows the profile-since precedent: state file in .tickmarkr/, never config, never git.
const PROFILE_DISCOUNTS_RE =
  /^(run-[A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+(\S+))?\s+(0|0\.5)\s+#\s+(.+)$/;

export function profileDiscountsPath(repoRoot: string): string {
  return join(repoRoot, stateDirName(repoRoot), "profile-discounts");
}

export function readProfileDiscounts(repoRoot: string): ProfileDiscount[] {
  const path = profileDiscountsPath(repoRoot);
  if (!existsSync(path)) return [];
  const out: ProfileDiscount[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = PROFILE_DISCOUNTS_RE.exec(trimmed);
    if (!m) continue;
    out.push({
      runId: m[1],
      ...(m[2] ? { taskId: m[2] } : {}),
      weight: m[3] === "0" ? 0 : 0.5,
      reason: m[4].trim(),
    });
  }
  return out;
}

export function appendProfileDiscount(repoRoot: string, discount: ProfileDiscount): void {
  tickmarkrDir(repoRoot);
  const line = `${discount.runId}${discount.taskId ? ` ${discount.taskId}` : ""} ${discount.weight} # ${discount.reason}\n`;
  appendFileSync(profileDiscountsPath(repoRoot), line);
}

// The one shared profile builder (criterion 4: plan and daemon share ONE code path).
// preview:true bypasses the routing.learned:off short-circuit so `tickmarkr plan` can render the
// trust-ramp preview while the daemon (no preview) stays inert (VALIDATION 13-01-11).
export function loadRoutingProfile(repoRoot: string, cfg: TickmarkrConfig, opts: { preview?: boolean } = {}): RoutingProfile | undefined {
  if (cfg.routing.learned === "off" && !opts.preview) return undefined; // never built, never passed
  const rows = readAllTelemetry(repoRoot, RUNS_WINDOW, { after: readProfileCursor(repoRoot) });
  // ROUTE-15: halfLifeRuns threads from config as a pure param; undefined ⇒ module default (byte-identical).
  const discounts = readProfileDiscounts(repoRoot);
  return rows.length ? buildProfile(rows, { halfLifeRuns: cfg.routing.learnedTuning?.halfLifeRuns, discounts }) : undefined; // cold ⇒ undefined ⇒ v1.5 dead-code path
}

export class Journal {
  private constructor(
    public readonly dir: string,
    public readonly runId: string,
    private readonly narrate?: (event: JournalEvent) => void,
  ) {}

  static create(repoRoot: string, runId: string, narrate?: (event: JournalEvent) => void): Journal {
    const id = parseRunId(runId);
    const dir = join(runsDir(repoRoot), id);
    if (existsSync(join(dir, "journal.jsonl"))) throw new Error(`journal already exists for ${id}`);
    mkdirSync(dir, { recursive: true });
    return new Journal(dir, id, narrate);
  }

  static open(repoRoot: string, runId: string, narrate?: (event: JournalEvent) => void): Journal {
    const id = parseRunId(runId);
    const dir = join(runsDir(repoRoot), id);
    if (!existsSync(join(dir, "journal.jsonl"))) throw new Error(`no journal for ${id} at ${dir}`);
    return new Journal(dir, id, narrate);
  }

  // withJournal: journal.jsonl appears at first append, after Journal.create mkdirs — a caller that
  // will Journal.open the result (status, report) must fall back to the newest run that is actually
  // readable, not throw on the mkdir-to-first-append window. Raw default stays for telemetry-scoped
  // callers (profile cursor), where a journal-less run dir still counts.
  static latestRunId(repoRoot: string, opts: { withJournal?: boolean } = {}): string | null {
    if (!existsSync(runsDir(repoRoot))) return null;
    const ids = readdirSync(runsDir(repoRoot))
      .filter((d) => d.startsWith("run-") && (!opts.withJournal || existsSync(join(runsDir(repoRoot), d, "journal.jsonl"))))
      .sort();
    return ids.at(-1) ?? null;
  }

  private get journalPath() {
    return join(this.dir, "journal.jsonl");
  }

  append(event: string, taskId?: string, data: Record<string, unknown> = {}): void {
    const row: JournalEvent = { ts: new Date().toISOString(), event, ...(taskId ? { taskId } : {}), data };
    // T3 secret redaction: only the persisted bytes are masked — the caller's data stays untouched in
    // memory. The narrator receives the persisted (masked) row so a pane sink never shows a credential.
    const line = redactSecrets(JSON.stringify(row));
    appendFileSync(this.journalPath, line + "\n");
    try {
      this.narrate?.(JSON.parse(line) as JournalEvent);
    } catch {
      // narration is observational; a broken sink must not affect the journal or run
    }
  }

  phaseStart(taskId: string, phase: TaskPhase, data: Record<string, unknown> = {}): void {
    this.append("phase-start", taskId, { ...data, phase });
  }

  read(): JournalEvent[] {
    return readJsonl(this.journalPath) as JournalEvent[];
  }

  replayStatuses(): Map<string, TaskStatus> {
    const s = new Map<string, TaskStatus>();
    for (const e of this.read()) {
      if (!e.taskId) continue;
      if (e.event === "task-dispatch") s.set(e.taskId, "running");
      else if (e.event === "task-done") s.set(e.taskId, "done");
      else if (e.event === "task-failed") s.set(e.taskId, "failed");
      else if (e.event === "task-human") s.set(e.taskId, "human");
      // GATE-08 (v1.12): approval is a journal EVENT, never a graph.json mutation (graph.json is compiled
      // output; recompile re-emits humanGate:true and would silently erase it — Phase 42 D-02). Events
      // replay in order, so task-human → task-approved lands on pending (last write wins). Additive-only:
      // 26 real journals with no such event replay byte-identically (D-04).
      else if (e.event === "task-approved") s.set(e.taskId, "pending");
    }
    for (const [id, st] of s) if (st === "running") s.set(id, "pending");
    return s;
  }

  // Phase 46 (RES-01/RES-02): companion replay — derives per-task resume state {attempts, tried,
  // lastAssignment} from EXISTING events only (task-dispatch + consult-verdict + optional v1.24
  // task-approved{release:attempt-cap}). Additive-only: no new required event, no schema change, the
  // status replay above is byte-untouched (corpus criterion 3 is git-diff-provable). Motivated by the
  // 2026-07-11 incident (run-20260711-185020, P43-03): `tickmarkr resume` re-dispatched at attempt 0 on
  // pi:zai/glm-5.2, the exact channel a frontier consult had just banned, because execTask's
  // attempt/tried/assignment state is loop-local and dies with the process while the journal held every fact needed.
  //
  // attempts is a COUNT of task-dispatch events, NEVER max(data.attempt)+1: existing journals'
  // post-resume dispatches restart at 0 (the bug corrupted its own evidence — incident journal L58
  // logged attempt 0 two ms after run-resume). Count === max+1 on clean journals and is truthful on
  // corrupted ones. tried is the ordered dedup of channelKey(assignment) across dispatches (≡ the
  // pre-kill tried list). lastAssignment is the last well-formed dispatched assignment.
  replayResumeState(): Map<string, ResumeState> {
    const m = new Map<string, ResumeState>();
    const pendingReroute = new Set<string>(); // reroute verdicts not yet cleared by a later dispatch
    for (const e of this.read()) {
      if (!e.taskId) continue;
      if (e.event === "task-dispatch") {
        // A subsequent dispatch clears the pending reroute — the reroute was acted on pre-kill.
        pendingReroute.delete(e.taskId);
        let st = m.get(e.taskId);
        if (!st) { st = { attempts: 0, tried: [] }; m.set(e.taskId, st); }
        st.attempts++; // COUNT, never max(data.attempt)+1 — see rationale above
        const parsed = DispatchAssignmentSchema.safeParse(e.data.assignment);
        if (parsed.success) {
          const key = channelKey(parsed.data);
          if (!st.tried.includes(key)) st.tried.push(key);
          st.lastAssignment = parsed.data;
        } else {
          // fail closed: malformed assignment still COUNTS (above) but adds nothing to tried and
          // poisons only lastAssignment (a malformed LAST dispatch must not be restored).
          st.lastAssignment = undefined;
        }
      } else if (e.event === "consult-verdict" && e.data.action === "reroute") {
        // A reroute bans the in-force channel; retry/decompose/human verdicts ban nothing (D-03).
        pendingReroute.add(e.taskId);
      } else if (e.event === "task-approved" && e.data.release === ATTEMPT_CAP_RELEASE) {
        // v1.24 OBS-18: operator released an attempt-cap park. Pre-v1.24 task-approved events have no
        // `release` key ⇒ this branch never fires (corpus criterion: identical statuses + resume state).
        // attempts reset to 0 so the daemon's attempt-cap check does not re-park in the same tick;
        // tried survives (consult bans and burned channels are not forgotten); lastAssignment is
        // cleared so the daemon's nextChannel-over-tried path skips burned channels on first dispatch
        // (restoring the last burned assignment would re-try it first — the failure the tried-list exists to prevent).
        const st = m.get(e.taskId);
        if (st) {
          st.attempts = 0;
          st.lastAssignment = undefined;
        }
      }
    }
    // Trailing-reroute edge (D-01 kill between verdict and dispatch): a reroute verdict with NO
    // subsequent dispatch means the last-dispatched channel is itself banned — add it to tried (if
    // absent) and clear lastAssignment so the daemon falls back to nextChannel over the exclusions.
    for (const taskId of pendingReroute) {
      const st = m.get(taskId);
      if (st?.lastAssignment) {
        const key = channelKey(st.lastAssignment);
        if (!st.tried.includes(key)) st.tried.push(key);
        st.lastAssignment = undefined;
      }
    }
    return m;
  }

  // OBS-130: gate satisfaction is authority, not an inferred daemon state. Only an explicit
  // task-approved event with the typed release marker and a known gate enters this fold. A daemon-made
  // gate-satisfied event, a prior pass/fail result, malformed data, or another task's approval is inert.
  replaySatisfiedGates(): Map<string, GateName> {
    const satisfied = new Map<string, GateName>();
    for (const e of this.read()) {
      if (e.event !== "task-approved" || !e.taskId || e.data.release !== GATE_SATISFIED_RELEASE) continue;
      if (typeof e.data.gate === "string" && (GATE_NAMES as readonly string[]).includes(e.data.gate)) {
        satisfied.set(e.taskId, e.data.gate as GateName);
      }
    }
    return satisfied;
  }

  // v1.71 OBS-119: run-wide exclusion fold — same replay discipline as replayResumeState().
  // channel-exclusion is the typed event; dead-channel-failover.from is the pre-v1.71 compat seam.
  replayExcludedChannels(): Set<string> {
    const excluded = new Set<string>();
    for (const e of this.read()) {
      if (e.event === "channel-exclusion" && typeof e.data.channel === "string") {
        excluded.add(e.data.channel);
      } else if (e.event === "dead-channel-failover" && typeof e.data.from === "string") {
        excluded.add(e.data.from);
      }
    }
    return excluded;
  }

  telemetry(row: TelemetryRow): void {
    // T3 secret redaction: same persistence seam as append — credential-free rows are byte-identical.
    appendFileSync(join(this.dir, "telemetry.jsonl"), redactSecrets(JSON.stringify(row)) + "\n");
  }

  // Per-run, raw (NOT schema-validated) — report.ts reads v1.5 core fields; stays byte-compatible.
  readTelemetry(): TelemetryRow[] {
    return readJsonl(join(this.dir, "telemetry.jsonl")) as TelemetryRow[];
  }
}
