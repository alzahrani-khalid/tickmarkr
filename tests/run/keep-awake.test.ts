import { ChildProcess, execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { status } from "../../src/cli/commands/status.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon, type RunOptions } from "../../src/run/daemon.js";
import { shOk } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { formatSpan, wallBudget } from "../../src/run/wall-budget.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const fixture = () => setupRepo([T("T1")], { tasks: {
  T1: [{ shell: `echo awake > awake.txt && ${COMMIT} awake`, result: { ok: true, summary: "awake" } }],
} });

// A ChildProcess event source without an OS process: no test starts caffeinate.
function recordingChild() {
  const child = new ChildProcess();
  child.pid = 43210;
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  return { child, kill };
}

test("test: the production daemon on darwin starts one keep-awake child for its own pid with the idle and wait flags, journals it and ends it when the run returns, while on another platform it starts none, so a run leaving its machine to sleep or leaking the child fails", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { repo, fake } = fixture();
    const { child, kill } = recordingChild();
    const spawn = vi.fn(() => {
      expect(JSON.parse(readFileSync(join(repo, ".tickmarkr", "graph.lock"), "utf8"))).toMatchObject({ pid: process.pid });
      return child;
    });
    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-awake", keepAwake: { spawn, platform },
      narrate: (row) => {
        if (row.event === "run-end") expect(kill).not.toHaveBeenCalled();
      },
    });
    expect(summary.done).toEqual(["T1"]);
    const events = Journal.open(repo, summary.runId).read();
    expect(events[0].event).toBe("baseline-start");
    const rows = events.filter(row => row.event.startsWith("keep-awake"));
    if (platform === "darwin") {
      expect(events.findIndex(row => row.event === "keep-awake")).toBeGreaterThan(events.findIndex(row => row.event === "run-start"));
      expect(spawn).toHaveBeenCalledExactlyOnceWith("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      expect(rows.map(row => ({ event: row.event, data: row.data }))).toEqual([{ event: "keep-awake", data: { pid: child.pid } }]);
      expect(kill).toHaveBeenCalledTimes(1);
    } else {
      expect(spawn).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
    }
    expect(existsSync(join(repo, ".tickmarkr", "graph.lock"))).toBe(false);
  }

  // The vitest switch applies even when the platform is explicitly darwin and the spawner is defaulted.
  const { repo, fake } = fixture();
  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-awake-vitest", keepAwake: { platform: "darwin" } });
  expect(summary.done).toEqual(["T1"]);
  expect(Journal.open(repo, summary.runId).read().filter(row => row.event.startsWith("keep-awake"))).toEqual([]);
}, 60_000);

test("test: a keep-awake child that cannot start or exits at once is journaled as failed and the run still completes and merges its task, so a best-effort keep-awake that ends the run fails", async () => {
  for (const outcome of ["throw", "error", "exit"] as const) {
    const { repo, fake } = fixture();
    const { child, kill } = recordingChild();
    const spawn: NonNullable<RunOptions["keepAwake"]>["spawn"] = vi.fn(() => {
      if (outcome === "throw") throw new Error("caffeinate unavailable");
      queueMicrotask(() => {
        if (outcome === "error") child.emit("error", new Error("spawn caffeinate ENOENT"));
        else child.emit("exit", 0, null);
      });
      return child;
    });
    const summary = await runDaemon(repo, { adapters: [fake], runId: `run-awake-${outcome}`, keepAwake: { spawn, platform: "darwin" } });
    expect(summary.done).toEqual(["T1"]);
    expect(summary.failed).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const rows = Journal.open(repo, summary.runId).read();
    expect(rows[0].event).toBe("baseline-start");
    expect(rows.findIndex(row => row.event === "keep-awake-failed")).toBeGreaterThan(rows.findIndex(row => row.event === "run-start"));
    const awake = rows.filter(row => row.event.startsWith("keep-awake"));
    expect(awake).toHaveLength(1);
    expect(awake[0].event).toBe("keep-awake-failed");
    expect(awake[0].data.error).toMatch(outcome === "exit" ? /exited within one second/ : /caffeinate/);
    expect(rows.filter(row => row.event === "merge").map(row => row.taskId)).toEqual(["T1"]);
    expect(await shOk(`git show ${summary.branch}:awake.txt`, repo)).toBe("awake\n");
    expect(kill).toHaveBeenCalledTimes(outcome === "throw" ? 0 : 1);
  }
}, 60_000);

