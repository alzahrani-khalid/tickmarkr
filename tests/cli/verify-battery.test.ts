import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { baselineCachePath, verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { captureBaseline, compareToBaseline, runnerFileCount, staleFileCountCommands, type Baseline } from "../../src/gates/baseline.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
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

test("test: verify preserves baseline forgiveness for unchanged build and lint fingerprints and rejects a new fingerprint or scope violation before a test phase can turn the accumulated verdict green", async () => {
  const suites = join(makeTestTempDir("tickmarkr-forgive-suites-"), "suites.log");
  writeFileSync(suites, "");
  const failing = (label: string) => `echo 'src/old.ts(1,1): error TS1001: pre-existing ${label} failure'; exit 1\n`;
  const repo = makeRepo({
    "package.json": JSON.stringify({ scripts: { build: "sh build.sh", lint: "sh lint.sh", test: "sh test.sh" } }),
    "build.sh": failing("build"),
    "lint.sh": failing("lint"),
    "test.sh": `echo run >> '${suites}'\n`,
    "src.txt": "base\n",
  });
  const candidate = (name: string, files: Record<string, string>) => {
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", name);
    for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body);
    commit(repo);
  };
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  type Report = { green: boolean; results: Array<{ gate: string; pass: boolean; details: string }> };
  const run = async (...args: string[]) => {
    const r = await verify(["--no-review", "--json", "--files", "src.txt", "--files", "*.sh", ...args], repo);
    return { code: r.code, report: JSON.parse(r.out) as Report };
  };

  // Unchanged pre-existing reds are forgiven, and only then does the leased suite speak.
  candidate("forgiven", { "src.txt": "base\nforgiven\n" });
  const forgiven = await run();
  expect(forgiven.code).toBe(0);
  expect(forgiven.report.results.filter((r) => ["build", "lint", "test"].includes(r.gate)).map((r) => [r.gate, r.pass]))
    .toEqual([["build", true], ["test", true], ["lint", true]]);
  expect(readFileSync(suites, "utf8").split("\n").filter(Boolean)).toHaveLength(2); // base suite + candidate suite

  // Each red below answers while another holder keeps the suite lease: no test phase is ever queued.
  let release!: () => void;
  const releasing = new Promise<void>((r) => { release = r; });
  let holding!: () => void;
  const holds = new Promise<void>((r) => { holding = r; });
  const holder = withRepositoryLease(repo, async () => { holding(); await releasing; }, { pollMs: 50 });
  await holds;
  const suitesBefore = readFileSync(suites, "utf8");
  errors.mockClear();
  const reds: Array<[string, Record<string, string>, string]> = [
    ["fresh-build", { "src.txt": "base\nbuild\n", "build.sh": `echo 'src/new.ts(2,1): error TS2002: fresh build failure'\n${failing("build")}` }, "build"],
    ["fresh-lint", { "src.txt": "base\nlint\n", "lint.sh": `echo 'src/new.ts(3,1): error TS2003: fresh lint failure'\n${failing("lint")}` }, "lint"],
    ["stray", { "src.txt": "base\nstray\n", "stray.txt": "drive-by\n" }, "scope"],
  ];
  for (const [name, files, gate] of reds) {
    candidate(name, files);
    const red = await run();
    expect(red.code, name).toBe(2);
    expect(red.report.green).toBe(false);
    expect(red.report.results.find((r) => r.gate === gate)?.pass, name).toBe(false);
    expect(red.report.results.map((r) => r.gate), name).not.toContain("test");
  }
  expect(errors.mock.calls.flat().join("\n")).not.toContain("waiting for the repository's runner lease");
  expect(readFileSync(suites, "utf8")).toBe(suitesBefore);
  release();
  await holder;
}, 120_000);

