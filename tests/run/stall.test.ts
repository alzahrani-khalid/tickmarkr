import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeStallSnapshot } from "../../src/run/stall.js";

// OBS-82 fixture: consecutive HerdrDriver.read(slot, 1000) snapshots of a live wedged codex pane
// (see tests/fixtures/codex-mcp-spinner/README.md for capture provenance). Loaded sorted so the
// pairwise assertions walk the frames in capture order; the count floor keeps an emptied fixture
// dir red, never vacuously green (journal-corpus precedent).
const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "codex-mcp-spinner");
const frames: string[] = readdirSync(FIXTURE_DIR)
  .filter((f) => /^frame-\d+\.txt$/.test(f))
  .sort()
  .map((f) => readFileSync(join(FIXTURE_DIR, f), "utf8"));

describe("stall normalizer", () => {
  test("ansi escape sequences are stripped before comparison", () => {
    // raw-pty forms (subprocess reads) — SGR color, erase-line, cursor moves, OSC title, charset
    expect(normalizeStallSnapshot("\x1b[2K\x1b[1;32mready\x1b[0m")).toBe("ready");
    expect(normalizeStallSnapshot("\x1b]0;pane title\x07ready\x1b[3A\x1b[12;40H")).toBe("ready");
    expect(normalizeStallSnapshot("\x1b(Bready\x1b7\x1b8")).toBe("ready");
    // two repaints differing only in escape sequences are the same frame
    expect(normalizeStallSnapshot("\x1b[31mStarting\x1b[0m")).toBe(normalizeStallSnapshot("\x1b[36mStarting\x1b[0m"));
  });

  test("spinner glyphs and elapsed time tokens normalize to silence", () => {
    const glyphFrames = ["⠋ Starting MCP servers (7/8): wedge (12s • esc to interrupt)", "⠙ Starting MCP servers (7/8): wedge (41s • esc to interrupt)"];
    expect(normalizeStallSnapshot(glyphFrames[0])).toBe(normalizeStallSnapshot(glyphFrames[1]));
    const silenced = normalizeStallSnapshot("⠸⠴⠦⠇ 1h 3m 12.5s 800ms");
    expect(silenced).not.toMatch(/[⠀-⣿]/); // no braille spinner cell survives
    expect(silenced).not.toMatch(/\d/); // every digit here was a time token — all gone
  });

  test("consecutive spinner only frames from the captured codex fixture normalize equal", () => {
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).not.toBe(frames[i - 1]); // real repaints: raw snapshots differ …
      expect(normalizeStallSnapshot(frames[i])).toBe(normalizeStallSnapshot(frames[i - 1])); // … normalized they are one frame
    }
  });

  test("frames differing by a server count normalize different", () => {
    expect(frames[0]).toContain("(7/8)"); // the captured startup count — a real server coming up
    const advanced = frames[0].replace("(7/8)", "(8/8)");
    expect(normalizeStallSnapshot(advanced)).not.toBe(normalizeStallSnapshot(frames[0]));
  });

  test("frames differing by ordinary text normalize different", () => {
    const reworded = frames[0].replace("esc to interrupt", "esc to abort");
    expect(reworded).not.toBe(frames[0]);
    expect(normalizeStallSnapshot(reworded)).not.toBe(normalizeStallSnapshot(frames[0]));
    const appended = `${frames[0]}\nerror: connection refused`;
    expect(normalizeStallSnapshot(appended)).not.toBe(normalizeStallSnapshot(frames[0]));
    // closed allowlist: unknown text passes through byte-identical
    const plain = "worker log: 5 of 7 suites passed, servers (6/7), retry 30 pending\n";
    expect(normalizeStallSnapshot(plain)).toBe(plain);
  });
});
