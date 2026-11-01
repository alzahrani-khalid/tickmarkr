import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { readJson } from "../../scripts/ci/json.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repo, "scripts/ci/cli.ts");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

type State = "passed" | "failed" | "skipped" | "pending";
type File = { file: string; project: string; state: State; durationMs: number };
type Counters = { total: number; covered: number };
type Source = Record<"lines" | "statements" | "functions" | "branches", Counters>;
type Summary = Record<string, Source>;
const files = ["tests/alpha.test.ts", "tests/beta.test.ts"];
const dirs = ["graph", "route", "gates", "run", "config", "compile", "adapters", "drivers", "cli"];
const source = (total = 10000, covered = 9000): Source => ({
  lines: { total, covered }, statements: { total, covered }, functions: { total, covered }, branches: { total, covered },
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-parity-")));
  temporary.push(root);
  for (const dir of ["src", "scripts", "node_modules"]) symlinkSync(realpathSync(join(repo, dir)), join(root, dir), "dir");
  cpSync(join(repo, "vitest.config.ts"), join(root, "vitest.config.ts"));
  for (const file of files) {
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, file), "// fixture\n");
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["add", "--", ...files], { cwd: root });
  execFileSync("git", ["-c", "user.name=Parity Test", "-c", "user.email=parity@example.test", "commit", "-qm", "fixture"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const base = (): Summary => Object.fromEntries(dirs.map((dir) => [join(root, `src/${dir}/a.ts`), source()]));
  const record = (subset: File[], name: string, selectedHead: string | null = head): string => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify({
      schema: "tickmarkr-ci-record/2", head: selectedHead, shard: null, files: subset, reason: "passed", unhandled: [],
      tests: subset.map(({ file, project, state }) => ({ file, project, name: "case", state })),
    }));
    return path;
  };
  const summary = (value: Summary, name: string): string => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify({ total: source(), ...value }));
    return path;
  };
  const rows = (state: State = "passed"): File[] => files.map((file) => ({ file, project: "suite", state, durationMs: 1 }));
  return { root, head, base, record, summary, rows };
}

async function run(root: string, serial: readonly string[], sharded: readonly string[], serialCoverage: string, shardedCoverage: string, runnerRoot = root) {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "parity", "--root", runnerRoot, "--serial", ...serial, "--sharded", ...sharded,
    "--serial-coverage", serialCoverage, "--sharded-coverage", shardedCoverage], {
    cwd: root, timeout: 60_000, encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  expect(result.error, result.stderr).toBeUndefined();
  const lines = result.stdout.trim().split("\n");
  const verdict = lines.filter((line) => line.startsWith("PARITY verdict="));
  expect(verdict, `status=${result.status} stderr=${result.stderr}`).toHaveLength(1);
  expect(lines.at(-1)).toBe(verdict[0]);
  return {
    code: result.status,
    verdict: verdict[0]!,
    defects: lines.filter((line) => line.startsWith("PARITY_DEFECT ")).map((line) => readJson(line.slice(14)) as { kind: string; form: string }),
    // every line but the verdict is a defect: parity prints no note a difference could hide in
    others: lines.filter((line) => line !== verdict[0] && !line.startsWith("PARITY_DEFECT ")),
  };
}

/** The floors command's own lines over one summary, from the fixture's copy of the production configuration. */
function floorsOf(root: string, summary: string): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "floors", summary], {
    cwd: root, timeout: 60_000, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout).toBe(0);
  return result.stdout;
}

test("test: parity reads GREEN for two complete forms on HEAD given in any order with equal source sets and every file's covered and total counts equal, printing nothing but its verdict, versus a passed-against-failed file or one file's covered lines ten apart reading RED", { timeout: 120_000 }, async () => {
  const f = fixture();
  const serial = [f.record([f.rows()[1]!], "serial-b.json"), f.record([f.rows()[0]!], "serial-a.json")];
  const sharded = [f.record([f.rows()[0]!], "sharded-a.json"), f.record([f.rows()[1]!], "sharded-b.json")];
  const serialSummary = f.summary(f.base(), "serial-summary.json");
  const shardSummary = f.summary(f.base(), "sharded-summary.json");
  const green = await run(f.root, serial, sharded, serialSummary, shardSummary);
  expect(green.code).toBe(0);
  expect(green.verdict).toBe("PARITY verdict=GREEN files=2 sources=9 globs=6 defects=0");
  expect(green.defects).toEqual([]);
  expect(green.others).toEqual([]);
  // the covered difference 2.8.2's parity printed as a note is a defect now
  const b = f.base();
  b[join(f.root, "src/config/a.ts")]!.lines.covered += 10;
  const covered = await run(f.root, serial, sharded, serialSummary, f.summary(b, "covered.json"));
  expect(covered.code).toBe(1);
  expect(covered.verdict).toBe("PARITY verdict=RED files=2 sources=9 globs=6 defects=1");
  expect(covered.defects).toEqual([{ form: "sharded", kind: "covered-differs", file: "src/config/a.ts", metric: "lines", serial: 9000, sharded: 9010 }]);
  expect(covered.others).toEqual([]);
  const failed = f.record([{ ...f.rows()[0]!, state: "failed" }], "failed.json");
  const red = await run(f.root, serial, [failed, sharded[1]!], serialSummary, shardSummary);
  expect(red.code).toBe(1);
  expect(red.defects).toContainEqual(expect.objectContaining({ kind: "state-differs", form: "sharded", file: files[0] }));
});

