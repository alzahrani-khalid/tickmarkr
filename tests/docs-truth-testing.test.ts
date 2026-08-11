import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const codebaseDocs = join(repoRoot, "docs", "codebase");
const mutationChild = process.env.TICKMARKR_DOCS_TRUTH_MUTATION_CHILD === "1";
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const COUNT_INDEPENDENCE_CRITERION = "test: a `*.test.ts` file added to every directory the guide publishes a count for, and one removed from another, leaves both the documentation-truth suite and the release-docs suite green, proven member by member over the closed set of those directories read from the guide and the tree at run time rather than listed in the test, each suite re-run against the perturbed tree in a child process";
const RETAINED_CONTRACTS_CRITERION = "test: every retained assertion still FAILS when the thing it guards is broken, proven member by member over the closed set of retained contracts — a cited file that does not exist, a removed authoring-law clause, and a coverage threshold that diverges from `vitest.config.ts` — each broken in a scratch copy and each producing a failure that names what it guarded";
const COVERAGE_THRESHOLDS_TITLE = "test: every coverage threshold published in the testing guide matches vitest.config.ts";

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

/**
 * Clauses the v1.80 amendment (OBS-164) added to the AUTHORING LAW in TESTING.md.
 * Removing the law from the guide fails every test that reads this map.
 */
const AMENDED_LAW_CLAUSES = {
  productionRenderPath: /captured through the production render path/i,
  equivalenceAsserted: /equivalence to that path asserted, not assumed/i,
  equivalencePrimary: /Equivalence is the primary oracle/i,
  provenanceInsufficient: /Provenance and stability together are insufficient/i,
  regenerationCircular: /compares a capture against itself and therefore proves nothing/i,
  positiveForm: /State positively what only the production tree can produce/i,
  namedStructure: /bordered panel enclosing its own content across more than one row/i,
  incident: /OBS-164/,
  whyWordingFailed: /put the whole burden on the word \*\*real\*\*, which no test can enforce/i,
} as const;

type CoverageThreshold = { key: string; values: string; raw: string };

function coverageThresholds(source: string): CoverageThreshold[] {
  const block = source.match(/thresholds:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  return [...block.matchAll(/^\s*("([^"]+)":\s*\{\s*([^}\n]+)\s*\})/gm)].map((match) => ({
    key: match[2],
    values: match[3].replace(/\s+/g, " ").trim(),
    raw: match[1],
  }));
}

function publishedTestDirs(testing: string): string[] {
  return [...testing.matchAll(/([a-z]+)\/ +(\d+) \*\.test\.ts files?/g)].map((match) => match[1]);
}

function makeScratchRepo(prefix: string): string {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const relativePath of tracked) {
    const destination = join(scratch, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, relativePath), destination);
  }
  symlinkSync(realpathSync(join(repoRoot, "node_modules")), join(scratch, "node_modules"), "dir");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: scratch });
  execFileSync("git", ["add", "-A"], { cwd: scratch });
  execFileSync(
    "git",
    ["-c", "user.name=docs-truth-test", "-c", "user.email=docs-truth@test.invalid", "commit", "-q", "--no-gpg-sign", "-m", "scratch"],
    { cwd: scratch }
  );
  return scratch;
}