test("keep-awake cleanup also runs when the daemon throws after starting its child", async () => {
  const { repo, fake } = fixture();
  const { child, kill } = recordingChild();
  const driver = new SubprocessDriver();
  driver.notify = async () => { throw new Error("notification failed"); };
  await expect(runDaemon(repo, { adapters: [fake], driver, runId: "run-awake-throw",
    keepAwake: { spawn: () => child, platform: "darwin" },
  })).rejects.toThrow("notification failed");
  expect(kill).toHaveBeenCalledTimes(1);
  expect(existsSync(join(repo, ".tickmarkr", "graph.lock"))).toBe(false);
});

function seedResume(repo: string, runId: string, data: Record<string, unknown> = {}) {
  const branch = `tickmarkr/${runId}`;
  const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", `refs/heads/${branch}`, baseRef], { cwd: repo });
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    pid: 111_111, branch, baseRef, commands: {}, integrationAnchor: "journal",
    graphDefinitionHash: graphDefinitionHash(loadGraph(repo)), ...data,
  });
  return journal;
}

// Exercise both keep-awake rows, every failure channel and the no-op platform across
// open and closed engagements. Only runDaemon writes the restart boundary under test.
test.each(["interrupted", "ended"].flatMap(lifecycle =>
  ["spawned", "throw", "error", "exit", "linux"].map(outcome => ({ lifecycle, outcome })),
))("a $lifecycle resume with $outcome keep-awake preserves downtime in wall-budget, report and status", async ({ lifecycle, outcome }) => {
  const { repo, fake } = fixture();
  const runId = "run-awake-restart";
  const journal = seedResume(repo, runId);
  const start = Date.now() - 1_001_000;
  const at = (seconds: number) => new Date(start + seconds * 1_000).toISOString();
  const prior = [
    { ...journal.read()[0], ts: at(0) },
    { event: "task-dispatch", taskId: "T1", ts: at(1), data: { assignment: {} } },
    { event: "worker-launch", taskId: "T1", ts: at(2), data: {} },
    ...(lifecycle === "ended" ? [{ event: "run-end", ts: at(3), data: {} }] : []),
  ];
  writeFileSync(join(journal.dir, "journal.jsonl"), prior.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  writeFileSync(join(repo, ".tickmarkr", "graph.lock"), JSON.stringify({
    pid: spawnSync("true").pid, runId, startedAt: start,
  }));
  const { child, kill } = recordingChild();
  const spawn = vi.fn(() => {
    if (outcome === "throw") throw new Error("caffeinate unavailable");
    if (outcome === "error") queueMicrotask(() => child.emit("error", new Error("spawn caffeinate ENOENT")));
    if (outcome === "exit") queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  });
  const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true,
    keepAwake: { spawn, platform: outcome === "linux" ? "linux" : "darwin" },
  });
  expect(summary.done).toEqual(["T1"]);
  const rows = journal.read();
  expect(rows.slice(0, prior.length)).toEqual(prior);
  expect(rows.some(row => row.event === "lock-reclaimed")).toBe(true);
  expect(rows.some(row => row.event === "exit-cause" && row.data.cause === "unclean")).toBe(lifecycle === "interrupted");
  const resumed = rows.findIndex(row => row.event === "run-resume");
  const downtime = Date.parse(rows[resumed].ts) - Date.parse(prior[prior.length - 1].ts);
  const budget = wallBudget(rows)!;
  expect(budget.exposedMs.interruption).toBe(downtime);
  expect(budget.residualMs).toBe(wallBudget(rows.filter(row => !row.event.startsWith("keep-awake")))!.residualMs);
  for (const output of [await report([runId], repo), await status([runId], repo)]) {
    expect(output).toContain(`interruption ${formatSpan(downtime)}`);
  }
  const awake = rows.filter(row => row.event.startsWith("keep-awake"));
  expect(awake.map(row => row.event)).toEqual(outcome === "linux" ? [] : [outcome === "spawned" ? "keep-awake" : "keep-awake-failed"]);
  if (awake.length) expect(rows.indexOf(awake[0])).toBeGreaterThan(resumed);
  expect(spawn).toHaveBeenCalledTimes(outcome === "linux" ? 0 : 1);
  expect(kill).toHaveBeenCalledTimes(outcome === "linux" || outcome === "throw" ? 0 : 1);
}, 30_000);

