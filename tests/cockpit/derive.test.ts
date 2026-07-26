import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import type { CaptureEvent, DemoJournalCapture } from "../../src/tui/cockpit/demo.js";
import {
  selectSparklineBucketWidthMs,
  SPARKLINE_BUCKET_WINDOW,
} from "../../src/tui/cockpit/derive.js";
import {
  deriveRunCockpitData,
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
    || (event.event === "run-end" && event.data.tipVerify === "failed");
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

    expect(data.tasks).toMatchObject({ done: done.size, total: dispatched.size });
    expect(data.gates).toMatchObject({ passed, total: gates.length });
    expect(data.passRate.value).toBe(rate);
    expect(data.progress).toBe(Math.round((done.size / dispatched.size) * 100));
    expect(frame).toContain(`${done.size}/${dispatched.size}`);
    expect(frame).toContain(`${passed}/${gates.length}`);
    expect(frame).toContain(`${rate}%`);
    expect(frame).not.toContain("999");
    expect(frame).not.toContain("SUMMARY-LIE");
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

  test("test: the tip verification state is derived from both of its sources in the capture, and renders as failed when the two disagree", () => {
    const source = capture("run-20260724-194619.journal.jsonl");
    const eventFailureOnly = {
      ...source,
      raw: source.raw.replaceAll('"tipVerify":"failed"', '"tipVerify":"passed"'),
    };
    const endFailureOnly = {
      ...source,
      raw: source.raw.replace(
        /"event":"tip-verify-failed","data":\{[^]*?\}\}\n/,
        '"event":"tip-verify","data":{"gate":"test","pass":true}}\n',
      ),
    };

    const fromEvent = deriveRunCockpitData(eventFailureOnly, "9.8.7");
    const fromEnd = deriveRunCockpitData(endFailureOnly, "9.8.7");

    expect(fromEvent.statusItems[0]).toEqual({
      state: "fail",
      text: "tip-verify FAILED",
    });
    expect(fromEnd.statusItems[0]).toEqual({
      state: "fail",
      text: "tip-verify FAILED",
    });
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
    // the tasks those events belong to really did finish successfully
    const doneLines = events.filter(({ event }) =>
      event.event === "task-done"
      && event.taskId !== undefined
      && failedOutcomes.some((failed) => failed.event.taskId === event.taskId)
    );
    expect(doneLines.length).toBeGreaterThan(0);
    for (const { line } of doneLines) {
      expect(rows.get(`event:${line}`)?.state).toBe("pass");
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
    const stateWords: Record<string, RegExp> = {
      pass: /\bpass\b/,
      fail: /\bfail\b/,
      warn: /\bwarn\b|\binterrupted\b/,
      neutral: /\bneutral\b/,
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
