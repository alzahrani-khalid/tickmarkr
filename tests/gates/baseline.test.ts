import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline, classifyFailureOutput, compareToBaseline, detectGateCommands, detectPackageManager, detectVacuousOracles, effectiveCeilingMs, fingerprint, UNRECOGNIZED_FAILURE } from "../../src/gates/baseline.js";
import { NO_EXPLORE_ENV, QUALITY_ENV } from "../../src/route/router.js";
import { DEFAULT_SHELL_TIMEOUT_MS, sh, type ShResult } from "../../src/run/git.js";
import { makeRepo } from "../helpers/tmprepo.js";

// The ceiling a battery runs under is an ARGUMENT to the shell, and an argument is only observable at
// the seam that receives it. This spy passes every call through to the real shell — so every other test
// in this file keeps running real commands, byte-identically — while recording the timeout each caller
// asked for, and lets one test hand back the ShResult a SIGKILLed child produces (a 600s wait is not a
// test). vi.hoisted: the mock factory is hoisted above the imports, so its state must be too.
const shSpy = vi.hoisted(() => ({
  calls: [] as { cmd: string; timeoutMs: number | undefined }[],
  stub: undefined as undefined | ((cmd: string) => ShResult | undefined),
}));

vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: (cmd: string, cwd: string, timeoutMs?: number) => {
      shSpy.calls.push({ cmd, timeoutMs });
      const stubbed = shSpy.stub?.(cmd);
      return stubbed ? Promise.resolve(stubbed) : actual.sh(cmd, cwd, timeoutMs);
    },
  };
});

const OXLINT = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "oxlint");
// Oxlint 1.74 changed its implicit reporter to a graphical diagnostic. Its `agent` reporter is the
// path-first default form this regression was captured against; invoke that real reporter explicitly
// so the test remains a binary-output drill instead of a transcription coupled to a version default.
const oxlintDefault = (files: string) => `${JSON.stringify(OXLINT)} ${files} --deny no-console --format agent`;

test("test: a lint runner's real default output fingerprints one entry per diagnostic and classifies as a regression where each line opens with a file path followed by a position followed by the word error; the single constant marker standing for every unreadable failure today fails", async () => {
  const repo = makeRepo({
    "first.js": "console.log('first');\n",
    "second.js": "console.log('second');\n",
  });
  const result = await sh(oxlintDefault("first.js second.js"), repo);
  const raw = `${result.stdout}\n${result.stderr}`;

  expect(result.code).toBe(1);
  expect(raw).toMatch(/^first\.js:\d+:\d+: error\b/m);
  expect(raw).toMatch(/^second\.js:\d+:\d+: error\b/m);
  expect(fingerprint(raw).toSorted()).toEqual([
    "first.js:#:#: error eslint(no-console): Unexpected console statement. help: Delete this console statement.",
    "second.js:#:#: error eslint(no-console): Unexpected console statement. help: Delete this console statement.",
  ]);
  expect(fingerprint(raw)).not.toContain(UNRECOGNIZED_FAILURE);
  expect(classifyFailureOutput(raw)).toBe("regression");
});

test("test: a line that merely mentions a file position inside a sentence contributes no fingerprint; a recognizer anchored loosely enough to match it manufactures a fresh failure out of ordinary runner prose and fails", () => {
  const failure = "FAIL tests/existing.test.ts > existing failure";
  const prose = "the runner merely mentions src/example.ts:12:7: error while explaining its output grammar";

  expect(fingerprint(`${failure}\n${prose}`)).toEqual(fingerprint(failure));
  expect(classifyFailureOutput(prose)).toBeUndefined();
});

test("test: two lint runs differing by exactly one new diagnostic produce different fingerprint sets so a baseline holding one pre-existing lint error stops forgiving the new one; a recognizer leaving both runs at one constant forgives it and fails", async () => {
  const repo = makeRepo({ "existing.js": "console.log('existing');\n" });
  const commands = { lint: oxlintDefault("*.js") };
  const baseline = await captureBaseline(repo, commands);

  expect(baseline.commands.lint.fingerprints).toHaveLength(1);
  expect((await compareToBaseline(repo, commands, baseline, ["lint"]))[0]).toMatchObject({ pass: true });

  writeFileSync(join(repo, "new.js"), "console.log('new');\n");
  const current = await sh(commands.lint, repo);
  const currentFingerprints = fingerprint(`${current.stdout}\n${current.stderr}`);
  expect(currentFingerprints).toHaveLength(2);
  expect(currentFingerprints).not.toEqual(baseline.commands.lint.fingerprints);

  const [gate] = await compareToBaseline(repo, commands, baseline, ["lint"]);
  expect(gate).toMatchObject({ pass: false, meta: { classification: "regression" } });
  expect(gate.details).toContain("new.js:#:#: error");
});

