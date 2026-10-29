import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { attach, type AttachSession } from "../../src/acp/attach.js";
import { createAcpAgent } from "../../src/acp/server.js";
import { createParkPresentation } from "../../src/acp/parks.js";
import { approvalDispositionForRelease, approvalEnactment, approvalRunOwner, releaseForDecision } from "../../src/cli/commands/approve.js";
import * as approval from "../../src/cli/commands/approve.js";
import { statusSnapshot } from "../../src/cli/commands/status-snapshot.js";
import * as snapshots from "../../src/cli/commands/status-snapshot.js";
import { JournalTail } from "../../src/cli/commands/wait.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { visibleControls, type JournalEvent } from "../../src/run/journal.js";
import { makeRepo, T } from "../helpers/tmprepo.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), appendFileSync: vi.fn(actual.appendFileSync),
    mkdirSync: vi.fn(actual.mkdirSync), openSync: vi.fn(actual.openSync) };
});
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync), exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync), execFile: vi.fn(actual.execFile), execFileSync: vi.fn(actual.execFileSync) };
});

const ts = "2026-10-28T00:00:00.000Z";
const later = "2026-10-28T00:01:00.000Z";
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}, at = ts): JournalEvent => ({ ts: at, event, taskId, data });
const encode = (rows: JournalEvent[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const messageText = (updates: any[]) => updates.filter(update => update.sessionUpdate === "agent_message_chunk").map(update => update.content.text as string);
const toolText = (tool: any): string => tool.content[0].content.text;
const tools = (updates: any[]) => updates.filter(update => ["tool_call", "tool_call_update"].includes(update.sessionUpdate));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(ids = ["T1"]) {
  const cwd = makeRepo({ "work.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "parks" }, tasks: ids.map(id => T(id)) });
  saveGraph(cwd, graph);
  const runId = "run-parks";
  const dir = join(cwd, ".tickmarkr", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.jsonl");
  fs.writeFileSync(path, encode([row("run-start", undefined, { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) })]));
  const append = (...rows: JournalEvent[]) => fs.appendFileSync(path, encode(rows));
  const lock = join(cwd, ".tickmarkr", "graph.lock");
  const own = (ownerRunId = runId) => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: ownerRunId, startedAt: Date.now() }));
  const updates: any[] = [];
  const session: AttachSession = { tools: new Map() };
  const watch = async (onTick: (n: number) => void, ownSession = session) => {
    const signal = new AbortController();
    let n = 0;
    const result = await attach({ cwd, runId, session: ownSession, signal: signal.signal,
      send: update => {
        validateAgentMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } });
        updates.push(update);
      },
      sleep: async ms => {
        expect(ms).toBe(1000);
        if (++n > 12) throw new Error("park watch did not settle");
        onTick(n);
        if (n === 8) signal.abort();
      } });
    expect(result).toEqual({ stopReason: "cancelled" });
  };
  return { cwd, runId, path, append, lock, own, updates, session, watch };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

test("a window closed by the row the first snapshot read unterminated is never announced", () => {
  for (const closer of ["task-dispatch", "run-resume", "approval-window-expired"]) {
    const f = fixture();
    f.append(row("task-human", "T1", { kind: "human-gate", reason: "waiting" }),
      row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }));
    fs.appendFileSync(f.path, JSON.stringify(row(closer, "T1")));
    const alerts: string[] = [];
    const p = createParkPresentation(f.cwd, f.runId, text => alerts.push(text));
    const s0 = statusSnapshot(f.cwd, f.runId);
    expect(s0.sequence).toBe(4);
    expect(s0.approvalWindow).toBeNull();
    p.render(s0);
    const fd = fs.openSync(f.path, "r");
    const tail = new JournalTail(f.path, fd);
    try {
      tail.read();
      p.windows(tail.events, tail.completeLineCount);
      fs.appendFileSync(f.path, "\n");
      for (let n = 0; n < 3; n++) {
        const state = statusSnapshot(f.cwd, f.runId);
        expect(state.approvalWindow).toBeNull();
        p.render(state);
        tail.read();
        p.windows(tail.events, tail.completeLineCount);
      }
      expect(alerts.filter(text => text.startsWith("Approval window closes at")), closer).toEqual([]);
    } finally { fs.closeSync(fd); }
  }
});

