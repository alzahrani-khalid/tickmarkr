import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { resetAttemptHardTimeoutMsForTests, resetCapacityBackoffMsForTests, runDaemon, setAttemptHardTimeoutMsForTests, setCapacityBackoffMsForTests } from "../../src/run/daemon.js";
import { identicalGateFailures, Journal, normalizeGateFailure, type JournalEvent } from "../../src/run/journal.js";
import { processLivenessHost } from "../../src/run/process-liveness.js";
import { resetHarvestCpuFlatMsForTests, setHarvestCpuFlatMsForTests, workerReapHost, WorkerTreeCpuAccountant, type ReapProcess } from "../../src/run/stall.js";
import { makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Row 364; D-2184 add.31/add.44/add.45; D-2185 add.3. The closed case table runs production daemon/consult
// decisions over fake execution surfaces, an injected clock and process probes. Git and verdict parsing stay real.
afterAll(() => reapTestTempDirs());
type Reading = "connection" | "cpu" | "silent" | "unmeasurable";
function probes(reading: () => Reading, now: () => number) {
  const start = vi.spyOn(WorkerTreeCpuAccountant.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(WorkerTreeCpuAccountant.prototype, "stop").mockResolvedValue();
  const cpu = vi.spyOn(WorkerTreeCpuAccountant.prototype, "read").mockImplementation(() => ({
    cpu: reading() === "unmeasurable" ? undefined : { ms: reading() === "cpu" ? now() : 0, resolutionMs: 10 }, gaps: 0,
  }));
  const connection = vi.spyOn(processLivenessHost, "connection").mockImplementation(async () =>
    reading() === "connection" ? "connected" : reading() === "unmeasurable" ? "unreadable" : "none");
  setHarvestCpuFlatMsForTests(0);
  return () => { start.mockRestore(); stop.mockRestore(); cpu.mockRestore(); connection.mockRestore(); resetHarvestCpuFlatMsForTests(); };
}

async function workerCase(reading: Reading, options: {
  exitAt?: number; trailerAt?: number; dirty?: boolean; hardMs?: number; reap?: boolean;
  exitCode?: number; noTrailer?: boolean; summary?: string; malformed?: boolean; interactive?: boolean;
} = {}) {
  const epoch = Date.now();
  let elapsed = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => epoch + elapsed);
  const restore = probes(() => reading, () => elapsed);
  // Ordinary cells have no process claim. r8 models a still-live owned group through the production
  // reaper's host seam: close alone cannot erase it, only the reaper's identity-checked kill can.
  const processRows = new Map<number, ReapProcess>();
  const killed: number[] = [];
  const census = vi.spyOn(workerReapHost, "snapshot").mockImplementation(async () => [...processRows.values()]);
  let workerCwd = "";
  const reapMocks = options.reap ? [
    vi.spyOn(workerReapHost, "inspect").mockImplementation(async () => ({ cwd: workerCwd })),
    vi.spyOn(workerReapHost, "identity").mockImplementation(async (pid) => processRows.get(pid)?.identity),
    vi.spyOn(workerReapHost, "kill").mockImplementation((pid) => {
      killed.push(pid);
      for (const row of processRows.values()) if (pid === row.pid || -pid === row.group) processRows.delete(row.pid);
    }),
  ] : [];
  if (options.hardMs !== undefined) setAttemptHardTimeoutMsForTests(options.hardMs);
  setCapacityBackoffMsForTests(0);
  const { repo, fake } = setupRepo([T("T1", { files: ["work.txt"], timeoutMinutes: 1 / 60 })], {
    tasks: { T1: [{ shell: "true", result: { ok: true, summary: "fixture" } }] },
    consult: { action: "human", notes: "silent control" },
  }, `visibility: { worker: ${options.interactive ? "interactive" : "print"}, llm: headless }\n`);
  // These cells model a CLI without busy-frame markers; completion uses the nonce trailer alone.
  if (options.interactive) Object.assign(fake, { busyFrameMarkers: undefined });
  const inner = new SubprocessDriver();
  let launched = 0;
  let stoppedAt: number | undefined;
  const seats = new Map<string, { nonce: string; launchedAt: number; completesAt?: number; first: boolean }>();
  const waits: Array<{ ms: number; start: number; end: number; matched: boolean }> = [];
  const driver: ExecutorDriver = {
    id: "subprocess", interactive: options.interactive ?? false,
    slot: inner.slot.bind(inner), worktree: inner.worktree.bind(inner),
    status: async () => "working", waitAgentStatus: async () => false, notify: async () => {},
    close: async (slot) => { if (seats.has(slot.id)) stoppedAt ??= elapsed; },
    run: async (slot, command) => {
      const marker = /([^'\s]*\.sh)/.exec(command)![1]!;
      const script = readFileSync(marker, "utf8");
      const nonce = /TICKMARKR_RESULT_([0-9a-f]+)/.exec(script)![1]!;
      const groupFile = /> '([^']+\.pgid)'/.exec(script)![1]!;
      writeFileSync(groupFile, "90000007\n");
      launched++;
      workerCwd = realpathSync(slot.cwd);
      if (options.reap) {
        processRows.set(90000007, { pid: 90000007, ppid: 1, group: 90000007, session: "90000007",
          identity: "90000007:birth", command: `bash ${marker}` });
        processRows.set(90000008, { pid: 90000008, ppid: 90000007, group: 90000007, session: "90000007",
          identity: "90000008:birth", command: "provider-connection-held" });
      }
      if (!(options.noTrailer && launched === 1)) {
        writeFileSync(join(slot.cwd, "work.txt"), `committed ${launched}\n`);
        execFileSync("git", ["add", "work.txt"], { cwd: slot.cwd });
        execFileSync("git", ["commit", "--no-gpg-sign", "-m", `work ${launched}`], { cwd: slot.cwd });
      }
      if (options.dirty && launched === 1) writeFileSync(join(slot.cwd, "work.txt"), "interrupted edit\n");
      seats.set(slot.id, { nonce, launchedAt: elapsed, first: launched === 1,
        completesAt: launched > 1 ? elapsed + 10 : options.exitAt === undefined ? undefined : elapsed + options.exitAt });
    },
    waitOutput: async (slot, _pattern, ms) => {
      const seat = seats.get(slot.id)!;
      const start = elapsed;
      elapsed += Math.min(ms, Math.max(0, (seat.completesAt ?? Infinity) - elapsed));
      const matched = seat.completesAt !== undefined && elapsed >= seat.completesAt;
      waits.push({ ms, start, end: elapsed, matched });
      return matched;
    },
    read: async (slot) => {
      const seat = seats.get(slot.id)!;
      const done = seat.completesAt !== undefined && elapsed >= seat.completesAt;
      const trailer = !(seat.first && options.noTrailer) && (done || (options.trailerAt !== undefined && elapsed - seat.launchedAt >= options.trailerAt));
      const summary = seat.first ? options.summary ?? "done" : "done";
      const verdict = seat.first && options.malformed ? '{"ok":true,' : JSON.stringify({ ok: true, summary, deviations: [] });
      return `tickmarkr worker launched\n${seat.first ? `${summary}\n` : ""}${trailer ? `TICKMARKR_RESULT_${seat.nonce} ${verdict}\n` : ""}${done ? `TICKMARKR_EXIT_${seat.nonce}:${seat.first ? options.exitCode ?? 0 : 0}` : ""}`;
    },
  };
  try {
    const result = await runDaemon(repo, { adapters: [fake], driver, runId: "run-row364-worker", approvalWindowMs: 0 });
    const rows = Journal.open(repo, "run-row364-worker").read();
    const worker = rows.find((row) => row.event === "worker-result")!;
    return { result, rows, worker, repo, elapsed, stoppedAt, killed, waits, survivors: [...processRows.keys()] };
  } finally { for (const mock of reapMocks) mock.mockRestore(); census.mockRestore(); restore(); clock.mockRestore(); resetAttemptHardTimeoutMsForTests(); resetCapacityBackoffMsForTests(); }
}

async function silentControl() {
  const control = await workerCase("silent");
  expect(control.worker.data.cause).toBe("stall-timeout");
  expect(control.rows.filter((row) => row.event === "worker-stall-held")).toEqual([]);
  return control;
}

test("row 364: fingerprint history keeps pre-upgrade daemon kill rows chargeable without the recorded fact", async () => {
  const history: JournalEvent[] = [];
  for (const [reading, hardMs] of [["silent", undefined], ["connection", 4000]] as const) {
    const { rows, worker } = await workerCase(reading, { dirty: true, hardMs });
    const red = rows.find((row) => row.event === "gate-result" && row.data.gate === "build")!;
    // Row 364; D-2185 add.19: derive the old serialization from the production writer's row.
    const oldWorker = structuredClone(worker);
    delete oldWorker.data.daemonKilled;
    history.push(...rows.slice(0, rows.indexOf(red) + 1).map((row) => row === worker ? oldWorker : row));
    expect(identicalGateFailures(history, "T1", "build", normalizeGateFailure(String(red.data.details)))).toBe(history.filter((row) => row.event === "worker-result").length);
  }
});

test("row 364 cell 1: worker print holds silent output on an ESTABLISHED connection once per attempt and completes on the later trailer", async () => {
  const held = await workerCase("connection", { exitAt: 2500 });
  expect(held.result.done).toEqual(["T1"]);
  expect(held.worker.data.cause).toBeUndefined();
  expect(held.rows.filter((row) => row.event === "worker-stall-held").map((row) => row.data.leg)).toEqual(["connection"]);
  await silentControl();
});
test("row 364 cell 2: worker print holds silent output on accruing CPU with no connection", async () => {
  const held = await workerCase("cpu", { exitAt: 2500 });
  expect(held.result.done).toEqual(["T1"]);
  expect(held.rows.filter((row) => row.event === "worker-stall-held").map((row) => row.data.leg)).toEqual(["cpu"]);
  await silentControl();
});
test("row 364 cell 3: worker print with no connection and flat CPU is killed at the silence window as stall-timeout", async () => {
  const control = await silentControl();
  expect(control.stoppedAt).toBe(1000);
});
test("row 364 cell 4: worker print holds unreadable probes until the ceiling instead of killing on missing evidence", async () => {
  const held = await workerCase("unmeasurable", { exitAt: 2500 });
  expect(held.result.done).toEqual(["T1"]);
  expect(held.rows.filter((row) => row.event === "worker-stall-held").map((row) => row.data.leg)).toEqual(["unmeasurable"]);
  await silentControl();
});
test("row 364 cell 5: worker print kills every liveness reading at the absolute hard deadline as hard-timeout", async () => {
  for (const reading of ["connection", "cpu", "unmeasurable", "silent"] as const) {
    const hardMs = reading === "silent" ? 1000 : 4000;
    const cut = await workerCase(reading, { hardMs });
    expect(cut.worker.data.cause, reading).toBe("hard-timeout");
    expect(cut.stoppedAt, reading).toBe(hardMs);
  }
});

// Row 364; D-2185 add.20: a completion trailer ends the LIVE turn, even when the CLI keeps
// its connection/CPU alive beyond the deadline. Probe the real daemon, parser, gates and reaper.
test("row 364 r8: a printed trailer releases connection, CPU and unmeasurable holds before or at the hard deadline and reaps the live group before ordinary gates", async () => {
  for (const reading of ["connection", "cpu", "unmeasurable"] as const) {
    for (const trailerAt of [2500, 4000]) {
      const exitAt = 8000;
      const done = await workerCase(reading, { trailerAt, exitAt, hardMs: 4000, reap: true });
      expect(done.worker.data.finished, `${reading}:${trailerAt}`).toBe(true);
      expect(done.worker.data.cause).toBeUndefined();
      expect(done.worker.data.daemonKilled).toBeUndefined();
      expect(done.rows.filter(row => row.event === "worker-hard-timeout")).toEqual([]);
      expect(done.stoppedAt).toBe(trailerAt + 2000);
      expect(done.stoppedAt).toBeLessThan(exitAt);
      expect(done.rows.filter(row => row.event === "worker-stall-held").map(row => row.data.leg)).toEqual([reading]);
      expect(done.result.done).toEqual(["T1"]);
      expect(done.rows.filter(row => row.event === "task-dispatch")).toHaveLength(1);
      expect(done.rows.filter(row => row.event === "worker-result-harvested")).toEqual([]);
      const reap = done.rows.find(row => row.event === "worker-process-reaped")!;
      expect(reap.data.processGroup).toBe(90000007);
      expect(reap.data.survivors).toEqual([]);
      expect(done.killed).toContain(-90000007);
      expect(done.survivors).toEqual([]);
      const gates = done.rows.filter(row => row.event === "gate-result");
      expect(gates.length).toBeGreaterThan(0);
      expect(gates.every(row => row.data.pass === true)).toBe(true);
      expect(done.rows.indexOf(reap)).toBeLessThan(done.rows.indexOf(gates[0]!));
    }
  }
});

test("row 364 r8 control: a connection held without a trailer is killed and reaped exactly at the hard ceiling", async () => {
  const cut = await workerCase("connection", { exitAt: 8000, hardMs: 4000, reap: true });
  expect(cut.worker.data.finished).toBe(false);
  expect(cut.worker.data.cause).toBe("hard-timeout");
  expect(cut.worker.data.daemonKilled).toBe(true);
  expect(cut.stoppedAt).toBe(4000);
  expect(cut.rows.filter(row => row.event === "worker-hard-timeout")).toHaveLength(1);
  expect(cut.killed).toContain(-90000007);
  expect(cut.survivors).toEqual([]);
});

// Row 364; D-2185 add.23. The poll slice ends after the trailer, before the exit marker.
test("row 364 r8c exit cell: print and interactive workers exiting zero during the trailer drain retain their true exit and reach gates despite a quota phrase", async () => {
  for (const interactive of [false, true]) {
    const done = await workerCase("connection", { interactive, trailerAt: 500, exitAt: 750, summary: "handled rate limit" });
    expect(done.waits).toContainEqual({ ms: 2000, start: 500, end: 750, matched: true });
    expect(done.worker.data).toMatchObject({ finished: true, exitCode: 0, mode: interactive ? "interactive" : "print" });
    expect(done.rows.filter(row => row.event === "quota-failover")).toEqual([]);
    expect(done.rows.filter(row => row.event === "task-dispatch")).toHaveLength(1);
    const gates = done.rows.filter(row => row.event === "gate-result");
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every(row => row.data.pass === true)).toBe(true);
    expect(done.result.done).toEqual(["T1"]);
  }
});

