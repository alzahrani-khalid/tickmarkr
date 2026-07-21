import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline, compareToBaseline, detectGateCommands, fingerprint } from "../../src/gates/baseline.js";
import { NO_EXPLORE_ENV, QUALITY_ENV } from "../../src/route/router.js";
import { makeRepo } from "../helpers/tmprepo.js";

describe("fingerprint", () => {
  test("keeps failure lines, normalizes digits/whitespace, dedupes", () => {
    const fp = fingerprint("ok line\nFAIL src/a.test.ts:12 took 1.3s\nFAIL src/a.test.ts:99   took 2.7s\nError: boom\n");
    expect(fp).toEqual(["FAIL src/a.test.ts:# took #.#s", "Error: boom"]);
  });

  // incident #2 (run-20260709-104447): a vitest PASS line with "error" in the test NAME was fingerprinted as a failure
  test("labeled ANSI-wrapped ✓ pass line with 'error' in the name is dropped", () => {
    expect(fingerprint("intake:test: \x1b[32m✓\x1b[0m maps DUPLICATE_USERNAME to a field-level error on username")).toEqual([]);
  });

  test("ANSI-wrapped FAIL line is stripped and normalized", () => {
    expect(fingerprint("\x1b[31mFAIL\x1b[0m src/a.test.ts:12")).toEqual(["FAIL src/a.test.ts:#"]);
  });

  test("OBS-42: vitest FAIL anchors ignore tickmarkr run-summary noise", () => {
    expect(fingerprint([
      "[tickmarkr] tickmarkr run-tip: 1 done, 1 failed, 0 awaiting human, 0 blocked, 0 pending",
      " FAIL  tests/run/tip.test.ts > tip verify > writes diagnostics 42",
    ].join("\n"))).toEqual(["FAIL tests/run/tip.test.ts > tip verify > writes diagnostics #"]);
  });

  // old-format stored baselines (pre-hardening) carry digit-normalized ANSI ("\x1b[#m") — compare must renormalize
  test("compareToBaseline forgives a line whose stored fingerprint has pre-hardening ANSI", async () => {
    const repo = makeRepo({ "run.sh": "printf '\\033[31mFAIL\\033[0m src/a.test.ts:12\\n'; exit 1\n" });
    const base = { commands: { test: { exitCode: 1, fingerprints: ["\x1b[#mFAIL\x1b[#m src/a.test.ts:#"] } } };
    const results = await compareToBaseline(repo, { test: "bash run.sh" }, base, ["test"]);
    expect(results[0]).toMatchObject({ gate: "test", pass: true });
    expect(results[0].details).toMatch(/pre-existing/i);
  });
});

