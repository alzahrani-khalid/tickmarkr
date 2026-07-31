import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import {
  captureRendererOutput,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  COCKPIT_COLUMN_FLOOR,
  COCKPIT_ROW_FLOOR,
  FRAME_CONTRACT_DOMAIN,
  FRAME_HEADER_GAP,
  FRAME_HEADER_PARTS,
  FRAME_SURRENDER_ORDER,
  FULL_LAYOUT_ROWS,
  FULL_JOURNAL_ROWS,
  HEADER_FIXED_CELLS,
  LAYOUT_PRIORITY,
  RAIL_COLUMNS,
  SIDEBAR_VITALS_COMPACT_ELEMENT_ROWS,
  SIDEBAR_VITALS_FULL_ELEMENT_ROWS,
  SIDEBAR_VITALS_ORDER,
  STANDARD_TAIL_HEIGHT,
  planFrame,
  planSidebar,
  resolveCockpitLayout,
  type FrameCockpitLayout,
  type PlannedFrame,
} from "../../src/tui/cockpit/layout.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
} from "../../src/tui/cockpit/run-cockpit.js";

/** A run caption of realistic production length (59 cells). */
const PRODUCTION_CAPTION =
  "run-20260729-134319 · tickmarkr/run-20260729-134319 · human";
const PRODUCTION_CAPTION_CELLS = PRODUCTION_CAPTION.length;

function planned(columns: number, rows: number, captionCells = 0): PlannedFrame {
  const plan = planFrame({ columns, rows }, "tasks", { captionCells });
  expect(plan.kind).toBe("frame");
  if (plan.kind !== "frame") {
    throw new Error(`expected a frame plan at ${columns}x${rows}`);
  }
  return plan;
}

function* contractDomain() {
  for (
    let columns = FRAME_CONTRACT_DOMAIN.minColumns;
    columns <= FRAME_CONTRACT_DOMAIN.maxColumns;
    columns += 1
  ) {
    for (
      let rows = FRAME_CONTRACT_DOMAIN.minRows;
      rows <= FRAME_CONTRACT_DOMAIN.maxRows;
      rows += 1
    ) {
      yield { columns, rows };
    }
  }
}

function frame(columns: number, rows: number): FrameCockpitLayout {
  const layout = resolveCockpitLayout(columns, rows);
  expect(layout.renderer).toBe("frame");
  if (layout.renderer !== "frame") {
    throw new Error(`expected a frame at ${columns}x${rows}`);
  }
  return layout;
}

