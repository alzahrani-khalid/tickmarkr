// Queue row 337 (D-2181 D1, D2): an interrupted test red is inconclusive infrastructure. Every row below
// runs through the production manifest gate (runGates → evaluateManifestedTest) with a stand-in runner
// resolved as the worktree's vitest, frozen injected hang clocks and an injected Darwin sleep segment, or
// through the production cache seam (VerdictStore, isInfraResult, failureDisposition). No real sleep.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { Baseline } from "../../src/gates/baseline.js";
import { isInfraResult, resolveStateDir, VerdictStore, type StoredVerdictRecord } from "../../src/gates/cache.js";
import { runGates } from "../../src/gates/run-gates.js";
import { resetHangClocksForTests, resetSleepEvidenceForTests, runWithInterruptionSink, setHangClocksForTests,
  setSleepEvidenceForTests, type HostInterruption } from "../../src/gates/test-manifest.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import { executedFullTest, failureDisposition, INTERRUPTED_RETRY_EVENT, interruptedReason, interruptedRetryState } from "../../src/run/recovery.js";
import { repairSelectionDecision } from "../../src/run/repair-selection.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// The captured run's line-273 host-suspend and its four attributed failing files (fixture data only).
const FROM = 1793621905332;
const WALL_MS = 170964;
const MONO_MS = 170963.3752500005;
const SUBTRACTED_MS = 170759.0830078125;
const CLOSED = "tests/run/daemon/transport-closed.test.ts";
const OTHERS = ["tests/run/daemon/resume-facts.test.ts", "tests/run/daemon/sweep-failure.test.ts", "tests/run/daemon/transport-held.test.ts"];
const CAPTURED_FILES = [...OTHERS, CLOSED].sort();
const CAPTURED_SUSPEND = { kind: "host-suspend", from: FROM, to: FROM + WALL_MS, wallMs: WALL_MS, monoMs: MONO_MS, subtractedMs: SUBTRACTED_MS };
const CMD = "vitest run";
const OUTER_MS = 60_000;
const MONO0 = 5_000_000;
const clock = { wall: 0, mono: 0 };
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" }, tasks: [
  { id: "T1", title: "interrupted", goal: "interrupted", shape: "implement", complexity: 3, gates: ["build", "test", "lint", "evidence", "scope"], acceptance: ["done"], files: ["**"] },
] }).tasks[0]!;

beforeEach(() => {
  setHangClocksForTests({ wall: () => FROM + clock.wall, mono: () => MONO0 + clock.mono });
  // The detector's own kernel-credit path, fed the captured segment; an on-time poll never reads it.
  setSleepEvidenceForTests({ platform: () => "darwin", reader: () => ({ sleep: FROM + 100, wake: FROM + 100 + SUBTRACTED_MS }) });
});
afterEach(() => { resetHangClocksForTests(); resetSleepEvidenceForTests(); });

interface Completion { at: number; status: "passed" | "failed"; failures?: string[]; tests: { passed: number; failed: number; skipped: number } }
interface RunnerSpec {
  files: string[];
  started: Record<string, number>;
  completed: Record<string, Completion>;
  exit: number;
  certificate: { at: number; exitCode: number; errors: number; diagnostics: string[] };
  scheduling?: Record<string, { pool: string; singleFork: boolean }>;
  /** What a stranded single-fork retry's own discovery lists. */
  retryList?: string[];
  /** The discovery listing itself fails with this exit: no test is ever invoked. */
  listExit?: number;
  /** A stranded single-fork retry's own execution: its own requested files, measurements and exit. */
  continuation?: Pick<RunnerSpec, "files" | "started" | "completed" | "exit" | "certificate">;
}
type Row = { started: Record<string, number>; completed: Record<string, Completion> };
const failed = (file: string, from: number, to: number): Row => ({
  started: { [file]: from }, completed: { [file]: { at: to, status: "failed", failures: [`${file} > breaks`], tests: { passed: 0, failed: 1, skipped: 0 } } },
});
const passed = (file: string, from: number, to: number): Row => ({
  started: { [file]: from }, completed: { [file]: { at: to, status: "passed", tests: { passed: 1, failed: 0, skipped: 0 } } },
});
function spec(rows: Row[], exit = 1): RunnerSpec {
  const files = rows.flatMap((r) => Object.keys(r.started)).sort();
  return { files, exit, started: Object.assign({}, ...rows.map((r) => r.started)), completed: Object.assign({}, ...rows.map((r) => r.completed)),
    certificate: { at: FROM + 200_000, exitCode: exit, errors: 0, diagnostics: [] } };
}

