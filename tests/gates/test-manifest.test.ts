import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline, compareToBaseline, type Baseline, type BaselineCommand } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { fileHangBudgetMs, isVitestTestCommand, readTestReport, verifyManifestReport } from "../../src/gates/test-manifest.js";
import { preserveWorktree, shGitOk, VERIFICATION_PROTOCOL } from "../../src/run/git.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
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
    channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: f.artifacts, selectTests: selected,
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
if (mode === 'runner-red') {
  report.started = {}; report.completed = {};
  report.certificate.exitCode = 1; report.certificate.errors = 1;
  process.stdout.write('x'.repeat(20000) + 'runner stdout tail');
  process.stderr.write('y'.repeat(20000) + '\\nError EAGAIN\\n');
}
if (mode === 'duplicate') report.requested.push(present[0]);
if (mode === 'terminal') delete report.certificate;
if (mode === 'hang') { report.started = {[files[0]]: now}; report.completed = {}; delete report.certificate; }
if (mode === 'failed' || mode === 'failed-zero') { report.completed[files[0]] = {at: now, status: 'failed', failures: ['FAIL tests/a.test.ts > injected assertion']}; report.certificate.exitCode = 1; }
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify(report));
if (mode === 'hang') setInterval(() => {}, 1000);
else process.exit(mode === 'contradiction' || mode === 'runner-red' || mode === 'failed' ? 1 : 0);
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
  expect(red.meta?.failingFiles).toEqual(["tests/b.test.ts"]);
  for (const [mode, reason] of [["missing", "tests/b.test.ts"], ["stale", "prior-invocation"], ["duplicate", "more than once"], ["terminal", "terminal"]]) {
    const broken = fixture(false); fault(broken, mode, mode);
    expect(existsSync(receipt(broken, mode))).toBe(false);
    const row = await round(broken);
    executed(broken, mode, row, "vitest run --globals");
    expect(row.pass).toBe(false); expect(row.meta?.classification).toBe("infra"); expect(row.details).toContain(reason);
  }
}, 90_000);

test("failing file identities come from completed records, never failure prose or passed records", () => {
  const manifest = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
  const verdict = verifyManifestReport({ manifest, nonce: "this-run", exitCode: 1, report: {
    nonce: "this-run", requested: manifest, started: Object.fromEntries(manifest.map(file => [file, 1])),
    completed: {
      "tests/a.test.ts": { at: 2, status: "passed", failures: ["misleading tests/a.test.ts"] },
      "tests/c.test.ts": { at: 2, status: "failed" },
      "tests/b.test.ts": { at: 2, status: "failed", failures: ["FAIL invented/path.test.ts > arbitrary message"] },
    }, certificate: { at: 3, exitCode: 1 },
  } });
  expect(verdict.pass).toBe(false);
  expect(verdict.meta.failingFiles).toEqual(["tests/b.test.ts", "tests/c.test.ts"]);
  expect(verdict.meta.failingTests).toEqual(["<unnamed failure>", "FAIL invented/path.test.ts > arbitrary message"]);
});

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
    const { meta: measurement, evidenceReceipt: actualReceipt, evidenceReceipts: actualReceipts, ...rowWithoutMeasurement } = actual;
    // R41: `verification` (protocol + effective lifecycle) is the one non-volatile stamp every row carries.
    expect(Object.keys(measurement!).sort()).toEqual(["durationMs","load1End","load1Max","load1Mean","load1Start","verification"]);
    const { evidenceReceipt: expectedReceipt, evidenceReceipts: expectedReceipts, ...expectedVerdict } = expected;
    expect(rowWithoutMeasurement).toEqual(expectedVerdict);
    expect(actualReceipt?.invocationId).not.toBe(expectedReceipt?.invocationId);
    expect(actualReceipts).toHaveLength(1); expect(expectedReceipts).toHaveLength(1);
    const [tipScript] = await verifyIntegrationTip(f.repo, {test:scripted}, f.artifacts, base);
    expect(tipScript).toMatchObject({gate:"test",cmd:scripted,pass:true,exitCode:0,fingerprints:[],details:"exit 0"});
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

// R41: run one battery with an explicit process-scoped npm lifecycle policy, restoring the fork's env after.
async function underLifecycle<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.npm_config_ignore_scripts;
  if (value === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = value;
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = prior;
  }
}

