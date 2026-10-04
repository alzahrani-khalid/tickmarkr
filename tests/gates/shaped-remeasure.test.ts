import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { resetCalmWindowForTests, setCalmWindowForTests, type Baseline } from "../../src/gates/baseline.js";
import { type GateContext, reobserveTestFiles, runGates } from "../../src/gates/run-gates.js";
import { RUNNER_INFRA_DIAGNOSTIC_RE, TIMEOUT_SHAPED_RE, timeoutShaped } from "../../src/gates/timeout-shaped.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import * as budget from "../../src/run/execution-budget.js";
import { gitHead, shGitOk } from "../../src/run/git.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { failureDisposition, reserveInfrastructureRetry } from "../../src/run/recovery.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// v2.6.6 C (D-873). SLOWEST-RUNNER: 3-core macOS under coverage — no wall-time oracle anywhere; calm
// and cancellation are injected observations, and 180000ms is a cleanup ceiling, never a verdict.
const CEILING_MS = 180_000;
const FILES = "abcdef".split("").map((c) => `tests/${c}.test.ts`);
const WORKER_RPC = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';

/** One runner payload: every file passes, the D-873 red family (one failed file, optionally the rest
 * never started, optionally runner diagnostics), or a single-fork pool stranded after a worker RPC
 * timeout (the inner recovery's input, and an infra verdict wherever that recovery may not run). */
type Step = { kind: "clean" } | { kind: "stranded" } | { kind: "red"; failure: string; diagnostics: string[]; neverStarted: boolean };
const clean: Step = { kind: "clean" };
const stranded: Step = { kind: "stranded" };
const red = (failure: string, diagnostics: string[], neverStarted: boolean): Step => ({ kind: "red", failure, diagnostics, neverStarted });
const D873 = red("Error: Test timed out in 20000ms.", [WORKER_RPC], true);

interface Payload { kind: string; files: string[]; work: boolean; nonce: string }

/** A physical stand-in runner resolved as vitest: discovery lists its filters, and every payload
 * writes a nonce-bound production report and appends to an invocation log the gate never reads.
 * Listings are discovery, never counted as payloads. `daemon` steps only payloads over work.txt. */
function runner(steps: Step[], daemon = false) {
  const dir = makeTestTempDir("tkr-shaped-runner-");
  const log = join(dir, "state.json");
  const bin = join(dir, "vitest");
  writeFileSync(log, JSON.stringify({ steps, calls: [] }));
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), args = process.argv.slice(2), log = ${JSON.stringify(log)};
const all = ${JSON.stringify(FILES)}, worker = ${JSON.stringify(WORKER_RPC)};
const filters = args.filter(a => !a.startsWith('-') && a.endsWith('.test.ts'));
const excluded = args.filter(a => a.startsWith('--exclude=')).map(a => a.slice(10));
const files = all.filter(f => (!filters.length || filters.some(q => q === f || q.endsWith('/' + f))) && !excluded.includes(f));
if (args[0] === 'list') { console.log(JSON.stringify(files.map(f => ({ file: path.resolve(f) })))); process.exit(0); }
const state = JSON.parse(fs.readFileSync(log, 'utf8')), work = fs.existsSync('work.txt');
const index = ${daemon} ? state.calls.filter(c => c.work).length : state.calls.length;
const step = ${daemon} && !work ? { kind: 'clean' } : state.steps[Math.min(index, state.steps.length - 1)];
const nonce = process.env.TICKMARKR_TEST_NONCE, now = Date.now();
state.calls.push({ kind: step.kind, files, work, nonce }); fs.writeFileSync(log, JSON.stringify(state));
const passed = () => ({ at: now, status: 'passed', tests: { passed: 1, failed: 0, skipped: 0 } });
const report = { nonce, requested: files, started: Object.fromEntries(files.map(f => [f, now])),
  completed: Object.fromEntries(files.map(f => [f, passed()])), certificate: { at: now, exitCode: 0, errors: 0, diagnostics: [] } };
