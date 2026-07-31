/**
 * Combining-mark width as a class, and the golden-frame regression net for
 * the dependency change.
 *
 * `src/tui/cockpit/width.ts` charges zero cells for the zero-width class
 * (non-spacing marks, enclosing marks, format characters) no matter which
 * script the mark belongs to. Pinning one well-behaved mark would let a
 * fixture re-narrow that contract, so the test below ranges over marks from
 * several scripts — a Devanagari virama and a combining acute among them —
 * and asserts the class behaviour for each: zero cells alone, zero cells
 * added to a base.
 *
 * The second test re-runs golden-frame regeneration after the dependency
 * declarations changed (chalk is now direct, string-width is pinned in the
 * lockfile root): every committed frame must reproduce byte for byte, so a
 * measurement change smuggled in by a different resolved copy fails here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  GOLDEN_FRAME_CASES,
  findGoldenFrameMismatches,
  regenerateGoldenFrames,
} from "../../src/tui/cockpit/capture.js";
import { cellWidth } from "../../src/tui/cockpit/width.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/cockpit/frames");

/**
 * The zero-width class the width authority recognises — the same categories
 * `width.ts` names, restated here so the test cannot be satisfied by a mark
 * handled through some other path.
 */
const ZERO_WIDTH_CLASS = /[\p{Mn}\p{Me}\p{Cf}]/u;

/**
 * One combining mark per script, spanning abugidas, alphabets and symbol
 * blocks: no single well-behaved mark can carry the criterion alone.
 */
const COMBINING_MARKS: ReadonlyArray<{
  readonly name: string;
  readonly mark: string;
  readonly script: RegExp;
}> = [
  // U+0301 is Script=Inherited (it rides Latin, Greek, Cyrillic alike); the
  // rest each carry their own script, so the class is exercised per script.
  { name: "combining acute", mark: "\u0301", script: /\p{Script=Inherited}/u },
  { name: "Devanagari virama", mark: "\u094D", script: /\p{Script=Devanagari}/u },
  { name: "Bengali hasant", mark: "\u09CD", script: /\p{Script=Bengali}/u },
  { name: "Tamil pulli", mark: "\u0BCD", script: /\p{Script=Tamil}/u },
  { name: "Thai mai han-akat", mark: "\u0E31", script: /\p{Script=Thai}/u },
  { name: "Hebrew point sheva", mark: "\u05B0", script: /\p{Script=Hebrew}/u },
  { name: "Cyrillic titlo", mark: "\u0483", script: /\p{Script=Cyrillic}/u },
  { name: "combining left harpoon above", mark: "\u20D0", script: /\p{Script=Inherited}/u },
];

describe("zero-width combining marks as a width class", () => {
  test("test: zero-width combining marks add no cells as a class across scripts — a Devanagari virama and a combining acute at minimum — so no fixture can re-narrow the criterion to one well-behaved mark", () => {
    const names = COMBINING_MARKS.map(({ name }) => name);
    expect(names).toContain("Devanagari virama");
    expect(names).toContain("combining acute");

    // Distinct scripts, not one script's marks under several names.
    expect(
      new Set(COMBINING_MARKS.map(({ script }) => script.source)).size,
    ).toBeGreaterThanOrEqual(5);

    for (const { name, mark, script } of COMBINING_MARKS) {
      // The mark is in the zero-width class and belongs to the script the
      // roster claims for it — a fixture cannot swap in a spacing lookalike.
      expect(ZERO_WIDTH_CLASS.test(mark), `${name} is in the zero-width class`)
        .toBe(true);
      expect(script.test(mark), `${name} is of its claimed script`).toBe(true);

      // Zero cells on its own, and zero added to a base character.
      expect(cellWidth(mark), `${name} alone`).toBe(0);
      expect(cellWidth(`a${mark}`), `${name} after a base`).toBe(cellWidth("a"));
    }

    // The virama's own job: a consonant conjunct is one cluster charging the
    // base consonant's cells, never the virama's plus the consonants'.
    const virama = COMBINING_MARKS.find(({ name }) =>
      name === "Devanagari virama"
    )!;
    expect(cellWidth(`क${virama.mark}`)).toBe(cellWidth("क"));
    expect(cellWidth(`क${virama.mark}त`)).toBe(cellWidth("क"));
  });
});

describe("golden frames after the dependency change", () => {
  test("test: regenerating every committed golden frame reproduces it byte for byte after the dependency change, so a measurement change that moves the drawn output fails here rather than in a later task", async () => {
    const generated = await regenerateGoldenFrames();
    const committed = new Map(
      readdirSync(FIXTURES)
        .sort()
        .map((fixture) => [
          fixture,
          readFileSync(join(FIXTURES, fixture), "utf8"),
        ]),
    );

    // The corpus is whole — every committed frame is claimed by the manifest,
    // and every manifest case is committed — then every byte reproduces.
    expect([...committed.keys()].sort()).toEqual(
      GOLDEN_FRAME_CASES.map((item) => item.fixture).sort(),
    );
    expect(findGoldenFrameMismatches(generated, committed)).toEqual([]);
  });
});
