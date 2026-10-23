import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderCodexGitGrant, codex } from "../../src/adapters/codex.js";
import { codexSandboxArgs, codexSandboxFor, probeCodexCommit, recordCodexCommit } from "../../src/adapters/codex-commit-check.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelsFromConfig, shq, type Assignment, type AuthHealth, type WorkerAdapter, type WorkerLaunchContext } from "../../src/adapters/types.js";
import type { TickmarkrConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import type { Effort, Task } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { checkedAuthority } from "../../src/run/git-trust.js";
import { Journal } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeRepo, makeTestTempDir, quietGitInit, setupRepo, T } from "../helpers/tmprepo.js";

// Queue rows 2 and 151 (D-2112, D-910): historical broad grants remain negative controls.
const BASE = `-c "sandbox_workspace_write.writable_roots=[$(tkr_common=$(git rev-parse --path-format=absolute --git-common-dir); tkr_gitdir=$(git rev-parse --absolute-git-dir); if [ "$tkr_gitdir" != "$tkr_common" ]; then printf '"%s",' "$tkr_gitdir"; fi; printf '"%s/objects","%s/refs","%s/logs"' "$tkr_common" "$tkr_common" "$tkr_common")]"`;
const SHIPPED = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\"]"`;
const D910 = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\",\\"$(git rev-parse --absolute-git-dir)\\"]"`;
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
const builders = (p: string, ctx: WorkerLaunchContext): Array<[string, string]> => [
  ["invoke().command", codex.invoke({} as never, ctx.cwd, { model: "fixture-model", channel: "sub", tier: "mid" }, { promptFile: p, ...ctx }).command],
  ["interactiveCommand", codex.interactiveCommand(p, "fixture-model", undefined, ctx)!],
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

test("test: the Codex worker launches from invoke and the interactive builder, shell-run at a linked task worktree on its assigned branch, hand a recording codex the gitdir, common objects and branch-leaf ref and reflog roots byte-equal to today's while a recording git sees no launch-time invocation, so a launch shell still running git or drifting roots fails", () => {
  const branch = "tickmarkr/run-x--T1";
  const { repo, common, linked, gitdir } = linkedFixture(branch);
  const bin = makeTestTempDir("recording-git-");
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "git"), '#!/bin/sh\necho called >> "$GIT_CALLS"\nexit 99\n', { mode: 0o755 });
  for (const [name, command] of builders(prompt(), { cwd: linked, branch, repoRoot: repo })) {
    expect(roots(launch(command, linked, { PATH: `${bin}:${process.env.PATH}`, GIT_CALLS: calls })), name)
      .toEqual([gitdir, `${common}/objects`, `${common}/refs/heads/tickmarkr`, `${common}/logs/refs/heads/tickmarkr`]);
    expect(existsSync(calls)).toBe(false);
  }
});

