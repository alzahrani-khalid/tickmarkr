import { describe, expect, it } from "vitest";
import { canonicalizeLegacyName, formatOwnedName, isForeignName, parseOwnedName } from "../../src/drivers/types.js";
import { desiredPanes, panesToClose } from "../../src/run/reconcile.js";
import type { JournalEvent } from "../../src/run/journal.js";

const runId = "run-20260713-175532";
const ev = (event: string, taskId: string | undefined, data: Record<string, unknown> = {}): JournalEvent =>
  ({ ts: "2026-07-13T17:55:32.000Z", event, ...(taskId ? { taskId } : {}), data });

describe("ownership contract", () => {
  it("round-trips every role through format/parse", () => {
    for (const role of ["worker", "judge", "review", "consult", "watch", "other"] as const) {
      const owned = { role, taskId: "T2", attempt: 1, runId };
      expect(parseOwnedName(formatOwnedName(owned))).toEqual(owned);
    }
  });

  it("rejects anything not matching the contract", () => {
    const legacyPane = `${["dro", "vr"].join("")}`;
    expect(parseOwnedName("narrator-watch-1234")).toBeNull();
    expect(parseOwnedName("WORKERS · T2")).toBeNull();
    expect(parseOwnedName(`${legacyPane}:judge:T1:0:run-x`)).toBeNull(); // pre-v1.38 pane name — foreign
    expect(parseOwnedName(`${legacyPane}:worker:T2:0`)).toBeNull(); // truncated — missing runId
    expect(parseOwnedName(`${legacyPane}:bogus:T2:0:run-x`)).toBeNull(); // unknown role
    expect(isForeignName("operator's own tab")).toBe(true);
    expect(isForeignName(formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId }))).toBe(false);
  });

  it("canonicalizes the daemon's legacy worker name to the same identity reconcile derives from the journal", () => {
    const legacy = `T2-worker-claude-code-a0-${runId.replace(/^run-/, "")}`; // daemon.ts:299 shape (dashed adapter id)
    expect(canonicalizeLegacyName(legacy, runId)).toEqual({ role: "worker", taskId: "T2", attempt: 0, runId });
  });

  it("canonicalizes gates/llm.ts gatePaneName shapes, incl. the -r1 retry suffix", () => {
    expect(canonicalizeLegacyName("judge · T4", runId)).toEqual({ role: "judge", taskId: "T4", attempt: 0, runId });
    expect(canonicalizeLegacyName("review · T3-r1", runId)).toEqual({ role: "review", taskId: "T3", attempt: 1, runId });
    expect(canonicalizeLegacyName("consult · T2", runId)).toEqual({ role: "consult", taskId: "T2", attempt: 0, runId });
  });

  it("is idempotent on an already-canonical name", () => {
    const owned = { role: "worker" as const, taskId: "T2", attempt: 2, runId };
    expect(canonicalizeLegacyName(formatOwnedName(owned), runId)).toEqual(owned);
  });
});

