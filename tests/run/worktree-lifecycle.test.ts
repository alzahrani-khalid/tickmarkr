import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { HostDegradedError } from "../../src/run/host-health.js";
import { createWorktree, worktreePath } from "../../src/run/git.js";
import { captureOwedCheck, foldOwedChecks, GATE_SATISFIED_RELEASE, Journal, owedSubject, type JournalEvent } from "../../src/run/journal.js";
import { wallBudget } from "../../src/run/wall-budget.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
const branchOf = (id: string) => `tickmarkr/${id}`;
const taskDir = (repo: string, id: string, task = "T1") => worktreePath(repo, `${branchOf(id)}--${task}`);
const removalRows = (rows: JournalEvent[]) => rows.filter((e) => e.event === "worktree-removed");
const script = (file: string, ok = true) => [{ shell: `echo ${file} > ${file}.txt && ${COMMIT} ${file}`, result: { ok, summary: file } }];
const deadPid = 2_000_000_000;
const parkConfig = 'gates: { lint: "test ! -f parked.txt" }\n';

afterEach(() => vi.restoreAllMocks());

async function leftover(repo: string, id: string, terminal?: string, pid: number | undefined = deadPid) {
  const branch = branchOf(id);
  const baseRef = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", branch, baseRef);
  const journal = Journal.create(repo, id);
  journal.append("run-start", undefined, { branch, baseRef, ...(pid === undefined ? {} : { pid }) });
  journal.append("task-dispatch", "T1", { base: baseRef, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  const dir = await createWorktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(dir, "saved.txt"), id);
  git(dir, "add", "saved.txt");
  git(dir, "commit", "--no-gpg-sign", "-m", "saved");
  writeFileSync(join(dir, "uncommitted.txt"), "uncommitted bytes\n");
  journal.append("phase-start", "T1", { phase: "gate:test" });
  const head = git(dir, "rev-parse", "HEAD");
  journal.append("gate-result", "T1", { gate: "test", pass: false, commit: owedSubject(repo, baseRef, head) });
  journal.append("task-human", "T1", { kind: "gate-fail" });
  const prior = journal.read();
  const park = { line: prior.length, ts: prior.at(-1)!.ts };
  const obligation = captureOwedCheck({
    cwd: repo, runId: id, taskId: "T1", gate: "test", cause: "fixture waiver", acceptance: ["done"],
    files: [], declared: [{ key: "fake:fake-1", vendor: "fake-a" }], taskRef: `${branch}--T1`, integrationRef: branch, events: prior,
  });
  journal.append("task-approved", "T1", { release: GATE_SATISFIED_RELEASE, gate: "test", park, obligation });
  if (terminal === "stop") journal.append("exit-cause", undefined, { cause: "SIGTERM" });
  if (terminal === "crash") journal.append("run-end", undefined, { fatal: true, error: "crashed" });
  if (terminal === "partial") journal.append("run-end", undefined, { done: [], human: ["T1"] });
  return { journal, dir, before: journal.read() };
}

test("test: a run ending with a parked task, a failed task and a merged done task leaves none of their checkouts, journals after its run end one removal row each for the parked and failed checkouts naming the checkout, its head and a recovery ref that still resolves once their task branches are deleted, beside a preserved row naming the same ref, keeps every task branch, and journals no row for the clean merged checkout, so a run end that removes only done checkouts or removes without a recovery ref fails", async () => {
  const id = "run-lifecycle-end";
  const { repo, fake } = setupRepo([T("P"), T("F"), T("D")], {
    tasks: { P: script("parked", false), D: script("done") }, consult: { action: "human", notes: "park" },
  }, "concurrency: 1\n" + parkConfig);
  const driver = new SubprocessDriver();
  const create = driver.worktree.bind(driver);
  driver.worktree = async (repoRoot, branch, base) => {
    const dir = await create(repoRoot, branch, base);
    if (branch.endsWith("--F")) {
      writeFileSync(join(dir, "failed.txt"), "failed work\n");
      git(dir, "add", "failed.txt");
      git(dir, "commit", "--no-gpg-sign", "-m", "failed work");
      throw new Error("fixture checkout failure");
    }
    return dir;
  };
  const result = await runDaemon(repo, { runId: id, adapters: [fake], driver });
  expect(result.human).toEqual(["P"]);
  expect(result.failed).toEqual(["F"]);
  expect(result.done).toEqual(["D"]);
  const events = Journal.open(repo, id).read();
  const removed = removalRows(events);
  expect(removed.map((e) => e.data.task).sort()).toEqual(["F", "P"]);
  for (const task of ["P", "F", "D"]) {
    expect(existsSync(taskDir(repo, id, task))).toBe(false);
    expect(git(repo, "rev-parse", `refs/heads/${branchOf(id)}--${task}`)).toMatch(/^[a-f0-9]{40}$/);
  }
  for (const row of removed) {
    expect(row.taskId).toBeUndefined();
    expect(events.indexOf(row)).toBeGreaterThan(events.findIndex((e) => e.event === "run-end"));
    expect(row.data).toMatchObject({ dir: taskDir(repo, id, String(row.data.task)), by: id });
    expect(events).toContainEqual(expect.objectContaining({ event: "worktree-preserved", taskId: row.data.task, data: expect.objectContaining({ ref: row.data.ref, by: id, producer: expect.any(String) }) }));
    if (row.data.task === "P") {
      const parked = events.find((e) => e.event === "task-human" && e.taskId === "P")!;
      expect(events.find((e) => e.event === "worktree-preserved" && e.taskId === "P")?.data.reason).toBe(parked.data.reason);
      expect(events.filter((e) => e.event === "task-human" && e.taskId === "P")).toHaveLength(1);
    }
    git(repo, "branch", "-D", `${branchOf(id)}--${row.data.task}`);
    expect(git(repo, "rev-parse", String(row.data.ref))).toBe(row.data.head);
  }
});

test("test: a parked task whose checkout its run end removed is released by the operator and resumed, and its committed work reaches the new attempt's tree and merges, the resumed run's measured interruption starting at its run end rather than at the removal rows, while a run under the keep-everything visibility setting removes and journals nothing, so a removal the resume cannot rebuild from fails", async () => {
  const id = "run-lifecycle-resume";
  const { repo, fake, scriptPath } = setupRepo([T("T1")], { tasks: { T1: script("parked") } });
  const driver = new SubprocessDriver();
  const create = driver.worktree.bind(driver);
  driver.worktree = async (repoRoot, branch, base) => {
    const dir = await create(repoRoot, branch, base);
    writeFileSync(join(dir, "parked.txt"), "parked\n");
    git(dir, "add", "parked.txt");
    git(dir, "commit", "--no-gpg-sign", "-m", "parked work");
    throw new HostDegradedError("fixture host unavailable after committed work");
  };
  const first = await runDaemon(repo, { runId: id, adapters: [fake], driver });
  expect(first.human).toEqual(["T1"]);
  expect(existsSync(taskDir(repo, id))).toBe(false);
  await approve([id, "T1", "--by", "operator", "--reason", "continue"], repo);
  const body = JSON.parse(readFileSync(scriptPath, "utf8"));
  body.tasks.T1 = [{ shell: `test -f parked.txt && echo resumed > resumed.txt && ${COMMIT} resumed`, result: { ok: true, summary: "resumed" } }];
  writeFileSync(scriptPath, JSON.stringify(body));
  const resumed = await runDaemon(repo, { runId: id, resume: true, adapters: [new FakeAdapter(scriptPath)] });
  expect(resumed.done).toEqual(["T1"]);
  expect(git(repo, "show", `${resumed.branch}:parked.txt`)).toBe("parked");
  expect(git(repo, "show", `${resumed.branch}:resumed.txt`)).toBe("resumed");
  const rows = Journal.open(repo, id).read();
  expect(rows.find((e) => e.event === "worktree-recreation" && e.data.rebuiltFrom === "removal")?.data.rebuiltFrom).toBe("removal");
  const end = rows.find((e) => e.event === "run-end")!;
  const restart = rows.find((e) => e.event === "run-resume")!;
  expect(wallBudget(rows)?.exposedMs.interruption).toBe(Date.parse(restart.ts) - Date.parse(end.ts));
  const kept = setupRepo([T("T1")], { tasks: { T1: script("kept", false) }, consult: { action: "human", notes: "park" } }, "visibility:\n  keepPanes: forever\n" + parkConfig);
  await runDaemon(kept.repo, { runId: id, adapters: [kept.fake] });
  expect(existsSync(taskDir(kept.repo, id))).toBe(true);
  expect(Journal.open(kept.repo, id).read().filter((e) => ["worktree-removed", "worktree-preserved", "worktree-removal-failed"].includes(e.event))).toEqual([]);
});

test.each([false, true])("plain approve after a gate-command dirt refusal resumes committed work without carrying the refused snapshot (keep forever: %s)", async (keepForever) => {
  const id = "run-lifecycle-approve-dirt";
  const visibility = keepForever ? "visibility: { keepPanes: forever }\n" : "";
  const litterCommand = "test -f resumed.txt || echo refused > litter.txt";
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { files: ["committed.txt", "resumed.txt"], gates: ["build", "test", "lint", "evidence", "scope"] })],
    { tasks: { T1: script("committed") } },
    visibility + `gates: { test: '${litterCommand}' }\n`,
  );
  expect((await runDaemon(repo, { runId: id, adapters: [fake] })).human).toEqual(["T1"]);
  const before = Journal.open(repo, id).read();
  const refusal = before.find((e) => e.event === "gate-result" && e.data.dirtyWorktree === true)!;
  expect(refusal.data).toMatchObject({ infra: true, culprit: litterCommand, dirtyPaths: ["litter.txt"] });
  expect(before.find((e) => e.event === "task-human")?.data.kind).toBe("infra");
  expect(existsSync(taskDir(repo, id))).toBe(keepForever);
  const recoveryRef = String(keepForever ? refusal.data.preservedRef : removalRows(before)[0]!.data.ref);
  expect(git(repo, "show", `${recoveryRef}:litter.txt`)).toBe("refused");

  const body = JSON.parse(readFileSync(scriptPath, "utf8"));
  body.tasks.T1 = [{
    shell: `test ! -f litter.txt && test -f committed.txt && echo resumed > resumed.txt && ${COMMIT} resumed`,
    result: { ok: true, summary: "resumed" },
  }];
  writeFileSync(scriptPath, JSON.stringify(body));
  await approve([id, "T1", "--by", "operator", "--reason", "retry committed work"], repo);
  const resumed = await runDaemon(repo, { runId: id, resume: true, adapters: [new FakeAdapter(scriptPath)] });
  const after = Journal.open(repo, id).read().slice(before.length);
  expect(after.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  const recreation = after.find((e) => e.event === "worktree-recreation")!;
  expect(recreation.data.attempted).toHaveLength(1);
  expect(recreation.data.carried).toHaveLength(1);
  expect(resumed.done).toEqual(["T1"]);
  const base = String(before.find((e) => e.event === "run-start")!.data.baseRef);
  expect(git(repo, "diff", "--name-only", `${base}..${resumed.branch}`)).toBe("committed.txt\nresumed.txt");
  expect(git(repo, "show", `${recoveryRef}:litter.txt`)).toBe("refused");
});

