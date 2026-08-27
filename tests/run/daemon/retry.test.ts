import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { kimiSessionId } from "../../../src/adapters/kimi.js";
import { shq } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { type ExecutorDriver, type Slot } from "../../../src/drivers/types.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { gitHead, sanitizeBranch, shOk, worktreePath, WORKTREES_DIR } from "../../../src/run/git.js";
import { activeRetryBan, GATE_FINGERPRINT_CAP, journaledFailureBrief, Journal, normalizeGateFailure, pendingRepairFindings, recordedTaskFailureKind, structuredFindings, UNIDENTIFIED, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, authedModels, setupRepo, T } from "../../helpers/tmprepo.js";


/**
 * A FakeAdapter wearing another adapter's id and vendor, so a fixture fleet can carry a second vendor
 * without a second script format. One definition, three call sites (it was copied three times).
 *
 * NONCE (OBS-186 collateral): llm.ts binds a scripted fake verdict to the call nonce only when
 * `adapter.id === "fake"` (augmentFakeVerdictOutput) — and a renamed fake is a different adapter to
 * that guard, so its review verdict arrived UNBOUND and every gate reaching it failed closed on
 * cause `no-verdict`. Path-keyed participation is what routes real reviews here for the first time.
 * The fix is the FIXTURE's, not the check's: this adapter emits its own VERDICT_NONCE-bound copy,
 * exactly as a real reviewer CLI does. Widening llm.ts's guard to `instanceof FakeAdapter` was
 * measured and turns tests/gates/review-retry.test.ts red — that suite uses the same rename to
 * produce a nonce-less verdict ON PURPOSE. Review only: a judge verdict served this way would miss
 * the per-criterion evidence injectFakeEvidence adds, and no fixture routes a judge to a NamedFake.
 */
class NamedFake extends FakeAdapter {
  constructor(private sp: string, public id: string, private models: string[], public vendor: string, private ch: "sub" | "api") {
    super(sp);
  }
  async probe() {
    return { installed: true, authed: true, version: "fake", models: this.models, modelAuth: authedModels(this.models) };
  }
  channels() {
    return this.models.map((model) => ({
      adapter: this.id, vendor: this.vendor, model, channel: this.ch, tier: "frontier" as const,
    }));
  }
  headlessCommand(promptFile: string, model: string): string {
    const base = super.headlessCommand(promptFile, model);
    const prompt = readFileSync(promptFile, "utf8");
    const nonce = extractPromptNonce(prompt);
    if (!nonce || !/TICKMARKR-REVIEW/.test(prompt)) return base;
    const scripted = (JSON.parse(readFileSync(this.sp, "utf8")) as { review?: unknown }).review;
    if (!scripted || typeof scripted !== "object") return base;
    return `${base}; echo ${shq(JSON.stringify({ ...scripted, nonce }))}`;
  }
}


const addGateScripts = (repo: string, testCmd: string) => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: testCmd } }));
};


const runWorktreeDirs = (repo: string, branch: string): string[] => {
  const root = join(tickmarkrDir(repo), WORKTREES_DIR);
  if (!existsSync(root)) return [];
  const prefix = sanitizeBranch(branch);
  return readdirSync(root).filter((d) => d === prefix || d.startsWith(`${prefix}--`)).sort();
};


const interactiveDriver = () => {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-test",
    interactive: true,
    status: inner.status.bind(inner),
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
};


// v1.23 T2: context sampling piggybacks on interactive poll seams; threshold → one journal + one notify.
describe("v1.23 context-sample (fake adapter, zero tokens)", () => {
  test("crossing the threshold journals one context-sample and notifies once per attempt (no spam)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo hi > a.txt && ${COMMIT} a`, result: { ok: true, summary: "done" } }] } },
      "contextWarnTokens: 1000\n",
    );
    // High context every sample; proves the once-per-attempt latch (not "notify every poll").
    fake.contextUsage = () => ({ tokens: 50_000 });
    const inner = new SubprocessDriver();
    const notified: string[] = [];
    let polls = 0;
    const driver = {
      id: "interactive-ctx",
      interactive: true,
      status: async () => "unknown",
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      // Force ≥3 poll slices while context stays high, then accept the real trailer wait.
      async waitOutput(slot: { id: string; name: string; cwd: string }, pattern: string, timeoutMs: number, opts?: { regex?: boolean }) {
        polls++;
        if (polls < 3) return false;
        return inner.waitOutput(slot, pattern, timeoutMs, opts);
      },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      async notify(msg: string, opts?: { sound?: string }) {
        notified.push(msg);
        return inner.notify(msg, opts);
      },
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-ctx-once", driver });
    expect(s.done).toEqual(["T1"]);
    expect(polls).toBeGreaterThanOrEqual(3); // multiple samples attempted
    const samples = Journal.open(repo, "run-ctx-once").read().filter((e) => e.event === "context-sample");
    expect(samples).toHaveLength(1); // one journal event per attempt
    expect(samples[0]!.data.tokens).toBe(50_000);
    expect(samples[0]!.data.threshold).toBe(1000);
    const ctxNotifies = notified.filter((m) => /context .*tokens/.test(m));
    expect(ctxNotifies).toHaveLength(1); // one notify — no spam while high
  }, 30_000);

  test("old journals without context-sample events still resume (replay compatibility)", async () => {
    // Resume path must tolerate pre-v1.23 journals: no context-sample events, no schema migration.
    const { repo, fake } = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: {
        T1: [{ shell: "echo SHOULD-NOT-RUN && exit 1", result: { ok: false, summary: "must not run" } }],
        T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
      } },
    );
    const j = Journal.create(repo, "run-ctx-resume");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
    j.append("task-done", "T1", { attempts: 1 });
    // Explicitly NO context-sample events — the pre-v1.23 shape.
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    // replayStatuses/replayResumeState ignore absent retryMode; old journals need no migration.
    expect(j.replayStatuses().get("T1")).toBe("done");
    expect(j.replayResumeState().get("T1")).toMatchObject({ attempts: 1, tried: ["fake:fake-1"] });
    expect(j.read().find((e) => e.event === "task-dispatch")!.data.retryMode).toBeUndefined();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-ctx-resume", resume: true });
    expect(s.done).toContain("T2");
    expect(s.done).toContain("T1");
    // Resume must not invent context-sample events for the already-done task.
    const samples = Journal.open(repo, "run-ctx-resume").read().filter((e) => e.event === "context-sample" && e.taskId === "T1");
    expect(samples).toHaveLength(0);
  });
});


