import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync, execSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  baselineIdentity,
  getWorktreeTree,
  getVerdictStore,
  computeVerificationIdentity,
  environmentFingerprint,
  verificationIdentityKey,
  resetVerdictCacheBoundForTests,
  setVerdictCacheBoundForTests,
  VerdictStore,
} from "../../src/gates/cache.js";
import { captureBaseline, type Baseline } from "../../src/gates/baseline.js";
import { type GateContext, runGates } from "../../src/gates/run-gates.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { validateGraph } from "../../src/graph/schema.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { gitHead, resolvedCapacity, runWithVerificationBudget, sameVerification, VERIFICATION_PROTOCOL, verificationProtocol } from "../../src/run/git.js";
import { verify } from "../../src/cli/commands/verify.js";
import { commandsHash, resetApprovalWindowForTests, runDaemon, setApprovalWindowForTests, verifyIntegrationTipCached } from "../../src/run/daemon.js";
import { type TipVerifyResult, verifyIntegrationTip } from "../../src/run/merge.js";
import { Journal } from "../../src/run/journal.js";
import { resolveReceiptArtifacts } from "../../src/run/receipt-resolver.js";
import { makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

function commitAll(repo: string, msg: string): void {
  execSync(`git add -A && git commit --no-gpg-sign -m "${msg}"`, { cwd: repo, encoding: "utf8" });
}

function freshProcess(script: string): unknown {
  return JSON.parse(execFileSync(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", script,
  ], { encoding: "utf8", timeout: 20_000 }));
}

test("test: two worktrees with identical trees whose admitted links target different in tree packages compute different verification identities while identical resolutions in relocated worktrees share one, so a key that omits resolution fails", async () => {
  const files = { ".gitignore": "node_modules\n", "packages/a/index.js": "export default 1;\n",
    "packages/b/index.js": "export default 2;\n" };
  const repos = [makeRepo(files), makeRepo(files), makeRepo(files)];
  for (const [index, repo] of repos.entries()) {
    // An external dependency root models the harness-provisioned node_modules link.
    const dependencies = makeTestTempDir("tickmarkr-resolution-");
    mkdirSync(join(dependencies, "@scope"));
    mkdirSync(join(dependencies, ".store/a"), { recursive: true });
    mkdirSync(join(dependencies, ".store/b"), { recursive: true });
    symlinkSync(dependencies, join(repo, "node_modules"), "dir");
    // Reverse creation order in the relocated control; inventory order must be canonical.
    const links = [
      ["workspace", join(repo, "packages", index === 1 ? "b" : "a")],
      ["@scope/installed", join(dependencies, ".store/a")],
    ];
    for (const [link, target] of index === 2 ? links.reverse() : links) {
      symlinkSync(target!, join(dependencies, link!), "dir");
    }
  }
  const identify = (worktree: string) => computeVerificationIdentity({ worktree, gate: "test", command: "npm test",
    capacity: { forkCap: 2, cores: 4 },
    verification: { protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" } });
  const [first, changed, relocated] = await Promise.all(repos.map(identify));
  expect(first?.tree).toBeTruthy();
  expect(changed?.tree).toBe(first!.tree);
  expect(relocated?.tree).toBe(first!.tree);
  expect(verificationIdentityKey(changed!)).not.toBe(verificationIdentityKey(first!));
  expect(verificationIdentityKey(relocated!)).toBe(verificationIdentityKey(first!));
  // The admitted dependency-store links are part of the whole inventory too.
  const installed = join(repos[2]!, "node_modules/@scope/installed");
  rmSync(installed);
  symlinkSync(join(realpathSync(join(repos[2]!, "node_modules")), ".store/b"), installed, "dir");
  expect(verificationIdentityKey((await identify(repos[2]!))!)).not.toBe(verificationIdentityKey(first!));
});

test("test: a verdict write whose final replacement fails after its temp file was written leaves the previous record readable at the final path, so a store that unlinks the final file before copying fails", () => {
  const dir = makeTestTempDir("tickmarkr-atomic-verdict-");
  const id = { gate: "test", tree: "tree", command: "npm test", baseline: "none", environment: "env" };
  const store = new VerdictStore(dir);
  const previous = { gate: "test", pass: true, details: "previous completed verdict" };
  expect(store.set(id, previous)).toBe(true);
  const finalPath = join(dir, `verdict-${verificationIdentityKey(id)}.json`);
  const before = readFileSync(finalPath, "utf8");
  const failure = freshProcess(`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const finalPath = ${JSON.stringify(finalPath)};
    const write = fs.writeFileSync;
    let tempWritten = false;
    let replacementAttempted = false;
    const fail = () => { replacementAttempted = true; throw new Error("replacement denied"); };
    fs.writeFileSync = (path, ...args) => {
      if (path === finalPath) fail();
      const result = write(path, ...args);
      if (String(path).endsWith(".tmp")) tempWritten = fs.existsSync(path);
      return result;
    };
    fs.renameSync = (source, destination) => {
      if (destination !== finalPath) throw new Error("unexpected destination");
      tempWritten = tempWritten && fs.existsSync(source);
      fail();
    };
    syncBuiltinESMExports();
    const { VerdictStore } = await import(${JSON.stringify(new URL("../../src/gates/cache.ts", import.meta.url).href)});
    let error;
    try {
      new VerdictStore(${JSON.stringify(dir)}).set(${JSON.stringify(id)},
        { gate: "test", pass: false, details: "replacement verdict" });
    } catch (caught) { error = caught.message; }
    console.log(JSON.stringify({ tempWritten, replacementAttempted, error }));
  `);
  expect(failure).toEqual({ tempWritten: true, replacementAttempted: true, error: "replacement denied" });
  expect(readFileSync(finalPath, "utf8")).toBe(before);
  expect(new VerdictStore(dir).get(id)).toEqual(previous);
  expect(readdirSync(dir).filter(file => file.endsWith(".tmp"))).toEqual([]);
  const replacement = { gate: "test", pass: false, details: "replacement verdict" };
  expect(store.set(id, replacement)).toBe(true);
  expect(new VerdictStore(dir).get(id)).toEqual(replacement);
});

async function assertCancelledTipWritesNothing(): Promise<void> {
  const repo = makeRepo({ "code.txt": "ok\n", ".gitignore": "calls.log\nstarted\nrelease\n" });
  const journal = Journal.create(repo, "run-cancelled-tip");
  const commands = {
    build: "printf 'build\\n' >> calls.log",
    lint: "printf 'lint\\n' >> calls.log; touch started; if [ ! -f release ]; then sleep 30; fi",
  };
  journal.append("run-start", undefined, { commands });
  const controller = new AbortController();
  const reason = new Error("cancelled by approval");
  const running = verifyIntegrationTipCached(repo, commands, journal, { signal: controller.signal });
  // Attach rejection handling before delivering the signal.
  const finished = running.then(() => undefined, (error: unknown) => error);
  try {
    await vi.waitFor(() => expect(existsSync(join(repo, "started"))).toBe(true), { timeout: 10_000, interval: 20 });
    expect(readFileSync(join(repo, "calls.log"), "utf8").trim().split("\n")).toEqual(["build", "lint"]);
    expect(getVerdictStore(join(repo, ".tickmarkr")).size()).toBe(0);
  } finally {
    controller.abort(reason);
    await finished;
  }
  expect(await finished).toBe(reason);
  journal.append("tip-verify-cancelled", undefined, { reason: "approval" });
  expect(getVerdictStore(join(repo, ".tickmarkr")).size()).toBe(0);
  writeFileSync(join(repo, "release"), "ready");
  expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
  expect(readFileSync(join(repo, "calls.log"), "utf8").trim().split("\n")).toEqual(["build", "lint", "build", "lint"]);
}

async function assertScopeRedPolicies(): Promise<void> {
  const repo = makeRepo({
    "tests/a.test.ts": "// initial\n", ".gitignore": "calls.log\n",
    "check.sh": "echo test >> calls.log\n[ $# -gt 0 ] && exit 0\nexit 1\n",
  });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "tests/a.test.ts"), "// changed\n");
  commitAll(repo, "change test");
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["s"], hash: "h" },
    tasks: [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["tests/**"] })] }).tasks[0]!;
  const ctx = {
    worktree: repo, baseRef, commands: { test: "sh check.sh" }, baseline: { commands: { test: { exitCode: 0, fingerprints: [] } } },
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } as const,
    result: { ok: true, summary: "", deviations: [], raw: "" },
    channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), selectTests: true,
  };
  const first = await runGates(task, ctx);
  expect(first.results.find((r) => r.gate === "test")).toMatchObject({ pass: false, meta: { fullSuite: true } });
  expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("test\ntest\n");
  const second = await runGates(task, ctx);
  expect(second.results.find((r) => r.gate === "test")).toMatchObject({ pass: false, meta: { fullSuite: true, reused: true } });
  expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("test\ntest\n");

  const store = getVerdictStore(join(repo, ".tickmarkr"));
  store.clear();
  // Same command, but selected evidence: the environment alone must prevent a full-suite hit.
  const selectedId = await computeVerificationIdentity({ worktree: repo, gate: "test", command: ctx.commands.test,
    baseline: ctx.baseline, selectedSet: ["tests/a.test.ts"] });
  store.set(selectedId, { gate: "test", pass: true, details: "selected green" });
  const full = await runGates(task, { ...ctx, selectTests: false });
  expect(full.results.find((r) => r.gate === "test")?.pass).toBe(false);
  expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("test\ntest\ntest\n");

  const journal = Journal.create(repo, "run-red-tip");
  const commands = { build: "echo tip >> calls.log; exit 1" };
  journal.append("run-start", undefined, { commands });
  for (let i = 0; i < 2; i++) expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(true);
  expect(journal.read().filter((e) => e.event === "tip-verify-failed")).toHaveLength(2);
  expect(readFileSync(join(repo, "calls.log"), "utf8").split("\n").filter((x) => x === "tip")).toHaveLength(2);

  // Infra must execute again through the actual battery, even at an unchanged identity.
  const buildTask = { ...task, gates: ["build" as const] };
  // OBS-1059: the echo must land before the ceiling kills the shell even on a starved CI runner, where
  // spawning sh alone can exceed 100 ms — the sleep guarantees the timeout, the ceiling stays far above spawn.
  const infraCtx = { ...ctx, commands: { build: "echo infra >> calls.log; sleep 5" },
    baseline: { commands: { build: { ceilingMs: 1000, fingerprints: [] } } } };
  for (let i = 0; i < 2; i++) {
    const result = await runGates(buildTask, infraCtx);
    expect(result.results[0]?.meta?.classification).toBe("infra");
    expect(result.results[0]?.meta?.reused).not.toBe(true);
  }
  expect(readFileSync(join(repo, "calls.log"), "utf8").split("\n").filter((x) => x === "infra")).toHaveLength(2);
}

