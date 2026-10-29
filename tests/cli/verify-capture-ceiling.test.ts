import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { baselineCachePath, verify } from "../../src/cli/commands/verify.js";
import * as git from "../../src/run/git.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// These tests measure capture timeouts through sh, so no suite process exists for the lease's
// process-tree census to reap. Keep the reservation outside this timing-only fixture.
vi.mock("../../src/run/lease.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/run/lease.js")>(),
  withRepositoryLease: async <T>(_cwd: string, run: () => Promise<T>) => run(),
}));

const minute = 60_000;
const command = "capture-ceiling-test";
const commands = { test: command };
const gitRun = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  vi.stubEnv("TMPDIR", realpathSync(makeTestTempDir("verify-ceiling-cache-")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fixture() {
  const repo = makeRepo({ ".gitignore": ".tickmarkr/\n", "src.txt": "base\n" });
  gitRun(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, "src.txt"), "feature\n");
  gitRun(repo, "commit", "-am", "feature", "--no-gpg-sign");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `gates: { test: ${command} }\n`);
  writeDoctor(repo, { fake: { installed: false, authed: false, models: [] } });
  return { repo, base: gitRun(repo, "rev-parse", "main") };
}

async function verified(repo: string) {
  const result = await verify(["--no-review"], repo);
  expect(result.code, result.out).toBe(0);
}

test("test: a verify capture killed at its ceiling leaves a marker recording the armed ceiling as its measured duration, and the next verify recaptures under exactly the ceiling that measurement scales to, so a recapture at thirty minutes fails", async () => {
  const { repo, base } = fixture();
  const armed: number[] = [];
  let kill = true;
  const original = git.sh;
  vi.spyOn(git, "sh").mockImplementation(async (cmd, cwd, timeout, opts) => {
    if (cmd !== command) return original(cmd, cwd, timeout, opts);
    const result = await original("true", cwd, timeout, opts);
    if (cwd === repo) return result;
    armed.push(timeout!);
    return kill ? { ...result, code: 137, timedOut: true, durationMs: timeout }
      : { ...result, durationMs: 28 * minute };
  });
  const cache = baselineCachePath(repo, base, commands);
  await verified(repo);
  expect(armed).toEqual([30 * minute]);
  expect(existsSync(cache)).toBe(false);
  const marker = JSON.parse(readFileSync(`${cache}.verdictless`, "utf8"));
  expect(marker).toEqual({ base, commands: ["test"], measurements: { test: { durationMs: 30 * minute, ceilingMs: 90 * minute } } });

  kill = false;
  await verified(repo);
  expect(armed).toEqual([30 * minute, 90 * minute]);
  expect(existsSync(`${cache}.verdictless`)).toBe(false);
  expect(JSON.parse(readFileSync(cache, "utf8")).commands.test).toMatchObject({ durationMs: 28 * minute, ceilingMs: 84 * minute });
});

test("test: a verify after a cached capture of the same commands at another base captures under the ceiling that capture's measurement scales to, so a prior read only at the same base fails", async () => {
  const { repo, base } = fixture();
  const armed: number[] = [];
  const original = git.sh;
  vi.spyOn(git, "sh").mockImplementation(async (cmd, cwd, timeout, opts) => {
    if (cmd !== command) return original(cmd, cwd, timeout, opts);
    if (cwd !== repo) armed.push(timeout!);
    return { ...await original("true", cwd, timeout, opts), durationMs: 28 * minute };
  });
  await verified(repo);
  const previous = baselineCachePath(repo, base, commands);
  expect(JSON.parse(readFileSync(previous, "utf8")).commands.test.ceilingMs).toBe(84 * minute);
  // Move the actual merge-base; the existing capture is now only timing evidence for this base.
  gitRun(repo, "checkout", "main");
  writeFileSync(join(repo, "base-only.txt"), "next base\n");
  gitRun(repo, "add", "base-only.txt");
  gitRun(repo, "commit", "-m", "next base", "--no-gpg-sign");
  const nextBase = gitRun(repo, "rev-parse", "HEAD");
  gitRun(repo, "checkout", "feature");
  gitRun(repo, "merge", "main", "--no-edit", "--no-gpg-sign");
  const next = baselineCachePath(repo, nextBase, commands);
  expect(next).not.toBe(previous);
  // A newer capture with different commands or runner must never supply timing.
  const unrelated = baselineCachePath(repo, "a".repeat(40), { test: "different-command" });
  writeFileSync(unrelated, JSON.stringify({ commands: { test: { durationMs: 10 * 60 * minute } } }));
  const otherRunner = previous.replace(/-[^-]+\.json$/, `-${"0".repeat(16)}.json`);
  writeFileSync(otherRunner, readFileSync(unrelated));
  await verified(repo);
  expect(armed).toEqual([30 * minute, 84 * minute]);

  // Both capture and marker are candidates; only the newest measurement for this command wins.
  const newerMarker = `${baselineCachePath(repo, "b".repeat(40), commands)}.verdictless`;
  mkdirSync(dirname(newerMarker), { recursive: true });
  writeFileSync(newerMarker, JSON.stringify({ base: "b".repeat(40), commands: ["test"], measurements: { test: { durationMs: 40 * minute, ceilingMs: 120 * minute } } }));
  const then = new Date(1_000);
  utimesSync(next, then, then);
  // Invalidate just the verdict cache at the current base, retaining its measured timing.
  const stale = JSON.parse(readFileSync(next, "utf8"));
  delete stale.commands.test.exitCode;
  writeFileSync(next, JSON.stringify(stale));
  utimesSync(next, then, then);
  await verified(repo);
  expect(armed.at(-1)).toBe(120 * minute);
});