test("this repository's own lint script selects the output format the shipped recognizer already reads and the recognizer carries a comment naming that script change as the local remedy and itself as the shipped fix, so a diff changing only the script fails", () => {
  const root = join(import.meta.dirname, "..", "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: { lint: string } };
  const source = readFileSync(join(root, "src", "gates", "baseline.ts"), "utf8");

  expect(pkg.scripts.lint).toMatch(/\boxlint\b.*--format\s+stylish\b/);
  expect(source).toMatch(/local remedy/);
  expect(source).toMatch(/shipped fix/);
  expect(source).toMatch(/PATH_FIRST_LINTER_ERROR_RE/);
});

test("test: a baseline capture over a runner that names per-file durations records the command's own wall clock the sum of those durations their ratio and the single longest file; a record carrying the wall clock alone fails", async () => {
  shSpy.stub = (cmd) => cmd === "timed-runner"
    ? {
        code: 0,
        stdout: [
          " ✓ tests/quick.test.ts (2 tests) 120ms",
          " ✓ |sync-heavy| tests/slow.test.ts (1 test) 1.5s",
        ].join("\n"),
        stderr: "",
        durationMs: 1_000,
      }
    : undefined;
  try {
    const entry = (await captureBaseline("/tmp/tickmarkr-timing", { test: "timed-runner" })).commands.test;
    expect(entry.durationMs).toBe(1_000);
    expect(entry.fileDurationSumMs).toBe(1_620);
    expect(entry.impliedParallelism).toBeCloseTo(1.62);
    expect(entry.longestFile).toEqual({ file: "tests/slow.test.ts", durationMs: 1_500 });
  } finally {
    shSpy.stub = undefined;
  }
});

test("test: a baseline capture over a runner naming no per-file durations records the wall clock and marks the other three unavailable; a record normalizing an unmeasurable sum to zero reads as perfect parallelism and fails", async () => {
  shSpy.stub = (cmd) => cmd === "untimed-runner"
    ? { code: 0, stdout: "3 checks passed\n", stderr: "", durationMs: 250 }
    : undefined;
  try {
    const entry = (await captureBaseline("/tmp/tickmarkr-timing", { test: "untimed-runner" })).commands.test;
    expect(entry.durationMs).toBe(250);
    expect(entry).toMatchObject({
      fileDurationSumMs: null,
      impliedParallelism: null,
      longestFile: null,
    });
    expect(entry.fileDurationSumMs).not.toBe(0);
  } finally {
    shSpy.stub = undefined;
  }
});

describe("fingerprint", () => {
  test("keeps failure lines, normalizes digits/whitespace, dedupes", () => {
    const fp = fingerprint("ok line\nFAIL src/a.test.ts:12 took 1.3s\nFAIL src/a.test.ts:99   took 2.7s\nError: boom\n");
    expect(fp).toEqual(["FAIL src/a.test.ts:# took #.#s", "Error: boom"]);
  });

  // Q137s (verbatim from dossier run-2's consult dossier): turbo/pnpm monorepo failure grammar
  // was shapeless — reds carried only the <unrecognized failure output> sentinel, so forgiveness
  // degraded to exit-code equality and repair workers got "no recognizable failure lines".
  test("turbo/pnpm failure lines fingerprint instead of collapsing to the unrecognized sentinel", () => {
    const out = [
      "   • Packages in scope: agent-runtime, intake-backend, intake-frontend",
      "intake-frontend:lint:  ELIFECYCLE  Command failed with exit code 1.",
      "Failed:    intake-frontend#lint",
      " ERROR  intake-frontend#lint: command (/frontend) /Users/x/bin/pnpm run lint exited (1)",
      " ERROR  run failed: command  exited (1)",
    ].join("\n");
    const fp = fingerprint(out);
    expect(fp).not.toContain(UNRECOGNIZED_FAILURE);
    expect(fp).toContain("intake-frontend:lint: ELIFECYCLE Command failed with exit code #.");
    expect(fp).toContain("Failed: intake-frontend#lint");
  });

  test("prose or chrome containing 'Failed' or 'ERROR' without the driver grammar stays shapeless", () => {
    expect(fingerprint("the deployment Failed: badly\nERROR happened somewhere")).toEqual([UNRECOGNIZED_FAILURE]);
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

  test("test: a rendered status line containing the words error or failed does not enter the fingerprint set unless it is failure-shaped", () => {
    // the cockpit's own run strip, the same strip stripped of every glyph, and plain narration: no
    // failure shape, so no line of any of them enters the set — glyphs are not what makes a line safe
    const strip = "│ ✗ tip-verify FAILED · zone +3 · run attempt 2 · 1 failed · last error attempt 1 │";
    for (const rendered of [strip, "gate-result — T1 — evidence failed", "tip verify: 2 failed, 1 error"]) {
      // the marker records THAT the command failed; it carries no text off the line
      expect(fingerprint(rendered)).toEqual([UNRECOGNIZED_FAILURE]);
      expect(fingerprint(rendered).join("\n")).not.toMatch(/zone|attempt|gate-result|tip.verify/i);
    }
    // …and beside a real failure the shape is the whole set — the drawn line still contributes nothing
    expect(fingerprint([strip, " FAIL  tests/a.test.ts > boom 7", " Tests  1 failed | 9 passed (10)"].join("\n")))
      .toEqual(["FAIL tests/a.test.ts > boom #", "Tests # failed | # passed (#)"]);
  });

  test("the unrecognized-output marker is constant, so narration can never differ between attempts", () => {
    const attempt = (zone: number, attemptNo: number) =>
      fingerprint(`renderer error budget exceeded\nzone +${zone} · run attempt ${attemptNo} · 1 failed`);
    expect(attempt(3, 2)).toEqual(attempt(9, 7));
    expect(fingerprint("")).toEqual([]); // no output at all is not a failure to record
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

// Operator directive 2026-08-12 (D-OBS-10): package-manager agnostic. The dossier
// exhibit: `npm run -s test` synthesized for a pnpm workspace whose engines said
// "please-use-pnpm" — turbo could not resolve pnpm and every gate died on environment.
describe("detectPackageManager + PM-correct gate commands", () => {
  const scripts = JSON.stringify({ scripts: { test: "turbo run test" } });

  test("packageManager field is authoritative over lockfiles", () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ packageManager: "pnpm@10.29.1+sha512.abc", scripts: { test: "turbo run test" } }),
      "package-lock.json": "{}",
    });
    expect(detectPackageManager(repo)).toBe("pnpm");
    expect(detectGateCommands(repo, DEFAULT_CONFIG).test).toBe("pnpm -s run test");
  });

  test.each([
    ["pnpm-lock.yaml", "pnpm", "pnpm -s run test"],
    ["yarn.lock", "yarn", "yarn run test"],
    ["bun.lockb", "bun", "bun run test"],
    ["package-lock.json", "npm", "npm run -s test"],
  ] as const)("lockfile %s → %s", (lockfile, pm, cmd) => {
    const repo = makeRepo({ "package.json": scripts, [lockfile]: "" });
    expect(detectPackageManager(repo)).toBe(pm);
    expect(detectGateCommands(repo, DEFAULT_CONFIG).test).toBe(cmd);
  });

  test("no field, no lockfile → npm (last resort)", () => {
    const repo = makeRepo({ "package.json": scripts });
    expect(detectPackageManager(repo)).toBe("npm");
  });

  test("cfg override still beats PM detection", () => {
    const repo = makeRepo({ "package.json": scripts, "pnpm-lock.yaml": "" });
    const cfg = { ...DEFAULT_CONFIG, gates: { test: "make check" } };
    expect(detectGateCommands(repo, cfg).test).toBe("make check");
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

  test("test: a fresh fingerprint set containing zero failure-shaped lines passes the gate", async () => {
    // an unrecognized runner: nothing it prints is failure-shaped, so nothing it prints is a verdict
    const repo = makeRepo({ "out.txt": "checker error in module a\n", "run.sh": "cat out.txt; exit 1\n" });
    const commands = { test: "bash run.sh" };
    const baseline = await captureBaseline(repo, commands);
    expect(baseline.commands.test.fingerprints).toEqual([UNRECOGNIZED_FAILURE]);
    writeFileSync(join(repo, "out.txt"), "checker error in module a\nrun attempt 2 failed to reach the zone\n");

    const result = (await compareToBaseline(repo, commands, baseline, ["test"]))[0];
    expect(result).toMatchObject({ gate: "test", pass: true });
    expect(result.details).toMatch(/pre-existing/i);
    // …but the pass says what it rests on: forgiveness here is unread output, not a verified green
    expect(result.details).toMatch(/no failure shape recognized/i);

    // and where the fresh set is genuinely non-empty yet holds no failure shape — an already-red
    // baseline of recognized failures whose command now fails unrecognizably — the same holds: the
    // marker is fresh, and being no shape it decides nothing
    const shapedBaseline = { commands: { test: { exitCode: 1, fingerprints: ["FAIL tests/a.test.ts > old failure"] } } };
    const marked = (await compareToBaseline(repo, commands, shapedBaseline, ["test"]))[0];
    expect(fingerprint("checker error in module a")).toEqual([UNRECOGNIZED_FAILURE]); // fresh vs that baseline
    expect(marked).toMatchObject({ gate: "test", pass: true });
  });

  test("the fingerprint heuristic cannot reject an implementation for rendering vocabulary its surfaces are chartered to render", async () => {
    const repo = makeRepo({
      "out.txt": " FAIL  tests/a.test.ts > old failure\n",
      "run.sh": "cat out.txt; exit 1\n",
    });
    const commands = { test: "bash run.sh" };
    const baseline = await captureBaseline(repo, commands);
    // the task under gate adds a run-status surface: every drawn line below is vocabulary the baseline
    // has never seen, and the only real failure is the pre-existing one
    writeFileSync(join(repo, "out.txt"), [
      "stdout | tests/cockpit/run.test.ts > run strip",
      "┌────────────────────────────────┐",
      "│ ✗ tip-verify FAILED · zone +3  │",
      "│ run attempt 2 · 1 failed       │",
      "│ last error: attempt 1 timed out│",
      "└────────────────────────────────┘",
      " FAIL  tests/a.test.ts > old failure",
      "",
    ].join("\n"));

    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0]).toMatchObject({ gate: "test", pass: true });
  });

  test("test: a genuinely new failing test still fails the gate and its fingerprint is reported", async () => {
    const repo = makeRepo({
      "out.txt": " FAIL  tests/a.test.ts > old failure\n",
      "run.sh": "cat out.txt; exit 1\n",
    });
    const commands = { test: "bash run.sh" };
    const baseline = await captureBaseline(repo, commands);
    writeFileSync(
      join(repo, "out.txt"),
      "zone +3 · run attempt 2 · 1 failed · last error on attempt 1\n FAIL  tests/a.test.ts > old failure\n FAIL  tests/new.test.ts > real regression 42\n",
    );

    const result = (await compareToBaseline(repo, commands, baseline, ["test"]))[0];
    expect(result.pass).toBe(false);
    expect(result.details).toContain(
      "new failure fingerprints vs baseline (secondary):\nFAIL tests/new.test.ts > real regression #",
    );

    // …and not only for Vitest's FAIL prefix: an already-red pytest, go or TAP repo must still block a
    // new failing test, or "shape, not vocabulary" would forgive every runner we did not fixture.
    for (const [old_, added] of [
      ["FAILED tests/test_old.py::test_a - AssertionError: nope", "FAILED tests/test_new.py::test_b - AssertionError: nope"],
      ["--- FAIL: TestOld (0.00s)", "--- FAIL: TestNew (0.01s)"],
      ["not ok 1 - old failure", "not ok 2 - new failure"],
      // trailing-verdict runners (cargo/libtest, and the same shape with the other separator): the
      // verdict ends the line after the runner's own separator, which no drawn strip does
      ["test tests::old_failure ... FAILED", "test tests::genuinely_new_failure ... FAILED"],
      ["tests::old_failure --- FAILED", "tests::genuinely_new_failure --- FAILED"],
    ]) {
      const runner = makeRepo({ "out.txt": `${old_}\n`, "run.sh": "cat out.txt; exit 1\n" });
      const base = await captureBaseline(runner, commands);
      expect(base.commands.test.exitCode).toBe(1);

      // the old failure alone is still forgiven…
      expect((await compareToBaseline(runner, commands, base, ["test"]))[0].pass).toBe(true);

      // …the new one blocks, and names itself in the details
      writeFileSync(join(runner, "out.txt"), `${old_}\n${added}\n`);
      const r = (await compareToBaseline(runner, commands, base, ["test"]))[0];
      expect(r.pass).toBe(false);
      expect(r.details).toContain(added);
      expect(r.meta?.failingTests).toContain(added);
    }
  });

  // T13 round 3, reviewer's Cargo reproduction: cargo puts the verdict LAST, so the leading-verdict
  // shapes read none of it — a one-failing-test baseline fingerprinted as <unrecognized failure output>
  // and a second genuinely failing test came back pass:true. Both blobs below are VERBATIM captures of
  // `cargo test --offline` on cargo 1.95.0 (2026-08-02), only the crate's absolute path neutralized.
  test("an already-red cargo baseline still blocks a newly failing cargo test and names it", async () => {
    const CARGO_HEAD = [
      "   Compiling fixture v0.1.0 (/tmp/fixture)",
      "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.06s",
      "     Running unittests src/lib.rs (target/debug/deps/fixture-6b5074602f5d8170)",
      "",
    ];
    const baselineOut = [
      ...CARGO_HEAD,
      "running 2 tests",
      "test tests::passes ... ok",
      "test tests::old_failure ... FAILED",
      "",
      "failures:",
      "",
      "---- tests::old_failure stdout ----",
      "",
      "thread 'tests::old_failure' (81651804) panicked at src/lib.rs:7:24:",
      "assertion `left == right` failed",
      "  left: 2",
      " right: 3",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
      "",
      "",
      "failures:",
      "    tests::old_failure",
      "",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
      "",
      "error: test failed, to rerun pass `--lib`",
      "",
    ].join("\n");
    const regressedOut = [
      ...CARGO_HEAD,
      "running 3 tests",
      "test tests::passes ... ok",
      "test tests::genuinely_new_failure ... FAILED",
      "test tests::old_failure ... FAILED",
      "",
      "failures:",
      "",
      "---- tests::genuinely_new_failure stdout ----",
      "",
      "thread 'tests::genuinely_new_failure' (81652742) panicked at src/lib.rs:11:34:",
      "assertion `left == right` failed",
      "  left: 4",
      " right: 5",
      "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
      "",
      "---- tests::old_failure stdout ----",
      "",
      "thread 'tests::old_failure' (81652743) panicked at src/lib.rs:7:24:",
      "assertion `left == right` failed",
      "  left: 2",
      " right: 3",
      "",
      "",
      "failures:",
      "    tests::genuinely_new_failure",
      "    tests::old_failure",
      "",
      "test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
      "",
      "error: test failed, to rerun pass `--lib`",
      "",
    ].join("\n");

    const repo = makeRepo({ "out.txt": baselineOut, "run.sh": "cat out.txt; exit 101\n" });
    const commands = { test: "bash run.sh" };
    const baseline = await captureBaseline(repo, commands);

    // the red baseline is READ, not shrugged at: the marker would erase the distinction between
    // "one test fails here" and "two do"
    expect(baseline.commands.test.fingerprints).not.toContain(UNRECOGNIZED_FAILURE);
    expect(baseline.commands.test.fingerprints).toContain("test tests::old_failure ... FAILED");

    // the same red run is still forgiven…
    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0]).toMatchObject({ pass: true });

    // …and the second genuinely failing test blocks, named in details and in meta
    writeFileSync(join(repo, "out.txt"), regressedOut);
    const r = (await compareToBaseline(repo, commands, baseline, ["test"]))[0];
    expect(r.pass).toBe(false);
    expect(r.details).toContain("test tests::genuinely_new_failure ... FAILED");
    expect(r.meta?.failingTests).toContain("test tests::genuinely_new_failure ... FAILED");
    // the pre-existing one is not reported as new
    expect(r.details).not.toContain("new failure fingerprints vs baseline (secondary):\ntest tests::old_failure");
  });

  // T13 round 2, reviewer's end-to-end reproduction: with only Vitest/pytest/go fixtured, a real
  // already-red node:test (TAP) baseline forgave a second genuinely failing test — pass:true, and its
  // fingerprint absent from the report. No fixture here: the runner is spawned for real.
  test("an already-red node:test TAP baseline still blocks a newly failing TAP test and names it", async () => {
    const failingTest = (name: string) => [
      'const { test } = require("node:test");',
      'const assert = require("node:assert");',
      `test(${JSON.stringify(name)}, () => { assert.strictEqual(1, 2); });`,
      "",
    ].join("\n");
    const repo = makeRepo({ "old.test.js": failingTest("old failure") });
    const commands = { test: "node --test --test-reporter=tap" };

    const baseline = await captureBaseline(repo, commands);
    expect(baseline.commands.test.exitCode).not.toBe(0);
    expect(baseline.commands.test.fingerprints).toContain("not ok # - old failure");

    // the same red run is forgiven…
    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0]).toMatchObject({ pass: true });

    // …and a second genuinely failing TAP test blocks, named in details and in meta
    writeFileSync(join(repo, "new.test.js"), failingTest("new failure"));
    const r = (await compareToBaseline(repo, commands, baseline, ["test"]))[0];
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/not ok \d+ - new failure/);
    expect(r.details).toContain("not ok # - new failure"); // the fresh fingerprint itself is reported
    expect(r.meta?.failingTests?.some((l) => /not ok \d+ - new failure/.test(l))).toBe(true);
  });

  // T13 round 4, anchored review (codex:gpt-5.6-sol, upheld): Node v22's spec reporter
  // (`--test-reporter=spec`) speaks glyphs — `✖ old failure (0.585875ms)` per failure, `ℹ fail 1`
  // in the totals — which no fixtured shape read: a one-failure spec baseline fingerprinted as
  // <unrecognized failure output>, so a second genuinely failing test came back pass:true with its
  // fingerprint unreported. No fixture here either: the runner is spawned for real.
  test("an already-red node:test spec baseline still blocks a newly failing spec test and names it", async () => {
    const failingTest = (name: string) => [
      'const { test } = require("node:test");',
      'const assert = require("node:assert");',
      `test(${JSON.stringify(name)}, () => { assert.strictEqual(1, 2); });`,
      "",
    ].join("\n");
    const repo = makeRepo({ "old.test.js": failingTest("old failure") });
    const commands = { test: "node --test --test-reporter=spec" };

    const baseline = await captureBaseline(repo, commands);
    expect(baseline.commands.test.exitCode).not.toBe(0);
    // the red baseline is READ, not shrugged at: the marker would erase the distinction between
    // "one test fails here" and "two do"
    expect(baseline.commands.test.fingerprints).not.toContain(UNRECOGNIZED_FAILURE);
    expect(baseline.commands.test.fingerprints).toContain("✖ old failure (#.#ms)");

    // the same red run is still forgiven…
    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0]).toMatchObject({ pass: true });

    // …and a second genuinely failing spec test blocks, named in details and in meta
    writeFileSync(join(repo, "new.test.js"), failingTest("new failure"));
    const r = (await compareToBaseline(repo, commands, baseline, ["test"]))[0];
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/✖ new failure \(/);
    expect(r.details).toContain("✖ new failure (#.#ms)"); // the fresh fingerprint itself is reported
    expect(r.meta?.failingTests?.some((l) => /✖ new failure \(/.test(l))).toBe(true);
  });

  // T13 round 5, anchored review (claude-opus-5, material): python unittest -v emits BOTH position
  // rules — `FAIL: test_x (mod.Class.test_x)` (leading verdict + identifier) and
  // `test_x (mod.Class.test_x) ... FAIL` (identifier + runner separator + trailing verdict) — and each
  // missed the fixtured shapes by one character, so a one-failure baseline fingerprinted only its
  // AssertionError body line and a second genuinely failing test came back pass:true. No fixture here
  // either: the runner is spawned for real.
  test("an already-red python unittest baseline still blocks a newly failing unittest test and names it", async () => {
    const failingTest = (cls: string, name: string) => [
      "import unittest",
      "",
      `class ${cls}(unittest.TestCase):`,
      `    def ${name}(self):`,
      "        self.assertEqual(1, 2)",
      "",
    ].join("\n");
    const repo = makeRepo({ "test_a.py": failingTest("TestA", "test_old") });
    const commands = { test: "python3 -m unittest -v" };

    const baseline = await captureBaseline(repo, commands);
    expect(baseline.commands.test.exitCode).not.toBe(0);
    // the red baseline is READ, not shrugged at: the marker would erase the distinction between
    // "one test fails here" and "two do" — both unittest position rules name the failing test.
    // (python <3.11 prints the qualified name as `(test_a.TestA)`, 3.11+ as `(test_a.TestA.test_old)`)
    const fps = baseline.commands.test.fingerprints;
    expect(fps).not.toContain(UNRECOGNIZED_FAILURE);
    expect(fps.some((f) => /^test_old \(test_a\.TestA(?:\.test_old)?\) \.\.\. FAIL$/.test(f))).toBe(true);
    expect(fps.some((f) => /^FAIL: test_old \(test_a\.TestA(?:\.test_old)?\)$/.test(f))).toBe(true);

    // the same red run is forgiven…
    expect((await compareToBaseline(repo, commands, baseline, ["test"]))[0]).toMatchObject({ pass: true });

    // …and a second genuinely failing unittest test blocks, named in details and in meta
    writeFileSync(join(repo, "test_b.py"), failingTest("TestB", "test_new"));
    const r = (await compareToBaseline(repo, commands, baseline, ["test"]))[0];
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/FAIL: test_new \(test_b\.TestB(?:\.test_new)?\)/);
    expect(r.details).toMatch(/test_new \(test_b\.TestB(?:\.test_new)?\) \.\.\. FAIL/);
    expect(r.meta?.failingTests?.some((l) => /FAIL: test_new \(test_b\.TestB(?:\.test_new)?\)/.test(l))).toBe(true);
    expect(r.meta?.failingTests?.some((l) => /test_new \(test_b\.TestB(?:\.test_new)?\) \.\.\. FAIL/.test(l))).toBe(true);
  });
});

