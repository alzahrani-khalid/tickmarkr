import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import { discoverTestManifest, manifestFileCount, runManifestedTest } from "../../src/gates/test-manifest.js";
import { validateGraph } from "../../src/graph/schema.js";
import { resetSpawnForTests, setSpawnForTests, sh, shell } from "../../src/run/git.js";
import { COMMAND_LEASE_TOKEN_ENV, CommandLeases, runWithCommandLease, withCommandLease } from "../../src/run/lease.js";
import type { ShellReceipt } from "../../src/run/protocol.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

beforeEach(() => { vi.stubEnv(COMMAND_LEASE_TOKEN_ENV, undefined); });
afterEach(() => { resetSpawnForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); });

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
};

/** Exercise the real shell entry and lease queue without starting another test suite. */
function runnerFixture() {
  const cwd = makeTestTempDir("listing-unleased-");
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(cwd, "node_modules/.bin/vitest"), "stand-in: spawn is injected\n");
  const starts: Array<{ pid: number; command: string; env: NodeJS.ProcessEnv; listing: boolean }> = [];
  const running = new Map<number, () => void>();
  let pid = 800000;
  const fixture = { cwd, starts, running, autoComplete: false };
  setSpawnForTests(((_binary: string, argv: string[], options: SpawnOptions) => {
    const command = argv[1]!;
    const listing = /\slist\s/.test(command);
    const child = Object.assign(new EventEmitter(), {
      pid: ++pid, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    starts.push({ pid: child.pid, command, listing, env: options.env! });
    const finish = () => {
      if (!running.delete(child.pid)) return;
      child.stdout.end(listing ? JSON.stringify([{ file: join(realpathSync(cwd), "tests/unit.test.ts") }]) : "Tests 1 passed (1)\n");
      child.stderr.end();
      child.emit("close", 0);
    };
    running.set(child.pid, finish);
    queueMicrotask(() => {
      child.emit("spawn");
      if (listing || fixture.autoComplete) finish();
    });
    return child;
  }) as unknown as Parameters<typeof setSpawnForTests>[0]);
  return fixture;
}

test("test: a manifest listing issued while another command holds the daemon's command lease runs at once without queueing, while a full suite, a selected screen and an acceptance test oracle issued then still wait for the lease, so a listing that queues behind a suite or a suite that skips the queue fails", async () => {
  const fixture = runnerFixture();
  const { cwd, starts, running } = fixture;
  vi.useFakeTimers();
  const leases = new CommandLeases();
  const waits: string[] = [];
  const context = <T>(run: () => Promise<T>) => runWithCommandLease(
    (command, execute) => leases.run(execute, () => waits.push(command), 10), run,
  );
  const release = deferred();
  const holder = context(() => withCommandLease("vitest run other-task", () => release.promise));
  const manifested = (command: string, nonce: string) => context(() => runManifestedTest(command, cwd, {
    manifest: ["tests/unit.test.ts"], nonce, reportPath: join(cwd, `${nonce}.json`),
  }));
  const full = manifested("vitest run", "full");
  const screen = manifested("vitest run tests/unit.test.ts", "screen");
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" }, tasks: [{
    id: "T1", title: "oracle", goal: "oracle", shape: "implement", complexity: 1,
    acceptance: [{ oracle: "test", test: "criterion guarded by oracle" }], files: ["**"],
  }] }).tasks[0]!;
  writeFileSync(join(cwd, "unused-judge.json"), JSON.stringify({ tasks: {} }));
  const oracle = context(() => acceptanceGate(task, cwd, "HEAD", {
    adapter: new FakeAdapter(join(cwd, "unused-judge.json")), model: "fake",
  }, undefined, { testCmd: "vitest run" }));
  const script = context(() => sh("npm run test:unit", cwd));
  const discovered = vi.fn();
  const listings = ["post-suite-first", "post-suite-second", "before-suite"].map(nonce => context(
    () => discoverTestManifest("vitest run", cwd, { dir: cwd, nonce, env: process.env }),
  ).then(manifest => { discovered(manifest.files); return manifest; }));
  const counted = vi.fn();
  const baseline = context(() => manifestFileCount("vitest run", cwd)).then(count => { counted(count); return count; });
  const jobs = [holder, full, screen, oracle, script, ...listings, baseline];
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(discovered.mock.calls).toEqual(Array.from({ length: 3 }, () => [["tests/unit.test.ts"]]));
    expect(counted).toHaveBeenCalledWith(1);
    expect(starts).toHaveLength(4);
    expect(starts.every(start => start.listing)).toBe(true);
    expect(starts.every(start => start.env[COMMAND_LEASE_TOKEN_ENV] === undefined)).toBe(true);
    expect(waits).toEqual(["vitest run", "vitest run tests/unit.test.ts", expect.stringContaining("-t"), "npm run test:unit"]);

    release.resolve();
    await holder;
    // Every real test payload gets a turn only after the holder and its predecessors finish.
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(10);
      const payloads = starts.filter(start => !start.listing);
      expect(payloads).toHaveLength(index + 1);
      expect(running.size).toBe(1);
      const current = payloads[index]!;
      expect(current.env[COMMAND_LEASE_TOKEN_ENV]).toBeTruthy();
      running.get(current.pid)!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect((await full).exitCode).toBe(0);
    expect((await screen).exitCode).toBe(0);
    expect((await oracle).pass).toBe(true);
    expect((await script).code).toBe(0);
    expect(running.size).toBe(0);
  } finally {
    fixture.autoComplete = true;
    release.resolve();
    for (const finish of running.values()) finish();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.allSettled(jobs);
  }
});

