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
/**
 * The committed capture corpus. Not a colour case — read here only for the one
 * source in the repository that RECORDS a failure the renderer still draws, so
 * the reserved failure ink keeps a genuine failure behind it.
 */
const CAPTURE_SOURCES = join(import.meta.dirname, "../fixtures/cockpit/sources");
const RECOVERED_CAPTURE = "run-20260724-194619.journal.jsonl";
const CAPTURE_SOURCE = join(
  import.meta.dirname,
  "../../src/tui/cockpit/capture.ts",
);

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Fresh frames paint the theme's hex vocabulary as truecolor (38;2;R;G;B);
// a 38;5 index in a fresh frame is itself a violation and normalizes to an
// `ansi256:` token no approved set contains. Values are restated here
// independently of theme.ts on purpose: the oracle must not let the source
// define its own expectation.
const ANSI_INK = /\x1b\[38;(?:5;(\d+)|2;(\d+);(\d+);(\d+))m/g;
const APPROVED_GREEN_RAMP = ["#87d787", "#5bbc5e", "#4f9a51", "#437944"] as const;
const WARNING_INK = "#ffaf00";
const FAILURE_INK = "#ff5f5f";
const APPROVED_INKS = new Set<string>([
  ...APPROVED_GREEN_RAMP,
  WARNING_INK,
  FAILURE_INK,
]);
const EXCLUDED_INKS = ["#5fd787", "#005f00"] as const;
const inkByte = (hex: string): string => {
  const match = /^#(..)(..)(..)$/.exec(hex);
  if (!match) throw new Error(`not a hex ink: ${hex}`);
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map((c) => Number.parseInt(c, 16));
  return `\x1b[38;2;${r};${g};${b}m`;
};

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

function inkIndexes(frame: string): string[] {
  return [...frame.matchAll(ANSI_INK)].map((match) =>
    match[1] !== undefined
      ? `ansi256:${match[1]}`
      : `#${[match[2]!, match[3]!, match[4]!]
        .map((channel) => Number(channel).toString(16).padStart(2, "0"))
        .join("")}`
  );
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

/**
 * Both reserved inks, each with its glyph and its word.
 *
 * OBS-244 moved where the failure ink comes from. The interrupted capture never
 * ran a verification, and the strip used to draw that silence `✗ tip-verify
 * FAILED` — so the ink was proved by a failure the engagement never recorded.
 * It now draws the item absent, and the failure ink is proved on the recovered
 * capture, whose journal records a failed tip verification and the run-end that
 * closed that cycle. Both frames are the live renderer's, from named sources
 * committed verbatim.
 */
function assertWarningFailureInkContract(
  warningFrame: string,
  failureFrame: string,
): void {
  assertOnlyApprovedInks(warningFrame);
  assertOnlyApprovedInks(failureFrame);
  expect(warningFrame).toContain(`${inkByte(WARNING_INK)}!\x1b[39m`);
  expect(warningFrame.replace(ANSI, "")).toMatch(/!\s+T\d+ interrupted/u);
  // The verification that never ran carries its own word, not a bare hue, and
  // is emphatically not drawn as a failure.
  expect(warningFrame.replace(ANSI, "")).toMatch(/-\s+tip-verify -/u);
  expect(inkIndexes(warningFrame)).not.toContain(FAILURE_INK);
  expect(failureFrame).toContain(`${inkByte(FAILURE_INK)}✗\x1b[39m`);
  expect(failureFrame.replace(ANSI, "")).toMatch(/✗\s+fail · tip-verify-failed/u);
}

function assertWordParity(coloured: string, colourless: string): void {
  expect(colourless).not.toContain("\x1b");
  expect(colourless).toBe(coloured.replace(ANSI, ""));
}

let generatedOnce: ReturnType<typeof regenerateColourFrames> | undefined;
const generatedFrames = () =>
  (generatedOnce ??= regenerateColourFrames());

/**
 * The recovered capture drawn tall enough to reach the cycle it recovered from:
 * its earlier tip verification failed, a later one passed, and the strip reports
 * the latest verdict while the journal keeps every failure it recorded.
 */
async function recoveredCaptureFrame(): Promise<string> {
  const data = deriveRunCockpitData(
    {
      fileName: RECOVERED_CAPTURE,
      raw: readFileSync(join(CAPTURE_SOURCES, RECOVERED_CAPTURE), "utf8"),
    },
    await version(),
    { isDaemonAlive: () => false },
  );
  return captureRendererOutput(
    createElement(RunCockpitFrame, { data, columns: 140, rows: 40 }),
    { columns: 140, rows: 40, colour: true },
  );
}

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

    // The run appearance moved, so these stay live renderer oracles whose
    // committed bytes are RETIRED: manifested and on disk, holding the
    // superseded appearance, never re-stamped before operator UAT.
    const committed = committedColourFrames();
    expect([...committed.keys()].sort()).toEqual(
      COLOUR_FRAME_CASES.map((colourCase) => colourCase.fixture).sort(),
    );
    for (const frame of generated) {
      expect(frame.emitted, frame.fixture).toBe(frame.output);
      const retiredBytes = committed.get(frame.fixture);
      expect(retiredBytes, frame.fixture).toBeDefined();
      // Not re-stamped: the retired bytes draw the deleted KEYS rail, and they
      // are not the frame the renderer paints from the same source today.
      expect(retiredBytes, frame.fixture).toContain("KEYS");
      expect(retiredBytes, frame.fixture).not.toBe(frame.output);
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
      await recoveredCaptureFrame(),
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
      inkByte(APPROVED_GREEN_RAMP[0]),
      inkByte(WARNING_INK),
    );

    expect(injected).not.toBe(healthy);
    expect(() => assertHealthyInkContract(injected)).toThrow();
  });

  test("test: stripping the ink from the frame carrying warning and failure states makes the oracle fail, so a frame that lost its ink cannot pass", async () => {
    const warningFailure = await frameById("warning-failure-colour");
    const recovered = await recoveredCaptureFrame();
    assertWarningFailureInkContract(warningFailure, recovered);

    for (const [warning, failure] of [
      [warningFailure.replace(ANSI, ""), recovered],
      [warningFailure, recovered.replace(ANSI, "")],
    ] as const) {
      expect([warning, failure]).not.toEqual([warningFailure, recovered]);
      expect(() => assertWarningFailureInkContract(warning, failure)).toThrow();
    }
  });

  test("test: breaking word parity between a coloured frame and its colourless twin makes the oracle fail, so meaning carried by hue alone cannot pass", async () => {
    const coloured = await frameById("healthy-colour");
    const colourless = await frameById("healthy-no-colour");
    assertWordParity(coloured, colourless);
    const broken = colourless.replace("tip-verify passed", "tip-verify");

    expect(broken).not.toBe(colourless);
    expect(() => assertWordParity(coloured, broken)).toThrow();
  });

  test("test: the committed colour frames use only the approved green ramp together with the two reserved inks, and neither deliberately excluded value appears anywhere in them", async () => {
    // The contract retired the committed run frames; the colour law stays on
    // the same renderer-drawn cases without pinning their new appearance. The
    // retired bytes are evidence on disk, not the oracle.
    expect([...committedColourFrames().keys()].sort()).toEqual(
      COLOUR_FRAME_CASES.map((colourCase) => colourCase.fixture).sort(),
    );
    const generated = await generatedFrames();
    const allIndexes = new Set<string>();

    for (const colourCase of COLOUR_FRAME_CASES.filter((item) => item.colour)) {
      const frame = generated.find((candidate) => candidate.id === colourCase.id)
        ?.output;
      if (!frame) throw new Error(`missing generated colour case: ${colourCase.id}`);
      assertOnlyApprovedInks(frame);
      for (const ink of inkIndexes(frame)) allIndexes.add(ink);
    }
    // OBS-244: no committed colour source records a failure any more — the one
    // failure the corpus used to draw was a verification that never ran. The
    // reserved ink stays proved against a capture whose journal DID record one,
    // so the reachability half of this law never rests on a defect.
    const recovered = await recoveredCaptureFrame();
    assertOnlyApprovedInks(recovered);
    for (const ink of inkIndexes(recovered)) allIndexes.add(ink);
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
