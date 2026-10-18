import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { HOST_SESSION_VARS } from "../../src/drivers/host-env.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { OrcaDriver } from "../../src/drivers/orca.js";
import { HERDR_CONTROL_VARS, SubprocessDriver } from "../../src/drivers/subprocess.js";
import { FORK_CAP_ENV, sh, shell } from "../../src/run/git.js";
import { probeClaudeAliasIdentity, probeVersion } from "../../src/adapters/claude-code.js";
import { cursorAgent } from "../../src/adapters/cursor-agent.js";
import { grok } from "../../src/adapters/grok.js";
import { kimi } from "../../src/adapters/kimi.js";
import { opencode } from "../../src/adapters/opencode.js";
import { pi } from "../../src/adapters/pi.js";
import { qwen } from "../../src/adapters/qwen.js";
import { probeHelpText } from "../../src/adapters/registry.js";
import { codexSandbox } from "../../src/adapters/codex-commit-check.js";
import { FakeOrca, steppedTime } from "../helpers/fake-orca.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 193 (D-2102 add.1): no agent CLI or gate command inherits the launching agent session's host variables.

const GOAL_NAMES = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_CODE_TERMINAL_MCP_TOOLS", "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_CODE_REPORT_FINDINGS",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "CLAUDE_CODE_EAGER_FLUSH", "CLAUDE_CODE_DISABLE_CRON", "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PREVIEW_CLASSIFIER_FLOOR", "CLAUDE_CODE_BRIDGE_SESSION_ID",
];
// Values a shell would mangle if any seam re-quoted them: spaces, both quotes, $, backslash, a tab.
const odd = (k: string) => `v ${k} 'q' "dq" $HOME \\ \t end`;
const USER_SET: Record<string, string> = Object.fromEntries([
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY",
].map((k) => [k, odd(k)]));
const UNLISTED = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: odd("teams") };
const KEPT: Record<string, string> = { ...USER_SET, ...UNLISTED };
const HOST: Record<string, string> = Object.fromEntries(GOAL_NAMES.map((k) => [k, odd(k)]));

/** Sets every host-session, user and unlisted name (plus `extra`) on process.env for `fn`, then restores. */
async function withParent<T>(extra: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const all = { ...HOST, ...KEPT, ...extra };
  const previous = Object.keys(all).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, all);
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A directory holding record.cjs: `node record.cjs <out> <name> ...args` appends {name,args,env} as one JSON line. */
function recorder(): { dir: string; out: string; cmd: (name: string) => string; records: () => Array<{ name: string; args: string[]; env: Record<string, string> }> } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-host-env-"));
  const out = join(dir, "records.jsonl");
  writeFileSync(join(dir, "record.cjs"),
    'const fs = require("fs"); const [out, name, ...args] = process.argv.slice(2);\n' +
    'fs.appendFileSync(out, JSON.stringify({ name, args, env: process.env }) + "\\n");\n');
  const cmd = (name: string) => `'${process.execPath}' '${join(dir, "record.cjs")}' '${out}' ${name}`;
  const records = () => existsSync(out)
    ? readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { dir, out, cmd, records };
}

function expectSealed(env: Record<string, string | undefined>, also: Record<string, string> = {}): void {
  for (const k of GOAL_NAMES) expect(env[k], k).toBeUndefined();
  for (const [k, v] of Object.entries({ ...KEPT, ...also })) expect(env[k], k).toBe(v);
}

