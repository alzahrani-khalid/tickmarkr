// OBS-1167 / D-478 add.1: a test that owns a subprocess — a daemon fixture in the stress harness, a
// nested Vitest runner — records it at spawn and tears its whole process tree down before it records
// an outcome. Ownership is retained while the root runs, not only at teardown: the root carries an
// ownership tag in its environment that every descendant inherits, and a tracker records its
// descendants every TRACK_MS, so a detached child is still owned after the root exits on its own.
// The root is spawned detached, so its process group is a handle known from spawn: when `ps`
// discovery fails or outlives its share of the teardown bound, a per-pid start-time read checks the
// recorded descendants before killing them. A remembered pid or group number alone never owns its
// current holder. Failed discovery still names ownership as unresolved — a failure, never a pass.
// ponytail: a descendant that detaches in the last TRACK_MS before its root exits is found only through
// its tag, and darwin hides the environment of platform binaries (sh, sleep, git), so such a child can
// escape; a kernel-held owner (a Linux subreaper, a darwin audit session) is the upgrade if one leaks.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { readProcessIdentity, type IdentityRead } from "../../src/run/beat-lifecycle.js";

export type Proc = { pid: number; ppid: number; pgid: number; startTime: string; tags?: string[] };
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

/** The beat suites' complete teardown ledger: child handles and identities read at pid registration. */
export class TeardownLedger {
  readonly children: ChildProcess[] = [];
  readonly pids = new Map<number, IdentityRead>();

  addChild(child: ChildProcess): ChildProcess {
    this.children.push(child);
    return child;
  }

  addPid(...pids: number[]): void {
    for (const pid of pids) this.pids.set(pid, readProcessIdentity(pid));
  }

  async teardown(kill: (pid: number, signal: NodeJS.Signals) => void): Promise<void> {
    const children = this.children.splice(0);
    const pids = new Map(this.pids);
    this.pids.clear();
    const matches = (pid: number, recorded: IdentityRead) => {
      if (typeof recorded !== "object") return false;
      const current = readProcessIdentity(pid);
      return typeof current === "object" && current.birth === recorded.birth
        && current.command === recorded.command && current.cwd === recorded.cwd;
    };
    const send = (pid: number) => {
      try { kill(pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    for (const child of children) if (child.pid !== undefined && !exited(child)) {
      send(child.pid);
      pids.delete(child.pid); // The same live child needs only one signal, even if an owner record also named it.
    }
    for (const [pid, identity] of pids) if (matches(pid, identity)) send(pid);
    const left = () => [
      ...children.filter((child) => child.pid !== undefined && !exited(child)).map((child) => child.pid!),
      ...[...pids].filter(([pid, identity]) => matches(pid, identity)).map(([pid]) => pid),
    ];
    const deadline = Date.now() + 5_000;
    let survivors = left();
    while (survivors.length && Date.now() < deadline) {
      await sleep(25);
      survivors = left();
    }
    if (survivors.length) throw new Error(`teardown ledger survivors: ${survivors.join(",")}`);
  }
}

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
  const { stdout } = await execFileP("ps", ["-A", "-ww", ...(linux ? [] : ["-E"]), "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
    timeout: o.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 28, env: { ...process.env, LC_ALL: "C" },
  });
  const rows = await Promise.all(stdout.trim().split("\n").map(async (line) => {
    const row = parseProc(line);
    if (!row) return [];
    const env = linux ? await readFile(`/proc/${row.pid}/environ`, "utf8").catch(() => "") : line;
    return [{ ...row, tags: TAG_RE.exec(env)?.[1]?.split(",") ?? [] }];
  }));
  return rows.flat();
}

function parseProc(line: string): Proc | undefined {
  const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})(?:\s|$)/.exec(line);
  if (!row) return undefined;
  return { pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]), startTime: row[5]! };
}

/** A failed full census grants no authority; the recorded birth must still match a per-pid read. */
async function readProc(pid: number, deadline: number): Promise<Proc | undefined> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "pid=,ppid=,pgid=,stat=,lstart=", "-p", String(pid)], {
      timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" },
    });
    return parseProc(stdout);
  } catch { return undefined; }
}

const sameStart = (recorded: Proc | undefined, current: Proc) =>
  recorded !== undefined && !!recorded.startTime && recorded.startTime === current.startTime;

