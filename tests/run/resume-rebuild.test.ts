import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { type Assignment, shq } from "../../src/adapters/types.js";
import { loadConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { ensureIntegration, integrationBranch } from "../../src/run/merge.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const assignment: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const realShGit = git.shGit;
afterEach(() => vi.restoreAllMocks());

async function seed(name: string, ids = ["T1"]) {
  const { repo, fake } = setupRepo(ids.map((id) => T(id, { files: ["*.txt"], gates: ["build", "test", "lint", "evidence", "scope"] })), {
    tasks: Object.fromEntries(ids.map((id) => [id, [{
      shell: `echo worker > worker.txt && ${COMMIT} worker`, result: { ok: true, summary: "landed" },
    }]])),
    consult: { action: "human", notes: "Queue row 240 (D-2138) fixture stops on failure" },
  }, stringify({ concurrency: 1, gates: { build: "true", lint: "true" } }));
  const base = await git.gitHead(repo);
  const runId = `run-rebuild-${name}`;
  const branch = integrationBranch(loadConfig(repo), runId);
  await ensureIntegration(repo, branch, base);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {
    pid: 111_111, baseRef: base, commands: { build: "true", lint: "true" }, branch,
    graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
  });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {
    build: { exitCode: 0, fingerprints: [] }, lint: { exitCode: 0, fingerprints: [] },
  } }));
  const worktrees = new Map<string, string>();
  for (const id of ids) {
    const wt = await new SubprocessDriver().worktree(repo, `${branch}--${id}`, base);
    worktrees.set(id, wt);
    journal.append("task-dispatch", id, { assignment, attempt: 0, base, retryMode: "fresh" });
  }
  return { repo, fake, runId, branch, journal, base, worktrees };
}
type Seed = Awaited<ReturnType<typeof seed>>;
const rows = (s: Seed) => Journal.open(s.repo, s.runId).read();
const afterResume = (s: Seed) => {
  const events = rows(s);
  return events.slice(events.map((e) => e.event).lastIndexOf("run-resume") + 1);
};
const run = (s: Seed) => runDaemon(s.repo, { adapters: [s.fake], runId: s.runId, resume: true });
const wt = (s: Seed, id = "T1") => s.worktrees.get(id)!;
async function commit(s: Seed, path = "work.txt", body = "committed\n", id = "T1") {
  writeFileSync(join(wt(s, id), path), body);
  await git.shGitOk(`git add ${shq(path)} && git commit --no-gpg-sign -m ${shq(path)}`, wt(s, id));
  return git.gitHead(wt(s, id));
}
function release(s: Seed, id = "T1", data: Record<string, unknown> = {}) {
  s.journal.append("task-human", id, { kind: "infra", reason: "Queue row 240 (D-2138) removed checkout" });
  s.journal.append("task-approved", id, { by: "fixture", park: s.journal.newestBinding(id), ...data });
}
async function remove(s: Seed, recorded: boolean, id = "T1") {
  const head = await git.gitHead(wt(s, id));
  const ref = await git.preserveWorktree(wt(s, id)) ?? head;
  await git.shGitOk(`git worktree remove --force ${shq(wt(s, id))}`, s.repo);
  if (recorded) s.journal.append("worktree-removed", undefined, { task: id, dir: wt(s, id), head, ref, by: "fixture" });
  return { head, ref };
}
async function tree(s: Seed, path: string) {
  return git.shGitOk(`git show ${shq(`${s.branch}:${path}`)}`, s.repo);
}
function recreation(s: Seed, id = "T1"): JournalEvent {
  const row = afterResume(s).find((e) => e.event === "worktree-recreation" && e.taskId === id);
  expect(row).toBeDefined();
  return row!;
}

