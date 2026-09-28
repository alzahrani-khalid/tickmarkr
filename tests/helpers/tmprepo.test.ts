import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { CHILD_REPORT_DEADLINE_MS, makeRepo, makeTestTempDir, readChildReport, recordTmpdirChild, TEST_TEMP_ROOT, TMPDIR_CHILD_ENV, TMPDIR_CHILD_TEST } from "./tmprepo.js";

const CHILD_ENV = "TICKMARKR_TMPREPO_CHILD";
const CHILD_TEST = "child runner: plant one fixture repository and hold it until released";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs only inside a child vitest spawned by the parallel-runner test below: plants a fixture
// repository, reports its path + pid, then holds the fixture until the parent releases it.
test.skipIf(!process.env[CHILD_ENV])(CHILD_TEST, async () => {
  const outFile = process.env[CHILD_ENV]!;
  const repo = makeRepo({ "f.txt": "x\n" });
  writeFileSync(outFile, JSON.stringify({ pid: process.pid, repo, root: TEST_TEMP_ROOT }));
  for (let i = 0; i < 300 && !existsSync(`${outFile}.release`); i++) await sleep(100);
}, 60_000);

// OBS-1155: the second, green file of tests/config/tmpdir.test.ts's single-fork child run.
test.skipIf(!process.env[TMPDIR_CHILD_ENV])(TMPDIR_CHILD_TEST, () => { recordTmpdirChild("passing.json"); });

function spawnRunner(outFile: string): Promise<number | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")));
  const child = spawn(
    join("node_modules", ".bin", "vitest"),
    ["run", "--project", "suite", "tests/helpers/tmprepo.test.ts", "-t", CHILD_TEST],
    { cwd: process.cwd(), env: { ...env, [CHILD_ENV]: outFile }, stdio: "ignore" },
  );
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

type Report = { pid: number; repo: string; root: string };
const waitFor = (file: string) => readChildReport<Report>(file);

describe("child-report reader (OBS-1200)", () => {
  test("test: the tmprepo child-report reader returns a complete report when its writer creates an empty file before delayed JSON completion but fails a permanently malformed report at the existing deadline, so an early parse exception or unbounded wait fails", async () => {
    const dir = makeTestTempDir("tickmarkr-report-");
    const report = { pid: 7, repo: join(dir, "r"), root: dir };

    // the writer's create-then-write schedule: an empty file, then a partial prefix, then the whole report
    const delayed = join(dir, "delayed.json");
    writeFileSync(delayed, "");
    const writer = (async () => {
      await sleep(250);
      writeFileSync(delayed, JSON.stringify(report).slice(0, 12));
      await sleep(250);
      writeFileSync(delayed, JSON.stringify(report));
    })();
    const started = Date.now();
    await expect(readChildReport<Report>(delayed)).resolves.toEqual(report);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await writer;

    // a report that never completes fails at the deadline, naming its bytes — never before, never later
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json");
    const deadline = 700;
    const before = Date.now();
    await expect(readChildReport(malformed, deadline)).rejects.toThrow(/incomplete after 700 ms: "\{ not json"/);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(deadline);
    expect(elapsed).toBeLessThan(deadline + 2_000);
    expect(CHILD_REPORT_DEADLINE_MS).toBe(60_000); // the production caller keeps the 600 × 100 ms bound
  }, 20_000);
});

describe("battery hygiene: per-runner temp namespaces (OBS-1054)", () => {
  test("test: two vitest runners of one suite file started in parallel each create their fixtures under a namespace root that carries that runner's process id and a nonce, and a deliberate removal of one runner's whole namespace root leaves the other runner's fixture repository and its .git/objects intact, so a helper whose directories share one flat prefix across runners fails", async () => {
    const scratch = makeTestTempDir("tickmarkr-runners-");
    const outA = join(scratch, "a.json");
    const outB = join(scratch, "b.json");
    const exitA = spawnRunner(outA);
    const exitB = spawnRunner(outB);
    try {
      const [a, b] = await Promise.all([waitFor(outA), waitFor(outB)]);
      expect(a.pid).not.toBe(b.pid);
      for (const r of [a, b]) {
        expect(dirname(r.repo)).toBe(r.root); // the fixture sits directly under the runner's root
        expect(dirname(r.root)).toBe(join(dirname(TEST_TEMP_ROOT))); // shared parent, distinct roots
        expect(basename(r.root)).toMatch(new RegExp(`^${r.pid}-[0-9a-f]{8}$`)); // pid + nonce
      }
      expect(a.root).not.toBe(b.root);
      expect(existsSync(join(b.repo, ".git", "objects"))).toBe(true);
      expect(existsSync(join(a.repo, ".git", "objects"))).toBe(true);

      rmSync(a.root, { recursive: true, force: true }); // wipe runner A wholesale
      expect(existsSync(a.repo)).toBe(false);
      expect(existsSync(b.repo)).toBe(true);
      expect(readdirSync(join(b.repo, ".git", "objects")).length).toBeGreaterThan(0);
      expect(readFileSync(join(b.repo, "f.txt"), "utf8")).toBe("x\n");
    } finally {
      writeFileSync(`${outA}.release`, "");
      writeFileSync(`${outB}.release`, "");
      await Promise.all([exitA, exitB]);
    }
  }, 120_000);

  test("test: reapTestTempDirs removes exactly the directories this runner recorded, proven by an unrecorded sibling directory planted under the same namespace root that survives the reap while every recorded directory is gone, so a teardown that sweeps by prefix or by parent directory fails", async () => {
    const { reapTestTempDirs } = await import("./tmprepo.js");
    const recorded = [makeTestTempDir("tickmarkr-recorded-"), makeTestTempDir("tickmarkr-recorded-")];
    const sibling = join(TEST_TEMP_ROOT, "tickmarkr-recorded-unrecorded");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "keep.txt"), "keep\n");
    try {
      reapTestTempDirs();
      for (const d of recorded) expect(existsSync(d)).toBe(false);
      expect(statSync(sibling).isDirectory()).toBe(true);
      expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(TEST_TEMP_ROOT)).toBe(true);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

