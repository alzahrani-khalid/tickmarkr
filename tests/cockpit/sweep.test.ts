import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  COCKPIT_CONTRACT_DOMAIN,
  COCKPIT_MARK_ALPHABET,
  COCKPIT_SIDEBAR_COLUMNS,
  COCKPIT_SIDEBAR_CONTENT_COLUMNS,
  COCKPIT_SIDEBAR_GUTTER_COLUMNS,
  GOLDEN_FRAME_CASES,
  captureCockpitOutput,
  cockpitFrameContractExpectation,
  findHeaderSignatures,
  goldenFrameMatchesCommitted,
  inspectCockpitFrameContract,
  isRetiredGoldenFrame,
  regenerateGoldenFrames,
  type CockpitFrameContractInspection,
} from "../../src/tui/cockpit/capture.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import { planFrame } from "../../src/tui/cockpit/layout.js";

const SELF = join(import.meta.dirname, "sweep.test.ts");
/**
 * The committed baseline, under the sweep's own fixture path. It is a fixture on
 * disk rather than a constant in here precisely so the target and the test that
 * reads it cannot drift into agreement in one edit.
 */
const BASELINE = join(
  import.meta.dirname,
  "../fixtures/cockpit/sweep/domain-violations.txt",
);
/**
 * The frozen appearance tier after the redesign. The six rendered anchors the
 * contract superseded remain as declared-retired evidence; the declaration,
 * not their absence, removes them from comparisons. The two machine surfaces
 * remain live byte pins: no retirement or projection reaches them.
 */
const ANCHORS = join(import.meta.dirname, "../fixtures/cockpit/anchors");

const DOMAIN = COCKPIT_CONTRACT_DOMAIN;

/** Every property the contract's artwork decides, and how each is judged. */
const PROPERTIES = [
  "tiles",
  "width",
  "header",
  "mark",
  "keybar",
  "sidebar-content",
  "sidebar-gutter",
  "sidebar-focus",
  "list-selection",
] as const;
type PropertyId = (typeof PROPERTIES)[number];

/**
 * The whole judgement of one painted frame, in one place: each property is
 * decided against what the contract's artwork draws at that very size, so the
 * sweep never carries a second opinion about geometry.
 */
function violationsAt(
  inspection: CockpitFrameContractInspection,
  columns: number,
  rows: number,
): PropertyId[] {
  const artwork = cockpitFrameContractExpectation(columns, rows);
  const held: Readonly<Record<PropertyId, boolean>> = {
    "tiles": inspection.tiles === artwork.tiles,
    "width": inspection.withinWidth === artwork.withinWidth,
    "header": inspection.headerCount === artwork.headerCount,
    "mark": inspection.markGlyphCount === artwork.markGlyphCount,
    "keybar": inspection.keybarContained === artwork.keybarContained,
    "sidebar-content":
      inspection.sidebarContentColumns === artwork.sidebarContentColumns,
    "sidebar-gutter":
      inspection.sidebarGutterColumns === artwork.sidebarGutterColumns,
    // Focus is counted per zone: exactly one marker in the navigation zone,
    // at most one selection marker in the active list.
    "sidebar-focus":
      inspection.sidebarFocusMarkers === artwork.sidebarFocusMarkers,
    "list-selection": inspection.listSelectionMarkers <= 1,
  };
  return PROPERTIES.filter((property) => !held[property]);
}

const violationKey = (
  property: PropertyId,
  columns: number,
  rows: number,
): string => `${property} ${columns}x${rows}`;

/** `40-63` / `24` / `14-18,40-50` — inclusive, in either field. */
function expandSpec(spec: string): number[] {
  return spec.split(",").flatMap((part) => {
    const [low, high] = part.split("-").map(Number);
    const to = high ?? low!;
    return Array.from({ length: to - low! + 1 }, (_, step) => low! + step);
  });
}

