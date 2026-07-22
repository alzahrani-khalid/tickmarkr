import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { compileSource } from "../../src/compile/index.js";
import {
  aggregateChannelTotals,
  CANARY_FIXTURE_ID,
  ensureCanary,
  isCanaryFixture,
  resolveCanaryFixture,
  runCanaryJudge,
  type FixtureChannelResult,
} from "../../src/eval/canary.js";
import { discoverFixtures, type Fixture } from "../../src/eval/fixtures.js";

const EVAL_FIXTURES_ROOT = join(process.cwd(), "fixtures", "eval");

function fakeWithJudge(judge: unknown): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-canary-judge-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, judge }));
  return new FakeAdapter(p);
}

function fixtureAt(root: string, id: string): Fixture {
  const path = join(root, id);
  return { id, path, startDir: join(path, "start"), solutionDir: join(path, "solution") };
}

describe("held-out known-fail judge canary", () => {
  test("the canary fixture's result is excluded from the channel-qualification totals it would otherwise contribute to", () => {
    const results: FixtureChannelResult[] = [
      { fixtureId: "alpha", channelKey: "fake:m1", skipped: false, pass: true },
      { fixtureId: "alpha", channelKey: "fake:m2", skipped: false, pass: false },
      { fixtureId: CANARY_FIXTURE_ID, channelKey: "fake:m1", skipped: false, pass: false },
      { fixtureId: CANARY_FIXTURE_ID, channelKey: "fake:m2", skipped: true },
    ];

    const totals = aggregateChannelTotals(results);

    expect(totals).toHaveLength(2);
    const m1 = totals.find((t) => t.channelKey === "fake:m1")!;
    const m2 = totals.find((t) => t.channelKey === "fake:m2")!;
    expect(m1.total).toBe(1);
    expect(m1.passed).toBe(1);
    expect(m1.failed).toBe(0);
    expect(m2.total).toBe(1);
    expect(m2.failed).toBe(1);
    expect(m2.skipped).toBe(0);
  });

  test("a judge verdict that correctly fails the canary is recorded as the expected outcome", async () => {
    const fixture = resolveCanaryFixture(EVAL_FIXTURES_ROOT);
    expect(fixture).toBeDefined();

    const fake = fakeWithJudge({
      pass: false,
      criteria: [
        {
          criterion: "c1",
          met: false,
          reason: "a.txt does not contain the required marker",
          evidence: "+canary-wrong",
        },
      ],
    });

    const result = await runCanaryJudge(fixture!, fake, "fake-1");

    expect(result.fixtureId).toBe(CANARY_FIXTURE_ID);
    expect(result.expectedPass).toBe(false);
    expect(result.judgePass).toBe(false);
    expect(result.breach).toBe(false);
    expect(result.details).toContain("c1");
  });

  test("a judge verdict that passes the canary is flagged as a judge-integrity breach rather than folded in as a normal result", async () => {
    const fixture = resolveCanaryFixture(EVAL_FIXTURES_ROOT);
    expect(fixture).toBeDefined();

    const fake = fakeWithJudge({
      pass: true,
      criteria: [
        {
          criterion: "c1",
          met: true,
          reason: "rubber-stamped",
          evidence: "+canary-wrong",
        },
      ],
    });

    const result = await runCanaryJudge(fixture!, fake, "fake-1");

    expect(result.fixtureId).toBe(CANARY_FIXTURE_ID);
    expect(result.expectedPass).toBe(false);
    expect(result.judgePass).toBe(true);
    expect(result.breach).toBe(true);
  });

  test("the canary runs on every invocation of the command regardless of which fixtures were requested", () => {
    const empty = ensureCanary([], EVAL_FIXTURES_ROOT);
    expect(empty.some(isCanaryFixture)).toBe(true);
    expect(empty).toHaveLength(1);

    const withOthers = ensureCanary([fixtureAt(EVAL_FIXTURES_ROOT, "sample")], EVAL_FIXTURES_ROOT);
    expect(withOthers.some(isCanaryFixture)).toBe(true);
    expect(withOthers).toHaveLength(2);
    expect(withOthers[0]!.id).toBe(CANARY_FIXTURE_ID);

    const alreadyPresent = ensureCanary([fixtureAt(EVAL_FIXTURES_ROOT, CANARY_FIXTURE_ID)], EVAL_FIXTURES_ROOT);
    expect(alreadyPresent).toHaveLength(1);
  });

  test("the canary's expected-fail condition comes from a genuinely unmet acceptance criterion rather than a fixture that merely errors out", async () => {
    const fixture = resolveCanaryFixture(EVAL_FIXTURES_ROOT);
    expect(fixture).toBeDefined();

    const graph = compileSource(join(fixture!.path, "spec.md"));
    expect(graph.tasks).toHaveLength(1);
    const task = graph.tasks[0]!;
    expect(task.acceptance.length).toBeGreaterThan(0);
    expect(task.acceptance.some((item) => typeof item === "string" || item.oracle === "judge")).toBe(true);

    const fake = fakeWithJudge({
      pass: false,
      criteria: [
        {
          criterion: "c1",
          met: false,
          reason: "the diff does not add the required canary-verified marker",
          evidence: "+canary-wrong",
        },
      ],
    });

    const result = await runCanaryJudge(fixture!, fake, "fake-1");
    expect(result.breach).toBe(false);
    expect(result.details).not.toMatch(/malformed|unparseable|no spec|failed to compile/i);
    expect(result.details).toContain("c1");
  });
});

describe("canary fixture discovery", () => {
  test("the checked-in eval fixtures include the canary fixture with the required start and solution parts", () => {
    const { valid } = discoverFixtures(EVAL_FIXTURES_ROOT);
    const canary = valid.find(isCanaryFixture);
    expect(canary).toBeDefined();
    expect(canary!.id).toBe(CANARY_FIXTURE_ID);
  });
});
