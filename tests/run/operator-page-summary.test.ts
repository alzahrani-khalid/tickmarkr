import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JournalEvent } from "../../src/run/journal.js";
import {
  EMPTY_OPERATOR_PAGE_SUMMARY, foldOperatorPages, operatorPageRow, summarizeOperatorPages,
  type OperatorPageRow,
} from "../../src/run/operator-page-summary.js";

const row = (line: number, over: Partial<OperatorPageRow> = {}): OperatorPageRow => ({
  line, ts: `2026-09-21T00:00:${String(line).padStart(2, "0")}Z`, runId: "run-1", taskId: "T1",
  park: "gate-fail#1", status: "blocked", suppressed: 0, blocker: "human-decision", owner: "operator",
  requiredAction: "approve", permittedActions: ["approve", "reject"], ...over,
});

describe("operator-page summary grouping", () => {
  it("equivalent historical operator-page rows keyed by run task current park identity and decision state form one group retaining first and last evidence timestamps and every source line reference, so a group that drops a source row fails", () => {
    const rows = [row(1, { suppressed: 2 }), row(2, { suppressed: 3 }), row(3), row(4, { taskId: "T2" })];
    const { groups } = foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, rows);
    expect(groups).toHaveLength(2);
    const [g] = groups;
    expect(g.lines).toEqual([1, 2, 3]);
    expect(g.firstEvidenceAt).toBe(rows[0].ts);
    expect(g.lastEvidenceAt).toBe(rows[2].ts);
    expect(g.observedCount).toBe(3);
    expect(g.suppressedCount).toBe(5);
    expect(groups[1].lines).toEqual([4]);
    // a distinct park identity or decision state is its own group
    const more = foldOperatorPages({ groups }, [row(5, { park: "gate-fail#2" }), row(6, { status: "idle" })]);
    expect(more.groups.map((x) => x.lines)).toEqual([[1, 2, 3], [4], [5], [6]]);
  });

  it("a change in blocker owner required action or permitted action set opens a new group, so a changed decision folded into the previous group fails", () => {
    const rows = [
      row(1), row(2, { blocker: "retry" }), row(3, { blocker: "retry", owner: "daemon" }),
      row(4, { blocker: "retry", owner: "daemon", requiredAction: "wait" }),
      row(5, { blocker: "retry", owner: "daemon", requiredAction: "wait", permittedActions: ["approve"] }),
      row(6, { blocker: "retry", owner: "daemon", requiredAction: "wait", permittedActions: ["approve"] }),
    ];
    const { groups } = foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, rows);
    expect(groups.map((g) => g.lines)).toEqual([[1], [2], [3], [4], [5, 6]]);
    expect(groups[4]).toMatchObject({ blocker: "retry", owner: "daemon", requiredAction: "wait", permittedActions: ["approve"] });
    // an intervening change closes the group: a later return to the earlier decision never merges backward,
    // and the same holds across an incremental boundary
    const abab = [row(1), row(2, { status: "idle", owner: "b" }), row(3)];
    expect(foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, abab).groups.map((g) => g.lines)).toEqual([[1], [2], [3]]);
    const split = foldOperatorPages(foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, abab.slice(0, 2)), abab.slice(2));
    expect(split.groups.map((g) => g.lines)).toEqual([[1], [2], [3]]);
    // permitted actions are a set: reordering keeps one group
    const reordered = [row(1), row(2, { permittedActions: ["reject", "approve"] })];
    expect(foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, reordered).groups.map((g) => g.lines)).toEqual([[1, 2]]);
  });

  it("the visible record count stays distinct from the producer's suppressed count across an incremental refresh, and the incremental result equals a full replay without modifying journal bytes, so a double count or a refresh that diverges from replay fails", () => {
    const events: JournalEvent[] = [
      { ts: "2026-09-21T00:00:01Z", event: "task-start", taskId: "T1", data: {} },
      { ts: "2026-09-21T00:00:02Z", event: "operator-page", taskId: "T1", data: { slot: "s", attempt: 1, status: "blocked", suppressed: 4 } },
      { ts: "2026-09-21T00:00:03Z", event: "operator-page", taskId: "T1", data: { slot: "s", attempt: 1, status: "blocked", suppressed: 6 } },
      { ts: "2026-09-21T00:00:04Z", event: "operator-page", taskId: "T1", data: { slot: "s", attempt: 1, status: "idle", suppressed: 1 } },
    ];
    const journal = join(mkdtempSync(join(tmpdir(), "ops-")), "journal.jsonl");
    writeFileSync(journal, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const before = readFileSync(journal);
    const full = summarizeOperatorPages(events, "run-1");
    const rows = events.flatMap((e, i) => { const r = operatorPageRow(e, i + 1, "run-1"); return r ? [r] : []; });
    const incremental = foldOperatorPages(foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, rows.slice(0, 1)), rows.slice(1));
    expect(incremental).toEqual(full);
    expect(full.groups[0].observedCount).toBe(2);
    expect(full.groups[0].suppressedCount).toBe(10);
    expect(full.groups[0].lines).toEqual([2, 3]);
    expect(full.groups[1]).toMatchObject({ status: "idle", observedCount: 1, suppressedCount: 1, lines: [4] });
    expect(readFileSync(journal).equals(before)).toBe(true);
  });

  it("distinct failures decisions and resolutions retain individual evidence access and rows without suppression metadata keep all raw references, so a distinct failure hidden by grouping or an old row losing its reference fails", () => {
    const rows = [
      row(1, { status: "failed", suppressed: undefined }), row(2, { status: "failed", suppressed: undefined }),
      row(3, { status: "blocked" }), row(4, { status: "resolved", blocker: undefined, requiredAction: undefined, permittedActions: [] }),
      row(5, { status: "failed", park: "gate-fail#2", suppressed: undefined }),
    ];
    const { groups } = foldOperatorPages(EMPTY_OPERATOR_PAGE_SUMMARY, rows);
    expect(groups.map((g) => [g.status, g.lines])).toEqual([
      ["failed", [1, 2]], ["blocked", [3]], ["resolved", [4]], ["failed", [5]],
    ]);
    expect(groups.flatMap((g) => g.lines).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(groups[0]).toMatchObject({ rawOnly: true, observedCount: 2, suppressedCount: 0 });
    expect(groups[1].rawOnly).toBe(false);
    // legacy journal row without `suppressed` still projects and keeps its line
    const legacy = operatorPageRow({ ts: "t", event: "operator-page", taskId: "T9", data: { slot: "s", attempt: 1, status: "blocked" } }, 42, "run-1");
    expect(legacy).toMatchObject({ line: 42, taskId: "T9", park: "s#1" });
    expect(legacy?.suppressed).toBeUndefined();
  });
});
