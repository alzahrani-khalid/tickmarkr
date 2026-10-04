// Slowest-runner note: all deadlines below bound fixture setup/cleanup on the slowest runner.
// Barriers and injected clocks decide admission/service; elapsed wall time never proves fairness.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { evaluateManifestedTest, resetHangClocksForTests, setHangClocksForTests } from "../../src/gates/test-manifest.js";
import { runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import * as execution from "../../src/run/execution-budget.js";
import { COMMAND_LEASE_TOKEN_ENV, CommandLeases, readHolder, REPOSITORY_LEASE_TOKEN_ENV, repositoryLeasePath, runWithCommandLease, withRepositoryLease } from "../../src/run/lease.js";
import { processIdentity } from "../../src/run/git.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { resetVerificationJobClockForTests, setVerificationJobClockForTests, VERIFICATION_JOB_TOKEN_ENV, type VerificationJobReport } from "../../src/run/verification-job.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const signals = new AsyncLocalStorage<AbortSignal>();
const owned = new Set<ChildProcess>();
const fixtures: Fixture[] = [];
beforeEach(() => {
  // These fixtures own root jobs; the enclosing suite's command capability is unrelated.
  vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined);
  vi.spyOn(execution, "executionSignal").mockImplementation(() => signals.getStore());
});
afterEach(async () => {
  for (const child of owned) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const f of fixtures) for (const row of f.rows()) { try { process.kill(-row.pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all([...owned].map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(r => child.once("exit", r))));
  owned.clear(); fixtures.length = 0;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetVerificationJobClockForTests(); resetHangClocksForTests();
});
const until = async (ready: () => boolean, what: string) => {
  const deadline = Date.now() + 60_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`fixture did not reach ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};
interface Row { phase: string; pid: number; token: string; holder: { pid: number; identity: string; token: string }; files: string[] }
interface Fixture { repo: string; base: string; artifacts: string; path: string; rows: () => Row[]; release: (phase: string) => void }
async function fixture(stranded = true, held: string[] = []): Promise<Fixture> {
  const repo = makeRepo({ ".gitignore": "node_modules/\n", "package.json": '{"scripts":{"test":"vitest run"}}', "src/a.ts": "export const a = 1;\n" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  // Mandatory evidence/scope screening requires a real committed candidate ahead of base.
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-qm", "fixture candidate"], { cwd: repo });
  const artifacts = makeTestTempDir("verification-job-proof-");
  const path = await repositoryLeasePath(repo);
  const log = join(artifacts, "runner.jsonl");
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/vitest"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = ${JSON.stringify(artifacts)}, lease = ${JSON.stringify(path)};
const all = ['tests/parallel.test.ts','tests/serial.test.ts'];
const continuation = args.some(a => a.endsWith('serial.test.ts'));
const phase = args[0] === 'list' ? (continuation ? 'continuation-discovery' : 'discovery') : (continuation ? 'continuation' : 'first-pass');
const files = continuation ? all.slice(1) : all;
// runGates also lists the current full manifest after the owned job has released its reservation.
if (args[0] === 'list' && !process.env.${VERIFICATION_JOB_TOKEN_ENV}) { console.log(JSON.stringify(files.map(file => ({file:path.resolve(file)})))); process.exit(0); }
const holder = JSON.parse(fs.readFileSync(lease, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase, files, pid: process.pid, token: process.env.${REPOSITORY_LEASE_TOKEN_ENV}, holder }) + '\\n');
async function main() {
  if (phase === 'first-pass') fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify({ nonce: process.env.TICKMARKR_TEST_NONCE, requested: files, started: {[files[0]]: Date.now()}, completed: {} }));
  if (${JSON.stringify(held)}.includes(phase)) await new Promise(resolve => { const poll = setInterval(() => { if (fs.existsSync(path.join(root, phase + '.release'))) { clearInterval(poll); resolve(); } }, 20); });
  if (args[0] === 'list') { console.log(JSON.stringify(files.map(file => ({ file: path.resolve(file) })))); return; }
  const now = Date.now(), pending = ${stranded} && !continuation;
  const present = pending ? all.slice(0,1) : files;
  const report = { nonce: process.env.TICKMARKR_TEST_NONCE, requested: files,
    scheduling: Object.fromEntries(files.map(f => [f,{pool:'forks',singleFork:f.includes('serial')}])),
    started: Object.fromEntries(present.map(f => [f,now])),
    completed: Object.fromEntries(present.map(f => [f,{at:now,status:'passed',tests:{passed:1,failed:0,skipped:0}}])),
    certificate: {at:now,exitCode:pending?1:0,errors:pending?1:0,diagnostics:pending?['Error: [vitest-worker]: Timeout calling "onTaskUpdate"']:[]} };
  fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT,JSON.stringify(report));
  if (${JSON.stringify(held)}.includes('first-pass-completion') && phase === 'first-pass') {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase: 'first-pass-completion', files, pid: process.pid, token: process.env.${REPOSITORY_LEASE_TOKEN_ENV}, holder }) + '\\n');
    await new Promise(resolve => { const poll = setInterval(() => { if (fs.existsSync(path.join(root, 'first-pass-completion.release'))) { clearInterval(poll); resolve(); } }, 20); });
  }
  process.exitCode = pending ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`, { mode: 0o755 });
  const f = { repo, base, artifacts, path, rows: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Row) : [],
    release: (phase: string) => writeFileSync(join(artifacts, `${phase}.release`), "") };
  fixtures.push(f); return f;
}
const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" }, tasks: [{
  id: "T1", title: "verification", goal: "verification", shape: "implement", complexity: 3, gates: ["build", "test", "lint", "evidence", "scope"], acceptance: ["done"], files: ["**"],
}] }).tasks[0]!;
async function taskGate(f: Fixture) {
  const out = await runGates(task, { worktree: f.repo, baseRef: f.base, author: { adapter: "fake", model: "fake", tier: "mid", channel: "sub" },
    result: { ok: true, summary: "done", deviations: [], raw: "" }, commands: { test: "vitest run" }, baseline: { commands: {} } as import("../../src/gates/baseline.js").Baseline, channels: [], adapters: [], cfg: structuredClone(DEFAULT_CONFIG), artifactDir: f.artifacts });
  return out.results.find(row => row.gate === "test")!;
}
const jobOf = (reportPath: string) => JSON.parse(readFileSync(`${reportPath}.job.json`, "utf8")) as VerificationJobReport;

