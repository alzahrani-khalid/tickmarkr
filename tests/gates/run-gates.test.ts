import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { type Assignment, type BillingChannel, declaredInputBoxForWorkerName, shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { captureBaseline, type Baseline } from "../../src/gates/baseline.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import type { GateResult } from "../../src/gates/types.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { GATE_NAMES, validateGraph } from "../../src/graph/schema.js";
import {
  NUDGEABLE_ADAPTERS, resetHarvestSilentMsForTests, resetNudgeTimingForTests, runDaemon,
  setHarvestSilentMsForTests, setNudgeTimingForTests, verifyIntegrationTipCached, WORKER_NUDGE_MESSAGE,
} from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];

function fake() {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-gates-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } }));
  return new FakeAdapter(script);
}

function task(shape: "docs" | "implement", complexity = 8, files?: string[]) {
  return validateGraph({
    version: 1,
    spec: { source: "native", paths: ["spec.md"], hash: "hash" },
    tasks: [{ id: "T1", title: "gate depth", goal: "verify gates", shape, complexity, acceptance: ["passes"], ...(files ? { files } : {}) }],
  }).tasks[0];
}

// R3 (OBS-186): participation is decided by paths, so a fixture that wants a declined review has to
// COMMIT leaf-class work — the gate re-tests the declared claim against the diff and promotes when it
// escapes. `touch` names what this repo's one commit actually changes.
function repoWithCommit(touch: Record<string, string> = { "a.txt": "after\n" }) {
  const repo = makeRepo({ "a.txt": "before\n" });
  const baseRef = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  for (const [rel, body] of Object.entries(touch)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  execSync("git add -A && git commit --no-gpg-sign -m work", { cwd: repo });
  return { repo, baseRef };
}

async function gatesFor(t: ReturnType<typeof task>, cfg: typeof DEFAULT_CONFIG, adapter: FakeAdapter, pipeline?: "v185", touch?: Record<string, string>) {
  const { repo, baseRef } = repoWithCommit(touch);
  return runGates(t, {
    worktree: repo,
    baseRef,
    author,
    result: { ok: true, summary: "", deviations: [], raw: "" },
    commands: {},
    baseline: await captureBaseline(repo, {}),
    channels,
    adapters: [adapter],
    cfg,
    ...(pipeline ? { pipeline } : {}),
  });
}

describe("per-shape gate participation", () => {
  test("docs can skip acceptance while other shapes still run it", async () => {
    const adapter = fake();
    const cfg = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & { gates: { byShape?: Record<string, { acceptance?: boolean }> } };
    cfg.judge.adapter = "fake";
    cfg.gates.byShape = { docs: { acceptance: false } };

    // build/test/lint have no detected command here (commands: {}) — they surface as explicit skips
    const docs = await gatesFor(task("docs", 3, ["docs/**"]), cfg, adapter, undefined, { "docs/guide.md": "# guide\n" });
    expect(docs.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "review"]);
    expect(docs.results.slice(0, 3).every((r) => r.pass && r.meta?.skipped === true)).toBe(true);
    // R3 (OBS-186): the review declines on PATHS — every declared path and every path this diff
    // touched is leaf-class — and the decline is honest: policy id, reason, and never pass:true.
    // (The retired assertion pinned `complexity 3 < threshold 7`, a string nothing can produce now.)
    expect(docs.results.at(-1)?.meta).toMatchObject({ skipped: true, verdict: "skipped", policy: "judge-only" });
    expect(docs.results.at(-1)?.pass).not.toBe(true);
    expect(docs.results.at(-1)?.details).toContain("docs/guide.md");

    const implement = await gatesFor(task("implement"), cfg, adapter);
    expect(implement.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
  });

  // T4 (OBS-265): the reordered pipeline changed WHEN gates run, not WHICH ones do. Same fixtures,
  // same participation, same canonical record — the evidence array is order-stable across pipelines.
  test("the v1.85 pipeline keeps per-shape participation and the canonical result order", async () => {
    const adapter = fake();
    const cfg = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & { gates: { byShape?: Record<string, { acceptance?: boolean }> } };
    cfg.judge.adapter = "fake";
    cfg.gates.byShape = { docs: { acceptance: false } };

    const docs = await gatesFor(task("docs", 3), cfg, adapter, "v185");
    expect(docs.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "review"]);
    expect(docs.results.slice(0, 3).every((r) => r.pass && r.meta?.skipped === true)).toBe(true);

    const implement = await gatesFor(task("implement"), cfg, adapter, "v185");
    expect(implement.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
    expect(implement.results.every((r) => r.pass)).toBe(true);
  });

  test("no byShape keeps acceptance and decides review on the paths the task declares and touches", async () => {
    const adapter = fake();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";

    // Same shape, same complexity, two declarations: participation follows the PATHS, not the shape
    // and not the number (the assertion this replaces read `complexity 3 < threshold 7` — a switch
    // that made review unreachable while `required: true` claimed the opposite, OBS-186).
    const leaf = await gatesFor(task("docs", 3, ["docs/**"]), cfg, adapter, undefined, { "docs/guide.md": "# guide\n" });
    expect(leaf.results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);
    expect(leaf.results.at(-1)?.meta).toMatchObject({ verdict: "skipped", policy: "judge-only" });

    const source = await gatesFor(task("docs", 3, ["src/run/daemon.ts"]), cfg, adapter, undefined, { "src/run/daemon.ts": "export const x = 1;\n" });
    expect(source.results.at(-1)?.meta).toMatchObject({ policy: "full", reviewer: "fake:fake-2" });
    expect(source.results.at(-1)?.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// T4 (OBS-265/266): the round's MECHANICS — when each gate runs, what a round may skip, and what a
// run-end may not re-pay. Every verdict below keeps the meaning it had before: the fixtures assert
// ordering, concurrency and command arguments, never a changed pass/fail rule.
// ---------------------------------------------------------------------------------------------

const DETERMINISTIC = ["build", "test", "lint", "evidence", "scope"];

function mkTask(over: Record<string, unknown> = {}) {
  return validateGraph({
    version: 1,
    spec: { source: "native", paths: ["spec.md"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], ...over }],
  }).tasks[0];
}

function fakeWith(extra: object): { adapter: FakeAdapter; scriptPath: string } {
  const scriptPath = join(makeTestTempDir("tickmarkr-pipeline-"), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {}, ...extra }));
  return { adapter: new FakeAdapter(scriptPath), scriptPath };
}

const git = (repo: string, cmd: string) => execSync(`git ${cmd}`, { cwd: repo, encoding: "utf8" });
const commitAll = (repo: string, msg: string) => git(repo, `add -A && git commit --no-gpg-sign -m ${msg}`);

async function gates(
  taskOver: Record<string, unknown>,
  repo: string,
  baseRef: string,
  commands: Record<string, string>,
  opts: { selectTests?: boolean; adapters?: FakeAdapter[]; onGate?: (e: GateEvent) => void | Promise<void>; armAfterBaseline?: () => void } = {},
): Promise<{ results: GateResult[] }> {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  const baseline = await captureBaseline(repo, commands);
  opts.armAfterBaseline?.(); // the baseline is the PRE-work state: a failure armed after it is a new one
  return runGates(mkTask(taskOver), {
    worktree: repo, baseRef, author,
    result: { ok: true, summary: "", deviations: [], raw: "" },
    commands, baseline, channels,
    adapters: opts.adapters ?? [fakeWith({}).adapter],
    cfg, pipeline: "v185", selectTests: opts.selectTests,
    onGate: opts.onGate,
  });
}

describe("T4 — the deterministic gates run before the battery (OBS-265)", () => {
  test("a scope failure is journaled before any battery command has run", async () => {
    // The battery commands are witnesses: each appends its own name to a log the moment it runs.
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n", "README.md": "r\n", "witness.sh": "echo \"$1\" >> battery.log\n" });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "README.md"), "drive-by edit outside src/**\n");
    commitAll(repo, "drive-by");
    const commands = { build: "sh witness.sh build", test: "sh witness.sh test", lint: "sh witness.sh lint" };
    const log = join(repo, "battery.log");

    // the baseline capture legitimately runs all three — the round under test starts from a clean slate
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const baseline = await captureBaseline(repo, commands);
    rmSync(log, { force: true });

    const journaled: string[] = [];
    const batteryAtScopeVerdict: boolean[] = [];
    const { results } = await runGates(mkTask({ gates: DETERMINISTIC, files: ["src/**"] }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels, adapters: [fakeWith({}).adapter], cfg,
      pipeline: "v185",
      onGate: (e) => {
        if (e.phase !== "end") return;
        journaled.push(`${e.gate}:${e.result.pass ? "pass" : "fail"}`);
        if (e.gate === "scope") batteryAtScopeVerdict.push(existsSync(log)); // read AT the verdict, not after
      },
    });

    expect(journaled).toEqual(["evidence:pass", "scope:fail"]);
    expect(batteryAtScopeVerdict).toEqual([false]); // no battery command had run when the scope red was journaled
    expect(existsSync(log)).toBe(false); // and the round ended without ever paying for one
    expect(results.find((r) => r.gate === "scope")?.pass).toBe(false);
    expect(results.some((r) => r.gate === "build" || r.gate === "test" || r.gate === "lint")).toBe(false);
  });

  // The other half of the screen: it is a screen, not a reordering. A green one must leave the round
  // exactly as it found it — one journaled verdict per gate, in GATE_NAMES order, and one battery.
  test("a green screen journals each gate once, in canonical order, and buys the battery once", async () => {
    const repo = makeRepo({
      "src/a.ts": "export const a = 1;\n",
      "witness.sh": "echo \"$1\" >> battery.log\n",
      // v1.87 T5: the witness's own log is a build artifact — declared as one, or the battery is
      // (correctly) refused for leaving uncommitted work behind.
      ".gitignore": "battery.log\n",
    });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commitAll(repo, "in-scope-work");
    const commands = { build: "sh witness.sh build", test: "sh witness.sh test", lint: "sh witness.sh lint" };

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const baseline = await captureBaseline(repo, commands);
    rmSync(join(repo, "battery.log"), { force: true });

    const stream: string[] = [];
    const { results } = await runGates(mkTask({ gates: DETERMINISTIC, files: ["src/**"] }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels, adapters: [fakeWith({}).adapter], cfg, pipeline: "v185",
      onGate: (e) => stream.push(`${e.gate}:${e.phase}`),
    });

    expect(results.every((r) => r.pass)).toBe(true);
    expect(stream).toEqual(DETERMINISTIC.flatMap((g) => [`${g}:start`, `${g}:end`]));
    expect(readFileSync(join(repo, "battery.log"), "utf8").trim().split("\n")).toEqual(["build", "test", "lint"]);
  });

  test("the battery stops at its first failing command instead of buying the rest", async () => {
    const repo = makeRepo({ "a.txt": "x\n", "witness.sh": "echo \"$1\" >> battery.log\n; exit 0\n" });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "a.txt"), "y\n");
    commitAll(repo, "work");
    const commands = { build: "sh -c 'echo build >> battery.log; exit 1'", test: "sh -c 'echo test >> battery.log'", lint: "sh -c 'echo lint >> battery.log'" };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const baseline = await captureBaseline(repo, { ...commands, build: "sh -c 'exit 0'" }); // green build at baseline
    rmSync(join(repo, "battery.log"), { force: true });

    const { results } = await runGates(mkTask({ gates: DETERMINISTIC, files: ["**"] }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels, adapters: [fakeWith({}).adapter], cfg, pipeline: "v185",
    });
    expect(results.find((r) => r.gate === "build")?.pass).toBe(false);
    expect(readFileSync(join(repo, "battery.log"), "utf8").trim().split("\n")).toEqual(["build"]);
    expect(results.some((r) => r.gate === "lint")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// v1.87 T5: the shell gates command the WORKING TREE while evidence, scope and the merge read
// COMMITS. One fixture, one bit different: the battery is a witness — each command appends its own
// name the moment it runs — so "no command ran" is proven by the absence of the log rather than by
// a claim about ordering, and the same fixture with a clean tree runs all three.
// ---------------------------------------------------------------------------------------------
let t5RepoTemplate: string | undefined;

function makeT5Repo(): string {
  t5RepoTemplate ??= makeRepo({
    "src/a.ts": "export const a = 1;\n",
    "tracked.txt": "before\n",
    "README.md": "r\n",
    "witness.sh": "echo \"$1\" >> battery.log\n",
    ".gitignore": "battery.log\n",
  });
  const repo = makeTestTempDir("tickmarkr-t5-repo-");
  cpSync(t5RepoTemplate, repo, { recursive: true });
  return repo;
}

async function witnessRound(uncommitted: Record<string, string>): Promise<{
  results: GateResult[];
  journaled: string[];
  stream: string[];
  battery: string[];
}> {
  const repo = makeT5Repo();
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  commitAll(repo, "committed-work");
  const commands = { build: "sh witness.sh build", test: "sh witness.sh test", lint: "sh witness.sh lint" };
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  const baseline = greenBaseline(commands);
  const log = join(repo, "battery.log");
  rmSync(log, { force: true }); // …the round under test starts from a clean witness

  for (const [rel, body] of Object.entries(uncommitted)) writeFileSync(join(repo, rel), body);

  const journaled: string[] = [];
  const stream: string[] = [];
  const { results } = await runGates(mkTask({ gates: DETERMINISTIC, files: ["**"] }), {
    worktree: repo, baseRef, author,
    result: { ok: true, summary: "", deviations: [], raw: "" },
    commands, baseline, channels, adapters: [fakeWith({}).adapter], cfg, pipeline: "v185",
    onGate: (e) => {
      stream.push(`${e.gate}:${e.phase}`);
      if (e.phase === "end") journaled.push(`${e.gate}:${e.result.pass ? "pass" : "fail"}`);
    },
  });
  return {
    results,
    journaled,
    stream,
    battery: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

// These fixtures exercise the gate run, not baseline capture. A known-green baseline is sufficient
// and avoids nine redundant shell processes contending with the suite's CPU-heavy rendering tests.
function greenBaseline(commands: Record<string, string>): Baseline {
  return {
    commands: Object.fromEntries(Object.keys(commands).map((name) => [
      name,
      { exitCode: 0, fingerprints: [] },
    ])),
  };
}

describe("v1.87 T5 — a dirty worktree is not gatable (the runtime refuses what it cannot judge)", () => {
  test("test: a worktree carrying uncommitted changes is refused before any shell gate command runs, and the refusal is recorded as a gate failure naming the dirty tree", async () => {
    const { results, journaled, battery } = await witnessRound({
      "src/a.ts": "export const a = 3; // edited, never committed\n", // tracked, modified
      "src/stray.ts": "export const stray = true;\n", // untracked, and just as gate-visible
    });

    expect(battery).toEqual([]); // not one shell gate command ran
    const refusal = results.find((r) => r.gate === "build")!;
    expect(refusal.pass).toBe(false);
    expect(refusal.meta?.dirtyWorktree).toBe(true);
    // the refusal NAMES the dirty tree — both shapes of uncommitted work, in git's own porcelain
    expect(refusal.details).toMatch(/refusing to gate a dirty worktree/);
    expect(refusal.details).toMatch(/^\s*M\s+src\/a\.ts$/m);
    expect(refusal.details).toMatch(/^\?\?\s+src\/stray\.ts$/m);
    // and it is the round's verdict: journaled as a gate failure, nothing after it, no merge
    expect(journaled).toEqual(["build:fail"]);
    expect(results.map((r) => r.gate)).toEqual(["build"]);
    expect(results.every((r) => r.pass)).toBe(false);
  }, 30_000);

  test("test: a clean worktree runs the shell gates unchanged, proving the refusal is scoped to the dirty case and not a blanket block", async () => {
    const { results, journaled, stream, battery } = await witnessRound({}); // the same fixture, committed

    expect(battery).toEqual(["build", "test", "lint"]); // every command really ran, in order
    expect(journaled).toEqual(DETERMINISTIC.map((g) => `${g}:pass`));
    expect(stream).toEqual(DETERMINISTIC.flatMap((g) => [`${g}:start`, `${g}:end`]));
    expect(results.map((r) => r.gate)).toEqual(DETERMINISTIC);
    expect(results.every((r) => r.pass)).toBe(true);
    expect(results.some((r) => r.meta?.dirtyWorktree === true)).toBe(false);
  }, 30_000);

  // The other half of the refusal, and the one a once-before-the-battery check cannot make: the tree
  // is clean when the battery starts and a green command dirties it. Everything after that command —
  // the next shell gate especially — would be judging bytes HEAD does not hold.
  test("a shell gate command that leaves the tree dirty fails at THAT gate, before the next command runs", async () => {
    const repo = makeT5Repo();
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commitAll(repo, "committed-work");
    const witness = { build: "sh witness.sh build", test: "sh witness.sh test", lint: "sh witness.sh lint" };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const baseline = greenBaseline(witness); // clean commands: the tree is clean at round start
    const log = join(repo, "battery.log");
    rmSync(log, { force: true });

    // build exits 0 AND rewrites a tracked file — the shortcut every "it passed" claim rests on
    const commands = { ...witness, build: `${witness.build}; echo 'export const a = 99;' > src/a.ts` };
    const journaled: string[] = [];
    const { results } = await runGates(mkTask({ gates: DETERMINISTIC, files: ["**"] }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels, adapters: [fakeWith({}).adapter], cfg, pipeline: "v185",
      onGate: (e) => { if (e.phase === "end") journaled.push(`${e.gate}:${e.result.pass ? "pass" : "fail"}`); },
    });

    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["build"]); // test and lint never ran
    const refusal = results.find((r) => r.gate === "build")!;
    expect(refusal.pass).toBe(false);
    expect(refusal.meta).toMatchObject({ dirtyWorktree: true, dirtiedBy: "build" });
    expect(refusal.details).toMatch(/refusing to gate a dirty worktree/);
    expect(refusal.details).toMatch(/^\s*M\s+src\/a\.ts$/m);
    // the round is the refusal: no later gate judged the tree the build command left behind
    expect(journaled).toEqual(["build:fail"]);
    expect(results.map((r) => r.gate)).toEqual(["build"]);
  }, 30_000);

  // The hole a battery-scoped check leaves, reproduced: a task with NO build/test/lint command
  // configured skips the battery entirely — but the acceptance gate still runs command and named-test
  // oracles in this worktree (acceptance.ts:264,275). Guarded only around the tool commands, a dirty
  // tree bought every one of the seven gates and merged a commit whose oracle judged uncommitted state.
  test("a dirty tree with NO tool command configured is still refused, before an acceptance oracle can run", async () => {
    const repo = makeT5Repo();
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    commitAll(repo, "committed-work");
    writeFileSync(join(repo, "tracked.txt"), "after — and never committed\n"); // the dirt

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    // the oracle is the witness: if it runs at all it leaves its own file behind
    const acceptance = [{ oracle: "command", command: "echo ran > oracle-ran.log" }];
    const fake = fakeWith({ review: { approve: true, issues: [] } }).adapter;
    const journaled: string[] = [];
    const { results } = await runGates(mkTask({ gates: [...GATE_NAMES], files: ["**"], acceptance }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: {}, baseline: await captureBaseline(repo, {}),
      channels, adapters: [fake], cfg, pipeline: "v185",
      onGate: (e) => { if (e.phase === "end") journaled.push(`${e.gate}:${e.result.pass ? "pass" : "fail"}`); },
    });

    expect(existsSync(join(repo, "oracle-ran.log"))).toBe(false); // not one shell gate command ran
    const refusal = results.find((r) => r.gate === "build")!;
    expect(refusal.pass).toBe(false);
    expect(refusal.meta?.dirtyWorktree).toBe(true);
    expect(refusal.details).toMatch(/refusing to gate a dirty worktree/);
    expect(refusal.details).toMatch(/^\s*M\s+tracked\.txt$/m);
    // the round IS the refusal — no gate was satisfied, so nothing here is mergeable
    expect(journaled).toEqual(["build:fail"]);
    expect(results.map((r) => r.gate)).toEqual(["build"]);
    expect(results.every((r) => r.pass)).toBe(false);
    expect(git(repo, "status --porcelain").trim()).toBe("M tracked.txt"); // and the round changed nothing
  }, 30_000);

  // The other end of the same rule: clean when the round starts, dirty when it ends. An oracle that
  // exits 0 having written into the worktree is caught by no check that runs before it, so the last
  // word on cleanliness is the round's last act — the green is withdrawn rather than merged.
  test("a merge-satisfied round that ends dirty is withdrawn on its last gate, not merged", async () => {
    const repo = makeT5Repo();
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "CHANGELOG.md"), "leaf-class work\n");
    commitAll(repo, "committed-leaf-work"); // clean at round entry

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const acceptance = [{ oracle: "command", command: "echo ran > oracle-ran.log" }]; // exit 0, and it writes
    const fake = fakeWith({ review: { approve: true, issues: [] } }).adapter;
    const journaled: string[] = [];
    const ended: GateResult[] = [];
    const { results } = await runGates(mkTask({ gates: [...GATE_NAMES], files: ["CHANGELOG.md"], acceptance }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: {}, baseline: await captureBaseline(repo, {}),
      channels, adapters: [fake], cfg, pipeline: "v185",
      onGate: (e) => {
        if (e.phase !== "end") return;
        journaled.push(`${e.gate}:${e.result.pass ? "pass" : "fail"}`);
        ended.push(e.result);
      },
    });

    expect(existsSync(join(repo, "oracle-ran.log"))).toBe(true); // the oracle really ran, and really dirtied
    expect(results.find((r) => r.gate === "acceptance")?.pass).toBe(true); // the judge said yes…
    const reviewEvents = ended.filter((r) => r.gate === "review");
    // …and the leaf-only review declined. That is still merge-satisfied (`gateSatisfied`), so a dirty
    // round must retract it exactly as it retracts a conventional pass.
    expect(reviewEvents[0]?.pass).toBe(false);
    expect(reviewEvents[0]?.meta).toMatchObject({ skipped: true, policy: "judge-only" });
    const withdrawn = results.at(-1)!;
    expect(withdrawn.gate).toBe("review");
    expect(withdrawn.pass).toBe(false); // …and the round still cannot merge
    expect(withdrawn.meta).toMatchObject({ dirtyWorktree: true, dirtyAtRoundEnd: true });
    expect(withdrawn.details).toMatch(/refusing to gate a dirty worktree/);
    expect(withdrawn.details).toMatch(/^\?\?\s+oracle-ran\.log$/m);
    expect(results.every((r) => r.pass || r.meta?.skipped === true)).toBe(false);
    // the withdrawal is journaled too: the satisfied result is on the record, and so is its retraction
    expect(journaled.at(-1)).toBe("review:fail");
    expect(reviewEvents[1]?.meta).toMatchObject({ dirtyWorktree: true, dirtyAtRoundEnd: true });
    expect(journaled.filter((j) => j.startsWith("review:"))).toEqual(["review:fail", "review:fail"]);
  }, 30_000);
});

// The allowlist is bound when the round starts — not re-read per gate. `ctx.cfg` is the daemon's live
// object; a round that re-read it could judge one attempt's diff against two different policies.
describe("v1.87 T5 — scope.allowDeviations is bound for the round", () => {
  test("widening cfg.scope.allowDeviations mid-round cannot reach the scope gate", async () => {
    const repo = makeT5Repo();
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "README.md"), "drive-by edit outside src/**\n");
    commitAll(repo, "out-of-scope");

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    cfg.scope = { allowDeviations: [] };
    const widenedAt: string[] = [];
    // no battery commands, so the gates walk their canonical order: the widening lands between the
    // first journaled gate and the scope gate it is trying to buy off.
    const { results } = await runGates(mkTask({ gates: DETERMINISTIC, files: ["src/**"] }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: {}, baseline: await captureBaseline(repo, {}),
      channels, adapters: [fakeWith({}).adapter], cfg, pipeline: "v185",
      onGate: (e) => {
        if (e.phase !== "end" || e.gate !== "build") return;
        cfg.scope!.allowDeviations!.push("**"); // the operator's live config, widened mid-round
        widenedAt.push(e.gate);
      },
    });

    expect(widenedAt).toEqual(["build"]); // the widening really happened, and before scope ran
    expect(cfg.scope.allowDeviations).toEqual(["**"]);
    const scope = results.find((r) => r.gate === "scope")!;
    expect(scope.pass).toBe(false); // …and the gate judged against the list the round started with
    expect(scope.details).toContain("README.md");
  }, 30_000);
});

