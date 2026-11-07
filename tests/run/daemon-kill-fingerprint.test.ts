import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { resetAttemptHardTimeoutMsForTests, runDaemon, setAttemptHardTimeoutMsForTests } from "../../src/run/daemon.js";
import { GATE_FINGERPRINT_CAP, identicalGateFailures, Journal, normalizeGateFailure, type JournalEvent } from "../../src/run/journal.js";
import { processLivenessHost } from "../../src/run/process-liveness.js";
import { resetHarvestCpuFlatMsForTests, setHarvestCpuFlatMsForTests, workerReapHost, WorkerTreeCpuAccountant } from "../../src/run/stall.js";
import { reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Row 364; D-2185 add.19. All worker and gate rows below come from the production daemon writer.
// Only the execution surface, process probes and clock are scripted; git, parsing and dirty refusal stay real.
afterAll(() => reapTestTempDirs());
type Ending = "stall" | "hard" | "exit" | "interactive-finished" | "interactive-late-exit";
async function drive(endings: Ending[], dirty = true, resume = false) {
  const epoch = Date.now();
  let elapsed = 0;
  let current: Ending = endings[0]!;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => epoch + elapsed);
  const start = vi.spyOn(WorkerTreeCpuAccountant.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(WorkerTreeCpuAccountant.prototype, "stop").mockResolvedValue();
  const cpu = vi.spyOn(WorkerTreeCpuAccountant.prototype, "read").mockReturnValue({ cpu: { ms: 0, resolutionMs: 10 }, gaps: 0 });
  const connection = vi.spyOn(processLivenessHost, "connection").mockImplementation(async () => current === "hard" ? "connected" : "none");
  const census = vi.spyOn(workerReapHost, "snapshot").mockResolvedValue([]);
  setHarvestCpuFlatMsForTests(0);
  setAttemptHardTimeoutMsForTests(2000);
  const interactive = endings[0]!.startsWith("interactive");
  const { repo, fake } = setupRepo([T("T1", { files: ["work.txt"], timeoutMinutes: 1 / 60 })], {
    tasks: { T1: [{ shell: "true", result: { ok: true, summary: "fixture" } }] },
    consult: { action: "human", notes: "fingerprint control" },
  }, `visibility: { worker: ${interactive ? "interactive" : "print"}, llm: headless, keepPanes: forever }\n`
    + (dirty ? "" : 'gates: { build: "[ ! -f work.txt ] || { echo deterministic-build-red; exit 1; }", test: "true", lint: "true" }\n'));
  const inner = new SubprocessDriver();
  let launched = 0;
  let taskWorktree = "";
  let resuming = false;
  let replayDirtRestored = false;
  const seats = new Map<string, { nonce: string; began: number; ending: Ending; lateReads: number }>();
  const driver: ExecutorDriver = {
    id: "subprocess", interactive,
    slot: inner.slot.bind(inner), worktree: inner.worktree.bind(inner),
    project: async (_taskId, state) => {
      // Resume preserves any entry dirt before gating. Reproduce an interrupted edit at the gate boundary.
      if (resuming && !replayDirtRestored && state === "in-review") {
        writeFileSync(join(taskWorktree, "work.txt"), "interrupted edit\n");
        replayDirtRestored = true;
      }
    },
    status: async () => "working", waitAgentStatus: async () => false, notify: async () => {}, close: async () => {},
    run: async (slot, command) => {
      taskWorktree = slot.cwd;
      const script = readFileSync(/([^'\s]*\.sh)/.exec(command)![1]!, "utf8");
      const nonce = /TICKMARKR_RESULT_([0-9a-f]+)/.exec(script)![1]!;
      writeFileSync(/> '([^']+\.pgid)'/.exec(script)![1]!, "90000007\n");
      current = endings[launched] ?? "exit";
      launched++;
      writeFileSync(join(slot.cwd, "work.txt"), `committed ${launched}\n`);
      execFileSync("git", ["add", "work.txt"], { cwd: slot.cwd });
      execFileSync("git", ["commit", "--no-gpg-sign", "-m", `work ${launched}`], { cwd: slot.cwd });
      if (dirty && launched <= endings.length) writeFileSync(join(slot.cwd, "work.txt"), "interrupted edit\n");
      seats.set(slot.id, { nonce, began: elapsed, ending: current, lateReads: 0 });
    },
    waitOutput: async (slot, pattern, ms) => {
      const seat = seats.get(slot.id)!;
      // A finished TUI has a trailer but no exit marker: its exit drain must time out.
      const completion = `TICKMARKR_RESULT_${seat.nonce} {"ok":true,\n`
        + (seat.ending === "exit" ? `TICKMARKR_EXIT_${seat.nonce}:0\n` : "");
      const completes = (seat.ending === "exit" || seat.ending === "interactive-finished") && new RegExp(pattern).test(completion);
      elapsed += completes ? Math.min(ms, Math.max(0, seat.began + 200 - elapsed)) : ms;
      return completes && elapsed >= seat.began + 200;
    },
    read: async (slot) => {
      const seat = seats.get(slot.id)!;
      const age = elapsed - seat.began;
      const done = (seat.ending === "exit" || seat.ending === "interactive-finished") && age >= 200;
      // The first expired slice still sees no exit; only the final post-timeout read observes it.
      const lateExit = seat.ending === "interactive-late-exit" && age >= 1000 && ++seat.lateReads >= 2;
      return "tickmarkr worker launched\n"
        + (done ? `TICKMARKR_RESULT_${seat.nonce} {"ok":true,"summary":"done","deviations":[]}\n` : "")
        + (lateExit || (done && seat.ending === "exit") ? `TICKMARKR_EXIT_${seat.nonce}:0\n` : "");
    },
  };
  const originalAppend = Journal.prototype.append;
  let crashRecorded = false;
  const append = resume ? vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, ...args) {
    originalAppend.apply(this, args);
    if (!crashRecorded && args[0] === "gate-result" && args[2]?.gate === "build") {
      crashRecorded = true;
      throw new Error("simulated crash immediately after the production build row");
    }
  }) : undefined;
  try {
    const runId = "run-row364-fingerprint";
    await runDaemon(repo, { adapters: [fake], driver, runId, approvalWindowMs: 0 });
    const journal = Journal.open(repo, runId);
    const original = journal.read();
    append?.mockRestore();
    if (resume) {
      // Replay a crash just after the original dirty refusal, retaining its real checkout and launch evidence.
      const last = original.findIndex((row) => row.event === "gate-result" && row.data.gate === "build");
      expect(last).toBeGreaterThan(0);
      writeFileSync(join(journal.dir, "journal.jsonl"), original.slice(0, last + 1).map((row) => JSON.stringify(row)).join("\n") + "\n");
      resuming = true;
      await runDaemon(repo, { adapters: [fake], driver, runId, resume: true, approvalWindowMs: 0 });
    }
    const rows = journal.read();
    const workers = rows.filter((row) => row.event === "worker-result");
    const reds = rows.filter((row) => row.event === "gate-result" && row.data.gate === "build" && row.data.pass === false);
    expect(workers.length).toBeGreaterThanOrEqual(endings.length);
    expect(reds.length).toBeGreaterThanOrEqual(endings.length);
    return { rows, workers, reds };
  } finally {
    append?.mockRestore(); census.mockRestore(); connection.mockRestore(); cpu.mockRestore(); stop.mockRestore(); start.mockRestore(); clock.mockRestore();
    resetHarvestCpuFlatMsForTests(); resetAttemptHardTimeoutMsForTests();
  }
}
const count = (rows: JournalEvent[], red: JournalEvent) => identicalGateFailures(rows, "T1", "build", normalizeGateFailure(String(red.data.details)));
const through = (rows: JournalEvent[], row: JournalEvent) => rows.slice(0, rows.indexOf(row) + 1);

test("row 364 r7 cell a: production print stall and hard kills record daemonKilled and their dirty refusals count zero", async () => {
  const observations: JournalEvent[] = [];
  for (const ending of ["stall", "hard"] as const) {
    const { rows, workers, reds } = await drive([ending]);
    expect(workers[0]!.data).toMatchObject({ mode: "print", finished: false, exitCode: 1, cause: `${ending}-timeout` });
    expect(reds[0]!.data.dirtyWorktree).toBe(true);
    observations.push(...through(rows, reds[0]!));
    expect(count(observations, reds[0]!)).toBe(0);
    expect(workers[0]!.data.daemonKilled).toBe(true);
  }
});
test("row 364 r7 cell b: one production kill followed by a self-exited dirty refusal counts one without firing the cap", async () => {
  const { rows, workers, reds } = await drive(["stall", "exit"]);
  expect(workers[1]!.data).toMatchObject({ finished: true, exitCode: 0, mode: "print" });
  expect(workers[1]!.data).not.toHaveProperty("daemonKilled");
  expect(count(through(rows, reds[1]!), reds[1]!)).toBe(1);
  expect(rows.filter((row) => row.event === "gate-fingerprint-cap")).toEqual([]);
});
test("row 364 r7 cell c: two self-exited dirty refusals fire the production cap exactly at two chargeable observations even after kills", async () => {
  for (const endings of [["exit", "exit"], ["stall", "exit", "exit"]] satisfies Ending[][]) {
    const { rows, reds } = await drive(endings);
    const last = reds[endings.length - 1]!;
    expect(count(through(rows, last), last)).toBe(GATE_FINGERPRINT_CAP);
    const caps = rows.filter((row) => row.event === "gate-fingerprint-cap");
    expect(caps).toHaveLength(1);
    expect(caps[0]!.data).toMatchObject({ occurrences: 2, attempt: endings.length });
    expect(rows.indexOf(caps[0]!)).toBeGreaterThan(rows.indexOf(last));
  }
});
test("row 364 r7 cell d: a production non-dirty failure remains chargeable after a daemon kill", async () => {
  const { rows, reds } = await drive(["stall", "hard"], false);
  expect(reds[0]!.data.dirtyWorktree).not.toBe(true);
  expect(count(through(rows, reds[1]!), reds[1]!)).toBe(2);
  expect(rows.find((row) => row.event === "gate-fingerprint-cap")?.data.occurrences).toBe(2);
});
test("row 364 r7 cell e: a production finished interactive result with no cause and null exit stays chargeable", async () => {
  const { rows, workers, reds } = await drive(["interactive-finished"]);
  expect(workers[0]!.data).toMatchObject({ mode: "interactive", finished: true, exitCode: null });
  expect(workers[0]!.data).not.toHaveProperty("cause");
  expect(workers[0]!.data).not.toHaveProperty("daemonKilled");
  expect(count(through(rows, reds[0]!), reds[0]!)).toBe(1);
});
test("row 364 r7 cell f: the production resume replay after a recorded kill contributes no fingerprint observation", async () => {
  const { rows, workers, reds } = await drive(["stall"], true, true);
  expect(workers[0]!.data.daemonKilled).toBe(true);
  const replay = reds.find((row) => row.data.replayMeasurement === true);
  expect(replay).toBeDefined();
  expect(replay!.data.dirtyWorktree).toBe(true);
  const replayHistory = through(rows, replay!);
  expect(replayHistory.filter((row) => row.event === "worker-result")).toHaveLength(1);
  expect(count(replayHistory, reds[0]!)).toBe(0);
  expect(replayHistory.filter((row) => row.event === "gate-fingerprint-cap")).toEqual([]);
});
test("row 364 r7 cell g: an interactive timeout whose final production read observes a self-exit records no daemonKilled and stays chargeable", async () => {
  const { rows, workers, reds } = await drive(["interactive-late-exit"]);
  expect(workers[0]!.data).toMatchObject({ mode: "interactive", finished: false, exitCode: 0, cause: "stall-timeout" });
  expect(workers[0]!.data).not.toHaveProperty("daemonKilled");
  expect(rows.filter((row) => row.event === "worker-reaped-before-harvest")).toEqual([]);
  expect(rows.find((row) => row.event === "escalation")?.data.workerAttributed).toBe(true);
  expect(count(through(rows, reds[0]!), reds[0]!)).toBe(1);
});
test("row 364 r7 cell h: pre-upgrade kill rows without the recorded fact stay chargeable", async () => {
  const { rows, workers, reds } = await drive(["stall"]);
  // The old serialization is derived from the production row by deleting only the newly added field.
  const old = structuredClone(workers[0]!);
  delete old.data.daemonKilled;
  const { daemonKilled: _fact, ...oldData } = workers[0]!.data;
  expect(old).toEqual({ ...workers[0]!, data: oldData });
  expect(Object.keys(old.data).sort()).toEqual(Object.keys(workers[0]!.data).filter((key) => key !== "daemonKilled").sort());
  const history = through(rows, reds[0]!).map((row) => row === workers[0] ? old : row);
  expect(count(history, reds[0]!)).toBe(1);
});