test("approval openings follow the initial physical boundary across closing rows, tail completion orders and later closed windows", () => {
  const f = fixture();
  const header = fs.readFileSync(f.path, "utf8");
  // Blank and invalid physical rows must not shift the snapshot/tail boundary.
  const history = header + "\n{torn history}\n" + encode([
    row("task-human", "T1", { kind: "human-gate", reason: "waiting" }),
    row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }),
    row("approval-window-expired"),
    row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }, later),
  ]);
  const future = "2026-10-28T00:02:00.000Z";
  const closers = ["task-dispatch", "run-resume", "approval-window-expired", "run-start", "run-end", "task-approved"];
  for (const closer of closers) for (const ending of ["terminated", "unterminated", "torn"]) {
    for (const completesBeforeTailRead of [false, true]) {
      // The approval names the park's physical line, including the blank/invalid rows.
      const text = JSON.stringify(row(closer, "T1", closer === "task-approved" ? { park: { line: 4, ts } } : {}));
      const cut = ending === "torn" ? text.length - 7 : text.length;
      fs.writeFileSync(f.path, history + text.slice(0, cut) + (ending === "terminated" ? "\n" : ""));
      const alerts: string[] = [];
      const p = createParkPresentation(f.cwd, f.runId, text => alerts.push(text));
      const initial = statusSnapshot(f.cwd, f.runId);
      expect(initial.sequence).toBe(8);
      expect(initial.approvalWindow !== null).toBe(ending === "torn");
      p.render(initial);
      const expected = ending === "torn" ? [expect.stringContaining("2026-10-28T00:01:10.000Z")] : [];
      const openings = () => alerts.filter(text => text.startsWith("Approval window closes at"));
      const complete = () => {
        if (ending !== "terminated") fs.appendFileSync(f.path, text.slice(cut) + "\n");
      };
      const fd = fs.openSync(f.path, "r");
      const tail = new JournalTail(f.path, fd);
      const poll = () => {
        const state = statusSnapshot(f.cwd, f.runId);
        expect(state.approvalWindow).toBeNull();
        p.render(state);
        tail.read();
        p.windows(tail.events, tail.completeLineCount);
      };
      try {
        if (completesBeforeTailRead) complete();
        for (let n = 0; n < 2; n++) { tail.read(); p.windows(tail.events, tail.completeLineCount); }
        if (!completesBeforeTailRead) complete();
        for (let n = 0; n < 3; n++) poll();
        expect(openings(), `${closer}/${ending}/${completesBeforeTailRead}`).toEqual(expected);
        // A later window can open and close between snapshots: the tail still announces it once.
        f.append(row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }, future),
          row("approval-window-expired", undefined, {}, future));
        for (let n = 0; n < 3; n++) poll();
        expect(openings()).toEqual([...expected, expect.stringContaining("2026-10-28T00:02:10.000Z")]);
      } finally { fs.closeSync(fd); }
    }
  }
});

