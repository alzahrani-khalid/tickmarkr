import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { createAcpAgent, preformatted } from "../../src/acp/server.js";
import { textContentSchema, validateAgentMessage } from "../helpers/acp-schema.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo, T } from "../helpers/tmprepo.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function agent(reply?: Parameters<typeof createAcpAgent>[0]["reply"]) {
  const input = new PassThrough();
  const output: any[] = [];
  const methods = new Map<unknown, string>();
  let stderr = "";
  let nextId = 0;
  const peer = createAcpAgent({ input, reply,
    write: (line) => {
      const message = JSON.parse(line);
      validateAgentMessage(message, methods.get(message.id));
      output.push(message);
    },
    stderr: (text) => { stderr += text; },
  });
  const send = (method: string, params?: unknown, notification = false) => {
    const id = ++nextId;
    methods.set(id, method);
    input.write(JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id } : {}), method, ...(params === undefined ? {} : { params }) }) + "\n");
    return id;
  };
  const response = async (id: number) => {
    await tick();
    await tick();
    const message = output.find((row) => row.id === id);
    expect(message, `answer to ${id}`).toBeDefined();
    return message;
  };
  return { input, output, send, response, stderr: () => stderr, end: async () => { input.end(); await peer.done; } };
}

test("initialize answers protocol version one for any requested integer with the tickmarkr name and package version, no auth methods and no session loading, any other request before it, an unknown one included, is refused without effect, and each answer validates against the vendored schema, so an unvalidated answer fails", async () => {
  const reply = vi.fn();
  const a = agent(reply);
  try {
    for (const [method, params] of [
      ["session/new", { cwd: "/tmp", mcpServers: [] }], ["session/prompt", { sessionId: "unknown", prompt: [] }],
      ["unknown", {}], ["unknown", []], ["session/cancel", { sessionId: "unknown" }],
    ] as const) {
      expect(await a.response(a.send(method, params))).toMatchObject({ error: { code: -32600 } });
    }
    const before = a.output.length;
    a.send("initialize", { protocolVersion: 1 }, true);
    a.send("session/new", { cwd: "/tmp", mcpServers: [] }, true);
    a.send("session/cancel", { sessionId: "unknown" }, true);
    a.send("unknown", {}, true);
    await tick();
    expect(a.output).toHaveLength(before);
    expect(await a.response(a.send("unknown", {}))).toMatchObject({ error: { code: -32600 } });
    for (const protocolVersion of [-1, 65536, 1.5, "1", null, true]) {
      expect(await a.response(a.send("initialize", { protocolVersion }))).toMatchObject({ error: { code: -32602 } });
    }
    expect(await a.response(a.send("session/new", {}))).toMatchObject({ error: { code: -32600 } });
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    for (const protocolVersion of [0, 1, 2, 9, 255, 256, 32767, 32768, 65534, 65535]) {
      const answer = await a.response(a.send("initialize", { protocolVersion }));
      expect(answer.result).toEqual({
        protocolVersion: 1, agentInfo: { name: "tickmarkr", version }, authMethods: [],
        agentCapabilities: { loadSession: false, sessionCapabilities: { list: {}, resume: {}, close: {} } },
      });
    }
    expect(await a.response(a.send("unknown", {}))).toMatchObject({ error: { code: -32601 } });
    expect(await a.response(a.send("session/prompt", { sessionId: "unknown", prompt: [] }))).toMatchObject({ error: { code: -32602 } });
    expect(reply).not.toHaveBeenCalled();
  } finally { await a.end(); }
});

