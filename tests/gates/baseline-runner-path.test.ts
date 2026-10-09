// Queue row 104 (D-1644): the test gate runs a manifested test command under its runner's child environment, which puts
// <cwd>/node_modules/.bin first on PATH; the baseline capture of the same command ran under the inherited PATH, so a bare
// repo-local runner resolved in the gate and was missing in the capture — an unmeasured baseline that forgave nothing.
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { captureBaseline } from "../../src/gates/baseline.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => { vi.unstubAllEnvs(); });

test("a bare repo-local vitest test command is captured under the test gate's runner PATH, so its baseline is measured rather than missing when the inherited PATH holds no node_modules/.bin", async () => {
  const repo = makeRepo({
    "tests/a.test.ts": 'test("alpha", () => expect(1).toBe(1));\n',
    "package.json": JSON.stringify({ type: "module" }),
  });
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
  // An inherited PATH that holds node and the base system only: no node_modules/.bin, no global runner.
  const bin = makeTestTempDir("row104-node-");
  symlinkSync(process.execPath, join(bin, "node"));
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  // premise: the bare command really cannot resolve on the inherited PATH alone
  expect(spawnSync("sh", ["-c", "command -v vitest"], { cwd: repo, env: process.env }).status).not.toBe(0);
  const entry = (await captureBaseline(repo, { test: "vitest run --globals" })).commands.test!;
  expect(entry.missingCommand).not.toBe(true);
  expect(entry.invalidCause).toBeUndefined();
  expect(entry.exitCode).toBe(0);
}, 60_000);

test("a caller-supplied capture environment reaches a manifested test capture and a tipTest capture under the test gate's runner PATH, so a supplied value is never discarded", async () => {
  const repo = makeRepo({
    "tests/a.test.ts": 'test("supplied", () => expect(process.env.ROW104_SUPPLIED).toBe("explicit-value"));\n',
    "package.json": JSON.stringify({ type: "module" }),
  });
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
  const bin = makeTestTempDir("row104-env-node-");
  symlinkSync(process.execPath, join(bin, "node"));
  // D-1659 (review M1): the evidence environment is the caller's contract; the runner PATH is built on it, never in its place
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ROW104_SUPPLIED: "explicit-value" };
  expect(spawnSync("sh", ["-c", "command -v vitest"], { cwd: repo, env }).status).not.toBe(0);
  const base = await captureBaseline(repo, { test: "vitest run --globals", tipTest: "vitest run --globals tests/a.test.ts" },
    { evidence: { artifactDir: makeTestTempDir("row104-evidence-"), env } });
  for (const name of ["test", "tipTest"]) {
    expect(base.commands[name]!.missingCommand, name).not.toBe(true);
    expect(base.commands[name]!.exitCode, name).toBe(0);
  }
}, 120_000);
