import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { filterLlmTranscript, normalizeStallSnapshot } from "../../src/run/stall.js";

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

// v1.65 T2: LLM-bound transcript filter — noise drops, signal never does, fail-open on any defect.
describe("llm transcript filter", () => {
  test("carriage-return overwrite churn and spinner frames are removed from filtered text", () => {
    const cr = Array.from({ length: 40 }, (_, i) => `building ${i}%`).join("\r");
    const spinner = Array.from({ length: 30 }, (_, i) => `⠋ Starting MCP servers (${i}s • esc to interrupt)`).join("\n");
    const input = `${cr}\n${spinner}\n⠸⠴⠦⠇ 12s\nready: all servers up`;
    const out = filterLlmTranscript(input);
    expect(out).toContain("building 39%"); // the final CR paint survives …
    expect(out).not.toContain("building 5%"); // … the overwritten ones do not
    expect(out).not.toContain("⠸⠴⠦⠇"); // pure spinner/elapsed frame dropped entirely
    // 30 spinner repaint frames squash to at most the latest one
    expect(out.split("\n").filter((l) => l.includes("Starting MCP servers")).length).toBeLessThanOrEqual(1);
    expect(out).toContain("ready: all servers up");
    expect(out.length).toBeLessThan(input.length / 2);
  });

  test("a run of passing-test lines collapses to a count line", () => {
    const passes = Array.from({ length: 25 }, (_, i) => ` ✓ tests/unit/thing.test.ts > suite > handles case ${i} (3ms)`);
    const input = ["RUN v3 /repo", ...passes, "Tests  25 passed (25)"].join("\n");
    const out = filterLlmTranscript(input);
    expect(out).toContain("[25 passing-test lines collapsed]");
    expect(out).not.toContain("handles case 3"); // individual passing lines are gone
    expect(out).toContain("RUN v3 /repo");
    expect(out).toContain("Tests  25 passed (25)");
  });

  test("failure lines exit codes and summary lines always survive filtering", () => {
    const noise = Array.from({ length: 40 }, (_, i) => `⠙ compiling module ${"x".repeat(24)} (${i}s)`).join("\n");
    const signal = [
      " ✗ tests/gate.test.ts > scope > rejects out-of-scope edits",
      "FAIL tests/gate.test.ts",
      "AssertionError: expected 2 to be 3",
      "process exited with exit code 1",
      "Tests  1 failed | 12 passed (13)",
      "Duration  4.21s",
    ];
    const out = filterLlmTranscript(`${noise}\n${signal.join("\n")}`);
    for (const line of signal) expect(out).toContain(line); // verbatim — elapsed tokens included
    expect(out.split("\n").filter((l) => l.includes("compiling module")).length).toBeLessThanOrEqual(1);
  });

  test("an internal filter error returns the original text unchanged", () => {
    const input = "worker transcript\nwith perfectly ordinary lines";
    const out = filterLlmTranscript(input, () => {
      throw new Error("classifier defect");
    });
    expect(out).toBe(input);
  });

  test("input whose filtered form saves almost nothing passes through unfiltered", () => {
    const input = [
      "worker cloned the repository and inspected the existing module layout in detail",
      "the change plan touches two files and keeps the public surface entirely stable",
      "committing the edit with a conventional message and running the suite once now",
      "⠋ 2s",
    ].join("\n");
    const out = filterLlmTranscript(input);
    expect(out).toBe(input); // dropping the lone spinner frame saves <10% — byte-identical pass-through
  });
});
