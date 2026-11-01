// v2.7.8 T1 acceptance — the coverage-floor recheck (specs/v2.7.8-sharded-ci.spec.md).
// Every case drives the real command (`npx tsx scripts/ci/cli.ts floors <summary>`) against the
// production vitest.config.ts or a scratch copy of it, because the repaired defect is a silent
// pass inside vitest's own threshold check — a mock of the loader could not prove the one-source
// claim. Scratch trees copy the config's import closure (src/, scripts/, manifests) plus the
// harness-provisioned node_modules symlink, the docs-truth scratch pattern. v2.8.2 T2 (ANL-022 §7.2a) runs the
// public workflow's own floors and coverage steps verbatim from such a tree, RUNNER_TEMP a scratch directory.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { expect, test } from "vitest";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";
import { validateThresholds } from "../../scripts/ci/floors.js";
import { readJson } from "../../scripts/ci/json.js";
import { parseRecord } from "../../scripts/ci/reporter.js";

// this file lives in tests/scripts/ — the repo root is two levels up
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Every top-level src/ directory a production floor glob owns. */
const GLOBBED_DIRS = ["graph", "route", "gates", "run", "config", "compile", "adapters", "drivers", "cli"];

type Counters = { total: number; covered: number };
type FloorLine = {
  glob: string;
  files: number;
  statements: number;
  metrics: Record<string, { pct: number; floor: number; ok: boolean }>;
  defects: string[];
};

const ZERO: Counters = { total: 0, covered: 0 };
const entry = (over: Record<string, Counters> = {}): Record<string, Counters> => ({
  lines: { total: 100, covered: 100 },
  statements: { total: 50, covered: 50 },
  functions: { total: 20, covered: 20 },
  branches: { total: 10, covered: 10 },
  ...over,
});

/** A healthy summary over `root`: every globbed dir covered, a zero-FUNCTION file beside statements (legitimate), and a statement-free file no production glob owns. */
const healthySummary = (root: string): string => {
  const entries: Record<string, unknown> = { total: entry() };
  for (const dir of GLOBBED_DIRS) entries[`${root}/src/${dir}/x.ts`] = entry();
  entries[`${root}/src/graph/nofn.ts`] = entry({ functions: ZERO });
  entries[`${root}/src/zero/z.ts`] = entry({ lines: ZERO, statements: ZERO, functions: ZERO, branches: ZERO });
  return JSON.stringify(entries, null, 1);
};

/** A summary holding only the given files (lines counters per file, everything else healthy). */
const linesSummary = (root: string, files: readonly [path: string, lines: Counters][]): string => {
  const entries: Record<string, unknown> = { total: entry() };
  for (const [path, lines] of files) entries[`${root}/${path}`] = entry({ lines });
  return JSON.stringify(entries, null, 1);
};

const productionConfig = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
const THRESHOLDS_BLOCK = /thresholds:\s*\{[\s\S]*?\n\s*\},/;
const productionBlock = productionConfig.match(THRESHOLDS_BLOCK)?.[0];
if (productionBlock === undefined) throw new Error("vitest.config.ts: thresholds block not found");
const productionInner = productionBlock.slice(productionBlock.indexOf("{") + 1, productionBlock.lastIndexOf("}")).trim();
const blockWithInner = (inner: string): string => `thresholds: {\n${inner}\n      },`;
const NOWHERE_GLOB = "src/{graph,route,gates,run}-nowhere/**";
const noFileInner = productionInner.replace('"src/{graph,route,gates,run}/**"', `"${NOWHERE_GLOB}"`);
if (noFileInner === productionInner) throw new Error("vitest.config.ts: core-4 glob key not found to misroot");
const zeroStatementsInner = productionInner.replace('"src/config/**"', '"src/zero/**"');
if (zeroStatementsInner === productionInner) throw new Error("vitest.config.ts: src/config glob key not found to retarget");

// realpath because process.cwd() reports the resolved path (macOS /var → /private/var) and the
// summary keys are matched against it — an unresolved scratch root would read as a foreign root
const makeScratch = (): string => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ci-floors-")));
  cpSync(join(repoRoot, "src"), join(scratch, "src"), { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(scratch, "scripts"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "vitest.config.ts"]) {
    cpSync(join(repoRoot, file), join(scratch, file));
  }
  // the harness-provisioned dependency link — realpath so the scratch link targets the real tree
  symlinkSync(realpathSync(join(repoRoot, "node_modules")), join(scratch, "node_modules"), "dir");
  return scratch;
};

