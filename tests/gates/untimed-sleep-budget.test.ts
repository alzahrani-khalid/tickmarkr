import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { Baseline, BaselineCommand } from "../../src/gates/baseline.js";
import { runGates } from "../../src/gates/run-gates.js";
import { FILE_HANG_SLACK, MIN_FILE_HANG_BUDGET_MS, fileHangBudgetMs, resetHangClocksForTests, resetSleepEvidenceForTests, runWithInterruptionSink,
  setHangClocksForTests, setSleepEvidenceForTests, type HostInterruption, type SleepEvidence } from "../../src/gates/test-manifest.js";
import { validateGraph } from "../../src/graph/schema.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

/**
 * v2.6.8 T3: the closed budget and sleep tables through production task verification (runGates) and tip verification
 * (verifyIntegrationTip). A stand-in runner resolved as the worktree's vitest starts tests/a.test.ts at a fixture-chosen
 * wall stamp and holds it until a release file appears. The gate's clocks are injected and frozen: the test moves them
 * only after the runner's started record exists and waits for the poll's own interruption record before the next move,
 * so every active-service value below is exact and no timer delay stands in for readiness.
 */
const CMD = "vitest run";
const FILE = "tests/a.test.ts";
const S0 = Date.UTC(2026, 9, 6, 0, 0, 0);
const MONO0 = 5_000_000;
const OUTER_MS = 60_000;
const clock = { wall: 0, mono: 0 };
const surfaces = ["task", "tip"] as const;
type Surface = typeof surfaces[number];

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" }, tasks: [
  { id: "T1", title: "budget", goal: "budget", shape: "implement", complexity: 3, gates: ["build", "test", "lint", "evidence", "scope"], acceptance: ["done"], files: ["**"] },
] }).tasks[0];

beforeEach(() => {
  setHangClocksForTests({ wall: () => S0 + clock.wall, mono: () => MONO0 + clock.mono });
  // Budget rows never consult the host: only the sleep rows below inject Darwin and its command boundary.
  setSleepEvidenceForTests({ platform: () => "linux" });
});
afterEach(() => { resetHangClocksForTests(); resetSleepEvidenceForTests(); });

/**
 * Queue row 102 (D-1626): ONE repository per test, built by its first drive, instead of a fresh one per drive; no row
 * varies the repository. Each drive still writes its own runner (start stamp, marks) and artifacts, and starts with no
 * `.tickmarkr` state dir, as a fresh repository did: the task verdict cache keys on a baseline identity that ignores
 * every duration and ceiling field, so a green kept there would answer the next row without running it.
 */
let shared: { repo: string; base: string } | undefined;
beforeEach(() => { shared = undefined; });

function sharedRepo(): { repo: string; base: string } {
  const repo = makeRepo({
    ".gitignore": "node_modules/\n",
    "src/a.ts": "export const a = 1;\n",
    [FILE]: 'test("a", () => {});\n',
    "package.json": JSON.stringify({ type: "module", scripts: { test: CMD } }),
  });
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  git(repo, "add", "-A"); git(repo, "commit", "--no-gpg-sign", "-m", "change");
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  return { repo, base };
}

