import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { KIMI_TRUST_DIALOG } from "../../src/adapters/kimi.js";
import { allAdapters, getAdapter } from "../../src/adapters/registry.js";
import { KIMI_TRUST_PANE, type InteractiveSeed, type TrustDialog, type WorkerAdapter } from "../../src/adapters/types.js";
import { OrcaDriver, type OrcaExec } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { parseOwnedName, type ExecutorDriver } from "../../src/drivers/types.js";
import { resetWorkerStartupWindowMsForTests, runDaemon, setWorkerStartupWindowMsForTests } from "../../src/run/daemon.js";
import { Journal, pendingRepairFindings, type JournalEvent } from "../../src/run/journal.js";
import { WorkerTreeCpuAccountant } from "../../src/run/stall.js";
import { cursorModalExec, FakeOrca } from "../helpers/fake-orca.js";
import { authedModels, setupRepo, T } from "../helpers/tmprepo.js";

// OBS-1205 add.1: in v2.6.2 run …0149 the T23 modal was answered from OUTSIDE the run, so the seed
// deadline's failover off the pinned kimi channel was never exercised. This drives it through runDaemon
// and the PRODUCTION OrcaDriver: the pinned channel's launches paint the cursor-drawn modal on the
// rendered screen only.

const SEED: InteractiveSeed = {
  launch: (model: string) => `launch-tui --model ${model}`,
  readinessMatch: "TUI ready",
  seedLine: (promptFile: string) => `Read ${promptFile} and do exactly what it says.`,
};
const PIN = { via: "fake", model: "fake-1" };
const TIMEOUT_MINUTES = 0.03;
const DEADLINE_MS = TIMEOUT_MINUTES * 60_000;
const FINDINGS = "funded repair findings: tests/x.test.ts red";

async function runPinned(runId: string, answers: boolean) {
  const { repo, fake } = setupRepo(
    [T("T1", { routingHints: { pin: PIN } })],
    { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "operator must unblock" } },
    `visibility:\n  worker: interactive\ntaskTimeoutMinutes: ${TIMEOUT_MINUTES}\n`,
  );
  const seeded = fake as unknown as { interactiveSeed: InteractiveSeed; trustDialog: TrustDialog };
  seeded.interactiveSeed = SEED;
  seeded.trustDialog = KIMI_TRUST_DIALOG;
  const orca = new FakeOrca({ echoSends: false });
  // Only the PINNED channel's launch raises the modal; any other channel is ready at once.
  const modal = cursorModalExec(orca, { launch: SEED.launch(PIN.model), screen: KIMI_TRUST_PANE, ready: SEED.readinessMatch, answers });
  const exec: OrcaExec = async (args, cwd, timeoutMs) => {
    const r = await modal.exec(args, cwd, timeoutMs);
    const command = args[args.indexOf("--command") + 1] ?? "";
    if (args[1] === "create" && r.code === 0 && command.includes("launch-tui") && !command.includes(SEED.launch(PIN.model))) {
      const handle = (JSON.parse(r.stdout) as { result: { terminal: { handle: string } } }).result.terminal.handle;
      orca.of(handle)!.lines.push(SEED.readinessMatch);
    }
    return r;
  };
  const summary = await runDaemon(repo, { adapters: [fake as WorkerAdapter], runId, driver: new OrcaDriver({ pollMs: 20, exec }) });
  const events = Journal.open(repo, runId).read().filter((e) => e.taskId === "T1");
  const dispatched = new Map<number, string>(events.filter((e) => e.event === "task-dispatch")
    .map((e) => [Number(e.data.attempt), (e.data.assignment as { model: string }).model]));
  // A funded repair standing before the first dispatch: the production fold says whether a seed spent it.
  const funded = (rows: JournalEvent[]): JournalEvent[] => [
    { ts: rows[0]!.ts, event: "repair-attempt", taskId: "T1", data: { repair: 1, charge: 1, of: 2, gates: ["test"], commits: 1, findings: FINDINGS } },
    ...rows,
  ];
  return { summary, events, dispatched, funded, enters: modal.enters() };
}

