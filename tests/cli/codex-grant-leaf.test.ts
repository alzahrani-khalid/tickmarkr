import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CODEX_GIT_GRANT, codex } from "../../src/adapters/codex.js";
import { codexSandboxFor, recordCodexCommit } from "../../src/adapters/codex-commit-check.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { makeRepo, makeTestTempDir, quietGitInit } from "../helpers/tmprepo.js";

// v2.8.0 T1 (rows 17/18, D-910). BASE is the 2.6.6–2.7.9 fragment this task replaces (gitdir when distinct,
// whole common objects/refs/logs, printf '"%s"'); SHIPPED and D910 are the broad grants before it.
const BASE = `-c "sandbox_workspace_write.writable_roots=[$(tkr_common=$(git rev-parse --path-format=absolute --git-common-dir); tkr_gitdir=$(git rev-parse --absolute-git-dir); if [ "$tkr_gitdir" != "$tkr_common" ]; then printf '"%s",' "$tkr_gitdir"; fi; printf '"%s/objects","%s/refs","%s/logs"' "$tkr_common" "$tkr_common" "$tkr_common")]"`;
const SHIPPED = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\"]"`;
const D910 = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\",\\"$(git rev-parse --absolute-git-dir)\\"]"`;
// the leaf grant minus its reflog leaf, rebuilt from the production bytes
const REFLOG_DENIED = CODEX_GIT_GRANT.replace(`,"%s/%s","%s/logs/%s"' "$tkr_common" "$tkr_leaf" "$tkr_common" "$tkr_leaf"`, `,"%s/%s"' "$tkr_common" "$tkr_leaf"`);

// A token-free stand-in for `codex`. Every launch logs its argv and each writable_roots value as TOML sees it:
// legal only as an array of basic strings without escapes (any Unicode but the double quote, the backslash and
// the controls TOML forbids raw — every C0 but tab, and DEL), whose roots are then the strings verbatim.
// `codex sandbox -- cmd` (doctor's probe) and, when FAKE_CODEX_RUN is set, any other launch (the worker
// builders) run their command under a workspace-write model: every path under the git common dir that no
// granted root covers is read-only while it runs, so REAL git decides what lands. Real enforcement is
// version-specific and measured live, never here.
const FAKE_CODEX = `#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const KEY = "sandbox_workspace_write.writable_roots=";
const STR = '"[^"\\\\\\\\\\\\u0000-\\\\u0008\\\\u000a-\\\\u001f\\\\u007f]*"';
const ARRAY = new RegExp("^\\\\[(?:" + STR + "(?:," + STR + ")*)?\\\\]$");
const grants = args.filter((a) => a.startsWith(KEY)).map((a) => {
  const v = a.slice(KEY.length);
  return ARRAY.test(v) ? { legal: true, roots: [...v.matchAll(/"([^"]*)"/g)].map((m) => m[1]) } : { legal: false, value: v };
});
fs.writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, grants }));
const cmd = args[0] === "sandbox" ? args.slice(args.indexOf("--") + 1) : process.env.FAKE_CODEX_RUN ? ["sh", "-c", process.env.FAKE_CODEX_RUN] : null;
if (!cmd) process.exit(0);
if (grants.length !== 1 || !grants[0].legal) { console.error("fake codex: no legal writable_roots"); process.exit(1); }
const roots = grants[0].roots;
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
const covered = (p) => roots.some((r) => p === r || p.startsWith(r + "/"));
const locked = [];
const lock = (p) => {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const e of fs.readdirSync(p)) lock(path.join(p, e));
  if (!covered(p)) { locked.push([p, st.mode & 0o7777]); fs.chmodSync(p, st.mode & ~0o222); }
};
lock(common);
try {
  process.exitCode = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" }).status ?? 1;
} finally {
  for (const [p, mode] of locked) fs.chmodSync(p, mode);
}
`;

