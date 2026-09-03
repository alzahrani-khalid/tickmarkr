import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { specTemplate } from "../../src/compile/native.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// The spec-authoring law only reaches users through the file `tickmarkr init` writes, so read it from a
// freshly initialised repository rather than from specTemplate() — a law asserted only against its own
// source is exactly the divergence these tests exist to catch.
async function initialisedSpec(): Promise<string> {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  const repo = makeRepo({ "keep.txt": "x" });
  await init(["--global-dir", makeTestTempDir("tickmarkr-spec-template-global-")], repo);
  return readFileSync(join(repo, "tickmarkr.spec.md"), "utf8");
}

afterEach(() => vi.restoreAllMocks());

const DAEMON_SURFACE_LAW =
  "A task changing what the daemon DOES must own every surface that TELLS the operator what the daemon does.";
const SINGLE_CLAIM_LAW =
  "A judge criterion carries ONE claim; a semicolon-joined criterion warns — split its clauses.";

function statesDaemonAndJudgeLaws(written: string): boolean {
  return written.includes(DAEMON_SURFACE_LAW) && written.includes(SINGLE_CLAIM_LAW);
}

// The section authors are pointed at. Slicing it keeps every assertion below about the criterion law
// itself, never about the same words appearing somewhere else in the template.
function criterionSection(written: string): string {
  return written.slice(
    written.indexOf("WHAT MAKES A CRITERION REAL:"),
    written.indexOf("ORDERING AND OWNERSHIP:"),
  );
}

// The pair law as a predicate over author-facing wording: it holds only when BOTH halves are demanded —
// the case that must pass and the neighbouring one that must fail. Wording that asks for two examples and
// never names a failing case is the plausible-wrong neighbour, so the predicate has to reject it.
function demandsBothHalvesOfThePair(section: string): boolean {
  return (
    /NAMES THE PAIR IT DISCRIMINATES/.test(section) &&
    /MUST PASS/.test(section) &&
    /MUST FAIL/.test(section) &&
    /not discrimination/.test(section)
  );
}

const STUB_QUESTION = "COULD THIS BE SATISFIED BY CODE THAT NOTHING OUTSIDE THE TEST SUITE CALLS?";
const FALSE_CLEAN_RULE =
  "the concrete FALSE-CLEAN case: what a passing test would look like if the mechanism were absent";

const EXISTING_CRITERION_LAWS = [
  "title must match the criterion string verbatim",
  "NO criterion may be satisfiable by an absence, a rename, a source-text grep, or an empty collection",
  '"goal:" is NEVER verification',
  'A source-only obligation (a comment or doc that a change makes false) has no lawful "test:"',
  "A criterion that pins the SHAPE of a fix must also pin the CONDITIONS under which it runs",
  "Enumerating one axis exhaustively is what hides the others",
  "A criterion that names a behaviour must name the VALUE AT WHICH IT WOULD BREAK",
  STUB_QUESTION,
  FALSE_CLEAN_RULE,
];

function carriesEveryExistingLaw(section: string): boolean {
  return EXISTING_CRITERION_LAWS.every((law) => section.includes(law));
}

function spikeSection(written: string): string {
  return written.slice(
    written.indexOf("PRE-SCOPE BY TEXT, ENUMERATE BLOCKERS BY EXECUTION:"),
    written.indexOf("WHICH SIDE OF A RUN INHERITS ENVIRONMENT"),
  );
}

function statesSpikeTrigger(section: string): boolean {
  return /Could a test this task does not own be asserting the\s+thing I am changing\?/i.test(section)
    && /I'D HAVE TO GREP TO KNOW" IS YES/i.test(section);
}

function statesSpikeCaveat(section: string): boolean {
  return /spike measures ONE implementation/i.test(section)
    && /does NOT make its reds the closed blocker set/i.test(section)
    && /worker taking a different route can\s+still red on unowned collateral/i.test(section)
    && /PLAN\s+DEFECT, NEVER A RETRY/i.test(section);
}

function statesSpikeCost(section: string): boolean {
  return /Measured price: 518 s implement \+ 831 s suite = 1,348 s ≈ 22\.5 min/.test(section)
    && /"Far cheaper than the alternative"\s+is WITHDRAWN on the direct leg/i.test(section)
    && /on the direct leg the\s+two are EQUAL/i.test(section);
}