/** The committed bands, expanded to one entry per violation. */
function committedBaseline(): Set<string> {
  const baseline = new Set<string>();
  for (const line of readFileSync(BASELINE, "utf8").split("\n")) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith("#")) continue;
    const [property, columnSpec, rowSpec] = text.split(/\s+/u);
    expect(PROPERTIES, `baseline names a real property: ${text}`)
      .toContain(property);
    for (const columns of expandSpec(columnSpec!)) {
      for (const rows of expandSpec(rowSpec!)) {
        baseline.add(violationKey(property as PropertyId, columns, rows));
      }
    }
  }
  return baseline;
}

/** Violations the observed sweep holds that the committed baseline does not. */
const regressions = (
  observed: readonly string[],
  baseline: ReadonlySet<string>,
): string[] => [...new Set(observed)].filter((entry) => !baseline.has(entry)).sort();

type SweptDomain = {
  readonly covered: number;
  readonly violations: readonly string[];
  readonly plainPairs: readonly string[];
  readonly samples: ReadonlyMap<string, string>;
};

/** Sizes whose painted frame is kept for the falsification checks below. */
const SAMPLED = new Set(["80x24", "140x24", "220x50"]);

/**
 * Paint every size in the contract domain through the production capture path
 * and judge each painted frame. Nothing here composes a frame: the bytes judged
 * are the bytes the renderer wrote.
 */
async function sweepDomain(): Promise<SweptDomain> {
  const captures = loadDemoCaptures();
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = DOMAIN.columns.maximum;
  output.rows = DOMAIN.rows.maximum;
  output.resume();

  const violations: string[] = [];
  const plainPairs: string[] = [];
  const samples = new Map<string, string>();
  let covered = 0;
  for (
    let columns = DOMAIN.columns.minimum;
    columns <= DOMAIN.columns.maximum;
    columns += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (
      let rows = DOMAIN.rows.minimum;
      rows <= DOMAIN.rows.maximum;
      rows += 1
    ) {
      const emission = await captureCockpitOutput({
        cockpit: "run",
        output: output as unknown as NodeJS.WriteStream,
        binaryVersion: "9.8.7",
        columns,
        rows,
        interactive: true,
        colour: false,
        ci: false,
        captures,
      });
      const at = `${columns}x${rows}`;
      if (emission.renderer !== "frame") plainPairs.push(at);
      if (SAMPLED.has(at)) samples.set(at, emission.output);
      for (
        const property of violationsAt(
          inspectCockpitFrameContract(emission.output, columns, rows),
          columns,
          rows,
        )
      ) {
        violations.push(violationKey(property, columns, rows));
      }
      covered += 1;
    }
  }
  return { covered, violations, plainPairs, samples };
}

let sweptOnce: Promise<SweptDomain> | undefined;
const swept = (): Promise<SweptDomain> => (sweptOnce ??= sweepDomain());

const DOMAIN_PAIRS =
  (DOMAIN.columns.maximum - DOMAIN.columns.minimum + 1)
  * (DOMAIN.rows.maximum - DOMAIN.rows.minimum + 1);

/** One painted row rewritten — the falsification lever, never a frame source. */
function rewriteRow(
  frame: string,
  row: number,
  rewrite: (line: string) => string,
): string {
  return frame.split("\n").map((line, index) =>
    index === row ? rewrite(line) : line
  ).join("\n");
}

const cellsOf = (line: string): string[] => [...line];

/** One painted cell overwritten, at the row and column the paint put it. */
function writeCell(
  frame: string,
  row: number,
  column: number,
  glyph: string,
): string {
  return rewriteRow(frame, row, (line) => {
    const cells = cellsOf(line);
    if (column >= cells.length) return line;
    cells[column] = glyph;
    return cells.join("");
  });
}

/**
 * The single reading each property is decided from. Kept apart from the
 * property list so a falsification can say which reading moved, and so a
 * property that is a proxy for another shows up as a reading that moves when
 * it was not supposed to.
 */
const READINGS: Readonly<
  Record<PropertyId, (inspection: CockpitFrameContractInspection) => string>