test("test: for ordinary and linked checkouts whose commondir or gitfile is intact or names a foreign repository, with HEAD on the assigned branch, another slashless branch or detached, the grant names no foreign path, is empty for a foreign pointer or double-quote path and loses only ref and reflog roots off the assigned branch, so following commondir or HEAD fails", () => {
  for (const kind of ["ordinary", "linked"]) for (const pointer of ["intact", "commondir", "gitfile"]) {
    for (const head of ["assigned", "other", "detached"]) for (const byte of ["safe", 'double"quote']) {
      const parent = makeTestTempDir("grant-table-");
      const repo = join(parent, byte);
      mkdirSync(repo);
      quietGitInit(repo);
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--no-gpg-sign", "--allow-empty", "-qm", "base");
      // Queue row 2 (D-2112): an ordinary gitfile can redirect while the run's anchor stays trusted.
      let common = join(realpathSync(repo), ".git");
      if (kind === "ordinary" && pointer === "gitfile") {
        common = join(realpathSync(parent), `${byte}-store`);
        git(repo, "init", "-q", "--separate-git-dir", common);
      }
      const anchor = join(parent, "anchor");
      git(repo, "worktree", "add", "-q", "--detach", anchor);
      const branch = "tickmarkr/run-x--T1";
      const cwd = kind === "ordinary" ? repo : join(parent, "task");
      if (kind === "ordinary") git(repo, "checkout", "-qb", branch);
      else git(repo, "worktree", "add", "-q", "-b", branch, cwd);
      const gitdir = kind === "ordinary" ? common : join(common, "worktrees", "task");
      const ownHead = git(repo, "rev-parse", "HEAD");
      writeFileSync(join(gitdir, "HEAD"), head === "assigned" ? `ref: refs/heads/${branch}\n` : head === "other" ? "ref: refs/heads/main\n" : `${ownHead}\n`);
      const foreign = makeRepo({ "foreign.txt": "foreign" });
      if (pointer === "commondir") writeFileSync(join(gitdir, "commondir"), `${foreign}/.git\n`);
      if (pointer === "gitfile") writeFileSync(join(cwd, ".git"), `gitdir: ${foreign}/.git\n`);
      const base = [...(kind === "linked" ? [gitdir] : []), `${common}/objects`];
      const want = pointer !== "intact" || byte !== "safe" ? [] : head !== "assigned" ? base
        : [...base, `${common}/refs/heads/tickmarkr`, `${common}/logs/refs/heads/tickmarkr`];
      const ctx = { cwd, branch, repoRoot: anchor };
      for (const [name, command] of builders(prompt(), ctx)) {
        const got = roots(launch(command, cwd));
        expect(got, `${name} ${kind} ${pointer} ${head} ${byte}`).toEqual(want);
        expect(got.some(root => root.startsWith(foreign))).toBe(false);
      }
    }
  }
  expect(renderCodexGitGrant()).toBe("-c 'sandbox_workspace_write.writable_roots=[]'");
  const valid = linkedFixture("task");
  const context = { cwd: valid.linked, branch: "task", repoRoot: valid.repo };
  for (const key of ["cwd", "branch", "repoRoot"] as const) expect(renderCodexGitGrant({ ...context, [key]: undefined })).toBe(renderCodexGitGrant());
  const outside = makeTestTempDir("outside-");
  expect(renderCodexGitGrant({ cwd: outside, branch: "task", repoRoot: outside })).toBe(renderCodexGitGrant());
}, 120_000);

test("test: worktree paths holding an apostrophe, a space, a dollar expression or a backtick reach the recording codex as exact roots from one shell-quoted grant argument, every substitution marker file left unwritten, so a grant quoted for shell expansion fails", () => {
  for (const byte of ["apost'rophe", "a space", "$(touch marker-dollar)", "`touch marker-backtick`"]) {
    const repo = join(makeTestTempDir("grant-bytes-"), byte);
    mkdirSync(repo);
    quietGitInit(repo);
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--no-gpg-sign", "--allow-empty", "-qm", "base");
    const cwd = join(repo, "task");
    const branch = "tickmarkr/run-x--T1";
    git(repo, "worktree", "add", "-q", "-b", branch, cwd);
    const common = join(realpathSync(repo), ".git");
    const ctx = { cwd, branch, repoRoot: repo };
    for (const [name, command] of builders(prompt(), ctx)) {
      expect(roots(launch(command, cwd)), name).toEqual([`${common}/worktrees/task`, `${common}/objects`, `${common}/refs/heads/tickmarkr`, `${common}/logs/refs/heads/tickmarkr`]);
      const { args } = JSON.parse(readFileSync(log, "utf8")) as { args: string[] };
      const grants = args.filter(arg => arg.startsWith("sandbox_workspace_write.writable_roots="));
      expect(grants).toHaveLength(1);
      expect(args[args.indexOf(grants[0]!) - 1]).toBe("-c");
      for (const marker of ["marker-dollar", "marker-backtick"]) expect(existsSync(join(cwd, marker))).toBe(false);
    }
  }
});