test("test: a run start removes the leftover task checkouts of each other run in the same state directory whose recorded daemon is dead and whose engagement ended by a deliberate stop, a crash record, an older engine's partial run end or no terminal row, journaling each removal into that run's own journal, preserving a leftover's uncommitted bytes into its recovery ref, and leaving that run's outstanding checks and measured wall window unchanged, so a start that keeps a stopped run's checkouts or writes the rows into its own journal fails", async () => {
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: script("new") } });
  const old = [];
  for (const terminal of ["stop", "crash", "partial", "open"]) old.push(await leftover(repo, `run-old-${terminal}`, terminal));
  const result = await runDaemon(repo, { runId: "run-sweeper", adapters: [fake] });
  expect(result.done).toEqual(["T1"]);
  for (const { journal, dir, before } of old) {
    expect(existsSync(dir)).toBe(false);
    const after = journal.read();
    const row = removalRows(after)[0]!;
    expect(row.data).toMatchObject({ dir, by: result.runId, task: "T1" });
    expect(git(repo, "show", `${row.data.ref}:uncommitted.txt`)).toBe("uncommitted bytes");
    expect(wallBudget(after)).toEqual(wallBudget(before));
    expect(foldOwedChecks(before, repo).outstanding).toHaveLength(1);
    expect(foldOwedChecks(after, repo)).toEqual(foldOwedChecks(before, repo));
  }
  expect(removalRows(Journal.open(repo, result.runId).read())).toEqual([]);
});

