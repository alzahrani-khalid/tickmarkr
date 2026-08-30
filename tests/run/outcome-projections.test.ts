import { expect, test } from "vitest";
import { compareToBaseline } from "../../src/gates/baseline.js";
import type { GateResult } from "../../src/gates/types.js";
import { GATE_OUTCOME_KINDS, normalizeGateOutcome, type GateOutcome, type GateOutcomeKind } from "../../src/run/outcome.js";
import { makeRepo } from "../helpers/tmprepo.js";

// T31. The vocabulary is the product here, so the table below is the test: every member of the closed
// union and every legacy shape the shipped record already writes is driven through the one normalizer,
// and the two things that must never happen — a non-failure read as a pass, an unreadable row read as
// clean — are asserted against the same table rather than against a hand-picked example.

/**
 * The journal row the daemon writes for a gate result (src/run/daemon.ts:1376-1391), reproduced here
 * over real GateResults: `pass` is OMITTED entirely for an unverdicted decline, and skipped, infra,
 * verdict, policy and reason ride at the row's top level where every projection reads them.
 */
const journalRow = (g: GateResult): Record<string, unknown> => {
  const unverdicted = g.meta?.skipped === true && !g.pass;
  return {
    gate: g.gate,
    ...(unverdicted ? {} : { pass: g.pass }),
    details: g.details,
    ...(g.meta?.skipped === true ? { skipped: true } : {}),
    ...(g.meta?.infra === true ? { infra: true } : {}),
    ...(g.meta?.verdict === "skipped"
      ? { verdict: "skipped", policy: g.meta.policy, reason: g.meta.reason }
      : {}),
    ...(Array.isArray(g.meta?.selectedTests) ? { selectedTests: g.meta.selectedTests } : {}),
    ...(g.meta?.fullSuite === true ? { fullSuite: true } : {}),
  };
};

/**
 * The declined review, captured verbatim from its producer (src/gates/review.ts:411-421). Running the
 * real gate needs a worktree, a base ref and a cross-vendor adapter; the shape it returns is the fact
 * under test, and a paraphrase of it would be a fixture that cannot go stale with the producer.
 */
const REVIEW_DECLINE: GateResult = {
  gate: "review",
  pass: false,
  details: "skipped — reviewPolicy judge-only: every declared path is docs/CHANGELOG/RELEASING/version-mirror leaf work and the diff stayed in that class (docs/README.md)",
  meta: {
    skipped: true,
    verdict: "skipped",
    policy: "judge-only",
    reason: "every declared path and every path this diff touched is provably leaf-class work",
    paths: ["docs/README.md"],
  },
};

/**
 * The held screen: a selected-test green that the full suite has not superseded. run-gates.ts:296-299
 * holds exactly this result, and journal.ts:1067-1071 is the fold that already refuses to call it
 * satisfied — it reports `pass: true` and is not the merge verdict.
 */
const HELD_SCREEN: GateResult = {
  gate: "test",
  pass: true,
  details: "exit 0 on the selected subset",
  meta: { selectedTests: ["tests/run/outcome-projections.test.ts"] },
};

/** Every member of the closed union, one sample each — the vocabulary half of the table. */
const VOCABULARY: GateOutcome[] = [
  { kind: "passed" },
  { kind: "failed" },
  { kind: "skipped", reason: "no lint command detected — skipped" },
  { kind: "declined", reason: "reviewPolicy judge-only declined the round" },
  { kind: "held", reason: "selected-test screen; the full suite has not spoken" },
  { kind: "unavailable", reason: "the row states no verdict" },
  { kind: "infra", reason: "Error: spawn EAGAIN", retryable: true },
];

test("a gate result whose explicit outcome field disagrees with its bare fields resolves to one kind through the accessor, so a row cannot be kept by one reader and painted by another", () => {
  const bareRow = { gate: "review", pass: true };
  const wrappedRow = {
    ...bareRow,
    outcome: { kind: "declined", reason: "reviewPolicy declined this gate" },
  };
  expect(normalizeGateOutcome(bareRow).kind).toBe("passed");
  expect(normalizeGateOutcome(wrappedRow).kind).toBe("declined");
  expect(normalizeGateOutcome(wrappedRow)).toEqual(wrappedRow.outcome);
});

test("a held selected-test screen and a full-suite pass resolve to different kinds, so the two greens stop sharing one string at the source", () => {
  const held = normalizeGateOutcome({
    gate: "test",
    pass: true,
    selectedTests: ["tests/run/outcome-projections.test.ts"],
    details: "selected test screen passed",
  });
  const full = normalizeGateOutcome({
    gate: "test",
    pass: true,
    selectedTests: ["tests/run/outcome-projections.test.ts"],
    fullSuite: true,
    details: "full suite passed",
  });
  expect(held.kind).toBe("held");
  expect(full.kind).toBe("passed");
  expect(held.kind).not.toBe(full.kind);
});

