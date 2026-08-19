import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const at = "2026-08-18T08:00:00.000Z";
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");

const graphFor = (ids: readonly string[]): RunGraph => validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["effort-panel"], hash: "effort-panel" },
  tasks: ids.map((id) => ({
    id,
    title: `Effort task ${id}`,
    goal: `Render effort for ${id}.`,
    shape: "implement",
    complexity: 3,
    acceptance: ["effort is visible"],
  })),
});

const startFor = (graph: RunGraph): JournalEvent => ({
  ts: at,
  event: "run-start",
  data: { pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) },
});

const dispatch = (taskId: string, attempt = 0): JournalEvent => ({
  ts: at,
  event: "task-dispatch",
  taskId,
  data: {
    attempt,
    assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" },
  },
});

const review = (taskId: string, pass: boolean): JournalEvent => ({
  ts: at,
  event: "gate-result",
  taskId,
  data: { gate: "review", pass },
});

// The three encodings a review decline is on disk in. Only the first states `data.skipped`; the
// other two are the shapes a flag-only predicate bills as funded rounds (src/run/outcome.ts).
const declineFlagged = (taskId: string): JournalEvent => ({
  ts: at,
  event: "gate-result",
  taskId,
  data: { gate: "review", skipped: true, verdict: "skipped", policy: "judge-only" },
});

const declineLegacy = (taskId: string): JournalEvent => ({
  ts: at,
  event: "gate-result",
  taskId,
  data: { gate: "review", pass: true, details: "skipped — complexity 4 < threshold 7" },
});

const declineCanonical = (taskId: string): JournalEvent => ({
  ts: at,
  event: "gate-result",
  taskId,
  data: {
    attempt: 0,
    gate: "review",
    outcome: { kind: "declined", reason: "reviewPolicy declined this gate" },
  },
});

const park = (taskId: string): JournalEvent => ({
  ts: at,
  event: "task-human",
  taskId,
  data: { kind: "review-round-cap", reason: "fixture park" },
});

const seed = (graph: RunGraph, events: readonly JournalEvent[]): { repo: string; runDir: string } => {
  // Through the test temp seam so tests/setup.ts reaps these fixtures: leaked mkdtemp dirs are the
  // machine-load class that times gate suites out (OBS-385), not free.
  const repo = makeTestTempDir("tickmarkr-status-effort-");
  saveGraph(repo, graph);
  const runDir = join(tickmarkrDir(repo), "runs", "run-effort");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"),
    [startFor(graph), ...events].map((event) => JSON.stringify(event)).join("\n") + "\n");
  return { repo, runDir };
};

