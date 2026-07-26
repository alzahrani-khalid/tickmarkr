import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  confirmKimiSeedBanner,
  kimi,
  KIMI_INPUT_BOX,
  kimiBannerModel,
  kimiBannerSessionId,
  runKimiInteractiveSeed,
} from "../../src/adapters/kimi.js";
import { matchesEmptyInputBox, matchesInputBox } from "../../src/adapters/types.js";
import type { Assignment } from "../../src/adapters/types.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";

const ASSIGNMENT: Assignment = { adapter: "kimi", model: "kimi-code/k3", channel: "sub", tier: "frontier" };
const FULL_MODEL = "kimi-code/kimi-for-coding";
const RETIRED_ALIAS = "kimi-for-coding";
const LIVE_BANNER_FRAME = readFileSync(
  join(import.meta.dirname, "../fixtures/kimi-editor-readiness/frame-01.txt"),
  "utf8",
);
const LIVE_BANNER_SESSION = "session_4d758ead-0dd9-475f-8ba4-bfa38741b59e";

function makeKimiSeedDriver(banner: string, opts: { submit?: boolean } = {}) {
  let buf = banner;
  if (!buf.includes("Send /help for help information.")) {
    buf += "\nSend /help for help information.\n> ";
  }
  const runs: string[] = [];
  const seedText = `Read /tmp/prompt.md and do exactly what it says.`;
  const slot: Slot = { id: "p1", name: "kimi-worker", cwd: "/tmp" };

  const driver: ExecutorDriver = {
    id: "kimi-seed-stub",
    interactive: true,
    slot: async () => slot,
    run: async (_s: Slot, cmd: string) => {
      runs.push(cmd);
      if (cmd.includes("kimi -y -m")) {
        // launch: the TUI banner is already in the pane buffer
      } else if (cmd === seedText) {
        buf += `\n${cmd}\n`;
        if (opts.submit !== false) buf += "[submitted]\n";
      } else {
        throw new Error(`unexpected command: ${cmd}`);
      }
    },
    waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) =>
      o?.regex ? new RegExp(pattern).test(buf) : buf.includes(pattern),
    waitAgentStatus: async () => true,
    status: async () => "unknown",
    read: async (_s: Slot, lines: number) => buf.split("\n").slice(-lines).join("\n"),
    notify: async () => {},
    close: async () => {},
    worktree: async (repo: string) => repo,
  };

  return { driver, slot, runs, seedText };
}

