import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import chalk from "chalk";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import type { JournalEvent } from "../../src/run/journal.js";
import {
  deriveLiveRunCockpitData,
  liveRunPointerSurface,
  runLiveCockpit,
  type LiveCockpitDelivery,
} from "../../src/tui/cockpit/live.js";
import {
  dispatchRunKey,
  openingRunInteractionState,
  projectRunKeyEntries,
  resolveRunKeyBinding,
  runFocusedPanel,
  runPanelFocusOrder,
  RUN_INPUT_BINDINGS,
  type RunInteractionState,
  type RunKeyEvent,
} from "../../src/tui/cockpit/keys.js";
import {
  captureCockpitOutput,
  captureRendererOutput,
} from "../../src/tui/cockpit/capture.js";
import {
  FRAME_VIEWS,
  planFrame,
  RAIL_COLUMNS,
  RAIL_READABLE_FLOOR_COLUMNS,
  type FrameRegion,
  type PlannedFrame,
} from "../../src/tui/cockpit/layout.js";
import {
  applyPointerReport,
  borrowPointerTracking,
  createPointerReportReader,
  parsePointerReports,
  plannedKeyColumns,
  pointerRestingCell,
  pointerRowAt,
  POINTER_TRACKING_OFF,
  POINTER_TRACKING_ON,
  resetSessionRailOverride,
  resolvePointerTarget,
  sessionRailOverride,
  type PointerReport,
  type PointerSurface,
  type PointerTrackingHost,
} from "../../src/tui/cockpit/pointer.js";
import {
  assertFrameConformance,
  RunCockpitFrame,
  runKeyColumns,
  type PlannedRunCockpitFrame,
  type RunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";
import {
  HOVER_MARKER,
  READABLE_PANEL_COLUMNS,
} from "../../src/tui/cockpit/components.js";

const ev = (
  event: string,
  data: Record<string, unknown>,
  ts: string,
  taskId?: string,
): JournalEvent => ({ ts, event, ...(taskId ? { taskId } : {}), data });

const POINTER_RAW = [
  ev("run-start", { branch: "spec/pointer", pid: process.pid }, "2026-07-31T09:00:00.000Z"),
  ev("task-dispatch", { assignment: { adapter: "codex", model: "gpt-9" } }, "2026-07-31T09:00:01.000Z", "T1"),
  ev("gate-result", { gate: "baseline", pass: true, details: "clean tree" }, "2026-07-31T09:00:02.000Z", "T1"),
  ev("gate-result", { gate: "evidence", pass: true, details: "diff observed" }, "2026-07-31T09:00:03.000Z", "T1"),
  ev("gate-result", { gate: "review", pass: false, details: "the production finding" }, "2026-07-31T09:00:04.000Z", "T1"),
].map((event) => JSON.stringify(event)).join("\n") + "\n";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const pointerData = (): RunCockpitData =>
  deriveLiveRunCockpitData(
    { fileName: "run-pointer.journal.jsonl", raw: POINTER_RAW },
    "9.8.7",
  );

/** The frame production paints for one state at one measured size. */
async function drawn(
  data: RunCockpitData,
  columns: number,
  rows: number,
  interaction: RunInteractionState,
): Promise<string> {
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

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(
    createElement(RunCockpitFrame, { data, columns, rows, interaction }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      onRender: painted,
    },
  );
  try {
    await firstPaint;
    return stripAnsi(writes.at(-1) ?? "");
  } finally {
    app.unmount();
    app.cleanup();
  }
}

/** The cells of one planned region, read out of the drawn frame. */
const regionCells = (frame: string, region: FrameRegion): string =>
  frame.split("\n").slice(region.row, region.row + region.rows).map((line) =>
    [...line].slice(region.column, region.column + region.columns).join("")
  ).join("\n");

const regionOf = (plan: PlannedFrame, id: FrameRegion["id"]): FrameRegion => {
  const region = plan.regions.find((candidate) => candidate.id === id);
  if (region === undefined) throw new Error(`no planned ${id} region`);
  return region;
};

function surfaceAt(
  data: RunCockpitData,
  interaction: RunInteractionState,
  columns = 140,
  rows = 24,
): PointerSurface {
  const surface = liveRunPointerSurface(data, interaction, { columns, rows });
  if (surface === undefined) throw new Error(`${columns}x${rows} planned plain output`);
  return surface;
}

const press = (column: number, row: number): PointerReport => ({
  action: "press",
  column,
  row,
});

/** The cell a view's own name occupies in the rail the plan drew — the plan's own row for it. */
function railViewCell(plan: PlannedFrame, view: number): PointerReport {
  const rail = regionOf(plan, "rail");
  if (plan.sidebar === null) throw new Error("the plan drew no sidebar");
  return press(rail.column + 2, plan.sidebar.viewRows[FRAME_VIEWS[view]!]);
}

/** The cell the body's nth drawn row occupies — read off the plan's own item band, the one the paint draws that row into. */
function bodyRowCell(plan: PlannedFrame, row: number): PointerReport {
  const items = regionOf(plan, "items");
  return press(items.column + 4, items.row + row);
}

/** The filter prompt open over the drawn view — the state its own / key reaches. */
function withFilterPrompt(
  surface: PointerSurface,
): RunInteractionState {
  const opened = dispatchRunKey(
    { input: "/", key: {} },
    surface.interaction,
    RUN_INPUT_BINDINGS,
    surface.rowIds,
    plannedKeyColumns(surface.plan),
  );
  if (opened?.filterPrompt !== true) {
    throw new Error("the / key did not open the filter prompt");
  }
  return opened;
}

const applied = (
  report: PointerReport,
  surface: PointerSurface,
): RunInteractionState => {
  const next = applyPointerReport(report, surface);
  if (next === undefined) throw new Error("the pointer report resolved to nothing");
  return next;
};

const GATES = 2;

const POINTER_SOURCE = readFileSync(
  join(import.meta.dirname, "../../src/tui/cockpit/pointer.ts"),
  "utf8",
);

describe("pointer reports", () => {
  test("SGR-1006 reports parse to zero-based cells, and the wheel is its own action", () => {
    expect(parsePointerReports("\x1b[<0;10;4M")).toEqual([
      { action: "press", column: 9, row: 3, button: 0 },
    ]);
    expect(parsePointerReports("\x1b[<0;10;4m")).toEqual([
      { action: "release", column: 9, row: 3, button: 0 },
    ]);
    expect(parsePointerReports("\x1b[<64;3;7M")).toEqual([
      { action: "wheel-up", column: 2, row: 6, button: 64 },
    ]);
    expect(parsePointerReports("\x1b[<65;3;7M")).toEqual([
      { action: "wheel-down", column: 2, row: 6, button: 65 },
    ]);
    expect(parsePointerReports("\x1b[<35;3;7M")).toEqual([
      { action: "move", column: 2, row: 6, button: 35 },
    ]);
    // Keyboard bytes are not pointer input, and a torn sequence reports nothing.
    expect(parsePointerReports("q")).toEqual([]);
    expect(parsePointerReports("\x1b[<0;10;")).toEqual([]);
  });

  test("a report split across stream chunks is one report, read when its last byte arrives, and none of its bytes are left for the keyboard", () => {
    const read = createPointerReportReader();
    // The terminal writes bytes, not messages: this report lands in four pieces.
    // Not one of them is a keystroke — the third would otherwise be read as the
    // digit 3, which is a view key with no prompt open and filter text with one.
    expect(read("\x1b")).toMatchObject({ reports: [], keys: "" });
    expect(read("[<0;")).toMatchObject({ reports: [], keys: "" });
    expect(read("3")).toMatchObject({ reports: [], keys: "" });
    expect(read(";6M")).toMatchObject({
      reports: [{ action: "press", column: 2, row: 5 }],
      keys: "",
    });
    // The carried tail is never reported twice, and keyboard bytes still pass —
    // to the keyboard, which is the half of the stream a report never joins.
    expect(read("q")).toMatchObject({ reports: [], keys: "q" });

    // A complete report and the head of the next one in one chunk.
    const split = createPointerReportReader();
    expect(split("\x1b[<64;3;7M\x1b[<65;9;")).toMatchObject({
      reports: [{ action: "wheel-up", column: 2, row: 6 }],
      keys: "",
    });
    expect(split("2M")).toMatchObject({
      reports: [{ action: "wheel-down", column: 8, row: 1 }],
      keys: "",
    });
    // A key typed between two reports in one chunk reaches the keyboard, and
    // only it does.
    const interleaved = split("\x1b[<0;1;1Mq\x1b[<0;2;2M");
    expect(interleaved).toMatchObject({
      reports: [
        { action: "press", column: 0, row: 0 },
        { action: "press", column: 1, row: 1 },
      ],
      keys: "q",
    });
    expect(interleaved.tokens).toEqual([
      { type: "pointer", report: { action: "press", column: 0, row: 0, button: 0 } },
      { type: "keys", bytes: "q" },
      { type: "pointer", report: { action: "press", column: 1, row: 1, button: 0 } },
    ]);

    // A lone ESC receives the same next-turn grace as Ink's input parser; if
    // no report continuation arrives, the demultiplexer releases it unchanged.
    const escape = createPointerReportReader();
    expect(escape("\x1b")).toMatchObject({ reports: [], keys: "" });
    expect(escape.flush()).toMatchObject({ reports: [], keys: "\x1b" });

    // Bytes that can never complete a report are dropped rather than carried,
    // and an arrow key is not pointer input at all.
    const noise = createPointerReportReader();
    expect(noise("\x1b[A")).toMatchObject({ reports: [], keys: "\x1b[A" });
    expect(noise("\x1b[<0;4;5M")).toMatchObject({
      reports: [{ action: "press", column: 3, row: 4 }],
      keys: "",
    });
  });
});

describe("the pointer acts through the plan", () => {
  test("test: clicking a view name in the rail draws that view in the main region, and removing the handler fails this test", async () => {
    const data = pointerData();
    const opening = openingRunInteractionState();
    const surface = surfaceAt(data, opening);
    const body = regionOf(surface.plan, "body");

    // The frame the surface draws while the report changes nothing — remove the
    // handler and this is what the assertions below are compared against.
    const before = await drawn(data, 140, 24, opening);
    expect(regionCells(before, body)).not.toContain("GATES");

    const next = applied(railViewCell(surface.plan, GATES), surface);
    expect(next).not.toEqual(opening);
    expect(next.activeView).toBe("gates");

    const after = await drawn(data, 140, 24, next);
    expect(regionCells(after, body)).toContain("GATES");
    expect(regionCells(after, body)).toContain("baseline");

    // And with the / prompt open the same click still draws that view: a click
    // is not a keystroke, so the number the rail row names is never read as
    // filter text by whatever scope happens to be live.
    const onTasks = applied(railViewCell(surface.plan, 1), surface);
    const prompting = withFilterPrompt(surfaceAt(data, onTasks));
    const clickedWhilePrompting = applied(
      railViewCell(surface.plan, GATES),
      surfaceAt(data, prompting),
    );
    expect(clickedWhilePrompting.activeView).toBe("gates");
    expect(clickedWhilePrompting.filterPrompt).toBe(false);
    expect(clickedWhilePrompting.filterQuery).toBe("");
    const promptedFrame = await drawn(data, 140, 24, clickedWhilePrompting);
    expect(regionCells(promptedFrame, body)).toContain("GATES");
    expect(regionCells(promptedFrame, body)).toContain("baseline");
  });

  test("test: clicking an item draws the selection on it, and clicking the already-selected item draws its detail", async () => {
    const data = pointerData();
    const railSurface = surfaceAt(data, openingRunInteractionState());
    const onGates = applied(railViewCell(railSurface.plan, GATES), railSurface);
    const surface = surfaceAt(data, onGates);
    const body = regionOf(surface.plan, "body");
    const clicked = bodyRowCell(surface.plan, 1);
    expect(surface.drawnRowIds.length).toBeGreaterThan(1);

    const unselected = await drawn(data, 140, 24, onGates);
    expect(regionCells(unselected, body))
      .not.toContain(`${GLYPHS.pointer} T1 · evidence`);

    const selected = applied(clicked, surface);
    expect(selected.selection).toBe(surface.drawnRowIds[1]);
    const selectedFrame = await drawn(data, 140, 24, selected);
    expect(regionCells(selectedFrame, body))
      .toContain(`${GLYPHS.pointer} T1 · evidence`);
    expect(regionCells(selectedFrame, body)).not.toContain("GATE DETAIL");

    // The selection is drawn on the planned item row itself: the glyph lands on
    // the row the plan places, and on no other row of the drawn list.
    const selectionRows = regionCells(selectedFrame, regionOf(surface.plan, "items"))
      .split("\n")
      .flatMap((line, row) => (line.includes(GLYPHS.pointer) ? [row] : []));
    expect(selectionRows).toEqual([1]);

    // The same cell again: the row the pointer already marks opens.
    const detail = applied(clicked, surfaceAt(data, selected));
    expect(detail.opened).toBe(selected.selection);
    const detailFrame = await drawn(data, 140, 24, detail);
    expect(regionCells(detailFrame, body)).toContain("GATE DETAIL");
    expect(regionCells(detailFrame, body)).toContain("evidence");

    // With the / prompt open the same second click still opens the detail: the
    // click is dispatched as ⏎ on the marked row, never as the prompt's Apply.
    const prompting = withFilterPrompt(surfaceAt(data, selected));
    const openedWhilePrompting = applied(clicked, surfaceAt(data, prompting));
    expect(openedWhilePrompting.opened).toBe(selected.selection);
    expect(openedWhilePrompting.filterPrompt).toBe(false);
    const promptedDetail = await drawn(data, 140, 24, openedWhilePrompting);
    expect(regionCells(promptedDetail, body)).toContain("GATE DETAIL");
    expect(regionCells(promptedDetail, body)).toContain("evidence");
  });

  test("test: the wheel dispatches the advertised arrow only in the focused panel", async () => {
    const data = pointerData();
    const railSurface = surfaceAt(data, openingRunInteractionState());
    const onGates = applied(railViewCell(railSurface.plan, GATES), railSurface);
    const surface = surfaceAt(data, onGates);
    const body = regionOf(surface.plan, "body");
    const rail = regionOf(surface.plan, "rail");
    const before = await drawn(data, 140, 24, onGates);

    // Over the body: the rows scroll, the rail is drawn exactly as it was.
    const wheeled = applied(
      { action: "wheel-down", column: body.column + 6, row: body.row + 4 },
      surface,
    );
    const bodyWheeled = await drawn(data, 140, 24, wheeled);
    expect(regionCells(bodyWheeled, body)).not.toBe(regionCells(before, body));
    expect(regionCells(bodyWheeled, body))
      .toContain(`${GLYPHS.pointer} T1 · review`);
    expect(regionCells(bodyWheeled, rail)).toBe(regionCells(before, rail));

    // Back is the advertised route to the rail. Once the keyboard has focused
    // it, a wheel over it is the same ↓ and the body is drawn as it was.
    const railFocused = dispatchRunKey(
      { input: "", key: { leftArrow: true } },
      wheeled,
      RUN_INPUT_BINDINGS,
      surface.rowIds,
      plannedKeyColumns(surface.plan),
    );
    if (railFocused === undefined) throw new Error("← did not focus the rail");
    const railFocusedFrame = await drawn(data, 140, 24, railFocused);
    const railWheeled = applied(
      { action: "wheel-down", column: rail.column + 2, row: rail.row + 1 },
      surfaceAt(data, railFocused),
    );
    const railFrame = await drawn(data, 140, 24, railWheeled);
    expect(regionCells(railFrame, rail)).not.toBe(regionCells(railFocusedFrame, rail));
    expect(regionCells(railFrame, rail))
      .toContain(`${GLYPHS.pointer} Journal`);
    expect(regionCells(railFrame, body)).toBe(regionCells(railFocusedFrame, body));

    // With the body's / prompt open neither the rail nor body offers ↑↓. A
    // wheel cannot borrow a different focus or scope and then restore it: that
    // would manufacture a state no advertised key reaches.
    const prompting = withFilterPrompt(surfaceAt(data, onGates));
    const promptRailWheel = applyPointerReport(
      { action: "wheel-down", column: rail.column + 2, row: rail.row + 1 },
      surfaceAt(data, prompting),
    );
    expect(promptRailWheel).toBeUndefined();
    const promptBodyWheel = applyPointerReport(
      { action: "wheel-down", column: body.column + 6, row: body.row + 4 },
      surfaceAt(data, prompting),
    );
    expect(promptBodyWheel).toBeUndefined();
  }, 30_000);

  test("test: clicking inside a panel draws the focus ring on that panel", async () => {
    const data = pointerData();
    const opening = openingRunInteractionState();
    const openedGates = applied(
      railViewCell(surfaceAt(data, opening).plan, GATES),
      surfaceAt(data, opening),
    );
    const onRail = dispatchRunKey(
      { input: "", key: { leftArrow: true } },
      openedGates,
      RUN_INPUT_BINDINGS,
      surfaceAt(data, openedGates).rowIds,
      plannedKeyColumns(surfaceAt(data, openedGates).plan),
    );
    if (onRail === undefined) throw new Error("← did not focus the rail");
    const surface = surfaceAt(data, onRail);
    const body = regionOf(surface.plan, "body");
    const rail = regionOf(surface.plan, "rail");

    const railRing = await drawn(data, 140, 24, onRail);
    expect(regionCells(railRing, rail)).toContain(`${GLYPHS.pointer} VIEWS`);
    expect(regionCells(railRing, body)).not.toContain(`${GLYPHS.pointer} RUN`);

    const inBody = applied(press(body.column + 6, body.row + 3), surface);
    const bodyRing = await drawn(data, 140, 24, inBody);
    expect(regionCells(bodyRing, body)).toContain(`${GLYPHS.pointer} GATES`);
    expect(regionCells(bodyRing, rail)).not.toContain(`${GLYPHS.pointer} VIEWS`);

    // Back onto the rail, below its menu: the ring returns without opening a view.
    const backOnRail = applied(
      press(rail.column + 2, rail.row + rail.rows - 1),
      surfaceAt(data, inBody),
    );
    expect(backOnRail.activeView).toBe(inBody.activeView);
    const returned = await drawn(data, 140, 24, backOnRail);
    expect(regionCells(returned, rail)).toContain(`${GLYPHS.pointer} VIEWS`);
    expect(regionCells(returned, body)).not.toContain(`${GLYPHS.pointer} RUN`);
  });

  test("test: at 64 to 79 columns the focus order and the click targets both match the bands the plan drew at that width", async () => {
    const data = pointerData();
    const opening = openingRunInteractionState();
    for (let columns = 64; columns <= 79; columns += 1) {
      const at = `${columns} columns`;
      const surface = surfaceAt(data, opening, columns, 24);
      const plan = surface.plan;
      // The plan draws the rail across this whole band.
      expect(plan.band, at).toBe("sidebar");
      expect(plannedKeyColumns(plan), at).toBe(runKeyColumns(columns));
      // The focus order the frame paints from carries the band the plan drew.
      expect(runPanelFocusOrder(plannedKeyColumns(plan)), at)
        .toContain("VIEWS");

      // The click targets are the same bands: the rail's menu, then the body.
      const rail = regionOf(plan, "rail");
      const target = resolvePointerTarget(plan, railViewCell(plan, GATES));
      expect(target?.region.id, at).toBe("rail");
      expect(target?.view, at).toBe(GATES);
      // A body cell lands on the body's own item band — the plan's nested
      // region for the list, which is what carries the row.
      const inBody = resolvePointerTarget(plan, bodyRowCell(plan, 0));
      expect(inBody?.region.id, at).toBe("items");
      expect(inBody?.row, at).toBe(0);
      expect(rail.column + rail.columns, at).toBe(regionOf(plan, "body").column);
    }

    // Below the band the plan draws no rail, so neither the focus order nor the
    // click targets carry one: the same cell is not a rail cell there.
    const strip = surfaceAt(data, opening, 63, 24);
    expect(strip.plan.band).toBe("strip");
    expect(runPanelFocusOrder(plannedKeyColumns(strip.plan))).toEqual(["CONTENT"]);
    expect(strip.plan.regions.some((region) => region.id === "rail")).toBe(false);

    // And the drawn frames at the band's edges act on what they draw.
    for (const columns of [64, 79]) {
      const surface = surfaceAt(data, opening, columns, 24);
      const next = applied(railViewCell(surface.plan, GATES), surface);
      const frame = await drawn(data, columns, 24, next);
      expect(regionCells(frame, regionOf(surface.plan, "body")), `${columns} body`)
        .toContain("GATES");
      expect(regionCells(frame, regionOf(surface.plan, "rail")), `${columns} rail`)
        .toContain("Gates");
    }
  }, 30_000);

  test("every hit resolves through planFrame's regions and no pointer path re-derives or caches geometry", async () => {
    const data = pointerData();
    const surface = surfaceAt(data, openingRunInteractionState());
    const plan = surface.plan;
    // Every cell of the frame lands in a region the plan itself placed — the
    // very object planFrame returned, not a rectangle of the same shape.
    for (let row = 0; row < plan.size.rows; row += 1) {
      for (let column = 0; column < plan.size.columns; column += 7) {
        const target = resolvePointerTarget(plan, { column, row });
        expect(target, `${column},${row}`).toBeDefined();
        expect(plan.regions, `${column},${row}`).toContain(target!.region);
      }
    }
    expect(resolvePointerTarget(plan, { column: 0, row: plan.size.rows }))
      .toBeUndefined();
    expect(resolvePointerTarget(plan, { column: plan.size.columns, row: 0 }))
      .toBeUndefined();

    // The item rows are planFrame's own output, not a rectangle production
    // derives after it: the plan a fresh planFrame call returns for this size
    // carries the identical region, and the resolver reads its offset off the
    // plan — move that planned region and the answer moves with it, while a
    // resolver subtracting the drawn panel's chrome would answer the same row.
    const authoritative = planFrame(plan.size, plan.view, { tab: plan.tab });
    if (authoritative.kind !== "frame") throw new Error("140x24 planned plain");
    const items = regionOf(plan, "items");
    const body = regionOf(plan, "body");
    expect(regionOf(authoritative, "items")).toEqual(items);
    // First-class, so the oracle can hold it: a band of `regions` — the roster
    // the paint must register a drawn node for — and a span of `rowSpans`.
    expect(plan.regions).toContain(items);
    expect(plan.rowSpans.items).toBe(items.rows);
    const cell = bodyRowCell(plan, 3);
    expect(resolvePointerTarget(plan, cell)?.row).toBe(3);
    const moveItems = (rows: number): PlannedFrame => ({
      ...plan,
      regions: plan.regions.map((region) =>
        region.id === "items" ? { ...region, row: region.row + rows } : region
      ),
    });
    expect(resolvePointerTarget(moveItems(1), cell)?.row).toBe(2);
    // And the plan is held to it: item rows that leave the band that hosts them
    // are refused before any frame is drawn, which is precisely what a field
    // standing beside the plan could never be held to.
    expect(() => assertFrameConformance(moveItems(body.rows), ""))
      .toThrow(/items/u);
    // And a cell above the planned item rows is no item at all.
    expect(resolvePointerTarget(plan, bodyRowCell(plan, -1))?.row)
      .toBeUndefined();

    // The paint draws its list into that same planned region: the row the plan
    // places first is the row the frame draws first, so the geometry a click
    // resolves through is the geometry an operator is looking at.
    const onGates = applied(railViewCell(plan, GATES), surface);
    const gates = surfaceAt(data, onGates);
    expect(gates.drawnRowIds.length).toBeGreaterThan(2);
    for (const row of [0, 2]) {
      const clickedRow = applied(bodyRowCell(gates.plan, row), gates);
      expect(clickedRow.selection, `row ${row}`).toBe(gates.drawnRowIds[row]);
      const painted = regionCells(
        await drawn(data, 140, 24, clickedRow),
        regionOf(gates.plan, "items"),
      ).split("\n").flatMap((line, index) =>
        line.includes(GLYPHS.pointer) ? [index] : []
      );
      expect(painted, `row ${row} is drawn where the plan places it`)
        .toEqual([row]);
    }
    // The row above the planned item rows is the panel's title, not an item.
    expect(
      (await drawn(data, 140, 24, onGates))
        .split("\n")[regionOf(gates.plan, "items").row - 1],
    ).toContain("GATES");

    // Nothing is carried between resolutions: the same cell resolves through
    // whichever plan it is asked about, at that plan's own bands.
    const narrow = surfaceAt(data, openingRunInteractionState(), 63, 24);
    const railCell = { column: 5, row: regionOf(plan, "rail").row };
    expect(resolvePointerTarget(plan, railCell)?.region.id).toBe("rail");
    const inNarrow = resolvePointerTarget(narrow.plan, railCell);
    expect(inNarrow?.region.id).not.toBe("rail");
    expect(narrow.plan.regions).toContain(inNarrow!.region);
    expect(resolvePointerTarget(plan, railCell)?.region.id).toBe("rail");

    // The rail is resolved the same way: the plan states the row each view is
    // drawn on, so moving that planned row moves the target — a resolver
    // reconstructing the menu from `menuRows` would answer the same view.
    const railCellFor = railViewCell(plan, GATES);
    expect(resolvePointerTarget(plan, railCellFor)?.view).toBe(GATES);
    const movedRail: PlannedFrame = {
      ...plan,
      sidebar: {
        ...plan.sidebar!,
        viewRows: { ...plan.sidebar!.viewRows, gates: plan.sidebar!.viewRows.gates + 1 },
      },
    };
    expect(resolvePointerTarget(movedRail, railCellFor)?.view).toBeUndefined();

    // The law in the file itself: the pointer layer subtracts no drawn chrome
    // to find the item rows, because it imports none to subtract.
    expect(POINTER_SOURCE).not.toContain('from "./components.js"');
    expect(POINTER_SOURCE).not.toContain("PANEL_CHROME_ROWS");
  }, 30_000);
});

/** A stream that is or is not a terminal, and every byte written to it. */
function terminalStream(isTTY: boolean): {
  readonly stream: PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  readonly writes: string[];
} {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  stream.isTTY = isTTY;
  stream.columns = 140;
  stream.rows = 24;
  stream.resume();
  const writes: string[] = [];
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return Reflect.apply(write, stream, [chunk, ...args]) as boolean;
  }) as typeof stream.write;
  return { stream, writes };
}

