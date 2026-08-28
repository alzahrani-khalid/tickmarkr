import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyFailureOutput } from "../../gates/baseline.js";
import { stateDirName } from "../../graph/graph.js";
import { Journal } from "../../run/journal.js";

// The operator-facing schema is deliberately closed. Adding a fact to the table therefore requires
// adding it here as a conscious compatibility change, rather than letting incidental journal fields
// leak into an analytics surface.
export const STATS_COLUMNS = [
  "author",
  "reviewer",
  "dispatches",
  "deliveries",
  "delivery rate",
  "attempts to green",
  "real reds",
  "infra reds",
  "within-task rescues",
] as const;

export interface ChannelStats {
  author: string;
  reviewers: string[];
  dispatches: number;
  deliveries: number;
  deliveryRate: number;
  /** Mean journal-recorded attempts among this channel's delivered tasks; null when it delivered none. */
  attemptsToGreen: number | null;
  realReds: number;
  infraReds: number;
  rescues: string[];
}

export interface StatsReport {
  runs: number;
  channels: ChannelStats[];
}

interface MutableChannelStats {
  author: string;
  reviewers: Set<string>;
  dispatches: number;
  deliveries: number;
  attemptsToGreen: number;
  realReds: number;
  infraReds: number;
  rescues: Set<string>;
}

interface Dispatch {
  author: string;
  attempt?: number;
  eventIndex: number;
}

interface Delivery {
  author: string;
  eventIndex: number;
}

interface TaskHistory {
  dispatches: Dispatch[];
  deliveries: Delivery[];
}

const assignmentAuthor = (data: Record<string, unknown>): string | undefined => {
  const assignment = data.assignment;
  if (!assignment || typeof assignment !== "object") return undefined;
  const { adapter, model } = assignment as { adapter?: unknown; model?: unknown };
  return typeof adapter === "string" && typeof model === "string"
    ? `${adapter}:${model}`
    : undefined;
};

// Current journals write the reviewer into review prose; the structured field is also accepted so
// journals produced through gateResultJournalData retain their stronger identity representation.
const reviewerFrom = (data: Record<string, unknown>): string | undefined => {
  if (typeof data.reviewer === "string" && data.reviewer.trim()) return data.reviewer.trim();
  if (typeof data.details !== "string") return undefined;
  return /\breviewer(?:\s+|:\s*)([\w@./+-]+:[\w@./+-]+)/iu.exec(data.details)?.[1];
};

const redEvidence = (data: Record<string, unknown>): string => {
  const fingerprints = Array.isArray(data.fingerprints)
    ? data.fingerprints.filter((value): value is string => typeof value === "string")
    : [];
  const prose = [data.details, data.error, data.reason]
    .filter((value): value is string => typeof value === "string");
  return [...fingerprints, ...prose].join("\n");
};

const historyFor = (tasks: Map<string, TaskHistory>, taskId: string): TaskHistory => {
  let history = tasks.get(taskId);
  if (!history) {
    history = { dispatches: [], deliveries: [] };
    tasks.set(taskId, history);
  }
  return history;
};

const dispatchedAuthorFor = (history: TaskHistory, data: Record<string, unknown>): string | undefined => {
  const attempt = typeof data.attempt === "number" && Number.isInteger(data.attempt)
    ? data.attempt
    : undefined;
  if (attempt !== undefined) {
    const matched = [...history.dispatches].reverse().find((dispatch) => dispatch.attempt === attempt);
    if (matched) return matched.author;
  }
  return history.dispatches.at(-1)?.author;
};

const runIdsWithJournals = (cwd: string): string[] => {
  const runsDir = join(cwd, stateDirName(cwd), "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-")
      && existsSync(join(runsDir, entry.name, "journal.jsonl")))
    .map((entry) => entry.name)
    .sort();
};

