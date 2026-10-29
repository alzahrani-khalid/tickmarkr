import fs, { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createAcpAgent } from "../../src/acp/server.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { listRunIds } from "../../src/run/runs-list.js";
import { makeRepo, T } from "../helpers/tmprepo.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const schema = JSON.parse(readFileSync(new URL("../fixtures/acp-v1/schema.json", import.meta.url), "utf8"));
const definitions: Record<string, string> = { "session/list": "ListSessionsResponse", "session/resume": "ResumeSessionResponse", "session/close": "CloseSessionResponse" };
function client() {
  const input = new PassThrough();
  const output: any[] = [];
  const methods = new Map<number, string>();
  let nextId = 0;
  const peer = createAcpAgent({ input, write: line => {
    const row = JSON.parse(line);
    const definition = definitions[methods.get(row.id)!];
    if (definition && !row.error) z.fromJSONSchema({ $defs: schema.$defs, $ref: `#/$defs/${definition}` }).parse(row.result);
    else validateAgentMessage(row, methods.get(row.id));
    output.push(row);
  } });
  const send = (method: string, params: unknown = {}, notification = false) => {
    const id = ++nextId;
    methods.set(id, method);
    input.write(JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id } : {}), method, params }) + "\n");
    return id;
  };
  const response = async (id: number) => {
    await tick(); await tick();
    const row = output.find(row => row.id === id);
    expect(row, `response ${id}`).toBeDefined();
    return row;
  };
  return { send, response, output, end: async () => { input.end(); await peer.done; } };
}
function fixture() {
  const cwd = makeRepo({ "work.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["specs/session.md"], hash: "sessions" }, tasks: [T("T1")] });
  saveGraph(cwd, graph);
  const seed = (id: string, ended = false) => {
    const dir = join(cwd, ".tickmarkr", "runs", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "journal.jsonl");
    writeFileSync(join(dir, "graph.json"), JSON.stringify(graph));
    const rows = [{ event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) } },
      ...(ended ? [{ event: "merge", taskId: "T1", data: {} }, { event: "run-end", data: { failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" } }] : [])];
    writeFileSync(path, rows.map(row => JSON.stringify({ ts: "2026-10-28T00:00:00Z", ...row })).join("\n") + "\n");
    return path;
  };
  return { cwd, seed };
}
const updates = (rows: any[]) => rows.filter(row => row.method === "session/update");
async function prompt(a: ReturnType<typeof client>, sessionId: string, text: string) {
  const before = a.output.length;
  expect(await a.response(a.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] })))
    .toMatchObject({ result: { stopReason: "end_turn" } });
  return updates(a.output.slice(before)).map(row => row.params.update);
}
const messages = (rows: any[]) => rows.filter(row => row.sessionUpdate === "agent_message_chunk").map(row => row.content.text);

test("the default run and resume membership read no run's graph file while the session listing keeps titles, so a selection that parses every run graph fails", async () => {
  const f = fixture();
  for (const id of ["run-a", "run-b", "run-c"]) f.seed(id, true);
  mkdirSync(join(f.cwd, ".tickmarkr/runs/run-zzz-empty"));
  f.seed("run-invalid!", true);
  mkdirSync(join(f.cwd, ".tickmarkr/runs/run-directory/journal.jsonl"), { recursive: true });
  writeFileSync(join(f.cwd, ".tickmarkr/runs/run-file"), "not a directory");
  const root = join(f.cwd, ".tickmarkr/runs") + "/";
  const graphReads: string[] = [];
  const read = fs.readFileSync;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    const path = String(args[0]);
    if (path.startsWith(root) && path.endsWith("/graph.json")) graphReads.push(path);
    return read(...args);
  });
  syncBuiltinESMExports();
  const a = client();
  try {
    expect(listRunIds(f.cwd)).toEqual(["run-c", "run-b", "run-a"]);
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const sessionId = (await a.response(a.send("session/new", { cwd: f.cwd, mcpServers: [] }))).result.sessionId;
    expect(messages(await prompt(a, sessionId, "/status"))).toEqual([expect.stringMatching(/^Run: run-c\n/u)]);
    const attached = await prompt(a, sessionId, "/attach");
    expect(attached.filter(row => row.sessionUpdate === "tool_call").map(row => row.toolCallId)).toEqual(["run-c/T1"]);
    expect((await a.response(a.send("session/resume", { cwd: f.cwd, sessionId: "run-a" }))).result).toEqual({});
    expect((await a.response(a.send("session/resume", { cwd: f.cwd, sessionId: "run-missing" }))).error.code).toBe(-32002);
    expect(graphReads).toEqual([]);

    const listed = (await a.response(a.send("session/list", { cwd: f.cwd }))).result.sessions;
    expect(listed.map(({ sessionId, title }: any) => ({ sessionId, title }))).toEqual([
      { sessionId: "run-c", title: "session.md" },
      { sessionId: "run-b", title: "session.md" },
      { sessionId: "run-a", title: "session.md" },
    ]);
    expect(graphReads).toEqual(["run-c", "run-b", "run-a"].map(id => join(root, id, "graph.json")));
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
    await a.end();
  }
});

