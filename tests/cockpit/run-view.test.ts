import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  approvalEnactment,
  approvalRunOwner,
  approve,
  DECISION_VERBS,
  permittedDecisionVerbs,
  releaseForDecision,
  type DecisionVerb,
} from "../../src/cli/commands/approve.js";
import { formatOwnedName } from "../../src/drivers/types.js";
import { graphDefinitionHash, tickmarkrDir } from "../../src/graph/graph.js";
import { GATE_NAMES, validateGraph } from "../../src/graph/schema.js";
import { Journal, PARK_KINDS, type JournalEvent } from "../../src/run/journal.js";
import { readOperatorState } from "../../src/run/operator-state.js";
import {
  applyDecisionKey,
  decisionArgv,
  decisionConfirmLines,
  decisionReceiptLines,
  deriveRunDecisions,
  executeDecision,
  initialDecisionSession,
  previewDecision,
  withDecisionPreview,
  withDecisionReceipt,
  type DecisionPreview,
} from "../../src/tui/cockpit/decision-actions.js";
import { deriveRunCockpitData } from "../../src/tui/cockpit/derive.js";
import { runLiveCockpit } from "../../src/tui/cockpit/live.js";
import { deriveRunViewRows, taskProjectionText } from "../../src/tui/cockpit/run-cockpit.js";
import type { ShellDelivery } from "../../src/tui/cockpit/live-runtime.js";
import {
  applyRunViewKey,
  evidenceLookup,
  initialRunViewSession,
  paneLocator,
  projectionLine,
  projectRunTasks,
  runGateCells,
  RunView,
  STALL_MARKER,
  VERDICT_WINDOW,
  type RunEvidenceRow,
  type RunViewSession,
} from "../../src/tui/cockpit/run-view.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { ttyInput } from "../helpers/tty-input.js";

/* ------------------------------------------------------------------------ */
/* Harness: a temp repo per journal, C2's reader over the file, an Ink frame. */
/* ------------------------------------------------------------------------ */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-run-view-"));
  dirs.push(root);
  return root;
}

const ASSIGNMENT = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } as const;

const graphOf = (ids: readonly string[], deps: Record<string, string[]> = {}) => validateGraph({
  version: 1, spec: { paths: ["fixture.md"], hash: "fixture-run-view", source: "native" },
  tasks: ids.map((id) => ({ id, title: `Task ${id}`, goal: "Synthetic", shape: "implement", complexity: 1, deps: deps[id] ?? [], files: [], acceptance: ["fixture"] })),
});

/** The file as C2 reads it: physical lines, and the pure snapshot fold over them. */
function readRun(root: string, runId: string, graph?: ReturnType<typeof graphOf>) {
  const tracked = Journal.open(root, runId).readTracked();
  const events = tracked.map((row) => row.raw as JournalEvent);
  const rows: RunEvidenceRow[] = tracked.map((row) => ({ line: row.sourceIndex + 1, event: row.raw as JournalEvent }));
  return { events, rows, snapshot: readOperatorState({ events, graph, sequence: 7 }) };
}

