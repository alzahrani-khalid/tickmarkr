import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const codebaseDocs = join(repoRoot, "docs", "codebase");

// All files cited in TESTING and CLI-DESIGN docs. These must exist in the tree.
const TESTING_CITED_FILES = [
  // TESTING.md citations
  "vitest.config.ts",
  "src/adapters/fake.ts",
  "src/gates/baseline.ts",
  "src/run/daemon.ts",
  "tests/adapters/fake.test.ts",
  "tests/adapters/prompt.test.ts",
  "tests/adapters/real-adapters.test.ts",
  "tests/compile/gsd.test.ts",
  "tests/compile/prd.test.ts",
  "tests/compile/speckit.test.ts",
  "tests/config/config.test.ts",
  "tests/drivers/herdr.test.ts",
  "tests/drivers/subprocess.test.ts",
  "tests/e2e/real-cli.test.ts",
  "tests/gates/baseline.test.ts",
  "tests/gates/acceptance.test.ts",
  "tests/gates/evidence-scope.test.ts",
  "tests/gates/review.test.ts",
  "tests/gates/via-driver.test.ts",
  "tests/graph/graph.test.ts",
  "tests/graph/schema.test.ts",
  "tests/helpers/tmprepo.ts",
  "tests/route/router.test.ts",
  "tests/run/consult.test.ts",
  "tests/run/daemon.test.ts",
  "tests/run/daemon-interactive.test.ts",
  "tests/run/git.test.ts",
  "tests/run/journal.test.ts",
  "tests/run/merge.test.ts",
  "tests/smoke.test.ts",
  "package.json",
];

const DESIGN_CITED_FILES = [
  // CLI-DESIGN.md citations
  "src/brand.ts",
];

function countTestFiles(dir: string): number {
  return readdirSync(dir).filter((f) => f.endsWith(".test.ts")).length;
}

