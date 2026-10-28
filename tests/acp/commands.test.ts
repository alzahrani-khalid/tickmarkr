import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { createAcpAgent } from "../../src/acp/server.js";
import { HOST_SESSION_VARS, SEAT_MARKER_ENV } from "../../src/drivers/host-env.js";
import { HERDR_CONTROL_VARS } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { childEnv, runCli } from "../../src/run/launch.js";
import * as statusModule from "../../src/cli/commands/status-snapshot.js";
import { finalMessage } from "../../src/acp/attach.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";
import { makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const denied = [...HOST_SESSION_VARS, ...HERDR_CONTROL_VARS, SEAT_MARKER_ENV];
const lookalikes = denied.flatMap(name => [`${name}_LOOKALIKE`, `PREFIX_${name}`, name.toLowerCase()]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function recordingEntry() {
  const dir = makeTestTempDir("acp-entry-");
  const entry = join(dir, "recording-entry.mjs");
  const log = join(dir, "children.jsonl");
  const real = pathToFileURL(new URL("../../dist/cli/index.js", import.meta.url).pathname).href;
  writeFileSync(entry, `
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
if (process.argv[2] !== "acp") {
  const names = new Set([...Object.keys(process.env), ...${JSON.stringify(denied)}]);
  const env = Object.fromEntries([...names].map(name => [name, Object.hasOwn(process.env, name)
    ? { present: true, sha256: createHash("sha256").update(process.env[name]).digest("hex") }
    : { present: false }]));
  appendFileSync(process.env.ACP_CHILD_RECORD, JSON.stringify({ execPath: process.execPath, execArgv: process.execArgv,
    entry: process.argv[1], args: process.argv.slice(2), env, stdin: readFileSync(0, "utf8") }) + "\\n");
}
const { dispatch } = await import(${JSON.stringify(real)});
const result = await dispatch(process.argv[2], process.argv.slice(3));
if (result.out) process.stdout.write(result.out + "\\n");
process.exitCode = result.code;
`);
  return { entry, log, records: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

function rpc(write: (line: string) => void) {
  const output: any[] = [];
  const methods = new Map<number, string>();
  const waiting = new Map<number, (row: any) => void>();
  let id = 0;
  const receive = (line: string) => {
    const row = JSON.parse(line);
    // The shared validator intentionally covers only the original v1 methods.
    if (methods.get(row.id) !== "session/resume" || row.error) validateAgentMessage(row, methods.get(row.id));
    else expect(row.result).toEqual({});
    output.push(row);
    waiting.get(row.id)?.(row);
  };
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { waiting.delete(next); reject(new Error(`No answer for ${method}`)); }, 10000);
    waiting.set(next, row => { clearTimeout(timer); waiting.delete(next); resolve(row); });
    methods.set(next, method);
    write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
  });
  return { output, receive, request };
}
const messages = (rows: any[]) => rows.filter(row => row.params?.update?.sessionUpdate === "agent_message_chunk").map(row => row.params.update.content.text);
const advertised = (rows: any[]) => rows.filter(row => row.params?.update?.sessionUpdate === "available_commands_update");

test("compile and plan run the version check first and stop on its non-zero exit, take exactly their arguments with no flag, and each child gets the same node, loader flags and entry with every denylist name removed and look-alikes byte-equal whatever environment the helper is handed, so a trusted environment fails", async () => {
  const recorder = recordingEntry();
  const cwd = makeRepo({ "work.txt": "base\n", "spec.md": "<!-- tickmarkr:spec -->\n## T1: Work\n- goal: Work\n- files: work.txt\n- acceptance:\n  - done\n" });
  mkdirSync(join(cwd, ".tickmarkr"));
  writeFileSync(join(cwd, ".tickmarkr/doctor.json"), "{}"); // an empty cached fleet: no agent is invoked
  writeFileSync(join(cwd, ".tickmarkr/config.yaml"), "driver: subprocess\n");
  const planted = Object.fromEntries([...denied, ...lookalikes].map(name => [name, `fixture:${name}:雪\nbyte-exact`]));
  const env = { ...process.env, ...planted, ACP_CHILD_RECORD: recorder.log };
  const flags = ["--no-warnings", "--enable-source-maps"];
  const proc = spawn(process.execPath, [...flags, recorder.entry, "acp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const a = rpc(line => { proc.stdin.write(line); });
  let tail = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8").on("data", chunk => {
    tail += chunk;
    let newline: number;
    while ((newline = tail.indexOf("\n")) >= 0) { a.receive(tail.slice(0, newline)); tail = tail.slice(newline + 1); }
  });
  proc.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = once(proc, "exit");
  try {
    await a.request("initialize", { protocolVersion: 1 });
    const sessionId = (await a.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    const prompt = async (text: string) => {
      const before = a.output.length;
      expect((await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })).result.stopReason).toBe("end_turn");
      const result = messages(a.output.slice(before));
      expect(result).toHaveLength(1);
      return result[0];
    };
    for (const text of ["/compile", "/compile --type gsd x", "/compile spec.md extra", "/compile --help", "/compile -x", "/plan x", "/plan --help"]) expect(await prompt(text)).toMatch(/^Usage:/u);
    expect(recorder.records()).toEqual([]);
    expect(await prompt("/compile spec.md")).toContain("compile exited 0");
    expect(existsSync(join(cwd, ".tickmarkr/graph.json"))).toBe(true);
    const plan = await prompt("/plan");
    expect(plan).toContain("plan exited 0");
    expect(plan).toMatch(/^plan exited 0\n(`{3,})text\n[\s\S]*\n\1\n\n$/u);
    expect(plan).toMatch(/unroutable|no .*channel/iu);
    expect(recorder.records().map(row => row.args)).toEqual([["version", "--check"], ["compile", "spec.md"], ["version", "--check"], ["plan"]]);
    rmSync(join(cwd, ".tickmarkr/graph.json"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "tickmarkr", version: "0.0.0-stale" }));
    for (const text of ["/compile spec.md", "/plan"]) {
      const failure = await prompt(text);
      expect(failure).toContain("version --check exited 1");
      expect(failure).toContain("versions differ");
      expect(existsSync(join(cwd, ".tickmarkr/graph.json"))).toBe(false);
    }
    const records = recorder.records();
    expect(records.slice(4).map(row => row.args)).toEqual([["version", "--check"], ["version", "--check"]]);
    for (const row of records) {
      expect(row).toMatchObject({ execPath: process.execPath, execArgv: flags, entry: recorder.entry, stdin: "" });
      for (const name of denied) expect(row.env[name], name).toEqual({ present: false });
      for (const name of lookalikes) expect(row.env[name], name).toEqual({ present: true, sha256: digest(planted[name]) });
    }
    expect(stderr).toBe("");
  } finally {
    proc.stdin.end();
    const timeout = setTimeout(() => proc.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timeout);
  }

  // A caller-supplied environment has no trust exemption, nor any implicit process.env overlay.
  // macOS's dynamic loader seeds __CF_USER_TEXT_ENCODING when absent. Supply a fixture
  // value so the child can prove the exact handed key set on every platform.
  const handed = { ...planted, ACP_CHILD_RECORD: recorder.log, ONLY_HANDED: "雪\ncustom", EMPTY: "", __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0" };
  const expected = Object.fromEntries(Object.entries(handed).filter(([name]) => !denied.includes(name as typeof denied[number])));
  expect(childEnv(handed)).toEqual(expected);
  expect(handed.CLAUDECODE).toBe(planted.CLAUDECODE);
  expect(childEnv({})).toEqual({});
  expect(childEnv()).toEqual(childEnv(process.env));
  const originalEntry = process.argv[1];
  process.argv[1] = recorder.entry;
  try {
    const direct = await runCli(cwd, ["version", "--check"], handed);
    expect(direct.exitCode).toBe(1);
    const row = recorder.records().at(-1);
    expect(row.execArgv).toEqual(process.execArgv);
    expect(row.entry).toBe(recorder.entry);
    expect(Object.keys(row.env).filter(name => row.env[name].present).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected)) expect(row.env[name]).toEqual({ present: true, sha256: digest(value) });
    const input = new PassThrough();
    const b = rpc(line => { input.write(line); });
    const peer = createAcpAgent({ input, write: b.receive, env: handed });
    try {
      await b.request("initialize", { protocolVersion: 1 });
      const sessionId = (await b.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
      await b.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/plan" }] });
      expect(recorder.records().at(-1).env).toEqual(row.env);
    } finally { input.end(); await peer.done; }
  } finally { process.argv[1] = originalEntry; }
});

test("status answers one reading of the named or default run, the default being the bound run, else the live lock's run, else the newest journalled run, and each new or resumed session advertises its commands after the answer, so a reading of the wrong run fails", async () => {
  const cwd = makeRepo({ "work.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "status" }, tasks: [T("T1")] });
  saveGraph(cwd, graph);
  for (const id of ["run-bound", "run-live", "run-newest"]) {
    const dir = join(cwd, ".tickmarkr/runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "graph.json"), JSON.stringify(graph));
    writeFileSync(join(dir, "journal.jsonl"), [
      { ts: "2026-10-28T00:00:00Z", event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) } },
      { ts: "2026-10-28T00:00:01Z", event: "task-human", taskId: "T1", data: { kind: "human-gate", reason: "Needs decision" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  mkdirSync(join(cwd, ".tickmarkr/runs/run-zzz-empty"));
  const input = new PassThrough();
  const a = rpc(line => { input.write(line); });
  const peer = createAcpAgent({ input, write: a.receive });
  const snapshot = vi.spyOn(statusModule, "statusSnapshot");
  const lock = join(cwd, ".tickmarkr/graph.lock");
  try {
    expect((await a.request("initialize", { protocolVersion: 1 })).result.agentCapabilities).toEqual({ loadSession: false, sessionCapabilities: { list: {}, resume: {}, close: {} } });
    const start = a.output.length;
    const created = await a.request("session/new", { cwd, mcpServers: [] });
    const sessionId = created.result.sessionId;
    await tick();
    expect(a.output[start]).toBe(created);
    expect(advertised(a.output.slice(start))).toHaveLength(1);
    expect(advertised(a.output.slice(start))[0].params.update.availableCommands.map((command: any) => command.name)).toEqual(["attach", "status", "compile", "plan", "run", "resume"]);
    const status = async (sessionId: string, text: string, expectedId: string) => {
      const before = a.output.length;
      snapshot.mockClear();
      await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      expect(snapshot).toHaveBeenCalledExactlyOnceWith(cwd, expectedId);
      const result = messages(a.output.slice(before));
      expect(result).toHaveLength(1);
      const state = snapshot.mock.results[0].value;
      expect(result[0]).toContain(`Run: ${expectedId}\nLifecycle: ${state.lifecycle}\nDaemon: ${state.daemon}`);
      expect(result[0]).toContain(finalMessage(state));
      for (const park of state.parks) for (const command of park.commands) expect(result[0]).toContain(command.command);
      expect(state.parks[0].commands.length).toBeGreaterThan(0);
      expect(advertised(a.output.slice(before))).toHaveLength(0);
    };
    await status(sessionId, "/status", "run-newest");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: "run-live", startedAt: Date.now() }));
    const bytes = readFileSync(lock);
    await status(sessionId, "/status", "run-live");
    const resumeStart = a.output.length;
    const resumed = await a.request("session/resume", { cwd, sessionId: "run-bound" });
    await tick();
    expect(a.output[resumeStart]).toBe(resumed);
    expect(advertised(a.output.slice(resumeStart))).toHaveLength(1);
    expect(advertised(a.output.slice(resumeStart))[0].params.update.availableCommands.map((command: any) => command.name)).toEqual(["attach", "status", "compile", "plan", "run", "resume"]);
    await status("run-bound", "/status", "run-bound");
    await status("run-bound", "/status run-newest", "run-newest");
    expect(readFileSync(lock)).toEqual(bytes);
    writeFileSync(lock, JSON.stringify({ pid: 2147483000, runId: "run-live", startedAt: Date.now() }));
    await status(sessionId, "/status", "run-newest");
    const before = a.output.length;
    await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/status run-missing" }] });
    expect(messages(a.output.slice(before))).toEqual([expect.stringContaining("Status unavailable:")]);
  } finally { snapshot.mockRestore(); input.end(); await peer.done; }
});
