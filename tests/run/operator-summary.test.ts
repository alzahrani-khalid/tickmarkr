import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { newestPark, permittedDecisionVerbs } from "../../src/cli/commands/approve.js";
import { PARK_KINDS, type JournalEvent } from "../../src/run/journal.js";
import {
  BLOCKER_KINDS, projectOperatorSummary,
  type OperatorDecisionSnapshot, type OperatorSummaryTask,
} from "../../src/run/operator-summary.js";

const task = (overrides: Partial<OperatorSummaryTask> = {}): OperatorSummaryTask => ({
  id: "T6", status: "human", deps: [], ...overrides,
});

// The fixture calls the production readers. No local table of allowed verbs.
function decision(kind: string, options: { reason?: string; gate?: string; diagnostic?: string } = {}): OperatorDecisionSnapshot {
  const events: JournalEvent[] = [];
  if (options.gate) events.push({
    event: "gate-result", taskId: "T6", ts: "2026-09-20T09:00:00Z",
    data: { gate: options.gate, pass: false },
  });
  events.push({ event: "task-human", taskId: "T6", ts: "2026-09-20T09:01:00Z",
    data: { kind, reason: options.reason ?? `Recorded ${kind} reason` } });
  const park = newestPark(events, "T6")!;
  return { taskId: "T6", park, verbs: permittedDecisionVerbs(park), diagnostic: options.diagnostic };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("operator summary", () => {
  it("every park kind the journal schema admits, paired with the verbs the production decision table returns for it, projects a blocker whose permitted actions equal exactly those verbs, whose human-intervention flag is true for every park kind except a tombstone, and whose decision flag is true only when at least one verb exists, so a scope-request shown as an automatic wait, a tombstone shown as needing a human, or a verb the table refuses fails", () => {
    const cases = [
      ...PARK_KINDS.map(kind => decision(kind)),
      decision("gate-fail", { gate: "review" }),
      decision("gate-fail", { gate: "test" }),
      decision("human-gate", { reason: "Retired task — tombstone" }),
    ];
    for (const snapshot of cases) {
      // A live park cannot be hidden by an automatic wait, even when both
      // pieces of evidence are present in the caller's current task snapshot.
      const blocker = projectOperatorSummary([task({
        deps: ["unfinished"], wait: { kind: "cooldown", wakeAt: "2026-09-20T12:00:00Z" },
        staleReceipt: { diagnostic: "Earlier receipt is stale" },
      })], [snapshot])[0]!.blocker!;
      expect(blocker.permittedActions).toEqual(snapshot.verbs);
      expect(blocker.permittedActions).not.toBe(snapshot.verbs);
      expect(blocker.humanInterventionRequired).toBe(!snapshot.park.tombstone);
      expect(blocker.decisionRequired).toBe(snapshot.verbs.length > 0);
      expect(blocker.kind).toBe(snapshot.park.tombstone ? "unknown" : "human-decision");
      expect(blocker).not.toHaveProperty("wakeAt");
      expect(blocker).not.toHaveProperty("prerequisites");
    }
  });

  it("a scope-request park, a tombstone park and a gate-fail park without failed-gate evidence keep their diagnostics verbatim with no fabricated next action, so a blocker that invents an action for an undecidable park fails", () => {
    const cases = [
      decision("scope-request", { diagnostic: "tickmarkr approve run T6 --files 'src/new/**'\nOnly extend the scope." }),
      decision("human-gate", { reason: "Retired — tombstone", diagnostic: "tombstone — permanent by design; no verb releases it" }),
      decision("gate-fail", { diagnostic: "parked on gate-fail with no failed gate result on the newest park — refusing to infer one" }),
    ];
    for (const snapshot of cases) {
      expect(projectOperatorSummary([task({
        missingCapability: { capability: "sandbox-exec", diagnostic: "Unrelated host diagnostic" },
      })], [snapshot])[0]!.blocker).toMatchObject({
        diagnostic: snapshot.diagnostic, nextAction: null, permittedActions: [], decisionRequired: false,
      });
      const { diagnostic: _diagnostic, ...withoutDiagnostic } = snapshot;
      expect(projectOperatorSummary([task()], [withoutDiagnostic])[0]!.blocker).toMatchObject({
        diagnostic: snapshot.park.reason, nextAction: null, permittedActions: [], decisionRequired: false,
      });
    }
    // A failed gate from before a production decision boundary cannot supply
    // verbs for a newer park that has no failed-gate evidence of its own.
    for (const boundary of ["task-dispatch", "task-approved", "task-human"] as const) {
      const events: JournalEvent[] = [
        { event: "gate-result", taskId: "T6", ts: "2026-09-20T09:00:00Z", data: { gate: "review", pass: false } },
        { event: boundary, taskId: "T6", ts: "2026-09-20T09:01:00Z", data: {} },
        { event: "gate-result", taskId: "other", ts: "2026-09-20T09:02:00Z", data: { gate: "review", pass: false } },
        { event: "task-human", taskId: "T6", ts: "2026-09-20T09:03:00Z", data: { kind: "gate-fail", reason: "No current failed gate.\nInspect the evidence." } },
      ];
      const park = newestPark(events, "T6")!;
      const snapshot = { taskId: "T6", park, verbs: permittedDecisionVerbs(park) };
      expect(snapshot.verbs).toEqual([]);
      expect(projectOperatorSummary([task()], [snapshot])[0]!.blocker).toMatchObject({
        diagnostic: park.reason, nextAction: null, permittedActions: [],
        humanInterventionRequired: true, decisionRequired: false,
      });
    }
    const reasonOnly = decision("scope-request", { reason: "Keep this reason verbatim.\nNo supplied menu." });
    expect(projectOperatorSummary([task()], [reasonOnly])[0]!.blocker!.diagnostic).toBe(reasonOnly.park.reason);
    const emptyDiagnostic = decision("scope-request", { diagnostic: "" });
    expect(projectOperatorSummary([task()], [emptyDiagnostic])[0]!.blocker).toMatchObject({
      diagnostic: "", nextAction: null,
    });
  });

  it("a pending task with unmet dependencies names the prerequisite ids and clears the blocker when the last one is done, while a recorded cooldown or retry wait exposes its recorded wake time only and never invents an owner or a timer, so a dependency blocker that outlives its resolution or a wait with a fabricated wake fails", () => {
    const pending = task({ status: "pending", deps: ["T1", "T2", "external"] });
    const tasks = [pending, task({ id: "T1", status: "done" }), task({ id: "T2", status: "running" })];
    expect(projectOperatorSummary(tasks, [decision("human-gate")])[0]!.blocker).toMatchObject({
      kind: "dependency-wait", prerequisites: ["T2", "external"], nextAction: "Wait for prerequisites: T2, external",
    });
    for (const status of ["done", "completed", "merged"]) {
      const prerequisites = [task({ id: "T1", status }), task({ id: "T2", status })];
      expect(projectOperatorSummary([pending, ...prerequisites], [])[0]!.blocker).toMatchObject({
        kind: "dependency-wait", prerequisites: ["external"],
      });
      const resolved = [pending, ...prerequisites, task({ id: "external", status })];
      expect(projectOperatorSummary(resolved, [decision("human-gate")])[0]!.blocker).toBeNull();
    }
    expect(projectOperatorSummary([pending, ...pending.deps.map(id => task({ id, status: "failed" }))], [])[0]!.blocker).toMatchObject({
      kind: "dependency-wait", prerequisites: pending.deps,
    });
    for (const status of ["done", "completed", "merged", "failed"]) {
      expect(projectOperatorSummary([task({ status, wait: { kind: "retry" },
        staleReceipt: { diagnostic: "old receipt" } })], [decision("human-gate")])[0]!.blocker).toBeNull();
    }
    for (const kind of ["cooldown", "retry"] as const) {
      for (const wakeAt of [undefined, "2026-09-20T10:30:00Z"]) {
        const summary = projectOperatorSummary([task({ status: "pending", wait: { kind, ...(wakeAt ? { wakeAt } : {}) } })], [])[0]!;
        expect(summary.responsible).toBeNull();
        expect(summary.blocker).toEqual({
          kind, permittedActions: [], humanInterventionRequired: false, decisionRequired: false,
          nextAction: null, ...(wakeAt ? { wakeAt } : {}),
        });
      }
    }
  });

  it("an infra park naming a missing host capability projects the capability and a diagnostic next step without promising that a rerun fixes it, and the closed blocker-kind set distinguishes a pending human decision from retry cooldown dependency wait and stale receipt, so two blocker kinds sharing one label fail", () => {
    const snapshot = decision("infra");
    const summary = projectOperatorSummary([task({ missingCapability: { capability: "sandbox-exec", diagnostic: "Host executable unavailable" } })], [snapshot])[0]!;
    expect(summary.blocker).toEqual({
      kind: "missing-capability", capability: "sandbox-exec", diagnostic: "Host executable unavailable",
      nextAction: "Diagnose host capability: sandbox-exec", permittedActions: snapshot.verbs,
      humanInterventionRequired: true, decisionRequired: true,
    });
    expect(summary.blocker!.nextAction).not.toMatch(/rerun|re-run|retry|fix/i);
    const diagnostic = "Recorded infra diagnostic.\nPreserve the caller's evidence.";
    expect(projectOperatorSummary([task({ missingCapability: {
      capability: "sandbox-exec", diagnostic: "Secondary capability detail",
    } })], [decision("infra", { diagnostic })])[0]!.blocker).toMatchObject({
      diagnostic, capability: "sandbox-exec", nextAction: "Diagnose host capability: sandbox-exec",
    });
    expect(BLOCKER_KINDS).toEqual(["human-decision", "retry", "cooldown", "dependency-wait", "stale-receipt", "missing-capability", "unknown"]);
    expect(new Set(BLOCKER_KINDS).size).toBe(7);
    const kinds = [
      projectOperatorSummary([task()], [decision("human-gate")])[0]!.blocker!.kind,
      ...projectOperatorSummary([
        task({ id: "retry", status: "pending", wait: { kind: "retry" } }),
        task({ id: "cooldown", status: "pending", wait: { kind: "cooldown" } }),
        task({ id: "deps", status: "pending", deps: ["missing"] }),
        task({ id: "stale", status: "running", staleReceipt: { diagnostic: "Receipt belongs to a prior invocation" } }),
        task({ id: "unknown", status: "blocked" }),
      ], []).map(row => row.blocker!.kind),
      summary.blocker!.kind,
    ];
    expect(new Set(kinds)).toEqual(new Set(BLOCKER_KINDS));
  });

  it("identical inputs yield deep-equal blocker projections with no mutation of inputs and no filesystem or process access, so a projection that reads the host fails", () => {
    const parks = PARK_KINDS.map((kind, index) => ({ ...decision(kind), taskId: `park-${index}` }));
    const tasks = freeze([
      task({ phase: "gate:build", lastEvidenceAt: "2026-09-20T09:01:00Z", responsible: { role: "reviewer", agent: "recorded-agent" } }),
      task({ id: "wait", status: "pending", wait: { kind: "cooldown", wakeAt: "2026-09-20T10:00:00Z" } }),
      task({ id: "pending", status: "pending", deps: ["unknown"] }),
      ...parks.map(snapshot => task({ id: snapshot.taskId })),
      task({ id: "infra", missingCapability: { capability: "sandbox-exec", diagnostic: "Unavailable on this host" } }),
      task({ id: "stale", status: "running", staleReceipt: { diagnostic: "Prior invocation" } }),
      task({ id: "retry", status: "pending", wait: { kind: "retry", diagnostic: "Recorded retry" } }),
      task({ id: "no-decision" }),
      task({ id: "unknown", status: "unknown" }),
      task({ id: "done", status: "done" }),
      task({ id: "ready", status: "pending" }),
      task({ id: "tombstone" }),
    ]);
    const snapshots = freeze([
      decision("gate-fail", { gate: "review" }), ...parks,
      { ...decision("infra"), taskId: "infra" },
      { ...decision("human-gate", { reason: "Retired — tombstone" }), taskId: "tombstone" },
    ]);
    const before = JSON.stringify({ tasks, snapshots });
    const first = projectOperatorSummary(tasks, snapshots);
    const original = structuredClone(first);
    expect(projectOperatorSummary(tasks, snapshots)).toEqual(first);
    expect(first[0]).toMatchObject({ phase: "gate:build", lastEvidenceAt: tasks[0]!.lastEvidenceAt, responsible: tasks[0]!.responsible });
    expect(first[1]).toMatchObject({ phase: null, lastEvidenceAt: null, responsible: null });
    const ownership = freeze([
      task({ responsible: {} }),
      task({ responsible: { role: "reviewer" } }),
      task({ responsible: { agent: "recorded-agent" } }),
    ]);
    expect(projectOperatorSummary(ownership, snapshots).map(row => row.responsible)).toEqual([
      null, { role: "reviewer" }, { agent: "recorded-agent" },
    ]);
    first[0]!.blocker!.permittedActions.push("invented");
    Object.assign(first[0]!.responsible!, { agent: "changed" });
    first[2]!.blocker!.prerequisites!.push("changed");
    expect(JSON.stringify({ tasks, snapshots })).toBe(before);
    expect(projectOperatorSummary(tasks, snapshots)).toEqual(original);

    // Execute the entire module in a hostless realm, including module initialization.
    // require/imports, process, filesystem, clocks, network, and timers are unavailable.
    const source = readFileSync(new URL("../../src/run/operator-summary.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const denied = () => { throw new Error("host access forbidden"); };
    const realm = { exports: {}, tasks, snapshots, require: denied, Date: undefined,
      fetch: denied, setTimeout: denied, setInterval: denied };
    Object.defineProperty(realm, "process", { get: denied });
    const result = runInNewContext(`${compiled}\nJSON.stringify(exports.projectOperatorSummary(tasks, snapshots))`, realm,
      { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
    expect(JSON.parse(result)).toEqual(projectOperatorSummary(tasks, snapshots));
  });
});
