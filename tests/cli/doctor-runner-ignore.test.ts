import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runnerIgnoreFinding } from "../../src/cli/commands/doctor.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Q122s (TRIAL T-OBS-3): a repo-wide-collecting runner scans .tickmarkr/ worktrees —
// SentioQ run-1's baseline/tip red. Doctor names the exact remedy line.
// Q130s (TRIAL T-OBS-6): the remedy MUST be <rootDir>-anchored — the unanchored shape
// self-matches inside provisioned worktrees and fails every gate battery closed
// (SentioQ run 2: 10 dispatches, 0 merges, one defect).
function repo(files: Record<string, string>): string {
  const dir = makeTestTempDir("tickmarkr-doctor-");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("the SentioQ shape: jest with **/ testMatch and no ignore → warn naming the anchored config line", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.(ts|tsx)"] };`,
  });
  const f = runnerIgnoreFinding(dir);
  expect(f?.verdict).toBe("warn");
  expect(f?.detail).toContain('add "<rootDir>/\\\\.tickmarkr/" to testPathIgnorePatterns in jest.config.js');
});

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("the SentioQ run-2 shape: jest with an UNANCHORED .tickmarkr ignore → warn, self-matches inside worktrees", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "/.tickmarkr/"] };`,
  });
  const f = runnerIgnoreFinding(dir);
  expect(f?.verdict).toBe("warn");
  expect(f?.detail).toContain("not <rootDir>-anchored");
  expect(f?.detail).toContain('"<rootDir>/\\\\.tickmarkr/"');
});

describe("doctor test-runner ignore check (Q122s + Q130s anchor probe)", () => {

  test("jest with the <rootDir>-anchored ignore (escaped dot) → pass", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "<rootDir>/\\\\.tickmarkr/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest with the <rootDir>-anchored ignore (plain dot) → pass", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["<rootDir>/.tickmarkr/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest with an anchored FULL worktree path → pass, no false warn on the tail", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["<rootDir>/.tickmarkr/worktrees.noindex/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest unanchored worktrees.noindex ignore → warn, same self-match class", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/worktrees.noindex/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("warn");
  });

  test("vitest exclude mentioning .tickmarkr → pass (root-relative globs cannot self-match)", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.ts": `export default { test: { include: ["**/*.test.ts"], exclude: [".tickmarkr/**"] } };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest anchored ignore with prose comments mentioning .tickmarkr → pass, comments stripped", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": [
        `// /.tickmarkr/ — tickmarkr provisions run worktrees INSIDE the repo`,
        `// (.tickmarkr/worktrees.noindex/): keep them out of the suite`,
        `module.exports = { testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/"] };`,
      ].join("\n"),
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest ignore that is commented OUT → warn, not a false pass", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": [
        `module.exports = { testMatch: ["**/__tests__/**/*.test.ts"] };`,
        `// testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/"]`,
      ].join("\n"),
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("warn");
  });

  test("vitest with rooted includes (this repo's own shape) → pass, no false warn", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.ts": `export default { test: { include: ["tests/**/*.test.ts"] } };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("vitest with NO config file → defaults are repo-wide → warn with root-anchored remedy", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const f = runnerIgnoreFinding(dir);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain('add ".tickmarkr/**" to test.exclude');
  });

  test("no recognized runner → no row", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }) });
    expect(runnerIgnoreFinding(dir)).toBeUndefined();
  });
});
