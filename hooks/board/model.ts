import type { BoardProps } from "./board";
import type { BoardState, RunSnapshot } from "./state";

/**
 * The board's model and lifecycle (queue rows 280, 331 and 332). Pure but for its plain-function deps: nothing here
 * imports claude-code or src/board at runtime, so every rule is tested under Vitest with fixed wire fixtures.
 */

/**
 * queue row 281: display text for a snapshot string (park reasons carry model text). Every C0 control but tab and
 * newline, DEL and every C1 control shows as its visible escape, as the CLI's visibleControls does, so no OSC or CSI
 * sequence reaches a terminal. The state keeps the raw bytes, so Copy still copies the exact command.
 */
export const visible = (text: unknown): string => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => {
  const code = c.charCodeAt(0);
  return `\\${code < 0x80 ? "x" : "u"}${code.toString(16).padStart(code < 0x80 ? 2 : 4, "0")}`;
});

/** A deep copy of the snapshot with every nested string through `visible`: what the board, keys and Copy posts see. */
export const shown = (snapshot: RunSnapshot): RunSnapshot => deep(snapshot) as RunSnapshot;
const deep = (value: unknown): unknown => typeof value === "string" ? visible(value)
  : Array.isArray(value) ? value.map(deep)
  : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)]))
  : value;

/** The manifest's comma lists (stateRoots, releaseRoots) as `tickmarkr board` flags: trimmed, blanks dropped. */
export function boardArgs(options: { stateRoots?: unknown; releaseRoots?: unknown } | undefined): string[] {
  const list = (value: unknown): string[] =>
    (Array.isArray(value) ? value.map(String) : String(value ?? "").split(",")).map(entry => entry.trim()).filter(Boolean);
  return [...list(options?.stateRoots).flatMap(root => ["--root", root]),
    ...list(options?.releaseRoots).flatMap(release => ["--release", release])];
}

/** What one `tickmarkr board --json` run gave: the process result, or the rejection of the run itself. */
export type BoardRun = { exitCode: number; stdout: string; stderr?: string; isStdoutTruncated?: boolean } | { rejected: unknown };
export const NEEDS_VERSION = "the board needs tickmarkr 2.19.0 or later";