/**
 * The exits the loan must survive, named here and nowhere else in this file:
 * every catchable POSIX terminator that ends an interactive cockpit — ⌃C, a
 * `kill`, a closed terminal, and ⌃\ — sorted the way a registered roster reads
 * back. Stated independently of `POINTER_RELEASE_SIGNALS` on purpose: a test
 * that derives its cases from the constant it is checking is satisfied by a
 * roster missing a terminator, which is exactly the defect it exists to catch.
 */
const REQUIRED_RELEASE_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
];

/** A process whose signal roster and re-raises can be read rather than survived. */
function recordingHost(platform: NodeJS.Platform = "linux"): PointerTrackingHost & {
  readonly listeners: Map<NodeJS.Signals, Set<() => void>>;
  readonly raised: { pid: number; signal: NodeJS.Signals }[];
} {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  const raised: { pid: number; signal: NodeJS.Signals }[] = [];
  return {
    pid: 4242,
    platform,
    listeners,
    raised,
    on: (signal, listener) => {
      const registered = listeners.get(signal) ?? new Set<() => void>();
      registered.add(listener);
      listeners.set(signal, registered);
    },
    off: (signal, listener) => {
      listeners.get(signal)?.delete(listener);
    },
    kill: (pid, signal) => {
      raised.push({ pid, signal });
    },
  };
}

