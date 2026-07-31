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
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import { PLAIN_COMPACT_LOCKUP } from "../../src/brand.js";
import { ui } from "../../src/cli/commands/ui.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { runViewRowIdentities } from "../../src/tui/cockpit/derive.js";
import {
  deriveLiveRunCockpitData,
  loadEngagementSource,
  runLiveCockpit,
  selectEngagementRunId,
  type LiveCockpitDelivery,
} from "../../src/tui/cockpit/live.js";
import {
  assertFrameConformance,
  planRunCockpitFrame,
  RunCockpitFrame,
  RunCockpitFrameFromPlan,
  type PlannedRunCockpitFrame,
  type RunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";
import {
  FRAME_CONTRACT_DOMAIN,
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

async function frameFor(raw: string, now?: () => number): Promise<string> {
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
    data: deriveLiveRunCockpitData(
      { fileName: "run-live-test.journal.jsonl", raw },
      "9.8.7",
      now,
    ),
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
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  input.isTTY = true;
  input.setRawMode = (mode) => {
    raw = mode;
  };
  input.ref = () => input as unknown as NodeJS.ReadStream;
  input.unref = () => input as unknown as NodeJS.ReadStream;

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

/** Move one planned row from the body band into the header band, internally tiled. */
function redistributedSpans(plan: PlannedFrame): PlannedFrame {
  if (plan.kind !== "frame") throw new Error("expected a frame plan");
  const rowSpans = {
    ...plan.rowSpans,
    header: plan.rowSpans.header! + 1,
    body: plan.rowSpans.body! - 1,
  };
  const bands = new Map<string, { row: number; rows: number }>();
  let row = 0;
  for (const [id, span] of Object.entries(rowSpans)) {
    bands.set(id, { row, rows: span });
    row += span;
  }
  const body = bands.get("body")!;
  const header = bands.get("header")!;
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

describe("run cockpit draw-time frame plan", () => {
  test("test: every planned region is drawn at its planned offset and span, at every size in the contract domain", async () => {
    for (
      let columns = FRAME_CONTRACT_DOMAIN.minColumns;
      columns <= FRAME_CONTRACT_DOMAIN.maxColumns;
      columns += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (
        let rows = FRAME_CONTRACT_DOMAIN.minRows;
        rows <= FRAME_CONTRACT_DOMAIN.maxRows;
        rows += 1
      ) {
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
    }
  }, Number(process.env.TICKMARKR_SWEEP_TIMEOUT_MS ?? 240_000));

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
        `${data.runId} · ${data.branch} · ${data.status} · ${data.elapsed}`;
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
        expect(band.row, `${at} ${id} offset`).toBe(tiled);
        expect(band.rows, `${at} ${id} span`).toBe(span);
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

    expect(frame).toContain("VIEWS");
    expect(frame).toContain("RUN");
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
    expect(frame).toContain("spec/branch-no-capture-owns");
    expect(frame).toContain("noprovider:model-zero");
    expect(frame).not.toContain(COMMITTED_CAPTURE_ID);

    io.input.write("q");
    await done;
  });

  test("test: when no engagement can be read the command refuses with a message and a non-zero status rather than drawing an empty surface", async () => {
    const repo = mkRepo(); // no .tickmarkr at all
    const io = makeInkStreams();

    const result = await ui([], { input: io.input, output: io.output }, repo);

    expect(result).toMatchObject({ code: 1 });
    expect((result as { out: string }).out).toContain("no engagement");
    expect(io.writes.join("")).toBe("");
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
    expect(bareFrame).toContain("spec/newer");
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
    expect(explicitFrame).toContain("spec/older");
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

      // ── The same reconciliation over the tasks view's graph-backed rows ─────
      // Selecting the middle row — index 1, identity task:T2.
      delivery.key({ input: "2", key: {} });
      delivery.key({ input: "", key: { downArrow: true } });
      delivery.key({ input: "", key: { downArrow: true } });
      expect(delivery.snapshot().interaction.activeView).toBe("tasks");
      expect(delivery.snapshot().interaction.selection).toBe("task:T2");

      // A recompile prepends a task: every index shifts, the identity does not.
      seedGraph(repo, ["T0", "T1", "T2", "T3"]);
      expect(delivery.refresh()).toBe(true);
      const prepended = delivery.snapshot();
      expect(prepended.data.taskRows.map((row) => row.id)).toEqual([
        "task:T0",
        "task:T1",
        "task:T2",
        "task:T3",
      ]);
      expect(identities("tasks").indexOf("task:T2")).toBe(2);
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