test("through runGates a vitest suite holding a module whose whole body is skipped by describe.skipIf lists that module in its file-specification manifest beside the two executed ones, its report completes it as skipped with zero executed test bodies, the passing row names two executed and one skipped module and persists the expected manifest with the exact filesOnly listing invocation beside the report, a selected screen over the changed source and the added skipped file lists exactly those two and passes on its one executed module while the merge-candidate full manifest keeps all three, a report whose only manifest module is skipped fails closed naming no executed module, a skipped record's failure prose is ignored as a passed record's is, and a completion with an unknown status or malformed counts is rejected before any verdict, so a discovery that omits skipped modules, a pass that counts a skipped module as executed, or a verdict with no executed test body fails", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, "tests/c.test.ts"), 'describe.skipIf(true)("env-gated", () => { test("never runs here", () => expect(1).toBe(2)); });\n');
  commit(f.repo);
  const row = await underLifecycle("false", () => round(f));
  expect(row.pass, row.details).toBe(true);
  expect(row.meta?.manifest).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
  expect(row.meta?.executedModules).toBe(2);
  expect(row.meta?.skippedModules).toEqual(["tests/c.test.ts"]);
  expect(row.details).toMatch(/3 manifest file\(s\) present exactly once; 2 executed, 1 skipped whole \(tests\/c\.test\.ts\)/);
  expect(String(row.meta?.listingCommand)).toMatch(/ list --globals --filesOnly --json$/);
  expect(row.meta?.verification).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" });
  const report = readTestReport(String(row.meta?.reportPath))!;
  expect(report.completed["tests/c.test.ts"]).toMatchObject({ status: "skipped", tests: { passed: 0, failed: 0, skipped: 1 } });
  expect(report.completed["tests/a.test.ts"]).toMatchObject({ status: "passed", tests: { passed: 1, failed: 0, skipped: 0 } });
  const manifestPath = String(row.meta?.manifestPath);
  expect(existsSync(manifestPath)).toBe(true);
  const persisted = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(persisted).toMatchObject({ nonce: row.meta?.nonce, listingCommand: row.meta?.listingCommand, listingExit: 0, files: row.meta?.manifest });
  expect(typeof persisted.listingStdoutSha256).toBe("string");

  // Selected screen: the diff touches src/a.ts only, so the screen's own listing (filters forwarded
  // to the same filesOnly discovery) is exactly its covering file; the merge-candidate full suite
  // that supersedes it lists all three, the skipped module included.
  const g = fixture();
  writeFileSync(join(g.repo, "tests/c.test.ts"), 'describe.skipIf(true)("env-gated", () => { test("never runs here", () => expect(1).toBe(2)); });\n');
  commit(g.repo);
  const screened = await round(g, "vitest run --globals", {}, true);
  expect(screened.pass, screened.details).toBe(true);
  // The diff changed src/a.ts AND added tests/c.test.ts, so the screen selects both; its own
  // manifest (a executed, c skipped whole) passes on the one executed module before the full suite.
  expect(screened.meta?.selectedTests).toEqual(["tests/a.test.ts", "tests/c.test.ts"]);
  expect(screened.meta?.fullSuite).toBe(true);
  expect(screened.meta?.manifest).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
  expect(screened.meta?.skippedModules).toEqual(["tests/c.test.ts"]);

  // Nothing executed is not a verdict.
  const now = Date.now();
  const onlySkipped = verifyManifestReport({ manifest: ["tests/c.test.ts"], nonce: "n", exitCode: 0, report: { nonce: "n",
    requested: ["tests/c.test.ts"], started: { "tests/c.test.ts": now },
    completed: { "tests/c.test.ts": { at: now, status: "skipped", tests: { passed: 0, failed: 0, skipped: 1 } } }, certificate: { at: now, exitCode: 0 } } });
  expect(onlySkipped).toMatchObject({ kind: "fail-closed", pass: false, meta: { infra: true, noExecutedModules: true, skippedModules: ["tests/c.test.ts"] } });
  expect(onlySkipped.details).toMatch(/no test body executed/);
  // A skipped record's failure prose is ignored exactly as a passed record's is (the pinned contract
  // above: failing identities come from FAILED completions only); an unknown status or malformed
  // counts never parse into a report at all.
  const skippedProse = verifyManifestReport({ manifest: ["tests/a.test.ts", "tests/b.test.ts"], nonce: "n", exitCode: 0, report: { nonce: "n",
    requested: ["tests/a.test.ts", "tests/b.test.ts"], started: { "tests/a.test.ts": now, "tests/b.test.ts": now },
    completed: { "tests/a.test.ts": { at: now, status: "skipped", failures: ["misleading tests/a.test.ts"] }, "tests/b.test.ts": { at: now, status: "passed" } },
    certificate: { at: now, exitCode: 0 } } });
  expect(skippedProse).toMatchObject({ kind: "pass", pass: true, meta: { executedModules: 1, skippedModules: ["tests/a.test.ts"] } });
  const bogus = join(f.artifacts, "bogus-status.json");
  writeFileSync(bogus, JSON.stringify({ nonce: "n", requested: ["tests/a.test.ts"], started: { "tests/a.test.ts": now },
    completed: { "tests/a.test.ts": { at: now, status: "bogus" } }, certificate: { at: now, exitCode: 0 } }));
  expect(readTestReport(bogus)).toBeUndefined();
  const badCounts = join(f.artifacts, "bad-counts.json");
  writeFileSync(badCounts, JSON.stringify({ nonce: "n", requested: ["tests/a.test.ts"], started: { "tests/a.test.ts": now },
    completed: { "tests/a.test.ts": { at: now, status: "passed", tests: { passed: "1", failed: 0, skipped: 0 } } }, certificate: { at: now, exitCode: 0 } }));
  expect(readTestReport(badCounts)).toBeUndefined();
}, 120_000);

