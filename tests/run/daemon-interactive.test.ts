import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dirname } from "node:path";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type Assignment, type Invocation } from "../../src/adapters/types.js";
import type { Task } from "../../src/graph/schema.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { NO_TRAILER_SUMMARY, UNPARSEABLE_TRAILER_SUMMARY } from "../../src/adapters/prompt.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";


// SubprocessDriver hosts the scripted "TUI": interactive flag forced on, agent status scriptable.
function idriver(overrides: Record<string, unknown> = {}): ExecutorDriver {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-fake",
    interactive: true,
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
    status: async () => "unknown",
    ...overrides,
  } as ExecutorDriver;
}

// T5 / OBS-111: deterministic pane-read staging for parse-boundary tests. The real subprocess still
// emits a well-formed trailer on the waitOutput seam; these staged strings simulate what driver.read
// returns from the pane, including the race where the token is present but the JSON is not yet balanced.
function nonceFor(repo: string, runId: string, taskId: string): string {
  const pf = join(repo, ".tickmarkr", "runs", runId, "prompts", `${taskId}-a0.md`);
  try {
    return /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(pf, "utf8"))?.[1] ?? "";
  } catch {
    return "";
  }
}
function withNonce(repo: string, runId: string, taskId: string, text: string): string {
  return text.replace(/<NONCE>/g, nonceFor(repo, runId, taskId));
}

function stagedInteractiveDriver(
  repo: string,
  runId: string,
  taskId: string,
  stages: string[],
  opts: { noToken?: boolean } = {},
): ExecutorDriver {
  const inner = new SubprocessDriver();
  let readIdx = 0;
  return idriver({
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: opts.noToken ? () => Promise.resolve(false) : inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: (slot: Slot, lines?: number) => {
      if (!slot.name.includes("-worker-")) return inner.read(slot, lines);
      const text = stages[Math.min(readIdx, stages.length - 1)];
      readIdx++;
      return Promise.resolve(withNonce(repo, runId, taskId, text));
    },
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
    status: async () => "unknown",
  });
}