describe("detectGateCommands", () => {
  test("cfg override wins; else package.json scripts; missing omitted", () => {
    const repo = makeRepo({ "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }) });
    expect(detectGateCommands(repo, DEFAULT_CONFIG)).toEqual({ build: "npm run -s build", test: "npm run -s test" });
    const cfg = { ...DEFAULT_CONFIG, gates: { test: "make check" } };
    expect(detectGateCommands(repo, cfg).test).toBe("make check");
  });

  test("no package.json → empty commands (gates skip, not crash)", () => {
    const repo = makeRepo({ "a.txt": "x" });
    expect(detectGateCommands(repo, DEFAULT_CONFIG)).toEqual({});
  });

  test("tickmarkr repo package.json scripts shape auto-detects lint", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    expect(detectGateCommands(repoRoot, DEFAULT_CONFIG)).toMatchObject({
      build: "npm run -s build",
      test: "npm run -s test",
      lint: "npm run -s lint",
    });
  });
});

describe("baseline forgiveness", () => {
  test("pre-existing failure forgiven; new failure fatal; green stays green", async () => {
    // test command = a script whose output we control via a file
    const repo = makeRepo({ "out.txt": "FAIL old thing\n", "run.sh": "cat out.txt; exit 1\n" });
    const commands = { test: "bash run.sh" };
    const base = await captureBaseline(repo, commands);
    expect(base.commands.test.exitCode).toBe(1);
    expect(base.commands.test.fingerprints).toEqual(["FAIL old thing"]);

    // same old failure → forgiven
    let results = await compareToBaseline(repo, commands, base, ["test"]);
    expect(results[0]).toMatchObject({ gate: "test", pass: true });
    expect(results[0].details).toMatch(/pre-existing/i);

    // a NEW failure appears → fatal
    writeFileSync(join(repo, "out.txt"), "FAIL old thing\nFAIL brand new thing\n");
    results = await compareToBaseline(repo, commands, base, ["test"]);
    expect(results[0].pass).toBe(false);
    expect(results[0].details).toContain("FAIL brand new thing");

    // everything green → pass
    writeFileSync(join(repo, "run.sh"), "echo all good; exit 0\n");
    results = await compareToBaseline(repo, commands, base, ["test"]);
    expect(results[0].pass).toBe(true);
  });

  test("enabled gate with no detected command → explicit skip result, not silence", async () => {
    const repo = makeRepo({ "run.sh": "exit 0\n" });
    const commands = { test: "bash run.sh" }; // no lint command detected
    const base = await captureBaseline(repo, commands);
    const results = await compareToBaseline(repo, commands, base, ["test", "lint"]);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ gate: "lint", pass: true, meta: { skipped: true } });
    expect(results[1].details).toMatch(/no lint command detected/);
  });

  test("enabled filter: only requested gates run", async () => {
    const repo = makeRepo({ "run.sh": "exit 0\n" });
    const commands = { test: "bash run.sh", build: "bash run.sh" };
    const base = await captureBaseline(repo, commands);
    const results = await compareToBaseline(repo, commands, base, ["build"]);
    expect(results.map((r) => r.gate)).toEqual(["build"]);
  });

  test("a baseline where at least one configured command runs produces no wrong-environment warning", async () => {
    const repo = makeRepo({ "run.sh": "echo 'ran and failed'; exit 1\n" });
    const baseline = await captureBaseline(repo, {
      build: "definitely-missing-tickmarkr-build",
      test: "bash run.sh",
    });

    expect(baseline.commands.build.missingCommand).toBe(true);
    expect(baseline.commands.test.missingCommand).toBe(false);
    expect(baseline.warnings ?? []).toEqual([]);
  });

  test("the wrong-environment warning distinguishes missing commands from commands that ran and failed", async () => {
    const repo = makeRepo({ "run.sh": "echo 'intentional command failure'; exit 127\n" });
    const baseline = await captureBaseline(repo, {
      build: "definitely-missing-tickmarkr-build",
      test: "bash run.sh",
    });

    expect(baseline.commands.build).toMatchObject({ exitCode: 127, missingCommand: true });
    expect(baseline.commands.test).toMatchObject({ exitCode: 127, missingCommand: false });
    expect(baseline.warnings ?? []).toEqual([]);
  });

  test("identical failure line differing only by absolute cwd prefix is forgiven (worktree regression)", async () => {
    // v1.4 live regression: baseline captured at repo root, gate compared inside a task worktree —
    // a warning path like <cwd>/src/app-error-boundary.tsx fingerprinted differently per cwd
    const repoA = makeRepo({ "run.sh": "cat out.txt; exit 1\n" });
    writeFileSync(join(repoA, "out.txt"), `error at ${repoA}/src/app-error-boundary.tsx\n`);
    const commands = { test: "bash run.sh" };
    const base = await captureBaseline(repoA, commands);
    expect(base.commands.test.exitCode).toBe(1);

    // simulate the task worktree: same repo-relative line, different absolute prefix
    const repoB = makeRepo({ "run.sh": "cat out.txt; exit 1\n" });
    writeFileSync(join(repoB, "out.txt"), `error at ${repoB}/src/app-error-boundary.tsx\n`);
    let results = await compareToBaseline(repoB, commands, base, ["test"]);
    expect(results[0]).toMatchObject({ gate: "test", pass: true });
    expect(results[0].details).toMatch(/pre-existing/i);

    // fail-closed preserved: a genuinely new failure line still fails the gate
    writeFileSync(join(repoB, "out.txt"), `error at ${repoB}/src/app-error-boundary.tsx\nFAIL brand new thing\n`);
    results = await compareToBaseline(repoB, commands, base, ["test"]);
    expect(results[0].pass).toBe(false);
    expect(results[0].details).toContain("FAIL brand new thing");
  });

  test("previously-green command turning red without recognizable failure lines fails closed", async () => {
    const repo = makeRepo({ "run.sh": "echo all good; exit 0\n" });
    const commands = { test: "bash run.sh" };
    const base = await captureBaseline(repo, commands);
    expect(base.commands.test.exitCode).toBe(0);
    writeFileSync(join(repo, "run.sh"), "echo '3 problems'; exit 1\n");
    const results = await compareToBaseline(repo, commands, base, ["test"]);
    expect(results[0].pass).toBe(false);
    expect(results[0].details).toMatch(/green at baseline/i);
  });

  test("OBS-42: baseline forgiveness decisions stay the same around run summaries", async () => {
    const repo = makeRepo({
      "out.txt": "tickmarkr run-tip: 1 done, 1 failed, 0 awaiting human\n FAIL  tests/a.test.ts > old failure\n",
      "run.sh": "cat out.txt; exit 1\n",
    });
    const commands = { test: "bash run.sh" };
    const baseline = await captureBaseline(repo, commands);

    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0].pass).toBe(true);

    writeFileSync(join(repo, "out.txt"), "tickmarkr run-tip: 1 done, 2 failed, 0 awaiting human\n FAIL  tests/a.test.ts > old failure\n FAIL  tests/a.test.ts > new failure\n");
    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0].pass).toBe(false);
  });

  test("OBS-42: legacy baselines forgive newly harvested Vitest diagnostic headings", async () => {
    const repo = makeRepo({
      "out.txt": " FAIL  tests/a.test.ts > old failure\n⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nUncaught Exception\n",
      "run.sh": "cat out.txt; exit 1\n",
    });
    const legacyBaseline = { commands: { test: { exitCode: 1, fingerprints: ["FAIL tests/a.test.ts > old failure"] } } };

    expect((await compareToBaseline(repo, { test: "bash run.sh" }, legacyBaseline, ["test"]))[0].pass).toBe(true);
  });
});

