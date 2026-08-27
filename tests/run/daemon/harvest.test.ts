import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { type ExecutorDriver, type Slot } from "../../../src/drivers/types.js";
import { tickmarkrDir } from "../../../src/graph/graph.js";
import { NO_TRAILER_SUMMARY } from "../../../src/adapters/prompt.js";
import { HARVESTED_RESULT_SUMMARY, harvestCpuFlatWindowMs, NUDGEABLE_ADAPTERS, resetDeadChannelFastKillMsForTests, resetHarvestCpuFlatMsForTests, resetHarvestSilentMsForTests, resetNudgeTimingForTests, runDaemon, setDeadChannelFastKillMsForTests, setHarvestCpuFlatMsForTests, setHarvestSilentMsForTests, setNudgeTimingForTests, workerTreeCpuMs } from "../../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

// ── T2 (OBS-264): finished work is harvested, never redone ─────────────────────────────────────
// Every case here rides a worker that COMMITS and then goes quiet without a trailer — the exact
// shape of all 18 observed stalls, each of which carried 2-33 commits that the next attempt then
// re-bought at full price. The pane is frozen by construction (constant text, no exit marker ever
// seen), so the only thing that can end a wait early is the liveness triad itself.
describe("harvest: finished work is gated, never redispatched (OBS-264)", () => {
  const hdriver = (overrides: Record<string, unknown> = {}): ExecutorDriver => {
    const inner = new SubprocessDriver();
    const { useRealRead = false, ...driverOverrides } = overrides;
    return {
      id: "harvest-fake",
      interactive: true,
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: async () => { await new Promise((r) => setTimeout(r, 50)); return false; },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: useRealRead ? inner.read.bind(inner) : async () => "working-on-it",
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      status: async () => "working",
      ...driverOverrides,
    } as ExecutorDriver;
  };

  const evsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();

  // A worker that keeps burning CPU at `dutyPct` of one core. BOUNDED and self-terminating: a
  // spinner that outlives the test run it was spawned for is an orphan pegging a core forever, so
  // the burn carries its own deadline instead of trusting anything to kill it (the daemon's
  // closeSlot SIGKILLs the process group too — the deadline is the belt to that suspenders).
  // It is a GRANDCHILD of the dispatch script — the matched root's own CPU time never moves, so
  // only the probe's descendant walk can see it. Sleeping between bursts is Atomics.wait, not a
  // child `sleep`: a spawned sleep would be another process in the very tree under measurement.
  const burnFor = (ms: number, dutyPct = 100) => `node -e ${shq(
    `const idle = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + ${ms};`
    + ` while (Date.now() < end) { const s = Date.now(); while (Date.now() - s < 10) { /* burn */ }`
    + ` if (${dutyPct} < 100) Atomics.wait(idle, 0, 0, 10 * (100 - ${dutyPct}) / ${dutyPct}); }`,
  )}`;

  // Review regression: the worker's persistent shell stays almost idle while each CPU-heavy tool
  // is a short-lived child. The 800ms gaps line up with the daemon's sparse harvest observations,
  // so summing only processes alive in those observations reads flat even though a new burner runs
  // between them. A retained descendant ledger sees the CPU before each child exits.
  const burnInShortChildren = (iterations = 12) =>
    `for i in {1..${iterations}}; do node -e ${shq("const end = Date.now() + 120; while (Date.now() < end) { /* burn */ }")}; sleep 0.8; done`;

  // The managed macOS test sandbox denies `ps` even to child processes. Production and ordinary CI
  // use the live process tree; only that named environmental gap gets a deterministic snapshot
  // source with the same shape: a persistent root plus 120ms child burners that disappear between
  // the daemon's ~1s observations. The fast accountant's 100ms samples see and retain them.
  const cpuProbeFallback = async (repo: string, runId: string, mode: "flat" | "bursty" = "bursty"): Promise<() => void> => {
    if (await workerTreeCpuMs("tickmarkr-cpu-probe-capability", repo) !== undefined) return () => {};
    const dir = makeTestTempDir("tickmarkr-ps-fallback-");
    const script = join(dir, "ps.mjs");
    const bashEnv = join(dir, "bash-env");
    const state = join(dir, "state");
    const marker = join(tickmarkrDir(repo), "runs", runId, "prompts", "T1-a0.sh");
    writeFileSync(script, [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const now = Date.now();',
      'const started = existsSync(process.env.TICKMARKR_TEST_PS_STATE) ? Number(readFileSync(process.env.TICKMARKR_TEST_PS_STATE, "utf8")) : now;',
      'writeFileSync(process.env.TICKMARKR_TEST_PS_STATE, String(started));',
      'const phase = (now - started) % 1000;',
      mode === "bursty"
        ? 'const rows = [`100 1 0:00.00 ${process.env.TICKMARKR_TEST_PS_MARKER}`, "101 100 0:00.00 fake-agent"];'
        : 'const rows = ["999 1 0:00.00 unrelated-process"];',
      mode === "bursty"
        ? 'if (phase >= 400 && phase <= 700) rows.push("102 101 0:00.20 short-lived-burner");'
        : "",
      'process.stdout.write(rows.join("\\n") + "\\n");',
    ].join("\n"));
    writeFileSync(bashEnv, `ps() { node ${shq(script)}; }\n`);
    const prior = {
      bashEnv: process.env.BASH_ENV,
      marker: process.env.TICKMARKR_TEST_PS_MARKER,
      state: process.env.TICKMARKR_TEST_PS_STATE,
    };
    process.env.BASH_ENV = bashEnv;
    process.env.TICKMARKR_TEST_PS_MARKER = marker;
    process.env.TICKMARKR_TEST_PS_STATE = state;
    return () => {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("BASH_ENV", prior.bashEnv);
      restore("TICKMARKR_TEST_PS_MARKER", prior.marker);
      restore("TICKMARKR_TEST_PS_STATE", prior.state);
    };
  };

  // Both harvest seams at once. Tests that assert a CONCLUSION pin the flat window so they need not
  // sit through a real one; tests that assert a worker is NOT concluded leave it at its real,
  // resolution-derived value — pinning it there would be the fixture answering its own question.
  const withSeams = async (silentMs: number, flatMs: number | undefined, body: () => Promise<void>) => {
    setHarvestSilentMsForTests(silentMs);
    if (flatMs !== undefined) setHarvestCpuFlatMsForTests(flatMs);
    try {
      await body();
    } finally {
      resetHarvestSilentMsForTests();
      resetHarvestCpuFlatMsForTests();
    }
  };

  test("the flat-CPU window is sized against the host's own CPU-clock quantum", () => {
    // darwin `ps` prints hundredths, linux whole seconds. Equality across a window shorter than the
    // quantum is not evidence: a throttled worker accrues less than one tick per sample and reads
    // flat while working. 30 ticks of the clock in use, floored — never a fixed two seconds.
    expect(harvestCpuFlatWindowMs(10)).toBe(3_000);
    expect(harvestCpuFlatWindowMs(1_000)).toBe(30_000);
    expect(harvestCpuFlatWindowMs(1_000)).toBeGreaterThan(harvestCpuFlatWindowMs(10));
  });

  test("an absent process tree reads as zero CPU, never as an unreadable snapshot", async () => {
    // The probe's two "no number" readings are opposites, and the triad turns on telling them
    // apart: 0 means nothing of this worker is running — the strongest at-rest signal there is, and
    // what every concluded harvest actually sees — while undefined means UNMEASURABLE and is
    // journaled rather than concluded on. A marker matching no process must produce the first; were
    // it ever to produce undefined, the triad would fall silent on exactly the finished, exited
    // workers OBS-264 is about, and the feature would be gone with only a journal line to say so.
    const restoreProbe = await cpuProbeFallback(process.cwd(), "unused", "flat");
    let cpu: Awaited<ReturnType<typeof workerTreeCpuMs>>;
    try {
      const marker = `tickmarkr-no-live-process-${randomBytes(16).toString("hex")}`;
      cpu = await workerTreeCpuMs(marker, process.cwd());
    } finally {
      restoreProbe();
    }
    expect(cpu).toBeDefined();
    expect(cpu!.ms).toBe(0);
    expect([10, 1_000]).toContain(cpu!.resolutionMs); // the quantum is read off the rows, not assumed
  });

  test("test: a silent worker with commits ahead of base and a flat CPU delta is concluded and its worktree goes to gates without a redispatch", async () => {
    await withSeams(500, 200, async () => {
      // 5m stall window: if the triad did not conclude this wait, the 120s test budget would expire
      // long before the window did. The worker commits, prints no trailer, and exits — flat CPU.
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        consult: { action: "human", notes: "a harvested attempt must never reach a consult" },
        tasks: { T1: [{ shell: `echo harvested > h.txt && ${COMMIT} h` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-ok", "flat");
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-ok", driver: hdriver() });
      } finally {
        restoreProbe();
      }

      expect(s.done).toEqual(["T1"]); // gated and merged on the harvested worktree
      const evs = evsOf(repo, "run-harvest-ok");
      const concluded = evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1");
      expect(concluded).toHaveLength(1); // the triad ended the wait, not the window
      expect(concluded[0]!.data.commits).toBe(1);
      expect(concluded[0]!.data.cpuMs).toBe(0); // the worker's process tree was gone
      // the carried worktree went to gates on THIS attempt — one dispatch, no fresh worker
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.some((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "evidence" && e.data.pass === true)).toBe(true);
      expect(evs.some((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "acceptance" && e.data.pass === true)).toBe(true);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0); // no stall consult was bought
      expect(evs.findIndex((e) => e.event === "worker-harvest"))
        .toBeLessThan(evs.findIndex((e) => e.event === "gate-result"));
    });
  }, 120_000);

  test("test: a concluded harvest with failing gates falls into the existing retry ladder exactly as a trailered failure does", async () => {
    await withSeams(500, 200, async () => {
      // Same task, same red judge, same worker diff — the ONLY difference is whether the worker
      // emitted a trailer. The transcript must stay CLEAN of every pre-gate routing signature
      // (quota banner, provider outage, CLI-death text): a committed attempt whose tail carries
      // one now routes BEFORE gates by design — that precedence is pinned by the dedicated
      // routing tests below, and seeding a signature here would reroute instead of laddering.
      const red = {
        judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "not met" }] },
        consult: { action: "human", notes: "gates stayed red" },
      };
      const shell = `node -e ${shq('require("fs").appendFileSync("w.txt", `${Date.now()}-${process.pid}\\n`)')} && ${COMMIT} w`;

      const trailered = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
        ...red, tasks: { T1: [{ shell, result: { ok: true, summary: "claimed" } }] },
      });
      const claimed = await runDaemon(trailered.repo, { adapters: [trailered.fake], runId: "run-ladder-claimed" });

      const silent = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
        ...red, tasks: { T1: [{ shell }] }, // no trailer — harvested
      });
      const harvested = await runDaemon(silent.repo, { adapters: [silent.fake], runId: "run-ladder-harvested", driver: hdriver({ useRealRead: true }) });

      const ladder = (repo: string, runId: string) =>
        evsOf(repo, runId).filter((e) => e.event === "escalation").map((e) => e.data.step);
      expect(ladder(silent.repo, "run-ladder-harvested")).toEqual(ladder(trailered.repo, "run-ladder-claimed"));
      expect(ladder(silent.repo, "run-ladder-harvested")).toEqual(["retry", "escalate", "consult"]);
      expect(harvested.human).toEqual(claimed.human); // same terminal decision
      expect(harvested.human).toEqual(["T1"]);
      const parks = (repo: string, runId: string) =>
        evsOf(repo, runId).filter((e) => e.event === "task-human").map((e) => e.data.kind);
      expect(parks(silent.repo, "run-ladder-harvested")).toEqual(parks(trailered.repo, "run-ladder-claimed"));
      // every harvested attempt really was harvested — none of them was a stall consult
      expect(evsOf(silent.repo, "run-ladder-harvested").filter((e) => e.event === "worker-result-harvested")).toHaveLength(3);
      expect(evsOf(trailered.repo, "run-ladder-claimed").filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
      const assignments = (repo: string, runId: string) => evsOf(repo, runId)
        .filter((e) => e.event === "task-dispatch")
        .map((e) => e.data.assignment);
      expect(assignments(silent.repo, "run-ladder-harvested"))
        .toEqual(assignments(trailered.repo, "run-ladder-claimed"));
    });
  }, 180_000);

  test("a committed attempt that walls on quota still fails over — its commits ride the carry-forward, not a gate run", async () => {
    // T2 review (material, routing precedence): the harvest synthesis used to set ok:true and
    // finished:true BEFORE the quota branch, and the branch's `!finished` guard then made quota
    // failover unreachable for ANY harvested attempt — including one the loop already broke on a
    // journaled quota-banner. A worker that committed partial work and hit the wall bought a full
    // gate run (baseline+evidence+scope+judge+review) on throttled work, burned a ladder step
    // spec §4 says quota must not consume, and retried on the same throttled channel. The branch
    // now classifies the PRE-HARVEST outcome (workerFinished + the pre-synthesis parse): the
    // walled attempt fails over exactly like a commit-less one, and its commits survive via the
    // existing commitsToCarry/cherryPickCommits carry-forward into the next attempt's worktree.
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
      consult: { action: "human", notes: "a quota-routed attempt must never reach a consult" },
      tasks: { T1: [
        { shell: `echo partial > p.txt && ${COMMIT} p && printf '%s\\n' 'usage limit reached for this model'` }, // commits, then walls — no trailer
        { shell: "test -f p.txt", result: { ok: true, summary: "carried work verified" } },
      ] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-quota-route", driver: hdriver({ useRealRead: true }) });

    expect(s.done).toEqual(["T1"]); // the other channel carried it to done
    const evs = evsOf(repo, "run-harvest-quota-route");
    // the walled attempt's commits WERE recognized — harvest journaling is not the defect — …
    expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
    // … but the attempt routed on its PRE-HARVEST outcome instead of buying a gate run
    const failover = evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1");
    expect(failover).toHaveLength(1);
    expect(failover[0]!.data.from).not.toBe(failover[0]!.data.to);
    expect(evs.findIndex((e) => e.event === "gate-result"))
      .toBeGreaterThan(evs.findIndex((e) => e.event === "quota-failover")); // gates ran only on the failover attempt
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    // the landed commit survived the reroute through the existing carry-forward — never re-earned
    const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
    expect(recreations).toHaveLength(1);
    expect((recreations[0]!.data.attempted as string[]).length).toBe(1);
    expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
    expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
  }, 120_000);

  test("a committed attempt on a dead channel is excluded and failed over — the synthesis cannot swallow auth-required", async () => {
    // Same precedence defect, dead-channel leg: classifyDeadChannel bails on any ok:true result,
    // so reading the SYNTHESIZED harvest result swallowed auth-required / setup-required /
    // provider-outage for every committed-but-walled attempt in BOTH modes — the channel stayed
    // eligible and the next attempt retried on a CLI that could never answer. Classification now
    // reads the pre-harvest parse, so the dead channel demotes and fails over while the commits
    // ride the same carry-forward as the quota case above.
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.02 })], {
      consult: { action: "human", notes: "a dead-channel-routed attempt must never reach a consult" },
      tasks: { T1: [
        { shell: `echo partial > p.txt && ${COMMIT} p && printf '%s\\n' 'Please run /login'` }, // commits, then the CLI reports it is dead — no trailer
        { shell: "test -f p.txt", result: { ok: true, summary: "carried work verified" } },
      ] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-dead-route", driver: hdriver({ useRealRead: true }) });

    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-harvest-dead-route");
    expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
    expect(evs.filter((e) => e.event === "channel-exclusion" && e.data.reason === "auth-required")).toHaveLength(1);
    const failover = evs.filter((e) => e.event === "dead-channel-failover" && e.data.reason === "auth-required");
    expect(failover).toHaveLength(1);
    expect(failover[0]!.data.from).not.toBe(failover[0]!.data.to);
    expect(evs.findIndex((e) => e.event === "gate-result"))
      .toBeGreaterThan(evs.findIndex((e) => e.event === "dead-channel-failover"));
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
    const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
    expect(recreations).toHaveLength(1);
    expect((recreations[0]!.data.attempted as string[]).length).toBe(1);
    expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
    expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
  }, 120_000);

  test("a committed attempt that then dies on a provider outage still requeues in place — the harvest cannot null the routing signature", async () => {
    await withSeams(500, 200, async () => {
      // T2 review (material, third routing branch): the harvest synthesis used to null the
      // pre-harvest cause for ANY harvested attempt, which made the v1.46 same-channel requeue
      // unreachable whenever commits landed — control fell through to classifyDeadChannel, whose
      // OUTAGE_RE matched the same banner and demoted the channel for every later attempt AND
      // every later task in the run, breaking the documented "a transient blip still recovers in
      // place" invariant. Every existing provider-death fixture exits, so workerFinished is true
      // and the harvest never fires — this worker COMMITS, prints the outage banner, and HANGS
      // (no exit, no trailer), the exact OBS-264 shape. The cause must survive synthesis: the
      // capped same-channel requeue fires, the channel is never demoted, and the commits ride
      // the carry-forward into the requeued attempt. The free requeue does not burn the attempt
      // counter, so the SAME scripted step replays — p.txt's presence in the recreated worktree
      // (carried forward) is what turns the replay into a trailer-emitting finisher.
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.05 })], {
        consult: { action: "human", notes: "a provider-death requeue must never reach a consult" },
        tasks: { T1: [
          { shell: `if [ -f p.txt ]; then test -s p.txt; else echo partial > p.txt && ${COMMIT} p && printf '%s\\n' 'Unable to reach the model provider' && sleep 60; fi`, result: { ok: true, summary: "carried work verified" } },
        ] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-provider-death", "flat");
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-provider-death", driver: hdriver({ useRealRead: true }) });
      } finally {
        restoreProbe();
      }

      expect(s.done).toEqual(["T1"]); // the free same-channel requeue carried it to done
      const evs = evsOf(repo, "run-harvest-provider-death");
      // the harvest still recognized and journaled the committed work — recognition is not the defect
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      // the worker's OWN outcome keeps its provider-death signature through the synthesis …
      expect(evs.filter((e) => e.event === "worker-result" && e.data.cause === "provider-death")).toHaveLength(1);
      // … so the capped same-channel requeue fires BEFORE any gate run …
      const requeues = evs.filter((e) => e.event === "provider-death-requeue" && e.taskId === "T1");
      expect(requeues).toHaveLength(1);
      expect(evs.findIndex((e) => e.event === "gate-result"))
        .toBeGreaterThan(evs.findIndex((e) => e.event === "provider-death-requeue"));
      // … and the transient blip never demotes the channel — no dead-channel classification at all
      expect(evs.filter((e) => e.event === "channel-exclusion")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "dead-channel-failover")).toHaveLength(0);
      // the requeue kept the same assignment and did not burn the attempt counter
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(dispatches[1]!.data.assignment).toEqual(dispatches[0]!.data.assignment);
      // the landed commit survived the requeue through the existing carry-forward — never re-earned
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations).toHaveLength(1);
      expect((recreations[0]!.data.attempted as string[]).length).toBe(1);
      expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
    });
  }, 120_000);

  test("a silent retry that only carries a prior attempt's commits is gated on the spot, never redispatched to re-earn them", async () => {
    // T2 review (material): harvest eligibility was measured against THIS attempt's post-carry
    // HEAD, so a retry that produced nothing of its own — while its worktree already held the
    // entire deliverable, cherry-picked forward — was invisible to both the triad and the
    // synthesis. Reproduced exactly: attempt 0 commits and walls on quota; attempt 1 receives that
    // commit and goes silent WITHOUT COMMITTING ANYTHING ITSELF. Before the fix the journal showed
    // worktree-recreation, then a stall consult, with no gate-result and no worker-result-harvested
    // — finished work sitting unverified in a worktree that was eligible to be bought again. The
    // commit-less retry is the whole point of this fixture: every other harvest case here lands a
    // fresh commit, which is exactly what hid this defect.
    await withSeams(300, 200, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.05 })], {
        consult: { action: "human", notes: "a carried-only retry must never reach a stall consult" },
        tasks: { T1: [
          { shell: `echo carried > c.txt && ${COMMIT} c && printf '%s\\n' 'usage limit reached for this model'` },
          { shell: "sleep 30" }, // silent, flat CPU, and not one commit of its own
        ] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-carried-only", "flat");
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-carried-only", driver: hdriver({ useRealRead: true }) });
      } finally {
        restoreProbe();
      }

      expect(s.done).toEqual(["T1"]);
      const evs = evsOf(repo, "run-harvest-carried-only");
      // attempt 0 routed on quota, as its own dedicated case pins …
      expect(evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1")).toHaveLength(1);
      // … and its commit rode the carry-forward into attempt 1's recreated worktree
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations).toHaveLength(1);
      expect(recreations[0]!.data.carried).toEqual(recreations[0]!.data.attempted);
      expect((recreations[0]!.data.carried as string[]).length).toBe(1);
      // the carried-only retry was harvested and GATED — the assertion that was red before the fix
      const harvested = evs.filter((e) => e.event === "worker-result-harvested" && e.data.attempt === 1);
      expect(harvested).toHaveLength(1);
      expect((harvested[0]!.data.commits as string[]).length).toBe(1); // the carried one; the worker made none
      const from = evs.indexOf(harvested[0]!);
      expect(evs.slice(from).some((e) => e.event === "gate-result" && e.taskId === "T1")).toBe(true);
      // and nothing was redispatched to re-produce work the worktree already held
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(2);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
    });
  }, 120_000);

  test("a carried-only silent retry on a dead channel still routes first — the harvest gates a worktree, it never certifies a channel", async () => {
    // The same carried-only retry, with a routing signature on it. Recognizing carried work must
    // not cost the pre-harvest routing precedence the closed-set constraint pins: attempt 1 lands
    // no commit of its own, is harvestable purely on the carry-forward, and STILL fails its dead
    // channel over before any gate runs on it. Both features are live in this one fixture — the
    // harvested event proves the harvest fired, the exclusion proves routing outranked it.
    await withSeams(100, 100, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.01 })], {
        judge: [
          { pass: false, criteria: [{ criterion: "done", met: false, reason: "retry once" }] },
          { pass: true, criteria: [{ criterion: "done", met: true, reason: "carried work is valid" }] },
        ],
        consult: { action: "human", notes: "unexpected gate failure" },
        tasks: { T1: [
          { shell: `echo landed > landed.txt && ${COMMIT} landed`, result: { ok: true, summary: "landed" } },
          { shell: "printf '%s\\n' 'Please run /login'; sleep 2" },
          { shell: "true", result: { ok: true, summary: "verified carried work" } },
        ] },
      });

      await runDaemon(repo, {
        adapters: [fake],
        runId: "run-harvest-attempt-base",
        driver: hdriver({ useRealRead: true }),
      });
      const evs = evsOf(repo, "run-harvest-attempt-base");

      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(dispatches.length).toBeGreaterThanOrEqual(3);
      // the carried-only retry IS recognized as holding work …
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.data.attempt === 1)).toHaveLength(1);
      // … and still routes on its PRE-HARVEST outcome, before any gate sees that worktree
      expect(evs.filter((e) => e.event === "channel-exclusion" && e.data.reason === "auth-required")).toHaveLength(1);
      const failover = evs.filter((e) => e.event === "dead-channel-failover" && e.data.reason === "auth-required");
      expect(failover).toHaveLength(1);
      const attempt1 = evs.indexOf(dispatches[1]!);
      const attempt2 = evs.indexOf(dispatches[2]!);
      const window = evs.slice(attempt1, attempt2);
      expect(window.some((e) => e.event === "dead-channel-failover")).toBe(true);
      expect(window.some((e) => e.event === "gate-result")).toBe(false);
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations.length).toBeGreaterThanOrEqual(2);
      expect(recreations.every((e) => (e.data.carried as string[]).length === 1)).toBe(true);
    });
  }, 120_000);

  test("a wait-loop exception always stops the worker CPU accountant", async () => {
    const probeDir = makeTestTempDir("tickmarkr-accountant-cleanup-");
    const probe = join(probeDir, "probe.ts");
    const daemonUrl = new URL("../../../src/run/daemon.ts", import.meta.url).href;
    const driverUrl = new URL("../../../src/drivers/subprocess.ts", import.meta.url).href;
    const helperUrl = new URL("../../helpers/tmprepo.ts", import.meta.url).href;
    writeFileSync(probe, [
      `import { runDaemon, resetHarvestCpuFlatMsForTests, resetHarvestSilentMsForTests, setHarvestCpuFlatMsForTests, setHarvestSilentMsForTests } from ${JSON.stringify(daemonUrl)};`,
      `import { SubprocessDriver } from ${JSON.stringify(driverUrl)};`,
      `import { COMMIT, setupRepo, T } from ${JSON.stringify(helperUrl)};`,
      "async function main() {",
      'const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], { tasks: { T1: [{ shell: `echo landed > landed.txt && ${COMMIT} landed` }] } });',
      "const inner = new SubprocessDriver();",
      "let reads = 0;",
      "const driver = {",
      '  id: "accountant-cleanup-probe", interactive: true,',
      "  slot: inner.slot.bind(inner), run: inner.run.bind(inner),",
      "  waitOutput: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return false; },",
      '  read: async () => { if (++reads >= 3) throw new Error("probe read failure"); return "working-on-it"; },',
      '  waitAgentStatus: inner.waitAgentStatus.bind(inner), status: async () => "working",',
      "  notify: inner.notify.bind(inner), close: inner.close.bind(inner), worktree: inner.worktree.bind(inner),",
      "};",
      "setHarvestSilentMsForTests(0); setHarvestCpuFlatMsForTests(60_000);",
      "try {",
      '  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-accountant-cleanup", driver });',
      '  if (!summary.failed.includes("T1")) throw new Error(`unexpected summary: ${JSON.stringify(summary)}`);',
      "} finally { resetHarvestSilentMsForTests(); resetHarvestCpuFlatMsForTests(); }",
      'process.stdout.write("accountant-cleanup-settled\\n");',
      "}",
      "main().catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", "tsx", probe], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let killedForLeak = false;
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        killedForLeak = true;
        child.kill("SIGKILL");
      }, 4_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(killedForLeak, stderr).toBe(false);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("accountant-cleanup-settled");
  }, 15_000);

  test("test: a worker still burning CPU is not concluded however silent its tracker is", async () => {
    // Pin three seconds, not one sparse observation: the window crosses three complete burner/gap
    // cycles on both CPU-clock resolutions, so only retained exited-child CPU can hold it open.
    await withSeams(300, 3_000, async () => {
      // Commits ahead of base AND a frozen tracker: two of the three legs are satisfied from the
      // first slice. The worker then burns, so the CPU leg alone must hold the wait open.
      // The persistent worker launches CPU-heavy tool children for 120ms, then waits 800ms. Every
      // child exits before the next sparse daemon observation; the persistent shell itself is idle.
      const runId = "run-harvest-busy";
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.12 })], {
        consult: { action: "human", notes: "stalled" },
        tasks: { T1: [{ shell: `echo busy > b.txt && ${COMMIT} b && ${burnInShortChildren()}` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, runId);
      let s: Awaited<ReturnType<typeof runDaemon>>;
      let waited = 0;
      try {
        const startedAt = Date.now();
        s = await runDaemon(repo, { adapters: [fake], runId, driver: hdriver() });
        waited = Date.now() - startedAt;
      } finally {
        restoreProbe();
      }

      const evs = evsOf(repo, "run-harvest-busy");
      // the triad never concluded this wait — the CPU leg alone held it, since the other two were
      // satisfied from the first slice
      expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // nor killed
      expect(waited).toBeGreaterThanOrEqual(7_200); // it rode the whole 0.12m window out
      expect(evs.find((e) => e.event === "worker-result" && e.taskId === "T1")!.data.cause).toBe("stall-timeout");
      // The CPU leg governs WHEN a wait ends, never whether landed work is gated: once the window
      // itself expired, the same carried worktree was still gated rather than redispatched — a busy
      // worker buys the full window it is entitled to, and not one redundant attempt after it.
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(s.done).toEqual(["T1"]);
    });
  }, 120_000);

  // OBS-548: the dead-channel fast-kill concluded on three CHANNEL-side legs — no trailer, an
  // unchanged launch tree, no output growth — and read none of the CPU this same loop already
  // measures. A worker holding 219,290 ms of tree CPU accruing at ~90 ms/s was declared dead at
  // 607 s of silence: its verification pass discarded, its gates run on a partial harvest, a healthy
  // channel demoted. The three runs below hold every one of those channel legs identical and vary
  // ONLY the CPU reading, so the kill's own arithmetic is the single thing under test.
  test("test: the fast-kill concludes a silent unchanged tree only when its measured worker-tree CPU is flat and stands down when that CPU is still accruing or cannot be measured; a kill that concludes without reading the measured CPU fails", async () => {
    // A host that cannot answer `ps` at all — the managed sandbox in production, made deterministic
    // here so the leg's THIRD state is exercised everywhere rather than only where `ps` is denied.
    const denyPs = (): (() => void) => {
      const bashEnv = join(makeTestTempDir("tickmarkr-ps-denied-"), "bash-env");
      writeFileSync(bashEnv, "ps() { return 1; }\n");
      const prior = process.env.BASH_ENV;
      process.env.BASH_ENV = bashEnv;
      return () => {
        if (prior === undefined) delete process.env.BASH_ENV;
        else process.env.BASH_ENV = prior;
      };
    };
    // 3s flat window, the shipped value on a hundredths host: the burner below runs in short-lived
    // children with ~800ms gaps, so a shorter window would read one gap as rest and answer the
    // test's own question. 0.12m of stall window leaves the kill room to land long before expiry.
    await withSeams(300, 3_000, async () => {
      setDeadChannelFastKillMsForTests(100);
      const run = async (runId: string, shell: string, cpu: "flat" | "accruing" | "denied") => {
        const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.12 })], {
          consult: { action: "human", notes: "a stalled worker parks" },
          tasks: { T1: [{ shell }] }, // no trailer, no commit — the tree never changes after launch
        });
        const restore = cpu === "denied"
          ? denyPs()
          : await cpuProbeFallback(repo, runId, cpu === "flat" ? "flat" : "bursty");
        try {
          await runDaemon(repo, { adapters: [fake], runId, driver: hdriver() });
        } finally {
          restore();
        }
        return evsOf(repo, runId);
      };

      const flat = await run("run-fastkill-cpu-flat", "sleep 30", "flat");
      const accruing = await run("run-fastkill-cpu-busy", burnInShortChildren(), "accruing");
      const denied = await run("run-fastkill-cpu-denied", "sleep 30", "denied");

      const rows = (evs: JournalEvent[], event: string) =>
        evs.filter((e) => e.event === event && e.taskId === "T1");
      const heldReasons = (evs: JournalEvent[]) => rows(evs, "worker-dead-held").map((e) => e.data.reason);

      // flat CPU under a silent tracker and an unchanged tree: the channel really is dead
      expect(rows(flat, "worker-dead")).toHaveLength(1);
      // the death carries the reading it concluded on — a kill that never asked cannot record one
      expect(rows(flat, "worker-dead")[0]!.data.cpuMs).toBe(0);
      expect(rows(flat, "worker-dead")[0]!.data.cpuResolutionMs).toBeTypeOf("number");

      // a live CPU delta is a live worker, by construction — the kill stands down and says why
      expect(rows(accruing, "worker-dead")).toHaveLength(0);
      expect(heldReasons(accruing)).toEqual(["cpu-accruing"]); // journaled once per attempt

      // unmeasurable is never evidence a worker stopped: the fail-open contract the probe states
      expect(rows(denied, "worker-dead")).toHaveLength(0);
      expect(heldReasons(denied)).toEqual(["cpu-unmeasurable"]);
      expect(rows(denied, "worker-harvest-unmeasurable").length).toBeGreaterThan(0);
    });
  }, 120_000);

  test("test: the synthesized no-trailer result is journaled as harvested, distinct from a worker-claimed ok", async () => {
    await withSeams(500, 200, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        tasks: { T1: [{ shell: `echo silent > s.txt && ${COMMIT} s` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-journal", "flat");
      try {
        await runDaemon(repo, { adapters: [fake], runId: "run-harvest-journal", driver: hdriver() });
      } finally {
        restoreProbe();
      }
      const evs = evsOf(repo, "run-harvest-journal");

      // the parsed truth is recorded first and stays truthful: the worker claimed nothing
      const parsed = evs.filter((e) => e.event === "worker-result" && e.taskId === "T1");
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.data.ok).toBe(false);
      expect(parsed[0]!.data.finished).toBe(false);
      expect(parsed[0]!.data.summary).toBe(NO_TRAILER_SUMMARY);
      // the synthesis is its OWN event — a worker-claimed ok can never produce this row
      const synthesized = evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1");
      expect(synthesized).toHaveLength(1);
      expect(synthesized[0]!.data.source).toBe("harvest");
      expect(synthesized[0]!.data.summary).toBe(HARVESTED_RESULT_SUMMARY);
      expect((synthesized[0]!.data.commits as string[]).length).toBe(1);
      expect(evs.findIndex((e) => e.event === "worker-result"))
        .toBeLessThan(evs.findIndex((e) => e.event === "worker-result-harvested"));

      // and a genuine worker-claimed ok never mints one
      const claimed = setupRepo([T("T1")], {
        tasks: { T1: [{ shell: `echo claimed > c.txt && ${COMMIT} c`, result: { ok: true, summary: "claimed" } }] },
      });
      await runDaemon(claimed.repo, { adapters: [claimed.fake], runId: "run-claimed-journal" });
      const claimedEvs = evsOf(claimed.repo, "run-claimed-journal");
      expect(claimedEvs.filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
      expect(claimedEvs.some((e) => e.event === "worker-result" && e.data.ok === true && e.data.finished === true)).toBe(true);
    });
  }, 120_000);

  test("no attempt whose worktree already carries the work is redispatched from scratch", async () => {
    await withSeams(500, 200, async () => {
      // A permanently red gate, so the ladder runs its full length and every attempt is a silent
      // worker that has already landed a commit. The invariant under test is per-attempt: whatever
      // the ladder decides next, the attempt that HOLDS the work is the attempt that gets verified.
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "not met" }] },
        consult: { action: "human", notes: "gates stayed red" },
        tasks: { T1: [{ shell: `echo work >> w.txt && ${COMMIT} w` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-never-redone", "flat");
      try {
        await runDaemon(repo, { adapters: [fake], runId: "run-harvest-never-redone", driver: hdriver() });
      } finally {
        restoreProbe();
      }
      const evs = evsOf(repo, "run-harvest-never-redone");

      const harvests = evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1");
      expect(harvests.length).toBeGreaterThan(1); // several attempts, every one of them carrying work
      // every harvest reaches gates BEFORE any next dispatch: the carried worktree is what got
      // verified, so no attempt was ever spent re-producing work the worktree already held.
      for (const h of harvests) {
        const from = evs.indexOf(h);
        const next = evs.findIndex((e, i) => i > from && e.event === "task-dispatch");
        const window = evs.slice(from, next === -1 ? evs.length : next);
        expect(window.some((e) => e.event === "gate-result")).toBe(true);
      }
      // one harvest per attempt: no attempt ended in the stall consult that buys a fresh worker
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(harvests.length);
      // and the landed commits ride every worktree recreation intact — nothing is ever re-earned
      const recreations = evs.filter((e) => e.event === "worktree-recreation" && e.taskId === "T1");
      expect(recreations.length).toBeGreaterThan(0);
      for (const r of recreations) {
        expect((r.data.attempted as string[]).length).toBeGreaterThan(0);
        expect(r.data.carried).toEqual(r.data.attempted);
      }
    });
  }, 180_000);

  test("a burning seeded worker is never concluded: its launch is outside the probed tree, so it has no CPU leg at all", async () => {
    // Review finding: interactiveSeed adapters (kimi) are launched by runInteractiveSeed, NOT by the
    // dispatch script — so a probe keyed to the script found nothing, read 0, called it FLAT, and
    // could harvest a worker that was mid-turn. tickmarkr does not own that launch line (the adapter
    // does, and it must be delivered verbatim), so the seeded path has no measurable CPU leg and is
    // never concluded by the triad; it keeps the no-redispatch half of OBS-264 through the tail.
    // Both seams are pinned SHORT on purpose: that removes "the window was too long" as an
    // explanation, so a probe that trusted its own zero would conclude this worker within seconds.
    await withSeams(300, 200, async () => {
      const { repo, scriptPath } = setupRepo([T("T1", { timeoutMinutes: 0.15 })], {
        consult: { action: "human", notes: "stalled" },
        tasks: { T1: [{ shell: "unused — the seed launch is the dispatch" }] },
      });
      const ready = "SEED-READY";
      // a tenth of a core, not a whole one: what this case needs is a worker that is ALIVE and
      // quiet with commits landed, and the suite runs test files in parallel forks — every
      // core-second here is charged to whatever else is running (tests/cockpit/live.test.ts sweeps
      // the frame-contract domain single-threaded and sits ~3% under its own timeout).
      const seedLaunch = `echo ${ready} && echo seeded > s.txt && ${COMMIT} s && ${burnFor(12_000, 10)}`;
      const fake = new FakeAdapter(scriptPath) as FakeAdapter & { interactiveSeed?: unknown };
      fake.interactiveCommand = () => null; // kimi's shape: no argv-seeding surface at all
      fake.interactiveSeed = {
        launch: () => seedLaunch,
        readinessMatch: ready,
        seedLine: (promptFile: string) => `Read ${promptFile} and do exactly what it says.`,
      };

      // Only the FIRST delivery spawns: a real seeded TUI receives the seed line as typed input, so
      // spawning a second process for it would both lie about the tree and drop the launch's handle.
      let launched: string | undefined;
      const inner = new SubprocessDriver();
      const driver = hdriver({
        waitOutput: inner.waitOutput.bind(inner), // real: readiness must be genuinely observed
        read: inner.read.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (launched !== undefined) return;
          launched = cmd;
          await inner.run(slot, cmd);
        },
        slot: inner.slot.bind(inner), close: inner.close.bind(inner), worktree: inner.worktree.bind(inner),
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-seeded", driver });

      // the burning seeded worker was NOT concluded — the assertion that goes red the moment the
      // probe treats "my marker matched nothing" as "this worker is at rest"
      const evs = evsOf(repo, "run-harvest-seeded");
      expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
      // the launch really did bypass the dispatch script (the gap is structural, not incidental)
      // and the daemon says so out loud rather than leaving a silent hole in the feature
      expect(launched).toBe(seedLaunch);
      const unmeasurable = evs.filter((e) => e.event === "worker-harvest-unmeasurable" && e.taskId === "T1");
      expect(unmeasurable).toHaveLength(1); // once per attempt, not once per slice
      expect(unmeasurable[0]!.data.reason).toContain("interactive-seed");
      // and the other half of OBS-264 still holds on this path: the window expiry gates the commits
      // the seeded worker landed instead of buying a fresh worker to re-produce them
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(s.done).toEqual(["T1"]); // and the window expiry still gates the work it landed
    });
  }, 120_000);

  test("a headless worker that committed and went quiet is harvested without riding out its window", async () => {
    // Review finding: the triad lived only in the interactive wait loop, so a print-mode worker —
    // the fallback EVERY adapter without a TUI surface lands in — still paid the full stall window.
    // A real SubprocessDriver (runDaemon's default), a real 5m window, and a worker that commits and
    // then sleeps: alive, zero CPU, silent. It must be concluded in seconds, not minutes.
    await withSeams(500, 200, async () => {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        consult: { action: "human", notes: "a harvested attempt must never reach a consult" },
        tasks: { T1: [{ shell: `echo headless > h.txt && ${COMMIT} h && sleep 20` }] },
      });
      const restoreProbe = await cpuProbeFallback(repo, "run-harvest-headless", "flat");
      const startedAt = Date.now();
      let s: Awaited<ReturnType<typeof runDaemon>>;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-headless" });
      } finally {
        restoreProbe();
      }
      const waited = Date.now() - startedAt;

      expect(s.done).toEqual(["T1"]);
      expect(waited).toBeLessThan(60_000); // the 5m window was never ridden out
      const evs = evsOf(repo, "run-harvest-headless");
      const concluded = evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1");
      expect(concluded).toHaveLength(1);
      expect(concluded[0]!.data.commits).toBe(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
    });
  }, 120_000);

  test("a headless worker that commits and exits cleanly without a trailer is harvested, never counted as completion", async () => {
    // T2 review (material): print mode set `finished` from the EXIT MARKER, so a worker that
    // committed and exited normally without a trailer entered the tail as finished:true — the
    // synthesis is gated on !workerFinished, so it never fired: gates ran on the worker's own
    // ok:false with no HARVESTED_RESULT_SUMMARY and no worker-result-harvested row. That is the
    // natural exit path every headless adapter takes; the other headless case here keeps its
    // process alive until the triad breaks the loop, which is exactly what hid this. `finished`
    // now means the trailer in BOTH modes, and the cause taxonomy's "clean-exit-no-trailer" —
    // unreachable in print mode until now — names the shape.
    const shell = `echo exited > e.txt && ${COMMIT} e`; // exits immediately; no trailer at all
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], {
      consult: { action: "human", notes: "a harvested attempt must never reach a consult" },
      tasks: { T1: [{ shell }] },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-print-exit" });

    expect(s.done).toEqual(["T1"]);
    const evs = evsOf(repo, "run-harvest-print-exit");
    // the exit marker ended the wait — the triad never ran, so this is the natural-exit path
    expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
    // the parsed worker truth stays truthful: it exited, it claimed nothing
    const parsed = evs.filter((e) => e.event === "worker-result" && e.taskId === "T1");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.data.finished).toBe(false);
    expect(parsed[0]!.data.exitCode).toBe(0);
    expect(parsed[0]!.data.summary).toBe(NO_TRAILER_SUMMARY);
    expect(parsed[0]!.data.cause).toBe("clean-exit-no-trailer");
    // and the committed worktree reached gates through the synthesis, on this same attempt
    const synthesized = evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1");
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.data.summary).toBe(HARVESTED_RESULT_SUMMARY);
    expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
    expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);

    // the SAME shell with a trailer is a worker-claimed completion — no synthesis, finished:true.
    // Both outcomes are reachable in this fixture; only the trailer differs.
    const claimed = setupRepo([T("T1", { timeoutMinutes: 5 })], {
      tasks: { T1: [{ shell, result: { ok: true, summary: "claimed" } }] },
    });
    await runDaemon(claimed.repo, { adapters: [claimed.fake], runId: "run-harvest-print-claimed" });
    const claimedEvs = evsOf(claimed.repo, "run-harvest-print-claimed");
    expect(claimedEvs.filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
    expect(claimedEvs.some((e) => e.event === "worker-result" && e.data.finished === true && e.data.ok === true)).toBe(true);
  }, 120_000);

  test("an unreadable ps stops the CPU accountant instead of forking one every 100ms for the rest of the window", async () => {
    // T2 review (material): the accountant samples at 10Hz and each sample forks bash + ps. Where
    // ps is unsupported or DENIED — the managed-sandbox class, and the named fail-open path — every
    // sample fails, so it kept forking for the remainder of the stall window: tens of thousands of
    // processes per silent attempt, multiplied by daemon concurrency, for a probe that can never
    // conclude anything. Persistent failure is structural, so the sampler stops. This shims `ps`
    // itself (a bash function via BASH_ENV, the same seam the sandbox fallback uses) to fail and
    // COUNT its calls, then measures the count against a window long enough that an unbounded
    // sampler would have forked ~90 times.
    const dir = makeTestTempDir("tickmarkr-ps-denied-");
    const counter = join(dir, "calls");
    const bashEnv = join(dir, "bash-env");
    writeFileSync(counter, "");
    writeFileSync(bashEnv, 'ps() { printf x >> "$TICKMARKR_TEST_PS_CALLS"; return 1; }\n');
    const prior = { bashEnv: process.env.BASH_ENV, calls: process.env.TICKMARKR_TEST_PS_CALLS };

    await withSeams(200, 200, async () => {
      // commits, then stays alive and silent for the whole 9s window — the accountant's own
      // population, and the one it must not keep forking through
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.15 })], {
        consult: { action: "human", notes: "an unmeasurable probe must never reach a consult" },
        tasks: { T1: [{ shell: `echo denied > d.txt && ${COMMIT} d && sleep 20` }] },
      });
      let s: Awaited<ReturnType<typeof runDaemon>>;
      process.env.BASH_ENV = bashEnv;
      process.env.TICKMARKR_TEST_PS_CALLS = counter;
      try {
        s = await runDaemon(repo, { adapters: [fake], runId: "run-harvest-ps-denied", driver: hdriver() });
      } finally {
        if (prior.bashEnv === undefined) delete process.env.BASH_ENV;
        else process.env.BASH_ENV = prior.bashEnv;
        if (prior.calls === undefined) delete process.env.TICKMARKR_TEST_PS_CALLS;
        else process.env.TICKMARKR_TEST_PS_CALLS = prior.calls;
      }

      const calls = readFileSync(counter, "utf8").length;
      expect(calls).toBeGreaterThan(0); // the accountant really did start — otherwise this proves nothing
      expect(calls).toBeLessThanOrEqual(25); // bounded by the cap, NOT by the 9s window
      const evs = evsOf(repo, "run-harvest-ps-denied");
      // it fails open exactly as before: nothing is concluded on an unreadable snapshot, the gap is
      // named once, and the window expiry still gates the work the worker landed
      expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
      const unmeasurable = evs.filter((e) => e.event === "worker-harvest-unmeasurable" && e.taskId === "T1");
      expect(unmeasurable).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
      expect(s.done).toEqual(["T1"]);
    });
  }, 120_000);

  // ── the harvest's precedence over every sibling guard in the wait loop ───────────────────────
  // The closed set is: the routing branches (quota + dead-channel classification — the two cases
  // above), the dead-channel fast-kill, the liveness nudge, and the noTrailerStreak accounting.
  // Each member below gets a fixture in which BOTH the harvest and that member can genuinely fire:
  // a fixture where only one of them is reachable proves precedence for neither, so every case
  // here carries a second run of the SAME fixture, differing only in the seam that decides which
  // member wins, and asserts the other one really was live in it.

  // Member: the liveness nudge (T1/OBS-262). A worker that COMMITS and goes quiet is harvestable
  // from the first slice, at seams pinned BELOW the nudge gate exactly as the shipped harvest 5m
  // sits below the shipped nudge 10m — and the adapter here is on the nudge allowlist, claude-code's
  // shape and the only member of it. Before the hold, the harvest concluded such an attempt at the
  // harvest gate and closed its slot, so the nudge was unreachable for every committed claude-code
  // worker: the CPU leg cannot tell "idle because finished" from "idle while holding an unsubmitted
  // turn in the input box" — both read flat CPU under a silent tracker — and the nudge is the one
  // signal that can. Holding concludes at nudge+grace instead of the whole window, and the landed
  // commits still go to gates through the same synthesis.
  test("a committed worker on a nudgeable adapter is nudged first — the harvest holds, then gates the same work", async () => {
    const fixture = (runId: string) => setupRepo([T("T1", { timeoutMinutes: 5 })], {
      consult: { action: "human", notes: `${runId}: a harvested attempt must never reach a consult` },
      tasks: { T1: [{ shell: `echo nudgeable > n.txt && ${COMMIT} n` }] }, // commits, then exits: flat CPU, silent tracker
    });
    await withSeams(200, 200, async () => {
      setNudgeTimingForTests(1_500, 600); // harvest gate (200ms) strictly below the nudge gate, as 5m < 10m
      try {
        // 1) the nudgeable run: the harvest is eligible from the first slice and must NOT take it
        const held = fixture("run-harvest-nudge-held");
        NUDGEABLE_ADAPTERS.add("fake");
        let nudges = 0;
        let s: Awaited<ReturnType<typeof runDaemon>>;
        let waited = 0;
        const restoreProbe = await cpuProbeFallback(held.repo, "run-harvest-nudge-held", "flat");
        try {
          const startedAt = Date.now();
          s = await runDaemon(held.repo, {
            adapters: [held.fake], runId: "run-harvest-nudge-held",
            driver: hdriver({ nudge: async () => { nudges++; return true; }, notify: async () => {} }),
          });
          waited = Date.now() - startedAt;
        } finally {
          NUDGEABLE_ADAPTERS.delete("fake");
          restoreProbe();
        }
        const evs = evsOf(held.repo, "run-harvest-nudge-held");
        // the rescue was reachable: it fired, and the harvest never preempted it
        expect(nudges).toBe(1);
        expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
        // the hold is bounded by the nudge's own grace, never by the 5m window
        expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(1);
        expect(waited).toBeLessThan(60_000);
        // and the OBS-264 win survives the hold: the committed work is still gated on THIS attempt
        expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "consult-verdict")).toHaveLength(0);
        expect(s.done).toEqual(["T1"]);

        // 2) the SAME fixture with the adapter off the allowlist — nothing else changed. It
        // harvests at these very seams, which is what makes run 1's silence a HOLD rather than a
        // fixture in which the triad could never have concluded anything.
        const free = fixture("run-harvest-nudge-free");
        const restoreFree = await cpuProbeFallback(free.repo, "run-harvest-nudge-free", "flat");
        try {
          await runDaemon(free.repo, {
            adapters: [free.fake], runId: "run-harvest-nudge-free",
            driver: hdriver({ nudge: async () => true, notify: async () => {} }),
          });
        } finally {
          restoreFree();
        }
        const freeEvs = evsOf(free.repo, "run-harvest-nudge-free");
        expect(freeEvs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(1);
        expect(freeEvs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(0);
      } finally {
        resetNudgeTimingForTests();
      }
    });
  }, 120_000);

  // Member: the dead-channel fast-kill. Its worktree clause and the harvest are mutually exclusive
  // by construction: committed work changes the launch tree, irrespective of whether a nudge can
  // reach the pane. An unreachable pane holding commits is therefore never condemned as a dead
  // empty tree, and its existing work goes straight to gates.
  // OBS-548 moved the MECHANISM and left the claim standing. Until v1.97 a failed delivery LIFTED
  // both holds — `(!nudgePending || nudgeFailed)` — so this pane was concluded 2.2 s after
  // `worker-nudge-failed` and the delivery failure was itself the trigger, on precisely the
  // population that has no input box to accept a nudge. Now both holds stand, so the pane rides its
  // OWN rolling window and the no-trailer tail harvests the same commits off the same worktree:
  // still harvested, still never condemned, but by the window rather than by the failure. The
  // window is sized so that riding all of it is the cheap outcome and not a test timeout.
  test("an unreachable pane holding commits is harvested rather than condemned by failed delivery, and its work still gated", async () => {
    const fixture = (id: string) => setupRepo([T("T1", { timeoutMinutes: 0.1 })], { // 6s window, ridden in full
      consult: { action: "human", notes: "an unreachable pane must never reach a consult" },
      tasks: { T1: [{ shell: `echo ${id} > u.txt && ${COMMIT} u` }] },
    });
    await withSeams(300, 200, async () => {
      NUDGEABLE_ADAPTERS.add("fake");
      setNudgeTimingForTests(300, 400);
      setDeadChannelFastKillMsForTests(1_500); // kill window well inside the 6s: an unheld kill fires at ~1.5s
      try {
        // 1) the delivery fails, so neither hold lifts: no kill, no triad harvest, the window owns
        //    the conclusion — and the committed tree is still what goes to gates.
        const killed = fixture("unreachable");
        const restoreProbe = await cpuProbeFallback(killed.repo, "run-harvest-unreachable", "flat");
        let s: Awaited<ReturnType<typeof runDaemon>>;
        let waited = 0;
        try {
          const startedAt = Date.now();
          s = await runDaemon(killed.repo, {
            adapters: [killed.fake], runId: "run-harvest-unreachable",
            driver: hdriver({ nudge: async () => false, notify: async () => {} }), // both deliveries fail → nudgeFailed
          });
          waited = Date.now() - startedAt;
        } finally {
          restoreProbe();
        }
        const evs = evsOf(killed.repo, "run-harvest-unreachable");
        expect(evs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
        expect(evs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(0);
        expect(waited).toBeGreaterThanOrEqual(6_000); // the rolling window was ridden, not short-circuited
        // the conclusion is still not a redispatch: the same worktree went to gates
        expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1")).toHaveLength(1);
        expect(evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1")).toHaveLength(1);
        expect(s.done).toEqual(["T1"]);

        // 2) the SAME fixture with the adapter off the allowlist — nothing else changed, and the
        //    seams are identical. No nudge is ever owed, so nothing is pending and nothing can fail
        //    to deliver: the triad concludes on the very evidence leg 1 also had, far inside that
        //    window. This is what makes leg 1's silence a HOLD rather than a fixture in which
        //    nothing could ever have been concluded.
        NUDGEABLE_ADAPTERS.delete("fake");
        const free = fixture("free");
        const restoreFree = await cpuProbeFallback(free.repo, "run-harvest-unreachable-free", "flat");
        let freeWaited = 0;
        try {
          const startedAt = Date.now();
          await runDaemon(free.repo, {
            adapters: [free.fake], runId: "run-harvest-unreachable-free",
            driver: hdriver({ nudge: async () => false, notify: async () => {} }),
          });
          freeWaited = Date.now() - startedAt;
        } finally {
          restoreFree();
        }
        const freeEvs = evsOf(free.repo, "run-harvest-unreachable-free");
        expect(freeEvs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(0);
        expect(freeEvs.filter((e) => e.event === "worker-harvest" && e.taskId === "T1")).toHaveLength(1);
        expect(freeEvs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
        expect(freeWaited).toBeLessThan(6_000); // concluded by the triad, not by the window
      } finally {
        NUDGEABLE_ADAPTERS.delete("fake");
        resetNudgeTimingForTests();
        resetDeadChannelFastKillMsForTests();
      }
    });
  }, 120_000);

  // Member: the noTrailerStreak accounting (OBS-57). A harvested attempt is a no-trailer window —
  // gates are the truth about its WORKTREE, never about its CHANNEL. Reading the synthesized
  // ok/finished here reset the streak on every harvest, so a CLI that produces commits and swallows
  // every trailer was immune to the two-window demotion and stayed first pick for the whole run.
  test("a harvested attempt still burns a no-trailer window — the channel is demoted, never certified", async () => {
    const red = {
      judge: { pass: false, criteria: [{ criterion: "done", met: false, reason: "not met" }] },
      consult: { action: "human", notes: "gates stayed red" },
    };
    const shell = `echo work >> w.txt && ${COMMIT} w`;
    await withSeams(300, 200, async () => {
      // 1) silent worker, red gates: every attempt is harvested, and the channel demotes on the second
      const silent = setupRepo([T("T1", { timeoutMinutes: 5 })], { ...red, tasks: { T1: [{ shell }] } });
      const restoreProbe = await cpuProbeFallback(silent.repo, "run-harvest-streak", "flat");
      try {
        await runDaemon(silent.repo, { adapters: [silent.fake], runId: "run-harvest-streak", driver: hdriver() });
      } finally {
        restoreProbe();
      }
      const evs = evsOf(silent.repo, "run-harvest-streak");
      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      const key = (a: unknown) => `${(a as { adapter: string }).adapter}:${(a as { model: string }).model}`;

      // both features live in this one fixture: the attempts really were harvested and gated …
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1").length).toBeGreaterThanOrEqual(2);
      expect(evs.some((e) => e.event === "gate-result" && e.taskId === "T1")).toBe(true);
      // … and the missing trailers still accumulated into the OBS-57 demotion
      const demotions = evs.filter((e) => e.event === "channel-demotion" && e.taskId === "T1");
      expect(demotions).toHaveLength(1);
      expect(demotions[0]!.data.streak).toBe(2);
      expect(demotions[0]!.data.channel).toBe(key(dispatches[0]!.data.assignment));
      // the demotion is not cosmetic: no later attempt was dispatched back onto that channel
      const after = evs.slice(evs.indexOf(demotions[0]!)).filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((e) => key(e.data.assignment) !== demotions[0]!.data.channel)).toBe(true);

      // 2) the SAME fixture, same red gates, same diff — the worker merely emits a trailer. No
      // demotion, so run 1's demotion came from the missing trailers and not from the red ladder.
      const trailered = setupRepo([T("T1", { timeoutMinutes: 5 })], {
        ...red, tasks: { T1: [{ shell, result: { ok: true, summary: "claimed" } }] },
      });
      await runDaemon(trailered.repo, { adapters: [trailered.fake], runId: "run-harvest-streak-claimed" });
      const claimedEvs = evsOf(trailered.repo, "run-harvest-streak-claimed");
      expect(claimedEvs.filter((e) => e.event === "worker-result-harvested")).toHaveLength(0);
      expect(claimedEvs.filter((e) => e.event === "channel-demotion")).toHaveLength(0);
    });
  }, 180_000);

  // ── v1.85 T3: the repair seam, composed with this suite's own fixture ────────────────────────
  // The repair decision reads `commits` and `lostCommits` from an attempt the HARVEST concluded, so
  // it is proven here rather than beside a trailer-emitting worker: the same run must show T1's
  // liveness nudge firing on a worker holding commits ahead of base BEFORE anything concludes it,
  // and the review-only failure that follows must buy a repair instead of a fresh re-onboarding.
  test("test: a review-only failure with fully carried commits dispatches a repair attempt whose prompt carries the diff content and the findings verbatim, and in the same composed fixture a nudge-eligible worker with commits ahead of base still receives the merged liveness nudge before any conclude", async () => {
    const { repo, fake } = setupRepo(
      // complexity 8 puts the task above review.complexityThreshold; the command oracle keeps
      // acceptance deterministic so REVIEW is the only gate that can fail.
      [T("T1", { complexity: 8, timeoutMinutes: 5, acceptance: [{ oracle: "command", command: "true" }] })],
      {
        review: {
          approve: false,
          findings: [{ note: "`renderRow` in src/ui/row.ts drops the last column", severity: "material" }],
          comments: [{ path: "src/ui/row.ts", line: 88, body: "off-by-one in `renderRow`" }],
        },
        consult: { action: "human", notes: "a repair fixture must never reach a consult" },
        // commits, then goes quiet without a trailer — the OBS-264 shape, carrying real work
        tasks: { T1: [{ shell: `echo carried > repairable.txt && ${COMMIT} carried` }] },
      },
    );
    await withSeams(200, 200, async () => {
      setNudgeTimingForTests(1_500, 600); // harvest gate (200ms) strictly below the nudge gate, as 5m < 10m
      NUDGEABLE_ADAPTERS.add("fake");
      let nudges = 0;
      const restoreProbe = await cpuProbeFallback(repo, "run-repair-review", "flat");
      try {
        await runDaemon(repo, {
          adapters: [fake], runId: "run-repair-review",
          driver: hdriver({ nudge: async () => { nudges++; return true; }, notify: async () => {} }),
        });
      } finally {
        NUDGEABLE_ADAPTERS.delete("fake");
        resetNudgeTimingForTests();
        restoreProbe();
      }
      const evs = evsOf(repo, "run-repair-review");

      // ── the merged liveness nudge still runs, and still runs FIRST ──
      expect(nudges).toBeGreaterThanOrEqual(1);
      const firstNudge = evs.findIndex((e) => e.event === "worker-nudge" && e.taskId === "T1");
      expect(firstNudge).toBeGreaterThanOrEqual(0);
      const concludes = ["worker-harvest", "worker-result-harvested", "worker-result"];
      const firstConclude = evs.findIndex((e) => concludes.includes(e.event) && e.taskId === "T1");
      expect(firstConclude).toBeGreaterThan(firstNudge); // nudged before any conclude, never after
      // the worker really did hold commits ahead of base, and that work reached the gates
      expect(evs.filter((e) => e.event === "worker-result-harvested" && e.taskId === "T1").length).toBeGreaterThanOrEqual(1);

      // ── review-only failure over fully carried commits → a REPAIR attempt ──
      const reviewFail = evs.find((e) => e.event === "gate-result" && e.taskId === "T1"
        && e.data.gate === "review" && e.data.pass === false)!;
      expect(reviewFail).toBeDefined();
      // both review rounds this engagement earned a repair (the budget is 2); the second one's
      // dispatch never happens because the review round cap parks the task first.
      const repairs = evs.filter((e) => e.event === "repair-attempt" && e.taskId === "T1");
      expect(repairs.length).toBeGreaterThanOrEqual(1);
      expect(repairs[0]!.data.gates).toEqual(["review"]);
      expect(String(repairs[0]!.data.findings)).toContain("renderRow"); // the findings ride the ledger
      const sent = evs.filter((e) => e.event === "repair-dispatch" && e.taskId === "T1");
      expect(Number(sent[0]!.data.diffBytes)).toBeGreaterThan(0);
      const dispatches = evs.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
      expect(dispatches.length).toBeGreaterThanOrEqual(2);
      expect(dispatches[1]!.data.retryMode).toBe("repair"); // not a fresh re-onboarding

      // ── the repair prompt carries the diff CONTENT and the findings VERBATIM ──
      const prompt = readFileSync(join(tickmarkrDir(repo), "runs", "run-repair-review", "prompts", "T1-a1.md"), "utf8");
      expect(prompt).toContain("## Repair attempt — fix ONLY what these findings name");
      expect(prompt).toContain(String(reviewFail.data.details)); // the journal's own bytes, unabridged
      expect(prompt).toContain("`renderRow` in src/ui/row.ts drops the last column");
      expect(prompt).toContain("diff --git"); // real diff content, not a hash manifest
      expect(prompt).toContain("+carried");
    });
  }, 240_000);

});
