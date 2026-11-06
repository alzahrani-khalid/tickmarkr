import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { baselineCachePath, verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import * as speed from "../../src/cli/verify-speed.js";
import { ceilingKillDurationMs, manifestedBaseline, resolveManifestedCeiling } from "../../src/cli/verify-speed.js";
import { CAPTURE_CEILING_MS, CAPTURE_HARD_MAX_MS, captureCeilingMs, effectiveCeilingMs, type Baseline } from "../../src/gates/baseline.js";
import { baselineIdentity } from "../../src/gates/cache.js";
import * as gates from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { COMMIT, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 300 / D-2182: contracts V, C and U of the standalone verify's manifested Vitest branch.
const minute = 60_000;
const suite = { test: "npm run -s test" }; // detectGateCommands' own spelling; no build script, so the subset is test alone
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (repo: string, text: string) => {
  writeFileSync(join(repo, "src.txt"), text);
  execFileSync("sh", ["-c", `${COMMIT} candidate`], { cwd: repo });
};
const errors = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.stubEnv("TMPDIR", realpathSync(makeTestTempDir("verify-speed-cache-")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** A tiny fake vitest: lists one file and writes one invocation-bound report per run, as the mode file says. */
function fixture(script = "vitest run") {
  const scratch = makeTestTempDir("verify-speed-runner-");
  const log = join(scratch, "runs.jsonl");
  const mode = join(scratch, "mode");
  writeFileSync(mode, "green");
  const repo = makeRepo({
    ".gitignore": "node_modules/\n.tickmarkr/\n",
    "package.json": JSON.stringify({ scripts: { test: script } }),
    "tests/a.test.ts": "test('alpha', () => {});\n",
    "check.sh": `printf '%s\\n' "$PWD" >> '${log}.sh'\n`,
    "src.txt": "base\n",
  });
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), files = ['tests/a.test.ts'], file = files[0];
const phase = args[0] === 'list' ? 'list' : 'run';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: path.resolve('.'), phase }) + '\\n');
if (phase === 'list') { console.log(JSON.stringify(files.map(f => ({ file: path.resolve(f) })))); process.exit(0); }
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
if (mode === 'noreport') process.exit(1);
const now = Date.now();
const head = { nonce: process.env.TICKMARKR_TEST_NONCE, requested: files,
  scheduling: { [file]: { pool: 'forks', singleFork: false } }, started: { [file]: now } };
if (mode === 'hang') { fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify({ ...head, completed: {} })); setInterval(() => {}, 1000); return; }
const red = mode === 'red';
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify({ ...head,
  completed: { [file]: { at: now, status: red ? 'failed' : 'passed', ...(red ? { failures: ['tests/a.test.ts > alpha: boom'] } : {}),
    tests: { passed: red ? 0 : 1, failed: red ? 1 : 0, skipped: 0 } } },
  certificate: { at: now, exitCode: red ? 1 : 0, errors: 0, diagnostics: [] } }));