// Queue row 2 (D-2112): keep the complete forbidden-byte rule, including path and branch leaf sources.
test("the literal grant refuses every forbidden root character and preserves Unicode paths", () => {
  for (const byte of ['"', '\\', ...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)), "\x7f", "é 日本"]) {
    const repo = join(makeTestTempDir("grant-forbidden-"), `repo${byte}`);
    mkdirSync(repo);
    quietGitInit(repo);
    const expected = byte === "é 日本" ? [`${realpathSync(repo)}/.git/objects`, `${realpathSync(repo)}/.git/refs/heads`, `${realpathSync(repo)}/.git/logs/refs/heads`] : [];
    for (const [, command] of builders(prompt(), { cwd: repo, branch: "main", repoRoot: repo })) expect(roots(launch(command, repo))).toEqual(expected);
  }
  const repo = makeRepo({ "base": "base" });
  const branch = 'x","/tmp/evil/y';
  git(repo, "checkout", "-qb", branch);
  for (const [, command] of builders(prompt(), { cwd: repo, branch, repoRoot: repo })) expect(roots(launch(command, repo))).toEqual([]);
}, 120_000);

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
  for (const name of ["invoke().command", "interactiveCommand"]) {
    for (const grant of ["leaf", "base"] as const) {
      const { repo, common, linked, gitdir } = linkedFixture(branch);
      const ctx = { cwd: linked, branch, repoRoot: repo };
      const command = builders(p, ctx).find(([builder]) => builder === name)![1];
      expect(command, name).toContain(renderCodexGitGrant(ctx));
      const base = git(repo, "rev-parse", "HEAD");
      const reflog = () => readFileSync(join(common, "logs", "refs", "heads", "tickmarkr", "run-x--T1"), "utf8").trimEnd().split("\n");
      const before = reflog().length;
      const g = launch(grant === "leaf" ? command : command.replace(renderCodexGitGrant(ctx), BASE), linked, { FAKE_CODEX_RUN: work });
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
  const denied = async (p: Parameters<ReturnType<typeof codexSandboxFor>>[0]) => {
    const grant = renderCodexGitGrant({ cwd: p.worktree, branch: p.branch, repoRoot: repo });
    const roots = [join(common, "worktrees", p.branch), `${common}/objects`, `${common}/refs/heads`];
    const mutant = `-c '${"sandbox_workspace_write.writable_roots=" + JSON.stringify(roots)}'`;
    expect(mutant).not.toBe(grant);
    return codexSandboxFor(mutant)(p);
  };
  const health: Record<string, AuthHealth> = { codex: { installed: true, authed: true, models: [] } };
  await recordCodexCommit([codex], health, repo, denied);
  expect(health.codex!.codexCommit).toBe("protected");
  expect(snapshot()).toEqual(before);

  // the broad grants still write shared hooks/config members
  for (const broad of [D910, SHIPPED]) {
    expect(await probe(broad), broad).toBe("escape");
    expect(snapshot(), broad).toEqual(before);
  }
}, 300_000);

// Queue row 2 item a (D-2112, D-2114): the real command reaches a recording child through each daemon transport.
class GrantSeat extends FakeAdapter {
  constructor(script: string, private readonly path: string) { super(script); this.id = "codex"; this.vendor = "openai"; }
  override async probe() { return { installed: true, authed: true, models: ["gpt-6-sol"], modelAuth: authedModels(["gpt-6-sol"]) }; }
  override channels(cfg: TickmarkrConfig) { return channelsFromConfig(this.id, cfg); }
  override invoke(task: Task, cwd: string, a: Assignment, ctx: Parameters<WorkerAdapter["invoke"]>[3]) {
    const command = codex.invoke(task, cwd, a, ctx).command;
    return { command: `PATH=${shq(this.path)} ${command} && ${super.invoke(task, cwd, a, ctx).command}` };
  }
  override interactiveCommand(prompt: string, model: string, effort?: Effort, ctx?: WorkerLaunchContext) {
    const command = codex.interactiveCommand(prompt, model, effort, ctx);
    return command === null ? null : `PATH=${shq(this.path)} ${command} && ${super.interactiveCommand(prompt, model)}`;
  }
}

