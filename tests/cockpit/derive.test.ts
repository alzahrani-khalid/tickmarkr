import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import type { CaptureEvent, DemoJournalCapture } from "../../src/tui/cockpit/demo.js";
import {
  ABSENT_FIELD,
  fieldReading,
  runViewRowIdentities,
  selectSparklineBucketWidthMs,
  SPARKLINE_BUCKET_WINDOW,
  type CockpitGraph,
  type RunCockpitSource,
} from "../../src/tui/cockpit/derive.js";
import {
  initialRunInteractionState,
  reconcileRunInteraction,
} from "../../src/tui/cockpit/keys.js";
import {
  deriveRunCockpitData,
  deriveRunViewRows,
  RunCockpitFrame,
} from "../../src/tui/cockpit/run-cockpit.js";

const SOURCES = join(import.meta.dirname, "../fixtures/cockpit/sources");

function capture(fileName: string): DemoJournalCapture {
  const raw = readFileSync(join(SOURCES, fileName), "utf8");
  return {
    fileName,
    raw,
    events: raw.split("\n").flatMap((line) =>
      line.trim() ? [JSON.parse(line) as CaptureEvent] : []
    ),
  };
}

function sourceEvents(raw: string): CaptureEvent[] {
  return raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as CaptureEvent];
    } catch {
      return [];
    }
  });
}

function sourceEventLines(
  raw: string,
): { readonly event: CaptureEvent; readonly line: number }[] {
  return raw.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ event: JSON.parse(line) as CaptureEvent, line: index + 1 }];
    } catch {
      return [];
    }
  });
}

/**
 * The failure forms the committed sources use, restated so the checks are
 * independent of the derivation under test: an unsuccessful result flag, an
 * unsuccessful outcome flag, an event name reporting a failure, a non-zero
 * exit status, or a run-end whose tip verification reads failed.
 */
function recordsFailure(event: CaptureEvent): boolean {
  return event.event.includes("failed")
    || event.data.pass === false
    || event.data.ok === false
    || (typeof event.data.exitCode === "number" && event.data.exitCode !== 0)
    || (
      event.event === "run-end"
      && (
        event.data.tipVerify === "failed"
        || (Array.isArray(event.data.failed) && event.data.failed.length > 0)
      )
    );
}

function rowsById(
  data: ReturnType<typeof deriveRunCockpitData>,
): Map<string, ReturnType<typeof deriveRunCockpitData>["journalRows"][number]> {
  return new Map(
    data.journalRows.flatMap((row) =>
      row.id === undefined ? [] : [[row.id, row] as const]
    ),
  );
}

