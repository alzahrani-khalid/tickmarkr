import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { newestPark, parkToken } from "../../src/cli/commands/approve.js";
import { currentOwed } from "../../src/cli/commands/report.js";
import { daemonLiveness, readRunRecord, recordProjection, status } from "../../src/cli/commands/status.js";
import * as snapshots from "../../src/cli/commands/status-snapshot.js";
import { graphDefinitionHash, saveGraph, stateDirName } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import { decisionCommands } from "../../src/run/decision-verbs.js";
import { effectiveEvents, owedCriteria, owedSubject, parseJournalText, rangePatch, rangePatches, type JournalEvent, type OwedCheck } from "../../src/run/journal.js";
import { acquireRunLock, releaseRunLock } from "../../src/run/lock.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import { createLiveStore } from "../../src/tui/cockpit/live-store.js";
import { makeRepo, T } from "../helpers/tmprepo.js";

const { StatusSnapshotSchema, statusSnapshot } = snapshots;
const root = fileURLToPath(new URL("../..", import.meta.url));
const ts = (second: number) => new Date(Date.UTC(2026, 9, 26, 10, 0, second)).toISOString();
const event = (name: string, second: number, taskId?: string, data: Record<string, unknown> = {}): JournalEvent =>
  ({ event: name, ts: ts(second), ...(taskId ? { taskId } : {}), data });
