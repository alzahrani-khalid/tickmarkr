import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { repairSelectionDecision } from "../../src/run/repair-selection.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon, setApprovalWindowForTests, resetApprovalWindowForTests, setLiveSuiteCountForTests, resetLiveSuiteCountForTests } from "../../src/run/daemon.js";
import { gitHead, shGitOk, worktreePath } from "../../src/run/git.js";
import { COMMAND_LEASE_TOKEN_ENV } from "../../src/run/lease.js";
import { Journal } from "../../src/run/journal.js";
import { failureDisposition, reserveInfrastructureRetry } from "../../src/run/recovery.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const policy = "executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: 700 }\n";
afterEach(() => { resetApprovalWindowForTests(); resetLiveSuiteCountForTests(); vi.unstubAllEnvs(); });

test("classification and malformed retry history fail closed", () => {
  expect(failureDisposition({ pass: false, meta: { infra: true, classification: "regression" } })).toBe("behavioral");
  expect(failureDisposition({ pass: false, meta: { infra: true } })).toBe("unknown");
  const rows = [{ event: "infra-retry-reserved", taskId: "T1", ts: "", data: { subject: 3, cause: "infrastructure" } }];
  const emitted: string[] = [];
  expect(reserveInfrastructureRetry(rows, "T1", "new", (event) => emitted.push(event))).toBe(false);
  expect(emitted).toEqual(["infra-retry-denied"]);
});

test("task execution ceiling terminates its sleeping worker, preserves edits, parks once and does not merge", async () => {
  setApprovalWindowForTests(1);
  const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], {
    tasks: { T1: [{ shell: "echo $$ > worker.pid; echo preserved > unfinished.txt; sleep 30 & echo $! > child.pid; wait", result: { ok: true, summary: "late" } }] },
  }, policy);
  const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const started = Date.now();
  try {
    const summary = await runDaemon(repo, { runId: "run-budget-owned", adapters: [fake], driver: new SubprocessDriver() });
    expect(Date.now() - started).toBeLessThan(7000);
    expect(summary.human).toEqual(["T1"]);
    const rows = Journal.open(repo, "run-budget-owned").read();
    expect(rows.filter((e) => e.event === "task-human")).toHaveLength(1);
    expect(rows.find((e) => e.event === "task-human")?.data).toMatchObject({ disposition: "execution-budget-exhausted" });
    expect(rows.filter((e) => e.event === "worker-launch")).toHaveLength(1);
    expect(rows.filter((e) => e.event === "merge")).toHaveLength(0);
    const wt = worktreePath(repo, "tickmarkr/run-budget-owned--T1");
    expect(existsSync(join(wt, "unfinished.txt"))).toBe(true);
    const pid = Number(readFileSync(join(wt, "worker.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    const child = Number(readFileSync(join(wt, "child.pid"), "utf8"));
    expect(() => process.kill(child, 0)).toThrow();
    expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
    const ref = rows.find((e) => e.event === "worktree-preserved")?.data.ref;
    expect(typeof ref).toBe("string");
    expect(await shGitOk(`git show ${ref}:unfinished.txt`, repo)).toContain("preserved");
  } finally { foreign.kill("SIGKILL"); }
}, 10000);

async function seededResume(recordedPolicy: boolean) {
  const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], {
    tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] },
  }, recordedPolicy ? "" : policy);
  const journal = Journal.create(repo, "run-policy-resume");
  journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
    ...(recordedPolicy ? { effectivePolicy: { config: { executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: 700 } } } } : {}) });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  if (recordedPolicy) journal.append("execution-budget-reserved", "T1", { id: "interrupted", limitMs: 700, reservedMs: 700 });
  return { repo, fake, journal };
}

test("resume retains the original exhausted enabled policy when current config disables it", async () => {
  setApprovalWindowForTests(1);
  const { repo, fake, journal } = await seededResume(true);
  const summary = await runDaemon(repo, { runId: journal.runId, resume: true, adapters: [fake], driver: new SubprocessDriver() });
  expect(summary.human).toEqual(["T1"]);
  expect(journal.read().filter((e) => e.event === "worker-launch")).toHaveLength(0);
  expect(journal.read().find((e) => e.event === "task-human")?.data).toMatchObject({ disposition: "execution-budget-exhausted" });
});