test("the production daemon fails over off a pinned channel after a seed deadline without worker-launch or a repair debit for that seed, whereas rendered readiness launches that channel, so waiting beyond the configured deadline fails", async () => {
  const stuck = await runPinned("run-orca-seed-deadline", false);
  const first = stuck.events.find((e) => e.event === "task-dispatch")!;
  expect((first.data.assignment as { model: string }).model).toBe(PIN.model); // routed onto the pin

  // ANL-022 §3 T1 #11 (DW, T-F3): T = 120 s; retain the configured lower bound.
  // A failover one whole window late reaches 2 * DEADLINE_MS and must fail.
  const withinWindow = (waitedMs: number) => expect(waitedMs).toBeLessThan(2 * DEADLINE_MS);
  const deadlines = stuck.events.filter((e) => e.event === "delivery-readiness-failed");
  expect(deadlines.length).toBeGreaterThan(0);
  for (const d of deadlines) {
    expect(stuck.dispatched.get(Number(d.data.attempt))).toBe(PIN.model);
    expect(Number(d.data.waitedMs)).toBeGreaterThanOrEqual(DEADLINE_MS);
    withinWindow(Number(d.data.waitedMs));
    expect(() => withinWindow(Number(d.data.waitedMs) + DEADLINE_MS)).toThrow();
  }
  // …each spent its one Enter on its own fresh modal, and none of them counts as a launched worker.
  expect(stuck.enters).toBe(deadlines.length);
  const launches = stuck.events.filter((e) => e.event === "worker-launch");
  expect(launches.every((e) => stuck.dispatched.get(Number(e.data.attempt)) !== PIN.model)).toBe(true);

  // The ladder moved the task OFF the pin, and the new channel launched a worker.
  expect(stuck.events.some((e) => e.event === "escalation" && e.data.step === "escalate")).toBe(true);
  const failedOver = [...stuck.dispatched.entries()].filter(([, model]) => model !== PIN.model);
  expect(failedOver).toHaveLength(1);
  expect(launches.map((e) => Number(e.data.attempt))).toEqual([failedOver[0]![0]]);

  // No repair debit for the dead seeds: through every pinned deadline the funded findings are still owed,
  // and only the failed-over launch — the first worker that received a brief — spends them.
  const beforeLaunch = stuck.events.slice(0, stuck.events.indexOf(launches[0]!));
  expect(pendingRepairFindings(stuck.funded(beforeLaunch), "T1")).toBe(FINDINGS);
  expect(pendingRepairFindings(stuck.funded(stuck.events), "T1")).toBeUndefined();

  // Control: the same pin whose rendered modal takes the Enter reaches readiness and launches ON the pin.
  const ready = await runPinned("run-orca-seed-ready", true);
  expect(ready.enters).toBe(1);
  expect(ready.events.some((e) => e.event === "delivery-readiness-failed")).toBe(false);
  const pinnedLaunch = ready.events.filter((e) => e.event === "worker-launch");
  expect(pinnedLaunch).toHaveLength(1);
  expect(ready.dispatched.get(Number(pinnedLaunch[0]!.data.attempt))).toBe(PIN.model);
  expect(pendingRepairFindings(ready.funded(ready.events), "T1")).toBeUndefined();
}, 120_000);