test("test: a parked task whose checkout was removed with a recorded removal, and then whose task branch was deleted, is rebuilt on resume carrying its committed work up to the recorded head and then the uncommitted file that removal preserved, while an earlier recreation's preserved snapshot never reaches the rebuilt tree, and a task whose checkout is present still carries from it, so a resume that resets the missing task to the integration tip fails", async () => {
  const s = await seed("removal", ["T1", "T2"]);
  writeFileSync(join(wt(s), "stale.txt"), "earlier snapshot\n");
  const stale = await git.preserveWorktree(wt(s));
  s.journal.append("worktree-preserved", "T1", { ref: stale, producer: "unknown" });
  s.journal.append("worktree-recreation", "T1", { attempted: [], carried: [] });
  await git.shGitOk("git clean -f -- stale.txt", wt(s));
  const head = await commit(s);
  writeFileSync(join(wt(s), "dirty.txt"), "uncommitted\n");
  const removal = await remove(s, true);
  await git.shGitOk(`git branch -D ${shq(`${s.branch}--T1`)}`, s.repo);
  const present = await commit(s, "present.txt", "present checkout\n", "T2");
  release(s);
  release(s, "T2");
  expect((await run(s)).done).toEqual(["T1", "T2"]);
  expect(recreation(s).data).toMatchObject({ rebuiltFrom: "removal", attempted: [head, removal.ref], carried: [head, removal.ref] });
  expect(recreation(s, "T2").data.attempted).toEqual([present]);
  expect(recreation(s, "T2").data.rebuiltFrom).toBeUndefined();
  expect(await tree(s, "work.txt")).toBe("committed\n");
  expect(await tree(s, "dirty.txt")).toBe("uncommitted\n");
  expect(await tree(s, "present.txt")).toBe("present checkout\n");
  expect((await git.shGit(`git cat-file -e ${shq(`${s.branch}:stale.txt`)}`, s.repo)).code).not.toBe(0);
  expect(afterResume(s).filter((e) => e.event === "task-dispatch").every((e) => typeof e.data.base === "string")).toBe(true);
}, 120_000);

