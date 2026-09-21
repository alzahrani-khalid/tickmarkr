import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ttyInput } from "../helpers/tty-input.js";
import { createElement, type ReactElement } from "react";
import { render } from "ink";
import { describe, expect, test } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import {
  defaultExportPath,
  deriveEvidenceView,
  EvidenceView,
  planEvidenceExport,
  selectTaskReview,
  writeEvidenceExport,
} from "../../src/tui/cockpit/evidence-view.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// every file outside tickmarkr's own state directory, keyed by path, valued by content hash
function snapshotRepo(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(repo, { recursive: true }).map(String).sort()) {
    if (rel === ".tickmarkr" || rel.startsWith(".tickmarkr/")) continue;
    const full = join(repo, rel);
    if (statSync(full).isFile()) out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return out;
}

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function makeInkStreams() {
  const input = ttyInput();
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true; output.columns = 120; output.rows = 40;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  return { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, writes };
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function drawFrame(node: ReactElement) {
  const { input, output, writes } = makeInkStreams();
  const app = render(node, { stdin: input, stdout: output, exitOnCtrlC: false, patchConsole: false, debug: true });
  await wait();
  return {
    frame: () => stripAnsi(writes.at(-1) ?? ""),
    input,
    rerender: async (next: ReactElement) => { app.rerender(next); await wait(); },
    unmount: () => app.unmount(),
  };
}

const ev = (event: string, taskId: string | undefined, data: Record<string, unknown>, ts = "2026-09-05T00:00:00.000Z"): JournalEvent =>
  ({ ts, event, data, ...(taskId ? { taskId } : {}) });

const LONG_REVIEW = Array.from({ length: 200 }, (_, i) => `verdict line ${i + 1}`).join("\n");

// Verbatim adjacency from the real emitter (review.ts:485): the artifact path is followed
// IMMEDIATELY by the message's own closing paren, no space — `; raw saved: <path>) — failing
// closed` — which is exactly what over-captured under the old `\S+` pattern.
const RAW_SAVED_LINE = "raw saved: /artifacts/review-raw-T1.txt) — failing closed";

const baseEvents: JournalEvent[] = [
  ev("run-start", undefined, {}),
  ev("task-dispatch", "T1", { assignment: { adapter: "codex", model: "gpt-5" }, attempt: 0 }),
  ev("gate-result", "T1", { gate: "review", pass: true, reviewer: "codex:gpt-5", details: `${LONG_REVIEW}\n${RAW_SAVED_LINE}` }),
  ev("merge", "T1", { commit: "abc" }),
  ev("task-dispatch", "T2", { assignment: { adapter: "pi", model: "glm-5" }, attempt: 0 }),
  ev("gate-result", "T2", { gate: "review", pass: true, details: "short verdict, no saved artifact" }),
];

describe("evidence-view", () => {
  test("The exported Evidence body consumed by C1 opens a merged task's 200-line review and durable artifact locations by original journal #L, holds a selected historical row while new events arrive with Follow off, and returns to the tail only on Follow. Journal, Report, Stats, Channels and learning preview expose their distinct sections and missing artifacts say missing. A filtered ordinal used as #L, a first-line-only verdict or a newly appended row stealing selection fails.", async () => {
    const model = deriveEvidenceView({
      events: baseEvents,
      reportLines: ["usage floor; dollar total not measurable"],
      statsLines: ["codex:gpt-5 | dispatches 1 | deliveries 1"],
      learningPreview: ["implement pi:sub cheap raw=3 n_eff=2 q=0.71"],
    });

    // T1's review verdict opens by ORIGINAL journal #L, whole (never first-line-only), plus its
    // durable artifact location.
    const t1Review = selectTaskReview(model.journal, "T1")!;
    expect(t1Review.evidence.id).toBe("journal.jsonl#L3"); // the raw journal position, not a filtered index
    expect(t1Review.fullText.split("\n")).toHaveLength(201); // 200 verdict lines + the saved-artifact line
    expect(t1Review.fullText).toContain("verdict line 200"); // whole text — a first-line-only read fails
    expect(t1Review.artifacts).toEqual(["/artifacts/review-raw-T1.txt"]);

    // T2's review carries no durable artifact — missing, never silently omitted or invented.
    const t2Review = selectTaskReview(model.journal, "T2")!;
    expect(t2Review.artifacts).toEqual([]);

    // A filtered subset (only T1's rows) still carries each row's TRUE original #L — never a
    // recomputed ordinal local to the filtered array (index 0 here is journal line 2, not line 1).
    const t1Only = model.journal.filter((row) => row.taskId === "T1");
    expect(t1Only[0]!.evidence.line).toBe(2);
    expect(t1Only[0]!.evidence.line).not.toBe(1);

    // C1 navigation: an inbound focusEvidence target (e.g. Home/Run's "open evidence", or
    // selectTaskReview's row for a merged task) opens directly on that original #L with Follow off
    // — never the tail default — with no remount required.
    const opened = await drawFrame(createElement(EvidenceView, { model, focusEvidence: t1Review.evidence }));
    expect(opened.frame()).toContain(`selected ${t1Review.evidence.id}`);
    expect(opened.frame()).toContain("Follow off");
    expect(opened.frame()).toContain("verdict line 200"); // the whole review opens, not first-line-only
    opened.unmount();

    // Journal, Report, Stats, Channels and learning preview are distinct sections.
    const frame = await drawFrame(createElement(EvidenceView, { model }));
    expect(frame.frame()).toContain("JOURNAL");
    expect(frame.frame()).toContain("missing"); // the held-selection tail row (T2's review) has none
    frame.input.write("\x1B[C"); await wait(); // right arrow -> Report
    expect(frame.frame()).toContain("usage floor; dollar total not measurable");
    frame.input.write("\x1B[C"); await wait(); // -> Stats
    expect(frame.frame()).toContain("codex:gpt-5 | dispatches 1 | deliveries 1");
    frame.input.write("\x1B[C"); await wait(); // -> Channels
    expect(frame.frame()).toContain("worker: 1, review: 1, consult: 0");
    frame.input.write("\x1B[C"); await wait(); // -> Learning preview
    expect(frame.frame()).toContain("implement pi:sub cheap raw=3 n_eff=2 q=0.71");
    frame.input.write("\x1B[D"); frame.input.write("\x1B[D"); frame.input.write("\x1B[D"); frame.input.write("\x1B[D");
    await wait(); // back to Journal
    frame.unmount();

    // Follow off holds a selected historical row while new events arrive; a newly appended row
    // never steals it. Follow on returns the selection to the tail.
    const growable = await drawFrame(createElement(EvidenceView, { model }));
    expect(growable.frame()).toContain("selected journal.jsonl#L6"); // default: Follow on, tail selected
    growable.input.write("f"); await wait(); // Follow off
    growable.input.write("\x1B[A"); await wait(); // up arrow: select T2's review's predecessor row (#L5)
    growable.input.write("\x1B[A"); await wait(); // up arrow again: #L4 (T1 merge)
    expect(growable.frame()).toContain("selected journal.jsonl#L4");
    expect(growable.frame()).toContain("Follow off");

    const grownEvents = [...baseEvents, ev("task-done", "T3", {}), ev("run-end", undefined, { done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [] })];
    const grownModel = deriveEvidenceView({ events: grownEvents });
    await growable.rerender(createElement(EvidenceView, { model: grownModel }));
    // the held selection survived the new rows arriving — never recomputed to the new tail
    expect(growable.frame()).toContain("selected journal.jsonl#L4");
    expect(growable.frame()).not.toContain("selected journal.jsonl#L8");

    growable.input.write("f"); await wait(); // Follow on: snaps back to the (new) tail
    expect(growable.frame()).toContain("selected journal.jsonl#L8");
    expect(growable.frame()).toContain("Follow on");
    growable.unmount();
  });

  test("Evidence export writes the displayed run's full record to the selected confirmed path and returns its actual path and byte count after successful write. Default beside-spec naming includes the full run ID only when the source spec is unambiguous. An existing destination or ambiguous source requires explicit choice/overwrite confirmation. Seeded content survives cancel/write failure, while confirmed export changes it. Production report --md remains stdout, --bundle remains explicit write and compare retains environment mismatch warnings. Reporting success before write or silently replacing a file fails.", async () => {
    const dir = makeTestTempDir("tickmarkr-evidence-export-");

    // unambiguous source spec: beside-spec naming includes the full run ID
    const unambiguous = defaultExportPath({ runId: "run-20260905-000000-1", specPaths: ["specs/v2.5.0-one-cockpit.spec.md"], specDir: dir });
    expect(unambiguous).toBe(join(dir, "v2.5.0-one-cockpit.spec.run-20260905-000000-1.report.md"));

    // ambiguous source (zero or multiple specs) never guesses a destination
    expect(defaultExportPath({ runId: "run-1", specPaths: [], specDir: dir })).toBeUndefined();
    expect(defaultExportPath({ runId: "run-1", specPaths: ["a.spec.md", "b.spec.md"], specDir: dir })).toBeUndefined();

    // an existing destination requires explicit overwrite confirmation before any write happens
    const path = join(dir, "existing.report.md");
    writeFileSync(path, "SEEDED CONTENT\n");
    const plan = planEvidenceExport(path, { existsSync });
    expect(plan).toEqual({ path, exists: true });

    // cancel: withholding confirmation is a PRECONDITION the writer itself enforces — writeFileSync
    // is never even invoked, so seeded content survives untouched. No confirmedOverwrite arg at all
    // (the caller skipped the confirm step) must fail exactly the same way as an explicit false.
    const cancelCalls: string[] = [];
    const cancelled = writeEvidenceExport(path, "NEW RECORD\n", {
      existsSync,
      writeFileSync: () => { cancelCalls.push("attempted"); },
    });
    expect(cancelled).toEqual({ ok: false, reason: "exists — overwrite not confirmed" });
    expect(cancelCalls).toEqual([]); // the underlying write was never attempted
    expect(readFileSync(path, "utf8")).toBe("SEEDED CONTENT\n");

    // a fresh (non-existing) destination needs no confirmation — the requirement is scoped to an
    // existing destination only, never a blanket gate on every write
    const freshPath = join(dir, "fresh.report.md");
    const freshOutcome = writeEvidenceExport(freshPath, "FRESH\n", { existsSync, writeFileSync });
    expect(freshOutcome).toEqual({ ok: true, path: freshPath, bytes: Buffer.byteLength("FRESH\n", "utf8") });
    expect(readFileSync(freshPath, "utf8")).toBe("FRESH\n");

    // a write failure (confirmed overwrite, but the underlying write throws) leaves the seeded
    // content untouched and reports failure, never a fabricated success — and never before the
    // underlying write actually ran
    const order: string[] = [];
    const failing = writeEvidenceExport(path, "NEW RECORD\n", {
      existsSync,
      writeFileSync: () => { order.push("attempted"); throw new Error("disk full"); },
    }, true);
    expect(failing).toEqual({ ok: false, reason: "disk full" });
    expect(order).toEqual(["attempted"]);
    expect(readFileSync(path, "utf8")).toBe("SEEDED CONTENT\n"); // unchanged by the failed attempt

    // a confirmed export actually changes the destination, and reports its ACTUAL path and byte
    // count only after the write lands
    const record = "# tickmarkr engagement\n\nrun-20260905-000000-1\n";
    const confirmed = writeEvidenceExport(path, record, { existsSync, writeFileSync }, true);
    expect(confirmed).toEqual({ ok: true, path, bytes: Buffer.byteLength(record, "utf8") });
    expect(readFileSync(path, "utf8")).toBe(record); // seeded content is gone — a confirmed export changed it

    // Production report --md remains stdout (no file write of its own); --bundle remains an
    // explicit write; compare retains its environment-mismatch warning.
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-evidence-export");
    j.append("run-start", undefined, { baseRef: "abc" });
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 });
    j.append("gate-result", "T1", { gate: "test", pass: true, details: "exit 0" });
    j.append("merge", "T1", { commit: "deadbeef" });
    j.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });
    const baseline = Journal.create(repo, "run-evidence-baseline");
    baseline.append("run-start", undefined, { baseRef: "abc" });
    baseline.append("run-end", undefined, { done: [], failed: [], human: [], blocked: [], pending: [] });

    // --md stays stdout-only; its byte-identity oracle is the dedicated test below (OBS-1056 (1))
    const md = await report(["run-evidence-export", "--md"], repo);
    expect(md).toContain("# tickmarkr engagement");

    const bundlePath = join(dir, "proof-bundle.json");
    expect(existsSync(bundlePath)).toBe(false);
    await report(["run-evidence-export", "--bundle", bundlePath], repo);
    expect(existsSync(bundlePath)).toBe(true); // --bundle is the explicit write path

    const compared = await report(["run-evidence-export", "--compare", "run-evidence-baseline"], repo);
    expect(compared).toMatch(/comparability caveat.*not apples-to-apples/s);
  });

  test("test: report --md returns Markdown containing the engagement heading and the selected run evidence while leaving every file that existed before it byte-identical and creates no report file anywhere in the repository, checked over a snapshot that excludes tickmarkr's own state directory, so an empty report fails and a run-state write under .tickmarkr no longer reds the oracle while a report file written beside the spec still does", async () => {
    const repo = makeRepo({ "keep.txt": "x\n", "specs/v1-thing.spec.md": "# spec\n" });
    const j = Journal.create(repo, "run-md-oracle");
    j.append("run-start", undefined, { baseRef: "abc" });
    j.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1" }, attempt: 0 });
    j.append("gate-result", "T1", { gate: "test", pass: true, details: "exit 0" });
    j.append("merge", "T1", { commit: "deadbeef" });
    j.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });

    const reportFiles = () => readdirSync(repo, { recursive: true }).map(String).filter((p) => /report\.md$/.test(p));
    const before = snapshotRepo(repo);
    const md = await report(["run-md-oracle", "--md"], repo);
    expect(md).toContain("# tickmarkr engagement"); // stdout text, not a side-effect file
    expect(md).toContain("run-md-oracle");
    expect(md).toContain("deadbeef"); // the selected run's own evidence — an empty report fails here
    expect(snapshotRepo(repo)).toEqual(before); // every pre-existing file byte-identical
    expect(reportFiles()).toEqual([]); // no report file anywhere, .tickmarkr included

    // positive controls for the oracle itself: run-state under .tickmarkr is invisible to it ...
    writeFileSync(join(repo, ".tickmarkr", "run-state.json"), "{}\n");
    expect(snapshotRepo(repo)).toEqual(before);
    // ... a report file beside the spec, or a rewritten pre-existing file, still reds it
    writeFileSync(join(repo, "specs", "run-md-oracle.report.md"), md);
    expect(snapshotRepo(repo)).not.toEqual(before);
    expect(reportFiles()).toEqual(["specs/run-md-oracle.report.md"]);
    rmSync(join(repo, "specs", "run-md-oracle.report.md"));
    writeFileSync(join(repo, "keep.txt"), "y\n");
    expect(snapshotRepo(repo)).not.toEqual(before);
  });

  test("Evidence rows carry the tracked journal rows' own line identities so a blank line and a malformed complete line before a review leave its #L equal to its physical position, and a review-leg2 row's recorded artifact path is listed as its durable artifact", () => {
    const rows = [
      { line: 1, source: "journal.jsonl", id: "journal.jsonl#L1", event: ev("run-start", undefined, {}) },
      { line: 2, source: "journal.jsonl", id: "journal.jsonl#L2", raw: "" },
      { line: 3, source: "journal.jsonl", id: "journal.jsonl#L3", raw: "malformed line {", error: "Unexpected token" },
      {
        line: 4,
        source: "journal.jsonl",
        id: "journal.jsonl#L4",
        event: ev("review-leg2", "T1", {
          pass: true,
          author: "codex:gpt-5",
          artifactPath: "/artifacts/verify-results.json",
          details: "leg2 review approved",
        }),
      },
    ];

    const model = deriveEvidenceView({ rows });
    expect(model.journal).toHaveLength(2);

    const leg2Review = selectTaskReview(model.journal, "T1");
    expect(leg2Review).toBeDefined();
    expect(leg2Review!.evidence.line).toBe(4);
    expect(leg2Review!.evidence.id).toBe("journal.jsonl#L4");
    expect(leg2Review!.artifacts).toEqual(["/artifacts/verify-results.json"]);
  });

  test("the production export writer serializes the displayed run's full record and lands it by temp-file rename with exclusive create, so a write that fails after emitting part of the record leaves the seeded destination byte-identical, a destination that appears between plan and write without confirmation is refused, and a confirmed write returns the actual path and on-disk byte count", () => {
    const dir = makeTestTempDir("tickmarkr-atomic-export-");
    const destination = join(dir, "exported-record.md");
    writeFileSync(destination, "ORIGINAL SEEDED CONTENT\n");

    // Write failure after emitting part of the record leaves seeded destination byte-identical
    const failingResult = writeEvidenceExport(destination, "PARTIAL UNFINISHED NEW RECORD\n", {
      existsSync,
      writeFileSync: (tmp, data) => {
        writeFileSync(tmp, data.slice(0, 7));
        throw new Error("simulated disk failure mid-write");
      },
    }, true);
    expect(failingResult).toEqual({ ok: false, reason: "simulated disk failure mid-write" });
    expect(readFileSync(destination, "utf8")).toBe("ORIGINAL SEEDED CONTENT\n");

    // Destination that appears between plan and write without confirmation is refused
    const freshTarget = join(dir, "appeared-target.md");
    const plan = planEvidenceExport(freshTarget, { existsSync });
    expect(plan.exists).toBe(false);
    writeFileSync(freshTarget, "SNEAKY APPEARED CONTENT\n");
    const unconfirmedWrite = writeEvidenceExport(freshTarget, "NEW RECORD\n", { existsSync, writeFileSync }, false);
    expect(unconfirmedWrite).toEqual({ ok: false, reason: "exists — overwrite not confirmed" });
    expect(readFileSync(freshTarget, "utf8")).toBe("SNEAKY APPEARED CONTENT\n");

    // Pre-existing temp path with exclusive create is refused rather than clobbered
    const collidingTemp = join(dir, "colliding-temp.tmp");
    writeFileSync(collidingTemp, "PRE-EXISTING TEMP CONTENT\n");
    let optionsPassed: { flag?: string } | undefined;
    const collidingResult = writeEvidenceExport(destination, "NEW RECORD\n", {
      existsSync,
      writeFileSync: (p, data, options) => {
        optionsPassed = options;
        writeFileSync(collidingTemp, data, options);
      },
    }, true);
    expect(collidingResult.ok).toBe(false);
    expect(collidingResult.reason).toMatch(/EEXIST/);
    expect(optionsPassed).toEqual({ flag: "wx" });
    expect(readFileSync(collidingTemp, "utf8")).toBe("PRE-EXISTING TEMP CONTENT\n");

    // Confirmed write lands the file and returns the actual path and on-disk byte count
    const fullRecord = "# tickmarkr engagement\n\nfull serialized production record\n";
    const confirmedWrite = writeEvidenceExport(destination, fullRecord, { existsSync, writeFileSync }, true);
    expect(confirmedWrite).toEqual({
      ok: true,
      path: destination,
      bytes: statSync(destination).size,
    });
    expect(readFileSync(destination, "utf8")).toBe(fullRecord);
  });
});