test("test: production manifested task gates enforce the closed job table reservation through discovery first pass and one continuation for direct entry versus the existing standalone wrapper", async () => {
  for (const wrapper of [false, true]) {
    const f = await fixture(true, ["discovery", "first-pass", "continuation"]);
    const leases = new CommandLeases(); let reservations = 0;
    const context = <T>(run: () => Promise<T>) => runWithCommandLease((command, callback) => {
      // Listing-only freshness checks are separate from the single full-job reservation.
      if (command === "vitest run") reservations++;
      return leases.run(() => callback("task-capability"), () => {}, 20);
    }, run);
    const running = context(() => wrapper ? withRepositoryLease(f.repo, () => taskGate(f), { pollMs: 20 }) : taskGate(f));
    await until(() => f.rows().some(row => row.phase === "discovery"), "owned discovery");
    const holder = readHolder(f.path)!;
    expect(holder).toMatchObject({ pid: process.pid, identity: await processIdentity(process.pid) });
    const waitProof = join(f.artifacts, "external-wait.json"), admissionProof = join(f.artifacts, "external-admission.json");
    const module = new URL("../../src/run/lease.ts", import.meta.url).href;
    const outsider = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {writeFileSync} from 'node:fs';
      import {withRepositoryLease, readHolder} from ${JSON.stringify(module)};
      await withRepositoryLease(${JSON.stringify(f.repo)}, async () => {
        writeFileSync(${JSON.stringify(admissionProof)}, JSON.stringify(readHolder(${JSON.stringify(f.path)})));
      }, {inherited:'',pollMs:20,onWait: holder => writeFileSync(${JSON.stringify(waitProof)},JSON.stringify(holder))});
    `], { env: { ...process.env, [REPOSITORY_LEASE_TOKEN_ENV]: "" }, stdio: "ignore" });
    owned.add(outsider);
    const outsideExit = new Promise<number | null>(r => outsider.once("exit", r));
    await until(() => existsSync(waitProof), "external cooperating waiter");
    expect(JSON.parse(readFileSync(waitProof, "utf8"))).toMatchObject({ pid: holder.pid, identity: holder.identity, token: holder.token });
    for (const phase of ["discovery", "first-pass", "continuation"]) {
      await until(() => f.rows().some(row => row.phase === phase), phase);
      expect(readHolder(f.path)?.token).toBe(holder.token); expect(existsSync(admissionProof)).toBe(false);
      f.release(phase);
    }
    const row = await running; expect(await outsideExit).toBe(0);
    expect(JSON.parse(readFileSync(admissionProof, "utf8")).token).not.toBe(holder.token);
    expect(row.pass, row.details).toBe(true); expect(reservations).toBe(1);
    expect(new Set(f.rows().map(row => row.token))).toEqual(new Set([holder.token]));
    expect(existsSync(f.path)).toBe(false);
  }
}, 180_000);

test("test: production verification enforces the closed capability table so a second concurrent job in the same process cannot reenter using the first job token versus its authorized descendant", async () => {
  const f = await fixture(false, ["first-pass"]);
  let stale = "";
  await withRepositoryLease(f.repo, async () => { stale = readHolder(f.path)!.token; }, { pollMs: 20 });
  const first = evaluateManifestedTest("vitest run", f.repo, { artifactDir: f.artifacts });
  await until(() => f.rows().some(row => row.phase === "first-pass"), "first job admission");
  const holder = readHolder(f.path)!;
  expect(process.env[REPOSITORY_LEASE_TOKEN_ENV]).not.toBe(holder.token);
  // This is a real descendant of the first runner, carrying exactly its generation. A sibling
  // below uses the same bytes but has no private async authority or ancestor-holder relationship.
  const module = new URL("../../src/run/lease.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {withRepositoryLease} from ${JSON.stringify(module)};
    await withRepositoryLease(${JSON.stringify(f.repo)}, async () => { process.stdout.write('authorized'); }, {pollMs:20});
  `], { env: { ...process.env, [REPOSITORY_LEASE_TOKEN_ENV]: holder.token }, stdio: ["ignore", "pipe", "pipe"] });
  owned.add(child);
  let output = ""; child.stdout!.on("data", bytes => { output += bytes; });
  await new Promise(resolve => child.once("exit", resolve)); expect(output).toBe("authorized");
  const foreignFixture = await fixture(false);
  let foreignToken = ""; let releaseForeign!: () => void;
  const foreign = withRepositoryLease(foreignFixture.repo, () => {
    foreignToken = readHolder(foreignFixture.path)!.token;
    return new Promise<void>(r => { releaseForeign = r; });
  }, { pollMs: 20 });
  await until(() => !!foreignToken, "live foreign capability");
  try {
  const saved = process.env[REPOSITORY_LEASE_TOKEN_ENV];
  process.env[REPOSITORY_LEASE_TOKEN_ENV] = holder.token;
  const others = ["forged", stale, foreignToken, holder.token].map(token => withRepositoryLease(f.repo, async () => readHolder(f.path)!.token, { isolated: true, inherited: token, pollMs: 20 }));
  const secondArtifacts = makeTestTempDir("second-job-");
  const second = evaluateManifestedTest("vitest run", f.repo, { artifactDir: secondArtifacts });
  if (saved === undefined) delete process.env[REPOSITORY_LEASE_TOKEN_ENV]; else process.env[REPOSITORY_LEASE_TOKEN_ENV] = saved;
  await until(() => { const name = requireReport(secondArtifacts); return !!name && !!(JSON.parse(readFileSync(join(secondArtifacts, name), "utf8")) as VerificationJobReport).waitingOn; }, "second job refused first token reentry");
  expect(readHolder(f.path)?.token).toBe(holder.token);
  expect(f.rows().filter(row => row.phase === "discovery")).toHaveLength(1);
  f.release("first-pass"); expect((await first).pass).toBe(true);
  const tokens = await Promise.all(others); expect(tokens).not.toContain(holder.token); expect(new Set(tokens).size).toBe(4);
  expect((await second).pass).toBe(true); expect(existsSync(f.path)).toBe(false);
  } finally { releaseForeign(); await foreign; }
}, 180_000);