// A judge and a reviewer that BLOCK on each other: the judge announces itself and waits for the
// reviewer to be ready, the reviewer waits for that announcement. Serialized, one of them waits out
// its bounded loop and drops a timeout marker — which is exactly what the assertion reads.
class RendezvousFake extends FakeAdapter {
  constructor(scriptPath: string, private readonly sync: string) {
    super(scriptPath);
  }

  override headlessCommand(promptFile: string, model: string): string {
    const inner = super.headlessCommand(promptFile, model);
    const isJudge = /TICKMARKR-(?:JUDGE|SCOPE)/.test(readFileSync(promptFile, "utf8"));
    const pre = join(this.sync, isJudge ? "judge-pre.sh" : "review-pre.sh");
    return `bash ${pre}; ${inner}`;
  }
}

// A reviewer that takes its time, and says so: the marker appears only once the review command has
// actually finished. The judge side is untouched, so a round that records each verdict on its own
// gate's fulfillment journals the judge's while this one is still running — and a round that awaits
// both before recording either cannot.
class SlowReviewFake extends FakeAdapter {
  constructor(scriptPath: string, private readonly sync: string) {
    super(scriptPath);
  }

  override headlessCommand(promptFile: string, model: string): string {
    const inner = super.headlessCommand(promptFile, model);
    if (/TICKMARKR-(?:JUDGE|SCOPE)/.test(readFileSync(promptFile, "utf8"))) return inner;
    return `sleep 1; ${inner}; touch ${join(this.sync, "review-done")}`;
  }
}

