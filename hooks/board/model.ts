import type { BoardProps } from "./board";
import type { BoardState, RunSnapshot } from "./state";

/**
 * The board's model and lifecycle (queue rows 280, 331, 332 and 343). Pure but for its plain-function deps: nothing
 * here imports claude-code or src/board at runtime, so every rule is tested under Vitest with fixed wire fixtures.
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
  /** whether the path is a directory. A throw is a rejected check (B7, D-2184); false means it is not a directory. */
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
/** B7 (D-2184): an automatic tick replaces a read that has stayed in flight for this many polls (60 s at POLL_MS). */
const STALE_READ_TICKS = 12;

/**
 * queue row 280: a session opens the board by itself only where its own folder holds tickmarkr state, so a session
 * anywhere else never polls. Queue row 343 (D-2180): it reads first and opens only a run that has not ended, once per
 * run id this session, and keeps that one poll while the pane stays closed. B7 (D-2184): the command leaves exactly
 * one armed timer — a stopped poll is armed again, an armed poll stays that subscription — and starts a fresh read.
 * A read in flight for 12 automatic ticks is replaced. Those ticks are counted when they start and stay bound to
 * the read then in flight, rejected checks included. Newest wins: only the most recently started read publishes,
 * sets the status line or feeds autoOpen, so a placement that resolves after a newer empty or failed read does not
 * restore the ready hint. end() bumps the session generation, which every publication, status and pane effect
 * checks first, so a late read lands nowhere.
 */
