import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { activeShellIdentities, processIdentity, resolveActiveShellIdentities, shGit, SUITE_PARENT_ENV } from "./git.js";

// OBS-82: normalize known presentation tokens before measuring transcript extent or filtering an
// LLM-bound transcript. This remains a closed allowlist — ANSI/VT escapes, braille-range spinner
// glyphs, and elapsed-time tokens bound to time-unit suffixes. Every other byte passes through
// identical. v1.76 deliberately stopped treating arbitrary normalized byte changes as progress:
// StallProgressTracker below requires monotonic evidence, so an unknown repaint fails closed toward
// a recoverable consult instead of holding the watchdog silent.

// CSI (with intermediates), OSC (BEL- or ST-terminated), DCS/SOS/PM/APC strings, single-char
// escapes, and charset selection — the raw-pty forms; herdr pane reads are already rendered.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x9b[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[()][0-9A-Za-z]|\x1b[0-~]/g;

// Braille patterns U+2800–U+28FF — the codex spinner cell (captured fixture: ⠋⠙⠸⠴⠦⠇ …).
const SPINNER_RE = /[⠀-⣿]/g;

// A digit run (optionally decimal) bound directly to a time-unit suffix, standing alone as a
// word: 9s, 41s, 3m, 1h, 800ms. Never bare digits — "(6/7)" and "5 of 7" stay change-sensitive.
const ELAPSED_RE = /(?<![\w.])\d+(?:\.\d+)?(?:ms|[hms])(?!\w)/g;

/** Normalize presentation tokens for transcript extent and LLM-noise classification. Trailer
 * parsing, harvest, waitOutput, and paging always read the raw text. */
export function normalizeStallSnapshot(text: string): string {
  return text.replace(ANSI_RE, "").replace(SPINNER_RE, "").replace(ELAPSED_RE, "");
}

export interface StallProgressSample {
  paneText: string;
  seedSubmitted?: boolean;
  contextTokens?: number;
}

// T2 (OBS-264): a CPU delta needs two samples separated in WALL CLOCK, and the CPU clock is
// QUANTIZED: darwin's `ps` prints hundredths ("0:00.03"), linux's precise /proc clock advances in
// jiffies. Equality across a window shorter than the quantum is not evidence of rest. Crossing 30
// ticks means the tree burned <1 tick in 30, i.e. under ~3% of one core. This process-tree liveness
// primitive lives here rather than in daemon.ts so lower-level gate waits can use it without closing
// the daemon -> run-gates -> llm -> daemon dependency cycle.
const HARVEST_CPU_FLAT_MS = 3_000;
const HARVEST_CPU_FLAT_TICKS = 30;
const WORKER_TREE_CPU_ACCOUNTING_POLL_MS = 100;
const WORKER_TREE_CPU_UNMEASURABLE_SAMPLE_CAP = 20;

let harvestCpuFlatMs: number | undefined;
export function harvestCpuFlatWindowMs(resolutionMs: number): number {
  return harvestCpuFlatMs ?? Math.max(HARVEST_CPU_FLAT_MS, resolutionMs * HARVEST_CPU_FLAT_TICKS);
}

/** Test seam — pin the quantization-aware flat window without changing production policy. */
export function setHarvestCpuFlatMsForTests(ms: number): void {
  harvestCpuFlatMs = ms;
}

export function resetHarvestCpuFlatMsForTests(): void {
  harvestCpuFlatMs = undefined;
}

// `ps` CPU time: "[[dd-]hh:]mm:ss[.frac]". Anything else is a header or a row this parser must
// not guess at. `frac` reports whether this host exposes sub-second digits so callers use the
// sampled clock's quantum rather than assuming one.
function parsePsCpu(raw: string): { ms: number; frac: boolean } | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) return undefined;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60_000
    + Math.round(Number(m[4]!) * 1000);
  return { ms, frac: m[4]!.includes(".") };
}

/** The dispatch shell records its foreground group in an attempt-unique artifact. */
export function readOwnedProcessGroup(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const group = /^\d+$/.test(raw) ? Number(raw) : 0;
    return Number.isSafeInteger(group) && group > 1 ? group : undefined;
  } catch { return undefined; }
}

