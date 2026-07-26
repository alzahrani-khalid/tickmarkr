import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import stringWidth from "string-width";
import { describe, expect, test } from "vitest";
import {
  captureCockpitOutput,
  captureRendererOutput,
  HEIGHT_TIER_BOUNDARIES,
  WIDTH_BAND_CASES,
  type CockpitName,
} from "../../src/tui/cockpit/capture.js";
import { KEYBAR_KEYS } from "../../src/tui/cockpit/components.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";
import {
  COCKPIT_COLUMN_FLOOR,
  COCKPIT_ROW_FLOOR,
  resolveCockpitLayout,
} from "../../src/tui/cockpit/layout.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
} from "../../src/tui/cockpit/run-cockpit.js";
import {
  deriveSetupCockpitData,
  SETUP_DETAIL_ORDER,
  SetupCockpitFrame,
} from "../../src/tui/cockpit/setup-cockpit.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SOURCE_DIRECTORY = join(import.meta.dirname, "../../src/tui/cockpit");
const captures = loadDemoCaptures();
const binaryVersion = "9.8.7";
const CONTRACTED_WIDTHS = [
  COCKPIT_COLUMN_FLOOR,
  ...WIDTH_BAND_CASES.map(({ columns }) => columns),
] as const;
const eventfulJournal = captures.journals.find((capture) =>
  capture.fileName === "run-20260724-231138.journal.jsonl"
);
if (!eventfulJournal) throw new Error("eventful cockpit capture is missing");

function memoryStream(
  columns: number,
  rows: number,
): NodeJS.WriteStream & { readonly writes: string[] } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    writes: string[];
  };
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  stream.writes = [];
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stream.writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return Reflect.apply(write, stream, [chunk, ...args]) as boolean;
  }) as typeof stream.write;
  return stream as unknown as NodeJS.WriteStream & { readonly writes: string[] };
}

const renderedFrames = new Map<string, Promise<string>>();

function renderFrame(
  cockpit: CockpitName,
  columns: number,
  rows: number,
): Promise<string> {
  const key = `${cockpit}:${columns}:${rows}`;
  const cached = renderedFrames.get(key);
  if (cached) return cached;
  const rendered = (async () => {
    const output = memoryStream(columns, rows);
    const emission = await captureCockpitOutput({
      cockpit,
      output,
      binaryVersion,
      columns,
      rows,
      interactive: true,
      colour: false,
      ci: false,
      captures,
    });
    expect(emission.renderer, key).toBe("frame");
    expect(output.writes.join(""), key).toBe(emission.output);
    return emission.output.replace(ANSI, "");
  })();
  renderedFrames.set(key, rendered);
  return rendered;
}

function frameLines(output: string): string[] {
  return output.split("\n");
}

type BorderedRegion = {
  readonly content: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
};

function borderedRegions(output: string): BorderedRegion[] {
  const grid = frameLines(output).map((line) => [...line]);
  const styles = {
    "╭": { topRight: "╮", bottomLeft: "╰", bottomRight: "╯", vertical: "│" },
    "╔": { topRight: "╗", bottomLeft: "╚", bottomRight: "╝", vertical: "║" },
  } as const;
  const regions: BorderedRegion[] = [];

  for (let top = 0; top < grid.length; top += 1) {
    for (let left = 0; left < (grid[top]?.length ?? 0); left += 1) {
      const corner = grid[top]?.[left] as keyof typeof styles | undefined;
      const style = corner === undefined ? undefined : styles[corner];
      if (!style) continue;
      const right = grid[top]!.indexOf(style.topRight, left + 1);
      if (right < 0) continue;
      for (let bottom = top + 2; bottom < grid.length; bottom += 1) {
        if (
          grid[bottom]?.[left] !== style.bottomLeft
          || grid[bottom]?.[right] !== style.bottomRight
        ) {
          continue;
        }
        const enclosed = grid.slice(top + 1, bottom);
        if (!enclosed.every((line) =>
          line[left] === style.vertical && line[right] === style.vertical
        )) {
          continue;
        }
        regions.push({
          content: enclosed.map((line) =>
            line.slice(left + 1, right).join("").trimEnd()
          ).join("\n"),
          top,
          bottom,
          left,
          right,
        });
        break;
      }
    }
  }
  return regions;
}