describe("cockpit terminal layout policy", () => {
  test("each contracted width band selects its own arrangement, asserted at both edges of every band", () => {
    expect(frame(40, FULL_LAYOUT_ROWS).arrangement).toBe("stacked");
    expect(frame(89, FULL_LAYOUT_ROWS).arrangement).toBe("stacked");
    expect(frame(90, FULL_LAYOUT_ROWS).arrangement).toBe("folded-keys");
    expect(frame(119, FULL_LAYOUT_ROWS).arrangement).toBe("folded-keys");
    expect(frame(120, FULL_LAYOUT_ROWS).arrangement).toBe("three-column");
    expect(frame(240, FULL_LAYOUT_ROWS).arrangement).toBe("three-column");
  });

  test("at every height at or above the contracted floor the version, the keybar and the status strip are all retained", () => {
    for (const columns of [40, 89, 90, 119, 120, 240]) {
      for (let rows = COCKPIT_ROW_FLOOR; rows <= 200; rows += 1) {
        expect(frame(columns, rows).elements).toMatchObject({
          version: true,
          keybar: true,
          statusStrip: true,
        });
      }
    }
  });

  test("as height decreases, elements are surrendered in the contracted priority order, lowest priority first, and no higher-priority element is dropped while a lower one survives", () => {
    const retainedByPriority = (layout: FrameCockpitLayout) => [
      layout.elements.keybar,
      layout.elements.statusStrip,
      layout.elements.primaryHeader,
      layout.elements.progressBar,
      layout.journalRows > 0,
      layout.elements.progressCaption,
      layout.stats.mode === "tiles",
      layout.elements.secondaryHeader,
    ];

    for (let rows = FULL_LAYOUT_ROWS; rows >= COCKPIT_ROW_FLOOR; rows -= 1) {
      const retained = retainedByPriority(frame(120, rows));
      for (let lower = 1; lower < retained.length; lower += 1) {
        if (retained[lower]) {
          expect(retained.slice(0, lower).every(Boolean)).toBe(true);
        }
      }
    }

    expect(retainedByPriority(frame(120, 19))).toEqual([
      true, true, true, true, true, true, true, true,
    ]);
    expect(retainedByPriority(frame(120, 18))).toEqual([
      true, true, true, true, true, true, true, false,
    ]);
    expect(retainedByPriority(frame(120, 17))).toEqual([
      true, true, true, true, true, true, false, false,
    ]);
    expect(retainedByPriority(frame(120, 16))).toEqual([
      true, true, true, true, true, false, false, false,
    ]);
  });

  test("below the contracted row floor or the contracted column floor the policy selects the plain renderer rather than a frame", () => {
    expect(resolveCockpitLayout(40, 13)).toEqual({
      renderer: "plain",
      arrangement: "plain",
    });
    expect(resolveCockpitLayout(39, 14)).toEqual({
      renderer: "plain",
      arrangement: "plain",
    });
    expect(resolveCockpitLayout(39, 13)).toEqual({
      renderer: "plain",
      arrangement: "plain",
    });
    expect(resolveCockpitLayout(40, 14).renderer).toBe("frame");
  });

  test("the row floor and the column floor are pinned at 14 rows and 40 columns, so moving either fails a test rather than silently shifting the cliff", () => {
    expect(COCKPIT_ROW_FLOOR).toBe(14);
    expect(COCKPIT_COLUMN_FLOOR).toBe(40);
  });

  test("as height decreases the stat tiles collapse into a single summary line still carrying their figures, rather than being removed from the frame", () => {
    expect(frame(120, 18).stats).toEqual({
      mode: "tiles",
      rows: 2,
      figures: ["tasks", "gates", "pass"],
    });
    expect(frame(120, 17).stats).toEqual({
      mode: "summary",
      rows: 1,
      figures: ["tasks", "gates", "pass"],
    });
    expect(frame(120, COCKPIT_ROW_FLOOR).stats).toEqual({
      mode: "summary",
      rows: 1,
      figures: ["tasks", "gates", "pass"],
    });
  });

  test("the journal panel shrinks toward a single row and never to none while any row remains available to it", () => {
    expect(frame(120, 16).journalRows).toBe(3);
    expect(frame(120, 15).journalRows).toBe(2);
    expect(frame(120, 14).journalRows).toBe(1);

    for (let rows = COCKPIT_ROW_FLOOR; rows <= 200; rows += 1) {
      expect(frame(120, rows).journalRows).toBeGreaterThanOrEqual(1);
    }
  });

  test("height beyond what the full arrangement needs is absorbed by the journal panel and by no other element", () => {
    const full = frame(120, FULL_LAYOUT_ROWS);
    expect(full.journalRows).toBe(FULL_JOURNAL_ROWS);

    for (const rows of [FULL_LAYOUT_ROWS + 1, 24, 40, 80]) {
      const expanded = frame(120, rows);
      expect(expanded.journalRows).toBe(FULL_JOURNAL_ROWS + rows - FULL_LAYOUT_ROWS);
      expect({
        ...expanded.rowAllocation,
        journal: full.rowAllocation.journal,
      }).toEqual(full.rowAllocation);
    }
  });

  test("the tiers are produced by one ordered policy rather than by a table of per-height layouts", () => {
    expect(LAYOUT_PRIORITY).toEqual([
      "keybar",
      "statusStrip",
      "primaryHeader",
      "progressBar",
      "journal",
      "progressCaption",
      "statTiles",
      "secondaryHeader",
    ]);
  });
});

