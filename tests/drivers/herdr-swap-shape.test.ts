import { describe, expect, test } from "vitest";

// OBS-561: the board died at birth on every real run while the suite stayed green, because the
// driver read `result.changed` and the fixture ASSERTED that same invented shape. herdr answers a
// swap at `result.swap.changed`. The capture below is verbatim stdout from
// `herdr pane swap --source-pane … --target-pane …` on herdr 0.8.0 (2026-08-24), trimmed only of
// the layout block's pane rectangles. A hand-written shape is what let the defect ship, so this
// fixture must stay a capture: if herdr's response moves, re-capture it, never edit it to fit.
const VERBATIM_SWAP_OK =
  '{"id":"cli:pane:swap","result":{"swap":{"changed":true,"focused_pane_id":"wZ:pBW",' +
  '"source_pane_id":"wZ:pBW","target_pane_id":"wZ:pBV"},"type":"pane_swap"}}';

// The same call when herdr declines the swap: zero exit, changed:false. This is the shape that
// must FAIL closed — an exit code alone proves nothing about the geometry.
const VERBATIM_SWAP_DECLINED =
  '{"id":"cli:pane:swap","result":{"swap":{"changed":false,"reason":"panes are not siblings"},"type":"pane_swap"}}';

// The driver's guard, extracted to the exact expression under test. Keep this identical to
// src/drivers/herdr.ts's swap verification; if that changes, this pin must change with it.
function swapChangedOf(stdout: string): unknown {
  try {
    const result = JSON.parse(stdout).result;
    return result?.swap?.changed ?? result?.changed;
  } catch {
    return undefined;
  }
}

describe("herdr pane swap response shape (OBS-561)", () => {
  test("a real successful swap is read as changed:true", () => {
    expect(swapChangedOf(VERBATIM_SWAP_OK)).toBe(true);
  });

  test("the pre-fix guard read undefined from the SAME real response — the shipped defect", () => {
    // The falsification control: this is what src/drivers/herdr.ts did before the fix. It must NOT
    // see the flag, which is precisely why every successful swap was judged failed and the board
    // was discarded. If this ever returns true, the guard is no longer reading what herdr answers.
    const preFix = JSON.parse(VERBATIM_SWAP_OK).result?.changed;
    expect(preFix).toBeUndefined();
  });

  test("a declined swap still fails closed", () => {
    expect(swapChangedOf(VERBATIM_SWAP_DECLINED)).toBe(false);
  });

  test("unparseable output fails closed rather than passing the guard", () => {
    expect(swapChangedOf("herdr: connection refused")).toBeUndefined();
  });

  test("a legacy flat shape is still accepted so an older socket verifies", () => {
    expect(swapChangedOf('{"result":{"changed":true}}')).toBe(true);
  });
});