test("test: the start sweep leaves the resumed run's own checkouts, another run whose recorded daemon is alive or unrecorded, a directory named like a task its run never dispatched, a detached hand-made checkout, a verification checkout and a sibling linked checkout's state untouched, and a refused start or the keep-everything setting sweeps nothing, so a sweep by directory listing or by ended-run membership alone fails", async () => {
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: script("parked") }, consult: { action: "human", notes: "park" } }, "visibility:\n  keepPanes: forever\n" + parkConfig);
  const id = "run-own";
  await runDaemon(repo, { runId: id, adapters: [fake] });
  const own = taskDir(repo, id);
  expect(Journal.open(repo, id).read().some((e) => e.event === "task-dispatch")).toBe(true);
  const alive = await leftover(repo, "run-alive", "partial", process.pid);
  const unknown = await leftover(repo, "run-unrecorded", "partial");
  unknown.journal.append("run-resume", undefined, {});
  unknown.before = unknown.journal.read();
  const dead = await leftover(repo, "run-dead", "stop");
  const undispatched = await createWorktree(repo, `${branchOf(dead.journal.runId)}--T2`, "HEAD");
  const detached = worktreePath(repo, "detached-hand-made");
  const verify = worktreePath(repo, "tip-verify-hand-made");
  git(repo, "worktree", "add", "--detach", detached, "HEAD");
  git(repo, "worktree", "add", "--detach", verify, "HEAD");
  const sibling = join(makeTestTempDir("sibling-"), "checkout");
  git(repo, "worktree", "add", "--detach", sibling, "HEAD");
  const siblingOld = await leftover(sibling, "run-sibling", "stop");
  const untouched = [own, alive.dir, unknown.dir, undispatched, detached, verify, siblingOld.dir];
  const all = [...untouched, dead.dir];
  const bytes = all.map((dir) => readFileSync(join(dir, ".git"), "utf8"));
  await runDaemon(repo, { runId: id, resume: true, adapters: [fake] });
  for (const dir of all) expect(existsSync(dir)).toBe(true);
  expect(dead.journal.read()).toEqual(dead.before);
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n");
  await expect(runDaemon(repo, { runId: "run-refused", adapters: [] })).rejects.toThrow();
  for (const dir of all) expect(existsSync(dir)).toBe(true);
  expect(dead.journal.read()).toEqual(dead.before);
  let ownAtEnd: string | undefined;
  await runDaemon(repo, { runId: id, resume: true, adapters: [fake], narrate: (e) => {
    if (e.event === "run-end") ownAtEnd = readFileSync(join(own, ".git"), "utf8");
  } });
  expect(ownAtEnd).toBe(bytes[all.indexOf(own)]);
  expect(existsSync(dead.dir)).toBe(false);
  for (const dir of untouched.filter((dir) => dir !== own)) expect(readFileSync(join(dir, ".git"), "utf8")).toBe(bytes[all.indexOf(dir)]);
  expect(alive.journal.read()).toEqual(alive.before);
  expect(unknown.journal.read()).toEqual(unknown.before);
  expect(siblingOld.journal.read()).toEqual(siblingOld.before);
});

