import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { TEST_REPORTER_SOURCE } from "../../src/gates/test-reporter.js";
import { verifyManifestReport, type TestReport } from "../../src/gates/test-manifest.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const FILE = "tests/suite.test.ts";
const NAME = "suite > compares scopes";

/** Loads the reporter class from its shipped source string and drives it with fake module objects —
 * no runner spawn. Returns the completion record the reporter wrote for the one failing module. */
async function complete(errors: Array<Record<string, unknown>>) {
  const dir = makeTestTempDir("reporter-");
  const source = join(dir, "reporter.mjs");
  const reportPath = join(dir, "report.json");
  writeFileSync(source, TEST_REPORTER_SOURCE);
  const saved = { report: process.env.TICKMARKR_TEST_REPORT, nonce: process.env.TICKMARKR_TEST_NONCE };
  process.env.TICKMARKR_TEST_REPORT = reportPath;
  process.env.TICKMARKR_TEST_NONCE = "n1";
  try {
    const Reporter = (await import(pathToFileURL(source).href)).default;
    const reporter = new Reporter();
    const module = {
      moduleId: join(reporter.cwd, FILE),
      state: () => "failed",
      children: { allTests: () => [{ fullName: NAME, result: () => ({ state: "failed", errors }) }] },
      errors: () => [],
    };
    reporter.onTestRunStart([module]);
    reporter.onTestModuleStart(module);
    reporter.onTestModuleEnd(module);
    reporter.onTestRunEnd([module], [], "failed");
  } finally {
    for (const [k, v] of [["TICKMARKR_TEST_REPORT", saved.report], ["TICKMARKR_TEST_NONCE", saved.nonce]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as TestReport;
  return { report, completion: report.completed[FILE]! };
}

const ELIDED = "expected [ …(3) ] to deeply equal [ …(3) ]";

test("test: a failing assertion whose runner error carries a diff naming a nested file yields a completion record whose evidence field holds that filename, so a record keeping only the elided message fails", async () => {
  const diff = '- Expected\n+ Received\n\n  [\n-   "src/gates/nested/in-scope.ts",\n+   "src/gates/nested/other.ts",\n  ]';
  const { completion } = await complete([{ message: ELIDED, diff }]);
  expect(completion.failures).toEqual([`FAIL ${FILE} > ${NAME}: ${ELIDED}`]);
  expect(completion.failures!.join("\n")).not.toContain("in-scope.ts");
  expect(completion.evidence).toHaveLength(1);
  expect(completion.evidence![0]!.test).toBe(`${FILE} > ${NAME}`);
  expect(completion.evidence![0]!.text).toContain("src/gates/nested/in-scope.ts");
  expect(completion.evidence![0]!.truncated).toBeUndefined();
  expect(completion.evidence![0]!.unavailable).toBeUndefined();
});

test("test: a runner error whose payload exceeds 4096 bytes yields evidence cut at the cap plus a truncated marker whereas an error carrying no payload yields an unavailable marker, so invented evidence fails", async () => {
  // Multibyte payload: a cap counted in characters would overshoot 4096 BYTES.
  const big = await complete([{ message: ELIDED, diff: "é".repeat(5000) }]);
  const cut = big.completion.evidence![0]!;
  expect(cut.truncated).toBe(true);
  expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(cut.text)).toBeGreaterThan(4090);
  expect("é".repeat(5000).startsWith(cut.text)).toBe(true);

  // The budget is per failed TEST, not per error: two soft-assertion errors share one 4096-byte entry.
  const soft = await complete([{ message: ELIDED, diff: "a".repeat(4000) }, { message: "second", diff: "b".repeat(4000) }]);
  expect(soft.completion.failures).toHaveLength(2);
  expect(soft.completion.evidence).toHaveLength(1);
  expect(soft.completion.evidence![0]!.truncated).toBe(true);
  expect(soft.completion.evidence![0]!.text).toContain("b");
  expect(Buffer.byteLength(soft.completion.evidence!.map(e => e.text).join(""))).toBeLessThanOrEqual(4096);

  const bare = await complete([{ message: ELIDED }]);
  expect(bare.completion.evidence).toEqual([{ test: `${FILE} > ${NAME}`, text: "", unavailable: true }]);
  // A failed test with no error object at all: still unavailable, still nothing invented.
  const none = await complete([]);
  expect(none.completion.evidence).toEqual([{ test: `${FILE} > ${NAME}`, text: "", unavailable: true }]);

  const fits = await complete([{ message: ELIDED, actual: "a.ts", expected: "b.ts" }]);
  expect(fits.completion.evidence![0]).toEqual({ test: `${FILE} > ${NAME}`, text: "actual: a.ts\nexpected: b.ts" });
});

test("test: two reports of one failing test that differ only in their evidence produce byte-identical verdict details plus identical failing fingerprints, so evidence that alters the failure identity fails", async () => {
  const a = await complete([{ message: ELIDED, diff: "- src/nested/a.ts" }]);
  const b = await complete([{ message: ELIDED, diff: "+ some/other/b.ts\n" + "x".repeat(9000) }]);
  expect(a.completion.evidence).not.toEqual(b.completion.evidence);
  const verdict = (report: TestReport) => verifyManifestReport({ manifest: [FILE], nonce: "n1", exitCode: 1, report });
  const va = verdict(a.report), vb = verdict(b.report);
  expect(va.kind).toBe("work");
  expect(va.details).toBe(vb.details);
  expect(va.details).not.toContain("a.ts");
  expect(va.meta.failingTests).toEqual(vb.meta.failingTests);
  expect(va.meta.failingTests).toEqual([`FAIL ${FILE} > ${NAME}: ${ELIDED}`]);
  expect(va.meta.failingFiles).toEqual(vb.meta.failingFiles);
  expect((va.meta.failureEvidence as Array<{ text: string }>)[0]!.text).toContain("src/nested/a.ts");
  expect((vb.meta.failureEvidence as Array<{ truncated?: boolean }>)[0]!.truncated).toBe(true);
});
