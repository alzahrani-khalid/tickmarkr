import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { baselineCachePath, verify } from "../../src/cli/commands/verify.js";
import { captureBaseline, compareToBaseline, runnerFileCount, staleFileCountCommands, type Baseline } from "../../src/gates/baseline.js";
import { sh } from "../../src/run/git.js";
import { repositoryLeasePath, withRepositoryLease } from "../../src/run/lease.js";
import { COMMIT, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const install = join(process.cwd(), "node_modules");
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (repo: string) => execFileSync("sh", ["-c", `${COMMIT} fixture`], { cwd: repo });
const link = (dir: string) => { if (!existsSync(join(dir, "node_modules"))) symlinkSync(install, join(dir, "node_modules"), "dir"); };
const linked = (repo: string, name: string, ref = "HEAD"): string => {
  const dir = join(makeTestTempDir(`tickmarkr-${name}-`), name);
  git(repo, "worktree", "add", "--detach", dir, ref);
  return dir;
};
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((r) => { resolve = r; }), resolve: () => resolve() };
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test("test: the baseline capture of a vitest command over a fixture suite whose tests echo nested runner summaries records the count the shared manifest discovery seam lists and not the stdout sum while running the suite once, a standalone verify in a linked worktree over that suite passes its test gate with no deficit and a manifest file killed mid-run still reds as infra naming the file, a scripted non-vitest test command keeps the stdout deficit rule byte-identically, and a cached baseline whose vitest entry's count is not manifest-derived is recaptured rather than applied while a cached non-vitest entry is reused as on the base, so a capture that sums summary lines or runs twice, a verify that counts stdout, a scripted command routed through the manifest, or a stale inflated count applied fails", async () => {
  const counter = join(makeTestTempDir("tickmarkr-capture-count-"), "runs");
  // Each test writes a nested runner's summary straight to the runner's stdout (a spawned child
  // runner's echo, bypassing vitest's attributed echo blocks) — the OBS-1044 shape.
  const echo = (n: number) => `require("node:fs").writeSync(1, " Test Files  ${n} passed (${n})\\n");`;
  const repo = makeRepo({
    ".gitignore": "node_modules/\n",
    "src/a.ts": "export const a = 1;\n",
    "tests/a.test.ts": `import { a } from "../src/a"; test("alpha", () => { require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); ${echo(5)} expect(a).toBeGreaterThan(0); });\n`,
    "tests/b.test.ts": `test("beta", () => { ${echo(7)} expect(2).toBe(2); });\n`,
    "package.json": JSON.stringify({ type: "module", scripts: { test: "vitest run --globals" } }),
  });
  link(repo);
  const cmd = "npm test";
  const raw = await sh(cmd, repo);
  expect(raw.code).toBe(0);
  expect(runnerFileCount(raw.stdout + "\n" + raw.stderr)).not.toBe(2); // the stdout sum is inflated by the nested echo
  writeFileSync(counter, "");
  const captured = await captureBaseline(repo, { test: cmd });
  expect(captured.commands.test).toMatchObject({ exitCode: 0, fileCount: 2, fileCountSource: "manifest" });
  expect(readFileSync(counter, "utf8")).toBe("x"); // the suite ran exactly once; the listing collects, it does not run
  expect(staleFileCountCommands(captured, { test: cmd }, repo)).toEqual([]);

  // A standalone verify from a linked worktree of that repository, over a diff that keeps the suite green.
  git(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 3;\n"); commit(repo);
  const wt = linked(repo, "vl-linked");
  link(wt);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const green = await verify(["--no-review"], wt);
  expect(green.code, green.out).toBe(0);
  expect(green.out).toContain("PASS test");
  expect(green.out).not.toContain("below baseline");
  const mergeBase = git(wt, "merge-base", "main", "HEAD");
  const cache = baselineCachePath(wt, mergeBase, { test: "npm run -s test" }); // detectGateCommands' own spelling
  expect(JSON.parse(readFileSync(cache, "utf8")).commands.test).toMatchObject({ fileCount: 2, fileCountSource: "manifest" });

  // An inflated pre-2.5.6 cached count (a stdout sum) is recaptured, never applied.
  const stale = JSON.parse(readFileSync(cache, "utf8")) as Baseline;
  delete stale.commands.test!.fileCountSource;
  stale.commands.test!.fileCount = 999;
  writeFileSync(cache, JSON.stringify(stale));
  errors.mockClear();
  const recaptured = await verify(["--no-review"], wt);
  expect(recaptured.code, recaptured.out).toBe(0);
  expect(errors.mock.calls.flat().join("\n")).toContain("cached baseline's file count for test is not manifest-derived; it will be recaptured");
  expect(errors.mock.calls.flat().join("\n")).not.toContain("reusing cached baseline");
  expect(JSON.parse(readFileSync(cache, "utf8")).commands.test).toMatchObject({ fileCount: 2, fileCountSource: "manifest" });

  // A manifest file killed mid-run (its per-file hang budget, derived from the supplied baseline) reds as infra naming it.
  writeFileSync(join(wt, "tests/hang.test.ts"), 'test("hangs", async () => { await new Promise((r) => setTimeout(r, 20_000)); }, 30_000);\n');
  commit(wt);
  const budgeted = join(dirname(cache), "hang-baseline.json");
  writeFileSync(budgeted, JSON.stringify({ commands: { test: {
    exitCode: 0, fingerprints: [], ceilingMs: 6_000, fileCount: 3, fileCountSource: "manifest",
    fileDurations: [{ file: "tests/a.test.ts", durationMs: 1_500 }, { file: "tests/b.test.ts", durationMs: 1_500 }],
    longestFile: { file: "tests/b.test.ts", durationMs: 1_500 },
  } } }));
  const killed = await verify(["--no-review", "--baseline", budgeted], wt);
  expect(killed.code).toBe(2);
  expect(killed.out).toContain("FAIL test");
  expect(killed.out).toContain('infra hang: "tests/hang.test.ts"');
  git(repo, "worktree", "remove", "--force", wt);

  // A scripted non-vitest command keeps the stdout deficit rule, byte for byte, and its cache entry is reused.
  const scripted = makeRepo({
    "package.json": JSON.stringify({ scripts: { test: "sh scripted.sh" } }),
    "scripted.sh": "echo ' Test Files  5 passed (5)'\n",
    "src.txt": "base\n",
  });
  const base = await captureBaseline(scripted, { test: cmd });
  expect(base.commands.test).toMatchObject({ exitCode: 0, fileCount: 5 });
  expect(base.commands.test!.fileCountSource).toBeUndefined();
  expect(staleFileCountCommands(base, { test: cmd }, scripted)).toEqual([]);
  writeFileSync(join(scripted, "scripted.sh"), "echo ' Test Files  3 passed (3)'\n");
  const [deficit] = await compareToBaseline(scripted, { test: cmd }, base, ["test"]);
  expect(deficit).toMatchObject({ pass: false, details: "infra; runner reported 3 test files, below baseline 5 — suite incomplete", meta: { classification: "infra", infra: true } });
  writeFileSync(join(scripted, "scripted.sh"), "echo ' Test Files  5 passed (5)'\n");
  git(scripted, "checkout", "-b", "feature");
  writeFileSync(join(scripted, "src.txt"), "base\nfeature\n"); commit(scripted);
  errors.mockClear();
  expect((await verify(["--no-review"], scripted)).code).toBe(0);
  expect((await verify(["--no-review"], scripted)).code).toBe(0);
  expect(errors.mock.calls.flat().join("\n")).toContain("reusing cached baseline");
  expect(errors.mock.calls.flat().join("\n")).not.toContain("not manifest-derived");
}, 180_000);

test("test: two standalone verifies started together in sibling linked worktrees of one repository hold one reservation under the repository's common git dir so exactly one runner root is live at a time and the live waiter journals the holder's pid and cwd and starts within one injected tick of the holder's release, in a second scenario a waiter cancelled while the holder runs completes its cancellation, releases only its own reservation and never starts while the holder finishes and a fresh waiter acquires after the release, and a verify in an unrelated repository starts at once, so two verifies that contend, a cancellation that releases the holder or later runs the cancelled verify, or a lease that spans repositories fails", async () => {
  const log = join(makeTestTempDir("tickmarkr-lease-log-"), "suites.log");
  writeFileSync(log, "");
  const repo = makeRepo({
    "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }),
    "log.cjs": `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv[2] + " " + Date.now() + "\\n");\n`,
    "check.sh": "node log.cjs start\nsleep 1\nnode log.cjs end\n",
    "src.txt": "base\n",
  });
  git(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n"); commit(repo);
  const a = linked(repo, "sibling-a"), b = linked(repo, "sibling-b");
  const commonDir = realpathSync(join(repo, ".git"));
  expect(dirname(realpathSync(dirname(await repositoryLeasePath(a))))).toBe(dirname(commonDir));
  expect(await repositoryLeasePath(a)).toBe(await repositoryLeasePath(b));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const [ra, rb] = await Promise.all([verify(["--no-review"], a), verify(["--no-review"], b)]);
  expect(ra.code, ra.out).toBe(0); expect(rb.code, rb.out).toBe(0);
  const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
  const spans: Array<[number, number]> = [];
  for (const [kind, at] of rows) { if (kind === "start") spans.push([Number(at), NaN]); else spans[spans.length - 1]![1] = Number(at); }
  expect(spans.length).toBeGreaterThanOrEqual(3); // one capture, two head batteries
  for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]); // never two runner roots live
  const waited = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("waiting for the repository's runner lease"));
  expect(waited).toHaveLength(1);
  expect(waited[0]).toContain(`held by pid ${process.pid} in `);
  expect([a, b].some((cwd) => waited[0]!.endsWith(cwd))).toBe(true);
  expect(existsSync(await repositoryLeasePath(a))).toBe(false);

  // The reservation itself, on an injected tick: release → the waiter starts within one poll.
  vi.useFakeTimers();
  const held = deferred(), holding = deferred(), queued = deferred();
  const holder = withRepositoryLease(a, async () => { holding.resolve(); await held.promise; }, { pollMs: 50 });
  await holding.promise;
  const waits: Array<{ pid: number; cwd: string }> = [];
  let waiterStarted = false;
  const waiter = withRepositoryLease(b, async () => { waiterStarted = true; }, { pollMs: 50, onWait: (h) => { waits.push({ pid: h.pid, cwd: h.cwd }); queued.resolve(); } });
  await queued.promise;
  expect(waits).toEqual([{ pid: process.pid, cwd: a }]);
  await vi.advanceTimersByTimeAsync(500);
  expect(waiterStarted).toBe(false);
  held.resolve(); await holder;
  await vi.advanceTimersByTimeAsync(50);
  await waiter;
  expect(waiterStarted).toBe(true);

  // Scenario two: a cancelled waiter releases only itself; the holder keeps its reservation.
  const held2 = deferred(), holding2 = deferred(), queued2 = deferred();
  const holder2 = withRepositoryLease(a, async () => { holding2.resolve(); await held2.promise; return "holder finished"; }, { pollMs: 50 });
  await holding2.promise;
  const controller = new AbortController();
  const cancelledRun = vi.fn(async () => {});
  const cancelled = withRepositoryLease(b, cancelledRun, { pollMs: 50, signal: controller.signal, onWait: () => queued2.resolve() });
  const rejected = expect(cancelled).rejects.toThrow("cancelled");
  await queued2.promise;
  controller.abort(new Error("cancelled"));
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(JSON.parse(readFileSync(await repositoryLeasePath(a), "utf8"))).toMatchObject({ pid: process.pid, cwd: a });
  const queued3 = deferred();
  let freshStarted = false;
  const fresh = withRepositoryLease(b, async () => { freshStarted = true; }, { pollMs: 50, onWait: () => queued3.resolve() });
  await queued3.promise;
  await vi.advanceTimersByTimeAsync(200);
  expect(freshStarted).toBe(false);
  held2.resolve();
  expect(await holder2).toBe("holder finished");
  await vi.advanceTimersByTimeAsync(50);
  await fresh;
  expect(freshStarted).toBe(true);
  expect(cancelledRun).not.toHaveBeenCalled();

  // An unrelated repository is independent of this one's reservation.
  const held3 = deferred(), holding3 = deferred();
  const holder3 = withRepositoryLease(a, async () => { holding3.resolve(); await held3.promise; }, { pollMs: 50 });
  await holding3.promise;
  const other = makeRepo({ "x.txt": "x\n" });
  expect(await withRepositoryLease(other, async () => "started at once", { pollMs: 50, onWait: () => { throw new Error("waited on another repository"); } })).toBe("started at once");
  held3.resolve(); await holder3;
  git(repo, "worktree", "remove", "--force", a);
  git(repo, "worktree", "remove", "--force", b);
}, 120_000);