function runScratchTests(scratch: string, files: string[], title?: string) {
  const args = [vitestBin, "run", "--configLoader", "runner", ...files];
  if (title) {
    const isolatedConfig = join(scratch, "vitest.docs-truth-mutation.config.mts");
    writeFileSync(isolatedConfig, "export default { test: { testTimeout: 20_000 } };\n");
    args.push("--config", isolatedConfig);
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    args.push("--testNamePattern", escaped);
  }
  // Q72s: async spawn, not spawnSync — a synchronous child run blocks this worker's event
  // loop for the child's whole lifetime, starving vitest's birpc on 2-core CI runners
  // (4/4 deterministic end-of-suite kills). The loop must breathe DURING children.
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: scratch,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        TICKMARKR_DOCS_TRUTH_MUTATION_CHILD: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function childOutput(result: Awaited<ReturnType<typeof runScratchTests>>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
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
    expect(missing, `missing cited files: ${missing.join(", ")}`).toStrictEqual([]);
  });

  test("test: the testing and cli design pages carry no stopgap banner", () => {
    for (const file of ["TESTING.md", "CLI-DESIGN.md"]) {
      const path = join(codebaseDocs, file);
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/^> \*\*STOPGAP:/, `${file} should not carry stopgap banner`);
    }
  });

  test("test: every claim the guide already made that the documentation-truth check verifies continues to hold", () => {
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

    // stable structure landmarks are present; volatile per-directory file counts are descriptive only
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

  test(COVERAGE_THRESHOLDS_TITLE, () => {
    const testing = readFileSync(join(codebaseDocs, "TESTING.md"), "utf8");
    const vitest = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    const documented = coverageThresholds(testing);
    const configured = coverageThresholds(vitest);

    expect(configured.length, "vitest.config.ts coverage threshold set is empty").toBeGreaterThan(0);
    expect(
      documented.map(({ key }) => key),
      "coverage threshold keys published in TESTING.md"
    ).toStrictEqual(configured.map(({ key }) => key));
    for (const threshold of configured) {
      expect(
        documented.find(({ key }) => key === threshold.key)?.values,
        `coverage threshold ${threshold.key}`
      ).toBe(threshold.values);
    }
  });

  test("test: the shipped testing guide states that a fixture standing in for the product's own rendered surface must be captured through the production render path and that equivalence with it is asserted, not assumed", () => {
    const testing = readFileSync(join(codebaseDocs, "TESTING.md"), "utf8");
    expect(testing).toMatch(/a fixture standing in for the product's \*own\* rendered surface/i);
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.productionRenderPath);
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.equivalenceAsserted);
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.equivalencePrimary);
    // the requirement is byte identity against the production path, not a structural import check
    expect(testing).toMatch(/identical to the production path's bytes for the same data at the same dimensions/i);
    expect(testing).toMatch(/\*imports\* the product's components is structural/i);
  });

  test("test: the guide states that provenance and stability together are insufficient, and that a regeneration check comparing a capture against itself proves nothing", () => {
    const testing = readFileSync(join(codebaseDocs, "TESTING.md"), "utf8");
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.provenanceInsufficient);
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.regenerationCircular);
    expect(testing).toMatch(/both true of a second renderer built for capture/i);
  });

  test("test: the guide requires the positive form, naming at least one structure only the production tree can produce, rather than only forbidding hand-authoring", () => {
    const testing = readFileSync(join(codebaseDocs, "TESTING.md"), "utf8");
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.positiveForm);
    expect(testing).toMatch(/rather than only forbidding hand-authoring/i);
    const namedStructures = [
      AMENDED_LAW_CLAUSES.namedStructure,
      /stat tile whose value and whose series both sit inside the tile's own border/i,
      /journal rows inside a border rather than as bare lines/i,
    ];
    expect(namedStructures.filter((s) => s.test(testing)).length).toBeGreaterThanOrEqual(1);
    // and it says why naming one works: a flat-line renderer cannot produce it
    expect(testing).toMatch(/A flat-line renderer cannot counterfeit those/i);
  });

  test("test: the guide records the incident that motivated the amendment, so a future reader learns why the earlier wording failed rather than only what replaced it", () => {
    const testing = readFileSync(join(codebaseDocs, "TESTING.md"), "utf8");
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.incident);
    // the incident, not just the rule: what the corpus depicted and how the gates passed
    expect(testing).toMatch(/golden corpus/i);
    expect(testing).toMatch(/used zero times/i);
    expect(testing).toMatch(/Every gate passed honestly/i);
    // and why the earlier wording failed, not only what replaced it
    expect(testing).toMatch(/captured verbatim from the real surface/i);
    expect(testing).toMatch(AMENDED_LAW_CLAUSES.whyWordingFailed);
    expect(testing).toMatch(/it was never violated/i);
  });

  test("test: the documentation-truth check asserts the amended law's presence, so removing it fails a test rather than passing a review", () => {
    const testing = readFileSync(join(codebaseDocs, "TESTING.md"), "utf8");
    // the law is one block, not two competing statements
    expect(testing.match(/\*\*AUTHORING LAW/g)?.length).toBe(1);
    const law = testing.slice(testing.indexOf("**AUTHORING LAW"), testing.indexOf("**Static file fixtures**"));
    expect(law).not.toBe("");
    for (const [name, clause] of Object.entries(AMENDED_LAW_CLAUSES)) {
      expect(clause.test(law), `AUTHORING LAW lost its ${name} clause`).toBe(true);
    }
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

  test.skipIf(mutationChild)(COUNT_INDEPENDENCE_CRITERION, async () => {
    const scratch = makeScratchRepo("tickmarkr-count-independence-");
    try {
      const testing = readFileSync(join(scratch, "docs/codebase/TESTING.md"), "utf8");
      const dirs = publishedTestDirs(testing);
      expect(dirs.length, "TESTING.md published test-directory count set is empty").toBeGreaterThan(1);
      expect(new Set(dirs).size, "TESTING.md publishes a directory count more than once").toBe(dirs.length);
      for (const dir of dirs) {
        expect(existsSync(join(scratch, "tests", dir)), `published test directory tests/${dir}`).toBe(true);
      }

      const cited = new Set([...TESTING_CITED_FILES, ...DESIGN_CITED_FILES]);
      for (const [index, addedDir] of dirs.entries()) {
        const removalDirs = [...dirs.slice(index + 1), ...dirs.slice(0, index)];
        const removedRelative = removalDirs
          .flatMap((dir) => readdirSync(join(scratch, "tests", dir))
            .filter((file) => file.endsWith(".test.ts"))
            .map((file) => `tests/${dir}/${file}`))
          .find((file) => !cited.has(file));
        expect(removedRelative, `removable test file outside tests/${addedDir}`).toBeTruthy();

        const addedRelative = `tests/${addedDir}/zz-doc-truth-count-probe.test.ts`;
        const addedPath = join(scratch, addedRelative);
        const removedPath = join(scratch, removedRelative!);
        const removedSource = readFileSync(removedPath, "utf8");
        try {
          writeFileSync(
            addedPath,
            'import { test } from "vitest";\ntest.skip("temporary test-count perturbation probe", () => {});\n'
          );
          unlinkSync(removedPath);
          const result = await runScratchTests(scratch, [
            "tests/docs-truth-testing.test.ts",
            "tests/repo/release-docs.test.ts",
          ]);
          expect(
            result.status,
            `count perturbation ${addedRelative} added and ${removedRelative} removed\n${childOutput(result)}`
          ).toBe(0);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } finally {
          rmSync(addedPath, { force: true });
          writeFileSync(removedPath, removedSource);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 240_000);

  test.skipIf(mutationChild)(RETAINED_CONTRACTS_CRITERION, async () => {
    const scratch = makeScratchRepo("tickmarkr-retained-contracts-");
    const expectNamedFailure = async (title: string, guarded: string) => {
      const result = await runScratchTests(scratch, ["tests/docs-truth-testing.test.ts"], title);
      const output = childOutput(result);
      expect(result.status, `mutation for ${guarded} unexpectedly passed\n${output}`).not.toBe(0);
      expect(output, `failure output did not name ${guarded}`).toContain(guarded);
    };

    try {
      for (const citedFile of [...TESTING_CITED_FILES, ...DESIGN_CITED_FILES]) {
        const path = join(scratch, citedFile);
        const source = readFileSync(path);
        try {
          unlinkSync(path);
          await expectNamedFailure(
            "test: every source file cited on the testing and cli design pages exists in the tree",
            citedFile
          );
        } finally {
          writeFileSync(path, source);
        }
      }

      const testingPath = join(scratch, "docs/codebase/TESTING.md");
      const testing = readFileSync(testingPath, "utf8");
      for (const [name, clause] of Object.entries(AMENDED_LAW_CLAUSES)) {
        const match = clause.exec(testing);
        expect(match, `AUTHORING LAW clause ${name} was not found for mutation`).toBeTruthy();
        const index = match!.index;
        try {
          writeFileSync(testingPath, testing.slice(0, index) + testing.slice(index + match![0].length));
          await expectNamedFailure(
            "test: the documentation-truth check asserts the amended law's presence, so removing it fails a test rather than passing a review",
            `AUTHORING LAW lost its ${name} clause`
          );
        } finally {
          writeFileSync(testingPath, testing);
        }
      }

      const thresholds = coverageThresholds(testing);
      expect(thresholds.length, "TESTING.md coverage threshold set is empty").toBeGreaterThan(0);
      for (const threshold of thresholds) {
        const mutated = threshold.raw.replace(/\d+/, (value) => String(Number(value) + 1));
        try {
          writeFileSync(testingPath, testing.replace(threshold.raw, mutated));
          await expectNamedFailure(COVERAGE_THRESHOLDS_TITLE, `coverage threshold ${threshold.key}`);
        } finally {
          writeFileSync(testingPath, testing);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 240_000);
});
