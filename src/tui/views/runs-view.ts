// T1 (v1.68): Runs cockpit — journal timeline, per-task gate ladder, attempt history.
// Pure render over INJECTED data: this module never touches the filesystem. The caller hands in
// a journal event list and a compiled graph; the view folds them into task cards and a dispatch-
// ordered attempt history itself. The task card language and gate ladder reuse the existing status
// command helpers verbatim rather than reimplementing them.
import { GLYPHS, dim, fail, legend, ok, statusRow, warn, type Verdict } from "../../brand.js";
import { channelKey, type Assignment, type TokenUsage } from "../../adapters/types.js";
import {
  GATE_NAMES,
  type RunGraph,
  type Task,
  type TaskStatus,
} from "../../graph/schema.js";
import { foldActivity } from "../../run/activity.js";
import { formatJournalNarration, type JournalEvent, type TelemetryRow, type WorkerResultCause } from "../../run/journal.js";
import { costSignal } from "../../cli/commands/fleet-picker.js";
import { approve } from "../../cli/commands/approve.js";
import {
  gateChain,
  gateStates,
  defaultGateStates,
  humanGateSuffix,
  shortGoal,
  failedGates,
  type GateState,
} from "../../cli/commands/status.js";
import { renderDossierPlaceholder } from "./consult-dossier.js";
import type { View } from "../app.js";

export type AttemptRecord = {
  attempt: number;
  channel: string;
  outcome: "clean" | "failed" | "in-flight" | "aborted";
  /** typed worker-result failure reason when the attempt did not finish cleanly */
  cause?: WorkerResultCause;
  /** worker-result summary or consult-verdict reason, when present */
  note?: string;
};

export type RunsTask = {
  task: Task;
  status: TaskStatus;
  states: GateState[];
  channel: string;
  ctx?: number;
  activity?: string;
  attempts: AttemptRecord[];
};

/** Everything the Runs cockpit renders — loaded by the caller, never by the render path. */
export type RunsViewData = {
  runId?: string;
  events: JournalEvent[];
  graph: RunGraph;
  /** Whether the journal is comparable with the loaded graph. Defaults to true. */
  comparable?: boolean;
  /** Per-tier per-task pricing from config, rendered ONLY through the shared costSignal formatter. */
  pricing?: Record<string, number>;
  /** This run's observed usage rows (telemetry.jsonl), folded per channel by the cost ticker. */
  telemetry?: TelemetryRow[];
};

/** Options for creating a Runs view. Backward-compatible: plain `createRunsView(data)` still works. */
export type RunsViewOptions = {
  data?: RunsViewData;
  repoRoot?: string;
  /** Notify the caller of a single-line notice change (confirmation, refusal, progress, result). */
  onNotice?: (message: string | null) => void;
  /** Refresh injected data after a mutation. Called after a successful approval. */
  reload?: () => RunsViewData | Promise<RunsViewData>;
};

export type RunsView = View & {
  /** Handle a decoded key name ("up" | "down" | "a" | "y"). */
  key(name: string): void;
  /** Index of the cursor in the task list. */
  cursor: number;
  /** The currently selected task, if any. */
  selectedTask(): RunsTask | undefined;
  /** Promise of an in-flight approval, exposed for tests. */
  approval?: Promise<void>;
};

const channelOf = (assignment: unknown): string => {
  const a = assignment as { adapter?: unknown; model?: unknown } | undefined;
  return typeof a?.adapter === "string" && typeof a.model === "string" ? `${a.adapter}:${a.model}` : "unknown channel";
};

const taskVerdict = (st: TaskStatus): Verdict =>
  st === "done" ? "pass" : st === "failed" ? "fail" : st === "human" ? "warn" : "neutral";

/** Local replay of task statuses from events only — mirrors Journal.replayStatuses but keeps the
 *  view filesystem-free. */
function replayStatuses(events: JournalEvent[]): Map<string, TaskStatus> {
  const s = new Map<string, TaskStatus>();
  for (const e of events) {
    if (!e.taskId) continue;
    if (e.event === "task-dispatch") s.set(e.taskId, "running");
    else if (e.event === "task-done") s.set(e.taskId, "done");
    else if (e.event === "task-failed") s.set(e.taskId, "failed");
    else if (e.event === "task-human") s.set(e.taskId, "human");
    else if (e.event === "task-approved") s.set(e.taskId, "pending");
  }
  for (const [id, st] of s) if (st === "running") s.set(id, "pending");
  return s;
}

