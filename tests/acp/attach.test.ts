import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { attach, type AttachSession } from "../../src/acp/attach.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { visibleControls, type JournalEvent } from "../../src/run/journal.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";
import { makeRepo, T } from "../helpers/tmprepo.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const ts = "2026-10-28T00:00:00.000Z";
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}): JournalEvent => ({ ts, event, taskId, data });
const encode = (rows: JournalEvent[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const end = () => row("run-end", undefined, { failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" });
const racingPid = 2_147_483_000;
function fixture(tasks = [T("T1")], pid: number | null = process.pid) {
  const cwd = makeRepo({ "work.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "attach" }, tasks });
  saveGraph(cwd, graph);
  const runId = "run-attach";
  const dir = join(cwd, ".tickmarkr", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.jsonl");
  const start = row("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), ...(pid === null ? {} : { pid }) });
  fs.writeFileSync(path, encode([start]));
  const append = (...rows: JournalEvent[]) => fs.appendFileSync(path, encode(rows));
  const updates: any[] = [];
  const signal = new AbortController();
  const session: AttachSession = { tools: new Map() };
  const send = (update: Record<string, unknown>) => {
    validateAgentMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } });
    updates.push(update);
  };
  const watch = (onTick: (tick: number) => void, ownSession = session) => {
    let tick = 0;
    return attach({ cwd, runId, signal: signal.signal, session: ownSession, send,
      sleep: async ms => { expect(ms).toBe(1000); if (++tick > 12) throw new Error("watch did not settle"); onTick(tick); } });
  };
  return { cwd, runId, path, start, append, updates, signal, session, watch };
}
const messages = (updates: any[]) => updates.filter(row => row.sessionUpdate === "agent_message_chunk");
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

test("test: an attached session shows one plan entry and one execute tool call per task by the closed state table, never completes an unmerged task, prefixes failed and parked entries, and after the first render sends only changed entries, so a task shown completed before its merge fails", async () => {
  const states = ["unknown", "pending", "blocked", "running", "completed", "merged", "human", "failed"];
  const controls = "title\x1b]52;c;bad\x07";
  const f = fixture(states.map((id, i) => T(id, { title: i === 0 ? controls : id })));
  const events: Record<string, string> = { pending: "task-approved", blocked: "task-blocked", running: "task-dispatch", completed: "task-done", merged: "merge", human: "task-human", failed: "task-failed" };
  f.append(row("task-human", "pending", { kind: "human-gate" }));
  for (const [id, event] of Object.entries(events)) f.append(row(event, id, event === "task-human" ? { kind: "human-gate", reason: controls }
    : event === "task-approved" ? { park: { line: 2, ts } } : {}));
  let firstLength = 0;
  expect(await f.watch(tick => {
    if (tick === 1) { firstLength = f.updates.length; return; }
    if (tick === 2) {
      expect(f.updates).toHaveLength(firstLength);
      f.append(row("merge", "completed"));
    } else {
      expect(f.updates.slice(firstLength).map(row => row.sessionUpdate)).toEqual(["plan", "tool_call_update"]);
      f.signal.abort();
    }
  })).toEqual({ stopReason: "cancelled" });
  const plan = f.updates[0];
  expect(plan.sessionUpdate).toBe("plan");
  expect(plan.entries.map((entry: any) => entry.status)).toEqual(["pending", "pending", "pending", "in_progress", "in_progress", "completed", "pending", "pending"]);
  expect(plan.entries.map((entry: any) => entry.content)).toEqual(states.map(id => `${id === "human" ? "[needs you] " : id === "failed" ? "[failed] " : ""}${id} · ${id === "unknown" ? visibleControls(controls) : id}`));
  const calls = f.updates.filter(row => row.sessionUpdate === "tool_call");
  expect(calls).toHaveLength(states.length);
  expect(calls.map(row => row.toolCallId)).toEqual(states.map(id => `${f.runId}/${id}`));
  expect(calls.map(row => row.status)).toEqual(["pending", "pending", "pending", "in_progress", "in_progress", "completed", "pending", "failed"]);
  for (const [index, call] of calls.entries()) {
    expect(call.kind).toBe("execute");
    expect(call.content[0].content.text).toContain(`state ${states[index]};`);
    for (const word of ["state", "gates", "tries", "seats", "phase"]) expect(call.content[0].content.text).toContain(word);
    expect(call.content[0].content.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
  }
  expect(calls.find(call => call.toolCallId.endsWith("/human")).content[0].content.text).toContain(`[needs you] human-gate — ${visibleControls(controls)}`);
  expect(f.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: `${f.runId}/completed`, status: "completed" });
  // Reattaching the same session must update existing IDs, never open them twice.
  const again = new AbortController();
  await attach({ cwd: f.cwd, runId: f.runId, session: f.session, signal: again.signal,
    send: update => f.updates.push(update), sleep: async () => { again.abort(); } });
  expect(f.updates.filter(row => row.sessionUpdate === "tool_call")).toHaveLength(states.length);
});

test("test: a park, a task failure, gate rows and window rows each update an attached session without ending its turn, while a run end ends it with one final message from a fresh status read, so a turn ended by a wake fails", async () => {
  const observations = [
    row("task-human", "T1", { kind: "human-gate", reason: "needs you" }),
    row("task-failed", "T1"), row("gate-result", "T1", { gate: "build", pass: true }),
    row("phase-start", "T1", { phase: "gate:review" }),
    row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }), row("approval-window-expired"),
  ];
  for (const observation of observations) {
    const f = fixture();
    if (observation.event === "approval-window-expired") f.append(row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }));
    let before = 0;
    let beforeMessages = 0;
    const alerts = ["task-human", "approval-window-start", "approval-window-expired"].includes(observation.event) ? 1 : 0;
    const result = await f.watch(tick => {
      if (tick === 1) { before = f.updates.length; beforeMessages = messages(f.updates).length; f.append(observation); }
      else if (tick === 2) {
        expect(f.updates.length).toBeGreaterThan(before);
        expect(messages(f.updates)).toHaveLength(beforeMessages + alerts);
        f.append(row("task-done", "T1"), row("merge", "T1"), end());
      } else throw new Error("run end was lost");
    });
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(messages(f.updates)).toHaveLength(beforeMessages + alerts + 1);
    expect(messages(f.updates).at(-1).content.text.split("\n")[0]).toBe("GREEN — every clause holds");
    expect(vi.mocked(fs.readFileSync).mock.calls.filter(args => args[0] === f.path).length).toBeGreaterThanOrEqual(4);
  }
  const f = fixture();
  // A journal with no recorded pid must continue watching even with a live lock holder.
  fs.writeFileSync(f.path, encode([{ ...f.start, data: { graphDefinitionHash: f.start.data.graphDefinitionHash } }]));
  fs.writeFileSync(join(f.cwd, ".tickmarkr", "graph.lock"), JSON.stringify({ pid: process.pid, runId: f.runId, startedAt: Date.now() }));
  expect(await f.watch(tick => { if (tick === 2) f.signal.abort(); })).toEqual({ stopReason: "cancelled" });
  expect(messages(f.updates)).toHaveLength(0);
});

test("test: a daemon dying with no further journal byte ends the turn not green naming resume, a death-confirmation re-read bringing a park then a run end ends it at that run end, and a journal replaced or truncated at that re-read ends it not green as unreadable, never an error, so a lost row fails", async () => {
  for (const mode of ["silent", "park-end", "replace", "truncate"] as const) {
    const f = fixture([T("T1")], racingPid);
    const original = process.kill.bind(process);
    let probes = 0;
    let changed = false;
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid !== racingPid || sig !== 0) return original(pid, sig);
      if (++probes < 4) return true;
      if (!changed) {
        changed = true;
        // Exactly inside classifyWake's liveness probe, between its two tail reads.
        if (mode === "park-end") f.append(row("task-human", "T1", { kind: "human-gate" }), row("task-done", "T1"), row("merge", "T1"), end());
        if (mode === "replace") {
          fs.renameSync(f.path, `${f.path}.old`);
          fs.writeFileSync(f.path, encode([f.start, row("merge", "T1"), end()]));
        }
        if (mode === "truncate") fs.truncateSync(f.path, 0);
      }
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    // Each tick probes once in statusSnapshot, then once in classifyWake. Die in the
    // second classifier probe without adding ANY byte during the intervening sleep.
    let ticks = 0;
    const result = await attach({ cwd: f.cwd, runId: f.runId, session: f.session, signal: f.signal.signal,
      send: update => { validateAgentMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } }); f.updates.push(update); },
      sleep: async () => { if (++ticks > 3) throw new Error("death not classified"); } });
    expect(result).toEqual({ stopReason: "end_turn" });
    const final = messages(f.updates).at(-1)!.content.text;
    if (mode === "park-end") expect(final.split("\n")[0]).toBe("GREEN — every clause holds");
    else {
      expect(final).toMatch(/^NOT GREEN — /u);
      if (mode === "silent") { expect(final).toContain("journal line 1"); expect(final).toContain(`tickmarkr resume ${f.runId}`); }
      else expect(final).toContain("unreadable");
    }
    expect(messages(f.updates)).toHaveLength(1);
    vi.restoreAllMocks();
  }
});

