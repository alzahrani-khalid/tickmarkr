import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyRunnerIgnore, packageManagerFinding, runnerIgnoreFinding } from "../../src/cli/commands/doctor.js";
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

  test("vitest whose glob strings form /* and */ pairs (the Intl-Dossier shape) still warns — comment stripping must not eat globs", () => {
    // Regression: 1.90.1's in-line comment-strip regex matched `/*` inside '**/*.d.ts'
    // and deleted through the next `*/`, erasing the repo-wide include evidence and
    // FALSE-PASSING the config as "rooted".
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "turbo run test" } }),
      "vitest.config.ts": [
        `export default {`,
        `  test: {`,
        `    coverage: { exclude: ['node_modules/', '**/*.d.ts', '**/*.spec.ts', '**/tests/**'] },`,
        `    include: ['**/*.{test,spec}.{js,ts,tsx}'],`,
        `    exclude: ['node_modules', 'dist', '.turbo'],`,
        `  },`,
        `};`,
      ].join("\n"),
    });
    const f = runnerIgnoreFinding(dir);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain('add ".tickmarkr/**" to test.exclude');
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

// Q134s: doctor --fix — the WRITE half. Every write is verified by re-running the
// finding; a write that does not turn the row green is reverted (never a half-fix).
describe("doctor --fix runner-ignore writer (Q134s)", () => {

  test("vitest, the Intl-Dossier shape: two exclude arrays (coverage + test) → wrote, finding passes", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "turbo run test" } }),
      "vitest.config.ts": [
        `import { defineConfig } from 'vitest/config';`,
        `export default defineConfig({`,
        `  test: {`,
        `    coverage: { exclude: ['node_modules/', 'dist/'] },`,
        `    include: ['**/*.{test,spec}.ts'],`,
        `    exclude: ['node_modules', 'dist', '.turbo'],`,
        `  },`,
        `});`,
      ].join("\n"),
    });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("wrote");
    const text = readFileSync(join(dir, "vitest.config.ts"), "utf8");
    expect(text.match(/'\.tickmarkr\/\*\*'/g)?.length).toBe(2);
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest, the SentioQ run-2 poison shape: unanchored entry → wrote, anchored in place", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "/.tickmarkr/"] };`,
    });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("wrote");
    const text = readFileSync(join(dir, "jest.config.js"), "utf8");
    expect(text).toContain('"<rootDir>/\\\\.tickmarkr/"');
    expect(text).not.toContain('"/.tickmarkr/"');
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest with an ignore array lacking tickmarkr → anchored entry prepended", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.ts"], testPathIgnorePatterns: ["/node_modules/"] };`,
    });
    expect(applyRunnerIgnore(dir).action).toBe("wrote");
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest testMatch-only config (no ignore array) → property added preserving /node_modules/", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.ts"] };`,
    });
    expect(applyRunnerIgnore(dir).action).toBe("wrote");
    const text = readFileSync(join(dir, "jest.config.js"), "utf8");
    expect(text).toContain('"/node_modules/"');
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest config only in the package.json block → manual, package.json untouched", () => {
    const pkg = JSON.stringify({ scripts: { test: "jest" }, jest: { testMatch: ["**/*.test.ts"] } });
    const dir = repo({ "package.json": pkg });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("manual");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(pkg);
  });

  test("already green → none, file untouched (idempotent)", () => {
    const cfg = `module.exports = { testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/"] };`;
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": cfg,
    });
    expect(applyRunnerIgnore(dir).action).toBe("none");
    expect(readFileSync(join(dir, "jest.config.js"), "utf8")).toBe(cfg);
  });

  test("unwritable shape (vitest config with no exclude array) → manual, file byte-identical", () => {
    const cfg = `export default { test: { include: ["**/*.test.ts"] } };`;
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.ts": cfg,
    });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("manual");
    expect(readFileSync(join(dir, "vitest.config.ts"), "utf8")).toBe(cfg);
  });
});

// Q140s(b) / D-OBS-10: the repo's package manager must resolve where gates spawn.
describe("doctor package-manager preflight", () => {
  test("detected pnpm missing from the environment → FAIL naming the fix", () => {
    const dir = repo({ "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }), "pnpm-lock.yaml": "" });
    const f = packageManagerFinding(dir, () => false);
    expect(f?.verdict).toBe("fail");
    expect(f?.detail).toContain("pnpm");
    expect(f?.detail).toContain("corepack enable");
  });

  test("resolvable manager → pass naming it", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
    const f = packageManagerFinding(dir, () => true);
    expect(f?.verdict).toBe("pass");
    expect(f?.detail).toContain("npm");
  });

  test("no package.json → no row", () => {
    const dir = repo({ "readme.md": "x" });
    expect(packageManagerFinding(dir, () => true)).toBeUndefined();
  });
});
