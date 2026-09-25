import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { Slot } from "../../src/drivers/types.js";
import { runGates } from "../../src/gates/run-gates.js";
import { VITEST_CACHE_ENV } from "../../src/gates/test-manifest.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const root = process.cwd();
const install = realpathSync(join(root, "node_modules"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const files = ["tests/ordinary.test.ts", "tests/cockpit/sweep.test.ts", "tests/cockpit/keys.test.ts", "tests/cli/bin.test.ts", "tests/run/reconcile-live.test.ts"];
function seed(repo: string) {
  cpSync(join(root, "src"), join(repo, "src"), { recursive: true });
  cpSync(join(root, "vitest.config.ts"), join(repo, "vitest.config.ts"));
  writeFileSync(join(repo, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8") + "\nnode_modules\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests/setup.ts"), "");
  for (const file of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), 'import { test, expect } from "vitest"; test("cache probe", () => expect(1).toBe(1));\n');
  }
  writeFileSync(join(repo, "cache-reporter.mjs"), `
    import { writeFileSync } from 'node:fs';
    export default class {
      onInit(ctx) { this.ctx = ctx; }
      onTestRunEnd() {
        writeFileSync(process.env.CACHE_RECORD, JSON.stringify({
          exported: process.env.${VITEST_CACHE_ENV},
          root: this.ctx.vite.config.cacheDir, cache: this.ctx.config.cache,
          projects: this.ctx.projects.map(p => ({ name: p.name, dir: p.vite.config.cacheDir,
            cache: p.config.cache, single: p.config.poolOptions?.forks?.singleFork === true }))
        }));
      }
    }
  `);
}
function results(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? results(join(dir, e.name)) : e.name === "results.json" ? [join(dir, e.name)] : []);
}
const args = [join(install, "vitest/vitest.mjs"), "run", "--configLoader", "runner", "--reporter", "./cache-reporter.mjs"];
async function run(repo: string, record: string, extra: string[] = [], cache?: string) {
  const env = { ...process.env, CACHE_RECORD: record, VITEST_MAX_FORKS: "1" };
  delete env[VITEST_CACHE_ENV];
  if (cache) env[VITEST_CACHE_ENV] = cache;
  const out = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [...args, ...extra], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", d => output += d); p.stderr.on("data", d => output += d);
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("error", e => { clearTimeout(timer); reject(e); });
    p.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  expect(out.code, out.output).toBe(0);
  return JSON.parse(readFileSync(record, "utf8"));
}
function assertLocal(record: any, repo: string, base = join(repo, ".vitest-cache")) {
  if (existsSync(repo) && base.startsWith(repo + "/")) base = realpathSync(repo) + base.slice(repo.length);
  expect(record.root === base || record.root.startsWith(base + "/"), JSON.stringify(record)).toBe(true);
  expect(record.projects.map((p: any) => p.name)).toEqual(["suite", "sync-heavy", "keys-ledger", "built-cli", "signal-reaper"]);
  for (const p of record.projects) {
    expect(p.dir === base || p.dir.startsWith(base + "/"), p.dir).toBe(true);
    expect(p.single).toBe(p.name !== "suite");
  }
}

test("test: the production daemon launches real Vitest with the production Vitest configuration into its own worktree cache across root plus serial projects versus direct invocation defaulting locally, so an unconsumed exported path fails", async () => {
  const evidence = makeTestTempDir("cache-evidence-");
  const record = join(evidence, "worker.json");
  const command = `CACHE_RECORD=${shq(record)} ${[process.execPath, ...args].map(shq).join(" ")} && echo changed > worker.txt && ${COMMIT} cache-worker`;
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: command, result: { ok: true, summary: "done" } }] } }, 'gates: { build: "true", test: "true", lint: "true" }\n');
  seed(repo);
  symlinkSync(install, join(repo, "node_modules"), "dir");
  git(repo, "add", "-A"); git(repo, "commit", "--no-gpg-sign", "-m", "cache fixture");
  let worker = "";
  let workerPhysical = "";
  let workerResults: string[] = [];
  class Driver extends SubprocessDriver {
    override async run(slot: Slot, cmd: string) {
      if (slot.name.includes("-worker-")) { worker = slot.cwd; workerPhysical = realpathSync(slot.cwd); }
      return super.run(slot, cmd);
    }
    override async close(slot: Slot) {
      if (slot.cwd === worker) workerResults = results(join(worker, ".vitest-cache"));
      return super.close(slot);
    }
  }
  const outcome = await runDaemon(repo, { adapters: [fake], driver: new Driver(), runId: "run-cache" });
  expect(outcome.done, JSON.stringify(outcome)).toEqual(["T1"]);
  const observed = JSON.parse(readFileSync(record, "utf8"));
  expect(observed.exported).toBe(join(worker, ".vitest-cache"));
  assertLocal(observed, workerPhysical);
  expect(workerResults.length).toBeGreaterThan(0);
  const direct = await run(repo, join(evidence, "direct.json"));
  expect(direct.exported).toBeUndefined();
  assertLocal(direct, repo);
  expect(results(join(repo, ".vitest-cache")).length).toBeGreaterThan(0);
}, 90_000);

