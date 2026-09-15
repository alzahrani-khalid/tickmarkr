import { execFileSync, execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { COMMAND_HELP, commandHelp } from "../../src/cli/help.js";
import { dispatch } from "../../src/cli/index.js";
import { specTemplate } from "../../src/compile/native.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { createWorktree, gitHead } from "../../src/run/git.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

function makeWorkspaceRepo(root: string, files: Record<string, string> = {}): string {
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, encoding: "utf8" });
  git("init -b main");
  git("config user.email tickmarkr@test.local");
  git("config user.name tickmarkr-test");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git("add -A");
  git("commit -m init --no-gpg-sign");
  return dir;
}

describe("init --remove (OBS-1029)", () => {
  test("test: init --remove over a repository carrying CLAUDE.md that init --agent --docs scaffolded and a run registered a worktree in deletes the .tickmarkr directory, all three shipped skill directories at both host locations and exactly the marker-bounded block of AGENTS.md and CLAUDE.md leaving every byte outside the markers identical, deletes the scaffold spec while it equals the shipped template and keeps it once edited, leaves git worktree list without the registered worktree, keeps the global config byte-identical, and prints each tickmarkr branch and preserved ref still present, so a remove that scaffolds, probes, deletes an edited spec, a line outside the markers or a branch, or leaves the state directory behind fails", async () => {
    const allAdaptersSpy = vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const root = makeTestTempDir("tickmarkr-init-remove-");
    const claudeInitial = "# Project Claude\n\nGuidelines line 1\nGuidelines line 2\n";
    const agentsInitial = "# Project Agents\n\nGuidelines rule 1\n";
    const repo = makeWorkspaceRepo(root, {
      "CLAUDE.md": claudeInitial,
      "AGENTS.md": agentsInitial,
    });

    const globalDir = join(root, "global");
    mkdirSync(globalDir, { recursive: true });
    const globalConfigPath = join(globalDir, "config.yaml");
    writeFileSync(globalConfigPath, "preserved_key: preserved_val\n");
    const globalBytes = readFileSync(globalConfigPath);

    // Step 1: run init --agent --docs
    await init(["--global-dir", globalDir, "--agent", "--docs", "--yes"], repo);

    // Verify scaffolding happened
    const stateDir = tickmarkrDir(repo);
    expect(existsSync(stateDir)).toBe(true);
    for (const skill of ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"]) {
      expect(existsSync(join(repo, ".agents", "skills", skill))).toBe(true);
      expect(existsSync(join(repo, ".claude", "skills", skill))).toBe(true);
    }
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("<!-- tickmarkr:agent-docs begin -->");
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("<!-- tickmarkr:agent-docs begin -->");
    expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(true);
    expect(readFileSync(join(repo, "tickmarkr.spec.md"), "utf8")).toBe(specTemplate());

    // Step 2: a run registered a worktree in it
    const base = await gitHead(repo);
    const wtBranch = "tickmarkr/run-20260912-215149--T10";
    const wtPath = await createWorktree(repo, wtBranch, base);
    expect(existsSync(wtPath)).toBe(true);

    // Also add a preserved ref
    const preservedCommit = (await gitHead(repo)).trim();
    const preservedRef = `refs/tickmarkr/preserved/${preservedCommit}`;
    execFileSync("git", ["update-ref", preservedRef, preservedCommit], { cwd: repo });

    // Verify worktree is in git worktree list
    const wtListBefore = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    expect(wtListBefore).toContain("worktrees.noindex");
    // Capture exact bytes outside the markers before remove
    const claudeRaw = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    const claudeBegin = claudeRaw.indexOf("<!-- tickmarkr:agent-docs begin -->");
    const claudeEnd = claudeRaw.indexOf("<!-- tickmarkr:agent-docs end -->") + "<!-- tickmarkr:agent-docs end -->".length;
    const claudeExpected = claudeRaw.slice(0, claudeBegin) + claudeRaw.slice(claudeEnd);

    const agentsRaw = readFileSync(join(repo, "AGENTS.md"), "utf8");
    const agentsBegin = agentsRaw.indexOf("<!-- tickmarkr:agent-docs begin -->");
    const agentsEnd = agentsRaw.indexOf("<!-- tickmarkr:agent-docs end -->") + "<!-- tickmarkr:agent-docs end -->".length;
    const agentsExpected = agentsRaw.slice(0, agentsBegin) + agentsRaw.slice(agentsEnd);

    // Step 3: Run init --remove
    allAdaptersSpy.mockClear();
    const out = await init(["--global-dir", globalDir, "--remove"], repo);
    expect(allAdaptersSpy).not.toHaveBeenCalled();

    // 1. Deletes .tickmarkr directory
    expect(existsSync(stateDir)).toBe(false);

    // 2. Deletes all three shipped skill directories at both host locations
    for (const skill of ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"]) {
      expect(existsSync(join(repo, ".agents", "skills", skill))).toBe(false);
      expect(existsSync(join(repo, ".claude", "skills", skill))).toBe(false);
    }

    // 3. Exactly the marker-bounded block of AGENTS.md and CLAUDE.md is deleted leaving every byte outside identical
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(claudeExpected);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(agentsExpected);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).not.toContain("<!-- tickmarkr:agent-docs");
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).not.toContain("<!-- tickmarkr:agent-docs");
    // 4. Deletes scaffold spec while it equals the shipped template
    expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(false);

    // 5. Leaves git worktree list without the registered worktree
    const wtListAfter = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    expect(wtListAfter).not.toContain("worktrees.noindex");

    // 6. Keeps global config byte-identical
    expect(readFileSync(globalConfigPath)).toEqual(globalBytes);

    // 7. Prints each tickmarkr branch and preserved ref still present
    expect(out).toContain(wtBranch);
    expect(out).toContain(preservedRef);

    // 8. Never deleting a branch or a ref
    const branches = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/tickmarkr/"], { cwd: repo, encoding: "utf8" });
    expect(branches).toContain(wtBranch);
    const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/tickmarkr/preserved/"], { cwd: repo, encoding: "utf8" });
    expect(refs).toContain(preservedRef);

    // 9. "and keeps it once edited": test that an edited spec is kept
    const editedSpec = "# Author Spec\n\n- acceptance:\n  - something\n";
    writeFileSync(join(repo, "tickmarkr.spec.md"), editedSpec);
    allAdaptersSpy.mockClear();
    await init(["--global-dir", globalDir, "--remove"], repo);
    expect(allAdaptersSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(repo, "tickmarkr.spec.md"), "utf8")).toBe(editedSpec);
  });

  test("test: init --remove while graph.lock names the test's own live pid exits non-zero naming that pid with every path it would delete byte-identical afterwards, and the same workspace once the lock names a reaped child's pid proceeds to the deletion, so a remove that treats the lock as advisory or refuses a dead holder fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);

    const root = makeTestTempDir("tickmarkr-init-remove-lock-");
    const claudeInitial = "# Claude\nGuidance\n";
    const agentsInitial = "# Agents\nGuidance\n";
    const repo = makeWorkspaceRepo(root, {
      "CLAUDE.md": claudeInitial,
      "AGENTS.md": agentsInitial,
    });

    const globalDir = join(root, "global");
    mkdirSync(globalDir, { recursive: true });
    await init(["--global-dir", globalDir, "--agent", "--docs", "--yes"], repo);

    // Add a registered worktree
    const base = await gitHead(repo);
    const wtBranch = "tickmarkr/run-lock--T1";
    await createWorktree(repo, wtBranch, base);

    // Plant graph.lock with test's own live pid
    const stateDir = tickmarkrDir(repo);
    const lockPath = join(stateDir, "graph.lock");
    const livePayload = JSON.stringify({ pid: process.pid, runId: "run-live-test", startedAt: Date.now() });
    writeFileSync(lockPath, livePayload);

    // Take a full snapshot of all paths in the repo that would be deleted
    const snapshotBefore = {
      lock: readFileSync(lockPath, "utf8"),
      repoConfig: readFileSync(join(stateDir, "config.yaml"), "utf8"),
      spec: readFileSync(join(repo, "tickmarkr.spec.md"), "utf8"),
      claude: readFileSync(join(repo, "CLAUDE.md"), "utf8"),
      agents: readFileSync(join(repo, "AGENTS.md"), "utf8"),
      skillsAgentsLoop: readFileSync(join(repo, ".agents", "skills", "tickmarkr-loop", "SKILL.md"), "utf8"),
      skillsClaudeLoop: readFileSync(join(repo, ".claude", "skills", "tickmarkr-loop", "SKILL.md"), "utf8"),
      worktreeList: execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }),
    };

    // Run init --remove directly: must reject naming process.pid
    await expect(init(["--remove"], repo)).rejects.toThrow(new RegExp(String(process.pid)));

    // Run init --remove via dispatch: exits non-zero naming process.pid
    const dispatchResult = await dispatch("init", ["--remove"], {
      init: (argv) => init(argv, repo),
    });
    expect(dispatchResult.code).not.toBe(0);
    expect(dispatchResult.out).toContain(String(process.pid));

    // Verify every path it would delete is byte-identical afterwards
    expect(readFileSync(lockPath, "utf8")).toBe(snapshotBefore.lock);
    expect(readFileSync(join(stateDir, "config.yaml"), "utf8")).toBe(snapshotBefore.repoConfig);
    expect(readFileSync(join(repo, "tickmarkr.spec.md"), "utf8")).toBe(snapshotBefore.spec);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(snapshotBefore.claude);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(snapshotBefore.agents);
    expect(readFileSync(join(repo, ".agents", "skills", "tickmarkr-loop", "SKILL.md"), "utf8")).toBe(snapshotBefore.skillsAgentsLoop);
    expect(readFileSync(join(repo, ".claude", "skills", "tickmarkr-loop", "SKILL.md"), "utf8")).toBe(snapshotBefore.skillsClaudeLoop);
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).toBe(snapshotBefore.worktreeList);

    // Now name a reaped child's pid in the lock
    const child = spawnSync("node", ["-e", "process.exit(0)"]);
    const deadPid = child.pid!;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, runId: "run-dead-test", startedAt: Date.now() }));

    // The same workspace once the lock names a reaped child's pid proceeds to the deletion
    await init(["--remove"], repo);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(false);
    for (const skill of ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"]) {
      expect(existsSync(join(repo, ".agents", "skills", skill))).toBe(false);
      expect(existsSync(join(repo, ".claude", "skills", skill))).toBe(false);
    }
    const claudeExpected2 = snapshotBefore.claude.slice(0, snapshotBefore.claude.indexOf("<!-- tickmarkr:agent-docs begin -->")) + snapshotBefore.claude.slice(snapshotBefore.claude.indexOf("<!-- tickmarkr:agent-docs end -->") + "<!-- tickmarkr:agent-docs end -->".length);
    const agentsExpected2 = snapshotBefore.agents.slice(0, snapshotBefore.agents.indexOf("<!-- tickmarkr:agent-docs begin -->")) + snapshotBefore.agents.slice(snapshotBefore.agents.indexOf("<!-- tickmarkr:agent-docs end -->") + "<!-- tickmarkr:agent-docs end -->".length);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(claudeExpected2);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(agentsExpected2);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).not.toContain("<!-- tickmarkr:agent-docs");
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).not.toContain("<!-- tickmarkr:agent-docs");
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).not.toContain("worktrees.noindex");
  });

  test("test: init --help lists --remove with a description beside every other init flag and the init parser accepts --remove without an unknown-option error, so a parser flag the help registry omits fails", async () => {
    const helpOut = commandHelp("init");
    expect(COMMAND_HELP.init.options["--remove"]).toBeDefined();
    expect(COMMAND_HELP.init.options["--remove"].length).toBeGreaterThan(15);
    expect(helpOut).toContain("--remove");
    expect(helpOut).toContain(COMMAND_HELP.init.options["--remove"]);

    // beside every other init flag
    for (const [flag, desc] of Object.entries(COMMAND_HELP.init.options)) {
      expect(helpOut).toContain(flag);
      expect(helpOut).toContain(desc);
    }

    // and the init parser accepts --remove without an unknown-option error
    const root = makeTestTempDir("tickmarkr-init-remove-help-");
    const repo = makeWorkspaceRepo(root, { "keep.txt": "keep\n" });
    await expect(init(["--remove"], repo)).resolves.toBeDefined();

    const helpResult = await dispatch("init", ["--help"]);
    expect(helpResult.code).toBe(0);
    expect(helpResult.out).toContain("--remove");

    // Verify parser options match help options
    const removeInHelp = Object.keys(COMMAND_HELP.init.options).some((k) => k.includes("--remove"));
    expect(removeInHelp).toBe(true);
  });

  test("init --remove refuses garbage graph.lock and deletes nothing", async () => {
    const root = makeTestTempDir("tickmarkr-init-remove-garbage-");
    const repo = makeWorkspaceRepo(root, { "keep.txt": "keep\n" });
    const stateDir = join(repo, ".tickmarkr");
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, "graph.lock");
    writeFileSync(lockPath, "not-json{");

    await expect(init(["--remove"], repo)).rejects.toThrow(/unreadable payload/);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("init --remove inside a linked worktree refuses without destroying live worktrees", async () => {
    const root = makeTestTempDir("tickmarkr-init-remove-wt-");
    const repo = makeWorkspaceRepo(root, { "file.txt": "initial\n" });
    const base = await gitHead(repo);
    const t1Path = await createWorktree(repo, "tickmarkr/run-live--T1", base);
    const t2Path = await createWorktree(repo, "tickmarkr/run-live--T2", base);

    // Plant an uncommitted file in T1
    const uncommittedPath = join(t1Path, "uncommitted.txt");
    writeFileSync(uncommittedPath, "work in progress\n");

    // Plant live lock in main repo
    const stateDir = join(repo, ".tickmarkr");
    mkdirSync(stateDir, { recursive: true });
    const lockPath = join(stateDir, "graph.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, runId: "run-live", startedAt: Date.now() }));

    // Running init --remove from inside T2 worktree must refuse naming process.pid
    await expect(init(["--remove"], t2Path)).rejects.toThrow(new RegExp(String(process.pid)));

    // T1 worktree and its uncommitted file must be preserved
    expect(existsSync(t1Path)).toBe(true);
    expect(existsSync(uncommittedPath)).toBe(true);
    expect(readFileSync(uncommittedPath, "utf8")).toBe("work in progress\n");

    // Remove live lock; running inside linked worktree still refuses
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, runId: "run-dead", startedAt: Date.now() }));
    await expect(init(["--remove"], t2Path)).rejects.toThrow(/linked worktree/);
    expect(existsSync(t1Path)).toBe(true);
    expect(existsSync(uncommittedPath)).toBe(true);
  });

  test("init --remove unregisters a git-locked worktree under worktrees.noindex, present or already deleted, so a single --force that leaves a locked registration behind fails (LEG2-T10 P2)", async () => {
    const root = makeTestTempDir("tickmarkr-init-remove-locked-");
    const repo = makeWorkspaceRepo(root, { "file.txt": "initial\n" });
    const base = await gitHead(repo);
    const lockedPresent = await createWorktree(repo, "tickmarkr/run-locked--T1", base);
    const lockedMissing = await createWorktree(repo, "tickmarkr/run-locked--T2", base);
    const stateDir = tickmarkrDir(repo);
    execFileSync("git", ["worktree", "lock", lockedPresent], { cwd: repo });
    execFileSync("git", ["worktree", "lock", lockedMissing], { cwd: repo });
    rmSync(lockedMissing, { recursive: true, force: true });
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("locked");

    const out = await init(["--remove"], repo);

    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).not.toContain("worktrees.noindex");
    expect(existsSync(stateDir)).toBe(false);
    expect(out).toContain("deleted state directory");
  });

  test("init --remove whose worktree unregister fails refuses naming the worktree before deleting any state, so a remove that swallows the failure and deletes the state directory fails (LEG2-T10 P2)", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const root = makeTestTempDir("tickmarkr-init-remove-unregfail-");
    const repo = makeWorkspaceRepo(root, { "CLAUDE.md": "# Claude\n" });
    const globalDir = join(root, "global");
    await init(["--global-dir", globalDir, "--agent", "--docs", "--yes"], repo);
    const base = await gitHead(repo);
    const wtPath = await createWorktree(repo, "tickmarkr/run-fail--T1", base);
    const stateDir = tickmarkrDir(repo);
    const configBytes = readFileSync(join(stateDir, "config.yaml"));
    // a read-only parent makes git unable to delete the checkout, so unregistration fails
    chmodSync(dirname(wtPath), 0o555);
    try {
      await expect(init(["--remove"], repo)).rejects.toThrow(/worktree/);
    } finally {
      chmodSync(dirname(wtPath), 0o755);
    }
    expect(readFileSync(join(stateDir, "config.yaml"))).toEqual(configBytes);
    expect(existsSync(join(repo, ".claude", "skills", "tickmarkr-loop"))).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
  });

  test("init --remove whose git repository probe cannot launch git or whose rev-parse fails refuses with every registered worktree and all state preserved, so a remove that treats a failed probe as a non-repository and deletes state fails (LEG2-T10-2 P2)", async () => {
    const root = makeTestTempDir("tickmarkr-init-remove-nogit-");
    const repo = makeWorkspaceRepo(root, { "file.txt": "initial\n" });
    const base = await gitHead(repo);
    const wtPath = await createWorktree(repo, "tickmarkr/run-nogit--T1", base);
    const stateDir = tickmarkrDir(repo);
    writeFileSync(join(stateDir, "config.yaml"), "keep: me\n");
    const listBefore = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });

    // a failing git on PATH: rev-parse fails with an error that is not git's "not a git repository" answer
    const failingGitDir = join(root, "failing-git");
    mkdirSync(failingGitDir);
    writeFileSync(join(failingGitDir, "git"), "#!/bin/sh\necho 'fatal: injected rev-parse failure' >&2\nexit 1\n", { mode: 0o755 });

    const savedPath = process.env.PATH;
    try {
      // launch failure (ENOENT), then an injected rev-parse failure
      process.env.PATH = join(root, "no-git-on-path");
      await expect(init(["--remove"], repo)).rejects.toThrow(/cannot remove: git repository probe failed/);
      process.env.PATH = `${failingGitDir}:${savedPath}`;
      await expect(init(["--remove"], repo)).rejects.toThrow(/injected rev-parse failure/);
    } finally {
      process.env.PATH = savedPath;
    }

    expect(readFileSync(join(stateDir, "config.yaml"), "utf8")).toBe("keep: me\n");
    expect(existsSync(wtPath)).toBe(true);
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).toBe(listBefore);
  });

  test("init --remove in a directory git reports is not a repository still deletes the state directory, so a probe that refuses every non-repository fails (LEG2-T10-2 control)", async () => {
    const dir = makeTestTempDir("tickmarkr-init-remove-nonrepo-");
    const stateDir = join(dir, ".tickmarkr");
    mkdirSync(join(stateDir, "worktrees.noindex"), { recursive: true });
    writeFileSync(join(stateDir, "config.yaml"), "x: 1\n");
    expect(spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir }).status).not.toBe(0);

    const out = await init(["--remove"], dir);

    expect(existsSync(stateDir)).toBe(false);
    expect(out).toContain("deleted state directory");
  });

  test("init --remove accepts only an exit-128 `git rev-parse --is-inside-work-tree` whose stderr is `fatal: not a git repository (or any of the parent directories)`, probed with GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR stripped, as a non-repository and refuses every other answer — including the explicit-GIT_DIR form `fatal: not a git repository: <path>` — with nothing deleted, so a probe that matches the phrase loosely, inherits GIT_* or runs another command fails (LEG2-T10 R102, R102 add.1)", async () => {
    const root = makeTestTempDir("tickmarkr-init-remove-probe128-");
    // fake git: answers `rev-parse --is-inside-work-tree` with the given exit-128 stderr; any other invocation is an invalid gitfile
    const fakeGit = (name: string, stderr: string): string => {
      const dir = join(root, name);
      mkdirSync(dir);
      const answer = stderr.replace(/'/g, "'\\''");
      writeFileSync(
        join(dir, "git"),
        "#!/bin/sh\n"
          // an inherited GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR turns the answer into git's explicit-GIT_DIR form
          + "if [ -n \"$GIT_DIR$GIT_WORK_TREE$GIT_COMMON_DIR\" ]; then echo \"fatal: not a git repository: $GIT_DIR\" >&2; exit 128; fi\n"
          + `if [ "$1" = rev-parse ] && [ "$2" = --is-inside-work-tree ]; then printf '%s\\n' '${answer}' >&2; exit 128; fi\n`
          + "echo 'fatal: invalid gitfile format: .git' >&2\nexit 128\n",
        { mode: 0o755 },
      );
      return dir;
    };
    const stateFor = (name: string): string => {
      const stateDir = join(root, name, ".tickmarkr");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "config.yaml"), "keep: me\n");
      return stateDir;
    };

    const accepted = fakeGit("git-not-a-repo", "fatal: not a git repository (or any of the parent directories): .git");
    const refusedCases: Array<[string, RegExp]> = [
      ["fatal: invalid gitfile format: /work/.git", /invalid gitfile format/],
      ["fatal: not a git repository: /work/missing/.git", /not a git repository: \/work\/missing\/\.git/],
      ["warning: unable to access '/home/.config/git/attributes': Permission denied\nfatal: not a git repository (or any of the parent directories): .git", /Permission denied/],
    ];

    const savedPath = process.env.PATH;
    const savedGitEnv = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    try {
      process.env.PATH = `${accepted}:${savedPath}`;
      // inherited repository overrides must not reach the probe
      process.env.GIT_DIR = join(root, "elsewhere", ".git");
      process.env.GIT_WORK_TREE = join(root, "elsewhere");
      process.env.GIT_COMMON_DIR = join(root, "elsewhere", ".git");
      const acceptedState = stateFor("accepted-ws");
      await expect(init(["--remove"], dirname(acceptedState))).resolves.toContain("deleted state directory");
      expect(existsSync(acceptedState)).toBe(false);
      for (const k of Object.keys(savedGitEnv)) delete process.env[k];

      for (const [i, [stderr, named]] of refusedCases.entries()) {
        process.env.PATH = `${fakeGit(`git-refused-${i}`, stderr)}:${savedPath}`;
        const refusedState = stateFor(`refused-ws-${i}`);
        await expect(init(["--remove"], dirname(refusedState))).rejects.toThrow(named);
        expect(readFileSync(join(refusedState, "config.yaml"), "utf8")).toBe("keep: me\n");
      }
    } finally {
      process.env.PATH = savedPath;
      for (const [k, v] of Object.entries(savedGitEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("init --remove with an inherited GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR pointing at a second repository unregisters the cwd repository's worktree and leaves the second repository's worktrees, state and refs untouched, so a remove whose list, remove, prune or re-list inherits GIT_* fails (LEG2-T10 R106)", async () => {
    const repo = makeWorkspaceRepo(makeTestTempDir("tickmarkr-init-remove-own-"), { "file.txt": "own\n" });
    const other = makeWorkspaceRepo(makeTestTempDir("tickmarkr-init-remove-other-"), { "file.txt": "other\n" });
    const ownWt = await createWorktree(repo, "tickmarkr/run-own--T1", await gitHead(repo));
    const otherWt = await createWorktree(other, "tickmarkr/run-other--T1", await gitHead(other));
    const ownState = tickmarkrDir(repo);
    const otherState = tickmarkrDir(other);
    writeFileSync(join(otherState, "config.yaml"), "other: keep\n");
    const otherListBefore = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: other, encoding: "utf8" });
    const otherRefsBefore = execFileSync("git", ["for-each-ref"], { cwd: other, encoding: "utf8" });
    expect(otherListBefore).toContain(otherWt);

    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    let out: string;
    try {
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_COMMON_DIR = join(other, ".git");
      out = await init(["--remove"], repo);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    expect(out).toContain(`deleted state directory ${ownState}`);
    expect(existsSync(ownState)).toBe(false);
    expect(existsSync(ownWt)).toBe(false);
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).not.toContain("worktrees.noindex");
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: other, encoding: "utf8" })).toBe(otherListBefore);
    expect(execFileSync("git", ["for-each-ref"], { cwd: other, encoding: "utf8" })).toBe(otherRefsBefore);
    expect(existsSync(otherWt)).toBe(true);
    expect(readFileSync(join(otherState, "config.yaml"), "utf8")).toBe("other: keep\n");
  });

  test("init --remove on fresh uninitialised repository does not create .tickmarkr", async () => {
    const root = makeTestTempDir("tickmarkr-init-remove-fresh-");
    const repo = makeWorkspaceRepo(root, { "file.txt": "clean\n" });
    const stateDir = join(repo, ".tickmarkr");
    expect(existsSync(stateDir)).toBe(false);

    const out = await init(["--remove"], repo);
    expect(existsSync(stateDir)).toBe(false);
    expect(out).not.toContain("deleted state directory");
  });
});