test("through runGates a scratch checkout whose package declares pretest npm run build and whose only test imports the ignored dist that build writes passes its test gate under an explicit process-scoped npm_config_ignore_scripts=false with dist provisioned by the hook and the row recording lifecycle hooks, the same checkout with dist removed under npm_config_ignore_scripts=true fails closed as infra on a report whose lifecycle started no module beside exit one with dist still absent and the row recording lifecycle ignore-scripts, and with no explicit policy the row records the policy measured from npm's resolved config with the outcome agreeing with it, so a runner child that does not receive the process policy, a verdict that hides which lifecycle it ran under, or a provisioning claimed by anything but the hook fails", async () => {
  const repo = makeRepo({
    ".gitignore": "node_modules/\ndist/\n",
    "build.mjs": 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/a.js", "export const a = 1;\\n");\n',
    "tests/a.test.ts": 'import { a } from "../dist/a.js"; test("built identity", () => expect(a).toBe(1));\n',
    "package.json": JSON.stringify({ type: "module", scripts: { pretest: "npm run build", build: "node build.mjs", test: "vitest run --globals" } }),
  });
  symlinkSync(install, join(repo, "node_modules"), "dir");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "tests/a.test.ts"), 'import { a } from "../dist/a.js"; test("built identity", () => expect(a).toBe(1)); // touched\n'); commit(repo);
  const f: Fixture = { repo, base, artifacts: makeTestTempDir("vl1-lifecycle-") };
  const dist = join(repo, "dist/a.js");
  expect(existsSync(dist)).toBe(false);

  const hooks = await underLifecycle("false", () => round(f, "npm test"));
  expect(hooks.pass, hooks.details).toBe(true);
  expect(existsSync(dist)).toBe(true);
  expect(hooks.meta?.verification).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" });
  expect(String(hooks.meta?.spawnedCommand).startsWith("npm test")).toBe(true);

  rmSync(join(repo, "dist"), { recursive: true, force: true });
  writeFileSync(join(repo, "tests/a.test.ts"), 'import { a } from "../dist/a.js"; test("built identity", () => expect(a).toBe(1)); // again\n'); commit(repo);
  const ignored = await underLifecycle("true", () => round(f, "npm test"));
  // Without the hook there is no dist, so the module cannot even load: vitest starts no module and
  // exits 1, and the gate fails CLOSED on a certificate that names no failed test beside a nonzero
  // exit — never a regression verdict, never a pass. The report itself shows the empty lifecycle.
  expect(ignored.pass).toBe(false);
  expect(ignored.meta?.classification).toBe("infra");
  expect(ignored.meta?.processExit).toBe(1);
  expect(ignored.details).toMatch(/report has no failed tests but the process exited 1/);
  const unloaded = readTestReport(String(ignored.meta?.reportPath))!;
  expect({ requested: unloaded.requested, started: unloaded.started, completed: unloaded.completed, exit: unloaded.certificate?.exitCode })
    .toEqual({ requested: ["tests/a.test.ts"], started: {}, completed: {}, exit: 1 });
  expect(existsSync(dist)).toBe(false);
  expect(ignored.meta?.verification).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle: "ignore-scripts", source: "explicit" });

  writeFileSync(join(repo, "tests/a.test.ts"), 'import { a } from "../dist/a.js"; test("built identity", () => expect(a).toBe(1)); // third\n'); commit(repo);
  const measured = await underLifecycle(undefined, () => round(f, "npm test"));
  // With no explicit export the policy is MEASURED from npm's resolved config for this checkout —
  // the host's npmrc, which this test does not own — and the outcome must agree with it.
  const policy = measured.meta?.verification as { protocol: string; lifecycle: string; source: string };
  expect(policy).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle: expect.stringMatching(/^(hooks|ignore-scripts)$/), source: "npm-config" });
  expect({ pass: measured.pass, dist: existsSync(dist), classification: measured.meta?.classification })
    .toEqual(policy.lifecycle === "hooks" ? { pass: true, dist: true, classification: undefined } : { pass: false, dist: false, classification: "infra" });
}, 180_000);

const SCRATCH_PRETEST_FILES = {
  ".gitignore": "node_modules/\ndist/\n",
  "build.mjs": 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/a.js", "export const a = 1;\\n");\n',
  "tests/a.test.ts": 'import { a } from "../dist/a.js"; test("built identity", () => expect(a).toBe(1));\n',
  "package.json": JSON.stringify({ type: "module", scripts: { pretest: "npm run build", build: "node build.mjs", test: "vitest run --globals" } }),
};

