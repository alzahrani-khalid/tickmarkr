import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { wait, type WaitOpts } from "../../src/cli/commands/wait.js";
import { StatusSnapshotSchema, statusSnapshot } from "../../src/cli/commands/status-snapshot.js";
import { COMMANDS, dispatch, USAGE } from "../../src/cli/index.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import * as journal from "../../src/run/journal.js";
import { makeRepo, T } from "../helpers/tmprepo.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync), readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});

const ts = "2026-10-26T12:00:00.000Z";
const row = (event: string, taskId?: string, data: Record<string, unknown> = {}): journal.JournalEvent =>
  ({ ts, event, ...(taskId ? { taskId } : {}), data });
const start = (graph: RunGraph, pid: number | undefined = process.pid) =>
  row("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), ...(pid === undefined ? {} : { pid }) });
const end = () => row("run-end", undefined, { failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" });
const park = (taskId = "T1") => row("task-human", taskId, { kind: "human-gate", reason: "needs a decision" });
const encode = (rows: journal.JournalEvent[]) => rows.map(value => JSON.stringify(value)).join("\n") + "\n";
function fixture(tasks = [T("T1"), T("T2")]) {
  const cwd = makeRepo({ "base.txt": "base\n" });
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "wait-fixture" }, tasks });
  saveGraph(cwd, graph);
  const path = (id: string) => join(cwd, ".tickmarkr", "runs", id, "journal.jsonl");
  const seed = (id: string, rows: journal.JournalEvent[]) => {
    fs.mkdirSync(join(cwd, ".tickmarkr", "runs", id), { recursive: true });
    fs.writeFileSync(path(id), encode(rows));
  };
  return { cwd, graph, path, seed };
}
function clock(onSleep: (tick: number) => void | Promise<void> = () => {}, step = 1000) {
  let time = 0;
  let tick = 0;
  const sleep = vi.fn(async (ms: number) => {
    expect(ms).toBe(1000);
    time += step;
    await onSleep(++tick);
  });
  return { now: () => time, sleep } satisfies WaitOpts;
}
async function daemon() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  return child;
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
const racingPid = 2_147_483_000;
function diesDuringProbe(onDeath: () => void, atProbe = 1) {
  const signal = process.kill.bind(process);
  let probes = 0;
  return vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (pid !== racingPid || sig !== 0) return signal(pid, sig);
    if (++probes < atProbe) return true;
    // Schedule the daemon's final append after wait's stat/read, immediately before ESRCH.
    // Keep the real journal I/O and status liveness path; no large-journal timing race needed.
    if (probes === atProbe) onDeath();
    throw Object.assign(new Error("daemon exited"), { code: "ESRCH" });
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

test("wait run-deps --timeout 0s --json returns the entire status snapshot including a dependent task's blocker", async () => {
  const f = fixture([T("T1"), { ...T("T2"), deps: ["T1"] }]);
  const id = "run-deps";
  f.seed(id, [start(f.graph), row("task-dispatch", "T1", { attempt: 0 })]);
  const result = await wait([id, "--timeout", "0s", "--json"], f.cwd, clock());
  expect(result.code).toBe(6);
  const output = JSON.parse(result.out);
  const expected = statusSnapshot(f.cwd, id);
  expect(expected.tasks[1]!.now).toEqual({ phase: null, since: null, blocker: "dependency-wait", nextAction: "Wait for prerequisites: T1" });
  expect(output.snapshot).toEqual({ ...expected, observedAt: output.snapshot.observedAt });
});

test("wait accepts a note without data exactly as status does and preserves known outstanding debt", async () => {
  const f = fixture();
  const id = "run-note";
  f.seed(id, [start(f.graph), row("task-dispatch", "T1", { attempt: 0 })]);
  fs.appendFileSync(f.path(id), JSON.stringify({ ts, event: "note" }) + "\n");
  const result = await wait([id, "--timeout", "0s", "--json"], f.cwd, clock());
  expect(result.code).toBe(6);
  const output = JSON.parse(result.out);
  const expected = statusSnapshot(f.cwd, id);
  expect(expected.verdict.outstanding).toEqual({ known: true, debt: 0, checks: [] });
  expect(output.snapshot.verdict.outstanding).toEqual(expected.verdict.outstanding);
  expect(output.snapshot).toEqual({ ...expected, observedAt: output.snapshot.observedAt });
});

test("wait run-torn --timeout 5s reports a park whose partial row at call time completes on the next tick", async () => {
  const f = fixture();
  const id = "run-torn";
  f.seed(id, [start(f.graph)]);
  const pending = encode([park()]);
  fs.appendFileSync(f.path(id), pending.slice(0, 20));
  const time = clock(tick => { if (tick === 1) fs.appendFileSync(f.path(id), pending.slice(20)); });
  const result = await wait([id, "--timeout", "5s"], f.cwd, time);
  expect({ code: result.code, headline: result.out.split("\n")[0] }).toEqual({
    code: 3, headline: `tickmarkr wait ${id}: park at journal line 2`,
  });
  expect(time.sleep).toHaveBeenCalledOnce();
  expect(result.out).toContain(`tickmarkr approve ${id} T1 --park 2@${ts}`);
});

test("wait snapshots equal status across dependency, phase, gate, decision, engagement and permissive journal inputs", async () => {
  const f = fixture([T("T1"), { ...T("T2"), deps: ["T1"] }]);
  const id = "run-snapshot-class";
  const dispatchRow = row("task-dispatch", "T1", { attempt: 1, assignment: { adapter: "fake", model: "worker" } });
  const parkRow = row("task-human", "T1", { kind: "human-gate", reason: "decide" });
  const cases = [
    encode([start(f.graph)]),
    encode([start(f.graph), dispatchRow]),
    encode([start(f.graph), dispatchRow, row("phase-start", "T1", { phase: "worker", role: "worker", agent: "fake" })]),
    encode([start(f.graph), dispatchRow, row("worker-result", "T1", { ok: true, finished: true }),
      ...f.graph.tasks[0]!.gates.map(gate => row("gate-result", "T1", { gate, pass: true }))]),
    encode([start(f.graph), dispatchRow, parkRow, row("approval-window-start", undefined, { windowMs: 60_000, parked: ["T1"] })]),
    encode([start(f.graph), dispatchRow, parkRow, row("task-approved", "T1", { park: { line: 3, ts } })]),
    encode([start(f.graph), dispatchRow, parkRow, row("task-approved", "T1", { park: { line: 999, ts } })]),
    encode([start(f.graph), dispatchRow, end(), row("run-resume", undefined, { pid: process.pid })]),
    encode([row("run-start", undefined, { graphDefinitionHash: "previous", pid: process.pid }), dispatchRow]),
    encode([row("run-start", undefined, { graphDefinitionHash: "previous", pid: process.pid }), dispatchRow,
      row("graph-rehash", undefined, { from: "previous", to: graphDefinitionHash(f.graph) })]),
    encode([start(f.graph), dispatchRow]) + "\nnot-json\n" + JSON.stringify({ ts, event: "note" }) + "\n",
    encode([start(f.graph), dispatchRow]) + "\nnot-json\n" + encode([parkRow,
      row("task-approved", "T1", { park: { line: 5, ts } })]),
    encode([start(f.graph), dispatchRow]) + JSON.stringify({ ts, event: "note" }),
  ];
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.cwd);
  try {
    for (const [index, raw] of cases.entries()) {
      f.seed(id, []);
      fs.writeFileSync(f.path(id), raw);
      const result = await dispatch("wait", [id, "--timeout", "0s", "--json"]);
      expect(result.code, `snapshot case ${index}: ${result.out}`).toBe(6);
      const output = JSON.parse(result.out);
      const expected = statusSnapshot(f.cwd, id);
      expect(output.snapshot, `snapshot case ${index}`).toEqual({ ...expected, observedAt: output.snapshot.observedAt });
    }
  } finally { cwd.mockRestore(); }
});

