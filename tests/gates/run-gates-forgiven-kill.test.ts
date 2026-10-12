import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { type Baseline, captureBaseline, resetCalmWindowForTests, setCalmWindowForTests } from "../../src/gates/baseline.js";
import { computeVerificationIdentity, getVerdictStore, isInfraResult } from "../../src/gates/cache.js";
import { type GateContext, runGates } from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import { gitHead, resolvedCapacity } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

// S19m4 (queue row 19 m4, ANL-021): kill text beside a forgiven non-zero exit is infra and never cached
// green. Every case is a REAL captureBaseline capture read back through the production readers — the
// battery (runGates → compareToBaseline) and the tip (verifyIntegrationTip). The runner's output and exit
// code live in IGNORED files, so a case can change what the runner prints without moving the tree identity
// a cached verdict is keyed on.

const KNOWN = "FAIL tests/known.test.ts > pre-existing red";
const SHAPED_SIGNAL = "FAIL tests/sig.test.ts > handles SIGTERM";
const KILL = "worker exited with SIGKILL";
const SCRIPT = 'if [ $# -gt 0 ]; then echo selected >> calls.txt; exit 0; fi\necho full >> calls.txt\ncat out.txt\nexit "$(cat code.txt)"\n';
const COMMAND = "bash run.sh";
// v2.6.7 T1: an attributed diagnostic is admitted only beside a semantic gate and on comparable timing
// (a red capture's timings count only with classified per-file outcomes, hence fileOutcomes below).
const ADMITTING_TIMING = [{ file: "tests/a.test.ts", durationMs: 1 }, { file: "tests/heavy.test.ts", durationMs: 99 }];

beforeEach(() => setCalmWindowForTests({ loadProvider: () => 0 }));
afterEach(() => resetCalmWindowForTests());

function judged(): Pick<GateContext, "cfg" | "adapters"> {
  const scriptPath = join(makeTestTempDir("tickmarkr-kill-judge-"), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  return { cfg, adapters: [new FakeAdapter(scriptPath)] };
}

/** A worktree whose test runner prints `out` and exits `code`, beside a baseline that recorded KNOWN and SHAPED_SIGNAL. */
async function fixture(opts: { selectTests?: boolean } = {}) {
  const repo = makeRepo({
    "tests/a.test.ts": "// initial\n", "run.sh": SCRIPT,
    ".gitignore": "calls.txt\nout.txt\ncode.txt\n.tickmarkr/\n",
  });
  const print = (out: string, code = 1) => {
    writeFileSync(join(repo, "out.txt"), `${out}\n`);
    writeFileSync(join(repo, "code.txt"), String(code));
  };
  print(`${KNOWN}\n${SHAPED_SIGNAL}`);
  const captured = await captureBaseline(repo, { test: COMMAND });
  const baseline: Baseline = { ...captured, commands: { test: { ...captured.commands.test!, fileDurations: ADMITTING_TIMING, fileOutcomes: true } } };
  rmSync(join(repo, "calls.txt"), { force: true });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "tests/a.test.ts"), "// changed\n");
  execSync('git add -A && git commit --no-gpg-sign -m "change test"', { cwd: repo });
  const select = opts.selectTests === true;
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["s"], hash: "h" }, tasks: [T("T1", {
    gates: select ? ["build", "test", "lint", "evidence", "scope", "acceptance"] : ["build", "test", "lint", "evidence", "scope"],
    files: ["tests/**"],
  })] }).tasks[0]!;
  const ctx: GateContext = {
    worktree: repo, baseRef, commands: { test: COMMAND }, baseline,
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    result: { ok: true, summary: "", deviations: [], raw: "" },
    channels: [], ...(select ? judged() : { adapters: [], cfg: structuredClone(DEFAULT_CONFIG) }),
    ...(select ? { selectTests: true, requiredRepairTests: ["tests/a.test.ts"], selectionReason: "known-failing-files" } : {}),
    stateDir: makeTestTempDir("tickmarkr-forgiven-kill-"),
  };
  const store = getVerdictStore(ctx.stateDir!);
  const identity = (await computeVerificationIdentity({ worktree: repo, gate: "test", command: COMMAND, baseline, capacity: resolvedCapacity() }))!;
  expect(identity.tree).toBeTruthy();
  const calls = () => existsSync(join(repo, "calls.txt")) ? readFileSync(join(repo, "calls.txt"), "utf8").trim().split("\n") : [];
  const testRow = async (over: Partial<GateContext> = {}) =>
    (await runGates(task, { ...ctx, ...over })).results.find((r) => r.gate === "test")!;
  return { repo, ctx, store, identity, calls, print, testRow };
}