test("through the production worktree recreation on one preserved clean commit, where the task checkout is preserved and re-added from its base with node_modules linked and nothing built and its carried commit is cherry-picked back so the gated tree is byte-identical, a battery whose build verdict is the compatible cached green of the prior checkout runs no build command so the recreated checkout still has no dist, and under an explicit lifecycle hooks its test gate actually runs with pretest provisioning dist inside the recreated checkout before the one module starts, completes and passes, while the same recreation under lifecycle ignore-scripts reuses the same build green, runs the test, starts no module and fails closed with dist still absent, so a recreation that inherits a build without its artifacts, a test gate that does not run, or a provisioning by anything but the hook fails", async () => {
  for (const [value, lifecycle] of [["false", "hooks"], ["true", "ignore-scripts"]] as const) {
    const repo = makeRepo(SCRATCH_PRETEST_FILES);
    symlinkSync(install, join(repo, "node_modules"), "dir");
    const base = git(repo, "rev-parse", "HEAD");
    const driver = new SubprocessDriver();
    const branch = "tickmarkr/r41-recreate--T1";
    const wt = await driver.worktree(repo, branch, base);
    writeFileSync(join(wt, "tests/a.test.ts"), 'import { a } from "../dist/a.js"; test("built identity", () => expect(a).toBe(1)); // carried\n'); commit(wt);
    const tip = git(wt, "rev-parse", "HEAD");
    const tipTree = git(wt, "rev-parse", "HEAD^{tree}");
    const artifacts = makeTestTempDir("vl1-recreate-");
    const stateDir = makeTestTempDir("vl1-recreate-state-");
    const bl = { commands: {
      build: { cmd: "npm run build", exitCode: 0, fingerprints: [] },
      test: { cmd: "npm test", exitCode: 0, fingerprints: [], ceilingMs: 30_000, fileCount: 999 },
    } } as unknown as Baseline;
    const battery = (worktree: string, commands: Record<string, string>) => runGates(task, {
      worktree, baseRef: base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
      result: { ok: true, summary: "done", deviations: [], raw: "" }, commands, baseline: bl,
      channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: artifacts, stateDir,
    });

    // The prior checkout: the build gate ran for real and left dist behind; its green is cached.
    const prior = await underLifecycle(value, () => battery(wt, { build: "npm run build" }));
    const priorBuild = prior.results.find((r) => r.gate === "build")!;
    expect(priorBuild.pass, priorBuild.details).toBe(true);
    expect(priorBuild.meta?.reused).toBeUndefined();
    expect(existsSync(join(wt, "dist/a.js"))).toBe(true);
    expect(priorBuild.meta?.verification).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle, source: "explicit" });

    // The production recreation the daemon performs: preserve (nothing to preserve on a clean
    // checkout), re-add the worktree from its base, link node_modules only, carry the commit back.
    expect(await preserveWorktree(wt)).toBeUndefined();
    const recreated = await driver.worktree(repo, branch, base);
    expect(recreated).toBe(wt);
    expect(git(recreated, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(recreated, "dist"))).toBe(false);
    expect(lstatSync(join(recreated, "node_modules")).isSymbolicLink()).toBe(true);
    await shGitOk(`git cherry-pick ${tip}`, recreated);
    expect(git(recreated, "rev-parse", "HEAD^{tree}")).toBe(tipTree);
    expect(existsSync(join(recreated, "dist"))).toBe(false);

    const round2 = await underLifecycle(value, () => battery(recreated, { build: "npm run build", test: "npm test" }));
    const build2 = round2.results.find((r) => r.gate === "build")!;
    expect(build2.pass).toBe(true);
    expect(build2.meta?.reused).toBe(true);
    expect(String(build2.details)).toMatch(new RegExp(`reused verdict \\(identity: gate=build .*lifecycle=${lifecycle} \\(explicit\\)\\]`));
    const test2 = round2.results.find((r) => r.gate === "test")!;
    expect(String(test2.meta?.spawnedCommand).startsWith("npm test -- --reporter=")).toBe(true);
    expect(test2.meta?.verification).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle, source: "explicit" });
    const report = readTestReport(String(test2.meta?.reportPath))!;
    expect(report.requested).toEqual(["tests/a.test.ts"]);
    if (lifecycle === "hooks") {
      expect(test2.pass, test2.details).toBe(true);
      expect(existsSync(join(recreated, "dist/a.js"))).toBe(true);
      expect(report.started).toHaveProperty("tests/a.test.ts");
      expect(report.completed["tests/a.test.ts"]).toMatchObject({ status: "passed", tests: { passed: 1, failed: 0, skipped: 0 } });
      expect(report.certificate?.exitCode).toBe(0);
      expect(test2.meta?.executedModules).toBe(1);
    } else {
      expect(test2.pass).toBe(false);
      expect(test2.meta?.classification).toBe("infra");
      expect(existsSync(join(recreated, "dist"))).toBe(false);
      expect({ started: report.started, completed: report.completed, exit: report.certificate?.exitCode }).toEqual({ started: {}, completed: {}, exit: 1 });
    }
  }
}, 240_000);

test("test: a manifested vitest run whose report is green but whose runner prints Error EAGAIN and exits 1 yields a failed test gate row retaining classification infra with a runner-level diagnostic, the available never-started and reporter error counts and the EAGAIN line, and persists the runner's stdout and stderr tail beside the manifest report while unavailable counts read unknown, so a red that records only the certificate or changes the existing verdict or classification fails", async () => {
  const f = fixture(false);
  fault(f, "runner-red", "runner-red");
  const row = await round(f);
  expect(row.pass).toBe(false);
  expect(row.meta?.classification).toBe("infra");
  expect(row.details).toContain("report has no failed tests but the process exited 1");
  expect(row.details).toContain("classification: infra; runner-level diagnostic: never-started 2; reporter errors 1");
  expect(row.details).toContain("Error EAGAIN");
  for (const [key, ending] of [["stdoutPath", "runner stdout tail"], ["stderrPath", "Error EAGAIN\n"]]) {
    const path = String(row.meta?.[key]);
    expect(path).toBe(join(f.artifacts, row.evidenceReceipt![key === "stdoutPath" ? "stdout" : "stderr"].path));
    const bytes = readFileSync(path);
    expect(bytes.length).toBe(16 * 1024);
    expect(bytes.toString().endsWith(ending)).toBe(true);
  }
  const old = fixture(false);
  fault(old, "contradiction", "contradiction");
  const oldRow = await round(old);
  expect(oldRow.pass).toBe(false);
  expect(oldRow.meta?.classification).toBe("infra");
  expect(oldRow.details).toContain("never-started 0; reporter errors unknown");
  const absent = fixture(false);
  fault(absent, "absent", "absent");
  expect((await round(absent)).details).toContain("never-started unknown; reporter errors unknown");
}, 60_000);