function statesSpikeNonApplication(section: string): boolean {
  return /Do NOT run the spike for a change that is purely additive and unwinds cheaply/i.test(section)
    && /bounded by\s+the expense of a late defect, not by novelty/i.test(section);
}

describe("spec template — daemon surfaces and single-claim judges", () => {
  test("test: the spec template a fresh tickmarkr init writes states in its ordering law that a task changing what the daemon does must own every surface that tells the operator what the daemon does and states beside the judge oracle that a judge criterion carries one claim so a semicolon-joined criterion warns whereas a template missing either sentence fails", async () => {
    const written = await initialisedSpec();

    expect(statesDaemonAndJudgeLaws(written)).toBe(true);
    expect(written.indexOf(SINGLE_CLAIM_LAW)).toBeGreaterThan(written.indexOf("- judge: <rubric>"));
    expect(written.indexOf(SINGLE_CLAIM_LAW)).toBeLessThan(written.indexOf("- <plain text>"));
    expect(written.indexOf(DAEMON_SURFACE_LAW)).toBeGreaterThan(written.indexOf("ORDERING AND OWNERSHIP:"));

    for (const missing of [DAEMON_SURFACE_LAW, SINGLE_CLAIM_LAW]) {
      expect(statesDaemonAndJudgeLaws(written.replace(missing, ""))).toBe(false);
    }
  });
});

describe("spec template — spike contract before scope", () => {
  test("test: the template a freshly initialised repository receives states the trigger as a question about a test the task does not own and rules that needing to grep in order to answer it is a yes; wording that asks only whether the change is risky leaves the author to judge scope by feel and fails", async () => {
    const section = spikeSection(await initialisedSpec());

    expect(statesSpikeTrigger(section)).toBe(true);

    const riskyOnly = "SPIKE-THE-CONTRACT-THEN-SCOPE: If this change feels risky, run a spike first.";
    expect(riskyOnly).not.toMatch(/test this task does not own/i);
    expect(statesSpikeTrigger(riskyOnly)).toBe(false);
  });

  test("test: the template states that a spike measures one implementation, so a worker taking a different route can still red on unowned collateral and that remains a plan defect rather than a retry; text presenting the spike's result as the closed blocker set fails", async () => {
    const section = spikeSection(await initialisedSpec());

    expect(statesSpikeCaveat(section)).toBe(true);

    const closedSet = "A spike closes the blocker set; rerun any worker that finds more collateral.";
    expect(statesSpikeCaveat(closedSet)).toBe(false);
  });

  test("test: the template carries the measured cost and records that the cheaper-than-the-alternative claim is withdrawn on the direct leg; a cost stated as a saving rather than as a price gets the rule run on every task and fails", async () => {
    const section = spikeSection(await initialisedSpec());

    expect(statesSpikeCost(section)).toBe(true);

    const saving = "The spike is far cheaper than the alternative, saving a halted run.";
    expect(statesSpikeCost(saving)).toBe(false);
  });

  test("test: the template names the case where the rule must not be run — a change that is purely additive and unwinds cheaply — so the rule is bounded by the expense of a late defect rather than by novelty; text without a stated non-application fails", async () => {
    const section = spikeSection(await initialisedSpec());

    expect(statesSpikeNonApplication(section)).toBe(true);

    const noBound = "Run the spike for new observable contracts.";
    expect(statesSpikeNonApplication(noBound)).toBe(false);
  });
});

