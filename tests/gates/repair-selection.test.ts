import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline, type Baseline } from "../../src/gates/baseline.js";
import { computeVerificationIdentity, getVerdictStore, resolveStateDir, type StoredVerdictRecord } from "../../src/gates/cache.js";
import { diagnosticAdmission, runGates, testCommandForFiles, type GateContext, type GateEvent } from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import { FORK_CAP_ENV, resolvedCapacity } from "../../src/run/git.js";
import type { StructuredFinding } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (repo: string) => {
  git(repo, "add", "-A");
  git(repo, "commit", "--no-gpg-sign", "-m", "repair");
};

// The runner records actual executions. Its ignored controls inject failures AFTER the
// green baseline without changing the subject or adding unrelated dirty-tree refusals.
async function fixture(mode: "green" | "selected-red" | "full-red" | "full-killed", renameRequired = false) {
  const repo = makeRepo({
    "src/changed.ts": "export const changed = 1;\n",
    "src/separate.ts": "export const separate = 1;\n",
    "tests/changed.test.ts": 'import { changed } from "../src/changed.js";\nchanged;\n',
    "tests/repair.test.ts": 'import { separate } from "../src/separate.js";\nseparate;\n',
    "tests/hidden.test.ts": "// A regression outside the import-based selection.\n",
    ".gitignore": "executions.log\noutcome.flag\n",
    "run.sh": [
      'echo "$*" >> executions.log',
      'mode=$(cat outcome.flag 2>/dev/null || true)',
      'if [ "$mode" = selected-red ] && [ "$#" -gt 0 ]; then',
      "  echo 'FAIL tests/repair.test.ts > known defect'",
      "  exit 1",
      "fi",
      'if [ "$mode" = full-killed ] && [ "$#" -eq 0 ]; then kill -KILL $$; fi', // a real signal, named by no output
      'if [ "$mode" = full-red ] && [ "$#" -eq 0 ]; then',
      "  echo 'FAIL tests/hidden.test.ts > omitted regression'",
      "  exit 1",
      "fi",
      "exit 0",
    ].join("\n"),
  });
  const baseRef = git(repo, "rev-parse", "HEAD");
  const commands = { test: "sh run.sh" };
  // v2.6.7 T1: comparable harness timing admits the attributed diagnostic (10 % of the suite, 10 ms).
  const baseline = timed(await captureBaseline(repo, commands),
    { "tests/changed.test.ts": 5, "tests/repair.test.ts": 5, "tests/hidden.test.ts": 90 });
  writeFileSync(join(repo, "src/changed.ts"), "export const changed = 2;\n");
  if (renameRequired) git(repo, "mv", "tests/repair.test.ts", "tests/renamed.test.ts");
  commit(repo);
  writeFileSync(join(repo, "outcome.flag"), mode);
  const task = validateGraph({
    version: 1, spec: { source: "native", paths: ["spec.md"], hash: "repair-fixture" },
    tasks: [{ id: "T1", title: "repair", goal: "repair a known regression", shape: "implement",
      complexity: 3, files: ["**"], acceptance: ["the defect is fixed"],
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] }],
  }).tasks[0];
  const ends: GateEvent[] = [];
  const context: GateContext = {
    worktree: repo, baseRef, commands, baseline, channels: [],
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    result: { ok: true, summary: "repaired", deviations: [], raw: "" },
    ...judged(), selectTests: true,
    requiredRepairTests: ["tests/repair.test.ts"], selectionReason: "known-failing-tests",
    onGate: (event) => { if (event.phase === "end") ends.push(event); },
  };
  const logged = () => readFileSync(join(repo, "executions.log"), "utf8").split("\n").slice(0, -1);
  const run = async (overrides: Partial<GateContext> = {}) => {
    // Only this round's executions: the first run excludes baseline capture's line.
    const seen = logged().length;
    ends.length = 0;
    const round = await runGates(task, { ...context, ...overrides });
    const verdict = round.results.find((result) => result.gate === "test")!;
    const executions = logged().slice(seen);
    // An admitted diagnostic publishes its own selected row; the returned verdict is the LAST test end.
    const testEnds = ends.filter((event) => event.gate === "test");
    expect(testEnds.at(-1)).toMatchObject({ result: verdict });
    return { round, verdict, executions };
  };
  return { repo, run, baseline, commands };
}

const repairSelection = "tests/changed.test.ts tests/repair.test.ts";