test("wait preserves attention rows across bounded byte splits including UTF-8 and the final newline", async () => {
  const f = fixture();
  const id = "run-split-class";
  const history = [start(f.graph), park(), row("task-failed", "T1"), end(), row("run-resume", undefined, { pid: process.pid })];
  for (const [event, cause, code] of [
    [row("task-human", "T1", { kind: "human-gate", reason: "قرار 🟢" }), "park", 3],
    [row("task-failed", "T1", { reason: "قرار 🟢" }), "task-failed", 4],
    [end(), "run-end", 0],
  ] as const) {
    const pending = Buffer.from(encode([event]));
    const utf8 = pending.indexOf(Buffer.from("قرار"));
    const splits = new Set([1, 20, pending.length - 2, pending.length - 1, ...(utf8 < 0 ? [] : [utf8 + 1])]);
    for (const cut of splits) {
      f.seed(id, history);
      fs.appendFileSync(f.path(id), pending.subarray(0, cut));
      const time = clock(tick => { if (tick === 1) fs.appendFileSync(f.path(id), pending.subarray(cut)); });
      const result = await wait([id, "--timeout", "5s", "--json"], f.cwd, time);
      expect(result.code, `${cause} split ${cut}`).toBe(code);
      expect(JSON.parse(result.out)).toMatchObject({ cause, line: history.length + 1 });
      expect(time.sleep, `${cause} split ${cut}`).toHaveBeenCalledOnce();
      const output = JSON.parse(result.out);
      const expected = statusSnapshot(f.cwd, id);
      expect(output.snapshot).toEqual({ ...expected, observedAt: output.snapshot.observedAt });
    }
  }
});