/** Parse vitest.config.ts coverage.include globs → top-level src/ directory names. */
function gatedSrcDirsFromVitestConfig(vitestSource: string): string[] {
  const coverageBlock = vitestSource.match(/coverage:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  const includeBlock = coverageBlock.match(/include:\s*\[([\s\S]*?)\],/)?.[1] ?? "";
  return [...includeBlock.matchAll(/"src\/([^/]+)\/\*\*"/g)].map((m) => m[1]).sort();
}

describe.skipIf(!existsSync(codebaseDocs))("docs-truth-testing", () => {
  test("test: every source file cited on the testing and cli design pages exists in the tree", () => {
    const allCited = [...TESTING_CITED_FILES, ...DESIGN_CITED_FILES];
    const missing: string[] = [];
    for (const file of allCited) {
      if (!existsSync(join(repoRoot, file))) {
        missing.push(file);
      }
    }
    expect(missing).toStrictEqual([]);
  });

  test("test: the testing and cli design pages carry no stopgap banner", () => {
    for (const file of ["TESTING.md", "CLI-DESIGN.md"]) {
      const path = join(codebaseDocs, file);
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/^> \*\*STOPGAP:/, `${file} should not carry stopgap banner`);
    }
  });

  test("test: the testing page does not contradict the test scripts and configuration", () => {
    const testingPath = join(codebaseDocs, "TESTING.md");
    const vitestPath = join(repoRoot, "vitest.config.ts");
    const pkgPath = join(repoRoot, "package.json");
    const testing = readFileSync(testingPath, "utf8");
    const vitest = readFileSync(vitestPath, "utf8");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    // npm scripts must match package.json
    expect(testing).toContain("npm test");
    expect(testing).toContain("npm run test:coverage");
    expect(testing).toContain("npm run e2e");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:coverage"]).toBe("vitest run --coverage");
    expect(pkg.scripts.e2e).toBe("TICKMARKR_E2E=1 vitest run tests/e2e --testTimeout 900000");

    // vitest config contract
    expect(testing).toContain("vitest.config.ts");
    expect(vitest).toContain('include: ["tests/**/*.test.ts"]');
    expect(vitest).toContain('setupFiles: ["tests/setup.ts"]');
    expect(testing).toContain("tests/setup.ts");
    expect(testing).toContain("setupFiles");

    // coverage thresholds match vitest.config.ts
    expect(testing).toContain('"src/{graph,route,gates,run}/**": { lines: 80, functions: 80, branches: 70 }');
    expect(vitest).toContain('"src/{graph,route,gates,run}/**": { lines: 80, functions: 80, branches: 70 }');

    // coverage include count derived from vitest.config.ts — plan/ and report/ are un-gated exceptions
    const gatedDirs = gatedSrcDirsFromVitestConfig(vitest);
    expect(gatedDirs.length).toBeGreaterThan(0);
    const countLabels = [String(gatedDirs.length), ...(gatedDirs.length === 9 ? ["nine"] : [])];
    expect(countLabels.some((n) => testing.includes(`gates ${n} of them`))).toBe(true);
    for (const dir of gatedDirs) {
      expect(testing).toContain(dir);
    }
    expect(testing).toContain("src/plan/");
    expect(testing).toContain("src/report/");
    expect(testing).toMatch(/not in the coverage include/i);
    expect(testing).not.toMatch(/All nine `src\/` directories are coverage-gated/);
    expect(testing).not.toMatch(/Every `src\/` change is coverage-gated independently/);

    // must not carry disproven blanket denials
    expect(testing).not.toMatch(/zero occurrences of `vi\.fn`/);
    expect(testing).not.toMatch(/No `beforeEach`\/`afterEach`\/`beforeAll`\/`afterAll` anywhere/);
    expect(testing).not.toMatch(/the only non-`\*\.test\.ts` file under `tests\/`/);

    // must acknowledge actual vi.* and hook usage where it exists
    expect(testing).toMatch(/vi\.(fn|mock|spyOn)/);
    expect(testing).toMatch(/beforeEach|afterEach/);

    // structure diagram counts must match the tree
    const dirs = ["adapters", "cli", "compile", "config", "drivers", "gates", "graph", "hygiene", "plan", "repo", "report", "route", "run"] as const;
    for (const dir of dirs) {
      const n = countTestFiles(join(repoRoot, "tests", dir));
      expect(testing).toContain(`${n} *.test.ts`);
    }
    expect(testing).toContain("brand.test.ts");
    expect(testing).toContain("smoke.test.ts");

    // non-test.ts infrastructure files documented
    expect(testing).toContain("setup.ts");
    expect(testing).toContain("tmprepo.ts");
    expect(testing).toContain("codex-mcp-spinner/capture.ts");
    for (const infra of ["tests/setup.ts", "tests/helpers/tmprepo.ts", "tests/fixtures/codex-mcp-spinner/capture.ts"]) {
      expect(existsSync(join(repoRoot, infra))).toBe(true);
    }

    // test types section present
    expect(testing).toContain("Unit tests");
    expect(testing).toContain("Integration tests");
    expect(testing).toContain("E2E tests");
  });

  test("test: the cli design page does not contradict the brand module design contract", () => {
    const designPath = join(codebaseDocs, "CLI-DESIGN.md");
    const brandPath = join(repoRoot, "src/brand.ts");
    const design = readFileSync(designPath, "utf8");
    const brand = readFileSync(brandPath, "utf8");

    // Verify src/brand.ts is mentioned
    expect(design).toContain("src/brand.ts");

    // Verify tokens section and all token names
    expect(design).toContain("`brand`");
    expect(design).toContain("`ok`");
    expect(design).toContain("`fail`");
    expect(design).toContain("`warn`");
    expect(design).toContain("`dim`");
    expect(design).toContain("`bold`");

    // Verify glyphs section and all glyph names
    expect(design).toContain("`pointer`");
    expect(design).toContain("`toggleActive`");
    expect(design).toContain("`toggleInactive`");
    expect(design).toContain("`pass`");
    expect(design).toContain("`fail`");
    expect(design).toContain("`attention`");
    expect(design).toContain("`neutral`");

    // Verify helpers are documented
    expect(design).toContain("`toggleActive()`");
    expect(design).toContain("`toggleInactive()`");
    expect(design).toContain("`title`");
    expect(design).toContain("`legend`");
    expect(design).toContain("`rule`");
    expect(design).toContain("`kvRow`");
    expect(design).toContain("`statusRow`");

    // Verify design mandates are documented
    expect(design).toMatch(/brand\s+tickmark/i);
    expect(design).toMatch(/dim circle/i);
    expect(design).toMatch(/Bracket toggle glyphs .* forbidden/i);
    expect(design).toMatch(/glyph-first/i);
    expect(design).toMatch(/Color is meaning, never decoration/i);
    expect(design).toMatch(/never the only signal/i);

    // Verify brand.ts exports these
    expect(brand).toContain("export const TOKENS");
    expect(brand).toContain("export const GLYPHS");
    expect(brand).toContain("export const toggleActive");
    expect(brand).toContain("export const toggleInactive");
    expect(brand).toContain("export const title");
    expect(brand).toContain("export const legend");
    expect(brand).toContain("export const rule");
    expect(brand).toContain("export const kvRow");
    expect(brand).toContain("export const statusRow");

    // BRAND_RAMP anchor matches source
    expect(design).toContain("[84, 78, 41, 35]");
    expect(brand).toContain("BRAND_RAMP");
    expect(brand).toMatch(/\[84,\s*78,\s*41,\s*35\]/);
  });
});
