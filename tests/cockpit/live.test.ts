import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import { PLAIN_COMPACT_LOCKUP } from "../../src/brand.js";
import { status } from "../../src/cli/commands/status.js";
import { ui } from "../../src/cli/commands/ui.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { runViewRowIdentities } from "../../src/tui/cockpit/derive.js";
import {
  deriveLiveRunCockpitData,
  liveRunViewRowIds,
  liveRunPointerSurface,
  loadEngagementSource,
  runLegacyCockpit as runLiveCockpit,
  selectEngagementRunId,
  type LiveCockpitDelivery,
} from "../../src/tui/cockpit/live.js";
import {
  POINTER_RELEASE_SIGNALS,
  POINTER_TRACKING_OFF,
  POINTER_TRACKING_ON,
  resolvePointerTarget,
} from "../../src/tui/cockpit/pointer.js";
import { RUN_VIEWS } from "../../src/tui/cockpit/views.js";
import {
  assertFrameConformance,
  deriveRunViewRows,
  planRunCockpitFrame,
  RunCockpitFrame,
  RunCockpitFrameFromPlan,
  type PlannedRunCockpitFrame,
  type RunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";
import {
  FRAME_CONTRACT_DOMAIN,
  FRAME_NESTED_ROW_BANDS,
  planFrame,
  type PlannedFrame,
} from "../../src/tui/cockpit/layout.js";
import {
  initialRunInteractionState,
  type RunInteractionState,
} from "../../src/tui/cockpit/keys.js";
import {
  COCKPIT_MARK_ALPHABET,
  findHeaderSignatures,
  GOLDEN_FRAME_CASES,
  isRetiredGoldenFrame,
} from "../../src/tui/cockpit/capture.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import { ttyInput } from "../helpers/tty-input.js";

const inkMount = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return {
    ...actual,
    render: (...args: Parameters<typeof actual.render>) => {
      const failure = inkMount.failure;
      inkMount.failure = null;
      if (failure !== null) throw failure;
      return actual.render(...args);
    },
  };
});

/** A run id that exists only in committed captures, never in a live journal. */
const COMMITTED_CAPTURE_ID = "run-20260724-231138";

const ev = (
  event: string,
  data: Record<string, unknown> = {},
  ts: string,
  taskId?: string,
): JournalEvent => ({ ts, event, ...(taskId ? { taskId } : {}), data });

const rawOf = (events: readonly JournalEvent[]): string =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Independent host-zone oracle: a fixed UTC instant converted by a named IANA rule set. */
const clockInZone = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

/** Every attempt number a surface prints without saying which ruler counted it. */
const bareAttemptReadings = (text: string): string[] =>
  [...text.matchAll(/(?<!engagement |run )\battempts? \d+/gu)].map(([reading]) => reading);

/** The numbers a surface reports on one named ruler, in order and deduplicated. */
const attemptReadings = (text: string, ruler: "engagement" | "run"): string[] => [
  ...new Set(
    [...text.matchAll(new RegExp(String.raw`\b${ruler} attempts? (\d+)`, "gu"))]
      .map(([, count]) => count as string),
  ),
];

/** The text of the counters the ui composes itself, as opposed to the fold records it surrenders. */
const taskRowText = (data: RunCockpitData): string =>
  deriveRunViewRows(data, "tasks").map((row) => row.text).join("\n");

/** The attempt the fold's newest record names for a task — the engagement's own label. */
const foldedEngagementAttempt = (data: RunCockpitData, taskId: string): string | undefined =>
  deriveRunViewRows(data, "journal")[0]?.text
    .match(new RegExp(String.raw`^${taskId} attempt (\d+)\b`, "u"))?.[1];

const hostZoneLabel = (): string => {
  const offset = -new Date().getTimezoneOffset();
  if (offset === 0) return "UTC";
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = Math.abs(offset) % 60;
  return minutes === 0
    ? `${sign}${hours}`
    : `${sign}${hours}:${String(minutes).padStart(2, "0")}`;
};

async function frameFor(
  raw: string,
  now?: () => number,
  fileName = "run-live-test.journal.jsonl",
  graph?: Parameters<typeof deriveLiveRunCockpitData>[3],
): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = 140;
  output.rows = 40;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(createElement(RunCockpitFrame, {
    data: deriveLiveRunCockpitData({ fileName, raw }, "9.8.7", now, graph),
    columns: 140,
    rows: 40,
  }), {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  await firstPaint;
  const frame = stripAnsi(writes.at(-1) ?? "").trimEnd();
  app.unmount();
  return frame;
}

async function plannedFrameAt(
  raw: string,
  columns: number,
  rows: number,
  interaction: RunInteractionState = initialRunInteractionState(),
  graph?: Parameters<typeof deriveLiveRunCockpitData>[3],
): Promise<{
  readonly frame: string;
  readonly plan: PlannedFrame;
}> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  output.resume();
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  const data = deriveLiveRunCockpitData(
    { fileName: "run-planned-frame.journal.jsonl", raw },
    "9.8.7",
    Date.now,
    graph,
  );
  const plannedFrame = planRunCockpitFrame({
    data,
    columns,
    rows,
    interaction,
  });
  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(createElement(RunCockpitFrameFromPlan, {
    data,
    plannedFrame,
  }), {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  // The paint-time guard reports a nonconforming region through the surface's exit channel.
  const refused = paintRefusal(app);
  try {
    await firstPaint;
    const failure = await refused;
    if (failure !== undefined) throw new Error(failure);
    return {
      frame: stripAnsi(writes.at(-1) ?? ""),
      plan: plannedFrame.plan,
    };
  } finally {
    app.unmount();
    app.cleanup();
  }
}

function seedJournal(repo: string, runId: string, raw: string): void {
  const dir = join(repo, ".tickmarkr", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), raw);
}

describe("live cockpit", () => {
  test("test: an attempt counter names its ruler and the two surfaces agree when showing the same task", async () => {
    const repo = mkRepo();
    const graph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: ["T1", "T2", "T3"].map((id) => ({
        id,
        title: id,
        goal: `Render ${id}.`,
        shape: "implement" as const,
        complexity: 3,
        acceptance: ["recorded"],
      })),
    });
    const at = (second: number) => `2026-07-28T09:00:${String(second).padStart(2, "0")}.000Z`;
    // T2 is on its SECOND dispatch: both surfaces consume T8's authoritative folded caption and
    // task row, then name the distinct engagement and run rulers they display.
    const events = [
      ev("run-start", { branch: "spec/rulers", pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, at(0)),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "old" }, attempt: 0 }, at(1), "T1"),
      ev("task-done", {}, at(8), "T1"),
      ev("merge", {}, at(9), "T1"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "single" }, attempt: 0 }, at(10), "T3"),
      ev("task-done", {}, at(11), "T3"),
      ev("merge", {}, at(12), "T3"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "current" }, attempt: 0 }, at(13), "T2"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "current" }, attempt: 1 }, at(14), "T2"),
    ];
    const raw = rawOf(events);
    saveGraph(repo, graph);
    seedJournal(repo, "run-20260728-090001", raw);

    const watch = await status(["--watch"], repo, { iterations: 1 });
    const uiFrame = await frameFor(raw);
    const data = deriveLiveRunCockpitData(
      { fileName: "run-20260728-090001.journal.jsonl", raw },
      "9.8.7",
    );
    const taskRows = deriveRunViewRows(data, "tasks");

    expect(watch).toContain("T2");
    expect(watch).toContain("engagement attempt 2");
    expect(watch).not.toContain("engagement attempt 1");
    expect(uiFrame).toContain("T2 · worker · engagement attempt 2 · fake:current");
    expect(uiFrame).not.toContain("T1 · worker · engagement attempt 1 · fake:old");
    expect(taskRows.find((row) => row.id === "task:T1")?.text).toContain("run attempt 1");
    expect(taskRows.find((row) => row.id === "task:T2")?.text).toContain("run attempts 2");
    expect(taskRows.find((row) => row.id === "task:T3")?.text).toContain("run attempt 1");
    // Every attempt number these surfaces COMPOSE says which ruler counted it. (The journal view
    // is excluded on purpose: it surrenders the fold's records untouched, wording included.)
    expect(bareAttemptReadings(stripAnsi(watch))).toEqual([]);
    expect(bareAttemptReadings(taskRowText(data))).toEqual([]);

    // A RESUME restarts the engagement's attempt label while the run's dispatch count keeps
    // climbing, so the two readings part company without the surface replacing the fold's caption.
    const rt = (second: number) => `2026-07-29T09:00:${String(second).padStart(2, "0")}.000Z`;
    const resumedRaw = rawOf([
      ev("run-start", { branch: "spec/rulers", pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, rt(0)),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "old" }, attempt: 0 }, rt(1), "T1"),
      ev("task-done", {}, rt(4), "T1"),
      ev("merge", {}, rt(5), "T1"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "current" }, attempt: 0 }, rt(6), "T2"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "current" }, attempt: 1 }, rt(7), "T2"),
      // the resume: the daemon restarts and redispatches T2 at label 0 — its THIRD dispatch
      ev("run-start", { branch: "spec/rulers", pid: process.pid, graphDefinitionHash: graphDefinitionHash(graph) }, rt(8)),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "current" }, attempt: 0 }, rt(9), "T2"),
    ]);
    const resumedRepo = mkRepo();
    saveGraph(resumedRepo, graph);
    seedJournal(resumedRepo, "run-20260729-090001", resumedRaw);

    const resumedWatch = stripAnsi(await status(["--watch"], resumedRepo, { iterations: 1 }));
    const resumedFrame = await frameFor(resumedRaw);
    const resumedData = deriveLiveRunCockpitData(
      { fileName: "run-20260729-090001.journal.jsonl", raw: resumedRaw },
      "9.8.7",
    );
    // Watch reads the engagement's own label; the caption reads the run's dispatch count. Neither
    // borrows the other's ruler, so 1 and 3 can stand side by side without contradicting.
    expect(resumedWatch).toContain("engagement attempt 1 in flight on fake:current");
    expect(resumedFrame).toContain("T2 · worker · engagement attempt 1 · fake:current");
    expect(resumedFrame).not.toContain("engagement attempt 3");
    expect(deriveRunViewRows(resumedData, "tasks").find((row) => row.id === "task:T2")?.text)
      .toContain("run attempts 3");
    expect(bareAttemptReadings(resumedWatch)).toEqual([]);
    expect(bareAttemptReadings(taskRowText(resumedData))).toEqual([]);
    // And the engagement's own label — the one reading both surfaces do carry for T2 — is the same
    // 1 on each. The ui's 3 is a different ruler, not a different answer to the same question.
    expect(attemptReadings(resumedWatch, "engagement")).toEqual(["1"]);
    expect(foldedEngagementAttempt(resumedData, "T2")).toBe("1");
  });

  test("progress renders the fold's authoritative same-second caption without graph-order re-derivation", async () => {
    const sameSecond = "2026-07-28T10:00:01.000Z";
    const graph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      // Deliberately opposite journal order. TaskRow clocks tie at second precision, so a surface
      // ranking these rows chooses T1 even though the fold's full event order names T2.
      tasks: ["T2", "T1"].map((id) => ({
        id,
        title: id,
        goal: `Render ${id}.`,
        shape: "implement" as const,
        complexity: 3,
        acceptance: ["recorded"],
      })),
    });
    const raw = rawOf([
      ev("run-start", { branch: "spec/concurrent", pid: process.pid }, "2026-07-28T10:00:00.000Z"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "first" }, attempt: 0 }, sameSecond, "T1"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "second" }, attempt: 0 }, sameSecond, "T2"),
    ]);
    const data = deriveLiveRunCockpitData(
      { fileName: "run-20260728-100000.journal.jsonl", raw },
      "9.8.7",
      Date.now,
      graph,
    );

    expect(data.progressCaption).toMatch(/^T2 ·/u);
    const frame = await frameFor(raw, undefined, "run-20260728-100000.journal.jsonl", graph);
    expect(frame).toContain("T2 · worker · engagement attempt 1 · fake:second");
    expect(frame).not.toContain("T1 · running");
  });

  test("the Tasks view and its selection identities omit graph-only placeholder rows", async () => {
    const graph = validateGraph({
      version: 1,
      spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: ["T1", "T2"].map((id) => ({
        id,
        title: id,
        goal: `Render ${id}.`,
        shape: "implement" as const,
        complexity: 3,
        acceptance: ["recorded"],
      })),
    });
    const raw = rawOf([
      ev("run-start", { branch: "spec/rows", pid: process.pid }, "2026-07-28T10:00:00.000Z"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "recorded" }, attempt: 0 }, "2026-07-28T10:00:01.000Z", "T1"),
    ]);
    const data = deriveLiveRunCockpitData(
      { fileName: "run-20260728-100000.journal.jsonl", raw },
      "9.8.7",
      Date.now,
      graph,
    );
    const interaction = { ...initialRunInteractionState(), activeView: "tasks" as const };

    expect(deriveRunViewRows(data, "tasks").map((row) => row.id)).toEqual(["task:T1"]);
    expect(liveRunViewRowIds(interaction, data)).toEqual(["task:T1"]);
    const tasks = await plannedFrameAt(raw, 140, 40, interaction, graph);
    expect(tasks.frame).toContain("T1 · running · run attempt 1 · fake:recorded");
    expect(tasks.frame).not.toContain("T2 · - · run attempts - · -");
  });

  test("test: an unmerged task-done renders unchecked on the Tasks view; only a merged task renders a checked pass", () => {
    const raw = rawOf([
      ev("run-start", { branch: "spec/landing", pid: process.pid }, "2026-07-28T09:00:00.000Z"),
      ev("task-dispatch", { assignment: { adapter: "fake", model: "fake" }, attempt: 0 }, "2026-07-28T09:00:01.000Z", "T1"),
      ev("task-done", {}, "2026-07-28T09:00:02.000Z", "T1"),
    ]);
    const completed = deriveLiveRunCockpitData(
      { fileName: "run-landing.journal.jsonl", raw },
      "9.8.7",
    );
    const foldedDoneWithoutLanding: RunCockpitData = {
      ...completed,
      taskRows: completed.taskRows.map((row) => ({ ...row, state: "done" as const })),
    };
    const landed: RunCockpitData = {
      ...foldedDoneWithoutLanding,
      taskRows: foldedDoneWithoutLanding.taskRows.map((row) => ({ ...row, merged: true as const })),
    };

    expect(deriveRunViewRows(completed, "tasks")[0]?.state).toBe("neutral");
    expect(deriveRunViewRows(foldedDoneWithoutLanding, "tasks")[0]?.state).toBe("neutral");
    expect(deriveRunViewRows(landed, "tasks")[0]?.state).toBe("pass");
  });

  test("the ui renders journal times in the host zone and names that zone once", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Riyadh";
    try {
      const start = "2026-07-14T08:00:00.000Z";
      const gate = "2026-07-14T08:00:01.000Z";
      const raw = rawOf([
        ev("run-start", { branch: "spec/local-clock", pid: process.pid }, start),
        ev("gate-result", { gate: "test", pass: true }, gate, "T1"),
      ]);

      const frame = await frameFor(raw);
      const tasks = await plannedFrameAt(raw, 140, 40, {
        ...initialRunInteractionState(),
        activeView: "tasks",
      });

      expect(frame).toContain(clockInZone(gate, "Asia/Riyadh"));
      expect(frame).not.toContain("08:00:01");
      expect(frame.match(/zone \+03/gu)).toHaveLength(1);
      expect(tasks.frame).toContain(clockInZone(gate, "Asia/Riyadh"));
      expect(tasks.frame).not.toContain("14:00:01");
      expect(tasks.frame.match(/zone \+03/gu)).toHaveLength(1);
      expect(raw).toContain("2026-07-14T08:00:01.000Z");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  // Same independent oracle as watch: complete instants plus a fixed IANA rule set. The compact
  // screen label is not used to derive an expected clock or any other asserted output bytes.
  test("the ui screen names the host zone once and converts every complete instant under its daylight-saving rules", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // The UTC clocks rise from 06:00 to 08:00 across a three-day gap, so source order plus
      // HH:mm:ss cannot recover the omitted dates. Only the complete instants can select EST for
      // the first row and EDT for the second.
      const before = "2026-03-06T06:00:00.000Z"; // 01:00 EST — before the jump
      const after = "2026-03-09T08:00:00.000Z"; // 04:00 EDT — after the jump
      const raw = rawOf([
        ev("run-start", { branch: "spec/dst", pid: process.pid }, before),
        ev("gate-result", { gate: "test", pass: true }, after, "T1"),
      ]);

      const frame = await frameFor(raw, undefined, "run-20260306-010000.journal.jsonl");

      expect(frame.match(/zone (?:UTC|[+-]\d{2}(?::\d{2})?)/gu)).toHaveLength(1);
      expect(frame).toContain(clockInZone(before, "America/New_York"));
      expect(frame).toContain(clockInZone(after, "America/New_York"));
      expect(raw).toContain(before);
      expect(raw).toContain(after);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("test: the merged fold layer's public shape stays additive — its existing consumers pass unchanged against this task's tree in a composed fixture exercising this task's surface changes", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Riyadh";
    try {
      const start = "2026-07-28T09:00:00.000Z";
      const dispatch = "2026-07-28T09:00:01.000Z";
      const done = "2026-07-28T09:00:02.000Z";
      const merged = "2026-07-28T09:00:03.000Z";
      const raw = rawOf([
        ev("run-start", { branch: "spec/composed", pid: process.pid }, start),
        ev("task-dispatch", { assignment: { adapter: "fake", model: "worker" }, attempt: 0 }, dispatch, "T1"),
        ev("task-done", {}, done, "T1"),
        ev("merge", {}, merged, "T1"),
      ]);
      const data = deriveLiveRunCockpitData(
        { fileName: "run-20260728-120000.journal.jsonl", raw },
        "9.8.7",
      );

      // The pre-existing consumer reads only the original public fields. The fold's complete
      // instant is extra information: the old projection and row identity remain untouched.
      const existingConsumer = (row: (typeof data.journalRows)[number]) => ({
        id: row.id,
        time: row.time,
        state: row.state,
        text: row.text,
      });
      expect(deriveRunViewRows(data, "journal")).toBe(data.journalRows);
      expect(data.journalRows.map(existingConsumer)).toEqual([
        { id: "event:4", time: "09:00:03", state: "pass", text: "T1 attempt 1 fake:worker pass running" },
        { id: "event:3", time: "09:00:02", state: "neutral", text: "T1 done · task-done" },
        { id: "event:2", time: "09:00:01", state: "neutral", text: "T1 neutral · task-dispatch" },
        { id: "event:1", time: "09:00:00", state: "neutral", text: "neutral · run-start" },
      ]);
      expect(data.journalRows.map((row) => row.timestamp)).toEqual([
        merged,
        done,
        dispatch,
        start,
      ]);

      const task = deriveRunViewRows(data, "tasks")[0];
      expect(task).toMatchObject({ state: "pass", timestamp: merged });
      expect(task?.text).toContain("run attempt 1");
      const frame = await frameFor(raw, undefined, "run-20260728-120000.journal.jsonl");
      expect(frame).toContain(clockInZone(merged, "Asia/Riyadh"));
      expect(frame.match(/zone \+03/gu)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("test: an engagement whose daemon is alive renders as running, and one whose daemon is gone renders as interrupted rather than as running", async () => {
    const start = Date.parse("2026-07-26T12:00:00.000Z");
    const at = (seconds: number) => new Date(start + seconds * 1_000).toISOString();
    const dispatch = (ts: string) =>
      ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, ts, "T1");

    const alive = await frameFor(rawOf([
      ev("run-start", { branch: "spec/live", pid: process.pid }, at(0)),
      dispatch(at(5)),
    ]));
    expect(alive).toContain("running");
    expect(alive).not.toContain("interrupted");

    const dead = spawnSync("true").pid!; // reaped-dead foreign pid → kill(pid,0) ESRCH
    const gone = await frameFor(rawOf([
      ev("run-start", { branch: "spec/live", pid: dead }, at(0)),
      dispatch(at(5)),
    ]));
    expect(gone).toContain("interrupted");
    expect(gone).not.toContain("running");
  });

  test("test: the header states how long ago the engagement's last event arrived, so an engagement that has stopped moving reads as stale rather than as current", async () => {
    const nowMs = Date.parse("2026-07-26T12:00:00.000Z");
    const now = () => nowMs;
    const ago = (seconds: number) => new Date(nowMs - seconds * 1_000).toISOString();

    const stale = rawOf([
      ev("run-start", { branch: "spec/stale", pid: process.pid }, ago(600)),
      ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, ago(600), "T1"),
    ]);
    const staleData = deriveLiveRunCockpitData(
      { fileName: "run-stale.journal.jsonl", raw: stale },
      "9.8.7",
      now,
    );
    expect(staleData.elapsed).toContain("last event 10m ago");
    expect(await frameFor(stale, now)).toContain("last event 10m ago");

    const fresh = rawOf([
      ev("run-start", { branch: "spec/fresh", pid: process.pid }, ago(3)),
    ]);
    expect(await frameFor(fresh, now)).toContain("last event 3s ago");
  });

  test("the engagement selection rule lives in one function: an explicit reference wins, otherwise the newest journaled run", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-live-select-"));
    expect(selectEngagementRunId(repo)).toBeNull();

    seedJournal(repo, "run-20260726-100000", '{"ts":"2026-07-26T10:00:00.000Z","event":"run-start","data":{}}\n');
    seedJournal(repo, "run-20260726-110000", '{"ts":"2026-07-26T11:00:00.000Z","event":"run-start","data":{}}\n');
    expect(selectEngagementRunId(repo)).toBe("run-20260726-110000");
    expect(selectEngagementRunId(repo, "run-20260726-100000")).toBe("run-20260726-100000");
    expect(() => selectEngagementRunId(repo, "../escape")).toThrow();
  });

  test("loadEngagementSource returns the journal bytes of the named engagement and throws when they cannot be read", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-live-load-"));
    seedJournal(repo, "run-20260726-171700", '{"ts":"2026-07-26T17:17:00.000Z","event":"run-start","data":{}}\n');

    const source = loadEngagementSource(repo, "run-20260726-171700");
    expect(source.fileName).toBe("run-20260726-171700.journal.jsonl");
    expect(source.raw).toContain('"run-start"');

    expect(() => loadEngagementSource(repo, "run-20260726-171701")).toThrow();
  });
});