test("wait prints the recorded park's clipboard and cursor controls visibly beside its release commands", async () => {
  const f = fixture();
  const id = "run-esc";
  const reason = "needs a decision\x1b]52;c;cm0gLXJmIH4=\x07\x1b[1A\x1b[2K";
  f.seed(id, [start(f.graph), row("task-human", "T1", { kind: "human-gate", reason })]);
  const result = await wait([id, "--after", "1"], f.cwd);
  expect(result.code).toBe(3);
  expect(result.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
  expect(result.out).toContain(`park T1: human-gate — ${journal.visibleControls(reason)}`);
  expect(result.out).toContain(`tickmarkr approve ${id} T1 --park 2@${ts}`);
});

test("wait renders every C0, DEL and C1 control visibly across journal-derived park fields and preserves raw JSON evidence", async () => {
  const f = fixture();
  const id = "run-controls";
  const controls = [...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)),
    ...Array.from({ length: 33 }, (_, index) => String.fromCharCode(127 + index))].join("");
  for (const kind of ["human-gate", `foreign${controls}`, "gate-fail", "scope-request"]) {
    const reason = `before${controls}after`;
    f.seed(id, [start(f.graph), row("task-human", "T1", { kind, reason })]);
    const result = await wait([id, "--after", "1"], f.cwd);
    expect(result.code).toBe(3);
    expect(result.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
    expect(result.out).toContain(journal.visibleControls(`park T1: ${kind} — ${reason}`));
    const state = statusSnapshot(f.cwd, id);
    for (const open of state.parks) {
      for (const command of open.commands) expect(result.out).toContain(journal.visibleControls(command.command));
      if (open.noDecision) expect(result.out).toContain(journal.visibleControls(open.noDecision));
    }
    const json = await wait([id, "--after", "1", "--json"], f.cwd);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.out).snapshot.parks[0]).toMatchObject({ kind, reason });
  }
});

// Reviewer reproducer: the tick's stat excludes the daemon's final row, then its PID reads dead.
test.each([
  { event: end(), cause: "run-end", code: 0 },
  { event: park(), cause: "park", code: 3 },
])("a $cause appended between the journal read and the death proof decides wait's cause, line and exit code", async ({ event, cause, code }) => {
  const f = fixture();
  const id = "run-race";
  f.seed(id, [start(f.graph, racingPid)]);
  const probe = diesDuringProbe(() => {
    expect(vi.mocked(fs.statSync).mock.calls.filter(args => args[0] === f.path(id))).toHaveLength(1);
    fs.appendFileSync(f.path(id), encode([event]));
  });
  const time = clock(() => { throw new Error("a final row must decide on this tick"); });
  const result = await wait([id, "--timeout", "0s"], f.cwd, time);
  expect({ code: result.code, headline: result.out.split("\n")[0] }).toEqual({ code, headline: `tickmarkr wait ${id}: ${cause} at journal line 2` });
  expect(time.sleep).not.toHaveBeenCalled();
  expect(probe).toHaveBeenCalledWith(racingPid, 0);
  if (cause === "park") expect(result.out).toContain(`tickmarkr approve ${id} T1 --park 2@${ts}`);
});