function namedRegion(output: string, title: string): BorderedRegion {
  const region = borderedRegions(output).find((candidate) =>
    candidate.content.split("\n")[0]?.trim() === title
  );
  if (!region) throw new Error(`missing bordered ${title} region`);
  return region;
}

function withoutJournalInterior(output: string, title: string): string {
  const region = namedRegion(output, title);
  const lines = frameLines(output);
  return [
    ...lines.slice(0, region.top + 2),
    ...lines.slice(region.bottom),
  ].join("\n");
}

function journalBodyLines(output: string): string[] {
  return namedRegion(output, "JOURNAL").content.split("\n").slice(1);
}

function drawnJournalEntryCount(output: string): number {
  return journalBodyLines(output).filter((line) => line.trim().length > 0).length;
}

function assertJournalFillsAvailableRows(
  output: string,
  derivedEntryCount: number,
): void {
  const body = journalBodyLines(output);
  expect(drawnJournalEntryCount(output)).toBe(
    Math.min(body.length, derivedEntryCount),
  );
}

async function renderRunData(
  data: ReturnType<typeof deriveRunCockpitData>,
  columns: number,
  rows: number,
): Promise<string> {
  return (
    await captureRendererOutput(
      createElement(RunCockpitFrame, { data, columns, rows }),
      { columns, rows, colour: false },
    )
  ).replace(ANSI, "");
}

function retainedRunElements(output: string): boolean[] {
  const data = deriveRunCockpitData(eventfulJournal, binaryVersion);
  return [
    output.includes("Move"),
    output.includes("tip-verify"),
    output.includes(`v${binaryVersion}`),
    output.includes(`${data.progress}%`),
    output.includes("JOURNAL"),
    output.includes(data.progressCaption),
    output.includes("TASKS"),
    output.includes(data.branch),
  ];
}

function retainedRunElementsAtWidth(output: string): boolean[] {
  const data = deriveRunCockpitData(eventfulJournal, binaryVersion);
  const retained = retainedRunElements(output);
  retained[5] = output.includes(
    data.progressCaption.split(" · ").slice(0, 2).join(" · "),
  );
  retained[6] = retained[6] || output.includes(
    `tasks ${data.tasks.done}/${data.tasks.total}`,
  );
  retained[7] = output.includes(data.runId);
  return retained;
}

function assertNoLeadingSeparator(output: string): void {
  expect(output).not.toMatch(/(?:^|[│║])\s*[·—→]/mu);
}

