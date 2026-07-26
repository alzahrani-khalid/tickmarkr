import { readFileSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  createElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { render } from "ink";
import { describe, expect, test } from "vitest";
import { GLYPHS } from "../../src/brand.js";
import * as components from "../../src/tui/cockpit/components.js";
import {
  BodyText,
  CockpitGrid,
  JournalRowPanel,
  KEYBAR_KEYS,
  Keybar,
  Panel,
  ProgressMeter,
  SPARKLINE_BUCKET_WINDOW,
  Sparkline,
  StateGlyph,
  StatTile,
  StatusStrip,
} from "../../src/tui/cockpit/components.js";
import {
  COCKPIT_DATA_RAMP,
  TEXT_EMPHASIS_TOKENS,
} from "../../src/tui/cockpit/theme.js";
import {
  findGoldenFrameMismatches,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";

const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function renderComponent(node: ReactNode, columns = 80): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
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
  const app = render(node, {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  await firstPaint;
  const frame = writes.at(-1) ?? "";
  app.unmount();
  return stripAnsi(frame).trimEnd();
}

const linesOf = (frame: string) => frame.split("\n").filter((line) => line.length > 0);

type BandColumnContent = {
  readonly title: string;
  readonly lines: readonly string[];
};

type BandApi = {
  readonly allocateBandColumns: (
    columns: number,
    content: readonly BandColumnContent[],
  ) => readonly number[];
  readonly BandLines: (props: {
    readonly columns: number;
    readonly lines: readonly string[];
    readonly emphasis?: "dim";
  }) => ReactElement;
  readonly measureBandRows: (
    columns: number,
    content: readonly BandColumnContent[],
  ) => number;
};

const bandApi = components as typeof components & BandApi;

type SizedCockpitGridProps = {
  readonly columns: number;
  readonly columnContents: readonly BandColumnContent[];
  readonly children: ReactNode;
};

const SizedCockpitGrid = CockpitGrid as unknown as (
  props: SizedCockpitGridProps,
) => ReactElement;

function panelWidths(frame: string): number[] {
  return [...(linesOf(frame)[0] ?? "").matchAll(/╭─+╮/gu)]
    .map((match) => [...match[0]].length);
}

function assertLongerContentGetsMore(
  widths: readonly number[],
  content: readonly BandColumnContent[],
): void {
  const longest = content.map((column) =>
    Math.max(...[column.title, ...column.lines].map((line) => [...line].length))
  );
  expect(longest[1]).toBeGreaterThan(longest[0]!);
  expect(widths[1]).toBeGreaterThan(widths[0]!);
}

describe("cockpit component vocabulary", () => {
  test("test: in a two-column band the column whose longest line is longer is given more columns than its sibling rather than an equal share", async () => {
    const columnContents = [
      { title: "SHORT", lines: ["tiny"] },
      {
        title: "LONG",
        lines: ["a longer detail line"],
      },
    ] as const;
    const allocated = bandApi.allocateBandColumns(72, columnContents);
    const frame = await renderComponent(createElement(
      SizedCockpitGrid,
      { columns: 72, columnContents },
      createElement(
        Panel,
        { title: columnContents[0].title },
        createElement(BodyText, null, columnContents[0].lines[0]),
      ),
      createElement(
        Panel,
        { title: columnContents[1].title },
        createElement(BodyText, null, columnContents[1].lines[0]),
      ),
    ), 72);

    assertLongerContentGetsMore(allocated, columnContents);
    expect(panelWidths(frame)).toEqual(allocated);
    assertLongerContentGetsMore(panelWidths(frame), columnContents);
  });

  test("test: splitting a band evenly again makes the preceding check fail, so an even split cannot pass", () => {
    const content = [
      { title: "SHORT", lines: ["tiny"] },
      { title: "LONG", lines: ["this line is much longer than tiny"] },
    ] as const;

    expect(() => assertLongerContentGetsMore([30, 30], content)).toThrow();
  });

  test("test: when a band has enough columns for every line it carries, no line in that band wraps", async () => {
    const columnContents = [
      { title: "LEFT", lines: ["short value"] },
      {
        title: "RIGHT",
        lines: ["the longer value remains whole when the band can carry it"],
      },
    ] as const;
    const frame = await renderComponent(createElement(
      SizedCockpitGrid,
      { columns: 86, columnContents },
      ...columnContents.map((column) =>
        createElement(
          Panel,
          { key: column.title, title: column.title },
          createElement(BodyText, null, column.lines[0]),
        )
      ),
    ), 86);

    for (const column of columnContents) {
      expect(
        linesOf(frame).filter((line) => line.includes(column.lines[0])),
        column.title,
      ).toHaveLength(1);
    }
  });

  test("test: a line that fits the columns it is given is drawn with exactly the characters its data carries", async () => {
    const data = "required true · prefer claude-code:opus";
    const frame = await renderComponent(createElement(bandApi.BandLines, {
      columns: [...data].length,
      lines: [data],
    }), [...data].length);

    expect(frame).toBe(data);
  });

  test("test: the rows a band is charged by the height ladder equal the rows that band draws", async () => {
    const columnContents = [
      {
        title: "CONSULTS",
        lines: ["seat claude-code:opus", "prefer codex:gpt-5.6-sol"],
      },
      {
        title: "REVIEWERS",
        lines: [
          "required true",
          "complexity threshold 8",
          "prefer claude-code:opus · codex:gpt-5.6-sol",
        ],
      },
    ] as const;
    const columns = 54;
    const widths = bandApi.allocateBandColumns(columns, columnContents);
    const frame = await renderComponent(createElement(
      SizedCockpitGrid,
      { columns, columnContents },
      ...columnContents.map((column, index) =>
        createElement(
          Panel,
          { key: column.title, title: column.title },
          createElement(bandApi.BandLines, {
            columns: widths[index]! - 4,
            lines: column.lines,
          }),
        )
      ),
    ), columns);

    expect(linesOf(frame)).toHaveLength(
      bandApi.measureBandRows(columns, columnContents),
    );
  });

  test("test: a bordered panel renders its title within its own border and its content inside the border box", async () => {
    const frame = await renderComponent(createElement(
      Panel,
      { title: "RUN", width: 24 },
      createElement(BodyText, null, "task body"),
    ));
    const lines = linesOf(frame);
    const titleLine = lines.findIndex((line) => line.includes("RUN"));
    const contentLine = lines.findIndex((line) => line.includes("task body"));

    expect(lines[0]).toMatch(/^╭/);
    expect(lines.at(-1)).toMatch(/^╰/);
    expect(titleLine).toBeGreaterThan(0);
    expect(titleLine).toBeLessThan(lines.length - 1);
    expect(contentLine).toBeGreaterThan(titleLine);
    expect(contentLine).toBeLessThan(lines.length - 1);
    expect(lines[titleLine]).toMatch(/^│.*RUN.*│$/);
    expect(lines[contentLine]).toMatch(/^│.*task body.*│$/);
  });

  test("test: a focused panel is distinguishable from an unfocused one by both its border treatment and a title marker, and remains distinguishable when colour is disabled", async () => {
    const focused = await renderComponent(createElement(
      Panel,
      { title: "RUN", focused: true, width: 20 },
      "focused",
    ));
    const unfocused = await renderComponent(createElement(
      Panel,
      { title: "RUN", focused: false, width: 20 },
      "unfocused",
    ));

    expect(focused).toContain(`${GLYPHS.pointer} RUN`);
    expect(unfocused).not.toContain(`${GLYPHS.pointer} RUN`);
    expect(linesOf(focused)[0]).toMatch(/^╔/);
    expect(linesOf(unfocused)[0]).toMatch(/^╭/);
    expect(stripAnsi(focused)).not.toBe(stripAnsi(unfocused));
  });

  test("test: a stat tile renders its value and its sparkline inside the tile's own border", async () => {
    const frame = await renderComponent(createElement(StatTile, {
      label: "PASS RATE",
      value: "96%",
      samples: [1, 2, 3, 4, 5, 4, 5, 6],
      width: 24,
    }));
    const lines = linesOf(frame);
    const valueLine = lines.findIndex((line) => line.includes("96%"));
    const sparklineLine = lines.findIndex((line) => /[▁▂▃▄▅▆▇█]/u.test(line));

    expect(lines[0]).toMatch(/^╭/);
    expect(lines.at(-1)).toMatch(/^╰/);
    expect(valueLine).toBeGreaterThan(0);
    expect(valueLine).toBeLessThan(lines.length - 1);
    expect(sparklineLine).toBeGreaterThan(0);
    expect(sparklineLine).toBeLessThan(lines.length - 1);
  });

  test("test: the progress meter fills in proportion to its value and states that value as text beside the fill", async () => {
    const frame = await renderComponent(createElement(ProgressMeter, {
      value: 50,
      width: 10,
    }));

    expect(frame).toContain("█████░░░░░");
    expect(frame).toContain("50%");
  });

  test("test: the keybar and the status strip each render as a single line at every width they are given", async () => {
    for (const width of [8, 16, 40, 80]) {
      const keybar = await renderComponent(createElement(Keybar, {
        surface: "run",
        width,
      }), width);
      const strip = await renderComponent(createElement(StatusStrip, {
        width,
        items: [
          { state: "pass", text: "tip-verify passed" },
          { state: "warn", text: "escalated 1" },
        ],
      }), width);

      expect(linesOf(keybar)).toHaveLength(1);
      expect(linesOf(strip)).toHaveLength(1);
    }
  });

  test("test: the keybar displays the contracted key glyphs for the surface it serves, the run surface's set and the setup surface's additional ones alike, rather than an arbitrary selection that happens to fit", async () => {
    const run = await renderComponent(createElement(Keybar, {
      surface: "run",
      width: 120,
    }), 120);
    const setup = await renderComponent(createElement(Keybar, {
      surface: "setup",
      width: 120,
    }), 120);

    expect(KEYBAR_KEYS.run.map((item) => item.key))
      .toEqual(["↑↓", "⏎", "←", "Tab", "?", "q", "f", "/"]);
    expect(KEYBAR_KEYS.setupAdditional.map((item) => item.key))
      .toEqual(["␣", "a", "r", "s", "n", "p"]);
    expect(KEYBAR_KEYS.setup.map((item) => item.key)).toEqual([
      ...KEYBAR_KEYS.run.slice(0, 6).map((item) => item.key),
      ...KEYBAR_KEYS.setupAdditional.map((item) => item.key),
    ]);
    for (const item of KEYBAR_KEYS.run) expect(run).toContain(item.key);
    for (const item of KEYBAR_KEYS.setup) expect(setup).toContain(item.key);
    for (const item of KEYBAR_KEYS.setupAdditional) expect(setup).toContain(item.key);
  });

  test("test: the journal row panel renders one row per supplied event carrying its time, its state glyph and its text, and takes those rows as input rather than reading any source itself", async () => {
    const rows = [
      { time: "22:23:47", state: "pass" as const, text: "T1 merge complete" },
      { time: "22:23:24", state: "warn" as const, text: "T1 escalated" },
      { time: "22:23:08", state: "fail" as const, text: "T1 readiness failed" },
    ];
    const frame = await renderComponent(createElement(JournalRowPanel, {
      rows,
      width: 56,
    }), 56);
    const journalRows = linesOf(frame).filter((line) =>
      rows.some((row) => line.includes(row.time))
    );

    expect(journalRows).toHaveLength(rows.length);
    for (const [index, row] of rows.entries()) {
      expect(journalRows[index]).toContain(row.time);
      expect(journalRows[index]).toContain(
        row.state === "pass" ? GLYPHS.pass
          : row.state === "warn" ? GLYPHS.attention
            : GLYPHS.fail,
      );
      expect(journalRows[index]).toContain(row.text);
    }
  });

  test("test: body text within a component renders through the theme's text emphasis tokens rather than through any step of the data ramp", () => {
    for (const emphasis of Object.keys(TEXT_EMPHASIS_TOKENS) as Array<
      keyof typeof TEXT_EMPHASIS_TOKENS
    >) {
      const element = BodyText({ emphasis, children: "body" });
      const token = TEXT_EMPHASIS_TOKENS[emphasis];

      expect(element.props.bold).toBe(token.weight === "bold");
      expect(element.props.dimColor).toBe(token.dimmed);
      expect(element.props.color).toBeUndefined();
      expect(COCKPIT_DATA_RAMP.map((step) => step.hex)).not.toContain(element.props.color);
    }
  });

  test("test: no component renders a bracket toggle, and active and inactive states use the established glyph vocabulary", async () => {
    const frame = await renderComponent(createElement(CockpitGrid, null,
      createElement(StateGlyph, { state: "active" }),
      createElement(StateGlyph, { state: "inactive" }),
    ));

    expect(frame).toContain(GLYPHS.toggleActive);
    expect(frame).toContain(GLYPHS.toggleInactive);
    expect(frame).not.toMatch(/\[[ x!]\]/i);
  });

  test("test: the sparkline bucket window is read from a single named constant rather than repeated per tile", async () => {
    const samples = Array.from(
      { length: SPARKLINE_BUCKET_WINDOW + 4 },
      (_, index) => index + 1,
    );
    const sparkline = await renderComponent(createElement(Sparkline, { samples }));
    const tile = await renderComponent(createElement(StatTile, {
      label: "TASKS",
      value: "6/8",
      samples,
      width: 28,
    }));
    const sparkGlyphs = (value: string) => [...value].filter((character) =>
      "▁▂▃▄▅▆▇█".includes(character)
    );

    expect(SPARKLINE_BUCKET_WINDOW).toBeGreaterThan(0);
    expect(sparkGlyphs(sparkline)).toHaveLength(SPARKLINE_BUCKET_WINDOW);
    expect(sparkGlyphs(tile)).toEqual(sparkGlyphs(sparkline));
  });

  test("test: an empty bucket renders as a gap rather than as a zero-height bar indistinguishable from a low one", async () => {
    const gap = await renderComponent(createElement(Sparkline, {
      samples: [1, null, 2],
    }));
    const low = await renderComponent(createElement(Sparkline, {
      samples: [1, 0, 2],
    }));
    const sparkGlyphs = (value: string) => [...value].filter((character) =>
      "▁▂▃▄▅▆▇█".includes(character)
    );

    expect(gap).toMatch(/[▁▂▃▄▅▆▇█] [▁▂▃▄▅▆▇█]/u);
    expect(sparkGlyphs(gap)).toHaveLength(2);
    expect(sparkGlyphs(low)).toHaveLength(3);
  });

  test("test: every committed golden frame is regenerated from the corrected renderer and the regeneration check passes against the regenerated frames", async () => {
    const fixtureDirectory = new URL("../fixtures/cockpit/frames/", import.meta.url);
    const committed = new Map(
      readdirSync(fixtureDirectory).map((fixture) => [
        fixture,
        readFileSync(new URL(fixture, fixtureDirectory), "utf8"),
      ]),
    );
    const regenerated = await regenerateGoldenFrames();

    expect(findGoldenFrameMismatches(regenerated, committed)).toEqual([]);
    for (const frame of regenerated) {
      expect(committed.get(frame.fixture)).toBe(frame.emitted);
    }
  });

  test("the components compose as nested boxes rather than as strings joined before rendering", async () => {
    const frame = await renderComponent(createElement(
      Panel,
      { title: "RUN", width: 64 },
      createElement(CockpitGrid, null,
        createElement(StatTile, {
          label: "TASKS",
          value: "6/8",
          samples: [1, 2, 3],
        }),
        createElement(StatTile, {
          label: "GATES",
          value: "23/24",
          samples: [2, 3, 4],
        }),
      ),
    ), 64);
    const source = readFileSync(
      new URL("../../src/tui/cockpit/components.tsx", import.meta.url),
      "utf8",
    );

    expect(frame.match(/[╭╔]/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(source).not.toContain(".join(");
  });

  test("the journal row panel is a single component with no second implementation beside it", () => {
    expect(Object.keys(components).filter((name) => /Journal.*Panel/.test(name)))
      .toEqual(["JournalRowPanel"]);
  });
});