function expectKillInfra(row: GateResult, line: string): void {
  expect(row.pass).toBe(false);
  expect(row.details.startsWith("infra;")).toBe(true);
  expect(row.details).toContain(line);
  expect(row.meta).toMatchObject({ classification: "infra", infra: true, retryable: false, kind: "signal-exit" });
  expect(row.meta?.forgivenFingerprints).toEqual(expect.arrayContaining([expect.stringContaining("pre-existing red")]));
  expect(row.meta?.killTextRead).toBeUndefined();
}

function expectForgiven(row: GateResult): void {
  expect(row.pass).toBe(true);
  expect(row.details).toContain("(forgiven)");
  expect(row.meta?.killTextRead).toBe(true);
  expect(row.meta?.infra).toBeUndefined();
}

test("test: through runGates a forgiven exit 1 beside an unshaped worker SIGKILL or exit code 137 or signal 9 line is a non-retryable infra red that is never cached versus the only signal word sitting inside a baseline-known shaped line or a Vitest echo block staying forgiven (S19m4-F1 F2 F3 P3 P4)", async () => {
  for (const line of [KILL, "runner: worker pool child exit code 137", "worker stopped by signal 9"]) {
    const { store, identity, calls, print, testRow } = await fixture();
    print(`${KNOWN}\n${line}`);
    const row = await testRow();
    expectKillInfra(row, line);
    expect(row.evidenceReceipt?.termination).toMatchObject({ kind: "exit", exitCode: 1 });
    expect(store.get(identity)).toBeUndefined();
    expect(calls()).toEqual(["full"]);
  }

  // P3: the signal word sits inside a failure line the baseline already recorded.
  const shaped = await fixture();
  shaped.print(`${KNOWN}\n${SHAPED_SIGNAL}`);
  const p3 = await shaped.testRow();
  expectForgiven(p3);
  expect(shaped.store.get(shaped.identity)).toMatchObject({ pass: true, meta: { killTextRead: true } });

  // P4: kill text inside a Vitest echo block is test-owned output, never the runner's.
  const echoed = await fixture();
  echoed.print(`stderr | tests/known.test.ts > pre-existing red\n${KILL}\n\n${KNOWN}`);
  expectForgiven(await echoed.testRow());
}, 120_000);

