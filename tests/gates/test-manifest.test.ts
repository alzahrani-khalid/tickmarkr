import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline, compareToBaseline, type Baseline, type BaselineCommand } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { fileHangBudgetMs, isVitestTestCommand, readTestReport } from "../../src/gates/test-manifest.js";
import { validateGraph } from "../../src/graph/schema.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const install = join(process.cwd(), "node_modules");
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (repo: string) => { git(repo, "add", "-A"); git(repo, "commit", "--no-gpg-sign", "-m", "fixture"); };
const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" }, tasks: [
  { id: "T1", title: "report", goal: "report", shape: "implement", complexity: 3, gates: ["build", "test", "lint", "evidence", "scope"], acceptance: ["done"], files: ["**"] },
] }).tasks[0];

function fixture(real = true) {
  const repo = makeRepo({
    ".gitignore": "node_modules/\n*.receipt\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "tests/a.test.ts": 'import { a } from "../src/a"; test("alpha identity", () => expect(a).toBeGreaterThan(0));\n',
    "tests/b.test.ts": 'import { b } from "../src/b"; test("beta identity", () => expect(b).toBe(2));\n',
    "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals" } }),
  });
  if (real) symlinkSync(install, join(repo, "node_modules"), "dir");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 3;\n"); commit(repo);
  return { repo, base, artifacts: makeTestTempDir("vl1-artifacts-") };
}
type Fixture = ReturnType<typeof fixture>;
function baseline(cmd: string, over: Partial<BaselineCommand> = {}): Baseline {
  return { commands: { test: { cmd, exitCode: 0, fingerprints: [], ceilingMs: 30_000, fileCount: 999, ...over } } } as Baseline;
}
async function round(f: Fixture, cmd = "vitest run --globals", over: Partial<BaselineCommand> = {}, selected = false) {
  const out = await runGates(task, {
    worktree: f.repo, baseRef: f.base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
    result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: cmd }, baseline: baseline(cmd, over),
    channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), pipeline: "v185", artifactDir: f.artifacts, selectTests: selected,
  });
  expect(out.results.filter(r => r.gate === "test")).toHaveLength(1);
  return out.results.find(r => r.gate === "test")!;
}
function receipt(f: Fixture, name: string) { return join(f.repo, name + ".receipt"); }
/** Only fault injection uses a stand-in. Each independent case records list and run separately. */
function fault(f: Fixture, name: string, mode: string) {
  mkdirSync(join(f.repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(f.repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const marker = ${JSON.stringify(receipt(f, name))};
const selected = args.includes('tests/a.test.ts');
const files = selected ? ['tests/a.test.ts'] : ['tests/a.test.ts','tests/b.test.ts'];
if (args[0] === 'list') {
  fs.writeFileSync(marker + '.list.receipt', JSON.stringify(args));
  if (mode === 'list') { console.error('case-specific cannot list'); process.exit(2); }
  console.log(JSON.stringify(files.map(file => ({file: path.resolve(file), name: file})))); process.exit(0);
}
fs.writeFileSync(marker, JSON.stringify({ args, pid: process.pid }));
if (mode === 'refuse') { console.error('case-specific refused reporter'); process.exit(2); }
if (mode === 'absent') process.exit(0);
if (mode === 'selected-missing' && selected) {
  // Positive screen delegates to the real runner and the real reporter; only the full run is faulty.
  const cp = require('child_process');
  const result = cp.spawnSync(process.execPath, [${JSON.stringify(join(install, "vitest/vitest.mjs"))}, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const present = mode === 'missing' || mode === 'selected-missing' ? files.slice(0,1) : files;
const now = Date.now();
const report = { nonce: mode === 'stale' ? 'prior-invocation' : process.env.TICKMARKR_TEST_NONCE,
  requested: [...present], started: Object.fromEntries(present.map(f => [f, now])),
  completed: Object.fromEntries(present.map(f => [f, {at: now, status: 'passed'}])), certificate: {at: now, exitCode: 0} };
if (mode === 'duplicate') report.requested.push(present[0]);
if (mode === 'terminal') delete report.certificate;
if (mode === 'hang') { report.started = {[files[0]]: now}; report.completed = {}; delete report.certificate; }
if (mode === 'failed' || mode === 'failed-zero') { report.completed[files[0]] = {at: now, status: 'failed', failures: ['FAIL tests/a.test.ts > injected assertion']}; report.certificate.exitCode = 1; }
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify(report));
if (mode === 'hang') setInterval(() => {}, 1000);
else process.exit(mode === 'contradiction' || mode === 'failed' ? 1 : 0);
`, { mode: 0o755 });
}
function executed(f: Fixture, name: string, row: Awaited<ReturnType<typeof round>>, cmd: string) {
  expect(existsSync(receipt(f, name)), `${name}: ${row.details}`).toBe(true);
  const got = JSON.parse(readFileSync(receipt(f, name), "utf8"));
  expect(got.args.some((a: string) => a.startsWith("--reporter="))).toBe(true);
  expect(got.args.some((a: string) => a.startsWith("--outputFile="))).toBe(true);
  expect(String(row.meta?.spawnedCommand).startsWith(cmd)).toBe(true);
  if (row.meta?.nonce) expect(got.args.join(" ")).toContain(row.meta.nonce);
  return got;
}

test("through runGates the repository's installed vitest run with the gate's reporter passes on exit zero when its report carries the gate's nonce, succeeds and names every manifest file exactly once, passes the same way through a package script naming a custom config and project whose listed manifest is exactly that selection, and with one failing test is a work result carrying that test's fingerprint on its nonzero exit, while a stand-in runner resolved as the worktree's vitest whose report omits one listed manifest file is an infra result naming that file though its exit is zero, and whose report carries a prior invocation's nonce, names one file twice, or lacks its terminal record fails closed naming that fault, so a gate that trusts the exit code, the stdout file count, a listing taken from different arguments, or a report without completion fails", async () => {
  const f = fixture();
  const green = await round(f);
  expect(green.pass, green.details).toBe(true);
  const report = readTestReport(green.meta!.reportPath as string)!;
  expect(report.nonce).toBe(green.meta!.nonce);
  expect(report.requested.sort()).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  expect(Object.keys(report.started).sort()).toEqual(report.requested);
  expect(Object.keys(report.completed).sort()).toEqual(report.requested);
  expect(report.certificate?.exitCode).toBe(0);
  writeFileSync(join(f.repo, "custom.config.mjs"), JSON.stringify({test:{projects:[{test:{name:"chosen",globals:true,include:["tests/a.test.ts"]}},{test:{name:"other",globals:true,include:["tests/b.test.ts"]}}]}}).replace(/^/, 'if (process.env.VL1_SELECTION !== "chosen") throw new Error("script environment lost"); export default '));
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({type:"module", scripts:{chosen:"VL1_SELECTION=chosen vitest run --configLoader runner --config custom.config.mjs --project chosen"}})); commit(f.repo);
  const custom = await round(f, "npm run chosen -- -t 'alpha identity'");
  expect(custom.pass, custom.details).toBe(true);
  expect(custom.meta!.manifest).toEqual(["tests/a.test.ts"]);
  expect(custom.meta!.spawnedCommand).toContain("npm run chosen -- -t 'alpha identity' --reporter=");
  writeFileSync(join(f.repo, "tests/b.test.ts"), 'test("real failure fingerprint", () => expect(1).toBe(2));'); commit(f.repo);
  const red = await round(f);
  expect(red.pass).toBe(false); expect(red.meta?.classification).toBe("regression");
  expect(red.meta?.processExit).toBe(1); expect(red.details).toContain("real failure fingerprint");
  for (const [mode, reason] of [["missing", "tests/b.test.ts"], ["stale", "prior-invocation"], ["duplicate", "more than once"], ["terminal", "terminal"]]) {
    const broken = fixture(false); fault(broken, mode, mode);
    expect(existsSync(receipt(broken, mode))).toBe(false);
    const row = await round(broken);
    executed(broken, mode, row, "vitest run --globals");
    expect(row.pass).toBe(false); expect(row.meta?.classification).toBe("infra"); expect(row.details).toContain(reason);
  }
}, 90_000);

test("verifyIntegrationTip and runGates each spawn the worktree's vitest with the gate's reporter, persist that invocation's report beside their artifacts at the path their result row names, and reach the report's verdict with the stdout deficit rule never consulted even when the runner prints fewer files than the baseline recorded, while a scripted test command that is not the runner produces the base's exact result row through both entry points, so a verify that counts files, a report left unpersisted, or a scripted command routed through the report fails", async () => {
  const f = fixture();
  const cmd = "npm test";
  const gate = await round(f, cmd);
  const [tip] = await verifyIntegrationTip(f.repo, {test:cmd}, f.artifacts, baseline(cmd));
  for (const path of [gate.meta!.reportPath as string, tip.reportPath!]) {
    expect(dirname(path)).toBe(f.artifacts); expect(readTestReport(path)?.certificate?.exitCode).toBe(0);
  }
  expect(gate.pass, gate.details).toBe(true); expect(tip.pass, tip.details).toBe(true);
  expect(tip.spawnedCommand).toContain("npm test -- --reporter=");
  expect(tip.reportPath).not.toBe(gate.meta!.reportPath);
  writeFileSync(join(f.repo, "vitest.config.ts"), "export default {};\n");
  writeFileSync(join(f.repo, "scripted.sh"), "exit 0\n");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({scripts:{test:"sh scripted.sh",coverage:"vitest run"}})); commit(f.repo);
  for (const scripted of ["sh scripted.sh", "npm test"]) {
    expect(isVitestTestCommand(scripted, f.repo)).toBe(false);
    const base = baseline(scripted, {fileCount: null});
    const expected = (await compareToBaseline(f.repo, {test:scripted}, base, ["test"]))[0];
    const actual = await round(f, scripted, {fileCount:null});
    // runGates adds the same volatile measurement fields to every base result row.
    const { meta: measurement, ...rowWithoutMeasurement } = actual;
    expect(Object.keys(measurement!).sort()).toEqual(["durationMs","load1End","load1Max","load1Mean","load1Start"]);
    expect(rowWithoutMeasurement).toEqual(expected);
    const [tipScript] = await verifyIntegrationTip(f.repo, {test:scripted}, f.artifacts, base);
    expect(tipScript).toEqual({gate:"test",cmd:scripted,pass:true,exitCode:0,fingerprints:[],details:"exit 0"});
  }
}, 90_000);

test("through runGates a round whose diff is covered by a selected screen passes the screen on the selected manifest alone and holds until the merge-candidate full suite's report names every file the full invocation listed, and a full suite whose report lacks one file of that full manifest ends the round with its one test result an infra result naming that file, so a selected green that merges or a full manifest satisfied by the selected set fails", async () => {
  const f = fixture();
  const row = await round(f, "vitest run --globals", {}, true);
  expect(row.pass, row.details).toBe(true);
  expect(row.meta).toMatchObject({selectedTests:["tests/a.test.ts"],fullSuite:true,manifest:["tests/a.test.ts","tests/b.test.ts"]});
  const reports = (await import("node:fs")).readdirSync(f.artifacts).filter(p => p.startsWith("test-manifest-report-"));
  expect(reports).toHaveLength(2);
  expect(reports.map(p => readTestReport(join(f.artifacts,p))!.requested.length).sort()).toEqual([1,2]);
  const broken = fixture(false);
  fault(broken, "selected-full", "selected-missing");
  const bad = await round(broken, "vitest run --globals", {}, true);
  expect(bad.pass).toBe(false); expect(bad.meta?.classification).toBe("infra"); expect(bad.details).toContain("tests/b.test.ts");
  const snapshots = (await import("node:fs")).readdirSync(broken.artifacts).filter(p => p.startsWith("test-manifest-report-"));
  expect(snapshots).toHaveLength(2);
  const screen = snapshots.map(p => readTestReport(join(broken.artifacts,p))!).find(r => r.requested.length === 1 && r.completed["tests/a.test.ts"]);
  expect(screen?.certificate?.exitCode).toBe(0);
  executed(broken, "selected-full", bad, "vitest run --globals");
}, 90_000);

test("through runGates a fixture baseline with known per-file durations yields for each timed file the larger of three times its duration and the longest usable duration capped at the battery ceiling, three times the longest usable for an untimed file, and the positive battery ceiling when nothing usable was timed, including a baseline whose observations are all zero and a legacy baseline keeping only a zero longestFile, each budgeting at the ceiling rather than terminating at once, a stand-in runner resolved as the worktree's vitest that writes a file's started record and never completes it is killed at that file's budget with an infra hang result naming the file and the budget and the runner's process group gone, the same kill names the file when its budget equals the battery ceiling, and the same runner completing that file with a failed test is a work result, so a budget derived from the gate under test, a zero or non-finite duration used as a timing, a hang left to the battery ceiling, a hang reported as a regression, or an untimed file killed at zero fails", async () => {
  const timings = [{file:"tests/a.test.ts",durationMs:40},{file:"tests/b.test.ts",durationMs:100},{file:"zero",durationMs:0},{file:"nan",durationMs:NaN},{file:"inf",durationMs:Infinity}];
  expect(fileHangBudgetMs("tests/a.test.ts",timings,1000)).toBe(120);
  expect(fileHangBudgetMs("tests/b.test.ts",timings,200)).toBe(200);
  expect(fileHangBudgetMs("missing",timings,1000)).toBe(300);
  expect(fileHangBudgetMs("zero",timings,1000)).toBe(300);
  expect(fileHangBudgetMs("nan",timings,1000)).toBe(300);
  expect(fileHangBudgetMs("inf",timings,1000)).toBe(300);
  const cases: Array<[string, Partial<BaselineCommand>, number]> = [
    ["timed",{fileDurations:timings,ceilingMs:3000},120],
    ["longest-wins",{fileDurations:[{file:"tests/a.test.ts",durationMs:10},{file:"b",durationMs:180}],ceilingMs:3000},180],
    ["untimed",{fileDurations:[{file:"b",durationMs:60}],ceilingMs:3000},180],
    ["legacy",{longestFile:{file:"tests/a.test.ts",durationMs:60},ceilingMs:3000},180],
    ["none",{ceilingMs:5000},5000],
    ["zero",{fileDurations:[{file:"tests/a.test.ts",durationMs:0}],ceilingMs:5000},5000],
    ["legacy-zero",{longestFile:{file:"a",durationMs:0},ceilingMs:5000},5000],
    ["equal",{fileDurations:[{file:"tests/a.test.ts",durationMs:5000}],ceilingMs:5000},5000],
  ];
  for (const [name, timing, budget] of cases) {
    const f = fixture(false); fault(f,name,"hang");
    expect(existsSync(receipt(f,name))).toBe(false);
    const row = await round(f,"vitest run --globals",timing);
    executed(f,name,row,"vitest run --globals");
    expect(row.meta, row.details).toMatchObject({classification:"infra",kind:"hang",file:"tests/a.test.ts",hangBudgetMs:budget});
    expect(row.details).toContain(String(budget));
    expect(() => process.kill(-(row.meta!.pid as number),0)).toThrow(/ESRCH/);
  }
  for (const mode of ["failed","failed-zero"]) {
    const f = fixture(false); fault(f,mode,mode);
    const row = await round(f,"vitest run --globals",{fileDurations:timings,ceilingMs:3000});
    executed(f,mode,row,"vitest run --globals");
    expect(row.meta?.classification).toBe("regression"); expect(row.details).toContain("injected assertion");
  }
  const capture = fixture(false);
  writeFileSync(join(capture.repo,"timings.sh"), "printf ' ✓ tests/a.test.ts (1 test) 0ms\\n ✓ tests/b.test.ts (1 test) 12ms\\n ✓ tests/c.test.ts (1 test) 2s\\n'\n");
  const captured = await captureBaseline(capture.repo,{test:"sh timings.sh"});
  expect(captured.commands.test.fileDurations).toEqual([{file:"tests/a.test.ts",durationMs:0},{file:"tests/b.test.ts",durationMs:12},{file:"tests/c.test.ts",durationMs:2000}]);
}, 90_000);

test("through runGates a stand-in runner resolved as the worktree's vitest whose run branch alone writes a fresh case-specific marker recording its argv, absent before the gate and never written by its list branch, proves each case executed: its report written successful beside its own nonzero exit fails closed naming both, and its zero exit with no report fails closed naming the missing report, each with that case's marker present, its argv carrying the reporter, and the result row's spawned command line beginning with the configured command verbatim, so a fixture whose runner never ran, a marker any branch or an earlier case could leave, a configured command rewritten before it is spawned, or a report that rescues a red exit fails", async () => {
  for (const [mode, reason] of [["contradiction","process exited 1"],["absent","missing report"]]) {
    const f = fixture(false); fault(f,mode,mode);
    expect(existsSync(receipt(f,mode))).toBe(false);
    const row = await round(f,"npm test");
    executed(f,mode,row,"npm test");
    expect(row.pass).toBe(false); expect(row.meta?.classification).toBe("infra"); expect(row.details).toContain(reason);
    if (mode === "contradiction") expect(row.details).toContain("exit 0");
  }
}, 90_000);

test("through runGates a test command whose package script invokes vitest fails closed as an infra result naming the runner and the cause when the runner cannot list its files, when the runner refuses the gate's reporter, when no vitest binary exists in the worktree, and when the script body is compound with vitest followed by a second command, while none of the four is re-classified as a scripted command and the absent binary expects no execution marker, so a gate that falls back to the exit-code contract, forwards reporter arguments to a compound script's last command, or passes a zero exit with no report fails", async () => {
  for (const [mode, reason] of [["list","cannot list"],["refuse","refused reporter"],["missing-binary","binary does not exist"],["compound","compound"]]) {
    const f = fixture(false);
    if (mode !== "missing-binary") fault(f,mode,mode);
    if (mode === "compound") {
      writeFileSync(join(f.repo,"package.json"),JSON.stringify({scripts:{test:"vitest run && echo second"}})); commit(f.repo);
    }
    expect(existsSync(receipt(f,mode))).toBe(false);
    expect(isVitestTestCommand("npm test",f.repo)).toBe(true);
    const row = await round(f,"npm test");
    expect(row.pass).toBe(false); expect(row.meta?.classification).toBe("infra");
    expect(row.details).toContain("vitest"); expect(row.details).toContain(reason);
    if (mode === "refuse") executed(f,mode,row,"npm test");
    else expect(existsSync(receipt(f,mode))).toBe(false);
    if (mode === "list") expect(existsSync(receipt(f,mode)+".list.receipt")).toBe(true);
  }
}, 90_000);