test("each approval window is announced exactly once by its close time whether the first snapshot read its start row unterminated or torn, so a repeated or missed opening fails", () => {
  for (const torn of [false, true]) for (const completesBeforeTailRead of [false, true]) {
    const f = fixture();
    f.append(row("task-human", "T1", { kind: "human-gate", reason: "waiting" }));
    const start = row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] });
    const text = JSON.stringify(start);
    const cut = torn ? text.length - 7 : text.length;
    fs.appendFileSync(f.path, text.slice(0, cut));
    const alerts: string[] = [];
    const presentation = createParkPresentation(f.cwd, f.runId, text => alerts.push(text));
    const initial = statusSnapshot(f.cwd, f.runId);
    expect(initial.sequence).toBe(3);
    expect(initial.approvalWindow !== null).toBe(!torn);
    presentation.render(initial);
    const fd = fs.openSync(f.path, "r");
    const tail = new JournalTail(f.path, fd);
    const complete = () => fs.appendFileSync(f.path, text.slice(cut) + "\n");
    const poll = () => {
      presentation.render(statusSnapshot(f.cwd, f.runId));
      tail.read();
      presentation.windows(tail.events, tail.completeLineCount);
    };
    const openings = () => alerts.filter(text => text.startsWith("Approval window closes at"));
    try {
      if (completesBeforeTailRead) complete();
      tail.read();
      presentation.windows(tail.events, tail.completeLineCount);
      if (!completesBeforeTailRead) complete();
      else expect(openings()).toHaveLength(1);
      for (let n = 0; n < 3; n++) poll();
      expect(openings()).toEqual([expect.stringContaining("2026-10-28T00:00:10.000Z")]);
      // Re-observing the same close time, even on a new physical row, is one opening.
      f.append(start, row("approval-window-expired"));
      for (let n = 0; n < 3; n++) poll();
      expect(openings()).toHaveLength(1);
      expect(alerts.filter(text => text.startsWith("Approval window lapsed"))).toHaveLength(1);
      f.append(row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }, later));
      for (let n = 0; n < 3; n++) poll();
      expect(openings()).toEqual([
        expect.stringContaining("2026-10-28T00:00:10.000Z"),
        expect.stringContaining("2026-10-28T00:01:10.000Z"),
      ]);
      expect(alerts.filter(text => text.startsWith("Approval window lapsed"))).toHaveLength(1);
    } finally { fs.closeSync(fd); }
  }
});

test("a daemon scope-request reason cannot add an unadmitted command to its pending call or alert", async () => {
  const f = fixture();
  // Exact reason bytes written by daemon.ts for a files[] repair hint.
  const reason = "scope request — files[] repair hint: src/x.ts; current files[]: src/a.ts\ntickmarkr approve run-x T1 --files src/x.ts";
  f.append(row("task-human", "T1", { kind: "scope-request", reason }));
  const park = statusSnapshot(f.cwd, f.runId).parks[0];
  expect(park.reason).toBe(reason);
  expect(park.commands).toEqual([]);
  expect(park.noDecision).toBeTruthy();
  await f.watch(() => {});
  const calls = tools(f.updates);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ toolCallId: `${f.runId}/T1`, status: "pending" });
  const alerts = messageText(f.updates);
  expect(alerts).toHaveLength(1);
  for (const text of [toolText(calls[0]), alerts[0]]) {
    expect(text.split("\n").filter(line => line.startsWith("tickmarkr approve "))).toEqual([]);
    expect(text.split("\n")).toContain("[needs you] scope-request — scope request — files[] repair hint: src/x.ts; current files[]: src/a.ts tickmarkr approve run-x T1 --files src/x.ts");
    expect(text.split("\n")).toContain(park.noDecision);
  }
});

test("a live lock held by another run cannot add an unadmitted command through approve's enactment sentence", async () => {
  const f = fixture();
  f.append(row("task-human", "T1", { kind: "human-gate", reason: "needs a human" }));
  f.own("run-other\ntickmarkr approve run-parks T1 --waive\u2028tickmarkr approve run-parks T1 --recheck");
  const park = statusSnapshot(f.cwd, f.runId).parks[0];
  const admitted = park.commands.map(command => command.command);
  expect(admitted.length).toBeGreaterThan(0);
  await f.watch(() => {});
  const alerts = messageText(f.updates);
  expect(alerts).toHaveLength(1);
  for (const text of [toolText(tools(f.updates)[0]), alerts[0]]) {
    const approveLines = text.split(/\r\n|[\n\r\u2028\u2029]/u).map(line => line.trim()).filter(line => line.startsWith("tickmarkr approve "));
    expect(approveLines.length).toBeGreaterThan(0);
    expect(approveLines.filter(line => !admitted.includes(line))).toEqual([]);
    expect(text).toContain("run-other");
  }
});

