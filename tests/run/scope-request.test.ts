import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { applyScopeAmendments, Journal, recordedGraphDefinitionHash } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const criterion = "test: approving a scope-request park with files against a live daemon journals graph-rehash naming both hashes and the approval, the next dispatch row carries the amended files[] and a fresh session with no halt row while an unrelated running task keeps its attempt, a second approval of the same revision is refused, the same approval without files is refused naming the flag, a resume over a recompiled graph that equals the approved graph except for the amendment re-applies it and journals the rehash before dispatch, and a resume over a graph whose task goal, acceptance, deps or floor changed beyond the amendment is refused with the recorded identity unmoved and nothing dispatched, so an amendment that needs a halt, a resume override, or a recompile to survive, or a replay onto a changed definition, fails";

const refusal = { shell: "true", result: { ok: false, summary: "Cannot edit needed.txt outside files[] allowlist" } };
const success = { shell: `echo fixed > needed.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } };

test.each(["needed.txt", "*.txt"])("scope-request approval refuses files overlapping an independent sibling (%s) without changing graph or journal", async (siblingPattern) => {
  const { repo } = setupRepo([
    T("T1", { files: ["owned.ts"] }),
    T("T2", { files: [siblingPattern] }),
  ], { tasks: {} });
  const graph = loadGraph(repo);
  const journal = Journal.create(repo, "run-scope-overlap");
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
  journal.append("task-dispatch", "T2", { attempt: 1, files: [siblingPattern] });
  journal.append("task-human", "T1", { kind: "scope-request", paths: ["needed.txt"], graphDefinitionHash: graphDefinitionHash(graph) });
  const graphPath = join(repo, ".tickmarkr", "graph.json");
  const journalPath = join(journal.dir, "journal.jsonl");
  const beforeGraph = readFileSync(graphPath, "utf8");
  const beforeJournal = readFileSync(journalPath, "utf8");
  const beforeResumeState = journal.replayResumeState();
  const shared = siblingPattern === "needed.txt" ? "needed.txt" : `needed.txt ⊂ ${siblingPattern}`;

  await expect(approve([journal.runId, "T1", "--files", "needed.txt"], repo))
    .rejects.toThrow(`T1 and T2 both write ${shared}`);

  expect(readFileSync(graphPath, "utf8")).toBe(beforeGraph);
  expect(readFileSync(journalPath, "utf8")).toBe(beforeJournal);
  expect(journal.replayResumeState()).toEqual(beforeResumeState);
  expect(journal.replayStatuses().get("T1")).toBe("human");
});

test("scope-request approval permits shared files when a dependency orders the tasks", async () => {
  const { repo } = setupRepo([
    T("T1", { files: ["owned.txt"], deps: ["T2"] }),
    T("T2", { files: ["needed.txt"] }),
  ], { tasks: {} });
  const graph = loadGraph(repo);
  const journal = Journal.create(repo, "run-scope-ordered");
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
  journal.append("task-done", "T2", {});
  journal.append("task-human", "T1", { kind: "scope-request", paths: ["needed.txt"], graphDefinitionHash: graphDefinitionHash(graph) });

  await approve([journal.runId, "T1", "--files", "needed.txt"], repo);

  const amended = loadGraph(repo);
  expect(amended.tasks.find((t) => t.id === "T1")?.files).toEqual(["owned.txt", "needed.txt"]);
  expect(amended.tasks.find((t) => t.id === "T2")).toEqual(graph.tasks.find((t) => t.id === "T2"));
  expect(journal.read().filter((e) => e.event === "task-approved")).toHaveLength(1);
  expect(journal.read().filter((e) => e.event === "graph-rehash")).toHaveLength(1);
  expect(recordedGraphDefinitionHash(journal.read())).toBe(graphDefinitionHash(amended));
  expect(journal.replayStatuses()).toEqual(new Map([["T2", "done"], ["T1", "pending"]]));
});

test(criterion, async () => {
  const live = setupRepo([T("T1", { files: ["owned.txt"], acceptance: [{ oracle: "command", command: "test -f needed.txt" }] }), T("T2", { files: ["sibling.txt"], acceptance: [{ oracle: "command", command: "test -f sibling.txt" }] })],
    { tasks: { T1: [refusal, success], T2: [] } }, "concurrency: 2\n");
  const release = join(live.repo, ".tickmarkr", "release-sibling");
  const started = join(live.repo, ".tickmarkr", "sibling-started");
  // The sibling stays in its original worker until the amended dispatch is observed.
  const { FakeAdapter } = await import("../../src/adapters/fake.js");
  writeFileSync(live.scriptPath, JSON.stringify({ tasks: {
    T1: [refusal, success],
    T2: [{ shell: `touch ${shq(started)}; while [ ! -f ${shq(release)} ]; do sleep 0.1; done; echo sibling > sibling.txt && ${COMMIT} sibling`, result: { ok: true, summary: "sibling" } }],
  }, judge: { pass: true, criteria: [] }, review: { approve: true, issues: [] } }));
  const original = loadGraph(live.repo);
  const id = "run-scope-live";
  const running = runDaemon(live.repo, { adapters: [new FakeAdapter(live.scriptPath)], runId: id, approvalWindowMs: 1000,
    narrate: (e) => {
      if (e.event === "task-dispatch" && e.taskId === "T1" && (e.data.files as string[] | undefined)?.includes("needed.txt")) {
        writeFileSync(release, "go");
      }
    },
  });
  // Always reap the blocked sibling, including when an assertion fails.
  try {
    await expect.poll(() => existsSync(started), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => Journal.open(live.repo, id).read().some((e) => e.event === "task-human" && e.data.kind === "scope-request"), { timeout: 30_000 }).toBe(true);
    const journal = Journal.open(live.repo, id);
    const before = journal.read().length;
    await expect(approve([id, "T1"], live.repo)).rejects.toThrow("--files");
    expect(journal.read()).toHaveLength(before);
    expect(await approve([id, "T1", "--files", "needed.txt", "--by", "scope-operator"], live.repo)).toContain("live daemon");
    await expect(approve([id, "T1", "--files", "needed.txt"], live.repo)).rejects.toThrow(/not a parked|refus/i);
    await running;
    const rows = journal.read();
    const approval = rows.find((e) => e.event === "task-approved")!;
    expect(rows.filter((e) => e.event === "graph-rehash")).toHaveLength(1);
    const rehash = rows.find((e) => e.event === "graph-rehash")!;
    expect(rehash.data).toMatchObject({ from: graphDefinitionHash(original), to: graphDefinitionHash(loadGraph(live.repo)), approval: approval.ts, by: "scope-operator", source: "approval" });
    const dispatches = rows.filter((e) => e.event === "task-dispatch" && e.taskId === "T1");
    expect(dispatches, JSON.stringify(rows.filter((e) => e.event === "gate-result"))).toHaveLength(2);
    expect(dispatches[1]!.data).toMatchObject({ files: ["owned.txt", "needed.txt"], retryMode: "fresh", graphDefinitionHash: rehash.data.to });
    expect(rows.indexOf(rehash)).toBeLessThan(rows.indexOf(dispatches[1]!));
    expect(rows.filter((e) => /halt/.test(e.event))).toEqual([]);
    expect(rows.filter((e) => e.event === "task-dispatch" && e.taskId === "T2")).toHaveLength(1);
    expect(rows.findIndex((e) => e.event === "worker-result" && e.taskId === "T2")).toBeGreaterThan(rows.indexOf(dispatches[1]!));
    const launches = rows.filter((e) => e.event === "worker-launch" && e.taskId === "T1");
    expect(launches.map((e) => e.data.retryMode)).toEqual(["fresh", "fresh"]);
    expect(launches[1]!.data.slot).not.toEqual(launches[0]!.data.slot);
  } finally {
    writeFileSync(release, "go");
    await running;
  }

  const replay = setupRepo([T("T1", { files: ["owned.txt"], acceptance: [{ oracle: "command", command: "test -f needed.txt" }] }), T("T2", { humanGate: true })], { tasks: { T1: [refusal, success] } });
  const base = loadGraph(replay.repo);
  const resumeId = "run-scope-replay";
  await runDaemon(replay.repo, { adapters: [replay.fake], runId: resumeId, approvalWindowMs: 1 });
  const parkedJournal = Journal.open(replay.repo, resumeId);
  const beforeStale = parkedJournal.read();
  saveGraph(replay.repo, { ...base, tasks: base.tasks.map((t) => t.id === "T1" ? { ...t, goal: "changed before approval" } : t) });
  await expect(approve([resumeId, "T1", "--files", "needed.txt"], replay.repo)).rejects.toThrow(/stale.*revision changed/);
  expect(parkedJournal.read()).toEqual(beforeStale);
  saveGraph(replay.repo, base);
  await approve([resumeId, "T1", "--files", "needed.txt"], replay.repo);
  const journal = Journal.open(replay.repo, resumeId);
  const identity = recordedGraphDefinitionHash(journal.read());
  const count = journal.read().filter((e) => e.event === "task-dispatch").length;
  for (const change of [
    { goal: "changed" }, { acceptance: ["changed"] }, { deps: ["T2"] }, { routingHints: { floor: "frontier" } },
  ]) {
    saveGraph(replay.repo, { ...base, tasks: base.tasks.map((t) => t.id === "T1" ? { ...t, ...change } : t) } as typeof base);
    await expect(runDaemon(replay.repo, { adapters: [replay.fake], runId: resumeId, resume: true, approvalWindowMs: 1 })).rejects.toThrow(/definition changed/);
    expect(recordedGraphDefinitionHash(journal.read())).toBe(identity);
    expect(journal.read().filter((e) => e.event === "task-dispatch")).toHaveLength(count);
  }
  saveGraph(replay.repo, base); // recompile erased only the amendment
  const boundary = journal.read().length;
  await runDaemon(replay.repo, { adapters: [replay.fake], runId: resumeId, resume: true, approvalWindowMs: 1 });
  const resumed = journal.read().slice(boundary);
  expect(resumed.findIndex((e) => e.event === "graph-rehash")).toBeGreaterThanOrEqual(0);
  expect(resumed.findIndex((e) => e.event === "graph-rehash")).toBeLessThan(resumed.findIndex((e) => e.event === "task-dispatch"));
  expect(resumed.find((e) => e.event === "task-dispatch")?.data.files).toEqual(["owned.txt", "needed.txt"]);
  expect(recordedGraphDefinitionHash(journal.read())).toBe(identity);
}, 180_000);


test("an interrupted approval append recovers its missing rehash from the durable amendment before materializing files", () => {
  const { repo } = setupRepo([T("T1", { files: ["owned.txt"] })], { tasks: {} });
  const graph = loadGraph(repo);
  const amended = { ...graph, tasks: graph.tasks.map((t) => ({ ...t, files: [...t.files, "needed.txt"] })) };
  const journal = Journal.create(repo, "run-scope-partial");
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
  journal.append("task-human", "T1", { kind: "scope-request" });
  journal.append("task-approved", "T1", { by: "operator", release: "scope-request", amendment: {
    from: graphDefinitionHash(graph), to: graphDefinitionHash(amended), beforeFiles: ["owned.txt"], files: ["owned.txt", "needed.txt"], parkLine: 2,
  } });
  const path = join(journal.dir, "journal.jsonl");
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  expect(JSON.parse(lines.at(-1)!).event).toBe("graph-rehash");
  // Crash left the permission row durable, but lost the tail of its paired append.
  writeFileSync(path, lines.slice(0, -1).join("\n") + "\n");
  expect(recordedGraphDefinitionHash(journal.read())).toBe(graphDefinitionHash(graph));
  const projected = applyScopeAmendments(graph, journal);
  expect(projected.tasks[0]!.files).toEqual(["owned.txt", "needed.txt"]);
  expect(recordedGraphDefinitionHash(journal.read())).toBe(graphDefinitionHash(amended));
  const recovered = journal.read();
  expect(recovered.at(-1)!.data).toMatchObject({ source: "approval", approval: recovered[2]!.ts });
  expect(applyScopeAmendments(projected, journal)).toEqual(projected);
  expect(journal.read()).toEqual(recovered); // recovery is idempotent
});
