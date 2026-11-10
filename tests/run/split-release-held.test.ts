// Queue row 389 (D-2186 add.17, add.18; D-2187): "kept" means kept. Every open park a graph-changed resume
// answers with a kept row — a park with no definition record, or one whose task work cannot be read — is held
// out of scheduling as an exempt (human-gate, attempt-cap) kept park is, until an operator decision on that park.
// Through runDaemon on the ended and the stopped path. Zero tokens: fake adapter, disposable repositories.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, physicalLine, type JournalEvent } from "../../src/run/journal.js";
import { PARK_KEPT_EVENT, parkDefinition } from "../../src/run/split-release.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const SPEC = { source: "prd", paths: ["p"], hash: "h" };
const SEAT = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const SCHEDULED = ["task-dispatch", "worker-launch", "recheck-battery", "gate-result", "task-done", "task-approved", "task-human"];
const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();
const parkIndex = (events: JournalEvent[], taskId: string) => events.map((e) => e.event === "task-human" && e.taskId === taskId).lastIndexOf(true);

/** Two non-exempt parks, each with a changed definition: L1 written before definition records, F1 whose only
 * work is a journaled preserved ref that resolves nowhere. The run ended or was stopped by a SIGTERM inside
 * the approval window; the split is recompiled and the run resumed --graph-changed. */
async function heldScenario(stop: "ended" | "stopped") {
  const before = ["L1", "F1"].map((id) => T(id, { goal: `parked ${id}`, acceptance: [{ oracle: "command", command: "true" }] }));
  const { repo, scriptPath } = setupRepo(before, {
    tasks: Object.fromEntries(["L1", "F1"].map((id) => [id, [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }]])),
  });
  const runId = `run-split-held-${stop}`;
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef: await gitHead(repo), branch: `tickmarkr/${runId}`, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  journal.append("task-dispatch", "L1", { assignment: SEAT, attempt: 0 });
  journal.append("task-human", "L1", { kind: "infra", reason: "runner infra (a park written before definition records)" });
  journal.append("task-dispatch", "F1", { assignment: SEAT, attempt: 0 });
  journal.append("worktree-preserved", "F1", { ref: `refs/tickmarkr/preserved/${"e".repeat(40)}` });
  journal.append("task-human", "F1", { kind: "infra", reason: "runner infra", definition: parkDefinition(loadGraph(repo).tasks.find((t) => t.id === "F1")!) });
  journal.append("approval-window-start", undefined, { windowMs: 60_000, parked: ["L1", "F1"] });
  if (stop === "ended") {
    journal.append("approval-window-expired", undefined, { parked: ["L1", "F1"] });
    journal.append("run-end", undefined, { done: [], failed: [], human: ["L1", "F1"], blocked: [], pending: [] });
  } else {
    journal.append("exit-cause", undefined, { cause: "deliberate", signal: "SIGTERM" });
  }
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const seeded = journal.read();
  const parks = Object.fromEntries(["L1", "F1"].map((id) => {
    const i = parkIndex(seeded, id);
    return [id, { line: physicalLine(seeded, i), token: `${physicalLine(seeded, i)}@${seeded[i]!.ts}` }];
  }));
  // the recompile writes every task pending with its split definition
  saveGraph(repo, validateGraph({ version: 1, spec: SPEC, tasks: before.map((t) => ({ ...t, goal: `${String(t.goal)}, split`, files: [`${String(t.id)}.txt`] })) }));
  const summary = await runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true, graphChanged: true });
  const events = rows(repo, runId);
  return { repo, runId, scriptPath, summary, events, parks, resumeAt: events.findIndex((e) => e.event === "run-resume") };
}

async function assertHeld(stop: "ended" | "stopped") {
  const h = await heldScenario(stop);
  const resumed = h.events.slice(h.resumeAt);
  const ids = ["L1", "F1"] as const;
  // held: no dispatch, worker, battery, gate, re-park or release this resume — the kept row is its only row
  expect(Object.fromEntries(ids.map((id) => [id, resumed.filter((e) => e.taskId === id && SCHEDULED.includes(e.event)).map((e) => e.event)])))
    .toEqual({ L1: [], F1: [] });
  expect(Object.fromEntries(ids.map((id) => [id, loadGraph(h.repo).tasks.find((t) => t.id === id)?.status]))).toEqual({ L1: "human", F1: "human" });
  for (const [id, why] of [["L1", "the definition at park is unrecorded"], ["F1", "reading the task work failed ("]] as const) {
    const kept = resumed.filter((e) => e.taskId === id && e.event === PARK_KEPT_EVENT);
    expect(kept.map((e) => e.data.park), id).toEqual([h.parks[id]!.line]);
    expect(String(kept[0]!.data.reason), id).toContain(why);
  }
  expect(h.summary.human).toEqual(expect.arrayContaining(["L1", "F1"]));
  // status still projects each original park with its approve verb
  const parked = JSON.parse(await status([h.runId, "--json"], h.repo)) as { parks: { taskId: string; token: string | null; commands: { command: string }[] }[] };
  for (const id of ["L1", "F1"]) {
    const park = parked.parks.find((p) => p.taskId === id);
    expect(park?.token, id).toBe(h.parks[id]!.token);
    expect(park?.commands.map((c) => c.command), id).toContain(`tickmarkr approve ${h.runId} ${id} --park ${h.parks[id]!.token}`);
  }
  return h;
}

describe("row 389 — a kept park is held out of scheduling until an operator decision", () => {
  test("on the ended path a graph changed resume holds a park with no definition record and a park whose work read fails with no dispatch worker or battery and status keeps each park with its approve verb", async () => {
    await assertHeld("ended");
  }, 300_000);

  test("on the stopped path inside the approval window a graph changed resume holds a park with no definition record and a park whose work read fails the same way", async () => {
    await assertHeld("stopped");
  }, 300_000);

  test("an operator approve on a held kept park releases it as at the base and the next resume dispatches it", async () => {
    const h = await heldScenario("ended");
    await approve([h.runId, "L1", "--park", h.parks.L1!.token], h.repo);
    const summary = await runDaemon(h.repo, { adapters: [new FakeAdapter(h.scriptPath)], runId: h.runId, resume: true });
    const events = rows(h.repo, h.runId);
    const after = events.slice(events.map((e) => e.event).lastIndexOf("run-resume")).filter((e) => e.taskId === "L1").map((e) => e.event);
    expect(after).toEqual(expect.arrayContaining(["task-dispatch", "worker-launch", "task-done"]));
    expect(summary.done).toContain("L1");
    // the other held park stays held: no decision bound to it
    expect(summary.human).toContain("F1");
  }, 300_000);
});
