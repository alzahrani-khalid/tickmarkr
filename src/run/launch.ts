import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOST_SESSION_VARS, SEAT_MARKER_ENV } from "../drivers/host-env.js";
import { HERDR_CONTROL_VARS } from "../drivers/subprocess.js";
import { loadGraph, tickmarkrDir, stateDirName } from "../graph/graph.js";
import { parseRunId } from "./journal.js";
import { isPidLive, runLockOwner } from "./lock.js";

/** Exact-name subtraction only: no trusted-env bypass, prefix filtering or added defaults. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const name of [...HOST_SESSION_VARS, ...HERDR_CONTROL_VARS, SEAT_MARKER_ENV]) delete child[name];
  return child;
}

/** Re-enter this ACP's CLI with its own Node and loader flags, never a PATH-resolved binary. */
export function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  return cli(cwd, process.argv[1]!, args, env, signal);
}

function cli(cwd: string, self: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, self, ...args], {
      cwd, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { output += chunk; });
    // An abort still waits for stdio to close, so no command child outlives its turn.
    child.on("error", error => { if (!signal?.aborted) reject(error); });
    child.on("close", code => resolve({ exitCode: code ?? 1, output }));
  });
}

export type DaemonLaunch =
  | { status: "bound"; runId: string; pid: number; driver: "subprocess"; logPath: string }
  | { status: "refused"; message: string }
  | { status: "cancelled" };

type JournalMark = { bytes: number; ino: number; boundary: boolean };

