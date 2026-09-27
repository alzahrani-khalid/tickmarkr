// OBS-1167 / D-478 add.1: a test that owns a subprocess — a daemon fixture in the stress harness, a
// nested Vitest runner — records it at spawn and tears its whole process tree down before it records
// an outcome. Ownership is retained while the root runs, not only at teardown: the root carries an
// ownership tag in its environment that every descendant inherits, and a tracker records its
// descendants every TRACK_MS, so a detached child is still owned after the root exits on its own.
// The root is spawned detached, so its process group is a handle known from spawn: when `ps`
// discovery fails or outlives its share of the teardown bound, every pid and group already recorded
// (and the root's own group) is still killed and awaited, and the teardown names ownership as
// unresolved — a failure, never a pass.
// ponytail: a descendant that detaches in the last TRACK_MS before its root exits is found only through
// its tag, and darwin hides the environment of platform binaries (sh, sleep, git), so such a child can
// escape; a kernel-held owner (a Linux subreaper, a darwin audit session) is the upgrade if one leaks.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export type Proc = { pid: number; ppid: number; pgid: number; tags?: string[] };
export type PsTable = (o: { phase: "track" | "teardown"; timeoutMs: number }) => Promise<Proc[]>;
export interface Teardown {
  /** Every process recorded under the root — tracked while it ran or discovered at teardown. */
  tree: Proc[];
  /** Recorded pids — or `-pgid` for a recorded group that still has a member — alive after the bound. */
  survivors: number[];
  /** Set when tracking or discovery failed: a descendant outside the recorded set may exist, so ownership is unproven. */
  unresolved?: string;
}
export interface OwnedRun extends Teardown {
  why: "settled" | "expired" | "cancelled";
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
}

const TAG = "TKR_OWNED_BY";
const TAG_RE = /(?:^|[\s\0])TKR_OWNED_BY=([^\s\0]+)/;
const TRACK_MS = 250;
const TRACK_TIMEOUT_MS = 5_000;
const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const signal = (pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* already gone */ } };
export const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/** `p`, or a rejection once `by` (epoch ms) passes — whichever settles first. */
function within<T>(p: Promise<T>, by: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), Math.max(0, by - Date.now()));
  });
  return Promise.race([p, cut]).finally(() => clearTimeout(timer));
}

export async function psTable(o: { timeoutMs?: number } = {}): Promise<Proc[]> {
  const linux = process.platform === "linux";
  // darwin's ps appends each process's environment to its command under -E; linux reads it from /proc
  const { stdout } = await execFileP("ps", ["-A", "-ww", ...(linux ? [] : ["-E"]), "-o", "pid=,ppid=,pgid=,command="], {
    timeout: o.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 28,
  });
  return Promise.all(stdout.trim().split("\n").map(async (line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/, 3).map(Number);
    const env = linux ? await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "") : line;
    return { pid: pid!, ppid: ppid!, pgid: pgid!, tags: TAG_RE.exec(env)?.[1]?.split(",") ?? [] };
  }));
}

/** Every row owned through a live root, a recorded pid or the ownership tag, with all their descendants. */
function ownedRows(rows: Proc[], root: ChildProcess, recorded: Map<number, Proc>, tag: string | undefined): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of rows) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  // an exited root's pid is free for reuse, so only a live root seeds the walk; its group is still killed
  // ponytail: pids allocate sequentially, so a recorded pid is reused only after a full pid wrap
  const queue = rows.filter((p) => recorded.has(p.pid) || (p.pid === root.pid && !exited(root))
    || (tag !== undefined && p.tags?.includes(tag)));
  const seen = new Map<number, Proc>();
  for (let p = queue.shift(); p; p = queue.shift()) {
    if (seen.has(p.pid)) continue;
    seen.set(p.pid, p);
    queue.push(...(children.get(p.pid) ?? []));
  }
  return [...seen.values()];
}

/**
 * Tear down a detached `root` and every descendant, whatever group it forked into — the
 * SubprocessDriver's workers and a runner's own children may detach, so a group kill alone would miss
 * them. Descendants are the processes `known` recorded while the root ran, the ones carrying `tag`, and
 * everything under those or under a live root. Freeze-then-kill: SIGSTOP each newly seen descendant
 * until a ps pass finds none new (a stopped process cannot fork out of the snapshot), then SIGKILL
 * every recorded pid plus the root's group and every group led by a recorded pid, and await all of
 * them. One deadline bounds it all: discovery gets the first half of `boundMs`, and a discovery that
 * fails or runs past it leaves ownership unresolved but never loses what was already recorded;
 * whatever outlives the bound is a survivor. Never throws.
 */
