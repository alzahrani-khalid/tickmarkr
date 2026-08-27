import { channelKey } from "../../adapters/types.js";
import { isPidLive } from "../../run/lock.js";
import type {
  ComponentState,
  JournalRow,
  StatusStripItem,
} from "./components.js";
import type { RunViewId } from "./views.js";

export const SPARKLINE_BUCKET_WINDOW = 12;
const MINUTE_MS = 60_000;
const SPARKLINE_BUCKET_WIDTH_LADDER_MINUTES = [
  1,
  5,
  10,
  30,
  60,
  120,
  360,
  720,
  1_440,
] as const;

export function selectSparklineBucketWidthMs(elapsedMs: number): number {
  const safeElapsedMs = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const requiredMinutes = safeElapsedMs / SPARKLINE_BUCKET_WINDOW / MINUTE_MS;
  const selected = SPARKLINE_BUCKET_WIDTH_LADDER_MINUTES.find(
    (minutes) => minutes >= requiredMinutes,
  );
  if (selected !== undefined) return selected * MINUTE_MS;

  let coarsened = SPARKLINE_BUCKET_WIDTH_LADDER_MINUTES.at(-1)!;
  while (coarsened < requiredMinutes) coarsened *= 2;
  return coarsened * MINUTE_MS;
}

type MetricSample = number | null;

/**
 * What the run is, in one word. `parked` is first-class beside the rest because
 * a run holding an unresolved `human` task owes the operator a verb — it is not
 * done, and calling it done is the render OBS-252 caught. The task-level word
 * for the same fact stays `human` (TaskState): that is the event the journal
 * writes, and `parked` is what the fold of it means for the run.
 */
export type RunStatus = "done" | "failed" | "interrupted" | "parked" | "running";

export type RunCockpitData = {
  readonly binaryVersion: string;
  readonly runId: string;
  readonly branch: string;
  readonly status: RunStatus;
  readonly elapsed: string;
  readonly tasks: {
    readonly done: number;
    readonly total: number;
    readonly samples: readonly MetricSample[];
  };
  readonly gates: {
    readonly passed: number;
    readonly total: number;
    readonly samples: readonly MetricSample[];
  };
  readonly passRate: {
    readonly value: number;
    readonly samples: readonly MetricSample[];
  };
  readonly progress: number;
  readonly progressCaption: string;
  readonly journalRows: readonly JournalRow[];
  readonly taskRows: readonly TaskRow[];
  readonly gateRows: readonly GateRow[];
  readonly fleetRows: readonly FleetRow[];
  readonly statusItems: readonly StatusStripItem[];
};

export type RunCockpitSource = {
  readonly fileName: string;
  readonly raw: string;
};

export type RunCockpitDeriveOptions = {
  readonly isDaemonAlive?: (pid: number) => boolean;
  /** The compiled graph, when the engagement has one. Identity only — see CockpitGraph. */
  readonly graph?: CockpitGraph;
};

/**
 * What the compiled graph lends the cockpit: which tasks exist, in what order,
 * and what each is called. `status` is named here only to state that it is
 * deliberately unread — the journal owns state, so a recompile can never
 * repaint a parked task green.
 */
export type CockpitGraph = {
  readonly tasks: readonly {
    readonly id: string;
    readonly title?: string;
    readonly status?: string;
  }[];
};

/** How an unrecorded field draws: the engagement said nothing, so the row says nothing. */
export const ABSENT_FIELD = "-";

/**
 * One reading of a row field. An absent field is a fact about the engagement —
 * it never recorded this — and never collapses into an empty string or a zero
 * that reads like a measurement.
 */
export function fieldReading(value: string | number | undefined): string {
  return value === undefined ? ABSENT_FIELD : String(value);
}

/**
 * One task of the compiled graph, wearing only what the journal recorded about
 * it. A task the journal never mentions still draws a row; its state, attempts,
 * actor and last event time are absent rather than invented — including the
 * state, because "pending" is a thing the engagement would have to have
 * recorded, not a thing a row may assume about silence.
 *
 * `attempts` is a count of recorded dispatches, never the newest dispatch's
 * `attempt` label: labels restart at zero on resume, so the label of the last
 * dispatch understates a task the engagement resumed into.
 */
export type TaskRow = {
  readonly id: string;
  readonly taskId: string;
  readonly state?: TaskState;
  readonly attempts?: number;
  readonly actor?: string;
  readonly lastEventTime?: string;
  /** Complete UTC instant paired with `lastEventTime`; additive for existing consumers. */
  readonly lastEventTimestamp?: string;
  readonly title?: string;
  /**
   * The park the task is standing in right now, as the daemon recorded it
   * (`task-human` data.kind). A resolved park has no kind at all: the badge
   * retires with the state it belonged to, so a merged task never wears the
   * `gate-fail` it was released from an hour earlier (OBS-256).
   */
  readonly parkKind?: string;
  /**
   * Recorded merged, and only then. A task the journal carried to `done` has
   * finished its work; a task the journal recorded a `merge` for has landed.
   * The two are different rows, so a consumer drawing a check-mark has the fact
   * that earns one rather than having to read `done` as if it were the same.
   */
  readonly merged?: true;
};