process.exit(red ? 1 : 0);
`, { mode: 0o755 });
  git(repo, "checkout", "-b", "feature");
  commit(repo, "feature\n");
  const base = git(repo, "merge-base", "main", "HEAD");
  const runs = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; phase: string }) : [];
  return { repo, base, mode, log, runs, cache: baselineCachePath(repo, base, suite) };
}

async function verified(repo: string, args: string[] = []) {
  const result = await verify(["--no-review", "--json", ...args], repo);
  const out = JSON.parse(result.out) as { green: boolean; results: GateResult[]; artifactPath: string };
  const row = out.results.find((r) => r.gate === "test")!;
  const artifact = JSON.parse(readFileSync(out.artifactPath, "utf8")) as { gateRows: GateResult[] };
  expect(artifact.gateRows.find((r) => r.gate === "test")).toEqual(row); // one artifact names the same provenance
  return { code: result.code, row, out };
}

const noBaseSuite = (f: ReturnType<typeof fixture>) => {
  const root = realpathSync(f.repo);
  expect(f.runs().every((r) => realpathSync(r.cwd) === root)).toBe(true); // no capture worktree ever ran the suite
  expect(existsSync(f.cache)).toBe(false);
  expect(readdirSync(verifyStateDir(f.repo)).filter((d) => d.startsWith("base-"))).toEqual([]);
  expect(errors().some((l) => l.includes("capturing baseline at merge-base"))).toBe(false);
  expect(errors().some((l) => l.includes("recapturing merge-base"))).toBe(false);
};
const runCount = (f: ReturnType<typeof fixture>) => f.runs().filter((r) => r.phase === "run").length;
const healthy = (durationMs: number, extra: Record<string, unknown> = {}) => ({ commands: { test: {
  exitCode: 0, fingerprints: [], durationMs, ceilingMs: effectiveCeilingMs({ durationMs }), fileCount: 1, fileCountSource: "manifest",
  fileDurations: [{ file: "tests/a.test.ts", durationMs: 2_000 }], longestFile: { file: "tests/a.test.ts", durationMs: 2_000 }, fileOutcomes: true, ...extra,
} } });
const write = (path: string, body: unknown, mtimeSeconds: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  utimesSync(path, mtimeSeconds, mtimeSeconds);
};
const marker = (durationMs: number, ceilingMs = effectiveCeilingMs({ durationMs })) =>
  ({ base: "b".repeat(40), commands: ["test"], measurements: { test: { durationMs, ceilingMs } } });

test("contract V green ordinary red exact-base cache candidate killed or infra and cached full green rows use the candidate verdict without a base suite and heal only prior-measurement or floor-kill-equivalent ceiling kills", async () => {
  const f = fixture();
  const floor = effectiveCeilingMs({ durationMs: CAPTURE_CEILING_MS });
  expect(floor).toBe(90 * minute);

  // green: the candidate's manifested verdict is the test row; no base suite, floor-kill-equivalent armed.
  const green = await verified(f.repo);
  expect(green.code, JSON.stringify(green.out)).toBe(0);
  expect(green.row).toMatchObject({ pass: true, meta: { baselineCapture: "not-required-manifested-vitest", ceilingSource: "floor-kill-equivalent", ceilingMs: floor } });
  expect(green.row.meta?.ceilingSourcePath).toBeUndefined();
  expect(errors()).toContain(`verify: base suite not required for manifested Vitest — ceiling source floor-kill-equivalent, armed ceiling ${floor}ms`);
  expect(runCount(f)).toBe(1);
  noBaseSuite(f);

  // cached full green: the existing store answers the same identity; still no base suite.
  const reused = await verified(f.repo);
  expect(reused.code).toBe(0);
  expect(reused.row.meta).toMatchObject({ reused: true, ceilingSource: "floor-kill-equivalent", ceilingMs: floor });
  expect(runCount(f)).toBe(1);
  noBaseSuite(f);

  // ordinary red: stands red, executed once, no base capture or second execution.
  commit(f.repo, "red\n");
  writeFileSync(f.mode, "red");
  const red = await verified(f.repo);
  expect(red.code).toBe(2);
  expect(red.row.pass).toBe(false);
  expect(red.row.meta?.infra).not.toBe(true);
  expect(red.row.details).toContain("boom");
  expect(red.row.meta).toMatchObject({ baselineCapture: "not-required-manifested-vitest", ceilingSource: "floor-kill-equivalent", ceilingMs: floor });
  expect(runCount(f)).toBe(2);
  noBaseSuite(f);

  // infra that is not a ceiling kill (no report, quick exit): infra, never green, no healing marker.
  writeFileSync(f.mode, "noreport");
  const infra = await verified(f.repo);
  expect(infra.code).toBe(2);
  expect(infra.row.meta).toMatchObject({ infra: true, missingReport: true, ceilingSource: "floor-kill-equivalent" });
  expect(ceilingKillDurationMs(infra.row, floor)).toBeUndefined();
  expect(existsSync(`${f.cache}.verdictless`)).toBe(false);
  noBaseSuite(f);

  // candidate killed at a floor-kill-equivalent ceiling (armed tiny here): infra, and the marker heals the next one.
  const real = speed.resolveManifestedCeiling;
  const spy = vi.spyOn(speed, "resolveManifestedCeiling").mockImplementation((...args) => ({ ...real(...args), ceilingMs: 3_000 }));
  writeFileSync(f.mode, "hang");
  const killed = await verified(f.repo);
  expect(killed.code).toBe(2);
  expect(killed.row.pass).toBe(false);
  expect(killed.row.meta).toMatchObject({ infra: true, kind: "hang", hangBudgetMs: 3_000, ceilingSource: "floor-kill-equivalent", ceilingMs: 3_000 });
  const span = killed.row.meta!.durationMs as number;
  expect(span).toBeGreaterThanOrEqual(3_000);
  expect(JSON.parse(readFileSync(`${f.cache}.verdictless`, "utf8")))
    .toEqual({ base: f.base, commands: ["test"], measurements: { test: { durationMs: span, ceilingMs: effectiveCeilingMs({ durationMs: span }) } } });
  expect(killed.row.meta?.ceilingMarker).toBe(`${f.cache}.verdictless`);
  expect(existsSync(f.cache)).toBe(false);
  spy.mockRestore();

  // healed: the next verify arms prior-measurement from that marker through captureCeilingMs.
  writeFileSync(f.mode, "green");
  const healed = await verified(f.repo);
  expect(healed.code).toBe(0);
  expect(healed.row.meta).toMatchObject({ ceilingSource: "prior-measurement", ceilingMs: CAPTURE_CEILING_MS, ceilingSourcePath: `${f.cache}.verdictless` });
  expect(errors().some((l) => l.includes(`ceiling source prior-measurement (${basename(f.cache)}.verdictless), armed ceiling ${CAPTURE_CEILING_MS}ms`))).toBe(true);
  noBaseSuite(f); // the marker is timing only; no capture file was written

  // exact-base cache: read as today (its own ceiling), no capture; its kill writes no marker and re-arms as today.
  rmSync(`${f.cache}.verdictless`);
  const exact = healthy(1_000, { ceilingMs: 3_000, fileDurations: null, longestFile: null });
  writeFileSync(f.cache, JSON.stringify(exact));
  writeFileSync(f.mode, "hang");
  const exactKill = await verified(f.repo);
  expect(exactKill.code).toBe(2);
  expect(exactKill.row.meta).toMatchObject({ infra: true, kind: "hang", hangBudgetMs: 3_000, ceilingSource: "exact-base-cache", ceilingMs: 3_000, ceilingSourcePath: f.cache });
  expect(existsSync(`${f.cache}.verdictless`)).toBe(false);
  expect(JSON.parse(readFileSync(f.cache, "utf8"))).toEqual(exact);
  expect(f.runs().every((r) => realpathSync(r.cwd) === realpathSync(f.repo))).toBe(true);
  expect(errors().some((l) => l.includes("capturing baseline at merge-base"))).toBe(false);
}, 120_000);

test("contract C exact-base cache cross-base healthy measurement cross-base verdictless measurement exact-base non-reusable measurement newest invalid or unreadable record foreign record no usable measurement bounds on prior measurement healthy capture per-file hang budgets and per-file timing absent rows select measured or floor-kill-equivalent ceilings", async () => {
  const f = fixture();
  const resolve = () => resolveManifestedCeiling(f.cache, suite, f.repo);
  const otherBase = (sha: string) => baselineCachePath(f.repo, sha.repeat(40), suite);
  const otherLock = (path: string) => path.replace(/^(baseline-[0-9a-f]{12}-)[0-9a-f]{12}/, (_m, head) => `${head}${"9".repeat(12)}`);
  const relock = (path: string) => join(dirname(path), otherLock(basename(path)));

  // no usable measurement: an absent cache directory arms the floor-kill-equivalent ceiling, ninety minutes.
  expect(resolve()).toEqual({ source: "floor-kill-equivalent", ceilingMs: 5_400_000 });
  expect(manifestedBaseline(resolve())).toEqual({ commands: { test: { ceilingMs: 5_400_000 } } });

  // foreign record: another command or runner hash is ignored however new, near or large.
  write(baselineCachePath(f.repo, f.base, { test: "different-command" }), healthy(3 * 60 * minute), 9_000);
  write(f.cache.replace(/-[^-]+\.json$/, `-${"0".repeat(16)}.json`), healthy(3 * 60 * minute), 9_000);
  expect(resolve().source).toBe("floor-kill-equivalent");

  // cross-base healthy measurement, at another base AND lockfile: measured ceiling plus hang budgets only.
  const crossHealthy = relock(otherBase("a"));
  const red = healthy(20 * minute, { exitCode: 1, fingerprints: ["boom"], fileOutcomes: undefined,
    fileDurations: [{ file: "tests/a.test.ts", durationMs: 2_000 }, { file: "tests/b.test.ts", durationMs: 4_000 }] });
  write(crossHealthy, red, 1_000);
  const fromHealthy = resolve();
  expect(fromHealthy).toMatchObject({ source: "prior-measurement", ceilingMs: captureCeilingMs(red.commands.test), sourcePath: crossHealthy, hangBudgets: { path: crossHealthy } });
  expect(fromHealthy.ceilingMs).toBe(60 * minute);
  // a red capture that never classified its files keeps every file failed, preserved by the measurement-only flag
  const budgeted = manifestedBaseline(fromHealthy);
  expect(budgeted).toEqual({ commands: { test: { ceilingMs: 60 * minute, fileOutcomes: true, longestFile: red.commands.test.longestFile,
    fileDurations: [{ file: "tests/a.test.ts", durationMs: 2_000, failed: true }, { file: "tests/b.test.ts", durationMs: 4_000, failed: true }] } } });
  expect(budgeted.commands.test).not.toHaveProperty("exitCode");
  expect(budgeted.commands.test).not.toHaveProperty("fingerprints");
  expect(baselineIdentity(budgeted)).toBe(baselineIdentity({ commands: { test: {} } } as unknown as Baseline));

  // cross-base verdictless measurement: a newer marker supplies the ceiling, never the per-file budgets,
  // and it does not hide the older healthy capture's budgets.
  const crossMarker = `${otherBase("b")}.verdictless`;
  write(crossMarker, marker(40 * minute), 2_000);
  expect(resolve()).toMatchObject({ source: "prior-measurement", ceilingMs: 120 * minute, sourcePath: crossMarker, hangBudgets: { path: crossHealthy } });
  expect(manifestedBaseline(resolve()).commands.test).toMatchObject({ ceilingMs: 120 * minute, fileDurations: budgeted.commands.test!.fileDurations });

  // newest invalid or unreadable records are skipped without coercion; the older valid measurement stands.
  const invalid: Array<[string, unknown]> = [
    ["c", "{torn"], ["d", null], ["e", { commands: { test: null } }], ["f", { commands: {} }],
    ["1", { commands: { test: { exitCode: 0, fingerprints: [], durationMs: "600000" } } }],
    ["2", { commands: { test: { exitCode: 0, fingerprints: [], durationMs: -1 } } }],
    ["3", { commands: { test: { exitCode: 0, fingerprints: [], durationMs: 0 } } }],
    // a present-but-invalid preferred ceiling is never bypassed by coercing the unused durationMs
    ["4", { commands: { test: { exitCode: 0, fingerprints: [], ceilingMs: "x", durationMs: 3 * 60 * minute } } }],
  ];
  invalid.forEach(([sha, body], i) => write(otherBase(sha), typeof body === "string" ? body : JSON.stringify(body), 3_000 + i));
  write(`${otherBase("5")}.verdictless`, { measurements: { test: { ceilingMs: -1 } } }, 3_100);
  expect(resolve()).toMatchObject({ source: "prior-measurement", ceilingMs: 120 * minute, sourcePath: crossMarker });
  // a null preferred ceiling follows the helper's own ?? precedence to a valid durationMs
  const nullCeiling = otherBase("6");
  write(nullCeiling, { commands: { test: { durationMs: 25 * minute, ceilingMs: null } } }, 4_000);
  expect(resolve()).toMatchObject({ sourcePath: nullCeiling, ceilingMs: 75 * minute, hangBudgets: { path: crossHealthy } });

  // bounds on prior measurement: captureCeilingMs' floor and hard maximum, recorded as the armed value.
  write(otherBase("7"), { commands: { test: { durationMs: 1_000 } } }, 5_000);
  expect(resolve().ceilingMs).toBe(CAPTURE_CEILING_MS);
  write(`${otherBase("8")}.verdictless`, marker(10 * 60 * minute), 6_000);
  expect(resolve().ceilingMs).toBe(CAPTURE_HARD_MAX_MS);

  // exact-base non-reusable measurement: a verdictless exact entry competes by recency for the ceiling only.
  const nonReusable = healthy(30 * minute, { exitCode: undefined });
  write(f.cache, nonReusable, 7_000);
  expect(resolve()).toMatchObject({ source: "prior-measurement", ceilingMs: 90 * minute, sourcePath: f.cache, hangBudgets: { path: crossHealthy } });
  expect(resolve().exact).toBeUndefined();
  // a healthy exact entry that is non-reusable (its file count is not manifest-derived) supplies budgets first, even when older
  write(f.cache, healthy(10 * minute, { fileCountSource: undefined, fileDurations: [{ file: "tests/a.test.ts", durationMs: 9_000 }] }), 1);
  expect(resolve()).toMatchObject({ source: "prior-measurement", sourcePath: `${otherBase("8")}.verdictless`, hangBudgets: { path: f.cache } });
  expect(manifestedBaseline(resolve()).commands.test).toMatchObject({ ceilingMs: CAPTURE_HARD_MAX_MS, fileOutcomes: true, fileDurations: [{ file: "tests/a.test.ts", durationMs: 9_000 }] });

  // exact-base cache: reusable at this exact base, read as today, beating every newer cross-base record.
  const exact = healthy(2 * minute);
  write(f.cache, exact, 1);
  // its own recorded ceiling, as the gate reads it today: three times two minutes is under the ten-minute shell floor
  expect(resolve()).toEqual({ source: "exact-base-cache", ceilingMs: 10 * minute, sourcePath: f.cache, exact });
  expect(manifestedBaseline(resolve())).toEqual(exact);
  rmSync(f.cache);

  // per-file timing absent: with only verdictless markers, no per-file durations or longestFile are invented.
  for (const file of readdirSync(dirname(f.cache))) if (!file.endsWith(".verdictless")) rmSync(join(dirname(f.cache), file));
  const markerOnly = resolve();
  expect(markerOnly.hangBudgets).toBeUndefined();
  expect(manifestedBaseline(markerOnly)).toEqual({ commands: { test: { ceilingMs: CAPTURE_HARD_MAX_MS } } });

  // healthy capture per-file hang budgets reach the real pipeline through the real caller, with no base suite.
  write(crossHealthy, red, 1_000);
  const seen: Baseline[] = [];
  const runGates = gates.runGates;
  vi.spyOn(gates, "runGates").mockImplementation(async (task, ctx) => {
    if (task.gates.includes("test")) seen.push(ctx.baseline);
    return runGates(task, ctx);
  });
  const result = await verified(f.repo);
  expect(result.code).toBe(0);
  expect(seen).toEqual([{ commands: { test: { ...budgeted.commands.test, ceilingMs: CAPTURE_HARD_MAX_MS } } }]);
  expect(result.row.meta).toMatchObject({ ceilingSource: "prior-measurement", ceilingMs: CAPTURE_HARD_MAX_MS, ceilingSourcePath: `${otherBase("8")}.verdictless`, hangBudgetSourcePath: crossHealthy });
  noBaseSuite(f);

  // the ceiling-kill observable: a per-file hang below the armed ceiling, or a short missing report, is not one.
  const row = (meta: Record<string, unknown>): GateResult => ({ gate: "test", pass: false, details: "", meta: { infra: true, ...meta } });
  expect(ceilingKillDurationMs(row({ kind: "hang", hangBudgetMs: 5_000, durationMs: 5_100 }), 5_000)).toBe(5_100);
  expect(ceilingKillDurationMs(row({ kind: "hang", hangBudgetMs: 4_000, durationMs: 5_100 }), 5_000)).toBeUndefined();
  expect(ceilingKillDurationMs(row({ missingCertificate: true, durationMs: 5_000 }), 5_000)).toBe(5_000);
  expect(ceilingKillDurationMs(row({ missingReport: true, durationMs: 4_999 }), 5_000)).toBeUndefined();
  expect(ceilingKillDurationMs(row({ kind: "hang", hangBudgetMs: 5_000 }), 5_000)).toBeUndefined(); // no span, no measurement
  expect(statSync(crossHealthy).isFile()).toBe(true); // read-only: discovery removed nothing
}, 60_000);

test("a non-Vitest test command still captures its merge-base suite and a supplied baseline is used as today with no ceiling source (contract U base case and supplied baseline rows)", async () => {
  // U base case: a scripted non-Vitest command captures at its merge-base and caches, exactly as before.
  const scripted = fixture("sh check.sh");
  const result = await verified(scripted.repo);
  expect(result.code).toBe(0);
  const shells = readFileSync(`${scripted.log}.sh`, "utf8").trim().split("\n");
  // the base worktree's capture (removed after it), then the candidate
  expect(shells.map((p) => existsSync(p) && realpathSync(p) === realpathSync(scripted.repo))).toEqual([false, true]);
  expect(basename(shells[0]!)).toMatch(/^base-/);
  expect(JSON.parse(readFileSync(scripted.cache, "utf8")).commands.test).toMatchObject({ exitCode: 0 });
  expect(errors().some((l) => l.startsWith(`verify: capturing baseline at merge-base ${scripted.base.slice(0, 12)} for test`))).toBe(true);
  expect(errors().some((l) => l.includes("base suite not required"))).toBe(false);
  expect(result.row.meta).not.toHaveProperty("ceilingSource");
  expect(result.row.meta).not.toHaveProperty("baselineCapture");

  // U supplied baseline: the manifested Vitest command reads the supplied file through today's path, with no ceiling source.
  const f = fixture();
  const supplied = join(makeTestTempDir("verify-speed-supplied-"), "baseline.json");
  const baseline = { commands: { test: { exitCode: 0, fingerprints: [], ceilingMs: 2 * minute } } };
  writeFileSync(supplied, JSON.stringify(baseline));
  const seen: Baseline[] = [];
  const runGates = gates.runGates;
  vi.spyOn(gates, "runGates").mockImplementation(async (task, ctx) => {
    seen.push(ctx.baseline);
    return runGates(task, ctx);
  });
  const resolver = vi.spyOn(speed, "resolveManifestedCeiling");
  const used = await verified(f.repo, ["--baseline", supplied]);
  expect(used.code).toBe(0);
  expect(seen.at(-1)).toEqual(baseline);
  expect(resolver).not.toHaveBeenCalled();
  expect(used.row.meta).not.toHaveProperty("ceilingSource");
  expect(used.row.meta).not.toHaveProperty("baselineCapture");
  expect(errors().some((l) => l.includes("base suite not required"))).toBe(false);
  expect(f.runs().every((r) => realpathSync(r.cwd) === realpathSync(f.repo))).toBe(true);
  expect(existsSync(f.cache)).toBe(false);
}, 60_000);
