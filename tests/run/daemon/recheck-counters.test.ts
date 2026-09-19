// v2.5.6 T5 (OBS-1022, OBS-1028, OBS-1010, OBS-1045, OBS-1030): the zero-spend verbs and the counters
// they must not touch. Zero tokens: fake adapter, subprocess driver, scripted gate commands.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { channelKey, shq, type BillingChannel } from "../../../src/adapters/types.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { gitHead, worktreePath } from "../../../src/run/git.js";
import { COMMAND_LEASE_TOKEN_ENV } from "../../../src/run/lease.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, makeRepo, setupRepo, T } from "../../helpers/tmprepo.js";

const fake1 = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const after = (all: JournalEvent[], event: string): JournalEvent[] => {
  const idx = all.map((e) => e.event).lastIndexOf(event);
  return idx >= 0 ? all.slice(idx + 1) : all;
};
const of = (evs: JournalEvent[], event: string, taskId = "T1") => evs.filter((e) => e.event === event && e.taskId === taskId);

/** A driver whose worker wait THROWS after the worker's shell has finished — commits landed, harvest never ran. */
const wedgedAfterWork = (): ExecutorDriver => {
  const inner = new SubprocessDriver();
  let wedged = false;
  return {
    id: "wedged-after-work",
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    async waitOutput(slot, pattern, timeoutMs, opts) {
      const seen = await inner.waitOutput(slot, pattern, timeoutMs, opts);
      if (!wedged && slot.name.includes("-worker-")) { wedged = true; throw new Error("pane wedged after the worker committed"); }
      return seen;
    },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
};

/** A third vendor's seat, so a reviewer remains once one fake seat is demoted (retry.test.ts's NamedFake shape). */
class OtherVendor extends FakeAdapter {
  constructor(private sp: string) { super(sp); }
  override id = "other";
  override vendor = "other-v";
  override async probe() { return { installed: true, authed: true, version: "fake", models: ["other-1"], modelAuth: authedModels(["other-1"]) }; }
  override channels(): BillingChannel[] { return [{ adapter: "other", vendor: "other-v", model: "other-1", channel: "api", tier: "frontier" }]; }
  override headlessCommand(promptFile: string, model: string): string {
    const base = super.headlessCommand(promptFile, model);
    const prompt = readFileSync(promptFile, "utf8");
    const nonce = extractPromptNonce(prompt);
    if (!nonce || !/TICKMARKR-REVIEW/.test(prompt)) return base;
    const scripted = (JSON.parse(readFileSync(this.sp, "utf8")) as { review?: object }).review;
    return `${base}; echo ${shq(JSON.stringify({ ...scripted, nonce }))}`;
  }
}

/** A one-task repo with a consult that parks on the first red, so a resumed ladder is observable in ONE round. */
const parkingRepo = (judgePass: boolean) => {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }));
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
  const scriptPath = join(mkdtempSync(join(tmpdir(), "tickmarkr-rc-")), "s.json");
  writeFileSync(scriptPath, JSON.stringify({
    judge: { pass: judgePass, criteria: [{ criterion: "c1", met: judgePass, reason: judgePass ? "ok" : "t1.txt:1 still wrong" }] },
    review: { approve: true, issues: [] },
    consult: { action: "human", notes: "operator decides" },
    tasks: { T1: [{ shell: `echo again > t1.txt && ${COMMIT} t1-again`, result: { ok: true, summary: "t1 again" } }] },
  }));
  return { repo, fake: new FakeAdapter(scriptPath), other: new OtherVendor(scriptPath) };
};

const seedJournal = async (repo: string, runId: string, events: Array<{ event: string; taskId?: string; data?: object }>) => {
  const j = Journal.create(repo, runId);
  const baseRef = await gitHead(repo);
  j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  for (const e of events) j.append(e.event, e.taskId, e.data ?? {});
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  return j;
};

/** The task worktree a parked run leaves behind, with one commit ahead of the integration base. */
const seedTaskWorktree = async (repo: string, runId: string): Promise<string> => {
  const branch = `tickmarkr/${runId}`;
  const base = await gitHead(repo);
  git(repo, "branch", branch, base);
  const wt = await new SubprocessDriver().worktree(repo, `${branch}--T1`, base);
  writeFileSync(join(wt, "t1.txt"), "landed\n");
  git(wt, "add", "-A");
  git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "t1 landed");
  return wt;
};