test("test: verify reuses a healthy baseline only for matching base lockfile and command-subset identities whereas verdictless or untrusted manifests are recaptured into one combined result artifact", async () => {
  const log = join(makeTestTempDir("tickmarkr-subset-cache-"), "runs.log");
  writeFileSync(log, "");
  // Each command logs `<gate>:<side>`, where the side is the checkout's own marker (base or head).
  const logged = (gate: string) => `echo ${gate}:$(cat side.txt) >> '${log}'`;
  const repo = makeRepo({
    "package.json": JSON.stringify({ scripts: { build: logged("build"), lint: logged("lint"), test: logged("test") } }),
    "side.txt": "base\n",
  });
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "side.txt"), "head\n"); commit(repo);
  const base = git(repo, "merge-base", "main", "HEAD");
  const cheap = { build: "npm run -s build", lint: "npm run -s lint" };
  const suite = { build: "npm run -s build", test: "npm run -s test" }; // the suite capture rebuilds first
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let seen = 0;
  const baseRuns = () => {
    const rows = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const fresh = rows.slice(seen).filter((row) => row.endsWith(":base"));
    seen = rows.length;
    return fresh.map((row) => row.split(":")[0]).sort();
  };
  const stderr = () => { const text = errors.mock.calls.flat().join("\n"); errors.mockClear(); return text; };
  type Report = { green: boolean; artifactPath: string; results: Array<{ gate: string; pass: boolean }> };
  const run = async () => {
    const r = await verify(["--no-review", "--json"], repo);
    expect(r.code, r.out).toBe(0);
    return JSON.parse(r.out) as Report;
  };

  // First run captures each subset under its own identity.
  await run();
  expect(baseRuns()).toEqual(["build", "build", "lint", "test"]);
  expect(existsSync(baselineCachePath(repo, base, cheap))).toBe(true);
  expect(existsSync(baselineCachePath(repo, base, suite))).toBe(true);
  expect(baselineCachePath(repo, base, cheap)).not.toBe(baselineCachePath(repo, base, suite));
  expect(baselineCachePath(repo, "0".repeat(40), cheap)).not.toBe(baselineCachePath(repo, base, cheap)); // another base, another identity
  stderr();

  // Same base, lockfiles and subsets: both healthy captures are reused and no base command runs.
  await run();
  expect(baseRuns()).toEqual([]);
  expect(stderr().match(/reusing cached baseline for/g)).toHaveLength(2);

  // A changed lint command changes only the build/lint subset's identity; the suite's capture stands.
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `gates:\n  lint: "${logged("lint").replace(/"/g, '\\"')} # strict"\n`);
  await run();
  expect(baseRuns()).toEqual(["build", "lint"]);
  expect(stderr()).toMatch(/reusing cached baseline for \w+ \(build, test: /);

  // A changed lockfile is a different dependency world: both subsets recapture.
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  commit(repo);
  await run();
  expect(baseRuns()).toEqual(["build", "build", "lint", "test"]);
  stderr();

  // Untrusted captures are never applied: a cached entry without a verdict, and bytes that do not parse.
  const cheapNow = { ...cheap, lint: `${logged("lint")} # strict` };
  const suitePath = baselineCachePath(repo, base, suite);
  const tampered = JSON.parse(readFileSync(suitePath, "utf8")) as Baseline;
  delete tampered.commands.test!.exitCode;
  writeFileSync(suitePath, JSON.stringify(tampered));
  writeFileSync(baselineCachePath(repo, base, cheapNow), "{ torn");
  const report = await run();
  expect(baseRuns()).toEqual(["build", "build", "lint", "test"]);
  const said = stderr();
  expect(said).toContain("cached baseline recorded no verdict for test; it was not reusable and will be recaptured");
  expect(said).toContain("is unreadable; it will be recaptured");
  expect(said).not.toContain("reusing cached baseline");
  expect((JSON.parse(readFileSync(suitePath, "utf8")) as Baseline).commands.test!.exitCode).toBe(0);

  // Both subsets' rows fold into ONE verdict and ONE results artifact.
  expect(readdirSync(dirname(report.artifactPath)).filter((f) => f.endsWith("results.json"))).toEqual(["verify-results.json"]);
  const artifact = JSON.parse(readFileSync(report.artifactPath, "utf8")) as { green: boolean; gateRows: Array<{ gate: string; pass: boolean }> };
  expect(artifact.green).toBe(true);
  expect(artifact.gateRows.map((r) => r.gate)).toEqual(["build", "test", "lint", "evidence"]);
  expect(artifact.gateRows).toEqual(report.results);
}, 120_000);

test("verify's suite baseline rebuilds ignored build outputs at base, so a suite failure that predates the diff stays forgiven", async () => {
  const repo = makeRepo({
    ".gitignore": "dist/\n",
    "package.json": JSON.stringify({ scripts: { build: "sh build.sh", test: "sh test.sh" } }),
    "build.sh": "mkdir -p dist && echo built > dist/out.txt\n",
    // The suite reads the build's ignored output, then fails the same way at base and at head.
    "test.sh": "[ -f dist/out.txt ] || { echo 'Error: build output dist/out.txt is missing'; exit 1; }\necho 'FAIL tests/old.test.ts > pre-existing failure'; exit 1\n",
    "src.txt": "base\n",
  });
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  commit(repo);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await verify(["--no-review", "--json"], repo);
  const report = JSON.parse(r.out) as { results: Array<{ gate: string; pass: boolean }> };
  expect(report.results.find((row) => row.gate === "test"), r.out).toMatchObject({ pass: true });
  expect(r.code, r.out).toBe(0);
}, 120_000);