test("test: with no recorded removal, a missing checkout whose task branch descends from the base its dispatch journaled carries the branch's commits and keeps the branch's old tip under a recovery ref, a dispatch row written without a base is proven against the run's start base instead, and a branch moved off its base, or one whose history read fails, parks the task naming the branch and leaves the branch's old tip where it was, so a resume that resets a branch holding commits or reads a failed history as nothing ahead fails", async () => {
  for (const variant of ["dispatch", "legacy", "off-base", "history-failure", "ancestry-failure"]) {
    const s = await seed(variant);
    const head = await commit(s);
    await remove(s, false);
    if (variant === "legacy" || variant === "off-base") {
      writeFileSync(join(s.repo, "integrated.txt"), "later integration\n");
      await git.shGitOk(`${COMMIT} integrated`, s.repo);
      const advanced = await git.gitHead(s.repo);
      await git.shGitOk(`git update-ref ${shq(`refs/heads/${s.branch}`)} ${shq(advanced)}`, s.repo);
      s.journal.append("run-resume", undefined, { baseRef: advanced });
      s.journal.append("task-dispatch", "T1", { assignment, attempt: 1, ...(variant === "off-base" ? { base: advanced } : {}) });
    }
    release(s);
    let failedRead = false;
    if (variant.endsWith("failure")) vi.spyOn(git, "shGit").mockImplementation(async (...args) => {
      if (args[1] === s.repo && args[0].startsWith(variant === "history-failure" ? "git log --reverse" : "git merge-base --is-ancestor")) {
        failedRead = true;
        return { code: 128, stdout: "", stderr: "Queue row 240 (D-2138) unreadable history" };
      }
      return realShGit(...args);
    });
    const result = await run(s);
    vi.restoreAllMocks();
    const events = afterResume(s);
    if (["off-base", "history-failure", "ancestry-failure"].includes(variant)) {
      expect(result.human, variant).toEqual(["T1"]);
      expect(events.find((e) => e.event === "task-human")?.data).toMatchObject({ kind: "infra", reason: expect.stringContaining(`${s.branch}--T1`) });
      expect((await git.shGitOk(`git rev-parse ${shq(`${s.branch}--T1`)}`, s.repo)).trim()).toBe(head);
      expect(events.some((e) => ["worktree-recreation", "task-dispatch", "worker-launch"].includes(e.event))).toBe(false);
      expect(existsSync(wt(s))).toBe(false);
      if (variant.endsWith("failure")) expect(failedRead).toBe(true);
    } else {
      expect(result.done, variant).toEqual(["T1"]);
      expect(recreation(s).data).toMatchObject({ rebuiltFrom: "branch", attempted: [head], carried: [head] });
      const pinAt = events.findIndex((e) => e.event === "worktree-preserved");
      expect(pinAt).toBeGreaterThanOrEqual(0);
      expect(pinAt).toBeLessThan(events.findIndex((e) => e.event === "worktree-recreation"));
      const ref = events[pinAt]!.data.ref as string;
      expect(ref).toMatch(/^refs\/tickmarkr\/preserved\//);
      expect((await git.shGitOk(`git rev-parse ${shq(ref)}`, s.repo)).trim()).toBe(head);
      expect(await tree(s, "work.txt")).toBe("committed\n");
    }
  }
}, 120_000);

test("test: a missing checkout with nothing recorded and a task branch absent or level with the integration tip is dispatched fresh with nothing carried, and a recorded removal followed by a later recreation of the task, or by later commits on its task branch, is not read, the task branch deciding instead, so a rebuild that carries a stale removal and drops the later attempt's commit fails", async () => {
  for (const variant of ["absent", "level", "recreated", "advanced"]) {
    const s = await seed(variant);
    let later: string | undefined;
    let removal: Awaited<ReturnType<typeof remove>> | undefined;
    if (["recreated", "advanced"].includes(variant)) {
      await commit(s);
      writeFileSync(join(wt(s), "stale.txt"), "stale removal snapshot\n");
      removal = await remove(s, true);
      const next = await new SubprocessDriver().worktree(s.repo, `${s.branch}--T1`, variant === "advanced" ? removal.head : s.base);
      expect(next).toBe(wt(s));
      if (variant === "recreated") s.journal.append("worktree-recreation", "T1", { attempted: [], carried: [] });
      later = await commit(s, "later.txt", "later attempt\n");
      await remove(s, false);
    } else {
      await remove(s, false);
      if (variant === "absent") await git.shGitOk(`git branch -D ${shq(`${s.branch}--T1`)}`, s.repo);
    }
    release(s);
    expect((await run(s)).done, variant).toEqual(["T1"]);
    const events = afterResume(s);
    if (later) {
      expect(recreation(s).data.rebuiltFrom).toBe("branch");
      expect(recreation(s).data.attempted).toContain(later);
      expect(recreation(s).data.attempted).not.toContain(removal!.ref);
      expect(await tree(s, "later.txt")).toBe("later attempt\n");
      expect((await git.shGit(`git cat-file -e ${shq(`${s.branch}:stale.txt`)}`, s.repo)).code).not.toBe(0);
    } else {
      expect(events.some((e) => e.event === "worktree-preserved" || e.event === "worktree-recreation")).toBe(false);
      expect(await tree(s, "worker.txt")).toBe("worker\n");
      expect(events.find((e) => e.event === "task-dispatch")?.data.base).toBe(s.base);
    }
  }
}, 120_000);

test("test: a resume releasing a waived gate over a removed checkout with a recorded removal rebuilds the checkout and replays the remaining gates to a merge holding the task's committed work, while the same release with nothing recorded still refuses because the task worktree is missing, so a replay that throws over recorded work or merges an empty tree fails", async () => {
  for (const variant of ["waived", "nothing", "observed"]) {
    const s = await seed(variant);
    const head = await commit(s);
    s.journal.append("worker-result", "T1", { ok: true, finished: true, summary: "landed", deviations: [] });
    s.journal.phaseStart("T1", "gates");
    s.journal.append("gate-result", "T1", {
      gate: "build", pass: variant === "observed", details: "Queue row 240 (D-2138) seeded gate", commit: head, attempt: 0,
      verification: git.verificationProtocol(),
    });
    if (variant !== "observed") {
      s.journal.append("task-human", "T1", { kind: "gate-fail", reason: "build failed" });
      s.journal.append("task-approved", "T1", { by: "fixture", release: "gate-satisfied", gate: "build", park: s.journal.newestBinding("T1") });
    }
    await remove(s, variant !== "nothing");
    if (variant === "nothing") await git.shGitOk(`git update-ref ${shq(`refs/heads/${s.branch}--T1`)} ${shq(s.base)}`, s.repo);
    const result = await run(s);
    const events = afterResume(s);
    expect(events.some((e) => e.event === "worker-launch")).toBe(false);
    if (variant === "nothing") {
      expect(result.failed).toEqual(["T1"]);
      expect(events.find((e) => e.event === "task-failed")?.data.error).toContain("approved gate build cannot resume: task worktree is missing");
      expect(events.some((e) => e.event === "merge")).toBe(false);
    } else {
      expect(result.done, JSON.stringify(events.filter((e) => e.event === "task-human" || e.event === "task-failed"))).toEqual(["T1"]);
      expect(recreation(s).data).toMatchObject({ rebuiltFrom: "removal", attempted: [head], carried: [head] });
      expect(events.some((e) => e.event === "gate-result" && e.data.gate === "lint" && e.data.pass === true)).toBe(true);
      expect(events.some((e) => e.event === "merge")).toBe(true);
      expect(await tree(s, "work.txt")).toBe("committed\n");
    }
  }
}, 120_000);

test("test: a resume finishing an interrupted attempt whose result was recorded before its harvest records the commits up to the recorded head of its removed checkout and gates them, an attempt that launched without a result is declined as before and then rebuilt from the recorded removal, a failed task's recheck over a removed checkout still gates the approval's checked ref, and a parked task's recheck, which names no checked ref, gates the rebuilt recorded work instead of failing on the missing checkout, so a harvest recording no commits for recorded work or a recheck refusing a removed checkout fails", async () => {
  for (const variant of ["result", "launch", "failed-recheck", "parked-recheck", "empty-recheck"]) {
    const s = await seed(variant);
    const head = await commit(s);
    let checked: string | undefined;
    if (variant === "failed-recheck") {
      checked = await commit(s, "checked.txt", "approval subject\n");
      await git.shGitOk(`git reset --hard ${shq(head)}`, wt(s));
    }
    if (variant === "result") s.journal.append("worker-result", "T1", {
      ok: true, finished: true, summary: "landed before harvest", source: "resume", deviations: [],
    });
    if (variant === "launch") s.journal.append("worker-launch", "T1", {
      attempt: 0, nonce: "rebuild", dispatchScript: join(wt(s), "dispatch.sh"),
      slot: { id: "old", name: "tickmarkr:worker:T1", cwd: wt(s) },
    });
    await remove(s, variant !== "empty-recheck");
    if (variant === "failed-recheck") {
      await git.shGitOk(`git update-ref refs/tickmarkr/preserved/checked ${shq(checked!)}`, s.repo);
      s.journal.append("task-failed", "T1", { error: "Queue row 240 (D-2138) fixture failure" });
      s.journal.append("task-approved", "T1", {
        by: "fixture", release: "recheck", recheckedRef: "refs/tickmarkr/preserved/checked", failure: s.journal.newestBinding("T1", "task-failed"),
      });
      await git.shGitOk(`git update-ref ${shq(`refs/heads/${s.branch}--T1`)} ${shq(s.base)}`, s.repo);
    }
    if (variant === "parked-recheck" || variant === "empty-recheck") release(s, "T1", { release: "recheck" });
    if (variant === "empty-recheck") await git.shGitOk(`git update-ref ${shq(`refs/heads/${s.branch}--T1`)} ${shq(s.base)}`, s.repo);
    const result = await run(s);
    const events = afterResume(s);
    if (variant === "empty-recheck") {
      expect(result.failed).toEqual(["T1"]);
      expect(events.find((e) => e.event === "task-failed")?.data.error).toContain("recheck cannot resume: task worktree is missing");
      continue;
    }
    expect(result.done, JSON.stringify(events.filter((e) => e.event === "task-human" || e.event === "task-failed"))).toEqual(["T1"]);
    expect(await tree(s, "work.txt")).toBe("committed\n");
    expect(events.some((e) => e.event === "gate-result" && e.data.pass === true)).toBe(true);
    if (variant === "result") {
      expect(events.find((e) => e.event === "worker-result-harvested")?.data.commits).toEqual([head]);
      expect(events.some((e) => e.event === "task-dispatch")).toBe(false);
    } else if (variant === "launch") {
      expect(events.find((e) => e.event === "resume-harvest-declined")?.data.reason).toBe("task worktree missing");
      expect(events.some((e) => e.event === "task-dispatch")).toBe(true);
    } else {
      expect(events.some((e) => e.event === "worker-launch")).toBe(false);
      if (checked) expect(await tree(s, "checked.txt")).toBe("approval subject\n");
    }
    if (variant !== "failed-recheck") expect(recreation(s).data.rebuiltFrom).toBe("removal");
  }
}, 120_000);
