// OBS-880 suite (2) / OBS-1071: the production Vitest configuration's suite lease hook
// (scripts/vitest-lease.ts), exercised through real Vitest processes over fixture repositories.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { discoverTestManifest } from "../../src/gates/test-manifest.js";
import { COMMAND_LEASE_TOKEN_ENV, REPOSITORY_LEASE_TOKEN_ENV, readHolder, repositoryLeasePath, withRepositoryLease } from "../../src/run/lease.js";
import { isListingInvocation, stopOwnedRunners } from "../../scripts/vitest-lease.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const root = process.cwd();
const VITEST = join(root, "node_modules/vitest/vitest.mjs");
const WAITING = "waits for this repository's runner lease";
const PROBE = "tests/probe.test.ts";
const PROBE_SOURCE = `
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
const env = process.env;
const log = (row) => appendFileSync(env.PROBE_LOG, JSON.stringify({ ...row, name: env.PROBE_NAME, pid: process.pid, at: Date.now() }) + "\\n");
const running = (pid) => { try { return !execFileSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).trim().startsWith("Z"); } catch { return false; } };
const until = async (ready, ms) => { const end = Date.now() + ms; while (!ready()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 50)); } return true; };
test("lease probe", async () => {
  let lease = "";
  try { lease = resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), "tickmarkr-runner.lease"); } catch {}
  const leased = () => lease && existsSync(lease) ? JSON.parse(readFileSync(lease, "utf8")).token : null;
  log({ event: "start", token: env.${REPOSITORY_LEASE_TOKEN_ENV} ?? null, lease: leased(), survivors: (env.PROBE_GONE ?? "").split(",").filter(Boolean).filter(running) });
  if (env.PROBE_SLEEPER) log({ event: "sleeper", child: spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" }).pid });
  if (env.PROBE_RENDEZVOUS) {
    appendFileSync(resolve(env.PROBE_RENDEZVOUS, env.PROBE_NAME), "");
    log({ event: "rendezvous", met: await until(() => env.PROBE_PARTNERS.split(",").every(p => existsSync(resolve(env.PROBE_RENDEZVOUS, p))), 30000) });
  }
  if (env.PROBE_NESTED) {
    // A nested mutation runner: the environment filtered as a manifested gate child filters it.
    const child = { ...env, PROBE_NAME: env.PROBE_NESTED };
    for (const key of ["VITEST", "TEST", "VITEST_WORKER_ID", "VITEST_POOL_ID", "${COMMAND_LEASE_TOKEN_ENV}", "PROBE_NESTED", "PROBE_HOLD", "PROBE_HOLD_MS", "PROBE_SLEEPER", "PROBE_GONE", "PROBE_CANCEL_NESTED"]) delete child[key];
    const nested = spawn(process.execPath, [env.PROBE_VITEST, "run", "--configLoader", "runner", "${PROBE}"], { env: child, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    nested.stdout.on("data", d => { output += d; });
    nested.stderr.on("data", d => { output += d; });
    const code = await new Promise(r => { const t = setTimeout(() => { nested.kill("SIGKILL"); r("deadlocked"); }, 40000); nested.on("close", c => { clearTimeout(t); r(c); }); });
    log({ event: "nested", code, output, lease: leased() });
    if (env.PROBE_CANCEL_NESTED) {
      const active = spawn(process.execPath, [env.PROBE_VITEST, "run", "--configLoader", "runner", "${PROBE}"],
        { env: { ...child, PROBE_NAME: "active-nested", PROBE_HOLD: env.PROBE_CANCEL_NESTED, PROBE_SLEEPER: "1" }, stdio: "ignore" });
      log({ event: "active-nested", child: active.pid });
    }
  }
  if (env.PROBE_HOLD) await until(() => existsSync(env.PROBE_HOLD), 60000);
  if (env.PROBE_HOLD_MS) await new Promise(r => setTimeout(r, Number(env.PROBE_HOLD_MS)));
  log({ event: "end", lease: leased() });
}, 120000);
`;

