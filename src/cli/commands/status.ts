import { BANNER, GLYPHS, type Verdict, dim, fail, legend, ok, rule, statusRow, title, warn } from "../../brand.js";
import { blockedTasks, graphDefinitionHash, loadGraph, pendingTasks } from "../../graph/graph.js";
import { GATE_NAMES, type RunGraph, type Task, type TaskStatus } from "../../graph/schema.js";
import { Journal, type JournalEvent, engagementComparable } from "../../run/journal.js";

// ponytail: fixed 2s refresh; promote to config.visibility.* only when an operator asks.
const REFRESH_MS = 2000;
const NOT_COMPARABLE_NOTICE = "graph recompiled since this run — task states not comparable; run `tickmarkr run` to execute";

// The timer must keep the process ALIVE: an unref'd timer here let the event loop drain after the
// first frame, so a live `--watch` printed once and exited 0 (OBS-11). Never unref this.
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type StatusOpts = {
  iterations?: number;
  sleep?: (ms: number) => Promise<void>;
};

const GATE_KEYS = { build: "B", test: "T", lint: "L", evidence: "E", scope: "S", acceptance: "A", review: "R" } as const;

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
const taskBox = (status: TaskStatus): string => {
  if (status === "done") return "[x]";
  if (status === "failed" || status === "human") return "[!]";
  return "[ ]";
};

const gateBox = (state: "open" | "pass" | "fail" | "skip", unicode: boolean): string => {
  if (unicode) {
    // shared glyph vocabulary: pass/fail verdicts, dash for skip, dim circle for not-yet-run
    return state === "pass" ? GLYPHS.pass : state === "fail" ? GLYPHS.fail : state === "skip" ? GLYPHS.neutral : GLYPHS.toggleInactive;
  }
  return state === "pass" ? "[x]" : state === "fail" ? "[!]" : state === "skip" ? "." : "[ ]";
};

type GateState = "open" | "pass" | "fail" | "skip";

const defaultGateStates = (task: Task): GateState[] =>
  GATE_NAMES.map((gate) => task.gates.includes(gate) ? "open" : "skip");