// Tier A #3 (2026-07-21 repo-scan reconciliation): vacuous command oracles surface at baseline capture.
describe("vacuous command oracles at baseline", () => {
  test("an oracle passing at baseline is named in a per-task warning; a mixed task lists only the vacuous ones", async () => {
    const repo = makeRepo({ "present.txt": "x" });
    const warnings = await detectVacuousOracles(repo, [
      { id: "T1", acceptance: [
        { oracle: "command", command: "test -f present.txt" },
        { oracle: "command", command: "test -f absent.txt" },
      ] },
      { id: "T2", acceptance: [{ oracle: "command", command: "test -f absent.txt" }] },
    ]);
    expect(warnings).toEqual([{
      kind: "vacuous-oracle",
      taskId: "T1",
      oracles: ["test -f present.txt"],
      reason: expect.stringContaining("test -f present.txt"),
    }]);
    expect(warnings[0].reason).toContain("T1");
  });

  test("a command oracle that fails at baseline capture produces no vacuous warning", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    const warnings = await detectVacuousOracles(repo, [
      { id: "T1", acceptance: [{ oracle: "command", command: "test -f does-not-exist.txt" }] },
    ]);
    expect(warnings).toEqual([]);
  });

  test("a task with only judge oracles produces no vacuous warning and no oracle execution", async () => {
    const repo = makeRepo({ "a.txt": "x" });
    // judge items whose TEXT is shell-runnable — if the pass wrongly executed them, a marker file appears
    const warnings = await detectVacuousOracles(repo, [
      { id: "T1", acceptance: ["touch executed-string.txt", { oracle: "judge", text: "touch executed-judge.txt" }] },
    ]);
    expect(warnings).toEqual([]);
    expect(existsSync(join(repo, "executed-string.txt"))).toBe(false);
    expect(existsSync(join(repo, "executed-judge.txt"))).toBe(false);
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
    // no headline meta — the tsc shape names no test. T9 adds the failure classification here and
    // nothing else: a tsc error is a regression, so the merge predicate must not read it as infra.
    expect(results[0].meta?.failingTests).toBeUndefined();
    expect(results[0].meta).toEqual({ classification: "regression" });
  });

  test("fingerprint still catches FAIL lines (no regex narrowing)", () => {
    expect(fingerprint(readFileSync(INCIDENT_FIXTURE, "utf8"))).toContain(
      "FAIL tests/config/config.test.ts > config > MODEL-# > loadConfig resolves grok tiers",
    );
  });
});

