import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as brandModule from "../src/brand.js";
import {
  BANNER, COMPACT_LOCKUP, GLYPHS, PLAIN_COMPACT_LOCKUP, TOKENS,
  kvRow, legend, paneDispatchCommand, rule, statusRow, title, toggleActive, toggleInactive,
} from "../src/brand.js";

const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const noColor0 = process.env.NO_COLOR;

const setTTY = (v: boolean) => Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
const onTTY = () => { setTTY(true); delete process.env.NO_COLOR; };

afterEach(() => {
  if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (noColor0 === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor0;
});

type MarkContract = {
  readonly MARK_BITMAP?: readonly string[];
  readonly MARK?: string;
  readonly PLAIN_MARK?: string;
};

const markContract = brandModule as MarkContract;
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const QUADRANTS = [
  " ", "▘", "▝", "▀", "▖", "▌", "▞", "▛",
  "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█",
] as const;

function packBitmap(bitmap: readonly string[]): string {
  const rows: string[] = [];
  for (let y = 0; y < bitmap.length; y += 2) {
    let row = "";
    for (let x = 0; x < bitmap[y]!.length; x += 2) {
      const mask = (bitmap[y]![x] === "#" ? 1 : 0)
        | (bitmap[y]![x + 1] === "#" ? 2 : 0)
        | (bitmap[y + 1]![x] === "#" ? 4 : 0)
        | (bitmap[y + 1]![x + 1] === "#" ? 8 : 0);
      row += QUADRANTS[mask];
    }
    rows.push(row);
  }
  return rows.join("\n");
}

describe("ruled product mark", () => {
  test("test: the mark the product prints is the ruled bitmap packed two pixels by two pixels into each cell, asserted against the bitmap rather than against a copy of the art", () => {
    expect(markContract.MARK_BITMAP).toHaveLength(10);
    expect(markContract.MARK_BITMAP!.every((row) => row.length === 18)).toBe(true);
    expect(markContract.PLAIN_MARK).toBe(packBitmap(markContract.MARK_BITMAP!));
    expect(markContract.PLAIN_MARK!.split("\n")).toHaveLength(5);
    expect(markContract.PLAIN_MARK!.split("\n").every((row) => [...row].length === 9)).toBe(true);
  });

  test("test: the mark draws ink on a solid tile, so its colours are the ruled tile and the ruled ink and no other pair", () => {
    expect(markContract.MARK).toBeTypeOf("string");
    const rows = markContract.MARK!.split("\n");
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const painted = row.match(/^\x1b\[38;5;(\d+);48;5;(\d+)m([\s\S]{9})\x1b\[0m$/u);
      expect(painted).not.toBeNull();
      expect([Number(painted![1]), Number(painted![2])]).toEqual([233, 41]);
    }
    expect(new Set(markContract.MARK!.match(/\x1b\[[0-9;]*m/g))).toEqual(
      new Set(["\x1b[38;5;233;48;5;41m", "\x1b[0m"]),
    );
  });

  test("test: with colour stripped the mark is still a legible silhouette rather than blank space", () => {
    expect(markContract.MARK).toBeTypeOf("string");
    expect(stripAnsi(markContract.MARK!)).toBe(markContract.PLAIN_MARK);
    const silhouette = markContract.PLAIN_MARK!.replaceAll(" ", "").replaceAll("\n", "");
    expect(silhouette.length).toBeGreaterThan(0);
    expect(new Set(silhouette).size).toBeGreaterThan(3);
  });

  test("test: the image twin is generated from the same bitmap, so a pixel present in one is present in the other", () => {
    expect(markContract.MARK_BITMAP).toHaveLength(10);
    const expectedPixels = new Set(markContract.MARK_BITMAP!.flatMap((row, y) =>
      [...row].flatMap((pixel, x) => pixel === "#" ? [`${x},${y}`] : []),
    ));
    const svg = readFileSync(join(import.meta.dirname, "../assets/mark.svg"), "utf8");
    const imagePixels = new Set([...svg.matchAll(
      /<rect class="ink" x="(\d+)" y="(\d+)" width="1" height="1"\/>/g,
    )].map((match) => `${match[1]},${match[2]}`));

    expect(svg).toContain('viewBox="0 0 18 10"');
    expect(imagePixels).toEqual(expectedPixels);
  });

  test("test: the legacy mark is gone from the product, asserted by rendering rather than by searching the source for its name", () => {
    expect(markContract.PLAIN_MARK).toBeTypeOf("string");
    const rendered = stripAnsi(BANNER);
    expect(rendered).toContain(markContract.PLAIN_MARK!.split("\n")[2]!.trimEnd());
    expect(rendered).not.toContain("████▄▄▄▄████▀▀");
    expect(rendered).not.toContain("▀▀████▀▀");
  });

  test("test: the compact lockup the run surface draws is still sliced from the mark rather than written beside it", () => {
    expect(markContract.PLAIN_MARK).toBeTypeOf("string");
    expect(COMPACT_LOCKUP).toBe(BANNER.split("\n").slice(1, 3).join("\n"));
    expect(PLAIN_COMPACT_LOCKUP).toBe(stripAnsi(COMPACT_LOCKUP).replace(/[ \t]+$/gm, ""));
    const frame = readFileSync(
      join(import.meta.dirname, "fixtures/cockpit/frames/run.height-24.140x24.txt"),
      "utf8",
    );
    for (const line of PLAIN_COMPACT_LOCKUP.split("\n")) {
      expect(frame).toContain(line.trimEnd());
    }
  });
});

describe("compact brand lockup", () => {
  test("the compact lockup renders as exactly two lines and carries the product name", () => {
    expect(COMPACT_LOCKUP.split("\n")).toHaveLength(2);
    expect(COMPACT_LOCKUP).toContain("tickmarkr");
  });

  test("every non-blank character the compact lockup draws also occurs in the full banner, so no glyph is invented", () => {
    const fullCharacters = new Set(stripAnsi(BANNER).replace(/\s/g, ""));
    for (const character of stripAnsi(COMPACT_LOCKUP).replace(/\s/g, "")) {
      expect(fullCharacters.has(character), `invented character: ${character}`).toBe(true);
    }
  });

  test("the brand module declares the compact lockup as an expression over the full banner constant rather than as its own literal art", () => {
    const brandSrc = readFileSync(join(import.meta.dirname, "../src/brand.ts"), "utf8");
    expect(brandSrc).toMatch(/export const COMPACT_LOCKUP\s*=\s*BANNER\s*\./);
  });

  test("the lockup degrades to unstyled characters when colour is disabled, exactly as the plain twin does", () => {
    expect(PLAIN_COMPACT_LOCKUP).toBe(
      COMPACT_LOCKUP.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, ""),
    );
    expect(PLAIN_COMPACT_LOCKUP).not.toContain("\x1b");
  });
});

describe("pane dispatch", () => {
  test("paneDispatchCommand shell-quotes a script path containing a space", () => {
    expect(paneDispatchCommand("/tmp/tickmarkr script/dispatch.sh")).toBe("bash '/tmp/tickmarkr script/dispatch.sh'");
  });
});

describe("design system — tokens", () => {
  test("every color token renders plain text when stdout is not a tty", () => {
    setTTY(false);
    delete process.env.NO_COLOR;
    for (const [name, tok] of Object.entries(TOKENS)) {
      expect(tok("sample"), name).toBe("sample");
    }
  });

  test("every color token renders plain text when the no-color env var is set", () => {
    setTTY(true);
    process.env.NO_COLOR = "1";
    for (const [name, tok] of Object.entries(TOKENS)) {
      expect(tok("sample"), name).toBe("sample");
    }
  });

  test("the ok token renders in the brand green ramp on a tty", () => {
    onTTY();
    expect(TOKENS.ok("pass")).toBe("\x1b[38;5;41mpass\x1b[0m");
  });

  test("the fail token renders red on a tty", () => {
    onTTY();
    expect(TOKENS.fail("fail")).toBe("\x1b[31mfail\x1b[0m");
  });

  test("the warn token renders amber on a tty", () => {
    onTTY();
    expect(TOKENS.warn("warn")).toBe("\x1b[33mwarn\x1b[0m");
  });
});

describe("design system — glyphs", () => {
  test("the active toggle glyph is the brand tickmark rendered in brand green on a tty", () => {
    onTTY();
    expect(toggleActive()).toBe("\x1b[38;5;41m✓\x1b[0m");
    setTTY(false);
    expect(toggleActive()).toBe("✓");
  });

  test("the inactive toggle glyph is a dim circle on a tty", () => {
    onTTY();
    expect(toggleInactive()).toBe("\x1b[2m○\x1b[0m");
    setTTY(false);
    expect(toggleInactive()).toBe("○");
  });

  test("no exported glyph contains a bracket character", () => {
    setTTY(false);
    for (const [name, glyph] of Object.entries(GLYPHS)) {
      expect(glyph, name).not.toMatch(/[[\]]/);
    }
    expect(toggleActive()).not.toMatch(/[[\]]/);
    expect(toggleInactive()).not.toMatch(/[[\]]/);
  });

  test("each verdict keeps a distinct glyph so color is never the only signal", () => {
    const verdictGlyphs = [GLYPHS.pass, GLYPHS.fail, GLYPHS.attention, GLYPHS.neutral];
    expect(new Set(verdictGlyphs).size).toBe(verdictGlyphs.length);
    setTTY(false);
    const rows = (["pass", "fail", "warn", "neutral"] as const).map((v) => statusRow(v, "label"));
    expect(new Set(rows).size).toBe(rows.length);
  });
});

describe("design system — helpers", () => {
  test("the title helper renders with emphasis on a tty and plain otherwise", () => {
    onTTY();
    expect(title("step 2/4 · models")).toBe("\x1b[1mstep 2/4 · models\x1b[0m");
    setTTY(false);
    expect(title("step 2/4 · models")).toBe("step 2/4 · models");
  });

  test("the legend helper renders dim on a tty and plain otherwise", () => {
    onTTY();
    expect(legend("↑↓ move · q quit")).toBe("\x1b[2m↑↓ move · q quit\x1b[0m");
    setTTY(false);
    expect(legend("↑↓ move · q quit")).toBe("↑↓ move · q quit");
  });

  test("the status row helper places the verdict glyph before the label", () => {
    setTTY(false);
    expect(statusRow("pass", "gates green")).toBe("✓ gates green");
    expect(statusRow("fail", "tip verify")).toBe("✗ tip verify");
    expect(statusRow("warn", "lint")).toBe("! lint");
    expect(statusRow("neutral", "skipped")).toBe("- skipped");
  });

  test("rule is dim chrome sized to the given width and plain when piped", () => {
    setTTY(false);
    expect(rule(4)).toBe("────");
    onTTY();
    expect(rule(4)).toBe("\x1b[2m────\x1b[0m");
  });

  test("kvRow aligns the key before styling so columns hold", () => {
    setTTY(false);
    expect(kvRow("worktree", "clean", 10)).toBe("  worktree   clean");
  });
});

// the public export ships no docs/codebase — repo-hygiene check only (OBS-65)
const designDocPath = join(import.meta.dirname, "../docs/codebase/CLI-DESIGN.md");
describe.skipIf(!existsSync(designDocPath))("design system — CLI-DESIGN.md contract", () => {
  const doc = existsSync(designDocPath) ? readFileSync(designDocPath, "utf8") : "";

  test("the design document names every exported token, glyph, and helper", () => {
    for (const name of Object.keys(TOKENS)) expect(doc, name).toContain(`\`${name}\``);
    for (const name of Object.keys(GLYPHS)) expect(doc, name).toContain(`\`${name}\``);
    for (const helper of ["toggleActive", "toggleInactive", "title", "legend", "rule", "kvRow", "statusRow"]) {
      expect(doc, helper).toContain(`\`${helper}`);
    }
  });

  test("the design document mandates the brand toggles, forbids brackets, and rules color as meaning", () => {
    expect(doc).toMatch(/brand\s+tickmark/i);
    expect(doc).toMatch(/dim circle/i);
    expect(doc).toMatch(/Bracket toggle glyphs .* forbidden/i);
    expect(doc).toMatch(/glyph-first/i);
    expect(doc).toMatch(/Color is meaning, never decoration/i);
    expect(doc).toMatch(/never the only signal/i);
  });
});
