import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { filterLlmTranscript, normalizeStallSnapshot, PANE_READ_ROWS, stallSnapshotBannerRows, stallSnapshotTail, StallProgressTracker } from "../../src/run/stall.js";
import { QUOTA_RE } from "../../src/adapters/types.js";

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

describe("stall progress tracker", () => {
  test("ambiguity between repaint and progress resolves toward firing the watchdog because a spurious consult is recoverable and a silent one is not", () => {
    const tracker = new StallProgressTracker();
    expect(tracker.observe({ paneText: "seed accepted\nagent idle · context 0% · cursor row 1" })).toBe(true);
    expect(tracker.observe({ paneText: "seed accepted\nagent idle · context 0% · cursor row 2" })).toBe(false);
    expect(tracker.observe({ paneText: "seed accepted\nagent idle · context 0% · cursor row 1000" })).toBe(false);
  });

  test("seed submission transcript growth and context growth are monotonic progress signals", () => {
    const tracker = new StallProgressTracker();
    expect(tracker.observe({ paneText: "", seedSubmitted: true })).toBe(true);
    expect(tracker.observe({ paneText: "", seedSubmitted: true })).toBe(false);
    expect(tracker.observe({ paneText: "first transcript row" })).toBe(true);
    expect(tracker.observe({ paneText: "repainted status row" })).toBe(false);
    expect(tracker.observe({ paneText: "first transcript row\nsecond transcript row" })).toBe(true);
    expect(tracker.observe({ paneText: "first transcript row\nsecond transcript row", contextTokens: 100 })).toBe(true);
    expect(tracker.observe({ paneText: "first transcript row\nsecond transcript row", contextTokens: 100 })).toBe(false);
    expect(tracker.observe({ paneText: "first transcript row\nsecond transcript row", contextTokens: 90 })).toBe(false);
    expect(tracker.observe({ paneText: "first transcript row\nsecond transcript row", contextTokens: 101 })).toBe(true);
  });

  test("test: row growth with a flat token-usage counter past fifteen minutes no longer resets the inactivity window, and with token growth it still does", () => {
    const t0 = 1_000_000_000;
    const tracker = new StallProgressTracker();
    // the first token sample anchors the flat-clock; token growth re-arms (and re-anchors)
    expect(tracker.observe({ paneText: "row 1", contextTokens: 100 }, t0)).toBe(true);
    // row growth inside fifteen minutes of the last token movement still re-arms the window …
    expect(tracker.observe({ paneText: "row 1\nrow 2", contextTokens: 100 }, t0 + 14 * 60_000)).toBe(true);
    // … but past fifteen minutes with a flat token counter the same row growth is cosmetic
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3", contextTokens: 100 }, t0 + 15 * 60_000 + 1)).toBe(false);
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3\nrow 4", contextTokens: 100 }, t0 + 20 * 60_000)).toBe(false);
    // token growth still resets the window, and re-opens the row-growth allowance
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3\nrow 4", contextTokens: 101 }, t0 + 20 * 60_000 + 1)).toBe(true);
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3\nrow 4\nrow 5", contextTokens: 101 }, t0 + 20 * 60_000 + 2)).toBe(true);
  });

  // T1 review fix: the flat-token rule suppresses the progress REPORT, but the dead-channel
  // fast-kill's "no output growth" leg must still see the pane streaming — lastRowGrowthAt is the
  // raw clock, advancing on every high-water advance whether or not observe() reports progress.
  test("the raw row-growth clock advances even while the flat-token rule suppresses the progress report", () => {
    const t0 = 1_000_000_000;
    const tracker = new StallProgressTracker();
    expect(tracker.lastRowGrowthAt).toBeUndefined(); // nothing observed yet
    tracker.observe({ paneText: "row 1", contextTokens: 100 }, t0);
    expect(tracker.lastRowGrowthAt).toBe(t0);
    // past the flat-token cap: observe() reports false (window does not re-arm) …
    expect(tracker.observe({ paneText: "row 1\nrow 2", contextTokens: 100 }, t0 + 16 * 60_000)).toBe(false);
    // … but the raw clock moved — this pane is streaming, not dead
    expect(tracker.lastRowGrowthAt).toBe(t0 + 16 * 60_000);
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3", contextTokens: 100 }, t0 + 17 * 60_000)).toBe(false);
    expect(tracker.lastRowGrowthAt).toBe(t0 + 17 * 60_000);
    // a same-extent repaint is not row growth on either clock
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3", contextTokens: 100 }, t0 + 18 * 60_000)).toBe(false);
    expect(tracker.lastRowGrowthAt).toBe(t0 + 17 * 60_000);
  });

  test("the quota tail is the last rows of the transcript, so an earlier mention is not a live banner", () => {
    const banner = "claude ai usage limit reached for this model\nresets at 5pm";
    expect(stallSnapshotTail(banner)).toContain("usage limit reached");
    // the same words quoted 20 rows up — a diff hunk the worker printed and then kept working past
    const quoted = ["+ // provider rate limit banner handling", ...Array.from({ length: 20 }, (_, i) => `reading module-${i}.ts`)].join("\n");
    expect(quoted).toMatch(/rate limit/); // the raw snapshot still matches …
    expect(stallSnapshotTail(quoted)).not.toMatch(/rate limit/); // … the tail does not
    // chrome-only rows never displace real ones out of the tail (normalized before slicing)
    const withChrome = [banner, ...Array.from({ length: 20 }, () => "⠋ 12s")].join("\n");
    expect(stallSnapshotTail(withChrome)).toContain("usage limit reached");
  });

  // T1 review (chrome-blind-matcher class): the tail of a rendered TUI frame ends in fixed chrome,
  // not the newest transcript line. Codex pins "• You have 3 usage limit resets available." there —
  // QUOTA_RE matches the raw tail of ALL EIGHT captured frames of this wedged-MCP pane, so a raw-tail
  // classifier would fail the canonical stall over as quota exhaustion. The classifier filters that
  // KNOWN chrome by identity (resets AVAILABLE is the opposite of exhaustion), never by novelty
  // against an anchor — see the launch-throttle proof below for what novelty exculpates.
  test("the captured wedged codex pane matches QUOTA_RE on raw tail rows but never once the known chrome is filtered", () => {
    expect(frames.length).toBeGreaterThanOrEqual(8); // the full capture, not a sample
    for (const frame of frames) {
      expect(QUOTA_RE.test(stallSnapshotTail(frame))).toBe(true); // the chrome really is in every tail …
      expect(QUOTA_RE.test(stallSnapshotBannerRows(frame))).toBe(false); // … and identity-filtering removes exactly it
    }
    // a live banner appended anywhere in the tail still classifies
    const live = `${frames[0]!}\nclaude ai usage limit reached for this model\nresets at 5pm`;
    expect(QUOTA_RE.test(stallSnapshotBannerRows(live))).toBe(true);
  });

  // T1 review (material): WHY the filter is by identity, never novelty against an anchor frame.
  // A channel throttled at LAUNCH paints its banner before the daemon's first poll read — under a
  // novelty baseline that banner IS the baseline and is exculpated forever (proven by execution
  // against the daemon: banner-from-the-first-loop-read fails over on shipped 843328b0, parks
  // human under the baseline). Identity-filtered rows classify a banner whenever it arrived.
  test("a quota banner present from the very first frame still classifies — the launch-throttle case a novelty baseline exculpated", () => {
    const throttledAtLaunch = "claude ai usage limit reached for this model\nresets at 5pm";
    expect(QUOTA_RE.test(stallSnapshotBannerRows(throttledAtLaunch))).toBe(true);
    // … including when the banner shares the tail with pinned codex chrome
    const withChrome = `${throttledAtLaunch}\n• You have 3 usage limit resets available. Run /usage to use one.`;
    expect(QUOTA_RE.test(stallSnapshotBannerRows(withChrome))).toBe(true);
  });

  test("a token DECREASE re-anchors the flat-clock — a compacting worker's row growth keeps re-arming", () => {
    const t0 = 1_000_000_000;
    const tracker = new StallProgressTracker();
    expect(tracker.observe({ paneText: "row 1", contextTokens: 100 }, t0)).toBe(true);
    // past fifteen flat minutes, row growth is cosmetic …
    expect(tracker.observe({ paneText: "row 1\nrow 2", contextTokens: 100 }, t0 + 16 * 60_000)).toBe(false);
    // … then the counter DROPS (context compaction, session rollover): movement, so the flat-clock
    // re-anchors even though a high-water comparison would read the counter as permanently flat
    expect(tracker.observe({ paneText: "row 1\nrow 2", contextTokens: 40 }, t0 + 17 * 60_000)).toBe(false);
    // row growth within fifteen minutes of that drop re-arms the window again — the worker lives
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3", contextTokens: 40 }, t0 + 18 * 60_000)).toBe(true);
    // and the climb back below the old peak is token growth again, not a frozen counter
    expect(tracker.observe({ paneText: "row 1\nrow 2\nrow 3", contextTokens: 60 }, t0 + 19 * 60_000)).toBe(true);
  });

  // T1 review (read-ceiling blindness): the row high-water is a one-way ratchet bounded by the
  // daemon's bounded pane read. Once a sample fills the read window, observe() can never report
  // row growth again — a flat tracker then means "unmeasurable", not "no output" — and the
  // dead-channel fast-kill must stand down on `rowSignalSaturated` instead of killing a live
  // unmetered worker (codex/cursor-agent/grok/opencode have no token signal to save them).
  test("the row signal reports saturated at the read ceiling, and never before it", () => {
    const tracker = new StallProgressTracker();
    expect(tracker.rowSignalSaturated).toBe(false); // no sample yet
    // the daemon only ever hands the tracker what the bounded pane read returned — simulate that
    const readWindow = (text: string) => text.split("\n").slice(-PANE_READ_ROWS).join("\n");
    const below = Array.from({ length: PANE_READ_ROWS - 1 }, (_, i) => `row ${i}`).join("\n");
    tracker.observe({ paneText: readWindow(below) });
    expect(tracker.rowSignalSaturated).toBe(false); // one row short of a full read window
    const at = `${below}\nrow ${PANE_READ_ROWS - 1}`;
    expect(tracker.observe({ paneText: readWindow(at) })).toBe(true); // the ceiling row itself is still growth …
    expect(tracker.rowSignalSaturated).toBe(true);
    // … but from here on the ratchet is stuck: new content scrolls out of the bounded read, so
    // every further sample is the same full window and observe() can never report growth again
    expect(tracker.observe({ paneText: readWindow(at) })).toBe(false);
    const beyond = `${at}\nrow ${PANE_READ_ROWS}\nrow ${PANE_READ_ROWS + 1}`; // a live worker still printing
    expect(tracker.observe({ paneText: readWindow(beyond) })).toBe(false); // indistinguishable from frozen
    expect(tracker.rowSignalSaturated).toBe(true); // sticky — the high-water never decreases
    // the token signal is unaffected by the ceiling: a metered worker still proves life
    expect(tracker.observe({ paneText: readWindow(beyond), contextTokens: 42 })).toBe(true);
  });

  // T1 review (material): saturation tracks the RAW window filling, not the normalized non-empty
  // count — a production `read(slot, PANE_READ_ROWS)` returns at most PANE_READ_ROWS lines
  // including blank and chrome-only rows (measured 730 non-empty of 1000 on the
  // codex-mcp-spinner fixture), so a non-empty high-water compared against PANE_READ_ROWS could
  // never reach it: the fast-kill's stand-down was unreachable and the kill fired on a blind
  // signal. A full raw window with sub-ceiling non-empty rows MUST saturate.
  test("a read window full on raw lines saturates even with non-empty rows below the ceiling", () => {
    const tracker = new StallProgressTracker();
    const pane = Array.from({ length: PANE_READ_ROWS }, (_, i) => (i % 4 === 3 ? "" : `row ${i}`)).join("\n");
    // the fixture's shape is the point: raw lines fill the read, non-empty rows do not
    expect(pane.split("\n").length).toBe(PANE_READ_ROWS);
    expect(pane.split("\n").filter((l) => l.trim().length > 0).length).toBeLessThan(PANE_READ_ROWS);
    tracker.observe({ paneText: pane });
    expect(tracker.rowSignalSaturated).toBe(true);
  });

  test("a tracker that never sees a token sample keeps row-growth re-arms forever (unmetered adapters)", () => {
    const t0 = 1_000_000_000;
    const tracker = new StallProgressTracker();
    expect(tracker.observe({ paneText: "row 1" }, t0)).toBe(true);
    expect(tracker.observe({ paneText: "row 1\nrow 2" }, t0 + 60 * 60_000)).toBe(true);
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