describe("v2.5.6 T5 — zero-spend verbs and honest counters", () => {
  test("test: approve --recheck on a task in state failed whose preserved ref carries commits ahead of the task base is accepted and the resumed daemon runs the battery on that tree with gate-result rows and no worker-launch, the same verb on a failed task with no commits ahead is refused naming the reason, and a recheck over an infra dirt refusal re-gates the same commit in a clean checkout with the worker's diff unchanged and the litter recoverable from the preserved ref while a second litter on that recheck parks infra again with no further gate run, so a recheck that dispatches a worker, refuses committed work, or loops on litter fails", async () => {
    // ---- (a) failed with committed work: recheck accepted, battery runs, no worker -----------------
    {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } });
      const runId = "run-recheck-failed";
      const first = await runDaemon(repo, { adapters: [fake], runId, driver: wedgedAfterWork() });
      expect(first.failed).toEqual(["T1"]);
      const taskRef = `tickmarkr/${runId}--T1`;
      expect(git(repo, "rev-list", "--count", `tickmarkr/${runId}..${taskRef}`)).toBe("1");
      const preservedRef = "refs/tickmarkr/preserved/recheck-failed";
      git(repo, "update-ref", preservedRef, taskRef);
      Journal.open(repo, runId).append("worktree-preserved", "T1", { ref: preservedRef, reason: "worker exited after committing" });
      const msg = await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      expect(msg).toContain(`1 commit(s) on ${preservedRef} ahead of tickmarkr/run-recheck-failed; no worker funded`);
      expect(of(rows(repo, runId), "task-approved").at(-1)?.data.recheckedRef).toBe(preservedRef);
      const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(resumed.done).toEqual(["T1"]);
      const post = after(rows(repo, runId), "run-resume");
      expect(of(post, "gate-result").length).toBeGreaterThan(0);
      expect(of(post, "worker-launch")).toEqual([]);
      expect(of(post, "task-dispatch")).toEqual([]);
      expect(of(post, "recheck-battery")[0]?.data.pass).toBe(true);
    }
    // ---- (a2) a stale preservation never displaces a task branch advanced by a later attempt ------
    {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo old > t1.txt && ${COMMIT} old`, result: { ok: true, summary: "old" } }] } });
      const runId = "run-recheck-stale-preserved";
      const first = await runDaemon(repo, { adapters: [fake], runId, driver: wedgedAfterWork() });
      expect(first.failed).toEqual(["T1"]);
      const taskRef = `tickmarkr/${runId}--T1`;
      const staleRef = "refs/tickmarkr/preserved/recheck-stale";
      git(repo, "update-ref", staleRef, taskRef);
      const wt = worktreePath(repo, taskRef);
      writeFileSync(join(wt, "t1.txt"), "newest\n");
      git(wt, "add", "t1.txt");
      git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "newest attempt");
      expect(git(repo, "merge-base", taskRef, staleRef)).toBe(git(repo, "rev-parse", staleRef));
      Journal.open(repo, runId).append("worktree-preserved", "T1", { ref: staleRef, reason: "older dirty retry" });

      const msg = await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      expect(msg).toContain(`2 commit(s) on ${taskRef} ahead of tickmarkr/${runId}; no worker funded`);
      expect(of(rows(repo, runId), "task-approved").at(-1)?.data.recheckedRef).toBe(taskRef);
      expect(git(repo, "show", `${taskRef}:t1.txt`)).toBe("newest");
      expect(git(repo, "show", `${staleRef}:t1.txt`)).toBe("old");
    }
    // ---- (b) failed with nothing landed: refused naming the reason ---------------------------------
    {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: "echo nothing-committed", result: { ok: true, summary: "no commit" } }] } });
      const runId = "run-recheck-empty";
      const first = await runDaemon(repo, { adapters: [fake], runId, driver: wedgedAfterWork() });
      expect(first.failed).toEqual(["T1"]);
      await expect(approve([runId, "T1", "--recheck"], repo)).rejects.toThrow(/carries no commits ahead of tickmarkr\/run-recheck-empty — nothing to re-gate/);
      expect(of(rows(repo, runId), "task-approved")).toEqual([]);
    }
    // ---- (c) infra dirt refusal → recheck re-gates the same commit clean; the second litter parks again
    {
      const { repo, fake } = setupRepo(
        [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })],
        { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
        "gates: { build: 'true', test: 'touch litter.txt', lint: 'true' }\n",
      );
      const runId = "run-recheck-litter";
      const first = await runDaemon(repo, { adapters: [fake], runId });
      expect(first.human).toEqual(["T1"]);
      const all = rows(repo, runId);
      const refusal = of(all, "gate-result").find((e) => e.data.dirtyWorktree === true)!;
      expect(refusal.data.infra).toBe(true);
      expect(refusal.data.dirtyPaths).toEqual(["litter.txt"]);
      expect(of(all, "task-human").at(-1)?.data.kind).toBe("infra");
      const gatedCommit = String(refusal.data.commit);
      const preserved = String(refusal.data.preservedRef);
      // the litter is recoverable from the ref the refusal named, and the worker's diff is untouched by it
      expect(git(repo, "show", `${preserved}:litter.txt`)).toBe("");
      expect(git(repo, "diff", "--name-only", `tickmarkr/${runId}..${preserved}^`)).toBe("t1.txt");
      await approve([runId, "T1", "--recheck"], repo);
      const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(resumed.human).toEqual(["T1"]);
      const post = after(rows(repo, runId), "run-resume");
      expect(of(post, "task-dispatch")).toEqual([]);
      expect(of(post, "worker-launch")).toEqual([]);
      const results = of(post, "gate-result");
      // the battery gated the SAME commit on a clean checkout (an entry-dirt refusal would have died at
      // build with no culprit), then the test command littered AGAIN: the round dies there — no second
      // battery — and the task parks infra once more
      expect(results.map((e) => e.data.gate)).toEqual(["build", "lint", "evidence", "scope", "test"]);
      expect(results.every((e) => e.data.commit === gatedCommit)).toBe(true);
      const again = results.at(-1)!;
      expect(again.data.dirtyWorktree).toBe(true);
      expect(again.data.culprit).toBe("touch litter.txt"); // command-left litter, never entry dirt from the old checkout
      expect(again.data.infra).toBe(true);
      expect(of(post, "task-human").map((e) => e.data.kind)).toEqual(["infra"]);
      expect(of(post, "phase-start").filter((e) => e.data.phase === "gates")).toHaveLength(1);
      expect(git(repo, "diff", "--name-only", `tickmarkr/${runId}..${String(again.data.preservedRef)}^`)).toBe("t1.txt");
    }
  }, 300_000);

  test("test: a parked task at attempt six released with --recheck whose battery reds re-dispatches attempt seven with its tried list intact, a fresh-budget release resets both, a resume over a journal carrying a channel-demotion row dispatches the task's next attempt on a different worker channel while a review-pool-demotion row excludes only that reviewer seat and leaves the worker channel eligible, and a daemon started with an inherited lease token clears it so its first gate takes its own lease, so a recheck that zeroes the ladder, a resume that forgets a demotion or benches the wrong role, or a daemon riding an ancestor's lease fails", async () => {
    // ---- (a) recheck keeps the ladder: attempt six parked → recheck → red battery → attempt seven ----
    {
      const { repo, fake } = parkingRepo(false);
      const runId = "run-recheck-ladder";
      const seeds = [fake1, fake2, fake1, fake2, fake1, fake2];
      await seedJournal(repo, runId, [
        ...seeds.map((assignment, attempt) => ({ event: "task-dispatch", taskId: "T1", data: { assignment, attempt } })),
        { event: "worker-result", taskId: "T1", data: { ok: true, summary: "a5" } },
        { event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: false, details: "judge: not met" } },
        { event: "task-human", taskId: "T1", data: { kind: "gate-fail", reason: "consult verdict: human" } },
      ]);
      await seedTaskWorktree(repo, runId);
      await approve([runId, "T1", "--recheck"], repo);
      expect(Journal.open(repo, runId).replayResumeState().get("T1")).toMatchObject({ attempts: 6, tried: ["fake:fake-1", "fake:fake-2"] });
      const s = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(s.human).toEqual(["T1"]);
      const post = after(rows(repo, runId), "run-resume");
      expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
      const dispatches = of(post, "task-dispatch");
      expect(dispatches.length).toBeGreaterThanOrEqual(1);
      expect(dispatches[0]!.data.attempt).toBe(6); // the seventh attempt — never attempt 0
      for (const d of dispatches) expect(d.data.attempt as number).toBeGreaterThanOrEqual(6);
      expect(of(post, "resume-restore")[0]?.data).toMatchObject({ attempts: 6, tried: ["fake:fake-1", "fake:fake-2"] });
    }
    // ---- (b) a fresh-budget release resets both halves of the ladder -------------------------------
    {
      const { repo } = parkingRepo(true);
      const runId = "run-fresh-budget";
      const j = await seedJournal(repo, runId, [
        ...Array.from({ length: 10 }, (_, attempt) => ({ event: "task-dispatch", taskId: "T1", data: { assignment: attempt % 2 ? fake2 : fake1, attempt } })),
        { event: "task-human", taskId: "T1", data: { kind: "attempt-cap", reason: "attempt cap (10) reached" } },
      ]);
      expect(j.replayResumeState().get("T1")).toMatchObject({ attempts: 10, tried: ["fake:fake-1", "fake:fake-2"] });
      await approve([runId, "T1"], repo);
      expect(Journal.open(repo, runId).replayResumeState().get("T1")).toMatchObject({ attempts: 0, tried: [] });
    }
    // ---- (c) demotions survive resume BY ROLE ------------------------------------------------------
    {
      const { repo, fake } = parkingRepo(true);
      const runId = "run-demotion-worker";
      await seedJournal(repo, runId, [
        { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
        { event: "channel-demotion", taskId: "T1", data: { channel: "fake:fake-1", streak: 2 } },
      ]);
      expect([...Journal.open(repo, runId).replayExcludedChannels()]).toEqual(["fake:fake-1"]);
      const s = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(s.done).toEqual(["T1"]);
      const post = after(rows(repo, runId), "run-resume");
      const d = of(post, "task-dispatch");
      expect(d.length).toBeGreaterThanOrEqual(1);
      expect(channelKey(d[0]!.data.assignment as typeof fake1)).toBe("fake:fake-2");
      expect(d[0]!.data.excludedChannels).toContain("fake:fake-1");
    }
    {
      const { repo, fake, other } = parkingRepo(true);
      const runId = "run-demotion-reviewer";
      await seedJournal(repo, runId, [
        { event: "task-dispatch", taskId: "T1", data: { assignment: fake1, attempt: 0 } },
        { event: "review-pool-demotion", taskId: "T1", data: { reviewer: "fake:fake-2", cause: "no-verdict" } },
      ]);
      expect([...Journal.open(repo, runId).replayExcludedChannels()]).toEqual([]);
      const s = await runDaemon(repo, { adapters: [fake, other], runId, resume: true });
      expect(s.done).toEqual(["T1"]);
      const post = after(rows(repo, runId), "run-resume");
      const d = of(post, "task-dispatch");
      expect(channelKey(d[0]!.data.assignment as typeof fake1)).toBe("fake:fake-1"); // the worker channel stays eligible
      expect(d[0]!.data.excludedChannels).not.toContain("fake:fake-2"); // the reviewer seat is not a worker exclusion
      const reviews = of(post, "gate-result").filter((e) => e.data.gate === "review");
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews.map((e) => e.data.reviewer)).toEqual(reviews.map(() => "other:other-1")); // the demoted seat never reviews
    }
    // ---- (d) an inherited lease token is cleared at run-start --------------------------------------
    {
      const { repo, fake } = setupRepo(
        [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })],
        { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
        "gates: { build: 'true', test: 'true', lint: 'true' }\n",
      );
      const before = process.env[COMMAND_LEASE_TOKEN_ENV];
      process.env[COMMAND_LEASE_TOKEN_ENV] = "ancestor-lease-token";
      try {
        const s = await runDaemon(repo, { adapters: [fake], runId: "run-lease-clear" });
        expect(s.done).toEqual(["T1"]);
        expect(process.env[COMMAND_LEASE_TOKEN_ENV]).toBeUndefined(); // cleared, not carried into the gates
        expect(of(rows(repo, "run-lease-clear"), "gate-result").map((e) => e.data.gate)).toContain("test");
      } finally {
        if (before === undefined) delete process.env[COMMAND_LEASE_TOKEN_ENV]; else process.env[COMMAND_LEASE_TOKEN_ENV] = before;
      }
    }
  }, 300_000);
});