const settled = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

const registeredSignals = (
  host: ReturnType<typeof recordingHost>,
): NodeJS.Signals[] =>
  [...host.listeners.entries()]
    .flatMap(([signal, listeners]) => (listeners.size > 0 ? [signal] : []))
    .sort();

/**
 * One mounted frame, held open: every byte it wrote, the frame it drew, and
 * the unmount that ends it — the exit path a refusing conformance guard takes.
 */
async function mountedFrame({
  data,
  interaction = openingRunInteractionState(),
  isTTY = true,
  seam = true,
  columns = 140,
  rows = 24,
}: {
  data: RunCockpitData;
  interaction?: RunInteractionState;
  /** Whether the stream the frame is painted into is a real terminal. */
  isTTY?: boolean;
  /** Whether anything is resolving pointer hits against this frame's geometry. */
  seam?: boolean;
  columns?: number;
  rows?: number;
}): Promise<{
  readonly writes: string[];
  readonly frame: string;
  readonly close: () => Promise<void>;
}> {
  const { stream, writes } = terminalStream(isTTY);
  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(
    createElement(RunCockpitFrame, {
      data,
      columns,
      rows,
      interaction,
      ...(seam ? { onCommittedFrame: () => {} } : {}),
    }),
    {
      stdout: stream as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      onRender: painted,
    },
  );
  await firstPaint;
  await settled();
  return {
    writes,
    // The drawn frame is the last write carrying drawn cells; a mode request
    // carries none, so it can never be mistaken for one.
    frame: writes.filter((chunk) => stripAnsi(chunk).trim().length > 0).at(-1)
      ?? "",
    close: async () => {
      app.unmount();
      app.cleanup();
      await settled();
    },
  };
}

/** The live runner's own delivery boundary, handed back as it is created. */
function deliveryPromise(): {
  readonly ready: Promise<LiveCockpitDelivery>;
  readonly accept: (delivery: LiveCockpitDelivery) => void;
} {
  let accept!: (delivery: LiveCockpitDelivery) => void;
  const ready = new Promise<LiveCockpitDelivery>((resolve) => {
    accept = resolve;
  });
  return { ready, accept };
}

/** A report written back in the one grammar the terminal reports it in. */
const sgrBytes = ({ action, column, row }: PointerReport): string => {
  const button = action === "wheel-up"
    ? 64
    : action === "wheel-down"
    ? 65
    : action === "move"
    ? 35
    : 0;
  return `\x1b[<${button};${column + 1};${row + 1}${
    action === "release" ? "m" : "M"
  }`;
};