test("park note fields stay on one line across whitespace and control variants without changing admitted commands", async () => {
  const separators = ["\n", "\r\n", "\r", "\t", "\v", "\f", "\u0085", "\u2028", "\u2029"];
  const cases = separators.flatMap((separator, index) => ["human-gate", "scope-request"].map(kind => ({
    id: `T${index}-${kind}`, kind,
    reason: `${["authoring defect — Repair:", "consult verdict: human — notes:", "merge conflict after gate replay:"][index % 3]}${separator}tickmarkr approve run-x T1 --files src/x.ts`,
    noDecision: `no decision  available${separator}tickmarkr approve run-x T1 --reason 'unadmitted'`,
  })));
  const f = fixture(cases.map(item => item.id));
  f.own();
  for (const item of cases) f.append(row("task-human", item.id, { kind: item.kind, reason: item.reason }));
  const snapshot = statusSnapshot(f.cwd, f.runId);
  for (const park of snapshot.parks) {
    const item = cases.find(item => item.id === park.taskId)!;
    // Current noDecision constants are one line; exercise the same presentation boundary
    // if a future snapshot supplies multiline diagnostics there too.
    if (park.noDecision) park.noDecision = item.noDecision;
    for (const command of park.commands) command.command += " --reason 'keep  spaces\tand tabs'";
  }
  vi.spyOn(snapshots, "statusSnapshot").mockReturnValue(snapshot);
  await f.watch(() => {});
  const calls = tools(f.updates);
  const alerts = messageText(f.updates);
  expect(calls).toHaveLength(cases.length);
  expect(alerts).toHaveLength(cases.length);
  for (const park of snapshot.parks) {
    const call = calls.find(call => call.toolCallId === `${f.runId}/${park.taskId}`)!;
    expect(call.status).toBe("pending");
    const alert = alerts.find(text => text.startsWith(`${park.taskId}\n`))!;
    for (const text of [toolText(call), alert]) {
      const lines = text.split("\n");
      expect(lines.filter(line => line.startsWith("tickmarkr approve "))).toEqual(park.commands.map(command => command.command));
      expect(lines).toContain(`[needs you] ${park.kind} — ${visibleControls(park.reason!)}`);
      if (park.noDecision) expect(lines).toContain(visibleControls(park.noDecision));
      for (const { verb, command } of park.commands) {
        expect(text).toContain(`${command}\n${approvalEnactment(approvalDispositionForRelease(releaseForDecision(verb,
          { kind: park.kind ?? undefined, failedGate: undefined })), approvalRunOwner(f.cwd, f.runId))}`);
      }
    }
  }
});

