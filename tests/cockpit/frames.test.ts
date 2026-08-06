import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, test } from "vitest";
import {
  COLOUR_FRAME_CASES,
  type CockpitName,
  GOLDEN_FRAME_CASES,
  HEIGHT_TIER_BOUNDARIES,
  RETIRED_RENDERED_COCKPITS,
  type RegeneratedGoldenFrame,
  WIDTH_BAND_CASES,
  captureCockpitOutput,
  captureRendererOutput,
  findGoldenFrameMismatches,
  goldenFrameMatchesCommitted,
  isRetiredGoldenFrame,
  normalizeGoldenFrameVersionForComparison,
  regenerateColourFrames,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import {
  loadDemoCaptures,
  type DemoCaptures,
} from "../../src/tui/cockpit/demo.js";
import { PLAIN_COMPACT_LOCKUP } from "../../src/brand.js";
import { planFrame, resolveCockpitLayout } from "../../src/tui/cockpit/layout.js";
import {
  RunCockpitFrame,
  deriveRunCockpitData,
} from "../../src/tui/cockpit/run-cockpit.js";
import {
  SetupCockpitFrame,
  deriveSetupCockpitData,
} from "../../src/tui/cockpit/setup-cockpit.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/cockpit/frames");
const COLOUR_FIXTURES = join(import.meta.dirname, "../fixtures/cockpit/colour");
/**
 * The frozen appearance oracle. It is a directory of its own, apart from the
 * regenerable working corpus, precisely so that regenerating the corpus cannot
 * move the target — and it holds anchors and nothing else, because the review
 * gate treats this prefix as protected evidence, which is a poor place to
 * shelter anything the oracle does not read.
 *
 * Its bytes are never rewritten to make an assertion pass, and there are exactly
 * two things that may happen to a frame the contract has left behind:
 *
 * RETIRE — the region the contract MOVED is declared (see CONTRACT_MOVED_PANELS
 * below) and the anchor keeps every byte it holds. Re-freezing the moved regions
 * waits for operator-accepted frames after UAT — OBS-207.
 *
 * RE-STAMP — where the frozen tier simply fell BEHIND production, with no
 * contract having moved, the bytes catch up in the open: one commit of its own,
 * touching nothing but anchors, its message naming the production change it
 * answers to, its whole diff confined to the region that drifted. That is the
 * opposite of a declaration papering over drift — it is the drift, recorded. The
 * keys line every anchor holds was re-stamped this way for bba480a0, and the
 * test bearing that criterion reads the commit back out of history to prove it —
 * by what the commit is rather than by where it sits, so a shallow CI checkout
 * or the one-commit public export, which carry no anchor change at all, answer
 * the same query rather than being excused from it. What the re-stamp achieved
 * is checked against the renderer in every checkout regardless: the keys line
 * each anchor holds is the one production emits today.
 */
const ANCHORS = join(import.meta.dirname, "../fixtures/cockpit/anchors");
const REPO_ROOT = join(import.meta.dirname, "../..");
/** The anchors' path as history spells it — the prefix a re-stamp stays inside. */
const ANCHORS_DIR = `${relative(REPO_ROOT, ANCHORS)}/`;
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
/**
 * The two machine surfaces. They open no panel and draw no header band above
 * one, so neither declared name below reaches them: every byte they hold is
 * compared, the keys line included. Where their frozen tier had fallen behind
 * production the bytes were re-stamped visibly — in the commit whose message
 * names the production change below — rather than exempted from the comparison.
 */
const MACHINE_SURFACE_ANCHORS = [
  "run.ci.140x24.txt",
  "run.non-tty.140x24.txt",
] as const;
/**
 * The six rendered anchors this redesign supersedes, DECLARED retired rather
 * than deleted or re-frozen. Read off the shipped manifest's own retirement
 * predicate, so it cannot drift from it, and the declaration is what removes
 * them from every comparison — the suite is neutral to the files.
 */
const RETIRED_RENDERED_ANCHORS: ReadonlySet<string> = new Set(
  GOLDEN_FRAME_CASES
    .filter((item) =>
      isRetiredGoldenFrame(item) && !UNANCHORED_RUN_FRAMES.has(item.fixture)
    )
    .map((item) => item.fixture),
);
/**
 * The production commit that moved what every surface advertises, and so the
 * change the anchors' re-stamp answers to. Its message names this hash, which is
 * how a re-stamp is attributable rather than anonymous.
 */
const RE_STAMP_ATTRIBUTION = "bba480a0";
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
  // No pre-slicing: the frame resolves its own height ladder, as the capture
  // path hands it.
  return createElement(RunCockpitFrame, {
    data: deriveRunCockpitData(source, binaryVersion),
    columns,
    rows,
  });
}

/**
 * The repository's own record of what was changed and why. A re-stamp is only
 * "visible" if it can be read back out of history as its own commit, so the
 * proof reads history rather than the operator's word for it.
 */
function gitText(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
}

function gitLines(args: readonly string[]): string[] {
  return gitText(args).split("\n").filter((line) => line.length > 0);
}

