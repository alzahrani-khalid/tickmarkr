import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tickmarkrDir } from "../src/graph/graph.js";
import { recordFatalRunEnd } from "../src/run/daemon.js";
import { Journal } from "../src/run/journal.js";
import { makeRepo, makeTestTempDir } from "./helpers/tmprepo.js";

// The overseer's shell watchers read a run's terminal record and its lock without the product's
// folds, so each carries the fatal rule itself: a crash is NOT GREEN even with every bucket empty, and
// a lock left by a dead daemon is no launch. The canonical scripts live under skills/; the installed
// copies under .claude/skills/ (watch-journal a symlink, watch-launch a byte-identical twin) are
// export-excluded, so each twin is exercised wherever it exists.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copies = (name: string) => [
  join(ROOT, "skills/tickmarkr-overseer/scripts", name),
  join(ROOT, ".claude/skills/tickmarkr-overseer/scripts", name),
].filter((p) => existsSync(p));

/**
 * A PATH holding a fake `sleep` (and `herdr`): each call counts itself and runs the staged action for
 * that call number, so an event lands strictly AFTER the watcher armed — no wall-clock race.
 */
const shimPath = (onSleep: Record<number, string>) => {
  const bin = makeTestTempDir("watch-shim-");
  const count = join(bin, "sleeps");
  const cases = Object.entries(onSleep).map(([n, action]) => `  ${n}) ${action} ;;`).join("\n");
  writeFileSync(join(bin, "sleep"), `#!/bin/sh\nn=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 ))\necho "$n" > "${count}"\ncase "$n" in\n${cases}\nesac\n/bin/sleep 0.05\n`);
  writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n");
  for (const f of ["sleep", "herdr"]) chmodSync(join(bin, f), 0o755);
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, sleeps: () => Number(readFileSync(count, "utf8")) };
};

/** One run's journal as production writes it, staged outside the watched runs directory. */
const stagedJournal = (runId: string, write: (journal: Journal) => void): string => {
  const repo = makeRepo({ "README.md": "x\n" });
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { runId });
  write(journal);
  return join(tickmarkrDir(repo), "runs", runId, "journal.jsonl");
};

const watchJournal = (script: string, runId: string, staged: string) => {
  const runs = makeTestTempDir("watch-runs-");
  const shim = shimPath({ 1: `mkdir -p "${join(runs, runId)}" && cp "${staged}" "${join(runs, runId, "journal.jsonl")}"` });
  return spawnSync("bash", [script, runs, "1", "5", "run-end"], { encoding: "utf8", env: shim.env });
};