/** Never infer ownership from a task name or scan another attempt's marker when reaping. */
export async function reapOwnedProcessGroup(group: number | undefined, cwd: string, ownership?: WorkerReapOwnership): Promise<number[] | null> {
  if (ownership) return reapWorkerProcesses(group, cwd, ownership);
  if (group === undefined) return null;
  const own = await shGit(`ps -o pgid= -p ${process.pid}`, cwd, 5_000);
  // An in-process driver fixture (or a non-isolating host) can share the daemon's
  // group. It is not an owned worker group: let the driver's close retire that slot.
  if (own.code !== 0 || !/^\d+$/.test(own.stdout.trim()) || Number(own.stdout.trim()) === group) return null;
  try { process.kill(-group, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  let survivors: number[] = [];
  // SIGKILL delivery and process retirement are asynchronous. Bound the confirmation
  // grace, retaining names if a process is still present after it.
  for (let probe = 0; probe < 5; probe++) {
    const snapshot = await shGit("ps -Awwo pid=,pgid=,stat=", cwd, 5_000);
    if (snapshot.code !== 0) return null;
    survivors = snapshot.stdout.split("\n").flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      return row && Number(row[2]) === group && !row[3]!.startsWith("Z") ? [Number(row[1])] : [];
    });
    if (survivors.length === 0) break;
    if (probe < 4) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return survivors;
}

export interface ReapProcess {
  pid: number; ppid: number; group: number; session: string; identity: string; command: string;
  startedAt?: string;
}

export interface WorkerReapOwnership {
  marker: string;
  /** Session recorded by the dispatch shell before its children can detach. */
  session?: string;
  parent?: { pid: number; startedAt: string };
  identities?: Map<number, string>;
  /** Descendants observed while the dispatch root was still alive. */
  descendants?: Map<number, string>;
  excludedGroups: number[];
  excludedWorktrees: string[];
  /** Discovery evidence is distinct from the final survivor census. */
  strays: number[];
}

const below = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
// Every probe is async and bounded like the CPU accountant's ps: a loaded host is slow, not unreadable.
const probeExec = (command: string, args: string[]): Promise<string> => new Promise((resolve, reject) =>
  execFile(command, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => (error ? reject(error) : resolve(stdout))));

/** Bounded host boundary, also used to inject unreadability and pid reuse in regressions. */
export const workerReapHost = {
  async snapshot(): Promise<ReapProcess[] | undefined> {
    try {
      const out = await probeExec("ps", ["-Awwo", "pid=,ppid=,pgid=,sess=,stat=,lstart=,command="]);
      const rows: ReapProcess[] = [];
      const lines = out.split("\n").filter((line) => line.trim());
      if (!lines.length || lines.length > 20_000) return undefined;
      for (const line of lines) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
        if (!m) return undefined;
        if (m[5]!.startsWith("Z")) continue;
        const pid = Number(m[1]);
        const identity = process.platform === "linux" ? await processIdentity(pid) : `${pid}:${m[6]!.trim().replace(/\s+/g, " ")}`;
        // A process disappearing during ps is normal; a present, unreadable identity is not.
        if (!identity) {
          try { process.kill(pid, 0); return undefined; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
          }
          continue;
        }
        rows.push({ pid, ppid: Number(m[2]), group: Number(m[3]), session: m[4]!, identity,
          startedAt: m[6]!.trim().replace(/\s+/g, " "), command: m[7]! });
      }
      return rows;
    } catch { return undefined; }
  },
  async inspect(pid: number): Promise<{ cwd: string; suiteParent?: number } | undefined> {
    try {
      let cwd: string;
      let env: string[];
      if (process.platform === "linux") {
        cwd = realpathSync(`/proc/${pid}/cwd`);
        env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      } else {
        const [open, command] = await Promise.all([
          probeExec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
          probeExec("ps", ["eww", "-p", String(pid), "-o", "command="]),
        ]);
        const path = open.split("\n").find((line) => line.startsWith("n"))?.slice(1);
        if (!path) return undefined;
        cwd = realpathSync(path);
        env = command.split(/\s+/);
      }
      const parent = env.find((entry) => entry.startsWith(`${SUITE_PARENT_ENV}=`))?.slice(SUITE_PARENT_ENV.length + 1);
      return { cwd, ...(parent && /^\d+$/.test(parent) ? { suiteParent: Number(parent) } : {}) };
    } catch { return undefined; }
  },
  // Lazy: a partial module mock of git.js must not fail at import time.
  identity: (pid: number): Promise<string | null | undefined> => processIdentity(pid),
  kill(pid: number): void { process.kill(pid, "SIGKILL"); },
};

