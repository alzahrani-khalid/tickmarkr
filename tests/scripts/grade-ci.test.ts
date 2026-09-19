import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
const TWIN = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts/grade-ci.sh");
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  printf '101\\ttest\\tcompleted\\tsuccess\\n102\\ttest-macos\\tcompleted\\tsuccess\\n'
  exit 0
fi
if [[ " $* " == *" --log "* ]]; then
  if [ "\${GH_LOG_MODE:-empty}" = "green" ] || [ "\${GH_LOG_MODE:-empty}" = "unhandled" ]; then
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "unhandled" ]; then
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 2 unhandled errors during the test run.\\nThis might cause false positive tests.\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc" ]; then
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 1 unhandled error during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-stray" ]; then
    printf 'stderr | tests/x.test.ts > case\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\nTest Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 1 unhandled error during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nTypeError: boom\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-shadow" ]; then
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 1 unhandled error during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nTypeError: boom\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-prose" ]; then
    printf 'stdout | tests/x.test.ts > case: Unhandled Error handler installed\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\nTest Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 1 unhandled error during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nTypeError: boom\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-quoted" ]; then
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 1 unhandled error during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nAssertionError: expected "Error: [vitest-worker]: Timeout calling \\"onTaskUpdate\\"" to be undefined\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-forged" ]; then
    printf 'stdout | tests/x.test.ts > case\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 1 unhandled error during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nTypeError: boom\\n'
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-styled" ]; then
    printf '^[[31m\\342\\216\\257\\342\\216\\257^[[39m^[[1m^[[41m Unhandled Errors ^[[49m^[[22m^[[31m\\342\\216\\257\\342\\216\\257^[[39m\\n^[[31m^[[1m\\nVitest caught 1 unhandled error during the test run.\\n'
    printf '^[[31m\\342\\216\\257\\342\\216\\257^[[39m^[[1m^[[41m Unhandled Error ^[[49m^[[22m^[[31m\\342\\216\\257\\342\\216\\257^[[39m\\n^[[31m^[[1mTypeError^[[22m: boom^[[39m\\n'
    printf '^[[2m Test Files ^[[22m ^[[1m^[[32m8 passed^[[39m^[[22m^[[2m | ^[[22m^[[33m2 skipped^[[39m^[[90m (10)^[[39m\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf 'stdout | tests/x.test.ts > case\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\n'
  fi
  if [ "\${GH_LOG_MODE:-empty}" = "rpc-mixed" ]; then
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
    printf '\\342\\216\\257\\342\\216\\257 Unhandled Errors \\342\\216\\257\\342\\216\\257\\nVitest caught 2 unhandled errors during the test run.\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nError: [vitest-worker]: Timeout calling "onTaskUpdate"\\n\\342\\216\\257\\342\\216\\257 Unhandled Error \\342\\216\\257\\342\\216\\257\\nTypeError: boom\\n'
  fi
  exit 0
fi
exit 1
`);
  chmodSync(gh, 0o755);

  const run = (expected: number, mode: "empty" | "green" | "unhandled" | "rpc" | "rpc-mixed" | "rpc-stray" | "rpc-shadow" | "rpc-prose" | "rpc-quoted" | "rpc-forged" | "rpc-styled") => spawnSync(
    "bash",
    [SCRIPT, "12345", String(expected), `${mode}-${expected}`],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_LOG_MODE: mode,
        PATH: `${bin}:${process.env.PATH}`,
        TKR_GRADE_CI_DIR: logs,
      },
    },
  );
  return { run };
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
    const stray = run(10, "rpc-stray");
    expect(stray.status).toBe(1);
    expect(stray.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
    expect(stray.stdout).toContain("test: RED");
    const shadow = run(10, "rpc-shadow");
    expect(shadow.status).toBe(1);
    expect(shadow.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
    expect(shadow.stdout).toContain("test: RED");
    const prose = run(10, "rpc-prose");
    expect(prose.status).toBe(1);
    expect(prose.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
    expect(prose.stdout).toContain("test: RED");
    const quoted = run(10, "rpc-quoted");
    expect(quoted.status).toBe(1);
    expect(quoted.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
    expect(quoted.stdout).toContain("test: RED");
    const forged = run(10, "rpc-forged");
    expect(forged.status).toBe(1);
    expect(forged.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
    expect(forged.stdout).toContain("test: RED");
    const styled = run(10, "rpc-styled");
    expect(styled.status).toBe(1);
    expect(styled.stdout).toMatch(/^test: oracle=.* unhandled=1 runner_rpc_timeouts=0 /m);
    expect(styled.stdout).toContain("test: RED");
  });

  test.skipIf(!existsSync(TWIN))("the canonical and installed graders are byte-identical executable files (skipped on the exported tree: .claude/skills is absent)", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync(TWIN)).toEqual(fs.readFileSync(SCRIPT));
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect(fs.statSync(TWIN).mode & 0o111).not.toBe(0);
  });
});