test("the post-death journal observation preserves physical row order across all qualifying permutations, baselines and deadline ticks", async () => {
  const f = fixture();
  const id = "run-race-orders";
  const entries = [[park(), "park", 3], [row("task-failed", "T1"), "task-failed", 4], [end(), "run-end", 0]] as const;
  const orders = entries.flatMap((a, i) => entries.flatMap((b, j) => i === j ? [] : [[a, b, entries.find((_, k) => k !== i && k !== j)!]]));
  const history = [start(f.graph, racingPid), park(), row("task-failed", "T1"), end(), row("run-resume", undefined, { pid: racingPid })];
  for (const order of orders) for (const atDeadline of [false, true]) for (const explicitAfter of [false, true]) {
    f.seed(id, history);
    const probe = diesDuringProbe(() => {
      fs.appendFileSync(f.path(id), "\nnot-json\n" + encode([row("phase-end", "T1", { phase: "worker" }), ...order.map(value => value[0])]));
    }, atDeadline ? 2 : 1);
    try {
      const time = clock();
      const result = await wait([id, ...(explicitAfter ? ["--after", String(history.length)] : []), "--json", "--timeout", atDeadline ? "1s" : "0s"], f.cwd, time);
      expect({ code: result.code, ...JSON.parse(result.out) }).toMatchObject({
        code: order[0]![2], cause: order[0]![1], line: 9, snapshot: { sequence: 11 },
      });
      expect(time.sleep).toHaveBeenCalledTimes(atDeadline ? 1 : 0);
      expect(StatusSnapshotSchema.safeParse(JSON.parse(result.out).snapshot).success).toBe(true);
    } finally { probe.mockRestore(); }
  }
});

test.each([
  { name: "run end", rows: [end()], cause: "run-end", code: 0 },
  { name: "live resume", rows: [end(), row("run-resume", undefined, { pid: process.pid })], cause: "timeout", code: 6 },
  { name: "routine phase", rows: [row("phase-end", "T1", { phase: "worker" })], cause: "daemon-death", code: 5 },
])("a $name observed after the death proof respects the newest lifecycle and last line even before an explicit future baseline", async ({ rows, cause, code }) => {
  const f = fixture();
  const id = "run-race-ended";
  f.seed(id, [start(f.graph, racingPid)]);
  diesDuringProbe(() => { fs.appendFileSync(f.path(id), encode(rows)); });
  const result = await wait([id, "--after", "100", "--timeout", "0s", "--json"], f.cwd, clock());
  expect({ code: result.code, ...JSON.parse(result.out) }).toMatchObject({ code, cause, line: rows.length + 1 });
});