function makeInkStreams(columns = 140, rows = 40) {
  let raw = false;
  const input = ttyInput({ onRawMode: mode => { raw = mode; } });

  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    writes,
    raw: () => raw,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function commandFrame(io: { writes: string[] }): Promise<string> {
  for (let attempts = 0; attempts < 40; attempts += 1) {
    const frame = stripAnsi(io.writes.join(""));
    if (frame.trim().length > 0) return frame;
    await wait(50);
  }
  return stripAnsi(io.writes.join(""));
}

async function waitForDraw(
  io: { writes: string[] },
  expected: string,
): Promise<string> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const output = stripAnsi(io.writes.join(""));
    if (output.includes(expected)) return output;
    await wait(20);
  }
  throw new Error(`live cockpit never drew ${JSON.stringify(expected)}`);
}

function lastLiveFrame(io: { writes: string[] }): string {
  return stripAnsi(io.writes.at(-1) ?? "");
}

async function waitForLastFrame(
  io: { writes: string[] },
  predicate: (frame: string) => boolean,
  description: string,
): Promise<string> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const frame = lastLiveFrame(io);
    if (predicate(frame)) return frame;
    await wait(20);
  }
  throw new Error(`live cockpit never drew ${description}`);
}

const mkRepo = () => mkdtempSync(join(tmpdir(), "tickmarkr-ui-"));

/** The drawn text of the gate row one seeded gate-result event produces. */
function gateRowText(event: string): string {
  return `T1 · ${event} ·`;
}

function selectedLine(frame: string, event: string): string | undefined {
  return frame.split("\n").find((line) =>
    line.includes(`${GLYPHS.pointer} ${gateRowText(event)}`)
  );
}

function deliveryPromise(): {
  readonly ready: Promise<LiveCockpitDelivery>;
  readonly accept: (delivery: LiveCockpitDelivery) => void;
} {
  let accept!: (delivery: LiveCockpitDelivery) => void;
  return {
    ready: new Promise<LiveCockpitDelivery>((resolve) => {
      accept = resolve;
    }),
    accept: (delivery) => accept(delivery),
  };
}

async function openGatesWithSelectedNewest(
  io: ReturnType<typeof makeInkStreams>,
  delivery: LiveCockpitDelivery,
  event: string,
): Promise<void> {
  delivery.key({ input: "3", key: {} });
  await waitForLastFrame(
    io,
    (frame) => frame.includes(`${GLYPHS.pointer} GATES`)
      && frame.includes(gateRowText(event))
      && !frame.includes("PROGRESS"),
    "the active Gates view",
  );
  delivery.key({ input: "", key: { downArrow: true } });
  await waitForLastFrame(
    io,
    (frame) => selectedLine(frame, event) !== undefined,
    `the selected ${event} row`,
  );
}

const PLANNED_FRAME_RAW = rawOf([
  ev(
    "run-start",
    { branch: "spec/planned-frame", pid: process.pid },
    "2026-07-29T13:43:19.000Z",
  ),
  ev(
    "gate-result",
    { gate: "review", pass: false, details: "the production finding" },
    "2026-07-29T13:43:20.000Z",
    "T4",
  ),
]);

function presentationStates(): readonly RunInteractionState[] {
  const initial = initialRunInteractionState();
  return [
    initial,
    { ...initial, activeView: "tasks", railSelection: 1 },
    { ...initial, activeView: "gates", railSelection: 2 },
    { ...initial, activeView: "journal", railSelection: 3 },
    { ...initial, activeView: "fleet", railSelection: 4 },
    {
      ...initial,
      activeView: "gates",
      railSelection: 2,
      opened: "gate:2",
      selection: "gate:2",
    },
    { ...initial, help: true },
    { ...initial, tab: "setup" },
  ];
}

const RENDERER_SOURCE = readFileSync(
  join(import.meta.dirname, "../../src/tui/cockpit/run-cockpit.tsx"),
  "utf8",
);
const LIVE_SOURCE = readFileSync(
  join(import.meta.dirname, "../../src/tui/cockpit/live.ts"),
  "utf8",
);

/** The plan, frozen: a path that rewrites a size, offset or span throws where it writes. */
function frozen(plan: PlannedFrame): PlannedFrame {
  for (const region of plan.regions) Object.freeze(region);
  for (
    const held of [
      plan.regions,
      plan.size,
      plan.rowSpans,
      plan.columnSpans,
      plan.content,
      plan.flexible,
      plan.surrendered,
    ]
  ) Object.freeze(held);
  return Object.freeze(plan);
}

