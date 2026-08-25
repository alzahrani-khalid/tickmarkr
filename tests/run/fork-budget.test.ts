import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { run } from "../../src/cli/commands/run.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { FORK_CAP_ENV } from "../../src/run/git.js";
import { COMMIT, authedModels, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

/**
 * T9: the fork budget a run hands its children must come from the concurrency THAT run resolved.
 *
 * Nothing here mocks the seam. Each run's gate commands and its worker shell are real commands that
 * append the value of VITEST_MAX_FORKS, as delivered to that process, to a per-run file — so the
 * assertions read environment values that actual gate shells and actual worker environments
 * received, not a helper's return value. A cap sourced from a re-parse of `process.argv`, from a
 * re-read of the config overlay, or from a process-global captured by whichever run started first
 * writes a different number into those files than the run enforcing it.
 */

const CORES = availableParallelism();
/** The guarantee, restated independently of the implementation. */
// OBS-618: the guarantee now divides by the SPAWN FAN-OUT as well as by concurrency, because one
// vitest fork can hold a daemon and that daemon's git child. Restated here independently of the
// implementation — if this line and git.ts's formula are edited to agree by copying, the pin is dead.
const expectedCap = (concurrency: number) => Math.max(1, Math.floor(CORES / (concurrency * 3)));

const logCmd = (log: string) => `printf '%s\\n' "\${${FORK_CAP_ENV}-unset}" >> ${log}`;

/** A repo whose every gate command and whose worker shell record the fork cap they were handed. */
function budgetRepo(tag: string, cfgExtra: Record<string, unknown> = {}) {
  const dir = makeTestTempDir("tickmarkr-forkbudget-");
  const gateLog = join(dir, `${tag}.gates`);
  const workerLog = join(dir, `${tag}.worker`);
  const gate = logCmd(gateLog);
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1")],
    { tasks: { T1: [{ shell: `${logCmd(workerLog)} && echo T1 > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "done" } }] } },
    stringify({ gates: { build: gate, test: gate, lint: gate }, ...cfgExtra }),
  );
  return { repo, fake, scriptPath, gateLog, workerLog, tag };
}

const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

/**
 * Dispatch through the PRODUCTION CLI entrypoint (`src/cli/commands/run.ts`) with the raw argv.
 * The duplicate-flag rule under test is then the one production applies — its own parseArgs call —
 * rather than a rule this file restates. A production regression that read the FIRST occurrence
 * hands the daemon the other number and every shell below records the wrong cap.
 */
function cliRun(r: { repo: string; scriptPath: string }, argv: string[]) {
  writeDoctor(r.repo, FAKE_ONLY_DOCTOR);
  process.env.TICKMARKR_FAKE_SCRIPT = r.scriptPath;
  return run([...argv, "--driver", "subprocess"], r.repo);
}

const caps = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.trim().length > 0) : [];

/** Every shell that wrote to `log` recorded exactly `cap` — and at least one shell wrote. */
function expectEveryShell(label: string, log: string, cap: number): void {
  const recorded = caps(log);
  expect(recorded.length, `${label}: no shell recorded a cap`).toBeGreaterThan(0);
  expect([...new Set(recorded)], `${label}: recorded caps`).toEqual([String(cap)]);
}

/** Assert over a run's gate shells AND its worker environment together. */
function expectRun(label: string, r: { gateLog: string; workerLog: string }, cap: number): void {
  expectEveryShell(`${label} gate shells`, r.gateLog, cap);
  expectEveryShell(`${label} worker environment`, r.workerLog, cap);
}

const start = (r: { repo: string; fake: unknown; tag: string }, concurrency?: number) =>
  runDaemon(r.repo, { adapters: [r.fake as never], runId: `run-fork-${r.tag}`, concurrency });

async function waitFor(pred: () => boolean, label: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Rewrite the repo's overlay concurrency in place — the mutation a live run must not notice. */
const setOverlayConcurrency = (repo: string, n: number, gate: string) =>
  writeFileSync(
    join(tickmarkrDir(repo), "config.yaml"),
    `judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n`
      + stringify({ concurrency: n, gates: { build: gate, test: gate, lint: gate } }),
  );

const savedArgv = [...process.argv];
const savedOverride = process.env[FORK_CAP_ENV];

/**
 * The operator's own export wins over any derived cap by design (git.ts), and this repository's
 * daemon shell exports one — so a test about the DERIVED value has to start from an unset
 * environment. afterEach puts the operator's value back.
 */
const withoutOperatorOverride = () => { delete process.env[FORK_CAP_ENV]; };

beforeEach(withoutOperatorOverride);
afterEach(() => {
  process.argv = [...savedArgv];
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  if (savedOverride === undefined) delete process.env[FORK_CAP_ENV];
  else process.env[FORK_CAP_ENV] = savedOverride;
});

describe("per-run fork budget (fake adapter, zero tokens)", () => {
  test('test: runDaemon resolves "--concurrency 2 --concurrency 8" and the reverse order; every gate shell and worker environment records caps derived from 8 then 2, while a single-flag control agrees under argv reparse, so first-occurrence or re-derived sources fail', async () => {
    // The raw argv goes to the production CLI, which parses it itself: parseArgs settles a repeated
    // flag on its LAST occurrence, so these two command lines mean 8 and 2. Nothing here parses.
    const forward = budgetRepo("dup-forward");
    await cliRun(forward, ["--concurrency", "2", "--concurrency", "8"]);
    expectRun("--concurrency 2 --concurrency 8", forward, expectedCap(8));

    const reverse = budgetRepo("dup-reverse");
    await cliRun(reverse, ["--concurrency", "8", "--concurrency", "2"]);
    expectRun("--concurrency 8 --concurrency 2", reverse, expectedCap(2));

    // A first-occurrence reading would have handed these two runs each other's caps. They differ
    // whenever the machine can tell 8 apart from 2, which is what makes the pair discriminating.
    if (expectedCap(8) !== expectedCap(2)) {
      expect(caps(forward.gateLog)[0]).not.toBe(caps(reverse.gateLog)[0]);
    }

    // Single-flag control: same meaning, one occurrence — and process.argv is rewritten to a
    // DIFFERENT concurrency while the run is in flight. A cap re-derived from argv at spawn time
    // would change for every shell launched after this line.
    const control = budgetRepo("single-flag");
    const running = cliRun(control, ["--concurrency", "8"]);
    await waitFor(() => existsSync(control.workerLog), "single-flag worker to record its cap");
    const beforeReparse = caps(control.gateLog).length;
    process.argv = ["node", "tkr", "run", "--concurrency", "1"];
    await running;
    expect(caps(control.gateLog).length, "gate shells launched after the argv rewrite").toBeGreaterThan(beforeReparse);
    expectRun("single-flag control", control, expectedCap(8));
  }, 300000);

  test("test: launch overlapping runDaemon calls in one process at concurrency 2 and 8, then a sequential pair, with no reset call; every shell retains its run's cap while an overlay change from 8 to 1 changes neither, so a process-global latch or sequential-only reset fails", async () => {
    // Both runs resolve concurrency from their OWN overlay — no opts.concurrency anywhere here.
    const low = budgetRepo("overlap-2", { concurrency: 2 });
    const high = budgetRepo("overlap-8", { concurrency: 8 });
    const both = Promise.all([start(low), start(high)]);
    // Mid-flight, rewrite the concurrency-8 repo's overlay to 1. Neither run may notice: the low run
    // because the overlay is not its, the high run because its budget was resolved once at start.
    await waitFor(() => existsSync(high.workerLog), "overlapping high run to reach its worker");
    const beforeOverlay = caps(high.gateLog).length;
    setOverlayConcurrency(high.repo, 1, logCmd(high.gateLog));
    await both;
    expect(caps(high.gateLog).length, "gate shells launched after the overlay change").toBeGreaterThan(beforeOverlay);
    expectRun("overlapping run at concurrency 2", low, expectedCap(2));
    expectRun("overlapping run at concurrency 8", high, expectedCap(8));

    // Sequential pair in the same process, no reset call between them. A process-global captured by
    // the first run — or one cleared only by a seam production never calls — hands the second run
    // the first run's cap here.
    const firstSeq = budgetRepo("seq-8", { concurrency: 8 });
    await start(firstSeq);
    const secondSeq = budgetRepo("seq-2", { concurrency: 2 });
    await start(secondSeq);
    expectRun("first sequential run at concurrency 8", firstSeq, expectedCap(8));
    expectRun("second sequential run at concurrency 2", secondSeq, expectedCap(2));
  }, 600000);

  test("test: the per-suite cap equals the floor of cores divided by concurrency with a minimum of one so total test parallelism never exceeds the larger of cores and concurrency, asserted over every shell a run launches at concurrency below, equal to and above the machine core count rather than over a convenient subrange", async () => {
    // Straddle the machine, rather than picking a range where the floor happens to be flattering:
    // one run under the core count, one exactly at it, one above it (where the floor is 0 and the
    // minimum of one is the only thing keeping a suite runnable at all).
    const points = [Math.max(1, CORES - 1), CORES, CORES + 1];
    expect(points[0], "the below-cores point is genuinely below when the machine has >1 core")
      .toBe(CORES > 1 ? CORES - 1 : 1);
    expect(points[2]).toBeGreaterThan(CORES);

    // ⚠ OBS-618: THE THREE POINTS ABOVE CANNOT DISCRIMINATE THE FORMULA. At concurrency >= CORES-1
    // both the old floor(cores/concurrency) and the current floor(cores/(concurrency*3)) bottom out
    // at the minimum of 1, so every observed cap is 1 under EITHER and the run proves only that
    // SOMETHING propagated. A low-concurrency point is what makes this test bite: at concurrency 2 on
    // any machine with >= 12 cores the two formulas give different numbers, and the cap that reaches
    // the gate shells is compared against the independent restatement — so a revert in git.ts OR a
    // silent edit of expectedCap reds here, which comparing the implementation to itself never could.
    const discriminating = CORES >= 12 ? [2] : [];
    for (const concurrency of discriminating) {
      expect(expectedCap(concurrency), `concurrency ${concurrency} must not read as the old floor(cores/concurrency)`)
        .not.toBe(Math.max(1, Math.floor(CORES / concurrency)));
    }

    for (const concurrency of [...discriminating, ...points]) {
      const r = budgetRepo(`formula-${concurrency}`);
      await start(r, concurrency);
      const cap = expectedCap(concurrency);
      expect(cap, `cap at concurrency ${concurrency} is at least one`).toBeGreaterThanOrEqual(1);
      // OBS-618: the guarantee the formula exists to buy is a bound on PROCESSES, not on forks —
      // one vitest fork can hold a daemon and that daemon's git child.
      expect(cap * concurrency * 3, `total process demand at concurrency ${concurrency}`)
        .toBeLessThanOrEqual(Math.max(CORES, concurrency * 3));
      expectRun(`concurrency ${concurrency} (cores ${CORES})`, r, cap);
    }
  }, 600000);

  test("test: run two overlapping runDaemon calls at concurrency 2 and 8, first without an override and then with VITEST_MAX_FORKS=3; every shell in each run records its run-owned derived cap in the first pair and 3 in the override pair, while a mid-run overlay mutation changes neither", async () => {
    const low = budgetRepo("ovr-off-2", { concurrency: 2 });
    const high = budgetRepo("ovr-off-8", { concurrency: 8 });
    const unoverridden = Promise.all([start(low), start(high)]);
    await waitFor(() => existsSync(high.workerLog), "unoverridden high run to reach its worker");
    const beforeUnoverridden = caps(high.gateLog).length;
    setOverlayConcurrency(high.repo, 1, logCmd(high.gateLog));
    await unoverridden;
    expect(caps(high.gateLog).length).toBeGreaterThan(beforeUnoverridden);
    expectRun("no override, concurrency 2", low, expectedCap(2));
    expectRun("no override, concurrency 8", high, expectedCap(8));

    // The operator's own export is the override, and it wins over both runs' derived caps at once.
    process.env[FORK_CAP_ENV] = "3";
    const lowOverridden = budgetRepo("ovr-on-2", { concurrency: 2 });
    const highOverridden = budgetRepo("ovr-on-8", { concurrency: 8 });
    const overridden = Promise.all([start(lowOverridden), start(highOverridden)]);
    await waitFor(() => existsSync(highOverridden.workerLog), "overridden high run to reach its worker");
    const beforeOverridden = caps(highOverridden.gateLog).length;
    setOverlayConcurrency(highOverridden.repo, 1, logCmd(highOverridden.gateLog));
    await overridden;
    expect(caps(highOverridden.gateLog).length).toBeGreaterThan(beforeOverridden);
    expectRun("VITEST_MAX_FORKS=3, concurrency 2", lowOverridden, 3);
    expectRun("VITEST_MAX_FORKS=3, concurrency 8", highOverridden, 3);
  }, 600000);
});
