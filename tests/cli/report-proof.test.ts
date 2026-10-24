import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderMarkdownRecord, report } from "../../src/cli/commands/report.js";
import type { ProofBundle } from "../../src/report/bundle.js";
import { compareRuns, recordedEnvironment } from "../../src/report/compare.js";
import { estimateCosts, type CostConfig } from "../../src/report/cost.js";
import { formatChannelMoney } from "../../src/report/operator-record.js";
import type { RunEnvironment } from "../../src/run/environment.js";
import { Journal, type JournalEvent, type TelemetryRow } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const environment: RunEnvironment = {
  tickmarkrVersion: "2.8.7", configHash: "config-a", adapterVersions: { fake: "1", codex: "2" }, cores: 8, forkCap: 2,
};

const event = (name: string, data: Record<string, unknown> = {}, taskId?: string): JournalEvent => ({
  ts: "2026-10-24T00:00:00.000Z", event: name, data, ...(taskId ? { taskId } : {}),
});

function seed(repo: string, id: string, events: JournalEvent[], rows: TelemetryRow[] = []): Journal {
  const journal = Journal.create(repo, id);
  writeFileSync(join(journal.dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const row of rows) journal.telemetry(row);
  return journal;
}

const run = (gates: JournalEvent[] = []): JournalEvent[] => [
  event("run-start", { environment }), ...gates, event("run-end", { done: ["T1"], failed: [], human: [] }),
];

test("test: the Markdown report, the plain report's tickmark rate, the proof bundle and the run comparison read a selected-test screen that passed without its full suite as held and never as a pass, while a full-suite row that also carries a diagnostic selection stays a pass on all four, so a fix that marks every row carrying a selection, or that any consumer still counts the screen, fails", async () => {
  const repo = makeRepo({ "keep.txt": "proof\n" });
  const baseline = run();
  seed(repo, "run-baseline", baseline);
  for (const [id, extra, held] of [
    ["screen", { selectedTests: ["tests/cli/report-proof.test.ts"] }, true],
    ["screen-false", { selectedTests: [], fullSuite: false }, true],
    ["full", { selectedTests: ["tests/cli/report-proof.test.ts"], fullSuite: true }, false],
    ["full-no-selection", { fullSuite: true }, false],
  ] as const) {
    const events = run([event("gate-result", { gate: "test", pass: true, details: "test evidence", ...extra }, "T1")]);
    const journal = seed(repo, `run-${id}`, events);
    const bundlePath = join(journal.dir, "proof.json");
    const md = await report([`run-${id}`, "--md", "--bundle", bundlePath, "--compare", "run-baseline"], repo);
    expect(md).toContain(`test: ${held ? "held" : "pass"} — test evidence`);
    expect(md).not.toContain(`test: ${held ? "pass" : "held"} —`);
    const count = held ? 0 : 1;
    expect(await report([`run-${id}`], repo)).toContain(`tickmark rate: ${count * 100}% (${count}/1)`);
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as ProofBundle;
    expect(bundle.tasks[0].gates[0].pass).toBe(!held);
    expect(bundle.tasks[0].gates[0].held).toBe(held ? true : undefined);
    const comparison = compareRuns({ runId: id, baselineRunId: "baseline", events, baselineEvents: baseline });
    expect(comparison.ok).toBe(true);
    if (!comparison.ok) throw new Error(comparison.reason);
    expect(comparison.current).toMatchObject({ gatePass: count, gateFail: 0, gateTotal: 1 });
    expect(md).toContain(`| gate pass rate | — | ${count}/1 | — |`);
  }
  const declined = run([event("gate-result", { gate: "review", pass: true, skipped: true, details: "skipped — policy" }, "T1")]);
  seed(repo, "run-declined", declined);
  expect(await report(["run-declined", "--md"], repo)).toContain("review: declined — skipped — policy");
  expect(await report(["run-declined"], repo)).toContain("tickmark rate: 0% (0/0) · declined: 1");
});

test("test: a channel whose rows are partly metered prints every price line as a floor beside its token floor and the run comparison marks that run's cost partial, while a fully metered channel prints no floor, so a price read as complete fails", async () => {
  const repo = makeRepo({ "keep.txt": "proof\n" });
  const cost: CostConfig = {
    models: { api: { inPerMtok: 2, outPerMtok: 3 }, sub: { inPerMtok: 2, outPerMtok: 3 } },
    subs: { fake: { planMonthly: 100, windowsPerMonthLow: 10, windowsPerMonthHigh: 20 } },
  };
  const metered = (model: "api" | "sub", taskId: string): TelemetryRow => ({
    taskId, shape: "implement", adapter: "fake", model, channel: model, attempts: 1, meteredAttempts: 1,
    outcome: "done", durationMs: 1, tokens: { input: 1_000_000, output: 0 },
  });
  const full = [metered("api", "T1"), metered("sub", "T1"), metered("api", "T2"), metered("sub", "T2")];
  const partial = full.map((row) => {
    if (row.taskId === "T1") return row;
    const { tokens: _tokens, meteredAttempts: _metered, ...unmetered } = row;
    return unmetered;
  });
  const events = run();
  seed(repo, "run-full", events, full);
  seed(repo, "run-partial", events, partial);
  writeFileSync(join(repo, ".tickmarkr/config.yaml"), JSON.stringify({ cost }));
  const md = await report(["run-partial", "--md", "--compare", "run-full"], repo);
  const prices = estimateCosts(partial, cost);
  expect(prices).toHaveLength(2);
  for (const row of prices) {
    expect(row.partialMetering).toBe(true);
    const money = formatChannelMoney(row).prices;
    expect(money.length).toBe(row.channel === "api" ? 1 : 2);
    for (const line of money) {
      expect(line).toContain(": ≥ $");
      expect(md).toContain(line);
    }
  }
  expect(md).toContain("tokens: ≥ in 1,000,000");
  const complete = await report(["run-full", "--md"], repo);
  expect(complete).not.toContain("≥");
  for (const row of estimateCosts(full, cost)) {
    expect(row.partialMetering).toBe(false);
    expect(formatChannelMoney(row).prices.join(" ")).not.toContain("≥");
  }
  const comparison = compareRuns({ runId: "partial", baselineRunId: "full", events, baselineEvents: events, rows: partial, baselineRows: full, cost });
  expect(comparison.ok).toBe(true);
  if (!comparison.ok) throw new Error(comparison.reason);
  expect(comparison.current.costPartial).toBe(true);
  expect(comparison.baseline.costPartial).toBe(false);
  expect(comparison.delta.costPartial).toBe(true);
  expect(md).toContain(`| cost | $${comparison.baseline.costUsd!.toFixed(6)} | $${comparison.current.costUsd!.toFixed(6)} (partial) |`);
  expect(comparison.text.split("\n").find((line) => line.startsWith("| cost |"))).toMatch(/\(partial\).*\(partial\)/);
});

test("test: a run whose resume stamped an environment differing from its start compares as a mismatch of mixed sessions against a baseline matching its start, a resume without a stamp compares as unbound, and two runs each started and resumed one or more times under one equal stamp stay comparable, so a comparison reading only the first session or calling every resumed run mixed fails", async () => {
  const repo = makeRepo({ "keep.txt": "proof\n" });
  const sessions = (stamps: unknown[]): JournalEvent[] => [
    ...stamps.map((stamp, i) => event(i ? "run-resume" : "run-start", stamp === undefined ? {} : { environment: stamp })),
    event("run-end", { done: [], failed: [], human: [] }),
  ];
  const equal = { ...environment, adapterVersions: { codex: "2", fake: "1" } };
  const baseline = sessions([environment, equal]);
  seed(repo, "run-baseline", baseline);
  const cases: Array<[string, unknown[], "mismatch" | "unbound" | "comparable"]> = [
    ["mixed-config", [environment, { ...environment, configHash: "config-b" }], "mismatch"],
    ["mixed-version", [environment, { ...environment, tickmarkrVersion: "other" }], "mismatch"],
    ["mixed-adapter", [environment, { ...environment, adapterVersions: { fake: "3", codex: "2" } }], "mismatch"],
    ["mixed-capacity", [environment, { ...environment, forkCap: 3 }], "mismatch"],
    ["missing-resume", [environment, undefined], "unbound"],
    ["missing-start", [undefined, environment], "unbound"],
    ["malformed-resume", [environment, { ...environment, adapterVersions: [] }], "unbound"],
    ["empty-resume", [environment, { ...environment, configHash: " " }], "unbound"],
    ["half-capacity", [environment, { ...environment, forkCap: undefined }], "unbound"],
    ["mixed-and-missing", [environment, { ...environment, configHash: "config-b" }, undefined], "unbound"],
    ["equal", [environment, equal, environment], "comparable"],
  ];
  for (const [id, stamps, expected] of cases) {
    const events = sessions(stamps);
    seed(repo, `run-${id}`, events);
    const text = await report([`run-${id}`, "--md", "--compare", "run-baseline"], repo);
    for (const reverse of [false, true]) {
      const comparison = compareRuns({ runId: id, baselineRunId: "baseline", events: reverse ? baseline : events, baselineEvents: reverse ? events : baseline });
      expect(comparison.ok).toBe(true);
      if (!comparison.ok) throw new Error(comparison.reason);
      if (expected === "comparable") {
        expect(comparison.comparability).toEqual({ comparable: true, recorded: environment.configHash });
        expect(recordedEnvironment(events)).toEqual(environment);
        expect(text).toContain("full comparability");
      } else {
        expect(comparison.comparability).toMatchObject({ comparable: false, reason: expected });
        expect(recordedEnvironment(events)).toBeUndefined();
        expect(text).not.toContain("full comparability");
        expect(comparison.text).toContain(expected === "mismatch" ? "mixed sessions" : "lack a recorded environment identity");
      }
    }
  }
});

test("test: the record's first line names a tip proof of fresh and reused gates as mixed, all reused as cached and all fresh as passed, each agreeing with the verification line, and the brand golden record's first line reads mixed, so a lead read from the last tip row fails", async () => {
  const repo = makeRepo({ "keep.txt": "proof\n" });
  for (const [id, cached, expected] of [
    ["mixed-last-cached", [false, true], "mixed"],
    ["mixed-last-fresh", [true, false], "mixed"],
    ["all-cached", [true, true], "cached"],
    ["all-fresh", [false, false], "passed"],
  ] as const) {
    const allCached = cached.every(Boolean);
    const events = [
      event("run-start", { environment }),
      event("tip-verify-start", { tip: "abcdef", gates: ["build", "test"], cached: allCached }),
      ...(allCached ? [event("tip-verify-cached", { tip: "abcdef", gates: ["build", "test"] })] : []),
      ...cached.map((reused, i) => event("tip-verify", { tip: "abcdef", gate: i ? "test" : "build", pass: true, cached: reused })),
      event("run-end", { tipVerify: "passed", done: [], failed: [], human: [] }),
    ];
    seed(repo, `run-${id}`, events);
    const md = await report([`run-${id}`, "--md"], repo);
    expect(md.split("\n")[0]).toContain(`tip verify ${expected}`);
    const verification = md.split("\n").find((line) => line.startsWith("- **verification:**"))!;
    expect(verification).toContain(`**verification:** ${allCached ? "cached" : "passed"} — tip proof:`);
    for (const [i, reused] of cached.entries()) {
      expect(verification).toContain(`${i ? "test" : "build"}: ${reused ? "cached (reused) — carried, not re-run" : "verified fresh"}`);
    }
    expect((await report([`run-${id}`], repo)).split("\n")[0]).toContain(`tip verify ${expected}`);
    const openResume = [...events, event("run-resume"), event("tip-verify-start", { tip: "new", gates: ["test"] }), event("tip-verify", { tip: "new", gate: "test", pass: true })];
    const closed = renderMarkdownRecord(id, openResume, [], [], undefined, repo);
    expect(closed.split("\n")[0]).toContain(`tip verify ${expected}`);
    expect(closed).toContain(verification);
  }
  const golden = readFileSync(join(import.meta.dirname, "../fixtures/brand-surfaces/report-md.md"), "utf8");
  expect(golden.split("\n")[0]).toContain("tip verify mixed");
  expect(golden).toContain("**verification:** passed — tip proof: reused");
  expect(golden).toContain("test: verified fresh");
  for (const gate of ["build", "lint"]) expect(golden).toContain(`${gate}: cached (reused) — carried, not re-run`);
});

test("test: an acceptance row that records its judge as not independent prints its tickmark with independence not established, while a row without that record prints as today, so a record that hides a judge sharing the author's vendor fails", () => {
  for (const pass of [true, false]) {
    const events = run([
      event("task-dispatch", { assignment: { adapter: "codex", model: "gpt-6-sol", channel: "sub" } }, "T1"),
      event("gate-result", { gate: "acceptance", pass, judgeIndependent: false, details: "judge evidence" }, "T1"),
      event("gate-result", { gate: "acceptance", pass, details: "legacy evidence" }, "T1"),
      event("gate-result", { gate: "acceptance", pass, judgeIndependent: true, details: "independent evidence" }, "T1"),
    ]);
    const md = renderMarkdownRecord("run-independence", events);
    const word = pass ? "pass" : "fail";
    expect(md).toContain(`acceptance: ${word} (independence not established) — judge evidence`);
    expect(md).toContain(`acceptance: ${word} — legacy evidence`);
    expect(md).toContain(`acceptance: ${word} — independent evidence`);
    expect(md.match(/independence not established/g)).toHaveLength(1);
  }
});