/** One recorded gate result. `details` is the record's own text, verbatim. */
export type GateRow = {
  readonly id: string;
  readonly time: string;
  /** Complete UTC instant paired with `time`; additive for existing consumers. */
  readonly timestamp?: string;
  readonly state: ComponentState;
  readonly gate?: string;
  readonly taskId?: string;
  readonly pass?: boolean;
  readonly details?: string;
};

/** One channel the engagement recorded, dispatched to or merely named. */
export type FleetRow = {
  readonly id: string;
  readonly adapter: string;
  readonly model: string;
  readonly dispatches?: number;
  readonly lastEventTime?: string;
  /** Complete UTC instant paired with `lastEventTime`; additive for existing consumers. */
  readonly lastEventTimestamp?: string;
};

type CaptureEvent = {
  readonly line: number;
  readonly ts: string;
  readonly event: string;
  readonly taskId?: string;
  readonly data: Record<string, unknown>;
};

type SourceDefect = {
  readonly line: number;
  readonly raw: string;
};

type Assignment = {
  readonly adapter: string;
  readonly model: string;
};

type DispatchFact = {
  readonly index: number;
  readonly ts: string;
  readonly attempt: number;
  readonly assignment?: Assignment;
};

export type TaskState =
  | "completed"
  | "done"
  | "failed"
  | "human"
  | "pending"
  | "running"
  | "interrupted";
type RunLifecycle = "active" | "completed" | "superseded";

type TaskFact = {
  readonly id: string;
  readonly dispatches: DispatchFact[];
  /** Undefined until an event records a state — silence is not "pending". */
  state: TaskState | undefined;
  /**
   * The kind of the park the task stands in now. It is written with the `human`
   * state and cleared with it, so it can never outlive the park it names.
   */
  parkKind: string | undefined;
  /** Recorded merged. Only this earns a task the check-mark. */
  merged: boolean;
  lastIndex: number;
  lastTs: string;
  phase: string;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSource(raw: string): {
  events: CaptureEvent[];
  defects: SourceDefect[];
} {
  const events: CaptureEvent[] = [];
  const defects: SourceDefect[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = recordValue(JSON.parse(line));
      const data = recordValue(parsed?.data);
      if (
        !parsed
        || typeof parsed.ts !== "string"
        || typeof parsed.event !== "string"
        || !data
        || (parsed.taskId !== undefined && typeof parsed.taskId !== "string")
      ) {
        defects.push({ line: index + 1, raw: line });
        continue;
      }
      events.push({
        line: index + 1,
        ts: parsed.ts,
        event: parsed.event,
        ...(typeof parsed.taskId === "string" ? { taskId: parsed.taskId } : {}),
        data,
      });
    } catch {
      defects.push({ line: index + 1, raw: line });
    }
  }
  return { events, defects };
}

function assignmentFrom(value: unknown): Assignment | undefined {
  const assignment = recordValue(value);
  return assignment
    && typeof assignment.adapter === "string"
    && typeof assignment.model === "string"
    ? { adapter: assignment.adapter, model: assignment.model }
    : undefined;
}

function elapsedReading(first: string, last: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(last) - Date.parse(first)) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const padded = (part: number) => String(part).padStart(2, "0");
  return `${padded(hours)}:${padded(minutes)}:${padded(remainder)}`;
}

function latestLifecycle(events: readonly CaptureEvent[]): RunLifecycle {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!.event;
    if (event === "superseded") return "superseded";
    if (event === "run-end") return "completed";
    if (event === "run-start" || event === "run-resume") return "active";
  }
  return "active";
}

function daemonPid(events: readonly CaptureEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      (event.event === "run-start" || event.event === "run-resume")
      && typeof event.data.pid === "number"
    ) {
      return event.data.pid;
    }
  }
  return undefined;
}

/**
 * The state an event writes onto the task it names — the whole list of them, so
 * "did anything move this task" is asked in one place. `task-dispatch` and
 * `merge` carry more than a state and are folded by hand below; they are named
 * here because they move one all the same.
 *
 * A Map, because an event name is whatever the journal wrote: an object's own
 * lookup answers `constructor` and `toString` with something inherited and
 * truthy, so a line naming one would masquerade as a state transition — writing
 * a function where a TaskState belongs and releasing a park the run declared.
 * A Map answers only for the keys stated here.
 */
const TASK_STATE_BY_EVENT: ReadonlyMap<string, TaskState> = new Map<string, TaskState>([
  ["task-dispatch", "running"],
  ["merge", "done"],
  ["task-done", "done"],
  ["task-failed", "failed"],
  ["task-human", "human"],
  ["task-approved", "pending"],
]);