function anchorBytes(): Map<string, string> {
  return new Map(
    readdirSync(ANCHORS)
      .sort()
        // Declaration applied: a retired anchor never enters a comparison.
      .filter((anchor) => !RETIRED_RENDERED_ANCHORS.has(anchor))
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

/**
 * The bytes are read as they stand: nothing is stripped on the way in, escape
 * sequences included, so a frame that grew one is measured with it rather than
 * without it. No committed frame carries any.
 */
function borderedRegions(output: string): BorderedRegion[] {
  const grid = output.split("\n").map((line) => [...line]);
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

type ProjectionCell = {
  readonly declaration: string;
  readonly row: number;
  readonly column: number;
  /**
   * What the comparison form holds in that cell once the declaration applies —
   * a blank where the cell stays, the empty string where the roster is taken out.
   */
  readonly glyph: string;
};

type PinnedProjection = {
  readonly text: string;
  readonly excludedRows: number;
  /** The comparison form row by row, before the journal's absorbed rows are dropped. */
  readonly lines: readonly string[];
  /** Every cell a declaration reaches, attributed to the declaration that reached it. */
  readonly covered: readonly ProjectionCell[];
};

/**
 * THE DECLARATION — the signed contract's one door, and the only one.
 *
 * `docs/superpowers/specs/2026-07-28-v1.83-watchsetup-contract.md` §6 retires the
 * superseded rendered anchors by DECLARING the regions whose contract moved. It
 * never rewrites an anchor byte: re-freezing waits for operator-accepted frames
 * after UAT, and declaring is the whole of what a task may do (OBS-207).
 *
 * Two names, and no third. Each is proven load-bearing by withdrawing it against
 * the unmodified committed anchors with nothing staged and nothing manufactured:
 *
 *   MARK  the header mark, removed by D1. Declared as GEOMETRY — the mark's own
 *         box, MARK_BOX below — and never as "a block glyph somewhere in the
 *         header": the same alphabet draws the sparklines and the meter, and a
 *         block drawn in header space the mark does not own is a change, not a
 *         mark.
 *   KEYS  the rail the contract deletes, whole. Declared as GEOMETRY too: the
 *         rail panel's own interior, located by the panel's caption and its own
 *         box. What the rail may say is never asked of the production key
 *         registry — a declaration that took its answer from the registry would
 *         widen itself every time the registry moved, and so could never fail.
 *         The panel's border, its caption row, its width and its position all
 *         stay byte-compared: the box the keys sat in is pinned even though what
 *         it held is retired.
 *
 * Both are located by caption or by declared geometry, never by a line number, so
 * a frame that grows above one of them still excises the right cells. A machine
 * surface opens no panel and draws no header band above one, so neither name
 * reaches run.ci or run.non-tty: every appearance byte stays compared, keys
 * line included. The release-owned first-line version token is canonicalized
 * before this projection. Where their frozen tier fell behind production the
 * anchors were re-stamped visibly rather than exempted here.
 *
 * No appearance cell is normalised or substituted. Every cell either name
 * reaches is BLANKED WHERE IT STANDS — never rewritten to another glyph, never
 * dropped, never swapped for a roster read from somewhere else — so every row
 * keeps the width it was drawn at, no escape sequence is stripped, no whitespace
 * is collapsed and no row is emptied. Every cell the comparison cannot see is a
 * cell one of the two names above reaches, recorded with the name that reached it.
 *
 * Everything else stays pinned byte for byte: the header's run identity and its
 * spacing, the VIEWS rail the contract does not name, the stat tiles and their
 * series, the progress meter, the journal panel's chrome, the focus ring, the
 * status strip, the keybar, and every panel's position and width.
 */
const CONTRACT_MOVED_PANELS: ReadonlySet<string> = new Set(["MARK", "KEYS"]);
/**
 * The mark's own box: the header's top two rows, left of the column where the
 * header's first word begins. Declared in advance rather than inferred, so a
 * block glyph outside it — a series, a meter, a block dropped into header
 * whitespace — is compared as the change it is.
 */
const MARK_BOX = { rows: 2, columns: 18 } as const;
/** The machine surface's own word for the row it prints its roster on. */
const KEYS_LABEL = "keys ";
/** The separator a keybar roster is drawn with, on every surface that draws one. */
const KEY_SEPARATOR = " · ";

function lastPaintedRow(lines: readonly string[]): number {
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    if (lines[row]!.trim().length > 0) return row;
  }
  return -1;
}

/**
 * The comparison form of a frame: every byte it draws, less the cells the
 * declaration above covers and the journal panel's absorbed entry rows. The
 * journal panel's top border and its caption row stay in, because the panel's
 * own shape is approved appearance; only what it absorbs is allowed to grow.
 *
 * The bytes arrive as they stand — nothing stripped, nothing collapsed, no row
 * emptied, every line the width it was drawn at — and nothing here reaches a
 * cell without recording that it did, so the cells the comparison cannot see are
 * exactly the cells a declaration names.
 */
function pinnedProjection(
  output: string,
  declared: ReadonlySet<string> = CONTRACT_MOVED_PANELS,
): PinnedProjection {
  const regions = borderedRegions(output);
  const grid = output.split("\n").map((line) => [...line]);
  const covered: ProjectionCell[] = [];
  const cover = (
    declaration: string,
    row: number,
    column: number,
    glyph: string,
  ): void => {
    const cells = grid[row];
    if (!cells || column < 0 || column >= cells.length) return;
    covered.push({ declaration, row, column, glyph });
    cells[column] = glyph;
  };
  // A machine surface opens no panel, so it has no header band above one and no
  // rail: neither appearance declaration reaches it.
  const headerRows = regions.length
    ? Math.min(...regions.map((region) => region.top))
    : 0;
  if (declared.has("MARK")) {
    for (let row = 0; row < Math.min(MARK_BOX.rows, headerRows); row += 1) {
      for (let column = 0; column < MARK_BOX.columns; column += 1) {
        cover("MARK", row, column, " ");
      }
    }
  }
  for (const region of regions) {
    const caption = region.content.split("\n")[0]?.trim() ?? "";
    if (!declared.has(caption)) continue;
    // The rail's interior, and only its interior: its border columns, its top
    // border row and its caption row are outside the loop and stay compared.
    for (let row = region.top + 2; row < region.bottom; row += 1) {
      for (let column = region.left + 1; column < region.right; column += 1) {
        cover(caption, row, column, " ");
      }
    }
  }

  const lines = grid.map((cells) => cells.join(""));
  const panel = regions.find((region) =>
    region.content.split("\n")[0]?.trim() === "JOURNAL"
  );
  if (!panel) {
    return { text: lines.join("\n"), excludedRows: 0, lines, covered };
  }
  return {
    text: [
      ...lines.slice(0, panel.top + 2),
      ...lines.slice(panel.bottom),
    ].join("\n"),
    excludedRows: panel.bottom - panel.top - 2,
    lines,
    covered,
  };
}

/** The panel a declared-region proof disturbs, with its own interior located. */
function movedPanel(output: string): BorderedRegion | undefined {
  return borderedRegions(output).find((region) =>
    CONTRACT_MOVED_PANELS.has(region.content.split("\n")[0]?.trim() ?? "")
  );
}

function anchorMismatches(
  generated: readonly RegeneratedGoldenFrame[],
  anchors: ReadonlyMap<string, string>,
  declared: ReadonlySet<string> = CONTRACT_MOVED_PANELS,
  onProjection?: (fixture: string) => void,
): string[] {
  const fresh = new Map(generated.map((frame) => [frame.fixture, frame]));
  return [...anchors]
    .flatMap(([fixture, frozen]) => {
      const rendered = fresh.get(fixture);
      if (rendered === undefined) return [fixture];
      // Machine surfaces do not enter a projection at all. This is decided from
      // the frozen fixture's identity, not from its present lack of panel chrome,
      // so adding frame-like geometry tomorrow cannot make a declaration reach it.
      if ((MACHINE_SURFACE_ANCHORS as readonly string[]).includes(fixture)) {
        return goldenFrameMatchesCommitted(rendered, frozen) ? [] : [fixture];
      }
      onProjection?.(fixture);
      return pinnedProjection(
        normalizeGoldenFrameVersionForComparison(rendered, frozen),
        declared,
      ).text
          === pinnedProjection(
            normalizeGoldenFrameVersionForComparison(rendered, rendered.output),
            declared,
          ).text
        ? []
        : [fixture];
    })
    .sort();
}

/** The row a frame advertises its keys on, and how much of it the surface owns. */
function keybarRow(bytes: string): { row: number; label: number } {
  const lines = bytes.split("\n");
  const row = lastPaintedRow(lines);
  return {
    row,
    label: lines[row]?.startsWith(KEYS_LABEL) === true ? KEYS_LABEL.length : 0,
  };
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
    expect(RETIRED_RENDERED_COCKPITS).toEqual(["run"]);
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
      expect(
        goldenFrameMatchesCommitted(frame, committed.get(frame.fixture)),
        frame.fixture,
      ).toBe(true);
    }
  });

  test("test: every committed frame is regenerated from the corrected capture path, and the regeneration check passes against the regenerated frames", async () => {
    const generated = await regenerateGoldenFrames();

    expect(findGoldenFrameMismatches(generated, fixtureBytes())).toEqual([]);
  });

  test("test: a committed frame contains a bordered panel enclosing its own content across more than one row, which a flat line renderer cannot produce", () => {
    const frame = readFileSync(
      join(FIXTURES, "setup.height-40.140x40.txt"),
      "utf8",
    );

    expect(borderedRegions(frame).some((region) =>
      region.interiorRows > 1
      && region.content.includes("SETUP")
      && region.content.includes("Detect")
    )).toBe(true);
  });

  test("test: a committed frame contains a stat tile whose value and whose series both sit inside the tile's own border", () => {
    const frame = readFileSync(
      join(FIXTURES, "setup.height-40.140x40.txt"),
      "utf8",
    );

    expect(borderedRegions(frame).some((region) =>
      region.content.includes("FOUND")
      && region.content.includes("7")
      && /[▁▂▃▄▅▆▇█]/u.test(region.content)
    )).toBe(true);
  });

  test("test: a committed frame contains the journal panel's rows inside a border rather than as bare lines", () => {
    // The run surface's journal is an unboxed tail band now; the criterion is
    // about bordered rows, not about which surface draws them.
    const frame = readFileSync(
      join(FIXTURES, "setup.height-40.140x40.txt"),
      "utf8",
    );

    expect(borderedRegions(frame).some((region) =>
      region.content.includes("DETECTED")
      && region.content.includes("✓")
      && region.interiorRows > 1
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
      const node = () =>
        interactiveFrameNode(cockpit, captures, binaryVersion, 140, 24);
      // The run surface commits no live colourless golden — its rendered
      // corpus is retired — so that frame is rendered rather than read. The
      // bytes judged are still the renderer's own; nothing new is pinned.
      const colourless = RETIRED_RENDERED_COCKPITS.includes(cockpit)
        ? await captureRendererOutput(node(), {
          columns: 140,
          rows: 24,
          colour: false,
        })
        : generatedById(generated, `${cockpit}-no-colour`);
      const coloured = await captureRendererOutput(node(), {
        columns: 140,
        rows: 24,
        colour: true,
      });

      expect(colourless).not.toContain("\x1b");
      expect(colourless).toBe(coloured.replace(ANSI, ""));
    }
    for (const frame of generated.filter((candidate) =>
      candidate.renderer === "frame"
    )) {
      expect(frame.output, frame.id).not.toContain("\x1b");
    }

    const run = await captureRendererOutput(
      interactiveFrameNode("run", captures, binaryVersion, 140, 40),
      { columns: 140, rows: 40, colour: false },
    );
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

  test("test: every committed golden frame regenerates from the renderer, so a hand-edited fixture fails", async () => {
    const generated = await regenerateGoldenFrames();
    const committed = fixtureBytes();

    // The corpus is the manifest's, whole: nothing committed is unclaimed and
    // nothing claimed is missing.
    expect([...committed.keys()].sort()).toEqual(
      GOLDEN_FRAME_CASES.map((item) => item.fixture).sort(),
    );
    expect(findGoldenFrameMismatches(generated, committed)).toEqual([]);
    const retired = GOLDEN_FRAME_CASES.filter((item) => isRetiredGoldenFrame(item));
    expect(retired.length).toBeGreaterThan(0);
    expect(generated).toHaveLength(GOLDEN_FRAME_CASES.length - retired.length);
    for (const frame of generated) {
      expect(isRetiredGoldenFrame(frame), frame.fixture).toBe(false);
    }

    for (const frame of generated) {
      // Every one of them is the renderer's own emitted bytes, not authored text:
      // what the capture path wrote to the stream is what the file holds.
      expect(frame.emitted, frame.fixture).toBe(frame.output);
      expect(
        goldenFrameMatchesCommitted(frame, committed.get(frame.fixture)),
        frame.fixture,
      ).toBe(true);
      // And each is individually load-bearing: hand-edit that one fixture and the
      // regeneration check names it, so no committed frame can be authored into
      // agreement with an assertion.
      const edited = new Map(committed).set(
        frame.fixture,
        `${committed.get(frame.fixture)}hand edit\n`,
      );

      expect(findGoldenFrameMismatches(generated, edited), frame.fixture)
        .toEqual([frame.fixture]);
    }
  });

  test("test: regenerating the corpus at an injected version different from package.json still matches every active committed capture, where the population is the PREDICATE the goal states — every route under tests/cockpit comparing committed bytes to a fresh render — covered one member per ROUTE over the closed set of routes: the golden-frame choke point, the anchor choke point, and a direct compare living inside a suite rather than in either choke point, with the setup members spanning every committed WIDTH tier because the version token sits at a different column in each", async () => {
    const generated = await regenerateGoldenFrames("987.65.4-rc.2");
    const committed = fixtureBytes();

    expect(findGoldenFrameMismatches(generated, committed)).toEqual([]);
    expect(anchorMismatches(generated, anchorBytes())).toEqual([]);

    const setupWidths = generated.filter((frame) =>
      frame.cockpit === "setup" && frame.axis === "width"
    );
    expect(setupWidths.map((frame) => frame.columns)).toEqual(
      WIDTH_BAND_CASES.map((item) => item.columns),
    );
    for (const frame of setupWidths) {
      expect(
        goldenFrameMatchesCommitted(frame, committed.get(frame.fixture)),
        frame.fixture,
      ).toBe(true);
    }
  });

  test("test: retired evidence is excluded from the equality population rather than normalized into agreement, proven member by member over the closed set of retired corpora — a retired rendered run golden, a declared-retired anchor and a colour capture — with the colour corpus still required to differ from what the renderer draws today", async () => {
    const generated = await regenerateGoldenFrames("987.65.4-rc.2");
    const retiredGolden = GOLDEN_FRAME_CASES.find((frame) =>
      frame.fixture === "run.width-three-column.140x24.txt"
    );
    if (!retiredGolden) throw new Error("retired rendered run golden is absent");
    expect(isRetiredGoldenFrame(retiredGolden)).toBe(true);
    expect(generated.some((frame) => frame.fixture === retiredGolden.fixture))
      .toBe(false);

    const retiredAnchor = "run.width-three-column.140x24.txt";
    expect(readFileSync(join(ANCHORS, retiredAnchor), "utf8").length)
      .toBeGreaterThan(0);
    expect(anchorBytes().has(retiredAnchor)).toBe(false);

    const colourCase = COLOUR_FRAME_CASES[0];
    const renderedColour = (await regenerateColourFrames()).find((frame) =>
      frame.fixture === colourCase.fixture
    );
    if (!renderedColour) throw new Error("colour corpus member was not rendered");
    const committedColour = readFileSync(
      join(COLOUR_FIXTURES, colourCase.fixture),
      "utf8",
    );
    expect(committedColour).not.toBe(renderedColour.output);
  });

  test("test: a hand-edited capture still fails the regeneration check, proven over the closed set of tamper shapes — a changed-status fixture, a changed-glyph fixture and an appended-blank-line fixture", async () => {
    const generated = await regenerateGoldenFrames();
    const committed = fixtureBytes();
    const tampered = [
      {
        fixture: "run.ci.140x24.txt",
        bytes: committed.get("run.ci.140x24.txt")!
          .replace(" done ", " running "),
      },
      {
        fixture: "setup.width-stacked.80x24.txt",
        bytes: committed.get("setup.width-stacked.80x24.txt")!
          .replace("binary ✓", "binary ✗"),
      },
      {
        fixture: "setup.height-40.140x40.txt",
        bytes: `${committed.get("setup.height-40.140x40.txt")}\n`,
      },
    ] as const;

    for (const { fixture, bytes } of tampered) {
      expect(bytes, `${fixture} mutation changed bytes`)
        .not.toBe(committed.get(fixture));
      expect(
        findGoldenFrameMismatches(
          generated,
          new Map(committed).set(fixture, bytes),
        ),
        fixture,
      ).toEqual([fixture]);
    }
  });

  test("test: within the active equality population normalization reaches only the version token in the two first-line header forms that population uses, and no header form belonging solely to a retired population is normalized at all, proven over the closed set of header mutations — a version-only fixture that matches, and a wrong-position fixture, a second-occurrence fixture and a malformed-header fixture that each mismatch", async () => {
    const committed = fixtureBytes();
    const injected = await regenerateGoldenFrames("987.65.4-rc.2");
    const plain = injected.find((frame) => frame.fixture === "run.ci.140x24.txt");
    const setup = injected.find((frame) =>
      frame.fixture === "setup.width-three-column.140x24.txt"
    );
    if (!plain || !setup) throw new Error("active header witnesses were not rendered");
    const plainBytes = committed.get(plain.fixture)!;
    const setupBytes = committed.get(setup.fixture)!;
    const mutateHeader = (
      bytes: string,
      mutate: (header: string) => string,
    ): string => {
      const lines = bytes.split("\n");
      lines[0] = mutate(lines[0]!);
      return lines.join("\n");
    };

    expect(goldenFrameMatchesCommitted(plain, plainBytes)).toBe(true);
    expect(goldenFrameMatchesCommitted(setup, setupBytes)).toBe(true);
    expect(
      goldenFrameMatchesCommitted(plain, mutateHeader(
        plainBytes,
        (header) => ` ${header}`,
      )),
      "wrong-position fixture",
    ).toBe(false);
    expect(
      goldenFrameMatchesCommitted(setup, mutateHeader(
        setupBytes,
        (header) => header.replace(
          /( +)(v\d+\.\d+\.\d+ · binary ✓)$/u,
          " v1.85.0$1$2",
        ),
      )),
      "second-occurrence fixture",
    ).toBe(false);
    expect(
      goldenFrameMatchesCommitted(plain, mutateHeader(
        plainBytes,
        (header) => header.replace("tickmarkr v", "tickmarkr version "),
      )),
      "malformed-header fixture",
    ).toBe(false);

    const retired = GOLDEN_FRAME_CASES.find((frame) =>
      frame.fixture === "run.width-three-column.140x24.txt"
    );
    if (!retired) throw new Error("retired header witness is absent");
    const captures = loadDemoCaptures();
    const retiredCommittedVersion = await captureRendererOutput(
      interactiveFrameNode(
        "run",
        captures,
        "1.85.0",
        retired.columns,
        retired.rows,
      ),
      { columns: retired.columns, rows: retired.rows, colour: false },
    );
    const retiredInjectedVersion = await captureRendererOutput(
      interactiveFrameNode(
        "run",
        captures,
        "987.65.4-rc.2",
        retired.columns,
        retired.rows,
      ),
      { columns: retired.columns, rows: retired.rows, colour: false },
    );
    expect(retiredCommittedVersion).toContain("tickmarkr 1.85.0");
    expect(retiredInjectedVersion).toContain("tickmarkr 987.65.4-rc.2");
    expect(goldenFrameMatchesCommitted(
      {
        ...retired,
        renderer: "frame",
        output: retiredInjectedVersion,
        emitted: retiredInjectedVersion,
      },
      retiredCommittedVersion,
    )).toBe(false);
  });

  test("test: normalization cannot manufacture agreement, proven by an absent committed capture reporting a mismatch rather than a skip and by every committed capture still carrying a literal version string afterwards rather than a stripped one (OBS-306 question 1 — the absent case must not be representable as agreement)", async () => {
    const generated = await regenerateGoldenFrames();
    const committed = fixtureBytes();
    const absent = generated[0]!;
    const withoutOne = new Map(committed);
    withoutOne.delete(absent.fixture);

    expect(goldenFrameMatchesCommitted(absent, undefined)).toBe(false);
    expect(findGoldenFrameMismatches(generated, withoutOne))
      .toContain(absent.fixture);

    for (const directory of [FIXTURES, ANCHORS, COLOUR_FIXTURES]) {
      for (const fixture of readdirSync(directory).filter((name) =>
        name.endsWith(".txt")
      )) {
        expect(
          readFileSync(join(directory, fixture), "utf8"),
          `${fixture} literal version`,
        ).toMatch(/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u);
      }
    }
  });
});

describe("cockpit healthy capture read, never named", () => {
  test("test: no capture is read through any filter, and the bytes an oracle renders are the bytes the capture holds", async () => {
    const bytes = readFileSync(HEALTHY_SOURCE, "utf8");

    // The bytes are the capture: digest-pinned, parsed whole, filtered by
    // nothing. The escalation-stripping read this oracle once used is gone —
    // asserted on the read itself, so a filter smuggled in under any parameter
    // name is caught, and reading anything that is not a capture stays free.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      HEALTHY_SOURCE_SHA256,
    );
    expect(readCapturedEvents.toString()).not.toMatch(/\.filter\b/);
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
  test("test: the stale rendered anchors and the goldens this redesign changes are retired, not re-stamped", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    // Retirement is a declaration and nothing else: the frames the contract
    // moved still hold every byte, and leave the comparison by what is declared.
    expect([...CONTRACT_MOVED_PANELS].sort()).toEqual(["KEYS", "MARK"]);
    expect(anchorMismatches(generated, anchors)).toEqual([]);

    // RETIREMENT, NOT BLANKING — structural, not taste. CONTRACT_MOVED_PANELS
    // blanks declared cells WHERE THEY STAND, preserving the row count by
    // construction, while the contract's one-row header REMOVES a row. No
    // cell-blanking absorbs that, so the six rendered anchors retire outright.
    const plan = planFrame({ columns: 140, rows: 24 });
    if (plan.kind !== "frame") throw new Error("140x24 planned plain output");
    expect(plan.rowSpans.header).toBe(1);
    expect([...RETIRED_RENDERED_ANCHORS].sort()).toEqual([
      "run.height-24.140x24.txt",
      "run.height-40.140x40.txt",
      "run.no-colour.140x24.txt",
      "run.width-folded-keys.100x24.txt",
      "run.width-stacked.80x24.txt",
      "run.width-three-column.140x24.txt",
    ]);
    expect([...anchors.keys()].sort()).toEqual([...MACHINE_SURFACE_ANCHORS].sort());

    // NOT RE-STAMPED. Every retired byte string still draws the mark and the
    // KEYS rail the contract removed, which a re-stamp would not, so the files
    // are historical evidence. Re-freezing waits on operator-accepted frames
    // after UAT (OBS-207).
    const retired = GOLDEN_FRAME_CASES.filter((item) => isRetiredGoldenFrame(item));
    expect(retired.map((item) => item.fixture).sort())
      .toEqual([...UNANCHORED_RUN_FRAMES, ...RETIRED_RENDERED_ANCHORS].sort());
    const lockupRows = PLAIN_COMPACT_LOCKUP.split("\n");
    for (const golden of retired) {
      const bytes = readFileSync(join(FIXTURES, golden.fixture), "utf8");
      expect(bytes, golden.fixture).toContain(lockupRows[0]!.trimEnd());
      expect(bytes, golden.fixture).toContain("KEYS");
    }
    const today = await captureRendererOutput(
      interactiveFrameNode("run", loadDemoCaptures(), "9.8.7", 140, 24),
      { columns: 140, rows: 24, colour: false },
    );
    for (const row of lockupRows) expect(today).not.toContain(row.trimEnd());
    expect(today).not.toContain("KEYS");

    // Not retired or projected: apart from the release-owned version token, the
    // comparison reads both machine surfaces whole, keys line included.
    const forbiddenProjection = (): void => {
      throw new Error("a machine-surface anchor entered the projection");
    };
    for (const fixture of MACHINE_SURFACE_ANCHORS) {
      const bytes = anchors.get(fixture);
      const rendered = generated.find((frame) => frame.fixture === fixture);
      if (!bytes || !rendered) throw new Error(`missing anchor: ${fixture}`);

      expect(pinnedProjection(bytes).covered, `${fixture} projected cells`)
        .toEqual([]);
      expect(pinnedProjection(bytes).text, `${fixture} discarded rows`).toBe(bytes);
      expect(goldenFrameMatchesCommitted(rendered, bytes), fixture).toBe(true);
      expect(
        anchorMismatches(
          generated,
          new Map([[fixture, bytes]]),
          CONTRACT_MOVED_PANELS,
          forbiddenProjection,
        ),
        `${fixture} comparison route`,
      ).toEqual([]);
      // And every byte of it rejects a change, on the roster row above all.
      const roster = lastPaintedRow(bytes.split("\n"));
      for (const row of [0, roster]) {
        expect(
          anchorMismatches(
            generated,
            new Map(anchors).set(
              fixture,
              mutateRow(bytes, row, (line) => `${line} drifted`),
            ),
          ),
          `${fixture} row ${row}`,
        ).toEqual([fixture]);
      }
    }

    // The declaration removed the retired six, not their absence: every file is
    // still here, so deleting them later moves no assertion. The directory holds
    // anchors and only anchors.
    const entries = readdirSync(ANCHORS, { withFileTypes: true });
    expect(entries.every((entry) => entry.isFile())).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [...MACHINE_SURFACE_ANCHORS, ...RETIRED_RENDERED_ANCHORS].sort(),
    );
    expect(anchorMismatches(
      generated,
      new Map([...anchors].map(([fixture, bytes]) => [fixture, `${bytes}drift\n`])),
    )).toEqual([...anchors.keys()].sort());
  });

  test("test: where the frozen tier is behind production the anchors are re-stamped visibly rather than exempted — the re-stamp lands as its own commit touching nothing else, its message attributes the change to bba480a0, every changed byte is accounted for by that commit so a diff wider than the keys line fails rather than being absorbed, and no exemption, roster substitution or normalisation survives anywhere in the comparison path", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    // A re-stamp is read out of history by what it is, not by where it sits, so
    // the same query answers in every checkout this repository supports: a full
    // clone, the depth-1 checkout every workflow takes (actions/checkout's
    // default), and the one-commit orphan scripts/export-public.sh builds. It
    // proves it reached the anchors before it judges what it found — they enter
    // all three histories by an add — and it then names as a re-stamp every
    // commit that CHANGES a frozen anchor and touches nothing else. A release
    // that re-freezes the appearance rewrites the whole tree and is not one;
    // neither is the snapshot commit a truncated history begins at, which adds
    // the anchors whole. So a history holding no re-stamp is not this criterion
    // skipped — it is a history holding no anchor change to launder, and the
    // query below still fails on one the moment it carries one.
    expect(
      gitLines(["log", "--format=%H", "--diff-filter=A", "--", ANCHORS]).length,
      "the anchors enter this checkout's history",
    ).toBeGreaterThan(0);
    // Both doors into the frozen bytes are audited, and each closes the other's
    // way out: a change confined to the anchors is a re-stamp whether or not it
    // says so, and a change that says so is a re-stamp whether or not it stayed
    // confined. Only a commit that MODIFIES an anchor can be either — which is
    // also why the attribution is never read off a commit that merely adds them,
    // as the one commit of a truncated history does while carrying this very
    // sentence in its message.
    const attributes = (commit: string): boolean =>
      gitText(["log", "-1", "--format=%B", commit]).includes(
        RE_STAMP_ATTRIBUTION,
      );
    const restamps = gitLines([
      "log",
      "--format=%H",
      "--diff-filter=M",
      "--",
      ANCHORS,
    ]).filter((commit) => {
      const paths = gitLines(["show", "--name-only", "--format=", commit]);
      return paths.length > 0 &&
        (paths.every((path) => path.startsWith(ANCHORS_DIR)) ||
          attributes(commit));
    });
    // Every one is attributed rather than anonymous: it names the production
    // change it answers to in its own message, so no anchors-only re-freeze can
    // enter history unexplained.
    expect(
      restamps.filter(attributes),
      "anchor changes naming the change they answer to",
    ).toEqual(restamps);

    for (const restamp of restamps) {
      // It touches nothing else: every path it names is a current anchor.
      const touched = gitLines(["show", "--name-only", "--format=", restamp]);
      expect(touched.length, "re-stamp touches nothing").toBeGreaterThan(0);
      expect(
          // The whole roster, retired included: a frame retired today was
        // live when the re-stamp landed on it.
        touched.filter((path) => {
          const name = path.split("/").at(-1)!;
          return !anchors.has(name) && !RETIRED_RENDERED_ANCHORS.has(name);
        }),
        "re-stamp reaches outside the anchors",
      ).toEqual([]);

      // And every byte it changed is on a keys line. A diff wider than that —
      // one row of chrome, one header cell, one journal entry — is named here
      // rather than absorbed, because a re-stamp that quietly re-froze anything
      // else is exactly the laundering the frozen tier makes visible (OBS-207).
      const changed = gitLines(["show", "--unified=0", "--format=", restamp])
        .filter((line) => /^[-+][^-+]/u.test(line))
        .map((line) => line.slice(1));
      expect(changed.length, "re-stamped lines").toBe(touched.length * 2);
      for (const line of changed) {
        const advertised = line.startsWith(KEYS_LABEL)
          ? line.slice(KEYS_LABEL.length)
          : line;
        expect(
          advertised.split(KEY_SEPARATOR).length,
          `re-stamped line is not a keys line: ${line}`,
        ).toBeGreaterThan(1);
      }
    }
    // The re-stamp caught the frozen tier up rather than papering over it: the
    // keys line each anchor now holds is the one the renderer emits today.
    for (const [fixture, bytes] of anchors) {
      const rendered = generated.find((frame) => frame.fixture === fixture)!.output;
      const frozen = bytes.split("\n");
      const fresh = rendered.split("\n");

      expect(
        frozen[lastPaintedRow(frozen)],
        `${fixture} keys line`,
      ).toBe(fresh[lastPaintedRow(fresh)]);
    }

    // Nothing exempt, nothing substituted, nothing normalised survives in the
    // comparison path: it names two declarations and no third, it reaches cells
    // only by blanking them where they stand, and it never asks the production
    // key registry what a row is allowed to say.
    const self = readFileSync(SELF, "utf8");
    expect([...CONTRACT_MOVED_PANELS].sort()).toEqual(["KEYS", "MARK"]);
    expect(self).not.toMatch(/from "\.\.\/\.\.\/src\/tui\/cockpit\/keys\.js"/);
    for (const [fixture, bytes] of anchors) {
      const projection = pinnedProjection(bytes);

      expect(
        [...new Set(projection.covered.map((cell) => cell.glyph))],
        `${fixture} rewritten cells`,
      ).toEqual(projection.covered.length > 0 ? [" "] : []);
      expect(projection.lines.map((line) => [...line].length), fixture)
        .toEqual(bytes.split("\n").map((line) => [...line].length));
    }
  });

  test("test: no anchor comparison exempts a whole header, body panel or frame — an unchanged region stays byte-compared, and a mutation inside any retained region fails the comparison", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    expect(anchors.size).toBeGreaterThan(0);
    for (const [fixture, bytes] of anchors) {
      const lines = bytes.split("\n");
      const regions = borderedRegions(bytes);
      const journal = journalPanel(bytes);
      // Every declared cell is blanked where it stands — nothing here normalises
      // a glyph into another glyph — so a covered cell is exactly a cell the
      // comparison stops reading, and every other cell belongs in this proof.
      const blanked = new Set(
        pinnedProjection(bytes).covered
          .filter((cell) => cell.glyph === " ")
          .map((cell) => `${cell.row},${cell.column}`),
      );
      // A cell the comparison still reads: not blanked by a declaration, and
      // outside the journal's absorbed entry rows.
      const retained = (row: number, column: number): boolean =>
        !blanked.has(`${row},${column}`)
        && !(journal !== undefined
          && row > journal.top + 1
          && row < journal.bottom)
        && ([...lines[row]!][column] ?? " ") !== " ";
      const firstRetained = (row: number, from: number, to: number) =>
        [...Array(Math.max(to - from, 0)).keys()]
          .map((offset) => from + offset)
          .find((candidate) => retained(row, candidate));
      const probes: { where: string; row: number; column: number }[] = [];
      const probe = (where: string, row: number, from: number, to: number) => {
        const column = firstRetained(row, from, to);
        expect(column, `${fixture} ${where} has no retained cell`).toBeDefined();
        probes.push({ where, row, column: column! });
      };

      // The header — every row of it, including the one the mark shares.
      const headerRows = regions.length
        ? Math.min(...regions.map((region) => region.top))
        : 0;
      for (let row = 0; row < headerRows; row += 1) {
        probe(`header row ${row}`, row, 0, [...lines[row]!].length);
      }
      // Every panel the frame draws, the declared rails included: a declaration
      // excises a rail's interior, never the panel it belongs to, so each one
      // still rejects a change to its caption row and to its own chrome.
      for (const region of regions) {
        const caption = region.content.split("\n")[0]?.trim() ?? "";
        probe(
          `panel ${caption} caption`,
          region.top + 1,
          region.left,
          region.right + 1,
        );
        probe(`panel ${caption} top border`, region.top, region.left, region.right + 1);
        // And the panel's own interior wherever the comparison still reads one:
        // the VIEWS rail is an unchanged region the contract does not name, and
        // it stays byte-compared rather than riding along with the rail opposite.
        for (let row = region.top + 2; row < region.bottom; row += 1) {
          const column = firstRetained(row, region.left + 1, region.right);
          if (column === undefined) continue;
          probes.push({ where: `panel ${caption} interior`, row, column });
          break;
        }
      }
      // And every remaining painted row, so no row is exempt by sitting outside a
      // panel: the status strip, and a machine surface's whole body but the
      // roster the declaration names.
      for (const [row, line] of lines.entries()) {
        if (row < headerRows || line.trim().length === 0) continue;
        if (journal && row > journal.top + 1 && row < journal.bottom) continue;
        if ([...line].every((_, column) => !retained(row, column))) continue;
        probe(`row ${row}`, row, 0, [...line].length);
      }

      // No frame is exempt by producing no probe at all, and the three the
      // criterion names are each among them.
      expect(probes.length, `${fixture} has nothing to disturb`)
        .toBeGreaterThan(regions.length * 2);
      expect(
        probes.filter((item) => item.where.startsWith("header")).length,
        `${fixture} header rows`,
      ).toBe(headerRows);
      expect(
        probes.filter((item) => item.where.endsWith("caption")).length,
        `${fixture} panel captions`,
      ).toBe(regions.length);
      expect(
        probes.filter((item) => item.where.endsWith("top border")).length,
        `${fixture} panel borders`,
      ).toBe(regions.length);
      expect(
        probes.some((item) => item.where === "panel VIEWS interior"),
        `${fixture} VIEWS interior`,
      ).toBe(regions.length > 0);
      for (const { where, row, column } of probes) {
        const mutated = new Map(anchors).set(
          fixture,
          mutateRow(bytes, row, (line) => replaceColumn(line, column, "¤")),
        );

        expect(anchorMismatches(generated, mutated), `${fixture} ${where}`)
          .toEqual([fixture]);
      }

      // The declared rail is not exempt as a panel: what the contract deletes is
      // what the rail HELD, so the box it sat in is still pinned. Its own rule —
      // both border columns, on a row whose interior is excised, and its bottom
      // border — each rejects a change, which is the difference between retiring
      // the keys the contract moved and exempting the panel they sat in.
      const rail = movedPanel(bytes);
      if (!rail) continue;
      const rule: [string, number, number][] = [
        ["left rule", rail.top + 2, rail.left],
        ["right rule", rail.top + 2, rail.right],
        ["bottom border", rail.bottom, rail.left + 1],
      ];
      for (const [where, row, column] of rule) {
        expect(
          anchorMismatches(
            generated,
            new Map(anchors).set(
              fixture,
              mutateRow(bytes, row, (line) => replaceColumn(line, column, "¤")),
            ),
          ),
          `${fixture} rail ${where}`,
        ).toEqual([fixture]);
      }
    }
  });

  test("test: the committed machine-surface anchors run.ci and run.non-tty byte-match what the renderer draws today, so the frozen tier is current rather than exempted, and it stays that way — a drift between the anchors and the renderer fails rather than being absorbed by any projection", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    for (const [fixture, bytes] of anchors) {
      // The bytes as they stand: no escape stripped, no whitespace collapsed.
      const raw = bytes.split("\n");
      const projection = pinnedProjection(bytes);
      const covered = new Map(
        projection.covered.map((cell) => [`${cell.row},${cell.column}`, cell]),
      );
      const keys = keybarRow(bytes);

      // Everything the projection touched, it touched under a name in the
      // declaration — and every cell it changed it BLANKED where it stood, never
      // rewriting one glyph as another, which is what normalising would be.
      expect(
        [...new Set(projection.covered.map((cell) => cell.declaration))]
          .filter((name) => !CONTRACT_MOVED_PANELS.has(name)),
        fixture,
      ).toEqual([]);
      expect(
        [...new Set(projection.covered.map((cell) => cell.glyph))],
        `${fixture} rewritten cells`,
      ).toEqual(projection.covered.length > 0 ? [" "] : []);
      expect(projection.lines.length, fixture).toBe(raw.length);
      for (const [row, line] of raw.entries()) {
        // No row is emptied, no line re-flowed and no row shortened: every row
        // keeps the width it was drawn at, the keys row included, so nothing on
        // any row is waved through by the projection's own shape.
        expect([...projection.lines[row]!].length, `${fixture} width ${row}`)
          .toBe([...line].length);
        const projected = [...projection.lines[row]!];
        for (const [column, glyph] of [...line].entries()) {
          if (projected[column] === glyph) continue;
          expect(
            covered.get(`${row},${column}`)?.declaration,
            `${fixture} row ${row} column ${column}`,
          ).toBeDefined();
        }
      }
      // A machine surface is reached by no declaration at all; a rendered frame
      // is reached by both, and by nothing outside them.
      const panel = journalPanel(bytes);
      expect(
        projection.covered.length > 0,
        `${fixture} projected cells`,
      ).toBe(panel !== undefined);
      // The only rows the comparison form drops are the journal's absorbed
      // entries, located by the panel's own geometry and counted against it.
      expect(
        projection.text.split("\n").length + projection.excludedRows,
        fixture,
      ).toBe(projection.lines.length);
      expect(projection.excludedRows, fixture).toBe(
        panel === undefined ? 0 : panel.bottom - panel.top - 2,
      );
      // And an escape sequence is bytes like any other: put one in the status
      // strip, a region no declaration names, and the comparison reads it rather
      // than stripping it on the way in.
      const strip = lastPaintedRow(raw.slice(0, keys.row));
      expect(
        anchorMismatches(
          generated,
          new Map(anchors).set(
            fixture,
            mutateRow(bytes, strip, (line) => `\u001b[31m${line}`),
          ),
        ),
        `${fixture} escape`,
      ).toEqual([fixture]);
    }

    // The keys line is inside the comparison's reach on every anchor, the two
    // machine surfaces included: no declaration reads it, so every way of moving
    // it is named. That is what the re-stamp bought — the alternative was a
    // declaration that asked the registry what the row may say, which would have
    // widened itself the next time the registry moved and never spoken again.
    for (const [fixture, bytes] of anchors) {
      const { row, label } = keybarRow(bytes);
      const line = bytes.split("\n")[row]!;
      const entries = line.slice(label).split(KEY_SEPARATOR);

      expect(entries.length, `${fixture} advertises nothing`).toBeGreaterThan(1);
      const rewritten = (keys: readonly string[]) =>
        `${line.slice(0, label)}${keys.join(KEY_SEPARATOR)}`;
      const mutations: [string, (line: string) => string][] = [
        ["re-lettered binding", () =>
          rewritten(entries.map((entry, index) =>
            index === 1 ? entry.replace(/.$/u, "z") : entry
          ))],
        ["dropped entry", () => rewritten(entries.slice(1))],
        ["re-ordered roster", () => rewritten([...entries].reverse())],
        ["extra roster", (current) => `${current}\n${current}`],
      ];
      if (label > 0) {
        mutations.push(["label", (current) => replaceColumn(current, 0, "K")]);
      }
      for (const [where, mutate] of mutations) {
        const mutated = new Map(anchors).set(fixture, mutateRow(bytes, row, mutate));

        expect(anchorMismatches(generated, mutated), `${fixture} ${where}`)
          .toEqual([fixture]);
      }
    }
    for (const fixture of MACHINE_SURFACE_ANCHORS) {
      expect(keybarRow(anchors.get(fixture)!).label, fixture)
        .toBe(KEYS_LABEL.length);
      const rendered = generated.find((frame) => frame.fixture === fixture)!;
      expect(
        goldenFrameMatchesCommitted(
          rendered,
          readFileSync(join(FIXTURES, fixture), "utf8"),
        ),
        `${fixture} twin`,
      ).toBe(true);
    }
  });

  test("test: the machine-surface anchors byte-match what the renderer draws with the Decisions hint, so the frozen tier is current", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    for (const fixture of MACHINE_SURFACE_ANCHORS) {
      const bytes = anchors.get(fixture);
      const rendered = generated.find((frame) => frame.fixture === fixture);
      if (!bytes || !rendered) throw new Error(`missing anchor: ${fixture}`);

      // No projection reaches a machine surface, so every byte except the
      // release-owned version token stays pinned, Decisions hint included.
      expect(goldenFrameMatchesCommitted(rendered, bytes), fixture).toBe(true);
      const keysLine = bytes.split("\n")[keybarRow(bytes).row]!;
      expect(keysLine, fixture).toContain("Tab Decisions");
      expect(bytes, fixture).not.toContain("Tab Setup");
      expect(rendered.output, fixture).not.toContain("Tab Setup");
    }
  });

  test("test: the plain-renderer anchors keep every row they hold, since they carry no journal panel to absorb anything and no declared region reaches them", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();
    const plain = [...anchors].filter(([, bytes]) =>
      journalPanel(bytes) === undefined
    );

    expect(plain.length).toBeGreaterThan(0);
    for (const [fixture, bytes] of plain) {
      expect(bytes, fixture).not.toMatch(DECORATED);
      expect(pinnedProjection(bytes).excludedRows, fixture).toBe(0);
      // Whole, keys row and all: every painted row rejects a change, which is
      // more rows than a journal-bearing frame keeps.
      const lines = bytes.split("\n");
      expect(lastPaintedRow(lines), fixture).toBeGreaterThan(0);
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

  test("test: the status strip and the header's run identity are outside every declared region, so a change to either fails", async () => {
    const anchors = anchorBytes();
    const generated = await generatedFrames();

    expect(anchors.size).toBeGreaterThan(0);
    for (const [fixture, bytes] of anchors) {
      const lines = bytes.split("\n");
      const strip = lastPaintedRow(lines.slice(0, lastPaintedRow(lines)));

      expect(strip, fixture).toBeGreaterThan(0);
      expect(
        anchorMismatches(
          generated,
          new Map(anchors).set(
            fixture,
            mutateRow(bytes, strip, (line) => `${line} drifted`),
          ),
        ),
        `${fixture} status strip`,
      ).toEqual([fixture]);
      expect(
        anchorMismatches(
          generated,
          new Map(anchors).set(
            fixture,
            mutateRow(bytes, 0, (line) => `${line} drifted`),
          ),
        ),
        `${fixture} header identity`,
      ).toEqual([fixture]);
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

    // Derived from the shipped case list less what the retirement declares,
    // never from the directory listing, so dropping a live anchor fails here.
    expect([...anchors.keys()].sort()).toEqual(
      GOLDEN_FRAME_CASES
        .filter((item) =>
          item.cockpit === "run"
          && !UNANCHORED_RUN_FRAMES.has(item.fixture)
          && !RETIRED_RENDERED_ANCHORS.has(item.fixture)
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