/** v2.6.7 T1: a diagnostic only runs beside a semantic gate — test-only verification keeps its full scope. */
function judged(): Pick<GateContext, "cfg" | "adapters"> {
  const scriptPath = join(mkdtempSync(join(tmpdir(), "tickmarkr-judged-")), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  return { cfg, adapters: [new FakeAdapter(scriptPath)] };
}

describe("repair selection preserves complete candidate verification", () => {
  test("a selected repair that remains red buys no full-suite execution", async () => {
    const { run } = await fixture("selected-red");
    const { round, verdict, executions } = await run();
    expect(executions).toEqual([repairSelection]);
    expect(verdict.pass).toBe(false);
    expect(verdict.meta?.fullSuite).not.toBe(true);
    expect(verdict.meta?.selectionDecision).toMatchObject({ scope: "selected", reason: "diagnostic-admitted" });
    expect(round.results.every((result) => result.pass)).toBe(false);
  });

  test("a signal-killed diagnostic or full job beside a red baseline is never forgiven green or cached", async () => {
    // A red baseline forgives a red with no fresh failure line; a SIGKILL'd runner prints nothing, so only the
    // authoritative termination receipt shows it never completed a suite.
    const { run, baseline } = await fixture("full-killed");
    const red = { ...baseline, commands: { ...baseline.commands, test: { ...baseline.commands.test!, exitCode: 1 } } };
    for (let round = 0; round < 2; round++) { // a cached green would answer the second round without a job
      const { round: result, verdict, executions } = await run({ baseline: red });
      expect(executions).toContain("");
      expect(verdict).toMatchObject({ pass: false, meta: { infra: true, kind: "signal-exit" },
        evidenceReceipt: { termination: { kind: "signal", signal: "SIGKILL" } } });
      expect(result.results.every((r) => r.pass)).toBe(false);
    }
  });

  test("a green selected repair still requires a complete candidate suite", async () => {
    const { run } = await fixture("green");
    const { round, verdict, executions } = await run();
    expect(executions).toEqual([repairSelection, ""]);
    expect(verdict.meta?.fullSuite).toBe(true);
    expect(verdict.meta?.selectedTests).toEqual(repairSelection.split(" "));
    expect(round.results.every((result) => result.pass)).toBe(true);
  });

  test("a known failing file is selected even when no changed import reaches it", async () => {
    const ordinary = await fixture("selected-red");
    // No attributed failing file: no diagnostic at all, only the one full job.
    const ordinaryRound = await ordinary.run({ requiredRepairTests: [], selectionReason: "affected-tests" });
    expect(ordinaryRound.executions).toEqual([""]);
    // The recorded reason is the eligibility check that failed, never the caller's "affected-tests" label.
    expect(ordinaryRound.verdict.meta?.selectionDecision).toMatchObject({ scope: "full", reason: "no-required-repair-tests" });
    const repair = await fixture("selected-red");
    const repairedRound = await repair.run();
    expect(repairedRound.executions).toEqual([repairSelection]);
    expect(repairedRound.verdict.meta?.selectionDecision).toMatchObject({ requiredFiles: ["tests/repair.test.ts"] });
  });

  test.each(["missing", "renamed"] as const)("a %s required file falls back to one full suite", async (kind) => {
    const { run } = await fixture("green", kind === "renamed");
    const { verdict, executions } = await run(kind === "missing" ? { requiredRepairTests: ["tests/missing.test.ts"] } : {});
    expect(executions).toEqual([""]);
    expect(verdict.pass).toBe(true);
    expect(verdict.meta?.selectedTests).toBeUndefined();
    expect(verdict.meta?.selectionDecision).toMatchObject({ scope: "full" });
  });

  test("an omitted regression discovered by the full candidate suite prevents a green round", async () => {
    const { run } = await fixture("full-red");
    const { round, verdict, executions } = await run();
    expect(executions).toEqual([repairSelection, ""]);
    expect(verdict.meta?.fullSuite).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.details).toContain("tests/hidden.test.ts");
    expect(round.results.every((result) => result.pass)).toBe(false);
  });
});

const timed = (baseline: Baseline, durations: Record<string, number>): Baseline => ({ ...baseline, commands: { ...baseline.commands,
  test: { ...baseline.commands.test!, fileDurations: Object.entries(durations).map(([file, durationMs]) => ({ file, durationMs })) } } });

