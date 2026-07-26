import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { render } from "ink";
import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { GLYPHS } from "../../brand.js";
import { version } from "../../cli/commands/version.js";
import { KEYBAR_KEYS, type ComponentState } from "./components.js";
import { loadDemoCaptures, type DemoCaptures } from "./demo.js";
import {
  resolveCockpitLayout,
} from "./layout.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
  type RunCockpitData,
} from "./run-cockpit.js";
import {
  deriveSetupCockpitData,
  SetupCockpitFrame,
  type SetupCockpitData,
} from "./setup-cockpit.js";

export type CockpitName = "run" | "setup";
export type CockpitRenderer = "frame" | "plain";

export type RendererCaptureOptions = {
  readonly columns: number;
  readonly rows: number;
  readonly colour: boolean;
};

export type FrameRenderer = (
  node: ReactNode,
  options: RendererCaptureOptions,
) => Promise<string>;

export type CockpitEmission = {
  readonly renderer: CockpitRenderer;
  readonly output: string;
};

export type CaptureCockpitOptions = {
  readonly cockpit: CockpitName;
  readonly output: NodeJS.WriteStream;
  readonly binaryVersion: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly interactive?: boolean;
  readonly colour?: boolean;
  readonly ci?: boolean;
  readonly captures?: DemoCaptures;
  readonly plainRenderer?: (
    cockpit: CockpitName,
    binaryVersion: string,
    captures: DemoCaptures,
  ) => string;
  readonly frameRenderer?: FrameRenderer;
};

export type WidthBandCase = {
  readonly arrangement: "stacked" | "folded-keys" | "three-column";
  readonly columns: number;
};

export const WIDTH_BAND_CASES = [
  { arrangement: "stacked", columns: 80 },
  { arrangement: "folded-keys", columns: 100 },
  { arrangement: "three-column", columns: 140 },
] as const satisfies readonly WidthBandCase[];

export const HEIGHT_TIER_BOUNDARIES = [14, 18, 24, 40] as const;

export type GoldenFrameCase = {
  readonly id: string;
  readonly fixture: string;
  readonly cockpit: CockpitName;
  readonly axis: "width" | "height" | "variant";
  readonly columns: number;
  readonly rows: number;
  readonly interactive: boolean;
  readonly colour: boolean;
  readonly ci: boolean;
};

const fixtureName = (
  cockpit: CockpitName,
  id: string,
  columns: number,
  rows: number,
): string => `${cockpit}.${id}.${columns}x${rows}.txt`;

const goldenCasesFor = (cockpit: CockpitName): GoldenFrameCase[] => [
  ...WIDTH_BAND_CASES.map(({ arrangement, columns }) => ({
    id: `${cockpit}-width-${arrangement}`,
    fixture: fixtureName(cockpit, `width-${arrangement}`, columns, 24),
    cockpit,
    axis: "width" as const,
    columns,
    rows: 24,
    interactive: true,
    colour: false,
    ci: false,
  })),
  ...HEIGHT_TIER_BOUNDARIES.map((rows) => ({
    id: `${cockpit}-height-${rows}`,
    fixture: fixtureName(cockpit, `height-${rows}`, 140, rows),
    cockpit,
    axis: "height" as const,
    columns: 140,
    rows,
    interactive: true,
    colour: false,
    ci: false,
  })),
  {
    id: `${cockpit}-no-colour`,
    fixture: fixtureName(cockpit, "no-colour", 140, 24),
    cockpit,
    axis: "variant",
    columns: 140,
    rows: 24,
    interactive: true,
    colour: false,
    ci: false,
  },
  {
    id: `${cockpit}-non-tty`,
    fixture: fixtureName(cockpit, "non-tty", 140, 24),
    cockpit,
    axis: "variant",
    columns: 140,
    rows: 24,
    interactive: false,
    colour: false,
    ci: false,
  },
  {
    id: `${cockpit}-ci`,
    fixture: fixtureName(cockpit, "ci", 140, 24),
    cockpit,
    axis: "variant",
    columns: 140,
    rows: 24,
    interactive: true,
    colour: false,
    ci: true,
  },
];

export const GOLDEN_FRAME_CASES = [
  ...goldenCasesFor("run"),
  ...goldenCasesFor("setup"),
] as const satisfies readonly GoldenFrameCase[];

export type ColourFrameCase = {
  readonly id:
    | "healthy-colour"
    | "healthy-no-colour"
    | "warning-failure-colour";
  readonly fixture: string;
  readonly sourceFileName: string;
  readonly columns: number;
  readonly rows: number;
  readonly colour: boolean;
};

/**
 * The colour corpus has a deliberately separate manifest from the layout
 * corpus. Layout cases stay colourless; these cases alone exercise real ink.
 */
