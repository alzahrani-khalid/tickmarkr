import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { verify, baselineCachePath } from "../../src/cli/commands/verify.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { inventoryDependencyLinks, linkNodeModules } from "../../src/run/git.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
afterEach(() => vi.restoreAllMocks());

function workspace() {
  const repo = realpathSync(makeRepo({
    ".gitignore": "node_modules\n.tickmarkr/\n",
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"], scripts: { build: "node packages/app/check.cjs" } }),
    "packages/app/package.json": JSON.stringify({ name: "app", dependencies: { "@fixture/sibling": "*" } }),
    "packages/app/check.cjs": "const fs = require('node:fs'); if (process.argv[2]) fs.appendFileSync(process.argv[2], 'ran\\n'); if (require('@fixture/sibling') !== 'clean') throw Error('planted sibling error');\n",
    "packages/sibling/package.json": JSON.stringify({ name: "@fixture/sibling", main: "index.cjs" }),
    "packages/sibling/index.cjs": "module.exports = 'clean';\n",
  }));
  const parent = realpathSync(makeTestTempDir("hermetic-workspace-"));
  const worktree = join(parent, "task");
  const baseRef = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "--detach", worktree, "HEAD");
  mkdirSync(join(repo, "node_modules/@fixture"), { recursive: true });
  symlinkSync("../../packages/sibling", join(repo, "node_modules/@fixture/sibling"), "dir");
  linkNodeModules(repo, worktree);
  const marker = join(parent, "commands-ran");
  const commands = { build: `node packages/app/check.cjs ${shq(marker)}`, test: `node packages/app/check.cjs ${shq(marker)}` };
  const runDir = join(parent, "run");
  mkdirSync(runDir);
  return { repo, worktree, baseRef, marker, commands, runDir, target: join(repo, "packages/sibling") };
}

async function battery(worktree: string, baseRef: string, commands: Record<string, string>, stateDir: string, events: GateEvent[] = []) {
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "x" },
    tasks: [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"] })] }).tasks[0]!;
  return runGates(task, { worktree, baseRef, commands, stateDir,
    author: { adapter: "fake", model: "fake", channel: "sub", tier: "frontier" },
    result: { ok: true, summary: "done", deviations: [], raw: "" },
    baseline: { commands: {} }, channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG),
    onGate: event => { events.push(event); },
  });
}

function namesOutside(details: string, target: string) {
  expect(details).toContain("OBS-1118");
  expect(details).toContain(`node_modules/@fixture/sibling -> ${target}`);
}

test("test: through the gate battery a task worktree of a two package workspace fixture whose planted error sits in its own sibling package while the main checkout's copy is clean is refused before build naming the dependency link and its main checkout target, so a battery that runs the clean main copy green fails", async () => {
  const f = workspace();
  writeFileSync(join(f.worktree, "packages/sibling/index.cjs"), "module.exports = 'planted error';\n");
  git(f.worktree, "add", "packages/sibling/index.cjs");
  git(f.worktree, "commit", "--no-gpg-sign", "-m", "plant sibling error");
  // The vulnerable command is green even from the task checkout; its own sibling is red.
  execFileSync(process.execPath, ["packages/app/check.cjs"], { cwd: f.worktree });
  expect(execFileSync(process.execPath, ["-e", "process.stdout.write(require('./packages/sibling/index.cjs'))"], { cwd: f.worktree, encoding: "utf8" })).toBe("planted error");
  const events: GateEvent[] = [];
  const result = await battery(f.worktree, f.baseRef, f.commands, f.runDir, events);
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({ gate: "build", pass: false, meta: { infra: true } });
  namesOutside(result.results[0]!.details, f.target);
  expect(events).toContainEqual(expect.objectContaining({ phase: "end", result: result.results[0] }));
  expect(events).toContainEqual(expect.objectContaining({ phase: "note", name: "build-receipt", payload: expect.objectContaining({ outcome: "refused", confirmedStart: false }) }));
  expect(existsSync(f.marker)).toBe(false);
});

test("test: tip verify on an integration worktree whose workspace link resolves into the main checkout records a refusal naming that link and no passing tip row, so a tip battery that tests the main checkout's package fails", async () => {
  const f = workspace();
  const results = await verifyIntegrationTip(f.worktree, f.commands, f.runDir);
  expect(results).toHaveLength(2);
  for (const row of results) {
    expect(row).toMatchObject({ pass: false, cause: "infra", evidenceAbsence: "not-started" });
    namesOutside(row.details, f.target);
    expect(readFileSync(row.artifact!, "utf8")).toContain(row.details);
  }
  expect(existsSync(f.marker)).toBe(false);
});