// v1.23 T3: over-threshold context on a failed/timed-out attempt ⇒ fresh-session retry + session-reset journal.
// Decision is retry-boundary only (never mid-attempt kill). Unknown/below ⇒ no event (byte-identical).
describe("v1.23 session hygiene on retry (fake adapter, zero tokens)", () => {
  test("under-threshold same-channel gate retry resumes with failure feedback", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 500 });
    const originalResume = fake.resumeCommand.bind(fake);
    const resumes: { sessionId: string; prompt: string }[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumes.push({ sessionId, prompt: readFileSync(promptFile, "utf8") });
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-resume", driver: interactiveDriver() });

    expect(s.done).toEqual(["T1"]);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.sessionId).toContain("-a0-");
    expect(resumes[0]!.prompt).toContain("Previous attempt failed gates");
    expect(resumes[0]!.prompt).toContain("evidence:");
    const dispatches = Journal.open(repo, "run-sess-resume").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "resume"]);
    expect(Journal.open(repo, "run-sess-resume").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("resume");
  }, 30_000);

  test("over-threshold prior attempt dispatches fresh and journals session-reset with token count", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        // attempt 0: finishes (trailer) but commits nothing → evidence gate fails → ladder retry
        { shell: "true", result: { ok: true, summary: "bloated nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "fresh retry" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 50_000 });
    const originalResume = fake.resumeCommand.bind(fake);
    const resumed: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumed.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const inner = new SubprocessDriver();
    let polls = 0;
    const driver = {
      id: "interactive-ctx-retry",
      interactive: true,
      status: async () => "unknown",
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      // Force a poll slice so sampleContext can fire on attempt 0 before the trailer is accepted.
      async waitOutput(slot: { id: string; name: string; cwd: string }, pattern: string, timeoutMs: number, opts?: { regex?: boolean }) {
        polls++;
        if (polls === 1) return false; // first slice: sample high context, no trailer yet
        return inner.waitOutput(slot, pattern, timeoutMs, opts);
      },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-reset", driver });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-sess-reset").read();
    const samples = evs.filter((e) => e.event === "context-sample" && e.taskId === "T1");
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[0]!.data.tokens).toBe(50_000);
    // session-reset at the retry boundary, naming the measured over-threshold count
    const resets = evs.filter((e) => e.event === "session-reset" && e.taskId === "T1");
    expect(resets).toHaveLength(1);
    expect(resets[0]!.data.tokens).toBe(50_000);
    expect(resets[0]!.data.threshold).toBe(1000);
    expect(resets[0]!.data.attempt).toBe(1); // the fresh attempt about to dispatch
    // reset is journaled before the retry's task-dispatch (retry-boundary, not mid-attempt)
    const resetIdx = evs.findIndex((e) => e.event === "session-reset" && e.taskId === "T1");
    const dispatch1Idx = evs.findIndex((e) => e.event === "task-dispatch" && e.taskId === "T1" && e.data.attempt === 1);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(dispatch1Idx).toBeGreaterThan(resetIdx);
    // two dispatches — attempt 1 is the fresh session (new nonce/slot; no resume of the bloated one)
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
    expect(resumed).toHaveLength(0);
    expect(Journal.open(repo, "run-sess-reset").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("fresh");
  }, 30_000);

  test("an adapter without resumeCommand keeps an under-threshold retry fresh", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "fresh ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 500 });
    fake.resumeCommand = undefined;

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-no-hook", driver: interactiveDriver() });

    expect(s.done).toEqual(["T1"]);
    const dispatches = Journal.open(repo, "run-sess-no-hook").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
    expect(Journal.open(repo, "run-sess-no-hook").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("fresh");
  }, 30_000);

  test("with no context data recorded, retry dispatch is unchanged from current behavior", async () => {
    // Default fake.contextUsage → null (unknown). No context-sample, no session-reset; retry is today.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } }, // evidence fails → retry
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "retry ok" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-sess-none" });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-sess-none").read();
    expect(evs.some((e) => e.event === "session-reset")).toBe(false);
    expect(evs.some((e) => e.event === "context-sample")).toBe(false);
    expect(evs.some((e) => e.event === "escalation" && e.data.step === "retry")).toBe(true);
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches).toHaveLength(2);
    for (const d of dispatches) {
      expect(Object.keys(d.data).sort()).toEqual(["assignment", "attempt", "provenance", "retryMode"]);
      expect(d.data.retryMode).toBe("fresh");
    }
  });

  // v1.24 T1 / OBS-20: consult reroute can ban a whole adapter via the existing tried-list (D-03).
  // Two-adapter fleet — cursor-agent ships two models (the OBS-20 shape); fake is the escape hatch
  // and also judge/consult. Per-adapter attempt counters mean separate scripts per instance.
  test("OBS-20: consult excludeAdapter bans every channel of that adapter on the next dispatch", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1", {
        // pin to cursor-agent; escalate:false so the ladder hits consult before another model is tried
        // (otherwise escalate would already leave the first model before the exclusion can prove itself)
        routingHints: { pin: { via: "cursor-agent", model: "composer" }, escalate: false },
      })],
      {
        consult: { action: "reroute", notes: "trust dialog blocks the CLI", excludeAdapter: "cursor-agent" },
        tasks: {
          // cursor-agent instance: two evidence fails → retry → consult
          T1: [
            { shell: "true", result: { ok: true, summary: "nothing 1" } },
            { shell: "true", result: { ok: true, summary: "nothing 2" } },
          ],
        },
      },
    );
    // fake adapter script: first (and only) attempt succeeds after the adapter-scoped reroute
    const fakeScript = join(tmpdir(), `tickmarkr-fake-esc-${Date.now()}.json`);
    writeFileSync(fakeScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "reroute", notes: "trust dialog blocks the CLI", excludeAdapter: "cursor-agent" },
      tasks: {
        T1: [{ shell: `echo ok > f.txt && ${COMMIT} ok`, result: { ok: true, summary: "escaped cursor" } }],
      },
    }));

    // cursor models are both `sub` so channel-level nextChannel prefers composer-2.5 over fake (`api`)
    // — that is the OBS-20 failure mode the exclusion must prevent.
    const cursor = new NamedFake(scriptPath, "cursor-agent", ["composer", "composer-2.5"], "cursor", "sub");
    const fake = new NamedFake(fakeScript, "fake", ["fake-1"], "fake-a", "api");
    const s = await runDaemon(repo, { adapters: [cursor, fake], runId: "run-obs20-excl" });
    expect(s.done).toEqual(["T1"]);

    const evs = Journal.open(repo, "run-obs20-excl").read();
    const verdict = evs.find((e) => e.event === "consult-verdict" && e.taskId === "T1");
    expect(verdict?.data).toMatchObject({ action: "reroute", excludeAdapter: "cursor-agent" });

    const dispatches = evs
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1")
      .map((e) => e.data.assignment as { adapter: string; model: string });
    // first two on cursor-agent:composer (initial + retry); post-consult must leave the adapter entirely
    expect(dispatches[0]).toMatchObject({ adapter: "cursor-agent", model: "composer" });
    expect(dispatches[1]).toMatchObject({ adapter: "cursor-agent", model: "composer" });
    const postConsult = dispatches.slice(2);
    expect(postConsult.length).toBeGreaterThanOrEqual(1);
    // OBS-20 invariant: reroute away from cursor-agent can never land on another cursor-agent model
    expect(postConsult.every((a) => a.adapter !== "cursor-agent")).toBe(true);
    expect(postConsult.some((a) => a.adapter === "fake")).toBe(true);
    // specifically never the second model that pre-v1.24 nextChannel would have preferred
    expect(dispatches.some((a) => a.model === "composer-2.5")).toBe(false);
  });

  test("v1.24: adapter exclusion is task-scoped — a sibling task can still use the excluded adapter", async () => {
    const { repo, scriptPath } = setupRepo(
      [
        T("T1", { routingHints: { pin: { via: "cursor-agent", model: "composer" }, escalate: false } }),
        // T2 depends on T1 so it starts after T1's exclusion fired — still free to pin cursor-agent
        T("T2", { deps: ["T1"], routingHints: { pin: { via: "cursor-agent", model: "composer-2.5" } } }),
      ],
      {
        consult: { action: "reroute", notes: "ban cursor for T1 only", excludeAdapter: "cursor-agent" },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "n1" } },
            { shell: "true", result: { ok: true, summary: "n2" } },
          ],
          // T2 runs on the cursor-agent instance — first step succeeds
          T2: [{ shell: `echo t2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2 on cursor" } }],
        },
      },
    );
    const fakeScript = join(tmpdir(), `tickmarkr-fake-scope-${Date.now()}.json`);
    writeFileSync(fakeScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "reroute", notes: "ban cursor for T1 only", excludeAdapter: "cursor-agent" },
      tasks: {
        T1: [{ shell: `echo t1 > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 escaped" } }],
      },
    }));

    const cursor = new NamedFake(scriptPath, "cursor-agent", ["composer", "composer-2.5"], "cursor", "sub");
    const fake = new NamedFake(fakeScript, "fake", ["fake-1"], "fake-a", "api");
    const s = await runDaemon(repo, { adapters: [cursor, fake], runId: "run-excl-scope", concurrency: 1 });
    expect(s.done).toEqual(["T1", "T2"]);

    const evs = Journal.open(repo, "run-excl-scope").read();
    const t2 = evs
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T2")
      .map((e) => e.data.assignment as { adapter: string; model: string });
    // T2 still routes to the adapter T1 banned — exclusion is per-task tried-list, not run-global
    expect(t2.length).toBeGreaterThanOrEqual(1);
    expect(t2[0].adapter).toBe("cursor-agent");
    expect(t2[0].model).toBe("composer-2.5");
  });

  test("v1.24: unknown excludeAdapter degrades to channel-level reroute (no crash, not human)", async () => {
    // Unknown adapter id → zero tried expansion → ordinary nextChannel over the current channel only.
    // With escalate:false and two cursor models + fake, post-consult lands on composer-2.5 (same adapter).
    const { repo, scriptPath } = setupRepo(
      [T("T1", { routingHints: { pin: { via: "cursor-agent", model: "composer" }, escalate: false } })],
      {
        consult: { action: "reroute", notes: "typo'd adapter", excludeAdapter: "not-a-real-adapter" },
        tasks: {
          T1: [
            { shell: "true", result: { ok: true, summary: "n1" } },
            { shell: "true", result: { ok: true, summary: "n2" } },
            // third dispatch (post-consult, still on cursor-agent:composer-2.5) succeeds on cursor instance
            { shell: `echo ok > f.txt && ${COMMIT} ok`, result: { ok: true, summary: "same-adapter model" } },
          ],
        },
      },
    );
    const fakeScript = join(tmpdir(), `tickmarkr-fake-unk-${Date.now()}.json`);
    writeFileSync(fakeScript, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
      review: { approve: true, issues: [] },
      consult: { action: "reroute", notes: "typo'd adapter", excludeAdapter: "not-a-real-adapter" },
      tasks: { T1: [{ shell: "true", result: { ok: true, summary: "unused" } }] },
    }));

    const cursor = new NamedFake(scriptPath, "cursor-agent", ["composer", "composer-2.5"], "cursor", "sub");
    const fake = new NamedFake(fakeScript, "fake", ["fake-1"], "fake-a", "api");
    const s = await runDaemon(repo, { adapters: [cursor, fake], runId: "run-excl-unknown" });
    expect(s.done).toEqual(["T1"]);
    expect(s.human).toEqual([]); // never silently forced to human

    const dispatches = Journal.open(repo, "run-excl-unknown").read()
      .filter((e) => e.event === "task-dispatch" && e.taskId === "T1")
      .map((e) => e.data.assignment as { adapter: string; model: string });
    // channel-level only: post-consult stays on cursor-agent (composer-2.5) — the OBS-20 failure mode
    // when exclusion is absent/unknown. Proves we did NOT ban the whole adapter on a bad name.
    expect(dispatches.some((a) => a.adapter === "cursor-agent" && a.model === "composer-2.5")).toBe(true);
  });

  // v1.24 T2 / OBS-18: approve of an attempt-cap park must grant a fresh attempt budget so resume
  // dispatches instead of re-parking in the same tick. Tried-list survives — a channel burned before
  // the park is not re-tried first. Journal is seeded (10 dispatches at cap) so the suite stays zero-token.
  test("OBS-18: approve of attempt-cap park + resume dispatches with fresh budget, keeps tried", async () => {
    const fake1 = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "post-release done" } }] } },
    );

    // seed: 10 dispatches (attempt cap), first channel burned, last on fake-2, then park at cap
    const j = Journal.create(repo, "run-obs18-cap");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    for (let i = 0; i < 9; i++) j.append("task-dispatch", "T1", { assignment: fake1, attempt: i });
    j.append("consult-verdict", "T1", { action: "reroute", notes: "ban fake-1" });
    j.append("task-dispatch", "T1", { assignment: fake2, attempt: 9 });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "attempt-cap" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    // without release: resume would re-park — pin the bug shape via replay (attempts ≥ 10)
    expect(Journal.open(repo, "run-obs18-cap").replayResumeState().get("T1")!.attempts).toBe(10);

    // real approve command stamps release:attempt-cap
    await approve(["run-obs18-cap", "T1", "--by", "test"], repo);
    const approved = Journal.open(repo, "run-obs18-cap").read().find((e) => e.event === "task-approved")!;
    expect(approved.data.release).toBe("attempt-cap");
    expect(Journal.open(repo, "run-obs18-cap").replayResumeState().get("T1")!.attempts).toBe(0);
    expect(Journal.open(repo, "run-obs18-cap").replayResumeState().get("T1")!.tried).toEqual([
      "fake:fake-1",
      "fake:fake-2",
    ]);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs18-cap", resume: true });
    expect(s.done).toEqual(["T1"]); // RED on HEAD: re-parks as human in the same tick
    expect(s.human).toEqual([]);

    const all = Journal.open(repo, "run-obs18-cap").read();
    const resumeIdx = all.findIndex((e) => e.event === "run-resume");
    const post = all.slice(resumeIdx + 1);
    // no re-park at the attempt cap
    expect(post.some((e) => e.event === "task-human" && /attempt cap/.test(String(e.data.reason ?? "")))).toBe(false);
    const restores = post.filter((e) => e.event === "resume-restore" && e.taskId === "T1");
    expect(restores).toHaveLength(1);
    expect((restores[0]!.data as { attempts: number }).attempts).toBe(0); // fresh budget
    expect((restores[0]!.data as { tried: string[] }).tried).toEqual(["fake:fake-1", "fake:fake-2"]);

    const dispatches = post.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    expect((dispatches[0]!.data as { attempt: number }).attempt).toBe(0);
    // burned channels not re-tried first: both fake-1 and fake-2 are in tried ⇒ nextChannel null
    // falls back to static route (fake-1). That is the ponytail ceiling when the ladder is fully
    // burned — the invariant we pin is "tried survived" (above) and "dispatched" (done), not that
    // a third channel exists. When only one of two is burned, nextChannel skips it:
    // re-seed with only fake-1 burned for the skip oracle below.
  });

  test("OBS-18: released task does not re-try a burned channel first", async () => {
    // only fake-1 burned; fake-2 free — post-release nextChannel must skip fake-1
    const fake1 = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "escaped burned" } }] } },
    );
    const j = Journal.create(repo, "run-obs18-tried");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    for (let i = 0; i < 10; i++) j.append("task-dispatch", "T1", { assignment: fake1, attempt: i });
    j.append("task-human", "T1", { reason: "attempt cap (10) reached", kind: "attempt-cap" });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    await approve(["run-obs18-tried", "T1", "--by", "test"], repo);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs18-tried", resume: true });
    expect(s.done).toEqual(["T1"]);

    const all = Journal.open(repo, "run-obs18-tried").read();
    const resumeIdx = all.findIndex((e) => e.event === "run-resume");
    const post = all.slice(resumeIdx + 1);
    const first = post.find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
    const a = first.data.assignment as { adapter: string; model: string };
    // tried = [fake:fake-1]; lastAssignment cleared by release ⇒ nextChannel skips fake-1 ⇒ fake-2
    expect(`${a.adapter}:${a.model}`).toBe("fake:fake-2");
    // resume-restore seeds attempts:0 + the burned list; the chosen assignment is then appended
    // (pre-kill invariant: tried always contains the current assignment)
    const rd = post.find((e) => e.event === "resume-restore")!.data as { tried: string[]; attempts: number };
    expect(rd.attempts).toBe(0);
    expect(rd.tried[0]).toBe("fake:fake-1"); // burned channel remembered first — never forgotten
    expect(rd.tried).toContain("fake:fake-2"); // current (post-release) assignment also present
  });
});