/** Paint one already-planned frame through the production paint. */
async function drawPlanned(
  data: RunCockpitData,
  plannedFrame: PlannedRunCockpitFrame,
): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = plannedFrame.columns;
  output.rows = plannedFrame.rows ?? 24;
  output.resume();
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;
  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(createElement(RunCockpitFrameFromPlan, { data, plannedFrame }), {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  const refused = paintRefusal(app);
  try {
    await firstPaint;
    const failure = await refused;
    if (failure !== undefined) throw new Error(failure);
    return stripAnsi(writes.at(-1) ?? "");
  } finally {
    app.unmount();
    app.cleanup();
  }
}

/** The guard's verdict on the frame just painted, or undefined when it conformed. */
async function paintRefusal(app: ReturnType<typeof render>): Promise<string | undefined> {
  const refused = app.waitUntilExit().then(
    () => undefined,
    (error: unknown) => error instanceof Error ? error.message : String(error),
  );
  return Promise.race([
    refused,
    new Promise<undefined>((resolve) => {
      setImmediate(() => resolve(undefined));
    }),
  ]);
}

/**
 * Move one planned row from the body band into the header band, internally
 * tiled — the body's nested item rows shortening with it, so the mutated plan
 * is self-consistent and only the DRAWN frame can catch the redistribution.
 */
function redistributedSpans(plan: PlannedFrame): PlannedFrame {
  if (plan.kind !== "frame") throw new Error("expected a frame plan");
  const rowSpans = {
    ...plan.rowSpans,
    header: plan.rowSpans.header! + 1,
    body: plan.rowSpans.body! - 1,
    items: plan.rowSpans.items! - 1,
  };
  const bands = new Map<string, { row: number; rows: number }>();
  let row = 0;
  for (const [id, span] of Object.entries(rowSpans)) {
    if (FRAME_NESTED_ROW_BANDS[id as keyof typeof FRAME_NESTED_ROW_BANDS] !== undefined) {
      continue;
    }
    bands.set(id, { row, rows: span });
    row += span;
  }
  const body = bands.get("body")!;
  const header = bands.get("header")!;
  const items = plan.regions.find((region) => region.id === "items")!;
  const bodyBefore = plan.regions.find((region) => region.id === "body")!;
  bands.set("items", {
    row: body.row + (items.row - bodyBefore.row),
    rows: rowSpans.items,
  });
  return {
    ...plan,
    regions: plan.regions.map((region) => {
      const band = bands.get(region.id);
      if (band !== undefined) return { ...region, row: band.row, rows: band.rows };
      if (region.id === "rail") return { ...region, row: body.row, rows: body.rows };
      return { ...region, row: header.row, rows: header.rows };
    }),
    rowSpans,
  };
}

/**
 * Mount one planned frame through Ink and report the failure the production
 * paint-time guard raises, or undefined when the paint accepts the frame. The
 * guard delivers its refusal through the surface's exit channel, which rejects
 * the exit promise before the fallback tick can win the race.
 */
async function paintConformanceFailure(
  data: RunCockpitData,
  plannedFrame: PlannedRunCockpitFrame,
): Promise<string | undefined> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = plannedFrame.columns;
  output.rows = plannedFrame.rows ?? 24;
  output.resume();
  let app: ReturnType<typeof render>;
  try {
    app = render(createElement(RunCockpitFrameFromPlan, { data, plannedFrame }), {
      stdout: output as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const failure = await paintRefusal(app);
  app.unmount();
  app.cleanup();
  return failure;
}

/** The last write that carried cells — debug:false interleaves bare escapes. */
function lastShippedFrame(io: { writes: readonly string[] }): string {
  for (let index = io.writes.length - 1; index >= 0; index -= 1) {
    const frame = stripAnsi(io.writes[index]!);
    if (frame.trim().length > 0) return frame;
  }
  return "";
}

/** Run the shipped surface (`debug:false`) and hold its real 64x18 frame to the guard. */
async function shippedPathConforms(
  resizeFrom?: { readonly columns: number; readonly rows: number },
): Promise<void> {
  const repo = mkRepo();
  const runId = "run-20260729-134321";
  seedJournal(repo, runId, PLANNED_FRAME_RAW);
  const opening = resizeFrom ?? { columns: 64, rows: 18 };
  const io = makeInkStreams(opening.columns, opening.rows);
  const seam = deliveryPromise();
  let refusal: string | undefined;
  const done = runLiveCockpit({
    input: io.input,
    output: io.output,
    cwd: repo,
    runId,
    binaryVersion: "9.8.7",
    refreshMs: 60_000,
    debug: false,
    onDelivery: seam.accept,
  }).catch((error: unknown) => {
    refusal = error instanceof Error ? error.message : String(error);
  });
  const delivery = await seam.ready;
  try {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (lastShippedFrame(io) !== "") break;
      await wait(20);
    }
    if (resizeFrom !== undefined) {
      const before = io.writes.length;
      const output = io.output as NodeJS.WriteStream & {
        columns: number;
        rows: number;
      };
      output.columns = 64;
      output.rows = 18;
      output.emit("resize");
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (
          io.writes.length > before
          && lastShippedFrame(io).split("\n").every((line) => cellWidth(line) <= 64)
        ) break;
        await wait(20);
      }
    }
    const plan = planRunCockpitFrame({
      data: delivery.snapshot().data,
      columns: 64,
      rows: 18,
      interaction: delivery.snapshot().interaction,
    }).plan;
    expect(plan.kind).toBe("frame");
    if (plan.kind !== "frame") throw new Error("64x18 planned plain output");
    const bytes = lastShippedFrame(io);
    // The guard tolerates the one transport newline the shipped path appends.
    expect(bytes.replace(/\n$/u, "").split("\n")).toHaveLength(plan.size.rows);
    expect(() => assertFrameConformance(plan, bytes)).not.toThrow();
    expect(() => assertFrameConformance(plan, `${bytes}\nsurplus`))
      .toThrow(/drawn frame has \d+ rows/u);
  } finally {
    io.input.write("\u0003");
    await done;
  }
  expect(refusal).toBeUndefined();
}

type FrameContractSweepMode = "sampled" | "exhaustive";

interface FrameContractSize {
  readonly columns: number;
  readonly rows: number;
}

const stridedAxis = (minimum: number, maximum: number, stride: number): number[] => {
  const values: number[] = [];
  for (let value = minimum; value <= maximum; value += stride) values.push(value);
  if (values.at(-1) !== maximum) values.push(maximum);
  return values;
};

/** One selector owns both breadths; sampled mode changes only the axis strides. */
function frameContractSweepSizes(mode: FrameContractSweepMode): FrameContractSize[] {
  const exhaustive = mode === "exhaustive";
  const columns = stridedAxis(
    FRAME_CONTRACT_DOMAIN.minColumns,
    FRAME_CONTRACT_DOMAIN.maxColumns,
    exhaustive ? 1 : 15,
  );
  const rows = stridedAxis(
    FRAME_CONTRACT_DOMAIN.minRows,
    FRAME_CONTRACT_DOMAIN.maxRows,
    exhaustive ? 1 : 4,
  );
  return columns.flatMap((column) =>
    rows.map((row) => ({ columns: column, rows: row })),
  );
}

/** Every selected size, regardless of breadth, passes through this one production oracle. */
async function expectFrameContractSize({
  columns,
  rows,
}: FrameContractSize): Promise<void> {
  const { frame, plan } = await plannedFrameAt(
    PLANNED_FRAME_RAW,
    columns,
    rows,
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${columns}x${rows}: ${message}`);
  });
  expect(plan.kind, `${columns}x${rows}`).toBe("frame");
  if (plan.kind !== "frame") throw new Error("contract size planned plain output");
  expect(frame.split("\n"), `${columns}x${rows} row count`)
    .toHaveLength(plan.size.rows);
  expect(() => assertFrameConformance(plan, frame), `${columns}x${rows} regions`)
    .not.toThrow();
}

async function expectFrameContractSweep(sizes: readonly FrameContractSize[]): Promise<void> {
  let previousColumns: number | undefined;
  for (const size of sizes) {
    if (size.columns !== previousColumns) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      previousColumns = size.columns;
    }
    await expectFrameContractSize(size);
  }
}

describe("run cockpit draw-time frame plan", () => {
  test("test: the default sweep plans at most 150 sizes including all four domain corners and both extremes of each axis, and holds every planned size to the frame contract", async () => {
    const planned = frameContractSweepSizes("sampled");
    const keys = new Set(planned.map(({ columns, rows }) => `${columns}x${rows}`));
    const {
      minColumns,
      maxColumns,
      minRows,
      maxRows,
    } = FRAME_CONTRACT_DOMAIN;

    expect(planned.length).toBeLessThanOrEqual(150);
    for (const key of [
      `${minColumns}x${minRows}`,
      `${minColumns}x${maxRows}`,
      `${maxColumns}x${minRows}`,
      `${maxColumns}x${maxRows}`,
    ]) expect(keys.has(key), key).toBe(true);
    expect(planned.map(({ columns }) => columns))
      .toEqual(expect.arrayContaining([minColumns, maxColumns]));
    expect(planned.map(({ rows }) => rows))
      .toEqual(expect.arrayContaining([minRows, maxRows]));
    expect(planned.some(({ columns, rows }) =>
      columns > minColumns
      && columns < maxColumns
      && rows > minRows
      && rows < maxRows,
    )).toBe(true);

    await expectFrameContractSweep(planned);
  });

  test("test: with the exhaustive opt-in set the planned size list is exactly the full contract domain, and both modes select sizes through the same list function", () => {
    const expected = [];
    for (
      let columns = FRAME_CONTRACT_DOMAIN.minColumns;
      columns <= FRAME_CONTRACT_DOMAIN.maxColumns;
      columns += 1
    ) {
      for (
        let rows = FRAME_CONTRACT_DOMAIN.minRows;
        rows <= FRAME_CONTRACT_DOMAIN.maxRows;
        rows += 1
      ) expected.push({ columns, rows });
    }

    const sampled = frameContractSweepSizes("sampled");
    expect(frameContractSweepSizes("exhaustive")).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(sampled));
  });

  test("the default suite's sweep cost is bounded by its sample size rather than a raised timeout — no per-test timeout override remains on the default path, and the per-size conformance assertions are identical between the sampled and exhaustive paths", () => {
    expect(frameContractSweepSizes("sampled").length)
      .toBeLessThan(frameContractSweepSizes("exhaustive").length);
    const source = readFileSync(import.meta.filename, "utf8");
    const defaultStart = source.indexOf(
      'test("test: the default sweep plans at most 150 sizes',
    );
    const defaultPath = source.slice(
      defaultStart,
      source.indexOf("\n  });", defaultStart),
    );
    const exhaustiveStart = source.lastIndexOf(
      '"test: every planned region is drawn at its planned offset',
    );
    const exhaustivePath = source.slice(
      exhaustiveStart,
      source.indexOf("\n  );", exhaustiveStart),
    );
    expect(defaultPath).not.toContain("TICKMARKR_SWEEP_TIMEOUT_MS");
    expect(defaultPath).toContain("await expectFrameContractSweep(planned)");
    expect(exhaustivePath).toContain("await expectFrameContractSweep(");
    expect(exhaustivePath).toContain('frameContractSweepSizes("exhaustive")');
  });

  test.skipIf(process.env.TICKMARKR_EXHAUSTIVE_SWEEP !== "1")(
    "test: every planned region is drawn at its planned offset and span, at every size in the contract domain",
    async () => {
      await expectFrameContractSweep(
        frameContractSweepSizes("exhaustive"),
      );
      // OBS-143 load-margin reasoning: the sweep renders every contract size through ink, so a
      // full-suite run under parallel-fork contention measured 249s against the old 240s guard —
      // a load flake, not a runaway. 600s is a load-proof budget over the slowest observed pass;
      // the conformance assertions remain the oracle, this is only the runaway guard.
    },
    Number(process.env.TICKMARKR_SWEEP_TIMEOUT_MS ?? 600_000),
  );

  /** Proven mechanically: the plan is deep-frozen before it enters the production paint. */
  test("test: the plan is consumed unmodified — nothing rewrites its size, region offsets, spans or rowSpans", async () => {
    const data = deriveLiveRunCockpitData(
      { fileName: "run-planned-frame.journal.jsonl", raw: PLANNED_FRAME_RAW },
      "9.8.7",
    );
    for (const [columns, rows] of [[140, 40], [140, 24], [64, 18], [50, 20], [40, 14]]) {
      const at = `${columns!}x${rows!}`;
      const planned = planRunCockpitFrame({ data, columns: columns!, rows: rows! });
      const plan = planned.plan;
      expect(plan.kind, at).toBe("frame");
      if (plan.kind !== "frame") throw new Error(`${at} planned plain output`);
      if (planned.content === undefined) {
        throw new Error(`${at} planned no region content`);
      }

      const caption =
        `${data.runId} · ${data.branch} · ${data.status} · ${data.elapsed} · zone ${hostZoneLabel()}`;
      const authoritative = planFrame({ columns: columns!, rows: rows! }, plan.view, {
        tab: plan.tab,
        detail: planned.interaction.opened !== null,
        captionCells: cellWidth(caption),
      });
      if (authoritative.kind !== "frame") throw new Error(`${at} planFrame went plain`);
      for (const field of ["view", "tab", "band", "content", "flexible", "surrendered"] as const) {
        expect(plan[field], `${at} ${field}`).toEqual(authoritative[field]);
      }

      // The plan is planFrame's own return, consumed unmodified.
      expect(plan.size, `${at} size`).toEqual(authoritative.size);
      expect(plan.regions, `${at} regions`).toEqual(authoritative.regions);
      expect(plan.rowSpans, `${at} rowSpans`).toEqual(authoritative.rowSpans);
      expect(plan.columnSpans, `${at} columnSpans`)
        .toEqual(authoritative.columnSpans);

      let tiled = 0;
      for (const [id, span] of Object.entries(plan.rowSpans)) {
        const band = plan.regions.find((region) => region.id === id);
        if (band === undefined) throw new Error(`${at} ${id} unplanned`);
        expect(band.rows, `${at} ${id} span`).toBe(span);
        const host = FRAME_NESTED_ROW_BANDS[
          id as keyof typeof FRAME_NESTED_ROW_BANDS
        ];
        if (host !== undefined) {
          // A nested band refines the band that hosts it rather than tiling
          // beside it, so it advances no row cursor and is held to that extent.
          const within = plan.regions.find((region) => region.id === host)!;
          expect(band.row, `${at} ${id} offset`)
            .toBeGreaterThanOrEqual(within.row);
          expect(band.row + band.rows, `${at} ${id} extent`)
            .toBeLessThanOrEqual(within.row + within.rows);
          continue;
        }
        expect(band.row, `${at} ${id} offset`).toBe(tiled);
        tiled += span;
      }
      expect(tiled, `${at} tiled height`).toBe(plan.size.rows);

      // The draw path writes nothing into the plan it was handed.
      const sizeBefore = plan.size;
      const frame = await drawPlanned(data, { ...planned, plan: frozen(plan) });
      expect(() => assertFrameConformance(plan, frame), `${at} conformance`)
        .not.toThrow();
      expect(plan.size, `${at} size after paint`).toEqual(sizeBefore);
    }
  }, 60_000);

  test("test: mutating a planned span makes the drawn frame fail its conformance assertion at every presentation the run cockpit itself draws, not only its default run presentation", async () => {
    const data = deriveLiveRunCockpitData(
      { fileName: "run-planned-frame.journal.jsonl", raw: PLANNED_FRAME_RAW },
      "9.8.7",
    );
    for (const interaction of presentationStates()) {
      const plannedFrame = planRunCockpitFrame({
        data,
        columns: 140,
        rows: 24,
        interaction,
      });
      const mutated = {
        ...plannedFrame,
        plan: redistributedSpans(plannedFrame.plan),
      };
      // The mutation keeps the plan internally tiled, so the pre-render span
      // invariant passes it; the refusal must come from the paint-time guard
      // measuring the regions the renderer actually drew — the "drawn region"
      // failure exists only there.
      const failure = await paintConformanceFailure(data, mutated);
      expect(
        failure,
        `${interaction.tab}/${interaction.activeView}/${interaction.help}/${interaction.opened}`,
      ).toMatch(/drawn region/u);
    }
  });


  /** The cells of one planned region, read out of the drawn frame in display cells. */
  const regionCells = (
    frame: string,
    region: { row: number; rows: number; column: number; columns: number },
  ): readonly string[] =>
    frame.split("\n").slice(region.row, region.row + region.rows).map((line) =>
      [...line].slice(region.column, region.column + region.columns).join("")
    );

  const MARK_GLYPHS = new RegExp(COCKPIT_MARK_ALPHABET, "gu");
  /** The border glyphs an unboxed region draws none of. */
  const BORDER_GLYPHS = /[\u250c-\u256c\u2570-\u257f]/u;
  /** The sparkline's eighth-block ramp, and the meter's fill and track. */
  const SPARKLINE_GLYPHS = /[\u2581-\u2588]/u;
  const METER_GLYPHS = /[\u2588\u2591]/u;
  test("test: the contract's frame draws — one plain header line, no mark glyph, no keys rail, unboxed sidebar vitals", async () => {
    // The KEYS rail is gone from the renderer itself, so a restored rail fails here.
    expect(RENDERER_SOURCE).not.toContain('title="KEYS"');
    const data = deriveLiveRunCockpitData(
      { fileName: "run-planned-frame.journal.jsonl", raw: PLANNED_FRAME_RAW },
      "9.8.7",
    );
    for (
      const [columns, rows] of [
        [220, 50],
        [140, 40],
        [140, 24],
        [100, 24],
        [64, 18],
        [64, 17],
        [64, 16],
        [64, 15],
        [64, 14],
      ]
    ) {
      const at = `${columns!}x${rows!}`;
      const { frame, plan } = await plannedFrameAt(PLANNED_FRAME_RAW, columns!, rows!);
      if (plan.kind !== "frame") throw new Error(`${at} planned plain output`);
      const lines = frame.split("\n");

      // One plain header LINE: one row, the brand word exactly once at any indentation.
      const header = plan.regions.find((region) => region.id === "header")!;
      expect(header.rows, `${at} header span`).toBe(1);
      const signatures = findHeaderSignatures(lines);
      expect(signatures.length, `${at} header count`).toBe(1);
      expect(signatures[0]!.row, `${at} header row`).toBe(header.row);
      expect(regionCells(frame, header)[0], `${at} header is plain`)
        .not.toMatch(BORDER_GLYPHS);
      expect(regionCells(frame, header)[0], `${at} watch tab`).toContain("WATCH");
      expect(regionCells(frame, header)[0], `${at} decisions tab`).toContain("DECISIONS");
      expect(frame.match(/zone (?:UTC|[+-]\d{2}(?::\d{2})?)/gu), `${at} zone label`)
        .toHaveLength(1);

      expect(
        lines.flatMap((line) => [...line.matchAll(MARK_GLYPHS)]).length,
        `${at} mark glyphs`,
      ).toBe(0);

      expect(frame, `${at} keys rail`).not.toContain("KEYS");

      // Unboxed sidebar vitals: counts, sparkline and meter still drawn, in the rail's columns.
      const rail = plan.regions.find((region) => region.id === "rail");
      expect(rail, `${at} rail planned`).toBeDefined();
      const vitals = regionCells(frame, rail!).join("\n");
      expect(vitals, `${at} tasks count`)
        .toContain(`${data.tasks.done}/${data.tasks.total}`);
      expect(vitals, `${at} gates count`)
        .toContain(`${data.gates.passed}/${data.gates.total}`);
      expect(vitals, `${at} sparkline`).toMatch(SPARKLINE_GLYPHS);
      expect(vitals, `${at} meter`).toMatch(METER_GLYPHS);
      expect(vitals, `${at} unboxed`).not.toMatch(BORDER_GLYPHS);
    }
  }, 60_000);

  test("a sized plan below the floor draws the plain fallback rather than the legacy multi-panel cockpit", async () => {
    const data = deriveLiveRunCockpitData(
      { fileName: "run-planned-frame.journal.jsonl", raw: PLANNED_FRAME_RAW },
      "9.8.7",
    );
    const planned = planRunCockpitFrame({ data, columns: 39, rows: 13 });
    expect(planned.plan.kind).toBe("plain");
    const frame = await drawPlanned(data, planned);
    const lines = frame.replace(/\n+$/u, "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(13);
    expect(frame).toContain("tickmarkr");
    expect(frame.match(/zone (?:UTC|[+-]\d{2}(?::\d{2})?)/gu)).toHaveLength(1);
    expect(frame).not.toContain("VIEWS");
    expect(frame).not.toMatch(BORDER_GLYPHS);
  });

  test("at 40x14 the RUN panel's children fit the planned body span, so nothing overwrites the journal's closing border", async () => {
    const { frame, plan } = await plannedFrameAt(PLANNED_FRAME_RAW, 40, 14);
    if (plan.kind !== "frame") throw new Error("40x14 planned plain output");
    const body = plan.regions.find((region) => region.id === "body")!;
    const drawn = regionCells(frame, body);
    // Journal and panel each close with an intact border row; a forced element would overwrite one.
    expect(drawn.filter((line) => /[╰╚]/u.test(line)).length).toBe(2);
    const header = regionCells(frame, plan.regions.find((region) => region.id === "header")!)[0]!;
    expect(header).toContain("WATCH");
    expect(header).toContain("DECISIONS");
    expect(header).toContain("9.8.7");
    expect(frame.match(/zone (?:UTC|[+-]\d{2}(?::\d{2})?)/gu)).toHaveLength(1);
  });

  test("test: the journal tail rides, shrinks and disappears by height tier, and opening a row draws its detail in the body", async () => {
    for (const [rows, tailRows] of [[50, 3], [24, 3], [23, 1], [16, 1], [15, 0], [14, 0]]) {
      const at = `100x${rows!}`;
      const { frame, plan } = await plannedFrameAt(PLANNED_FRAME_RAW, 100, rows!);
      if (plan.kind !== "frame") throw new Error(`${at} planned plain output`);
      const tail = plan.regions.find((region) => region.id === "tail");
      expect(tail?.rows ?? 0, `${at} tail span`).toBe(tailRows);
      if (tail === undefined) continue;
      const drawn = regionCells(frame, tail);
      expect(drawn.length, `${at} tail rows drawn`).toBe(tailRows);
      expect(drawn.some((line) => line.trim().length > 0), `${at} tail content`)
        .toBe(true);
    }

    // Opening a row draws its detail IN THE BODY, in the body's own planned cells.
    const opened: RunInteractionState = {
      ...initialRunInteractionState(),
      activeView: "gates",
      railSelection: 2,
      opened: "gate:2",
      selection: "gate:2",
    };
    const { frame, plan } = await plannedFrameAt(PLANNED_FRAME_RAW, 140, 24, opened);
    if (plan.kind !== "frame") throw new Error("detail frame planned plain output");
    expect(plan.content.body).toBe("detail");
    const body = plan.regions.find((region) => region.id === "body")!;
    expect(regionCells(frame, body).join("\n")).toContain("GATE DETAIL");
    const tail = plan.regions.find((region) => region.id === "tail")!;
    expect(regionCells(frame, tail).some((line) => line.trim().length > 0))
      .toBe(true);
  }, 60_000);

  test("test: resizing the terminal mid-session re-plans and redraws at the new size, and the frame drawn after the resize carries no line wider than the new width", async () => {
    const repo = mkRepo();
    const runId = "run-20260729-134320";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("spec/planned-frame"), "the wide frame");
      const before = io.writes.length;
      const output = io.output as NodeJS.WriteStream & { columns: number; rows: number };
      output.columns = 64;
      output.rows = 18;
      output.emit("resize");
      const replanned = planRunCockpitFrame({
        data: delivery.snapshot().data,
        columns: 64,
        rows: 18,
        interaction: delivery.snapshot().interaction,
      }).plan;
      const resized = await waitForLastFrame(
        io,
        (frame) => io.writes.length > before
          && frame.split("\n").length === replanned.size.rows
          && frame.split("\n").every((line) => cellWidth(line) <= 64),
        "the replanned 64x18 frame",
      );
      expect(replanned.kind).toBe("frame");
      if (replanned.kind !== "frame") throw new Error("resize planned plain output");
      expect(() => assertFrameConformance(replanned, resized)).not.toThrow();
      expect(resized.split("\n").every((line) => cellWidth(line) <= 64)).toBe(true);
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: a production journal row containing a ZWJ grapheme draws without the conformance assertion rejecting the frame, because run-cockpit.tsx and live.ts measure display cells only through the width module and carry no width arithmetic of their own", async () => {
    // Neither file may hold width arithmetic of its own: cells are counted by
    // ./width.js alone, which is what makes the ZWJ row below measurable.
    for (const source of [RENDERER_SOURCE, LIVE_SOURCE]) {
      expect(source).not.toContain('from "string-width"');
      expect(source).not.toMatch(/\.length\s*(?:[*+-]|>=?|<=?)\s*(?:columns|width)/u);
    }
    expect(RENDERER_SOURCE).toContain('from "./width.js"');
    const family = "👨‍👩‍👧‍👦";
    const raw = rawOf([
      ev(
        "run-start",
        { branch: "spec/zwj", pid: process.pid },
        "2026-07-29T13:43:19.000Z",
      ),
      ev(
        `journal-family-${family}`,
        {},
        "2026-07-29T13:43:20.000Z",
        "T4",
      ),
    ]);
    const { frame, plan } = await plannedFrameAt(raw, 80, 24);
    expect(frame).toContain(family);
    expect(cellWidth(family)).toBe(2);
    expect(plan.kind).toBe("frame");
    if (plan.kind !== "frame") throw new Error("ZWJ frame planned plain output");
    expect(() => assertFrameConformance(plan, frame)).not.toThrow();
  });

  test("test: conformance holds on the shipped debug:false path at 64x18, on launch and after a resize", async () => {
    const data = deriveLiveRunCockpitData(
      { fileName: "run-planned-frame.journal.jsonl", raw: PLANNED_FRAME_RAW },
      "9.8.7",
    );
    const plannedFrame = planRunCockpitFrame({ data, columns: 140, rows: 24 });
    const mutated = {
      ...plannedFrame,
      plan: redistributedSpans(plannedFrame.plan),
    };
    // The production refusal must be the guard's own verdict, so the suite
    // computes it directly: the mutated plan checked against the regions the
    // untampered plan authors. The production mount draws the mutated plan's
    // spans — the paint follows the plan it is handed — and the refusal comes
    // from the guard's authorship oracle, the plan re-planned from the same
    // inputs; both checks name the same drawn region.
    const { frame, plan } = await plannedFrameAt(PLANNED_FRAME_RAW, 140, 24);
    if (plan.kind !== "frame") throw new Error("planned frame went plain");
    // The production path's refusal IS assertFrameConformance's refusal: the
    // suite's guard and production's are one function, proven by the message.
    const direct = (() => {
      try {
        assertFrameConformance(
          mutated.plan as PlannedFrame,
          frame,
          plan.regions,
        );
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(direct).toMatch(/drawn region/u);
    // No environment disables it — a bypass is a source change a reviewer sees,
    // never a variable a runner sets. The renderer reads no environment at all.
    expect(RENDERER_SOURCE).not.toContain("process.env");
    for (
      const [name, value] of [
        ["TICKMARKR_ASSERT_FRAME_CONFORMANCE", "0"],
        ["NODE_ENV", "production"],
        ["CI", "true"],
      ]
    ) {
      const previous = process.env[name!];
      process.env[name!] = value;
      try {
        expect(await paintConformanceFailure(data, mutated), name).toBe(direct);
      } finally {
        if (previous === undefined) delete process.env[name!];
        else process.env[name!] = previous;
      }
    }
    // The refusal is the mounted renderer's own: production region measurement is what this oracle stands on.
    await expect(drawPlanned(data, mutated)).rejects.toThrow(/drawn region/u);
    // No environment disables it: the renderer reads none at all.
    expect(RENDERER_SOURCE).not.toContain("process.env");
    // The shipped path appends a newline of its own — transport, not a drawn row.
    await shippedPathConforms();
    await shippedPathConforms({ columns: 140, rows: 24 });

    // A redistributed plan committed by a resize on the shipped transport is
    // refused in the cycle its frame is emitted.
    const resized = planRunCockpitFrame({ data, columns: 64, rows: 18 });
    if (resized.plan.kind !== "frame") throw new Error("64x18 planned plain");
    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
      rows: number;
    };
    output.isTTY = true;
    output.columns = 140;
    output.rows = 24;
    output.resume();
    const writes: string[] = [];
    const write = output.write.bind(output);
    output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return Reflect.apply(write, output, [chunk, ...args]) as boolean;
    }) as typeof output.write;
    const shipped = render(
      createElement(RunCockpitFrameFromPlan, { data, plannedFrame }),
      {
        stdout: output as unknown as NodeJS.WriteStream,
        debug: false,
        patchConsole: false,
      },
    );
    try {
      for (let attempts = 0; attempts < 100; attempts += 1) {
        // The whole 140x24 frame, so its scheduled validation has settled.
        if (
          writes.some((chunk) =>
            stripAnsi(chunk).replace(/\n$/u, "").split("\n").length >= 24
          )
        ) break;
        await wait(20);
      }
      await wait(50);
      shipped.rerender(
        createElement(RunCockpitFrameFromPlan, {
          data,
          plannedFrame: { ...resized, plan: redistributedSpans(resized.plan) },
        }),
      );
      const refusal = await Promise.race([
        shipped.waitUntilExit().then(
          () => undefined,
          (error: unknown) => error instanceof Error ? error.message : String(error),
        ),
        wait(4_000).then(() => "no refusal arrived"),
      ]);
      expect(refusal).toMatch(/drawn region/u);
    } finally {
      shipped.unmount();
      shipped.cleanup();
    }
  });

  test("test: the stale rendered anchors and the goldens this redesign changes are retired, not re-stamped", () => {
    const corpus = join(import.meta.dirname, "../fixtures/cockpit");
    const anchors = join(corpus, "anchors");
    const frames = join(corpus, "frames");
    const colour = join(corpus, "colour");
    const machineSurfaces = [
      "run.ci.140x24.txt",
      "run.non-tty.140x24.txt",
    ] as const;
    const staleRenderedAnchors = [
      "run.height-24.140x24.txt",
      "run.height-40.140x40.txt",
      "run.no-colour.140x24.txt",
      "run.width-folded-keys.100x24.txt",
      "run.width-stacked.80x24.txt",
      "run.width-three-column.140x24.txt",
    ] as const;
    const supersededGoldens = [
      "run.height-14.140x14.txt",
      "run.height-18.140x18.txt",
      ...staleRenderedAnchors,
    ] as const;
    const supersededColourGoldens = [
      "run-20260718-000943.colour.140x24.txt",
      "run-20260718-000943.no-colour.140x24.txt",
      "run-20260725-025004.interrupted.colour.140x24.txt",
    ] as const;

    // T14 keeps the old frozen bytes on disk but retires all six through the
    // production manifest. The active anchor set is therefore exactly as small
    // as T13's deletion made it, while the retained bytes add proof that no
    // replacement appearance was re-frozen under an old fixture name.
    const retiredRenderedAnchors = new Set(
      GOLDEN_FRAME_CASES
        .filter((item) =>
          isRetiredGoldenFrame(item)
          && staleRenderedAnchors.some((fixture) => fixture === item.fixture)
        )
        .map((item) => item.fixture),
    );
    expect([...retiredRenderedAnchors].sort())
      .toEqual([...staleRenderedAnchors].sort());

    // The regenerable goldens cannot retire by deletion: the shipped capture
    // manifest the diff-cap gate measures claims every one, and the gate's
    // drift test fails on a member that does not exist. So they retire by
    // declaration instead — manifested, on disk, exempt from the byte-compare
    // — and what proves they were not re-stamped is that every retired byte
    // string still draws the superseded appearance: the mark's compact lockup
    // and the KEYS rail, both gone from every frame the renderer draws today.
    const lockupRows = PLAIN_COMPACT_LOCKUP.split("\n");
    for (const fixture of supersededGoldens) {
      const bytes = readFileSync(join(frames, fixture), "utf8");
      // The mark's glyph row and the KEYS rail: both gone from every frame the
      // renderer draws today, both present in every retired byte string.
      expect(bytes, `golden ${fixture}`).toContain(lockupRows[0]!.trimEnd());
      expect(bytes, `golden ${fixture}`).toContain("KEYS");
    }
    for (const fixture of staleRenderedAnchors) {
      const bytes = readFileSync(join(anchors, fixture), "utf8");
      expect(bytes.length, `anchor ${fixture}`).toBeGreaterThan(0);
      expect(bytes, `anchor ${fixture}`).toMatch(MARK_GLYPHS);
      expect(bytes, `anchor ${fixture}`).toContain("KEYS");
    }
    for (const fixture of supersededColourGoldens) {
      const bytes = readFileSync(join(colour, fixture), "utf8");
      expect(bytes.length, `colour ${fixture}`).toBeGreaterThan(0);
      expect(bytes, `colour ${fixture}`).toContain("KEYS");
    }

    // The two machine surfaces are the only remaining run anchors, and their
    // entire bytes stay compared rather than entering the retired MARK/KEYS
    // projection.
    expect(
      readdirSync(anchors)
        .filter((file) =>
          file.startsWith("run.") && !retiredRenderedAnchors.has(file)
        )
        .sort(),
    )
      .toEqual([...machineSurfaces]);
    expect(readdirSync(frames).filter((file) => file.startsWith("run.")).sort())
      .toEqual([...machineSurfaces, ...supersededGoldens].sort());
    for (const fixture of machineSurfaces) {
      expect(readFileSync(join(frames, fixture), "utf8"), fixture)
        .toBe(readFileSync(join(anchors, fixture), "utf8"));
    }
  });

  test("the renderer consumes the plan and derives no geometry of its own", async () => {
    const data = deriveLiveRunCockpitData(
      { fileName: "run-planned-frame.journal.jsonl", raw: PLANNED_FRAME_RAW },
      "9.8.7",
    );
    // Every presentation, so no one path keeps a private row budget.
    for (const interaction of presentationStates()) {
      const at = `${interaction.tab}/${interaction.activeView}/${interaction.help}/${interaction.opened}`;
      // Two measured sizes whose plans differ only by two body rows:
      // planFrame's body is the one flexible row element and both sizes sit in
      // the same height tier, so the two extra terminal rows move exactly the
      // body band's planned span — and nothing else.
      const planned = planRunCockpitFrame({
        data,
        columns: 100,
        rows: 24,
        interaction,
      });
      const grown = planRunCockpitFrame({
        data,
        columns: 100,
        rows: 26,
        interaction,
      });
      if (planned.plan.kind !== "frame" || grown.plan.kind !== "frame") {
        throw new Error(`${at} a sized frame went plain`);
      }
      expect(grown.plan.rowSpans.body, `${at} body span`)
        .toBe(planned.plan.rowSpans.body! + 2);
      expect(grown.plan.size.rows, `${at} planned height`)
        .toBe(planned.plan.size.rows + 2);

      // The drawn frame moves with the plan: taller by exactly the rows
      // planFrame added to the body span. A renderer holding a geometry model
      // of its own would draw the same frame twice — and drawPlanned holds
      // each paint to the production guard's refusal, so both frames also
      // conform band by band.
      const drawn = await drawPlanned(data, planned);
      const redrawn = await drawPlanned(data, grown);
      expect(drawn.split("\n"), `${at} baseline`)
        .toHaveLength(planned.plan.size.rows);
      expect(redrawn.split("\n").length, `${at} drawn follows the plan`)
        .toBe(drawn.split("\n").length + 2);
      expect(
        () => assertFrameConformance(grown.plan as PlannedFrame, redrawn),
        `${at} grown conformance`,
      ).not.toThrow();
    }
  }, 60_000);
});

describe("ui command (live cockpit)", () => {
  test("test: the live surface routes input at the width it is measured at, so a terminal too narrow for the rail moves the view itself rather than a rail it never drew", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-090000";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    // 50 columns: the plan draws the view strip, not the rail. A delivery that
    // assumed a width would route this arrow to a sidebar nothing painted.
    const io = makeInkStreams(50, 20);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the narrow frame");
      const planned = planRunCockpitFrame({
        data: delivery.snapshot().data,
        columns: 50,
        rows: 20,
        interaction: delivery.snapshot().interaction,
      }).plan;
      if (planned.kind !== "frame") throw new Error("50x20 planned plain output");
      expect(planned.band).toBe("strip");

      delivery.key({ input: "", key: { downArrow: true } });
      expect(delivery.snapshot().interaction.activeView).toBe("tasks");
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} TASKS`),
        "the Tasks view the arrow opened",
      );
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("a pointer report split across stream chunks acts when its last byte arrives, drawing the view the click named", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-090500";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the opening frame");
      const surface = liveRunPointerSurface(
        delivery.snapshot().data,
        delivery.snapshot().interaction,
        { columns: 140, rows: 24 },
      );
      if (surface === undefined) throw new Error("140x24 planned plain output");
      const rail = surface.plan.regions.find((region) => region.id === "rail");
      if (rail === undefined || surface.plan.sidebar === null) {
        throw new Error("the plan drew no rail at 140 columns");
      }
      // The Gates row of the rail the plan drew, reported in the terminal's own
      // one-based cells.
      const column = rail.column + 3;
      const row = rail.row + (surface.plan.sidebar.menuRows - RUN_VIEWS.length)
        + RUN_VIEWS.findIndex((view) => view.id === "gates") + 1;

      // The terminal writes bytes, not messages: this one report arrives in two
      // chunks. Half a report acts on nothing.
      io.input.write(`\x1b[<0;${column};`);
      await wait(60);
      expect(delivery.snapshot().interaction.activeView).toBe("run");

      io.input.write(`${row}M`);
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the Gates view the split report clicked",
      );
      expect(delivery.snapshot().interaction.activeView).toBe("gates");
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("a click delivered with the filter prompt open draws the view it named rather than being typed into the query", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-091500";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the opening frame");
      // The Gates view with its own / prompt open: the scope in which a digit
      // is filter text and ⏎ applies a filter.
      delivery.key({ input: "3", key: {} });
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the Gates view",
      );
      delivery.key({ input: "/", key: {} });
      expect(delivery.snapshot().interaction.filterPrompt).toBe(true);

      const surface = liveRunPointerSurface(
        delivery.snapshot().data,
        delivery.snapshot().interaction,
        { columns: 140, rows: 24 },
      );
      if (surface === undefined) throw new Error("140x24 planned plain output");
      const rail = surface.plan.regions.find((region) => region.id === "rail");
      if (rail === undefined || surface.plan.sidebar === null) {
        throw new Error("the plan drew no rail at 140 columns");
      }
      // The Tasks row of the rail the plan drew, in the terminal's own cells.
      const column = rail.column + 3;
      const row = rail.row + (surface.plan.sidebar.menuRows - RUN_VIEWS.length)
        + RUN_VIEWS.findIndex((view) => view.id === "tasks") + 1;
      io.input.write(`\x1b[<0;${column};${row}M`);

      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} TASKS`),
        "the Tasks view the click named",
      );
      const interaction = delivery.snapshot().interaction;
      expect(interaction.activeView).toBe("tasks");
      // The click was never read as text: no digit reached the query, and the
      // prompt it retired is closed rather than left holding the input.
      expect(interaction.filterQuery).toBe("");
      expect(interaction.filterPrompt).toBe(false);
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("a double click arriving as one batch of adjacent reports opens the row it was drawn on, on a list longer than the item rows the plan draws", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-093000";
    // More gate rows than the plan draws item rows, so the drawn window is a
    // scrolled slice of the list and moving the selection moves that slice.
    const seeded = Array.from({ length: 24 }, (_, index) =>
      ev(
        "gate-result",
        { gate: `gate-${String(index).padStart(2, "0")}`, pass: true },
        `2026-07-31T09:30:${String(index + 1).padStart(2, "0")}.000Z`,
        "T1",
      ));
    seedJournal(repo, runId, rawOf([
      ev(
        "run-start",
        { branch: "spec/live-double-click", pid: process.pid },
        "2026-07-31T09:30:00.000Z",
      ),
      ...seeded,
    ]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the opening frame");
      delivery.key({ input: "3", key: {} });
      // Walk the selection to the oldest row, which scrolls the drawn window
      // off the head of the list.
      for (let step = 0; step < seeded.length; step += 1) {
        delivery.key({ input: "", key: { downArrow: true } });
      }
      await waitForLastFrame(
        io,
        (frame) => selectedLine(frame, "gate-00") !== undefined,
        "the scrolled window with the oldest gate selected",
      );

      const scrolled = liveRunPointerSurface(
        delivery.snapshot().data,
        delivery.snapshot().interaction,
        { columns: 140, rows: 24 },
      );
      if (scrolled === undefined) throw new Error("140x24 planned plain output");
      const items = scrolled.plan.regions.find((region) => region.id === "items");
      if (items === undefined) throw new Error("the plan planned no item rows");
      // The window really is a slice: the row drawn at the top of the panel is
      // not the view's first row, so a selection change moves what is drawn.
      expect(scrolled.rowIds.length).toBeGreaterThan(scrolled.drawnRowIds.length);
      expect(scrolled.drawnRowIds[0]).not.toBe(scrolled.rowIds[0]);
      const drawnFirst = scrolled.drawnRowIds[0];

      // One chunk, the way a terminal delivers a double click: press, release,
      // press, release, with no redraw between them. Both presses name the same
      // still-drawn cell, so the second is that row opening — not whichever row
      // a window re-planned around the first press would have slid under it.
      const cell = `${items.column + 5};${items.row + 1}`;
      io.input.write(
        `\x1b[<0;${cell}M\x1b[<0;${cell}m\x1b[<0;${cell}M\x1b[<0;${cell}m`,
      );

      await waitForLastFrame(
        io,
        (frame) => frame.includes("GATE DETAIL"),
        "the detail of the row the double click was drawn on",
      );
      const interaction = delivery.snapshot().interaction;
      expect(interaction.opened).toBe(drawnFirst);
      expect(interaction.selection).toBe(drawnFirst);
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("a key transition that has not been painted yet does not move the pointer's target: the click resolves through the frame the paint committed", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-095500";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the opening frame");
      const size = { columns: 140, rows: 24 };
      // The frame on the screen is the RUN view: its body draws no selectable
      // rows at all.
      const opening = delivery.snapshot();
      const drawn = liveRunPointerSurface(
        opening.data,
        opening.interaction,
        size,
      );
      if (drawn === undefined) throw new Error("140x24 planned plain output");
      expect(drawn.drawnRowIds).toEqual([]);

      // The key switches the state to Gates now, but the paint lags it: the
      // screen still shows the RUN frame, so that frame owns every hit.
      delivery.key({ input: "3", key: {} });
      expect(delivery.snapshot().interaction.activeView).toBe("gates");

      // The cell the UNPAINTED Gates plan would put on its first drawn gate
      // row (zero-based, as PointerReport counts cells). An input path that
      // planned for itself would select that row here.
      const switched = delivery.snapshot();
      const unpainted = liveRunPointerSurface(
        switched.data,
        switched.interaction,
        size,
      );
      if (unpainted === undefined) throw new Error("140x24 planned plain output");
      const items = unpainted.plan.regions.find((region) => region.id === "items");
      if (items === undefined) throw new Error("the plan planned no item rows");
      const cell = { column: items.column + 5, row: items.row };
      expect(resolvePointerTarget(unpainted.plan, cell)?.region.id).toBe("items");
      expect(unpainted.drawnRowIds[0]).toBeDefined();

      // Delivered before the paint, the same report selects nothing: the
      // committed RUN frame owns no row there. And the unpainted view switch
      // the click followed is not clobbered back either.
      delivery.pointer({ action: "press", ...cell });
      expect(delivery.snapshot().interaction.selection).toBe(null);
      expect(delivery.snapshot().interaction.activeView).toBe("gates");

      // Once the Gates frame is painted, the same cell acts on it.
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the painted Gates view",
      );
      delivery.pointer({ action: "press", ...cell });
      expect(delivery.snapshot().interaction.selection)
        .toBe(unpainted.drawnRowIds[0]);
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("a bare Escape from live stdin reaches the open filter prompt's cancel binding", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-092000";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the opening frame");
      delivery.key({ input: "3", key: {} });
      delivery.key({ input: "/", key: {} });
      delivery.key({ input: "x", key: {} });
      expect(delivery.snapshot().interaction).toMatchObject({
        filterPrompt: true,
        filterQuery: "x",
      });

      io.input.write("\x1b");
      for (let attempts = 0; attempts < 20; attempts += 1) {
        if (!delivery.snapshot().interaction.filterPrompt) break;
        await wait(10);
      }
      expect(delivery.snapshot().interaction).toMatchObject({
        filterPrompt: false,
        filterQuery: "",
        quit: false,
      });
    } finally {
      delivery.key({ input: "", key: { escape: true } });
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("a key before a click in one stdin chunk acts before that click", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-092500";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the opening frame");
      delivery.key({ input: "3", key: {} });
      delivery.key({ input: "/", key: {} });
      const surface = liveRunPointerSurface(
        delivery.snapshot().data,
        delivery.snapshot().interaction,
        { columns: 140, rows: 24 },
      );
      if (surface === undefined) throw new Error("140x24 planned plain output");
      const body = surface.plan.regions.find((region) => region.id === "body");
      if (body === undefined) throw new Error("the plan drew no body panel");

      // q belongs to the prompt while it is open. The click follows it in the
      // same terminal chunk, so q must grow the query before the click retires
      // the prompt. Reversing them makes q quit the surface. The panel chrome
      // stays present after q filters the item rows away, so the target itself
      // cannot disappear between these two ordered tokens.
      io.input.write(
        `q\x1b[<0;${body.column + 1};${body.row + 1}M`,
      );
      for (let attempts = 0; attempts < 20; attempts += 1) {
        if (!delivery.snapshot().interaction.filterPrompt) break;
        await wait(10);
      }
      expect(delivery.snapshot().interaction).toMatchObject({
        filterPrompt: false,
        filterQuery: "q",
        quit: false,
      });
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: pointer reporting is on only for an interactive terminal and off again on every exit, including a failing one", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-093000";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const baseline = POINTER_RELEASE_SIGNALS.map((signal) =>
      process.rawListeners(signal)
    );
    let rosterWhenAsked: readonly (readonly Function[])[] | undefined;
    const write = io.output.write.bind(io.output);
    io.output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const bytes = typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
      if (bytes.includes(POINTER_TRACKING_ON)) {
        rosterWhenAsked = POINTER_RELEASE_SIGNALS.map((signal) =>
          process.rawListeners(signal)
        );
      }
      return Reflect.apply(write, io.output, [chunk, ...args]) as boolean;
    }) as typeof io.output.write;
    // The shipped path, not the debug one: a terminal reports no pointer at all
    // until it is asked to, so without these bytes every click and wheel notch
    // an operator makes produces nothing and the pointer layer is unreachable.
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: false,
    });
    try {
      // The shipped path interleaves bare escapes with the writes that carry
      // cells, so the drawn frame is the last write that has any.
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (lastShippedFrame(io).includes("RUN")) break;
        await wait(20);
      }
      expect(lastShippedFrame(io)).toContain("RUN");
      const asked = io.writes.findIndex((bytes) => bytes.includes("\x1b[?1000h"));
      const painted = io.writes.findIndex((bytes) =>
        stripAnsi(bytes).trim().length > 0
      );
      expect(asked).toBeGreaterThanOrEqual(0);
      // Normal tracking is asked for in SGR encoding — the one grammar the
      // reader parses, and the only one that can state a cell past column 223.
      expect(io.writes[asked]).toContain("\x1b[?1006h");
      expect(painted).toBeGreaterThan(asked);
      // The live lifecycle is the one owner: every signal repayment stands
      // before the ask, and mounting the frame adds no second owner afterward.
      expect(rosterWhenAsked).toBeDefined();
      POINTER_RELEASE_SIGNALS.forEach((signal, index) => {
        expect(rosterWhenAsked?.[index], `${signal} stood before the ask`)
          .toHaveLength(baseline[index]!.length + 1);
      });
      // Ink may install its own SIGINT listener while mounted. Pointer mode
      // itself still has exactly one owner, proven by the one enable write.
      expect(io.writes.join("").split(POINTER_TRACKING_ON)).toHaveLength(2);
      // And tracking is still on while the surface is drawn.
      expect(io.writes.join("")).not.toContain("\x1b[?1000l");
    } finally {
      io.input.write("\u0003");
      await done;
    }
    // A terminal left tracking writes reports into whatever runs next.
    expect(io.writes.join("")).toContain(POINTER_TRACKING_OFF);
    POINTER_RELEASE_SIGNALS.forEach((signal, index) => {
      const borrowed = rosterWhenAsked?.[index].filter((listener) =>
        !baseline[index]!.includes(listener)
      ) ?? [];
      expect(borrowed, `${signal} had one repayment`).toHaveLength(1);
      expect(process.rawListeners(signal), `${signal} repayment was handed back`)
        .not.toContain(borrowed[0]);
    });
  });

  test("a synchronous mount failure turns pointer tracking off and removes the resize listener", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-093500";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const resizeListeners = io.output.listenerCount("resize");
    inkMount.failure = new Error("synchronous mount failure");
    try {
      await expect(runLiveCockpit({
        input: io.input,
        output: io.output,
        cwd: repo,
        runId,
        binaryVersion: "9.8.7",
        refreshMs: 60_000,
        debug: false,
      })).rejects.toThrow("synchronous mount failure");
    } finally {
      inkMount.failure = null;
    }

    const bytes = io.writes.join("");
    expect(bytes).toContain("\x1b[?1000h\x1b[?1006h");
    expect(bytes).toContain("\x1b[?1006l\x1b[?1000l");
    expect(io.output.listenerCount("resize")).toBe(resizeListeners);
  });

  test("an off-focus wheel report split across chunks reaches no key handler and cannot manufacture a mouse-only frame", async () => {
    const repo = mkRepo();
    const runId = "run-20260731-094500";
    seedJournal(repo, runId, PLANNED_FRAME_RAW);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes("RUN"), "the opening frame");
      // The Gates view with its own / prompt open: the scope in which a digit is
      // filter text.
      delivery.key({ input: "3", key: {} });
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the Gates view",
      );
      delivery.key({ input: "/", key: {} });
      const before = delivery.snapshot().interaction;
      expect(before.filterPrompt).toBe(true);

      const surface = liveRunPointerSurface(
        delivery.snapshot().data,
        before,
        { columns: 140, rows: 24 },
      );
      if (surface === undefined) throw new Error("140x24 planned plain output");
      const rail = surface.plan.regions.find((region) => region.id === "rail");
      if (rail === undefined) throw new Error("the plan drew no rail at 140 columns");
      // A rail cell the plan itself confirms, reported in the terminal's
      // one-based cells so its column is the bare digit 3 — the fragment a
      // terminal is free to leave in a chunk of its own, and a live key in both
      // rosters: a view key with no prompt open, filter text with one.
      const row = rail.row + 2;
      expect(resolvePointerTarget(surface.plan, { column: 2, row: row - 1 })?.region.id)
        .toBe("rail");

      // One wheel-down report, in three chunks, the middle one that bare digit.
      io.input.write("\x1b[<65;");
      await wait(40);
      io.input.write("3");
      await wait(40);
      expect(delivery.snapshot().interaction.filterQuery).toBe("");
      io.input.write(`;${row}M`);

      await wait(40);
      const after = delivery.snapshot().interaction;
      // The rail is not focused and ↓ is not in the prompt's advertised
      // roster. The wheel therefore has no transition: it neither fabricates
      // rail focus nor leaks any report fragment into the prompt.
      expect(after).toEqual(before);
    } finally {
      // ctrl-C, not q: the prompt this test leaves open is the scope in which q
      // is filter text.
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: two back-to-back moves delivered before any redraw advance the selection twice, driven through the live surface rather than a helper that waits between keys", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-150001";
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-current-moves", pid: process.pid }, "2026-07-27T15:00:00.000Z"),
      ev("gate-result", { gate: "first-event" }, "2026-07-27T15:00:01.000Z", "T1"),
      ev("gate-result", { gate: "second-event" }, "2026-07-27T15:00:02.000Z", "T1"),
    ]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });

    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      delivery.key({ input: "3", key: {} });
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`)
          && frame.includes(gateRowText("second-event"))
          && !frame.includes("PROGRESS"),
        "the active Gates view",
      );
      const writesBeforeMoves = io.writes.length;
      delivery.batch(() => {
        delivery.key({ input: "", key: { downArrow: true } });
        delivery.key({ input: "", key: { downArrow: true } });
        expect(delivery.snapshot().interaction.selection).toBe("gate:2");
        expect(io.writes).toHaveLength(writesBeforeMoves);
      });
      const moved = await waitForLastFrame(
        io,
        (frame) => selectedLine(frame, "first-event") !== undefined,
        "the twice-advanced selection",
      );
      expect(selectedLine(moved, "second-event")).toBeUndefined();
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("test: a key and a refresh that prepends a row so every position shifts, interleaved and driven through the live surface before any redraw in both orderings, starting with a row already selected and the key intending its neighbour, leave the selection on the row the key intended or cleared if that row is gone, never on a different row that happens to remain in range", async () => {
    for (const order of ["key-first", "refresh-first"] as const) {
      const repo = mkRepo();
      const runId = order === "key-first"
        ? "run-20260727-150002"
        : "run-20260727-150003";
      const start = ev("run-start", {
        branch: `spec/live-${order}`,
        pid: process.pid,
      }, "2026-07-27T15:00:00.000Z");
      const intended = ev("gate-result", { gate: "intended-neighbour" }, "2026-07-27T15:00:01.000Z", "T1");
      const selected = ev("gate-result", { gate: "selected-row" }, "2026-07-27T15:00:02.000Z", "T1");
      const prepended = ev("gate-result", { gate: "prepended-row" }, "2026-07-27T15:00:03.000Z", "T1");
      seedJournal(repo, runId, rawOf([start, intended, selected]));
      const io = makeInkStreams(140, 24);
      const seam = deliveryPromise();
      const done = runLiveCockpit({
        input: io.input,
        output: io.output,
        cwd: repo,
        runId,
        binaryVersion: "9.8.7",
        refreshMs: 60_000,
        debug: true,
        onDelivery: seam.accept,
      });

      try {
        const delivery = await seam.ready;
        await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
        await openGatesWithSelectedNewest(io, delivery, "selected-row");
        seedJournal(repo, runId, rawOf([start, intended, selected, prepended]));
        const writesBeforeRace = io.writes.length;
        delivery.batch(() => {
          if (order === "key-first") {
            delivery.key({ input: "", key: { downArrow: true } });
          }
          delivery.refresh();
          if (order === "refresh-first") {
            delivery.key({ input: "", key: { downArrow: true } });
          }
          expect(io.writes, order).toHaveLength(writesBeforeRace);
        });
        const raced = await waitForLastFrame(
          io,
          (frame) => selectedLine(frame, "intended-neighbour") !== undefined,
          `${order} preserving the intended neighbour`,
        );
        expect(selectedLine(raced, "selected-row"), order).toBeUndefined();
        expect(selectedLine(raced, "prepended-row"), order).toBeUndefined();
      } finally {
        io.input.write("\u0003");
        await done;
      }
    }

    // The other permitted result is clearing: the key first selects its real
    // neighbour, then a refresh removes that source row before either change
    // is drawn. A surviving in-range row must not inherit the pointer.
    const repo = mkRepo();
    const runId = "run-20260727-150008";
    const start = ev("run-start", {
      branch: "spec/live-intended-row-gone",
      pid: process.pid,
    }, "2026-07-27T15:00:00.000Z");
    const selected = ev("gate-result", { gate: "selected-row" }, "2026-07-27T15:00:01.000Z", "T1");
    const doomed = ev("gate-result", { gate: "doomed-neighbour" }, "2026-07-27T15:00:02.000Z", "T1");
    seedJournal(repo, runId, rawOf([start, selected, doomed]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the deletion arm's initial run");
      delivery.key({ input: "3", key: {} });
      delivery.key({ input: "", key: { downArrow: true } });
      delivery.key({ input: "", key: { downArrow: true } });
      await waitForLastFrame(
        io,
        (frame) => selectedLine(frame, "selected-row") !== undefined,
        "the row beside the doomed neighbour",
      );
      seedJournal(repo, runId, rawOf([start, selected]));
      const writesBeforeRemoval = io.writes.length;
      delivery.batch(() => {
        delivery.key({ input: "", key: { upArrow: true } });
        expect(delivery.snapshot().interaction.selection).toBe("gate:3");
        delivery.refresh();
        expect(delivery.snapshot().interaction.selection).toBeNull();
        expect(io.writes).toHaveLength(writesBeforeRemoval);
      });
      const cleared = await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("selected-row"))
          && !frame.includes(gateRowText("doomed-neighbour")),
        "the refreshed rows after the intended neighbour disappeared",
      );
      expect(selectedLine(cleared, "selected-row")).toBeUndefined();
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("test: the refresh-first ordering is proved by a delivery seam that applies the refresh to the live state before the key, so an arm that only touches the disk while both inputs run in one turn makes the assertion fail", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-150004";
    const start = ev("run-start", { branch: "spec/live-refresh-first", pid: process.pid }, "2026-07-27T15:00:00.000Z");
    const intended = ev("gate-result", { gate: "intended-neighbour" }, "2026-07-27T15:00:01.000Z", "T1");
    const selected = ev("gate-result", { gate: "selected-row" }, "2026-07-27T15:00:02.000Z", "T1");
    const prepended = ev("gate-result", { gate: "seam-applied-row" }, "2026-07-27T15:00:03.000Z", "T1");
    seedJournal(repo, runId, rawOf([start, intended, selected]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });

    try {
      const delivery = await seam.ready;
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      await openGatesWithSelectedNewest(io, delivery, "selected-row");
      seedJournal(repo, runId, rawOf([start, intended, selected, prepended]));
      const writesBeforeRace = io.writes.length;
      delivery.batch(() => {
        expect(delivery.snapshot().data.gateRows[0]?.gate).not.toContain("seam-applied-row");
        delivery.refresh();
        expect(delivery.snapshot().data.gateRows[0]?.gate).toContain("seam-applied-row");
        expect(delivery.snapshot().interaction.selection).toBe("gate:3");
        delivery.key({ input: "", key: { downArrow: true } });
        expect(delivery.snapshot().interaction.selection).toBe("gate:2");
        expect(io.writes).toHaveLength(writesBeforeRace);
      });
      await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("seam-applied-row"))
          && selectedLine(frame, "intended-neighbour") !== undefined,
        "the refresh-first live snapshot",
      );
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: two characters typed into the filter prompt before any redraw both land in the query in order, driven through the live surface", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-150005";
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-current-prompt", pid: process.pid }, "2026-07-27T15:00:00.000Z"),
      ev("gate-result", { gate: "alpha-event" }, "2026-07-27T15:00:01.000Z", "T1"),
    ]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });

    try {
      const delivery = await seam.ready;
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      delivery.key({ input: "3", key: {} });
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`)
          && frame.includes(gateRowText("alpha-event"))
          && !frame.includes("PROGRESS"),
        "the active Gates view",
      );
      delivery.key({ input: "/", key: {} });
      await waitForLastFrame(io, (frame) => frame.includes("text Edit"), "the filter prompt");
      const writesBeforeTyping = io.writes.length;
      delivery.batch(() => {
        delivery.key({ input: "a", key: {} });
        delivery.key({ input: "l", key: {} });
        expect(delivery.snapshot().interaction.filterQuery).toBe("al");
        expect(io.writes).toHaveLength(writesBeforeTyping);
      });
      await waitForLastFrame(
        io,
        (frame) => frame.includes("GATES /al") && frame.includes(gateRowText("alpha-event")),
        "the ordered filter query",
      );
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: the tab key switches the drawn surface between the watch tab and the decisions tab through the production live path, and each tab keeps its own selection state across the round trip, asserted on applied frames", async () => {
    const repo = mkRepo();
    const runId = "run-20260728-110001";
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-tabs", pid: process.pid }, "2026-07-28T11:00:00.000Z"),
      ev("gate-result", { gate: "watch-side-row" }, "2026-07-28T11:00:01.000Z", "T1"),
      ev("gate-result", { gate: "second-row" }, "2026-07-28T11:00:02.000Z", "T1"),
    ]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    try {
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      // The watch tab, carrying a row this operator selected on it.
      await openGatesWithSelectedNewest(io, delivery, "second-row");

      // Tab draws the decisions tab: its own rail, and none of the watch tab's
      // rows.
      delivery.key({ input: "", key: { tab: true } });
      const decisions = await waitForLastFrame(
        io,
        (frame) => frame.includes("SECTIONS"),
        "the decisions tab",
      );
      expect(decisions).toContain("DECISIONS");
      expect(decisions).not.toContain(gateRowText("second-row"));
      // The keybar tells the truth on both tabs: it names the tab Tab draws.
      // Standing on Decisions, the destination is Watch — so the hint names it
      // and cannot still be advertising the tab already drawn.
      expect(decisions).toContain("Tab Watch");
      expect(decisions).not.toContain("Tab Decisions");

      // The decisions tab carries a selection of its own, in its own rail.
      delivery.key({ input: "", key: { downArrow: true } });
      const onFleet = await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} Fleet`),
        "the decisions tab's own rail selection",
      );
      expect(onFleet).toContain("SECTIONS");

      // Back to watch: the row it was left on is still the selected row.
      delivery.key({ input: "", key: { tab: true } });
      const returned = await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the watch tab again",
      );
      expect(selectedLine(returned, "second-row")).toBeDefined();
      expect(returned).not.toContain("SECTIONS");
      expect(returned).toContain("Tab Decisions");

      // And back to decisions: its rail is still where the operator left it.
      delivery.key({ input: "", key: { tab: true } });
      const decisionsAgain = await waitForLastFrame(
        io,
        (frame) => frame.includes("SECTIONS"),
        "the decisions tab a second time",
      );
      expect(decisionsAgain).toContain(`${GLYPHS.pointer} Fleet`);
      expect(decisionsAgain).toContain("FLEET is read-only on this surface");
      expect(decisionsAgain).toContain("Tab Watch");

      // Tab belongs to the surface even while a view is narrowing itself: with
      // the filter prompt open and holding a query, Tab still draws the other
      // tab, and tabbing back returns to the prompt exactly as it was left.
      delivery.key({ input: "", key: { tab: true } });
      await waitForLastFrame(
        io,
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the watch tab before the prompt",
      );
      delivery.key({ input: "/", key: {} });
      delivery.key({ input: "s", key: {} });
      const prompted = await waitForLastFrame(
        io,
        (frame) => frame.includes("text Edit") && frame.includes("GATES /s"),
        "the open filter prompt",
      );
      expect(prompted).not.toContain("SECTIONS");

      delivery.key({ input: "", key: { tab: true } });
      const switchedWhilePrompted = await waitForLastFrame(
        io,
        (frame) => frame.includes("SECTIONS"),
        "the decisions tab reached from an open prompt",
      );
      expect(switchedWhilePrompted).not.toContain("text Edit");
      expect(switchedWhilePrompted).toContain("FLEET is read-only on this surface");

      delivery.key({ input: "", key: { tab: true } });
      const promptAgain = await waitForLastFrame(
        io,
        (frame) => frame.includes("text Edit"),
        "the prompt the operator left open",
      );
      expect(promptAgain).toContain("GATES /s");
      expect(promptAgain).not.toContain("SECTIONS");
      // The prompt is dismissed the way it opened — through the same registry.
      delivery.key({ input: "", key: { escape: true } });
      await waitForLastFrame(
        io,
        (frame) => !frame.includes("text Edit"),
        "the dismissed prompt",
      );
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });

  test("test: a refresh that changes the data visibly changes the drawn frame", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-150006";
    const start = ev("run-start", { branch: "spec/live-visible-refresh", pid: process.pid }, "2026-07-27T15:00:00.000Z");
    seedJournal(repo, runId, rawOf([start]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });

    try {
      const delivery = await seam.ready;
      const before = await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      seedJournal(repo, runId, rawOf([
        start,
        ev("visible-refresh-event", {}, "2026-07-27T15:00:01.000Z"),
      ]));
      delivery.refresh();
      const after = await waitForLastFrame(
        io,
        (frame) => frame.includes("neutral · visible-refresh-event"),
        "the refreshed data",
      );
      expect(after).not.toBe(before);
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: sending the quit key through the live surface draws its report in the emitted bytes and ends the session, asserted by observing the exit rather than by rendering a constructed state", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-150007";
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-observed-quit", pid: process.pid }, "2026-07-27T15:00:00.000Z"),
    ]));
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    await seam.ready;
    await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");

    io.input.write("q");

    await expect(done).resolves.toBeUndefined();
    expect(stripAnsi(io.writes.join(""))).toContain("Quit requested");
    expect(io.raw()).toBe(false);
  });

  test("following a live overview redraws the newest journal event after the refresh interval", async () => {
    const repo = mkRepo();
    const runId = "run-20260726-171659";
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-follow", pid: process.pid }, new Date().toISOString()),
    ]));
    const io = makeInkStreams();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 10,
    });

    try {
      await waitForDraw(io, runId);
      io.input.write("f");
      await waitForDraw(io, "Follow");
      appendFileSync(
        join(repo, ".tickmarkr", "runs", runId, "journal.jsonl"),
        rawOf([ev("live-tail-arrived", {}, new Date().toISOString())]),
      );
      await waitForDraw(io, "neutral · live-tail-arrived");
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: a refresh that arrives with no key pressed leaves no selection or detail pointing at a row that is not there", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-120001";
    const start = ev(
      "run-start",
      { branch: "spec/live-row-repair", pid: process.pid },
      "2026-07-27T12:00:00.000Z",
    );
    const stable = ev("gate-result", { gate: "stable-event" }, "2026-07-27T12:00:01.000Z", "T1");
    const target = ev("gate-result", { gate: "target-event" }, "2026-07-27T12:00:02.000Z", "T1");
    seedJournal(repo, runId, rawOf([start, stable, target]));
    const io = makeInkStreams(140, 24);
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 10,
      debug: true,
    });

    try {
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      io.input.write("3");
      await waitForLastFrame(
        io,
        (frame) => frame.includes("GATES") && frame.includes(gateRowText("target-event")),
        "the production Gates rows",
      );
      io.input.write("\u001b[B");
      await waitForLastFrame(
        io,
        (frame) => frame.split("\n").some((line) =>
          line.includes("❯") && line.includes(gateRowText("target-event"))
        ),
        "the selected target row",
      );
      io.input.write("\r");
      await waitForLastFrame(io, (frame) => frame.includes("GATE DETAIL"), "the opened target row");

      // No key is sent during either refresh. Removing the source record must
      // clear both identities in the live owner, otherwise re-adding that same
      // source record would resurrect the old detail and selection.
      seedJournal(repo, runId, rawOf([start, stable]));
      await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("stable-event")) && !frame.includes("GATE DETAIL"),
        "the repaired Gates view after target removal",
      );
      seedJournal(repo, runId, rawOf([start, stable, target]));
      const returned = await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("target-event")),
        "the target source record after it returns",
      );
      expect(returned).not.toContain("GATE DETAIL");
      expect(returned.split("\n").find((line) => line.includes(gateRowText("target-event"))))
        .not.toContain("❯");
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("filter prompt edits reconcile the live selection against rows derived from the updated query", async () => {
    const repo = mkRepo();
    const runId = "run-20260727-120002";
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-filter-repair", pid: process.pid }, "2026-07-27T12:00:00.000Z"),
      ev("gate-result", { gate: "stable-event" }, "2026-07-27T12:00:01.000Z", "T1"),
      ev("gate-result", { gate: "target-event" }, "2026-07-27T12:00:02.000Z", "T1"),
    ]));
    const io = makeInkStreams(140, 24);
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 1_000,
      debug: true,
    });

    try {
      await waitForLastFrame(io, (frame) => frame.includes(runId), "the initial run");
      io.input.write("3");
      await waitForLastFrame(io, (frame) => frame.includes(gateRowText("target-event")), "Gates rows");
      io.input.write("\u001b[B");
      await waitForLastFrame(
        io,
        (frame) => frame.split("\n").some((line) =>
          line.includes("❯") && line.includes(gateRowText("target-event"))
        ),
        "the selected target",
      );
      io.input.write("/");
      await waitForLastFrame(io, (frame) => frame.includes("text Edit"), "the filter prompt");
      io.input.write("z");
      await waitForLastFrame(io, (frame) => frame.includes("No gates in this engagement"), "a rowless filtered view");
      io.input.write("\r");
      await waitForLastFrame(
        io,
        (frame) => !frame.includes("text Edit") && frame.includes("No gates in this engagement"),
        "the applied rowless filter",
      );
      io.input.write("/");
      const restored = await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("target-event")) && frame.includes("text Edit"),
        "the rows after resetting the query",
      );
      expect(restored.split("\n").find((line) => line.includes(gateRowText("target-event"))))
        .not.toContain("❯");
      io.input.write("\r");
      await waitForLastFrame(io, (frame) => !frame.includes("text Edit"), "the applied empty query");
      io.input.write("\r");
      await wait(50);
      expect(lastLiveFrame(io)).not.toContain("GATE DETAIL");
    } finally {
      io.input.write("\u0003");
      await done;
    }
  });

  test("test: the command renders the cockpit surface and no longer reaches the retired studio module", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20260726-171700", rawOf([
      ev("run-start", { branch: "spec/ui-live", pid: process.pid }, new Date().toISOString()),
      ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, new Date().toISOString(), "T1"),
    ]));

    const io = makeInkStreams();
    const done = ui([], { input: io.input, output: io.output }, repo);
    const frame = await commandFrame(io);

    expect(frame).toContain("1 Home  4 Run  5 Evidence");
    expect(frame).toContain("HOME");
    // The KEYS rail was retired with the contract's frame; keys are advertised in the keybar band alone.
    expect(frame).not.toContain("KEYS");
    expect(frame).toContain("run-20260726-171700");
    // the retired studio's vocabulary, not the cockpit's
    expect(frame).not.toContain("Fleet view");
    expect(frame).not.toContain("Routing");
    expect(frame).not.toContain("Preview");

    io.input.write("q");
    await expect(done).resolves.toBe("ui: closed");
    expect(io.raw()).toBe(false);
  });

  test("test: the surface is derived from the journal bytes of a real engagement rather than from any committed capture", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20990102-030405", rawOf([
      ev("run-start", { branch: "spec/branch-no-capture-owns", pid: process.pid }, new Date().toISOString()),
      ev("task-dispatch", { assignment: { adapter: "noprovider", model: "model-zero" } }, new Date().toISOString(), "T9"),
    ]));

    const io = makeInkStreams();
    const done = ui([], { input: io.input, output: io.output }, repo);
    const frame = await commandFrame(io);

    expect(frame).toContain("run-20990102-030405");
    expect(frame).toContain("noprovider:model-zero");
    expect(frame).not.toContain(COMMITTED_CAPTURE_ID);

    io.input.write("q");
    await done;
  });

  test("implicit no-run UI opens useful Home without arming an observer", async () => {
    const repo = mkRepo();
    const io = makeInkStreams();
    const done = ui([], { input: io.input, output: io.output }, repo);
    try {
      const frame = await commandFrame(io);
      expect(frame).toContain("HOME");
      expect(frame).toContain("No run recorded yet.");
      expect(frame).toContain("fleet");
    } finally { io.input.write("q"); await done; }
  });

  test("test: when the journal bytes are unreadable the command refuses rather than rendering a plausible surface derived from nothing", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20260726-171700", "not json at all\n{broken\n");
    const io = makeInkStreams();

    const result = await ui([], { input: io.input, output: io.output }, repo);

    expect(result).toMatchObject({ code: 1 });
    expect((result as { out: string }).out).toContain("run-20260726-171700");
    expect(io.writes.join("")).toBe("");
  });

  test("test: the bare command opens the most recently started engagement, decided in exactly one place, and an explicit engagement reference given on the command line overrides it", async () => {
    const repo = mkRepo();
    seedJournal(repo, "run-20260726-100000", rawOf([
      ev("run-start", { branch: "spec/older", pid: process.pid }, new Date().toISOString()),
    ]));
    seedJournal(repo, "run-20260726-110000", rawOf([
      ev("run-start", { branch: "spec/newer", pid: process.pid }, new Date().toISOString()),
    ]));

    const bare = makeInkStreams();
    const bareDone = ui([], { input: bare.input, output: bare.output }, repo);
    const bareFrame = await commandFrame(bare);
    expect(bareFrame).toContain("run-20260726-110000");
    expect(bareFrame).not.toContain("run-20260726-100000");
    bare.input.write("q");
    await bareDone;

    const explicit = makeInkStreams();
    const explicitDone = ui(["run-20260726-100000"], {
      input: explicit.input,
      output: explicit.output,
    }, repo);
    const explicitFrame = await commandFrame(explicit);
    expect(explicitFrame).toContain("run-20260726-100000");
    expect(explicitFrame).not.toContain("run-20260726-110000");
    explicit.input.write("q");
    await explicitDone;
  });
});