// OBS-74 (run-20260718-050244): the daemon's --quality env leaked into its own gate children, so a
// dogfood repo's route() tests went red INSIDE the gates while green in the worker's clean shell.
// The fix is at the spawn seam (src/run/git.ts shell() scrubs ROUTING_ENV_SEAMS) — these tests prove
// it through the real baseline gate path, with NO help from any repo test setup: the child is a bare
// bash script that fails loudly when a seam var is visible, in a target repo with no setup files.
describe("OBS-74: gate children are hermetic to the daemon's routing env", () => {
  // ${VAR+x}: set-but-empty still counts as leaked — the child must not see the var at all
  const leakProbe = (name: string) =>
    makeRepo({ "run.sh": `test -z "\${${name}+x}" || { echo "FAIL ${name} leaked into gate child"; exit 1; }\n` });

  const gateStaysGreen = async (name: string) => {
    const repo = leakProbe(name);
    const commands = { test: "bash run.sh" };
    process.env[name] = "1";
    try {
      const base = await captureBaseline(repo, commands); // baseline child: hermetic
      expect(base.commands.test.exitCode).toBe(0);
      const results = await compareToBaseline(repo, commands, base, ["test"]); // gate child: hermetic
      expect(results[0]).toMatchObject({ gate: "test", pass: true, details: "exit 0" });
    } finally {
      delete process.env[name];
    }
  };

  test("a gate child never sees the quality env var when the daemon carries it", async () => {
    await gateStaysGreen(QUALITY_ENV);
  });

  test("a gate child never sees the no-explore env var when the daemon carries it", async () => {
    await gateStaysGreen(NO_EXPLORE_ENV);
  });
});