// The inverse witness: review is fast while the judge stays in flight. This is the direction a
// canonical acceptance-first await hides — a completed review must be journalable before the judge
// finishes, just as a completed judge already is before a slow review finishes.
class SlowJudgeFake extends FakeAdapter {
  constructor(scriptPath: string, private readonly sync: string) {
    super(scriptPath);
  }

  override headlessCommand(promptFile: string, model: string): string {
    const inner = super.headlessCommand(promptFile, model);
    if (!/TICKMARKR-(?:JUDGE|SCOPE)/.test(readFileSync(promptFile, "utf8"))) return inner;
    return `sleep 1; ${inner}; touch ${join(this.sync, "judge-done")}`;
  }
}

function slowReview(): { adapter: SlowReviewFake; sync: string } {
  const sync = makeTestTempDir("tickmarkr-slow-review-");
  const { scriptPath } = fakeWith({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
  });
  return { adapter: new SlowReviewFake(scriptPath, sync), sync };
}

function slowJudge(): { adapter: SlowJudgeFake; sync: string } {
  const sync = makeTestTempDir("tickmarkr-slow-judge-");
  const { scriptPath } = fakeWith({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
  });
  return { adapter: new SlowJudgeFake(scriptPath, sync), sync };
}

function rendezvous(): { adapter: RendezvousFake; sync: string } {
  const sync = makeTestTempDir("tickmarkr-rendezvous-");
  const waitFor = (flag: string, timeout: string) =>
    `for i in $(seq 1 150); do [ -f ${join(sync, flag)} ] && break; sleep 0.02; done\n` +
    `[ -f ${join(sync, flag)} ] || touch ${join(sync, timeout)}\n`;
  writeFileSync(join(sync, "judge-pre.sh"), `touch ${join(sync, "judge-started")}\n${waitFor("review-ready", "judge-waited-out")}`);
  writeFileSync(join(sync, "review-pre.sh"), `${waitFor("judge-started", "review-waited-out")}touch ${join(sync, "review-ready")}\n`);
  const { scriptPath } = fakeWith({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
  });
  return { adapter: new RendezvousFake(scriptPath, sync), sync };
}

