// Queue row 409 (D-2187 add.100 N1): a scope grant whose task definition or files[] changed LAPSES under a
// --graph-changed resume instead of refusing; the lapse is durable in every later fold. Every cell of the
// contract's closed case table runs through the production seams: the daemon's resume, approve --files,
// and the replay verify and approve share.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { graphDefinitionHash, loadGraph, saveGraph, taskDefinitionFingerprint } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { resetHostLatencySampleForTests, setHostLatencySampleForTests } from "../../src/run/host-health.js";
import { applyScopeAmendments, engagementComparable, engagementReleased, Journal, recordedGraphDefinitionHash, replayScopeAmendments, SCOPE_LAPSE_EVENT } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

beforeEach(() => { setHostLatencySampleForTests(async () => 20); });
afterEach(() => { resetHostLatencySampleForTests(); });

const refuse = (path: string) => ({ shell: "true", result: { ok: false, summary: `Cannot edit ${path} outside files[] allowlist` } });
const succeed = { shell: `echo fixed > owned.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } };
const ACCEPT = [{ oracle: "command", command: "test -f base.txt" }];

/** A run whose T1 holds one production grant per path, the run ended with T1 approved and pending. */
async function granted(id: string, grants: string[], later: object[]) {
  const fixture = setupRepo([T("T1", { files: ["owned.txt"], acceptance: ACCEPT })], { tasks: { T1: [...grants.map(refuse), ...later] } });
  for (const path of ["needed.txt", "other.txt"]) writeFileSync(join(fixture.repo, path), "needs repair\n");
  execFileSync("git", ["add", "-A"], { cwd: fixture.repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "seed requested paths"], { cwd: fixture.repo });
  const base = loadGraph(fixture.repo);
  for (const [i, path] of grants.entries()) {
    await runDaemon(fixture.repo, { adapters: [fixture.fake], runId: id, resume: i > 0, approvalWindowMs: 1 });
    await approve([id, "T1", "--files", path], fixture.repo);
  }
  const journal = Journal.open(fixture.repo, id);
  const resume = (graphChanged: boolean) =>
    runDaemon(fixture.repo, { adapters: [fixture.fake], runId: id, resume: true, graphChanged, approvalWindowMs: 1 });
  const recompile = (over: Record<string, unknown>): RunGraph => {
    const graph = { ...base, tasks: base.tasks.map((t) => t.id === "T1" ? { ...t, ...over } : t) } as RunGraph;
    saveGraph(fixture.repo, graph);
    return graph;
  };
  const lapses = () => journal.read().filter((e) => e.event === SCOPE_LAPSE_EVENT);
  const dispatchFiles = () => journal.read().filter((e) => e.event === "task-dispatch" && e.taskId === "T1").at(-1)?.data.files;
  const fingerprint = (graph: RunGraph) => taskDefinitionFingerprint(graph.tasks.find((t) => t.id === "T1")!);
  return { ...fixture, base, journal, resume, recompile, lapses, dispatchFiles, fingerprint };
}

test("a graph changed resume over a granted task whose definition changed lapses the grant with both fingerprints and resumes with the new files", async () => {
  const run = await granted("run-lapse-goal", ["needed.txt"], [succeed]);
  const park = (run.journal.read().find((e) => e.event === "task-approved")!.data.amendment as { parkLine: number }).parkLine;
  // control: unchanged definition and files under the release replay the amendment as at the base, lapsing nothing
  expect(applyScopeAmendments(run.base, run.journal, false, true).tasks[0]!.files).toEqual(["owned.txt", "needed.txt"]);
  expect(run.lapses()).toEqual([]);

  const moved = run.recompile({ goal: "T1 rewritten" });
  await run.resume(true); // the base refused here: "definition changed beyond the approved amendment"
  expect(run.lapses()).toHaveLength(1);
  expect(run.lapses()[0]).toMatchObject({ taskId: "T1", data: { park, from: run.fingerprint(run.base), to: run.fingerprint(moved), files: ["needed.txt"] } });
  expect(run.lapses()[0]!.data.from).not.toBe(run.lapses()[0]!.data.to);
  expect(run.dispatchFiles()).toEqual(["owned.txt"]);
  expect(run.journal.read().at(-1)!.event).toBe("run-end");

  // a second graph-changed resume journals no second lapse row for the same grant
  await run.resume(true);
  expect(run.lapses()).toHaveLength(1);

  // a definition AND files change of a fresh grant: one lapse row, no refusal at the files check
  const both = await granted("run-lapse-both", ["needed.txt"], [succeed]);
  const bothGraph = both.recompile({ goal: "T1 rewritten", files: ["owned.txt", "renamed.txt"] });
  expect(applyScopeAmendments(bothGraph, both.journal, true, true).tasks[0]!.files).toEqual(["owned.txt", "renamed.txt"]);
  expect(both.lapses()).toHaveLength(1);
  expect(both.lapses()[0]!.data).toMatchObject({ from: both.fingerprint(both.base), to: both.fingerprint(bothGraph) });
}, 180_000);

test("a files only change also lapses under a graph changed resume while a plain resume with no lapse refuses as before", async () => {
  const run = await granted("run-lapse-files", ["needed.txt"], [succeed]);
  // control: with no lapse recorded a plain resume refuses exactly as at the base, for a definition or a files change
  run.recompile({ goal: "T1 rewritten" });
  await expect(run.resume(false)).rejects.toThrow("refusing scope amendment replay: graph task definition changed beyond approval for T1 — resume with --graph-changed to release it");
  const filesOnly = run.recompile({ files: ["owned.txt", "renamed.txt"] });
  await expect(run.resume(false)).rejects.toThrow("refusing scope amendment replay: T1 files[] changed beyond the approved amendment");
  expect(() => replayScopeAmendments(filesOnly, run.journal.read())).toThrow(/T1 files\[\] changed beyond the approved amendment/);
  expect(run.lapses()).toEqual([]);

  // the fingerprint excludes files[]: only the files check sees this change, and under the release it lapses
  expect(run.fingerprint(filesOnly)).toBe(run.fingerprint(run.base));
  await run.resume(true);
  expect(run.lapses()).toHaveLength(1);
  expect(run.lapses()[0]!.data).toMatchObject({ from: run.fingerprint(run.base), to: run.fingerprint(run.base), files: ["needed.txt"] });
  expect(run.dispatchFiles()).toEqual(["owned.txt", "renamed.txt"]);
}, 180_000);

test("after a lapse a plain resume replays only active grants and a lapsed path is granted again through the scope gate and approve", async () => {
  const run = await granted("run-lapse-regrant", ["needed.txt", "other.txt"], [refuse("needed.txt"), succeed]);
  const moved = run.recompile({ goal: "T1 rewritten" });
  // both old grants lapse; the worker then needs a lapsed path and parks a scope request
  await run.resume(true);
  expect(run.lapses().map((e) => e.data.files)).toEqual([["needed.txt"], ["other.txt"]]);
  expect(run.dispatchFiles()).toEqual(["owned.txt"]);
  expect(run.journal.read().filter((e) => e.event === "task-human" && e.data.kind === "scope-request")).toHaveLength(3);

  // every later fold skips the lapsed grants: the plain replay verify uses, on the new definition, refuses nothing
  expect(replayScopeAmendments(moved, run.journal.read()).tasks[0]!.files).toEqual(["owned.txt"]);
  await approve(["run-lapse-regrant", "T1", "--files", "needed.txt"], run.repo);
  const active = run.journal.read().filter((e) => e.event === "task-approved" && e.data.amendment !== undefined).at(-1)!;
  expect(active.data.amendment).toMatchObject({ beforeFiles: ["owned.txt"], files: ["owned.txt", "needed.txt"], definition: run.fingerprint(moved) });

  // a plain resume starts: only the new grant replays, onto the new definition's files[]
  saveGraph(run.repo, moved); // a recompile of the new definition
  await run.resume(false);
  expect(run.dispatchFiles()).toEqual(["owned.txt", "needed.txt"]);
  expect(run.lapses()).toHaveLength(2);
  expect(replayScopeAmendments(moved, run.journal.read()).tasks[0]!.files).toEqual(["owned.txt", "needed.txt"]);
  const rows = run.journal.read();
  expect(rows.at(-1)!.data).toMatchObject({ done: ["T1"] });
}, 240_000);

// Repair (row 409, D-2187 add.100 N1): a grant that SURVIVES a graph-changed resume beside a lapsed one keeps
// replaying on every later plain fold. Its whole-graph from/to predate the audited transition, so the plain fold skips
// them and the shared comparator binds the identity (add.144); before this repair the plain replay refused it.
test("a surviving grant on another task replays on a plain resume after a lapse in the production daemon", async () => {
  const done = (file: string) => ({ shell: `echo fixed > ${file} && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } });
  const fixture = setupRepo([T("T1", { files: ["one.txt"], acceptance: ACCEPT }), T("T2", { files: ["two.txt"], deps: ["T1"], acceptance: ACCEPT })],
    { tasks: { T1: [refuse("needed.txt"), done("one.txt")], T2: [refuse("other.txt"), done("two.txt")] } });
  for (const path of ["needed.txt", "other.txt"]) writeFileSync(join(fixture.repo, path), "needs repair\n");
  execFileSync("git", ["add", "-A"], { cwd: fixture.repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "seed requested paths"], { cwd: fixture.repo });
  const base = loadGraph(fixture.repo);
  const id = "run-lapse-survivor";
  const resume = (resumed: boolean, graphChanged = false) =>
    runDaemon(fixture.repo, { adapters: [fixture.fake], runId: id, resume: resumed, graphChanged, approvalWindowMs: 1 });
  await resume(false);
  await approve([id, "T1", "--files", "needed.txt"], fixture.repo);
  await resume(true); // T1 finishes on its grant; T2 (after T1) then parks its own scope request
  await approve([id, "T2", "--files", "other.txt"], fixture.repo);
  const moved = { ...base, tasks: base.tasks.map((t) => t.id === "T1" ? { ...t, goal: "T1 rewritten" } : t) } as RunGraph;
  saveGraph(fixture.repo, moved);
  await resume(true, true);
  const journal = Journal.open(fixture.repo, id);
  expect(journal.read().filter((e) => e.event === SCOPE_LAPSE_EVENT).map((e) => e.taskId)).toEqual(["T1"]);
  // the plain resume starts without a regrant and T2's grant still replays
  await resume(true);
  expect(journal.read().at(-1)!.event).toBe("run-end");
  expect(replayScopeAmendments(moved, journal.read()).tasks.map((t) => t.files)).toEqual([["one.txt"], ["two.txt", "other.txt"]]);
  // verify's supersede source replays the run's start snapshot: the surviving grant binds there too
  const snapshot = validateGraph(JSON.parse(readFileSync(join(journal.dir, "graph.json"), "utf8")));
  expect(replayScopeAmendments(snapshot, journal.read()).tasks.map((t) => t.files)).toEqual([["one.txt"], ["two.txt", "other.txt"]]);
  // a further unaudited T1 change after the lapse: the plain resume refuses and the recorded identity stays put
  const recorded = recordedGraphDefinitionHash(journal.read());
  saveGraph(fixture.repo, { ...moved, tasks: moved.tasks.map((t) => t.id === "T1" ? { ...t, goal: "T1 rewritten again" } : t) } as RunGraph);
  await expect(resume(true)).rejects.toThrow(/graph changed since this run/);
  expect(journal.read().filter((e) => e.event === "graph-rehash").at(-1)!.data.to).toBe(recorded);
  expect(recordedGraphDefinitionHash(journal.read())).toBe(recorded);
}, 240_000);