// HYG-08 (D-01, incident run-20260711-154920): a genuinely-failing test (config > MODEL-10, broken by an
// operator config edit) went unnamed for 3 attempts (~75 min + tokens) because the baseline gate's details
// headlined benign fingerprint-diff noise — tickmarkr's own "N done, 0 failed" CLI summary line and a test NAME
// containing "fail-closed" both fingerprint as failures. That details string feeds every retry's worker
// feedback (daemon.ts:445) AND the frontier consult dossier (consult.ts:32), so the misdiagnosis propagated to
// the most expensive intelligence in the fleet. Fixture vendored below reproduces that incident's SHAPE;
// empirical vitest 3.2.7 output shapes captured in .planning/phases/44-fleet-hygiene/44-RESEARCH.md (HYG-08).
const INCIDENT_FIXTURE = join(import.meta.dirname, "..", "fixtures", "baseline-incident", "fresh-output.txt");
const INCIDENT_FAIL_LINE = " FAIL  tests/config/config.test.ts > config > MODEL-10 > loadConfig resolves grok tiers";

describe("HYG-08: failing details name the failing test, not stdout noise", () => {
  test("details headlines the failing test, not the noise", async () => {
    // green baseline → any failure line is fresh; the gate must NAME it, not echo the fingerprint diff
    const repo = makeRepo({ "run.sh": `cat ${INCIDENT_FIXTURE}; exit 1\n` });
    const greenBaseline = { commands: { test: { exitCode: 0, fingerprints: [] } } };
    const results = await compareToBaseline(repo, { test: "bash run.sh" }, greenBaseline, ["test"]);
    expect(results[0].pass).toBe(false);
    const details = results[0].details;
    expect(details.startsWith("failing tests:")).toBe(true);
    // headline section = text before the labeled secondary fingerprint diff
    const headline = details.split("new failure fingerprints vs baseline (secondary):")[0];
    // headline carries the runner's own FAIL line + Tests summary, digits UN-normalized (MODEL-10, 815, 816)
    expect(headline).toContain(INCIDENT_FAIL_LINE);
    expect(headline).toContain("Tests  1 failed | 815 passed (816)");
    // headline does NOT carry the benign noise that fingerprinted as failures today
    expect(headline).not.toContain("done, 0 failed");
    expect(headline).not.toContain("fail-closed");
    // the fingerprint diff is demoted, still present as a labeled secondary section
    expect(details).toContain("new failure fingerprints vs baseline (secondary):");
  });

  test("meta.failingTests carries the raw FAIL lines", async () => {
    const repo = makeRepo({ "run.sh": `cat ${INCIDENT_FIXTURE}; exit 1\n` });
    const greenBaseline = { commands: { test: { exitCode: 0, fingerprints: [] } } };
    const results = await compareToBaseline(repo, { test: "bash run.sh" }, greenBaseline, ["test"]);
    expect(results[0].meta?.failingTests).toEqual([INCIDENT_FAIL_LINE]);
  });

  // non-regression pins — GREEN on unfixed HEAD too (verdict flow byte-untouched by HYG-08)

  test("fail-closed branch untouched: green→red with no recognizable failure lines still fails closed", async () => {
    const repo = makeRepo({ "run.sh": "echo '3 problems'; exit 1\n" });
    const greenBaseline = { commands: { test: { exitCode: 0, fingerprints: [] } } };
    const results = await compareToBaseline(repo, { test: "bash run.sh" }, greenBaseline, ["test"]);
    expect(results[0].pass).toBe(false);
    expect(results[0].details).toMatch(/failing closed/);
    expect(results[0].meta).toBeUndefined();
  });

  test("no-headline fallback: tsc-shaped output stays byte-identical to today's fingerprint diff", async () => {
    const repo = makeRepo({ "run.sh": "echo 'src/x.ts(12,5): error TS2554: Expected 2 arguments'; exit 1\n" });
    const greenBaseline = { commands: { test: { exitCode: 0, fingerprints: [] } } };
    const results = await compareToBaseline(repo, { test: "bash run.sh" }, greenBaseline, ["test"]);
    expect(results[0].pass).toBe(false);
    expect(results[0].details.startsWith("failing tests:")).toBe(false);
    expect(results[0].details.startsWith("new failures vs baseline:")).toBe(true);
    expect(results[0].meta).toBeUndefined();
  });

  test("fingerprint still catches FAIL lines (no regex narrowing)", () => {
    expect(fingerprint(readFileSync(INCIDENT_FIXTURE, "utf8"))).toContain(
      "FAIL tests/config/config.test.ts > config > MODEL-# > loadConfig resolves grok tiers",
    );
  });
});