test("test: the shell entry runs a command marked unleased outside the command lease and every unmarked runner command through it, and only the manifest discovery marks its listing, so a marker set by any other caller or ignored by the shell fails", async () => {
  const fixture = runnerFixture();
  fixture.autoComplete = true;
  const { cwd } = fixture;
  const admitted = vi.fn();
  const context = <T>(run: () => Promise<T>) => runWithCommandLease(async (command, execute) => {
    admitted(command);
    return execute();
  }, run);
  const receipts: ShellReceipt[] = [];
  await context(() => shell("vitest run explicit", cwd, 5000, false, { unleased: true, onReceipt: receipt => receipts.push(receipt) }));
  await context(() => sh("npm test explicit", cwd, 5000, { unleased: true }));
  expect(admitted).not.toHaveBeenCalled();
  expect(receipts.map(receipt => receipt.outcome)).toEqual(["started", "completed"]);

  const commands = ["vitest run", "vitest run tests/unit.test.ts", "vitest run -t criterion", "npm run test:unit", "vitest list --filesOnly --json"];
  for (const command of commands) await context(() => shell(command, cwd, 5000));
  await context(() => sh("vitest run explicitly-leased", cwd, 5000, { unleased: false }));
  // An empty manifest alone never grants a bypass, even for a command spelled as a listing.
  await context(() => runManifestedTest("vitest list --filesOnly --json", cwd, {
    manifest: [], nonce: "ordinary", reportPath: join(cwd, "ordinary.json"),
  }));
  expect(admitted.mock.calls.map(([command]) => command)).toEqual([
    ...commands, "vitest run explicitly-leased", "vitest list --filesOnly --json",
  ]);
  admitted.mockClear();
  expect((await context(() => discoverTestManifest("vitest run", cwd, { dir: cwd, nonce: "discovery", env: process.env }))).files)
    .toEqual(["tests/unit.test.ts"]);
  expect(admitted).not.toHaveBeenCalled();

  // Audit every production caller: only discovery authors the listing capability, only
  // runManifestedTest forwards it, and only shellEntry reads the resulting shell option.
  const markers: string[] = [];
  const visitFile = (path: string) => {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, owner = "") => {
      if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? "";
      const location = `${relative(process.cwd(), path)}:${owner}`;
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(source).replace(/['"]/g, "");
        if (name === "unleased") markers.push(`${location}:unleased=${node.initializer.getText(source)}`);
        if (name === "listing" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) markers.push(`${location}:listing=true`);
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "unleased") markers.push(`${location}:read-unleased`);
      ts.forEachChild(node, child => visit(child, owner));
    };
    visit(source);
  };
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) visitFile(path);
    }
  };
  walk(join(process.cwd(), "src"));
  expect(markers.sort()).toEqual([
    "src/gates/test-manifest.ts:discoverTestManifest:listing=true",
    "src/gates/test-manifest.ts:runManifestedTest:unleased=opts.listing",
    "src/run/git.ts:shellEntry:read-unleased",
  ]);
});