test("test: the production Vitest configuration preserves disabled caching plus project membership while rebasing an inherited foreign cache path into the current worktree, so a parent environment escaping cache isolation fails", async () => {
  const repo = realpathSync(makeRepo({ "base.txt": "base" })); seed(repo);
  symlinkSync(install, join(repo, "node_modules"), "dir");
  const evidence = makeTestTempDir("cache-disabled-");
  const foreign = join(evidence, "foreign", ".vitest-cache");
  const disabled = await run(repo, join(evidence, "disabled.json"), ["--no-cache"], foreign);
  assertLocal(disabled, repo);
  expect(disabled.cache).toBe(false);
  // Vitest applies --no-cache at the root results writer.
  expect(results(join(repo, ".vitest-cache"))).toEqual([]);
  const enabled = await run(repo, join(evidence, "enabled.json"), [], foreign);
  assertLocal(enabled, repo);
  expect(results(join(repo, ".vitest-cache")).length).toBeGreaterThan(0);
  expect(existsSync(foreign)).toBe(false);
  const custom = join(realpathSync(repo), ".vitest-cache", "explicit");
  assertLocal(await run(repo, join(evidence, "custom.json"), [], custom), repo, custom);
  expect(results(custom).length).toBeGreaterThan(0);
}, 90_000);

test("test: the gate battery writes initial plus recovered Vitest results beneath each of two worktrees sharing the shared dependency directory, so either invocation writing into the shared dependency tree fails", async () => {
  const repo = realpathSync(makeRepo({ "base.txt": "base" })); seed(repo);
  const evidence = realpathSync(makeTestTempDir("cache-gates-"));
  // Run real Vitest in both phases; inject only a stranded serial-project certificate after
  // the initial process exits. The retry must discover and execute those files itself.
  writeFileSync(join(repo, "vitest.mjs"), `
    import { spawnSync } from 'node:child_process';
    import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
    import { join } from 'node:path';
    const argv = process.argv.slice(2), listing = argv[0] === 'list';
    const log = join(${JSON.stringify(evidence)}, process.cwd().split('/').pop() + '.json');
    const rows = existsSync(log) ? JSON.parse(readFileSync(log)) : [];
    const child = spawnSync(process.execPath, [${JSON.stringify(join(install, "vitest/vitest.mjs"))}, ...argv], { stdio: 'inherit' });
    const cache = process.env.${VITEST_CACHE_ENV};
    function scan(dir) { return existsSync(dir) ? readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? scan(join(dir,e.name)) : e.name === 'results.json' ? [{path:join(dir,e.name), mtime:statSync(join(dir,e.name)).mtimeMs, content:JSON.parse(readFileSync(join(dir,e.name)))}] : []) : []; }
    rows.push({ listing, cache, results: scan(cache || 'missing') }); writeFileSync(log, JSON.stringify(rows));
    if (child.status !== 0 || listing) process.exit(child.status ?? 1);
    if (rows.filter(r => !r.listing).length === 1) {
      const file = process.env.TICKMARKR_TEST_REPORT, report = JSON.parse(readFileSync(file));
      for (const [name, scheduled] of Object.entries(report.scheduling)) if (scheduled.singleFork) { delete report.started[name]; delete report.completed[name]; }
      report.certificate.exitCode = 1; report.certificate.errors = 1;
      report.certificate.diagnostics = ['Error: [vitest-worker]: Timeout calling "onTaskUpdate"'];
      writeFileSync(file, JSON.stringify(report)); process.exit(1);
    }
  `);
  git(repo, "add", "-A"); git(repo, "commit", "--no-gpg-sign", "-m", "cache fixture");
  const base = git(repo, "rev-parse", "HEAD");
  for (const name of ["one", "two"]) {
    const wt = join(evidence, name);
    git(repo, "worktree", "add", "-b", name, wt);
    symlinkSync(install, join(wt, "node_modules"), "dir");
    expect(realpathSync(join(wt, "node_modules"))).toBe(install);
    writeFileSync(join(wt, "base.txt"), name); git(wt, "add", "base.txt"); git(wt, "commit", "--no-gpg-sign", "-m", name);
    const task = validateGraph({ version: 1, spec: { source: "native", paths: ["base.txt"], hash: "h" }, tasks: [T("T1", { gates: ["build", "test", "lint", "evidence", "scope"], files: ["**"] })] }).tasks[0];
    const command = "node vitest.mjs run --configLoader runner";
    const outcome = await runGates(task, { worktree: wt, baseRef: base,
      author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
      result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: command },
      baseline: { commands: { test: { cmd: command, exitCode: 0, fingerprints: [], ceilingMs: 30_000 } } },
      channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: evidence,
    });
    const row = outcome.results.find(r => r.gate === "test")!;
    expect(row, JSON.stringify(outcome)).toBeDefined();
    expect(row.pass, row.details).toBe(true);
    const rows = JSON.parse(readFileSync(join(evidence, name + ".json"), "utf8"));
    const runs = rows.filter((r: any) => !r.listing);
    expect(runs).toHaveLength(2);
    expect(runs[1].results.some((r: any) => r.mtime > runs[0].results.find((before: any) => before.path === r.path)?.mtime)).toBe(true);
    for (const r of rows) {
      expect(r.cache).toBe(join(wt, ".vitest-cache"));
      if (!r.listing) {
        expect(r.results.length).toBeGreaterThan(0);
        for (const result of r.results) expect(result.path.startsWith(join(wt, ".vitest-cache") + "/")).toBe(true);
      }
    }
    expect(git(wt, "status", "--porcelain")).toBe("");
  }
}, 90_000);