type Row = { event: string; name: string; pid: number; at: number; token?: string | null; lease?: string | null; code?: unknown; output?: string; met?: boolean; child?: number; survivors?: string[] };
const rows = (log: string): Row[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Row) : [];
const until = async (ready: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

/** A repository carrying the production config and hook; `src` and `node_modules` link to this checkout. */
function fixtureRepo(): string {
  const files: Record<string, string> = { "package.json": JSON.stringify({ type: "module" }), "tests/setup.ts": "", [PROBE]: PROBE_SOURCE,
    ".gitignore": "node_modules\nsrc\n.vitest-cache\n" };
  for (const file of ["vitest.config.ts", "scripts/vitest-lease.ts"]) files[file] = readFileSync(join(root, file), "utf8");
  const repo = makeRepo(files);
  linkDeps(repo);
  return repo;
}
function linkDeps(dir: string) {
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  symlinkSync(join(root, "src"), join(dir, "src"), "dir");
}
function worktree(repo: string, name: string): string {
  const dir = join(makeTestTempDir(`lease-${name}-`), name);
  execFileSync("git", ["worktree", "add", "--detach", "-q", dir], { cwd: repo });
  linkDeps(dir);
  return dir;
}

interface Runner { child: ChildProcess; out: () => string; exit: Promise<number | null> }
const runners = new Set<Runner>();
// Test-only containment: even a failed assertion or broken production exit hook must not leave
// fixture runners alive. Each fixture coordinator owns a separate process group, including forks.
afterEach(async () => {
  for (const r of runners) {
    try { process.kill(-r.child.pid!, "SIGKILL"); } catch { /* group already gone */ }
  }
  await Promise.all([...runners].map(r => r.exit));
  runners.clear();
});
function vitest(cwd: string, name: string, log: string, extra: NodeJS.ProcessEnv = {}, args = ["run", "--configLoader", "runner", PROBE]): Runner {
  const env: NodeJS.ProcessEnv = { ...process.env, PROBE_LOG: log, PROBE_NAME: name, PROBE_VITEST: VITEST, VITEST_MAX_FORKS: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of ["VITEST", "TEST", "VITEST_WORKER_ID", "VITEST_POOL_ID", REPOSITORY_LEASE_TOKEN_ENV, COMMAND_LEASE_TOKEN_ENV]) delete env[key];
  const child = spawn(process.execPath, [VITEST, ...args], { cwd, env: { ...env, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", d => { out += d; });
  child.stderr!.on("data", d => { out += d; });
  const exit = new Promise<number | null>(resolve => child.on("close", resolve));
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }, 90_000);
  void exit.then(() => clearTimeout(timer));
  const runner = { child, out: () => out, exit };
  runners.add(runner);
  return runner;
}
const passed = async (r: Runner) => { const code = await r.exit; expect(code, r.out()).toBe(0); };
/** A waiter shows the holder it queued behind and never starts its test body; then it is cancelled. */
async function waits(r: Runner, log: string, name: string) {
  await until(() => r.out().includes(WAITING), 30_000, `${name} to report waiting:\n${r.out()}`);
  await new Promise(res => setTimeout(res, 300));
  expect(rows(log).filter(row => row.name === name)).toEqual([]);
  r.child.kill("SIGKILL");
  await r.exit;
}

test("test: repository-configured worker/reviewer/gate Vitest serializes same-repository runners versus independent repositories running together, with listing-only discoverTestManifest/vitest list or repository-less cwds taking no lease, so a listing blocked on its parent lease fails", async () => {
  const log = join(makeTestTempDir("lease-log-"), "rows.jsonl");
  // Same repository: three linked worktrees of one clone, started together, run one at a time.
  const repo = fixtureRepo();
  const seats = ["worker", "reviewer", "gate"] as const;
  const trees = { worker: repo, reviewer: worktree(repo, "reviewer"), gate: worktree(repo, "gate") };
  const same = seats.map(name => vitest(trees[name], name, log, { PROBE_HOLD_MS: "1500" }));
  await Promise.all(same.map(passed));
  const spans = seats.map(name => {
    const mine = rows(log).filter(row => row.name === name);
    return { name, start: mine.find(row => row.event === "start")!.at, end: mine.find(row => row.event === "end")!.at,
      token: mine[0]!.token, lease: mine[0]!.lease };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) expect(spans[i]!.start, JSON.stringify(spans)).toBeGreaterThanOrEqual(spans[i - 1]!.end);
  for (const span of spans) { expect(span.token).toMatch(/^[0-9a-f-]{36}$/); expect(span.lease).toBe(span.token); }
  expect(new Set(spans.map(span => span.token)).size).toBe(3);
  expect(same.filter(r => r.out().includes(WAITING)).length).toBeGreaterThanOrEqual(2);
  expect(existsSync(await repositoryLeasePath(repo))).toBe(false);

  // Independent repositories: each must reach the other's rendezvous, which a serialized pair never can.
  const rendezvous = makeTestTempDir("lease-rendezvous-");
  const independent = ["repo-a", "repo-b"].map(name => vitest(fixtureRepo(), name, log,
    { PROBE_RENDEZVOUS: rendezvous, PROBE_PARTNERS: "repo-a,repo-b" }));
  await Promise.all(independent.map(passed));
  expect(rows(log).filter(row => row.event === "rendezvous").map(row => [row.name, row.met]).sort()).toEqual([["repo-a", true], ["repo-b", true]]);
  expect(independent.some(r => r.out().includes(WAITING))).toBe(false);

  // The parent holds the lease; its listing children carry no reentry token and must still finish.
  await withRepositoryLease(repo, async () => {
    const holder = readHolder(await repositoryLeasePath(repo))!;
    expect(holder.pid).toBe(process.pid);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[REPOSITORY_LEASE_TOKEN_ENV];
    const listed = await discoverTestManifest(`npx vitest run --configLoader runner ${PROBE}`, repo,
      { dir: makeTestTempDir("lease-listing-"), nonce: "listing", env, overallCeilingMs: 30_000 });
    expect(listed.files).toEqual([PROBE]);
    // The listing command as Vitest parses it, wherever options put it; `vitest run list` is a filtered run.
    expect(isListingInvocation(["node", "vitest", "--configLoader", "runner", "list"])).toBe(true);
    expect(isListingInvocation(["node", "vitest", "run", "list"])).toBe(false);
    const direct = [["list", "--configLoader", "runner", PROBE, "--json"], ["--configLoader", "runner", "list", PROBE, "--json"]]
      .map(args => vitest(repo, "lister", log, {}, args));
    await Promise.all(direct.map(passed));
    for (const r of direct) expect(r.out()).not.toContain(WAITING);
    expect(rows(log).some(row => row.name === "lister")).toBe(false); // listing runs no test body
    expect(readHolder(await repositoryLeasePath(repo))?.token).toBe(holder.token);
  });

  // A repository-less cwd runs the production configuration without any lease to take or export.
  const loose = makeTestTempDir("lease-loose-");
  for (const file of ["vitest.config.ts", "scripts/vitest-lease.ts", "tests/setup.ts", PROBE, "package.json"]) {
    mkdirSync(dirname(join(loose, file)), { recursive: true });
    copyFileSync(join(repo, file), join(loose, file));
  }
  linkDeps(loose);
  expect(() => execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: loose, stdio: "ignore" })).toThrow();
  const bare = vitest(loose, "loose", log);
  await passed(bare);
  expect(rows(log).find(row => row.name === "loose" && row.event === "start")).toMatchObject({ token: null, lease: null });
}, 240_000);

test("test: gate and nested mutation children reenter only a live identity-bound file lease exported by the holding repository entry before its first fork and cancellation releases it whereas a forged stale foreign or in-process TICKMARKR_LEASE_TOKEN waits, so a missing exporter token bypass deadlock or premature release fails", async () => {
  const log = join(makeTestTempDir("lease-log-"), "rows.jsonl");
  const repo = fixtureRepo();
  const path = await repositoryLeasePath(repo);
  const outer = process.env[REPOSITORY_LEASE_TOKEN_ENV]; // this suite's own lease, when it holds one
  let stale = "";
  await withRepositoryLease(repo, async () => { stale = readHolder(path)!.token; }); // a released generation

  // The repository entry exports its own token before the first fork; a nested runner under the
  // filtered gate environment reenters it, and the lease is still that holder's until the runner ends.
  const release = join(makeTestTempDir("lease-hold-"), "release");
  const holder = vitest(repo, "holder", log, { PROBE_NESTED: "nested", PROBE_HOLD: release, PROBE_SLEEPER: "1", PROBE_CANCEL_NESTED: release });
  await until(() => rows(log).some(row => row.name === "holder" && row.event === "nested"), 60_000, `the nested runner:\n${holder.out()}`);
  const held = rows(log).filter(row => row.name === "holder");
  const token = held[0]!.token!;
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  expect(held[0]!.lease).toBe(token);
  expect(held.find(row => row.event === "nested"), held.find(row => row.event === "nested")?.output).toMatchObject({ code: 0, lease: token });
  expect(rows(log).find(row => row.name === "nested" && row.event === "start")).toMatchObject({ token, lease: token });
  expect(readHolder(path)).toMatchObject({ pid: holder.child.pid, token });

  // Tokens that name no live ancestor holding THIS repository's lease wait, alongside a plain waiter.
  const foreignRepo = fixtureRepo();
  await withRepositoryLease(foreignRepo, async () => {
    const foreign = readHolder(await repositoryLeasePath(foreignRepo))!.token;
    expect(foreign).not.toBe(stale);
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ["forged", { [REPOSITORY_LEASE_TOKEN_ENV]: "forged-token" }],
      ["stale", { [REPOSITORY_LEASE_TOKEN_ENV]: stale }],
      ["foreign", { [REPOSITORY_LEASE_TOKEN_ENV]: foreign }],
      ["in-process", { [COMMAND_LEASE_TOKEN_ENV]: token }],
      ["plain", {}],
    ];
    const waiters = cases.map(([name, env]) => [name, vitest(worktree(repo, name), name, log, env)] as const);
    await Promise.all(waiters.map(([name, r]) => waits(r, log, name)));
  });
  expect(readHolder(path)?.token).toBe(token); // no waiter's cancellation released the holder

  // Cancellation must stop the still-running nested coordinator, its fork and grandchild as well
  // as the holder's fork and child. Cleanup below runs only AFTER the waiter's survivor assertion.
  await until(() => rows(log).some(row => row.name === "active-nested" && row.event === "sleeper"), 30_000, "active nested runner's grandchild");
  const owned = [...new Set(rows(log).filter(row => row.name === "holder" || row.name === "active-nested")
    .flatMap(row => [row.pid, ...(row.child ? [row.child] : [])]))];
  for (const pid of owned) expect(() => process.kill(pid, 0)).not.toThrow();
  const next = vitest(worktree(repo, "next"), "next", log, { PROBE_GONE: owned.join(",") });
  await until(() => next.out().includes(WAITING), 30_000, `next to queue:\n${next.out()}`);
  holder.child.kill("SIGTERM");
  await holder.exit;
  await passed(next);
  const started = rows(log).find(row => row.name === "next" && row.event === "start")!;
  expect(started.survivors).toEqual([]);
  expect(rows(log).some(row => row.name === "holder" && row.event === "end")).toBe(false);
  expect(rows(log).some(row => row.name === "active-nested" && row.event === "end")).toBe(false);
  expect(started.lease).toBe(started.token);
  expect(started.token).not.toBe(token);
  expect(existsSync(path)).toBe(false);

  // A gate process holding the lease (the `tickmarkr verify` path) exports it to its descendant runner.
  await withRepositoryLease(repo, async () => {
    const gateToken = readHolder(path)!.token;
    expect(process.env[REPOSITORY_LEASE_TOKEN_ENV]).toBe(gateToken);
    const child = vitest(repo, "gate-child", log, { [REPOSITORY_LEASE_TOKEN_ENV]: gateToken });
    await passed(child);
    expect(child.out()).not.toContain(WAITING);
    expect(rows(log).find(row => row.name === "gate-child" && row.event === "start")).toMatchObject({ token: gateToken, lease: gateToken });
    expect(readHolder(path)?.token).toBe(gateToken); // the reentrant child released nothing
  });
  expect(process.env[REPOSITORY_LEASE_TOKEN_ENV]).toBe(outer);
  expect(existsSync(path)).toBe(false);
}, 240_000);

// C-9(i) (D-670, verify of the D-644 lease fix): a ps census that threw after the tree was frozen skipped
// the SIGKILL, so SIGSTOPped forks outlived a reclaimed lease.
test("stopOwnedRunners kills the processes it froze when a later ps census throws, so a stopped fork outliving the lease fails", async () => {
  const realPs = execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
  const bin = makeTestTempDir("tickmarkr-ps-shim-");
  const count = join(bin, "count");
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nif [ -e "${count}" ]; then exit 1; fi\n: > "${count}"\nexec "${realPs}" "$@"\n`, { mode: 0o755 });
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    expect(() => stopOwnedRunners(2_000)).toThrow();
  } finally {
    process.env.PATH = path;
  }
  const sig = await Promise.race([exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 3_000))]);
  if (sig === "alive") child.kill("SIGKILL");
  expect(sig).toBe("SIGKILL");
});