/** Only task identities the summary actually records can enter its fold. */
function summaryTaskIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * The parks the latest `run-end` says the daemon stopped holding, that nothing
 * since resolved. The summary is the daemon's own closing statement, so a run
 * whose end names a task in `human` owes the operator a verb whether or not a
 * `task-human` line happens to precede it — that dependence is what let a run
 * end read `done` over a parked task (OBS-252).
 *
 * "Since" is measured from the summary forward, and only forward. The summary
 * describes the moment the daemon exited, so a state written *before* it —
 * the dispatch it parked, the completion of a round it then held for review —
 * is history the summary already accounts for and cannot answer it. Weighing
 * the whole-journal fold against it let a line above the summary retire a park
 * the summary itself declares: `run-start · task-dispatch T1 · run-end
 * human:[T1]` read `interrupted`, and the same journal with a `task-done T1`
 * read `done` — OBS-252 again, one line lower.
 *
 * So a name is resolved only when a later event moved that task: approved,
 * redispatched, finished, landed. Nothing later — including a task the record
 * never mentions at all — leaves the park standing, because an uncorroborated
 * park is still the run's own claim that it is waiting and withholding `done`
 * on a claim the surface cannot check is the fail-closed reading. It stays a
 * reading of the run and of the tasks it names: a summary is a journal event,
 * so its explicit task outcomes are facts the board must count and draw even
 * when the more detailed task event is absent.
 */
function unresolvedSummaryParks(events: readonly CaptureEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event !== "run-end") continue;
    const parked = Array.isArray(event.data.human) ? event.data.human : [];
    const released = new Map<string, boolean>();
    for (const later of events.slice(index + 1)) {
      if (later.taskId === undefined) continue;
      if (!TASK_STATE_BY_EVENT.has(later.event)) continue;
      released.set(later.taskId, later.event !== "task-human");
    }
    return parked.filter((id): id is string =>
      typeof id === "string" && released.get(id) !== true
    );
  }
  return [];
}

function deriveTasks(
  events: readonly CaptureEvent[],
  interrupted: boolean,
): Map<string, TaskFact> {
  const tasks = new Map<string, TaskFact>();
  const task = (taskId: string, index: number, ts: string): TaskFact => {
    const existing = tasks.get(taskId);
    if (existing) return existing;
    const created: TaskFact = {
      id: taskId,
      dispatches: [],
      state: undefined,
      parkKind: undefined,
      merged: false,
      lastIndex: index,
      lastTs: ts,
      phase: "pending",
    };
    tasks.set(taskId, created);
    return created;
  };

  for (const [index, event] of events.entries()) {
    if (event.event === "run-end") {
      // The closing summary is a recorded fold, not commentary. Apply all
      // task outcomes it owns before later resume events get their ordinary
      // chance to supersede them. Failure comes last so a malformed overlap
      // fails closed instead of repainting a failed task done.
      const summaries: readonly (readonly [unknown, TaskState])[] = [
        [event.data.done, "done"],
        [event.data.human, "human"],
        [event.data.failed, "failed"],
      ];
      for (const [ids, state] of summaries) {
        for (const taskId of summaryTaskIds(ids)) {
          const fact = task(taskId, index, event.ts);
          fact.state = state;
          // A summary does not invent a park kind; it preserves one only when
          // it confirms that the same park still stands.
          if (state !== "human") fact.parkKind = undefined;
          fact.lastIndex = index;
          fact.lastTs = event.ts;
        }
      }
      continue;
    }
    if (!event.taskId) continue;
    if (event.event === "task-dispatch") {
      const fact = task(event.taskId, index, event.ts);
      const recordedAttempt = event.data.attempt;
      fact.dispatches.push({
        index,
        ts: event.ts,
        attempt: typeof recordedAttempt === "number"
          ? Math.max(1, Math.floor(recordedAttempt) + 1)
          : fact.dispatches.length + 1,
        assignment: assignmentFrom(event.data.assignment),
      });
      fact.state = "running";
      fact.parkKind = undefined;
      fact.phase = "worker";
      fact.lastIndex = index;
      fact.lastTs = event.ts;
      continue;
    }
    if (event.event === "merge") {
      const fact = task(event.taskId, index, event.ts);
      fact.merged = true;
      // A merge is a landing, and it is a state the journal recorded: the task
      // is done, and whatever park it was released from is retired by the merge
      // itself rather than by whichever event happened to precede it. Nothing
      // here depends on a `task-done` line arriving first (OBS-256).
      fact.state = "done";
      fact.parkKind = undefined;
      fact.lastIndex = index;
      fact.lastTs = event.ts;
      continue;
    }
    if (event.event === "phase-start") {
      const fact = task(event.taskId, index, event.ts);
      fact.phase = typeof event.data.phase === "string" ? event.data.phase : fact.phase;
      fact.lastIndex = index;
      fact.lastTs = event.ts;
      continue;
    }
    // `task-dispatch` and `merge` returned above; the rest write their state and
    // nothing else. One list, read from one place, so a new state-writing event
    // cannot move the fold without also moving what resolves a park.
    const state = TASK_STATE_BY_EVENT.get(event.event);
    if (state) {
      const fact = task(event.taskId, index, event.ts);
      fact.state = state;
      // The park kind travels with the park: `task-human` records it, and the
      // next recorded state — approved, done, failed — retires it with the park
      // it named. A resolved state must not leave its badge behind (OBS-256).
      fact.parkKind = state === "human" && typeof event.data.kind === "string"
        ? event.data.kind
        : undefined;
      fact.lastIndex = index;
      fact.lastTs = event.ts;
    }
  }

  if (interrupted) {
    for (const fact of tasks.values()) {
      // Only a task the journal recorded as running. `task-dispatch` recorded
      // that it started; no event records how it ended; the daemon that would
      // have recorded that ending is gone. So the recorded state cannot still
      // be true, and its interruption is a reading of that record — not an
      // invention on top of silence.
      //
      // Silence stays silent. A task the engagement mentioned without ever
      // recording a state keeps none: the run's stopping is a fact about the
      // run, and lending it to a task would be exactly the assumption an absent
      // field exists to refuse.
      //
      // A state the journal did record otherwise is never overwritten —
      // `pending` is what `task-approved` recorded, and it says the task was
      // released back to the pool to await a dispatch, not that a dispatch was
      // cut short. In the real post-run approval sequence (run-end, then the
      // operator approves) that approval is the newest thing the engagement
      // recorded about the task, so reporting it as interrupted would be the
      // run's stopping overruling the journal. The journal wins.
      if (fact.state === "running") fact.state = "interrupted";
    }
  }
  return tasks;
}