test("a new session needs an absolute directory, a text block off the pinned v1 text shape or a block of no v1 type is refused as invalid params before anything runs, other v1 kinds are accepted by type unread, and free text names the directory and commands, so a coerced payload fails", async () => {
  const a = agent();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    for (const params of [{}, { cwd: "relative", mcpServers: [] }, { cwd: 7, mcpServers: [] },
      { cwd: "/tmp" }, { cwd: "/tmp", mcpServers: {} }, { cwd: "/tmp", mcpServers: null }]) {
      expect(await a.response(a.send("session/new", params))).toMatchObject({ error: { code: -32602 } });
    }
    const cwd = "/tmp/acp session 雪";
    const created = await a.response(a.send("session/new", { cwd, mcpServers: [{ deliberately: "unread" }, null] }));
    const sessionId = created.result.sessionId;
    expect(sessionId).toMatch(/^acp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const second = await a.response(a.send("session/new", { cwd, mcpServers: [] }));
    expect(second.result.sessionId).not.toBe(sessionId);
    const badText = [
      {}, { text: 4 }, { text: null }, { text: [] }, { text: "hi", _meta: [] }, { text: "hi", _meta: 5 },
      { text: "hi", annotations: [] }, { text: "hi", annotations: "bad" },
      { text: "hi", annotations: { audience: "user" } }, { text: "hi", annotations: { audience: ["system"] } },
      { text: "hi", annotations: { audience: [7] } }, { text: "hi", annotations: { priority: "1" } },
      { text: "hi", annotations: { lastModified: 1 } }, { text: "hi", annotations: { _meta: [] } },
    ];
    for (const text of badText) {
      expect(textContentSchema.safeParse(text).success).toBe(false);
      const before = a.output.length;
      expect(await a.response(a.send("session/prompt", { sessionId, prompt: [{ type: "text", ...text }] }))).toMatchObject({ error: { code: -32602 } });
      expect(a.output.slice(before)).toHaveLength(1);
    }
    for (const prompt of [null, "text", {}, [null], ["text"], [{}], [{ type: "video" }], [{ type: 1 }], [{ text: "hello" }]]) {
      const before = a.output.length;
      expect(await a.response(a.send("session/prompt", { sessionId, prompt }))).toMatchObject({ error: { code: -32602 } });
      expect(a.output.slice(before)).toHaveLength(1);
    }
    const texts = [
      { text: "What can I do here?" }, { text: "hi", annotations: null, _meta: null },
      { text: "hi", annotations: { audience: ["user", "assistant"], priority: 2, lastModified: "yesterday", _meta: { anything: [] } }, _meta: { anything: true } },
      { text: "hi", annotations: { audience: null, priority: null, lastModified: null, _meta: null } },
    ];
    for (const text of texts) {
      textContentSchema.parse(text);
      const before = a.output.length;
      const id = a.send("session/prompt", { sessionId, prompt: [{ type: "text", ...text }] });
      expect(await a.response(id)).toMatchObject({ result: { stopReason: "end_turn" } });
      const messages = a.output.slice(before).filter((row) => row.method === "session/update");
      expect(messages).toHaveLength(1);
      expect(messages[0].params).toMatchObject({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: expect.stringContaining(cwd) } } });
      for (const command of ["/attach [run]", "/status [run]", "/compile <spec>", "/plan", "/run", "/resume <run id>", "initialize", "session/new", "session/list", "session/resume", "session/close", "session/prompt", "session/cancel"]) expect(messages[0].params.update.content.text).toContain(command);
    }
    for (const type of ["image", "audio", "resource", "resource_link"]) {
      expect(await a.response(a.send("session/prompt", { sessionId, prompt: [{ type, text: { execute: "never" }, data: null, _meta: 7, annotations: false }] }))).toMatchObject({ result: { stopReason: "end_turn" } });
    }
    // A valid text before a bad block must not start a partial turn.
    const before = a.output.length;
    expect(await a.response(a.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "/run" }, { type: "not-v1" }] }))).toMatchObject({ error: { code: -32602 } });
    expect(a.output.slice(before)).toHaveLength(1);
    expect(a.stderr()).toBe("");
  } finally { await a.end(); }
});