let shared: { repo: string; base: string } | undefined;
function fixture(s: RunnerSpec, keepState = false) {
  if (!shared) {
    const repo = makeRepo({ ".gitignore": "node_modules/\n", "src/a.ts": "export const a = 1;\n",
      "package.json": JSON.stringify({ type: "module", scripts: { test: CMD } }) });
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    git(repo, "add", "-A"); git(repo, "commit", "--no-gpg-sign", "-m", "change");
    mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
    shared = { repo, base };
  }
  const { repo, base } = shared;
  if (!keepState) rmSync(join(repo, ".tickmarkr"), { recursive: true, force: true });
  const dir = makeTestTempDir("interrupted-verdict-marks-");
  const mark = join(dir, randomBytes(4).toString("hex"));
  writeFileSync(`${mark}.spec.json`, JSON.stringify(s));
  // Outside the worktree: the gate refuses a tree its test command left dirty.
  writeFileSync(join(repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const mark = ${JSON.stringify(mark)}, spec = JSON.parse(fs.readFileSync(mark + '.spec.json', 'utf8'));
if (process.argv[2] === 'list') {
  if (spec.listExit) { console.error('cannot list'); process.exit(spec.listExit); }
  const files = process.argv.some((a) => a.startsWith('--exclude')) ? spec.retryList : spec.files;
  console.log(JSON.stringify(files.map((file) => ({ file: path.resolve(file), name: file })))); process.exit(0);
}
// Each invocation is bound to its OWN report: the first pass, then a continuation with its own spec.
const runs = (fs.existsSync(mark + '.runs') ? Number(fs.readFileSync(mark + '.runs', 'utf8')) : 0) + 1;
fs.writeFileSync(mark + '.runs', String(runs));
const pass = runs > 1 && spec.continuation ? spec.continuation : spec, tag = runs > 1 ? String(runs) : '';
const out = process.env.TICKMARKR_TEST_REPORT;
const report = { nonce: process.env.TICKMARKR_TEST_NONCE, requested: pass.files, started: pass.started, completed: {},
  ...(pass === spec && spec.scheduling ? { scheduling: spec.scheduling } : {}) };
fs.writeFileSync(out, JSON.stringify(report));
fs.writeFileSync(mark + '.started' + tag, String(process.pid));
const held = setInterval(() => {
  if (!fs.existsSync(mark + '.release' + tag)) return;
  clearInterval(held);
  report.completed = pass.completed;
  report.certificate = pass.certificate;
  fs.writeFileSync(out, JSON.stringify(report));
  process.exit(pass.exit);
}, 10);
`, { mode: 0o755 });
  return { repo, base, mark, artifacts: makeTestTempDir("interrupted-verdict-") };
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + OUTER_MS; !done();) {
    if (Date.now() > deadline) throw new Error(`never observed: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One production task gate round. `interrupt` moves the frozen clocks by the captured gap only after the
 * runner's started record exists, and waits for the poll that records it before releasing the runner. */
async function drive(s: RunnerSpec, interrupt: boolean | "continuation", keepState = false, singleExecution = false) {
  const f = fixture(s, keepState);
  clock.wall = 0; clock.mono = 0;
  const seen: HostInterruption[] = [];
  const notes: string[] = [];
  let settled = false;
  const baseline = { commands: { test: { cmd: CMD, exitCode: 0, fingerprints: [] } } } as unknown as Baseline;
  const outcome = runWithInterruptionSink((i) => { seen.push(i); }, () => runGates(task, {
    worktree: f.repo, baseRef: f.base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
    result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: CMD }, baseline,
    channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: f.artifacts,
    ...(singleExecution ? { singleExecution: true as const } : {}),
    onGate: (e) => { if (e.phase === "note") notes.push(e.name); },
  })).finally(() => { settled = true; });
  await until(() => existsSync(`${f.mark}.started`) || settled, "the runner's started record");
  // "continuation": the first pass runs uninterrupted; the suspend lands inside the continuation only.
  const tag = interrupt === "continuation" ? "2" : "";
  if (tag) {
    writeFileSync(`${f.mark}.release`, "");
    await until(() => existsSync(`${f.mark}.started2`) || settled, "the continuation's started record");
  }
  if (interrupt) {
    clock.mono = MONO_MS; clock.wall = WALL_MS;
    await until(() => seen.length > 0 || settled, "the poll's interruption record");
  }
  writeFileSync(`${f.mark}.release${tag}`, "");
  const out = await outcome;
  const r = out.results.find((g) => g.gate === "test")!;
  const runs = existsSync(`${f.mark}.runs`) ? Number(readFileSync(`${f.mark}.runs`, "utf8")) : 0;
  return { result: r, meta: r.meta ?? {}, seen, notes, runs, repo: f.repo, artifacts: f.artifacts };
}

const verdictFiles = (repo: string, artifacts: string): string[] => {
  const dir = join(resolveStateDir(repo, artifacts), "verdicts");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("verdict-") && f.endsWith(".json")).map((f) => join(dir, f)) : [];
};

describe("row 337 (D-2181 D1): interrupted test reds are inconclusive", () => {
  test("the interruption verdict CASE table preserves raw red evidence under inconclusive classification", async () => {
    // Base row: the captured attempt-three red — the measured transport-closed window holds the captured suspend.
    const captured = spec([failed(CLOSED, 1793621893704, 1793622077279),
      failed(OTHERS[0]!, FROM + 10, FROM + 20), failed(OTHERS[1]!, FROM + 30, FROM + 40), failed(OTHERS[2]!, FROM + 50, FROM + 60)]);
    const base = await drive(captured, true);
    expect(base.seen).toHaveLength(1);
    expect(base.seen[0]).toEqual(CAPTURED_SUSPEND);
    expect(base.result.pass).toBe(false);
    expect(base.meta).toMatchObject({ disposition: "interrupted", infra: true, classification: "regression", failingFiles: CAPTURED_FILES,
      interruptions: [CAPTURED_SUSPEND] });
    expect(base.meta.failureWindows).toContainEqual({ file: CLOSED, from: 1793621893704, to: 1793622077279 });
    expect((base.meta.failingTests as string[]).sort()).toEqual(CAPTURED_FILES.map((f) => `${f} > breaks`));
    expect(base.result.details).toContain("test report names failing fingerprint(s)");
    expect(base.result.details).toContain("host interruptions: host-suspend 170964ms wall");
    expect(base.result.details).toMatch(/interrupted: host-suspend interruption overlaps tests\/run\/daemon\//);
    expect(failureDisposition(base.result)).toBe("interrupted");
    expect(isInfraResult(base.result)).toBe(true);
    // never stored as reusable proof, never behavioral repair provenance
    expect(verdictFiles(base.repo, base.artifacts)).toEqual([]);
    const row = { event: "gate-result", taskId: "T1", data: { gate: "test", pass: false, commit: "c".repeat(64), ...base.meta } };
    expect(repairSelectionDecision([row], "T1", true)).toEqual({ selectTests: true, requiredFiles: [], reason: "no-test-failure" });

    // No interruptions: existing verdict and disposition, unchanged.
    const plain = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), false);
    expect(plain.seen).toEqual([]);
    expect(plain.meta.disposition).toBeUndefined();
    expect(plain.meta.infra).toBeUndefined();
    expect(failureDisposition(plain.result)).toBe("behavioral");
    expect(failureDisposition({ pass: false, meta: { ...plain.meta, interruptions: [] } })).toBe("behavioral");

    // Equality at either edge overlaps: the window ends where the suspend begins / begins where it ends.
    for (const [from, to] of [[FROM - 5_000, FROM], [FROM + WALL_MS, FROM + WALL_MS + 5_000]] as const) {
      const edge = await drive(spec([failed(CLOSED, from, to)]), true);
      expect(edge.meta.disposition, `${from}..${to}`).toBe("interrupted");
      expect(failureDisposition(edge.result)).toBe("interrupted");
    }

    // Every failing window strictly outside every valid interruption: the existing red disposition.
    const outside = await drive(spec([failed(CLOSED, FROM - 5_000, FROM - 1), failed(OTHERS[0]!, FROM + WALL_MS + 1, FROM + WALL_MS + 9)]), true);
    expect(outside.seen).toHaveLength(1);
    expect(outside.meta.disposition).toBeUndefined();
    expect(outside.meta.interruptions).toEqual([CAPTURED_SUSPEND]);
    expect(failureDisposition(outside.result)).toBe("behavioral");
    expect(isInfraResult(outside.result)).toBe(false);

    // A green with interruptions stays green; nothing is retried or reclassified.
    const green = await drive(spec([passed(CLOSED, FROM - 5_000, FROM + WALL_MS + 5)], 0), true);
    expect(green.result.pass, green.result.details).toBe(true);
    expect(green.meta.interruptions).toEqual([CAPTURED_SUSPEND]);
    expect(green.meta.disposition).toBeUndefined();
    expect(green.meta.runnerInfraRerun).toBeUndefined();

    // A nonempty malformed interruption record, or a red whose report binding is unreadable: inconclusive
    // infrastructure naming the unreadable evidence, with no behavioral attribution and no reuse.
    const malformed = { pass: false, meta: { classification: "regression", failingFiles: [CLOSED], interruptions: [{ kind: "host-suspend", from: FROM }] } };
    expect(interruptedReason(malformed)).toMatch(/unreadable interruption evidence/);
    expect(failureDisposition(malformed)).toBe("interrupted");
    expect(isInfraResult(malformed)).toBe(true);
    const unbound = { pass: false, meta: { classification: "infra", infra: true, missingReport: true, interruptions: [CAPTURED_SUSPEND] } };
    expect(failureDisposition(unbound)).toBe("infrastructure");
    expect(isInfraResult(unbound)).toBe(true);
    const unboundRegression = { pass: false, meta: { classification: "regression", interruptions: [CAPTURED_SUSPEND] } };
    expect(interruptedReason(unboundRegression)).toMatch(/unreadable failing-file evidence/);
  }, 120_000);

  test("first pass and continuation failures retain their own measured windows and missing partial malformed or unreadable windows never prove nonoverlap", async () => {
    // A stranded single-fork first pass: A failed inside the suspend, B never ran; the continuation's own
    // discovery then lists a different set and throws. The catch path keeps the first pass's evidence.
    const A = "tests/a.test.ts", B = "tests/b.test.ts";
    const stranded: RunnerSpec = {
      files: [A, B], exit: 1,
      ...failed(A, FROM - 1_000, FROM + 1_000),
      scheduling: { [A]: { pool: "forks", singleFork: false }, [B]: { pool: "forks", singleFork: true } },
      certificate: { at: FROM + 2_000, exitCode: 1, errors: 1, diagnostics: ['Error: [vitest-worker]: Timeout calling "onTaskUpdate"'] },
      retryList: [A],
    };
    const thrown = await drive(stranded, true);
    expect(thrown.result.pass).toBe(false);
    expect(thrown.meta.manifestDiscoveryFailed).toBe(true);
    expect(thrown.result.details).toMatch(/single fork retry discovery does not match the stranded set/);
    expect(thrown.meta).toMatchObject({ disposition: "interrupted", infra: true, classification: "regression", failingFiles: [A],
      interruptions: [CAPTURED_SUSPEND], failureWindows: [{ file: A, from: FROM - 1_000, to: FROM + 1_000 }] });
    expect(thrown.meta.recovery).toMatchObject({ files: [B] });
    expect(failureDisposition(thrown.result)).toBe("interrupted");

    // A continuation that EXECUTES: each invocation-bound report contributes its own failing window, and
    // the suspend lands inside the continuation only — its overlap is confined to the continuation's file.
    const continued = (first: [number, number], second: [number, number]): RunnerSpec => ({
      ...stranded, retryList: [B], ...failed(A, ...first),
      continuation: { files: [B], exit: 1, ...failed(B, ...second), certificate: { at: FROM + WALL_MS + 100, exitCode: 1, errors: 0, diagnostics: [] } },
    });
    const confined = await drive(continued([FROM - 9_000, FROM - 8_000], [FROM + 10, FROM + 20]), "continuation");
    expect(confined.seen).toEqual([CAPTURED_SUSPEND]);
    expect(confined.meta.manifestDiscoveryFailed).toBeUndefined();
    expect(confined.meta.recovery).toMatchObject({ files: [B] });
    expect(confined.meta).toMatchObject({ disposition: "interrupted", infra: true, classification: "regression", failingFiles: [A, B],
      interruptions: [CAPTURED_SUSPEND] });
    expect(confined.meta.failureWindows).toEqual([{ file: A, from: FROM - 9_000, to: FROM - 8_000 }, { file: B, from: FROM + 10, to: FROM + 20 }]);
    expect(confined.meta.interruptedReason).toBe(`host-suspend interruption overlaps ${B}`);
    expect(failureDisposition(confined.result)).toBe("interrupted");
    // control: the continuation's window outside the suspend — both measured windows prove non-overlap
    const clear = await drive(continued([FROM - 9_000, FROM - 8_000], [FROM + WALL_MS + 10, FROM + WALL_MS + 20]), "continuation");
    expect(clear.seen).toEqual([CAPTURED_SUSPEND]);
    expect(clear.meta.failureWindows).toEqual([{ file: A, from: FROM - 9_000, to: FROM - 8_000 }, { file: B, from: FROM + WALL_MS + 10, to: FROM + WALL_MS + 20 }]);
    expect(clear.meta.disposition).toBeUndefined();
    expect(failureDisposition(clear.result)).toBe("behavioral");

    // Each pass keeps its OWN measured window: a first-pass file is never bound only to a continuation's report.
    const twoPass = { pass: false, meta: { classification: "regression", failingFiles: [A, B], interruptions: [CAPTURED_SUSPEND] } };
    const windows = { first: { file: A, from: FROM - 9_000, to: FROM - 8_000 }, continuation: { file: B, from: FROM + WALL_MS + 10, to: FROM + WALL_MS + 20 } };
    expect(failureDisposition({ ...twoPass, meta: { ...twoPass.meta, failureWindows: [windows.first, windows.continuation] } })).toBe("behavioral");
    expect(failureDisposition({ ...twoPass, meta: { ...twoPass.meta, failureWindows: [{ ...windows.first, to: FROM }, windows.continuation] } })).toBe("interrupted");

    // Missing, partial, malformed or unreadable windows never prove non-overlap.
    const cells: [string, unknown][] = [
      ["missing", undefined],
      ["partial", [windows.first]],
      ["malformed: reversed", [windows.first, { file: B, from: 20, to: 10 }]],
      ["malformed: non-finite", [windows.first, { file: B, from: Number.NaN, to: 10 }]],
      ["malformed: duplicate unreadable entry", [windows.first, windows.continuation, { file: B, from: "x", to: 1 }]],
      ["unreadable", "not-an-array"],
    ];
    for (const [cell, failureWindows] of cells) {
      const r = { ...twoPass, meta: { ...twoPass.meta, ...(failureWindows === undefined ? {} : { failureWindows }) } };
      expect(interruptedReason(r), cell).toMatch(/overlap with the interruption is unproved/);
      expect(failureDisposition(r), cell).toBe("interrupted");
      expect(isInfraResult(r), cell).toBe(true);
    }
  }, 120_000);

  test("the test cache refuses interrupted verdicts in memory on disk and in legacy regression records while uninterrupted and green reuse controls keep their existing proof rules", async () => {
    // Uninterrupted red control: stored by the fresh round, reused by the next battery round.
    const red = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), false);
    const [stored] = verdictFiles(red.repo, red.artifacts);
    expect(stored).toBeDefined();
    const reusedRed = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), false, true);
    expect(reusedRed.notes).toContain("gate-reused-verdict");
    expect(reusedRed.meta.reused).toBe(true);
    expect(failureDisposition(reusedRed.result)).toBe("behavioral");

    // On disk: a pre-upgrade record carrying the captured interruption and only a raw regression
    // classification (no windows, no disposition) is derived interrupted and refused — the gate runs.
    const record = JSON.parse(readFileSync(stored!, "utf8")) as StoredVerdictRecord;
    const legacy = { ...record, verdict: { ...record.verdict, meta: { ...record.verdict.meta, interruptions: [CAPTURED_SUSPEND] } } };
    delete (legacy.verdict.meta as Record<string, unknown>).failureWindows;
    writeFileSync(stored!, JSON.stringify(legacy));
    const store = new VerdictStore(join(resolveStateDir(red.repo, red.artifacts), "verdicts"));
    expect(store.get(legacy.identity)).toBeUndefined();
    expect(isInfraResult(legacy.verdict)).toBe(true);
    const refusedLegacy = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), false, true);
    expect(refusedLegacy.notes).not.toContain("gate-reused-verdict");
    expect(refusedLegacy.meta.reused).toBeUndefined();

    // Explicit interrupted disposition, even beside contradicting fields (no interruptions, regression):
    // refused on read, and never stored as reusable.
    const explicit = { ...record, verdict: { ...record.verdict, meta: { ...record.verdict.meta, disposition: "interrupted", interruptions: [] } } };
    writeFileSync(stored!, JSON.stringify(explicit));
    expect(store.get(explicit.identity)).toBeUndefined();
    const refusedExplicit = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), false, true);
    expect(refusedExplicit.notes).not.toContain("gate-reused-verdict");
    expect(store.set(explicit.identity, explicit.verdict as GateResult)).toBe(false);
    // The same explicit disposition beside a contradicting pass: true is refused at both boundaries, so a
    // green round over it executes fresh instead of re-proving and reusing it as green proof.
    const contradictory = { ...explicit, verdict: { ...explicit.verdict, pass: true } };
    writeFileSync(stored!, JSON.stringify(contradictory));
    expect(new VerdictStore(join(resolveStateDir(red.repo, red.artifacts), "verdicts")).get(contradictory.identity)).toBeUndefined();
    expect(isInfraResult(contradictory.verdict)).toBe(true);
    const refusedContradictory = await drive(spec([passed(CLOSED, FROM - 5_000, FROM + 5_000)], 0), false, true);
    expect(refusedContradictory.notes).not.toContain("gate-reused-verdict");
    expect(refusedContradictory.meta.reused).toBeUndefined();
    expect(refusedContradictory.result.pass).toBe(true);
    expect(store.set(contradictory.identity, contradictory.verdict as GateResult)).toBe(false);

    // In memory: a fresh interrupted verdict is never written, so the next round executes again.
    rmSync(join(resolveStateDir(red.repo, red.artifacts), "verdicts"), { recursive: true, force: true });
    const live = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), true);
    expect(live.meta.disposition).toBe("interrupted");
    expect(store.set(legacy.identity, live.result)).toBe(false);
    expect(verdictFiles(live.repo, live.artifacts)).toEqual([]);
    const again = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), false, true);
    expect(again.notes).not.toContain("gate-reused-verdict");
    expect(again.meta.reused).toBeUndefined();

    // Green control: an interrupted GREEN is stored and reused only after its full-manifest re-proof.
    rmSync(join(resolveStateDir(red.repo, red.artifacts), "verdicts"), { recursive: true, force: true });
    const green = await drive(spec([passed(CLOSED, FROM - 5_000, FROM + WALL_MS + 5)], 0), true);
    expect(green.result.pass).toBe(true);
    expect(verdictFiles(green.repo, green.artifacts)).toHaveLength(1);
    const reusedGreen = await drive(spec([passed(CLOSED, FROM - 5_000, FROM + WALL_MS + 5)], 0), false, true);
    expect(reusedGreen.notes).toContain("gate-reused-verdict");
    expect(reusedGreen.result.pass).toBe(true);
    expect(reusedGreen.meta.reused).toBe(true);

    // A single-execution round — the reserved retry or an interrupted subject's recheck (row 337, D-2181 D2):
    // no cached uninterrupted test verdict answers it, green or red. It executes once, fresh; the ordinary
    // round after it keeps the existing reuse rules.
    for (const cached of [spec([passed(CLOSED, FROM - 5_000, FROM + 5_000)], 0), spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)])]) {
      rmSync(join(resolveStateDir(red.repo, red.artifacts), "verdicts"), { recursive: true, force: true });
      const seeded = await drive(cached, false);
      expect(seeded.runs).toBe(1);
      expect(verdictFiles(seeded.repo, seeded.artifacts)).toHaveLength(1);
      const single = await drive(cached, false, true, true);
      expect(single.runs).toBe(1);
      expect(single.notes).not.toContain("gate-reused-verdict");
      expect(single.meta.reused).toBeUndefined();
      expect(single.result.pass).toBe(cached.exit === 0);
      const ordinary = await drive(cached, false, true);
      expect(ordinary.runs).toBe(0);
      expect(ordinary.notes).toContain("gate-reused-verdict");
    }
  }, 240_000);

  test("a discovery failure is an unexecuted refusal that never consumes the interruption retry while executed manifest reds do", async () => {
    // The journal row's execution fields, exactly as the daemon lifts them from this production result.
    const row = (r: { result: GateResult; meta: Record<string, unknown> }) => ({ event: "gate-result", taskId: "T1", data: {
      ...r.meta, gate: "test", pass: r.result.pass, commit: "c".repeat(64),
      evidenceReceipt: r.result.evidenceReceipt, evidenceReceipts: r.result.evidenceReceipts } });
    const reservation = { event: INTERRUPTED_RETRY_EVENT, taskId: "T1", data: { commit: "c".repeat(64), attempt: 0 } };
    const refused = await drive({ ...spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), listExit: 2 }, false);
    expect(refused.result.pass).toBe(false);
    expect(refused.meta.manifestDiscoveryFailed).toBe(true);
    expect(refused.result.evidenceReceipts?.length).toBeGreaterThan(0); // the listing ran; no test did
    expect(executedFullTest(row(refused).data)).toBe(false);
    expect(interruptedRetryState([reservation, row(refused)], "T1", "c".repeat(64)).kind).toBe("reserved");
    // controls: an executed interrupted red, and a thrown continuation after an executed first pass
    const ran = await drive(spec([failed(CLOSED, FROM - 5_000, FROM + 5_000)]), true);
    expect(ran.meta.disposition).toBe("interrupted");
    expect(executedFullTest(row(ran).data)).toBe(true);
    expect(interruptedRetryState([reservation, row(ran)], "T1", "c".repeat(64)).kind).toBe("consumed");
    const A = "tests/a.test.ts", B = "tests/b.test.ts";
    const thrown = await drive({ files: [A, B], exit: 1, ...failed(A, FROM - 1_000, FROM + 1_000),
      scheduling: { [A]: { pool: "forks", singleFork: false }, [B]: { pool: "forks", singleFork: true } },
      certificate: { at: FROM + 2_000, exitCode: 1, errors: 1, diagnostics: ['Error: [vitest-worker]: Timeout calling "onTaskUpdate"'] },
      retryList: [A] }, true);
    expect(thrown.meta.manifestDiscoveryFailed).toBe(true);
    expect(executedFullTest(row(thrown).data)).toBe(true);
  }, 120_000);
});