test("runGates admits the attributed diagnostic at ratio 0.15 and estimate 60000 ms versus one full invocation above either bound or on unknown timing and uses a qualified full-green hit before any diagnostic, so a selected-only hit authorizing merge fails", async () => {
  // Harness-measured baseline timing at both admission boundaries: the diagnostic runs, then the full job.
  for (const [durations, costRatio, estimatedMs] of [
    [{ "tests/changed.test.ts": 10, "tests/repair.test.ts": 5, "tests/hidden.test.ts": 85 }, 0.15, 15],
    [{ "tests/changed.test.ts": 30_000, "tests/repair.test.ts": 30_000, "tests/hidden.test.ts": 340_000 }, 0.15, 60_000],
  ] as const) {
    const admitted = await fixture("green");
    const round = await admitted.run({ baseline: timed(admitted.baseline, durations) });
    expect(round.executions).toEqual([repairSelection, ""]);
    expect(round.verdict.meta).toMatchObject({ fullSuite: true,
      selectionDecision: { scope: "selected", reason: "diagnostic-admitted", costRatio, estimatedMs } });
    expect(round.round.results.every((result) => result.pass)).toBe(true);
  }

  for (const [durations, reason] of [
    [{ "tests/changed.test.ts": 10, "tests/repair.test.ts": 6, "tests/hidden.test.ts": 84 }, "diagnostic-cost-ratio"], // 0.16
    [{ "tests/changed.test.ts": 30_001, "tests/repair.test.ts": 30_000, "tests/hidden.test.ts": 400_000 }, "diagnostic-cost-estimate"], // 60001 ms
    [{ "tests/changed.test.ts": 40, "tests/hidden.test.ts": 60 }, "diagnostic-unknown-cost"], // a selected file without a measurement
    [undefined, "diagnostic-unknown-cost"], // no per-file timing at all
  ] as const) {
    const skipped = await fixture("green");
    const baseline = durations ? timed(skipped.baseline, durations)
      : { ...skipped.baseline, commands: { ...skipped.baseline.commands, test: { ...skipped.baseline.commands.test!, fileDurations: undefined } } };
    const round = await skipped.run({ baseline });
    expect({ durations, executions: round.executions }).toEqual({ durations, executions: [""] });
    expect(round.verdict.pass).toBe(true);
    expect(round.verdict.meta?.selectedTests).toBeUndefined();
    expect(round.verdict.meta?.selectionDecision).toMatchObject({ scope: "full", reason });
  }

  // A full green already measured on this exact identity answers before any diagnostic is bought.
  const cached = await fixture("green");
  expect((await cached.run({ selectTests: false })).executions).toEqual([""]);
  const hit = await cached.run();
  expect(hit.executions).toEqual([]);
  expect(hit.verdict.pass).toBe(true);
  expect(hit.verdict.meta).toMatchObject({ reused: true, selectionDecision: { scope: "full", reason: "full-green-cache" } });

  // A green recorded only for the selection is not full evidence: the full suite still runs and reds.
  const selectedOnly = await fixture("full-red");
  const selection = repairSelection.split(" ");
  const identity = await computeVerificationIdentity({ worktree: selectedOnly.repo, gate: "test",
    command: testCommandForFiles(selectedOnly.commands.test, selection), baseline: selectedOnly.baseline, selectedSet: selection });
  expect(getVerdictStore(resolveStateDir(selectedOnly.repo)).set(identity, { gate: "test", pass: true, details: "selected green" })).toBe(true);
  const refused = await selectedOnly.run();
  // (that planted green carries no exit receipt, so it is unavailable proof: the diagnostic measures fresh too)
  expect(refused.executions).toEqual([repairSelection, ""]);
  expect(refused.verdict.pass).toBe(false);
  expect(refused.verdict.meta?.fullSuite).toBe(true);
  expect(refused.round.results.every((result) => result.pass)).toBe(false);

  // A manifested runner: a full green qualifies only for the manifest it certified. An ignored
  // generated test the runner now collects moves no tree or environment identity, so the hit no
  // longer answers — its one timed file is the whole suite (over the ratio bound), and a fresh full suite certifies the larger manifest.
  for (const generated of [false, true]) {
    const repo = makeRepo({
      ".gitignore": "node_modules/\ntests/generated.test.ts\n",
      "src/a.ts": "export const a = 1;\n",
      "tests/a.test.ts": 'import { a } from "../src/a"; test("alpha", () => expect(a).toBeGreaterThan(0));\n',
      "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals" } }),
    });
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
    const baseRef = git(repo, "rev-parse", "HEAD");
    const commands = { test: "vitest run --globals" };
    // a trivial file can measure 0 ms (unknown cost); pin its timing so the ratio bound is what decides
    const baseline = timed(await captureBaseline(repo, commands), { "tests/a.test.ts": 5 });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commit(repo);
    const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "manifest" }, tasks: [{ id: "T1", title: "m",
      goal: "m", shape: "implement", complexity: 3, files: ["**"], acceptance: ["done"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] }] }).tasks[0];
    const round = async (selectTests: boolean) => (await runGates(task, { worktree: repo, baseRef, commands, baseline, channels: [], ...judged(),
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, result: { ok: true, summary: "", deviations: [], raw: "" },
      selectTests, requiredRepairTests: ["tests/a.test.ts"], selectionReason: "known-failing-files" })).results.find((r) => r.gate === "test")!;
    expect((await round(false)).meta?.manifest).toEqual(["tests/a.test.ts"]);
    if (generated) writeFileSync(join(repo, "tests/generated.test.ts"), 'test("generated", () => expect(1).toBe(1));\n');
    const verdict = await round(true);
    expect({ generated, pass: verdict.pass, reused: verdict.meta?.reused, manifest: verdict.meta?.manifest, reason: (verdict.meta?.selectionDecision as { reason?: string })?.reason })
      .toEqual(generated
        ? { generated, pass: true, reused: undefined, manifest: ["tests/a.test.ts", "tests/generated.test.ts"], reason: "diagnostic-cost-ratio" }
        : { generated, pass: true, reused: true, manifest: ["tests/a.test.ts"], reason: "full-green-cache" });
  }
}, 120_000);