describe("planFrame — the pure frame plan over the whole contract domain", () => {
  test("the planned row spans of every region sum to the height and no planned column exceeds the width, at every width and height in the contract domain", () => {
    for (const { columns, rows } of contractDomain()) {
      const plan = planned(columns, rows);
      const rowTotal = Object.values(plan.rowSpans).reduce(
        (sum, span) => sum + span,
        0,
      );
      expect(rowTotal).toBe(rows);
      const columnTotal = Object.values(plan.columnSpans).reduce(
        (sum, span) => sum + span,
        0,
      );
      expect(columnTotal).toBe(columns);
      for (const region of plan.regions) {
        expect(region.column).toBeGreaterThanOrEqual(0);
        expect(region.column + region.columns).toBeLessThanOrEqual(columns);
        expect(region.row).toBeGreaterThanOrEqual(0);
        expect(region.row + region.rows).toBeLessThanOrEqual(rows);
      }
    }
  });

  test("no size in the contract domain plans a negative or zero span for any region, including when a production-length caption forces the fit check to surrender regions in order", () => {
    let sawSurrenderedCaption = false;
    let sawFittedCaption = false;
    let sawOrderedSurrender = false;
    for (const { columns, rows } of contractDomain()) {
      const plan = planned(columns, rows, PRODUCTION_CAPTION_CELLS);
      for (const region of plan.regions) {
        expect(region.rows).toBeGreaterThanOrEqual(1);
        expect(region.columns).toBeGreaterThanOrEqual(1);
      }
      for (const span of Object.values(plan.rowSpans)) {
        expect(span).toBeGreaterThanOrEqual(1);
      }
      for (const span of Object.values(plan.columnSpans)) {
        expect(span).toBeGreaterThanOrEqual(1);
      }
      // The fit check's decision, recomputed independently: the surrendered
      // list must be the declared order filtered to the regions that do not
      // fit — both membership and order are asserted, not push order.
      const unfitInOrder = FRAME_SURRENDER_ORDER.filter((id) =>
        id === "caption"
          ? columns - HEADER_FIXED_CELLS < PRODUCTION_CAPTION_CELLS
          : rows < STANDARD_TAIL_HEIGHT,
      );
      expect(plan.surrendered).toEqual(unfitInOrder);
      if (unfitInOrder.length > 1) sawOrderedSurrender = true;
      // The caption is surrendered exactly when it cannot fit the header.
      const captionPlanned = plan.regions.some(({ id }) => id === "caption");
      expect(captionPlanned).toBe(
        columns - HEADER_FIXED_CELLS >= PRODUCTION_CAPTION_CELLS,
      );
      if (captionPlanned) {
        sawFittedCaption = true;
        expect(plan.surrendered).not.toContain("caption");
      } else {
        sawSurrenderedCaption = true;
        expect(plan.surrendered).toContain("caption");
      }
    }
    expect(sawSurrenderedCaption).toBe(true);
    expect(sawFittedCaption).toBe(true);
    expect(sawOrderedSurrender).toBe(true);
    // A size that surrenders both regions surrenders them in the declared order.
    expect(planned(40, 14, PRODUCTION_CAPTION_CELLS).surrendered).toEqual([
      "caption",
      "tail",
    ]);
  });

  test("exactly one element per axis absorbs surplus, so widening grows only the flexible column and adding rows grows only the body region", () => {
    const heightTier = (rows: number) => (rows >= 24 ? 2 : rows >= 16 ? 1 : 0);
    for (const { columns, rows } of contractDomain()) {
      const plan = planned(columns, rows);
      expect(plan.flexible).toEqual({ row: "body", column: "body" });
      // Widening by one column inside a band grows only the body column;
      // the rail stays constant and full-width bands are not column regions.
      if (columns < FRAME_CONTRACT_DOMAIN.maxColumns) {
        const wider = planned(columns + 1, rows);
        if (wider.band === plan.band) {
          for (const [id, span] of Object.entries(wider.columnSpans)) {
            expect(span).toBe(
              plan.columnSpans[id] + (id === plan.flexible.column ? 1 : 0),
            );
          }
          expect(wider.rowSpans).toEqual(plan.rowSpans);
        }
      }
      // Adding one row inside a height tier grows only the body region.
      if (rows < FRAME_CONTRACT_DOMAIN.maxRows && heightTier(rows + 1) === heightTier(rows)) {
        const taller = planned(columns, rows + 1);
        for (const [id, span] of Object.entries(taller.rowSpans)) {
          expect(span).toBe(
            plan.rowSpans[id] + (id === plan.flexible.row ? 1 : 0),
          );
        }
        expect(taller.columnSpans).toEqual(plan.columnSpans);
      }
      // At a tier boundary the tail is restored whole, never squeezed: the
      // added row funds it, and when the restored tier is taller the body
      // pays the rest — the spans still tile exactly, so the body and tail
      // deltas sum to the one added row while every other band holds.
      if (rows < FRAME_CONTRACT_DOMAIN.maxRows && heightTier(rows + 1) !== heightTier(rows)) {
        const taller = planned(columns, rows + 1);
        const tailGrowth = (taller.rowSpans.tail ?? 0) - (plan.rowSpans.tail ?? 0);
        expect(tailGrowth).toBeGreaterThan(0);
        expect(taller.rowSpans.body - plan.rowSpans.body + tailGrowth).toBe(1);
        for (const [id, span] of Object.entries(taller.rowSpans)) {
          if (id !== "body" && id !== "tail") {
            expect(span).toBe(plan.rowSpans[id]);
          }
        }
        expect(taller.columnSpans).toEqual(plan.columnSpans);
      }
    }
  });

  test("below the width floor or the height floor the plan is the plain fallback rather than a frame", () => {
    expect(planFrame({ columns: 39, rows: 24 })).toEqual({
      kind: "plain",
      size: { columns: 39, rows: 24 },
    });
    expect(planFrame({ columns: 80, rows: 13 })).toEqual({
      kind: "plain",
      size: { columns: 80, rows: 13 },
    });
    expect(planFrame({ columns: 39, rows: 13 }).kind).toBe("plain");
    expect(planFrame({ columns: Number.NaN, rows: 24 }).kind).toBe("plain");
    expect(planFrame({ columns: 80, rows: Number.NaN }).kind).toBe("plain");
    expect(planFrame({ columns: COCKPIT_COLUMN_FLOOR, rows: COCKPIT_ROW_FLOOR }).kind).toBe("frame");
  });

  test("the plan is a pure function of the measured size — the same size yields an identical plan and planning performs no read of the live terminal", () => {
    const size = { columns: 137, rows: 31 };
    const state = { captionCells: PRODUCTION_CAPTION_CELLS };
    expect(planFrame(size, "tasks", state)).toEqual(planFrame(size, "tasks", state));
    expect(planFrame(size, "tasks", state)).toEqual(
      planFrame({ ...size }, "tasks", { ...state }),
    );

    // Any read of the live terminal during planning throws; the plan must
    // come out identical anyway because it is a function of its arguments.
    const live: Array<"columns" | "rows"> = ["columns", "rows"];
    const originals = live.map(
      (key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)] as const,
    );
    for (const key of live) {
      Object.defineProperty(process.stdout, key, {
        configurable: true,
        get() {
          throw new Error(`planFrame read the live terminal (${key})`);
        },
      });
    }
    try {
      expect(planFrame(size, "tasks", state)).toEqual(planFrame(size, "tasks", state));
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) {
          Object.defineProperty(process.stdout, key, descriptor);
        }
      }
    }
  });

  test("the sidebar band holds a constant 15-column rail while the strip band plans the view strip under the header at full width", () => {
    const strip = planned(40, 24);
    expect(strip.band).toBe("strip");
    expect(strip.rowSpans.strip).toBe(1);
    expect(strip.columnSpans).toEqual({ body: 40 });
    expect(strip.regions.some(({ id }) => id === "rail")).toBe(false);

    for (const columns of [64, 100, 140, 220]) {
      const sidebar = planned(columns, 24);
      expect(sidebar.band).toBe("sidebar");
      expect(sidebar.columnSpans).toEqual({
        rail: RAIL_COLUMNS,
        body: columns - RAIL_COLUMNS,
      });
      expect(sidebar.regions.some(({ id }) => id === "strip")).toBe(false);
    }
  });

  test("the approved 140×24 contract frame plans header, rule, a 16-row body, a second rule, a 3-row tail, status and keybar — every chrome row owned by a region", () => {
    const plan = planned(140, 24);
    expect(plan.rowSpans).toEqual({
      header: 1,
      rule: 1,
      body: 16,
      rule2: 1,
      tail: 3,
      status: 1,
      keybar: 1,
    });
    expect(plan.columnSpans).toEqual({ rail: RAIL_COLUMNS, body: 125 });
    // The separator above the tail is the second rule, row 18 of 24.
    expect(plan.regions.find(({ id }) => id === "rule2")).toEqual({
      id: "rule2",
      row: 18,
      rows: 1,
      column: 0,
      columns: 140,
    });
  });

  test("the fixed header cells are pinned to the composed header text, so a header composition change fails this test instead of letting the caption overrun the tabs", () => {
    const approvedHeaderFixedText = "tickmarkr 1.83.0   [ WATCH ]   SETUP";
    expect(FRAME_HEADER_PARTS.join(FRAME_HEADER_GAP)).toBe(
      approvedHeaderFixedText,
    );
    expect(HEADER_FIXED_CELLS).toBe(approvedHeaderFixedText.length);
  });

  test("the view and state decide what each flexible band draws — the Journal view is the full-height tail, SETUP turns the tail into PENDING WRITES, an open detail owns the body — without moving any span", () => {
    const size = { columns: 140, rows: 24 };
    const tasks = planFrame(size, "tasks");
    expect(tasks.kind).toBe("frame");
    if (tasks.kind !== "frame") throw new Error("expected a frame plan");
    expect(tasks.content).toEqual({ body: "rows", tail: "journal" });
    expect(tasks.view).toBe("tasks");
    expect(tasks.tab).toBe("watch");

    const journal = planFrame(size, "journal");
    expect(journal.kind).toBe("frame");
    if (journal.kind !== "frame") throw new Error("expected a frame plan");
    expect(journal.content.body).toBe("journal");

    const detail = planFrame(size, "tasks", { detail: true });
    expect(detail.kind).toBe("frame");
    if (detail.kind !== "frame") throw new Error("expected a frame plan");
    expect(detail.content.body).toBe("detail");

    const setup = planFrame(size, "tasks", { tab: "setup" });
    expect(setup.kind).toBe("frame");
    if (setup.kind !== "frame") throw new Error("expected a frame plan");
    expect(setup.tab).toBe("setup");
    expect(setup.content.tail).toBe("pending-writes");

    // Geometry is owned by the plan and identical across views and states.
    for (const variant of [journal, detail, setup]) {
      expect(variant.rowSpans).toEqual(tasks.rowSpans);
      expect(variant.columnSpans).toEqual(tasks.columnSpans);
      expect(variant.regions).toEqual(tasks.regions);
    }
  });
});

