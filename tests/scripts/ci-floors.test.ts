// v2.7.8 T1 acceptance — the coverage-floor recheck (specs/v2.7.8-sharded-ci.spec.md).
// Every case drives the real command (`npx tsx scripts/ci/cli.ts floors <summary>`) against the
// production vitest.config.ts or a scratch copy of it, because the repaired defect is a silent
// pass inside vitest's own threshold check — a mock of the loader could not prove the one-source
// claim. Scratch trees copy the config's import closure (src/, scripts/, manifests) plus the
// harness-provisioned node_modules symlink, the docs-truth scratch pattern.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { expect, test } from "vitest";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";
import { validateThresholds } from "../../scripts/ci/floors.js";

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

const runFloorsCommand = async (cwd: string, summaryArg: string): Promise<CliRun> => {
  const run = await runOwned("npx", ["tsx", "scripts/ci/cli.ts", "floors", summaryArg], {
    cwd,
    ms: 120_000,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const failures = ownedFailures(run, "floors recheck child");
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { status: run.exitCode ?? -1, stdout: run.out };
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

test("test: both public CI jobs run the recheck command their parsed workflow declares after the coverage step under always() and that exact command exits nonzero in a scratch production tree with a misrooted glob and zero with the production floors", { timeout: 180_000 }, async () => {
  // v2.7.8 T5 (D-1813): the sharded form checks the floors once per OS, in that OS's aggregate job, over the
  // summary its merge of every shard's blob writes — the matrix expands to one aggregate job per OS
  type WorkflowStep = { name?: string; if?: string; run?: string };
  const jobs = (parseYaml(readFileSync(join(repoRoot, ".github/workflows/ci.public.yml"), "utf8")) as {
    jobs?: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps?: WorkflowStep[] }>;
  }).jobs ?? {};
  const aggregate = jobs["aggregate"];
  expect(aggregate?.strategy?.matrix?.os, "aggregate: one job per OS").toEqual(["ubuntu-latest", "macos-latest"]);
  const commands: string[] = [];
  for (const os of aggregate?.strategy?.matrix?.os ?? []) {
    const jobName = `aggregate ${os}`;
    const steps = JSON.parse(JSON.stringify(aggregate?.steps ?? []).replaceAll("${{ matrix.os }}", os)) as WorkflowStep[];
    const floorsIndex = steps.findIndex((step) => step.name === "Recheck coverage floors");
    expect(floorsIndex, `${jobName}: Recheck coverage floors step`).toBeGreaterThan(-1);
    expect(steps[floorsIndex]?.if, `${jobName}: floors step must run under always()`).toBe("always()");
    const coverageIndex = steps.findIndex((step) => step.name === "Merge coverage (one threshold check per OS)");
    expect(coverageIndex, `${jobName}: coverage step`).toBeGreaterThan(-1);
    expect(steps[coverageIndex]?.run, `${jobName}: the coverage step merges every shard's blob`).toMatch(/ --merge-reports=\S+ --coverage$/);
    expect(floorsIndex, `${jobName}: floors step must directly follow the coverage step`).toBe(coverageIndex + 1);
    const run = steps[floorsIndex]?.run?.trim();
    expect(run, `${jobName}: floors step command`).toBeTruthy();
    commands.push(run!);
  }
  expect(commands, "one recheck per OS").toHaveLength(2);
  expect(new Set(commands).size, "both jobs declare the same recheck").toBe(1);
  const command = commands[0]!;
  expect(command).toContain("coverage/coverage-summary.json");
  expect(command.startsWith("npx tsx scripts/ci/cli.ts floors "), "the floors recheck over the merged summary").toBe(true);

  // that exact command, run from a scratch production tree
  const scratch = makeScratch();
  try {
    mkdirSync(join(scratch, "coverage"), { recursive: true });
    writeFileSync(join(scratch, "coverage", "coverage-summary.json"), healthySummary(scratch));
    const runDeclared = async (): Promise<number> => {
      const run = await runOwned("bash", ["-e", "-c", command], {
        cwd: scratch,
        ms: 120_000,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const failures = ownedFailures(run, "declared floors step");
      if (failures.length > 0) throw new Error(failures.join("; "));
      return run.exitCode ?? -1;
    };
    expect(await runDeclared(), "production floors over a matching summary").toBe(0);
    writeThresholds(scratch, blockWithInner(noFileInner)); // a misrooted glob
    const misrooted = await runDeclared();
    expect(misrooted).not.toBe(0);
    expect(misrooted).toBe(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