async function reapWorkerProcesses(group: number | undefined, cwd: string, ownership: WorkerReapOwnership): Promise<number[] | null> {
  let root: string;
  let excludedPaths: string[];
  try {
    root = realpathSync(cwd);
    excludedPaths = ownership.excludedWorktrees.map((path) => realpathSync(path));
  } catch { return null; }
  let rows = await workerReapHost.snapshot();
  if (!rows) return null;
  const roots = rows.filter((row) => row.command === `bash ${ownership.marker}` || row.command === `/bin/bash ${ownership.marker}`);
  // Ownership evidence: the recorded group, a live dispatch root, or descendants observed while it
  // lived. cwd alone is never authority, and neither is the session id (OBS-1170): on Linux a
  // same-session SIBLING that never descended from the dispatch — an operator job in a kept pane
  // whose cwd is the worktree — is not ours to signal. `ownership.session` stays recorded as
  // evidence only. With none of these in a readable snapshot nothing owned is observable: the
  // dispatch has retired, so the census is empty rather than unknown (a finished root leaves no row).
  const groupRows = group === undefined ? [] : rows.filter((row) => row.group === group && row.pid !== process.pid);
  if (roots.length === 0 && !ownership.descendants?.size && groupRows.length === 0) return [];
  const owned = new Map(ownership.descendants);
  const protectedIds = new Map<number, string>();
  const recordedParent = rows.find((row) => row.pid === ownership.parent?.pid && row.startedAt === ownership.parent.startedAt);
  // Never reap a pane's shell (an ancestor of the dispatch root), or the daemon.
  for (const start of [...roots.map((row) => row.ppid), ...(recordedParent ? [recordedParent.pid] : []), process.pid]) {
    const seen = new Set<number>();
    for (let pid = start; pid && !seen.has(pid);) {
      seen.add(pid);
      const row = rows.find((p) => p.pid === pid);
      if (!row) break;
      protectedIds.set(pid, row.identity);
      pid = row.ppid;
    }
  }
  const targets = new Map<number, string>();
  const observed = ownership.identities ?? new Map<number, string>();
  for (const [pid, identity] of owned) if (!observed.has(pid)) observed.set(pid, identity);
  for (const row of rows) if (!observed.has(row.pid)) observed.set(row.pid, row.identity);
  let unknown = false;
  // Bounds the whole sweep; each probe is bounded on its own (15 s) and never blocks the loop.
  const deadline = Date.now() + 60_000;
  // One cwd verdict per identity: a later round never re-probes a process it already classified.
  const inspected = new Set<string>();
  const discover = async (snapshot: ReapProcess[]) => {
    const children = new Map<number, number[]>();
    for (const row of snapshot) {
      const siblings = children.get(row.ppid) ?? [];
      siblings.push(row.pid);
      children.set(row.ppid, siblings);
    }
    const descendants = (seeds: Set<number>, stop = new Set<number>()) => {
      const queue = [...seeds];
      for (let index = 0; index < queue.length; index++) {
        for (const pid of children.get(queue[index]!) ?? []) if (!seeds.has(pid) && !stop.has(pid)) {
          seeds.add(pid); queue.push(pid);
        }
      }
    };
    const tree = new Set(snapshot.filter((row) =>
      owned.get(row.pid) === row.identity || roots.some((r) => r.pid === row.pid && r.identity === row.identity)
      || (group !== undefined && row.group === group)).map((row) => row.pid));
    descendants(tree);
    await resolveActiveShellIdentities();
    const receipts = activeShellIdentities();
    for (const [pid, identity] of receipts) if (identity === undefined && tree.has(pid)) unknown = true;
    const excluded = new Set(snapshot.filter((row) => row.pid === process.pid
      || ownership.excludedGroups.includes(row.group)
      || (receipts.has(row.pid) && (receipts.get(row.pid) === undefined || receipts.get(row.pid) === row.identity))).map((row) => row.pid));
    // A daemon ancestor is protected, but the explicitly owned dispatch branch is not.
    descendants(excluded, new Set(snapshot.filter((row) => roots.some((r) => r.pid === row.pid && r.identity === row.identity)).map((row) => row.pid)));
    for (const row of snapshot) if (protectedIds.get(row.pid) === row.identity) excluded.add(row.pid);
    const candidates: ReapProcess[] = [];
    for (const row of snapshot) {
      if (!tree.has(row.pid) || excluded.has(row.pid)) continue;
      if (observed.has(row.pid) && observed.get(row.pid) !== row.identity) { unknown = true; continue; }
      observed.set(row.pid, row.identity);
      owned.set(row.pid, row.identity);
      if (!inspected.has(row.identity)) { inspected.add(row.identity); candidates.push(row); }
    }
    if (candidates.length && Date.now() > deadline) { unknown = true; return; }
    // Probe concurrently, then record verdicts in snapshot order.
    const verdicts = await Promise.all(candidates.map(async (row): Promise<"target" | "spared" | "unknown"> => {
      const details = await workerReapHost.inspect(row.pid);
      // A child that exited between the snapshot and this probe is a normal race, not
      // unreadable ownership; only a still-live identity with no readable cwd is unknown.
      // OBS-1173 add.2: a FAILED recheck (null) is unknown too — it never reads as gone.
      if (!details) {
        const recheck = await workerReapHost.identity(row.pid);
        return recheck === row.identity || recheck === null ? "unknown" : "spared";
      }
      if (details.suiteParent === process.pid || excludedPaths.some((path) => below(path, details.cwd))) return "spared";
      if (!below(root, details.cwd)) return "spared";
      // OBS-1173: the same race after a readable cwd — a short-lived tool child that exits between
      // inspect and this recheck is gone, not unreadable. Only a live, different identity — or a
      // failed probe (null, OBS-1173 add.2), which is never gone — is unknown.
      const current = await workerReapHost.identity(row.pid);
      if (current === row.identity) return "target";
      return current === undefined ? "spared" : "unknown";
    }));
    candidates.forEach((row, index) => {
      if (verdicts[index] === "unknown") unknown = true;
      if (verdicts[index] !== "target") return;
      targets.set(row.pid, row.identity);
      if (row.group !== group && !ownership.strays.includes(row.pid)) ownership.strays.push(row.pid);
    });
  };
  await discover(rows); // capture detached ancestry before killing its parents
  // A protected/foreign group member rules out a group signal. Signal only proven identities.
  const members = group === undefined ? [] : rows.filter((row) => row.group === group);
  if (group !== undefined && members.length && members.every((row) => targets.get(row.pid) === row.identity)
      && (await Promise.all(members.map((row) => workerReapHost.identity(row.pid)))).every((identity, index) => identity === members[index]!.identity)) {
    try { workerReapHost.kill(-group); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") unknown = true;
    }
  }
  let survivors: number[] = [];
  if (targets.size === 0) return unknown ? null : [];
  for (let probe = 0; probe < 5; probe++) {
    // Revalidate immediately before each signal, including after any slow cwd probe.
    await Promise.all([...targets].map(async ([pid, identity]) => {
      const current = await workerReapHost.identity(pid);
      if (current !== identity) {
        if (current !== undefined) unknown = true;
        return;
      }
      try { workerReapHost.kill(pid); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") unknown = true;
      }
    }));
    await new Promise((resolve) => setTimeout(resolve, probe === 0 ? 10 : 50));
    rows = await workerReapHost.snapshot();
    if (!rows || Date.now() > deadline) return null;
    await discover(rows);
    survivors = rows.filter((row) => targets.get(row.pid) === row.identity).map((row) => row.pid);
    if (!survivors.length) return unknown ? null : [];
  }
  return unknown ? null : survivors;
}

