import { spawn, type SpawnOptions } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
const CLASSIFIER = join(ROOT, "skills/tickmarkr-overseer/scripts/classify-vitest-log.sh");
const WRAPPER = join(ROOT, "scripts/run-ci-vitest.sh");
const TWIN_DIR = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts");
const cleanup: string[] = [];

// Q72s birpc-starver class (vitest.config.ts): async spawn, never spawnSync — these tests run dozens of
// children, and a synchronous child blocks this worker's event loop until vitest's RPC times out under load.
type Spawned = { status: number | null; stdout: string; stderr: string };
const bash = (args: string[], options: SpawnOptions = {}) => new Promise<Spawned>((settle, fail) => {
  const child = spawn("bash", args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", fail).on("close", (status) => settle({ status, stdout, stderr }));
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---- Vitest 3.2 log shapes: the unhandled block prints BEFORE the file summary, whose Errors line
// counts the same list the block's tally does; the summary ends at its Duration line.
const BAR = "⎯⎯⎯⎯⎯⎯";
const banner = (title: string) => `${BAR} ${title} ${BAR}`;
const RPC = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
const ORACLE = "COUNT_ORACLE GREEN expected=10 actual=10\n";
const summary = (errors = 0, files = "8 passed | 2 skipped (10)", tests = "40 passed | 3 skipped (43)") =>
  [
    "",
    ` Test Files  ${files}`,
    `      Tests  ${tests}`,
    ...(errors ? [`     Errors  ${errors} error${errors > 1 ? "s" : ""}`] : []),
    "   Start at  10:00:00",
    "   Duration  12.00s (transform 1.00s, setup 0ms, collect 2.00s, tests 9.00s)",
    "",
  ].join("\n");
const block = (...payloads: string[]) =>
  [
    banner("Unhandled Errors"),
    "",
    `Vitest caught ${payloads.length} unhandled error${payloads.length > 1 ? "s" : ""} during the test run.`,
    "This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.",
    ...payloads.flatMap((payload) => ["", banner("Unhandled Error"), payload, " ❯ node_modules/vitest/dist/chunks/rpc.js:49:13"]),
    BAR,
    "",
  ].join("\n");
// gh renders a job log line as "<job>\t<step>\t<timestamp> <text>"
const ghJobLog = (log: string) =>
  log.split("\n").map((line) => `test\tRun coverage proof (parallel suite project)\t2026-09-25T20:33:15.0679633Z ${line}`).join("\n");

const LOGS = {
  empty: undefined,
  green: summary() + ORACLE,
  unhandled: block("TypeError: boom", "TypeError: bang") + summary(2) + ORACLE,
  rpc: block(RPC) + summary(1) + ORACLE,
  "rpc-mixed": block(RPC, "TypeError: boom") + summary(2) + ORACLE,
  "rpc-stray": `stderr | tests/x.test.ts > case\n${RPC}\n` + block("TypeError: boom") + summary(1) + ORACLE,
  "rpc-shadow": block(`TypeError: boom\n${RPC}`) + summary(1) + ORACLE,
  "rpc-prose": `stdout | tests/x.test.ts > case: Unhandled Error handler installed\n${RPC}\n` + block("TypeError: boom") + summary(1) + ORACLE,
  "rpc-quoted": block('AssertionError: expected "Error: [vitest-worker]: Timeout calling \\"onTaskUpdate\\"" to be undefined') + summary(1) + ORACLE,
  "rpc-forged": `stdout | tests/x.test.ts > case\n${banner("Unhandled Error")}\n${RPC}\n` + block("TypeError: boom") + summary(1) + ORACLE,
  "rpc-styled": [
    "^[[31m⎯⎯^[[39m^[[1m^[[41m Unhandled Errors ^[[49m^[[22m^[[31m⎯⎯^[[39m",
    "^[[31m^[[1m",
    "Vitest caught 1 unhandled error during the test run.",
    "^[[31m⎯⎯^[[39m^[[1m^[[41m Unhandled Error ^[[49m^[[22m^[[31m⎯⎯^[[39m",
    "^[[31m^[[1mTypeError^[[22m: boom^[[39m",
    "^[[2m Test Files ^[[22m ^[[1m^[[32m8 passed^[[39m^[[22m^[[2m | ^[[22m^[[33m2 skipped^[[39m^[[90m (10)^[[39m",
    "^[[2m      Tests ^[[22m ^[[1m^[[32m40 passed^[[39m^[[22m",
    "^[[2m     Errors ^[[22m ^[[1m^[[31m1 error^[[39m^[[22m",
    "^[[2m   Duration ^[[22m 12.00s",
    "COUNT_ORACLE GREEN expected=10 actual=10",
    "stdout | tests/x.test.ts > case",
    banner("Unhandled Error"),
    RPC,
    "",
  ].join("\n"),
} as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-grade-ci-"));
  cleanup.push(root);
  const bin = join(root, "bin");
  const logs = join(root, "logs");
  mkdirSync(bin);
  mkdirSync(logs);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/bash
if [[ " $* " == *" --json jobs "* ]]; then
  printf '101\\ttest\\tcompleted\\t%s\\n102\\ttest-macos\\tcompleted\\t%s\\n' "\${GH_CONCLUSION:-success}" "\${GH_MACOS_CONCLUSION:-\${GH_CONCLUSION:-success}}"
  exit 0
fi
if [[ " $* " == *" --log "* ]]; then
  if [[ " $* " == *" --job 102 "* && -n "\${GH_MACOS_LOG_FILE:-}" ]]; then cat "$GH_MACOS_LOG_FILE"; exit 0; fi
  [ -n "\${GH_LOG_FILE:-}" ] && cat "$GH_LOG_FILE"
  exit 0
fi
exit 1
`);
  chmodSync(gh, 0o755);
  let n = 0;
  const write = (text: string) => {
    const path = join(root, `log-${n++}.txt`);
    writeFileSync(path, text);
    return path;
  };

  // the grader over one gh job log (both jobs read the same fixture unless macOS is given its own)
  const grade = (expected: number, log: string | undefined, tag: string, conclusion = "success", macosLog?: string, macosConclusion = conclusion) => bash(
    [SCRIPT, "12345", String(expected), `${tag}-${expected}`],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GH_CONCLUSION: conclusion,
        GH_MACOS_CONCLUSION: macosConclusion,
        GH_LOG_FILE: log === undefined ? "" : write(log),
        GH_MACOS_LOG_FILE: macosLog === undefined ? "" : write(macosLog),
        PATH: `${bin}:${process.env.PATH}`,
        TKR_GRADE_CI_DIR: logs,
      },
    },
  );
  const run = (expected: number, mode: keyof typeof LOGS) => grade(expected, LOGS[mode], mode);
  // the public CI wrapper over a stand-in Vitest command that prints the raw log and exits `status`
  const wrap = (log: string, status: number) => bash(
    [WRAPPER, join(root, `ci-${n++}.log`), "bash", "-c", 'cat "$1"; exit "$2"', "fake-vitest", write(log), String(status)],
    { cwd: ROOT },
  );
  return { run, grade, wrap };
}

describe("grade-ci.sh job-log controls", () => {
  test("test: grade-ci.sh reads UNREADABLE and exits 2 for a job whose log is empty and GREEN for a log carrying the count oracle at the expected count with zero failed and RED for the same log at a different expected count whereas a grader that reads an empty log as green fails", async () => {
    const { run } = fixture();

    const empty = await run(10, "empty");
    expect(empty.status).toBe(2);
    expect(empty.stdout).toContain("test: UNREADABLE (empty log)");
    expect(empty.stdout).not.toContain("test: GREEN");

    const green = await run(10, "green");
    expect(green.status).toBe(0);
    expect(green.stdout).toContain("test: GREEN");
    expect(green.stdout).toContain("test-macos: GREEN");
    expect(green.stdout).toContain("failed=0");

    const red = await run(11, "green");
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("test: RED");
    expect(red.stdout).not.toContain("test: GREEN");
  });

  test("test: grade-ci over a fixture job log whose count oracle is green beside a vitest unhandled-errors block prints the unhandled count on the job's line and grades the job RED, while the same log without the block grades GREEN, so a grader blind to unhandled errors fails", async () => {
    const { run } = fixture();

    const unhandled = await run(10, "unhandled");
    expect(unhandled.status).toBe(1);
    expect(unhandled.stdout).toMatch(/^test: oracle=\[COUNT_ORACLE GREEN expected=10 actual=10\].* unhandled=2 /m);
    expect(unhandled.stdout).toContain("test: RED");
    expect(unhandled.stdout).not.toContain("test: GREEN");

    const green = await run(10, "green");
    expect(green.status).toBe(0);
    expect(green.stdout).toMatch(/^test: oracle=.* unhandled=0 /m);
    expect(green.stdout).toContain("test: GREEN");
  });

  test("test: grade-ci over a fixture job log whose only unhandled error is a vitest-worker RPC timeout grades the job GREEN and names the timeout on its own field, while a log carrying that timeout beside any other unhandled error grades RED and neither a stray timeout diagnostic outside the unhandled block nor a timeout line shadowing a real error's payload under one header nor a prose line that merely contains the header's words nor an assertion whose payload quotes the timeout text nor a header and timeout printed to stdout outside Vitest's own block — before it, or after a styled file summary in gh's ^[ rendering — offsets that error, so a grader that reds the starved runner's own noise, or one that lets a real unhandled error hide behind it, fails", async () => {
    const { run } = fixture();
    const rpc = await run(10, "rpc");
    expect(rpc.status).toBe(0);
    expect(rpc.stdout).toMatch(/^test: oracle=.* unhandled=0 runner_rpc_timeouts=1 /m);
    expect(rpc.stdout).toContain("test: GREEN");
    const mixed = await run(10, "rpc-mixed");
    expect(mixed.status).toBe(1);
    expect(mixed.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=1 /m);
    expect(mixed.stdout).toContain("test: RED");
    for (const mode of ["rpc-stray", "rpc-shadow", "rpc-prose", "rpc-quoted", "rpc-forged", "rpc-styled"] as const) {
      const red = await run(10, mode);
      expect(red.status, mode).toBe(1);
      expect(red.stdout, mode).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
      expect(red.stdout, mode).toContain("test: RED");
    }
  });

  test("test: the public CI wrapper and grader agree on complete RPC-only green versus mixed unhandled errors coverage threshold misses failed or timed-out tests and truncated logs, so one red fixture classified green fails", async () => {
    const { grade, wrap } = fixture();
    const rpcOnly = block(RPC) + summary(1);
    // Vitest prints an exception thrown after the summary (here a coverage reporter's) under a lone
    // banner, then exits 1
    const reportCrash = `\n${banner("Unhandled Error")}\nError: ENOENT: no such file or directory, open 'coverage/.tmp/coverage-0.json'\n ❯ node_modules/@vitest/coverage-v8/dist/provider.js:9:9\n\n\n`;
    // [name, raw Vitest log, the command's own exit status, green]
    const cases: [name: string, log: string, status: number, green: boolean][] = [
      ["complete RPC-only", rpcOnly, 1, true],
      ["complete clean run", summary(), 0, true],
      ["mixed unhandled errors", block(RPC, "TypeError: boom") + summary(2), 1, false],
      ["coverage threshold miss", rpcOnly + "ERROR: Coverage for lines (79.21%) does not meet global threshold (80%)\n", 1, false],
      ["coverage reporting exception after a complete RPC-only summary", rpcOnly + reportCrash, 1, false],
      ["failed test", block(RPC) + summary(1, "1 failed | 7 passed | 2 skipped (10)", "1 failed | 39 passed | 3 skipped (43)"), 1, false],
      [
        "timed-out test",
        " FAIL  tests/slow.test.ts > waits\nError: Test timed out in 5000ms.\n" +
          block(RPC) + summary(1, "1 failed | 7 passed | 2 skipped (10)", "1 failed | 39 passed | 3 skipped (43)"),
        1,
        false,
      ],
      ["log truncated inside the summary", rpcOnly.slice(0, rpcOnly.indexOf("   Start at")), 1, false],
      ["log truncated inside the unhandled block", rpcOnly.slice(0, rpcOnly.indexOf(RPC)), 1, false],
      ["whole block forged on stdout", `stdout | tests/x.test.ts > case\n${block(RPC)}` + summary(), 1, false],
      // outside the proven exception the command's own status stands: any other code, a signal, exit 1 unexplained
      ["complete passing summary then exit 2", summary(), 2, false],
      ["complete RPC-only then exit 2", rpcOnly, 2, false],
      ["complete RPC-only then killed (137) without an npm signal line", rpcOnly, 137, false],
      ["complete clean summary then exit 1", summary(), 1, false],
    ];
    for (const [name, log, status, green] of cases) {
      const ci = await wrap(log, status);
      // the job log CI produces for that raw outcome: the step's own exit annotation and conclusion
      const job = ghJobLog(log + (status ? `##[error]Process completed with exit code ${status}.\n` : "")) + "\n" + ORACLE;
      const graded = await grade(10, job, "agree", status ? "failure" : "success");
      expect(ci.status === 0, `${name}: wrapper exit ${ci.status}\n${ci.stdout}`).toBe(green);
      if (!green && status !== 1) expect(ci.status, name).toBe(status);
      expect(graded.status === 0, `${name}: grader exit ${graded.status}\n${graded.stdout}`).toBe(green);
      expect(graded.stdout, name).toMatch(green ? /^test: GREEN$/m : /^test: (RED|UNREADABLE)$/m);
      if (!green) expect(graded.stdout, name).not.toContain("test: GREEN");
    }

    // a cancelled job, or a failure no step exit explains, never grades GREEN
    for (const conclusion of ["cancelled", "failure"]) {
      const graded = await grade(10, ghJobLog(summary()) + "\n" + ORACLE, "concl", conclusion);
      expect(graded.status, conclusion).toBe(1);
      expect(graded.stdout, conclusion).toContain("test: RED");
    }
    const accepted = await wrap(rpcOnly, 1);
    expect(accepted.stdout).toContain("VITEST_LOG verdict=RPC_ONLY");
  });

  test("test: a complete RPC-only run whose test prints the daemon's normalized timeout fingerprint on stdout is forgiven by the wrapper and graded GREEN, while Vitest's own timed-out message with its millisecond count stays RED, so a classifier that counts a test's printed output as a timed-out test fails", async () => {
    const { grade, wrap } = fixture();
    // OBS-1106's daemon tests print fingerprints normalized to '#ms'; Vitest's own message always carries digits.
    const printed = "stdout | tests/run/daemon/x.test.ts > case\nfailing tests:\nFAIL tests/slow.test.ts > slow\n\nnew failure fingerprints vs baseline (secondary):\nError: Test timed out in #ms.\n\n";
    const rpcOnly = printed + block(RPC) + summary(1);
    const ci = await wrap(rpcOnly, 1);
    expect(ci.status, ci.stdout).toBe(0);
    expect(ci.stdout).toContain("VITEST_LOG verdict=RPC_ONLY");
    const job = ghJobLog(rpcOnly + "##[error]Process completed with exit code 1.\n") + "\n" + ORACLE;
    const graded = await grade(10, job, "fingerprint", "failure");
    expect(graded.status, graded.stdout).toBe(0);
    expect(graded.stdout).toMatch(/^test: oracle=.* timedout=0 /m);
    expect(graded.stdout).toContain("test: GREEN");
    const real = " FAIL  tests/slow.test.ts > waits\nError: Test timed out in 5000ms.\n" + block(RPC)
      + summary(1, "1 failed | 7 passed | 2 skipped (10)", "1 failed | 39 passed | 3 skipped (43)");
    expect((await wrap(real, 1)).status).toBe(1);
    expect((await grade(10, ghJobLog(real + "##[error]Process completed with exit code 1.\n") + "\n" + ORACLE, "real", "failure")).stdout)
      .toMatch(/^test: oracle=.* timedout=1 .*\ntest: RED$/m);
  });

  test("the shipped classifier and CI grader return INFRA_KILLED exit 3 for runner shutdown without failed tests but RED for shutdown with a failed test and partial expected files or a never-started declared project", async () => {
    const { grade } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-classify-"));
    cleanup.push(dir);
    let k = 0;
    const classify = (log: string, ...contract: string[]) => {
      const path = join(dir, `log-${k++}.txt`);
      writeFileSync(path, log);
      return bash([CLASSIFIER, path, ...contract]);
    };
    const ghStep = (step: string, log: string) =>
      log.split("\n").map((line) => `test\t${step}\t2026-10-02T01:11:41.1203249Z ${line}`).join("\n") + "\n";
    const COVERAGE = "Run coverage proof (parallel suite project)";
    const SINGLE_FORK = "Run single-fork projects (independent of the step above)";
    const SHUTDOWN = "##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";
    const CANCELED = "##[error]The operation was canceled.";
    // D-897: the coverage step finished RPC-only on 7 of the 10 files, then the runner died inside the
    // single-fork step — no second summary, and the count step never ran, so no oracle either
    const sevenRpcOnly = block(RPC) + summary(1, "7 passed (7)", "21 passed (21)");
    const killed = ghStep(COVERAGE, sevenRpcOnly) + ghStep(SINGLE_FORK, `····\n${SHUTDOWN}\n${CANCELED}`);
    const canceledOnly = ghStep(COVERAGE, sevenRpcOnly) + ghStep(SINGLE_FORK, `··\n${CANCELED}`);
    const killedAfterFailure = ghStep(COVERAGE, block(RPC) + summary(1, "1 failed | 6 passed (7)", "1 failed | 20 passed (21)"))
      + ghStep(SINGLE_FORK, `····\n${SHUTDOWN}\n${CANCELED}`);
    const killedAfterTimeout = ghStep(COVERAGE, " FAIL  tests/slow.test.ts > waits\nError: Test timed out in 5000ms.\n" + sevenRpcOnly)
      + ghStep(SINGLE_FORK, `··\n${CANCELED}`);

    // the classifier: a kill alone is its own non-green class, exit 3; a failure beside it is RED
    for (const [name, log] of [["runner shutdown", killed], ["operation canceled", canceledOnly]] as const) {
      const verdict = await classify(log, "10");
      expect(verdict.status, name).toBe(3);
      expect(verdict.stdout, name).toMatch(/^VITEST_LOG verdict=INFRA_KILLED reason=runner-shutdown .* failed=0 timedout=0 .* runner_kills=[12]$/m);
    }
    for (const [name, log] of [["failed test", killedAfterFailure], ["timed-out test", killedAfterTimeout]] as const) {
      const verdict = await classify(log, "10");
      expect(verdict.status, name).toBe(1);
      expect(verdict.stdout, name).toMatch(/^VITEST_LOG verdict=RED reason=(failed|timed-out) .* runner_kills=[12]$/m);
    }
    // a failure Vitest reported before the kill cut its summary off still dominates the kill: the dot
    // reporter's x (its newline-less stream may run straight into a test's stdout/stderr header), the
    // default reporter's ×, a FAIL badge, the Failed Tests banner
    const reportedThenKilled = (report: string) => ghStep(COVERAGE, sevenRpcOnly) + ghStep(SINGLE_FORK, `${report}\n${SHUTDOWN}\n${CANCELED}`);
    const dotThenStdout = "··xstdout | unknown test\nprinted after the failure";
    for (const report of ["··x·", dotThenStdout, "·x·stderr | tests/a.test.ts > runs\nwarned", "   × keeps the ledger 3ms", " FAIL  |built-cli| tests/built-cli/a.test.ts > runs", banner("Failed Tests 1")]) {
      const verdict = await classify(reportedThenKilled(report), "10");
      expect(verdict.status, report).toBe(1);
      expect(verdict.stdout, report).toMatch(/^VITEST_LOG verdict=RED reason=failed .* runner_kills=2$/m);
    }
    // a passing dot stream that runs into a stdout header reports no failure: the kill stays its own class
    expect((await classify(reportedThenKilled("···stdout | unknown test\nprinted"), "10")).status).toBe(3);
    // a test's console block runs until the reporter speaks again, blank lines and all: failure-looking
    // output inside it is not a reported failure, while the dot run the reporter resumes with still is
    const stdoutFail = "··stdout | tests/report.test.ts > prints\n FAIL  tests/slow.test.ts > previous failure";
    const paragraphsFail = "··stdout | tests/report.test.ts > prints\nfirst\n\n FAIL  tests/slow.test.ts > previous failure\n   × keeps the ledger 3ms\n";
    for (const report of [stdoutFail, paragraphsFail]) {
      const verdict = await classify(reportedThenKilled(report), "10");
      expect(verdict.status, `${report}\n${verdict.stdout}`).toBe(3);
      expect(verdict.stdout).toMatch(/^VITEST_LOG verdict=INFRA_KILLED reason=runner-shutdown .* failed=0 timedout=0 /m);
    }
    const failAfterStdout = "··stdout | tests/a.test.ts > prints\nhello\n\nmore\n\n··x·";
    expect((await classify(reportedThenKilled(failAfterStdout), "10")).stdout).toMatch(/^VITEST_LOG verdict=RED reason=failed /m);
    // the default reporter resumes after a console block (header, output, Vitest's own trailing blank line)
    // with a module record: a failed one (❯, even with no failed test — a collect or hook error), or the ×
    // test lines under it, is a reported failure, while a passing ✓ record ends the block without reporting one
    const defaultFailAfterStdout = "stdout | tests/a.test.ts > fails after stdout\nhello\n\n"
      + " \u001b[31m❯\u001b[39m tests/a.test.ts \u001b[2m(1 test | \u001b[22m\u001b[31m1 failed\u001b[39m\u001b[2m)\u001b[22m 5ms\n"
      + "\u001b[31m   × fails after stdout\u001b[39m 3ms\n     → expected 1 to be 2";
    for (const report of [defaultFailAfterStdout, "stdout | tests/a.test.ts > prints\nhello\n\n ❯ |built-cli| tests/a.test.ts (2 tests | 1 failed) 5ms",
      "stdout | tests/a.test.ts\nloading\n\n ❯ tests/a.test.ts (0 test) 5ms"]) {
      const verdict = await classify(reportedThenKilled(report), "10");
      expect(verdict.status, `${report}\n${verdict.stdout}`).toBe(1);
      expect(verdict.stdout).toMatch(/^VITEST_LOG verdict=RED reason=failed .* runner_kills=2$/m);
    }
    expect((await classify(reportedThenKilled("stdout | tests/a.test.ts > prints\nhello\n\n ✓ tests/a.test.ts (1 test) 2ms"), "10")).status).toBe(3);
    // a passing test's stdout that only LOOKS like a failure, settled by its complete all-pass summary,
    // cannot turn the later cancellation RED — the summary's own counts decide what came before it
    const passingStdoutThenCanceled = ghStep(COVERAGE, "stdout | tests/report.test.ts > prints\n FAIL  tests/slow.test.ts > slow\n··x·\n   × keeps the ledger 3ms\n"
      + banner("Failed Tests 1") + "\n" + sevenRpcOnly) + ghStep(SINGLE_FORK, `··\n${CANCELED}`);
    const settled = await classify(passingStdoutThenCanceled, "10");
    expect(settled.status, settled.stdout).toBe(3);
    expect(settled.stdout).toMatch(/^VITEST_LOG verdict=INFRA_KILLED reason=runner-shutdown .* failed=0 timedout=0 .* runner_kills=1$/m);
    // the declared file contract: a complete RPC-only proof of 7 files is partial against 10, whole against 7
    const short = await classify(sevenRpcOnly, "10");
    expect(short.status).toBe(1);
    expect(short.stdout).toMatch(/^VITEST_LOG verdict=RED reason=partial /);
    expect((await classify(sevenRpcOnly, "7")).stdout).toMatch(/^VITEST_LOG verdict=RPC_ONLY reason=none /);
    // the declared project contract: the single-fork step declares sync-heavy, keys-ledger, built-cli and
    // signal-reaper, whose candidate-tree discovery owns 10 files; built-cli's 4 never started. A test that
    // printed a built-cli record — on its header's line or after a blank line of its own — starts nothing:
    // presence is the discovered count, so the 6 collected stay partial, and the same print beside all 10
    // keeps the complete RPC-only proof whole
    const printedRecord = "······stdout | tests/sync-heavy/f1.test.ts > prints\nexample: ✓ |built-cli| tests/built-cli/f1.test.ts\n\n"
      + " ✓ |built-cli| tests/built-cli/f1.test.ts (1 test) 3ms\n\n····\n\n";
    const neverStarted = await classify(printedRecord + block(RPC) + summary(1, "6 passed (6)", "18 passed (18)"), "10");
    expect(neverStarted.status, neverStarted.stdout).toBe(1);
    expect(neverStarted.stdout).toMatch(/^VITEST_LOG verdict=RED reason=partial /);
    const allStarted = await classify(printedRecord + block(RPC) + summary(1, "10 passed (10)", "30 passed (30)"), "10");
    expect(allStarted.status, allStarted.stdout).toBe(0);
    expect(allStarted.stdout).toMatch(/^VITEST_LOG verdict=RPC_ONLY reason=none /);

    // the grader: both jobs killed is INFRA_KILLED (exit 3), never GREEN and never mistaken for UNREADABLE
    for (const conclusion of ["failure", "cancelled"]) {
      const graded = await grade(10, killed, "killed", conclusion);
      expect(graded.status, `${conclusion}\n${graded.stdout}`).toBe(3);
      expect(graded.stdout).toMatch(/^test: oracle=\[MISSING\] .* runner_kills=2 log=\[runner-shutdown\]/m);
      expect(graded.stdout).toMatch(/^test: INFRA_KILLED$/m);
      expect(graded.stdout).toMatch(/^test-macos: INFRA_KILLED$/m);
      expect(graded.stdout).not.toMatch(/: (GREEN|UNREADABLE)$/m);
      expect(graded.stdout).toContain("VERDICT rc=3");
    }
    const settledGrade = await grade(10, passingStdoutThenCanceled, "passing-stdout-canceled", "cancelled");
    expect(settledGrade.status, settledGrade.stdout).toBe(3);
    expect(settledGrade.stdout).toMatch(/^test: INFRA_KILLED$/m);
    // a failed test, or a step's own failing exit, dominates the kill: RED, not INFRA_KILLED or UNREADABLE
    const lintRed = ghStep("Run npm run lint", "src/x.ts: error\n##[error]Process completed with exit code 1.") + killed;
    const stdoutFailGrade = await grade(10, reportedThenKilled(paragraphsFail), "stdout-fail-canceled", "cancelled");
    expect(stdoutFailGrade.status, stdoutFailGrade.stdout).toBe(3);
    expect(stdoutFailGrade.stdout).toMatch(/^test: INFRA_KILLED$/m);
    for (const [name, log] of [["failed test", killedAfterFailure], ["reported failure", reportedThenKilled("··x·")], ["stdout failure", reportedThenKilled(dotThenStdout)], ["failure after stdout", reportedThenKilled(failAfterStdout)], ["default failure after stdout", reportedThenKilled(defaultFailAfterStdout)], ["lint exit", lintRed]] as const) {
      const graded = await grade(10, log, `kill-${name.replace(" ", "-")}`, "failure");
      expect(graded.status, `${name}\n${graded.stdout}`).toBe(1);
      expect(graded.stdout, name).toMatch(/^test: RED$/m);
      expect(graded.stdout, name).not.toMatch(/^test(-macos)?: INFRA_KILLED$/m);
    }
    // partial expected files through the grader: the classifier names it on the job line
    const partial = await grade(10, ghJobLog(sevenRpcOnly) + "\nCOUNT_ORACLE RED expected=10 actual=7\n", "partial");
    expect(partial.status).toBe(1);
    expect(partial.stdout).toMatch(/^test: oracle=.* log=\[partial\] .*\ntest: RED$/m);
    // a never-started declared project through the grader: the coverage step's 10 complete, the single-fork
    // step's 6 of its 10 — built-cli never started — against the job's 20 tracked files
    const noBuiltCli = ghStep(COVERAGE, block(RPC) + summary(1, "10 passed (10)", "30 passed (30)"))
      + ghStep(SINGLE_FORK, printedRecord + summary(0, "6 passed (6)", "18 passed (18)")) + "\nCOUNT_ORACLE RED expected=20 actual=16\n";
    const neverStartedGrade = await grade(20, noBuiltCli, "never-started");
    expect(neverStartedGrade.status, neverStartedGrade.stdout).toBe(1);
    expect(neverStartedGrade.stdout).toMatch(/^test: oracle=.* log=\[partial\] .*\ntest: RED$/m);
    // mixed jobs: a red job dominates a killed one, an unreadable one stays unknown, a green one leaves the kill
    const green = ghJobLog(summary()) + "\n" + ORACLE;
    expect((await grade(10, killed, "mixed-red", "failure", killedAfterFailure)).status).toBe(1);
    expect((await grade(10, killed, "mixed-unreadable", "failure", "")).status).toBe(2);
    const mixedGreen = await grade(10, killed, "mixed-green", "failure", green, "success");
    expect(mixedGreen.stdout).toMatch(/^test-macos: GREEN$/m);
    expect(mixedGreen.status).toBe(3);
  });

  test("unchanged public CI invocation forms derive candidate-tree file and project contracts through the production wrapper so seven of ten files or a never-started built-cli project stays RED while complete RPC-only exit one keeps its narrow exception", async () => {
    // the forms are read from the public workflow itself: the same two wrapped commands in both jobs,
    // passing nothing but a log and the command
    const workflow = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.public.yml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    const forms = new Set<string>();
    for (const job of ["test", "test-macos"]) {
      const wrapped = workflow.jobs[job].steps
        .map((step) => /^bash scripts\/run-ci-vitest\.sh "[^"]+" (.+)$/.exec((step.run ?? "").trim())?.[1])
        .filter((command): command is string => command !== undefined);
      expect(wrapped, job).toHaveLength(2);
      for (const command of wrapped) forms.add(command);
    }
    const [coverageForm, singleForkForm] = [...forms].sort();
    expect([coverageForm, singleForkForm]).toEqual([
      "npm run test:coverage -- --project suite",
      "npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper",
    ]);

    // the candidate tree: each project owns tests/<project>/*.test.ts, 10 per form
    const tree = mkdtempSync(join(tmpdir(), "tickmarkr-ci-candidate-"));
    cleanup.push(tree);
    const owned: Record<string, number> = { suite: 10, "sync-heavy": 2, "keys-ledger": 2, "built-cli": 4, "signal-reaper": 2 };
    for (const [project, files] of Object.entries(owned)) {
      mkdirSync(join(tree, "tests", project), { recursive: true });
      for (let i = 1; i <= files; i++) writeFileSync(join(tree, "tests", project, `f${i}.test.ts`), "");
    }
    // local stand-ins: `npx vitest list --filesOnly --project …` prints the tree's files as Vitest's
    // discovery does ("[project] path") and fails on an unknown project; `npx vitest run …` and
    // `npm run test:coverage …` print the scripted log and exit the scripted status
    const bin = join(tree, ".bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npx"), `#!/usr/bin/env bash
[ "$1" = vitest ] || exit 64
case "$2" in
  list)
    [ "$3" = --filesOnly ] || exit 64
    shift 3
    while [ "$#" -gt 0 ]; do
      { [ "$1" = --project ] && [ -d "tests/$2" ]; } || { echo "No projects matched the filter \\"$2\\"" >&2; exit 1; }
      for f in "tests/$2"/*.test.ts; do printf '[%s] %s\\n' "$2" "$f"; done
      shift 2
    done ;;
  run) cat "$FAKE_RUN_LOG"; exit "$FAKE_RUN_STATUS" ;;
  *) exit 64 ;;
esac
`);
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
[ "$1 $2" = "run test:coverage" ] || exit 64
cat "$FAKE_RUN_LOG"; exit "$FAKE_RUN_STATUS"
`);
    chmodSync(join(bin, "npx"), 0o755);
    chmodSync(join(bin, "npm"), 0o755);
    let k = 0;
    const ci = (form: string, files: number, status: number, wrapper = WRAPPER, total = files, printed = "") => {
      // the lean CI dot reporter: no per-file or per-project line, only the summary (and any test output)
      const log = join(tree, `run-${k}.log`);
      writeFileSync(log, ` RUN  v3.2.7 ${tree}\n\n${"·".repeat(files * 3)}${printed}\n\n` + block(RPC)
        + summary(1, `${files} passed (${total})`, `${files * 3} passed (${files * 3})`));
      return bash([wrapper, join(tree, `ci-${k++}.log`), ...form.split(" ")], {
        cwd: tree,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RUN_LOG: log, FAKE_RUN_STATUS: String(status) },
      });
    };

    for (const [form, projects] of [[coverageForm, "suite"], [singleForkForm, "sync-heavy,keys-ledger,built-cli,signal-reaper"]] as const) {
      const complete = await ci(form, 10, 1);
      expect(complete.status, `${form}\n${complete.stdout}${complete.stderr}`).toBe(0);
      expect(complete.stdout).toContain(`run-ci-vitest: declared contract: 10 files across ${projects}`);
      expect(complete.stdout).toContain("run-ci-vitest: exit 1 -> 0");
      expect(complete.stdout).toContain("VITEST_LOG verdict=RPC_ONLY");
      const seven = await ci(form, 7, 1);
      expect(seven.status, `${form}\n${seven.stdout}`).toBe(1);
      expect(seven.stdout).toContain("run-ci-vitest: exit 1 kept: VITEST_LOG verdict=RED reason=partial");
      // Vitest's "(10)" also counts the queued and running files an abort left unfinished: a total that
      // matches discovery is not completion when only seven of the ten finished
      const unfinished = await ci(form, 7, 1, WRAPPER, 10);
      expect(unfinished.status, `${form}\n${unfinished.stdout}`).toBe(1);
      expect(unfinished.stdout).toContain(`run-ci-vitest: declared contract: 10 files across ${projects}`);
      expect(unfinished.stdout).toContain("run-ci-vitest: exit 1 kept: VITEST_LOG verdict=RED reason=partial");
      // outside exit 1 the command's own status stands, as before
      expect((await ci(form, 10, 0)).status).toBe(0);
      expect((await ci(form, 7, 2)).status).toBe(2);
    }
    // a complete RPC-only proof whose test printed project-looking stdout keeps the narrow exception: the
    // printed label is test output, not a reporter record of built-cli starting without its peers — even
    // when the test's multiline output puts it after a blank line of its own
    const printedLabel = "stdout | tests/built-cli/f1.test.ts > prints\nexample: ✓ |built-cli| tests/cli/bin.test.ts\n\n"
      + " ✓ |built-cli| tests/cli/bin.test.ts (1 test) 3ms\n\n······";
    const printed = await ci(singleForkForm, 10, 1, WRAPPER, 10, printedLabel);
    expect(printed.status, printed.stdout).toBe(0);
    expect(printed.stdout).toContain("run-ci-vitest: exit 1 -> 0");
    expect(printed.stdout).toContain("VITEST_LOG verdict=RPC_ONLY reason=none");
    // built-cli's 4 files never started: the other three single-fork projects collected their 6, and the
    // same printed record does not start it
    for (const output of ["", printedLabel]) {
      const noBuiltCli = await ci(singleForkForm, 6, 1, WRAPPER, 6, output);
      expect(noBuiltCli.status, noBuiltCli.stdout).toBe(1);
      expect(noBuiltCli.stdout).toContain("run-ci-vitest: declared contract: 10 files across sync-heavy,keys-ledger,built-cli,signal-reaper");
      expect(noBuiltCli.stdout).toContain("run-ci-vitest: exit 1 kept: VITEST_LOG verdict=RED reason=partial");
    }

    // the derived contract is what holds the line: the same wrapper without it launders seven of ten
    const blind = join(tree, ".blind");
    mkdirSync(join(blind, "scripts"), { recursive: true });
    mkdirSync(join(blind, "skills/tickmarkr-overseer/scripts"), { recursive: true });
    const source = readFileSync(WRAPPER, "utf8");
    const contractBlind = source.replace(' ${contract[@]+"${contract[@]}"}', "");
    expect(contractBlind).not.toBe(source);
    writeFileSync(join(blind, "scripts/run-ci-vitest.sh"), contractBlind);
    copyFileSync(CLASSIFIER, join(blind, "skills/tickmarkr-overseer/scripts/classify-vitest-log.sh"));
    expect((await ci(singleForkForm, 7, 1, join(blind, "scripts/run-ci-vitest.sh"))).status).toBe(0);

    // a declared project the candidate tree's discovery cannot find keeps the raw 1 (fail closed)
    rmSync(join(tree, "tests/built-cli"), { recursive: true });
    const undiscovered = await ci(singleForkForm, 10, 1);
    expect(undiscovered.status).toBe(1);
    expect(undiscovered.stdout).toContain("run-ci-vitest: exit 1 kept: candidate-tree discovery failed");
  });

  test.skipIf(!existsSync(TWIN_DIR))("the canonical and installed graders are byte-identical executable files (skipped on the exported tree: .claude/skills is absent)", async () => {
    const fs = await import("node:fs");
    for (const script of [SCRIPT, CLASSIFIER]) {
      const twin = join(TWIN_DIR, script.split("/").pop()!);
      expect(fs.readFileSync(twin), twin).toEqual(fs.readFileSync(script));
      expect(fs.statSync(script).mode & 0o111).not.toBe(0);
      expect(fs.statSync(twin).mode & 0o111).not.toBe(0);
    }
  });
});
