import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { kimi, KIMI_TRUST_DIALOG } from "../../src/adapters/kimi.js";
import { KIMI_TRUST_PANE, matchesTrustDialog } from "../../src/adapters/types.js";
import type { Assignment, InteractiveSeed, WorkerAdapter } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runDaemon, resetEarlyLaunchLivenessMsForTests, setEarlyLaunchLivenessMsForTests } from "../../src/run/daemon.js";
import { runInteractiveSeed } from "../../src/run/interactive-seed.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

function fakeBannerModel(banner: string): string | undefined {
  const m = /^Model: (.+)$/m.exec(banner);
  if (!m) return undefined;
  const alias = m[1].trim();
  return alias ? `fake-${alias}` : undefined;
}

const SEED: InteractiveSeed = {
  launch: (model: string) => `launch-tui --model ${model}`,
  readinessMatch: "TUI ready",
  seedLine: (promptFile: string) => `read ${promptFile}`,
  confirmBanner: (banner, assignedModel) => {
    const saw = fakeBannerModel(banner);
    if (saw !== undefined && saw !== assignedModel) {
      return { ok: false, error: `model mismatch: expected ${assignedModel}, saw ${saw}` };
    }
    return { ok: true };
  },
};

class SeedFakeAdapter extends FakeAdapter {
  interactiveCommand(): string | null {
    return null;
  }
  interactiveSeed = SEED;
}

interface SeedDriver {
  driver: ExecutorDriver;
  runs: string[];
  waits: { pattern: string; regex?: boolean }[];
  buf: string;
}

function makeSeedDriver(promptFile: string, opts: { ready?: boolean; stick?: boolean } = {}): SeedDriver {
  const runs: string[] = [];
  const waits: { pattern: string; regex?: boolean }[] = [];
  let buf = "";
  const launchCmd = SEED.launch("fake-1");
  const seedCmd = SEED.seedLine(promptFile);

  const driver: ExecutorDriver = {
    id: "seed-spy",
    interactive: true,
    slot: async (cwd: string, name: string) => ({ id: "p1", name, cwd } as Slot),
    run: async (s: Slot, cmd: string) => {
      runs.push(cmd);
      if (cmd === launchCmd) {
        buf += "banner\nTUI ready\n> ";
      } else if (cmd === seedCmd) {
        buf += `\n${cmd}\n`;
        if (!opts.stick) {
          // Simulate the TUI doing the work and emitting a real trailer.
          execSync(`echo done > done.txt && ${COMMIT} done`, { cwd: s.cwd });
          const promptText = readFileSync(promptFile, "utf8");
          const nonce = /TICKMARKR_RESULT_([0-9a-z]+)/.exec(promptText)?.[1] ?? "";
          if (nonce) {
            buf += `TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"seeded","deviations":[]}\n`;
          }
        }
      } else {
        // Execute gate/consult scripts the same way the real subprocess driver would.
        const m = /^bash '(.+)'$/.exec(cmd);
        if (m) {
          try {
            const out = execSync(`bash -lc ${JSON.stringify(m[1])}`, { cwd: s.cwd, encoding: "utf8" });
            buf += out;
          } catch {
            /* gate failures are reflected in the empty buffer */
          }
        }
      }
    },
    waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) => {
      waits.push({ pattern, regex: o?.regex });
      if (pattern === SEED.readinessMatch && opts.ready === false) return false;
      return o?.regex ? new RegExp(pattern).test(buf) : buf.includes(pattern);
    },
    waitAgentStatus: async () => true,
    read: async (_s: Slot, lines: number) => buf.split("\n").slice(-lines).join("\n"),
    status: async () => "unknown",
    notify: async () => {},
    close: async () => {},
    worktree: async (repo: string, branch: string, baseRef: string) => new SubprocessDriver().worktree(repo, branch, baseRef),
  };

  return { driver, runs, waits, buf };
}

const BANNER_ASSIGNMENT: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "mid" };

