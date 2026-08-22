import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { BOARD_HEIGHT_SHARE, boardSplitPlan, TRAILER_SAFE_FLOOR_COLS, TRAILER_WIDTH_MARGIN, workerSplitDirection, type BoardPlacement } from "../../src/drivers/herdr.js";

const FIX = join(import.meta.dirname, "../fixtures/trailer-width");
const MEAS = FIX;
const RESULTS = join(MEAS, "results.json");
const DOC = join(FIX, "43-MEASUREMENT.md");
const NONCE = "vis09probe";

describe("VIS-09 trailer-width measurement gate", () => {
  if (existsSync(RESULTS)) {
    const results = JSON.parse(readFileSync(RESULTS, "utf8")) as {
      cols: number;
      capture: string;
      repeat: number;
      parseOk: boolean;
      cli: string;
      cliVersion: string;
    }[];

    test("measurement verdicts are derived, not narrated", () => {
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const e of results) {
        const raw = readFileSync(join(MEAS, e.capture), "utf8");
        const parsed = parseWorkerResult(raw, NONCE);
        expect(parsed.ok).toBe(e.parseOk);
      }
    });

    test("every capture carries its provenance", () => {
      for (const e of results) {
        const raw = readFileSync(join(MEAS, e.capture), "utf8");
        expect(raw).toMatch(new RegExp(`PROBE_TPUT_COLS=${e.cols}`));
        expect(raw).toContain(e.cliVersion.split("\n")[0]);
        expect(raw).toMatch(/cursor-agent|Cursor Agent/i);
      }
    });

    test("43-MEASUREMENT.md records Grid licensed or Grid refused", () => {
      const md = readFileSync(DOC, "utf8");
      expect(md).toMatch(/Grid (licensed|refused)/);
    });
  } else {
    test("probe refused — no captures required", () => {
      const md = readFileSync(DOC, "utf8");
      expect(md).toContain("## Probe refused");
    });
  }
});

describe("workerSplitDirection (43-MEASUREMENT.md licensed geometry)", () => {
  test("incident-e8aa003 and degenerate widths → down", () => {
    for (const w of [2, 4, 25, 50, 100, 108]) {
      expect(workerSplitDirection(w)).toBe("down");
    }
  });

  test("comfortably-wide terminal geometry → right", () => {
    expect(workerSplitDirection(222)).toBe("right");
    expect(workerSplitDirection(220)).toBe("right");
  });

  test("width introspection failure → down (fail closed)", () => {
    expect(workerSplitDirection(null)).toBe("down");
    expect(workerSplitDirection(0)).toBe("down");
  });

  test("safety floor and margin match 43-MEASUREMENT.md constants", () => {
    expect(TRAILER_SAFE_FLOOR_COLS).toBe(108);
    expect(TRAILER_WIDTH_MARGIN).toBe(2);
    // terminal 222 → half 111 ≥ 108+2 licenses right
    expect(workerSplitDirection(222, TRAILER_SAFE_FLOOR_COLS, TRAILER_WIDTH_MARGIN)).toBe("right");
  });
});

// v1.99 T2: the board is no longer placed by width at all. Two width-derived arrangements shipped
// and both were wrong in the operator's tab — the halving floor sent a 189-column board below the
// seat, and the width-first side split put the board shoulder to shoulder with the narration it is
// supposed to sit above. The plan is now one record: stacked above the caller, full width, 72% of
// the height, whatever the terminal measures.
describe("boardSplitPlan (the invariant vertical stack)", () => {
  // the closed matrix: the incident geometry, the two widths the side split used to switch between,
  // a degenerate terminal, and the unmeasurable caller every earlier plan fell back on.
  const CALLER_WIDTH_MATRIX: (number | null)[] = [null, 0, 2, 40, 108, 140, 149, 150, 189, 220, 400];

  test("test: the board-placement plan remains invariant across the closed caller-width matrix and equals the single approved vertical-stack record, whereas any width-sensitive record fails", () => {
    const APPROVED: BoardPlacement = { direction: "down", ratio: 0.72, swap: "above" };
    expect(boardSplitPlan()).toEqual(APPROVED); // the plan an unmeasured caller gets
    expect(BOARD_HEIGHT_SHARE).toBe(0.72); // board 72 / narration 28

    for (const callerCols of CALLER_WIDTH_MATRIX) {
      expect(boardSplitPlan(callerCols), String(callerCols)).toEqual(APPROVED);
    }
    // ONE record across the whole matrix — deep-equality per width would still pass if the plan
    // merely happened to agree pairwise, so the distinct-record count is what is asserted.
    const distinct = new Set(CALLER_WIDTH_MATRIX.map((cols) => JSON.stringify(boardSplitPlan(cols))));
    expect(distinct).toEqual(new Set([JSON.stringify(APPROVED)]));

    // the control: a width-sensitive record — the shipped v1.94 plan, board width allocated first —
    // answers the same matrix with more than one arrangement and is not the approved stack at all.
    const widthSensitive = (callerCols: number | null) =>
      callerCols == null || callerCols < 150
        ? { direction: "down", boardCols: null }
        : { direction: "right", ratio: Math.round(((callerCols - 110) / callerCols) * 1e4) / 1e4, boardCols: 110 };
    const controlRecords = new Set(CALLER_WIDTH_MATRIX.map((cols) => JSON.stringify(widthSensitive(cols))));
    expect(controlRecords.size).toBeGreaterThan(1); // width picked the arrangement — the defect
    expect(widthSensitive(220)).not.toEqual(APPROVED);
  });
});
