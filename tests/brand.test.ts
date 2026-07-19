import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BANNER, GLYPHS, PLAIN_BANNER, TOKENS,
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

// exact bytes of the exports as they were before the design-system change
const BANNER_PINNED = [
  "              \x1b[38;5;84m▄▄████\x1b[0m",
  "          \x1b[38;5;78m▄▄████▀▀\x1b[0m",
  "\x1b[38;5;41m████▄▄▄▄████▀▀\x1b[0m     \x1b[1mtickmarkr\x1b[0m",
  "  \x1b[38;5;35m▀▀████▀▀\x1b[0m         spec in, verified work out.",
  "",
].join("\n");
const PLAIN_PINNED = BANNER_PINNED.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, "");

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

describe("design system — legacy exports byte-pinned", () => {
  test("the banner export is byte-identical to before this change", () => {
    expect(BANNER).toBe(BANNER_PINNED);
  });

  test("the plain banner export is byte-identical to before this change", () => {
    expect(PLAIN_BANNER).toBe(PLAIN_PINNED);
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