/** A compiled graph on disk, in the shape `tickmarkr compile` writes. */
function seedGraph(repo: string, taskIds: readonly string[]): void {
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(
    join(repo, ".tickmarkr", "graph.json"),
    JSON.stringify({
      version: 1,
      spec: { source: "native", paths: ["specs/live.spec.md"], hash: "deadbeef" },
      tasks: taskIds.map((id) => ({
        id,
        title: `title of ${id}`,
        goal: `goal of ${id}`,
        shape: "implement",
        complexity: 1,
        deps: [],
        files: [],
        context: [],
        acceptance: [`test: ${id} holds`],
        status: "pending",
      })),
    }),
  );
}

/** A compiled graph on disk that exists and cannot be read as one. */
function corruptGraph(repo: string): void {
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "graph.json"), "{\"version\": 1, tasks:");
}

describe("live cockpit row identity", () => {
  test("test: selection follows the row's source identity across a refresh, and a refresh that removes the selected identity clears the selection honestly rather than selecting the row that inherited its index", async () => {
    const repo = mkRepo();
    const runId = "run-20260728-090001";
    const journalPath = join(repo, ".tickmarkr", "runs", runId, "journal.jsonl");
    seedJournal(repo, runId, rawOf([
      ev("run-start", { branch: "spec/live-identity", pid: process.pid }, "2026-07-28T09:00:00.000Z"),
      ev("gate-result", { gate: "older-row" }, "2026-07-28T09:00:01.000Z", "T1"),
      ev("gate-result", { gate: "selected-row" }, "2026-07-28T09:00:02.000Z", "T1"),
    ]));
    seedGraph(repo, ["T1", "T2", "T3"]);
    const io = makeInkStreams(140, 24);
    const seam = deliveryPromise();
    const done = runLiveCockpit({
      input: io.input,
      output: io.output,
      cwd: repo,
      runId,
      binaryVersion: "9.8.7",
      refreshMs: 60_000,
      debug: true,
      onDelivery: seam.accept,
    });
    const delivery = await seam.ready;
    const identities = (view: "journal" | "gates" | "tasks"): readonly string[] =>
      runViewRowIdentities(delivery.snapshot().data, view);
    try {
      // ── The painted proof, on a view whose rows a key may stand on ─────────
      // The journal is a tail and owns no selection, so the proof runs on the
      // gates view, whose rows the frame lists and whose pointer it paints:
      // select a row, then let a refresh move it.
      await openGatesWithSelectedNewest(io, delivery, "selected-row");
      const selectedId = delivery.snapshot().interaction.selection;
      expect(selectedId).not.toBeNull();
      expect(identities("gates").indexOf(selectedId!)).toBe(0);

      // A live journal grows: the appended event lands above the selected row,
      // so the row the operator chose now sits at a different index.
      appendFileSync(
        journalPath,
        rawOf([ev("gate-result", { gate: "prepended-row" }, "2026-07-28T09:00:03.000Z", "T1")]),
      );
      expect(delivery.refresh()).toBe(true);
      expect(delivery.snapshot().interaction.selection).toBe(selectedId);
      expect(identities("gates").indexOf(selectedId!)).toBe(1);

      // The pointer the surface actually painted sits immediately before that
      // exact row's own text — the navigation rail's pointer, which shares the
      // line, cannot stand in for it — and no other row carries one.
      const shifted = await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("prepended-row")),
        "the gates view after the refresh",
      );
      const pointedRows = (frame: string): readonly string[] =>
        frame
          .split("\n")
          .flatMap((line) => line.split(`${GLYPHS.pointer} T1 · `).slice(1))
          .map((tail) => tail.trim().split(" ")[0]!);
      expect(pointedRows(shifted)).toEqual(["selected-row"]);

      // ── The removal half, painted, on the same view ────────────────────────
      // A live journal read mid-append has a torn trailing line. The surface
      // draws it in the tail as a source defect rather than pretending it
      // parsed — and no key may stand on it, because the tail is not a list.
      appendFileSync(
        journalPath,
        "{\"ts\":\"2026-07-28T09:00:04.000Z\",\"event\":\"complet",
      );
      expect(delivery.refresh()).toBe(true);
      expect(identities("journal")[0]).toBe("defect:5");
      expect(delivery.snapshot().interaction.selection).toBe(selectedId);

      // The append lands, and it carries a gate result of its own. The row the
      // operator selected is gone from the engagement, and the row that took
      // its place must not inherit the pointer.
      writeFileSync(
        journalPath,
        rawOf([
          ev("run-start", { branch: "spec/live-identity", pid: process.pid }, "2026-07-28T09:00:00.000Z"),
          ev("gate-result", { gate: "older-row" }, "2026-07-28T09:00:01.000Z", "T1"),
          ev("withdrawn-row", {}, "2026-07-28T09:00:02.000Z", "T1"),
          ev("gate-result", { gate: "prepended-row" }, "2026-07-28T09:00:03.000Z", "T1"),
          ev("gate-result", { gate: "completed-row" }, "2026-07-28T09:00:04.000Z", "T1"),
          ev("task-dispatch", { assignment: { adapter: "fake", model: "two" }, attempt: 0 }, "2026-07-28T09:00:05.000Z", "T2"),
          ev("task-done", {}, "2026-07-28T09:00:06.000Z", "T2"),
          ev("task-dispatch", { assignment: { adapter: "fake", model: "three" }, attempt: 0 }, "2026-07-28T09:00:07.000Z", "T3"),
          ev("task-done", {}, "2026-07-28T09:00:08.000Z", "T3"),
        ]),
      );
      expect(delivery.refresh()).toBe(true);
      expect(identities("journal")).not.toContain("defect:5");
      expect(identities("gates")[0]).toBe("gate:5");
      expect(delivery.snapshot().interaction.selection).toBeNull();

      // And the frame the surface applied paints no pointer on any row: not on
      // the identity that left, and not on the row that inherited its place at
      // the top of the view.
      const completed = await waitForLastFrame(
        io,
        (frame) => frame.includes(gateRowText("completed-row")),
        "the gates view after the torn line completed",
      );
      expect(selectedLine(completed, "completed-row")).toBeUndefined();
      expect(selectedLine(completed, "older-row")).toBeUndefined();
      expect(pointedRows(completed)).toEqual([]);

      // ── The same reconciliation over the Tasks view's recorded rows ─────────
      // Selecting the middle row — index 1, identity task:T2.
      delivery.key({ input: "2", key: {} });
      delivery.key({ input: "", key: { downArrow: true } });
      delivery.key({ input: "", key: { downArrow: true } });
      expect(delivery.snapshot().interaction.activeView).toBe("tasks");
      expect(delivery.snapshot().interaction.selection).toBe("task:T2");

      // A recompile prepends a graph-only task. The fold still carries that placeholder, but the
      // surface neither renders nor selects it, so the recorded identity remains standing.
      seedGraph(repo, ["T0", "T1", "T2", "T3"]);
      expect(delivery.refresh()).toBe(true);
      const prepended = delivery.snapshot();
      expect(prepended.data.taskRows.map((row) => row.id)).toEqual([
        "task:T0",
        "task:T1",
        "task:T2",
        "task:T3",
      ]);
      expect(liveRunViewRowIds({
        ...prepended.interaction,
        activeView: "tasks",
      }, prepended.data).indexOf("task:T2")).toBe(1);
      expect(prepended.interaction.selection).toBe("task:T2");

      // A graph caught mid-recompile is a fault, not an engagement that dropped
      // its tasks: the refresh keeps the last good rows and the selection
      // standing on one of them rather than demoting the surface to the tasks
      // the journal alone happens to mention — here, none at all.
      corruptGraph(repo);
      expect(delivery.refresh()).toBe(false);
      const faulted = delivery.snapshot();
      expect(faulted.data.taskRows.map((row) => row.id)).toEqual([
        "task:T0",
        "task:T1",
        "task:T2",
        "task:T3",
      ]);
      expect(faulted.interaction.selection).toBe("task:T2");

      // A recompile that drops the selected task leaves another row holding its
      // old index. The selection is cleared rather than slid onto that row.
      seedGraph(repo, ["T0", "T1", "T3"]);
      expect(delivery.refresh()).toBe(true);
      const dropped = delivery.snapshot();
      expect(dropped.data.taskRows.map((row) => row.id)).not.toContain("task:T2");
      expect(dropped.data.taskRows[2]?.id).toBe("task:T3");
      expect(dropped.interaction.selection).toBeNull();
      expect(dropped.interaction.selection).not.toBe("task:T3");
      // No frame assertion rides here. Listing the tasks view's rows is S4's
      // (this task owns the row model and the identities selection is repaired
      // against), so the tasks panel paints no rows yet and a "no pointer sits
      // on T2 or T3" check would pass over an empty panel — a claim proved by
      // the absence of the thing it inspects. The painted proof of the same
      // rule lives above, on the journal, whose rows the shipped frame does
      // draw: a selected identity that leaves takes the pointer with it.
    } finally {
      delivery.key({ input: "q", key: {} });
      await done;
    }
  });
});

