import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { runSelfcheck } from "../../src/eval/selfcheck.js";
import type { Fixture } from "../../src/eval/fixtures.js";

function tempFixture(opts: {
  startText: string;
  solutionText: string;
  command?: string;
}): { fixture: Fixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-selfcheck-"));
  const name = "demo";
  const dir = join(root, name);
  const startDir = join(dir, "start");
  const solutionDir = join(dir, "solution");
  mkdirSync(startDir, { recursive: true });
  mkdirSync(solutionDir, { recursive: true });
  writeFileSync(join(startDir, "a.txt"), opts.startText);
  writeFileSync(join(solutionDir, "a.txt"), opts.solutionText);

  const spec = `<!-- tickmarkr:spec -->
# Demo fixture

## T1: Expected content
- goal: a.txt contains the expected text
- shape: implement
- acceptance:
  - command: ${opts.command ?? '[ "$(cat a.txt)" = "expected" ]'}
`;
  writeFileSync(join(dir, "spec.md"), spec);

  return {
    fixture: {
      id: name,
      path: dir,
      startDir,
      solutionDir,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("fixture selfcheck", () => {
  test("running the selfcheck against a fixture's starting tree records a failing result on that fixture's own acceptance check", async () => {
    const { fixture, cleanup } = tempFixture({
      startText: "start",
      solutionText: "expected",
      command: '[ "$(cat a.txt)" = "expected" ]',
    });
    const result = await runSelfcheck(fixture);
    expect(result.start.pass).toBe(false);
    expect(result.start.details).toContain("oracle failed");
    expect(result.valid).toBe(true);
    cleanup();
  });

  test("running the selfcheck against a fixture's reference tree records a passing result on the same acceptance check", async () => {
    const { fixture, cleanup } = tempFixture({
      startText: "start",
      solutionText: "expected",
      command: '[ "$(cat a.txt)" = "expected" ]',
    });
    const result = await runSelfcheck(fixture);
    expect(result.solution.pass).toBe(true);
    expect(result.solution.details).toContain("exit 0");
    expect(result.valid).toBe(true);
    cleanup();
  });

  test("a fixture whose starting tree already passes is reported as an invalid fixture rather than silently accepted", async () => {
    const { fixture, cleanup } = tempFixture({
      startText: "expected",
      solutionText: "expected",
      command: '[ "$(cat a.txt)" = "expected" ]',
    });
    const result = await runSelfcheck(fixture);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/starting tree already passes/);
    cleanup();
  });

  test("a fixture whose reference tree still fails is reported as an invalid fixture rather than silently accepted", async () => {
    const { fixture, cleanup } = tempFixture({
      startText: "start",
      solutionText: "start",
      command: '[ "$(cat a.txt)" = "expected" ]',
    });
    const result = await runSelfcheck(fixture);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/reference tree still fails/);
    cleanup();
  });
});
