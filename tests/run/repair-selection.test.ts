import { expect, test } from "vitest";
import { repairSelectionDecision } from "../../src/run/repair-selection.js";

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

test("a behavioral replacement full suite defeats selected success on the same subject and later repairs never clear distrust", () => {
  const decision = repairSelectionDecision([row({ pass: true }), row({ fullSuite: true, failingFiles: ["tests/omitted.test.ts"] }),
    row({ pass: true, fullSuite: true }), row()], "T1", true);
  expect(decision.selectTests).toBe(false);
  expect(decision.reason).toBe("full-suite-failure");
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