test("test: through runGates a historical forgiven test green with a normal exit 1 receipt and no kill-text marker seeded at the battery read and the diagnostic-admission read and the merge-candidate read is reused by none so each runs its command and admission never decides full-green-cache and a second battery over kill output runs again versus the same seeded green carrying the marker being reused at each (S19m4-F4 F5 P2)", async () => {
  // One real forgiven green, measured by this engine: it carries the marker and a normal exit 1 receipt.
  const source = await fixture();
  source.print(KNOWN);
  expectForgiven(await source.testRow());
  const marked = source.store.get(source.identity)!;
  expect(marked).toMatchObject({ pass: true, meta: { killTextRead: true } });
  expect(marked.evidenceReceipt?.termination).toMatchObject({ kind: "exit", exitCode: 1 });
  const { killTextRead: _, ...historicalMeta } = marked.meta!;
  const historical = { ...marked, meta: historicalMeta };
  expect(historical.meta.forgivenFingerprints).toBeDefined();

  // Battery read. P2: the marked green is reused, nothing runs.
  const battery = await fixture();
  battery.print(KNOWN);
  battery.store.set(battery.identity, marked);
  expect(await battery.testRow()).toMatchObject({ pass: true, meta: { reused: true } });
  expect(battery.calls()).toEqual([]);
  // F5: the same green without the marker is unproven — the command runs and the fresh green is marked.
  battery.store.set(battery.identity, historical);
  const remeasured = await battery.testRow();
  expectForgiven(remeasured);
  expect(remeasured.meta?.reused).not.toBe(true);
  expect(battery.calls()).toEqual(["full"]);
  // F4: over kill output the historical green is refused and the infra red is never written, so the
  // second battery runs the command again.
  battery.store.set(battery.identity, historical);
  battery.print(`${KNOWN}\n${KILL}`);
  for (let round = 0; round < 2; round++) {
    const row = await battery.testRow();
    expectKillInfra(row, KILL);
    expect(row.meta?.reused).not.toBe(true);
  }
  expect(battery.calls()).toEqual(["full", "full", "full"]);
  expect(battery.store.get(battery.identity)?.meta?.killTextRead).toBeUndefined();

  // Diagnostic-admission read AND merge-candidate read, both seeded with the historical green before the
  // round: admission refuses it (the diagnostic runs), and the merge-candidate refuses it (the full job runs).
  const unmarked = await fixture({ selectTests: true });
  unmarked.print(KNOWN);
  unmarked.store.set(unmarked.identity, historical);
  const refused = await unmarked.testRow();
  expectForgiven(refused);
  expect(refused.meta?.reused).not.toBe(true);
  expect(refused.meta?.selectionDecision).toMatchObject({ scope: "selected", reason: "diagnostic-admitted" });
  expect(unmarked.calls()).toEqual(["selected", "full"]);

  // Admission, marked: the cached full green decides scope and the battery reuses it — nothing runs.
  const admitted = await fixture({ selectTests: true });
  admitted.print(KNOWN);
  admitted.store.set(admitted.identity, marked);
  const answered = await admitted.testRow();
  expect(answered).toMatchObject({ pass: true, meta: { reused: true, selectionDecision: { scope: "full", reason: "full-green-cache" } } });
  expect(admitted.calls()).toEqual([]);

  // Merge-candidate read alone: the green is seeded after admission, when the diagnostic row is published.
  for (const [seed, full] of [[historical, ["full"]], [marked, []]] as const) {
    const candidate = await fixture({ selectTests: true });
    candidate.print(KNOWN);
    const onGate: GateContext["onGate"] = (e) => {
      if (e.phase === "end" && e.gate === "test" && e.result.meta?.fullSuite !== true) candidate.store.set(candidate.identity, seed);
    };
    const row = await candidate.testRow({ onGate });
    expect(row.meta?.selectionDecision).toMatchObject({ scope: "selected", reason: "diagnostic-admitted" });
    expect(candidate.calls()).toEqual(["selected", ...full]);
    expect(row.pass).toBe(true);
    expect(row.meta?.fullSuite).toBe(true);
    if (seed === marked) expect(row.meta?.reused).toBe(true);
    else expectForgiven(row);
  }
}, 180_000);