describe("T4 — judge and review are one round, not two (OBS-265)", () => {
  test("judge and review phase-starts for one round carry the same parent timestamp and neither result waits on the other", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "a.txt"), "y\n");
    commitAll(repo, "work");
    const { adapter, sync } = rendezvous();
    const starts: GateEvent[] = [];
    const { results } = await gates(
      { files: ["**"] },
      repo, baseRef, {},
      { adapters: [adapter], onGate: (e) => { if (e.phase === "start") starts.push(e); } },
    );

    const judgeStart = starts.find((e) => e.phase === "start" && e.gate === "acceptance");
    const reviewStart = starts.find((e) => e.phase === "start" && e.gate === "review");
    expect(judgeStart).toBeDefined();
    expect(reviewStart).toBeDefined();
    // one round, one parent: the two verdict gates were launched together, and a surface can say so
    expect((judgeStart as { parentAt?: number }).parentAt).toBeTypeOf("number");
    expect((judgeStart as { parentAt?: number }).parentAt).toBe((reviewStart as { parentAt?: number }).parentAt);
    // the deterministic gates before them are the sequence — they carry no parent
    expect(starts.filter((e) => e.phase === "start" && e.gate === "evidence")[0]).not.toHaveProperty("parentAt");

    // the rendezvous: each verdict completed while the other was in flight. Serialized, the first one
    // dispatched would have waited out its loop and left a marker behind.
    expect(existsSync(join(sync, "judge-started"))).toBe(true); // the rendezvous really ran on both sides
    expect(existsSync(join(sync, "review-ready"))).toBe(true);
    expect(existsSync(join(sync, "judge-waited-out"))).toBe(false);
    expect(existsSync(join(sync, "review-waited-out"))).toBe(false);
    expect(results.find((r) => r.gate === "acceptance")?.pass).toBe(true);
    expect(results.find((r) => r.gate === "review")?.pass).toBe(true);
    // enforcement is unchanged: the returned record is still every gate, in canonical order
    expect(results.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence", "scope", "acceptance", "review"]);

    // "neither result waits on the other" is about the VERDICTS, not just the dispatches: each gate's
    // result is recorded the moment ITS gate answers. With a deliberately slow reviewer, the judge's
    // end event is emitted while the review command is still running — awaiting both before recording
    // either would make the judge's verdict land only after the reviewer's marker exists.
    const slow = slowReview();
    const ends: Array<{ gate: string; reviewFinished: boolean }> = [];
    await gates(
      { files: ["**"] },
      repo, baseRef, {},
      {
        adapters: [slow.adapter],
        onGate: (e) => { if (e.phase === "end") ends.push({ gate: e.gate, reviewFinished: existsSync(join(slow.sync, "review-done")) }); },
      },
    );
    expect(ends.find((e) => e.gate === "acceptance")).toEqual({ gate: "acceptance", reviewFinished: false });
    expect(ends.findIndex((e) => e.gate === "acceptance")).toBeLessThan(ends.findIndex((e) => e.gate === "review"));
    expect(existsSync(join(slow.sync, "review-done"))).toBe(true); // the slow reviewer really did run

    // And the inverse direction: a fast review publishes while the judge is still in flight. This
    // catches an acceptance-first await, which passes the slow-review half above while withholding
    // the already-complete review result until the judge finishes.
    const inverse = slowJudge();
    const inverseEnds: Array<{ gate: string; judgeFinished: boolean }> = [];
    await gates(
      { files: ["**"] },
      repo, baseRef, {},
      {
        adapters: [inverse.adapter],
        onGate: (e) => { if (e.phase === "end") inverseEnds.push({ gate: e.gate, judgeFinished: existsSync(join(inverse.sync, "judge-done")) }); },
      },
    );
    expect(inverseEnds.find((e) => e.gate === "review")).toEqual({ gate: "review", judgeFinished: false });
    expect(inverseEnds.findIndex((e) => e.gate === "review")).toBeLessThan(inverseEnds.findIndex((e) => e.gate === "acceptance"));
    expect(existsSync(join(inverse.sync, "judge-done"))).toBe(true); // the slow judge really did run

    // the falsifier: the SAME fixture on the serial walk. The judge is dispatched first, waits out its
    // bounded loop for a reviewer that cannot start yet, and leaves the marker the assertion above forbids.
    const serial = rendezvous();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    await runGates(mkTask({ files: ["**"] }), {
      worktree: repo, baseRef, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: {}, baseline: await captureBaseline(repo, {}), channels, adapters: [serial.adapter], cfg,
      pipeline: "legacy",
    });
    expect(existsSync(join(serial.sync, "judge-waited-out"))).toBe(true);
  }, 30_000);

  test("a failing judge no longer suppresses the review verdict — enforcement is the AND of both", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "a.txt"), "y\n");
    commitAll(repo, "work");
    const { adapter } = fakeWith({
      judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "nope" }] },
      review: { approve: true, issues: [] },
    });
    const { results } = await gates({ files: ["**"] }, repo, baseRef, {}, { adapters: [adapter] });
    expect(results.find((r) => r.gate === "acceptance")?.pass).toBe(false);
    expect(results.find((r) => r.gate === "review")?.pass).toBe(true); // ran anyway, read nothing from the judge
    expect(results.every((r) => r.pass)).toBe(false); // and the AND still refuses the round
  }, 30_000);

  // The round that launches judge and review together interleaves their command BUILDS, and the fake
  // adapter's three role scratch files are shared per script path. A build that writes a role it is
  // not can therefore land between a sibling's build and that sibling's `cat`. This is the falsifier
  // for that: the interleaving is forced rather than raced, so it fails on an adapter that writes all
  // three files and passes on one that writes only the role its prompt is.
  test("a concurrently-built review command cannot clobber the verdict a judge command was built to serve", async () => {
    const { adapter, scriptPath } = fakeWith({
      judge: [
        "judge output garbage — not a verdict",
        { pass: true, criteria: [{ criterion: "c1", met: true, reason: "good" }] },
      ],
      review: { approve: true, issues: [] },
    });
    const dir = join(scriptPath, "..");
    const judgePrompt = join(dir, "jp.txt");
    const reviewPrompt = join(dir, "rp.txt");
    writeFileSync(judgePrompt, "TICKMARKR-JUDGE\n");
    writeFileSync(reviewPrompt, "TICKMARKR-REVIEW\n");

    const first = adapter.headlessCommand(judgePrompt, "fake-1");
    const reviewCmd = adapter.headlessCommand(reviewPrompt, "fake-1"); // the concurrent sibling's build
    // the judge reads what ITS build served — the first array element, not the whole array
    expect(JSON.parse(execSync(first, { encoding: "utf8" }))).toBe("judge output garbage — not a verdict");
    // and the sibling build did not consume a judge verdict either: the next judge gets element two
    const second = adapter.headlessCommand(judgePrompt, "fake-1");
    expect(JSON.parse(execSync(second, { encoding: "utf8" })).pass).toBe(true);
    expect(JSON.parse(execSync(reviewCmd, { encoding: "utf8" })).approve).toBe(true);

    // and end to end: garbage-then-good survives a real round where review is dispatched alongside it
    const repo = makeRepo({ "a.txt": "x\n" });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "a.txt"), "y\n");
    commitAll(repo, "work");
    const { adapter: round } = fakeWith({
      judge: [
        "judge output garbage — not a verdict",
        { pass: true, criteria: [{ criterion: "c1", met: true, reason: "good" }] },
      ],
      review: { approve: true, issues: [] },
    });
    const { results } = await gates({ files: ["**"] }, repo, baseRef, {}, { adapters: [round] });
    expect(results.find((r) => r.gate === "acceptance")?.pass).toBe(true); // the retry served element two
    expect(results.find((r) => r.gate === "review")?.pass).toBe(true);
  }, 30_000);
});

