import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "../adapters/types.js";
import { createWorktree, sh, type ShResult } from "../run/git.js";
import { Journal, type JournalEvent } from "../run/journal.js";
import { MAX_BUF } from "./subprocess.js";
import { formatOwnedName, panesToClose, parseOwnedName, type ExecutorDriver, type NotifyOpts, type Slot, type SlotOpts } from "./types.js";

// Orca (onorca.dev) as a third execution surface beside herdr and subprocess. tickmarkr keeps
// worktrees, routing, gates, journal and merges; orca supplies visible terminals only. Everything
// here is bound by the 1.4.186 conformance spike
// (.planning/assessments/2026-08-21-orca-driver-conformance.md, CONFORMANCE-END) and the
// 1.4.195 drift capture (.planning/assessments/2026-09-02-orca-1.4.195-capture/):
//
//  - reads arrive as `result.terminal.tail` line arrays with line-indexed cursors and a `status`
//    field on the same object (C2); a CLOSED terminal answers ok:true with its own dead record
//    and retained scrollback (C4), so liveness is never inferred from a read that returned bytes;
//  - orca has no output-pattern wait, so waitOutput is a bounded cursor-paged polling matcher (C2);
//    `--command` runs inside an interactive wrapper shell that OUTLIVES it, so `wait --for exit` is
//    never command completion — the tickmarkr trailer is (C2);
//  - show reports liveness through connected/orphaned only (NO status, NO agent field): agent
//    state lives on orca's own agent-wait/tui-idle surface — `blocked` when show reports
//    agentWait:true, `idle` when the `wait --for tui-idle` condition is satisfied;
//  - the owned title survives at TAB identity: create's title lands on the tab, and the shell
//    overwrites each row's pane title as soon as it draws output (recorded: "…probe…" → "bash"),
//    so recovery matches the owned TAB title in `list --include-visual-layouts`, never a row title;
//  - handles are runtime-scoped; every envelope carries `_meta.runtimeId`, read-only operations
//    recover after observing a change, and sends probe runtime identity before mutating (C1/C4);
//  - `--worktree` takes a SELECTOR, not a path (`orca terminal create --help`, 1.4.186):
//    `path:<abs>` names a checkout outright while `active`/`current` resolve whatever the UI has
//    focused — a driver that lets the app pick has given away the isolation the worktree exists
//    for, so every call this driver makes names `path:` and verifies what came back (T2);
//  - `terminal list`'s `--worktree` is OPTIONAL (same help): the reconcile sweep omits it, because
//    an older run's leftover sits in a checkout this run never knew (T2).

/** The response families the ONE shared envelope parser serves. There is no second JSON seam. */
export const ORCA_RESPONSE_FAMILIES = [
  "status", "create", "list", "read", "send", "wait", "show", "close",
  "worktree-current", "worktree-set", "hooks-status",
] as const;
export type OrcaFamily = (typeof ORCA_RESPONSE_FAMILIES)[number];

export const ORCA_FIXTURE_VERSION = "1.4.195";
export const ORCA_CLI_COMMAND_ENV = "ORCA_CLI_COMMAND";
export const STALE_HANDLE_CODE = "terminal_handle_stale";
export const TERMINAL_GONE_CODE = "terminal_gone";
export const STALE_HANDLE_CODES = new Set([STALE_HANDLE_CODE, TERMINAL_GONE_CODE]);
export const WAIT_TIMEOUT_CODE = "timeout";
export const NOT_WRITABLE_CODE = "terminal_not_writable";
/** The ONLY terminal status that licenses reading a terminal's bytes or its agent state. */
export const RUNNING_STATUS = "running";

// The closed method set the terminal-status discipline governs: every one of these validates the
// terminal record's own status BEFORE it reports anything derived from that terminal — bytes for
// read/waitOutput, agent state for status/waitAgentStatus. Nothing else in this driver reads a
// terminal, so the set is closed by construction.
export const STATUS_GOVERNED_METHODS = ["read", "waitOutput", "status", "waitAgentStatus"] as const;

const PAGE_LINES = 500; // per-page ask; orca caps server-side and reports `limited`
const LIST_LIMIT = 10000; // well past orca's own row default; `truncated` still decides (listAll)
const MAX_PAGES = 400; // runaway guard: a cursor that stops advancing ends the sweep, never loops
const POLL_MS = 200;
export const WORKTREE_ADOPTION_TIMEOUT_MS = 60_000;
const WORKTREE_ADOPTION_POLL_MS = 1_000;
const WORKTREE_ADOPTION_JOURNAL_MS = 2_000;
const NUDGE_ECHO_TIMEOUT_MS = 2_000;

export interface OrcaExec { (args: string[], cwd: string, timeoutMs?: number): Promise<ShResult> }
export interface OrcaTimeSource { now: () => number; sleep: (ms: number) => Promise<void> }

const SYSTEM_TIME: OrcaTimeSource = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Every failure this driver produces is explicit and carries the raw bytes that produced it. */
export class OrcaError extends Error {
  readonly code?: string;
  readonly runtimeId?: string;

  constructor(
    readonly family: string,
    readonly reason: string,
    readonly raw: string,
    opts: { code?: string; runtimeId?: string } = {},
  ) {
    super(`orca ${family} failed — ${reason}; raw response:\n${raw}`);
    this.name = "OrcaError";
    this.code = opts.code;
    this.runtimeId = opts.runtimeId;
  }
}

/** The slot cannot be addressed: dead/unknown terminal record, or a handle that cannot be recovered
 *  to exactly one owned terminal in the slot's own worktree. Never a silent false or empty string. */
export class OrcaUnavailableError extends OrcaError {
  constructor(family: string, reason: string, raw: string, readonly terminalStatus?: string) {
    super(family, reason, raw, { code: "terminal_unavailable" });
    this.name = "OrcaUnavailableError";
  }
}

export interface OrcaEnvelope {
  result: Record<string, unknown>;
  runtimeId: string;
  raw: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export interface OrcaBinaryResolverOpts {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  resolve?: (bin: string, cwd: string) => { resolved?: string };
}

/**
 * One Orca CLI name decision for both the driver and doctor. Linux desktop systems can have
 * GNOME's screen-reader `orca` on PATH, so outside an Orca terminal the app CLI is `orca-ide`.
 */
export function resolveOrcaCliBinary(cwd = process.cwd(), opts: OrcaBinaryResolverOpts = {}): string | undefined {
  const env = opts.env ?? process.env;
  const explicit = env[ORCA_CLI_COMMAND_ENV]?.trim();
  if (explicit) return explicit;
  const platform = opts.platform ?? process.platform;
  const selected = platform === "linux" && env.TERM_PROGRAM !== "Orca" ? "orca-ide" : "orca";
  return opts.resolve ? opts.resolve(selected, cwd).resolved : selected;
}

/**
 * The one JSON seam. Fails CLOSED on every degenerate response — empty, unparseable (a truncated
 * body lands here), non-object, no boolean `ok`, `ok:false`, `ok:true` with no result object, or a
 * successful response without a usable `_meta.runtimeId` —
 * and preserves the raw bytes on the thrown error for diagnostics. Callers never see a partial
 * envelope, so no caller can reinterpret a parse failure as empty output, an unknown-but-successful
 * status, or a successful close.
 */
export function parseEnvelope(family: OrcaFamily, stdout: string, raw?: string): OrcaEnvelope {
  const text = stdout.trim();
  const rawText = raw !== undefined ? raw : stdout;
  if (!text) throw new OrcaError(family, "empty response", rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new OrcaError(family, `unparseable response (${(e as Error).message})`, rawText);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OrcaError(family, "response is not a JSON object", rawText);
  }
  const env = parsed as Record<string, unknown>;
  const meta = env._meta;
  const runtimeId = typeof meta === "object" && meta !== null ? str((meta as Record<string, unknown>).runtimeId) : undefined;
  if (typeof env.ok !== "boolean") throw new OrcaError(family, "envelope carries no boolean ok", rawText, { runtimeId });
  if (!env.ok) {
    const err = typeof env.error === "object" && env.error !== null ? (env.error as Record<string, unknown>) : {};
    const code = str(err.code);
    throw new OrcaError(family, `refused (${code ?? "no error code"}${str(err.message) ? `: ${str(err.message)}` : ""})`, rawText, { code, runtimeId });
  }
  const result = env.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new OrcaError(family, "ok response carries no result object", rawText, { runtimeId });
  }
  if (!runtimeId || runtimeId === "none") {
    throw new OrcaError(family, "ok response carries no usable _meta.runtimeId", rawText, { runtimeId });
  }
  return { result: result as Record<string, unknown>, runtimeId, raw: rawText };
}