describe("desiredPanes", () => {
  it("is empty before run-start and again after run-end", () => {
    expect(desiredPanes([], runId)).toEqual(new Set());
    expect(desiredPanes([ev("run-start", undefined), ev("run-end", undefined)], runId)).toEqual(new Set());
  });

  it("wants the watch pane plus each in-flight worker attempt", () => {
    const rows = [ev("run-start", undefined), ev("task-dispatch", "T2", { attempt: 0 })];
    expect(desiredPanes(rows, runId)).toEqual(new Set([
      formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }),
      formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId }),
    ]));
  });

  // OBS-17 (a): quota-failover reroutes T2/T7/T8 to a new attempt but the old slot was never closed —
  // 3 stale pi worker panes the operator had to close by hand. A re-dispatch must supersede, not add.
  it("excludes a superseded attempt after quota-failover re-dispatches (OBS-17 zombie panes)", () => {
    const rows = [
      ev("run-start", undefined),
      ev("task-dispatch", "T2", { attempt: 0 }),
      ev("quota-failover", "T2", { from: "pi:x", to: "codex:y" }),
      ev("task-dispatch", "T2", { attempt: 1 }),
    ];
    const desired = desiredPanes(rows, runId);
    expect(desired.has(formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId }))).toBe(false);
    expect(desired.has(formatOwnedName({ role: "worker", taskId: "T2", attempt: 1, runId }))).toBe(true);
  });

  // OBS-17 (b): the overseer's stop-amend-resume killed the daemon mid v1.19-T4 attempt-1 — the killed
  // process couldn't close its slot, and a plain resume doesn't reconcile it. run-resume must sweep it.
  it("drops a daemon-kill orphan across run-resume", () => {
    const rows = [
      ev("run-start", undefined),
      ev("task-dispatch", "T4", { attempt: 1 }),
      ev("run-resume", undefined),
    ];
    const desired = desiredPanes(rows, runId);
    expect(desired.has(formatOwnedName({ role: "worker", taskId: "T4", attempt: 1, runId }))).toBe(false);
    expect([...desired]).toEqual([formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId })]);
  });

  // OBS-103: pre-v1.64 the fold re-added the watch here, so the run-end sweep could never take the
  // narrator and a stop→resume cycle's leftover watch pane survived until the operator closed it.
  it("the run end reconcile desired set excludes the watch narrator so the sweep closes it", () => {
    const rows = [
      ev("run-start", undefined),
      ev("task-dispatch", "T6", { attempt: 0 }),
      ev("worker-result", "T6", { ok: true }),
      ev("gate-result", "T6", { gate: "acceptance", pass: true }),
      ev("gate-result", "T6", { gate: "review", pass: true }),
      ev("task-done", "T6", {}),
      ev("run-end", undefined, {}),
    ];
    const desired = desiredPanes(rows, runId);
    expect(desired.has(formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }))).toBe(false);
    expect(desired).toEqual(new Set()); // run-end retires EVERY run-tagged pane, narrator included
  });

  it("the narrator stays open at every non-terminal reconcile safe point", () => {
    const watch = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId });
    const rows: JournalEvent[] = [ev("run-start", undefined)];
    // every safe point the daemon sweeps at, short of run-end: task lifecycle events, terminal
    // task events (done/failed/human), and a run-resume boundary after a daemon kill
    const safePoints: JournalEvent[] = [
      ev("task-dispatch", "T1", { attempt: 0 }),
      ev("worker-result", "T1", { ok: true }),
      ev("gate-result", "T1", { gate: "acceptance", pass: true }),
      ev("gate-result", "T1", { gate: "review", pass: true }),
      ev("task-done", "T1", {}),
      ev("task-dispatch", "T2", { attempt: 0 }),
      ev("task-failed", "T2", {}),
      ev("task-dispatch", "T3", { attempt: 0 }),
      ev("task-human", "T3", {}),
      ev("run-resume", undefined),
    ];
    expect(desiredPanes(rows, runId).has(watch)).toBe(true); // run-start itself is a safe point
    for (const row of safePoints) {
      rows.push(row);
      expect(desiredPanes(rows, runId).has(watch), `watch desired after ${row.event}`).toBe(true);
    }
    rows.push(ev("run-end", undefined));
    expect(desiredPanes(rows, runId).has(watch)).toBe(false); // only the terminal boundary retires it
  });

  it("opens the judge pane after worker-result, retires it and opens review after acceptance passes, then retires review", () => {
    let rows: JournalEvent[] = [ev("run-start", undefined), ev("task-dispatch", "T2", { attempt: 0 }), ev("worker-result", "T2", {})];
    let desired = desiredPanes(rows, runId);
    expect(desired.has(formatOwnedName({ role: "judge", taskId: "T2", attempt: 0, runId }))).toBe(true);

    rows = [...rows, ev("gate-result", "T2", { gate: "acceptance", pass: true })];
    desired = desiredPanes(rows, runId);
    expect(desired.has(formatOwnedName({ role: "judge", taskId: "T2", attempt: 0, runId }))).toBe(false);
    expect(desired.has(formatOwnedName({ role: "review", taskId: "T2", attempt: 0, runId }))).toBe(true);

    rows = [...rows, ev("gate-result", "T2", { gate: "review", pass: true })];
    desired = desiredPanes(rows, runId);
    expect(desired.has(formatOwnedName({ role: "review", taskId: "T2", attempt: 0, runId }))).toBe(false);
  });

  it("clears a task's panes on task-failed/task-human without waiting for run-end", () => {
    const rows = [ev("run-start", undefined), ev("task-dispatch", "T9", { attempt: 0 }), ev("task-failed", "T9", {})];
    expect(desiredPanes(rows, runId).has(formatOwnedName({ role: "worker", taskId: "T9", attempt: 0, runId }))).toBe(false);
  });

  it("is a pure function: same rows in, same set out, no I/O", () => {
    const rows = [ev("run-start", undefined), ev("task-dispatch", "T1", { attempt: 0 })];
    expect(desiredPanes(rows, runId)).toEqual(desiredPanes(rows, runId));
  });
});

