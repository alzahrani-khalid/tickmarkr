import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import { graphDefinitionHash, loadGraph, stateDirName } from "../../graph/graph.js";
import { GATE_NAMES } from "../../graph/schema.js";
import { decisionCommands, permittedDecisionVerbs } from "../../run/decision-verbs.js";
import { effectiveEvents, engagementComparable, fatalRunEndCause, parseJournalText, parseRunId, physicalLine, visibleControls, withPhysicalLine, type JournalEvent } from "../../run/journal.js";
import { runLockOwner } from "../../run/lock.js";
import { readOperatorState } from "../../run/operator-state.js";
import { commandHelp, hasHelpFlag } from "../help.js";
import { newestPark, parkToken } from "./approve.js";
import { currentOwed } from "./report.js";
import { daemonLiveness, recordProjection } from "./status.js";
import { StatusSnapshotSchema, type StatusSnapshot } from "./status-snapshot.js";

export type WaitOpts = { now?: () => number; sleep?: (ms: number) => Promise<void> };
export type Cause = "run-end" | "park" | "task-failed" | "daemon-death" | "timeout";
const EXIT = { "run-end": 0, park: 3, "task-failed": 4, "daemon-death": 5, timeout: 6 } as const;
const causes: Readonly<Record<string, Cause | undefined>> = { "run-end": "run-end", "task-human": "park", "task-failed": "task-failed" };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** An append-only cursor. A partial UTF-8 character or JSON row survives until the next read. */
export class JournalTail {
  readonly events: JournalEvent[] = [];
  raw = "";
  private offset = 0;
  private completeLines = 0;
  private pending = "";
  private provisional = false;
  private decoder = new StringDecoder("utf8");
  private identity: ReturnType<typeof fstatSync>;

  constructor(private path: string, private fd: number) {
    this.identity = fstatSync(fd);
    if (!this.identity.isFile()) throw new Error(`unreadable journal: ${path} is not a regular file`);
  }

  get line(): number { return this.completeLines + (this.pending.length ? 1 : 0); }
  get completeLineCount(): number { return this.completeLines; }

  read(): JournalEvent[] {
    const stat = statSync(this.path);
    if (stat.ino !== this.identity.ino || stat.dev !== this.identity.dev || stat.size < this.offset) {
      throw new Error(`journal replaced or truncated: ${this.path}`);
    }
    if (stat.size === this.offset) return [];
    if (this.provisional) this.events.pop();
    this.provisional = false;
    const fresh: JournalEvent[] = [];
    const parse = (text: string, line: number, complete = true): boolean => {
      const rows = parseJournalText(text);
      if (!rows.length) return false;
      const row = rows[0]!;
      if (row && typeof row === "object") withPhysicalLine(row, line);
      this.events.push(row);
      if (complete) fresh.push(row);
      return true;
    };
    while (this.offset < stat.size) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - this.offset));
      const bytes = readSync(this.fd, buffer, 0, buffer.length, this.offset);
      if (!bytes) throw new Error(`journal ended during read: ${this.path}`);
      this.offset += bytes;
      const text = this.decoder.write(buffer.subarray(0, bytes));
      this.raw += text;
      const lines = (this.pending + text).split("\n");
      this.pending = lines.pop()!;
      for (const line of lines) parse(line, ++this.completeLines);
    }
    // Status can describe valid JSON without a newline, but only a completed physical
    // line can wake wait. Retain provisional evidence without consuming that wakeup.
    if (this.pending.length) this.provisional = parse(this.pending, this.completeLines + 1, false);
    return fresh;
  }
}

/** Mutable cursor shared by wait and attached sessions. Only complete physical rows wake it. */
export type WakeCursor = { after?: number; initial?: boolean };
export type Wake = { cause: Exclude<Cause, "timeout">; line: number };

/** Classify the next unconsumed wake, including rows observed by the death-confirmation read.
 * Row order wins over kind; a newly recorded engagement gets its own liveness proof. */
