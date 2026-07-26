import type {
  ComponentState,
  JournalRow,
  StatusStripItem,
} from "./components.js";

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

export type RunStatus = "done" | "failed" | "interrupted" | "running";

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
  readonly statusItems: readonly StatusStripItem[];
};

export type RunCockpitSource = {
  readonly fileName: string;
  readonly raw: string;
};

export type RunCockpitDeriveOptions = {
  readonly isDaemonAlive?: (pid: number) => boolean;
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

type TaskState = "done" | "failed" | "human" | "pending" | "running" | "interrupted";
type RunLifecycle = "active" | "completed" | "superseded";

type TaskFact = {
  readonly id: string;
  readonly dispatches: DispatchFact[];
  state: TaskState;
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

function defaultDaemonLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      state: "pending",
      lastIndex: index,
      lastTs: ts,
      phase: "pending",
    };
    tasks.set(taskId, created);
    return created;
  };

  for (const [index, event] of events.entries()) {
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
      fact.phase = "worker";
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
    const state = {
      "task-done": "done",
      "task-failed": "failed",
      "task-human": "human",
      "task-approved": "pending",
    }[event.event] as TaskState | undefined;
    if (state) {
      const fact = task(event.taskId, index, event.ts);
      fact.state = state;
      fact.lastIndex = index;
      fact.lastTs = event.ts;
    }
  }

  if (interrupted) {
    for (const fact of tasks.values()) {
      if (fact.state === "running" || fact.state === "pending") {
        fact.state = "interrupted";
      }
    }
  }
  return tasks;
}

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
    || (event.event === "run-end" && event.data.tipVerify === "failed");
}

function recordsSuccess(event: CaptureEvent): boolean {
  return event.event === "task-done"
    || event.event === "merge"
    || event.data.pass === true
    || event.data.ok === true
    || (event.event === "run-end" && event.data.tipVerify !== "failed");
}

/**
 * A row depicts the event it names: the event's own recorded outcome decides
 * the state, never the state its task reached later. Only a task with no
 * terminal event in a run whose daemon is gone lends its interruption, because
 * no event records that ending — the interruption is the run's present truth.
 * Every state carries its word, so meaning never rides on hue alone.
 */
function eventPresentation(
  event: CaptureEvent,
  task: TaskFact | undefined,
): { readonly state: ComponentState; readonly word: string } {
  if (event.event === "escalation" || event.event === "task-human") {
    return { state: "warn", word: "warn" };
  }
  if (recordsFailure(event)) return { state: "fail", word: "fail" };
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
  const { state, word } = eventPresentation(event, task);
  // The spotlight entry must keep the task, its attempt and its acting adapter
  // inside the narrowest band's width budget — that budget cannot pay for the
  // separators and the event name, so the state word and the run's status
  // (what the newest event recorded) ride after the adapter instead.
  const text = newest && spotlight !== undefined
    ? `${spotlight.id} attempt ${taskAttempt(spotlight)} ${taskActor(spotlight)} ${word}${word === runStatus ? "" : ` ${runStatus}`}`
    : task !== undefined
      ? `${task.id} ${word} · ${event.event}`
      : `${word} · ${event.event}`;
  return {
    id: `event:${event.line}`,
    time: eventTime(event.ts),
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

function tipVerificationPassed(events: readonly CaptureEvent[]): boolean {
  const eventVerdicts = events.flatMap((event) => {
    if (event.event === "tip-verify-failed") return [false];
    if (event.event === "tip-verify") return [event.data.pass === true];
    return [];
  });
  const endVerdicts = events.flatMap((event) =>
    event.event === "run-end" && typeof event.data.tipVerify === "string"
      ? [event.data.tipVerify === "passed"]
      : []
  );
  return eventVerdicts.length > 0
    && endVerdicts.length > 0
    && eventVerdicts.every(Boolean)
    && endVerdicts.every(Boolean);
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
    : pid !== undefined && (options.isDaemonAlive ?? defaultDaemonLiveness)(pid);
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
  const runStatus: RunStatus = failed > 0
    ? "failed"
    : lifecycle === "superseded" || hasInterruptedTask
        ? "interrupted"
        : lifecycle === "completed"
          ? "done"
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
    statusItems: [
      { state: tipPassed ? "pass" : "fail", text: `tip-verify ${tipPassed ? "passed" : "FAILED"}` },
      { state: "pass", text: `done ${done}` },
      { state: failed > 0 ? "fail" : "neutral", text: `failed ${failed}` },
      { state: human > 0 ? "warn" : "neutral", text: `human ${human}` },
      { state: escalated > 0 ? "warn" : "neutral", text: `escalated ${escalated}` },
    ],
  };
}