// D-2163: status --watch --events replayed line one and never terminated at attention or run end.
test("wait exits once with the park code at the first park appended after it started, printing that park's release commands and the green-rule fields, while a park, a failure and a resumed run end at or before its baseline and a phase row after it move nothing, so a wait that replays history or wakes on routine rows fails", async () => {
  for (const explicitAfter of [false, true]) {
    const f = fixture();
    const id = "run-park";
    const history = [start(f.graph), park(), row("task-failed", "T1"), end(), row("run-resume", undefined, { pid: process.pid }), row("task-dispatch", "T1", { attempt: 0 })];
    f.seed(id, history);
    const time = clock(tick => {
      if (tick === 1) fs.appendFileSync(f.path(id), encode([row("phase-start", "T1", { phase: "worker" })]));
      else if (tick === 2) fs.appendFileSync(f.path(id), "\n" + encode([
        row("gate-result", "T1", { gate: "review", pass: false }),
        row("task-human", "T1", { kind: "gate-fail", reason: "review red" }),
        row("task-human", "T2", { kind: "infra", reason: "fix host" }),
      ]));
      else throw new Error("wait did not exit once at the first new park");
    });
    const result = await wait([id, ...(explicitAfter ? ["--after", String(history.length)] : []), "--timeout", "1m"], f.cwd, time);
    expect(result.code).toBe(3);
    expect(time.sleep).toHaveBeenCalledTimes(2);
    expect(result.out.split("\n")[0]).toBe(`tickmarkr wait ${id}: park at journal line 10`);
    expect(result.out.match(/tickmarkr wait /gu)).toHaveLength(1);
    const snapshot = statusSnapshot(f.cwd, id);
    expect(result.out).toContain(`green ${snapshot.verdict.green}; fatal ${snapshot.verdict.fatal}; current tip ${snapshot.verdict.currentTip}`);
    for (const name of ["failed", "human", "blocked", "pending", "outstanding"]) expect(result.out).toContain(`${name}:`);
    expect(snapshot.parks.map(value => value.taskId)).toEqual(["T1", "T2"]);
    expect(snapshot.parks[0]!.commands.map(value => value.verb)).toEqual(["waive", "uphold", "recheck"]);
    for (const open of snapshot.parks) for (const command of open.commands) expect(result.out).toContain(command.command);
    expect(result.out).toContain(`--park 10@${ts}`);
    expect(result.out).toContain(`tickmarkr approve ${id} T2 --recheck`);
  }
});

test("each cell of the closed exit table decides as ruled, a run ended before the call exiting zero at once, a failed task four, a daemon killed mid-run with no run end five, a silent live run at its timeout six, no live run unnamed seven and an unknown run one, so any cell decided otherwise fails", async () => {
  const f = fixture();
  const id = "run-table";
  const immediate = clock(() => { throw new Error("already ended run slept"); });
  // Its exit remains zero even when the recorded daemon has already gone away.
  const child = await daemon();
  try {
    f.seed(id, [start(f.graph, child.pid)]);
    const killed = clock(async () => { await kill(child); });
    const death = await wait([id, "--timeout", "1m"], f.cwd, killed);
    expect(death.code).toBe(5);
    expect(death.out).toContain("daemon-death at journal line 1");
    expect(killed.sleep).toHaveBeenCalledOnce();
    const atCall = await wait([id, "--timeout", "0s"], f.cwd, immediate);
    expect(atCall.code).toBe(5);
    f.seed(id, [start(f.graph, child.pid), end()]);
    expect((await wait([id], f.cwd, immediate)).code).toBe(0);
    expect(immediate.sleep).not.toHaveBeenCalled();
    f.seed(id, [start(f.graph, child.pid), end(), row("run-resume", undefined, { pid: child.pid })]);
    expect((await wait([id], f.cwd, immediate)).code).toBe(5);
    fs.writeFileSync(join(f.cwd, ".tickmarkr", "graph.lock"), JSON.stringify({ pid: child.pid, runId: id, startedAt: 0 }));
    expect((await wait([], f.cwd)).code).toBe(7);
  } finally { await kill(child); }
  for (const [event, cause, code] of [[row("task-failed", "T1"), "task-failed", 4], [end(), "run-end", 0]] as const) {
    f.seed(id, [start(f.graph)]);
    const result = await wait([id, "--timeout", "2s"], f.cwd, clock(() => { fs.appendFileSync(f.path(id), encode([event])); }));
    expect(result.code).toBe(code);
    expect(result.out).toContain(`${cause} at journal line 2`);
  }
  f.seed(id, [start(f.graph)]);
  for (const [duration, ms] of [["2s", 2000], ["1m", 60_000], ["1h", 3_600_000]] as const) {
    const time = clock(() => {}, ms);
    const timeout = await wait([id, "--timeout", duration], f.cwd, time);
    expect(timeout.code).toBe(6);
    expect(timeout.out).toContain("timeout at journal line 1");
    expect(time.sleep).toHaveBeenCalledOnce();
  }
  fs.rmSync(join(f.cwd, ".tickmarkr", "graph.lock"));
  expect((await wait([], f.cwd)).code).toBe(7);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.cwd);
  try {
    for (const args of [["run-unknown"], [id, "--wat"], [id, "--after", "-1"], [id, "--after", "1.5"], [id, "--after", ""],
      [id, "--timeout", "30"], [id, "--timeout", "-1s"], [id, "--timeout", "999999999999999999h"], [id, "run-extra"], ["../run-table"]]) {
      expect((await dispatch("wait", args)).code, args.join(" ")).toBe(1);
    }
    fs.rmSync(f.path(id));
    fs.mkdirSync(f.path(id));
    const unreadable = await dispatch("wait", [id]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.out).toContain("unreadable journal");
  } finally { cwd.mockRestore(); }
});

