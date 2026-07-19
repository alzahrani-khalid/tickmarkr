import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";

const { mockQuestion, mockCreateInterface } = vi.hoisted(() => {
  const mockQuestion = vi.fn();
  const mockCreateInterface = vi.fn(() => ({ question: mockQuestion, close: vi.fn() }));
  return { mockQuestion, mockCreateInterface };
});

vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));

import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { GLYPHS, toggleActive, toggleInactive } from "../../src/brand.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { formatFleetPrint, loadConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const FAKE_TIERS = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
`;

// the injected test parser: logical key name → raw bytes; the agreement test below pins
// that node's production keypress decoder names every one of these exactly as we assume
const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  j: "j",
  k: "k",
  space: " ",
  enter: "\r",
  escape: "\x1b",
  q: "q",
  r: "r",
  t: "t",
  a: "a",
  p: "p",
  f: "f",
} as const;

const withOverlay = (repo: string, yaml: string) => {
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
};

const stampDoctor = (repo: string) => {
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2", "fake-new"],
      modelsDetectedAt: "2026-07-16T12:00:00.000Z",
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
        "fake-new": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
      },
    },
  });
  const when = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
};

const fakeAdapter = (repo: string) => {
  const script = join(repo, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  return new FakeAdapter(script);
};

const setup = () => {
  const repo = makeRepo({ "keep.txt": "x" });
  withOverlay(repo, FAKE_TIERS);
  stampDoctor(repo);
  return { repo, adapter: fakeAdapter(repo) };
};

type TestInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };

// plain PassThrough with no inject marker of any kind: the editor decodes whatever raw
// bytes arrive on it through node's own emitKeypressEvents — the production path
const makeIO = () => {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  const rawCalls: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    rawCalls.push(mode);
  };
  const writes: string[] = [];
  const output = {
    isTTY: true,
    write: (chunk: string) => {
      writes.push(chunk);
    },
    // node's REAL readline (the OBS-77 tests) attaches/removes a terminal resize listener on
    // its output stream; production output is process.stdout which has these — inert here
    on: () => {},
    removeListener: () => {},
  };
  const io: FleetIO = { input, output };
  return { input, output, writes, rawCalls, io };
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const pointerLine = (frame: string) => strip(frame).split("\n").find((l) => l.includes("❯")) ?? "";

const drive = (repo: string, adapter: FakeAdapter, io: FleetIO, bytes: string, argv: string[] = []) => {
  const p = fleet(argv, repo, [adapter], io);
  io.input!.write(bytes);
  return p;
};

// isolated global config dir — the operator's real ~/.config/tickmarkr mode must never leak in
const isolatedGlobal = () => mkdtempSync(join(tmpdir(), "tickmarkr-fleet-g-"));

const withoutTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  try {
    await fn();
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

const queueAnswers = (...answers: string[]) => {
  mockQuestion.mockReset();
  for (const a of answers) mockQuestion.mockResolvedValueOnce(a);
};

// OBS-77 reproduces only through node's REAL readline — the mocked interface's close() never
// pauses the stream, so a mocked run goes green against the bug. Route the next n
// createInterface calls to the actual module: the production seam (OBS-69), same pause-on-close.
const useRealReadline = async (n: number) => {
  const real = await vi.importActual<typeof import("node:readline/promises")>("node:readline/promises");
  const impl = real.createInterface as unknown as Parameters<typeof mockCreateInterface.mockImplementationOnce>[0];
  for (let i = 0; i < n; i++) mockCreateInterface.mockImplementationOnce(impl);
};

const settle = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};

// fleet renders through the T1 brand helpers (src/brand.ts), which style only when the REAL
// process.stdout is a TTY — distinct from the injected FleetIO mock's own isTTY flag. The
// interactive editor requires a TTY to run at all, so this suite runs with one on by default;
// the single non-TTY refusal test below overrides both descriptors for its own scope.
let stdoutTTYDescriptor: PropertyDescriptor | undefined;
let noColorBefore: string | undefined;

beforeEach(() => {
  mockCreateInterface.mockClear();
  mockQuestion.mockReset();
  stdoutTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  noColorBefore = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (stdoutTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutTTYDescriptor);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (noColorBefore === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColorBefore;
});

describe("tickmarkr fleet", () => {
  test("the print flag output is the formatFleetPrint body with only the mode line spliced under the header", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const gdir = isolatedGlobal();
    withOverlay(repo, `${FAKE_TIERS}routing:
  deny:
    models: [fake:fake-2]
`);
    const out = await fleet(["--print", "--global-dir", gdir], repo, [fakeAdapter(repo)]);
    expect(out).toContain("# tickmarkr fleet — effective state");
    expect(out).toContain("fake-2");
    expect(mockCreateInterface).not.toHaveBeenCalled();
    // non-TTY regex stability: line 2 is the comment-prefixed mode line; the rest is byte-identical
    const lines = (out as string).split("\n");
    expect(lines[1]).toBe("# mode: risk-based (default)");
    expect([lines[0], ...lines.slice(2)].join("\n")).toBe(formatFleetPrint(repo, { globalDir: gdir }));
  });

  test("fleet print output names the mode and its source layer", async () => {
    const gdir = isolatedGlobal();
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `${FAKE_TIERS}routing:
  mode: staff-led