// v2.6.5 T6 (D): the closed repair-mode table. Which repair asks its semantic question before
// buying a test screen is decided by what the round carries, never by timing: the stream below is
// the order gates actually started and ended, and executions.log is the actual test launch trace.
const MATERIAL: StructuredFinding = { class: "review:material", path: "src/changed.ts", symbol: "changed",
  note: "src/changed.ts `changed` drops the last row", fingerprint: "review:material|src/changed.ts|changed" };

async function semanticOrder(over: Partial<GateContext>) {
  const repo = makeRepo({
    "src/changed.ts": "export const changed = 1;\n",
    "src/separate.ts": "export const separate = 1;\n",
    "tests/changed.test.ts": 'import { changed } from "../src/changed.js";\nchanged;\n',
    "tests/repair.test.ts": 'import { separate } from "../src/separate.js";\nseparate;\n',
    ".gitignore": "executions.log\n",
    "run.sh": 'echo "$*" >> executions.log\nexit 0\n',
  });
  const baseRef = git(repo, "rev-parse", "HEAD");
  const commands = { test: "sh run.sh" };
  const baseline = await captureBaseline(repo, commands);
  writeFileSync(join(repo, "src/changed.ts"), "export const changed = 2;\n");
  commit(repo);
  rmSync(join(repo, "executions.log"), { force: true });
  const carried = over.carriedFindings ?? [MATERIAL];
  const scriptPath = join(mkdtempSync(join(tmpdir(), "tickmarkr-semantic-order-")), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {},
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, findings: [], ...(carried.length ? { resolved: carried.map((f) => f.fingerprint), reraised: [] } : {}) } }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  const task = validateGraph({
    version: 1, spec: { source: "native", paths: ["spec.md"], hash: "semantic-order" },
    tasks: [{ id: "T1", title: "repair", goal: "repair what the review found", shape: "implement", complexity: 8,
      files: ["**"], acceptance: ["the defect is fixed"] }],
  }).tasks[0];
  const stream: string[] = [];
  const { results } = await runGates(task, {
    worktree: repo, baseRef, commands, baseline, cfg,
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    channels: [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
    ],
    adapters: [new FakeAdapter(scriptPath)],
    result: { ok: true, summary: "repaired", deviations: [], raw: "" },
    selectTests: true, carriedFindings: [MATERIAL],
    onGate: (e) => {
      // judge ‖ review complete in either order: both ends read as one semantic end
      if (e.phase !== "note" && ["test", "acceptance", "review"].includes(e.gate)) stream.push(e.phase === "end" && e.gate !== "test" ? "semantic:end" : `${e.gate}:${e.phase}`);
    },
    ...over,
  });
  const executions = readFileSync(join(repo, "executions.log"), "utf8").split("\n").slice(0, -1);
  return { stream, executions, green: results.every((r) => r.pass) };
}

const SEMANTICS = ["acceptance:start", "review:start", "semantic:end", "semantic:end"];