/** Fold one task's dispatch-ordered attempt history. Each task-dispatch opens an attempt; a
 *  worker-result sets the attempt's outcome; task-done/task-failed/task-approved finish it. A new
 *  dispatch while the previous attempt is still in-flight marks it aborted. */
function foldAttempts(events: JournalEvent[], taskId: string): AttemptRecord[] {
  const attempts: AttemptRecord[] = [];
  let open: AttemptRecord | undefined;
  const finish = () => {
    if (open) {
      attempts.push(open);
      open = undefined;
    }
  };
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    if (e.event === "task-dispatch" || e.event === "escalation") {
      if (open) {
        if (open.outcome === "in-flight") open.outcome = "aborted";
        finish();
      }
      const attempt = (Number.isInteger(e.data.attempt) ? (e.data.attempt as number) : 0) + 1;
      open = { attempt, channel: channelOf(e.data.assignment), outcome: "in-flight" };
    } else if (e.event === "worker-result" && open) {
      const ok = e.data.ok === true;
      const finished = e.data.finished === true;
      if (ok && finished) {
        open.outcome = "clean";
      } else {
        open.outcome = "failed";
        open.cause = (e.data.cause as WorkerResultCause | undefined) ?? undefined;
        open.note = typeof e.data.summary === "string" ? e.data.summary : undefined;
      }
    } else if (e.event === "task-done" || e.event === "task-approved") {
      if (open && open.outcome === "in-flight") open.outcome = "clean";
      finish();
    } else if (e.event === "task-failed") {
      if (open && open.outcome === "in-flight") open.outcome = "failed";
      finish();
    }
  }
  finish();
  return attempts;
}

/** Build the injected raw data into task rows. Pure function, no filesystem access. */
export function foldRunsTasks(data: RunsViewData): RunsTask[] {
  const { events, graph, comparable = true } = data;
  const statuses = replayStatuses(events);
  const assignments = new Map<string, string>();
  const contexts = new Map<string, number>();
  for (const e of events) {
    if (e.event === "task-dispatch" && e.taskId) {
      assignments.set(e.taskId, channelOf(e.data.assignment));
    }
    if (e.event === "context-sample" && e.taskId && typeof e.data.tokens === "number" && Number.isFinite(e.data.tokens)) {
      contexts.set(e.taskId, e.data.tokens as number);
    }
  }
  const activityTasks = graph.tasks.map((t) => ({
    id: t.id,
    gates: t.gates,
    deps: t.deps,
    status: statuses.get(t.id) ?? t.status,
  }));
  const activity = foldActivity(comparable ? events : [], activityTasks);
  return graph.tasks.map((t) => {
    const status = statuses.get(t.id) ?? t.status;
    const states = comparable ? gateStates(t, events) : defaultGateStates(t);
    const channel = assignments.get(t.id) ?? "-";
    return {
      task: t,
      status,
      states,
      channel,
      ctx: contexts.get(t.id),
      activity: activity.cells.get(t.id),
      attempts: foldAttempts(events, t.id),
    };
  });
}

const CARD_LINES = 3; // 2 content lines + 1 blank separator

// T3 (v1.68): cost ticker + tip-verify state. Both fold from INJECTED data only. The ticker reuses
// fleet-picker's costSignal verbatim — a subscription channel renders "sub flat-rate quota", never a
// fabricated dollar figure; money never appears except as the formatter's own per-task estimate.

export type CostTickerRow = {
  /** adapter:model */
  key: string;
  /** verbatim output of the shared cost-signal formatter */
  signal: string;
  /** distinct tasks dispatched on this channel */
  tasks: number;
  /** summed observed token usage for this channel; undefined when nothing was metered */
  tokens?: number;
};

const usageTotal = (u: TokenUsage): number =>
  u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.reasoning ?? 0);

/** Sum observed token usage per channel for the loaded run. Dispatch events name the channel's
 *  full assignment (billing channel + tier); telemetry rows contribute the metered tokens. A
 *  telemetry-only channel degrades costSignal to "api metered" — never an invented price. */
