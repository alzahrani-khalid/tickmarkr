import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_FORK_CAP, FORK_CAP_ENV, ROUTING_ENV_SEAMS as SCRUBBED_AT_SPAWN, createWorktree, gitHead, linkNodeModules, removeWorktree, sh, shOk, shGit, shGitOk, WORKTREES_DIR, worktreePath } from "../../src/run/git.js";
import { NO_EXPLORE_ENV, QUALITY_ENV, ROUTING_ENV_SEAMS } from "../../src/route/router.js";
import { makeRepo } from "../helpers/tmprepo.js";

describe("sh", () => {
  test("captures stdout/stderr/code", async () => {
    const r = await sh("echo out; echo err >&2; exit 3", "/tmp");
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
    expect(r.code).toBe(3);
  });

  test("timeout kills and reports timedOut, not a plain exit-1", async () => {
    const r = await sh("sleep 5", "/tmp", 300);
    expect(r.code).not.toBe(0);
    expect(r.timedOut).toBe(true);
  }, 10000);

  test("timeout resolves even when a grandchild keeps the stdio pipes open", async () => {
    // v1.33.1 init hang: SIGKILLing bash orphaned a background child that inherited our
    // stdout pipe, so "close" never fired. The background sleep here reproduces that.
    const t0 = Date.now();
    const r = await sh("sleep 30 & sleep 30", "/tmp", 300);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10000);

  test("stdin-reading command returns promptly (stdin ignored)", async () => {
    const t0 = Date.now();
    // cat blocks forever on an open stdin pipe; with stdin ignore it EOFs and exits.
    const r = await sh("cat", "/tmp", 5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.timedOut).not.toBe(true);
    expect(r.code).toBe(0);
  }, 10000);

  test("shOk throws with stderr", async () => {
    await expect(shOk("echo boom >&2; exit 1", "/tmp")).rejects.toThrow(/boom/);
  });

  test("internal git plumbing commands run without the login-shell flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "tickmarkr-shell-home-"));
    writeFileSync(join(home, ".bash_profile"), "export TICKMARKR_LOGIN_SOURCED=yes\n");
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await shGit("test -z \"$TICKMARKR_LOGIN_SOURCED\" && printf ok", "/tmp");
      expect(r).toMatchObject({ code: 0, stdout: "ok" });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

describe("routing env scrub at the spawn seam (OBS-74)", () => {
  test("the scrub list is imported from the router constants", () => {
    // reference identity: the seam scrubs the router's own exported list, not a hardcoded copy —
    // a rename or addition in router.ts cannot silently un-scrub the spawn seam
    expect(SCRUBBED_AT_SPAWN).toBe(ROUTING_ENV_SEAMS);
    expect(ROUTING_ENV_SEAMS).toEqual([QUALITY_ENV, NO_EXPLORE_ENV]);
  });

  test("the parent daemon environment remains unchanged after child execution", async () => {
    process.env[QUALITY_ENV] = "1";
    process.env[NO_EXPLORE_ENV] = "1";
    try {
      // ${VAR-unset}: distinguishes unset from set-but-empty — the child must see neither seam at all
      const r = await sh(`printf '%s|%s' "\${${QUALITY_ENV}-unset}" "\${${NO_EXPLORE_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe("unset|unset"); // scrubbed from the child...
      expect(process.env[QUALITY_ENV]).toBe("1"); // ...while the daemon's own env is untouched
      expect(process.env[NO_EXPLORE_ENV]).toBe("1");
    } finally {
      delete process.env[QUALITY_ENV];
      delete process.env[NO_EXPLORE_ENV];
    }
  });

  test("non-login git plumbing children are scrubbed too (same choke point)", async () => {
    process.env[QUALITY_ENV] = "1";
    try {
      const r = await shGit(`printf '%s' "\${${QUALITY_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe("unset");
    } finally {
      delete process.env[QUALITY_ENV];
    }
  });
});

describe("fork-cap default at the spawn seam (OBS-110)", () => {
  const resetForkCap = () => {
    const before = process.env[FORK_CAP_ENV];
    delete process.env[FORK_CAP_ENV];
    return before;
  };
  const restoreForkCap = (before: string | undefined) => {
    if (before === undefined) delete process.env[FORK_CAP_ENV];
    else process.env[FORK_CAP_ENV] = before;
  };

  test("a child spawned with no fork-cap variable in the parent environment receives the default value", async () => {
    const before = resetForkCap();
    try {
      const r = await sh(`printf '%s' "\${${FORK_CAP_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe(DEFAULT_FORK_CAP);
    } finally {
      restoreForkCap(before);
    }
  });

  test("a child spawned with the operator's own fork-cap variable already set in the parent environment keeps that value unchanged", async () => {
    const before = process.env[FORK_CAP_ENV];
    process.env[FORK_CAP_ENV] = "12";
    try {
      const r = await sh(`printf '%s' "\${${FORK_CAP_ENV}-unset}"`, "/tmp");
      expect(r.stdout).toBe("12");
    } finally {
      restoreForkCap(before);
    }
  });

  test("a plain git plumbing command spawned through the same helper still succeeds with the default variable present", async () => {
    const before = resetForkCap();
    try {
      const repo = makeRepo({ "a.txt": "hello\n" });
      const head = await gitHead(repo);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      restoreForkCap(before);
    }
  });
});

describe("worktrees", () => {
  test("worktreePath resolves under worktrees.noindex from the shared constant (OBS-49)", () => {
    // pure-ish: tickmarkrDir() mkdirs, so use a real temp root; both this and the merge path
    // derive the directory name from the single exported WORKTREES_DIR constant
    const repo = mkdtempSync(join(tmpdir(), "wt-path-"));
    expect(worktreePath(repo, "tickmarkr/run-1--T1")).toContain(
      join(".tickmarkr", WORKTREES_DIR, "tickmarkr-run-1--T1"),
    );
    expect(WORKTREES_DIR).toBe("worktrees.noindex");
  });

  test("createWorktree makes an isolated checkout on a new branch", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    // "--" not "/": a task branch must never nest under the integration branch ref (locked decision 10)
    const wt = await createWorktree(repo, "tickmarkr/run-1--T1", base);
    expect(wt).toContain(`.tickmarkr/${WORKTREES_DIR}/`);
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("hello\n");
    expect((await shOk("git branch --show-current", wt)).trim()).toBe("tickmarkr/run-1--T1");
    // recreating the same lane resets it instead of failing
    const wt2 = await createWorktree(repo, "tickmarkr/run-1--T1", base);
    expect(existsSync(wt2)).toBe(true);
  });

  test("metacharacter branch never executes shell injection (HARD-01)", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    const payload = "tickmarkr/run'; touch PWNED #";
    try {
      await createWorktree(repo, payload, base);
    } catch {
      // git may reject the malformed ref after quoting — either outcome is fine
    }
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  test("symlinks the repo's node_modules into a fresh worktree", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-2--T1", base);
    const link = join(wt, "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repo, "node_modules")));
    expect(readFileSync(join(link, "marker.txt"), "utf8")).toBe("root\n");
  });

  test("creates no link and no error when the repo has no node_modules", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-3--T1", base);
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
  });

  test("leaves an existing worktree node_modules untouched", async () => {
    // node_modules tracked in git: checkout gives both repo and worktree a real (non-symlink) copy
    const repo = makeRepo({ "a.txt": "hello\n", "node_modules/own.txt": "own\n" });
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-4--T1", base);
    const link = join(wt, "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(link, "own.txt"), "utf8")).toBe("own\n");
  });

  test("removeWorktree tears down a created worktree under the new path (OBS-49 lifecycle)", async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const base = await gitHead(repo);
    const wt = await createWorktree(repo, "tickmarkr/run-rm--T1", base);
    expect(existsSync(wt)).toBe(true);
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    // the lane directory under worktrees.noindex is gone
    expect(existsSync(worktreePath(repo, "tickmarkr/run-rm--T1"))).toBe(false);
  });
});

describe("linkNodeModules re-assert (OBS-47)", () => {
  const provisioning = (repo: string) => {
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
  };

  test("OBS-47: a removed node_modules link is re-asserted before the next attempt's gates (force)", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-reassert-"));
    provisioning(repo);
    const wt = mkdtempSync(join(tmpdir(), "wt-reassert-wt-"));
    expect(linkNodeModules(repo, wt)).toBe(true); // provisioned
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    rmSync(join(wt, "node_modules")); // a worker deleted the link
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true); // harness re-asserts it
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, "node_modules", "marker.txt"), "utf8")).toBe("root\n");
  });

  test("OBS-47: a worker-replaced real directory is restored to the provisioned link (force)", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-realdir-"));
    provisioning(repo);
    const wt = mkdtempSync(join(tmpdir(), "wt-realdir-wt-"));
    linkNodeModules(repo, wt);
    rmSync(join(wt, "node_modules"));
    mkdirSync(join(wt, "node_modules")); // worker replaced the link with a real directory
    writeFileSync(join(wt, "node_modules", "own.txt"), "worker\n");
    // lenient (provisioning) leaves the real dir untouched; force restores the provisioned link
    expect(linkNodeModules(repo, wt)).toBe(false);
    expect(lstatSync(join(wt, "node_modules")).isDirectory()).toBe(true);
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, "node_modules", "marker.txt"), "utf8")).toBe("root\n");
  });

  test("OBS-47: an already-correct link is idempotent under force", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-idem-"));
    provisioning(repo);
    const wt = mkdtempSync(join(tmpdir(), "wt-idem-wt-"));
    linkNodeModules(repo, wt);
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true); // no-op, still correct
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
  });

  test("OBS-47: no provisioned source is benign — nothing to link, never a failure", () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-nosrc-")); // no node_modules at the repo root
    const wt = mkdtempSync(join(tmpdir(), "wt-nosrc-wt-"));
    expect(linkNodeModules(repo, wt, { force: true })).toBe(true); // correct state is no link — not a parkable failure
    expect(existsSync(join(wt, "node_modules"))).toBe(false); // nothing created
  });
});

describe("worktree node_modules exclude (OBS-78)", () => {
  const provisionedWorktree = async (files: Record<string, string> = { "a.txt": "hello\n" }) => {
    const repo = makeRepo(files);
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "marker.txt"), "root\n");
    const wt = await createWorktree(repo, "tickmarkr/run-ex--T1", await gitHead(repo));
    return { repo, wt };
  };
  // the exclude file git actually consults for the worktree (linked worktrees share the common dir's)
  const excludeFile = async (wt: string) =>
    (await shGitOk("git rev-parse --path-format=absolute --git-path info/exclude", wt)).trim();

  test("staging all files in a provisioned worktree leaves the node_modules symlink unstaged", async () => {
    const { wt } = await provisionedWorktree();
    await shGitOk("git add -A", wt); // the OBS-78 worker move that committed the link
    const staged = await shGitOk("git diff --cached --name-only", wt);
    expect(staged).not.toMatch(/^node_modules$/m);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true); // link present, just unstageable
  });

  test("the provisioned worktree carries a git exclude entry for node_modules", async () => {
    const { wt } = await provisionedWorktree();
    expect(readFileSync(await excludeFile(wt), "utf8")).toMatch(/^node_modules$/m);
    const r = await shGit("git check-ignore -q node_modules", wt); // git itself honors it in the worktree
    expect(r.code).toBe(0);
  });

  test("a repeated re-assert leaves a single exclude entry", async () => {
    const { repo, wt } = await provisionedWorktree();
    linkNodeModules(repo, wt, { force: true }); // daemon re-asserts before every gate pass
    linkNodeModules(repo, wt, { force: true });
    expect(readFileSync(await excludeFile(wt), "utf8").match(/^node_modules$/gm)).toHaveLength(1);
  });

  test("the node_modules exclusion never edits the target repository gitignore", async () => {
    const { repo, wt } = await provisionedWorktree({ "a.txt": "hello\n", ".gitignore": "dist/\n" });
    linkNodeModules(repo, wt, { force: true }); // provision + re-assert both ran
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("dist/\n");
    expect(readFileSync(join(wt, ".gitignore"), "utf8")).toBe("dist/\n");
  });
});