function makeBannerSeedDriver(banner: string, promptFile: string, opts: { submit?: boolean } = {}) {
  let buf = banner.includes("TUI ready") ? banner : `${banner}\nTUI ready\n> `;
  const runs: string[] = [];
  const seedCmd = SEED.seedLine(promptFile);
  const slot: Slot = { id: "p1", name: "banner-seed", cwd: "/tmp" };

  const driver: ExecutorDriver = {
    id: "banner-seed-stub",
    interactive: true,
    slot: async () => slot,
    run: async (_s: Slot, cmd: string) => {
      runs.push(cmd);
      if (cmd === seedCmd && opts.submit !== false) {
        buf += `\n${cmd}\n[submitted]\n`;
      } else if (cmd === seedCmd) {
        buf += `\n${cmd}\n`;
      }
    },
    waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) =>
      o?.regex ? new RegExp(pattern).test(buf) : buf.includes(pattern),
    waitAgentStatus: async () => true,
    status: async () => "unknown",
    read: async (_s: Slot, lines: number) => buf.split("\n").slice(-lines).join("\n"),
    notify: async () => {},
    close: async () => {},
    worktree: async (repo: string) => repo,
  };

  return { driver, slot, runs, seedCmd };
}

function bannerSeedAdapter(): Pick<WorkerAdapter, "interactiveSeed"> {
  return { interactiveSeed: SEED };
}

// v1.89 T19 / OBS-406 — the RECORDED kimi ordering: the workspace-trust modal renders FIRST and the
// cold-start banner (kimi's own `readinessMatch`) only after it is answered. BOTH panes are imported
// captures, never re-transcribed — the modal from src/adapters/types.ts (OBS-358's live pane) and
// the banner from the committed kimi cold-start frame, which carries the Directory/Session/Model/
// Version rows a real launch prints. Review round 8 (material): the banner here used to be a
// three-line hand-written box with no Model row, so kimi's confirmBanner reached readiness through
// its unknown-model fallback and the trace proved nothing about the recorded launch. The frame's
// own `Model: K2.7 Coding` is why the assignment below is kimi-for-coding.
const KIMI_READY_PANE = readFileSync(
  join(import.meta.dirname, "../fixtures/kimi-editor-readiness/frame-01.txt"),
  "utf8",
);
const KIMI_RECORDED_SESSION = "session_4d758ead-0dd9-475f-8ba4-bfa38741b59e";

const KIMI_ASSIGNMENT: Assignment = {
  adapter: "kimi", model: "kimi-code/kimi-for-coding", channel: "sub", tier: "frontier",
};

function makeKimiModalDriver(
  promptFile: string, opts: { modalAfterMs?: number; model?: string } = {},
) {
  const model = opts.model ?? KIMI_ASSIGNMENT.model;
  const keys: string[] = [];
  const log: string[] = [];
  const slot: Slot = { id: "p1", name: "kimi-modal", cwd: "/tmp" };
  const seedCmd = kimi.interactiveSeed!.seedLine(promptFile);
  let pane = "";
  // A modal is not always painted by the time the launch command returns: a cold CLI can spend a
  // minute on startup before it raises the gate. `modalAfterMs` is how long after launch this pane
  // renders it — 0 (the default) is the immediate case, and every read/wait re-checks the clock.
  let modalAt = Infinity;

  const settle = () => {
    if (Date.now() >= modalAt) {
      pane = KIMI_TRUST_PANE;
      modalAt = Infinity;
      log.push("modal");
    }
  };
  const toReady = () => {
    pane = KIMI_READY_PANE;
    log.push("ready");
  };
  const driver = {
    run: async (_s: Slot, cmd: string) => {
      log.push(`run:${cmd}`);
      if (cmd === kimi.interactiveSeed!.launch(model)) {
        modalAt = Date.now() + (opts.modalAfterMs ?? 0);
        settle();
      } else if (cmd === seedCmd) pane = `${KIMI_READY_PANE}\nworking on the task`;
    },
    waitOutput: async (_s: Slot, pattern: string, ms: number, o?: { regex?: boolean }) => {
      const end = Date.now() + ms;
      for (;;) {
        settle();
        if (o?.regex ? new RegExp(pattern).test(pane) : pane.includes(pattern)) return true;
        if (Date.now() >= end) return false;
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, end - Date.now()))));
      }
    },
    read: async (_s: Slot, lines: number) => {
      settle();
      return pane.split("\n").slice(-lines).join("\n");
    },
    sendKey: async (_s: Slot, key: string) => {
      keys.push(key);
      log.push("key");
      if (pane === KIMI_TRUST_PANE) toReady(); // the modal is what was blocking the banner
    },
  };
  return { driver, slot, keys, log, seedCmd, pane: () => pane };
}

