// Queue row 412 (D-2187 add.67): stray quarantine, the branch safety ref and preserve's registered-worktree check.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, unlinkSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { createWorktree, preserveWorktree, shGit, worktreePath } from "../../src/run/git.js";
import { resetAttemptHardTimeoutMsForTests, runDaemon, setAttemptHardTimeoutMsForTests } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { executionSignal, withExecutionBudget } from "../../src/run/execution-budget.js";
import { GitProbeUnknownError, ownSafetyRefs, quarantineAndRetry, withBranchSafety, WorktreePathExistsError } from "../../src/run/worktree-quarantine.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

afterEach(() => { vi.unstubAllEnvs(); });

const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
/**
 * A PATH git stand-in for in-process git calls: the first `failAdds` worktree adds fail with git's sibling admin read
 * error, and `lockAfterAdd` (a path) is created once a later add succeeds. `fail` fails matching calls (only once
 * `whenExists` exists, when named); `sleepAdd` holds every add that long (ms) inside the shim process itself.
 */
const gitShim = (opts: { failAdds?: number; adminEvidence?: string; lockAfterAdd?: string; sleepAdd?: number; fail?: { match: string; from?: number; times?: number; stderr?: string; whenExists?: string; after?: boolean };
  pause?: { match: string; ms: number; after?: boolean; marker?: string } }): (() => number) => {
  const dir = makeTestTempDir("stray-git-");
  const count = join(dir, "adds");
  writeFileSync(join(dir, "git"), `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const at = args.indexOf("worktree");
const add = at >= 0 && args[at + 1] === "add";
const opts = ${JSON.stringify(opts)};
let n = 0;
if (add) { n = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0; fs.writeFileSync(${JSON.stringify(count)}, String(++n)); }
const failed = ${JSON.stringify(join(dir, "failed"))};
if (add && opts.sleepAdd) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.sleepAdd);
const paused = opts.pause && args.join(" ").includes(opts.pause.match);
if (paused && !opts.pause.after) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.pause.ms);
if (opts.fail && args.join(" ").includes(opts.fail.match) && (!opts.fail.whenExists || fs.existsSync(opts.fail.whenExists))) {
  const f = fs.existsSync(failed) ? Number(fs.readFileSync(failed, "utf8")) : 0;
  fs.writeFileSync(failed, String(f + 1));
  const from = (opts.fail.from || 1) - 1;
  if (f >= from && (opts.fail.times === undefined || f < from + opts.fail.times)) { if (opts.fail.after) spawnSync(${JSON.stringify(realGit)}, args, { stdio: "ignore" }); process.stderr.write((opts.fail.stderr || "fatal: injected probe failure") + "\\n"); process.exit(128); }
}
if (add && n <= (opts.failAdds || 0)) { process.stderr.write(opts.adminEvidence + "\\n"); process.exit(128); }
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: ["inherit", "pipe", "pipe"] });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (add && r.status === 0 && opts.lockAfterAdd) fs.writeFileSync(opts.lockAfterAdd, "");
if (paused && opts.pause.after && r.status === 0) {
  if (opts.pause.marker) fs.writeFileSync(opts.pause.marker, "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.pause.ms);
}
process.exit(r.status === null ? 128 : r.status);
`);
  chmodSync(join(dir, "git"), 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  return () => existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
};

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const done = [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }];
const stray = (dir: string): void => {
  mkdirSync(join(dir, "graft", ".cache"), { recursive: true });
  writeFileSync(join(dir, "graft", ".cache", "stats.json"), "{}\n");
};
/** A stray whose `.git` names a pruned worktree: its own git probes exit 128, the repository's listing does not hold it. */
const prunedStray = (repo: string, dir: string): void => {
  git(repo, "worktree", "add", "-q", "-b", `pruned-${basename(dir)}`, dir);
  execFileSync("rm", ["-rf", join(repo, ".git", "worktrees", basename(dir))]);
};
const quarantined = (dir: string): string[] => readdirSync(dirname(dir)).filter((name) => name.startsWith(`${basename(dir)}.quarantine-`));
const safetyRefs = (repo: string): string => git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tickmarkr/safety");
/** A task branch that already exists one commit past base, as a repair dispatch finds it. */
const priorBranch = (repo: string, branch: string): string => {
  git(repo, "branch", branch, "HEAD");
  const side = join(dirname(repo), `${branch.replace(/\W+/g, "-")}-side`);
  git(repo, "worktree", "add", side, branch);
  writeFileSync(join(side, "prior.txt"), `${branch}\n`);
  git(side, "add", "prior.txt");
  git(side, "commit", "--no-gpg-sign", "-m", "prior");
  const head = git(side, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", "--force", side);
  return head;
};

test("a stray non git directory at the worktree path is moved aside with a quarantine row and the one retried dispatch runs", async () => {
  const id = "run-stray";
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: done } });
  const dir = worktreePath(repo, `tickmarkr/${id}--T1`);
  stray(dir);
  const driver = new SubprocessDriver();
  const create = driver.worktree.bind(driver);
  let adds = 0;
  driver.worktree = (r, b, base) => { adds++; return create(r, b, base); };
  const result = await runDaemon(repo, { runId: id, adapters: [fake], driver });
  expect(result.done).toEqual(["T1"]);
  expect(adds).toBe(2);
  const rows = Journal.open(repo, id).read().filter((e) => e.event === "worktree-quarantine");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.data).toMatchObject({ path: dir, entries: ["graft/.cache/stats.json"] });
  const movedTo = String(rows[0]!.data.movedTo);
  expect(movedTo.startsWith(`${dir}.quarantine-`)).toBe(true);
  expect(readFileSync(join(movedTo, "graft", ".cache", "stats.json"), "utf8")).toBe("{}\n");
  // control: the task branch did not exist (the verify exits non-zero, the absent-ref transaction exits 0): no safety ref stays
  expect(safetyRefs(repo)).toBe("");

  // control: a confirmed stray whose `.git` names a pruned worktree is asked of the repository, which does not list it
  const idp = "run-stray-pruned";
  const pruned = setupRepo([T("T1")], { tasks: { T1: done } });
  const dirp = worktreePath(pruned.repo, `tickmarkr/${idp}--T1`);
  prunedStray(pruned.repo, dirp);
  const resultp = await runDaemon(pruned.repo, { runId: idp, adapters: [pruned.fake] });
  expect(resultp.done).toEqual(["T1"]);
  const rowsp = Journal.open(pruned.repo, idp).read().filter((e) => e.event === "worktree-quarantine");
  expect(rowsp).toHaveLength(1);
  expect(rowsp[0]!.data.path).toBe(dirp);

  // control: a registered worktree at the path is removed and recreated as at the base, with no quarantine
  const branch = "tickmarkr/control--T1";
  const first = await createWorktree(repo, branch, "HEAD");
  writeFileSync(join(first, "scratch.txt"), "x\n");
  expect(await createWorktree(repo, branch, "HEAD")).toBe(first);
  expect(existsSync(join(first, "scratch.txt"))).toBe(false);
  expect(quarantined(first)).toEqual([]);
}, 60_000);