test("a legacy run does not acquire current opt-in policy on resume", async () => {
  const { repo, fake, journal } = await seededResume(false);
  const summary = await runDaemon(repo, { runId: journal.runId, resume: true, adapters: [fake], driver: new SubprocessDriver() });
  expect(summary.done).toEqual(["T1"]);
  expect(journal.read().filter((e) => e.event.startsWith("execution-budget-"))).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(tickmarkrDir(repo), "graph.json"), "utf8")).tasks[0].status).toBe("done");
});


test.each([null, [], {}, { config: null }, { config: [] }, { config: { executionPolicy: null } },
  { config: { executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: -1 } } },
].map((snapshot) => [snapshot]))("malformed recorded policy is rejected before dispatch: %j", async (snapshot) => {
  const { repo, fake, journal } = await seededResume(false);
  const path = join(journal.dir, "journal.jsonl");
  const rows = journal.read();
  rows[0].data.effectivePolicy = snapshot;
  writeFileSync(path, rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const before = readFileSync(path, "utf8");
  await expect(runDaemon(repo, { runId: journal.runId, resume: true, adapters: [fake], driver: new SubprocessDriver() })).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("budget interrupts a task's shared-baseline wait without killing the run-owned capture", async () => {
  setApprovalWindowForTests(1);
  const dir = makeTestTempDir("tkr-budget-baseline-");
  const completed = join(dir, "completed");
  const runner = join(dir, "baseline.sh");
  writeFileSync(runner, `sleep 1.4\necho complete > '${completed}'\nexit 0\n`);
  const { repo, fake } = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], {
    tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] },
  }, policy + `gates: { test: "bash ${runner}" }\n`);
  const summary = await runDaemon(repo, { runId: "run-budget-baseline", adapters: [fake], driver: new SubprocessDriver() });
  expect(summary.human).toEqual(["T1"]);
  const rows = Journal.open(repo, "run-budget-baseline").read();
  expect(rows.some((e) => e.event === "baseline-wait" && e.taskId === "T1")).toBe(true);
  const parked = rows.find((e) => e.event === "task-human")!;
  expect(parked.data.disposition).toBe("execution-budget-exhausted");
  expect(existsSync(completed)).toBe(true);
  expect(Date.parse(parked.ts)).toBeLessThan(statSync(completed).mtimeMs);
  const captured = JSON.parse(readFileSync(join(Journal.open(repo, "run-budget-baseline").dir, "baseline.json"), "utf8"));
  expect(captured.commands.test.exitCode).toBe(0);
  expect(rows.some((e) => e.event === "merge")).toBe(false);
}, 5000);

test("external-suite admission waiting consumes task budget and launches no verifier", async () => {
  setApprovalWindowForTests(1);
  const { repo, fake, journal } = await seededResume(false);
  const runnerDir = makeTestTempDir("tkr-budget-admission-");
  const marker = join(runnerDir, "verifier-ran");
  const rows = journal.read();
  rows[0].data.effectivePolicy = { config: { executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: 700 } } };
  writeFileSync(join(runnerDir, "package.json"), JSON.stringify({ scripts: { test: "node test.cjs" } }));
  writeFileSync(join(runnerDir, "test.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`);
  const command = `cd ${runnerDir} && npm run -s test`;
  rows[0].data.commands = { test: command };
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), policy + `gates: { test: "${command}" }\n`);
  vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
  writeFileSync(join(journal.dir, "journal.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: { test: { exitCode: 0, fingerprints: [] } } }));
  setLiveSuiteCountForTests(async () => 1);
  const started = Date.now();
  const summary = await runDaemon(repo, { runId: journal.runId, resume: true, adapters: [fake], driver: new SubprocessDriver() });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(summary.human).toEqual(["T1"]);
  expect(journal.read().some((e) => e.event === "suite-wait" && e.taskId === "T1")).toBe(true);
  expect(journal.read().find((e) => e.event === "task-human")?.data.disposition).toBe("execution-budget-exhausted");
  expect(existsSync(marker)).toBe(false);
}, 7000);

test("an exhausted task cannot close a concurrently executing sibling's owned worker", async () => {
  setApprovalWindowForTests(1);
  const gates = ["build", "test", "lint", "evidence", "scope"];
  const { repo, fake } = setupRepo([T("T1", { gates, files: ["first.txt"] }), T("T2", { gates, files: ["second.txt"] })], {
    tasks: {
      T1: [{ shell: "echo waiting > first.txt; sleep 30", result: { ok: true, summary: "late" } }],
      T2: [{ shell: `sleep 1.1; echo survived > second.txt && ${COMMIT} second`, result: { ok: true, summary: "second done" } }],
    },
  });
  const journal = Journal.create(repo, "run-budget-sibling");
  journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
    effectivePolicy: { config: { executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: 2500 } } } });
  journal.append("execution-budget-reserved", "T1", { id: "prior", limitMs: 2500, reservedMs: 1700 });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const summary = await runDaemon(repo, { runId: journal.runId, resume: true, concurrency: 2, adapters: [fake], driver: new SubprocessDriver() });
  expect(summary.human).toEqual(["T1"]);
  expect(summary.done).toEqual(["T2"]);
  const rows = journal.read();
  const firstPark = rows.findIndex((e) => e.event === "task-human" && e.taskId === "T1");
  const secondLaunch = rows.findIndex((e) => e.event === "worker-launch" && e.taskId === "T2");
  const secondDone = rows.findIndex((e) => e.event === "task-done" && e.taskId === "T2");
  expect(secondLaunch).toBeLessThan(firstPark);
  expect(secondDone).toBeGreaterThan(firstPark);
  expect(await shGitOk(`git show ${summary.branch}:second.txt`, repo)).toContain("survived");
}, 7000);


