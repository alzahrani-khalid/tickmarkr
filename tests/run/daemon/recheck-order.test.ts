// OBS-1158: plan and the daemon share one admission seam — a READY approved recheck ranks ahead of
// fresh work of equal or lower depth and behind deeper fresh work; ties elsewhere keep declaration
// order; consumed approvals and dependency-blocked rechecks gain nothing. Zero tokens: fake adapter.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { shq } from "../../../src/adapters/types.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { plan } from "../../../src/cli/commands/plan.js";
import { batteryPriority, dispatchWaves, loadGraph, readyTasks, saveGraph, setStatus } from "../../../src/graph/graph.js";
import { pendingDaemonApprovalActions, runDaemon } from "../../../src/run/daemon.js";
import { Journal, pendingApprovalActions, RECHECK_RELEASE, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

// Declaration order puts every fresh task BEFORE the recheck target T1 so priority, not position,
// must lift it: F0/F1 are depth-0 fresh (human-gated so the first run parks them unrun), D is a
// depth-1 fresh root over DC. T1's test gate reds until `flag` exists — the parked-then-rechecked shape.
const tasks = () => [
  T("F0", { humanGate: true }), T("F1", { humanGate: true }), T("D", { humanGate: true }),
  T("T1", { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] }), T("DC", { deps: ["D"] }),
];
const setup = () => {
  const flag = join(makeTestTempDir("tickmarkr-recheck-order-"), "green");
  const { repo, fake } = setupRepo(tasks(), {
    consult: { action: "human", notes: "operator decides" },
    tasks: Object.fromEntries(tasks().map((t) => [t.id, [{ shell: `echo ${t.id} >> ${t.id.toLowerCase()}.txt && ${COMMIT} ${t.id}`, result: { ok: true, summary: t.id } }]])),
  }, `concurrency: 1\ngates: { build: 'true', test: ${shq(`[ ! -f t1.txt ] || [ -f ${flag} ]`)}, lint: 'true' }\n`);
  return { repo, fake, flag };
};
const afterResume = (all: JournalEvent[]) => all.slice(all.map((e) => e.event).lastIndexOf("run-resume") + 1);
// admission order as the daemon journals it: a fresh task admits with task-dispatch, a recheck with its battery
const admissions = (evs: JournalEvent[]) => evs.filter((e) => e.event === "task-dispatch" || e.event === "recheck-battery").map((e) => e.taskId);
const planWaves = (out: string) => {
  const waves = new Map<string, number>();
  const lines = out.split("\n");
  lines.forEach((l, i) => {
    const m = /wave (\d+) at concurrency/.exec(l);
    const id = /^\s{2}(\S+)\s/.exec(lines.slice(0, i).reverse().find((p) => /^\s{2}\S+\s+\S+/.test(p)) ?? "")?.[1];
    if (m && id) waves.set(id, Number(m[1]));
  });
  return waves;
};
const byWave = (waves: Map<string, number>) => [...waves].sort((a, b) => a[1] - b[1]).map(([id]) => id);