test("test: a covered difference offset by the opposite difference in another floor's file so both forms' overall totals are equal reds on both files, one covered line no 0.1-point rounding shows reds, and a glob matching no file or summing to zero statements in either summary reds, versus a tolerance applied to the glob percentages or the overall total alone", { timeout: 180_000 }, async () => {
  const f = fixture();
  const r = f.record(f.rows(), "record.json");
  const serialSummary = f.summary(f.base(), "a.json");
  const config = join(f.root, "src/config/a.ts");
  const offset = f.base();
  offset[config]!.lines.covered += 10;
  offset[join(f.root, "src/compile/a.ts")]!.lines.covered -= 10;
  const both = await run(f.root, [r], [r], serialSummary, f.summary(offset, "b.json"));
  expect(both.code).toBe(1);
  expect(both.defects).toEqual([
    { form: "sharded", kind: "covered-differs", file: "src/compile/a.ts", metric: "lines", serial: 9000, sharded: 8990 },
    { form: "sharded", kind: "covered-differs", file: "src/config/a.ts", metric: "lines", serial: 9000, sharded: 9010 },
  ]);
  const one = f.base();
  one[config]!.lines.covered += 1;
  const oneLine = await run(f.root, [r], [r], serialSummary, f.summary(one, "b.json"));
  expect(oneLine.code).toBe(1);
  expect(oneLine.defects).toEqual([{ form: "sharded", kind: "covered-differs", file: "src/config/a.ts", metric: "lines", serial: 9000, sharded: 9001 }]);
  const absent = f.base();
  delete absent[config];
  const noFile = await run(f.root, [r], [r], serialSummary, f.summary(absent, "b.json"));
  expect(noFile.defects).toContainEqual(expect.objectContaining({ kind: "no-file", form: "sharded", glob: "src/config/**" }));
  const zero = f.base();
  zero[config]!.statements = { total: 0, covered: 0 };
  const zeroStatements = await run(f.root, [r], [r], serialSummary, f.summary(zero, "b.json"));
  expect(zeroStatements.defects).toContainEqual(expect.objectContaining({ kind: "zero-statements", form: "sharded", glob: "src/config/**" }));
  const zeroSerial = await run(f.root, [r], [r], f.summary(zero, "c.json"), serialSummary);
  expect(zeroSerial.defects).toContainEqual(expect.objectContaining({ kind: "zero-statements", form: "serial", glob: "src/config/**" }));
});

test("test: parity reads RED naming the file and the metric when one file's covered count or total count of lines, statements, functions or branches differs by one, each of the eight changed alone, a statements covered difference no floor percentage shows included, while identical forms read GREEN, so a parity that forgives a covered difference, compares a subset of the four metrics or keeps a tolerance fails", { timeout: 300_000 }, async () => {
  const f = fixture();
  const r = f.record(f.rows(), "record.json");
  const serialSummary = f.summary(f.base(), "serial.json");
  const identical = await run(f.root, [r], [r], serialSummary, f.summary(f.base(), "identical.json"));
  expect(identical.code).toBe(0);
  expect(identical.verdict).toBe("PARITY verdict=GREEN files=2 sources=9 globs=6 defects=0");
  const file = "src/graph/a.ts";
  for (const metric of ["lines", "statements", "functions", "branches"] as const) {
    for (const count of ["covered", "total"] as const) {
      const changed = f.base();
      const counters = changed[join(f.root, file)]![metric];
      changed[join(f.root, file)]![metric] = { ...counters, [count]: counters[count] + 1 };
      const shardedSummary = f.summary(changed, `${metric}-${count}.json`);
      const result = await run(f.root, [r], [r], serialSummary, shardedSummary);
      expect(result.code, `${metric} ${count}`).toBe(1);
      expect(result.verdict, `${metric} ${count}`).toBe("PARITY verdict=RED files=2 sources=9 globs=6 defects=1");
      expect(result.defects, `${metric} ${count}`).toEqual([{
        form: "sharded", kind: count === "covered" ? "covered-differs" : "totals-differ", file, metric,
        serial: counters[count], sharded: counters[count] + 1,
      }]);
      // no floor names statements, so the floors command reads that form exactly as the serial one
      if (metric === "statements" && count === "covered") expect(floorsOf(f.root, shardedSummary)).toBe(floorsOf(f.root, serialSummary));
    }
  }
});