test("runGates runs semantics before one full job for fresh review-repair unattributed and unknown-cost candidates while only an admitted attributed test-red diagnostic precedes them", async () => {
  const FULL = ["test:start", "test:end"];
  // selectTests false (an explicit full recheck): semantics, then the one full job — no diagnostic.
  expect(await semanticOrder({ selectTests: false })).toEqual({ stream: [...SEMANTICS, ...FULL], executions: [""], green: true });
  // An attributed test-red repair with unknown timing: the diagnostic is skipped, never promoted to a full suite before semantics.
  expect(await semanticOrder({ requiredRepairTests: ["tests/repair.test.ts"], selectionReason: "known-failing-files" })).toEqual({
    stream: [...SEMANTICS, ...FULL], executions: [""], green: true });
  // Review-only repair and a first attempt (nothing carried): semantics first, then one full job without a selected screen.
  expect(await semanticOrder({})).toEqual({ stream: [...SEMANTICS, ...FULL], executions: [""], green: true });
  expect(await semanticOrder({ requiredRepairTests: [] })).toEqual({ stream: [...SEMANTICS, ...FULL], executions: [""], green: true });
  expect(await semanticOrder({ carriedFindings: [] })).toEqual({ stream: [...SEMANTICS, ...FULL], executions: [""], green: true });
}, 120_000);

test("diagnostic admission sums a file's repeated per-project measurements against the same total", () => {
  const timed = (fileDurations: { file: string; durationMs: number }[]) =>
    ({ commands: { test: { exitCode: 0, fingerprints: [], fileDurations } } }) as unknown as Baseline;
  // one file measured by two projects: its cost is both measurements, never the last one alone
  expect(diagnosticAdmission(timed([{ file: "tests/a.test.ts", durationMs: 61_000 }, { file: "tests/a.test.ts", durationMs: 1 },
    { file: "tests/b.test.ts", durationMs: 1_000_000 }]), ["tests/a.test.ts"]))
    .toMatchObject({ admitted: false, reason: "diagnostic-cost-estimate", estimatedMs: 61_001 });
  expect(diagnosticAdmission(timed([{ file: "tests/a.test.ts", durationMs: 90 }, { file: "tests/a.test.ts", durationMs: 1 },
    { file: "tests/b.test.ts", durationMs: 9 }]), ["tests/a.test.ts"]))
    .toMatchObject({ admitted: false, reason: "diagnostic-cost-ratio", estimatedMs: 91, costRatio: 0.91 });
});

test("diagnostic admission reads a selected file that was RED in the baseline as unknown cost, never as the cheap screen its early-ending red time would buy, while the same timings with that file green are still estimated", () => {
  const timed = (fileDurations: { file: string; durationMs: number; failed?: true }[]) =>
    ({ commands: { test: { exitCode: 1, fingerprints: [], fileDurations, fileOutcomes: true } } }) as unknown as Baseline;
  const red = [{ file: "tests/a.test.ts", durationMs: 90, failed: true as const }, { file: "tests/b.test.ts", durationMs: 1_000_000 }];
  expect(diagnosticAdmission(timed(red), ["tests/a.test.ts"]).reason).toBe("diagnostic-unknown-cost");
  // another file's red flag does not make the selected green file unknown
  expect(diagnosticAdmission(timed([{ file: "tests/a.test.ts", durationMs: 90 }, { file: "tests/b.test.ts", durationMs: 1_000_000, failed: true }]), ["tests/a.test.ts"]).reason)
    .not.toBe("diagnostic-unknown-cost");
});

