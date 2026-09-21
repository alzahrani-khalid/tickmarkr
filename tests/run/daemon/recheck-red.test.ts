// v2.5.6 (OBS-1055): a recheck never reuses a RED verdict, and a pinned recheck repair honours the pin.
// Zero tokens: fake adapter, subprocess driver, scripted gate commands.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { channelKey, shq } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const afterResume = (all: JournalEvent[]): JournalEvent[] => all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
const seatOf = (e: JournalEvent) => channelKey(e.data.assignment as { adapter: string; model: string });

/**
 * A one-task repo whose test gate is green at baseline (no t1.txt yet) and, once the worker lands
 * t1.txt, green only while `flag` exists — so the SAME tree reds and then greens with no worker in
 * between, the shape of a flake the operator rechecks. The first run parks on the red (consult →
 * human); the daemon's own battery caches that red for the task tree.
 */
const flakyRepo = (opts: { judgePass?: boolean; pin?: { via: string; model: string }; testGreen?: boolean } = {}) => {
  const flag = join(makeTestTempDir("tickmarkr-recheck-red-"), "green");
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"], ...(opts.pin ? { routingHints: { pin: opts.pin } } : {}) })],
    {
      judge: { pass: opts.judgePass ?? true, criteria: [{ criterion: "c1", met: opts.judgePass ?? true, reason: opts.judgePass ?? true ? "ok" : "t1.txt:1 still wrong" }] },
      consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
    },
    `gates: { build: 'true', test: ${shq(opts.testGreen ? "true" : `[ ! -f t1.txt ] || [ -f ${flag} ]`)}, lint: 'true' }\n`,
  );
  return { repo, fake, scriptPath, flag };
};

describe("v2.5.6 — a recheck re-measures: cached reds are discarded, the pin hosts the repair", () => {
  test("test: a task parked gate-fail on a red test verdict and released with approve --recheck re-runs the test gate on the same tree instead of replaying the cached red, journaling recheck-rerun {gate: test, reason: cached-red-discarded} and a fresh green test gate-result with no worker-launch and no task-dispatch, so a recheck that answers from the red it was asked to re-measure fails", async () => {
    const { repo, fake, flag } = flakyRepo();
    const runId = "run-recheck-red-discarded";
    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);
    const parked = rows(repo, runId);
    expect(of(parked, "gate-result").filter((e) => e.data.gate === "test").every((e) => e.data.pass === false)).toBe(true);
    // the flake clears: the identical tree is green now — no worker, no new commit
    writeFileSync(flag, "green\n");
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(resumed.done).toEqual(["T1"]);
    const post = afterResume(rows(repo, runId));
    expect(of(post, "recheck-rerun").map((e) => e.data)).toEqual([{ gate: "test", reason: "cached-red-discarded" }]);
    expect(of(post, "gate-reused-verdict").filter((e) => e.data.gate === "test")).toEqual([]);
    const fresh = of(post, "gate-result").filter((e) => e.data.gate === "test");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.data.pass).toBe(true);
    expect(fresh[0]!.data.reused).toBeUndefined();
    expect(of(post, "recheck-battery")[0]?.data.pass).toBe(true);
    expect(of(post, "worker-launch")).toEqual([]);
    expect(of(post, "task-dispatch")).toEqual([]);
  }, 300_000);

  test("test: the same recheck over a task whose cached test verdict is GREEN replays it (gate-reused-verdict test pass:true, no recheck-rerun row, no second test run), so only reds are discarded and a recheck that re-runs every gate regardless of its cached verdict fails", async () => {
    const { repo, fake, scriptPath } = flakyRepo({ judgePass: false, testGreen: true });
    const runId = "run-recheck-green-replayed";
    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);
    const parked = rows(repo, runId);
    expect(of(parked, "gate-result").filter((e) => e.data.gate === "test").every((e) => e.data.pass === true)).toBe(true);
    // the judge relents; the battery's cached greens are not what the recheck questions
    const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
    writeFileSync(scriptPath, JSON.stringify({ ...script, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } }));
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    const resumed = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true });
    expect(resumed.done).toEqual(["T1"]);
    const post = afterResume(rows(repo, runId));
    expect(of(post, "recheck-rerun")).toEqual([]);
    const replayed = of(post, "gate-reused-verdict").filter((e) => e.data.gate === "test");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.data.pass).toBe(true);
    expect(of(post, "worker-launch")).toEqual([]);
  }, 300_000);

  test("test: a pinned task whose recheck battery reds dispatches the repair on the pinned seat, and the same recheck over a task pinned to a seat the fleet cannot host parks naming the pin with no dispatch, so a recheck repair that takes the ladder off the pin, or that silently degrades an unavailable pin to the ladder, fails", async () => {
    // ---- the pin hosts its own repair --------------------------------------------------------------
    {
      const { repo, fake, flag } = flakyRepo({ pin: { via: "fake", model: "fake-1" } });
      const runId = "run-recheck-pin-repair";
      const first = await runDaemon(repo, { adapters: [fake], runId });
      expect(first.human).toEqual(["T1"]);
      for (const d of of(rows(repo, runId), "task-dispatch")) expect(seatOf(d)).toBe("fake:fake-1");
      expect(existsSync(flag)).toBe(false); // still red: the recheck re-measures and reds again
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      await runDaemon(repo, { adapters: [fake], runId, resume: true });
      const post = afterResume(rows(repo, runId));
      expect(of(post, "recheck-rerun").map((e) => e.data)).toEqual([{ gate: "test", reason: "cached-red-discarded" }]);
      expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
      const dispatches = of(post, "task-dispatch");
      expect(dispatches.length).toBeGreaterThanOrEqual(1);
      expect(seatOf(dispatches[0]!)).toBe("fake:fake-1");
    }
    // ---- an unhostable pin parks naming the pin, never the ladder -----------------------------------
    {
      const { repo, fake } = flakyRepo({ pin: { via: "fake", model: "fake-9" } });
      const runId = "run-recheck-pin-unavailable";
      const first = await runDaemon(repo, { adapters: [fake], runId });
      expect(first.human).toEqual(["T1"]);
      await approve([runId, "T1", "--recheck", "--by", "op"], repo);
      const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(resumed.human).toEqual(["T1"]);
      const post = afterResume(rows(repo, runId));
      expect(of(post, "recheck-battery")[0]?.data.pass).toBe(false);
      expect(of(post, "task-dispatch")).toEqual([]);
      expect(of(post, "worker-launch")).toEqual([]);
      const park = of(post, "task-human").at(-1)!;
      expect(park.data.kind).toBe("gate-fail");
      expect(park.data.reason).toMatch(/pinned fake:fake-9 is unavailable to host the repair — refusing the ladder/);
    }
  }, 300_000);
});