/**
 * The label the engagement gave the attempt now standing — which is what the
 * spotlight caption is naming ("attempt 3 of 4", the ladder's own numbering).
 * Not a count of attempts: labels restart at zero on resume. Rows that mean
 * "how many times was this tried" count dispatches instead — see TaskRow.
 */
function taskAttempt(fact: TaskFact): number {
  return fact.dispatches.at(-1)?.attempt ?? Math.max(1, fact.dispatches.length);
}

function taskActor(fact: TaskFact): string {
  const assignment = fact.dispatches.at(-1)?.assignment;
  return assignment ? `${assignment.adapter}:${assignment.model}` : "unassigned";
}

function changedActingAdapter(fact: TaskFact): boolean {
  const first = fact.dispatches[0]?.assignment?.adapter;
  const last = fact.dispatches.at(-1)?.assignment?.adapter;
  return first !== undefined && last !== undefined && first !== last;
}

function spotlightTask(tasks: ReadonlyMap<string, TaskFact>): TaskFact | undefined {
  return [...tasks.values()]
    .filter((fact) => fact.dispatches.length > 0)
    .sort((left, right) =>
      Number(changedActingAdapter(right)) - Number(changedActingAdapter(left))
      || taskAttempt(right) - taskAttempt(left)
      || right.lastIndex - left.lastIndex
    )[0];
}

function defectRow(defect: SourceDefect): JournalRow {
  const excerpt = defect.raw.trim().replace(/\s+/g, " ").slice(0, 64);
  return {
    id: `defect:${defect.line}`,
    time: `L${defect.line}`,
    state: "fail",
    text: `fail · DEFECT · source line ${defect.line} unparseable${excerpt ? ` · ${excerpt}` : ""}`,
  };
}

function eventTime(ts: string): string {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(11, 19)
    : ts.slice(0, 8);
}

/**
 * The outcome an event records about itself, in every form the committed
 * sources use: an unsuccessful result flag, an unsuccessful outcome flag, an
 * event name reporting a failure, a non-zero exit status, or a run-end whose
 * tip verification reads failed.
 */
function recordsFailure(event: CaptureEvent): boolean {
  return event.event.includes("failed")
    || event.data.pass === false
    || event.data.ok === false
    || (typeof event.data.exitCode === "number" && event.data.exitCode !== 0)
    || (
      event.event === "run-end"
      && (
        event.data.tipVerify === "failed"
        || summaryTaskIds(event.data.failed).length > 0
      )
    );
}

/**
 * The outcome an event records as a success. `merge` is here and `task-done` is
 * not: a merge records the landing, and a completion records only that the
 * worker stopped working — the gates that judge it and the merge that lands it
 * come after. A `run-end` counts only when its tip verification reads passed:
 * an absent verdict is nothing verified, and a check-mark on nothing verified
 * is the run claiming a pass tickmarkr never corroborated — the same
 * fail-closed reading the status strip already draws (OBS-244), now on the row.
 */
function recordsSuccess(event: CaptureEvent): boolean {
  return event.event === "merge"
    || event.data.pass === true
    || event.data.ok === true
    || (event.event === "run-end" && event.data.tipVerify === "passed");
}