describe("the terminal is borrowed, the keyboard is sovereign", () => {
  test("test: pointer reporting is on only for an interactive terminal and off again on every exit, including a failing one", async () => {
    // Not a terminal: nothing is asked for and nothing is registered, so a pipe
    // receives no mode request — and no stray disable either.
    const pipe = terminalStream(false);
    const pipeHost = recordingHost();
    borrowPointerTracking(pipe.stream, pipeHost)();
    expect(pipe.writes.join("")).toBe("");
    expect(registeredSignals(pipeHost)).toEqual([]);

    // A terminal: asked once, handed back once. Handing it back twice writes no
    // second disable — the loan is a loan, not a counter.
    const tty = terminalStream(true);
    const host = recordingHost();
    // And asked for only once the repayment stands: the roster is read at the
    // moment the ask reaches the terminal, so there is no instant at which the
    // modes are on and no listener would hand them back.
    const rosterWhenAsked: NodeJS.Signals[][] = [];
    const askWrite = tty.stream.write.bind(tty.stream);
    tty.stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      rosterWhenAsked.push(registeredSignals(host));
      return Reflect.apply(askWrite, tty.stream, [chunk, ...args]) as boolean;
    }) as typeof tty.stream.write;
    const release = borrowPointerTracking(tty.stream, host);
    expect(rosterWhenAsked).toEqual([REQUIRED_RELEASE_SIGNALS]);
    expect(tty.writes.join("")).toBe(POINTER_TRACKING_ON);
    expect(registeredSignals(host)).toEqual(REQUIRED_RELEASE_SIGNALS);
    release();
    release();
    expect(tty.writes.join("")).toBe(POINTER_TRACKING_ON + POINTER_TRACKING_OFF);
    expect(registeredSignals(host)).toEqual([]);

    // A failing exit: the borrower throws, and the release every borrower runs
    // from its own finally still hands the modes back.
    const failing = terminalStream(true);
    const failingRelease = borrowPointerTracking(failing.stream, recordingHost());
    expect(() => {
      try {
        throw new Error("the frame refused");
      } finally {
        failingRelease();
      }
    }).toThrow("the frame refused");
    expect(failing.writes.join(""))
      .toBe(POINTER_TRACKING_ON + POINTER_TRACKING_OFF);

    // A signal runs no finally and unmounts no renderer, so the listener repays
    // the loan itself and then re-raises — with itself removed, so the process
    // still ends exactly the way the signal meant it to. Every signal this
    // asserts is named by the required set above, never read back off the
    // production roster: a test that iterates the roster it is checking passes
    // just as happily on a roster missing a terminator.
    for (const signal of REQUIRED_RELEASE_SIGNALS) {
      const signalled = terminalStream(true);
      const signalHost = recordingHost();
      borrowPointerTracking(signalled.stream, signalHost);
      for (const listener of signalHost.listeners.get(signal) ?? []) listener();
      expect(signalled.writes.join(""), signal)
        .toBe(POINTER_TRACKING_ON + POINTER_TRACKING_OFF);
      expect(signalHost.raised, signal)
        .toEqual([{ pid: signalHost.pid, signal }]);
      expect(registeredSignals(signalHost), signal).toEqual([]);
    }

    // The one platform exception is a platform that cannot receive the signal:
    // Windows has no SIGQUIT and libuv refuses the listener, so there the loan
    // is repaid by the three terminators that platform does deliver — and by
    // every one of them, rather than by a roster that quietly shrank.
    const windows = recordingHost("win32");
    borrowPointerTracking(terminalStream(true).stream, windows);
    expect(registeredSignals(windows)).toEqual(
      REQUIRED_RELEASE_SIGNALS.filter((signal) => signal !== "SIGQUIT"),
    );

    // The shipped surface: the frame whose geometry hits resolve through asks
    // its terminal, and hands it back when it unmounts — which is the exit the
    // conformance guard takes when it refuses a frame.
    // A frame is not a second owner of the terminal. The complete live runner
    // owns the one borrow around mount, wait and teardown; rendering alone is
    // quiet whether or not it publishes committed geometry for hit testing.
    const data = pointerData();
    for (const surface of [{ seam: false }, { isTTY: false }]) {
      const quiet = await mountedFrame({ data, ...surface });
      await quiet.close();
      expect(quiet.writes.join(""), JSON.stringify(surface))
        .not.toContain("\x1b[?100");
    }

    // So the machine anchors carry no enable sequence — the frozen bytes, and
    // the production capture path that would regenerate them.
    for (const fixture of ["run.ci.140x24.txt", "run.non-tty.140x24.txt"]) {
      expect(
        readFileSync(
          join(import.meta.dirname, "../fixtures/cockpit/frames", fixture),
          "utf8",
        ),
        fixture,
      ).not.toContain("\x1b[?100");
    }
    for (const machine of [
      { interactive: false, ci: false },
      { interactive: true, ci: true },
    ]) {
      const anchor = terminalStream(machine.interactive);
      await captureCockpitOutput({
        cockpit: "run",
        output: anchor.stream as unknown as NodeJS.WriteStream,
        binaryVersion: "9.8.7",
        columns: 140,
        rows: 24,
        colour: false,
        ...machine,
      });
      expect(anchor.writes.join(""), JSON.stringify(machine))
        .not.toContain("\x1b[?100");
    }
  }, 60_000);

  test("test: with no pointer reported the surface draws exactly what it draws with the pointer layer absent", async () => {
    const data = pointerData();
    const interaction = openingRunInteractionState();

    // The same state drawn with the pointer layer live — reports asked for, the
    // committed geometry published — and with the layer absent entirely.
    const withPointer = await mountedFrame({ data, interaction });
    await withPointer.close();
    const withoutPointer = await mountedFrame({ data, interaction, seam: false });
    await withoutPointer.close();
    expect(withPointer.frame).toBe(withoutPointer.frame);
    // The mode requests are the layer's whole footprint on the stream, and they
    // are not part of any drawn row.
    expect(withPointer.writes.join("")).not.toContain("\x1b[?100");
    expect(withPointer.frame).not.toContain("\x1b[?100");

    // And no report is no transition. A cell outside the frame owns nothing,
    // and the reports that name no action — a release, a pointer merely moving
    // over the surface — change nothing either, so a surface an operator is not
    // clicking on stays the surface they were given.
    const surface = surfaceAt(data, interaction);
    expect(applyPointerReport(press(0, surface.plan.size.rows), surface))
      .toBeUndefined();
    for (const action of ["release", "move"] as const) {
      expect(applyPointerReport({ action, column: 4, row: 4 }, surface), action)
        .toBeUndefined();
    }
    // And the keyboard's own stream is untouched by a chunk carrying no report.
    expect(createPointerReportReader()("q"))
      .toMatchObject({ reports: [], keys: "q" });
  }, 60_000);

  test("test: every pointer action is performed by an advertised key as well, proven by driving both and comparing drawn frames", async () => {
    const data = pointerData();
    const opening = openingRunInteractionState();
    const railSurface = surfaceAt(data, opening);
    const plan = railSurface.plan;
    const body = regionOf(plan, "body");
    const rail = regionOf(plan, "rail");
    const onGates = applied(railViewCell(plan, GATES), railSurface);
    const gates = surfaceAt(data, onGates);
    const marked = applied(bodyRowCell(gates.plan, 0), gates);
    const promptingGates = withFilterPrompt(gates);
    const promptingMarked = withFilterPrompt(surfaceAt(data, marked));
    // A wholly keyboard-reachable mismatch: ↓ moves the rail marker while the
    // Run overview remains active. This is the state the old fixture matrix
    // omitted, allowing a body click to forge CONTENT focus while preserving a
    // rail/view mismatch no advertised key could draw.
    let runWithGatesMarked = opening;
    for (let index = 0; index < GATES; index += 1) {
      const at = surfaceAt(data, runWithGatesMarked);
      const next = dispatchRunKey(
        { input: "", key: { downArrow: true } },
        runWithGatesMarked,
        RUN_INPUT_BINDINGS,
        at.rowIds,
        plannedKeyColumns(at.plan),
      );
      if (next === undefined) throw new Error("↓ did not move the rail marker");
      runWithGatesMarked = next;
    }
    expect(runWithGatesMarked).toMatchObject({
      activeView: "run",
      railSelection: GATES,
      panel: runPanelFocusOrder(plannedKeyColumns(plan)).indexOf("VIEWS"),
    });

    // Every transition the pointer layer can make, beside the advertised key
    // that makes it. The pointer's whole roster is here: a rail view name, a
    // panel, an item row, the row already marked, and the wheel both ways.
    const paired: readonly {
      readonly name: string;
      readonly from: RunInteractionState;
      readonly report: PointerReport;
      readonly keys: readonly {
        readonly advertised: string;
        readonly event: RunKeyEvent;
      }[];
    }[] = [
      {
        name: "a view name in the rail",
        from: opening,
        report: railViewCell(plan, GATES),
        keys: [{ advertised: "1–5", event: { input: String(GATES + 1), key: {} } }],
      },
      {
        name: "the panel a cell is in",
        from: opening,
        report: press(body.column + 6, body.row + 3),
        keys: [{ advertised: "⏎", event: { input: "", key: { return: true } } }],
      },
      {
        name: "the body while a different rail view is marked",
        from: runWithGatesMarked,
        report: press(body.column + 6, body.row + 3),
        keys: [{ advertised: "⏎", event: { input: "", key: { return: true } } }],
      },
      {
        name: "back onto the rail",
        from: onGates,
        report: press(rail.column + 2, rail.row + rail.rows - 1),
        keys: [{ advertised: "←", event: { input: "", key: { leftArrow: true } } }],
      },
      {
        name: "an item row",
        from: onGates,
        report: bodyRowCell(gates.plan, 1),
        keys: [0, 1].map(() => ({
          advertised: "↑↓",
          event: { input: "", key: { downArrow: true } },
        })),
      },
      {
        name: "the item row already marked",
        from: marked,
        report: bodyRowCell(gates.plan, 0),
        keys: [{ advertised: "⏎", event: { input: "", key: { return: true } } }],
      },
      {
        name: "a view name while the filter prompt owns input",
        from: promptingGates,
        report: railViewCell(plan, 1),
        keys: [
          { advertised: "⏎", event: { input: "", key: { return: true } } },
          { advertised: "1–5", event: { input: "2", key: {} } },
        ],
      },
      {
        name: "the marked item while the filter prompt owns input",
        from: promptingMarked,
        report: bodyRowCell(gates.plan, 0),
        keys: [0, 1].map(() => ({
          advertised: "⏎",
          event: { input: "", key: { return: true } },
        })),
      },
      {
        name: "the wheel down",
        from: onGates,
        report: { action: "wheel-down", column: body.column + 6, row: body.row + 4 },
        keys: [{ advertised: "↑↓", event: { input: "", key: { downArrow: true } } }],
      },
      {
        name: "the wheel up",
        from: marked,
        report: { action: "wheel-up", column: body.column + 6, row: body.row + 4 },
        keys: [{ advertised: "↑↓", event: { input: "", key: { upArrow: true } } }],
      },
      {
        name: "the wheel over the rail",
        from: opening,
        report: { action: "wheel-down", column: rail.column + 2, row: rail.row + 1 },
        keys: [{ advertised: "↑↓", event: { input: "", key: { downArrow: true } } }],
      },
    ];

    for (const { name, from, report, keys } of paired) {
      const pointed = applied(report, surfaceAt(data, from));

      // The keyboard's own route to the same place: every key is one the keybar
      // is advertising in the state it is pressed from, so nothing here is
      // reachable by a key an operator was never offered.
      let typed = from;
      for (const { advertised, event } of keys) {
        const surface = surfaceAt(data, typed);
        const roster = projectRunKeyEntries({
          interaction: typed,
          columns: plannedKeyColumns(surface.plan),
          rowIds: surface.rowIds,
        });
        expect(roster.map((entry) => entry.key), `${name} advertises ${advertised}`)
          .toContain(advertised);
        const next = dispatchRunKey(
          event,
          typed,
          RUN_INPUT_BINDINGS,
          surface.rowIds,
          plannedKeyColumns(surface.plan),
        );
        if (next === undefined) throw new Error(`${name}: ${advertised} did nothing`);
        typed = next;
      }

      // The proof is the drawn frame: whatever the two routes did to the state,
      // the operator is looking at the identical surface either way.
      expect(await drawn(data, 140, 24, pointed), `${name} drawn`)
        .toBe(await drawn(data, 140, 24, typed));
      // And the pointer really moved: a pair that changed nothing proves nothing.
      expect(await drawn(data, 140, 24, pointed), `${name} moved`)
        .not.toBe(await drawn(data, 140, 24, from));
    }

    // And the roster above is every action the pointer layer has, rather than
    // the ones that happened to pair: the actions absent from it are absent
    // because they make no transition at all, so there is no pointer transition
    // left over without an advertised key beside it.
    const acted = new Set(paired.map(({ report }) => report.action));
    expect([...acted].sort()).toEqual(["press", "wheel-down", "wheel-up"]);
    for (const action of ["release", "move"] as const) {
      expect(
        applyPointerReport(
          { action, column: body.column + 6, row: body.row + 4 },
          surfaceAt(data, onGates),
        ),
        action,
      ).toBeUndefined();
    }

    // Off-focus wheel reports are not actions. Reach both focus states through
    // advertised keys, then prove a notch over the other band cannot borrow
    // focus and restore it to manufacture a mouse-only frame.
    const gatesSurface = surfaceAt(data, onGates);
    const railOnGates = dispatchRunKey(
      { input: "", key: { leftArrow: true } },
      onGates,
      RUN_INPUT_BINDINGS,
      gatesSurface.rowIds,
      plannedKeyColumns(gatesSurface.plan),
    );
    if (railOnGates === undefined) throw new Error("← did not focus the rail");
    for (
      const [name, from, cell] of [
        ["the rail while the body is focused", onGates, {
          column: rail.column + 2,
          row: rail.row + 1,
        }],
        ["the body while the rail is focused", railOnGates, {
          column: body.column + 6,
          row: body.row + 4,
        }],
      ] as const
    ) {
      const surface = surfaceAt(data, from);
      const scrolled = applyPointerReport({ action: "wheel-down", ...cell }, surface);
      expect(scrolled, name).toBeUndefined();
    }
  }, 120_000);

  test("test: a pointer report changes no key handler state, while its paired key drives the same transition", () => {
    const data = pointerData();
    const opening = openingRunInteractionState();
    const surface = surfaceAt(data, opening);
    const report = railViewCell(surface.plan, GATES);
    const bytes = sgrBytes(report);
    const dispatch = (
      event: RunKeyEvent,
      state: RunInteractionState,
    ): RunInteractionState | undefined =>
      dispatchRunKey(
        event,
        state,
        RUN_INPUT_BINDINGS,
        surface.rowIds,
        plannedKeyColumns(surface.plan),
      );

    // A report is its own input class: the demultiplexer hands the keyboard
    // nothing at all, whether the report arrives whole or one byte at a time.
    expect(createPointerReportReader()(bytes))
      .toMatchObject({ reports: [report], keys: "" });
    const torn = createPointerReportReader();
    const handedToKeys = [...bytes].map((byte) => torn(byte).keys).join("");
    expect(handedToKeys).toBe("");

    // So no key handler sees a byte of it: everything the keyboard was handed,
    // dispatched, leaves the surface exactly where it stood.
    expect(dispatch({ input: handedToKeys, key: {} }, opening)).toBeUndefined();

    // And the separation is load-bearing rather than incidental — every digit
    // inside a report is a byte a key handler owns, so a report left on the
    // stream would dispatch keystrokes nobody typed.
    const digits = [...bytes].filter((byte) => /\d/u.test(byte));
    expect(digits.length).toBeGreaterThan(0);
    for (const digit of digits) {
      expect(resolveRunKeyBinding(RUN_INPUT_BINDINGS, { input: digit, key: {} }), digit)
        .toBeDefined();
    }

    // The report acts through the pointer layer alone, and the key it is paired
    // with drives the identical transition through the registry.
    const clicked = applied(report, surface);
    expect(clicked.activeView).toBe("gates");
    expect(dispatch({ input: String(GATES + 1), key: {} }, opening)).toEqual(clicked);
  });
});