function fixture(startedAt: number) {
  if (!shared) shared = sharedRepo();
  const { repo, base } = shared;
  rmSync(join(repo, ".tickmarkr"), { recursive: true, force: true });
  // Outside the worktree: the gate refuses a tree its test command left dirty.
  const mark = join(makeTestTempDir("untimed-sleep-marks-"), randomBytes(4).toString("hex"));
  writeFileSync(join(repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const files = [${JSON.stringify(FILE)}], mark = ${JSON.stringify(mark)}, started = ${startedAt};
if (process.argv[2] === 'list') { console.log(JSON.stringify(files.map(file => ({ file: path.resolve(file), name: file })))); process.exit(0); }
const out = process.env.TICKMARKR_TEST_REPORT;
const report = { nonce: process.env.TICKMARKR_TEST_NONCE, requested: files, started: { [files[0]]: started }, completed: {} };
fs.writeFileSync(out, JSON.stringify(report));
fs.writeFileSync(mark + '.started', String(process.pid));
const held = setInterval(() => {
  if (!fs.existsSync(mark + '.release')) return;
  clearInterval(held);
  report.completed = { [files[0]]: { at: started, status: 'passed', tests: { passed: 1, failed: 0, skipped: 0 } } };
  report.certificate = { at: started, exitCode: 0, errors: 0, diagnostics: [] };
  fs.writeFileSync(out, JSON.stringify(report));
  process.exit(0);
}, 10);
`, { mode: 0o755 });
  return { repo, base, mark, artifacts: makeTestTempDir("untimed-sleep-") };
}

async function verify(surface: Surface, f: ReturnType<typeof fixture>, entry: Partial<BaselineCommand>) {
  const baseline = { commands: { test: { cmd: CMD, exitCode: 0, fingerprints: [], ...entry } } } as Baseline;
  if (surface === "task") {
    const out = await runGates(task, {
      worktree: f.repo, baseRef: f.base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
      result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: CMD }, baseline,
      channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: f.artifacts,
    });
    const rows = out.results.filter((r) => r.gate === "test");
    expect(rows).toHaveLength(1);
    return { pass: rows[0]!.pass, details: rows[0]!.details, meta: rows[0]!.meta ?? {} };
  }
  const runDir = join(f.artifacts, "tip");
  mkdirSync(runDir, { recursive: true });
  const [tip] = await verifyIntegrationTip(f.repo, { test: CMD }, runDir, baseline);
  return { pass: tip!.pass, details: tip!.details, meta: {} as Record<string, unknown> };
}

/** Polls for an observed event (a file the runner wrote, a recorded interruption), never a delay as evidence. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + OUTER_MS; !done();) {
    if (Date.now() > deadline) throw new Error(`never observed: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Step { wall: number; mono?: number; before?: () => void }
/** Each step moves the frozen wall clock to an absolute offset from S0 — the monotonic clock by the same amount unless
 * the step names its own offset — and waits for the poll that records that gap; the hang decision is made in that same
 * poll. The release is always written afterwards: a killed file can no longer use it. */
async function drive(surface: Surface, entry: Partial<BaselineCommand>, steps: Step[], startedAt = S0) {
  const f = fixture(startedAt);
  clock.wall = 0; clock.mono = 0;
  const seen: HostInterruption[] = [];
  let settled = false;
  const outcome = runWithInterruptionSink((i) => { seen.push(i); }, () => verify(surface, f, entry)).finally(() => { settled = true; });
  await until(() => existsSync(`${f.mark}.started`) || settled, "the runner's started record");
  for (const [i, step] of steps.entries()) {
    step.before?.();
    clock.mono = step.mono ?? clock.mono + step.wall - clock.wall;
    clock.wall = step.wall;
    await until(() => seen.length > i || settled, `interruption ${i + 1}`);
  }
  writeFileSync(`${f.mark}.release`, "");
  const result = await outcome;
  return { ...result, seen, pid: Number(readFileSync(`${f.mark}.started`, "utf8")) };
}
type Driven = Awaited<ReturnType<typeof drive>>;

function expectHang(surface: Surface, r: Driven, budget: number, activeMs?: number, wallMs = activeMs) {
  expect(r.pass, r.details).toBe(false);
  expect(r.details).toContain(`infra hang: "${FILE}" started and did not complete within its ${budget}ms budget`);
  if (activeMs !== undefined) expect(r.details).toContain(`(${activeMs}ms active of ${wallMs}ms wall)`);
  if (surface === "task") expect(r.meta).toMatchObject({ classification: "infra", kind: "hang", file: FILE, hangBudgetMs: budget });
  // joined: the runner's whole process group is gone, not left to run unbounded
  expect(() => process.kill(-r.pid, 0)).toThrow(/ESRCH/);
}
function expectPass(r: Driven) {
  expect({ pass: r.pass, hang: /infra hang/.test(r.details) }, r.details).toEqual({ pass: true, hang: false });
  expect(() => process.kill(-r.pid, 0)).toThrow(/ESRCH/);
}
/** Below the budget the first poll keeps the file; at equality the next poll kills it. */
const toBudget = (budget: number): Step[] => [{ wall: budget - 1 }, { wall: budget, mono: budget + 5_000 }];

test("production task and tip verification pass an untimed file at 11000 ms under a 20000 ms ceiling versus the old longest-file guess", async () => {
  const untimed: Partial<BaselineCommand> = { ceilingMs: 20_000, fileDurations: [{ file: "tests/other.test.ts", durationMs: 60 }] };
  const red: Partial<BaselineCommand> = { ceilingMs: 20_000, exitCode: 1, fileOutcomes: true,
    fileDurations: [{ file: FILE, durationMs: 60, failed: true }, { file: "tests/other.test.ts", durationMs: 60 }] };
  // the old guess: max(10000 floor, 3 × L) = 10000, which 11000 ms of service exceeds; the ceiling rule is 20000
  expect(Math.max(MIN_FILE_HANG_BUDGET_MS, FILE_HANG_SLACK * 60)).toBeLessThan(11_000);
  for (const entry of [untimed, red]) expect(fileHangBudgetMs(FILE, entry.fileDurations, entry.ceilingMs)).toBe(20_000);
  for (const surface of surfaces) {
    for (const entry of [untimed, red]) {
      const r = await drive(surface, entry, [{ wall: 11_000 }]);
      expectPass(r);
      expect(r.seen).toEqual([expect.objectContaining({ kind: "unknown", wallMs: 11_000, monoMs: 11_000, subtractedMs: 0 })]);
    }
  }
}, 300_000);

test("production task and tip verification join a held untimed file as a named infra hang at the finite ceiling versus unbounded execution", async () => {
  const untimed: Partial<BaselineCommand> = { ceilingMs: 20_000, fileDurations: [{ file: "tests/other.test.ts", durationMs: 60 }] };
  const red: Partial<BaselineCommand> = { ceilingMs: 20_000, exitCode: 1, fileOutcomes: true,
    fileDurations: [{ file: FILE, durationMs: 60, failed: true }, { file: "tests/other.test.ts", durationMs: 60 }] };
  for (const surface of surfaces) {
    for (const entry of [untimed, red]) {
      const r = await drive(surface, entry, toBudget(20_000));
      expectHang(surface, r, 20_000, 20_000);
      expect(r.seen.map((i) => i.subtractedMs)).toEqual([0, 0]);
      if (surface === "task") expect(r.meta).toMatchObject({ activeMs: 20_000, wallMs: 20_000 });
    }
  }
}, 300_000);

const OTHER = "tests/other.test.ts";
test("production task and tip verification enforce the closed invalid budget table versus zero nonfinite or baseline-red measured slack", async () => {
  const other = { file: OTHER, durationMs: 5_000 };
  const red = { exitCode: 1, fileOutcomes: true };
  // [row, baseline entry, enforced budget, a completed service below it]
  const rows: Array<[string, Partial<BaselineCommand>, number, number?]> = [
    ["measured K=4000 L=5000 C=20000", { ceilingMs: 20_000, fileDurations: [{ file: FILE, durationMs: 4_000 }, other] }, 12_000, 11_999],
    ["measured K=100 L=500 C=20000 takes the floor", { ceilingMs: 20_000, fileDurations: [{ file: FILE, durationMs: 100 }, { file: OTHER, durationMs: 500 }] }, 10_000, 9_999],
    ["C=5000 below the floor wins", { ceilingMs: 5_000, fileDurations: [{ file: FILE, durationMs: 4_000 }, other] }, 5_000],
    ["green K=1000 beside another file red at 20000 keeps that red in L", { ceilingMs: 60_000, ...red,
      fileDurations: [{ file: FILE, durationMs: 1_000 }, { file: OTHER, durationMs: 20_000, failed: true }] }, 20_000, 15_000],
    ["absent ceiling and duration: untimed at 600000", { fileDurations: [other] }, 600_000, 599_999],
    ["absent ceiling, duration 100000: baseline-red at 600000", { durationMs: 100_000, ...red,
      fileDurations: [{ file: FILE, durationMs: 50, failed: true }, other] }, 600_000, 599_999],
    ["absent ceiling, duration 300000: untimed at 900000", { durationMs: 300_000, fileDurations: [other] }, 900_000, 899_999],
    ...[0, -1, NaN, Infinity, -Infinity].map((ceilingMs): [string, Partial<BaselineCommand>, number, number] =>
      [`unusable ceiling ${ceilingMs} falls back to 60000`, { ceilingMs, fileDurations: [other] }, 60_000, 59_999]),
    ...[undefined, 0, -1, NaN, Infinity, -Infinity].map((durationMs): [string, Partial<BaselineCommand>, number] =>
      [`unusable K ${durationMs} beside a valid L is C`, { ceilingMs: 20_000,
        fileDurations: [...(durationMs === undefined ? [] : [{ file: FILE, durationMs }]), other] }, 20_000]),
    ["usable K keeps its slack beside invalid L entries", { ceilingMs: 20_000, longestFile: { file: OTHER, durationMs: NaN },
      fileDurations: [{ file: FILE, durationMs: 4_000 }, { file: OTHER, durationMs: Infinity }, { file: "tests/x.test.ts", durationMs: -1 }, { file: "tests/y.test.ts", durationMs: NaN }] }, 12_000],
    ["red duplicate before green", { ceilingMs: 20_000, ...red, fileDurations: [{ file: FILE, durationMs: 4_000, failed: true }, { file: FILE, durationMs: 4_000 }, other] }, 20_000],
    ["green before an unusable red duplicate", { ceilingMs: 20_000, ...red, fileDurations: [{ file: FILE, durationMs: 4_000 }, { file: FILE, durationMs: NaN, failed: true }, other] }, 20_000],
    ["legacy red capture", { ceilingMs: 20_000, exitCode: 1, fileDurations: [{ file: FILE, durationMs: 4_000 }, other] }, 20_000],
    ["legacy longest-only", { ceilingMs: 20_000, longestFile: { file: FILE, durationMs: 4_000 } }, 20_000],
  ];
  for (const surface of surfaces) {
    for (const [row, entry, budget, completeAt] of rows) {
      const held = await drive(surface, entry, toBudget(budget));
      // at its finite, positive budget: never zero (the first poll below it kept the file), never unbounded
      expectHang(surface, held, budget, budget === 5_000 ? undefined : budget);
      expect(held.seen, `${surface} ${row}`).toHaveLength(2);
      if (completeAt === undefined) continue;
      const completed = await drive(surface, entry, [{ wall: completeAt }]);
      expectPass(completed);
    }
  }
}, 600_000);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** One line as `sysctl -n kern.sleeptime` prints it on a real host: `{ sec = N, usec = M } Www Mmm d hh:mm:ss yyyy`. */
function stamp(ms: number): string {
  const d = new Date(ms), two = (n: number) => String(n).padStart(2, "0");
  return `{ sec = ${Math.floor(ms / 1000)}, usec = ${(ms % 1000) * 1000} } ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} `
    + `${String(d.getUTCDate()).padStart(2, " ")} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
/** The two-line `sysctl -n kern.sleeptime kern.waketime` transcript, offsets from S0. */
const transcript = (sleep: number, wake: number) => `${stamp(S0 + sleep)}\n${stamp(S0 + wake)}\n`;
type Command = SleepEvidence["command"];
type CommandResult = ReturnType<Command>;
const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
/** The injected synchronous command boundary under the DEFAULT reader; `advanceMs` is service time on the gate's own clock. */
const sysctl = (result: Partial<CommandResult> & { advanceMs?: number }): Command => (file, args, opts) => {
  calls.push({ file, args, opts });
  clock.mono += result.advanceMs ?? 0;
  const { advanceMs: _advance, ...rest } = result;
  return { status: 0, signal: null, stdout: "", stderr: "", ...rest };
};
const darwin = (command: Command) => setSleepEvidenceForTests({ platform: () => "darwin", command });

test("production task and tip verification credit the closed sleep table at wall-equals-mono versus unknown-gap active overrun", async () => {
  const untimed = (ceilingMs: number): Partial<BaselineCommand> => ({ ceilingMs, fileDurations: [{ file: OTHER, durationMs: 60 }] });
  const measured30000: Partial<BaselineCommand> = { ceilingMs: 60_000, fileDurations: [{ file: FILE, durationMs: 10_000 }] };
  const SYSCTL = { file: "sysctl", args: ["-n", "kern.sleeptime", "kern.waketime"], opts: { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096, killSignal: "SIGKILL" } };
  for (const surface of surfaces) {
    // No reader override on injected Darwin: the DEFAULT reader runs the boundary once for the gap, inside its bounds
    // (999 ms, exactly 4096 combined bytes), and its parse credits 55000 ms before that same poll's hang decision.
    calls.length = 0;
    const out = transcript(2_500, 57_500);
    darwin(sysctl({ stdout: out, stderr: "x".repeat(4_096 - out.length), advanceMs: 999 }));
    const credited = await drive(surface, untimed(20_000), [{ wall: 60_000 }]);
    expectPass(credited);
    expect(calls).toEqual([SYSCTL]);
    expect(credited.seen).toEqual([expect.objectContaining({ kind: "host-suspend", wallMs: 60_000, monoMs: 60_000, subtractedMs: 55_000 })]);
    expect(credited.details).toContain("host interruptions: host-suspend 60000ms wall / 60000ms monotonic, 55000ms subtracted");

    // The clock-only control: non-Darwin never calls the reader; the same gap is unknown/0 and its active overrun hangs.
    calls.length = 0;
    setSleepEvidenceForTests({ platform: () => "linux", command: sysctl({ stdout: out }) });
    const clockOnly = await drive(surface, untimed(20_000), [{ wall: 60_000 }]);
    expectHang(surface, clockOnly, 20_000, 60_000);
    expect(calls).toEqual([]);
    expect(clockOnly.seen).toEqual([expect.objectContaining({ kind: "unknown", subtractedMs: 0 })]);

    // Unreadable evidence never excuses work: each 10000 ms gap carries one variant and credits 0, so the file
    // hangs at exactly sixteen gaps of active service. A transcript that WOULD credit 5000 ms of the gap rides
    // on every bounded-out variant, so wrongly trusting any one of them leaves the file alive.
    calls.length = 0;
    const children: number[] = [];
    const ends: Array<[NodeJS.Signals | null, string | undefined]> = [];
    const owned = (args: string[]): Command => (file, a, opts) => {
      calls.push({ file, args: a, opts });
      const r = spawnSync(process.execPath, args, opts);
      children.push(r.pid);
      ends.push([r.signal, (r.error as NodeJS.ErrnoException | undefined)?.code]);
      return r;
    };
    const inGap = (i: number) => transcript(10_000 * i + 2_000, 10_000 * i + 7_000);
    const variants: Array<(i: number) => void> = [
      (i) => darwin(sysctl({ stdout: inGap(i), advanceMs: 1_000 })), // equal to the 1000 ms bound
      (i) => darwin(sysctl({ stdout: inGap(i), advanceMs: 1_500 })), // over it
      (i) => darwin(sysctl({ stdout: inGap(i), stderr: "x".repeat(4_097 - inGap(i).length) })), // 4097 combined bytes
      (i) => darwin(sysctl({ stdout: inGap(i), status: 1 })),
      (i) => darwin(sysctl({ stdout: inGap(i), status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync sysctl ETIMEDOUT"), { code: "ETIMEDOUT" }) })),
      (i) => darwin(sysctl({ stdout: inGap(i).slice(0, -12) })), // truncated
      (i) => darwin(sysctl({ stdout: inGap(i).split("\n")[0] + "\n" })), // one stamp only
      () => darwin(sysctl({ stdout: `${stamp(0)}\n${stamp(0)}\n` })), // no sleep recorded
      (i) => darwin(sysctl({ stdout: transcript(10_000 * i + 7_000, 10_000 * i + 2_000) })), // reversed
      () => darwin(sysctl({ stdout: transcript(-50_000, -40_000) })), // outside the gap
      () => darwin(sysctl({ stdout: `{ sec = ${"9".repeat(400)}, usec = 0 } Tue Oct  6 00:00:00 2026\n{ sec = ${"9".repeat(401)}, usec = 0 } Tue Oct  6 00:00:01 2026\n` })),
      () => darwin(sysctl({ stdout: "kern.sleeptime: unavailable\nkern.waketime: unavailable\n" })), // malformed
      () => darwin((file, args, opts) => { calls.push({ file, args, opts }); throw new Error("spawnSync sysctl EAGAIN"); }),
      () => setSleepEvidenceForTests({ platform: () => "darwin", reader: () => { throw new Error("reader unavailable"); } }),
      // real owned children IGNORING SIGTERM under the reader's own options: past the 1000 ms timeout, and over 4096
      // output bytes. Only a SIGKILL bounds them; under SIGTERM spawnSync would wait out their 30000 ms hold.
      () => darwin(owned(["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"])),
      () => darwin(owned(["-e", "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 30000)"])),
    ];
    const budget = variants.length * 10_000;
    const unread = await drive(surface, untimed(budget), variants.map((before, i) => ({ wall: 10_000 * (i + 1), before: () => before(i) })));
    expectHang(surface, unread, budget, budget);
    expect(unread.seen.map((i) => [i.kind, i.subtractedMs])).toEqual(variants.map(() => ["unknown", 0]));
    expect(calls).toHaveLength(variants.length - 1); // one call per gap; the throwing reader override replaces the command
    expect(calls.every((c) => c.opts && (c.opts as { timeout: number }).timeout === 1_000 && (c.opts as { maxBuffer: number }).maxBuffer === 4_096
      && (c.opts as { killSignal: string }).killSignal === "SIGKILL")).toBe(true);
    expect(ends).toEqual([["SIGKILL", "ETIMEDOUT"], ["SIGKILL", "ENOBUFS"]]); // killed at each bound, never a voluntary exit
    for (const pid of children) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/); // each bounded child was joined

    // OS overlap larger than the gap is clamped to the gap.
    darwin(sysctl({ stdout: transcript(-10_000, 70_000) }));
    const clamped = await drive(surface, untimed(20_000), [{ wall: 60_000 }]);
    expectPass(clamped);
    expect(clamped.seen).toEqual([expect.objectContaining({ kind: "host-suspend", subtractedMs: 60_000, wallMs: 60_000 })]);

    // Partial window/file overlap: the gap's 40000 ms segment, but the file started 30000 ms into the gap, so only its
    // own 20000 ms overlap is credited — 10000 ms active hangs at the 10000 ms floor (crediting all 40000 would not).
    darwin(sysctl({ stdout: transcript(10_000, 50_000) }));
    const partial = await drive(surface, { ceilingMs: 20_000, fileDurations: [{ file: FILE, durationMs: 100 }, { file: OTHER, durationMs: 500 }] },
      [{ wall: 60_000 }], S0 + 30_000);
    expectHang(surface, partial, 10_000, 10_000, 30_000);
    expect(partial.seen).toEqual([expect.objectContaining({ kind: "host-suspend", subtractedMs: 40_000 })]);

    // A repeated interval is credited once: after a wall step back, the same pair overlapping the next gap adds nothing.
    darwin(sysctl({ stdout: transcript(5_000, 55_000) }));
    const repeated = await drive(surface, untimed(40_000), [{ wall: 60_000 }, { wall: 30_000, mono: 62_000 }, { wall: 90_000, mono: 122_000 }]);
    expectHang(surface, repeated, 40_000, 40_000, 90_000);
    expect(repeated.seen.map((i) => [i.kind, i.subtractedMs])).toEqual([["host-suspend", 50_000], ["unknown", 0], ["unknown", 0]]);

    // A 30000 ms clock offset and a 30000 ms OS overlap over one window are one suspend: subtractedMs 30000, never 60000,
    // so 30000 ms active hangs at a measured 30000 ms budget and completes under a 60000 ms one.
    for (const [entry, hangs] of [[measured30000, true], [untimed(60_000), false]] as const) {
      darwin(sysctl({ stdout: transcript(15_000, 45_000) }));
      const offset = await drive(surface, entry, [{ wall: 60_000, mono: 30_000 }]);
      if (hangs) expectHang(surface, offset, 30_000, 30_000, 60_000); else expectPass(offset);
      expect(offset.seen).toEqual([expect.objectContaining({ kind: "host-suspend", subtractedMs: 30_000 })]);
    }

    // NAMED RESIDUAL: two sleeps (20000 then 15000 ms) in one gap; the kernel exposes only the last pair, so 15000 is
    // credited, never 35000, and the file active from the gap's start hangs at 45000 ms against a 30000 ms budget.
    darwin(sysctl({ stdout: transcript(40_000, 55_000) }));
    const residual = await drive(surface, measured30000, [{ wall: 60_000 }]);
    expectHang(surface, residual, 30_000, 45_000, 60_000);
    expect(residual.seen).toEqual([expect.objectContaining({ kind: "host-suspend", subtractedMs: 15_000 })]);

    // The old wall-only discontinuity off Darwin: the offset alone is subtracted and the reader is never called.
    calls.length = 0;
    setSleepEvidenceForTests({ platform: () => "linux", command: sysctl({ stdout: transcript(0, 60_000) }) });
    const wallOnly = await drive(surface, untimed(20_000), [{ wall: 60_000, mono: 0 }]);
    expectPass(wallOnly);
    expect(calls).toEqual([]);
    expect(wallOnly.seen).toEqual([expect.objectContaining({ kind: "host-suspend", subtractedMs: 60_000 })]);
  }
}, 600_000);
