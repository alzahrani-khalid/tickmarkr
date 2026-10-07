// v2.6.8 beside leg B-KEYS (D-1338): a cursor move in the fleet editor reuses its rows. The staged
// policy and every row's reach derive ONCE per staged state and live in refs; a render-local memo
// reset on every keypress and re-derived ~800 rows (the policy, the exclusion collector per member,
// the overlay holder per held path) six to seven passes per frame — the operator's "delay moving
// with keys from one item to another".
// Harness: production assembleFleetEditor → the real Ink editor fed raw key bytes, with the two props
// the row derivation reaches the command through (stagedRouting: the loader over the candidate
// bytes; holderOf: the overlay file reads) wrapped in call counters; a cached fake doctor and an
// injected FakeAdapter — no probe, no model, zero tokens. Frame barriers only, never a sleep.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import { assembleFleetEditor, type FleetIO } from "../../src/cli/commands/fleet.js";
import { makeRepo } from "../helpers/tmprepo.js";

const K = { down: "\x1b[B", up: "\x1b[A", left: "\x1b[D", right: "\x1b[C", enter: "\r", escape: "\x1b", space: " " } as const;
// the reach picker: in · out workers · out all seats
const REACH_WORKERS = K.space + K.down + K.enter;

const MODELS = Array.from({ length: 40 }, (_, i) => `fake-${String(i + 1).padStart(2, "0")}`);
// every fifth channel is workers-denied on disk, so its row carries a held scope (a holderOf read)
const DENIED = MODELS.filter((_, i) => i % 5 === 1);

beforeEach(() => {
  vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "tkr-keys-home-")));
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "tkr-keys-xdg-")));
  vi.stubEnv("FORCE_COLOR", "0");
});
afterEach(() => vi.unstubAllEnvs());

type Fixture = { repo: string; globalDir: string; adapter: FakeAdapter };

function fixture(): Fixture {
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  const globalDir = mkdtempSync(join(process.env.HOME ?? tmpdir(), "tkr-keys-user-"));
  writeFileSync(join(globalDir, "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    ...MODELS.map((model) => `      ${model}: mid`),
    "routing:",
    "  deny:",
    "    workers:",
    "      models:",
    ...DENIED.map((model) => `        - fake:${model}`),
    "",
  ].join("\n"));
  const script = join(repo, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const at = "2026-10-06T00:00:00.000Z";
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: MODELS,
      modelsDetectedAt: at,
      modelAuth: Object.fromEntries(MODELS.map((model) => [model, { authed: true, probedAt: at }])),
    },
  });
  return { repo, globalDir, adapter: new FakeAdapter(script) };
}

type TestInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; ref: () => TestInput; unref: () => TestInput };