/**
 * The one byte an inverted highlight is drawn with. Nothing else the cockpit
 * paints wears SGR 7, so its presence in a frame is the highlight's ink and its
 * absence is the pointerless appearance — which is what makes "no highlight
 * byte reaches a capture" a claim about bytes rather than about intent.
 *
 * The ink is only half of it. Chalk suppresses inverse and colour together at
 * level 0, so under `NO_COLOR` or a colourless TTY this byte is never written
 * at all and {@link HOVER_MARKER} is the whole highlight. Both are therefore
 * highlight bytes, and both are what a capture must be free of: the anchors are
 * captured with colour off, where the marker is the only one that could leak.
 */
const HIGHLIGHT = "\x1b[7m";
const HIGHLIGHT_BYTES = [HIGHLIGHT, HOVER_MARKER] as const;

/**
 * Every committed capture corpus, each named here rather than discovered, so a
 * corpus this claim was never checked against cannot pass by being absent: the
 * layout goldens, the machine anchors — which live in their own directory and
 * are the artefact the acceptance criterion names beside the goldens — and the
 * colour corpus, the only one drawn in real ink at all.
 */
const FIXTURE_DIRS = {
  frames: join(import.meta.dirname, "../fixtures/cockpit/frames"),
  anchors: join(import.meta.dirname, "../fixtures/cockpit/anchors"),
  colour: join(import.meta.dirname, "../fixtures/cockpit/colour"),
} as const;

/**
 * Rest the pointer where a terminal would have reported it resting. The move
 * report goes through `applyPointerReport` — the one call the live delivery
 * makes for every report it receives — so nothing here hands a frame a hover it
 * could not have been reported. `null` is the pointer resting nowhere, reached
 * the way production reaches it: the tracking loan handed back, which restores
 * the state that stands before any report arrives.
 */
function restPointer(
  surface: PointerSurface,
  cell: { readonly column: number; readonly row: number } | null,
): void {
  if (cell === null) {
    borrowPointerTracking(terminalStream(true).stream, recordingHost())();
    return;
  }
  applyPointerReport({ action: "move", ...cell }, surface);
}

/**
 * The frame production paints in real ink for one state, with the pointer
 * reported to rest on one cell of the surface that state draws — or nowhere,
 * which is the shape every capture builds this frame in.
 */
async function inked(
  data: RunCockpitData,
  interaction: RunInteractionState,
  hover: { readonly column: number; readonly row: number } | null,
): Promise<string> {
  restPointer(surfaceAt(data, interaction), hover);
  return captureRendererOutput(
    createElement(RunCockpitFrame, {
      data,
      columns: 140,
      rows: 24,
      interaction,
      // The seam a live surface has and a capture does not: this frame publishes
      // its geometry for hit testing, so a report resolves against it.
      onCommittedFrame: () => {},
    }),
    { columns: 140, rows: 24, colour: true },
  );
}

/**
 * The item rows a highlight is drawn on, counted from the planned band's own
 * first row. Read from the marker in the drawn cells rather than from the ink,
 * so the same reading answers at every colour level — at level 0 the ink is
 * never written and a reading that looked for it would report no highlight on a
 * frame that carries one.
 */
const highlighted = (frame: string, items: FrameRegion): number[] =>
  regionCells(stripAnsi(frame), items).split("\n").flatMap((line, row) =>
    line.includes(HOVER_MARKER) ? [row] : []
  );

/**
 * A frame's drawn cells with the highlight taken back out — the marker returned
 * to the separator space it stands in. Equal to the unhovered frame's own cells
 * exactly when the highlight cost the row nothing but that one cell, which is
 * what makes it safe to draw under an operator mid-read.
 */
const unmarked = (frame: string): string =>
  stripAnsi(frame).replaceAll(HOVER_MARKER, " ");

/** The item rows the selection marker is drawn on, in the same counting. */
const marked = (frame: string, items: FrameRegion): number[] =>
  regionCells(stripAnsi(frame), items).split("\n").flatMap((line, row) =>
    line.includes(GLYPHS.pointer) ? [row] : []
  );

/** The surface with the Gates view drawn — a body whose rows a click acts on. */
function gatesSurface(data: RunCockpitData): {
  readonly interaction: RunInteractionState;
  readonly surface: PointerSurface;
} {
  const opening = surfaceAt(data, openingRunInteractionState());
  const interaction = applied(railViewCell(opening.plan, GATES), opening);
  return { interaction, surface: surfaceAt(data, interaction) };
}

/** A cell reported the way a terminal reports a pointer merely resting there. */
const hoverBytes = (cell: PointerReport): string =>
  sgrBytes({ ...cell, action: "move" });

/**
 * The state an advertised key sequence reaches from the one a surface was drawn
 * in — the keyboard's own route to a state, so a hover claim is tested in states
 * an operator can actually reach rather than only in the one a click composes.
 */
function typed(
  surface: PointerSurface,
  ...events: readonly RunKeyEvent[]
): RunInteractionState {
  let state = surface.interaction;
  for (const event of events) {
    const next = dispatchRunKey(
      event,
      state,
      RUN_INPUT_BINDINGS,
      surface.rowIds,
      plannedKeyColumns(surface.plan),
    );
    if (next === undefined) throw new Error("the key drove no transition");
    state = next;
  }
  return state;
}

const BACK: RunKeyEvent = { input: "", key: { leftArrow: true } };
const DOWN: RunKeyEvent = { input: "", key: { downArrow: true } };

/**
 * The shipped live cockpit, open on a seeded engagement, driven by bytes on its
 * own stdin and read by the bytes it writes to its own stdout. Nothing is
 * injected into the renderer: what the terminal would write is what is written,
 * and what the operator would see is what is read back.
 */