function rateCapture(): DemoJournalCapture {
  const started = Date.parse("2026-07-25T00:00:00.000Z");
  const event = (
    seconds: number,
    name: string,
    data: Record<string, unknown> = {},
    taskId?: string,
  ): CaptureEvent => ({
    ts: new Date(started + seconds * 1_000).toISOString(),
    event: name,
    ...(taskId ? { taskId } : {}),
    data,
  });
  const events = [
    event(0, "run-start", { branch: "spec/rates", pid: 123 }),
    event(5, "task-done", {}, "T1"),
    event(10, "gate-result", { pass: true }),
    event(20, "task-done", {}, "T2"),
    event(30, "gate-result", { pass: true }),
    event(130, "task-done", {}, "T3"),
    event(140, "gate-result", { pass: true }),
    event(150, "gate-result", { pass: false }),
    event(170, "run-end", { tipVerify: "passed" }),
  ];
  return {
    fileName: "run-rate.journal.jsonl",
    events,
    raw: `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
  };
}

function numericSamples(samples: readonly unknown[]): number[] {
  return samples.filter((sample): sample is number => typeof sample === "number");
}

function hasFall(samples: readonly unknown[]): boolean {
  const values = numericSamples(samples);
  return values.some((value, index) => index > 0 && value < values[index - 1]!);
}

function elapsedMs(source: DemoJournalCapture): number {
  return Date.parse(source.events.at(-1)!.ts) - Date.parse(source.events[0]!.ts);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

async function frameFor(
  source: DemoJournalCapture,
  options?: { readonly isDaemonAlive?: (pid: number) => boolean },
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
    data: deriveRunCockpitData(source, "9.8.7", options),
    columns: 140,
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

describe("run cockpit event derivation", () => {
  test("test: each tile's series is bucketed by elapsed time rather than indexed by event, so one bucket spans an interval and may contain any number of events including none", () => {
    const data = deriveRunCockpitData(rateCapture(), "9.8.7");
    const series = [
      data.tasks.samples,
      data.gates.samples,
      data.passRate.samples,
    ];

    for (const samples of series) {
      expect(samples).toHaveLength(SPARKLINE_BUCKET_WINDOW);
      const occupied = samples.flatMap((sample, index) =>
        typeof sample === "number" ? [index] : []
      );
      expect(occupied).toHaveLength(2);
      expect(occupied[1]! - occupied[0]!).toBe(2);
      expect(samples[occupied[0]! + 1]).toBeNull();
    }
    expect(numericSamples(data.tasks.samples)).toEqual([2, 1]);
    expect(numericSamples(data.gates.samples)).toEqual([2, 1]);
    expect(numericSamples(data.passRate.samples)).toEqual([100, 50]);
  });

  test("test: each bucket carries the change occurring within it rather than a running total, so a series falls whenever the underlying rate falls", () => {
    const data = deriveRunCockpitData(rateCapture(), "9.8.7");

    expect(numericSamples(data.tasks.samples)).toEqual([2, 1]);
    expect(numericSamples(data.gates.samples)).toEqual([2, 1]);
    expect(numericSamples(data.passRate.samples)).toEqual([100, 50]);
    expect(hasFall(data.tasks.samples)).toBe(true);
    expect(hasFall(data.gates.samples)).toBe(true);
    expect(hasFall(data.passRate.samples)).toBe(true);
  });

  test("test: against a captured engagement, at least one tile's series falls somewhere, which a running total could never produce", () => {
    const data = deriveRunCockpitData(
      capture("run-20260724-231138.journal.jsonl"),
      "9.8.7",
    );

    expect([
      data.tasks.samples,
      data.gates.samples,
    ].some(hasFall)).toBe(true);
  });

  test("test: the bucket window is a single named constant that every producer and every consumer imports, so changing the window is one edit and no call site repeats the value", () => {
    const deriveSource = readFileSync(
      new URL("../../src/tui/cockpit/derive.ts", import.meta.url),
      "utf8",
    );
    const componentSource = readFileSync(
      new URL("../../src/tui/cockpit/components.tsx", import.meta.url),
      "utf8",
    );

    expect(SPARKLINE_BUCKET_WINDOW).toBe(12);
    expect(deriveSource).toContain("export const SPARKLINE_BUCKET_WINDOW = 12;");
    expect(componentSource).toMatch(
      /import \{\s*SPARKLINE_BUCKET_WINDOW\s*\} from "\.\/derive\.js";/,
    );
    expect(componentSource).toContain(".slice(-SPARKLINE_BUCKET_WINDOW)");
    expect(`${deriveSource}\n${componentSource}`.match(/\b12\b/g)).toHaveLength(1);
  });

  test("test: the shipped window is twelve buckets whose width is chosen from a coarsening ladder so the window covers the elapsed run, and the widths that ladder selects are asserted against captured runs of differing length", () => {
    const cases = [
      [capture("run-20260724-194619.journal.jsonl"), 5],
      [capture("run-20260724-231138.journal.jsonl"), 10],
    ] as const;
    for (const [source, expectedMinutes] of cases) {
      const widthMs = selectSparklineBucketWidthMs(elapsedMs(source));
      expect(widthMs).toBe(expectedMinutes * 60_000);
      expect(widthMs * SPARKLINE_BUCKET_WINDOW).toBeGreaterThanOrEqual(
        elapsedMs(source),
      );
    }
    expect(selectSparklineBucketWidthMs(34 * 60_000)).toBe(5 * 60_000);
    expect(selectSparklineBucketWidthMs(309 * 60_000)).toBe(30 * 60_000);
  });

  test("test: every count and rate the run cockpit shows equals the value independently derived from the captured events it claims to summarise", async () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEvents(source.raw);
    const dispatched = new Set(events.flatMap((event) =>
      event.event === "task-dispatch" && event.taskId ? [event.taskId] : []
    ));
    const done = new Set(events.flatMap((event) =>
      event.event === "task-done" && event.taskId ? [event.taskId] : []
    ));
    const gates = events.filter((event) => event.event === "gate-result");
    const passed = gates.filter((event) => event.data.pass === true).length;
    const rate = Math.round((passed / gates.length) * 100);
    const poisonedRaw = source.raw.split("\n").map((line) => {
      if (!line.trim()) return line;
      const event = JSON.parse(line) as CaptureEvent;
      if (event.event !== "run-end") return line;
      return JSON.stringify({
        ...event,
        data: {
          ...event.data,
          done: ["SUMMARY-LIE"],
          failed: ["SUMMARY-LIE"],
          human: ["SUMMARY-LIE"],
          escalated: 999,
          gatePassed: 999,
          gateTotal: 999,
          passRate: 1,
        },
      });
    }).join("\n");
    const poisonedSummary = {
      ...source,
      raw: poisonedRaw,
    } satisfies DemoJournalCapture;

    const data = deriveRunCockpitData(poisonedSummary, "9.8.7");
    const frame = await frameFor(poisonedSummary);
    const summaryIds = new Set(["SUMMARY-LIE"]);
    const taskTotal = new Set([...dispatched, ...summaryIds]).size;

    // The closing summary is a captured event too. Its contradictory identity
    // is folded once, with failure taking precedence, rather than discarded.
    expect(data.tasks).toMatchObject({ done: done.size, total: taskTotal });
    expect(data.status).toBe("failed");
    expect(data.statusItems).toContainEqual({ state: "fail", text: "failed 1" });
    expect(data.gates).toMatchObject({ passed, total: gates.length });
    expect(data.passRate.value).toBe(rate);
    expect(data.progress).toBe(Math.round((done.size / taskTotal) * 100));
    expect(frame).toContain(`${done.size}/${taskTotal}`);
    expect(frame).toContain(`${passed}/${gates.length}`);
    expect(frame).toContain(`${rate}%`);
    expect(frame).not.toContain("999");
  });

  test("test: the attempt and the acting adapter are present both in the progress caption and in the journal rows, for a captured task whose work was completed by a different adapter than the one first dispatched", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const t2Dispatches = sourceEvents(source.raw).filter((event) =>
      event.event === "task-dispatch" && event.taskId === "T2"
    );
    const firstAdapter = (t2Dispatches[0]!.data.assignment as { adapter: string }).adapter;
    const acting = t2Dispatches.at(-1)!;
    const actingAssignment = acting.data.assignment as { adapter: string; model: string };
    const attempt = Number(acting.data.attempt) + 1;

    const data = deriveRunCockpitData(source, "9.8.7");
    const t2Row = data.journalRows.find((row) => row.text.includes("T2"));

    expect(actingAssignment.adapter).not.toBe(firstAdapter);
    expect(data.progressCaption).toContain("T2");
    expect(data.progressCaption).toContain(`attempt ${attempt}`);
    expect(data.progressCaption).toContain(`${actingAssignment.adapter}:${actingAssignment.model}`);
    expect(t2Row?.text).toContain(`attempt ${attempt}`);
    expect(t2Row?.text).toContain(`${actingAssignment.adapter}:${actingAssignment.model}`);
  });

  test("test: the entries offered to the journal are derived from the events the source carries, so a source carrying more history offers more entries than one carrying less", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const sourceLines = source.raw.trimEnd().split("\n");
    const shorter = {
      ...source,
      raw: `${sourceLines.slice(0, 12).join("\n")}\n`,
    } satisfies DemoJournalCapture;

    const shortRows = deriveRunCockpitData(shorter, "9.8.7", {
      isDaemonAlive: () => false,
    }).journalRows;
    const fullRows = deriveRunCockpitData(source, "9.8.7").journalRows;

    expect(shortRows).toHaveLength(sourceEvents(shorter.raw).length);
    expect(fullRows).toHaveLength(sourceEvents(source.raw).length);
    expect(fullRows.length).toBeGreaterThan(shortRows.length);
  });

  test("test: the escalation count in the status strip equals the number of escalation events in the captured source", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const expected = sourceEvents(source.raw).filter((event) =>
      event.event === "escalation"
    ).length;

    const data = deriveRunCockpitData(source, "9.8.7");

    expect(data.statusItems).toContainEqual({
      state: "warn",
      text: `escalated ${expected}`,
    });
  });

  test("test: a journal whose final run-end records tipVerify passed draws the strip pass, even when an earlier cycle failed", () => {
    const source = capture("run-20260724-194619.journal.jsonl");
    const events = sourceEvents(source.raw);
    const runEnds = events.filter((event) => event.event === "run-end");

    expect(runEnds.map((event) => event.data.tipVerify)).toEqual([
      "failed",
      "passed",
    ]);
    expect(events.some((event) => event.event === "tip-verify-failed")).toBe(
      true,
    );

    expect(deriveRunCockpitData(source, "9.8.7").statusItems[0]).toEqual({
      state: "pass",
      text: "tip-verify passed",
    });
  });

  test("test: a journal whose latest tip verdict is failed draws the strip fail", () => {
    const source = capture("run-20260724-194619.journal.jsonl");
    const lines = source.raw.trimEnd().split("\n");
    const firstRunEnd = lines.findIndex((line) =>
      (JSON.parse(line) as CaptureEvent).event === "run-end"
    );
    const failedCycle = {
      ...source,
      raw: `${lines.slice(0, firstRunEnd + 1).join("\n")}\n`.replace(
        /"event":"tip-verify-failed","data":\{[^]*?\}\}\n/,
        '"event":"tip-verify","data":{"gate":"test","pass":true}}\n',
      ),
    } satisfies DemoJournalCapture;
    const events = sourceEvents(failedCycle.raw);

    expect(events.at(-1)).toMatchObject({
      event: "run-end",
      data: { tipVerify: "failed" },
    });
    expect(events.some((event) => event.event === "tip-verify-failed")).toBe(false);
    expect(events.filter((event) => event.event === "tip-verify").every(
      (event) => event.data.pass === true,
    )).toBe(true);

    expect(deriveRunCockpitData(failedCycle, "9.8.7").statusItems[0]).toEqual({
      state: "fail",
      text: "tip-verify FAILED",
    });
  });

  test("test: with no tip verification recorded the strip draws the item as absent rather than as passed or failed", () => {
    const source = syntheticSource("run-no-tip.journal.jsonl", [
      {
        ts: "2026-07-25T00:00:00.000Z",
        event: "run-start",
        data: { branch: "spec/no-tip", pid: 1 },
      },
      {
        ts: "2026-07-25T00:00:01.000Z",
        event: "run-end",
        data: { done: [], failed: [], human: [], blocked: [], pending: [] },
      },
    ]);
    const events = sourceEvents(source.raw);
    expect(events.some((event) =>
      event.event === "tip-verify"
      || event.event === "tip-verify-failed"
      || typeof event.data.tipVerify === "string"
    )).toBe(false);

    const item = deriveRunCockpitData(source, "9.8.7").statusItems[0]!;
    expect(item).toEqual({
      state: "neutral",
      text: `tip-verify ${ABSENT_FIELD}`,
    });
    expect(item.state).not.toBe("pass");
    expect(item.state).not.toBe("fail");
    expect(item.text).not.toContain("passed");
    expect(item.text).not.toContain("FAILED");
  });

  test("test: an unparseable source line is still reported ahead of the entries derived from parsed ones", async () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const line = source.raw.trimEnd().split("\n").length + 1;
    const malformed = {
      ...source,
      raw: `${source.raw.trimEnd()}\n{not-json\n`,
    };

    const data = deriveRunCockpitData(malformed, "9.8.7");
    const frame = await frameFor(malformed);

    expect(data.journalRows[0]).toEqual(expect.objectContaining({
      state: "fail",
      text: expect.stringContaining(`DEFECT · source line ${line}`),
    }));
    expect(data.journalRows.slice(1)).toHaveLength(
      sourceEvents(source.raw).length,
    );
    expect(frame).toContain(`DEFECT · source line ${line}`);
  });

  test("test: the most recent entry is drawn first and the order of the rest follows the order the source records them", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEvents(source.raw);
    const expectedTimes = [...events].reverse().map((event) =>
      new Date(event.ts).toISOString().slice(11, 19)
    );

    const rows = deriveRunCockpitData(source, "9.8.7").journalRows;

    expect(rows.map((row) => row.time)).toEqual(expectedTimes);
  });

  test("test: a source carrying dispatched work with no run end, whose daemon is no longer alive, renders those tasks as interrupted rather than as running", async () => {
    const source = capture("run-20260725-025004.interrupted.journal.jsonl");
    const frame = await frameFor(source, { isDaemonAlive: () => false });

    expect(frame).toContain("interrupted");
    for (const taskId of ["T1", "T2", "T3"]) {
      expect(frame).toContain(`${taskId} interrupted`);
    }
    expect(frame).not.toContain(" running ");
  });

  test("the surface cannot report a task as running while reporting the daemon that dispatched it as gone", async () => {
    const source = capture("run-20260725-025004.interrupted.journal.jsonl");
    const lastEvent = sourceEvents(source.raw).at(-1)!;
    const superseded = {
      ...source,
      raw: `${source.raw.trimEnd()}\n${JSON.stringify({
        ts: new Date(Date.parse(lastEvent.ts) + 1).toISOString(),
        event: "superseded",
        data: { by: "run-successor" },
      })}\n`,
    } satisfies DemoJournalCapture;

    const data = deriveRunCockpitData(superseded, "9.8.7");
    const frame = await frameFor(superseded);

    expect(data.status).toBe("interrupted");
    for (const taskId of ["T1", "T2", "T3"]) {
      expect(frame).toContain(`${taskId} interrupted`);
    }
    expect(frame).not.toContain(" running ");
  });

  test("test: an event recording a failed outcome is drawn in the failure state even when the task it belongs to finished successfully", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEventLines(source.raw);
    const finished = new Set(events.flatMap(({ event }) =>
      event.event === "task-done" && event.taskId ? [event.taskId] : []
    ));
    const rows = rowsById(deriveRunCockpitData(source, "9.8.7"));

    const failedOutcomes = events.filter(({ event }) =>
      event.taskId !== undefined
      && finished.has(event.taskId)
      && recordsFailure(event)
    );
    expect(failedOutcomes.length).toBeGreaterThan(0);
    for (const { event, line } of failedOutcomes) {
      expect(finished.has(event.taskId!)).toBe(true);
      expect(rows.get(`event:${line}`)?.state, `line ${line}`).toBe("fail");
    }
    // the tasks those events belong to really did finish successfully — and
    // said so twice, because finishing and landing are two records: the
    // completion says the worker stopped working and carries no check, and the
    // merge that lands it is the one that earns one.
    const doneLines = events.filter(({ event }) =>
      event.event === "task-done"
      && event.taskId !== undefined
      && failedOutcomes.some((failed) => failed.event.taskId === event.taskId)
    );
    expect(doneLines.length).toBeGreaterThan(0);
    for (const { event, line } of doneLines) {
      expect(rows.get(`event:${line}`)?.state, `line ${line}`).toBe("neutral");
      expect(rows.get(`event:${line}`)?.text, `line ${line}`).toContain("done");
      const landing = events.find((item) =>
        item.event.event === "merge" && item.event.taskId === event.taskId
      )!;
      expect(rows.get(`event:${landing.line}`)?.state, `line ${landing.line}`)
        .toBe("pass");
    }
  });

  test("test: a failure is recognised from any form the sources use, including an unsuccessful result flag, an unsuccessful outcome flag, an event whose name reports a failure, and a non-zero exit status", () => {
    const started = Date.parse("2026-07-25T00:00:00.000Z");
    const forms = [
      { event: "gate-result", data: { gate: "test", pass: false } },
      { event: "worker-result", data: { ok: false } },
      { event: "tip-verify-failed", data: { gate: "test" } },
      { event: "worker-result", data: { ok: true, exitCode: 1 } },
    ] as const;
    const events = [
      { ts: new Date(started).toISOString(), event: "run-start", data: { branch: "spec/forms", pid: 1 } },
      ...forms.map((form, index) => ({
        ts: new Date(started + (index + 1) * 1_000).toISOString(),
        event: form.event,
        data: form.data,
      })),
      {
        ts: new Date(started + 60_000).toISOString(),
        event: "run-end",
        data: { tipVerify: "passed" },
      },
    ];
    const source = {
      fileName: "run-forms.journal.jsonl",
      events,
      raw: `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
    } satisfies DemoJournalCapture;

    const data = deriveRunCockpitData(source, "9.8.7");

    expect(
      data.journalRows.filter((row) => row.state === "fail"),
    ).toHaveLength(forms.length);
    for (const form of forms) {
      expect(recordsFailure(form as unknown as CaptureEvent)).toBe(true);
    }
  });

  test("test: every event in the eventful committed source that records a failure by any of those forms is drawn in the failure state, and the number of such rows equals the number of such events", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const failures = sourceEventLines(source.raw).filter(({ event }) =>
      recordsFailure(event)
    );
    expect(failures.length).toBeGreaterThan(0);

    const data = deriveRunCockpitData(source, "9.8.7");
    const rows = rowsById(data);

    for (const { line } of failures) {
      expect(rows.get(`event:${line}`)?.state, `line ${line}`).toBe("fail");
    }
    expect(
      data.journalRows.filter((row) => row.state === "fail"),
    ).toHaveLength(failures.length);
  });

  test("test: drawing a row from its task's final state instead of the event's own outcome makes the preceding checks fail", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEventLines(source.raw);
    // the rule the defect applied: every event wears its task's final state
    const finalStates = new Map<string, string>();
    for (const { event } of events) {
      if (!event.taskId) continue;
      if (event.event === "task-done") finalStates.set(event.taskId, "pass");
      if (event.event === "task-failed") finalStates.set(event.taskId, "fail");
      if (event.event === "task-human") finalStates.set(event.taskId, "warn");
    }
    const failures = events.filter(({ event }) => recordsFailure(event));
    const underTaskFinalRule = failures.map(({ event }) =>
      event.taskId === undefined
        ? "neutral"
        : finalStates.get(event.taskId) ?? "neutral"
    );

    // under that rule the failed-outcome rows are not drawn as failures, so
    // the count the preceding check asserts cannot hold
    expect(underTaskFinalRule).not.toContain("fail");
    expect(underTaskFinalRule.filter((state) => state === "fail"))
      .not.toHaveLength(failures.length);

    // the shipped rule holds it
    const data = deriveRunCockpitData(source, "9.8.7");
    expect(
      data.journalRows.filter((row) => row.state === "fail"),
    ).toHaveLength(failures.length);
  });

  test("test: the words a row carries describe what its event recorded rather than the state its task reached afterwards", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEventLines(source.raw);
    const rows = rowsById(deriveRunCockpitData(source, "9.8.7"));

    // T2 finished done; its failed gate result says what it recorded
    const failedGate = events.find(({ event }) =>
      event.event === "gate-result"
      && event.taskId === "T2"
      && event.data.pass === false
    )!;
    const failedRow = rows.get(`event:${failedGate.line}`)!;
    expect(failedRow.text).toContain("fail");
    expect(failedRow.text).toContain("gate-result");
    expect(failedRow.text).not.toContain("done");

    // its task-done row names the event that recorded the finish
    const done = events.find(({ event }) =>
      event.event === "task-done" && event.taskId === "T2"
    )!;
    expect(rows.get(`event:${done.line}`)?.text).toContain("task-done");

    // and a row with no outcome of its own carries none of the task's
    const phase = events.find(({ event }) =>
      event.event === "phase-start" && event.taskId === "T2"
    )!;
    const phaseRow = rows.get(`event:${phase.line}`)!;
    expect(phaseRow.text).toContain("phase-start");
    expect(phaseRow.text).not.toContain("done");
  });

  test("test: an event that records no outcome of its own is drawn in the neutral state rather than borrowing one from its task", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEventLines(source.raw);
    const finished = new Set(events.flatMap(({ event }) =>
      event.event === "task-done" && event.taskId ? [event.taskId] : []
    ));
    const rows = rowsById(deriveRunCockpitData(source, "9.8.7"));

    const outcomeless = events.filter(({ event }) =>
      event.taskId !== undefined
      && finished.has(event.taskId)
      && (event.event === "task-dispatch" || event.event === "phase-start")
    );
    expect(outcomeless.length).toBeGreaterThan(0);
    for (const { line } of outcomeless) {
      expect(rows.get(`event:${line}`)?.state, `line ${line}`).toBe("neutral");
    }
  });

  test("test: an event marking a run as escalated or awaiting a human is still drawn in the warning state", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const escalations = sourceEventLines(source.raw).filter(({ event }) =>
      event.event === "escalation"
    );
    expect(escalations.length).toBeGreaterThan(0);
    const rows = rowsById(deriveRunCockpitData(source, "9.8.7"));
    for (const { line } of escalations) {
      expect(rows.get(`event:${line}`)?.state, `line ${line}`).toBe("warn");
    }

    const started = Date.parse("2026-07-25T00:00:00.000Z");
    const events = [
      { ts: new Date(started).toISOString(), event: "run-start", data: { branch: "spec/human", pid: 1 } },
      { ts: new Date(started + 1_000).toISOString(), event: "task-dispatch", taskId: "T1", data: { attempt: 0 } },
      { ts: new Date(started + 2_000).toISOString(), event: "task-human", taskId: "T1", data: {} },
    ];
    const awaiting = deriveRunCockpitData({
      fileName: "run-human.journal.jsonl",
      events,
      raw: `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
    }, "9.8.7", { isDaemonAlive: () => true });
    const humanRow = rowsById(awaiting).get("event:3");
    expect(humanRow?.state).toBe("warn");
  });

  test("test: every row that carries a state glyph also carries a word for that state, so meaning is never carried by hue alone", async () => {
    // Every word the vocabulary allows a state, including the ones a row wears
    // when it names a task rather than an outcome: a park reads parked, an
    // unmerged finish reads done, a failure reads failed.
    const stateWords: Record<string, RegExp> = {
      pass: /\bpass\b/,
      fail: /\bfail(?:ed)?\b/,
      warn: /\bwarn\b|\binterrupted\b|\bparked\b/,
      neutral: /\bneutral\b|\bdone\b|\brunning\b|\bpending\b/,
    };
    const sources = [
      capture("run-20260724-231138.journal.jsonl"),
      capture("run-20260724-194619.journal.jsonl"),
      capture("run-20260725-025004.interrupted.journal.jsonl"),
    ];
    for (const source of sources) {
      const data = deriveRunCockpitData(source, "9.8.7", {
        isDaemonAlive: () => false,
      });
      expect(data.journalRows.length).toBeGreaterThan(0);
      for (const row of data.journalRows) {
        expect(row.text, `${source.fileName} ${row.id}`).toMatch(
          stateWords[row.state]!,
        );
      }
    }

    // a defect row carries its failure word as well
    const malformed = {
      ...sources[0]!,
      raw: `{not-json\n${sources[0]!.raw}`,
    } satisfies DemoJournalCapture;
    const withDefect = deriveRunCockpitData(malformed, "9.8.7");
    expect(withDefect.journalRows[0]!.state).toBe("fail");
    expect(withDefect.journalRows[0]!.text).toMatch(/\bfail\b/);

    // and the rendered frame pairs every glyph with its word
    const frame = await frameFor(sources[0]!);
    expect(frame).toMatch(/✓ T\d+ pass · /);
    expect(frame).toMatch(/✗ T\d+ fail · /);
    expect(frame).toMatch(/! T\d+ warn · /);
    expect(frame).toMatch(/- (?:T\d+ )?neutral · /);
  });

  test("test: the newest row still names the spotlight task's attempt and acting adapter", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const t2Dispatches = sourceEvents(source.raw).filter((event) =>
      event.event === "task-dispatch" && event.taskId === "T2"
    );
    const acting = t2Dispatches.at(-1)!;
    const actingAssignment = acting.data.assignment as {
      adapter: string;
      model: string;
    };
    const attempt = Number(acting.data.attempt) + 1;

    const rows = deriveRunCockpitData(source, "9.8.7").journalRows;

    expect(rows[0]?.text).toContain("T2");
    expect(rows[0]?.text).toContain(`attempt ${attempt}`);
    expect(rows[0]?.text).toContain(
      `${actingAssignment.adapter}:${actingAssignment.model}`,
    );
  });
});

/** A journal written for one check, in the shape the daemon appends. */
function syntheticSource(
  fileName: string,
  events: readonly {
    ts: string;
    event: string;
    taskId?: string;
    data?: Record<string, unknown>;
  }[],
): { fileName: string; raw: string } {
  return {
    fileName,
    raw: events
      .map(({ data = {}, ...rest }) => JSON.stringify({ ...rest, data }))
      .join("\n") + "\n",
  };
}

const AT = (seconds: number): string =>
  new Date(Date.parse("2026-07-28T09:00:00.000Z") + seconds * 1_000).toISOString();

const graphOf = (
  ...tasks: readonly { id: string; title?: string; status?: string }[]
): CockpitGraph => ({ tasks });

/** The HH:MM:SS reading every cockpit row speaks, derived here independently. */
const reading = (ts: string): string => new Date(Date.parse(ts)).toISOString().slice(11, 19);

describe("cockpit view rows", () => {
  test("test: the tasks view's rows are one per task in the compiled graph, so a task the journal never mentions still draws a row, with state, attempts, actor and last event time coming from recorded journal events only", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEvents(source.raw);
    const recordedIds = [
      ...new Set(events.flatMap((event) => event.taskId ? [event.taskId] : [])),
    ];
    // The graph carries every recorded task plus one the journal never names,
    // and orders them its own way — the rows must follow the graph, not the journal.
    const unmentioned = "T99";
    expect(recordedIds).not.toContain(unmentioned);
    const graph = graphOf(
      { id: unmentioned, title: "compiled but never dispatched" },
      ...recordedIds.map((id) => ({ id, title: `title of ${id}` })),
    );

    const rows = deriveRunCockpitData(source, "9.8.7", { graph }).taskRows;

    expect(rows.map((row) => row.taskId)).toEqual([unmentioned, ...recordedIds]);
    expect(rows.map((row) => row.id)).toEqual(
      [unmentioned, ...recordedIds].map((id) => `task:${id}`),
    );
    expect(rows.map((row) => row.title)).toEqual(
      graph.tasks.map((task) => task.title),
    );

    const drawn = new Map(rows.map((row) => [row.taskId, row] as const));
    // The row exists, and every field the engagement never recorded for it —
    // its state included — is absent rather than assumed.
    const unmentionedRow = drawn.get(unmentioned)!;
    expect(unmentionedRow.state).toBeUndefined();
    expect(unmentionedRow.attempts).toBeUndefined();
    expect(unmentionedRow.actor).toBeUndefined();
    expect(unmentionedRow.lastEventTime).toBeUndefined();

    for (const id of recordedIds) {
      const row = drawn.get(id)!;
      const mine = events.filter((event) => event.taskId === id);
      const dispatches = mine.filter((event) => event.event === "task-dispatch");
      const assignment = dispatches.at(-1)!.data.assignment as {
        adapter: string;
        model: string;
      };
      expect(row.attempts).toBe(dispatches.length);
      expect(row.actor).toBe(`${assignment.adapter}:${assignment.model}`);
      expect(row.lastEventTime).toBe(reading(mine.at(-1)!.ts));
      // The state is the one the journal recorded, never the graph's.
      const finished = mine.some((event) => event.event === "task-done");
      if (finished) expect(row.state).toBe("done");
    }

    // Attempt labels restart at zero when an engagement resumes, so the newest
    // label is not the count. A task dispatched 0, 1, 0 was tried three times.
    const resumed = deriveRunCockpitData(
      syntheticSource("run-resumed.journal.jsonl", [
        { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-resumed", pid: 1 } },
        ...[0, 1].map((attempt, index) => ({
          ts: AT(index + 1),
          event: "task-dispatch",
          taskId: "T1",
          data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt },
        })),
        { ts: AT(3), event: "run-resume", data: { pid: 1 } },
        {
          ts: AT(4),
          event: "task-dispatch",
          taskId: "T1",
          data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
        },
        { ts: AT(5), event: "task-done", taskId: "T1", data: {} },
        { ts: AT(6), event: "run-end", data: { tipVerify: "passed" } },
      ]),
      "9.8.7",
      { graph: graphOf({ id: "T1" }), isDaemonAlive: () => false },
    ).taskRows;

    expect(resumed[0]!.attempts).toBe(3);
    // Not the newest recorded label, and not that label plus one.
    expect(resumed[0]!.attempts).not.toBe(1);
  });

  test("test: the gates view's rows are one per recorded gate result, newest first, and the row's detail payload is the recorded details verbatim", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const recorded = sourceEventLines(source.raw).filter(
      ({ event }) => event.event === "gate-result",
    );
    expect(recorded.length).toBeGreaterThan(0);

    const rows = deriveRunCockpitData(source, "9.8.7").gateRows;

    expect(rows).toHaveLength(recorded.length);
    // Newest first: the rows are the recorded results in reverse source order.
    const newestFirst = [...recorded].reverse();
    expect(rows.map((row) => row.id)).toEqual(
      newestFirst.map(({ line }) => `gate:${line}`),
    );
    expect(rows.map((row) => row.time)).toEqual(
      newestFirst.map(({ event }) => reading(event.ts)),
    );
    for (const [index, { event }] of newestFirst.entries()) {
      const row = rows[index]!;
      expect(row.gate).toBe(event.data.gate);
      expect(row.taskId).toBe(event.taskId);
      expect(row.pass).toBe(event.data.pass);
      // Verbatim: every byte the gate recorded, newlines and all.
      expect(row.details).toBe(event.data.details);
    }
    // The corpus really does carry multi-line findings, so verbatim means something.
    expect(rows.some((row) => (row.details ?? "").includes("\n"))).toBe(true);
  });

  test("test: the fleet view's rows are one per recorded channel, and a channel with zero dispatches draws a dash rather than an invented count", () => {
    const source = capture("run-20260724-231138.journal.jsonl");
    const events = sourceEvents(source.raw);
    // The engagement recorded its whole fleet at run-start; only three of those
    // channels were ever dispatched to.
    const roster = events.find((event) => event.event === "run-start")!
      .data.channels as readonly string[];
    const dispatched = new Map<string, number>();
    for (const event of events) {
      if (event.event !== "task-dispatch") continue;
      const assignment = event.data.assignment as { adapter: string; model: string };
      const key = `${assignment.adapter}:${assignment.model}`;
      dispatched.set(key, (dispatched.get(key) ?? 0) + 1);
    }
    expect(roster.length).toBeGreaterThan(dispatched.size);

    const rows = deriveRunCockpitData(source, "9.8.7").fleetRows;

    // One row per recorded channel: the roster in the order it was recorded,
    // and no channel the engagement never named.
    expect(rows.map((row) => row.id)).toEqual(roster.map((key) => `channel:${key}`));
    expect(rows.map((row) => `${row.adapter}:${row.model}`)).toEqual([...roster]);
    for (const key of roster) {
      const row = rows.find((candidate) => candidate.id === `channel:${key}`)!;
      const count = dispatched.get(key);
      expect(row.dispatches).toBe(count);
      expect(fieldReading(row.dispatches)).toBe(
        count === undefined ? ABSENT_FIELD : String(count),
      );
    }
    // The roster's unused seats really are the majority here, so the dash means
    // something: nine channels the engagement could have used and never did.
    const idle = rows.filter((row) => row.dispatches === undefined);
    expect(idle).toHaveLength(roster.length - dispatched.size);
    for (const row of idle) expect(fieldReading(row.dispatches)).toBe(ABSENT_FIELD);

    // A channel the router named and passed over is recorded without ever
    // being dispatched to: its count is absent, not zero.
    const passedOver = deriveRunCockpitData(
      syntheticSource("run-fleet.journal.jsonl", [
        { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-fleet", pid: 1 } },
        {
          ts: AT(1),
          event: "failover-deviation",
          taskId: "T1",
          data: { site: "escalate", static: "claude-code:fable", chosen: "codex:gpt-9" },
        },
        {
          ts: AT(2),
          event: "task-dispatch",
          taskId: "T1",
          data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
        },
        { ts: AT(3), event: "run-end", data: { tipVerify: "passed" } },
      ]),
      "9.8.7",
      { isDaemonAlive: () => false },
    ).fleetRows;

    expect(passedOver.map((row) => row.id)).toEqual([
      "channel:claude-code:fable",
      "channel:codex:gpt-9",
    ]);
    const never = passedOver[0]!;
    expect(never.adapter).toBe("claude-code");
    expect(never.model).toBe("fable");
    expect(never.dispatches).toBeUndefined();
    expect(fieldReading(never.dispatches)).toBe(ABSENT_FIELD);
    expect(passedOver[1]!.dispatches).toBe(1);
  });

  test("test: task state comes from the journal even when the compiled graph disagrees, so a recompiled graph can never show a parked task as green", () => {
    const source = syntheticSource("run-disagree.journal.jsonl", [
      { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-disagree", pid: 1 } },
      {
        ts: AT(1),
        event: "task-dispatch",
        taskId: "T1",
        data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
      },
      { ts: AT(2), event: "task-human", taskId: "T1", data: { kind: "ladder-exhausted" } },
      {
        ts: AT(3),
        event: "task-dispatch",
        taskId: "T2",
        data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
      },
      { ts: AT(4), event: "task-done", taskId: "T2", data: {} },
      { ts: AT(5), event: "run-end", data: { tipVerify: "passed" } },
    ]);
    // A recompile rewrote both statuses: the park reads green, the green reads
    // pending, and a task the journal never mentions claims to be done.
    const stale = graphOf(
      { id: "T1", title: "parked task", status: "done" },
      { id: "T2", title: "finished task", status: "pending" },
      { id: "T3", title: "never dispatched", status: "done" },
    );

    const rows = deriveRunCockpitData(source, "9.8.7", {
      graph: stale,
      isDaemonAlive: () => false,
    }).taskRows;

    const parked = rows.find((row) => row.taskId === "T1")!;
    expect(parked.state).toBe("human");
    expect(parked.state).not.toBe("done");
    expect(rows.find((row) => row.taskId === "T2")!.state).toBe("completed");
    // The graph's own claim is not a recorded state, so it reaches no row at all.
    const unrecorded = rows.find((row) => row.taskId === "T3")!;
    expect(unrecorded.state).toBeUndefined();
    expect(unrecorded.state).not.toBe("done");
    // The graph still supplied identity and title — only its state was ignored.
    expect(rows.map((row) => row.title)).toEqual([
      "parked task",
      "finished task",
      "never dispatched",
    ]);

    // The journal also wins over the run's own stopping. In the real approval
    // sequence the operator releases a parked task after the run has ended, so
    // the newest thing recorded about it is `task-approved` — pending, awaiting
    // a dispatch. A daemon that is gone must not repaint that as interrupted.
    const approvedAfterEnd = deriveRunCockpitData(
      syntheticSource("run-approved.journal.jsonl", [
        { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-approved", pid: 1 } },
        {
          ts: AT(1),
          event: "task-dispatch",
          taskId: "T1",
          data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
        },
        { ts: AT(2), event: "task-human", taskId: "T1", data: { kind: "ladder-exhausted" } },
        {
          ts: AT(3),
          event: "task-dispatch",
          taskId: "T2",
          data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
        },
        { ts: AT(4), event: "run-end", data: { tipVerify: "passed" } },
        { ts: AT(5), event: "task-approved", taskId: "T1", data: { by: "khalid" } },
      ]),
      "9.8.7",
      // The run has ended and its daemon is gone — the interruption every other
      // outcome-less task inherits.
      { graph: graphOf({ id: "T1" }, { id: "T2" }), isDaemonAlive: () => false },
    ).taskRows;

    const released = approvedAfterEnd.find((row) => row.taskId === "T1")!;
    expect(released.state).toBe("pending");
    expect(released.state).not.toBe("interrupted");
    // And the interruption still reaches the task the run really did cut short:
    // T2 was dispatched and no event ever recorded how it ended.
    expect(approvedAfterEnd.find((row) => row.taskId === "T2")!.state).toBe(
      "interrupted",
    );
  });

  test("test: selection follows the row's source identity across a refresh, and a refresh that removes the selected identity clears the selection honestly rather than selecting the row that inherited its index", () => {
    // The engagement as its journal recorded it, line by line: the identities
    // the rows carry are those source positions, so an appended event can
    // never renumber a row that was already written.
    const recorded = [
      { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-identity", pid: 1 } },
      {
        ts: AT(1),
        event: "task-dispatch",
        taskId: "T1",
        data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
      },
      { ts: AT(2), event: "gate-result", taskId: "T1", data: { gate: "test", pass: true, details: "older row" } },
      { ts: AT(3), event: "gate-result", taskId: "T1", data: { gate: "review", pass: false, details: "selected row" } },
      { ts: AT(4), event: "task-done", taskId: "T1", data: {} },
    ];
    const graph = graphOf({ id: "T1" }, { id: "T2" }, { id: "T3" });
    /** One refresh: the journal as it stands now, joined to the graph as it stands now. */
    const refresh = (
      events: readonly Parameters<typeof syntheticSource>[1][number][],
      compiled: CockpitGraph,
    ) =>
      deriveRunCockpitData(
        syntheticSource("run-identity.journal.jsonl", events),
        "9.8.7",
        { graph: compiled, isDaemonAlive: () => false },
      );

    const before = refresh(recorded, graph);
    const beforeGates = runViewRowIdentities(before, "gates");
    expect(beforeGates).toEqual(["gate:4", "gate:3"]);
    // The operator stands on the newest recorded gate result.
    const selected = beforeGates[0]!;
    const held = reconcileRunInteraction(
      { ...initialRunInteractionState(), activeView: "gates", selection: selected, opened: selected },
      beforeGates,
    );
    expect(held.selection).toBe(selected);

    // The engagement records two more events. The newer gate result is drawn
    // first, so the row the operator chose now sits at a different index — and
    // its identity, the line the engagement wrote it on, has not moved.
    const grownEvents = [
      ...recorded,
      {
        ts: AT(5),
        event: "task-dispatch",
        taskId: "T2",
        data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
      },
      { ts: AT(6), event: "gate-result", taskId: "T2", data: { gate: "build", pass: true, details: "newest row" } },
    ];
    const grown = refresh(grownEvents, graph);
    const grownGates = runViewRowIdentities(grown, "gates");
    expect(grownGates).toEqual(["gate:7", "gate:4", "gate:3"]);
    expect(grownGates.indexOf(selected)).toBe(1);

    const followed = reconcileRunInteraction(held, grownGates);
    expect(followed.selection).toBe(selected);
    expect(followed.opened).toBe(selected);
    // Not the row that inherited the index the selected row used to hold.
    expect(followed.selection).not.toBe(grownGates[0]);
    // And the row that identity names is still the gate result the engagement
    // recorded on that line — the details, verbatim.
    expect(grown.gateRows.find((row) => row.id === selected)?.details).toBe("selected row");

    // The tasks view's identities are the compiled graph's, and the same
    // refresh re-reads both: the rows carry what the journal recorded.
    const beforeTasks = runViewRowIdentities(grown, "tasks");
    expect(beforeTasks).toEqual(["task:T1", "task:T2", "task:T3"]);
    expect(grown.taskRows.find((row) => row.id === "task:T1")).toMatchObject({
      state: "completed",
      attempts: 1,
    });
    const onTask = reconcileRunInteraction(
      { ...held, activeView: "tasks", selection: "task:T2", opened: "task:T2" },
      beforeTasks,
    );
    expect(onTask.selection).toBe("task:T2");

    // A recompile between refreshes drops the selected task and adds another.
    // Some row still holds the index the selection stood on; it is not the row
    // the operator chose, so the selection is cleared rather than slid onto it.
    const recompiled = refresh(grownEvents, graphOf({ id: "T1" }, { id: "T3" }, { id: "T4" }));
    const afterTasks = runViewRowIdentities(recompiled, "tasks");
    expect(afterTasks).toEqual(["task:T1", "task:T3", "task:T4"]);
    expect(afterTasks).not.toContain("task:T2");
    const inheritor = afterTasks[beforeTasks.indexOf("task:T2")]!;
    expect(inheritor).toBe("task:T3");

    const cleared = reconcileRunInteraction(onTask, afterTasks);
    expect(cleared.selection).toBeNull();
    expect(cleared.selection).not.toBe(inheritor);
    // The row that was open is gone with it — a detail pane never survives
    // onto whoever took the place of the row it was showing.
    expect(cleared.opened).toBeNull();
    // The rows that did survive keep the identities they had, so the operator's
    // other bearings are untouched by the one that left.
    expect(reconcileRunInteraction(
      { ...onTask, selection: "task:T1", opened: null },
      afterTasks,
    ).selection).toBe("task:T1");
  });

  test("test: a field the engagement never recorded draws as absent rather than as an empty or false value", () => {
    const source = syntheticSource("run-absent.journal.jsonl", [
      { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-absent", pid: 1 } },
      // A gate result that recorded neither a verdict nor any details.
      { ts: AT(1), event: "gate-result", taskId: "T1", data: { gate: "review" } },
      {
        ts: AT(2),
        event: "failover-deviation",
        taskId: "T1",
        data: { site: "escalate", static: "claude-code:fable", chosen: "claude-code:fable" },
      },
      { ts: AT(3), event: "run-end", data: { tipVerify: "passed" } },
    ]);

    const data = deriveRunCockpitData(source, "9.8.7", {
      graph: graphOf({ id: "T1" }, { id: "T2" }),
      isDaemonAlive: () => false,
    });

    const untouched = data.taskRows.find((row) => row.taskId === "T2")!;
    for (
      const absent of [
        untouched.state,
        untouched.attempts,
        untouched.actor,
        untouched.lastEventTime,
        untouched.title,
      ]
    ) {
      expect(absent).toBeUndefined();
      expect(fieldReading(absent)).toBe(ABSENT_FIELD);
    }
    // Absent, not the empty string, not the zero that reads like a measurement,
    // and not the "pending" a row would be assuming rather than reporting.
    expect(untouched.attempts).not.toBe(0);
    expect(untouched.actor).not.toBe("");
    expect(untouched.state).not.toBe("pending");
    for (const field of ["state", "attempts", "actor"]) {
      expect(Object.hasOwn(untouched, field)).toBe(false);
    }

    const gate = data.gateRows[0]!;
    expect(gate.pass).toBeUndefined();
    expect(gate.pass).not.toBe(false);
    expect(gate.details).toBeUndefined();
    expect(gate.details).not.toBe("");
    expect(gate.state).toBe("neutral");
    expect(fieldReading(gate.details)).toBe(ABSENT_FIELD);

    const channel = data.fleetRows[0]!;
    expect(channel.dispatches).toBeUndefined();
    expect(channel.dispatches).not.toBe(0);
    expect(fieldReading(channel.dispatches)).toBe(ABSENT_FIELD);

    // The run's own stopping is not a recorded state either. T3 below is
    // mentioned — the engagement recorded a phase for it — but no event ever
    // recorded a state, and the daemon is gone. The row reports the silence.
    // T4, dispatched and never resolved, is the contrast: the journal did
    // record it running, so the vanished daemon makes that reading interrupted.
    const halted = deriveRunCockpitData(
      syntheticSource("run-halted.journal.jsonl", [
        { ts: AT(0), event: "run-start", data: { branch: "tickmarkr/run-halted", pid: 1 } },
        { ts: AT(1), event: "phase-start", taskId: "T3", data: { phase: "baseline" } },
        {
          ts: AT(2),
          event: "task-dispatch",
          taskId: "T4",
          data: { assignment: { adapter: "codex", model: "gpt-9" }, attempt: 0 },
        },
      ]),
      "9.8.7",
      { graph: graphOf({ id: "T3" }, { id: "T4" }), isDaemonAlive: () => false },
    ).taskRows;

    const mentioned = halted.find((row) => row.taskId === "T3")!;
    expect(mentioned.lastEventTime).toBe(reading(AT(1)));
    expect(mentioned.state).toBeUndefined();
    expect(mentioned.state).not.toBe("interrupted");
    expect(Object.hasOwn(mentioned, "state")).toBe(false);
    expect(fieldReading(mentioned.state)).toBe(ABSENT_FIELD);
    expect(halted.find((row) => row.taskId === "T4")!.state).toBe("interrupted");
  });
});
/**
 * The v1.84 engagement, entire: every one of the 375 lines the daemon wrote to
 * `.tickmarkr/runs/run-20260731-192921/journal.jsonl`, byte for byte — the
 * dispatches, parks, approvals and merges, and with them the phase, gate,
 * escalation, worker-result and tip-verify lines a hand-picked projection would
 * have dropped. Those lines are board states too — they move the gate rows, the
 * counts and the pass rate — so a replay that skips them replays something
 * other than the run.
 *
 * It rides gzipped and base64-wrapped for one reason: the capture is 150,897
 * bytes, this task's scope is this test and the module it tests, so it cannot
 * be a file beside the other committed captures, and 150KB of source literal is
 * more than the review gate's diff cap admits. The encoding hides nothing — the
 * replay test below pins the inflated bytes by length, by line count and by
 * SHA-256 against the values measured off the file itself, so a fixture edited
 * to suit the derivation fails before a single board is compared.
 */
const V184_GZIP_BASE64 = `
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
`;

const V184_RAW = gunzipSync(
  Buffer.from(V184_GZIP_BASE64.replace(/\s+/gu, ""), "base64"),
).toString("utf8");

/** What the capture is, measured off the file rather than off this test. */
const V184_BYTES = 150_897;
const V184_LINES = 375;
const V184_SHA256 =
  "09488cb72a398b35b43656024227b9ceebd9ea91e4de7438c9b4416bfa86cc2b";

const V184: RunCockpitSource = {
  fileName: "run-20260731-192921.journal.jsonl",
  raw: V184_RAW,
};

/** What the record itself says about one task, folded by hand. */
type FoldedTask = {
  state?: "done" | "failed" | "human" | "pending" | "running";
  merged: boolean;
  parkKind?: string;
};

type BoardState = "pass" | "fail" | "warn" | "active" | "neutral";

/**
 * The success forms the committed sources use, restated here beside the failure
 * forms above so the row checks are independent of the derivation under test.
 * `task-done` is not one of them: the record's word for a landing is `merge`,
 * and a completion the record never landed has nothing to put a check on.
 */
function recordsSuccess(event: CaptureEvent): boolean {
  return event.event === "merge"
    || event.data.pass === true
    || event.data.ok === true
    || (event.event === "run-end" && event.data.tipVerify === "passed");
}

/**
 * Every line of a source read the way the surface reads it: a line the capture
 * cannot be parsed out of is a defect, and everything else is an event carrying
 * the line number its row is identified by.
 */
function sourceLines(raw: string): {
  readonly events: readonly { readonly event: CaptureEvent; readonly line: number }[];
  readonly defects: readonly number[];
} {
  const events: { event: CaptureEvent; line: number }[] = [];
  const defects: number[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CaptureEvent;
      if (
        typeof parsed?.ts !== "string"
        || typeof parsed?.event !== "string"
        || typeof parsed?.data !== "object"
        || parsed.data === null
      ) {
        defects.push(index + 1);
        continue;
      }
      events.push({ event: parsed, line: index + 1 });
    } catch {
      defects.push(index + 1);
    }
  }
  return { events, defects };
}

/**
 * The journal folded against rules written here rather than imported, so the
 * derivation is judged by the record instead of by itself. An entry opens for
 * every task the record gives a fold — dispatched, phased, merged, given a
 * state, or named parked by a run-end summary — and only the events that move a
 * state move one.
 */
function foldJournal(events: readonly CaptureEvent[]): Map<string, FoldedTask> {
  const fold = new Map<string, FoldedTask>();
  const folded = (id: string): FoldedTask => {
    const existing = fold.get(id);
    if (existing) return existing;
    const created: FoldedTask = { merged: false };
    fold.set(id, created);
    return created;
  };
  // Keyed by a Map, because an event name is whatever the journal wrote: an
  // object would answer `constructor` and `toString` with something inherited
  // and truthy, and the fold would move on a line that transitions nothing.
  const states = new Map<string, FoldedTask["state"]>([
    ["task-dispatch", "running"],
    ["task-done", "done"],
    ["task-failed", "failed"],
    ["task-human", "human"],
    ["task-approved", "pending"],
  ]);
  for (const event of events) {
    if (event.event === "run-end") {
      const summaries: readonly (readonly [unknown, FoldedTask["state"]])[] = [
        [event.data.done, "done"],
        [event.data.human, "human"],
        [event.data.failed, "failed"],
      ];
      for (const [ids, state] of summaries) {
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id !== "string") continue;
          const task = folded(id);
          task.state = state;
          if (state !== "human") task.parkKind = undefined;
        }
      }
      continue;
    }
    if (event.taskId === undefined) continue;
    if (event.event === "merge") {
      const task = folded(event.taskId);
      task.merged = true;
      // Landing is a state and it retires the park it was released from.
      task.state = "done";
      task.parkKind = undefined;
      continue;
    }
    if (event.event === "phase-start") {
      folded(event.taskId);
      continue;
    }
    const state = states.get(event.event);
    if (state === undefined) continue;
    const task = folded(event.taskId);
    task.state = state;
    // The park kind belongs to the park: the next recorded state retires it.
    task.parkKind = event.event === "task-human" && typeof event.data.kind === "string"
      ? event.data.kind
      : undefined;
  }
  return fold;
}

/**
 * The parks the latest run-end names that no later event released. Release is
 * read forward from the summary and only forward: the summary describes the
 * moment the daemon exited, so a state the record wrote before it is history
 * the summary already accounts for, not an answer to it. A name nothing later
 * moved counts — including a name the record never mentions again, because the
 * run's own closing statement that it is waiting on someone is not corroborated
 * away by silence.
 */
function summaryParks(events: readonly CaptureEvent[]): string[] {
  let end = -1;
  for (const [index, event] of events.entries()) {
    if (event.event === "run-end") end = index;
  }
  if (end < 0) return [];
  const parked = Array.isArray(events[end]!.data.human) ? events[end]!.data.human : [];
  const released = new Map<string, boolean>();
  for (const later of events.slice(end + 1)) {
    if (later.taskId === undefined) continue;
    if (
      !["task-dispatch", "merge", "task-done", "task-failed", "task-human", "task-approved"]
        .includes(later.event)
    ) {
      continue;
    }
    released.set(later.taskId, later.event !== "task-human");
  }
  return (parked as unknown[]).filter((id): id is string =>
    typeof id === "string" && released.get(id) !== true
  );
}

/**
 * How a task's own fold reads when a row wears the task rather than an event:
 * only a landed task is a pass, a park is a warning and never a failure, and a
 * task the record left running in a run whose daemon is gone is interrupted.
 */
function foldedTaskState(task: FoldedTask | undefined): BoardState {
  if (task?.state === "done") return task.merged ? "pass" : "neutral";
  if (task?.state === "failed") return "fail";
  if (task?.state === "human") return "warn";
  if (task?.state === "running") return "warn";
  return "neutral";
}

/** How an event's own record reads, which is what a row naming that event wears. */
function foldedEventState(
  event: CaptureEvent,
  fold: ReadonlyMap<string, FoldedTask>,
): BoardState {
  if (event.event === "escalation" || event.event === "task-human") return "warn";
  if (recordsFailure(event)) return "fail";
  if (
    event.event === "run-end"
    && Array.isArray(event.data.human)
    && event.data.human.length > 0
  ) {
    return "warn";
  }
  // A completion is not a landing: the row waits, uncheckable, for the merge.
  if (event.event === "task-done") return "neutral";
  if (recordsSuccess(event)) return "pass";
  if (
    event.taskId !== undefined
    && fold.get(event.taskId)?.state === "running"
  ) {
    return "warn";
  }
  return "neutral";
}

/**
 * Every prefix of a source that still carries its run-start, oldest first. A
 * prefix is what the surface had on screen at that moment of the engagement, so
 * a fold that is only right at the end is not right.
 */
function prefixes(source: RunCockpitSource, stride = 1): RunCockpitSource[] {
  const lines = source.raw.trimEnd().split("\n");
  const start = lines.findIndex((line) => line.includes('"event":"run-start"'));
  expect(start, source.fileName).toBeGreaterThanOrEqual(0);
  const taken: RunCockpitSource[] = [];
  for (let end = start + 1; end <= lines.length; end += 1) {
    if (end !== lines.length && (end - start - 1) % stride !== 0) continue;
    taken.push({
      fileName: source.fileName,
      raw: `${lines.slice(0, end).join("\n")}\n`,
    });
  }
  return taken;
}

const derived = (source: RunCockpitSource) =>
  deriveRunCockpitData(source, "9.8.7", { isDaemonAlive: () => false });

/**
 * A journal written line by line, for the readings no committed capture holds:
 * a run-end declaring a park that no `task-human` line precedes, and the same
 * summary released — or not — by what the record writes after it.
 */
function journalOf(
  name: string,
  lines: readonly (readonly [string, string | undefined, Record<string, unknown>])[],
): RunCockpitSource {
  return {
    fileName: `run-${name}.journal.jsonl`,
    raw: `${
      lines.map(([event, taskId, data], index) =>
        JSON.stringify({
          ts: `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          event,
          ...(taskId === undefined ? {} : { taskId }),
          data,
        })
      ).join("\n")
    }\n`,
  };
}

const OPENED = ["run-start", undefined, { branch: "tickmarkr/park-window", pid: 1 }] as const;
const DISPATCHED = [
  "task-dispatch",
  "T1",
  { attempt: 0, assignment: { adapter: "fake", model: "fake" } },
] as const;
const ENDS_PARKED = [
  "run-end",
  undefined,
  { done: [], failed: [], human: ["T1"], tipVerify: "passed" },
] as const;

/**
 * The four journals that put a summary's park on each side of the events that
 * could answer it: none, one before, one after, and a landing after.
 */
const PARK_WINDOW_JOURNALS: readonly RunCockpitSource[] = [
  journalOf("dispatch-then-park", [OPENED, DISPATCHED, ENDS_PARKED]),
  journalOf("done-then-park", [OPENED, DISPATCHED, ["task-done", "T1", {}], ENDS_PARKED]),
  journalOf("approve-after-park", [
    OPENED,
    DISPATCHED,
    ENDS_PARKED,
    ["task-approved", "T1", {}],
  ]),
  journalOf("merge-after-park", [
    OPENED,
    DISPATCHED,
    ENDS_PARKED,
    ["task-done", "T1", {}],
    ["merge", "T1", { branch: "tickmarkr/park-window--T1", commit: "abc123" }],
  ]),
];

const DISPATCHED_T2 = [
  "task-dispatch",
  "T2",
  { attempt: 0, assignment: { adapter: "fake", model: "fake" } },
] as const;
const MIXED_PARKED_LINES = [
  OPENED,
  DISPATCHED,
  ["task-done", "T1", {}],
  DISPATCHED_T2,
  ["task-human", "T2", { kind: "gate-fail" }],
  ["run-end", undefined, { done: [], failed: [], human: ["T2"], tipVerify: "passed" }],
] as const;

/**
 * A parked board holding a task that finished and never landed — the reading no
 * committed capture carries, because the daemon appends `merge` in the same
 * breath as `task-done` and so a check-mark on the completion cannot be told
 * from one on the landing. And the same board with the landing, which is what
 * tells them apart.
 */
const MIXED_PARKED_JOURNAL = journalOf("mixed-parked", MIXED_PARKED_LINES);
const MERGED_MIXED_JOURNAL = journalOf("mixed-parked-landed", [
  ...MIXED_PARKED_LINES.slice(0, 3),
  ["merge", "T1", { branch: "tickmarkr/mixed--T1", commit: "abc123" }],
  ...MIXED_PARKED_LINES.slice(3),
]);

/** A landed T1 must not lend its check or identity to T2's newest failure. */
const OWNED_NEWEST_EVENT_JOURNAL = journalOf("owned-newest-event", [
  OPENED,
  DISPATCHED,
  ["merge", "T1", { branch: "tickmarkr/owned--T1", commit: "abc123" }],
  DISPATCHED_T2,
  ["task-failed", "T2", { reason: "the newest event failed" }],
]);

/** The closing summary is itself a journaled failure, even without task events. */
const SUMMARY_ONLY_FAILURE_JOURNAL = journalOf("summary-only-failure", [
  OPENED,
  [
    "run-end",
    undefined,
    { done: [], failed: ["T1"], human: [], tipVerify: "passed" },
  ],
]);

/**
 * A journal whose later lines name events no fold knows — named, deliberately,
 * after the properties every object inherits. A lookup keyed by an object
 * answers `constructor` and `toString` truthily, so under one these lines pass
 * for state transitions: they release the park the run-end declares and write a
 * function where a task state belongs. Event names are open strings; the daemon
 * gains new ones every version, and an operator may hold a journal a newer
 * binary wrote.
 */
const INHERITED_EVENT_NAMES = [
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "__proto__",
] as const;
const INHERITED_NAME_JOURNAL = journalOf("inherited-event-names", [
  OPENED,
  DISPATCHED,
  ENDS_PARKED,
  ...INHERITED_EVENT_NAMES.map((name) =>
    [name, "T1", {}] as readonly [string, string, Record<string, unknown>]
  ),
]);

/**
 * The whole board against the fold it summarizes — not a subset of it. The
 * run's word, every count and rate, every task row, every gate row and every
 * journal row is restated from the raw events here and compared, so a line the
 * capture carries cannot move the surface without moving this check too.
 */
function assertBoardMatchesFold(source: RunCockpitSource, label: string): void {
  const { events: lines, defects } = sourceLines(source.raw);
  const events = lines.map((line) => line.event);
  const data = derived(source);
  const fold = foldJournal(events);
  const tasks = [...fold.values()];
  const parked = tasks.filter((task) => task.state === "human");
  const failed = tasks.filter((task) => task.state === "failed");
  const done = tasks.filter((task) => task.state === "done");
  const outstanding = tasks.filter((task) =>
    task.state !== undefined && task.state !== "done"
  );

  // The run's word — owed to the parks the fold holds and to the parks the
  // latest run-end names and nothing since resolved.
  const summary = summaryParks(events);
  if (failed.length > 0) expect(data.status, label).toBe("failed");
  else if (parked.length > 0 || summary.length > 0) {
    expect(data.status, label).toBe("parked");
  }
  if (data.status === "parked") {
    expect(parked.length + summary.length, label).toBeGreaterThan(0);
  }
  if (data.status === "failed") expect(failed.length, label).toBeGreaterThan(0);
  if (data.status === "done") {
    expect(parked, label).toEqual([]);
    expect(failed, label).toEqual([]);
    expect(outstanding, label).toEqual([]);
    expect(summary, label).toEqual([]);
    expect(events.some((event) => event.event === "run-end"), label).toBe(true);
  }

  // Every count and rate the board shows, recomputed off the record.
  const gateEvents = events.filter((event) => event.event === "gate-result");
  const gatePasses = gateEvents.filter((event) => event.data.pass === true);
  const escalations = events.filter((event) => event.event === "escalation");
  expect(data.tasks.total, label).toBe(fold.size);
  expect(data.tasks.done, label).toBe(done.length);
  expect(data.progress, label).toBe(
    fold.size === 0 ? 0 : Math.round((done.length / fold.size) * 100),
  );
  expect(data.gates.total, label).toBe(gateEvents.length);
  expect(data.gates.passed, label).toBe(gatePasses.length);
  expect(data.passRate.value, label).toBe(
    gateEvents.length === 0
      ? 0
      : Math.round((gatePasses.length / gateEvents.length) * 100),
  );
  for (
    const item of [
      { state: "pass" as const, text: `done ${done.length}` },
      {
        state: failed.length > 0 ? "fail" as const : "neutral" as const,
        text: `failed ${failed.length}`,
      },
      {
        state: parked.length > 0 ? "warn" as const : "neutral" as const,
        text: `human ${parked.length}`,
      },
      {
        state: escalations.length > 0 ? "warn" as const : "neutral" as const,
        text: `escalated ${escalations.length}`,
      },
    ]
  ) {
    expect(data.statusItems, label).toContainEqual(item);
  }

  // The task rows: one per task the record folds or merely names, each wearing
  // only what the record gave it.
  //
  // A recorded state derives itself. The one reading the fold does not carry is
  // interruption: the journal recorded the task running and the daemon that
  // would have recorded its ending is gone, so a running task reads either way.
  const readings: Record<string, readonly (string | undefined)[]> = {
    done: ["done", "completed"],
    failed: ["failed"],
    human: ["human"],
    pending: ["pending"],
    running: ["running", "interrupted"],
  };
  const named = new Set(
    events.flatMap((event) => event.taskId === undefined ? [] : [event.taskId]),
  );
  expect(data.taskRows.map((row) => row.taskId).sort(), label).toEqual(
    [...new Set([...fold.keys(), ...named])].sort(),
  );
  for (const row of data.taskRows) {
    const task = fold.get(row.taskId);
    const where = `${label} ${row.taskId}`;
    if (task?.state === undefined) {
      expect(row.state, where).toBeUndefined();
    } else {
      expect(readings[task.state], where).toContain(row.state);
    }
    // The park kind stands only while its park does, and landing is its own
    // fact — a row reading `done` says nothing about whether it merged, so the
    // row carries the merge rather than leaving a consumer to assume it.
    expect(row.parkKind, where).toBe(task?.parkKind);
    expect(row.merged, where).toBe(task?.merged === true ? true : undefined);
    if (task?.merged === true) expect(row.parkKind, where).toBeUndefined();
    if (task?.state === "done") {
      expect(row.state, where).toBe(task.merged ? "done" : "completed");
    }
  }

  // The gate rows: one per recorded result, newest first, verbatim.
  const gateLines = lines
    .filter((line) => line.event.event === "gate-result")
    .reverse();
  expect(data.gateRows, label).toHaveLength(gateLines.length);
  for (const [index, { event, line }] of gateLines.entries()) {
    const row = data.gateRows[index]!;
    const where = `${label} gate:${line}`;
    const pass = typeof event.data.pass === "boolean" ? event.data.pass : undefined;
    expect(row.id, where).toBe(`gate:${line}`);
    expect(row.taskId, where).toBe(event.taskId);
    expect(row.pass, where).toBe(pass);
    expect(row.state, where).toBe(
      pass === true ? "pass" : pass === false ? "fail" : "neutral",
    );
    expect(row.gate, where).toBe(
      typeof event.data.gate === "string" ? event.data.gate : undefined,
    );
    expect(row.details, where).toBe(
      typeof event.data.details === "string" ? event.data.details : undefined,
    );
  }

  // The journal rows: one per line the source carries, defects first and the
  // rest newest first, each wearing what its own event recorded.
  expect(data.journalRows, label).toHaveLength(lines.length + defects.length);
  const history = data.journalRows.slice(defects.length);
  expect(history.map((row) => row.id), label).toEqual(
    [...lines].reverse().map(({ line }) => `event:${line}`),
  );
  for (const [index, row] of history.entries()) {
    const event = lines[lines.length - 1 - index]!.event;
    // A task-owned newest event keeps that task's identity and its own outcome.
    // Only the taskless run-end borrows spotlight context, and its state remains
    // the independently folded run state rather than the borrowed task's state.
    const displayed = index === 0
      ? /^(\S+) attempt /u.exec(row.text)?.[1]
      : undefined;
    if (index === 0 && event.taskId !== undefined) {
      expect(displayed, `${label} ${row.id}`).toBe(event.taskId);
    }
    const expected = index === 0 && event.event === "run-end"
      ? failed.length > 0
        ? "fail"
        : parked.length > 0 || summary.length > 0
          ? "warn"
          : data.status === "done" && displayed !== undefined
            ? foldedTaskState(fold.get(displayed))
            : data.status === "done"
              ? "pass"
              : data.status === "interrupted"
                ? "warn"
                : "neutral"
      : foldedEventState(event, fold);
    expect(row.state, `${label} ${row.id}`).toBe(expected);
    if (row.state === "pass" && displayed !== undefined && event.taskId === undefined) {
      expect(fold.get(displayed)?.merged, `${label} ${displayed}`).toBe(true);
    }
  }

  // The fleet rows: a channel carries the dispatches the record counted for it,
  // and nothing at all when the record never dispatched to it.
  const dispatched = new Map<string, number>();
  for (const event of events) {
    if (event.event !== "task-dispatch") continue;
    const assignment = event.data.assignment as
      | { adapter?: unknown; model?: unknown }
      | undefined;
    if (
      typeof assignment?.adapter !== "string"
      || typeof assignment.model !== "string"
    ) {
      continue;
    }
    const key = `${assignment.adapter}:${assignment.model}`;
    dispatched.set(key, (dispatched.get(key) ?? 0) + 1);
  }
  for (const row of data.fleetRows) {
    expect(row.dispatches, `${label} ${row.id}`).toBe(
      dispatched.get(`${row.adapter}:${row.model}`),
    );
  }
}

describe("the folds tell the truth", () => {
  test("test: a run-end with human tasks derives parked and no task in it derives done-with-a-check unless merged", () => {
    const boards = prefixes(V184).filter((prefix) =>
      sourceEvents(prefix.raw).at(-1)?.event === "run-end"
    );
    // The engagement journaled six run-ends; four of them report human tasks.
    const withHuman = boards.filter((prefix) => {
      const end = sourceEvents(prefix.raw).at(-1)!;
      return Array.isArray(end.data.human) && end.data.human.length > 0;
    });
    expect(withHuman.length).toBeGreaterThan(0);

    for (const prefix of withHuman) {
      const events = sourceEvents(prefix.raw);
      const end = events.at(-1)!;
      const label = `${end.ts} ${JSON.stringify(end.data.human)}`;
      const data = derived(prefix);
      const fold = foldJournal(events);

      // The run-end names human tasks, so the run is parked — not done, and not
      // the interruption of a daemon that exited exactly as a park asks it to.
      expect(data.status, label).toBe("parked");
      expect(data.status, label).not.toBe("done");
      for (const taskId of end.data.human as string[]) {
        expect(fold.get(taskId)?.state, label).toBe("human");
        expect(data.taskRows.find((row) => row.taskId === taskId)?.state, label)
          .toBe("human");
      }

      // No row in that board wears a check-mark for a task the journal never
      // recorded merged — the ✓ pass done OBS-252 caught stood on the task that
      // had failed review one second earlier.
      const newest = data.journalRows[0]!;
      const named = /^(\S+) attempt /u.exec(newest.text)?.[1];
      if (newest.state === "pass") {
        expect(named, label).toBeDefined();
        expect(fold.get(named!)?.merged, label).toBe(true);
        expect(fold.get(named!)?.state, label).toBe("done");
      }
      // Every other row that reports a task finishing or landing is checked by
      // the landing alone: a completion carries the word, the merge carries the
      // mark. (The newest row is the borrowed one, judged above.)
      const completions = sourceEventLines(prefix.raw).filter(({ event }) =>
        event.event === "task-done" || event.event === "merge"
      );
      for (const { event, line } of completions) {
        const row = data.journalRows.find((item) => item.id === `event:${line}`)!;
        if (row.id === newest.id) continue;
        const where = `${label} ${row.text}`;
        expect(row.state === "pass", where).toBe(event.event === "merge");
        if (row.state === "pass") {
          expect(fold.get(event.taskId!)?.merged, where).toBe(true);
        }
      }
      // And the row carries the landing as its own fact, so a consumer drawing
      // a check has the record that earns one rather than reading `done` as if
      // it were both. In this engagement the daemon merged in the same breath
      // as it finished, so every done task here landed — the board that pulls
      // those two records apart is written below.
      for (const row of data.taskRows) {
        expect(row.merged, `${label} ${row.taskId}`).toBe(
          fold.get(row.taskId)?.merged === true ? true : undefined,
        );
        if (row.state === "done") {
          expect(row.merged, `${label} ${row.taskId}`).toBe(true);
        }
      }
    }

    // The board this engagement never held: parked on one task while another
    // finished and never landed. The daemon writes `merge` in the same breath
    // as `task-done`, so in every capture a completion is a landing too and a
    // check-mark handed to the completion is indistinguishable from one handed
    // to the landing. Pull them apart and the difference is the whole law.
    const mixed = derived(MIXED_PARKED_JOURNAL);
    expect(mixed.status).toBe("parked");
    expect(mixed.status).not.toBe("done");
    const finished = mixed.taskRows.find((row) => row.taskId === "T1")!;
    expect(finished.state).toBe("completed");
    expect(finished.merged).toBeUndefined();
    expect(mixed.taskRows.find((row) => row.taskId === "T2")?.state).toBe("human");

    // This is the production Tasks-view projection, not an intermediate fact:
    // an unmerged completion stays neutral where the check glyph is chosen.
    const finishedView = deriveRunViewRows(mixed, "tasks")
      .find((row) => row.id === "task:T1")!;
    expect(finishedView.state).toBe("neutral");
    expect(finishedView.state).not.toBe("pass");

    // Its completion row says done and carries no check, because no merge is
    // recorded anywhere in the board.
    const completion = mixed.journalRows.find((row) =>
      row.text.includes("task-done")
    )!;
    expect(completion.text).toContain("T1");
    expect(completion.text).toMatch(/\bdone\b/u);
    expect(completion.state).toBe("neutral");
    expect(completion.state).not.toBe("pass");
    expect(mixed.journalRows.filter((row) => row.state === "pass")).toEqual([]);

    // The defect, restated as the rule it applied: a completion is a success on
    // its own account. Under it that row is a check on work no merge landed.
    const underCompletionIsSuccess = (event: CaptureEvent): BoardState =>
      event.event === "task-done" ? "pass" : "neutral";
    const doneEvent = sourceEvents(MIXED_PARKED_JOURNAL.raw)
      .find((event) => event.event === "task-done")!;
    expect(underCompletionIsSuccess(doneEvent)).toBe("pass");
    expect(completion.state).not.toBe(underCompletionIsSuccess(doneEvent));

    // And the landing is what lifts it: the same journal with the merge the
    // daemon would have written checks the row and lands the task.
    const landed = derived(MERGED_MIXED_JOURNAL);
    expect(landed.taskRows.find((row) => row.taskId === "T1")?.merged).toBe(true);
    expect(
      landed.journalRows.find((row) => row.text.includes("merge"))?.state,
    ).toBe("pass");
    expect(landed.status).toBe("parked");

    // A park is released only by an event that moved the task, and an event the
    // fold does not know moved nothing — however familiar its name looks to an
    // object. Under a lookup keyed by one, `constructor` reads as a transition:
    // it retires the park the run-end declares and writes a function where a
    // task state belongs, and the parked run reads interrupted.
    const inherited = derived(INHERITED_NAME_JOURNAL);
    expect(sourceEvents(INHERITED_NAME_JOURNAL.raw).map((event) => event.event))
      .toEqual(expect.arrayContaining([...INHERITED_EVENT_NAMES]));
    expect(inherited.status).toBe("parked");
    expect(inherited.status).not.toBe("interrupted");
    expect(inherited.status).not.toBe("done");
    // Nor do those lines write a state: the row keeps the human state the
    // run-end itself recorded, and every row's state is one of the states there
    // are.
    for (const row of inherited.taskRows) {
      expect(
        ["done", "failed", "human", "pending", "running", "interrupted", undefined],
        row.taskId,
      ).toContain(row.state);
    }
    expect(inherited.taskRows.find((row) => row.taskId === "T1")?.state)
      .toBe("human");

    // The defect, restated as the rule it applied: an event names a transition
    // when the lookup answers for its name. An object answers for all of these.
    for (const name of INHERITED_EVENT_NAMES) {
      expect(({} as Record<string, unknown>)[name]).toBeDefined();
    }

    // The summary is read on its own account, not because a task line happened
    // to precede it: a run whose only record of a park is the run-end's own
    // `human` list still derives parked. The summary is a journal event in its
    // own right, so the task it names is drawn and counted from that event.
    const summaryOnlyRaw = [
      JSON.stringify({
        ts: "2026-08-01T00:00:00.000Z",
        event: "run-start",
        data: { branch: "tickmarkr/run-summary-only", pid: 1 },
      }),
      JSON.stringify({
        ts: "2026-08-01T00:00:01.000Z",
        event: "run-end",
        data: { done: [], failed: [], human: ["T1"], tipVerify: "passed" },
      }),
      "",
    ].join("\n");
    const summaryOnly = derived({
      fileName: "run-summary-only.journal.jsonl",
      raw: summaryOnlyRaw,
    });
    expect(summaryOnly.status).toBe("parked");
    expect(summaryOnly.status).not.toBe("done");
    expect(summaryOnly.taskRows).toContainEqual(
      expect.objectContaining({ taskId: "T1", state: "human" }),
    );
    expect(summaryOnly.tasks.total).toBe(1);
    // And the reverse, which is the same law: a run-end that names nobody in
    // `human` is not held back from `done` by a park it never recorded.
    const summaryClear = derived({
      fileName: "run-summary-clear.journal.jsonl",
      raw: summaryOnlyRaw.replace('"human":["T1"]', '"human":[]'),
    });
    expect(summaryClear.status).toBe("done");

    // And the park the summary declares is released only by what comes after
    // it. The summary describes the moment the daemon exited, so a state the
    // record wrote *before* it is history the summary already accounts for —
    // weighing the whole-journal fold against the summary let the line directly
    // above it retire the park the summary itself declares.
    const [
      dispatchThenParkSource,
      doneThenParkSource,
      approveAfterParkSource,
      mergeAfterParkSource,
    ] = PARK_WINDOW_JOURNALS;

    // A dispatch and then the summary, with no `task-human` line anywhere: the
    // run is parked, not the interruption of a daemon that exited exactly as
    // the park it declares asks it to.
    const dispatchThenPark = derived(dispatchThenParkSource!);
    expect(dispatchThenPark.status).toBe("parked");
    expect(dispatchThenPark.status).not.toBe("interrupted");
    expect(dispatchThenPark.status).not.toBe("done");
    // The closing summary supersedes that dispatch with its own recorded human
    // state rather than leaving the task interrupted.
    expect(dispatchThenPark.taskRows.map((row) => row.taskId)).toEqual(["T1"]);
    expect(dispatchThenPark.taskRows[0]!.state).toBe("human");

    // A completion recorded before the summary does not answer it either.
    const doneThenPark = derived(doneThenParkSource!);
    expect(doneThenPark.status).toBe("parked");
    expect(doneThenPark.status).not.toBe("done");

    // Forward, release works: the operator approves after the summary and the
    // run is no longer waiting on anyone — and a task that lands after it is
    // released by its landing.
    const approvedAfterPark = derived(approveAfterParkSource!);
    expect(approvedAfterPark.status).not.toBe("parked");
    const landedAfterPark = derived(mergeAfterParkSource!);
    expect(landedAfterPark.status).toBe("done");

    // The defect, restated as the rule it applied: read the park against the
    // whole journal's fold. Under it the two journals above read the state of
    // the line before the summary rather than the summary's own word.
    expect([dispatchThenPark.status, doneThenPark.status])
      .not.toEqual(["interrupted", "done"]);

    // The defect, restated as the rule it applied: a run-end ends the run, so
    // the run is done. Under it every one of these boards reads done.
    const underLifecycleOnlyRule = withHuman.map(() => "done");
    expect(underLifecycleOnlyRule).not.toEqual(
      withHuman.map((prefix) => derived(prefix).status),
    );
  });

  test("test: a merged task's derived row carries no park kind from its history", () => {
    const events = sourceEvents(V184.raw);
    // T1 parked twice, each time with a recorded kind, before it merged.
    const parks = events.filter((event) =>
      event.event === "task-human" && event.taskId === "T1"
    );
    expect(parks.length).toBeGreaterThan(1);
    expect(new Set(parks.map((event) => event.data.kind))).toEqual(
      new Set(["gate-fail"]),
    );
    expect(
      events.some((event) => event.event === "merge" && event.taskId === "T1"),
    ).toBe(true);

    const row = derived(V184).taskRows.find((item) => item.taskId === "T1")!;
    expect(row.state).toBe("done");
    expect(row.merged).toBe(true);
    expect(row.parkKind).toBeUndefined();
    expect(row.parkKind).not.toBe("gate-fail");
    expect(Object.hasOwn(row, "parkKind")).toBe(false);

    // And nowhere in the engagement: at no moment does a merged task's row wear
    // a kind, however many parks its history holds.
    let merged = 0;
    for (const prefix of prefixes(V184)) {
      const fold = foldJournal(sourceEvents(prefix.raw));
      for (const item of derived(prefix).taskRows) {
        if (fold.get(item.taskId)?.merged !== true) continue;
        merged += 1;
        expect(item.parkKind, `${prefix.raw.length} ${item.taskId}`)
          .toBeUndefined();
      }
    }
    expect(merged).toBeGreaterThan(0);

    // The merge retires the park itself rather than relying on the task-done
    // that happens to precede it in this capture: a park merged straight out of
    // its park keeps neither the kind nor the parked state.
    const straight = derived({
      fileName: "run-park-then-merge.journal.jsonl",
      raw: [
        JSON.stringify({
          ts: "2026-08-01T00:00:00.000Z",
          event: "run-start",
          data: { branch: "tickmarkr/run-park-then-merge", pid: 1 },
        }),
        JSON.stringify({
          ts: "2026-08-01T00:00:01.000Z",
          event: "task-human",
          taskId: "T1",
          data: { kind: "gate-fail", reason: "review round cap (2) reached" },
        }),
        JSON.stringify({
          ts: "2026-08-01T00:00:02.000Z",
          event: "merge",
          taskId: "T1",
          data: { branch: "tickmarkr/run-park-then-merge--T1", commit: "abc123" },
        }),
        "",
      ].join("\n"),
    });
    const landed = straight.taskRows.find((item) => item.taskId === "T1")!;
    expect(landed.parkKind).toBeUndefined();
    expect(landed.state).toBe("done");
    expect(landed.merged).toBe(true);
    expect(straight.status).not.toBe("parked");

    // The defect, restated: keep the newest recorded kind for the task. Under
    // that rule T1's row wears the park it was released from hours earlier.
    const lastKind = parks.at(-1)!.data.kind;
    expect(lastKind).toBe("gate-fail");
    expect(row.parkKind).not.toBe(lastKind);
  });

  test("test: a parked task derives parked and never failed", () => {
    // The board as it stood at the first run-end: T1 parked at a review round
    // cap, nothing failed, nothing done.
    const upToFirstEnd = prefixes(V184).find((prefix) =>
      sourceEvents(prefix.raw).at(-1)?.event === "run-end"
    )!;
    const events = sourceEvents(upToFirstEnd.raw);
    expect(events.some((event) => event.event === "task-failed")).toBe(false);
    expect(events.some((event) => event.event === "task-done")).toBe(false);

    const data = derived(upToFirstEnd);
    expect(data.status).toBe("parked");
    expect(data.status).not.toBe("failed");
    expect(data.status).not.toBe("done");

    const row = data.taskRows.find((item) => item.taskId === "T1")!;
    expect(row.state).toBe("human");
    expect(row.state).not.toBe("failed");
    expect(row.parkKind).toBe("gate-fail");
    expect(row.merged).toBeUndefined();

    // The park's own row says so, in the warning state, and no row in the board
    // reports a failure the journal never recorded.
    const park = data.journalRows.find((item) => item.text.includes("parked"))!;
    expect(park.state).toBe("warn");
    expect(park.state).not.toBe("fail");
    expect(data.statusItems).toContainEqual({ state: "warn", text: "human 1" });
    for (const item of data.journalRows.filter((entry) => entry.state === "fail")) {
      const line = Number(item.id.replace("event:", ""));
      expect(recordsFailure(sourceEvents(upToFirstEnd.raw)[line - 1]!), item.text)
        .toBe(true);
    }

    // A park is not a failure even beside one: when the resumed attempt later
    // fails, the run owes a fix and says failed — and the park that preceded it
    // is gone from the row rather than folded into the failure.
    const afterFailure = prefixes(V184).find((prefix) =>
      sourceEvents(prefix.raw).at(-1)?.event === "task-failed"
    )!;
    const failedBoard = derived(afterFailure);
    expect(failedBoard.status).toBe("failed");
    expect(failedBoard.taskRows.find((item) => item.taskId === "T1")?.state)
      .toBe("failed");
    expect(failedBoard.taskRows.find((item) => item.taskId === "T1")?.parkKind)
      .toBeUndefined();
  });

  test("test: replaying the v1.84 fixture journal derives a board matching its raw event fold at every prefix", () => {
    // The fixture is the capture: the daemon's own bytes, not a projection of
    // them. Length, line count and digest are the file's, measured off it.
    expect(Buffer.byteLength(V184_RAW, "utf8")).toBe(V184_BYTES);
    expect(V184_RAW.trimEnd().split("\n")).toHaveLength(V184_LINES);
    expect(createHash("sha256").update(V184_RAW, "utf8").digest("hex"))
      .toBe(V184_SHA256);
    // Including the lines a hand-picked projection would have dropped, which
    // are exactly the ones that move the gate rows, the counts and the rate.
    const kinds = new Set(sourceEvents(V184_RAW).map((event) => event.event));
    for (
      const kind of [
        "run-start",
        "run-resume",
        "run-end",
        "phase-start",
        "gate-result",
        "escalation",
        "worker-result",
        "tip-verify",
        "task-dispatch",
        "task-human",
        "task-approved",
        "task-failed",
        "task-done",
        "merge",
      ]
    ) {
      expect(kinds, kind).toContain(kind);
    }

    const replayed = prefixes(V184);
    // Every line of the capture is replayed, not a sampled few.
    expect(replayed).toHaveLength(V184_LINES);

    const seen = new Set<string>();
    for (const prefix of replayed) {
      const events = sourceEvents(prefix.raw);
      assertBoardMatchesFold(prefix, `${prefix.fileName}@${events.length}`);
      seen.add(derived(prefix).status);
    }

    // The replay actually walks the states this bundle mis-rendered: a parked
    // run, a failed one, an interrupted one and a finished one.
    expect(seen).toEqual(new Set(["parked", "failed", "interrupted", "done"]));
    expect(derived(replayed.at(-1)!).status).toBe("done");

    // Line 140 is T2's dispatch immediately after T1 merged. Its row belongs
    // to T2 and carries the dispatch's interrupted reading after the daemon is
    // observed gone; T1's spotlight check cannot replace either fact.
    const atLine140 = replayed.find((prefix) =>
      sourceEventLines(prefix.raw).at(-1)?.line === 140
    )!;
    const line140 = sourceEventLines(atLine140.raw).at(-1)!;
    expect(line140.event.event).toBe("task-dispatch");
    expect(line140.event.taskId).toBe("T2");
    const line140Row = derived(atLine140).journalRows[0]!;
    expect(line140Row.id).toBe("event:140");
    expect(line140Row.text).toContain("T2 attempt 1 claude-code:opus");
    expect(line140Row.text).not.toContain("T1 attempt");
    expect(line140Row.state).toBe("warn");
    expect(line140Row.state).not.toBe("pass");

    // Failure is the discriminating outcome: a landed spotlight task cannot
    // repaint another task's newest failure as its own pass.
    const failedNewest = derived(OWNED_NEWEST_EVENT_JOURNAL).journalRows[0]!;
    expect(failedNewest.text).toContain("T2 attempt 1 fake:fake");
    expect(failedNewest.text).not.toContain("T1 attempt");
    expect(failedNewest.state).toBe("fail");
  });

  test("no derived status contradicts the journal fold it summarizes", () => {
    const corpus = [
      V184,
      capture("run-20260724-231138.journal.jsonl"),
      capture("run-20260724-194619.journal.jsonl"),
      capture("run-20260725-025004.interrupted.journal.jsonl"),
    ];
    for (const source of corpus) {
      const walked = prefixes(source, 5);
      expect(walked.length).toBeGreaterThan(1);
      for (const prefix of walked) {
        assertBoardMatchesFold(
          prefix,
          `${source.fileName}@${sourceEvents(prefix.raw).length}`,
        );
      }
    }

    // The captures are internally consistent — every summary park has its
    // `task-human` line directly above it, every completion its merge, every
    // event a name the fold knows — so they cannot judge the readings that
    // contradict them. These journals can: a park declared with no park line at
    // all, one after a completion, one released by what follows, a finish that
    // never landed, and lines named after what every object inherits. The board
    // and the fold agree on all of them, at every prefix.
    for (
      const source of [
        ...PARK_WINDOW_JOURNALS,
        MIXED_PARKED_JOURNAL,
        MERGED_MIXED_JOURNAL,
        INHERITED_NAME_JOURNAL,
      ]
    ) {
      for (const prefix of prefixes(source)) {
        assertBoardMatchesFold(
          prefix,
          `${source.fileName}@${sourceEvents(prefix.raw).length}`,
        );
      }
    }

    // The defect this closes, restated as the rule it applied: the run's word
    // comes from its lifecycle alone. On the capture that produced OBS-252 that
    // rule reads done while the record holds a parked task and nothing done.
    const parkedBoard = prefixes(V184).find((prefix) =>
      sourceEvents(prefix.raw).at(-1)?.event === "run-end"
    )!;
    const fold = foldJournal(sourceEvents(parkedBoard.raw));
    expect([...fold.values()].some((task) => task.state === "human")).toBe(true);
    expect([...fold.values()].every((task) => task.state !== "done")).toBe(true);
    expect(derived(parkedBoard).status).not.toBe("done");

    // A run-end's failed list is a journaled task outcome in its own right.
    // It must drive the run word, count, task row and newest event row even
    // when no preceding task-failed line exists to make the fixture convenient.
    const summaryFailure = derived(SUMMARY_ONLY_FAILURE_JOURNAL);
    expect(summaryFailure.status).toBe("failed");
    expect(summaryFailure.tasks).toMatchObject({ done: 0, total: 1 });
    expect(summaryFailure.statusItems).toContainEqual({
      state: "fail",
      text: "failed 1",
    });
    expect(summaryFailure.taskRows).toContainEqual(
      expect.objectContaining({ taskId: "T1", state: "failed" }),
    );
    expect(summaryFailure.journalRows[0]).toMatchObject({
      id: "event:2",
      state: "fail",
    });
  });
});