test("test: the same glob percentages over a different source file set or over equal sets with one source's totals changed read RED versus equal sets and equal totals reading GREEN", async () => {
  const f = fixture();
  const r = f.record(f.rows(), "record.json");
  const a = f.base();
  const serialSummary = f.summary(a, "a.json");
  expect((await run(f.root, [r], [r], serialSummary, f.summary(f.base(), "b.json"))).code).toBe(0);
  const different = f.base();
  delete different[join(f.root, "src/config/a.ts")];
  different[join(f.root, "src/config/b.ts")] = source();
  const sourceSet = await run(f.root, [r], [r], serialSummary, f.summary(different, "b.json"));
  expect(sourceSet.code).toBe(1);
  expect(sourceSet.defects.map((d) => d.kind)).toEqual(expect.arrayContaining(["source-only-serial", "source-only-sharded"]));
  const totals = f.base();
  totals[join(f.root, "src/config/a.ts")]!.lines.total += 1;
  const unequalTotals = await run(f.root, [r], [r], serialSummary, f.summary(totals, "b.json"));
  expect(unequalTotals.code).toBe(1);
  expect(unequalTotals.defects).toContainEqual(expect.objectContaining({ kind: "totals-differ", file: "src/config/a.ts", metric: "lines" }));
});

test("test: an empty, truncated, mixed-head or wrong-head form or a null head reds through the same manifest check the set oracle uses versus two complete forms on this HEAD reading GREEN", async () => {
  const f = fixture();
  const summary = f.summary(f.base(), "summary.json");
  const complete = f.record(f.rows(), "complete.json");
  expect((await run(f.root, [complete], [complete], summary, summary)).code).toBe(0);
  const empty = f.record([], "empty.json");
  const truncated = f.record([f.rows()[0]!], "truncated.json");
  const wrongHead = "a".repeat(40) === f.head ? "b".repeat(40) : "a".repeat(40);
  const wrong = f.record(f.rows(), "wrong.json", wrongHead);
  const nullHead = f.record(f.rows(), "null.json", null);
  for (const [records, kind] of [
    [[empty], "missing"], [[truncated], "missing"], [[f.record([f.rows()[0]!], "mixed-good.json"), f.record([f.rows()[1]!], "mixed-bad.json", wrongHead)], "wrong-head"],
    [[wrong], "wrong-head"], [[nullHead], "wrong-head"],
  ] as const) {
    const result = await run(f.root, records, [complete], summary, summary);
    expect(result.code).toBe(1);
    expect(result.defects).toContainEqual(expect.objectContaining({ form: "serial", kind }));
  }
});

test("test: a summary path outside --root and a malformed record or summary exit 2 UNREADABLE versus paths under --root normalizing to the same repository paths in both forms", async () => {
  const f = fixture();
  const record = f.record(f.rows(), "record.json");
  const runnerRoot = join(f.root, "runner-checkout");
  const runnerBase = (): Summary => Object.fromEntries(Object.entries(f.base()).map(([path, counters]) =>
    [path.replace(f.root, runnerRoot), counters]));
  const a = f.summary(runnerBase(), "a.json");
  const variant = runnerBase();
  variant[`${runnerRoot}/src/graph/../graph/a.ts`] = variant[join(runnerRoot, "src/graph/a.ts")]!;
  delete variant[join(runnerRoot, "src/graph/a.ts")];
  const b = f.summary(variant, "b.json");
  expect((await run(f.root, [record], [record], a, b, runnerRoot)).code).toBe(0);
  const outside = runnerBase();
  outside[join(f.root, "src/foreign.ts")] = source();
  const outsideResult = await run(f.root, [record], [record], a, f.summary(outside, "outside.json"), runnerRoot);
  expect(outsideResult.code).toBe(2);
  expect(outsideResult.verdict).toBe("PARITY verdict=UNREADABLE files=UNREADABLE sources=UNREADABLE globs=UNREADABLE defects=1");
  expect(outsideResult.defects).toContainEqual(expect.objectContaining({ kind: "unreadable" }));
  const malformed = join(f.root, "bad-record.json");
  writeFileSync(malformed, "{");
  expect((await run(f.root, [malformed], [record], a, b, runnerRoot)).code).toBe(2);
  // a record of the previous format (F2: no reason, unhandled errors or test entries) is another schema
  const formatTwo = join(f.root, "f2-record.json");
  writeFileSync(formatTwo, JSON.stringify({ schema: "tickmarkr-ci-record/1", head: f.head, shard: null, files: f.rows() }));
  expect((await run(f.root, [formatTwo], [record], a, b, runnerRoot)).code).toBe(2);
  writeFileSync(join(f.root, "bad-summary.json"), readFileSync(a, "utf8").slice(0, 10));
  expect((await run(f.root, [record], [record], join(f.root, "bad-summary.json"), b, runnerRoot)).code).toBe(2);
});
