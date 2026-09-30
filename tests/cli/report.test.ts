import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { wallBudget, WALL_PRIORITY } from "../../src/run/wall-budget.js";
import { makeRepo } from "../helpers/tmprepo.js";

// v1.53 T5: supersession renders in the report header on BOTH runs — `superseded by` from the prior
// run's appended superseded event, `supersedes` from the superseding run's own run-start stamp.
describe("v1.53 supersession in the report header", () => {
  test("the report header of a superseded run names the superseding run", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-old");
    j.append("run-start", undefined, { baseRef: "x" });
    j.append("superseded", undefined, { by: "run-new" });
    const out = await report(["run-old"], repo);
    expect(out.split("\n\n")[0]).toContain("superseded by run-new"); // header block, before any section
    const md = await report(["run-old", "--md"], repo);
    expect(md).toContain("**superseded by:** run-new");
  });

  test("the report header of the superseding run names the run it supersedes", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-new");
    j.append("run-start", undefined, { baseRef: "x", supersedes: "run-old" });
    const out = await report(["run-new"], repo);
    expect(out.split("\n\n")[0]).toContain("supersedes run-old");
    const md = await report(["run-new", "--md"], repo);
    expect(md).toContain("**supersedes:** run-old");
  });
});

describe("tickmarkr report --md usage and efficiency", () => {
  test("renders measured and unmetered channels, deterministic efficiency, and routing evidence", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const j = Journal.create(repo, "run-record");
    writeFileSync(join(j.dir, "journal.jsonl"), [
      { ts: "2026-07-13T10:00:00.000Z", event: "run-start", data: {} },
      { ts: "2026-07-13T10:00:01.000Z", event: "task-dispatch", taskId: "T1", data: { provenance: "floor cheap (config floors), marginal-cost auto (via learned score 0.750 (n=6) over api:static 0.100)" } },
      { ts: "2026-07-13T10:00:02.000Z", event: "route-deviation", taskId: "T1", data: { static: "api:static", chosen: "api:metered", score: 0.75, staticScore: 0.1, n: 6 } },
      { ts: "2026-07-13T10:00:03.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: false } },
      { ts: "2026-07-13T10:00:04.000Z", event: "gate-result", taskId: "T1", data: { gate: "build", pass: false } },
      { ts: "2026-07-13T10:00:05.000Z", event: "consult-verdict", taskId: "T1", data: { action: "retry" } },
      { ts: "2026-07-13T10:00:06.000Z", event: "escalation", taskId: "T1", data: { step: "escalate" } },
      { ts: "2026-07-13T10:01:30.000Z", event: "run-end", data: {} },
    ].map(JSON.stringify).join("\n") + "\n");
    j.telemetry({ taskId: "T1", shape: "implement", adapter: "api", model: "metered", channel: "api", attempts: 1, outcome: "done", durationMs: 1, firstAttemptOk: true, tokens: { input: 1_000_000, output: 1_000_000 }, meteredAttempts: 1 });
    j.telemetry({ taskId: "T2", shape: "implement", adapter: "claude-code", model: "sub", channel: "sub", attempts: 2, outcome: "done", durationMs: 1, firstAttemptOk: false, tokens: { input: 1_000_000, output: 0 }, meteredAttempts: 2 });
    j.telemetry({ taskId: "T3", shape: "implement", adapter: "legacy", model: "unmetered", channel: "sub", attempts: 4, outcome: "done", durationMs: 1 });
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `cost:
  models:
    metered: { inPerMtok: 5, outPerMtok: 25, rateDate: 2026-07-13 }
    sub: { inPerMtok: 3, outPerMtok: 15, rateDate: 2026-07-13 }
  subs:
    claude-code: { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 }
`);

    const journalBefore = readFileSync(join(j.dir, "journal.jsonl"));
    const telemetryBefore = readFileSync(join(j.dir, "telemetry.jsonl"));
    const out = await report(["run-record", "--md"], repo);

    expect(readFileSync(join(j.dir, "journal.jsonl"))).toEqual(journalBefore);
    expect(readFileSync(join(j.dir, "telemetry.jsonl"))).toEqual(telemetryBefore);
    expect(out).toContain("## Usage & efficiency");
    expect(out).toMatch(/api:metered[^\n]*tokens: in 1,000,000[^\n]*\$30[^\n]*basis:[^\n]*2026-07-13/);
    expect(out).toMatch(/claude-code:sub[^\n]*windows: 2[^\n]*\$0\.333333–\$1[^\n]*basis:/);
    expect(out).toMatch(/legacy:unmetered[^\n]*attempts\/windows: 4[^\n]*not measurable/);
    expect(out).toContain("**first-attempt rate (engagement-local telemetry):** 1/2 (50%)");
    expect(out).toContain("**gate failures:** build: 2");
    expect(out).toContain("**consults:** 1");
    expect(out).toContain("**escalations:** 1");
    expect(out).toContain("**wall-clock:** 1m 30s");
    expect(out).toContain("**routing:** floor cheap (config floors), marginal-cost auto (via learned score 0.750 (n=6) over api:static 0.100)");
    expect(out).toContain("**route deviation:** api:metered learned score 0.75 (n=6) vs static api:static 0.1");
  });
});