/** A synthetic journal of production-shaped grants, one per task in `order`, each bound to the whole graph. */
function grantJournal(repo: string, order: string[], legacy = false) {
  const base = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: ["T1", "T2"].map((id) => T(id, { files: [`${id}.ts`] })) });
  const journal = Journal.create(repo, `run-${order.join("")}`);
  // the run's start snapshot; a legacy (pre-v2.5.7) row carries no fingerprint and the snapshot backs it
  writeFileSync(join(journal.dir, "graph.json"), JSON.stringify(base));
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(base) });
  let graph = base;
  for (const id of order) {
    const task = graph.tasks.find((t) => t.id === id)!;
    const files = [...task.files, `${id}-grant.ts`];
    const next = { ...graph, tasks: graph.tasks.map((t) => t.id === id ? { ...t, files } : t) };
    journal.append("task-human", id, { kind: "scope-request" });
    const park = journal.newestBinding(id)!;
    journal.append("task-approved", id, { release: "scope-request", park, amendment: {
      from: graphDefinitionHash(graph), to: graphDefinitionHash(next), beforeFiles: task.files, files, parkLine: park.line,
      ...(legacy ? {} : { definition: taskDefinitionFingerprint(task) }) } });
    graph = next;
  }
  return { base, journal };
}

/** The daemon's resume launch, line for line (daemon.ts): the audited replay, then the shared comparator. */
function launch(journal: Journal, loaded: RunGraph, graphChanged: boolean): RunGraph {
  const graph = applyScopeAmendments(loaded, journal, true, graphChanged);
  const cmp = engagementComparable(journal.read(), graphDefinitionHash(graph));
  if (!cmp.comparable) {
    if (!graphChanged) throw new Error(`refusing to resume: graph changed since this run`);
    journal.append("graph-rehash", undefined, { from: cmp.reason === "mismatch" ? cmp.recorded : null, to: graphDefinitionHash(graph) });
  }
  return graph;
}

