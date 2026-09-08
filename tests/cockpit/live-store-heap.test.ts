import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { ORDINARY_HEAP_CAPTURE_PATH } from "../fixtures/operator-state/fixture.js";

const ROOT = resolve(import.meta.dirname, "../..");
const harness = join(ROOT, "tests/fixtures/operator-state/heap-runner.mjs");
function run(shape: string, production: boolean, destination: string): Promise<void> {
  const env = { ...process.env };
  delete env.NODE_ENV; delete env.CI; delete env.CONTINUOUS_INTEGRATION;
  if (production) env.NODE_ENV = "production";
  return new Promise((resolveRun, reject) => {
    const oldSpaceMiB = production ? 2048 : 8192;
    const child = spawn(process.execPath, ["--import", "tsx", "--expose-gc", `--max-old-space-size=${oldSpaceMiB}`, harness, shape, destination], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error = (error + chunk).slice(-4000); });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 240000);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else reject(new Error(`heap ${shape}: exit ${code}: ${error}`));
    });
  });
}

test("the ordinary-environment heap result survives the test's cleanup at a printed stable path whose JSON names the measured source commit, a null NODE_ENV, the verdict, the performance-entry count and any first failure, so a result written only inside the removed temp dir fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-heap-tests-"));
  const stablePath = ORDINARY_HEAP_CAPTURE_PATH;
  rmSync(stablePath, { force: true });
  try {
    for (const [shape, production] of [["static", true], ["growth", true], ["resize", true], ["static", false]] as const) {
      const path = join(dir, `${shape}-${production}.json`);
      await run(shape, production, path);
      const result = JSON.parse(readFileSync(path, "utf8"));
      expect(result.protocol).toBe("C2-production-mount-v1");
      expect(result.samples.map((s: { tick: number }) => s.tick)).toEqual(Array.from({ length: 11 }, (_, i) => (i + 1) * 1000));
      expect(result.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(result.warmupTicks).toBe(1000); expect(result.measuredTicks).toBe(10000);
      expect(result.environment.NODE_ENV).toBe(production ? "production" : null);
      expect(result.writes).toBeGreaterThan(1000); expect(result.bytes).toBeGreaterThan(100000);
      expect(result.lastFrame.length).toBeLessThanOrEqual(20000); expect(result.lastFrame).toContain("heap-fixture");
      expect(result.pendingOutputBytes).toBe(0);
      for (const sample of result.samples) {
        expect(sample.pid).toBe(result.pid); expect(sample.timestamp).toMatch(/^202\d-/); expect(sample.rss).toBeGreaterThan(0);
        expect(sample.store.pendingReads).toBe(0); expect(sample.store.metrics).toBeLessThanOrEqual(12);
        if (production) expect(sample.heap).toBeLessThanOrEqual(64 * 1024 * 1024);
      }
      if (production) {
        expect(result.verdict).toBe("pass"); expect(result.lateGrowth).toBeLessThanOrEqual(16 * 1024 * 1024);
      } else {
        copyFileSync(path, stablePath);
        console.info(`Retained ordinary-environment heap capture: ${stablePath}`);
        console.info("C1 ordinary-environment baseline", JSON.stringify({ verdict: result.verdict, heap: result.peak, performanceMeasures: result.performanceMeasures, firstFailure: result.firstFailure }));
        expect(["pass", "fail"]).toContain(result.verdict);
        expect(typeof result.performanceMeasures).toBe("number");
        if (result.verdict === "fail") expect(result.firstFailure).toMatchObject({ root: "node:perf_hooks performance timeline", performanceMeasures: expect.any(Number) });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  expect(existsSync(dir)).toBe(false);
  expect(existsSync(join(dir, "static-false.json"))).toBe(false);
  expect(existsSync(stablePath)).toBe(true);
  expect(resolve(stablePath).startsWith(resolve(dir))).toBe(false);

  const retained = JSON.parse(readFileSync(stablePath, "utf8"));
  expect(retained.protocol).toBe("C2-production-mount-v1");
  expect(retained.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(retained.environment.NODE_ENV).toBeNull();
  expect(["pass", "fail"]).toContain(retained.verdict);
  expect(typeof retained.performanceMeasures).toBe("number");
  if (retained.verdict === "fail") {
    expect(retained.firstFailure).toMatchObject({
      root: "node:perf_hooks performance timeline",
      performanceMeasures: expect.any(Number),
    });
  } else {
    expect(retained.firstFailure).toBeUndefined();
  }

  const transientDir = mkdtempSync(join(tmpdir(), "operator-heap-transient-"));
  const transientFile = join(transientDir, "static-false.json");
  writeFileSync(transientFile, JSON.stringify(retained));
  expect(existsSync(transientFile)).toBe(true);
  rmSync(transientDir, { recursive: true, force: true });
  expect(existsSync(transientFile)).toBe(false);
}, 1_000_000);