// v1.22b T1: workspace pinning — the reconciler must treat "owned but misplaced" as garbage too,
// not just "owned but undesired". Pure fold, no herdr stub needed.
describe("panesToClose (workspace-aware fleet fold)", () => {
  const ws = "wT";

  it("closes an in-workspace owned-but-undesired pane and reports its tab", () => {
    const superseded = formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId });
    const out = panesToClose(
      [{ name: superseded, paneId: "p1", tabId: "t1", workspaceId: ws }],
      new Set([formatOwnedName({ role: "worker", taskId: "T2", attempt: 1, runId })]),
      ws,
      runId,
    );
    expect(out).toEqual([{ paneId: "p1", tabId: "t1" }]);
  });

  // the 2026-07-13 'WORKERS - T3' scenario, generalized: an OLDER run's owned worker pane sitting in
  // a FOREIGN workspace is a leftover just as much as one sitting in the current workspace is.
  it("closes an owned worker pane from an OLDER run sitting in a FOREIGN workspace", () => {
    const olderLeftover = formatOwnedName({ role: "worker", taskId: "T9", attempt: 0, runId: "run-old" });
    const out = panesToClose(
      [{ name: olderLeftover, paneId: "p3", tabId: "t2", workspaceId: "wForeign" }],
      new Set(),
      ws,
      runId,
    );
    expect(out).toEqual([{ paneId: "p3", tabId: "t2" }]);
  });

  it("never touches this run's own pane sitting in another workspace", () => {
    const ownPane = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId });
    const out = panesToClose(
      [{ name: ownPane, paneId: "p6", tabId: "t5", workspaceId: "wZ" }],
      new Set(),
      ws,
      runId,
    );
    expect(out).toEqual([]);
  });

  it("never touches a foreign (non-contract) name, in any workspace", () => {
    const out = panesToClose(
      [
        { name: "orchestrator", paneId: "p4", tabId: "t3", workspaceId: ws },
        { name: "orchestrator", paneId: "p7", tabId: "t6", workspaceId: "wForeign" },
        { paneId: "p4b", tabId: "t3", workspaceId: ws }, // nameless shell
      ],
      new Set(),
      ws,
      runId,
    );
    expect(out).toEqual([]);
  });

  it("leaves a surviving watch for the operator", () => {
    const oldWatch = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId: "run-old" });
    expect(panesToClose([{ name: oldWatch, paneId: "p8", tabId: "t8", workspaceId: ws }], new Set(), ws, runId)).toEqual([]);
  });

  it("spares same-run consult/judge/review panes mid-run (spareLiveLlm), in-workspace only", () => {
    const consult = formatOwnedName({ role: "consult", taskId: "T5", attempt: 0, runId });
    const spared = panesToClose([{ name: consult, paneId: "p5", tabId: "t4", workspaceId: ws }], new Set(), ws, runId, { spareLiveLlm: true });
    expect(spared).toEqual([]);
    const boundary = panesToClose([{ name: consult, paneId: "p5", tabId: "t4", workspaceId: ws }], new Set(), ws, runId);
    expect(boundary).toEqual([{ paneId: "p5", tabId: "t4" }]);
  });

  it("skips a listing row missing a name or pane id", () => {
    const out = panesToClose([{ tabId: "t1", workspaceId: ws }, { name: formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId }), workspaceId: ws }], new Set(), ws, runId);
    expect(out).toEqual([]);
  });
});