test("test: production verification cancellation at discovery first-pass completion and continuation releases only owned generations after child reaping while owner death protects a live orphan tree from new admission", async () => {
  for (const phase of ["discovery", "first-pass-completion", "continuation"]) {
    const f = await fixture(true, [phase]); const controller = new AbortController();
    const running = signals.run(controller.signal, () => taskGate(f));
    await until(() => f.rows().some(row => row.phase === phase), phase);
    const token = readHolder(f.path)!.token;
    const cancelledWaiter = new AbortController(); let cancelledEntered = false;
    const wait = withRepositoryLease(f.repo, async () => { cancelledEntered = true; }, { signal: cancelledWaiter.signal, inherited: "", pollMs: 20 });
    const rejection = expect(wait).rejects.toThrow("waiter cancelled"); cancelledWaiter.abort(new Error("waiter cancelled")); await rejection;
    expect(cancelledEntered).toBe(false); expect(readHolder(f.path)?.token).toBe(token);
    let survivors: number[] = [];
    const next = withRepositoryLease(f.repo, async () => { survivors = f.rows().filter(row => { try { process.kill(row.pid, 0); return true; } catch { return false; } }).map(row => row.pid); }, { inherited: "", pollMs: 20 });
    controller.abort(new Error("job cancelled")); const row = await running; await next;
    expect(row.pass).toBe(false); expect(survivors).toEqual([]); expect(existsSync(f.path)).toBe(false);
  }
  const f = await fixture(false, ["first-pass"]);
  const module = new URL("../../src/gates/test-manifest.ts", import.meta.url).href;
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {evaluateManifestedTest} from ${JSON.stringify(module)};
    await evaluateManifestedTest('vitest run',${JSON.stringify(f.repo)},{artifactDir:${JSON.stringify(f.artifacts)}});
  `], { stdio: "ignore", env: { ...process.env, [REPOSITORY_LEASE_TOKEN_ENV]: "" } });
  owned.add(owner);
  await until(() => f.rows().some(row => row.phase === "first-pass"), "orphan tree started");
  const old = readHolder(f.path)!; const exited = new Promise(r => owner.once("exit", r)); owner.kill("SIGKILL"); await exited;
  let admitted = false; let waited = false;
  const next = withRepositoryLease(f.repo, async () => { admitted = true; expect(readHolder(f.path)?.token).not.toBe(old.token); }, { inherited: "", pollMs: 20, onWait: h => { expect(h.token).toBe(old.token); waited = true; } });
  await until(() => waited, "dead-owner live-orphan protection"); expect(admitted).toBe(false);
  const unfinished = JSON.parse(readFileSync(join(f.artifacts, requireReport(f.artifacts)), "utf8")) as VerificationJobReport;
  expect(unfinished.releasedAt).toBeUndefined();
  f.release("first-pass"); await next; expect(admitted).toBe(true); expect(existsSync(f.path)).toBe(false);
}, 240_000);

function requireReport(root: string): string {
  return readdirSync(root).find(file => file.endsWith(".job.json"))!;
}

test("test: production verification releases before unrelated infrastructure retry so an older queued task is admitted after at most one continuation rather than bypassed by a second full job", async () => {
  const f = await fixture(true, ["continuation"]);
  const order: string[] = [];
  const leases = new CommandLeases();
  const context = <T>(run: () => Promise<T>) => runWithCommandLease((_, callback) => leases.run(() => callback(), () => {}, 20), run);
  const first = context(() => taskGate(f));
  await until(() => f.rows().some(row => row.phase === "continuation"), "one continuation");
  const olderArtifacts = makeTestTempDir("older-job-");
  const older = context(async () => { const out = await evaluateManifestedTest("vitest run", f.repo, { artifactDir: olderArtifacts }); order.push("older"); return out; });
  await until(() => { const name = requireReport(olderArtifacts); return !!name && (JSON.parse(readFileSync(join(olderArtifacts, name), "utf8")) as VerificationJobReport).state === "queued"; }, "older job queued before release");
  f.release("continuation"); await first;
  const unrelatedRetry = context(async () => { const out = await evaluateManifestedTest("vitest run", f.repo, { artifactDir: makeTestTempDir("new-full-job-"), allowStrandedRecovery: false }); order.push("retry"); return out; });
  await older; await unrelatedRetry; expect(order).toEqual(["older", "retry"]);
  const tokens = f.rows().filter(row => row.phase === "discovery").map(row => row.token);
  expect(new Set(tokens).size).toBe(3); expect(f.rows().filter(row => row.phase === "continuation")).toHaveLength(2);
  expect(existsSync(f.path)).toBe(false);
}, 180_000);

test("test: production task and integration-tip manifest callers record the closed timing table across queued completed continued cancelled and overrun jobs", async () => {
  let now = 10_000; setVerificationJobClockForTests(() => now);
  for (const tip of [false, true]) for (const continued of [false, true]) {
    const f = await fixture(continued, ["first-pass"]);
    let release!: () => void; let admitted = false;
    const held = withRepositoryLease(f.repo, () => { admitted = true; return new Promise<void>(r => { release = r; }); }, { pollMs: 20 });
    await until(() => admitted, "queue holder");
    const running = tip ? verifyIntegrationTip(f.repo, { test: "vitest run" }, f.artifacts) : taskGate(f);
    await until(() => requireReport(f.artifacts) !== undefined, "queued producer report");
    const queued = JSON.parse(readFileSync(join(f.artifacts, requireReport(f.artifacts)), "utf8")) as VerificationJobReport;
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    expect(queued).toMatchObject({ state: "queued", queuedAt: 10_000, subject: { commit: candidate }, scope: "vitest run", reason: "manifest verification", phases: [] });
    now += 1_000_000; release(); await held;
    await until(() => f.rows().some(row => row.phase === "first-pass"), "post-admission first pass");
    now += 50; f.release("first-pass"); const raw = await running; const row = Array.isArray(raw) ? raw[0]! : raw;
    expect(row.pass, row.details).toBe(true);
    const reportPath = "reportPath" in row ? row.reportPath! : ("meta" in row ? row.meta!.reportPath : undefined) as string;
    const report = jobOf(reportPath); expect(report.admittedAt).toBeGreaterThan(report.queuedAt);
    expect(report.releasedAt).toBeGreaterThanOrEqual(report.phases.at(-1)!.endedAt!);
    expect(report.state).toBe("completed"); expect(report.phases.map(p => p.phase)).toEqual(continued ? ["discovery", "first-pass", "continuation-discovery", "continuation"] : ["discovery", "first-pass"]);
    for (const phase of report.phases) { expect(phase.startedAt).toBeGreaterThanOrEqual(report.admittedAt!); expect(phase.endedAt).toBeGreaterThanOrEqual(phase.startedAt!); }
    if (continued) expect(report.phases.at(-1)!.parentNonce).toBe(report.phases[1]!.nonce);
    now = 10_000;
  }
  const f = await fixture(false, ["first-pass"]); const controller = new AbortController();
  const cancelled = signals.run(controller.signal, () => evaluateManifestedTest("vitest run", f.repo, { artifactDir: f.artifacts }));
  await until(() => f.rows().some(row => row.phase === "first-pass"), "cancellable admitted job");
  now += 30; controller.abort(new Error("cancelled")); const out = await cancelled; const report = jobOf(out.reportPath);
  expect(report.state).toBe("cancelled"); expect(report.reapedAt).toBeLessThanOrEqual(report.releasedAt!); expect(out.pass).toBe(false);
  // The injected post-admission overrun is a real report start, with the host's hang clock
  // advanced beyond its budget. The million-ms queue jump above incurred no child service.
  let wall = Date.now(), mono = 0; setHangClocksForTests({ wall: () => wall, mono: () => mono });
  const overrun = await fixture(false, ["first-pass"]);
  const job = evaluateManifestedTest("vitest run", overrun.repo, { artifactDir: overrun.artifacts, overallCeilingMs: 60_000 });
  await until(() => overrun.rows().some(row => row.phase === "first-pass"), "overrun admission");
  // The command ceiling itself remains admission-started; cancelling records non-green cleanup.
  wall = Date.now() + 1_000_000; mono += 1_000_000;
  const result = await job;
  expect(result.pass).toBe(false); expect(result.details).toContain("infra hang");
  expect(jobOf(result.reportPath).state).toBe("failed");
  expect(jobOf(result.reportPath).admittedAt).toBeDefined();
}, 240_000);
