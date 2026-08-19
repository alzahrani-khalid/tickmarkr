import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNER, GLYPHS, type Verdict, dim, fail, legend, ok, rule, statusRow, title, warn } from "../../brand.js";
import { DEFAULT_CONFIG, loadConfig, type TickmarkrConfig } from "../../config/config.js";
import { HerdrDriver } from "../../drivers/herdr.js";
import {
  formatOwnedName,
  parseOwnedName,
  type DecisionEvent,
  type DecisionWebhookPost,
} from "../../drivers/types.js";
import { blockedTasks, graphDefinitionHash, loadGraph, stateDirName } from "../../graph/graph.js";
import { GATE_NAMES, type GateName, type RunGraph, type Task, type TaskStatus } from "../../graph/schema.js";
import { foldActivity } from "../../run/activity.js";
import {
  Journal,
  type JournalEvent,
  engagementComparable,
  isQualityFailureParkKind,
  recordedTaskFailureKind,
  runHasEnded,
  type TaskPhase,
} from "../../run/journal.js";
import { normalizeGateOutcome, type GateOutcomeKind } from "../../run/outcome.js";
import { desiredPanes } from "../../run/reconcile.js";
import { normalizeStallSnapshot } from "../../run/stall.js";
import { readSupervision, supervisionText } from "../../run/supervision.js";
import {
  deriveRunCockpitData,
  type TaskRow,
} from "../../tui/cockpit/derive.js";
import { COCKPIT_COLUMN_FLOOR, LAYOUT_PRIORITY } from "../../tui/cockpit/layout.js";
import { cellWidth, fitCells, wrapCells } from "../../tui/cockpit/width.js";

// ponytail: fixed 2s refresh; promote to config.visibility.* only when an operator asks.
const REFRESH_MS = 2000;
// The claim leads, the guidance follows: an incomparable journal is named in three words a wrapped
// board keeps on one row, and the remedy trails it. Both surfaces state the claim; nothing derived
// from such a journal — task states, gate outcomes, tip verification — may be presented as this
// run's, so the verify claim beside it reads `unavailable` rather than the recorded verdict.
const NOT_COMPARABLE_CLAIM = "graph not comparable";
const NOT_COMPARABLE_NOTICE = `${NOT_COMPARABLE_CLAIM} — recompiled since this run; resume with \`--graph-changed\` to audit this recompile`;
const PRIOR_GRAPH_MARKER = "prior graph";

// One compact host-zone label per screen. Each event below is still converted from its own
// complete UTC instant, so the zone's historical rules — including a transition within one frame
// — stay intact rather than being rendered through this label's single sampled offset.
const localZoneLabel = (reference = new Date()): string => {
  const offset = -reference.getTimezoneOffset();
  if (offset === 0) return "UTC";
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = Math.abs(offset) % 60;
  return minutes === 0
    ? `${sign}${hours}`
    : `${sign}${hours}:${String(minutes).padStart(2, "0")}`;
};

const localClockText = (content: string, reference = new Date()): string => {
  return content.replace(/\b([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\b/gu, (_whole, h, m, s) => {
    const instant = new Date(Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
      Number(h),
      Number(m),
      Number(s),
    ));
    return [instant.getHours(), instant.getMinutes(), instant.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  });
};

/** The complete journal instant behind a folded clock phrase, not a screen-wide offset sample. */
const taskClockReference = (
  events: readonly JournalEvent[],
  taskId: string,
  content: string,
  fallback: Date,
): Date => {
  const utcClock = content.match(/\b(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\b/u)?.[0];
  if (utcClock === undefined) return fallback;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.taskId !== taskId || event.ts.slice(11, 19) !== utcClock) continue;
    const instant = new Date(event.ts);
    if (Number.isFinite(instant.getTime())) return instant;
  }
  return fallback;
};

// Every attempt number a cell phrase carries is the engagement's own ladder (foldActivity counts
// dispatch labels from 1). Name that ruler wherever a bare one appears, not only in the one phrase
// shipping today — a phrase added upstream must not reach the operator unruled.
const labelAttemptRuler = (text: string): string =>
  text.replace(/(?<!engagement |run )\battempt (?=\d)/gu, "engagement attempt ");

// The timer must keep the process ALIVE: an unref'd timer here let the event loop drain after the
// first frame, so a live `--watch` printed once and exited 0 (OBS-11). Never unref this.
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type StatusOpts = {
  iterations?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readWorkerOutput?: (taskId: string, attempt: number, runId: string) => Promise<string | undefined>;
  webhookUrl?: string;
  postWebhook?: DecisionWebhookPost;
};

export const GATE_KEYS = { build: "B", test: "T", lint: "L", evidence: "E", scope: "S", acceptance: "A", review: "R" } as const;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ASCII_SPINNER = ["|", "/", "-", "\\"] as const;
const SAVE_TERMINAL_TITLE = "\x1b[22;0t";
const RESTORE_TERMINAL_TITLE = "\x1b[23;0t";

const decisionEvidence = (stateDir: string, runId: string, sequence: number): string =>
  `${stateDir}/runs/${runId}/journal.jsonl#L${sequence}`;

// v1.79 T4: a deterministic JSONL projection over journal truth. Sequence/evidence come from the
// append-only line position, timestamps and claims come from the row, and no watcher-local clock or
// filesystem write participates. Re-reading the same bytes therefore returns the same event bytes.
export const decisionEventsFromJournal = (
  events: JournalEvent[],
  runId: string,
  stateDir = ".tickmarkr",
): DecisionEvent[] => events.flatMap<DecisionEvent>((event, index): DecisionEvent[] => {
  const sequence = index + 1;
  const base = {
    version: 1 as const,
    sequence,
    ts: event.ts,
    runId,
    evidence: decisionEvidence(stateDir, runId, sequence),
    ...(event.taskId ? { taskId: event.taskId } : {}),
  };
  if (event.event === "phase-start" && typeof event.data.phase === "string") {
    return [{ ...base, type: "phase-change" as const, tier: "routine" as const, phase: event.data.phase }];
  }
  if (event.event === "gate-result" && typeof event.data.gate === "string") {
    const verdict = event.data.skipped === true
      ? "skipped" as const
      : event.data.pass === true
        ? "passed" as const
        : event.data.pass === false
          ? "failed" as const
          : "unknown" as const;
    return [{
      ...base,
      type: "gate-verdict" as const,
      tier: verdict === "failed" ? "decision" as const : "routine" as const,
      gate: event.data.gate,
      verdict,
    }];
  }
  if (event.event === "escalation") {
    return [{
      ...base,
      type: "escalation" as const,
      tier: "decision" as const,
      ...(typeof event.data.step === "string" ? { step: event.data.step } : {}),
      ...(typeof event.data.attempt === "number" ? { attempt: event.data.attempt } : {}),
    }];
  }
  if (event.event === "task-human" && event.taskId) {
    return [{
      ...base,
      type: "human-decision-required" as const,
      tier: "decision" as const,
      approvalCommand: `tickmarkr approve ${runId} ${event.taskId}`,
      ...(typeof event.data.kind === "string" ? { kind: event.data.kind } : {}),
      ...(typeof event.data.reason === "string" ? { reason: event.data.reason } : {}),
    }];
  }
  if (event.event === "run-end") {
    return [{
      ...base,
      type: "run-end" as const,
      tier: "decision" as const,
      summary: event.data,
    }];
  }
  return [];
});

const optionValue = (argv: string[], name: string): string | undefined => {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || undefined;
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
};

// The one positional this command takes: an explicit run id. Everything else is a flag or a flag's
// value (`--webhook <url>`), so the first bare token that is not a --webhook value is the run id.
const positionalRunId = (argv: string[]): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--webhook") { i += 1; continue; }
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
};

const defaultPostWebhook: DecisionWebhookPost = (url, event) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }).then(() => undefined);

const postWebhookFireAndForget = (
  post: DecisionWebhookPost,
  url: string,
  event: DecisionEvent,
): void => {
  try {
    void Promise.resolve(post(url, event)).catch(() => undefined);
  } catch {
    // Webhooks are observational. A synchronous bridge failure is as inert as a rejected request.
  }
};

type LivePhase = {
  taskId: string;
  phase: TaskPhase;
  startedAt: number;
  order: number;
  attempt: number;
  /** The gate the row names, read from the event's own `gate` field — never from the phase word. */
  gate?: GateName;
  /**
   * When the DAEMON last proved this worker alive, and by what evidence (`worker-contact`). A
   * headless channel prints nothing to its pane for its whole run, so pane silence is not worker
   * silence — and the daemon's own proof was journaled with no reader (OBS-538).
   */
  lastContactAt?: number;
  contactEvidence?: string;
};

