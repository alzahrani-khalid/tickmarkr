import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeRepo, makeTestTempDir, TEST_TEMP_ROOT } from "./tmprepo.js";

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

function spawnRunner(outFile: string): Promise<number | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")));
  const child = spawn(
    join("node_modules", ".bin", "vitest"),
    ["run", "--project", "suite", "tests/helpers/tmprepo.test.ts", "-t", CHILD_TEST],
    { cwd: process.cwd(), env: { ...env, [CHILD_ENV]: outFile }, stdio: "ignore" },
  );
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

async function waitFor(file: string): Promise<{ pid: number; repo: string; root: string }> {
  for (let i = 0; i < 600; i++) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    await sleep(100);
  }
  throw new Error(`child runner never reported to ${file}`);
}

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

