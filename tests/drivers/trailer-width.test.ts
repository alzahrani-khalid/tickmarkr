import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { TRAILER_SAFE_FLOOR_COLS, TRAILER_WIDTH_MARGIN, workerSplitDirection } from "../../src/drivers/herdr.js";

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
