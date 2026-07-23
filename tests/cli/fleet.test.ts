import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";

import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { GLYPHS } from "../../src/brand.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { formatFleetPrint, loadConfig, overlayBytesLoadError } from "../../src/config/config.js";
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
  y: "y",
  n: "n",
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

type TestInput = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => TestInput;
  unref: () => TestInput;
};

// plain PassThrough with no inject marker of any kind: the editor decodes whatever raw
// bytes arrive on it through node's own emitKeypressEvents — the production path
const makeIO = () => {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  const rawCalls: boolean[] = [];
  input.setRawMode = (mode: boolean) => {
    rawCalls.push(mode);
  };
  input.ref = () => input;
  input.unref = () => input;
  const directWrite = input.write.bind(input);
  const pendingWrites: string[] = [];
  let pumping = false;
  const pump = () => {
    const chunk = pendingWrites.shift();
    if (chunk === undefined) {
      pumping = false;
      return;
    }
    directWrite(chunk);
    setImmediate(pump);
  };
  // Ink intentionally treats a multi-character write as a paste. Tests model terminal
  // keypresses, so feed one decoded key sequence per event across the Ink-to-legacy handoff.
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pendingWrites.push(...(text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []));
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
    return true;
  }) as typeof input.write;
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 120,
    rows: 60,
    write: (chunk: string) => {
      if (chunk === "" || chunk === "\x1b[?25l" || chunk === "\x1b[?25h") return true;
      if (writes.at(-1) === chunk) return true;
      writes.push(chunk);
      return true;
    },
    // Production output is process.stdout and exposes these listener methods; inert here.
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  const io: FleetIO = { input, output, debug: true };
  return { input, output, writes, rawCalls, io };
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const pointerLine = (frame: string) => strip(frame).split("\n").find((l) => l.includes("❯")) ?? "";
const ioReadlineImports = () => readFileSync(
  join(import.meta.dirname, "../../src/cli/commands/fleet.ts"),
  "utf8",
).match(/from "node:readline(?:\/promises)?"/g) ?? [];

