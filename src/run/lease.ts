import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { trustedCommonDir } from "./git-trust.js";

// The process census and command admission deliberately use the same command-head classifier.
export function isRunnerCommand(command: string): boolean {
  // Inspect executable positions only: inference prompts and shell script bodies may name runners.
  let head = command.trim().replace(/['"]/g, "");
  for (;;) {
    const unwrapped = head
      .replace(/^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+/i, "")
      .replace(/^cd\s+[^;&|]+\s*&&\s*/, "")
      .replace(/^(?:env\s+)?(?:[A-Za-z_]\w*=\S+\s+)+/, "");
    if (unwrapped === head) break;
    head = unwrapped;
  }
  const binary = "(?:\\S*/)?";
  const flags = "(?:\\s+(?:--?[\\w-]+(?:=[^\\s]+)?|--))*";
  const manager = `${binary}(?:npm|pnpm|yarn|bun)${flags}`;
  const jsRunner = `${binary}(?:vitest(?:\\.mjs)?|jest|mocha)(?:\\s|$)`;
  // Test scripts may be scoped (test:unit, test.integration); runner binaries may be launched
  // through a manager. Keep each match anchored to that executable position so prompt/argument
  // mentions stay out. OBS-1045: the scope is `test` followed by a `:` or `.` separator — the npm
  // scoping convention — so a differently named script such as `test-lint` is never leased.
  return new RegExp(`^${manager}\\s+(?:run${flags}\\s+)?test(?:[:.][\\w.-]+)?(?:\\s|$)`, "i").test(head)
    || new RegExp(`^${manager}\\s+(?:(?:exec|x|dlx)${flags}\\s+)?${jsRunner}`, "i").test(head)
    || new RegExp(`^${binary}npx${flags}\\s+${jsRunner}`, "i").test(head)
    || /^(?:\S*\/)?(?:go|make|cargo)\s+test(?:\s|$)/i.test(head)
    || /^(?:(?:\S*\/)?(?:node|npx)\s+)?(?:\S*\/)?(?:vitest(?:\.mjs)?|jest|mocha|pytest(?:\d+(?:\.\d+)*)?)(?:\s|$)/i.test(head)
    || /^(?:\S*\/)?python[\d.]*\s+-m\s+pytest(?:\s|$)/i.test(head);
}

export const COMMAND_LEASE_TOKEN_ENV = "TICKMARKR_LEASE_TOKEN";
export type CommandLease = <T>(command: string, run: (token?: string) => Promise<T>) => Promise<T>;
const context = new AsyncLocalStorage<CommandLease>();
const ownership = new AsyncLocalStorage<{ token: string; active: boolean }>();

/** Async descendants share the reservation; a shell's descendants inherit the same token. */
export function currentCommandLeaseToken(): string | undefined {
  const owner = ownership.getStore();
  return owner ? (owner.active ? owner.token : undefined) : process.env[COMMAND_LEASE_TOKEN_ENV] || undefined;
}

/** Never export a command's token through process.env: concurrent sibling commands must queue. */
export function commandLeaseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  const token = currentCommandLeaseToken();
  if (token) child[COMMAND_LEASE_TOKEN_ENV] = token;
  else delete child[COMMAND_LEASE_TOKEN_ENV];
  return child;
}

export const runWithCommandLease = <T>(lease: CommandLease, run: () => Promise<T>): Promise<T> =>
  context.run(lease, run);
export const withCommandLease = <T>(command: string, run: () => Promise<T>): Promise<T> => {
  const lease = context.getStore();
  if (!lease || !isRunnerCommand(command) || currentCommandLeaseToken()) return run();
  return lease(command, token => {
    const owner = { token: token ?? randomUUID(), active: true };
    return ownership.run(owner, async () => {
      try { return await run(); }
      finally { owner.active = false; } // A continuation after release must acquire a new lease.
    });
  });
};

/** Each reservation releases only itself, including an aborted waiter. */
export class CommandLeases {
  private readonly owners = new Set<symbol>();
  async run<T>(run: () => Promise<T>, waiting: (count: number) => void, pollMs: number, signal?: AbortSignal): Promise<T> {
    const owner = Symbol("command");
    this.owners.add(owner);
    try {
      let reported = false;
      while (this.owners.values().next().value !== owner) {
        signal?.throwIfAborted();
        if (!reported) { waiting(this.owners.size - 1); reported = true; }
        await new Promise((wake) => setTimeout(wake, pollMs));
      }
      signal?.throwIfAborted();
      return await run();
    } finally {
      this.owners.delete(owner);
    }
  }
}

/**
 * OBS-1042: the standalone battery's cross-process lease. Two `tickmarkr verify` runs in two linked
 * worktrees of one clone share NO daemon and NO state directory, so the in-process `CommandLeases`
 * above never saw each other and both full suites ran on one host. This reservation is keyed on the
 * repository's COMMON git dir (`git rev-parse --git-common-dir`), which every linked worktree of a
 * clone shares and an unrelated repository never does. One file, created exclusively; the holder
 * writes its pid and cwd so a waiter can journal who it waits on and reclaim a reservation whose
 * holder is dead. Each reservation releases only itself: a waiter that never acquired removes nothing,
 * so cancelling it never frees the holder. The daemon's adoption is deferred to 2.5.7.
 */
export interface RepositoryLeaseHolder {
  pid: number; cwd: string; at: number; token: string;
  /** Exact owner birth and token-bound execution roots; retained across owner death. */
  identity?: string;
  protectOrphans?: true;
  /** The owner settled; only its protected tree can still block reclamation. */
  ownerReleased?: true;
  roots?: number[];
  rootBirths?: Record<string, string>;
}
/** Queue row 120: a live process keeping a dead or released holder's lease, as the wait names it: pid, executable and
 * cwd. Its arguments and environment are never printed or read (`ps -o comm=`, the census's cwd-only probe). */
export interface LeaseBlocker { pid: number; executable: string; cwd?: string }
export interface RepositoryLeaseOptions {
  pollMs?: number;
  signal?: AbortSignal;
  /** Called once per distinct holder the waiter is queued behind, and again whenever the set of processes keeping a
   * dead holder's lease changes; `blockers` names that set (queue row 120). */
  onWait?: (holder: RepositoryLeaseHolder, blockers?: readonly LeaseBlocker[]) => void;
  /** The token a descendant inherited; defaults to REPOSITORY_LEASE_TOKEN_ENV. */
  inherited?: string;
  /** Manifest jobs bridge capabilities through explicit child environments, never process.env. */
  isolated?: boolean;
  protectOrphans?: boolean;
  onAdmission?: (holder: RepositoryLeaseHolder) => void;
  onRelease?: () => void;
  /** A new job inside an existing job cannot borrow that job's async capability. */
  independent?: boolean;
}

/** OBS-880/1071: the file lease's token, exported to the holder's descendants for the span it is held
 * so a nested runner (a gate's suite under `tickmarkr verify`, a mutation child inside a leased suite)
 * reenters instead of waiting on its own ancestor. Deliberately NOT COMMAND_LEASE_TOKEN_ENV: the
 * installed daemon clears and rewrites that in-process token, and a command-lease token never names
 * this file. Environment text alone proves nothing: see `reentrantHolder`. */
export const REPOSITORY_LEASE_TOKEN_ENV = "TICKMARKR_REPOSITORY_LEASE_TOKEN";

/** The strict ancestors of this process, from one `ps` snapshot; empty when unreadable (fail closed). */
const ancestorPids = (): Promise<Set<number>> => new Promise((ok) => execFile("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }, (error, stdout) => {
  const parent = new Map<number, number>();
  if (!error) for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parent.set(pid!, ppid!);
  }
  const seen = new Set<number>();
  for (let pid = error ? 0 : process.ppid; pid > 1 && !seen.has(pid); pid = parent.get(pid) ?? 0) seen.add(pid);
  ok(seen);
}));