let code = 0;
if (step.kind === 'stranded') {
  code = 1;
  report.scheduling = Object.fromEntries(files.map(f => [f, { pool: 'forks', singleFork: f !== all[0] }]));
  report.started = { [all[0]]: now }; report.completed = { [all[0]]: passed() };
  report.certificate = { at: now, exitCode: 1, errors: 1, diagnostics: [worker] };
} else if (step.kind === 'red') {
  code = 1;
  const f = files[0], failed = { at: now, status: 'failed', tests: { passed: 0, failed: 1, skipped: 0 }, failures: [step.failure] };
  if (step.neverStarted) { report.started = { [f]: now }; report.completed = { [f]: failed }; } else report.completed[f] = failed;
  report.certificate = { at: now, exitCode: 1, errors: step.diagnostics.length, diagnostics: step.diagnostics };
}
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify(report));
process.exit(code);
`, { mode: 0o755 });
  return { command: `'${bin}' run`, calls: () => (JSON.parse(readFileSync(log, "utf8")) as { calls: Payload[] }).calls };
}

const baseline: Baseline = { commands: { test: { exitCode: 0, fingerprints: [], ceilingMs: 60_000 } } };
const task = validateGraph({ version: 1, spec: { source: "native", paths: ["s"], hash: "h" }, tasks: [
  { id: "T1", title: "proof", goal: "proof", shape: "implement", complexity: 3, files: ["**"], acceptance: ["done"],
    gates: ["build", "test", "lint", "evidence", "scope"] },
] }).tasks[0]!;
// v2.6.7 T1: an attributed diagnostic only runs beside a semantic gate; test-only verification keeps full scope.
const diagnosed = { ...task, gates: [...task.gates, "acceptance" as const] };
function judged() {
  const scriptPath = join(makeTestTempDir("tickmarkr-judged-"), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  return { cfg, adapters: [new FakeAdapter(scriptPath)] };
}
const fixture = () => makeRepo({ ".gitignore": ".tickmarkr/\nnode_modules/\n.vitest-cache/\n",
  ...Object.fromEntries(FILES.map((f) => [f, "// stand-in runner fixture\n"])) });

interface Policy {
  authorizeInfraRetry?: (subject: string, cause?: "infrastructure" | "host-starved") => boolean; selectTests?: boolean;
  requiredRepairTests?: string[]; selectionReason?: string; baseline?: Baseline; onGate?: GateContext["onGate"];
}
/** One production runGates round over a worker commit; `touch` edits test files so a screen selects them. */
async function round(repo: string, cmd: string, policy: Policy = {}, touch: string[] = []): Promise<GateResult> {
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "work.txt"), "work\n");
  for (const f of touch) writeFileSync(join(repo, f), "// touched by the worker\n");
  await shGitOk("git add -A && git commit --no-gpg-sign -m work", repo);
  const { results } = await runGates(policy.requiredRepairTests ? diagnosed : task, { worktree: repo, baseRef, commands: { test: cmd }, baseline,
    author: { adapter: "fake", model: "fake-1", tier: "frontier", channel: "sub" }, channels: [], adapters: [],
    result: { ok: true, summary: "work", deviations: [], raw: "" }, cfg: structuredClone(DEFAULT_CONFIG),
    ...(policy.requiredRepairTests ? judged() : {}), ...policy });
  return results.find((g) => g.gate === "test")!;
}

/** The bounded policy exactly as the daemon builds it: the production reservation over a journal. */
function bounded(rows: JournalEvent[] = []) {
  const append = (event: string, taskId: string, data: Record<string, unknown>) => rows.push({ event, taskId, data, ts: new Date().toISOString() });
  const authorizeInfraRetry = vi.fn((subject: string, cause?: "infrastructure" | "host-starved") => reserveInfrastructureRetry(rows, "T1", subject, append, cause));
  return { rows, authorizeInfraRetry, reserved: () => rows.filter((e) => e.event === "infra-retry-reserved") };
}

afterEach(() => { resetCalmWindowForTests(); vi.restoreAllMocks(); });

test("production runGates remeasures the exact original two-file D-873-shaped selection once preserving both receipt histories plus authoritative second meta and remeasured versus never-started-zero or assertion reds using one payload that stay red", async () => {
  setCalmWindowForTests({ loadProvider: () => 0 });
  const pair = FILES.slice(0, 2);
  // The closed spelling table: each row's first payload, and whether the daemon's predicate calls it shaped.
  const ansi = "Error: \u001b[31mTest timed out in 20000ms\u001b[39m.";
  const table: Array<[string, Step, boolean]> = [
    ["D-873: Test timed out, never-started 1 and a worker RPC timeout", D873, true],
    ["Hook timed out beside never-started 1", red("Error: Hook timed out in 10000ms.", [], true), true],
    ["wall form expected n to be less than m beside never-started 1", red("AssertionError: expected 25000 to be less than 20000", [], true), true],
    ["[vitest-worker]: Timeout calling alone (never-started 0)", red("Error: Test timed out in 20000ms.", [WORKER_RPC], false), true],
    ["masked never-started # alone", red("Error: Test timed out in 20000ms.", ["runner-level diagnostic: never-started #; reporter errors #"], false), true],
    ["ANSI-wrapped timeout beside a worker RPC timeout", red(ansi, [WORKER_RPC], false), true],
    ["timeout with never-started 0 and reporter errors 0", red("Error: Test timed out in 20000ms.", [], false), false],
    ["assertion red beside the D-873 runner diagnostics", red("AssertionError: expected 1 to be 2", [WORKER_RPC], true), false],
  ];
  // The ANSI row is shaped only because the predicate reads the readable excerpt.
  expect(TIMEOUT_SHAPED_RE.test(ansi)).toBe(false);
  expect(timeoutShaped(ansi)).toBe(true);
  for (const [label, step, shaped] of table) {
    const r = runner([step, clean]);
    const repo = fixture();
    const cmd = `${r.command} ${pair.join(" ")}`;
    const result = await round(repo, cmd);
    const calls = r.calls();
    const remeasured = result.meta?.remeasured as { count: number; firstReportPath: string; first: { pass: boolean; details: string; meta: Record<string, unknown> } } | undefined;
    // The first sample's details, as the gate measured them, are exactly what the exported predicate reads.
    const first = remeasured?.first.details ?? result.details;
    expect(timeoutShaped(first) && RUNNER_INFRA_DIAGNOSTIC_RE.test(first), label).toBe(shaped);
    if (!shaped) {
      // One payload, and the red stands as a work verdict.
      expect(calls, label).toHaveLength(1);
      expect(result.pass, label).toBe(false);
      expect(failureDisposition(result), label).toBe("behavioral");
      expect(result.meta?.remeasured, label).toBeUndefined();
      continue;
    }
    // Exactly one more payload over the exact original selection, after which the second sample decides.
    expect(calls.map((c) => c.files), label).toEqual([pair, pair]);
    expect(calls.map((c) => c.kind), label).toEqual(["red", "clean"]);
    expect(result.pass, `${label}: ${result.details}`).toBe(true);
    expect(remeasured, label).toMatchObject({ count: 1, waitedMs: expect.any(Number), first: { pass: false, meta: { classification: "regression" } } });
    expect(result.meta?.runnerInfraRerun, label).toBeUndefined();
    // Authoritative second meta: its nonce, report and command; the first's survive under remeasured.
    expect(result.meta?.nonce, label).toBe(calls[1]!.nonce);
    expect(remeasured!.first.meta.nonce, label).toBe(calls[0]!.nonce);
    expect(result.meta?.reportPath, label).not.toBe(remeasured!.firstReportPath);
    expect(String(result.meta?.spawnedCommand).startsWith(cmd), label).toBe(true);
    expect(String(remeasured!.first.meta.spawnedCommand).startsWith(cmd), label).toBe(true);
    // Both receipt histories: two discoveries and two payloads, four distinct invocations, in order.
    expect(result.evidenceReceipts, label).toHaveLength(4);
    expect(new Set(result.evidenceReceipts!.map((e) => e.invocationId)).size, label).toBe(4);
    const payloadReceipts = result.evidenceReceipts!.filter((e) => calls.some((c) => c.nonce === e.nonce)).map((e) => e.nonce);
    expect(payloadReceipts, label).toEqual(calls.map((c) => c.nonce));
    expect(result.evidenceReceipt?.nonce, label).toBe(calls[1]!.nonce);
  }

  // The same D-873 row as an admitted attributed test-red diagnostic (v2.6.7 T1: comparable timing,
  // 10000 ms and 1/13 of the suite, with per-file hang budgets far above the stand-in's runtime): the
  // diagnostic's own two-file selection is what is remeasured, and the merge-candidate full suite still runs after it.
  const screen = runner([D873, clean, clean]);
  const timed: Baseline = { commands: { test: { ...baseline.commands.test!,
    fileDurations: FILES.map((file) => ({ file, durationMs: pair.includes(file) ? 5_000 : 30_000 })) } } };
  const ends: GateResult[] = [];
  const result = await round(fixture(), screen.command, { selectTests: true, requiredRepairTests: pair, selectionReason: "known-failing-files",
    baseline: timed, onGate: (e) => { if (e.phase === "end" && e.gate === "test") ends.push(e.result); } }, pair);
  expect(screen.calls().map((c) => c.files)).toEqual([pair, pair, FILES]);
  expect(result.pass, result.details).toBe(true);
  expect(result.meta).toMatchObject({ fullSuite: true, selectedTests: pair });
  // the diagnostic's own published row keeps both remeasured histories; the full row keeps its own
  expect(ends.map((r) => r.evidenceReceipts?.length)).toEqual([4, 2]);

  // A persistent shaped red stays red on its second sample: two payloads, never a third.
  const persistent = runner([D873, D873]);
  const stays = await round(fixture(), `${persistent.command} ${pair.join(" ")}`);
  expect(persistent.calls()).toHaveLength(2);
  expect(stays.pass).toBe(false);
  expect(failureDisposition(stays)).toBe("behavioral");
  expect(stays.meta?.remeasured).toMatchObject({ count: 1, first: { pass: false } });
}, CEILING_MS);

test("production runGates executes all 27 closed default/bounded composition rows under one outer latch across prior recovery plus clean/shaped/infra second outcomes plus cancellation/exhausted allowance", async () => {
  setCalmWindowForTests({ loadProvider: () => 0 });
  const outcomes = { clean, shaped: D873, infra: stranded } as const;
  type Outcome = keyof typeof outcomes;
  const rows: Array<Record<string, unknown>> = [];
  for (const policy of ["default", "bounded"] as const) {
    for (const prior of ["none", "clean", "shaped", "infra"] as const) {
      for (const second of ["clean", "shaped", "infra"] as Outcome[]) {
        const label = `${policy}/${prior}/${second}`;
        // none: a D-873 first payload, then the second outcome. A prior recovery: the inner stranded
        // single-fork recovery's two payloads (stranded, then its tail) — `second` is planned, never bought.
        const r = runner(prior === "none" ? [D873, outcomes[second]] : [stranded, outcomes[prior], outcomes[second]]);
        const allowance = bounded();
        const repo = fixture();
        const result = await round(repo, r.command, policy === "bounded" ? { authorizeInfraRetry: allowance.authorizeInfraRetry } : {});
        const calls = r.calls();
        expect(calls, label).toHaveLength(2);
        const green = prior === "clean" || (prior === "none" && second === "clean");
        expect(result.pass, `${label}: ${result.details}`).toBe(green);
        const disposition = failureDisposition(result);
        if (prior === "none") {
          expect(calls.map((c) => c.files), label).toEqual([FILES, FILES]);
          expect(result.meta?.remeasured, label).toMatchObject({ count: 1 });
          expect(result.meta?.recovery, label).toBeUndefined(); // a stranded second never stacks the inner recovery
          expect(disposition, label).toBe(second === "clean" ? "unknown" : second === "shaped" ? "behavioral" : "infrastructure");
        } else {
          expect(calls.map((c) => c.kind), label).toEqual(["stranded", outcomes[prior].kind]);
          expect(result.meta?.retryable, label).toBe(false);
          expect(result.meta?.recovery, label).toBeDefined();
          expect(result.meta?.remeasured ?? result.meta?.runnerInfraRerun, label).toBeUndefined();
          expect(disposition, label).toBe(prior === "clean" ? "unknown" : prior === "shaped" ? "behavioral" : "infrastructure");
        }
        // The bounded allowance is spent once by the one outer remeasure and never by a recovered measurement.
        if (policy === "bounded") {
          expect(allowance.authorizeInfraRetry, label).toHaveBeenCalledTimes(prior === "none" ? 1 : 0);
          expect(allowance.reserved().map((e) => e.data.cause), label).toEqual(prior === "none" ? ["infrastructure"] : []);
        }
        // A behavioral red still reaches the daemon's unchanged one-payload diagnostic re-observation.
        let diagnostic = 0;
        if (!result.pass && disposition === "behavioral") {
          const failing = (result.meta?.failingFiles as string[] | undefined) ?? [];
          expect(failing.length, label).toBeGreaterThan(0);
          const reobserved = await reobserveTestFiles(repo, r.command, baseline, failing);
          diagnostic = r.calls().length - calls.length;
          expect(diagnostic, label).toBe(1);
          expect(reobserved.meta?.remeasured, label).toBeUndefined();
        }
        const total = r.calls().length;
        expect(total, label).toBeLessThanOrEqual(green ? 2 : 3);
        rows.push({ policy, prior, second, payloads: calls.length, pass: result.pass, disposition, diagnostic, total });
      }
    }
  }
  // Bounded exhausted allowance: the production reservation refuses, so the red is never re-measured.
  {
    const r = runner([D873, clean]);
    const exhausted = bounded([0, 1].map((n) => ({ event: "infra-retry-reserved", taskId: "T1", ts: "2026-10-02T00:00:00Z",
      data: { subject: `earlier-subject-${n}`, cause: "infrastructure", consumed: n + 1 } })));
    const result = await round(fixture(), r.command, { authorizeInfraRetry: exhausted.authorizeInfraRetry });
    expect(r.calls()).toHaveLength(1);
    expect(result.pass).toBe(false);
    expect(result.meta?.recoveryBlocked).toMatch(/allowance exhausted/);
    expect(exhausted.rows.filter((e) => e.event === "infra-retry-denied").map((e) => e.data.reason)).toEqual(["task-allowance-exhausted"]);
    rows.push({ policy: "bounded", exhausted: true, payloads: 1, pass: false });
  }
  // Cancellation after the first complete measurement, in both policies: the calm wait observes the
  // aborted execution signal and no second payload is bought.
  for (const policy of ["default", "bounded"] as const) {
    const r = runner([D873, clean]);
    const controller = new AbortController();
    vi.spyOn(budget, "executionSignal").mockImplementation(() => controller.signal);
    setCalmWindowForTests({ loadProvider: () => { controller.abort(new Error("fixture cancellation after the first measurement")); return 0; } });
    const allowance = bounded();
    await expect(round(fixture(), r.command, policy === "bounded" ? { authorizeInfraRetry: allowance.authorizeInfraRetry } : {}))
      .rejects.toThrow(/fixture cancellation/);
    expect(r.calls(), policy).toHaveLength(1);
    expect(allowance.authorizeInfraRetry, policy).not.toHaveBeenCalled();
    rows.push({ policy, cancellation: true, payloads: 1, pass: false });
    vi.restoreAllMocks();
    setCalmWindowForTests({ loadProvider: () => 0 });
  }
  expect(rows).toHaveLength(27);
}, CEILING_MS);

test("production runDaemon merges a recovered full-suite timeout sample without isolated adjudication", async () => {
  setCalmWindowForTests({ loadProvider: () => 0 });
  const r = runner([D873, clean], true);
  const { repo, fake } = setupRepo([T("T1", { files: ["work.txt"], gates: ["build", "test", "lint", "evidence", "scope"] })], {
    tasks: { T1: [{ shell: `echo work > work.txt && ${COMMIT} work`, result: { ok: true, summary: "work" } }] },
  }, stringify({ gates: { build: "true", test: r.command, lint: "true" } }));
  const result = await runDaemon(repo, { adapters: [fake], runId: "run-shaped-merge" });
  expect(result.done).toEqual(["T1"]);
  const work = r.calls().filter((c) => c.work);
  // The task's full suite: a D-873 red, then its one remeasurement — no isolated subset ever ran.
  expect(work.slice(0, 2).map((c) => [c.kind, c.files])).toEqual([["red", FILES], ["clean", FILES]]);
  expect(r.calls().every((c) => c.files.length === FILES.length)).toBe(true);
  const rows = Journal.open(repo, "run-shaped-merge").read().filter((e) => e.taskId === "T1");
  expect(rows.filter((e) => e.event === "gate-reobserved")).toEqual([]);
  expect(rows.filter((e) => e.event === "task-human")).toEqual([]);
  expect(rows.filter((e) => e.event === "merge")).toHaveLength(1);
  const tests = rows.filter((e) => e.event === "gate-result" && e.data.gate === "test");
  expect(tests.at(-1)?.data.pass).toBe(true);
  expect(tests.some((e) => e.data.pass === false)).toBe(false);
}, CEILING_MS);
