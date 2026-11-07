import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { declaredInputBoxForWorkerName, matchesEmptyInputBox, matchesOccupiedInputBox, shq, type InputBox } from "../adapters/types.js";
import { stateDirName } from "../graph/graph.js";
import { createWorktree, shGit } from "../run/git.js";
import { trustedCommonDir } from "../run/git-trust.js";
import { isPidLive } from "../run/lock.js";
import { readSupervision, readWatchBoard, requestWatchBoardStop, reserveWatchBoard, stopWatchBoard, supervisionPresencePath, WATCH_OWNER_ENV, watchBoardAcknowledged, type WatchBoardOwner } from "../run/supervision.js";
import { ADDRESS_RE, HC_CALL_TIMEOUT_MS, HC_PLACEMENT_TIMEOUT_MS, HcClient, HcError, type AppLayout, type AppSplit, type HcList, type HcRead, type HcTerminal } from "./hc-client.js";
import { tabLabelFor } from "./herdr.js";
import { canonicalWorktreePath } from "./orca.js";
import { herdrSealShellPrefix, MAX_BUF, SubprocessDriver } from "./subprocess.js";
import { canonicalizeLegacyName, formatOwnedName, panesToClose, parseOwnedName, type ExecutorDriver, type NotificationPost, type NotifyOpts, type PanesToCloseOpts, type Slot, type SlotOpts, type TransportState } from "./types.js";

// Queue row 340; D-2180 — the Herdr app as an execution surface. Terminals are hc (herdr-core) terminals on the
// launcher's core; tickmarkr keeps worktrees, routing, gates, journal and merges. Ownership is two labels written at
// creation — tickmarkr.owner (the full owned name, decoded only by parseOwnedName) and tickmarkr.repo (the canonical
// git common directory) — plus the canonical checkout cwd and the core that answered. Every control call re-verifies
// that triple at the PINNED address on the same core first; a mismatch is unavailable, never a re-resolution by name.
// The initial command is the terminal's own argv (`bash -lc`), so there is no shell-readiness race and no paste; any
// later run is a TUI message to the pinned terminal, gated on readiness and confirmed by a read-back.

export const OWNER_LABEL = "tickmarkr.owner";
export const REPO_LABEL = "tickmarkr.repo";
/** The app's window labels: a terminal created carrying them is placed in that space (and tab) of the window. */
export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";
/** Roles that ride in their TASK's tab; anything else (scope drafts, other) gets a tab of its own. */
const TASK_ROLES = new Set(["worker", "judge", "review", "consult"]);
/** The CLOSED logical key set: anything else throws before any hc call. */
export const HC_KEYS: Readonly<Record<string, string>> = Object.freeze({ Enter: "enter", Down: "down", Up: "up", Esc: "esc", "ctrl+c": "ctrl+c" });
const AGENT_STATES = new Set(["idle", "working", "done", "blocked", "error"]);
const OWN_SCOPE_VAR = "__tickmarkr_own_hc_scope";
const EXPORT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const READ_LINES = 1000;

export class HcUnavailableError extends Error {
  constructor(readonly op: string, reason: string) { super(`herdr-app ${op}: ${reason}`); this.name = "HcUnavailableError"; }
}
/** A deadline was spent before a call could be issued, or its evidence arrived after it: never accepted. */
export class HcDeadlineError extends HcUnavailableError {
  constructor(op: string) { super(op, "deadline reached; late or missing evidence is not accepted"); this.name = "HcDeadlineError"; }
}

/** The first line of an error's message: hc diagnostics carry bounded stdout/stderr below it. */
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
/** Occurrences of `needle` in `hay` (0 for an empty needle). */
const count = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);

/**
 * The terminal's whole command: hc has just injected the terminal's OWN fresh HC_TERMINAL_ID/SOCKET/HC_SCOPE on top of
 * the CORE's environment (the client's environment never reaches it). Save only that own scope, seal like every pane,
 * restore the own scope (hc kill reaps through it), then the explicit exports, then the command.
 */
export function terminalPayload(cmd: string, env: NodeJS.ProcessEnv = process.env, exports: Record<string, string> = {}): string {
  // The core's environment is the terminal's, so an agent CLI the daemon resolved from its own PATH (a shell-profile
  // directory the core never read) would be missing there: the daemon's PATH crosses as one explicit export (queue
  // row 340; D-2180 — measured: omp in a profile-only directory was "command not found" in a review terminal). An empty
  // or absent PATH is deliberately NOT carried: exported, it would find no command at all, so the core's PATH stays.
  const carried = env.PATH ? { PATH: env.PATH, ...exports } : exports;
  const exported = Object.entries(carried).map(([k, v]) => {
    if (!EXPORT_NAME_RE.test(k)) throw new Error(`herdr-app: export name ${JSON.stringify(k)} is not a shell variable name`);
    return `export ${k}=${shq(v)}; `;
  }).join("");
  return `${OWN_SCOPE_VAR}="\${HC_SCOPE-}"; ${herdrSealShellPrefix(env)}` +
    `if [ -n "$${OWN_SCOPE_VAR}" ]; then export HC_SCOPE="$${OWN_SCOPE_VAR}"; fi; unset ${OWN_SCOPE_VAR}; ${exported}${cmd}`;
}

/**
 * A screen-only read (--lines 0) proves drain or a missing trailer only in the exact shape that request implies:
 * complete AND how screen. Any other shape (a history answer, or incomplete) is unreadable for that purpose.
 */
const provesDrain = (r: HcRead): boolean => r.complete && r.how === "screen";

/** Reported agent state, exactly; anything unreported, null or unrecognized is unknown — never inferred from text. */
export function agentState(t: HcTerminal): string {
  return t.reported && t.status && AGENT_STATES.has(t.status.state) ? t.status.state : "unknown";
}

/** A numeric signal as a supported OS name, else null. */
export function signalName(n: number | null): string | null {
  if (n === null) return null;
  return Object.entries(osConstants.signals).find(([, v]) => v === n)?.[0] ?? null;
}

/**
 * CASE B: the board's shell trampoline. It waits on its private launch gate and EXITS — never launching — if the gate
 * is not released within `waitMs` or its creator dies; the release carries the owner token, so nothing starts tokenless.
 */
export function boardTrampoline(cwd: string, gate: string, command: string, creator: number, waitMs: number): string {
  const g = shq(gate);
  return `cd ${shq(cwd)} || exit 1; n=${Math.ceil(waitMs / 100)}; while [ ! -s ${g} ]; do ` +
    `kill -0 ${Math.trunc(creator)} 2>/dev/null && [ "$n" -gt 0 ] || exit 1; n=$((n-1)); sleep 0.1; done; ` +
    `t=$(cat ${g}); rm -f ${g}; [ -n "$t" ] || exit 1; export ${WATCH_OWNER_ENV}="$t"; ${command}`;
}

/** Every window row of `address`: its exact terminal field, never labels or focus. */
const rowsOf = (layout: AppLayout, address: string): { space: string; tab: string; pane: string }[] =>
  layout.spaces.flatMap((s) => s.tabs.flatMap((tb) => tb.terminals.filter((r) => r.terminal === address).map((r) => ({ space: s.id, tab: tb.id, pane: r.pane }))));
/** Whether any window row is `address`'s terminal field or (when known) its app `pane` — a cleared terminal field
 *  leaves the pane, so absence needs both. */
const inWindow = (layout: AppLayout, address: string, pane?: string): boolean =>
  layout.spaces.some((s) => s.tabs.some((tb) => tb.terminals.some((r) => r.terminal === address || (!!pane && r.pane === pane))));
/** CASE B: the captured layouts never show a pane row with an empty terminal field; such a row is an uncaptured shape
 *  (a pane whose terminal cannot be identified), so every board decision reads that layout as unreadable. */
const uncaptured = (layout: AppLayout): string | undefined => {
  const r = layout.spaces.flatMap((s) => s.tabs.flatMap((tb) => tb.terminals)).find((x) => !x.terminal);
  return r && `the window layout is unreadable (pane ${r.pane} has an empty terminal field, an uncaptured shape)`;
};
/** A message without its `herdr-app <op>: ` prefix. */
const bare = (e: unknown): string => firstLine(e).replace(/^herdr-app \w+: /, "");
/** A live claimed UI: the record carries its claimant's pid, still alive, and the arm whose presence still exists. */
const claimed = (root: string, rec: WatchBoardOwner | undefined): boolean =>
  rec?.pid !== undefined && isPidLive(rec.pid) && !!rec.armId && existsSync(supervisionPresencePath(root, "watch", rec.armId));

/**
 * `address` is set only once creation is confirmed. `receipt` is an issued creation's receipt-bound address whose
 * confirmation failed or was rejected: close re-verifies it like a bound one. `unresolved` names an issued creation
 * with no receipt at all: close can neither prove its absence nor kill a guessed address, so it reports failure.
 */
interface AppSlot {
  owner: string; repo: string; cwd: string; inputBox?: InputBox; address?: string; coreId?: string; issued?: boolean;
  receipt?: string; unresolved?: string;
  /** The task-tab key (repo, run, task from the OWNER label — never a daemon group such as `workers`). */
  task?: string;
}

/**
 * CASE P: one task's tab generation. `space`/`tab` are recorded only from an exact mapping: the first placed member's,
 * or — for a generation recovered by adopt, which records them unset — the window layout row listing a verified
 * member. `members` are the addresses this driver placed or adopted there. `hidden` latches a generation whose mapping
 * never arrived: its later slots run hidden rather than scattering into speculative tabs.
 */
