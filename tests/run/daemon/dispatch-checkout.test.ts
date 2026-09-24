import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { Slot } from "../../../src/drivers/types.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

test("test: a worker whose launch line runs from the enclosing checkout instead of its task worktree still commits on its task branch because the dispatch script enters the worktree itself, so a payload that commits in the operator's checkout fails", async () => {
  const { repo, fake } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: `echo isolated > worker.txt && ${COMMIT} isolated-worker`, result: { ok: true, summary: "committed" } }] },
  });
  const originalHead = git(repo, "rev-parse", "HEAD");
  let taskBranch = "";
  class MisplacedDriver extends SubprocessDriver {
    override async run(slot: Slot, cmd: string): Promise<void> {
      if (slot.name.includes("-worker-")) {
        taskBranch = git(slot.cwd, "branch", "--show-current");
        return super.run({ ...slot, cwd: repo }, cmd);
      }
      return super.run(slot, cmd);
    }
  }
  const result = await runDaemon(repo, { adapters: [fake], driver: new MisplacedDriver(), runId: "run-dispatch-checkout" });
  expect(result.done).toEqual(["T1"]);
  expect(git(repo, "rev-parse", "HEAD")).toBe(originalHead);
  expect(existsSync(join(repo, "worker.txt"))).toBe(false);
  expect(taskBranch).not.toBe("main");
  expect(git(repo, "log", "-1", "--format=%s", taskBranch)).toBe("isolated-worker");
}, 30_000);

test("test: a dispatch script whose task worktree is absent exits nonzero before the worker command runs and leaves no commit on any branch, so a script that falls through to the enclosing checkout fails", async () => {
  const { repo, fake } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: `echo escaped > worker.txt && ${COMMIT} escaped-worker`, result: { ok: true, summary: "committed" } }] },
  });
  const originalCommits = git(repo, "rev-list", "--all");
  const statuses: Array<number | null> = [];
  class MissingCheckoutDriver extends SubprocessDriver {
    override async run(slot: Slot, cmd: string): Promise<void> {
      if (!slot.name.includes("-worker-")) return super.run(slot, cmd);
      const moved = `${slot.cwd}-temporarily-absent`;
      renameSync(slot.cwd, moved);
      try {
        const result = spawnSync("bash", ["-c", cmd], { cwd: repo, encoding: "utf8" });
        statuses.push(result.status);
      } finally {
        renameSync(moved, slot.cwd);
      }
      throw new Error("dispatch exited before worker startup");
    }
  }
  const result = await runDaemon(repo, { adapters: [fake], driver: new MissingCheckoutDriver(), runId: "run-dispatch-absent" });
  expect(result.done).toEqual([]);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((status) => status !== null && status !== 0)).toBe(true);
  expect(existsSync(join(repo, "worker.txt"))).toBe(false);
  expect(git(repo, "rev-list", "--all")).toBe(originalCommits);
}, 30_000);
