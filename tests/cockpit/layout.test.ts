import { describe, expect, test } from "vitest";
import {
  COCKPIT_COLUMN_FLOOR,
  COCKPIT_ROW_FLOOR,
  FULL_LAYOUT_ROWS,
  FULL_JOURNAL_ROWS,
  LAYOUT_PRIORITY,
  resolveCockpitLayout,
  type FrameCockpitLayout,
} from "../../src/tui/cockpit/layout.js";

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