test("a command run through the production shell seam from a parent environment holding every host-session name receives none of them, while every user auth and provider variable, the unlisted experimental agent-teams variable, the values of an explicit options environment and the herdr host marker reach it byte-equal and the daemon's own environment still holds every name afterwards, so a seam that strips nothing, strips by prefix or mutates the daemon environment fails", async () => {
  const rec = recorder();
  // sh() and the subprocess driver run login shells: an empty HOME keeps the operator's profile out of the record.
  await withParent({ HERDR_ENV: "1", HOME: rec.dir }, async () => {
    expect((await sh(rec.cmd("sh"), rec.dir)).code).toBe(0);
    expect((await shell(rec.cmd("shell"), rec.dir, 30_000)).code).toBe(0);
    const explicit: NodeJS.ProcessEnv = { ...process.env, EXPLICIT_ONLY: odd("explicit"), HERDR_ENV: "explicit-marker" };
    expect((await sh(rec.cmd("explicit"), rec.dir, 30_000, { env: explicit })).code).toBe(0);
    const [viaSh, viaShell, viaExplicit] = rec.records();
    expect([viaSh?.name, viaShell?.name, viaExplicit?.name]).toEqual(["sh", "shell", "explicit"]);
    expectSealed(viaSh!.env, { HERDR_ENV: "1" });
    expectSealed(viaShell!.env, { HERDR_ENV: "1" });
    expectSealed(viaExplicit!.env, { EXPLICIT_ONLY: odd("explicit"), HERDR_ENV: "explicit-marker" });
    // The explicit options object and the daemon's own environment are copies' sources, never mutated.
    for (const k of GOAL_NAMES) expect(explicit[k], k).toBe(HOST[k]);
    for (const k of GOAL_NAMES) expect(process.env[k], k).toBe(HOST[k]);
    for (const [k, v] of Object.entries(KEPT)) expect(process.env[k], k).toBe(v);
  });
});

test("a subprocess driver worker child, a herdr worker seed executed by a shell and an Orca worker terminal's create command executed by a shell, each from that same parent environment, see none of the host-session names and every user variable byte-equal, the herdr seed still unsetting the five host control names and the Orca command still exporting the fork cap first, so a seal applied to one driver only or an Orca payload that unsets nothing fails", async () => {
  const rec = recorder();
  const control: Record<string, string> = {
    HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", ORCA_TERMINAL_HANDLE: "term-x", ORCA_PANE_KEY: "pane-x", ORCA_TAB_ID: "tab-x",
  };
  await withParent({ ...control, HERDR_WORKSPACE_ID: "wHOST", HOME: rec.dir }, async () => {
    // Subprocess driver: the worker child itself.
    const subprocess = new SubprocessDriver();
    const slot = await subprocess.slot(rec.dir, "T1-worker-fake-a0-r");
    await subprocess.run(slot, `${rec.cmd("subprocess")}; printf 'DONE\\n'`);
    expect(await subprocess.waitOutput(slot, "DONE", 10_000)).toBe(true);
    await subprocess.close(slot);

    // herdr: the stub captures the exact seed text `pane run` carries; a shell then executes it.
    const seedFile = join(rec.dir, "seed.txt");
    const bin = join(rec.dir, "herdr");
    writeFileSync(bin, `#!/usr/bin/env bash
if [ "$1 $2" = "pane run" ]; then case "$4" in *"export HERDR_WORKSPACE_ID="*) printf %s "$4" > '${seedFile}' ;; esac; fi
case "$1 $2" in
  "agent start") echo '{"result":{"agent":{"pane_id":"w1:p9"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p0"}}}' ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"w1:p7"}}}' ;;
  "pane layout") echo '{"result":{"layout":{"area":{"width":222},"panes":[{"pane_id":"w1:p42","rect":{"width":222}}]}}}' ;;
  "agent get") echo '{"result":{"agent":{"pane_id":"w1:p42"}}}' ;;
  *) echo '{}' ;;
esac
`);
    chmodSync(bin, 0o755);
    await new HerdrDriver(bin).slot(rec.dir, "T1-worker-fake-a0-r");
    const seed = readFileSync(seedFile, "utf8");
    expect(seed).toContain("export HERDR_WORKSPACE_ID=");
    execFileSync("sh", ["-c", `${seed}${rec.cmd("herdr")}`], { cwd: rec.dir, env: process.env });

    // Orca: the create command a fresh terminal runs, executed by a shell.
    const cwd = makeTestTempDir("orca-host-env-");
    const fake = new FakeOrca({ trackedWorktrees: [cwd] });
    const driver = new OrcaDriver({ exec: fake.exec, time: steppedTime() });
    const orcaSlot = await driver.slot(cwd, "T1-worker-fake-a0-r");
    await driver.run(orcaSlot, rec.cmd("orca"));
    const create = fake.calls.find((args) => args[1] === "create")!;
    const command = create[create.indexOf("--command") + 1]!;
    const capAt = command.indexOf(`export ${FORK_CAP_ENV}=`);
    expect(capAt).toBeGreaterThanOrEqual(0);
    expect(capAt).toBeLessThan(command.indexOf("unset "));
    execFileSync("sh", ["-c", command], { cwd, env: process.env });
    await driver.close(orcaSlot);

    const byName = Object.fromEntries(rec.records().map((r) => [r.name, r.env]));
    expect(Object.keys(byName).sort()).toEqual(["herdr", "orca", "subprocess"]);
    for (const name of ["subprocess", "herdr", "orca"]) expectSealed(byName[name]!);
    for (const k of HERDR_CONTROL_VARS) {
      expect(byName.subprocess![k], k).toBeUndefined();
      expect(byName.herdr![k], k).toBeUndefined();
      expect(seed).toContain(`unset ${k}`);
    }
    expect(byName.orca![FORK_CAP_ENV]).toBeDefined();
    for (const k of GOAL_NAMES) expect(process.env[k], k).toBe(HOST[k]);
  });
});