export function foldCostTicker(data: RunsViewData): CostTickerRow[] {
  const pricing = data.pricing ?? {};
  const rows = new Map<string, { assignment?: Assignment; tasks: Set<string>; tokens: number; metered: boolean }>();
  const rowFor = (key: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { tasks: new Set(), tokens: 0, metered: false };
      rows.set(key, r);
    }
    return r;
  };
  for (const e of data.events) {
    if (e.event !== "task-dispatch" || !e.taskId) continue;
    const a = e.data.assignment as Assignment | undefined;
    if (!a || typeof a.adapter !== "string" || typeof a.model !== "string") continue;
    const r = rowFor(channelKey(a));
    r.tasks.add(e.taskId);
    if ((a.channel === "sub" || a.channel === "api") && typeof a.tier === "string") r.assignment = a;
  }
  for (const t of data.telemetry ?? []) {
    const r = rowFor(channelKey(t));
    if (t.tokens) {
      r.tokens += usageTotal(t.tokens);
      r.metered = true;
    }
    if (!r.assignment && (t.channel === "sub" || t.channel === "api")) {
      r.assignment = { adapter: t.adapter, model: t.model, channel: t.channel, tier: "" as Assignment["tier"] };
    }
  }
  return [...rows.entries()].map(([key, r]) => ({
    key,
    signal: r.assignment ? costSignal(r.assignment, pricing) : "channel unknown",
    tasks: r.tasks.size,
    tokens: r.metered ? r.tokens : undefined,
  }));
}

type TipVerifyState = { state: "pending" | "passed" | "failed"; gate?: string };

/** Last tip-verify event wins; none recorded yet ⇒ pending — never a false pass or fail. */
function tipVerifyState(events: JournalEvent[]): TipVerifyState {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === "tip-verify" || e.event === "tip-verify-failed") {
      return {
        state: e.event === "tip-verify" ? "passed" : "failed",
        gate: typeof e.data.gate === "string" ? e.data.gate : undefined,
      };
    }
  }
  return { state: "pending" };
}

function tipVerifyLine(events: JournalEvent[]): string {
  const tip = tipVerifyState(events);
  const word = tip.state === "passed" ? ok("passed") : tip.state === "failed" ? fail("failed") : dim("pending");
  return legend(`   tip-verify: ${tip.gate ? `${tip.gate} ` : ""}`) + word;
}

/** Cost values stay plain (CLI-DESIGN "data plain"): costSignal's output verbatim, never colorized. */
function costTickerPanel(data: RunsViewData): string[] {
  const rows = foldCostTicker(data);
  const lines = ["", dim("── cost ticker ──")];
  if (rows.length === 0) {
    lines.push("  no channel usage observed yet");
    return lines;
  }
  const keyW = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    const parts = [r.signal, `${r.tasks} task${r.tasks === 1 ? "" : "s"}`];
    if (r.tokens !== undefined) parts.push(`${r.tokens} tokens`);
    lines.push(`  ${r.key.padEnd(keyW)}  ${parts.join(" · ")}`);
  }
  return lines;
}