test("an adapter whose trust modal appears before its readiness banner has that modal answered during the pre-readiness seed launch, exercised over the recorded kimi modal-then-banner ordering, so a declaration the run loop consults only after the seed returns is unreachable and fails", async () => {
  const promptFile = "/tmp/kimi-modal-prompt.md";

  // ARM A — production. The launch window belongs to the seed, so the modal is answered inside it.
  const live = makeKimiModalDriver(promptFile);
  const answered = await runInteractiveSeed({
    driver: live.driver, slot: live.slot, adapter: kimi,
    assignment: KIMI_ASSIGNMENT, promptFile, taskTimeoutMinutes: 0.1,
  });
  expect(answered.seedFailed).toBe(false);
  expect(answered.trustAnswered).toBe(true);
  expect(live.keys).toEqual([KIMI_TRUST_DIALOG.key]);
  // ORDERING is the claim, not merely the count: the key lands before the readiness banner exists
  // and before the seed line is injected — i.e. inside the pre-readiness launch.
  expect(live.log.indexOf("key")).toBeGreaterThan(-1);
  expect(live.log.indexOf("key")).toBeLessThan(live.log.indexOf("ready"));
  expect(live.log.indexOf("key")).toBeLessThan(live.log.indexOf(`run:${live.seedCmd}`));
  // The banner the seed proceeded on is the RECORDED one, and production RECOGNIZED it: kimi's own
  // confirmBanner maps the frame's `Model: K2.7 Coding` row to the assigned channel and lifts the
  // launch's session id off it. The unknown-model fallback (what a banner with no Model row buys)
  // reaches readiness too, so a green seed alone is not evidence — the confirmed status is.
  expect(kimi.interactiveSeed!.confirmBanner!(KIMI_READY_PANE, KIMI_ASSIGNMENT.model))
    .toMatchObject({ ok: true, status: "confirmed" });
  expect(answered.sessionId).toBe(KIMI_RECORDED_SESSION);

  // ...and that recognition is load-bearing, proven by an INSTANCE rather than asserted: the same
  // recorded ordering with a DIFFERENT model assigned fails on the banner. The unknown fallback
  // returns ok for every model, so this outcome is unreachable unless the recorded row was read and
  // mapped. The trust modal is still answered exactly once on the way — the key precedes the banner.
  const wrong = makeKimiModalDriver(promptFile, { model: "kimi-code/k3" });
  const mismatched = await runInteractiveSeed({
    driver: wrong.driver, slot: wrong.slot, adapter: kimi,
    assignment: { ...KIMI_ASSIGNMENT, model: "kimi-code/k3" }, promptFile, taskTimeoutMinutes: 0.1,
  });
  expect(mismatched.seedFailed).toBe(true);
  expect(mismatched.seedError).toMatch(/model mismatch: expected kimi-code\/k3, saw kimi-code\/kimi-for-coding/);
  expect(mismatched.trustAnswered).toBe(true);
  expect(wrong.keys).toEqual([KIMI_TRUST_DIALOG.key]);
  expect(wrong.log.indexOf("key")).toBeLessThan(wrong.log.indexOf("ready"));

  // ARM B — the control, and it is an INSTANCE of the defect rather than a description of it: the
  // pre-T19 arrangement, where the seed has no keystroke surface at all and the declaration is
  // consulted only after runInteractiveSeed returns. Same adapter, same recorded ordering.
  const late = makeKimiModalDriver(promptFile);
  const seedOnly = { run: late.driver.run, waitOutput: late.driver.waitOutput, read: late.driver.read };
  const unreached = await runInteractiveSeed({
    driver: seedOnly, slot: late.slot, adapter: kimi,
    assignment: KIMI_ASSIGNMENT, promptFile, taskTimeoutMinutes: 0.02,
  });
  expect(unreached.seedFailed).toBe(true);
  expect(unreached.seedError).toMatch(/readiness pattern not seen/);
  expect(unreached.trustAnswered).toBe(false);
  expect(late.keys).toEqual([]);
  expect(late.log).not.toContain("ready");
  expect(late.log).not.toContain(`run:${late.seedCmd}`);

  // The declaration was correct the whole time — it is the TIMING that made it dead. Matching it
  // here, after the seed has already failed the attempt, is exactly what the run loop would do.
  expect(matchesTrustDialog(late.pane(), kimi.trustDialog)).toBe(true);
  await late.driver.sendKey(late.slot, KIMI_TRUST_DIALOG.key);
  expect(late.keys).toEqual([KIMI_TRUST_DIALOG.key]); // a key, but the seed already failed closed
  expect(unreached.seedFailed).toBe(true);

  // ARM C — the same ordering, painted LATE. "Before the readiness banner" is not "immediately":
  // a cold CLI can spend a minute starting up before it raises the gate, and an observation window
  // shorter than the readiness budget is a stretch of time in which a real modal is never read.
  // Round 7 named the instance — modal at 61s of a two-minute deadline — so it is run here on a
  // fake clock, which costs no wall time and makes the 60-second cutoff the only thing that fails.
  vi.useFakeTimers();
  try {
    const slow = makeKimiModalDriver(promptFile, { modalAfterMs: 61_000 });
    const pending = runInteractiveSeed({
      driver: slow.driver, slot: slow.slot, adapter: kimi,
      assignment: KIMI_ASSIGNMENT, promptFile, taskTimeoutMinutes: 2,
    });
    await vi.advanceTimersByTimeAsync(130_000);
    const answeredLate = await pending;
    expect(answeredLate.seedFailed).toBe(false);
    expect(answeredLate.trustAnswered).toBe(true);
    expect(slow.keys).toEqual([KIMI_TRUST_DIALOG.key]);
    // Still the pre-readiness launch, just later in it — and still one key, not one per poll.
    expect(slow.log.indexOf("key")).toBeGreaterThan(slow.log.indexOf("modal"));
    expect(slow.log.indexOf("key")).toBeLessThan(slow.log.indexOf("ready"));
    expect(slow.log.indexOf("key")).toBeLessThan(slow.log.indexOf(`run:${slow.seedCmd}`));
  } finally {
    vi.useRealTimers();
  }
}, 30_000);