let log = "";
beforeEach(() => {
  const dir = makeTestTempDir("codex-leaf-fake-");
  writeFileSync(join(dir, "codex"), FAKE_CODEX, { mode: 0o755 });
  log = join(dir, "log.json");
  // hermetic: no operator CODEX_HOME (MCP names), the fake codex first on PATH for every shell production spawns
  mkdirSync(join(dir, "codex-home"));
  vi.stubEnv("CODEX_HOME", join(dir, "codex-home"));
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  vi.stubEnv("FAKE_CODEX_LOG", log);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const prompt = () => {
  const p = join(makeTestTempDir("codex-leaf-prompt-"), "prompt.md");
  writeFileSync(p, "fixture prompt");
  return p;
};
/** The two production WORKER builders: invoke()'s headless worker form and the interactive TUI. */
const builders = (p: string): Array<[string, string]> => [
  ["invoke().command", codex.invoke({} as never, "/wt", { model: "fixture-model", channel: "sub", tier: "mid" }, { promptFile: p }).command],
  ["interactiveCommand", codex.interactiveCommand(p, "fixture-model")!],
];
type Grant = { legal: true; roots: string[] } | { legal: false; value: string };
/** Runs `command` through sh at `cwd` and returns the one writable_roots grant the fake codex parsed. */
const launch = (command: string, cwd: string, env: Record<string, string> = {}): Grant => {
  execFileSync("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
  const { grants } = JSON.parse(readFileSync(log, "utf8")) as { grants: Grant[] };
  expect(grants).toHaveLength(1);
  return grants[0]!;
};
const roots = (g: Grant): string[] => {
  expect(g.legal).toBe(true);
  return (g as { roots: string[] }).roots;
};
/** A linked worktree of a fresh repository on `branch`, with the common dir resolved. */
const linkedFixture = (branch: string) => {
  const repo = makeRepo({ "a.txt": "x\n" });
  git(repo, "branch", "keep");
  const common = realpathSync(join(repo, ".git"));
  const name = `wt-${branch.replaceAll("/", "-")}`;
  const linked = join(makeTestTempDir("codex-leaf-linked-"), name);
  git(repo, "worktree", "add", "-q", "-b", branch, linked, "HEAD");
  return { repo, common, linked, gitdir: join(common, "worktrees", name) };
};

test("test: both worker builders in a linked worktree on branch tickmarkr/run-x--T1 grant only its gitdir the common objects and the refs/heads/tickmarkr ref and reflog leaves so a sandboxed commit lands on that branch while moving main or another branch or creating a tag or a stash is denied versus whole common refs and logs letting each through", () => {
  const p = prompt();
  const branch = "tickmarkr/run-x--T1";
  // inside the sandbox: the worker's own commit, then every ref move outside its leaf
  const id = "-c user.name=w -c user.email=w@w.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null";
  const work = [
    `git ${id} commit -q --allow-empty -m leaf`,
    "git update-ref refs/heads/main HEAD",
    "git update-ref refs/heads/keep HEAD",
    "git tag t1",
    `echo y >> a.txt && git ${id} stash push -q`,
  ].map((c) => `{ ${c}; } 2>/dev/null`).join("; ") + "; true";
  for (const [name, command] of builders(p)) {
    expect(command, name).toContain(CODEX_GIT_GRANT);
    for (const grant of ["leaf", "base"] as const) {
      const { repo, common, linked, gitdir } = linkedFixture(branch);
      const base = git(repo, "rev-parse", "HEAD");
      const reflog = () => readFileSync(join(common, "logs", "refs", "heads", "tickmarkr", "run-x--T1"), "utf8").trimEnd().split("\n");
      const before = reflog().length;
      const g = launch(grant === "leaf" ? command : command.replace(CODEX_GIT_GRANT, BASE), linked, { FAKE_CODEX_RUN: work });
      const tip = git(repo, "rev-parse", `refs/heads/${branch}`);
      // the worker's commit lands on its branch, ref and reflog, under either grant
      expect(tip, `${name} ${grant}`).not.toBe(base);
      expect(reflog()).toHaveLength(before + 1);
      expect(reflog().at(-1)).toContain(`${base} ${tip} `);
      const refs = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
      if (grant === "leaf") {
        expect(roots(g), name).toEqual([gitdir, `${common}/objects`, `${common}/refs/heads/tickmarkr`, `${common}/logs/refs/heads/tickmarkr`]);
        // main, another branch, a tag and the stash: every one denied
        expect(refs, name).toBe([`refs/heads/keep ${base}`, `refs/heads/main ${base}`, `refs/heads/${branch} ${tip}`].join("\n"));
        expect(existsSync(join(common, "logs", "refs", "stash")), name).toBe(false);
      } else {
        expect(roots(g), name).toEqual([gitdir, `${common}/objects`, `${common}/refs`, `${common}/logs`]);
        // whole common refs and logs let each one through
        expect(git(repo, "rev-parse", "refs/heads/main"), name).toBe(tip);
        expect(git(repo, "rev-parse", "refs/heads/keep"), name).toBe(tip);
        expect(git(repo, "rev-parse", "refs/tags/t1"), name).toBe(tip);
        expect(git(repo, "rev-parse", "--verify", "-q", "refs/stash"), name).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  }
}, 120_000);

test("test: the closed root table gives a branch without a slash the refs/heads leaf and a detached HEAD no refs or reflog root and an ordinary checkout no gitdir root and a directory outside any repository an empty array versus the base fragment granting slash objects refs and logs outside any repository", () => {
  const p = prompt();
  const { repo, common, linked, gitdir } = linkedFixture("task");
  const detached = join(makeTestTempDir("codex-leaf-detached-"), "det");
  git(repo, "worktree", "add", "-q", "--detach", detached, "HEAD");
  const outside = join(makeTestTempDir("codex-leaf-outside-"), "plain");
  mkdirSync(outside);
  // outside any repository: git may not search above the fixture's parent
  const noRepo = { GIT_CEILING_DIRECTORIES: dirname(outside) };
  const heads = [`${common}/refs/heads`, `${common}/logs/refs/heads`];
  const rows: Array<[string, string, string[], Record<string, string>?]> = [
    ["branch without a slash", linked, [gitdir, `${common}/objects`, ...heads]],
    ["detached HEAD", detached, [join(common, "worktrees", "det"), `${common}/objects`]],
    ["ordinary checkout", repo, [`${common}/objects`, ...heads]],
    ["outside any repository", outside, [], noRepo],
  ];
  for (const [name, command] of builders(p)) {
    for (const [row, cwd, want, env] of rows) expect(roots(launch(command, cwd, env)), `${name}: ${row}`).toEqual(want);
    // the base fragment grants /objects, /refs and /logs at the filesystem root outside any repository
    expect(roots(launch(command.replace(CODEX_GIT_GRANT, BASE), outside, noRepo)), name).toEqual(["/objects", "/refs", "/logs"]);
  }
}, 120_000);

test("test: a repository path holding spaces and non-ASCII letters keeps every root exact while a path holding a double quote or the sequence quote comma quote or a backslash or any one C0 character from U+0001 to U+001F or DEL looped over that whole table through both worker builders yields one empty TOML-legal roots array versus the base fragment injecting a second root or emitting a string TOML forbids", () => {
  const p = prompt();
  const fixture = (dirName: string) => {
    const repo = join(makeTestTempDir("codex-leaf-path-"), dirName);
    mkdirSync(repo);
    quietGitInit(repo);
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "i");
    return { repo, common: join(realpathSync(repo), ".git") };
  };
  // spaces and non-ASCII letters: every root exact, through a linked worktree on a slashed branch (git
  // sanitizes a worktree NAME, so the spaces live in the repository path every root carries)
  const { repo, common } = fixture("re po é ü 日本");
  const linked = join(dirname(repo), "wt-é-日");
  git(repo, "worktree", "add", "-q", "-b", "tickmarkr/run-é", linked, "HEAD");
  for (const [name, command] of builders(p)) {
    expect(roots(launch(command, linked)), name).toEqual([join(common, "worktrees", "wt-é-日"), `${common}/objects`, `${common}/refs/heads/tickmarkr`, `${common}/logs/refs/heads/tickmarkr`]);
  }
  // the closed forbidden set, one character per repository path
  const forbidden = ['"', '","', "\\", ...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)), "\x7f"];
  for (const ch of forbidden) {
    const { repo: bad, common: badCommon } = fixture(`re${ch}po`);
    const label = JSON.stringify(ch);
    for (const [name, command] of builders(p)) {
      expect(launch(command, bad), `${name} ${label}`).toEqual({ legal: true, roots: [] });
      const base = launch(command.replace(CODEX_GIT_GRANT, BASE), bad);
      const exact = [`${badCommon}/objects`, `${badCommon}/refs`, `${badCommon}/logs`];
      if (ch === '","') {
        // TOML-legal, yet each root splits in two: a second root injected per root
        expect(roots(base), name).toEqual(exact.flatMap((r) => r.split(ch)));
      } else if (ch === "\t") {
        // the one control TOML allows raw: the base grants the tab path, the leaf refuses it (a declared cost)
        expect(roots(base), name).toEqual(exact);
      } else {
        expect(base.legal, `${name} ${label}`).toBe(false);
      }
    }
  }
  // a branch name is a root's source too: a refname holding quote comma quote cannot inject a root
  const { repo: br, common: brCommon } = fixture("branchy");
  git(br, "checkout", "-q", "-b", 'x","/tmp/evil/y');
  for (const [name, command] of builders(p)) {
    expect(launch(command, br), name).toEqual({ legal: true, roots: [] });
    expect(roots(launch(command.replace(CODEX_GIT_GRANT, BASE), br)), name).toEqual([`${brCommon}/objects`, `${brCommon}/refs`, `${brCommon}/logs`]);
  }
}, 120_000);

test("test: doctor's commit probe executing the leaf grant through the fake codex sandbox still reads allowed and leaves every ref and reflog as it found them while a grant without the reflog leaf reads protected versus the D-910 and shipped broad grants still reading escape", async () => {
  const repo = makeRepo({ "a.txt": "x" });
  git(repo, "branch", "keep");
  git(repo, "branch", "tickmarkr/run-x");
  const common = realpathSync(join(repo, ".git"));
  const reflogs = (dir: string): string[][] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? reflogs(join(dir, e.name)) : [[join(dir, e.name), readFileSync(join(dir, e.name), "utf8")]]);
  const snapshot = () => ({
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    reflogs: reflogs(join(common, "logs")).sort(),
    root: readdirSync(common).sort(),
    hooks: readdirSync(join(common, "hooks")).sort(),
  });
  const before = snapshot();
  const probe = async (grant?: string) => {
    const health: Record<string, AuthHealth> = { codex: { installed: true, authed: true, models: [] } };
    await recordCodexCommit([codex], health, repo, grant === undefined ? undefined : codexSandboxFor(grant));
    return health.codex!.codexCommit;
  };

  // production (no injected sandbox): the slash-free fixture branch commits inside the refs/heads leaf
  expect(await probe()).toBe("allowed");
  const { grants } = JSON.parse(readFileSync(log, "utf8")) as { grants: Grant[] };
  expect(roots(grants[0]!).slice(1)).toEqual([`${common}/objects`, `${common}/refs/heads`, `${common}/logs/refs/heads`]);
  expect(snapshot()).toEqual(before);

  // the same bytes minus the reflog leaf: the branch commit cannot append its reflog
  expect(REFLOG_DENIED).not.toBe(CODEX_GIT_GRANT);
  expect(await probe(REFLOG_DENIED)).toBe("protected");
  expect(snapshot()).toEqual(before);

  // the broad grants still write shared hooks/config members
  for (const broad of [D910, SHIPPED]) {
    expect(await probe(broad), broad).toBe("escape");
    expect(snapshot(), broad).toEqual(before);
  }
}, 300_000);
