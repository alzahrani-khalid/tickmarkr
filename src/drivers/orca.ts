import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { shq } from "../adapters/types.js";
import { createWorktree, FORK_CAP_ENV, resolvedForkCap, sh, type ShResult } from "../run/git.js";
import { Journal, type JournalEvent, parseRunId } from "../run/journal.js";
import { stateDirName } from "../graph/graph.js";
import { readWatchBoard, requestWatchBoardStop, stopWatchBoard, WATCH_OWNER_ENV, type WatchBoardOwner } from "../run/supervision.js";
import { MAX_BUF } from "./subprocess.js";
import { formatOwnedName, panesToClose, parseOwnedName, type ExecutorDriver, type FocusTarget, type FocusResult, type NotifyOpts, type Slot, type SlotOpts } from "./types.js";

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
//    an older run's leftover sits in a checkout this run never knew (T2);
//  - Orca tracks only the worktrees it created or the operator opened (1.4.200, OBS-1004): a task
//    checkout the daemon adds under the clone is not a selector, `worktree current` from inside it
//    answers the enclosing clone, and there is no adopt verb — so every terminal is created ON the
//    tracked worktree with its command cd'ed into the checkout, and `worktree set` names the
//    tracked worktree; identity stays the handle plus the owned tab title.

/** The response families the ONE shared envelope parser serves. There is no second JSON seam. */
export const ORCA_RESPONSE_FAMILIES = [
  "status", "create", "list", "read", "send", "wait", "show", "close",
  "worktree-current", "worktree-set", "hooks-status", "split",
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
const NUDGE_ECHO_TIMEOUT_MS = 2_000;
/** A missing slot gets the same bounded chance to appear as a reaped shell gets to settle. */
export const PENDING_PROJECT_GRACE_MS = 2_000;

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

/** OBS-1004: a reported (tracked) worktree encloses a checkout when it IS the checkout or a parent of it. */
function enclosesCheckout(reported: string | undefined, checkout: string): boolean {
  if (reported === undefined) return false;
  const tracked = canonicalWorktreePath(reported);
  return tracked === checkout || checkout.startsWith(`${tracked}/`);
}

/** The proof line a worker terminal prints first: create, recovery and focus read it back. */
export const CHECKOUT_MARK = "TICKMARKR_CHECKOUT";
// FX-N05: the proof is a FRAMED value — `TICKMARKR_CHECKOUT <byteLength>:<utf8 bytes as hex>;` — so it
// carries no whitespace or quotes, survives renderer wrapping (hex rows re-join losslessly), and is
// either complete (length matches, terminator present) or nothing. A prefix of another checkout can
// never decode to this one; `A` versus `A B`, `…--T1` versus `…--T10` are different frames.
const CHECKOUT_FRAME_RE = /TICKMARKR_CHECKOUT (\d+):([0-9a-f]*)(;?)/g;
const PROOF_PAGES = 16; // pages read from the oldest cursor before the proof is declared absent
const CHECKOUT_PROOF_TIMEOUT_MS = 2_000; // allow the wrapper shell to emit its startup proof

/** The exact bytes the create command prints as its first line. */
export function checkoutProofLine(checkout: string): string {
  const bytes = Buffer.from(checkout, "utf8");
  return `${CHECKOUT_MARK} ${bytes.length}:${bytes.toString("hex")};`;
}

/** Every complete frame in a scrollback, decoded and canonicalized; whether an incomplete one was seen. */
export function checkoutFrames(text: string): { complete: string[]; incomplete: boolean } {
  const complete: string[] = [];
  let incomplete = false;
  // Rows are re-joined first: a wrapped frame is whole again, and joining can never complete a
  // frame that was not printed whole — the declared length and the terminator decide.
  for (const m of joinWrapped(text).matchAll(CHECKOUT_FRAME_RE)) {
    const length = Number(m[1]);
    const hex = m[2]!;
    if (m[3] !== ";" || hex.length !== length * 2 || !Number.isInteger(length)) { incomplete = true; continue; }
    complete.push(canonicalWorktreePath(Buffer.from(hex, "hex").toString("utf8")));
  }
  return { complete, incomplete };
}

/** Does a scrollback prove exactly `checkout`: at least one complete frame equals it, no complete
 *  frame names anything else, and no frame is incomplete. Full-path equality after canonicalization —
 *  never a prefix, a substring, or a whitespace-terminated fragment. */
export function provesCheckout(text: string, checkout: string): boolean {
  const { complete, incomplete } = checkoutFrames(text);
  return !incomplete && complete.includes(checkout) && complete.every((c) => c === checkout);
}

/**
 * Everything a terminal on the tracked worktree runs before the payload: enter the checkout (a
 * failed cd stops the whole line — nothing of the payload ever runs in the enclosing path), print
 * the proof line, then hand the WHOLE payload to one `sh -c` so a background list, a `;` list or a
 * subshell inside it all start in the checkout and its exit status is the payload's (FX-N02).
 */
export function checkoutPrefix(checkout: string): string {
  return `cd ${shq(checkout)} && printf '%s\\n' ${shq(checkoutProofLine(checkout))} && sh -c `;
}

/** The command a terminal on the tracked worktree runs so that it executes INSIDE the checkout. */
export function inCheckout(checkout: string, cmd: string): string {
  return `${checkoutPrefix(checkout)}${shq(cmd)}`;
}

/** Every checkout the complete proof frames in a scrollback name, in order of appearance. */
export function checkoutsNamed(text: string): string[] {
  return checkoutFrames(text).complete;
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

/**
 * The Orca board owner record is the board's ONE lifecycle, and it lives on disk: every step below is
 * decided from the file (plus Orca's own terminal table), so a fresh OrcaDriver — a restarted daemon —
 * reaches the same answer as the instance that placed the board. No instance map or set carries it.
 *
 *   reserved  pane "", no claim            narrator, create-only, before the split can read its token
 *   claimed   pid + armId, pane ""         observer (observeNamedRun), written exactly once
 *   bound     claim + the receipt's handle and the split envelope's runtimeId
 *   retired   bound + retired:true         tombstone, CAS on the bound bytes; never answered again
 *
 * A retired record is replaced by a new reservation (CAS on the tombstone bytes) only once its pane
 * is proven gone. Everything else — a reservation or claim with no bound pane, a failed cleanup, a
 * record another driver holds with a live observer — refuses and keeps the record exactly as it is.
 */
/** `placer` is the pid of the narrator that wrote the reservation: a reserved or claimed record is a
 *  normal intermediate state while that pid lives (another driver awaiting listing or bind) and a
 *  crash to recover only once it is dead. */
type BoardRecord = WatchBoardOwner & { retired?: true; runtimeId?: string; placer?: number };
type BoardState = "reserved" | "claimed" | "bound" | "retired";

function boardState(r: BoardRecord): BoardState {
  if (r.retired === true) return "retired";
  if (typeof r.pid !== "number" || typeof r.armId !== "string") return "reserved";
  return r.pane === "" ? "claimed" : "bound";
}

/** The record's exact bytes and their parse; undefined only when no record exists. A torn or foreign
 *  file throws — it is indeterminate, never absent. */
function readBoard(path: string, repo: string, runId: string): { raw: string; record: BoardRecord } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const record = JSON.parse(raw) as BoardRecord;
  if (record.repo !== realpathSync(repo) || record.runId !== runId || typeof record.token !== "string" || typeof record.pane !== "string") {
    throw new Error(`watch owner record ${path} does not describe run ${runId} in ${repo}`);
  }
  return { raw, record };
}

/**
 * Whole-record compare-and-swap. The canonical path stays readable until commit: a mkdir lock
 * excludes other writers, then create-only `link`s the new inode (fails if anything exists) or
 * `rename`s the new file over the live path (POSIX atomic replace — readers see old or new, never
 * absence). A crash that leaves a `.tmp` or `.lock` does not drop the previous record.
 * Each lock generation publishes its pid and nonce atomically in a symlink target. A holder that died
 * between taking and releasing it is recovered at once (its lock is taken over in place); a live
 * holder bounds the wait on injected time and is then refused with the record untouched. A legacy
 * pid-less or malformed generation is recoverable too: a contender atomically creates the next owner
 * generation, and release removes the directory only while that exact generation is still current.
 * ponytail: observeNamedRun (supervision.ts) renames without CAS. It cannot interleave with a swap
 * because the narrator writes nothing between reserve and claim, and no transition here swaps one.
 */
export async function casBoard(family: string, path: string, expected: string | undefined, next: BoardRecord, time: OrcaTimeSource = SYSTEM_TIME): Promise<string> {
  const raw = JSON.stringify(next) + "\n";
  const refused = () => new OrcaError(family, `watch owner record ${path} changed underneath; swap refused and the current record kept`, "");
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = time.now() + LOCK_WAIT_MS;
  const ownerTarget = `${process.pid}:${randomUUID()}`;
  let ownerEntry = "";
  let acquiredEntries: string[] = [];
  for (;;) {
    try { mkdirSync(lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }

    // The marker's directory entry and target appear as one filesystem operation. If the creator
    // dies after mkdir but before this call, a contender claims owner.0; if both race, only one
    // symlink wins and the loser judges that published owner before entering the CAS section.
    const holder = lockHolder(lock);
    if (holder?.pid !== undefined && pidLive(holder.pid)) {
      if (time.now() >= deadline) throw new OrcaError(family, `watch owner record ${path} lock not acquired; current record kept`, "");
      await time.sleep(10);
      continue;
    }
    ownerEntry = `owner.${(holder?.gen ?? -1) + 1}`;
    try {
      symlinkSync(ownerTarget, join(lock, ownerEntry));
      // Snapshot only generations that this takeover superseded, with our marker last. Release must
      // never recursively scan: after our final unlink a contender may publish a replacement marker
      // before rmdir, and that marker belongs to the contender, not to this generation.
      acquiredEntries = readdirSync(lock)
        .filter((entry) => entry === ownerEntry || lockEntryGeneration(entry) !== undefined)
        .sort((a, b) => Number(a === ownerEntry) - Number(b === ownerEntry));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") throw error;
      continue; // another contender published this generation, or the prior holder just released
    }
  }
  try {
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== expected) throw refused();
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, raw);
    try {
      if (expected === undefined) {
        try { linkSync(tmp, path); } catch { throw refused(); }
      } else {
        renameSync(tmp, path);
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    return raw;
  } finally {
    releaseBoardLock(lock, ownerEntry, ownerTarget, acquiredEntries);
  }
}

const LOCK_WAIT_MS = 2_000;

/** Best-effort release cannot invalidate a committed CAS. Superseded entries go first and our marker
 * goes last; after that unlink, a non-recursive rmdir either removes the empty old generation or
 * leaves a contender's newly published marker untouched. Any abnormal filesystem error leaves the
 * lock for the next generation's stale-owner recovery instead of escaping from the caller's finally. */
function releaseBoardLock(lock: string, ownerEntry: string, ownerTarget: string, acquiredEntries: string[]): void {
  const holder = lockHolder(lock);
  if (holder?.entry !== ownerEntry || holder.target !== ownerTarget) return;
  for (const entry of acquiredEntries) {
    try { unlinkSync(join(lock, entry)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }
  try { rmdirSync(lock); }
  catch { /* ENOTEMPTY means a contender owns it; any other failure is recoverable stale state. */ }
}

/** The highest published generation. `pid*` files are accepted for recovery compatibility; new
 * owners use atomic `owner.N -> pid:nonce` symlinks. Missing or malformed contents return a
 * generation with no pid, which is stale and can only be superseded by creating the next marker. */
function lockHolder(lock: string): { gen: number; entry: string; target?: string; pid?: number } | undefined {
  try {
    const candidates = readdirSync(lock).flatMap((entry) => {
      const owner = /^owner\.(\d+)$/.exec(entry);
      const gen = lockEntryGeneration(entry);
      return gen === undefined ? [] : [{ gen, entry, owner: owner !== null }];
    }).sort((a, b) => b.gen - a.gen || Number(b.owner) - Number(a.owner));
    const current = candidates[0];
    if (!current) return undefined;
    let target: string;
    try {
      target = current.owner
        ? readlinkSync(join(lock, current.entry))
        : readFileSync(join(lock, current.entry), "utf8").trim();
    } catch {
      return { gen: current.gen, entry: current.entry };
    }
    const pidText = current.owner ? /^([1-9]\d*):.+$/.exec(target)?.[1] : target;
    const pid = Number(pidText);
    return Number.isInteger(pid) && pid > 0
      ? { gen: current.gen, entry: current.entry, target, pid }
      : { gen: current.gen, entry: current.entry, target };
  } catch { return undefined; }
}

function lockEntryGeneration(entry: string): number | undefined {
  const owner = /^owner\.(\d+)$/.exec(entry);
  const legacy = /^pid(?:\.(\d+))?$/.exec(entry);
  return owner ? Number(owner[1]) : legacy ? Number(legacy[1] ?? 0) : undefined;
}

function pidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function terminalRows(env: OrcaEnvelope): Record<string, unknown>[] {
  const rows = env.result.terminals;
  if (!Array.isArray(rows)) throw new OrcaError("list", "list response carries no terminals array", env.raw);
  return rows.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
}

function listsHandle(env: OrcaEnvelope, handle: string): boolean {
  return terminalRows(env).some((r) => str(r.handle) === handle);
}

/** A handle listed by a different runtime is not the recorded pane — Orca handles are runtime-scoped. */
function listedOnRuntime(env: OrcaEnvelope, handle: string, runtimeId: string | undefined): boolean {
  return typeof runtimeId === "string" && env.runtimeId === runtimeId && listsHandle(env, handle);
}

function terminalTabId(env: OrcaEnvelope, handle: string): string | undefined {
  for (const row of terminalRows(env)) {
    if (str(row.handle) === handle) return str(row.tabId);
  }
  return undefined;
}

/**
 * Orca 1.4.200 split contract: child at `result.split.handle`, parent tab at `result.split.tabId`.
 * A receipt that only happens to contain a handle is malformed — it does not establish that the
 * child belongs to the launching terminal's tab.
 */
function splitReceipt(env: OrcaEnvelope): { handle: string; tabId: string } {
  const receipt = env.result.split;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    throw new OrcaError("split", "split receipt is unknown, malformed or handle-less", env.raw);
  }
  const rec = receipt as Record<string, unknown>;
  const handle = str(rec.handle);
  const tabId = str(rec.tabId);
  if (!handle || !tabId) {
    throw new OrcaError("split", "split receipt is unknown, malformed or handle-less", env.raw);
  }
  return { handle, tabId };
}

function watchSlot(cwd: string, name: string, handle: string): Slot {
  return { id: handle, name, cwd: canonicalWorktreePath(cwd) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terminal-pane handles under a layout tab node: a pane object, an array of them, or a nested
 *  group/split carrying `panes`, `first`, `second`. Only `type:"terminal"` leaves count — anything else is chrome. */
function collectLeaves(node: unknown, out: { handle: string; title?: string }[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectLeaves(n, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const o = node as Record<string, unknown>;
  if (o.type === "terminal") {
    const h = str(o.handle);
    if (h) out.push({ handle: h, title: str(o.title) });
    return;
  }
  collectLeaves(o.panes, out);
  collectLeaves(o.first, out);
  collectLeaves(o.second, out);
}

function collectPaneHandles(node: unknown, out: string[]): void {
  const leaves: { handle: string; title?: string }[] = [];
  collectLeaves(node, leaves);
  for (const l of leaves) out.push(l.handle);
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

/** The OBS-1011 add.1 capture: `status:"exited", tail:[], returnedLineCount 0` from a stream read. */
export function isBlindStreamPage(term: Record<string, unknown>): boolean {
  return str(term.status) === "exited"
    && term.source !== "screen"
    && Array.isArray(term.tail) && term.tail.length === 0
    && (term.returnedLineCount === undefined || term.returnedLineCount === 0);
}

interface OrcaSlotState {
  title: string; // the FULL owned title — the durable TAB identity a relist matches on
  cwd: string; // the slot's exact checkout, canonicalized — where the command runs; the ownership identity
  // OBS-1004: the Orca-TRACKED worktree that encloses `cwd`, canonicalized — the only `path:` selector
  // Orca 1.4.200 resolves. Orca tracks the worktrees it created or the operator opened; a git worktree
  // the daemon adds under `.tickmarkr/worktrees.noindex/` is never adopted (`orca worktree --help`:
  // list/show/current/create/set/rm/ps — no adopt), and `worktree current` from inside it answers the
  // enclosing clone. Terminals are created ON this path with the command cd'ed into `cwd`; identity
  // is the handle plus the owned tab title, never the checkout.
  tracked?: string;
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
  launchingHandle?: string;
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
  private trackedByCheckout = new Map<string, string>(); // OBS-1004: checkout → the tracked worktree enclosing it
  private pendingProjects = new Map<string, {
    state: "in-progress" | "in-review" | "completed";
    since: number;
  }>();
  private env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  private launchingHandle?: string;
  private serialQueue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serialQueue.then(fn, fn);
    this.serialQueue = next.then(() => {}, () => {});
    return next;
  }

  constructor(opts: OrcaDriverOpts = {}) {
    this.env = opts.env ?? process.env;
    this.launchingHandle = opts.launchingHandle ?? this.env.ORCA_TERMINAL_HANDLE;
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
        await this.setWorkspaceStatus(worktree, pending.state);
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
  describe(slot: Slot): { surface?: string; hostPlatform?: string } | undefined {
    const st = this.state(slot);
    // The daemon asks only after run(), but callers probing a lazy slot must see absence rather
    // than an invented placement. The interface's object spread accepts this runtime absence.
    if (!st.handle) return undefined;
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

  private async sendText(st: OrcaSlotState, text: string, waitSubmit = false): Promise<Record<string, unknown>> {
    const env = await this.terminalOp("send", st, (h) => this.call(
      "send",
      ["terminal", "send", "--terminal", h, "--text", text, "--enter", ...(waitSubmit ? ["--wait-submit", "15"] : [])],
      this.cliCwd(st),
    ), { mutating: true });
    // Recorded 1.4.195 send receipt: result.send = {handle, accepted, bytesWritten}. `ok:true`
    // alone is not delivery: the accepted receipt must name this handle and account for the bytes.
    const receipt = this.sendReceipt(env, st);
    const expectedBytes = Buffer.byteLength(text, "utf8") + 1;
    if (receipt.accepted !== true || typeof receipt.bytesWritten !== "number" || receipt.bytesWritten !== expectedBytes) {
      throw new OrcaError("send", `send receipt does not report expected byte delivery (accepted: ${JSON.stringify(receipt.accepted)}, bytesWritten: ${receipt.bytesWritten}, expected: ${expectedBytes})`, env.raw);
    }
    return receipt;
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
    const tracked = await this.trackedWorktree(st.cwd);
    st.tracked = tracked;
    // The selector names the TRACKED worktree enclosing this slot's checkout outright — never the
    // UI's active worktree (`active`/`current`) nor the daemon's cwd — and the command itself moves
    // into the checkout, because Orca cannot be asked to place a terminal in a path it does not
    // track (OBS-1004). Shell startup can swallow that prefix; prove it from scrollback below.
    const payload = `export ${FORK_CAP_ENV}=${shq(process.env[FORK_CAP_ENV] ?? resolvedForkCap())}; ${cmd}`;
    const env = await this.call("create", [
      "terminal", "create", "--worktree", `path:${tracked}`, "--title", st.title, "--command", inCheckout(st.cwd, payload),
    ], this.cliCwd(st));
    const term = requireTerminal("create", env);
    const handle = str(term.handle);
    if (!handle) throw new OrcaError("create", "create receipt carries no terminal handle", env.raw);
    // Asking is not getting: the receipt says which worktree the runtime actually resolved, and a
    // terminal bound elsewhere has already lost the isolation this run is built on.
    const worktree = terminalWorktree(term);
    if (!sameWorktree(worktree, tracked)) {
      // `terminal create` has ALREADY launched the command in that wrong checkout, so refusing the
      // receipt is not yet fail-closed: the agent keeps mutating it. Close the exact handle this
      // receipt named, under the runtime that answered it (closeTerminal re-proves that identity
      // before the handle goes on the wire), then latch — the slot is not addressable again, so a
      // retrying dispatch never opens a second terminal beside one that must not exist. The close
      // is best effort; the latch is what holds if it fails.
      try {
        await this.closeTerminal({ ...st, handle, runtimeId: env.runtimeId });
      } catch { /* already gone, or no longer provably ours — never a blind retry */ }
      throw this.latched("create", st, `create receipt bound to ${worktree ?? "no worktree"}, not the tracked ${tracked} enclosing ${st.cwd}`, env.raw);
    }
    // A receipt only proves placement on the enclosing tracked checkout. Wait briefly for the
    // startup command's proof before run() can resolve and the daemon can count a worker launch.
    const deadline = this.time.now() + CHECKOUT_PROOF_TIMEOUT_MS;
    let proof = await this.checkoutProven(handle, st.cwd, this.cliCwd(st), env.runtimeId);
    while (!proof.proven && this.time.now() < deadline) {
      await this.time.sleep(POLL_MS);
      proof = await this.checkoutProven(handle, st.cwd, this.cliCwd(st), env.runtimeId);
    }
    if (!proof.proven) {
      try {
        await this.closeTerminal({ ...st, handle, runtimeId: env.runtimeId });
      } catch { /* best effort under the answering runtime; the latch prevents another launch */ }
      throw this.latched("create", st, `terminal ${handle} does not prove checkout ${st.cwd} (${proof.reason})`, env.raw);
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
   * OBS-1004: the tracked worktree that encloses a checkout, asked ONCE of `worktree current` from
   * inside that checkout. Orca answers the exact path when it tracks the checkout itself, the
   * enclosing tracked clone for a git worktree the daemon added beneath it (1.4.200, verified from
   * `.tickmarkr/worktrees.noindex/<task>`), and selector_not_found when nothing it tracks encloses
   * the cwd — which is a driver failure, not something to wait out: Orca has no adopt verb.
   */
  private async trackedWorktree(checkout: string): Promise<string> {
    const cached = this.trackedByCheckout.get(checkout);
    if (cached) return cached;
    const env = await this.call("worktree-current", ["worktree", "current"], checkout);
    const worktree = env.result.worktree;
    if (typeof worktree !== "object" || worktree === null || Array.isArray(worktree)) {
      throw new OrcaError("worktree-current", "response carries no worktree record", env.raw, { runtimeId: env.runtimeId });
    }
    const reported = terminalWorktree(worktree as Record<string, unknown>);
    if (!reported) throw new OrcaError("worktree-current", "worktree record carries no path", env.raw, { runtimeId: env.runtimeId });
    const tracked = canonicalWorktreePath(reported);
    if (tracked !== checkout && !checkout.startsWith(`${tracked}/`)) {
      throw new OrcaError("worktree-current", `Orca answered ${tracked}, which does not enclose ${checkout}`, env.raw, { runtimeId: env.runtimeId });
    }
    this.trackedByCheckout.set(checkout, tracked);
    return tracked;
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

  /**
   * FX-N01/N05/N06: under a shared enclosing worktree every task terminal lists with the same
   * worktreePath, so the tracked path + owned title cannot tell two nested checkouts apart. The
   * runtime's own proof is the terminal's earliest scrollback, where the create command printed a
   * framed `TICKMARKR_CHECKOUT` line before its payload (checkoutProofLine). READ-only calls: the
   * anchor (for `oldestCursor`), then pages from the oldest cursor until a frame is complete or the
   * bound is hit. Every page is evidence only when the response's own identity is the candidate's:
   * the terminal record must name `handle` and `_meta.runtimeId` must be `runtimeId` — the runtime
   * that supplied the ownership listing — else another terminal's or another runtime's bytes were
   * answered and nothing is proven. Proven means provesCheckout: exact canonical full-path equality
   * of a complete frame, no other checkout named, no incomplete frame.
   */
  private async checkoutProven(handle: string, checkout: string | undefined, from: string, runtimeId: string): Promise<{ proven: boolean; reason: string }> {
    const page = async (cursor?: string): Promise<Record<string, unknown>> => {
      const env = await this.call("read", [
        "terminal", "read", "--terminal", handle, ...(cursor === undefined ? [] : ["--cursor", cursor]), "--limit", String(this.pageLines),
      ], from);
      if (env.runtimeId !== runtimeId) {
        throw new OrcaError("read", `proof page answered by runtime ${env.runtimeId}, not the listing's ${runtimeId}`, env.raw);
      }
      const term = requireTerminal("read", env);
      if (str(term.handle) !== handle) {
        throw new OrcaError("read", `proof page names terminal ${str(term.handle) ?? "none"}, not the candidate ${handle}`, env.raw);
      }
      return term;
    };
    const lines = (term: Record<string, unknown>): string[] =>
      Array.isArray(term.tail) ? term.tail.filter((l): l is string => typeof l === "string") : [];
    try {
      const anchor = await page();
      let cursor = str(anchor.oldestCursor);
      let text = cursor === undefined ? lines(anchor).join("\n") : "";
      for (let n = 0; cursor !== undefined && n < PROOF_PAGES; n++) {
        const term = await page(cursor);
        text += `${lines(term).join("\n")}\n`;
        const frames = checkoutFrames(text);
        if (frames.complete.length > 0 && !frames.incomplete) break; // whole frames, nothing dangling
        const next = str(term.nextCursor);
        if (term.limited !== true || next === undefined || next === cursor) break;
        cursor = next;
      }
      const frames = checkoutFrames(text);
      // Reconcile has no task-checkout path after a daemon restart, but the proof itself remains
      // an ownership record: exactly one complete, unambiguous checkout frame can only have been
      // written by tickmarkr's create command.  Slot recovery additionally requires its exact path.
      if (checkout === undefined
        ? !frames.incomplete && frames.complete.length > 0 && new Set(frames.complete).size === 1
        : provesCheckout(text, checkout)) return { proven: true, reason: "" };
      return {
        proven: false,
        reason: `its scrollback ${frames.complete.length ? `names ${[...new Set(frames.complete)].join(", ")}` : "names no checkout"}${frames.incomplete ? " and carries an incomplete proof frame" : ""}`,
      };
    } catch (error) {
      return { proven: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async recover(family: string, st: OrcaSlotState, newRuntimeId: string | undefined, raw: string): Promise<void> {
    if (st.recovering) throw this.latched(family, st, "handle recovery re-entered", raw);
    st.recovering = true;
    try {
      const old = st.handle;
      // visualLayouts is required: the owned title survives at TAB identity only, and rows carry
      // just the shell-controlled pane title (recorded: "…probe…" at create → "bash" on the row).
      const home = st.tracked ?? st.cwd; // the worktree Orca placed this terminal in (OBS-1004)
      const env = await this.call("list", ["terminal", "list", "--worktree", `path:${home}`, "--include-visual-layouts", "--limit", String(LIST_LIMIT)], this.cliCwd(st));
      const listed = env.result.terminals;
      if (!Array.isArray(listed)) throw new OrcaError("list", "list response carries no terminals array", env.raw);
      if (env.result.truncated === true) throw new OrcaError("list", "terminal list is truncated, cannot safely recover handle", env.raw);
      const layouts = env.result.visualLayouts;
      if (!Array.isArray(layouts)) throw new OrcaError("list", "list response carries no visualLayouts array — owned tab titles are not recoverable", env.raw);
      // The worktree-authoritative rows of THIS worktree: a handle is adoptable only if a row in
      // the slot's exact worktree backs it. A same-titled tab in another worktree is a lookalike.
      const inWorktree = new Set(
        listed
          .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && sameWorktree(terminalWorktree(t), home))
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
        if (!sameWorktree(terminalWorktree(lo), home)) continue; // another worktree's tabs are never candidates
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
        throw this.latched(family, st, `no tab in ${home} carries the owned title ${st.title} (row titles are shell-controlled and are never ownership keys)`, env.raw);
      }
      if (ownedTabs.length > 1) {
        throw this.latched(family, st, `${ownedTabs.length} tabs in ${home} carry the owned title ${st.title} — ambiguous`, env.raw);
      }
      const panes = ownedTabs[0].filter((h) => inWorktree.has(h));
      if (panes.length !== 1) {
        throw this.latched(family, st, `the owned tab resolves to ${panes.length} terminals in ${home}`, env.raw);
      }
      const handle = panes[0];
      if (handle === old) {
        // Handles are runtime-scoped: the same VALUE under a different runtime proves nothing about
        // which terminal it addresses, so it is never adopted.
        throw this.latched(family, st, `replacement handle ${handle} is the old handle value reused by runtime ${newRuntimeId ?? env.runtimeId ?? "unknown"}`, env.raw);
      }
      if (st.tracked !== undefined && st.tracked !== st.cwd) {
        // FX-N01: a nested checkout shares its worktreePath with every sibling task's terminal, so
        // the candidate must prove the checkout itself (read-only) before it is addressed as ours.
        const proof = await this.checkoutProven(handle, st.cwd, this.cliCwd(st), env.runtimeId);
        if (!proof.proven) {
          throw this.latched(family, st, `candidate ${handle} does not prove checkout ${st.cwd} (${proof.reason}); the sole same-titled tab on ${home} is not adopted`, env.raw);
        }
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
    if (isBlindStreamPage(requireTerminal(family, env))) {
      return { term: await this.screenBehindBlindStream(family, st, env), raw: env.raw, recovered };
    }
    return { term: this.validated(family, st, env), raw: env.raw, recovered };
  }

  /**
   * OBS-1011 add.1 / OBS-1016: the captured incident shape — a stream page answering status exited
   * with an empty tail on a terminal that accepted a send seconds earlier — is BLIND, not dead, when
   * the same handle's show record on the same runtime reports connected and not orphaned (show carries
   * no status field; none is demanded) and its screen read reports running. Then the rendered frame is
   * the terminal's bytes. Anything less — disconnected, orphaned, another handle or runtime, a screen
   * that is unavailable or exited — is refused as unavailable, exactly as the dead record would be.
   */
  private async screenBehindBlindStream(family: string, st: OrcaSlotState, blind: OrcaEnvelope): Promise<Record<string, unknown>> {
    const handle = str(requireTerminal(family, blind).handle);
    if (handle !== st.handle) {
      throw new OrcaUnavailableError(family, `terminal record names ${handle ?? "no handle"}, not the addressed ${st.handle}`, blind.raw);
    }
    const show = await this.call("show", ["terminal", "show", "--terminal", st.handle!], this.cliCwd(st));
    if (show.runtimeId !== st.runtimeId) {
      throw new OrcaUnavailableError(family, `exited-shaped stream page: show answered by runtime ${show.runtimeId}, not the bound ${st.runtimeId}`, show.raw, "exited");
    }
    this.liveShowTerm(family, st, show);
    const screen = await this.readScreen(st);
    if (screen.source !== "screen") {
      throw new OrcaUnavailableError(family, `exited-shaped stream page and no rendered screen for ${st.handle}`, blind.raw, "exited");
    }
    return screen.term;
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
      const receipt = await this.sendText(st, message, true);
      // OBS-1016: delivery is proven by the receipt — a prompt stage of turn_started — or by the
      // composer emptying on a screen read, never by stream echo: the stream is blind on a live Orca
      // terminal (OBS-1011 add.1), so an echo sweep fails every nudge and latches the harvest hold.
      const prompt = typeof receipt.prompt === "object" && receipt.prompt !== null && !Array.isArray(receipt.prompt)
        ? receipt.prompt as Record<string, unknown>
        : {};
      const stages = Array.isArray(prompt.stages) ? prompt.stages : [];
      if (stages.includes("turn_started")) return true;
      const deadline = this.time.now() + NUDGE_ECHO_TIMEOUT_MS;
      for (;;) {
        const screen = await this.readScreen(st);
        // ponytail: "composer emptied" is "the text is no longer on the frame" — a TUI that keeps the
        // submitted turn on screen reads as undelivered until the timeout; the receipt stage is primary.
        if (screen.source === "screen") {
          const frame = this.tailText("status", screen.term, "");
          if (!frame.includes(message) && !joinWrapped(frame).includes(message)) return true;
        }
        const left = deadline - this.time.now();
        if (left <= 0) return false;
        await this.time.sleep(Math.min(this.pollMs, left));
      }
    } catch {
      return false;
    }
  }

  async narrator(cwd: string, command: string, runId?: string): Promise<Slot> {
    if (!runId) throw new OrcaError("split", "Orca narrator requires a run identity", "");
    const launchingHandle = (this.launchingHandle ?? this.env.ORCA_TERMINAL_HANDLE)?.trim();
    if (!launchingHandle) throw new OrcaError("split", "Orca narrator requires ORCA_TERMINAL_HANDLE", "");

    return this.serial(async () => {
      const name = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
      const path = this.boardPath(cwd, runId);
      const kept = `indeterminate cleanup refused — owner record ${path} kept`;
      let current = readBoard(path, cwd, runId);
      if (current && (current.record.driver !== this.id || current.record.name !== name)) {
        // Never overwrite a record this driver did not create, unless its observer is provably gone.
        const { driver, pid } = current.record;
        if (typeof pid !== "number" || pidLive(pid)) {
          throw new OrcaError("split", `Orca narrator placement refused for ${name}: the record is held by driver ${driver} with a live or unclaimed observer; ${kept}`, "");
        }
      } else if (current) {
        const state = boardState(current.record);
        if (state === "reserved" || state === "claimed") {
          // A reservation or claim with no bound pane is the placing narrator's normal intermediate
          // state while that narrator lives (awaiting its receipt, listing, claim or bind): refused
          // untouched, its observer never asked to stop. Only a DEAD placer (or one unrecorded) makes
          // it a crash to recover.
          const { placer } = current.record;
          if (typeof placer !== "number" || pidLive(placer)) {
            throw new OrcaError("split", `Orca narrator placement remains unresolved for ${name} (${state}, no bound pane) while placing narrator ${placer ?? "unrecorded"} lives; ${kept}`, "");
          }
        }
        if (state === "claimed") {
          // The placing driver crashed between the observer's claim and its bind. The record is
          // replaced only once that observer is proven gone: dead outright, or live and stopped with
          // its acknowledgement awaited on injected time — unacknowledged, it is refused untouched.
          const pid = current.record.pid as number;
          if (pidLive(pid)) {
            try {
              await stopWatchBoard(current.record, this.time);
            } catch (error) {
              throw new OrcaError("split", `Orca narrator placement refused for ${name}: claimed board's live observer unacknowledged; ${kept}; ${errorText(error)}`, "");
            }
          }
          const retired: BoardRecord = { ...current.record, retired: true };
          current = { raw: await casBoard("split", path, current.raw, retired, this.time), record: retired };
        }
        if (state === "reserved") {
          // The placer died before any claim: no observer exists, its split pane (if any) is unknown
          // to the record. Tombstoned in place so the generic tail below replaces it.
          const retired: BoardRecord = { ...current.record, retired: true };
          current = { raw: await casBoard("split", path, current.raw, retired, this.time), record: retired };
        }
        if (state === "bound") {
          // The bound record is the durable truth of placement: the child handle PLUS the split
          // envelope's runtime identity. A handle listed by a later runtime is a different pane.
          if (listedOnRuntime(await this.listAll(cwd), current.record.pane, current.record.runtimeId)) {
            return watchSlot(cwd, name, current.record.pane);
          }
          // Lost: this runtime no longer has that pane. Tombstone before anything else.
          const retired: BoardRecord = { ...current.record, retired: true };
          current = { raw: await casBoard("split", path, current.raw, retired, this.time), record: retired };
        }
        // A tombstone can be an acknowledgement timeout, not completed observer cleanup. A live
        // observer must stop and ack on injected time before the handle-bound close; timeout keeps
        // the tombstone and does not replace it.
        try {
          if (typeof current.record.pid === "number" && pidLive(current.record.pid)) {
            await stopWatchBoard(current.record, this.time);
          } else {
            requestWatchBoardStop(current.record);
          }
        } catch (error) {
          throw new OrcaError("split", `Orca narrator placement refused for ${name}: retired board observer unacknowledged; ${kept}; ${errorText(error)}`, "");
        }
        try {
          await this.closeRecordedPane(cwd, name, current.record.pane, current.record.runtimeId);
        } catch (error) {
          throw new OrcaError("split", `Orca narrator placement refused for ${name}: retired board pane ${current.record.pane} not proven closed; ${kept}; ${errorText(error)}`, "");
        }
      }

      // Reserve before any command can read the token: create-only, or a swap of the exact record
      // judged replaceable above.
      const token = randomUUID();
      await casBoard("split", path, current?.raw, { repo: realpathSync(cwd), runId, driver: this.id, workspace: ORCA_SPACE, pane: "", name, token, placer: process.pid }, this.time);
      // A reservation that can never be bound — no usable receipt, or no claim — is tombstoned so the
      // next narrator call splits afresh instead of refusing forever. Only THIS reservation, and only
      // while it is still the untouched reservation; a record anyone else moved is left to them.
      const tombstone = async (extra: Partial<BoardRecord> = {}): Promise<void> => {
        try {
          const now = readBoard(path, cwd, runId);
          if (now?.record.token === token && boardState(now.record) === "reserved") {
            await casBoard("split", path, now.raw, { ...now.record, ...extra, retired: true }, this.time);
          }
        } catch { /* the record is kept as it stands; the next narrator judges it */ }
      };

      // Exactly one terminal split of the launching handle, horizontal, carrying token and command.
      // An unknown receipt (transport failure, refusal, unparseable output) after the verb was issued
      // is as indeterminate as a handle-less one: the pane may exist, so the reservation stays.
      const env = await this.call("split", [
        "terminal", "split",
        "--terminal", launchingHandle,
        "--direction", "horizontal",
        "--command", `${WATCH_OWNER_ENV}=${shq(token)} ${command}`,
      ], cwd).catch(async (error: unknown) => {
        await tombstone();
        throw new OrcaError("split", `Orca narrator placement failed for ${name}: split receipt is unknown (${error instanceof OrcaError ? error.reason : errorText(error)}); ${kept}`, error instanceof OrcaError ? error.raw : "");
      });
      let child: { handle: string; tabId: string };
      try {
        child = splitReceipt(env);
      } catch {
        await tombstone();
        throw new OrcaError("split", `Orca narrator placement failed for ${name}: split receipt is unknown, malformed or handle-less; ${kept}`, env.raw);
      }
      // Parent tabId must name the launching terminal's tab, and the child must actually appear
      // there. A handle-only object, a tabId for some other tab, or a handle the list does not
      // place in that tab is malformed — closing it would be a guessed handle.
      let listing: OrcaEnvelope;
      try {
        listing = await this.listAll(cwd);
      } catch (error) {
        await tombstone();
        throw new OrcaError("split", `Orca narrator placement failed for ${name}: split receipt is unknown, malformed or handle-less; ${kept}`, error instanceof OrcaError ? error.raw : env.raw);
      }
      const launchingTabId = terminalTabId(listing, launchingHandle);
      if (
        !launchingTabId
        || child.tabId !== launchingTabId
        || child.handle === launchingHandle
        || terminalTabId(listing, child.handle) !== launchingTabId
      ) {
        await tombstone();
        throw new OrcaError("split", `Orca narrator placement failed for ${name}: split receipt is unknown, malformed or handle-less; ${kept}`, env.raw);
      }
      const childHandle = child.handle;

      // The narrator writes nothing until the observer's single claim is visible, so neither write
      // can erase the other; after it the observer never writes the record again.
      const claimDeadline = this.time.now() + 5000;
      let claim: { raw: string; record: BoardRecord } | undefined;
      for (;;) {
        const check = readBoard(path, cwd, runId);
        if (check?.record.token !== token) break;
        if (boardState(check.record) === "claimed") {
          claim = check;
          break;
        }
        if (this.time.now() > claimDeadline) break;
        await this.time.sleep(20);
      }
      if (!claim) {
        // The receipt's handle may be closed; the reservation is tombstoned naming that pane so the
        // next narrator can prove it gone (or close it) and split afresh.
        await tombstone({ pane: childHandle, runtimeId: env.runtimeId });
        let pane: string;
        try {
          await this.closeRecordedPane(cwd, name, childHandle, env.runtimeId);
          pane = `its pane ${childHandle} was closed`;
        } catch (error) {
          pane = `its pane ${childHandle} was not proven closed (${errorText(error)})`;
        }
        throw new OrcaError("split", `Orca narrator board unclaimed for ${name}: the observer never claimed the record (unclaimed board); ${kept}; ${pane}`, env.raw);
      }

      await casBoard("split", path, claim.raw, { ...claim.record, pane: childHandle, runtimeId: env.runtimeId }, this.time);
      return watchSlot(cwd, name, childHandle);
    });
  }

  private boardPath(cwd: string, runId: string): string {
    return join(cwd, stateDirName(cwd), "supervision", `watch-board.${parseRunId(runId)}.json`);
  }

  /** A recorded pane (a receipt's handle bound to the split envelope's runtime, never a guess) is
   *  gone when that runtime no longer lists it, or when a handle-bound close receipt names it.
   *  A handle listed by a different runtime is a different pane — not closed, treated as gone. */
  private async closeRecordedPane(cwd: string, name: string, handle: string, runtimeId?: string): Promise<void> {
    const listing = await this.listAll(cwd);
    if (!listedOnRuntime(listing, handle, runtimeId)) return;
    await this.closeTerminal({
      title: name, cwd: canonicalWorktreePath(cwd), handle, runtimeId, buf: "", recoveries: 0, recovering: false,
    });
  }

  /** bound → retired, decided from the record alone: it must be this driver's board for exactly this
   *  slot's pane. Already retired is returned as it is. */
  private async retireBoard(family: string, slot: Slot): Promise<BoardRecord> {
    const runId = parseOwnedName(slot.name)?.runId;
    const path = runId ? this.boardPath(slot.cwd, runId) : undefined;
    const current = path && runId ? readBoard(path, slot.cwd, runId) : undefined;
    const r = current?.record;
    if (!path || !current || !r || r.driver !== this.id || r.name !== slot.name || r.pane !== slot.id || boardState(r) === "reserved" || boardState(r) === "claimed") {
      throw new OrcaError(family, `watch ownership unknown or foreign for ${slot.name}; existing board protected`, "");
    }
    if (r.retired) return r;
    const retired: BoardRecord = { ...r, retired: true };
    await casBoard(family, path, current.raw, retired, this.time);
    return retired;
  }

  /** bound → retired first: whatever fails below, no later call answers this board again. A live
   *  observer is asked to stop and its acknowledgement awaited on injected time before the
   *  handle-bound close (timeout keeps the tombstone and the pane); a dead one never acknowledges,
   *  so it is only asked. */
  private async retireAndClose(slot: Slot): Promise<void> {
    await this.serial(async () => {
      const retired = await this.retireBoard("close", slot);
      if (typeof retired.pid === "number" && pidLive(retired.pid)) await stopWatchBoard(retired, this.time);
      else requestWatchBoardStop(retired);
      await this.closeRecordedPane(slot.cwd, slot.name, slot.id, retired.runtimeId);
    });
  }

  /** WB-1 seam: the daemon reports this board lost. "Lost" can be a stale beat or missing presence
   *  under a still-live owner pid, so it is not proof of a dead observer — retirement keeps close's
   *  acknowledgement discipline (Leg-2 T9 P1). */
  async retireLostWatch(slot: Slot): Promise<void> {
    await this.retireAndClose(slot);
  }

  async focus(target: FocusTarget): Promise<FocusResult> {
    const { slot, runId, taskId, attempt } = target;
    const cwd = canonicalWorktreePath(slot.cwd);
    if (slot.name !== formatOwnedName({ role: "worker", taskId, attempt, runId })) {
      return { status: "foreign", reason: "Recorded run/task/attempt ownership does not match" };
    }
    try {
      const env = await this.listAll(cwd);
      const rows = env.result.terminals;
      const layouts = env.result.visualLayouts;
      if (!Array.isArray(rows) || !Array.isArray(layouts)) return { status: "unsupported", reason: "Cannot verify Orca terminal ownership" };
      const handles: string[] = [];
      for (const layout of layouts) {
        if (typeof layout !== "object" || layout === null) continue;
        const lo = layout as Record<string, unknown>;
        if (!enclosesCheckout(terminalWorktree(lo), cwd)) continue; // the tracked worktree Orca placed it in (OBS-1004)
        const tabs: unknown[] = [];
        collectTabs(lo.root, tabs);
        for (const tab of tabs) {
          if (typeof tab === "object" && tab !== null && str((tab as Record<string, unknown>).title) === slot.name) collectPaneHandles((tab as Record<string, unknown>).panes, handles);
        }
      }
      if (handles.length !== 1) return { status: rows.length ? "foreign" : "closed", reason: "No unique owned terminal in the recorded worktree" };
      const matches = rows.filter(row => typeof row === "object" && row !== null && str(row.handle) === handles[0] && enclosesCheckout(terminalWorktree(row), cwd));
      if (matches.length !== 1) return { status: "foreign", reason: "Terminal worktree ownership is unverified" };
      if (!sameWorktree(terminalWorktree(matches[0]), cwd)) {
        // FX-N01: the row only ENCLOSES the recorded checkout — require the terminal's own proof line.
        const proof = await this.checkoutProven(handles[0]!, cwd, cwd, env.runtimeId);
        if (!proof.proven) return { status: "foreign", reason: `Terminal checkout ownership is unverified: ${proof.reason}` };
      }
      if (matches[0].connected === false || matches[0].orphaned === true) return { status: "closed", reason: "Recorded terminal is no longer running; open task evidence" };
      return { status: "unsupported", reason: "Owned terminal verified; this Orca API has no focus operation. Open task evidence with Enter" };
    } catch (error) { return { status: "unsupported", reason: `Cannot verify Orca focus target: ${String(error)}` }; }
  }

  async project(taskId: string, state: "in-progress" | "in-review" | "completed"): Promise<void> {
    const worktree = this.taskWorktrees.get(taskId);
    if (!worktree) {
      // The daemon projects in-progress immediately before it creates the task checkout/slot.
      // Hold only that latest state; slot() applies it once the task's own path is known.
      this.pendingProjects.set(taskId, { state, since: this.time.now() });
      return;
    }
    await this.setWorkspaceStatus(worktree, state);
  }

  private async setWorkspaceStatus(
    checkout: string,
    state: "in-progress" | "in-review" | "completed",
  ): Promise<void> {
    // OBS-1004: the task checkout is not an Orca selector (`selector_not_found`, recorded on run
    // 0004's T5); the projection lands on the tracked worktree that encloses it.
    const tracked = await this.trackedWorktree(checkout);
    // UNRECORDED SHAPE: no Orca 1.4.195 `worktree set` receipt was captured. The shared envelope
    // parser is the complete success proof here; no result payload is assumed or fabricated.
    await this.call("worktree-set", [
      "worktree", "set", "--worktree", `path:${tracked}`, "--workspace-status", state,
    ], checkout);
  }

  async notify(msg: string, opts?: NotifyOpts): Promise<void> {
    if (opts?.tier === "routine") return;
    console.log(`[tickmarkr] ${msg}`); // console fallback only — notification injection is out of scope
  }

  narrateWith(narrate: (event: JournalEvent) => void): void {
    this.narrate = narrate;
  }

  async close(slot: Slot): Promise<void> {
    if (parseOwnedName(slot.name)?.role === "watch") {
      await this.retireAndClose(slot);
      return;
    }
    const st = this.slots.get(slot.id);
    if (!st) return;
    if (st.handle) {
      await this.closeTerminal(st);
    }
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

  private openRunJournal(runId: string): Journal | undefined {
    const roots = new Set(this.journalRoots.values());
    roots.add(process.cwd());
    for (const repoRoot of roots) {
      try {
        return Journal.open(repoRoot, runId, this.narrate);
      } catch {
        /* try the next daemon-bound root */
      }
    }
    return undefined;
  }

  // A projection exists only to bridge project() to the worker slot that follows it. After the
  // grace, desired remains the dispatch oracle: a declared worker is still being placed and must
  // keep its projection. Make genuine absence durable by appending first and deleting second; with
  // no writable run journal the entry remains eligible for a later reconcile.
  private dropExpiredProjects(desired: Set<string>, runId: string): void {
    const now = this.time.now();
    const desiredTasks = new Set<string>();
    for (const name of desired) {
      const owned = parseOwnedName(name);
      if (owned?.role === "worker") desiredTasks.add(owned.taskId);
    }
    const expired = [...this.pendingProjects].filter(([, pending]) =>
      now - pending.since > PENDING_PROJECT_GRACE_MS
    ).filter(([taskId]) => !desiredTasks.has(taskId));
    if (expired.length === 0) return;
    const journal = this.openRunJournal(runId);
    if (!journal) return;
    for (const [taskId, pending] of expired) {
      try {
        const pendingMs = Math.max(0, now - pending.since);
        journal.append("project-unplaced", taskId, {
          state: pending.state,
          pendingMs,
          graceMs: PENDING_PROJECT_GRACE_MS,
        });
        this.pendingProjects.delete(taskId);
      } catch {
        /* reconcile is cosmetic; preserve the projection until a later journalled drop */
      }
    }
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
    this.dropExpiredProjects(desired, runId);
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
          const leaves: { handle: string; title?: string }[] = [];
          collectLeaves(t.panes, leaves);
          const launching = (this.launchingHandle ?? this.env.ORCA_TERMINAL_HANDLE)?.trim();
          // A tab title belongs to the tab, not to a leaf. After the operator moves the worker
          // out, a foreign shell can sit alone under that owned title — so every leaf, including
          // the only leaf of a single-leaf tab, needs the durable checkout proof. A title that
          // does not parse is never a candidate.
          if (!parseOwnedName(title)) continue;
          for (const leaf of leaves) {
            if (launching && leaf.handle === launching) continue;
            if (this.isRecordedWatchHandle(leaf.handle, worktree, runId, env.runtimeId)) continue;
            if (!await this.isRecordedWorkerHandle(leaf.handle, from, env.runtimeId)) continue;
            candidates.set(leaf.handle, { title, worktree: canonicalWorktreePath(worktree) });
          }
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
  private isRecordedWatchHandle(handle: string, cwd: string, runId: string | undefined, runtimeId: string): boolean {
    const matches = (record: { pane?: unknown; runtimeId?: unknown } | undefined): boolean =>
      !!record && record.pane === handle && record.runtimeId === runtimeId;
    if (runId && matches(readWatchBoard(cwd, runId))) return true;
    try {
      const dir = join(cwd, stateDirName(cwd), "supervision");
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (f.startsWith("watch-board.") && f.endsWith(".json")) {
            const content = JSON.parse(readFileSync(join(dir, f), "utf8"));
            if (content && typeof content === "object" && matches(content as { pane?: unknown; runtimeId?: unknown })) return true;
          }
        }
      }
    } catch (error) {
      // Ownership uncertainty fails closed: abort this best-effort reconcile before it can treat a
      // recorded watch as an ordinary title-keyed worker. The outer reconcile boundary remains
      // cosmetic, but no close is attempted from a partial supervision-directory read.
      throw new OrcaError("list", `watch ownership unreadable in ${cwd}: ${errorText(error)}`, "");
    }
    return false;
  }
  private async isRecordedWorkerHandle(handle: string, from: string, runtimeId: string): Promise<boolean> {
    // Do not use the driver's in-memory slots as the boundary: reconcile is also responsible for
    // terminals made before this driver process started.  `create()` writes this proof before its
    // worker payload, and checkoutProven reads it from Orca rather than trusting a fixture handle.
    return (await this.checkoutProven(handle, undefined, from, runtimeId)).proven;
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
