// OBS-1161: "Selected model is at capacity" is transient — the seat comes back in minutes. It is
// neither quota (permanent demotion for the run) nor a stall (a full window of waiting): the daemon
// waits briefly on the same seat, bounded, then fails over within the floor, and the budget lives
// in the journal so a resume continues it. A parsed verdict quoting the phrase is work, never capacity.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { CAPACITY_RE, channelKey, QUOTA_RE, type AuthHealth, type BillingChannel } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { type Slot } from "../../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../../src/graph/graph.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { resetCapacityBackoffMsForTests, resetQuotaBannerSilentMsForTests, runDaemon, setCapacityBackoffMsForTests, setQuotaBannerSilentMsForTests } from "../../../src/run/daemon.js";
import { gitHead } from "../../../src/run/git.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const BANNER = "Selected model is at capacity";
const CAPACITY_EXIT = { shell: `echo ${JSON.stringify(BANNER)}; exit 1` }; // no trailer, nonzero: a capacity exit
const okStep = (id: string, note = "ok") => ({ shell: `echo ok > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: `${note} ${id}` } });
const RETRY = { action: "retry", notes: "not a channel verdict" };
const evs = (repo: string, runId: string) => Journal.open(repo, runId).read();
const of = (all: JournalEvent[], event: string, taskId = "T1") => all.filter((e) => e.event === event && e.taskId === taskId);
const seatOf = (e: JournalEvent) => channelKey((e.data as { assignment: BillingChannel }).assignment);

// An interactive driver whose FIRST worker pane paints `text` after two benign frames and then sits
// idle — the live banner shape (tests/run/daemon/stall.test.ts quota mirror). That first worker never
// runs its step (a requeue re-dispatches the SAME attempt, and the interactive fake keys its step on
// the attempt), so the seat's recovery is the same step served to the second, real, worker.
const bannerDriver = (text: string) => {
  const inner = new SubprocessDriver();
  let workerRuns = 0;
  let reads = 0;
  return {
    id: "capacity-banner-fake",
    interactive: true,
    slot: inner.slot.bind(inner),
    run: async (slot: Slot, cmd: string) => {
      if (slot.name.includes("-worker-")) workerRuns++;
      return inner.run(slot, workerRuns === 1 && slot.name.includes("-worker-") ? "sleep 60" : cmd);
    },
    waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
      workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: (slot: Slot, lines?: number) => {
      if (slot.name.includes("-worker-") && workerRuns === 1) {
        reads++;
        return Promise.resolve(reads <= 2 ? "composing a plan for the task" : `${text}\nplease try again later`);
      }
      return inner.read(slot, lines);
    },
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
    status: async () => "working" as const,
  };
};

describe("OBS-1161: transient capacity waits briefly then fails over within the floor", () => {
  beforeEach(() => { setQuotaBannerSilentMsForTests(1_500); setCapacityBackoffMsForTests(100); });
  afterEach(() => { resetQuotaBannerSilentMsForTests(); resetCapacityBackoffMsForTests(); });

  test("test: the production daemon classifies a live idle capacity banner equivalently to a no-trailer capacity exit for bounded backoff before same-floor failover, so full-stall waiting or permanent quota demotion fails", async () => {
    expect(QUOTA_RE.test(BANNER)).toBe(false); // the whole hazard: today neither classifier owns this line
    expect(CAPACITY_RE.test(BANNER)).toBe(true);
    // live idle banner in a 5m window: finishing inside the test timeout proves the window was not waited out
    const live = setupRepo([T("T1", { timeoutMinutes: 5 })], { tasks: { T1: [okStep("T1", "recovered")] }, consult: RETRY });
    const s = await runDaemon(live.repo, { adapters: [live.fake], runId: "run-cap-live", driver: bannerDriver(BANNER) });
    expect(s.done).toEqual(["T1"]);
    const liveEvs = evs(live.repo, "run-cap-live");
    expect(of(liveEvs, "capacity-banner")).toHaveLength(1);
    expect(of(liveEvs, "capacity-requeue").map((e) => e.data)).toMatchObject([{ requeue: 1, of: 2, channel: "fake:fake-1", source: "banner", matched: BANNER }]);
    // the same seat carried it to done: no failover, no demotion, no exclusion, no stall consult
    expect(seatOf(of(liveEvs, "task-done")[0]!)).toBe("fake:fake-1");
    for (const ev of ["quota-banner", "quota-failover", "capacity-failover", "channel-demotion", "channel-exclusion", "consult", "consult-verdict"]) expect(of(liveEvs, ev)).toHaveLength(0);

    // the no-trailer capacity exit classifies identically — same row shape, same seat, only the source differs
    const exit = setupRepo([T("T1")], { tasks: { T1: [CAPACITY_EXIT, okStep("T1", "recovered")] }, consult: RETRY });
    const s2 = await runDaemon(exit.repo, { adapters: [exit.fake], runId: "run-cap-exit" });
    expect(s2.done).toEqual(["T1"]);
    const exitEvs = evs(exit.repo, "run-cap-exit");
    expect(of(exitEvs, "capacity-requeue").map((e) => e.data)).toMatchObject([{ requeue: 1, of: 2, channel: "fake:fake-1", source: "exit", matched: BANNER }]);
    expect(seatOf(of(exitEvs, "task-done")[0]!)).toBe("fake:fake-1");
    for (const ev of ["quota-failover", "capacity-failover", "channel-demotion", "channel-exclusion", "consult-verdict"]) expect(of(exitEvs, ev)).toHaveLength(0);
    // a requeue is free: the attempt ordinal is not burned
    expect(of(exitEvs, "task-dispatch").map((e) => (e.data as { attempt: number }).attempt)).toEqual([0, 0]);
  }, 120_000);

  test("test: the production daemon preserves capacity retry accounting across resume until exhaustion parks when every alternative is below floor, so restarting the retry budget or taking a weaker seat fails", async () => {
    // fleet: four frontier seats (the task floor) and one cheap seat below it
    const FRONTIER = ["fake-1", "fake-2", "fake-3", "fake-4"];
    class FloorFake extends FakeAdapter {
      override async probe(): Promise<AuthHealth> {
        const at = "1970-01-01T00:00:00.000Z";
        const models = [...FRONTIER, "fake-9"];
        return { installed: true, authed: true, version: "fake", models, modelAuth: Object.fromEntries(models.map((m) => [m, { authed: true, probedAt: at }])) };
      }
      override channels(): BillingChannel[] {
        return [
          ...FRONTIER.map((model) => ({ adapter: "fake", vendor: "fake-a", model, channel: "sub", tier: "frontier" as const })),
          { adapter: "fake", vendor: "fake-c", model: "fake-9", channel: "sub", tier: "cheap" },
        ];
      }
    }
    const repo = makeRepo({ "base.txt": "base\n" });
    saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { routingHints: { floor: "frontier" } })] }));
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
    const scriptPath = join(makeTestTempDir("tickmarkr-cap-"), "s.json");
    writeFileSync(scriptPath, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, consult: RETRY,
      tasks: { T1: [CAPACITY_EXIT, okStep("T1")] }, // capacity persists on the frontier seat; a weaker seat WOULD succeed
    }));
    const fake = new FloorFake(scriptPath);
    const seat = (model: string) => ({ adapter: "fake", model, channel: "sub", tier: "frontier" });
    // The production history a crash leaves behind: fake-1..3 each spent their budget (three dispatches,
    // two requeues, a failover) and fake-4 spent both requeues before the process died in backoff.
    // That is ELEVEN task-dispatch rows — past MAX_ATTEMPTS (10) if replay charged every one — for
    // three charged attempts, so a replay that bills the free requeues parks attempt-cap on resume.
    const runId = "run-cap-resume";
    const j = Journal.create(repo, runId);
    j.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    let ordinal = 0;
    FRONTIER.forEach((model, attempt) => {
      const channel = `fake:${model}`;
      for (const requeue of [1, 2]) {
        j.append("task-dispatch", "T1", { assignment: seat(model), attempt, workerDispatchOrdinal: ordinal++ });
        j.append("capacity-requeue", "T1", { attempt, requeue, of: 2, channel, assignment: seat(model), matched: BANNER, source: "exit", backoffMs: 100 });
      }
      if (model === "fake-4") return; // the crash: died in the second backoff, before the re-dispatch
      j.append("task-dispatch", "T1", { assignment: seat(model), attempt, workerDispatchOrdinal: ordinal++ });
      j.append("capacity-failover", "T1", { from: channel, to: `fake:${FRONTIER[attempt + 1]}`, matched: BANNER, source: "exit", requeues: 2, cause: "capacity" });
    });
    expect(of(j.read(), "task-dispatch")).toHaveLength(11);
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const before = j.read().length;

    const s = await runDaemon(repo, { adapters: [fake], runId, resume: true });
    expect(s.human).toEqual(["T1"]);
    expect(s.done).toEqual([]);
    const after = evs(repo, runId).slice(before);
    // replay charged the three spent attempts, not the eleven dispatch rows, and kept the busy seat in force
    expect(of(after, "resume-restore").map((e) => e.data)).toMatchObject([{ attempts: 3, tried: FRONTIER.map((m) => `fake:${m}`), assignment: seat("fake-4") }]);
    expect(of(after, "task-dispatch").map((e) => [seatOf(e), (e.data as { attempt: number }).attempt])).toEqual([["fake:fake-4", 3]]);
    // the budget continued at 2 of 2: no third requeue, the next capacity hit went straight to failover
    expect(of(after, "capacity-requeue")).toHaveLength(0);
    expect(of(after, "capacity-failover").map((e) => e.data)).toMatchObject([{ from: "fake:fake-4", to: null, requeues: 2, cause: "capacity" }]);
    // every alternative at the floor was spent and the cheap seat was never taken: a capacity park, not attempt-cap
    expect(of(after, "task-human").map((e) => e.data)).toMatchObject([{ kind: "quota", cause: "capacity", channel: "fake:fake-4", requeues: 2 }]);
    expect(of(after, "channel-exclusion")).toHaveLength(0);
  }, 120_000);

  test("test: the production daemon completes on a recovered original channel within its capacity budget versus bounded failover when capacity persists, so permanently excluding a transiently busy seat fails", async () => {
    // recovered: the seat answers on the second try — done on the original channel, no failover
    const recovered = setupRepo([T("T1")], { tasks: { T1: [CAPACITY_EXIT, CAPACITY_EXIT, okStep("T1", "recovered")] }, consult: RETRY });
    const s = await runDaemon(recovered.repo, { adapters: [recovered.fake], runId: "run-cap-recovered" });
    expect(s.done).toEqual(["T1"]);
    const rEvs = evs(recovered.repo, "run-cap-recovered");
    expect(of(rEvs, "capacity-requeue").map((e) => (e.data as { requeue: number }).requeue)).toEqual([1, 2]);
    expect(of(rEvs, "capacity-failover")).toHaveLength(0);
    expect(seatOf(of(rEvs, "task-done")[0]!)).toBe("fake:fake-1");

    // persists: the budget is spent, then a same-floor failover — and the busy seat stays eligible
    // for the next task (T2 depends on T1, so it routes AFTER the failover)
    const persists = setupRepo(
      [T("T1"), T("T2", { deps: ["T1"] })],
      { tasks: { T1: [CAPACITY_EXIT, CAPACITY_EXIT, CAPACITY_EXIT, okStep("T1", "on B")], T2: [okStep("T2")] }, consult: RETRY },
    );
    const s2 = await runDaemon(persists.repo, { adapters: [persists.fake], runId: "run-cap-persists" });
    expect(s2.done).toEqual(["T1", "T2"]);
    const pEvs = evs(persists.repo, "run-cap-persists");
    expect(of(pEvs, "capacity-requeue")).toHaveLength(2); // bounded: never a third wait
    expect(of(pEvs, "capacity-failover").map((e) => e.data)).toMatchObject([{ from: "fake:fake-1", to: "fake:fake-2", requeues: 2 }]);
    expect(seatOf(of(pEvs, "task-done")[0]!)).toBe("fake:fake-2");
    expect(of(pEvs, "task-dispatch").map((e) => (e.data as { attempt: number }).attempt)).toEqual([0, 0, 0, 1]); // requeues are free; the failover counts an attempt exactly as quota does
    expect(of(pEvs, "channel-exclusion")).toHaveLength(0);
    expect(of(pEvs, "channel-demotion")).toHaveLength(0);
    expect(of(pEvs, "quota-failover")).toHaveLength(0);
    // T2 lands back on the seat that was merely busy
    expect(seatOf(of(pEvs, "task-dispatch", "T2")[0]!)).toBe("fake:fake-1");
  }, 120_000);

  test("test: the production daemon treats a parsed verdict quoting capacity as work versus the same phrase in the filtered live banner as transient capacity, so raw-transcript substring failover fails", async () => {
    // a worker whose PARSED trailer quotes the phrase, with the phrase also in its transcript tail
    const quoted = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo ${JSON.stringify(BANNER)} > note.txt && cat note.txt && ${COMMIT} note`, result: { ok: true, summary: `handled: ${BANNER}` } }] } });
    const s = await runDaemon(quoted.repo, { adapters: [quoted.fake], runId: "run-cap-quoted" });
    expect(s.done).toEqual(["T1"]);
    const qEvs = evs(quoted.repo, "run-cap-quoted");
    expect(of(qEvs, "task-dispatch")).toHaveLength(1);
    for (const ev of ["capacity-banner", "capacity-requeue", "capacity-failover", "quota-failover"]) expect(of(qEvs, ev)).toHaveLength(0);
    expect((of(qEvs, "worker-result")[0]!.data as { summary: string }).summary).toContain(BANNER);

    // the phrase QUOTED in a no-trailer exit — a `>` quote and a quotation — is work evidence too: the
    // ordinary no-trailer ladder charges the attempt, and no capacity wait or failover happens
    const quotedExit = { shell: `echo ${JSON.stringify(`> ${BANNER}`)}; echo ${JSON.stringify(`the provider log said '${BANNER}'`)}; exit 1` };
    const noVerdict = setupRepo([T("T1")], { tasks: { T1: [quotedExit, okStep("T1")] }, consult: RETRY });
    const s3 = await runDaemon(noVerdict.repo, { adapters: [noVerdict.fake], runId: "run-cap-quoted-exit" });
    expect(s3.done).toEqual(["T1"]);
    const nEvs = evs(noVerdict.repo, "run-cap-quoted-exit");
    for (const ev of ["capacity-banner", "capacity-requeue", "capacity-failover", "quota-failover"]) expect(of(nEvs, ev)).toHaveLength(0);
    expect(of(nEvs, "task-dispatch").map((e) => (e.data as { attempt: number }).attempt)).toEqual([0, 1]);

    // the phrase QUOTED at the tail of an idle live pane rides the same filter and is not a banner:
    // the silence gate passes in 1.5 s, yet only the ordinary 6 s window concludes the attempt
    const quotedLive = setupRepo([T("T1", { timeoutMinutes: 0.1 })], { tasks: { T1: [okStep("T1")] }, consult: RETRY });
    const s4 = await runDaemon(quotedLive.repo, { adapters: [quotedLive.fake], runId: "run-cap-quoted-live", driver: bannerDriver(`> ${BANNER}`) });
    expect(s4.done).toEqual(["T1"]);
    const qlEvs = evs(quotedLive.repo, "run-cap-quoted-live");
    for (const ev of ["capacity-banner", "capacity-requeue", "capacity-failover", "quota-failover"]) expect(of(qlEvs, ev)).toHaveLength(0);
    expect(of(qlEvs, "task-dispatch").map((e) => (e.data as { attempt: number }).attempt)).toEqual([0, 1]);

    // the same phrase painted in the filtered live banner of an idle pane is transient capacity
    const live = setupRepo([T("T1", { timeoutMinutes: 5 })], { tasks: { T1: [okStep("T1")] }, consult: RETRY });
    const s2 = await runDaemon(live.repo, { adapters: [live.fake], runId: "run-cap-live2", driver: bannerDriver(BANNER) });
    expect(s2.done).toEqual(["T1"]);
    const lEvs = evs(live.repo, "run-cap-live2");
    expect(of(lEvs, "capacity-banner")).toHaveLength(1);
    expect(of(lEvs, "capacity-requeue")).toHaveLength(1);
    expect(of(lEvs, "quota-failover")).toHaveLength(0);
  }, 120_000);
});
