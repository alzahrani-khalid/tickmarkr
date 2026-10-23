import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { dispatch } from "../../src/cli/index.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { isPidLive, repositoryClaimPath } from "../../src/run/lock.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 220 (D-2111): a spec's declared base is proven before a run or a resume writes anything.
// Every fixture is a real repository; the fake adapter is the only seat, so the suite spends no tokens.

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
// explicit paths only: the untracked run state directory must never ride a fixture commit
const commit = (repo: string, path: string, subject: string) => {
  writeFileSync(join(repo, path), `${subject}\n`);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
};
const declare = (repo: string, base: string | undefined) => {
  const g = loadGraph(repo);
  saveGraph(repo, validateGraph({ ...g, spec: { ...g.spec, base } }));
};
const runnable = () => setupRepo(
  [T("T1")],
  { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
);
const rejection = (p: Promise<unknown>) =>
  p.then(() => { throw new Error("resolved — the declared base was not refused"); }, (e: unknown) => e as Error);
const runStart = (repo: string, runId: string) => Journal.open(repo, runId).read().find((e) => e.event === "run-start")!;
const journalBytes = (repo: string, runId: string) => readFileSync(join(Journal.open(repo, runId).dir, "journal.jsonl"), "utf8");
const deadPid = () => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid!;
  expect(isPidLive(pid)).toBe(false);
  return pid;
};

/** Nothing a run writes is left: no run directory, no task worktree, no integration ref, no lock or claim. */
const expectNothingWritten = (repo: string) => {
  const runs = join(tickmarkrDir(repo), "runs");
  expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  const worktrees = join(tickmarkrDir(repo), "worktrees.noindex");
  expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  expect(git(repo, "for-each-ref", "refs/heads/tickmarkr", "refs/tickmarkr")).toBe("");
  expect(existsSync(join(tickmarkrDir(repo), "graph.lock"))).toBe(false);
  expect(existsSync(repositoryClaimPath(repo)!)).toBe(false);
};

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