test("a console session reselects the live lock after attaching to the newest run and status reads that live run", async () => {
  const f = fixture();
  f.seed("run-a", true);
  f.seed("run-b", true);
  const a = client();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const sessionId = (await a.response(a.send("session/new", { cwd: f.cwd, mcpServers: [] }))).result.sessionId;
    const first = await prompt(a, sessionId, "/attach");
    expect(first.filter(row => row.sessionUpdate === "tool_call").map(row => row.toolCallId)).toEqual(["run-b/T1"]);
    writeFileSync(join(f.cwd, ".tickmarkr/graph.lock"), JSON.stringify({ pid: process.pid, runId: "run-a", startedAt: Date.now() }));
    const second = await prompt(a, sessionId, "/attach");
    expect(second.filter(row => row.sessionUpdate === "tool_call").map(row => row.toolCallId)).toEqual(["run-a/T1"]);
    expect(messages(await prompt(a, sessionId, "/status"))).toEqual([expect.stringMatching(/^Run: run-a\n/u)]);
    expect(messages(await prompt(a, sessionId, "hello"))).toEqual([expect.stringContaining(`Session directory: ${f.cwd}`)]);
  } finally { await a.end(); }
});

test("attaching another run preserves a resumed session's run id for status, free text and bare attach", async () => {
  const f = fixture();
  f.seed("run-a", true);
  const other = f.seed("run-b");
  appendFileSync(other, [
    { event: "task-human", taskId: "T1", data: { kind: "human-gate", reason: "Needs decision" } },
    { event: "run-end", data: { failed: [], human: ["T1"], blocked: [], pending: [], tipVerify: "passed" } },
  ].map(row => JSON.stringify({ ts: "2026-10-28T00:00:01Z", ...row })).join("\n") + "\n");
  const a = client();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    await a.response(a.send("session/resume", { cwd: f.cwd, sessionId: "run-a" }));
    const attached = await prompt(a, "run-a", "/attach run-b");
    expect(attached.filter(row => row.sessionUpdate === "tool_call").map(row => row.toolCallId)).toEqual(["run-b/T1"]);
    expect(messages(attached)).toEqual([expect.stringMatching(/^NOT GREEN/u)]);
    expect(messages(await prompt(a, "run-a", "/status"))).toEqual([expect.stringMatching(/^Run: run-a\n/u)]);
    for (const text of ["watch my run", "/attach"]) {
      const bound = await prompt(a, "run-a", text);
      expect(bound.some(row => row.sessionUpdate === "plan")).toBe(true);
      expect(messages(bound)).toEqual([expect.stringMatching(/^GREEN/u)]);
    }
  } finally { await a.end(); }
});

test("only resume binds across bounded combinations of attachment targets, live or dead locks and newer journals", async () => {
  const f = fixture();
  const targets = ["run-a", "run-b", "run-c"];
  for (const runId of targets) f.seed(runId, true);
  const lock = join(f.cwd, ".tickmarkr/graph.lock");
  const a = client();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const consoleId = (await a.response(a.send("session/new", { cwd: f.cwd, mcpServers: [] }))).result.sessionId;
    await a.response(a.send("session/resume", { cwd: f.cwd, sessionId: "run-b" }));
    const phases = [
      { live: false, newest: "run-c" },
      { runId: "run-a", live: true, newest: "run-c" },
      { runId: "run-c", live: true, newest: "run-c" },
      { runId: "run-a", live: false, newest: "run-c" },
      { live: false, newest: "run-z" },
    ];
    for (const phase of phases) {
      if (phase.newest === "run-z") f.seed("run-z", true);
      if (phase.runId) writeFileSync(lock, JSON.stringify({ pid: phase.live ? process.pid : 2147483000, runId: phase.runId, startedAt: Date.now() }));
      else rmSync(lock, { force: true });
      for (const sessionId of [consoleId, "run-b"]) {
        const expected = sessionId === "run-b" ? sessionId : phase.live ? phase.runId! : phase.newest;
        for (const text of [...targets.map(runId => `/attach ${runId}`), "/attach"]) {
          await prompt(a, sessionId, text);
          expect(messages(await prompt(a, sessionId, "/status")), `${sessionId}: ${text}, ${JSON.stringify(phase)}`)
            .toEqual([expect.stringMatching(new RegExp(`^Run: ${expected}\\n`, "u"))]);
        }
      }
    }
  } finally { await a.end(); }
});