describe("planFrame — the sidebar's planned composition", () => {
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

  function sidebarPlan(columns: number, rows: number): PlannedFrame {
    const plan = planned(columns, rows);
    expect(plan.band, `${columns}x${rows} bands a sidebar`).toBe("sidebar");
    if (plan.sidebar === null) {
      throw new Error(`expected a sidebar plan at ${columns}x${rows}`);
    }
    return plan;
  }

  function vitalsRows(plan: PlannedFrame): number {
    const sidebar = plan.sidebar!;
    return sidebar.vitals.length * (sidebar.vitalsMode === "full"
      ? SIDEBAR_VITALS_FULL_ELEMENT_ROWS
      : SIDEBAR_VITALS_COMPACT_ELEMENT_ROWS);
  }

  test("test: at every size in the contract domain where the sidebar draws both menu and vitals, at least one blank row separates them", async () => {
    // Plan level, over the whole domain: wherever any vitals element draws —
    // the menu always draws — the plan funds at least one blank row between
    // the last menu row and the first vitals row.
    let sawSidebar = false;
    for (const { columns, rows } of contractDomain()) {
      const plan = planned(columns, rows);
      if (plan.band !== "sidebar") continue;
      sawSidebar = true;
      if (plan.sidebar!.vitals.length === 0) continue;
      expect(plan.sidebar!.gapRows, `${columns}x${rows}`)
        .toBeGreaterThanOrEqual(1);
    }
    expect(sawSidebar).toBe(true);

    // Render level, at the height tiers and the width edges: the rows the plan
    // leaves between the menu and the vitals are blank in the drawn rail.
    const source = loadDemoCaptures().journals.find((capture) =>
      capture.fileName === "run-20260724-231138.journal.jsonl"
    );
    if (!source) throw new Error("eventful cockpit capture is missing");
    const data = deriveRunCockpitData(source, "9.8.7");
    for (
      const [columns, rows] of [
        [64, 14],
        [64, 16],
        [64, 18],
        [64, 24],
        [100, 24],
        [140, 24],
        [220, 50],
      ] as const
    ) {
      const plan = sidebarPlan(columns, rows);
      const sidebar = plan.sidebar!;
      const rail = plan.regions.find((region) => region.id === "rail")!;
      const frame = (await captureRendererOutput(
        createElement(RunCockpitFrame, { data, columns, rows }),
        { columns, rows, colour: false },
      )).replace(ANSI, "");
      const lines = frame.split("\n");
      const railCells = (row: number) =>
        [...lines[row] ?? []].slice(rail.column, rail.column + rail.columns)
          .join("");
      const firstVitalsRow = rail.row + rail.rows - vitalsRows(plan);
      expect(sidebar.vitals.length, `${columns}x${rows} vitals draw`)
        .toBeGreaterThan(0);
      expect(
        firstVitalsRow - (rail.row + sidebar.menuRows),
        `${columns}x${rows} drawn gap`,
      ).toBeGreaterThanOrEqual(1);
      for (
        let row = rail.row + sidebar.menuRows;
        row < firstVitalsRow;
        row += 1
      ) {
        expect(railCells(row).trim(), `${columns}x${rows} row ${row} is blank`)
          .toBe("");
      }
      // The menu ends where the plan says it ends: its last row is painted.
      expect(
        railCells(rail.row + sidebar.menuRows - 1).trim(),
        `${columns}x${rows} last menu row`,
      ).not.toBe("");
    }
  });

  test("test: the vitals block anchors to the sidebar bottom, and a too-short sidebar surrenders whole vitals elements, never the gap", () => {
    // Anchored: at every sidebar size in the domain the menu, the gap and the
    // vitals tile the rail exactly, so the block's last row is the rail's last.
    for (const { columns, rows } of contractDomain()) {
      const plan = planned(columns, rows);
      if (plan.band !== "sidebar") continue;
      const sidebar = plan.sidebar!;
      const rail = plan.regions.find((region) => region.id === "rail")!;
      expect(
        sidebar.menuRows + sidebar.gapRows + vitalsRows(plan),
        `${columns}x${rows}`,
      ).toBe(rail.rows);
      if (sidebar.vitals.length > 0) {
        expect(sidebar.gapRows, `${columns}x${rows}`).toBeGreaterThanOrEqual(1);
      }
    }

    // Surrender: walking the rail shorter, whole elements go from the top of
    // the block — the meter is surrendered last — and the gap is never what
    // closes. The kept elements are always a suffix of the block order.
    for (let railRows = 0; railRows <= 30; railRows += 1) {
      const sidebar = planSidebar(railRows);
      expect(sidebar.vitals, `rail ${railRows}`).toEqual(
        SIDEBAR_VITALS_ORDER.slice(
          SIDEBAR_VITALS_ORDER.length - sidebar.vitals.length,
        ),
      );
      if (sidebar.vitals.length > 0) {
        expect(sidebar.gapRows, `rail ${railRows}`).toBeGreaterThanOrEqual(1);
      } else {
        expect(sidebar.gapRows, `rail ${railRows}`).toBe(0);
      }
      // An element draws whole or not at all: the full mode is the whole block.
      if (sidebar.vitalsMode === "full") {
        expect(sidebar.vitals, `rail ${railRows}`).toEqual(SIDEBAR_VITALS_ORDER);
      }
    }
    // The short-rail sequence, pinned: 9 rows keeps every element compact,
    // then tasks goes, then gates, and the meter stands alone before the gap
    // is ever traded away.
    expect(planSidebar(9).vitals).toEqual(["tasks", "gates", "meter"]);
    expect(planSidebar(9).gapRows).toBe(1);
    expect(planSidebar(8)).toEqual({
      menuRows: 5,
      gapRows: 1,
      vitalsMode: "compact",
      vitals: ["gates", "meter"],
    });
    expect(planSidebar(7)).toEqual({
      menuRows: 5,
      gapRows: 1,
      vitalsMode: "compact",
      vitals: ["meter"],
    });
    expect(planSidebar(6)).toEqual({
      menuRows: 5,
      gapRows: 0,
      vitalsMode: "compact",
      vitals: [],
    });
  });

  test("test: the machine-surface anchors byte-match what the renderer draws with the separated sidebar, so the frozen tier is current", async () => {
    const anchors = join(import.meta.dirname, "../fixtures/cockpit/anchors");
    const generated = await regenerateGoldenFrames();
    for (
      const fixture of ["run.ci.140x24.txt", "run.non-tty.140x24.txt"] as const
    ) {
      const rendered = generated.find((frame) => frame.fixture === fixture);
      if (!rendered) throw new Error(`the manifest drew no ${fixture}`);
      const frozen = readFileSync(join(anchors, fixture), "utf8");
      expect(frozen, fixture).toBe(rendered.output);
    }
  });
});