// FINAL integration: unlike legacy frame tests these exercise the production C2/C3/C4/C5 mount.
import chalk from "chalk";
import { C1_CRITERIA } from "../fixtures/cockpit/final/criteria.js";
import { FINAL_VERDICT_LINE, LONG_TASK_ID, shellFixture } from "../fixtures/cockpit/final/capture-fixture.js";
import { mountShell } from "../fixtures/cockpit/final/mount.js";
import { planShell } from "../../src/tui/cockpit/layout.js";
import { captureShellOutput, FINAL_SHELL_RETIREMENT } from "../../src/tui/cockpit/capture.js";
import { SHELL_TERMINAL_ENTER, SHELL_TERMINAL_RESTORE, runConsolidatedCockpit, type ShellDelivery } from "../../src/tui/cockpit/live-runtime.js";
import { SHELL_BINDINGS, shellBindings } from "../../src/tui/cockpit/keys.js";
import { SHELL_PALETTE, resolveShellColourMode, resolveTileColour } from "../../src/tui/cockpit/theme.js";
import { CAPTURE_ARTIFACT_MANIFEST } from "../../src/gates/artifact-manifest.js";

/**
 * OBS-960: the mounted sweep paints every planned size through ink for three views. The default path
 * selects sizes through the same selector the frame-contract sweep uses (stride 15x4: 130 sizes, every
 * corner and both extremes of each axis); the exhaustive 6,697-size form runs under
 * TICKMARKR_EXHAUSTIVE_SWEEP=1 with TICKMARKR_SWEEP_TIMEOUT_MS. The planShell oracle in C1_CRITERIA[0]
 * stays exhaustive — every integer size is validated by the plan; the mounted paint is validated at the
 * sampled sizes. On a single-fork CI runner the exhaustive mounted sweep exceeded 600 s (2.5.0 CI run
 * 34193886440, both jobs) where it takes 116 s on an 18-core host.
 */
