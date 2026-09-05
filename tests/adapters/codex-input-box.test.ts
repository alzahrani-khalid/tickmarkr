import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codex, CODEX_INPUT_BOX } from "../../src/adapters/codex.js";
import {
  declaredInputBoxForWorkerName,
  matchesEmptyInputBox,
  matchesInputBox,
  matchesOccupiedInputBox,
  missingInputStateDeclarations,
  QUOTA_RE,
} from "../../src/adapters/types.js";
import { stallSnapshotBannerRows } from "../../src/run/stall.js";

// OBS-930: every frame below is a VERBATIM herdr pane read of codex 0.153.4 (provenance:
// tests/fixtures/codex-input-box/README.md). Nothing here is typed from memory.
const FIXTURES = join(import.meta.dirname, "../fixtures/codex-input-box");
const frame = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const IDLE_TEXT = frame("idle-visible.txt");
const IDLE_ANSI = frame("idle-visible.ansi");
const OCCUPIED_TEXT = frame("occupied-visible.txt");
const OCCUPIED_ANSI = frame("occupied-visible.ansi");
const TRANSCRIPT = frame("transcript-recent-unwrapped.txt");
const TRUST_DIALOG = frame("trust-dialog.txt");

describe("codex input box (OBS-930 / OBS-136)", () => {
  test("test: the idle composer is recognised as painted and empty in both the text and ansi pane reads whereas an occupied composer is painted and not empty", () => {
    for (const idle of [IDLE_TEXT, IDLE_ANSI]) {
      expect(matchesInputBox(idle, CODEX_INPUT_BOX)).toBe(true);
      expect(matchesEmptyInputBox(idle, CODEX_INPUT_BOX)).toBe(true);
      expect(matchesOccupiedInputBox(idle, CODEX_INPUT_BOX)).toBe(false);
    }
    for (const occupied of [OCCUPIED_TEXT, OCCUPIED_ANSI]) {
      expect(matchesInputBox(occupied, CODEX_INPUT_BOX)).toBe(true);
      expect(matchesEmptyInputBox(occupied, CODEX_INPUT_BOX)).toBe(false);
      expect(matchesOccupiedInputBox(occupied, CODEX_INPUT_BOX)).toBe(true);
    }
  });

  test("test: a submitted turn echoed with the same caret and the trust dialog's cursor never read as a composer whereas the transcript that also holds the idle composer does", () => {
    // the full transcript: echoed `› You are a smoke test.` + `• PONG` + the idle composer
    expect(matchesInputBox(TRANSCRIPT, CODEX_INPUT_BOX)).toBe(true);
    expect(matchesEmptyInputBox(TRANSCRIPT, CODEX_INPUT_BOX)).toBe(true);
    // the same transcript with the composer rows removed: only the echoed turn's caret remains
    const echoOnly = TRANSCRIPT.split("\n").filter((l) => !/Ask Codex to do anything| · /.test(l)).join("\n");
    expect(echoOnly).toContain("› You are a smoke test.");
    expect(matchesInputBox(echoOnly, CODEX_INPUT_BOX)).toBe(false);
    expect(matchesEmptyInputBox(echoOnly, CODEX_INPUT_BOX)).toBe(false);
    expect(TRUST_DIALOG).toContain("› 1. Yes, continue");
    expect(matchesInputBox(TRUST_DIALOG, CODEX_INPUT_BOX)).toBe(false);
    // a bare fingerprint would have matched all three — the structural anchor is the point
    expect(TRUST_DIALOG.includes(CODEX_INPUT_BOX.fingerprint)).toBe(true);
  });

  test("test: the codex adapter declares the composer with every typed-delivery state so a worker slot named for codex resolves to it and carries the › glyph", () => {
    expect(codex.inputBox).toBe(CODEX_INPUT_BOX);
    expect(missingInputStateDeclarations(CODEX_INPUT_BOX)).toEqual([]);
    expect(declaredInputBoxForWorkerName("T2-worker-codex-a0-run")).toBe(CODEX_INPUT_BOX);
    expect(CODEX_INPUT_BOX.promptGlyph).toBe("›");
    expect((CODEX_INPUT_BOX as { firstDeliveryIsLaunch?: true }).firstDeliveryIsLaunch).toBe(true);
  });

  test("test: the idle codex TUI's banner rows carry the 'usage limit resets available' chrome yet never read as a quota banner whereas a real limit line in the same tail does", () => {
    expect(IDLE_TEXT).toMatch(/usage limit resets available/);
    expect(QUOTA_RE.test(stallSnapshotBannerRows(IDLE_TEXT))).toBe(false);
    expect(QUOTA_RE.test(stallSnapshotBannerRows(TRANSCRIPT))).toBe(false);
    // control: the filter removes only the known chrome line, never a real banner beside it
    const throttled = IDLE_TEXT.replace("• PONG", "• You've hit your usage limit. Try again at 4pm.");
    expect(QUOTA_RE.test(stallSnapshotBannerRows(throttled))).toBe(true);
  });
});