/** Reduce every readable run journal under the repository's state directory. */
export function collectChannelStats(cwd = process.cwd()): StatsReport {
  const runIds = runIdsWithJournals(cwd);
  const channels = new Map<string, MutableChannelStats>();
  const channelFor = (author: string): MutableChannelStats => {
    let channel = channels.get(author);
    if (!channel) {
      channel = {
        author, reviewers: new Set(), dispatches: 0, deliveries: 0,
        attemptsToGreen: 0, realReds: 0, infraReds: 0, rescues: new Set(),
      };
      channels.set(author, channel);
    }
    return channel;
  };

  for (const runId of runIds) {
    const events = Journal.open(cwd, runId).read();
    const tasks = new Map<string, TaskHistory>();

    for (const [eventIndex, event] of events.entries()) {
      if (!event.taskId) continue;
      const history = historyFor(tasks, event.taskId);

      if (event.event === "task-dispatch") {
        const author = assignmentAuthor(event.data);
        if (!author) continue;
        channelFor(author).dispatches += 1;
        history.dispatches.push({
          author,
          ...(typeof event.data.attempt === "number" && Number.isInteger(event.data.attempt)
            ? { attempt: event.data.attempt }
            : {}),
          eventIndex,
        });
        continue;
      }

      if (event.event === "task-done") {
        const author = assignmentAuthor(event.data) ?? history.dispatches.at(-1)?.author;
        if (!author) continue;
        const channel = channelFor(author);
        channel.deliveries += 1;
        const recordedAttempts = typeof event.data.attempts === "number"
          && Number.isInteger(event.data.attempts) && event.data.attempts >= 0
          ? event.data.attempts
          : history.dispatches.filter((dispatch) => dispatch.eventIndex < eventIndex).length;
        channel.attemptsToGreen += recordedAttempts;
        history.deliveries.push({ author, eventIndex });
        continue;
      }

      if (event.event === "review-retry") {
        const author = dispatchedAuthorFor(history, event.data);
        if (!author) continue;
        for (const reviewer of [event.data.flaked, event.data.retried]) {
          if (typeof reviewer === "string" && reviewer.trim()) channelFor(author).reviewers.add(reviewer.trim());
        }
        continue;
      }

      if (event.event !== "gate-result") continue;
      const author = dispatchedAuthorFor(history, event.data);
      if (!author) continue;
      const channel = channelFor(author);
      if (event.data.gate === "review") {
        const reviewer = reviewerFrom(event.data);
        if (reviewer) channel.reviewers.add(reviewer);
      }
      if (event.data.pass !== false) continue;
      const infra = event.data.infra === true || classifyFailureOutput(redEvidence(event.data)) === "infra";
      if (infra) channel.infraReds += 1;
      else channel.realReds += 1;
    }

    // A rescue is task-matched, not attempt-matched: one edge says the failed author and delivering
    // author faced the same task in the same run. Repeated attempts on the failed author do not make
    // the task easier and therefore do not manufacture extra controlled comparisons.
    for (const [taskId, history] of tasks) {
      for (const delivery of history.deliveries) {
        const failedAuthors = new Set(history.dispatches
          .filter((dispatch) => dispatch.eventIndex < delivery.eventIndex && dispatch.author !== delivery.author)
          .map((dispatch) => dispatch.author));
        for (const failedAuthor of failedAuthors) {
          channelFor(delivery.author).rescues.add(`${failedAuthor} → ${delivery.author} (${runId}/${taskId})`);
        }
      }
    }
  }

  return {
    runs: runIds.length,
    channels: [...channels.values()]
      .sort((a, b) => a.author.localeCompare(b.author, "en"))
      .map((channel) => ({
        author: channel.author,
        reviewers: [...channel.reviewers].sort((a, b) => a.localeCompare(b, "en")),
        dispatches: channel.dispatches,
        deliveries: channel.deliveries,
        deliveryRate: channel.dispatches === 0 ? 0 : channel.deliveries / channel.dispatches,
        attemptsToGreen: channel.deliveries === 0 ? null : channel.attemptsToGreen / channel.deliveries,
        realReds: channel.realReds,
        infraReds: channel.infraReds,
        rescues: [...channel.rescues].sort((a, b) => a.localeCompare(b, "en")),
      })),
  };
}

const percent = (rate: number): string => `${Number((rate * 100).toFixed(1))}%`;

export function renderStats(report: StatsReport): string {
  const lines = [`tickmarkr stats — ${report.runs} run${report.runs === 1 ? "" : "s"}`];
  if (report.channels.length === 0) return [...lines, "no channels"].join("\n");
  lines.push(STATS_COLUMNS.join(" | "));
  for (const channel of report.channels) {
    lines.push([
      channel.author,
      channel.reviewers.join(", ") || "—",
      channel.dispatches,
      channel.deliveries,
      percent(channel.deliveryRate),
      channel.attemptsToGreen === null ? "—" : Number(channel.attemptsToGreen.toFixed(2)),
      channel.realReds,
      channel.infraReds,
      channel.rescues.join("; ") || "—",
    ].join(" | "));
  }
  return lines.join("\n");
}

export async function stats(argv: string[], cwd = process.cwd()): Promise<string> {
  if (argv.length > 0) throw new Error("stats takes no run id — it reads every run in the state directory");
  return renderStats(collectChannelStats(cwd));
}