test("a stray that cannot be moved or whose single retry fails parks the task as infra naming the path and writes no task failed row", async () => {
  // the single retry fails: the stray is back at the path when the retried add runs
  const id = "run-stray-retry";
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: done } });
  const branch = `tickmarkr/${id}--T1`;
  const dir = worktreePath(repo, branch);
  stray(dir);
  const driver = new SubprocessDriver();
  const create = driver.worktree.bind(driver);
  let adds = 0;
  driver.worktree = (r, b, base) => { if (++adds === 2) stray(dir); return create(r, b, base); };
  const result = await runDaemon(repo, { runId: id, adapters: [fake], driver });
  expect(result.human).toEqual(["T1"]);
  expect(adds).toBe(2);
  const rows = Journal.open(repo, id).read();
  expect(rows.filter((e) => e.event === "worktree-quarantine")).toHaveLength(1);
  expect(rows.filter((e) => e.event === "task-failed")).toEqual([]);
  const park = rows.find((e) => e.event === "task-human" && e.taskId === "T1")!;
  expect(park.data).toMatchObject({ kind: "infra", disposition: "worktree-stray", path: dir });
  expect(String(park.data.reason)).toContain(dir);
  expect(String(park.data.reason)).toContain(String(park.data.recovery));
  expect(String(park.data.recovery)).toContain(`mv -- '${dir}'`);

  // the move fails: the worktrees folder is not writable
  const id2 = "run-stray-stuck";
  const stuck = setupRepo([T("T1")], { tasks: { T1: done } });
  const dir2 = worktreePath(stuck.repo, `tickmarkr/${id2}--T1`);
  stray(dir2);
  chmodSync(dirname(dir2), 0o555);
  try {
    const parked = await runDaemon(stuck.repo, { runId: id2, adapters: [stuck.fake] });
    expect(parked.human).toEqual(["T1"]);
  } finally { chmodSync(dirname(dir2), 0o755); }
  const rows2 = Journal.open(stuck.repo, id2).read();
  expect(rows2.filter((e) => e.event === "task-failed")).toEqual([]);
  expect(rows2.filter((e) => e.event === "worktree-quarantine")).toEqual([]);
  const park2 = rows2.find((e) => e.event === "task-human" && e.taskId === "T1")!;
  expect(park2.data).toMatchObject({ kind: "infra", disposition: "worktree-stray", path: dir2 });
  expect(existsSync(join(dir2, "graft", ".cache", "stats.json"))).toBe(true);

  // the retried add succeeds but the dispatch's safety ref cannot be removed: still an infra park naming the path,
  // the quarantine destination and the ref's own cleanup command, never a failed task
  const id3 = "run-stray-cleanup";
  const held = setupRepo([T("T1")], { tasks: { T1: done } });
  const branch3 = `tickmarkr/${id3}--T1`;
  const prior3 = priorBranch(held.repo, branch3);
  const dir3 = worktreePath(held.repo, branch3);
  stray(dir3);
  const ref3 = `refs/tickmarkr/safety/${branch3}/${prior3}`;
  const adds3 = gitShim({ lockAfterAdd: join(held.repo, ".git", ref3 + ".lock") });
  const parked3 = await runDaemon(held.repo, { runId: id3, adapters: [held.fake] });
  vi.unstubAllEnvs();
  expect(parked3.human).toEqual(["T1"]);
  expect(adds3()).toBe(2);
  const rows3 = Journal.open(held.repo, id3).read();
  expect(rows3.filter((e) => e.event === "task-failed")).toEqual([]);
  const moved3 = rows3.filter((e) => e.event === "worktree-quarantine");
  expect(moved3).toHaveLength(1);
  const park3 = rows3.find((e) => e.event === "task-human" && e.taskId === "T1")!;
  expect(park3.data).toMatchObject({ kind: "infra", disposition: "worktree-stray", path: dir3, movedTo: moved3[0]!.data.movedTo,
    recovery: `cd -- '${held.repo}' && if git show-ref --verify --quiet '${ref3}'; then git update-ref -d '${ref3}' '${prior3}'; fi` });
  expect(String(park3.data.reason)).toContain(String(park3.data.recovery));
  unlinkSync(join(held.repo, ".git", ref3 + ".lock"));

  // the same removal failure after a PLAIN add (no stray): an infra park naming the ref, never a failed task
  const id4 = "run-plain-cleanup";
  const plain = setupRepo([T("T1")], { tasks: { T1: done } });
  const branch4 = `tickmarkr/${id4}--T1`;
  const prior4 = priorBranch(plain.repo, branch4);
  const ref4 = `refs/tickmarkr/safety/${branch4}/${prior4}`;
  gitShim({ lockAfterAdd: join(plain.repo, ".git", ref4 + ".lock") });
  const parked4 = await runDaemon(plain.repo, { runId: id4, adapters: [plain.fake] });
  vi.unstubAllEnvs();
  expect(parked4.human).toEqual(["T1"]);
  const rows4 = Journal.open(plain.repo, id4).read();
  expect(rows4.filter((e) => e.event === "task-failed")).toEqual([]);
  expect(rows4.find((e) => e.event === "task-human" && e.taskId === "T1")!.data)
    .toMatchObject({ kind: "infra", disposition: "safety-ref", path: ref4, recovery: `cd -- '${plain.repo}' && if git show-ref --verify --quiet '${ref4}'; then git update-ref -d '${ref4}' '${prior4}'; fi` });
  unlinkSync(join(plain.repo, ".git", ref4 + ".lock"));

  // a DIRTY registered worktree at the path whose registration probe fails once, then one whose probe keeps failing:
  // UNKNOWN is never "not registered" — nothing preserved-skipped, deleted, recreated or quarantined; an infra park
  // the probe fails once at each asking in turn: the task-work reader, preserve, the recreation's removal check
  for (const [from, times] of [[1, 1], [2, 1], [3, 1], [1, undefined]] as const) {
    const id5 = `run-probe-${from}-${times ?? "persistent"}`;
    const reg = setupRepo([T("T1")], { tasks: { T1: done } });
    const wt = await createWorktree(reg.repo, `tickmarkr/${id5}--T1`, "HEAD");
    writeFileSync(join(wt, "uncommitted.txt"), "irreplaceable\n");
    gitShim({ fail: { match: "worktree list --porcelain -z", from, times } });
    const parked5 = await runDaemon(reg.repo, { runId: id5, adapters: [reg.fake] });
    vi.unstubAllEnvs();
    expect(parked5.human).toEqual(["T1"]);
    const rows5 = Journal.open(reg.repo, id5).read();
    expect(rows5.filter((e) => e.event === "task-failed" || e.event === "worktree-quarantine")).toEqual([]);
    expect(rows5.find((e) => e.event === "task-human" && e.taskId === "T1")!.data)
      .toMatchObject({ kind: "infra", disposition: "git-probe-unknown", path: wt, probe: "git worktree list --porcelain -z", exit: 128 });
    // never recreated; the uncommitted file is in place, or (the base's run-end cleanup, row 240) in a preserved ref
    expect(rows5.filter((e) => e.event === "worktree-recreation")).toEqual([]);
    const preserved = rows5.filter((e) => e.event === "worktree-preserved").map((e) => String(e.data.ref));
    expect(existsSync(join(wt, "uncommitted.txt")) ? readFileSync(join(wt, "uncommitted.txt"), "utf8")
      : `${git(reg.repo, "show", `${preserved.at(-1)}:uncommitted.txt`)}\n`).toBe("irreplaceable\n");
    expect(quarantined(wt)).toEqual([]);
    // the probe that keeps failing also stops the run-end removal: the registered checkout stays where it was
    if (times === undefined) expect(git(reg.repo, "worktree", "list", "--porcelain")).toContain(`worktree ${realpathSync(wt)}`);
  }

  // the task branch exists and its prior-head probe fails, or its ref is broken: no add, an infra park, the ref untouched
  // "probe-once": only the FIRST prior-head probe fails; one checked answer, so zero adds (D-2187 add.156)
  for (const shape of ["probe", "probe-once", "broken"] as const) {
    const id6 = `run-branch-${shape}`;
    const run = setupRepo([T("T1")], { tasks: { T1: done } });
    const branch6 = `tickmarkr/${id6}--T1`;
    const head = priorBranch(run.repo, branch6);
    const loose = join(run.repo, ".git", "refs", "heads", ...branch6.split("/"));
    let adds6: (() => number) | undefined;
    if (shape === "broken") writeFileSync(loose, "not-an-object-name\n");
    else adds6 = gitShim({ fail: { match: `rev-parse --verify -q refs/heads/${branch6}`, times: shape === "probe-once" ? 1 : undefined } });
    const before = readFileSync(loose, "utf8");
    const parked6 = await runDaemon(run.repo, { runId: id6, adapters: [run.fake] });
    vi.unstubAllEnvs();
    expect(parked6.human).toEqual(["T1"]);
    const rows6 = Journal.open(run.repo, id6).read();
    expect(rows6.filter((e) => e.event === "task-failed")).toEqual([]);
    expect(rows6.find((e) => e.event === "task-human" && e.taskId === "T1")!.data)
      .toMatchObject({ kind: "infra", disposition: "git-probe-unknown", path: `refs/heads/${branch6}` });
    expect(readFileSync(loose, "utf8")).toBe(before);
    if (shape !== "broken") expect(before.trim()).toBe(head);
    if (adds6) expect(adds6()).toBe(0);
    expect(existsSync(worktreePath(run.repo, branch6))).toBe(false);
    expect(safetyRefs(run.repo)).toBe("");
  }

  // a dispatch that fails keeping its safety ref names it in the printed recovery on every path: an unmovable stray,
  // the quarantine retry's admin race, the quarantine retry's unknown branch probe, three admin races
  for (const shape of ["unmovable", "retry-race", "retry-probe", "races"] as const) {
    const id7 = `run-kept-${shape}`;
    const run = setupRepo([T("T1")], { tasks: { T1: done } });
    const branch7 = `tickmarkr/${id7}--T1`;
    const head = priorBranch(run.repo, branch7);
    const ref7 = `refs/tickmarkr/safety/${branch7}/${head}`;
    const dir7 = worktreePath(run.repo, branch7);
    if (shape !== "races") stray(dir7);
    const evidence = `fatal: failed to read '${run.repo}/.git/worktrees/foreign/commondir': No such file or directory`;
    if (shape === "retry-race") gitShim({ fail: { match: "worktree add", from: 2, times: 1, stderr: evidence } });
    if (shape === "retry-probe") gitShim({ fail: { match: `rev-parse --verify -q refs/heads/${branch7}`, from: 2, times: 1 } });
    if (shape === "races") gitShim({ failAdds: 3, adminEvidence: evidence });
    if (shape === "unmovable") chmodSync(dirname(dir7), 0o555);
    let parked7: Awaited<ReturnType<typeof runDaemon>>;
    try { parked7 = await runDaemon(run.repo, { runId: id7, adapters: [run.fake] }); }
    finally { if (shape === "unmovable") chmodSync(dirname(dir7), 0o755); vi.unstubAllEnvs(); }
    expect(parked7.human).toEqual(["T1"]);
    const rows7 = Journal.open(run.repo, id7).read();
    expect(rows7.filter((e) => e.event === "task-failed")).toEqual([]);
    const park7 = rows7.find((e) => e.event === "task-human" && e.taskId === "T1")!;
    expect(park7.data).toMatchObject({ kind: "infra", safetyRefs: [ref7] });
    expect(String(park7.data.recovery)).toContain(`git update-ref -d '${ref7}' '${head}'`);
    expect(String(park7.data.reason)).toContain(String(park7.data.recovery));
    expect(git(run.repo, "rev-parse", `refs/heads/${branch7}`)).toBe(head);
    expect(safetyRefs(run.repo)).toBe(`${ref7} ${head}`);
  }

  // the branch restore after a failed add fails once (the stray's single retry would then succeed): no retry, an infra
  // park naming the kept safety ref and the restore that recovers it, never success with the ref retained (D-2187 add.156)
  {
    const id8 = "run-restore-fails";
    const run = setupRepo([T("T1")], { tasks: { T1: done } });
    const branch8 = `tickmarkr/${id8}--T1`;
    const head = priorBranch(run.repo, branch8);
    const ref8 = `refs/tickmarkr/safety/${branch8}/${head}`;
    stray(worktreePath(run.repo, branch8));
    const adds8 = gitShim({ fail: { match: `update-ref refs/heads/${branch8} `, times: 1 } });
    const parked8 = await runDaemon(run.repo, { runId: id8, adapters: [run.fake] });
    vi.unstubAllEnvs();
    expect(parked8.human).toEqual(["T1"]);
    expect(adds8()).toBe(1);
    const rows8 = Journal.open(run.repo, id8).read();
    expect(rows8.filter((e) => e.event === "task-failed" || e.event === "worktree-quarantine")).toEqual([]);
    const park8 = rows8.find((e) => e.event === "task-human" && e.taskId === "T1")!;
    expect(park8.data).toMatchObject({ kind: "infra", disposition: "safety-ref-restore", path: ref8, safetyRefs: [ref8] });
    expect(String(park8.data.recovery)).toContain(`git update-ref 'refs/heads/${branch8}' '${head}'`);
    expect(String(park8.data.reason)).toContain(String(park8.data.recovery));
    expect(safetyRefs(run.repo)).toBe(`${ref8} ${head}`);
  }

  // an existing branch's add outlives the execution budget: the branch keeps its prior head and the budget park names
  // the kept safety ref with its recovery
  {
    const id9 = "run-budget-add";
    const run = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: { T1: done } },
      "executionPolicy: {boundedInfrastructure: true, taskExecutionLimitMs: 3500}\n");
    const branch9 = `tickmarkr/${id9}--T1`;
    const head = priorBranch(run.repo, branch9);
    const ref9 = `refs/tickmarkr/safety/${branch9}/${head}`;
    gitShim({ sleepAdd: 6_000 });
    const parked9 = await runDaemon(run.repo, { runId: id9, adapters: [run.fake], approvalWindowMs: 0 });
    vi.unstubAllEnvs();
    expect(parked9.human).toEqual(["T1"]);
    const rows9 = Journal.open(run.repo, id9).read();
    expect(rows9.filter((e) => e.event === "task-failed")).toEqual([]);
    const park9 = rows9.find((e) => e.event === "task-human" && e.taskId === "T1")!;
    expect(park9.data).toMatchObject({ kind: "infra", disposition: "execution-budget-exhausted", safetyRefs: [ref9] });
    expect(String(park9.data.recovery)).toContain(`git update-ref -d '${ref9}' '${head}'`);
    expect(String(park9.data.reason)).toContain(String(park9.data.recovery));
    expect(git(run.repo, "rev-parse", `refs/heads/${branch9}`)).toBe(head);
    expect(safetyRefs(run.repo)).toBe(`${ref9} ${head}`);
  }

  // the recovery entry is recorded before the safety ref's write and leaves only once its deletion is confirmed, so the
  // ref survives named in the park when the budget expires mid-write, mid-cleanup, or before preserve's probe fails, and
  // an older recovery ref reused by an unmovable stray's dispatch is named and never deleted (row 412 a, D-2187 add.156)
  for (const shape of ["ref-write", "cleanup", "list-fail", "older-unmovable"] as const) {
    const id12 = `run-kept-${shape}`;
    const run = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: { T1: done } },
      shape === "older-unmovable" ? "" : "executionPolicy: {boundedInfrastructure: true, taskExecutionLimitMs: 3500}\n");
    const branch12 = `tickmarkr/${id12}--T1`;
    const head = priorBranch(run.repo, branch12);
    const ref12 = `refs/tickmarkr/safety/${branch12}/${head}`;
    const dir12 = worktreePath(run.repo, branch12);
    const marker = join(makeTestTempDir("stray-marker-"), "added");
    if (shape === "ref-write") gitShim({ pause: { match: "update-ref refs/tickmarkr/safety/", ms: 6_000, after: true } });
    if (shape === "cleanup") {
      gitShim({ lockAfterAdd: join(run.repo, ".git", ...ref12.split("/")) + ".lock", pause: { match: "update-ref -d refs/tickmarkr/safety/", ms: 6_000 } });
    }
    if (shape === "list-fail") {
      gitShim({ pause: { match: "worktree add", ms: 6_000, after: true, marker }, fail: { match: "worktree list --porcelain -z", whenExists: marker } });
    }
    if (shape === "older-unmovable") { git(run.repo, "update-ref", ref12, head); stray(dir12); chmodSync(dirname(dir12), 0o555); }
    let parked12: Awaited<ReturnType<typeof runDaemon>>;
    try { parked12 = await runDaemon(run.repo, { runId: id12, adapters: [run.fake], approvalWindowMs: 0 }); }
    finally { if (shape === "older-unmovable") chmodSync(dirname(dir12), 0o755); vi.unstubAllEnvs(); }
    expect(parked12.human).toEqual(["T1"]);
    const rows12 = Journal.open(run.repo, id12).read();
    expect(rows12.filter((e) => e.event === "task-failed")).toEqual([]);
    const park12 = rows12.find((e) => e.event === "task-human" && e.taskId === "T1")!;
    expect(park12.data).toMatchObject({ kind: "infra", safetyRefs: [ref12] });
    expect(String(park12.data.reason)).toContain(String(park12.data.recovery));
    if (shape === "older-unmovable") {
      expect(String(park12.data.recovery)).toContain(`git update-ref 'refs/heads/${branch12}' '${head}'`);
      expect(String(park12.data.recovery)).not.toContain(`-d '${ref12}'`);
    } else {
      expect(String(park12.data.recovery)).toContain(`git update-ref -d '${ref12}' '${head}'`);
    }
    if (shape !== "cleanup") expect(git(run.repo, "rev-parse", `refs/heads/${branch12}`)).toBe(head);
    expect(safetyRefs(run.repo)).toBe(`${ref12} ${head}`);
  }

  // the printed recovery holds whether or not the safety ref's write landed (row 412 a, D-2187 add.156): the budget
  // expires before the write executes, or the write lands and then exits 128; executing the recovery exits 0, leaves the
  // branch at its prior head and no safety ref
  for (const shape of ["write-pending", "write-landed"] as const) {
    const id13 = `run-${shape}`;
    const run = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: { T1: done } },
      shape === "write-pending" ? "executionPolicy: {boundedInfrastructure: true, taskExecutionLimitMs: 3500}\n" : "");
    const branch13 = `tickmarkr/${id13}--T1`;
    const head = priorBranch(run.repo, branch13);
    const ref13 = `refs/tickmarkr/safety/${branch13}/${head}`;
    const adds13 = shape === "write-pending" ? gitShim({ pause: { match: "update-ref refs/tickmarkr/safety/", ms: 6_000 } })
      : gitShim({ fail: { match: "update-ref refs/tickmarkr/safety/", after: true } });
    const parked13 = await runDaemon(run.repo, { runId: id13, adapters: [run.fake], approvalWindowMs: 0 });
    vi.unstubAllEnvs();
    expect(parked13.human).toEqual(["T1"]);
    expect(adds13()).toBe(0);
    const rows13 = Journal.open(run.repo, id13).read();
    expect(rows13.filter((e) => e.event === "task-failed")).toEqual([]);
    const park13 = rows13.find((e) => e.event === "task-human" && e.taskId === "T1")!;
    expect(park13.data).toMatchObject({ kind: "infra" });
    const recovery13 = String(park13.data.recovery);
    expect(String(park13.data.reason)).toContain(recovery13);
    expect(recovery13).toContain(`if git show-ref --verify --quiet '${ref13}'; then git update-ref -d '${ref13}' '${head}'; fi`);
    expect(String(park13.data.reason)).not.toContain(`${ref13} keeps the prior head`);
    if (shape === "write-landed") expect(safetyRefs(run.repo)).toBe(`${ref13} ${head}`);
    const safety13 = recovery13.split(" && ").filter((part) => part.startsWith("cd -- ") || part.includes(ref13) || part.includes("refs/heads/"));
    execFileSync("sh", ["-c", safety13.join(" && ")], { stdio: "pipe" });
    expect(git(run.repo, "rev-parse", `refs/heads/${branch13}`)).toBe(head);
    expect(safetyRefs(run.repo)).toBe("");
  }

  // preserve's registration probe fails during a park's cleanup (an expired budget, an exhausted transport, a reap after
  // the hard timeout): an infra park naming the path, the probe and its exit — never a crashed run or a stall park
  for (const shape of ["budget", "transport", "reap"] as const) {
    const id10 = `run-preserve-${shape}`;
    const marker = join(makeTestTempDir("stray-marker-"), "started");
    const run = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })],
      { tasks: { T1: [{ shell: `echo dirty > unfinished.txt; touch '${marker}'; sleep 30`, result: { ok: true, summary: "done" } }] } },
      shape === "budget" ? "executionPolicy: {boundedInfrastructure: true, taskExecutionLimitMs: 3500}\n" : "");
    const wt = worktreePath(run.repo, `tickmarkr/${id10}--T1`);
    gitShim({ fail: { match: "worktree list --porcelain -z", whenExists: marker } });
    const driver = new SubprocessDriver({ poster: () => ({ status: 0, signal: null }) });
    if (shape === "transport") {
      driver.waitOutput = async () => {
        await new Promise((r) => setTimeout(r, 200));
        throw Object.assign(new Error("injected transport timeout"), { code: "ETIMEDOUT" });
      };
    }
    if (shape === "reap") setAttemptHardTimeoutMsForTests(1_200);
    let parked10: Awaited<ReturnType<typeof runDaemon>>;
    try { parked10 = await runDaemon(run.repo, { runId: id10, adapters: [run.fake], driver, approvalWindowMs: 0 }); }
    finally { resetAttemptHardTimeoutMsForTests(); vi.unstubAllEnvs(); }
    expect(parked10.human).toEqual(["T1"]);
    const rows10 = Journal.open(run.repo, id10).read();
    expect(rows10.filter((e) => e.event === "task-failed")).toEqual([]);
    expect(rows10.find((e) => e.event === "task-human" && e.taskId === "T1")!.data)
      .toMatchObject({ kind: "infra", disposition: "git-probe-unknown", path: wt, probe: "git worktree list --porcelain -z", exit: 128 });
    expect(readFileSync(join(wt, "unfinished.txt"), "utf8")).toBe("dirty\n");
  }

  // a dirty registered worktree beneath an inaccessible parent: its existence is unknown, so no add, no safety ref, an
  // infra park naming the path
  {
    const id11 = "run-inaccessible";
    const run = setupRepo([T("T1")], { tasks: { T1: done } });
    const branch11 = `tickmarkr/${id11}--T1`;
    const head = priorBranch(run.repo, branch11);
    const wt = await createWorktree(run.repo, branch11, head);
    writeFileSync(join(wt, "unfinished.txt"), "irreplaceable\n");
    const adds11 = gitShim({});
    chmodSync(dirname(wt), 0o000);
    let parked11: Awaited<ReturnType<typeof runDaemon>>;
    try { parked11 = await runDaemon(run.repo, { runId: id11, adapters: [run.fake], approvalWindowMs: 0 }); }
    finally { chmodSync(dirname(wt), 0o755); vi.unstubAllEnvs(); }
    expect(parked11.human).toEqual(["T1"]);
    expect(adds11()).toBe(0);
    const rows11 = Journal.open(run.repo, id11).read();
    expect(rows11.filter((e) => e.event === "task-failed")).toEqual([]);
    expect(rows11.find((e) => e.event === "task-human" && e.taskId === "T1")!.data)
      .toMatchObject({ kind: "infra", disposition: "git-probe-unknown", path: wt });
    expect(safetyRefs(run.repo)).toBe("");
    expect(git(run.repo, "rev-parse", `refs/heads/${branch11}`)).toBe(head);
    expect(readFileSync(join(wt, "unfinished.txt"), "utf8")).toBe("irreplaceable\n");
  }

  // the quarantine moved the stray and the execution budget expires inside the single retried add (D-2187 add.159): the
  // budget park keeps its kind and disposition and prints the record, the original path, where it was moved and a
  // command that completes the move only if the path is still there, never deleting the sibling; both branch cases
  // "before-retry": the budget expires after the move and before the retry enters createWorktree (the review's cell)
  for (const [existing, boundary] of [[true, "in-add"], [false, "in-add"], [true, "before-retry"], [false, "before-retry"]] as const) {
    const id14 = `run-budget-quarantine-${existing ? "existing" : "absent"}-${boundary}`;
    const run = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: { T1: done } },
      "executionPolicy: {boundedInfrastructure: true, taskExecutionLimitMs: 3500}\n");
    const branch14 = `tickmarkr/${id14}--T1`;
    const head = existing ? priorBranch(run.repo, branch14) : undefined;
    const dir14 = worktreePath(run.repo, branch14);
    stray(dir14);
    // the first add fails on the stray; the retried add succeeds and is then held past the budget
    const adds14 = gitShim(boundary === "in-add" ? { pause: { match: "worktree add", ms: 6_000, after: true } } : {});
    const driver = new SubprocessDriver();
    const create = driver.worktree.bind(driver);
    let calls = 0;
    // before the retry: wait for the budget's own cancellation, then stop as a cooperative caller does
    driver.worktree = async (r, b, at) => {
      if (++calls === 2 && boundary === "before-retry") {
        const signal = executionSignal()!;
        await new Promise((resolve) => signal.aborted ? resolve(undefined) : signal.addEventListener("abort", resolve, { once: true }));
        throw signal.reason;
      }
      return create(r, b, at);
    };
    const parked14 = await runDaemon(run.repo, { runId: id14, adapters: [run.fake], approvalWindowMs: 0, driver });
    vi.unstubAllEnvs();
    expect(parked14.human).toEqual(["T1"]);
    expect(calls).toBe(2);
    expect(adds14()).toBe(boundary === "in-add" ? 2 : 1);
    const rows14 = Journal.open(run.repo, id14).read();
    expect(rows14.filter((e) => e.event === "task-failed")).toEqual([]);
    const moves14 = rows14.filter((e) => e.event === "worktree-quarantine");
    expect(moves14).toHaveLength(1);
    const movedTo14 = String(moves14[0]!.data.movedTo);
    const park14 = rows14.find((e) => e.event === "task-human" && e.taskId === "T1")!;
    expect(park14.data).toMatchObject({ kind: "infra", disposition: "execution-budget-exhausted", quarantine: { path: dir14, movedTo: movedTo14 } });
    const reason14 = String(park14.data.reason);
    expect(reason14).toContain(dir14);
    expect(reason14).toContain(movedTo14);
    expect(reason14).toContain(String(park14.data.recovery));
    const finish14 = `if [ -e '${dir14}' ] && [ ! -e '${movedTo14}' ]; then mv -- '${dir14}' '${movedTo14}'; fi`;
    expect(String(park14.data.recovery)).toContain(finish14);
    execFileSync("sh", ["-c", finish14], { stdio: "pipe" });
    expect(readFileSync(join(movedTo14, "graft", ".cache", "stats.json"), "utf8")).toBe("{}\n");
    if (head) expect(git(run.repo, "rev-parse", `refs/heads/${branch14}`)).toBe(head);
    if (head && boundary === "before-retry") {
      // the first add's safety ref is kept and named with its executable drop
      const ref14 = `refs/tickmarkr/safety/${branch14}/${head}`;
      expect(park14.data).toMatchObject({ safetyRefs: [ref14] });
      expect(String(park14.data.recovery)).toContain(`git update-ref -d '${ref14}' '${head}'`);
      expect(safetyRefs(run.repo)).toBe(`${ref14} ${head}`);
    }
  }

  // the stray is quarantined and the single retry meets a git trust refusal (a raced foreign commondir): the refusal
  // keeps its type and task-failed ending, never an infra park, and that row's error prints the recovery record
  for (const existing of [true, false]) {
    const id15 = `run-trust-retry-${existing ? "existing" : "absent"}`;
    const run = setupRepo([T("T1")], { tasks: { T1: done } });
    const branch15 = `tickmarkr/${id15}--T1`;
    const head = existing ? priorBranch(run.repo, branch15) : undefined;
    const dir15 = worktreePath(run.repo, branch15);
    stray(dir15);
    // a real trust check in a linked checkout whose commondir names a foreign repository
    const host = makeRepo({ "base.txt": "base\n" });
    const linked = join(dirname(host), `${basename(host)}-linked`);
    git(host, "worktree", "add", "-q", "--detach", linked);
    writeFileSync(join(host, ".git", "worktrees", basename(linked), "commondir"), `${join(makeRepo({ "f.txt": "f\n" }), ".git")}\n`);
    const driver = new SubprocessDriver();
    const create = driver.worktree.bind(driver);
    let calls = 0;
    driver.worktree = async (r, b, at) => {
      if (++calls === 2) { await shGit("git status", linked); throw new Error("the trust check did not refuse"); }
      return create(r, b, at);
    };
    const result15 = await runDaemon(run.repo, { runId: id15, adapters: [run.fake], driver });
    expect(result15.failed).toEqual(["T1"]);
    expect(calls).toBe(2);
    const rows15 = Journal.open(run.repo, id15).read();
    expect(rows15.filter((e) => e.event === "task-human")).toEqual([]);
    const moves15 = rows15.filter((e) => e.event === "worktree-quarantine");
    expect(moves15).toHaveLength(1);
    const movedTo15 = String(moves15[0]!.data.movedTo);
    const failed15 = rows15.filter((e) => e.event === "task-failed");
    expect(failed15).toHaveLength(1);
    const error15 = String(failed15[0]!.data.error);
    expect(error15).toContain("git trust refusal");
    expect(error15).toContain(dir15);
    expect(error15).toContain(`if [ -e '${dir15}' ] && [ ! -e '${movedTo15}' ]; then mv -- '${dir15}' '${movedTo15}'; fi`);
    if (head) {
      const ref15 = `refs/tickmarkr/safety/${branch15}/${head}`;
      expect(error15).toContain(`git update-ref -d '${ref15}' '${head}'`);
      expect(git(run.repo, "rev-parse", `refs/heads/${branch15}`)).toBe(head);
      expect(safetyRefs(run.repo)).toBe(`${ref15} ${head}`);
    } else expect(safetyRefs(run.repo)).toBe("");
  }
}, 480_000);

