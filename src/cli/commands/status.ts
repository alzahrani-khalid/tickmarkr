import { BANNER, GLYPHS, type Verdict, dim, fail, legend, ok, rule, statusRow, title, warn } from "../../brand.js";
import { HerdrDriver } from "../../drivers/herdr.js";
import { formatOwnedName } from "../../drivers/types.js";
import { blockedTasks, graphDefinitionHash, loadGraph } from "../../graph/graph.js";
import { GATE_NAMES, type RunGraph, type Task, type TaskStatus } from "../../graph/schema.js";
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
import { normalizeStallSnapshot } from "../../run/stall.js";

// ponytail: fixed 2s refresh; promote to config.visibility.* only when an operator asks.
const REFRESH_MS = 2000;
const NOT_COMPARABLE_NOTICE = "graph recompiled since this run — task states not comparable; run `tickmarkr run` to execute";

// The timer must keep the process ALIVE: an unref'd timer here let the event loop drain after the
// first frame, so a live `--watch` printed once and exited 0 (OBS-11). Never unref this.
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type StatusOpts = {
  iterations?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readWorkerOutput?: (taskId: string, attempt: number, runId: string) => Promise<string | undefined>;
};

export const GATE_KEYS = { build: "B", test: "T", lint: "L", evidence: "E", scope: "S", acceptance: "A", review: "R" } as const;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ASCII_SPINNER = ["|", "/", "-", "\\"] as const;
const SAVE_TERMINAL_TITLE = "\x1b[22;0t";
const RESTORE_TERMINAL_TITLE = "\x1b[23;0t";

type LivePhase = {
  taskId: string;
  phase: TaskPhase;
  startedAt: number;
  order: number;
  attempt: number;
};

type WorkerLiveness = {
  phaseStartedAt: number;
  snapshot: string;
  hasOutput: boolean;
  lastOutputAt: number;
};

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
      if (phase && Number.isFinite(startedAt)) live.set(event.taskId, { taskId: event.taskId, phase, startedAt, order, attempt });
      continue;
    }
    if (!event.taskId) continue;
    const active = live.get(event.taskId);
    if (!active) continue;
    const gate = phaseGate(active.phase);
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

const phaseLabel = (phase: TaskPhase): string => phase.startsWith("gate:") ? `gate ${phase.slice("gate:".length)}` : phase;

const fmtElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m${seconds % 60}s`;
};

const workerOutputAge = (phase: LivePhase, now: number, worker?: WorkerLiveness): number =>
  now - (worker?.phaseStartedAt === phase.startedAt && worker.hasOutput ? worker.lastOutputAt : phase.startedAt);

const phaseDetail = (phase: LivePhase, now: number, worker?: WorkerLiveness): string => {
  const elapsed = fmtElapsed(now - phase.startedAt);
  if (phase.phase !== "worker") return `${phaseLabel(phase.phase)} · ${elapsed} elapsed`;
  const age = fmtElapsed(workerOutputAge(phase, now, worker));
  const output = worker?.phaseStartedAt === phase.startedAt && worker.hasOutput
    ? `last output ${age} ago`
    : `no output ${age}`;
  return `${phaseLabel(phase.phase)} · ${elapsed} elapsed · ${output}`;
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

export const gateStates = (task: Task, events: JournalEvent[]): GateState[] => {
  const outcomes = new Map<string, "pass" | "fail" | "skip">();
  const start = attemptStartIdx(events, task.id);
  if (start >= 0) {
    for (const e of events.slice(start)) {
      if (e.taskId !== task.id || e.event !== "gate-result" || typeof e.data.gate !== "string") continue;
      if (e.data.skipped === true) outcomes.set(e.data.gate, "skip");
      else if (e.data.pass === true) outcomes.set(e.data.gate, "pass");
      else if (e.data.pass === false) outcomes.set(e.data.gate, "fail");
    }
  }
  return GATE_NAMES.map((gate) => task.gates.includes(gate) ? outcomes.get(gate) ?? "open" : "skip");
};

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

export const shortGoal = (goal: string, max: number): string => {
  const clause = goal.split(/[,;.?!]/, 1)[0]!.trim();
  if (clause.length <= max) return clause;
  if (max <= 3) return clause.slice(0, Math.max(0, max));
  return `${clause.slice(0, max - 3).trimEnd()}...`;
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

const renderFrame = (
  cwd: string,
  now = Date.now(),
  animationFrame = 0,
  workerLiveness = new Map<string, WorkerLiveness>(),
): RenderedFrame => {
  const g = loadGraph(cwd);
  const runId = Journal.latestRunId(cwd, { withJournal: true });
  const assignments = new Map<string, string>();
  let replayed: Map<string, TaskStatus> | null = null;
  let events: JournalEvent[] = [];
  const contexts = new Map<string, number>();
  let comparable = false;
  let supersededBy: string | undefined; // v1.53 T5: this run is dead — a newer run replaced it
  if (runId) {
    const j = Journal.open(cwd, runId);
    events = j.read();
    const sup = [...events].reverse().find((e) => e.event === "superseded" && typeof e.data.by === "string");
    supersededBy = sup?.data.by as string | undefined;
    // T3 (Sol #2 / Fable F2): the SAME comparator resume uses (engagementComparable) — one decision,
    // two consumers. graphDefinitionHash (compiled task definitions only) survives status/evidence
    // mutation but changes when a task definition changes, so a recompiled graph is detected here too.
    comparable = engagementComparable(events, graphDefinitionHash(g)).comparable;
    if (comparable) {
      replayed = j.replayStatuses();
      for (const e of events) {
        if (e.event === "task-dispatch" && e.taskId) {
          const a = e.data.assignment as { adapter?: string; model?: string };
          if (typeof a.adapter === "string" && typeof a.model === "string") assignments.set(e.taskId, `${a.adapter}:${a.model}`);
        }
        if (e.event === "context-sample" && e.taskId && typeof e.data.tokens === "number" && Number.isFinite(e.data.tokens)) {
          contexts.set(e.taskId, e.data.tokens as number); // last write wins
        }
      }
    }
  }
  const effective: RunGraph = { ...g, tasks: g.tasks.map((t) => ({ ...t, status: replayed?.get(t.id) ?? t.status })) };
  const starved = new Set(blockedTasks(effective).map((t) => t.id));
  // OBS-104: ONE activity fold feeds both surfaces — never re-derived here. Comparable events only
  // (a recompiled graph's journal must not animate the wrong tasks); with no or stale journal the
  // dep-waiting cells still derive from the effective graph statuses.
  const activity = foldActivity(comparable ? events : [], effective.tasks);
  const unicode = visual();
  const divider = unicode ? " · " : " / ";
  const width = process.stdout.columns ?? 120;
  const done = effective.tasks.filter((t) => t.status === "done").length;
  const ended = comparable && runHasEnded(events);
  const taskIds = new Set(g.tasks.map((task) => task.id));
  const phases = comparable ? livePhases(events) : new Map<string, LivePhase>();
  for (const taskId of phases.keys()) if (!taskIds.has(taskId)) phases.delete(taskId);
  const hotPhase = [...phases.values()].sort((a, b) => a.order - b.order).at(-1);

  const cells = g.tasks.map((t) => {
    const st = replayed?.get(t.id) ?? t.status;
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
    const phrase = livePhase ? phaseDetail(livePhase, now, workerLiveness.get(t.id)) : isStarved ? undefined : activity.cells.get(t.id);
    const label = isStarved ? " starved" : phrase ? ` ${phrase}` : "";
    const channel = assignments.get(t.id) ?? "-";
    const ctx = contexts.get(t.id);
    const assignCol = ctx !== undefined ? `${channel}${divider}ctx ${ctx}` : channel;
    return { t, st, failureKind, redTier, label, assignCol, isStarved, phrase, channel, ctx, livePhase, states: comparable ? gateStates(t, events) : defaultGateStates(t) };
  });

  if (!unicode) {
    // machine/CI surface — journals without phase-start stay byte-identical; new phase-aware frames
    // use an ASCII spinner so pipes never receive terminal-only braille/ANSI.
    const rows = cells.map(({ t, st, label, assignCol, livePhase, states }) => {
      const chain = gateChain(states, false);
      const prefix = livePhase ? `  ${ASCII_SPINNER[animationFrame % ASCII_SPINNER.length]} ${t.id} ` : `  ${taskBox(st)} ${t.id} `;
      const suffix = `  ${chain}  ${livePhase ? "running" : String(st)}${label}  ${assignCol}`;
      return `${prefix}${shortGoal(t.goal, Math.max(0, width - prefix.length - suffix.length))}${suffix}`;
    });
    const header = runId
      ? `tickmarkr status${divider}run ${runId}${supersededBy ? `${divider}superseded by ${supersededBy}` : ""}${!comparable ? `${divider}${NOT_COMPARABLE_NOTICE}` : ""}${divider}${liveness(events, now).replaceAll(" · ", divider)}${divider}${done}/${g.tasks.length} done`
      : `tickmarkr status${divider}no runs yet${divider}${done}/${g.tasks.length} done`;
    const legendLine = `  gates: ${GATE_NAMES.map((gate) => `${GATE_KEYS[gate]} ${gate}`).join(divider)}`;
    return {
      content: [header, legendLine, ...rows].join("\n"),
      ...(hotPhase ? { hotPhase } : {}),
      ...(runId ? { runId } : {}),
      workerPhases: [...phases.values()].filter((phase) => phase.phase === "worker"),
    };
  }

  // TTY: cockpit frame composed through src/brand.ts (CLI-DESIGN.md) — dominant run title,
  // dim chrome, semantic color only on verdicts, completion gauge, and column-aligned status
  // rows (pad plain text FIRST, colorize after: ANSI has zero display width and would corrupt
  // padEnd math)
  const dot = dim(" · ");
  const anyFailed = cells.some((c) => c.redTier);
  const gaugeCells = 10;
  const fill = g.tasks.length ? Math.round((done / g.tasks.length) * gaugeCells) : 0;
  const gauge = (fill ? (anyFailed ? fail : ok)("█".repeat(fill)) : "") + (fill < gaugeCells ? dim("░".repeat(gaugeCells - fill)) : "");
  const live = liveness(events, now)
    .replace(/\bdead\b/, fail("dead"))
    .replace(/\bfinished\b/, dim("finished"))
    .replace(/\balive\b/, ok("alive"))
    .replaceAll(" · ", dot);
  const tally = `${done}/${g.tasks.length} done`;
  const header = ` ${title(runId ? `run ${runId}` : "tickmarkr")}${dot}` +
    (runId
      ? `${supersededBy ? `${warn(`superseded by ${supersededBy}`)}${dot}` : ""}${!comparable ? `${warn(NOT_COMPARABLE_NOTICE)}${dot}` : ""}${live}${dot}`
      : `no runs yet${dot}`) +
    `${gauge} ${done === g.tasks.length && g.tasks.length > 0 ? ok(tally) : tally}`;
  const hr = rule(Math.min(width, 100));
  // OBS-104 run-level now line: names the most recent journal event. TTY frame only — the non-TTY
  // machine surface is byte-pinned (status-brand golden) and must not drift. Rendered BELOW the task
  // rows: the line names task ids, and rows must stay the first id-bearing lines for grep consumers.
  const nowLine = activity.now ? [legend(`   now: ${activity.now}`)] : [];
  const gatesLegend = legend(`   gates: ${GATE_NAMES.join(" · ")}`);

  // Two-line card per task (operator request, v1.67): line 1 carries identity + verdict — glyph,
  // id, goal at full width, and only SHORT status words. Line 2 carries the machinery, dim and
  // aligned under the goal: gate chain, live activity phrase (or channel), ctx. Long channel names
  // and activity phrases live on line 2 only, so they can never squeeze the goal or wrap line 1.
  const taskVerdict = (c: (typeof cells)[number]): Verdict =>
    c.st === "done" ? "pass" : c.redTier ? "fail" : c.st === "failed" || c.st === "human" ? "warn" : "neutral";
  const statusWord = (c: (typeof cells)[number]): string =>
    c.livePhase ? "running" : c.redTier ? "failed" : c.st === "failed" ? "warn" : String(c.st);
  const idW = Math.max(...cells.map((c) => c.t.id.length), 2);
  // plain-text status suffixes for width math only — starved / failed gate names / approval hint
  const suffixPlain = (c: (typeof cells)[number]): string =>
    (c.isStarved ? " · starved" : "") + failedSuffix(c.states) + humanGateSuffix(c.t, c.st, c.states);
  const stW = Math.max(...cells.map((c) => statusWord(c).length + suffixPlain(c).length));
  const avail = Math.max(8, width - (5 + idW) - 2 - stW);
  const goals = cells.map((c) => shortGoal(c.t.goal, avail));
  const goalW = Math.max(8, ...goals.map((s) => s.length));
  const indent = " ".repeat(idW + 5); // line 2 starts under the goal column
  const rows = cells.map((c, i) => {
    const { t, st, failureKind, redTier, states, isStarved, phrase, channel, ctx, livePhase } = c;
    const word = statusWord(c);
    const staleWorker = livePhase?.phase === "worker"
      && workerOutputAge(livePhase, now, workerLiveness.get(t.id)) >= 60_000;
    const stWord = staleWorker ? warn(word) : st === "done" ? ok(word) : redTier ? fail(word) : st === "failed" || st === "human" ? warn(word) : word;
    // a fail names its gate in words right here — the one moment gate identity is needed on a row
    const f = failedGates(states);
    const human = humanGateSuffix(t, st, states);
    const statusCell = stWord +
      (isStarved ? dot + fail("starved") : "") +
      (f.length ? dot + fail(f.join(", ")) : "") +
      (human ? dot + warn("awaiting approval") : "");
    const taskLabel = `${t.id.padEnd(idW)} ${goals[i]!.padEnd(goalW)}  ${statusCell}`;
    const line1 = livePhase
      ? `  ${(staleWorker ? warn : dim)(SPINNER[animationFrame % SPINNER.length]!)} ${taskLabel}`
      : `  ${statusRow(taskVerdict(c), taskLabel)}`;
    // activity already names its channel for in-flight attempts — never repeat it
    const detail = [
      ...(phrase ? [phrase, ...(phrase.includes(channel) || channel === "-" ? [] : [channel])] : [channel]),
      ...(failureKind && !phrase?.includes(failureKind) ? [failureKind] : []),
      ...(ctx !== undefined ? [`ctx ${ctx}`] : []),
    ].join(" · ");
    return [line1, `${indent}${gateChain(states, true)}  ${dim(detail)}`, ""];
  }).flat();
  if (!nowLine.length) rows.pop(); // cards end blank-separated; drop the dangling one
  return {
    content: [header, hr, gatesLegend, "", ...rows, ...nowLine].join("\n"),
    ...(hotPhase ? { hotPhase } : {}),
    ...(runId ? { runId } : {}),
    workerPhases: [...phases.values()].filter((phase) => phase.phase === "worker"),
  };
};

export async function status(argv: string[], cwd = process.cwd(), opts: StatusOpts = {}): Promise<string> {
  // cockpit surface: banner + frame on a TTY (doctor's pattern); pipes get the bare frame
  if (!argv.includes("--watch")) {
    const { content } = renderFrame(cwd, opts.now?.() ?? Date.now());
    return visual() ? BANNER + content : content;
  }

  const iterations = opts.iterations ?? Infinity;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const bounded = Number.isFinite(iterations);
  const frames: string[] = [];
  const sep = "\n---\n";
  const tty = visual();
  const workerLiveness = new Map<string, WorkerLiveness>();
  const herdr = HerdrDriver.available() ? new HerdrDriver() : undefined;
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
    process.stdout.write(`\x1b]0;⏳ ${hotPhase.taskId} ${phaseLabel(hotPhase.phase)} ${fmtElapsed(nowMs - hotPhase.startedAt)}\x07`);
  };

  try {
    for (let i = 0; i < iterations; i++) {
      const nowMs = now();
      const frame = renderFrame(cwd, nowMs, i, workerLiveness);
      if (tty) {
        updateTitle(frame.hotPhase, nowMs);
        process.stdout.write(`\x1b[2J\x1b[H${BANNER}${frame.content}\n${legend(` watching · refresh ${REFRESH_MS / 1000}s · ^C to quit`)}`);
      } else {
        process.stdout.write(frame.content + sep);
      }
      if (bounded) frames.push(frame.content);
      if (i + 1 < iterations) {
        await observeWorkerOutput(frame.workerPhases, frame.runId, nowMs);
        await sleep(REFRESH_MS);
      }
    }
  } finally {
    if (titleSaved) {
      process.removeListener("exit", restoreTitle);
      restoreTitle();
    }
  }
  return bounded ? frames.join(sep) : "";
}
