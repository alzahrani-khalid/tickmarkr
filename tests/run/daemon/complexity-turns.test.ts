// Rows 501, 502 (D-2187 add.367, add.369): the daemon routes each task with the run's whole graph, so on a
// line by complexity its first dispatch names the model `tickmarkr plan` named (contract 1.5 (vii) U5), with
// and without an exclusion in the run; and a task that already has a model keeps it (cell Y7, first half).
// Zero tokens: fake adapter, subprocess driver, scripted workers.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FakeAdapter } from "../../../src/adapters/fake.js";
import { channelKey, type BillingChannel } from "../../../src/adapters/types.js";
import { plan, type PlanTaskRow } from "../../../src/cli/commands/plan.js";
import type { VitestListResult } from "../../../src/gates/acceptance.js";
import { captureBaseline } from "../../../src/gates/baseline.js";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const MODELS = ["fake-1", "fake-2", "fake-3"];
// One frontier group with no scores (rule 4): three models that take turns at every complexity.
const threeModels = (fake: FakeAdapter): FakeAdapter => {
  fake.probe = async () => ({ installed: true, authed: true, version: "fake", models: MODELS, modelAuth: authedModels(MODELS) });
  fake.channels = (): BillingChannel[] => MODELS.map((model) => ({ adapter: "fake", model, vendor: "fake-a", channel: "sub", tier: "frontier" }));
  return fake;
};
const POOL = "review: { required: false }\nrouting:\n  map:\n    implement:\n      pool:\n        mode: complexity\n        channels: [fake:fake-1, fake:fake-2, fake:fake-3]\n";
const GATES = ["build", "test", "lint", "evidence", "scope"];
const finish = (f: string) => ({ shell: `echo ${f} > ${f}.txt && ${COMMIT} ${f}`, result: { ok: true, summary: f } });

// U2's graph: T1 c3, T2 c5, T3 c7, goals a, b, c — chained, so each later task routes after its earlier peer is
// done, and a rank read from the pending tasks alone (U5's bait) would hand T2 and T3 the first model.
const made3 = () => {
  const made = setupRepo([
    T("T1", { goal: "a", complexity: 3, files: ["t1.txt"], gates: GATES }),
    T("T2", { goal: "b", complexity: 5, deps: ["T1"], files: ["t2.txt"], gates: GATES }),
    T("T3", { goal: "c", complexity: 7, deps: ["T2"], files: ["t3.txt"], gates: GATES }),
  ], { tasks: { T1: [finish("t1")], T2: [finish("t2")], T3: [finish("t3")] } }, POOL);
  return { ...made, fake: threeModels(made.fake) };
};

const noTests = async (): Promise<VitestListResult> => ({ status: "listed", tests: [] });
const planned = async (repo: string, fake: FakeAdapter): Promise<Record<string, string>> => {
  const rows: PlanTaskRow[] = [];
  await plan([], repo, [fake], undefined, { listTests: noTests, onTask: (r) => rows.push(r) });
  return Object.fromEntries(rows.map((r) => [r.id, r.worker ? channelKey(r.worker) : "none"]));
};
const firstDispatch = (rows: JournalEvent[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of rows) if (e.event === "task-dispatch" && e.taskId && !(e.taskId in out)) out[e.taskId] = channelKey(e.data.assignment as never);
  return out;
};
const dispatches = (rows: JournalEvent[], id: string) => rows.filter((e) => e.event === "task-dispatch" && e.taskId === id).map((e) => channelKey(e.data.assignment as never));

/** A run that started and recorded `rows` before any task ran its gates; resumed by the caller. */
const seeded = async (repo: string, runId: string, rows: [string, string | undefined, Record<string, unknown>][]) => {
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), branch: `tickmarkr/${runId}`, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  for (const [event, taskId, data] of rows) journal.append(event as never, taskId, data);
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(await captureBaseline(repo, {})));
  return journal;
};

describe("rows 501, 502: the daemon's first dispatch names the model plan named", { timeout: 300_000 }, () => {
  test("a run first dispatches each task to the model plan named for it; so it does when one model is excluded in the run", async () => {
    // No exclusion: plan names one task for each model, and the run dispatches each where plan named it.
    const fresh = made3();
    const named = await planned(fresh.repo, fresh.fake);
    expect(named).toEqual({ T1: "fake:fake-1", T2: "fake:fake-2", T3: "fake:fake-3" });
    const runId = "run-cx-turns-fresh";
    const summary = await runDaemon(fresh.repo, { adapters: [fresh.fake], runId });
    expect(summary.done.sort()).toEqual(["T1", "T2", "T3"]);
    expect(firstDispatch(Journal.open(fresh.repo, runId).read())).toEqual(named);

    // fake:fake-2 excluded in the run (U7): plan reads the run's replayed exclusion, and the resumed run's first
    // dispatches match it — O, O, S: the third task keeps its turn, the excluded model's task goes to the first.
    const ex = made3();
    const exRun = "run-cx-turns-excluded";
    const journal = await seeded(ex.repo, exRun, [["channel-exclusion", undefined, { channel: "fake:fake-2", reason: "fixture" }]]);
    const exNamed = await planned(ex.repo, ex.fake);
    expect(exNamed).toEqual({ T1: "fake:fake-1", T2: "fake:fake-1", T3: "fake:fake-3" });
    const exSummary = await runDaemon(ex.repo, { adapters: [ex.fake], runId: exRun, resume: true });
    expect(exSummary.done.sort()).toEqual(["T1", "T2", "T3"]);
    expect(firstDispatch(journal.read())).toEqual(exNamed);
  });

  test("a resumed task that already has a model keeps it where a fresh plan names another", async () => {
    // Y7's first half: T1 was dispatched to fake:fake-2 before the run stopped; the resume restores it (the
    // daemon's restore is not touched) while a fresh plan, which reads no assignment, names fake:fake-1.
    const made = made3();
    const runId = "run-cx-turns-restore";
    const journal = await seeded(made.repo, runId, [
      ["task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "frontier" } }],
    ]);
    expect((await planned(made.repo, made.fake)).T1).toBe("fake:fake-1");
    const summary = await runDaemon(made.repo, { adapters: [made.fake], runId, resume: true });
    expect(summary.done).toContain("T1");
    expect(dispatches(journal.read(), "T1")).toEqual(["fake:fake-2", "fake:fake-2"]);
  });
});