// Queue row 215 (D-2118 add.1, D-2125): no CLI is executed; the production grok declaration and
// Orca driver observe a fake runtime whose rendered frame differs from its cursor stream.
async function runGrokTrust(surface: "orca" | "pane", modal: "present" | "absent" | "late", status = "unknown", slowScreen = false) {
  const startupMs = 10_000;
  const { repo, fake } = setupRepo(
    [T("T1", { routingHints: { pin: { via: "grok", model: "grok-4.5" } } })],
    { tasks: {}, consult: { action: "human", notes: "Queue row 215: fixture finished" } },
    "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.1\n",
  );
  const screen = readFileSync(new URL("../fixtures/grok-trust/grok-1.0.67.screen.txt", import.meta.url), "utf8");
  const noModal = "Grok Build is working on the requested change.";
  let elapsed = 0;
  const base = Date.now();
  let nonce = "";
  let polls = 0;
  let screenReads = 0;
  let paneReads = 0;
  let postLaunchScreenReads = 0;
  const statuses: string[] = [];
  const keys: Array<{ key: string; at: number; afterLaunch: boolean }> = [];
  const runId = `run-grok-${surface}-${modal}-${status}${slowScreen ? "-slow" : ""}`;
  const events = () => Journal.open(repo, runId).read().filter((e) => e.taskId === "T1");
  const launched = () => events().some((e) => e.event === "worker-launch");
  const completion = () => `TICKMARKR_EXIT_${nonce}:0`;
  const frame = () => modal === "absent" || (modal === "late" && elapsed <= startupMs) ? noModal : screen;
  const observeStatus = () => {
    polls++;
    if (modal === "late" && polls === 1) elapsed = startupMs + 1;
  };
  const worker: WorkerAdapter = {
    ...getAdapter("grok", allAdapters()),
    // D-2137 add.1: no shell probe of a real grok binary. probeAll would replace this fixture's probe with one, and a host
    // without grok (CI) would then read the pinned channel as unavailable and route the task elsewhere.
    hardcodedFlags: undefined,
    probe: async () => ({ installed: true, authed: true, version: "fixture", models: ["grok-4.5"], modelAuth: authedModels(["grok-4.5"]) }),
    channels: () => [{ adapter: "grok", vendor: "xai", model: "grok-4.5", channel: "sub", tier: "frontier" }],
    interactiveCommand: (promptFile) => {
      nonce = /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(promptFile, "utf8"))![1];
      return "grok-trust-fixture";
    },
  };
  const runtime = new FakeOrca({ pageSize: 500, echoSends: false, hookStatuses: [{ agent: "grok", state: "not_installed" }] });
  let workerHandle = "";
  const exec: OrcaExec = async (args, cwd, timeoutMs) => {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    if (arg("--terminal") === workerHandle && workerHandle) {
      const terminal = runtime.of(workerHandle)!;
      if (args[1] === "read" && args.includes("--screen")) {
        screenReads++;
        if (launched()) {
          postLaunchScreenReads++;
          if (modal === "late" && polls === 0) elapsed = startupMs + 1;
          // Queue row 215 (D-2118 add.1): status reads the frame first; the trust read can cross the deadline.
          if (slowScreen && postLaunchScreenReads === 2) elapsed = startupMs + 1;
        }
        terminal.screenLines = frame().split("\n");
      }
      if (args[1] === "show" && launched()) {
        observeStatus();
        terminal.agentWait = status === "blocked";
        terminal.lines.push(`Queue row 215: fixture poll ${polls}`);
        if (polls >= 3) terminal.lines.push(completion());
      }
      if (args[1] === "send" && args.includes("--enter") && arg("--text") === "") {
        keys.push({ key: "Enter", at: elapsed, afterLaunch: launched() });
      }
    }
    const result = await runtime.exec(args, cwd, timeoutMs);
    if (args[1] === "create" && result.code === 0 && parseOwnedName(arg("--title"))?.role === "worker") {
      workerHandle = JSON.parse(result.stdout).result.terminal.handle;
      const terminal = runtime.of(workerHandle)!;
      terminal.lines.push(noModal);
      terminal.screenLines = frame().split("\n");
      terminal.agentWait = status === "blocked";
    }
    return result;
  };
  const orca = new OrcaDriver({ exec, pollMs: 500, time: {
    now: () => Date.now(), sleep: async (ms) => { elapsed += ms; },
  } });
  const paneDriver: ExecutorDriver = {
    id: "grok-pane-fixture", interactive: true,
    slot: async (cwd, name) => ({ id: "pane-worker", cwd, name }),
    run: async () => {},
    waitOutput: async (_slot, _pattern, ms) => { elapsed += ms; return polls >= 3; },
    waitAgentStatus: async () => false,
    read: async () => {
      paneReads++;
      // Queue row 215 (D-2118 add.1): grow the transcript, as Orca does, so a flat CPU cannot stall it before completion.
      const transcript = Array.from({ length: polls + 1 }, (_, i) => `Queue row 215: fixture poll ${i}`).join("\n");
      return polls >= 3 ? completion() : `${frame()}\n${transcript}`;
    },
    status: async () => { observeStatus(); statuses.push(status); return status; },
    sendKey: async (_slot, key) => { keys.push({ key, at: elapsed, afterLaunch: launched() }); },
    close: async () => {}, notify: async () => {},
    worktree: (cwd, branch, path) => new SubprocessDriver().worktree(cwd, branch, path),
  };
  const statusSpy = vi.spyOn(orca, "status");
  // Queue row 215 (D-2118 add.1): the fake worker consumes no CPU; make watchdog observations independent of host ps.
  const cpuSpy = vi.spyOn(WorkerTreeCpuAccountant.prototype, "read").mockReturnValue({ cpu: { ms: 0, resolutionMs: 1 }, gaps: 0 });
  const clock = vi.spyOn(Date, "now").mockImplementation(() => base + elapsed);
  setWorkerStartupWindowMsForTests(startupMs);
  try {
    await runDaemon(repo, { adapters: [fake, worker], runId, approvalWindowMs: 0, driver: surface === "orca" ? orca : paneDriver });
    if (surface === "orca") {
      for (const result of statusSpy.mock.results) statuses.push(await result.value);
    }
    expect(events().filter((e) => e.event === "worker-launch")).toHaveLength(1);
    expect(events().find((e) => e.event === "worker-result")?.data.exitCode, `${surface} ${modal} ${status}`).toBe(0);
    return { events: events(), keys, statuses, screenReads, paneReads, polls, startupMs };
  } finally {
    clock.mockRestore();
    statusSpy.mockRestore();
    cpuSpy.mockRestore();
    resetWorkerStartupWindowMsForTests();
  }
}

