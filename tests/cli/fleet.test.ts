import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";

import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { retiredModelReason } from "../../src/adapters/model-lints.js";
import { GLYPHS } from "../../src/brand.js";
import { assembleFleetEditor, fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
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
  left: "\x1b[D",
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
  w: "w",
  m: "m",
  s: "s",
  y: "y",
  n: "n",
  backspace: "\x7f",
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
// the cursor's path through a run: one entry per distinct pointer row, in frame order
const pointerSeq = (writes: string[]) => {
  const seq: string[] = [];
  for (const frame of writes) {
    const line = pointerLine(frame);
    if (line !== "" && line !== seq.at(-1)) seq.push(line);
  }
  return seq;
};
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
  // ── v1.92 browser navigation: the rail (left pane) lists All models(0) · Shapes(1) ·
  // Steering(2) · one row per installed adapter (fake = 3). ← focuses the rail, Enter opens
  // the row's view (an adapter row scopes the models list), Space on an adapter row denies it.
  const RAIL = KEYS.left;
  // v1.92: the FIRST Shapes entry per session auto-raises the presets overlay (fleet scoping
  // first — membership before routing); the trailing Esc lands in the shapes list beneath it.
  const OPEN_SHAPES = RAIL + KEYS.down + KEYS.enter + KEYS.escape;
  const OPEN_STEER = RAIL + KEYS.down.repeat(2) + KEYS.enter;
  const SCOPE_FAKE = RAIL + KEYS.down.repeat(3) + KEYS.enter;
  // shapes list order is SHAPES order: plan spec implement tests docs … — docs is row 4
  const TO_DOCS = OPEN_SHAPES + KEYS.down.repeat(4);
  const overlayAt = (repo: string) => join(repo, ".tickmarkr", "config.yaml");
  const parsedOverlay = (repo: string) => parse(readFileSync(overlayAt(repo), "utf8")) as Record<string, any>;

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

  test("print output renders the review steering preferences when the loaded config declares them", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const gdir = isolatedGlobal();
    withOverlay(repo, `${FAKE_TIERS}review:
  prefer: [fake:fake-1, fake]
`);

    const out = await fleet(["--print", "--global-dir", gdir], repo, [fakeAdapter(repo)]);

    expect(out).toContain(`review:
  prefer: ["fake:fake-1","fake"]
`);
  });

  test("print output renders the consult steering preferences when the loaded config declares them", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const gdir = isolatedGlobal();
    withOverlay(repo, `${FAKE_TIERS}consult:
  prefer: [fake:fake-1]
`);

    const out = await fleet(["--print", "--global-dir", gdir], repo, [fakeAdapter(repo)]);

    expect(out).toContain(`consult:
  prefer: ["fake:fake-1"]
`);
  });

  test("a config declaring no steering renders no empty steering block", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const gdir = isolatedGlobal();
    withOverlay(repo, FAKE_TIERS);

    const out = await fleet(["--print", "--global-dir", gdir], repo, [fakeAdapter(repo)]);

    expect(out).not.toContain("\nreview:\n");
    expect(out).not.toContain("\nconsult:\n");
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

  test("the header names the doctor data age and the refresh key exits pointing at fleet --fresh", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.r);
    expect(strip(writes.join(""))).toContain("probe 5m old");
    expect(out).toBe("fleet: probe refresh requested — re-run `tickmarkr fleet --fresh` (doctor is the sensor; the editor itself never re-probes)");
  });

  // ── OBS-528: a stale cache (or --fresh) runs the sensor up front, then the editor opens ──
  test("a stale probe cache no longer refuses the interactive editor — fleet runs doctor first and opens on what it recorded", async () => {
    const { repo, adapter } = setup();
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), stale, stale);
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).toContain("tickmarkr fleet"); // the editor DID open
    expect(all).toContain("probe 0m old"); // …on the probe fleet just ran, not the stale cache
  });

  test("--fresh forces the probe even when the cache is fresh", async () => {
    const { repo, adapter } = setup(); // stampDoctor: 5m old — inside the reuse TTL
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.q, ["--fresh", "--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(strip(writes.join(""))).toContain("probe 0m old"); // re-probed despite the fresh cache
  });

  test("taking an adapter out of the fleet on the rail stages the fail-closed membership write", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const out = await drive(
      repo,
      adapter,
      makeIO().io,
      RAIL + KEYS.down.repeat(3) + KEYS.space + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    const routing = parse(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).routing;
    // whole fleet out: allow stays present but EMPTY (fail-closed, nothing admitted) and the
    // legacy deny scopes are null-tombstoned so no lower layer re-excludes behind the operator
    expect(routing.allow).toEqual({});
    expect(routing.deny).toEqual({ adapters: null, models: null });
  });

  test("the interactive loop renders through the declarative component runtime and no surface in this task hand-writes cursor-movement escape sequences", () => {
    const command = readFileSync(join(import.meta.dirname, "../../src/cli/commands/fleet.ts"), "utf8");
    const app = readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8");
    const frame = readFileSync(join(import.meta.dirname, "../../src/tui/ink/frame.tsx"), "utf8");
    const components = readFileSync(join(import.meta.dirname, "../../src/tui/ink/components.tsx"), "utf8");
    expect(command).toContain('await import("../../tui/ink/fleet-app.js")');
    // the ink stream bridges hoisted into frame.tsx keep the production input path
    expect(frame).toContain('typeof input.ref === "function" && typeof input.unref === "function"');
    expect(frame).toContain('input.on("data", onData)');
    expect(frame).toContain("stream: stream as unknown as NodeJS.ReadStream");
    for (const src of [app, frame, components]) {
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
      // the staged toggle arms the quit guard — the second q in the same chunk confirms it
      RAIL + KEYS.down.repeat(3) + KEYS.space + KEYS.q + KEYS.q,
    );
    const early = await Promise.race([
      done.then((value) => ({ value })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    if (early === null) {
      io.input.write(KEYS.q + KEYS.q);
    }
    expect(await done).toBe("fleet: quit without writing");
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
    const out = await drive(repo, adapter, io, KEYS.down + KEYS.up + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const seq = pointerSeq(writes);
    expect(seq[0]).toContain("fake/fake-1");
    expect(seq[1]).toContain("fake/fake-2");
    expect(seq[2]).toContain("fake/fake-1");
  });

  test("the j key moves the cursor down and the k key moves it up", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    // list focus: j/k move whenever search mode is off — same as the old wizard
    const out = await drive(repo, adapter, io, KEYS.j + KEYS.k + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const seq = pointerSeq(writes);
    expect(seq[0]).toContain("fake/fake-1");
    expect(seq[1]).toContain("fake/fake-2");
    expect(seq[2]).toContain("fake/fake-1");
    // and the rail understands them too
    const rail = makeIO();
    expect(await drive(repo, adapter, rail.io, RAIL + KEYS.j + KEYS.q)).toBe("fleet: quit without writing");
    expect(pointerSeq(rail.writes).some((l) => l.includes("Shapes"))).toBe(true);
  });

  test("the space key toggles the highlighted rail adapter between active and inactive", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, RAIL + KEYS.down.repeat(3) + KEYS.space + KEYS.space + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const frames = writes.map(strip);
    const denied = frames.findIndex((f) => f.includes(`${GLYPHS.toggleInactive} fake`));
    expect(denied).toBeGreaterThan(-1);
    expect(frames.slice(denied + 1).some((f) => f.includes(`${GLYPHS.toggleActive} fake`))).toBe(true);
  });

  test("the space key toggles deny on the highlighted model", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.space + KEYS.space + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const frames = writes.map(strip);
    expect(frames[0]).toContain(`${GLYPHS.toggleActive} fake/fake-1`);
    const denied = frames.findIndex((f) => f.includes(`${GLYPHS.toggleInactive} fake/fake-1`));
    expect(denied).toBeGreaterThan(0);
    expect(frames.slice(denied + 1).some((f) => f.includes(`${GLYPHS.toggleActive} fake/fake-1`))).toBe(true);
  });

  test("every browser view renders its list header and the frame header names the probe age and mode", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      OPEN_SHAPES + RAIL + KEYS.down + KEYS.enter + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).toContain("tickmarkr fleet");
    expect(all).toContain("probe 5m old");
    expect(all).toContain("mode risk-based");
    expect(all).toContain("All models");
    expect(all).toContain("Shapes  routed under risk-based");
    expect(all).toContain("Steering  review · consult · judge");
  });

  test("escape aborts the editor without writing the overlay — a staged edit takes a second Esc and the first names the loss", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.space + KEYS.escape + KEYS.escape);
    expect(out).toBe("fleet: quit without writing");
    // OBS-521: the first Esc warns instead of silently discarding the staged toggle
    expect(strip(writes.join(""))).toContain("staged edit(s) not written");
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("the q key aborts the editor without writing the overlay — a staged edit takes a second q", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.space + KEYS.q + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("w on an untouched browser says nothing is staged and stays open instead of exiting", async () => {
    const { repo, adapter } = setup();
    const doctorPath = join(tickmarkrDir(repo), "doctor.json");
    const doctorBefore = readFileSync(doctorPath, "utf8");
    const mtimeBefore = statSync(doctorPath).mtimeMs;
    const overlayBefore = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io, writes } = makeIO();
    // OBS-522: the save key never doubles as quit — q (with nothing staged) exits immediately
    const out = await drive(repo, adapter, io, KEYS.w + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(strip(writes.join(""))).toContain("no staged edits — nothing to write");
    expect(readFileSync(doctorPath, "utf8")).toBe(doctorBefore);
    expect(statSync(doctorPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(overlayBefore);
    expect(ioReadlineImports()).toEqual([]);
  });

  test("a toggle is written to the overlay only after the diff is confirmed", async () => {
    const { repo, adapter } = setup();
    const overlayPath = join(repo, ".tickmarkr", "config.yaml");
    const before = readFileSync(overlayPath, "utf8");
    const bytes = KEYS.space + KEYS.w;

    queueAnswers("n");
    const declined = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(declined).toBe("fleet: discarded overlay changes");
    expect(readFileSync(overlayPath, "utf8")).toBe(before);

    queueAnswers("y");
    const accepted = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(accepted).toMatch(/^fleet: wrote /);
    const after = readFileSync(overlayPath, "utf8");
    expect(after).not.toBe(before);
    // fake-1 out of the served two-channel universe (fake-1 sub, fake-2 api) — partial-adapter allow form
    expect(parse(after).routing.allow).toEqual({ models: ["fake:fake-2"] });
  });

  test("assigning a tier to an unclassified model still requires a typed provenance note", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const io = makeIO();
    const ok = await drive(
      repo,
      adapter,
      io.io,
      KEYS.down + KEYS.t + KEYS.down + KEYS.enter
        + KEYS.enter + "AA Index 54, SWE-bench Pro 62%" + KEYS.enter + KEYS.w,
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
    const { io, writes } = makeIO();
    const out = await drive(
      repo,
      adapter,
      io,
      KEYS.down + KEYS.t + KEYS.escape + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    const rendered = strip(writes.join(""));
    expect(rendered).toContain("classify · fake:fake-2");
    for (const tier of ["cheap", "mid", "frontier"]) expect(rendered).toContain(tier);
    expect(ioReadlineImports()).toEqual([]);
  });

  test("an empty provenance note is re-asked and a corrected note lands on the classified model exactly as before the migration", async () => {
    const gdir = isolatedGlobal();
    const classify = (emptyFirst: boolean) =>
      KEYS.down + KEYS.t + KEYS.down + KEYS.enter
      + (emptyFirst ? KEYS.enter : "")
      + "AA Index 54" + KEYS.enter + KEYS.w;

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

  // v1.52 T5: routing.floors is the only band authority now — the Shapes view exposes no 't'
  // tier-editing action (unlike the models view's classification 't', which stays).
  test("fleet exposes no map tier editing action", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      OPEN_SHAPES + KEYS.t + KEYS.w + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    // 't' on the Shapes view is unhandled — nothing changed, so w stays put and q quits clean
    expect(out).toBe("fleet: quit without writing");
    const shapesFrame = writes.map(strip).find((f) => f.includes("Shapes  routed under"));
    expect(shapesFrame).toBeDefined();
    const keybar = shapesFrame!.split("\n").filter((l) => l.trim() !== "").at(-1)!;
    expect(keybar).toContain("a auto");
    expect(keybar).not.toContain("tier");
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
    await drive(repo, adapter, io, KEYS.q);
    const models = writes[0];
    expect((models.match(/❯/g) ?? []).length).toBe(1);
    expect(pointerLine(models)).toContain("fake/fake-1");
  });

  test("the highlighted row renders with ANSI emphasis and other rows render plain", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.q);
    const lines = writes[0].split("\n").filter((l) => l !== "");
    const selected = lines.find((l) => l.includes("❯") && strip(l).includes("fake/fake-1"));
    expect(selected).toBeDefined();
    expect(selected).toContain("\x1b[1m");
    for (const other of lines.filter((l) => strip(l).includes("fake/fake-2") || strip(l).includes("fake/fake-new"))) {
      expect(other).not.toContain("\x1b[1m");
    }
  });

  test("the frame header line renders with ANSI emphasis", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.q);
    const header = writes[0].split("\n").filter((l) => l !== "")[0];
    expect(header).toContain("\x1b[1m");
    expect(strip(header)).toContain("tickmarkr fleet");
  });

  test("the key legend line renders dim", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.q);
    const lines = writes[0].split("\n").filter((l) => l.trim() !== "");
    const keybar = lines.at(-1)!;
    expect(keybar).toContain("\x1b[2m");
    expect(strip(keybar)).toContain("quit");
  });

  test("real ANSI arrow bytes on a non-injected input stream move the cursor through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "\x1b[B\x1b[A" + "q");
    expect(out).toBe("fleet: quit without writing");
    const seq = pointerSeq(writes);
    expect(seq[0]).toContain("fake/fake-1");
    expect(seq[1]).toContain("fake/fake-2");
    expect(seq[2]).toContain("fake/fake-1");
  });

  test("j and k bytes on a non-injected input stream move the cursor through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "jk" + "q");
    expect(out).toBe("fleet: quit without writing");
    const seq = pointerSeq(writes);
    expect(seq[0]).toContain("fake/fake-1");
    expect(seq[1]).toContain("fake/fake-2");
    expect(seq[2]).toContain("fake/fake-1");
  });

  test("space and enter and escape bytes on a non-injected input stream toggle and navigate and abort through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    // the extra trailing Esc pair: the first Esc dismisses the auto-raised presets overlay on the
    // Shapes entry (v1.92); the staged toggle arms the quit guard so TWO more Esc quit the browser
    const out = await drive(repo, adapter, io, " \x1b[D\x1b[B\r\x1b\x1b\x1b", ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).toContain(`${GLYPHS.toggleInactive} fake/fake-1`);
    expect(all).toContain("Shapes  routed under");
  });

  test("characters typed in / search mode land in the search box and never leak as raw echo", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "/zZ" + KEYS.escape + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const searched = writes.map(strip).find((f) => f.includes("> zZ"));
    expect(searched).toBeDefined();
    // the typed characters exist ONLY in the search row — nowhere else in the frame
    expect(searched!.match(/zZ/g)).toHaveLength(1);
    expect(searched).toContain("no models match");
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
    const out = await drive(repo, adapter, io, KEYS.space + KEYS.w, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
  });

  test("digits typed in / search mode feed the filter and never toggle a row", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, "/2" + KEYS.backspace + KEYS.escape + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    // the typed digit searched rather than toggled: the narrowed frame names the filter, keeps only
    // the matching model, and the backspace restores the full list with fake-1 still allowed
    const searched = writes.map(strip).find((frame) => frame.includes("> 2"));
    expect(searched).toBeDefined();
    expect(searched).toContain("fake/fake-2");
    expect(searched).not.toContain("fake/fake-1");
    const settledFrame = strip(writes.at(-1)!);
    expect(settledFrame).toContain(`${GLYPHS.toggleActive} fake/fake-1`);
    expect(settledFrame).toContain(`${GLYPHS.toggleActive} fake`);
  });

  test("search is an explicit mode: command letters filter inside it, and hotkeys stay live on a committed filter", async () => {
    const { repo, adapter } = setup();
    // direction 1 — first query letter is a hotkey letter: "/m" must search, never open presets
    const first = makeIO();
    const out1 = await drive(repo, adapter, first.io, "/m" + KEYS.escape + KEYS.q);
    expect(out1).toBe("fleet: quit without writing");
    expect(first.writes.map(strip).find((f) => f.includes("> m"))).toBeDefined();
    expect(strip(first.writes.join(""))).not.toContain("routing mode");
    // direction 2 — Enter commits the filter; m must then open presets instead of going dormant
    const second = makeIO();
    const out2 = await drive(repo, adapter, second.io, "/2" + KEYS.enter + "m" + KEYS.escape + KEYS.q);
    expect(out2).toBe("fleet: quit without writing");
    expect(second.writes.map(strip).find((f) => f.includes("routing mode"))).toBeDefined();
  });

  test("every interactive frame reads like an fzf style list picker — exactly one pointer glyph marks the highlighted row, toggle marks are readable without color, the header dominates the frame, and the key legend closes it", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      // the Esc after the first Enter dismisses the auto-raised presets overlay on the Shapes
      // entry (v1.92) so the walk still reaches the Steering view
      KEYS.down + RAIL + KEYS.down + KEYS.enter + KEYS.escape + RAIL + KEYS.down + KEYS.enter + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    // the fzf invariant holds for EVERY complete frame the runtime renders — asserted per-frame
    // rather than pinning an exact frame count (the runtime coalesces render-timing-dependent frames)
    expect(writes.length).toBeGreaterThanOrEqual(1);
    for (const frame of writes) {
      const lines = frame.split("\n").filter((l) => l.trim() !== "");
      expect((frame.match(/❯/g) ?? []).length).toBe(1);
      expect(lines[0]).toContain("\x1b[1m");
      expect(strip(lines[0])).toContain("tickmarkr fleet");
      expect(strip(lines.at(-1)!)).toContain("Esc");
    }
    // models frames keep colorless-readable toggle marks (the ruled glyphs) — located by
    // content, not by a render-timing-dependent frame index.
    const models = writes.map(strip).find((f) => f.includes("fake/fake-1"));
    expect(models).toBeDefined();
    expect(models).toMatch(new RegExp(`[${GLYPHS.toggleActive}${GLYPHS.toggleInactive}]`));
    // v1.90.9: the unclassified glyph is `?`; the remedy/evidence lives in the footer detail band
    expect(models).toContain("? fake/fake-2");
  });

  test("the injected test parser and the production keypress decoder agree on every key the editor handles including j and k", async () => {
    const stream = new PassThrough();
    emitKeypressEvents(stream);
    const decoded: string[] = [];
    stream.on("keypress", (_s: string | undefined, key: { name?: string } | undefined) => {
      decoded.push(key?.name ?? "");
    });
    const order = ["down", "up", "left", "j", "k", "space", "enter", "q", "r", "t", "a", "p", "f", "w", "m", "s", "escape"] as const;
    for (const name of order) stream.write(KEYS[name]);
    // a lone ESC only resolves via node's escape-sequence timeout (500ms)
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(decoded).toEqual(["down", "up", "left", "j", "k", "space", "return", "q", "r", "t", "a", "p", "f", "w", "m", "s", "escape"]);
  });

  test("fleet never mutates doctor state", async () => {
    const { repo, adapter } = setup();
    const doctorPath = join(tickmarkrDir(repo), "doctor.json");
    const before = readFileSync(doctorPath, "utf8");
    const mtimeBefore = statSync(doctorPath).mtimeMs;
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, KEYS.space + KEYS.w, ["--global-dir", isolatedGlobal()]);
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
    const out = await drive(repo, adapter, io, KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).not.toMatch(/\[[x ]\]/);
    expect(all).toContain(GLYPHS.toggleActive);
  });

  test("an allowed row renders the brand tickmark in the fleet frame on a tty", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.q);
    expect(writes[0]).toMatch(/\x1b\[38;5;41m✓\x1b\[39m fake/);
  });

  test("a denied row renders a dim circle in the fleet frame on a tty", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    await drive(repo, adapter, io, KEYS.space + KEYS.q + KEYS.q);
    const denied = writes.find((f) => strip(f).includes("○ fake/fake-1"));
    expect(denied).toBeDefined();
    expect(denied).toMatch(/\x1b\[2m○\x1b\[22m/);
  });

  test("the stack reference records the new runtime dependencies with the adoption ruling named as cause", () => {
    const stack = readFileSync(join(import.meta.dirname, "../../docs/codebase/STACK.md"), "utf8");
    expect(stack).toContain("Ink 6.8.0 + React 19.2.8");
    expect(stack).toContain(".planning/rulings/2026-07-22-v172-ink-beachhead.md");
    expect(stack).toContain("The adoption cause is the operator ruling");
  });

  // ── v1.51 T4 → v1.92: the routing mode moved into the `m` presets overlay ──

  test("the fleet mode overlay lists three modes with the highlighted row carrying the pointer glyph", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.m + KEYS.q + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const frame = writes.find((f) => strip(f).includes("routing mode"))!;
    expect(frame).toBeDefined();
    const plain = strip(frame);
    for (const m of ["partner-led", "risk-based", "staff-led"]) expect(plain).toContain(m);
    // a gloss line per mode
    expect(plain).toContain("every shape frontier · explore off");
    expect(plain).toContain("risk-tiered default floors");
    expect(plain).toContain("implement/refactor one band down · integrity shapes hold frontier");
    // exactly one pointer, on the current (highlighted) mode; the current mode wears the brand tickmark
    expect((frame.match(/❯/g) ?? []).length).toBe(1);
    expect(pointerLine(frame)).toContain("risk-based");
    expect(plain).toContain("✓ risk-based");
  });

  test("selecting a different mode in fleet previews the resolved floor changes before the diff confirm", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const { io, writes } = makeIO();
    const out = await drive(
      repo, adapter, io,
      KEYS.m + KEYS.down + KEYS.enter + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    // the down keypress highlights staff-led; the SAME frame previews its floor deltas vs risk-based —
    // rendered before the diff and its confirm ever appear
    const preview = writes.map(strip).find((f) => f.includes("floors vs risk-based:"))!;
    expect(preview).toBeDefined();
    expect(preview).toContain("implement: mid → cheap");
    expect(preview).toContain("refactor: mid → cheap");
    expect(preview).toContain("ui: mid → frontier");
    // the selection writes only through the existing diff-confirm flow, as routing.mode
    expect(strip(writes.join(""))).toContain("+routing:");
    expect(strip(writes.join(""))).toContain("+  mode: staff-led");
    expect(out).toMatch(/^fleet: wrote /);
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toContain("mode: staff-led");
  });

  test("the mode overlay previews the same routed mix the production router reports for the selected mode", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(
      repo,
      adapter,
      io,
      KEYS.m + KEYS.down + KEYS.escape + KEYS.q,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: quit without writing");
    const preview = strip(writes.join(""));
    expect(preview).toContain("mix: 7 frontier — 7 sub (flat-rate quota) · 2 unroutable");
    expect(readFileSync(join(import.meta.dirname, "../../src/tui/ink/fleet-app.tsx"), "utf8"))
      .toContain("modePreview");
  });

  test("quitting on the mode overlay writes nothing even after a selection preview", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
    const { io } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.m + KEYS.down + KEYS.escape + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  });

  test("a non-injected input stream drives the mode overlay through the production keypress path", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    // plain PassThrough, raw ANSI/CR bytes only — node's own emitKeypressEvents is the decoder
    const out = await drive(repo, adapter, io, "m" + "\x1b[B" + "\x1b" + "q", ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const modeFrames = writes.filter((f) => strip(f).includes("routing mode"));
    expect(modeFrames.length).toBeGreaterThan(0);
    expect(pointerLine(modeFrames[0])).toContain("risk-based");
    expect(pointerLine(modeFrames.at(-1)!)).toContain("staff-led");
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
    const out = await drive(repo, adapter, makeIO().io, KEYS.space + KEYS.w, ["--global-dir", gdir]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(() => loadConfig(repo, { globalDir: gdir })).not.toThrow();
  });

  test("a valid overlay still writes through the diff confirm", async () => {
    const { repo, adapter } = setup();
    const gdir = isolatedGlobal();
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, KEYS.space + KEYS.w, ["--global-dir", gdir]);
    expect(out).toMatch(/^fleet: wrote /);
    // and what it wrote reloads through the same loader the guard used
    expect(() => loadConfig(repo, { globalDir: gdir })).not.toThrow();
  });

  // Shape preferences are an ordered component-runtime picker. Provenance is the only
  // free-text edit; diff confirmation remains inside that same runtime.
  const completeShapePreferPick = async (repo: string, adapter: FakeAdapter, io: ReturnType<typeof makeIO>) => {
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(OPEN_SHAPES + KEYS.f);
    await settle(() => io.writes.join("").includes("edit · plan.prefer"));
    const mark = io.writes.length;
    io.input.write(KEYS.space + KEYS.enter);
    await settle(() => io.writes.slice(mark).join("").includes("Shapes  routed under"));
    return { done };
  };

  test("a completed shape preference pick leaves the component input stream flowing", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("a keypress arriving after a shape preference pick still advances the flow", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("the component close path leaves the input stream paused with zero keypress listeners", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    expect(io.input.isPaused()).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  test("shape preferences are picked from discovered routing vocabulary rather than typed", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeShapePreferPick(repo, adapter, io);
    expect(strip(io.writes.join(""))).toContain("edit · plan.prefer");
    expect(ioReadlineImports()).toEqual([]);
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("after the provenance free-text entry the component flow keeps accepting keys instead of exiting", async () => {
    const { repo, adapter } = setup();
    const { io, input, writes } = makeIO();
    const p = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(KEYS.down + KEYS.t + KEYS.down + KEYS.enter);
    await settle(() => writes.join("").includes("benchmark provenance (required)"));
    const mark = writes.length;
    input.write("AA Index 54" + KEYS.enter);
    await settle(() => writes.slice(mark).join("").includes("All models"));
    // the staged classification renders on the browser row — the flow is alive after free text
    await settle(() => /fake\/fake-2\s+mid/.test(strip(writes.at(-1) ?? "")));
    expect(strip(writes.join(""))).toMatch(/fake\/fake-2\s+mid/);
    input.write(KEYS.q + KEYS.q);
    expect(await p).toBe("fleet: quit without writing");
  });

  // ── v1.54 T4 → v1.92: steering lives in the rail's Steering view — review.prefer ·
  // consult.prefer · judge; f (or Enter) opens the picker for the highlighted row ──

  // review picker rows for the fake fleet: [fake (bare adapter), fake:fake-1, fake:fake-2] —
  // toggling the seat first then the bare adapter proves selection order IS chain order
  test("picked review prefer entries land in the written overlay in selection order", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const pick = KEYS.down + KEYS.space + KEYS.up + KEYS.space + KEYS.enter;
    const out = await drive(repo, adapter, makeIO().io, OPEN_STEER + KEYS.f + pick + KEYS.w, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).review.prefer).toEqual(["fake:fake-1", "fake"]);
  });

  test("a picked consult prefer seat lands in the written overlay under consult prefer", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const out = await drive(repo, adapter, makeIO().io, OPEN_STEER + KEYS.down + KEYS.f + KEYS.space + KEYS.enter + KEYS.w, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).consult.prefer).toEqual(["fake:fake-1"]);
  });

  // OBS-508: catalog evidence drives the classify flow — `s` bulk-stages every visible suggested
  // model for the rail-scoped adapter, and the ONLY writer remains the review-diff confirm.
  // T2/D-2: the band is fleet-relative, so the fixture carries a four-model AA universe
  // (configured opus 63 / sonnet 55 / fake-1 45 plus the unclassified fake-2 at 50) — fake-2 sits
  // in the middle third → mid. fake-new stays uncovered. The two claude records are spelled as
  // models.dev really spells them (`claude-opus-4-8`), NOT as the aliases config carries (`opus`):
  // the aliases reach them only through fleet's resolved-model callback. Drop that callback and
  // the universe is two models, the AA basis yields under the three-model floor, and the
  // rank-3/4 provenance below is gone.
  test("s bulk-stages every visible catalog-suggested model through the review funnel — the written overlay carries the suggested tier with its evidence provenance while uncovered models stay unclassified", async () => {
    const { repo, adapter } = setup();
    writeFileSync(join(repo, ".tickmarkr", "catalog-cache.json"), JSON.stringify({
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      modelsDev: {
        fake: {
          models: {
            "fake-1": { id: "fake-1", cost: { input: 1, output: 5 }, limit: { context: 200000 } },
            "fake-2": { id: "fake-2", cost: { input: 1, output: 5 }, limit: { context: 200000 } },
          },
        },
        anthropic: {
          id: "anthropic",
          models: {
            "claude-opus-4-8": { id: "claude-opus-4-8", cost: { input: 5, output: 25 }, limit: { context: 200000 } },
            "claude-sonnet-5": { id: "claude-sonnet-5", cost: { input: 2, output: 10 }, limit: { context: 200000 } },
          },
        },
      },
      artificialAnalysis: {
        intelligence_index_version: "4.1.1",
        data: [
          { id: "claude-opus-4-8", intelligence_index: 63 },
          { id: "claude-sonnet-5", intelligence_index: 55 },
          { id: "fake-2", intelligence_index: 50 },
          { id: "fake-1", intelligence_index: 45 },
        ],
      },
    }));
    queueAnswers("y");
    const out = await drive(
      repo,
      adapter,
      makeIO().io,
      SCOPE_FAKE + KEYS.s + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    const overlay = parsedOverlay(repo);
    expect(overlay.tiers.fake.models["fake-2"]).toBe("mid");
    expect(overlay.tiers.fake.models["fake-new"]).toBeUndefined();
    const bytes = readFileSync(overlayAt(repo), "utf8");
    expect(bytes).toContain("SUGGESTED mid (intelligence inference, not a measurement)");
    expect(bytes).toContain("fleet-relative rank 3/4 by Artificial Analysis Intelligence Index 50 (intelligence index version 4.1.1)");
    expect(bytes).toContain("operator confirmation required");
    expect(bytes).toMatch(/— fleet \d{4}-\d{2}-\d{2}/);
  });

  // the root-cause fix for the live bare-adapter consult incident: the consult picker offers
  // adapter:model seats ONLY, so the rejected grammar is unreachable from the editor
  test("the consult picker offers only full adapter-and-model seats while the review picker additionally offers bare adapters", async () => {
    // a picker row after strip reads "❯ · <entry>" or "  · <entry>" embedded in the two-pane
    // frame line — the lookahead keeps "· fake:fake-1" from false-matching the bare-adapter row
    const bareRow = /· fake(?![:-])/;
    const a = setup();
    const aIO = makeIO();
    await drive(a.repo, a.adapter, aIO.io, OPEN_STEER + KEYS.down + KEYS.f + "\x03", ["--global-dir", isolatedGlobal()]);
    const consultFrame = strip(aIO.writes.join(""));
    expect(consultFrame).toContain("edit · consult.prefer");
    expect(consultFrame).toContain("· fake:fake-1");
    expect(consultFrame).not.toMatch(bareRow);
    const b = setup();
    const bIO = makeIO();
    await drive(b.repo, b.adapter, bIO.io, OPEN_STEER + KEYS.f + "\x03", ["--global-dir", isolatedGlobal()]);
    const reviewFrame = strip(bIO.writes.join(""));
    expect(reviewFrame).toContain("edit · review.prefer");
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
    const out = await drive(repo, adapter, makeIO().io, OPEN_STEER + KEYS.f + pick + KEYS.w, ["--global-dir", isolatedGlobal()]);
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
    io.input.write(OPEN_STEER + KEYS.f + KEYS.space + KEYS.enter + KEYS.w);
    await settle(() => strip(io.writes.join("")).includes("y writes, n discards"));
    const mark = io.writes.length;
    io.input.write(KEYS.y);
    await settle(() => {
      const rendered = strip(io.writes.slice(mark).join(""));
      return rendered.includes("Steering  review · consult · judge")
        && rendered.includes("review.prefer  →  fake")
        && rendered.includes("config loader rejects");
    });
    expect(reloadGuard).toHaveBeenCalledOnce();
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
    expect(io.input.isPaused()).toBe(false);
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("quitting the editor at any screen leaves the terminal in a usable state with no orphaned input listeners", async () => {
    const cases = [
      KEYS.q,
      RAIL + KEYS.q,
      SCOPE_FAKE + KEYS.q,
      // Esc inside the classification sub-flow CANCELS back to the browser; q then quits from
      // the browser, proving the cancel left no orphaned state between the two.
      KEYS.down + KEYS.t + KEYS.escape + KEYS.q,
      KEYS.down + KEYS.t + KEYS.down + KEYS.enter + KEYS.escape + KEYS.q,
      OPEN_SHAPES + KEYS.q,
      TO_DOCS + KEYS.p + "\x03",
      OPEN_SHAPES + KEYS.f + "\x03",
      OPEN_STEER + KEYS.q,
      OPEN_STEER + KEYS.f + "\x03",
      KEYS.m + KEYS.escape + KEYS.q,
      // q on the review overlay itself quits without writing
      KEYS.space + KEYS.w + KEYS.q,
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
    const out = await drive(repo, adapter, makeIO().io, OPEN_STEER + KEYS.f + KEYS.space + KEYS.enter + KEYS.w, ["--global-dir", isolatedGlobal()]);
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
    const out = await drive(repo, adapter, makeIO().io, OPEN_STEER + KEYS.f + KEYS.escape + KEYS.q, ["--global-dir", isolatedGlobal()]);
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
    io.input.write(OPEN_STEER + KEYS.f);
    await settle(() => io.writes.join("").includes("edit · review.prefer"));
    const mark = io.writes.length;
    io.input.write(KEYS.space + KEYS.enter);
    await settle(() => io.writes.slice(mark).join("").includes("Steering  review · consult · judge"));
    return { done };
  };

  test("a completed prefer pick returns to the steering keypress loop", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeSteerPick(repo, adapter, io);
    expect(io.input.isPaused()).toBe(false);
    // the next raw keypress still drives the flow — the decoder loop is live again
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("quitting after a prefer pick releases the input stream", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await completeSteerPick(repo, adapter, io);
    io.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    // the OBS-70 exit contract after a steering edit: paused stream, zero keypress listeners
    expect(io.input.isPaused()).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  test("the editor process exits after quitting the mode overlay", async () => {
    const { repo, adapter } = setup();
    const { io, input, rawCalls } = makeIO();
    const out = await drive(repo, adapter, io, KEYS.m + KEYS.escape + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    // nothing keeps the event loop alive: stream paused, zero keypress listeners, raw mode off —
    // the OBS-70 exit contract that lets the real process terminate after q on the mode overlay
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("keypress")).toBe(0);
    expect(rawCalls.at(-1)).toBe(false);
  });

  // ── v1.56 T2 → v1.92: the per-shape candidate picker lives on the Shapes view ─────
  // The FakeAdapter hard-codes two channels — fake-1 (sub, frontier) and fake-2 (api, frontier) —
  // so docs (floor cheap) auto-routes to fake-1 (marginal cost: sub before api) and a picker pin
  // of fake-2 visibly changes the rendered row.

  // the docs-row pointer lines across a run, deduped in frame order — the shape row carries
  // padCell("docs", 10), so "docs" identifies it even inside a concatenated two-pane line
  const docsRows = (writes: string[]) => pointerSeq(writes).filter((l) => l.includes("docs"));

  test("pressing p opens the candidate picker for the highlighted shape", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + "\x03", ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const picker = writes.find((f) => strip(f).includes("pin · docs"))!;
    expect(picker).toBeDefined();
    expect(strip(picker)).toContain("fake:fake-1");
    expect(strip(picker)).toContain("fake:fake-2");
    // the first (highlighted) candidate IS the production route the shape row shows (T1 seam)
    expect(docsRows(writes).at(-1)).toContain("fake:fake-1");
    expect(pointerLine(picker)).toContain("fake:fake-1");
    // the typed pin prompt is gone — p opens no line interface
    expect(ioReadlineImports()).toEqual([]);
  });

  test("every picker row shows tier and a cost signal and a why line", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    // down moves the picker cursor to rank-2 so the footer detail names ITS full why line too
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + KEYS.down + "\x03", ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const picker = writes.map(strip).filter((f) => f.includes("pin · docs")).join("\n").replace(/\s+/g, " ");
    // cost signal is channel economics: flat-rate quota for sub (never $0), rough per-task $ for api
    expect(picker).toContain("fake:fake-1 frontier sub flat-rate quota");
    expect(picker).toContain("fake:fake-2 frontier api ~$2.50/task");
    // the why line rides the footer detail band for the focused row (rows clip at pane width)
    expect(picker).toContain("— floor cheap (config floors), marginal-cost auto (cheapest sufficient");
  });

  // OBS-707: a rendered frame does not reach an assertion the instant the editor returns. The
  // runtime coalesces renders on its own schedule, and a host under its own suite's parallel load
  // stretches that arbitrarily — the ancestor of the case below asked the frame stream for the
  // overlay diff at return time and got the header frame (`tickmarkr fleet · probe 5m old · mod…`)
  // on public CI, on the 2.1.2 and 2.1.3 tags. Model the delay explicitly rather than hoping the
  // host supplies one: every frame the editor writes lands on THIS stream a beat after it was
  // written, so an instant read is provably reading the past whatever the host's load. The
  // settled-frame idiom the escape-path case already uses — poll the fact, never the instant — is
  // what survives it. (A shared delayed-frame mode across every frame-asserting suite is CE-1,
  // queued for 2.1.5; this stays local to the enumerated site.)
  //
  // The delay is a GATE this test opens, never a timer a contended host can outrun: a wall-clock
  // arrival window would itself be decided by load — an editor run longer than the window would
  // hand the diff frame over before returning and the instant-read negative control would go
  // green — which is the very defect this case exists to close. Nothing reaches `frames` until
  // release() is called, so the instant read is reading the past by construction, at any load.
  const delayedFrames = (io: FleetIO, writes: string[]) => {
    const frames: string[] = [];
    const held: string[] = [];
    let released = false;
    const inner = io.output!.write.bind(io.output);
    io.output!.write = (chunk: string) => {
      const before = writes.length;
      const kept = inner(chunk);
      // mirror only what the mock itself kept — cursor codes and repeats are not frames
      if (writes.length > before) {
        if (released) setTimeout(() => frames.push(chunk), 0);
        else held.push(chunk);
      }
      return kept;
    };
    // released a beat later, on the runtime's own schedule: the reader still has to poll the fact
    // rather than read an instant, exactly as it must against a host that coalesces renders
    const release = () => {
      released = true;
      const queued = held.splice(0);
      setTimeout(() => frames.push(...queued), 0);
    };
    return { frames, release };
  };

  test("test: a pin picked through the candidate list reaches the rendered overlay diff and the written overlay even where the frames arrive delayed; the same pick asserted on the frame stream as it stands the instant the editor returns fails under that delay", async () => {
    const { repo, adapter } = setup();
    const { io, writes, input } = makeIO();
    const { frames, release } = delayedFrames(io, writes);
    queueAnswers("y");
    const out = await drive(
      repo, adapter, io,
      TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    // the pick reached disk regardless: the mechanism never depended on when a frame arrives
    expect(parsedOverlay(repo).routing.map.docs.pin).toEqual({ via: "fake", model: "fake-2" });
    // demonstrated rather than claimed: the frame stream as it stands the instant the editor
    // returned does not carry the diff, and this is the assertion form that read it there
    expect(() => expect(strip(frames.join(""))).toContain("+routing:")).toThrow();

    // settled: poll the fact until the frames arrive, exactly as the escape-path case does
    release();
    await settle(() => strip(frames.join("")).includes("+      pin:"));
    const all = strip(frames.join(""));
    expect(all).toContain("+routing:");
    expect(all).toContain("+    docs:");
    expect(all).toContain("+      pin:");
    expect(all).toContain("via: fake");
    expect(all).toContain("model: fake-2");
    // the picked candidate lands on the shape row after the pick
    expect(docsRows(frames).some((l) => l.includes("fake:fake-2 (api, frontier)"))).toBe(true);
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
      TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.w,
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
    const bytes = TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.w;
    queueAnswers("n");
    const declined = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(declined).toBe("fleet: discarded overlay changes");
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
    queueAnswers("y");
    const accepted = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(accepted).toMatch(/^fleet: wrote /);
    expect(readFileSync(overlayAt(repo), "utf8")).toContain("pin:");
  });

  test("Space in the candidate picker stages a pool through the poolmode overlay that replaces the shape's pin", async () => {
    const { repo, adapter } = setup();
    // first: pin fake:fake-2 on docs through the picker (row 2 = the api channel)
    queueAnswers("y");
    const pinned = await drive(repo, adapter, makeIO().io, TO_DOCS + KEYS.p + KEYS.down + KEYS.enter + KEYS.w, ["--global-dir", isolatedGlobal()]);
    expect(pinned).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).routing.map.docs.pin).toEqual({ via: "fake", model: "fake-2" });
    // then: pool in REVERSE rank order (row 2 first, row 1 second) — channels are the pick
    // order, never the list order. Enter on the non-empty selection opens the poolmode overlay
    // (down = ordered); the committed pool evicts the pin (schema: pin and pool are one
    // declaration — pin+pool fails config load)
    queueAnswers("y");
    const pooled = await drive(
      repo, adapter, makeIO().io,
      TO_DOCS + KEYS.p + KEYS.down + KEYS.space + KEYS.up + KEYS.space + KEYS.enter
        + KEYS.down + KEYS.enter + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(pooled).toMatch(/^fleet: wrote /);
    expect(parsedOverlay(repo).routing.map.docs.pool).toEqual({ mode: "ordered", channels: ["fake:fake-2", "fake:fake-1"] });
    expect(parsedOverlay(repo).routing.map.docs.pin).toBeUndefined();
  });

  // fake-new is config-classified here so the fleet universe (classified models only) has two
  // members and a partial-adapter membership write is a REAL allow form, never a degenerate
  // empty one; fake-2 keeps riding the FakeAdapter's self-declared frontier/api channel.
  const TWO_CLASSIFIED = `${FAKE_TIERS}      fake-new: cheap\n`;
  const pickerWindow = (stream: string) => {
    const fromPicker = stream.slice(stream.indexOf("pin · docs"));
    const shapesAt = fromPicker.indexOf("Shapes  routed under");
    return shapesAt === -1 ? fromPicker : fromPicker.slice(0, shapesAt);
  };

  test("the candidate picker honors staged fleet membership in both directions and the confirmed write lands the allow form", async () => {
    // OUT staged this session leaves the picker immediately — no relaunch; the confirmed write
    // is the minimal allow form (fake partially in-fleet → adapter:model entry, deny tombstoned)
    const a = setup();
    withOverlay(a.repo, TWO_CLASSIFIED);
    const aIO = makeIO();
    const aDone = fleet(["--global-dir", isolatedGlobal()], a.repo, [a.adapter], aIO.io);
    aIO.input.write(KEYS.space + TO_DOCS + KEYS.p);
    await settle(() => strip(aIO.writes.join("")).includes("pin · docs"));
    aIO.input.write(KEYS.escape + KEYS.w + KEYS.y);
    expect(await aDone).toMatch(/^fleet: wrote /);
    // Ink chunks are not whole frames — assert on the joined stream bounded to the picker window
    const aPicker = pickerWindow(strip(aIO.writes.join("")));
    expect(aPicker).toContain("fake:fake-2");
    expect(aPicker).not.toContain("fake:fake-1");
    expect(parsedOverlay(a.repo).routing.allow).toEqual({ models: ["fake:fake-2"] });
    expect(parsedOverlay(a.repo).routing.deny).toEqual({ adapters: null, models: null });
    // a DISK-excluded model (allow form, fail-closed complement) toggled back IN this session
    // reappears in the picker — the preview pool is discovered membership-blind, so the startup
    // scopes can't lie until restart — and the whole-fleet-in write removes the allow block
    const b = setup();
    withOverlay(b.repo, `${TWO_CLASSIFIED}routing:
  allow:
    models: [fake:fake-2]
`);
    const bIO = makeIO();
    const bDone = fleet(["--global-dir", isolatedGlobal()], b.repo, [b.adapter], bIO.io);
    bIO.input.write(KEYS.space + TO_DOCS + KEYS.p);
    await settle(() => strip(bIO.writes.join("")).includes("pin · docs"));
    bIO.input.write(KEYS.escape + KEYS.w + KEYS.y);
    expect(await bDone).toMatch(/^fleet: wrote /);
    expect(pickerWindow(strip(bIO.writes.join("")))).toContain("fake:fake-1");
    expect(parsedOverlay(b.repo).routing?.allow).toBeUndefined();
  });

  test("Enter on an out-of-fleet classified row explains membership instead of opening the assign overlay", async () => {
    const { repo, adapter } = setup();
    const { io, writes } = makeIO();
    // Space toggles fake-1 out of the fleet; Enter on the same row must coach, not assign
    const out = await drive(repo, adapter, io, KEYS.space + KEYS.enter + KEYS.q + KEYS.q, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(writes.join(""));
    expect(all).toContain("fake:fake-1 is out of the fleet — Space adds it before assigning");
    expect(all).not.toContain("pin fake:fake-1 to a shape"); // the assign overlay never opened
  });

  test("Esc on the poolmode overlay returns to the candidate picker with the chain markers intact", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(TO_DOCS + KEYS.p + KEYS.down + KEYS.space + KEYS.up + KEYS.space + KEYS.enter);
    await settle(() => strip(io.writes.join("")).includes("pool mode · docs"));
    const poolFrame = io.writes.map(strip).find((f) => f.includes("pool mode · docs"))!;
    expect(poolFrame).toContain("economy engine picks within your selection");
    expect(poolFrame).toContain("first live wins");
    const mark = io.writes.length;
    io.input.write(KEYS.escape);
    await settle(() => io.writes.slice(mark).map(strip).some((f) => f.includes("pool · docs")));
    const picker = io.writes.slice(mark).map(strip).find((f) => f.includes("pool · docs"))!;
    // the order markers survive the round trip: fake-2 was picked first, fake-1 second
    expect(picker).toMatch(/1 fake:fake-2/);
    expect(picker).toMatch(/2 fake:fake-1/);
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  test("/ outside the models view names where search lives instead of eating the key", async () => {
    const { repo, adapter } = setup();
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(OPEN_SHAPES);
    await settle(() => writes.map(strip).some((f) => f.includes("Shapes  routed under")));
    input.write("/");
    await settle(() => strip(writes.join("")).includes("not searchable"));
    input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    expect(strip(writes.join(""))).toContain("this list is not searchable — / searches the models view");
  });

  test("a leading / in a searchable overlay is swallowed so /query works everywhere", async () => {
    const { repo, adapter } = setup();
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(TO_DOCS + KEYS.p);
    await settle(() => strip(writes.join("")).includes("pin · docs"));
    input.write("/fake-2");
    await settle(() => strip(writes.join("")).includes("> fake-2"));
    input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
    const stream = strip(writes.join(""));
    expect(stream).toContain("> fake-2"); // the query landed
    expect(stream).not.toContain("> /fake"); // the leading slash never landed in the query
  });

  test("Space on an unauthed rail adapter names auth as the blocker and the doctor remedy", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, FAKE_TIERS);
    registry.writeDoctor(repo, {
      fake: {
        installed: true,
        authed: false,
        version: "fake",
        models: ["fake-1", "fake-2"],
        modelsDetectedAt: "2026-07-16T12:00:00.000Z",
      },
    });
    const when = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [fakeAdapter(repo)], io);
    input.write(RAIL + KEYS.down.repeat(3) + KEYS.space);
    await settle(() => strip(writes.join("")).includes("is not authed"));
    input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    expect(strip(writes.join(""))).toContain(
      "fake is not authed — Space only toggles fleet membership; re-auth the fake CLI, then run tickmarkr doctor",
    );
  });

  test("the first Shapes entry per session raises the presets overlay and Esc lands in the shapes list", async () => {
    const { repo, adapter } = setup();
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(RAIL + KEYS.down + KEYS.enter);
    await settle(() => strip(writes.join("")).includes("routing mode"));
    expect(strip(writes[0])).not.toContain("routing mode"); // never at launch — the browser opens first
    const mark = writes.length;
    input.write(KEYS.escape);
    await settle(() => writes.slice(mark).map(strip).some((f) => f.includes("Shapes  routed under")));
    // Esc landed in the shapes list beneath it (never quit) — q then quits from the browser
    expect(writes.slice(mark).map(strip).some((f) => f.includes("Shapes  routed under"))).toBe(true);
    input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  // Repair layer 2/2 — ASSERTION SYNCHRONIZATION. This escape-path observation uses the same
  // release gate as the sibling overlay-diff case above; no wall-clock settle window decides when
  // the post-Escape frame becomes eligible for the assertion.
  test("test: the escape path's settled row is observed through the same release gate its sibling case already uses, so the stream as it stands the instant the escape key is written does not carry that row while the post-release poll does; an assertion satisfied by that instant read fails", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(TO_DOCS + KEYS.p);
    await settle(() => strip(io.writes.at(-1) ?? "").includes("pin · docs")); // picker open = TO_DOCS drained
    // capture the settled shape row the picker opened on — the LAST Shapes-view frame BEFORE the
    // picker, located by content rather than a fixed frame index (the runtime coalesces a
    // render-timing-dependent number of frames; CI differs from local).
    const shapeFrame = (f: string) => strip(f).includes("Shapes  routed under");
    const rowBefore = pointerLine(io.writes.filter(shapeFrame).at(-1)!);
    expect(rowBefore).toContain("fake:fake-1");
    // Install the sibling's gate only after the picker is open. `frames` can therefore contain
    // only the post-Escape stream, never the identical pre-picker Shapes row captured above.
    const { frames, release } = delayedFrames(io.io, io.writes);
    io.input.write(KEYS.escape);
    // Instant read: the release gate is still closed, so satisfying the row assertion here is the bug.
    const escapedShapeRows = () => frames.filter(shapeFrame).map(pointerLine);
    const escapedShapeRow = () => pointerLine(
      frames.filter(shapeFrame).at(-1) ?? "",
    );
    expect(escapedShapeRows()).not.toContain(rowBefore);
    release();
    // Post-release: poll the fact itself; a real move to another shape never satisfies it.
    await expect.poll(escapedShapeRow, { interval: 5, timeout: 2_000 }).toBe(rowBefore);
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
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
    const rows = docsRows(writes);
    const pinnedAt = rows.findIndex((l) => l.includes("fake:fake-2 (api, frontier)")); // pinned via the picker
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(rows.slice(0, pinnedAt).some((l) => l.includes("fake:fake-1 (sub, frontier)"))).toBe(true); // auto before the pin
    expect(rows.slice(pinnedAt + 1).some((l) => l.includes("fake:fake-1 (sub, frontier)"))).toBe(true); // a returns the row to auto
  });

  test("aborting from inside the picker releases keypress listeners and pauses the input stream", async () => {
    const { repo, adapter } = setup();
    const { io, input, rawCalls } = makeIO();
    const out = await drive(repo, adapter, io, TO_DOCS + KEYS.p + "\x03", ["--global-dir", isolatedGlobal()]);
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
  test("a shape-row preview's routed candidate always matches the candidate picker's rank-1 result for the same shape and channel set", async () => {
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
    // OBS-607: this compares TWO RENDERED FRAMES — the Shapes row and the picker's rank-1 row — so
    // both must actually paint. A one-chunk drive does not guarantee that: the runtime coalesces a
    // render-timing-dependent number of frames, and under the suite's own fork pressure the Shapes
    // frame and the picker frame collapse into one, leaving `docsRows` empty and the comparison
    // reading `undefined` as if the two had disagreed. Split the writes and PROVE each frame
    // painted before pressing the key that replaces it — the same contract the neighbouring
    // shapes-economics drives already state. Nothing about the comparison itself is relaxed.
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(TO_DOCS);
    await settle(() => docsRows(writes).some((l) => /fake:fake-\d/.test(l)));
    input.write(KEYS.p);
    await settle(() => strip(writes.join("")).includes("pin · docs"));
    input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
    const rowRouted = /fake:fake-\d/.exec(docsRows(writes).at(-1) ?? "")?.[0]; // the docs shape row
    const picker = writes.find((f) => strip(f).includes("pin · docs"))!;
    const rank1 = /fake:fake-\d/.exec(pointerLine(picker))?.[0]; // picker cursor starts on rank-1
    expect(rank1).toBe("fake:fake-1"); // the warm incumbent — never the due exploration probe
    expect(rowRouted).toBe(rank1);
  });

  // ── v1.56 T3: cost visibility on the Shapes view ──────────────────────────
  // The DEFAULT map pins plan and spec to claude-code:fable, which cannot route in the fake
  // fleet — re-pin them onto fake-1 so all nine shapes route. Auto rows land on fake-1
  // (sub, frontier; marginal cost ranks sub before api), so the sub economics label covers
  // every row, and the api per-task estimate is exercised by pinning fake-2 through the picker.
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

  // the 9 shape rows of the last Shapes-view frame — the footer detail band (the one line that
  // still carries the "→" why-projection) is excluded so only real list rows are counted
  const shapeRowsOf = (writes: string[]) => {
    const frame = writes.map(strip).filter((f) => f.includes("Shapes  routed under")).at(-1) ?? "";
    return frame.split("\n").filter((l) => (l.includes("(sub,") || l.includes("(api,")) && !l.includes("→"));
  };

  // one settled drive for the shapes-economics family: OPEN_SHAPES, PROVE the shapes frame
  // painted, then quit — one-chunk drives coalesce into a single final render and can skip it
  const driveToShapes = async (repo: string, adapter: FakeAdapter) => {
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(OPEN_SHAPES);
    await settle(() => writes.map(strip).some((f) => f.includes("Shapes  routed under")));
    input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    return writes;
  };

  test("every shape row carries a channel economics marker", async () => {
    const { repo, adapter } = setupAllRoutable();
    const rows = shapeRowsOf(await driveToShapes(repo, adapter));
    expect(rows.length).toBe(9);
    for (const row of rows) expect(row).toMatch(/flat-rate quota|api ~\$|api metered/);
  });

  test("sub channel rows are labeled flat rate quota", async () => {
    const { repo, adapter } = setupAllRoutable();
    const subRows = shapeRowsOf(await driveToShapes(repo, adapter)).filter((l) => l.includes("(sub,"));
    expect(subRows.length).toBe(9);
    for (const row of subRows) expect(row).toContain("sub flat-rate quota");
  });

  test("no sub channel row renders a zero dollar amount", async () => {
    const { repo, adapter } = setupAllRoutable();
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    // split writes: the shapes frame must PAINT before p replaces it with the picker (one-chunk
    // drives coalesce into a single final render and would skip it)
    input.write(OPEN_SHAPES);
    await settle(() => writes.map(strip).some((f) => f.includes("Shapes  routed under")));
    input.write(KEYS.p);
    await settle(() => strip(writes.join("")).includes("pin · plan"));
    input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
    // shape rows and picker rows: a sub channel is flat-rate quota — it never renders a dollar
    // figure at all, so a fake $0 is structurally impossible
    const shapeSubRows = shapeRowsOf(writes).filter((l) => l.includes("(sub,"));
    expect(shapeSubRows.length).toBe(9);
    const picker = strip(writes.join(""));
    const pickerWindowed = picker.slice(picker.indexOf("pin · plan"));
    const pickerSubRows = pickerWindowed.split("\n").filter((l) => l.includes("fake:fake-1"));
    expect(pickerSubRows.length).toBeGreaterThan(0);
    for (const row of [...shapeSubRows, ...pickerSubRows]) expect(row).not.toContain("$");
  });

  test("an api routed shape shows a rough per task estimate from the pricing table", async () => {
    const { repo, adapter } = setup();
    const { io, writes, input } = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    input.write(TO_DOCS + KEYS.p);
    await settle(() => strip(writes.join("")).includes("pin · docs"));
    const mark = writes.length;
    input.write(KEYS.down + KEYS.enter);
    // the post-pin shapes repaint must PAINT before q unmounts (same coalescing hazard)
    await settle(() => writes.slice(mark).map(strip).some((f) => f.includes("Shapes  routed under")));
    input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
    // docs pinned to fake-2 (api, frontier) via the picker — the row carries the default
    // pricing-table frontier per-task estimate ($2.50), same figure the picker row showed
    expect(docsRows(writes).at(-1)).toContain("fake:fake-2 (api, frontier)  api ~$2.50/task");
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
  const MODE_ONLY_WRITE = KEYS.m + KEYS.down + KEYS.enter + KEYS.w;

  test("a provenance note attached to one model tier survives a fleet write that only changes a different model's tier", async () => {
    const { repo, adapter } = setupNoted();
    queueAnswers("y");
    const out = await drive(
      repo, adapter, makeIO().io,
      KEYS.down + KEYS.t + KEYS.enter
        + "AA Index 54" + KEYS.enter + KEYS.w,
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
    // a steering-only write (picker: toggle the bare fake adapter, apply, review, confirm)
    const b = setupNoted();
    queueAnswers("y");
    expect(await drive(b.repo, b.adapter, makeIO().io, OPEN_STEER + KEYS.f + KEYS.space + KEYS.enter + KEYS.w, ["--global-dir", isolatedGlobal()])).toMatch(/^fleet: wrote /);
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

  // The classify flow makes an invalid tier structurally unreachable; the remaining input mistake
  // is an empty provenance submission, which keeps every staged edit and re-asks in place.

  test("an empty provenance note in the classify flow re-prompts the provenance field and keeps every other in-session edit intact", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    queueAnswers("y");
    const bytes = KEYS.space + KEYS.down + KEYS.t + KEYS.down + KEYS.enter + KEYS.enter
      + "AA Index 54" + KEYS.enter + KEYS.w;
    const out = await drive(repo, adapter, io.io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    expect(strip(io.writes.join(""))).toContain("benchmark-provenance note is required");
    const overlay = parsedOverlay(repo);
    // the Space-out of fake-1 leaves fake-2 in the served universe — partial-adapter allow form
    expect(overlay.routing.allow).toEqual({ models: ["fake:fake-2"] });
    expect(overlay.tiers.fake.models["fake-2"]).toBe("mid");
    expect(readFileSync(overlayAt(repo), "utf8")).toMatch(/fake-2: mid {2}# AA Index 54 — fleet \d{4}-\d{2}-\d{2}/);
  });

  test("a corrected entry after a re-prompt applies the tier assignment exactly as if it had been entered correctly the first time", async () => {
    const gdir = isolatedGlobal();
    const classify = (emptyFirst: boolean) =>
      KEYS.down + KEYS.t + KEYS.down + KEYS.enter
      + (emptyFirst ? KEYS.enter : "") + "AA Index 54" + KEYS.enter + KEYS.w;
    const a = setup();
    queueAnswers("y");
    expect(await drive(a.repo, a.adapter, makeIO().io, classify(true), ["--global-dir", gdir])).toMatch(/^fleet: wrote /);
    const b = setup();
    queueAnswers("y");
    expect(await drive(b.repo, b.adapter, makeIO().io, classify(false), ["--global-dir", gdir])).toMatch(/^fleet: wrote /);
    expect(readFileSync(overlayAt(a.repo), "utf8")).toBe(readFileSync(overlayAt(b.repo), "utf8"));
  });

  // ── OBS-529: classify → write → the missing third step gets named ──
  test("writing a classification for a model doctor never probed names the fleet --fresh step; a fully probed write stays silent", async () => {
    // fake-2 detected but WITHOUT a modelAuth verdict — exactly a freshly discovered model
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, FAKE_TIERS);
    registry.writeDoctor(repo, {
      fake: {
        installed: true,
        authed: true,
        version: "fake",
        models: ["fake-1", "fake-2"],
        modelsDetectedAt: "2026-07-16T12:00:00.000Z",
        modelAuth: { "fake-1": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" } },
      },
    });
    const when = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
    queueAnswers("y");
    const out = await drive(
      repo, fakeAdapter(repo), makeIO().io,
      KEYS.down + KEYS.t + KEYS.down + KEYS.enter + "AA Index 54" + KEYS.enter + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toMatch(/^fleet: wrote /);
    expect(out).toContain("1 newly classified model(s) have no probe verdict yet (fake:fake-2)");
    expect(out).toContain("tickmarkr fleet --fresh");

    // control: the same classification with a recorded verdict appends nothing
    const probed = setup(); // stampDoctor carries verdicts for every model
    queueAnswers("y");
    const silent = await drive(
      probed.repo, probed.adapter, makeIO().io,
      KEYS.down + KEYS.t + KEYS.down + KEYS.enter + "AA Index 54" + KEYS.enter + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(silent).toMatch(/^fleet: wrote /);
    expect(silent).not.toContain("probe verdict");
  });

  test("no classify-flow input mistake can any longer discard an operator's in-session fleet edits before the review overlay is reached", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    const io = makeIO();
    queueAnswers("n");
    const out = await drive(
      repo, adapter, io.io,
      KEYS.space + KEYS.t + KEYS.down + KEYS.t
        + KEYS.down + KEYS.down + KEYS.enter + KEYS.enter
        + "AA Index 54" + KEYS.enter + KEYS.w,
      ["--global-dir", isolatedGlobal()],
    );
    expect(out).toBe("fleet: discarded overlay changes");
    const all = strip(io.writes.join(""));
    // t on a classified row renders the inline notice and the session stays alive
    expect(all).toContain("tier reassignment on classified models is not supported in v1");
    expect(all).toContain("allow:"); // the membership edit reached the review diff
    expect(all).toContain("- fake:fake-2"); // as the minimal partial-adapter allow form
    expect(all).toContain("fake-2: frontier"); // and so did the corrected classification
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
  });

  // ── v1.61 → v1.92: init's editor entry (browser-first, Esc-home presets), the judge seat, and type-to-search ──
  // entry="presets" is only reachable through the assembler contract init.ts consumes, so these
  // drive assembleFleetEditor + runFleetInkEditor directly rather than the fleet() command shell.
  const driveEntry = async (repo: string, adapter: FakeAdapter, bytes: string) => {
    const io = makeIO();
    // dynamic import mirrors init.ts and keeps Ink's color detection AFTER the TTY fixture above
    const { runFleetInkEditor } = await import("../../src/tui/ink/fleet-app.js");
    const assembled = await assembleFleetEditor(repo, [adapter], io.io, {
      globalDir: isolatedGlobal(),
      entry: "presets",
    });
    if ("unavailable" in assembled) throw new Error(assembled.unavailable);
    const done = runFleetInkEditor(assembled.props);
    io.input.write(bytes);
    const result = await done;
    return { io, out: assembled.commit(result) };
  };

  test("entry=presets opens the browser on the models view and Esc raises the preset overlay whose pick routes straight to the diff confirm", async () => {
    const { repo, adapter } = setup();
    // v1.92: no preset overlay at launch — fleet scoping first. Esc is HOME to the preset
    // overlay; the cursor there starts on the current mode (risk-based), one down = staff-led.
    const { io, out } = await driveEntry(repo, adapter, KEYS.escape + KEYS.down + KEYS.enter + KEYS.y);
    expect(out).toMatch(/^fleet: wrote /);
    const first = strip(io.writes[0] ?? "");
    expect(first).toContain("All models"); // launch lands in the browser
    expect(first).not.toContain("routing preset");
    expect(first).toContain("init act 3 of 3"); // the preset entry names its init journey
    const all = strip(io.writes.join(""));
    expect(all).toContain("routing preset"); // Esc raised the HOME overlay with the custom row
    expect(all).toContain("custom");
    expect(all).toContain("open the fleet browser (models · shapes · steering)");
    expect(all).toContain("review ·"); // the preset pick went straight to the review overlay
    expect(all).toContain("y writes, n discards");
    expect(parsedOverlay(repo).routing.mode).toBe("staff-led");
  });

  test("entry=presets picking the current mode on the Esc-home overlay is an empty diff and Esc there quits", async () => {
    const a = setup();
    expect((await driveEntry(a.repo, a.adapter, KEYS.escape + KEYS.enter)).out)
      .toBe("fleet: no overlay changes (empty diff)");
    const b = setup();
    expect((await driveEntry(b.repo, b.adapter, KEYS.escape + KEYS.escape)).out)
      .toBe("fleet: quit without writing");
  });

  test("entry=presets selecting custom on the Esc-home overlay returns to the fleet browser on the models view", async () => {
    const { repo, adapter } = setup();
    // over-pressing down clamps on the final custom row without pinning the mode count
    const { io, out } = await driveEntry(repo, adapter, KEYS.escape + KEYS.down.repeat(9) + KEYS.enter + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const all = strip(io.writes.join(""));
    expect(all).toContain("All models"); // custom closes back into the browser
    expect(all).toContain("fake/fake-1");
  });

  test("entry=presets Esc inside the browser returns HOME to the preset overlay; Esc there quits", async () => {
    const { repo, adapter } = setup();
    const { io, out } = await driveEntry(repo, adapter, KEYS.escape + KEYS.escape);
    expect(out).toBe("fleet: quit without writing");
    const frames = io.writes.map(strip);
    // launch IS the browser (no overlay); Esc raises the preset overlay; Esc there quits
    expect(frames[0]).toContain("fake/fake-1");
    expect(frames[0]).not.toContain("routing preset");
    const home = frames.slice(1).find((f) => f.includes("routing preset"));
    expect(home).toBeTruthy();
    expect(home).toContain("custom"); // the custom row rides the HOME overlay
  });

  // ── the judge seat: a SINGLE adapter:model pick on the Steering view (never a chain) ──
  test("picking a judge seat stages an overlay diff carrying judge adapter and model and the write lands both", async () => {
    const { repo, adapter } = setup();
    queueAnswers("y");
    const io = makeIO();
    // steering: down down lands on the judge row; f opens the picker; down skips (keep default)
    const bytes = OPEN_STEER + KEYS.down + KEYS.down + KEYS.f + KEYS.down + KEYS.enter + KEYS.w;
    const out = await drive(repo, adapter, io.io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(out).toMatch(/^fleet: wrote /);
    const all = strip(io.writes.join(""));
    expect(all).toContain("(keep default)  claude-code:fable"); // the picker names the resolved default
    expect(all).toContain("judge:"); // the confirmed diff carries the judge block
    expect(parsedOverlay(repo).judge).toEqual({ adapter: "fake", model: "fake-1" });
  });

  // ── viewport windowing: "can't choose models for omp" (operator field report, 218-model list) ──
  test("a model list taller than the terminal windows around the cursor with chrome and pointer always visible", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, FAKE_TIERS);
    const many = Array.from({ length: 120 }, (_, i) => `bulk-${String(i).padStart(3, "0")}`);
    registry.writeDoctor(repo, {
      fake: {
        installed: true,
        authed: true,
        version: "fake",
        models: ["fake-1", "fake-2", ...many],
        modelsDetectedAt: "2026-07-16T12:00:00.000Z",
        modelAuth: {
          "fake-1": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
          "fake-2": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
        },
      },
    });
    const when = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
    const adapter = fakeAdapter(repo);

    // browser-first entry: the models list with 120+ unclassified rows IS the launch view; makeIO is 60 rows tall
    const { io, out } = await driveEntry(repo, adapter, KEYS.down.repeat(9) + KEYS.q);
    expect(out).toBe("fleet: quit without writing");
    const modelFrames = io.writes.map(strip).filter((f) => f.includes("All models") && f.includes("bulk-"));
    expect(modelFrames.length).toBeGreaterThan(0);
    const frame = modelFrames.at(-1)!;
    expect(frame).toContain("❯");                       // the cursor is IN the frame
    expect(frame).toMatch(/… \d+ below — \/ to search/); // elision named, remedy named
    expect(frame.split("\n").length).toBeLessThan(60);   // never taller than the terminal
  });

  test("Space on an unclassified model opens the classify flow instead of dying silently", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    // fake-new is the unclassified row two below the cursor; Space on it must land in the
    // classify flow (FAKE_TIERS declares the channel, so it opens at the tier pick — the same
    // flow `t` opens) — never a silent no-op.
    const bytes = KEYS.down + KEYS.down + KEYS.space;
    const p = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(bytes + KEYS.escape + KEYS.q);
    await p;
    const all = strip(io.writes.join(""));
    expect(all).toContain("classify · fake:fake-new"); // classify flow opened from Space
    expect(all).toContain("unclassified — Space/Enter classifies"); // the detail band names the remedy
  });

  test("retired shapes hide by default with a counted line, `a` reveals them, and a classified dated snapshot is never hidden", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    // fake-old-20240620 is CLASSIFIED (tiered) — dated shape must not hide it
    withOverlay(repo, `${FAKE_TIERS}      fake-old-20240620: cheap\n`);
    registry.writeDoctor(repo, {
      fake: {
        installed: true,
        authed: true,
        version: "fake",
        models: ["fake-1", "fake-old-20240620", "fake-live", "fake-snap-20250101", "fake-embedding", "fake-x-preview"],
        modelsDetectedAt: "2026-07-16T12:00:00.000Z",
        modelAuth: { "fake-1": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" } },
      },
    });
    const when = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
    const adapter = fakeAdapter(repo);
    const io = makeIO();
    const p = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    // models browser → toggle show-all → quit
    io.input.write(KEYS.a + KEYS.q);
    await p;
    const frames = io.writes.map(strip);
    const before = frames.find((f) => f.includes("hidden — a shows all"))!;
    expect(before).toBeDefined();
    expect(before).toContain("3 retired/preview/non-worker hidden"); // snap + embedding + preview
    expect(before).not.toContain("fake-snap-20250101");
    expect(before).toContain("fake-old-20240620"); // classified dated snapshot stays visible
    expect(before).toContain("fake-live");
    const after = frames.find((f) => f.includes("showing retired models"));
    expect(after).toBeDefined();
    expect(after).toContain("fake-snap-20250101");
  });

  test("retiredModelReason classifies the shapes and letter hotkeys yield inside search mode", async () => {
    expect(retiredModelReason("anthropic/claude-3-5-sonnet-20241022")).toBe("dated snapshot");
    expect(retiredModelReason("google/deep-research-preview-04-2026")).toBe("preview");
    expect(retiredModelReason("google/gemini-2.5-flash-image")).toBe("non-worker");
    expect(retiredModelReason("google/gemini-1.5-pro")).toBe("legacy family");
    expect(retiredModelReason("openai/gpt-5.6-sol")).toBeNull();
    expect(retiredModelReason("kimi-code/k3")).toBeNull();

    // search mode swallows t/n/a as search characters — "fake-new" narrowing keeps working
    const { repo, adapter } = setup();
    const io = makeIO();
    const p = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write("/fake-n" + KEYS.escape + KEYS.q);
    await p;
    const all = strip(io.writes.join(""));
    expect(all).toContain("> fake-n"); // the n joined the filter instead of opening add-model
    expect(all).not.toContain("add model · fake");
  });

  test("windowRows keeps the cursor centered and clamps at both ends", async () => {
    // dynamic, deliberately: components.tsx imports Ink, and Ink's color detection must run
    // AFTER this file's TTY fixture (same seam as the fleet-app import in driveEntry above).
    const { windowRows } = await import("../../src/tui/ink/components.js");
    const rows = Array.from({ length: 100 }, (_, i) => i);
    expect(windowRows(rows, 0, 10)).toMatchObject({ start: 0, above: 0, below: 90 });
    expect(windowRows(rows, 50, 10)).toMatchObject({ start: 45, above: 45, below: 45 });
    expect(windowRows(rows, 99, 10)).toMatchObject({ start: 90, above: 90, below: 0 });
    expect(windowRows(rows, 5, 200).visible).toHaveLength(100); // capacity beyond length = no window
  });

  test("picking (keep default) on the judge overlay stages nothing and an otherwise unchanged browser stays an empty diff", async () => {
    const { repo, adapter } = setup();
    const before = readFileSync(overlayAt(repo), "utf8");
    const bytes = OPEN_STEER + KEYS.down + KEYS.down + KEYS.f + KEYS.enter + KEYS.w + KEYS.q;
    const out = await drive(repo, adapter, makeIO().io, bytes, ["--global-dir", isolatedGlobal()]);
    expect(out).toBe("fleet: quit without writing");
    expect(readFileSync(overlayAt(repo), "utf8")).toBe(before);
  });

  // ── type-to-search on the long lists ──
  test("type-to-search narrows a picker list and backspace restores the dropped rows", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(OPEN_STEER + KEYS.f);
    await settle(() => io.writes.join("").includes("edit · review.prefer"));
    io.input.write("1");
    await settle(() => strip(io.writes.join("")).includes("> 1"));
    const bareRow = /· fake(?![:-])/;
    const narrowed = strip(io.writes.at(-1)!);
    expect(narrowed).toContain("fake:fake-1");
    expect(narrowed).not.toContain("fake:fake-2");
    expect(narrowed).not.toMatch(bareRow);
    const mark = io.writes.length;
    io.input.write(KEYS.backspace);
    await settle(() => io.writes.slice(mark).some((frame) => bareRow.test(strip(frame))));
    expect(io.writes.slice(mark).map(strip).some((frame) => bareRow.test(frame))).toBe(true);
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  // ── OBS-524: the review diff scrolls — the operator can read everything they approve ──
  test("a review diff taller than the window scrolls with the arrow keys instead of hiding its tail forever", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    io.output.rows = 18; // viewRows = max(8, 18-12) = 8 → review window 9 rows
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(KEYS.space + KEYS.w); // membership toggle → allow form + tombstones > 9 diff lines
    await settle(() => strip(io.writes.join("")).includes("review · "));
    const first = strip(io.writes.at(-1)!);
    expect(first).toMatch(/… \d+ below — ↓ scrolls/);
    const mark = io.writes.length;
    io.input.write(KEYS.down);
    await settle(() => io.writes.slice(mark).map(strip).some((f) => f.includes("… 1 above")));
    expect(io.writes.slice(mark).map(strip).some((f) => f.includes("… 1 above"))).toBe(true);
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  // ── OBS-525: pools round-trip through the editor ──
  // returns { done } — a bare promise return would be FLATTENED by the caller's await
  const stageDocsPool = async (io: ReturnType<typeof makeIO>, repo: string, adapter: FakeAdapter) => {
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(TO_DOCS + KEYS.p + KEYS.down + KEYS.space + KEYS.up + KEYS.space + KEYS.enter);
    await settle(() => strip(io.writes.join("")).includes("pool mode · docs"));
    const mark = io.writes.length;
    io.input.write(KEYS.enter); // mode: any → pool staged on docs
    await settle(() => io.writes.slice(mark).map(strip).some((f) => f.includes("Shapes  routed under")));
    return { done };
  };

  test("reopening the picker on a pooled shape seeds the staged chain instead of an empty selection", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await stageDocsPool(io, repo, adapter);
    const mark = io.writes.length;
    io.input.write(KEYS.p); // reopen WITHOUT pressing Space — the chain must already be there
    await settle(() => io.writes.slice(mark).map(strip).some((f) => f.includes("pool · docs")));
    const picker = io.writes.slice(mark).map(strip).find((f) => f.includes("pool · docs"))!;
    expect(picker).toMatch(/1 fake:fake-2/);
    expect(picker).toMatch(/2 fake:fake-1/);
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  test("a on a pooled shape reverts the whole declaration to auto, not just a pin", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await stageDocsPool(io, repo, adapter);
    const mark = io.writes.length;
    io.input.write(KEYS.a);
    await settle(() => io.writes.slice(mark).map(strip).some((f) => pointerLine(f).includes("fake:fake-1 (sub, frontier)")));
    expect(io.writes.slice(mark).map(strip).some((f) => pointerLine(f).includes("fake:fake-1 (sub, frontier)"))).toBe(true);
    // pool gone + nothing else staged ⇒ ONE q quits — the guard sees zero staged edits
    io.input.write(KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  test("f on a pooled shape refuses to stage the invalid pool+prefer combination and names the way out", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await stageDocsPool(io, repo, adapter);
    const mark = io.writes.length;
    io.input.write(KEYS.f);
    await settle(() => io.writes.slice(mark).map(strip).some((f) => f.includes("routes a pool")));
    expect(strip(io.writes.join(""))).toContain("docs routes a pool — prefer applies to auto/pin routing");
    expect(io.writes.slice(mark).map(strip).some((f) => f.includes("edit · docs.prefer"))).toBe(false);
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  // ── OBS-520: the browser's committed search survives an overlay round trip ──
  test("closing an overlay restores the committed model search instead of dumping the operator on the unfiltered list", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write("/e-2" + KEYS.enter); // commit the filter
    await settle(() => strip(io.writes.join("")).includes("> e-2"));
    io.input.write(KEYS.enter); // fake-2 is unclassified → the classify overlay opens
    await settle(() => strip(io.writes.join("")).includes("classify · fake:fake-2"));
    const mark = io.writes.length;
    io.input.write(KEYS.escape); // cancel the overlay — the filter must come back
    await settle(() => io.writes.slice(mark).map(strip).some((f) => f.includes("> e-2")));
    expect(io.writes.slice(mark).map(strip).some((f) => f.includes("> e-2"))).toBe(true);
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  // ── OBS-521: the header names staged work ──
  test("the header counts staged edits while they exist and drops the chip when the last one is untoggled", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(KEYS.space);
    await settle(() => io.writes.map(strip).some((f) => f.includes("· 1 staged")));
    expect(io.writes.map(strip).some((f) => f.includes("· 1 staged"))).toBe(true);
    const mark = io.writes.length;
    io.input.write(KEYS.space); // untoggle — back to zero staged
    await settle(() => io.writes.slice(mark).map(strip).some((f) => !f.includes("staged") && f.includes("tickmarkr fleet")));
    expect(strip(io.writes.at(-1)!)).not.toContain("· 1 staged");
    io.input.write(KEYS.q); // zero staged ⇒ one q suffices
    expect(await done).toBe("fleet: quit without writing");
  });

  // ── OBS-527: terminal geometry is a live input — a pane resize re-renders at the new size ──
  test("a terminal resize re-renders the editor at the new geometry with staged state intact", async () => {
    const { repo, adapter } = setup();
    const base = makeIO();
    const writes: string[] = [];
    // a real event-emitting output — makeIO's inert on/off can never deliver the resize
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 120,
      rows: 20, // viewRows = max(8, 20-12) = 8 visible list rows
      write: (chunk: string) => {
        if (chunk === "" || chunk === "\x1b[?25l" || chunk === "\x1b[?25h") return true;
        if (writes.at(-1) === chunk) return true;
        writes.push(chunk);
        return true;
      },
    });
    const io: FleetIO = { input: base.input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, debug: true };
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io);
    base.input.write(KEYS.space); // stage a toggle so state survival across the resize is observable
    await settle(() => writes.map(strip).some((f) => f.includes("· 1 staged")));
    const frameWidth = (frame: string) =>
      frame.split("\n").find((line) => line.startsWith("╭"))?.length ?? Number.NaN;
    expect(frameWidth(strip(writes.at(-1) ?? ""))).toBe(120);
    const mark = writes.length;
    output.columns = 80; // narrow the pane — the frame must re-render at the new width
    output.emit("resize");
    await settle(() => writes.slice(mark).map(strip).some((f) => frameWidth(f) === 80));
    const resized = writes.slice(mark).map(strip).find((f) => frameWidth(f) === 80);
    expect(resized).toBeDefined();
    expect(resized).toContain("· 1 staged"); // the resize preserved the staged edit
    base.input.write(KEYS.q + KEYS.q);
    expect(await done).toBe("fleet: quit without writing");
  });

  // ── OBS-530/531: the picker names what it cannot offer; shape rows name their pool; deep ids keep their tail ──
  test("a pasted search chunk with a trailing newline strips the control bytes instead of poisoning the filter", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    delete (io.input as Partial<TestInput>).ref;
    delete (io.input as Partial<TestInput>).unref;
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    await settle(() => io.writes.map(strip).some((f) => f.includes("All models")));
    // bypass makeIO's one-key pump: a real paste delivers the whole chunk in ONE data event
    PassThrough.prototype.write.call(io.input, "/e-2\r");
    await settle(() => io.writes.map(strip).some((f) => f.includes("> e-2")));
    const searched = io.writes.map(strip).find((f) => f.includes("> e-2"))!;
    expect(searched).toBeDefined();
    expect(searched).toContain("fake/fake-2"); // the row matches — no \r poisoned the query
    expect(searched).not.toContain("no models match");
    PassThrough.prototype.write.call(io.input, "\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  test("the candidate picker names every excluded bucket instead of omitting channels silently", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const done = fleet(["--global-dir", isolatedGlobal()], repo, [adapter], io.io);
    io.input.write(KEYS.space); // stage fake-1 out — the picker must attribute its absence
    await settle(() => io.writes.map(strip).some((f) => f.includes("· 1 staged")));
    io.input.write(OPEN_SHAPES + KEYS.p);
    await settle(() => io.writes.map(strip).some((f) => f.includes("not offered:")));
    const note = io.writes.map(strip).find((f) => f.includes("not offered:"))!;
    expect(note).toBeDefined();
    expect(note).toContain("1 staged out this session");
    expect(note).toContain("unclassified (never routed)"); // fake-2/fake-new have no tier
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });

  test("a pooled shape row names the declaration, not just the routed winner", async () => {
    const { repo, adapter } = setup();
    const io = makeIO();
    const { done } = await stageDocsPool(io, repo, adapter);
    const shapesFrame = io.writes.map(strip).filter((f) => f.includes("Shapes  routed under")).at(-1)!;
    expect(shapesFrame).toContain("pool(any·2) → fake:"); // declaration visible beside the winner
    io.input.write("\x03");
    expect(await done).toBe("fleet: quit without writing");
  });
  test("clipPathTail keeps the distinguishing last segment of a deep model id", async () => {
    // dynamic import: a static frame.js import would snapshot Ink's color support at collection
    // time, BEFORE the TTY/FORCE_COLOR fixture — the same ordering law driveEntry documents
    const { clipPathTail } = await import("../../src/tui/ink/frame.js");
    const id = "prime-agent/prime-inference/anthropic/claude-fable-5";
    expect(clipPathTail(id, id.length)).toBe(id); // fits — untouched
    const clipped = clipPathTail(id, 34);
    expect(clipped).toHaveLength(34);
    expect(clipped).toContain("…");
    expect(clipped.endsWith("/claude-fable-5")).toBe(true); // the tail survives
    expect(clipPathTail("no-slashes-here-at-all", 10)).toBe("no-slashe…"); // fallback end-clip
    expect(clipPathTail("a/very-long-tail-segment-wider-than-width", 10)).toHaveLength(10); // tail too wide — fallback
  });
});
