import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/cli/commands/compile.js";
import { graphPath, loadGraph } from "../../src/graph/graph.js";
import { acquireRunLock, isRunLockLive, releaseRunLock } from "../../src/run/lock.js";
import { makeRepo } from "../helpers/tmprepo.js";

const VALID_SPEC = `# Dry compile fixture

## T1: Update widget behavior
- goal: Keep the widget behavior observable.
- shape: implement
- complexity: 3
- files: src/widget.ts
- acceptance:
  - widgetValue remains observable through sharedHelper
  - tests cover the widget behavior
`;

const INVALID_SPEC = `# Invalid dry compile fixture

## T1: One task beyond several compile bounds
- goal: Split this task before a worker receives it.
- shape: implement
- complexity: 3
- files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts, src/h.ts, src/i.ts
- acceptance:
  - criterion one
  - criterion two
  - criterion three
  - criterion four
  - criterion five
  - criterion six
  - criterion seven
`;

function compileRepo(spec = VALID_SPEC): string {
  return makeRepo({
    "feature.prd.md": spec,
    "src/widget.ts": "export const widgetValue = () => sharedHelper();\n",
    "src/helper-a.ts": "export const sharedHelper = () => 'a';\n",
    "src/helper-b.ts": "export const sharedHelper = () => 'b';\n",
    "tests/widget.test.ts": "import { widgetValue } from '../src/widget.js';\nvoid widgetValue;\n",
  });
}

function taskCount(output: string): string {
  return output.match(/\((\d+) tasks,/)?.[1] ?? "missing task count";
}

function diagnostics(output: string): string[] {
  const marker = "\nscope lints:\n";
  const start = output.indexOf(marker);
  return start === -1 ? [] : output.slice(start + marker.length).split("\n");
}

async function failure(argv: string[], repo: string): Promise<string> {
  try {
    await compile(argv, repo);
    return "compile unexpectedly succeeded";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("compile --dry-run", () => {
  test("a dry compile of a valid spec reports the same task count and the same diagnostics as a real compile of that spec, with the graph file byte-identical before and after", async () => {
    const repo = compileRepo();
    const real = await compile(["feature.prd.md"], repo);
    const before = readFileSync(graphPath(repo));

    const dry = await compile(["feature.prd.md", "--dry-run"], repo);
    const after = readFileSync(graphPath(repo));

    expect(taskCount(dry)).toBe(taskCount(real));
    expect(diagnostics(dry)).toEqual(diagnostics(real));
    expect(diagnostics(dry)).toEqual(expect.arrayContaining([
      expect.stringContaining("likely collateral tests not in files[]: tests/widget.test.ts"),
      expect.stringContaining("criteria implicate out-of-scope source not in files[]: src/helper-a.ts, src/helper-b.ts"),
    ]));
    expect(after.equals(before)).toBe(true);
  });

  test("a dry compile of a spec that violates a compile bound reports the same violations a real compile reports, and still writes nothing", async () => {
    const repo = compileRepo();
    await compile(["feature.prd.md"], repo);
    const before = readFileSync(graphPath(repo));
    writeFileSync(join(repo, "invalid.prd.md"), INVALID_SPEC);

    const dryError = await failure(["invalid.prd.md", "--dry-run"], repo);
    const afterDry = readFileSync(graphPath(repo));
    const realError = await failure(["invalid.prd.md"], repo);

    expect(dryError).toBe(realError);
    expect(dryError).toContain("violates the task unit contract (3 errors)");
    expect(dryError).toContain("declares 7 acceptance items (max 6)");
    expect(dryError).toContain("declares 9 files[] patterns (max 8)");
    expect(dryError).toContain("acceptance×files surface of 63");
    expect(afterDry.equals(before)).toBe(true);
  });

  test("a dry compile completes while the run lock is held, proving a live run no longer makes spec validation impossible", async () => {
    const repo = compileRepo();
    acquireRunLock(repo, "run-live");
    try {
      expect(isRunLockLive(repo)).toBe(true);
      const output = await compile(["feature.prd.md", "--dry-run"], repo);
      expect(output).toContain("(1 tasks,");
      expect(isRunLockLive(repo)).toBe(true);
      expect(existsSync(graphPath(repo))).toBe(false);
    } finally {
      releaseRunLock(repo);
    }
  });

  test("a compile without the flag still writes the graph and still takes the lock, so the default path is unweakened", async () => {
    const repo = compileRepo();
    acquireRunLock(repo, "run-live");
    try {
      await expect(compile(["feature.prd.md"], repo)).rejects.toThrow(/graph\.lock held by pid/);
      expect(existsSync(graphPath(repo))).toBe(false);
    } finally {
      releaseRunLock(repo);
    }

    await compile(["feature.prd.md"], repo);
    expect(loadGraph(repo).tasks).toHaveLength(1);
  });
});
