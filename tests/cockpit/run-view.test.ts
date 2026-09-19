import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  approvalEnactment,
  approvalRunOwner,
  approve,
  DECISION_VERBS,
  permittedDecisionVerbs,
  releaseForDecision,
  type DecisionVerb,
} from "../../src/cli/commands/approve.js";
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
import {
  applyRunViewKey,
  evidenceLookup,
  initialRunViewSession,
  runGateCells,
  RunView,
  VERDICT_WINDOW,
  type RunEvidenceRow,
  type RunViewSession,
} from "../../src/tui/cockpit/run-view.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";

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
    expect(row("T4")).toMatch(/· {2}· {2}· {2}· {2}· {2}· {2}✔ {4}fake:fake-1 +1 +1\/7 gates run$/u);
    expect(row("T5")).toMatch(/✔ {2}✔ {2}✔ {2}· {2}· {2}· {2}· {4}fake:fake-1 +1 +3\/7 gates run$/u);
    expect(row("T7")).toMatch(/· {2}· {2}· {2}· {2}· {2}· {2}· {4}fake:fake-1 +2 +in flight$/u);
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