`);
    const out = await fleet(["--print", "--global-dir", gdir], repo, [fakeAdapter(repo)]);
    expect(out).toContain("# mode: staff-led (repo config)");
    // no declaration anywhere → the default, named as such
    const repo2 = makeRepo({ "keep.txt": "x" });
    withOverlay(repo2, FAKE_TIERS);
    const out2 = await fleet(["--print", "--global-dir", gdir], repo2, [fakeAdapter(repo2)]);
    expect(out2).toContain("# mode: risk-based (default)");
    // a global-layer declaration is attributed to the global layer
    writeFileSync(join(gdir, "config.yaml"), "routing:\n  mode: partner-led\n");
    const out3 = await fleet(["--print", "--global-dir", gdir], repo2, [fakeAdapter(repo2)]);
    expect(out3).toContain("# mode: partner-led (global config)");
  });

  test("fleet run without a TTY refuses with the existing clear message", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    await withoutTTY(async () => {
      const res = await fleet([], repo, [fakeAdapter(repo)]);
      expect(res).toEqual({
        out: "tickmarkr fleet: interactive fleet editor requires a TTY — use `tickmarkr fleet --print` for non-interactive output",
        code: 1,
      });
    });
  });

  test("the down arrow moves the cursor to the next row and the up arrow moves it back", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.down + KEYS.up + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(pointerLine(writes[2])).toContain("fake-1");
    expect(pointerLine(writes[3])).toContain("fake-2");
    expect(pointerLine(writes[4])).toContain("fake-1");
  });

  test("the j key moves the cursor down and the k key moves it up", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.j + KEYS.k + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(pointerLine(writes[2])).toContain("fake-1");
    expect(pointerLine(writes[3])).toContain("fake-2");
    expect(pointerLine(writes[4])).toContain("fake-1");
  });

  test("the space key toggles the highlighted adapter between active and inactive", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.space + KEYS.space + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(strip(writes[1])).toContain(`${GLYPHS.toggleActive} fake`);
    expect(strip(writes[2])).toContain(`${GLYPHS.toggleInactive} fake`);
    expect(strip(writes[3])).toContain(`${GLYPHS.toggleActive} fake`);
  });

  test("the space key toggles deny on the highlighted model", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.space + KEYS.space + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(strip(writes[2])).toContain(`${GLYPHS.toggleActive} fake-1  mid  allowed`);
    expect(strip(writes[3])).toContain(`${GLYPHS.toggleInactive} fake-1  mid  denied`);
    expect(strip(writes[4])).toContain(`${GLYPHS.toggleActive} fake-1  mid  allowed`);
  });

  test("every screen renders a step title naming the step number and the step name", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: no overlay changes (empty diff)");
    const all = strip(writes.join(""));
    expect(all).toContain("step 1/6 · probe data");
    expect(all).toContain("step 2/6 · agent CLIs");
    expect(all).toContain("step 3/6 · models");
    expect(all).toContain("step 4/6 · routing mode");
    expect(all).toContain("step 5/6 · shape routing");
    expect(all).toContain("step 6/6 · steering");
  });

  test("escape aborts the editor without writing the overlay", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.space + KEYS.escape);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("the q key aborts the editor without writing the overlay", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.space + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("pressing enter through every screen yields an empty diff and writes nothing", async () => {
    const { repo, adapter } = setup();
    const doctorPath = join(tickmarkrDir(repo), "doctor.json");
    const doctorBefore = readFileSync(doctorPath, "utf8");
    const mtimeBefore = statSync(doctorPath).mtimeMs;
    const overlayBefore = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: no overlay changes (empty diff)");
    expect(readFileSync(doctorPath, "utf8")).toBe(doctorBefore);
    expect(statSync(doctorPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(overlayBefore);
    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  test("a toggle is written to the overlay only after the diff is confirmed", async () => {
    const { repo, adapter } = setup();
    const overlayPath = join(repo, ".tickmarkr", "config.yaml");
    const before = readFileSync(overlayPath, "utf8");
    const bytes = KEYS.enter + KEYS.enter + KEYS.space + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter;

    queueAnswers("n");
    const declined = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(declined).toBe("fleet: discarded overlay changes");
    expect(readFileSync(overlayPath, "utf8")).toBe(before);

    queueAnswers("y");
    const accepted = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(accepted).toMatch(/^fleet: wrote /);
    const after = readFileSync(overlayPath, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("fake:fake-1");
  });

  test("assigning a tier to an unclassified model still requires a typed provenance note", async () => {
    const { repo, adapter } = setup();
    queueAnswers("cheap", "");
    const missing = await drive(repo, adapter, makeIO().io, KEYS.enter + KEYS.enter + KEYS.down + KEYS.t);
    expect(missing).toEqual({
      out: "fleet: assigning a tier to an unclassified model requires a typed benchmark-provenance note",
      code: 1,
    });

    queueAnswers("mid", "AA Index 54, SWE-bench Pro 62%", "y");
    const ok = await drive(
      repo,
      adapter,
      makeIO().io,
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter,
      ["--global-dir", isolatedGlobal()],
    );
    expect(ok).toMatch(/^fleet: wrote /);
    const overlay = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    expect(overlay).toContain("fake-2: mid");
    expect(overlay).toContain("AA Index 54, SWE-bench Pro 62%");
  });

  // v1.52 T5: routing.floors is the only band authority now — the shape-routing screen (step 5/6)
  // no longer exposes a 't' tier-editing action (unlike step 3/6's model-classification 't', which stays).
  test("fleet exposes no map tier editing action", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.t + KEYS.enter + KEYS.enter,
      ["--global-dir", isolatedGlobal()],
    );
    // 't' at the shape-routing screen is unhandled — nothing changed, so the confirm never fires
    expect(out).toBe("fleet: no overlay changes (empty diff)");
    const all = strip(writes.join(""));
    const lines = all.split("\n");
    const shapesTitleIdx = lines.findIndex((l) => l.includes("step 5/6 · shape routing"));
    expect(shapesTitleIdx).toBeGreaterThanOrEqual(0);
    // the legend directly under the step 5/6 title — step 3/6's own 't tier' legend is a distinct,
    // still-live action (model classification) and must not be mistaken for this one
    expect(lines[shapesTitleIdx + 1]).toBe("↑↓/jk move · a auto · p pin · f prefer · enter next · esc/q quit");
  });

  test("the terminal raw mode is restored after an abort", async () => {
    const { repo, adapter } = setup();
    const { io, rawCalls } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(rawCalls).toEqual([true, false]);
  });

  test("the highlighted row carries a pointer glyph that appears on no other row", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.q);
    const models = writes[2];
    expect((models.match(/❯/g) ?? []).length).toBe(1);
    expect(pointerLine(models)).toContain("fake-1");
  });

  test("the highlighted row renders with ANSI emphasis and other rows render plain", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.q);
    const lines = writes[2].split("\n").filter((l) => l !== "");
    expect(lines[2]).toContain("❯");
    expect(lines[2]).toContain("\x1b[1m");
    expect(lines[3]).not.toContain("\x1b[1m");
    expect(lines[4]).not.toContain("\x1b[1m");
  });

  test("the step title line renders with ANSI emphasis", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.q);
    expect(writes[0].startsWith("\x1b[1mstep 1/6 · probe data\x1b[0m")).toBe(true);
  });

  test("the key legend line renders dim", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.q);
    const lines = writes[0].split("\n");
    expect(lines[1].startsWith("\x1b[2m")).toBe(true);
    expect(strip(lines[1])).toContain("quit");
  });

  test("real ANSI arrow bytes on a non-injected input stream move the cursor through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "\r\r\x1b[B\x1b[A" + "q");
    expect(out).toBe("fleet: quit without writing");
    expect(pointerLine(writes[3])).toContain("fake-2");
    expect(pointerLine(writes[4])).toContain("fake-1");
  });

  test("j and k bytes on a non-injected input stream move the cursor through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "\r\r" + "jk" + "q");
    expect(out).toBe("fleet: quit without writing");
    expect(pointerLine(writes[3])).toContain("fake-2");
    expect(pointerLine(writes[4])).toContain("fake-1");
  });

  test("space and enter and escape bytes on a non-injected input stream toggle and advance and abort through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "\r \r\r\x1b", ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).toContain(`${GLYPHS.toggleInactive} fake`);
    expect(all).toContain("step 5/6 · shape routing");
  });

  test("characters typed on a list screen are never echoed as text into the output", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + "zZ" + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const all = writes.join("");
    expect(all).not.toContain("z");
    expect(all).not.toContain("Z");
  });

  test("after the editor resolves on abort the input stream is paused and has zero keypress listeners", async () => {
    const { repo, adapter } = setup();
    const { io, input } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  test("after the editor resolves on confirm the input stream is paused and has zero keypress listeners", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const { io, input } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.space + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  test("arrow and space interaction fully replaces number-typed toggles on the membership and models screens", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + "1" + KEYS.enter + "2" + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    // digits are dead keys: no re-render, no toggle
    expect(writes.length).toBe(3);
    expect(strip(writes[1])).toContain(`${GLYPHS.toggleActive} fake`);
    expect(strip(writes[2])).toContain(`${GLYPHS.toggleActive} fake-1  mid  allowed`);
  });

  test("every interactive frame reads like an fzf style list picker — exactly one pointer glyph marks the highlighted row, toggle marks are readable without color, the step title visually dominates the frame, and the key legend is a single dim line", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: no overlay changes (empty diff)");
    expect(writes.length).toBe(6);
    for (const frame of writes) {
      const lines = frame.split("\n").filter((l) => l !== "");
      expect((frame.match(/❯/g) ?? []).length).toBe(1);
      expect(lines[0]).toContain("\x1b[1mstep ");
      const dimLines = lines.filter((l) => l.includes("\x1b[2m"));
      expect(dimLines).toEqual([lines[1]]);
    }
    // membership + models frames keep colorless-readable toggle marks (the ruled glyphs)
    expect(strip(writes[1])).toMatch(new RegExp(`[${GLYPHS.toggleActive}${GLYPHS.toggleInactive}]`));
    expect(strip(writes[2])).toMatch(new RegExp(`[${GLYPHS.toggleActive}${GLYPHS.toggleInactive}]`));
    expect(strip(writes[2])).toContain("( )");
  });

  test("the injected test parser and the production keypress decoder agree on every key the editor handles including j and k", async () => {
    const stream = new PassThrough();
    emitKeypressEvents(stream);
    const decoded: string[] = [];
    stream.on("keypress", (_s: string | undefined, key: { name?: string } | undefined) => {
      decoded.push(key?.name ?? "");
    });
    const order = ["down", "up", "j", "k", "space", "enter", "q", "r", "t", "a", "p", "f", "escape"] as const;
    for (const name of order) stream.write(KEYS[name]);
    // a lone ESC only resolves via node's escape-sequence timeout (500ms)
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(decoded).toEqual(["down", "up", "j", "k", "space", "return", "q", "r", "t", "a", "p", "f", "escape"]);
  });

  test("fleet never mutates doctor state", async () => {
    const { repo, adapter } = setup();
    const doctorPath = join(tickmarkrDir(repo), "doctor.json");
    const before = readFileSync(doctorPath, "utf8");
    const mtimeBefore = statSync(doctorPath).mtimeMs;
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, KEYS.enter + KEYS.enter + KEYS.space + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(readFileSync(doctorPath, "utf8")).toBe(before);
    expect(statSync(doctorPath).mtimeMs).toBe(mtimeBefore);
    expect(existsSync(join(tickmarkrDir(repo), "doctor-overlay.yaml"))).toBe(false);
  });

  test("the editor uses only node builtin modules and adds no new dependency", async () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    expect(src).toContain('from "node:readline"');
    expect(src).toContain('from "node:readline/promises"');
    expect(src).not.toMatch(/from ["'](?!node:|\.{1,2}\/)/);
  });

  test("doctor remains a sensor and fleet is the only config actuator", async () => {
    const doctorSrc = readFileSync(join(import.meta.dirname, "../../src/cli/commands/doctor.ts"), "utf8");
    const fleetSrc = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    expect(doctorSrc).toContain("tickmarkr NEVER applies");
    expect(fleetSrc).toContain("fleet never re-probes");
    expect(fleetSrc).not.toContain("writeDoctor");
    expect(fleetSrc).not.toContain("probeAll");
    expect(fleetSrc).not.toContain("probeModels");
  });

  test("every existing fleet test passes with only bracket toggle literals updated to the ruled glyphs", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).not.toMatch(/\[[x ]\]/);
    expect(all).toContain(GLYPHS.toggleActive);
  });

  test("an allowed row renders the brand tickmark in the fleet frame on a tty", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.enter + KEYS.q);
    expect(writes[1]).toContain(`${toggleActive()} fake`);
  });

  test("a denied row renders a dim circle in the fleet frame on a tty", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.enter + KEYS.space + KEYS.q);
    expect(writes[2]).toContain(`${toggleInactive()} fake`);
  });

  test("the fleet frames contain no ansi escape produced outside brand helpers", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    queueAnswers("n");
    await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.space + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    // brand.ts's only style (SGR, ending in "m") escapes for fleet's tokens: bold (1), dim (2),
    // brand green (38;5;41), reset (0). Cursor-erase control codes (ending in F/J) are a
    // separate redraw mechanism, not brand styling, and are exempt (status.ts hand-rolls the
    // same class of control code for its own screen clears).
    const allowedSgr = new Set(["1", "2", "38;5;41", "0"]);
    for (const chunk of writes) {
      const sgrCodes = [...chunk.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);
      for (const code of sgrCodes) expect(allowedSgr.has(code)).toBe(true);
    }
  });

  // ── v1.51 T4: the routing-mode screen (step 4/6) ──────────────────────────

  test("the fleet mode screen lists three modes with the highlighted row carrying the pointer glyph", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const frame = writes[3]; // frames: 0 probe, 1 CLIs, 2 models, 3 mode
    const plain = strip(frame);
    expect(plain).toContain("step 4/6 · routing mode");
    for (const m of ["partner-led", "risk-based", "staff-led"]) expect(plain).toContain(m);
    // a gloss line per mode
    expect(plain).toContain("every shape frontier · explore off");
    expect(plain).toContain("risk-tiered default floors");
    expect(plain).toContain("implement/refactor one band down · integrity shapes hold frontier");
    // exactly one pointer, on the current (highlighted) mode; the current mode wears the brand tickmark
    expect((frame.match(/❯/g) ?? []).length).toBe(1);
    expect(pointerLine(frame)).toContain("risk-based");
    expect(frame).toContain(toggleActive());
  });

  test("selecting a different mode in fleet previews the resolved floor changes before the diff confirm", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      KEYS.enter + KEYS.enter + KEYS.enter + KEYS.down + KEYS.enter + KEYS.enter + KEYS.enter,
      ["--global-dir", isolatedGlobal()],
    );
    // the down keypress highlights staff-led; the SAME frame previews its floor deltas vs risk-based —
    // rendered before the diff and its typed confirm ever appear
    const preview = strip(writes[4]);
    expect(preview).toContain("floors vs risk-based:");
    expect(preview).toContain("implement: mid → cheap");
    expect(preview).toContain("refactor: mid → cheap");
    expect(preview).toContain("ui: mid → frontier");
    // the selection writes only through the existing diff-confirm flow, as routing.mode
    expect(strip(writes.join(""))).toContain("+routing:");
    expect(strip(writes.join(""))).toContain("+  mode: staff-led");
    expect(out).toMatch(/^fleet: wrote /);
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toContain("mode: staff-led");
  });

  test("quitting on the mode screen writes nothing even after a selection preview", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.down + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("a non-injected input stream drives the mode screen through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    // plain PassThrough, raw ANSI/CR bytes only — node's own emitKeypressEvents is the decoder
    const out = await drive(repo, adapter, io, "\r\r\r" + "\x1b[B" + "q", ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(strip(writes[3])).toContain("step 4/6 · routing mode");
    expect(pointerLine(writes[3])).toContain("risk-based");
    expect(pointerLine(writes[4])).toContain("staff-led");
  });

  // ── v1.52 T2: write-time reload guard ─────────────────────────────────────
  // The provenance note is spliced into the YAML as a hand-rolled comment, so a note carrying a
  // newline injects raw lines into the candidate bytes — a byte-level defect that exists ONLY in
  // the serialized output, never in the editor's in-memory state. The injected line is
  // syntactically valid YAML whose value fails the tier schema, so only the full production
  // loader (parse → merge → schema) can refuse it — yaml.parse alone would pass it.
  const BAD_NOTE = "AA54\n      fake-9: notATier";
  const refuseDrive = (repo: string, adapter: FakeAdapter, io: FleetIO) => {
    queueAnswers("mid", BAD_NOTE, "y");
    return drive(
      repo, adapter, io,
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter,
      ["--global-dir", isolatedGlobal()],
    );
  };

  test("the editor refuses to write an overlay the config loader rejects", async () => {
    const { repo, adapter } = setup();
    const out = await refuseDrive(repo, adapter, makeIO().io);
    expect(out).toMatchObject({ code: 1 });
    expect((out as { out: string }).out).toMatch(/^fleet: refusing to write /);
  });

  test("a refused write leaves the existing overlay file byte-identical", async () => {
    const { repo, adapter } = setup();
    const overlayPath = join(repo, ".tickmarkr", "config.yaml");
    const before = readFileSync(overlayPath, "utf8");
    const out = await refuseDrive(repo, adapter, makeIO().io);
    expect(out).toMatchObject({ code: 1 });
    expect(readFileSync(overlayPath, "utf8")).toBe(before);
  });

  test("the refusal message names the parse failure", async () => {
    const { repo, adapter } = setup();
    const out = (await refuseDrive(repo, adapter, makeIO().io)) as { out: string; code: number };
    expect(out.out).toContain("the config loader rejects the proposed overlay");
    expect(out.out).toContain('expected one of "cheap"|"mid"|"frontier"');
  });

  test("a valid overlay still writes through the diff confirm", async () => {
    const { repo, adapter } = setup();
    const gdir = isolatedGlobal();
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, KEYS.enter + KEYS.enter + KEYS.space + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", gdir]);
    expect(out).toMatch(/^fleet: wrote /);
    // and what it wrote reloads through the same loader the guard used
    expect(() => loadConfig(repo, { globalDir: gdir })).not.toThrow();
  });

  test("the guard validates the exact proposed bytes through the production loader path", async () => {
    const { repo, adapter } = setup();
    const out = (await refuseDrive(repo, adapter, makeIO().io)) as { out: string; code: number };
    // the rejected value carries the serializer's "— fleet" comment splice — an artifact that
    // exists only in the proposed bytes (the editor's in-memory state holds no fake-9 at all),
    // so the bytes themselves were parsed; and the verdict is a schema failure, not a YAML
    // syntax error, so the full production loader judged them — not yaml.parse alone
    expect(out.out).toContain("notATier — fleet");
    expect(out.out).toContain('expected one of "cheap"|"mid"|"frontier"');
  });

  test("the editor process exits after a refused write", async () => {
    const { repo, adapter } = setup();
    const { io, input, rawCalls } = makeIO();
    const out = await refuseDrive(repo, adapter, io);
    expect(out).toMatchObject({ code: 1 });
    // the OBS-70 exit contract on the refusal path: stream paused, zero keypress listeners,
    // raw mode off — nothing keeps the event loop alive, so the real process terminates
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
    expect(rawCalls.at(-1)).toBe(false);
  });

  // ── v1.53 T1: askTyped resumes the input stream after a typed entry (OBS-77) ──
  // Each test drives the flow to a typed entry over node's REAL readline (useRealReadline);
  // rl.close() pauses the injected stream exactly as it pauses process.stdin on a live TTY.

  // drive to step 5/6, open the shape prefer prompt (v1.56: the typed pin entry became the
  // candidate picker, so the OBS-77 coverage rides the surviving `f` typed path), complete the
  // typed entry, and wait for the re-rendered shapes frame (drawn synchronously after the entry —
  // no keypress involved); fleet's promise is returned WRAPPED so awaiting cannot flatten into it
  const completePreferEntry = async (repo: string, adapter: FakeAdapter, io: ReturnType<typeof makeIO>) => {
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.f);
    await settle(() => io.writes.join("").includes("prefer (comma-separated adapters or adapter:model)>"));
    const mark = io.writes.length;
    io.input.write("fake\r");
    await settle(() => io.writes.slice(mark).join("").includes("step 5/6 · shape routing"));
    return { done };
  };

  test("a completed typed entry leaves the input stream flowing", async () => {
    const { repo, adapter } = setup();
    await useRealReadline(1);
    const io = makeIO();
    const { done } = await completePreferEntry(repo, adapter, io);
    expect(io.input.isPaused()).toBe(false);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("a keypress arriving after a completed typed entry still advances the flow", async () => {
    const { repo, adapter } = setup();
    await useRealReadline(1);
    const io = makeIO();
    const { done } = await completePreferEntry(repo, adapter, io);
    // without the resume the paused stream never emits this keypress and fleet never resolves
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("the close path still leaves the input stream paused with zero keypress listeners", async () => {
    const { repo, adapter } = setup();
    await useRealReadline(1);
    const io = makeIO();
    const { done } = await completePreferEntry(repo, adapter, io);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    // the post-entry resume must not break OBS-70's exit contract
    expect(io.input.isPaused()).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  test("the stdin resume regression stays covered on a surviving typed entry path", async () => {
    // OBS-77's original vehicle was the typed pin prompt, removed by the v1.56 picker; the shape
    // prefer prompt is the same askTyped seam over node's REAL readline (rl.close() pauses the
    // stream), so the regression stays pinned on a path that still exists in production.
    const { repo, adapter } = setup();
    await useRealReadline(1);
    const io = makeIO();
    const { done } = await completePreferEntry(repo, adapter, io);
    expect(io.input.isPaused()).toBe(false);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("after any typed entry the fleet flow keeps accepting keys instead of exiting", async () => {
    const { repo, adapter } = setup();
    await useRealReadline(2);
    const { io, input, writes } = makeIO();
    const p = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    // the OBS-77 live repro: classify an unclassified model (t → tier → note), then keep going
    input.write(KEYS.enter + KEYS.enter + KEYS.down + KEYS.t);
    await settle(() => writes.join("").includes("tier (cheap|mid|frontier)>"));
    input.write("mid\r");
    await settle(() => writes.join("").includes("benchmark provenance note (required):"));
    const mark = writes.length;
    input.write("AA Index 54\r");
    await settle(() => writes.slice(mark).join("").includes("step 3/6 · models"));
    input.write(KEYS.enter);
    await settle(() => writes.join("").includes("step 4/6 · routing mode"));
    input.write(KEYS.enter);
    await settle(() => writes.join("").includes("step 5/6 · shape routing"));
    expect(strip(writes.join(""))).toContain("fake-2  mid");
    input.write(KEYS.q);
    expect(await p).toBe("fleet: quit without writing");
  });

  // ── v1.54 T4: the steering screen (step 6/6) — review.prefer + consult.prefer ──
  // five enters walk steps 1-5; the cursor lands on the review row of the steering screen
  const TO_STEER = KEYS.enter.repeat(5);
  const overlayAt = (repo: string) => join(repo, ".tickmarkr", "config.yaml");
  const parsedOverlay = (repo: string) => parse(readFileSync(overlayAt(repo), "utf8")) as Record<string, any>;

  test("a typed review prefer entry lands in the written overlay under review prefer", async () => {
    const { repo, adapter } = setup();
    queueAnswers("codex:gpt-5.6-sol, kimi", "y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).review.prefer).toEqual(["codex:gpt-5.6-sol", "kimi"]);
  });

  test("a typed consult prefer entry lands in the written overlay under consult prefer", async () => {
    const { repo, adapter } = setup();
    queueAnswers("codex:gpt-5.6-sol", "y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.down + KEYS.f + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).consult.prefer).toEqual(["codex:gpt-5.6-sol"]);
  });

  test("clearing a prefer list removes the key from the written overlay", async () => {
    const { repo, adapter } = setup();
    withOverlay(repo, `${FAKE_TIERS}review:
  prefer: [codex]
