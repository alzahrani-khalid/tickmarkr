import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, Invocation } from "../../src/adapters/types.js";
import type { Task } from "../../src/graph/schema.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { classifyWorkerResultCause } from "../../src/run/journal.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

function idriver(overrides: Record<string, unknown> = {}): ExecutorDriver {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-fake", interactive: true,
    slot: inner.slot.bind(inner), run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner), status: async () => "unknown",
    ...overrides,
  } as ExecutorDriver;
}

class MalformedTrailerFake extends FakeAdapter {
  invoke(task: Task, _cwd: string, _a: Assignment, ctx: { promptFile: string }): Invocation {
    const nonce = /TICKMARKR_RESULT_([0-9a-f]+)/.exec(readFileSync(ctx.promptFile, "utf8"))?.[1] ?? "";
    // trailerPattern matches "ok":true, but JSON.parse fails on the truncated summary string
    return { command: `bash -c 'echo TICKMARKR_RESULT_${nonce} {"ok":true, "summary":}'` };
  }
}

describe("classifyWorkerResultCause (OBS-53 unit)", () => {
  test("provider-death when output contains provider-outage signature", () => {
    expect(classifyWorkerResultCause({
      output: "committing…\nUnable to reach the model provider\n",
      ok: false, finished: false, exitCode: null, summary: "worker produced no TICKMARKR_RESULT trailer", timedOut: false,
    })).toBe("provider-death");
  });

  test("stall-timeout when timed out without trailer", () => {
    expect(classifyWorkerResultCause({
      output: "still working…", ok: false, finished: false, exitCode: null,
      summary: "worker produced no TICKMARKR_RESULT trailer", timedOut: true,
    })).toBe("stall-timeout");
  });

  test("malformed-trailer when trailer token present but unparseable", () => {
    expect(classifyWorkerResultCause({
      output: 'TICKMARKR_RESULT_abcd {"ok":true broken', ok: false, finished: true, exitCode: null,
      summary: "unparseable TICKMARKR_RESULT trailer", timedOut: false,
    })).toBe("malformed-trailer");
  });

  test("clean-exit-no-trailer when process exits without trailer", () => {
    expect(classifyWorkerResultCause({
      output: "done\n", ok: false, finished: false, exitCode: 0,
      summary: "worker produced no TICKMARKR_RESULT trailer", timedOut: false,
    })).toBe("clean-exit-no-trailer");
  });
});