describe("OBS-1158 — approved rechecks share one bounded priority across plan and daemon", () => {
  test("test: plan wave one equals the production daemon next admission for the depth matrix with a recheck before equal/lower-depth fresh work but after deeper fresh work, so either a divergent order or unconditional priority fails", async () => {
    const { repo, fake, flag } = setup();
    const runId = "run-obs1158-matrix";
    const first = await runDaemon(repo, { adapters: [fake], runId, concurrency: 1 });
    expect([...first.human].sort()).toEqual(["D", "F0", "F1", "T1"]);
    writeFileSync(flag, "green\n");
    for (const id of ["F0", "F1", "D"]) await approve([runId, id, "--by", "op"], repo);
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    // plan: the deeper fresh root leads; the ready recheck beats equal-depth fresh work declared before it
    const waves = planWaves(await plan([], repo, [fake]));
    expect(byWave(waves)).toEqual(["D", "T1", "F0", "F1", "DC"]);
    expect(waves.get("D")).toBe(1);
    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true, concurrency: 1 });
    expect([...resumed.done].sort()).toEqual(["D", "DC", "F0", "F1", "T1"]);
    const order = admissions(afterResume(Journal.open(repo, runId).read()));
    expect(order[0]).toBe([...waves].find(([, w]) => w === 1)![0]);
    expect(order).toEqual(["D", "T1", "F0", "F1", "DC"]);
  }, 300_000);

  test("test: plan plus the production daemon preserve stable declaration ties outside ready battery approvals across resume, so a consumed approval or dependency-blocked recheck gaining priority fails", async () => {
    const { repo, fake, flag } = setup();
    const runId = "run-obs1158-ties";
    await runDaemon(repo, { adapters: [fake], runId, concurrency: 1 });
    writeFileSync(flag, "green\n");
    // the recheck runs alone and is CONSUMED by its battery before any fresh work is released
    await approve([runId, "T1", "--recheck", "--by", "op"], repo);
    const alone = await runDaemon(repo, { adapters: [fake], runId, resume: true, concurrency: 1 });
    expect(alone.done).toEqual(["T1"]);
    for (const id of ["F0", "F1", "D"]) await approve([runId, id, "--by", "op"], repo);
    const journal = Journal.open(repo, runId);
    expect(batteryPriority(pendingApprovalActions(journal.read()).values())).toEqual(new Set());
    const waves = planWaves(await plan([], repo, [fake]));
    expect(byWave(waves)).toEqual(["D", "F0", "F1", "DC"]);
    const resumed = await runDaemon(repo, { adapters: [fake], runId, resume: true, concurrency: 1 });
    expect([...resumed.done].sort()).toEqual(["D", "DC", "F0", "F1", "T1"]);
    expect(admissions(afterResume(journal.read()))).toEqual(["D", "F0", "F1", "DC"]);
    // D parks again, so a recheck row on DC (dependency-blocked) is never ready and buys nothing.
    journal.append("task-human", "D", { kind: "gate-fail", reason: "parked again" });
    journal.append("task-approved", "DC", { by: "op", release: RECHECK_RELEASE });
    // F0 and F1 park and are released with PLAIN (worker-funding) approvals: pending, no battery rank.
    for (const id of ["F0", "F1"]) {
      journal.append("task-human", id, { kind: "gate-fail", reason: "parked again" });
      journal.append("task-approved", id, { by: "op" });
    }
    // T1's recheck approval was CONSUMED by a legacy worker-launch (no recheck-battery row) and the
    // run was interrupted before the task closed: T1 is eligible again with no superseding approval.
    journal.append("task-human", "T1", { kind: "gate-fail", reason: "parked again" });
    journal.append("task-approved", "T1", { by: "op", release: RECHECK_RELEASE });
    journal.append("worker-launch", "T1", { attempt: 1 });
    let g = loadGraph(repo);
    for (const t of g.tasks) g = setStatus(g, t.id, t.id === "D" ? "human" : "pending");
    saveGraph(repo, g);
    // the naive fold still carries T1's battery row; the shared consumption-aware seam drops it
    expect(batteryPriority(pendingApprovalActions(journal.read()).values())).toEqual(new Set(["DC", "T1"]));
    const priority = batteryPriority(pendingDaemonApprovalActions(journal.read()).values());
    expect(priority).toEqual(new Set(["DC"]));
    expect(readyTasks(g, priority).map((t) => t.id)).toEqual(["F0", "F1", "T1"]);
    expect(byWave(dispatchWaves(g, 1, priority))).toEqual(["F0", "F1", "T1"]);
    expect(byWave(planWaves(await plan([], repo, [fake])))).toEqual(["F0", "F1", "T1"]);
    // production resume with the blocked recheck present and the consumed approval on T1: declaration
    // order admits F0, F1, T1; DC never admits while D stays parked
    const again = await runDaemon(repo, { adapters: [fake], runId, resume: true, concurrency: 1 });
    expect([...again.done].sort()).toEqual(["F0", "F1", "T1"]);
    expect(again.human).toEqual(["D"]);
    expect(again.blocked).toEqual(["DC"]);
    expect(admissions(afterResume(journal.read()))).toEqual(["F0", "F1", "T1"]);
  }, 300_000);
});