test("each bare agent-CLI probe, namely the claude alias probe, the version probe, the cursor-agent, grok, opencode and pi model listings, the pi probe, the qwen probe, the kimi seed launch's help read, the help-text probe and the codex sandbox commit probe, run against a PATH stand-in that records its own environment, records none of the host-session names and every user variable byte-equal, so a probe left on the inherited environment fails", async () => {
  const rec = recorder();
  for (const name of ["claude", "cursor-agent", "grok", "opencode", "pi", "qwen", "kimi", "codex", "helpbin"]) {
    const bin = join(rec.dir, name);
    writeFileSync(bin, `#!/bin/sh\n${rec.cmd(name)} "$@"\n[ "$1" = "--version" ] && echo "1.2.3"\nexit 0\n`);
    chmodSync(bin, 0o755);
  }
  const worktree = makeTestTempDir("host-env-probe-");
  await withParent({ PATH: `${rec.dir}:${process.env.PATH ?? ""}` }, async () => {
    const vitest = process.env.VITEST;
    delete process.env.VITEST; // probeClaudeAliasIdentity returns early under VITEST
    try {
      probeClaudeAliasIdentity(worktree, "opus");
    } finally {
      process.env.VITEST = vitest;
    }
    probeVersion("claude");
    await cursorAgent.listModels!();
    await grok.listModels!();
    await opencode.listModels!();
    await pi.listModels!();
    await pi.probe();
    await qwen.probe();
    kimi.interactiveSeed!.launch("kimi-k2");
    probeHelpText("helpbin");
    await codexSandbox({
      worktree, commonDir: worktree, branch: "b", control: "c", lock: "l",
      hostileHook: join(worktree, "h"), hostileRoot: join(worktree, "r"), token: "t",
    });
  });
  const calls = rec.records().map((r) => `${r.name} ${r.args[0] ?? ""}`);
  expect(calls).toEqual([
    "claude -p", "claude --version", "cursor-agent --list-models", "grok models", "opencode models",
    "pi --list-models", "pi --version", "pi --list-models", "qwen --version", "kimi --help", "helpbin --help", "codex sandbox",
  ]);
  for (const r of rec.records()) expectSealed(r.env);
});

test("the exported host-session denylist equals exactly the thirty-one names this task's goal lists, with no duplicate and no pattern, and holds no name of the user set nor any other CLAUDE_CODE name, so a list missing the bridge session id, holding a prefix or swallowing a user variable fails", () => {
  expect(GOAL_NAMES).toHaveLength(31);
  expect([...HOST_SESSION_VARS]).toEqual(GOAL_NAMES);
  expect(new Set(HOST_SESSION_VARS).size).toBe(31);
  for (const k of HOST_SESSION_VARS) expect(k).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
  for (const k of Object.keys(KEPT)) expect(HOST_SESSION_VARS as readonly string[]).not.toContain(k);
  expect(HOST_SESSION_VARS as readonly string[]).toContain("CLAUDE_CODE_BRIDGE_SESSION_ID");
});
