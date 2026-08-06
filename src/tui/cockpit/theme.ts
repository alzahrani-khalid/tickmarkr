import { BRAND_RAMP, GLYPHS } from "../../brand.js";

export type HexColour = `#${string}`;

export type ColourValue = {
  readonly xterm: number;
  readonly hex: HexColour;
};

/** The logo remains governed by src/brand.ts; cockpit data never modifies this ramp. */
export const LOGO_RAMP = BRAND_RAMP;

/** Near-black panel fill against which every data shade must remain legible. */
export const COCKPIT_SURFACE = "#1a1a19" as const satisfies HexColour;

/**
 * Bright-to-deep, single-hue data ink. Depth communicates magnitude, never tile identity.
 * Anchored on xterm 114 (#87d787) — operator-chosen 2026-08-03 — with the hue (OKLab 144.2°)
 * held constant down the ramp; steps descend in even OKLab lightness (0.094) and were searched
 * and verified through guardDataRamp below. hex is the rendered ink (truecolor terminals);
 * xterm is the nearest-distinct 256-colour fallback, documentation not render source.
 */
export const COCKPIT_DATA_RAMP = [
  { xterm: 114, hex: "#87d787" },
  { xterm: 71, hex: "#5bbc5e" },
  { xterm: 65, hex: "#4f9a51" },
  { xterm: 29, hex: "#437944" },
] as const satisfies readonly ColourValue[];

/** Documented near-misses retained as guard fixtures, not special cases in the guard. */
export const EXCLUDED_DATA_SHADES = {
  neighbourCollision: { xterm: 78, hex: "#5fd787" },
  insufficientContrast: { xterm: 22, hex: "#005f00" },
} as const satisfies Record<string, ColourValue>;

/**
 * The only coloured semantic inks outside the green ramp. Shape and text make
 * both meanings survive NO_COLOR and reduced-colour terminals.
 */
export const COCKPIT_INKS = {
  dataRamp: COCKPIT_DATA_RAMP,
  warning: {
    xterm: 214,
    hex: "#ffaf00",
    glyph: GLYPHS.attention,
    label: "warning",
  },
  failure: {
    xterm: 203,
    hex: "#ff5f5f",
    glyph: GLYPHS.fail,
    label: "failure",
  },
} as const;

/** Every drawable cockpit ink; the panel surface and text emphasis are not inks. */
export const COCKPIT_INK_VOCABULARY = [
  ...COCKPIT_DATA_RAMP,
  COCKPIT_INKS.warning,
  COCKPIT_INKS.failure,
] as const;

/** Text hierarchy is independent of hue: weight and dimming are its only axes. */
export const TEXT_EMPHASIS_TOKENS = {
  strong: { weight: "bold", dimmed: false },
  normal: { weight: "normal", dimmed: false },
  dim: { weight: "normal", dimmed: true },
} as const;

/** Deliberate 16-colour choices. Renderers select this map; they do not infer one. */
export const REDUCED_COLOUR_MAPPING = {
  dataRamp: [
    { from: COCKPIT_DATA_RAMP[0].hex, to: "bright-green" },
    { from: COCKPIT_DATA_RAMP[1].hex, to: "green" },
    { from: COCKPIT_DATA_RAMP[2].hex, to: "green" },
    { from: COCKPIT_DATA_RAMP[3].hex, to: "dim-green" },
  ],
  warning: { from: COCKPIT_INKS.warning.hex, to: "yellow" },
  failure: { from: COCKPIT_INKS.failure.hex, to: "red" },
} as const;

export type TileMagnitude = 0 | 1 | 2 | 3;
export type TileColourInput = {
  readonly magnitude: TileMagnitude;
};

/**
 * Resolve reusable tile ink from magnitude alone. Tile names and positions are
 * deliberately absent from the contract, so separate tiles cannot acquire identity hues.
 */
export function resolveTileColour(
  { magnitude }: TileColourInput,
): (typeof COCKPIT_DATA_RAMP)[number] {
  const ink = COCKPIT_DATA_RAMP[magnitude];
  if (!ink) throw new RangeError(`invalid tile magnitude: ${magnitude}`);
  return ink;
}

export const DATA_RAMP_GUARD = {
  requiredSteps: 4,
  minimumContrast: 3,
  minimumNeighbourDistance: 0.08,
  maximumLightnessStepSpread: 0.02,
} as const;

export type PaletteGuardIssueKind =
  | "step-count"
  | "invalid-colour"
  | "lightness-order"
  | "lightness-spacing"
  | "neighbour-collision"
  | "contrast";

export type PaletteGuardIssue = {
  readonly kind: PaletteGuardIssueKind;
  readonly indexes: readonly number[];
};

export type PaletteGuardVerdict = {
  readonly ok: boolean;
  readonly lightness: readonly number[];
  readonly lightnessSteps: readonly number[];
  readonly neighbourDistances: readonly number[];
  readonly contrastRatios: readonly number[];
  readonly issues: readonly PaletteGuardIssue[];
};