test("a failed add restores an existing branch to its prior head from the safety ref which a successful add removes while an older recovery ref survives", async () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const base = git(repo, "rev-parse", "HEAD");
  // an add failure on an existing branch: restored, and the safety ref holds the prior head
  const branch = "tickmarkr/run-safety--T1";
  const prior = priorBranch(repo, branch);
  const dir = worktreePath(repo, branch);
  stray(dir);
  await expect(createWorktree(repo, branch, base)).rejects.toBeInstanceOf(WorktreePathExistsError);
  expect(git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(prior);
  expect(safetyRefs(repo)).toBe(`refs/tickmarkr/safety/${branch}/${prior} ${prior}`);
  // a clean add when that recovery ref already existed: the earlier ref is untouched
  execFileSync("mv", [dir, `${dir}.aside`]);
  expect(await createWorktree(repo, branch, base)).toBe(dir);
  expect(git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(base);
  expect(safetyRefs(repo)).toBe(`refs/tickmarkr/safety/${branch}/${prior} ${prior}`);
  // control: a clean add on an existing clean branch with no prior recovery ref leaves no safety ref
  const clean = "tickmarkr/run-safety--T2";
  const cleanPrior = priorBranch(repo, clean);
  expect(await createWorktree(repo, clean, base)).toBe(worktreePath(repo, clean));
  expect(git(repo, "rev-parse", `refs/heads/${clean}`)).toBe(base);
  expect(safetyRefs(repo)).not.toContain(cleanPrior);
  expect(safetyRefs(repo)).toBe(`refs/tickmarkr/safety/${branch}/${prior} ${prior}`);

  // one dispatch: existing branch plus stray, no ref before dispatch -> the ref the failed add created is removed
  // when the single quarantine retry succeeds, and the older recovery ref still survives
  const retried = "tickmarkr/run-safety--T3";
  const retriedPrior = priorBranch(repo, retried);
  const retriedDir = worktreePath(repo, retried);
  stray(retriedDir);
  const add = () => createWorktree(repo, retried, base);
  expect(await ownSafetyRefs(async () => {
    const failed = await add().catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(WorktreePathExistsError);
    expect(safetyRefs(repo)).toContain(retriedPrior);
    return quarantineAndRetry(failed as WorktreePathExistsError, add, () => undefined);
  })).toBe(retriedDir);
  expect(safetyRefs(repo)).toBe(`refs/tickmarkr/safety/${branch}/${prior} ${prior}`);

  // through runDaemon, each retry kind: an admin race on the first add, then (a) success, (b) a stray quarantined and
  // retried. The ref the dispatch's first add created is removed by the eventual success; a ref predating the dispatch
  // (c) survives that same sequence.
  for (const shape of ["race", "race-then-stray", "older-ref", "stray"] as const) {
    const id = `run-safety-${shape}`;
    const run = setupRepo([T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })], { tasks: { T1: done } });
    const taskBranch = `tickmarkr/${id}--T1`;
    const head = priorBranch(run.repo, taskBranch);
    const older = shape === "older-ref" ? `refs/tickmarkr/safety/${taskBranch}/${head}` : undefined;
    if (older) git(run.repo, "update-ref", older, head);
    const evidence = `fatal: failed to read '${run.repo}/.git/worktrees/foreign/commondir': No such file or directory`;
    const adds = gitShim({ failAdds: shape === "stray" ? 0 : 1, adminEvidence: evidence });
    if (shape === "stray") stray(worktreePath(run.repo, taskBranch));
    const driver = new SubprocessDriver();
    const create = driver.worktree.bind(driver);
    let n = 0;
    driver.worktree = (r, b, at) => { if (++n === 2 && shape === "race-then-stray") stray(worktreePath(r, b)); return create(r, b, at); };
    const result = await runDaemon(run.repo, { runId: id, adapters: [run.fake], driver });
    vi.unstubAllEnvs();
    expect(result.done).toEqual(["T1"]);
    expect(adds()).toBe(shape === "race-then-stray" ? 3 : 2);
    const rows = Journal.open(run.repo, id).read();
    expect(rows.filter((e) => e.event === "worktree-add-retry")).toHaveLength(shape === "stray" ? 0 : 1);
    expect(rows.filter((e) => e.event === "worktree-quarantine")).toHaveLength(shape.includes("stray") ? 1 : 0);
    expect(safetyRefs(run.repo)).toBe(older ? `${older} ${head}` : "");
  }

  // two dispatches whose existing branches share a prior head both meet strays; the second's single retry fails after
  // the first's retry succeeds: the first removes only its own safety ref, the parked one keeps its recovery point
  {
    const id = "run-shared-ref";
    const gates = ["build", "test", "lint", "evidence", "scope"] as const;
    const run = setupRepo([T("T1", { gates: [...gates] }), T("T2", { gates: [...gates] })], { tasks: { T1: done, T2: done } });
    const a = `tickmarkr/${id}--T1`, b = `tickmarkr/${id}--T2`;
    const head = priorBranch(run.repo, a);
    git(run.repo, "branch", b, head);
    stray(worktreePath(run.repo, a));
    stray(worktreePath(run.repo, b));
    const driver = new SubprocessDriver();
    const create = driver.worktree.bind(driver);
    const counts: Record<string, number> = {};
    let aFirst!: () => void, bLast!: () => void;
    const aFailed = new Promise<void>((r) => { aFirst = r; });
    const bFailed = new Promise<void>((r) => { bLast = r; });
    driver.worktree = async (r, br, at) => {
      const n = counts[br] = (counts[br] ?? 0) + 1;
      if (br === b && n === 1) await aFailed;
      if (br === a && n === 2) await bFailed;
      if (br === b && n === 2) stray(worktreePath(r, br));
      try { return await create(r, br, at); } finally {
        if (br === a && n === 1) aFirst();
        if (br === b && n === 2) bLast();
      }
    };
    const result = await runDaemon(run.repo, { runId: id, adapters: [run.fake], driver, concurrency: 2, approvalWindowMs: 0 });
    expect(result.done).toEqual(["T1"]);
    expect(result.human).toEqual(["T2"]);
    expect(counts).toEqual({ [a]: 2, [b]: 2 });
    expect(git(run.repo, "rev-parse", b)).toBe(head);
    expect(safetyRefs(run.repo)).toBe(`refs/tickmarkr/safety/${b}/${head} ${head}`);
    const park = Journal.open(run.repo, id).read().find((e) => e.event === "task-human" && e.taskId === "T2")!;
    expect(String(park.data.recovery)).toContain(`refs/tickmarkr/safety/${b}/${head}`);
  }

  // a safety ref that cannot be removed after a clean add is reported, never success with the ref retained
  const locked = "tickmarkr/run-safety--T4";
  const lockedPrior = priorBranch(repo, locked);
  const lock = join(repo, ".git", "refs", "tickmarkr", "safety", ...locked.split("/"), `${lockedPrior}.lock`);
  await expect(withBranchSafety(repo, locked, async () => { writeFileSync(lock, ""); return "added"; })).rejects.toThrow(/could not be removed/);
  execFileSync("rm", ["-f", lock]);

  // the restore runs outside an expired execution budget: the branch is back on its prior head
  const budget = "tickmarkr/run-safety--T5";
  const budgetPrior = priorBranch(repo, budget);
  const budgeted = withExecutionBudget({ limitMs: 300, taskId: "T5", readEvents: () => [], append: () => undefined }, () =>
    withBranchSafety(repo, budget, async () => {
      git(repo, "update-ref", `refs/heads/${budget}`, base);
      await new Promise((r) => setTimeout(r, 800));
      throw new Error("add interrupted");
    }));
  await expect(budgeted).rejects.toThrow();
  expect(git(repo, "rev-parse", `refs/heads/${budget}`)).toBe(budgetPrior);
}, 120_000);