// The corpus repo: one shape per way a diff can point at (or fail to point at) a test.
//   tests/a.test.ts -> src/a.ts -> src/deep.ts        (mirror, then transitive)
//   tests/b.test.ts -> src/old.ts                     (the file the rename moves)
//   src/orphan.ts                                     (nothing imports it)
function corpusRepo(): { repo: string; baseRef: Promise<string> } {
  const repo = makeRepo({
    "src/a.ts": "import { deep } from \"./deep.js\";\nexport const a = () => deep();\n",
    "src/deep.ts": "export const deep = () => 1;\n",
    "src/old.ts": "export const old = () => 2;\n",
    "src/orphan.ts": "export const orphan = () => 3;\n",
    "tests/a.test.ts": "import { a } from \"../src/a.js\";\na();\n",
    "tests/b.test.ts": "import { old } from \"../src/old.js\";\nold();\n",
    "run.sh": "echo \"$*\" >> argv.log\nexit 0\n",
    // v1.87 T5: the runner's own scratch is a build artifact, declared as one. Left undeclared it is
    // uncommitted work by every reading git offers, and the battery now refuses to gate such a tree.
    ".gitignore": "argv.log\nmiss.flag\n",
  });
  return { repo, baseRef: gitHead(repo) };
}

const argvLines = (repo: string) => readFileSync(join(repo, "argv.log"), "utf8").split("\n").slice(0, -1);

describe("T4 — selection is a round's economy, never a merge's licence (OBS-265)", () => {
  test("a selected-test round that passes still forces the full suite on the merge-candidate round, and a selection miss costs one round, never a merge, proven across a diff-shape corpus of >=5 members — a source file with a direct test mirror, a file reached only by transitive import, a test file itself, a file with no covering tests, and a renamed or deleted file", async () => {
    const corpus: Array<{ shape: string; mutate: (repo: string) => void; selected?: string[] }> = [
      {
        shape: "a source file with a direct test mirror",
        mutate: (r) => writeFileSync(join(r, "src/a.ts"), "import { deep } from \"./deep.js\";\nexport const a = () => deep() + 1;\n"),
        selected: ["tests/a.test.ts"],
      },
      {
        shape: "a file reached only by transitive import",
        mutate: (r) => writeFileSync(join(r, "src/deep.ts"), "export const deep = () => 11;\n"),
        selected: ["tests/a.test.ts"], // no test imports src/deep.ts directly — only through src/a.ts
      },
      {
        shape: "a test file itself",
        mutate: (r) => writeFileSync(join(r, "tests/b.test.ts"), "import { old } from \"../src/old.js\";\nold();\nold();\n"),
        selected: ["tests/b.test.ts"],
      },
      {
        shape: "a file with no covering tests",
        mutate: (r) => writeFileSync(join(r, "src/orphan.ts"), "export const orphan = () => 33;\n"),
        selected: undefined, // nothing covers it, so nothing but the whole suite can speak for it
      },
      {
        shape: "a renamed or deleted file",
        mutate: (r) => git(r, "mv src/old.ts src/renamed.ts"),
        selected: undefined, // the old path's coverage is gone — unattributable
      },
    ];
    expect(corpus).toHaveLength(5);

    for (const member of corpus) {
      const { repo, baseRef } = corpusRepo();
      const base = await baseRef;
      member.mutate(repo);
      commitAll(repo, "work");
      const ends: GateEvent[] = [];
      const { results } = await gates(
        { gates: DETERMINISTIC, files: ["**"] }, repo, base, { test: "sh run.sh" },
        { selectTests: true, onGate: (e) => { if (e.phase === "end") ends.push(e); } },
      );
      const testGate = results.find((r) => r.gate === "test")!;
      const runs = argvLines(repo).slice(1); // line 0 is gates()' own baseline capture
      // ONE test verdict per round, however many suites the round had to run to reach it: the selected
      // run is a screen the full suite supersedes, never a second indistinguishable `test` gate-result.
      const testEnds = ends.filter((e) => e.gate === "test");
      expect({ shape: member.shape, verdicts: testEnds.length }).toEqual({ shape: member.shape, verdicts: 1 });
      expect({ shape: member.shape, verdict: testEnds[0]!.phase === "end" && testEnds[0]!.result }).toEqual({ shape: member.shape, verdict: testGate });

      if (member.selected) {
        expect({ shape: member.shape, selected: testGate.meta?.selectedTests }).toEqual({ shape: member.shape, selected: member.selected });
        // the round ran the subset FIRST, then the full suite on the same commit before reporting green
        expect({ shape: member.shape, runs }).toEqual({ shape: member.shape, runs: [member.selected.join(" "), ""] });
        expect({ shape: member.shape, full: testGate.meta?.fullSuite }).toEqual({ shape: member.shape, full: true });
      } else {
        expect({ shape: member.shape, selected: testGate.meta?.selectedTests }).toEqual({ shape: member.shape, selected: undefined });
        expect({ shape: member.shape, runs }).toEqual({ shape: member.shape, runs: [""] }); // one full run, never two
      }
      expect({ shape: member.shape, pass: results.every((r) => r.pass) }).toEqual({ shape: member.shape, pass: true });
    }

    // the miss: the selected subset is green, the full suite is red. The round is red — one round
    // spent, and `results.every(pass)` (the daemon's merge condition) refuses.
    const { repo } = corpusRepo();
    // the runner is armed BEFORE the base, so the round's own diff is one covered source file
    writeFileSync(join(repo, "run.sh"), [
      "if [ \"$#\" -gt 0 ]; then echo \"$*\" >> argv.log; exit 0; fi", // the subset the selector picked: green
      "echo \"\" >> argv.log",
      "if [ -f miss.flag ]; then echo 'FAIL tests/hidden.test.ts'; exit 1; fi", // the suite: a failure no selection saw
      "exit 0",
    ].join("\n"));
    commitAll(repo, "arm-the-miss");
    const missBase = await gitHead(repo);
    writeFileSync(join(repo, "src/a.ts"), "import { deep } from \"./deep.js\";\nexport const a = () => deep() + 2;\n");
    commitAll(repo, "work");
    const missed = await gates(
      { gates: DETERMINISTIC, files: ["**"] }, repo, missBase, { test: "sh run.sh" },
      { selectTests: true, armAfterBaseline: () => writeFileSync(join(repo, "miss.flag"), "a failure the selection cannot see\n") },
    );
    const missedTest = missed.results.find((r) => r.gate === "test")!;
    expect(missedTest.meta?.selectedTests).toEqual(["tests/a.test.ts"]); // the selection happened
    expect(argvLines(repo).slice(1)).toEqual(["tests/a.test.ts", ""]); // subset green, then the full suite
    expect(missedTest.pass).toBe(false); // and the full suite is what the round reports
    expect(missed.results.every((r) => r.pass)).toBe(false); // never a merge — the miss cost this round only
  }, 60_000);

  // The corpus above pins the merge-candidate exit. This is the OTHER one: a round whose verdict gate
  // goes red never reaches the full suite, so the selected screen is all that ran — and it must still
  // be journaled, exactly once, as the selection it was. Two `test` gate-results in one round would be
  // indistinguishable to every consumer that counts verdicts.
  test("a round that dies after a green selected screen still journals it once, as a selected run", async () => {
    const { repo, baseRef } = corpusRepo();
    const base = await baseRef;
    writeFileSync(join(repo, "src/a.ts"), "import { deep } from \"./deep.js\";\nexport const a = () => deep() + 3;\n");
    commitAll(repo, "work");

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const commands = { test: "sh run.sh" };
    const ends: GateEvent[] = [];
    const { results } = await runGates(mkTask({ files: ["**"] }), {
      worktree: repo, baseRef: base, author,
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline: await captureBaseline(repo, commands), channels,
      // the judge refuses, so the round ends at the verdict gates — before the merge-candidate suite
      adapters: [fakeWith({
        judge: { pass: false, criteria: [{ criterion: "a", met: false, reason: "no" }] },
        review: { approve: true, issues: [] },
      }).adapter],
      cfg, pipeline: "v185", selectTests: true,
      onGate: (e) => { if (e.phase === "end") ends.push(e); },
    });

    const testEnds = ends.filter((e) => e.gate === "test");
    expect(testEnds).toHaveLength(1);
    const verdict = testEnds[0]!.phase === "end" ? testEnds[0]!.result : undefined;
    expect(verdict?.pass).toBe(true);
    expect(verdict?.meta?.selectedTests).toEqual(["tests/a.test.ts"]);
    expect(verdict?.meta?.fullSuite).toBeUndefined(); // the full suite never ran, and the record says so
    expect(verdict).toEqual(results.find((r) => r.gate === "test")); // stream and record agree
    expect(argvLines(repo).slice(1)).toEqual(["tests/a.test.ts"]); // the subset really is all that ran
    expect(results.every((r) => r.pass)).toBe(false);
  }, 30_000);

  // The selector's ban is a fact about the TASK, and the journal is the only state that survives a
  // park, a `resume`, or a daemon restart. Seeded from process memory it always starts clean, so one
  // miss could be re-bought every cycle instead of costing exactly one round.
  test("a journaled test failure survives a restart — the resumed round runs the full suite, never a selection", async () => {
    const selectionRun = async (runId: string, seed: boolean) => {
      const log = join(makeTestTempDir("tickmarkr-argv-"), "argv.log");
      const { repo, fake } = setupRepo(
        [T("T1", { files: ["**"] })],
        { tasks: { T1: [{ shell: `echo 'export const a = () => 2;' > src/a.ts && ${COMMIT} work`, result: { ok: true, summary: "w" } }] } },
        `gates: { test: "sh run.sh" }\n`,
      );
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(join(repo, "src/a.ts"), "export const a = () => 1;\n");
      writeFileSync(join(repo, "tests/a.test.ts"), "import { a } from \"../src/a.js\";\na();\n");
      writeFileSync(join(repo, "run.sh"), `echo "$*" >> ${log}\nexit 0\n`);
      commitAll(repo, "fixture");

      const commands = { test: "sh run.sh" };
      const journal = Journal.create(repo, runId);
      journal.append("run-start", undefined, {
        baseRef: await gitHead(repo), commands, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)),
      });
      // the interrupted process's evidence: this task's test gate already went red once
      if (seed) journal.append("gate-result", "T1", { gate: "test", pass: false, details: "the suite the selection could not see" });
      writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(await captureBaseline(repo, commands)));

      const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
      expect(summary.done).toEqual(["T1"]);
      return readFileSync(log, "utf8").split("\n").slice(0, -1);
    };

    // the falsifier first: with nothing journaled against it, the resumed round DOES select
    expect(await selectionRun("run-select-clean", false)).toContain("tests/a.test.ts");
    // and with the failure on the record, no run of the suite ever carries a filter again
    expect(await selectionRun("run-select-banned", true)).not.toContain("tests/a.test.ts");
  }, 60_000);
});

