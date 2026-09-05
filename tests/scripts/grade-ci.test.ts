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
  if [ "\${GH_LOG_MODE:-empty}" = "green" ]; then
    printf 'Test Files  8 passed | 2 skipped (10)\\nCOUNT_ORACLE GREEN expected=10 actual=10\\n'
  fi
  exit 0
fi
exit 1
`);
  chmodSync(gh, 0o755);

  const run = (expected: number, mode: "empty" | "green") => spawnSync(
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

  test.skipIf(!existsSync(TWIN))("the canonical and installed graders are byte-identical executable files (skipped on the exported tree: .claude/skills is absent)", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync(TWIN)).toEqual(fs.readFileSync(SCRIPT));
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect(fs.statSync(TWIN).mode & 0o111).not.toBe(0);
  });
});
