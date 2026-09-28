import { expect, test } from "vitest";
import { KIMI_TRUST_DIALOG } from "../../src/adapters/kimi.js";
import { KIMI_TRUST_PANE, type InteractiveSeed, type TrustDialog, type WorkerAdapter } from "../../src/adapters/types.js";
import { OrcaDriver, type OrcaExec } from "../../src/drivers/orca.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, pendingRepairFindings, type JournalEvent } from "../../src/run/journal.js";
import { cursorModalExec, FakeOrca } from "../helpers/fake-orca.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

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
// One trust-poll cycle (interactive-seed.ts TRUST_POLL_MS) plus the closing banner read.
const POLL_SLACK_MS = 1_500;
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

  // Every pinned launch waited out exactly its configured deadline — never longer — and ended there.
  const deadlines = stuck.events.filter((e) => e.event === "delivery-readiness-failed");
  expect(deadlines.length).toBeGreaterThan(0);
  for (const d of deadlines) {
    expect(stuck.dispatched.get(Number(d.data.attempt))).toBe(PIN.model);
    expect(Number(d.data.waitedMs)).toBeGreaterThanOrEqual(DEADLINE_MS);
    expect(Number(d.data.waitedMs)).toBeLessThan(DEADLINE_MS + POLL_SLACK_MS);
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
