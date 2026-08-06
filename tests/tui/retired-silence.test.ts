import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const RETIRED_HEADERS = ["consult-dossier", "engine", "input", "runs-view"] as const;
const REPO_ROOT = join(import.meta.dirname, "..", "..");

type RunnerAssertion = {
  ancestorTitles: string[];
  status: string;
  title: string;
};

type RunnerReport = {
  numFailedTests: number;
  numPassedTests: number;
  numPendingTests: number;
  numTotalTests: number;
  success: boolean;
  testResults: Array<{
    assertionResults: RunnerAssertion[];
    name: string;
  }>;
};

function runRetiredHeadersFixture(): RunnerReport {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tickmarkr-retired-silence-"));
  const fixturePath = join(fixtureRoot, "retired-headers.fixture.test.ts");
  const reportPath = join(fixtureRoot, "report.json");
  const disabledSuiteDeclaration = ["const describe = d", "skip;"].join(".");
  const fixtureSource = [
    'import { describe as d, test } from "vitest";',
    disabledSuiteDeclaration,
    ...RETIRED_HEADERS.flatMap((header) => [
      `describe(${JSON.stringify(header)}, () => {`,
      `  test(${JSON.stringify(`assertion beneath ${header}`)}, () => {`,
      `    throw new Error(${JSON.stringify(`retired assertion executed: ${header}`)});`,
      "  });",
      "});",
    ]),
    'test("live sentinel", () => {});',
    "",
  ].join("\n");

  try {
    writeFileSync(fixturePath, fixtureSource);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "VITEST" && !key.startsWith("VITEST_")),
    );
    try {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
          "run",
          fixturePath,
          "--root",
          fixtureRoot,
          "--reporter=json",
          "--outputFile",
          reportPath,
        ],
        { cwd: fixtureRoot, encoding: "utf8", env, stdio: "pipe" },
      );
    } catch (error) {
      const result = error as { stderr?: string; stdout?: string };
      throw new Error(`retired-header fixture failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
    return JSON.parse(readFileSync(reportPath, "utf8")) as RunnerReport;
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

let cachedReport: RunnerReport | undefined;

function runnerReport(): RunnerReport {
  cachedReport ??= runRetiredHeadersFixture();
  return cachedReport;
}

function reportedAssertions(): RunnerAssertion[] {
  return runnerReport().testResults.flatMap((result) => result.assertionResults);
}

test("a suite carrying a retired header registers its assertions and executes none of them, proven member by member over the closed set of retired headers — the consult-dossier, engine, input and runs-view headers — each read from the runner's own report rather than from its source", () => {
  const assertions = reportedAssertions();

  expect(runnerReport()).toMatchObject({
    numFailedTests: 0,
    numPassedTests: 1,
    numPendingTests: RETIRED_HEADERS.length,
    numTotalTests: RETIRED_HEADERS.length + 1,
    success: true,
  });
  for (const header of RETIRED_HEADERS) {
    const registered = assertions.filter((assertion) => assertion.ancestorTitles.includes(header));
    expect(registered, header).toHaveLength(1);
    expect(registered[0], header).toMatchObject({
      ancestorTitles: [header],
      status: "skipped",
      title: `assertion beneath ${header}`,
    });
  }
});

test("a live sentinel beside a retired header in the same file is reported as passed, so the header silences its own block rather than the whole file", () => {
  const report = runnerReport();
  expect(report.testResults).toHaveLength(1);
  expect(report.testResults[0].name.replaceAll("\\", "/")).toMatch(/\/retired-headers\.fixture\.test\.ts$/);
  const assertions = report.testResults[0].assertionResults;
  expect(assertions.some((assertion) => assertion.ancestorTitles.length > 0)).toBe(true);
  const sentinels = assertions.filter((assertion) => assertion.title === "live sentinel");

  expect(sentinels).toHaveLength(1);
  expect(sentinels[0]).toMatchObject({
    ancestorTitles: [],
    status: "passed",
    title: "live sentinel",
  });
});