export function classifyWake(tail: JournalTail, cursor: WakeCursor): Wake | undefined {
  const qualifying = () => tail.events.find(row => {
    const line = physicalLine([row], 0);
    return line > cursor.after! && line <= tail.completeLineCount && Object.hasOwn(causes, row.event);
  });
  const newestLifecycle = () => [...tail.events].reverse().find(row => physicalLine([row], 0) <= tail.completeLineCount
    && ["run-start", "run-resume", "run-end"].includes(row.event));
  const wake = (cause: Wake["cause"], line: number): Wake => {
    cursor.after = line;
    cursor.initial = false;
    return { cause, line };
  };
  for (;;) {
    tail.read();
    cursor.after ??= tail.completeLineCount;
    const first = qualifying();
    if (first) return wake(causes[first.event] as Wake["cause"], physicalLine([first], 0));
    const lifecycle = newestLifecycle();
    if (cursor.initial !== false && lifecycle?.event === "run-end") return wake("run-end", physicalLine([lifecycle], 0));
    if (lifecycle?.event !== "run-end" && daemonLiveness(tail.events).state === "dead") {
      // A dying daemon can append after the tick's stat. Never decide from that stale batch.
      tail.read();
      const final = qualifying();
      if (final) return wake(causes[final.event] as Wake["cause"], physicalLine([final], 0));
      const settledLifecycle = newestLifecycle();
      if (settledLifecycle?.event === "run-end") return wake("run-end", physicalLine([settledLifecycle], 0));
      if (settledLifecycle !== lifecycle) continue;
      return wake("daemon-death", tail.line);
    }
    cursor.after = tail.completeLineCount;
    cursor.initial = false;
    return undefined;
  }
}

/** Use the status authorities on the cursor's observation, without reopening or reparsing its journal. */
function snapshot(cwd: string, runId: string, tail: JournalTail, observedAt: number): StatusSnapshot {
  const graph = loadGraph(cwd);
  const events = effectiveEvents(tail.events);
  const daemon = daemonLiveness(events).state;
  const source = join(cwd, stateDirName(cwd), "runs", runId, "journal.jsonl");
  const basis = createHash("sha256").update(tail.raw).digest("hex");
  const readable = tail.events.length === tail.raw.split("\n").filter(line => line.trim()).length;
  const fold = currentOwed(events, cwd);
  const operator = readOperatorState({
    events: events.map((event, index) => {
      const line = physicalLine(events, index);
      return { event, source, line, id: `${source}#L${line}` };
    }), graph, source, sequence: tail.line, observedAt, readable, daemonDead: daemon === "dead",
    owed: { basis, fold }, basis,
  });
  const states = new Map(operator.tasks.map(task => [task.id, task]));
  // Match readRunRecord's engagement inputs, including the newest rehash audit.
  // The exported status projection owns task states, phases and dependency blockers.
  const comparable = engagementComparable(tail.events, graphDefinitionHash(graph)).comparable;
  let rehashAt: number | undefined;
  if (comparable) for (let i = tail.events.length - 1; i >= 0; i--) {
    if (tail.events[i]!.event === "graph-rehash") { rehashAt = i; break; }
  }
  const { summaries } = recordProjection({ runId, raw: tail.raw, events: tail.events, comparable,
    ...(rehashAt === undefined ? {} : { rehashAt }) }, graph, () => daemon !== "dead");
  const decisions = graph.tasks.flatMap(task => {
    const park = states.get(task.id)?.state === "human" ? newestPark(events, task.id) : undefined;
    return park ? [{ taskId: task.id, park, verbs: permittedDecisionVerbs(park), ...decisionCommands(runId, task.id, park) }] : [];
  });
  const parks = decisions.map(({ taskId, park, commands, noDecision }) => ({
    taskId, kind: park.kind ?? null, reason: park.reason ?? null, token: parkToken(park) ?? null,
    commands: [...commands], noDecision,
  }));
  let approvalWindow: StatusSnapshot["approvalWindow"] = null;
  for (const row of events) {
    if (row.event === "approval-window-start") {
      const ms = row.data.windowMs;
      const opens = Date.parse(row.ts);
      approvalWindow = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && Number.isFinite(opens)
        && Array.isArray(row.data.parked) && row.data.parked.every(id => typeof id === "string")
        ? { opensAt: row.ts, closesAt: new Date(opens + ms).toISOString(), parked: row.data.parked } : null;
    } else if (["approval-window-expired", "task-approved", "task-dispatch", "run-end", "run-start", "run-resume"].includes(row.event)) approvalWindow = null;
  }
  const last = (own: JournalEvent[], name: string) => [...own].reverse().find(row => row.event === name);
  return StatusSnapshotSchema.parse({
    version: 1, runId, sequence: tail.line, observedAt: new Date(observedAt).toISOString(), daemon, lifecycle: operator.lifecycle,
    verdict: {
      green: operator.green, fatal: fatalRunEndCause(events) !== undefined, currentTip: operator.currentTip,
      buckets: Object.fromEntries(Object.entries(operator.buckets).map(([key, ids]) => [key, ids ?? null])),
      outstanding: !readable ? { known: false, reason: "complete journal holds an invalid line" }
        : operator.debt === "unknown" ? { known: false, reason: fold.unknown.map(item => item.reason).join("; ") || "current owed checks unknown" }
          : { known: true, debt: operator.debt, checks: operator.outstanding },
    }, approvalWindow, parks,
    tasks: graph.tasks.map(task => {
      const own = events.filter(row => row.taskId === task.id);
      const dispatch = last(own, "task-dispatch");
      const repair = last(own, "repair-attempt");
      const assignment = dispatch?.data.assignment as Record<string, unknown> | undefined;
      const acceptance = [...own].reverse().find(row => row.event === "gate-result" && row.data.gate === "acceptance");
      const invocations = acceptance?.data.invocations;
      const judge = Array.isArray(invocations) ? invocations.at(-1)?.channel : undefined;
      const reviewer = [...own].reverse().find(row => row.event === "gate-result" && row.data.gate === "review")?.data.reviewer;
      const summary = summaries.get(task.id)!;
      return {
        id: task.id, title: task.title, deps: task.deps, state: states.get(task.id)?.state ?? "unknown",
        gates: Object.fromEntries(GATE_NAMES.map(name => [name, states.get(task.id)?.gates[name]?.state ?? "unknown"])),
        tries: { round: Number.isInteger(dispatch?.data.attempt) ? Number(dispatch!.data.attempt) + 1 : null,
          budget: Number.isInteger(repair?.data.of) ? Number(repair!.data.of) + 1 : 3,
          launches: own.filter(row => row.event === "worker-launch").length },
        seats: { worker: typeof assignment?.adapter === "string" && typeof assignment.model === "string" ? `${assignment.adapter}:${assignment.model}` : null,
          judge: typeof judge === "string" ? judge : null, reviewer: typeof reviewer === "string" ? reviewer : null },
        startedAt: own.find(row => row.event === "task-dispatch")?.ts ?? null, endedAt: last(own, "merge")?.ts ?? null,
        now: { phase: summary.phase, since: summary.lastEvidenceAt, blocker: summary.blocker?.kind ?? null, nextAction: summary.blocker?.nextAction ?? null },
      };
    }),
  });
}