> = {
  "tiles": (inspection) =>
    JSON.stringify([
      inspection.boundaries.grid,
      inspection.boundaries.ruleRows,
      inspection.boundaries.dividerColumns,
      inspection.boundaries.dividerSpans,
    ]),
  "width": (inspection) => JSON.stringify(inspection.withinWidth),
  "header": (inspection) => JSON.stringify(inspection.headerCount),
  "mark": (inspection) => JSON.stringify(inspection.markGlyphCount),
  "keybar": (inspection) => JSON.stringify(inspection.boundaries.keyRows),
  "sidebar-content": (inspection) =>
    JSON.stringify(inspection.sidebarContentColumns),
  "sidebar-gutter": (inspection) =>
    JSON.stringify(inspection.sidebarGutterColumns),
  "sidebar-focus": (inspection) =>
    JSON.stringify(inspection.sidebarFocusMarkers),
  "list-selection": (inspection) =>
    JSON.stringify(inspection.listSelectionMarkers),
};

/** Which readings two inspections of the same size disagree on. */
const movedReadings = (
  before: CockpitFrameContractInspection,
  after: CockpitFrameContractInspection,
): PropertyId[] =>
  PROPERTIES.filter((property) =>
    READINGS[property](before) !== READINGS[property](after)
  );

const FOCUS_MARKER = "❯";
const MARK_GLYPHS = new RegExp(COCKPIT_MARK_ALPHABET, "gu");

type Falsifier = {
  readonly id: string;
  readonly disturbs: readonly PropertyId[];
  readonly mutate: (bytes: string) => string;
};

type OracleProbe = {
  /** The renderer bytes every falsifier mutates. Nothing composes these. */
  readonly frame: string;
  readonly painted: readonly string[];
  readonly base: CockpitFrameContractInspection;
  readonly keybarRow: number;
  readonly falsifiers: readonly Falsifier[];
};

/**
 * Build the falsification levers from one swept frame. Every lever is an edit
 * of bytes the renderer drew — the paint supplies its own boundary glyph, its
 * own header signature and its own key row, so a lever cannot smuggle in frame
 * chrome this file would have had to invent.
 */