test("test: the report's review row for an approval that closed carried materials names the resolved fingerprints beside the reviewer and an approval that carried none prints no resolved list, so a report that renders the approval without the closure it certified fails", async () => {
  const repo = makeRepo({ "keep.txt": "x\n" });
  const journal = Journal.create(repo, "run-closure");
  const resolved = ["review:material|src/pointer.ts|register", "review:material|src/model.ts|reconcile"];
  for (const [taskId, ids] of [["T1", resolved], ["T2", []]] as const) {
    journal.append("task-dispatch", taskId, { adapter: "codex", model: "gpt-5" });
    journal.append("gate-result", taskId, {
      gate: "review", pass: true, reviewer: "claude-code:opus", resolved: ids,
      details: "reviewer claude-code:opus (vendor: anthropic; provider: anthropic): approved",
    });
  }
  const md = await report(["run-closure", "--md"], repo);
  const rows = md.split("\n").filter((line) => line.includes("- review: pass"));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("reviewer claude-code:opus");
  expect(rows[0]).toContain("approved");
  for (const id of resolved) expect(rows[0]).toContain(id);
  expect(rows[1]).toContain("approved");
  expect(rows[1]).not.toContain("resolved:");
});

// OBS-1201: a hundred-second journal whose buckets are known by construction. Gate rows are journaled
// when their round settles (acceptance, review and test share t70), so each span is anchored at its
// gate's first phase-start. The test gate's measured 43s includes the 3s it queued for its command
// (t17–t20, under T2's worker), so its service is t20–t60. Every copy below would move a bucket if
// it were counted.
describe("OBS-1201 disjoint wall budget", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-28T00:00:00.000Z") + s * 1_000).toISOString();
  const graph = validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["wall-budget"], hash: "wall-budget" },
    tasks: ["T1", "T2"].map((id) => ({ id, title: `task ${id}`, goal: `task ${id}`, shape: "implement", complexity: 3, acceptance: ["a"], status: "done" })),
  });
  const copies: JournalEvent[] = [
    { ts: t(80), event: "gate-result", taskId: "T2", data: { gate: "test", pass: true, reused: true, durationMs: 43_000, evidenceReceipt: { invocationId: "n-test" } } },
    { ts: t(85), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, replayedFromAttempt: 0, durationMs: 43_000, nonce: "n-test" } },
    { ts: t(88), event: "gate-result", taskId: "T2", data: { gate: "build", pass: true, durationMs: 5_000, nonce: "n-build" } },
  ];
  const journal: JournalEvent[] = [
    { ts: t(0), event: "run-start", data: { baseRef: "base", graphDefinitionHash: graphDefinitionHash(graph) } },
    { ts: t(0), event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0, workerDispatchOrdinal: 0 } },
    { ts: t(0), event: "worker-launch", taskId: "T1", data: { attempt: 0 } },
    { ts: t(5), event: "task-dispatch", taskId: "T2", data: { assignment: { adapter: "fake", model: "fake-2", channel: "sub", tier: "cheap" }, attempt: 0, workerDispatchOrdinal: 0 } },
    { ts: t(5), event: "worker-launch", taskId: "T2", data: { attempt: 0 } },
    { ts: t(17), event: "worker-result", taskId: "T1", data: { ok: true } },
    { ts: t(17), event: "phase-start", taskId: "T1", data: { phase: "gates" } },
    { ts: t(17), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
    { ts: t(17), event: "suite-wait", taskId: "T1", data: { count: 1, gate: "test" } },
    { ts: t(19), event: "suite-wait", taskId: "T1", data: { count: 2, gate: "test" } },
    { ts: t(20), event: "worker-result", taskId: "T2", data: { ok: true } },
    { ts: t(20), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test", admitted: true } },
    { ts: t(50), event: "suite-wait", taskId: "T2", data: { count: 1 } },
    { ts: t(60), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
    { ts: t(60), event: "phase-start", taskId: "T1", data: { phase: "review", gate: "review" } },
    { ts: t(70), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 10_000 } },
    { ts: t(70), event: "gate-result", taskId: "T1", data: { gate: "review", pass: true, durationMs: 8_000 } },
    { ts: t(70), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 43_000, nonce: "n-test" } },
    { ts: t(75), event: "suite-admitted", taskId: "T2", data: {} },
    { ts: t(75), event: "phase-start", taskId: "T2", data: { phase: "gates" } },
    { ts: t(75), event: "phase-start", taskId: "T2", data: { phase: "gate:build", gate: "build" } },
    { ts: t(80), event: "gate-result", taskId: "T2", data: { gate: "build", pass: true, durationMs: 5_000, nonce: "n-build" } },
    ...copies,
    { ts: t(90), event: "exit-cause", data: { cause: "deliberate", signal: "SIGTERM" } },
    { ts: t(95), event: "task-approved", taskId: "T2", data: { by: "operator", reason: "outside the engagement" } },
    { ts: t(100), event: "run-resume", data: { pid: 1 } },
    { ts: t(100), event: "run-end", data: { done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [] } },
  ];
  const seconds = (text: string) => text.trim().split(/\s+/u)
    .reduce((sum, part) => sum + Number(part.slice(0, -1)) * (part.endsWith("h") ? 3_600 : part.endsWith("m") ? 60 : 1), 0);
  // The same parse for every surface: "<bucket>[:**] <span> (<pct>%) · task-time <span>".
  const bucketsOf = (out: string) => Object.fromEntries(WALL_PRIORITY.map((bucket) => {
    const match = new RegExp(`(?:^|[\\s*])${bucket}(?::\\*\\*)?\\s+(\\d[\\dhms ]*?) \\(\\d+%\\) · task-time (\\d[\\dhms ]*?)(?: ·|$)`, "mu").exec(out);
    expect(match, `${bucket} in\n${out}`).not.toBeNull();
    return [bucket, { exposed: seconds(match![1]!), task: seconds(match![2]!) }];
  }));
  const residualOf = (out: string) => seconds(/residual(?::\*\*)?\s+(\d[\dhms ]*?) \(\d+%\)/mu.exec(out)![1]!);

  test("production report/status partitions a hundred-second journal as interruption10 test40 semantics10 worker20 queue5 other-gate5 residual10 versus concurrent task-hours, so copied evidence adding service or wall buckets exceeding one hundred fails", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, graph);
    const j = Journal.create(repo, "run-wall");
    writeFileSync(join(j.dir, "journal.jsonl"), journal.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const surfaces = {
      text: await report(["run-wall"], repo),
      md: await report(["run-wall", "--md"], repo),
      status: await status(["run-wall"], repo),
    };
    for (const [surface, out] of Object.entries(surfaces)) {
      const buckets = bucketsOf(out);
      expect(Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, v.exposed])), surface).toEqual({
        interruption: 10, test: 40, semantics: 10, worker: 20, queue: 5, "other-gate": 5,
      });
      expect(residualOf(out), surface).toBe(10);
      // Exposed wall is disjoint: it sums to the hundred-second window, never more.
      expect(Object.values(buckets).reduce((sum, v) => sum + v.exposed, 0) + residualOf(out), surface).toBe(100);
      // Task-time keeps concurrent service apart: two workers, two waits, acceptance beside review.
      expect(Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, v.task])), surface).toEqual({
        interruption: 10, test: 40, semantics: 18, worker: 32, queue: 28, "other-gate": 5,
      });
      expect(Object.values(buckets).reduce((sum, v) => sum + v.task, 0), surface).toBeGreaterThan(100);
      expect(out, surface).toContain("fresh 4 · replay 2 · reuse 1 · unknown 0");
    }
    expect(surfaces.md).toMatch(/\*\*window:\*\* 1m 40s — each instant counted once, by priority interruption › test › semantics › worker › queue › other-gate › residual/u);
    expect(surfaces.status).toContain("wall budget 1m 40s");

    // The copies are inert: removing them changes no span, only the evidence tally.
    const without = wallBudget(journal.filter((e) => !copies.includes(e)))!;
    const withCopies = wallBudget(journal)!;
    expect(withCopies.exposedMs).toEqual(without.exposedMs);
    expect(withCopies.taskMs).toEqual(without.taskMs);
    expect(without.evidence).toEqual({ fresh: 4, replay: 0, reuse: 0, unknown: 0 });
    expect(withCopies.wallMs).toBe(100_000);
  });

  // CG1: the lead is read off the SAME partition — never the task-time sum (2m 13s here) posing as elapsed.
  test("status and report lead using finished/time/needs-you facts from the existing hundred-second wall partition; plain output fits configured 80 or 110 columns and retains graph-comparability tip-verdict or supersession facts rather than summing concurrent task time into elapsed time", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, graph);
    const j = Journal.create(repo, "run-wall");
    const ended = journal.map((e) => e.event === "run-end" ? { ...e, data: { ...e.data, tipVerify: "passed" } } : e);
    writeFileSync(join(j.dir, "journal.jsonl"), [...ended, { ts: t(101), event: "superseded", data: { by: "run-next" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const time = "time 1m 40s wall, each instant once: test 40s · worker 20s · interruption 10s";

    const text = (await report(["run-wall"], repo)).split("\n");
    const md = (await report(["run-wall", "--md"], repo)).split("\n");
    // The record's own tip reading leads beside finished work, exactly as its verification line states it.
    const tip = /\*\*verification:\*\* (\w+)/u.exec(md.join("\n"))![1]!.toLowerCase();
    expect(text.slice(0, 3)).toEqual([
      `finished 2/2 done · tip verify ${tip} · end-to-end first pass 0/2`,
      time,
      "needs you: outstanding 0 · 0 parked · 0 failed",
    ]);
    expect(md.slice(0, 3)).toEqual(text.slice(0, 3).map((line) => `- ${line}`));
    // --bundle's receipt follows the lead on both report surfaces, never pushing needs you off line three.
    const bundlePath = join(j.dir, "bundle.json");
    const bundled = { text: (await report(["run-wall", "--bundle", bundlePath], repo)).split("\n"), md: (await report(["run-wall", "--md", "--bundle", bundlePath], repo)).split("\n") };
    expect(bundled.text.slice(0, 4)).toEqual([...text.slice(0, 3), `wrote proof bundle → ${bundlePath}`]);
    expect(bundled.md.slice(0, 6)).toEqual([...md.slice(0, 4), `wrote proof bundle → ${bundlePath}`, "# tickmarkr engagement"]);
    for (const out of [text, md]) {
      expect(out.join("\n")).not.toContain("2m 13s"); // the concurrent task-time sum is never the elapsed time
      expect(out.join("\n")).toMatch(/superseded by:?\*{0,2} run-next/u);
    }

    // A baseline for --compare that records no environment identity (its caveat is the widest compare row),
    // and a bundle path long enough to overflow either width.
    writeFileSync(join(Journal.create(repo, "run-wall-base").dir, "journal.jsonl"), journal.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const longBundle = join(j.dir, `proof-bundle-${"x".repeat(96)}.json`);
    for (const columns of [80, 110]) {
      const cols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
      try {
        const lines = (await status(["run-wall"], repo)).split("\n");
        // EVERY plain row fits the configured width: the lead, the header, each task row and summary, the wall section.
        for (const line of lines) expect(cellWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
        // finished, time and needs you are the first three physical lines at every width; the lead keeps every
        // fact whole: at 80 columns the supersession fact moves to a continuation row AFTER them, never dropped.
        const headerAt = lines.findIndex((line) => line.startsWith("tickmarkr status"));
        expect(lines.slice(0, headerAt), `${columns}`).toEqual([
          columns === 80
            ? "finished 2/2 done · tip verify passed · end-to-end first pass 0/2"
            : "finished 2/2 done · tip verify passed · end-to-end first pass 0/2 · superseded by run-next",
          time,
          "needs you: outstanding 0 · 0 parked · 0 failed",
          ...(columns === 80 ? ["  finished: superseded by run-next"] : []),
        ]);
        expect(lines.some((line) => line.startsWith("  wall budget 1m 40s")), `${columns}`).toBe(true);
        // The header the lead sits above, read back across its wrapped rows, keeps every comparability, supersession and verdict fact.
        const header = lines.slice(headerAt, lines.findIndex((line) => line.startsWith("  gates:"))).join(" ").replace(/\s+/gu, " ");
        expect(header).toContain("superseded by run-next");
        expect(header).toContain("verify passed");
        expect(header).not.toContain("graph not comparable");
        // Report text holds the same width over its COMPLETE output — the lead, the engagement-local telemetry
        // heading and the wall window row each wrap beneath their own indent, never dropping a fact.
        const plain = (await report(["run-wall"], repo)).split("\n");
        for (const line of plain) expect(cellWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
        expect(plain.slice(0, 3).map((line) => line.split(" ")[0]), `${columns}`).toEqual(["finished", "time", "needs"]);
        const whole = plain.join(" ").replace(/\s+/gu, " ");
        expect(whole).toContain("engagement summary — audit trail: engagement-local telemetry, attempts restart at every resume");
        expect(whole).toContain(`window 1m 40s — each instant counted once, by priority ${WALL_PRIORITY.join(" › ")} › residual; task-time sums concurrent spans`);
        expect(whole).toContain("superseded by run-next");
        // --bundle's receipt and --compare's output are rows of the same complete output: a receipt naming a
        // long path and the comparability caveat each wrap within the width, after the lead, no fact dropped.
        const extras = (await report(["run-wall", "--bundle", longBundle, "--compare", "run-wall-base"], repo)).split("\n");
        for (const line of extras) expect(cellWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
        expect(extras.slice(0, 3).map((line) => line.split(" ")[0]), `${columns}`).toEqual(["finished", "time", "needs"]);
        const receiptAt = extras.findIndex((line) => line.startsWith("wrote proof bundle → "));
        expect(receiptAt, `${columns}`).toBeGreaterThanOrEqual(3);
        expect(receiptAt, `${columns}`).toBeLessThan(extras.indexOf("tickmarkr engagement — run-wall"));
        const squeezed = extras.join("").replace(/\s+/gu, "");
        expect(squeezed).toContain(`wroteproofbundle→${longBundle}`.replace(/\s+/gu, ""));
        expect(squeezed).toContain("comparabilitycaveat—oneorbothrunslackarecordedenvironmentidentity;notapples-to-apples");
      } finally {
        if (cols) Object.defineProperty(process.stdout, "columns", cols);
        else delete (process.stdout as { columns?: number }).columns;
      }
    }

    // needs you reads the CURRENT lifecycle: a run-end naming a park and a failure the task rows never
    // wrote counts both, and a later merge after the resume moves its task on.
    const summaryOnly = makeRepo({ "keep.txt": "x\n" });
    saveGraph(summaryOnly, graph);
    const summaryRows: JournalEvent[] = [
      journal[0]!, journal[1]!, journal[3]!,
      { ts: t(10), event: "run-end", data: { done: [], failed: ["T2"], human: ["T1"], blocked: [], pending: [] } },
    ];
    const sj = Journal.create(summaryOnly, "run-summary");
    writeFileSync(join(sj.dir, "journal.jsonl"), summaryRows.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const needsYou = async () => [
      (await report(["run-summary"], summaryOnly)).split("\n")[2],
      (await report(["run-summary", "--md"], summaryOnly)).split("\n")[2],
      (await status(["run-summary"], summaryOnly)).split("\n")[2],
    ];
    expect(await needsYou()).toEqual(["needs you: outstanding 0 · 1 parked · 1 failed", "- needs you: outstanding 0 · 1 parked · 1 failed", "needs you: outstanding 0 · 1 parked · 1 failed"]);
    appendFileSync(join(sj.dir, "journal.jsonl"), [
      { ts: t(20), event: "run-resume", data: { pid: 2 } },
      { ts: t(21), event: "task-done", taskId: "T1", data: {} },
      { ts: t(22), event: "merge", taskId: "T1", data: { commit: "d".repeat(40) } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await needsYou()).toEqual(["needs you: outstanding 0 · 0 parked · 1 failed", "- needs you: outstanding 0 · 0 parked · 1 failed", "needs you: outstanding 0 · 0 parked · 1 failed"]);

    // A recompiled graph is claimed as such in the lead, never tallied against the new graph.
    saveGraph(repo, validateGraph({ ...graph, tasks: [...graph.tasks, { ...graph.tasks[0]!, id: "T3", title: "task T3" }] }));
    const incomparable = (await status(["run-wall"], repo)).split("\n");
    expect(incomparable[0]).toMatch(/^finished graph not comparable · tip verify unavailable/u);
    expect(incomparable.find((line) => line.startsWith("tickmarkr status"))).toContain("graph not comparable");
  });

  test("a merge-candidate test row places its selected run at the gate's first phase-start and its full suite at the row, so a span read back from the row alone swallows the judge that ran between them", () => {
    const b = wallBudget([
      { ts: t(0), event: "run-start", data: {} },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gates" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(5), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(8), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 3_000 } },
      { ts: t(10), event: "gate-provisioned", taskId: "T1", data: { gate: "build", durationMs: 2_000 } },
      { ts: t(10), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(30), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, fullSuite: true, durationMs: 25_000, selectedDurationMs: 5_000, fullDurationMs: 20_000, nonce: "n-full" } },
      { ts: t(30), event: "run-end", data: {} },
    ])!;
    expect(b.exposedMs).toEqual({ interruption: 0, test: 25_000, semantics: 3_000, worker: 0, queue: 0, "other-gate": 2_000 });
    expect(b.residualMs).toBe(0);
    expect(b.evidence).toEqual({ fresh: 2, replay: 0, reuse: 0, unknown: 0 });
  });
});

// D-639: a wait is the test gate's queue, never a sibling semantic gate's, and a long wait history is
// swept once — not doubled per wait.
describe("OBS-1201 queue subtraction (D-639)", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-28T00:00:00.000Z") + s * 1_000).toISOString();
  test("a matched suite wait is cut only from the gate that owns it, and a thousand waits stay linear", () => {
    const b = wallBudget([
      { ts: t(0), event: "run-start", data: {} },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(0), event: "suite-wait", taskId: "T1", data: { count: 1 } },
      { ts: t(4), event: "suite-admitted", taskId: "T1", data: {} },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "run-end", data: {} },
    ])!;
    expect(b.taskMs.semantics).toBe(10_000); // the judge kept running through the sibling's wait
    expect(b.taskMs.test).toBe(6_000);
    expect(b.taskMs.queue).toBe(4_000);

    // A wait the daemon attributes to another gate is cut from THAT gate: acceptance owning a wait
    // reads semantics 6s and queue 4s, and the sibling test span keeps its full ten.
    const owned = wallBudget([
      { ts: t(0), event: "run-start", data: {} },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance" } },
      { ts: t(0), event: "phase-start", taskId: "T1", data: { phase: "gate:test", gate: "test" } },
      { ts: t(0), event: "suite-wait", taskId: "T1", data: { count: 1, gate: "acceptance" } },
      { ts: t(4), event: "phase-start", taskId: "T1", data: { phase: "judge", gate: "acceptance", admitted: true } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 10_000 } },
      { ts: t(10), event: "run-end", data: {} },
    ])!;
    expect(owned.taskMs.semantics).toBe(6_000);
    expect(owned.taskMs.queue).toBe(4_000);
    expect(owned.taskMs.test).toBe(10_000);

    const many: JournalEvent[] = [{ ts: t(0), event: "run-start", data: {} }];
    for (let i = 0; i < 1_000; i++) {
      many.push({ ts: t(2 * i), event: "suite-wait", taskId: "T1", data: { count: 1 } });
      many.push({ ts: t(2 * i + 1), event: "suite-admitted", taskId: "T1", data: {} });
    }
    many.push({ ts: t(2_000), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, durationMs: 2_000_000 } });
    many.push({ ts: t(2_000), event: "run-end", data: {} });
    const started = Date.now();
    const big = wallBudget(many)!;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(big.taskMs.queue).toBe(1_000_000);
    expect(big.taskMs.test).toBe(1_000_000);
  });
});

// CG1 (v2.6.4): one waived test gate leaves one owed check. Every consumer surface reads the CURRENT
// fold, so a discharge appended after the run-end row moves all five — while the run-end row itself
// stays historical — and a legacy waive with no obligation reads unknown, never zero.
describe("CG1 current owed-check fold on every consumer surface", () => {
  const t = (s: number) => new Date(Date.parse("2026-09-29T00:00:00.000Z") + s * 1_000).toISOString();
  const graph = validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["cg1"], hash: "cg1" },
    tasks: [{ id: "T1", title: "task T1", goal: "task T1", shape: "implement", complexity: 3, acceptance: ["a"], status: "done" }],
  });
  const base = "b".repeat(40);
  const head = "c".repeat(40);
  const obligation = {
    version: 1, id: "owed-t1-test", runId: "run-cg1", taskId: "T1", gate: "test", base, head, subject: "subject-1",
    patch: "patch-1", patches: ["patch-1"], criteria: "criteria-1", files: ["src/a.ts"], authors: ["fake:fake-1"],
    declared: [{ key: "fake:fake-1", vendor: "fakeco" }], cause: "operator waive", evidence: "tickmarkr verify --record run-cg1",
    disposition: "accepted-risk", known: true,
  };
  const seed = (runId: string, waive: Record<string, unknown>) => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, graph);
    const j = Journal.create(repo, runId);
    const rows: JournalEvent[] = [
      { ts: t(0), event: "run-start", data: { baseRef: "base", graphDefinitionHash: graphDefinitionHash(graph) } },
      { ts: t(1), event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" }, attempt: 0, workerDispatchOrdinal: 0 } },
      { ts: t(10), event: "gate-result", taskId: "T1", data: { gate: "test", pass: false, details: "1 failed" } },
      { ts: t(11), event: "task-human", taskId: "T1", data: { kind: "gate-fail" } },
      { ts: t(20), event: "task-approved", taskId: "T1", data: { by: "operator", release: "gate-satisfied", gate: "test", park: { line: 4, ts: t(11) }, ...waive } },
      { ts: t(21), event: "run-resume", data: { pid: 1 } },
      { ts: t(22), event: "task-done", taskId: "T1", data: {} },
      { ts: t(23), event: "merge", taskId: "T1", data: { branch: `tickmarkr/${runId}`, commit: "d".repeat(40) } },
      { ts: t(24), event: "run-end", data: { done: ["T1"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" } },
    ];
    writeFileSync(join(j.dir, "journal.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { repo, j };
  };
  /** One bounded frame drawn on a colour terminal — the frame `status --watch --plain` paints there. */
  const terminal = async (repo: string, runId: string): Promise<string> => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const noColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      return (await status(["--watch", "--plain", runId], repo, { iterations: 1, sleep: async () => {} })).replace(/\x1b\[[0-9;]*m/gu, "");
    } finally {
      write.mockRestore();
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (noColor !== undefined) process.env.NO_COLOR = noColor;
    }
  };
  const surfaces = async (repo: string, runId: string) => ({
    "status plain": await status([runId], repo),
    "status oneline": await status([runId, "--oneline"], repo),
    "status watch": await status(["--watch", runId], repo, { iterations: 1, sleep: async () => {} }),
    // The same watch surface on a terminal: its frames lead with the current fold too.
    "status watch terminal": await terminal(repo, runId),
    "report text": await report([runId], repo),
    "report markdown": await report([runId, "--md"], repo),
  });

  test("status plain oneline watch and report text markdown render the current fold after run-end; validated discharge changes outstanding 1 to 0 on all five surfaces whereas legacy evidence reads unknown", async () => {
    const { repo, j } = seed("run-cg1", { obligation });
    const before = await surfaces(repo, "run-cg1");
    expect(Object.keys(before)).toHaveLength(6);
    for (const [surface, out] of Object.entries(before)) {
      expect(out, surface).toContain("outstanding 1");
      expect(out, surface).not.toContain("outstanding 0");
    }
    expect(before["status plain"].split("\n")[2]).toBe("needs you: outstanding 1 (T1 test) · 0 parked · 0 failed");
    // The terminal frame (its task board, not the plain print) opens with the same three lead lines, above its brand lockup.
    expect(before["status watch terminal"]).toMatch(/▌ TASKS/u);
    expect(before["status watch terminal"].split("\n").slice(0, 3)).toEqual(before["status plain"].split("\n").slice(0, 3));
    expect(before["status oneline"]).toContain("end-to-end first pass 0/1 · ");
    expect(before["status oneline"]).toContain(" wall · needs you: outstanding 1 (T1 test) · 0 parked · 0 failed");

    // verify --record's proof, appended after run-end: the hash-bound artifact measured the exact range green.
    const artifactPath = join(j.dir, "verify-results.json");
    const artifact = Buffer.from(JSON.stringify({ base, head, mergeBase: base, green: true, files: ["src/a.ts"], criteria: "criteria-1", gateRows: [{ gate: "test", pass: true }] }));
    writeFileSync(artifactPath, artifact);
    const runEnd = readFileSync(join(j.dir, "journal.jsonl"), "utf8");
    appendFileSync(join(j.dir, "journal.jsonl"), JSON.stringify({ ts: t(30), event: "owed-check-discharged", taskId: "T1", data: {
      ids: ["owed-t1-test"], gates: ["test"], mapping: "exact", mergeBase: base, head, criteria: "criteria-1",
      artifactPath, artifactSha256: createHash("sha256").update(artifact).digest("hex"), authorChannels: [],
    } }) + "\n");
    const after = await surfaces(repo, "run-cg1");
    for (const [surface, out] of Object.entries(after)) {
      expect(out, surface).toContain("outstanding 0");
      expect(out, surface).not.toContain("outstanding 1");
    }
    // The run-end row is history: nothing above re-read or rewrote it.
    expect(readFileSync(join(j.dir, "journal.jsonl"), "utf8").startsWith(runEnd)).toBe(true);

    // A legacy waive — no obligation on the row — is debt nobody can count: unknown, never zero.
    const legacy = seed("run-cg1-legacy", {});
    for (const [surface, out] of Object.entries(await surfaces(legacy.repo, "run-cg1-legacy"))) {
      expect(out, surface).toContain("outstanding unknown");
      expect(out, surface).not.toMatch(/outstanding \d/u);
    }
  });
});