interface WorkerTreeCpuSnapshot {
  processes: Map<string, number>;
  resolutionMs: number;
}

let linuxClockTickMs: Promise<number | undefined> | undefined;
function linuxProcessCpuMs(pid: string, cwd: string): Promise<{ ms: number; resolutionMs: number } | undefined> {
  if (!existsSync("/proc/self/stat")) return Promise.resolve(undefined);
  // shGit, not sh: the accountant samples at 100ms cadence and must not run the operator's login
  // profile (nvm/pyenv/direnv side effects included) on every sample.
  linuxClockTickMs ??= shGit("getconf CLK_TCK", cwd, 15_000).then((r) => {
    const ticks = r.code === 0 ? Number(r.stdout.trim()) : Number.NaN;
    return Number.isFinite(ticks) && ticks > 0 ? 1_000 / ticks : undefined;
  });
  return linuxClockTickMs.then((resolutionMs) => {
    if (resolutionMs === undefined) return undefined;
    try {
      // `/proc/<pid>/stat` fields 14-17 are user/system jiffies for the process and its waited-for
      // children. Child totals retain tools that start and exit wholly between live-tree polls.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const ticks = Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]);
      return Number.isFinite(ticks) ? { ms: ticks * resolutionMs, resolutionMs } : undefined;
    } catch {
      return undefined;
    }
  });
}