const journalEvents = (root: string, runId: string): JournalEvent[] => readFileSync(join(tickmarkrDir(root), "runs", runId, "journal.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as JournalEvent);
const approvals = (root: string, runId: string, taskId: string): JournalEvent[] => journalEvents(root, runId).filter((e) => e.event === "task-approved" && e.taskId === taskId);

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function renderComponent(node: ReactNode, columns = 150): Promise<string> {
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true; output.columns = columns; output.rows = 80;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => { painted = resolve; });
  const app = render(node, { stdout: output as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, onRender: painted });
  await firstPaint;
  const frame = stripAnsi(writes.at(-1) ?? "").trimEnd();
  app.unmount();
  return frame;
}


async function drawRun(root: string, runId: string, session: RunViewSession, columns = 150, graph = graphOf([])) {
  const { rows, snapshot } = readRun(root, runId, graph);
  const decisions = deriveRunDecisions(Journal.open(root, runId), graph);
  return renderComponent(createElement(RunView, { snapshot, rows, graph, decisions, session, columns, run: approvalRunOwner(root, runId) }), columns);
}

const key = (input: string, k: Record<string, boolean> = {}) => ({ input, key: k });
const DOWN = key("", { downArrow: true });
const ENTER = key("", { return: true });
const PAGE_DOWN = key("", { pageDown: true });

/* ------------------------------------------------------------------------ */
/* Parks of every kind, written the way the daemon writes them.              */
/* ------------------------------------------------------------------------ */

function park(j: Journal, taskId: string, kind: string, opts: { failedGate?: string; reason?: string; dispatch?: boolean } = {}): void {
  if (opts.dispatch !== false) j.append("task-dispatch", taskId, { assignment: ASSIGNMENT, attempt: 0 });
  if (opts.failedGate) j.append("gate-result", taskId, { gate: opts.failedGate, pass: false, ...(kind === "infra" ? { infra: true } : {}), details: `${opts.failedGate} red` });
  j.append("task-human", taskId, { kind, reason: opts.reason ?? `${kind} park` });
}

describe("C4 — Run and validated decisions", () => {
  test("a mounted Run scope request shows its exact files approval diagnostic and cannot open a bare approve confirmation", async () => {
    const root = repo();
    const runId = "run-scope-view";
    const graph = graphOf(["T1", "T2"]);
    const journal = Journal.create(root, runId);
    journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
    const command = `tickmarkr approve ${runId} T1 --files src/needed.ts`;
    journal.append("task-human", "T1", { kind: "scope-request", paths: ["src/needed.ts"], reason: "outside files[]", approveCommand: command });
    journal.append("task-human", "T2", { kind: "human-gate", reason: "human approval" });
    const decisions = deriveRunDecisions(journal, graph);
    const session = initialRunViewSession();
    const frame = await drawRun(root, runId, session, 150, graph);
    expect(frame).toContain(command);
    expect(decisions[0]!.verbs).toEqual([]);
    expect(decisions[1]!.verbs).toEqual(["approve"]);
    const { snapshot } = readRun(root, runId, graph);
    const pressed = applyRunViewKey(session, key("a"), { tasks: snapshot.tasks, decisions, verdictLines: 0 });
    expect(pressed.session.decisions.confirming).toBeNull();
    expect(journal.read().some((e) => e.event === "task-approved")).toBe(false);
  });

  test("The Run body consumed by C1 shows every matching graph task, its recorded attempt/path/pane/alarm and current-attempt build test lint evidence scope acceptance review cells in declaration order. Evidence-backed passed, failed, running, not-run, disabled and unknown remain distinct, with inherited/satisfied labels and full 200-line verdict paging. Baseline-forgiven build/test/lint and infra/work outcomes retain their evidence labels. Acceptance/review are concurrent and optional. An earlier-attempt pass, missing reviewer tier inferred from policy, or passing prose containing infrastructure admitted by the infra-failure filter fails.", async () => {
    const root = repo();
    const runId = "run-view-matrix";
    const graph = graphOf(["T1", "T2", "T3", "T4", "T5", "T6", "T7"], { T3: ["T2"] });
    const j = Journal.create(root, runId);
    j.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
    // T1: every gate green on attempt 0, build forgiven by baseline, a 200-line review verdict with no tier metadata.
    j.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
    j.append("gate-result", "T1", { gate: "build", pass: true, details: "exit 1 but only pre-existing failures (forgiven)" });
    for (const gate of ["test", "lint", "evidence", "scope", "acceptance"]) j.append("gate-result", "T1", { gate, pass: true, details: `${gate} ok` });
    const verdict = Array.from({ length: 200 }, (_, i) => `verdict line ${i + 1}`).join("\n");
    j.append("gate-result", "T1", { gate: "review", pass: true, details: verdict, reviewer: "fake:rev-1", vendor: "fake" });
    j.append("merge", "T1", { commit: "abc" });
    // T2: an infra death on attempt 0, parked on infra — the current attempt's evidence.
    j.append("task-dispatch", "T2", { assignment: ASSIGNMENT, attempt: 0 });
    j.append("gate-result", "T2", { gate: "build", pass: true, details: "ok" });
    j.append("gate-result", "T2", { gate: "test", pass: false, infra: true, retryable: true, details: "signal exit — the runner never completed a suite" });
    j.append("task-human", "T2", { kind: "infra", reason: "signal exit" });
    // T4: a PASSING review whose prose mentions infrastructure; a policy-disabled acceptance; a scope row with no verdict.
    j.append("task-dispatch", "T4", { assignment: ASSIGNMENT, attempt: 0 });
    j.append("gate-result", "T4", { gate: "review", pass: true, details: "reviewed the infrastructure module; infrastructure looks fine — approve", reviewer: "fake:rev-2" });
    j.append("gate-result", "T4", { gate: "acceptance", disabled: true, details: "acceptance disabled by policy" });
    j.append("gate-result", "T4", { gate: "scope", details: "no verdict stated" });
    // T5: three green gates, then reused after a resume — inherited, not re-run.
    j.append("task-dispatch", "T5", { assignment: ASSIGNMENT, attempt: 0 });
    for (const gate of ["build", "test", "lint"]) j.append("gate-result", "T5", { gate, pass: true, details: `${gate} ok` });
    // T6: review red, parked, then waived — satisfied by approval, still a recorded failure.
    j.append("task-dispatch", "T6", { assignment: ASSIGNMENT, attempt: 0 });
    j.append("gate-result", "T6", { gate: "review", pass: false, details: "requested changes" });
    j.append("task-human", "T6", { kind: "gate-fail", reason: "review round cap" });
    j.append("task-approved", "T6", { by: "op", via: "cli", release: "gate-satisfied", gate: "review" });
    // T7: attempt 0 passed build then died; attempt 1 is running build — the earlier pass must not show.
    j.append("task-dispatch", "T7", { assignment: ASSIGNMENT, attempt: 0 });
    j.append("gate-result", "T7", { gate: "build", pass: true, details: "ok" });
    j.append("task-failed", "T7", { reason: "worker died" });
    j.append("task-dispatch", "T7", { assignment: ASSIGNMENT, attempt: 1 });
    j.append("gate-start", "T7", { gate: "build" });
    j.append("run-end", undefined, { done: ["T1"], failed: [], human: ["T2"], blocked: ["T3"], pending: ["T4", "T5", "T6", "T7"], tipVerify: "passed" });
    j.append("run-resume", undefined, {});
    for (const gate of ["build", "test", "lint"]) j.append("gate-reused", "T5", { gate, commit: "abc" });
    j.append("gate-start", "T5", { gate: "evidence" });

    const { rows, snapshot } = readRun(root, runId, graph);
    expect(snapshot.comparable).toBe(true);
    const lookup = evidenceLookup(rows);
    const cellsOf = (id: string) => runGateCells(snapshot.tasks.find((t) => t.id === id)!, lookup, rows);
    const letters = (id: string) => cellsOf(id).map((c) => c.letter).join("");

    // Declaration order, current attempt only: seven cells per task, every state distinct.
    expect(cellsOf("T1").map((c) => c.gate)).toEqual([...GATE_NAMES]);
    expect(letters("T1")).toBe("PPPPPPP");
    expect(letters("T2")).toBe("PF-----");
    expect(letters("T3")).toBe("-------"); // never dispatched
    expect(letters("T4")).toBe("----?DP"); // unknown scope, disabled acceptance, passed review
    expect(letters("T5")).toBe("PPPR---"); // inherited greens, evidence running
    expect(letters("T6")).toBe("------F"); // waived, still a recorded failure
    expect(letters("T7")).toBe("R------"); // attempt 1: the attempt-0 build pass is gone

    // Evidence labels survive on the cells: forgiveness, infra vs work, inherited, satisfied, tiers unknown.
    const t1 = Object.fromEntries(cellsOf("T1").map((c) => [c.gate, c]));
    expect(t1.build!.labels).toContain("baseline-forgiven (pre-existing failures)");
    expect(t1.build!.outcomeClass).toBe("pass");
    expect(t1.review!.labels).toEqual(expect.arrayContaining(["reviewer fake:rev-1", "reviewer tier unknown", "author tier unknown", "reviewer floor unknown"]));
    expect(t1.review!.verdict).toHaveLength(200);
    const t2 = Object.fromEntries(cellsOf("T2").map((c) => [c.gate, c]));
    expect(t2.test!.outcomeClass).toBe("infra failure");
    expect(t2.test!.labels[0]).toMatch(/^infra failure — .*\(retryable\)$/);
    expect(t2.lint!.labels).toEqual(["not run"]);
    const t4 = Object.fromEntries(cellsOf("T4").map((c) => [c.gate, c]));
    expect(t4.review!.outcomeClass).toBe("pass"); // the word infrastructure is prose, not an infra verdict
    expect(t4.acceptance!.labels).toEqual(["disabled by policy"]);
    expect(t4.scope!.outcomeClass).toBe("unknown");
    expect(t4.scope!.labels[0]).toMatch(/^unknown — /);
    const lineOf = (pick: (e: JournalEvent) => boolean) => rows.find((r) => r.event !== undefined && pick(r.event))!.line;
    expect(cellsOf("T5")[0]!.labels).toContain(`inherited from abc · #L${lineOf((e) => e.event === "gate-reused" && e.taskId === "T5" && e.data.gate === "build")}`);
    expect(cellsOf("T5")[3]!.labels).toEqual(["running"]);
    expect(cellsOf("T6")[6]!.labels).toContain(`satisfied by approval #L${lineOf((e) => e.event === "task-approved" && e.taskId === "T6")}`);
    expect(cellsOf("T6")[6]!.outcomeClass).toBe("work failure");
    expect(cellsOf("T7").filter((c) => c.state === "passed")).toEqual([]);
    expect(cellsOf("T7")[0]!.labels).toEqual(["running"]);

    // C2 retains only a bounded tail. Both later markers remain discoverable when they and their
    // evidence have been evicted, using the production-shaped physical-line page accessor.
    const retainedTail = rows.slice(-1);
    const pagedLookup = evidenceLookup(retainedTail, (firstLine, count = 32) =>
      rows.filter((row) => row.line >= firstLine).slice(0, count));
    expect(runGateCells(snapshot.tasks.find((t) => t.id === "T5")!, pagedLookup, retainedTail)[0]!.labels)
      .toContain(`inherited from abc · #L${lineOf((e) => e.event === "gate-reused" && e.taskId === "T5" && e.data.gate === "build")}`);
    expect(runGateCells(snapshot.tasks.find((t) => t.id === "T6")!, pagedLookup, retainedTail)[6]!.labels)
      .toContain(`satisfied by approval #L${lineOf((e) => e.event === "task-approved" && e.taskId === "T6")}`);

    // A routine live append invalidates C2's paging stamp. The selected cells degrade to their
    // existing unavailable label instead of throwing during render, and a batch-gap lookup does too.
    const changedPage = () => { throw new Error("journal changed; refresh before paging"); };
    const staleLookup = evidenceLookup(retainedTail, changedPage);
    expect(() => runGateCells(snapshot.tasks.find((t) => t.id === "T1")!, staleLookup, retainedTail)).not.toThrow();
    expect(runGateCells(snapshot.tasks.find((t) => t.id === "T1")!, staleLookup, retainedTail)[0]!.labels)
      .toEqual([`evidence #L${lineOf((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "build")} unavailable`]);

    // The outcome selector classifies rows; a passing review mentioning infrastructure never enters the infra filter.
    const infraOnly = (id: string) => cellsOf(id).filter((c) => c.outcomeClass === "infra failure").map((c) => c.gate);
    expect(infraOnly("T2")).toEqual(["test"]);
    expect(infraOnly("T4")).toEqual([]);

    // The mounted body: every matching graph task, recorded attempt/path/pane/alarm, legend, distinct words.
    const opening = initialRunViewSession();
    const frame = await drawRun(root, runId, opening, 150, graph);
    for (const id of graph.tasks.map((t) => t.id)) expect(frame).toContain(`${id} `);
    // BD-1: the board rows — id, area, deps, title, seven ✔ ✖ · cells, channel, attempts, note.
    const row = (id: string) => frame.split("\n").find((line) => /^(?: {4}| {2}❯ )/u.test(line) && line.slice(4).startsWith(`${id} `)) ?? "";
    expect(row("T1")).toMatch(/^ {2}❯ T1 {3}— {15}— {13}Task T1 .*✔ {2}✔ {2}✔ {2}✔ {2}✔ {2}✔ {2}✔ {4}fake:fake-1 +1 *$/u);
    expect(row("T2")).toMatch(/✔ {2}✖ {2}· {2}· {2}· {2}· {2}· {4}fake:fake-1 +1 +✖ test · 2\/7 gates run$/u);
    expect(row("T3")).toMatch(/T3 {3}— {15}T2 {12}Task T3 .*· {2}· {2}· {2}· {2}· {2}· {2}· {4}— +0 +waiting on T2$/u);
    expect(row("T4")).toMatch(/· {2}· {2}· {2}· {2}\? {2}D {2}✔ {4}fake:fake-1 +1 +1\/7 gates run$/u);
    expect(row("T5")).toMatch(/✔ {2}✔ {2}✔ {2}R {2}· {2}· {2}· {4}fake:fake-1 +1 +running · evidence$/u);
    expect(row("T7")).toMatch(/R {2}· {2}· {2}· {2}· {2}· {2}· {4}fake:fake-1 +2 +running · build$/u);
    expect(frame).toContain("RUN / RUNNING · 1/7 merged | human T2 | blocked T3 | pending T4,T5,T6,T7 | current-cycle tip PENDING | RUNNING | matching graph");
    expect(row("T6")).toMatch(/· {2}· {2}· {2}· {2}· {2}· {2}✖ {4}fake:fake-1 +1 +✖ review · 1\/7 gates run$/u);
    expect(frame).toContain("gates left→right in declaration order");
    expect(frame).toContain("─ not declared (acceptance and review are the optional two)");
    expect(frame).toContain("WHERE THE EFFORT WENT");
    expect(frame).toContain(`path /wt/T1 · pane pane-T1 · alarm 600000ms · merged #L${lineOf((e) => e.event === "merge" && e.taskId === "T1")}`);
    expect(frame).toContain("reviewer tier unknown");
    expect(frame).toContain(`VERDICT / review #L${lineOf((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review")} · lines 1–10 of 200`);
    expect(frame).toContain("   1 verdict line 1");
    expect(frame).not.toContain("verdict line 200");
    const t2Frame = await drawRun(root, runId, { ...opening, selection: 1 }, 150, graph);
    expect(t2Frame).toContain("path unknown · pane unknown · alarm unknown");
    expect(t2Frame).toContain("infra failure — signal exit");
    expect(t2Frame).toContain("PARK / T2");
    expect(t2Frame).toContain("blocks T3");

    // Paging reaches the 200th verdict line; the window never claims lines it does not draw.
    let session = opening;
    const ctx = { tasks: snapshot.tasks, decisions: [], verdictLines: 200 };
    for (let i = 0; i < 19; i++) session = applyRunViewKey(session, PAGE_DOWN, ctx).session;
    expect(session.verdictOffset).toBe(190);
    expect(applyRunViewKey(session, PAGE_DOWN, ctx).session.verdictOffset).toBe(200 - VERDICT_WINDOW);
    const paged = await drawRun(root, runId, session, 150, graph);
    expect(paged).toContain("lines 191–200 of 200");
    expect(paged).toContain(" 200 verdict line 200");

    // The infra filter admits T2's test row and nothing of T4; the pass filter shows T4's review.
    const infraFilter = { ...opening, selection: 1, outcomeFilter: "infra failure" as const };
    expect(await drawRun(root, runId, infraFilter, 150, graph)).toContain("1 of 7 gates shown");
    const t4Infra = await drawRun(root, runId, { ...infraFilter, selection: 3 }, 150, graph);
    expect(t4Infra).toContain("0 of 7 gates shown");
    expect(t4Infra).not.toContain("P review     passed");
    expect(await drawRun(root, runId, { ...infraFilter, selection: 3, outcomeFilter: "pass" }, 150, graph)).toContain("P review     passed · reviewer fake:rev-2");
    let cycled = opening;
    for (let i = 0; i < 5; i++) cycled = applyRunViewKey(cycled, key("x"), ctx).session;
    expect(cycled.outcomeFilter).toBe("all");

    // A digit is data here, never a view switch; ↑↓ stay within the task list; lines fit the column.
    expect(applyRunViewKey(opening, key("1"), ctx).session).toEqual(opening);
    expect(applyRunViewKey(opening, key("", { upArrow: true }), ctx).session.selection).toBe(0);
    for (const columns of [80, 120]) {
      for (const line of (await drawRun(root, runId, { ...opening, selection: 1 }, columns, graph)).split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(columns);
    }
  });

  test("Run confirmation invokes exported production approve for FINAL §3.3’s closed park-kind set and reads exactly its appended decision: human/attempt-cap/other approve, infra approve or recheck, review failure waive/uphold/recheck, other gate failure waive/recheck, missing-gate or tombstone diagnostic. Tests cover infra recheck and the neighbouring human uphold refusal, gate-specific waiver and recheck satisfying none. A release appended by another actor after preview produces a refreshed refusal rather than a duplicate append. Bypassing command validation or fabricating a permitted verb fails.", async () => {
    // Every member of the daemon's closed park-kind set, in the shapes FINAL §3.3 names.
    const cases: { name: string; kind: string; failedGate?: string; reason?: string; verbs: readonly DecisionVerb[] }[] = [
      { name: "review gate-fail", kind: "gate-fail", failedGate: "review", verbs: ["waive", "uphold", "recheck"] },
      { name: "scope gate-fail", kind: "gate-fail", failedGate: "scope", verbs: ["waive", "recheck"] },
      { name: "gate-fail without failed-gate evidence", kind: "gate-fail", verbs: [] },
      { name: "infra", kind: "infra", failedGate: "test", verbs: ["approve", "recheck"] },
      // OBS-1007: a cap trip is re-gated under a raised cap, never re-bought — recheck is its ONLY verb
      { name: "diff-cap", kind: "diff-cap", failedGate: "review", verbs: ["recheck"] },
      { name: "tombstone", kind: "human-gate", reason: "T1 — tombstone: retained only so the engagement resumes", verbs: [] },
      { name: "scope-request", kind: "scope-request", verbs: [] },
      ...PARK_KINDS.filter((k) => k !== "gate-fail" && k !== "infra" && k !== "scope-request" && k !== "diff-cap").map((kind) => ({ name: kind, kind, verbs: ["approve"] as const })),
    ];
    for (const c of cases) {
      const root = repo();
      const runId = `run-${c.name.replace(/[^a-z]+/gu, "-")}`;
      park(Journal.create(root, runId), "T1", c.kind, { failedGate: c.failedGate, reason: c.reason, dispatch: c.kind !== "human-gate" });
      const [decision] = deriveRunDecisions(Journal.open(root, runId));
      expect(decision, c.name).toBeDefined();
      expect(decision!.verbs, c.name).toEqual(c.verbs);
      expect(permittedDecisionVerbs(decision!.park)).toEqual(c.verbs);
      if (c.verbs.length === 0) {
        expect(decision!.diagnostic, c.name).toMatch(/tombstone|no failed gate result|scope-request requires/);
        // No fabricated verb: every verb is refused before the command, and the command refuses a forced argv.
        for (const verb of DECISION_VERBS) expect(previewDecision({ verb, taskId: "T1" }, { cwd: root, runId, by: "operator" }).ok, `${c.name} ${verb}`).toBe(false);
        // The production command itself, called directly with every verb's argv, refuses too.
        for (const verb of DECISION_VERBS) {
          await expect(approve(decisionArgv({ verb, taskId: "T1" }, { runId, by: "operator" }), root), `${c.name} ${verb} via command`).rejects.toThrow(/permanent by design; no verb releases it|no failed gate result|applies to a (review )?gate-fail|requires --files/);
        }
        expect(approvals(root, runId, "T1")).toEqual([]);
        continue;
      }
      // Each permitted verb, on a fresh copy of the park, appends exactly the release the command owns.
      for (const verb of c.verbs) {
        const verbRoot = repo();
        park(Journal.create(verbRoot, runId), "T1", c.kind, { failedGate: c.failedGate, reason: c.reason, dispatch: c.kind !== "human-gate" });
        const preview = previewDecision({ verb, taskId: "T1" }, { cwd: verbRoot, runId, by: "operator" });
        expect(preview.ok, `${c.name} ${verb}`).toBe(true);
        if (!preview.ok) continue;
        const receipt = await executeDecision(preview.preview, { cwd: verbRoot });
        expect(receipt.ok, `${c.name} ${verb}`).toBe(true);
        const appended = approvals(verbRoot, runId, "T1");
        expect(appended).toHaveLength(1);
        expect(appended[0]!.data.release).toBe(releaseForDecision(verb, decision!.park));
        expect(appended[0]!.data.by).toBe("operator");
        if (receipt.ok) {
          expect(receipt.appended.event).toEqual(appended[0]);
          expect(receipt.appended.line).toBe(journalEvents(verbRoot, runId).length);
          expect(receipt.release).toBe(appended[0]!.data.release);
        }
        const satisfied = Journal.open(verbRoot, runId).replaySatisfiedGates();
        // Waive satisfies only the named gate; approve, uphold and recheck satisfy none.
        expect([...satisfied], `${c.name} ${verb}`).toEqual(verb === "waive" ? [["T1", c.failedGate]] : []);
        expect(Journal.open(verbRoot, runId).replayStatuses().get("T1")).toBe("pending");
      }
    }

    // Infra recheck beside its neighbour: uphold on a human gate is refused, at the boundary and by the command.
    const root = repo();
    const runId = "run-infra-and-human";
    const j = Journal.create(root, runId);
    park(j, "T1", "infra", { failedGate: "test", reason: "signal exit" });
    park(j, "T2", "human-gate", { dispatch: false });
    const infra = previewDecision({ verb: "recheck", taskId: "T1" }, { cwd: root, runId, by: "operator" });
    expect(infra.ok).toBe(true);
    const infraReceipt = await executeDecision((infra as { preview: DecisionPreview }).preview, { cwd: root });
    expect(infraReceipt.ok).toBe(true);
    if (infraReceipt.ok) expect(infraReceipt.message).toContain("infra park");
    expect(approvals(root, runId, "T1")[0]!.data.release).toBe("recheck");
    expect([...Journal.open(root, runId).replaySatisfiedGates()]).toEqual([]);
    const humanUphold = previewDecision({ verb: "uphold", taskId: "T2" }, { cwd: root, runId, by: "operator" });
    expect(humanUphold.ok).toBe(false);
    if (!humanUphold.ok) expect(humanUphold.refusal).toMatch(/uphold is not a decision for T2's human-gate park/);
    // Bypassing the boundary's validation: a forged preview still reaches only the production command, which refuses.
    const humanApprove = previewDecision({ verb: "approve", taskId: "T2" }, { cwd: root, runId, by: "operator" }) as { ok: true; preview: DecisionPreview };
    const forged: DecisionPreview = { ...humanApprove.preview, command: { verb: "uphold", taskId: "T2" }, argv: [runId, "T2", "--uphold", "--by", "operator"] };
    const forgedReceipt = await executeDecision(forged, { cwd: root });
    expect(forgedReceipt.ok).toBe(false);
    expect(approvals(root, runId, "T2")).toEqual([]);
    const bypass = await executeDecision({ ...humanApprove.preview, argv: [runId, "T2", "--uphold", "--by", "operator"] }, { cwd: root });
    expect(bypass.ok).toBe(false);
    if (!bypass.ok) expect(bypass.refusal).toMatch(/does not match the confirmed approve/);
    expect(approvals(root, runId, "T2")).toEqual([]);
    // A forged preview naming one permitted verb while its argv carries another permitted verb: refused
    // before the command, so the journal never gains the release the argv asked for.
    const reviewRoot = repo();
    park(Journal.create(reviewRoot, runId), "T3", "gate-fail", { failedGate: "review", reason: "review round cap" });
    const recheck = previewDecision({ verb: "recheck", taskId: "T3" }, { cwd: reviewRoot, runId, by: "operator" }) as { ok: true; preview: DecisionPreview };
    const swapped = await executeDecision({ ...recheck.preview, argv: [runId, "T3", "--waive", "--by", "operator"] }, { cwd: reviewRoot });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.refusal).toMatch(/does not match the confirmed recheck/);
    const otherActor = await executeDecision({ ...recheck.preview, argv: [runId, "T3", "--recheck", "--by", "impostor"] }, { cwd: reviewRoot });
    expect(otherActor.ok).toBe(false);
    expect(approvals(reviewRoot, runId, "T3")).toEqual([]);
    expect([...Journal.open(reviewRoot, runId).replaySatisfiedGates()]).toEqual([]);
    // A fabricated verb never becomes argv.
    expect(() => decisionArgv({ verb: "force" as DecisionVerb, taskId: "T2" }, { runId, by: "operator" })).toThrow(/not a decision verb/);
    expect(previewDecision({ verb: "force" as DecisionVerb, taskId: "T2" }, { cwd: root, runId, by: "operator" }).ok).toBe(false);

    // "tombstone" in an ordinary title is prose, not the explicit declaration-retirement grammar.
    const proseRoot = repo();
    park(Journal.create(proseRoot, "run-tombstone-prose"), "T1", "human-gate", {
      dispatch: false,
      reason: 'humanGate: "v1.25 T3 tombstone stale cursor-agent xhigh seeds" requires approval before dispatch',
    });
    const [proseDecision] = deriveRunDecisions(Journal.open(proseRoot, "run-tombstone-prose"));
    expect(proseDecision!.park.tombstone).toBe(false);
    expect(proseDecision!.verbs).toEqual(["approve"]);
    await expect(approve(["run-tombstone-prose", "T1", "--by", "operator"], proseRoot)).resolves.toContain("approved T1");

    // A release appended by another actor after the preview: refreshed refusal, no duplicate append.
    const before = journalEvents(root, runId).length;
    await approve([runId, "T2", "--by", "someone-else"], root);
    const raced = await executeDecision(humanApprove.preview, { cwd: root });
    expect(raced.ok).toBe(false);
    if (!raced.ok) {
      expect(raced.stale).toBe(true);
      expect(raced.refusal).toContain(`released at #L${before + 1} by someone-else`);
    }
    expect(approvals(root, runId, "T2")).toHaveLength(1);
    expect(approvals(root, runId, "T2")[0]!.data.by).toBe("someone-else");
    const refreshed = previewDecision({ verb: "approve", taskId: "T2" }, { cwd: root, runId, by: "operator" });
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.refusal).toContain("already released");
  });

  test("Run’s confirmation and receipt disclose run/task, newest park line, actor/reason, exact argv including gate or review-round ceiling, consequence and enactment from approvalRunOwner/approvalEnactment. Matching-live shows pending daemon enactment, other-live names its held lock, and no-owner prints the exact resume command, with one verified journal append in each valid case. Closed-daemon approval showing dispatched or green work, Enter silently confirming, or an unreadable append shown as success fails.", async () => {
    const owners = ["matching-live", "other-live", "no-owner"] as const;
    for (const owner of owners) {
      const root = repo();
      const runId = `run-${owner}`;
      const j = Journal.create(root, runId);
      park(j, "T1", "infra", { failedGate: "test", reason: "signal exit" });
      park(j, "T2", "gate-fail", { failedGate: "review", reason: "review round cap" });
      if (owner !== "no-owner") {
        writeFileSync(join(tickmarkrDir(root), "graph.lock"), JSON.stringify({ pid: process.pid, runId: owner === "matching-live" ? runId : "run-somebody-else", startedAt: Date.now() }));
      }
      const run = approvalRunOwner(root, runId);
      expect(run.live).toBe(owner === "matching-live");
      expect(run.blockingRunId).toBe(owner === "other-live" ? "run-somebody-else" : undefined);
      const graph = graphOf(["T1", "T2", "T3"], { T3: ["T1"] });
      const decisions = () => deriveRunDecisions(Journal.open(root, runId), graph);
      const { snapshot } = readRun(root, runId, graph);
      const ctx = { tasks: snapshot.tasks, decisions: decisions(), verdictLines: 0 };

      // The spike: infra recheck from the mounted view. a opens Actions, ↓ reaches recheck, Enter previews.
      let session = initialRunViewSession();
      session = applyRunViewKey(session, key("a"), ctx).session;
      expect(session.decisions.menu).toEqual({ taskId: "T1", verbs: ["approve", "recheck"], selection: 0 });
      expect(await drawRun(root, runId, session, 150, graph)).toContain("ACTIONS / T1");
      session = applyRunViewKey(session, DOWN, ctx).session;
      const picked = applyRunViewKey(session, ENTER, ctx);
      expect(picked.open).toEqual({ verb: "recheck", taskId: "T1" });
      expect(picked.confirm).toBeUndefined();
      const preview = previewDecision({ ...picked.open!, reason: "runner died" }, { cwd: root, runId, by: "operator" });
      expect(preview.ok).toBe(true);
      if (!preview.ok) continue;
      session = { ...picked.session, decisions: withDecisionPreview(picked.session.decisions, preview) };
      const confirmFrame = await drawRun(root, runId, session, 200, graph);
      const lines = decisionConfirmLines(preview.preview);
      expect(confirmFrame).toContain("CONFIRM RECHECK");
      expect(lines).toContain(`run          ${runId}`);
      expect(lines).toContain("task         T1");
      expect(lines).toContain("park         #L3 infra · failed gate test · signal exit");
      expect(lines).toContain("actor        operator");
      expect(lines).toContain("reason       runner died");
      expect(lines).toContain(`argv         tickmarkr approve ${runId} T1 --recheck --by operator --reason "runner died"`);
      expect(lines).toContain("consequence  disposition re-dispatch; appends one task-approved with release recheck");
      expect(lines).toContain(`             ${approvalEnactment("re-dispatch", run)}`);
      expect(lines.some((l) => l.startsWith("enactment    ") && l.includes(
        owner === "matching-live" ? "pending daemon enactment" : owner === "other-live" ? "`run-somebody-else` holds the repository lock" : `tickmarkr resume ${runId}`,
      ))).toBe(true);
      for (const line of lines) expect(confirmFrame).toContain(line.trim().slice(0, 60));
      expect(confirmFrame).toContain("blocks T3");

      // Enter never confirms; y names the write; nothing is appended until then.
      const pressedEnter = applyRunViewKey(session, ENTER, ctx);
      expect(pressedEnter.confirm).toBeUndefined();
      expect(pressedEnter.session.decisions.confirming).toEqual(preview.preview);
      expect(approvals(root, runId, "T1")).toEqual([]);
      const confirmed = applyRunViewKey(session, key("y"), ctx);
      expect(confirmed.confirm).toEqual(preview.preview);
      expect(approvals(root, runId, "T1")).toEqual([]);

      const receipt = await executeDecision(confirmed.confirm!, { cwd: root });
      expect(receipt.ok).toBe(true);
      if (!receipt.ok) continue;
      const appended = approvals(root, runId, "T1");
      expect(appended).toHaveLength(1);
      expect(appended[0]!.data).toMatchObject({ by: "operator", reason: "runner died", release: "recheck" });
      expect(receipt.appended.line).toBe(journalEvents(root, runId).length);
      const receiptLines = decisionReceiptLines(receipt);
      expect(receiptLines[0]).toBe(`appended     #L${receipt.appended.line} task-approved T1 · release recheck · disposition re-dispatch · read back from ${join(".tickmarkr", "runs", runId, "journal.jsonl")}`);
      expect(receiptLines).toContain("actor        operator · reason runner died");
      expect(receiptLines).toContain(`argv         tickmarkr approve ${runId} T1 --recheck --by operator --reason "runner died"`);
      expect(receiptLines).toContain(`             ${approvalEnactment("re-dispatch", run)}`);
      const enactment = receiptLines.find((l) => l.startsWith("enactment    "))!;
      const state = receiptLines.find((l) => l.startsWith("state        "))!;
      if (owner === "matching-live") {
        expect(enactment).toContain("matching live daemon — pending daemon enactment at its next task boundary");
        expect(state).toContain("pending daemon enactment");
      } else if (owner === "other-live") {
        expect(enactment).toContain("other live run `run-somebody-else` holds the repository lock — recorded, not dispatched");
        expect(state).toContain("approved; resume required");
      } else {
        expect(enactment).toBe(`enactment    no live owner — recorded, not dispatched; resume required: tickmarkr resume ${runId}`);
        expect(state).toContain("approved; resume required");
      }
      // A closed daemon's approval is permission, never dispatched or green work.
      expect(state).toContain("permission recorded, no work dispatched, nothing green");
      const receiptSession = { ...confirmed.session, decisions: withDecisionReceipt(confirmed.session.decisions, receipt) };
      const receiptFrame = await drawRun(root, runId, receiptSession, 200, graph);
      expect(receiptFrame).toContain("RECEIPT · appended");
      expect(receiptFrame).toContain("state pending");
      expect(receiptFrame).not.toContain("state merged");
      expect(receiptFrame).not.toMatch(/T1 .*dispatched\b/u);
      expect(readRun(root, runId, graph).snapshot.green).toBe(false);

      // The review park with a review-round ceiling: the exact argv carries the gate decision and ceiling.
      const uphold = previewDecision({ verb: "uphold", taskId: "T2", reviewRounds: 2 }, { cwd: root, runId, by: "operator" });
      expect(uphold.ok).toBe(true);
      if (!uphold.ok) continue;
      expect(decisionConfirmLines(uphold.preview)).toContain(`argv         tickmarkr approve ${runId} T2 --uphold --review-rounds 2 --by operator`);
      expect(decisionConfirmLines(uphold.preview)).toContain("park         #L6 gate-fail · failed gate review · review round cap");
      const upheld = await executeDecision(uphold.preview, { cwd: root });
      expect(upheld.ok).toBe(true);
      expect(approvals(root, runId, "T2")).toHaveLength(1);
      expect(approvals(root, runId, "T2")[0]!.data).toMatchObject({ release: "review-upheld", gate: "review", reviewRoundCeiling: 2 });
      if (upheld.ok) expect(decisionReceiptLines(upheld)[0]).toContain("release review-upheld · disposition fund-fixed-attempt");
    }

    // Physical journal identity survives malformed and blank rows that the parsed replay omits.
    const physicalRoot = repo();
    const physicalRun = "run-physical-lines";
    park(Journal.create(physicalRoot, physicalRun), "T1", "infra", { failedGate: "test", reason: "crash then resume" });
    const physicalFile = join(tickmarkrDir(physicalRoot), "runs", physicalRun, "journal.jsonl");
    writeFileSync(physicalFile, `{torn write}\n\n${readFileSync(physicalFile, "utf8")}`);
    const physicalPreview = previewDecision({ verb: "recheck", taskId: "T1" }, { cwd: physicalRoot, runId: physicalRun, by: "operator" });
    expect(physicalPreview.ok).toBe(true);
    if (physicalPreview.ok) {
      expect(physicalPreview.preview.park.line).toBe(5);
      expect(decisionConfirmLines(physicalPreview.preview)).toContain("park         #L5 infra · failed gate test · crash then resume");
      const physicalReceipt = await executeDecision(physicalPreview.preview, { cwd: physicalRoot });
      expect(physicalReceipt.ok).toBe(true);
      if (physicalReceipt.ok) {
        expect(physicalReceipt.appended.line).toBe(6);
        expect(decisionReceiptLines(physicalReceipt)[0]).toContain("appended     #L6 task-approved T1");
        expect(Journal.open(physicalRoot, physicalRun).readTracked().find((row) => row.sourceIndex === 5)?.raw)
          .toEqual(physicalReceipt.appended.event);
      }
    }

    // An append that cannot be read back is a refusal, never a receipt.
    const root = repo();
    const runId = "run-unreadable-append";
    park(Journal.create(root, runId), "T1", "attempt-cap");
    const preview = previewDecision({ verb: "approve", taskId: "T1" }, { cwd: root, runId, by: "operator" }) as { ok: true; preview: DecisionPreview };
    const silent = await executeDecision(preview.preview, { cwd: root, command: async () => "approval disposition fresh-budget: approved T1 — by operator" });
    expect(silent.ok).toBe(false);
    if (!silent.ok) expect(silent.refusal).toMatch(/gained 0 task-approved row\(s\) for T1 after #L2 — not shown as success/);
    expect(decisionReceiptLines(silent)).toContain("appended     nothing");
    expect(approvals(root, runId, "T1")).toEqual([]);
    const mismatched = await executeDecision(preview.preview, { cwd: root, command: async () => { await approve([runId, "T1", "--by", "impostor"], root); return "faked"; } });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.refusal).toMatch(/has by impostor, expected operator/);

    // Read-back verifies every command-bearing field, not merely release and actor. Each forged
    // command gets a fresh park because even a rejected receipt cannot undo its physical append.
    for (const [field, replacement] of [
      ["gate", "scope"],
      ["reason", "different reason"],
      ["reviewRoundCeiling", 4],
      ["via", "tui"],
    ] as const) {
      const mismatchRoot = repo();
      const mismatchRun = `run-wrong-${field}`;
      park(Journal.create(mismatchRoot, mismatchRun), "T1", "gate-fail", { failedGate: "review" });
      const named = previewDecision(
        { verb: "waive", taskId: "T1", reason: "confirmed reason", reviewRounds: 3 },
        { cwd: mismatchRoot, runId: mismatchRun, by: "operator" },
      ) as { ok: true; preview: DecisionPreview };
      const forgedReceipt = await executeDecision(named.preview, {
        cwd: mismatchRoot,
        command: async () => {
          Journal.open(mismatchRoot, mismatchRun).append("task-approved", "T1", {
            by: "operator", via: "cli", release: "gate-satisfied", gate: "review",
            reason: "confirmed reason", reviewRoundCeiling: 3, [field]: replacement,
          });
          return "forged success";
        },
      });
      expect(forgedReceipt.ok, field).toBe(false);
      if (!forgedReceipt.ok) expect(forgedReceipt.refusal).toContain(`has ${field} ${String(replacement)}`);
    }

    // Mandatory facts wrap instead of clipping at the narrow supported width. Suffixes from the
    // long park, actor and reason prove the complete values remain on-screen in confirm and receipt.
    const narrowRoot = repo();
    const narrowRun = "run-narrow-decision";
    const parkReason = `park-${"p".repeat(72)}-PARK-END`;
    park(Journal.create(narrowRoot, narrowRun), "T1", "infra", { failedGate: "test", reason: parkReason });
    const actor = `actor-${"a".repeat(48)}-ACTOR-END`;
    const reason = `reason-${"r".repeat(64)}-REASON-END`;
    const narrowPreview = previewDecision({ verb: "recheck", taskId: "T1", reason }, { cwd: narrowRoot, runId: narrowRun, by: actor }) as { ok: true; preview: DecisionPreview };
    const narrowGraph = graphOf(["T1"]);
    const narrowSession = {
      ...initialRunViewSession(),
      decisions: withDecisionPreview(initialDecisionSession(), narrowPreview),
    };
    const narrowConfirm = await drawRun(narrowRoot, narrowRun, narrowSession, 40, narrowGraph);
    for (const suffix of ["PARK-END", "ACTOR-END", "REASON-END", "--recheck", "--reason", "whole declared", "battery re-runs", "tickmarkr resume", narrowRun]) {
      expect(narrowConfirm, suffix).toContain(suffix);
    }
    for (const line of narrowConfirm.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(40);
    const narrowReceipt = await executeDecision(narrowPreview.preview, { cwd: narrowRoot });
    expect(narrowReceipt.ok).toBe(true);
    const receiptSession = {
      ...initialRunViewSession(),
      decisions: withDecisionReceipt(initialDecisionSession(), narrowReceipt),
    };
    const narrowReceiptFrame = await drawRun(narrowRoot, narrowRun, receiptSession, 40, narrowGraph);
    for (const suffix of ["PARK-END", "ACTOR-END", "REASON-END", "--recheck", "--reason", "whole declared", "battery re-runs", "tickmarkr resume", narrowRun]) {
      expect(narrowReceiptFrame, suffix).toContain(suffix);
    }
    for (const line of narrowReceiptFrame.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(40);
    // The receipt's keybar and Esc: cancelling a confirm leaves the file byte-identical.
    const cancelRoot = repo();
    park(Journal.create(cancelRoot, "run-cancel"), "T1", "quota");
    const cancelPreview = previewDecision({ verb: "approve", taskId: "T1" }, { cwd: cancelRoot, runId: "run-cancel", by: "operator" }) as { ok: true; preview: DecisionPreview };
    const bytes = readFileSync(join(tickmarkrDir(cancelRoot), "runs", "run-cancel", "journal.jsonl"), "utf8");
    const armed = withDecisionPreview(initialDecisionSession(), cancelPreview);
    expect(applyDecisionKey(armed, key("", { escape: true }), undefined).session.confirming).toBeNull();
    expect(applyDecisionKey(armed, key("n"), undefined).confirm).toBeUndefined();
    expect(readFileSync(join(tickmarkrDir(cancelRoot), "runs", "run-cancel", "journal.jsonl"), "utf8")).toBe(bytes);
  });
});

/* ------------------------------------------------------------------------ */
/* T9 — the projection per task with source references; honest locators.    */
/* ------------------------------------------------------------------------ */

const T9_RUN = "run-20260921-090000";
const ownedWorker = (taskId: string, attempt: number, runId = T9_RUN) => formatOwnedName({ role: "worker", taskId, attempt, runId });
const launch = (j: Journal, taskId: string, attempt: number, slot: { id: string; name: string; cwd?: string }, driver = "herdr") =>
  j.append("worker-launch", taskId, { attempt, driver, slot: { cwd: "/wt", ...slot }, workspace: "ws-1" });

/** T1 stalls after launch; T2 builds, fails review and parks; T3 waits on T2. */
function t9Journal(root: string): { j: Journal; graph: ReturnType<typeof graphOf> } {
  const graph = graphOf(["T1", "T2", "T3"], { T3: ["T2"] });
  const j = Journal.create(root, T9_RUN);
  j.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
  j.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
  launch(j, "T1", 0, { id: "p-11", name: ownedWorker("T1", 0) });
  j.append("worker-nudge-failed", "T1", { attempt: 0, reason: "no composer" });
  j.append("operator-page", "T1", { attempt: 0, reason: "idle" });
  j.append("task-dispatch", "T2", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T2", pane: "pane-T2", alarmMs: 600000 });
  launch(j, "T2", 0, { id: "p-22", name: ownedWorker("T2", 0) });
  j.append("worker-result", "T2", { attempt: 0, ok: true, finished: true, role: "worker", agent: "fake:fake-1" });
  j.append("phase-start", "T2", { phase: "gates", attempt: 0 });
  j.append("build-receipt", "T2", { gate: "build", outcome: "completed", confirmedStart: true, exitCode: 0, durationMs: 12, attribution: { runId: T9_RUN, taskId: "T2", attempt: 0, gateRound: 1, invocation: "build#1" } });
  j.append("gate-result", "T2", { gate: "build", pass: true, attempt: 0, details: "ok" });
  j.append("gate-result", "T2", { gate: "review", pass: false, attempt: 0, details: "review red" });
  j.append("task-human", "T2", { kind: "gate-fail", reason: "review round cap reached — the reviewer upheld two findings about the retry path and the operator must decide" });
  return { j, graph };
}

const lineOfEvent = (root: string, pred: (e: JournalEvent) => boolean): number => journalEvents(root, T9_RUN).findIndex(pred) + 1;

describe("T9 — projection per agent with source references and honest locators", () => {
  test("the Run body shows for every task its role or agent identity phase build execution evidence blocker and next action each with the journal line it came from, and draws the stall marker on a stalled attempt, so a row without source references or a stalled attempt drawn as in flight fails", async () => {
    const root = repo();
    const { graph } = t9Journal(root);
    const { rows, snapshot } = readRun(root, T9_RUN, graph);
    const decisions = deriveRunDecisions(Journal.open(root, T9_RUN), graph);
    const projections = projectRunTasks(snapshot, rows, graph, decisions, T9_RUN);
    expect(projections.map((p) => p.taskId)).toEqual(["T1", "T2", "T3"]);
    const by = Object.fromEntries(projections.map((p) => [p.taskId, p]));

    // T1: identity from its launch row, phase implementing, no build row, stalled — never "in flight".
    const t1Launch = lineOfEvent(root, (e) => e.event === "worker-launch" && e.taskId === "T1");
    expect(by.T1).toMatchObject({ identity: { label: `worker ${ownedWorker("T1", 0)}`, line: t1Launch }, phase: { label: "phase implementing" }, build: { label: "build start-unrecorded" } });
    expect(by.T1!.build.line).toBeUndefined();
    expect(by.T1!.stalled).toMatchObject({ line: t1Launch });
    expect(by.T1!.stalled!.label).toContain(STALL_MARKER);
    expect(by.T1!.stalled!.label).toContain(`nudge failed #L${lineOfEvent(root, (e) => e.event === "worker-nudge-failed")}`);
    expect(by.T1!.stalled!.label).toContain(`paged #L${lineOfEvent(root, (e) => e.event === "operator-page")}`);

    // T2: identity from the worker-result's recorded role/agent, build receipt with its row, park as the blocker.
    const t2Result = lineOfEvent(root, (e) => e.event === "worker-result" && e.taskId === "T2");
    const t2Build = lineOfEvent(root, (e) => e.event === "build-receipt");
    const t2Park = lineOfEvent(root, (e) => e.event === "task-human" && e.taskId === "T2");
    expect(by.T2).toMatchObject({ identity: { label: "worker fake:fake-1", line: t2Result }, build: { label: "build completed exit 0", line: t2Build }, blocker: { line: t2Park }, nextAction: { line: t2Park } });
    expect(by.T2!.blocker.label).toContain("blocker human-decision");
    expect(by.T2!.nextAction.label).toMatch(/^next Choose a decision: /u);
    expect(by.T2!.phase).toMatchObject({ label: "phase terminal", line: t2Park });
    expect(by.T2!.stalled).toBeUndefined();

    // T3: never dispatched — every field says so rather than inventing a row.
    expect(by.T3).toMatchObject({ identity: { label: "identity unrecorded" }, blocker: { label: "blocker dependency-wait" }, nextAction: { label: "next Wait for prerequisites: T2" } });
    expect(by.T3!.identity.line).toBeUndefined();
    expect(by.T3!.stalled).toBeUndefined();

    // Every recorded reading carries the line it came from — a row without source references fails.
    for (const p of [by.T1!, by.T2!]) for (const f of [p.identity, p.phase]) expect(f.line, `${p.taskId} ${f.label}`).toBeGreaterThan(0);

    const frame = await drawRun(root, T9_RUN, initialRunViewSession(), 220, graph);
    expect(frame).toContain("PROJECTION / every task");
    for (const p of projections) expect(frame).toContain(projectionLine(p).slice(0, 120));
    expect(frame).toContain(`T1 · worker ${ownedWorker("T1", 0)} #L${t1Launch} · phase implementing #L${t1Launch} · build start-unrecorded (no journal row)`);
    expect(frame).toContain(`build completed exit 0 #L${t2Build} · blocker human-decision`);
    const t1Row = frame.split("\n").find((l) => l.includes(`T1 · worker ${ownedWorker("T1", 0)}`))!;
    expect(t1Row).toContain(STALL_MARKER);
    expect(t1Row).not.toContain("in flight");

    // Cross-attempt (finding 1): a delayed worker-result of attempt 0 never retires attempt 1's stall,
    // and attempt 0's nudge and page never mark attempt 1 stalled.
    const { j } = { j: Journal.open(root, T9_RUN) };
    j.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, worktree: "/wt/T1", pane: "pane-T1b", alarmMs: 600000 });
    launch(j, "T1", 1, { id: "p-12", name: ownedWorker("T1", 1) });
    j.append("worker-nudge-failed", "T1", { attempt: 0, reason: "late" });
    j.append("operator-page", "T1", { attempt: 0, reason: "late" });
    let again = readRun(root, T9_RUN, graph);
    let p1 = projectRunTasks(again.snapshot, again.rows, graph, [], T9_RUN).find((p) => p.taskId === "T1")!;
    expect(p1.stalled, "old-attempt nudge/page do not stall attempt 1").toBeUndefined();
    j.append("worker-nudge-failed", "T1", { attempt: 1, reason: "no composer" });
    j.append("operator-page", "T1", { attempt: 1, reason: "idle" });
    j.append("worker-result", "T1", { attempt: 0, ok: false, finished: true });
    again = readRun(root, T9_RUN, graph);
    p1 = projectRunTasks(again.snapshot, again.rows, graph, [], T9_RUN).find((p) => p.taskId === "T1")!;
    const t1Launch1 = lineOfEvent(root, (e) => e.event === "worker-launch" && e.taskId === "T1" && e.data.attempt === 1);
    expect(p1.stalled, "a delayed attempt-0 result never retires attempt 1's stall").toMatchObject({ line: t1Launch1 });
    expect(p1.identity, "identity follows the current attempt").toMatchObject({ label: `worker ${ownedWorker("T1", 1)}`, line: t1Launch1 });
    expect(p1.phase, "a delayed old-attempt result is not the phase's source").toMatchObject({ label: "phase implementing", line: t1Launch1 });

    // Accepted evidence (finding 2): a rejected attempt-0 receipt after the valid one is never the build's source.
    j.append("task-dispatch", "T2", { assignment: ASSIGNMENT, attempt: 1, worktree: "/wt/T2", pane: "pane-T2b", alarmMs: 600000 });
    launch(j, "T2", 1, { id: "p-23", name: ownedWorker("T2", 1) });
    j.append("worker-result", "T2", { attempt: 1, ok: true, finished: true });
    j.append("phase-start", "T2", { phase: "gates", attempt: 1 });
    j.append("build-receipt", "T2", { gate: "build", outcome: "completed", confirmedStart: true, exitCode: 0, durationMs: 9, attribution: { runId: T9_RUN, taskId: "T2", attempt: 1, gateRound: 2, invocation: "build#2" } });
    j.append("build-receipt", "T2", { gate: "build", outcome: "failed", confirmedStart: true, exitCode: 1, durationMs: 9, attribution: { runId: T9_RUN, taskId: "T2", attempt: 0, gateRound: 2, invocation: "build#stale" } });
    again = readRun(root, T9_RUN, graph);
    const p2 = projectRunTasks(again.snapshot, again.rows, graph, [], T9_RUN).find((p) => p.taskId === "T2")!;
    const validReceipt = lineOfEvent(root, (e) => e.event === "build-receipt" && (e.data as { attribution: { invocation: string } }).attribution.invocation === "build#2");
    expect(p2.build).toEqual({ label: "build completed exit 0", line: validReceipt });
    const gatesStart = lineOfEvent(root, (e) => e.event === "phase-start" && e.taskId === "T2" && e.data.attempt === 1);
    const t2Result1 = lineOfEvent(root, (e) => e.event === "worker-result" && e.taskId === "T2" && e.data.attempt === 1);
    expect(p2.phase, "the row that moved the phase, not the newest lifecycle row, is its source").toEqual({ label: "phase returned-for-verification", line: t2Result1 });
    expect(gatesStart).toBeGreaterThan(t2Result1);

    // The cockpit's tasks-view row (finding 4): exact sources carry their own line; presentation-only
    // ambiguity fails closed instead of attaching a stale attempt's row to the accepted value.
    const data = deriveRunCockpitData({ fileName: `${T9_RUN}.journal.jsonl`, raw: readFileSync(join(tickmarkrDir(root), "runs", T9_RUN, "journal.jsonl"), "utf8") }, "t9", { graph: { tasks: graph.tasks.map((t) => ({ id: t.id, title: t.title })) } });
    const taskRows = deriveRunViewRows(data, "tasks");
    const t2Text = taskRows.find((r) => r.text.startsWith("T2 "))!.text;
    // The cockpit cites the row that supplied each field: the owned identity came from this
    // attempt's launch, not the later worker-result that carried no identity payload.
    const newestT2Launch = lineOfEvent(root, (e) => e.event === "worker-launch" && e.taskId === "T2" && e.data.attempt === 1);
    expect(t2Text).toContain(`identity worker ${ownedWorker("T2", 1)} #L${newestT2Launch}`);
    expect(t2Text).toContain("phase returned-for-verification (no journal row)");
    expect(t2Text).toContain("build completed (no journal row)");
    expect(t2Text).not.toContain(`build completed #L${validReceipt}`);
    const t1Text = taskRows.find((r) => r.text.startsWith("T1 "))!.text;
    expect(t1Text).toContain(`${STALL_MARKER} · launch #L${t1Launch1} · 1 nudge failed (no journal row) · 1 paged (no journal row)`);
    expect(t1Text).not.toContain("source");
    expect(taskProjectionText(data.taskRows.find((r) => r.taskId === "T3")!, data.journalRows)).toBe("identity - · phase unconfirmed (no journal row) · build start-unrecorded · blocker unknown (no journal row) · next -");

    // Presentation rows omit attempts, so the cockpit must fail closed in the opposite ordering
    // too: stale attempt-0 evidence before accepted attempt-1 evidence is still ambiguous here.
    const probeRoot = repo();
    const probeGraph = graphOf(["T1"]);
    const probe = Journal.create(probeRoot, T9_RUN);
    probe.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(probeGraph), branch: "fixture" });
    probe.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
    launch(probe, "T1", 1, { id: "p-probe", name: ownedWorker("T1", 1) });
    probe.append("worker-result", "T1", { attempt: 0, ok: true, finished: true });
    probe.append("worker-result", "T1", { attempt: 1, ok: true, finished: true });
    probe.append("phase-start", "T1", { phase: "gates", attempt: 1 });
    probe.append("build-receipt", "T1", { gate: "build", outcome: "failed", confirmedStart: true, exitCode: 1, durationMs: 9, attribution: { runId: T9_RUN, taskId: "T1", attempt: 0, gateRound: 1, invocation: "build#stale-first" } });
    probe.append("build-receipt", "T1", { gate: "build", outcome: "completed", confirmedStart: true, exitCode: 0, durationMs: 9, attribution: { runId: T9_RUN, taskId: "T1", attempt: 1, gateRound: 1, invocation: "build#accepted-second" } });
    const probeData = deriveRunCockpitData({ fileName: `${T9_RUN}.journal.jsonl`, raw: readFileSync(join(tickmarkrDir(probeRoot), "runs", T9_RUN, "journal.jsonl"), "utf8") }, "t9", { graph: { tasks: probeGraph.tasks.map((t) => ({ id: t.id, title: t.title })) } });
    const probeText = deriveRunViewRows(probeData, "tasks")[0]!.text;
    expect(probeText).toContain("phase returned-for-verification (no journal row)");
    expect(probeText).toContain("build completed (no journal row)");
  });

  test("a pane locator the driver cannot verify a stale one and an ambiguous one render as unavailable with the recorded evidence reachable and no other terminal is selected by title provider or task id, so a guessed replacement tab fails", async () => {
    const root = repo();
    const graph = graphOf(["T1", "T2"]);
    const j = Journal.create(root, T9_RUN);
    j.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
    j.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
    // Look-alikes that a guess would pick: same task id in the title, same provider, another run's owned name.
    launch(j, "T2", 0, { id: "p-decoy-title", name: "T1 — Task T1 (claude)" });
    launch(j, "T2", 0, { id: "p-decoy-other-run", name: ownedWorker("T1", 0, "run-20260101-000000") });
    const read = (runId = T9_RUN) => { const { rows, snapshot } = readRun(root, runId, graph); return { rows, task: snapshot.tasks.find((t) => t.id === "T1")! }; };
    const dispatchLine = lineOfEvent(root, (e) => e.event === "task-dispatch" && e.taskId === "T1");

    // No launch for this attempt: unavailable, the dispatch-recorded pane field reachable with its evidence row.
    let r = read();
    expect(paneLocator(r.task, r.rows, T9_RUN)).toEqual({ status: "unavailable", reason: `no worker-launch for attempt 0 · recorded pane pane-T1 · evidence #L${dispatchLine}` });

    // A launch that names a title, not this attempt's owned pane: unverifiable, its row cited, never adopted.
    launch(j, "T1", 0, { id: "p-title", name: "Task T1 · claude" });
    r = read();
    const titled = paneLocator(r.task, r.rows, T9_RUN);
    expect(titled.status).toBe("unavailable");
    expect(titled.reason).toContain(`launch #L${titled.line} names Task T1 · claude, not this attempt's owned pane`);
    expect(titled.reason).toContain(`recorded pane pane-T1 · evidence #L${r.task.evidence!.line}`);

    // Ambiguous: two launches of the attempt with different pane ids.
    launch(j, "T1", 0, { id: "p-a", name: ownedWorker("T1", 0) });
    launch(j, "T1", 0, { id: "p-b", name: ownedWorker("T1", 0) });
    r = read();
    const ambiguous = paneLocator(r.task, r.rows, T9_RUN);
    expect(ambiguous.status).toBe("unavailable");
    expect(ambiguous.reason).toMatch(/^ambiguous: 3 launches #L\d+,#L\d+,#L\d+/u);

    // A single owned launch remains unavailable: this read does not ask the host, so it cannot
    // distinguish a live pane from one closed outside the journal. A resume still proves staleness.
    const root2 = repo();
    const j2 = Journal.create(root2, T9_RUN);
    j2.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
    j2.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
    launch(j2, "T1", 0, { id: "p-live", name: ownedWorker("T1", 0) });
    const live = readRun(root2, T9_RUN, graph);
    const launchLine = live.rows.length;
    expect(paneLocator(live.snapshot.tasks[0]!, live.rows, T9_RUN)).toMatchObject({ status: "unavailable", line: launchLine, reason: expect.stringContaining(`launch #L${launchLine} records herdr p-live, but live host verification is required`) });
    // A different run id makes the same name foreign: the locator is keyed by run, task and attempt.
    expect(paneLocator(live.snapshot.tasks[0]!, live.rows, "run-20260101-000000").status).toBe("unavailable");
    j2.append("run-resume", undefined, {});
    const stale = readRun(root2, T9_RUN, graph);
    const staleRead = paneLocator(stale.snapshot.tasks[0]!, stale.rows, T9_RUN);
    expect(staleRead).toMatchObject({ status: "unavailable", line: launchLine });
    expect(staleRead.reason).toContain(`launch #L${launchLine} is stale: run-resume #L${launchLine + 1} followed it`);

    // Staleness belongs to this attempt and exact pane. Delayed old-attempt results and closes of
    // another pane cannot retire the current locator.
    const root5 = repo();
    const j5 = Journal.create(root5, T9_RUN);
    j5.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
    j5.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 1, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
    launch(j5, "T1", 1, { id: "p-current", name: ownedWorker("T1", 1) });
    j5.append("worker-result", "T1", { attempt: 0, ok: true, finished: true });
    j5.append("pane-close", "T1", { paneId: "p-other" });
    const unrelated = readRun(root5, T9_RUN, graph);
    const unrelatedRead = paneLocator(unrelated.snapshot.tasks[0]!, unrelated.rows, T9_RUN);
    expect(unrelatedRead).toMatchObject({ status: "unavailable", reason: expect.stringContaining("live host verification is required") });
    expect(unrelatedRead.reason).not.toContain("is stale");

    // Capability limitations, not malformed names: a herdr launch without a workspace (HerdrDriver.focus
    // rejects it), a subprocess launch (no pane to verify), and a pane the journal recorded closed.
    for (const [label, extra, expected] of [
      ["herdr without workspace", { driver: "herdr", workspace: undefined }, "records no workspace; herdr cannot verify the pane"],
      ["subprocess", { driver: "subprocess" }, "driver subprocess cannot verify a pane"],
    ] as const) {
      const root3 = repo();
      const j3 = Journal.create(root3, T9_RUN);
      j3.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
      j3.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
      j3.append("worker-launch", "T1", { attempt: 0, slot: { id: "p-cap", cwd: "/wt", name: ownedWorker("T1", 0) }, ...extra });
      const cap = readRun(root3, T9_RUN, graph);
      const reading = paneLocator(cap.snapshot.tasks[0]!, cap.rows, T9_RUN);
      expect(reading.status, label).toBe("unavailable");
      expect(reading.reason, label).toContain(expected);
      expect(reading.reason, label).toContain("recorded pane pane-T1 · evidence #L");
      expect(reading.line, label).toBe(cap.rows.length);
    }
    const root4 = repo();
    const j4 = Journal.create(root4, T9_RUN);
    j4.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph), branch: "fixture" });
    j4.append("task-dispatch", "T1", { assignment: ASSIGNMENT, attempt: 0, worktree: "/wt/T1", pane: "pane-T1", alarmMs: 600000 });
    launch(j4, "T1", 0, { id: "p-closed", name: ownedWorker("T1", 0) });
    j4.append("pane-close", "T1", { paneId: "p-closed" });
    const closed = readRun(root4, T9_RUN, graph);
    const closedRead = paneLocator(closed.snapshot.tasks[0]!, closed.rows, T9_RUN);
    expect(closedRead.status).toBe("unavailable");
    expect(closedRead.reason).toContain(`is stale: pane-close #L${closed.rows.length} followed it`);

    // Rendered: the unavailable reading and its evidence are on the selected task's detail line; no decoy pane id is.
    const frame = await drawRun(root, T9_RUN, initialRunViewSession(), 220, graph);
    const detail = frame.split("\n").filter((l) => l.includes("locator unavailable — ambiguous")).join("\n");
    expect(detail).toContain(`recorded pane pane-T1 · evidence #L${r.task.evidence!.line}`);
    for (const decoy of ["p-decoy-title", "p-decoy-other-run", "p-title", "p-a", "p-b"]) expect(detail).not.toContain(decoy);
    const staleFrame = await drawRun(root2, T9_RUN, initialRunViewSession(), 220, graph);
    expect(staleFrame).toContain(`locator unavailable — launch #L${launchLine} is stale`);
  });

  test("refresh and navigation of the Run view issue zero terminal lifecycle or input operations and the existing decision confirmation and receipt read-back flow is unchanged, so a read that mutates a terminal or a broken confirmation fails", async () => {
    // Static: the view reads owned-name helpers only; no driver, host or process module can be reached from it.
    const source = readFileSync(join(import.meta.dirname, "../../src/tui/cockpit/run-view.tsx"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]!);
    expect(imports.filter((i) => i.includes("drivers/"))).toEqual(["../../drivers/types.js"]);
    expect(imports.some((i) => /child_process|drivers\/index|herdr|orca|subprocess/u.test(i))).toBe(false);

    // Mounted: every navigation key and a refresh, with the focus capability spied — it is never reached.
    const root = repo();
    const { graph } = t9Journal(root);
    void graph;
    const focusDriver = vi.fn(async () => ({ status: "focused" as const, reason: "never" }));
    const input = ttyInput();
    let lastFrame = "";
    const output = new Writable({ write(chunk, _enc, next) { const t = String(chunk); if (t.includes("q Quit")) lastFrame = t.slice(-20000); next(); } }) as NodeJS.WriteStream;
    Object.assign(output, { isTTY: true, columns: 120, rows: 40 });
    let delivery!: ShellDelivery;
    const mounted = runLiveCockpit({ cwd: root, runId: T9_RUN, input, output, binaryVersion: "t9", debug: true, refreshMs: 2 ** 30, focusDriver, onShellDelivery: (d) => { delivery = d; } });
    const settled = mounted.then(() => undefined, (e) => e as Error);
    await wait(30);
    try {
      delivery.key({ input: "4", key: {} });
      for (const k of [{ downArrow: true }, { downArrow: true }, { upArrow: true }, { rightArrow: true }, { leftArrow: true }, { pageDown: true }, { pageUp: true }]) delivery.key({ input: "", key: k });
      delivery.key({ input: "x", key: {} });
      delivery.refresh();
      await wait(30);
      expect(stripAnsi(lastFrame)).toContain("RUN /");
      expect(focusDriver).not.toHaveBeenCalled();
    } finally {
      delivery.key({ input: "q", key: {} }); delivery.key({ input: "c", key: { ctrl: true } });
      expect(await settled).toBeUndefined();
      input.destroy(); output.destroy();
    }

    // The confirmation and receipt read-back flow: a → Enter previews, y confirms, one append read back.
    const decisions = () => deriveRunDecisions(Journal.open(root, T9_RUN), graph);
    const { snapshot } = readRun(root, T9_RUN, graph);
    const ctx = { tasks: snapshot.tasks, decisions: decisions(), verdictLines: 0 };
    let session: RunViewSession = { ...initialRunViewSession(), selection: 1 };
    session = applyRunViewKey(session, key("a"), ctx).session;
    expect(session.decisions.menu).toEqual({ taskId: "T2", verbs: ["waive", "uphold", "recheck"], selection: 0 });
    const picked = applyRunViewKey(session, ENTER, ctx);
    expect(picked.open).toEqual({ verb: "waive", taskId: "T2" });
    const preview = previewDecision({ ...picked.open!, reason: "accepted risk" }, { cwd: root, runId: T9_RUN, by: "operator" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    session = { ...picked.session, decisions: withDecisionPreview(picked.session.decisions, preview) };
    const confirmFrame = await drawRun(root, T9_RUN, session, 220, graph);
    expect(confirmFrame).toContain("CONFIRM WAIVE");
    expect(confirmFrame).toContain(`tickmarkr approve ${T9_RUN} T2 --waive`);
    expect(applyRunViewKey(session, ENTER, ctx).confirm).toBeUndefined();
    expect(approvals(root, T9_RUN, "T2")).toEqual([]);
    const confirmed = applyRunViewKey(session, key("y"), ctx);
    expect(confirmed.confirm).toEqual(preview.preview);
    const receipt = await executeDecision(confirmed.confirm!, { cwd: root });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(approvals(root, T9_RUN, "T2")).toHaveLength(1);
    expect(receipt.appended.line).toBe(journalEvents(root, T9_RUN).length);
    const receiptFrame = await drawRun(root, T9_RUN, { ...session, decisions: withDecisionReceipt(session.decisions, receipt) }, 220, graph);
    expect(receiptFrame).toContain("RECEIPT · appended");
    expect(receiptFrame).toContain(`#L${receipt.appended.line} task-approved T2 · release ${receipt.release ?? "none"}`);
    expect(focusDriver).not.toHaveBeenCalled();
  });
});