describe("spec template — a criterion names the pair it discriminates", () => {
  test("test: the spec template a freshly initialised repository writes requires every criterion to name the case that must pass and the neighbouring case that must fail; wording asking only for two examples fails", async () => {
    const section = criterionSection(await initialisedSpec());

    expect(section).toContain("EVERY CRITERION NAMES THE PAIR IT DISCRIMINATES");
    expect(section).toMatch(/the correct case that MUST PASS/);
    expect(section).toMatch(/neighbouring plausible-wrong or false-clean case that MUST FAIL/);
    expect(demandsBothHalvesOfThePair(section)).toBe(true);

    // The neighbouring wrong wording: asks for two cases, never names one that must fail. Same shape,
    // same vocabulary, no discrimination — the law is only real if this is rejected.
    const twoExamplesOnly = [
      "  WHAT MAKES A CRITERION REAL:",
      "    - Give every criterion TWO DISCRIMINATING CASES drawn from the full domain the system accepts,",
      "      and prefer two examples to one: a criterion tested at a single convenient value proves little.",
      "",
      "  ORDERING AND OWNERSHIP:",
    ].join("\n");
    expect(demandsBothHalvesOfThePair(criterionSection(twoExamplesOnly))).toBe(false);
  });

  test("test: the template still carries every existing criterion-quality law beside the new pair rule; a rewrite that drops the stub-satisfiability question or the false-clean rule fails", async () => {
    const section = criterionSection(await initialisedSpec());

    expect(demandsBothHalvesOfThePair(section)).toBe(true);
    expect(carriesEveryExistingLaw(section)).toBe(true);

    // The false-clean case a "beside" claim hides: the pair rule lands and a law it was meant to sit
    // beside quietly leaves with it. Each rewrite still satisfies the pair law and must still be rejected.
    for (const dropped of [STUB_QUESTION, FALSE_CLEAN_RULE]) {
      const rewrite = section.replace(dropped, "");
      expect(rewrite).not.toBe(section);
      expect(demandsBothHalvesOfThePair(rewrite)).toBe(true);
      expect(carriesEveryExistingLaw(rewrite)).toBe(false);
    }
  });

  test("test: the template still carries every criterion-quality law it held before, including the pair-discrimination rule and the stub-satisfiability question; a rewrite that drops or weakens one while adding the new section fails", async () => {
    const written = await initialisedSpec();
    const section = criterionSection(written);

    expect(spikeSection(written)).toContain("SPIKE-THE-CONTRACT-THEN-SCOPE");
    expect(demandsBothHalvesOfThePair(section)).toBe(true);
    expect(carriesEveryExistingLaw(section)).toBe(true);

    const dropsStub = section.replace(STUB_QUESTION, "");
    expect(carriesEveryExistingLaw(dropsStub)).toBe(false);

    const weakensPair = section.replace("neighbouring plausible-wrong or false-clean case that MUST FAIL", "neighbouring plausible case");
    expect(weakensPair).not.toBe(section);
    expect(demandsBothHalvesOfThePair(weakensPair)).toBe(false);
  });
});

describe("spec template — stub-satisfiability law", () => {
  test("test: the template the init path writes contains the stub-satisfiability test stated as a question an author applies to each criterion, and names the production caller as what distinguishes a real criterion from a satisfiable one", async () => {
    const written = await initialisedSpec();

    // Stated as a question the author asks of every criterion, not as background prose.
    expect(written).toContain("Ask of every criterion:");
    expect(written).toContain("COULD THIS BE SATISFIED BY CODE THAT NOTHING OUTSIDE THE TEST SUITE CALLS?");
    // ...and answered by naming the production caller, which is what a stub lacks.
    expect(written).toContain("PRODUCTION CALLER");
    expect(written).toMatch(/A criterion naming a CAPABILITY is satisfiable by a stub/);
    expect(written).toMatch(/PRODUCTION CALLER\n\s+that must exercise the capability/);
  });

  test("test: the template reaching a freshly initialised repository is the same text, so the law is not documentation that diverges from what is written", async () => {
    expect(await initialisedSpec()).toBe(specTemplate());
  });

  test("test: the new law sits with the existing criterion-quality rules and weakens none of them", async () => {
    const written = await initialisedSpec();
    const section = written.slice(
      written.indexOf("WHAT MAKES A CRITERION REAL:"),
      written.indexOf("ORDERING AND OWNERSHIP:"),
    );

    expect(section).toContain("COULD THIS BE SATISFIED BY CODE THAT NOTHING OUTSIDE THE TEST SUITE CALLS?");
    // The rules that were already there stay there, verbatim.
    for (const rule of [
      "title must match the criterion string verbatim",
      "NO criterion may be satisfiable by an absence, a rename, a source-text grep, or an empty collection",
      '"goal:" is NEVER verification',
      'A source-only obligation (a comment or doc that a change makes false) has no lawful "test:"',
      "A criterion that pins the SHAPE of a fix must also pin the CONDITIONS under which it runs",
      "Enumerating one axis exhaustively is what hides the others",
    ]) {
      expect(section).toContain(rule);
    }
  });
});
