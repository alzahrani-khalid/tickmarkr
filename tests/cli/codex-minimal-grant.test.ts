import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CODEX_GIT_GRANT, codex } from "../../src/adapters/codex.js";
import { type CodexSandbox, codexCommitHeadline, codexSandbox, codexSandboxFor, recordCodexCommit } from "../../src/adapters/codex-commit-check.js";
import * as registry from "../../src/adapters/registry.js";
import type { AuthHealth, WorkerAdapter } from "../../src/adapters/types.js";
import { statusRow } from "../../src/brand.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { plan } from "../../src/cli/commands/plan.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// v2.6.6 T9 (K, D-912). The grants this task replaces, in the builders' own shell form: the shipped 2.6.5
// common-root grant and D-910's rejected [common, gitdir]. LOGS_DENIED is the minimal grant minus common/logs.
const SHIPPED = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\"]"`;
const D910 = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\",\\"$(git rev-parse --absolute-git-dir)\\"]"`;
const LOGS_DENIED = CODEX_GIT_GRANT.replace(`,"%s/logs"' "$tkr_common" "$tkr_common" "$tkr_common"`, `' "$tkr_common" "$tkr_common"`);

// A token-free stand-in for `codex` (no model, no network). The builders' launches only log argv. `codex
// sandbox` models workspace-write explicitly: every path under the git common dir that no granted writable
// root covers is made read-only for the sandboxed command and restored after it, so REAL git and a real
// shell decide what lands. Real enforcement is version-specific and measured live (S-K2), never here.
const FAKE_CODEX = `#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGV) fs.writeFileSync(process.env.FAKE_CODEX_ARGV, JSON.stringify(args));
if (args[0] !== "sandbox") process.exit(0);
const grant = args.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
const roots = JSON.parse(grant.slice(grant.indexOf("=") + 1));
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
  const cmd = args.slice(args.indexOf("--") + 1);
  process.exitCode = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" }).status ?? 1;
} finally {
  for (const [p, mode] of locked) fs.chmodSync(p, mode);
}
`;