describe("T4 — a verified tip is verified for the SHA it verified (OBS-266)", () => {
  test("an unmoved verified tip skips re-verification and a moved tip or changed command hash runs it in full", async () => {
    // verify.log is the witness: gitignored, exactly like the artifacts a real suite drops, so the
    // integration tree stays clean between run-ends.
    const repo = makeRepo({ "a.txt": "x\n", "verify.sh": "echo ran >> verify.log\nexit 0\n", ".gitignore": "verify.log\n.tickmarkr/\n" });
    const journal = Journal.create(repo, "run-20260801-000000");
    const commands = { test: "sh verify.sh" };
    const runs = () => (existsSync(join(repo, "verify.log")) ? readFileSync(join(repo, "verify.log"), "utf8").trim().split("\n").length : 0);
    const events = () => journal.read();

    // 1. first verify: real run, and the SHA it verified is on the record
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    const tip = await gitHead(repo);
    expect(runs()).toBe(1);
    expect(events().filter((e) => e.event === "tip-verify").map((e) => e.data.tip)).toEqual([tip]);

    // 2. nothing moved: the same green, not a second suite
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(1);
    expect(events().filter((e) => e.event === "tip-verify-cached").map((e) => e.data.tip)).toEqual([tip]);
    // …and the skip still reads as GREEN to every surface: they derive the verdict from this cycle's
    // tip-verify events, and a run-end claiming "passed" with none of them is fail-closed to FAILED.
    const carried = events().filter((e) => e.event === "tip-verify" && e.data.cached === true);
    expect(carried.map((e) => [e.data.gate, e.data.pass, e.data.tip])).toEqual([["test", true, tip]]);

    // 3. a dirty tree is doubt: verify in full even on the same SHA
    writeFileSync(join(repo, "untracked.txt"), "uncommitted\n");
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(2);
    rmSync(join(repo, "untracked.txt"));

    // 4. the tip moved: verify in full
    writeFileSync(join(repo, "a.txt"), "y\n");
    commitAll(repo, "merge-something");
    const moved = await gitHead(repo);
    expect(moved).not.toBe(tip);
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(3);
    // the real verify, the carried-forward green, the dirty-tree re-verify, then the moved tip
    expect(events().filter((e) => e.event === "tip-verify").map((e) => e.data.tip)).toEqual([tip, tip, tip, moved]);

    // 5. same tip, different commands: a different verify, so it runs in full
    expect(await verifyIntegrationTipCached(repo, { test: "sh verify.sh", lint: "sh verify.sh" }, journal)).toBe(false);
    expect(runs()).toBe(5); // two commands, both really executed
    // …and switching BACK is not a hit. The skip is licensed by the LAST green verify, never by a
    // history of every pair ever green: the last thing that ran on this SHA was the other command
    // set, so A→B→A re-verifies. Only once A is the last one again does the next run-end skip.
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(6);
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(6);

    // 6. a RED tip is never cached — the failure is re-run, every time
    writeFileSync(join(repo, "verify.sh"), "echo ran >> verify.log\nexit 1\n");
    commitAll(repo, "break-it");
    const red = { test: "sh verify.sh" };
    expect(await verifyIntegrationTipCached(repo, red, journal)).toBe(true);
    const after = runs();
    expect(await verifyIntegrationTipCached(repo, red, journal)).toBe(true);
    expect(runs()).toBe(after + 1);
  }, 30_000);

  // The tip half of the same rule: the skip is licensed by the LAST green verify, never by a history
  // of every SHA ever green. A tip that moves away and back really moved, so it is verified again.
  test("a tip that moves away and back is re-verified — only the most recent green licenses a skip", async () => {
    const repo = makeRepo({ "a.txt": "x\n", "verify.sh": "echo ran >> verify.log\nexit 0\n", ".gitignore": "verify.log\n.tickmarkr/\n" });
    const journal = Journal.create(repo, "run-20260803-000000");
    const commands = { test: "sh verify.sh" };
    const runs = () => (existsSync(join(repo, "verify.log")) ? readFileSync(join(repo, "verify.log"), "utf8").trim().split("\n").length : 0);

    const a = await gitHead(repo);
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(1);

    writeFileSync(join(repo, "a.txt"), "y\n");
    commitAll(repo, "b");
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(2);

    // back to A: green once, long ago — but B is what the last verify spoke for, so A is re-verified.
    // A history-wide cache would skip here and report an unverified state as green.
    git(repo, `reset --hard ${a}`);
    expect(await gitHead(repo)).toBe(a);
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(3);
    // …and now A IS the last green verify, so the next run-end on it skips
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(3);
  }, 30_000);

  test("a same-tip red-to-green recovery establishes a new cacheable verification cycle", async () => {
    const repo = makeRepo({
      "a.txt": "x\n",
      "verify.sh": "echo ran >> verify.log\n[ ! -f fail.flag ]\n",
      ".gitignore": "verify.log\nfail.flag\n.tickmarkr/\n",
    });
    const journal = Journal.create(repo, "run-20260803-red-green");
    const commands = { test: "sh verify.sh" };
    const runs = () => readFileSync(join(repo, "verify.log"), "utf8").trim().split("\n").length;

    // Same SHA, same command hash: the first cycle is red, the next real cycle recovers, and that
    // recovered green — not the earlier red — licenses the following run-end to skip.
    writeFileSync(join(repo, "fail.flag"), "red\n");
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(true);
    rmSync(join(repo, "fail.flag"));
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(2);
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    expect(runs()).toBe(2);
    expect(journal.read().filter((e) => e.event === "tip-verify-cached")).toHaveLength(1);
  }, 30_000);
});