test("diagnostic admission reads a selected 0 ms negative NaN or non-numeric timing and any non-finite or negative measurement as unknown cost before aggregating", () => {
  const timed = (fileDurations: { file: string; durationMs: unknown }[]) =>
    ({ commands: { test: { exitCode: 0, fingerprints: [], fileDurations } } }) as unknown as Baseline;
  const reason = (fileDurations: { file: string; durationMs: unknown }[]) => diagnosticAdmission(timed(fileDurations), ["tests/a.test.ts"]).reason;
  // a JSON-round-tripped object with no primitive value would throw if any arithmetic reached it first
  const opaque: unknown = JSON.parse('{"valueOf":null,"toString":null}');
  for (const durationMs of [0, -5, NaN, Infinity, "5", null, opaque]) {
    // the selected file itself, beside a positive total (selected=0 ms + another=100 ms once admitted at 0 ms)
    expect({ durationMs, reason: reason([{ file: "tests/a.test.ts", durationMs }, { file: "tests/b.test.ts", durationMs: 100 }]) })
      .toEqual({ durationMs, reason: "diagnostic-unknown-cost" });
    // one of its per-project measurements: checked before the sum can hide it
    expect({ durationMs, reason: reason([{ file: "tests/a.test.ts", durationMs: 10 }, { file: "tests/a.test.ts", durationMs }, { file: "tests/b.test.ts", durationMs: 1000 }]) })
      .toEqual({ durationMs, reason: "diagnostic-unknown-cost" });
  }
  for (const durationMs of [0, -5, NaN, Infinity, "5", null, opaque]) {
    // an unselected measurement that is 0 ms, negative or not a finite number poisons the total
    expect({ durationMs, reason: reason([{ file: "tests/a.test.ts", durationMs: 10 }, { file: "tests/b.test.ts", durationMs }, { file: "tests/c.test.ts", durationMs: 1000 }]) })
      .toEqual({ durationMs, reason: "diagnostic-unknown-cost" });
  }
  // finite measurements whose sum overflows: an Infinity total never admits a diagnostic at costRatio 0
  expect(reason([{ file: "tests/a.test.ts", durationMs: 10 }, { file: "tests/b.test.ts", durationMs: 1e308 }, { file: "tests/c.test.ts", durationMs: 1e308 }]))
    .toBe("diagnostic-unknown-cost");
  // ...nor does a selected file whose own measurements overflow, nor a malformed entry
  expect(reason([{ file: "tests/a.test.ts", durationMs: 1e308 }, { file: "tests/a.test.ts", durationMs: 1e308 }])).toBe("diagnostic-unknown-cost");
  expect(reason([{ file: "tests/a.test.ts", durationMs: 10 }, null as unknown as { file: string; durationMs: unknown }])).toBe("diagnostic-unknown-cost");
  // every measurement finite and > 0: admitted on the exact arithmetic
  expect(diagnosticAdmission(timed([{ file: "tests/a.test.ts", durationMs: 10 }, { file: "tests/c.test.ts", durationMs: 990 }]), ["tests/a.test.ts"]))
    .toMatchObject({ admitted: true, reason: "diagnostic-admitted", estimatedMs: 10, costRatio: 0.01 });
});

test("diagnostic admission refuses timing recorded under a different or malformed capacity while an absent or equal capacity stays comparable", () => {
  const timed = (capacity: unknown) => ({ commands: { test: { exitCode: 0, fingerprints: [], capacity,
    fileDurations: [{ file: "tests/a.test.ts", durationMs: 10 }, { file: "tests/b.test.ts", durationMs: 90 }] } } }) as unknown as Baseline;
  const now = resolvedCapacity();
  for (const [capacity, reason] of [[undefined, "diagnostic-admitted"], [now, "diagnostic-admitted"],
    [{ ...now, forkCap: now.forkCap + 1 }, "diagnostic-capacity-mismatch"], [{ forkCap: now.forkCap }, "diagnostic-capacity-mismatch"]] as const) {
    expect({ capacity, admission: diagnosticAdmission(timed(capacity), ["tests/a.test.ts"]).reason }).toEqual({ capacity, admission: reason });
  }
  // A malformed CURRENT capacity is unknown cost whatever the baseline recorded — unstamped included.
  const prior = process.env[FORK_CAP_ENV];
  try {
    for (const forkCap of ["0", "-2", "NaN", "Infinity", "1.5", "abc", ""]) {
      process.env[FORK_CAP_ENV] = forkCap;
      for (const capacity of [undefined, now]) {
        expect({ forkCap, capacity, admission: diagnosticAdmission(timed(capacity), ["tests/a.test.ts"]) })
          .toEqual({ forkCap, capacity, admission: { admitted: false, reason: "diagnostic-capacity-mismatch" } });
      }
    }
    process.env[FORK_CAP_ENV] = "2"; // the falsifier: a well-formed current capacity beside the unstamped baseline admits
    expect(diagnosticAdmission(timed(undefined), ["tests/a.test.ts"]).reason).toBe("diagnostic-admitted");
  } finally {
    if (prior === undefined) delete process.env[FORK_CAP_ENV]; else process.env[FORK_CAP_ENV] = prior;
  }
});