describe("runInteractiveSeed launch banner confirmation", () => {
  test("a launch banner naming the assigned model proceeds to seed injection unchanged", async () => {
    const promptFile = "/tmp/prompt-match.md";
    const banner = "Model: 1\n";
    const { driver, slot, runs, seedCmd } = makeBannerSeedDriver(banner, promptFile);
    const r = await runInteractiveSeed({
      driver,
      slot,
      adapter: bannerSeedAdapter() as WorkerAdapter,
      assignment: BANNER_ASSIGNMENT,
      promptFile,
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(false);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toBe(SEED.launch("fake-1"));
    expect(runs[1]).toBe(seedCmd);
  });

  test("a launch banner naming a different model than the assignment fails the attempt closed before any seed line is injected", async () => {
    const promptFile = "/tmp/prompt-mismatch.md";
    const banner = "Model: 2\n";
    const { driver, slot, runs } = makeBannerSeedDriver(banner, promptFile);
    const r = await runInteractiveSeed({
      driver,
      slot,
      adapter: bannerSeedAdapter() as WorkerAdapter,
      assignment: BANNER_ASSIGNMENT,
      promptFile,
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(true);
    expect(r.seedError).toMatch(/model mismatch/);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe(SEED.launch("fake-1"));
    expect(r.output).toContain("Model: 2");
  });

  test("a launch banner missing a recognizable model line is not treated as a mismatch", async () => {
    const promptFile = "/tmp/prompt-no-model.md";
    const banner = "Session: session_abc\n";
    const { driver, slot, runs, seedCmd } = makeBannerSeedDriver(banner, promptFile);
    const r = await runInteractiveSeed({
      driver,
      slot,
      adapter: bannerSeedAdapter() as WorkerAdapter,
      assignment: BANNER_ASSIGNMENT,
      promptFile,
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(false);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toBe(seedCmd);
  });
});

describe("daemon interactive seed path (fake adapter, zero tokens)", () => {
  test("an adapter declaring the seed capability launches through a launch-then-seed sequence instead of the existing single-command interactive path", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "ok" } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.2\n",
    );
    const promptFile = `${repo}/.tickmarkr/runs/run-seed/prompts/T1-a0.md`;
    const { driver, runs, waits } = makeSeedDriver(promptFile);

    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-seed", driver });
    expect(s.done).toEqual(["T1"]);
    expect(runs[0]).toBe(SEED.launch("fake-1"));
    expect(runs[1]).toBe(SEED.seedLine(promptFile));
    expect(runs.some((r) => r.startsWith("bash "))).toBe(false);
    expect(waits[0]?.pattern).toBe(SEED.readinessMatch);
  }, 30_000);

  test("the seed line is only injected after the launch output matches the adapter's declared readiness pattern", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "ok" } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
    );
    const promptFile = `${repo}/.tickmarkr/runs/run-ready/prompts/T1-a0.md`;
    const { driver, runs, waits } = makeSeedDriver(promptFile, { ready: false });

    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-ready", driver });
    expect(s.done).toEqual([]);
    expect(s.human).toEqual(["T1"]);
    expect(runs).toEqual([SEED.launch("fake-1")]);
    expect(runs).not.toContain(SEED.seedLine(promptFile));
    expect(waits.some((w) => w.pattern === SEED.readinessMatch)).toBe(true);
    const wr = Journal.open(repo, "run-ready").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(false);
  }, 30_000);

  test("after injecting the seed line the daemon reads the pane back and treats a submission that never left the input box as a failure rather than a false start", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "ok" } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
    );
    const promptFile = `${repo}/.tickmarkr/runs/run-stuck/prompts/T1-a0.md`;
    const { driver, runs } = makeSeedDriver(promptFile, { stick: true });

    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-stuck", driver });
    expect(s.done).toEqual([]);
    expect(s.human).toEqual(["T1"]);
    expect(runs).toContain(SEED.launch("fake-1"));
    expect(runs).toContain(SEED.seedLine(promptFile));
    const wr = Journal.open(repo, "run-stuck").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(false);
    expect(wr?.data.summary).not.toBe("seeded");
  }, 30_000);

  test("an adapter without the seed capability dispatches exactly as it does today, unchanged", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "unchanged" } }] } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
    );
    const runs: string[] = [];
    const inner = {
      id: "unchanged-spy",
      interactive: true,
      slot: async (cwd: string, name: string) => ({ id: "p1", name, cwd } as Slot),
      run: async (_s: Slot, cmd: string) => { runs.push(cmd); },
      waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) => {
        if (pattern.includes("TICKMARKR_EXIT")) return true;
        return o?.regex ? new RegExp(pattern).test("") : false;
      },
      waitAgentStatus: async () => true,
      read: async () => "",
      status: async () => "unknown",
      notify: async () => {},
      close: async () => {},
      worktree: async (repo: string, branch: string, baseRef: string) => new SubprocessDriver().worktree(repo, branch, baseRef),
    } as ExecutorDriver;

    await runDaemon(repo, { adapters: [fake], runId: "run-unchanged", driver: inner });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^bash '/);
    expect(runs[0]).not.toContain(SEED.launch("fake-1"));
    expect(runs[0]).not.toContain(SEED.seedLine(`${repo}/.tickmarkr/runs/run-unchanged/prompts/T1-a0.md`));
  }, 30_000);

  test("a seed-mode launch that prints a readiness banner is not classified as an early-launch dead channel while waiting for the worker trailer", async () => {
    setEarlyLaunchLivenessMsForTests(50);
    try {
      const { repo, scriptPath } = setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "stuck after seed" } },
        "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
      );
      const promptFile = `${repo}/.tickmarkr/runs/run-seed-banner/prompts/T1-a0.md`;
      const { driver } = makeSeedDriver(promptFile, { stick: true });
      const started = Date.now();
      const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-seed-banner", driver });
      expect(Date.now() - started).toBeGreaterThan(800);
      expect(s.human).toEqual(["T1"]);
      const evs = Journal.open(repo, "run-seed-banner").read();
      expect(evs.some((e) => e.event === "dead-channel-failover")).toBe(false);
      expect(evs.find((e) => e.event === "worker-result")?.data.cause).toBe("stall-timeout");
    } finally {
      resetEarlyLaunchLivenessMsForTests();
    }
  }, 30_000);
});