export async function teardownTree(root: ChildProcess, o: {
  boundMs?: number; ps?: PsTable; tag?: string; known?: Map<number, Proc>;
} = {}): Promise<Teardown> {
  const bound = o.boundMs ?? 10_000;
  const deadline = Date.now() + bound;
  const discoverBy = deadline - bound / 2;
  const tree = new Map(o.known);
  let unresolved: string | undefined;
  if (root.pid !== undefined && exited(root) && !o.tag && !o.known) {
    unresolved = "root exited before its descendants were tracked";
  } else {
    try {
      const frozen = new Set<number>();
      for (let grew = true; grew;) {
        grew = false;
        const rows = await within((o.ps ?? psTable)({ phase: "teardown", timeoutMs: Math.max(1, discoverBy - Date.now()) }),
          discoverBy, `discovery past its ${bound / 2} ms share of the teardown bound`);
        for (const p of ownedRows(rows, root, tree, o.tag)) {
          tree.set(p.pid, p);
          if (frozen.has(p.pid)) continue;
          frozen.add(p.pid);
          signal(p.pid, "SIGSTOP");
          grew = true;
        }
      }
    } catch (e) {
      unresolved = `process discovery failed: ${message(e)}`;
    }
  }
  // ponytail: the root's group id is only reused once that group is empty, and then the kill is ESRCH
  const groups = new Set(root.pid === undefined ? [] : [root.pid]);
  for (const p of tree.values()) if (tree.has(p.pgid)) groups.add(p.pgid);
  for (const g of groups) signal(-g, "SIGKILL");
  for (const pid of tree.keys()) signal(pid, "SIGKILL");
  const left = () => [
    ...(root.pid !== undefined && !exited(root) ? [root.pid] : []),
    ...[...tree.keys()].filter((pid) => pid !== root.pid && alive(pid)),
    ...[...groups].filter((g) => alive(-g)).map((g) => -g),
  ];
  let survivors = left();
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(50);
    survivors = left();
  }
  return { tree: [...tree.values()], survivors, ...(unresolved ? { unresolved } : {}) };
}

/**
 * Run `cmd` as an owned, detached root until it exits, prints `settleOn`, exhausts its wall-time bound
 * `ms` (armed at spawn, or at the first stdout match of `armOn` with `armCeilingMs` cutting a run that
 * never arms), or `signal` cancels it — then tear its tree down before returning. Its descendants are
 * tracked every TRACK_MS while it runs; a failed tracking pass leaves ownership unresolved. Never
 * throws: every path returns one record.
 */
export async function runOwned(cmd: string, args: readonly string[], o: {
  cwd?: string; env?: NodeJS.ProcessEnv; ms?: number; armOn?: RegExp; armCeilingMs?: number;
  settleOn?: RegExp; signal?: AbortSignal; ps?: PsTable; boundMs?: number;
} = {}): Promise<OwnedRun> {
  let out = "";
  let err = "";
  const tag = randomUUID();
  const env = o.env ?? process.env;
  let child: ChildProcess;
  try {
    // appended, so an owner nested inside another owned run stays inside that run's tag too
    child = spawn(cmd, args, {
      cwd: o.cwd, env: { ...env, [TAG]: [env[TAG], tag].filter(Boolean).join(",") }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { why: "settled", pid: undefined, exitCode: null, signal: null, out, err: String(e), tree: [], survivors: [] };
  }
  const closed = once(child, "close").catch(() => undefined);
  const known = new Map<number, Proc>();
  let trackFailure: string | undefined;
  let tracking = true;
  let wake = () => {};
  const tracker = (async () => {
    while (tracking) {
      try {
        const rows = await within((o.ps ?? psTable)({ phase: "track", timeoutMs: TRACK_TIMEOUT_MS }), Date.now() + TRACK_TIMEOUT_MS, "tracking");
        const seen = ownedRows(rows, child, known, tag);
        known.clear();
        for (const p of seen) known.set(p.pid, p);
      } catch (e) {
        trackFailure ??= `process tracking failed: ${message(e)}`;
      }
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, TRACK_MS); });
    }
  })();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let onAbort = () => {};
  const why = await new Promise<OwnedRun["why"]>((resolve) => {
    let armed = false;
    const arm = (ms: number) => timers.push(setTimeout(() => resolve("expired"), ms));
    if (o.ms !== undefined && !o.armOn) { armed = true; arm(o.ms); }
    if (o.ms !== undefined && o.armOn) arm(o.armCeilingMs ?? 60_000);
    onAbort = () => resolve("cancelled");
    if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (d) => {
      out += d;
      if (!armed && o.armOn?.test(out)) { armed = true; arm(o.ms!); }
      if (o.settleOn?.test(out)) resolve("settled");
    });
    child.stderr!.on("data", (d) => { err += d; });
    child.once("exit", () => resolve("settled"));
    child.once("error", (e) => { err += `\n${e}`; resolve("settled"); });
  });
  for (const t of timers) clearTimeout(t);
  o.signal?.removeEventListener("abort", onAbort);
  tracking = false;
  wake();
  await tracker;
  const torn = await teardownTree(child, { boundMs: o.boundMs, ps: o.ps, tag, known });
  // every recorded holder of the pipes is dead now, so the tail of the output drains within a moment
  await Promise.race([closed, sleep(2_000)]);
  const unresolved = [trackFailure, torn.unresolved].filter(Boolean).join("; ");
  return { why, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, out, err, ...torn, ...(unresolved ? { unresolved } : {}) };
}

/** Every reason an owned run is not a clean completion: a cut, a cancellation, unproven or leaked ownership. */
export function ownedFailures(run: OwnedRun, label: string): string[] {
  return [
    ...(run.why === "expired" ? [`${label}: wall-time bound exhausted`] : []),
    ...(run.why === "cancelled" ? [`${label}: cancelled`] : []),
    ...(run.unresolved ? [`${label}: ownership unresolved — ${run.unresolved}`] : []),
    ...(run.survivors.length ? [`${label}: owned processes outlived teardown: ${run.survivors.join(",")}`] : []),
  ];
}