test("a failed snapshot warns once and keeps watching; replacement or truncation at a tick ends unreadable", async () => {
  for (const mode of ["throws", "replace", "truncate"] as const) {
    const f = fixture();
    const read = vi.mocked(fs.readFileSync).getMockImplementation()!;
    let unavailable = false;
    vi.mocked(fs.readFileSync).mockImplementation(((...args: any[]) => {
      if (args[0] === f.path && unavailable) throw new Error("read failed");
      return (read as any)(...args);
    }) as typeof fs.readFileSync);
    const result = await f.watch(tick => {
      if (mode === "throws") { unavailable = true; if (tick === 3) f.signal.abort(); }
      else if (mode === "replace") { fs.renameSync(f.path, `${f.path}.old`); fs.writeFileSync(f.path, encode([f.start, row("merge", "T1"), end()])); }
      else fs.truncateSync(f.path, 0);
    });
    expect(result.stopReason).toBe(mode === "throws" ? "cancelled" : "end_turn");
    const shown = messages(f.updates);
    expect(shown.filter(row => row.content.text.includes("still watching")).length).toBeLessThanOrEqual(1);
    expect(shown.at(-1).content.text).toContain(mode === "throws" ? "still watching" : "unreadable");
    vi.restoreAllMocks();
  }
});

test("a mistyped run id is answered as not a run id and ends the turn, never as an unreadable journal or a verdict", async () => {
  const f = fixture();
  for (const typed of ["4099", "latest", "../x", "run-a\x1bb"]) {
    const updates: any[] = [];
    const result = await attach({ cwd: f.cwd, runId: typed, signal: f.signal.signal, session: { tools: new Map() },
      send: update => { validateAgentMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } }); updates.push(update); } });
    expect(result, typed).toEqual({ stopReason: "end_turn" });
    expect(messages(updates).map(update => update.content.text), typed).toEqual([`Not a run id: ${visibleControls(typed)}`]);
  }
});
