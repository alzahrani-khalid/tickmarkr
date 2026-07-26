import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import {
  type ColourFrameCase,
  COLOUR_FRAME_CASES,
  GOLDEN_FRAME_CASES,
  captureRendererOutput,
  regenerateColourFrames,
} from "../../src/tui/cockpit/capture.js";
import { version } from "../../src/cli/commands/version.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
} from "../../src/tui/cockpit/run-cockpit.js";

const COLOUR_FIXTURES = join(
  import.meta.dirname,
  "../fixtures/cockpit/colour",
);
const COLOUR_SOURCES = join(COLOUR_FIXTURES, "sources");
const LAYOUT_FIXTURES = join(
  import.meta.dirname,
  "../fixtures/cockpit/frames",
);
const CAPTURE_SOURCE = join(
  import.meta.dirname,
  "../../src/tui/cockpit/capture.ts",
);

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_INK = /\x1b\[38;5;(\d+)m/g;
const APPROVED_GREEN_RAMP = [84, 41, 35, 29] as const;
const WARNING_INK = 214;
const FAILURE_INK = 203;
const APPROVED_INKS = new Set<number>([
  ...APPROVED_GREEN_RAMP,
  WARNING_INK,
  FAILURE_INK,
]);
const EXCLUDED_INKS = [78, 22] as const;

const EXPECTED_LAYOUT_FIXTURES = [
  "run.ci.140x24.txt",
  "run.height-14.140x14.txt",
  "run.height-18.140x18.txt",
  "run.height-24.140x24.txt",
  "run.height-40.140x40.txt",
  "run.no-colour.140x24.txt",
  "run.non-tty.140x24.txt",
  "run.width-folded-keys.100x24.txt",
  "run.width-stacked.80x24.txt",
  "run.width-three-column.140x24.txt",
  "setup.ci.140x24.txt",
  "setup.height-14.140x14.txt",
  "setup.height-18.140x18.txt",
  "setup.height-24.140x24.txt",
  "setup.height-40.140x40.txt",
  "setup.no-colour.140x24.txt",
  "setup.non-tty.140x24.txt",
  "setup.width-folded-keys.100x24.txt",
  "setup.width-stacked.80x24.txt",
  "setup.width-three-column.140x24.txt",
] as const;

type SourceEvent = {
  readonly event: string;
  readonly taskId?: string;
  readonly data: Record<string, unknown>;
};

function committedColourFrames(): Map<string, string> {
  return new Map(
    readdirSync(COLOUR_FIXTURES)
      .filter((fixture) => fixture.endsWith(".txt"))
      .sort()
      .map((fixture) => [
        fixture,
        readFileSync(join(COLOUR_FIXTURES, fixture), "utf8"),
      ]),
  );
}

function sourceBytes(colourCase: ColourFrameCase): string {
  return readFileSync(
    join(COLOUR_SOURCES, colourCase.sourceFileName),
    "utf8",
  );
}

function sourceEvents(colourCase: ColourFrameCase): SourceEvent[] {
  return sourceBytes(colourCase)
    .split("\n")
    .flatMap((line) =>
      line.trim().length > 0
        ? [JSON.parse(line) as SourceEvent]
        : []
    );
}

function namedRun(colourCase: ColourFrameCase): string {
  return colourCase.sourceFileName.replace(
    /(?:\.interrupted)?\.journal\.jsonl$/,
    "",
  );
}

async function captureNamedSourceVerbatim(
  colourCase: ColourFrameCase,
  binaryVersion: string,
): Promise<string> {
  const data = deriveRunCockpitData(
    {
      fileName: colourCase.sourceFileName,
      raw: sourceBytes(colourCase),
    },
    binaryVersion,
    { isDaemonAlive: () => false },
  );
  return captureRendererOutput(
    createElement(RunCockpitFrame, {
      data,
      columns: colourCase.columns,
      rows: colourCase.rows,
    }),
    {
      columns: colourCase.columns,
      rows: colourCase.rows,
      colour: colourCase.colour,
    },
  );
}

function inkIndexes(frame: string): number[] {
  return [...frame.matchAll(ANSI_INK)].map((match) => Number(match[1]));
}

function assertOnlyApprovedInks(frame: string): void {
  const indexes = inkIndexes(frame);
  expect(indexes.length).toBeGreaterThan(0);
  expect(indexes.filter((ink) => !APPROVED_INKS.has(ink))).toEqual([]);
  for (const excluded of EXCLUDED_INKS) {
    expect(indexes).not.toContain(excluded);
  }
}

function assertHealthyInkContract(frame: string): void {
  assertOnlyApprovedInks(frame);
  expect(inkIndexes(frame)).not.toContain(WARNING_INK);
  expect(inkIndexes(frame)).not.toContain(FAILURE_INK);
}

function assertWarningFailureInkContract(frame: string): void {
  assertOnlyApprovedInks(frame);
  const plain = frame.replace(ANSI, "");
  expect(frame).toContain(`\x1b[38;5;${WARNING_INK}m!\x1b[39m`);
  expect(plain).toMatch(/!\s+T\d+ interrupted/u);
  expect(frame).toContain(`\x1b[38;5;${FAILURE_INK}m✗\x1b[39m`);
  expect(plain).toMatch(/✗\s+tip-verify FAILED/u);
}

function assertWordParity(coloured: string, colourless: string): void {
  expect(colourless).not.toContain("\x1b");
  expect(colourless).toBe(coloured.replace(ANSI, ""));
}

let generatedOnce: ReturnType<typeof regenerateColourFrames> | undefined;
const generatedFrames = () =>
  (generatedOnce ??= regenerateColourFrames());

async function frameById(id: string): Promise<string> {
  const generated = await generatedFrames();
  const frame = generated.find((candidate) => candidate.id === id);
  if (!frame) throw new Error(`missing generated colour frame: ${id}`);
  return frame.output;
}

describe("cockpit committed colour corpus", () => {
  test("test: every colour case captures its named source verbatim, and no mode exists by which a source may be filtered or transformed before capture", async () => {
    const captureSource = readFileSync(CAPTURE_SOURCE, "utf8");
    expect(captureSource).not.toMatch(
      /\b(?:ColourSourceMode|sourceMode|sourceForColourCase|without-escalations)\b/,
    );
    expect(COLOUR_FRAME_CASES.every((item) =>
      !("sourceMode" in item)
    )).toBe(true);

    const binaryVersion = await version();
    const generated = await generatedFrames();
    expect(generated).toHaveLength(COLOUR_FRAME_CASES.length);
    for (const colourCase of COLOUR_FRAME_CASES) {
      const frame = generated.find((candidate) =>
        candidate.id === colourCase.id
      );
      if (!frame) throw new Error(`missing generated frame: ${colourCase.id}`);
      expect(frame.output, colourCase.id).toBe(
        await captureNamedSourceVerbatim(colourCase, binaryVersion),
      );
      expect(frame.fixture, colourCase.id).toMatch(
        new RegExp(`^${namedRun(colourCase).replaceAll("-", "\\-")}\\.`),
      );
      expect(frame.output.replace(ANSI, ""), colourCase.id).toContain(
        namedRun(colourCase),
      );
    }

    const committed = committedColourFrames();
    expect([...committed.keys()].sort()).toEqual(
      COLOUR_FRAME_CASES.map((item) => item.fixture).sort(),
    );
    for (const frame of generated) {
      expect(frame.emitted, frame.fixture).toBe(frame.output);
      expect(committed.get(frame.fixture), frame.fixture).toBe(frame.output);
    }
  });

  test("test: the source behind the healthy frames is itself healthy, carrying no escalation and no failed gate result, rather than being one whose failing events were removed", () => {
    const healthyCases = COLOUR_FRAME_CASES.filter((item) =>
      item.id.startsWith("healthy-")
    );
    expect(healthyCases).toHaveLength(2);
    expect(new Set(healthyCases.map((item) => item.sourceFileName)).size).toBe(1);

    const healthy = healthyCases[0]!;
    const raw = sourceBytes(healthy);
    const events = sourceEvents(healthy);
    const gateResults = events.filter((event) =>
      event.event === "gate-result"
    );
    const tipVerifications = events.filter((event) =>
      event.event === "tip-verify"
    );
    const runEnd = events.findLast((event) => event.event === "run-end");

    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      "48302a97d65c012781eda747f4d82b8b9f71649f5c4daaef3da37b25105c45e2",
    );
    expect(events.some((event) => event.event === "run-start")).toBe(true);
    expect(events.some((event) => event.event === "task-dispatch")).toBe(true);
    expect(events.some((event) => event.event === "escalation")).toBe(false);
    expect(events.some((event) => event.event === "tip-verify-failed")).toBe(false);
    expect(gateResults.length).toBeGreaterThan(0);
    expect(gateResults.every((event) => event.data.pass === true)).toBe(true);
    expect(tipVerifications.length).toBeGreaterThan(0);
    expect(tipVerifications.every((event) => event.data.pass === true)).toBe(true);
    expect(runEnd?.data).toMatchObject({
      runId: namedRun(healthy),
      failed: [],
      human: [],
      blocked: [],
      pending: [],
      tipVerify: "passed",
    });
  });

  test("test: the healthy coloured frame carries no warning ink and no failure ink anywhere in it", async () => {
    assertHealthyInkContract(await frameById("healthy-colour"));
  });

  test("test: the frame captured from the source carrying warning and failure states carries both inks, and each one is accompanied by its own glyph and its own word", async () => {
    const colourCase = COLOUR_FRAME_CASES.find((item) =>
      item.id === "warning-failure-colour"
    );
    if (!colourCase) throw new Error("warning/failure colour case is missing");
    expect(
      createHash("sha256").update(sourceBytes(colourCase)).digest("hex"),
    ).toBe("96615dc94cbdb5d2b375c0d286c5a476be5037a259eacb443e163cb3c7af5d5b");

    assertWarningFailureInkContract(
      await frameById("warning-failure-colour"),
    );
  });

  test("test: the colourless twin carries every glyph and every word its coloured counterpart carries, and carries no ink at all", async () => {
    assertWordParity(
      await frameById("healthy-colour"),
      await frameById("healthy-no-colour"),
    );
  });

  test("test: injecting warning ink into the healthy frame makes the oracle fail, so a healthy frame that gained ink cannot pass", async () => {
    const healthy = await frameById("healthy-colour");
    assertHealthyInkContract(healthy);
    const injected = healthy.replace(
      "\x1b[38;5;84m",
      `\x1b[38;5;${WARNING_INK}m`,
    );

    expect(injected).not.toBe(healthy);
    expect(() => assertHealthyInkContract(injected)).toThrow();
  });

  test("test: stripping the ink from the frame carrying warning and failure states makes the oracle fail, so a frame that lost its ink cannot pass", async () => {
    const warningFailure = await frameById("warning-failure-colour");
    assertWarningFailureInkContract(warningFailure);
    const stripped = warningFailure.replace(ANSI, "");

    expect(stripped).not.toBe(warningFailure);
    expect(() => assertWarningFailureInkContract(stripped)).toThrow();
  });

  test("test: breaking word parity between a coloured frame and its colourless twin makes the oracle fail, so meaning carried by hue alone cannot pass", async () => {
    const coloured = await frameById("healthy-colour");
    const colourless = await frameById("healthy-no-colour");
    assertWordParity(coloured, colourless);
    const broken = colourless.replace("tip-verify passed", "tip-verify");

    expect(broken).not.toBe(colourless);
    expect(() => assertWordParity(coloured, broken)).toThrow();
  });

  test("test: the committed colour frames use only the approved green ramp together with the two reserved inks, and neither deliberately excluded value appears anywhere in them", () => {
    const committed = committedColourFrames();
    const allIndexes = new Set<number>();

    for (const colourCase of COLOUR_FRAME_CASES.filter((item) => item.colour)) {
      const frame = committed.get(colourCase.fixture);
      if (!frame) throw new Error(`missing colour fixture: ${colourCase.fixture}`);
      assertOnlyApprovedInks(frame);
      for (const ink of inkIndexes(frame)) allIndexes.add(ink);
    }
    expect([...allIndexes].filter((ink) => !APPROVED_INKS.has(ink))).toEqual([]);
    expect([...allIndexes].some((ink) =>
      APPROVED_GREEN_RAMP.includes(
        ink as (typeof APPROVED_GREEN_RAMP)[number],
      )
    )).toBe(true);
    expect(allIndexes.has(WARNING_INK)).toBe(true);
    expect(allIndexes.has(FAILURE_INK)).toBe(true);
  });

  test("test: the layout corpus is unchanged and still carries no ink, so the two corpora stay separated", () => {
    expect(GOLDEN_FRAME_CASES.map((item) => item.fixture).sort()).toEqual(
      [...EXPECTED_LAYOUT_FIXTURES].sort(),
    );
    expect(readdirSync(LAYOUT_FIXTURES).sort()).toEqual(
      [...EXPECTED_LAYOUT_FIXTURES].sort(),
    );
    expect(
      COLOUR_FRAME_CASES.some((colourCase) =>
        GOLDEN_FRAME_CASES.some((layoutCase) =>
          layoutCase.fixture === colourCase.fixture
        )
      ),
    ).toBe(false);
    for (const fixture of readdirSync(LAYOUT_FIXTURES)) {
      expect(
        readFileSync(join(LAYOUT_FIXTURES, fixture), "utf8"),
        fixture,
      ).not.toContain("\x1b");
    }
  });
});