test("the diff leaves the exported kind list unchanged, so this task cannot break a reader it does not own", () => {
  expect([...GATE_OUTCOME_KINDS]).toEqual([
    "passed", "failed", "skipped", "declined", "held", "unavailable", "infra",
  ]);
});

// Deliberately titled verbatim at TOP LEVEL: the shipped acceptance gate runs the criterion through
// `testFilterPattern`, whose leaf-anchored `(^| )…$` matches the criterion as the complete trailing
// segment of Vitest's runner-visible full name (acceptance.ts — OBS-511 widened it through describe
test("closed GateOutcome table drives normalizeGateOutcome over every vocabulary member and over legacy review-skip, baseline-skip, infra-retryable, held and malformed rows, where passed and failed controls remain unchanged and every reason is retained, so collapsing non-failure into pass or unknown into clean fails", async () => {
  // The vocabulary half. The table must name EVERY member — a member added to the union without a
  // sample here fails this line, so the table cannot silently stop being closed.
  expect(VOCABULARY.map((o) => o.kind)).toEqual([...GATE_OUTCOME_KINDS]);
  for (const member of VOCABULARY) {
    // Idempotent over the vocabulary: T40 publishes typed outcomes while pre-T40 journals still hold
    // legacy rows, so a projection calls one normalizer without asking which era it is reading.
    expect(normalizeGateOutcome(member)).toEqual(member);
  }

  // The legacy half. These two rows are PRODUCED by the shipped gate over real runners, not written
  // here: a skip of a command the repository never configured, and a runner that died on the machine.
  const bench = makeRepo({ "base.txt": "base\n" });
  const [baselineSkip] = await compareToBaseline(bench, {}, { commands: {} }, ["lint"]);
  const [infraFailure] = await compareToBaseline(
    bench,
    { test: "printf '%s\\n' 'Error: spawn EAGAIN' >&2; exit 1" },
    { commands: { test: { exitCode: 1, fingerprints: [] } } },
    ["test"],
  );
  const [passControl] = await compareToBaseline(bench, { build: "exit 0" }, { commands: {} }, ["build"]);
  const [failControl] = await compareToBaseline(
    bench,
    { test: "printf '%s\\n' 'FAIL tests/a.test.ts > adds two numbers'; exit 1" },
    { commands: { test: { exitCode: 0, fingerprints: [] } } },
    ["test"],
  );
  expect(baselineSkip!.meta?.skipped).toBe(true);
  expect(infraFailure!.meta?.infra).toBe(true);

  const table: { what: string; row: unknown; expected: GateOutcome }[] = [
    // Controls: a real green and a real red are unchanged by the vocabulary.
    { what: "pass control", row: journalRow(passControl!), expected: { kind: "passed" } },
    { what: "fail control", row: journalRow(failControl!), expected: { kind: "failed" } },
    {
      what: "legacy baseline-skip",
      row: journalRow(baselineSkip!),
      expected: { kind: "skipped", reason: baselineSkip!.details },
    },
    {
      what: "legacy review-skip",
      row: journalRow(REVIEW_DECLINE),
      expected: {
        kind: "declined",
        reason: `${REVIEW_DECLINE.meta!.reason} — ${REVIEW_DECLINE.details}`,
      },
    },
    // The review-skip shape that is actually on disk in most runs. Pre-R3 (daemon.ts:1386) the review
    // gate journaled its policy decline as `pass: true` beside `skipped: true` — indistinguishable
    // from a baseline command-absent skip by field, and indistinguishable from a GREEN to any reader
    // that only consults `pass`. R3 changed what NEW rows look like, not what old journals hold, and
    // report/bundle.ts:19-22 still reads both. Reproduced verbatim, not routed through journalRow():
    // no producer in this tree emits it any more, and the point is that the normalizer must still.
    {
      what: "historical review-skip carrying pass:true",
      row: {
        gate: "review",
        pass: true,
        skipped: true,
        details: "skipped — complexity 4 < threshold 7",
      },
      expected: { kind: "declined", reason: "skipped — complexity 4 < threshold 7" },
    },
    {
      // Older still: the decline predates the `skipped` field and states itself only in the details
      // prefix — the exact rows bundle.ts's ^-anchored predicate exists for.
      what: "historical review-skip predating the skipped field",
      row: { gate: "review", pass: true, details: "skipped — complexity 2 < threshold 7" },
      expected: { kind: "declined", reason: "skipped — complexity 2 < threshold 7" },
    },
    {
      // The ^ anchor is load-bearing in both directions: a review that RAN and mentions a skipped
      // something mid-body is a verdict, not a decline.
      what: "review that ran and merely mentions a skip mid-body",
      row: { gate: "review", pass: true, details: "approved — the diff skipped no declared path" },
      expected: { kind: "passed" },
    },
    {
      // The prefix-only compatibility case belongs to historical REVIEW declines. A failed test may
      // begin its diagnostic with the same word and its explicit red verdict remains authoritative.
      what: "failed test whose diagnostic begins with skipped",
      row: { gate: "test", pass: false, details: "skipped tests/a.test.ts because setup failed" },
      expected: { kind: "failed" },
    },
    {
      what: "legacy infra-retryable",
      row: journalRow(infraFailure!),
      expected: { kind: "infra", reason: infraFailure!.details, retryable: true },
    },
    {
      what: "legacy held screen",
      row: journalRow(HELD_SCREEN),
      expected: { kind: "held", reason: HELD_SCREEN.details },
    },
    // Malformed: no verdict field at all, a non-boolean pass, and inputs that are not rows.
    {
      what: "malformed row stating no verdict",
      row: { gate: "test", details: "the runner emitted no verdict" },
      expected: { kind: "unavailable", reason: "the runner emitted no verdict" },
    },
    {
      what: "malformed row whose pass is a string",
      row: { gate: "test", pass: "true", details: "pass arrived as text" },
      expected: { kind: "unavailable", reason: "pass arrived as text" },
    },
    {
      what: "malformed canonical pass mixed with a legacy failure",
      row: { kind: "passed", pass: false, details: "explicit failure" },
      expected: { kind: "unavailable", reason: "explicit failure" },
    },
    {
      what: "malformed canonical pass mixed with legacy infra",
      row: { kind: "passed", infra: true, details: "runner exited before reporting a verdict" },
      expected: { kind: "unavailable", reason: "runner exited before reporting a verdict" },
    },
    {
      what: "malformed row with nothing to retain",
      row: { gate: "test" },
      expected: { kind: "unavailable", reason: "gate result states no pass, skip, decline or infra verdict" },
    },
    {
      what: "malformed non-row",
      row: null,
      expected: { kind: "unavailable", reason: "malformed gate result: expected an object, read null" },
    },
  ];

  for (const { what, row, expected } of table) {
    expect(normalizeGateOutcome(row), what).toEqual(expected);
  }

  // Canonical and legacy discriminators are mutually exclusive producer formats. Exercise that
  // boundary across the entire closed union and every legacy truth field: even a consistent-looking
  // dual-write is malformed, and its stated reason must survive the fail-closed result.
  const legacyDiscriminators: { field: "pass" | "skipped" | "verdict" | "infra"; value: unknown }[] = [
    { field: "pass", value: true },
    { field: "skipped", value: true },
    { field: "verdict", value: "skipped" },
    { field: "infra", value: true },
  ];
  for (const member of VOCABULARY) {
    for (const { field, value } of legacyDiscriminators) {
      const details = `mixed ${member.kind} outcome carrying legacy ${field}`;
      const outcome = normalizeGateOutcome({ ...member, [field]: value, details });
      expect(outcome.kind, details).toBe("unavailable");
      expect(outcome.kind === "unavailable" && outcome.reason, details).toContain(details);
    }
  }

  // Collapsing non-failure into pass fails: every legacy row that is not the pass control is read as
  // its own member and never as `passed` — the four fields legacy truth is spread across (pass,
  // skipped, verdict, infra) each carry a `pass: true` or a missing `pass` that a raw read gets wrong.
  for (const { what, row, expected } of table) {
    if (expected.kind === "passed") continue;
    expect(normalizeGateOutcome(row).kind, `${what} must not read as passed`).not.toBe("passed");
  }

  // Unknown into clean fails: an unreadable row is a stated non-verdict, never absent and never green.
  for (const { what, row, expected } of table) {
    if (expected.kind !== "unavailable") continue;
    const outcome = normalizeGateOutcome(row);
    expect(outcome.kind, `${what} must stay unavailable`).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reason.length > 0).toBe(true);
  }

  // Every reason is retained: each non-verdict outcome carries the row's own words back out, so no
  // projection has to re-read the raw row to tell an operator why a gate did not verify anything.
  for (const { what, row, expected } of table) {
    if (expected.kind === "passed" || expected.kind === "failed") continue;
    const outcome = normalizeGateOutcome(row);
    const stated = [(row as Record<string, unknown>)?.reason, (row as Record<string, unknown>)?.details]
      .filter((r): r is string => typeof r === "string");
    for (const said of stated) {
      expect(outcome.kind !== "passed" && outcome.kind !== "failed" && outcome.reason, what).toContain(said);
    }
  }

  // The table is closed over the union: together the two halves drive every member, so no kind can be
  // added to the vocabulary without a case that exercises it.
  const driven = new Set<GateOutcomeKind>([...VOCABULARY, ...table.map((c) => c.expected)].map((o) => o.kind));
  expect([...driven].sort()).toEqual([...GATE_OUTCOME_KINDS].sort());
});
