import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { runDaemon } from "../../src/run/daemon.js";
import { addDetachedWorktree, createWorktree, removeWorktree, WorktreeAdminRaceError, worktreePath } from "../../src/run/git.js";
import { GitTrustRefusal } from "../../src/run/git-trust.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync(realGit, args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
interface AdminRow { phase: "start" | "end" | "overlap"; op: string; args: string[]; pid: number; retries?: number }
interface RecordingOptions {
  failures?: number | "always";
  evidence?: string;
  journal?: string;
  sabotage?: { branch: string; commondir: string; hostile: string };
}

// Queue row 223 (D-2118): the real git stays behind a PATH recorder that widens every admin command.
function recordingGit(options: RecordingOptions = {}) {
  const dir = makeTestTempDir("worktree-admin-");
  const log = join(dir, "admin.jsonl"), active = join(dir, "active"), count = join(dir, "adds");
  const control = join(dir, "control.json");
  writeFileSync(control, JSON.stringify(options));
  const file = join(dir, "git");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const at = args.indexOf("worktree");
const op = at < 0 ? undefined : args[at + 1];
const admin = ["add", "remove", "prune"].includes(op);
const log = ${JSON.stringify(log)}, active = ${JSON.stringify(active)}, count = ${JSON.stringify(count)};
const control = ${JSON.stringify(control)};
const options = JSON.parse(fs.readFileSync(control, "utf8"));
const record = phase => {
  const rows = options.journal && fs.existsSync(options.journal)
    ? fs.readFileSync(options.journal, "utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const retries = rows.filter(row => row.event === "worktree-add-retry").length;
  fs.appendFileSync(log, JSON.stringify({ phase, op, args, pid: process.pid, retries }) + "\\n");
};
let owned = false;
if (admin) {
  try { fs.mkdirSync(active); owned = true; } catch { record("overlap"); }
  record("start");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
}
let result;
try {
  let n = 0;
  if (op === "add") {
    n = fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0;
    fs.writeFileSync(count, String(++n));
  }
  if (op === "add" && (options.failures === "always" || n <= (options.failures || 0))) {
    result = { status: 128, stderr: options.evidence + "\\n" };
  } else {
    result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: ["ignore", "pipe", "pipe"] });
    const s = options.sabotage;
    if (result.status === 0 && op === "add" && s && args.includes(s.branch)) {
      fs.writeFileSync(s.commondir, s.hostile + "\\n");
    }
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
} finally {
  if (admin) { record("end"); if (owned) fs.rmdirSync(active); }
}
process.exit(result.status === null ? 128 : result.status);
`);
  chmodSync(file, 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  return {
    rows: (): AdminRow[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [],
    configure: (next: RecordingOptions) => writeFileSync(control, JSON.stringify(next)),
    adds: () => existsSync(count) ? Number(readFileSync(count, "utf8")) : 0,
  };
}

function expectSerial(rows: AdminRow[]) {
  expect(rows.filter((r) => r.phase === "overlap")).toEqual([]);
  let active: number | undefined;
  for (const row of rows) {
    if (row.phase === "start") { expect(active).toBeUndefined(); active = row.pid; }
    else { expect(row.pid).toBe(active); active = undefined; }
  }
  expect(active).toBeUndefined();
}

function daemonFixture(ids = ["T1"]) {
  return setupRepo(ids.map((id) => T(id, { files: [`${id}.txt`], gates: ["build", "test", "lint", "evidence", "scope"] })), {
    tasks: Object.fromEntries(ids.map((id) => [id, [{
      shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`,
      result: { ok: true, summary: id },
    }]])),
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("queue row 223 (D-2118)", () => {
  test("test: a daemon dispatching three independent tasks in one wave, under a recording git on the daemon's path that holds each worktree add open, records no two adds overlapping and dispatches all three, so concurrent unserialized adds fail", async () => {
    const ids = ["T1", "T2", "T3"];
    const { repo, fake } = daemonFixture(ids);
    const recorder = recordingGit();
    let arrived = 0;
    let release!: () => void;
    const wave = new Promise<void>((done) => { release = done; });
    class WaveDriver extends SubprocessDriver {
      override async worktree(root: string, branch: string, base: string) {
        if (++arrived === 3) release();
        await wave;
        return super.worktree(root, branch, base);
      }
    }
    const runId = "run-admin-wave";
    const result = await runDaemon(repo, { adapters: [fake], driver: new WaveDriver(), concurrency: 3, runId, approvalWindowMs: 0 });
    expect(arrived).toBe(3);
    expect(result.done.sort()).toEqual(ids);
    expect(result.failed).toEqual([]);
    const dispatched = Journal.open(repo, runId).read().filter((r) => r.event === "task-dispatch");
    expect(dispatched.map((r) => r.taskId).sort()).toEqual(ids);
    const rows = recorder.rows();
    expect(rows.filter((r) => r.phase === "start" && r.op === "add")).toHaveLength(3);
    expectSerial(rows);
  });

  test("test: concurrent task checkout creation, checkout removal and the detached baseline add in one process never overlap their worktree add, remove or prune, while a recreation over an existing checkout and a trust-refused add's rollback complete under the held lock, so a lock missing from any of them, or one that deadlocks, fails", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const existing = await createWorktree(repo, "existing", "HEAD");
    const removing = await createWorktree(repo, "removing", "HEAD");
    const detached = join(makeTestTempDir("baseline-"), "checkout");
    const recorder = recordingGit();
    const created = await Promise.all([
      createWorktree(repo, "created", "HEAD"),
      removeWorktree(repo, removing),
      addDetachedWorktree(repo, detached, "HEAD"),
    ]);
    expect(existsSync(created[0])).toBe(true);
    expect(existsSync(removing)).toBe(false);
    expect(created[2].code).toBe(0);
    expect(git(detached, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expectSerial(recorder.rows());

    const offset = recorder.rows().length;
    const [recreated, sibling] = await Promise.all([
      createWorktree(repo, "existing", "HEAD"),
      createWorktree(repo, "after-recreation", "HEAD"),
    ]);
    expect(recreated).toBe(existing);
    expect(existsSync(sibling)).toBe(true);
    const recreation = recorder.rows().slice(offset).filter((r) => r.phase === "start");
    expect(recreation.map((r) => r.op)).toEqual(["remove", "prune", "add", "add"]);
    expect(recreation[2]!.args).toContain("existing");
    expect(recreation[3]!.args).toContain("after-recreation");

    git(repo, "commit", "--allow-empty", "--no-gpg-sign", "-m", "prior branch");
    const prior = git(repo, "rev-parse", "HEAD");
    const source = join(makeTestTempDir("linked-source-"), "source");
    git(repo, "worktree", "add", "-b", "source", source, "HEAD^");
    const commondir = join(repo, ".git", "worktrees", "source", "commondir");
    const original = readFileSync(commondir, "utf8");
    const hostile = makeRepo({ "hostile.txt": "hostile\n" });
    const hostileRefs = git(hostile, "show-ref");
    for (const restore of [false, true]) {
      const branch = restore ? "refused-restore" : "refused-new";
      if (restore) git(repo, "branch", branch, prior);
      recorder.configure({ sabotage: { branch, commondir, hostile: join(hostile, ".git") } });
      const start = recorder.rows().length;
      try {
        const settled = await Promise.allSettled([
          createWorktree(source, branch, "HEAD"),
          createWorktree(repo, `after-${branch}`, "HEAD"),
        ]);
        expect(settled[0].status).toBe("rejected");
        expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(GitTrustRefusal);
        expect(settled[1].status).toBe("fulfilled");
        expect(existsSync(worktreePath(source, branch))).toBe(false);
        expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(`branch refs/heads/${branch}\n`);
        if (restore) expect(git(repo, "rev-parse", `refs/heads/${branch}`)).toBe(prior);
        else expect(git(repo, "branch", "--list", branch)).toBe("");
        expect(git(hostile, "show-ref")).toBe(hostileRefs);
        const rollback = recorder.rows().slice(start).filter((r) => r.phase === "start");
        expect(rollback.map((r) => r.op)).toEqual(["add", "remove", "prune", "add"]);
        expect(rollback[0]!.args).toContain(branch);
        expect(rollback[3]!.args).toContain(`after-${branch}`);
      } finally { writeFileSync(commondir, original); recorder.configure({}); }
    }
    expectSerial(recorder.rows());
  });

  test("test: an add that fails once with git's sibling admin read error and then succeeds dispatches the task and journals one retry row naming git's evidence, while that error on every add parks the task as infra naming it after three adds with no task-failed row, so a raced add recorded as a task failure fails", async () => {
    for (const failures of [1, "always"] as const) {
      const { repo, fake } = daemonFixture();
      const evidence = `fatal: failed to read '${repo}/.git/worktrees/foreign/commondir': No such file or directory`;
      const runId = `run-admin-${failures}`;
      const recorder = recordingGit({ failures, evidence, journal: join(repo, ".tickmarkr", "runs", runId, "journal.jsonl") });
      const result = await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 0 });
      const events = Journal.open(repo, runId).read().filter((r) => r.taskId === "T1");
      const retries = events.filter((r) => r.event === "worktree-add-retry");
      expect(retries).toHaveLength(failures === 1 ? 1 : 2);
      expect(retries.map((r) => r.data.attempt)).toEqual(failures === 1 ? [1] : [1, 2]);
      expect(retries.every((r) => r.data.evidence === evidence)).toBe(true);
      expect(events.filter((r) => r.event === "task-failed")).toEqual([]);
      expect(recorder.adds()).toBe(failures === 1 ? 2 : 3);
      expect(recorder.rows().filter((r) => r.phase === "start" && r.op === "add").map((r) => r.retries))
        .toEqual(failures === 1 ? [0, 1] : [0, 1, 2]);
      if (failures === 1) {
        expect(result.done).toEqual(["T1"]);
        expect(events.filter((r) => r.event === "worker-launch")).toHaveLength(1);
        expect(events.filter((r) => r.event === "task-human")).toEqual([]);
      } else {
        expect(result.done).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(events.filter((r) => r.event === "worker-launch")).toEqual([]);
        const parks = events.filter((r) => r.event === "task-human");
        expect(parks).toHaveLength(1);
        expect(parks[0]!.data.kind).toBe("infra");
        expect(parks[0]!.data.reason).toContain(evidence);
      }
      expectSerial(recorder.rows());
      vi.unstubAllEnvs();
    }
  });

  test("test: an add failing with any other git error, such as an invalid reference, still records task-failed of kind dispatch with no retry row and no infra park, so a retry or infra park widened past the sibling admin signature fails", async () => {
    const { repo, fake } = daemonFixture();
    const evidence = "fatal: invalid reference: missing-base";
    const recorder = recordingGit({ failures: "always", evidence });
    const runId = "run-admin-invalid";
    const result = await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 0 });
    const events = Journal.open(repo, runId).read().filter((r) => r.taskId === "T1");
    expect(result.failed).toEqual(["T1"]);
    expect(recorder.adds()).toBe(1);
    expect(events.filter((r) => r.event === "worktree-add-retry" || r.event === "task-human")).toEqual([]);
    const failures = events.filter((r) => r.event === "task-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.data).toMatchObject({ kind: "dispatch", error: expect.stringContaining(evidence) });
  });

  test("queue row 223 (D-2118): only add stderr naming a direct sibling admin file gets the exported error", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const recorder = recordingGit();
    for (const leaf of ["commondir", "gitdir", "HEAD"]) {
      const evidence = `fatal: failed to read ${repo}/.git/worktrees/sibling/${leaf}: No such file or directory`;
      recorder.configure({ failures: "always", evidence });
      await expect(createWorktree(repo, `typed-${leaf}`, "HEAD")).rejects.toMatchObject({ name: "WorktreeAdminRaceError", evidence });
    }
    for (const path of ["HEAD", "worktrees/sibling/index", "worktrees/sibling/nested/HEAD", "other/sibling/commondir"]) {
      recorder.configure({ failures: "always", evidence: `fatal: failed to read '${repo}/.git/${path}': No such file or directory` });
      const error = await createWorktree(repo, "ordinary-failure", "HEAD").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(WorktreeAdminRaceError);
    }
    recorder.configure({});
    await expect(createWorktree(repo, "after-errors", "HEAD")).resolves.toBe(worktreePath(repo, "after-errors"));
  });
}, 120_000);
