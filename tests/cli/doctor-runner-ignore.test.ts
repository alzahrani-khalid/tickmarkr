import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runnerIgnoreFinding } from "../../src/cli/commands/doctor.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Q122s (TRIAL T-OBS-3): a repo-wide-collecting runner scans .tickmarkr/ worktrees —
// SentioQ run-1's baseline/tip red. Doctor names the exact remedy line.
function repo(files: Record<string, string>): string {
  const dir = makeTestTempDir("tickmarkr-doctor-");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("the SentioQ shape: jest with **/ testMatch and no ignore → warn naming the config line", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.(ts|tsx)"] };`,
  });
  const f = runnerIgnoreFinding(dir);
  expect(f?.verdict).toBe("warn");
  expect(f?.detail).toContain('add "/.tickmarkr/" to testPathIgnorePatterns in jest.config.js');
});

describe("doctor test-runner ignore check (Q122s)", () => {

  test("jest with the ignore in place → pass", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "/.tickmarkr/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("vitest with rooted includes (this repo's own shape) → pass, no false warn", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.ts": `export default { test: { include: ["tests/**/*.test.ts"] } };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("vitest with NO config file → defaults are repo-wide → warn", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const f = runnerIgnoreFinding(dir);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain("test.exclude");
  });

  test("no recognized runner → no row", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }) });
    expect(runnerIgnoreFinding(dir)).toBeUndefined();
  });
});