test("test: every row of the closed park table shows its task as a pending tool call carrying exactly the snapshot's commands, each with approve's enactment sentence for the current owner, while the no-decision rows carry their reason and no command, so a re-derived or missing command fails", async () => {
  const table = [
    { id: "human", kind: "human-gate", verbs: ["approve"] },
    { id: "cap", kind: "attempt-cap", verbs: ["approve"] },
    { id: "other", kind: "future-kind", verbs: ["approve"] },
    { id: "stall", kind: "stall", verbs: ["approve"] },
    { id: "infra", kind: "infra", verbs: ["approve", "recheck"] },
    { id: "reap", kind: "stall", reapFailure: "census unreadable", verbs: ["approve", "recheck"] },
    ...["build", "test", "lint"].map(gate => ({ id: `author-${gate}`, kind: "authoring", gate, verbs: ["approve", "recheck"] })),
    { id: "author-review", kind: "authoring", gate: "review", verbs: ["approve"] },
    { id: "review", kind: "gate-fail", gate: "review", verbs: ["waive", "uphold", "recheck"] },
    ...["build", "test", "lint", "scope", "evidence", "acceptance"].map(gate => ({ id: `gate-${gate}`, kind: "gate-fail", gate, verbs: ["waive", "recheck"] })),
    { id: "diff", kind: "diff-cap", verbs: ["recheck"] },
    { id: "tombstone", kind: "human-gate", reason: "retired — tombstone", verbs: [] },
    { id: "scope", kind: "scope-request", verbs: [] },
    { id: "untimed", kind: "human-gate", untimed: true, verbs: [] },
    { id: "no-gate", kind: "gate-fail", verbs: [] },
  ];
  const f = fixture(table.map(item => item.id));
  f.own();
  for (const item of table) {
    if ("gate" in item) f.append(row("gate-result", item.id, { gate: item.gate, pass: false }));
    const park = row("task-human", item.id, { kind: item.kind, reason: "reason" in item ? item.reason : `waiting ${item.id}`,
      ...("reapFailure" in item ? { reapFailure: item.reapFailure } : {}) });
    if ("untimed" in item) delete (park as Partial<JournalEvent>).ts;
    f.append(park);
  }
  const snapshot = statusSnapshot(f.cwd, f.runId);
  expect(snapshot.parks).toHaveLength(table.length);
  // Distinctive snapshot bytes make a local command reconstruction fail, including
  // one that picks the right verbs but loses quoting or significant whitespace.
  snapshot.parks.find(park => park.taskId === "other")!.commands[0].command += " --reason 'snapshot  owns this command'";
  vi.spyOn(snapshots, "statusSnapshot").mockReturnValue(snapshot);
  await f.watch(n => {
    if (n > 1) return;
    const calls = tools(f.updates);
    expect(calls).toHaveLength(table.length);
    table.forEach((item, index) => {
      const park = snapshot.parks.find(park => park.taskId === item.id)!;
      expect(park.commands.map(command => command.verb)).toEqual(item.verbs);
      const call = calls[index];
      expect(call).toMatchObject({ toolCallId: `${f.runId}/${item.id}`, status: "pending" });
      const text = toolText(call);
      expect(text).toContain(`[needs you] ${park.kind} — ${park.reason}`);
      expect(text.split("\n").filter(line => line.startsWith("tickmarkr approve "))).toEqual(park.commands.map(command => command.command));
      for (const { verb, command } of park.commands) {
        expect(text).toContain(`${command}\n${approvalEnactment(approvalDispositionForRelease(releaseForDecision(verb,
          { kind: park.kind ?? undefined, failedGate: undefined })), approvalRunOwner(f.cwd, f.runId))}`);
      }
      if (!item.verbs.length) { expect(park.noDecision).toBeTruthy(); expect(text).toContain(park.noDecision!); }
    });
  });
});

test("test: each open park alerts once per turn by its park token, a new token on the same task alerts once more, and later polls repeat nothing, so an alert per poll or a missed re-park fails", async () => {
  const f = fixture(["T1", "untimed"]);
  f.append(row("task-human", "T1", { kind: "human-gate", reason: "first" }));
  const untimed = row("task-human", "untimed", { kind: "infra", reason: "no time" });
  delete (untimed as Partial<JournalEvent>).ts;
  f.append(untimed);
  let count = 0;
  await f.watch(n => {
    if (n <= 3) {
      expect(messageText(f.updates)).toHaveLength(2);
      if (n === 1) count = f.updates.length;
      else expect(f.updates).toHaveLength(count);
    }
    if (n === 3) f.append(row("task-human", "T1", { kind: "human-gate", reason: "first" }), untimed);
    if (n >= 4) expect(messageText(f.updates)).toHaveLength(3);
  });
  const before = messageText(f.updates).length;
  // A new turn in the same session owns a fresh alert set, even when tool IDs already exist.
  await f.watch(() => {});
  expect(messageText(f.updates)).toHaveLength(before + 2);
  expect(tools(f.updates).filter(tool => tool.sessionUpdate === "tool_call")).toHaveLength(2);
});