// Amendment F (D-2187 add.144): its five rows, each in both grant orders, for a goal-only and a files-only change,
// for current and legacy snapshot-backed amendments, through every fold of the contract's closed list.
test("grants on two tasks keep the unchanged task's grant active through every fold after the other lapses", () => {
  const drifts = [{ goal: "rewritten" }, { files: ["T1.ts", "renamed.ts"] }];
  const t2drifts = [{ goal: "drifted" }, { files: ["T2.ts", "moved.ts"] }];
  const cells = [false, true].flatMap((legacy) => [["T1", "T2"], ["T2", "T1"]].flatMap((order) =>
    drifts.map((drift, d) => ({ legacy, order, drift, t2drift: t2drifts[d]! }))));
  expect(cells).toHaveLength(8);
  for (const { legacy, order, drift, t2drift } of cells) {
    const { base, journal } = grantJournal(makeTestTempDir("scope-lapse-"), order, legacy);
    const t1 = (graph: RunGraph, over: object) => ({ ...graph, tasks: graph.tasks.map((t) => t.id === "T1" ? { ...t, ...over } : t) }) as RunGraph;
    const t2 = (graph: RunGraph, over: object) => ({ ...graph, tasks: graph.tasks.map((t) => t.id === "T2" ? { ...t, ...over } : t) }) as RunGraph;
    const changed = t1(base, drift); // the recompiled graph: T1 moved, T2 back at its compiled files[]
    const lapses = () => journal.read().filter((e) => e.event === SCOPE_LAPSE_EVENT).map((e) => e.taskId);
    const files = (graph: RunGraph) => graph.tasks.map((t) => t.files);
    const expected = [changed.tasks[0]!.files, ["T2.ts", "T2-grant.ts"]];

    // row 1: graph-changed resume — one lapse row for T1; T2's grant replays onto its files[]
    expect(files(launch(journal, changed, true))).toEqual(expected);
    expect(lapses()).toEqual(["T1"]);
    // row 2: a plain resume starts; the surviving grant replays, the lapsed one does not
    expect(files(launch(journal, changed, false))).toEqual(expected);
    // row 3: approve's replay (its grant check binds through the comparator) and verify's replay from its run snapshot
    const approved = applyScopeAmendments(changed, journal, false, engagementReleased(journal.read()));
    expect(files(approved)).toEqual(expected);
    expect(engagementComparable(journal.read(), graphDefinitionHash(approved)).comparable).toBe(true);
    const snapshot = validateGraph(JSON.parse(readFileSync(join(journal.dir, "graph.json"), "utf8")));
    expect(files(replayScopeAmendments(snapshot, journal.read()))).toEqual([["T1.ts"], ["T2.ts", "T2-grant.ts"]]);
    // row 4 (control): a FURTHER change to either task, plain resume — refuses, no graph-rehash journaled
    for (const further of [t1(changed, "goal" in drift ? { goal: "rewritten twice" } : { files: ["T1.ts", "again.ts"] }), t2(changed, t2drift)]) {
      const rehashes = journal.read().filter((e) => e.event === "graph-rehash").length;
      expect(() => launch(journal, further, false)).toThrow(/graph changed since this run|T2 files\[\] changed beyond the approved amendment/);
      expect(journal.read().filter((e) => e.event === "graph-rehash")).toHaveLength(rehashes);
    }
    // row 5: a further change to the SURVIVING grant's task under a graph-changed resume lapses it too, one row
    expect(files(launch(journal, t2(changed, t2drift), true))).toEqual([changed.tasks[0]!.files, t2(changed, t2drift).tasks[1]!.files]);
    expect(lapses()).toEqual(["T1", "T2"]);
  }
});