export const COLOUR_FRAME_CASES = [
  {
    id: "healthy-colour",
    fixture: "run-20260718-000943.colour.140x24.txt",
    sourceFileName: "run-20260718-000943.journal.jsonl",
    columns: 140,
    rows: 24,
    colour: true,
  },
  {
    id: "healthy-no-colour",
    fixture: "run-20260718-000943.no-colour.140x24.txt",
    sourceFileName: "run-20260718-000943.journal.jsonl",
    columns: 140,
    rows: 24,
    colour: false,
  },
  {
    id: "warning-failure-colour",
    fixture: "run-20260725-025004.interrupted.colour.140x24.txt",
    sourceFileName: "run-20260725-025004.interrupted.journal.jsonl",
    columns: 140,
    rows: 24,
    colour: true,
  },
] as const satisfies readonly ColourFrameCase[];

const COLOUR_SOURCE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/cockpit/colour/sources",
);

type DerivedCockpitData =
  | { readonly cockpit: "run"; readonly data: RunCockpitData }
  | { readonly cockpit: "setup"; readonly data: SetupCockpitData };

function derivedData(
  cockpit: CockpitName,
  binaryVersion: string,
  captures: DemoCaptures,
): DerivedCockpitData {
  if (cockpit === "setup") {
    return {
      cockpit,
      data: deriveSetupCockpitData(captures, binaryVersion),
    };
  }
  const source = captures.journals.find((capture) =>
    capture.fileName === "run-20260724-231138.journal.jsonl"
  );
  if (!source) throw new Error("healthy cockpit capture is missing");
  return {
    cockpit,
    data: deriveRunCockpitData(source, binaryVersion),
  };
}

function stateGlyph(state: ComponentState): string {
  if (state === "active" || state === "pass") return GLYPHS.pass;
  if (state === "inactive") return GLYPHS.toggleInactive;
  if (state === "fail") return GLYPHS.fail;
  if (state === "warn") return GLYPHS.attention;
  return GLYPHS.neutral;
}

function defaultPlainRenderer(
  cockpit: CockpitName,
  binaryVersion: string,
  captures: DemoCaptures,
): string {
  const derived = derivedData(cockpit, binaryVersion, captures);
  if (derived.cockpit === "run") {
    const data = derived.data;
    return [
      `tickmarkr v${binaryVersion}`,
      `${data.runId} ${data.status} ${data.elapsed}`,
      ...data.statusItems.map((item) =>
        `${stateGlyph(item.state)} ${item.text}`
      ),
      `keys ${KEYBAR_KEYS.run.map((item) =>
        `${item.key} ${item.label}`
      ).join(" · ")}`,
      "",
    ].join("\n");
  }
  const data = derived.data;
  return [
    `tickmarkr v${binaryVersion}`,
    `setup ${data.counts.found} found ${data.counts.authenticated} authed ${data.counts.routable} routable`,
    ...data.harnesses.map((harness) =>
      `${stateGlyph(harness.state)} ${harness.stateWord} ${harness.id}`
    ),
    ...data.deniedChannels.map((denied) =>
      `${GLYPHS.fail} denied ${denied.channel} - ${denied.reason}`
    ),
    `${GLYPHS.pass} base untouched`,
    `${GLYPHS.attention} ${data.stagedChanges.length} changes unsaved`,
    `keys ${KEYBAR_KEYS.setup.map((item) =>
      `${item.key} ${item.label}`
    ).join(" · ")}`,
    "",
  ].join("\n");
}

function frameNode(
  derived: DerivedCockpitData,
  columns: number,
  rows: number,
): ReactNode {
  if (derived.cockpit === "run") {
    return createElement(RunCockpitFrame, {
      data: derived.data,
      columns,
      rows,
    });
  }
  return createElement(SetupCockpitFrame, {
    data: derived.data,
    columns,
    rows,
  });
}

/**
 * Capture exactly the bytes Ink writes for one static paint. Debug mode is
 * deliberate: it exposes the complete frame rather than terminal patch
 * instructions, so the committed corpus is the renderer's frame output.
 */