async function probeOracle(): Promise<OracleProbe> {
  const { samples } = await swept();
  const frame = samples.get("140x24")!;
  const plan = planFrame({ columns: 140, rows: 24 });
  if (plan.kind !== "frame") throw new Error("140x24 must plan a frame");
  const body = plan.regions.find((region) => region.id === "body")!;
  const rail = plan.regions.find((region) => region.id === "rail")!;
  const keybar = plan.regions.find((region) => region.id === "keybar")!;
  const base = inspectCockpitFrameContract(frame, 140, 24);
  const painted = frame.split("\n");
  const bodyRows = Array.from(
    { length: body.rows },
    (_unused, step) => body.row + step,
  );

  // The frame's own boundary glyph, harvested from the first span the
  // inspector actually recognized, with a free cell beside it.
  const boundaryColumn = base.boundaries.dividerColumns[0]!;
  const boundaryRow = base.boundaries.dividerSpans.find(
    (span) => span.column === boundaryColumn,
  )?.row;
  expect(boundaryRow, "a painted body row carries the first vertical")
    .toBeGreaterThanOrEqual(0);
  const boundaryCells = cellsOf(painted[boundaryRow!]!);
  expect(boundaryCells[boundaryColumn + 1], "the vertical has a free neighbour")
    .toBe(" ");
  const boundaryGlyph = boundaryCells[boundaryColumn]!;

  // The header the paint drew, taken from where the paint drew it.
  const signatures = findHeaderSignatures(painted);
  expect(signatures.length, "the paint draws one header signature").toBe(1);
  const signature = signatures[0]!;
  const signatureCells = cellsOf(signature.text);

  const widestRow = painted.reduce(
    (widest, line, row) =>
      cellsOf(line).length > cellsOf(painted[widest]!).length ? row : widest,
    0,
  );
  // A row no other reading reads: outside the body band, carrying no key
  // label, no mark glyph and no boundary of its own, and wide enough to take a
  // duplicate signature at a nonzero indentation, whether the artwork's own
  // signature begins at column zero or is itself inset.
  const quietPlacement = painted.flatMap((line, row) => {
    const cells = cellsOf(line);
    if (
      bodyRows.includes(row)
      || row === signature.row
      || base.boundaries.keyRows.includes(row)
      || line.match(MARK_GLYPHS) !== null
      || line.includes(boundaryGlyph)
    ) return [];
    const column = cells.findIndex((_cell, candidate) =>
      candidate > 0
      && candidate + signatureCells.length <= cells.length
      && cells[candidate - 1] === " "
      && (cells[candidate + signatureCells.length] ?? " ") === " "
    );
    return column < 0 ? [] : [[row, column] as const];
  })[0];
  expect(quietPlacement, "a painted row outside every other reading")
    .toBeDefined();
  const [quietRow, duplicateHeaderColumn] = quietPlacement!;
  const quietColumn = cellsOf(painted[quietRow!]!).findIndex((cell) => cell === " ");
  expect(quietColumn, "the quiet row has one cell a mark can occupy")
    .toBeGreaterThanOrEqual(0);
  const lastKeyRow = base.boundaries.keyRows.at(-1)!;
  const freeCell = (from: number, to: number): readonly [number, number] => {
    for (const row of bodyRows) {
      const cells = cellsOf(painted[row] ?? "");
      for (let column = from; column < to; column += 1) {
        if (cells[column] === " ") return [row, column];
      }
    }
    throw new Error(`no free painted cell in ${from}..${to}`);
  };
  const [railRow, railColumn] = freeCell(rail.column, rail.column + rail.columns);
  const [listRow, listColumn] = freeCell(body.column, body.column + body.columns);

  return {
    frame,
    painted,
    base,
    keybarRow: keybar.row,
    falsifiers: [
      {
        id: "the rail's boundary moves one column, at unchanged dimensions",
        disturbs: ["tiles"],
        mutate: (bytes) =>
          writeCell(
            writeCell(bytes, boundaryRow!, boundaryColumn + 1, boundaryGlyph),
            boundaryRow!,
            boundaryColumn,
            " ",
          ),
      },
      {
        id: "one cell is removed from a boundary whose offset still exists on other rows",
        disturbs: ["tiles"],
        mutate: (bytes) =>
          writeCell(bytes, boundaryRow!, boundaryColumn, " "),
      },
      {
        id: "one painted row runs past the contracted width",
        disturbs: ["width"],
        mutate: (bytes) => rewriteRow(bytes, widestRow, (line) => `${line}x`),
      },
      {
        // The duplicate is planted at a guaranteed nonzero indentation: a
        // check anchored at the start of a line would miss it.
        id: "a second header signature is drawn at a nonzero indentation",
        disturbs: ["header"],
        mutate: (bytes) =>
          rewriteRow(bytes, quietRow, (line) => {
            const cells = cellsOf(line);
            signatureCells.forEach((glyph, step) => {
              cells[duplicateHeaderColumn + step] = glyph;
            });
            return cells.join("");
          }),
      },
      {
        id: "one mark glyph is put back into the paint",
        disturbs: ["mark"],
        mutate: (bytes) =>
          writeCell(bytes, quietRow, quietColumn, String.fromCodePoint(0x2580)),
      },
      {
        id: "the key labels move one row above their band, which is left blank",
        disturbs: ["keybar"],
        mutate: (bytes) =>
          rewriteRow(
            rewriteRow(bytes, lastKeyRow - 1, () => painted[lastKeyRow]!),
            lastKeyRow,
            () => "",
          ),
      },
      {
        id: "the rail's content band and gutter are redrawn at the divider cell",
        disturbs: ["tiles", "sidebar-content", "sidebar-gutter"],
        mutate: (bytes) =>
          bodyRows.reduce(
            (carried, row) =>
              rewriteRow(carried, row, (line) => {
                const cells = cellsOf(line);
                if (cells.length <= COCKPIT_SIDEBAR_COLUMNS) return line;
                for (let column = 0; column < COCKPIT_SIDEBAR_COLUMNS; column += 1) {
                  if (cells[column] !== FOCUS_MARKER) cells[column] = " ";
                }
                cells[COCKPIT_SIDEBAR_COLUMNS] = boundaryGlyph;
                return cells.join("");
              }),
            bytes,
          ),
      },
      {
        id: "a second focus marker appears in the navigation zone",
        disturbs: ["sidebar-focus"],
        mutate: (bytes) => writeCell(bytes, railRow, railColumn, FOCUS_MARKER),
      },
      {
        id: "a second selection marker appears in the active list",
        disturbs: ["list-selection"],
        mutate: (bytes) => writeCell(bytes, listRow, listColumn, FOCUS_MARKER),
      },
    ],
  };
}

