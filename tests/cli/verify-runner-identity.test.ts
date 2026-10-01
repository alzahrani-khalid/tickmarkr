import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { baselineCachePath, verify } from "../../src/cli/commands/verify.js";
import { runnerInputsHash } from "../../src/gates/cache.js";
import { NATIVE_PROCESS_TITLE_ENV, resetTitleEnvironmentForTests, setTitleEnvironmentForTests } from "../../src/run/title-environment.js";
import { COMMIT, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const commands = { test: "npm run -s test" };
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const restoreEnv = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
const prior = { options: process.env.NODE_OPTIONS, optOut: process.env[NATIVE_PROCESS_TITLE_ENV] };
afterEach(() => {
  restoreEnv("NODE_OPTIONS", prior.options); restoreEnv(NATIVE_PROCESS_TITLE_ENV, prior.optOut);
  resetTitleEnvironmentForTests(); vi.restoreAllMocks();
});

function fixture(verdictless = false) {
  const scratch = makeTestTempDir("tickmarkr-verify-runner-");
  const calls = join(scratch, "calls");
  const flag = join(scratch, "no-verdict");
  const preload = join(scratch, "title-preload.cjs");
  writeFileSync(preload, "// effective preload A\n");
  process.env.NODE_OPTIONS = "--stack-trace-limit=17";
  delete process.env[NATIVE_PROCESS_TITLE_ENV];
  setTitleEnvironmentForTests({ platform: "darwin", preloadPath: preload });
  const repo = makeRepo({
    "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "check.sh": `printf '%s|%s\\n' "$PWD" "\${NODE_OPTIONS:-}" >> '${calls}'\n` +
      (verdictless ? `if test -e '${flag}'; then echo 'Error: spawn EAGAIN'; exit 1; fi\n` : ""),
    "src.txt": "base\n",
  });
  git(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  execFileSync("sh", ["-c", `${COMMIT} feature`], { cwd: repo });
  return { repo, calls, flag, preload, base: git(repo, "merge-base", "main", "HEAD") };
}
const calledOptions = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : [];

test("D-825: standalone verify automatically recaptures changed effective Darwin runner identities and reuses unchanged identities at the same base, lockfiles and commands", async () => {
  const f = fixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const own = process.env.NODE_OPTIONS!;
  const preloaded = `${own} --require "${f.preload}"`;
  const extraOptions = `${own} --trace-warnings`;
  const movedPreload = join(f.repo, "..", "moved-title-preload.cjs");
  const acceptedProbe = (() => ({ status: 0, signal: null })) as unknown as typeof import("node:child_process").spawnSync;
  const refusedProbe = (() => ({ status: 7, signal: null })) as unknown as typeof import("node:child_process").spawnSync;
  const paths: string[] = [];
  let calls = 0;
  const steps = [
    { options: preloaded, reused: false },
    { options: preloaded, reused: true },
    { change: () => writeFileSync(f.preload, "// effective preload B\n"), options: preloaded, reused: false },
    { options: preloaded, reused: true },
    { change: () => setTitleEnvironmentForTests({ probe: refusedProbe }), options: own, reused: false },
    { options: own, reused: true },
    // Opt-out and refusal are the SAME effective native identity, so keep that reuse.
    { change: () => { process.env[NATIVE_PROCESS_TITLE_ENV] = "1"; setTitleEnvironmentForTests({ probe: acceptedProbe }); }, options: own, reused: true },
    { change: () => { delete process.env[NATIVE_PROCESS_TITLE_ENV]; }, options: preloaded, reused: true },
    // Change inherited options alone, then repeat that exact effective identity.
    { change: () => { process.env.NODE_OPTIONS = extraOptions; }, options: `${extraOptions} --require "${f.preload}"`, reused: false },
    { options: `${extraOptions} --require "${f.preload}"`, reused: true },
    // Keep preload content and inherited options fixed; change only the effective preload path.
    { change: () => { writeFileSync(movedPreload, readFileSync(f.preload)); setTitleEnvironmentForTests({ preloadPath: movedPreload }); }, options: `${extraOptions} --require "${movedPreload}"`, reused: false },
    { options: `${extraOptions} --require "${movedPreload}"`, reused: true },
  ];
  for (const step of steps) {
    const previousHash = runnerInputsHash();
    step.change?.(); errors.mockClear();
    const inputsHash = runnerInputsHash();
    if (!step.reused && paths.length) expect(inputsHash).not.toBe(previousHash);
    const path = baselineCachePath(f.repo, f.base, commands);
    expect(path).toContain(inputsHash);
    const result = await verify(["--no-review"], f.repo);
    expect(result.code, result.out).toBe(0);
    expect(existsSync(path)).toBe(true);
    const lines = errors.mock.calls.flat().join("\n");
    expect(lines.includes("reusing cached baseline")).toBe(step.reused);
    expect(lines.includes("capturing baseline at merge-base")).toBe(!step.reused);
    const added = calledOptions(f.calls).slice(calls);
    // Candidate verdict reuse may skip its command too. Count actual BASE worktree executions
    // independently, so this asserts automatic baseline invalidation rather than hand capture.
    expect(added.filter(row => row.split("|")[0] !== realpathSync(f.repo))).toHaveLength(step.reused ? 0 : 1);
    if (!step.reused) expect(added).toHaveLength(2); // fresh baseline and fresh candidate
    expect(added.every(row => row.slice(row.indexOf("|") + 1) === step.options)).toBe(true);
    calls += added.length; paths.push(path);
  }
  expect(paths[0]).toBe(paths[1]);
  expect(paths[2]).not.toBe(paths[0]);
  expect(paths[2]).toBe(paths[3]);
  expect(paths[4]).not.toBe(paths[2]);
  expect(paths[4]).toBe(paths[5]);
  expect(paths[4]).toBe(paths[6]);
  expect(paths[7]).toBe(paths[2]);
  expect(paths[8]).not.toBe(paths[7]);
  expect(paths[9]).toBe(paths[8]);
  expect(paths[10]).not.toBe(paths[9]);
  expect(paths[11]).toBe(paths[10]);
}, 60_000);

test("D-825: verdictless markers follow the effective runner cache key, trigger recapture only for that identity and are removed only by its healthy capture", async () => {
  const f = fixture(true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  writeFileSync(f.flag, "refuse\n");
  const preloadCache = baselineCachePath(f.repo, f.base, commands);
  await verify(["--no-review"], f.repo);
  expect(existsSync(preloadCache)).toBe(false);
  expect(existsSync(`${preloadCache}.verdictless`)).toBe(true);

  process.env[NATIVE_PROCESS_TITLE_ENV] = "1";
  const nativeCache = baselineCachePath(f.repo, f.base, commands);
  expect(nativeCache).not.toBe(preloadCache);
  expect(existsSync(`${nativeCache}.verdictless`)).toBe(false);
  errors.mockClear();
  await verify(["--no-review"], f.repo);
  expect(errors.mock.calls.flat().join("\n")).not.toContain("prior baseline recorded no verdict");
  expect(existsSync(`${nativeCache}.verdictless`)).toBe(true);
  expect(existsSync(nativeCache)).toBe(false);

  rmSync(f.flag); errors.mockClear();
  const native = await verify(["--no-review"], f.repo);
  expect(native.code, native.out).toBe(0);
  expect(String(errors.mock.calls[0]?.[0])).toContain("prior baseline recorded no verdict");
  expect(existsSync(nativeCache)).toBe(true);
  expect(existsSync(`${nativeCache}.verdictless`)).toBe(false);
  expect(existsSync(`${preloadCache}.verdictless`)).toBe(true);

  delete process.env[NATIVE_PROCESS_TITLE_ENV]; errors.mockClear();
  const preload = await verify(["--no-review"], f.repo);
  expect(preload.code, preload.out).toBe(0);
  expect(String(errors.mock.calls[0]?.[0])).toContain("prior baseline recorded no verdict");
  expect(existsSync(preloadCache)).toBe(true);
  expect(existsSync(`${preloadCache}.verdictless`)).toBe(false);
  expect(existsSync(nativeCache)).toBe(true);
}, 60_000);