test("row 364 r8c quota control: an unfinished print or interactive worker exiting nonzero with a quota phrase still fails over", async () => {
  for (const interactive of [false, true]) {
    const done = await workerCase("silent", { interactive, noTrailer: true, exitAt: 500, exitCode: 7, summary: "usage limit reached for this model" });
    expect(done.worker.data).toMatchObject({ finished: false, exitCode: 7, mode: interactive ? "interactive" : "print" });
    const failovers = done.rows.filter(row => row.event === "quota-failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]!.data).toMatchObject({ from: "fake:fake-1", to: "fake:fake-2" });
    expect(done.rows.filter(row => row.event === "task-dispatch")).toHaveLength(2);
    expect(done.rows.indexOf(failovers[0]!)).toBeLessThan(done.rows.findIndex(row => row.event === "gate-result"));
    expect(done.result.done).toEqual(["T1"]);
  }
});

test("row 364 r8c quota guard: a trailer-finished print or interactive worker lingering past the exit grace reaches gates without quota failover", async () => {
  for (const interactive of [false, true]) {
    const done = await workerCase("connection", { interactive, trailerAt: 500, exitAt: 8000, summary: "handled rate limit" });
    expect(done.waits).toContainEqual({ ms: 2000, start: 500, end: 2500, matched: false });
    expect(done.worker.data).toMatchObject({ finished: true, exitCode: interactive ? null : 1 });
    expect(done.worker.data.daemonKilled).toBeUndefined();
    expect(done.rows.filter(row => row.event === "quota-failover" || row.event === "capacity-failover" || row.event === "capacity-requeue")).toEqual([]);
    expect(done.rows.filter(row => row.event === "task-dispatch")).toHaveLength(1);
    const gates = done.rows.filter(row => row.event === "gate-result");
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every(row => row.data.pass === true)).toBe(true);
    expect(done.result.done).toEqual(["T1"]);
  }
});