interface TaskTab { coreId: string; space?: string; tab?: string; members: Member[]; hidden?: string }
/** A placed member's full identity at creation: a later read must match ALL of it (owner, repo and checkout). */
type Member = Pick<AppSlot, "owner" | "repo" | "cwd"> & { address: string };
interface Placement { space?: string; tab?: string; gen?: TaskTab }
/**
 * CASE B: the run board this driver placed. `st` is the receipt-bound terminal (its owner is the watch name and its
 * cwd the one hc reported); `pane`/`tab` the window row the split answered (unset: resolved by the first verify);
 * `token` the WatchBoardOwner token its observer claimed. The slot id is the terminal address, as is the record's pane.
 */
interface Board {
  runId: string; root: string; slot: Slot; st: AppSlot & { address: string; coreId: string }; space: string; pane: string; tab: string; token: string;
  /** Our ownership labels were verified on it: from then on a read without them is a lost owner, never a fresh split. */
  labelled?: boolean;
}
/** CASE B: a board cleanup that did not prove absence — its terminal address and, when known, its app pane id. */
interface Unresolved { address: string; pane?: string; why?: string }
/** CASE B: `<run dir>/board-protect.json`, the run's board protection across driver instances (a resumed daemon). */
interface BoardProtect { version: 1; unresolved: Unresolved[]; indeterminate: boolean }
const protectPath = (root: string, runId: string): string => join(root, stateDirName(root), "runs", runId, "board-protect.json");
/** The run's protection file: undefined when missing (nothing owed); a throw when unreadable, malformed or of an
 *  unknown version — never read as nothing owed. */