`);
    queueAnswers("", "y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const written = readFileSync(overlayAt(repo), "utf8");
    expect(written).not.toContain("prefer");
    expect(parsedOverlay(repo).review).toBeUndefined();
  });

  test("existing overlay keys outside the edited lists survive a prefer write", async () => {
    const { repo, adapter } = setup();
    withOverlay(repo, `${FAKE_TIERS}concurrency: 5
review:
  complexityThreshold: 9
`);
    queueAnswers("kimi", "y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const overlay = parsedOverlay(repo);
    expect(overlay.concurrency).toBe(5);
    expect(overlay.review.complexityThreshold).toBe(9);
    expect(overlay.review.prefer).toEqual(["kimi"]);
    expect(overlay.tiers.fake.models["fake-1"]).toBe("mid");
  });

  test("an aborted prefer edit leaves the overlay untouched", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    queueAnswers("codex");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
  });

  // a bare-adapter consult entry serializes into bytes the config loader rejects (consult.prefer
  // entries must be adapter:model) — the live proof that a prefer write passes the reload guard
  test("a consult prefer entry the config loader rejects is refused by the reload guard and never touches disk", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    queueAnswers("kimi", "y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.down + KEYS.f + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatchObject({ code: 1 });
    expect((out as { out: string }).out).toMatch(/^fleet: refusing to write /);
    expect((out as { out: string }).out).toContain("consult.prefer entries must be adapter:model");
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
  });

  // completes a steering typed entry over node's REAL readline (the OBS-77 seam) and waits for
  // the re-rendered steering frame — same shape as completePinEntry above
  const completeSteerEntry = async (repo: string, adapter: FakeAdapter, io: ReturnType<typeof makeIO>) => {
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(TO_STEER + KEYS.f);
    await settle(() => io.writes.join("").includes("review.prefer (comma-separated"));
    const mark = io.writes.length;
    io.input.write("codex\r");
    await settle(() => io.writes.slice(mark).join("").includes("step 6/6 · steering"));
    return { done };
  };

  test("a completed prefer entry returns to keypress input", async () => {
    const { repo, adapter } = setup();
    await useRealReadline(1);
    const io = makeIO();
    const { done } = await completeSteerEntry(repo, adapter, io);
    expect(io.input.isPaused()).toBe(false);
    // the next raw keypress still drives the flow — the decoder loop is live again
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("quitting after a prefer edit releases the input stream", async () => {
    const { repo, adapter } = setup();
    await useRealReadline(1);
    const io = makeIO();
    const { done } = await completeSteerEntry(repo, adapter, io);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    // the OBS-70 exit contract after a steering entry: paused stream, zero keypress listeners
    expect(io.input.isPaused()).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  test("the editor process exits after quitting the mode screen", async () => {
    const { repo, adapter } = setup();
    const { io, input, rawCalls } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    // nothing keeps the event loop alive: stream paused, zero keypress listeners, raw mode off —
    // the OBS-70 exit contract that lets the real process terminate after q on the mode screen
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
    expect(rawCalls.at(-1)).toBe(false);
  });

  // ── v1.56 T2: the per-shape candidate picker replaces typed pin entry ─────
  // The FakeAdapter hard-codes two channels — fake-1 (sub, frontier) and fake-2 (api, frontier) —
  // so docs (floor cheap) auto-routes to fake-1 (marginal cost: sub before api) and a picker pin
  // of fake-2 visibly changes the rendered row. Frames on the walk to the docs row: 0 probe,
  // 1 CLIs, 2 models, 3 mode, 4 shapes(plan), 5-8 shapes after each down (docs is SHAPES[4]),
  // 9 the picker.
  const TO_DOCS = KEYS.enter.repeat(4) + KEYS.down.repeat(4);

  test("pressing p opens the candidate picker for the highlighted shape", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const picker = strip(writes[9]);
    expect(picker).toContain("pick · docs");
    expect(picker).toContain("fake:fake-1");
    expect(picker).toContain("fake:fake-2");
    // the first (highlighted) candidate IS the production route the shape row shows (T1 seam)
    expect(pointerLine(writes[8])).toContain("fake:fake-1");
    expect(pointerLine(writes[9])).toContain("fake:fake-1");
    // the typed pin prompt is gone — p opens no readline interface
    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  test("every picker row shows tier and a cost signal and a why line", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const rows = strip(writes[9]).split("\n").filter((l) => l !== "").slice(2); // title, legend, then candidates
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).toMatch(/\b(cheap|mid|frontier)\b/); // tier
      expect(row).toContain("— floor cheap (config floors), marginal-cost auto (cheapest sufficient tier)"); // why line
    }
    // cost signal is channel economics: flat-rate quota for sub (never $0), rough per-task $ for api
    expect(rows[0]).toContain("fake:fake-1  frontier  sub flat-rate quota");
    expect(rows[1]).toContain("fake:fake-2  frontier  api ~$2.50/task");
  });

  test("picking a candidate writes a pin for that shape into the overlay diff", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const { io, writes, input } = makeIO();
    const out = await drive(
      repo, adapter, io,
      TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.enter + KEYS.enter,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    // the picked candidate lands on the shape row immediately (frame 11 = shapes after the pick)
    expect(pointerLine(writes[11])).toContain("fake:fake-2 (api, frontier)");
    const all = strip(writes.join(""));
    expect(all).toContain("+routing:");
    expect(all).toContain("+    docs:");
    expect(all).toContain("+      pin:");
    expect(all).toContain("via: fake");
    expect(all).toContain("model: fake-2");
    expect(parsedOverlay(repo).routing.map.docs.pin).toEqual({ via: "fake", model: "fake-2" });
    // the pick exit path inherits the OBS-70 close contract
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  test("a picked pin reaches disk only after the diff confirm accepts it", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    const bytes = TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.enter + KEYS.enter;
    queueAnswers("n");
    const declined = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(declined).toBe("fleet: discarded overlay changes");
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
    queueAnswers("y");
    const accepted = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(accepted).toMatch(/^fleet: wrote /);
    expect(readFileSync(overlayAt(repo), "utf8")).toContain("pin:");
  });

  test("escape closes the picker without changing the shape row", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(TO_DOCS + KEYS.p);
    await settle(() => io.writes.join("").includes("pick · docs"));
    const rowBefore = pointerLine(io.writes[8]);
    expect(rowBefore).toContain("fake:fake-1");
    const mark = io.writes.length;
    // a lone ESC resolves via node's escape-sequence timeout (500ms) — settle covers it
    io.input.write(KEYS.escape);
    await settle(() => io.writes.slice(mark).join("").includes("step 5/6 · shape routing"));
    expect(pointerLine(io.writes.at(-1)!)).toBe(rowBefore);
    io.input.write(KEYS.enter + KEYS.enter);
    expect(await done).toBe("fleet: no overlay changes (empty diff)");
    // the escape exit path inherits the OBS-70 close contract
    expect(io.input.isPaused()).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  test("pressing a returns a pinned shape to auto", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.a + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    expect(pointerLine(writes[8])).toContain("fake:fake-1 (sub, frontier)"); // auto before the pin
    expect(pointerLine(writes[11])).toContain("fake:fake-2 (api, frontier)"); // pinned via the picker
    expect(pointerLine(writes[12])).toContain("fake:fake-1 (sub, frontier)"); // a returns the row to auto
  });

  test("aborting from inside the picker releases keypress listeners and pauses the input stream", async () => {
    const { repo, adapter } = setup();
    const { io, input, rawCalls } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
    expect(rawCalls.at(-1)).toBe(false);
  });

  // ── v1.56 T3: cost visibility on the shape screen ─────────────────────────
  // The DEFAULT map pins plan and spec to claude-code:fable, which cannot route in the fake
  // fleet — re-pin them onto fake-1 so all nine shapes route. Auto rows land on fake-1
  // (sub, frontier; marginal cost ranks sub before api), so the sub economics label covers
  // every row, and the api per-task estimate is exercised by pinning fake-2 through the picker.
  const TO_SHAPES = KEYS.enter.repeat(4);
  const setupAllRoutable = () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `${FAKE_TIERS}routing:
  map:
    plan:
      pin: { via: fake, model: fake-1 }
    spec:
      pin: { via: fake, model: fake-1 }