async function liveCockpit(colourLevel: 0 | 3 = 3): Promise<{
  readonly delivery: LiveCockpitDelivery;
  readonly type: (bytes: string) => void;
  readonly frame: (
    matches: (frame: string) => boolean,
    description: string,
  ) => Promise<string>;
  readonly close: () => Promise<void>;
}> {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-hover-"));
  const runId = "run-20260731-090000";
  mkdirSync(join(repo, ".tickmarkr", "runs", runId), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "runs", runId, "journal.jsonl"), POINTER_RAW);

  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input as unknown as NodeJS.ReadStream;
  input.unref = () => input as unknown as NodeJS.ReadStream;
  const terminal = terminalStream(true);

  // The colour level the runner paints at. Level 3 is the ink-bearing terminal;
  // level 0 is what `NO_COLOR` and a colourless TTY both resolve to, where Ink
  // routes every style through a Chalk that writes no SGR at all — so a frame
  // drawn there wears no SGR 7 whether or not anything is hovered, and the
  // highlight is whatever remains once the ink is gone.
  const previousColour = chalk.level;
  chalk.level = colourLevel;
  const seam = deliveryPromise();
  const done = runLiveCockpit({
    input: input as unknown as NodeJS.ReadStream,
    output: terminal.stream as unknown as NodeJS.WriteStream,
    cwd: repo,
    runId,
    binaryVersion: "9.8.7",
    // A fixed clock and no refresh: every difference between two frames below
    // is the pointer's, never the elapsed-time field's.
    now: () => Date.parse("2026-07-31T09:00:10.000Z"),
    refreshMs: 60_000,
    debug: true,
    onDelivery: seam.accept,
  });
  const delivery = await seam.ready;
  return {
    delivery,
    type: (bytes) => {
      input.write(bytes);
    },
    frame: async (matches, description) => {
      for (let attempts = 0; attempts < 200; attempts += 1) {
        // The drawn frame is the last write carrying drawn cells; a mode
        // request carries none.
        const frame = terminal.writes.filter((chunk) =>
          stripAnsi(chunk).trim().length > 0
        ).at(-1) ?? "";
        if (matches(frame)) return frame;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`the live cockpit never drew ${description}`);
    },
    close: async () => {
      delivery.key({ input: "q", key: {} });
      await done;
      chalk.level = previousColour;
    },
  };
}

/** The live surface's own committed geometry, at the size it is drawn at. */
function liveSurface(delivery: LiveCockpitDelivery): PointerSurface {
  const { data, interaction } = delivery.snapshot();
  const surface = liveRunPointerSurface(data, interaction, {
    columns: 140,
    rows: 24,
  });
  if (surface === undefined) throw new Error("140x24 planned plain output");
  return surface;
}

describe("hover tells you what a click would hit", () => {
  test("test: hovering an item draws a highlight the unhovered frame does not carry, and removing the handler fails this test", async () => {
    const data = pointerData();
    const { interaction, surface } = gatesSurface(data);
    const items = regionOf(surface.plan, "items");
    expect(surface.drawnRowIds.length).toBeGreaterThan(1);

    // First in the shipped runner, driven by nothing but bytes on its own
    // stdin: a terminal reporting the pointer resting over an item row, and the
    // frame that runner then writes to its own stdout. Remove the handler — the
    // resting cell the report feeds, or the frame's reading of it — and no
    // report on this path can reach a drawn cell at all.
    const live = await liveCockpit();
    try {
      await live.frame((frame) => stripAnsi(frame).includes("RUN"), "the opening frame");
      live.type(sgrBytes(railViewCell(liveSurface(live.delivery).plan, GATES)));
      const liveGates = await live.frame(
        (frame) => stripAnsi(frame).includes(`${GLYPHS.pointer} GATES`),
        "the Gates view",
      );
      expect(liveGates).not.toContain(HIGHLIGHT);

      const beforeHover = live.delivery.snapshot().interaction;
      live.type(hoverBytes(bodyRowCell(liveSurface(live.delivery).plan, 1)));
      const liveHovered = await live.frame(
        (frame) => frame.includes(HIGHLIGHT),
        "the highlight under the resting pointer",
      );
      // Drawn by the report alone: the surface's interaction state is exactly
      // where the click before it left it, so nothing was selected or opened —
      // the redraw is the highlight and nothing else.
      expect(live.delivery.snapshot().interaction).toBe(beforeHover);
      expect(unmarked(liveHovered)).toBe(stripAnsi(liveGates));
    } finally {
      await live.close();
    }

    // And again in the same shipped runner drawn the way `NO_COLOR` and a
    // colourless TTY both draw it — Chalk at level 0, which writes no SGR at
    // all. A highlight made of ink alone is not suppressed there so much as
    // absent: the hovered and unhovered frames would be byte-identical and an
    // operator would be shown nothing. This is the regression that catches
    // that, so it asserts the frames differ BEFORE it says how.
    const plain = await liveCockpit(0);
    try {
      await plain.frame((frame) => stripAnsi(frame).includes("RUN"), "the opening frame");
      plain.type(sgrBytes(railViewCell(liveSurface(plain.delivery).plan, GATES)));
      const plainGates = await plain.frame(
        (frame) => frame.includes(`${GLYPHS.pointer} GATES`),
        "the Gates view",
      );
      expect(plainGates).not.toContain(HIGHLIGHT);
      expect(plainGates).not.toContain(HOVER_MARKER);

      plain.type(hoverBytes(bodyRowCell(liveSurface(plain.delivery).plan, 1)));
      const plainHovered = await plain.frame(
        (frame) => frame !== plainGates,
        "a frame the unhovered one is not",
      );
      // Nothing coloured it: at this level the runner writes no SGR 7 whatever
      // is hovered, so the whole difference is drawn cells.
      expect(plainHovered).not.toContain(HIGHLIGHT);
      expect(highlighted(plainHovered, regionOf(liveSurface(plain.delivery).plan, "items")))
        .toEqual([1]);
      // The row the operator was reading is where it was: the marker stands in
      // a cell the row already spent, so nothing shifted to make room for it.
      expect(unmarked(plainHovered)).toBe(stripAnsi(plainGates));
    } finally {
      await plain.close();
    }

    // The frame the surface draws while nothing hovers it — remove the handler
    // and this is what the hovered frame below becomes.
    const unhovered = await inked(data, interaction, null);
    for (const byte of HIGHLIGHT_BYTES) expect(unhovered).not.toContain(byte);

    const hovered = await inked(data, interaction, bodyRowCell(surface.plan, 1));
    for (const byte of HIGHLIGHT_BYTES) expect(hovered).toContain(byte);
    expect(hovered).not.toBe(unhovered);
    // On the row the plan places under that cell, and on no other row.
    expect(highlighted(hovered, items)).toEqual([1]);

    // The drawn half of it is one cell the row already spent: put the separator
    // back and every remaining cell is the unhovered frame's own, so a hover
    // shifts nothing an operator was reading.
    expect(stripAnsi(hovered)).not.toBe(stripAnsi(unhovered));
    expect(unmarked(hovered)).toBe(stripAnsi(unhovered));

    // The pointer never says where it is resting until the terminal is asked
    // for motion, so the ask carries the mode that reports it.
    expect(POINTER_TRACKING_ON).toContain("\x1b[?1003h");
    expect(POINTER_TRACKING_OFF).toContain("\x1b[?1003l");
  }, 60_000);

  test("test: moving the pointer off an item redraws it without the highlight", async () => {
    const data = pointerData();
    const { interaction, surface } = gatesSurface(data);
    const items = regionOf(surface.plan, "items");
    const rail = regionOf(surface.plan, "rail");

    // In the shipped runner first: the pointer comes to rest on an item row and
    // then moves off it, and the runner redraws its own stdout without the
    // highlight — no unmount, no second frame handed in from outside.
    const live = await liveCockpit();
    try {
      await live.frame((frame) => stripAnsi(frame).includes("RUN"), "the opening frame");
      live.type(sgrBytes(railViewCell(liveSurface(live.delivery).plan, GATES)));
      const gates = await live.frame(
        (frame) => stripAnsi(frame).includes(`${GLYPHS.pointer} GATES`),
        "the Gates view",
      );
      const plan = liveSurface(live.delivery).plan;
      live.type(hoverBytes(bodyRowCell(plan, 1)));
      await live.frame((frame) => frame.includes(HIGHLIGHT), "the highlight");
      // Off the list, onto the panel's own title row above the item band.
      live.type(hoverBytes(bodyRowCell(plan, -1)));
      const off = await live.frame(
        (frame) => !frame.includes(HIGHLIGHT),
        "the frame redrawn without the highlight",
      );
      expect(stripAnsi(off)).toBe(stripAnsi(gates));
    } finally {
      await live.close();
    }

    const unhovered = await inked(data, interaction, null);
    const onFirst = await inked(data, interaction, bodyRowCell(surface.plan, 0));
    expect(highlighted(onFirst, items)).toEqual([0]);

    // Onto the next row: the row left behind is redrawn without the highlight,
    // rather than keeping it while a second one lights up.
    const onSecond = await inked(data, interaction, bodyRowCell(surface.plan, 1));
    expect(highlighted(onSecond, items)).toEqual([1]);

    // And off the list entirely — the panel's own title row above the band, the
    // rail beside it, and the terminal handing the loan back so nothing is
    // reported at all — is the frame that was drawn before anything hovered it,
    // byte for byte.
    for (
      const [name, off] of [
        ["the panel title above the band", bodyRowCell(surface.plan, -1)],
        ["the rail beside it", press(rail.column + 2, rail.row + 1)],
        ["nowhere at all", null],
      ] as const
    ) {
      expect(await inked(data, interaction, off), name).toBe(unhovered);
    }
  }, 60_000);

  test("test: the highlight marks what a click acts on, proven by clicking where the highlight is and observing that selection", async () => {
    const data = pointerData();
    const { interaction, surface } = gatesSurface(data);
    const items = regionOf(surface.plan, "items");
    expect(surface.drawnRowIds.length).toBeGreaterThan(2);

    for (const row of [0, 2]) {
      const cell = bodyRowCell(surface.plan, row);
      // What the operator is shown the click will hit.
      const hovered = await inked(data, interaction, cell);
      expect(highlighted(hovered, items), `row ${row} highlighted`).toEqual([row]);

      // The click at that same cell, and what it actually acted on.
      const clicked = applied(cell, surface);
      expect(clicked.selection, `row ${row} selected`)
        .toBe(surface.drawnRowIds[row]);
      expect(marked(await inked(data, clicked, null), items), `row ${row} marked`)
        .toEqual([row]);
    }

    // The promise holds because there is one resolution rather than two that
    // agree: move the planned item band and the highlight and the click both
    // move with it, to the same row.
    const moved: PlannedFrame = {
      ...surface.plan,
      regions: surface.plan.regions.map((region) =>
        region.id === "items" ? { ...region, row: region.row + 1 } : region
      ),
    };
    const cell = bodyRowCell(surface.plan, 2);
    expect(pointerRowAt({ ...surface, plan: moved }, cell))
      .toBe(surface.drawnRowIds[1]);
    expect(applyPointerReport(cell, { ...surface, plan: moved })?.selection)
      .toBe(surface.drawnRowIds[1]);

    // And it holds in the states the KEYBOARD reaches, not only the one a click
    // composed. Both are one ← from the rail, and they differ in the one thing
    // that decides whether a click on an item selects it at all — where the
    // rail's marker is standing:
    //   ← alone leaves it on the view the body draws, so a click dives and then
    //     selects the row under the pointer;
    //   ← then ↓ moves it to Journal while Gates stays drawn, so the same click
    //     opens the MARKED view and selects nothing — the row under the pointer
    //     belongs to the view being left behind.
    // The claim is an equivalence, so it is swept rather than sampled: over
    // every drawn row of each state, the rows lit up are exactly the rows a
    // click at that cell is then observed to select.
    for (const [name, keys] of [
      ["the rail marking the drawn view", [BACK]],
      ["the rail marking another view", [BACK, DOWN]],
    ] as const) {
      const railed = surfaceAt(data, typed(surface, ...keys));
      expect(runFocusedPanel({
        interaction: railed.interaction,
        columns: plannedKeyColumns(railed.plan),
      }), name).toBe("VIEWS");
      const band = regionOf(railed.plan, "items");
      const lit: number[] = [];
      const acted: number[] = [];
      for (const row of railed.drawnRowIds.keys()) {
        const cell = bodyRowCell(railed.plan, row);
        lit.push(...highlighted(await inked(data, railed.interaction, cell), band));
        if (applied(cell, railed).selection === railed.drawnRowIds[row]) {
          acted.push(row);
        }
      }
      expect(lit, `${name}: lit`).toEqual(acted);
    }
  }, 60_000);

  test("test: captures record the pointerless appearance, so no highlight byte reaches a golden, anchor or colour capture", async () => {
    const data = pointerData();
    const { interaction, surface } = gatesSurface(data);
    // The highlight is reachable on this very frame, so its absence below is
    // the capture path never asking for one — not a frame that cannot draw it.
    const pointerless = await inked(data, interaction, null);
    const hoverable = await inked(data, interaction, bodyRowCell(surface.plan, 1));
    for (const byte of HIGHLIGHT_BYTES) {
      expect(pointerless).not.toContain(byte);
      expect(hoverable).toContain(byte);
    }

    // With that pointer still resting on the item row, the identical frame
    // composed the way a capture composes it — data, size and interaction, and
    // no geometry published for hit testing. A frame nothing resolves a hit
    // against cannot be hovered, so this is the pointerless frame byte for byte
    // rather than a hovered one with the highlight taken back out.
    const resting = bodyRowCell(surface.plan, 1);
    expect(pointerRestingCell())
      .toEqual({ column: resting.column, row: resting.row });
    const captured = await captureRendererOutput(
      createElement(RunCockpitFrame, { data, columns: 140, rows: 24, interaction }),
      { columns: 140, rows: 24, colour: true },
    );
    for (const byte of HIGHLIGHT_BYTES) expect(captured).not.toContain(byte);
    expect(captured).toBe(pointerless);

    // Every committed capture corpus: the layout goldens, the machine anchors
    // in their own directory beside them, and the colour corpus that is the
    // only one drawn in real ink at all. Named rather than discovered, so a
    // corpus never checked cannot pass by being missing from the roster.
    expect(Object.keys(FIXTURE_DIRS)).toEqual(["frames", "anchors", "colour"]);
    for (const [corpus, directory] of Object.entries(FIXTURE_DIRS)) {
      const fixtures = readdirSync(directory).filter((name) =>
        name.endsWith(".txt")
      );
      expect(fixtures.length, corpus).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const committed = readFileSync(join(directory, fixture), "utf8");
        for (const byte of HIGHLIGHT_BYTES) {
          expect(committed, `${fixture}: ${JSON.stringify(byte)}`)
            .not.toContain(byte);
        }
      }
    }

    // And the production path that regenerates them, in both inks — run with a
    // pointer reported to be resting squarely on an item row of the very view
    // the anchors capture. The capture publishes no geometry for hit testing,
    // so it resolves no hits and draws no highlight however the pointer came to
    // rest: the pointerless appearance is what this path draws by construction,
    // rather than what a guard strips back out of it afterwards.
    restPointer(surface, bodyRowCell(surface.plan, 1));
    for (const colour of [true, false]) {
      const anchor = terminalStream(true);
      await captureCockpitOutput({
        cockpit: "run",
        output: anchor.stream as unknown as NodeJS.WriteStream,
        binaryVersion: "9.8.7",
        columns: 140,
        rows: 24,
        colour,
        interactive: true,
        ci: false,
      });
      // Both bytes, in both inks: with colour off the ink is never written by
      // anything, so the marker is the only byte a leaked highlight could show
      // up as — the check that means something on exactly the capture that
      // regenerates the anchors.
      for (const byte of HIGHLIGHT_BYTES) {
        expect(anchor.writes.join(""), `colour ${colour}: ${JSON.stringify(byte)}`)
          .not.toContain(byte);
      }
    }
  }, 120_000);

  test("hover shows what a click would hit rather than decorating whatever the pointer passes over", async () => {
    const data = pointerData();
    const { interaction, surface } = gatesSurface(data);
    const items = regionOf(surface.plan, "items");
    const unhovered = await inked(data, interaction, null);
    const drawnRows = surface.drawnRowIds.length;
    expect(items.rows).toBeGreaterThan(drawnRows);

    // Inside the item band, below the last row the list drew: the pointer is
    // over the panel, and a click there acts on nothing — so nothing lights up.
    const empty = bodyRowCell(surface.plan, drawnRows);
    expect(pointerRowAt(surface, empty)).toBeUndefined();
    expect(applied(empty, surface).selection).toBe(interaction.selection);
    expect(await inked(data, interaction, empty)).toBe(unhovered);

    // A view whose rows no click ever selects — the journal, whose rows are a
    // record rather than a collection — is not decorated either, though the
    // pointer passes over rows there exactly as it does over the gates.
    const JOURNAL = FRAME_VIEWS.indexOf("journal");
    const onJournal = applied(railViewCell(surface.plan, JOURNAL), surface);
    const journal = surfaceAt(data, onJournal);
    expect(journal.interaction.activeView).toBe("journal");
    expect(journal.drawnRowIds).toEqual([]);
    const journalCell = bodyRowCell(journal.plan, 0);
    expect(pointerRowAt(journal, journalCell)).toBeUndefined();
    expect(await inked(data, onJournal, journalCell))
      .toBe(await inked(data, onJournal, null));

    // What is decorated is decided by the plan, not by the pointer's own row:
    // the same cell over a frame whose item band the plan placed one row lower
    // names the row above, and the highlight is drawn there.
    const shifted = bodyRowCell(surface.plan, 1);
    expect(pointerRowAt(surface, shifted)).toBe(surface.drawnRowIds[1]);
    expect(highlighted(await inked(data, interaction, shifted), items))
      .toEqual([1]);

    // The click is a ROUTE, not a lookup — and the state that proves it is two
    // advertised keys away: ← backs out to the rail, ↓ moves the marker to
    // Journal while the body still draws the Gates the operator opened. The
    // plan still places a Gates row under the pointer, so a highlight taken from
    // the row lookup alone would light one up...
    const marked = typed(surface, BACK, DOWN);
    expect(marked.activeView).toBe("gates");
    expect(FRAME_VIEWS[marked.railSelection]).toBe("journal");
    const straySurface = surfaceAt(data, marked);
    const stray = bodyRowCell(straySurface.plan, 1);
    expect(pointerRowAt(straySurface, stray)).toBe(straySurface.drawnRowIds[1]);

    // ...but the click at that very cell dives into the MARKED view: it opens
    // the journal and selects no row at all, so what it acts on is not the row
    // under the pointer. Nothing is decorated, on that row or any other.
    const dived = applied(stray, straySurface);
    expect(dived.activeView).toBe("journal");
    expect(dived.selection).toBeNull();
    const strayFrame = await inked(data, marked, stray);
    expect(highlighted(strayFrame, regionOf(straySurface.plan, "items"))).toEqual([]);
    expect(strayFrame).toBe(await inked(data, marked, null));
  }, 120_000);
});