async function signalCacheFixture(selectTests: boolean, outcome = "exit 137") {
  const repo = makeRepo({
    "tests/a.test.ts": "// initial\n", ".gitignore": "calls.log\n",
    "check.sh": `if [ $# -gt 0 ]; then echo selected >> calls.log; exit 0; fi\necho full >> calls.log\n${outcome}\n`,
  });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "tests/a.test.ts"), "// changed\n");
  commitAll(repo, "change test");
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["s"], hash: "h" },
    tasks: [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["tests/**"] })] }).tasks[0]!;
  const ctx: GateContext = {
    worktree: repo, baseRef, commands: { test: "sh check.sh" },
    baseline: { commands: { test: { exitCode: 0, fingerprints: [] } } },
    author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    result: { ok: true, summary: "", deviations: [], raw: "" },
    channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), selectTests,
    stateDir: makeTestTempDir("tickmarkr-signal-cache-"),
  };
  const store = getVerdictStore(ctx.stateDir!);
  const identity = await computeVerificationIdentity({ worktree: repo, gate: "test", command: ctx.commands.test!,
    baseline: ctx.baseline, capacity: resolvedCapacity() });
  expect(identity?.tree).toBeTruthy();
  const calls = () => readFileSync(join(repo, "calls.log"), "utf8").trim().split("\n");
  return { repo, task, ctx, store, identity: identity!, calls };
}

