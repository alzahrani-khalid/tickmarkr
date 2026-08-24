import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { runInitWizardApp, type InitWizardFields } from "../../src/tui/ink/init-app.js";

// logical key name → raw bytes, same vocabulary the fleet suite pins against node's
// production keypress decoder — one complete sequence per initialInput token, because
// Ink treats a multi-key chunk as a paste
const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
  space: " ",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
} as const;

type TestInput = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => TestInput;
  unref: () => TestInput;
};

// The production-shaped stream pair: ref/unref present selects init-app's raw-data input
// path (the one real terminals hit), and the output exposes listener methods so the app
// runs without Ink's debug frame mode — tests only assert on the resolved result and on
// text presence across all frames.
const makeIO = () => {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 120,
    rows: 60,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  return { input: input as unknown as NodeJS.ReadStream, output, writes };
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// Same streams, minus the listener methods: init-app reads that absence as a legacy output and
// turns on Ink's debug frame mode, which writes one COMPLETE frame per keypress instead of
// throttling. Description copy shown only while the cursor sits on a row is otherwise a frame
// the throttle is free to drop.
const makeFrameIO = () => {
  const io = makeIO();
  const { isTTY, columns, rows, write } = io.output as unknown as Record<string, unknown>;
  return { ...io, output: { isTTY, columns, rows, write } as unknown as NodeJS.WriteStream };
};

const fields = (over: Partial<InitWizardFields> = {}): InitWizardFields => ({
  driver: "auto",
  concurrency: 3,
  visibilityLlm: "headless",
  offerSkills: true,
  skillsDefault: true,
  ...over,
});

const run = (f: InitWizardFields, keys: string[], io = makeIO()) => {
  const result = runInitWizardApp({ fields: f, input: io.input, output: io.output, initialInput: keys });
  return { result, io };
};

// row order with offerSkills: driver, concurrency, visibility, skills, docs, continue
const TO_CONTINUE = [KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down];

describe("init wizard act 1", () => {
  test("defaults pass through untouched to the overlay", async () => {
    const { result } = run(fields(), [...TO_CONTINUE, KEYS.enter]);
    expect(await result).toEqual({
      kind: "continue",
      overlay: { driver: "auto", concurrency: 3, visibility: { llm: "headless" } },
      installSkills: true,
      installDocs: false,
    });
  });

  test("the guided init driver cycle offers orca with orca-specific environment copy and auto still described as herdr-else-subprocess while the shipped cycle limited to auto, herdr and subprocess fails", async () => {
    // three cycles from the seeded auto: herdr → subprocess → orca. A cycle holding only
    // auto/herdr/subprocess wraps back to auto here and never renders the orca copy.
    const { result, io } = run(fields(), [KEYS.space, KEYS.space, KEYS.space, ...TO_CONTINUE, KEYS.enter], makeFrameIO());
    const outcome = await result;
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") expect(outcome.overlay.driver).toBe("orca");

    const frames = strip(io.writes.join(""));
    // orca's own environment — its terminals, and that only an explicit choice reaches it
    expect(frames).toContain("orca: visible terminals in the Orca app");
    expect(frames).toContain("an explicit choice, never auto's");
    // auto's meaning is untouched by the fourth driver
    expect(frames).toContain("auto: herdr when HERDR_ENV=1, else subprocess");
  });

  test("cycling driver twice from auto lands on subprocess", async () => {
    const { result } = run(fields(), [KEYS.space, KEYS.space, ...TO_CONTINUE, KEYS.enter]);
    const outcome = await result;
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") expect(outcome.overlay.driver).toBe("subprocess");
  });

  test("typed digits become the concurrency integer", async () => {
    const { result } = run(fields(), [KEYS.down, "1", "2", KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter]);
    const outcome = await result;
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") expect(outcome.overlay.concurrency).toBe(12);
  });

  test("zero and empty clamp back to the prior valid value", async () => {
    // type 12 and leave the row (commits 12), come back, type 0 → clamps to 12, not the seed 3
    const zeroed = run(fields(), [
      KEYS.down, "1", "2", KEYS.down, KEYS.up, "0",
      KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter,
    ]);
    const zeroedOutcome = await zeroed.result;
    expect(zeroedOutcome.kind).toBe("continue");
    if (zeroedOutcome.kind === "continue") expect(zeroedOutcome.overlay.concurrency).toBe(12);

    // backspacing the buffer to empty reverts to the seeded value on leave
    const emptied = run(fields(), [
      KEYS.down, "1", "2", KEYS.backspace, KEYS.backspace,
      KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter,
    ]);
    const emptiedOutcome = await emptied.result;
    expect(emptiedOutcome.kind).toBe("continue");
    if (emptiedOutcome.kind === "continue") expect(emptiedOutcome.overlay.concurrency).toBe(3);
  });

  test("escape resolves quit from anywhere", async () => {
    const { result } = run(fields(), [KEYS.down, KEYS.escape]);
    expect(await result).toEqual({ kind: "quit" });
  });

  test("skills toggle flips installSkills off", async () => {
    const { result } = run(fields(), [
      KEYS.down, KEYS.down, KEYS.down, KEYS.space, KEYS.down, KEYS.down, KEYS.enter,
    ]);
    const outcome = await result;
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") expect(outcome.installSkills).toBe(false);
  });

  test("docs toggle flips installDocs on and is independent of the skills default", async () => {
    const { result } = run(fields(), [
      KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.space, KEYS.down, KEYS.enter,
    ]);
    const outcome = await result;
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") {
      expect(outcome.installDocs).toBe(true);
      expect(outcome.installSkills).toBe(true);
    }
  });

  test("offerSkills=false removes the row from navigation and rendering", async () => {
    // three downs from Driver land directly on Continue — the skills row is not in the path
    const { result, io } = run(fields({ offerSkills: false }), [
      KEYS.down, KEYS.down, KEYS.down, KEYS.enter,
    ]);
    const outcome = await result;
    expect(outcome).toEqual({
      kind: "continue",
      overlay: { driver: "auto", concurrency: 3, visibility: { llm: "headless" } },
      installSkills: false,
      installDocs: false,
    });
    expect(strip(io.writes.join(""))).not.toContain("Install agent skills");
  });

  test("tab jumps from the Run section to Skills", async () => {
    // tab from Driver lands on the skills row; space flips it, then past docs to Continue
    const { result } = run(fields({ skillsDefault: false }), [
      KEYS.tab, KEYS.space, KEYS.down, KEYS.down, KEYS.enter,
    ]);
    const outcome = await result;
    expect(outcome.kind).toBe("continue");
    if (outcome.kind === "continue") expect(outcome.installSkills).toBe(true);
  });
});