const gateStates = (task: Task, events: JournalEvent[]): GateState[] => {
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

const gateChain = (states: GateState[], unicode: boolean): string =>
  GATE_NAMES.map((gate, i) => {
    const chip = `${GATE_KEYS[gate]}${gateBox(states[i]!, unicode)}`;
    return unicode ? GATE_STATE_TOKEN[states[i]!](chip) : chip;
  }).join(" ");

// plain (uncolored) chip width for column math — ANSI codes have zero display width
const gateChainWidth = (unicode: boolean): number => GATE_NAMES.reduce((w, gate) => w + GATE_KEYS[gate].length + (unicode ? 1 : 3) + 1, -1);

const shortGoal = (goal: string, max: number): string => {
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

const liveness = (events: JournalEvent[]): string => {
  const last = events.at(-1);
  if (!last) return "last event unknown · daemon pid unknown";
  const age = fmtAge(Date.now() - Date.parse(last.ts));
  const pid = daemonPid(events);
  if (pid === undefined) return `last event ${age} ago · daemon pid unknown`;
  // a dead pid after run-end is a clean exit, not a crash — "dead" is only alarming (red) while
  // the run is still incomplete (operator's crash indicator)
  const ended = events.some((e) => e.event === "run-end");
  let state: string;
  try { process.kill(pid, 0); state = "alive"; } // no throw ⇒ alive
  catch (k) { state = (k as NodeJS.ErrnoException).code === "ESRCH" ? (ended ? "finished" : "dead") : "alive"; } // EPERM ⇒ alive
  return `last event ${age} ago · daemon pid ${pid} ${state}`;
};

const renderFrame = (cwd: string): string => {
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
  const waiting = new Set(pendingTasks(effective).map((t) => t.id));
  const unicode = visual();
  const divider = unicode ? " · " : " / ";
  const width = process.stdout.columns ?? 120;
  const done = effective.tasks.filter((t) => t.status === "done").length;

  const cells = g.tasks.map((t) => {
    const st = replayed?.get(t.id) ?? t.status;
    const label = starved.has(t.id) ? " starved" : waiting.has(t.id) ? " dep-waiting" : "";
    const channel = assignments.get(t.id) ?? "-";
    const assignCol = contexts.has(t.id) ? `${channel}${divider}ctx ${contexts.get(t.id)}` : channel;
    return { t, st, label, assignCol, states: comparable ? gateStates(t, events) : defaultGateStates(t) };
  });

  if (!unicode) {
    // machine/CI surface — layout unchanged (pipes, greps, and the golden pins depend on it)
    const rows = cells.map(({ t, st, label, assignCol, states }) => {
      const chain = gateChain(states, false);
      const prefix = `  ${taskBox(st)} ${t.id} `;
      const suffix = `  ${chain}  ${String(st)}${label}  ${assignCol}`;
      return `${prefix}${shortGoal(t.goal, Math.max(0, width - prefix.length - suffix.length))}${suffix}`;
    });
    const header = runId
      ? `tickmarkr status${divider}run ${runId}${supersededBy ? `${divider}superseded by ${supersededBy}` : ""}${!comparable ? `${divider}${NOT_COMPARABLE_NOTICE}` : ""}${divider}${liveness(events).replaceAll(" · ", divider)}${divider}${done}/${g.tasks.length} done`
      : `tickmarkr status${divider}no runs yet${divider}${done}/${g.tasks.length} done`;
    const legendLine = `  gates: ${GATE_NAMES.map((gate) => `${GATE_KEYS[gate]} ${gate}`).join(divider)}`;
    return [header, legendLine, ...rows].join("\n");
  }

  // TTY: cockpit frame composed through src/brand.ts (CLI-DESIGN.md) — dominant run title,
  // dim chrome, semantic color only on verdicts, completion gauge, and column-aligned status
  // rows (pad plain text FIRST, colorize after: ANSI has zero display width and would corrupt
  // padEnd math)
  const dot = dim(" · ");
  const anyFailed = cells.some((c) => c.st === "failed");
  const gaugeCells = 10;
  const fill = g.tasks.length ? Math.round((done / g.tasks.length) * gaugeCells) : 0;
  const gauge = (fill ? (anyFailed ? fail : ok)("█".repeat(fill)) : "") + (fill < gaugeCells ? dim("░".repeat(gaugeCells - fill)) : "");
  const live = liveness(events)
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
  const gatesLegend = legend(`   gates: ${GATE_NAMES.map((gate) => `${GATE_KEYS[gate]} ${gate}`).join(" · ")}`);

  const taskVerdict = (st: TaskStatus): Verdict =>
    st === "done" ? "pass" : st === "failed" ? "fail" : st === "human" ? "warn" : "neutral";
  const idW = Math.max(...cells.map((c) => c.t.id.length), 2);
  const stW = Math.max(...cells.map((c) => (String(c.st) + c.label).length));
  const chainW = gateChainWidth(true);
  const assignW = Math.max(...cells.map((c) => c.assignCol.length));
  const goalW = Math.max(8, width - (5 + idW) - 2 - chainW - 2 - stW - 2 - assignW);
  const rows = cells.map(({ t, st, label, assignCol, states }) => {
    const goal = shortGoal(t.goal, goalW).padEnd(goalW);
    const stWord = st === "done" ? ok(String(st)) : st === "failed" ? fail(String(st)) : st === "human" ? warn(String(st)) : String(st);
    const statusCell = stWord +
      (label ? (label === " starved" ? fail(label) : dim(label)) : "") +
      " ".repeat(stW - (String(st) + label).length);
    return `  ${statusRow(taskVerdict(st), `${t.id.padEnd(idW)} ${goal}  ${gateChain(states, true)}  ${statusCell}  ${dim(assignCol)}`)}`;
  });
  return [header, hr, gatesLegend, ...rows].join("\n");
};

export async function status(argv: string[], cwd = process.cwd(), opts: StatusOpts = {}): Promise<string> {
  // cockpit surface: banner + frame on a TTY (doctor's pattern); pipes get the bare frame
  if (!argv.includes("--watch")) return visual() ? BANNER + renderFrame(cwd) : renderFrame(cwd);

  const iterations = opts.iterations ?? Infinity;
  const sleep = opts.sleep ?? defaultSleep;
  const bounded = Number.isFinite(iterations);
  const frames: string[] = [];
  const sep = "\n---\n";
  const tty = visual();

  for (let i = 0; i < iterations; i++) {
    const frame = renderFrame(cwd);
    if (tty) process.stdout.write(`\x1b[2J\x1b[H${BANNER}${frame}\n${legend(` watching · refresh ${REFRESH_MS / 1000}s · ^C to quit`)}`);
    else process.stdout.write(frame + sep);
    if (bounded) frames.push(frame);
    if (i + 1 < iterations) await sleep(REFRESH_MS);
  }
  return bounded ? frames.join(sep) : "";
}