function requireTerminal(family: string, env: OrcaEnvelope): Record<string, unknown> {
  const t = env.result.terminal;
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    throw new OrcaError(family, "response carries no terminal record", env.raw);
  }
  return t as Record<string, unknown>;
}

/** The worktree a terminal record binds to. The spike pinned the record's shape but not this key's
 *  spelling, so the known aliases are accepted and nothing else — a record with none is unbound,
 *  which fails every identity comparison below rather than passing one by default. */
export function terminalWorktree(term: Record<string, unknown>): string | undefined {
  const nested = typeof term.worktree === "object" && term.worktree !== null && !Array.isArray(term.worktree)
    ? str((term.worktree as Record<string, unknown>).path)
    : undefined;
  const id = str(term.worktreeId);
  const separator = id?.indexOf("::") ?? -1;
  const fromId = id && separator >= 0 ? str(id.slice(separator + 2)) : undefined;
  return str(term.worktree) ?? str(term.worktreePath) ?? str(term.worktree_path) ?? nested ?? fromId ?? str(term.path) ?? str(term.cwd);
}

/**
 * The same checkout under two spellings. git hands tickmarkr one (`/tmp/...` on darwin, or anything
 * below a symlinked parent) while Orca answers the canonicalized one (`/private/tmp/...`), and
 * `resolve()` collapses `..` but never a symlink — so string equality on resolved paths reports two
 * different checkouts and leaves a perfectly valid slot unreacquirable after a runtime restart.
 * Identity is FILESYSTEM identity. A path that does not exist has no filesystem identity to read, so
 * it keeps its resolved spelling: deterministic, and still comparable to another spelling of itself.
 */
export function canonicalWorktreePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path); // never created, already removed, or not ours to stat
  }
}

/** Does a record's reported worktree name `canonical` (a path already canonicalized)? An unbound
 *  record reports none, and that is never a match — the comparison fails closed, not by default. */
function sameWorktree(reported: string | undefined, canonical: string): boolean {
  return reported !== undefined && canonicalWorktreePath(reported) === canonical;
}

// Orca has ONE terminal space — no workspace dimension for a terminal to be outside of — so every
// reconcile candidate takes panesToClose's in-workspace branch: owned-and-undesired closes whichever
// run (or which daemon) created it, and an unparseable title is never a candidate anywhere.
const ORCA_SPACE = "orca";

/** Conservative agent-state mapping over orca's ACTUAL surfaces: `blocked` only when the show
 *  record reports agentWait:true, `idle` only when the `terminal wait --for tui-idle` condition is
 *  satisfied. The recorded 1.4.186 show response carries NO agent field at all — an absent signal
 *  is "unknown", never a fabricated definite status. */
export function mapAgentState(term: Record<string, unknown>, tuiIdle: boolean): string {
  if (term.agentWait === true) return "blocked";
  if (tuiIdle) return "idle";
  return "unknown"; // absent fields: unknown, never blocked/idle
}

/** Terminal-pane handles under a layout tab node: a pane object, an array of them, or a nested
 *  group/split carrying `panes`, `first`, `second`. Only `type:"terminal"` leaves count — anything else is chrome. */
function collectPaneHandles(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectPaneHandles(n, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const o = node as Record<string, unknown>;
  if (o.type === "terminal") {
    const h = str(o.handle);
    if (h) out.push(h);
    return;
  }
  collectPaneHandles(o.panes, out);
  collectPaneHandles(o.first, out);
  collectPaneHandles(o.second, out);
}

function collectTabs(node: unknown, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTabs(n, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.tabs)) {
    out.push(...o.tabs);
  }
  collectTabs(o.first, out);
  collectTabs(o.second, out);
}

/**
 * The renderer hard-wraps long lines, paints margin chrome, and a cursor page boundary splits a
 * marker exactly like a wrap does. `parseWorkerResult` (src/adapters/prompt.ts) already de-wraps
 * trailers this way, so marker matching gets the same joined view beside the raw one.
 * ponytail: joining every line can in principle glue two unrelated lines into a marker — the same
 * tolerance parseWorkerResult has carried since v1.2; raw is matched first, so an unwrapped hit
 * never depends on this.
 */
export function joinWrapped(raw: string): string {
  return raw.split("\n").map((l) => l.replace(/^[\s│|]+/, "").replace(/[\s│|]+$/, "")).join("");
}

interface OrcaSlotState {
  title: string; // the FULL owned title — the durable TAB identity a relist matches on
  cwd: string; // the slot's exact worktree, canonicalized — the `path:` selector AND the identity
  // Where the `orca` CLI is invoked from. Every command names its target with an explicit `path:`
  // selector or a handle, so the CLI's own cwd selects nothing — but it must still EXIST, and
  // reconcile sweeps checkouts an older run already removed. Defaults to the worktree itself.
  dir?: string;
  agent?: string; // tickmarkr adapter id; Orca's hook table uses a few different names
  handle?: string;
  surface?: string; // copied only from the terminal create receipt; never inferred
  hostPlatform?: string; // copied only from the terminal create receipt; never inferred

  runtimeId?: string; // the runtime identity that ANSWERED this handle's create
  cursor?: string; // waitOutput's resume point; undefined until the first sweep anchors it
  buf: string;
  recoveries: number;
  recovering: boolean;
  unavailable?: string; // latched: the slot can no longer be addressed, ever
}

export interface OrcaDriverOpts {
  bin?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exec?: OrcaExec;
  time?: OrcaTimeSource;
  pageLines?: number;
  pollMs?: number;
  /** Bounded, seam-adjustable staleness window for runtime probes before mutations. */
  probeStalenessMs?: number;
}

export class OrcaDriver implements ExecutorDriver {
  id = "orca";
  interactive = true; // a visible terminal the operator can watch and answer
  private slots = new Map<string, OrcaSlotState>();
  private n = 0;
  private bin: string;
  private exec: OrcaExec;
  private time: OrcaTimeSource;
  private pageLines: number;
  private pollMs: number;
  private probeStalenessMs: number;
  private journalRoots = new Map<string, string>();
  private narrate?: (event: JournalEvent) => void;
  private hookCoverage?: Promise<{ enabled: boolean; states: Map<string, string> }>;
  private taskWorktrees = new Map<string, string>();
  private pendingProjects = new Map<string, "in-progress" | "in-review" | "completed">();