describe("daemon v1.2 interactive workers (fake adapter, zero tokens)", () => {
  test("interactive harvest: trailer in transcript, no fallback", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo hi > a.txt && ${COMMIT} a`, result: { ok: true, summary: "done interactively" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-int", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-int").read();
    const wr = evs.find((e) => e.event === "worker-result");
    expect(wr?.data.mode).toBe("interactive");
    expect(wr?.data.finished).toBe(true);
    expect(wr?.data.exitCode).toBe(0); // the fake's bash exits after the trailer; a real TUI stays alive (null — next test)
    expect(evs.some((e) => e.event === "worker-mode-fallback")).toBe(false);
  }, 30_000);

  test("trailer while the TUI is still alive: finished, exitCode null", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo alive > v.txt && ${COMMIT} v`, result: { ok: true, summary: "tui still open" } }] } },
    );
    const inner = new SubprocessDriver();
    // strip the exit marker from the WORKER dispatch script only (gates/consult still need theirs)
    // and hold the process open — models a TUI that finished but didn't exit. v1.62 T1: the delivered
    // line is a script invocation, so the marker is edited out of the script file, not the line.
    const driver = idriver({
      slot: inner.slot.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      run: (s: Slot, cmd: string) => {
        const p = /^bash '(.+)'$/.exec(cmd)?.[1];
        const script = p ? readFileSync(p, "utf8") : "";
        if (p && script.includes("TICKMARKR_RESULT")) {
          writeFileSync(p, script.replace(/\nprintf[^\n]*\$\?$/, "\nsleep 3"));
        }
        return inner.run(s, cmd);
      },
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-alive", driver });
    expect(s.done).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-alive").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(true);
    expect(wr?.data.exitCode).toBeNull();
  }, 30_000);

  test("crashed TUI fast-fails via the exit marker instead of burning the timeout", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "echo boom; exit 7" }] } }, // no result → no trailer; process dies
      "taskTimeoutMinutes: 5\n", // generous — the test only stays fast if the crash short-circuits the wait
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-crash", driver: idriver() });
    expect(s.human).toEqual(["T1"]); // no consult script → fail-closed to human
    const wr = Journal.open(repo, "run-crash").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(false);
    expect(wr?.data.exitCode).toBe(7);
    expect(wr?.data.mode).toBe("interactive");
  }, 30_000);

  test("worker: print pins the v1.1 path (TICKMARKR_EXIT wrapper, exit code, no fallback event)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo p > p.txt && ${COMMIT} p`, result: { ok: true, summary: "print mode" } }] } },
      "visibility:\n  worker: print\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-print", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-print").read();
    const wr = evs.find((e) => e.event === "worker-result");
    expect(wr?.data.mode).toBe("print");
    expect(wr?.data.exitCode).toBe(0);
    expect(evs.some((e) => e.event === "worker-mode-fallback")).toBe(false);
  }, 30_000);

  test("driver without interactive support falls back to print, journaled once", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo d > d.txt && ${COMMIT} d`, result: { ok: true, summary: "subprocess" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-fb-driver" }); // default SubprocessDriver
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-fb-driver").read();
    const fb = evs.filter((e) => e.event === "worker-mode-fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0].data.reason).toBe("driver");
    expect(evs.find((e) => e.event === "worker-result")?.data.mode).toBe("print");
  }, 30_000);

  test("adapter without an interactive command falls back to print, journaled", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo n > n.txt && ${COMMIT} n`, result: { ok: true, summary: "null icmd" } }] } },
    );
    class NullFake extends FakeAdapter {
      interactiveCommand(): string | null { return null; }
    }
    const s = await runDaemon(repo, { adapters: [new NullFake(scriptPath)], runId: "run-fb-adapter", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-fb-adapter").read();
    const fb = evs.filter((e) => e.event === "worker-mode-fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0].data.reason).toBe("adapter");
  }, 30_000);

  test("interactive quota: no trailer + quota text at timeout → channel failover, then done", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'" }, // no result → no trailer: hung on quota
        { shell: `echo q > q.txt && ${COMMIT} q`, result: { ok: true, summary: "second channel worked" } },
      ] } },
      "taskTimeoutMinutes: 0.05\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-int-quota", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-int-quota").read();
    const qf = evs.find((e) => e.event === "quota-failover");
    expect(qf?.data.from).toBe("fake:fake-1");
    expect(qf?.data.to).toBe("fake:fake-2");
  }, 30_000);

  test("interactive completion beats quota mentions: trailer present → no failover", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo 'note: handled upstream 429 rate limit' > r.txt && ${COMMIT} r`, result: { ok: true, summary: "mentions quota harmlessly" } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-int-noquota", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    expect(Journal.open(repo, "run-int-noquota").read().some((e) => e.event === "quota-failover")).toBe(false);
  }, 30_000);

  test("blocked pane pages the operator exactly once and keeps waiting", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "sleep 30" }] }, // never emits a trailer
        consult: { action: "human", notes: "operator must unblock" },
      },
      "taskTimeoutMinutes: 0.02\n",
    );
    const inner = new SubprocessDriver();
    const notified: string[] = [];
    const driver = {
      id: "interactive-fake",
      interactive: true,
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      // trailer (regex) waits fail instantly so the loop spins; plain waits (consult TICKMARKR_EXIT) stay real
      waitOutput: (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
        opts?.regex ? Promise.resolve(false) : inner.waitOutput(slot, pattern, ms),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: async (msg: string) => { notified.push(msg); },
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      status: async () => "blocked",
    } as ExecutorDriver;
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-blocked", driver });
    expect(s.human).toEqual(["T1"]);
    expect(notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
  }, 30_000);

  test("displaying a marker string mid-work doesn't end the wait (tickmarkr-editing-tickmarkr)", async () => {
    // v1.4 phase-1 incident: a worker editing consult.ts DISPLAYED the source line containing
    // "TICKMARKR_EXIT:" — the wait matched it, harvested early, and stall-consulted a healthy worker.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{
        shell: `echo 'src line: waitOutput(slot, "TICKMARKR_EXIT:", ms)' && sleep 2 && echo w > w.txt && ${COMMIT} w`,
        result: { ok: true, summary: "finished after showing the marker" },
      }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-selfref", driver: idriver() });
    expect(s.done).toEqual(["T1"]); // early false-positive harvest would have parked this
    const wr = Journal.open(repo, "run-selfref").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(true);
  }, 30_000);

  // SPEND-01 behavioral proof of the coordinator's correction: an interactive TUI writes the SAME
  // cwd-keyed session store, so collectUsage(cwd) reads real usage — the interactive row is METERED,
  // NOT unmetered. The value arrives via a disk read; no driver.read sits on the usage code path.
  // This locks out any future re-introduction of an `interactive ? undefined : ...` guard (Task 3 drill).
  test("interactive rows ARE metered — usage from the disk store, no driver.read on the path", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo hi > a.txt && ${COMMIT} a`, result: { ok: true, summary: "done interactively" }, usage: { input: 700, output: 42, reasoning: 99 } }] } },
      "visibility:\n  worker: interactive\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-int-metered", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const evs = Journal.open(repo, "run-int-metered").read();
    expect(evs.find((e) => e.event === "worker-result")?.data.mode).toBe("interactive");
    const row = Journal.open(repo, "run-int-metered").readTelemetry().find((r) => r.taskId === "T1")!;
    expect(row.tokens).toEqual({ input: 700, output: 42, reasoning: 99 }); // metered under the interactive path
    expect(row.meteredAttempts).toBe(1);
  }, 30_000);

  test("idle-without-finishing pages too (herdr blocked-scrape is flaky for TUI dialogs)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "sleep 30" }] },
        consult: { action: "human", notes: "operator must look" },
      },
      "taskTimeoutMinutes: 0.02\n",
    );
    const inner = new SubprocessDriver();
    const notified: string[] = [];
    const driver = idriver({
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: (slot: Slot, pattern: string, ms: number, opts?: { regex?: boolean }) =>
        opts?.regex ? Promise.resolve(false) : inner.waitOutput(slot, pattern, ms),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      notify: async (msg: string) => { notified.push(msg); },
      status: async () => "idle", // what cursor's trust dialog actually scraped as in the live check
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-idlepage", driver });
    expect(s.human).toEqual(["T1"]);
    expect(notified.filter((m) => /looks idle without finishing/.test(m))).toHaveLength(1);
  }, 30_000);

  test("a worker emitting output within the stall window is not reaped even when total wall-clock exceeds the window", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{
        shell: `for n in 1 2 3 4 5; do echo "still working $n"; sleep 0.3; done; echo done > done.txt && ${COMMIT} done`,
        result: { ok: true, summary: "finished after active output" },
      }] } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: interactive\n",
    );
    const started = Date.now();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-output-active", driver: idriver() });
    expect(Date.now() - started).toBeGreaterThan(1_200);
    expect(s.done).toEqual(["T1"]);
  }, 30_000);

  test("print workers also reset the stall window from output", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{
        shell: `for n in 1 2 3 4 5; do echo "still working $n"; sleep 0.3; done; echo done > done.txt && ${COMMIT} done`,
        result: { ok: true, summary: "finished after active output" },
      }] } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: print\n",
    );
    expect((await runDaemon(repo, { adapters: [fake], runId: "run-output-print" })).done).toEqual(["T1"]);
  }, 30_000);

  test("a worker silent for the full stall window is reaped", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "stalled" } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: interactive\n",
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-output-silent", driver: idriver() });
    expect(s.human).toEqual(["T1"]);
    expect(Journal.open(repo, "run-output-silent").read().find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
  }, 30_000);

  test("the task-human park event carries a machine-readable kind", async () => {
    const { repo, fake } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
    await runDaemon(repo, { adapters: [fake], runId: "run-park-kind", driver: idriver() });
    expect(Journal.open(repo, "run-park-kind").read().find((e) => e.event === "task-human")?.data.kind).toBe("human-gate");
  }, 30_000);

  test("the standard worker prompt states the non-interactive one-pass contract", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-prompt-contract", driver: idriver() });
    const prompt = readFileSync(join(Journal.open(repo, "run-prompt-contract").dir, "prompts", "T1-a0.md"), "utf8");
    expect(prompt).toContain("non-interactive");
    expect(prompt).toContain("one continuous pass");
  }, 30_000);

  test("the standard worker prompt states the stall-window budget", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] } },
      "taskTimeoutMinutes: 17\n",
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-prompt-budget", driver: idriver() });
    expect(readFileSync(join(Journal.open(repo, "run-prompt-budget").dir, "prompts", "T1-a0.md"), "utf8")).toContain("17 minute stall window");
  }, 30_000);

  // OBS-82: a wedged codex pane repaints only a braille glyph + elapsed-time cell forever. The
  // scripted read below changes BOTH on every poll — raw text never repeats — yet the stall clock
  // must still expire because the normalized snapshot is constant. Consult reads stay real (the
  // override targets only the worker slot), so the fail-closed human park is exercised end to end.
  test("spinner only repaints do not reset the interactive stall clock", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "spinner wedge" } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: interactive\n",
    );
    const inner = new SubprocessDriver();
    const glyphs = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"];
    let n = 0;
    const driver = idriver({
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      notify: inner.notify.bind(inner),
      close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      read: (slot: Slot, lines?: number) =>
        slot.name.includes("-worker-")
          ? Promise.resolve(`${glyphs[++n % glyphs.length]} Starting MCP servers (5/7): context7, sites-design-picker · ${n}s · esc to interrupt`)
          : inner.read(slot, lines),
    });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-spin-int", driver });
    expect(s.human).toEqual(["T1"]);
    expect(Journal.open(repo, "run-spin-int").read().find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
  }, 30_000);

  test("a real output change resets the stall clock", async () => {
    // same OBS-82 startup-status shape, but the server COUNT advances — lexical progress is
    // activity, so the worker outlives several stall windows and finishes.
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{
        shell: `for n in 1 2 3 4 5; do echo "Starting MCP servers ($n/7): context7"; sleep 0.3; done; echo done > done.txt && ${COMMIT} done`,
        result: { ok: true, summary: "progressed past the window" },
      }] } },
      "taskTimeoutMinutes: 0.02\nvisibility:\n  worker: interactive\n",
    );
    const started = Date.now();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-stall-reset", driver: idriver() });
    expect(Date.now() - started).toBeGreaterThan(1_200); // outlived the window ⇒ the clock was reset
    expect(s.done).toEqual(["T1"]);
  }, 30_000);

  test("trailer detection and harvest read unnormalized pane text", async () => {
    // the summary carries exactly the tokens the stall normalizer deletes (braille glyph +
    // elapsed-time word); it must round-trip byte-identical through detection, harvest, and parse.
    const summary = "⠋ verified in 3s";
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo u > u.txt && ${COMMIT} u`, result: { ok: true, summary } }] } },
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-raw-harvest", driver: idriver() });
    expect(s.done).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-raw-harvest").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(true);
    expect(wr?.data.summary).toBe(summary);
  }, 30_000);

  test("the standard worker brief states the verbatim test naming contract", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { acceptance: ["test: auth suite passes"] })],
      { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] } },
    );
    await runDaemon(repo, { adapters: [fake], runId: "run-prompt-test-naming", driver: idriver() });
    const prompt = readFileSync(join(Journal.open(repo, "run-prompt-test-naming").dir, "prompts", "T1-a0.md"), "utf8");
    expect(prompt).toMatch(/verbatim/i);
    expect(prompt).toMatch(/test:.*criterion.*verbatim/i);
  }, 30_000);

  test("an interactive attempt whose first harvest only balances into a valid trailer after a settle re-read is recorded with the re-read's outcome rather than the malformed-trailer cause", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "settled green" } }] } },
      "taskTimeoutMinutes: 0.05\n",
    );
    const driver = stagedInteractiveDriver(repo, "run-settle-green", "T1", [
      "",
      `TICKMARKR_RESULT_<NONCE> {"ok":true, "summary": "settled green`,
      `TICKMARKR_RESULT_<NONCE> {"ok":true, "summary": "settled green`,
      `TICKMARKR_RESULT_<NONCE> {"ok":true,"summary":"settled green","deviations":[]}`,
    ]);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-settle-green", driver });
    expect(s.done).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-settle-green").read().find((e) => e.event === "worker-result");
    expect(wr?.data.ok).toBe(true);
    expect(wr?.data.summary).toBe("settled green");
    expect(wr?.data.cause).toBeUndefined();
  }, 30_000);

  test("an interactive attempt whose harvest never contains the nonce-tagged trailer token is recorded as unparseable without any settle re-read", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "sleep 30" }] }, consult: { action: "human", notes: "no trailer token" } },
      "taskTimeoutMinutes: 0.05\n",
    );
    const started = Date.now();
    const driver = stagedInteractiveDriver(repo, "run-no-token", "T1", [""], { noToken: true });
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-no-token", driver });
    expect(s.human).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-no-token").read().find((e) => e.event === "worker-result");
    expect(wr?.data.ok).toBe(false);
    expect(wr?.data.summary).toBe(NO_TRAILER_SUMMARY);
    expect(wr?.data.cause).toBe("stall-timeout");
    expect(Date.now() - started).toBeLessThan(4_500); // 0.05m stall window + small overhead, no settle retries
  }, 30_000);

  test("the settle re-read is bounded to at most two attempts and never runs out the attempt's own stall window", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "would need three retries" } }] } },
      "taskTimeoutMinutes: 0.05\n",
    );
    const started = Date.now();
    const driver = stagedInteractiveDriver(repo, "run-bound", "T1", [
      "",
      `TICKMARKR_RESULT_<NONCE> {"ok":true, "summary": "x`,
      `TICKMARKR_RESULT_<NONCE> {"ok":true, "summary": "x`,
      `TICKMARKR_RESULT_<NONCE> {"ok":true, "summary": "x`,
      `TICKMARKR_RESULT_<NONCE> {"ok":true, "summary": "x`,
      `TICKMARKR_RESULT_<NONCE> {"ok":true,"summary":"would need three retries","deviations":[]}`,
    ]);
    await runDaemon(repo, { adapters: [fake], runId: "run-bound", driver });
    // Coarse runaway guard only (CI runners measured 3166ms for overhead + two 1s settles — a 3s
    // bound flaked the v1.68.0 release). The real fences are below: cause is malformed-trailer,
    // NOT stall-timeout (settle retries never ate the 0.05m stall window), and the staged good
    // trailer at read 6 was never reached (re-reads bounded at two).
    expect(Date.now() - started).toBeLessThan(10_000);
    const wr = Journal.open(repo, "run-bound").read().find((e) => e.event === "worker-result");
    expect(wr?.data.ok).toBe(false);
    expect(wr?.data.summary).toBe(UNPARSEABLE_TRAILER_SUMMARY);
    expect(wr?.data.cause).toBe("malformed-trailer");
  }, 30_000);

  test("a headless attempt's malformed-trailer handling is unchanged by the settle-retry addition", async () => {
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: {} });
    class MalformedTrailerFake extends FakeAdapter {
      private readonly workerScript = join(dirname(scriptPath), "malformed-headless.sh");
      invoke(task: Task, _cwd: string, _assignment: Assignment, ctx: { promptFile: string }): Invocation {
        const nonce = /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(ctx.promptFile, "utf8"))?.[1] ?? "";
        writeFileSync(this.workerScript, [
          "#!/bin/bash",
          "set -e",
          "echo ok > ok.txt",
          "git add -A",
          "git commit --no-gpg-sign -m ok",
          `echo 'TICKMARKR_RESULT_${nonce} {"ok":true, "summary": "headless unchanged'`,
          `printf '\\nTICKMARKR_EXIT_${nonce}:0\\n'`,
        ].join("\n"));
        return { command: `bash ${shq(this.workerScript)}` };
      }
    }
    const s = await runDaemon(repo, { adapters: [new MalformedTrailerFake(scriptPath)], runId: "run-headless-unchanged" });
    expect(s.done).toEqual(["T1"]);
    const wr = Journal.open(repo, "run-headless-unchanged").read().find((e) => e.event === "worker-result");
    expect(wr?.data.mode).toBe("print");
    expect(wr?.data.ok).toBe(false);
    expect(wr?.data.summary).toBe(UNPARSEABLE_TRAILER_SUMMARY);
    expect(wr?.data.cause).toBe("malformed-trailer");
  }, 30_000);
});