// Record byte boundaries BEFORE spawning: a resume's historical rows prove nothing about this child.
function journalMarks(cwd: string, resumeTarget?: string): Map<string, JournalMark> {
  const marks = new Map<string, JournalMark>();
  const runs = join(cwd, stateDirName(cwd), "runs");
  let names: string[];
  try { names = readdirSync(runs); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return marks; throw error; }
  for (const name of names) {
    try { parseRunId(name); } catch { continue; }
    let fd: number | undefined;
    try {
      fd = openSync(join(runs, name, "journal.jsonl"), "r");
      const st = fstatSync(fd);
      const last = Buffer.alloc(1);
      if (st.size) readSync(fd, last, 0, 1, st.size - 1);
      marks.set(name, { bytes: st.size, ino: st.ino, boundary: !st.size || last[0] === 10 });
    } catch (error) {
      // Keep every readable history marked, including for a fresh launch. Only the
      // resume target's unreadable history can refuse this launch before spawning.
      if (name === resumeTarget && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return marks;
}

function hasLifecycle(cwd: string, runId: string, pid: number, verb: "run" | "resume", mark?: JournalMark): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(join(cwd, stateDirName(cwd), "runs", runId, "journal.jsonl"), "r");
    const st = fstatSync(fd);
    const offset = mark?.bytes ?? 0;
    if ((mark && st.ino !== mark.ino) || st.size < offset) throw new Error("journal replaced or truncated since launch");
    const bytes = Buffer.alloc(st.size - offset);
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    let text = bytes.subarray(0, count).toString("utf8");
    // Never complete a row that began before the spawn, nor accept an unterminated new row.
    if (mark && !mark.boundary) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    lines.pop();
    return lines.some(line => {
      try {
        const row = JSON.parse(line);
        return row?.event === (verb === "run" ? "run-start" : "run-resume") && row?.data?.pid === pid;
      } catch { return false; }
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** The single detached launch. It owns no lock or daemon lifetime and never sends a signal,
 * including on cancellation: even the version probe is allowed to finish without an AbortSignal. */
export async function launchDaemon(options: {
  cwd: string; self?: string; verb: "run" | "resume"; runId?: string; env?: NodeJS.ProcessEnv;
  cancelled?: () => boolean; onWaiting?: (child: { pid: number; logPath: string }) => void;
}): Promise<DaemonLaunch> {
  const { cwd, verb } = options;
  const cancelled = options.cancelled ?? (() => false);
  const cancel = { status: "cancelled" } as const;
  let logPath: string | undefined;
  let logOffset = 0;
  let pid: number | undefined;
  const refuse = (reason: string): DaemonLaunch => {
    if (cancelled()) return cancel;
    let tail = "";
    if (logPath) try {
      tail = readFileSync(logPath).subarray(logOffset).toString("utf8").replace(/\n$/u, "").split("\n").slice(-20).join("\n");
    } catch { /* the reason still identifies an unreadable log */ }
    return { status: "refused", message: `${reason}${pid ? `; child pid ${pid}${isPidLive(pid) ? " left running" : " exited"}, not signalled` : ""}${logPath ? `; log ${logPath}` : ""}${tail ? `\n${tail}` : ""}` };
  };
  try {
    const runId = verb === "resume" ? parseRunId(options.runId ?? "") : undefined;
    if (cancelled()) return cancel;
    const self = options.self ?? process.argv[1]!;
    const env = options.env ?? process.env;
    const check = await cli(cwd, self, ["version", "--check"], env);
    if (cancelled()) return cancel;
    if (check.exitCode !== 0) return refuse(`version --check exited ${check.exitCode}\n${check.output}`);
    const owner = runLockOwner(cwd);
    if (owner?.live) return refuse(`Launch refused: live lock held by pid ${owner.pid ?? "unknown"} (run ${owner.runId ?? "unknown"})`);
    // Preflight before journal marks or state creation; keep the daemon's graph loader authoritative.
    if (verb === "run") loadGraph(cwd);
    else if (!statSync(join(cwd, stateDirName(cwd), "runs", runId!, "journal.jsonl"), { throwIfNoEntry: false })?.isFile()) {
      return refuse(`Launch refused: no journal for run ${runId}`);
    }
    const marks = journalMarks(cwd, runId);
    logPath = join(tickmarkrDir(cwd), "daemon.log");
    const log = openSync(logPath, "a");
    let child;
    try {
      logOffset = fstatSync(log).size;
      if (cancelled()) return cancel;
      child = spawn(process.execPath, [...process.execArgv, self, verb, ...(runId ? [runId] : []), "--driver", "subprocess"], {
        cwd, env: childEnv(env), detached: true, stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    let exited = false;
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    child.on("exit", () => { exited = true; });
    child.unref();
    pid = child.pid;
    const deadline = Date.now() + 10_000;
    let heldRun: string | undefined;
    if (pid) options.onWaiting?.({ pid, logPath });
    for (;;) {
      if (cancelled()) return cancel;
      if (spawnError) return refuse(`Daemon spawn failed: ${spawnError.message}`);
      if (exited || (pid !== undefined && !isPidLive(pid))) return refuse("Daemon exited before readiness");
      if (!heldRun && Date.now() >= deadline) return refuse("No child lock within 10 seconds");
      const lock = runLockOwner(cwd);
      if (lock?.live) {
        if (lock.pid !== pid) return refuse(`Launch refused: live lock held by pid ${lock.pid ?? "unknown"} (run ${lock.runId ?? "unknown"})`);
        const namedRun = parseRunId(lock.runId ?? "");
        if ((runId && namedRun !== runId) || (heldRun && namedRun !== heldRun)) return refuse(`Child lock names run ${namedRun}, expected ${runId ?? heldRun}`);
        heldRun = namedRun;
        if (pid !== undefined && hasLifecycle(cwd, heldRun, pid, verb, marks.get(heldRun))) {
          const finalLock = runLockOwner(cwd);
          if (!finalLock?.live || finalLock.pid !== pid || finalLock.runId !== heldRun) return refuse("Child lock released or changed before binding");
          if (exited || !isPidLive(pid)) return refuse("Daemon exited before binding");
          if (cancelled()) return cancel; // Last check: cancellation wins even alongside the row.
          return { status: "bound", runId: heldRun, pid, driver: "subprocess", logPath };
        }
      } else if (heldRun) return refuse("Child lock released or changed before its lifecycle row");
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  } catch (error) { return refuse(`Launch refused: ${error instanceof Error ? error.message : String(error)}`); }
}