export async function wait(argv: string[], cwd = process.cwd(), opts: WaitOpts = {}): Promise<{ out: string; code: number }> {
  if (hasHelpFlag(argv)) return { out: commandHelp("wait"), code: 0 };
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    after: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" },
  } });
  if (positionals.length > 1) throw new Error("expected at most one run id");
  const after = values.after === undefined ? undefined : Number(values.after);
  if (values.after !== undefined && (!/^\d+$/u.test(values.after) || !Number.isSafeInteger(after))) throw new Error("--after requires a nonnegative journal line");
  let timeout = Infinity;
  if (values.timeout !== undefined) {
    const match = /^(\d+)([smh])$/u.exec(values.timeout);
    if (!match) throw new Error("--timeout requires a duration such as 30s, 5m or 1h");
    timeout = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[match[2]!]!);
    if (!Number.isSafeInteger(timeout)) throw new Error("--timeout is too large");
  }
  const now = opts.now ?? Date.now;
  const deadline = now() + timeout;
  const owner = positionals.length ? undefined : runLockOwner(cwd);
  const selected = positionals[0] ?? (owner?.live ? owner.runId : undefined);
  if (!selected) return { out: "tickmarkr wait: no live run holds the graph lock", code: 7 };
  const runId = parseRunId(selected);
  const path = join(cwd, stateDirName(cwd), "runs", runId, "journal.jsonl");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const tail = new JournalTail(path, fd);
    const finish = (cause: Cause, line: number) => {
      const state = snapshot(cwd, runId, tail, now());
      const verdict = state.verdict;
      return { code: EXIT[cause], out: values.json ? JSON.stringify({ cause, line, snapshot: state }) : [
        `tickmarkr wait ${runId}: ${cause} at journal line ${line}`,
        `green ${verdict.green}; fatal ${verdict.fatal}; current tip ${verdict.currentTip}`,
        ...Object.entries(verdict.buckets).map(([name, ids]) => `${name}: ${ids === null ? "unknown" : ids.length ? ids.join(", ") : "0"}`),
        `outstanding: ${verdict.outstanding.known ? verdict.outstanding.debt : `unknown (${verdict.outstanding.reason})`}`,
        ...state.parks.flatMap(park => [`park ${park.taskId}: ${park.kind ?? "unknown"}${park.reason ? ` — ${park.reason}` : ""}`,
          ...park.commands.map(command => command.command), ...(park.noDecision ? [park.noDecision] : [])]),
      ].map(visibleControls).join("\n") };
    };
    const cursor: WakeCursor = { after };
    for (;;) {
      const wake = classifyWake(tail, cursor);
      if (wake) return finish(wake.cause, wake.line);
      if (now() >= deadline) return finish("timeout", tail.line);
      await (opts.sleep ?? sleep)(1000);
    }
  } finally { closeSync(fd); }
}