// v1.53 T3: kimi resume through the daemon retry seam — adapter-declared session-id capture
// (sessionIdFrom) replaces the slot-name retry id, and the adapter-declared unknown-context opt-in
// (resumeUnknownContext) is what lets a contextUsage-less adapter (kimi, KIMI-03) resume at all.
// The fake is configured with kimi's exact declaration shape; kimiSessionId is the real capture fn.
describe("v1.53 kimi resume at the daemon retry seam (fake adapter, zero tokens)", () => {
  const KIMI_TRAILER = "To resume this session: kimi -r session_25e8efca-cc09-4dd6-9dee-1951aec28581";

  test("a captured session id replaces the slot name in the stored retry session", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        // attempt 0 echoes the kimi resume trailer, finishes, but commits nothing → evidence gate fails
        { shell: `echo ${shq(KIMI_TRAILER)}`, result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    fake.contextUsage = () => ({ tokens: 500 }); // known under threshold — existing eligibility path
    fake.sessionIdFrom = kimiSessionId;
    const originalResume = fake.resumeCommand.bind(fake);
    const resumes: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumes.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-kimi-capture", driver: interactiveDriver() });
    expect(s.done).toEqual(["T1"]);
    // the retry carried the id captured from attempt 0's output — not the harness slot name
    expect(resumes).toEqual(["session_25e8efca-cc09-4dd6-9dee-1951aec28581"]);
  }, 30_000);

  test("a gate-failed kimi retry on the same channel dispatches the resume command", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: `echo ${shq(KIMI_TRAILER)}`, result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
    );
    // kimi's declaration shape: no contextUsage surface (KIMI-03), resume + capture + opt-in declared
    fake.contextUsage = undefined;
    fake.sessionIdFrom = kimiSessionId;
    fake.resumeUnknownContext = true;
    const originalResume = fake.resumeCommand.bind(fake);
    const resumes: string[] = [];
    fake.resumeCommand = (sessionId, promptFile, model) => {
      resumes.push(sessionId);
      return originalResume(sessionId, promptFile, model);
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-kimi-resume", driver: interactiveDriver() });
    expect(s.done).toEqual(["T1"]);
    expect(resumes).toEqual(["session_25e8efca-cc09-4dd6-9dee-1951aec28581"]); // resume command dispatched once
    const dispatches = Journal.open(repo, "run-kimi-resume").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.map((e) => e.data.retryMode)).toEqual(["fresh", "resume"]);
    expect(Journal.open(repo, "run-kimi-resume").readTelemetry().find((r) => r.taskId === "T1")!.retryMode).toBe("resume");
  }, 30_000);

  test("an adapter without the unknown context declaration still requires a known under threshold context to resume", async () => {
    // Unknown context + resumeCommand but NO resumeUnknownContext ⇒ both dispatches stay fresh.
    const noDecl = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "fresh ok" } },
      ] } },
    );
    noDecl.fake.contextUsage = undefined; // context unknowable, declaration absent
    const freshResumes: string[] = [];
    const originalNoDecl = noDecl.fake.resumeCommand.bind(noDecl.fake);
    noDecl.fake.resumeCommand = (sessionId, promptFile, model) => {
      freshResumes.push(sessionId);
      return originalNoDecl(sessionId, promptFile, model);
    };
    const s1 = await runDaemon(noDecl.repo, { adapters: [noDecl.fake], runId: "run-no-decl", driver: interactiveDriver() });
    expect(s1.done).toEqual(["T1"]);
    expect(freshResumes).toEqual([]); // never resumed without a known context
    const d1 = Journal.open(noDecl.repo, "run-no-decl").read().filter((e) => e.event === "task-dispatch");
    expect(d1.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);

    // Same declaration-less adapter WITH a known under-threshold context still resumes (unchanged v1.29 path).
    const known = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "true", result: { ok: true, summary: "nothing" } },
        { shell: `echo ok > a.txt && ${COMMIT} a`, result: { ok: true, summary: "resumed ok" } },
      ] } },
      "contextWarnTokens: 1000\n",
    );
    known.fake.contextUsage = () => ({ tokens: 500 });
    const s2 = await runDaemon(known.repo, { adapters: [known.fake], runId: "run-known-ctx", driver: interactiveDriver() });
    expect(s2.done).toEqual(["T1"]);
    const d2 = Journal.open(known.repo, "run-known-ctx").read().filter((e) => e.event === "task-dispatch");
    expect(d2.map((e) => e.data.retryMode)).toEqual(["fresh", "resume"]);
  }, 60_000);
});