describe("worker-result cause journaling (v1.46 T1, zero tokens)", () => {
  test("a dead worker whose output contains a provider-outage signature journals cause provider-death", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "echo 'Unable to reach the model provider'; exit 1" }] },
        consult: { action: "human", notes: "stop" },
      },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-prov-death", driver: idriver() });
    const wr = Journal.open(repo, "run-prov-death").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("provider-death");
  }, 30_000);

  test("a stall reap journals cause stall-timeout", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 999" }] }, consult: { action: "human", notes: "stop" } },
      "taskTimeoutMinutes: 1\n",
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-stall", driver: idriver() });
    const wr = Journal.open(repo, "run-stall").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("stall-timeout");
    // T5: the dispatch banner is a one-time pane-output burst; if it lands after the detector's first
    // read it legitimately resets inactivity detection by one poll slice — the budget must cover it.
  }, 150_000);

  test("a finished worker with an unparseable trailer journals cause malformed-trailer", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { consult: { action: "human", notes: "stop" } },
      "visibility:\n  worker: print\n",
    );
    const fake = new MalformedTrailerFake(scriptPath);
    await runDaemon(repo, { adapters: [fake], runId: "run-malformed", driver: idriver() });
    const wr = Journal.open(repo, "run-malformed").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("malformed-trailer");
  }, 30_000);

  test("a clean exit with no trailer journals cause clean-exit-no-trailer", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo done; exit 0" }] }, consult: { action: "human", notes: "stop" } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-clean-exit", driver: idriver() });
    const wr = Journal.open(repo, "run-clean-exit").read().find((e) => e.event === "worker-result");
    expect(wr?.data.cause).toBe("clean-exit-no-trailer");
  }, 30_000);

  test("a provider-death requeues the same assignment without incrementing the attempt counter", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [
            { shell: "echo 'Unable to reach the model provider'; exit 1" },
            { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered" } },
          ],
        },
      },
      "visibility:\n  worker: print\n", // print mode advances the fake step counter across provider requeues
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-requeue", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-requeue").read().filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(evs).toHaveLength(2); // initial + one successful retry, not three
    expect(evs.every((e) => (e.data.assignment as { model: string }).model === "fake-1")).toBe(true);
    const requeues = Journal.open(repo, "run-requeue").read().filter((e) => e.event === "provider-death-requeue");
    expect(requeues).toHaveLength(1);
    expect(requeues[0].data.attempt).toBe(0);
  }, 30_000);

  // v1.65 T1: the third consecutive provider-death no longer falls through to the consult/ladder
  // path — it is a typed dead channel and takes the free failover; with every channel dead the
  // task parks on reroute-exhausted without spending a consult or a ladder step.
  test("provider outage on every channel exhausts the requeues then parks without a consult", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "echo 'Unable to reach the model provider'; exit 1" }] },
        consult: { action: "human", notes: "infra exhausted" },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-prov-cap", driver: idriver() });
    expect(s.human).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-prov-cap").read();
    // 2 requeues per channel (v1.46 cap), then a typed reroute; the second channel dies the same way
    expect(evs.filter((e) => e.event === "provider-death-requeue")).toHaveLength(4);
    const fo = evs.filter((e) => e.event === "dead-channel-failover");
    expect(fo).toHaveLength(2);
    expect(fo.every((e) => e.data.reason === "provider-outage")).toBe(true);
    expect(fo[1].data.to).toBeNull(); // no candidate left → park, not consult
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(false);
    expect(evs.some((e) => e.event === "escalation")).toBe(false);
    expect(evs.some((e) => e.event === "task-human" && e.data.kind === "reroute-exhausted")).toBe(true);
  }, 60_000);

  test("a channel with two consecutive no-trailer windows in one run is not selected for later attempts in that run", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [
            { shell: "echo stall1; exit 0" },
            { shell: "echo stall2; exit 0" },
            { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "on fake-2" } },
          ],
        },
        consult: { action: "retry", notes: "try again" },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-demote", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-demote").read();
    expect(evs.some((e) => e.event === "channel-demotion" && e.data.channel === "fake:fake-1")).toBe(true);
    const dispatches = evs.filter((e) => e.event === "task-dispatch");
    const models = dispatches.map((e) => (e.data.assignment as { model: string }).model);
    expect(models[0]).toBe("fake-1");
    expect(models[1]).toBe("fake-1");
    expect(models[2]).toBe("fake-2"); // demoted fake-1 after two no-trailer windows
  }, 30_000);

  test("every failure path still writes a journal event", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo stall; exit 0" }] }, consult: { action: "human", notes: "park" } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-journal", driver: idriver() });
    const evs = Journal.open(repo, "run-journal").read();
    expect(evs.filter((e) => e.event === "worker-result")).toHaveLength(1);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(true);
    expect(evs.some((e) => e.event === "task-human")).toBe(true);
  }, 30_000);
});