test("test: a manifested run with one module that fails to load yields a certificate carrying errors 1 and a gate row whose details name that module's load error while its classification and pass verdict are exactly what the same report produced before this change, so a load error recorded without its module name or a row whose verdict moved fails", async () => {
  const f = fixture();
  rmSync(join(f.repo, "tests/b.test.ts"));
  writeFileSync(join(f.repo, "tests/a.test.ts"), 'import "../missing-module.js"; test("unreachable", () => {});\n');
  commit(f.repo);
  const row = await round(f);
  const report = readTestReport(String(row.meta?.reportPath))!;
  expect(report.certificate?.errors).toBe(1);
  expect(row.details).toContain("tests/a.test.ts");
  expect(row.details).toContain("missing-module");
  const before = structuredClone(report);
  delete before.certificate!.errors;
  delete before.certificate!.diagnostics;
  const verdict = verifyManifestReport({ manifest: row.meta!.manifest as string[], nonce: report.nonce, report: before, exitCode: 1 });
  expect(row.pass).toBe(verdict.pass);
  expect(row.meta?.classification).toBe(verdict.meta.classification);
  expect(row.pass).toBe(false);
  expect(row.meta?.classification).toBe("infra");
}, 60_000);

test("test: through the test gate a vitest run holding one failing assertion yields a failed row whose meta carries that failure's evidence beside an unchanged regression classification, so a verdict that drops the evidence fails", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, "tests/b.test.ts"), 'test("scope list", () => expect({ files: ["src/nested/in-scope.ts"] }).toEqual({ files: ["src/nested/other.ts"] }));'); commit(f.repo);
  const red = await round(f);
  expect(red.pass).toBe(false);
  expect(red.meta?.classification).toBe("regression");
  expect(red.meta?.failingFiles).toEqual(["tests/b.test.ts"]);
  expect(red.meta?.failingTests).toHaveLength(1);
  const evidence = red.meta?.failureEvidence as Array<{ test: string; text: string }>;
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.test).toBe("tests/b.test.ts > scope list");
  expect(evidence[0]!.text).toContain("src/nested/in-scope.ts");
  expect(Buffer.byteLength(evidence[0]!.text)).toBeLessThanOrEqual(4096);
}, 60_000);

test("test: a test gate receipt carries the invocation nonce beside the same artifact hash and count fields as build and lint, so a test row whose paths carry no hash fails", async () => {
  const { createHash } = await import("node:crypto");
  const { GateEvidenceReceiptSchema } = await import("../../src/run/protocol.js");
  const { evaluateManifestedTest } = await import("../../src/gates/test-manifest.js");
  const f = fixture(false); fault(f, "evidence", "runner-red");
  const row = await evaluateManifestedTest("vitest run --globals", f.repo, { artifactDir: f.artifacts });
  const receipt = row.evidenceReceipt!;
  expect(GateEvidenceReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(receipt.invocationId).toBe(row.meta.nonce); expect(receipt.nonce).toBe(row.meta.nonce);
  for (const ref of [receipt.stdout, receipt.stderr]) {
    const bytes = readFileSync(join(f.artifacts, ref.path));
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(ref.retainedBytes).toBe(bytes.length); expect(ref.retainedBytes).toBe(16384);
    expect(ref.droppedBytes).toBeGreaterThan(0); expect(ref.truncated).toBe(true);
  }
});

test("test: one successful plus one failed executed command each under healthy or injected failing evidence persistence through the manifested or the non manifested production call keep pass classification plus recovery decision unchanged under capture-failed evidence whereas a command that failed to launch stays infra, so a successful command turned infra by a lost tail fails", async () => {
  const { evaluateManifestedTest } = await import("../../src/gates/test-manifest.js");
  const { failureDisposition } = await import("../../src/run/recovery.js");
  const { setSpawnForTests, resetSpawnForTests } = await import("../../src/run/git.js");
  const failWrite = () => { throw new Error("injected evidence disk failure"); };
  for (const failed of [false, true]) {
    const f = fixture(false); fault(f, "persistence", failed ? "failed" : "pass");
    const cmd = "vitest run --globals";
    const normal = await evaluateManifestedTest(cmd, f.repo, { artifactDir: f.artifacts });
    const lost = await evaluateManifestedTest(cmd, f.repo, { artifactDir: f.artifacts, evidence: { write: failWrite } });
    expect(lost.pass).toBe(!failed); expect(lost.pass).toBe(normal.pass);
    expect(lost.classification).toBe(normal.classification);
    expect(failureDisposition(lost)).toBe(failureDisposition(normal));
    expect(lost.evidenceReceipt?.availability).toBe("capture-failed");
    expect(normal.evidenceReceipt?.availability).toBe("available");
    for (const gate of ["build", "lint", "test"]) {
      const scripted = failed ? "echo 'Error: assertion broken'; exit 1" : "echo fine";
      const base = { commands: { [gate]: { exitCode: 0, fingerprints: [] } } };
      let retries = 0;
      const [healthy] = await compareToBaseline(f.repo, { [gate]: scripted }, base, [gate], { evidence: { artifactDir: f.artifacts }, authorizeRetry: () => { retries++; return false; } });
      const [broken] = await compareToBaseline(f.repo, { [gate]: scripted }, base, [gate], { evidence: { artifactDir: f.artifacts, write: failWrite }, authorizeRetry: () => { retries++; return false; } });
      expect(broken.pass).toBe(!failed); expect(broken.pass).toBe(healthy.pass);
      expect(broken.meta?.classification).toBe(healthy.meta?.classification);
      expect(failureDisposition(broken)).toBe(failureDisposition(healthy)); expect(retries).toBe(0);
      expect(broken.evidenceReceipt?.availability).toBe("capture-failed");
      const captured = await captureBaseline(f.repo, { [gate]: scripted }, { evidence: { artifactDir: f.artifacts, write: failWrite } });
      expect(captured.commands[gate].exitCode).toBe(failed ? 1 : 0);
      expect(captured.evidenceReceipts?.[gate].availability).toBe("capture-failed");
    }
  }
  const f = fixture(false); fault(f, "launch", "pass");
  try {
    setSpawnForTests(() => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); });
    const missing = await evaluateManifestedTest("vitest run", f.repo, { artifactDir: f.artifacts, evidence: { write: failWrite } });
    expect(missing.pass).toBe(false); expect(missing.classification).toBe("infra");
    expect(failureDisposition(missing)).toBe("infrastructure");
    expect(missing.evidenceReceipt?.availability).toBe("not-started");
    const [scripted] = await compareToBaseline(f.repo, { build: "echo fine" }, { commands: {} }, ["build"], { evidence: { artifactDir: f.artifacts, write: failWrite } });
    expect(scripted.pass).toBe(false); expect(failureDisposition(scripted)).toBe("infrastructure"); expect(scripted.evidenceReceipt?.availability).toBe("not-started");
    expect(scripted.evidenceReceipt?.termination.kind).toBe("not-started");
  } finally { resetSpawnForTests(); }
}, 30_000);