describe("the overseer watchers read a fatal run-end and a dead holder's lock as not green", () => {
  test("test: both watch-journal copies print NOT GREEN with the fatal reason for a fatal run-end with every bucket empty versus EXECUTION COMPLETE for a normal all-done run-end", () => {
    // a setup crash: no graph reached the record, so every bucket is empty
    const fatal = stagedJournal("run-fatal", (j) => recordFatalRunEnd(j, "run-fatal", "b", new Error("integration branch refused")));
    const quoted = stagedJournal("run-fatal-quoted", (j) => recordFatalRunEnd(j, "run-fatal-quoted", "b",
      new Error(`"refs/heads/topic" could not be locked:\npermission denied at C:\\tmp\\lock`)));
    const normal = stagedJournal("run-normal", (j) => j.append("run-end", undefined,
      { runId: "run-normal", done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" }));
    const scripts = copies("watch-journal.sh");
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const script of scripts) {
      const crashed = watchJournal(script, "run-fatal", fatal);
      expect(crashed.status, script).toBe(0);
      expect(crashed.stdout).toContain("RUN_END run-fatal — NOT GREEN (fatal: setup failed: integration branch refused; tipVerify=unknown)");
      expect(crashed.stdout).toContain("done=[] failed=[] human=[] blocked=[] pending=[]");
      expect(crashed.stdout).toContain("a fatal run-end is never green");
      expect(crashed.stdout).not.toContain("EXECUTION COMPLETE");

      // the reason is the DECODED error: a quoted ref (escaped `\"` in the journal) never cuts it short
      const quotedRun = watchJournal(script, "run-fatal-quoted", quoted);
      expect(quotedRun.status, script).toBe(0);
      expect(quotedRun.stdout).toContain(`RUN_END run-fatal-quoted — NOT GREEN (fatal: setup failed: "refs/heads/topic" could not be locked: permission denied at C:\\tmp\\lock; tipVerify=unknown)`);

      const green = watchJournal(script, "run-normal", normal);
      expect(green.status, script).toBe(0);
      expect(green.stdout).toContain("RUN_END run-normal — EXECUTION COMPLETE (tipVerify=passed)");
      expect(green.stdout).not.toContain("NOT GREEN");
    }
  }, 30_000);

  // D-1756: the reviewers' payloads — a 7-bit and an 8-bit OSC title, ST and CSI clear — print as
  // visible escapes in both lines that name the crash, beside a plain error that prints unchanged.
  test.each([
    ["plain", "lock lost", "lock lost"],
    ["7-bit OSC/CSI", "\x1b]0;GREEN\x07\x1b[2J\x1b[Hlock lost", "\\x1b]0;GREEN\\x07\\x1b[2J\\x1b[Hlock lost"],
    ["8-bit OSC/ST/CSI", "\x9d0;GREEN\x9c\x9b2J\x9bHlock lost", "\\u009d0;GREEN\\u009c\\u009b2J\\u009bHlock lost"],
  ])("%s: both watch-journal copies print a fatal error's terminal controls as visible escapes, never raw", (_, raw, shown) => {
    const staged = stagedJournal("run-fatal-controls", (j) => recordFatalRunEnd(j, "run-fatal-controls", "b", new Error(raw)));
    for (const script of copies("watch-journal.sh")) {
      const r = watchJournal(script, "run-fatal-controls", staged);
      expect(r.status, script).toBe(0);
      expect(r.stdout).toContain(`RUN_END run-fatal-controls — NOT GREEN (fatal: setup failed: ${shown}; tipVerify=unknown)`);
      expect(r.stdout).toContain(`the run CRASHED (setup failed: ${shown})`);
      expect(r.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
    }
  }, 30_000);

  test("test: both watch-launch copies keep waiting past a lock whose holder pid is dead and print LAUNCH_OK only for a live holder versus accepting the stale lock", () => {
    const dead = spawnSync("true").pid!; // exited and reaped: its pid is provably dead
    const live = process.pid; // this test process — live for the whole watch
    const scripts = copies("watch-launch.sh");
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const script of scripts) {
      // a stale lock is present from the start; the live holder's lock replaces it on the 3rd poll
      const wt = makeTestTempDir("watch-launch-wt-");
      const lock = join(wt, "graph.lock");
      mkdirSync(wt, { recursive: true });
      writeFileSync(lock, `{"pid":${dead},"runId":"run-stale"}\n`);
      const relock = shimPath({ 3: `printf '%s\\n' '{"pid":${live},"runId":"run-live"}' > "${lock}"` });
      const r = spawnSync("bash", [script, lock, "20", "wZ:pTEST", "1"], { encoding: "utf8", env: relock.env });
      expect(r.status, script).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^LAUNCH_OK \\d\\d:\\d\\d:\\d\\dZ \\{"pid":${live},"runId":"run-live"\\}$`, "m"));
      expect(r.stdout).not.toContain("run-stale");
      expect(relock.sleeps()).toBeGreaterThanOrEqual(3); // it waited past the stale lock

      // control: a lock whose holder stays dead is never a launch — the deadline passes and it is overdue
      const staleOnly = makeTestTempDir("watch-launch-wt-");
      writeFileSync(join(staleOnly, "graph.lock"), `{"pid":${dead},"runId":"run-stale"}\n`);
      const stale = spawnSync("bash", [script, join(staleOnly, "graph.lock"), "1", "wZ:pTEST", "1"], { encoding: "utf8", env: shimPath({}).env });
      expect(stale.status, script).toBe(3);
      expect(stale.stdout).toContain("LAUNCH_OVERDUE");
      expect(stale.stdout).not.toContain("LAUNCH_OK");
    }
  }, 60_000);
});