test("human-released recheck runs full tests even when opted-in repair history permits selection", async () => {
  const runId = "run-recheck-repair-selection";
  const dir = makeTestTempDir("tkr-recheck-selection-");
  const log = join(dir, "argv.log");
  const runner = join(dir, "tests.sh");
  writeFileSync(runner, `printf '%s\\n' "$#" >> ${shq(log)}\nexit 0\n`);
  const command = `bash ${shq(runner)}`;
  const enabled = { boundedInfrastructure: true, repairSelection: true, taskExecutionLimitMs: 5000 };
  const { repo, fake } = setupRepo([T("T1", { files: ["**"], gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: {} },
    `executionPolicy: ${JSON.stringify(enabled)}\ngates: { test: ${JSON.stringify(command)} }\n`);
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "src/a.ts"), "export const value = 0;\n");
  writeFileSync(join(repo, "tests/a.test.ts"), 'import { value } from "../src/a.js";\n');
  await shGitOk("git add -A && git commit --no-gpg-sign -m fixture", repo);
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const driver = new SubprocessDriver();
  const wt = await driver.worktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "src/a.ts"), "export const value = 1;\n");
  await shGitOk("git add -A && git commit --no-gpg-sign -m repaired", wt);
  const commit = await gitHead(wt);
  const commands = { test: command };
  const baseline = await captureBaseline(repo, commands);
  writeFileSync(log, "");
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)), effectivePolicy: { config: { executionPolicy: enabled } } });
  journal.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
  journal.append("worker-result", "T1", { ok: true, summary: "repair ready", deviations: [] });
  journal.phaseStart("T1", "gates");
  journal.append("gate-result", "T1", { gate: "test", pass: false, details: "known selected regression", disposition: "behavioral", classification: "regression",
    commit, selectedTests: ["tests/a.test.ts"], failingFiles: ["tests/a.test.ts"] });
  journal.append("task-human", "T1", { reason: "test failed", kind: "gate-fail" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  await approve([runId, "T1", "--recheck", "--by", "test"], repo);
  expect(repairSelectionDecision(journal.read(), "T1", true)).toMatchObject({ selectTests: true, reason: "known-failing-files" });
  const summary = await runDaemon(repo, { runId, resume: true, adapters: [fake], driver });
  expect(summary.done).toEqual(["T1"]);
  const rows = journal.read();
  const post = rows.slice(rows.findLastIndex((e) => e.event === "run-resume") + 1);
  const testIndex = post.findIndex((e) => e.event === "gate-result" && e.data.gate === "test");
  const mergeIndex = post.findIndex((e) => e.event === "merge");
  expect(testIndex).toBeGreaterThanOrEqual(0);
  expect(mergeIndex).toBeGreaterThan(testIndex);
  expect(post[testIndex].data.selectedTests).toBeUndefined();
  expect(post.filter((e) => e.event === "worker-launch")).toHaveLength(0);
  // Recheck plus integration tip, with no diagnostic subset execution preceding either.
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["0", "0"]);
}, 7000);