// v1.25 T1: trust-dialog auto-answer is journaled (taskId + slot + adapter) so a live run proves the
// dialog appeared and was answered. Control flow (once-per-slot latch, sendKey, no-page) unchanged.
describe("v1.25 trust-auto-answer journal (fake adapter, zero tokens)", () => {
  test("matching trust dialog journals exactly one trust-auto-answer and does not page the operator", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [{ shell: "true", result: { ok: true, summary: "done after trust" } }],
        },
        consult: { action: "human", notes: "ok" },
      },
      "taskTimeoutMinutes: 0.2\n",
    );
    const dialog = { fingerprint: "Workspace Trust Required", key: "Enter" };
    (fake as { trustDialog?: typeof dialog }).trustDialog = dialog;

    let phase: "dialog" | "working" = "dialog";
    let nonce = "";
    const keys: string[] = [];
    const notified: string[] = [];
    const inner = new SubprocessDriver();
    let answeredSlot = "";

    const driver = {
      id: "trust-scripted",
      interactive: true,
      slot: async (cwd: string, name: string) => ({ id: "p1", name, cwd }),
      run: async (_s: { id: string; name: string; cwd: string }, cmd: string) => {
        // v1.62 T1: the delivered line is a nonce-free script invocation — the trailer lives in the script
        const p = /^bash '(.+)'$/.exec(cmd)?.[1];
        const m = p ? /TICKMARKR_RESULT_([0-9a-z]+)/i.exec(readFileSync(p, "utf8")) : null;
        if (m) nonce = m[1];
      },
      waitOutput: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return phase === "working";
      },
      waitAgentStatus: async () => true,
      read: async () => {
        if (phase === "dialog") return "Workspace Trust Required\nTrust this folder?";
        return `working\nTICKMARKR_RESULT_${nonce} {"ok":true,"summary":"done after trust","deviations":[]}\n`;
      },
      status: async () => (phase === "dialog" ? "blocked" : "working"),
      sendKey: async (s: { id: string; name: string; cwd: string }, key: string) => {
        keys.push(key);
        answeredSlot = s.name; // the slot the daemon auto-answered — journal must name this exact pane
        phase = "working";
      },
      notify: async (msg: string) => { notified.push(msg); },
      close: async () => {},
      worktree: inner.worktree.bind(inner),
    };

    await runDaemon(repo, { adapters: [fake], runId: "run-trust-journal", driver });
    expect(keys).toEqual(["Enter"]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);

    const events = Journal.open(repo, "run-trust-journal").read().filter((e) => e.event === "trust-auto-answer");
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe("T1");
    expect(events[0]!.data.adapter).toBe("fake");
    expect(events[0]!.data.slot).toBe(answeredSlot);
    expect(answeredSlot).toMatch(/T1-worker-fake-/);
  }, 30_000);

  test("a run with no trust dialog journals zero trust-auto-answer events", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-no-trust-journal" });
    expect(s.done).toEqual(["T1"]);
    const events = Journal.open(repo, "run-no-trust-journal").read().filter((e) => e.event === "trust-auto-answer");
    expect(events).toHaveLength(0);
  });

  describe("OBS-28 run-end worktree cleanup", () => {
    test("a green run-end leaves zero worktrees for that runId under the state dir", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2", { deps: ["T1"] })],
        { tasks: {
          T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
          T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
        } },
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-wt-green" });
      expect(s.done).toEqual(["T1", "T2"]);
      expect(runWorktreeDirs(repo, s.branch)).toEqual([]);
    });

    test("with visibility.keepPanes: forever, run-end removes nothing", async () => {
      const { repo, fake } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
        "visibility:\n  keepPanes: forever\n",
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-wt-forever" });
      expect(s.done).toEqual(["T1"]);
      expect(runWorktreeDirs(repo, s.branch)).toEqual([
        sanitizeBranch(s.branch),
        `${sanitizeBranch(s.branch)}--T1`,
      ]);
      expect(existsSync(worktreePath(repo, s.branch))).toBe(true);
      expect(existsSync(worktreePath(repo, `${s.branch}--T1`))).toBe(true);
    });

    test("a run ending with a failed/blocked task keeps that task's worktree and removes only merged-done ones", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2")],
        {
          consult: { action: "human", notes: "conflicting edits need a person" },
          tasks: {
            // Keep both worktrees based on the same integration tip, but make the first merge
            // deterministic under full-suite load so this remains a cleanup oracle, not a race.
            T1: [{ shell: `sleep 0.2 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 1.2 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
          },
        },
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-wt-partial" });
      expect(s.done).toHaveLength(1);
      expect(s.human).toHaveLength(1);
      const doneId = s.done[0]!;
      const parkedId = s.human[0]!;
      expect(runWorktreeDirs(repo, s.branch)).toEqual([
        sanitizeBranch(s.branch),
        `${sanitizeBranch(s.branch)}--${parkedId}`,
      ]);
      expect(existsSync(worktreePath(repo, s.branch))).toBe(true);
      expect(existsSync(worktreePath(repo, `${s.branch}--${doneId}`))).toBe(false);
      expect(existsSync(worktreePath(repo, `${s.branch}--${parkedId}`))).toBe(true);
    });

    test("resume of a prior run whose worktrees were cleaned re-creates what it needs and completes", async () => {
      const { repo, fake, scriptPath } = setupRepo(
        [T("T1"), T("T2")],
        {
          consult: { action: "human", notes: "conflicting edits need a person" },
          tasks: {
            T1: [{ shell: `sleep 0.3 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 0.3 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
          },
        },
      );
      const first = await runDaemon(repo, { adapters: [fake], runId: "run-wt-resume" });
      expect(first.done).toHaveLength(1);
      expect(first.human).toHaveLength(1);
      const parkedId = first.human[0]!;
      expect(existsSync(worktreePath(repo, `${first.branch}--${first.done[0]}`))).toBe(false);

      const script = JSON.parse(readFileSync(scriptPath, "utf8"));
      script.tasks[parkedId] = [{ shell: `echo fixed > other.txt && ${COMMIT} fix`, result: { ok: true, summary: "fixed" } }];
      writeFileSync(scriptPath, JSON.stringify(script));
      const graph = loadGraph(repo);
      saveGraph(repo, validateGraph({
        ...graph,
        tasks: graph.tasks.map((t) => t.id === parkedId ? { ...t, status: "pending" as const } : t),
      }));

      const resumed = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId: "run-wt-resume", resume: true });
      expect(resumed.done.sort()).toEqual(["T1", "T2"]);
      expect(runWorktreeDirs(repo, resumed.branch)).toEqual([]);
    });

    test("only worktrees recorded for THIS runId are touched — never another run's", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2")],
        {
          consult: { action: "human", notes: "conflicting edits need a person" },
          tasks: {
            T1: [{ shell: `sleep 0.3 && echo A > shared.txt && ${COMMIT} ta`, result: { ok: true, summary: "ta" } }],
            T2: [{ shell: `sleep 0.3 && echo B > shared.txt && ${COMMIT} tb`, result: { ok: true, summary: "tb" } }],
          },
        },
      );
      const partial = await runDaemon(repo, { adapters: [fake], runId: "run-wt-keep" });
      expect(partial.done).toHaveLength(1);
      expect(partial.human).toHaveLength(1);
      const keptDirs = runWorktreeDirs(repo, partial.branch);
      expect(keptDirs.length).toBeGreaterThan(0);

      saveGraph(repo, validateGraph({
        version: 1,
        spec: { source: "prd", paths: ["p"], hash: "h2" },
        tasks: [T("T1")],
      }));
      const green = await runDaemon(repo, { adapters: [fake], runId: "run-wt-clean" });
      expect(green.done).toEqual(["T1"]);
      expect(runWorktreeDirs(repo, green.branch)).toEqual([]);
      expect(runWorktreeDirs(repo, partial.branch)).toEqual(keptDirs);
    });
  });

  describe("OBS-34 integration-tip verify", () => {
    const passTest = "node -e \"process.exit(0)\"";
    const failOutput = `integration tip error\n${"x".repeat(20_000)}\n`;
    const failTest = `node -e ${shq(`process.stderr.write(${JSON.stringify(failOutput)}); process.exit(1);`)}`;

    test("merged tip passing emits tip-verify events then a green run-end", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2", { deps: ["T1"] })],
        { tasks: {
          T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
          T2: [{ shell: `test -f t1.txt && echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
        } },
      );
      addGateScripts(repo, passTest);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-pass" });
      expect(s.done).toEqual(["T1", "T2"]);
      expect(s.tipVerify).toBe("passed");
      const events = Journal.open(repo, "run-tip-pass").read();
      expect(events.filter((e) => e.event === "tip-verify")).toHaveLength(1);
      expect(events.some((e) => e.event === "tip-verify-failed")).toBe(false);
      expect(readdirSync(Journal.open(repo, "run-tip-pass").dir).filter((name) => name.startsWith("tip-verify-"))).toEqual([]);
      const end = events.find((e) => e.event === "run-end");
      expect(end?.data.tipVerify).toBe("passed");
      expect(events.findIndex((e) => e.event === "tip-verify")).toBeLessThan(events.findIndex((e) => e.event === "run-end"));
    });

    test("merged tip failing emits tip-verify-failed and run-end carries tipVerify failed with last-merged task", async () => {
      const { repo, fake } = setupRepo(
        [T("T1"), T("T2", { deps: ["T1"] })],
        { tasks: {
          T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
          T2: [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
        } },
      );
      addGateScripts(repo, failTest);
      const notifies: string[] = [];
      const driver = new SubprocessDriver();
      driver.notify = async (msg) => { notifies.push(msg); };
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-fail", driver });
      expect(s.done).toEqual(["T1", "T2"]);
      expect(s.tipVerify).toBe("failed");
      expect(s.lastMergedTask).toBe("T2");
      const events = Journal.open(repo, "run-tip-fail").read();
      const fail = events.find((e) => e.event === "tip-verify-failed");
      expect(fail).toBeDefined();
      expect(fail!.data.gate).toBe("test");
      expect(fail!.data.cmd).toContain("npm run");
      expect(Array.isArray(fail!.data.fingerprints)).toBe(true);
      expect((fail!.data.fingerprints as string[]).length).toBeGreaterThan(0);
      expect(fail!.data.lastMergedTask).toBe("T2");
      const artifact = join(Journal.open(repo, "run-tip-fail").dir, "tip-verify-test.log");
      expect(readFileSync(artifact, "utf8")).toBe(`\n${failOutput}`);
      expect(fail!.data.artifact).toBe(artifact);
      const end = events.find((e) => e.event === "run-end");
      expect(end?.data.tipVerify).toBe("failed");
      expect(end?.data.lastMergedTask).toBe("T2");
      expect(notifies.some((m) => /TIP VERIFY FAILED/i.test(m) && /T2/.test(m))).toBe(true);
      expect(events.filter((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === true).length).toBeGreaterThan(0);
    });

    test("resume after tip-verify-failed re-runs tip verify only and ends green", async () => {
      const { repo, fake } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      );
      addGateScripts(repo, failTest);
      const first = await runDaemon(repo, { adapters: [fake], runId: "run-tip-resume" });
      expect(first.tipVerify).toBe("failed");
      addGateScripts(worktreePath(repo, first.branch), passTest);
      const resumed = await runDaemon(repo, { adapters: [fake], runId: "run-tip-resume", resume: true });
      expect(resumed.tipVerify).toBe("passed");
      const slice = Journal.open(repo, "run-tip-resume").read();
      const resumeIdx = slice.findIndex((e) => e.event === "run-resume");
      const afterResume = slice.slice(resumeIdx);
      expect(afterResume.some((e) => e.event === "task-dispatch")).toBe(false);
      expect(afterResume.filter((e) => e.event === "tip-verify")).toHaveLength(1);
      expect(afterResume.find((e) => e.event === "run-end")?.data.tipVerify).toBe("passed");
    });

    test("zero merged tasks skips tip verify", async () => {
      const { repo, fake } = setupRepo(
        [T("T1", { humanGate: true })],
        { tasks: {} },
      );
      addGateScripts(repo, passTest);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-tip-skip" });
      expect(s.done).toEqual([]);
      expect(s.tipVerify).toBeUndefined();
      const events = Journal.open(repo, "run-tip-skip").read();
      expect(events.some((e) => e.event === "tip-verify" || e.event === "tip-verify-failed")).toBe(false);
      expect(events.find((e) => e.event === "run-end")?.data.tipVerify).toBeUndefined();
    });
  });
});


// v1.39 OBS-37b: per-task timeoutMinutes overrides config taskTimeoutMinutes for that task only.
describe("per-task timeout override (OBS-37b)", () => {
  test("shorter task override times out before the config default would", async () => {
    const t0 = Date.now();
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.02 })],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "stalled" } },
      "taskTimeoutMinutes: 5\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-short" });
    expect(s.human).toEqual(["T1"]);
    expect(Date.now() - t0).toBeLessThan(5_000); // config default 5m would not fire this fast
    const row = Journal.open(repo, "run-timeout-short").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.overrun).toBe(true);
  }, 30_000);

  test("longer task override completes when config default would have timed out", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.15 })],
      { tasks: { T1: [{ shell: `sleep 3 && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "slow but ok" } }] } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: print\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-long" });
    expect(s.done).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-timeout-long").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(true);
  }, 30_000);

  test("tasks without override keep config-default timeout behavior", async () => {
    const t0 = Date.now();
    const { repo, fake } = setupRepo(
      [T("T1", { timeoutMinutes: 0.02 }), T("T2")],
      {
        tasks: {
          T1: [{ shell: "sleep 30" }],
          T2: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "default window" } }],
        },
        consult: { action: "human", notes: "stalled" },
      },
      "taskTimeoutMinutes: 5\nvisibility:\n  worker: print\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-timeout-default" });
    expect(s.human).toEqual(["T1"]);
    expect(s.done).toEqual(["T2"]);
    expect(Date.now() - t0).toBeLessThan(8_000); // T1 short override; T2 uses 5m default and finishes quickly
  }, 30_000);

  test("OBS-58: a retry worktree recreation carries a prior attempt's cleanly-applying commit forward", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: `echo carried > kept.txt && ${COMMIT} carry && echo 'usage limit reached for this model'; exit 1` },
        { shell: `test -f kept.txt && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-obs58-carry" });
    expect(s.done).toEqual(["T1"]);
    const recreation = Journal.open(repo, "run-obs58-carry").read().find((e) => e.event === "worktree-recreation");
    expect(recreation).toBeDefined();
    expect(recreation!.data.carried).toEqual(recreation!.data.attempted);
    expect((recreation!.data.carried as string[]).length).toBe(1);
  });

  test("OBS-58: the retry brief names prior attempt commits by hash", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: `echo carried > kept.txt && ${COMMIT} carry && echo 'usage limit reached for this model'; exit 1` },
        { shell: `test -f kept.txt && echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const runId = "run-obs58-hash";
    const s = await runDaemon(repo, { adapters: [fake], runId });
    expect(s.done).toEqual(["T1"]);
    const carried = (Journal.open(repo, runId).read().find((e) => e.event === "worktree-recreation")!.data.carried as string[])[0];
    const retryPrompt = readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a1.md"), "utf8");
    expect(retryPrompt).toContain("## Prior attempt commits (by hash)");
    expect(retryPrompt).toContain(carried);
    expect(retryPrompt).toContain("— present in this worktree");
  });

  test("OBS-58: a brief premise asserting a commit that the fresh worktree lacks is corrected before dispatch", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [
          { shell: `echo v1 > impl.txt && ${COMMIT} impl && sleep 30` },
          { shell: `echo v2 > impl.txt && ${COMMIT} done`, result: { ok: true, summary: "ok" } },
        ] },
        consult: { action: "retry", guidance: "The src implementation is already committed — verify and emit the trailer." },
      },
      "taskTimeoutMinutes: 0.005\n",
    );
    const inner = new SubprocessDriver();
    const runId = "run-obs58-premise";
    const intBranch = `tickmarkr/${runId}`;
    let closed = 0;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      async close(slot: { id: string; name: string; cwd: string }) {
        await inner.close(slot);
        if (++closed === 1) {
          const intWt = worktreePath(repo, intBranch);
          writeFileSync(join(intWt, "impl.txt"), "conflict\n");
          await shOk(`git add impl.txt && ${COMMIT} integration-conflict`, intWt);
        }
      },
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId, driver });
    expect(s.done).toEqual(["T1"]);
    const recreation = Journal.open(repo, runId).read().find((e) => e.event === "worktree-recreation")!;
    expect(recreation.data.carried).toEqual([]);
    expect((recreation.data.attempted as string[]).length).toBeGreaterThan(0);
    const retryPrompt = readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a1.md"), "utf8");
    expect(retryPrompt).toContain("could not be carried forward");
    expect(retryPrompt).not.toMatch(/already committed/i);
  }, 30_000);
});