async function mountedViewSweep(sweep: Awaited<ReturnType<typeof mountShell>>, sizes: FrameContractSize[]): Promise<void> {
  for (const [key, view] of [["1", "HOME"], ["4", "RUN"], ["5", "EVIDENCE"]]) {
    await sweep.send(key!);
    for (const { columns, rows } of sizes) {
      await sweep.resizeAndPaint(columns, rows);
      const frame = stripAnsi(sweep.frame());
      const lines = frame.split("\n");
      expect(lines.length, `${view} ${columns}x${rows}`).toBe(rows);
      expect(lines.every(line => cellWidth(line) <= columns), `${view} ${columns}x${rows} cells`).toBe(true);
      expect(lines[0]).toContain(`| ${view} |`);
      expect(lines[1]).toMatch(/\d+–\d+\/\d+.*\d+ hidden/);
      expect(lines[rows - 3]).toContain("PENDING");
      expect(lines[rows - 2]).toContain("q Quit");
      expect(lines.slice(3, rows - 4).join("\n")).toContain(view === "HOME" ? "MERGED" : view === "RUN" ? "RUN /" : "JOURNAL");
    }
  }
}

test(C1_CRITERIA[0], async () => {
  let sizes = 0;
  for (let columns = 40; columns <= 220; columns++) for (let rows = 14; rows <= 50; rows++) {
    const p = planShell(columns, rows);
    expect(p.refused).toBe(false);
    expect(p.bodyRows + 7).toBe(rows);
    expect(2 + p.rail + (p.rail ? 1 : 0) + p.bodyColumns + (p.shortcuts ? 1 : 0) + p.shortcuts).toBe(columns);
    sizes++;
  }
  expect(sizes).toBe(6697);
  expect(planShell(120, 40)).toMatchObject({ rail: 15, bodyColumns: 79, shortcuts: 22, bodyRows: 33 });
  expect(planShell(80, 24)).toMatchObject({ rail: 0, bodyColumns: 78, shortcuts: 0, bodyRows: 17 });
  const f = shellFixture();
  try {
    for (const [columns, rows] of [[120, 40], [80, 24]]) for (const view of ["home", "run", "evidence"] as const) {
      const frame = await captureShellOutput({ ...f, columns, rows, view });
      expect(frame).toContain(view.toUpperCase());
      expect(frame).toContain("q Quit");
      expect(frame.split("\n").length).toBe(rows);
      expect(frame.split("\n").every(line => cellWidth(line) <= columns)).toBe(true);
      if (view === "home") {
        expect(frame).toContain("MERGED"); expect(frame).toContain("CURRENT TIP: PENDING");
        const labels = ["MERGED", "GATES RAN", "GATE PASS RATE", "ACTIVE SEATS", "NEEDS YOU", "SPEND"];
        const positions = labels.map(label => {
          const row = frame.split("\n").findIndex(line => line.includes(label));
          return { row, column: cellWidth(frame.split("\n")[row]!.split(label)[0]!) };
        });
        const tileColumns = columns === 80 ? 2 : 3;
        expect(new Set(positions.map(position => position.row)).size).toBe(6 / tileColumns);
        for (let i = 0; i < positions.length; i++) {
          expect(positions[i]!.column).toBe(positions[i % tileColumns]!.column);
          if (i % tileColumns) expect(positions[i]!.row).toBe(positions[i - 1]!.row);
          if (i >= tileColumns) expect(positions[i]!.row).toBeGreaterThan(positions[i - tileColumns]!.row);
        }
      }
      if (view === "run") {
        // BD-1: the board's rows are taller than the letter matrix was; the fourth task's row sits
        // below a 17-row body, so the long identity is asserted where the body can hold it.
        if (rows === 40) { expect(frame).toContain(LONG_TASK_ID.slice(0, 38)); expect(frame).toContain("─ not declared"); }
        expect(frame).toContain("❯ T1   ");
      }
      if (view === "evidence") {
        expect(frame).toContain("terminal failure");
        expect(frame).toContain("- disabled");
      }
    }
    const sweep = await mountShell(f.cwd, f.runId, 120, 40, { NO_COLOR: "1" });
    try { await mountedViewSweep(sweep, frameContractSweepSizes("sampled")); } finally { await sweep.close(); }
    for (const [w, h] of [[39, 14], [40, 13]]) {
      const m = await mountShell(f.cwd, f.runId, w, h);
      try { expect(m.frame()).toContain("q Quit"); await m.send("q"); expect(await m.result).toBeUndefined(); } finally { await m.close(); }
    }
  } finally { f.close(); }
}, 600000);