// v1.65 T1: typed dead-channel failover — classification at the parse boundary (classifyDeadChannel
// in src/adapters/prompt.ts), consumed by the daemon as a type; free reroute like quota, run-wide
// channel exclusion, no escalation-ladder step. All zero-token (fake adapter, subprocess driver).
describe("typed dead-channel failover (v1.65 T1, zero tokens)", () => {
  const AUTH_FAIL = "echo 'Not logged in. Please run /login to authenticate.'; exit 1";
  const dispatchModels = (repo: string, runId: string, taskId = "T1") =>
    Journal.open(repo, runId).read()
      .filter((e) => e.event === "task-dispatch" && e.taskId === taskId)
      .map((e) => (e.data.assignment as { model: string }).model);

  test("an authentication-required worker failure reroutes to the next candidate without consuming an escalation step", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: AUTH_FAIL },
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "done on the next channel" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dead-auth" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-dead-auth").read();
    const fo = evs.filter((e) => e.event === "dead-channel-failover");
    expect(fo).toHaveLength(1);
    expect(fo[0].data).toMatchObject({ reason: "auth-required", from: "fake:fake-1", to: "fake:fake-2" });
    expect(evs.some((e) => e.event === "escalation")).toBe(false); // the ladder never moved
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(false);
    expect(dispatchModels(repo, "run-dead-auth")).toEqual(["fake-1", "fake-2"]);
  }, 30_000);

  test("a provider-outage worker failure reroutes to the next candidate without consuming an escalation step", async () => {
    const outage = "echo 'Unable to reach the model provider'; exit 1";
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: outage }, // dispatch
        { shell: outage }, // requeue 1 (v1.46 transient recovery unchanged)
        { shell: outage }, // requeue 2 — cap spent, PERSISTING outage → typed free failover
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "done on the next channel" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dead-outage" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-dead-outage").read();
    expect(evs.filter((e) => e.event === "provider-death-requeue")).toHaveLength(2);
    const fo = evs.filter((e) => e.event === "dead-channel-failover");
    expect(fo).toHaveLength(1);
    expect(fo[0].data).toMatchObject({ reason: "provider-outage", from: "fake:fake-1", to: "fake:fake-2" });
    expect(evs.some((e) => e.event === "escalation")).toBe(false);
    expect(evs.some((e) => e.event === "consult-verdict")).toBe(false);
  }, 30_000);

  test("a typed dead-channel failure excludes that channel for later attempts in the run", async () => {
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [
          { shell: AUTH_FAIL },
          { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "rerouted" } },
        ],
        T2: [{ shell: `echo t2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "on the surviving channel" } }],
      } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dead-exclude" });
    expect([...s.done].sort()).toEqual(["T1", "T2"]);
    // the dead channel never serves again this run: T1's retry AND the later task both avoid it
    expect(dispatchModels(repo, "run-dead-exclude", "T1")).toEqual(["fake-1", "fake-2"]);
    expect(dispatchModels(repo, "run-dead-exclude", "T2")).toEqual(["fake-2"]);
  }, 30_000);

  test("the journal records the typed reason for every dead-channel reroute", async () => {
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [
          { shell: AUTH_FAIL },
          { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "rerouted" } },
        ],
        T2: [{ shell: `echo t2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "clean" } }],
      } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-dead-journal" });
    const fo = Journal.open(repo, "run-dead-journal").read().filter((e) => e.event === "dead-channel-failover");
    expect(fo.length).toBeGreaterThan(0);
    for (const e of fo) {
      expect(["auth-required", "setup-required", "provider-outage", "timeout"]).toContain(e.data.reason);
      expect(typeof e.data.from).toBe("string"); // reroute is attributable: reason + from + to on every event
      expect(e.data).toHaveProperty("to");
    }
  }, 30_000);

  test("a genuine work failure with a parseable trailer still walks the escalation ladder unchanged", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "retry", notes: "commit something real" },
        tasks: { T1: [
          // dead-channel-looking text INSIDE ordinary work output — the parsed trailer wins
          { shell: "echo 'saw: Not logged in — while editing the auth page'", result: { ok: false, summary: "tests failing" } },
          { shell: "true", result: { ok: false, summary: "still failing" } },
          { shell: "true", result: { ok: false, summary: "still failing" } },
          { shell: `echo done > f.txt && ${COMMIT} f`, result: { ok: true, summary: "finally" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dead-ladder" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-dead-ladder").read();
    expect(evs.filter((e) => e.event === "escalation").map((e) => e.data.step)).toEqual(["retry", "escalate", "consult"]);
    expect(evs.some((e) => e.event === "dead-channel-failover")).toBe(false);
  }, 30_000);

  test("quota failover behavior is byte-identical to before the extension", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'; exit 1" },
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-dead-quota" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-dead-quota").read();
    const q = evs.filter((e) => e.event === "quota-failover");
    expect(q).toHaveLength(1);
    expect(Object.keys(q[0].data).sort()).toEqual(["from", "to"]); // exact pre-extension event shape
    expect(q[0].data).toEqual({ from: "fake:fake-1", to: "fake:fake-2" });
    // a quota hit never enters the typed dead-channel path: no typed event, no run-wide demotion
    expect(evs.some((e) => e.event === "dead-channel-failover")).toBe(false);
    expect(evs.some((e) => e.event === "channel-demotion")).toBe(false);
    expect(evs.some((e) => e.event === "escalation")).toBe(false);
    expect(dispatchModels(repo, "run-dead-quota")).toEqual(["fake-1", "fake-2"]);
  }, 30_000);
});

describe("OBS-53/OBS-57 citations in source", () => {
  test("OBS-53 is cited at the classification site", async () => {
    const src = readFileSync(new URL("../../src/run/journal.ts", import.meta.url), "utf8");
    expect(src).toMatch(/OBS-53/);
    expect(src).toContain("classifyWorkerResultCause");
  });

  test("OBS-57 is cited at the in-run demotion site", async () => {
    const daemon = readFileSync(new URL("../../src/run/daemon.ts", import.meta.url), "utf8");
    const router = readFileSync(new URL("../../src/route/router.ts", import.meta.url), "utf8");
    expect(daemon).toMatch(/OBS-57/);
    expect(router).toMatch(/OBS-57/);
  });
});