// ── v1.85 T3 (speed dive): retries repair with the findings in hand ────────────────────────────
// Measured losses this suite pins: 62 of 68 re-dispatches were FRESH (~20m of onboarding re-bought
// each time) and ~663m across 5 runs went to loops of normalized-identical failures.
describe("T3 retry economics (fake adapter, zero tokens)", () => {
  const evsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
  const promptOf = (repo: string, runId: string, attempt: number) =>
    readFileSync(join(tickmarkrDir(repo), "runs", runId, "prompts", `T1-a${attempt}.md`), "utf8");

  // a driver whose WORKER dispatch never registers — the OBS-253 shape: the pane wedges before the
  // agent ever runs, so the attempt dies with no worker-result at all.
  const dispatchDeathDriver = (): ExecutorDriver => {
    const inner = new SubprocessDriver();
    return {
      id: "dispatch-death",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      async run(slot: Slot, cmd: string) {
        if (slot.name.startsWith("tickmarkr:worker:") || slot.name.includes("-worker-")) {
          throw new Error("pane wedged: dispatch never registered");
        }
        await inner.run(slot, cmd);
      },
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    } as ExecutorDriver;
  };

  test("test: the third repair-eligible failure in one engagement falls back to the fresh ladder", async () => {
    // The budget is spent on the deterministic oracle, and the THIRD repair-eligible failure is a
    // REVIEW-only one — the case with its own same-channel fix retry (OBS-189). That retry is exactly
    // the round the spent budget declared too expensive to repeat, so the ladder must own it: a
    // fixture made only of oracle failures would leave that override untested.
    // Each round's failure carries different assertion content, so the failures stay repair-eligible
    // without tripping the normalized-identical fingerprint cap (the other half of this seam, below).
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "cat marker.txt; test -f pass.txt" }] })],
      {
        review: {
          approve: false,
          findings: [{ note: "`applyMarker` in src/mark.ts writes the wrong column", severity: "material" }],
        },
        consult: { action: "human", notes: "the ladder ran out" },
        tasks: { T1: [
          { shell: `echo one > marker.txt && ${COMMIT} m1`, result: { ok: true, summary: "a0" } },
          { shell: `echo two > marker.txt && ${COMMIT} m2`, result: { ok: true, summary: "a1" } },
          // the oracle is satisfied from here on, so REVIEW becomes the only failing gate
          { shell: `echo three > marker.txt && touch pass.txt && ${COMMIT} m3`, result: { ok: true, summary: "a2" } },
          { shell: `echo four > marker.txt && ${COMMIT} m4`, result: { ok: true, summary: "a3" } },
          { shell: `echo five > marker.txt && ${COMMIT} m5`, result: { ok: true, summary: "a4" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-repair-budget" });
    expect(s.human).toEqual(["T1"]);
    const evs = evsOf(repo, "run-repair-budget");

    // the first two failures really were repair-eligible (same narrow battery, work carried)
    const oracleFails = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "acceptance" && e.data.pass === false);
    expect(oracleFails).toHaveLength(2);
    // …and no two of them were normalized-identical, so nothing here is the fingerprint cap acting
    const shapes = new Set(oracleFails.map((e) => normalizeGateFailure(String(e.data.details))));
    expect(shapes.size).toBe(oracleFails.length);

    // exactly two repairs were funded, and exactly two dispatches carried the repair mode
    expect(evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1")).toHaveLength(2);
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches.filter((e) => e.data.retryMode === "repair")).toHaveLength(2);
    expect(dispatches[1]!.data.retryMode).toBe("repair");
    expect(dispatches[2]!.data.retryMode).toBe("repair");

    // the THIRD repair-eligible failure — review-only, the case that has its own fix retry — is
    // refused a repair AND refused that retry: the fresh ladder takes the rung instead.
    const exhausted = evs.filter((e) => e.event === "repair-exhausted" && e.taskId === "T1");
    expect(exhausted.length).toBeGreaterThanOrEqual(1);
    expect(exhausted[0]!.data.gates).toEqual(["review"]);      // …and it is the review round
    const escalations = evs.filter((e) => e.event === "escalation" && e.taskId === "T1");
    expect(escalations[0]!.data.repair).toBe(1);
    expect(escalations[1]!.data.repair).toBe(2);
    expect(escalations[2]!.data.repair).toBeUndefined();       // the fresh ladder owns this one
    expect(escalations[2]!.data.reviewFix).toBeUndefined();    // NOT the free same-channel review round
    expect(escalations[2]!.data.step).toBe("retry");           // ladder rung 0 …
    // … which it really did CONSUME: a review-fix round would have left the ladder standing at rung
    // 0 and drawn another free same-channel round instead of walking on.
    expect(escalations[3]!.data.step).toBe("escalate");

    // the ladder attempt is a FRESH brief: no diff content, no fix-only contract
    expect(promptOf(repo, "run-repair-budget", 1)).toContain("## Repair attempt");
    expect(promptOf(repo, "run-repair-budget", 2)).toContain("## Repair attempt");
    expect(promptOf(repo, "run-repair-budget", 3)).not.toContain("## Repair attempt");
    expect(promptOf(repo, "run-repair-budget", 3)).not.toContain("diff --git");
    expect(dispatches[3]!.data.retryMode).not.toBe("repair");
    // …and it still carries WHY the last attempt failed — a ladder rung is not an amnesia rung
    expect(promptOf(repo, "run-repair-budget", 3)).toContain("applyMarker");
  }, 180_000);

  test("a single failing test gate over landed commits earns a repair, though the evidence gate never ran", async () => {
    // runGates returns at the first red gate, so a failing test gate never reaches the evidence
    // stage and its commit list comes back empty. The repair decision must measure the landed work
    // itself, or the ruling's own test/lint case is unreachable by construction.
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        consult: { action: "human", notes: "unused" },
        tasks: { T1: [
          { shell: `echo boom > broken.txt && ${COMMIT} b1`, result: { ok: true, summary: "a0" } },
          { shell: `echo ok > fixed.txt && git rm -q broken.txt && ${COMMIT} b2`, result: { ok: true, summary: "a1" } },
        ] },
      },
      "gates: { test: 'test ! -f broken.txt' }\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-repair-test-gate" });
    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-repair-test-gate");

    const testFail = evs.find((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "test" && e.data.pass === false)!;
    expect(testFail).toBeDefined();
    const repairs = evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.data.gates).toEqual(["test"]);
    expect(repairs[0]!.data.commits).toBe(1); // measured from the worktree, not from runGates' output
    const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches[1]!.data.retryMode).toBe("repair");
    const prompt = promptOf(repo, "run-repair-test-gate", 1);
    expect(prompt).toContain("## Repair attempt — fix ONLY what these findings name");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("+boom");
  }, 180_000);

  test("a funded repair and a retry ban are read back from the journal, so the next dispatch keeps them across a stop", () => {
    // Both decisions govern exactly one dispatch: the next one. They are therefore journal-derived
    // rather than process-local — a stop between the decision and the dispatch (OBS-254's shape one
    // layer up) must not send a normal prompt with the findings gone, or re-run a banned assignment.
    const ev = (event: string, data: Record<string, unknown> = {}, taskId = "T1"): JournalEvent =>
      ({ ts: "2026-08-01T00:00:00.000Z", event, taskId, data });
    const funded = [ev("gate-result", { gate: "review", pass: false }), ev("repair-attempt", { findings: "review: the cap is never applied" })];
    expect(pendingRepairFindings(funded, "T1")).toBe("review: the cap is never applied");
    expect(pendingRepairFindings(funded, "T2")).toBeUndefined();                     // task-scoped
    expect(pendingRepairFindings([...funded, ev("task-dispatch")], "T1")).toBe("review: the cap is never applied"); // a dispatch that never launched keeps it
    expect(pendingRepairFindings([...funded, ev("worker-launch")], "T1")).toBeUndefined(); // spent at launch

    const capped = [ev("gate-fingerprint-cap", { gate: "acceptance", channel: "fake:fake-1" })];
    expect(activeRetryBan(capped, "T1", "fake:fake-1")).toBe("acceptance");
    expect(activeRetryBan(capped, "T1", "other:model-2")).toBeUndefined();           // channel-bound
    // and never latched: once the worker it governed has LAUNCHED, a later unrelated failure — a
    // stall, a merge conflict, a different fingerprint — is not refused under a stale ban. Expiry
    // hangs off the launch, not the pre-launch task-dispatch event: a dispatch that dies before the
    // worker starts has spent nothing, so the decision must still be there for the retry.
    expect(activeRetryBan([...capped, ev("task-dispatch")], "T1", "fake:fake-1")).toBe("acceptance");
    expect(activeRetryBan([...capped, ev("worker-launch")], "T1", "fake:fake-1")).toBeUndefined();

    // The ordinary gate-fail brief expires on the same event, for the same reason: a dispatch that
    // dies BETWEEN task-dispatch and worker-launch (readiness, setup, slot allocation) has shown the
    // worker nothing, so `--retry-failed` must still carry why the last attempt failed — and the
    // dead dispatch is itself part of that answer, not a reason to forget the rest of it.
    const gated = [
      ev("gate-result", { gate: "test", pass: false, details: "1 failed | 3 passed" }),
      ev("gate-result", { gate: "review", pass: true, details: "approved" }),
      ev("task-dispatch"),
      ev("delivery-readiness-failed", { waitedMs: 9000, transcript: "pane never came up" }),
    ];
    expect(journaledFailureBrief(gated, "T1")).toEqual([
      "test: 1 failed | 3 passed",
      "dispatch: delivery readiness failed after 9000ms; pane transcript:\npane never came up",
    ]);
    expect(journaledFailureBrief(gated, "T2")).toEqual([]);                       // task-scoped
    expect(journaledFailureBrief([...gated, ev("worker-launch")], "T1")).toEqual([]); // spent at launch
    expect(journaledFailureBrief([...gated, ev("task-approved")], "T1")).toEqual([]); // and by an approval

    // The ONE pre-launch invariant covers the terminal exception path too: task-dispatch does not
    // spend information, task-failed contributes its exact dispatch error, and only an actual launch
    // spends it. A non-dispatch task failure is not manufactured into dispatch guidance.
    const dispatchError = "Error: pane wedged: dispatch never registered";
    const died = [
      ev("task-dispatch"),
      ev("task-failed", { kind: "dispatch", error: dispatchError }),
    ];
    expect(journaledFailureBrief(died, "T1")).toEqual([`dispatch: ${dispatchError}`]);
    expect(journaledFailureBrief([...died, ev("worker-launch")], "T1")).toEqual([]);
    expect(journaledFailureBrief([
      ev("task-dispatch"),
      ev("task-failed", { kind: "gate-fail", error: dispatchError }),
    ], "T1")).toEqual([]);
  });

  test("test: every blocking review and judge result journals structured findings with class, path and symbol", async () => {
    // 1) a blocking JUDGE verdict
    const judged = setupRepo([T("T1")], {
      judge: {
        pass: false,
        criteria: [{ criterion: "c1", met: false, reason: "src/a.ts must define `parseThing`" }],
        comments: [{ path: "src/a.ts", line: 12, body: "`parseThing` is missing" }],
      },
      consult: { action: "human", notes: "judge rejected" },
      tasks: { T1: [{ shell: `echo x > x.txt && ${COMMIT} x`, result: { ok: true, summary: "x" } }] },
    });
    await runDaemon(judged.repo, { adapters: [judged.fake], runId: "run-findings-judge" });
    const judgeFail = evsOf(judged.repo, "run-findings-judge").find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "acceptance" && e.data.pass === false)!;
    expect(judgeFail).toBeDefined();
    const judgeFindings = judgeFail.data.findings as Array<Record<string, string>>;
    // exact identities, never "a string is present": class, path and symbol each name something real
    expect(judgeFindings.map((f) => f.fingerprint)).toEqual([
      "acceptance:unmet|src/a.ts|parseThing",
      "acceptance:anchored|src/a.ts|parseThing",
    ]);
    for (const f of judgeFindings) expect(f.note.length).toBeGreaterThan(0); // the judge's own bytes survive

    // 2) a blocking REVIEW verdict
    const reviewed = setupRepo([T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })], {
      review: {
        approve: false,
        findings: [{ note: "`renderRow` in src/ui/row.ts drops the last column", severity: "material" }],
        comments: [{ path: "src/ui/row.ts", line: 88, body: "off-by-one in `renderRow`" }],
      },
      consult: { action: "human", notes: "review rejected" },
      tasks: { T1: [{ shell: `echo y > y.txt && ${COMMIT} y`, result: { ok: true, summary: "y" } }] },
    });
    await runDaemon(reviewed.repo, { adapters: [reviewed.fake], runId: "run-findings-review" });
    const reviewFail = evsOf(reviewed.repo, "run-findings-review").find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === false)!;
    expect(reviewFail).toBeDefined();
    const reviewFindings = reviewFail.data.findings as Array<Record<string, string>>;
    expect(reviewFindings.map((f) => f.fingerprint)).toEqual([
      "review:material|src/ui/row.ts|renderRow",
      "review:anchored|src/ui/row.ts|renderRow",
    ]);
    for (const f of reviewFindings) expect(f.note.length).toBeGreaterThan(0); // the reviewer's own bytes survive

    // a PASSING result carries no findings — the structure exists to describe blocking ones
    const passed = evsOf(reviewed.repo, "run-findings-review").find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.pass === true)!;
    expect(passed.data.findings).toBeUndefined();

    // Rule: a finding's path is its OWN evidence path. An inline path therefore resolves; an anchor
    // belonging to another finding and the task's declared scope never substitute for a pathless row.
    // The latter fails closed as the explicit non-empty UNIDENTIFIED sentinel.
    const pathless = "✗ c2: the brief is never carried\njudge verdict pass=false";
    expect(structuredFindings("acceptance", "✗ c2: src/a.ts never carries the brief")[0])
      .toMatchObject({ class: "acceptance:unmet", path: "src/a.ts", symbol: "c2" });
    const unrelatedEvidence = structuredFindings("acceptance",
      `${pathless}\n\n## Anchored review\n- src/b.ts:42 — another finding in \`renderB\``, ["src/a.ts", "src/b.ts"]);
    expect(unrelatedEvidence.find((f) => f.class === "acceptance:unmet"))
      .toMatchObject({ path: UNIDENTIFIED, symbol: "c2" });
    expect(unrelatedEvidence.filter((f) => f.class === "acceptance:unmet")).toHaveLength(1);
    expect(unrelatedEvidence.find((f) => f.class === "acceptance:anchored"))
      .toMatchObject({ path: "src/b.ts", symbol: "renderB" });
    // a review note naming no code identity still gets a stable symbol of its own — its own words,
    // volatile tokens swept out, so the same note one line lower is still the same finding
    const bare = (line: number) => structuredFindings("review",
      `- [material] this silently drops the operator's brief, see src/run/daemon.ts:${line}`, ["src/run/daemon.ts"])[0]!;
    expect(bare(42).path).toBe("src/run/daemon.ts");
    expect(bare(42).symbol).not.toBe(UNIDENTIFIED);
    expect(bare(42).fingerprint).toBe(bare(913).fingerprint);
    // UNIDENTIFIED survives for the one residual it describes: nothing, anywhere, names a file
    expect(structuredFindings("acceptance", pathless)[0]!.path).toBe(UNIDENTIFIED);
    // the criterion id survives a rephrased reason — the same unmet criterion is the same finding
    expect(structuredFindings("acceptance", "✗ c2: put another way, nothing carries the brief", ["src/a.ts"])[0]!.fingerprint)
      .toBe(structuredFindings("acceptance", pathless, ["src/a.ts"])[0]!.fingerprint);

    // R4 identity: line numbers are EVIDENCE, not identity — the same finding one line lower keeps
    // its fingerprint, while a different symbol in the same file is a different finding.
    const at = (line: number, symbol = "renderRow") => structuredFindings("review", [
      "reviewer x:y (v): requested changes (1 material)",
      `- [material] \`${symbol}\` in src/ui/row.ts drops the last column`,
      "",
      "## Anchored review",
      `- src/ui/row.ts:${line} — off-by-one in \`${symbol}\``,
    ].join("\n"));
    expect(at(88).map((f) => f.fingerprint)).toEqual(at(412).map((f) => f.fingerprint));
    expect(at(88, "renderCell").map((f) => f.fingerprint)).not.toEqual(at(88).map((f) => f.fingerprint));
  }, 180_000);

  test("test: two normalized-identical failures of one gate on one task force a consult and ban an identical retry, with normalization proven across a fixture corpus of >=6 volatile-token classes — absolute and tmp paths, line and column numbers, durations and timestamps, ANSI styling, run and worktree identifiers, memory addresses — and a failure differing in assertion content never normalizing identical", async () => {
    // ── part 1: the corpus. Each pair differs ONLY in one class of volatile token. ──
    const corpus: Array<{ volatile: string; a: string; b: string }> = [
      {
        volatile: "absolute and tmp paths",
        a: "AssertionError: expected true to be false at /private/var/folders/9j/T/tickmarkr-repo-Ab3xY/src/run/daemon.ts",
        b: "AssertionError: expected true to be false at /tmp/tickmarkr-repo-Zq7Kd/src/run/daemon.ts",
      },
      {
        volatile: "line and column numbers",
        a: "FAIL tests/run/daemon.test.ts:412:9 — expected 3 to be 4",
        b: "FAIL tests/run/daemon.test.ts:87:31 — expected 3 to be 4",
      },
      {
        volatile: "durations",
        a: "Tests 1 failed | 146 passed (147) in 7.41s",
        b: "Tests 1 failed | 146 passed (147) in 12.02s",
      },
      {
        volatile: "timestamps",
        a: "worker-result 2026-08-01T12:21:55.109Z — no trailer",
        b: "worker-result 2026-07-31T19:29:21.884Z — no trailer",
      },
      {
        volatile: "quoted ordinary diagnostic paths",
        a: "ENOENT: no such file, open '/tmp/wt-a/src/a.ts'",
        b: "ENOENT: no such file, open '/tmp/wt-b/src/a.ts'",
      },
      {
        volatile: "absolute paths outside marker roots with the same file",
        a: "ENOENT: no such file, open '/Users/k/repo/lib/parse.js'",
        b: "ENOENT: no such file, open '/home/runner/project/pkg/parse.js'",
      },
      {
        volatile: "quoted ordinary diagnostic timestamps with offsets",
        a: "worker died at '2026-08-01T12:21:55.109+03:00' before launch",
        b: "worker died at '2026-07-31T19:29:21.884-04:00' before launch",
      },
      {
        volatile: "ANSI styling",
        a: "\u001b[31mFAIL\u001b[39m evidence: worker committed nothing",
        b: "FAIL evidence: worker committed nothing",
      },
      {
        volatile: "run and worktree identifiers",
        a: "ran in /w/tickmarkr-run-20260801-122155--T1 for run-20260801-122155 at 4d48a1163fce",
        b: "ran in /w/tickmarkr-run-20260731-192921--T1 for run-20260731-192921 at 27cf0685aa91",
      },
      {
        volatile: "memory addresses",
        a: "Segmentation fault at 0x00007ffee3b2a180 while linking node_modules",
        b: "Segmentation fault at 0x00007fb41c0e9d40 while linking node_modules",
      },
    ];
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    for (const { volatile, a, b } of corpus) {
      expect(normalizeGateFailure(a), volatile).toBe(normalizeGateFailure(b));
    }
    // the guard on the other side: assertion CONTENT is never normalized away — including content
    // that is itself path-shaped or line-shaped, which is where a naive volatile-token sweep turns
    // two different defects into one and bans a retry that was never redundant.
    const differs: Array<[string, string, string]> = [
      ["numbers", "AssertionError: expected 3 to be 4", "AssertionError: expected 3 to be 5"],
      ["exit codes", "oracle failed: $ npm test (exit 1)", "oracle failed: $ npm test (exit 2)"],
      ["symbols", "- [material] `renderRow` drops the last column", "- [material] `renderCell` drops the last column"],
      ["path-VALUED assertions", "AssertionError: expected '/api/v1/users' to be '/api/v2/orders'", "AssertionError: expected '/api/v3/carts' to be '/api/v4/items'"],
      ["unquoted path-valued assertions", "expected /api/v1/users to be /api/v2/orders", "expected /api/v3/carts to be /api/v4/items"],
      ["line-VALUED assertions", "AssertionError: expected 'src/a.ts:12' to be 'src/a.ts:34'", "AssertionError: expected 'src/a.ts:56' to be 'src/a.ts:78'"],
      ["quoted absolute paths asserted as payload",
        "AssertionError: expected '/tmp/actual-a/src/a.ts' to be '/tmp/want/src/a.ts'",
        "AssertionError: expected '/tmp/actual-b/src/a.ts' to be '/tmp/want/src/a.ts'"],
      ["which file failed", "FAIL tests/run/daemon.test.ts:412 — expected 3 to be 4", "FAIL tests/run/journal.test.ts:412 — expected 3 to be 4"],
      ["absolute paths outside the marker roots",
        "ENOENT: no such file or directory, open '/Users/k/repo/lib/parse.js'",
        "ENOENT: no such file or directory, open '/Users/k/repo/lib/render.js'"],
      // whitespace INSIDE a payload is asserted content: a collapse applied to the whole line erased
      // it, so a formatter defect and an alignment defect became one identity and banned a retry
      ["whitespace inside an asserted value", 'expected "a  b" to be "c"', 'expected "a b" to be "c"'],
      ["asserted indentation", "expected '  indented' to equal '\tindented'", "expected ' indented' to equal '\tindented'"],
    ];
    for (const [what, a, b] of differs) {
      expect(normalizeGateFailure(a), what).not.toBe(normalizeGateFailure(b));
    }
    // …and an English contraction does not open a quoted span that swallows the volatile half
    expect(normalizeGateFailure("the worker's diff at /tmp/wt-aaa/src/a.ts and the judge's verdict"))
      .toBe(normalizeGateFailure("the worker's diff at /tmp/wt-bbb/src/a.ts and the judge's verdict"));

    // ── part 2: the live seam. The same defect twice, wearing different volatile tokens. ──
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "cat boom.txt; exit 1" }] })],
      {
        consult: { action: "retry", notes: "try that again" }, // a retry verdict the ban must refuse
        tasks: { T1: [
          // attempt 0 commits nothing: the evidence gate fails and the LADDER spends its rung 0, so
          // the identical pair below is judged from a rung the ladder has already walked past — the
          // cap tests the shape of the next move, never which rung the task happens to stand on.
          { shell: "true", result: { ok: true, summary: "nothing" } },
          { shell: `printf 'expected true at /tmp/wt-1111/src/a.ts:12:3 in 1.1s\\n' > boom.txt && ${COMMIT} b1`, result: { ok: true, summary: "a1" } },
          { shell: `printf 'expected true at /tmp/wt-2222/src/a.ts:99:7 in 9.9s\\n' > boom.txt && ${COMMIT} b2`, result: { ok: true, summary: "a2" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-fingerprint-cap" });
    expect(s.human).toEqual(["T1"]);
    const evs = evsOf(repo, "run-fingerprint-cap");

    const fails = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1"
      && e.data.gate === "acceptance" && e.data.pass === false);
    expect(fails.length).toBeGreaterThanOrEqual(2);
    // the raw bytes really did differ — otherwise this fixture proves nothing about normalization
    expect(String(fails[0]!.data.details)).not.toBe(String(fails[1]!.data.details));
    expect(normalizeGateFailure(String(fails[0]!.data.details)))
      .toBe(normalizeGateFailure(String(fails[1]!.data.details)));

    // the cap fired on the second identical one, taking the round the ladder was about to buy
    const cap = evs.filter((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1");
    expect(cap).toHaveLength(1);
    expect(cap[0]!.data.gate).toBe("acceptance");
    expect(cap[0]!.data.occurrences).toBe(GATE_FINGERPRINT_CAP);
    expect(cap[0]!.data.retrySameBanned).toBe(true);
    // it forced a consult of its own, immediately, and that consult's retry verdict was refused:
    // escalation (the rung the cap spent) → consult-verdict → retry-same-banned, back to back.
    const capAt = evs.indexOf(cap[0]!);
    expect(evs.slice(capAt + 1, capAt + 4).map((e) => e.event))
      .toEqual(["escalation", "consult-verdict", "retry-same-banned"]);
    expect(evs[capAt + 2]!.data.action).toBe("retry");   // the consult DID say retry …

    // … and the ban refused an identical one: the next dispatch is a different channel, never the
    // same channel on the same brief.
    const banned = evs.filter((e) => e.event === "retry-same-banned" && e.taskId === "T1");
    expect(banned).toHaveLength(cap.length);            // every cap banned exactly one identical retry
    expect(banned.every((e) => e.data.gate === "acceptance")).toBe(true);
    expect(banned[0]!.data.to).not.toBe(banned[0]!.data.from);
    const afterBan = evs.slice(evs.indexOf(banned[0]!)).find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
    const key = (a: unknown) => `${(a as { adapter: string }).adapter}:${(a as { model: string }).model}`;
    expect(key(afterBan.data.assignment)).toBe(banned[0]!.data.to);

    // The cap SPENDS the rung the ladder would have spent rather than skipping it, so a task that
    // cannot converge still reaches exhaustion on exactly the budget it always had — the cap can
    // never hand a stuck task extra rounds. Rung 0 went to the evidence failure before any of this,
    // so the cap fired from rung 1: a mid-ladder position, not the ladder's starting one.
    const rungs = evs.filter((e) => e.event === "escalation" && e.taskId === "T1");
    expect(rungs.map((e) => e.data.step)).toEqual(["retry", "retry", "escalate", "retry", "consult", "human"]);
    expect(rungs[0]!.data.repair).toBeUndefined();       // ladder rung 0 (the evidence failure)
    expect(rungs[1]!.data.repair).toBe(1);               // a repair — it consumes no rung
    expect(rungs[2]!.data.fingerprintCap).toBe(true);    // the cap took rung 1 (escalate) and spent it
    expect(rungs[3]!.data.repair).toBe(2);               // the second and last funded repair
    // then the ladder's own end, on its own budget — the cap bought nothing extra
    expect(evs.filter((e) => e.taskId === "T1").at(-1)!.event).toBe("task-human");

    // ── and the rerouted retry still knows WHY the last attempt failed ──
    // The consult's guidance is ADDED to the brief the journal already holds, never swapped for it:
    // no retry discards information the journal already holds about the previous failure.
    const rerouted = promptOf(repo, "run-fingerprint-cap", 3);
    expect(rerouted).toContain("## Previous attempt failed gates — fix these specifically");
    expect(rerouted).toContain(String(fails[1]!.data.details));  // the journalled failure bytes …
    expect(rerouted).toContain("try that again");                // … alongside the consult guidance
  }, 180_000);

  test("a terminal cap consult vetoes an identical retry but not a rung that already changes channel", async () => {
    // Rule: a terminal cap consult vetoes a same-channel retry, but it cannot veto an `escalate`
    // rung that already satisfies the cap's ban by changing channel. These two fixtures assert both
    // directions at the boundary: retry parks; escalate continues on a different assignment.
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "cat boom.txt; exit 1" }] })],
      {
        consult: { action: "human", notes: "cannot adjudicate" }, // terminal: neither retry nor reroute
        tasks: { T1: [
          { shell: `printf 'expected true at /tmp/wt-1111/src/a.ts:12:3 in 1.1s\\n' > boom.txt && ${COMMIT} b1`, result: { ok: true, summary: "a0" } },
          { shell: `printf 'expected true at /tmp/wt-2222/src/a.ts:99:7 in 9.9s\\n' > boom.txt && ${COMMIT} b2`, result: { ok: true, summary: "a1" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-cap-terminal" });
    expect(s.human).toEqual(["T1"]);
    const evs = evsOf(repo, "run-cap-terminal");

    const cap = evs.filter((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1");
    expect(cap).toHaveLength(1);
    const capAt = evs.indexOf(cap[0]!);
    // The dangerous shape really is the one under test: rung `retry`, then a TERMINAL verdict.
    expect(evs[capAt + 1]!.data.step).toBe("retry");
    expect(evs[capAt + 1]!.data.fingerprintCap).toBe(true);
    expect(evs[capAt + 2]!.event).toBe("consult-verdict");
    expect(evs[capAt + 2]!.data.action).toBe("human");
    expect(evs[capAt + 2]!.data.capAdvisory).toBeUndefined();
    expect(evs[capAt + 3]!.event).toBe("task-human");
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    expect(evs.slice(capAt).some((e) => e.event === "retry-same-banned" && e.taskId === "T1")).toBe(false);

    const escalated = setupRepo(
      [T("T1")],
      {
        consult: { action: "human", notes: "cannot adjudicate" },
        tasks: { T1: [
          { shell: "true", result: { ok: true, summary: "no commit one" } },
          { shell: "true", result: { ok: true, summary: "no commit two" } },
          { shell: `echo fixed > fixed.txt && ${COMMIT} fixed`, result: { ok: true, summary: "different channel fixed it" } },
        ] },
      },
    );
    const moved = await runDaemon(escalated.repo, { adapters: [escalated.fake], runId: "run-cap-terminal-escalate" });
    expect(moved.done).toEqual(["T1"]);
    const movedEvents = evsOf(escalated.repo, "run-cap-terminal-escalate");
    const movedCap = movedEvents.find((e) => e.event === "gate-fingerprint-cap" && e.taskId === "T1")!;
    const movedCapAt = movedEvents.indexOf(movedCap);
    expect(movedEvents[movedCapAt + 1]!.data.step).toBe("escalate");
    expect(movedEvents[movedCapAt + 2]).toMatchObject({
      event: "consult-verdict",
      data: { action: "human", capAdvisory: true },
    });
    expect(movedEvents.slice(movedCapAt).some((e) => e.event === "task-human" && e.taskId === "T1")).toBe(false);
    const movedDispatches = movedEvents.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(movedDispatches).toHaveLength(3);
    const assignmentKey = (e: JournalEvent) => {
      const a = e.data.assignment as { adapter: string; model: string };
      return `${a.adapter}:${a.model}`;
    };
    expect(assignmentKey(movedDispatches[2]!)).not.toBe(assignmentKey(movedDispatches[1]!));
  }, 180_000);

  test("a repair is cancelled when the recreated worktree loses the commits it was funded on", async () => {
    // Repair eligibility is decided one attempt BEFORE the carry that has to hold it. When the
    // recreation drops a landed commit — a concurrently advanced integration tip, a cherry-pick
    // conflict — a fix-only contract would quote a diff whose implementation is missing and forbid
    // the worker from rebuilding the rest. The precondition is therefore re-validated after the
    // carry, and the fresh ladder owns that dispatch instead.
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "test -f pass.txt" }] })],
      {
        consult: { action: "human", notes: "a cancelled repair must not need a consult" },
        tasks: { T1: [
          { shell: `echo impl > impl.txt && ${COMMIT} impl`, result: { ok: true, summary: "a0" } },
          { shell: `touch pass.txt && ${COMMIT} pass`, result: { ok: true, summary: "a1" } },
        ] },
      },
    );
    const inner = new SubprocessDriver();
    let recreations = 0;
    const carryLosingDriver = {
      id: "carry-loss",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      async worktree(root: string, branch: string, base: string) {
        const wt = await inner.worktree(root, branch, base);
        // the RETRY's recreation lands a conflicting commit first, so cherry-picking attempt 0's
        // landed work onto it fails — the OBS-212 shape, reproduced deterministically
        if (branch.endsWith("--T1") && recreations++ === 1) {
          execSync("printf 'clobber\\n' > impl.txt && git add -A && git commit -q --no-gpg-sign -m clobber", { cwd: wt });
        }
        return wt;
      },
    } as unknown as ExecutorDriver;

    await runDaemon(repo, { adapters: [fake], runId: "run-repair-carry-loss", driver: carryLosingDriver });
    const evs = evsOf(repo, "run-repair-carry-loss");

    // the repair really was funded, and the carry really did lose the commit it was funded on
    expect(evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1")).toHaveLength(1);
    const loss = evs.find((e) => e.event === "work-loss" && e.taskId === "T1")!;
    expect(loss).toBeDefined();
    expect((loss.data.lost as string[]).length).toBeGreaterThan(0);

    // …so no fix-only prompt was built over the incomplete tree
    const cancelled = evs.filter((e) => e.event === "repair-cancelled" && e.taskId === "T1");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.data.lost).toEqual(loss.data.lost);
    expect(evs.filter((e) => e.event === "repair-dispatch" && e.taskId === "T1")).toHaveLength(0);
    const prompt = promptOf(repo, "run-repair-carry-loss", 1);
    expect(prompt).not.toContain("## Repair attempt");
    expect(prompt).not.toContain("### The work under review");
    // the launch event names what the worker actually received, not the mode intended before the carry
    const launch = evs.filter((e) => e.event === "worker-launch" && e.taskId === "T1");
    expect(launch[1]!.data.retryMode).toBe("fresh");
    // …and the retry still knows why the last attempt failed — cancelling a repair is not amnesia
    expect(prompt).toContain("## Previous attempt failed gates — fix these specifically");
    expect(prompt).toContain("oracle failed");
  }, 180_000);

  test("no retry discards information the journal already holds about why the last attempt failed", async () => {
    // One run that walks EVERY kind of re-dispatch this seam can produce — repair, repair, the fresh
    // ladder's retry, an escalate onto another channel, and a consult verdict of retry — and asserts
    // the same thing of each: the prompt reproduces the gate-result bytes the journal already holds
    // for the attempt before it. The consult round is the one that used to lose them, by replacing
    // the brief with its own guidance rather than adding to it.
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: [{ oracle: "command", command: "cat marker.txt; test -f pass.txt" }] })],
      {
        consult: { action: "retry", notes: "commit the marker file this time" },
        tasks: { T1: [
          { shell: `echo one > marker.txt && ${COMMIT} m1`, result: { ok: true, summary: "a0" } },
          { shell: `echo two > marker.txt && ${COMMIT} m2`, result: { ok: true, summary: "a1" } },
          { shell: `echo three > marker.txt && ${COMMIT} m3`, result: { ok: true, summary: "a2" } },
          { shell: `echo four > marker.txt && ${COMMIT} m4`, result: { ok: true, summary: "a3" } },
          { shell: `echo five > marker.txt && ${COMMIT} m5`, result: { ok: true, summary: "a4" } },
          { shell: `touch pass.txt && ${COMMIT} pass`, result: { ok: true, summary: "a5" } },
        ] },
      },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-no-amnesia" });
    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-no-amnesia");

    // every kind of re-dispatch really did occur in this one run
    const modes = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").map((e) => e.data.retryMode);
    expect(modes.slice(1, 3)).toEqual(["repair", "repair"]);
    const steps = evs.filter((e) => e.event === "escalation" && e.taskId === "T1").map((e) => e.data.step);
    expect(steps).toEqual(["retry", "retry", "retry", "escalate", "consult"]);
    expect(evs.filter((e) => e.event === "consult-verdict" && e.data.action === "retry")).toHaveLength(1);

    // …and not one of them dropped the failure bytes the journal was already holding
    const fails = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.pass === false);
    expect(fails).toHaveLength(5);
    fails.forEach((f, i) => {
      expect(promptOf(repo, "run-no-amnesia", i + 1), `attempt ${i + 1}`).toContain(String(f.data.details));
    });
    // the consult round carries its guidance ON TOP of them, never instead of them
    expect(promptOf(repo, "run-no-amnesia", 5)).toContain("commit the marker file this time");
  }, 180_000);

  test("test: a dispatch death before worker-result followed by retry-failed reproduces the upheld finding bytes exactly", async () => {
    const runId = "run-obs254";
    const { repo, fake } = setupRepo(
      [T("T1", { complexity: 8, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: {
          approve: false,
          findings: [{ note: "`applyBudget` in src/run/budget.ts ignores the configured cap", severity: "material" }],
          comments: [{ path: "src/run/budget.ts", line: 42, body: "cap is read but never applied in `applyBudget`" }],
        },
        consult: { action: "human", notes: "review park" },
        tasks: { T1: [{ shell: `echo v > v.txt && ${COMMIT} v`, result: { ok: true, summary: "v" } }] },
      },
    );
    // 1) the reviewer requests changes until the engagement's round cap parks the task
    const first = await runDaemon(repo, { adapters: [fake], runId });
    expect(first.human).toEqual(["T1"]);
    const upheldDetails = String([...evsOf(repo, runId)].reverse().find((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === false)!.data.details);
    expect(upheldDetails).toContain("applyBudget");

    // This is also where an identically-repeating REVIEW failure lands, and why the fingerprint cap
    // leaves that one gate to REVIEW_ROUND_CAP: the rounds here are normalized-identical, so an
    // uncapped review WOULD be the loop the cap exists to stop — but the round cap already stopped it
    // in two, and stopped it at the OPERATOR rather than at a consult. Pre-empting a strictly tighter
    // bound would trade a human decision for an LLM round, which is the trade backwards.
    const reviewFails = evsOf(repo, runId).filter((e) => e.event === "gate-result"
      && e.taskId === "T1" && e.data.gate === "review" && e.data.pass === false);
    expect(reviewFails).toHaveLength(2); // REVIEW_ROUND_CAP
    expect(new Set(reviewFails.map((e) => normalizeGateFailure(String(e.data.details)))).size).toBe(1);
    expect(evsOf(repo, runId).some((e) => e.event === "gate-fingerprint-cap")).toBe(false);

    // 2) the operator sides WITH the reviewer and funds one fixed attempt
    await approve([runId, "T1", "--by", "test", "--uphold"], repo);

    // 3) that funded attempt dies at dispatch — the dangerous case: BEFORE any worker-result
    await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: dispatchDeathDriver() });
    const afterDeath = evsOf(repo, runId);
    expect(recordedTaskFailureKind(afterDeath, "T1")).toBe("dispatch");
    const lastDispatch = afterDeath.map((e) => e.event).lastIndexOf("task-dispatch");
    expect(afterDeath.slice(lastDispatch).some((e) => e.event === "worker-result")).toBe(false);

    // a stale prompt must not be able to answer for the retry
    const promptPath = join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a0.md");
    writeFileSync(promptPath, "STALE — no dispatch happened\n");
    const dispatchesBefore = afterDeath.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length;

    // 4) the prescribed recovery
    await runDaemon(repo, { adapters: [fake], runId, resume: true, retryFailed: true });
    const evs = evsOf(repo, runId);
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1").length).toBeGreaterThan(dispatchesBefore);

    // the retry reproduces the upheld finding BYTES — never a heading over an empty section
    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt).not.toContain("STALE");
    expect(prompt).toContain("## Previous attempt failed gates — fix these specifically");
    expect(prompt).toContain("The operator UPHELD the reviewer's findings");
    expect(prompt).toContain(upheldDetails);
    expect(prompt).toContain("`applyBudget` in src/run/budget.ts ignores the configured cap");
    const dispatchError = String([...afterDeath].reverse().find((e) => e.event === "task-failed"
      && e.taskId === "T1")!.data.error);
    expect(dispatchError).toBe("Error: pane wedged: dispatch never registered");
    expect(prompt).toContain(`dispatch: ${dispatchError}`);
  }, 240_000);
});