const graph = (tasks = [T("T1")]): RunGraph => validateGraph({
  version: 1, spec: { source: "native", paths: ["spec.md"], hash: "snapshot-fixture" }, tasks,
});
const start = (g: RunGraph) => event("run-start", 0, undefined, { graphDefinitionHash: graphDefinitionHash(g), pid: process.pid });
const end = (extra: Record<string, unknown> = {}) => event("run-end", 20, undefined, {
  failed: [], human: [], blocked: [], pending: [], tipVerify: "passed", ...extra,
});
const path = (cwd: string, runId: string) => join(cwd, stateDirName(cwd), "runs", runId, "journal.jsonl");
const seed = (cwd: string, runId: string, rows: JournalEvent[]) => {
  mkdirSync(join(cwd, stateDirName(cwd), "runs", runId), { recursive: true });
  writeFileSync(path(cwd, runId), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
};
const read = async (cwd: string, runId?: string) => {
  const out = await status([...(runId ? [runId] : []), "--json"], cwd);
  expect(out.split("\n")).toHaveLength(1);
  return StatusSnapshotSchema.parse(JSON.parse(out));
};
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
afterEach(() => vi.restoreAllMocks());

test("test: the status json snapshot reads green exactly when the cockpit's lifecycle fold does for each closed green-rule run, parked, owing a waived review check, a legacy waiver of unknown debt, a fatal end, clean, and discharged after its end, so a verdict read from the run-end record fails", async () => {
  const cwd = makeRepo({ "work.txt": "before\n" });
  const g = graph();
  saveGraph(cwd, g);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  writeFileSync(join(cwd, "work.txt"), "after\n");
  git(cwd, ["add", "work.txt"]);
  git(cwd, ["commit", "--no-gpg-sign", "-m", "work"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const names = ["parked", "owing", "legacy", "fatal", "clean", "discharged"] as const;
  for (const name of names) {
    const runId = `run-${name}`;
    const obligation: OwedCheck = {
      version: 1, id: `owed-${name}`, runId, taskId: "T1", gate: "review", base, head,
      subject: owedSubject(cwd, base, head), patch: rangePatch(cwd, base, head), patches: rangePatches(cwd, base, head),
      criteria: owedCriteria(g.tasks[0]!.acceptance), files: ["work.txt"], authors: ["codex:gpt-5"],
      declared: [{ key: "codex:gpt-5", vendor: "openai" }, { key: "claude-code:sonnet", vendor: "anthropic" }],
      cause: "operator accepted review risk", evidence: "verify the exact range", disposition: "accepted-risk", known: true,
    };
    const rows = [start(g), event("task-dispatch", 1, "T1", { attempt: 0 })];
    if (["parked", "owing", "legacy", "discharged"].includes(name)) {
      rows.push(event("gate-result", 2, "T1", { gate: "review", pass: false }),
        event("task-human", 3, "T1", { kind: "gate-fail", reason: "review red" }));
      if (name !== "parked") rows.push(event("task-approved", 4, "T1", {
        release: "gate-satisfied", gate: "review", park: { line: 4, ts: ts(3) },
        ...(name === "legacy" ? {} : { obligation }),
      }), event("recheck-battery", 5, "T1"));
    }
    if (name !== "parked") rows.push(event("task-done", 6, "T1"), event("merge", 7, "T1", { commit: head }));
    rows.push(end({
      ...(name === "parked" ? { human: ["T1"] } : {}),
      ...(name === "fatal" ? { fatal: true, phase: "merge", error: "publication failed" } : {}),
      // Deliberately stale debt: even clean carries debt here; discharged still carries its old 1.
      owedChecks: { known: true, debt: name === "owing" ? 0 : 1 },
    }));
    seed(cwd, runId, rows);
    if (name === "discharged") {
      const proof = Buffer.from(JSON.stringify({
        head, mergeBase: base, green: true, files: obligation.files, criteria: obligation.criteria,
        gateRows: [{ gate: "review", pass: true, meta: { reviewer: "claude-code:sonnet", vendor: "anthropic", provider: "anthropic" } }],
      }));
      writeFileSync(join(cwd, stateDirName(cwd), "runs", runId, "proof.json"), proof);
      appendFileSync(path(cwd, runId), JSON.stringify(event("owed-check-discharged", 21, "T1", {
        ids: [obligation.id], gates: ["review"], mapping: "exact", mergeBase: base, head, criteria: obligation.criteria,
        artifactPath: "proof.json", artifactSha256: createHash("sha256").update(proof).digest("hex"),
        reviewer: { key: "claude-code:sonnet", vendor: "anthropic" }, authorChannels: [{ key: "codex:gpt-5", vendor: "openai" }],
      })) + "\n");
    }
    const snapshot = await read(cwd, runId);
    const events = effectiveEvents(parseJournalText(readFileSync(path(cwd, runId), "utf8")));
    const basis = "same-observation";
    const cockpitFold = readOperatorState({ events, graph: g, owed: { basis, fold: currentOwed(events, cwd) }, basis });
    const cockpit = createLiveStore({ cwd, runId });
    try {
      expect(snapshot.verdict.green, name).toBe(cockpit.snapshot().operator.green);
      expect(snapshot.lifecycle, name).toBe(cockpit.snapshot().operator.lifecycle);
    } finally { cockpit.dispose(); }
    expect(snapshot.verdict.green, name).toBe(cockpitFold.green);
    expect(snapshot.lifecycle, name).toBe(cockpitFold.lifecycle);
    expect(snapshot.verdict.green, name).toBe(name === "clean" || name === "discharged");
    expect(snapshot.verdict.fatal, name).toBe(name === "fatal");
    expect(snapshot.verdict.outstanding, name).toEqual(name === "legacy" || name === "fatal"
      ? { known: false, reason: expect.any(String) }
      : { known: true, debt: name === "owing" ? 1 : 0, checks: name === "owing" ? ["T1 review"] : [] });
    if (name === "discharged") {
      // Artifact changes must invalidate green even when the journal bytes stay fixed.
      writeFileSync(join(cwd, stateDirName(cwd), "runs", runId, "proof.json"), "{}");
      const changed = await read(cwd, runId);
      expect(changed.verdict.green).toBe(false);
      expect(changed.verdict.outstanding).toMatchObject({ known: false, reason: expect.stringContaining("artifact hash mismatch") });
    }
  }
});

test("test: the status json snapshot lists tasks in graph order with each task's round, budget and launches across a resume, its worker, judge and reviewer seats and its first dispatch and merge times, so a launch count that restarts at a resume or a task out of graph order fails", async () => {
  const cwd = makeRepo({ "keep.txt": "x" });
  const g = graph([T("T2", { deps: ["T1"], title: "second" }), T("T1"), T("T3")]);
  saveGraph(cwd, g);
  const rows = [start(g),
    event("task-dispatch", 1, "T1", { attempt: 0, assignment: { adapter: "codex", model: "old" } }),
    event("worker-launch", 2, "T1"), event("repair-attempt", 3, "T1", { of: 2 }),
    event("task-dispatch", 4, "T1", { attempt: 1 }), event("worker-launch", 5, "T1"),
    end({ human: ["T1"] }), event("run-resume", 21, undefined, { pid: process.pid }),
    event("task-dispatch", 22, "T1", { attempt: 0, assignment: { adapter: "codex", model: "gpt-5" } }),
    event("worker-launch", 23, "T1"), event("repair-attempt", 24, "T1", { of: 4 }),
    event("gate-result", 25, "T1", { gate: "acceptance", pass: true, invocations: [{ channel: "old:judge" }] }),
    event("gate-result", 26, "T1", { gate: "acceptance", pass: true, invocations: [{ channel: "retry:first" }, { channel: "claude-code:sonnet" }] }),
    event("gate-result", 27, "T1", { gate: "review", pass: true, reviewer: "old:reviewer" }),
    event("gate-result", 28, "T1", { gate: "review", pass: true, reviewer: "opencode:reviewer" }),
    event("task-done", 29, "T1"), event("merge", 30, "T1"),
    event("task-dispatch", 31, "T2", { attempt: 2 }), event("worker-launch", 32, "T2"),
  ];
  seed(cwd, "run-resumed", rows);
  // Blank and torn physical lines still advance sequence; neither is a worker launch.
  appendFileSync(path(cwd, "run-resumed"), "\n{torn\n");
  const snapshot = await read(cwd, "run-resumed");
  expect(snapshot.sequence).toBe(rows.length + 2);
  expect(snapshot.tasks.map(task => task.id)).toEqual(["T2", "T1", "T3"]);
  const [t2, t1, t3] = snapshot.tasks;
  expect(t1).toMatchObject({
    tries: { round: 1, budget: 5, launches: 3 },
    seats: { worker: "codex:gpt-5", judge: "claude-code:sonnet", reviewer: "opencode:reviewer" },
    startedAt: ts(1), endedAt: ts(30), state: "merged", gates: { acceptance: "passed", review: "passed" },
  });
  expect(t2).toMatchObject({ title: "second", deps: ["T1"], tries: { round: 3, budget: 3, launches: 1 }, startedAt: ts(31), endedAt: null });
  expect(t3).toMatchObject({ tries: { round: null, budget: 3, launches: 0 }, seats: { worker: null, judge: null, reviewer: null }, startedAt: null, endedAt: null });
  const projection = recordProjection(readRunRecord(cwd, g, "run-resumed"), g, () => true);
  for (const task of snapshot.tasks) {
    const summary = projection.summaries.get(task.id)!;
    expect(task.now).toEqual({ phase: summary.phase, since: summary.lastEvidenceAt, blocker: summary.blocker?.kind ?? null, nextAction: summary.blocker?.nextAction ?? null });
  }
  expect(snapshot.daemon).toBe(daemonLiveness(rows).state);
});

test("test: a parked task's snapshot entry carries its park token and the release commands the release-command helper returns, and an open approval window carries its closing time while an expired one reads null, so a park without commands or a window outliving its expiry fails", async () => {
  const cwd = makeRepo({ "keep.txt": "x" });
  const g = graph();
  saveGraph(cwd, g);
  const rows = [start(g), event("task-dispatch", 1, "T1"),
    event("gate-result", 2, "T1", { gate: "review", pass: false }),
    event("task-human", 3, "T1", { kind: "gate-fail", reason: "review needs a decision" }),
    event("approval-window-start", 4, undefined, { windowMs: 60_000, parked: ["T1"] }),
  ];
  seed(cwd, "run-park", rows);
  // Preserve physical identity through a blank line before the park.
  const raw = readFileSync(path(cwd, "run-park"), "utf8").split("\n");
  raw.splice(2, 0, "");
  writeFileSync(path(cwd, "run-park"), raw.join("\n"));
  const parsed = parseJournalText(readFileSync(path(cwd, "run-park"), "utf8"));
  const park = newestPark(parsed, "T1")!;
  const snapshot = await read(cwd, "run-park");
  expect(snapshot.parks).toEqual([{
    taskId: "T1", kind: "gate-fail", reason: "review needs a decision", token: parkToken(park),
    ...decisionCommands("run-park", "T1", park),
  }]);
  expect(snapshot.parks[0]!.commands.map(command => command.verb)).toEqual(["waive", "uphold", "recheck"]);
  expect(snapshot.parks[0]!.token).toBe(`5@${ts(3)}`);
  expect(snapshot.approvalWindow).toEqual({ opensAt: ts(4), closesAt: ts(64), parked: ["T1"] });
  expect(snapshot.tasks[0]!.now.nextAction).toContain(snapshot.parks[0]!.commands[0]!.command);
  for (const closing of [event("approval-window-expired", 5), event("task-dispatch", 5, "T1"), end(),
    event("task-approved", 5, "T1", { park: { line: 5, ts: ts(3) } })]) {
    writeFileSync(path(cwd, "run-park"), raw.join("\n") + JSON.stringify(closing) + "\n");
    expect((await read(cwd, "run-park")).approvalWindow, closing.event).toBeNull();
  }
  // A refused decision closes nothing; the same effective journal drives the window and task state.
  writeFileSync(path(cwd, "run-park"), raw.join("\n") + JSON.stringify(event("task-approved", 5, "T1", { park: { line: 999, ts: ts(3) } })) + "\n");
  expect((await read(cwd, "run-park")).approvalWindow).not.toBeNull();
});

test("test: the shipped status schema file equals the schema the snapshot module defines, every snapshot the status command prints validates against it, and a snapshot missing its verdict is refused before printing, so a stale schema file or an unvalidated print fails", async () => {
  const shipped = JSON.parse(readFileSync(join(root, "schema/status.schema.json"), "utf8"));
  const expected = z.toJSONSchema(StatusSnapshotSchema, { io: "input", unrepresentable: "any" });
  expect(shipped).toEqual({ ...expected, $comment: "Version 1 status snapshot; verdict and lifecycle use the shared operator fold with current owed checks." });
  const cwd = makeRepo({ "keep.txt": "x" });
  const g = graph();
  saveGraph(cwd, g);
  seed(cwd, "run-schema", [start(g), event("task-done", 1, "T1"), event("merge", 2, "T1"), end()]);
  const snapshot = await read(cwd, "run-schema");
  const printed = execFileSync(process.execPath, [join(root, "dist/cli/index.js"), "status", "--json"], { cwd, encoding: "utf8" });
  expect(printed.trim().split("\n")).toHaveLength(1);
  expect(StatusSnapshotSchema.parse(JSON.parse(printed))).toMatchObject({ runId: "run-schema", verdict: { green: true } });
  expect(StatusSnapshotSchema.safeParse({ ...snapshot, extra: true }).success).toBe(false);
  expect(StatusSnapshotSchema.safeParse({ ...snapshot, verdict: { ...snapshot.verdict, extra: true } }).success).toBe(false);
  const { verdict: _verdict, ...missingVerdict } = snapshot;
  expect(StatusSnapshotSchema.safeParse(missingVerdict).success).toBe(false);
  vi.spyOn(snapshots, "statusSnapshot").mockReturnValue(missingVerdict as snapshots.StatusSnapshot);
  const writes = vi.spyOn(process.stdout, "write");
  await expect(status(["--json"], cwd)).rejects.toThrow(/verdict/u);
  expect(writes).not.toHaveBeenCalled();
});

test("test: status with the json flag and no run named prints the newest run's snapshot and refuses the json flag beside the watch flag, while status without it prints the same text frame as before, so a flag that changes the default output fails", async () => {
  const cwd = makeRepo({ "keep.txt": "x" });
  const g = graph();
  saveGraph(cwd, g);
  const rows = [start(g), event("task-done", 1, "T1"), event("merge", 2, "T1"), end()];
  seed(cwd, "run-001", rows);
  seed(cwd, "run-002", rows);
  const text = await status([], cwd, { now: () => Date.parse(ts(30)) });
  expect(text).toBe(await status(["run-002"], cwd, { now: () => Date.parse(ts(30)) }));
  expect(text).toContain("run-002");
  expect(text).toContain("phase terminal");
  expect(() => JSON.parse(text)).toThrow();
  expect((await read(cwd)).runId).toBe("run-002");
  expect((await read(cwd, "run-001")).runId).toBe("run-001");
  // Machine default stays newest even while the live text board follows an older locked run.
  acquireRunLock(cwd, "run-001");
  try { expect((await read(cwd)).runId).toBe("run-002"); } finally { releaseRunLock(cwd, "run-001"); }
  expect(await status([], cwd, { now: () => Date.parse(ts(30)) })).toBe(text);
  for (const argv of [["--json", "--watch"], ["--watch", "--json", "--oneline"], ["--json", "--watch", "--events"]]) {
    await expect(status(argv, cwd)).rejects.toThrow(/--json.*--watch/u);
  }
  await expect(status(["run-missing", "--json"], cwd)).rejects.toThrow(/no journal for run-missing/u);
  await expect(status(["../bad", "--json"], cwd)).rejects.toThrow();
  const empty = makeRepo({ "keep.txt": "x" });
  saveGraph(empty, g);
  expect(() => statusSnapshot(empty)).toThrow(/no runs yet/u);
});