test("test: the Evidence view shows each operator-page group with its first and last evidence its visible and suppressed counts and every raw source line reachable while the raw journal section still lists every historical flood row, so a group that hides a raw row fails", async () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({
    line: i + 4,
    event: ev("operator-page", "T1", {
      park: "gate-fail#0", status: i < 10 ? "blocked" : "resolved",
      owner: i < 11 ? "operator" : "reviewer",
      ...(i === 0 ? {} : { suppressed: 2 }), summary: `flood-row-${i}`,
    }, `2026-09-21T00:00:${String(i).padStart(2, "0")}.000Z`),
  }));
  // Physical gaps must not turn references into filtered display ordinals.
  const model = deriveEvidenceView({ rows: [{ line: 2, error: "malformed", raw: "{" }, ...pages] });
  expect(model.operatorPages.map(g => [g.lines, g.observedCount, g.suppressedCount, g.rawOnly])).toEqual([
    [pages.slice(0, 10).map(r => r.line), 10, 18, true],
    [[pages[10]!.line], 1, 2, false],
    [[pages[11]!.line], 1, 2, false],
  ]);
  expect(model.journal.map(r => r.evidence.line)).toEqual(pages.map(r => r.line));
  const selected: string[] = [];
  const frame = await drawFrame(createElement(EvidenceView, { model, onSelect: e => selected.push(e.id) }));
  try {
    const body = frame.frame();
    expect(body).toContain("RAW JOURNAL");
    expect(body).toContain("OPERATOR PAGE GROUPS");
    // Inspect each rendered group independently: the raw journal must not satisfy a
    // missing group reference, nor may another group's timestamps/counts stand in for it.
    const groupsSection = body.split("OPERATOR PAGE GROUPS")[1]!.split("SELECTED EVIDENCE")[0]!;
    const groups = groupsSection.split(/T1 · gate-fail#0 · (?:blocked|resolved)/).slice(1);
    expect(groups).toHaveLength(3);
    const expectedGroups = [pages.slice(0, 10), [pages[10]!], [pages[11]!]];
    for (const [index, rows] of expectedGroups.entries()) {
      const group = groups[index]!;
      expect(group).toContain(`first ${rows[0]!.event.ts}`);
      expect(group).toContain(`last ${rows.at(-1)!.event.ts}`);
      expect(group).toContain(`visible ${rows.length} · suppressed ${index === 0 ? 18 : 2}`);
      expect(group.includes("raw-only (suppression unrecorded)")).toBe(index === 0);
      expect([...group.matchAll(/#L(\d+)\b/g)].map(match => Number(match[1])))
        .toEqual(rows.map(row => row.line));
    }
    const rawSection = body.split("RAW JOURNAL")[1]!.split("OPERATOR PAGE GROUPS")[0]!;
    for (let i = 0; i < pages.length; i++) expect(rawSection).toContain(`flood-row-${i}`);
    // Traverse every historical row using the production input handler, including those coalesced.
    for (const page of [...pages].reverse()) {
      // Wait for the DRAWN selection, not for a fixed sleep: a 20 ms wait is host-speed-bound and
      // reddened both public CI jobs of v2.5.7 (run 35577514076).
      for (let i = 0; i < 100 && !frame.frame().includes(`selected journal.jsonl#L${page.line}`); i++) await wait();
      expect(frame.frame()).toContain(`selected journal.jsonl#L${page.line}`);
      expect(frame.frame()).toContain(`"summary": "${page.event.data.summary}"`);
      frame.input.write("\r"); await wait();
      frame.input.write("\x1B[A"); await wait();
    }
    expect(selected).toEqual([...pages].reverse().map(p => `journal.jsonl#L${p.line}`));
  } finally { frame.unmount(); }
});


test("Enter opens the row the operator navigated to even when no frame was drawn between the arrow and the Enter, so a handler acting on the previous render's selection fails", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    line: i + 3,
    event: ev("operator-page", "T1", { park: "gate-fail#0", status: "blocked", owner: "operator", summary: `row-${i}` },
      `2026-09-21T00:00:${String(i).padStart(2, "0")}.000Z`),
  }));
  const model = deriveEvidenceView({ rows });
  const selected: string[] = [];
  const frame = await drawFrame(createElement(EvidenceView, { model, onSelect: e => selected.push(e.id) }));
  try {
    // Two arrows and an Enter in one tick: no render, and no re-subscribed handler, in between.
    frame.input.write("\x1B[A"); frame.input.write("\x1B[A"); frame.input.write("\r");
    await wait(50);
    expect(selected).toEqual(["journal.jsonl#L6"]);
    expect(frame.frame()).toContain("selected journal.jsonl#L6");
  } finally { frame.unmount(); }
});