test("test: the window's opening states its close time and condition and its expiry states the lapse, neither ending the turn, and the enactment names resume only once no live daemon owns the run, so a resume promised to a live run fails", async () => {
  for (const alreadyOpen of [true, false]) {
    const f = fixture(["T1", "failed"]);
    f.own();
    f.append(row("task-human", "T1", { kind: "attempt-cap", reason: "budget" }), row("task-failed", "failed"));
    const start = row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] });
    if (alreadyOpen) f.append(start);
    await f.watch(n => {
      if (n === 1 && !alreadyOpen) { f.append(start); return; }
      const shown = messageText(f.updates);
      expect(shown.filter(text => text.startsWith("Approval window closes"))).toHaveLength(1);
      const opening = shown.find(text => text.startsWith("Approval window closes"))!;
      for (const phrase of ["2026-10-28T00:00:10.000Z", "nothing is in flight", "a task is parked", "every pending task waits transitively behind a park", "failed task does not prevent it"]) expect(opening).toContain(phrase);
      if (n === 2) {
        expect(toolText(tools(f.updates).filter(tool => tool.toolCallId.endsWith("/T1")).at(-1))).toContain("Approval window closes at 2026-10-28T00:00:10.000Z");
        f.append(row("approval-window-expired"));
      }
      if (n >= 3) {
        expect(shown.filter(text => text.startsWith("Approval window lapsed"))).toHaveLength(1);
        expect(shown.find(text => text.startsWith("Approval window lapsed"))).toContain("before final close");
      }
      const current = toolText(tools(f.updates).filter(tool => tool.toolCallId.endsWith("/T1")).at(-1));
      if (n <= 3) {
        expect(current).toContain("the live daemon enacts this at its next task boundary");
        expect(current).not.toContain("tickmarkr resume");
      }
      if (n === 3) f.own("another-run");
      if (n === 4) {
        expect(current).toContain("live run `another-run` holds the repository lock");
        expect(current).not.toContain("tickmarkr resume");
        fs.unlinkSync(f.lock);
      }
      if (n >= 5) expect(current).toContain(`run \`tickmarkr resume ${f.runId}\` to dispatch it on a fresh attempt budget`);
      expect(shown.every(text => !text.startsWith("NOT GREEN") && !text.startsWith("GREEN"))).toBe(true);
    });
  }
});

test("test: across a session holding open parks, an approval window and its expiry, acp sends no client request of any kind, writes no journal row and creates no state file, so a permission request or a recorded decision fails", async () => {
  const f = fixture();
  f.own();
  f.append(row("task-human", "T1", { kind: "infra", reason: "host unavailable" }), row("approval-window-start", undefined, { windowMs: 10000, parked: ["T1"] }));
  const tree = (dir: string): Record<string, string> => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(tree(path)) : [[path, fs.readFileSync(path).toString("base64")]];
  }));
  const stateDir = join(f.cwd, ".tickmarkr");
  const before = tree(stateDir);
  const input = new PassThrough();
  const output: any[] = [];
  const methods = new Map([[1, "initialize"], [2, "session/new"], [3, "session/prompt"]]);
  const peer = createAcpAgent({ input, write: line => {
    const message = JSON.parse(line);
    // Any outbound request is forbidden, regardless of its method name.
    expect(message.method === undefined || message.id === undefined).toBe(true);
    validateAgentMessage(message, methods.get(message.id));
    output.push(message);
  } });
  const send = (id: number | undefined, method: string, params: unknown) => input.write(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) + "\n");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const approve = vi.spyOn(approval, "approve");
  vi.clearAllMocks();
  const noWritesOrChildren = () => {
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.appendFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) expect(childProcess[method]).not.toHaveBeenCalled();
  };
  try {
    send(1, "initialize", { protocolVersion: 1 });
    await tick();
    send(2, "session/new", { cwd: f.cwd, mcpServers: [] });
    await tick();
    const sessionId = output.find(message => message.id === 2).result.sessionId;
    send(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: `/attach ${f.runId}` }] });
    await tick();
    await tick();
    const initialMessages = output.length;
    for (let n = 0; n < 3; n++) await vi.advanceTimersByTimeAsync(1000);
    expect(output).toHaveLength(initialMessages);
    expect(tree(stateDir)).toEqual(before);
    noWritesOrChildren();
    f.append(row("approval-window-expired", undefined, {}, later));
    const afterExpiry = tree(stateDir);
    vi.clearAllMocks();
    for (let n = 0; n < 3; n++) await vi.advanceTimersByTimeAsync(1000);
    expect(output.some(message => message.id === 3)).toBe(false);
    const updates = output.filter(message => message.method === "session/update").map(message => message.params.update);
    expect(messageText(updates).filter(text => text.includes("[needs you]"))).toHaveLength(1);
    expect(messageText(updates).filter(text => text.startsWith("Approval window closes"))).toHaveLength(1);
    expect(messageText(updates).filter(text => text.startsWith("Approval window lapsed"))).toHaveLength(1);
    const announcements = output.filter(message => message.params?.update?.sessionUpdate === "available_commands_update");
    expect(announcements).toHaveLength(1);
    expect(announcements[0].params.sessionId).toBe(sessionId);
    expect(announcements[0].params.update.availableCommands.map((command: any) => command.name)).toEqual(["attach", "status", "compile", "plan", "run", "resume"]);
    expect(output.indexOf(announcements[0])).toBeGreaterThan(output.findIndex(message => message.id === 2));
    expect(updates.every(update => ["available_commands_update", "plan", "tool_call", "tool_call_update", "agent_message_chunk"].includes(update.sessionUpdate))).toBe(true);
    expect(tree(stateDir)).toEqual(afterExpiry);
    noWritesOrChildren();
    expect(vi.mocked(fs.openSync).mock.calls.every(call => call[1] === (fs.constants.O_RDONLY | fs.constants.O_NONBLOCK))).toBe(true);
    send(undefined, "session/cancel", { sessionId });
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(output.find(message => message.id === 3)).toMatchObject({ result: { stopReason: "cancelled" } });
  } finally { input.end(); await peer.done; }
});