/** Exactly one of snapshot, empty and error; every read is a whole replacement, so no previous verdict survives. */
export function parseBoard(ran: BoardRun): BoardState {
  const error = (text: string): BoardState => ({ snapshot: null, empty: null, error: visible(text) });
  if ("rejected" in ran) {
    const why = ran.rejected instanceof Error ? ran.rejected.message : String(ran.rejected);
    return error(why.trim() ? why : "the board read was rejected");
  }
  if (ran.exitCode !== 0) {
    const last = String(ran.stderr ?? "").split("\n").map(line => line.trim()).filter(Boolean).pop();
    return error(last ?? `tickmarkr board exited ${ran.exitCode}; install tickmarkr 2.19.0 or later`);
  }
  if (ran.isStdoutTruncated === true) return error("tickmarkr board output was cut short");
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch (thrown) {
    return error(`tickmarkr board printed malformed JSON: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  if (!isRecord(parsed)) return error("tickmarkr board printed a misshapen answer");
  if (parsed.version !== 1) return error(NEEDS_VERSION);
  if ("empty" in parsed) {
    return Object.keys(parsed).length === 2 && typeof parsed.empty === "string"
      ? { snapshot: null, empty: parsed.empty, error: null } : error("tickmarkr board printed a misshapen empty answer");
  }
  return SNAPSHOT(parsed) ? { snapshot: parsed as RunSnapshot, empty: null, error: null }
    : error("tickmarkr board printed a misshapen snapshot");
}

// The shape checks: each field the board reads, with the type the wire contract gives it.
type Check = (value: unknown) => boolean;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str: Check = value => typeof value === "string";
const num: Check = value => typeof value === "number" && Number.isFinite(value);
const bool: Check = value => typeof value === "boolean";
const nullable = (check: Check): Check => value => value === null || check(value);
const list = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const oneOf = (...allowed: unknown[]): Check => value => allowed.includes(value);
const shape = (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check => value =>
  isRecord(value) && Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
  && Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
const strs = list(str);
const PART = shape({ text: str, tone: oneOf("pass", "fail", "wait", "open") }, { reason: str, since: num });
const TASK = shape({
  id: str, title: str, state: oneOf("pending", "worker", "waiting", "gates", "parked", "done", "failed"),
  attempt: num, dispatched: bool, budget: num, launches: num,
  gates: value => isRecord(value) && Object.values(value).every(oneOf("pass", "fail")),
  note: str, deps: strs, blocks: strs, worker: str, judge: str, reviewer: str, suiteWaiting: bool, now: str,
  nowSince: nullable(num), history: list(shape({ att: num, start: str, parts: list(PART) })),
  startEpoch: nullable(num), endEpoch: nullable(num), startedAt: str, endedAt: str,
  tokens: nullable(shape({ input: num, output: num, cacheRead: num })),
});
const RELEASE = shape({
  version: str, dir: str, ciRun: nullable(str), mirror: nullable(str), status: str, conclusion: str, polledAt: str,
  stages: list(shape({ name: str, state: oneOf("pending", "running", "done", "failed"), detail: str })),
});
const SNAPSHOT = shape({
  version: oneOf(1), runId: str, alive: nullable(bool), pid: nullable(num), elapsedMin: num,
  ended: nullable(shape({
    done: strs, failed: strs, human: strs, blocked: strs, pending: strs, tipVerify: nullable(str), owed: nullable(num),
  })),
  tasks: list(TASK),
  needsYou: list(shape({ task: str, kind: str, reason: str, since: num, blocks: strs, cmd: str })),
  approvalWindow: nullable(shape({ closesAt: num, parked: strs })),
  eta: nullable(shape({ cleanMin: num, oneRepairMin: num, criticalPath: strs, stoppedBy: strs })),
  atEpoch: num, startEpoch: nullable(num), endEpoch: nullable(num), readAt: str, release: nullable(RELEASE),
  spec: nullable(str),
});

/**
 * The raw command a Copy press may copy: the board shows (and so posts) `visible(cmd)`, which two raw commands can
 * share (a literal `\x1b` and the ESC byte), so only a post naming exactly one distinct raw cmd of the current snapshot
 * copies; an ambiguous, stale or non-string post copies nothing.
 */
export function copyTarget(snapshot: RunSnapshot | null, posted: unknown): string | undefined {
  if (snapshot === null || typeof posted !== "string") return undefined;
  const matches = new Set(snapshot.needsYou.map(need => need.cmd).filter(cmd => visible(cmd) === posted));
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** The reference register's status line, through `visible`. */
export function boardStatusLine(s: RunSnapshot): string {
  const done = s.tasks.filter(t => t.state === "done").length;
  const busy = s.tasks.filter(t => t.state !== "done" && t.state !== "pending").map(t => `${t.id} ${t.state}`);
  const life = s.ended ? "ended" : s.alive ? "live" : "daemon down";
  const needs = s.needsYou.length ? ` · NEEDS YOU ${s.needsYou.map(n => n.task).join(", ")}` : "";
  const ci = s.release?.stages.find(g => g.name === "CI");
  const rel = s.release ? ` · ${s.release.version} CI ${ci?.state === "done" ? "green" : ci?.state ?? "?"}` : "";
  return visible(`tkr ${s.runId.slice(-4)} ${life} · ${done}/${s.tasks.length} done${needs}${busy.length ? " · " + busy.join(", ") : ""}${rel}`);
}

export const EMPTY_HEAD = "No tickmarkr runs found.";
export const EMPTY_TAIL = "Compile a spec and review its plan, then run tickmarkr run. This board refreshes every 5 seconds.";
export const WAITING = "Waiting for the first read of the run…";
const EMPTY_PREFIX = "no tickmarkr run under ";

/** What the pane draws: the board over the shown snapshot, or one block of visible text. */
export type BoardView = { props: BoardProps } | { text: string };
export function view(state: BoardState, marks: "glyph" | "devicons" = "glyph", fit?: number): BoardView {
  if (state.snapshot !== null) {
    return { props: { snap: shown(state.snapshot), error: null, marks, ...(fit === undefined ? {} : { fit }) } };
  }
  if (state.empty !== null) {
    const roots = state.empty.startsWith(EMPTY_PREFIX) ? state.empty.slice(EMPTY_PREFIX.length) : state.empty;
    return { text: [EMPTY_HEAD, `Searched ${visible(roots)}`, EMPTY_TAIL].join("\n") };
  }
  return { text: visible(state.error ?? WAITING) };
}

/** The lifecycle's host, as plain functions: register.tsx maps each onto `$`. */
export type BoardDeps = {
  /** the session's folder, read at each use */
  cwd: () => Promise<string>;
  /** whether the path is a directory; a rejection reads as false */
  isDirectory: (path: string) => Promise<boolean>;
  /** runs the argv in the folder (no shell) */
  run: (argv: readonly string[], cwd: string) => Promise<Exclude<BoardRun, { rejected: unknown }>>;
  /** opens the board pane without asking for focus; resolves whether the surface placed it */
  open: () => Promise<boolean>;
  /** pins the status line; undefined clears it */
  status: (text: string | undefined) => void;
  /** a repeating timer; returns its cancel */
  every: (ms: number, tick: () => void) => () => void;
  /** replaces the whole board state */
  publish: (state: BoardState) => Promise<void>;
  /** boardArgs(options) */
  args?: readonly string[];
};
export const POLL_MS = 5000;
export const READY_HINT = "Run board ready — /tickmarkr-board opens it";

/**
 * queue row 280: a session opens the board by itself only where its own folder holds tickmarkr state, so a session
 * anywhere else never polls. One timer and one in-flight read serve start, the command and the poll; end() bumps the
 * session generation, which every publication, status and pane effect checks first, so a late read lands nowhere.
 */
export function boardController(deps: BoardDeps) {
  let session = 0;
  let cancel: (() => void) | undefined;
  let reading: Promise<void> | undefined;

  /** The session folder when its own `.tickmarkr` is a directory; undefined otherwise, a rejected check included. */
  const eligible = async (): Promise<string | undefined> => {
    try {
      const cwd = await deps.cwd();
      return (await deps.isDirectory(`${cwd.replace(/\/+$/, "")}/.tickmarkr`)) === true ? cwd : undefined;
    } catch {
      return undefined;
    }
  };

  /** One read at a time. `checked` binds an automatic read to the folder whose `.tickmarkr` was just checked. */
  const refresh = (checked?: string): Promise<void> => {
    if (reading) return reading;
    const live = session;
    const read: Promise<void> = (async () => {
      let state: BoardState;
      try {
        const cwd = checked ?? await deps.cwd();
        state = parseBoard(await deps.run(["tickmarkr", "board", "--json", ...(deps.args ?? [])], cwd));
      } catch (rejected) {
        state = parseBoard({ rejected });
      }
      if (live !== session) return;
      await deps.publish(state);
      if (live !== session) return;
      // an empty or failed read clears the status line, as the published state cleared Copy
      deps.status(state.snapshot ? boardStatusLine(shown(state.snapshot)) : undefined);
    })().finally(() => { if (reading === read) reading = undefined; });
    reading = read;
    return read;
  };

  const stopPolling = (): void => {
    cancel?.();
    cancel = undefined;
  };

  // Every automatic refresh, after start and after the command alike, rechecks the session folder and reads only in the
  // folder it checked; polling stops once that `.tickmarkr` is gone. Only the command's own refresh is unconditional.
  const tick = async (): Promise<void> => {
    const live = session;
    const cwd = await eligible();
    if (live !== session) return;
    if (cwd === undefined) stopPolling();
    else await refresh(cwd);
  };
  const poll = (): void => {
    cancel ??= deps.every(POLL_MS, () => { void tick().catch(() => undefined); });
  };

  return {
    /** session.start: autoload only in an interactive session whose own folder holds a `.tickmarkr` directory */
    async start(interactive: boolean): Promise<void> {
      if (!interactive) return;
      const live = session;
      const cwd = await eligible();
      if (cwd === undefined || live !== session) return;
      await refresh(cwd);
      if (live !== session) return;
      const placed = await deps.open();
      if (live !== session) return;
      // an unasked pane waits undrawn on a narrow terminal: point at the command instead of polling an unseen board
      if (placed) poll();
      else deps.status(READY_HINT);
    },
    /** /tickmarkr-board: its own refresh has no autoload condition; the one timer it keeps rechecks the folder per tick */
    async command(): Promise<void> {
      const live = session;
      poll();
      await refresh();
      if (live !== session) return;
      await deps.open();
    },
    /** session.end: cancel the timer and invalidate every pending effect */
    end(): void {
      session += 1;
      reading = undefined;
      stopPolling();
    },
  };
}