// Q24/Q25 (v1.89 run 498, 7 zero-information kills): a gate battery SIGKILLed at its ceiling has no
// verdict to report. Before this, the kill's partial output carried no failure shape, so a green
// baseline turned it into "command was green at baseline but now exits 137 with no recognizable
// failure lines" — a sentence about the WORK, printed about a suite the machine took away mid-run.
// Both criteria run at TOP LEVEL: vitest's -t contract is the full name (describe titles + title),
// and the acceptance gate anchors it, so a describe wrapper would break the verbatim match.

test("a gate command SIGKILLed at its ceiling produces a gate-result whose details begin", async () => {
  // ONE fixture, ONE command: the only difference between the two reads below is whether it was killed
  const repo = makeRepo({ "run.sh": "exit 0\n" });
  const commands = { test: "bash run.sh" };
  const base = await captureBaseline(repo, commands);
  writeFileSync(
    join(repo, "run.sh"),
    "echo ' FAIL  tests/a.test.ts > boom'; echo ' Tests  1 failed | 9 passed (10)'; exit 1\n",
  );
  try {
    // the runner answered, so its answer is what gets reported — unchanged by this task
    const [red] = await compareToBaseline(repo, commands, base, ["test"]);
    expect(red.pass).toBe(false);
    expect(red.details.startsWith("ceiling-kill")).toBe(false);
    expect(red.details).toContain("FAIL  tests/a.test.ts > boom");
    expect(red.meta?.failingTests).toEqual([" FAIL  tests/a.test.ts > boom"]);
    expect(red.meta?.kind).toBeUndefined();

    // same fixture, same command, same green baseline — this time the ceiling killed it
    shSpy.stub = (cmd) =>
      cmd.includes("run.sh")
        ? { code: 137, stdout: " ✓ tests/a.test.ts > slow start 1\n", stderr: "", timedOut: true, durationMs: 600_042 }
        : undefined;
    const [killed] = await compareToBaseline(repo, commands, base, ["test"]);
    expect(killed.pass).toBe(false);
    expect(killed.details.startsWith("ceiling-kill")).toBe(true);
    expect(killed.details).toContain("600042ms"); // elapsed
    expect(killed.details).toContain(`${base.commands.test.ceilingMs}ms`); // configured
    // the sentence this task exists to delete: a kill is not a claim about the work
    expect(killed.details).not.toContain("no recognizable failure lines");
    expect(killed.meta).toMatchObject({
      kind: "ceiling-kill", classification: "infra", infra: true, durationMs: 600_042, ceilingMs: 600_000,
    });
  } finally {
    shSpy.stub = undefined;
  }
}, 30_000);

