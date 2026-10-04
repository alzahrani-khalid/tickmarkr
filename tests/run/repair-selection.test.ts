import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead, shGitOk } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";
import { repairSelectionDecision, repairSelectionEnabled } from "../../src/run/repair-selection.js";

const subject = "a".repeat(64);
const row = (data: Record<string, unknown> = {}, taskId = "T1") => ({
  event: "gate-result", taskId,
  data: { gate: "test", pass: false, commit: subject, disposition: "behavioral",
    selectedTests: ["tests/a.test.ts", "tests/b.test.ts"], failingFiles: ["tests/a.test.ts"], ...data },
});

test("selected regressions accumulate literal failing files across subjects and resume without green or approval forgetting them", () => {
  const events = [row(), row({ commit: "b".repeat(40), failingFiles: ["tests/b.test.ts"] }),
    row({ pass: true }), { event: "task-approved", taskId: "T1", data: {} },
    { event: "run-resume", data: {} }];
  expect(repairSelectionDecision(JSON.parse(JSON.stringify(events)), "T1", true)).toEqual({
    selectTests: true, requiredFiles: ["tests/a.test.ts", "tests/b.test.ts"], reason: "known-failing-files",
  });
});

test("attributed ordinary and replacement full-suite reds join the screen, while a full red without a positive full marker stays distrusted", () => {
  const replacement = row({ fullSuite: true, failingFiles: ["tests/omitted.test.ts"] });
  const ordinary = row({ selectedTests: undefined, selectionDecision: { scope: "full" }, failingFiles: ["tests/full.test.ts"] });
  expect(repairSelectionDecision([row({ pass: true }), replacement, row({ pass: true, fullSuite: true }), ordinary, row()], "T1", true)).toEqual({
    selectTests: true, requiredFiles: ["tests/a.test.ts", "tests/full.test.ts", "tests/omitted.test.ts"], reason: "known-failing-files",
  });
  for (const over of [{ selectedTests: undefined }, { selectedTests: undefined, selectionDecision: { scope: "selected" } },
    { fullSuite: true, failingFiles: undefined }, { selectedTests: undefined, selectionDecision: { scope: "full" }, disposition: undefined }]) {
    expect(repairSelectionDecision([row(over)], "T1", true)).toMatchObject({ selectTests: false, reason: "unattributed-test-failure" });
  }
});

test("the effective default is on without an execution policy and either explicit false turns it off", () => {
  expect(repairSelectionEnabled(undefined)).toBe(true);
  expect(repairSelectionEnabled({ executionPolicy: { boundedInfrastructure: true } as { repairSelection?: boolean } })).toBe(true);
  expect(repairSelectionEnabled({ gates: { repairSelection: false } })).toBe(false);
  expect(repairSelectionEnabled({ executionPolicy: { repairSelection: false }, gates: { repairSelection: true } })).toBe(false);
});

test("recorded infrastructure neither poisons selection nor clears a preexisting historical failure", () => {
  const infra = row({ disposition: "infrastructure", infra: true, failingFiles: undefined, commit: undefined, fullSuite: true });
  expect(repairSelectionDecision([infra], "T1", true)).toEqual({ selectTests: true, requiredFiles: [], reason: "no-test-failure" });
  const legacy = row({ disposition: undefined });
  expect(repairSelectionDecision([legacy, infra, row({ pass: true })], "T1", true).selectTests).toBe(false);
  expect(repairSelectionDecision([row(), infra], "T1", true).requiredFiles).toEqual(["tests/a.test.ts"]);
});

test.each([
  { disposition: undefined }, { disposition: "unknown" }, { commit: undefined }, { commit: "unknown" },
  { selectedTests: undefined }, { failingFiles: undefined }, { failingFiles: [] },
  { failingFiles: ["tests/not-selected.test.ts"] }, { failingFiles: [42] }, { fullSuite: "false" },
  { failingFiles: ["../escape.test.ts"] }, { failingFiles: ["/absolute.test.ts"] },
  { failingFiles: ["C:\\tests\\a.test.ts"] }, { failingFiles: ["tests/./a.test.ts"] },
  { failingFiles: ["tests/a.test.ts\n"] },
])("missing or ambiguous failure identity forces durable conservative selection: %j", (over) => {
  expect(repairSelectionDecision([row(over), row(), row({ pass: true })], "T1", true).selectTests).toBe(false);
});

