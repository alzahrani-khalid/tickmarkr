import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { validateAgentMessage } from "../helpers/acp-schema.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const LOADER = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const ENTRY = join(ROOT, "src/cli/index.ts");

// Runs INSIDE the CLI process. Block dangerous calls after recording them, so even a
// signalling regression cannot kill this test runner (the live lock holder).
const RECORDER = String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const record = (row) => fs.appendFileSync(process.env.ACP_AUDIT, JSON.stringify(row) + "\n");
const kill = process.kill;
process.kill = function(pid, signal = "SIGTERM") {
  record({ kind: "process.kill", pid, signal });
  if (signal !== 0) throw new Error("ACP attempted a signal");
  return kill.call(this, pid, signal);
};
const childKill = cp.ChildProcess.prototype.kill;
cp.ChildProcess.prototype.kill = function(signal = "SIGTERM") {
  record({ kind: "child.kill", pid: this.pid, signal });
  if (signal !== 0) throw new Error("ACP attempted a child signal");
  return childKill.call(this, signal);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
  const original = cp[name];
  cp[name] = function(...args) {
    const command = args.filter((v) => typeof v === "string" || Array.isArray(v)).flat().join(" ");
    if (/(?:^|[\s\/;&|])(?:kill|pkill|killall)(?:\s|$)/.test(command)) {
      record({ kind: "kill command", command });
      throw new Error("ACP attempted a kill command");
    }
    return original.apply(this, args);
  };
}
require("node:module").syncBuiltinESMExports();
record({ kind: "installed" });
// Positive control proves the in-process recorder sees liveness queries; it also proves
// the lock holder is alive without giving ACP ownership of it.
if (process.env.ACP_LIVE_HOLDER) process.kill(Number(process.env.ACP_LIVE_HOLDER), 0);
if (process.env.ACP_NOISE) {
  const write = process.stdout.write;
  let emitted = false;
  process.stdout.write = function(chunk, ...args) {
    let row;
    try { row = JSON.parse(String(chunk)); } catch {}
    if (!emitted && row?.result?.sessionId) {
      emitted = true;
      console.log("console stray during session");
      process.stdout.write("stream stray during session\n");
    }
    return write.call(this, chunk, ...args);
  };
}
`;

function start(cwd: string, noise: boolean, holder?: number) {
  const audit = join(cwd, "signal-attempts.jsonl");
  const preload = join(cwd, "acp-preload.cjs");
  writeFileSync(preload, RECORDER);
  const child = spawn(process.execPath, ["--require", preload, "--import", LOADER, ENTRY, "acp"], {
    cwd, stdio: "pipe", env: { ...process.env, ACP_AUDIT: audit, ACP_NOISE: noise ? "1" : "", ACP_LIVE_HOLDER: holder ? String(holder) : "" },
  });
  const closed = once(child, "close");
  const output: any[] = [];
  const failures: unknown[] = [];
  const methods = new Map<number, string>();
  let stdout = "";
  let stderr = "";
  let tail = "";
  let nextId = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    tail += chunk;
    let newline: number;
    while ((newline = tail.indexOf("\n")) >= 0) {
      const line = tail.slice(0, newline);
      tail = tail.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        validateAgentMessage(message, methods.get(message.id));
        output.push(message);
      } catch (fault) { failures.push(fault); }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const request = async (method: string, params: object) => {
    const id = ++nextId;
    methods.set(id, method);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const deadline = Date.now() + 10_000;
    while (!output.some((row) => row.id === id)) {
      if (failures.length) throw failures[0];
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`ACP never answered ${method}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return output.find((row) => row.id === id);
  };
  return { child, closed, output, request, audit,
    finish: async () => {
      child.stdin.end();
      const [code, signal] = await closed;
      expect(failures).toEqual([]);
      expect(signal).toBe(null);
      expect(code, stderr).toBe(0);
      expect(tail).toBe("");
      expect(stdout).toBe(output.map((row) => JSON.stringify(row) + "\n").join(""));
      return { stdout, stderr };
    },
    cleanup: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}

test("the acp command spawned from the source entry, with a preloaded module writing through console and the stdout stream mid-session, emits only schema-valid protocol lines on stdout, sends the stray bytes to stderr and exits zero at end of input with no trailing byte, so an impure stdout fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-acp-stdio-"));
  const cli = start(cwd, true);
  try {
    await cli.request("initialize", { protocolVersion: 65535 });
    const { result: { sessionId } } = await cli.request("session/new", { cwd, mcpServers: [] });
    await cli.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello 雪🙂" }] });
    // An unterminated row at EOF is never parsed, including by the actual command.
    cli.child.stdin.write("{unterminated");
    const { stdout, stderr } = await cli.finish();
    expect(cli.output.map((row) => row.id ?? row.params.update.sessionUpdate)).toEqual([
      1, 2, "available_commands_update", "agent_message_chunk", 3,
    ]);
    expect(cli.output[2].params).toMatchObject({ sessionId, update: {
      availableCommands: [
        { name: "attach" }, { name: "status" }, { name: "compile" }, { name: "plan" }, { name: "run" }, { name: "resume" },
      ],
    } });
    expect(stdout.endsWith("}\n")).toBe(true);
    expect(stderr).toBe("console stray during session\nstream stray during session\n");
  } finally { await cli.cleanup(); rmSync(cwd, { recursive: true, force: true }); }
});

test("at end of input with a live lock holder recorded, acp exits zero having attempted no signal but a signal-zero query, by a recorder inside the spawned process, and leaves the lock file byte-identical, so a detach that signals or touches the run fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-acp-lock-"));
  mkdirSync(join(cwd, ".tickmarkr"));
  const lock = join(cwd, ".tickmarkr/graph.lock");
  const bytes = Buffer.from(` { "pid": ${process.pid}, "runId": "live-run", "startedAt": ${Date.now()} } \n`);
  writeFileSync(lock, bytes);
  const cli = start(cwd, false, process.pid);
  try {
    await cli.request("initialize", { protocolVersion: 1 });
    await cli.request("session/new", { cwd, mcpServers: [] });
    const { stderr } = await cli.finish();
    expect(stderr).toBe("");
    expect(readFileSync(lock)).toEqual(bytes);
    const attempts = readFileSync(cli.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(attempts[0]).toEqual({ kind: "installed" });
    expect(attempts).toContainEqual({ kind: "process.kill", pid: process.pid, signal: 0 });
    for (const attempt of attempts.slice(1)) {
      expect(["process.kill", "child.kill"]).toContain(attempt.kind);
      expect(attempt.signal).toBe(0);
    }
  } finally { await cli.cleanup(); rmSync(cwd, { recursive: true, force: true }); }
});
