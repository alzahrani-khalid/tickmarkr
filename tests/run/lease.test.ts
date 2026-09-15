import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { COMMAND_LEASE_TOKEN_ENV, commandLeaseEnvironment, CommandLeases, currentCommandLeaseToken, isRunnerCommand, runWithCommandLease, withCommandLease } from "../../src/run/lease.js";
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
  "npm run test:unit", "npm run -s test:unit", "pnpm run test.integration", "yarn run test-e2e",
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
  "yarn run build --description test:unit", "npm run contest", "npm exec vitest-helper", "echo pnpm exec vitest",
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
