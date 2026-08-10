import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { acceptanceGate, auditAcceptanceCorpus, testFiltered } from "../../src/gates/acceptance.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

function noCall(): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-judge-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, judge: "DEFINITELY NOT JSON" }));
  return new FakeAdapter(p);
}

const repoRoot = process.cwd();
const base = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();

// Dedicated file-level fixtures: a named-test oracle now means the complete runner-visible name, so an
// enclosing describe title or a decorative suffix would deliberately make these different names.
test("OBS55_MATCH_PASS", () => {
  expect(true).toBe(true);
});

// OBS-62: criterion strings with regex metachars must match verbatim-titled tests once escaped.
test("init points at existing specs when specs/*.spec.md already exist", () => {
  expect(true).toBe(true);
});

const oracleTask = (testName: string) => validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3,
    acceptance: [{ oracle: "test", test: testName }] }],
}).tasks[0];

// vitest-shaped stdout stubs for tmp-repo tests that lack a real runner
const stubRan = (summary: string) => `bash -c 'printf "%s\\n" "${summary}"'`;
const stubFail = (summary: string) => `bash -c 'printf "%s\\n" "${summary}" >&2; exit 1'`;

// real-runner tests pin the nested vitest to THIS file: `npm test` alone collects all 114
// suite files (~19s on 18 cores, >20s vitest cap on 2-core CI — OBS-59). One file keeps the
// runner real, exercises `--` composition, and cannot recurse (the -t filter skips these
// async tests in the nested run).
const oneFileCmd = "npm test -- --configLoader runner tests/gates/obs55-oracle.test.ts";