`);
    stampDoctor(repo);
    return { repo, adapter: fakeAdapter(repo) };
  };

  test("every shape row carries a channel economics marker", async () => {
    const { repo, adapter } = setupAllRoutable();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_SHAPES + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const rows = strip(writes[4]).split("\n").filter((l) => l !== "").slice(2); // title, legend, then the 9 shape rows
    expect(rows.length).toBe(9);
    for (const row of rows) expect(row).toMatch(/flat-rate quota|api ~\$|api metered/);
  });

  test("sub channel rows are labeled flat rate quota", async () => {
    const { repo, adapter } = setupAllRoutable();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_SHAPES + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const subRows = strip(writes[4]).split("\n").filter((l) => l.includes("(sub,"));
    expect(subRows.length).toBe(9);
    for (const row of subRows) expect(row).toContain("sub flat-rate quota");
  });

  test("no sub channel row renders a zero dollar amount", async () => {
    const { repo, adapter } = setupAllRoutable();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_SHAPES + KEYS.p + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    // shape rows (frame 4) and picker rows (frame 5): a sub channel is flat-rate quota — it
    // never renders a dollar figure at all, so a fake $0 is structurally impossible
    const shapeSubRows = strip(writes[4]).split("\n").filter((l) => l.includes("(sub,"));
    expect(shapeSubRows.length).toBe(9);
    const pickerSubRows = strip(writes[5]).split("\n").filter((l) => l.includes("fake:fake-1"));
    expect(pickerSubRows.length).toBe(1);
    for (const row of [...shapeSubRows, ...pickerSubRows]) expect(row).not.toContain("$");
  });

  test("an api routed shape shows a rough per task estimate from the pricing table", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    // docs pinned to fake-2 (api, frontier) via the picker — the row carries the default
    // pricing-table frontier per-task estimate ($2.50), same figure the picker row showed
    expect(pointerLine(writes[11])).toContain("fake:fake-2 (api, frontier)  api ~$2.50/task");
  });
});
