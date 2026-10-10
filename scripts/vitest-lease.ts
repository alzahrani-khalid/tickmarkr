// OBS-880 suite (2) / OBS-1071: the repository's Vitest entry takes the same identity-bound file lease
// `tickmarkr verify` holds (src/run/lease.ts withRepositoryLease), so a worker's or reviewer's own
// `vitest run` and a gate suite in any linked worktree of this clone run one at a time, while an
// unrelated repository keeps its own lease. vitest.config.ts registers this module as globalSetup:
// Vitest runs it in the main process before the first fork is spawned (the fork environment is built
// after global setup), so the exported token reaches every fork and every nested runner they start,
// and its close hook releases the lease only after the runner's owned workloads — the forks and
// whatever they started — have completed, never waiting out its deadline on the runner's own tooling.
// Bounds: this is cooperation between configured entries, not enforcement over arbitrary shells or
// foreign runner configurations; a dead holder is reclaimed only once its token-bound tree ceases.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { parseCLI, type TestProject } from "vitest/node";
import { describeLeaseWait, readHolder, REPOSITORY_LEASE_TOKEN_ENV, repositoryLeasePath, withRepositoryLease } from "../src/run/lease.js";

/** `vitest list` (manifest discovery) collects and never executes a test body: it takes no lease, so a
 * listing issued while its own parent holds the lease can never block on it. The command is read the way
 * Vitest's own CLI reads it, so options may precede it (`vitest --configLoader runner list`) while
 * `vitest run list` stays a run filtered by "list". */
export const isListingInvocation = (argv: readonly string[] = process.argv): boolean =>
  parseCLI(["vitest", "list", ...argv.slice(2)]).filter[0] === "list";

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Every live (non-zombie) process below this one, from one `ps` snapshot that leaves out `ps` itself.
 * `identity` is pid plus birth time, so a reused pid never passes for the process it replaced. */
type Descendant = { pid: number; identity: string };
function descendants(): Descendant[] {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], { encoding: "utf8" });
  if (ps.status !== 0) throw ps.error ?? new Error(`ps exited ${ps.status}`);
  const children = new Map<number, Descendant[]>();
  for (const line of ps.stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!row || row[3]!.startsWith("Z") || Number(row[1]) === ps.pid) continue;
    const ppid = Number(row[2]);
    children.set(ppid, [...children.get(ppid) ?? [], { pid: Number(row[1]), identity: `${row[1]}:${row[4]!.trim()}` }]);
  }
  const found: Descendant[] = [];
  for (let queue = [process.pid]; queue.length;) for (const child of children.get(queue.shift()!) ?? []) { found.push(child); queue.push(child.pid); }
  return found;
}
const signal = (pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* already gone */ } };
const running = (pid: number): boolean => {
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch { return false; } // ps -p exits non-zero once the pid is gone
};

/** Cancellation: stop every fork and nested runner this entry owns before its capacity is released.
 * The tree is frozen first (a stopped process cannot fork, and a killed parent would reparent its
 * children out of the snapshot), then killed, then awaited. Returns whether all of it is gone. */
export function stopOwnedRunners(deadlineMs = 10_000): boolean {
  const owned = new Set<number>();
  try {
    for (let fresh = descendants(); fresh.some(({ pid }) => !owned.has(pid)); fresh = descendants()) {
      for (const { pid } of fresh) if (!owned.has(pid)) { signal(pid, "SIGSTOP"); owned.add(pid); }
    }
  } finally {
    // C-9(i) (D-670): a census that throws after a SIGSTOP must not leave frozen processes behind.
    for (const pid of owned) signal(pid, "SIGKILL");
  }
  const end = Date.now() + deadlineMs;
  let left = [...owned];
  while ((left = left.filter(running)).length && Date.now() < end) sleepSync(20);
  return left.length === 0;
}

/** Vitest closes its pool after global teardown. Let that normal shutdown reap the workers
 * before repository cleanup signals any residual children. The public close hook is awaited
 * alongside pool shutdown, so waiting here cannot hold up the pool's own close operation.
 * Only the owned workloads are awaited: the forks and everything beneath them. A child the main
 * process keeps for its own lifetime (Vite's esbuild service, measured as the sole survivor at
 * every close) is `tooling` — it was already below this process before the first fork — and
 * waiting on it would only pay the full deadline at every close, nested runs included (D-1300). */
async function awaitRunnerShutdown(tooling: ReadonlySet<string>, deadlineMs = 10_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  const workload = () => descendants().some(({ identity }) => !tooling.has(identity));
  while (workload() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
}

// Vitest runs globalSetup once per project in this one process; the first call holds, the rest share it.
const HELD = Symbol.for("tickmarkr.vitest-lease");
type Held = { users: number; release: () => void; done: Promise<unknown>; tooling: Set<string> };
const registry = globalThis as { [HELD]?: Held };

export default async function vitestLease(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  if (isListingInvocation()) return undefined;
  const cwd = process.cwd();
  let path: string;
  try { path = await repositoryLeasePath(cwd); } catch { return undefined; } // repository-less cwd: nothing to key on
  let held = registry[HELD];
  if (!held) {
    let release!: () => void;
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => { acquired = resolve; });
    const done = withRepositoryLease(cwd, () => {
      acquired();
      return new Promise<void>((resolve) => { release = resolve; });
    }, {
      onWait: (holder, blockers) => console.error(`tickmarkr: vitest waits for this repository's runner lease ${describeLeaseWait(holder, blockers)}`),
    });
    await Promise.race([holding, done]);
    // Cancellation: Vitest answers SIGINT/SIGTERM with process.exit() and never runs global teardown or
    // closes its pool, so forks and their nested runners would outlive it. Prepended so it runs before
    // Vitest's own exit listener re-enters process.exit(); the record goes only once the tree is gone
    // (otherwise the dead-pid rule reclaims it after this process, and its killed tree, are gone).
    const token = process.env[REPOSITORY_LEASE_TOKEN_ENV];
    const onExit = () => {
      let gone = false;
      try { gone = stopOwnedRunners(); } catch { /* ps unreadable: leave the record to the dead-pid rule */ }
      const holder = readHolder(path);
      if (gone && holder?.pid === process.pid && holder.token === token) rmSync(path, { force: true });
    };
    process.prependOnceListener("exit", onExit);
    held = registry[HELD] = { users: 0, release: () => { process.off("exit", onExit); release(); }, done, tooling: new Set() };
    // The first project's global setup runs here, in the main process, before the first owned fork: whatever
    // already lives below this process is the runner's own tooling, structurally — not an owned workload,
    // whatever its argv says. Captured ONCE: a later project's setup may find an earlier project's fork or
    // nested runner alive, and that is workload. An unreadable census leaves the set empty, so close waits
    // for every child as before.
    try { for (const { identity } of descendants()) held.tooling.add(identity); } catch { /* ps unreadable */ }
    const own = held;
    project.vitest.onClose(async () => {
      await awaitRunnerShutdown(own.tooling);
      own.release();
      await own.done;
    });
  }
  held.users++;
  const own = held;
  return async () => {
    if (--own.users > 0) return;
    delete registry[HELD];
    // Returning lets Vitest close its servers and pool in its normal order. The public onClose
    // hook keeps the reservation and exit protection until those children have ceased.
  };
}