/** Every row owned through a live root, a recorded pid or the ownership tag, with all their descendants. */
function ownedRows(rows: Proc[], root: ChildProcess, recorded: Map<number, Proc>, tag: string | undefined): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of rows) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const eligible = (p: Proc) => !!p.startTime && (p.pid === root.pid ? !exited(root)
    : !recorded.has(p.pid) || sameStart(recorded.get(p.pid), p));
  const queue = rows.filter((p) => eligible(p) && (sameStart(recorded.get(p.pid), p) || p.pid === root.pid
    || (tag !== undefined && p.tags?.includes(tag))));
  const seen = new Map<number, Proc>();
  for (let p = queue.shift(); p; p = queue.shift()) {
    if (seen.has(p.pid) || !eligible(p)) continue;
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
 * identified pids and the groups they lead. The root's group is owned only while the child is unreaped
 * or an identified member holds it. One deadline bounds it all: discovery gets the first half of
 * `boundMs`; a failed census falls back to per-pid reads of recorded start times. A mismatched or
 * unreadable holder is neither a signal target nor a survivor. Never throws.
 */
export async function teardownTree(root: ChildProcess, o: {
  boundMs?: number; ps?: PsTable; tag?: string; known?: Map<number, Proc>;
} = {}): Promise<Teardown> {
  const bound = o.boundMs ?? 10_000;
  const deadline = Date.now() + bound;
  const discoverBy = deadline - bound / 2;
  const tree = new Map(o.known);
  let unresolved: string | undefined;
  let current: Proc[] | undefined;
  if (root.pid !== undefined && exited(root) && !o.tag && !o.known) {
    unresolved = "root exited before its descendants were tracked";
  } else {
    try {
      const frozen = new Set<number>();
      for (let grew = true; grew;) {
        grew = false;
        const rows = await within((o.ps ?? psTable)({ phase: "teardown", timeoutMs: Math.max(1, discoverBy - Date.now()) }),
          discoverBy, `discovery past its ${bound / 2} ms share of the teardown bound`);
        current = rows;
        for (const p of ownedRows(rows, root, tree, o.tag)) {
          tree.set(p.pid, p);
          if (frozen.has(p.pid)) continue;
          frozen.add(p.pid);
          signal(p.pid, "SIGSTOP");
          grew = true;
        }
      }
    } catch (e) {
      current = undefined;
      unresolved = `process discovery failed: ${message(e)}`;
    }
  }
  const identified = async (rows?: Proc[]) => {
    const read = rows ?? (await Promise.all([...tree.keys()].map((pid) => readProc(pid, deadline))))
      .filter((p): p is Proc => p !== undefined);
    return read.filter((p) => sameStart(tree.get(p.pid), p) && (p.pid !== root.pid || !exited(root)));
  };
  const groupsOf = (members: Proc[]) => {
    const groups = new Set<number>();
    if (root.pid !== undefined && (!exited(root) || members.some((p) => p.pid !== root.pid && p.pgid === root.pid))) groups.add(root.pid);
    for (const p of members) if (p.pid !== root.pid && p.pid === p.pgid) groups.add(p.pgid);
    return groups;
  };
  const targets = await identified(current);
  for (const g of groupsOf(targets)) signal(-g, "SIGKILL");
  for (const p of targets) if (p.pid !== root.pid) signal(p.pid, "SIGKILL");
  if (root.pid !== undefined && !exited(root)) signal(root.pid, "SIGKILL");
  const left = async () => {
    const members = await identified();
    return [
      ...(root.pid !== undefined && !exited(root) ? [root.pid] : []),
      ...members.filter((p) => p.pid !== root.pid).map((p) => p.pid),
      ...[...groupsOf(members)].filter((g) => alive(-g)).map((g) => -g),
    ];
  };
  let survivors = await left();
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(50);
    survivors = await left();
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
  /**
   * Census fault injection only. These pids are appended to the survivor list AFTER the real tree
   * is killed and awaited. Omitted means the census is unchanged. This is not a reap-policy change:
   * the injected pid is not signalled and not treated as owned.
   */
  injectSurvivors?: readonly number[];
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
  return {
    why, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, out, err, ...torn,
    survivors: [...torn.survivors, ...(o.injectSurvivors ?? [])],
    ...(unresolved ? { unresolved } : {}),
  };
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

/** One parent row per owned fixture. A rejection becomes a red row; it does not drop the others. */
export interface DiagnosticLedger {
  name: string;
  ok: boolean;
  pid: number | undefined;
  cause: string;
  tail: string;
  survivors: number[];
}

export async function diagnosticLedgers(jobs: readonly { name: string; run: () => Promise<OwnedRun> }[]): Promise<DiagnosticLedger[]> {
  const settled = await Promise.allSettled(jobs.map(async (job) => ({ name: job.name, run: await job.run() })));
  return settled.map((entry, i) => {
    const name = jobs[i]!.name;
    if (entry.status === "rejected") {
      const cause = `rejected: ${message(entry.reason)}`;
      return { name, ok: false, pid: undefined, cause, tail: cause, survivors: [] };
    }
    const run = entry.value.run;
    const fails = ownedFailures(run, name);
    return {
      name,
      ok: fails.length === 0 && run.exitCode === 0,
      pid: run.pid,
      cause: fails.join("; "),
      tail: `${run.out}${run.err}`.slice(-4_000),
      survivors: run.survivors,
    };
  });
}