test("session list returns every journalled run of the requested or launch directory newest first in pages of at most fifty with an opaque cursor, run id as session id, spec file title and journal time, and refuses an unknown cursor, so a missed, unordered or unpaged run fails", async () => {
  const f = fixture();
  const ids = Array.from({ length: 107 }, (_, i) => `run-${String(i).padStart(3, "0")}`);
  const time = new Date("2026-02-03T04:05:06Z");
  // Deliberately create out of order, and give the oldest id the latest mtime.
  for (const id of [...ids.filter((_, i) => i % 2), ...ids.filter((_, i) => !(i % 2))]) {
    const path = f.seed(id);
    utimesSync(path, time, time);
  }
  utimesSync(join(f.cwd, ".tickmarkr/runs/run-000/journal.jsonl"), new Date(), new Date());
  mkdirSync(join(f.cwd, ".tickmarkr/runs/run-zzz-bait"));
  f.seed("run-invalid!");
  const before = readdirSync(join(f.cwd, ".tickmarkr"), { recursive: true }).sort();
  const a = client();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    let cursor: string | undefined;
    const listed: any[] = [];
    for (const count of [50, 50, 7]) {
      const { result } = await a.response(a.send("session/list", { cwd: f.cwd, cursor }));
      expect(result.sessions).toHaveLength(count);
      listed.push(...result.sessions);
      if (count === 50) expect(result.nextCursor).toBe(result.sessions.at(-1).sessionId);
      else expect(result.nextCursor).toBeUndefined();
      cursor = result.nextCursor;
    }
    expect(listed.map(row => row.sessionId)).toEqual(ids.reverse());
    for (const row of listed) expect(row).toEqual({ sessionId: row.sessionId, cwd: f.cwd, title: "session.md", updatedAt: row.sessionId === "run-000" ? expect.any(String) : time.toISOString() });
    expect((await a.response(a.send("session/list", { cwd: f.cwd, cursor: "run-zzz-bait" }))).error.code).toBe(-32602);
    expect((await a.response(a.send("session/list", { cwd: f.cwd, cursor: "run-missing" }))).error.code).toBe(-32602);
    for (const params of [{ cwd: "relative" }, { cwd: 1 }, { cursor: 1 }]) expect((await a.response(a.send("session/list", params))).error.code).toBe(-32602);
    // The launch directory is captured by each agent, not supplied by a session/new.
    const launchDirectory = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(f.cwd));
    let launch: ReturnType<typeof client>;
    try { launch = client(); }
    finally { launchDirectory.mockRestore(); }
    try {
      await launch.response(launch.send("initialize", { protocolVersion: 1 }));
      expect((await launch.response(launch.send("session/list"))).result.sessions[0].cwd).toBe(realpathSync(f.cwd));
    } finally { await launch.end(); }
    expect(readdirSync(join(f.cwd, ".tickmarkr"), { recursive: true }).sort()).toEqual(before);
  } finally { await a.end(); }
});