// SubprocessDriver hosts a scripted interactive worker (copied from tests/run/daemon-interactive.ts's
// idriver: the daemon's nudge path only exists for interactive drivers).
function idriver(overrides: Record<string, unknown> = {}): ExecutorDriver {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-fake",
    interactive: true,
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
    status: async () => "unknown",
    ...overrides,
  } as ExecutorDriver;
}

describe("T4 — merged-task invariants under the reordered pipeline", () => {
  test("with commits ahead of base and a nudge-eligible adapter, the merged liveness nudge still fires and is journaled under the reordered pipeline — merged-task invariants proven in a composed fixture where both preconditions occur together", async () => {
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(400, 600);
    setHarvestSilentMsForTests(150); // harvest is eligible FIRST — the nudge hold is the only reason the pane lives
    try {
      const { repo, fake } = setupRepo(
        [T("T1", { timeoutMinutes: 30 })], // the 60s test timeout proves the window was never waited out
        {
          consult: { action: "human", notes: "stalled worker" },
          // both preconditions in ONE fixture: the worker COMMITS (ahead of base) and then goes silent
          tasks: { T1: [{ shell: `echo landed > a.txt && ${COMMIT} landed && echo working-on-it && sleep 20` }] },
        },
      );
      let nudges = 0;
      const driver = idriver({ status: async () => "working", nudge: async () => { nudges++; return true; }, notify: async () => {} });
      await runDaemon(repo, { adapters: [fake], runId: "run-t4-composed", driver });
      const evs = Journal.open(repo, "run-t4-composed").read();
      expect(nudges).toBe(1);
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      // the commits really were ahead of base when the nudge fired — the same attempt's work is what
      // the conclusion carries into gates, and the gates it lands in are the reordered ones.
      const gateEvents = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1");
      // the daemon's own round, end to end: deterministic gates retain their sequence; the two
      // independently-published verdicts each land once in whichever fulfillment order is true.
      const gateNames = gateEvents.map((e) => e.data.gate as string);
      expect(gateNames.slice(0, 5)).toEqual(["build", "test", "lint", "evidence", "scope"]);
      expect(gateNames.slice(5).sort()).toEqual(["acceptance", "review"]);
      // the round's parallelism reaches the JOURNAL, not just the gate stream. The marker is the
      // gate stream's shared parentAt reduced to a run-identical boolean: two runs of one graph still
      // journal byte-identical events (tests/run/notify-identity.test.ts), and a surface can still say
      // which phases were one round rather than a sequence.
      const parallelOf = (gate: string) => evs.find((e) => e.event === "phase-start" && e.data.gate === gate)?.data.parallel;
      expect(parallelOf("acceptance")).toBe(true);
      expect(parallelOf("review")).toBe(true);
      expect(parallelOf("evidence")).toBeUndefined(); // the deterministic gates ARE the sequence
      expect(evs.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetHarvestSilentMsForTests();
    }
  }, 60_000);
});

// ── R3 review participation + OBS-201/262 nudge deliverability ─────────────────────────────────
// The T4 fixture above proved the composition with a CLOSURE-STUB nudge (`nudge: async () => true`),
// which cannot fail — it hid, through two engagements, that claude-code (the ONLY member of
// NUDGEABLE_ADAPTERS) declared no input box, so the real driver's pincer had nothing to recognise.
// This test replaces the stub with HerdrDriver.nudge itself, driven against pane frames CAPTURED
// from claude 2.1.220, and re-keys participation on paths.

/** Frames captured from a live claude-code TUI (2.1.220, tmux 120x30, 2026-08-03). */
const CLAUDE_PANE_CHROME = [
  "\u256d\u2500\u2500\u2500 Claude Code v2.1.220 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e",
  "\u2502                Welcome back Khalid!                \u2502",
  "\u2570" + "\u2500".repeat(50) + "\u256f",
].join("\n");

/** The editor itself: one caret row FENCED BY TWO RULES, the caret padded with U+00A0 (not a space). */
const CLAUDE_RULE = "\u2500".repeat(120);
const claudeFrame = (typed: string) => [
  CLAUDE_PANE_CHROME,
  CLAUDE_RULE,
  `\u276f\u00a0${typed}`,
  CLAUDE_RULE,
  "  Fable 5 \u2502 boxprobe                                                            /rc",
].join("\n");

/**
 * A herdr stub that answers the exact verbs HerdrDriver issues and repaints the CAPTURED frames as
 * the driver types into them: a bare shell prompt before launch, the launch echo plus a painted
 * editor after it, and the typed turn inside the caret row until Enter clears it. Nothing about the
 * driver is stubbed — only the terminal it talks to.
 */
function makeClaudeHerdrStub(): { bin: string; cwd: string } {
  const dir = makeTestTempDir("tickmarkr-claude-box-");
  const bin = join(dir, "herdr");
  const frames = join(dir, "frames.js");
  writeFileSync(frames, `const chrome = ${JSON.stringify(CLAUDE_PANE_CHROME)};\n`
    + `const rule = ${JSON.stringify(CLAUDE_RULE)};\n`
    + `const fs = require("fs");\n`
    + `const typed = fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2], "utf8").replace(/\\n$/, "") : "";\n`
    + `const launch = fs.existsSync(process.argv[3]) ? fs.readFileSync(process.argv[3], "utf8").replace(/\\n$/, "") : "";\n`
    + `if (!launch) { process.stdout.write("\\u279c  work " + typed + "\\n"); process.exit(0); }\n`
    + `process.stdout.write(["\\u279c  work " + launch, chrome, rule, "\\u276f\\u00a0" + typed, rule].join("\\n") + "\\n");\n`);
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
D='${dir}'
case "$1 $2" in
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "pane rename") printf '%s' "$4" > "$D/label.txt"; echo '{}' ;;
  "pane list") printf '{"result":{"panes":[{"pane_id":"w1:p1","label":"%s"}]}}\n' "$(cat "$D/label.txt" 2>/dev/null)" ;;
  "pane read") node "$D/frames.js" "$D/typed.txt" "$D/launch.txt" ;;
  "pane send-text") printf '%s' "$4" > "$D/typed.txt"; echo '{}' ;;
  "pane send-keys")
    if [ "$4" = "Enter" ] && [ -f "$D/typed.txt" ]; then
      if [ ! -f "$D/launch.txt" ]; then cp "$D/typed.txt" "$D/launch.txt"; fi
      rm -f "$D/typed.txt"
    fi
    echo '{}' ;;
  # v1.85 T5: the LAUNCH is a shell dispatch, delivered atomically and acknowledged by the START
  # nonce the line prints for itself. The line runs in a real shell with an empty PATH, so its
  # acknowledgment builtins execute (the ack is causal, never answered by the fixture) while the
  # claude command they gate cannot — this fixture paints an editor, it never runs an agent CLI.
  "pane run")
    PATH='' /bin/bash -c "$4" >> "$D/paneout" 2>/dev/null || :
    case "$4" in *TICKMARKR_START_*) t="\${4#*; }"; printf '%s' "\${t#*; }" > "$D/launch.txt" ;; esac
    echo '{}' ;;
  "pane wait-output")
    case "$5" in
      TICKMARKR_START_*) grep -q -- "$5" "$D/paneout" 2>/dev/null && exit 0 || exit 1 ;;
      *) exit 0 ;;
    esac ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, cwd: makeTestTempDir("tickmarkr-claude-box-cwd-") };
}