test("attaching to a closed run carries its open park block in the single final receipt", async () => {
  const f = fixture();
  f.append(row("task-human", "T1", { kind: "human-gate", reason: "needs a decision" }),
    row("run-end", undefined, { failed: [], human: ["T1"], blocked: [], pending: [] }));
  const result = await attach({ cwd: f.cwd, runId: f.runId, session: f.session, signal: new AbortController().signal,
    send: update => f.updates.push(update), sleep: async () => { throw new Error("closed run kept watching"); } });
  expect(result).toEqual({ stopReason: "end_turn" });
  const shown = messageText(f.updates);
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatch(/^NOT GREEN/u);
  expect(shown[0]).toContain("[needs you] human-gate — needs a decision");
  expect(shown[0]).toContain(statusSnapshot(f.cwd, f.runId).parks[0].commands[0].command);
});

test("test: a park released elsewhere, by an approval row and a new dispatch, moves its task's tool call off pending and alerts nothing new, while a park still open keeps its block, so a released park still shown as waiting fails", async () => {
  const f = fixture(["T1", "T2"]);
  f.own();
  f.append(row("task-human", "T1", { kind: "human-gate", reason: "release me" }), row("task-human", "T2", { kind: "human-gate", reason: "still waiting" }));
  const park = statusSnapshot(f.cwd, f.runId).parks.find(park => park.taskId === "T1")!;
  const line = Number(park.token!.split("@")[0]);
  await f.watch(n => {
    if (n === 2) f.append(row("task-approved", "T1", { park: { line, ts } }, later), row("task-dispatch", "T1", { attempt: 0 }, later));
    if (n >= 3) {
      expect(messageText(f.updates)).toHaveLength(2);
      const released = tools(f.updates).filter(tool => tool.toolCallId.endsWith("/T1")).at(-1);
      expect(released).toMatchObject({ sessionUpdate: "tool_call_update", status: "in_progress" });
      expect(toolText(released)).not.toContain("[needs you]");
      expect(toolText(released)).not.toContain("tickmarkr approve");
      const held = tools(f.updates).filter(tool => tool.toolCallId.endsWith("/T2")).at(-1);
      expect(held.status).toBe("pending");
      expect(toolText(held)).toContain("[needs you] human-gate — still waiting");
    }
  });
});