test("test: a receipt survives the dirty worktree substitution at both battery seams and binds run task attempt gate plus subject commit under distinct invocation ids across a retry a selected screen or the full suite, so a receipt lost at substitution or reused invocation ids fail", async () => {
  const { GateEvidenceReceiptSchema } = await import("../../src/run/protocol.js");
  const { setCalmWindowForTests, resetCalmWindowForTests } = await import("../../src/gates/baseline.js");
  const allIds: string[] = [];
  for (const fullOnly of [false, true]) {
    const f = fixture(false);
    writeFileSync(join(f.repo, "gate.sh"), `if ${fullOnly ? '[ "$#" = 0 ]' : 'true'}; then echo dirty >> src/a.ts; fi\necho completed\n`); commit(f.repo);
    const subjectCommit = git(f.repo, "rev-parse", "HEAD");
    const cmd = "sh gate.sh";
    const result = await runGates(task, {
      worktree: f.repo, baseRef: f.base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
      result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: cmd }, baseline: baseline(cmd, { fileCount: null }),
      channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: f.artifacts, selectTests: fullOnly,
      buildReceiptIdentity: { runId: "receipt-run", taskId: "T1", attempt: 3, gateRound: 2 },
    });
    const row = result.results.find(r => r.gate === "test")!;
    expect(row.pass, row.details).toBe(false); expect(row.details).toMatch(/dirty|tracked/i);
    expect(row.evidenceReceipt?.termination.exitCode).toBe(0);
    expect(row.evidenceReceipts).toHaveLength(fullOnly ? 2 : 1);
    for (const receipt of row.evidenceReceipts!) {
      expect(GateEvidenceReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(receipt.subject).toEqual({ runId: "receipt-run", taskId: "T1", attempt: 3, gate: "test", subjectCommit });
      allIds.push(receipt.invocationId);
    }
  }
  const f = fixture(false);
  const marker = join(f.artifacts, "retry-marker");
  const cmd = `if [ -f '${marker}' ]; then echo done; else touch '${marker}'; echo 'Error: spawn EAGAIN'; exit 1; fi`;
  try {
    setCalmWindowForTests({ loadProvider: () => 0, calmLoad: () => 1 });
    const [row] = await compareToBaseline(f.repo, { test: cmd }, baseline(cmd, { fileCount: null }), ["test"], {
      authorizeRetry: () => true, evidence: { artifactDir: f.artifacts, runId: "receipt-run", taskId: "T1", attempt: 4 },
    });
    expect(row.pass).toBe(true); expect(row.evidenceReceipts).toHaveLength(2);
    expect(row.evidenceReceipts!.map(r => r.termination.exitCode)).toEqual([1, 0]);
    for (const receipt of row.evidenceReceipts!) {
      expect(receipt.subject.attempt).toBe(4); allIds.push(receipt.invocationId);
    }
  } finally { resetCalmWindowForTests(); }
  const { spawn } = await import("node:child_process");
  const { setSpawnForTests, resetSpawnForTests } = await import("../../src/run/git.js");
  let spawns = 0;
  try {
    setSpawnForTests(((...args: Parameters<typeof spawn>) => {
      if (spawns++ === 0) {
        const refused = spawn("/__tickmarkr_missing_evidence_runner__", [], args[2]);
        refused.prependListener("error", error => Object.assign(error, { code: "EAGAIN" }));
        return refused;
      }
      return spawn(...args);
    }) as typeof spawn);
    const [row] = await compareToBaseline(f.repo, { build: "echo completed" }, { commands: {} }, ["build"], { evidence: { artifactDir: f.artifacts } });
    expect(row.pass).toBe(true); expect(row.evidenceReceipts).toHaveLength(2);
    expect(row.evidenceReceipts!.map(r => r.termination.kind)).toEqual(["not-started", "exit"]);
    allIds.push(...row.evidenceReceipts!.map(r => r.invocationId));
  } finally { resetSpawnForTests(); }
  expect(new Set(allIds).size).toBe(allIds.length);
}, 30_000);