test("row 364 r8c capacity guard: a trailer-finished print worker lingering past the exit grace reaches gates without capacity rerouting even when its trailer is truncated", async () => {
  // A complete parsed verdict already defeats the capacity classifier. Its truncated prefix still
  // ends the print turn, so the routing guard must keep that attempt on the ordinary gate path too.
  for (const malformed of [false, true]) {
    const done = await workerCase("connection", { trailerAt: 500, exitAt: 8000, summary: "model is at capacity", malformed });
    expect(done.waits).toContainEqual({ ms: 2000, start: 500, end: 2500, matched: false });
    expect(done.worker.data).toMatchObject({ finished: true, exitCode: 1 });
    expect(done.worker.data.daemonKilled).toBeUndefined();
    if (malformed) expect(done.worker.data.cause).toBe("malformed-trailer");
    expect(done.rows.filter(row => row.event === "capacity-failover" || row.event === "capacity-requeue" || row.event === "quota-failover")).toEqual([]);
    expect(done.rows.filter(row => row.event === "task-dispatch")).toHaveLength(1);
    const gates = done.rows.filter(row => row.event === "gate-result");
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every(row => row.data.pass === true)).toBe(true);
    expect(done.result.done).toEqual(["T1"]);
  }
});

// Row 364; SPEND-01; D-2185 add.21/add.22. Run an actual local print process. Its post-trailer
// store writer is released only by the bounded exit drain, so an immediate reap deterministically
// loses the record; normal usage still uses FakeAdapter's unchanged writer and collector.
async function meteredPrintCase(lateUsage: boolean) {
  const usage = { input: 701, output: 109, cacheRead: 7, cacheWrite: 3 };
  const dir = makeTestTempDir("row364-post-trailer-");
  const release = join(dir, "release");
  const tail = join(dir, "tail.cjs");
  writeFileSync(tail, `const fs = require("node:fs");
const started = Date.now();
const timer = setInterval(() => {
  if (!fs.existsSync(process.argv[2])) {
    if (Date.now() - started > 10000) process.exit(42);
    return;
  }
  clearInterval(timer);
  fs.writeFileSync(".tickmarkr-usage.json", JSON.stringify({ timestamp: new Date().toISOString(), usage: ${JSON.stringify(usage)} }));
  process.exit(0);
}, 5);
`);
  const { repo, fake } = setupRepo([T("T1", { files: ["work.txt"], timeoutMinutes: 1 / 60 })], {
    tasks: { T1: [{ shell: "echo metered > work.txt && git add work.txt && git -c user.name=fake -c user.email=fake@example.test commit --no-gpg-sign -m metered",
      result: { ok: true, summary: "done" }, ...(lateUsage ? {} : { usage }) }] },
  }, "visibility: { worker: print, llm: headless }\n");
  if (lateUsage) {
    const invoke = fake.invoke.bind(fake);
    fake.invoke = (...args) => {
      const invocation = invoke(...args);
      return { ...invocation, command: `${invocation.command}; ${shq(process.execPath)} ${shq(tail)} ${shq(release)}` };
    };
  }
  const inner = new SubprocessDriver();
  let sawTrailer = false;
  let drainCalls = 0;
  const driver: ExecutorDriver = {
    id: "subprocess", interactive: false,
    slot: inner.slot.bind(inner), run: inner.run.bind(inner), worktree: inner.worktree.bind(inner),
    status: inner.status.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    close: inner.close.bind(inner), notify: async () => {},
    read: async (slot, lines) => {
      const output = await inner.read(slot, lines ?? 500);
      if (/TICKMARKR_RESULT_[0-9a-f]+ \{/.test(output)) sawTrailer = true;
      return output;
    },
    waitOutput: async (slot, pattern, ms, opts) => {
      if (lateUsage && sawTrailer && ms === 2_000) {
        drainCalls++;
        writeFileSync(release, "flush");
      }
      return inner.waitOutput(slot, pattern, ms, opts);
    },
  };
  const result = await runDaemon(repo, { adapters: [fake], driver, runId: "run-row364-post-trailer", approvalWindowMs: 0 });
  const journal = Journal.open(repo, "run-row364-post-trailer");
  return { result, usage, rows: journal.read(), telemetry: journal.readTelemetry(), drainCalls };
}

test("row 364 r8b cell a: a print worker that flushes usage after its trailer within the exit grace finishes metered", async () => {
  const done = await meteredPrintCase(true);
  expect(done.result.done).toEqual(["T1"]);
  expect(done.rows.find(row => row.event === "worker-result")?.data.finished).toBe(true);
  expect(done.telemetry[0]?.tokens).toEqual(done.usage);
  expect(done.telemetry[0]?.meteredAttempts).toBe(1);
  expect(done.drainCalls).toBe(1);
  expect(done.rows.filter(row => row.event === "worker-hard-timeout")).toEqual([]);
  expect(done.rows.find(row => row.event === "worker-process-reaped")?.data.survivors).toEqual([]);
}, 60_000);

test("row 364 r8b cell c: a normal print worker retains its finished result and disk usage", async () => {
  const done = await meteredPrintCase(false);
  expect(done.result.done).toEqual(["T1"]);
  expect(done.rows.find(row => row.event === "worker-result")?.data.finished).toBe(true);
  expect(done.telemetry[0]?.tokens).toEqual(done.usage);
  expect(done.telemetry[0]?.meteredAttempts).toBe(1);
  expect(done.drainCalls).toBe(0);
  expect(done.rows.filter(row => row.event === "worker-hard-timeout")).toEqual([]);
}, 60_000);

const dossier: Dossier = { taskId: "T1", trigger: "stall", journalTail: "", transcript: "quiet worker", diff: "", gates: [] };
async function consultCase(visibility: "pane" | "headless", reading: Reading, answers: boolean) {
  const dir = makeTestTempDir("row364-consult-");
  const script = join(dir, "fake.json");
  writeFileSync(script, '{"tasks":{}}');
  let elapsed = 0;
  let current = "";
  let firstStartedAt = 0;
  let firstStoppedAt: number | undefined;
  const built: string[] = [];
  const outputs = new Map<string, string>();
  const releases = join(dir, "release");
  const started = join(dir, "started");
  const completed = join(dir, "completed");
  class Seat extends FakeAdapter {
    constructor(id: string) { super(script); this.id = id; this.vendor = id; }
    override headlessCommand(file: string): string {
      current = this.id;
      built.push(current);
      const nonce = extractPromptNonce(readFileSync(file, "utf8"))!;
      const response = JSON.stringify({ nonce, action: "retry", notes: this.id });
      outputs.set(this.id, `${response}\nTICKMARKR_EXIT_${nonce}:0`);
      if (this.id === "first") firstStartedAt = elapsed;
      else firstStoppedAt ??= elapsed;
      return `: ROW364_SEAT=${this.id}; ` + (visibility === "headless" && this.id === "first"
        ? `printf 'working'; touch ${shq(started)}; while [ ! -f ${shq(releases)} ]; do sleep 0.01; done; printf '%s' ${shq(response)}; touch ${shq(completed)}`
        : `printf '%s' ${shq(response)}`);
    }
  }
  const restore = probes(() => current === "first" ? reading : "silent", () => elapsed);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.visibility.llm = visibility;
  cfg.consult = { adapter: "fallback", model: "fallback-model", stallMinutes: 1 / 60, prefer: ["first:first-model"] };
  const slots = new Map<string, { seat: string; began: number }>();
  const driver: ExecutorDriver = {
    id: "fake-consult", interactive: false,
    slot: async (cwd, name) => ({ id: String(slots.size), cwd, name }),
    run: async (slot, command) => {
      const scriptText = readFileSync(/([^'\s]*\.sh)/.exec(command)![1]!, "utf8");
      const seat = /ROW364_SEAT=(\w+)/.exec(scriptText)![1]!;
      writeFileSync(/> '([^']+\.pgid)'/.exec(scriptText)![1]!, "90000008\n");
      slots.set(slot.id, { seat, began: elapsed });
    },
    read: async (slot) => {
      const s = slots.get(slot.id)!;
      return s.seat !== "first" || (answers && elapsed - s.began >= 2500) ? outputs.get(s.seat)! : "working\n";
    },
    waitOutput: async (slot, _pattern, ms) => {
      const s = slots.get(slot.id)!;
      const due = s.seat === "first" ? answers ? s.began + 2500 : Infinity : s.began + 10;
      elapsed += Math.min(ms, Math.max(0, due - elapsed));
      return elapsed >= due;
    },
    status: async () => "working", waitAgentStatus: async () => false,
    notify: async () => {}, close: async () => {}, worktree: async () => dir,
  };
  const time = { now: () => elapsed, sleep: async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    if (current !== "first") { await new Promise((resolve) => setTimeout(resolve, 20)); return; }
    // Let the real local fake shell start before advancing its injected clock. No model process is launched.
    for (let n = 0; n < 200 && !existsSync(started); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(existsSync(started)).toBe(true);
    elapsed += answers ? Math.min(ms, Math.max(0, firstStartedAt + 2500 - elapsed)) : ms;
    if (answers && elapsed - firstStartedAt >= 2500) {
      writeFileSync(releases, "go");
      for (let n = 0; n < 200 && !existsSync(completed); n++) await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } };
  try {
    const verdict = await consult(dossier, cfg, [new Seat("first"), new Seat("fallback")], driver, dir, dir, {
      time, channels: [{ adapter: "first", model: "first-model", vendor: "first" }],
    });
    return { verdict, built, firstDuration: (firstStoppedAt ?? elapsed) - firstStartedAt };
  } finally { restore(); }
}

test("row 364 cell 6: a live pane consult answers after the silence window before four windows without fallback", async () => {
  const live = await consultCase("pane", "connection", true);
  expect(live.verdict.notes).toBe("first");
  expect(live.built).toEqual(["first"]);
  expect(live.firstDuration).toBe(2500);
  expect((await consultCase("pane", "silent", true)).verdict.notes).toBe("fallback");
});
test("row 364 cell 7: a silent pane consult falls back at the configured silence window", async () => {
  const silent = await consultCase("pane", "silent", false);
  expect(silent.verdict.notes).toBe("fallback");
  expect(silent.firstDuration).toBe(1000);
});
test("row 364 cell 8: a live headless consult answers after the silence window before four windows", async () => {
  const live = await consultCase("headless", "connection", true);
  expect(live.verdict.notes).toBe("first");
  expect(live.built).toEqual(["first"]);
  expect(live.firstDuration).toBe(2500);
  expect((await consultCase("headless", "silent", false)).verdict.notes).toBe("fallback");
});
test("row 364 cell 9: live pane and headless consults are cut at four silence windows and fall back", async () => {
  for (const visibility of ["pane", "headless"] as const) {
    const cut = await consultCase(visibility, "connection", false);
    expect(cut.verdict.notes, visibility).toBe("fallback");
    expect(cut.built, visibility).toEqual(["first", "fallback"]);
    expect(cut.firstDuration, visibility).toBe(4000);
  }
});
test("row 364 cell 10: dirty-tree build refusals after daemon stall and hard kills escalate without worker attribution", async () => {
  for (const [reading, hardMs, cause] of [["silent", undefined, "stall-timeout"], ["connection", 4000, "hard-timeout"]] as const) {
    const cut = await workerCase(reading, { dirty: true, hardMs });
    expect(cut.worker.data.cause).toBe(cause);
    expect(cut.rows.find((row) => row.event === "gate-result" && row.data.gate === "build")?.data.dirtyWorktree).toBe(true);
    expect(cut.rows.find((row) => row.event === "escalation")?.data.workerAttributed).toBe(false);
    expect(cut.rows.some((row) => row.event === "worktree-preserved" && typeof row.data.ref === "string")).toBe(true);
  }
});
test("row 364 cell 11: a self-exited worker leaving a dirty tree retains worker-attributed escalation", async () => {
  const exited = await workerCase("silent", { dirty: true, exitAt: 200 });
  expect(exited.worker.data.finished).toBe(true);
  expect(exited.worker.data.cause).toBeUndefined();
  expect(exited.rows.find((row) => row.event === "gate-result" && row.data.gate === "build")?.data.dirtyWorktree).toBe(true);
  expect(exited.rows.find((row) => row.event === "escalation")?.data.workerAttributed).toBe(true);
});
