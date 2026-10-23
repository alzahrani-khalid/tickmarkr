import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  type Baseline,
  captureBaseline,
  classifyFailureOutput,
  classifyRunnerOutput,
  compareToBaseline,
  fingerprint,
  freshFailures,
} from "../../src/gates/baseline.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Queue rows 211 and 224(a) (D-2118): replay the recorded streams through the production readers.
const fixture = (file: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", file), "utf8");
const WATCHMAN = fixture("baseline-jest/watchman-red.stdout.txt");
const JEST = fixture("baseline-jest/watchman-red.stderr.txt");
const VITEST = fixture("baseline-incident/fresh-output.txt");
const [HEADER, HINT, WATCHMAN_ERROR] = WATCHMAN.trimEnd().split("\n");
const COMMANDS = { test: "bash run.sh" };
const GREEN: Baseline = { commands: { test: { exitCode: 0, fingerprints: [] } } };
const FAIL_A = "FAIL __tests__/app/library/index.test.tsx";
const FAIL_B = "FAIL __tests__/features/catalog/catalogEntries.test.tsx";
const ID_A = "  ● Test suite failed to run";
const ID_B = "  ● Catalog entry affordances › home keeps settings; the tab entry reaches the catalog route";
const MESSAGE = "    Missing apiUrl. Set APP_API_URL in .env and ensure app.config.ts `extra` reads it.";
const FAILS = [FAIL_A, FAIL_B, FAIL_A, FAIL_B];

function stage(repo: string, stdout: string, stderr = JEST, code = 1): void {
  writeFileSync(join(repo, "stdout.txt"), stdout);
  writeFileSync(join(repo, "stderr.txt"), stderr);
  writeFileSync(join(repo, "exit-code.txt"), String(code));
}

function replayRepo(): string {
  return makeRepo({ "run.sh": 'cat stdout.txt; cat stderr.txt >&2; exit "$(cat exit-code.txt)"\n' });
}

async function capture(repo: string, stdout: string, stderr = JEST, code = 1): Promise<Baseline> {
  stage(repo, stdout, stderr, code);
  return captureBaseline(repo, COMMANDS);
}

async function gate(repo: string, baseline: Baseline, stdout: string, stderr = JEST) {
  stage(repo, stdout, stderr);
  return (await compareToBaseline(repo, COMMANDS, baseline, ["test"]))[0]!;
}

async function tip(repo: string, baseline: Baseline) {
  const runDir = join(repo, "tip-run");
  mkdirSync(runDir, { recursive: true });
  return (await verifyIntegrationTip(repo, COMMANDS, runDir, baseline))[0]!;
}

test("the test gate over a green baseline, reading the recorded jest output whose Watchman retry block precedes two failing suites, reds with details that name each jest failure identity beside its first message line and carry no Watchman text, so details that headline the recovered warning or omit the assertion message fail", async () => {
  const repo = replayRepo();
  const green = await capture(repo, "", "all tests passed\n", 0);
  const result = await gate(repo, green, WATCHMAN);
  expect(result).toMatchObject({ pass: false, meta: { classification: "regression", failingTests: FAILS } });
  expect(result.details.split("\n\n")[0]).toBe([
    "failing tests:", FAIL_A, ID_A, MESSAGE, FAIL_B, ID_B, MESSAGE,
    FAIL_A, ID_A, MESSAGE, FAIL_B, ID_B, MESSAGE,
  ].join("\n"));
  expect(result.details).not.toMatch(/watchman|crawl failed|Usually this happens/i);
  expect(result.details).toContain("new failure fingerprints vs baseline (secondary):");
});

test("over a red baseline captured from the same failures without the Watchman block, the recorded output with the block is forgiven as only pre-existing failures, and a baseline captured with the block forgives the same failures printed without it, so a gate that reds on the recovered warning alone fails", async () => {
  const repo = replayRepo();
  const without = await capture(repo, "");
  const withBlock = await capture(repo, WATCHMAN);
  expect(withBlock.commands.test!.fingerprints).toEqual(without.commands.test!.fingerprints);
  for (const [baseline, stdout] of [[without, WATCHMAN], [withBlock, ""]] as const) {
    const result = await gate(repo, baseline, stdout);
    expect(result.pass).toBe(true);
    expect(result.details).toBe("exit 1 but only pre-existing failures (forgiven)");
    expect(await tip(repo, baseline)).toMatchObject({ pass: true, forgiven: true });
  }
  const onlyA = `${FAIL_A}\n${ID_A}\n\n${MESSAGE}\n`;
  expect((await gate(repo, without, WATCHMAN, onlyA)).pass).toBe(true);
  expect((await gate(repo, withBlock, "", onlyA)).pass).toBe(true);
});

test("jest's thrown crawler-retry failure after the Watchman block reds over green and over a red baseline captured without it, while near-matching blocks stay evidence, the header and hint followed by a fresh type error over that red baseline redding and the header indented in a console echo staying fingerprinted, so a signature matching by indentation alone fails", async () => {
  const repo = replayRepo();
  const red = await capture(repo, "");
  const crawlerFailure = `Error: Crawler retry failed:\n  Original error: ${WATCHMAN_ERROR!.trim().slice("Error: ".length)}\n  Retry error: EACCES: permission denied, scandir '/project'\n`;
  for (const baseline of [GREEN, red]) {
    const result = await gate(repo, baseline, WATCHMAN, `${JEST}\n${crawlerFailure}`);
    expect(result).toMatchObject({ pass: false, meta: { classification: "regression" } });
    expect(result.details).toContain("Error: Crawler retry failed:");
    expect(await tip(repo, baseline)).toMatchObject({ pass: false, cause: "regression" });
  }
  const nearMatches = [
    `${HEADER}\n${HINT}\nTypeError: fresh crawl defect\n`,
    `${HEADER}\nTypeError: fresh crawl defect\n`,
    `${HINT}\nTypeError: fresh crawl defect\n`,
    `${HINT}\n${WATCHMAN_ERROR}\n`,
    `${HEADER}\n${WATCHMAN_ERROR}\n`,
    WATCHMAN.replace("Usually this happens", "Sometimes this happens"),
    WATCHMAN.replace("for this project.", "for a different project."),
    WATCHMAN.replace(`${HEADER}\n`, `${HEADER}\n\n`),
    WATCHMAN.replace("synchronization failed:", "synchronization failed:\n    more error context:"),
    `  ● Console\n\n    console.warn\n${WATCHMAN.trimEnd().split("\n").map(line => `      ${line}`).join("\n")}\n`,
  ];
  for (const output of nearMatches) {
    const result = await gate(repo, red, output);
    expect(result, output).toMatchObject({ pass: false, meta: { classification: "regression" } });
    expect(freshFailures(red.commands.test, `${output}\n${JEST}`).failing.length, output).toBeGreaterThan(0);
  }
  const indented = nearMatches.at(-1)!;
  expect(fingerprint(indented)).toContain(WATCHMAN_ERROR!.replace(/\d+/g, "#").trim());
  expect((await capture(repo, indented)).commands.test!.fingerprints.some(line => line.includes("Watchman error:"))).toBe(true);
});

test("jest Console identities and column-zero validation bullets are never headlined, the failing-tests metadata still lists only the runner's FAIL lines, and the recorded vitest incident's details and metadata stay byte-identical to the base rendering, so a headline that leaks console blocks or moves vitest bytes fails", async () => {
  const repo = replayRepo();
  const extra = [
    "● Validation Error:", "", "  Invalid configuration", "",
    "stdout | tests/gates/baseline-jest.test.ts > echoed output",
    "  ● echoed identity", "", // The first blank ends Vitest's echo block.
    "stderr | tests/gates/baseline-jest.test.ts > echoed output",
    "  ● another echoed identity", "    echoed message", "",
  ].join("\n");
  const result = await gate(repo, GREEN, WATCHMAN, `${extra}\n${JEST}`);
  const headline = result.details.split("new failure fingerprints vs baseline (secondary):")[0]!;
  expect(headline).not.toMatch(/● Console|console\.error|act\(|Validation Error|echoed identity|echoed message/);
  expect(result.meta).toEqual({ failingTests: FAILS, classification: "regression" });
  const otherIdentity = "  ● Console helpers › preserves arbitrary titles";
  const messages = `\n${otherIdentity}\n\n\n    first message\n    later context\n`;
  const withMessages = await gate(repo, GREEN, WATCHMAN, `${JEST}${messages}`);
  expect(withMessages.details).toContain(`${otherIdentity}\n    first message`);
  expect(withMessages.details).not.toContain("later context");
  expect(withMessages.meta).toEqual(result.meta);
  expect(fingerprint(`${WATCHMAN}\n${JEST}${messages}`)).toEqual(fingerprint(`${WATCHMAN}\n${JEST}`));

  const incident = await gate(repo, GREEN, VITEST, "");
  expect(incident.pass).toBe(false);
  expect(incident.details).toBe([
    "failing tests:",
    " FAIL  tests/config/config.test.ts > config > MODEL-10 > loadConfig resolves grok tiers",
    " Test Files  1 failed (1)",
    "      Tests  1 failed | 815 passed (816)",
    "", "new failure fingerprints vs baseline (secondary):",
    "× config > MODEL-# > loadConfig resolves grok tiers #ms",
    "FAIL tests/config/config.test.ts > config > MODEL-# > loadConfig resolves grok tiers",
    "AssertionError: expected # to be #",
    "Test Files # failed (#)",
    "Tests # failed | # passed (#)",
  ].join("\n"));
  expect(incident.meta).toEqual({
    failingTests: [" FAIL  tests/config/config.test.ts > config > MODEL-10 > loadConfig resolves grok tiers"],
    classification: "regression",
  });

  // Queue row 224(a) (D-2118): raw Vitest FAIL/summary headlines and metadata retain the base rendering.
  const echoedFail = " FAIL  tests/fake.test.ts > fake";
  const echoedSummary = "      Tests  2 failed | 8 passed (10)";
  const echo = [
    "stdout | tests/a.test.ts > prints runner output",
    `\u001b[31m${echoedFail}\u001b[39m`, echoedSummary,
    "  ● echoed identity", "    echoed message", "",
  ].join("\n");
  const echoedIncident = await gate(repo, GREEN, `${echo}\n${VITEST}`, "");
  expect(echoedIncident.details).toBe(incident.details.replace(
    "failing tests:\n", `failing tests:\n${echoedFail}\n${echoedSummary}\n`,
  ));
  expect(echoedIncident.meta).toEqual({
    failingTests: [echoedFail, " FAIL  tests/config/config.test.ts > config > MODEL-10 > loadConfig resolves grok tiers"],
    classification: "regression",
  });
  const assertionOnly = await gate(repo, GREEN, `${echo}\nAssertionError: expected 1 to be 2\n`, "");
  expect(assertionOnly.details).toBe([
    "failing tests:", echoedFail, echoedSummary, "",
    "new failure fingerprints vs baseline (secondary):", "AssertionError: expected # to be #",
  ].join("\n"));
  expect(assertionOnly.meta).toEqual({ failingTests: [echoedFail], classification: "regression" });
});

test("queue rows 211 and 224(a) (D-2118): unrecognized and infrastructure details retain raw Vitest echoes while omitting the recovered Watchman warning", async () => {
  const repo = replayRepo();
  const unrecognized = await gate(repo, GREEN, [
    WATCHMAN.trimEnd(), "stderr | tests/a.test.ts > t", "some error happened here", "",
  ].join("\n"), "");
  expect(unrecognized.details).toBe([
    "command was green at baseline but now exits 1 with no recognizable failure lines — failing closed",
    "unrecognized output:", "some error happened here",
  ].join("\n"));
  expect(unrecognized.meta).toBeUndefined();

  stage(repo, [
    WATCHMAN.trimEnd(), "stdout | tests/a.test.ts > t", "diagnostic breadcrumb", "", "EAGAIN", "",
  ].join("\n"), "");
  const [infra] = await compareToBaseline(repo, { build: COMMANDS.test }, {
    commands: { build: { exitCode: 1, fingerprints: ["EAGAIN"] } },
  }, ["build"]);
  expect(infra!.details).toBe([
    "infra; exit 1; the fresh failures carry infrastructure evidence alone — the runner never completed a suite, so this gate verified nothing:",
    "stdout | tests/a.test.ts > t", "diagnostic breadcrumb", "", "EAGAIN",
  ].join("\n"));
  expect(infra!.meta).toEqual({ classification: "infra", infra: true });
});

test("a baseline capture of the recorded jest output records no fingerprint for the Watchman block while still recording each FAIL line, and the block printed alone over a green baseline fails closed with no regression classification, so a capture or classifier still reading the warning as a failure fails", async () => {
  const repo = replayRepo();
  const baseline = await capture(repo, WATCHMAN);
  expect(baseline.commands.test).toMatchObject({ exitCode: 1, fingerprintVersion: 2 });
  expect(baseline.commands.test!.fingerprints).toEqual([...FAILS].sort());
  expect(fingerprint(WATCHMAN)).toEqual([]);
  expect(classifyFailureOutput(WATCHMAN)).toBeUndefined();
  expect(classifyRunnerOutput(WATCHMAN, 1)).toBeUndefined();
  expect(freshFailures(GREEN.commands.test, WATCHMAN).failing).toEqual([]);
  const result = await gate(repo, GREEN, WATCHMAN, "");
  expect(result).toMatchObject({ pass: false });
  expect(result.details).toBe("command was green at baseline but now exits 1 with no recognizable failure lines — failing closed");
  expect(result.meta).toBeUndefined();
  expect(await tip(repo, GREEN)).toMatchObject({ pass: false, fingerprints: [] });
});