function readProtect(root: string, runId: string): BoardProtect | undefined {
  const p = protectPath(root, runId);
  let text: string;
  try { text = readFileSync(p, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${p} is unreadable (${firstLine(e)})`);
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error(`${p} is malformed`); }
  const o = v as Partial<BoardProtect> | null;
  if (o === null || typeof o !== "object" || o.version !== 1) throw new Error(`${p} has an unknown version`);
  const entry = (x: unknown): boolean => {
    const e = x as Unresolved | null;
    return e !== null && typeof e === "object" && typeof e.address === "string" && !!e.address && (e.pane === undefined || typeof e.pane === "string");
  };
  if (!Array.isArray(o.unresolved) || !o.unresolved.every(entry) || typeof o.indeterminate !== "boolean") throw new Error(`${p} is malformed`);
  return { version: 1, unresolved: o.unresolved.map((x) => ({ address: x.address, ...(x.pane ? { pane: x.pane } : {}) })), indeterminate: o.indeterminate };
}
const bindingKey = (x: Unresolved): string => `${x.address}\0${x.pane ?? ""}`;
const protect = (x: Unresolved, why: string): never => {
  throw new HcUnavailableError("board", `prior board ${x.address}${x.pane ? ` (pane ${x.pane})` : ""} is not proven gone (${why})${x.why ? `; ${x.why}` : ""}; protected, none stacked`);
};
/** Each binding absent from this exhaustive hc listing AND this layout (no row with its terminal or pane), else protected. */
function goneIn(left: Unresolved[], list: HcList, layout: AppLayout): void {
  for (const x of left) {
    if (list.terminals.some((r) => r.address === x.address)) protect(x, "still listed in hc");
    if (list.hiddenFinished !== 0) protect(x, `the listing hides ${list.hiddenFinished} finished terminal(s)`);
    if (inWindow(layout, x.address, x.pane)) protect(x, "still in the window");
  }
}
/** A prior board's owner record whose terminal is still listed in hc or still has a window row is a ghost: never
 *  stacked over — either read alone is survival. */
function ghost(rec: WatchBoardOwner | undefined, list: HcList, layout: AppLayout): void {
  const where = !rec ? undefined : list.terminals.some((r) => r.address === rec.pane) ? "hc" : rowsOf(layout, rec.pane).length ? "the window" : undefined;
  if (where) throw new HcUnavailableError("board", `prior board ${rec!.pane} survives in ${where}; protected, none stacked`);
}

export interface HerdrAppTime { now: () => number; sleep: (ms: number) => Promise<void> }
export interface HerdrAppDriverOpts {
  hcBin?: string;
  appBin?: string;
  /** The hc CLIENT environment (the launcher's core selection) and the source of the sealed fork cap. */
  env?: NodeJS.ProcessEnv;
  /** Deliberately carried values rendered as quoted payload exports; nothing else crosses from the client. */
  exports?: Record<string, string>;
  /** Run identity for legacy-name canonicalization; a stable invocation-local synthetic one when absent. */
  runId?: string;
  time?: HerdrAppTime;
  callTimeoutMs?: number;
  outputCap?: number;
  readinessMs?: number;
  confirmMs?: number;
  pollMs?: number;
  /** How long a first task slot awaits its exact tab mapping (default 30 s). */
  placementMs?: number;
}

const SYSTEM_TIME: HerdrAppTime = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export class HerdrAppDriver implements ExecutorDriver {
  id = "herdr-app";
  interactive = true;
  readSource = "hc read --json (rendered screen plus history)";
  private readonly client: HcClient;
  private readonly slots = new Map<string, AppSlot>();
  private readonly fallback = new SubprocessDriver(); // notify/postSync: console/OS only, never typed into a terminal
  private readonly env: NodeJS.ProcessEnv;
  private readonly runId: string;
  private readonly time: HerdrAppTime;
  private append?: (event: string, taskId?: string, data?: Record<string, unknown>) => void;
  private n = 0;
  private readonly tabs = new Map<string, TaskTab>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Repo identities of the slots this driver created or adopted: reconcile sweeps only terminals labelled with one. */
  private readonly repos = new Set<string>();
  /** The run checkouts the daemon handed worktree() (a linked worktree included): their state dirs hold supervision. */
  private readonly checkouts = new Set<string>();
  /** CASE B: the live cached board of each run. */
  private readonly boards = new Map<string, Board>();
  /** CASE B: per run, every board cleanup not proven absent from hc AND the window; no split until each is re-proven
   *  gone. It mirrors the run's board-protect.json (written before the failure is reported), never replaces it. */
  private readonly unresolved = new Map<string, Unresolved[]>();
  /** CASE B: per run, an earlier split whose response failed, timed out or was malformed — it may have created a
   *  terminal nobody can name, so no driver splits for that run again (board-protect.json carries it). */
  private readonly indeterminate = new Map<string, string>();

  constructor(private readonly opts: HerdrAppDriverOpts = {}) {
    this.env = opts.env ?? process.env;
    this.time = opts.time ?? SYSTEM_TIME;
    this.client = new HcClient({ hcBin: opts.hcBin ?? "hc", appBin: opts.appBin, env: this.env, timeoutMs: opts.callTimeoutMs, outputCap: opts.outputCap, now: () => this.time.now() });
    this.runId = opts.runId ?? `run-local-${randomBytes(4).toString("hex")}`;
  }

  journalWith(append: NonNullable<HerdrAppDriver["append"]>): void { this.append = append; this.fallback.journalWith(append); }

  private journal(event: string, taskId: string | undefined, data: Record<string, unknown>): void {
    try { this.append?.(event, taskId, data); } catch { /* best-effort: a diagnostic row never fails the run */ }
  }

  private ownerFor(name: string, opts?: SlotOpts): string {
    if (opts?.owned) {
      const owner = formatOwnedName(opts.owned);
      const back = parseOwnedName(owner);
      if (!back || back.role !== opts.owned.role || back.taskId !== opts.owned.taskId || back.attempt !== opts.owned.attempt || back.runId !== opts.owned.runId) {
        throw new Error(`herdr-app slot: malformed owned identity ${JSON.stringify(opts.owned)}`);
      }
      return owner;
    }
    if (parseOwnedName(name)) return name;
    const owner = formatOwnedName(canonicalizeLegacyName(name, this.runId));
    if (!parseOwnedName(owner)) throw new Error(`herdr-app slot: ${JSON.stringify(name)} has no parseable owned identity`);
    return owner;
  }

  /** Logical only: no terminal exists until the first run. */
  async slot(cwd: string, name: string, opts?: SlotOpts): Promise<Slot> {
    const owner = this.ownerFor(name, opts);
    const dir = canonicalWorktreePath(cwd);
    const repo = realpathSync(trustedCommonDir(dir)); // repo identity: shared by this repo's checkouts, unequal to a foreign one
    const slot: Slot = { id: `hc-${++this.n}`, name: owner, cwd }; // the caller's path; ownership compares the canonical one
    slot.readScreen = () => this.readScreen(slot);
    // The adapter's composer rules follow the caller's adapter identity, not the (possibly canonical) slot name.
    // ponytail: the registry is only reachable by worker name, so opts.agent is looked up through a synthetic one.
    const inputBox = (opts?.agent ? declaredInputBoxForWorkerName(`slot-worker-${opts.agent}-a0-slot`) : undefined) ?? declaredInputBoxForWorkerName(name);
    const o = parseOwnedName(owner)!;
    const task = TASK_ROLES.has(o.role) ? JSON.stringify([repo, o.runId, o.taskId]) : undefined;
    this.slots.set(slot.id, { owner, repo, cwd: dir, inputBox, task });
    this.repos.add(repo);
    return slot;
  }

  private state(slot: Slot): AppSlot {
    const st = this.slots.get(slot.id);
    if (!st) throw new HcUnavailableError("slot", `unknown slot ${slot.id}`);
    return st;
  }

  private matches(st: Pick<AppSlot, "owner" | "repo" | "cwd">, t: HcTerminal): string | undefined {
    if (t.labels[OWNER_LABEL] !== st.owner) return "owner label differs";
    if (t.labels[REPO_LABEL] !== st.repo) return "repo label differs";
    if (canonicalWorktreePath(t.cwd) !== st.cwd) return "checkout differs";
    return undefined;
  }

  /** One call's bound before `deadline` (none without one); a spent deadline issues no call at all. */
  private budget(op: string, deadline?: number): number | undefined {
    if (deadline === undefined) return undefined;
    const left = deadline - this.time.now();
    if (left <= 0) throw new HcDeadlineError(op);
    return Math.min(this.opts.callTimeoutMs ?? HC_CALL_TIMEOUT_MS, left);
  }

  /** Evidence observed after its deadline is late, never accepted. */
  private inTime(op: string, deadline: number): void { if (this.time.now() > deadline) throw new HcDeadlineError(op); }

  /** The pinned terminal, re-verified: same core, same address, same owner/repo/checkout. Never a lookup by name. */
  private async owned(op: string, st: AppSlot, live = false, deadline?: number, at = st.address): Promise<HcTerminal & { address: string }> {
    if (!at || !st.coreId) throw new HcUnavailableError(op, "slot has no bound terminal");
    const core = await this.client.status(this.budget(op, deadline));
    if (core.coreId !== st.coreId) throw new HcUnavailableError(op, `core identity changed (${st.coreId} → ${core.coreId}); ${at} is not addressed`);
    let t: HcTerminal;
    try { t = await this.client.get(at, this.budget(op, deadline)); } catch (e) {
      if (e instanceof HcError && e.kind === "not_found") throw new HcUnavailableError(op, `${at} is gone`);
      throw e;
    }
    const why = this.matches(st, t);
    if (why) throw new HcUnavailableError(op, `${at} is not this slot's terminal (${why})`);
    if (live && t.state !== "live") throw new HcUnavailableError(op, `${at} has finished`);
    return t as HcTerminal & { address: string };
  }

  async run(slot: Slot, cmd: string): Promise<void> {
    const st = this.state(slot);
    if (st.address) return this.deliver(st, cmd);
    // A creation is issued at most once: an unconfirmed one is never replayed, and no guessed address is killed.
    if (st.issued) throw new HcUnavailableError("run", "a creation was already issued for this slot and is unconfirmed; not issuing another");
    st.issued = true;
    // Allocation is serialized per repo/run/task, so concurrent first slots of one task cannot open two tabs.
    return this.serial(st.task, () => this.create(st, cmd));
  }

  private serial<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (key === undefined) return fn();
    const next = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(key, next.catch(() => undefined)); // ponytail: one settled promise per task key, never pruned
    return next;
  }

  private async create(st: AppSlot, cmd: string): Promise<void> {
    const core = await this.client.status();
    st.coreId = core.coreId; // the core the creation is issued on; owned() still refuses until `address` is confirmed
    const place = await this.placeBefore(st, core.coreId);
    st.unresolved = "a creation was issued and has not answered; cleanup unresolved";
    let address: string;
    try {
      address = (await this.client.run([
        "--bg", "--no-parent", "--no-notify", "--cwd", st.cwd,
        "--label", `${OWNER_LABEL}=${st.owner}`, "--label", `${REPO_LABEL}=${st.repo}`,
        ...(place.space ? ["--label", `${SPACE_LABEL}=${place.space}`] : []),
        ...(place.tab ? ["--label", `${TAB_LABEL}=${place.tab}`] : []),
        "--", "bash", "-lc", terminalPayload(cmd, this.env, this.opts.exports),
      ])).address;
    } catch (e) {
      const orphan = await this.discover(st).catch(() => undefined);
      st.unresolved = `creation unconfirmed (${(e as Error).message})${orphan ? `; owned orphan ${orphan} left for cleanup` : ""}`;
      throw new HcUnavailableError("run", st.unresolved);
    }
    st.unresolved = undefined;
    st.receipt = address;
    let t: HcTerminal, after: { coreId: string };
    try {
      t = await this.client.get(address);
      after = await this.client.status();
    } catch (e) {
      throw new HcUnavailableError("run", `${address} creation unconfirmed (${(e as Error).message}); close re-verifies it before any cleanup`);
    }
    const why = this.matches(st, t)
      ?? (t.parent !== null || t.dieWithParent || t.notify ? "created as a launcher child (parent/die_with_parent/notify set): a task terminal must not also list under its launcher" : undefined)
      ?? (after.coreId !== core.coreId ? "core identity changed during creation" : undefined);
    if (why) throw new HcUnavailableError("run", `${address} rejected: ${why}`);
    if (place.space) await this.placeAfter(st, address, place, core.coreId);
    // The app turns keep on for a terminal it shows; a kept terminal can recover into a live shell that is not this
    // worker. Until keep reads false on the pinned, still-owned terminal it is not this slot's controlled transport.
    if (place.space || t.keep) {
      // keep --off mutates: issued only at the pinned address on the same core after ownership re-reads as this slot's.
      await this.owned("run", st, false, undefined, address);
      let off: HcTerminal | Error;
      try { off = await this.client.keepOff(address); } catch (e) { off = e as Error; }
      const bad = off instanceof Error ? firstLine(off) : this.matches(st, off) ?? (off.keep ? "keep still reads true" : undefined);
      if (bad) throw new HcUnavailableError("run", `${address} keep could not be disabled (${bad}); a recovered shell is never this worker's transport`);
    }
    st.address = address;
    st.coreId = core.coreId;
  }

  /**
   * CASE P before creation, never throwing: the window labels this terminal is created with. A verified task tab is
   * joined; otherwise the anchor's (the launcher's own HC_TERMINAL_ID) herdr.space starts a new tab. No anchor, an
   * unreadable anchor, or no space runs hidden. Focus, active tabs and the app's choice of space are never consulted.
   */
  private async placeBefore(st: AppSlot, coreId: string): Promise<Placement> {
    const o = parseOwnedName(st.owner)!;
    const hidden = (reason: string): Placement => {
      this.journal("herdr-app-placement-unavailable", o.taskId, { slot: st.owner, reason });
      return {};
    };
    try {
      const gen = st.task ? this.tabs.get(st.task) : undefined;
      if (gen && gen.coreId !== coreId) this.tabs.delete(st.task!); // a core change invalidates every recorded binding
      else if (gen?.hidden) return hidden(`task tab generation unplaced (${gen.hidden}); never a speculative tab`);
      else if (gen) {
        let layout;
        try { layout = await this.client.app("app-ls", ["ls"]); } catch (e) { return hidden(`app ls unreadable (${firstLine(e)})`); }
        // Every window row listing a recorded member (inside the generation's recorded space/tab, when it has them),
        // counted only while that member's whole identity — owner, repo AND checkout — still reads at its address.
        const found = new Map<string, { space: string; tab: string }>();
        for (const s of layout.spaces.filter((x) => !gen.space || x.id === gen.space)) {
          for (const tb of s.tabs.filter((x) => !gen.tab || x.id === gen.tab)) {
            for (const m of gen.members.filter((x) => tb.terminals.some((r) => r.terminal === x.address))) {
              const t = await this.client.get(m.address).catch(() => undefined);
              if (t && !this.matches(m, t)) found.set(JSON.stringify([s.id, tb.id]), { space: s.id, tab: tb.id });
            }
          }
        }
        if (found.size === 1) {
          const [at] = found.values();
          Object.assign(gen, at); // an adopted generation's resolved tab is recorded: later roles re-verify that one
          return { ...at!, gen };
        }
        // No verified member in any listed tab — or verified members in two tabs, so no unique task tab: a new
        // generation, never a foreign, reused or guessed tab.
        this.tabs.delete(st.task!);
      }
      const anchor = this.env.HC_TERMINAL_ID?.trim();
      if (!anchor) return hidden("no anchor terminal (HC_TERMINAL_ID unset)");
      let a: HcTerminal;
      try { a = await this.client.get(anchor); } catch (e) { return hidden(`anchor ${anchor} metadata unreadable (${firstLine(e)})`); }
      const space = a.labels[SPACE_LABEL]?.trim();
      if (!space) return {}; // an anchor outside any window: hidden in hc, no placement commands
      // A label outlives its window: the space is carried only while the window lists it, never into a gone window.
      let layout;
      try { layout = await this.client.app("app-ls", ["ls"]); } catch (e) { return hidden(`window unavailable (${firstLine(e)})`); }
      if (!layout.spaces.some((s) => s.id === space)) return hidden(`anchor space ${space} is not in the window layout`);
      return { space };
    } catch (e) {
      return hidden(firstLine(e));
    }
  }

  /**
   * CASE P after a confirmed creation, never throwing: a later member joins its generation; a first member awaits its
   * OWN exact mapping (its herdr.tab label in the anchor space, or its exact terminal row in that space of app ls),
   * records that tab and renames it. No mapping keeps execution, journals unavailable and latches the generation.
   */
  private async placeAfter(st: AppSlot, address: string, place: Placement, coreId: string): Promise<void> {
    const o = parseOwnedName(st.owner)!;
    const member: Member = { address, owner: st.owner, repo: st.repo, cwd: st.cwd };
    if (place.gen) { place.gen.members.push(member); return; }
    const deadline = this.time.now() + (this.opts.placementMs ?? HC_PLACEMENT_TIMEOUT_MS);
    let tab: string | undefined, why = "tab mapping never arrived", lost: string | undefined;
    try {
      for (;;) {
        const t = await this.client.get(address, this.budget("placement", deadline));
        // Placement metadata is accepted only from this slot's own terminal: a re-owned one is never recorded or renamed.
        if ((lost = this.matches(st, t))) break;
        if (t.labels[SPACE_LABEL] === place.space && t.labels[TAB_LABEL]) { tab = t.labels[TAB_LABEL]; break; }
        const layout = await this.client.app("app-ls", ["ls"], this.budget("placement", deadline));
        const hits = layout.spaces.filter((s) => s.id === place.space).flatMap((s) => s.tabs).filter((tb) => tb.terminals.some((m) => m.terminal === address));
        if (hits.length === 1) { tab = hits[0]!.id; break; }
        if (this.time.now() >= deadline) break;
        await this.time.sleep(Math.min(this.opts.pollMs ?? 200, Math.max(0, deadline - this.time.now())));
      }
    } catch (e) {
      if (!this.spent(e, deadline)) why = `placement unreadable (${firstLine(e)})`;
    }
    if (lost) throw new HcUnavailableError("run", `${address} rejected: ownership changed during placement (${lost}); not placed, renamed or controlled`);
    if (!tab) {
      if (st.task) this.tabs.set(st.task, { coreId, space: place.space!, members: [member], hidden: why });
      this.journal("herdr-app-placement-unavailable", o.taskId, { slot: st.owner, address, reason: why });
      return;
    }
    if (st.task) this.tabs.set(st.task, { coreId, space: place.space!, tab, members: [member] });
    try {
      // The existing short-title policy: a task token for task roles, the slot's own short name for anything else.
      await this.client.app("tab-rename", ["do", "tab.rename", "--id", tab, "--name", tabLabelFor(TASK_ROLES.has(o.role) ? st.owner : o.taskId)]);
    } catch (e) {
      this.journal("herdr-app-tab-rename-failed", o.taskId, { slot: st.owner, tab, reason: firstLine(e) }); // cosmetic: never a re-creation
    }
  }

  /** Discovery only (list, then get each candidate): the unique owned terminal of this slot, if any. */
  private async discover(st: AppSlot): Promise<string | undefined> {
    const list = await this.client.list();
    if (list.hiddenFinished !== 0) return undefined; // uniqueness is absence of any other: unproven behind hidden rows
    const hits: string[] = [];
    for (const row of list.terminals) {
      if (canonicalWorktreePath(row.cwd) !== st.cwd) continue;
      if (!this.matches(st, await this.client.get(row.address))) hits.push(row.address);
    }
    return hits.length === 1 ? hits[0] : undefined;
  }

  /**
   * A TUI message to the PINNED terminal: readiness, hc send (never --force), then a read-back of the same terminal.
   * Every call is bounded by its phase deadline and late evidence is refused. Confirmation needs evidence attributable
   * to THIS send: more echo occurrences than the pre-send screen had, or a transition into reported working from the
   * LAST pre-send observation — a get taken after the readiness read, and the status the send itself met.
   */
  private async deliver(st: AppSlot, text: string): Promise<void> {
    const ready = this.opts.readinessMs ?? 30_000;
    const poll = this.opts.pollMs ?? 200;
    const deadline = this.time.now() + ready;
    let before: { status: string; screen: string } | undefined;
    let why = "no readiness observed";
    try {
      const observe = async (): Promise<string> => {
        const t = await this.owned("send", st, true, deadline);
        const status = agentState(t);
        if (status === "blocked") throw new HcUnavailableError("send", `${t.address} is blocked on a dialog; no input sent`);
        return status;
      };
      while (!before) {
        await observe(); // ownership and liveness before any control read
        const screen = (await this.client.read(st.address!, 0, this.budget("send", deadline))).text;
        // The status that decides readiness and is the confirmation baseline is observed AFTER the screen read, so a
        // transition during that read is never credited to the send.
        const status = await observe();
        this.inTime("send", deadline);
        const box = st.inputBox;
        const occupied = box ? matchesOccupiedInputBox(screen, box) : false;
        if (!occupied && ((box && matchesEmptyInputBox(screen, box)) || status === "idle")) before = { status, screen };
        else {
          why = occupied ? "composer occupied" : `status ${status}`;
          if (this.time.now() >= deadline) throw new HcDeadlineError("send");
          await this.time.sleep(Math.min(poll, Math.max(0, deadline - this.time.now())));
        }
      }
    } catch (e) {
      if (this.spent(e, deadline)) throw new HcUnavailableError("send", `${st.address} not ready within ${ready} ms (${why}); no input sent`);
      throw e;
    }
    // hc reports the status the input met (captured: idle for a program that turned working on it): an agent already
    // working when the message landed cannot credit that state to this submission.
    const met = (await this.client.send(st.address!, text)).status;
    const baseline = met === "working" ? met : before.status;
    // ponytail: the echo is the message's first nonblank line (60 chars); a TUI that rewraps it needs its own marker.
    const echo = text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 60) ?? "";
    const confirmDeadline = this.time.now() + (this.opts.confirmMs ?? 5_000);
    try {
      for (;;) {
        const t = await this.owned("send", st, false, confirmDeadline);
        const working = agentState(t) === "working" && baseline !== "working";
        const echoed = !working && echo !== "" && count((await this.client.read(t.address, 0, this.budget("send", confirmDeadline))).text, echo) > count(before.screen, echo);
        this.inTime("send", confirmDeadline);
        if (working || echoed) return;
        if (this.time.now() >= confirmDeadline) throw new HcDeadlineError("send");
        await this.time.sleep(Math.min(poll, Math.max(0, confirmDeadline - this.time.now())));
      }
    } catch (e) {
      if (this.spent(e, confirmDeadline)) throw new HcUnavailableError("send", `${st.address} accepted the message but no read-back confirmed submission in time`);
      throw e;
    }
  }

  async nudge(slot: Slot, message: string): Promise<boolean> {
    try {
      await this.deliver(this.state(slot), message);
      return true;
    } catch (error) {
      try { this.append?.("herdr-app-nudge-unconfirmed", undefined, { slot: slot.name, reason: String(error) }); } catch { /* best-effort */ }
      return false;
    }
  }

  async sendKey(slot: Slot, key: string): Promise<void> {
    const hcKey = Object.hasOwn(HC_KEYS, key) ? HC_KEYS[key] : undefined;
    if (!hcKey) throw new Error(`herdr-app sendKey: ${JSON.stringify(key)} is not in the closed key set (${Object.keys(HC_KEYS).join(", ")})`);
    const t = await this.owned("keys", this.state(slot), true);
    await this.client.keys(t.address, [hcKey]);
  }

  async read(slot: Slot, lines: number): Promise<string> {
    const t = await this.owned("read", this.state(slot));
    // Incomplete (a full-screen app, a working agent) is still the terminal's text; completeness only gates negatives.
    return (await this.client.read(t.address, lines)).text;
  }

  async readScreen(slot: Slot): Promise<string> {
    const t = await this.owned("read", this.state(slot));
    return (await this.client.read(t.address, 0)).text;
  }

  async waitOutput(slot: Slot, pattern: string, timeoutMs: number, opts?: { regex?: boolean }): Promise<boolean> {
    const st = this.state(slot);
    const re = opts?.regex ? new RegExp(pattern) : undefined;
    // Each snapshot is matched on its own (tail-bounded), never concatenated with another into a fabricated marker.
    const hit = (text: string): boolean => { const t = text.slice(-MAX_BUF); return re ? re.test(t) : t.includes(pattern); };
    const deadline = this.time.now() + timeoutMs;
    try {
      for (;;) {
        const t = await this.owned("read", st, false, deadline);
        const history = await this.client.read(t.address, READ_LINES, this.budget("read", deadline));
        this.inTime("read", deadline);
        if (hit(history.text)) return true;
        if (t.state === "finished") {
          const screen = await this.client.read(t.address, 0, this.budget("read", deadline));
          this.inTime("read", deadline);
          if (hit(screen.text)) return true;
          // Only a complete how-screen final read proves drain; any other shape keeps polling to the deadline.
          if (provesDrain(screen)) return false;
        }
        if (this.time.now() >= deadline) return false;
        await this.time.sleep(Math.min(this.opts.pollMs ?? 200, Math.max(0, deadline - this.time.now())));
      }
    } catch (e) {
      if (this.spent(e, deadline)) return false;
      throw e;
    }
  }

  /** A deadline refusal, or a call killed at its deadline-derived bound: the wait timed out, nothing else. */
  private spent(e: unknown, deadline: number): boolean {
    // ponytail: a 5 ms slop — a kill timer armed for exactly the remaining time can fire a hair before the clock reads it.
    return e instanceof HcDeadlineError || (e instanceof HcError && e.diagnostics.timedOut && this.time.now() >= deadline - 5);
  }

  async status(slot: Slot): Promise<string> {
    const st = this.state(slot);
    if (!st.address) return "unknown";
    return agentState(await this.owned("status", st));
  }

  async waitAgentStatus(slot: Slot, status: string, timeoutMs: number): Promise<boolean> {
    const st = this.state(slot);
    const poll = this.opts.pollMs ?? 200;
    const deadline = this.time.now() + timeoutMs;
    try {
      for (;;) {
        const t = await this.owned("status", st, false, deadline);
        this.inTime("status", deadline);
        if (agentState(t) === status) return true; // only the authoritative get, in time, decides
        const left = deadline - this.time.now();
        if (t.state === "finished" || left <= 0) return false;
        // A wait slice is a wake reason only: timeout, message, exit or another settled status never decide. The
        // slice subprocess is bounded by the remaining deadline, never by a fresh call ceiling on top of it.
        const w = await this.client.wait(t.address, Math.min(left, poll), this.budget("status", deadline));
        if (w.ended || w.reason !== "timeout") await this.time.sleep(Math.min(poll, Math.max(0, deadline - this.time.now())));
      }
    } catch (e) {
      if (this.spent(e, deadline)) return false;
      throw e;
    }
  }

  /** Closed only on a finished terminal whose final screen-only read proves drain; live is open; anything else throws. */
  async transportState(slot: Slot): Promise<TransportState> {
    const t = await this.owned("transport", this.state(slot));
    if (t.state === "live") return { closed: false, exitCode: null, signal: null };
    // A kept terminal can come back as a live shell that is not the worker: its screen never proves the worker drained.
    if (t.keep) throw new HcUnavailableError("transport", `${t.address} has keep on; a recovered shell could stand in for the worker, drain unproven`);
    const screen = await this.client.read(t.address, 0);
    if (!provesDrain(screen)) {
      throw new HcUnavailableError("transport", `${t.address} final screen-only read is not a complete screen (complete ${screen.complete}, how ${screen.how}); drain unproven`);
    }
    return { closed: true, exitCode: t.exitCode, signal: signalName(t.signal) };
  }

  /**
   * CASE L-close: exact pinned ownership, kill (if live), rm, then proven absence. Never a tab or space. A receipt-bound
   * but unconfirmed creation is re-verified at its receipt address exactly like a bound one; an issued creation with
   * no receipt is reported unresolved (never success, never a guessed kill) and the slot is kept.
   */
  async close(slot: Slot): Promise<void> {
    const board = this.boardOf(slot);
    if (board) {
      await this.serial(`board ${board.runId}`, () => this.retireBoard(board, false)).catch((e: unknown) => {
        this.journal("herdr-app-cleanup-unconfirmed", undefined, { runId: board.runId, address: board.st.address, reason: firstLine(e) });
        throw e;
      });
      if (this.boards.get(board.runId) === board) this.boards.delete(board.runId);
      return;
    }
    const st = this.state(slot);
    if (st.unresolved) throw new HcUnavailableError("close", st.unresolved);
    const address = st.address ?? st.receipt;
    if (address) await this.closeAt(st, address); // never issued: logical only
    this.slots.delete(slot.id);
  }

  /** Re-verify `st`'s identity at the pinned `address` on its core, kill (if live), rm, then prove absence. */
  private async closeAt(st: AppSlot, address: string, guard?: (t: HcTerminal) => void | Promise<void>): Promise<void> {
    const core = await this.client.status();
    if (core.coreId !== st.coreId) throw new HcUnavailableError("close", `core identity changed; ${address} protected`);
    if (!(await this.listed("close", address))) return;
    const t = await this.owned("close", st, false, undefined, address);
    await guard?.(t); // the caller's own identity evidence on this final read, checked immediately before each destructive call
    if (t.state === "live") {
      // The kill receipt is ownership evidence too: a terminal re-owned between get and kill is protected, never rm'd.
      const k = await this.client.kill(address);
      const why = this.matches(st, k);
      if (why) throw new HcUnavailableError("close", `${address} protected: ownership lost during kill (${why}); not removed`);
      await guard?.(k);
    }
    await this.client.rm(address);
    if (await this.listed("close", address)) throw new HcUnavailableError("close", `${address} survived kill/rm`);
  }

  /**
   * READ-ONLY binding of a fresh instance to the terminal an earlier daemon created (list/get plus checkout git proof;
   * no create, run, label, keep, kill or rm). Exactly one terminal carries the full owner label; its repo label and
   * canonical cwd are this checkout's, and the checkout is its own git top level. Zero, duplicates, a foreign
   * cwd/repo, a malformed or partial listing, or a core change throws. A retained finished terminal binds: its
   * trailer is harvest evidence.
   */
  async adopt(slot: Slot): Promise<Slot> {
    if (!parseOwnedName(slot.name)) throw new HcUnavailableError("adopt", `slot ${slot.name} carries no owned name; nothing to adopt`);
    const cwd = canonicalWorktreePath(slot.cwd);
    const repo = realpathSync(trustedCommonDir(cwd));
    const core = await this.client.status();
    const list = await this.client.list();
    if (list.hiddenFinished !== 0) throw new HcUnavailableError("adopt", `the listing hides ${list.hiddenFinished} finished terminal(s); uniqueness unproven`);
    const hits: HcTerminal[] = [];
    for (const row of list.terminals) {
      try {
        const t = await this.client.get(row.address);
        if (t.labels[OWNER_LABEL] === slot.name) hits.push(t); // never the hc name: a same-title lookalike is not a candidate
      } catch (e) {
        if (!(e instanceof HcError && e.kind === "not_found")) throw e; // removed since the listing: not a candidate
      }
    }
    if (hits.length !== 1) throw new HcUnavailableError("adopt", `${hits.length === 0 ? "no terminal carries" : `${hits.length} terminals carry`} the owner label ${slot.name}`);
    const t = hits[0]!;
    if (t.labels[REPO_LABEL] !== repo) throw new HcUnavailableError("adopt", `${t.address} owned by ${slot.name} belongs to repo ${t.labels[REPO_LABEL] ?? "(unlabelled)"}, not ${repo}; foreign`);
    if (canonicalWorktreePath(t.cwd) !== cwd) throw new HcUnavailableError("adopt", `${t.address} owned by ${slot.name} sits in ${t.cwd}, not the task checkout ${cwd}; foreign`);
    const top = await shGit("git rev-parse --show-toplevel", cwd);
    if (top.code !== 0 || canonicalWorktreePath(top.stdout.trim()) !== cwd) throw new HcUnavailableError("adopt", `${cwd} is not its own git checkout; no checkout proof for ${slot.name}`);
    if ((await this.client.status()).coreId !== core.coreId) throw new HcUnavailableError("adopt", `core identity changed during adoption; ${t.address} is not addressed`);
    const adopted: Slot = { id: `hc-${++this.n}`, name: slot.name, cwd: slot.cwd, ...(slot.group === undefined ? {} : { group: slot.group }) };
    adopted.readScreen = () => this.readScreen(adopted);
    const o = parseOwnedName(slot.name)!;
    const task = TASK_ROLES.has(o.role) ? JSON.stringify([repo, o.runId, o.taskId]) : undefined;
    // issued: an adopted binding is never a creation target; the next run is a pinned TUI message, never a second terminal.
    this.slots.set(adopted.id, { owner: slot.name, repo, cwd, address: t.address, coreId: core.coreId, issued: true, inputBox: declaredInputBoxForWorkerName(slot.name), task });
    this.repos.add(repo);
    // A verified member that was created shown (it carries herdr.space) joins its task's tab generation — every adopted
    // member of the task, not just the first — so the task's later roles join its tab. Recording reads nothing more and
    // trusts no herdr.tab claim: placeBefore resolves the tab from the exact window layout row listing a member whose
    // owner+repo+checkout still verify, so a layout-only mapping counts and a closed first member leaves the rest.
    if (task && t.labels[SPACE_LABEL]?.trim()) {
      const member: Member = { address: t.address, owner: slot.name, repo, cwd };
      const gen = this.tabs.get(task);
      if (gen?.coreId === core.coreId) gen.members.push(member);
      else this.tabs.set(task, { coreId: core.coreId, members: [member] });
    }
    return adopted;
  }

  /**
   * Sweep owned terminals down to `desired`, cosmetic by contract (never throws). The boundary is exactly the repos
   * of slots this instance created or adopted (never the process cwd); live seats come from the run checkout's own
   * supervision, and a sweep with no established run checkout destroys nothing. Lists ALL terminals, finished
   * included, and reads each one's labels; panesToClose decides with the REPO as the boundary: only those repos'
   * parseable owners, never watch or live supervision seats, the current run's undesired ones and older runs only
   * when the caller's endedRunIds authorizes them. An owner label held twice is ambiguous and protected. Each
   * candidate is re-verified at its pinned address before kill/rm and proven absent; any failure journals
   * cleanup-unconfirmed, never a successful cleanup.
   */
  async reconcile(desired: Set<string>, runId: string, opts?: PanesToCloseOpts): Promise<void> {
    const unconfirmed = (reason: string, data: Record<string, unknown> = {}): void =>
      this.journal("herdr-app-cleanup-unconfirmed", undefined, { runId, ...data, reason });
    try {
      const repos = this.repos;
      if (!repos.size) return; // nothing served: no repo is in the boundary
      // Live seats are unknowable without the run checkout whose state dir the daemon's supervision lives in.
      if (!this.checkouts.size) return unconfirmed("no run checkout established (worktree() never called); live supervision seats unknown, nothing swept");
      // D-2180 add.14: uncertainty never authorizes destruction. Only ARMED with a seat protects by name; DISARMED,
      // ABSENT and STALE are definite. An UNREADABLE tier (a malformed or unreadable heartbeat or stand-down) could be
      // hiding a live seat, so live seats are unknown and nothing is swept — a readSupervision throw lands the same way.
      const liveSeats = new Set(opts?.liveSeats ?? []);
      for (const root of this.checkouts) {
        for (const tier of readSupervision(root)) {
          if (tier.state === "UNREADABLE") return unconfirmed(`supervision tier ${tier.tier} unreadable under ${root}; live supervision seats unknown, nothing swept`, { tier: tier.tier, checkout: root });
          if (tier.state === "ARMED" && tier.seat) liveSeats.add(tier.seat);
        }
      }
      const core = await this.client.status();
      const list = await this.client.list();
      // Uniqueness is the absence of any other holder: a hidden row or an unreadable label could be a duplicate owner
      // of any candidate, so destruction needs EXHAUSTIVE discovery — otherwise nothing is swept.
      if (list.hiddenFinished !== 0) return unconfirmed(`the listing hides ${list.hiddenFinished} finished terminal(s); ownership uniqueness unproven, nothing swept`);
      const terms: HcTerminal[] = [];
      const unreadable: string[] = [];
      for (const row of list.terminals) {
        try { terms.push(await this.client.get(row.address)); } catch (e) {
          if (!(e instanceof HcError && e.kind === "not_found")) {
            unreadable.push(row.address);
            unconfirmed(`labels unreadable (${firstLine(e)})`, { address: row.address });
          }
        }
      }
      if (unreadable.length) return unconfirmed(`${unreadable.length} terminal label read(s) failed; ownership uniqueness unproven, nothing swept`);
      const held = new Map<string, number>();
      for (const t of terms) { const o = t.labels[OWNER_LABEL]; if (o !== undefined) held.set(o, (held.get(o) ?? 0) + 1); }
      const REPO = "repo";
      const doomed = panesToClose(terms.map((t) => ({
        name: t.labels[OWNER_LABEL], paneId: t.address, workspaceId: repos.has(t.labels[REPO_LABEL] ?? "") ? REPO : undefined,
      })), desired, REPO, runId, { ...opts, liveSeats });
      for (const { paneId: address } of doomed) {
        const t = terms.find((x) => x.address === address)!;
        const owner = t.labels[OWNER_LABEL]!;
        const data = { address, owner, ownedRunId: parseOwnedName(owner)!.runId };
        if (held.get(owner) !== 1) { unconfirmed(`${held.get(owner)} terminals carry this owner label; ambiguous, protected`, data); continue; }
        try {
          await this.closeAt({ owner, repo: t.labels[REPO_LABEL]!, cwd: canonicalWorktreePath(t.cwd), address, coreId: core.coreId }, address);
          this.journal("herdr-app-reconcile-close", parseOwnedName(owner)!.taskId, { runId, ...data });
        } catch (e) {
          unconfirmed(firstLine(e), data);
        }
      }
    } catch (e) {
      unconfirmed(firstLine(e));
    }
  }

  /** Whether `address` is listed. Absence counts only from an EXHAUSTIVE listing (hidden_finished 0); otherwise throws. */
  private async listed(op: string, address: string): Promise<boolean> {
    const list = await this.client.list();
    if (list.terminals.some((r) => r.address === address)) return true;
    if (list.hiddenFinished !== 0) throw new HcUnavailableError(op, `${address} absence unproven: the listing hides ${list.hiddenFinished} finished terminal(s)`);
    return false;
  }

  /**
   * CASE B: one board right of the anchor's exact pane, running the daemon's narrator command. A live cached binding
   * answers again; an uncached same-name prior board is retired gracefully first or, unproven, protected — never
   * stacked. Every refusal journals herdr-app-boardless and rejects; the daemon then runs boardless.
   */
  async narrator(cwd: string, command: string, runId?: string): Promise<Slot> {
    if (!runId) throw new HcUnavailableError("board", "a run board requires a run identity");
    return this.serial(`board ${runId}`, async () => {
      try { return await this.placeBoard(cwd, command, runId); } catch (e) {
        this.journal("herdr-app-boardless", undefined, { runId, reason: firstLine(e) });
        throw e;
      }
    });
  }

  /** CASE B: the daemon proved this board lost. The cache is forgotten FIRST — a failed retire never answers the ghost
   *  again — then the exact board is closed without the dead UI's impossible acknowledgement, and proven absent. */
  async retireLostWatch(slot: Slot): Promise<void> {
    const b = this.boardOf(slot);
    if (!b) {
      const owned = parseOwnedName(slot.name);
      if (owned?.role === "watch" && ADDRESS_RE.test(slot.id)) this.unresolve(canonicalWorktreePath(slot.cwd), owned.runId, slot.id); // untouched, so unproven
      throw new HcUnavailableError("board", `${slot.name} is not a board this driver placed; ownership unproven, protected`);
    }
    this.boards.delete(b.runId);
    await this.serial(`board ${b.runId}`, () => this.retireBoard(b, true));
  }

  private boardOf(slot: Slot): Board | undefined { return [...this.boards.values()].find((b) => b.slot === slot || b.slot.id === slot.id); }

  private remember(runId: string, address: string, pane?: string, why?: string): void {
    const left = this.unresolved.get(runId) ?? [];
    if (!left.some((x) => x.address === address && x.pane === pane)) this.unresolved.set(runId, [...left, { address, pane, why }]);
  }

  /** An unproved cleanup: remembered, and persisted before its failure is reported. */
  private unresolve(root: string, runId: string, address: string, pane?: string, why?: string): void {
    this.remember(runId, address, pane, why);
    this.persist(root, runId);
  }

  /** Atomically rewrite the run's board-protect.json: the file's entries, this instance's and `add`, less those
   *  `proven` gone; indeterminate once either says so. `pending` is this instance's own split in flight: true records it
   *  before the split is issued (indeterminate until its receipt), false replaces it once the receipt is bound — and
   *  either throws on an unreadable file, so no split is ever issued unrecorded. Otherwise an unreadable file is left
   *  as it is — it already refuses every placement. */
  private persist(root: string, runId: string, c: { proven?: Unresolved[]; add?: Unresolved; pending?: boolean } = {}): void {
    let file: BoardProtect | undefined;
    try { file = readProtect(root, runId); } catch (e) {
      if (c.pending !== undefined) throw e;
      return;
    }
    const gone = new Set((c.proven ?? []).map(bindingKey));
    const all = new Map<string, Unresolved>();
    for (const x of [...(file?.unresolved ?? []), ...(this.unresolved.get(runId) ?? []), ...(c.add ? [c.add] : [])]) {
      if (!gone.has(bindingKey(x))) all.set(bindingKey(x), { address: x.address, ...(x.pane ? { pane: x.pane } : {}) });
    }
    const p = protectPath(root, runId);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
    const indeterminate = this.indeterminate.has(runId) || (c.pending ?? !!file?.indeterminate);
    writeFileSync(tmp, JSON.stringify({ version: 1, unresolved: [...all.values()], indeterminate }) + "\n");
    renameSync(tmp, p);
  }

  /** Every unresolved cleanup of `runId` re-proven gone — an exhaustive hc listing without its address AND no window
   *  row with that terminal or its pane — or the board is refused: never stacked over an unproved cleanup. The bindings
   *  are returned still owed: placement re-proves them on its newest reads before discharging them. */
  private async reproveGone(runId: string): Promise<Unresolved[]> {
    const left = this.unresolved.get(runId) ?? [];
    if (!left.length) return left;
    const [list, layout] = await Promise.all([this.client.list(), this.boardLayout()]).catch((e: unknown) => protect(left[0]!, bare(e)));
    goneIn(left, list, layout);
    return left;
  }

  private async placeBoard(cwd: string, command: string, runId: string): Promise<Slot> {
    const earlier = this.indeterminate.get(runId);
    if (earlier) throw new HcUnavailableError("board", `an earlier board placement for ${runId} was indeterminate (${earlier}); its terminal is left to its own bounded gate wait, no second split`);
    const cached = this.boards.get(runId);
    if (cached) {
      // Only the same live CLAIMED binding answers again: its terminal and row verified, then its record and claim.
      const why = await this.boardVerify(cached, true).then(() => {
        const rec = this.ownerOf(cached);
        return !rec ? "owner record changed (token or identity)" : claimed(cached.root, rec) ? undefined : "no live claimed UI";
      }, bare);
      if (!why) return cached.slot;
      // Not provably this live binding: it stays cached under its ORIGINAL identity (cwd, token, pane) — never re-derived
      // from a changed terminal or record — and unresolved, so nothing is split until its terminal and pane are proven gone.
      this.unresolve(cached.root, runId, cached.st.address, cached.pane, `its cached binding failed verification (${why})`);
    }
    const root = canonicalWorktreePath(cwd);
    // The run's persisted protection, read before any retirement or split: what an earlier driver could not prove.
    let file: BoardProtect | undefined;
    try { file = readProtect(root, runId); } catch (e) {
      throw new HcUnavailableError("board", `board protection for ${runId} is unreadable (${firstLine(e)}); none stacked, no split`);
    }
    if (file?.indeterminate) throw new HcUnavailableError("board", `an earlier board placement for ${runId} was indeterminate (recorded in board-protect.json); its terminal is left to its own bounded gate wait, no second split`);
    for (const x of file?.unresolved ?? []) this.remember(runId, x.address, x.pane);
    const owed = await this.reproveGone(runId);
    const repo = realpathSync(trustedCommonDir(root));
    const name = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
    const no = (why: string): never => { throw new HcUnavailableError("board", `board unavailable: ${why}`); };
    const core = await this.client.status();
    const anchor = this.env.HC_TERMINAL_ID?.trim() || no("no anchor terminal (HC_TERMINAL_ID unset)");
    const a = await this.client.get(anchor).catch((e: unknown) => no(`anchor ${anchor} unreadable (${firstLine(e)})`));
    const space = a.labels[SPACE_LABEL]?.trim() || no(`anchor ${anchor} is in no window space`);
    const layout = await this.client.app("app-ls", ["ls"]).catch((e: unknown) => no(`no window (${firstLine(e)})`));
    const unread = uncaptured(layout);
    if (unread) no(unread);
    // The anchor's pane is its exact terminal row in its own space: never its labels alone, focus or a default target.
    const anchorIn = (l: AppLayout): { pane: string; tab: string } => {
      const rows = rowsOf(l, anchor);
      return rows.length === 1 && rows[0]!.space === space ? rows[0]! : no(`anchor ${anchor} has ${rows.length} pane row(s), not exactly one in space ${space}`);
    };
    anchorIn(layout);
    await this.retirePrior(root, repo, name, runId, space, core.coreId);
    const waitMs = this.opts.placementMs ?? HC_PLACEMENT_TIMEOUT_MS;
    const gate = join(root, stateDirName(root), "runs", runId, `board-gate.${randomBytes(8).toString("hex")}`); // run-local, private
    mkdirSync(dirname(gate), { recursive: true });
    // What already exists, read after any retirement and immediately before the split: an exhaustive hc listing and the
    // window layout. A receipt naming any of it (the anchor included) names nothing new, so it binds nothing.
    const [seen, seenLayout] = await Promise.all([this.client.list(), this.boardLayout()]).catch((e: unknown) => no(`existing terminals unreadable (${bare(e)})`));
    if (seen.hiddenFinished !== 0) no(`the listing hides ${seen.hiddenFinished} finished terminal(s); a split receipt could not be proven new`);
    // These newest reads are THE evidence for every pre-split decision (D-2180 add.22): the anchor re-resolved and the
    // split aimed at ITS row; the prior board re-proven gone — no listed terminal carries the watch owner (one landing
    // after retirePrior's scan included) and the owner record's terminal is neither listed nor shown; the owed
    // bindings' absence re-proven — then discharged.
    const at = anchorIn(seenLayout);
    const left = await this.sameName(seen, name);
    if (left.length) throw new HcUnavailableError("board", `prior board ${left.map((t) => t.address).join(", ")} survives in hc as ${name}; protected, none stacked`);
    ghost(readWatchBoard(root, runId), seen, seenLayout);
    goneIn(owed, seen, seenLayout);
    this.boards.delete(runId); // a cached binding reaching here is proven gone
    // The split's intent is recorded BEFORE it is issued: a daemon dying before its receipt is bound leaves a terminal
    // nobody can name, so every later driver must already read this run's placement as indeterminate.
    this.unresolved.delete(runId);
    this.persist(root, runId, { proven: owed, pending: true }); // the owed bindings are removed only by this proven absence
    try {
      let split: AppSplit;
      try {
        split = await this.client.app("pane-split", ["do", "pane.split", "--direction", "right", "--pane", at.pane, "--argv",
          JSON.stringify(["bash", "-lc", terminalPayload(boardTrampoline(root, gate, command, process.pid, waitMs), this.env, this.opts.exports)])]);
        if (!ADDRESS_RE.test(split.terminal)) throw new Error(`receipt terminal ${JSON.stringify(split.terminal)} is not a local address`);
        if (split.terminal === anchor || seen.terminals.some((r) => r.address === split.terminal) || inWindow(seenLayout, split.terminal, split.pane)) {
          throw new Error(`receipt ${split.terminal} (pane ${split.pane}) names an existing terminal or pane, not the split's`);
        }
      } catch (e) {
        this.indeterminate.set(runId, firstLine(e)); // it may have created a terminal: never split again for this run
        this.persist(root, runId); // by any driver: already recorded as the split's intent, kept indeterminate
        throw new HcUnavailableError("board", `board placement indeterminate (${firstLine(e)}); no guessed cleanup and no second split`);
      }
      const b: Board = { runId, root, slot: { id: split.terminal, name, cwd }, space, pane: split.pane, tab: at.tab, token: "",
        st: { owner: name, repo, cwd: "", address: split.terminal, coreId: core.coreId } };
      // The intent becomes the receipt binding before any setup mutation; it is discharged only by confirmed setup
      // (below) or a proven take-back, so a daemon dying in between leaves every later driver protecting this split.
      this.persist(root, runId, { add: { address: b.st.address, pane: b.pane }, pending: false });
      try {
        // Every setup mutation is aimed only at the receipt-bound terminal re-proven just before it, and its receipt
        // is evidence too: the split's core, unlabelled (then exactly ours), its space and its checkout.
        b.st.cwd = canonicalWorktreePath((await this.split(b, true)).cwd);
        const own = this.splitIs(b, await this.client.label(b.st.address, [`${OWNER_LABEL}=${name}`, `${REPO_LABEL}=${repo}`])).labels;
        if (own[OWNER_LABEL] !== name || own[REPO_LABEL] !== repo) throw new Error(`${b.st.address} label receipt lacks our ownership labels`);
        b.labelled = true;
        await this.split(b, false);
        if (this.splitIs(b, await this.client.keepOff(b.st.address)).keep) throw new Error(`${b.st.address} keep still reads true`);
        await this.boardVerify(b, true); // the inherited window labels and the exact pane row: verified, never predicted
        b.token = reserveWatchBoard({ repo: root, runId, driver: this.id, workspace: space, pane: b.st.address, name }).token;
        writeFileSync(`${gate}.tmp`, b.token); // the release IS the published token, renamed over atomically
        renameSync(`${gate}.tmp`, gate);
        const claim = await this.awaitClaim(b, waitMs);
        // Re-proven after the claim, immediately before caching: the terminal, its row, the record still this board and
        // the very claim awaited still held (same pid and arm, live, its presence present) — verification is async.
        await this.boardVerify(b, true);
        const rec = this.ownerOf(b);
        if (!rec) throw new Error("the owner record changed after its observer claimed it");
        if (rec.pid !== claim.pid || rec.armId !== claim.armId || !claimed(root, rec)) throw new Error("the observer's claim did not hold through the final verification (matching pid, arm and presence)");
        this.persist(root, runId, { proven: [{ address: b.st.address, pane: b.pane }] }); // confirmed: a claimed, owned board
      } catch (e) {
        throw new HcUnavailableError("board", `board setup failed (${firstLine(e)}); ${await this.takeBack(b)}`);
      }
      this.boards.set(runId, b);
      return b.slot;
    } finally {
      rmSync(gate, { force: true });
      rmSync(`${gate}.tmp`, { force: true });
    }
  }

  /** Every terminal of `list` that, read now, carries the watch owner `name` (one found gone is no candidate). */
  private async sameName(list: HcList, name: string): Promise<HcTerminal[]> {
    const same: HcTerminal[] = [];
    for (const row of list.terminals) {
      try { const t = await this.client.get(row.address); if (t.labels[OWNER_LABEL] === name) same.push(t); } catch (e) {
        if (!(e instanceof HcError && e.kind === "not_found")) throw e;
      }
    }
    return same;
  }

  /** An uncached same-name prior board: retired gracefully only on full evidence and a live claimed UI, else protected.
   *  Finding none here is not absence: placement re-proves the prior gone on its newest reads, just before the split. */
  private async retirePrior(root: string, repo: string, name: string, runId: string, space: string, coreId: string): Promise<void> {
    const list = await this.client.list();
    if (list.hiddenFinished !== 0) throw new HcUnavailableError("board", `the listing hides ${list.hiddenFinished} finished terminal(s); a prior board is unproven, none stacked`);
    const same = await this.sameName(list, name);
    if (!same.length) return;
    const rec = readWatchBoard(root, runId);
    const t = same[0]!;
    if (same.length !== 1 || rec?.driver !== this.id || rec.name !== name || rec.workspace !== space || rec.pane !== t.address || t.labels[REPO_LABEL] !== repo || !claimed(root, rec)) {
      throw new HcUnavailableError("board", `prior board ${name} lacks matching repo/run/space/terminal/token evidence or a live claimed UI; protected, none stacked`);
    }
    await this.retireBoard({ runId, root, slot: { id: t.address, name, cwd: root }, space, pane: "", tab: "", token: rec.token,
      st: { owner: name, repo, cwd: canonicalWorktreePath(t.cwd), address: t.address, coreId } }, false);
  }

  /** The board terminal's identity on its core (owner/repo/cwd, its space) and its unique exact window row.
   *  undefined only on close (`live` false): a UI that exited by itself is a finished terminal, and the Herdr app drops
   *  a finished terminal's pane from the window, so no row is then its closed state (queue row 340; D-2180). */
  private async boardVerify(b: Board, live: boolean): Promise<{ pane: string; tab: string } | undefined> {
    const t = await this.owned("board", b.st, live);
    if (t.labels[SPACE_LABEL] !== b.space) throw new HcUnavailableError("board", `${t.address} is not in space ${b.space}`);
    const layout = await this.boardLayout();
    const rows = rowsOf(layout, t.address);
    // ...but only while the board's KNOWN pane is gone too: a pane that survives under another terminal, or a pane this
    // driver never learned (an uncached prior board whose UI exited after its claim check), is protected.
    if (!live && t.state === "finished" && rows.length === 0 && b.pane && !inWindow(layout, t.address, b.pane)) return undefined;
    const r = rows[0];
    if (rows.length !== 1 || r!.space !== b.space || (b.pane && r!.pane !== b.pane) || (b.tab && r!.tab !== b.tab)) {
      throw new HcUnavailableError("board", `${t.address} has no unique exact pane row (${rows.length} row(s))`);
    }
    return r!;
  }

  /** The observer's claim: the record still carries this token, now with its pid and arm, whose presence exists. */
  private async awaitClaim(b: Board, waitMs: number): Promise<WatchBoardOwner> {
    const deadline = this.time.now() + waitMs;
    for (;;) {
      const rec = this.ownerOf(b);
      if (!rec) throw new Error("the owner record changed before its observer claimed it");
      if (claimed(b.root, rec)) return rec;
      if ((await this.split(b, false)).state !== "live") throw new Error(`${b.st.address} finished before its observer claimed the board`);
      if (this.time.now() >= deadline) throw new Error("no observer claimed the board (matching token, pid and arm presence)");
      await this.time.sleep(Math.min(this.opts.pollMs ?? 200, Math.max(0, deadline - this.time.now())));
    }
  }

  /** The owner record, only while it still names exactly this board: token, terminal, space, driver and name. */
  private ownerOf(b: Board): WatchBoardOwner | undefined {
    const rec = readWatchBoard(b.root, b.runId);
    return rec?.token === b.token && rec.pane === b.st.address && rec.workspace === b.space && rec.driver === this.id && rec.name === b.st.owner ? rec : undefined;
  }

  /** `t` (a read or a mutation's receipt) is the receipt-bound split terminal: no ownership labels when `fresh`;
   *  exactly ours once they were verified (`labelled`), else none or ours; the split's space; once read, the split's
   *  checkout. Anything else is protected. */
  private splitIs(b: Board, t: HcTerminal, fresh = false): HcTerminal {
    const own = t.labels[OWNER_LABEL], rep = t.labels[REPO_LABEL];
    if (fresh ? own !== undefined || rep !== undefined : (own ?? b.st.owner) !== b.st.owner || (rep ?? b.st.repo) !== b.st.repo) {
      throw new Error(`${b.st.address} carries a foreign owner; protected`);
    }
    if (!fresh && b.labelled && (own === undefined || rep === undefined)) throw new Error(`${b.st.address} lost its ownership labels; protected`);
    if (t.labels[SPACE_LABEL] !== b.space) throw new Error(`${b.st.address} is not in space ${b.space}; protected`);
    if (b.st.cwd && canonicalWorktreePath(t.cwd) !== b.st.cwd) throw new Error(`${b.st.address} checkout differs; protected`);
    return t;
  }

  /** The receipt-bound terminal re-read on the split's own core (a restarted core's same address is someone else). */
  private async split(b: Board, fresh: boolean): Promise<HcTerminal> {
    if ((await this.client.status()).coreId !== b.st.coreId) throw new Error(`core identity changed; ${b.st.address} protected`);
    return this.splitIs(b, await this.client.get(b.st.address), fresh);
  }

  /** The window layout for a board decision: an uncaptured shape is unreadable, never evidence (absence included). */
  private async boardLayout(): Promise<AppLayout> {
    const layout = await this.client.app("app-ls", ["ls"]);
    const why = uncaptured(layout);
    if (why) throw new HcUnavailableError("board", why);
    return layout;
  }

  /** Neither the terminal nor its pane is in the window any more: hc removal alone is not absence. */
  private async goneFromWindow(address: string, pane: string): Promise<void> {
    if (inWindow(await this.boardLayout(), address, pane)) throw new HcUnavailableError("board", `${address} (pane ${pane}) is still in the window after close`);
  }

  /** Failed setup: take back ONLY the receipt-bound terminal while it is still provably this split's (same core, its
   *  checkout, no foreign or lost owner, a kill receipt saying the same and — once reserved — the owner record still
   *  naming this board) — kill, rm, proven absent from hc AND the window. Anything less is journaled
   *  cleanup-unconfirmed, never success. */
  private async takeBack(b: Board): Promise<string> {
    const a = b.st.address;
    // After reservation the record is ownership evidence too, re-read before each destructive call.
    const mine = (): void => { if (b.token && !this.ownerOf(b)) throw new Error(`${b.st.owner} owner record changed (token or identity); protected`); };
    try {
      if ((await this.client.status()).coreId !== b.st.coreId) throw new Error("core identity changed");
      if (await this.listed("board", a)) {
        if (!b.st.cwd) throw new Error(`${a} was never read; identity unproven, protected`);
        const live = (await this.split(b, false)).state === "live";
        mine();
        if (live) {
          try { this.splitIs(b, await this.client.kill(a)); } catch (e) { throw new Error(`ownership lost during kill (${firstLine(e)}); not removed`); }
          mine();
        }
        await this.client.rm(a);
        if (await this.listed("board", a)) throw new Error(`${a} survived kill/rm`);
      }
      await this.goneFromWindow(a, b.pane);
      this.persist(b.root, b.runId, { proven: [{ address: a, pane: b.pane }] }); // the receipt binding, proven absent
      return `split ${a} taken back`;
    } catch (e) {
      this.unresolve(b.root, b.runId, a, b.pane);
      this.journal("herdr-app-cleanup-unconfirmed", undefined, { address: a, reason: firstLine(e) });
      return `cleanup unconfirmed for ${a} (${firstLine(e)})`;
    }
  }

  /**
   * Close a board: the owner record (token, terminal, space) and the terminal's identity and unique row verified first;
   * a live UI must acknowledge (stop, matching ack, its own presence gone) while a LOST one is only asked. The record
   * is re-read after the acknowledgement (it answers a token, not an identity) and again before kill and before rm,
   * then proven absence from hc and the window. Any failure protects the board.
   */
  private async retireBoard(b: Board, lost: boolean): Promise<void> {
    let pane = b.pane || undefined; // unknown (an uncached prior board) until its row is verified: matched by address alone
    try {
      const owner = (): WatchBoardOwner => this.ownerOf(b) ?? (() => { throw new HcUnavailableError("board", `${b.st.owner} owner record changed (token or identity); board protected`); })();
      const rec = owner();
      const row = await this.boardVerify(b, false); // undefined: its UI exited by itself and the window dropped its pane
      pane = row?.pane ?? pane;
      const dead = lost || !row; // a dead UI can never acknowledge; a merely stuck one still finds the request
      if (dead) requestWatchBoardStop(rec);
      else await stopWatchBoard(rec, this.time);
      // Normal close: the acknowledgement is re-proven against the CURRENT record at every destructive step — its
      // claimant's ack, that arm's presence gone; a record whose pid/arm changed after acknowledging protects the board.
      // A lost board, or one whose UI exited by itself, is exempt: its dead UI can never acknowledge.
      const mine = (): void => {
        if (!watchBoardAcknowledged(owner()) && !dead) throw new HcUnavailableError("board", `${b.st.owner} acknowledgement no longer matches its current claimant; board protected`);
      };
      mine();
      // The verification right before the close decides its guards: a board that was live and acknowledged can still
      // exit (finished, its pane dropped) before this read, and then it closes as a dead UI too.
      const settled = row ? await this.boardVerify({ ...b, ...row }, false) : undefined;
      const known = row?.pane || b.pane;
      // Space is identity too: the final read and the kill receipt must still name the board's space, and the record
      // this board — anything else protects it, never killed or removed.
      await this.closeAt(b.st, b.st.address, async (t) => {
        if (t.labels[SPACE_LABEL] !== b.space) throw new HcUnavailableError("board", `${b.st.address} space ${t.labels[SPACE_LABEL] ?? "(none)"} is not the board's ${b.space}; board protected`);
        // A board closed as a dead UI (no window row) is removed only while this final read still says finished, so it
        // is never killed (hc rm itself refuses a terminal that turned live after it), and only while its known pane is
        // still absent, re-read just before the rm: that read is the window's last proof.
        if (!settled) {
          if (t.state !== "finished") throw new HcUnavailableError("board", `${b.st.address} is live again after its UI exited; board protected`);
          if (inWindow(await this.boardLayout(), b.st.address, known)) throw new HcUnavailableError("board", `${b.st.address} (pane ${known}) reappeared in the window; board protected`);
        }
        mine(); // last, after every awaited read: the owner record is re-proven immediately before the destructive call
      });
      await this.goneFromWindow(b.st.address, settled?.pane ?? known);
    } catch (e) {
      this.unresolve(b.root, b.runId, b.st.address, pane);
      throw e;
    }
  }

  notify(msg: string, opts?: NotifyOpts): Promise<void> { return this.fallback.notify(msg, opts); }
  postSync(post: NotificationPost): void { this.fallback.postSync(post); }
  worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    this.checkouts.add(repo); // the daemon's run checkout: its supervision dir is where reconcile reads live seats
    return createWorktree(repo, branch, baseRef);
  }
}