/** The newest run-end speaks for the run; spotlight is context, not outcome. */
function runPresentation(
  runStatus: RunStatus,
  spotlight: TaskFact | undefined,
): { readonly state: ComponentState; readonly word: string } {
  switch (runStatus) {
    case "failed":
      return { state: "fail", word: "failed" };
    case "parked":
      return { state: "warn", word: "parked" };
    case "interrupted":
      return { state: "warn", word: "interrupted" };
    case "running":
      return { state: "neutral", word: "running" };
    case "done":
      // A task named beside the run still earns a check only from its merge.
      return spotlight === undefined || spotlight.merged
        ? { state: "pass", word: "pass" }
        : { state: "neutral", word: "done" };
  }
}

/**
 * A row depicts the event it names: the event's own recorded outcome decides
 * the state, never the state its task reached later. Only a task the journal
 * recorded as running, in a run whose daemon is gone, lends its interruption:
 * a dispatch was recorded, no event records how it ended, and the process that
 * would have recorded that ending is no longer there.
 * Every state carries its word, so meaning never rides on hue alone.
 */
function eventPresentation(
  event: CaptureEvent,
  task: TaskFact | undefined,
): { readonly state: ComponentState; readonly word: string } {
  if (event.event === "escalation") return { state: "warn", word: "warn" };
  // A park is a state, not a severity: the row says what the engagement is
  // waiting for, which is the operator.
  if (event.event === "task-human") return { state: "warn", word: "parked" };
  if (recordsFailure(event)) return { state: "fail", word: "fail" };
  if (
    event.event === "run-end"
    && summaryTaskIds(event.data.human).length > 0
  ) {
    return { state: "warn", word: "parked" };
  }
  // Work finished is not work landed. `task-done` records the first, so its row
  // says `done` and carries no check: the check-mark belongs to the `merge` that
  // records the landing, and until the journal writes one there is nothing to
  // put it on (OBS-256). This is the same reading `taskPresentation` gives the
  // task itself, stated here for the event because a row depicts its own event.
  if (event.event === "task-done") return { state: "neutral", word: "done" };
  if (recordsSuccess(event)) return { state: "pass", word: "pass" };
  if (task?.state === "interrupted") {
    return { state: "warn", word: "interrupted" };
  }
  return { state: "neutral", word: "neutral" };
}

function historyRow(
  event: CaptureEvent,
  tasks: ReadonlyMap<string, TaskFact>,
  spotlight: TaskFact | undefined,
  newest: boolean,
  runStatus: RunStatus,
): JournalRow {
  const task = event.taskId === undefined ? undefined : tasks.get(event.taskId);
  // Spotlight is context only for the taskless closing summary. A task-owned
  // newest event keeps its own identity and outcome: T2's dispatch or failure
  // cannot become a pass for merged T1 merely because T1 wins the spotlight.
  const summary = newest && event.event === "run-end"
    ? runPresentation(runStatus, spotlight)
    : undefined;
  const { state, word } = summary ?? eventPresentation(event, task);
  const displayedTask = newest
    ? event.taskId === undefined ? spotlight : task
    : task;
  // The spotlight entry must keep the task, its attempt and its acting adapter
  // inside the narrowest band's width budget — that budget cannot pay for the
  // separators and the event name, so the state word and the run's status
  // (what the newest event recorded) ride after the adapter instead.
  const text = newest && displayedTask !== undefined
    ? `${displayedTask.id} attempt ${taskAttempt(displayedTask)} ${taskActor(displayedTask)} ${word}${word === runStatus ? "" : ` ${runStatus}`}`
    : task !== undefined
      ? `${task.id} ${word} · ${event.event}`
      : `${word} · ${event.event}`;
  return {
    id: `event:${event.line}`,
    time: eventTime(event.ts),
    timestamp: event.ts,
    state,
    text,
  };
}

function journalRows(
  events: readonly CaptureEvent[],
  tasks: ReadonlyMap<string, TaskFact>,
  defects: readonly SourceDefect[],
  runStatus: RunStatus,
): JournalRow[] {
  const spotlight = spotlightTask(tasks);
  const history = [...events].reverse().map((event, index) =>
    historyRow(event, tasks, spotlight, index === 0, runStatus)
  );
  return [...[...defects].reverse().map(defectRow), ...history];
}

/**
 * The tasks the engagement owns, in the compiled graph's order: the graph
 * supplies identity and nothing else, so a task the journal never mentions
 * still draws a row. Every other field is read off recorded events — the
 * graph's own `status` is never consulted, which is what keeps a recompiled
 * graph from repainting a parked task green.
 */