test.skipIf(process.env.TICKMARKR_EXHAUSTIVE_SWEEP !== "1")(
  "test: the mounted Home, Run and Evidence views hold the frame contract at every integer size 40–220 by 14–50 (exhaustive opt-in; the default path samples through the same selector)",
  async () => {
    const f = shellFixture();
    try {
      const sweep = await mountShell(f.cwd, f.runId, 120, 40, { NO_COLOR: "1" });
      try { await mountedViewSweep(sweep, frameContractSweepSizes("exhaustive")); } finally { await sweep.close(); }
    } finally { f.close(); }
  },
  Number(process.env.TICKMARKR_SWEEP_TIMEOUT_MS ?? 600_000),
);

test(C1_CRITERIA[1], async () => {
  const f = shellFixture(); const m = await mountShell(f.cwd, f.runId);
  try {
    for (const [key, view] of [["1", "home"], ["4", "run"], ["5", "evidence"]]) {
      await m.send(key); expect(m.delivery.snapshot().state.view).toBe(view); expect(m.frame()).toContain(view.toUpperCase());
    }
    await m.send("1");
    m.delivery.key({ input: "", key: { return: true } });
    await m.send("");
    expect(m.delivery.snapshot().state.view).toBe("run");
    expect(stripAnsi(m.frame())).toContain("❯ T3");
    expect(stripAnsi(m.frame())).toContain("blocked");
    await m.send("5");
    m.delivery.key({ input: "", key: { return: true } });
    const evidenceOpen = m.delivery.snapshot().state.overlay?.join("\n") ?? "";
    expect(evidenceOpen).toMatch(/task-dispatch|"event": "task-dispatch"|T2/);
    expect(evidenceOpen).toContain("\"attempt\": 0");
    await m.send("\x1b");
    await m.resize(120, 40);
    await m.send("1");
    const openGeometry = planShell(120, 40);
    m.delivery.pointer({
      action: "press",
      column: openGeometry.bodyColumn + openGeometry.bodyColumns + 2,
      row: openGeometry.bodyRow + SHELL_BINDINGS.findIndex(binding => binding.action === "open"),
    });
    await m.send("");
    expect(m.delivery.snapshot().state.view).toBe("run");
    expect(stripAnsi(m.frame())).toContain("❯ T3");
    await m.send("5");
    m.delivery.pointer({
      action: "press",
      column: openGeometry.bodyColumn + openGeometry.bodyColumns + 2,
      row: openGeometry.bodyRow + SHELL_BINDINGS.findIndex(binding => binding.action === "open"),
    });
    expect(m.delivery.snapshot().state.overlay?.join("\n")).toMatch(/task-dispatch|"event": "task-dispatch"|T2/);
    await m.send("\x1b");
    // Move off both defaults: Home's Activity history and Evidence's selected
    // row must be the same targets for terminal Enter and pointer Open.
    await m.send("1");
    await m.send("\x1b[C");
    await m.send("\x1b[5~");
    const homeTarget = m.delivery.snapshot().store.journal.history.at(-4)!;
    await m.send("\r");
    expect(m.delivery.snapshot().state.view).toBe("evidence");
    expect(m.delivery.snapshot().state.overlay).toBeUndefined();
    expect(stripAnsi(m.frame())).toContain("Follow off");
    m.delivery.key({ input: "", key: { return: true } });
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(homeTarget.id);
    await m.send("\x1b");
    await m.send("1");
    await m.send("\x1b[C");
    await m.send("\x1b[5~");
    m.delivery.pointer({
      action: "press",
      column: openGeometry.bodyColumn + openGeometry.bodyColumns + 2,
      row: openGeometry.bodyRow + SHELL_BINDINGS.findIndex(binding => binding.action === "open"),
    });
    await m.send("");
    expect(m.delivery.snapshot().state.view).toBe("evidence");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(homeTarget.id);
    await m.send("\x1b");
    // A local arrow delivered by the production boundary uses the same leaf
    // controller as stdin; Open may not silently fall back to the tail.
    m.delivery.key({ input: "", key: { upArrow: true } });
    await m.send("");
    const evidenceTarget = m.delivery.snapshot().store.journal.history.find(row => row.line === homeTarget.line - 1)!;
    m.delivery.pointer({
      action: "press",
      column: openGeometry.bodyColumn + openGeometry.bodyColumns + 2,
      row: openGeometry.bodyRow + SHELL_BINDINGS.findIndex(binding => binding.action === "open"),
    });
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(evidenceTarget.id);
    expect(m.delivery.snapshot().state.overlay?.join("\n")).toContain(evidenceTarget.event!.event);
    await m.send("\x1b");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(evidenceTarget.id);
    await m.send("\x1b");
    await m.send("\x1b[C");
    expect(stripAnsi(m.frame())).toContain("[REPORT]");
    expect(stripAnsi(m.frame())).not.toContain("Enter Open");
    m.delivery.pointer({
      action: "press",
      column: openGeometry.bodyColumn + openGeometry.bodyColumns + 2,
      row: openGeometry.bodyRow + shellBindings(m.delivery.snapshot().state).findIndex(binding => binding.action === "actions"),
    });
    expect(m.delivery.snapshot().state.overlay).toContain("Existing CLI actions");
    await m.send("\x1b");
    expect(stripAnsi(m.frame())).toContain("[REPORT]");
    expect(stripAnsi(m.frame())).not.toContain("Enter Open");
    await m.send("\x1b[D");
    expect(stripAnsi(m.frame())).toContain("Enter Open");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(evidenceTarget.id);
    await m.send("\x1b");
    await m.send("/"); await m.send("q1?");
    expect(m.delivery.snapshot().state).toMatchObject({ view: "evidence", editor: "q1?", quit: false });
    await m.send("\r"); expect(m.delivery.snapshot().state.query).toBe("q1?");
    await m.send("?"); expect(m.delivery.snapshot().state.help).toBe(true);
    await m.send("\x1b"); expect(m.delivery.snapshot().state.help).toBe(false);
    expect(m.delivery.snapshot().state.quit).toBe(false);
    const focusSequences = [
      { width: 80, forward: ["content", "content"], reverse: "content" },
      { width: 90, forward: ["rail", "content"], reverse: "rail" },
      { width: 120, forward: ["shortcuts", "rail"], reverse: "shortcuts" },
    ] as const;
    for (const sample of focusSequences) {
      await m.resize(sample.width, 24);
      const p = planShell(sample.width, 24);
      m.delivery.pointer({ action: "press", column: p.bodyColumn, row: p.bodyRow });
      expect(m.delivery.snapshot().state.focus).toBe("content");
      for (const expected of sample.forward) {
        await m.send("\t");
        expect(m.delivery.snapshot().state.focus).toBe(expected);
      }
      await m.send("\x1b[Z");
      expect(m.delivery.snapshot().state.focus).toBe(sample.reverse);
    }
    await m.send("4");
    for (let task = 0; task < 4; task++) await m.send("\x1b[A");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.join(" ")).toContain("T1");
    await m.send("\x1b");
    for (let task = 0; task < 3; task++) await m.send("\x1b[B");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.join(" ")).toContain(LONG_TASK_ID);
    expect(m.delivery.snapshot().state.overlay?.join(" ")).toContain("组合文字 cafe\u0301");
    await m.send("\x1b");
    for (let task = 0; task < 3; task++) await m.send("\x1b[A");
    await m.send("a");
    expect(m.delivery.snapshot().state.overlay).toBeDefined();
    await m.send("\x1b");
    for (let page = 0; page < 20; page++) await m.send("\x1b[6~");
    expect(m.frame()).toContain(FINAL_VERDICT_LINE);
    m.delivery.stage(["config.yaml: staged preference (not written)"]);
    await m.send("q"); expect(m.delivery.snapshot().state.reviewing).toBe(true);
    await m.send("\r"); expect(m.delivery.snapshot().state.quit).toBe(false);
    await m.send("n"); expect(m.delivery.snapshot().state.reviewing).toBe(false);
    expect(m.delivery.snapshot().state.staged).toHaveLength(1);
    await m.resize(120, 40);
    m.delivery.pointer({ action: "press", column: 2, row: 3 });
    expect(m.delivery.snapshot().state.view).toBe("home");
    await m.send("q");
    await m.send("y");
    expect(await m.result).toBeUndefined();
  } finally { await m.close(); f.close(); }
}, 15000);

test(C1_CRITERIA[2], async () => {
  const f = shellFixture();
  try {
    for (const exit of ["q", "ctrl-c", "signal", "read failure", "render failure"]) {
      const m = await mountShell(f.cwd, f.runId);
      expect(m.controls()).toContain(SHELL_TERMINAL_ENTER);
      if (exit === "q") await m.send("q");
      if (exit === "ctrl-c") await m.send("\x03");
      if (exit === "signal") process.emit("SIGTERM");
      if (exit === "read failure") m.input.emit("error", new Error("induced read failure"));
      if (exit === "render failure") m.output.emit("error", new Error("induced render failure"));
      const result = await m.result;
      expect(result instanceof Error).toBe(exit.includes("failure"));
      expect(m.controls()).toContain(SHELL_TERMINAL_RESTORE);
      expect(m.raw.at(-1)).toBe(false);
      expect(m.input.listenerCount("readable")).toBe(0);
      expect(m.output.listenerCount("resize")).toBe(0);
      expect(m.delivery.diagnostics().subscriptions).toBe(0);
      expect(m.delivery.refresh()).toBe(false);
      let usable = ""; m.input.on("data", chunk => { usable += String(chunk); }); m.input.resume();
      await m.send("usable"); expect(usable).toBe("usable");
      await m.close();
    }
    const a = await mountShell(f.cwd, f.runId); const b = await mountShell(f.cwd, f.runId);
    try { await a.close(); await b.send("5"); expect(b.frame()).toContain("EVIDENCE"); expect(b.delivery.refresh()).toBe(true); } finally { await b.close(); }
  } finally { f.close(); }
}, 15000);

test(C1_CRITERIA[3], async () => {
  expect(SHELL_PALETTE).toMatchObject({ passed: "#90C4A4", running: "#5A76AE", human: "#ffaf00", failure: "#B07BAC" });
  expect(resolveShellColourMode({ NO_COLOR: "" })).toBe("none");
  expect(resolveShellColourMode({ TERM: "xterm-256color" })).toBe("reduced");
  expect(resolveShellColourMode({ COLORTERM: "truecolor" })).toBe("truecolor");
  expect(resolveTileColour({ magnitude: 0 })).not.toEqual(resolveTileColour({ magnitude: 3 }));
  expect(FINAL_SHELL_RETIREMENT.refreeze).toContain("pending accepted UAT");
  for (const view of ["home", "run", "evidence"]) for (const size of ["120x40", "80x24"]) {
    const path = `tests/fixtures/cockpit/final/${view}.${size}.txt`;
    expect(CAPTURE_ARTIFACT_MANIFEST.artifacts.some(a => a.path === path)).toBe(true);
    expect(readFileSync(join(import.meta.dirname, "../..", path), "utf8")).toContain("q Quit");
  }
  const f = shellFixture();
  try {
    const frame = await captureShellOutput({ ...f, columns: 80, rows: 24, view: "home" });
    expect(frame).toContain("● running"); expect(frame).toContain("no history"); expect(frame).toContain("not measurable");
    expect(frame).not.toContain("✓ running"); expect(frame).not.toContain("✓ human");
    for (const sample of [
      { mode: "truecolor", environment: { COLORTERM: "truecolor" }, failure: "38;2;176;123;172", disabled: "38;2;217;215;221" },
      { mode: "reduced", environment: { TERM: "xterm-256color" }, failure: "35", disabled: "37" },
      { mode: "none", environment: { NO_COLOR: "1" }, failure: "", disabled: "" },
    ] as const) {
      const mounted = await captureShellOutput({ ...f, columns: 120, rows: 40, view: "evidence", environment: sample.environment, stripAnsi: false });
      expect(mounted).toContain("terminal failure");
      // The disabled word and ink must belong to the actual build gate row,
      // not a footer legend or another unrelated disabled component.
      const gateRow = mounted.split("\n").find(line => stripAnsi(line).includes("- disabled"));
      expect(gateRow).toBeDefined();
      expect(stripAnsi(gateRow!)).toContain("- disabled build — gate-result");
      expect(stripAnsi(gateRow!)).toContain(LONG_TASK_ID.slice(0, 20));
      expect(mounted).not.toContain("uninstalled disabled");
      expect(mounted.split("\n").slice(-4).join("\n")).not.toContain("disabled");
      if (sample.mode === "none") expect(mounted).not.toMatch(/\x1b\[(?:3[0-9]|38;)/u);
      else {
        expect(mounted).toContain(sample.failure);
        expect(gateRow).toMatch(new RegExp(`${sample.disabled}m- disabled`));
      }
    }
    const beforeTrend = await captureShellOutput({ ...f, columns: 120, rows: 40, view: "home", environment: { COLORTERM: "truecolor" }, stripAnsi: false });
    expect(beforeTrend).toContain("no history");
    const journal = join(f.cwd, ".tickmarkr", "runs", f.runId, "journal.jsonl");
    appendFileSync(journal, JSON.stringify({ ts: "2026-09-05T00:01:00.000Z", event: "merge", taskId: "T2", data: {} }) + "\n");
    const measuredTrend = await captureShellOutput({ ...f, columns: 120, rows: 40, view: "home", environment: { COLORTERM: "truecolor" }, stripAnsi: false });
    const trendRow = measuredTrend.split("\n").find(line => stripAnsi(line).includes("▁█"));
    expect(trendRow).toBeDefined();
    // Same MERGED tile: two journal magnitudes, two guarded green steps.
    expect(trendRow).toContain("38;2;67;121;68m");
    expect(trendRow).toContain("38;2;135;215;135m");
    // Keep ANSI enabled in Ink: NO_COLOR must be enforced by the production
    // shell itself, independently of captureShellOutput's chalk-level setup.
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      for (const sample of [
        { environment: { COLORTERM: "truecolor" }, background: "\x1b[48;2;26;26;25m", chrome: "\x1b[38;2;217;215;221m" },
        { environment: { TERM: "xterm-256color" }, background: "\x1b[40m", chrome: "\x1b[37m" },
        { environment: { NO_COLOR: "1" }, background: undefined, chrome: undefined },
      ]) {
        const m = await mountShell(f.cwd, f.runId, 120, 40, sample.environment);
        try {
          for (const bytes of ["1", "4", "5", "?", "\x1b", "/"]) {
            await m.send(bytes);
            const painted = m.frame();
            expect(stripAnsi(painted)).toContain("q Quit");
            if (sample.background) {
              expect(painted).toContain(sample.background);
              expect(painted).toContain(sample.chrome);
              // Fill the empty body as well as text-bearing rows.
              expect(painted.split("\n").filter(line => line.includes(sample.background!))).toHaveLength(40);
            } else {
              expect(painted).not.toMatch(/\x1b\[(?:[349][0-9]|10[0-7])(?:;[0-9]+)*m/u);
            }
          }
          await m.send("\x1b");
        } finally { await m.close(); }
      }
    } finally { chalk.level = previousLevel; }
  } finally { f.close(); }
});

/**
 * OBS-960: one heap child per test (two environments x three shapes) instead of six inside one test —
 * the protocol (1000 warm-up, 10000 measured ticks, 64 MiB / 16 MiB) is unchanged; each child gets its
 * own 600 s budget. On a single-fork CI runner the shared 180 s SIGKILL timer killed a child that runs
 * in 35 s on an 18-core host ("heap child exited null", 2.5.0 CI run 34193886440).
 */
const HEAP_PROTOCOL_CASES = [false, true].flatMap(production => (["static", "growth", "resize"] as const).map(shape => ({ production, shape })));
test.each(HEAP_PROTOCOL_CASES)(`${C1_CRITERIA[4]} [%o]`, async ({ production, shape }) => {
  const { spawn } = await import("node:child_process");
  const { rmSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "final-shell-memory-"));
  try {
    {
      const destination = join(dir, `${shape}-${production}.json`);
      const env = { ...process.env }; delete env.NODE_ENV; delete env.CI; delete env.CONTINUOUS_INTEGRATION;
      if (production) env.NODE_ENV = "production";
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--expose-gc", join(import.meta.dirname, "../fixtures/cockpit/final/heap-runner.mjs"), shape, destination], { env, stdio: ["ignore", "ignore", "pipe"] });
        let errors = "";
        child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
        child.on("error", reject);
        child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(errors || `heap child exited ${code}`)); });
      });
      const result = JSON.parse(readFileSync(destination, "utf8"));
      expect(result.protocol).toBe("C1-production-mount-v1");
      expect(result.environment.NODE_ENV).toBe(production ? "production" : null);
      expect(result.warmupTicks).toBe(1000); expect(result.measuredTicks).toBe(10000);
      expect(result.samples.map((s: { tick: number }) => s.tick)).toEqual(Array.from({ length: 11 }, (_, i) => (i + 1) * 1000));
      for (const sample of result.samples) { expect(sample.heap).toBeLessThanOrEqual(64 * 1048576); expect(sample.performanceMeasures).toBeLessThan(1000); }
      expect(result.lateGrowth).toBeLessThanOrEqual(16 * 1048576);
      expect(result.verdict).toBe("pass"); expect(result.writes).toBeGreaterThan(10000);
      expect(result.bytes).toBeGreaterThan(100000); expect(result.pendingOutputBytes).toBe(0);
      expect(result.lastFrame.length).toBeLessThanOrEqual(20000);
      expect(result.lastFrame).toContain("heap-fixture");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 660_000);

