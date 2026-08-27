import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/config/config.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { type ExecutorDriver, type Slot } from "../../../src/drivers/types.js";
import { tickmarkrDir } from "../../../src/graph/graph.js";
import { EARLY_LAUNCH_LIVENESS_MS, NUDGEABLE_ADAPTERS, resetDeadChannelFastKillMsForTests, resetEarlyLaunchLivenessMsForTests, resetNudgeTimingForTests, resetPageRepeatMsForTests, resetQuotaBannerSilentMsForTests, runDaemon, setDeadChannelFastKillMsForTests, setEarlyLaunchLivenessMsForTests, setNudgeTimingForTests, setPageRepeatMsForTests, setQuotaBannerSilentMsForTests, WORKER_NUDGE_MESSAGE } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { PANE_READ_ROWS, resetRowRearmTokenFlatMsForTests, setRowRearmTokenFlatMsForTests } from "../../../src/run/stall.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";


// A deterministic flat worker-tree CPU reading, installed by overriding `ps` for every shell the
// daemon forks. Unconditional on purpose: the point is that the CPU leg answers the same on a host
// whose `ps` works and on one that denies it, so a test can vary the leg it actually means to test.
function flatCpuProbe(): () => void {
  const bashEnv = join(makeTestTempDir("tickmarkr-ps-flat-"), "bash-env");
  writeFileSync(bashEnv, "ps() { echo '1 1 0:00.00 unrelated-process'; }\n");
  const prior = process.env.BASH_ENV;
  process.env.BASH_ENV = bashEnv;
  return () => {
    if (prior === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = prior;
  };
}


describe("OBS-82 spinner-blind stall, headless site (fake adapter, zero tokens)", () => {
  // Mirror of the interactive test in daemon-interactive.test.ts: every poll returns a raw-unique
  // frame (glyph + elapsed-time repaint) that normalizes constant, so the headless inactivity
  // budget must expire. Only the worker slot is scripted — consult reads stay real.
  test("spinner only repaints do not reset the headless stall clock", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "spinner wedge" } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: print\n",
    );
    const inner = new SubprocessDriver();
    const glyphs = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"];
    let n = 0;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: (slot: Slot, lines?: number) =>
        slot.name.includes("-worker-")
          ? Promise.resolve(`${glyphs[++n % glyphs.length]} Starting MCP servers (5/7): context7, sites-design-picker · ${n}s · esc to interrupt`)
          : inner.read(slot, lines),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-spin-print", driver });
    expect(s.human).toEqual(["T1"]);
    expect(Journal.open(repo, "run-spin-print").read().find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
  }, 30_000);
});


describe("v1.76 progress-based stall watchdog (fake adapter, zero tokens)", () => {
  test("test: a worker pane emitting only cursor and status-bar repaints past the stall threshold triggers the stall escalation", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "repaint-only pane" } },
      "taskTimeoutMinutes: 0.005\nvisibility:\n  worker: print\n",
    );
    const inner = new SubprocessDriver();
    let workerReads = 0;
    const driver = {
      id: "subprocess",
      interactive: false,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) => {
        if (!slot.name.includes("-worker-")) return inner.waitOutput(slot, pattern, ms, opts);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return false;
      },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: (slot: Slot, lines?: number) => {
        if (!slot.name.includes("-worker-")) return inner.read(slot, lines);
        workerReads++;
        const repaint = Math.min(workerReads, 20);
        return Promise.resolve([
          "seed accepted",
          "────────────────────────",
          `agent idle · context 0% · cursor row ${repaint}`,
        ].join("\n"));
      },
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
    };

    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-chrome-repaint", driver });

    expect(summary.human).toEqual(["T1"]);
    expect(workerReads).toBeLessThan(20); // watchdog fired while the repaint stream was still changing
    expect(Journal.open(repo, "run-chrome-repaint").read().find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
  }, 30_000);

  test("test: a worker making real transcript progress at the same cadence does not trigger it", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{
        shell: `for n in 1 2 3 4 5; do echo "completed transcript step $n"; sleep 0.15; done; echo done > done.txt && ${COMMIT} done`,
        result: { ok: true, summary: "transcript kept growing" },
      }] } },
      "taskTimeoutMinutes: 0.005\nvisibility:\n  worker: print\n",
    );

    const summary = await runDaemon(repo, { adapters: [fake], runId: "run-transcript-progress" });

    expect(summary.done).toEqual(["T1"]);
    const result = Journal.open(repo, "run-transcript-progress").read().find((e) => e.event === "worker-result");
    expect(result?.data.finished).toBe(true);
    expect(result?.data.cause).toBeUndefined();
  }, 30_000);
});


