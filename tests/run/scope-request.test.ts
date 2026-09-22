import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph, saveGraph, taskDefinitionFingerprint } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import * as stall from "../../src/run/stall.js";
import { applyScopeAmendments, engagementReleased, Journal, recordedGraphDefinitionHash, replayScopeAmendments } from "../../src/run/journal.js";
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
  seedNeeded(live.repo);
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
  const driver = new SubprocessDriver();
  const groups = new Map<string, number>();
  let nextGroup = 40_000;
  // Isolate the ownership oracle from host ps permissions. Actual children are
  // still closed by SubprocessDriver, while each launch gets a distinct claim.
  const readGroup = vi.spyOn(stall, "readOwnedProcessGroup").mockImplementation((path) => groups.get(path));
  const reapGroup = vi.spyOn(stall, "reapOwnedProcessGroup").mockResolvedValue([]);
  const launch = driver.run.bind(driver);
  driver.run = async (slot, cmd) => {
    if (slot.name.includes("-worker-")) {
      const script = /^bash '(.+)'$/.exec(cmd)![1]!;
      const groupFile = / > '([^']+\.pgid)'/.exec(readFileSync(script, "utf8"))![1]!;
      groups.set(groupFile, ++nextGroup);
    }
    await launch(slot, cmd);
  };
  const waitOutput = driver.waitOutput.bind(driver);
  driver.waitOutput = async (slot, pattern, timeoutMs, opts) => {
    const hit = await waitOutput(slot, pattern, timeoutMs, opts);
    // Make the exited-pane retention path deterministic: approval resets the attempt
    // budget while the old pane is still retained until the run-end sweep.
    if (hit && slot.name.includes("-worker-")) {
      expect(await waitOutput(slot, "TICKMARKR_EXIT_[a-z0-9]+:[0-9]+", 5_000, { regex: true })).toBe(true);
    }
    return hit;
  };
  const running = runDaemon(live.repo, { driver, adapters: [new FakeAdapter(live.scriptPath)], runId: id, approvalWindowMs: 1000,
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
    // Reused attempt numbers must never overwrite an earlier pane's group claim.
    expect(dispatches[1]!.data.attempt).toBe(dispatches[0]!.data.attempt);
    expect([...groups.keys()].filter((path) => path.includes("/T1-"))).toHaveLength(2);
    expect(reapGroup.mock.calls.map(([group]) => group).sort()).toEqual([...groups.values()].sort());
  } finally {
    writeFileSync(release, "go");
    try { await running; } finally {
      readGroup.mockRestore();
      reapGroup.mockRestore();
    }
  }

  const replay = setupRepo([T("T1", { files: ["owned.txt"], acceptance: [{ oracle: "command", command: "test -f needed.txt" }] }), T("T2", { humanGate: true })], { tasks: { T1: [refusal, success] } });
  seedNeeded(replay.repo);
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

// OBS-1073 (v2.5.7 run …152220, resume #7 refused): T9's in-run --files grant plus a later spec repair of
// T11 (D-57) left the run unresumable — the replay demanded the whole-graph hash of a graph that no
// longer existed, and --graph-changed was checked only afterwards.
test("test: an in-run scope amendment replays onto a graph where another task was later re-scoped only under the graph-changed release, restoring the amended files and keeping the other task's widening, while the same replay without the release still refuses naming the amended task, and under the release a drift of the amended task's goal acceptance deps or routing is refused against the fingerprint the approval recorded or against the run's graph snapshot for an older approval, so a release that accepts a moved definition or a refusal that blocks the audited resume fails", () => {
  const { repo } = setupRepo([T("T1", { files: ["owned.txt"] }), T("T2", { files: ["other.txt"] })], { tasks: {} });
  const graph = loadGraph(repo);
  const amended = { ...graph, tasks: graph.tasks.map((t) => t.id === "T1" ? { ...t, files: ["owned.txt", "needed.txt"] } : t) };
  const journal = Journal.create(repo, "run-scope-release");
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
  journal.append("task-human", "T1", { kind: "scope-request" });
  journal.append("task-approved", "T1", { by: "operator", release: "scope-request", amendment: {
    from: graphDefinitionHash(graph), to: graphDefinitionHash(amended), beforeFiles: ["owned.txt"], files: ["owned.txt", "needed.txt"], parkLine: 2,
    definition: taskDefinitionFingerprint(graph.tasks.find((t) => t.id === "T1")!),
  } });
  const events = journal.read();
  // a later spec repair widens ANOTHER task; the recompiled graph carries T1's original files[]
  const repaired = { ...graph, tasks: graph.tasks.map((t) => t.id === "T2" ? { ...t, files: ["other.txt", "late.txt"] } : t) };
  expect(() => replayScopeAmendments(repaired, events)).toThrow(/beyond approval for T1/);
  const released = replayScopeAmendments(repaired, events, true);
  expect(released.tasks.find((t) => t.id === "T1")!.files).toEqual(["owned.txt", "needed.txt"]);
  expect(released.tasks.find((t) => t.id === "T2")!.files).toEqual(["other.txt", "late.txt"]);
  // the release waives whole-graph identity only: an amended task whose files[] drifted is still refused
  const drifted = { ...repaired, tasks: repaired.tasks.map((t) => t.id === "T1" ? { ...t, files: ["renamed.txt"] } : t) };
  expect(() => replayScopeAmendments(drifted, events, true)).toThrow(/T1 files\[\] changed beyond the approved amendment/);
  // …and never the amended task's own definition: every non-files drift is refused under the release
  const t1 = graph.tasks.find((t) => t.id === "T1")!;
  for (const change of [{ goal: "changed" }, { acceptance: ["changed"] }, { deps: ["T2"] }, { routingHints: { ...t1.routingHints, floor: "frontier" } }]) {
    const moved = { ...repaired, tasks: repaired.tasks.map((t) => t.id === "T1" ? { ...t, ...change } : t) };
    expect(() => replayScopeAmendments(moved, events, true)).toThrow(/T1 definition changed beyond the approved amendment/);
  }
  // an older approval row carries no fingerprint: the caller supplies the run snapshot's, and without one the release refuses
  const legacy = journal.read().map((e) => e.event === "task-approved" ? { ...e, data: { ...e.data, amendment: { ...(e.data.amendment as object), definition: undefined } } } : e);
  expect(() => replayScopeAmendments(repaired, legacy, true)).toThrow(/no approved definition fingerprint for T1/);
  const snapshot = new Map([["T1", taskDefinitionFingerprint(t1)]]);
  expect(replayScopeAmendments(repaired, legacy, true, snapshot).tasks.find((t) => t.id === "T1")!.files).toEqual(["owned.txt", "needed.txt"]);
  // and the unchanged path is byte-for-byte the old behaviour
  expect(replayScopeAmendments(graph, events).tasks.find((t) => t.id === "T1")!.files).toEqual(["owned.txt", "needed.txt"]);
});

// OBS-1073 residual (v2.5.7 run …152220, engagement 8 died 9 s after an in-run approve): the launch honoured
// --graph-changed, the in-run approval sweep did not.
test("test: a daemon resumed under the graph-changed release over a graph where another task was widened after an in-run scope grant survives an in-run plain approval of a parked human gate, journals the release on its run-resume row and dispatches the approved task, so a sweep that re-runs the whole-graph asserts the launch waived and dies fails", async () => {
  const { repo, fake, scriptPath } = setupRepo([
    T("T1", { files: ["owned.txt"], acceptance: [{ oracle: "command", command: "test -f needed.txt" }] }),
    T("T2", { humanGate: true, files: ["gate.txt"], acceptance: [{ oracle: "command", command: "test -f gate.txt" }] }),
    T("T3", { files: ["other.txt"] }),
  ], { tasks: { T1: [refusal], T3: [{ shell: `echo other > other.txt && ${COMMIT} other`, result: { ok: true, summary: "other" } }] } }, "concurrency: 2\n");
  seedNeeded(repo); // v2.5.7 T12: a scope request names a path that exists in the task tree, or it is no scope request
  const runId = "run-scope-release-live";
  await runDaemon(repo, { adapters: [fake], runId, approvalWindowMs: 1 });
  const journal = Journal.open(repo, runId);
  expect(journal.replayStatuses().get("T1")).toBe("human");
  await approve([runId, "T1", "--files", "needed.txt"], repo);
  // a later spec repair widens ANOTHER task
  const base = loadGraph(repo);
  saveGraph(repo, { ...base, tasks: base.tasks.map((t) => t.id === "T3" ? { ...t, files: ["other.txt", "late.txt"] } : t) });
  const release = join(repo, ".tickmarkr", "release-t1");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {
    T1: [{ shell: `while [ ! -f ${shq(release)} ]; do sleep 0.1; done; echo fixed > needed.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } }],
    T2: [{ shell: `echo gate > gate.txt && ${COMMIT} gate`, result: { ok: true, summary: "gate" } }],
  }, judge: { pass: true, criteria: [] }, review: { approve: true, issues: [] } }));
  const { FakeAdapter } = await import("../../src/adapters/fake.js");
  const running = runDaemon(repo, { adapters: [new FakeAdapter(scriptPath)], runId, resume: true, graphChanged: true, approvalWindowMs: 1000 });
  try {
    await expect.poll(() => journal.read().some((e) => e.event === "task-dispatch" && e.taskId === "T1" && (e.data.files as string[] | undefined)?.includes("needed.txt")), { timeout: 30_000 }).toBe(true);
    expect(engagementReleased(journal.read())).toBe(true);
    // the in-run approval that killed engagement 8: a plain approve of the parked human gate while the daemon is live
    expect(await approve([runId, "T2"], repo)).toContain("live daemon");
  } finally {
    writeFileSync(release, "go");
  }
  await running; // a sweep that throws rejects here
  const rows = journal.read();
  expect(rows.at(-1)!.event).toBe("run-end");
  const approvedAt = rows.findIndex((e) => e.event === "task-approved" && e.taskId === "T2");
  expect(approvedAt).toBeGreaterThan(-1);
  // the gate parks on dispatch until approved, so the row count before the approval is the daemon's business; after it, T2 runs
  expect(rows.slice(approvedAt).filter((e) => e.event === "task-dispatch" && e.taskId === "T2").length).toBeGreaterThanOrEqual(1);
  expect(rows.slice(approvedAt).some((e) => e.event === "worker-result" && e.taskId === "T2" && e.data.ok === true)).toBe(true);
  expect(rows.at(-1)!.data).toMatchObject({ done: ["T1", "T2", "T3"], human: [] });
}, 120_000);
function seedNeeded(repo: string): void {
  writeFileSync(join(repo, "needed.txt"), "needs repair\n");
  execFileSync("git", ["add", "needed.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "seed requested path"], { cwd: repo });
}

test('test: a review rejection reading "pins the tracked twin at .claude/skills/x/y.sh" yields the hint .claude/skills/x/y.sh only when that path exists in the tree and a printed approve command line naming it, and a hint that resolves to nothing journals the unresolved token and prints no command, so a hint glued to the preceding word or a command for a path that matches nothing fails', async () => {
  const path = ".claude/skills/x/y.sh";
  for (const mode of ["exists", "missing", "glued", "quoted"] as const) {
    const note = mode === "glued" ? `pins the tracked twin at${path}`
      : mode === "quoted" ? `pins the tracked twin at \`${path}\`` : `pins the tracked twin at ${path}`;
    const { repo, fake } = setupRepo([T("T1", { files: ["owned.txt"] })], {
      review: { approve: false, findings: [{ note, severity: "material" }] },
      consult: { action: "human", notes: "operator decides" },
      tasks: { T1: [0, 1, 2].map((i) => ({ shell: `echo ${i} > owned.txt && ${COMMIT} change`, result: { ok: true, summary: "changed" } })) },
    });
    if (mode !== "missing") {
      mkdirSync(join(repo, ".claude/skills/x"), { recursive: true });
      writeFileSync(join(repo, path), "echo twin\n");
      execFileSync("git", ["add", path], { cwd: repo });
      execFileSync("git", ["commit", "--no-gpg-sign", "-m", "tracked twin"], { cwd: repo });
    }
    const notifications: string[] = [];
    const driver = new SubprocessDriver();
    driver.notify = async (message) => { notifications.push(message); };
    const id = `run-scope-token-${mode}`;
    await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
    const events = Journal.open(repo, id).read().filter((e) => e.taskId === "T1");
    const park = events.findLast((e) => e.event === "task-human")!;
    if (mode === "exists" || mode === "quoted") {
      expect(park.data.paths).toEqual([path]);
      expect(park.data.kind).toBe("scope-request");
      const command = `tickmarkr approve ${id} T1 --files ${path}`;
      expect(park.data.approveCommand).toBe(command);
      expect(notifications.some((message) => message.split("\n").includes(command))).toBe(true);
      // The printed command is executable against this exact park and graph revision.
      await approve([id, "T1", "--files", path], repo);
      expect(loadGraph(repo).tasks[0]!.files).toContain(path);
    } else {
      expect(park.data.approveCommand).toBeUndefined();
      expect(notifications.join("\n")).not.toContain("--files");
      expect(events.some((e) => e.event === "scope-hint-unresolved"
        && (e.data.paths as string[]).includes(mode === "glued" ? `at${path}` : path))).toBe(true);
      expect(events.some((e) => e.event === "scope-request")).toBe(false);
    }
  }
}, 60_000);

test("test: a worker refusal naming one path present in the task tree plus one present only in the main checkout yields a repair hint for the first alone, so a fallback resolved against the repository root fails", async () => {
  const mainOnly = ".tickmarkr/main-only.txt";
  const blocked = { shell: "true", result: { ok: false, summary: `Blocked until needed.txt and ${mainOnly} are repaired first` } };
  const { repo, fake } = setupRepo([T("T1", { files: ["owned.txt"] })],
    { consult: { action: "human", notes: "operator decides" }, tasks: { T1: Array.from({ length: 6 }, () => blocked) } });
  seedNeeded(repo);
  // Present in the main checkout only: no task worktree ever carries it.
  writeFileSync(join(repo, mainOnly), "main checkout only\n");
  const id = "run-scope-fallback";
  await runDaemon(repo, { adapters: [fake], runId: id, approvalWindowMs: 0 });
  expect(existsSync(join(repo, mainOnly))).toBe(true);
  const park = Journal.open(repo, id).read().findLast((e) => e.taskId === "T1" && e.event === "task-human")!;
  expect(park.data.approveCommand).toBeUndefined();
  expect(park.data.reason).toMatch(/files\[\] repair hint: needed\.txt$/);
  expect(park.data.reason).not.toContain(mainOnly);
}, 60_000);

test("test: the approve command printed on a scope request park lists exactly the validated paths, so a command carrying an unresolved token fails", async () => {
  const mixed = { shell: "true", result: { ok: false, summary: "Cannot edit needed.txt or ghost/missing.txt outside files[] allowlist" } };
  const { repo, fake } = setupRepo([T("T1", { files: ["owned.txt"] })], { tasks: { T1: [mixed] } });
  seedNeeded(repo);
  const notifications: string[] = [];
  const driver = new SubprocessDriver();
  driver.notify = async (message) => { notifications.push(message); };
  const id = "run-scope-validated";
  await runDaemon(repo, { adapters: [fake], driver, runId: id, approvalWindowMs: 0 });
  const events = Journal.open(repo, id).read().filter((e) => e.taskId === "T1");
  const park = events.findLast((e) => e.event === "task-human")!;
  const command = `tickmarkr approve ${id} T1 --files needed.txt`;
  expect(park.data).toMatchObject({ kind: "scope-request", paths: ["needed.txt"], approveCommand: command });
  expect(notifications.flatMap((message) => message.split("\n")).filter((line) => line.includes("--files"))).toEqual([command]);
  expect(notifications.join("\n")).not.toMatch(/--files[^\n]*ghost/);
  expect(events.some((e) => e.event === "scope-hint-unresolved" && (e.data.paths as string[]).includes("ghost/missing.txt"))).toBe(true);
}, 60_000);