test("test: under unknown worker status, the daemon on the production Orca driver over the fake runtime reading the rendered screen, and on a non-Orca driver offering only a pane read, journals one trust-auto-answer row and sends exactly one Enter for the production grok declaration within the window, so a fix limited to blocked or idle status, or to Orca, fails", async () => {
  for (const surface of ["orca", "pane"] as const) {
    const run = await runGrokTrust(surface, "present");
    expect(run.statuses.length, surface).toBeGreaterThanOrEqual(2);
    expect(new Set(run.statuses), surface).toEqual(new Set(["unknown"]));
    expect(run.keys, surface).toEqual([{ key: "Enter", at: expect.any(Number), afterLaunch: true }]);
    expect(run.keys[0]!.at, surface).toBeLessThan(run.startupMs);
    const answers = run.events.filter((e) => e.event === "trust-auto-answer");
    expect(answers, surface).toHaveLength(1);
    expect(answers[0]!.data, surface).toMatchObject({ adapter: "grok" });
    expect(run.events.indexOf(answers[0]!), surface).toBeGreaterThan(run.events.findIndex((e) => e.event === "worker-launch"));
    expect(answers[0]!.data.phase, surface).toBeUndefined();
    if (surface === "orca") expect(run.screenReads).toBeGreaterThan(0);
    else {
      expect(run.paneReads).toBeGreaterThan(0);
      expect(run.screenReads).toBe(0);
    }
  }
}, 60_000);

test("test: under unknown status a screen without the modal receives no key, a modal still showing after the Enter receives no second key, and a modal first painted after the startup window receives none, while a blocked pane showing it is answered as before, so an unbounded or repeating answer on unknown status fails", async () => {
  for (const surface of ["orca", "pane"] as const) {
    for (const modal of ["absent", "present", "late"] as const) {
      const run = await runGrokTrust(surface, modal);
      expect(run.polls, `${surface} ${modal}`).toBeGreaterThanOrEqual(2);
      expect(run.keys, `${surface} ${modal}`).toHaveLength(modal === "present" ? 1 : 0);
      expect(run.events.filter((e) => e.event === "trust-auto-answer"), `${surface} ${modal}`).toHaveLength(modal === "present" ? 1 : 0);
    }
    const blocked = await runGrokTrust(surface, "late", "blocked");
    expect(blocked.statuses).toContain("blocked");
    expect(blocked.keys).toEqual([{ key: "Enter", at: expect.any(Number), afterLaunch: true }]);
    expect(blocked.keys[0]!.at).toBeGreaterThan(blocked.startupMs);
    expect(blocked.events.filter((e) => e.event === "trust-auto-answer")).toHaveLength(1);
  }
  const slow = await runGrokTrust("orca", "present", "unknown", true);
  expect(slow.keys).toEqual([]);
  expect(slow.events.some((e) => e.event === "trust-auto-answer")).toBe(false);
}, 60_000);