describe("OBS-117 early-launch liveness (fake adapter, zero tokens)", () => {
  const SETUP_FAIL = "echo 'zsh: command not found: codex'; exit 1";

  test("test: the silent-launch fast path keeps its existing shorter deadline and error", async () => {
    setEarlyLaunchLivenessMsForTests(50);
    try {
      const stall = setupRepo(
        [T("T1")],
        {
          tasks: {
            T1: [
              { shell: SETUP_FAIL },
              { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered" } },
            ],
          },
        },
        "taskTimeoutMinutes: 5\nvisibility:\n  worker: print\n",
      );
      await runDaemon(stall.repo, { adapters: [stall.fake], runId: "run-stall-setup" });
      const stallFo = Journal.open(stall.repo, "run-stall-setup").read()
        .find((e) => e.event === "dead-channel-failover")!.data;

      const early = setupRepo(
        [T("T1")],
        {
          tasks: {
            T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered" } }],
          },
        },
        "taskTimeoutMinutes: 5\nvisibility:\n  worker: print\n",
      );
      const inner = new SubprocessDriver();
      let workerRuns = 0;
      const driver = {
        id: "subprocess",
        interactive: false,
        status: inner.status.bind(inner),
        slot: inner.slot.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (slot.name.includes("-worker-")) workerRuns++;
          return inner.run(slot, cmd);
        },
        waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
          workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: (slot: Slot, lines?: number) =>
          slot.name.includes("-worker-") && workerRuns === 1
            ? Promise.resolve("")
            : inner.read(slot, lines),
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        worktree: inner.worktree.bind(inner),
      };
      await runDaemon(early.repo, { adapters: [early.fake], runId: "run-early-setup", driver });
      const earlyFo = Journal.open(early.repo, "run-early-setup").read()
        .find((e) => e.event === "dead-channel-failover")!.data;

      expect(earlyFo.reason).toBe(stallFo.reason);
      expect(earlyFo.reason).toBe("setup-required");
      expect(earlyFo.from).toBe(stallFo.from);
      expect(earlyFo.to).toBe(stallFo.to);
      expect(Object.keys(earlyFo).sort()).toEqual(Object.keys(stallFo).sort());
    } finally {
      resetEarlyLaunchLivenessMsForTests();
    }
  }, 30_000);

  test("stall thresholds and their configuration surface are unchanged", () => {
    expect(EARLY_LAUNCH_LIVENESS_MS).toBe(60_000);
    expect(DEFAULT_CONFIG.taskTimeoutMinutes).toBe(30);
    expect(DEFAULT_CONFIG.consult.stallMinutes).toBe(15);
    expect(Object.keys(DEFAULT_CONFIG).filter((key) => /stall|timeout/i.test(key))).toEqual(["taskTimeoutMinutes"]);
  });

  test("the early check adds no new polling timer beyond the existing stall-wait poll cadence", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../src/run/daemon.ts"), "utf8");
    expect(src).not.toMatch(/\bsetInterval\s*\(/);
    expect(src).toMatch(/earlyLaunchLivenessMs/);
    expect(src).toMatch(/!everHadOutput && Date\.now\(\) - attemptStart >= earlyLaunchLivenessMs/);
    expect(src).not.toMatch(/setTimeout\([^)]*earlyLaunch/);
  });
});