export function boardController(deps: BoardDeps) {
  let session = 0;
  let cancel: (() => void) | undefined;
  let timerGen = 0;
  let reading: Promise<number> | undefined;
  /** Identity of the most recently started read. An older read that settles later loses to it (B7, D-2184). */
  let current = 0;
  let readSeq = 0;
  /**
   * Automatic ticks already counted against the current read. The count is taken when the tick starts and bound to
   * the read in flight then, so a rejected check ages that read and a late probe cannot age a newer one.
   */
  let flight = 0;
  let latest: BoardState | undefined;
  /** Run ids successfully placed this session, by an automatic open or by a command that displayed a snapshot. */
  const opened = new Set<string>();
  /** One automatic placement at a time. A narrow miss does not enter `opened`, so the next poll may try again. */
  let placing = false;
  let placeGen = 0;

  /**
   * The session folder when its own `.tickmarkr` is a directory. `rejected` is a thrown check, distinct from an
   * answer that the path is not a directory (B7, D-2184).
   */
  const probe = async (): Promise<{ ok: true; cwd: string } | { ok: false; rejected: boolean }> => {
    try {
      const cwd = await deps.cwd();
      const dir = await deps.isDirectory(`${cwd.replace(/\/+$/, "")}/.tickmarkr`);
      return dir === true ? { ok: true, cwd } : { ok: false, rejected: false };
    } catch {
      return { ok: false, rejected: true };
    }
  };

  /**
   * `checked` binds an automatic read to the folder whose `.tickmarkr` was just checked. `force` starts a fresh
   * read even when one is in flight (the command, or a read held for STALE_READ_TICKS).
   * B7 (D-2184), newest wins: only the most recently started read publishes, sets the status line or feeds
   * autoOpen. An older read that settles later has no effect.
   */
  const refresh = (checked: string | undefined, force: boolean): Promise<number> => {
    if (reading && !force) return reading;
    const live = session;
    const mine = ++readSeq;
    current = mine;
    flight = 0;
    const read: Promise<number> = (async () => {
      let state: BoardState;
      try {
        const cwd = checked ?? await deps.cwd();
        state = parseBoard(await deps.run(["tickmarkr", "board", "--json", ...(deps.args ?? [])], cwd));
      } catch (rejected) {
        state = parseBoard({ rejected });
      }
      if (live !== session || mine !== current) return mine;
      latest = state;
      await deps.publish(state);
      if (live !== session || mine !== current) return mine;
      // an empty or failed read clears the status line, as the published state cleared Copy
      deps.status(state.snapshot ? boardStatusLine(shown(state.snapshot)) : undefined);
      return mine;
    })().finally(() => { if (reading === read) reading = undefined; });
    reading = read;
    return read;
  };

  const stopPolling = (): void => {
    timerGen += 1;
    const stop = cancel;
    cancel = undefined;
    stop?.();
  };
  const arm = (): void => {
    const generation = ++timerGen;
    cancel = deps.every(POLL_MS, () => {
      if (generation !== timerGen) return;
      void tick().catch(() => undefined);
    });
  };
  /** Exactly one subscription (B7, D-2184). A stopped poll is armed again. An armed poll stays that subscription. */
  const poll = (): void => {
    if (cancel) return;
    arm();
  };

  // Automatic placement only. The decision uses the snapshot just published — never a second read. Daemon liveness
  // is not an input: an unfinished run opens once whether the daemon is alive, down or unknown. A false placement
  // keeps the ready hint and leaves the id unlatched. Concurrent completions share this gate, so two of them cannot
  // open the same id, and a miss cannot become a latch.
  const autoOpen = async (live: number, mine: number): Promise<void> => {
    if (live !== session || mine !== current || placing) return;
    const snap = latest?.snapshot ?? null;
    if (snap === null || snap.ended !== null || opened.has(snap.runId)) return;
    const runId = snap.runId;
    placing = true;
    const gen = placeGen;
    try {
      const placed = await deps.open();
      if (live !== session) return;
      // A successful placement still latches, including when a newer read began while the pane request was open.
      if (placed) {
        opened.add(runId);
        return;
      }
      if (opened.has(runId)) return;
      // Contract C's newest-wins status rule applies even when the newer read is still pending or shows the same run.
      if (mine !== current) return;
      deps.status(READY_HINT);
    } finally {
      if (placeGen === gen) placing = false;
    }
  };

  // Every automatic refresh, after start and after the command alike, rechecks the session folder and reads only in the
  // folder it checked. B7 (D-2184): a rejected folder check (a throw) keeps polling and this tick reads nothing; a
  // check that answers not-a-directory stops polling, including when `.tickmarkr` is gone. The tick's age is measured
  // before that check and bound to the read already in flight, so rejected ticks count toward STALE_READ_TICKS and a
  // probe that resolves after a newer read has started does not age the newer one. Only the command's own refresh is
  // unconditional. A read in flight for fewer than STALE_READ_TICKS ticks is shared; the 12th eligible one replaces it.
  const tick = async (): Promise<void> => {
    const live = session;
    const agedRead = reading === undefined ? undefined : current;
    const agedFlight = agedRead === undefined ? flight : flight + 1;
    if (agedRead !== undefined) flight = agedFlight;
    const found = await probe();
    if (live !== session) return;
    if (!found.ok) {
      if (!found.rejected) stopPolling();
      return;
    }
    const replace = agedRead !== undefined && agedRead === current && reading !== undefined
      && agedFlight >= STALE_READ_TICKS;
    const mine = await refresh(found.cwd, replace);
    if (live !== session || mine !== current) return;
    await autoOpen(live, mine);
  };

  return {
    /** session.start: read an eligible interactive folder, then open only an unfinished run. The poll stays either way. */
    async start(interactive: boolean): Promise<void> {
      if (!interactive) return;
      const live = session;
      const found = await probe();
      // A rejected, missing or not-a-directory check still has no board effect (B7).
      if (!found.ok || live !== session) return;
      const mine = await refresh(found.cwd, false);
      if (live !== session || mine !== current) return;
      // An ended, empty, failed or still-unplaced read keeps watching the folder. The open itself is one cheap
      // placement request per poll, not another read.
      poll();
      await autoOpen(live, mine);
    },
    /** /tickmarkr-board: exactly one armed timer, a fresh read, and a placed snapshot's run id counts as opened. */
    async command(): Promise<void> {
      const live = session;
      poll();
      const mine = await refresh(undefined, true);
      if (live !== session || mine !== current) return;
      const snap = latest?.snapshot ?? null;
      const placed = await deps.open();
      if (live !== session || mine !== current) return;
      // An empty or failed display has no run id. A false placement records none, so a later poll may still open.
      if (placed && snap !== null) opened.add(snap.runId);
    },
    /** session.end: cancel the timer, drop this session's autoload memory, and invalidate every pending effect. */
    end(): void {
      session += 1;
      current = ++readSeq;
      placeGen += 1;
      placing = false;
      reading = undefined;
      latest = undefined;
      flight = 0;
      opened.clear();
      stopPolling();
    },
  };
}