test("across a silent minute wait polls once a second, stats the journal each tick and parses only bytes appended since its last read, so a wait that rereads the whole journal or polls faster fails", async () => {
  const f = fixture();
  const id = "run-silent";
  const history = [start(f.graph), ...Array.from({ length: 1000 }, () => row("phase-end", "T1", { phase: "worker" }))];
  f.seed(id, history);
  const initialBytes = Buffer.byteLength(encode(history));
  const phase = row("phase-start", "T1", { phase: "gates" });
  const appended = encode([phase]);
  const parser = vi.spyOn(journal, "parseJournalText");
  vi.clearAllMocks();
  const statTicks: number[] = [];
  const time = clock(tick => {
    statTicks.push(vi.mocked(fs.statSync).mock.calls.filter(args => args[0] === f.path(id)).length);
    if (tick === 30) fs.appendFileSync(f.path(id), appended);
  });
  const result = await wait([id, "--timeout", "1m"], f.cwd, time);
  expect(result.code).toBe(6);
  expect(time.now()).toBe(60_000);
  expect(time.sleep.mock.calls).toEqual(Array.from({ length: 60 }, () => [1000]));
  expect(statTicks).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  expect(vi.mocked(fs.statSync).mock.calls.filter(args => args[0] === f.path(id))).toHaveLength(61);
  expect(parser.mock.calls.map(args => args[0])).toEqual([...history.map(value => JSON.stringify(value)), JSON.stringify(phase)]);
  expect(vi.mocked(fs.readFileSync).mock.calls.filter(args => args[0] === f.path(id))).toHaveLength(0);
  const opened = vi.mocked(fs.openSync).mock.calls.findIndex(args => args[0] === f.path(id));
  const fd = vi.mocked(fs.openSync).mock.results[opened]!.value;
  const reads = vi.mocked(fs.readSync).mock.calls.flatMap((args, i) => args[0] === fd ? [{ args, bytes: vi.mocked(fs.readSync).mock.results[i]!.value as number }] : []);
  let offset = 0;
  for (const { args, bytes } of reads) { expect(args[4]).toBe(offset); offset += bytes; }
  expect(offset).toBe(initialBytes + Buffer.byteLength(appended));
  expect(reads.at(-1)!.args[4]).toBe(initialBytes);
  expect(vi.mocked(fs.closeSync).mock.calls.filter(args => args[0] === fd)).toHaveLength(1);
});