test("baseline capture stores the measured suite duration and a later battery uses", async () => {
  const repo = makeRepo({ "run.sh": "sleep 0.2; exit 0\n" });
  const commands = { test: "bash run.sh" };
  const base = await captureBaseline(repo, commands);
  const measured = base.commands.test.durationMs!;
  expect(measured).toBeGreaterThanOrEqual(200); // the suite's own clock, not a constant
  expect(base.commands.test.ceilingMs).toBe(Math.max(600_000, 3 * measured)); // persisted with it

  // a measured repository whose suite is slower than the floor: 3 × measured is the only number a
  // hard-coded 600000 cannot produce, so this is the assertion that falsifies a constant ceiling
  shSpy.calls.length = 0;
  const slow = { commands: { test: { exitCode: 0, fingerprints: [], durationMs: 400_000, ceilingMs: 1_200_000 } } };
  await compareToBaseline(repo, commands, slow, ["test"]);
  expect(shSpy.calls.map((c) => c.timeoutMs)).toEqual([1_200_000]);

  // …and a pre-v1.90 baseline.json, which has no measurement at all, gets the shipped constant
  shSpy.calls.length = 0;
  await compareToBaseline(repo, commands, { commands: { test: { exitCode: 0, fingerprints: [] } } }, ["test"]);
  expect(shSpy.calls.map((c) => c.timeoutMs)).toEqual([DEFAULT_SHELL_TIMEOUT_MS]);
  expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(600_000);

  // capture and compare both derive the number here, so the two cannot drift apart
  expect(effectiveCeilingMs({ durationMs: 400_000 })).toBe(1_200_000);
  expect(effectiveCeilingMs({ durationMs: 1_000 })).toBe(600_000);
  expect(effectiveCeilingMs(undefined)).toBe(600_000);
}, 30_000);
