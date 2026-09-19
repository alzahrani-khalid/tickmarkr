import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { COMMAND_LEASE_TOKEN_ENV, commandLeaseEnvironment, CommandLeases, currentCommandLeaseToken, isRunnerCommand, readHolder, reclaimDead, repositoryLeasePath, runWithCommandLease, tryReserve, withCommandLease, withRepositoryLease, observeIdentity } from "../../src/run/lease.js";
import { resetSpawnForTests, setSpawnForTests, sh } from "../../src/run/git.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { verifyIntegrationTip } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
};
// These fixtures exercise root admission even when the containing suite is itself leased.
beforeEach(() => { vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined); });
afterEach(() => { resetSpawnForTests(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

test("test: two leased commands started together run one at a time with the second's suite-wait row naming the count, a leased command killed at its ceiling releases only its own lease and the waiting command starts within one poll while a third command's lease is untouched, and the baseline capture and tip verify each hold a lease for their command's span, so a lease outliving its job or a capture that runs unleased fails", async () => {
  const repo = makeRepo({ "base.txt": "base" });
  const artifacts = makeTestTempDir("tickmarkr-lease-tip-");
  vi.useFakeTimers();
  const starts: string[] = [];
  const children = new Map<number, EventEmitter>();
  let nextPid = 800000;
  setSpawnForTests(((_binary: string, argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.pid = ++nextPid; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit("exit", null); child.emit("close", null); return true; };
    children.set(child.pid, child);
    if (isRunnerCommand(argv[1]!)) starts.push(argv[1]!);
    else queueMicrotask(() => { child.stdout.write(argv[1]!.includes("rev-parse") ? "a".repeat(40) + "\n" : ""); child.emit("close", 0); });
    return child;
  }) as Parameters<typeof setSpawnForTests>[0]);
  const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
    const child = children.get(-Number(pid));
    child?.emit("exit", null); return true; // escaped descendant keeps close pending
  });
  const leases = new CommandLeases();
  const rows: Array<{ event: string; count: number }> = [];
  const context = <T>(fn: () => Promise<T>) => runWithCommandLease((_cmd, run) => leases.run(run, count => rows.push({ event: "suite-wait", count }), 250), fn);
  const a = context(() => sh("mocha A", repo, 100));
  const b = context(() => sh("mocha B", repo, 10000));
  const c = context(() => sh("mocha C", repo, 10000));
  expect(starts).toEqual(["mocha A"]);
  expect(rows).toEqual([{ event: "suite-wait", count: 1 }, { event: "suite-wait", count: 2 }]);
  await vi.advanceTimersByTimeAsync(200);
  expect((await a).timedOut).toBe(true);
  expect(kill).toHaveBeenCalledWith(-800001, "SIGKILL");
  await vi.advanceTimersByTimeAsync(50);
  expect(starts).toEqual(["mocha A", "mocha B"]);
  await vi.advanceTimersByTimeAsync(250);
  expect(starts).toEqual(["mocha A", "mocha B"]);
  children.get(800002)!.emit("close", 0); await b;
  await vi.advanceTimersByTimeAsync(250);
  expect(starts).toEqual(["mocha A", "mocha B", "mocha C"]);
  children.get(800003)!.emit("close", 0); await c;

  for (const command of [() => captureBaseline(repo, { test: "npm run -s test" }), () => verifyIntegrationTip(repo, { test: "pnpm -s run test" }, artifacts)]) {
    const result = context(command);
    await vi.advanceTimersByTimeAsync(0);
    const child = children.get(nextPid)!;
    const contender = context(() => sh("mocha contender", repo));
    expect(starts.at(-1)).not.toBe("mocha contender");
    child.emit("close", 0);
    await result;
    await vi.advanceTimersByTimeAsync(250);
    expect(starts.at(-1)).toBe("mocha contender");
    children.get(nextPid)!.emit("close", 0); await contender;
  }
});

