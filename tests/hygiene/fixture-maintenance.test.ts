import { execSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeRepo, quietGitInit, makeTestTempDir } from "../helpers/tmprepo.js";

// OBS-1067 (v2.5.7 run …152220: T6 ×3, T7 ×2 and one tip-verify parked as "authoring" on a vanished
// `.git/objects/maintenance.lock`): git's detached auto-maintenance raced fixture tree walks.
const cfg = (repo: string, key: string) =>
  execSync(`git config --get ${key}`, { cwd: repo, encoding: "utf8" }).trim();

test("test: a fixture repo from the shared seam and one from quietGitInit both carry gc.auto 0 and maintenance.auto false before their first commit, and a burst of commits followed by a recursive walk of the whole tree including .git completes with no maintenance lock ever present, so a fixture whose commit can spawn background git maintenance fails", () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  expect([cfg(repo, "gc.auto"), cfg(repo, "maintenance.auto")]).toEqual(["0", "false"]);

  const bare = makeTestTempDir("tickmarkr-quiet-");
  quietGitInit(bare, "trunk");
  expect([cfg(bare, "gc.auto"), cfg(bare, "maintenance.auto")]).toEqual(["0", "false"]);
  expect(execSync("git symbolic-ref --short HEAD", { cwd: bare, encoding: "utf8" }).trim()).toBe("trunk");

  // the behaviour the config buys: commits never leave a maintenance process behind, so the walk that
  // reds evidence-view/run-gates on the base (a readdir over .git) cannot meet a vanishing entry
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(repo, "a.txt"), `a${i}\n`);
    execSync(`git add -A && git commit -q --no-gpg-sign -m c${i}`, { cwd: repo });
  }
  const walk = readdirSync(repo, { recursive: true, withFileTypes: true });
  expect(walk.length).toBeGreaterThan(12);
  expect(existsSync(join(repo, ".git", "objects", "maintenance.lock"))).toBe(false);
});