describe("panel boundary drag — the session resize override", () => {
  afterEach(() => {
    resetSessionRailOverride();
  });

  /**
   * The rail's grab cell: the boundary column on a row the plan gives no other
   * target. A view row's last column is the view's own click target even on
   * the grab column, so the handle the drag starts from stands on one of the
   * rail's remaining rows — read off the plan's own view rows, never
   * reconstructed.
   */
  const grabCell = (plan: PlannedFrame): PointerReport => {
    const rail = regionOf(plan, "rail");
    const sidebar = plan.sidebar;
    if (sidebar === null) throw new Error("the plan drew no sidebar");
    const column = rail.column + rail.columns - 1;
    for (let row = rail.row; row < rail.row + rail.rows; row += 1) {
      if (FRAME_VIEWS.every((name) => sidebar.viewRows[name] !== row)) {
        return { action: "press", column, row, button: 0 };
      }
    }
    throw new Error("the rail drew no grab row");
  };

  /** Grab the rail's last column, drag it so the rail is `toWidth` wide, release. */
  const dragBoundary = (surface: PointerSurface, toWidth: number): void => {
    const grab = grabCell(surface.plan);
    const reports: PointerReport[] = [
      grab,
      // A real drag-motion: the motion bit set, the button still held.
      { action: "move", column: toWidth - 1, row: grab.row, button: 32 },
      { action: "release", column: toWidth - 1, row: grab.row, button: 0 },
    ];
    for (const report of reports) {
      // A drag is drawn state, never a transition: no report moves the interaction.
      expect(applyPointerReport(report, surface)).toBeUndefined();
    }
  };

  const framePlan = (plan: ReturnType<typeof planFrame>): PlannedFrame => {
    if (plan.kind !== "frame") throw new Error("the plan fell back to plain");
    return plan;
  };

  /**
   * The frame production paints for one state at 140x24, with no railColumns
   * handed in: the session override reaches the frame only through the pointer
   * layer's store — the `useSyncExternalStore` subscription the live surface
   * reads — never as a prop beside it. Returns the painted bytes and the frame
   * the renderer committed.
   */
  async function painted(
    data: RunCockpitData,
    interaction: RunInteractionState,
  ): Promise<{
    readonly output: string;
    readonly committed: PlannedRunCockpitFrame;
  }> {
    const frames: PlannedRunCockpitFrame[] = [];
    const output = await captureRendererOutput(
      createElement(RunCockpitFrame, {
        data,
        columns: 140,
        rows: 24,
        interaction,
        onCommittedFrame: (frame: PlannedRunCockpitFrame) => {
          frames.push(frame);
        },
      }),
      { columns: 140, rows: 24, colour: false },
    );
    const committed = frames.at(-1);
    if (committed === undefined) throw new Error("the frame committed nothing");
    return { output, committed };
  }

  /**
   * The drawn frame IS the recomputed plan: what the renderer committed equals
   * planFrame's own output for the exact inputs it planned from, and the
   * painted bytes conform to the plan — the real rows and per-row cell widths
   * of the surface, not a blank stand-in that cannot fail.
   */
  const asPlanned = (
    committed: PlannedRunCockpitFrame,
    output: string,
  ): PlannedFrame => {
    const planning = committed.planning;
    if (planning === undefined) throw new Error("the frame planned nothing");
    expect(committed.plan).toEqual(
      planFrame(planning.size, planning.view, planning.state),
    );
    const plan = framePlan(committed.plan);
    assertFrameConformance(plan, output);
    return plan;
  };

  /**
   * The cell columns the paint drew the body panel's left and right edges on,
   * read off the bytes of the panel's border row — the visible seam between
   * the two panels, so a redraw at new widths is asserted where the operator
   * sees it.
   */
  const paintedBodyEdges = (
    frame: string,
    body: FrameRegion,
  ): { readonly left: number; readonly right: number } => {
    const line = stripAnsi(frame).split("\n")[body.row] ?? "";
    const left = line.indexOf("╭");
    const right = line.lastIndexOf("╮");
    if (left < 0 || right < 0) {
      throw new Error("the paint drew no body panel border on its border row");
    }
    return {
      left: cellWidth(line.slice(0, left)),
      right: cellWidth(line.slice(0, right)),
    };
  };

  test("test: dragging a panel boundary redraws the panels at their new widths and the surface still fits its terminal", async () => {
    const data = pointerData();
    const interaction = openingRunInteractionState();
    const surface = surfaceAt(data, interaction, 140, 24);
    restPointer(surface, null);

    // The launch frame: the contract's constant rail, the divider one cell
    // beside it, the surface fitting its terminal.
    const launched = await painted(data, interaction);
    const launchedPlan = asPlanned(launched.committed, launched.output);
    expect(regionOf(launchedPlan, "rail").columns).toBe(RAIL_COLUMNS);
    expect(paintedBodyEdges(launched.output, regionOf(launchedPlan, "body")))
      .toEqual({ left: RAIL_COLUMNS, right: 139 });

    // The drag: press on the boundary, move, release — no transition, only the
    // session override the store now carries.
    dragBoundary(surface, RAIL_COLUMNS + 10);
    expect(sessionRailOverride()).toBe(RAIL_COLUMNS + 10);

    // The redraw: nothing is handed to the frame beside the store — the plan
    // recomputes from the measured size plus the override, and the paint draws
    // the panels at their new widths, still inside the terminal it fit before.
    const resized = await painted(data, interaction);
    expect(resized.committed.planning?.state.railColumns)
      .toBe(RAIL_COLUMNS + 10);
    const resizedPlan = asPlanned(resized.committed, resized.output);
    expect(regionOf(resizedPlan, "rail").columns).toBe(RAIL_COLUMNS + 10);
    expect(regionOf(resizedPlan, "body").column).toBe(RAIL_COLUMNS + 10);
    expect(regionOf(resizedPlan, "body").columns).toBe(140 - RAIL_COLUMNS - 10);
    expect(paintedBodyEdges(resized.output, regionOf(resizedPlan, "body")))
      .toEqual({ left: RAIL_COLUMNS + 10, right: 139 });
    expect(resized.output).not.toBe(launched.output);
  });

  test("test: a resize never persists — relaunching draws the original layout", async () => {
    const data = pointerData();
    const interaction = openingRunInteractionState();
    const surface = surfaceAt(data, interaction, 140, 24);
    restPointer(surface, null);

    const launched = await painted(data, interaction);
    expect(launched.committed.planning?.state.railColumns).toBeUndefined();
    const launchedPlan = asPlanned(launched.committed, launched.output);
    expect(regionOf(launchedPlan, "rail").columns).toBe(RAIL_COLUMNS);

    dragBoundary(surface, 40);
    expect(sessionRailOverride()).toBe(40);

    // The override lives only in the running process — nothing writes it
    // anywhere, so a relaunch carries none of it. The fresh tracking loan is
    // the session boundary: a new session borrows, and the store is clear.
    borrowPointerTracking({ isTTY: false, write: () => {} });
    expect(sessionRailOverride()).toBeNull();

    // And the layout a relaunch draws is the original one, byte-identical to
    // the launch frame's paint.
    restPointer(surface, null);
    const relaunched = await painted(data, interaction);
    expect(relaunched.committed.planning?.state.railColumns).toBeUndefined();
    const relaunchedPlan = asPlanned(relaunched.committed, relaunched.output);
    expect(regionOf(relaunchedPlan, "rail").columns).toBe(RAIL_COLUMNS);
    expect(relaunched.output).toBe(launched.output);
  });

  test("test: a drag below a panel's readable floor leaves it at the floor rather than collapsing it", async () => {
    const data = pointerData();
    const interaction = openingRunInteractionState();
    const surface = surfaceAt(data, interaction, 140, 24);
    restPointer(surface, null);

    // A drag asking for a one-column rail: the rail stands at its floor,
    // surrendered whole per the contract, and the painted surface still fits.
    dragBoundary(surface, 1);
    expect(sessionRailOverride()).toBe(1);
    const floored = await painted(data, interaction);
    expect(floored.committed.planning?.state.railColumns).toBe(1);
    const flooredPlan = asPlanned(floored.committed, floored.output);
    expect(regionOf(flooredPlan, "rail").columns)
      .toBe(RAIL_READABLE_FLOOR_COLUMNS);
    expect(regionOf(flooredPlan, "body").column)
      .toBe(RAIL_READABLE_FLOOR_COLUMNS);
    expect(regionOf(flooredPlan, "body").columns)
      .toBe(140 - RAIL_READABLE_FLOOR_COLUMNS);
    expect(paintedBodyEdges(floored.output, regionOf(flooredPlan, "body")))
      .toEqual({ left: RAIL_READABLE_FLOOR_COLUMNS, right: 139 });
    // At the floor the rail still reads: the view names draw whole.
    expect(regionCells(stripAnsi(floored.output), regionOf(flooredPlan, "rail")))
      .toContain("Journal");

    // The mirrored drag, started from the floored layout the first drag left
    // behind: the rail never widens past what leaves the body readable — the
    // body stands at its own floor, surrendered whole, never collapsed.
    dragBoundary({ ...surface, plan: flooredPlan }, 139);
    expect(sessionRailOverride()).toBe(139);
    const widened = await painted(data, interaction);
    expect(widened.committed.planning?.state.railColumns).toBe(139);
    const widenedPlan = asPlanned(widened.committed, widened.output);
    expect(regionOf(widenedPlan, "body").columns).toBe(READABLE_PANEL_COLUMNS);
    expect(regionOf(widenedPlan, "rail").columns)
      .toBe(140 - READABLE_PANEL_COLUMNS);
    expect(paintedBodyEdges(widened.output, regionOf(widenedPlan, "body")))
      .toEqual({ left: 140 - READABLE_PANEL_COLUMNS, right: 139 });
  });

  test("test: the resized layout is planFrame's output and conformance holds on it, on launch and after further resizes", async () => {
    const data = pointerData();
    const interaction = openingRunInteractionState();
    const surface = surfaceAt(data, interaction, 140, 24);
    restPointer(surface, null);

    // On launch: no override, the default layout, conformance on the real paint.
    const launched = await painted(data, interaction);
    expect(launched.committed.planning?.state.railColumns).toBeUndefined();
    asPlanned(launched.committed, launched.output);

    // After a drag: the override flows INTO the plan as an input — never a
    // bypass of it; nothing is handed to the frame beside the store — and the
    // recomputed plan conforms on the painted bytes exactly as the default did.
    dragBoundary(surface, 40);
    const resized = await painted(data, interaction);
    expect(resized.committed.planning?.state.railColumns).toBe(40);
    const resizedPlan = asPlanned(resized.committed, resized.output);
    expect(regionOf(resizedPlan, "rail").columns).toBe(40);
    expect(paintedBodyEdges(resized.output, regionOf(resizedPlan, "body")))
      .toEqual({ left: 40, right: 139 });

    // After a further resize from the resized layout itself — the boundary is
    // read off the plan the drag left behind — conformance still holds.
    dragBoundary({ ...surface, plan: resizedPlan }, 20);
    expect(sessionRailOverride()).toBe(20);
    const again = await painted(data, interaction);
    expect(again.committed.planning?.state.railColumns).toBe(20);
    expect(regionOf(asPlanned(again.committed, again.output), "rail").columns)
      .toBe(20);
  });

  test("a release lost outside the window latches no drag: the first no-button motion ends it", () => {
    const data = pointerData();
    const surface = surfaceAt(data, openingRunInteractionState(), 140, 24);

    // Press the boundary, then let go past the terminal's edge — the natural
    // way to ask for the widest rail, and a release no terminal ever sends.
    expect(applyPointerReport(grabCell(surface.plan), surface)).toBeUndefined();
    // The next report is a bare hover-motion: SGR button 35, no button held —
    // the terminal saying the drag is already over. It resizes nothing.
    const [hover] = parsePointerReports("\x1b[<35;61;12M");
    expect(hover).toEqual({ action: "move", column: 60, row: 11, button: 35 });
    expect(applyPointerReport(hover!, surface)).toBeUndefined();
    expect(sessionRailOverride()).toBeNull();

    // And the latch is gone with the drag: the surface answers pointer input
    // again — a press on the Gates row is the view's own number key.
    const clicked = applied(railViewCell(surface.plan, GATES), surface);
    expect(clicked.activeView).toBe("gates");
  });

  test("a drag whose release never arrives swallows nothing: the next press is its own action", () => {
    const data = pointerData();
    const surface = surfaceAt(data, openingRunInteractionState(), 140, 24);

    // Grab the boundary and drag — then the release is lost entirely.
    const grab = grabCell(surface.plan);
    expect(applyPointerReport(grab, surface)).toBeUndefined();
    expect(
      applyPointerReport(
        { action: "move", column: 24, row: grab.row, button: 32 },
        surface,
      ),
    ).toBeUndefined();
    expect(sessionRailOverride()).toBe(25);

    // A fresh press is no drag content: the dead latch may not eat it — it
    // takes its ordinary route, the Gates view's own number key.
    const clicked = applied(railViewCell(surface.plan, GATES), surface);
    expect(clicked.activeView).toBe("gates");
  });
});