function taskRows(
  events: readonly CaptureEvent[],
  tasks: ReadonlyMap<string, TaskFact>,
  graph: CockpitGraph | undefined,
): TaskRow[] {
  const lastSeen = new Map<string, string>();
  for (const event of events) {
    if (event.taskId !== undefined) lastSeen.set(event.taskId, event.ts);
  }
  const identities = graph !== undefined
    ? graph.tasks.map((task) => ({ id: task.id, title: task.title }))
    // Without a graph the engagement's own records are the only identities there are.
    : [...new Set([...tasks.keys(), ...lastSeen.keys()])].map((id) => ({
      id,
      title: undefined as string | undefined,
    }));

  return identities.map(({ id, title }) => {
    const fact = tasks.get(id);
    const assignment = fact?.dispatches.at(-1)?.assignment;
    const lastTs = lastSeen.get(id);
    // Counted, not read off the newest dispatch's label: the label restarts at
    // zero when a run resumes, so a task dispatched 0,1,0 was tried three times
    // and reporting its last label would say one.
    const attempts = fact?.dispatches.length ?? 0;
    // `task-done` records completion; only `merge` records landing. The fixed
    // Tasks-view consumer maps `done` to a check, so the derived row must keep
    // an unmerged completion in the neutral `completed` state and reserve
    // `done` for a fact whose merge the journal actually carries.
    const state = fact?.state === "done" && fact.merged !== true
      ? "completed" as const
      : fact?.state;
    return {
      id: `task:${id}`,
      taskId: id,
      ...(state === undefined ? {} : { state }),
      ...(attempts === 0 ? {} : { attempts }),
      ...(assignment === undefined ? {} : { actor: channelKey(assignment) }),
      ...(lastTs === undefined ? {} : { lastEventTime: eventTime(lastTs) }),
      ...(lastTs === undefined ? {} : { lastEventTimestamp: lastTs }),
      ...(title === undefined ? {} : { title }),
      // Only while the park stands: the fold cleared it the moment the journal
      // recorded what the park resolved to.
      ...(fact?.parkKind === undefined ? {} : { parkKind: fact.parkKind }),
      // Landing is its own fact. `done` is work finished; only a recorded merge
      // is work landed, and only that earns a check-mark.
      ...(fact?.merged === true ? { merged: true as const } : {}),
    };
  });
}

/**
 * One row per recorded gate result, newest first. The recorded details ride
 * through untouched — the operator reads the reviewer's findings and the
 * failing test names as the gate wrote them, never a rephrasing.
 */
function gateRows(events: readonly CaptureEvent[]): GateRow[] {
  const rows = events.flatMap((event): GateRow[] => {
    if (event.event !== "gate-result") return [];
    const pass = typeof event.data.pass === "boolean" ? event.data.pass : undefined;
    return [{
      id: `gate:${event.line}`,
      time: eventTime(event.ts),
      timestamp: event.ts,
      state: pass === true ? "pass" : pass === false ? "fail" : "neutral",
      ...(typeof event.data.gate === "string" ? { gate: event.data.gate } : {}),
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(pass === undefined ? {} : { pass }),
      ...(typeof event.data.details === "string" ? { details: event.data.details } : {}),
    }];
  });
  return rows.reverse();
}

/** An `adapter:model` channel key back into its parts, or nothing if it is not one. */
function splitChannelKey(
  key: string,
): { readonly adapter: string; readonly model: string } | undefined {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator >= key.length - 1) return undefined;
  return { adapter: key.slice(0, separator), model: key.slice(separator + 1) };
}

/**
 * One row per channel the engagement recorded, in the order it first named
 * them — starting with the roster it recorded at run-start, which is the whole
 * fleet it could have dispatched to, then any channel a later event named that
 * the roster did not. A channel it named without dispatching — a roster seat it
 * never used, or the static choice a failover passed over — carries no dispatch
 * count at all, because zero dispatches is something the engagement never
 * measured, not a measurement of zero.
 */
function fleetRows(events: readonly CaptureEvent[]): FleetRow[] {
  type Channel = {
    adapter: string;
    model: string;
    dispatches: number;
    lastTs: string;
  };
  const channels = new Map<string, Channel>();
  const note = (
    channel: { readonly adapter: string; readonly model: string },
    ts: string,
    dispatched: boolean,
  ): void => {
    const key = channelKey(channel);
    const existing = channels.get(key)
      ?? { adapter: channel.adapter, model: channel.model, dispatches: 0, lastTs: ts };
    channels.set(key, {
      ...existing,
      dispatches: existing.dispatches + (dispatched ? 1 : 0),
      lastTs: ts,
    });
  };

  const noteKeys = (recorded: readonly unknown[], ts: string): void => {
    for (const key of recorded) {
      const channel = typeof key === "string" ? splitChannelKey(key) : undefined;
      if (channel) note(channel, ts, false);
    }
  };

  for (const event of events) {
    if (event.event === "run-start" && Array.isArray(event.data.channels)) {
      noteKeys(event.data.channels, event.ts);
      continue;
    }
    if (event.event === "task-dispatch") {
      const assignment = assignmentFrom(event.data.assignment);
      if (assignment) note(assignment, event.ts, true);
      continue;
    }
    if (event.event === "failover-deviation") {
      noteKeys([event.data.static, event.data.chosen], event.ts);
    }
  }

  return [...channels.entries()].map(([key, channel]) => ({
    id: `channel:${key}`,
    adapter: channel.adapter,
    model: channel.model,
    ...(channel.dispatches === 0 ? {} : { dispatches: channel.dispatches }),
    lastEventTime: eventTime(channel.lastTs),
    lastEventTimestamp: channel.lastTs,
  }));
}