test("test: standalone verify refuses a base worktree whose workspace link resolves outside it before capturing a baseline, so a baseline measured against the main checkout's package fails", async () => {
  const f = workspace();
  // Direct capture also refuses and produces no forgivable measurements or receipts.
  const baseline = await captureBaseline(f.worktree, f.commands);
  namesOutside(baseline.refusal!, f.target);
  expect(baseline.commands.build).toMatchObject({ infra: true, invalidCause: "infra", fingerprints: [] });
  expect(baseline.commands.build!.exitCode).toBeUndefined();
  expect(baseline.commands.build!.durationMs).toBeUndefined();
  expect(baseline.evidenceReceipts).toBeUndefined();
  git(f.repo, "checkout", "-b", "feature");
  writeFileSync(join(f.repo, "feature.txt"), "change\n");
  git(f.repo, "add", "feature.txt");
  git(f.repo, "commit", "--no-gpg-sign", "-m", "feature");
  // Main's link is local to main, but becomes outside when linked into the detached base.
  expect(inventoryDependencyLinks(f.repo)[0]!.classification).toBe("worktree");
  const command = `node packages/app/check.cjs ${shq(f.marker)}`;
  mkdirSync(join(f.repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(f.repo, ".tickmarkr/config.yaml"), `gates:\n  build: ${JSON.stringify(command)}\n`);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await verify(["--base", "main", "--no-review", "--no-acceptance"], f.repo);
  expect(result.code).not.toBe(0);
  namesOutside(result.out, f.target);
  expect(existsSync(f.marker)).toBe(false);
  expect(existsSync(baselineCachePath(f.repo, f.baseRef, { build: command }))).toBe(false);
});

test("test: a worktree whose links resolve inside itself or inside the real dependency directory and a repository with no dependency directory run their batteries exactly as today, so a refusal of an installed or in tree link fails", async () => {
  const f = workspace();
  rmSync(join(f.repo, "node_modules/@fixture/sibling"));
  symlinkSync(join(f.worktree, "packages/sibling"), join(f.repo, "node_modules/@fixture/sibling"), "dir");
  mkdirSync(join(f.repo, "node_modules/.store/installed"), { recursive: true });
  symlinkSync(".store/installed", join(f.repo, "node_modules/installed"), "dir");
  expect(inventoryDependencyLinks(f.worktree)).toEqual([
    { link: "@fixture/sibling", target: join(f.worktree, "packages/sibling"), classification: "worktree" },
    { link: "installed", target: join(f.repo, "node_modules/.store/installed"), classification: "node_modules" },
  ]);
  const empty = realpathSync(makeRepo({ ".gitignore": "node_modules\n.tickmarkr/\n", "file.txt": "base\n" }));
  expect(inventoryDependencyLinks(empty)).toEqual([]);
  for (const cwd of [f.worktree, empty]) {
    rmSync(f.marker, { force: true });
    const commands = cwd === empty ? { build: `echo ran >> ${shq(f.marker)}` } : f.commands;
    const baseRef = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, "change.txt"), "committed work\n");
    git(cwd, "add", "change.txt");
    git(cwd, "commit", "--no-gpg-sign", "-m", "work");
    const baseline = await captureBaseline(cwd, commands);
    expect(baseline.refusal).toBeUndefined();
    expect(Object.values(baseline.commands).every(entry => entry.exitCode === 0)).toBe(true);
    const gates = await battery(cwd, baseRef, commands, join(f.runDir, cwd === empty ? "empty" : "installed"));
    expect(gates.results.every(row => row.pass)).toBe(true);
    const tip = await verifyIntegrationTip(cwd, commands, f.runDir);
    expect(tip.every(row => row.pass)).toBe(true);
    expect(readFileSync(f.marker, "utf8").trim().split("\n")).toHaveLength(Object.keys(commands).length * 3);
  }
});

test("dependency inventory names every package link, respects path boundaries, and stops below scoped packages", async () => {
  const f = workspace();
  const adjacent = `${f.worktree}-other`;
  mkdirSync(adjacent);
  symlinkSync(adjacent, join(f.repo, "node_modules/plain"), "dir");
  mkdirSync(join(f.repo, "node_modules/@fixture/installed"));
  symlinkSync(adjacent, join(f.repo, "node_modules/@fixture/installed/nested"), "dir");
  expect(inventoryDependencyLinks(f.worktree)).toEqual([
    { link: "@fixture/sibling", target: f.target, classification: "outside" },
    { link: "plain", target: adjacent, classification: "outside" },
  ]);
  const result = await battery(f.worktree, f.baseRef, f.commands, f.runDir);
  namesOutside(result.results[0]!.details, f.target);
  expect(result.results[0]!.details).toContain(`node_modules/plain -> ${adjacent}`);
  expect(result.results[0]!.details).not.toContain("nested");
  expect(existsSync(f.marker)).toBe(false);
});

test("a cached green battery and tip cannot bypass a changed dependency-link inventory", async () => {
  const f = workspace();
  const link = join(f.repo, "node_modules/@fixture/sibling");
  rmSync(link);
  symlinkSync(join(f.worktree, "packages/sibling"), link, "dir");
  writeFileSync(join(f.worktree, "change.txt"), "work\n");
  git(f.worktree, "add", "change.txt");
  git(f.worktree, "commit", "--no-gpg-sign", "-m", "work");
  const first = await battery(f.worktree, f.baseRef, f.commands, f.runDir);
  expect(first.results.every(row => row.pass)).toBe(true);
  expect((await verifyIntegrationTip(f.worktree, f.commands, f.runDir)).every(row => row.pass)).toBe(true);
  rmSync(f.marker);
  rmSync(link);
  symlinkSync(f.target, link, "dir");
  const second = await battery(f.worktree, f.baseRef, f.commands, f.runDir);
  expect(second.results[0]).toMatchObject({ pass: false, meta: { infra: true } });
  namesOutside(second.results[0]!.details, f.target);
  const tip = await verifyIntegrationTip(f.worktree, f.commands, f.runDir);
  expect(tip.every(row => !row.pass && row.cause === "infra")).toBe(true);
  expect(existsSync(f.marker)).toBe(false);
});
