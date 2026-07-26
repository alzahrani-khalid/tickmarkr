import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, test } from "vitest";
import {
  type CockpitName,
  GOLDEN_FRAME_CASES,
  HEIGHT_TIER_BOUNDARIES,
  type RegeneratedGoldenFrame,
  WIDTH_BAND_CASES,
  captureCockpitOutput,
  captureRendererOutput,
  findGoldenFrameMismatches,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import {
  loadDemoCaptures,
  type DemoCaptures,
} from "../../src/tui/cockpit/demo.js";
import { resolveCockpitLayout } from "../../src/tui/cockpit/layout.js";
import {
  RunCockpitFrame,
  deriveRunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";
import {
  SetupCockpitFrame,
  deriveSetupCockpitData,
} from "../../src/tui/cockpit/setup-cockpit.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/cockpit/frames");
/**
 * The frozen appearance oracle. It is a directory of its own, outside the
 * regenerable working corpus and outside this task's file scope, precisely so
 * that regenerating the corpus cannot move the target.
 */
const ANCHORS = join(import.meta.dirname, "../fixtures/cockpit/anchors");
const CAPTURE_SOURCE = join(
  import.meta.dirname,
  "../../src/tui/cockpit/capture.ts",
);
const SELF = join(import.meta.dirname, "frames.test.ts");
/**
 * The capture the healthy-capture oracle reads. It lives with the colour
 * corpus, which pinned its digest; the oracle proves it failure-free by
 * reading its events, never by trusting its name.
 */
const HEALTHY_SOURCE_NAME = "run-20260718-000943.journal.jsonl";
const HEALTHY_SOURCE = join(
  import.meta.dirname,
  "../fixtures/cockpit/colour/sources",
  HEALTHY_SOURCE_NAME,
);
const HEALTHY_SOURCE_SHA256 =
  "48302a97d65c012781eda747f4d82b8b9f71649f5c4daaef3da37b25105c45e2";
/**
 * Outside the anchor set by ruling: both currently overflow their terminals, so
 * both must change and freezing them would freeze a defect. The whole setup
 * surface is outside for the same reason.
 */
const UNANCHORED_RUN_FRAMES = new Set([
  "run.height-14.140x14.txt",
  "run.height-18.140x18.txt",
]);
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const DECORATED = /\x1b|[\u2500-\u257f]/u;
const WARM_INK = /\x1b\[38;5;(?:203|214)m/;

function fixtureBytes(): Map<string, string> {
  return new Map(
    readdirSync(FIXTURES)
      .sort()
      .map((fixture) => [fixture, readFileSync(join(FIXTURES, fixture), "utf8")]),
  );
}

function memoryStream(
  isTTY: boolean,
  columns: number,
  rows: number,
): NodeJS.WriteStream & { readonly writes: string[] } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    writes: string[];
  };
  stream.isTTY = isTTY;
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

function generatedById(
  generated: Awaited<ReturnType<typeof regenerateGoldenFrames>>,
  id: string,
): string {
  const frame = generated.find((candidate) => candidate.id === id);
  if (!frame) throw new Error(`missing generated frame: ${id}`);
  return frame.output;
}

function interactiveFrameNode(
  cockpit: CockpitName,
  captures: DemoCaptures,
  binaryVersion: string,
  columns: number,
  rows: number,
): ReactElement {
  const layout = resolveCockpitLayout(columns, rows);
  if (layout.renderer === "plain") {
    throw new Error("interactive equivalence requires a frame layout");
  }
  if (cockpit === "setup") {
    const data = deriveSetupCockpitData(captures, binaryVersion);
    return createElement(SetupCockpitFrame, {
      data: {
        ...data,
        reviewRows: data.reviewRows.slice(0, layout.journalRows),
      },
      columns,
    });
  }
  const source = captures.journals.find((capture) =>
    capture.fileName === "run-20260724-231138.journal.jsonl"
  );
  if (!source) throw new Error("eventful cockpit capture is missing");
  const data = deriveRunCockpitData(source, binaryVersion);
  return createElement(RunCockpitFrame, {
    data: {
      ...data,
      journalRows: data.journalRows.slice(0, layout.journalRows),
    },
    columns,
  });
}

function anchorBytes(): Map<string, string> {
  return new Map(
    readdirSync(ANCHORS)
      .sort()
      .map((anchor) => [anchor, readFileSync(join(ANCHORS, anchor), "utf8")]),
  );
}

let generatedOnce: Promise<readonly RegeneratedGoldenFrame[]> | undefined;
const generatedFrames = (): Promise<readonly RegeneratedGoldenFrame[]> =>
  (generatedOnce ??= regenerateGoldenFrames());

type BorderedRegion = {
  readonly interiorRows: number;
  readonly content: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
};

function borderedRegions(output: string): BorderedRegion[] {
  const grid = output.replace(ANSI, "").split("\n").map((line) => [...line]);
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
          interiorRows: bottom - top - 1,
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

/**
 * Locate the journal panel by its own caption and box geometry — never by line
 * number. A journal that absorbed surplus rows sits at the same place in the
 * structure while every line beneath it has moved.
 */
function journalPanel(output: string): BorderedRegion | undefined {
  return borderedRegions(output).find((region) =>
    region.content.split("\n")[0]?.trim() === "JOURNAL"
  );
}

type PinnedProjection = {
  readonly text: string;
  readonly excludedRows: number;
};

/**
 * The comparison form of a frame: everything except the journal panel's entry
 * rows. The panel's top border and its caption row stay in, because the panel's
 * own shape is approved appearance; only what it absorbs is allowed to grow.
 * Frames with no journal panel — the plain renderer's — are pinned whole.
 */
function pinnedProjection(output: string): PinnedProjection {
  const lines = output.replace(ANSI, "").split("\n");
  const panel = journalPanel(output);
  if (!panel) return { text: lines.join("\n"), excludedRows: 0 };
  return {
    text: [
      ...lines.slice(0, panel.top + 2),
      ...lines.slice(panel.bottom),
    ].join("\n"),
    excludedRows: panel.bottom - panel.top - 2,
  };
}

function anchorMismatches(
  generated: readonly RegeneratedGoldenFrame[],
  anchors: ReadonlyMap<string, string>,
): string[] {
  const fresh = new Map(generated.map((frame) => [frame.fixture, frame.output]));
  return [...anchors]
    .flatMap(([fixture, frozen]) => {
      const rendered = fresh.get(fixture);
      if (rendered === undefined) return [fixture];
      return pinnedProjection(frozen).text === pinnedProjection(rendered).text
        ? []
        : [fixture];
    })
    .sort();
}

function replaceColumn(line: string, column: number, glyph: string): string {
  const cells = [...line];
  if (column >= cells.length) return `${line}${glyph}`;
  cells[column] = glyph;
  return cells.join("");
}

function mutateRow(
  bytes: string,
  row: number,
  mutate: (line: string) => string,
): string {
  return bytes
    .split("\n")
    .map((line, index) => (index === row ? mutate(line) : line))
    .join("\n");
}

type CapturedSourceEvent = {
  readonly ts: string;
  readonly event: string;
  readonly taskId?: string;
  readonly data: Record<string, unknown>;
};

function readCapturedEvents(raw: string): CapturedSourceEvent[] {
  return raw.split("\n").flatMap((line) =>
    line.trim().length > 0 ? [JSON.parse(line) as CapturedSourceEvent] : []
  );
}

/**
 * The failure forms the committed sources use, restated here so the oracle's
 * health check is independent of the derivation it checks: an unsuccessful
 * result flag, an unsuccessful outcome flag, an event name reporting a
 * failure, a non-zero exit status, or a run-end whose tip verification reads
 * failed.
 */
function recordsFailure(event: CapturedSourceEvent): boolean {
  return event.event.includes("failed")
    || event.data.pass === false
    || event.data.ok === false
    || (typeof event.data.exitCode === "number" && event.data.exitCode !== 0)
    || (event.event === "run-end" && event.data.tipVerify === "failed");
}

describe("cockpit renderer-owned golden frames", () => {
  test("test: for the same capture and the same dimensions, the bytes the capture path emits are identical to the bytes the interactive path emits, asserted for both contracted surfaces", async () => {
    const captures = loadDemoCaptures();
    const columns = 140;
    const rows = 24;
    const binaryVersion = "9.8.7";

    for (const cockpit of ["run", "setup"] as const) {
      const interactive = await captureRendererOutput(
        interactiveFrameNode(
          cockpit,
          captures,
          binaryVersion,
          columns,
          rows,
        ),
        { columns, rows, colour: false },
      );
      const output = memoryStream(true, columns, rows);
      const captured = await captureCockpitOutput({
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

      expect(captured.renderer, cockpit).toBe("frame");
      expect(captured.output, cockpit).toBe(interactive);
      expect(output.writes.join(""), cockpit).toBe(interactive);
    }
  });

  test("test: the capture path draws both surfaces through the shipped cockpit frame components and defines no frame of its own", async () => {
    const captures = loadDemoCaptures();
    const expectedComponents = {
      run: RunCockpitFrame,
      setup: SetupCockpitFrame,
    } as const;

    for (const cockpit of ["run", "setup"] as const) {
      const output = memoryStream(true, 140, 24);
      let capturedNode: ReactNode = null;
      await captureCockpitOutput({
        cockpit,
        output,
        binaryVersion: "9.8.7",
        interactive: true,
        colour: false,
        ci: false,
        captures,
        frameRenderer: async (node) => {
          capturedNode = node;
          return "component frame";
        },
      });

      expect(isValidElement(capturedNode), cockpit).toBe(true);
      expect((capturedNode as ReactElement).type, cockpit).toBe(
        expectedComponents[cockpit],
      );
    }

    // A whitelist, not a denylist: any component the capture path invented for
    // itself shows up here, including one whose name nobody thought to ban.
    const source = readFileSync(CAPTURE_SOURCE, "utf8");
    expect(
      [...source.matchAll(/createElement\(\s*([A-Za-z_$][\w$]*)/g)]
        .map((match) => match[1]),
    ).toEqual(["RunCockpitFrame", "SetupCockpitFrame"]);
  });

  test("test: a golden frame is committed for each cockpit at every contracted width band and every height tier boundary, and each is the renderer's own emitted output", async () => {
    const generated = await regenerateGoldenFrames();

    expect(WIDTH_BAND_CASES.map((item) => item.arrangement)).toEqual([
      "stacked",
      "folded-keys",
      "three-column",
    ]);
    expect(HEIGHT_TIER_BOUNDARIES).toEqual([14, 18, 24, 40]);
    for (const cockpit of ["run", "setup"] as const) {
      expect(GOLDEN_FRAME_CASES.filter((item) =>
        item.cockpit === cockpit && item.axis === "width"
      ).map((item) => item.columns)).toEqual(
        WIDTH_BAND_CASES.map((item) => item.columns),
      );
      expect(GOLDEN_FRAME_CASES.filter((item) =>
        item.cockpit === cockpit && item.axis === "height"
      ).map((item) => item.rows)).toEqual(HEIGHT_TIER_BOUNDARIES);
    }
    for (const frame of generated) {
      expect(frame.output.length, frame.id).toBeGreaterThan(0);
      expect(frame.emitted).toBe(frame.output);
      if (frame.renderer === "frame") {
        const lines = frame.output.replace(ANSI, "").split("\n");
        expect(
          Math.max(...lines.map((line) => [...line].length)),
          `${frame.id} column budget`,
        ).toBeLessThanOrEqual(frame.columns);
      }
    }
    const committed = fixtureBytes();
    expect([...committed.keys()].sort()).toEqual(
      GOLDEN_FRAME_CASES.map((item) => item.fixture).sort(),
    );
    for (const frame of generated) {
      expect(committed.get(frame.fixture), frame.fixture).toBe(frame.output);
    }
  });

  test("test: every committed frame is regenerated from the corrected capture path, and the regeneration check passes against the regenerated frames", async () => {
    const generated = await regenerateGoldenFrames();

    expect(findGoldenFrameMismatches(generated, fixtureBytes())).toEqual([]);
  });

  test("test: a committed frame contains a bordered panel enclosing its own content across more than one row, which a flat line renderer cannot produce", () => {
    const frame = readFileSync(
      join(FIXTURES, "run.height-40.140x40.txt"),
      "utf8",
    );

    expect(borderedRegions(frame).some((region) =>
      region.interiorRows > 1
      && region.content.includes("VIEWS")
      && region.content.includes("Run")
    )).toBe(true);
  });

  test("test: a committed frame contains a stat tile whose value and whose series both sit inside the tile's own border", () => {
    const frame = readFileSync(
      join(FIXTURES, "run.height-40.140x40.txt"),
      "utf8",
    );

    expect(borderedRegions(frame).some((region) =>
      region.content.includes("TASKS")
      && region.content.includes("7/7")
      && /[▁▂▃▄▅▆▇█]/u.test(region.content)
    )).toBe(true);
  });

  test("test: a committed frame contains the journal panel's rows inside a border rather than as bare lines", () => {
    const frame = readFileSync(
      join(FIXTURES, "run.height-40.140x40.txt"),
      "utf8",
    );

    expect(borderedRegions(frame).some((region) =>
      region.content.includes("JOURNAL")
      && /\d{2}:\d{2}:\d{2}/u.test(region.content)
      && region.content.includes("✓")
    )).toBe(true);
  });

  test("test: every committed frame still carries the version, the keybar and the status strip, so the corpus keeps the invariant it already held", async () => {
    const generated = await regenerateGoldenFrames();

    for (const frame of generated) {
      const plain = frame.output.replace(ANSI, "");
      expect(plain, frame.id).toMatch(/\bv\d+\.\d+\.\d+\b/);
      expect(plain, frame.id).toContain(
        frame.cockpit === "run" ? "Move" : "Toggle",
      );
      expect(plain, frame.id).toContain(
        frame.cockpit === "run" ? "tip-verify" : "base untouched",
      );
    }
  });

  test("test: below the contracted floor the surface emits plain output rather than a truncated or broken frame", async () => {
    for (const [columns, rows] of [[39, 14], [40, 13]] as const) {
      const output = memoryStream(true, columns, rows);
      const emission = await captureCockpitOutput({
        cockpit: "run",
        output,
        binaryVersion: "9.8.7",
        interactive: true,
        colour: true,
        ci: false,
        plainRenderer: () => "plain floor output\n",
      });

      expect(emission).toEqual({
        renderer: "plain",
        output: "plain floor output\n",
      });
      expect(output.writes.join("")).toBe("plain floor output\n");
      expect(output.writes.join("")).not.toMatch(DECORATED);
    }
  });

  test("test: with colour disabled no information is lost, because every state still carries its glyph and its word", async () => {
    const binaryVersion = "9.8.7";
    const generated = await regenerateGoldenFrames(binaryVersion);
    const captures = loadDemoCaptures();
    for (const cockpit of ["run", "setup"] as const) {
      const colourless = generatedById(generated, `${cockpit}-no-colour`);
      const coloured = await captureRendererOutput(
        interactiveFrameNode(
          cockpit,
          captures,
          binaryVersion,
          140,
          24,
        ),
        { columns: 140, rows: 24, colour: true },
      );

      expect(colourless).not.toContain("\x1b");
      expect(colourless).toBe(coloured.replace(ANSI, ""));
    }
    for (const frame of generated.filter((candidate) =>
      candidate.renderer === "frame"
    )) {
      expect(frame.output, frame.id).not.toContain("\x1b");
    }

    const run = generatedById(generated, "run-no-colour");
    const setup = generatedById(generated, "setup-no-colour");
    expect(run).toMatch(/✓\s+tip-verify passed/);
    expect(run).toMatch(/-\s+failed 0/);
    expect(run).toMatch(/!\s+escalated \d+/);
    expect(setup).toMatch(/✓\s+authed/);
    expect(setup).toMatch(/○\s+missing/);
    expect(setup).toMatch(/✗\s+denied/);
    expect(setup).toMatch(/!\s+\d+ changes unsaved/);
  });

  test("test: a frame rendered from a healthy capture carries no warning or failure ink anywhere in it, so any warm ink in a frame means something needs attention", async () => {
    const bytes = readFileSync(HEALTHY_SOURCE, "utf8");
    const data = deriveRunCockpitData(
      { fileName: HEALTHY_SOURCE_NAME, raw: bytes },
      "9.8.7",
    );

    expect(data.statusItems.every((item) =>
      item.state === "pass" || item.state === "neutral"
    )).toBe(true);
    expect(data.journalRows.every((item) =>
      item.state === "pass" || item.state === "neutral"
    )).toBe(true);
    const frame = await captureRendererOutput(
      createElement(RunCockpitFrame, { data, columns: 140 }),
      { columns: 140, rows: 24, colour: true },
    );
    expect(frame).not.toMatch(WARM_INK);
  });

  test("test: in a non-interactive environment, including the one where the box renderer is known to emit nothing at all, the surface emits the plain renderer's output rather than an empty screen", async () => {
    const nonTty = memoryStream(false, 140, 24);
    const nonTtyEmission = await captureCockpitOutput({
      cockpit: "run",
      output: nonTty,
      binaryVersion: "9.8.7",
      colour: true,
      ci: false,
      plainRenderer: () => "plain non-tty output\n",
    });
    const ci = memoryStream(true, 140, 24);
    const ciEmission = await captureCockpitOutput({
      cockpit: "run",
      output: ci,
      binaryVersion: "9.8.7",
      interactive: true,
      colour: true,
      ci: true,
      plainRenderer: () => "plain CI output\n",
    });
    const empty = memoryStream(true, 140, 24);
    const emptyEmission = await captureCockpitOutput({
      cockpit: "run",
      output: empty,
      binaryVersion: "9.8.7",
      interactive: true,
      colour: true,
      ci: false,
      plainRenderer: () => "plain empty-render output\n",
      frameRenderer: async () => "",
    });

    expect(nonTtyEmission.output).toBe("plain non-tty output\n");
    expect(ciEmission.output).toBe("plain CI output\n");
    expect(emptyEmission.output).toBe("plain empty-render output\n");
    expect(nonTty.writes.join("")).toBe(nonTtyEmission.output);
    expect(ci.writes.join("")).toBe(ciEmission.output);
    expect(empty.writes.join("")).toBe(emptyEmission.output);
  });

  test("test: no decorated output reaches a stream that is not an interactive terminal", async () => {
    for (const cockpit of ["run", "setup"] as const) {
      const output = memoryStream(false, 140, 24);
      const emission = await captureCockpitOutput({
        cockpit,
        output,
        binaryVersion: "9.8.7",
        colour: true,
        ci: false,
      });

      expect(emission.renderer).toBe("plain");
      expect(output.writes.join("")).toBe(emission.output);
      expect(emission.output).not.toMatch(DECORATED);
    }
  });

  test("every committed frame is a verbatim capture of the renderer rather than authored text", async () => {
    const generated = await regenerateGoldenFrames();
    const committed = fixtureBytes();

    for (const frame of generated) {
      expect(committed.get(frame.fixture)).toBe(frame.emitted);
    }
  });

  test("the regeneration check would fail if a frame were edited by hand to satisfy an assertion", async () => {
    const generated = await regenerateGoldenFrames();
    const edited = fixtureBytes();
    const target = generated.find((frame) => frame.renderer === "frame");
    if (!target) throw new Error("no decorated golden frame exists");
    edited.set(target.fixture, `${edited.get(target.fixture)}hand edit\n`);

    expect(findGoldenFrameMismatches(generated, edited)).toEqual([
      target.fixture,
    ]);
  });
});

describe("cockpit healthy capture read, never named", () => {
  test("test: no capture is read through any filter, and the bytes an oracle renders are the bytes the capture holds", async () => {
    const bytes = readFileSync(HEALTHY_SOURCE, "utf8");
    const self = readFileSync(SELF, "utf8");

    // The bytes are the capture: digest-pinned, parsed whole, filtered by
    // nothing. The escalation-stripping read this oracle once used is gone.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      HEALTHY_SOURCE_SHA256,
    );
    expect(self).not.toMatch(/\.filter\(\s*\(line\)/);
    const events = readCapturedEvents(bytes);
    expect(events).toHaveLength(bytes.trimEnd().split("\n").length);

    // What the oracle renders is derived from those held bytes and no others.
    const data = deriveRunCockpitData(
      { fileName: HEALTHY_SOURCE_NAME, raw: bytes },
      "9.8.7",
    );
    expect(data.journalRows).toHaveLength(events.length);
    const frame = await captureRendererOutput(
      createElement(RunCockpitFrame, { data, columns: 140 }),
      { columns: 140, rows: 24, colour: false },
    );
    expect(frame.replace(ANSI, "")).toContain("run-20260718-000943");
  });

  test("test: every capture the code treats as healthy is asserted to contain zero events recording a failure by any of those forms, by reading the capture rather than by its name", () => {
    const bytes = readFileSync(HEALTHY_SOURCE, "utf8");
    const events = readCapturedEvents(bytes);

    expect(events.length).toBeGreaterThan(0);
    expect(events.filter(recordsFailure)).toEqual([]);
    expect(
      events.filter((event) =>
        event.event === "escalation" || event.event === "task-human"
      ),
    ).toEqual([]);

    // Health is read, never granted by a name: nothing in scope may label the
    // eventful engagement healthy, because it is not.
    const engagement = ["run-20260724", "231138"].join("-");
    const sources = [
      ...["frames.test.ts", "derive.test.ts", "demo.test.ts", "height.test.ts"]
        .map((file) => join(import.meta.dirname, file)),
      join(import.meta.dirname, "../../src/tui/cockpit/demo.ts"),
    ];
    for (const file of sources) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        expect(
          line.includes("healthy") && line.includes(engagement),
          `${file}: ${line}`,
        ).toBe(false);
      }
    }
  });

  test("test: introducing one failure event into the capture treated as healthy makes the preceding check fail, so a mislabelled capture cannot pass", () => {
    const bytes = readFileSync(HEALTHY_SOURCE, "utf8");
    const events = readCapturedEvents(bytes);
    const last = events.at(-1)!;
    const poisonedBytes = `${bytes.trimEnd()}\n${JSON.stringify({
      ts: last.ts,
      event: "gate-result",
      taskId: "T1",
      data: { gate: "test", pass: false },
    })}\n`;

    const poisoned = readCapturedEvents(poisonedBytes);
    expect(poisoned.filter(recordsFailure)).toHaveLength(1);
    expect(() => {
      expect(poisoned.filter(recordsFailure)).toEqual([]);
    }).toThrow();

    const data = deriveRunCockpitData(
      { fileName: HEALTHY_SOURCE_NAME, raw: poisonedBytes },
      "9.8.7",
    );
    expect(data.journalRows.some((row) => row.state === "fail")).toBe(true);
  });
});

describe("cockpit approved appearance pinned to frozen anchors", () => {
  test("test: each frozen anchor of the run surface matches the freshly rendered frame byte for byte once the journal panel's interior rows are removed from both, so approved appearance is pinned while surplus absorption stays legal", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    expect(anchors.size).toBeGreaterThan(0);
    expect(anchorMismatches(generated, anchors)).toEqual([]);
    // The exclusion is load-bearing rather than decorative: the full arrangement
    // needs fewer rows than it is given, so the journal really does absorb some.
    expect([...anchors.values()].some((bytes) =>
      pinnedProjection(bytes).excludedRows > 0
    )).toBe(true);
  });

  test("test: the journal panel's top border row and its title row are inside that comparison rather than excluded from it", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();
    const framed = [...anchors].filter(([, bytes]) =>
      journalPanel(bytes) !== undefined
    );

    expect(framed.length).toBeGreaterThan(0);
    for (const [fixture, bytes] of framed) {
      const panel = journalPanel(bytes)!;
      const lines = bytes.split("\n");
      const projection = pinnedProjection(bytes).text;

      expect(projection, `${fixture} top border`).toContain(lines[panel.top]);
      expect(projection, `${fixture} title`).toContain(lines[panel.top + 1]);
      // Containment is not enough on its own — a kept row must also be able to
      // reject a change, so disturb each one inside the panel's own span.
      for (const row of [panel.top, panel.top + 1]) {
        const mutated = new Map(anchors).set(
          fixture,
          mutateRow(bytes, row, (line) => replaceColumn(line, panel.left + 1, "x")),
        );

        expect(anchorMismatches(generated, mutated), `${fixture} row ${row}`)
          .toEqual([fixture]);
      }
    }
  });

  test("test: the removal of journal interior rows is structural rather than positional, so a taller journal shifting every line beneath it does not fail the comparison", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();
    const framed = [...anchors].filter(([, bytes]) =>
      journalPanel(bytes) !== undefined
    );

    expect(framed.length).toBeGreaterThan(0);
    for (const [fixture, bytes] of framed) {
      const panel = journalPanel(bytes)!;
      const lines = bytes.split("\n");
      const entry = lines[panel.bottom - 1]!;
      // A journal handed two more surplus rows: the panel grows downward and the
      // status strip and keybar beneath it both move.
      const taller = [
        ...lines.slice(0, panel.bottom),
        entry,
        entry,
        ...lines.slice(panel.bottom),
      ].join("\n");

      expect(taller.split("\n").length, fixture).toBe(lines.length + 2);
      expect(pinnedProjection(taller).text, fixture).toBe(
        pinnedProjection(bytes).text,
      );
      expect(pinnedProjection(taller).excludedRows, fixture).toBe(
        pinnedProjection(bytes).excludedRows + 2,
      );
      expect(anchorMismatches(generated, new Map(anchors).set(fixture, taller)))
        .toEqual([]);
    }
  });

  test("test: the plain-renderer anchors are pinned whole with no exclusion at all, since they carry no journal panel", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();
    const plain = [...anchors].filter(([, bytes]) =>
      journalPanel(bytes) === undefined
    );

    expect(plain.length).toBeGreaterThan(0);
    for (const [fixture, bytes] of plain) {
      expect(bytes, fixture).not.toMatch(DECORATED);
      expect(pinnedProjection(bytes).excludedRows, fixture).toBe(0);
      expect(pinnedProjection(bytes).text, fixture).toBe(bytes);
      // Whole means whole: every row of it rejects a change, not merely the rows
      // a journal-bearing frame would have kept.
      const lines = bytes.split("\n");
      for (const [row, line] of lines.entries()) {
        if (line.length === 0) continue;
        const mutated = new Map(anchors).set(
          fixture,
          mutateRow(bytes, row, (candidate) => `${candidate}x`),
        );

        expect(anchorMismatches(generated, mutated), `${fixture} row ${row}`)
          .toEqual([fixture]);
      }
    }
  });

  test("test: the comparison reads the frozen anchor set rather than the working corpus, so regenerating the working corpus cannot move the target", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    expect(ANCHORS).not.toBe(FIXTURES);
    expect(ANCHORS.startsWith(FIXTURES)).toBe(false);
    expect(FIXTURES.startsWith(ANCHORS)).toBe(false);
    for (const [fixture, bytes] of anchors) {
      expect(bytes, fixture).toBe(readFileSync(join(ANCHORS, fixture), "utf8"));
    }
    // The target is the bytes handed in, so a stand-in that is not the frozen set
    // is rejected wholesale — a regenerated corpus could never be mistaken for it.
    expect(anchorMismatches(
      generated,
      new Map([...anchors.keys()].map((fixture) => [fixture, "laundered\n"])),
    )).toEqual([...anchors.keys()].sort());
    expect(anchorMismatches(generated, anchors)).toEqual([]);
  });

  test("test: mutating a frozen anchor in memory makes the comparison fail, so the pin can reject the laundering it exists to close", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    expect(anchors.size).toBeGreaterThan(0);
    for (const [fixture, bytes] of anchors) {
      const panel = journalPanel(bytes);
      const row = panel ? panel.top + 1 : 0;
      const mutated = new Map(anchors).set(
        fixture,
        mutateRow(bytes, row, (line) => `${line} drifted`),
      );

      expect(anchorMismatches(generated, mutated), fixture).toEqual([fixture]);
    }
  });

  test("test: the comparison covers every frozen anchor present on disk, so a frame silently dropped from the set fails rather than passes", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    // The manifest is derived from the shipped case list, not from the directory
    // listing, so deleting an anchor fails here instead of quietly shrinking the
    // comparison to whatever is left.
    expect([...anchors.keys()].sort()).toEqual(
      GOLDEN_FRAME_CASES
        .filter((item) =>
          item.cockpit === "run" && !UNANCHORED_RUN_FRAMES.has(item.fixture)
        )
        .map((item) => item.fixture)
        .sort(),
    );
    // Every one of them is actually visited: disturb them all and all are named.
    expect(anchorMismatches(
      generated,
      new Map([...anchors].map(([fixture, bytes]) => [fixture, `${bytes}drift\n`])),
    )).toEqual([...anchors.keys()].sort());
    // An anchor with no rendered counterpart is a failure, never a skip.
    expect(anchorMismatches([], anchors)).toEqual([...anchors.keys()].sort());
  });

  test("test: the frozen anchor set is read from disk rather than restated in the test, so an anchor and its expectation cannot drift into agreement", () => {
    const anchors = anchorBytes();
    const source = readFileSync(SELF, "utf8");

    expect(anchors.size).toBeGreaterThan(0);
    for (const [fixture, bytes] of anchors) {
      expect(bytes, fixture).toBe(readFileSync(join(ANCHORS, fixture), "utf8"));
      for (const line of bytes.split("\n")) {
        if (line.trim().length === 0) continue;
        expect(source.includes(line), `${fixture} restates: ${line}`).toBe(false);
      }
    }
  });
});
