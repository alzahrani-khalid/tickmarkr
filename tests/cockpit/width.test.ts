import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  cellWidth,
  fitCells,
  graphemeClusters,
  locateCell,
  sliceCells,
  wrapCells,
} from "../../src/tui/cockpit/width.js";

/** Every awkward cluster class the cockpit can be handed, in one string. */
const CLUSTERED = "ab中👨‍👩‍👧‍👦🇺🇸é✈️z";

describe("cockpit display-cell width measured by grapheme cluster", () => {
  test("a string containing a ZWJ family sequence measures the cells the sequence occupies as one cluster rather than the sum of its code points", () => {
    // Four people joined by three zero-width joiners: seven code points,
    // one grapheme cluster, two display cells.
    const family = "👨‍👩‍👧‍👦";
    expect([...family].length).toBe(7);
    expect(graphemeClusters(`a${family}b`)).toEqual(["a", family, "b"]);
    expect(cellWidth(family)).toBe(2);
    expect(cellWidth(`a${family}b`)).toBe(4);
  });

  test("regional-indicator flag pairs, skin-tone modifiers and variation selectors each measure as a single cluster", () => {
    const flag = "🇺🇸"; // regional indicator U + regional indicator S
    const waved = "👋🏽"; // waving hand + medium skin-tone modifier
    const plane = "✈️"; // airplane + emoji variation selector (VS16)
    for (const cluster of [flag, waved, plane]) {
      expect(graphemeClusters(cluster)).toEqual([cluster]);
      expect([...cluster].length).toBeGreaterThan(1);
      expect(cellWidth(cluster)).toBe(2);
    }
    // Adjacent flags stay separate clusters — pairing is per two indicators.
    expect(graphemeClusters("🇺🇸🇯🇵")).toEqual(["🇺🇸", "🇯🇵"]);
    expect(cellWidth("🇺🇸🇯🇵")).toBe(4);
  });

  test("zero-width combining marks add no cells, so an accented decomposed string measures the same as its precomposed form", () => {
    // Escaped, not literal: an editor or an encoding pass silently
    // normalises a decomposed literal back into its precomposed form.
    const precomposed = "Caf\u00E9"; // e-acute as one code point
    const decomposed = "Cafe\u0301"; // e + combining acute accent
    expect(decomposed).not.toBe(precomposed);
    expect(decomposed.normalize("NFC")).toBe(precomposed);
    expect([...decomposed].length).toBeGreaterThan([...precomposed].length);
    expect(cellWidth(decomposed)).toBe(cellWidth(precomposed));
    expect(cellWidth(precomposed)).toBe(4);
    // Stacked marks pile onto one cell, however many of them there are.
    expect(cellWidth("a\u0301\u0308\u0327")).toBe(1);
    // Virama is also a combining mark. The locked base-width table charges
    // U+094D separately, so keep cluster-level coverage outside Latin marks.
    const devanagariWithVirama = "क्";
    expect([...devanagariWithVirama]).toHaveLength(2);
    expect(cellWidth(devanagariWithVirama)).toBe(1);
  });

  test("string-width is pinned to the runtime version already resolved by the lockfile", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies?.["string-width"]).toBe("5.1.2");
  });

  test("resolving a cell offset inside a string never lands in the middle of a grapheme cluster at any offset in the string", () => {
    const clusters = graphemeClusters(CLUSTERED);
    const boundaries: number[] = [];
    let total = 0;
    for (const cluster of clusters) {
      boundaries.push(total);
      total += cellWidth(cluster);
    }
    expect(total).toBe(cellWidth(CLUSTERED));

    for (let offset = 0; offset < total; offset += 1) {
      const located = locateCell(CLUSTERED, offset);
      expect(located).not.toBeNull();
      if (located === null) continue;
      // The resolution lands on a cluster boundary and spans the whole
      // cluster, never a fraction of it — the second cell of a double-cell
      // cluster resolves to that same cluster, not to a half of it.
      expect(boundaries).toContain(located.cellStart);
      expect(located.cluster).toBe(clusters[located.clusterIndex]);
      expect(located.cellEnd).toBe(located.cellStart + cellWidth(located.cluster));
      expect(offset).toBeGreaterThanOrEqual(located.cellStart);
      expect(offset).toBeLessThan(located.cellEnd);
      // Cutting at that offset cuts on the same boundaries: the head is
      // always a whole-cluster prefix, never a fraction of one.
      const { head } = sliceCells(CLUSTERED, offset);
      expect(clusters.slice(0, graphemeClusters(head).length).join("")).toBe(head);
    }

    expect(locateCell(CLUSTERED, total)).toBeNull();
    expect(locateCell(CLUSTERED, -1)).toBeNull();
  });

  test("measuring, locating, cutting and clipping compose the cockpit's column and wrap work with no cell arithmetic left to the caller", () => {
    // A fixed column: the clip is exactly its span at every width, so a
    // region can never overflow and never under-fills.
    for (let column = 0; column <= cellWidth(CLUSTERED) + 3; column += 1) {
      const clipped = fitCells(CLUSTERED, column);
      expect(cellWidth(clipped)).toBe(Math.max(0, column));
      const visible = clipped.replace(/ +$/u, "");
      // What survives is a whole-cluster prefix of the input, never a half
      // glyph — at column 3 the two-cell 中 has one cell to live in, so it is
      // dropped and the cell padded rather than half-drawn.
      expect(graphemeClusters(CLUSTERED).slice(0, graphemeClusters(visible).length)
        .join("")).toBe(visible);
    }
    expect(fitCells("中", 1)).toBe(" ");
    expect(fitCells("ab", 4)).toBe("ab  ");

    // A wrap: cutting until the tail runs out reconstructs the input exactly,
    // charges each row the cells it really occupies, and always advances —
    // even at a budget too narrow for the widest glyph.
    for (const budget of [1, 2, 5, 7]) {
      const rows: string[] = [];
      let rest = CLUSTERED;
      while (rest.length > 0 && rows.length <= graphemeClusters(CLUSTERED).length) {
        const { head, tail, cells } = sliceCells(rest, budget);
        expect(head).not.toBe("");
        expect(cells).toBe(cellWidth(head));
        // Only a single glyph wider than the whole budget may exceed it.
        if (cells > budget) expect(graphemeClusters(head)).toHaveLength(1);
        rows.push(head);
        rest = tail;
      }
      expect(rest).toBe("");
      expect(rows.join("")).toBe(CLUSTERED);
    }
    expect(sliceCells(CLUSTERED, 0)).toEqual({ head: "", tail: CLUSTERED, cells: 0 });

    // A cursor: stepping by located cluster walks the whole string in cluster
    // steps and lands exactly on its end.
    let cell = 0;
    let steps = 0;
    while (cell < cellWidth(CLUSTERED)) {
      cell = locateCell(CLUSTERED, cell)!.cellEnd;
      steps += 1;
    }
    expect(steps).toBe(graphemeClusters(CLUSTERED).length);
    expect(cell).toBe(cellWidth(CLUSTERED));
  });

  test("wrapping into rows is cluster-safe at every budget, so a caller states where to break and never counts cells to do it", () => {
    const text = `run ${CLUSTERED} tail 🇺🇸 end`;
    const sourceClusters = graphemeClusters(text);

    for (let budget = 1; budget <= cellWidth(text) + 2; budget += 1) {
      const rows = wrapCells(text, budget);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // No cluster is split, invented or dropped — including ordinary spaces.
      // A row that cut through a ZWJ sequence would leave fragments that match
      // nothing, while a dropped separator would fail exact reconstruction.
      expect(rows.flatMap(graphemeClusters)).toEqual(sourceClusters);
      expect(rows.join("")).toBe(text);
      for (const row of rows) {
        // Only a lone glyph too wide for the whole budget may exceed it —
        // the same escape hatch `sliceCells` documents, so a wrap advances.
        if (cellWidth(row) > budget) {
          expect(graphemeClusters(row)).toHaveLength(1);
        }
      }
    }

    // Greedy, breaking between words, cutting a word too wide for a row of
    // its own — the semantics the live callers hand-roll today.
    expect(wrapCells("one two three", 7)).toEqual(["one two", " three"]);
    expect(wrapCells("aaaaaa bb", 4)).toEqual(["aaaa", "aa", " bb"]);
    expect(wrapCells("", 8)).toEqual([""]);
    // Spacing survives exactly at breaks and at the edges. Consecutive spaces
    // become real one-cell rows at a one-cell budget, never empty sentinels.
    expect(wrapCells("one two", 3)).toEqual(["one", " tw", "o"]);
    expect(wrapCells(" a ", 1)).toEqual([" ", "a", " "]);
    expect(wrapCells("a  b", 1)).toEqual(["a", " ", " ", "b"]);
    expect(wrapCells("a  b", 8)).toEqual(["a  b"]);
    for (const [spaced, budget] of [
      ["one two", 3],
      [" a ", 1],
      ["a  b", 1],
      ["  a b  ", 2],
    ] as const) {
      const rows = wrapCells(spaced, budget);
      expect(rows.join("")).toBe(spaced);
      expect(rows.every((row) => row.length > 0)).toBe(true);
    }

    // A continuation marker is width policy owned by the module. Every
    // returned row already fits, so callers do not subtract marker cells.
    const continued = wrapCells("abcdefgh", 4, {
      continuationPrefix: "↳ ",
    });
    expect(continued).toEqual(["abcd", "↳ ef", "↳ gh"]);
    expect(continued.every((row) => cellWidth(row) <= 4)).toBe(true);
    expect(continued.map((row, index) => index === 0 ? row : row.slice(2)).join(""))
      .toBe("abcdefgh");
    const wideContinuation = wrapCells("abcd中x", 3, {
      continuationPrefix: "↳ ",
    });
    expect(wideContinuation).toEqual(["abc", "↳ d", "中", "↳ x"]);
    expect(wideContinuation.every((row) => cellWidth(row) <= 3)).toBe(true);

    // A space carrying a combining mark is one cluster and is not an ordinary
    // word separator at all.
    const markedSpace = "a ́b"; // space + combining acute = ONE cluster
    expect(graphemeClusters(markedSpace)).toEqual(["a", " ́", "b"]);
    expect(wrapCells(markedSpace, 1)).toEqual(["a", " ́", "b"]);
  });

  test("ANSI controls are zero-width atomic units for measurement, location, slicing and clipping", () => {
    const red = "\u001B[31mred\u001B[0m";
    expect(cellWidth(red)).toBe(3);
    expect(locateCell(red, 0)?.cluster).toBe("r");
    expect(sliceCells(red, 2)).toEqual({
      head: "\u001B[31mre",
      tail: "d\u001B[0m",
      cells: 2,
    });
    expect(sliceCells(red, 3)).toEqual({ head: red, tail: "", cells: 3 });
    expect(fitCells(red, 3)).toBe(red);

    // OSC hyperlinks are one control token at each end too; none of their
    // payload bytes may be exposed as visible cells or cut into fragments.
    const link = "\u001B]8;;https://example.test\u0007go\u001B]8;;\u0007";
    expect(cellWidth(link)).toBe(2);
    expect(sliceCells(link, 1)).toEqual({
      head: "\u001B]8;;https://example.test\u0007g",
      tail: "o\u001B]8;;\u0007",
      cells: 1,
    });
  });

  test("the module covers every cell operation the cockpit's live call sites perform, so migrating one removes arithmetic rather than moving it", () => {
    // components.tsx longestBandLine — widest of a set of lines.
    const lines = ["ok", "👨‍👩‍👧‍👦 family", "中中中"];
    expect(Math.max(...lines.map(cellWidth))).toBe(9);

    // components.tsx takeDisplayColumns — cut into [head, tail] at a column.
    const { head, tail } = sliceCells("👋🏽ok", 2);
    expect([head, tail]).toEqual(["👋🏽", "ok"]);

    // run-cockpit.tsx wrappedRows — how many rows a line will occupy. Its
    // `[...word].length` charges the family seven columns and predicts two
    // rows; the terminal draws two cells and one row. That gap is the defect
    // this module retires, and the row count is now a length, not a formula.
    const line = "👨‍👩‍👧‍👦 ok";
    expect([...line].length).toBe(10);
    expect(cellWidth(line)).toBe(5);
    expect(wrapCells(line, 5)).toEqual([line]);
    expect(wrapCells(line, 5)).toHaveLength(1);

    // components.tsx keyRosterLines — hard wrap of a run with no break point.
    expect(wrapCells("🇺🇸🇯🇵🇺🇸", 4)).toEqual(["🇺🇸🇯🇵", "🇺🇸"]);

    // Fixed-column paint — exact span, cut on a cluster boundary.
    expect(cellWidth(fitCells(CLUSTERED, 9))).toBe(9);

    // Cursor placement — a cell resolves to a whole glyph, never half of one.
    expect(locateCell("👋🏽ok", 1)?.cluster).toBe("👋🏽");
  });
});