type WorkerLiveness = {
  phaseStartedAt: number;
  snapshot: string;
  hasOutput: boolean;
  lastOutputAt: number;
};

// `phase` is a coarse word — the daemon writes "judge" for the acceptance gate and, for a review
// round, whatever phaseForGate() maps that gate to. The gate a row must NAME is the event's own
// `gate` field; a value that is not one of the seven declared gates is not a gate name and is
// ignored rather than printed.
const recordedGate = (value: unknown): GateName | undefined =>
  typeof value === "string" && GATE_NAMES.includes(value as GateName) ? value as GateName : undefined;

const taskPhase = (value: unknown): TaskPhase | undefined => {
  if (value === "worker" || value === "gates" || value === "judge" || value === "review" || value === "merge") return value;
  if (typeof value !== "string" || !value.startsWith("gate:")) return undefined;
  return GATE_NAMES.includes(value.slice("gate:".length) as (typeof GATE_NAMES)[number]) ? value as TaskPhase : undefined;
};

const phaseGate = (phase: TaskPhase): string | undefined => {
  if (phase === "judge") return "acceptance";
  if (phase === "review") return "review";
  return phase.startsWith("gate:") ? phase.slice("gate:".length) : undefined;
};

// A phase is live only between its append-only start marker and the matching real outcome. A newer
// start for the same task supersedes the prior phase (gates → named gate, worker retry → worker).
// No clock participates in this fold: time only decorates the derived live interval at render time.
const livePhases = (events: JournalEvent[]): Map<string, LivePhase> => {
  const live = new Map<string, LivePhase>();
  for (let order = 0; order < events.length; order++) {
    const event = events[order]!;
    if (event.event === "run-start" || event.event === "run-resume" || event.event === "run-end" || event.event === "superseded") {
      live.clear();
      continue;
    }
    if (event.event === "phase-start" && event.taskId) {
      const phase = taskPhase(event.data.phase);
      const startedAt = Date.parse(event.ts);
      const attempt = typeof event.data.attempt === "number" && Number.isInteger(event.data.attempt) && event.data.attempt >= 0
        ? event.data.attempt
        : 0;
      const gate = recordedGate(event.data.gate);
      if (phase && Number.isFinite(startedAt)) {
        live.set(event.taskId, { taskId: event.taskId, phase, startedAt, order, attempt, ...(gate ? { gate } : {}) });
      }
      continue;
    }
    if (!event.taskId) continue;
    const active = live.get(event.taskId);
    if (!active) continue;
    // The daemon proves a silent worker alive by hashing its worktree and journals that proof as
    // `worker-contact`. It is evidence ABOUT the live phase, never its outcome, so it decorates the
    // entry and is deliberately absent from the `matched` set below.
    if (event.event === "worker-contact" && active.phase === "worker") {
      const at = Date.parse(event.ts);
      if (Number.isFinite(at)) {
        active.lastContactAt = at;
        if (typeof event.data.evidence === "string") active.contactEvidence = event.data.evidence;
      }
      continue;
    }
    const gate = active.gate ?? phaseGate(active.phase);
    const matched =
      (active.phase === "worker" && event.event === "worker-result")
      || (active.phase === "gates" && event.event === "gate-result")
      || (gate !== undefined && event.event === "gate-result" && event.data.gate === gate)
      || (active.phase === "merge" && event.event === "merge")
      || event.event === "task-done"
      || event.event === "task-failed"
      || event.event === "task-human"
      || event.event === "task-approved"
      || event.event === "task-dispatch";
    if (matched) live.delete(event.taskId);
  }
  return live;
};

// A gate the journal named is rendered by that name. Only a phase the journal left ungated falls
// back to the phase word — the word alone cannot tell an acceptance round from a review one, since
// the daemon records both under a phase of its own choosing (phaseForGate).
const phaseLabel = (phase: LivePhase | TaskPhase): string => {
  if (typeof phase !== "string") return phase.gate ? `gate ${phase.gate}` : phaseLabel(phase.phase);
  return phase.startsWith("gate:") ? `gate ${phase.slice("gate:".length)}` : phase;
};

const fmtElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m${seconds % 60}s`;
};

/**
 * The freshest evidence that this worker is alive, and what produced it. ONE derivation, because the
 * two readers of worker silence drifted apart the first time this was fixed: OBS-538 taught the detail
 * phrase to read the daemon's journaled `worker-contact` and left the stall ALARM (`staleWorker`)
 * clocking pane bytes alone. For the exact population OBS-538 is about — a headless channel (codex
 * `sub`, an API worker) that prints nothing to its pane all run, so `hasOutput` never becomes true —
 * the alarm then warn-painted every live row from 60s onward while line 2 of the same card read
 * "last contact 10s ago (worktree)". A card cannot contradict itself if both halves ask this.
 */
const workerActivity = (
  phase: LivePhase,
  worker?: WorkerLiveness,
): { at: number; source: "output" | "contact" | "none" } => {
  const outputAt = worker?.phaseStartedAt === phase.startedAt && worker.hasOutput ? worker.lastOutputAt : undefined;
  const contactAt = phase.lastContactAt;
  if (outputAt !== undefined && (contactAt === undefined || outputAt >= contactAt)) return { at: outputAt, source: "output" };
  if (contactAt !== undefined) return { at: contactAt, source: "contact" };
  // Nothing has been observed since the phase began: silence is the whole phase, which is what both
  // the phrase ("no output 14m51s") and the alarm's 60s threshold must measure.
  return { at: phase.startedAt, source: "none" };
};

/** How long this worker has been silent by the freshest evidence available — the alarm's clock. */
const workerSilenceMs = (phase: LivePhase, now: number, worker?: WorkerLiveness): number =>
  now - workerActivity(phase, worker).at;

/**
 * What a live worker row says about silence. Pane bytes are not more truthful than a worktree delta,
 * only different, so the row names whichever evidence is fresher AND names its source.
 */
const phaseDetail = (phase: LivePhase, now: number, worker?: WorkerLiveness): string => {
  const elapsed = fmtElapsed(now - phase.startedAt);
  if (phase.phase !== "worker") return `${phaseLabel(phase)} · ${elapsed} elapsed`;
  const head = `${phaseLabel(phase.phase)} · ${elapsed} elapsed`;
  const activity = workerActivity(phase, worker);
  const age = fmtElapsed(now - activity.at);
  if (activity.source === "output") return `${head} · last output ${age} ago`;
  if (activity.source === "contact") return `${head} · last contact ${age} ago (${phase.contactEvidence ?? "worktree"})`;
  return `${head} · no output ${age}`;
};

const attemptStartIdx = (events: JournalEvent[], taskId: string): number => {
  let idx = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.taskId === taskId && (e.event === "task-dispatch" || e.event === "escalation")) idx = i;
  }
  return idx;
};

const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

// non-TTY machine surface only — the TTY frame draws task verdicts via statusRow
export const taskBox = (status: TaskStatus): string => {
  if (status === "done") return "[x]";
  if (status === "failed" || status === "human") return "[!]";
  return "[ ]";
};

type SurfaceTaskState = TaskStatus | NonNullable<TaskRow["state"]>;

const graphTaskStatus = (state: SurfaceTaskState | undefined, fallback: TaskStatus): TaskStatus => {
  if (state === "completed" || state === "done") return "done";
  if (state === "interrupted") return "failed";
  return state ?? fallback;
};

const surfaceStatusWord = (state: SurfaceTaskState): string => {
  if (state === "human") return "parked";
  return state;
};

const surfaceTaskBox = (state: SurfaceTaskState, merged: boolean): string => {
  if (merged) return "[x]";
  if (state === "failed" || state === "human") return "[!]";
  return "[ ]";
};

export const gateBox = (state: "open" | "pass" | "fail" | "skip", unicode: boolean): string => {
  if (unicode) {
    // shared glyph vocabulary: pass/fail verdicts, dash for skip, dim circle for not-yet-run
    return state === "pass" ? GLYPHS.pass : state === "fail" ? GLYPHS.fail : state === "skip" ? GLYPHS.neutral : GLYPHS.toggleInactive;
  }
  return state === "pass" ? "[x]" : state === "fail" ? "[!]" : state === "skip" ? "." : "[ ]";
};

export type GateState = "open" | "pass" | "fail" | "skip";

export const defaultGateStates = (task: Task): GateState[] =>
  GATE_NAMES.map((gate) => task.gates.includes(gate) ? "open" : "skip");

type GateSnapshot = {
  states: GateState[];
  priorGraph: boolean;
};

const gateSnapshot = (task: Task, events: JournalEvent[], rehashAt?: number): GateSnapshot => {
  const outcomes = new Map<string, { state: "pass" | "fail" | "skip"; eventIndex: number }>();
  const start = attemptStartIdx(events, task.id);
  if (start >= 0) {
    for (let eventIndex = start; eventIndex < events.length; eventIndex++) {
      const e = events[eventIndex]!;
      if (e.taskId !== task.id || e.event !== "gate-result" || typeof e.data.gate !== "string") continue;
      if (e.data.skipped === true) outcomes.set(e.data.gate, { state: "skip", eventIndex });
      else if (e.data.pass === true) outcomes.set(e.data.gate, { state: "pass", eventIndex });
      else if (e.data.pass === false) outcomes.set(e.data.gate, { state: "fail", eventIndex });
    }
  }
  return {
    states: GATE_NAMES.map((gate) => task.gates.includes(gate) ? outcomes.get(gate)?.state ?? "open" : "skip"),
    priorGraph: rehashAt !== undefined && [...outcomes.values()].some((outcome) => outcome.eventIndex < rehashAt),
  };
};

export const gateStates = (task: Task, events: JournalEvent[]): GateState[] =>
  gateSnapshot(task, events).states;

// verdict semantics only: pass brand green, fail red, skip/open dim chrome — everything else stays quiet
const GATE_STATE_TOKEN: Record<GateState, (s: string) => string> = { pass: ok, fail, skip: dim, open: dim };

// TTY cells are bare glyphs in fixed GATE_NAMES order — gate identity lives once in the frame
// legend, and in words on a failing row; non-TTY keeps the letter+box chips (byte-pinned surface)
export const gateChain = (states: GateState[], unicode: boolean): string =>
  GATE_NAMES.map((gate, i) => unicode
    ? GATE_STATE_TOKEN[states[i]!](gateBox(states[i]!, true))
    : `${GATE_KEYS[gate]}${gateBox(states[i]!, false)}`).join(" ");

export const failedGates = (states: GateState[]): string[] => GATE_NAMES.filter((_, i) => states[i] === "fail");
// plain-text form of the failed-gate words for column math; rendered with a dim dot + red names
const failedSuffix = (states: GateState[]): string => {
  const f = failedGates(states);
  return f.length ? ` · ${f.join(", ")}` : "";
};

// a designed human gate parks the task BEFORE any gate result exists (daemon.ts execTask), so the
// awaited approval is named from task state alone — never from gate results. Failed gates win the
// cell when present: a post-approval park is not awaiting the designed gate. Plain text for column
// math; rendered with a dim dot + warn words. TTY-only — the non-TTY surface stays byte-pinned.
export const humanGateSuffix = (t: Task, st: TaskStatus, states: GateState[]): string =>
  st === "human" && t.humanGate && failedGates(states).length === 0 ? " · awaiting approval" : "";

// Task titles are graph-authored data. Remove terminal controls and row-breaking whitespace before
// either width measurement or rendering so zero-cell ECMA-48 bytes cannot escape the task column.
const ECMA_48_CONTROL =
  /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u009D[\s\S]*?(?:\u0007|\u009C)|\u001B[P^_X][\s\S]*?\u001B\\|[\u0090\u0098\u009E\u009F][\s\S]*?\u009C|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[@-_])/gu;

const sanitizeTaskText = (text: string): string =>
  text.replace(ECMA_48_CONTROL, "").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();

export const shortGoal = (goal: string, max: number): string => {
  const clause = sanitizeTaskText(goal).split(/[,;.?!]/, 1)[0]!.trim();
  const cells = Math.max(0, Math.floor(max));
  if (cellWidth(clause) <= cells) return clause;
  if (cells <= 3) return fitCells(clause, cells).trimEnd();
  return `${fitCells(clause, cells - 3).trimEnd()}...`;
};

/** Columns the machine row always spends on the task title, however long its machinery segment runs. */
const MACHINE_TITLE_FLOOR = 24;

/**
 * A card's detail segments, named in the cockpit's own element vocabulary so the board carries no
 * shed order of its own: `LAYOUT_PRIORITY` is ordered highest-priority first, so its tail is what a
 * narrowing board surrenders, and it surrenders it from the end. The journal segment — where BOTH
 * directions of the graph edge are named, the blocking dependencies of a waiting task and the
 * dependents waiting on it — sits above that tail and is therefore never shed: it wraps instead, so
 * narrowing costs rows, never the graph's structure, and never turns a named task into a `+N` count.
 */
type DetailSegment = { element: (typeof LAYOUT_PRIORITY)[number]; text: string };

const detailText = (segments: readonly DetailSegment[], budget: number): string => {
  const shedOrder = LAYOUT_PRIORITY.slice(LAYOUT_PRIORITY.indexOf("journal") + 1).reverse();
  const shed = new Set<string>();
  const compose = (): string => segments
    .filter((segment) => segment.text.length > 0 && !shed.has(segment.element))
    .map((segment) => segment.text)
    .join(" · ");
  for (const element of shedOrder) {
    if (cellWidth(compose()) <= budget) break;
    shed.add(element);
  }
  return compose();
};

/**
 * Every board line leaves through the cockpit's own wrap, measured in display cells: no drawn line
 * exceeds the board's columns, and nothing is shortened into a count to get there. Blank separators
 * stay blank — `wrapCells` always answers at least one row.
 */
const boardRows = (lines: readonly string[], columns: number): string[] =>
  lines.flatMap((line) => wrapCells(line, columns, { continuationPrefix: "  " }));

type TaskEffort = {
  taskId: string;
  dispatches: number;
  reviews: number;
  parks: number;
  total: number;
};

/**
 * A funded review round is a review that actually returned a verdict. `passed` and `failed` are the
 * only two arms of the gate vocabulary that carry one (outcome.ts:23) — every other arm states why
 * nothing ran, so counting it would bill the task for a reviewer it never spent.
 */
const REVIEW_VERDICTS = new Set<GateOutcomeKind>(["passed", "failed"]);

/**
 * Fold the panel from parsed JournalEvent rows only. In particular, a review round is every
 * gate-result whose typed gate field is `review` and whose outcome is a verdict, passed or failed.
 * `review-raw-*` artifacts are unparseable-verdict captures, not round markers, and neither raw
 * journal strings nor run-directory filenames participate in this count.
 *
 * A decline is not a round, and it is NOT readable off `data.skipped`: that field is one of four
 * encodings the shipped record already writes, and the two it misses are both live on disk — a
 * pre-R3 review decline states itself only as `{ pass: true, details: "skipped — …" }`, and a
 * canonical row states it as `outcome.kind: "declined"`. Reading the flag alone bills both as funded
 * rounds and can reorder the top four. `normalizeGateOutcome` is the ONE reader of all four
 * encodings (outcome.ts:125), so the panel asks it rather than re-deriving a fifth answer; a row it
 * cannot read stays `unavailable` and therefore uncounted, fail-closed. `replayMeasurement` is
 * orthogonal to the outcome — a resume re-observing an interrupted round reports a real verdict —
 * so it stays an explicit exclusion, the same clause journal.ts:110 uses.
 */
const foldTaskEffort = (tasks: readonly Task[], events: readonly JournalEvent[]): TaskEffort[] => {
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  const effort = new Map(tasks.map((task) => [task.id, {
    taskId: task.id,
    dispatches: 0,
    reviews: 0,
    parks: 0,
    total: 0,
  }]));

  for (const event of events) {
    if (!event.taskId) continue;
    const task = effort.get(event.taskId);
    if (!task) continue;
    if (event.event === "task-dispatch") task.dispatches += 1;
    else if (event.event === "gate-result" && event.data.gate === "review"
             && event.data.replayMeasurement !== true
             && REVIEW_VERDICTS.has(normalizeGateOutcome(event.data.outcome ?? event.data).kind)) task.reviews += 1;
    else if (event.event === "task-human") task.parks += 1;
    task.total = task.dispatches + task.reviews + task.parks;
  }

  return [...effort.values()].sort((left, right) =>
    right.total - left.total
    || order.get(left.taskId)! - order.get(right.taskId)!
  );
};

/**
 * Prototype panel, fitted by the cockpit's display-cell authority before board-wide wrapping.
 *
 * `undefined` events mean this run's journal describes a DIFFERENT graph, so it funds no claim here.
 * Folding it — or folding an empty array in its place — would state zero dispatches, reviews and
 * parks for a run that recorded all three, which is unavailable evidence dressed as an answer. Same
 * clause the verify claim uses (`verify unavailable`): no claim beats a false zero.
 */
const effortPanel = (
  tasks: readonly Task[],
  events: readonly JournalEvent[] | undefined,
  columns: number,
): string[] => {
  if (!events) {
    return [
      ` ${title("WHERE THE EFFORT WENT")}`,
      legend(`   dispatch · review · park counts unavailable — ${NOT_COMPARABLE_CLAIM}`),
    ];
  }
  const top = foldTaskEffort(tasks, events).slice(0, 4);
  const maxTotal = Math.max(1, ...top.map((task) => task.total));
  const idColumns = Math.max(2, Math.min(16, Math.max(...top.map((task) => cellWidth(task.taskId)))));
  const rows = top.map((task) => {
    const counts = `${task.dispatches} dispatch · ${task.reviews} review · ${task.parks} park`;
    const prefix = `    ${fitCells(task.taskId, idColumns)} `;
    const barColumns = Math.min(46, Math.max(3,
      columns - cellWidth(prefix) - 2 - cellWidth(counts),
    ));
    const dispatchEnd = Math.round((task.dispatches / maxTotal) * barColumns);
    const reviewEnd = Math.round(((task.dispatches + task.reviews) / maxTotal) * barColumns);
    const parkEnd = Math.round((task.total / maxTotal) * barColumns);
    const stack = ok("█".repeat(dispatchEnd))
      + warn("█".repeat(Math.max(0, reviewEnd - dispatchEnd)))
      + fail("█".repeat(Math.max(0, parkEnd - reviewEnd)));
    return `${prefix}${fitCells(stack, barColumns)}  ${counts}`;
  });

  return [
    ` ${title("WHERE THE EFFORT WENT")}`,
    legend(`   dispatches · review rounds · human parks · top ${top.length} of ${tasks.length} tasks`),
    "",
    ...rows,
    "",
    `   ${ok("█")} ${dim("dispatch")}  ${warn("█")} ${dim("review round")}  ${fail("█")} ${dim("human park")}`,
  ];
};

// VIS-11 (v1.13): a liveness header for renderFrame — last journal event age + whether the recorded
// daemon pid is still alive. Honest about unknowns: a pre-v1.13 journal with no pid renders "unknown",
// never fabricated (garbage pid data fails toward unknown too). kill(pid,0) is a signal probe, not a
// write — VIS-07 purity holds (status stays a pure reader; the snapshot-purity test is the fence).
// The lock.ts:52-53 idiom: ESRCH ⇒ dead, EPERM/success ⇒ alive.
const fmtAge = (ms: number): string => {
  if (ms < 90_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 5_400_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
};

// last valid recording wins: scan from the newest event for the most recent run-start/run-resume
// carrying a positive-integer pid. Anything else (absent, non-integer, ≤0) ⇒ undefined ⇒ unknown.
const daemonPid = (events: JournalEvent[]): number | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.event === "run-start" || e.event === "run-resume") && Number.isInteger(e.data.pid) && (e.data.pid as number) > 0) {
      return e.data.pid as number;
    }
  }
  return undefined;
};

const terminalFailureCause = (events: JournalEvent[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event !== "run-end" || typeof e.data.error !== "string") continue;
    const phase = typeof e.data.phase === "string" && e.data.phase.trim()
      ? `${e.data.phase.trim()} failed`
      : "run failed";
    return `${phase}: ${e.data.error.replace(/\s+/g, " ").trim()}`;
  }
  return undefined;
};

type TipVerifyPhase = {
  state: "failed" | "re-verifying" | "pending";
  gates: string[];
  fingerprints?: number;
  attempt?: number;
};

type TipFailureEvidence = Pick<TipVerifyPhase, "gates" | "fingerprints">;

const tipFailureEvidence = (events: JournalEvent[], start: number, end: number): TipFailureEvidence => {
  const gates = new Set<string>();
  let fingerprints = 0;
  let hasFingerprintCount = false;
  for (let i = start; i <= end; i++) {
    const event = events[i]!;
    if (event.event !== "tip-verify-failed") continue;
    if (typeof event.data.gate === "string" && event.data.gate.trim()) gates.add(event.data.gate.trim());
    if (Array.isArray(event.data.fingerprints)) {
      fingerprints += event.data.fingerprints.length;
      hasFingerprintCount = true;
    }
  }
  return { gates: [...gates], ...(hasFingerprintCount ? { fingerprints } : {}) };
};

const priorLifecycleIndex = (events: JournalEvent[], end: number): number => {
  for (let i = end; i >= 0; i--) {
    if (events[i]!.event === "run-start" || events[i]!.event === "run-resume") return i;
  }
  return 0;
};

// OBS-146: tip verification is a run phase, folded exclusively from append-only journal facts.
// A completed run-end owns passed/failed; a later resume keeps the prior failure visible while
// recording a re-verification attempt; an active run becomes pending only after a recorded merge
// and recorded non-empty command set make a tip verification applicable. Unknown evidence stays
// unknown rather than borrowing optimistic state from graph.json.
const tipVerifyPhase = (events: JournalEvent[]): TipVerifyPhase | undefined => {
  let lastRunEnd = -1;
  let lastLifecycle = -1;
  let attempts = 0;
  let hasCommands = false;
  let hasMerge = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.event === "run-start" || event.event === "run-resume") {
      lastLifecycle = i;
      attempts++;
      if (event.event === "run-start" && typeof event.data.commands === "object" && event.data.commands !== null
        && !Array.isArray(event.data.commands) && Object.keys(event.data.commands).length > 0) {
        hasCommands = true;
      }
    } else if (event.event === "run-end") {
      lastRunEnd = i;
    } else if (event.event === "merge") {
      hasMerge = true;
    }
  }

  if (lastRunEnd >= 0 && events[lastRunEnd]!.data.tipVerify === "failed") {
    const failureStart = priorLifecycleIndex(events, lastRunEnd);
    const priorFailure = tipFailureEvidence(events, failureStart, lastRunEnd);
    if (lastLifecycle > lastRunEnd) {
      const currentFailure = tipFailureEvidence(events, lastLifecycle, events.length - 1);
      if (currentFailure.gates.length > 0 || currentFailure.fingerprints !== undefined) {
        return { state: "failed", ...currentFailure };
      }
      return { state: "re-verifying", ...priorFailure, attempt: Math.max(2, attempts) };
    }
    return { state: "failed", ...priorFailure };
  }

  if (lastLifecycle > lastRunEnd) {
    const currentFailure = tipFailureEvidence(events, lastLifecycle, events.length - 1);
    if (currentFailure.gates.length > 0 || currentFailure.fingerprints !== undefined) {
      return { state: "failed", ...currentFailure };
    }
    if (hasCommands && hasMerge) return { state: "pending", gates: [] };
  }
  return undefined;
};

const tipVerifyText = (phase: TipVerifyPhase): string => {
  if (phase.state === "pending") return "verify pending";
  const gates = phase.gates.length ? phase.gates.join(", ") : "gate unknown";
  const failed = `verify FAILED (${gates})`;
  const reverify = phase.state === "re-verifying" ? ` → re-verifying (run attempt ${phase.attempt})` : "";
  const fingerprints = phase.fingerprints === undefined
    ? ""
    : ` · ${phase.fingerprints} fingerprint${phase.fingerprints === 1 ? "" : "s"}`;
  return `${failed}${reverify}${fingerprints}`;
};

// The only tip-verification verdicts a run-end can RECORD. Anything else in that field — absent, a
// value carrying a newline or terminal controls, a word from some other vocabulary — records no
// verdict, and the surfaces say so instead of echoing it or counting `tip-verify` events to guess
// (an operator-local reimplementation counted them and scored two failed runs as verified).
const RECORDED_VERIFY = new Set(["passed", "failed"]);

type VerifyWord = "passed" | "failed" | "unrecorded" | "unavailable";

const recordedVerify = (events: JournalEvent[]): VerifyWord => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.event !== "run-end") continue;
    const recorded = event.data.tipVerify;
    return typeof recorded === "string" && RECORDED_VERIFY.has(recorded)
      ? recorded as VerifyWord
      : "unrecorded";
  }
  return "unrecorded"; // no run-end: this run's record names no verdict yet
};

/**
 * What the board may CLAIM about tip verification, in one place for both surfaces.
 *
 * An incomparable journal yields no claim about this graph at all, so it reads `unavailable` rather
 * than the recorded verdict. A live phase (failed, re-verifying, pending) keeps its own richer
 * phrase. Otherwise the run-end field is READ: `passed` is stated positively — silence used to be
 * the only sign of a passed tip, which reads identically to a surface that simply hides it — and a
 * record that ends without naming a verdict is `unrecorded`. A run still in flight claims nothing.
 */
const verifyClaim = (
  events: JournalEvent[],
  comparable: boolean,
  tipPhase: TipVerifyPhase | undefined,
): string | undefined => {
  if (!comparable) return "verify unavailable";
  if (tipPhase) return tipVerifyText(tipPhase);
  if (!runHasEnded(events)) return undefined;
  return `verify ${recordedVerify(events)}`;
};

/**
 * Where an operator can still look, per task — folded from the daemon's OWN pane authority
 * (`desiredPanes`, the reconcile fold that decides which owned panes should exist right now) and
 * the visibility setting that governs when a worker pane closes. A locator built from dispatch
 * history alone survives the events that retire a pane — `task-done` closes a merged task's worker
 * pane, `run-end` retires every pane of the run — and sends the operator to a pane that is gone.
 *
 * Under `keepPanes: "attempt"` the daemon closes a worker pane as soon as it harvests that attempt,
 * before the gates run and before `worker-result` is journaled (daemon.ts), so a harvested attempt
 * has no pane left however desirable the fold finds it.
 */
const workerPaneLocators = (
  events: JournalEvent[],
  runId: string,
  keepPanes: TickmarkrConfig["visibility"]["keepPanes"],
): Map<string, string> => {
  const locators = new Map<string, string>();
  for (const name of desiredPanes(events, runId)) {
    const owned = parseOwnedName(name);
    if (owned?.role === "worker") locators.set(owned.taskId, name);
  }
  if (keepPanes !== "attempt") return locators;
  const harvested = new Set<string>();
  for (const event of events) {
    if (!event.taskId) continue;
    if (event.event === "task-dispatch") harvested.delete(event.taskId);
    else if (event.event === "worker-result") harvested.add(event.taskId);
  }
  for (const taskId of harvested) locators.delete(taskId);
  return locators;
};

// status is a reader of the repo it reports on: the same resolved config every other command loads.
// A config that will not load is not a reason to fail a frame — the shipped default keeps the fold.
const keepPanesSetting = (cwd: string): TickmarkrConfig["visibility"]["keepPanes"] => {
  try {
    return loadConfig(cwd).visibility.keepPanes;
  } catch {
    return DEFAULT_CONFIG.visibility.keepPanes;
  }
};

const liveness = (events: JournalEvent[], now = Date.now()): string => {
  const last = events.at(-1);
  if (!last) return "last event unknown · daemon pid unknown";
  const age = fmtAge(now - Date.parse(last.ts));
  const pid = daemonPid(events);
  const cause = terminalFailureCause(events);
  if (pid === undefined) return `last event ${age} ago · daemon pid unknown${cause ? ` · ${cause}` : ""}`;
  // a dead pid after run-end is a clean exit, not a crash — "dead" is only alarming (red) while
  // the run is still incomplete (operator's crash indicator)
  const ended = events.some((e) => e.event === "run-end");
  let state: string;
  try { process.kill(pid, 0); state = "alive"; } // no throw ⇒ alive
  catch (k) { state = (k as NodeJS.ErrnoException).code === "ESRCH" ? (ended ? "finished" : "dead") : "alive"; } // EPERM ⇒ alive
  return `last event ${age} ago · daemon pid ${pid} ${state}${cause ? ` · ${cause}` : ""}`;
};

type RenderedFrame = {
  content: string;
  hotPhase?: LivePhase;
  runId?: string;
  workerPhases: LivePhase[];
};

type StatusEngagement = {
  comparable: boolean;
  rehashAt?: number;
};

// Resume's shared comparator remains the fail-closed baseline. Status may additionally accept the
// daemon's audited graph-rehash release, but only when its `from` names that baseline identity (or
// null for an explicitly released legacy journal) and its `to` names the graph loaded now.
const statusEngagement = (events: JournalEvent[], loadedHash: string): StatusEngagement => {
  const baseline = engagementComparable(events, loadedHash);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.event !== "graph-rehash") continue;
    const auditsBaseline = baseline.comparable || baseline.reason === "mismatch"
      ? event.data.from === baseline.recorded
      : event.data.from === null;
    return event.data.to === loadedHash && auditsBaseline
      ? { comparable: true, rehashAt: i }
      : { comparable: false };
  }
  return { comparable: baseline.comparable };
};

// The journal's own reader rule (src/run/journal.ts readJsonl), applied to bytes already in hand:
// skip blanks, drop a line that will not parse (a torn trailing write after a crash), keep the rest.
const parseJournalSnapshot = (raw: string): JournalEvent[] =>
  raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as JournalEvent];
    } catch {
      return [];
    }
  });

type RunRecord = {
  runId: string;
  raw: string;
  events: JournalEvent[];
  comparable: boolean;
  rehashAt?: number;
};

/**
 * ONE journal read per answer, and every claim about the run folded from THOSE bytes — the board's
 * task rows, activity, phases, gates, liveness and tip verification, and the compact one-line form
 * alike. A second read is what lets two snapshots be presented as one state: a line the daemon
 * appends between them pairs a task count from one instant with a verdict from another.
 *
 * An explicit <runId> is a resolution, not a hint: `Journal.open` refuses an id without a readable
 * journal, so status fails loudly naming that id instead of rendering any other run.
 */
const readRunRecord = (cwd: string, graph: RunGraph, namedRunId?: string): RunRecord | undefined => {
  const runId = namedRunId ?? Journal.latestRunId(cwd, { withJournal: true });
  if (!runId) return undefined;
  const raw = readFileSync(join(Journal.open(cwd, runId).dir, "journal.jsonl"), "utf8");
  const events = parseJournalSnapshot(raw);
  // The resume comparator is the fail-closed baseline; a matching graph-rehash is the daemon's
  // append-only audit that authorizes this status replay after stop-amend-resume.
  const engagement = statusEngagement(events, graphDefinitionHash(graph));
  return {
    runId,
    raw,
    events,
    comparable: engagement.comparable,
    ...(engagement.rehashAt === undefined ? {} : { rehashAt: engagement.rehashAt }),
  };
};

/**
 * The cockpit fold over those same bytes — the journal-backed task authority both forms read.
 *
 * The daemon creates journal.jsonl with lock-reclaimed before run-start, and a reader may also
 * catch an empty or torn first write. Those snapshots own no task fold yet; once run-start exists,
 * however, a fold failure is unexpected and must surface instead of becoming a false empty run.
 */
const recordTaskRows = (record: RunRecord, graph: RunGraph): Map<string, TaskRow> =>
  record.comparable && record.events.some((event) => event.event === "run-start")
    ? new Map(deriveRunCockpitData(
      { fileName: `${record.runId}.journal.jsonl`, raw: record.raw },
      "status",
      { graph },
    ).taskRows.map((row) => [row.taskId, row]))
    : new Map();

/** The graph tasks this run's record actually speaks about — a row with no recorded fact is silence. */
const recordedTasks = (graph: RunGraph, rows: Map<string, TaskRow>): Task[] =>
  graph.tasks.filter((task) => {
    const row = rows.get(task.id);
    return row !== undefined && (
      row.state !== undefined
      || row.lastEventTime !== undefined
      || row.attempts !== undefined
      || row.actor !== undefined
      || row.merged === true
      || row.parkKind !== undefined
    );
  });

const recordedDone = (tasks: readonly Task[], rows: Map<string, TaskRow>): number =>
  tasks.filter((task) => graphTaskStatus(rows.get(task.id)?.state, task.status) === "done").length;

const renderFrame = (
  cwd: string,
  now = Date.now(),
  animationFrame = 0,
  workerLiveness = new Map<string, WorkerLiveness>(),
  journalRowsOnly = false,
  namedRunId?: string,
): RenderedFrame => {
  const g = loadGraph(cwd);
  const record = readRunRecord(cwd, g, namedRunId);
  const runId = record?.runId;
  const events = record?.events ?? [];
  const comparable = record?.comparable ?? false;
  const rehashAt = record?.rehashAt;
  const assignments = new Map<string, string>();
  let replayed: Map<string, TaskStatus> | null = null;
  const contexts = new Map<string, number>();
  // v1.53 T5: this run is dead — a newer run replaced it
  const supersededBy = [...events].reverse()
    .find((e) => e.event === "superseded" && typeof e.data.by === "string")?.data.by as string | undefined;
  if (record && comparable) {
    if (!journalRowsOnly) replayed = Journal.open(cwd, record.runId).replayStatuses();
    for (const e of events) {
      if (!journalRowsOnly && e.event === "task-dispatch" && e.taskId) {
        const a = e.data.assignment as { adapter?: string; model?: string };
        if (typeof a.adapter === "string" && typeof a.model === "string") {
          assignments.set(e.taskId, `${a.adapter}:${a.model}`);
        }
      }
      if (e.event === "context-sample" && e.taskId && typeof e.data.tokens === "number" && Number.isFinite(e.data.tokens)) {
        contexts.set(e.taskId, e.data.tokens as number); // last write wins
      }
    }
  }
  const taskRows = record && journalRowsOnly ? recordTaskRows(record, g) : new Map<string, TaskRow>();
  const clockFallback = new Date(now);
  const recordedClock = new Date(events.at(-1)?.ts ?? now);
  const zoneReference = Number.isFinite(recordedClock.getTime()) ? recordedClock : clockFallback;
  const effective: RunGraph = {
    ...g,
    tasks: g.tasks.map((task) => ({
      ...task,
      status: comparable
        ? journalRowsOnly
          ? graphTaskStatus(taskRows.get(task.id)?.state, task.status)
          : replayed?.get(task.id) ?? task.status
        : task.status,
    })),
  };
  const renderedTasks = journalRowsOnly ? recordedTasks(g, taskRows) : g.tasks;
  const starved = new Set(blockedTasks(effective).map((t) => t.id));
  // OBS-104: ONE activity fold feeds both surfaces — never re-derived here. Comparable events only
  // (a recompiled graph's journal must not animate the wrong tasks); with no or stale journal the
  // dep-waiting cells still derive from the effective graph statuses.
  const activity = foldActivity(comparable ? events : [], effective.tasks);
  // RULING-v189-scope §14c: a card answers BOTH supervisor questions. `foldActivity` names what a
  // task waits FOR; this names what waits ON it. Read from `effective.tasks` — whose statuses are
  // the journal's replay, never the compiled graph's — so a dependent the record says is done stops
  // being named, and a task all of whose dependents are done acquires no entry at all.
  const dependents = new Map<string, string[]>();
  for (const task of effective.tasks) {
    if (task.status === "done") continue;
    for (const dep of task.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
  }
  const unicode = visual();
  const divider = unicode ? " · " : " / ";
  // SUP-01: derived by stat() alone, from THIS frame's clock. status stays a reader — nothing here
  // creates, touches or reaps a beat file, so an absent supervision dir stays absent.
  const supervision = readSupervision(cwd, now);
  const width = process.stdout.columns ?? 120;
  const done = journalRowsOnly
    ? recordedDone(renderedTasks, taskRows)
    : effective.tasks.filter((task) => task.status === "done").length;
  const total = g.tasks.length;
  const ended = comparable && runHasEnded(events);
  const tipPhase = comparable ? tipVerifyPhase(events) : undefined;
  const verify = runId ? verifyClaim(events, comparable, tipPhase) : undefined;
  // Where an operator can still look: only panes this run's record leaves open (see workerPaneLocators).
  const panes = runId && comparable
    ? workerPaneLocators(events, runId, keepPanesSetting(cwd))
    : new Map<string, string>();
  const taskIds = new Set(g.tasks.map((task) => task.id));
  const phases = comparable ? livePhases(events) : new Map<string, LivePhase>();
  for (const taskId of phases.keys()) if (!taskIds.has(taskId)) phases.delete(taskId);
  const hotPhase = [...phases.values()].sort((a, b) => a.order - b.order).at(-1);

  const cells = renderedTasks.map((t) => {
    const folded = journalRowsOnly && comparable ? taskRows.get(t.id) : undefined;
    const st: SurfaceTaskState = folded?.state ?? replayed?.get(t.id) ?? t.status;
    const merged = journalRowsOnly ? folded?.merged === true : st === "done" || st === "completed";
    const failureKind = comparable ? recordedTaskFailureKind(events, t.id) : undefined;
    const terminal = st === "failed" || st === "human";
    // Unknown legacy task-failed events stay red. Typed availability noise is warn-tier only while
    // the run is live; verified quality parks and every unresolved task in an ended run are red.
    const redTier = terminal && (
      ended
      || (failureKind !== undefined && isQualityFailureParkKind(failureKind))
      || (st === "failed" && failureKind === undefined)
    );
    const livePhase = phases.get(t.id);
    const isStarved = !livePhase && starved.has(t.id);
    const rawPhrase = livePhase ? phaseDetail(livePhase, now, workerLiveness.get(t.id)) : isStarved ? undefined : activity.cells.get(t.id);
    const phrase = rawPhrase === undefined
      ? undefined
      : journalRowsOnly
        ? labelAttemptRuler(localClockText(
          rawPhrase,
          taskClockReference(events, t.id, rawPhrase, clockFallback),
        ))
        : rawPhrase;
    const label = isStarved ? " starved" : phrase ? ` ${phrase}` : "";
    const channel = journalRowsOnly ? folded?.actor ?? "-" : assignments.get(t.id) ?? "-";
    const ctx = contexts.get(t.id);
    const assignCol = ctx !== undefined ? `${channel}${divider}ctx ${ctx}` : channel;
    const gates = comparable
      ? gateSnapshot(t, events, rehashAt)
      : { states: defaultGateStates(t), priorGraph: false };
    const pane = panes.get(t.id);
    return { t, st, merged, failureKind, redTier, label, assignCol, isStarved, phrase, channel, ctx, livePhase, pane, ...gates };
  });

  if (!unicode) {
    // machine/CI surface — journals without phase-start stay byte-identical; new phase-aware frames
    // use an ASCII spinner so pipes never receive terminal-only braille/ANSI.
    const rows = cells.map(({ t, st, merged, label, assignCol, livePhase, states, priorGraph, pane }) => {
      const chain = gateChain(states, false);
      const prefix = livePhase ? `  ${ASCII_SPINNER[animationFrame % ASCII_SPINNER.length]} ${t.id} ` : `  ${surfaceTaskBox(st, merged)} ${t.id} `;
      const suffix = `  ${chain}${priorGraph ? ` ${PRIOR_GRAPH_MARKER}` : ""}  ${livePhase ? "running" : surfaceStatusWord(st)}${label}  ${assignCol}${pane ? `  pane ${pane}` : ""}`;
      // The machine row carries the cockpit's own law (see LAYOUT_PRIORITY and the two-line card):
      // identity is never what a crowded row sheds. `dep-waiting on …` grows with fan-in and alone
      // can exceed the terminal width, and the pre-floor math paid for it out of the TITLE — 20 of
      // 41 rows in a live 41-task run named no task at all. These rows already overflow `width`
      // (a pane name is 60 columns on its own), so the floor costs wrapping, never the graph.
      return `${prefix}${shortGoal(t.title, Math.max(MACHINE_TITLE_FLOOR, width - prefix.length - suffix.length))}${suffix}`;
    });
    const zone = journalRowsOnly ? `${divider}zone ${localZoneLabel(zoneReference)}` : "";
    const header = runId
      ? `tickmarkr status${divider}run ${runId}${zone}${supersededBy ? `${divider}superseded by ${supersededBy}` : ""}${!comparable ? `${divider}${NOT_COMPARABLE_NOTICE}` : ""}${divider}${liveness(events, now).replaceAll(" · ", divider)}${verify ? `${divider}${verify}` : ""}${divider}${tipPhase ? `${done}/${total} tasks done${divider}run not verified` : `${done}/${total} done`}`
      : `tickmarkr status${zone}${divider}no runs yet${divider}${done}/${total} done`;
    const legendLine = `  gates: ${GATE_NAMES.map((gate) => `${GATE_KEYS[gate]} ${gate}`).join(divider)}`;
    return {
      content: [header, legendLine, `  ${supervisionText(supervision, divider)}`, ...rows].join("\n"),
      ...(hotPhase ? { hotPhase } : {}),
      ...(runId ? { runId } : {}),
      workerPhases: [...phases.values()].filter((phase) => phase.phase === "worker"),
    };
  }

  // TTY: cockpit frame composed through src/brand.ts (CLI-DESIGN.md) — dominant run title,
  // dim chrome, semantic color only on verdicts, completion gauge, and column-aligned status
  // rows (pad plain text FIRST, colorize after: ANSI has zero display width and would corrupt
  // padEnd math)
  // The cockpit owns this board's column contract: `COCKPIT_COLUMN_FLOOR` is the narrowest board it
  // plans, so below it the terminal — not a second floor stated here — decides what happens to the
  // drawn rows. Every column figure below is derived from this one.
  const boardColumns = Math.max(COCKPIT_COLUMN_FLOOR, width);
  const dot = dim(" · ");
  const anyFailed = cells.some((c) => c.redTier);
  const gaugeCells = 10;
  const fill = total ? Math.round((done / total) * gaugeCells) : 0;
  const tipFailed = tipPhase?.state === "failed";
  const progressTone = anyFailed || tipFailed ? fail : tipPhase ? warn : ok;
  const gauge = (fill ? progressTone("█".repeat(fill)) : "") + (fill < gaugeCells ? dim("░".repeat(gaugeCells - fill)) : "");
  const live = liveness(events, now)
    .replace(/\bdead\b/, fail("dead"))
    .replace(/\bfinished\b/, dim("finished"))
    .replace(/\balive\b/, ok("alive"))
    .replaceAll(" · ", dot);
  const tally = tipPhase
    ? `${progressTone(`${done}/${total} tasks done`)}${dot}${progressTone("run not verified")}`
    : `${done}/${total} done`;
  // The prototype's header order, ported: identity, then what the run is worth (verdict and
  // tally), then the instruments that decorate it. A board that must wrap keeps the decisive
  // segments on the row an operator reads first; nothing is dropped to get there.
  const header = ` ${[
    title(runId ? `run ${runId}` : "tickmarkr"),
    ...(runId ? [] : ["no runs yet"]),
    ...(runId && supersededBy ? [warn(`superseded by ${supersededBy}`)] : []),
    ...(runId && !comparable ? [warn(NOT_COMPARABLE_NOTICE)] : []),
    ...(verify === undefined
      ? []
      : [verify === "verify passed" ? ok(verify) : tipFailed ? fail(verify) : warn(verify)]),
    `${gauge} ${tipPhase ? tally : done === total && total > 0 ? ok(tally) : tally}`,
    ...(runId ? [live] : []),
    ...(journalRowsOnly ? [`zone ${localZoneLabel(zoneReference)}`] : []),
  ].join(dot)}`;
  const hr = rule(Math.min(boardColumns, 100));
  // OBS-104 run-level now line: names the most recent journal event. TTY frame only — the non-TTY
  // machine surface is byte-pinned (status-brand golden) and must not drift. Rendered BELOW the task
  // rows: the line names task ids, and rows must stay the first id-bearing lines for grep consumers.
  const nowLine = activity.now ? [legend(`   now: ${activity.now}`)] : [];
  const gatesLegend = legend(`   gates: ${GATE_NAMES.join(" · ")}`);
  // Every known tier, beaten or not: a tier missing from this line would read as a healthy one.
  const supervisionLegend = legend(`   ${supervisionText(supervision)}`);

  // Two-line card per task (operator request, v1.67): line 1 carries identity + verdict — glyph,
  // id, title at full width, and only SHORT status words. Line 2 carries the machinery, dim and
  // aligned under the title: gate chain, live activity phrase (or channel), ctx. Long channel names
  // and activity phrases live on line 2 only, so they can never squeeze the title or wrap line 1.
  const taskVerdict = (c: (typeof cells)[number]): Verdict =>
    c.merged ? "pass" : c.redTier ? "fail" : c.st === "failed" || c.st === "human" ? "warn" : "neutral";
  const statusWord = (c: (typeof cells)[number]): string =>
    c.livePhase ? "running" : c.redTier ? "failed" : c.st === "failed" ? "warn" : surfaceStatusWord(c.st);
  // Every column figure is display cells through the cockpit's width authority — never String
  // length, which over-charges a wide cluster and bills a combining mark that draws nothing.
  const idW = Math.max(...cells.map((c) => cellWidth(c.t.id)), 2);
  // plain-text status suffixes for width math only — starved / failed gate names / approval hint
  const suffixPlain = (c: (typeof cells)[number]): string =>
    (c.isStarved ? " · starved" : "") + failedSuffix(c.states)
    + humanGateSuffix(c.t, graphTaskStatus(c.st, c.t.status), c.states);
  const stW = Math.max(...cells.map((c) => cellWidth(statusWord(c) + suffixPlain(c))));
  const avail = Math.max(8, boardColumns - (5 + idW) - 2 - stW);
  const titles = cells.map((c) => shortGoal(c.t.title, avail));
  const titleW = Math.max(8, ...titles.map(cellWidth));
  // Line 2 starts under the title column — but never past what the board can pay for: an id near
  // the schema's 64-character maximum would otherwise indent the machinery clean off a narrow row.
  const chainCells = cellWidth(gateChain(GATE_NAMES.map(() => "open"), true));
  const indent = " ".repeat(
    Math.max(0, Math.min(idW + 5, boardColumns - chainCells - 2)),
  );
  const rows = cells.map((c, i) => {
    const { t, st, merged, failureKind, redTier, states, priorGraph, isStarved, phrase, channel, ctx, livePhase, pane } = c;
    const word = statusWord(c);
    // The alarm reads the SAME evidence the detail phrase names — a worktree delta the daemon proved
    // counts, or the card would flag a worker it just called alive one line below (OBS-538 review).
    const staleWorker = livePhase?.phase === "worker"
      && workerSilenceMs(livePhase, now, workerLiveness.get(t.id)) >= 60_000;
    const stWord = staleWorker ? warn(word) : merged ? ok(word) : redTier ? fail(word) : st === "failed" || st === "human" ? warn(word) : word;
    // a fail names its gate in words right here — the one moment gate identity is needed on a row
    const f = failedGates(states);
    const human = humanGateSuffix(t, graphTaskStatus(st, t.status), states);
    const statusCell = stWord +
      (isStarved ? dot + fail("starved") : "") +
      (f.length ? dot + fail(f.join(", ")) : "") +
      (human ? dot + warn("awaiting approval") : "");
    const taskTitle = titles[i]!;
    const taskLabel = `${t.id.padEnd(idW)} ${taskTitle}${" ".repeat(titleW - cellWidth(taskTitle))}  ${statusCell}`;
    const line1 = livePhase
      ? `  ${(staleWorker ? warn : dim)(SPINNER[animationFrame % SPINNER.length]!)} ${taskLabel}`
      : `  ${statusRow(taskVerdict(c), taskLabel)}`;
    // activity already names its channel for in-flight attempts — never repeat it
    const chain = gateChain(states, true);
    // A finished task blocks nobody — the same journal-folded done-ness the map was built on.
    const blocking = graphTaskStatus(st, t.status) === "done" ? [] : dependents.get(t.id) ?? [];
    const segments: DetailSegment[] = [
      ...(priorGraph ? [{ element: "progressCaption" as const, text: PRIOR_GRAPH_MARKER }] : []),
      ...(phrase
        ? [
          { element: "journal" as const, text: phrase },
          ...(phrase.includes(channel) || channel === "-"
            ? []
            : [{ element: "secondaryHeader" as const, text: channel }]),
        ]
        : [{ element: "secondaryHeader" as const, text: channel }]),
      // The waiting phrase's reverse direction, and structure for the same reason: a supervisor
      // deciding what to unblock needs the names, so it wraps beside the blockers rather than being
      // shed or folded into a count. A finished task blocks nobody.
      ...(blocking.length ? [{ element: "journal" as const, text: `blocks ${blocking.join(", ")}` }] : []),
      ...(failureKind && !phrase?.includes(failureKind)
        ? [{ element: "progressCaption" as const, text: failureKind }]
        : []),
      // A pane an operator can still open is structure, not decoration: it wraps like the blockers
      // above it rather than being shed, because half an address is no address.
      ...(pane ? [{ element: "journal" as const, text: `pane ${pane}` }] : []),
      ...(ctx !== undefined ? [{ element: "statTiles" as const, text: `ctx ${ctx}` }] : []),
    ];
    const detail = detailText(segments, boardColumns - cellWidth(indent) - cellWidth(chain) - 2);
    // A board narrow enough to surrender every detail segment ends the row at the gate chain: the
    // separator is part of the segment it separates, never chrome left standing on its own.
    const line2 = detail ? `${indent}${chain}  ${dim(detail)}` : `${indent}${chain}`;
    return [line1, line2, ""];
  }).flat();
  if (!nowLine.length) rows.pop(); // cards end blank-separated; drop the dangling one
  const effort = effortPanel(g.tasks, record && !comparable ? undefined : events, boardColumns);
  return {
    content: boardRows(
      [header, hr, gatesLegend, supervisionLegend, "", ...rows, ...nowLine, "", hr, "", ...effort],
      boardColumns,
    ).join("\n"),
    ...(hotPhase ? { hotPhase } : {}),
    ...(runId ? { runId } : {}),
    workerPhases: [...phases.values()].filter((phase) => phase.phase === "worker"),
  };
};

/**
 * The compact form a statusline calls, so journal interpretation happens ONCE, inside the product.
 * (An operator-local bash reimplementation counted `tip-verify` events instead of reading the
 * run-end field and scored two runs whose tip verification had FAILED as verified.)
 *
 * One line, one journal read, and every word from the run's own record: the tally and the verdict
 * are folded from the same bytes, so a completion appended between two reads can never be paired
 * with a verdict the other read never saw. Plain text through the task-text sanitizer — a statusline
 * embeds this, so no recorded value may carry a control byte or a row break into its host.
 */
const oneLine = (cwd: string, namedRunId?: string): string => {
  const graph = loadGraph(cwd);
  const record = readRunRecord(cwd, graph, namedRunId);
  if (!record) return sanitizeTaskText(`tickmarkr · no runs yet · 0/${graph.tasks.length} done`);
  const rows = recordTaskRows(record, graph);
  const claims = record.comparable
    ? [
      `${recordedDone(recordedTasks(graph, rows), rows)}/${graph.tasks.length} done`,
      `verify ${recordedVerify(record.events)}`,
    ]
    : [NOT_COMPARABLE_CLAIM, "verify unavailable"];
  return sanitizeTaskText([record.runId, ...claims].join(" · "));
};

export async function status(argv: string[], cwd = process.cwd(), opts: StatusOpts = {}): Promise<string> {
  const namedRunId = positionalRunId(argv);
  if (argv.includes("--oneline")) return oneLine(cwd, namedRunId);
  // cockpit surface: banner + frame on a TTY (doctor's pattern); pipes get the bare frame
  if (!argv.includes("--watch")) {
    const { content } = renderFrame(cwd, opts.now?.() ?? Date.now(), 0, undefined, false, namedRunId);
    return visual() ? BANNER + content : content;
  }

  const eventStream = argv.some((arg) => arg === "--events" || arg === "--jsonl" || arg === "--decision-events");
  const webhookUrl = opts.webhookUrl
    ?? optionValue(argv, "--webhook")
    ?? process.env.TICKMARKR_DECISION_WEBHOOK;
  const postWebhook = opts.postWebhook ?? defaultPostWebhook;
  const iterations = opts.iterations ?? Infinity;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const bounded = Number.isFinite(iterations);
  const frames: string[] = [];
  const eventLines: string[] = [];
  const sep = "\n---\n";
  const tty = !eventStream && visual();
  const workerLiveness = new Map<string, WorkerLiveness>();
  const herdr = !eventStream && HerdrDriver.available() ? new HerdrDriver() : undefined;
  const readWorkerOutput = opts.readWorkerOutput ?? (herdr
    ? async (taskId: string, attempt: number, runId: string) => {
        const name = formatOwnedName({ role: "worker", taskId, attempt, runId });
        try {
          return await herdr.read({ id: name, name, cwd }, 80);
        } catch {
          return undefined;
        }
      }
    : undefined);
  const observeWorkerOutput = async (active: LivePhase[], runId: string | undefined, observedAt: number) => {
    const activeIds = new Set(active.map((phase) => phase.taskId));
    for (const taskId of workerLiveness.keys()) if (!activeIds.has(taskId)) workerLiveness.delete(taskId);
    if (!readWorkerOutput || !runId) return;
    await Promise.all(active.map(async (phase) => {
      const output = await readWorkerOutput(phase.taskId, phase.attempt, runId);
      if (output === undefined) return;
      const snapshot = normalizeStallSnapshot(output);
      const prior = workerLiveness.get(phase.taskId);
      if (!prior || prior.phaseStartedAt !== phase.startedAt) {
        const hasOutput = snapshot.trim().length > 0;
        workerLiveness.set(phase.taskId, {
          phaseStartedAt: phase.startedAt,
          snapshot,
          hasOutput,
          lastOutputAt: hasOutput ? observedAt : phase.startedAt,
        });
        return;
      }
      if (snapshot !== prior.snapshot && snapshot.trim().length > 0) {
        prior.hasOutput = true;
        prior.lastOutputAt = observedAt;
      }
      prior.snapshot = snapshot;
    }));
  };
  let decisionRunId: string | undefined;
  let journalCursor = 0;
  const consumeDecisionEvents = (): DecisionEvent[] => {
    // A named run is followed, never re-resolved: --watch <runId> keeps reporting that run even as
    // newer runs start. Only the no-argument form tracks latest, as before.
    const runId = namedRunId ?? Journal.latestRunId(cwd, { withJournal: true });
    if (!runId) return [];
    if (decisionRunId !== runId) {
      decisionRunId = runId;
      journalCursor = 0;
    }
    const journalEvents = Journal.open(cwd, runId).read();
    if (journalEvents.length < journalCursor) journalCursor = 0;
    const fresh = decisionEventsFromJournal(journalEvents, runId, stateDirName(cwd))
      .filter((event) => event.sequence > journalCursor);
    journalCursor = journalEvents.length;
    if (webhookUrl) {
      for (const event of fresh) {
        if (event.tier === "decision") postWebhookFireAndForget(postWebhook, webhookUrl, event);
      }
    }
    return fresh;
  };
  let titleSaved = false;
  const restoreTitle = () => {
    if (!titleSaved) return;
    titleSaved = false;
    process.stdout.write(RESTORE_TERMINAL_TITLE);
  };
  const updateTitle = (hotPhase: LivePhase | undefined, nowMs: number) => {
    if (!hotPhase) {
      if (titleSaved) {
        process.removeListener("exit", restoreTitle);
        restoreTitle();
      }
      return;
    }
    if (!titleSaved) {
      process.stdout.write(SAVE_TERMINAL_TITLE);
      titleSaved = true;
      process.once("exit", restoreTitle);
    }
    process.stdout.write(`\x1b]0;⏳ ${hotPhase.taskId} ${phaseLabel(hotPhase)} ${fmtElapsed(nowMs - hotPhase.startedAt)}\x07`);
  };

  try {
    for (let i = 0; i < iterations; i++) {
      const nowMs = now();
      const decisionEvents = eventStream || webhookUrl ? consumeDecisionEvents() : [];
      let frame: RenderedFrame | undefined;
      if (eventStream) {
        for (const event of decisionEvents) {
          const line = JSON.stringify(event);
          process.stdout.write(line + "\n");
          if (bounded) eventLines.push(line);
        }
      } else {
        frame = renderFrame(cwd, nowMs, i, workerLiveness, true, namedRunId);
        if (tty) {
          updateTitle(frame.hotPhase, nowMs);
          process.stdout.write(`\x1b[2J\x1b[H${BANNER}${frame.content}\n${legend(` watching · refresh ${REFRESH_MS / 1000}s · ^C to quit`)}`);
        } else {
          process.stdout.write(frame.content + sep);
        }
        if (bounded) frames.push(frame.content);
      }
      if (i + 1 < iterations) {
        if (frame) await observeWorkerOutput(frame.workerPhases, frame.runId, nowMs);
        await sleep(REFRESH_MS);
      }
    }
  } finally {
    if (titleSaved) {
      process.removeListener("exit", restoreTitle);
      restoreTitle();
    }
  }
  return bounded ? eventStream ? eventLines.join("\n") : frames.join(sep) : "";
}