test("one classifier excludes inference prompts and scripted gates, and cancelling a queued reservation preserves both neighbours", async () => {
  expect(isRunnerCommand("codex -a never -s workspace-write --prompt Run vitest tests")).toBe(false);
  expect(isRunnerCommand("exit 0")).toBe(false);
  for (const cmd of ["npm test", "sh -c npm test", "node /bin/vitest.mjs run", "mocha test.js", "'node' '/bin/vitest.mjs' list"]) expect(isRunnerCommand(cmd)).toBe(true);
  vi.useFakeTimers();
  const leases = new CommandLeases(), held = deferred(), controller = new AbortController();
  const first = leases.run(() => held.promise, () => {}, 250);
  const cancelled = leases.run(async () => { throw new Error("must not run"); }, () => {}, 250, controller.signal);
  const rejected = expect(cancelled).rejects.toThrow("cancelled");
  let lastRan = false;
  const last = leases.run(async () => { lastRan = true; }, () => {}, 250);
  controller.abort(new Error("cancelled"));
  await vi.advanceTimersByTimeAsync(250); await rejected;
  expect(lastRan).toBe(false);
  held.resolve(); await vi.advanceTimersByTimeAsync(250); await Promise.all([first, last]);
  expect(lastRan).toBe(true);
});

// These are the product defaults from detectGateCommands, plus supported runner entry points.
test.each([
  "npm run -s test", "pnpm -s run test", "yarn run test", "bun run test",
  "pnpm test", "yarn test", "bun test", "pytest", "go test", "make test",
  "cd pkg && npm test", "bash -lc 'cd pkg && npm run -s test'", "python3 -m pytest",
  // D1: configured scripts and package-manager runner entry points must share the same lease.
  "npm run test:unit", "npm run -s test:unit", "pnpm run test.integration",
  "pnpm exec vitest run", "yarn vitest run", "pnpm vitest", "npx --yes vitest run", "npm exec vitest",
  "npm exec -- vitest run", "pnpm dlx vitest run", "bun x vitest run", "yarn exec jest", "pnpm exec mocha",
  "npx --no-install jest", "pnpm --silent exec -- vitest run", "env CI=1 sh -c 'npm run test:unit'",
])("leases runner entry point %s for exactly its command span", async command => {
  const held = deferred();
  const leases = new CommandLeases();
  let secondStarted = false;
  const waits: number[] = [];
  const context = <T>(run: () => Promise<T>) => runWithCommandLease(
    (_cmd, execute) => leases.run(execute, count => waits.push(count), 250), run);
  const { withCommandLease } = await import("../../src/run/lease.js");
  vi.useFakeTimers();
  const first = context(() => withCommandLease(command, () => held.promise));
  const second = context(() => withCommandLease(command, async () => { secondStarted = true; }));
  expect(secondStarted).toBe(false);
  expect(waits).toEqual([1]);
  held.resolve();
  await first;
  await vi.advanceTimersByTimeAsync(250);
  await second;
  expect(secondStarted).toBe(true);
});

test.each([
  "npm run lint vitest", "pnpm exec codex --prompt Run vitest tests", "npx --yes codex vitest",
  "yarn run build --description test:unit", "npm run contest", "npm run test-lint", "npm exec vitest-helper", "echo pnpm exec vitest",
])("does not lease runner names in arguments to a non-runner command: %s", async command => {
  const lease = vi.fn((_command: string, run: () => Promise<void>) => run());
  const { withCommandLease } = await import("../../src/run/lease.js");
  const run = vi.fn(async () => {});
  await runWithCommandLease(lease, () => withCommandLease(command, run));
  expect(run).toHaveBeenCalledOnce();
  expect(lease).not.toHaveBeenCalled();
});

test("R87: a nested npx vitest joins its leased npm test while an unrelated runner waits for the parent to finish", async () => {
  vi.useFakeTimers();
  const leases = new CommandLeases(), parentHeld = deferred(), controller = new AbortController();
  const waits: string[] = [], starts: string[] = [];
  const context = <T>(run: () => Promise<T>) => runWithCommandLease(
    (command, execute) => leases.run(execute, () => waits.push(command), 250, controller.signal), run);
  const parent = context(() => withCommandLease("npm test", async () => {
    starts.push("parent");
    await withCommandLease("npx vitest", async () => { starts.push("child"); });
    await parentHeld.promise;
  }));
  const peer = context(() => withCommandLease("vitest independent", async () => { starts.push("peer"); }));
  const settled = Promise.allSettled([parent, peer]);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(["parent", "child"]);
    expect(waits).toEqual(["vitest independent"]);
    parentHeld.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(await settled).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    expect(starts).toEqual(["parent", "child", "peer"]);
  } finally {
    parentHeld.resolve();
    controller.abort(new Error("test cleanup"));
    await vi.advanceTimersByTimeAsync(250);
    await settled;
  }
});