describe("kimi TUI seed banner checks", () => {
  test("kimi declares its bordered steady-state input box through the adapter contract", () => {
    const emptyEditor = "╭────────────╮\n│ >          │\n╰────────────╯";
    const welcomeBanner = "Welcome to Kimi Code!\nSend /help for help information.";
    expect(kimi.inputBox?.fingerprint).toBe("│ > ");
    expect(kimi.inputBox?.match?.(emptyEditor)).toBe(true);
    expect(kimi.inputBox?.emptyMatch?.(emptyEditor)).toBe(true);
    expect(kimi.inputBox?.match?.(welcomeBanner)).toBe(false);
    expect(kimi.inputBox?.emptyMatch?.(welcomeBanner)).toBe(false);
    expect(kimi.inputBox?.launchCommand?.(kimi.interactiveSeed!.launch(FULL_MODEL))).toBe(true);
    expect(kimi.inputBox?.launchCommand?.("Read /tmp/prompt.md and do exactly what it says.")).toBe(false);
    expect(kimi.inputBox?.readinessTimeoutMs).toBe(15_000);
  });

  // OBS-152 regression. The synthetic fixture above passed for four versions while the LIVE matcher
  // failed, because it was hand-authored flush-left and kimi indents its whole TUI one column — the
  // `^`-anchored row regexes never fired on reality. This case reads the VERBATIM frame the driver
  // itself captured and journalled at probe 6's readiness timeout (run-20260724-222251, kimi 0.29.0,
  // delivery-readiness-failed after 15000ms) — a frame whose editor box was fully painted and
  // interactive. Never regenerate this file by hand; re-capture it from a journal.
  test("recognizes the live indented editor box from the verbatim probe-6 readiness frame (OBS-152)", () => {
    const frame = readFileSync(join(import.meta.dirname, "../fixtures/kimi-editor-readiness/frame-01.txt"), "utf8");
    // guard the fixture itself: if these stop holding, the capture was tidied and the test is theatre
    expect(frame).toContain("│ > ");
    expect(frame.split("\n").some((line) => /^\s+╭─+╮$/.test(line))).toBe(true);
    expect(frame.split("\n").some((line) => /^╭─+╮$/.test(line))).toBe(false);

    expect(kimi.inputBox?.match?.(frame)).toBe(true);
    expect(kimi.inputBox?.emptyMatch?.(frame)).toBe(true);
  });

  test("the indented welcome panel alone still never satisfies the editor declaration (OBS-152 guard)", () => {
    // The welcome panel is ALSO an indented bordered box, so trimming the margin must not let it
    // count as an input box — that would make readiness go true on banner paint again (OBS-142).
    // This negative fixture is DERIVED from the real capture, never hand-typed: two live launches
    // (0.29.0 and 0.29.1) both painted banner and editor in a SINGLE frame, so a banner-only frame
    // is not producible from this surface — the honest substitute is the captured frame with its
    // editor box sliced off at the box's own top border.
    const frame = readFileSync(join(import.meta.dirname, "../fixtures/kimi-editor-readiness/frame-01.txt"), "utf8");
    const lines = frame.split("\n");
    const inputRow = lines.findIndex((line) => line.includes("│ > "));
    expect(inputRow).toBeGreaterThan(0);
    const bannerOnly = lines.slice(0, inputRow - 1).join("\n");

    expect(bannerOnly).toContain("Welcome to Kimi Code!");
    expect(bannerOnly).not.toContain("│ > ");
    expect(kimi.inputBox?.match?.(bannerOnly)).toBe(false);
    expect(kimi.inputBox?.emptyMatch?.(bannerOnly)).toBe(false);
  });

  // A second live capture, taken from kimi 0.29.1 after it auto-updated mid-session. Its only job
  // is to prove the one-column indent is a stable property of the interface rather than a 0.29.0
  // fluke — if a future version un-indents, this fails and the matcher gets re-examined on purpose.
  test("the indent survives a kimi version bump (0.29.1 capture)", () => {
    const frame = readFileSync(join(import.meta.dirname, "../fixtures/kimi-editor-readiness/frame-02.txt"), "utf8");
    expect(frame).toContain("Version:   0.29.1");
    expect(frame.split("\n").some((line) => /^\s+╭─+╮$/.test(line))).toBe(true);
    expect(kimi.inputBox?.match?.(frame)).toBe(true);
  });

  test("test: the model identity is extracted from a banner captured verbatim from the live interface, borders and indentation included", () => {
    // This is the driver-captured probe-6 frame, including shell echo, absolute worktree path,
    // terminal-width borders, version, indentation, and the steady-state editor below the banner.
    expect(LIVE_BANNER_FRAME).toContain("kimi -y -m 'kimi-code/kimi-for-coding'");
    expect(LIVE_BANNER_FRAME).toContain("Version:   0.29.0");
    expect(LIVE_BANNER_FRAME.split("\n").some((line) => line.startsWith(" │  Model:"))).toBe(true);
    expect(LIVE_BANNER_FRAME.split("\n").some((line) => line.startsWith("Model:"))).toBe(false);

    expect(kimiBannerModel(LIVE_BANNER_FRAME)).toBe(FULL_MODEL);
  });

  test("test: a banner naming a model other than the one assigned is reported as a mismatch", async () => {
    const result = confirmKimiSeedBanner(LIVE_BANNER_FRAME, ASSIGNMENT.model);

    expect(result).toMatchObject({
      ok: false,
      status: "mismatch",
      error: `model mismatch: expected ${ASSIGNMENT.model}, saw ${FULL_MODEL}`,
    });

    const { driver, slot, runs } = makeKimiSeedDriver(LIVE_BANNER_FRAME);
    const seeded = await runKimiInteractiveSeed({
      driver,
      slot,
      assignment: ASSIGNMENT,
      promptFile: "/tmp/prompt.md",
      taskTimeoutMinutes: 0.1,
    });
    expect(seeded.seedFailed).toBe(true);
    expect(seeded.seedError).toBe(result.status === "mismatch" ? result.error : undefined);
    expect(runs).toHaveLength(1);
  });

  test("test: a banner whose printed model name has no known mapping to a channel identifier is reported as unknown rather than as a mismatch", () => {
    const unknownBanner = LIVE_BANNER_FRAME.replace("K2.7 Coding", "Unmapped Future Model");

    expect(confirmKimiSeedBanner(unknownBanner, ASSIGNMENT.model)).toEqual({
      status: "unknown",
      printedModel: "Unmapped Future Model",
      sessionId: LIVE_BANNER_SESSION,
    });
    expect(kimi.interactiveSeed!.confirmBanner!(unknownBanner, ASSIGNMENT.model)).toMatchObject({
      ok: true,
      status: "unknown",
      sessionId: LIVE_BANNER_SESSION,
    });
  });

  test("test: the session identifier is extracted from that same captured banner", () => {
    expect(kimiBannerSessionId(LIVE_BANNER_FRAME)).toBe(LIVE_BANNER_SESSION);
    expect(kimi.sessionIdFrom!(LIVE_BANNER_FRAME)).toBe(LIVE_BANNER_SESSION);
  });

  test("test: the interactive launch command carries the full configured model identifier rather than a stripped suffix", () => {
    expect(kimi.interactiveSeed?.launch(FULL_MODEL)).toBe(`kimi -y -m '${FULL_MODEL}'`);
  });

  test("test: the banner model parse maps whatever the banner prints back to the same channel identifier routing uses", () => {
    for (const printedModel of [FULL_MODEL, RETIRED_ALIAS]) {
      const banner = `Model: ${printedModel}`;
      expect(kimiBannerModel(banner)).toBe(FULL_MODEL);
      expect(confirmKimiSeedBanner(banner, FULL_MODEL)).toEqual({ ok: true, status: "confirmed" });
    }
  });

  test("the launch banner's named model line is checked against the assigned channel before the seed line is injected, failing closed on a mismatch rather than seeding blind", async () => {
    const banner = "Model: kimi-for-coding\nSession: session_11111111-aaaa-bbbb-cccc-111111111111\n";
    const { driver, slot, runs } = makeKimiSeedDriver(banner);
    const r = await runKimiInteractiveSeed({
      driver,
      slot,
      assignment: ASSIGNMENT,
      promptFile: "/tmp/prompt.md",
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(true);
    expect(r.seedError).toMatch(/model mismatch/);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("kimi -y -m");
    expect(r.output).toContain("Model: kimi-for-coding");
    // Pure confirm on the same banner text — no probe of its own.
    expect(confirmKimiSeedBanner(banner, ASSIGNMENT.model).ok).toBe(false);
    expect(kimiBannerModel(banner)).toBe("kimi-code/kimi-for-coding");
  });

  test("a session identifier is captured from the launch banner itself rather than waiting for the attempt's own completion text", async () => {
    const sessionId = "session_25e8efca-cc09-4dd6-9dee-1951aec28581";
    const banner = `Model: k3\nSession: ${sessionId}\n`;
    const { driver, slot, runs, seedText } = makeKimiSeedDriver(banner);
    const r = await runKimiInteractiveSeed({
      driver,
      slot,
      assignment: ASSIGNMENT,
      promptFile: "/tmp/prompt.md",
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(false);
    expect(r.sessionId).toBe(sessionId);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toBe(seedText);
    // Captured from the banner alone — no completion-time resume trailer present.
    expect(r.output).not.toMatch(/To resume this session/);
    expect(kimiBannerSessionId(banner)).toBe(sessionId);
    expect(kimi.sessionIdFrom!(banner)).toBe(sessionId);
    expect(confirmKimiSeedBanner(banner, ASSIGNMENT.model)).toEqual({ ok: true, status: "confirmed", sessionId });
  });
});

// OBS-181: the submit verifier fails OPEN whenever an adapter's input-box matcher misses, because
// the driver's fallback ("is there any text after the prompt?") is always true for a TUI that paints
// chrome below its editor. kimi's status footer made every wedged dispatch read as delivered while
// the pane sat untouched and the stall clock ran.
//
// `match` deliberately means "the editor box is PAINTED" (readiness) and is true for an empty box;
// `emptyMatch` is the stricter "painted and carrying nothing". The defect was that a box with blank
// continuation rows satisfied NEITHER, because the matcher demanded the bottom border on the line
// directly below the prompt. It had never been exercised against an occupied box at all.
describe("kimi editor box matching with continuation rows (OBS-181)", () => {
  const frame = (name: string) =>
    readFileSync(join(import.meta.dirname, `../fixtures/kimi-editor-readiness/${name}.txt`), "utf8");

  test("test: an occupied editor box is painted and NOT empty, so an unsubmitted prompt is visible to the submit verifier", () => {
    const occupied = frame("frame-occupied");
    expect(matchesInputBox(occupied, KIMI_INPUT_BOX)).toBe(true);
    expect(matchesEmptyInputBox(occupied, KIMI_INPUT_BOX)).toBe(false);
  });

  test("test: an empty editor box is painted AND empty, so a submitted pane is positively recognised rather than inferred", () => {
    for (const name of ["frame-01", "frame-02"]) {
      expect(matchesInputBox(frame(name), KIMI_INPUT_BOX), `${name} painted`).toBe(true);
      expect(matchesEmptyInputBox(frame(name), KIMI_INPUT_BOX), `${name} empty`).toBe(true);
    }
  });

  test("test: a box carrying blank continuation rows still matches, so a multi-row editor does not blind the matcher", () => {
    // The wedged worker pane rendered four rows — top, prompt, a blank continuation row, bottom.
    // Asserted by inserting interior rows into a real capture rather than hand-authoring a frame.
    const lines = frame("frame-occupied").split("\n");
    const promptAt = lines.findIndex((line) => line.trim().startsWith("│ > "));
    expect(promptAt).toBeGreaterThan(-1);
    const width = Math.max(2, lines[promptAt].trim().length);
    const blank = `│${" ".repeat(width - 2)}│`;
    for (const extra of [1, 2, 5]) {
      const widened = [
        ...lines.slice(0, promptAt + 1),
        ...Array.from({ length: extra }, () => blank),
        ...lines.slice(promptAt + 1),
      ].join("\n");
      expect(matchesInputBox(widened, KIMI_INPUT_BOX), `${extra} continuation row(s)`).toBe(true);
      expect(matchesEmptyInputBox(widened, KIMI_INPUT_BOX), `${extra} continuation row(s)`).toBe(false);
    }
  });
});