export async function captureRendererOutput(
  node: ReactNode,
  options: RendererCaptureOptions,
): Promise<string> {
  const sizedNode = isValidElement(node)
      && (node.type === RunCockpitFrame || node.type === SetupCockpitFrame)
    ? cloneElement(
      node as ReactElement<{ readonly rows?: number }>,
      { rows: options.rows },
    )
    : node;
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = options.columns;
  output.rows = options.rows;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  const previousColourLevel = chalk.level;
  const previousNoColour = process.env.NO_COLOR;
  chalk.level = options.colour ? 3 : 0;
  if (options.colour) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = "1";

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(sizedNode, {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  try {
    await firstPaint;
    return writes.at(-1) ?? "";
  } finally {
    app.unmount();
    app.cleanup();
    chalk.level = previousColourLevel;
    if (previousNoColour === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColour;
  }
}

/**
 * The single interactive/plain boundary. It decides before mounting Ink, then
 * falls back again if a renderer returns an empty paint.
 */
export async function captureCockpitOutput(
  options: CaptureCockpitOptions,
): Promise<CockpitEmission> {
  const columns = options.columns ?? options.output.columns ?? 80;
  const rows = options.rows ?? options.output.rows ?? 24;
  const interactive = options.interactive
    ?? options.output.isTTY === true;
  const colour = options.colour
    ?? process.env.NO_COLOR === undefined;
  const ci = options.ci ?? process.env.CI === "true";
  const captures = options.captures ?? loadDemoCaptures();
  const plain = () => (
    options.plainRenderer ?? defaultPlainRenderer
  )(options.cockpit, options.binaryVersion, captures);
  const layout = resolveCockpitLayout(columns, rows);

  if (!interactive || options.output.isTTY !== true || ci || layout.renderer === "plain") {
    const plainOutput = plain();
    options.output.write(plainOutput);
    return { renderer: "plain", output: plainOutput };
  }

  const derived = derivedData(options.cockpit, options.binaryVersion, captures);
  const frameOutput = await (
    options.frameRenderer ?? captureRendererOutput
  )(frameNode(derived, columns, rows), { columns, rows, colour });
  if (frameOutput.length === 0) {
    const plainOutput = plain();
    options.output.write(plainOutput);
    return { renderer: "plain", output: plainOutput };
  }
  options.output.write(frameOutput);
  return { renderer: "frame", output: frameOutput };
}

export type RegeneratedGoldenFrame = GoldenFrameCase & {
  readonly renderer: CockpitRenderer;
  readonly output: string;
  readonly emitted: string;
};

export async function regenerateGoldenFrames(
  binaryVersion?: string,
): Promise<readonly RegeneratedGoldenFrame[]> {
  const resolvedVersion = binaryVersion ?? await version();
  const captures = loadDemoCaptures();
  const regenerated: RegeneratedGoldenFrame[] = [];
  for (const golden of GOLDEN_FRAME_CASES) {
    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
      rows: number;
    };
    output.isTTY = golden.interactive;
    output.columns = golden.columns;
    output.rows = golden.rows;
    const writes: string[] = [];
    const write = output.write.bind(output);
    output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return Reflect.apply(write, output, [chunk, ...args]) as boolean;
    }) as typeof output.write;
    const emission = await captureCockpitOutput({
      cockpit: golden.cockpit,
      output: output as unknown as NodeJS.WriteStream,
      binaryVersion: resolvedVersion,
      columns: golden.columns,
      rows: golden.rows,
      interactive: golden.interactive,
      colour: golden.colour,
      ci: golden.ci,
      captures,
    });
    regenerated.push({
      ...golden,
      ...emission,
      emitted: writes.join(""),
    });
  }
  return regenerated;
}

export function findGoldenFrameMismatches(
  regenerated: readonly RegeneratedGoldenFrame[],
  committed: ReadonlyMap<string, string>,
): string[] {
  const expected = new Set(regenerated.map((frame) => frame.fixture));
  return [
    ...regenerated.flatMap((frame) =>
      committed.get(frame.fixture) === frame.output ? [] : [frame.fixture]
    ),
    ...[...committed.keys()].filter((fixture) => !expected.has(fixture)),
  ].sort();
}

export type RegeneratedColourFrame = ColourFrameCase & {
  readonly output: string;
  readonly emitted: string;
};

/**
 * Regenerate only the colour contract corpus from its own manifest. Historical
 * run sources are read and rendered byte-for-byte with their captured daemon
 * stopped, matching the demo path and avoiding live-process state in committed
 * bytes.
 */
export async function regenerateColourFrames(
  binaryVersion?: string,
): Promise<readonly RegeneratedColourFrame[]> {
  const resolvedVersion = binaryVersion ?? await version();
  const regenerated: RegeneratedColourFrame[] = [];

  for (const colourCase of COLOUR_FRAME_CASES) {
    const source = {
      fileName: colourCase.sourceFileName,
      raw: readFileSync(
        join(COLOUR_SOURCE_DIRECTORY, colourCase.sourceFileName),
        "utf8",
      ),
    };
    const data = deriveRunCockpitData(source, resolvedVersion, {
      isDaemonAlive: () => false,
    });
    const output = await captureRendererOutput(
      frameNode(
        { cockpit: "run", data },
        colourCase.columns,
        colourCase.rows,
      ),
      {
        columns: colourCase.columns,
        rows: colourCase.rows,
        colour: colourCase.colour,
      },
    );
    regenerated.push({
      ...colourCase,
      output,
      emitted: output,
    });
  }

  return regenerated;
}
