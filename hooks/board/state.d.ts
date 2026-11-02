/**
 * Wire contract version 1 of `tickmarkr board --json` (queue rows 331 and 332): exactly one of a full snapshot or the
 * empty answer. The run types are the reference board's own (tests/fixtures/board/reference/types.d.ts); no repository
 * runtime imports.
 */
export type GateMark = "pass" | "fail";
/**
 * One phase of one attempt, as the attempt history draws it: the words, how they read, the red reason apart (drawn
 * last), and for a running phase `{since}` in the words with the epoch seconds it ticks from.
 */
export type AttemptPart = { text: string; tone: "pass" | "fail" | "wait" | "open"; reason?: string; since?: number };
export type AttemptLine = { att: number; start: string; parts: AttemptPart[] };
export type TaskRow = {
  id: string;
  title: string;
  state: "pending" | "worker" | "waiting" | "gates" | "parked" | "done" | "failed";
  /** the journal's 0-based dispatch attempt; people count from one */
  attempt: number;
  /** dispatched at least once (an undispatched task's attempt 0 is no attempt) */
  dispatched: boolean;
  /** attempts the task may take: one fresh plus the funded repairs */
  budget: number;
  /** every worker the run started for this task, across resumes and upheld rounds (attempt restarts each round) */
  launches: number;
  gates: Record<string, GateMark>;
  note: string;
  deps: string[];
  /** every task downstream of this one (graph.json deps, transitive) */
  blocks: string[];
  /** adapter:model of the latest dispatch, the judge seat and the reviewer seat ('' until known) */
  worker: string;
  judge: string;
  reviewer: string;
  /** queued behind another task's full suite (suite-wait without an admission yet) */
  suiteWaiting: boolean;
  /** what the task is doing, for how long ({since}), against the typical time */
  now: string;
  /** epoch seconds the now-sentence's {since} counts from; null when it has none */
  nowSince: number | null;
  /** one line per attempt, oldest first */
  history: AttemptLine[];
  /** epoch seconds of the first dispatch and of the merge (null until each happens) */
  startEpoch: number | null;
  endEpoch: number | null;
  /** the same in local wall-clock text: `2026-10-24 02:07:37` and `02:37` ('' until known) */
  startedAt: string;
  endedAt: string;
  /** worker usage, credited once the task is done (telemetry rows carry no time) */
  tokens: { input: number; output: number; cacheRead: number } | null;
};
export type NeedsYou = { task: string; kind: string; reason: string; since: number; blocks: string[]; cmd: string };
/** One step of the release chain as the card draws it: CI, the tag, npm, private main. */
export type ReleaseStage = { name: string; state: "pending" | "running" | "done" | "failed"; detail: string };
/** The release card: the chosen release folder's last CI run and the stage files beside it. */
export type ReleaseSnapshot = {
  version: string;
  dir: string;
  ciRun: string | null;
  mirror: string | null;
  status: string;
  conclusion: string;
  /** local wall-clock time of the watcher's last poll ('' before the first) */
  polledAt: string;
  stages: ReleaseStage[];
};
/** The full snapshot of wire version 1: `readAt` and `release` are always present. */
export type RunSnapshot = {
  version: 1;
  runId: string;
  alive: boolean | null;
  pid: number | null;
  elapsedMin: number;
  ended: { done: string[]; failed: string[]; human: string[]; blocked: string[]; pending: string[]; tipVerify: string | null; owed: number | null } | null;
  tasks: TaskRow[];
  needsYou: NeedsYou[];
  /** the open approval window: epoch seconds it closes at; the run ends PARTIAL when it lapses */
  approvalWindow: { closesAt: number; parked: string[] } | null;
  /** minutes left for a clean pass and with one repair round per task; null once the run ended */
  eta: { cleanMin: number; oneRepairMin: number; criticalPath: string[]; stoppedBy: string[] } | null;
  /** epoch seconds the snapshot describes (the run's end once it ended) */
  atEpoch: number;
  startEpoch: number | null;
  endEpoch: number | null;
  /** local `HH:MM:SS` of the read */
  readAt: string;
  /** null when no release folder is configured or holds a file */
  release: ReleaseSnapshot | null;
  /** the spec the run builds: its graph's first spec file name without `.spec.md`; null when the graph names none (queue row 335) */
  spec: string | null;
};
/** The empty answer of wire version 1: `no tickmarkr run under <roots>`, with no other field. */
export type EmptyBoard = { version: 1; empty: string };
export type BoardWire = RunSnapshot | EmptyBoard;

/** Exactly one of the three is non-null once a read has landed; all three are null before the first. */
export type BoardState = { snapshot: RunSnapshot | null; empty: string | null; error: string | null };

declare module "claude-code" {
  interface PluginState {
    /** one host write replaces the whole board state */
    tickmarkr: { runBoard: BoardState };
  }
}