test("a diagnosed, in-battery or test-only full job whose own command creates an ignored collectable test never passes or caches stale proof under an unchanged Git identity: one fresh job certifies the grown manifest and a second stale job fails closed", async () => {
  // semantic=false is test-only verification: no semantic gate, no diagnostic, the same freshness check.
  for (const [diagnosed, fresh, semantic] of [[true, false, true], [true, true, true], [false, false, true], [false, true, true],
    [false, false, false], [false, true, false]] as const) {
    // tests/hidden.test.ts is outside the diagnostic's selection; once flagged, every full job writes an ignored
    // test the runner collects — the same file (a rerun's discovery then holds it), or a new one each time.
    const target = fresh ? "`tests/generated-${process.hrtime.bigint()}.test.ts`" : '"tests/generated.test.ts"';
    const repo = makeRepo({
      ".gitignore": "node_modules/\ngenerate.flag\ntests/generated*.test.ts\n",
      "src/a.ts": "export const a = 1;\n",
      "tests/a.test.ts": 'import { a } from "../src/a"; test("alpha", () => expect(a).toBeGreaterThan(0));\n',
      "tests/hidden.test.ts": `import { existsSync, writeFileSync } from "node:fs";\ntest("hidden", () => {\n`
        + `  if (existsSync("generate.flag")) writeFileSync(${target}, 'test("generated", () => expect(1).toBe(1));\\n');\n});\n`,
      "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals" } }),
    });
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
    const baseRef = git(repo, "rev-parse", "HEAD");
    const commands = { test: "vitest run --globals" };
    const baseline = timed(await captureBaseline(repo, commands), { "tests/a.test.ts": 5, "tests/hidden.test.ts": 95 });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commit(repo);
    writeFileSync(join(repo, "generate.flag"), "");
    const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "stale" }, tasks: [{ id: "T1", title: "s",
      goal: "s", shape: "implement", complexity: 3, files: ["**"], acceptance: ["done"],
      gates: ["build", "test", "lint", "evidence", "scope", ...(semantic ? ["acceptance"] : [])] }] }).tasks[0];
    const head = git(repo, "rev-parse", "HEAD");
    const ends: GateResult[] = [];
    const { results } = await runGates(task, { worktree: repo, baseRef, commands, baseline, channels: [], ...judged(),
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, result: { ok: true, summary: "", deviations: [], raw: "" },
      selectTests: diagnosed, requiredRepairTests: ["tests/a.test.ts"], selectionReason: "known-failing-files",
      onGate: (e) => { if (e.phase === "end" && e.gate === "test") ends.push(e.result); } });
    if (diagnosed) expect(ends.shift()).toMatchObject({ pass: true, meta: { selectedTests: ["tests/a.test.ts"] } });
    const [superseded, last] = ends;
    expect(ends).toHaveLength(2);
    // the first full job's green answered a manifest without the test it created: never published green, never cached
    expect(superseded).toMatchObject({ pass: false, meta: { staleProof: true, skipped: true, infra: true,
      manifest: ["tests/a.test.ts", "tests/hidden.test.ts"] } });
    expect(results.find((r) => r.gate === "test")).toBe(last);
    if (!fresh) {
      expect(last).toMatchObject({ pass: true, meta: { fullSuite: true, manifest: ["tests/a.test.ts", "tests/generated.test.ts", "tests/hidden.test.ts"] } });
      expect(results.every((r) => r.pass)).toBe(true);
    } else {
      expect(last).toMatchObject({ pass: false, meta: { staleProof: true, infra: true, retryable: false, fullSuite: true } });
      expect(last!.meta?.skipped).toBeUndefined();
      expect(results.every((r) => r.pass)).toBe(false);
    }
    // Git identity never moved (the created tests are ignored), yet no cached full green certifies the stale manifest.
    expect([git(repo, "rev-parse", "HEAD"), git(repo, "status", "--porcelain")]).toEqual([head, ""]);
    const dir = join(resolveStateDir(repo), "verdicts");
    const cachedFull = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredVerdictRecord)
      .filter((rec) => rec.verdict.gate === "test" && !rec.identity.envParts?.selectedSet);
    expect(cachedFull.filter((rec) => rec.verdict.pass && !((rec.verdict.meta?.manifest ?? []) as string[]).includes("tests/generated.test.ts"))).toEqual([]);
    expect(cachedFull.length).toBe(fresh ? 0 : 1);
  }
}, 180_000);