describe("queue row 220: a declared base is proven before a run or a resume writes anything", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; });

  test("test: a fresh daemon run whose declared base HEAD contains by ancestry, or only as a cherry-picked twin, starts from HEAD and journals the declared ref with method ancestry or patch-id on run-start, while no declared base journals no such field, so a run that proves nothing, names the wrong method or stamps an undeclared base fails", async () => {
    const cases: Array<{ name: string; arrange: (repo: string) => string | undefined; via?: string }> = [
      { name: "ancestry", via: "ancestry", arrange: (repo) => {
        git(repo, "branch", "declared");
        commit(repo, "ahead.txt", "main moves past the declared base");
        return "declared";
      } },
      { name: "patch-id", via: "patch-id", arrange: (repo) => {
        git(repo, "checkout", "-q", "-b", "declared");
        const twin = commit(repo, "twin.txt", "the declared patch");
        git(repo, "checkout", "-q", "main");
        commit(repo, "other.txt", "main diverges first");
        git(repo, "cherry-pick", twin);
        // no ancestry: only patch identity can prove this base
        expect(spawnSync("git", ["merge-base", "--is-ancestor", "declared", "HEAD"], { cwd: repo }).status).toBe(1);
        return "declared";
      } },
      { name: "no declared base", arrange: () => undefined },
    ];
    for (const c of cases) {
      const { repo, fake } = runnable();
      const base = c.arrange(repo);
      declare(repo, base);
      const head = git(repo, "rev-parse", "HEAD");
      const runId = `run-declared-${c.name.replace(/\W+/g, "-")}`;
      const s = await runDaemon(repo, { adapters: [fake], runId });
      expect(s.done, c.name).toEqual(["T1"]);
      const start = runStart(repo, runId);
      expect(start.data.baseRef, c.name).toBe(head);
      if (c.via) expect(start.data.declaredBase, c.name).toEqual({ ref: base, via: c.via });
      else expect("declaredBase" in start.data, c.name).toBe(false);
    }
  }, 240_000);

  test("test: when the declared base carries a commit HEAD lacks, the tickmarkr run command exits non-zero and the daemon throws, naming its short id, subject, paths and both remedies, with no run directory, task worktree, integration ref or graph lock left, so a run on the wrong base or a refusal after any write fails", async () => {
    const { repo, fake, scriptPath } = runnable();
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;
    git(repo, "checkout", "-q", "-b", "declared");
    const missing = commit(repo, "drift.txt", "declared-only drift commit");
    git(repo, "checkout", "-q", "main");
    declare(repo, "declared");
    const expectNamed = (message: string) => {
      expect(message).toContain(missing.slice(0, 12));
      expect(message).toContain("declared-only drift commit");
      expect(message).toContain("drift.txt");
      expect(message).toContain("check out a branch that contains declared");
      expect(message).toContain("correct base: in the spec and recompile");
    };

    const priorCwd = process.cwd();
    process.chdir(repo);
    try {
      const cli = await dispatch("run", ["--driver", "subprocess"]);
      expect(cli.code).not.toBe(0);
      expectNamed(cli.out);
    } finally {
      process.chdir(priorCwd);
    }
    expectNothingWritten(repo);

    const err = await rejection(runDaemon(repo, { adapters: [fake], runId: "run-drifted" }));
    expect(err.message).toContain("has drifted");
    expectNamed(err.message);
    expectNothingWritten(repo);

    // a subject git cannot read is never papered over: the refusal turns unresolvable and quotes git
    git(repo, "config", "log.date", "invalid-review-date");
    const said = spawnSync("git", ["log", "-1", "--format=%s", missing], { cwd: repo, encoding: "utf8" });
    expect(said.status).not.toBe(0);
    const evidence = (said.stderr || said.stdout).trim();
    expect(evidence).toContain("invalid-review-date");
    const unread = await rejection(runDaemon(repo, { adapters: [fake], runId: "run-subject-unreadable" }));
    expect(unread.message).toContain("is unresolvable");
    expect(unread.message).toContain(`missing commit ${missing.slice(0, 12)}`);
    expect(unread.message).toContain(evidence);
    expect(unread.message).toContain("correct base: in the spec and recompile");
    expect(unread.message).not.toContain("subject unreadable");
    expectNothingWritten(repo);
  }, 120_000);

  test("test: a fresh run whose declared base resolves to no commit throws quoting git's own evidence and writes nothing, and a resume whose run-start records no base commit refuses naming that missing record, so a refusal hiding git's answer or an unknown base read as contained fails", async () => {
    const { repo, fake } = runnable();
    declare(repo, "refs/heads/never-existed");
    const said = spawnSync("git", ["rev-parse", "--verify", "refs/heads/never-existed^{commit}"], { cwd: repo, encoding: "utf8" });
    expect(said.status).not.toBe(0);
    const evidence = (said.stderr || said.stdout).trim();
    expect(evidence).not.toBe("");
    const err = await rejection(runDaemon(repo, { adapters: [fake], runId: "run-unresolvable" }));
    expect(err.message).toContain("is unresolvable");
    expect(err.message).toContain(evidence);
    expect(err.message).toContain("correct base: in the spec and recompile");
    expectNothingWritten(repo);

    // a base HEAD holds outright, so only the missing record can refuse it
    declare(repo, "main");
    const j = Journal.create(repo, "run-no-base-record");
    j.append("run-start", undefined, { commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    const before = journalBytes(repo, "run-no-base-record");
    const refused = await rejection(runDaemon(repo, { adapters: [fake], runId: "run-no-base-record", resume: true }));
    expect(refused.message).toContain("is unresolvable");
    expect(refused.message).toContain("run-start records no baseRef");
    expect(journalBytes(repo, "run-no-base-record")).toBe(before);
    expect(existsSync(join(tickmarkrDir(repo), "graph.lock"))).toBe(false);
  }, 120_000);

  test("test: a resume proves its declared base against the recorded run-start base, not HEAD: a moved or deleted base ref, or a graph-changed base the recorded base lacks though HEAD holds it, refuses with the journal unchanged and no graph-rehash row, while one the recorded base holds under an unrelated HEAD proceeds journaling ref and method, so a HEAD-based check fails", async () => {
    const { repo, fake } = runnable();
    git(repo, "branch", "declared");
    declare(repo, "declared");
    const runId = "run-resume-base";
    expect((await runDaemon(repo, { adapters: [fake], runId })).done).toEqual(["T1"]);
    const recorded = runStart(repo, runId).data.baseRef as string;
    const before = journalBytes(repo, runId);
    const refuses = async (graphChanged: boolean, ...expected: string[]) => {
      const err = await rejection(runDaemon(repo, { adapters: [fake], runId, resume: true, graphChanged }));
      expect(err.message).toContain(`recorded run-start base ${recorded.slice(0, 12)}`);
      for (const text of expected) expect(err.message).toContain(text);
      expect(journalBytes(repo, runId)).toBe(before);
      expect(Journal.open(repo, runId).read().some((e) => e.event === "graph-rehash")).toBe(false);
      expect(existsSync(join(tickmarkrDir(repo), "graph.lock"))).toBe(false);
    };

    // moved: the declared ref gains a commit the recorded base lacks, and HEAD fast-forwards to hold it
    git(repo, "checkout", "-q", "declared");
    const moved = commit(repo, "moved.txt", "declared ref moved after run-start");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "declared");
    expect(git(repo, "rev-parse", "HEAD")).toBe(moved);
    await refuses(false, "has drifted", moved.slice(0, 12), "moved.txt");

    // deleted: the declared ref no longer resolves
    git(repo, "branch", "-D", "declared");
    await refuses(false, "is unresolvable");

    // graph-changed onto a base HEAD holds and the recorded base lacks
    declare(repo, "main");
    await refuses(true, "has drifted", moved.slice(0, 12));

    // graph-changed onto a base the recorded base holds, under a HEAD with no shared history
    git(repo, "branch", "held", recorded);
    declare(repo, "held");
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    git(repo, "rm", "-rfq", "--", ".");
    commit(repo, "unrelated.txt", "unrelated history");
    expect(spawnSync("git", ["merge-base", "held", "HEAD"], { cwd: repo }).status).not.toBe(0);
    await runDaemon(repo, { adapters: [fake], runId, resume: true, graphChanged: true });
    const resumed = Journal.open(repo, runId).read().filter((e) => e.event === "run-resume");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.data.declaredBase).toEqual({ ref: "held", via: "ancestry" });
    expect(runStart(repo, runId).data.baseRef).toBe(recorded); // never re-based
  }, 240_000);

  test("test: resuming an interrupted run, whose killed daemon left an open journal and its graph lock, onto a drifted base refuses with the journal byte-identical, no exit-cause or lock-reclaimed row, and no graph lock or repository claim left, so a check placed after the reclaim rows fails", async () => {
    const { repo, fake } = runnable();
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "declared");
    const drift = commit(repo, "drift.txt", "declared drift past the recorded base");
    git(repo, "checkout", "-q", "main");
    declare(repo, "declared");
    const runId = "run-interrupted";
    const pid = deadPid();
    const j = Journal.create(repo, runId);
    j.append("run-start", undefined, { pid, baseRef: head, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1");
    // the killed daemon's graph lock and repository claim, both naming its provably dead pid
    const lock = join(tickmarkrDir(repo), "graph.lock");
    const claim = repositoryClaimPath(repo)!;
    writeFileSync(lock, JSON.stringify({ pid, runId, startedAt: Date.now() }));
    writeFileSync(claim, JSON.stringify({ pid, runId, startedAt: Date.now(), checkout: realpathSync(repo) }));
    const before = journalBytes(repo, runId);

    const err = await rejection(runDaemon(repo, { adapters: [fake], runId, resume: true }));
    expect(err.message).toContain("has drifted");
    expect(err.message).toContain(drift.slice(0, 12));
    expect(journalBytes(repo, runId)).toBe(before);
    const events = Journal.open(repo, runId).read().map((e) => e.event);
    expect(events).not.toContain("exit-cause");
    expect(events).not.toContain("lock-reclaimed");
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(claim)).toBe(false);

    // control: the same killed-daemon residue under a contained base reaches the reclaim rows, so the
    // refusal above is what kept them out
    git(repo, "branch", "-f", "declared", head);
    writeFileSync(lock, JSON.stringify({ pid, runId, startedAt: Date.now() }));
    writeFileSync(claim, JSON.stringify({ pid, runId, startedAt: Date.now(), checkout: realpathSync(repo) }));
    await runDaemon(repo, { adapters: [fake], runId, resume: true });
    const appended = Journal.open(repo, runId).read().map((e) => e.event);
    expect(appended).toContain("exit-cause");
    expect(appended).toContain("lock-reclaimed");
    expect(Journal.open(repo, runId).read().find((e) => e.event === "run-resume")!.data.declaredBase)
      .toEqual({ ref: "declared", via: "ancestry" });
  }, 240_000);
});