  constructor(opts: OrcaDriverOpts = {}) {
    this.bin = opts.bin ?? resolveOrcaCliBinary(process.cwd(), { env: opts.env, platform: opts.platform }) ?? "orca";
    // Config values flow into a shell here: every argv element is quoted, always.
    this.exec = opts.exec ?? ((args, cwd, timeoutMs) => {
      return sh([this.bin, ...args].map(shq).join(" "), cwd, timeoutMs);
    });
    this.time = opts.time ?? SYSTEM_TIME;
    this.pageLines = opts.pageLines ?? PAGE_LINES;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.probeStalenessMs = opts.probeStalenessMs ?? 2000;
  }

  private async call(family: OrcaFamily, args: string[], cwd: string, timeoutMs?: number): Promise<OrcaEnvelope> {
    let r: ShResult;
    try {
      r = await this.exec([...args, "--json"], cwd, timeoutMs);
    } catch (e) {
      throw new OrcaError(family, `orca CLI could not be invoked (${(e as Error).message})`, "");
    }
    // JSON is opt-in on every Orca command. Keep both streams when present so a refusal or a CLI
    // diagnostic is never discarded before the one shared parser reports it.
    const raw = [r.stdout, r.stderr ? `STDERR: ${r.stderr}` : ""].filter(Boolean).join("\n");
    if (r.code !== 0) {
      // Recorded refusal transport: the process exits rc 1 with the STRUCTURED ok:false
      // body on stdout. Parse it so the refusal CODE survives (terminal_handle_stale,
      // terminal_not_writable) — everything downstream that recovers on a code depends on this
      // branch. Elapsed `terminal wait` has two recorded transports: 1.4.186's ok:true,
      // `wait.satisfied:false` receipt and 1.4.195's ok:false/code:timeout refusal. Each remains
      // scoped to wait only; any other ok:true body on a nonzero exit stays a transport failure (a
      // shell/runtime crash can leave stale stdout behind).
      try {
        const env = parseEnvelope(family, r.stdout, raw);
        const wait = env.result.wait;
        if (
          family === "wait"
          && r.code === 1
          && !r.timedOut
          && typeof wait === "object"
          && wait !== null
          && !Array.isArray(wait)
          && (wait as Record<string, unknown>).satisfied === false
        ) {
          return env;
        }
      } catch (e) {
        if (
          family === "wait"
          && r.code === 1
          && !r.timedOut
          && e instanceof OrcaError
          && e.code === WAIT_TIMEOUT_CODE
          && e.runtimeId
          && e.runtimeId !== "none"
        ) {
          const handle = args[args.indexOf("--terminal") + 1];
          const condition = args[args.indexOf("--for") + 1];
          return {
            result: { wait: { handle, condition, satisfied: false, status: RUNNING_STATUS } },
            runtimeId: e.runtimeId,
            raw,
          };
        }
        // The refusal code lives in stdout alone, but the raw bytes propagated to the caller must
        // still be the COMBINED stream — stderr can carry the diagnostic that explains the refusal.
        if (e instanceof OrcaError && !(e instanceof OrcaUnavailableError) && e.code !== undefined) {
          throw new OrcaError(family, e.reason, raw, { code: e.code, runtimeId: e.runtimeId });
        }
      }
      throw new OrcaError(
        family,
        `orca CLI exited ${r.code}${r.timedOut ? " after timeout" : ""}`,
        raw,
      );
    }
    return parseEnvelope(family, r.stdout, raw);
  }