const driver = (): ExecutorDriver => {
  const inner = new SubprocessDriver();
  return { id: "interactive-test", interactive: true,
    slot: inner.slot.bind(inner), run: inner.run.bind(inner), read: inner.read.bind(inner),
    status: inner.status.bind(inner), close: inner.close.bind(inner), notify: inner.notify.bind(inner),
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner), worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
};

test("test: daemon runs dispatching a Codex worker over the headless transport, the interactive transport and the oversized-prompt fallback hand the recording codex child that task's worktree gitdir and branch leaf, and doctor's probe hands it the renderer's grant for its fixture with no grant lookup there, so a transport or the probe left without context fails", async () => {
  const bin = makeTestTempDir("daemon-codex-bin-");
  const log = join(bin, "record.jsonl");
  const home = join(bin, "codex-home");
  mkdirSync(home);
  vi.stubEnv("CODEX_HOME", home);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');\n`, { mode: 0o755 });
  const path = `${bin}:${process.env.PATH}`;
  for (const mode of ["headless", "interactive", "oversized"]) {
    const { repo, scriptPath, fake } = setupRepo(
      [T("T1", { ...(mode === "oversized" ? { goal: "x".repeat(950_000) } : {}), routingHints: { pin: { via: "codex", model: "gpt-6-sol" } } })],
      { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] } },
      `visibility: { worker: ${mode === "headless" ? "print" : "interactive"} }\n`,
    );
    const runId = `run-grant-${mode}`;
    const result = await runDaemon(repo, { adapters: [new GrantSeat(scriptPath, path), fake], runId, ...(mode === "headless" ? {} : { driver: driver() }) });
    expect(result.done, mode).toEqual(["T1"]);
    const records = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { cwd: string; args: string[] });
    const child = records.at(-1)!;
    const common = checkedAuthority(repo)!.common;
    const branch = `tickmarkr/${runId}--T1`;
    const gitdir = join(common, "worktrees", branch.replaceAll("/", "-"));
    const values = child.args.filter(arg => arg.startsWith("sandbox_workspace_write.writable_roots="));
    expect(values, mode).toHaveLength(1);
    const roots = JSON.parse(values[0]!.split("=").slice(1).join("=")) as string[];
    // Queue row 2 (D-2112): compare the actual task registration, not the test driver's command.
    expect(roots, mode).toEqual([gitdir, `${common}/objects`, `${common}/refs/heads/tickmarkr`, `${common}/logs/refs/heads/tickmarkr`]);
    expect(child.cwd).toContain("T1");
    expect(child.args[0]).toBe(mode === "interactive" ? "-a" : "exec");
    const events = Journal.open(repo, runId).read();
    expect(events.some(e => e.event === "worker-mode-fallback")).toBe(mode === "oversized");

    vi.stubEnv("PATH", path);
    const marker = join(bin, `probe-git-${mode}`);
    const guard = makeTestTempDir("probe-no-lookup-");
    writeFileSync(join(guard, "git"), `#!/bin/sh\nprintf called > ${shq(marker)}\nexit 99\n`, { mode: 0o755 });
    const probe = await probeCodexCommit(repo, async p => {
      const grant = renderCodexGitGrant({ cwd: p.worktree, branch: p.branch, repoRoot: repo });
      expect(grant).not.toBe(renderCodexGitGrant());
      expect(codexSandboxArgs(p)[1]).toContain(` ${grant} -- sh `);
      const priorPath = process.env.PATH;
      try {
        process.env.PATH = `${guard}:${path}`;
        await codexSandboxFor()(p);
      } finally { process.env.PATH = priorPath; }
      expect(existsSync(marker)).toBe(false);
      const child = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!) as { args: string[] };
      expect(child.args).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([checkedAuthority(p.worktree)!.gitdir, `${common}/objects`, `${common}/refs/heads`, `${common}/logs/refs/heads`])}`);
      return "unreadable";
    });
    expect(probe.status).toBe("unknown");
  }
}, 120_000);