/**
 * A second-vendor reviewer that is a FakeAdapter under another id — and so NOT the adapter llm.ts
 * binds a scripted verdict to (`augmentFakeVerdictOutput` is scoped to `adapter.id === "fake"`).
 * It emits its own VERDICT_NONCE-bound copy, exactly as a real reviewer CLI does. `bindNonce: false`
 * is the falsification lever: the same fixture with an UNBOUND verdict must fail the gate closed.
 */
class NoncedFake extends FakeAdapter {
  constructor(private sp: string, public id: string, public vendor: string, private bindNonce = true) {
    super(sp);
  }
  async probe() {
    return { installed: true, authed: true, version: "fake", models: ["rev-1"], modelAuth: { "rev-1": { authed: true, probedAt: "1970-01-01T00:00:00.000Z" } } };
  }
  channels(): BillingChannel[] {
    return [{ adapter: this.id, vendor: this.vendor, model: "rev-1", channel: "sub", tier: "frontier" }];
  }
  headlessCommand(promptFile: string, model: string): string {
    const base = super.headlessCommand(promptFile, model);
    if (!this.bindNonce) return base;
    const prompt = readFileSync(promptFile, "utf8");
    const nonce = extractPromptNonce(prompt);
    if (!nonce || !/TICKMARKR-REVIEW/.test(prompt)) return base;
    const scripted = (JSON.parse(readFileSync(this.sp, "utf8")) as { review?: unknown }).review;
    if (!scripted || typeof scripted !== "object") return base;
    return `${base}; echo ${shq(JSON.stringify({ ...scripted, nonce }))}`;
  }
}

describe("R3 participation is path-keyed and the nudge reaches the adapter allowed to receive it", () => {
  test("test: the rewritten participation assertions key on touched paths and pass with nonce verification intact, and in a composed fixture a nudge-eligible worker with commits ahead of base still receives the merged liveness nudge — delivered by the real driver against claude-code's declared input box — under path-keyed participation", async () => {
    // ── half one: participation keyed on the paths, decided by a verdict that is nonce-bound ─────
    const reviewerScript = join(makeTestTempDir("tickmarkr-nonced-"), "s.json");
    writeFileSync(reviewerScript, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
    const pool: BillingChannel[] = [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "rev", vendor: "other-vendor", model: "rev-1", channel: "sub", tier: "frontier" },
    ];
    const gatesWith = async (files: string[], touch: Record<string, string>, reviewer: FakeAdapter) => {
      const { repo, baseRef } = repoWithCommit(touch);
      return runGates(task("implement", 3, files), {
        worktree: repo, baseRef, author,
        result: { ok: true, summary: "", deviations: [], raw: "" },
        commands: {}, baseline: await captureBaseline(repo, {}),
        channels: pool, adapters: [fake(), reviewer], cfg, pipeline: "v185",
      });
    };

    // the declared paths are leaf-class AND the diff stayed there → the review declines, honestly
    const leaf = await gatesWith(["docs/**", "CHANGELOG.md"], { "docs/guide.md": "# guide\n" }, new NoncedFake(reviewerScript, "rev", "other-vendor"));
    const leafReview = leaf.results.find((r) => r.gate === "review")!;
    expect(leafReview.pass).not.toBe(true);
    expect(leafReview.meta).toMatchObject({ skipped: true, verdict: "skipped", policy: "judge-only" });

    // the SAME complexity, source paths → a real cross-vendor review runs and its verdict is taken
    const source = await gatesWith(["src/run/daemon.ts"], { "src/run/daemon.ts": "export const x = 1;\n" }, new NoncedFake(reviewerScript, "rev", "other-vendor"));
    const sourceReview = source.results.find((r) => r.gate === "review")!;
    expect(sourceReview.pass).toBe(true);
    expect(sourceReview.meta).toMatchObject({ policy: "full", reviewer: "rev:rev-1" });

    // …and it was taken BECAUSE the verdict carried this call's nonce: the identical fixture with an
    // unbound verdict fails closed on `no-verdict`. Nonce verification is exercised, never bypassed.
    const unbound = await gatesWith(["src/run/daemon.ts"], { "src/run/daemon.ts": "export const x = 1;\n" }, new NoncedFake(reviewerScript, "rev", "other-vendor", false));
    const unboundReview = unbound.results.find((r) => r.gate === "review")!;
    expect(unboundReview.pass).toBe(false);
    expect(unboundReview.meta).toMatchObject({ unparseable: true, cause: "no-verdict" });

    // ── half two: the composed fixture, nudged by the REAL driver against the DECLARED box ───────
    // The declaration is claude-code's own, resolved the way the driver resolves it — off the
    // adapter-bearing worker slot name, before canonicalization.
    const box = declaredInputBoxForWorkerName("T1-worker-claude-code-a0-run-r3");
    expect(box).toBeDefined();
    expect(box!.match!(claudeFrame(""))).toBe(true); // painted, empty → ready to receive
    expect(box!.emptyMatch!(claudeFrame(""))).toBe(true);
    expect(box!.emptyMatch!(claudeFrame(WORKER_NUDGE_MESSAGE))).toBe(false); // occupied is not empty
    // the U+00A0 padding is the whole ballgame: an ASCII-space caret is a different pane
    expect(box!.match!(claudeFrame("").replace("\u276f\u00a0", "\u276f "))).toBe(false);

    const prevWs = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wR3";
    NUDGEABLE_ADAPTERS.add("fake");
    setNudgeTimingForTests(400, 600);
    setHarvestSilentMsForTests(150); // harvest is eligible FIRST — the nudge hold is why the pane lives
    try {
      const { bin, cwd } = makeClaudeHerdrStub();
      const real = new HerdrDriver(bin);
      const paneSlot = await real.slot(cwd, "T1-worker-claude-code-a0-run-r3");
      // launch the adapter's REAL interactive command, through the real verified-delivery pincer,
      // so the pane is pinned exactly as a production dispatch pins it (nudge refuses an unpinned slot)
      await real.run(paneSlot, claudeCode.interactiveCommand!("/tmp/prompt.md", "fable"));

      const { repo, fake: worker } = setupRepo(
        [T("T1", { timeoutMinutes: 30 })],
        {
          consult: { action: "human", notes: "stalled worker" },
          // both preconditions in ONE fixture: the worker COMMITS (ahead of base), then goes silent
          tasks: { T1: [{ shell: `echo landed > a.txt && ${COMMIT} landed && echo working-on-it && sleep 20` }] },
        },
      );
      const deliveries: boolean[] = [];
      const driver = idriver({
        status: async () => "working",
        notify: async () => {},
        // The daemon's own slot belongs to the subprocess driver that runs the worker; the nudge is
        // handed to the real HerdrDriver's pinned pane. Everything the nudge exercises — readiness
        // stable-frame against the declared box, type-without-Enter, read-back, verified submit — is
        // the shipped code path, not a fixture's return value.
        nudge: async (_slot: unknown, message: string) => {
          const ok = await real.nudge(paneSlot, message);
          deliveries.push(ok);
          return ok;
        },
      });
      await runDaemon(repo, { adapters: [worker], runId: "run-r3-nudge", driver });

      expect(deliveries).toEqual([true]); // the real pincer landed it — one delivery, no retry
      const evs = Journal.open(repo, "run-r3-nudge").read();
      expect(evs.filter((e) => e.event === "worker-nudge" && e.taskId === "T1")).toHaveLength(1);
      expect(evs.some((e) => e.event === "worker-nudge-failed")).toBe(false);
      // the commits really were ahead of base when the nudge fired, and the round still merged
      expect(evs.some((e) => e.event === "merge" && e.taskId === "T1")).toBe(true);
      // …under path-keyed participation: T1 declares no files, so its review is `full` and RAN
      const review = evs.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review").at(-1);
      expect(review?.data.pass).toBe(true);
      expect(review?.data.skipped).toBeUndefined();
    } finally {
      NUDGEABLE_ADAPTERS.delete("fake");
      resetNudgeTimingForTests();
      resetHarvestSilentMsForTests();
      if (prevWs === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = prevWs;
    }
  }, 120_000);
});
