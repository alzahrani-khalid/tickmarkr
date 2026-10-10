import { execFile } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isRunnerCommand } from "./lease.js";
import { SUITE_PARENT_ENV } from "./git.js";

/**
 * Queue row 103 (D-1553): the live-suite census asks each runner-looking process for its cwd and its inherited
 * TICKMARKR_SUITE_PARENT marker. It used to ask one pid at a time with a synchronous `lsof` and `ps`, which held the
 * daemon's event loop 44–46 s under a full suite (the stall traces recorded for queue row 8). Here every pid is answered by /proc where it
 * exists (Linux, child-free), else by ONE async `lsof` and ONE async `ps eww`, plus one more `lsof` for suite parents
 * not already probed — the census asks for a parent's cwd too. The answers feed countLiveSuites' existing lookups.
 */
export type ProbeExec = (file: string, args: readonly string[]) => Promise<string>;

// A pid that exits between the snapshot and the probe makes lsof/ps exit non-zero while still printing every other
// row, so an ordinary non-zero exit (a numeric code, no signal) keeps whatever was printed. D-1564: a timeout, a kill, a
// spawn failure or an output-cap overflow is no answer — the base's execFileSync threw there and discarded any partial
// output, so these answer nothing even when they buffered rows first.
// D-1561: execFile can also throw SYNCHRONOUSLY (EPERM, EAGAIN under fork pressure); the base's per-pid try/catch answered
// that as "unknown", so this probe never throws or rejects either — it answers nothing.
const probeExec: ProbeExec = (file, args) => new Promise((resolve) => {
  try {
    execFile(file, [...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error && (error.killed || error.signal || typeof error.code !== "number") ? "" : String(stdout ?? "")));
  } catch {
    resolve("");
  }
});

// D-1567 batch poisoning: lsof and ps fail the WHOLE command for one -p member they cannot take (a marker of 22 digits
// prints as 1e+21, 310 nines as Infinity; ps refuses one above int32), erasing every other pid's answer. The base probed
// per pid, so such a pid lost only its own answer: it stays unanswered here and never joins a batch.
const probeable = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;

/** Each pid's working directory: /proc first, then ONE batched lsof for the rest; never rejects, and reads no process
 * environment (the runner-lease wait names blockers through it, queue row 120). Answers land in `cwds`. */
export async function batchedProcessCwds(pids: readonly number[], exec: ProbeExec = probeExec, proc: ProcReader = procReader,
  cwds = new Map<number, string>()): Promise<Map<number, string>> {
  const rest: number[] = [];
  for (const pid of pids.filter(probeable)) {
    try { cwds.set(pid, proc.cwd(pid)); } catch { rest.push(pid); } // Darwin has no /proc
  }
  if (rest.length === 0) return cwds;
  let listing = "";
  try { listing = await exec("lsof", ["-a", "-p", rest.join(","), "-d", "cwd", "-Fn"]); } catch { /* the census never rejects */ }
  let pid: number | undefined;
  for (const line of listing.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) {
      try { cwds.set(pid, realpathSync(line.slice(1))); } catch { /* the directory is gone */ }
    }
  }
  return cwds;
}

/** The pids of every live (non-zombie) row of a `ps -o pid=,ppid=,state=,command=` snapshot whose command is a runner. */
export function runnerPids(snapshot: string): number[] {
  const pids: number[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/s.exec(line);
    if (match && !match[3]!.startsWith("Z") && isRunnerCommand(match[4]!)) pids.push(Number(match[1]));
  }
  return pids;
}

/** The /proc reads, injectable so the Linux branch is testable anywhere; each throws where /proc has no entry. */
export interface ProcReader {
  cwd(pid: number): string;
  environ(pid: number): string;
}
const procReader: ProcReader = {
  cwd: (pid) => realpathSync(readlinkSync(`/proc/${pid}/cwd`)),
  environ: (pid) => readFileSync(`/proc/${pid}/environ`, "utf8"),
};

export interface CensusProbes {
  cwd: (pid: number) => string | undefined;
  suiteParent: (pid: number) => number | undefined;
}

export async function batchedProcessProbes(pids: readonly number[], exec: ProbeExec = probeExec, proc: ProcReader = procReader): Promise<CensusProbes> {
  // the census never rejects, whatever exec does (queue row 103's closed case table, D-1561)
  const ask = async (file: string, args: readonly string[]): Promise<string> => { try { return await exec(file, args); } catch { return ""; } };
  const cwds = new Map<number, string>();
  const parents = new Map<number, number>();
  const parentIn = (text: string) => new RegExp(`(?:^|\\s)${SUITE_PARENT_ENV}=(\\d+)(?:\\s|$)`).exec(text)?.[1];
  const probeCwds = (wanted: readonly number[]) => batchedProcessCwds(wanted, ask, proc, cwds);
  const probeParents = async (wanted: readonly number[]) => {
    const rest: number[] = [];
    for (const pid of wanted.filter(probeable)) {
      try {
        // the base's exact rule (7c8009772 daemon.ts:1418-1423, D-1558): ONE NUL-delimited entry, its WHOLE value digits —
        // a joined string would let another variable's text, or a value with trailing junk, pass for the marker
        const value = proc.environ(pid).split("\0").find((entry) => entry.startsWith(`${SUITE_PARENT_ENV}=`))?.slice(SUITE_PARENT_ENV.length + 1);
        if (value && /^\d+$/.test(value)) parents.set(pid, Number(value));
      } catch { rest.push(pid); } // Darwin has no /proc process environments
    }
    if (rest.length === 0) return;
    for (const line of (await ask("ps", ["eww", "-p", rest.join(","), "-o", "pid=,command="])).split("\n")) {
      const row = /^\s*(\d+)\s+(.*)$/s.exec(line);
      const value = row ? parentIn(row[2]!) : undefined;
      if (row && value) parents.set(Number(row[1]), Number(value));
    }
  };

  const unique = [...new Set(pids)];
  await probeCwds(unique);
  await probeParents(unique);
  await probeCwds([...new Set(parents.values())].filter((pid) => !cwds.has(pid)));
  return { cwd: (pid) => cwds.get(pid), suiteParent: (pid) => parents.get(pid) };
}