test("preserve refuses in a plain directory inside the worktrees folder and leaves the parent index and refs unchanged", async () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const plain = worktreePath(repo, "plain-stray");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "loose.txt"), "loose\n");
  const index = readFileSync(join(repo, ".git", "index"));
  const refs = git(repo, "for-each-ref");
  expect(await preserveWorktree(plain)).toBeUndefined();
  expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
  expect(git(repo, "for-each-ref")).toBe(refs);
  // control: a registered linked worktree is preserved as at the base
  const linked = await createWorktree(repo, "tickmarkr/run-preserve--T1", "HEAD");
  writeFileSync(join(linked, "dirty.txt"), "dirty\n");
  const ref = await preserveWorktree(linked);
  expect(ref).toMatch(/^refs\/tickmarkr\/preserved\/[a-f0-9]{40}$/);
  expect(git(repo, "show", `${ref}:dirty.txt`)).toBe("dirty");
  // control: a plain repository that is its own top level (the gate runner's dirty refusal) is preserved too
  writeFileSync(join(repo, "main-dirty.txt"), "main\n");
  const own = await preserveWorktree(repo);
  expect(git(repo, "show", `${own}:main-dirty.txt`)).toBe("main");

  // control: a main checkout whose path holds a newline and ends in a space, and its linked worktree, are registered
  const odd = `${makeRepo({ "base.txt": "base\n" })}\nodd `;
  renameSync(odd.slice(0, odd.indexOf("\n")), odd);
  writeFileSync(join(odd, "odd-dirty.txt"), "odd\n");
  expect(await preserveWorktree(odd)).toMatch(/^refs\/tickmarkr\/preserved\//);
  const oddLinked = await createWorktree(odd, "tickmarkr/run-odd--T1", "HEAD");
  expect(await createWorktree(odd, "tickmarkr/run-odd--T1", "HEAD")).toBe(oddLinked);
  writeFileSync(join(oddLinked, "dirty.txt"), "dirty\n");
  expect(await preserveWorktree(oddLinked)).toMatch(/^refs\/tickmarkr\/preserved\//);

  // no repository named, in a stray whose `.git` names a pruned worktree: the typed unknown error, nothing written
  const strayRepo = makeRepo({ "base.txt": "base\n" });
  const pruned = worktreePath(strayRepo, "pruned-stray");
  prunedStray(strayRepo, pruned);
  writeFileSync(join(pruned, "loose.txt"), "loose\n");
  const strayIndex = readFileSync(join(strayRepo, ".git", "index"));
  const strayRefs = git(strayRepo, "for-each-ref");
  const unknown = await preserveWorktree(pruned).catch((e: unknown) => e);
  expect(unknown).toBeInstanceOf(GitProbeUnknownError);
  expect((unknown as GitProbeUnknownError).data).toMatchObject({ disposition: "git-probe-unknown", path: pruned });
  expect(readFileSync(join(strayRepo, ".git", "index"))).toEqual(strayIndex);
  expect(git(strayRepo, "for-each-ref")).toBe(strayRefs);
  expect(readdirSync(join(pruned))).toEqual([".git", "base.txt", "loose.txt"]);

  // a dirty registered worktree beneath an inaccessible parent does not resolve: unknown, never "nothing to preserve"
  const hidden = await createWorktree(strayRepo, "tickmarkr/run-hidden--T1", "HEAD");
  writeFileSync(join(hidden, "dirty.txt"), "dirty\n");
  const hiddenRefs = git(strayRepo, "for-each-ref");
  chmodSync(dirname(hidden), 0o000);
  let denied: unknown;
  try { denied = await preserveWorktree(hidden, "unknown", strayRepo).catch((e: unknown) => e); }
  finally { chmodSync(dirname(hidden), 0o755); }
  expect(denied).toBeInstanceOf(GitProbeUnknownError);
  expect((denied as GitProbeUnknownError).data).toMatchObject({ disposition: "git-probe-unknown", path: hidden });
  expect(git(strayRepo, "for-each-ref")).toBe(hiddenRefs);
  expect(readFileSync(join(hidden, "dirty.txt"), "utf8")).toBe("dirty\n");
});