test.each([false, true])("R87: an async continuation after its parent lease settles reacquires instead of reusing the expired token (parent rejects: %s)", async rejects => {
  const continueLater = deferred();
  const acquired: string[] = [];
  const tokens: Array<string | undefined> = [];
  let later!: Promise<void>;
  const parent = runWithCommandLease((command, execute) => {
    acquired.push(command);
    return execute();
  }, () => withCommandLease("npm test", async () => {
    tokens.push(currentCommandLeaseToken());
    later = continueLater.promise.then(() => withCommandLease("npx vitest", async () => {
      tokens.push(currentCommandLeaseToken());
    }));
    if (rejects) throw new Error("parent failed");
  }));
  const [settled] = await Promise.allSettled([parent]);
  expect(settled!.status).toBe(rejects ? "rejected" : "fulfilled");
  continueLater.resolve();
  await later;
  expect(acquired).toEqual(["npm test", "npx vitest"]);
  expect(tokens).toEqual([expect.any(String), expect.any(String)]);
  expect(tokens[1]).not.toBe(tokens[0]);
});

test("R87: a shell environment receives its active lease token even with an explicit environment and does not leak it to a peer", async () => {
  const supplied = { PATH: "/bin", TICKMARKR_LEASE_TOKEN: "unrelated-token" };
  const before = process.env.TICKMARKR_LEASE_TOKEN;
  await runWithCommandLease((_command, execute) => execute("granted-parent-token"), () => withCommandLease("npm test", async () => {
    expect(commandLeaseEnvironment(supplied)).toEqual({ PATH: "/bin", TICKMARKR_LEASE_TOKEN: "granted-parent-token" });
    expect(process.env.TICKMARKR_LEASE_TOKEN).toBe(before);
  }));
  expect(commandLeaseEnvironment(supplied).TICKMARKR_LEASE_TOKEN).toBe(before || undefined);
  expect(supplied.TICKMARKR_LEASE_TOKEN).toBe("unrelated-token");
});

test("test: the runner classifier leases npm test, npm run test:unit and npx vitest run and leases neither a script named test-lint nor a prompt that mentions vitest, and a leased npm test whose child test spawns npx vitest through the production lease path completes without waiting on its parent and is censused once, so a classifier that over-matches or a nested runner that waits on its own parent fails", async () => {
  for (const cmd of ["npm test", "npm run test:unit", "npx vitest run"]) expect(isRunnerCommand(cmd), cmd).toBe(true);
  for (const cmd of ["npm run test-lint", "npm run -s test-lint", "codex --prompt 'run the vitest suite'"]) expect(isRunnerCommand(cmd), cmd).toBe(false);

  const repo = makeRepo({ "base.txt": "base" });
  vi.useFakeTimers();
  const starts: Array<{ command: string; token: string | undefined }> = [];
  const children = new Map<string, EventEmitter>();
  let childRun: Promise<unknown> | undefined;
  setSpawnForTests(((_binary: string, argv: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.pid = 900000 + starts.length; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    starts.push({ command: argv[1]!, token: options.env[COMMAND_LEASE_TOKEN_ENV] });
    children.set(argv[1]!, child);
    // The parent's test spawns a nested runner through the SAME production seam (sh → withCommandLease).
    if (argv[1] === "npm test") childRun = sh("npx vitest run", repo);
    return child;
  }) as Parameters<typeof setSpawnForTests>[0]);
  const leases = new CommandLeases();
  const census: number[] = [];
  const context = <T>(fn: () => Promise<T>) => runWithCommandLease((_cmd, run) => leases.run(run, count => census.push(count), 250), fn);
  const parent = context(() => sh("npm test", repo));
  const contender = context(() => sh("npm run test:unit", repo));
  await vi.advanceTimersByTimeAsync(0);
  // The nested runner started at once (no wait on its parent) carrying its parent's token.
  expect(starts.map(s => s.command)).toEqual(["npm test", "npx vitest run"]);
  expect(starts[0]!.token).toEqual(expect.any(String));
  expect(starts[1]!.token).toBe(starts[0]!.token);
  // The contender censused exactly one live reservation: the parent and its child are one suite.
  expect(census).toEqual([1]);
  children.get("npx vitest run")!.emit("close", 0);
  await childRun;
  children.get("npm test")!.emit("close", 0);
  await parent;
  await vi.advanceTimersByTimeAsync(250);
  expect(starts.map(s => s.command)).toEqual(["npm test", "npx vitest run", "npm run test:unit"]);
  children.get("npm run test:unit")!.emit("close", 0);
  await contender;
});

