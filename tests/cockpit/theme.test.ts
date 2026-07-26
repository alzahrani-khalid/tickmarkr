import { describe, expect, test } from "vitest";
import { BRAND_RAMP } from "../../src/brand.js";
import {
  COCKPIT_DATA_RAMP,
  COCKPIT_INK_VOCABULARY,
  COCKPIT_INKS,
  COCKPIT_SURFACE,
  DATA_RAMP_GUARD,
  EXCLUDED_DATA_SHADES,
  LOGO_RAMP,
  REDUCED_COLOUR_MAPPING,
  TEXT_EMPHASIS_TOKENS,
  guardDataRamp,
  resolveTileColour,
} from "../../src/tui/cockpit/theme.js";

const issueKinds = (candidate: Parameters<typeof guardDataRamp>[0]) =>
  guardDataRamp(candidate).issues.map((issue) => issue.kind);

describe("cockpit colour system", () => {
  test("test: the data ramp has four steps whose perceptual lightness decreases monotonically with near-even spacing between neighbours", () => {
    const verdict = guardDataRamp(COCKPIT_DATA_RAMP);

    expect(COCKPIT_DATA_RAMP).toHaveLength(DATA_RAMP_GUARD.requiredSteps);
    expect(verdict.lightness.every((value, index, values) =>
      index === 0 || values[index - 1]! > value,
    )).toBe(true);
    expect(Math.max(...verdict.lightnessSteps) - Math.min(...verdict.lightnessSteps))
      .toBeLessThanOrEqual(DATA_RAMP_GUARD.maximumLightnessStepSpread);
    expect(verdict.issues).toEqual([]);
  });

  test("test: every step of the data ramp clears the minimum contrast floor against the dark surface it is drawn on", () => {
    const verdict = guardDataRamp(COCKPIT_DATA_RAMP, COCKPIT_SURFACE);

    expect(verdict.contrastRatios).toHaveLength(COCKPIT_DATA_RAMP.length);
    expect(verdict.contrastRatios.every((ratio) =>
      ratio >= DATA_RAMP_GUARD.minimumContrast,
    )).toBe(true);
  });

  test("test: the guard rejects a candidate ramp containing either deliberately excluded shade, one for colliding with a neighbour and one for failing contrast", () => {
    const collisionCandidate = [
      COCKPIT_DATA_RAMP[0],
      EXCLUDED_DATA_SHADES.neighbourCollision,
      COCKPIT_DATA_RAMP[1],
      COCKPIT_DATA_RAMP[2],
    ];
    const contrastCandidate = [
      COCKPIT_DATA_RAMP[0],
      COCKPIT_DATA_RAMP[1],
      COCKPIT_DATA_RAMP[2],
      EXCLUDED_DATA_SHADES.insufficientContrast,
    ];

    expect(issueKinds(collisionCandidate)).toContain("neighbour-collision");
    expect(issueKinds(contrastCandidate)).toContain("contrast");
    expect(guardDataRamp(collisionCandidate).ok).toBe(false);
    expect(guardDataRamp(contrastCandidate).ok).toBe(false);
  });

  test("test: the only inks outside the green ramp are the warning and failure pair, and each is accompanied by a distinct glyph and a text label", () => {
    const { dataRamp, ...outsideRamp } = COCKPIT_INKS;
    const reserved = Object.values(outsideRamp);

    expect(dataRamp).toBe(COCKPIT_DATA_RAMP);
    expect(Object.keys(outsideRamp)).toEqual(["warning", "failure"]);
    expect(new Set(reserved.map((ink) => ink.glyph)).size).toBe(reserved.length);
    expect(new Set(reserved.map((ink) => ink.label)).size).toBe(reserved.length);
    for (const ink of reserved) {
      expect(ink.glyph.length).toBeGreaterThan(0);
      expect(ink.label.length).toBeGreaterThan(0);
    }
  });

  test("test: the text emphasis tokens are declared as their own set, carrying weight and dimming rather than any hue drawn from the data ramp", () => {
    expect(Object.keys(TEXT_EMPHASIS_TOKENS)).toEqual(["strong", "normal", "dim"]);
    for (const token of Object.values(TEXT_EMPHASIS_TOKENS)) {
      expect(Object.keys(token).sort()).toEqual(["dimmed", "weight"]);
    }
    for (const step of COCKPIT_DATA_RAMP) {
      expect(JSON.stringify(TEXT_EMPHASIS_TOKENS)).not.toContain(step.hex);
    }
  });

  test("test: the reduced-colour rendering is an explicitly declared mapping rather than an automatic downgrade of the ramp", () => {
    expect(REDUCED_COLOUR_MAPPING.dataRamp.map((entry) => entry.from))
      .toEqual(COCKPIT_DATA_RAMP.map((step) => step.hex));
    expect(REDUCED_COLOUR_MAPPING.dataRamp.map((entry) => entry.to))
      .toEqual(["bright-green", "green", "green", "dim-green"]);
    expect(REDUCED_COLOUR_MAPPING.warning.to).toBe("yellow");
    expect(REDUCED_COLOUR_MAPPING.failure.to).toBe("red");
  });

  test("test: the logo ramp is untouched by the data ramp and remains its own constant", () => {
    expect(LOGO_RAMP).toBe(BRAND_RAMP);
    expect(LOGO_RAMP).toEqual([84, 78, 41, 35]);
    expect(COCKPIT_DATA_RAMP.map((step) => step.xterm)).toEqual([84, 41, 35, 29]);
    expect(COCKPIT_DATA_RAMP).not.toBe(LOGO_RAMP);
  });

  test("the palette guard derives its verdicts from the colour values rather than comparing against hard-coded expected results", () => {
    const relabelledRamp = COCKPIT_DATA_RAMP.map((step, index) => ({
      ...step,
      xterm: 200 + index,
    }));
    const darkenedValue = relabelledRamp.map((step, index) =>
      index === relabelledRamp.length - 1
        ? { ...step, hex: EXCLUDED_DATA_SHADES.insufficientContrast.hex }
        : step
    );

    expect(guardDataRamp(relabelledRamp).ok).toBe(true);
    expect(issueKinds(darkenedValue)).toContain("contrast");
  });

  test("no colour in the surface carries identity between separate tiles", () => {
    const permittedInks = new Set([
      ...COCKPIT_DATA_RAMP.map((ink) => ink.hex),
      COCKPIT_INKS.warning.hex,
      COCKPIT_INKS.failure.hex,
    ]);
    expect(new Set(COCKPIT_INK_VOCABULARY.map((ink) => ink.hex))).toEqual(permittedInks);
    expect(COCKPIT_INK_VOCABULARY.every((ink) => permittedInks.has(ink.hex))).toBe(true);

    const tasksTile = { id: "tasks", label: "Tasks", magnitude: 1 as const };
    const gatesTile = { id: "gates", label: "Gates", magnitude: 1 as const };
    expect(resolveTileColour(tasksTile)).toBe(resolveTileColour(gatesTile));
    expect(resolveTileColour({ ...tasksTile, magnitude: 3 })).not.toBe(
      resolveTileColour(tasksTile),
    );
  });
});