test.each([
  ["mismatched graph", /graph changed since this run/],
  ["unbound graph", /no recorded graph definition hash/],
  ["unreadable baseline", /existing baseline.json is unreadable/],
  ["changed baseline commands", /baseline recapture refused.*commands differ/],
  ["masked baseline commands", /baseline recapture refused.*masked/],
] as const)("a %s resume refusal starts no keep-awake child and adds no keep-awake row", async (condition, refusal) => {
  const { repo, fake } = fixture();
  const runId = "run-awake-late-refusal";
  const journal = seedResume(repo, runId, {
    ...(condition === "mismatched graph" ? { graphDefinitionHash: "stale" } : {}),
    ...(condition === "unbound graph" ? { graphDefinitionHash: undefined } : {}),
    ...(condition.includes("commands") ? { commands: { build: condition.startsWith("masked") ? "[REDACTED]" : "true" } } : {}),
  });
  if (condition === "unreadable baseline") writeFileSync(join(journal.dir, "baseline.json"), "{");
  const before = readFileSync(join(journal.dir, "journal.jsonl"), "utf8");
  const { child, kill } = recordingChild();
  const spawn = vi.fn(() => child);
  await expect(runDaemon(repo, { adapters: [fake], runId, resume: true,
    keepAwake: { spawn, platform: "darwin" },
  })).rejects.toThrow(refusal);
  expect(readFileSync(join(journal.dir, "journal.jsonl"), "utf8")).toBe(before);
  expect(spawn).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
  expect(existsSync(join(repo, ".tickmarkr", "graph.lock"))).toBe(false);
});

// Bounded refusal matrix: lifecycle checks, each unreadable anchor shape, and the
// marked/legacy ref rules all precede keep-awake, including a reclaimed lock.
test.each([
  ["superseded", /superseded by run-next/],
  ["no run-start", /has no run-start event/],
  ["unreadable base", /no readable published tip/],
  ["unreadable merge commit", /no readable published tip/],
  ["missing merge from", /no readable published tip/],
  ["marked moved ref", /last published tip \(value\)/],
  ["marked symbolic ref", /last published tip \(symbolic\)/],
  ["marked missing ref", /last published tip \(missing\)/],
  ["marked unreadable ref", /last published tip \(unreadable\)/],
  ["legacy symbolic ref", /is symbolic to refs\/heads\/main/],
  ["legacy dangling ref", /which names no commit/],
  ["legacy missing ref", /is missing while the journal records merges/],
  ["legacy unreadable ref", /is unreadable/],
] as const)("a %s resume leaves its journal unchanged and never starts keep-awake", async (condition, refusal) => {
  const { repo, fake } = fixture();
  const runId = "run-awake-refused";
  const branch = `tickmarkr/${runId}`;
  const ref = `refs/heads/${branch}`;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  const base = git("rev-parse", "HEAD");
  git("update-ref", ref, base);
  const journal = Journal.create(repo, runId);
  if (condition !== "no run-start") journal.append("run-start", undefined, {
    pid: 111_111, branch, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
    baseRef: condition === "unreadable base" ? "HEAD" : base,
    ...(condition.startsWith("legacy") ? {} : { integrationAnchor: "journal" }),
  });
  if (condition === "superseded") journal.append("superseded", undefined, { by: "run-next" });
  if (condition === "unreadable merge commit" || condition === "missing merge from" || condition === "legacy missing ref") {
    journal.append("merge", "T1", {
      branch: `${branch}--T1`, commit: condition === "unreadable merge commit" ? "garbage" : base,
      ...(condition === "missing merge from" ? {} : { from: base }),
    });
  }
  if (condition === "marked moved ref") git("update-ref", ref, git("commit-tree", `${base}^{tree}`, "-p", base, "-m", "moved"));
  if (condition.includes("symbolic ref")) git("symbolic-ref", ref, "refs/heads/main");
  if (condition === "legacy dangling ref") git("symbolic-ref", ref, "refs/heads/absent");
  if (condition.includes("missing ref")) git("update-ref", "-d", ref);
  if (condition.includes("unreadable ref")) writeFileSync(join(repo, ".git", ref), "garbage\n");
  // Reclamation must not add exit-cause or lock-reclaimed on any refused resume.
  writeFileSync(join(repo, ".tickmarkr", "graph.lock"), JSON.stringify({
    pid: spawnSync("true").pid, runId, startedAt: Date.now() - 60_000,
  }));
  const journalPath = join(journal.dir, "journal.jsonl");
  // Journal.create is lazy; keep the no-run-start journal present without a lifecycle row.
  if (condition === "no run-start") writeFileSync(journalPath, "");
  const before = readFileSync(journalPath, "utf8");
  const rowsBefore = journal.read();
  const { child, kill } = recordingChild();
  const spawn = vi.fn(() => child);
  await expect(runDaemon(repo, { adapters: [fake], runId, resume: true,
    keepAwake: { spawn, platform: "darwin" },
  })).rejects.toThrow(refusal);
  expect(journal.read()).toEqual(rowsBefore);
  expect(readFileSync(journalPath, "utf8")).toBe(before);
  expect(spawn).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
  expect(existsSync(join(repo, ".tickmarkr", "graph.lock"))).toBe(false);
});