test("infrastructure labels cannot hide contradictory behavioral file evidence", () => {
  expect(repairSelectionDecision([row({ disposition: "infrastructure", infra: true })], "T1", true).selectTests).toBe(false);
  expect(repairSelectionDecision([row({ disposition: "infrastructure", failingFiles: undefined, classification: "regression" })], "T1", true).selectTests).toBe(false);
});

test("disabled policy retains the old failure latch including historical infrastructure", () => {
  expect(repairSelectionDecision([row({ disposition: "infrastructure", failingFiles: undefined })], "T1", false))
    .toEqual({ selectTests: false, requiredFiles: [], reason: "legacy-test-failure" });
  expect(repairSelectionDecision([row()], "T1", false).selectTests).toBe(false);
});

test("sibling tasks, unrelated gates and non-verdict events do not affect selection", () => {
  expect(repairSelectionDecision([row({}, "T2"), row({ gate: "review" }), row({ pass: undefined }),
    { ...row(), event: "gate-start" }], "T1", true))
    .toEqual({ selectTests: true, requiredFiles: [], reason: "no-test-failure" });
});

test("literal bracketed paths are supported and repeated failure files stay deduplicated", () => {
  const over = { selectedTests: ["tests/[id]/a.test.ts"], failingFiles: ["tests/[id]/a.test.ts", "tests/[id]/a.test.ts"] };
  expect(repairSelectionDecision([row(over), row(over)], "T1", true).requiredFiles).toEqual(["tests/[id]/a.test.ts"]);
});

class DriverAs extends SubprocessDriver {
  constructor(readonly as: string) { super(); (this as { id: string }).id = as; }
}

// A prior attempt left two attributed full-suite reds on its subject: an ordinary full run and the
// replacement that followed a green screen. The operator releases the park and the daemon resumes.
// v2.6.7 T1: a diagnostic only runs beside a semantic gate; `testOnly` drops acceptance (test-only verification).
async function repairRun(driverId: string, recordedConfig: Record<string, unknown>, attributed: boolean, testOnly = false) {
  const runId = `run-repair-${driverId}-${attributed ? "a" : "u"}-${recordedConfig.gates ? "off" : "on"}${testOnly ? "-t" : ""}`;
  const dir = makeTestTempDir("tkr-repair-selection-");
  const log = join(dir, "argv.log");
  const runner = join(dir, "tests.sh");
  writeFileSync(runner, `printf '[%s]\\n' "$*" >> ${shq(log)}\nexit 0\n`);
  const command = `bash ${shq(runner)}`;
  const gates = ["build", "test", "lint", "evidence", "scope", ...(testOnly ? [] : ["acceptance"])];
  const { repo, fake } = setupRepo([T("T1", { files: ["**"], gates })], {
    tasks: { T1: [{ shell: `echo "export const value = 2;" > src/a.ts && ${COMMIT} repaired`, result: { ok: true, summary: "repaired" } }] },
  }, `gates: { test: ${JSON.stringify(command)} }\n`);
  for (const [file, body] of Object.entries({ "src/a.ts": "export const value = 0;\n", "tests/a.test.ts": 'import { value } from "../src/a.js";\n',
    "tests/ordinary.test.ts": "// failed only in an ordinary full suite\n", "tests/replacement.test.ts": "// failed only in a replacement full suite\n" })) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), body);
  }
  await shGitOk("git add -A && git commit --no-gpg-sign -m fixture", repo);
  const baseRef = await gitHead(repo);
  const branch = `tickmarkr/${runId}`;
  const wt = await new SubprocessDriver().worktree(repo, `${branch}--T1`, baseRef);
  writeFileSync(join(wt, "src/a.ts"), "export const value = 1;\n");
  await shGitOk("git add -A && git commit --no-gpg-sign -m red", wt);
  const commit = await gitHead(wt);
  const commands = { test: command };
  const baseline = await captureBaseline(repo, commands);
  // v2.6.7 T1: comparable harness timing admits the attributed diagnostic (3 % of the suite, 3 ms); synthetic, so no capacity claim
  baseline.commands.test = { ...baseline.commands.test!, capacity: undefined, fileDurations: ["tests/a.test.ts", "tests/ordinary.test.ts", "tests/replacement.test.ts"]
    .map((file) => ({ file, durationMs: 1 })).concat({ file: "tests/heavy.test.ts", durationMs: 97 }) };
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef, commands, branch, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
    effectivePolicy: { config: recordedConfig } });
  journal.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0 });
  journal.append("worker-result", "T1", { ok: true, summary: "first try", deviations: [] });
  journal.phaseStart("T1", "gates");
  const red = { gate: "test", pass: false, details: "FAIL", disposition: "behavioral", classification: "regression", commit };
  journal.append("gate-result", "T1", { ...red, failingFiles: ["tests/ordinary.test.ts"],
    ...(attributed ? { selectionDecision: { scope: "full", reason: "no-test-failure", requiredFiles: [] } } : {}) });
  journal.append("gate-result", "T1", { ...red, failingFiles: ["tests/replacement.test.ts"],
    ...(attributed ? { fullSuite: true, selectedTests: ["tests/a.test.ts"] } : {}) });
  journal.append("task-human", "T1", { reason: "attempt cap reached", kind: "attempt-cap" });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
  writeFileSync(log, "");
  await approve([runId, "T1", "--by", "test"], repo);
  const summary = await runDaemon(repo, { runId, resume: true, adapters: [fake], driver: new DriverAs(driverId) });
  const screens = journal.read().filter((e) => e.event === "gate-result" && e.data.gate === "test" && Array.isArray(e.data.selectedTests)
    && e.data.fullSuite !== true && e.data.commit !== commit);
  const tests = journal.read().filter((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.commit !== commit);
  return { summary, executions: readFileSync(log, "utf8").trim().split("\n"), screens, tests };
}