test("manifest evidence with an undefined artifact override persists at its reported paths", async () => {
  const { evaluateManifestedTest } = await import("../../src/gates/test-manifest.js");
  const f = fixture(false); fault(f, "artifact-fallback", "pass");
  const row = await evaluateManifestedTest("vitest run --globals", f.repo, {
    artifactDir: f.artifacts, evidence: { artifactDir: undefined },
  });
  expect(row.pass, row.details).toBe(true);
  expect(row.evidenceReceipts).toHaveLength(2);
  for (const receipt of row.evidenceReceipts!) {
    expect(receipt.availability).toBe("available");
    for (const ref of [receipt.stdout, receipt.stderr]) {
      expect(readFileSync(join(f.artifacts, ref.path)).length).toBe(ref.retainedBytes);
    }
  }
  expect(row.meta.stdoutPath).toBe(join(f.artifacts, row.evidenceReceipt!.stdout.path));
  expect(row.meta.stderrPath).toBe(join(f.artifacts, row.evidenceReceipt!.stderr.path));
});

// A deterministic pool-boundary fault, with real child processes and independent invocation logs.
// Only the runner's transport failure is injected; discovery, gate, receipts and tip journal are real.
function strandedFixture(mutate = "", retryMode = "pass", allSkipped = false) {
  const f = fixture(false);
  const files = ["tests/a.test.ts", "tests/parallel-skip.test.ts", "tests/single.test.ts", "tests/single-skip.test.ts"];
  const log = join(f.artifacts, "invocations.json");
  mkdirSync(join(f.repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(f.repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), all = ${JSON.stringify(files)}, log = ${JSON.stringify(log)};
const filters = args.filter(a => !a.startsWith('-') && a.endsWith('.test.ts'));
const excluded = args.filter(a => a.startsWith('--exclude=')).map(a => a.slice(10));
const files = all.filter(f => (!filters.length || filters.some(q => path.resolve(f).includes(q))) && !excluded.includes(f));
if (args[0] === 'list') { console.log(JSON.stringify(files.map(file => ({ file: path.resolve(file) })))); process.exit(0); }
const runs = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
const retry = runs.length > 0, now = Date.now();
const present = retry ? files : files.filter(f => !f.includes('single'));
const report = { nonce: process.env.TICKMARKR_TEST_NONCE, requested: files,
 scheduling: Object.fromEntries(files.map(f => [f, { pool: 'forks', singleFork: f.includes('single') }])),
 started: Object.fromEntries(present.map(f => [f, now])),
 completed: Object.fromEntries(present.map(f => [f, { at: now, status: ${allSkipped} || f.includes('skip') ? 'skipped' : 'passed' }])),
 certificate: { at: now, exitCode: retry ? 0 : 1, errors: retry ? 0 : 1,
 diagnostics: retry ? [] : ['Error: [vitest-worker]: Timeout calling "onTaskUpdate"'] } };
let code = retry ? 0 : 1;
if (!retry) { ${mutate} }
if (retry && ${JSON.stringify(retryMode)} === 'failed') { report.completed[files[0]].status = 'failed'; report.certificate.exitCode = code = 1; }
if (retry && ${JSON.stringify(retryMode)} === 'stranded') { delete report.started[files[0]]; delete report.completed[files[0]]; report.certificate.exitCode = code = 1; report.certificate.errors = 1; report.certificate.diagnostics = ['Error: [vitest-worker]: Timeout calling "onTaskUpdate"']; }
if (retry && ${JSON.stringify(retryMode)} === 'skipped') for (const c of Object.values(report.completed)) c.status = 'skipped';
runs.push({ args, files, nonce: report.nonce, reportPath: process.env.TICKMARKR_TEST_REPORT });
fs.writeFileSync(log, JSON.stringify(runs));
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify(report));
console.log('invocation phase ' + runs.length); console.error('stderr phase ' + runs.length);
process.exit(code);
`, { mode: 0o755 });
  return { ...f, files, runs: () => JSON.parse(readFileSync(log, "utf8")) as Array<{ args: string[]; files: string[]; nonce: string; reportPath: string }> };
}

test("test: through the gate battery a first run whose single fork files never started after a worker RPC timeout re-runs exactly those files once and passes when they pass even though a parallel file and a single fork file were skipped whole, so a gate that fails closed or re-runs the whole suite or counts a skip as a failure fails", async () => {
  const f = strandedFixture();
  const row = await round(f);
  expect(row.pass, row.details).toBe(true);
  const runs = f.runs();
  expect(runs.map(r => r.files)).toEqual([f.files, f.files.slice(2)]);
  expect(runs[0]!.nonce).not.toBe(runs[1]!.nonce);
  expect(row.meta).toMatchObject({ executedModules: 2, skippedModules: [f.files[1], f.files[3]], retryable: false });
  for (const run of runs) expect(row.details).toContain(run.nonce);
  expect(readTestReport(runs[0]!.reportPath)?.certificate?.exitCode).toBe(1);
  expect(readTestReport(runs[1]!.reportPath)?.certificate?.exitCode).toBe(0);
  // Skips are accounted across BOTH phases; a wholly skipped retry can still finish the manifest.
  const skippedRetry = strandedFixture("", "skipped");
  expect((await round(skippedRetry)).meta).toMatchObject({ executedModules: 1 });
  const noExecution = strandedFixture("", "pass", true);
  const refused = await round(noExecution);
  expect(refused.pass).toBe(false);
  expect(refused.meta?.noExecutedModules).toBe(true);
  expect(noExecution.runs()).toHaveLength(2);
}, 60_000);

test("test: a report stranding a whole parallel project or lacking the reporter's scheduling record or starting no file or holding an unexpected lifecycle member or a certificate exit that disagrees with the process or a failed or unfinished started file or a diagnostic other than a worker RPC timeout is never re-run and keeps today's fail-closed verdict, so a retry that launders a runner failure fails", async () => {
  const mutations = [
    "delete report.started[all[1]]; delete report.completed[all[1]];",
    "delete report.scheduling;", "delete report.scheduling[all[0]];",
    "report.scheduling[all[0]].singleFork = undefined;", "report.scheduling[all[0]].pool = 'threads';",
    "report.started = {}; report.completed = {};",
    "report.started['unexpected.test.ts'] = now;", "report.requested.push('unexpected.test.ts');",
    "report.completed['unexpected.test.ts'] = { at: now, status: 'passed' };",
    "report.certificate.exitCode = 0;", "code = 0;", "code = 2; report.certificate.exitCode = 2;",
    "report.completed[all[0]].status = 'failed';", "delete report.completed[all[0]];",
    "report.certificate.diagnostics.push('Error: spawn EAGAIN'); report.certificate.errors++;",
    "report.certificate.diagnostics = ['AssertionError: [vitest-worker]: Timeout calling \"onTaskUpdate\"'];",
    "report.certificate.diagnostics = ['Error: [vitest-api]: Timeout calling \"onTaskUpdate\"'];",
    "report.certificate.diagnostics = [];", "report.certificate.errors = 2;", "delete report.certificate;",
    "report.nonce = 'old';", "report.requested.push(all[0]);", "report.duplicateCompletions = [all[0]];",
    "delete report.started[all[0]];", "report.started[all[2]] = now;",
  ];
  for (const mutation of mutations) {
    const f = strandedFixture(mutation);
    const row = await round(f);
    expect(row.pass, mutation).toBe(false);
    expect(f.runs(), mutation).toHaveLength(1);
    const run = f.runs()[0]!;
    const original = verifyManifestReport({ manifest: f.files, nonce: row.meta!.nonce as string,
      exitCode: row.meta!.processExit as number, report: readTestReport(run.reportPath) });
    expect(row.details, mutation).toContain(original.details);
  }
}, 60_000);

test("test: a re-run whose own report fails or strands a file fails the gate naming both nonces and launches no second re-run while each invocation keeps its own receipt, so a retry that reports the first run's green or overwrites its evidence fails", async () => {
  const { createHash } = await import("node:crypto");
  for (const mode of ["failed", "stranded"]) {
    const f = strandedFixture("", mode);
    const row = await round(f);
    expect(row.pass).toBe(false);
    expect(row.meta?.retryable).toBe(false);
    const runs = f.runs();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.files).toEqual(f.files.slice(2));
    expect(row.meta?.nonce).toBe(runs[1]!.nonce);
    const ids = new Set<string>();
    for (const [index, run] of runs.entries()) {
      expect(row.details).toContain(run.nonce);
      const receipt = row.evidenceReceipts!.find(r => r.nonce === run.nonce)!;
      expect(receipt.invocationId).toBe(run.nonce);
      ids.add(receipt.invocationId);
      expect(readTestReport(run.reportPath)?.nonce).toBe(run.nonce);
      for (const stream of [receipt.stdout, receipt.stderr]) {
        const bytes = readFileSync(join(f.artifacts, stream.path));
        expect(stream.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(bytes.toString()).toContain(`phase ${index + 1}`);
      }
    }
    expect(ids.size).toBe(2);
    expect(row.evidenceReceipt?.nonce).toBe(runs[1]!.nonce);
  }
}, 60_000);

test("test: tip verify of an integration tip whose first run stranded its single fork files after a worker RPC timeout re-runs only those files once and journals a passing tip row naming the retry, so a tip verify that stays red on the stall fails", async () => {
  const { Journal } = await import("../../src/run/journal.js");
  const { verifyIntegrationTipCached } = await import("../../src/run/daemon.js");
  const f = strandedFixture();
  const journal = Journal.create(f.repo, "run-stranded-tip");
  const commands = { test: "vitest run --globals" };
  journal.append("run-start", undefined, { commands });
  expect(await verifyIntegrationTipCached(f.repo, commands, journal)).toBe(false);
  const runs = f.runs();
  expect(runs.map(r => r.files)).toEqual([f.files, f.files.slice(2)]);
  const rows = journal.read().filter(r => r.event === "tip-verify");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.data).toMatchObject({ pass: true, nonce: runs[1]!.nonce });
  expect(rows[0]!.data.details).toContain(runs[0]!.nonce);
  expect(rows[0]!.data.details).toContain(runs[1]!.nonce);
}, 60_000);