type Rgb = readonly [red: number, green: number, blue: number];
type Oklab = readonly [lightness: number, a: number, b: number];

const parseHex = (hex: string): Rgb | undefined => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return undefined;
  return [
    Number.parseInt(match[1]!, 16) / 255,
    Number.parseInt(match[2]!, 16) / 255,
    Number.parseInt(match[3]!, 16) / 255,
  ];
};

const linearChannel = (channel: number): number =>
  channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;

const relativeLuminance = ([red, green, blue]: Rgb): number =>
  (0.2126 * linearChannel(red))
  + (0.7152 * linearChannel(green))
  + (0.0722 * linearChannel(blue));

const toOklab = ([red, green, blue]: Rgb): Oklab => {
  const r = linearChannel(red);
  const g = linearChannel(green);
  const b = linearChannel(blue);
  const l = Math.cbrt((0.4122214708 * r) + (0.5363325363 * g) + (0.0514459929 * b));
  const m = Math.cbrt((0.2119034982 * r) + (0.6806995451 * g) + (0.1073969566 * b));
  const s = Math.cbrt((0.0883024619 * r) + (0.2817188376 * g) + (0.6299787005 * b));

  return [
    (0.2104542553 * l) + (0.793617785 * m) - (0.0040720468 * s),
    (1.9779984951 * l) - (2.428592205 * m) + (0.4505937099 * s),
    (0.0259040371 * l) + (0.7827717662 * m) - (0.808675766 * s),
  ];
};

const oklabDistance = (left: Oklab, right: Oklab): number =>
  Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);

const contrastRatio = (foreground: Rgb, background: Rgb): number => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * Evaluate any four candidate values. Xterm indexes and declared palette names
 * are intentionally ignored: only parsed colour values can earn a verdict.
 */
export function guardDataRamp(
  candidate: readonly ColourValue[],
  surface: HexColour = COCKPIT_SURFACE,
): PaletteGuardVerdict {
  const issues: PaletteGuardIssue[] = [];
  if (candidate.length !== DATA_RAMP_GUARD.requiredSteps) {
    issues.push({ kind: "step-count", indexes: candidate.map((_, index) => index) });
  }

  const parsed = candidate.map((step) => parseHex(step.hex));
  const invalidIndexes = parsed.flatMap((value, index) => value ? [] : [index]);
  const surfaceRgb = parseHex(surface);
  if (invalidIndexes.length > 0 || !surfaceRgb) {
    issues.push({
      kind: "invalid-colour",
      indexes: !surfaceRgb ? [-1, ...invalidIndexes] : invalidIndexes,
    });
  }

  const labs = parsed.map((value) => value ? toOklab(value) : undefined);
  const lightness = labs.map((value) => value?.[0] ?? Number.NaN);
  const lightnessSteps = lightness.slice(1).map((value, index) =>
    lightness[index]! - value
  );
  const neighbourDistances = labs.slice(1).map((value, index) => {
    const previous = labs[index];
    return previous && value ? oklabDistance(previous, value) : Number.NaN;
  });
  const contrastRatios = parsed.map((value) =>
    value && surfaceRgb ? contrastRatio(value, surfaceRgb) : Number.NaN
  );

  const unorderedIndexes = lightnessSteps.flatMap((step, index) =>
    Number.isFinite(step) && step <= 0 ? [index, index + 1] : []
  );
  if (unorderedIndexes.length > 0) {
    issues.push({ kind: "lightness-order", indexes: [...new Set(unorderedIndexes)] });
  }

  const finiteSteps = lightnessSteps.filter(Number.isFinite);
  if (
    finiteSteps.length > 1
    && Math.max(...finiteSteps) - Math.min(...finiteSteps)
      > DATA_RAMP_GUARD.maximumLightnessStepSpread
  ) {
    issues.push({
      kind: "lightness-spacing",
      indexes: lightnessSteps.flatMap((_, index) => [index, index + 1]),
    });
  }

  const collisionIndexes = neighbourDistances.flatMap((distance, index) =>
    Number.isFinite(distance) && distance < DATA_RAMP_GUARD.minimumNeighbourDistance
      ? [index, index + 1]
      : []
  );
  if (collisionIndexes.length > 0) {
    issues.push({ kind: "neighbour-collision", indexes: [...new Set(collisionIndexes)] });
  }

  const contrastIndexes = contrastRatios.flatMap((ratio, index) =>
    Number.isFinite(ratio) && ratio < DATA_RAMP_GUARD.minimumContrast ? [index] : []
  );
  if (contrastIndexes.length > 0) {
    issues.push({ kind: "contrast", indexes: contrastIndexes });
  }

  return {
    ok: issues.length === 0,
    lightness,
    lightnessSteps,
    neighbourDistances,
    contrastRatios,
    issues,
  };
}