/** Reentry is identity-bound: the inherited token must name the record at THIS repository's lease path
 * right now, its holder must be alive, and that holder must be a strict ancestor of this process. A
 * forged, stale (released or superseded), foreign-repository or command-lease token matches no record;
 * an in-process sibling is not a descendant — each of those waits like any other runner. */
export async function reentrantHolder(path: string, inherited: string | undefined): Promise<RepositoryLeaseHolder | undefined> {
  if (!inherited) return undefined;
  const holder = readHolder(path);
  if (holder?.token !== inherited || holder.pid === process.pid || !holderAlive(holder)) return undefined;
  return (await ancestorPids()).has(holder.pid) ? holder : undefined;
}

const LEASE_FILE = "tickmarkr-runner.lease";

export async function repositoryLeasePath(cwd: string): Promise<string> {
  return join(trustedCommonDir(cwd), LEASE_FILE);
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
const isCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

/** OBS-1057: dev+ino alone is not an identity across unlink/recreate — Linux hands the freed inode
 * number straight to the next file, so a stale observation of a dead or corrupt reservation matched
 * the fresh reservation that replaced it and reclaimDead removed the live winner (public CI, ubuntu).
 * The bytes are the generation: a fragment never hashes like a complete record, and two complete
 * records differ by token. Size and mtime are not enough (a same-length reservation written within
 * the filesystem's timestamp resolution — Leg-2 review of the first cut). */
export const inodeIdentity = (st: { dev: number | bigint; ino: number | bigint }, bytes: string | Buffer): string =>
  `${st.dev}-${st.ino}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

/** The identity a reclaimer would observe at a path right now, or undefined when nothing is there. */
export const observeIdentity = (path: string): string | undefined => readOccupant(path)?.identity;

/** What sits at the lease path, read through one descriptor so bytes and identity always describe
 * the same inode even when another process replaces the pathname. */
type Occupant = { holder: RepositoryLeaseHolder | undefined; identity: string } | undefined;
const readOccupant = (path: string): Occupant => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    const bytes = readFileSync(fd, "utf8");
    const identity = inodeIdentity(st, bytes);
    try {
      const holder = JSON.parse(bytes) as RepositoryLeaseHolder;
      if (typeof holder.pid === "number" && typeof holder.cwd === "string" && typeof holder.token === "string") return { holder, identity };
    } catch { /* incomplete/foreign bytes are reclaimable under the mutation lock */ }
    return { holder: undefined, identity };
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
export const readHolder = (path: string): RepositoryLeaseHolder | undefined => readOccupant(path)?.holder;

/** Crash-recoverable serialization for lease-path mutations. The highest atomic owner-generation
 * symlink is authoritative. A process killed in the critical section leaves its pid behind, so one
 * contender can exclusively publish the next generation and finish the interrupted operation. */
const mutationLock = (path: string) => `${path}.lock`;
const lockGeneration = (entry: string): number | undefined => {
  const match = /^owner\.(\d+)$/.exec(entry);
  return match ? Number(match[1]) : undefined;
};
const mutationHolder = (lock: string): { entry: string; gen: number; target?: string; pid?: number } | undefined => {
  let names: string[];
  try { names = readdirSync(lock); } catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
  const current = names.flatMap((entry) => {
    const gen = lockGeneration(entry);
    return gen === undefined ? [] : [{ entry, gen }];
  }).sort((a, b) => b.gen - a.gen)[0];
  if (!current) return undefined;
  try {
    const target = readlinkSync(join(lock, current.entry));
    const pid = Number(/^([1-9]\d*):/.exec(target)?.[1]);
    return Number.isInteger(pid) && pid > 0 ? { ...current, target, pid } : { ...current, target };
  } catch { return current; }
};
const releaseMutationLock = (lock: string, entry: string, target: string, inherited: string[]): void => {
  const holder = mutationHolder(lock);
  if (holder?.entry !== entry || holder.target !== target) return;
  // Remove our marker last. A successor published after that point is never in this snapshot.
  for (const name of [...inherited, entry]) {
    try { unlinkSync(join(lock, name)); } catch (error) { if (!isCode(error, "ENOENT")) return; }
  }
  try { rmdirSync(lock); } catch { /* ENOTEMPTY: a successor owns the directory */ }
};
const withMutationLock = async <T>(path: string, pollMs: number, signal: AbortSignal | undefined, run: () => T | Promise<T>): Promise<T> => {
  const lock = mutationLock(path);
  const target = `${process.pid}:${randomUUID()}`;
  let entry = "";
  let inherited: string[] = [];
  for (;;) {
    signal?.throwIfAborted();
    try { mkdirSync(lock); } catch (error) { if (!isCode(error, "EEXIST")) throw error; }
    const holder = mutationHolder(lock);
    if (holder?.pid !== undefined && alive(holder.pid)) {
      await new Promise((wake) => setTimeout(wake, pollMs));
      continue;
    }
    entry = `owner.${(holder?.gen ?? -1) + 1}`;
    try {
      symlinkSync(target, join(lock, entry));
      inherited = readdirSync(lock).filter((name) => name !== entry && lockGeneration(name) !== undefined);
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST") && !isCode(error, "ENOENT")) throw error;
    }
  }
  try { return await run(); }
  finally { releaseMutationLock(lock, entry, target, inherited); }
};

/** Publish `mine` at `path` atomically: the record is written whole to a private file and linked
 * into place — `link` is exclusive (EEXIST when the path is taken) and a reader never sees a partial
 * record, so a process killed at any point of its acquisition leaves either nothing or a complete
 * record naming a pid a waiter can check. Returns false when the path is taken. */
export function tryReserve(path: string, mine: RepositoryLeaseHolder): boolean {
  const draft = `${path}.${mine.token}.draft`;
  writeFileSync(draft, JSON.stringify(mine) + "\n");
  try { linkSync(draft, path); return true; }
  catch (error) { if (isCode(error, "EEXIST")) return false; throw error; }
  finally { rmSync(draft, { force: true }); }
}

/** Link the inspected dead inode to its stable tombstone, then remove the canonical name. This runs
 * only under the mutation lock. EEXIST means an earlier reclaimer died after link: recovery finishes
 * only if both names still bind that exact inode, never a replacement holder. */
const reclaimDeadLocked = (path: string, identity: string): boolean => {
  const tombstone = `${path}.dead-${identity}`;
  try { linkSync(path, tombstone); }
  catch (error) { if (!isCode(error, "EEXIST") && !isCode(error, "ENOENT")) throw error; }
  const dead = readOccupant(tombstone);
  const current = readOccupant(path);
  if (dead?.identity !== identity || current?.identity !== identity) return false;
  unlinkSync(path);
  return true;
};

/** Exposed for recovery regressions; the standalone verify uses the combined critical section. */
export const reclaimDead = async (path: string, identity: string, pollMs = 10): Promise<boolean> =>
  withMutationLock(path, pollMs, undefined, () => reclaimDeadLocked(path, identity));

const inspectAndReserve = async (path: string, mine: RepositoryLeaseHolder): Promise<{ acquired: boolean; holder?: RepositoryLeaseHolder; blocking?: number[] }> => {
  let occupant = readOccupant(path);
  const dead = occupant?.holder !== undefined && !holderAlive(occupant.holder);
  // A dead holder's protected tree is what keeps the lease; the waiter is told which processes those are (queue row 120).
  const blocking = dead && occupant!.holder!.protectOrphans ? await protectedProcesses(occupant!.holder!) : [];
  if (occupant && (!occupant.holder || (dead && !blocking.length))) {
    reclaimDeadLocked(path, occupant.identity);
    occupant = readOccupant(path);
  }
  if (!occupant && tryReserve(path, mine)) return { acquired: true };
  return { acquired: false, holder: occupant?.holder, ...(blocking.length ? { blocking } : {}) };
};

/** Each blocker's pid, executable and working directory, and NO argument: `ps -o comm=` (a command line joins argv with
 * spaces, so no redaction could tell where a secret value ends, D-1710). The cwd comes from the census's cwd-only probe
 * (async, batched, never rejecting, no environment read; queue row 103: no synchronous lsof on a waiting loop), imported
 * lazily because suite-census imports this module. Diagnostics only: an unreadable process reads "(executable
 * unreadable)", and this never throws into the wait. */
export async function describeLeaseBlockers(pids: readonly number[]): Promise<LeaseBlocker[]> {
  const rows = await new Promise<string>((done) => {
    try { execFile("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], { encoding: "utf8", timeout: 5_000 }, (_error, stdout) => done(stdout ?? "")); }
    catch { done(""); }
  });
  const executables = new Map(rows.split("\n").flatMap((line) => { const row = /^\s*(\d+)\s+(.*)$/.exec(line); return row ? [[Number(row[1]), row[2]!.trim()] as const] : []; }));
  const cwds = await import("./suite-census.js").then(({ batchedProcessCwds }) => batchedProcessCwds(pids)).catch(() => undefined);
  return pids.map((pid) => {
    const cwd = cwds?.get(pid);
    return { pid, executable: executables.get(pid) || "(executable unreadable)", ...(cwd ? { cwd } : {}) };
  });
}
/** The wait's own words: the holder alone while it lives; once it has exited or released the lease, every process still
 * keeping it. */
export function describeLeaseWait(holder: RepositoryLeaseHolder, blockers?: readonly LeaseBlocker[]): string {
  const held = `held by pid ${holder.pid} in ${holder.cwd}`;
  if (!blockers?.length) return held;
  const named = blockers.map((b) => `pid ${b.pid} ${b.executable}${b.cwd ? ` (cwd ${b.cwd})` : ""}`).join("; ");
  return `${held}, which has exited or released it; ${blockers.length} process(es) it started still run and keep the lease until they exit: ${named}`;
}

// A durable capability is also a crash owner: census checks the exact generation's inherited
// environment and recorded process groups, including live orphans reparented after owner death.
// An unreadable census refuses reclamation/release. No dead-pid shortcut admits over a live tree.
export async function protectedProcesses(holder: RepositoryLeaseHolder, tokenEnv = REPOSITORY_LEASE_TOKEN_ENV, ownedOnly = false): Promise<number[]> {
  let censusPid: number | undefined;
  const rows = await new Promise<string>((ok, fail) => { const census = execFile("ps", ["eww", "-A", "-o", "pid=,ppid=,pgid=,stat=,command="],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? fail(error) : ok(stdout)); censusPid = census.pid; });
  const token = `${tokenEnv}=${holder.token}`;
  const lines = rows.split("\n");
  const safeGroups = new Set((holder.roots ?? []).filter(pid => {
    const leader = lines.some(line => new RegExp(`^\\s*${pid}\\s+\\d+\\s+${pid}\\s+`).test(line));
    // A leaderless group still belongs to its recorded root; a reused leader must match its birth.
    return !leader || sameProcessBirth(processBirth(pid), holder.rootBirths?.[pid]);
  }));
  const parsed = lines.flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), stat: match[4]!, command: match[5]! }] : [];
  });
  const parents = new Map(parsed.map(row => [row.pid, row.parent]));
  const descendant = (pid: number) => {
    const seen = new Set<number>();
    for (let at = parents.get(pid) ?? 0; at > 1 && !seen.has(at); at = parents.get(at) ?? 0) {
      if (at === holder.pid) return true;
      seen.add(at);
    }
    return false;
  };
  return parsed.flatMap(row => {
    if (row.stat.startsWith("Z") || row.pid === holder.pid || row.pid === censusPid) return [];
    const group = safeGroups.has(row.group);
    const capability = row.command.split(/\s+/).includes(token);
    // Copied environment text outside the owned tree can conservatively block reclamation, but
    // can never authorize signalling an unrelated process. Birth-checked groups survive reparenting.
    return group || (capability && (!ownedOnly || descendant(row.pid))) ? [row.pid] : [];
  });
}
interface RepositoryOwnership { path: string; holder: RepositoryLeaseHolder; active: boolean }
const repositoryOwnership = new AsyncLocalStorage<RepositoryOwnership>();
export const repositoryLeaseEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const own = repositoryOwnership.getStore();
  if (!own) return { ...env };
  const child = { ...env };
  if (own.active) child[REPOSITORY_LEASE_TOKEN_ENV] = own.holder.token;
  else delete child[REPOSITORY_LEASE_TOKEN_ENV];
  return child;
};
/** Called synchronously at spawn, before any user callback, and only on an owned generation. */
export function registerRepositoryChild(pid: number | undefined): void {
  const own = repositoryOwnership.getStore();
  if (!own?.active || !own.holder.protectOrphans || pid === undefined) return;
  if (readHolder(own.path)?.token !== own.holder.token) throw new Error("verification reservation superseded before child registration");
  own.holder.roots = [...new Set([...(readHolder(own.path)?.roots ?? []), pid])];
  const birth = processBirth(pid);
  own.holder.rootBirths = { ...readHolder(own.path)?.rootBirths, ...(birth ? { [pid]: birth } : {}) };
  const draft = `${own.path}.${own.holder.token}.${process.pid}.roots`;
  try {
    writeFileSync(draft, JSON.stringify(own.holder) + "\n");
    renameSync(draft, own.path);
  } finally { rmSync(draft, { force: true }); }
}
export const withFreshCommandLease = <T>(command: string, run: () => Promise<T>): Promise<T> =>
  ownership.run({ token: "", active: false }, () => withCommandLease(command, run));
const repositoryQueues = new Map<string, Set<symbol>>();
/** Queue row 120: the queue head's last view of what keeps a dead holder's lease, so in-process followers name it too. */
const repositoryBlocking = new Map<string, { token: string; blocking: readonly number[] }>();

/** The standalone wrapper uses the same command-then-repository order when a scheduler exists.
 * Without one (CLI/global setup), this remains exactly the outer file reservation API. */
export function withRepositoryLease<T>(cwd: string, run: () => Promise<T>, opts: RepositoryLeaseOptions = {}): Promise<T> {
  return opts.isolated ? repositoryLease(cwd, run, opts)
    : withCommandLease("vitest run", () => repositoryLease(cwd, run, opts));
}
export const hasRepositoryLeaseOwnership = (): boolean => repositoryOwnership.getStore()?.active === true;
async function repositoryLease<T>(cwd: string, run: () => Promise<T>, opts: RepositoryLeaseOptions): Promise<T> {
  const path = await repositoryLeasePath(cwd);
  const own = repositoryOwnership.getStore();
  // Only the private async capability can reenter within this process. Environment text cannot.
  if (!opts.independent && own?.active && own.path === path && readHolder(path)?.token === own.holder.token) {
    opts.onAdmission?.(own.holder);
    const value = await run();
    opts.onRelease?.(); // this caller's span ends; the outer reservation stays owned
    return value;
  }
  if (await reentrantHolder(path, opts.inherited ?? process.env[REPOSITORY_LEASE_TOKEN_ENV])) {
    const holder = readHolder(path)!;
    const inheritedOwner = { path, holder, active: true };
    return repositoryOwnership.run(inheritedOwner, async () => {
      opts.onAdmission?.(holder);
      try { const value = await run(); opts.onRelease?.(); return value; } finally { inheritedOwner.active = false; }
    });
  }
  const pollMs = opts.pollMs ?? 1_000;
  const mine: RepositoryLeaseHolder = { pid: process.pid, cwd, at: Date.now(), token: randomUUID(),
    ...(opts.protectOrphans !== false ? { protectOrphans: true, roots: [], identity: ownerIdentity() } : {}) };
  const queue = repositoryQueues.get(path) ?? new Set<symbol>();
  repositoryQueues.set(path, queue);
  const ticket = Symbol("repository job");
  queue.add(ticket);
  let waitingOn: string | undefined;
  const waitOn = async (holder: RepositoryLeaseHolder | undefined, blocking: readonly number[] = []) => {
    const key = holder && `${holder.token}\0${[...blocking].sort((a, b) => a - b).join(",")}`;
    if (holder && key !== waitingOn) {
      waitingOn = key;
      opts.onWait?.(holder, blocking.length ? await describeLeaseBlockers(blocking) : undefined);
    }
  };
  try {
    for (;;) {
      opts.signal?.throwIfAborted();
      if (queue.values().next().value === ticket) {
        const attempt = await withMutationLock(path, pollMs, opts.signal, () => inspectAndReserve(path, mine));
        if (attempt.acquired) { repositoryBlocking.delete(path); break; }
        if (attempt.holder) repositoryBlocking.set(path, { token: attempt.holder.token, blocking: attempt.blocking ?? [] });
        await waitOn(attempt.holder, attempt.blocking);
      } else {
        const holder = readHolder(path);
        const seen = repositoryBlocking.get(path);
        await waitOn(holder, holder && seen?.token === holder.token ? seen.blocking : []);
      }
      await new Promise(wake => setTimeout(wake, pollMs));
    }
    const exported = process.env[REPOSITORY_LEASE_TOKEN_ENV];
    if (!opts.isolated) process.env[REPOSITORY_LEASE_TOKEN_ENV] = mine.token;
    const owner = { path, holder: mine, active: true };
    try {
      return await repositoryOwnership.run(owner, async () => {
        opts.signal?.throwIfAborted();
        opts.onAdmission?.(mine);
        return run();
      });
    } finally {
      owner.active = false;
      if (!opts.isolated && process.env[REPOSITORY_LEASE_TOKEN_ENV] === mine.token) {
        if (exported === undefined) delete process.env[REPOSITORY_LEASE_TOKEN_ENV];
        else process.env[REPOSITORY_LEASE_TOKEN_ENV] = exported;
      }
      // All token-bound children, including escaped descendants, cease before release. Shell has
      // already reaped its group; this closes the inherited-pipe/escaped-child boundary as well.
      if (mine.protectOrphans) await reapRepositoryChildren(mine, pollMs).catch(async error => {
        // A failed census or reap deadline must not leave a settled job naming a live owner
        // forever. Retain the exact generation and its roots for the orphan rule: admission
        // still requires a successful census proving the protected tree has ceased.
        await withMutationLock(path, pollMs, undefined, () => {
          const holder = readHolder(path);
          if (holder?.token !== mine.token) return;
          const draft = `${path}.${mine.token}.${process.pid}.released`;
          try {
            writeFileSync(draft, JSON.stringify({ ...holder, ownerReleased: true }) + "\n");
            renameSync(draft, path);
          } finally { rmSync(draft, { force: true }); }
        });
        throw error;
      });
      await withMutationLock(path, pollMs, undefined, () => {
        if (readHolder(path)?.token === mine.token) unlinkSync(path);
      });
      opts.onRelease?.();
    }
  } finally {
    queue.delete(ticket);
    if (!queue.size) { repositoryQueues.delete(path); repositoryBlocking.delete(path); }
    // A waiter removes no repository generation, including cancellation before acquisition.
  }
}
function processBirth(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
}

function ownerIdentity(): string | undefined {
  const birth = processBirth(process.pid);
  // Match git.ts's independent identity format without changing recorded raw root births.
  return birth ? `${process.pid}:${canonicalBirth(birth)}` : undefined;
}

const canonicalBirth = (birth: string): string => birth.trim().replace(/\s+/g, " ");
const sameProcessBirth = (actual: string | undefined, expected: string | undefined): boolean =>
  actual !== undefined && expected !== undefined && canonicalBirth(actual) === canonicalBirth(expected);

export async function reapRepositoryChildren(holder: RepositoryLeaseHolder, pollMs: number, tokenEnv = REPOSITORY_LEASE_TOKEN_ENV): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (const pid of await protectedProcesses(holder, tokenEnv, true)) {
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (!isCode(error, "ESRCH")) throw error; }
  }
  while ((await protectedProcesses(holder, tokenEnv)).length) {
    if (Date.now() >= deadline) throw new Error("verification children did not cease; reservation retained");
    await new Promise(wake => setTimeout(wake, pollMs));
  }
}

function holderAlive(holder: RepositoryLeaseHolder): boolean {
  if (holder.ownerReleased === true) return false;
  if (!alive(holder.pid)) return false;
  if (!holder.identity) return true; // legacy live holder remains protected
  const birth = processBirth(holder.pid);
  // Older live generations may contain ps's space-padded day. Formatting cannot prove owner death.
  return birth === undefined || sameProcessBirth(`${holder.pid}:${birth}`, holder.identity);
}