let argvLog = "";
beforeEach(() => {
  const dir = makeTestTempDir("codex-fake-");
  writeFileSync(join(dir, "codex"), FAKE_CODEX, { mode: 0o755 });
  argvLog = join(dir, "argv.json");
  // hermetic: no operator CODEX_HOME (MCP names), the fake codex first on PATH for every shell production spawns
  mkdirSync(join(dir, "codex-home"));
  vi.stubEnv("CODEX_HOME", join(dir, "codex-home"));
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  vi.stubEnv("FAKE_CODEX_ARGV", argvLog);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const grantedRoots = (): string[] => {
  const grants = (JSON.parse(readFileSync(argvLog, "utf8")) as string[]).filter((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
  expect(grants).toHaveLength(1);
  return JSON.parse(grants[0]!.slice(grants[0]!.indexOf("=") + 1));
};

test("both production Codex builders expand exactly the minimal linked grant versus shipped and D-910 broad sets and ordinary checkout omits its common gitdir", () => {
  const repo = makeRepo({ "a.txt": "x" });
  const common = realpathSync(join(repo, ".git"));
  const linked = join(makeTestTempDir("codex-linked-"), "task");
  git(repo, "worktree", "add", "-q", "-b", "task", linked, "HEAD");
  const prompt = join(makeTestTempDir("codex-prompt-"), "prompt.md");
  writeFileSync(prompt, "fixture prompt");
  expect(LOGS_DENIED).not.toBe(CODEX_GIT_GRANT);

  const objectsRefsLogs = [`${common}/objects`, `${common}/refs`, `${common}/logs`];
  const rows = [
    // a linked worktree: its own gitdir (never the common root, never the worktrees parent) plus objects/refs/logs
    { cwd: linked, minimal: [`${common}/worktrees/task`, ...objectsRefsLogs], d910: [common, `${common}/worktrees/task`] },
    // an ordinary checkout: gitdir IS the common dir, so no gitdir root at all (its commit fails closed)
    { cwd: repo, minimal: objectsRefsLogs, d910: [common, common] },
  ];
  for (const { cwd, minimal, d910 } of rows) {
    const builders = [codex.headlessCommand(prompt, "fixture-model"), codex.interactiveCommand(prompt, "fixture-model")!];
    for (const command of builders) {
      expect(command).toContain(CODEX_GIT_GRANT);
      execFileSync("sh", ["-c", command], { cwd });
      expect(grantedRoots(), command).toEqual(minimal);
      expect(grantedRoots()).not.toContain(common);
      // the same builder bytes carrying the shipped or D-910 fragment expand the broad sets this grant replaces
      execFileSync("sh", ["-c", command.replace(CODEX_GIT_GRANT, SHIPPED)], { cwd });
      expect(grantedRoots()).toEqual([common]);
      execFileSync("sh", ["-c", command.replace(CODEX_GIT_GRANT, D910)], { cwd });
      expect(grantedRoots()).toEqual(d910);
    }
  }
});

test("doctor worker-grant probe discriminates the allowed protected escape unknown table including D-910 escape and a logs-denied branch commit while deleting only its owned ref/reflog versus removing a ref/reflog after a foreign tip change", async () => {
  const repo = makeRepo({ "a.txt": "x" });
  git(repo, "branch", "keep");
  const common = realpathSync(join(repo, ".git"));
  writeFileSync(join(common, "hooks", "post-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // everything the probe may not leave changed: refs, every reflog, the real hooks and config, the common root
  const snapshot = () => ({
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    reflogs: readdirSync(join(common, "logs", "refs", "heads")).sort().map((b) => [b, readFileSync(join(common, "logs", "refs", "heads", b), "utf8")]),
    hooks: readdirSync(join(common, "hooks")).sort().map((h) => [h, readFileSync(join(common, "hooks", h), "utf8")]),
    config: readFileSync(join(common, "config"), "utf8"),
    root: readdirSync(common).sort(),
  });
  const before = snapshot();
  const doctorProbe = async (sandbox?: CodexSandbox) => {
    const health: Record<string, AuthHealth> = { codex: { installed: true, authed: true, models: [] } };
    await recordCodexCommit([codex], health, repo, sandbox);
    return health.codex!;
  };

  // allowed: production (the real adapter, no injected sandbox) executes the minimal fragment, commits on its
  // fixture branch, is denied both members, then deletes ONLY its own ref and reflog
  const allowed = await doctorProbe();
  expect(allowed.codexCommit).toBe("allowed");
  expect(allowed.note).toBe("linked-worktree commit probe: commit allowed, shared hooks/config denied — the sandbox committed on its fixture branch and was denied both shared-metadata members");
  const roots = grantedRoots();
  expect(roots[0]).toMatch(new RegExp(`^${common}/worktrees/tickmarkr-probe-[0-9a-f-]{36}$`));
  expect(roots.slice(1)).toEqual([`${common}/objects`, `${common}/refs`, `${common}/logs`]);
  expect(snapshot()).toEqual(before);

  // escape: D-910's [common, gitdir] (and the shipped [common]) let the sandbox write both unique hostile
  // members — BLOCKING; the probe removes only its own token files and never touches real hooks or config
  for (const broad of [D910, SHIPPED]) {
    const escaped = await doctorProbe(codexSandboxFor(broad));
    expect(escaped.codexCommit, broad).toBe("escape");
    expect(escaped.note).toMatch(/^BLOCKING security warning: codex sandbox escape into shared git metadata — the sandbox wrote \S+\/hooks\/tickmarkr-probe-\S+ and \S+\/\.git\/tickmarkr-probe-\S+ outside the worker grant; every Codex role \(worker, judge, review, consult\) launches with this grant/);
    expect(snapshot(), broad).toEqual(before);
  }

  // protected: without common/logs the real branch commit fails on its reflog; the controls stay readable
  const logsDenied = await doctorProbe(codexSandboxFor(LOGS_DENIED));
  expect(logsDenied.codexCommit).toBe("protected");
  expect(logsDenied.note).toContain("linked-worktree git metadata protected — the sandbox wrote an ordinary worktree file but denied the linked-worktree commit");
  expect(snapshot()).toEqual(before);

  // unknown: unreadable receipts, and a commit receipt the fixture branch contradicts
  expect((await doctorProbe(async () => "unreadable")).codexCommit).toBe("unknown");
  const claimed = await doctorProbe(async (p) => { writeFileSync(p.control, p.token); return "control=ok\ncommit=ok\nhook=denied\nroot=denied\n"; });
  expect(claimed.codexCommit).toBe("unknown");
  expect(snapshot()).toEqual(before);
  // contradictory receipts beside a REAL successful commit and reflog: unknown, never allowed
  const conflicting = await doctorProbe(async (p) => `${await codexSandbox(p)}commit=fail\n`);
  expect(conflicting.codexCommit).toBe("unknown");
  expect(conflicting.note).toContain("the sandbox receipts contradict each other");
  expect(snapshot()).toEqual(before);

  // a sandbox that writes both hostile members and then exits non-zero still escaped — inspected before cleanup,
  // dominant over contradictory receipts, blocking in the note — and the probe still removes only its own files
  const failedAfterWrite = await doctorProbe(async (p) => { await codexSandboxFor(D910)(p); throw new Error("Command failed: exit 17"); });
  expect(failedAfterWrite.codexCommit).toBe("escape");
  expect(failedAfterWrite.note).toMatch(/^BLOCKING security warning: codex sandbox escape into shared git metadata — the sandbox wrote \S+\/hooks\/tickmarkr-probe-\S+ and \S+\/\.git\/tickmarkr-probe-\S+ outside the worker grant; every Codex role/);
  expect((await doctorProbe(async (p) => `${await codexSandboxFor(D910)(p)}commit=fail\n`)).codexCommit).toBe("escape");
  expect(snapshot()).toEqual(before);

  // a foreign tip change after the probe's own commit: unknown, and the moved ref and its reflog stay
  let foreignTip = "";
  const moved = await doctorProbe(async (p) => {
    const out = await codexSandbox(p);
    git(p.worktree, "-c", "user.name=f", "-c", "user.email=f@f.invalid", "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "foreign");
    foreignTip = git(p.worktree, "rev-parse", "HEAD");
    return out;
  });
  expect(moved.codexCommit).toBe("unknown");
  expect(moved.note).toContain("the fixture branch does not match the sandbox commit report (a foreign change may have moved it)");
  const kept = git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/tickmarkr-probe-*");
  expect(kept).toMatch(/^refs\/heads\/tickmarkr-probe-[0-9a-f-]{36}$/);
  expect(git(repo, "rev-parse", kept)).toBe(foreignTip);
  expect(readFileSync(join(common, "logs", kept), "utf8")).toContain(foreignTip);
  git(repo, "update-ref", "-d", kept, foreignTip);
  expect(snapshot()).toEqual(before);
}, 300_000);

test("doctor and plan block a Codex escape for a review-only Codex role versus an allowed minimal probe", async () => {
  // the candidate-CLI sweep shells nine PATH probes per doctor call; doctor-candidate-cli.test.ts owns it
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  const stubCodex = { id: "codex", vendor: "openai", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;
  const verified = (id: string) => ({ installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {})) });
  const outcome = async (sandbox: CodexSandbox) => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] }],
    }));
    // Codex may serve every role but a worker (the implement seed prefers codex, so claude-code takes the work)
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "routing:\n  map:\n    implement: { prefer: [claude-code] }\n  deny:\n    workers:\n      adapters: [codex]\n");
    const doctorOut = await doctor(["--"], repo, [stubCodex], { banner: false, codexSandbox: sandbox, resolveOrcaBinary: () => undefined });
    const verdict = JSON.parse(readFileSync(join(tickmarkrDir(repo), "doctor.json"), "utf8")).codex.codexCommit;
    // plan reads doctor's persisted verdict beside an authed fleet
    registry.writeDoctor(repo, { "claude-code": verified("claude-code"), codex: { ...verified("codex"), codexCommit: verdict } });
    const planOut = (await plan([], repo)).split("\n");
    return { verdict, codexRow: doctorOut.split("\n").find((l) => l.includes(" codex ")) ?? "", planOut };
  };
  const escape = await outcome(codexSandboxFor(D910));
  const allowed = await outcome(codexSandbox);

  expect(escape.verdict).toBe("escape");
  expect(allowed.verdict).toBe("allowed");
  // doctor: the codex row FAILS and carries the blocking warning; the allowed row passes without it
  expect(escape.codexRow.trimStart().startsWith(statusRow("fail", ""))).toBe(true);
  expect(escape.codexRow).toContain("BLOCKING security warning: codex sandbox escape into shared git metadata");
  expect(escape.codexRow).toContain("every Codex role (worker, judge, review, consult) launches with this grant — stop Codex seats and inspect .git/hooks");
  expect(allowed.codexRow.trimStart().startsWith(statusRow("pass", ""))).toBe(true);
  expect(allowed.codexRow).toContain("linked-worktree commit probe: commit allowed, shared hooks/config denied");
  expect(allowed.codexRow).not.toContain("BLOCKING");

  // plan: Codex is no worker here, yet a review seat — the escape still blocks; the allowed probe adds nothing
  for (const { planOut } of [escape, allowed]) {
    const row = planOut.findIndex((l) => l.startsWith("  T1 "));
    expect(planOut[row]).toContain("→ claude-code:");
    expect(planOut.slice(row).find((l) => l.startsWith("    review: "))).toMatch(/^ {4}review: codex:/);
  }
  expect(escape.planOut).toContain("BLOCKING security warning: codex sandbox escape (doctor probe) — Codex review/consult seats launch with the worker grant that let the sandbox write shared git metadata; stop Codex seats and inspect .git/hooks and git config --list --show-origin (core.hooksPath, core.fsmonitor, filter.*, diff.external) before dispatch");
  expect(allowed.planOut.join("\n")).not.toContain("BLOCKING");
  expect(allowed.planOut.join("\n")).not.toContain("worker restriction");
  // a Codex WORKER row under the same escape carries its own blocking headline
  expect(codexCommitHeadline("codex", [codex], { codex: { ...verified("codex"), codexCommit: "escape" } })).toBe("    BLOCKING security warning: codex sandbox escape (doctor probe) — this worker's launch grant let the sandbox write shared git metadata; stop Codex seats and inspect .git/hooks and git config --list --show-origin (core.hooksPath, core.fsmonitor, filter.*, diff.external) before dispatch");
}, 300_000);
