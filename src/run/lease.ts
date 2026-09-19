import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

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
export interface RepositoryLeaseHolder { pid: number; cwd: string; at: number; token: string }
export interface RepositoryLeaseOptions {
  pollMs?: number;
  signal?: AbortSignal;
  /** Called once per distinct holder the waiter is queued behind. */
  onWait?: (holder: RepositoryLeaseHolder) => void;
}

const LEASE_FILE = "tickmarkr-runner.lease";

export async function repositoryLeasePath(cwd: string): Promise<string> {
  const commonDir = await new Promise<string>((ok, fail) => execFile("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" },
    (error, stdout) => error ? fail(error) : ok(stdout.trim())));
  return join(resolve(cwd, commonDir), LEASE_FILE);
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

const inspectAndReserve = (path: string, mine: RepositoryLeaseHolder): { acquired: boolean; holder?: RepositoryLeaseHolder } => {
  let occupant = readOccupant(path);
  if (occupant && (!occupant.holder || !alive(occupant.holder.pid))) {
    reclaimDeadLocked(path, occupant.identity);
    occupant = readOccupant(path);
  }
  if (!occupant && tryReserve(path, mine)) return { acquired: true };
  return { acquired: false, holder: occupant?.holder };
};

export async function withRepositoryLease<T>(cwd: string, run: () => Promise<T>, opts: RepositoryLeaseOptions = {}): Promise<T> {
  const path = await repositoryLeasePath(cwd);
  const pollMs = opts.pollMs ?? 1_000;
  const mine: RepositoryLeaseHolder = { pid: process.pid, cwd, at: Date.now(), token: randomUUID() };
  let waitingOn: number | undefined;
  for (;;) {
    opts.signal?.throwIfAborted();
    const attempt = await withMutationLock(path, pollMs, opts.signal, () => inspectAndReserve(path, mine));
    if (attempt.acquired) break;
    if (attempt.holder && attempt.holder.pid !== waitingOn) { waitingOn = attempt.holder.pid; opts.onWait?.(attempt.holder); }
    await new Promise((wake) => setTimeout(wake, pollMs));
  }
  try {
    return await run();
  } finally {
    // Release is serialized with reclamation/acquisition and removes only this generation.
    await withMutationLock(path, pollMs, undefined, () => {
      if (readHolder(path)?.token === mine.token) unlinkSync(path);
    });
  }
}