/**
 * The source identities the named view's rows carry, in draw order. Selection
 * is repaired against these, so it follows a row across a refresh instead of
 * following the index the row happened to occupy.
 */
export function runViewRowIdentities(
  data: RunCockpitData,
  viewId: RunViewId,
  // ponytail: the filter is the journal's, as it has always been; the promoted
  // views gain one when a criterion asks for it.
  filterQuery = "",
): readonly string[] {
  if (viewId === "tasks") return data.taskRows.map((row) => row.id);
  if (viewId === "gates") return data.gateRows.map((row) => row.id);
  if (viewId === "fleet") return data.fleetRows.map((row) => row.id);
  if (viewId !== "journal") return [];
  const query = filterQuery.trim().toLowerCase();
  return data.journalRows
    .filter((row) => query === "" || row.text.toLowerCase().includes(query))
    .map((row) => row.id);
}

function bucketedMetricSamples(events: readonly CaptureEvent[]): {
  readonly tasks: readonly MetricSample[];
  readonly gates: readonly MetricSample[];
  readonly passRate: readonly MetricSample[];
} {
  const taskSamples: MetricSample[] = Array.from(
    { length: SPARKLINE_BUCKET_WINDOW },
    () => null,
  );
  const gateTotals = Array.from(
    { length: SPARKLINE_BUCKET_WINDOW },
    () => 0,
  );
  const gatePasses = Array.from(
    { length: SPARKLINE_BUCKET_WINDOW },
    () => 0,
  );
  const firstMs = Date.parse(events[0]!.ts);
  const lastMs = Date.parse(events.at(-1)!.ts);
  const bucketWidthMs = selectSparklineBucketWidthMs(lastMs - firstMs);
  const windowStartMs = lastMs - bucketWidthMs * SPARKLINE_BUCKET_WINDOW;
  const completedTasks = new Set<string>();

  for (const event of events) {
    const eventMs = Date.parse(event.ts);
    if (!Number.isFinite(eventMs)) continue;
    const bucket = Math.max(
      0,
      Math.min(
        SPARKLINE_BUCKET_WINDOW - 1,
        Math.floor((eventMs - windowStartMs) / bucketWidthMs),
      ),
    );
    if (
      event.event === "task-done"
      && event.taskId
      && !completedTasks.has(event.taskId)
    ) {
      completedTasks.add(event.taskId);
      taskSamples[bucket] = (taskSamples[bucket] ?? 0) + 1;
    }
    if (event.event === "gate-result") {
      gateTotals[bucket] = gateTotals[bucket]! + 1;
      if (event.data.pass === true) {
        gatePasses[bucket] = gatePasses[bucket]! + 1;
      }
    }
  }

  return {
    tasks: taskSamples,
    gates: gateTotals.map((total, index) =>
      total === 0 ? null : gatePasses[index]!
    ),
    passRate: gateTotals.map((total, index) =>
      total === 0 ? null : Math.round((gatePasses[index]! / total) * 100)
    ),
  };
}

// OBS-244: the strip reports the LATEST verification cycle, never the whole journal conjoined.
// The daemon runs the integration-tip commands and appends `run-end` in one breath (daemon.ts
// finishRun), so a cycle is the tip-verify events recorded since the previous run-end together
// with the verdict on the run-end that closes them — a mid-run failure a later cycle recovered is
// no longer permanent red. `undefined` means nothing was verified: drawn absent, never passed.
// Fail-closed everywhere else — a cycle with no closing verdict, or a verdict with no events, is
// a failure, because a claim tickmarkr cannot corroborate is not a pass.
function tipVerificationPassed(
  events: readonly CaptureEvent[],
): boolean | undefined {
  const runEnds = events.flatMap((event, index) =>
    event.event === "run-end" ? [index] : []
  );
  const lastRunEnd = runEnds.at(-1);
  const cycle = events.slice(
    (runEnds.at(-2) ?? -1) + 1,
    lastRunEnd === undefined ? events.length : lastRunEnd + 1,
  );
  const cycleVerdicts = cycle.flatMap((event) => {
    if (event.event === "tip-verify-failed") return [false];
    if (event.event === "tip-verify") return [event.data.pass === true];
    return [];
  });
  const closing = lastRunEnd === undefined
    ? undefined
    : events[lastRunEnd]!.data.tipVerify;
  const endVerdict = typeof closing === "string"
    ? closing === "passed"
    : undefined;

  if (cycleVerdicts.length === 0 && endVerdict === undefined) return undefined;
  return endVerdict === true
    && cycleVerdicts.length > 0
    && cycleVerdicts.every(Boolean);
}