test("test: tip verify reads the same kill output as an infra red and refuses a seeded historical forgiven tip entry lacking the marker versus a forgiven tip result written with the marker being reused by a second tip verify of the same identity and a clean tip staying green (S19m4-F6 F7 P7 P5)", async () => {
  const { repo, ctx, calls, print } = await fixture();
  const commands = { test: COMMAND };
  // F6: a fresh tip verify over the kill output (no journal: nothing is reused or written).
  const fresh = makeTestTempDir("tickmarkr-kill-tip-");
  print(`${KNOWN}\n${KILL}`);
  for (let round = 0; round < 2; round++) {
    const [red] = await verifyIntegrationTip(repo, commands, fresh, ctx.baseline);
    expect(red).toMatchObject({ pass: false, cause: "infra", exitCode: 1 });
    expect(red!.forgiven).toBeUndefined();
    expect(red!.details.startsWith("infra;")).toBe(true);
    expect(red!.details).toContain(KILL);
  }
  expect(calls()).toEqual(["full", "full"]);

  // P5: a tip without kill text stays green, forgiven, and is stored WITH the marker.
  const journal = Journal.create(repo, "run-forgiven-kill");
  journal.append("run-start", undefined, { commands });
  print(KNOWN);
  const [clean] = await verifyIntegrationTip(repo, commands, journal.dir, ctx.baseline);
  expect(clean).toMatchObject({ pass: true, forgiven: true });
  expect(clean!.reused).toBeUndefined();
  const storeDir = join(repo, ".tickmarkr", "verdicts");
  const files = readdirSync(storeDir).filter((f) => f.startsWith("verdict-") && f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const path = join(storeDir, files[0]!);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.verdict.meta).toMatchObject({ forgiven: true, killTextRead: true });
  // P7: the second tip verify of the same identity reuses it.
  const [reused] = await verifyIntegrationTip(repo, commands, journal.dir, ctx.baseline);
  expect(reused!.pass).toBe(true);
  expect(reused!.details).toContain("reused tip verdict (identity:");
  expect(calls()).toEqual(["full", "full", "full"]);

  // F7: the same entry as an earlier engine wrote it — forgiven, no marker — at the current identity, over
  // kill output. It is never reused: the tip measures and reads infra, and the infra red is not written.
  delete stored.verdict.meta.killTextRead;
  writeFileSync(path, JSON.stringify(stored));
  print(`${KNOWN}\n${KILL}`);
  const [measured] = await verifyIntegrationTip(repo, commands, journal.dir, ctx.baseline);
  expect(measured).toMatchObject({ pass: false, cause: "infra" });
  expect(measured!.details).not.toContain("reused");
  expect(measured!.details).toContain(KILL);
  expect(isInfraResult(measured!)).toBe(true);
  expect(calls()).toEqual(["full", "full", "full", "full"]);
  expect(JSON.parse(readFileSync(path, "utf8")).verdict.meta.killTextRead).toBeUndefined();
}, 120_000);

test("test: through runGates exit 0 output naming SIGKILL in a test title stays green and a red naming a fresh failing test beside kill text stays a charged work verdict versus the forgiven kill-only output reading infra (S19m4-P1 P6 F1)", async () => {
  // P1: exit 0 is green whatever a test title says.
  const green = await fixture();
  green.print("✓ tests/sig.test.ts > survives SIGKILL", 0);
  expect(await green.testRow()).toMatchObject({ pass: true, details: "exit 0" });

  // P6: a fresh failing test beside kill text is the work's red, charged and cacheable as one.
  const charged = await fixture();
  charged.print(`${KNOWN}\nFAIL tests/fresh.test.ts > introduced by this work\n${KILL}`);
  const work = await charged.testRow();
  expect(work.pass).toBe(false);
  expect(work.details).toContain("tests/fresh.test.ts");
  expect(isInfraResult(work)).toBe(false);
  expect(work.meta?.kind).toBeUndefined();
  expect(charged.store.get(charged.identity)).toMatchObject({ pass: false });

  // F1: the same kill text beside only forgiven failures is infra.
  const killed = await fixture();
  killed.print(`${KNOWN}\n${KILL}`);
  expectKillInfra(await killed.testRow(), KILL);
}, 120_000);

test("test: through runGates a forgiven exit 1 whose only signal word sits in a script-echo line starting with a greater-than sign and a space stays forgiven for npm's leading pair and a nested script's later pair versus the same signal word on an unshaped line after the echo reading infra (OBSERVER ruling 2026-10-12: the echo is never kill text)", async () => {
  const leading = "> pkg@1.0.0 test\n> node runner.js --kill-signal=SIGKILL\n";
  const nested = "> pkg@1.0.0 test\n> npm run inner\n\n\n> pkg@1.0.0 inner\n> node runner.js --kill-signal=SIGKILL\n";
  for (const echo of [leading, nested]) {
    const { print, testRow } = await fixture();
    print(`${echo}\n${KNOWN}`);
    expectForgiven(await testRow());
  }
  const unshaped = await fixture();
  unshaped.print(`${nested}\nnode runner.js --kill-signal=SIGKILL\n${KNOWN}`);
  expectKillInfra(await unshaped.testRow(), "node runner.js --kill-signal=SIGKILL");
}, 120_000);