test("a full green whose post-run manifest listing rewrites an ignored lockfile under identical filenames is never cached or published under its pre-listing identity", async () => {
  // The listing is a command too: once the round's run arms it, it writes an ignored lockfile (lock.next's bytes,
  // else "{}") and returns the same files. Identity and cleanliness are sampled AFTER it, so that green is stale.
  const repo = makeRepo({
    ".gitignore": "node_modules/\narm.flag\narmed\nlock.next\npackage-lock.json\n",
    "vitest.config.mjs": 'import { existsSync, readFileSync, writeFileSync } from "node:fs";\n'
      + 'if (process.argv.includes("list") && existsSync("armed")) writeFileSync("package-lock.json", existsSync("lock.next") ? readFileSync("lock.next") : "{}\\n");\nexport default {};\n',
    "src/a.ts": "export const a = 1;\n",
    "tests/a.test.ts": 'import { existsSync, writeFileSync } from "node:fs";\nimport { a } from "../src/a";\n'
      + 'test("alpha", () => { if (existsSync("arm.flag")) writeFileSync("armed", ""); expect(a).toBeGreaterThan(0); });\n',
    "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals" } }),
  });
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
  const baseRef = git(repo, "rev-parse", "HEAD");
  const commands = { test: "vitest run --globals" };
  // timing admits round 3's diagnostic (ratio 0.05); the same baseline keys every round's identity
  const baseline = timed(await captureBaseline(repo, commands), { "tests/a.test.ts": 5, "tests/z.test.ts": 95 });
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  commit(repo);
  writeFileSync(join(repo, "arm.flag"), "");
  const task = (gates: string[]) => validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "lock" }, tasks: [{ id: "T1", title: "l",
    goal: "l", shape: "implement", complexity: 3, files: ["**"], acceptance: ["done"], gates: ["build", "test", "lint", "evidence", "scope", ...gates] }] }).tasks[0];
  const round = async (gates: string[], extra: Partial<GateContext> = {}, onEnd?: (r: GateResult) => void) => {
    const ends: GateResult[] = [];
    const reused: unknown[] = [];
    const { results } = await runGates(task(gates), { worktree: repo, baseRef, commands, baseline, channels: [], ...judged(),
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, result: { ok: true, summary: "", deviations: [], raw: "" }, ...extra,
      onGate: (e) => {
        if (e.phase === "end" && e.gate === "test") { ends.push(e.result); onEnd?.(e.result); }
        if (e.phase === "note" && e.gate === "test" && e.name === "gate-reused-verdict") reused.push(e.payload);
      } });
    return { results, ends, reused };
  };
  const cachedFull = () => readdirSync(join(resolveStateDir(repo), "verdicts")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(resolveStateDir(repo), "verdicts", f), "utf8")) as StoredVerdictRecord)
    .filter((rec) => rec.verdict.gate === "test" && !rec.identity.envParts?.selectedSet);
  const first = await round([]);
  expect(first.ends).toHaveLength(2);
  expect(first.ends[0]).toMatchObject({ pass: false, meta: { staleProof: true, skipped: true, infra: true } });
  expect(first.ends[1]).toMatchObject({ pass: true, meta: { fullSuite: true } });
  expect(first.results.every((r) => r.pass)).toBe(true);
  expect([existsSync(join(repo, "package-lock.json")), git(repo, "status", "--porcelain")]).toEqual([true, ""]);
  // only the fresh job's green is cached, and under the identity measured after its listing (lockfile present)
  expect(cachedFull().map((rec) => [rec.verdict.pass, rec.identity.envParts?.lockfile === "no-lockfile"])).toEqual([[true, false]]);

  // Cache reuse, battery branch: the green cached under "{}" is found, but the reuse check's own listing now writes
  // v2 under identical filenames — stale, it is never reused or relabelled; one fresh job measures and caches v2.
  writeFileSync(join(repo, "lock.next"), '{"v":2}\n');
  const second = await round([]);
  expect(second.reused).toEqual([]);
  expect(second.ends).toEqual([expect.objectContaining({ pass: true, meta: expect.not.objectContaining({ reused: true }) })]);
  expect(cachedFull().map((rec) => rec.verdict.pass)).toEqual([true, true]);
  expect(new Set(cachedFull().map((rec) => rec.identity.envParts?.lockfile)).size).toBe(2);

  // Merge-candidate branch: site C's listing writes v3 (no qualified full-green hit), so the diagnostic runs; after it
  // the lockfile is put back to v2, whose green IS cached — the loop finds it, its listing writes v3 again: stale, fresh job.
  writeFileSync(join(repo, "lock.next"), '{"v":3}\n');
  const third = await round(["acceptance"], { selectTests: true, requiredRepairTests: ["tests/a.test.ts"], selectionReason: "known-failing-files" },
    (r) => { if (r.meta?.fullSuite !== true) writeFileSync(join(repo, "package-lock.json"), '{"v":2}\n'); });
  expect(third.reused).toEqual([]);
  expect(third.ends).toEqual([expect.objectContaining({ pass: true, meta: expect.objectContaining({ selectedTests: ["tests/a.test.ts"] }) }),
    expect.objectContaining({ pass: true, meta: expect.objectContaining({ fullSuite: true, selectionDecision: expect.objectContaining({ reason: "diagnostic-admitted" }) }) })]);
  expect(third.ends[1]!.meta?.reused).toBeUndefined();
  expect(third.results.every((r) => r.pass)).toBe(true);
  expect(readFileSync(join(repo, "package-lock.json"), "utf8")).toBe('{"v":3}\n');
}, 180_000);