// T1 (OBS-262/263, speed-spec §2): stall detection notices a dead or silent worker in minutes.
// Interactive-driver integration tests over the scripted fake adapter — zero tokens, real worktrees.
describe("T1 stall detection (OBS-262/263, fake adapter, zero tokens)", () => {
  // OBS-548 review (material): the fast-kill grew a CPU leg, and it fails OPEN — an unmeasurable
  // reading stands the kill down and hands the pane back to the rolling window. Every case in this
  // describe discriminates on a CHANNEL leg (row growth, worktree delta, nudge state, status), so
  // the CPU reading must be a constant here rather than something each host answers differently:
  // the managed macOS sandbox denies `ps` outright, which would hold every kill below until a
  // 5- or 30-minute daemon window outlived the 120 s test budget. One unrelated row — the marker
  // matches nothing, so the worker tree is empty and reads the probe's documented flat zero,
  // "nothing of this worker is running". Same fixture the OBS-548 cases use, applied to all of them.
  let restoreCpuProbe: () => void = () => {};
  beforeEach(() => { restoreCpuProbe = flatCpuProbe(); });
  afterEach(() => { restoreCpuProbe(); });

  // a stalled interactive TUI: prints once (early-launch liveness passes), never emits a trailer
  const STALLED = {
    consult: { action: "human", notes: "stalled worker" },
    tasks: { T1: [{ shell: "echo working-on-it" }] },
  };
  const idriver = (overrides: Record<string, unknown> = {}): ExecutorDriver => {
    const inner = new SubprocessDriver();
    return {
      id: "t1-stall-fake",
      interactive: true,
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: async () => { await new Promise((r) => setTimeout(r, 50)); return false; },
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: async () => "working-on-it",
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      status: async () => "working",
      ...overrides,
    } as ExecutorDriver;
  };

  test("test: a worker silent on the monotonic tracker for ten minutes is nudged even while its herdr status reads working, and the nudge is journaled", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400); // seam for the 10m gate / 4m grace — behavior under test is status-blindness
    // Both seams scale TOGETHER so the ordering is what is proven: the fast-kill window sits BELOW
    // the nudge gate (its shipped 5m is below the nudge's 10m too), and a nudgeable pane must still
    // be nudged first — the kill holds while the daemon has an action of its own pending.
    setDeadChannelFastKillMsForTests(50);
    try {
      const nudges: string[] = [];
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const driver = idriver({
        status: async () => "working", // the reading that used to hold the nudge gate hostage
        nudge: async (_slot: unknown, message: string) => { nudges.push(message); return true; },
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-working", driver });
      expect(s.human).toEqual(["T1"]); // unanswered nudge → grace expiry → stall consult parks human
      expect(nudges).toEqual([WORKER_NUDGE_MESSAGE]); // one nudge per attempt, fired under "working"
      const evs = Journal.open(repo, "run-t1-nudge-working").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(1);
      // the fast-kill seam expired long before the nudge gate — and never fired: the nudge got first crack
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
      // status is journaled on change (T1 review — per-slice appends flooded the live surface),
      // and every journaled sample read "working"
      const samples = evs.filter((e) => e.event === "worker-status" && e.taskId === "T1");
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every((e) => e.data.status === "working")).toBe(true);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  test("test: a second page fires after a first — deleting the paged latch is proven by two journaled pages in one attempt", async () => {
    // adapter "fake" is NOT nudge-allowlisted and the driver has no nudge surface: an idle pane is
    // the operator's to unblock, so the page fires — journaled every slice AND delivered again on
    // the repeat cadence. The status never changes here, so a status latch would deliver once.
    setPageRepeatMsForTests(500); // seam for the 2m operator-spam cadence (shipped 2m sits below the 5m fast-kill)
    try {
      const notifies: string[] = [];
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const driver = idriver({
        status: async () => "idle",
        notify: async (msg: string) => { notifies.push(msg); },
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-pages", driver });
      expect(s.human).toEqual(["T1"]);
      const pages = Journal.open(repo, "run-t1-pages").read()
        .filter((e) => e.event === "operator-page" && e.taskId === "T1");
      expect(pages.length).toBeGreaterThanOrEqual(2); // a second page fired after a first …
      expect(new Set(pages.map((e) => e.data.attempt)).size).toBe(1); // … within ONE attempt
      // … and the second page reached the operator, not just the journal (the latch is gone)
      expect(notifies.filter((m) => /looks idle without finishing/.test(m)).length).toBeGreaterThanOrEqual(2);
    } finally {
      resetPageRepeatMsForTests();
    }
  }, 120_000);

  test("test: a quota banner matched on two consecutive slices with three minutes of tracker silence fails the attempt over without waiting out the window", async () => {
    setQuotaBannerSilentMsForTests(1_500); // seam for the 3m silence gate
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 5 })], // a 5m window: finishing inside the 120s test timeout proves the window was NOT waited out
        { tasks: { T1: [
          { shell: "echo 'usage limit reached for this model'" }, // channel A: quota banner, no trailer
          { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered on B" } },
        ] } },
      );
      const inner = new SubprocessDriver();
      let workerRuns = 0;
      let bannerReads = 0;
      const driver = {
        id: "t1-quota-fake",
        interactive: true,
        slot: inner.slot.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (slot.name.includes("-worker-")) workerRuns++;
          return inner.run(slot, cmd);
        },
        waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
          workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: (slot: Slot, lines?: number) => {
          // the banner printed AFTER a benign launch frame classifies; the mirror test below
          // proves arrival order no longer matters — chrome is filtered by identity, not novelty
          if (slot.name.includes("-worker-") && workerRuns === 1) {
            bannerReads++;
            return Promise.resolve(bannerReads <= 2
              ? "composing a plan for the task"
              : "claude ai usage limit reached for this model\nresets at 5pm"); // the banner IS output
          }
          return inner.read(slot, lines);
        },
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        worktree: inner.worktree.bind(inner),
        status: async () => "working",
      };
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota", driver });
      expect(s.done).toEqual(["T1"]); // channel B carried it to done — A failed over, not consulted
      const evs = Journal.open(repo, "run-t1-quota").read();
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(1);
      const failover = evs.find((e) => e.event === "quota-failover" && e.taskId === "T1");
      expect(failover).toBeDefined();
      expect(failover!.data.from).not.toBe(failover!.data.to);
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // Mirror of the criterion above (T1 review, material): the banner is on screen from the FIRST
  // read the daemon ever makes — a channel throttled at launch paints it before the first poll.
  // A novelty baseline anchored on that first frame exculpated exactly this case forever (proven
  // by execution: this driver shape yields {done:["T1"], quotaFailover:1} on shipped 843328b0 and
  // {human:["T1"], quotaFailover:0} under the baseline). Chrome is filtered by identity now, so
  // the banner classifies however early it arrived — quota failover is free and never waits the
  // rolling window out (criterion 6).
  test("a quota banner present from the first loop read fails the attempt over — the launch-time-throttle mirror", async () => {
    setQuotaBannerSilentMsForTests(1_500); // seam for the 3m silence gate
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 5 })], // 5m window: finishing inside the 120s timeout proves it was NOT waited out
        { tasks: { T1: [
          { shell: "echo 'usage limit reached for this model'" }, // channel A: throttled at launch, no trailer
          { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "recovered on B" } },
        ] } },
      );
      const inner = new SubprocessDriver();
      let workerRuns = 0;
      const driver = {
        id: "t1-quota-launch-fake",
        interactive: true,
        slot: inner.slot.bind(inner),
        run: async (slot: Slot, cmd: string) => {
          if (slot.name.includes("-worker-")) workerRuns++;
          return inner.run(slot, cmd);
        },
        waitOutput: async (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
          workerRuns > 1 ? inner.waitOutput(slot, pattern, ms, opts) : false,
        waitAgentStatus: inner.waitAgentStatus.bind(inner),
        read: (slot: Slot, lines?: number) =>
          // the banner IS the launch frame and every frame after — the exact shape a baseline
          // anchored on the first rendered frame swallowed
          slot.name.includes("-worker-") && workerRuns === 1
            ? Promise.resolve("claude ai usage limit reached for this model\nresets at 5pm")
            : inner.read(slot, lines),
        notify: inner.notify.bind(inner),
        close: inner.close.bind(inner),
        worktree: inner.worktree.bind(inner),
        status: async () => "working",
      };
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota-launch", driver });
      expect(s.done).toEqual(["T1"]); // channel B carried it to done — the shipped behavior the baseline regressed
      const evs = Journal.open(repo, "run-t1-quota-launch").read();
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.some((e) => e.event === "quota-failover" && e.taskId === "T1")).toBe(true);
      expect(Journal.open(repo, "run-t1-quota-launch").readTelemetry().filter((r) => r.quotaFailover === true)).toHaveLength(1);
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // OBS-548, fourth clause: the arithmetic was settled before either probe ran. The prompt told
  // every worker "Budget the full suite once" inside a stall window whose OUTPUT-silence gates are
  // 300 s (600 s in practice, behind the nudge hold) — and this repository's own suite measures
  // ~712 s. A worker obeying the harness's own instruction was killed by construction, which is
  // OBS-534's shape one probe over. Gates already run build/test/lint themselves against a recorded
  // baseline, so the suite was never the worker's to buy; what the worker owes inside the window is
  // a commit and a trailer. Read off the prompt a dispatched worker actually received, never off the
  // template — the contract is prepended at dispatch, and only the delivered file proves delivery.
  test("test: the harness contract a dispatched worker receives puts the full suite on the gates and still demands a commit and completion trailer inside the stall window; a contract telling the worker to budget the full suite once fails", async () => {
    const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 7 })], {
      tasks: { T1: [{ shell: `echo done > d.txt && ${COMMIT} d`, result: { ok: true, summary: "done" } }] },
    });
    await runDaemon(repo, { adapters: [fake], runId: "run-worker-contract" });
    const prompt = readFileSync(join(tickmarkrDir(repo), "runs", "run-worker-contract", "prompts", "T1-a0.md"), "utf8");
    const contract = prompt.split("\n").find((line) => line.includes("stall window"))!;

    expect(contract).toContain("7 minute stall window"); // still the task's own window, named
    // the suite belongs to the gates, and the worker is told so
    expect(contract).toMatch(/gates run the full suite/i);
    // …and never told to spend the window on one
    expect(contract).not.toMatch(/budget the full suite/i);
    // what it still owes inside that window is unchanged: a commit and the completion trailer
    expect(contract).toMatch(/commit/i);
    expect(contract).toMatch(/completion trailer/i);
    expect(prompt).toContain("This harness is non-interactive"); // the rest of the contract is intact
  }, 60_000);

  test("test: a worker with no trailer, no worktree delta and no output growth for five minutes is concluded dead and journaled as such", async () => {
    setDeadChannelFastKillMsForTests(1_500); // seam for the 5m fast-kill window
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], STALLED); // 5m window; the 120s test timeout proves the kill was fast
      const driver = idriver({ status: async () => "working" }); // constant pane text: zero output growth
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-dead", driver });
      expect(s.human).toEqual(["T1"]); // concluded dead → stall consult parks human
      const evs = Journal.open(repo, "run-t1-dead").read();
      const dead = evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1");
      expect(dead).toHaveLength(1);
      expect(dead[0]!.data.attempt).toBe(0);
      // the dead conclusion precedes the worker-result harvest in the stream
      expect(evs.findIndex((e) => e.event === "worker-dead" && e.taskId === "T1"))
        .toBeLessThan(evs.findIndex((e) => e.event === "worker-result" && e.taskId === "T1"));
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // The fast-kill's growth signal is the monotonic tracker, never raw pane bytes. This is the
  // exact OBS-262 blindness in miniature: the pane below is FROZEN — its only change per slice is
  // the elapsed counter ticking inside one repainting row, which lengthens the raw read while the
  // transcript occupies no new rows. A fast-kill clocked on raw pane length would read that tick
  // as growth and hold the window open forever; the tracker normalizes the elapsed token away and
  // condemns it. Behavioral on purpose — a source grep pins the spelling, not the property.
  test("a pane whose only change is a ticking elapsed counter is still fast-killed — raw byte growth is not progress", async () => {
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], STALLED); // 5m window; the kill lands in seconds
      let tick = 0;
      const driver = idriver({
        status: async () => "working",
        // one row, same width class, strictly longer bytes each read: "⠋ thinking (9s)" → "(10s)" → …
        read: async () => `⠋ thinking (${9 + tick++}s • esc to interrupt)`,
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-tick", driver });
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-t1-tick").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(1);
      expect(tick).toBeGreaterThan(1); // the pane really did repaint a longer line between slices
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // The dead-channel triad has no status exemption. A `blocked` reading is exactly the status a
  // wedged TUI scrapes as, so exempting it would let the worst stall class wait the rolling window
  // out on a status reading — the blindness T1 exists to delete. The operator is still paged; the
  // page and the kill are not alternatives.
  test("a blocked pane holding the dead-channel triad is fast-killed too, and paged on the way out", async () => {
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 5 })], STALLED); // 5m window; the kill lands in seconds
      const driver = idriver({ status: async () => "blocked", notify: async () => {} });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-blocked", driver });
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-t1-blocked").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(1);
      const pages = evs.filter((e) => e.event === "operator-page" && e.taskId === "T1");
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.every((e) => e.data.status === "blocked")).toBe(true);
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review (read-ceiling blindness): the tracker's row signal saturates once a sample FILLS
  // the bounded read on RAW lines (blanks and chrome-only rows included) — past that, a flat
  // tracker means "unmeasurable", not "dead". For UNMETERED adapters (no contextUsage: codex,
  // cursor-agent, grok, opencode — the exact non-nudgeable set this kill governs) rows are the
  // only liveness signal, so a live worker past the ceiling would be concluded dead mid-work.
  // The kill must stand down on a saturated row signal (journaled once) and let the rolling
  // window own the pane, as pre-T1.
  test("a saturated row signal stands the fast-kill down — a live pane past the read ceiling is never concluded dead", async () => {
    setDeadChannelFastKillMsForTests(1_500); // kill seam far below the 6s window: without the stand-down, worker-dead fires
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      // a constant FULL read window in the shape a production `read(slot, PANE_READ_ROWS)`
      // actually returns: exactly PANE_READ_ROWS raw lines, blank rows included (measured
      // 730 non-empty of 1000 on the codex-mcp-spinner fixture). Frozen-looking to the row
      // high-water, but only because the signal is blind — and the non-empty count sits BELOW
      // the ceiling, so only a raw-window saturation check can stand the kill down here.
      const saturatedPane = Array.from({ length: PANE_READ_ROWS }, (_, i) =>
        i % 4 === 3 ? "" : `exploring module ${i}`).join("\n");
      const driver = idriver({ status: async () => "working", read: async () => saturatedPane });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-saturated", driver });
      expect(s.human).toEqual(["T1"]); // the rolling window concluded it — the stall consult parks human
      const evs = Journal.open(repo, "run-t1-saturated").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // never killed on a blind signal
      const held = evs.filter((e) => e.event === "worker-dead-held" && e.taskId === "T1");
      expect(held).toHaveLength(1); // the stand-down is journaled exactly once per attempt
      expect(held[0]!.data.reason).toBe("row-signal-saturated");
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // Adversarial pair to the quota criterion: the classifier must fire on a live banner and stay
  // silent on a transcript that merely QUOTES one. Same silence, same two slices, same regex —
  // only the banner's position in the transcript differs. The quoting text is printed AFTER a
  // benign launch frame, so it is genuinely NEW output — novelty cannot be what saves it; only
  // its place above the tail can.
  test("a quota mention above the transcript tail is not a banner and never fails the attempt over", async () => {
    setQuotaBannerSilentMsForTests(500);
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const harmless = [
        "$ git diff",
        "+  // handle the provider rate limit banner: usage limit reached → failover",
        "+  if (QUOTA_RE.test(out)) return quotaFailover();",
        ...Array.from({ length: 14 }, (_, i) => `  reading src/run/module-${i}.ts`),
      ].join("\n");
      let reads = 0;
      const driver = idriver({
        status: async () => "working",
        read: async () => (++reads <= 2 ? "composing a plan for the task" : harmless),
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota-mention", driver });
      expect(s.human).toEqual(["T1"]); // window expiry → stall consult …
      const evs = Journal.open(repo, "run-t1-quota-mention").read();
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1")).toHaveLength(0); // … never a failover
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // T1 review (material, fixture-overfit class): codex pins "• You have 3 usage limit resets
  // available." in the composer chrome of EVERY rendered frame (tests/fixtures/codex-mcp-spinner),
  // so a raw-tail QUOTA_RE match fails a wedged worker over for a quota it never hit. The daemon
  // filters that KNOWN chrome by identity — never by novelty against an anchor frame, which is
  // what swallowed the launch-time banner (see the mirror test above). This test feeds the daemon
  // the hostile shape: a pre-render launch read (a shell pane holding the dispatch line — what
  // driver.run() + an immediate read produce for every adapter without interactiveSeed), then the
  // captured wedged-MCP frames — tracker-silent, chrome pinned inside the tail.
  test("codex welcome chrome painted after a pre-render launch read is never classified as a quota banner", async () => {
    setQuotaBannerSilentMsForTests(500); // the silence gate passes quickly — only the chrome filter can save the pane
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED);
      const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "codex-mcp-spinner");
      const frames = readdirSync(fixtureDir)
        .filter((f) => /^frame-\d+\.txt$/.test(f))
        .sort()
        .map((f) => readFileSync(join(fixtureDir, f), "utf8"));
      expect(frames.length).toBeGreaterThanOrEqual(8);
      let reads = 0;
      const driver = idriver({
        status: async () => "working",
        // read #1 is the daemon's launch read: the pre-render shell pane. Every later read is a
        // rendered frame from the wedged-MCP capture — chrome pinned in the tail, zero progress.
        read: async () => (++reads === 1
          ? "$ bash /tmp/tickmarkr-dispatch-T1.sh"
          : frames[(reads - 2) % frames.length]),
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-quota-chrome", driver });
      expect(s.human).toEqual(["T1"]); // window expiry → stall consult: the pane was wedged, not throttled
      const evs = Journal.open(repo, "run-t1-quota-chrome").read();
      expect(reads).toBeGreaterThan(3); // the loop really polled rendered frames past the launch read
      expect(evs.filter((e) => e.event === "quota-banner" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "quota-failover" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      resetQuotaBannerSilentMsForTests();
    }
  }, 120_000);

  // A nudge that could not be DELIVERED says only that the daemon lost contact. The worker's real
  // worktree delta remains independent evidence and keeps the fast-kill from condemning the pane;
  // the short rolling window owns its eventual conclusion instead.
  // "Could not be delivered" means BOTH attempts failed — one in-slice retry (T1 review) filters a
  // driver flake, so a single false return never reaches this path.
  test("an undeliverable nudge does not condemn a pane whose worktree changed — delivery failure is not worker evidence", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400);
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 0.05 })], // 3s window owns the conclusion after the delta is observed
        { consult: { action: "human", notes: "stalled worker" },
          tasks: { T1: [{ shell: "echo scratch > scratch.txt && echo working-on-it" }] } }, // uncommitted delta
      );
      const driver = idriver({
        status: async () => "working", // never pageable
        nudge: async () => false, // the pane cannot be reached
        notify: async () => {}, // keep expected consult/page delivery inside this fixture, not suite stdout
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-fail", driver });
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-t1-nudge-fail").read();
      expect(evs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-contact" && e.data.evidence === "worktree")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review: a false return from driver.nudge is a driver-delivery outcome (missing pin,
  // readiness timeout, read-back hiccup), not proof of an unreachable channel — so ONE failed
  // delivery must not condemn a pane holding uncommitted work. The daemon retries once in-slice;
  // here the first delivery flakes and the retry lands, and the pane must live to see its grace.
  test("a nudge that fails once then delivers does not condemn the pane — one driver flake is not a dead channel", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400);
    setDeadChannelFastKillMsForTests(1_500); // below the window: if the flake latched, the kill would fire
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 30 })], // 30m window; the 120s test timeout proves it was not waited out
        { consult: { action: "human", notes: "stalled worker" },
          tasks: { T1: [{ shell: "echo scratch > scratch.txt && echo working-on-it" }] } }, // uncommitted delta
      );
      let calls = 0;
      const driver = idriver({
        status: async () => "working", // never pageable — the kill is the only path that could condemn
        nudge: async () => ++calls >= 2, // first delivery flakes, the in-slice retry lands
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-flake", driver });
      expect(s.human).toEqual(["T1"]); // delivered-but-unanswered nudge → grace expiry → stall consult
      expect(calls).toBe(2); // the retry really happened, inside the same nudge sequence
      const evs = Journal.open(repo, "run-t1-nudge-flake").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-nudge-failed" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // the flake never condemned it
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(1);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // The other half of that claim: with the nudge never attempted (adapter off the allowlist), the
  // same worktree delta still protects the pane for the whole window — the delta clause is intact.
  test("a worktree delta still disables the fast-kill when no nudge has failed", async () => {
    setDeadChannelFastKillMsForTests(1_500);
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 0.1 })], // 6s window — the whole of it elapses without a kill
        { consult: { action: "human", notes: "stalled worker" },
          tasks: { T1: [{ shell: "echo scratch > scratch.txt && echo working-on-it" }] } },
      );
      const driver = idriver({ status: async () => "working", notify: async () => {} });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-delta-alive", driver });
      expect(s.human).toEqual(["T1"]); // window expiry → stall consult, not a dead-channel kill
      const evs = Journal.open(repo, "run-t1-delta-alive").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review fix (material): the nudge grace deadline used to arm once and never disarm — a
  // worker that ANSWERED the nudge and resumed was force-concluded at its next quiet patch ≥ the
  // grace (measured off the rolling lastProgressAt), journaled worker-nudge-expired as if it had
  // ignored the nudge. Post-nudge progress must disarm the deadline and hand the pane back to the
  // rolling window. Here: silence → nudge → the worker replies (real new rows) → a quiet patch
  // longer than the grace → the attempt ends on the WINDOW, never on worker-nudge-expired.
  test("a worker that answers the nudge and resumes disarms the grace deadline — the next quiet patch is owned by the rolling window", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400); // 200ms silence → nudge; 400ms grace
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.05 })], STALLED); // 3s window — the conclusion must be the window's
      let nudged = false;
      let replyRows = 0;
      const driver = idriver({
        status: async () => "working",
        nudge: async () => { nudged = true; return true; },
        read: async () => {
          // once the nudge lands the worker replies and resumes: real new transcript rows for a
          // few slices (post-nudge progress), then a quiet patch far longer than the grace
          if (nudged && replyRows < 3) replyRows++;
          return ["working-on-it", ...Array.from({ length: replyRows + 1 }, (_, i) => `resumed row ${i}`)].join("\n");
        },
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-nudge-answered", driver });
      expect(s.human).toEqual(["T1"]); // the rolling window concluded it — stall consult parks human
      const evs = Journal.open(repo, "run-t1-nudge-answered").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      // the answer was seen and disarmed the grace …
      expect(evs.filter((e) => e.event === "worker-nudge-answered" && e.taskId === "T1")).toHaveLength(1);
      // … so the false "ignored the nudge" conclusion never fires
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(0);
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
    }
  }, 120_000);

  // T1 review (answer-then-die, criterion 6): the disarm test above proves the answered pane
  // survives to the window; this one proves it does not survive UNWATCHED. The fast-kill hold used
  // to key on `nudgeable` — a per-slice adapter/status property — so once a worker answered the
  // nudge and then froze, the one-per-attempt nudge latch, the disarmed expiry branch, and the
  // nudgeable-gated kill and page left it with NO watchdog at all: the dead-channel triad was met
  // at the fast-kill window and the pane still rode the whole rolling window in silence. The hold
  // is on a PENDING daemon action now (un-nudged, or grace armed), so the kill owns this pane.
  test("a worker that answers the nudge and then freezes with no delta is fast-killed — the rolling window does not own it", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(200, 400); // 200ms silence → nudge; 400ms grace
    setDeadChannelFastKillMsForTests(1_500); // kill seam far below the 30m window: the kill owns the conclusion
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 30 })], STALLED); // 30m window, no worktree delta
      let nudged = false;
      let replyRows = 0;
      const driver = idriver({
        status: async () => "working", // never pageable — the kill is the only watchdog left
        nudge: async () => { nudged = true; return true; },
        read: async () => {
          // the worker answers the nudge (real new rows — the grace disarms), then freezes for good
          if (nudged && replyRows < 3) replyRows++;
          return ["working-on-it", ...Array.from({ length: replyRows + 1 }, (_, i) => `resumed row ${i}`)].join("\n");
        },
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-answer-die", driver });
      expect(s.human).toEqual(["T1"]); // concluded dead → stall consult parks human
      const evs = Journal.open(repo, "run-t1-answer-die").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.filter((e) => e.event === "worker-nudge-answered" && e.taskId === "T1")).toHaveLength(1);
      // the answer was genuine, so the "ignored the nudge" conclusion never fires …
      expect(evs.filter((e) => e.event === "worker-nudge-expired" && e.taskId === "T1")).toHaveLength(0);
      // … but the subsequent freeze meets the dead-channel triad and is killed on the fast-kill
      // window — seconds into a 30m rolling window, not at the end of it
      const dead = evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1");
      expect(dead).toHaveLength(1);
      expect(evs.findIndex((e) => e.event === "worker-nudge-answered" && e.taskId === "T1"))
        .toBeLessThan(evs.findIndex((e) => e.event === "worker-dead" && e.taskId === "T1"));
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetDeadChannelFastKillMsForTests();
    }
  }, 120_000);

  // T1 review fix (material): the fast-kill's "no output growth" leg used to clock off
  // lastProgressAt, which the flat-token rule deliberately suppresses — and contextTokens is
  // sticky across read misses. A METERED, non-nudgeable adapter (pi's shape: contextUsage present,
  // off the nudge allowlist) streaming rows under a stale counter was journaled worker-dead while
  // its pane was visibly printing. The kill now reads the tracker's raw row-growth clock: rows
  // advancing is output growth, suppressed or not.
  test("a metered non-nudgeable worker streaming rows under a flat token counter is never fast-killed", async () => {
    setDeadChannelFastKillMsForTests(300); // kill seam far below the 6s window: the old composition kills in ~1s
    setRowRearmTokenFlatMsForTests(200); // seam for the 15m flat-token cap: suppression engages mid-test
    try {
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], STALLED); // the 6s window owns the conclusion
      fake.contextUsage = () => ({ tokens: 500 }); // metered — and permanently FLAT (the sticky counter)
      let reads = 0;
      const driver = idriver({
        status: async () => "working", // never pageable; "fake" is not nudge-allowlisted → the kill is the only early exit
        read: async () => ["working-on-it", ...Array.from({ length: Math.min(reads++, 50) }, (_, i) => `suite output row ${i}`)].join("\n"),
        notify: async () => {},
      });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-t1-flat-tokens", driver });
      expect(s.human).toEqual(["T1"]); // the rolling window concluded it, not the kill
      const evs = Journal.open(repo, "run-t1-flat-tokens").read();
      expect(evs.filter((e) => e.event === "worker-dead" && e.taskId === "T1")).toHaveLength(0); // streaming rows ARE output growth
      expect(reads).toBeGreaterThan(2); // the pane really did keep streaming past the suppression point
    } finally {
      resetDeadChannelFastKillMsForTests();
      resetRowRearmTokenFlatMsForTests();
    }
  }, 120_000);
});