const union = "tests/a.test.ts tests/ordinary.test.ts tests/replacement.test.ts";

test("runDaemon selects the attributed ordinary or replacement full-red failing-file union by default on subprocess Orca Herdr versus full execution for explicit off or untrusted provenance, so omission of a failing file or absent-policy driver refusal fails", async () => {
  for (const driverId of ["subprocess", "orca", "herdr"]) {
    // No executionPolicy anywhere: the default alone selects, and no driver refuses the run.
    const { summary, executions, screens } = await repairRun(driverId, {}, true);
    expect({ driverId, done: summary.done }).toEqual({ driverId, done: ["T1"] });
    // screen = diff-affected test ∪ both full-red failing files; then the complete merge candidate and the tip.
    expect({ driverId, executions }).toEqual({ driverId, executions: [`[${union}]`, "[]", "[]"] });
    expect(screens.map((e) => e.data.selectionDecision)).toEqual([expect.objectContaining({ scope: "selected",
      reason: "diagnostic-admitted", requiredFiles: ["tests/ordinary.test.ts", "tests/replacement.test.ts"] })]);
  }
  const off = await repairRun("orca", { gates: { repairSelection: false } }, true);
  expect(off.summary.done).toEqual(["T1"]);
  expect(off.executions).toEqual(["[]", "[]"]);
  const untrusted = await repairRun("herdr", {}, false);
  expect(untrusted.summary.done).toEqual(["T1"]);
  expect(untrusted.executions).toEqual(["[]", "[]"]);
}, 60_000);

test("runDaemon keeps test-only verification at full scope after an attributed prior test red, so a selected diagnostic before its full job fails", async () => {
  const { summary, executions, screens, tests } = await repairRun("subprocess", {}, true, true);
  expect(summary.done).toEqual(["T1"]);
  // the merge-candidate full job and the tip only: no diagnostic precedes the full job
  expect(executions).toEqual(["[]", "[]"]);
  expect(screens).toEqual([]);
  expect(tests.map((e) => e.data.selectionDecision)).toEqual([expect.objectContaining({ scope: "full",
    reason: "test-only-verification", requiredFiles: ["tests/ordinary.test.ts", "tests/replacement.test.ts"] })]);
}, 60_000);