export function deriveRunCockpitData(
  source: RunCockpitSource,
  binaryVersion: string,
  options: RunCockpitDeriveOptions = {},
): RunCockpitData {
  const { events, defects } = parseSource(source.raw);
  if (events.length === 0) throw new Error(`empty cockpit capture: ${source.fileName}`);
  const start = events.find((event) => event.event === "run-start");
  if (!start) throw new Error(`capture has no run-start: ${source.fileName}`);

  const lifecycle = latestLifecycle(events);
  const pid = daemonPid(events);
  const alive = lifecycle !== "active"
    ? false
    // lock.ts's isPidLive is the ONE pid-liveness table. The local copy this replaced treated ANY
    // thrown probe error as death, so a daemon owned by another user (EPERM) read dead here and
    // alive in the lock — the cockpit called a live run interrupted.
    : pid !== undefined && (options.isDaemonAlive ?? isPidLive)(pid);
  const interrupted = !alive;
  const tasks = deriveTasks(events, interrupted);
  const taskFacts = [...tasks.values()];
  const done = taskFacts.filter((task) => task.state === "done").length;
  const failed = taskFacts.filter((task) => task.state === "failed").length;
  const human = taskFacts.filter((task) => task.state === "human").length;
  const hasInterruptedTask = taskFacts.some((task) => task.state === "interrupted");
  const gateEvents = events.filter((event) => event.event === "gate-result");
  const passed = gateEvents.filter((event) => event.data.pass === true).length;
  const passRate = gateEvents.length === 0 ? 0 : Math.round((passed / gateEvents.length) * 100);
  const progress = tasks.size === 0 ? 0 : Math.round((done / tasks.size) * 100);
  const escalated = events.filter((event) => event.event === "escalation").length;
  const tipPassed = tipVerificationPassed(events);
  const spotlight = spotlightTask(tasks);
  const samples = bucketedMetricSamples(events);
  // A task the journal carried somewhere other than done — approved and awaiting
  // the resume that redispatches it, most of all. `done` is a claim about all of
  // them, so one outstanding task retires it.
  const outstanding = taskFacts.some((task) =>
    task.state !== undefined && task.state !== "done"
  );
  // Parked outranks every reading but failure: a run holding an unresolved
  // `human` task owes the operator a verb, and the daemon's exit after a park is
  // the park's own consequence — not an interruption, and never done. A run that
  // also failed a task owes a fix first, so failure still leads (OBS-252).
  //
  // The word is owed on two readings, not one: the parks the fold holds, and
  // the parks the latest run-end names and nothing since resolved. The second
  // is what keeps the reading off the luck of a `task-human` line preceding the
  // run-end — the run's own closing statement is enough.
  const runStatus: RunStatus = failed > 0
    ? "failed"
    : human > 0 || unresolvedSummaryParks(events).length > 0
      ? "parked"
      : lifecycle === "superseded" || hasInterruptedTask
          ? "interrupted"
          : lifecycle === "completed"
            ? outstanding ? "interrupted" : "done"
            : interrupted
              ? "interrupted"
              : "running";

  return {
    binaryVersion,
    runId: source.fileName.replace(/(?:\.interrupted)?\.journal\.jsonl$/, ""),
    branch: typeof start.data.branch === "string" ? start.data.branch : "unknown",
    status: runStatus,
    elapsed: elapsedReading(events[0]!.ts, events.at(-1)!.ts),
    tasks: {
      done,
      total: tasks.size,
      samples: samples.tasks,
    },
    gates: {
      passed,
      total: gateEvents.length,
      samples: samples.gates,
    },
    passRate: {
      value: passRate,
      samples: samples.passRate,
    },
    progress,
    progressCaption: spotlight
      ? `${spotlight.id} · ${spotlight.phase} · attempt ${taskAttempt(spotlight)} · ${taskActor(spotlight)}`
      : "- · pending · attempt 1 · unassigned",
    journalRows: journalRows(events, tasks, defects, runStatus),
    taskRows: taskRows(events, tasks, options.graph),
    gateRows: gateRows(events),
    fleetRows: fleetRows(events),
    statusItems: [
      {
        state: tipPassed === undefined ? "neutral" : tipPassed ? "pass" : "fail",
        text: `tip-verify ${tipPassed === undefined ? ABSENT_FIELD : tipPassed ? "passed" : "FAILED"}`,
      },
      { state: "pass", text: `done ${done}` },
      { state: failed > 0 ? "fail" : "neutral", text: `failed ${failed}` },
      { state: human > 0 ? "warn" : "neutral", text: `human ${human}` },
      { state: escalated > 0 ? "warn" : "neutral", text: `escalated ${escalated}` },
    ],
  };
}