let queuedConfirm: string | undefined;
const drive = (repo: string, adapter: FakeAdapter, io: FleetIO, bytes: string, argv: string[] = []) => {
  const p = fleet(argv, repo, [adapter], io);
  const confirm = queuedConfirm;
  queuedConfirm = undefined;
  io.input!.write(bytes + (confirm ?? ""));
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
  queuedConfirm = answers.find((answer) => /^[yn]/i.test(answer))?.slice(0, 1).toLowerCase();
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
let forceColorBefore: string | undefined;

beforeEach(() => {
  queuedConfirm = undefined;
  stdoutTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  noColorBefore = process.env.NO_COLOR;
  forceColorBefore = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "3";
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (stdoutTTYDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutTTYDescriptor);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (noColorBefore === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColorBefore;
  if (forceColorBefore === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = forceColorBefore;
});

describe("tickmarkr fleet", () => {
  test("print mode output for an unchanged config is byte-identical to the pre-migration output", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const gdir = isolatedGlobal();
    withOverlay(repo, `${FAKE_TIERS}routing:
  deny:
    models: [fake:fake-2]
`);
    const out = await fleet(["--print", "--global-dir", gdir], repo, [fakeAdapter(repo)]);
    expect(out).toContain("# tickmarkr fleet — effective state");
    expect(out).toContain("fake-2");
    expect(ioReadlineImports()).toEqual([]);
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

  test("launching without a terminal prints the existing non-interactive guidance and renders no interactive frame", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const io = makeIO();
    io.input.isTTY = false;
    io.output.isTTY = false;
    await withoutTTY(async () => {
      const res = await fleet([], repo, [fakeAdapter(repo)], io.io);
      expect(res).toEqual({
        out: "tickmarkr fleet: interactive fleet editor requires a TTY — use `tickmarkr fleet --print` for non-interactive output",
        code: 1,
      });
      expect(io.writes).toEqual([]);
    });
  });

  test("the probe screen names the doctor data age and the refresh key re-probes through the same doctor path as before", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.r);
    expect(strip(writes.join(""))).toContain("probe data: 5m old (.tickmarkr/doctor.json)");
    expect(out).toBe("fleet: run `tickmarkr doctor` to refresh probe data, then re-run `tickmarkr fleet` (doctor is the sensor; fleet never re-probes)");
  });

  test("toggling an adapter on the agent screen stages the same deny-list change the pre-migration editor staged", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const out = await drive(
      repo,
      adapter,
      makeIO().io,
      KEYS.enter + KEYS.space + KEYS.enter.repeat(4),
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    expect(parse(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).routing.deny.adapters).toEqual(["fake"]);
  });

  test("the interactive loop renders through the declarative component runtime and no screen in this task hand-writes cursor-movement escape sequences", () => {
    const command = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    const app = readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8");
    const components = readFileSync(join(import.meta.dirname, "../../src/tui/ink/components.tsx"), "utf8");
    expect(command).toContain('await import("../../tui/ink/fleet-app.js")');
    expect(app).toContain('const productionInput = typeof input.ref === "function" && typeof input.unref === "function"');
    expect(app).toContain('input.on("data", onData)');
    expect(app).toContain("stream: stream as unknown as NodeJS.ReadStream");
    for (const src of [app, components]) {
      expect(src).not.toContain("\\x1b");
      expect(src).not.toContain("\\u001b");
      expect(src).not.toContain("\x1b");
    }
  });

  test("raw type-ahead survives component-runtime startup", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    delete (io.input as Partial<TestInput>).ref;
    delete (io.input as Partial<TestInput>).unref;
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    // Bypass makeIO's one-key-at-a-time terminal simulation: injected callers historically
    // wrote a whole key sequence at once, and that compatibility must survive the Ink beachhead.
    PassThrough.prototype.write.call(
      io.input,
      KEYS.enter + KEYS.space + KEYS.enter + KEYS.q,
    );
    const early = await Promise.race([
      done.then((value) => ({ value })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    if (early === null) {
      io.input.write(KEYS.q);
      await done;
    }
    expect(early?.value).toBe("fleet: quit without writing");
    expect(strip(io.writes.join(""))).toContain(`${GLYPHS.toggleInactive} fake`);
  });

  test("the component runtime React types are available with its runtime dependency set", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
    expect(pkg.dependencies["@types/react"]).toBe("^19.2.17");
    expect(pkg.devDependencies["@types/react"]).toBeUndefined();
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
    expect(ioReadlineImports()).toEqual([]);
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
    queueAnswers("y");
    const io = makeIO();
    const ok = await drive(
      repo,
      adapter,
      io.io,
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.down + KEYS.enter
        + KEYS.enter + "AA Index 54, SWE-bench Pro 62%" + KEYS.enter + KEYS.enter.repeat(4),
      ["--global-dir", isolatedGlobal()],
    );
    expect(ok).toMatch(/^fleet: wrote /);
    expect(strip(io.writes.join(""))).toContain("benchmark-provenance note is required");
    const overlay = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    expect(overlay).toContain("fake-2: mid");
    expect(overlay).toContain("AA Index 54, SWE-bench Pro 62%");
  });

  test("a model tier classification is chosen from the three offered bands rather than typed", async () => {
    const { repo, adapter } = setup();
    queueAnswers("mid", "AA Index 54");
    const { io, writes } = makeIO();
    const out = await drive(
      repo,
      adapter,
      io,
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    const rendered = strip(writes.join(""));
    expect(rendered).toContain("pick · tier · fake:fake-2");
    for (const tier of ["cheap", "mid", "frontier"]) expect(rendered).toContain(tier);
    expect(ioReadlineImports()).toEqual([]);
  });

  test("an empty provenance note is re-asked and a corrected note lands on the classified model exactly as before the migration", async () => {
    const gdir = isolatedGlobal();
    const classify = (emptyFirst: boolean) =>
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.down + KEYS.enter
      + (emptyFirst ? KEYS.enter : "")
      + "AA Index 54" + KEYS.enter + KEYS.enter.repeat(4);

    const corrected = setup();
    queueAnswers("y");
    expect(await drive(
      corrected.repo,
      corrected.adapter,
      makeIO().io,
      classify(true),
      ["--global-dir", gdir],
    )).toMatch(/^fleet: wrote /);

    const firstTry = setup();
    queueAnswers("y");
    expect(await drive(
      firstTry.repo,
      firstTry.adapter,
      makeIO().io,
      classify(false),
      ["--global-dir", gdir],
    )).toMatch(/^fleet: wrote /);

    const correctedBytes = readFileSync(join(corrected.repo, ".tickmarkr", "config.yaml"), "utf8");
    expect(correctedBytes).toMatch(/fake-2: mid {2}# AA Index 54 — fleet \d{4}-\d{2}-\d{2}/);
    expect(correctedBytes).toBe(readFileSync(join(firstTry.repo, ".tickmarkr", "config.yaml"), "utf8"));
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
    expect(writes[0]).toMatch(/^\x1b\[1mstep 1\/6 · probe data\x1b\[22m/);
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
    // digits are dead keys: they never toggle. The invariant is the settled toggle STATE, not the frame
    // count — the runtime coalesces a render-timing-dependent number of frames (CI differs from local), so
    // assert by content on the settled frames: the CLIs frame keeps fake ACTIVE and the settled models
    // frame keeps fake-1 ALLOWED (a live digit-toggle would flip these marks).
    await settle(() => strip(writes.at(-1) ?? "").includes(`${GLYPHS.toggleActive} fake-1  mid  allowed`));
    const membership = writes.find((f) => strip(f).includes("step 2/6 · agent CLIs"));
    expect(strip(membership ?? "")).toContain(`${GLYPHS.toggleActive} fake`);
    expect(strip(writes.at(-1)!)).toContain(`${GLYPHS.toggleActive} fake-1  mid  allowed`);
  });

  test("every interactive frame reads like an fzf style list picker — exactly one pointer glyph marks the highlighted row, toggle marks are readable without color, the step title visually dominates the frame, and the key legend is a single dim line", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: no overlay changes (empty diff)");
    // the fzf invariant holds for EVERY complete frame the runtime renders — so assert it per-frame rather
    // than pinning an exact frame count (the runtime coalesces a render-timing-dependent number of frames;
    // CI renders more than local). Any extra coalesced frame is still a complete screen and must comply.
    expect(writes.length).toBeGreaterThanOrEqual(1);
    for (const frame of writes) {
      const lines = frame.split("\n").filter((l) => l !== "");
      expect((frame.match(/❯/g) ?? []).length).toBe(1);
      expect(lines[0]).toContain("\x1b[1mstep ");
      const dimLines = lines.filter((l) => l.includes("\x1b[2m"));
      expect(dimLines).toEqual([lines[1]]);
    }
    // membership + models frames keep colorless-readable toggle marks (the ruled glyphs) — located by
    // screen title, not by a render-timing-dependent frame index.
    const membership = writes.find((f) => strip(f).includes("step 2/6 · agent CLIs"));
    const models = writes.find((f) => strip(f).includes("step 3/6 · models"));
    expect(strip(membership ?? "")).toMatch(new RegExp(`[${GLYPHS.toggleActive}${GLYPHS.toggleInactive}]`));
    expect(strip(models ?? "")).toMatch(new RegExp(`[${GLYPHS.toggleActive}${GLYPHS.toggleInactive}]`));
    expect(strip(models ?? "")).toContain("( )");
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

  test("the fleet command loads the component runtime only on the interactive path", async () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    expect(ioReadlineImports()).toEqual([]);
    expect(src).toContain('await import("../../tui/ink/fleet-app.js")');
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
    expect(writes[1]).toMatch(/\x1b\[38;5;41m✓\x1b\[39m fake/);
  });

  test("a denied row renders a dim circle in the fleet frame on a tty", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.enter + KEYS.space + KEYS.q);
    expect(writes[2]).toMatch(/\x1b\[2m○\x1b\[22m fake/);
  });

  test("the stack reference records the new runtime dependencies with the adoption ruling named as cause", () => {
    const stack = readFileSync(join(import.meta.dirname, "../../docs/codebase/STACK.md"), "utf8");
    expect(stack).toContain("Ink 6.8.0 + React 19.2.8");
    expect(stack).toContain(".planning/rulings/2026-07-22-v172-ink-beachhead.md");
    expect(stack).toContain("The adoption cause is the operator ruling");
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
    expect(strip(frame)).toContain("✓ risk-based");
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

  test("the mode screen previews the same routed mix the production router reports for the selected mode", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo,
      adapter,
      io,
      KEYS.enter + KEYS.enter + KEYS.enter + KEYS.down + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    const preview = strip(writes.join(""));
    expect(preview).toContain("mix: 7 frontier — 7 sub (flat-rate quota) · 2 unroutable");
    expect(readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8"))
      .toContain("modePreview");
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
  // Return submits the component-runtime provenance field, so multiline note injection is no
  // longer reachable through the editor. The byte-level guard remains pinned at its production
  // loader seam for malformed candidate bytes from any future serializer regression.
  const BAD_OVERLAY = `${FAKE_TIERS.replace("fake-1: mid", "fake-1: mid  # AA54")}
      fake-9: notATier
`;

  test("the production reload guard still rejects malformed proposed overlay bytes", () => {
    const { repo } = setup();
    const error = overlayBytesLoadError(repo, BAD_OVERLAY, { globalDir: isolatedGlobal() });
    expect(error).toContain('expected one of "cheap"|"mid"|"frontier"');
  });

  test("valid component-runtime edits still write through the diff confirm", async () => {
    const { repo, adapter } = setup();
    const gdir = isolatedGlobal();
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, KEYS.enter + KEYS.enter + KEYS.space + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter, ["--global-dir", gdir]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(() => loadConfig(repo, { globalDir: gdir })).not.toThrow();
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

  // Shape preferences are an ordered component-runtime picker. Provenance is the only
  // free-text edit; diff confirmation remains inside that same runtime.
  const completeShapePreferPick = async (repo: string, adapter: FakeAdapter, io: ReturnType<typeof makeIO>) => {
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter + KEYS.f);
    await settle(() => io.writes.join("").includes("pick · plan.prefer"));
    const mark = io.writes.length;
    io.input.write(KEYS.space + KEYS.enter);
    await settle(() => io.writes.slice(mark).join("").includes("step 5/6 · shape routing"));
    return { done };
  };

  test("a completed shape preference pick leaves the component input stream flowing", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("a keypress arriving after a shape preference pick still advances the flow", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("the component close path leaves the input stream paused with zero keypress listeners", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    expect(io.input.isPaused()).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  test("shape preferences are picked from discovered routing vocabulary rather than typed", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    expect(strip(io.writes.join(""))).toContain("pick · plan.prefer");
    expect(ioReadlineImports()).toEqual([]);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("after the provenance free-text entry the component flow keeps accepting keys instead of exiting", async () => {
    const { repo, adapter } = setup();
    const { io, input, writes } = makeIO();
    const p = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.down + KEYS.enter);
    await settle(() => writes.join("").includes("benchmark provenance · fake:fake-2"));
    const mark = writes.length;
    input.write("AA Index 54" + KEYS.enter);
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

  // review picker rows for the fake fleet: [fake (bare adapter), fake:fake-1 (seat)] —
  // toggling the seat first then the bare adapter proves selection order IS chain order
  test("picked review prefer entries land in the written overlay in selection order", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const pick = KEYS.down + KEYS.space + KEYS.up + KEYS.space + KEYS.enter;
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + pick + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).review.prefer).toEqual(["fake:fake-1", "fake"]);
  });

  test("a picked consult prefer seat lands in the written overlay under consult prefer", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.down + KEYS.f + KEYS.space + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).consult.prefer).toEqual(["fake:fake-1"]);
  });

  // the root-cause fix for the live bare-adapter consult incident: the consult picker offers
  // adapter:model seats ONLY, so the rejected grammar is unreachable from the editor
  test("the consult picker offers only full adapter-and-model seats while the review picker additionally offers bare adapters", async () => {
    const a = setup();
    const aIO = makeIO();
    await drive(a.repo, a.adapter, aIO.io, TO_STEER + KEYS.down + KEYS.f + KEYS.q, ["--global-dir", isolatedGlobal()]);
    // a picker row is "❯ · <entry>" or "  · <entry>" after strip — anchored so the step-3
    // title "step 3/6 · models · fake" can never false-match a bare-adapter row
    const bareRow = /^(?:❯ | {2})· fake$/m;
    const consultFrame = strip(aIO.writes.join(""));
    expect(consultFrame).toContain("pick · consult.prefer");
    expect(consultFrame).toContain("· fake:fake-1");
    expect(consultFrame).not.toMatch(bareRow);
    const b = setup();
    const bIO = makeIO();
    await drive(b.repo, b.adapter, bIO.io, TO_STEER + KEYS.f + KEYS.q, ["--global-dir", isolatedGlobal()]);
    const reviewFrame = strip(bIO.writes.join(""));
    expect(reviewFrame).toContain("pick · review.prefer");
    expect(reviewFrame).toMatch(bareRow);
    expect(reviewFrame).toContain("· fake:fake-1");
  });

  // a chain entry no longer discoverable ("codex" here — the fake fleet never offers it) stays
  // visible as a picker row so the edit drops it deliberately, never silently
  test("a chain entry no longer discoverable stays visible in the picker and dropping it removes it from the written overlay", async () => {
    const { repo, adapter } = setup();
    withOverlay(repo, `${FAKE_TIERS}review:
  prefer: [codex]
`);
    queueAnswers("y");
    // undiscovered chain entries append after the channel universe, so codex is the LAST row —
    // over-pressing down clamps there without pinning the test to the universe's size
    const pick = KEYS.down.repeat(9) + KEYS.space + KEYS.enter;
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + pick + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const written = readFileSync(overlayAt(repo), "utf8");
    expect(written).not.toContain("prefer");
    expect(parsedOverlay(repo).review).toBeUndefined();
  });

  test("an overlay the config loader rejects returns the operator to the editor with staged edits intact and writes nothing to disk", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    const io = makeIO();
    const reloadGuard = vi.fn(() => "consult.prefer entries must be adapter:model");
    const done = fleet(
      ["--global-dir", isolatedGlobal()],
      repo,
      [adapter],
      { ...io.io, reloadGuard } as FleetIO,
    );
    io.input.write(TO_STEER + KEYS.f + KEYS.space + KEYS.enter + KEYS.enter);
    await settle(() => strip(io.writes.join("")).includes("review · overlay diff"));
    const mark = io.writes.length;
    io.input.write(KEYS.y);
    await settle(() => {
      const rendered = strip(io.writes.slice(mark).join(""));
      return rendered.includes("step 6/6 · steering")
        && rendered.includes("review.prefer  →  fake")
        && rendered.includes("config loader rejects");
    });
    expect(reloadGuard).toHaveBeenCalledOnce();
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
    expect(io.input.isPaused()).toBe(false);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("quitting the editor at any screen leaves the terminal in a usable state with no orphaned input listeners", async () => {
    const cases = [
      KEYS.q,
      KEYS.enter + KEYS.q,
      KEYS.enter.repeat(2) + KEYS.q,
      KEYS.enter.repeat(2) + KEYS.down + KEYS.t + KEYS.q,
      KEYS.enter.repeat(2) + KEYS.down + KEYS.t + KEYS.enter + KEYS.escape,
      KEYS.enter.repeat(3) + KEYS.q,
      KEYS.enter.repeat(4) + KEYS.q,
      TO_DOCS + KEYS.p + KEYS.q,
      KEYS.enter.repeat(4) + KEYS.f + KEYS.q,
      TO_STEER + KEYS.q,
      TO_STEER + KEYS.f + KEYS.q,
      KEYS.enter.repeat(2) + KEYS.space + KEYS.enter.repeat(4) + KEYS.q,
    ];
    for (const bytes of cases) {
      const { repo, adapter } = setup();
      const io = makeIO();
      const out = await drive(repo, adapter, io.io, bytes, ["--global-dir", isolatedGlobal()]);
      expect(out).toBe("fleet: quit without writing");
      expect(io.input.isPaused()).toBe(true);
      expect(io.rawCalls.at(-1)).toBe(false);
      expect(io.input.listenerCount("keypress")).toBe(0);
      expect(io.input.listenerCount("data")).toBe(0);
    }
  });

  test("the write path remains the single diff-confirm plus reload-guard funnel and no component gained its own writer", () => {
    const command = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    const app = readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8");
    expect(command.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(command).toContain("overlayBytesLoadError(");
    expect(app).not.toContain("writeFileSync");
    expect(app).not.toContain('from "node:fs"');
  });

  test("no code path in the fleet command reaches a line-based readline interface any longer", () => {
    const command = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    expect(command).not.toContain('from "node:readline"');
    expect(command).not.toContain('from "node:readline/promises"');
    expect(command).not.toContain("createInterface(");
    expect(command).not.toContain("askTyped(");
    expect(command).not.toContain("openTerm(");
  });

  test("existing overlay keys outside the edited lists survive a prefer write", async () => {
    const { repo, adapter } = setup();
    withOverlay(repo, `${FAKE_TIERS}concurrency: 5
review:
  complexityThreshold: 9
`);
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.space + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const overlay = parsedOverlay(repo);
    expect(overlay.concurrency).toBe(5);
    expect(overlay.review.complexityThreshold).toBe(9);
    expect(overlay.review.prefer).toEqual(["fake"]);
    expect(overlay.tiers.fake.models["fake-1"]).toBe("mid");
  });

  test("an aborted prefer edit leaves the overlay untouched", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    const out = await drive(repo, adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
  });

  // the picker made bad consult bytes unreachable from the editor, so the reload guard's red
  // proof moved to the loader seam itself: bytes the old typed entry could produce must still
  // be rejected, and the exact bytes the picker stages must load clean
  test("the reload guard seam rejects consult prefer bytes whose entries are not adapter:model", () => {
    const { repo } = setup();
    const g = isolatedGlobal();
    const bad = `${FAKE_TIERS}consult:
  prefer: [kimi]
`;
    expect(overlayBytesLoadError(repo, bad, { globalDir: g })).toContain(
      "consult.prefer entries must be adapter:model",
    );
    const good = `${FAKE_TIERS}consult:
  prefer: [fake:fake-1]
`;
    expect(overlayBytesLoadError(repo, good, { globalDir: g })).toBeNull();
  });

  // completes a steering picker apply and waits for the re-rendered steering frame — the picker
  // never leaves keypress mode (no readline hop), so the decoder loop must survive the nesting
  const completeSteerPick = async (repo: string, adapter: FakeAdapter, io: ReturnType<typeof makeIO>) => {
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(TO_STEER + KEYS.f);
    await settle(() => io.writes.join("").includes("pick · review.prefer"));
    const mark = io.writes.length;
    io.input.write(KEYS.space + KEYS.enter);
    await settle(() => io.writes.slice(mark).join("").includes("step 6/6 · steering"));
    return { done };
  };

  test("a completed prefer pick returns to the steering keypress loop", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeSteerPick(repo, adapter, io);
    expect(io.input.isPaused()).toBe(false);
    // the next raw keypress still drives the flow — the decoder loop is live again
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("quitting after a prefer pick releases the input stream", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeSteerPick(repo, adapter, io);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    // the OBS-70 exit contract after a steering edit: paused stream, zero keypress listeners
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
    // the typed pin prompt is gone — p opens no line interface
    expect(ioReadlineImports()).toEqual([]);
  });

  test("every picker row shows tier and a cost signal and a why line", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    // Ink wraps long rows at the terminal width, so assert the two semantic rows after
    // whitespace normalization instead of counting physical output lines.
    const picker = strip(writes[9]).replace(/\s+/g, " ");
    expect(picker.match(/fake:fake-[12]/g)).toEqual(["fake:fake-1", "fake:fake-2"]);
    expect(picker.match(/— floor cheap \(config floors\), marginal-cost auto \(cheapest sufficient tier\)/g)).toHaveLength(2);
    // cost signal is channel economics: flat-rate quota for sub (never $0), rough per-task $ for api
    expect(picker).toContain("fake:fake-1 frontier sub flat-rate quota");
    expect(picker).toContain("fake:fake-2 frontier api ~$2.50/task");
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

  test("a pin staged from the candidate picker lands in the written overlay identically to the pre-migration pin path", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const out = await drive(
      repo,
      adapter,
      makeIO().io,
      TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.enter + KEYS.enter,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).routing.map.docs).toEqual({
      pin: { via: "fake", model: "fake-2" },
    });
    expect(readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8"))
      .toContain("candidatesForShape");
  });

  test("candidate ranking still flows through the shared picker ranking seam rather than a reimplementation inside a component", () => {
    const command = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    const picker = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet-picker.ts"), "utf8");
    const app = readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8");
    expect(command).toContain("shapeCandidates(previewTask(shape)");
    expect(picker).toContain("return rankCandidates(");
    expect(app).not.toContain("rankCandidates(");
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
    await settle(() => strip(io.writes.at(-1) ?? "").includes("pick · docs")); // picker open = TO_DOCS drained
    // capture the settled shape row the picker opened on — the LAST shape-routing frame BEFORE the picker,
    // located by content rather than a fixed frame index (the runtime coalesces a render-timing-dependent
    // number of frames; CI differs from local).
    const shapeFrame = (f: string) => strip(f).includes("step 5/6 · shape routing") && !strip(f).includes("pick · docs");
    const rowBefore = pointerLine(io.writes.filter(shapeFrame).at(-1)!);
    expect(rowBefore).toContain("fake:fake-1");
    // a lone ESC resolves via node's escape-sequence timeout (500ms) — settle covers it
    io.input.write(KEYS.escape);
    // settle until the picker has fully CLOSED — the settled frame is shape routing again and no longer
    // shows the picker. Asserting on io.writes.at(-1) before the close settled caught a pre-close frame.
    await settle(() => shapeFrame(io.writes.at(-1) ?? ""));
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

  // v1.60 T3: previews rank with the picker's exploration setting (noExplore). Seed a profile where
  // exploration WOULD divert the pick: docs gets a two-entry prefer so fake-1 and fake-2 sit in
  // separate prefer groups (the ROUTE-17 rep-bonus key fires ACROSS groups; within one group the
  // sub-vs-api cost key would decide first and no probe could ever flip it). fake-1 is warm past
  // EXPLORE_CAP (bonus 0, positive learned score); fake-2 has one dispatch (probe due, bonus 0.8,
  // cold score 0). Exploration-live routing picks the fake-2 probe; noExplore picks fake-1 — so a
  // row ranked with exploration on would disagree with the picker's rank-1.
  test("a step-4 or step-5 preview row's routed candidate always matches the candidate picker's rank-1 result for the same shape and channel set", async () => {
    const { repo, adapter } = setup();
    withOverlay(repo, `${FAKE_TIERS}routing:
  map:
    docs:
      prefer: [fake:fake-1, fake:fake-2]
`);
    const runDir = join(tickmarkrDir(repo), "runs", "run-20260701-000000");
    mkdirSync(runDir, { recursive: true });
    const row = (model: string, channel: string) =>
      JSON.stringify({ taskId: "T1", shape: "docs", adapter: "fake", model, channel, attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0 });
    writeFileSync(join(runDir, "telemetry.jsonl"), [...Array(6).fill(row("fake-1", "sub")), row("fake-2", "api")].join("\n") + "\n");
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const rowRouted = /fake:fake-\d/.exec(pointerLine(writes[8]))?.[0]; // step-5 docs row
    const rank1 = /fake:fake-\d/.exec(pointerLine(writes[9]))?.[0]; // picker cursor starts on rank-1
    expect(rank1).toBe("fake:fake-1"); // the warm incumbent — never the due exploration probe
    expect(rowRouted).toBe(rank1);
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

  // ── OBS-88: provenance notes survive fleet writes ─────────────────────────
  // yaml.parse discards comments, so the write path used to know only the current session's own
  // notes — the next fleet write of any kind silently stripped every prior # note. The session now
  // harvests existing notes from the overlay bytes at load and re-attaches them on write.
  const NOTE = "SWE-bench Pro 62.1 — fleet 2026-07-18";
  const NOTED_TIERS = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid  # ${NOTE}
`;
  const setupNoted = (extra = "") => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, NOTED_TIERS + extra);
    stampDoctor(repo);
    return { repo, adapter: fakeAdapter(repo) };
  };
  const MODE_ONLY_WRITE = KEYS.enter.repeat(3) + KEYS.down + KEYS.enter + KEYS.enter + KEYS.enter;

  test("a provenance note attached to one model tier survives a fleet write that only changes a different model's tier", async () => {
    const { repo, adapter } = setupNoted();
    queueAnswers("y");
    const out = await drive(
      repo, adapter, makeIO().io,
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.enter
        + "AA Index 54" + KEYS.enter + KEYS.enter.repeat(4),
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    const written = readFileSync(overlayAt(repo), "utf8");
    expect(written).toContain(`fake-1: mid  # ${NOTE}`); // the untouched note, byte-for-byte
    expect(written).toMatch(/fake-2: cheap {2}# AA Index 54 — fleet \d{4}-\d{2}-\d{2}/); // fresh note stamped
    expect(parsedOverlay(repo).tiers.fake.models).toMatchObject({ "fake-1": "mid", "fake-2": "cheap" });
  });

  test("a provenance note attached to one model tier survives a fleet write that only changes routing mode or steering preferences", async () => {
    // a mode-only write
    const a = setupNoted();
    queueAnswers("y");
    expect(await drive(a.repo, a.adapter, makeIO().io, MODE_ONLY_WRITE, ["--global-dir", isolatedGlobal()])).toMatch(/^fleet: wrote /);
    const afterMode = readFileSync(overlayAt(a.repo), "utf8");
    expect(afterMode).toContain("mode: staff-led");
    expect(afterMode).toContain(`fake-1: mid  # ${NOTE}`);
    // a steering-only write (picker: toggle the bare fake adapter, apply, next, confirm)
    const b = setupNoted();
    queueAnswers("y");
    expect(await drive(b.repo, b.adapter, makeIO().io, TO_STEER + KEYS.f + KEYS.space + KEYS.enter + KEYS.enter, ["--global-dir", isolatedGlobal()])).toMatch(/^fleet: wrote /);
    const afterSteer = readFileSync(overlayAt(b.repo), "utf8");
    expect(parsedOverlay(b.repo).review.prefer).toEqual(["fake"]);
    expect(afterSteer).toContain(`fake-1: mid  # ${NOTE}`);
  });

  test("a repo overlay with no existing provenance comments loads a fleet session with no provenance data and writes no spurious notes", async () => {
    const { repo, adapter } = setup(); // FAKE_TIERS carries no comments
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, MODE_ONLY_WRITE, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const written = readFileSync(overlayAt(repo), "utf8");
    expect(written).toContain("mode: staff-led");
    expect(written).toMatch(/^ {6}fake-1: mid$/m); // the tier line exactly, no comment appended
    expect(written).not.toContain("#"); // no spurious notes anywhere
  });

  test("an operator's hand-written deny reason or benchmark note is never silently dropped by a fleet edit that never touched it", async () => {
    const { repo, adapter } = setupNoted(`routing:
  deny:
    models:
      - fake:fake-2  # burned quota — re-enable in August
`);
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, MODE_ONLY_WRITE, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const written = readFileSync(overlayAt(repo), "utf8");
    expect(written).toContain("- fake:fake-2  # burned quota — re-enable in August"); // hand-written deny reason
    expect(written).toContain(`fake-1: mid  # ${NOTE}`); // benchmark note
    expect(parsedOverlay(repo).routing.deny.models).toEqual(["fake:fake-2"]); // comments never change the data
  });

  // Step 3 now makes an invalid tier structurally unreachable; the remaining input mistake is
  // an empty provenance submission, which keeps every staged edit and re-asks in place.
  const TO_MISTAKE = KEYS.enter + KEYS.enter + KEYS.space + KEYS.down + KEYS.t;
  const THROUGH_REVIEW = KEYS.enter + KEYS.enter + KEYS.enter + KEYS.enter; // leave steps 3-6 to the diff confirm

  test("an empty provenance note at step 3 re-prompts the provenance field and keeps every other in-session edit intact", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    queueAnswers("y");
    const bytes = TO_MISTAKE + KEYS.down + KEYS.enter + KEYS.enter
      + "AA Index 54" + KEYS.enter + THROUGH_REVIEW;
    const out = await drive(repo, adapter, io.io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(strip(io.writes.join(""))).toContain("benchmark-provenance note is required");
    const overlay = parsedOverlay(repo);
    expect(overlay.routing.deny.models).toEqual(["fake:fake-1"]);
    expect(overlay.tiers.fake.models["fake-2"]).toBe("mid");
    expect(readFileSync(overlayAt(repo), "utf8")).toMatch(/fake-2: mid {2}# AA Index 54 — fleet \d{4}-\d{2}-\d{2}/);
  });

  test("a corrected entry after a re-prompt applies the tier assignment exactly as if it had been entered correctly the first time", async () => {
    const gdir = isolatedGlobal();
    const classify = (emptyFirst: boolean) =>
      KEYS.enter + KEYS.enter + KEYS.down + KEYS.t + KEYS.down + KEYS.enter
      + (emptyFirst ? KEYS.enter : "") + "AA Index 54" + KEYS.enter + THROUGH_REVIEW;
    const a = setup();
    queueAnswers("y");
    expect(await drive(a.repo, a.adapter, makeIO().io, classify(true), ["--global-dir", gdir])).toMatch(/^fleet: wrote /);
    const b = setup();
    queueAnswers("y");
    expect(await drive(b.repo, b.adapter, makeIO().io, classify(false), ["--global-dir", gdir])).toMatch(/^fleet: wrote /);
    expect(readFileSync(overlayAt(a.repo), "utf8")).toBe(readFileSync(overlayAt(b.repo), "utf8"));
  });

  test("no step-3 input mistake can any longer discard an operator's in-session fleet edits before the review screen is reached", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    const io = makeIO();
    queueAnswers("n");
    const out = await drive(
      repo, adapter, io.io,
      KEYS.enter + KEYS.enter + KEYS.space + KEYS.t + KEYS.down + KEYS.t
        + KEYS.down + KEYS.down + KEYS.enter + KEYS.enter
        + "AA Index 54" + KEYS.enter + THROUGH_REVIEW,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: discarded overlay changes");
    const all = strip(io.writes.join(""));
    // t on a classified row renders the inline notice and the session stays alive
    expect(all).toContain("tier reassignment on classified models is not supported in v1");
    expect(all).toContain("fake:fake-1"); // the deny edit reached the review diff
    expect(all).toContain("fake-2: frontier"); // and so did the corrected classification
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
  });
});