function makeIO() {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const frames: string[] = [];
  const output = {
    isTTY: true,
    columns: 160,
    rows: 60,
    write: (chunk: string) => {
      if (chunk && chunk !== "\x1b[?25l" && chunk !== "\x1b[?25h") frames.push(chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
      return true;
    },
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  return { input, frames, io: { input, output, debug: true } as FleetIO };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
// the doctor-age chip counts minutes since doctor.json's mtime — the one clock on the frame
const stable = (frame: string) => frame.replace(/\d+[mh] old/g, "age");

async function session(fx: Fixture) {
  const { input, frames, io } = makeIO();
  const assembled = await assembleFleetEditor(fx.repo, [fx.adapter], io, { globalDir: fx.globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const counts = { routing: 0, holder: 0 };
  const stagedRouting = assembled.props.stagedRouting;
  const holderOf = assembled.props.holderOf;
  if (!stagedRouting || !holderOf) throw new Error("the fleet command hands the editor both seams");
  assembled.props.stagedRouting = (deny, stage) => {
    counts.routing += 1;
    return stagedRouting(deny, stage);
  };
  assembled.props.holderOf = (dotted) => {
    counts.holder += 1;
    return holderOf(dotted);
  };
  const { runFleetInkEditor } = await import("../../src/tui/ink/fleet-app.js");
  let settled = false;
  const done = runFleetInkEditor(assembled.props).finally(() => {
    settled = true;
  });
  const until = async (seen: () => boolean, what: string) => {
    for (let turns = 0; !seen(); turns++) {
      if (turns > 20_000) throw new Error(`frame barrier: never saw ${what} — last frame:\n${frames.at(-1)}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const key = async (bytes: string) => {
    for (const part of bytes.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      const count = frames.length;
      input.write(part);
      await until(() => frames.length > count, `a frame after ${JSON.stringify(part)}`);
      await tick();
    }
  };
  await until(() => frames.length > 0, "the first frame");
  await tick();
  return {
    key,
    counts: () => ({ ...counts }),
    last: () => frames.at(-1) ?? "",
    // the browser row of one channel: name, tier and reach cells
    row: (model: string) => (frames.at(-1) ?? "").split("\n").find((line) => line.includes(`fake/${model} `)) ?? "",
    async quit() {
      input.write("q"); // arms when edits are staged; quits outright otherwise
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 50))]);
      if (!settled) input.write("q");
      await done;
    },
  };
}

test("fleet editor cursor moves across many rows recompute no row reach after the first render versus once per row per pass on the base", async () => {
  const s = await session(fixture());
  const first = s.counts();
  expect(first.routing).toBeGreaterThan(0); // the first frame did derive the staged policy
  expect(first.holder).toBeGreaterThan(0); // and read the held scope of every denied row

  // list cursor: down the list, back up, the rail, a rail move, back to the list, the reach picker
  // opened, moved and cancelled, retired-show toggled on and off — every cursor the editor has
  for (let i = 0; i < 30; i++) await s.key(K.down);
  for (let i = 0; i < 5; i++) await s.key(K.up);
  await s.key(K.left);
  await s.key(K.down);
  await s.key(K.right);
  await s.key(K.space);
  await s.key(K.down);
  await s.key(K.escape);
  await s.key("a");
  await s.key("a");

  expect(s.counts()).toEqual(first);
  expect(s.row("fake-26")).toMatch(/fake-26\s+mid\s+in\b/);
  expect(s.row("fake-27")).toMatch(/fake-27\s+mid\s+out workers/);
  await s.quit();
});

test("a staged deny edit after cursor moves recomputes the affected rows so the next frame shows the new reach", async () => {
  const s = await session(fixture());
  for (let i = 0; i < 4; i++) await s.key(K.down); // → fake-05, in for every seat on disk
  expect(s.row("fake-05")).toMatch(/fake-05\s+mid\s+in\b/);
  const moved = s.counts();

  await s.key(REACH_WORKERS);
  expect(s.counts().routing).toBeGreaterThan(moved.routing); // the staged policy changed — rows re-derived
  expect(s.row("fake-05")).toMatch(/fake-05\s+mid\s+out workers/);

  // the new staged state settles like the first one: moving again derives nothing
  const staged = s.counts();
  for (let i = 0; i < 10; i++) await s.key(K.down);
  for (let i = 0; i < 10; i++) await s.key(K.up);
  expect(s.counts()).toEqual(staged);
  expect(s.row("fake-05")).toMatch(/fake-05\s+mid\s+out workers/);
  await s.quit();
});

test("the frame after cursor moves is identical to a fresh render of the same staged state", async () => {
  const fx = fixture();
  // one session stages a deny, then wanders: moves, the rail, a cancelled reach picker, showAll on
  // and off, back up — and costs nothing for the wandering
  const a = await session(fx);
  for (let i = 0; i < 3; i++) await a.key(K.down);
  await a.key(REACH_WORKERS);
  const staged = a.counts();
  for (let i = 0; i < 12; i++) await a.key(K.down);
  await a.key(K.left);
  await a.key(K.down);
  await a.key(K.right);
  await a.key(K.space);
  await a.key(K.down);
  await a.key(K.escape);
  await a.key("a");
  await a.key("a");
  for (let i = 0; i < 6; i++) await a.key(K.up);
  expect(a.counts()).toEqual(staged);
  const wandered = stable(a.last());
  await a.quit();

  // a fresh session reaches the same staged state and cursor by the shortest path
  const b = await session(fx);
  for (let i = 0; i < 3; i++) await b.key(K.down);
  await b.key(REACH_WORKERS);
  for (let i = 0; i < 6; i++) await b.key(K.down);
  expect(wandered).toBe(stable(b.last()));
  expect(wandered).toMatch(/fake-04\s+mid\s+out workers/);
  await b.quit();
});

test("fleet editor shows a routing change written to an overlay file during the session on the next frame after a cursor move", async () => {
  // B-KEYS r2 (D-1446): the row memo keys on the loaded overlay layers too — a layer written while the editor is
  // open (another terminal, another tool) shows on the next frame exactly as on the base, then settles again
  const fx = fixture();
  const s = await session(fx);
  for (let i = 0; i < 4; i++) await s.key(K.down); // → fake-05, in for every seat on disk
  expect(s.row("fake-05")).toMatch(/fake-05\s+mid\s+in\b/);

  // the USER overlay gains a workers deny for fake-05
  const userPath = join(fx.globalDir, "config.yaml");
  writeFileSync(userPath, readFileSync(userPath, "utf8").replace("        - fake:fake-02\n", "        - fake:fake-02\n        - fake:fake-05\n"));
  await s.key(K.down);
  expect(s.row("fake-05")).toMatch(/fake-05\s+mid\s+out workers/);
  expect(s.row("fake-02")).toMatch(/fake-02\s+mid\s+out workers/);

  // the REPOSITORY overlay declares its own workers deny list, which replaces the user's wholesale
  writeFileSync(join(fx.repo, ".tickmarkr", "config.yaml"), "routing:\n  deny:\n    workers:\n      models:\n        - fake:fake-10\n");
  await s.key(K.up);
  expect(s.row("fake-10")).toMatch(/fake-10\s+mid\s+out workers/);
  expect(s.row("fake-05")).toMatch(/fake-05\s+mid\s+in\b/);
  expect(s.row("fake-02")).toMatch(/fake-02\s+mid\s+in\b/);

  // unchanged layers again: cursor moves derive nothing
  const settled = s.counts();
  for (let i = 0; i < 8; i++) await s.key(K.down);
  for (let i = 0; i < 8; i++) await s.key(K.up);
  expect(s.counts()).toEqual(settled);
  expect(s.row("fake-10")).toMatch(/fake-10\s+mid\s+out workers/);
  await s.quit();
});