test("/attach selects the live lock then newest journal, answers a journal-less run once, and session cancellation never changes a live lock", async () => {
  const cwd = makeRepo({ "work.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "server-attach" }, tasks: [T("T1")] });
  saveGraph(cwd, graph);
  const seed = (id: string, ended: boolean) => {
    const dir = join(cwd, ".tickmarkr", "runs", id);
    mkdirSync(dir, { recursive: true });
    const rows = [{ event: "run-start", data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) } },
      ...(ended ? [{ event: "merge", taskId: "T1", data: {} }, { event: "run-end", data: { failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" } }] : [])];
    writeFileSync(join(dir, "journal.jsonl"), rows.map(row => JSON.stringify({ ts: "2026-10-28T00:00:00.000Z", ...row })).join("\n") + "\n");
  };
  seed("run-newest", true);
  seed("run-live", false);
  mkdirSync(join(cwd, ".tickmarkr", "runs", "run-zz-empty"));
  const a = agent();
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const sessionId = (await a.response(a.send("session/new", { cwd, mcpServers: [] }))).result.sessionId;
    const prompt = (text: string) => a.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    expect(await a.response(prompt("/attach"))).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(a.output.filter(row => row.method === "session/update" && row.params.update.sessionUpdate === "tool_call").map(row => row.params.update.toolCallId)).toEqual(["run-newest/T1"]);
    const before = a.output.length;
    expect(await a.response(prompt("/attach run-zz-empty"))).toMatchObject({ result: { stopReason: "end_turn" } });
    const messages = a.output.slice(before).filter(row => row.method === "session/update");
    expect(messages).toHaveLength(1);
    expect(messages[0].params.update.content.text).toContain("No journal");
    const lock = join(cwd, ".tickmarkr", "graph.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: "run-live", startedAt: Date.now() }));
    const bytes = readFileSync(lock);
    const watching = prompt("/attach");
    await tick(); await tick();
    expect(a.output.find(row => row.id === watching)).toBeUndefined();
    expect(a.output.some(row => row.params?.update?.toolCallId === "run-live/T1")).toBe(true);
    a.send("session/cancel", { sessionId }, true);
    expect(await a.response(watching)).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(readFileSync(lock)).toEqual(bytes);
    expect(a.stderr()).toBe("");
  } finally { await a.end(); }
});

test("session cancellation ends only its running turn and handler faults return internal errors with stacks on stderr", async () => {
  const reply = vi.fn(async (_cwd: string, text: string, signal: AbortSignal) => {
    if (text === "fault") throw new Error("server fault sentinel");
    if (text === "wait") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return "reply";
  });
  const a = agent(reply);
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const sessionId = (await a.response(a.send("session/new", { cwd: "/tmp", mcpServers: [] }))).result.sessionId;
    const prompt = (text: string) => a.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const waiting = prompt("wait");
    await tick();
    await tick();
    a.send("session/cancel", { sessionId: "unknown" }, true);
    a.send("session/cancel", { sessionId: 7 }, true);
    await tick();
    expect(a.output.find((row) => row.id === waiting)).toBeUndefined();
    a.send("session/cancel", { sessionId }, true);
    expect(await a.response(waiting)).toMatchObject({ result: { stopReason: "cancelled" } });
    const immediate = prompt("cancel before handler");
    a.send("session/cancel", { sessionId }, true);
    expect(await a.response(immediate)).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(reply.mock.calls.map((args) => args[1])).toEqual(["wait"]);
    expect(await a.response(prompt("fault"))).toMatchObject({ error: { code: -32603 } });
    expect(a.stderr()).toContain("Error: server fault sentinel\n");
    expect(a.stderr()).toMatch(/server\.test\.ts:\d+/);
    expect(await a.response(prompt("after fault"))).toMatchObject({ result: { stopReason: "end_turn" } });
  } finally { await a.end(); }
});

test("every message chunk ends with a blank line, so a client appending a turn's chunks keeps each paragraph apart, and compile or plan output keeps its spacing in a fence longer than any backtick run, with controls escaped", async () => {
  expect(preformatted("T1  claude   0.4\nT2  codex    1.2\n")).toBe("```text\nT1  claude   0.4\nT2  codex    1.2\n```");
  expect(preformatted("a ```` b")).toBe("`````text\na ```` b\n`````");
  expect(preformatted("x\x1b[31my\ty\rz")).toBe("```text\nx\\x1b[31my\ty\\x0dz\n```");
  expect(preformatted("`a".repeat(150_000)).startsWith("```text\n`a`a")).toBe(true);
  const a = agent(async () => "first line\nsecond line");
  try {
    await a.response(a.send("initialize", { protocolVersion: 1 }));
    const cwd = makeRepo({ "a.txt": "a\n" });
    const sessionId = (await a.response(a.send("session/new", { cwd, mcpServers: [] }))).result.sessionId;
    const before = a.output.length;
    await a.response(a.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] }));
    const chunks = a.output.slice(before).filter((row) => row.params?.update?.sessionUpdate === "agent_message_chunk").map((row) => row.params.update.content.text);
    expect(chunks).toEqual(["first line\nsecond line\n\n"]);
  } finally { await a.end(); }
});