test("resuming a run answers before any update, then sends its commands, plan and tool calls and binds the session, while an unknown or journal-less run id is not found and a console id resumes idle with only its commands, so a replay before the answer fails", async () => {
  const f = fixture();
  f.seed("run-bound", true);
  f.seed("run-zzz-other", true);
  mkdirSync(join(f.cwd, ".tickmarkr/runs/run-empty"));
  const a = client();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const consoleId = (await a.response(a.send("session/new", { cwd: f.cwd, mcpServers: [] }))).result.sessionId;
    for (const sessionId of ["run-unknown", "run-empty", "acp-not-a-console-id"]) expect((await a.response(a.send("session/resume", { cwd: f.cwd, sessionId }))).error.code).toBe(-32002);
    // A console id, issued by this process or an earlier one, resumes idle (ACP-RESUME-001): the answer first, then only its commands.
    for (const sessionId of [consoleId, "acp-00000000-0000-4000-8000-000000000000"]) {
      const start = a.output.length;
      const id = a.send("session/resume", { cwd: f.cwd, sessionId, mcpServers: [] });
      expect((await a.response(id)).result).toEqual({});
      const rows = a.output.slice(start);
      expect(rows[0]).toMatchObject({ id, result: {} });
      expect(updates(rows).map(row => row.params.update.sessionUpdate)).toEqual(["available_commands_update"]);
    }
    const before = a.output.length;
    const id = a.send("session/resume", { cwd: f.cwd, sessionId: "run-bound", mcpServers: [] });
    expect((await a.response(id)).result).toEqual({});
    const replay = a.output.slice(before);
    expect(replay[0]).toMatchObject({ id, result: {} });
    expect(updates(replay).map(row => row.params.update.sessionUpdate)).toEqual(["available_commands_update", "plan", "tool_call"]);
    expect(updates(replay)[2].params.update.toolCallId).toBe("run-bound/T1");
    for (const text of ["watch this", "/attach"]) {
      const start = a.output.length;
      expect((await a.response(a.send("session/prompt", { sessionId: "run-bound", prompt: [{ type: "text", text }] }))).result.stopReason).toBe("end_turn");
      const projection = updates(a.output.slice(start));
      expect(projection.some(row => row.params.update.sessionUpdate === "plan")).toBe(true);
      expect(projection.some(row => row.params.update.toolCallId?.startsWith("run-zzz"))).toBe(false);
      expect(projection.filter(row => row.params.update.sessionUpdate === "agent_message_chunk")[0].params.update.content.text).toMatch(/^GREEN/u);
    }
    expect((await a.response(a.send("session/load", { cwd: f.cwd, sessionId: "run-bound" }))).error.code).toBe(-32601);
  } finally { await a.end(); }
});

test("closing one of two sessions watching one run cancels only its own turn and forgets it, cancel leaves the lock untouched, and a second prompt during a turn is refused while the turn continues, so a close stopping another session's watch fails", async () => {
  const f = fixture();
  const path = f.seed("run-live");
  const lock = join(f.cwd, ".tickmarkr/graph.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: "run-live", startedAt: Date.now() }));
  const bytes = readFileSync(lock);
  const a = client();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    await a.response(a.send("session/resume", { cwd: f.cwd, sessionId: "run-live" }));
    const one = "run-live";
    const two = (await a.response(a.send("session/new", { cwd: f.cwd, mcpServers: [] }))).result.sessionId;
    const prompt = (sessionId: string, text: string) => a.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const first = prompt(one, "watch");
    const second = prompt(two, "/attach run-live");
    await tick(); await tick();
    expect((await a.response(prompt(one, "interrupt"))).error.code).toBe(-32600);
    expect(a.output.some(row => row.id === first)).toBe(false);
    expect((await a.response(a.send("session/close", { sessionId: one }))).result).toEqual({});
    expect((await a.response(first)).result.stopReason).toBe("cancelled");
    expect(a.output.some(row => row.id === second)).toBe(false);
    expect(readFileSync(lock)).toEqual(bytes);
    for (const sessionId of [one, "unknown"]) expect((await a.response(a.send("session/close", { sessionId }))).error.code).toBe(-32602);
    expect((await a.response(prompt(one, "closed"))).error.code).toBe(-32602);
    const start = a.output.length;
    appendFileSync(path, JSON.stringify({ ts: "2026-10-28T00:00:01Z", event: "task-dispatch", taskId: "T1", data: {} }) + "\n");
    await new Promise(resolve => setTimeout(resolve, 1100));
    const next = updates(a.output.slice(start));
    expect(next.some(row => row.params.sessionId === two && row.params.update.sessionUpdate === "tool_call_update")).toBe(true);
    expect(next.some(row => row.params.sessionId === one)).toBe(false);
    a.send("session/cancel", { sessionId: two }, true);
    expect((await a.response(second)).result.stopReason).toBe("cancelled");
    expect(readFileSync(lock)).toEqual(bytes);
  } finally { await a.end(); }
});