describe.each([false, true])("D1 signal-exit cache protection (selected screen: %s)", (selectTests) => {
  test("a scripted exit 137 without a failure identity is never stored and the second battery reruns it", async () => {
    const { task, ctx, store, identity, calls } = await signalCacheFixture(selectTests);
    const emitted: unknown[] = [];
    ctx.onGate = (e) => { if (e.phase === "end" && e.gate === "test") emitted.push(e.result.meta); };
    for (let round = 0; round < 2; round++) {
      const result = (await runGates(task, ctx)).results.find((r) => r.gate === "test")!;
      expect(result.pass).toBe(false);
      expect(result.details).toContain("exits 137");
      expect(store.get(identity)).toBeUndefined();
      expect(store.size()).toBe(selectTests ? 1 : 0); // Only the selected green may persist.
      expect(result.meta).toMatchObject({ classification: "infra", infra: true, kind: "signal-exit", retryable: false });
      expect(result.meta?.reused).not.toBe(true);
      expect(result.meta?.fullSuite).toBe(selectTests ? true : undefined);
    }
    expect(calls()).toEqual(selectTests ? ["selected", "full", "full"] : ["full", "full"]);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((meta) => (meta as { infra?: boolean }).infra === true)).toBe(true);
  });

  test.each([false, true])("a planted infra verdict (pass: %s) is rejected before reuse", async (pass) => {
    const { task, ctx, store, identity, calls } = await signalCacheFixture(selectTests, "exit 0");
    // Bypass set's write guard to model an older or externally planted record on disk.
    expect(store.set(identity, { gate: "test", pass, details: "planted verdict" })).toBe(true);
    const path = join(store.dir, `verdict-${verificationIdentityKey(identity)}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.verdict.meta = { classification: "infra", infra: true, kind: "signal-exit" };
    writeFileSync(path, JSON.stringify(record));
    expect(store.get(identity)?.meta?.infra).toBe(true); // Prove the poisoned identity is reachable.
    const notes: unknown[] = [];
    ctx.onGate = (e) => { if (e.phase === "note" && e.name === "gate-reused-verdict") notes.push(e.payload); };
    const result = (await runGates(task, ctx)).results.find((r) => r.gate === "test")!;
    expect(result).toMatchObject({ pass: true, details: "exit 0" });
    expect(result.meta?.reused).not.toBe(true);
    expect(result.meta?.fullSuite).toBe(selectTests ? true : undefined);
    expect(notes).toEqual([]);
    expect(calls()).toEqual(selectTests ? ["selected", "full"] : ["full"]);
    expect(store.get(identity)).toMatchObject({ pass: true, details: "exit 0" });
    expect(store.get(identity)?.meta?.infra).not.toBe(true);
  });

  test("a legacy signal-only red without infra metadata is rejected before reuse", async () => {
    const { task, ctx, store, identity, calls } = await signalCacheFixture(selectTests, "exit 0");
    // This is the unclassified row that D1 wrote before the fix.
    expect(store.set(identity, { gate: "test", pass: false,
      details: "command was green at baseline but now exits 137 with no recognizable failure lines — failing closed" })).toBe(true);
    const notes: unknown[] = [];
    ctx.onGate = (e) => { if (e.phase === "note" && e.name === "gate-reused-verdict") notes.push(e.payload); };
    const result = (await runGates(task, ctx)).results.find((r) => r.gate === "test")!;
    expect(result).toMatchObject({ pass: true, details: "exit 0" });
    expect(result.meta?.reused).not.toBe(true);
    expect(notes).toEqual([]);
    expect(calls()).toEqual(selectTests ? ["selected", "full"] : ["full"]);
  });

  test("a named assertion failure beside signal evidence remains a reusable work verdict", async () => {
    const { task, ctx, store, identity, calls } = await signalCacheFixture(selectTests,
      "echo 'FAIL tests/a.test.ts > signal case: AssertionError expected 1 to be 2 after SIGTERM'\nexit 137");
    const first = (await runGates(task, ctx)).results.find((r) => r.gate === "test")!;
    expect(first.pass).toBe(false);
    expect(first.details).toContain("SIGTERM");
    expect(first.meta?.infra).not.toBe(true);
    expect(store.get(identity)?.pass).toBe(false);
    const second = (await runGates(task, ctx)).results.find((r) => r.gate === "test")!;
    expect(second).toMatchObject({ pass: false, details: first.details, meta: { reused: true } });
    expect(calls()).toEqual(selectTests ? ["selected", "full"] : ["full"]);
  });
});

describe("VC-1 verdict cache", () => {
  test("a second battery over the same tree command baseline and environment returns the first battery's green and red tool verdicts without running the commands and each reused row's details name the reuse and the identity, while changing any one of the four identity parts including the lockfile or the capacity runs the command again, so a cache keyed on fewer than four parts or a reuse the row hides fails", async () => {
    const repo = makeRepo({
      "src/code.ts": "export const val = 1;\n",
      ".gitignore": "battery.log\npackage-lock.json\n",
    });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "src/code.ts"), "export const val = 2;\n");
    commitAll(repo, "work");

    const commands = {
      build: `printf 'build\\n' >> battery.log; exit 0`,
      lint: `printf 'lint\\n' >> battery.log; exit 1`,
    };

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    const baseline = await captureBaseline(repo, { build: "exit 0", lint: "exit 0" });

    const logPath = join(repo, "battery.log");
    rmSync(logPath, { force: true });

    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "hash" },
      tasks: [{
        id: "T1", title: "T1", goal: "T1", shape: "implement", complexity: 8,
        acceptance: ["passes"],
        gates: ["build", "test", "lint", "evidence", "scope"],
        files: ["src/**"],
      }],
    }).tasks[0];

    const sdir = makeTestTempDir("tickmarkr-fake-");
    const sfile = join(sdir, "s.json");
    writeFileSync(sfile, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [] }, review: { approve: true, issues: [] } }));
    const adapter = new FakeAdapter(sfile);

    // First battery
    const round1 = await runGates(task, {
      worktree: repo, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels: [], adapters: [adapter], cfg,
    });

    const b1 = round1.results.find((r) => r.gate === "build")!;
    const l1 = round1.results.find((r) => r.gate === "lint")!;
    expect(b1.pass).toBe(true);
    expect(l1.pass).toBe(false);

    const log1 = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log1).toEqual(["build", "lint"]);

    // Second battery on the same tree, command, baseline, environment
    const notes: Array<Record<string, unknown>> = [];
    const round2 = await runGates(task, {
      worktree: repo, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels: [], adapters: [adapter], cfg,
      onGate: (e) => { if (e.phase === "note" && e.name === "gate-reused-verdict") notes.push(e.payload); },
    });

    // Returned without running commands
    const log2 = readFileSync(logPath, "utf8").trim().split("\n");
    expect(log2).toEqual(["build", "lint"]); // No new command executions!

    const b2 = round2.results.find((r) => r.gate === "build")!;
    const l2 = round2.results.find((r) => r.gate === "lint")!;
    expect(b2.pass).toBe(true);
    expect(l2.pass).toBe(false);

    // Each reused row names the reuse and the identity: a green in its details; a red on its meta and
    // its journaled note, with details byte-identical to the fresh red so the fingerprint cap still
    // reads it as the identical failure it is (no free retry).
    expect(b2.details).toMatch(/reused verdict \(identity: gate=build/);
    expect(b2.details).toContain(`command=${commands.build}`);
    expect(b2.meta?.reused).toBe(true);
    const b2Id = b2.meta?.verificationIdentity as { key: string } | undefined;
    expect(b2Id?.key).toMatch(/^battery-build-/);

    expect(l2.details).toBe(l1.details);
    expect(l2.meta?.reused).toBe(true);
    expect(l2.meta?.reusedDetails).toMatch(/reused verdict \(identity: gate=lint/);
    const l2Id = l2.meta?.verificationIdentity as { key: string } | undefined;
    expect(l2Id?.key).toMatch(/^battery-lint-/);
    expect(notes.map((n) => `${n.gate}:${n.pass}`)).toEqual(["build:true", "lint:false"]);
    expect(notes.every((n) => typeof n.key === "string" && typeof n.tree === "string" && String(n.details).includes("reused"))).toBe(true);

    // Part 1: Changing tree runs command again
    writeFileSync(join(repo, "src/code.ts"), "export const val = 3;\n");
    commitAll(repo, "tree-change");
    await runGates(task, {
      worktree: repo, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels: [], adapters: [adapter], cfg,
    });
    const logTree = readFileSync(logPath, "utf8").trim().split("\n");
    expect(logTree.length).toBeGreaterThan(2);

    // Part 2: Changing command runs command again
    const changedCommands = {
      build: `printf 'build2\\n' >> battery.log; exit 0`,
      lint: `printf 'lint2\\n' >> battery.log; exit 1`,
    };
    await runGates(task, {
      worktree: repo, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands: changedCommands, baseline, channels: [], adapters: [adapter], cfg,
    });
    expect(readFileSync(logPath, "utf8")).toContain("build2");

    // Part 3: Changing baseline runs command again
    const changedBaseline: Baseline = {
      commands: {
        build: { exitCode: 1, fingerprints: ["new"] },
      },
    };
    await runGates(task, {
      worktree: repo, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline: changedBaseline, channels: [], adapters: [adapter], cfg,
    });
    const logBase = readFileSync(logPath, "utf8").trim().split("\n");
    expect(logBase).toHaveLength(logTree.length + 4);
    expect(logBase.slice(-2)).toEqual(["build", "lint"]);

    // Part 4a: An ignored lockfile changes only the environment, not the tree.
    const treeBeforeLock = await getWorktreeTree(repo);
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    expect(await getWorktreeTree(repo)).toBe(treeBeforeLock);
    await runGates(task, {
      worktree: repo, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline: changedBaseline, channels: [], adapters: [adapter], cfg,
    });
    const logLock = readFileSync(logPath, "utf8").trim().split("\n");
    expect(logLock).toHaveLength(logBase.length + 2);
    expect(logLock.slice(-2)).toEqual(["build", "lint"]);

    // Part 4b: Changing capacity in environment runs command again
    const capacity = resolvedCapacity();
    await runWithVerificationBudget({ forkCap: capacity.forkCap + 1, cores: capacity.cores }, async () => {
      await runGates(task, {
        worktree: repo, baseRef,
        author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
        result: { ok: true, summary: "", deviations: [], raw: "" },
        commands, baseline: changedBaseline, channels: [], adapters: [adapter], cfg,
      });
    });
    const logCap = readFileSync(logPath, "utf8").trim().split("\n");
    expect(logCap).toHaveLength(logLock.length + 2);
    expect(logCap.slice(-2)).toEqual(["build", "lint"]);
  });

  test("an infra verdict at an identity is never returned on the next battery at that identity, the store holding its bound plus one entries evicts the oldest and answers the newest, and through runGates and verifyIntegrationTip the merge-candidate full suite, tip verify and standalone verify each reuse only a verdict recorded in their own verification scope at the identical identity, green or red for the task battery including its merge-candidate full suite and green only for tip verify and standalone verify, with their own row naming the reuse, where a tip verify in a fresh process and a different worktree of the same repository, sharing the state store and identical tree, command, baseline, environment and scope, reuses the prior completed tip-verify green without executing the command and neither checkout path nor process identity prevents the hit, the store reopened in a fresh process still evicts the oldest and answers the newest, a task-battery green never answers tip verify even over the identical tree, a selected screen never answers the full suite, a tip verify the daemon cancelled recorded nothing, not even the gates it completed before the cancel, so the verify re-entered at close runs, and a completed tip verify's cycle cache still answers first with its tip-verify-cached row unchanged, so an infra result reused, an unbounded store, a close that serves a cancelled verify from the store, a forced full gate satisfied by a selected entry, a tip verify satisfied by a task-battery entry, a positive control that still passes when the tip store read is bypassed or the checkout path enters the key, or a caller that bypasses the store within its scope fails", async () => {
    // 1. Infra verdict is never stored / returned
    const stateDir = makeTestTempDir("tickmarkr-store-");
    const store = new VerdictStore(join(stateDir, "verdicts"));
    const id1 = { tree: "t1", command: "cmd1", baseline: "b1", environment: "e1" };

    const infraVerdict = {
      gate: "build",
      pass: false,
      details: "infra; timeout occurred",
      meta: { classification: "infra", infra: true },
    };
    const storedInfra = store.set(id1, infraVerdict);
    expect(storedInfra).toBe(false);
    expect(store.get(id1)).toBeUndefined();

    // 2. Bounded store: bound plus one evicts oldest and answers newest
    setVerdictCacheBoundForTests(2);
    try {
      const e1 = { tree: "t1", command: "c1", baseline: "b1", environment: "e1" };
      const e2 = { tree: "t2", command: "c2", baseline: "b2", environment: "e2" };
      const e3 = { tree: "t3", command: "c3", baseline: "b3", environment: "e3" };

      store.set(e1, { gate: "build", pass: true, details: "v1" });
      expect(store.size()).toBe(1);
      store.set(e2, { gate: "build", pass: true, details: "v2" });
      expect(store.size()).toBe(2);

      // Adding 3rd entry (bound + 1) evicts oldest (e1) and keeps newest (e3)
      store.set(e3, { gate: "build", pass: true, details: "v3" });
      expect(store.size()).toBe(2);
      expect(store.get(e1)).toBeUndefined(); // Oldest evicted!
      expect(store.get(e3)?.details).toBe("v3"); // Newest answered!
      expect(store.get(e2)?.details).toBe("v2");
    } finally {
      resetVerdictCacheBoundForTests();
    }

    // 2b. A clock rollback across restart must not evict the new process's first write.
    const now = vi.spyOn(Date, "now").mockReturnValue(123456789);
    setVerdictCacheBoundForTests(2);
    try {
      const pDir = makeTestTempDir("tickmarkr-probe-");
      const s1 = new VerdictStore(join(pDir, "verdicts"));
      for (let i = 1; i <= 5; i++) {
        s1.set(
          { gate: "build", tree: `tp${i}`, command: "cmd", baseline: "base", environment: "env" },
          { gate: "build", pass: true, details: `probe-${i}` },
        );
      }
      expect(s1.size()).toBe(2);
      freshProcess(`
        import { VerdictStore, setVerdictCacheBoundForTests } from ${JSON.stringify(new URL("../../src/gates/cache.ts", import.meta.url).href)};
        Date.now = () => 123456788;
        setVerdictCacheBoundForTests(2);
        const store = new VerdictStore(${JSON.stringify(join(pDir, "verdicts"))});
        store.set({ gate: "build", tree: "tp6", command: "cmd", baseline: "base", environment: "env" },
          { gate: "build", pass: true, details: "probe-6" });
        console.log(JSON.stringify(store.size()));
      `);
      const s2 = new VerdictStore(join(pDir, "verdicts"));
      expect(s2.size()).toBe(2);
      const e6Id = { gate: "build", tree: "tp6", command: "cmd", baseline: "base", environment: "env" };
      expect(s2.get(e6Id)?.details).toBe("probe-6"); // Newest answered after restart!
      const e4Id = { gate: "build", tree: "tp4", command: "cmd", baseline: "base", environment: "env" };
      expect(s2.get(e4Id)).toBeUndefined(); // Oldest evicted!
      const e5Id = { gate: "build", tree: "tp5", command: "cmd", baseline: "base", environment: "env" };
      expect(s2.get(e5Id)?.details).toBe("probe-5");
    } finally {
      resetVerdictCacheBoundForTests();
      now.mockRestore();
    }

    // 3. tip verify, merge-candidate full suite, and standalone verify reuse run verdict
    const repo = makeRepo({
      "src/index.ts": "export const x = 1;\n",
      "tests/index.test.ts": "import { x } from '../src/index.js';\ntest('ok', () => { expect(x).toBe(2); });\n",
      ".gitignore": "verify.log\n",
    });
    const baseRef = await gitHead(repo);
    writeFileSync(join(repo, "src/index.ts"), "export const x = 2;\n");
    commitAll(repo, "feature");

    const marker = join(repo, "verify.log");
    const commands = {
      build: `sh -c 'printf "build\\n" >> "${marker}"; exit 0' --`,
      test: `sh -c 'printf "test\\n" >> "${marker}"; exit 0' --`,
    };

    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    cfg.gates.build = commands.build;
    cfg.gates.test = commands.test;

    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `
gates:
  build: ${JSON.stringify(commands.build)}
  test: ${JSON.stringify(commands.test)}
`);
    const sdir = makeTestTempDir("tickmarkr-fake-");
    const baseline = await captureBaseline(repo, commands);
    const baselineFile = join(sdir, "base.json");
    writeFileSync(baselineFile, JSON.stringify(baseline));
    rmSync(marker, { force: true });

    const sfile = join(sdir, "s.json");
    writeFileSync(sfile, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [] }, review: { approve: true, issues: [] } }));
    const adapter = new FakeAdapter(sfile);

    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "hash" },
      tasks: [{
        id: "T1", title: "T1", goal: "T1", shape: "implement", complexity: 8,
        acceptance: ["passes"],
        gates: ["build", "test", "lint", "evidence", "scope"],
        files: ["src/**", "tests/**"],
      }],
    }).tasks[0];

    const checkouts = makeTestTempDir("tickmarkr-cache-worktrees-");
    const taskWorktree = join(checkouts, "run-1--T1");
    const integrationWorktree = join(checkouts, "run-1");
    for (const worktree of [taskWorktree, integrationWorktree]) {
      execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: repo });
    }
    expect(await getWorktreeTree(taskWorktree)).toBe(await getWorktreeTree(repo));
    expect(await getWorktreeTree(integrationWorktree)).toBe(await getWorktreeTree(repo));
    const tipJournal = Journal.create(repo, "run-1");
    tipJournal.append("run-start", undefined, { baseRef, commands, branch: "tickmarkr/run-1" });
    // Run gates with full suite (populates verdict store for tree)
    const runResult = await runGates(task, {
      worktree: taskWorktree, baseRef, artifactDir: tipJournal.dir,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels: [], adapters: [adapter], cfg,
    });
    expect(runResult.results.every((r) => r.pass)).toBe(true);
    const countAfterRun = readFileSync(marker, "utf8").trim().split("\n").length;
    expect(countAfterRun).toBe(2); // build and test ran once

    // a) Battery greens cannot answer tip verification, even at the identical tree.
    expect(await verifyIntegrationTipCached(integrationWorktree, commands, tipJournal, { baseline })).toBe(false);
    expect(readFileSync(marker, "utf8").trim().split("\n").length).toBe(countAfterRun + 2); // Tip scope ran both commands.
    const tipStore = new VerdictStore(join(repo, ".tickmarkr", "verdicts"));
    const tipId = await computeVerificationIdentity({ worktree: integrationWorktree, gate: "test", scope: "tip", command: commands.test, baseline, capacity: resolvedCapacity() });
    expect(tipStore.get(tipId!)?.pass).toBe(true);
    const tipRows = tipJournal.read().filter((e) => e.event === "tip-verify" && e.data.cached !== true);
    expect(tipRows.map((e) => e.data.gate).sort()).toEqual(["build", "test"]);
    expect(tipRows.every((e) => e.data.details === "exit 0")).toBe(true);

    // A fresh process in another checkout reuses the TIP test verdict, but must build its own outputs.
    const tipResults = freshProcess(`
      import { verifyIntegrationTip } from ${JSON.stringify(new URL("../../src/run/merge.ts", import.meta.url).href)};
      import { runWithVerificationBudget } from ${JSON.stringify(new URL("../../src/run/git.ts", import.meta.url).href)};
      const results = await runWithVerificationBudget(${JSON.stringify(resolvedCapacity())}, () =>
        verifyIntegrationTip(${JSON.stringify(taskWorktree)}, ${JSON.stringify(commands)}, ${JSON.stringify(tipJournal.dir)}, ${JSON.stringify(baseline)}));
      console.log(JSON.stringify(results));
    `) as Array<{ gate: string; details: string }>;
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(countAfterRun + 3);
    expect(tipResults.map((e) => e.gate).sort()).toEqual(["build", "test"]);
    expect(tipResults.find(e => e.gate === "test")?.details).toContain("reused tip verdict (identity:");
    expect(tipResults.find(e => e.gate === "build")?.details).toBe("exit 0");

    // Even deleting the store cannot displace the daemon's completed cycle cache.
    tipStore.clear();
    // Second cycle is the daemon's cycle cache
    expect(await verifyIntegrationTipCached(integrationWorktree, commands, tipJournal, { baseline })).toBe(false);
    const countAfterTip = readFileSync(marker, "utf8").trim().split("\n").length;
    expect(countAfterTip).toBe(countAfterRun + 3); // Still no new command ran!
    const cycleCachedRows = tipJournal.read().filter((e) => e.event === "tip-verify" && e.data.cached === true);
    expect(cycleCachedRows.map((e) => e.data.gate).sort()).toEqual(["build", "test"]);
    expect(tipJournal.read().filter((e) => e.event === "tip-verify-cached")).toHaveLength(1);
    // Restore a full battery entry after clearing the store for the cycle-cache check.
    await runGates(task, {
      worktree: taskWorktree, baseRef, artifactDir: tipJournal.dir,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels: [], adapters: [adapter], cfg,
    });
    // b) merge-candidate full suite reuses the run's verdict
    const selectScreen = await runGates(task, {
      worktree: taskWorktree, baseRef,
      author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
      result: { ok: true, summary: "", deviations: [], raw: "" },
      commands, baseline, channels: [], adapters: [adapter], cfg,
      selectTests: true,
    });
    const fullGate = selectScreen.results.find((r) => r.gate === "test")!;
    expect(fullGate.pass).toBe(true);
    expect(fullGate.meta?.fullSuite).toBe(true);
    expect(fullGate.details).toMatch(/reused/i);

    // c) Standalone must first execute, then reuse only its own greens.
    const countBeforeStandalone = readFileSync(marker, "utf8").trim().split("\n").length;
    const standalone = await verify(["--base", baseRef, "--no-review", "--no-acceptance", "--baseline", baselineFile, "--json"], repo);
    expect(standalone.code).toBe(0);
    const parsed = JSON.parse(standalone.out) as { results: Array<{ gate: string; details: string }> };
    const standaloneTools = parsed.results.filter((r) => r.gate === "build" || r.gate === "test");
    expect(standaloneTools.map((r) => r.gate).sort()).toEqual(["build", "test"]);
    expect(standaloneTools.every((r) => !r.details.includes("reused"))).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(countBeforeStandalone + 2);
    const again = await verify(["--base", baseRef, "--no-review", "--no-acceptance", "--baseline", baselineFile, "--json"], repo);
    expect(again.code).toBe(0);
    const reusedTools = JSON.parse(again.out).results.filter((r: { gate: string }) => ["build", "test"].includes(r.gate));
    expect(reusedTools).toHaveLength(2);
    expect(reusedTools.every((r: { details: string }) => r.details.includes("reused verdict (identity:"))).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(countBeforeStandalone + 2);
    const standaloneId = await computeVerificationIdentity({ worktree: repo, gate: "build", command: commands.build, baseline, scope: "standalone" });
    tipStore.set(standaloneId, { gate: "build", pass: false, details: "cached red" });
    const afterRed = await verify(["--base", baseRef, "--no-review", "--no-acceptance", "--baseline", baselineFile, "--json"], repo);
    expect(afterRed.code).toBe(0);
    expect(JSON.parse(afterRed.out).results.find((r: { gate: string }) => r.gate === "build").details).not.toContain("reused");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(countBeforeStandalone + 3);
    await assertCancelledTipWritesNothing();
    await assertScopeRedPolicies();
  }, 60_000);

  test("a daemon retry in a recreated checkout records a fresh deterministic build red and preserves the identical-failure policy without a free retry", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { files: ["code.txt", "ok.flag", "build.sh"] })],
      {
        tasks: {
          T1: [
            { shell: "rm -f ok.flag && echo c1 > code.txt && git add -A && git commit --no-gpg-sign -m c1", result: { ok: true, summary: "c1" } },
            { shell: "true", result: { ok: true, summary: "c1 unchanged" } },
          ],
        },
        consult: { action: "human", notes: "halt" },
      },
      `gates: { build: "sh build.sh" }`,
    );

    writeFileSync(join(repo, "build.sh"), "echo build >> marker.log\n[ -f ok.flag ] && exit 0 || exit 1\n");
    writeFileSync(join(repo, "ok.flag"), "ok\n");
    writeFileSync(join(repo, ".gitignore"), "marker.log\n");
    commitAll(repo, "ok-flag");

    const runId = "run-cached-red-test";
    setApprovalWindowForTests(1);
    try {
      await runDaemon(repo, { adapters: [fake], runId });
    } finally {
      resetApprovalWindowForTests();
    }

    const events = Journal.open(repo, runId).read();
    const gateResults = events.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "build");
    expect(gateResults.length).toBeGreaterThanOrEqual(2);

    const attempt0Result = gateResults.find((e) => e.data.attempt === 0)!;
    const attempt1Result = gateResults.find((e) => e.data.attempt === 1)!;
    expect(attempt1Result.data.pass).toBe(false);
    expect(attempt1Result.data.details).toBe(attempt0Result.data.details);
    expect(events.filter(e => e.event === "gate-reused-verdict" && e.taskId === "T1")).toEqual([]);
    expect(attempt1Result.data.evidenceReceipt).not.toEqual(attempt0Result.data.evidenceReceipt);
    expect(events.filter(e => e.event === "build-receipt" && e.taskId === "T1" && e.data.outcome === "started"))
      .toHaveLength(gateResults.length);
    expect(events.some(e => e.event === "gate-fingerprint-cap" && e.taskId === "T1" && e.data.gate === "build")).toBe(true);

    // Charges the round exactly the failure-policy rows a fresh red charges:
    const escalations = events.filter((e) => e.event === "escalation" && e.taskId === "T1");
    const attempt1Escalations = escalations.filter((e) => e.data.attempt === 2);
    expect(attempt1Escalations).toHaveLength(1);
  });
});


test("verification scope separates the four-part key and baseline timing does not change forgiveness identity", async () => {
  const repo = makeRepo({ "code.txt": "ok\n" });
  const baseline: Baseline = { commands: { test: { exitCode: 1, fingerprints: ["known"], durationMs: 10, ceilingMs: 30 } } };
  const measuredAgain: Baseline = { commands: { test: { ...baseline.commands.test!, durationMs: 20, ceilingMs: 60 } } };
  expect(baselineIdentity(measuredAgain)).toBe(baselineIdentity(baseline));
  expect(baselineIdentity({ commands: { test: { ...baseline.commands.test!, fingerprints: ["different"] } } })).not.toBe(baselineIdentity(baseline));
  const battery = await computeVerificationIdentity({ worktree: repo, gate: "test", command: "exit 0", baseline });
  const tip = await computeVerificationIdentity({ worktree: repo, gate: "test", command: "exit 0", baseline: measuredAgain, scope: "tip" });
  expect(verificationIdentityKey(tip!)).not.toBe(verificationIdentityKey(battery!));
  expect(tip!.environment).not.toBe(battery!.environment);
  const store = new VerdictStore(join(makeTestTempDir("tickmarkr-shared-key-"), "verdicts"));
  store.set(battery, { gate: "test", pass: true, details: "green" });
  expect(store.get(tip)).toBeUndefined();
});

test("a failed git identity computation never reads or writes a shared empty-tree verdict", async () => {
  const worktree = makeTestTempDir("tickmarkr-no-git-");
  const id = await computeVerificationIdentity({ worktree, gate: "build", command: "exit 0" });
  expect(id).toBeUndefined();
  const store = new VerdictStore(join(worktree, "verdicts"));
  expect(store.set(id, { gate: "build", pass: true, details: "green" })).toBe(false);
  expect(store.get(id)).toBeUndefined();
  expect(store.set({ tree: "", command: "exit 0", baseline: "none", environment: "env" }, { gate: "build", pass: true, details: "green" })).toBe(false);
  expect(store.size()).toBe(0);
});


test("tip verification reuses a manifested full-suite green recorded in tip scope", async () => {
  const repo = makeRepo({ "code.txt": "ok\n" });
  // No Vitest executable is installed in this checkout: a cache bypass would fail closed.
  const command = "vitest run";
  const journal = Journal.create(repo, "run-manifest-reuse");
  journal.append("run-start", undefined, { commands: { test: command } });
  const store = getVerdictStore(join(repo, ".tickmarkr"));
  const id = await computeVerificationIdentity({ worktree: repo, gate: "test", command, scope: "tip" });
  store.set(id, { gate: "test", pass: true, details: "all requested tests completed", meta: {
    source: "gate", runDir: journal.dir, processExit: 0, reportPath: "recorded-report.json", manifest: ["tests/a.test.ts"],
  } });
  const [hit] = await verifyIntegrationTip(repo, { test: command }, journal.dir);
  expect(hit!.pass).toBe(true);
  expect(hit!.details).toContain("reused tip verdict (identity:");
  expect(hit!.reportPath).toBe("recorded-report.json");
});

// R41: run one battery under an explicit process-scoped npm lifecycle policy, restoring the fork's env after.
async function underLifecycle<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.npm_config_ignore_scripts;
  if (value === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = value;
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = prior;
  }
}

test("the verification identity binds the protocol and the effective runner lifecycle policy: through runGates a green test verdict recorded under an explicit lifecycle hooks is reused by the next battery under hooks with its row naming protocol, lifecycle and source and is re-run under ignore-scripts, a red work verdict recorded under hooks is likewise reused under hooks and re-run under ignore-scripts, with no explicit export the policy is measured from npm's resolved config so rewriting the user npmrc between batteries re-runs the command while an explicit export naming the same effective policy reuses it, an unmeasurable policy is never stored, answered or compatible with itself, the environment fingerprint differs between two protocols or two lifecycles over otherwise identical parts and names both in its parts, and a stored record whose environment predates the stamp never answers the stamped identity, so a cache that reuses a verdict across protocols or effective lifecycles, a reuse that hides them, an unknown policy treated as comparable, or a pre-stamp entry answering a stamped lookup fails", async () => {
  for (const outcome of ["exit 0", "echo 'AssertionError: expected 1 to be 2'; exit 1"]) {
    const { task, ctx, store, calls } = await signalCacheFixture(false, outcome);
    const battery = () => runGates(task, ctx);
    const first = await underLifecycle("false", battery);
    const firstTest = first.results.find((r) => r.gate === "test")!;
    expect(firstTest.pass).toBe(outcome === "exit 0");
    expect(firstTest.meta?.reused).toBeUndefined();
    expect(calls()).toEqual(["full"]);
    expect(store.size()).toBe(1);

    const second = await underLifecycle("false", battery);
    const secondTest = second.results.find((r) => r.gate === "test")!;
    expect(secondTest.meta?.reused).toBe(true);
    expect(String(secondTest.meta?.reusedDetails)).toMatch(new RegExp(`protocol=${VERIFICATION_PROTOCOL}, lifecycle=hooks \\(explicit\\)\\]`));
    expect((secondTest.meta!.verificationIdentity as Record<string, unknown>).environment)
      .toBe((await computeVerificationIdentity({ worktree: ctx.worktree, gate: "test", command: ctx.commands.test!, baseline: ctx.baseline,
        capacity: resolvedCapacity(), verification: { protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" } }))!.environment);
    expect(calls()).toEqual(["full"]);

    const third = await underLifecycle("true", battery);
    const thirdTest = third.results.find((r) => r.gate === "test")!;
    expect(thirdTest.meta?.reused).toBeUndefined();
    expect(calls()).toEqual(["full", "full"]);
    expect(store.size()).toBe(2);
  }

  // The EFFECTIVE policy, not the env: with no explicit export the identity is measured from npm's
  // resolved config for the checkout, so rewriting the user npmrc between two batteries — no env
  // change, no tree change — re-runs the command, and an unmeasurable policy never caches at all.
  {
    const { task, ctx, store, calls } = await signalCacheFixture(false, "exit 0");
    const battery = () => runGates(task, ctx);
    const userconfig = join(makeTestTempDir("tickmarkr-npmrc-"), "npmrc");
    const setNpmrc = (body: string, mtimeSeconds: number) => { writeFileSync(userconfig, body); utimesSync(userconfig, mtimeSeconds, mtimeSeconds); };
    const priorUser = process.env.NPM_CONFIG_USERCONFIG;
    process.env.NPM_CONFIG_USERCONFIG = userconfig;
    try {
      setNpmrc("ignore-scripts=true\n", 1_700_000_000);
      const measuredIgnore = await underLifecycle(undefined, battery);
      const m1 = measuredIgnore.results.find((r) => r.gate === "test")!;
      expect(m1.meta?.reused).toBeUndefined();
      expect(await underLifecycle(undefined, async () => verificationProtocol(process.env, ctx.worktree))).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle: "ignore-scripts", source: "npm-config" });
      const measuredAgain = await underLifecycle(undefined, battery);
      expect(measuredAgain.results.find((r) => r.gate === "test")!.meta?.reused).toBe(true);
      expect(String(measuredAgain.results.find((r) => r.gate === "test")!.meta?.reusedDetails)).toMatch(/lifecycle=ignore-scripts \(npm-config\)\]/);
      expect(calls()).toEqual(["full"]);
      setNpmrc("ignore-scripts=false\n", 1_700_000_100);
      expect(await underLifecycle(undefined, async () => verificationProtocol(process.env, ctx.worktree))).toEqual({ protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "npm-config" });
      const measuredHooks = await underLifecycle(undefined, battery);
      expect(measuredHooks.results.find((r) => r.gate === "test")!.meta?.reused).toBeUndefined();
      expect(calls()).toEqual(["full", "full"]);
      // An explicit export names the same effective policy as the npmrc: the two are one identity.
      const explicitHooks = await underLifecycle("false", battery);
      expect(explicitHooks.results.find((r) => r.gate === "test")!.meta?.reused).toBe(true);
      expect(calls()).toEqual(["full", "full"]);
      expect(store.size()).toBe(2);
    } finally {
      if (priorUser === undefined) delete process.env.NPM_CONFIG_USERCONFIG; else process.env.NPM_CONFIG_USERCONFIG = priorUser;
    }
    // Unknown is never compatible — not with a matching unknown, not with anything.
    const unknown = { protocol: VERIFICATION_PROTOCOL, lifecycle: "unknown" as const, source: "unknown" as const };
    expect(sameVerification(unknown, unknown)).toBe(false);
    expect(sameVerification({ protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" }, unknown)).toBe(false);
    expect(sameVerification({ protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "npm-config" }, { protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" })).toBe(true);
    expect(sameVerification(undefined, { protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" })).toBe(false);
    const unknownId = { ...(await computeVerificationIdentity({ worktree: ctx.worktree, gate: "test", command: ctx.commands.test!, baseline: ctx.baseline,
      capacity: resolvedCapacity(), verification: unknown }))! };
    expect(store.set(unknownId, { gate: "test", pass: true, details: "exit 0" })).toBe(false);
    expect(store.get(unknownId)).toBeUndefined();
  }

  const parts = { nodeRuntime: "v1", lockfile: "l", capacity: { forkCap: 2, cores: 4 } };
  const current = environmentFingerprint(parts);
  expect(current.parts.verification).toEqual(verificationProtocol());
  const otherProtocol = environmentFingerprint({ ...parts, verification: { ...verificationProtocol(), protocol: "vl1.1" } });
  const otherLifecycle = environmentFingerprint({ ...parts, verification: { protocol: VERIFICATION_PROTOCOL, lifecycle: "hooks", source: "explicit" } });
  const sameAgain = environmentFingerprint({ ...parts, verification: verificationProtocol() });
  expect(otherProtocol.fingerprint).not.toBe(current.fingerprint);
  expect(otherLifecycle.fingerprint).not.toBe(environmentFingerprint({ ...parts, verification: { protocol: VERIFICATION_PROTOCOL, lifecycle: "ignore-scripts", source: "explicit" } }).fingerprint);
  expect(sameAgain.fingerprint).toBe(current.fingerprint);

  // A record written before the stamp keys on an environment fingerprint computed without it: the
  // stamped identity never resolves to that file, green or red, and nothing has to be deleted.
  const { ctx: legacyCtx, store: legacyStore, identity } = await signalCacheFixture(false, "exit 0");
  const preStamp = { ...identity, environment: "0123456789abcdef", envParts: undefined };
  expect(legacyStore.set(preStamp, { gate: "test", pass: true, details: "exit 0" })).toBe(true);
  expect(legacyStore.set({ ...preStamp, gate: "lint" }, { gate: "lint", pass: false, details: "AssertionError: legacy red" })).toBe(true);
  expect(legacyStore.get(identity)).toBeUndefined();
  expect(legacyStore.get({ ...identity, gate: "lint" })).toBeUndefined();
  expect(legacyStore.get(preStamp)?.pass).toBe(true);
  expect(legacyCtx.stateDir).toBeTruthy();
});

test("test: an explicitly funded rerun discards a cached red at the battery read plus the full suite read journaling each discard, whereas a cached green is still reused, so a red replayed from either cache fails", async () => {
  for (const outcome of ["exit 0", "echo 'AssertionError: still broken'; exit 1"]) {
    const { task, ctx, store, identity, calls } = await signalCacheFixture(true, outcome);
    ctx.commands.build = "true";
    ctx.cachedRedBypass = "operator-rerun";
    const journal = Journal.create(makeTestTempDir("tickmarkr-cache-journal-"), `run-funded-cache-${outcome === "exit 0" ? "green" : "red"}`);
    ctx.onGate = (e) => { if (e.phase === "note") journal.append(e.name, task.id, e.payload); };
    const buildId = await computeVerificationIdentity({ worktree: ctx.worktree, gate: "build", command: "true",
      baseline: ctx.baseline, capacity: resolvedCapacity() });
    store.set(buildId, { gate: "build", pass: false, details: "old build red" });
    store.set(identity, { gate: "test", pass: false, details: "old full suite red" });
    const first = await runGates(task, ctx);
    expect(first.results.find((r) => r.gate === "build")?.pass).toBe(true);
    expect(first.results.find((r) => r.gate === "test")?.pass).toBe(outcome === "exit 0");
    expect(calls()).toEqual(["selected", "full"]);
    expect(journal.read().filter((e) => e.event === "gate-rerun").map((e) => e.data)).toEqual([
      { gate: "build", reason: "cached-red-discarded", bypass: "operator-rerun" },
      { gate: "test", reason: "cached-red-discarded", bypass: "operator-rerun" },
    ]);
    if (outcome === "exit 0") {
      const second = await runGates(task, ctx);
      expect(second.results.find((r) => r.gate === "test")?.meta?.reused).toBe(true);
      expect(calls()).toEqual(["selected", "full"]);
      expect(journal.read().filter((e) => e.event === "gate-rerun")).toHaveLength(2);
      expect(journal.read().filter((e) => e.event === "gate-reused-verdict").map((e) => e.data.gate))
        .toEqual(expect.arrayContaining(["build", "test"]));
    }
  }
});


// Snapshot bytes as well as filenames: reuse must not rewrite a receipt or mint an artifact.
function cacheEvidenceBytes(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).sort().map(file => [file, readFileSync(join(dir, file)).toString("base64")]));
}

test("test: a per gate persisted hit reused in a fresh process carries the original receipt invocation id plus origin run root under a reused marker, so a reuse that mints a new invocation or drops the receipt fails", async () => {
  const repo = makeRepo({ ".gitignore": "calls.log\n" });
  const commands = { build: "echo build >> calls.log; echo original-output" };
  const original = Journal.create(repo, "run-original-receipt");
  original.append("run-start", undefined, { commands });
  const [fresh] = await verifyIntegrationTip(repo, commands, original.dir);
  expect(fresh!.evidenceReceipt?.invocationId).toBeTruthy();
  expect(fresh!.originRunRoot).toBe(original.dir);
  const store = getVerdictStore(join(repo, ".tickmarkr"));
  const beforeStore = cacheEvidenceBytes(store.dir);
  const beforeEvidence = cacheEvidenceBytes(join(original.dir, "gate-evidence"));
  const next = Journal.create(repo, "run-reusing-receipt");
  next.append("run-start", undefined, { commands });
  const reused = freshProcess(`
    import { verifyIntegrationTip } from ${JSON.stringify(new URL("../../src/run/merge.ts", import.meta.url).href)};
    import { runWithVerificationBudget } from ${JSON.stringify(new URL("../../src/run/git.ts", import.meta.url).href)};
    console.log(JSON.stringify(await runWithVerificationBudget(${JSON.stringify(resolvedCapacity())}, () =>
      verifyIntegrationTip(${JSON.stringify(repo)}, ${JSON.stringify(commands)}, ${JSON.stringify(next.dir)}))));
  `) as TipVerifyResult[];
  expect(reused).toHaveLength(1);
  expect(reused[0]).toMatchObject({ reused: true, originRunRoot: original.dir,
    evidenceReceipt: fresh!.evidenceReceipt, evidenceReceipts: fresh!.evidenceReceipts });
  expect(reused[0]!.evidenceReceipt).toEqual(fresh!.evidenceReceipt);
  expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("build\n");
  expect(cacheEvidenceBytes(store.dir)).toEqual(beforeStore);
  expect(cacheEvidenceBytes(join(original.dir, "gate-evidence"))).toEqual(beforeEvidence);
  expect(existsSync(join(next.dir, "gate-evidence"))).toBe(false);

  // A daemon cycle populated from the persisted hit must carry the same evidence too.
  for (let cycle = 0; cycle < 2; cycle++) {
    expect(await verifyIntegrationTipCached(repo, commands, next)).toBe(false);
    expect(next.read().filter(e => e.event === "tip-verify").at(-1)!.data).toMatchObject({
      cached: true, reused: true, originRunRoot: original.dir, evidenceReceipt: fresh!.evidenceReceipt,
    });
  }
  expect(cacheEvidenceBytes(store.dir)).toEqual(beforeStore);
  expect(cacheEvidenceBytes(join(original.dir, "gate-evidence"))).toEqual(beforeEvidence);
  expect(existsSync(join(next.dir, "gate-evidence"))).toBe(false);
  expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("build\n");
});

test("test: whole cycle cached rows carry their original receipts unchanged while the store's no re-execution contract holds byte for byte, so a reuse projection that re-executes or rewrites evidence fails", async () => {
  const repo = makeRepo({ ".gitignore": "calls.log\n" });
  const commands = { build: "echo build >> calls.log; echo build-output", lint: "echo lint >> calls.log; echo lint-output >&2" };
  const journal = Journal.create(repo, "run-cycle-receipts");
  journal.append("run-start", undefined, { commands });
  expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
  const originals = journal.read().filter(e => e.event === "tip-verify");
  expect(originals).toHaveLength(2);
  for (const row of originals) expect(row.data.evidenceReceipt).toBeDefined();
  const store = getVerdictStore(join(repo, ".tickmarkr"));
  const beforeStore = cacheEvidenceBytes(store.dir);
  const beforeEvidence = cacheEvidenceBytes(join(journal.dir, "gate-evidence"));
  for (let cycle = 0; cycle < 2; cycle++) {
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    const rows = journal.read().filter(e => e.event === "tip-verify").slice(-2);
    for (const [index, row] of rows.entries()) {
      expect(row.data).toMatchObject({ cached: true, reused: true, originRunRoot: journal.dir });
      expect(row.data.evidenceReceipt).toEqual(originals[index]!.data.evidenceReceipt);
      expect(row.data.evidenceReceipts).toEqual(originals[index]!.data.evidenceReceipts);
    }
    expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("build\nlint\n");
    expect(cacheEvidenceBytes(store.dir)).toEqual(beforeStore);
    expect(cacheEvidenceBytes(join(journal.dir, "gate-evidence"))).toEqual(beforeEvidence);
  }
});

test("test: a historical cached result without a receipt reuses as absent evidence fabricating none, so a backfilled or invented receipt on reuse fails", async () => {
  const repo = makeRepo({ ".gitignore": "calls.log\n" });
  const commands = { build: "echo unexpected >> calls.log" };
  const journal = Journal.create(repo, "run-historical-receipt");
  journal.append("run-start", undefined, { commands });
  const store = getVerdictStore(join(repo, ".tickmarkr"));
  const id = await computeVerificationIdentity({ worktree: repo, gate: "build", scope: "tip", command: commands.build });
  store.set(id, { gate: "build", pass: true, details: "historical green" });
  const beforeStore = cacheEvidenceBytes(store.dir);
  const [hit] = await verifyIntegrationTip(repo, commands, journal.dir);
  expect(hit).toMatchObject({ pass: true, reused: true, evidenceAbsence: "historical-cache" });
  expect(hit!.evidenceReceipt).toBeUndefined();
  expect(hit!.evidenceReceipts).toBeUndefined();
  expect(hit!.originRunRoot).toBeUndefined();

  // Seed an actual pre-receipt cycle; both repeated cycle reuse and persisted reuse are covered.
  const tip = await gitHead(repo);
  const cmdHash = commandsHash(commands);
  journal.append("tip-verify", undefined, { gate: "build", cmd: commands.build, pass: true, exitCode: 0, tip, cmdHash });
  expect(cacheEvidenceBytes(store.dir)).toEqual(beforeStore);
  store.clear(); // Only the historical cycle can answer now; executing would create calls.log.
  for (let cycle = 0; cycle < 2; cycle++) {
    expect(await verifyIntegrationTipCached(repo, commands, journal)).toBe(false);
    const row = journal.read().filter(e => e.event === "tip-verify").at(-1)!;
    expect(row.data).toMatchObject({ cached: true, reused: true, evidenceAbsence: "historical-cache" });
    for (const key of ["evidenceReceipt", "evidenceReceipts", "originRunRoot", "nonce"]) expect(row.data[key]).toBeUndefined();
  }
  expect(Object.keys(beforeStore)).toHaveLength(1);
  expect(cacheEvidenceBytes(store.dir)).toEqual({});
  expect(existsSync(join(repo, "calls.log"))).toBe(false);
  expect(existsSync(join(journal.dir, "gate-evidence"))).toBe(false);
});

test("test: a reused verdict retains its original receipt bound to its origin run root and the cache's no re-execution contract holds byte for byte, so a reuse that mints a fresh execution or resolves a foreign reference against the current run fails", async () => {
  const repo = makeRepo({ ".gitignore": "calls.log\n" });
  const commands = { build: "echo build >> calls.log; echo bound-output" };
  const original = Journal.create(repo, "run-bound-origin");
  original.append("run-start", undefined, { commands });
  const [fresh] = await verifyIntegrationTip(repo, commands, original.dir);
  expect(fresh).toMatchObject({ pass: true, originRunRoot: original.dir });
  const freshReceipt = fresh!.evidenceReceipt!;
  const store = getVerdictStore(join(repo, ".tickmarkr"));
  const beforeStore = cacheEvidenceBytes(store.dir);
  const beforeEvidence = cacheEvidenceBytes(join(original.dir, "gate-evidence"));
  expect(Object.keys(beforeEvidence)).toHaveLength(2);

  const next = Journal.create(repo, "run-bound-reuser");
  next.append("run-start", undefined, { commands });
  for (let cycle = 0; cycle < 2; cycle++) {
    expect(await verifyIntegrationTipCached(repo, commands, next)).toBe(false);
    const row = next.read().filter(e => e.event === "tip-verify").at(-1)!;
    expect(row.data).toMatchObject({ cached: true, reused: true, originRunRoot: original.dir });
    expect(row.data.evidenceReceipt).toEqual(freshReceipt);
    // The retained receipt resolves against the run root that minted it — verified bytes, hash and all…
    // The root is the caller's trust anchor and is handed in canonical form; the resolver itself follows no link.
    const resolved = resolveReceiptArtifacts(row.data.evidenceReceipt as typeof freshReceipt, realpathSync(row.data.originRunRoot as string));
    expect(resolved).toEqual([
      { ok: true, path: freshReceipt.stdout.path, sha256: freshReceipt.stdout.sha256 },
      { ok: true, path: freshReceipt.stderr.path, sha256: freshReceipt.stderr.sha256 },
    ]);
    // …and the same reference is a FOREIGN one under the reusing run, which owns no such bytes.
    expect(resolveReceiptArtifacts(freshReceipt, realpathSync(next.dir)).map(r => r.ok ? "available" : r.reason)).toEqual(["missing", "missing"]);
  }
  // No fresh execution was minted: the command ran once, nothing under either run root changed.
  expect(readFileSync(join(repo, "calls.log"), "utf8")).toBe("build\n");
  expect(cacheEvidenceBytes(store.dir)).toEqual(beforeStore);
  expect(cacheEvidenceBytes(join(original.dir, "gate-evidence"))).toEqual(beforeEvidence);
  expect(existsSync(join(next.dir, "gate-evidence"))).toBe(false);
});

test("test: the daemon's gate row for a task gate verdict reused from the store in a fresh process carries the original receipt invocation id and origin run root under the reused marker, so a reused row with no receipt or a newly minted one fails", async () => {
  const { repo, fake, scriptPath } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: 'echo one > t1.txt && git add t1.txt && git commit --no-gpg-sign -m one', result: { ok: true, summary: "one" } }] },
  }, 'gates: { lint: "echo original-lint-output" }\n');
  const graphPath = join(repo, ".tickmarkr", "graph.json");
  const graph = readFileSync(graphPath);
  await runDaemon(repo, { adapters: [fake], runId: "run-task-receipt-source", approvalWindowMs: 0 });
  const original = Journal.open(repo, "run-task-receipt-source");
  const fresh = original.read().find(e => e.event === "gate-result" && e.data.gate === "lint")!;
  expect(fresh.data.evidenceReceipt).toBeDefined();
  const before = cacheEvidenceBytes(join(original.dir, "gate-evidence"));
  writeFileSync(graphPath, graph);
  // A separate Node process must read the persisted verdict, with no in-memory result to borrow.
  execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", `
    import { runDaemon } from ${JSON.stringify(new URL("../../src/run/daemon.ts", import.meta.url).href)};
    import { FakeAdapter } from ${JSON.stringify(new URL("../../src/adapters/fake.ts", import.meta.url).href)};
    await runDaemon(${JSON.stringify(repo)}, { adapters: [new FakeAdapter(${JSON.stringify(scriptPath)})],
      runId: "run-task-receipt-reused", approvalWindowMs: 0 });
  `], { encoding: "utf8", timeout: 90_000 });
  const reused = Journal.open(repo, "run-task-receipt-reused").read()
    .find(e => e.event === "gate-result" && e.data.gate === "lint")!;
  expect(reused.data).toMatchObject({ reused: true, originRunRoot: original.dir,
    evidenceReceipt: fresh.data.evidenceReceipt, evidenceReceipts: fresh.data.evidenceReceipts });
  expect(reused.data.evidenceReceipt).toEqual(fresh.data.evidenceReceipt);
  expect(cacheEvidenceBytes(join(original.dir, "gate-evidence"))).toEqual(before);
}, 120_000);

test("test: the gate battery invalidates recreated-checkout build identity while retaining unchanged-checkout reuse across process restart plus existing lint/test identity, so a process-only generation or wholesale cache disabling fails", async () => {
  const { createWorktree } = await import("../../src/run/git.js");
  const repo = makeRepo({ "source.txt": "base", ".gitignore": ".tickmarkr/\ndist/\n" });
  const baseRef = await gitHead(repo);
  writeFileSync(join(repo, "source.txt"), "task");
  commitAll(repo, "task");
  const head = await gitHead(repo);
  const worktree = await createWorktree(repo, "incarnation-battery", head);
  const task = T("T1", { gates: ["build", "test", "lint"] });
  const ctx: GateContext = {
    worktree, baseRef, commands: { build: "mkdir -p dist; echo built > dist/output", test: "test -f dist/output", lint: "true" },
    baseline: { commands: {} }, author: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" },
    result: { ok: true, summary: "done", deviations: [], raw: "" }, channels: [], adapters: [], cfg: DEFAULT_CONFIG,
    stateDir: join(repo, ".tickmarkr"),
  };
  const first = await runGates(task, ctx);
  expect(first.results.every(r => r.pass)).toBe(true);
  const restarted = freshProcess(`
    import { runGates } from ${JSON.stringify(new URL("../../src/gates/run-gates.ts", import.meta.url).href)};
    import { runWithVerificationBudget } from ${JSON.stringify(new URL("../../src/run/git.ts", import.meta.url).href)};
    console.log(JSON.stringify(await runWithVerificationBudget(${JSON.stringify(resolvedCapacity())}, () => runGates(${JSON.stringify(task)}, ${JSON.stringify(ctx)}))));
  `) as Awaited<ReturnType<typeof runGates>>;
  for (const gate of ["build", "test", "lint"]) {
    expect(restarted.results.find(r => r.gate === gate)).toMatchObject({ pass: true, meta: { reused: true } });
  }
  const keys = async () => Promise.all(["build", "test", "lint"].map(async gate => verificationIdentityKey((await computeVerificationIdentity({ worktree, gate, command: ctx.commands[gate]! }))!)));
  const before = await keys();
  expect(await createWorktree(repo, "incarnation-battery", head)).toBe(worktree);
  expect(await gitHead(worktree)).toBe(head);
  expect(existsSync(join(worktree, "dist/output"))).toBe(false);
  const after = await keys();
  expect(after[0]).not.toBe(before[0]);
  expect(after.slice(1)).toEqual(before.slice(1));
  const fresh = await runGates(task, ctx);
  const build = fresh.results.find(r => r.gate === "build")!;
  expect(build.pass).toBe(true);
  expect(build.meta?.reused).not.toBe(true);
  expect(build.evidenceReceipt?.invocationId).not.toBe(first.results.find(r => r.gate === "build")!.evidenceReceipt?.invocationId);
  expect(existsSync(join(worktree, "dist/output"))).toBe(true);
  for (const gate of ["test", "lint"]) expect(fresh.results.find(r => r.gate === gate)?.meta?.reused).toBe(true);
}, 60_000);

test("test: standalone verify plus the integration tip verifier retain a fresh failing build receipt after checkout recreation instead of the former green, so either entry point borrowing the dead checkout build fails", async () => {
  const { createWorktree } = await import("../../src/run/git.js");
  const flag = join(makeTestTempDir("incarnation-failure-"), "fail");
  const command = `if [ -f '${flag}' ]; then echo 'source.ts(1,1): error TS9999: fresh build failed'; exit 1; fi; mkdir -p dist; echo built > dist/output`;
  const repo = makeRepo({ "source.txt": "base", ".gitignore": ".tickmarkr/\ndist/\n" });
  writeFileSync(join(repo, "source.txt"), "task");
  commitAll(repo, "task");
  // Keep main at the baseline so standalone verification has a real diff.
  execFileSync("git", ["branch", "-f", "base", "HEAD~1"], { cwd: repo });
  const head = await gitHead(repo);
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr/config.yaml"), `gates:\n  build: ${JSON.stringify(command)}\n`);
  const worktree = await createWorktree(repo, "incarnation-verifiers", head);
  const args = ["--base", "base", "--no-review", "--json"];
  const green = JSON.parse((await verify(args, worktree)).out);
  expect(green.green).toBe(true);
  const commands = { build: command };
  const journal = Journal.create(repo, "run-incarnation-tip");
  journal.append("run-start", undefined, { commands });
  const [tipGreen] = await verifyIntegrationTip(worktree, commands, journal.dir);
  expect(tipGreen?.pass).toBe(true);
  expect((await verifyIntegrationTip(worktree, commands, journal.dir))[0]?.reused).toBe(true);
  expect(JSON.parse((await verify(args, worktree)).out).results.find((r: { gate: string }) => r.gate === "build").meta.reused).toBe(true);
  await createWorktree(repo, "incarnation-verifiers", head);
  expect(existsSync(join(worktree, "dist/output"))).toBe(false);
  writeFileSync(flag, "fail");
  const red = JSON.parse((await verify(args, worktree)).out);
  expect(red.green).toBe(false);
  const build = red.results.find((r: { gate: string }) => r.gate === "build");
  expect(build.meta?.reused).not.toBe(true);
  expect(build.evidenceReceipt.termination).toMatchObject({ kind: "exit", exitCode: 1 });
  expect(build.evidenceReceipt.invocationId).not.toBe(green.results.find((r: { gate: string }) => r.gate === "build").evidenceReceipt.invocationId);
  expect(build.meta?.classification).toBe("regression");
  const [tipRed] = await verifyIntegrationTip(worktree, commands, journal.dir);
  expect(tipRed).toMatchObject({ pass: false, exitCode: 1 });
  expect(tipRed?.reused).not.toBe(true);
  expect(tipRed?.cause).toBe("regression");
  expect(tipRed?.evidenceReceipt?.termination).toMatchObject({ kind: "exit", exitCode: 1 });
  expect(tipRed?.evidenceReceipt?.invocationId).not.toBe(tipGreen?.evidenceReceipt?.invocationId);
}, 60_000);