test("test: a removal whose checkout holds staged bytes its preservation missed, staged then reverted in the working file, or whose preservation or deletion fails keeps the checkout and journals a removal failure, and at a run end the run still returns its own outcome with exactly one run end row and no crash record, while at a run start the run proceeds to its tasks, so a cleanup failure that crashes or reopens a closed run fails", async () => {
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: script("new") } });
  const old = [];
  for (const mode of ["staged", "reverted", "preserve", "delete"]) {
    const item = await leftover(repo, `run-fail-${mode}`, "stop");
    if (mode === "staged" || mode === "reverted") {
      writeFileSync(join(item.dir, "saved.txt"), "staged bytes\n");
      git(item.dir, "add", "saved.txt");
      writeFileSync(join(item.dir, "saved.txt"), mode === "reverted" ? item.journal.runId : "different working bytes\n");
    } else if (mode === "delete") git(repo, "worktree", "lock", item.dir);
    else git(item.dir, "init", "-q", "embedded");
    old.push(item);
  }
  const result = await runDaemon(repo, { runId: "run-failure-sweep", adapters: [fake] });
  expect(result.done).toEqual(["T1"]);
  for (const item of old) expect(existsSync(item.dir)).toBe(true);
  const failures = Journal.open(repo, result.runId).read().filter((e) => e.event === "worktree-removal-failed");
  expect(failures.map((e) => e.data.run).sort()).toEqual(old.map((e) => e.journal.runId).sort());
  expect(failures.every((e) => e.taskId === undefined && typeof e.data.error === "string")).toBe(true);
  const held = setupRepo([T("T1")], { tasks: { T1: script("parked", false) }, consult: { action: "human", notes: "park" } }, parkConfig);
  const id = "run-failure-end";
  const outcome = await runDaemon(held.repo, { runId: id, adapters: [held.fake], narrate: (e) => {
    if (e.event === "run-end") git(held.repo, "worktree", "lock", taskDir(held.repo, id));
  } });
  expect(outcome.human).toEqual(["T1"]);
  expect(existsSync(taskDir(held.repo, id))).toBe(true);
  const rows = Journal.open(held.repo, id).read();
  expect(rows.filter((e) => e.event === "run-end")).toHaveLength(1);
  expect(rows.some((e) => e.event === "run-end" && e.data.fatal)).toBe(false);
  expect(rows.some((e) => e.event === "exit-cause" && e.data.cause === "unclean")).toBe(false);
  expect(rows.filter((e) => e.event === "worktree-removal-failed")).toHaveLength(1);
});