const ttyFrame = async (repo: string, columns: number): Promise<string> => {
  const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const oldColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  delete process.env.NO_COLOR;
  try {
    return await status([], repo);
  } finally {
    if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (oldColumns) Object.defineProperty(process.stdout, "columns", oldColumns);
    else delete (process.stdout as { columns?: number }).columns;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
};

const panelFrom = (frame: string): string => {
  const plain = stripAnsi(frame);
  const start = plain.indexOf("WHERE THE EFFORT WENT");
  expect(start).toBeGreaterThanOrEqual(0);
  return plain.slice(start);
};

const effortTaskLines = (panel: string): string[] =>
  panel.split("\n").filter((line) => /\d+ dispatch · \d+ review · \d+ park$/u.test(line));

describe("status board effort panel", () => {
  test("test: the effort panel counts a task's review rounds from gate-result journal rows whose gate field is review counting passed and failed rounds alike, so a fold rendering zero review rounds for a task with three recorded review results fails", async () => {
    const graph = graphFor(["T1"]);
    const { repo, runDir } = seed(graph, [
      dispatch("T1"),
      review("T1", true),
      review("T1", false),
      review("T1", true),
      // A raw-line search for "review" sees this decoy; the typed gate fold must not.
      { ts: at, event: "gate-result", taskId: "T1", data: { gate: "build", pass: true, details: "review-raw-T1-decoy" } },
      // A reviewPolicy decline (src/gates/review.ts): a typed review row where no reviewer ever ran.
      // All three shipped encodings, because only the first one states `data.skipped`.
      declineFlagged("T1"),
      declineLegacy("T1"),
      declineCanonical("T1"),
      // A resume re-measurement (src/run/daemon.ts): audit evidence, not a newly funded round.
      { ts: at, event: "gate-result", taskId: "T1", data: { gate: "review", pass: false, replayMeasurement: true } },
    ]);
    // The prototype defect counted these artifacts. Seven files versus three typed review rows makes
    // a filesystem implementation observably wrong instead of coincidentally right.
    for (let index = 0; index < 7; index += 1) {
      writeFileSync(join(runDir, `review-raw-T1-${index}.txt`), "unparseable reviewer output\n");
    }

    const lines = effortTaskLines(panelFrom(await ttyFrame(repo, 110)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/T1\s+.*1 dispatch · 3 review · 0 park$/u);

    // Source citation fence: the named fold hunk accepts typed rows and selects the typed gate field;
    // it has no raw bytes, string splitting/matching, or directory reads available to derive counts.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/cli/commands/status.ts", import.meta.url)),
      "utf8",
    );
    const foldStart = source.indexOf("const foldTaskEffort");
    const foldEnd = source.indexOf("const effortPanel", foldStart);
    const foldHunk = source.slice(foldStart, foldEnd);
    expect(foldStart).toBeGreaterThanOrEqual(0);
    expect(foldEnd).toBeGreaterThan(foldStart);
    expect(foldHunk).toContain("events: readonly JournalEvent[]");
    expect(foldHunk).toContain('event.event === "gate-result" && event.data.gate === "review"');
    expect(foldHunk).not.toMatch(/readFileSync|readdirSync|record\.raw|\.split\(|\.match\(|\.includes\(/u);
  });

  test("test: the effort panel orders tasks by combined dispatch review and park counts and renders at most the top four over a five-task journal, so an unranked panel or one row per task fails", async () => {
    const graph = graphFor(["T1", "T2", "T10", "T11", "T12"]);
    const { repo } = seed(graph, [
      // total 1 — omitted; the two declines are not rounds, so counting either would lift T1 to 3
      // and evict T12 from the top four.
      dispatch("T1"), declineLegacy("T1"), declineCanonical("T1"),
      dispatch("T2"), review("T2", true), review("T2", false), review("T2", true), park("T2"), // total 5
      dispatch("T10"), review("T10", true), review("T10", false), // total 3
      dispatch("T11"), review("T11", true), park("T11"), park("T11"), // total 4
      dispatch("T12"), dispatch("T12", 1), // total 2
    ]);

    const lines = effortTaskLines(panelFrom(await ttyFrame(repo, 110)));
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.match(/^\s+(T\d+)\s/u)?.[1])).toEqual(["T2", "T11", "T10", "T12"]);
    expect(lines.join("\n")).not.toMatch(/^\s+T1\s/gmu);
  });

  test("an incomparable journal renders the panel as unavailable, never as zero effort", async () => {
    const graph = graphFor(["T1"]);
    const { repo } = seed(graph, [
      dispatch("T1"),
      review("T1", true),
      review("T1", false),
      park("T1"),
    ]);
    // Recompile the graph out from under the recorded run: the journal now describes another graph.
    saveGraph(repo, graphFor(["T1", "T2"]));

    const panel = panelFrom(await ttyFrame(repo, 110));
    expect(panel).toContain("counts unavailable");
    expect(effortTaskLines(panel)).toHaveLength(0);
    expect(panel).not.toMatch(/0 dispatch · 0 review · 0 park/u);
  });

  test("test: every effort panel line fits within 80, 110 and 150 columns measured in display cells, so a stacked bar or task label pushing a rendered line past the terminal fails", async () => {
    const longestId = "T_cockpit_width_authority_at_the_schema_maximum_identifier_lengt";
    expect(longestId).toHaveLength(64);
    const graph = graphFor([longestId, "T2", "T3", "T4", "T5"]);
    const { repo } = seed(graph, [
      dispatch(longestId), dispatch(longestId, 1), review(longestId, true), review(longestId, false), park(longestId),
      dispatch("T2"), review("T2", true), review("T2", false), park("T2"),
      dispatch("T3"), review("T3", true), park("T3"),
      dispatch("T4"), review("T4", true),
      dispatch("T5"),
    ]);

    for (const columns of [80, 110, 150]) {
      const panel = panelFrom(await ttyFrame(repo, columns));
      expect(panel).toContain("█");
      const taskLines = effortTaskLines(panel);
      expect(taskLines).toHaveLength(4);
      expect(taskLines.every((line) => line.includes("█"))).toBe(true);
      for (const line of panel.split("\n")) {
        expect(cellWidth(line), `${columns} columns: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });
});
