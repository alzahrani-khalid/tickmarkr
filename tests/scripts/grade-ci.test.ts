import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
const CLASSIFIER = join(ROOT, "skills/tickmarkr-overseer/scripts/classify-vitest-log.sh");
const WRAPPER = join(ROOT, "scripts/run-ci-vitest.sh");
const TWIN_DIR = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts");
const cleanup: string[] = [];

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
  printf '101\\ttest\\tcompleted\\t%s\\n102\\ttest-macos\\tcompleted\\t%s\\n' "\${GH_CONCLUSION:-success}" "\${GH_CONCLUSION:-success}"
  exit 0
fi
if [[ " $* " == *" --log "* ]]; then
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

  // the grader over one gh job log (both jobs read the same fixture)
  const grade = (expected: number, log: string | undefined, tag: string, conclusion = "success") => spawnSync(
    "bash",
    [SCRIPT, "12345", String(expected), `${tag}-${expected}`],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_CONCLUSION: conclusion,
        GH_LOG_FILE: log === undefined ? "" : write(log),
        PATH: `${bin}:${process.env.PATH}`,
        TKR_GRADE_CI_DIR: logs,
      },
    },
  );
  const run = (expected: number, mode: keyof typeof LOGS) => grade(expected, LOGS[mode], mode);
  // the public CI wrapper over a stand-in Vitest command that prints the raw log and exits `status`
  const wrap = (log: string, status: number) => spawnSync(
    "bash",
    [WRAPPER, join(root, `ci-${n++}.log`), "bash", "-c", 'cat "$1"; exit "$2"', "fake-vitest", write(log), String(status)],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { run, grade, wrap };
}

describe("grade-ci.sh job-log controls", () => {
  test("test: grade-ci.sh reads UNREADABLE and exits 2 for a job whose log is empty and GREEN for a log carrying the count oracle at the expected count with zero failed and RED for the same log at a different expected count whereas a grader that reads an empty log as green fails", () => {
    const { run } = fixture();

    const empty = run(10, "empty");
    expect(empty.status).toBe(2);
    expect(empty.stdout).toContain("test: UNREADABLE (empty log)");
    expect(empty.stdout).not.toContain("test: GREEN");

    const green = run(10, "green");
    expect(green.status).toBe(0);
    expect(green.stdout).toContain("test: GREEN");
    expect(green.stdout).toContain("test-macos: GREEN");
    expect(green.stdout).toContain("failed=0");

    const red = run(11, "green");
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("test: RED");
    expect(red.stdout).not.toContain("test: GREEN");
  });

  test("test: grade-ci over a fixture job log whose count oracle is green beside a vitest unhandled-errors block prints the unhandled count on the job's line and grades the job RED, while the same log without the block grades GREEN, so a grader blind to unhandled errors fails", () => {
    const { run } = fixture();

    const unhandled = run(10, "unhandled");
    expect(unhandled.status).toBe(1);
    expect(unhandled.stdout).toMatch(/^test: oracle=\[COUNT_ORACLE GREEN expected=10 actual=10\].* unhandled=2 /m);
    expect(unhandled.stdout).toContain("test: RED");
    expect(unhandled.stdout).not.toContain("test: GREEN");

    const green = run(10, "green");
    expect(green.status).toBe(0);
    expect(green.stdout).toMatch(/^test: oracle=.* unhandled=0 /m);
    expect(green.stdout).toContain("test: GREEN");
  });

  test("test: grade-ci over a fixture job log whose only unhandled error is a vitest-worker RPC timeout grades the job GREEN and names the timeout on its own field, while a log carrying that timeout beside any other unhandled error grades RED and neither a stray timeout diagnostic outside the unhandled block nor a timeout line shadowing a real error's payload under one header nor a prose line that merely contains the header's words nor an assertion whose payload quotes the timeout text nor a header and timeout printed to stdout outside Vitest's own block — before it, or after a styled file summary in gh's ^[ rendering — offsets that error, so a grader that reds the starved runner's own noise, or one that lets a real unhandled error hide behind it, fails", () => {
    const { run } = fixture();
    const rpc = run(10, "rpc");
    expect(rpc.status).toBe(0);
    expect(rpc.stdout).toMatch(/^test: oracle=.* unhandled=0 runner_rpc_timeouts=1 /m);
    expect(rpc.stdout).toContain("test: GREEN");
    const mixed = run(10, "rpc-mixed");
    expect(mixed.status).toBe(1);
    expect(mixed.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=1 /m);
    expect(mixed.stdout).toContain("test: RED");
    for (const mode of ["rpc-stray", "rpc-shadow", "rpc-prose", "rpc-quoted", "rpc-forged", "rpc-styled"] as const) {
      const red = run(10, mode);
      expect(red.status, mode).toBe(1);
      expect(red.stdout, mode).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
      expect(red.stdout, mode).toContain("test: RED");
    }
  });

  test("test: the public CI wrapper and grader agree on complete RPC-only green versus mixed unhandled errors coverage threshold misses failed or timed-out tests and truncated logs, so one red fixture classified green fails", () => {
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
      const ci = wrap(log, status);
      // the job log CI produces for that raw outcome: the step's own exit annotation and conclusion
      const job = ghJobLog(log + (status ? `##[error]Process completed with exit code ${status}.\n` : "")) + "\n" + ORACLE;
      const graded = grade(10, job, "agree", status ? "failure" : "success");
      expect(ci.status === 0, `${name}: wrapper exit ${ci.status}\n${ci.stdout}`).toBe(green);
      if (!green && status !== 1) expect(ci.status, name).toBe(status);
      expect(graded.status === 0, `${name}: grader exit ${graded.status}\n${graded.stdout}`).toBe(green);
      expect(graded.stdout, name).toMatch(green ? /^test: GREEN$/m : /^test: (RED|UNREADABLE)$/m);
      if (!green) expect(graded.stdout, name).not.toContain("test: GREEN");
    }

    // a cancelled job, or a failure no step exit explains, never grades GREEN
    for (const conclusion of ["cancelled", "failure"]) {
      const graded = grade(10, ghJobLog(summary()) + "\n" + ORACLE, "concl", conclusion);
      expect(graded.status, conclusion).toBe(1);
      expect(graded.stdout, conclusion).toContain("test: RED");
    }
    const accepted = wrap(rpcOnly, 1);
    expect(accepted.stdout).toContain("VITEST_LOG verdict=RPC_ONLY");
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