test("mounted shortcuts omit Open without a target and Filter outside Journal; Evidence export reviews the actual destination", async () => {
  const f = shellFixture();
  const journal = join(f.cwd, ".tickmarkr", "runs", f.runId, "journal.jsonl");
  writeFileSync(journal, "");
  const m = await mountShell(f.cwd, f.runId);
  try {
    expect(stripAnsi(m.frame())).toContain("No run recorded yet");
    expect(stripAnsi(m.frame())).not.toContain("Enter Open");
    expect(stripAnsi(m.frame())).not.toContain("/ Filter");
    await m.send("/");
    expect(m.delivery.snapshot().state.editor).toBeUndefined();
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay).toBeUndefined();
    await m.send("4");
    expect(stripAnsi(m.frame())).not.toContain("/ Filter");
    await m.send("5");
    expect(stripAnsi(m.frame())).not.toContain("Enter Open");
    expect(stripAnsi(m.frame())).toContain("e Export");
    const destination = join(f.cwd, "receipt.md");
    writeFileSync(destination, "original receipt");
    await m.send("e");
    expect(m.delivery.snapshot().state.editor).toBe(join(f.cwd, `fixture.${f.runId}.report.md`));
    while (m.delivery.snapshot().state.editor) m.delivery.key({ input: "", key: { backspace: true } });
    await m.send(destination); await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(`Overwrite ${destination}`);
    await m.send("\r");
    expect(readFileSync(destination, "utf8")).toBe("original receipt");
    await m.send("n");
    expect(m.delivery.snapshot().state.overlay).toBeUndefined();
    await m.send("e");
    expect(m.delivery.snapshot().state.editor).toBe(join(f.cwd, `fixture.${f.runId}.report.md`));
    while (m.delivery.snapshot().state.editor) m.delivery.key({ input: "", key: { backspace: true } });
    await m.send(destination); await m.send("\r"); await m.send("y");
    const record = readFileSync(destination, "utf8");
    expect(record).toContain(f.runId);
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(`Exported ${destination} (${Buffer.byteLength(record)} bytes)`);
  } finally { await m.close(); f.close(); }
});


test("mounted pointer selects the painted Run task and Evidence row after resize and scroll", async () => {
  const f = shellFixture(); const m = await mountShell(f.cwd, f.runId);
  try {
    await m.send("4");
    for (const width of [120, 90, 80]) {
      await m.resize(width, 24);
      const geometry = m.delivery.geometry()!;
      const target = geometry.paintedRows.find(row => stripAnsi(row.text).trimStart().startsWith("T3 "))!;
      expect(target).toBeDefined();
      m.delivery.pointer({ action: "press", column: target.column + 4, row: target.row });
      await m.send("");
      expect(stripAnsi(m.frame())).toContain("❯ T3");
      await m.send("\r");
      expect(m.delivery.snapshot().state.overlay?.join("\n")).toContain("T3");
      await m.send("\x1b"); await m.send("\x1b[A");
    }
    // 40×14 stacks the board and holds only a few of its rows: Down keys select the fourth task and
    // the shell scrolls its row into the body, where the pointer then finds it.
    await m.resize(40, 14);
    for (let i = 0; i < 4; i++) await m.send("\x1b[B");
    const plan = m.delivery.geometry()!;
    const longRow = plan.paintedRows.find(row => row.text.includes(LONG_TASK_ID.slice(0, 28)))!;
    expect(longRow).toBeDefined();
    expect(longRow.row).toBeGreaterThanOrEqual(plan.bodyRow); expect(longRow.row).toBeLessThan(plan.bodyRow + plan.bodyRows);
    m.delivery.pointer({ action: "press", column: longRow.column + 3, row: longRow.row });
    await m.send(""); await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.join("\n")).toContain(LONG_TASK_ID.slice(0, 38));
    expect(m.delivery.snapshot().state.overlay?.join("\n")).toContain("组合文字 cafe\u0301");
    await m.send("\x1b");
    // With the side columns folded, the painted selector remains clickable.
    await m.resize(80, 24);
    const selector = m.delivery.geometry()!.paintedRows.find(row => row.text.startsWith("1 Home"))!;
    m.delivery.pointer({ action: "press", row: selector.row, column: selector.column + cellWidth(selector.text.split("5 Evidence")[0]!) });
    await m.send("");
    expect(m.delivery.snapshot().state.view).toBe("evidence");
    await m.resize(120, 40);
    const geometry = m.delivery.geometry()!;
    const target = geometry.paintedRows.find(row => row.text === "gate-result — T1 — review passed")!;
    expect(target).toBeDefined();
    m.delivery.pointer({ action: "press", column: target.column + 1, row: target.row });
    await m.send(""); await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.join("\n")).toContain('"gate": "review"');
    expect(m.delivery.snapshot().state.overlay?.[0]).toMatch(/#L3$/);
  } finally { await m.close(); f.close(); }
});

test("mounted Evidence reselects a previously clicked row after keyboard navigation", async () => {
  const f = shellFixture(); const m = await mountShell(f.cwd, f.runId);
  try {
    await m.send("5");
    const clickReview = async () => {
      const target = m.delivery.geometry()!.paintedRows.find(row => row.text === "gate-result — T1 — review passed")!;
      expect(target).toBeDefined();
      await m.send(`\x1b[<0;${target.column + 2};${target.row + 1}M`);
      await m.send(`\x1b[<0;${target.column + 2};${target.row + 1}m`);
    };
    await clickReview();
    await m.send("\r");
    const identity = m.delivery.snapshot().state.overlay?.[0];
    expect(identity).toMatch(/#L3$/);
    await m.send("\x1b");
    await m.send("\x1b[B");
    expect(m.delivery.geometry()!.paintedRows.find(row => row.text === "❯ ")?.evidenceId).toMatch(/#L4$/);
    await clickReview();
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(identity);
    expect(m.delivery.snapshot().state.overlay?.join("\n")).toContain('"gate": "review"');
  } finally { await m.close(); f.close(); }
});

test("mounted Home Needs-you pointer opens the same human-first target as Enter", async () => {
  const f = shellFixture();
  const journal = join(f.cwd, ".tickmarkr", "runs", f.runId, "journal.jsonl");
  appendFileSync(journal, [
    { ts: "2026-09-05T00:02:00.000Z", event: "task-blocked", taskId: "T1", data: {} },
    { ts: "2026-09-05T00:02:01.000Z", event: "task-human", taskId: "T2", data: { reason: "operator review" } },
  ].map(event => JSON.stringify(event) + "\n").join(""));
  const m = await mountShell(f.cwd, f.runId);
  try {
    for (const width of [120, 90, 80]) {
      await m.resize(width, 24);
      await m.send("1");
      expect(stripAnsi(m.frame())).toContain("T2 human");
      await m.send("\r");
      expect(m.delivery.snapshot().state.view).toBe("run");
      expect(stripAnsi(m.frame())).toContain("❯ T2");
      await m.send("1");
      const target = m.delivery.geometry()!.paintedRows.find(row => row.text.startsWith("NEEDS YOU"))!;
      expect(target).toBeDefined();
      m.delivery.pointer({ action: "press", column: target.column, row: target.row });
      await m.send("");
      expect(m.delivery.snapshot().state.view).toBe("run");
      expect(stripAnsi(m.frame())).toContain("❯ T2");
      await m.send("\r");
      expect(m.delivery.snapshot().state.overlay?.[0]).toBe("T2");
      await m.send("\x1b");
      await m.send("1");
      // Move Needs-you selection down to T1 (second target):
      await m.send("\x1b[B");
      expect(stripAnsi(m.frame())).toContain("T1 blocked");
      const movedTarget = m.delivery.geometry()!.paintedRows.find(row => row.text.startsWith("NEEDS YOU"))!;
      expect(movedTarget).toBeDefined();
      m.delivery.pointer({ action: "press", column: movedTarget.column, row: movedTarget.row });
      await m.send("");
      expect(m.delivery.snapshot().state.view).toBe("run");
      expect(stripAnsi(m.frame())).toContain("❯ T1");
      await m.send("1");
    }
  } finally { await m.close(); f.close(); }
});
test("mounted Home Needs-you pointer opens diagnostic overlay when diagnostic target is selected", async () => {
  const f = shellFixture();
  let lastFrame = "";
  const raw: boolean[] = [];
  const input = ttyInput({ onRawMode: v => { raw.push(v); } });
  const output = new Writable({ write(chunk, _encoding, next) {
    const text = String(chunk);
    if (text.includes("q Quit")) lastFrame = text.slice(-20000);
    next();
  } }) as NodeJS.WriteStream;
  Object.assign(output, { isTTY: true, columns: 120, rows: 40 });
  let delivery!: ShellDelivery;
  const mounted = runConsolidatedCockpit({
    cwd: f.cwd, runId: f.runId, input, output, binaryVersion: "fixture", debug: true, refreshMs: 2 ** 30,
    diagnostics: [{ kind: "diagnostic", id: "lock-dead-holder", label: "lock: dead holder" }],
    onShellDelivery: d => { delivery = d; },
  });
  const result = mounted.then(() => undefined, error => error as Error);
  await sleep(50);
  try {
    input.write("1");
    await sleep(30);
    // Move down past parks (T2, T1, T3) to diagnostic target:
    input.write("\x1b[B"); await sleep(20);
    input.write("\x1b[B"); await sleep(20);
    input.write("\x1b[B"); await sleep(20);
    expect(stripAnsi(lastFrame)).toContain("lock: dead holder");
    const target = delivery.geometry()!.paintedRows.find(row => row.text.startsWith("NEEDS YOU"))!;
    expect(target).toBeDefined();
    delivery.pointer({ action: "press", column: target.column, row: target.row });
    input.write("");
    await sleep(30);

    expect(delivery.snapshot().state.overlay?.[0]).toBe("lock-dead-holder");
  } finally {
    delivery.key({ input: "q", key: {} });
    delivery.key({ input: "c", key: { ctrl: true } });
    await result;
    input.destroy();
    output.destroy();
    f.close();
  }
});


test("mounted divider dragging uses the same bounded resize transition as the advertised keys", async () => {
  const f = shellFixture(); const m = await mountShell(f.cwd, f.runId);
  try {
    const before = m.delivery.geometry()!;
    const divider = before.paintedRows.find(row => row.text === "│" && row.column === before.bodyColumn + before.bodyColumns)!;
    expect(divider).toBeDefined();
    expect(stripAnsi(m.frame())).toContain("+ Widen shortcuts");
    const report = (button: number, column: number, released = false) => `\x1b[<${button};${column + 1};${divider.row + 1}${released ? "m" : "M"}`;
    await m.send(report(0, divider.column));
    await m.send(report(32, divider.column - 4));
    await m.send(report(0, divider.column - 4, true));
    expect(m.delivery.geometry()).toMatchObject({ shortcuts: 26, bodyColumns: 75 });
    await m.send("-");
    expect(m.delivery.geometry()).toMatchObject({ shortcuts: 25, bodyColumns: 76 });
    await m.send("+");
    expect(m.delivery.geometry()).toMatchObject({ shortcuts: 26, bodyColumns: 75 });
    await m.resize(80, 24);
    expect(stripAnsi(m.frame())).not.toContain("Widen shortcuts");
    await m.send("+");
    expect(m.delivery.geometry()).toMatchObject({ shortcuts: 0, bodyColumns: 78 });
  } finally { await m.close(); f.close(); }
});

test("mounted Open disappears when an unfollowed Evidence selection is removed or the filter has no matches", async () => {
  const f = shellFixture(); const m = await mountShell(f.cwd, f.runId);
  try {
    await m.send("5"); await m.send("\x1b[A");
    expect(stripAnsi(m.frame())).toContain("Enter Open");
    const path = join(f.cwd, ".tickmarkr", "runs", f.runId, "journal.jsonl");
    writeFileSync(path, JSON.stringify({ ts: "2026-09-05T00:02:00.000Z", event: "worker-nudge", data: { reason: "replacement" } }) + "\n");
    m.delivery.refresh(); await m.send("");
    expect(stripAnsi(m.frame())).not.toContain("Enter Open");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay).toBeUndefined();
    await m.send("f");
    expect(stripAnsi(m.frame())).toContain("Enter Open");
    await m.send("/"); await m.send("no matching evidence"); await m.send("\r");
    expect(stripAnsi(m.frame())).not.toContain("Enter Open");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay).toBeUndefined();
  } finally { await m.close(); f.close(); }
});


test("mounted pointer keeps original identities for repeated journal narrations", async () => {
  const f = shellFixture();
  const path = join(f.cwd, ".tickmarkr", "runs", f.runId, "journal.jsonl");
  const duplicate = JSON.stringify({ ts: "2026-09-05T00:03:00.000Z", event: "worker-nudge", taskId: "T2", data: { reason: "identical narration" } }) + "\n";
  appendFileSync(path, duplicate + duplicate);
  const m = await mountShell(f.cwd, f.runId);
  try {
    const expected = m.delivery.snapshot().store.journal.history.at(-2)!;
    await m.send("5");
    const row = m.delivery.geometry()!.paintedRows.find(row => row.evidenceId === expected.id)!;
    expect(row).toBeDefined();
    m.delivery.pointer({ action: "press", row: row.row, column: row.column + 1 });
    await m.send(""); await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(expected.id);
    await m.send("\x1b"); await m.send("1");
    const activity = m.delivery.geometry()!.paintedRows.find(row => row.text.startsWith(` #L${expected.line} `))!;
    expect(activity).toBeDefined();
    m.delivery.pointer({ action: "press", row: activity.row, column: activity.column + 1 });
    await m.send(""); await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(expected.id);
  } finally { await m.close(); f.close(); }
});


test("mounted row presses keep the committed view context across an unpainted view key", async () => {
  const f = shellFixture(); const m = await mountShell(f.cwd, f.runId);
  try {
    await m.send("4");
    const task = m.delivery.geometry()!.paintedRows.find(row => stripAnsi(row.text).trimStart().startsWith("T3 "))!;
    m.delivery.key({ input: "1", key: {} });
    m.delivery.pointer({ action: "press", row: task.row, column: task.column + 3 });
    await m.send("");
    expect(m.delivery.snapshot().state.view).toBe("run");
    expect(stripAnsi(m.frame())).toContain("❯ T3");
    await m.send("5");
    const expected = m.delivery.snapshot().store.journal.history[2]!;
    const evidence = m.delivery.geometry()!.paintedRows.find(row => row.evidenceId === expected.id)!;
    m.delivery.key({ input: "1", key: {} });
    m.delivery.pointer({ action: "press", row: evidence.row, column: evidence.column + 1 });
    await m.send(""); await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(expected.id);
    await m.send("\x1b");
    const oldRow = m.delivery.geometry()!.paintedRows.find(row => row.evidenceId === expected.id)!;
    m.delivery.key({ input: "", key: { rightArrow: true } });
    m.delivery.pointer({ action: "press", row: oldRow.row, column: oldRow.column + 1 });
    await m.send("");
    expect(stripAnsi(m.frame())).toContain("[JOURNAL]");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(expected.id);
    await m.send("\x1b"); await m.resize(40, 14);
    const quit = m.delivery.geometry()!.paintedRows.find(row => row.text.includes("q Quit"))!;
    m.delivery.pointer({ action: "press", row: quit.row, column: quit.column + cellWidth(quit.text.split("q Quit")[0]!) });
    expect(await m.result).toBeUndefined();
    expect(m.controls()).toContain(SHELL_TERMINAL_RESTORE);
  } finally { await m.close(); f.close(); }
});

test("test: in the mounted shell Home's selected Activity row is marked by a glyph that survives with colour disabled and pointer Open on that row opens the same original evidence identity as Enter after the selection has moved off the newest row", async () => {
  const f = shellFixture();
  const m = await mountShell(f.cwd, f.runId, 120, 40, { NO_COLOR: "1" });
  try {
    await m.send("1");
    await m.send("\x1b[C");
    await m.send("\x1b[B");

    expect(m.frame()).not.toMatch(/\x1b\[(?:3[0-9]|38;)/u);
    expect(m.frame()).toContain(GLYPHS.pointer);

    const expected = m.delivery.snapshot().store.journal.history.at(-2)!;
    const newest = m.delivery.snapshot().store.journal.history.at(-1)!;

    const geometry = m.delivery.geometry()!;
    const selectedRow = geometry.paintedRows.find(row => row.text.includes(GLYPHS.pointer))!;
    expect(selectedRow).toBeDefined();
    expect(selectedRow.text).toContain(`#L${expected.line}`);

    const newestRow = geometry.paintedRows.find(row => row.text.includes(`#L${newest.line}`))!;
    expect(newestRow.text).not.toContain(GLYPHS.pointer);

    m.delivery.pointer({ action: "press", row: selectedRow.row, column: selectedRow.column + 1 });
    await m.send("");
    expect(m.delivery.snapshot().state.view).toBe("evidence");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(expected.id);

    await m.send("\x1b");
    await m.send("1");
    await m.send("\x1b[C");
    await m.send("\x1b[B");

    await m.send("\r");
    expect(m.delivery.snapshot().state.view).toBe("evidence");
    await m.send("\r");
    expect(m.delivery.snapshot().state.overlay?.[0]).toBe(expected.id);
  } finally {
    await m.close();
    f.close();
  }
});