  /** The live runtime's identity, or an explicit failure. A missing or unreachable runtime is a
   *  driver-level failure carrying the raw refusal — never a reachable-looking default. */
  private async runtimeEnv(cwd: string): Promise<OrcaEnvelope> {
    const env = await this.call("status", ["status"], cwd);
    const runtime = env.result.runtime;
    const reachable = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>).reachable
      : undefined;
    if (reachable !== true) {
      throw new OrcaError("status", "runtime reports reachable:false or carries no reachability proof", env.raw, { runtimeId: env.runtimeId });
    }
    return env;
  }

  /** Explicit runtime probe. Also T3's doctor probe. */
  async probeRuntime(cwd: string = process.cwd()): Promise<string> {
    return (await this.runtimeEnv(cwd)).runtimeId;
  }

  // ---- slot lifecycle --------------------------------------------------------------------------

  async slot(cwd: string, name: string, opts?: SlotOpts): Promise<Slot> {
    const title = opts?.owned ? formatOwnedName(opts.owned) : name;
    const id = `orca-${++this.n}`;
    // ponytail: no terminal is created here — slot() is lazy by contract (T2); the first run()
    // issues the single `terminal create` that carries both the command and this cwd.
    // Canonical: git and Orca can spell one checkout two ways, and every later comparison — create
    // receipt, relist, reconcile — is against THIS value.
    const worktree = canonicalWorktreePath(cwd);
    this.slots.set(id, { title, cwd: worktree, agent: opts?.agent, buf: "", recoveries: 0, recovering: false });
    const owned = parseOwnedName(title);
    if (owned?.role === "worker") {
      this.taskWorktrees.set(owned.taskId, worktree);
      const pending = this.pendingProjects.get(owned.taskId);
      if (pending) {
        await this.setWorkspaceStatus(worktree, pending);
        this.pendingProjects.delete(owned.taskId);
      }
    }
    return { id, name: title, cwd: worktree, group: opts?.group };
  }

  /** Where to invoke the CLI for this slot's calls (see OrcaSlotState.dir). */
  private cliCwd(st: OrcaSlotState): string {
    return st.dir ?? st.cwd;
  }

  private state(slot: Slot): OrcaSlotState {
    const s = this.slots.get(slot.id);
    if (!s) throw new OrcaError("show", `unknown slot ${slot.id}`, "");
    return s;
  }

  private latched(family: string, st: OrcaSlotState, reason: string, raw: string): OrcaUnavailableError {
    st.unavailable = reason;
    return new OrcaUnavailableError(family, reason, raw);
  }

  private assertAvailable(family: string, st: OrcaSlotState): void {
    if (st.unavailable) throw new OrcaUnavailableError(family, st.unavailable, "");
  }
  describe(slot: Slot): { surface?: string; hostPlatform?: string } {
    const st = this.state(slot);
    // The daemon asks only after run(), but callers probing a lazy slot must see absence rather
    // than an invented placement. The interface's object spread accepts this runtime absence.
    if (!st.handle) return undefined as never;
    return {
      ...(st.surface === undefined ? {} : { surface: st.surface }),
      ...(st.hostPlatform === undefined ? {} : { hostPlatform: st.hostPlatform }),
    };
  }

  async run(slot: Slot, cmd: string): Promise<void> {
    const st = this.state(slot);
    if (!st.handle) {
      this.assertAvailable("create", st);
      return this.create(st, cmd);
    }
    this.assertAvailable("send", st);
    // Later deliveries go into the terminal this slot already owns — never a second create.
    // terminalOp proves the runtime binding before the handle goes on the wire.
    await this.sendText(st, cmd);
  }

  private async sendText(st: OrcaSlotState, text: string): Promise<void> {
    const env = await this.terminalOp("send", st, (h) => this.call(
      "send",
      ["terminal", "send", "--terminal", h, "--text", text, "--enter"],
      this.cliCwd(st),
    ), { mutating: true });
    // Recorded 1.4.195 send receipt: result.send = {handle, accepted, bytesWritten}. `ok:true`
    // alone is not delivery: the accepted receipt must name this handle and account for the bytes.
    const receipt = this.sendReceipt(env, st);
    const expectedBytes = Buffer.byteLength(text, "utf8") + 1;
    if (receipt.accepted !== true || typeof receipt.bytesWritten !== "number" || receipt.bytesWritten !== expectedBytes) {
      throw new OrcaError("send", `send receipt does not report expected byte delivery (accepted: ${JSON.stringify(receipt.accepted)}, bytesWritten: ${receipt.bytesWritten}, expected: ${expectedBytes})`, env.raw);
    }
  }

  private sendReceipt(env: OrcaEnvelope, st: OrcaSlotState): Record<string, unknown> {
    const receipt = env.result.send;
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      throw new OrcaError("send", "send response carries no send receipt", env.raw);
    }
    const parsed = receipt as Record<string, unknown>;
    if (str(parsed.handle) !== st.handle) {
      throw new OrcaError("send", `send receipt names terminal ${str(parsed.handle) ?? "none"}, not the addressed ${st.handle}`, env.raw);
    }
    return parsed;
  }

  private async create(st: OrcaSlotState, cmd: string): Promise<void> {
    await this.probeRuntime(this.cliCwd(st));
    await this.awaitWorktreeAdoption(st);
    // The selector names THIS slot's checkout outright, and the CLI child is bound to it too, so
    // neither the UI's active worktree (`active`/`current`) nor the daemon's cwd can place it.
    const env = await this.call("create", [
      "terminal", "create", "--worktree", `path:${st.cwd}`, "--title", st.title, "--command", cmd,
    ], this.cliCwd(st));
    const term = requireTerminal("create", env);
    const handle = str(term.handle);
    if (!handle) throw new OrcaError("create", "create receipt carries no terminal handle", env.raw);
    // Asking is not getting: the receipt says which checkout the runtime actually resolved, and a
    // terminal in the wrong one has already lost the isolation this run is built on.
    const worktree = terminalWorktree(term);
    if (!sameWorktree(worktree, st.cwd)) {
      // `terminal create` has ALREADY launched the command in that wrong checkout, so refusing the
      // receipt is not yet fail-closed: the agent keeps mutating it. Close the exact handle this
      // receipt named, under the runtime that answered it (closeTerminal re-proves that identity
      // before the handle goes on the wire), then latch — the slot is not addressable again, so a
      // retrying dispatch never opens a second terminal beside one that must not exist. The close
      // is best effort; the latch is what holds if it fails.
      try {
        await this.closeTerminal({ ...st, handle, runtimeId: env.runtimeId });
      } catch { /* already gone, or no longer provably ours — never a blind retry */ }
      throw this.latched("create", st, `create receipt bound to ${worktree ?? "no worktree"}, not the slot's ${st.cwd}`, env.raw);
    }
    st.handle = handle;
    // The handle is bound to the runtime identity that ANSWERED its create.
    st.runtimeId = env.runtimeId;
    st.surface = str(term.surface);
    st.hostPlatform = str(term.hostPlatform);
    if (st.surface !== undefined && st.surface !== "visible") {
      await this.notify(`tickmarkr orca terminal created on ${st.surface} surface`, { tier: "attention" });
    }
  }

  /**
   * A freshly-created git checkout does not become a valid Orca selector atomically. Ask
   * `worktree current` FROM that checkout until Orca itself resolves the exact filesystem identity;
   * an enclosing checkout is still not adoption. Only selector_not_found is a retryable refusal —
   * malformed envelopes and every other refusal remain explicit driver failures.
   */
  private async awaitWorktreeAdoption(st: OrcaSlotState): Promise<void> {
    const started = this.time.now();
    const deadline = started + WORKTREE_ADOPTION_TIMEOUT_MS;
    let lastReported: string | undefined;
    for (;;) {
      const left = deadline - this.time.now();
      if (left < 0) break;
      try {
        const env = await this.call(
          "worktree-current",
          ["worktree", "current"],
          st.cwd,
          Math.max(1, left),
        );
        const worktree = env.result.worktree;
        if (typeof worktree !== "object" || worktree === null || Array.isArray(worktree)) {
          throw new OrcaError("worktree-current", "response carries no worktree record", env.raw, { runtimeId: env.runtimeId });
        }
        const reported = terminalWorktree(worktree as Record<string, unknown>);
        if (!reported) {
          throw new OrcaError("worktree-current", "worktree record carries no path", env.raw, { runtimeId: env.runtimeId });
        }
        lastReported = canonicalWorktreePath(reported);
        if (lastReported === st.cwd) {
          const waitedMs = this.time.now() - started;
          if (waitedMs > WORKTREE_ADOPTION_JOURNAL_MS) this.appendAdoptionWait(st, waitedMs);
          return;
        }
      } catch (error) {
        if (!(error instanceof OrcaError) || error.code !== "selector_not_found") throw error;
        lastReported = undefined;
      }
      const remaining = deadline - this.time.now();
      if (remaining <= 0) break;
      await this.time.sleep(Math.min(WORKTREE_ADOPTION_POLL_MS, remaining));
    }
    const waitedMs = this.time.now() - started;
    throw new OrcaUnavailableError(
      "worktree-current",
      `Orca did not adopt ${st.cwd} within ${WORKTREE_ADOPTION_TIMEOUT_MS}ms${lastReported ? ` (last answered ${lastReported})` : ""}`,
      `waitedMs=${waitedMs}`,
    );
  }

  /** Same repo/run/narration path Herdr uses for its driver-owned dispatch-retry row. */
  private appendAdoptionWait(st: OrcaSlotState, waitedMs: number): void {
    const owned = parseOwnedName(st.title);
    if (!owned) throw new Error(`cannot journal worktree-adoption-wait: slot ${st.title} carries no run identity`);
    const repoRoot = this.journalRoots.get(st.cwd);
    if (!repoRoot) {
      throw new Error(`cannot journal worktree-adoption-wait: slot ${st.title} has no daemon repo binding for ${st.cwd}`);
    }
    Journal.open(repoRoot, owned.runId, this.narrate).append("worktree-adoption-wait", owned.taskId, {
      milliseconds: waitedMs,
    });
  }

  // ---- handle identity and restart recovery ----------------------------------------------------

  /**
   * Every terminal-addressed call — read AND write — goes through here, and the runtime identity is
   * established BEFORE the runtime-scoped handle goes on the wire. Discarding a lookalike's answer
   * after reading it is still having addressed it, so the probe comes first; the post-call check
   * only closes the narrow race of a restart landing between probe and call. Same for an explicit
   * `terminal_handle_stale`. Either way the driver relists the slot's exact worktree and replaces
   * the handle exactly once, then re-issues the operation against the replacement.
   */
  private async terminalOp(
    family: string,
    st: OrcaSlotState,
    fn: (handle: string) => Promise<OrcaEnvelope>,
    opts?: { mutating?: boolean; onRecovered?: () => void },
  ): Promise<OrcaEnvelope> {
    this.assertAvailable(family, st);
    if (!st.handle) throw new OrcaError(family, "slot holds no terminal handle yet", "");
    if (!st.runtimeId) throw this.latched(family, st, "terminal handle carries no bound runtime identity", "");
    let recovered = false;
    const mutating = opts?.mutating === true;
    // One recovery per operation: a second identity change mid-operation is not another relist, it
    // is an unavailable slot.
    const relist = async (runtimeId: string | undefined, raw: string): Promise<void> => {
      if (recovered) throw this.latched(family, st, `runtime identity changed again during ${family}`, raw);
      recovered = true;
      await this.recover(family, st, runtimeId, raw);
      opts?.onRecovered?.();
    };
    const live = await this.runtimeEnv(this.cliCwd(st));
    let probeTime = this.time.now();
    if (live.runtimeId !== st.runtimeId) await relist(live.runtimeId, live.raw);
    for (;;) {
      if (mutating && this.time.now() - probeTime > this.probeStalenessMs) {
        const fresh = await this.runtimeEnv(this.cliCwd(st));
        probeTime = this.time.now();
        if (fresh.runtimeId !== st.runtimeId) {
          await relist(fresh.runtimeId, fresh.raw);
          continue;
        }
      }
      let env: OrcaEnvelope;
      try {
        env = await fn(st.handle);
      } catch (e) {
        if (e instanceof OrcaError && !(e instanceof OrcaUnavailableError)) {
          // Identity FIRST, before any code-bearing branch: a mutation whose failure carries a
          // different identity — or NO identity at all (a malformed/truncated/_meta-less body the
          // parser rejected before any code existed) — cannot be proven undelivered, so the slot is
          // latched unavailable rather than left addressable for a second, duplicate mutation.
          if (mutating && e.runtimeId !== st.runtimeId) {
            throw this.latched(family, st, `runtime identity mismatch on refused mutation: expected ${st.runtimeId}, got ${e.runtimeId ?? "absent"}`, e.raw);
          }
          if (e.code !== undefined) {
            if (e.runtimeId !== st.runtimeId) {
              await relist(e.runtimeId, e.raw);
              continue;
            }
            if (STALE_HANDLE_CODES.has(e.code)) {
              await relist(e.runtimeId, e.raw);
              continue;
            }
          }
        }
        throw e;
      }
      if (env.runtimeId !== st.runtimeId) {
        if (mutating) {
          throw this.latched(family, st, `runtime identity mismatch on mutation response: expected ${st.runtimeId}, got ${env.runtimeId ?? "absent"}`, env.raw);
        }
        await relist(env.runtimeId, env.raw);
        continue;
      }
      return env;
    }
  }

  private async recover(family: string, st: OrcaSlotState, newRuntimeId: string | undefined, raw: string): Promise<void> {
    if (st.recovering) throw this.latched(family, st, "handle recovery re-entered", raw);
    st.recovering = true;
    try {
      const old = st.handle;
      // visualLayouts is required: the owned title survives at TAB identity only, and rows carry
      // just the shell-controlled pane title (recorded: "…probe…" at create → "bash" on the row).
      const env = await this.call("list", ["terminal", "list", "--worktree", `path:${st.cwd}`, "--include-visual-layouts", "--limit", String(LIST_LIMIT)], this.cliCwd(st));
      const listed = env.result.terminals;
      if (!Array.isArray(listed)) throw new OrcaError("list", "list response carries no terminals array", env.raw);
      if (env.result.truncated === true) throw new OrcaError("list", "terminal list is truncated, cannot safely recover handle", env.raw);
      const layouts = env.result.visualLayouts;
      if (!Array.isArray(layouts)) throw new OrcaError("list", "list response carries no visualLayouts array — owned tab titles are not recoverable", env.raw);
      // The worktree-authoritative rows of THIS worktree: a handle is adoptable only if a row in
      // the slot's exact worktree backs it. A same-titled tab in another worktree is a lookalike.
      const inWorktree = new Set(
        listed
          .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && sameWorktree(terminalWorktree(t), st.cwd))
          .map((t) => str(t.handle))
          .filter((h): h is string => h !== undefined),
      );
      // Exactly one tab carrying the FULL owned title, resolving to exactly one terminal pane.
      // Nothing else — a prefix, a suffix, a pane title that happens to spell the owned name, or
      // the same tab title in another worktree is a lookalike and is not this slot's terminal.
      const ownedTabs: string[][] = [];
      for (const layout of layouts) {
        if (typeof layout !== "object" || layout === null) continue;
        const lo = layout as Record<string, unknown>;
        if (!sameWorktree(terminalWorktree(lo), st.cwd)) continue; // another worktree's tabs are never candidates
        const tabs: unknown[] = [];
        collectTabs(lo.root, tabs);
        for (const tab of tabs) {
          if (typeof tab !== "object" || tab === null || str((tab as Record<string, unknown>).title) !== st.title) continue;
          const handles: string[] = [];
          collectPaneHandles((tab as Record<string, unknown>).panes, handles);
          ownedTabs.push(handles);
        }
      }
      if (ownedTabs.length === 0) {
        throw this.latched(family, st, `no tab in ${st.cwd} carries the owned title ${st.title} (row titles are shell-controlled and are never ownership keys)`, env.raw);
      }
      if (ownedTabs.length > 1) {
        throw this.latched(family, st, `${ownedTabs.length} tabs in ${st.cwd} carry the owned title ${st.title} — ambiguous`, env.raw);
      }
      const panes = ownedTabs[0].filter((h) => inWorktree.has(h));
      if (panes.length !== 1) {
        throw this.latched(family, st, `the owned tab resolves to ${panes.length} terminals in ${st.cwd}`, env.raw);
      }
      const handle = panes[0];
      if (handle === old) {
        // Handles are runtime-scoped: the same VALUE under a different runtime proves nothing about
        // which terminal it addresses, so it is never adopted.
        throw this.latched(family, st, `replacement handle ${handle} is the old handle value reused by runtime ${newRuntimeId ?? env.runtimeId ?? "unknown"}`, env.raw);
      }
      st.handle = handle;
      // The list response is the identity proof for the replacement. A stale refusal may have been
      // produced by either side of a restart; its metadata never overrides the runtime that relisted.
      st.runtimeId = env.runtimeId;
      st.cursor = undefined; // a different terminal record owns a different cursor space
      // …and a different terminal's bytes. Whatever this slot accumulated came from the runtime we
      // just discarded; keeping it would let an old prefix and a new suffix join into a marker no
      // terminal ever emitted.
      st.buf = "";
      st.recoveries++;
    } finally {
      st.recovering = false;
    }
  }

  // ---- status discipline -----------------------------------------------------------------------

  /** Validated READ terminal record, or an explicit unavailable failure. Called BEFORE any caller
   *  looks at tail bytes — on every page, on every read-governed method. Read records are the one
   *  place orca reports a literal `status` (recorded: "running" live, "exited" on the dead record). */
  private validated(family: string, st: OrcaSlotState, env: OrcaEnvelope): Record<string, unknown> {
    const term = requireTerminal(family, env);
    const handle = str(term.handle);
    if (handle !== st.handle) {
      throw new OrcaUnavailableError(family, `terminal record names ${handle ?? "no handle"}, not the addressed ${st.handle}`, env.raw);
    }
    const status = str(term.status);
    if (status !== RUNNING_STATUS) {
      throw new OrcaUnavailableError(
        family,
        `terminal ${str(term.handle) ?? st.handle ?? "?"} reports status ${status ?? "absent"}, not ${RUNNING_STATUS}`,
        env.raw,
        status,
      );
    }
    return term;
  }

  /** Validated SHOW terminal record, or an explicit unavailable failure. The recorded 1.4.186 show
   *  response reports liveness through connected/orphaned and carries NO status and NO agent field,
   * so this is the status discipline's show leg: a terminal that cannot prove connected-and-not-
   * orphaned is unavailable for state questions, exactly as a non-running read record is for bytes. */
  private liveShowTerm(family: string, st: OrcaSlotState, env: OrcaEnvelope): Record<string, unknown> {
    const term = requireTerminal(family, env);
    const handle = str(term.handle);
    if (handle !== st.handle) {
      throw new OrcaUnavailableError(family, `terminal record names ${handle ?? "no handle"}, not the addressed ${st.handle}`, env.raw);
    }
    if (term.connected !== true || term.orphaned === true) {
      const status = term.orphaned === true ? "orphaned" : term.connected === false ? "disconnected" : "unknown";
      throw new OrcaUnavailableError(
        family,
        `terminal ${str(term.handle) ?? st.handle ?? "?"} reports connected=${JSON.stringify(term.connected)}, orphaned=${JSON.stringify(term.orphaned)}`,
        env.raw,
        status,
      );
    }
    return term;
  }

  private tailText(family: string, term: Record<string, unknown>, raw: string): string {
    const tail = term.tail;
    if (!Array.isArray(tail)) throw new OrcaError(family, "terminal record carries no tail array", raw);
    if (!tail.every((line) => typeof line === "string")) {
      throw new OrcaError(family, "terminal tail carries a non-string line", raw);
    }
    return tail.join("\n");
  }

  private async readPage(
    family: string,
    st: OrcaSlotState,
    cursor: string | undefined,
    lines: number,
  ): Promise<{ term: Record<string, unknown>; raw: string; recovered: boolean }> {
    let recovered = false;
    const env = await this.terminalOp(family, st, (h) => this.call("read", [
      "terminal", "read", "--terminal", h,
      ...(cursor === undefined || recovered ? [] : ["--cursor", cursor]),
      "--limit", String(lines),
    ], this.cliCwd(st)), { onRecovered: () => { recovered = true; } });
    return { term: this.validated(family, st, env), raw: env.raw, recovered };
  }

  /** A rendered-frame liveness read. `--screen` and `--cursor` are mutually exclusive in Orca. */
  private async readScreen(st: OrcaSlotState): Promise<{ term: Record<string, unknown>; source: string }> {
    const env = await this.terminalOp("status", st, (h) => this.call("read", [
      "terminal", "read", "--terminal", h, "--screen",
    ], this.cliCwd(st)));
    const term = this.validated("status", st, env);
    const source = str(term.source);
    if (source !== "screen" && source !== "screen-unavailable") {
      throw new OrcaError("read", `screen read reports source ${source ?? "absent"}, not screen or screen-unavailable`, env.raw);
    }
    return { term, source };
  }

  /** A single UNPAGED tail read — exactly what the caller asked for and nothing more. Markers split
   *  across cursor pages are not reassembled here; that is waitOutput's job. */
  async read(slot: Slot, lines: number): Promise<string> {
    if (!Number.isInteger(lines) || lines <= 0) throw new OrcaError("read", `invalid line limit ${lines}`, "");
    const st = this.state(slot);
    const { term, raw } = await this.readPage("read", st, undefined, lines);
    return this.tailText("read", term, raw);
  }

  /**
   * Bounded cursor-paged sweep into the slot's accumulated buffer. The first read of a slot carries
   * no cursor: it is the ANCHOR, whose `oldestCursor` says where the retained buffer starts (its own
   * tail is the newest lines, not the oldest, so it is not appended). Every page after it appends,
   * and every one of them — anchor included — is status-validated before a single byte is matched.
   */
  private async sweep(st: OrcaSlotState): Promise<string> {
    let cursor = st.cursor;
    let anchored = cursor !== undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { term, raw, recovered } = await this.readPage("waitOutput", st, cursor, this.pageLines);
      if (recovered) {
        // recover() reset the slot cursor; reset this in-flight sweep too. The retried read was
        // deliberately rebuilt without the old cursor and is the replacement record's new anchor.
        cursor = undefined;
        anchored = false;
      }
      if (!anchored) {
        const oldest = str(term.oldestCursor);
        anchored = true;
        if (oldest === undefined) {
          // No cursors on this record: one shot is all there is.
          st.buf = (st.buf + this.tailText("waitOutput", term, raw) + "\n").slice(-MAX_BUF);
          return st.buf;
        }
        cursor = oldest;
        continue;
      }
      st.buf = (st.buf + this.tailText("waitOutput", term, raw) + "\n").slice(-MAX_BUF);
      const next = str(term.nextCursor);
      const latest = str(term.latestCursor);
      if (term.limited !== true || next === latest) {
        st.cursor = next ?? cursor;
        return st.buf;
      }
      if (next === undefined || next === cursor) {
        throw new OrcaError("read", "limited cursor page did not advance", raw);
      }
      cursor = next;
    }
    throw new OrcaUnavailableError("waitOutput", `cursor paging exceeded ${MAX_PAGES} pages`, "");
  }

  async waitOutput(slot: Slot, pattern: string, timeoutMs: number, opts?: { regex?: boolean }): Promise<boolean> {
    const st = this.state(slot);
    const re = opts?.regex ? new RegExp(pattern) : null; // compile once, not per poll
    const hit = (buf: string): boolean => {
      const joined = joinWrapped(buf);
      return re ? re.test(buf) || re.test(joined) : buf.includes(pattern) || joined.includes(pattern);
    };
    const deadline = this.time.now() + timeoutMs;
    for (;;) {
      if (hit(await this.sweep(st))) return true;
      const left = deadline - this.time.now();
      if (left <= 0) return false;
      await this.time.sleep(Math.min(this.pollMs, left));
    }
  }

  async status(slot: Slot): Promise<string> {
    const st = this.state(slot);
    for (;;) {
      const gen = `${st.runtimeId}:${st.handle}:${st.recoveries}`;
      // The status discipline's read leg: an exited/unknown READ status must block agent-state
      // reporting even when the show record alone would still look connected (show carries no
      // status field of its own, so a terminal can report "unknown"/"exited" on read while its
      // show row still says connected — the read leg is the only place that catches that).
      const screen = await this.readScreen(st);
      if (`${st.runtimeId}:${st.handle}:${st.recoveries}` !== gen) {
        continue;
      }
      // No rendered frame means no trustworthy TUI state. In particular, the stream fragments this
      // call replaced cannot license an idle verdict or a wait probe.
      if (screen.source === "screen-unavailable") return "unknown";

      const env = await this.terminalOp("show", st, (h) => this.call("show", ["terminal", "show", "--terminal", h], this.cliCwd(st)));
      if (`${st.runtimeId}:${st.handle}:${st.recoveries}` !== gen) {
        continue;
      }
      const term = this.liveShowTerm("status", st, env);
      if (term.agentWait === true) return "blocked";

      // Orca can only report tui-idle/agentWait for agents whose managed hook is installed. A
      // definitively unhooked adapter is unknown; an agent absent from Orca's table keeps the
      // legacy probe because absence is not proof that the CLI has no compatible status surface.
      if (await this.agentHookAvailable(st) === false) return "unknown";

      // `idle` is proven only by orca's own tui-idle condition: a 1ms wait is a point-in-time probe —
      // satisfied now → idle; elapsed (the recorded `timeout` refusal) → not idle.
      const isIdle = await this.waitCondition(st, "tui-idle", 1);
      if (`${st.runtimeId}:${st.handle}:${st.recoveries}` !== gen) {
        continue;
      }

      return mapAgentState(term, isIdle);
    }
  }

  private hookAgent(adapter: string): string {
    if (adapter === "claude-code") return "claude";
    if (adapter === "cursor-agent") return "cursor";
    return adapter;
  }

  /** true = hooked, false = definitively unhooked, undefined = agent absent from Orca's table. */
  private async agentHookAvailable(st: OrcaSlotState): Promise<boolean | undefined> {
    if (!st.agent) return undefined;
    this.hookCoverage ??= this.loadHookCoverage(st.cwd);
    const coverage = await this.hookCoverage;
    const state = coverage.states.get(this.hookAgent(st.agent));
    // The table's omission is deliberately inconclusive even when managed hooks are disabled:
    // Orca may not know this agent, so preserve the legacy probe exactly as an unlisted row does.
    if (state === undefined) return undefined;
    return coverage.enabled && state === "installed";
  }

  private async loadHookCoverage(cwd: string): Promise<{ enabled: boolean; states: Map<string, string> }> {
    const env = await this.call("hooks-status", ["agent", "hooks", "status"], cwd);
    if (typeof env.result.enabled !== "boolean") {
      throw new OrcaError("hooks-status", "response carries no boolean enabled", env.raw, { runtimeId: env.runtimeId });
    }
    const statuses = env.result.statuses;
    if (!Array.isArray(statuses)) {
      throw new OrcaError("hooks-status", "response carries no statuses array", env.raw, { runtimeId: env.runtimeId });
    }
    const states = new Map<string, string>();
    const allowed = new Set(["installed", "not_installed", "partial", "error"]);
    for (const row of statuses) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new OrcaError("hooks-status", "statuses carries a non-object row", env.raw, { runtimeId: env.runtimeId });
      }
      const agent = str((row as Record<string, unknown>).agent);
      const state = str((row as Record<string, unknown>).state);
      if (!agent || !state || !allowed.has(state)) {
        throw new OrcaError("hooks-status", "status row carries no valid agent/state pair", env.raw, { runtimeId: env.runtimeId });
      }
      states.set(agent, state);
    }
    return { enabled: env.result.enabled, states };
  }

  /** One `terminal wait` through the full identity machinery. The recorded 1.4.186 elapsed answer
   *  is rc 1 + ok:true + {handle, condition, satisfied:false, status:"running"}; it is "not yet"
   *  only after this method validates all four fields. Any malformed/refused wait remains explicit. */
  private async waitCondition(st: OrcaSlotState, condition: "exit" | "tui-idle", budgetMs: number): Promise<boolean> {
    const env = await this.terminalOp("wait", st, (h) => this.call("wait", [
      "terminal", "wait", "--terminal", h, "--for", condition, "--timeout-ms", String(Math.max(1, Math.floor(budgetMs))),
    ], this.cliCwd(st), budgetMs + 15_000));
    const receipt = env.result.wait;
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      throw new OrcaError("wait", "wait response carries no wait receipt", env.raw);
    }
    const w = receipt as Record<string, unknown>;
    if (str(w.handle) !== st.handle || str(w.condition) !== condition) {
      throw new OrcaError("wait", `wait receipt does not name ${condition} for ${st.handle}`, env.raw);
    }
    const rStatus = str(w.status);
    if (w.satisfied === false) {
      if (rStatus !== RUNNING_STATUS) {
        throw new OrcaUnavailableError(
          "wait",
          `terminal ${st.handle} reports status ${rStatus ?? "absent"}, not ${RUNNING_STATUS} in elapsed wait receipt`,
          env.raw,
          rStatus,
        );
      }
      return false;
    }
    if (w.satisfied !== true) {
      throw new OrcaError("wait", `wait receipt does not prove ${condition} is satisfied:true for ${st.handle}`, env.raw);
    }
    if (condition === "tui-idle" && rStatus !== RUNNING_STATUS) {
      throw new OrcaUnavailableError(
        "wait",
        `terminal ${st.handle} reports status ${rStatus ?? "absent"}, not ${RUNNING_STATUS} in wait receipt`,
        env.raw,
        rStatus,
      );
    }
    return true;
  }

  async waitAgentStatus(slot: Slot, status: string, timeoutMs: number): Promise<boolean> {
    const st = this.state(slot);
    const deadline = this.time.now() + timeoutMs;
    for (;;) {
      const genBefore = `${st.runtimeId}:${st.handle}:${st.recoveries}`;
      const now = await this.status(slot); // liveness- and identity-validated on every poll
      if (now === status) return true;
      if (`${st.runtimeId}:${st.handle}:${st.recoveries}` !== genBefore) {
        continue;
      }

      const left = deadline - this.time.now();
      if (left <= 0) return false;

      // "done" is terminal EXIT and "idle" is the tui-idle condition — the two things
      // `terminal wait` truthfully answers, each with the remaining budget in one call. "done" is
      // never command completion: `--command` runs inside a wrapper shell that outlives it (C2).
      if (status === "done" || status === "idle") {
        const cond = status === "done" ? "exit" : "tui-idle";
        const satisfied = await this.waitCondition(st, cond, left);
        if (`${st.runtimeId}:${st.handle}:${st.recoveries}` !== genBefore) {
          continue;
        }
        if (satisfied) return true;
      }

      const left2 = deadline - this.time.now();
      if (left2 <= 0) return false;
      await this.time.sleep(Math.min(this.pollMs, left2));
    }
  }

  async sendKey(slot: Slot, key: string): Promise<void> {
    const st = this.state(slot);
    this.assertAvailable("send", st);
    if (key === "enter") {
      await this.sendText(st, "");
      return;
    }
    if (key === "ctrl+c") {
      const env = await this.terminalOp("send", st, (h) => this.call(
        "send",
        ["terminal", "send", "--terminal", h, "--interrupt"],
        this.cliCwd(st),
      ), { mutating: true });
      // UNRECORDED SHAPE: Orca 1.4.195 was not captured for `send --interrupt`. Until a live
      // receipt exists, validate only the shared envelope and its handle binding; do not invent
      // accepted/bytesWritten semantics for an interrupt.
      this.sendReceipt(env, st);
      return;
    }
    throw new OrcaError("send", `Orca has no terminal key verb for ${JSON.stringify(key)}`, "");
  }

  async nudge(slot: Slot, message: string): Promise<boolean> {
    if (!message) return false;
    try {
      const st = this.state(slot);
      if (!await this.waitCondition(st, "tui-idle", 1)) return false;

      // Drain to the current stream cursor before sending. A message already present makes the
      // proof ambiguous, so decline rather than reporting delivery from old scrollback.
      const before = await this.sweep(st);
      if (before.includes(message) || joinWrapped(before).includes(message)) return false;
      await this.sendText(st, message);

      const deadline = this.time.now() + NUDGE_ECHO_TIMEOUT_MS;
      for (;;) {
        const after = await this.sweep(st);
        if (after.includes(message) || joinWrapped(after).includes(message)) return true;
        const left = deadline - this.time.now();
        if (left <= 0) return false;
        await this.time.sleep(Math.min(this.pollMs, left));
      }
    } catch {
      return false;
    }
  }

  async narrator(cwd: string, command: string, runId?: string): Promise<Slot> {
    if (!runId) throw new OrcaError("create", "Orca narrator requires a run identity", "");
    const slot = await this.slot(
      cwd,
      formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }),
      { owned: { role: "watch", taskId: "run", attempt: 0, runId } },
    );
    await this.run(slot, command);
    return slot;
  }

  async project(taskId: string, state: "in-progress" | "in-review" | "completed"): Promise<void> {
    const worktree = this.taskWorktrees.get(taskId);
    if (!worktree) {
      // The daemon projects in-progress immediately before it creates the task checkout/slot.
      // Hold only that latest state; slot() applies it once the task's own path is known.
      this.pendingProjects.set(taskId, state);
      return;
    }
    await this.setWorkspaceStatus(worktree, state);
  }

  private async setWorkspaceStatus(
    worktree: string,
    state: "in-progress" | "in-review" | "completed",
  ): Promise<void> {
    // UNRECORDED SHAPE: no Orca 1.4.195 `worktree set` receipt was captured. The shared envelope
    // parser is the complete success proof here; no result payload is assumed or fabricated.
    await this.call("worktree-set", [
      "worktree", "set", "--worktree", `path:${worktree}`, "--workspace-status", state,
    ], worktree);
  }

  async notify(msg: string, opts?: NotifyOpts): Promise<void> {
    if (opts?.tier === "routine") return;
    console.log(`[tickmarkr] ${msg}`); // console fallback only — notification injection is out of scope
  }

  narrateWith(narrate: (event: JournalEvent) => void): void {
    this.narrate = narrate;
  }

  async close(slot: Slot): Promise<void> {
    const st = this.slots.get(slot.id);
    if (!st) return;
    if (st.handle) await this.closeTerminal(st);
    this.slots.delete(slot.id);
  }

  /**
   * The one destructive call in this driver, for a slot's own terminal AND for a reconcile candidate
   * alike. It goes through terminalOp deliberately: the live runtime identity is proven immediately
   * BEFORE the handle goes on the wire, and a runtime that changed does not merely fail the close —
   * the handle is DISCARDED and re-derived from the owned tab title in that exact checkout, where a
   * handle value the new runtime happened to reissue to somebody else's terminal is refused by
   * construction (recover()). Checking identity on the receipt afterwards could not undo a close.
   */
  private async closeTerminal(st: OrcaSlotState): Promise<void> {
    this.assertAvailable("close", st);
    const env = await this.terminalOp("close", st, (h) => this.call("close", ["terminal", "close", "--terminal", h], this.cliCwd(st)), { mutating: true });
    // A handle-bound close receipt proves this terminal was removed. `ptyKilled` says whether a live
    // pty needed killing, not whether the terminal closed: Orca 1.4.186 returns false for an
    // already-exited/no-PTY leaf while still removing its terminal record.
    const receipt = env.result.close;
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      throw new OrcaError("close", "close response carries no close receipt", env.raw);
    }
    const r = receipt as Record<string, unknown>;
    if (str(r.handle) !== st.handle || (r.ptyKilled !== true && r.ptyKilled !== false)) {
      throw new OrcaError("close", `close receipt does not prove terminal ${st.handle} was closed`, env.raw);
    }
  }

  /**
   * The WHOLE terminal table. `terminal list` caps rows at its own default and says so through
   * `truncated`/`totalCount`; a capped listing is not an ownership snapshot, because the row it
   * dropped is precisely the older run's leftover no later sweep would ever see again.
   * ponytail: two asks, not a paging loop — `--limit` takes the whole table in one go, and a runtime
   * that still reports truncated at totalCount rows is a listing this sweep declines to judge on.
   */
  private async listAll(from: string): Promise<OrcaEnvelope> {
    const argv = (limit: number) => ["terminal", "list", "--include-visual-layouts", "--limit", String(limit)];
    const first = await this.call("list", argv(LIST_LIMIT), from);
    if (first.result.truncated !== true) return first;
    const total = typeof first.result.totalCount === "number" ? first.result.totalCount : 0;
    const whole = await this.call("list", argv(Math.max(total, LIST_LIMIT + 1)), from);
    if (whole.result.truncated === true) throw new OrcaError("list", "terminal list is still truncated at totalCount rows", whole.raw);
    return whole;
  }

  /**
   * Sweep tickmarkr-owned terminals down to `desired`. Ownership is decided ONLY by parseOwnedName
   * over the owned TAB title, through the same panesToClose fold herdr uses (drivers/types.ts): an
   * owned-and-undesired terminal closes whichever run — and whichever daemon — created it, and a
   * title that does not parse is never a candidate however much it resembles one.
   *
   * The listing is UNSCOPED and layout-bearing. Unscoped because an older run's leftover sits in a
   * checkout this run never knew, so a `--worktree`-filtered sweep is exactly how such a leftover
   * survives forever. Layout-bearing because the owned title survives at TAB identity only — a list
   * row's `title` is the shell-controlled pane title, and closing on that is how a foreign pane that
   * happens to be running an owned-looking command gets killed.
   *
   * Cosmetic by contract: every failure is swallowed, per candidate and overall.
   */
  async reconcile(desired: Set<string>, runId: string, opts?: { spareLiveLlm?: boolean }): Promise<void> {
    try {
      // Every call below is handle-addressed or explicitly selectored, so the CLI's own cwd selects
      // nothing — it only has to exist, which the checkouts being swept no longer need to.
      const from = process.cwd();
      const env = await this.listAll(from);
      const layouts = env.result.visualLayouts;
      if (!Array.isArray(layouts)) return; // no tab titles, no ownership evidence, nothing to close
      const candidates = new Map<string, { title: string; worktree: string }>();
      for (const layout of layouts) {
        if (typeof layout !== "object" || layout === null) continue;
        const lo = layout as Record<string, unknown>;
        const worktree = terminalWorktree(lo);
        if (!worktree) continue; // an unbound layout names no checkout to re-acquire a handle in
        const tabs: unknown[] = [];
        collectTabs(lo.root, tabs);
        for (const tab of tabs) {
          if (typeof tab !== "object" || tab === null) continue;
          const t = tab as Record<string, unknown>;
          const title = str(t.title);
          if (!title) continue;
          const handles: string[] = [];
          collectPaneHandles(t.panes, handles); // a split tab holds more than one, and both are ours
          for (const handle of handles) candidates.set(handle, { title, worktree: canonicalWorktreePath(worktree) });
        }
      }
      const toClose = panesToClose(
        [...candidates].map(([paneId, c]) => ({ name: c.title, paneId, workspaceId: ORCA_SPACE })),
        desired,
        ORCA_SPACE,
        runId,
        opts,
      );
      for (const c of toClose) {
        const cand = candidates.get(c.paneId);
        if (!cand) continue;
        try {
          await this.closeTerminal({
            title: cand.title,
            cwd: cand.worktree,
            dir: from,
            handle: c.paneId,
            runtimeId: env.runtimeId, // the identity that vouched for this handle, checked before the close
            buf: "",
            recoveries: 0,
            recovering: false,
          });
        } catch { /* vanished, stale, or no longer provably ours — never a blind retry */ }
      }
    } catch { /* cosmetic — visibility hygiene never fails the run */ }
  }

  // tickmarkr's own createWorktree stays the sole checkout authority — orca never makes worktrees.
  async worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    const worktree = await createWorktree(repo, branch, baseRef);
    const repoRoot = canonicalWorktreePath(repo);
    this.journalRoots.set(repoRoot, repoRoot);
    this.journalRoots.set(canonicalWorktreePath(worktree), repoRoot);
    return worktree;
  }
}