// Every non-seeded worker process descends from its attempt-unique dispatch script. One ps snapshot
// finds that root and its descendants. An empty tree is measurable zero; a failed or unparseable
// snapshot is undefined because missing evidence can never prove inactivity.
async function workerTreeCpuSnapshot(marker: string, cwd: string, group?: number, identities?: Map<number, string>): Promise<WorkerTreeCpuSnapshot | undefined> {
  const snapshot = await shGit("ps -Awwo pid=,ppid=,time=,command=", cwd, 15_000);
  if (snapshot.code !== 0) return undefined;
  const rows: { pid: string; ppid: string; cpuMs: number; frac: boolean; cmd: string }[] = [];
  for (const line of snapshot.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cpu = parsePsCpu(m[3]!);
    if (cpu !== undefined) rows.push({ pid: m[1]!, ppid: m[2]!, cpuMs: cpu.ms, frac: cpu.frac, cmd: m[4]! });
  }
  if (rows.length === 0) return undefined;
  const tree = new Set(rows.filter((p) => p.cmd.includes(marker)).map((p) => p.pid));
  // CPU presentation matching is intentionally broader than authority to signal a process.
  const owned = new Set(rows.filter((p) => p.cmd === `bash ${marker}` || p.cmd === `/bin/bash ${marker}`).map((p) => p.pid));
  if (group !== undefined) {
    const groups = await shGit("ps -Awwo pid=,pgid=", cwd, 15_000);
    if (groups.code !== 0) return undefined;
    for (const line of groups.stdout.split("\n")) {
      const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (row && Number(row[2]) === group) tree.add(row[1]!);
    }
  }
  // ps output is not topologically ordered; relax the parent -> child closure until stable.
  for (let grew = true; grew;) {
    grew = false;
    for (const p of rows) {
      if (!owned.has(p.pid) && owned.has(p.ppid)) { owned.add(p.pid); grew = true; }
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  const precise = new Map<string, number>();
  let preciseResolutionMs: number | undefined;
  for (const p of rows) {
    if (!tree.has(p.pid)) continue;
    if (identities && owned.has(p.pid) && !identities.has(Number(p.pid))) {
      const identity = await processIdentity(Number(p.pid));
      if (identity) identities.set(Number(p.pid), identity);
    }
    const cpu = await linuxProcessCpuMs(p.pid, cwd);
    precise.set(p.pid, cpu?.ms ?? p.cpuMs);
    if (cpu !== undefined) preciseResolutionMs = cpu.resolutionMs;
  }
  if (preciseResolutionMs === undefined && existsSync("/proc/self/stat")) {
    preciseResolutionMs = (await linuxProcessCpuMs(String(process.pid), cwd))?.resolutionMs;
  }
  return {
    processes: precise,
    resolutionMs: preciseResolutionMs ?? (rows.some((p) => p.frac) ? 10 : 1_000),
  };
}

export async function workerTreeCpuMs(
  marker: string,
  cwd: string,
): Promise<{ ms: number; resolutionMs: number } | undefined> {
  const snapshot = await workerTreeCpuSnapshot(marker, cwd);
  if (snapshot === undefined) return undefined;
  return {
    ms: [...snapshot.processes.values()].reduce((sum, cpuMs) => sum + cpuMs, 0),
    resolutionMs: snapshot.resolutionMs,
  };
}

// Sparse live-tree totals forget a tool's CPU as soon as it exits. This attempt-local accountant
// instead accumulates each observed PID's delta and replaces only the live-PID cursor. Daemon workers
// and gate workers deliberately share these semantics: the marker is the unique dispatch script,
// an unreadable sample clears the current evidence, and stopped descendants remain in the total.
export class WorkerTreeCpuAccountant {
  private active = false;
  private loop: Promise<void> | undefined;
  private live = new Map<string, number>();
  private totalMs = 0;
  private gaps = 0;
  private consecutiveGaps = 0;
  private latest: { ms: number; resolutionMs: number } | undefined;

  constructor(private marker: string, private cwd: string, private group?: () => number | undefined,
    private identities?: Map<number, string>) {}

  private async sample(): Promise<void> {
    const snapshot = await workerTreeCpuSnapshot(this.marker, this.cwd, this.group?.(), this.identities);
    if (snapshot === undefined) {
      this.gaps++;
      this.live.clear();
      this.latest = undefined;
      if (++this.consecutiveGaps >= WORKER_TREE_CPU_UNMEASURABLE_SAMPLE_CAP) this.active = false;
      return;
    }
    this.consecutiveGaps = 0;
    for (const [pid, cpuMs] of snapshot.processes) {
      const prior = this.live.get(pid);
      this.totalMs += prior === undefined || cpuMs < prior ? cpuMs : cpuMs - prior;
    }
    this.live = snapshot.processes;
    this.latest = { ms: this.totalMs, resolutionMs: snapshot.resolutionMs };
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.sample();
    this.loop = (async () => {
      while (this.active) {
        await new Promise((resolve) => setTimeout(resolve, WORKER_TREE_CPU_ACCOUNTING_POLL_MS));
        if (this.active) await this.sample();
      }
    })();
  }

  read(): { cpu: { ms: number; resolutionMs: number } | undefined; gaps: number } {
    return { cpu: this.latest, gaps: this.gaps };
  }

  async stop(): Promise<void> {
    this.active = false;
    await this.loop;
  }
}

// T1 (OBS-262): the rescue nudge's adapter scope — claude-code only (steering path proven,
// OBS-122). Widening it is a future fixture-capture chore (an occupied-frame capture per adapter,
// OBS-181 scar), never a drive-by edit. Lives in the stall module so the watchdog's policy and its
// scope constant cannot drift apart.
export const NUDGEABLE_ADAPTERS = new Set(["claude-code"]);

// T1 (OBS-263): a LIVE provider banner is the last thing the pane printed — the worker stopped
// underneath it. A "quota"/"rate limit" mention inside the task prompt, a diff hunk, or earlier
// output sits ABOVE the transcript tail and must never fail an attempt over, so the in-loop quota
// classifier reads only this many trailing non-empty rows instead of the whole retained snapshot.
// ponytail: rows, not a banner grammar — the ceiling is a worker frozen with a quota mention as its
// literal last output; the two-consecutive-slices + tracker-silence gates bound that cost to one
// failover within the routing floor. Upgrade path is a per-adapter banner fixture if it ever bites.
export const QUOTA_BANNER_TAIL_ROWS = 12;
export function stallSnapshotTail(text: string, rows: number = QUOTA_BANNER_TAIL_ROWS): string {
  return normalizeStallSnapshot(text)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-rows)
    .join("\n");
}

// T1 review (chrome-blind-matcher class, OBS-152/155): the tail of a RENDERED TUI frame is not
// "what the pane printed last" — its bottom rows are fixed composer/welcome chrome. Codex pins
// "• You have 3 usage limit resets available." there, so a raw-tail QUOTA_RE match fires on every
// frame of a wedged pane (verified against all 8 frames of tests/fixtures/codex-mcp-spinner) and
// would fail a live worker over mid-work. Filter the KNOWN chrome instead of everything on screen
// at some anchor: a novelty baseline cannot distinguish "chrome that was already there" from "a
// real banner the CLI printed before the first poll read" — a channel throttled at launch paints
// its banner inside the first BLOCKED_POLL_MS slice, so the banner BECOMES the baseline and is
// exculpated forever (proven by execution: banner-from-the-first-loop-read fails over on shipped
// 843328b0, parks human under the baseline). This line is semantically the opposite of exhaustion
// — resets AVAILABLE — so matching it out can never hide a real banner. Closed allowlist, same
// philosophy as the normalizer's: a new adapter's quota-flavored chrome is a fixture-capture
// chore, never a drive-by edit.
const QUOTA_CHROME_RE = /usage limit resets? available/i;
export function stallSnapshotBannerRows(text: string, rows: number = QUOTA_BANNER_TAIL_ROWS): string {
  return stallSnapshotTail(text, rows)
    .split("\n")
    .filter((line) => !QUOTA_CHROME_RE.test(line))
    .join("\n");
}

// T1 (OBS-262/263, speed-spec §2): past fifteen minutes with a FLAT token-usage counter, row
// growth alone no longer re-arms the inactivity window — cosmetic repaint rows are not paid work.
// Token usage is the paid-work signal the tracker already samples; token growth always re-arms.
export const ROW_REARM_TOKEN_FLAT_MS = 15 * 60_000;
// Test seam, same pattern as the daemon's timing seams: production reads the constant.
let rowRearmTokenFlatMs = ROW_REARM_TOKEN_FLAT_MS;
export function setRowRearmTokenFlatMsForTests(ms: number): void {
  rowRearmTokenFlatMs = ms;
}
export function resetRowRearmTokenFlatMsForTests(): void {
  rowRearmTokenFlatMs = ROW_REARM_TOKEN_FLAT_MS;
}

// T1 review (read-ceiling blindness): the daemon samples panes through `driver.read(slot, N)` —
// a bounded window. This constant IS that N, and the daemon's pane reads must use it (never a
// literal) so the tracker's saturation check below cannot drift away from the real read depth.
export const PANE_READ_ROWS = 1000;

/**
 * Monotonic worker-progress measure for the stall watchdog.
 *
 * Terminal chrome is allowed to repaint arbitrary bytes in place, so byte differences are not
 * evidence of work. A rendered transcript is only known to have grown when it occupies more
 * non-empty rows than any prior sample. Same-row rewrites are deliberately ambiguous and do not
 * advance the clock: a recoverable early consult is safer than silencing the watchdog forever.
 *
 * CEILING: `transcriptRows` is a monotone high-water over the daemon's bounded pane read
 * (PANE_READ_ROWS lines), so it is a one-way ratchet whose signal goes blind once the pane's
 * content exceeds the read window — the same full window slides and `observe()` can never
 * report row growth again. Past that point a `false` return means "unmeasurable", not "no
 * output" — consumers making a kill decision (the dead-channel fast-kill) must check
 * `rowSignalSaturated` and stand down on it.
 */
export class StallProgressTracker {
  private transcriptRows = 0; // non-empty high-water over the bounded read — the growth signal
  private rawWindowLines = 0; // raw-line high-water — the SATURATION signal (see the getter)
  private seedSubmitted = false;
  private contextTokens: number | undefined;
  private lastTokenGrowthAt: number | undefined; // undefined until the first token sample anchors the flat-clock
  private rowGrowthAt: number | undefined; // raw row-growth clock — NEVER suppressed by the flat-token rule

  /** True once a sample FILLED the bounded read window on RAW lines (blanks and chrome-only
   * rows included): the pane's real extent is then unknown — genuinely new content scrolls out
   * of the read and the row high-water can never advance again — so a flat tracker is blindness,
   * not silence. The raw window is the saturation signal, NOT the normalized non-empty count: a
   * production `read(slot, PANE_READ_ROWS)` returns at most PANE_READ_ROWS lines including blank
   * and chrome-only rows (measured 730 non-empty of 1000 on the codex-mcp-spinner fixture), so
   * comparing the non-empty high-water against PANE_READ_ROWS could never engage and the
   * fast-kill's stand-down was unreachable. Sticky by construction (the high-water never
   * decreases). */
  get rowSignalSaturated(): boolean {
    return this.rawWindowLines >= PANE_READ_ROWS;
  }

  /** Raw row-growth clock: the last observe() that advanced the row high-water, recorded even
   * when the flat-token rule suppresses the progress REPORT (observe returns false). T1 review:
   * the dead-channel fast-kill's "no output growth" leg must read this, not the suppressed
   * progress clock — a metered adapter whose sticky token counter freezes the report while the
   * pane keeps streaming rows is alive, and only this clock sees it. */
  get lastRowGrowthAt(): number | undefined {
    return this.rowGrowthAt;
  }

  observe(sample: StallProgressSample, now: number = Date.now()): boolean {
    let rowsAdvanced = false;
    // raw window high-water first — this is the saturation signal (rowSignalSaturated), and it
    // must see the sample exactly as the bounded read returned it, blanks and chrome included.
    const rawLines = sample.paneText.split("\n").length;
    if (rawLines > this.rawWindowLines) this.rawWindowLines = rawLines;
    const rows = normalizeStallSnapshot(sample.paneText)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .length;
    if (rows > this.transcriptRows) {
      this.transcriptRows = rows;
      rowsAdvanced = true;
      this.rowGrowthAt = now; // raw signal — advances even when the report below is suppressed
    }
    let seedAdvanced = false;
    if (sample.seedSubmitted && !this.seedSubmitted) {
      this.seedSubmitted = true;
      seedAdvanced = true;
    }
    let tokensAdvanced = false;
    const tokens = sample.contextTokens;
    if (tokens !== undefined && Number.isFinite(tokens)) {
      if (tokens > (this.contextTokens ?? 0)) tokensAdvanced = true;
      // T1 review: ANY movement re-anchors the flat-clock, not just a new high-water mark — a
      // context compaction drops the counter, and the climb back below the old peak is still paid
      // work. A high-water comparison would freeze the anchor forever on the first decrease. (The
      // first token sample always counts as movement: contextTokens starts undefined.)
      if (tokens !== this.contextTokens) this.lastTokenGrowthAt = now;
      this.contextTokens = tokens;
    }
    if (tokensAdvanced || seedAdvanced) return true;
    if (rowsAdvanced) {
      // T1: row growth past the flat-token cap is cosmetic — the paid-work counter has not moved,
      // so the inactivity window must NOT re-arm on it. A tracker that never sees a token sample
      // (unmetered adapter) keeps the old row-growth behavior.
      if (this.lastTokenGrowthAt !== undefined && now - this.lastTokenGrowthAt >= rowRearmTokenFlatMs) return false;
      return true;
    }
    return false;
  }
}

// ─── v1.65 T2: LLM-bound transcript filter ──────────────────────────────────────────────────────
// Consult dossiers and gate prompts pay tokens per transcript byte, so LLM-bound text runs through
// a per-line classifier: carriage-return overwrite churn keeps only the final paint, lines that are
// pure presentation (spinner/ANSI/elapsed only — classified via normalizeStallSnapshot above, never
// a parallel normalizer) drop, consecutive repaint frames that normalize equal squash to the last,
// and runs of passing-test lines collapse to a count line. Failure lines, exit codes, and summary
// lines always survive verbatim. Fail-open by contract: any internal error — or trivial savings —
// returns the original text; the filter may only ever cost noise, never evidence.

// Signal that must never drop: failure markers, exit codes, run summaries. Substring matches on
// purpose (AssertionError, FAILED) — over-keeping is the safe miss, same asymmetry as the allowlist.
const KEEP_RE = /[✗✖]|fail|error|exception|fatal|panic|exit\s*code|exit(?:ed)?\s+with|non-?zero|traceback|^\s*(?:tests?\b|test\s+(?:files|suites)|suites?\b|snapshots?\b|duration\b|summary\b)/i;

// Passing-test line shapes (vitest/jest/tap/go/pytest). Only KEEP-negative lines reach this class.
const PASS_RE = /^\s*(?:[✓✔√]\s|ok\s+\d|PASS\b|---\s*PASS:)|\bPASSED\b/;

const COLLAPSE_MIN = 3; // a 1–2 line run costs less than the count line that would replace it
const MIN_SAVINGS_RATIO = 0.1; // below 10% shrink the rewrite is not worth its risk — pass through

function classifyTranscript(text: string): string {
  const out: string[] = [];
  let run: string[] = [];
  let prevNorm: string | null = null;
  const flush = () => {
    if (run.length >= COLLAPSE_MIN) out.push(`[${run.length} passing-test lines collapsed]`);
    else out.push(...run);
    run = [];
  };
  for (const raw of text.split("\n")) {
    // CR overwrite churn: the final paint wins; earlier paints carrying must-keep signal survive too.
    const segs = raw.split("\r");
    for (const line of segs.filter((s, i) => i === segs.length - 1 || KEEP_RE.test(s))) {
      if (KEEP_RE.test(line)) { flush(); out.push(line); prevNorm = null; continue; }
      if (PASS_RE.test(line)) { run.push(line); prevNorm = null; continue; }
      flush();
      const norm = normalizeStallSnapshot(line);
      if (line.trim() !== "" && norm.trim() === "") continue; // pure spinner/ANSI/elapsed frame
      if (norm !== "" && norm === prevNorm) { out[out.length - 1] = line; continue; } // repaint of the prior line — latest wins
      out.push(line);
      prevNorm = norm;
    }
  }
  flush();
  return out.join("\n");
}

/** Filter transcript text bound for an LLM prompt (consult dossiers, gate prompts). The classify
 * seam exists for fault injection in tests only — production callers pass text alone. */
export function filterLlmTranscript(text: string, classify: (t: string) => string = classifyTranscript): string {
  try {
    const filtered = classify(text);
    return text.length - filtered.length < text.length * MIN_SAVINGS_RATIO ? text : filtered;
  } catch {
    return text; // fail open — a filter defect must never cost the consult its evidence
  }
}