test("R-T7: two waiters that both read one dead holder reclaim it once — the loser's reclamation never removes the winner's fresh reservation — and a reservation left empty or truncated by a process killed mid-acquisition is reclaimed rather than waited on forever", async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const repo = makeRepo({ "base.txt": "base" });
  const path = await repositoryLeasePath(repo);
  // A holder that really died: a child process that reserved and was then killed.
  const deadPid = spawnSync("node", ["-e", "process.exit(0)"]).pid!;
  const dead = { pid: deadPid, cwd: repo, at: 1, token: "dead-token" };
  expect(tryReserve(path, dead)).toBe(true);
  const deadIdentity = observeIdentity(path)!;
  // The reviewer's interleaving: A and B both read the dead holder; A reclaims and acquires; B reclaims.
  const a = { pid: process.pid, cwd: repo, at: 2, token: "a-token" };
  expect(await reclaimDead(path, deadIdentity)).toBe(true);
  expect(tryReserve(path, a)).toBe(true);
  expect(await reclaimDead(path, deadIdentity)).toBe(false); // B's stale reclamation is a no-op
  expect(readHolder(path)?.token).toBe("a-token"); // A's live reservation survived
  expect(tryReserve(path, { ...a, token: "b-token" })).toBe(false);
  expect(readHolder(path)?.token).toBe("a-token");

  // Termination during reservation creation: the draft is private, so a kill before the link leaves nothing.
  const draft = spawnSync("node", ["-e", `
    const { writeFileSync } = require("node:fs");
    writeFileSync(${JSON.stringify(path)} + ".x.draft", "{\\"pid\\":");
    process.kill(process.pid, "SIGKILL");
  `]);
  expect(draft.signal).toBe("SIGKILL");
  expect(readHolder(path)?.token).toBe("a-token");

  // A partial record at the path itself is reclaimed on the next poll instead of being treated as a
  // live holder. Its bytes and inode are read through one descriptor, so a stale corrupt observation
  // cannot remove the complete replacement published by another process.
  for (const bytes of ["", '{"pid":']) {
    rmSyncOrIgnore(path);
    writeFileSync(path, bytes);
    const corruptIdentity = observeIdentity(path)!;
    rmSyncOrIgnore(path);
    expect(tryReserve(path, a)).toBe(true);
    const stale = spawnSync("node", ["--input-type=module", "-e", `
      import { reclaimDead } from "./dist/run/lease.js";
      void (async () => process.exit(await reclaimDead(process.argv[1], process.argv[2]) ? 42 : 0))();
    `, path, corruptIdentity], { cwd: process.cwd() });
    expect(stale.status, stale.stderr.toString()).toBe(0);
    expect(readHolder(path)?.token).toBe("a-token");
    rmSyncOrIgnore(path);
    writeFileSync(path, bytes);
    await expect(withRepositoryLease(repo, async () => `ran over ${JSON.stringify(bytes)}`, { pollMs: 10 })).resolves.toBe(`ran over ${JSON.stringify(bytes)}`);
    expect(existsSync(path)).toBe(false);
  }

  // A reclaimer killed after linking the tombstone but before unlinking the canonical path leaves a
  // dead mutation-lock generation. The next production acquisition supersedes it and finishes the
  // exact inode's reclaim instead of spinning or deleting a replacement.
  writeFileSync(path, '{"pid":');
  const interruptedIdentity = observeIdentity(path)!;
  const interrupted = spawnSync("node", ["-e", `
    const { linkSync, mkdirSync, symlinkSync } = require("node:fs");
    const path = process.argv[1], identity = process.argv[2], lock = path + ".lock";
    mkdirSync(lock);
    symlinkSync(process.pid + ":killed", lock + "/owner.0");
    linkSync(path, path + ".dead-" + identity);
    process.kill(process.pid, "SIGKILL");
  `, path, interruptedIdentity]);
  expect(interrupted.signal).toBe("SIGKILL");
  await expect(withRepositoryLease(repo, async () => "recovered interrupted reclaim", { pollMs: 10 })).resolves.toBe("recovered interrupted reclaim");
  expect(existsSync(path)).toBe(false);
  expect(readFileSync(`${path}.dead-${deadIdentity}`, "utf8")).toContain("dead-token");
});
const rmSyncOrIgnore = (p: string) => { try { require("node:fs").rmSync(p, { force: true }); } catch { /* absent */ } };