test("two overlapping verifies of one checkout capture their unleased baselines in separate worktrees, remove only their own and a dead owner's leftover, and both reach the held suite lease", async () => {
  const scratch = makeTestTempDir("tickmarkr-overlap-");
  const arrivals = join(scratch, "arrivals");
  const log = join(scratch, "captures.log");
  mkdirSync(arrivals);
  writeFileSync(log, "");
  // Each build checks in and waits (bounded) until two builds are live at once, then logs the
  // worktree it ran in and whether that worktree still holds its own checkout.
  const repo = makeRepo({
    "package.json": JSON.stringify({ scripts: { build: "sh build.sh", lint: "cat side.txt", test: "cat side.txt" } }),
    "build.sh": `touch '${arrivals}'/$$\ni=0; while [ "$(ls '${arrivals}' | wc -l)" -lt 2 ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\necho "$(pwd -P) $(cat side.txt)" >> '${log}'\n`,
    "side.txt": "base\n",
  });
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "side.txt"), "head\n");
  commit(repo);
  const base = git(repo, "merge-base", "main", "HEAD");
  // Leftovers in the state dir: a killed verify's (its pid is dead) and a live one's (this process).
  const stateDir = verifyStateDir(repo);
  mkdirSync(stateDir, { recursive: true });
  const deadLeftover = join(stateDir, `base-${base.slice(0, 12)}-${spawnSync("true").pid}-abcdef`);
  const liveLeftover = join(stateDir, `base-${base.slice(0, 12)}-${process.pid}-ghijkl`);
  for (const dir of [deadLeftover, liveLeftover]) git(repo, "worktree", "add", "--detach", dir, base);

  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const waits = () => errors.mock.calls.filter((c) => String(c[0]).includes("waiting for the repository's runner lease")).length;
  const held = deferred(), holding = deferred();
  const holder = withRepositoryLease(repo, async () => { holding.resolve(); await held.promise; }, { pollMs: 50 });
  await holding.promise;
  const both = Promise.all([verify(["--no-review"], repo), verify(["--no-review"], repo)]);
  // Both finish their cheap gates unleased and queue on the held lease.
  await vi.waitFor(() => expect(waits()).toBe(2), { timeout: 60_000, interval: 50 });
  const baseCaptures = readFileSync(log, "utf8").split("\n").filter((line) => line.endsWith(" base"));
  expect(baseCaptures).toHaveLength(2);
  expect(new Set(baseCaptures).size).toBe(2); // two worktrees, each intact through its own capture
  held.resolve();
  await holder;
  for (const r of await both) expect(r.code, r.out).toBe(0);

  expect(readdirSync(stateDir).filter((entry) => entry.startsWith("base-"))).toEqual([basename(liveLeftover)]);
  git(repo, "worktree", "remove", "--force", liveLeftover);
  expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}, 120_000);

test("two verifies of one checkout allocated in the same millisecond each write their own results artifact", async () => {
  const repo = makeRepo({ "package.json": JSON.stringify({ scripts: { build: "true" } }), "src.txt": "base\n" });
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  commit(repo);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z")); // every allocation reads one identical timestamp
  type Report = { artifactPath: string; artifactAvailability: string; artifactSha256: string | null };
  const reports = (await Promise.all([verify(["--no-review", "--json"], repo), verify(["--no-review", "--json"], repo)]))
    .map((r) => { expect(r.code, r.out).toBe(0); return JSON.parse(r.out) as Report; });
  expect(reports.map((r) => r.artifactAvailability)).toEqual(["available", "available"]);
  expect(new Set(reports.map((r) => r.artifactPath)).size).toBe(2);
  for (const r of reports) expect(basename(dirname(r.artifactPath))).toMatch(/^2026-09-29T00-00-00-000Z-/);
}, 120_000);

test("a suite baseline refused after the unleased gates answered is a failed test row inside the one accumulated verdict and artifact", async () => {
  const repo = makeRepo({
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ scripts: { test: "true" } }),
    "packages/pkg/index.js": "module.exports = 1;\n",
    "src.txt": "base\n",
  });
  // A workspace link resolves inside the candidate, but from the base worktree (whose node_modules
  // links back here) it resolves outside both — so only the deferred suite capture refuses.
  mkdirSync(join(repo, "node_modules"));
  symlinkSync("../packages/pkg", join(repo, "node_modules", "pkg"), "dir");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  commit(repo);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await verify(["--no-review", "--json"], repo);
  expect(r.code, r.out).toBe(2);
  type Row = { gate: string; pass: boolean; details: string };
  const report = JSON.parse(r.out) as { green: boolean; artifactPath: string; artifactAvailability: string; results: Row[] };
  expect(report.green).toBe(false);
  expect(report.results.map((row) => [row.gate, row.pass])).toEqual([["build", true], ["test", false], ["lint", true], ["evidence", true]]);
  expect(report.results[1]!.details).toContain("OBS-1118 refusing verification");
  expect(report.artifactAvailability).toBe("available");
  const artifact = JSON.parse(readFileSync(report.artifactPath, "utf8")) as { green: boolean; gateRows: Row[] };
  expect(artifact.green).toBe(false);
  expect(artifact.gateRows).toEqual(report.results);
}, 120_000);