let probedOnce: Promise<OracleProbe> | undefined;
const probed = (): Promise<OracleProbe> => (probedOnce ??= probeOracle());

describe("cockpit whole-domain appearance oracle", () => {
  test("sweep.test.ts carries the preserved tag's sweep substance adapted to the merged declaration model, with no assertion weakened and both falsification levers exercising a planted violation", async () => {
    expect(DOMAIN).toEqual({
      columns: { minimum: 40, maximum: 220 },
      rows: { minimum: 14, maximum: 50 },
    });
    // The rail the artwork draws, and the one blank cell before its divider.
    expect([COCKPIT_SIDEBAR_CONTENT_COLUMNS, COCKPIT_SIDEBAR_GUTTER_COLUMNS])
      .toEqual([15, 1]);

    const { covered, violations, plainPairs } = await swept();
    expect(covered).toBe(DOMAIN_PAIRS);
    expect(plainPairs).toEqual([]);
    expect(regressions(violations, committedBaseline())).toEqual([]);

    // Every one of the properties is load-bearing, proven on bytes the renderer
    // drew: each falsifier edits the paint the way one property is supposed to
    // notice, and the readings that move are exactly the ones it declares. A
    // property that ignored the bytes would move nothing; a property that was a
    // proxy for another would move alongside it.
    const { frame, painted, base, keybarRow, falsifiers } =
      await probed();
    const read = (bytes: string) => inspectCockpitFrameContract(bytes, 140, 24);

    // Indentation is not part of the signature. The baseline is allowed to
    // start at column zero; the falsifier below proves an additional copy at a
    // nonzero column is still counted.
    expect(base.headerCount).toBe(1);

    const falsified = new Set<PropertyId>();
    for (const falsifier of falsifiers) {
      const after = read(falsifier.mutate(frame));
      expect(movedReadings(base, after), falsifier.id)
        .toEqual([...falsifier.disturbs]);
      // No verdict moves outside the blast radius the falsifier declared.
      const before = violationsAt(base, 140, 24);
      const verdicts = violationsAt(after, 140, 24);
      expect(
        PROPERTIES.filter((property) =>
          before.includes(property) !== verdicts.includes(property)
        ).every((property) => falsifier.disturbs.includes(property)),
        `${falsifier.id} moves no verdict it did not declare`,
      ).toBe(true);
      for (const property of falsifier.disturbs) falsified.add(property);
    }
    expect([...falsified].sort()).toEqual([...PROPERTIES].sort());

    // The three readings a weaker oracle would have let through, stated against
    // the same painted bytes. Moving a region while the outer rectangle is
    // untouched: line count and every line's width are what they were, and the
    // tiling reading still moves, so tiling is region ownership rather than a
    // filled rectangle.
    const falsifier = (property: PropertyId) =>
      falsifiers.find((candidate) => candidate.disturbs[0] === property)!;
    const moved = falsifier("tiles").mutate(frame).split("\n");
    expect(moved.length).toBe(painted.length);
    expect(moved.map((line) => cellsOf(line).length))
      .toEqual(painted.map((line) => cellsOf(line).length));
    expect(READINGS.tiles(read(moved.join("\n"))))
      .not.toBe(READINGS.tiles(base));

    // A duplicate header drawn at an indentation is still counted even though
    // that copy does not begin its line.
    const doubled = falsifier("header").mutate(frame).split("\n");
    const doubledSignatures = findHeaderSignatures(doubled);
    expect(doubledSignatures).toHaveLength(2);
    expect(doubledSignatures.some((hit) => hit.column > 0)).toBe(true);
    expect(read(doubled.join("\n")).headerCount).toBe(2);

    // And a keybar painted one row above its own band, with the band left
    // blank: the keys are then on the last painted row — which is exactly what
    // "wherever the paint ended" would have accepted — and the reading says
    // they are outside the band the plan allocated.
    const displaced = falsifier("keybar").mutate(frame).split("\n");
    const lastPainted = displaced.reduce(
      (last, line, row) => (line.trim().length > 0 ? row : last),
      -1,
    );
    const displacedRead = read(displaced.join("\n"));
    expect(displacedRead.boundaries.keyRows).toContain(lastPainted);
    expect(displacedRead.boundaries.keyRows).not.toContain(keybarRow);
    expect(displacedRead.keybarContained).toBe(false);
  }, 600_000);

  test("test: the sweep asserts those properties against frames the real renderer drew and never against inspection values the test constructs for itself, each property falsified by mutating renderer-drawn bytes, and its baseline is a per-violation fixture committed under tests/fixtures/cockpit/sweep compared by subset, so a partial renderer fix goes green on what it fixed and only a regression goes red", async () => {
    const { violations, plainPairs, samples } = await swept();
    const source = readFileSync(SELF, "utf8");

    // Renderer-drawn: every pair took the frame path, and re-running the same
    // capture reproduces the very bytes the sweep judged.
    expect(plainPairs).toEqual([]);
    expect(samples.size).toBe(SAMPLED.size);
    const captures = loadDemoCaptures();
    for (const [at, bytes] of samples) {
      const [columns, rows] = at.split("x").map(Number);
      const output = new PassThrough() as PassThrough & {
        isTTY: boolean;
        columns: number;
        rows: number;
      };
      output.isTTY = true;
      output.columns = columns!;
      output.rows = rows!;
      output.resume();
      const emission = await captureCockpitOutput({
        cockpit: "run",
        output: output as unknown as NodeJS.WriteStream,
        binaryVersion: "9.8.7",
        columns: columns!,
        rows: rows!,
        interactive: true,
        colour: false,
        ci: false,
        captures,
      });
      expect(emission.renderer, at).toBe("frame");
      expect(emission.output, at).toBe(bytes);
      expect(bytes.length, at).toBeGreaterThan(0);
    }
    // Never test-authored: this file owns no means of composing a frame — no
    // repeated rule glyphs, no padded line builder, and not one glyph of frame
    // chrome anywhere in it. The only frames it can judge are painted ones.
    expect(source).not.toMatch(/\.repeat\(/u);
    expect(source).not.toMatch(/padEnd\(|padStart\(/u);
    expect(source).not.toMatch(/[\u2500-\u257f]/u);
    // Nor any means of composing an inspection: every reading judged above is
    // returned by the inspector, never stated here as a field of its own. An
    // inspection literal has to carry all of these names as its own keys, so a
    // test-authored verdict cannot be assembled without tripping this.
    expect(source).not.toMatch(
      /(?<!["'\w.])(?:withinWidth|headerCount|markGlyphCount|keybarContained|sidebarContentColumns|sidebarGutterColumns|sidebarFocusMarkers|listSelectionMarkers)\s*:/u,
    );

    // Each property falsified by mutating renderer-drawn bytes: the levers all
    // start from the swept capture itself, every property is covered by one,
    // and each lever's output is an edit of that paint — some painted lines
    // survive it untouched and at least one does not.
    const { frame, painted, falsifiers } = await probed();
    expect(frame).toBe(samples.get("140x24"));
    expect([...new Set(falsifiers.flatMap((lever) => lever.disturbs))].sort())
      .toEqual([...PROPERTIES].sort());
    for (const lever of falsifiers) {
      const mutated = lever.mutate(frame).split("\n");
      const kept = painted.filter((line, row) => mutated[row] === line);
      expect(kept.length, `${lever.id} keeps painted rows`).toBeGreaterThan(0);
      expect(kept.length, `${lever.id} changes painted rows`)
        .toBeLessThan(painted.length);
    }

    // The baseline is the committed fixture, read from disk and never restated
    // here, so a violation and its permission cannot drift into agreement.
    const committed = readFileSync(BASELINE, "utf8");
    const bands = committed.split("\n").filter((line) =>
      line.trim().length > 0 && !line.trim().startsWith("#")
    );
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      expect(source.includes(band.trim()), `restates: ${band}`).toBe(false);
    }
    const baseline = committedBaseline();
    // Per violation, not per band: the fixture expands to one entry each, and
    // the comparison below is over those entries.
    expect(baseline.size).toBeGreaterThan(bands.length);
    expect(baseline.size).toBeGreaterThanOrEqual(new Set(violations).size);

    // Subset, so the sweep is green today and stays green on a partial fix.
    expect(regressions(violations, baseline)).toEqual([]);
    for (const dropped of [1, Math.floor(violations.length / 2)]) {
      const partiallyFixed = [...new Set(violations)].slice(dropped);
      expect(regressions(partiallyFixed, baseline), `fixed ${dropped}`)
        .toEqual([]);
    }
    expect(regressions([], baseline)).toEqual([]);

    // And red on a regression: a violation the fixture does not name is named.
    const unnamed = violationKey(
      "list-selection",
      DOMAIN.columns.minimum,
      DOMAIN.rows.minimum,
    );
    expect(baseline.has(unnamed)).toBe(false);
    expect(regressions([...violations, unnamed], baseline)).toEqual([unnamed]);
  }, 600_000);
});

describe("cockpit frozen anchor tier after the retirement", () => {
  test("the net diff leaves tests/fixtures/cockpit/anchors byte-identical to the integration tip — the six declared-retired anchors and the two machine surfaces remain exactly as T14 merged them", async () => {
    // The machine surfaces are read off the shipped manifest's own retirement
    // predicate, then pinned so a declaration that swallowed one cannot pass on
    // an empty set.
    const machineSurfaces = GOLDEN_FRAME_CASES
      .filter((golden) =>
        golden.cockpit === "run" && !isRetiredGoldenFrame(golden)
      )
      .map((golden) => golden.fixture)
      .sort();
    expect(machineSurfaces).toEqual([
      "run.ci.140x24.txt",
      "run.non-tty.140x24.txt",
    ]);

    // Retirement is the declaration T14 merged, never deletion. Pin its six
    // historical files, prove every one remains declared, and require the
    // directory to hold exactly those six plus the two machine surfaces.
    const declaredRetired = [
      "run.height-24.140x24.txt",
      "run.height-40.140x40.txt",
      "run.no-colour.140x24.txt",
      "run.width-folded-keys.100x24.txt",
      "run.width-stacked.80x24.txt",
      "run.width-three-column.140x24.txt",
    ] as const;
    for (const fixture of declaredRetired) {
      const golden = GOLDEN_FRAME_CASES.find((item) => item.fixture === fixture);
      expect(golden, fixture).toBeDefined();
      expect(isRetiredGoldenFrame(golden!), fixture).toBe(true);
      expect(readFileSync(join(ANCHORS, fixture), "utf8").length, fixture)
        .toBeGreaterThan(0);
    }

    const entries = readdirSync(ANCHORS, { withFileTypes: true });
    expect(entries.every((entry) => entry.isFile())).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [...declaredRetired, ...machineSurfaces].sort(),
    );

    // And each is what production emits today apart from the release-owned
    // first-line version token. Every other row and the advertised keys line
    // remain whole equality evidence.
    const drawn = await regenerateGoldenFrames();
    for (const fixture of machineSurfaces) {
      const rendered = drawn.find((frame) => frame.fixture === fixture);
      if (!rendered) throw new Error(`the manifest drew no ${fixture}`);
      const bytes = readFileSync(join(ANCHORS, fixture), "utf8");

      expect(bytes.length, fixture).toBeGreaterThan(0);
      expect(goldenFrameMatchesCommitted(rendered, bytes), fixture).toBe(true);
      // A drift is named rather than absorbed: disturb the committed bytes and
      // the comparison that just passed fails.
      expect(
        goldenFrameMatchesCommitted(rendered, `${bytes}drifted\n`),
        fixture,
      ).toBe(false);
    }
  }, 120_000);
});