describe("OBS-55 — test oracle match verification", () => {
  test("a test oracle whose name filter matches zero tests fails closed even when the runner exits 0", async () => {
    const filter = "OBS55_ZERO_MATCH_UNIQUE_NAME";
    const r = await acceptanceGate(
      oracleTask(filter),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/matched zero tests/i);
  }, 60_000);

  test("the zero-match failure message names the test filter that matched nothing", async () => {
    const filter = "OBS55_ZERO_MATCH_UNIQUE_NAME";
    const r = await acceptanceGate(
      oracleTask(filter),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toContain(filter);
  }, 60_000);

  test("a test oracle with a matching passing test still passes", async () => {
    const r = await acceptanceGate(
      oracleTask("OBS55_MATCH_PASS"),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(true);
    expect(r.details).toContain("OBS55_MATCH_PASS");
  }, 60_000);

  test("a test oracle with a matching failing test still fails", async () => {
    const repo = makeRepo({ "x.txt": "x\n" });
    const b = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const name = "OBS55_MATCH_FAIL";
    const r = await acceptanceGate(
      oracleTask(name),
      repo, b, { adapter: noCall(), model: "fake-1" }, undefined,
      { testCmd: stubFail("      Tests  1 failed | 0 skipped (1)") },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toContain(name);
    expect(r.details).toMatch(/exit/);
  });

  test("testFiltered composes a base command already containing `--` without dropping the name filter", () => {
    const cmd = testFiltered("npm test -- --maxWorkers=6", "OBS55_MATCH_PASS");
    expect(cmd).toBe("npm test -- --maxWorkers=6 -t '^OBS55_MATCH_PASS$'");
    expect(cmd).not.toMatch(/\s--\s-t\b/);

    expect(testFiltered("vitest run", "OBS55_MATCH_PASS"))
      .toBe("vitest run -t '^OBS55_MATCH_PASS$'");
    expect(testFiltered("npm test", "OBS55_MATCH_PASS"))
      .toBe("npm test -- -t '^OBS55_MATCH_PASS$'");
  });

  test("no code path lets a zero-matched test run count as an oracle pass", async () => {
    const repo = makeRepo({ "x.txt": "x\n" });
    const b = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const r = await acceptanceGate(
      oracleTask("nothing"),
      repo, b, { adapter: noCall(), model: "fake-1" }, undefined,
      { testCmd: stubRan("      Tests  0 passed | 99 skipped (99)") },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/matched zero tests/i);
  });
});

interface ListedTest {
  name: string;
  file: string;
  projectName?: string;
}

const vitestBin = join(repoRoot, "node_modules/.bin/vitest");

function parsedJson<T>(output: string, opener: "[" | "{"): T {
  const start = output.indexOf(opener);
  if (start < 0) throw new Error(`Vitest emitted no JSON payload: ${output}`);
  return JSON.parse(output.slice(start)) as T;
}

function runnerVisibleName(name: string): string {
  return name.split(" > ").join(" ");
}

function fixtureSource(title: string, suites: readonly string[] = []): string {
  let body = `test(${JSON.stringify(title)}, () => expect(true).toBe(true));\n`;
  for (const suite of [...suites].reverse()) {
    body = `describe(${JSON.stringify(suite)}, () => {\n${body}});\n`;
  }
  return body;
}

function writeFixture(title: string, suites: readonly string[] = []): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-t6-vitest-"));
  const file = join(root, "fixture.test.ts");
  writeFileSync(file, fixtureSource(title, suites));
  return { root, file };
}

function fixtureArgs(root: string, file: string): string[] {
  return ["--globals", "--configLoader", "runner", "--root", root, file];
}

function listFixture(root: string, file: string, pattern?: string): ListedTest[] {
  const args = ["list", ...fixtureArgs(root, file), "--json"];
  if (pattern !== undefined) args.push("-t", pattern);
  return parsedJson<ListedTest[]>(execFileSync(vitestBin, args, { encoding: "utf8" }), "[");
}

function runUnanchored(root: string, file: string, criterion: string): { listed: ListedTest[]; passed: number } {
  const listed = listFixture(root, file, criterion);
  const output = execFileSync(
    vitestBin,
    ["run", ...fixtureArgs(root, file), "-t", criterion, "--reporter=json"],
    { encoding: "utf8" },
  );
  const report = parsedJson<{ numPassedTests: number }>(output, "{");
  return { listed, passed: report.numPassedTests };
}

async function runAcceptanceGate(root: string, file: string, criterion: string) {
  const testCmd = `${shq(vitestBin)} run --globals --configLoader runner --root ${shq(root)} ${shq(file)}`;
  return runAcceptanceGateWithCommand(root, criterion, testCmd);
}

async function runAcceptanceGateWithCommand(root: string, criterion: string, testCmd: string) {
  return acceptanceGate(
    oracleTask(criterion),
    root,
    base,
    { adapter: noCall(), model: "fake-1" },
    undefined,
    { testCmd },
  );
}

const t6AcceptanceTitles: string[] = [];

function t6AcceptanceTest(
  title: string,
  body: () => void | Promise<void>,
  timeout = 180_000,
): void {
  t6AcceptanceTitles.push(title);
  test(title, body, timeout);
}

t6AcceptanceTest(
  `runAcceptanceGate invokes Vitest on identical fixtures whose full names are "test: criterion extra" and "test: criterion"; the first records acceptance failed and the second passed, while the old unanchored filter passes both, so helper-only anchoring or dropped forwarding fails`,
  async () => {
    const criterion = "test: criterion";
    const fixtures = [writeFixture(`${criterion} extra`), writeFixture(criterion)];
    try {
      const listedNames = fixtures.map(({ root, file }) => {
        const listed = listFixture(root, file);
        expect(listed).toHaveLength(1);
        return runnerVisibleName(listed[0]!.name);
      });
      expect(listedNames).toEqual([`${criterion} extra`, criterion]);

      const old = fixtures.map(({ root, file }) => runUnanchored(root, file, criterion));
      expect(old.map((result) => result.listed.length)).toEqual([1, 1]);
      expect(old.map((result) => result.passed)).toEqual([1, 1]);

      const gates = await Promise.all(fixtures.map(({ root, file }) => runAcceptanceGate(root, file, criterion)));
      expect(gates.map((result) => result.pass)).toEqual([false, true]);
      expect(gates[0]!.details).toMatch(/matched zero tests/i);
    } finally {
      for (const { root } of fixtures) rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);

interface AuditResult {
  specPath: string;
  status: "parsed" | "parse-failed";
  error?: string;
  item?: unknown;
  namedTest?: { criterion: string; matches: ListedTest[] };
}

type AuditAcceptanceCorpus = (corpusRoot: string, listedTests: readonly ListedTest[]) => AuditResult[];

function productionCorpusAudit(corpusRoot: string, listedTests: readonly ListedTest[]): AuditResult[] {
  const audit: AuditAcceptanceCorpus = auditAcceptanceCorpus;
  return audit(corpusRoot, listedTests);
}

function quietProductionCorpusAudit(corpusRoot: string, listedTests: readonly ListedTest[]): AuditResult[] {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return productionCorpusAudit(corpusRoot, listedTests);
  } finally {
    console.warn = warn;
  }
}

function specBody(criterion: string): string {
  return `## T1: fixture\n- acceptance:\n  - test: ${criterion}\n`;
}

function writePath(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function filesystemSpecPaths(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => path.endsWith(".spec.md"))
    .map((path) => join(root, path))
    .sort();
}

function writeMultiProjectFixture(projectTitles: Readonly<Record<string, readonly string[]>>): {
  root: string;
  config: string;
  fileByTitle: Map<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-t6-projects-"));
  const config = join(root, "vitest.config.mjs");
  const fileByTitle = new Map<string, string>();
  const projects = Object.entries(projectTitles).map(([projectName, titles]) => {
    titles.forEach((title, index) => {
      const file = join(root, projectName, `fixture-${index}.test.ts`);
      writePath(file, fixtureSource(title));
      fileByTitle.set(title, file);
    });
    return {
      test: {
        name: projectName,
        globals: true,
        include: [`${projectName}/**/*.test.ts`],
      },
    };
  });
  writeFileSync(config, `export default ${JSON.stringify({ test: { projects } })};\n`);
  return { root, config, fileByTitle };
}

function projectArgs(root: string, config: string): string[] {
  return ["--configLoader", "runner", "--root", root, "--config", config];
}

function listProjects(root: string, config: string): ListedTest[] {
  const output = execFileSync(vitestBin, ["list", ...projectArgs(root, config), "--json"], { encoding: "utf8" });
  return parsedJson<ListedTest[]>(output, "[");
}

function projectTestCommand(root: string, config: string): string {
  return `${shq(vitestBin)} run --configLoader runner --root ${shq(root)} --config ${shq(config)}`;
}

function listRepositoryAllProjects(): ListedTest[] {
  return parsedJson<ListedTest[]>(
    execFileSync(vitestBin, ["list", "--configLoader", "runner", "--json"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
    "[",
  );
}

t6AcceptanceTest(
  `enumerate every spec path from the corpus filesystem, require each path to yield parsed acceptance items or a named parse failure, then match those items against Vitest's JSON listing from every configured project; include one bad spec and one test outside suite so an omitted path or project cannot pass`,
  () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-t6-corpus-"));
    const corpus = join(root, "corpus");
    const shippedRoot = join(repoRoot, "specs");
    for (const source of filesystemSpecPaths(shippedRoot)) {
      const relative = source.slice(shippedRoot.length + 1);
      writePath(join(corpus, "shipped", relative), readFileSync(source, "utf8"));
    }

    const listed = listRepositoryAllProjects();
    expect(new Set(listed.map((entry) => entry.projectName)))
      .toEqual(new Set(["suite", "built-cli", "signal-reaper"]));
    const outsideTest = listed.find((entry) => entry.projectName !== "suite")!;
    const outsideCriterion = runnerVisibleName(outsideTest.name);
    // A suite-project control drawn from the listing itself, so suite-project matching is proven
    // hermetically — the exported tree excludes specs/ (scripts/export-public.sh), leaving no
    // shipped spec that could match a suite test there; the prior assertion relied on one and was
    // satisfiable only in the private checkout (found by the 1.89.0 release proof).
    const suiteTest = listed.find((entry) => entry.projectName === "suite")!;
    const suiteCriterion = runnerVisibleName(suiteTest.name);
    const suiteSpec = join(corpus, "controls", "suite-project.spec.md");
    const outsideSpec = join(corpus, "controls", "outside-project.spec.md");
    const badSpec = join(corpus, "controls", "bad.spec.md");
    writePath(suiteSpec, specBody(suiteCriterion));
    writePath(outsideSpec, specBody(outsideCriterion));
    writePath(badSpec, "this is not a native spec\n");
    try {
      const results = quietProductionCorpusAudit(corpus, listed);
      const discovered = filesystemSpecPaths(corpus);
      expect(discovered).toHaveLength(filesystemSpecPaths(shippedRoot).length + 3);
      expect([...new Set(results.map((result) => result.specPath))].sort()).toEqual(discovered);
      for (const path of discovered) {
        const outcomes = results.filter((result) => result.specPath === path);
        expect(outcomes.length).toBeGreaterThan(0);
        expect(outcomes.every((result) => result.status === "parsed") ||
          (outcomes.length === 1 && outcomes[0]!.status === "parse-failed")).toBe(true);
      }

      const failure = results.find((result) => result.specPath === badSpec);
      expect(failure).toMatchObject({ status: "parse-failed", specPath: badSpec });
      expect(failure?.error).toContain(badSpec);

      const named = results.filter((result) => result.namedTest);
      expect(named.length).toBeGreaterThan(0);
      const suiteResult = named.find((result) => result.specPath === suiteSpec)!;
      expect(suiteResult.namedTest?.criterion).toBe(suiteCriterion);
      expect(suiteResult.namedTest?.matches.some((match) => match.projectName === "suite")).toBe(true);
      const outsideResult = named.find((result) => result.specPath === outsideSpec)!;
      expect(outsideResult.namedTest?.criterion).toBe(outsideCriterion);
      expect(outsideResult.namedTest?.matches).toEqual([outsideTest]);

      const suiteOnly = quietProductionCorpusAudit(corpus, listed.filter((entry) => entry.projectName === "suite"));
      const omittedProject = suiteOnly.find((result) => result.specPath === outsideSpec);
      expect(omittedProject?.namedTest?.matches).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);

t6AcceptanceTest(
  `the production corpus audit enumerates two spec paths, one valid and one unparseable; it records the bad path as parse-failed and the good path's named-test result, while an all-valid corpus records two results, so catch-and-drop and hardcoded failure both fail`,
  () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-t6-audit-"));
    const good = join(root, "good.spec.md");
    const bad = join(root, "bad.spec.md");
    writePath(good, specBody("test: good audit criterion"));
    writePath(bad, "not a task\n");
    try {
      const first = productionCorpusAudit(root, [{
        name: "test: good audit criterion",
        file: "/fixture/good.test.ts",
        projectName: "suite",
      }]);
      expect(first).toHaveLength(2);
      expect(first.find((result) => result.specPath === bad)).toMatchObject({ status: "parse-failed" });
      expect(first.find((result) => result.specPath === good)?.namedTest?.matches).toHaveLength(1);

      writePath(bad, specBody("test: repaired audit criterion"));
      const allValid = productionCorpusAudit(root, [
        { name: "test: good audit criterion", file: "/fixture/good.test.ts", projectName: "suite" },
        { name: "test: repaired audit criterion", file: "/fixture/repaired.test.ts", projectName: "outside" },
      ]);
      expect(allValid).toHaveLength(2);
      expect(allValid.every((result) => result.status === "parsed")).toBe(true);
      expect(allValid.every((result) => result.namedTest?.matches.length === 1)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

t6AcceptanceTest(
  `execute every T6 acceptance title through Vitest's all-project listing and runAcceptanceGate, recording one collected test and gate result per title. Mutate one title with a suffix and require that title alone to fail, so citations or a transcribed name set cannot pass`,
  async () => {
    // This array is populated by t6AcceptanceTest itself as tests are registered; it is not a second
    // transcription of the six criteria. The repository listing proves those registrations are real.
    expect(t6AcceptanceTitles).toHaveLength(6);
    const repositoryListed = listRepositoryAllProjects();
    for (const title of t6AcceptanceTitles) {
      expect(repositoryListed.filter((entry) => runnerVisibleName(entry.name) === title)).toHaveLength(1);
    }

    const split = Math.ceil(t6AcceptanceTitles.length / 2);
    const fixture = writeMultiProjectFixture({
      suite: t6AcceptanceTitles.slice(0, split),
      outside: t6AcceptanceTitles.slice(split),
    });
    try {
      const listed = listProjects(fixture.root, fixture.config);
      expect(new Set(listed.map((entry) => entry.projectName))).toEqual(new Set(["suite", "outside"]));
      const collected = new Map(t6AcceptanceTitles.map((title) => [
        title,
        listed.filter((entry) => runnerVisibleName(entry.name) === title),
      ]));
      expect([...collected.values()].every((matches) => matches.length === 1)).toBe(true);

      const command = projectTestCommand(fixture.root, fixture.config);
      const before = new Map<string, Awaited<ReturnType<typeof runAcceptanceGateWithCommand>>>();
      for (const title of t6AcceptanceTitles) {
        before.set(title, await runAcceptanceGateWithCommand(fixture.root, title, command));
      }
      expect(before.size).toBe(t6AcceptanceTitles.length);
      expect([...before.values()].every((result) => result.pass)).toBe(true);

      const mutated = t6AcceptanceTitles[0]!;
      writePath(fixture.fileByTitle.get(mutated)!, fixtureSource(`${mutated} suffix`));
      const relisted = listProjects(fixture.root, fixture.config);
      expect(relisted.filter((entry) => runnerVisibleName(entry.name) === mutated)).toHaveLength(0);
      expect(relisted.filter((entry) => runnerVisibleName(entry.name) === `${mutated} suffix`)).toHaveLength(1);

      const after = new Map<string, Awaited<ReturnType<typeof runAcceptanceGateWithCommand>>>();
      for (const title of t6AcceptanceTitles) {
        after.set(title, await runAcceptanceGateWithCommand(fixture.root, title, command));
      }
      expect([...after].filter(([, result]) => !result.pass).map(([title]) => title)).toEqual([mutated]);
      expect(after.get(mutated)?.details).toMatch(/matched zero tests/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  300_000,
);

t6AcceptanceTest(
  `runAcceptanceGate records pass for exact full names "test: [a+b]?" and "test: plain", and failure for those same names with a trailing suffix; varying metacharacters and equality together makes unanchored filtering and broken escaping both fail`,
  async () => {
    const criteria = ["test: [a+b]?", "test: plain"];
    const cases = criteria.flatMap((criterion) => [
      { criterion, fixture: writeFixture(criterion), expected: true },
      { criterion, fixture: writeFixture(`${criterion} suffix`), expected: false },
    ]);
    try {
      const results = [];
      for (const entry of cases) {
        const listed = listFixture(entry.fixture.root, entry.fixture.file);
        expect(listed).toHaveLength(1);
        results.push(await runAcceptanceGate(entry.fixture.root, entry.fixture.file, entry.criterion));
      }
      expect(results.map((result) => result.pass)).toEqual(cases.map((entry) => entry.expected));
    } finally {
      for (const { fixture } of cases) rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  240_000,
);

t6AcceptanceTest(
  `runAcceptanceGate uses Vitest's listed full name for fixtures at one and two describe levels; each exact space-joined criterion passes and the identical inner title alone fails, with gate results proving a helper not called by acceptance cannot satisfy it`,
  async () => {
    const fixtures = [writeFixture("inner", ["outer"]), writeFixture("inner", ["outer", "middle"])];
    try {
      for (const { root, file } of fixtures) {
        const listed = listFixture(root, file);
        expect(listed).toHaveLength(1);
        const fullName = runnerVisibleName(listed[0]!.name);
        expect(fullName).not.toBe("inner");

        const exact = await runAcceptanceGate(root, file, fullName);
        const innerOnly = await runAcceptanceGate(root, file, "inner");
        expect(exact.pass).toBe(true);
        expect(innerOnly.pass).toBe(false);
        expect(innerOnly.details).toMatch(/matched zero tests/i);
      }
    } finally {
      for (const { root } of fixtures) rmSync(root, { recursive: true, force: true });
    }
  },
  240_000,
);

// OBS-62: escape regex metachars in -t filters so verbatim-titled tests match; zero-match stays fail-closed.
describe("OBS-62 — test oracle regex escaping", () => {
  const metacharCriterion = "init points at existing specs when specs/*.spec.md already exist";
  const metacharZeroMatch = "no test named specs/*.spec.md [unique-zm]";

  test("a criterion containing regex metachars matches its verbatim titled test", async () => {
    const r = await acceptanceGate(
      oracleTask(metacharCriterion),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(true);
    expect(r.details).toContain(metacharCriterion);
  }, 60_000);

  test("a criterion containing regex metachars that matches no test still fails closed", async () => {
    const r = await acceptanceGate(
      oracleTask(metacharZeroMatch),
      repoRoot, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: oneFileCmd },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/matched zero tests/i);
    expect(r.details).toContain(metacharZeroMatch);
  }, 60_000);

  test("testFiltered regex-escapes metachars in the -t pattern", () => {
    const cmd = testFiltered("npm test", metacharCriterion);
    expect(cmd).toContain(String.raw`specs/\*\.spec\.md`);
  });
});