describe("cockpit frame-owned height ladder", () => {
  test("test: no journal body row is left blank while an entry the surface derived for that frame remains undrawn", async () => {
    const derivedEntryCount = deriveRunCockpitData(
      eventfulJournal,
      binaryVersion,
    ).journalRows.length;

    for (const rows of HEIGHT_TIER_BOUNDARIES) {
      assertJournalFillsAvailableRows(
        await renderFrame("run", 140, rows),
        derivedEntryCount,
      );
    }
  });

  test("test: the journal still fills every body row it is given while entries remain undrawn, and unparseable source lines are still reported first", async () => {
    const data = deriveRunCockpitData(
      {
        ...eventfulJournal,
        raw: `${eventfulJournal.raw.trimEnd()}\n{not-json\n`,
      },
      binaryVersion,
    );
    expect(data.journalRows[0]?.text).toContain("DEFECT");

    const frame = await renderRunData(data, 140, 40);

    expect(journalBodyLines(frame)[0]).toContain("DEFECT");
    assertJournalFillsAvailableRows(frame, data.journalRows.length);
  });

  test("test: capping the derived entries below the body rows the panel was given makes the preceding check fail, so a panel that grows without filling cannot pass", async () => {
    const data = deriveRunCockpitData(eventfulJournal, binaryVersion);
    const capped = {
      ...data,
      journalRows: data.journalRows.slice(0, 3),
    };
    const frame = await renderRunData(capped, 140, 40);

    expect(data.journalRows.length).toBeGreaterThan(
      journalBodyLines(frame).length,
    );
    expect(() =>
      assertJournalFillsAvailableRows(frame, data.journalRows.length)
    ).toThrow();
  });

  test("test: the tallest frame in the corpus draws more journal entries than the shortest frame in the corpus", async () => {
    const shortest = await renderFrame(
      "run",
      140,
      HEIGHT_TIER_BOUNDARIES[0],
    );
    const tallest = await renderFrame(
      "run",
      140,
      HEIGHT_TIER_BOUNDARIES.at(-1)!,
    );

    expect(drawnJournalEntryCount(tallest)).toBeGreaterThan(
      drawnJournalEntryCount(shortest),
    );
  });

  test("test: the entry naming the spotlight task's attempt and acting adapter is drawn on every frame that has a journal panel", async () => {
    const source = eventfulJournal.raw.split("\n").flatMap((line) =>
      line.trim()
        ? [JSON.parse(line) as {
          readonly event: string;
          readonly taskId?: string;
          readonly data: Record<string, unknown>;
        }]
        : []
    );
    const dispatches = source.filter((event) =>
      event.event === "task-dispatch" && event.taskId === "T2"
    );
    const acting = dispatches.at(-1)!;
    const assignment = acting.data.assignment as {
      readonly adapter: string;
      readonly model: string;
    };
    const attempt = Number(acting.data.attempt) + 1;
    const cases = [
      ...WIDTH_BAND_CASES.map(({ columns }) => ({ columns, rows: 24 })),
      ...HEIGHT_TIER_BOUNDARIES.map((rows) => ({ columns: 140, rows })),
    ];

    for (const { columns, rows } of cases) {
      const journal = namedRegion(
        await renderFrame("run", columns, rows),
        "JOURNAL",
      ).content;
      expect(journal, `${columns}x${rows} task`).toContain("T2");
      expect(journal, `${columns}x${rows} attempt`).toContain(
        `attempt ${attempt}`,
      );
      expect(journal, `${columns}x${rows} adapter`).toContain(
        `${assignment.adapter}:${assignment.model}`,
      );
    }
  });

  test("test: each cockpit frame receives the terminal's row count and resolves the priority ladder itself, rather than receiving a row list a caller has already sliced", async () => {
    const output = memoryStream(140, 14);
    const nodes: ReactNode[] = [];

    for (const cockpit of ["run", "setup"] as const) {
      await captureCockpitOutput({
        cockpit,
        output,
        binaryVersion,
        columns: 140,
        rows: 14,
        interactive: true,
        colour: false,
        ci: false,
        captures,
        frameRenderer: async (node) => {
          nodes.push(node);
          return "frame";
        },
      });
    }

    expect(nodes).toHaveLength(2);
    const run = nodes[0] as ReactElement<{
      rows?: number;
      data: { journalRows: readonly unknown[] };
    }>;
    const setup = nodes[1] as ReactElement<{
      rows?: number;
      data: { reviewRows: readonly unknown[] };
    }>;
    expect(isValidElement(run)).toBe(true);
    expect(isValidElement(setup)).toBe(true);
    expect(run.type).toBe(RunCockpitFrame);
    expect(setup.type).toBe(SetupCockpitFrame);
    expect(run.props.rows).toBe(14);
    expect(setup.props.rows).toBe(14);
    expect(run.props.data.journalRows).toHaveLength(
      deriveRunCockpitData(eventfulJournal, binaryVersion).journalRows.length,
    );
    expect(setup.props.data.reviewRows).toHaveLength(
      deriveSetupCockpitData(captures, binaryVersion).reviewRows.length,
    );

    for (const file of ["run-cockpit.tsx", "setup-cockpit.tsx"]) {
      const source = readFileSync(join(SOURCE_DIRECTORY, file), "utf8");
      expect(source, file).toContain("resolveCockpitLayout");
    }
    const runSource = readFileSync(
      join(SOURCE_DIRECTORY, "run-cockpit.tsx"),
      "utf8",
    );
    expect(runSource).not.toMatch(/\brows\s*>=\s*\d+/);
    expect(runSource).not.toMatch(
      /sourceRows\s*\+\s*Math\.floor\(rows\)\s*-\s*\d+/,
    );
  });

  test("test: no caller pre-applies the ladder by slicing a row list before handing it to a frame", () => {
    for (const file of ["capture.ts", "demo.ts"]) {
      const source = readFileSync(join(SOURCE_DIRECTORY, file), "utf8");
      expect(source, file).not.toMatch(
        /(?:journalRows|reviewRows)\s*:\s*[^\n]*\.slice\(/,
      );
    }
  });

  test("test: for every contracted width band at every contracted height tier, the rendered frame's row count does not exceed the rows that tier allows, asserted for both surfaces", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      for (const columns of CONTRACTED_WIDTHS) {
        for (const rows of HEIGHT_TIER_BOUNDARIES) {
          expect(
            frameLines(await renderFrame(cockpit, columns, rows)).length,
            `${cockpit} ${columns}x${rows}`,
          ).toBeLessThanOrEqual(rows);
        }
      }
    }
  });

  test("test: for every contracted width band at every contracted height tier, the rendered frame's widest line does not exceed the band's columns, counted as display columns rather than as bytes", async () => {
    expect(Buffer.byteLength("╭")).toBeGreaterThan(stringWidth("╭"));
    for (const cockpit of ["run", "setup"] as const) {
      for (const columns of CONTRACTED_WIDTHS) {
        for (const rows of HEIGHT_TIER_BOUNDARIES) {
          const widest = Math.max(
            ...frameLines(await renderFrame(cockpit, columns, rows))
              .map((line) => stringWidth(line)),
          );
          expect(widest, `${cockpit} ${columns}x${rows}`).toBeLessThanOrEqual(columns);
        }
      }
    }
  });

  // ~140 full frame renders (2 surfaces x 71 widths x every height tier). It comfortably fits the
  // default 20s locally and comfortably does not on a 2-core CI runner, where it timed out at
  // 20132ms during the v1.80.0 release. The work is the point of the test, so give it room rather
  // than thinning the sweep.
  test("test: no rendered line anywhere in either surface begins with a separator glyph", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      for (
        let columns = COCKPIT_COLUMN_FLOOR;
        columns <= 170;
        columns += 1
      ) {
        for (const rows of HEIGHT_TIER_BOUNDARIES) {
          assertNoLeadingSeparator(await renderFrame(cockpit, columns, rows));
        }
      }
    }
  }, 180_000);

  test("test: composing a line whose separator falls exactly at a wrap boundary makes the preceding check fail, so the guard rejects the case it exists for", () => {
    const data = "12345678 · next item";
    const brokenComposition = [...data].reduce<string[]>((lines, character) => {
      const current = lines.at(-1);
      if (current === undefined || current.length === 9) lines.push(character);
      else lines[lines.length - 1] = current + character;
      return lines;
    }, []).join("\n");

    expect(brokenComposition.split("\n")[1]).toMatch(/^·/u);
    expect(() => assertNoLeadingSeparator(brokenComposition)).toThrow();
  });

  test("test: at every width from the column floor upward the surface still fits its frame and the ladder still retains the ranked elements it retained before", async () => {
    for (let columns = COCKPIT_COLUMN_FLOOR; columns <= 170; columns += 1) {
      for (const rows of HEIGHT_TIER_BOUNDARIES) {
        for (const cockpit of ["run", "setup"] as const) {
          const output = await renderFrame(cockpit, columns, rows);
          expect(
            frameLines(output).length,
            `${cockpit} ${columns}x${rows} rows`,
          ).toBeLessThanOrEqual(rows);
          expect(
            Math.max(...frameLines(output).map((line) => stringWidth(line))),
            `${cockpit} ${columns}x${rows} columns`,
          ).toBeLessThanOrEqual(columns);
        }

        const retained = retainedRunElementsAtWidth(
          await renderFrame("run", columns, rows),
        );
        const layout = resolveCockpitLayout(columns, rows);
        if (layout.renderer !== "frame") throw new Error("expected frame layout");
        expect(retained, `${columns}x${rows}`).toEqual([
          true,
          true,
          true,
          layout.elements.progressBar,
          true,
          layout.elements.progressCaption,
          true,
          layout.elements.secondaryHeader,
        ]);
      }
    }
  });

  test("test: at a tier where the tiles surrender, the frame contains their single summary line and does not contain the bordered tiles, so the collapse is proven by what is present rather than by what is absent", async () => {
    const run = await renderFrame("run", 140, COCKPIT_ROW_FLOOR);
    const setup = await renderFrame("setup", 140, COCKPIT_ROW_FLOOR);

    expect(run).toContain("tasks 7/7 · gates 59/64 · pass 92%");
    expect(run).not.toMatch(/[│║]\s*TASKS\s*[│║]/);
    expect(run).not.toMatch(/[│║]\s*GATES\s*[│║]/);
    expect(run).not.toMatch(/[│║]\s*PASS RATE\s*[│║]/);
    expect(setup).toContain("found 7 · authenticated 6 · routable 6");
    expect(setup).not.toMatch(/[│║]\s*FOUND\s*[│║]/);
    expect(setup).not.toMatch(/[│║]\s*AUTHENTICATED\s*[│║]/);
    expect(setup).not.toMatch(/[│║]\s*ROUTABLE\s*[│║]/);
  });

  test("test: as height decreases, elements are surrendered in the contracted priority order, and no higher-priority element is missing while a lower-priority one is still drawn", async () => {
    for (let rows = 24; rows >= COCKPIT_ROW_FLOOR; rows -= 1) {
      const retained = retainedRunElements(
        await renderFrame("run", 140, rows),
      );
      for (let lower = 1; lower < retained.length; lower += 1) {
        if (retained[lower]) {
          expect(
            retained.slice(0, lower).every(Boolean),
            `${rows} rows: ${retained.join(",")}`,
          ).toBe(true);
        }
      }
    }
  });

  test("test: at every height at or above the floor the version, the keybar and the status strip are all retained, on both surfaces", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      for (let rows = COCKPIT_ROW_FLOOR; rows <= 40; rows += 1) {
        const frame = await renderFrame(cockpit, 140, rows);
        expect(frame, `${cockpit} ${rows} version`).toContain(`v${binaryVersion}`);
        expect(frame, `${cockpit} ${rows} keybar`).toContain(
          cockpit === "run" ? "Move" : "Toggle",
        );
        expect(frame, `${cockpit} ${rows} status`).toContain(
          cockpit === "run" ? "tip-verify" : "base untouched",
        );
      }
    }
  });

  test("test: above the height the full arrangement needs, the journal absorbs the surplus rows and no other element grows", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      // the first height at which each surface draws its whole arrangement,
      // above which the journal is the only element with anywhere to grow
      const fullRows = cockpit === "run" ? 24 : 67;
      const shorter = await renderFrame(cockpit, 140, fullRows);
      const taller = await renderFrame(cockpit, 140, fullRows + 16);
      const title = cockpit === "run" ? "JOURNAL" : "REVIEW";
      const shortJournal = namedRegion(shorter, title);
      const tallJournal = namedRegion(taller, title);
      const rowGrowth = frameLines(taller).length - frameLines(shorter).length;

      expect(tallJournal.bottom - tallJournal.top).toBe(
        shortJournal.bottom - shortJournal.top + rowGrowth,
      );
      expect(withoutJournalInterior(taller, title)).toBe(
        withoutJournalInterior(shorter, title),
      );
    }
  });

  test("test: the frame rendered at the tallest contracted tier has more rows than the same band rendered at the tier below it, so absorption is proven by a live render rather than by a frozen frame", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      for (const { columns } of WIDTH_BAND_CASES) {
        const below = frameLines(await renderFrame(cockpit, columns, 24)).length;
        const tallest = frameLines(await renderFrame(cockpit, columns, 40)).length;
        expect(tallest, `${cockpit} ${columns}`).toBeGreaterThan(below);
      }
    }
  });

  test("test: below the contracted row floor or column floor the surface yields the plain renderer rather than a clipped or broken frame", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      for (const [columns, rows] of [
        [COCKPIT_COLUMN_FLOOR - 1, COCKPIT_ROW_FLOOR],
        [COCKPIT_COLUMN_FLOOR, COCKPIT_ROW_FLOOR - 1],
      ] as const) {
        const output = memoryStream(columns, rows);
        const emission = await captureCockpitOutput({
          cockpit,
          output,
          binaryVersion,
          columns,
          rows,
          interactive: true,
          colour: false,
          ci: false,
          captures,
          plainRenderer: () => `plain ${cockpit}\n`,
        });
        expect(emission).toEqual({
          renderer: "plain",
          output: `plain ${cockpit}\n`,
        });
        expect(output.writes.join("")).not.toMatch(/[\u2500-\u257f]/u);
      }
    }
  });

  test("test: on the surface that has no frozen anchor, every retained element of the approved arrangement is still present at each tier above the floor, asserted structurally", async () => {
    const expectedSidePanelWidths = new Map([
      ["stacked", 11],
      ["folded-keys", 12],
      ["three-column", 16],
    ]);

    for (const { columns } of WIDTH_BAND_CASES) {
      for (const rows of HEIGHT_TIER_BOUNDARIES) {
        const output = await renderFrame("setup", columns, rows);
        const layout = resolveCockpitLayout(columns, rows);
        if (layout.renderer !== "frame") throw new Error("expected frame layout");
        const regions = borderedRegions(output);
        const titles = regions.map((region) =>
          region.content.split("\n")[0]?.trim().replace(/^❯\s+/, "")
        );

        expect(titles, `${columns}x${rows} shell`).toEqual(
          expect.arrayContaining(["SETUP", "HARNESSES", "KEYS", "REVIEW"]),
        );
        if (layout.stats.mode === "tiles") {
          expect(titles, `${columns}x${rows} found tile`).toContain("FOUND");
          expect(
            titles.some((title) => title?.startsWith("AUTHENTIC")),
            `${columns}x${rows} authenticated tile`,
          ).toBe(true);
          expect(titles, `${columns}x${rows} routable tile`).toContain("ROUTABLE");
        } else {
          expect(output, `${columns}x${rows} summary`).toContain(
            "found 7 · authenticated 6 · routable 6",
          );
        }
        if (layout.elements.secondaryHeader) {
          expect(output, `${columns}x${rows} secondary header`).toContain(
            "setup · step 2/6",
          );
        }
        const expectedWidth = expectedSidePanelWidths.get(layout.arrangement);
        expect(expectedWidth).toBeDefined();
        for (const title of ["SETUP", "KEYS"]) {
          const region = namedRegion(output, title);
          expect(
            region.right - region.left + 1,
            `${columns}x${rows} ${title} band-derived width`,
          ).toBe(expectedWidth);
        }
        const keys = namedRegion(output, "KEYS");
        if (keys.content.includes(KEYBAR_KEYS.setup[0].label)) {
          for (const item of KEYBAR_KEYS.setup.slice(0, 6)) {
            expect(
              keys.content,
              `${columns}x${rows} retained ${item.label} key`,
            ).toContain(item.label);
          }
        } else {
          expect(
            keys.content.split("\n").slice(1).filter((line) =>
              line.trim().length > 0
            ).length,
            `${columns}x${rows} compact key rows`,
          ).toBe(KEYBAR_KEYS.setupAdditional.length);
        }
      }
    }

    const fullKeys = namedRegion(
      await renderFrame("setup", 140, 40),
      "KEYS",
    ).content;
    for (const item of KEYBAR_KEYS.setup) {
      expect(fullKeys, `${item.key} ${item.label}`).toContain(
        `${item.key} ${item.label}`,
      );
    }
  });

  test("test: the setup detail panels are retained as a prefix of the contracted surrender order, and a tier with room for one draws it rather than leaving the rows unspent", async () => {
    const detailTitles: Record<(typeof SETUP_DETAIL_ORDER)[number], string[]> = {
      detected: ["DETECTED"],
      consultsAndReviewers: ["CONSULTS", "REVIEWERS"],
      overlayDiff: ["OVERLAY DIFF"],
      fleetAndGates: ["FLEET", "GATES"],
    };

    for (const { columns } of WIDTH_BAND_CASES) {
      for (const rows of HEIGHT_TIER_BOUNDARIES) {
        const titles = borderedRegions(await renderFrame("setup", columns, rows))
          .map((region) => region.content.split("\n")[0]?.trim());
        const drawn = SETUP_DETAIL_ORDER.map((detail) =>
          detailTitles[detail].every((title) => titles.includes(title))
        );
        const surrendered = drawn.indexOf(false);
        expect(
          surrendered < 0 || drawn.slice(surrendered).every((kept) => !kept),
          `${columns}x${rows} retained out of order: ${drawn.join(",")}`,
        ).toBe(true);
      }
    }

    // the tallest contracted tier of the widest band has room for more than the
    // step's own panel, and spends it rather than leaving it blank
    const tallest = await renderFrame("setup", 140, 40);
    for (const title of ["DETECTED", "CONSULTS", "REVIEWERS"]) {
      expect(tallest, `140x40 ${title}`).toContain(title);
    }
    expect(frameLines(tallest).length).toBeGreaterThan(40 - 4);

    // and every panel of the approved arrangement returns once the rows exist
    const whole = await renderFrame("setup", 140, 67);
    for (const titles of Object.values(detailTitles)) {
      for (const title of titles) {
        expect(whole, `140x67 ${title}`).toContain(title);
      }
    }
  });
});