/** Rewrite the scratch config's thresholds block (null removes it); the config module is re-imported fresh by each child run. */
const writeThresholds = (scratch: string, block: string | null): void => {
  writeFileSync(join(scratch, "vitest.config.ts"), productionConfig.replace(THRESHOLDS_BLOCK, block ?? ""));
};

interface CliRun {
  status: number;
  stdout: string;
}

/** One floors run, with and without `--out` (v2.8.2 T1): the producer's sidecar holds exactly the lines it printed,
 * and writing it changes neither the lines nor the exit status. */
const runFloorsCommand = async (cwd: string, summaryArg: string): Promise<CliRun> => {
  const once = async (extra: readonly string[]) => {
    const run = await runOwned("npx", ["tsx", "scripts/ci/cli.ts", "floors", summaryArg, ...extra], {
      cwd,
      ms: 120_000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const failures = ownedFailures(run, "floors recheck child");
    if (failures.length > 0) throw new Error(failures.join("; "));
    return { status: run.exitCode ?? -1, stdout: run.out };
  };
  const dir = mkdtempSync(join(tmpdir(), "ci-floors-out-"));
  try {
    const sidecar = join(dir, "floors.out");
    const [plain, written] = await Promise.all([once([]), once(["--out", sidecar])]);
    expect(written, summaryArg).toEqual(plain);
    expect(readFileSync(sidecar, "utf8"), summaryArg).toBe(plain.stdout);
    return plain;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const floorLines = (stdout: string): FloorLine[] =>
  stdout.split("\n").filter((line) => line.startsWith("COVERAGE_FLOOR ")).map((line) => JSON.parse(line.slice("COVERAGE_FLOOR ".length)) as FloorLine);
const floorLineFor = (stdout: string, glob: string): FloorLine => {
  const found = floorLines(stdout).find((line) => line.glob === glob);
  if (found === undefined) throw new Error(`no COVERAGE_FLOOR line for ${glob} in:\n${stdout}`);
  return found;
};
const finalLine = (stdout: string): string => stdout.trimEnd().split("\n").at(-1) ?? "";

test("test: the floors command reds a floor glob that matches no file and one whose matched files hold zero statements in a scratch copy of the production config while the same summary under the production floors reads GREEN with a zero-function file beside statements", { timeout: 180_000 }, async () => {
  const scratch = makeScratch();
  try {
    writeFileSync(join(scratch, "summary.json"), healthySummary(scratch));

    // control: the same summary under the production floors — the zero-function file sits beside
    // statements inside core-4 and stays legitimate
    const green = await runFloorsCommand(scratch, "summary.json");
    expect(green.status).toBe(0);
    expect(finalLine(green.stdout)).toBe("COVERAGE_FLOORS verdict=GREEN floors=6 failing=0");
    const core4 = floorLineFor(green.stdout, "src/{graph,route,gates,run}/**");
    expect(core4.files).toBe(5); // graph, route, gates, run + the zero-function file
    expect(core4.defects).toEqual([]);
    expect(core4.metrics.functions).toEqual({ pct: 100, floor: 80, ok: true });

    // a glob that matches no file reds — the vitest 3.2.7 silent pass
    writeThresholds(scratch, blockWithInner(noFileInner));
    const noFile = await runFloorsCommand(scratch, "summary.json");
    expect(noFile.status).toBe(1);
    expect(finalLine(noFile.stdout)).toBe("COVERAGE_FLOORS verdict=RED floors=6 failing=1");
    const nowhere = floorLineFor(noFile.stdout, NOWHERE_GLOB);
    expect(nowhere.defects).toEqual(["no-file"]);
    expect(nowhere.files).toBe(0);

    // a glob whose matched files hold zero statements reds (percent(0,0)=100 must not mask it)
    writeThresholds(scratch, blockWithInner(zeroStatementsInner));
    const zero = await runFloorsCommand(scratch, "summary.json");
    expect(zero.status).toBe(1);
    expect(finalLine(zero.stdout)).toBe("COVERAGE_FLOORS verdict=RED floors=6 failing=1");
    const zeroLine = floorLineFor(zero.stdout, "src/zero/**");
    expect(zeroLine.defects).toEqual(["zero-statements"]);
    expect(zeroLine.files).toBe(1);
    expect(zeroLine.statements).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("test: a coverage summary written under another root reds every production floor glob as matching no file versus the same entries under this root reading GREEN", { timeout: 120_000 }, async () => {
  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "ci-floors-other-")));
  try {
    // same entries, keys rebased under a foreign root; run from THIS checkout so the production
    // floors load from the working directory's real vitest.config.ts
    writeFileSync(join(otherRoot, "under-root.json"), healthySummary(repoRoot));
    writeFileSync(join(otherRoot, "foreign.json"), healthySummary(otherRoot));
    const green = await runFloorsCommand(repoRoot, join(otherRoot, "under-root.json"));
    expect(green.status).toBe(0);
    expect(finalLine(green.stdout)).toBe("COVERAGE_FLOORS verdict=GREEN floors=6 failing=0");

    const foreign = await runFloorsCommand(repoRoot, join(otherRoot, "foreign.json"));
    expect(foreign.status).toBe(1);
    expect(finalLine(foreign.stdout)).toBe("COVERAGE_FLOORS verdict=RED floors=6 failing=6");
    const lines = floorLines(foreign.stdout);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line.defects, line.glob).toEqual(["no-file"]);
    expect(lines.every((line) => line.files === 0)).toBe(true);
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("test: a measured floor reds at 79.99 against 80 and passes at exactly 80 from summed covered over total so a glob that averages to a pass but sums to a miss reds", { timeout: 180_000 }, async () => {
  const scratch = makeScratch();
  try {
    writeThresholds(scratch, blockWithInner('        "src/graph/**": { lines: 80 },'));

    writeFileSync(join(scratch, "summary.json"), linesSummary(scratch, [["src/graph/a.ts", { total: 10000, covered: 7999 }]]));
    const short = await runFloorsCommand(scratch, "summary.json");
    expect(short.status).toBe(1);
    expect(floorLineFor(short.stdout, "src/graph/**").defects).toEqual(["below-floor"]);
    expect(floorLineFor(short.stdout, "src/graph/**").metrics.lines).toEqual({ pct: 79.99, floor: 80, ok: false });

    writeFileSync(join(scratch, "summary.json"), linesSummary(scratch, [["src/graph/a.ts", { total: 10000, covered: 8000 }]]));
    const exact = await runFloorsCommand(scratch, "summary.json");
    expect(exact.status).toBe(0);
    expect(finalLine(exact.stdout)).toBe("COVERAGE_FLOORS verdict=GREEN floors=1 failing=0");
    expect(floorLineFor(exact.stdout, "src/graph/**").metrics.lines).toEqual({ pct: 80, floor: 80, ok: true });

    // per-file pcts 100 and 79.9 average to 89.95 (a pass), but the SUM is 8000/10010 = 79.92
    writeFileSync(join(scratch, "summary.json"), linesSummary(scratch, [
      ["src/graph/b1.ts", { total: 10, covered: 10 }],
      ["src/graph/b2.ts", { total: 10000, covered: 7990 }],
    ]));
    const averaged = await runFloorsCommand(scratch, "summary.json");
    expect(averaged.status).toBe(1);
    const averagedLine = floorLineFor(averaged.stdout, "src/graph/**");
    expect(averagedLine.defects).toEqual(["below-floor"]);
    expect(averagedLine.metrics.lines).toEqual({ pct: 79.92, floor: 80, ok: false });
    expect(averagedLine.files).toBe(2);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("test: a missing empty or malformed summary, absent or empty thresholds, an empty metric subset, covered above total, a repeated JSON key and a perFile or numeric global threshold key each exit 2 UNREADABLE versus exit 0 on the production floors", { timeout: 300_000 }, async () => {
  const scratch = makeScratch();
  try {
    writeFileSync(join(scratch, "good.json"), healthySummary(scratch));
    const green = await runFloorsCommand(scratch, "good.json");
    expect(green.status).toBe(0);
    expect(finalLine(green.stdout)).toBe("COVERAGE_FLOORS verdict=GREEN floors=6 failing=0");

    const expectUnreadable = async (summaryArg: string): Promise<void> => {
      const run = await runFloorsCommand(scratch, summaryArg);
      expect(run.status, summaryArg).toBe(2);
      expect(finalLine(run.stdout), summaryArg).toBe("COVERAGE_FLOORS verdict=UNREADABLE floors=UNREADABLE failing=UNREADABLE");
      expect(floorLines(run.stdout), `${summaryArg}: no partial verdict lines on UNREADABLE`).toHaveLength(0);
    };

    // summary-side violations
    await expectUnreadable("missing.json");
    writeFileSync(join(scratch, "empty.json"), "");
    await expectUnreadable("empty.json");
    writeFileSync(join(scratch, "malformed.json"), '{"total": {');
    await expectUnreadable("malformed.json");
    writeFileSync(join(scratch, "over.json"), JSON.stringify({ total: entry(), [`${scratch}/src/graph/a.ts`]: entry({ lines: { total: 10, covered: 11 } }) }));
    await expectUnreadable("over.json");
    // JSON.stringify cannot repeat a key — the doctored document is written as raw text
    const repeatedKey = JSON.stringify(`${scratch}/src/graph/a.ts`);
    writeFileSync(join(scratch, "repeated.json"), `{"total":${JSON.stringify(entry())},${repeatedKey}:${JSON.stringify(entry())},${repeatedKey}:${JSON.stringify(entry())}}`);
    await expectUnreadable("repeated.json");

    // config-side violations, each over the healthy summary
    writeThresholds(scratch, null); // absent thresholds
    await expectUnreadable("good.json");
    writeThresholds(scratch, "thresholds: {},"); // empty thresholds
    await expectUnreadable("good.json");
    writeThresholds(scratch, blockWithInner('        "src/graph/**": {},')); // empty metric subset
    await expectUnreadable("good.json");
    writeThresholds(scratch, blockWithInner(`${productionInner}\n        perFile: true,`));
    await expectUnreadable("good.json");
    writeThresholds(scratch, blockWithInner(`${productionInner}\n        lines: 80,`)); // numeric global key
    await expectUnreadable("good.json");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Review repair (prototype-sensitive dictionaries + sorted producer output): every probe below is
// an input the reviewer executed against the prior code. JSON keys named "constructor",
// "toString", "hasOwnProperty" or "__proto__" are ordinary data — repeated ones are duplicates,
// lookups are never answered through a rewritten prototype — and the COVERAGE_FLOOR lines render
// sorted by glob, the CLOSED INPUT preamble's producer rule.
test("prototype-named JSON keys are ordinary data, literal prototype-named globs stay usable, and floor lines render sorted by glob", { timeout: 240_000 }, async () => {
  // module probe: JSON.parse keeps every key as own data, "__proto__" included, and all four
  // literal globs must validate as usable — a plain-record unsupported lookup would reject them
  // through inherited Object.prototype members
  const probe = validateThresholds(
    JSON.parse('{"constructor":{"lines":80},"toString":{"statements":80},"hasOwnProperty":{"functions":80},"__proto__":{"branches":80}}'),
  );
  expect(Object.keys(probe).sort()).toEqual(["__proto__", "constructor", "hasOwnProperty", "toString"]);
  expect(probe["__proto__"]).toEqual({ branches: 80 });

  const scratch = makeScratch();
  try {
    writeFileSync(join(scratch, "good.json"), healthySummary(scratch));
    const green = await runFloorsCommand(scratch, "good.json");
    expect(green.status).toBe(0);
    // producer side of the preamble: production thresholds over a healthy summary, sorted by glob
    const globs = floorLines(green.stdout).map((line) => line.glob);
    expect(globs).toEqual([...globs].sort());

    const healthy = JSON.stringify(entry());
    const expectUnreadableDoc = async (name: string, doc: string): Promise<void> => {
      writeFileSync(join(scratch, name), doc);
      const run = await runFloorsCommand(scratch, name);
      expect(run.status, name).toBe(2);
      expect(finalLine(run.stdout), name).toBe("COVERAGE_FLOORS verdict=UNREADABLE floors=UNREADABLE failing=UNREADABLE");
      expect(floorLines(run.stdout), `${name}: no partial verdict lines on UNREADABLE`).toHaveLength(0);
    };

    // a repeated "__proto__" key is a duplicate, not a silent prototype rewrite
    await expectUnreadableDoc("dup-top-proto.json", `{"total":${healthy},"__proto__":${healthy},"__proto__":${healthy}}`);
    await expectUnreadableDoc("dup-total-proto.json", `{"total":{"__proto__":1,"__proto__":2}}`);
    // a nonabsolute "__proto__" key is a rejected summary key, not an invisible one
    await expectUnreadableDoc("nonabsolute-proto.json", `{"total":${healthy},"__proto__":null}`);
    // metrics reachable only through a rewritten entry prototype never counted as present
    await expectUnreadableDoc(
      "proto-metrics.json",
      `{"total":${healthy},${JSON.stringify(`${scratch}/src/graph/p.ts`)}:{"__proto__":${healthy}}}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// v2.8.2 T2 (ANL-022 §7.2a) — the public workflow's own steps, read from the parsed file, run verbatim through
// `bash -e -c` with RUNNER_TEMP a scratch directory. v2.8.2 T7 (§7.4): the sharded form — every job is a matrix over
// both operating systems, so one declaration is both OSes' step; its matrix and runner expressions render per run.
type WorkflowStep = { name?: string; if?: string; run?: string; env?: Record<string, string> };
const publicJob = (jobName: string) =>
  ((parseYaml(readFileSync(join(repoRoot, ".github/workflows/ci.public.yml"), "utf8")) as {
    jobs?: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps?: WorkflowStep[] }>;
  }).jobs ?? {})[jobName];
const publicSteps = (jobName: string): WorkflowStep[] => publicJob(jobName)?.steps ?? [];
/** The step the public job `jobName` declares under `name`, run on both operating systems. */
const declaredStep = (jobName: string, name: string): { run: string; env: Record<string, string> } => {
  expect(publicJob(jobName)?.strategy?.matrix?.os, `${jobName}: one job per OS`).toEqual(["ubuntu-latest", "macos-latest"]);
  const step = publicSteps(jobName).find((candidate) => candidate.name === name);
  expect(step?.run?.trim(), `${jobName}: ${name} command`).toBeTruthy();
  return { run: step!.run!.trim(), env: step!.env ?? {} };
};
const renderStep = (text: string, vars: Record<string, string>): string =>
  text.replace(/\$\{\{\s*(?:matrix\.(\w+)|runner\.(temp))\s*\}\}/g, (_, key?: string, temp?: string) => (temp ? vars.RUNNER_TEMP! : vars[key!]!) ?? "");

/** The child environment of a nested run: no inherited Vitest, record, lean-reporter, git-location or lease variables. */
const childEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GIT_")
    && key !== "TICKMARKR_CI_RECORD" && key !== "TICKMARKR_CI_LEAN_REPORTERS" && key !== "TICKMARKR_REPOSITORY_LEASE_TOKEN")),
  NO_COLOR: "1", FORCE_COLOR: "0", ...extra,
});

test("test: the floors command each OS's aggregate declares directly after its merge of every shard's blob writes its own sidecar into the runner temp proof directory, exiting zero with a GREEN sidecar over a healthy summary and one with a RED sidecar over a misrooted glob (W-P2 W-F1)", { timeout: 180_000 }, async () => {
  // the sharded form checks the floors once per OS, in that OS's aggregate, over the summary its merge writes
  const steps = publicSteps("aggregate");
  const floorsIndex = steps.findIndex((step) => step.name === "Recheck coverage floors");
  expect(floorsIndex, "aggregate: Recheck coverage floors step").toBeGreaterThan(-1);
  expect(steps[floorsIndex]?.if, "aggregate: floors step must run under always()").toBe("always()");
  const coverageIndex = steps.findIndex((step) => step.name === "Merge coverage (one coverage map per OS)");
  expect(coverageIndex, "aggregate: coverage merge step").toBeGreaterThan(-1);
  expect(steps[coverageIndex]?.run, "aggregate: the coverage step merges every shard's blob").toMatch(/ --merge-reports=\S+ --coverage /);
  expect(floorsIndex, "aggregate: floors step must directly follow the coverage step").toBe(coverageIndex + 1);
  for (const jobName of ["suite", "single-fork"]) {
    expect(publicSteps(jobName).some((step) => /\bcli\.ts floors\b/.test(step.run ?? "")), `${jobName}: no partial floors check`).toBe(false);
  }
  const command = declaredStep("aggregate", "Recheck coverage floors").run;
  expect(command).toContain("coverage/coverage-summary.json");
  expect(command, "the producer writes its own sidecar: no pipe or tee masks its status").not.toMatch(/\||\btee\b/);

  // that exact command, run from a scratch production tree; the coverage step's wrapper creates the proof
  // directory in CI (it makes its log's parent), so the scratch runner temp holds it before the step runs
  const scratch = makeScratch();
  try {
    mkdirSync(join(scratch, "coverage"), { recursive: true });
    writeFileSync(join(scratch, "coverage", "coverage-summary.json"), healthySummary(scratch));
    const runnerTemp = join(scratch, "runner-temp");
    const sidecar = join(runnerTemp, "proof", "floors.out");
    const runDeclared = async (): Promise<{ status: number; sidecar: string }> => {
      rmSync(sidecar, { force: true });
      mkdirSync(join(runnerTemp, "proof"), { recursive: true });
      const run = await runOwned("bash", ["-e", "-c", command], {
        cwd: scratch,
        ms: 120_000,
        env: { ...process.env, RUNNER_TEMP: runnerTemp, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const failures = ownedFailures(run, "declared floors step");
      if (failures.length > 0) throw new Error(failures.join("; "));
      expect(existsSync(sidecar), "the producer wrote its own sidecar into $RUNNER_TEMP/proof").toBe(true);
      const written = readFileSync(sidecar, "utf8");
      expect(written, "the sidecar holds exactly the lines the step printed").toBe(run.out);
      return { status: run.exitCode ?? -1, sidecar: written };
    };

    const green = await runDeclared();
    expect(green.status, "production floors over a matching summary").toBe(0);
    expect(green.sidecar.trimEnd().split("\n"), "six floor lines and the verdict line").toHaveLength(7);
    expect(floorLines(green.sidecar)).toHaveLength(6);
    expect(finalLine(green.sidecar)).toBe("COVERAGE_FLOORS verdict=GREEN floors=6 failing=0");

    writeThresholds(scratch, blockWithInner(noFileInner)); // a misrooted glob
    const red = await runDeclared();
    expect(red.status, "the producer's status reaches the step").not.toBe(0);
    expect(red.status).toBe(1);
    expect(floorLines(red.sidecar)).toHaveLength(6);
    expect(finalLine(red.sidecar)).toBe("COVERAGE_FLOORS verdict=RED floors=6 failing=1");
    expect(floorLineFor(red.sidecar, NOWHERE_GLOB).defects).toEqual(["no-file"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("test: under the production configuration the declared shard steps over a suite with one failing test and the aggregate's declared merge of their blobs still write the coverage summary the floors step reads, and a test that prints the timeout text keeps that line in its shard's log, while a merge of no blob writes no summary (W-P3)", { timeout: 600_000 }, async () => {
  // v2.8.2 T7 (ANL-022 §7.4): the floors step reads the summary the aggregate's merge writes, so a test that failed in a
  // shard must not cost the OS its summary. Vitest's merge reports coverage whatever the replayed tests did.
  const shardStep = declaredStep("suite", "Run coverage shard (parallel suite project)");
  const mergeStep = declaredStep("aggregate", "Merge coverage (one coverage map per OS)");
  expect(shardStep.run, "the shard step's log argument").toMatch(/^bash scripts\/run-ci-vitest\.sh "\$RUNNER_TEMP\/proof\//);
  const TIMEOUT_LINES = ["Error: Test timed out in 5000ms.", "Error: Hook timed out in 10000ms."];

  // a scratch production copy with the real setup file, committed so its records carry a head and its runs take
  // their own lease: four probes, one per shard by name (no durations are known) — one failing, one printing Vitest's
  // own timeout wording
  const scratch = makeScratch();
  try {
    for (const file of ["tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      cpSync(join(repoRoot, file), join(scratch, file));
    }
    mkdirSync(join(scratch, "tests/probe"), { recursive: true });
    writeFileSync(join(scratch, "tests/probe/a-fails.test.ts"), 'import { expect, test } from "vitest";\ntest("fails", () => {\n  expect(1).toBe(2);\n});\n');
    writeFileSync(join(scratch, "tests/probe/b-prints.test.ts"), `import { test } from "vitest";
test("prints the timeout text", () => {
  console.log(${JSON.stringify(TIMEOUT_LINES[0])});
  console.error(${JSON.stringify(TIMEOUT_LINES[1])});
});
`);
    for (const name of ["c", "d"]) writeFileSync(join(scratch, `tests/probe/${name}-passes.test.ts`), 'import { test } from "vitest";\ntest("passes", () => {});\n');
    const ceiling = { GIT_CEILING_DIRECTORIES: dirname(scratch) };
    for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "scratch"]]) {
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: scratch, env: childEnv(ceiling), stdio: "ignore" });
    }

    // a declared step, verbatim with its declared env, on its own runner; the fixture suite covers no production file,
    // so Vitest's own thresholds fail the merge here — the subject is the summary the floors step reads
    const runStep = async (step: { run: string; env: Record<string, string> }, vars: Record<string, string>) => {
      const env = Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, renderStep(value, vars)]));
      const run = await runOwned("bash", ["-e", "-c", renderStep(step.run, vars)], {
        cwd: scratch, ms: 240_000, env: childEnv({ ...env, ...ceiling, RUNNER_TEMP: vars.RUNNER_TEMP! }),
      });
      const failures = ownedFailures(run, "declared step");
      if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
      return { status: run.exitCode, output: `${run.out}${run.err}` };
    };
    const runners = join(scratch, ".runners");
    const tests: string[][] = [];
    const logs: string[] = [];
    for (const k of [1, 2, 3, 4]) {
      const vars = { os: "ubuntu-latest", shard: String(k), RUNNER_TEMP: join(runners, `suite-${k}`) };
      await runStep(shardStep, vars);
      const log = join(vars.RUNNER_TEMP, "proof", `suite-${k}.log`);
      const record = parseRecord(readJson(readFileSync(`${log}.record.json`, "utf8")), log);
      tests.push(...record.tests.map(({ file, name, state }) => [file, name, state]));
      logs.push(readFileSync(log, "utf8"));
    }
    expect(tests).toEqual([
      ["tests/probe/a-fails.test.ts", "fails", "failed"], ["tests/probe/b-prints.test.ts", "prints the timeout text", "passed"],
      ["tests/probe/c-passes.test.ts", "passes", "passed"], ["tests/probe/d-passes.test.ts", "passes", "passed"],
    ]);
    for (const line of TIMEOUT_LINES) expect(logs[1], `${line} in its shard's log`).toContain(line);

    // the aggregate on its own runner: every shard's proof directory flattened into its group, as the download does
    const summary = join(scratch, "coverage", "coverage-summary.json");
    const merge = async (name: string, shards: readonly number[]) => {
      const vars = { os: "ubuntu-latest", RUNNER_TEMP: join(runners, name) };
      mkdirSync(join(vars.RUNNER_TEMP, "group", "blobs"), { recursive: true });
      for (const k of shards) cpSync(join(runners, `suite-${k}`, "proof"), join(vars.RUNNER_TEMP, "group"), { recursive: true });
      rmSync(join(scratch, "coverage"), { recursive: true, force: true });
      const run = await runStep(mergeStep, vars);
      return { ...run, summary: existsSync(summary) ? (readJson(readFileSync(summary, "utf8")) as Record<string, unknown>) : undefined };
    };
    const merged = await merge("aggregate", [1, 2, 3, 4]);
    expect(merged.status, "the replayed failure still fails the merge").not.toBe(0);
    expect(merged.summary, `a merge replaying a failed test still writes the summary\n${merged.output}`).toHaveProperty("total");
    // control: the summary is the merge's own — a merge of no blob writes none
    const empty = await merge("aggregate-empty", []);
    expect(empty.status).not.toBe(0);
    expect(empty.summary, "no summary without a blob").toBeUndefined();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