test("wait with no run named attaches to the run holding the live graph lock, and with the json flag prints its cause, its journal line and a snapshot validating against the status schema, so a wait attached to another run or printing an unvalidated snapshot fails", async () => {
  const f = fixture();
  const id = "run-owner";
  f.seed(id, [start(f.graph)]);
  f.seed("run-zz-newer", [start(f.graph), end()]);
  const lock = join(f.cwd, ".tickmarkr", "graph.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: id, startedAt: Date.now() }));
  const beforeLock = fs.readFileSync(lock);
  const beforeGraph = fs.readFileSync(join(f.cwd, ".tickmarkr", "graph.json"));
  const validator = vi.spyOn(StatusSnapshotSchema, "parse");
  const result = await wait(["--json", "--timeout", "1s"], f.cwd, clock(() => {
    fs.appendFileSync(f.path(id), encode([park()]));
  }));
  expect(result.code).toBe(3);
  expect(result.out.split("\n")).toHaveLength(1);
  const output = JSON.parse(result.out);
  expect(Object.keys(output).sort()).toEqual(["cause", "line", "snapshot"]);
  expect(output.cause).toBe("park");
  expect(output.line).toBe(2);
  expect(output.snapshot.runId).toBe(id);
  expect(validator).toHaveBeenCalledOnce();
  expect(validator.mock.results[0]!.value).toEqual(output.snapshot);
  expect(StatusSnapshotSchema.safeParse(output.snapshot).success).toBe(true);
  const status = statusSnapshot(f.cwd, id);
  expect(output.snapshot).toEqual({ ...status, observedAt: output.snapshot.observedAt });
  expect(output.snapshot.parks[0].commands[0].command).toContain(`tickmarkr approve ${id} T1 --park 2@${ts}`);
  expect(fs.readFileSync(lock)).toEqual(beforeLock);
  expect(fs.readFileSync(join(f.cwd, ".tickmarkr", "graph.json"))).toEqual(beforeGraph);
});

test("through the production dispatcher the wait command's exit code equals the cause it printed for a park, a failed task and a run end, so a cause printed while exiting zero fails", async () => {
  const f = fixture();
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.cwd);
  try {
    expect(COMMANDS.wait).toBe(wait);
    expect(USAGE).toContain("wait [<run>]");
    for (const [event, cause, code] of [[park(), "park", 3], [row("task-failed", "T1"), "task-failed", 4], [end(), "run-end", 0]] as const) {
      f.seed("run-dispatch", [start(f.graph), event]);
      const result = await dispatch("wait", ["run-dispatch", "--after", "1"]);
      expect(result.out.split("\n")[0]).toBe(`tickmarkr wait run-dispatch: ${cause} at journal line 2`);
      expect(result.code).toBe(code);
      const json = await dispatch("wait", ["run-dispatch", "--after", "1", "--json"]);
      expect(json.code).toBe(code);
      expect(JSON.parse(json.out)).toMatchObject({ cause, line: 2 });
    }
  } finally { cwd.mockRestore(); }
});

test("for both orders of every pair of park, failure and run end appended in one read, wait prints the earlier row's cause and physical line, a row or a proven death present at the deadline tick beats the timeout, and a daemon dying after a park reports the park, so a wait ranking causes by kind fails", async () => {
  const f = fixture();
  const id = "run-precedence";
  const entries = [[park(), "park", 3], [row("task-failed", "T1"), "task-failed", 4], [end(), "run-end", 0]] as const;
  const orders = entries.flatMap((a, i) => entries.flatMap((b, j) => i === j ? [] : [[a, b], [a, b, entries.find((_, k) => k !== i && k !== j)!]]));
  for (const order of orders) {
    f.seed(id, [start(f.graph)]);
    const result = await wait([id, "--timeout", "1s"], f.cwd, clock(() => {
      fs.appendFileSync(f.path(id), "\nnot-json\n" + encode([row("phase-start", "T1", { phase: "worker" }), ...order.map(value => value[0])]));
    }));
    expect(result.code, order.map(value => value[1]).join(",")).toBe(order[0]![2]);
    expect(result.out.split("\n")[0]).toBe(`tickmarkr wait ${id}: ${order[0]![1]} at journal line 5`);
  }
  for (const appendPark of [false, true]) {
    const child = await daemon();
    try {
      f.seed(id, [start(f.graph, child.pid)]);
      const result = await wait([id, "--timeout", "1s"], f.cwd, clock(async () => {
        if (appendPark) fs.appendFileSync(f.path(id), encode([park()]));
        await kill(child);
      }));
      expect(result.code).toBe(appendPark ? 3 : 5);
      expect(result.out.split("\n")[0]).toBe(`tickmarkr wait ${id}: ${appendPark ? "park" : "daemon-death"} at journal line ${appendPark ? 2 : 1}`);
    } finally { await kill(child); }
  }
});