export function createRunsView(data?: RunsViewData, opts?: Omit<RunsViewOptions, "data">): RunsView {
  let currentData = data;
  let tasks = currentData ? foldRunsTasks(currentData) : [];
  let cursor = 0;
  let confirming: { taskId: string } | null = null;
  let notice: string | null = null;
  let busy = false;
  let approvalPromise: Promise<void> | undefined;
  const repoRoot = opts?.repoRoot;
  const onNotice = opts?.onNotice ?? (() => {});
  const reload = opts?.reload;

  const setNotice = (message: string | null) => {
    notice = message;
    onNotice(message);
  };

  const refresh = async () => {
    if (!reload) return;
    currentData = await reload();
    tasks = currentData ? foldRunsTasks(currentData) : [];
  };

  const runApprove = async (taskId: string) => {
    if (!repoRoot || !currentData?.runId) {
      setNotice("approval not available — no run loaded");
      return;
    }
    busy = true;
    setNotice("approving…");
    try {
      const message = await approve([currentData.runId, taskId], repoRoot);
      await refresh();
      setNotice(message);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      approvalPromise = undefined;
    }
  };

  const view: RunsView = {
    id: "runs",
    label: "Runs",
    cursor: 0,

    key(name: string): void {
      if (busy) return;
      if (confirming) {
        const taskId = confirming.taskId;
        confirming = null;
        if (name === "y") {
          approvalPromise = runApprove(taskId);
          return;
        }
        setNotice("approval cancelled");
        return;
      }
      if (!tasks.length) return;
      if (name === "up") cursor = Math.max(cursor - 1, 0);
      else if (name === "down") cursor = Math.min(cursor + 1, tasks.length - 1);
      else if (name === "a") {
        if (!repoRoot || !currentData?.runId) {
          setNotice("approval not available — no run loaded");
          return;
        }
        const task = tasks[cursor];
        if (!task) return;
        if (task.status === "human") {
          confirming = { taskId: task.task.id };
          setNotice(`approve ${task.task.id}? releases the parked human gate and resumes the run.   [y] confirm   [any key] cancel`);
          return;
        }
        approvalPromise = runApprove(task.task.id);
      }
      this.cursor = cursor;
    },

    selectedTask(): RunsTask | undefined {
      return tasks[cursor];
    },

    render(props: { cols: number; rows: number }): string[] {
      if (!currentData || !currentData.runId) {
        return emptyState();
      }
      const last = currentData.events.at(-1);
      const now = last ? formatJournalNarration(last) : undefined;
      const lines: string[] = [];
      if (now) lines.push(legend(`   now: ${now}`));
      else lines.push(legend("   now: —"));
      lines.push(tipVerifyLine(currentData.events));
      lines.push(legend(`   gates: ${GATE_NAMES.join(" · ")}`));
      lines.push("");

      const { rows } = props;
      const ticker = costTickerPanel(currentData);
      // Reserve space for: now, tip-verify, gates legend, blank, detail panel (blank + divider +
      // content + attempts), cost ticker panel, optional notice line, trailing blank
      const detailReserve = 6 + ticker.length + (notice ? 1 : 0);
      const cardBudget = Math.max(0, rows - lines.length - detailReserve);
      const visibleCount = Math.max(1, Math.floor(cardBudget / CARD_LINES));
      const maxStart = Math.max(0, tasks.length - visibleCount);
      let start = cursor - Math.floor(visibleCount / 2);
      if (start < 0) start = 0;
      if (start > maxStart) start = maxStart;
      const end = Math.min(tasks.length, start + visibleCount);

      const width = Math.min(props.cols, 100);
      const idW = Math.max(2, ...tasks.map((c) => c.task.id.length));
      const goalAvail = Math.max(8, width - (idW + 12));
      const goals = tasks.map((c) => shortGoal(c.task.goal, goalAvail));
      const goalW = Math.max(8, ...goals.map((s) => s.length));
      const indent = " ".repeat(idW + 5);

      for (let i = start; i < end; i++) {
        const t = tasks[i]!;
        const goal = goals[i]!;
        const pointer = i === cursor ? `${GLYPHS.pointer} ` : "  ";
        const f = failedGates(t.states);
        const human = humanGateSuffix(t.task, t.status, t.states);
        const statusCell = renderStatusCell(t.status, f, human);
        const line1 = `  ${pointer}${statusRow(taskVerdict(t.status), `${t.task.id.padEnd(idW)} ${goal.padEnd(goalW)}  ${statusCell}`)}`;
        const detailParts = [t.activity ?? t.channel];
        if (t.ctx !== undefined) detailParts.push(`ctx ${t.ctx}`);
        const line2 = `${indent}${gateChain(t.states, true)}  ${dim(detailParts.join(" · "))}`;
        lines.push(line1, line2, "");
      }

      lines.push(...detailPanel(tasks[cursor]));
      lines.push(...ticker);
      if (notice) lines.push(legend(`   ${notice}`));
      return lines;
    },
  };
  Object.defineProperty(view, "approval", {
    get: () => approvalPromise,
    configurable: true,
  });
  return view;
}

function renderStatusCell(status: TaskStatus, failed: string[], human: string): string {
  const stWord =
    status === "done" ? ok(String(status))
    : status === "failed" ? fail(String(status))
    : status === "human" ? warn(String(status))
    : String(status);
  const dot = dim(" · ");
  return stWord +
    (failed.length ? dot + fail(failed.join(", ")) : "") +
    (human ? dot + warn("awaiting approval") : "");
}

function detailPanel(task: RunsTask | undefined): string[] {
  if (!task) return [];
  const lines: string[] = ["", dim(`── ${task.task.id} — attempts & consult dossier ──`)];
  if (task.attempts.length === 0) {
    lines.push(`  no attempts recorded for ${task.task.id}`);
    return lines;
  }
  for (const a of task.attempts) {
    const reason = a.cause ? ` — ${a.cause}` : a.note ? ` — ${a.note}` : "";
    const statusWord = a.outcome === "clean" ? "done" : a.outcome === "failed" ? "failed" : "in flight";
    lines.push(`  attempt ${a.attempt}  ${a.channel}  ${statusWord}${reason}`);
  }
  lines.push("");
  lines.push(dim(renderDossierPlaceholder()));
  return lines;
}

function emptyState(): string[] {
  return [
    "",
    "  no run loaded — run `tickmarkr run` or `tickmarkr resume <runId>` to start one.",
    "  the Runs cockpit reads the active or most recent run's journal; nothing to show yet.",
    "",
  ];
}
