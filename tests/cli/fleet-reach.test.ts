import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";

import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfig } from "../../src/config/config.js";
import { exclusionCollector } from "../../src/route/preference.js";
import { makeRepo } from "../helpers/tmprepo.js";

// OBS-994/FL-1: the fleet browser makes every deny scope visible with its reach, and cycles a
// model row's policy scope on Space rather than a flat binary in/out toggle (RULING-231-19 §3).

const KEYS = {
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  q: "q",
} as const;

type TestInput = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => TestInput;
  unref: () => TestInput;
};

function terminal() {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const directWrite = input.write.bind(input);
  const pending: string[] = [];
  let pumping = false;
  const pump = () => {
    const token = pending.shift();
    if (token === undefined) {
      pumping = false;
      return;
    }
    directWrite(token);
    setImmediate(pump);
  };
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pending.push(...(text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []));
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
    return true;
  }) as typeof input.write;
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 140,
    rows: 60,
    write(chunk: string) {
      if (chunk && writes.at(-1) !== chunk) writes.push(chunk);
      return true;
    },
    on() { return output; },
    off() { return output; },
    removeListener() { return output; },
  };
  return { input, output: output as unknown as NodeJS.WriteStream, writes };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function setup() {
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    "      fake-1: mid",
    "      fake-2: mid",
    "      fake-3: mid",
    "      fake-4: mid",
    "      fake-5: mid",
    "routing:",
    "  deny:",
    "    workers:",
    "      models:",
    "        - fake:fake-2  # operator-directed worker-only ban",
    "        - fake:fake-4",
    "",
  ].join("\n"));
  const scriptPath = join(repo, "fake.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {} }));
  const adapter = new FakeAdapter(scriptPath);
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5"],
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        // OBS-972/FL-1: a resolved alias no deny covers — flags uncovered
        "fake-3": { authed: true, probedAt: "2026-09-12T00:00:00.000Z", identity: "resolved-3" },
        // a resolved alias its OWN workers-deny entry above also covers — no flag
        "fake-4": { authed: true, probedAt: "2026-09-12T00:00:00.000Z", identity: "resolved-4" },
        "fake-5": { authed: false, reason: "quota exceeded", probedAt: "2026-09-12T00:00:00.000Z" },
      },
    },
  });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-g-"));
  return { repo, adapter, globalDir };
}

test("test: a config with a workers-only deny opens in the fleet browser showing that channel out for workers and in for judge and review with the reason naming the workers models path, Space on an in row cycles it to out workers then out all seats then in with every other scope's reason untouched, a resolved alias row that no deny covers shows both its resolved identity and the uncovered flag while a resolved alias a deny covers shows its identity without the flag, and an unauthed row shows the re-probe caption and keeps its reach on Space, so a browser that hides the workers scope or clears every reason on one toggle fails", async () => {
  const { repo, adapter, globalDir } = setup();
  const io = terminal();
  const done = fleet(["--global-dir", globalDir], repo, [adapter], { input: io.input, output: io.output, debug: true } as unknown as FleetIO);

  // row order: fake-1, fake-2, fake-3, fake-4, fake-5 (classified, insertion order); the browser
  // opens with the cursor on fake-1.
  io.input.write(
    KEYS.down // → fake-2 (workers-only denied on disk, before any toggle)
      + KEYS.up // → back to fake-1 ("in")
      + KEYS.space // in → out(workers)
      + KEYS.space // out(workers) → out(all seats)
      + KEYS.space // out(all seats) → in
      + KEYS.down // → fake-2 again — its reason must have survived fake-1's whole cycle
      + KEYS.down // → fake-3 (resolved alias, uncovered)
      + KEYS.down // → fake-4 (resolved alias, covered by its own workers-deny entry)
      + KEYS.down // → fake-5 (unauthed)
      + KEYS.space // Space on the unauthed row — must not toggle its reach
      + KEYS.q + KEYS.q,
  );
  const out = await done;
  expect(out).toBe("fleet: quit without writing");

  const frames = io.writes.map(strip);
  const findFrom = (from: number, needle: string): number => {
    const rel = frames.slice(from).findIndex((f) => f.includes(needle));
    return rel === -1 ? -1 : from + rel;
  };

  const untouchedWitness = "out · workers only (judge/review/consult unaffected) — routing.deny.workers.models";

  // fake-2 opens already reach out(workers), in for judge/review/consult, the reason naming the
  // workers models path — read before fake-1 is touched at all
  const fake2Before = findFrom(0, untouchedWitness);
  expect(fake2Before).toBeGreaterThanOrEqual(0);

  // back on fake-1 ("in") after the Up
  const fake1In = findFrom(fake2Before + 1, "reach: in — Space cycles to out · workers");
  expect(fake1In).toBeGreaterThan(fake2Before);

  // Space #1: in → out(workers)
  const outWorkers = findFrom(fake1In + 1, "reach: out · workers only");
  expect(outWorkers).toBeGreaterThan(fake1In);
  expect(frames[outWorkers]).toContain("routing.deny.workers.models");

  // Space #2: out(workers) → out(all seats)
  const outAll = findFrom(outWorkers + 1, "reach: out · all seats");
  expect(outAll).toBeGreaterThan(outWorkers);
  // LEG2-T3 finding 1: the reason is the collector's over the candidate policy — fake-1 is in the
  // probe universe, so the all-seats exclusion the writer stages is the routing.allow form
  expect(frames[outAll]).toContain("routing.allow (not admitted)");
  expect(frames[outAll]).not.toContain("routing.deny.workers.models");

  // Space #3: out(all seats) → in
  const backToIn = findFrom(outAll + 1, "reach: in — Space cycles to out · workers");
  expect(backToIn).toBeGreaterThan(outAll);

  // fake-2's reason survived fake-1's entire three-press cycle, untouched
  const fake2After = findFrom(backToIn + 1, untouchedWitness);
  expect(fake2After).toBeGreaterThan(backToIn);

  // fake-3: a resolved alias no deny covers — identity shown, uncovered flag present
  const fake3 = findFrom(fake2After + 1, "resolved identity resolved-3");
  expect(fake3).toBeGreaterThan(fake2After);
  expect(frames[fake3]).toContain("resolved identity resolved-3 — no deny entry covers it");

  // fake-4: a resolved alias its OWN workers-deny entry covers — identity shown, no flag
  const fake4 = findFrom(fake3 + 1, "resolved identity resolved-4");
  expect(fake4).toBeGreaterThan(fake3);
  expect(frames[fake4]).not.toContain("no deny entry covers it");

  // fake-5: unauthed — re-probe caption, and Space (pressed once) never changes it
  const fake5Before = findFrom(fake4 + 1, "re-probe with tickmarkr doctor");
  expect(fake5Before).toBeGreaterThan(fake4);
  const fake5After = findFrom(fake5Before + 1, "re-probe with tickmarkr doctor");
  expect(fake5After).toBeGreaterThan(fake5Before);
});

// ── Leg-2 T3 fix leg (LEG2-T3-ASTRA findings 1 and 3) ──────────────────────────────────────────

// channels() reads cfg.tiers, so the probe universe is exactly the classified rows below.
const tierAdapter: WorkerAdapter = {
  id: "fake",
  vendor: "fake",
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: (cfg) => channelsFromConfig("fake", cfg),
  headlessCommand: () => "fake",
  interactiveCommand: () => null,
  invoke: () => ({ command: "fake" }),
  parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  listModels: async () => [],
};

function policyRepo(models: string[], routing: string[], identities: Record<string, string> = {}) {
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  const overlay = [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    ...models.map((m) => `      ${m}: mid`),
    "routing:",
    ...routing,
    "",
  ].join("\n");
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), overlay);
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models,
      modelAuth: Object.fromEntries(models.map((m) => [m, {
        authed: true,
        probedAt: "2026-09-12T00:00:00.000Z",
        ...(identities[m] ? { identity: identities[m] } : {}),
      }])),
    },
  });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-g-"));
  return { repo, globalDir, overlay };
}

async function browse(repo: string, globalDir: string, keys: string, columns = 200, adapters: WorkerAdapter[] = [tierAdapter]) {
  const io = terminal();
  (io.output as unknown as { columns: number }).columns = columns;
  const done = fleet(["--global-dir", globalDir], repo, adapters, { input: io.input, output: io.output, debug: true } as unknown as FleetIO);
  io.input.write(keys);
  const out = await done;
  return { out, frames: io.writes.map(strip) };
}

const rowLine = (frames: string[], label: string): string | undefined =>
  frames.flatMap((f) => f.split("\n")).find((line) => line.includes(label));

test("finding 1: reach and every reason come from the exclusion collector over the staged policy and the recorded identity — identity, bare-model and adapter:identity workers entries, a distinct allow reach, and every scope that excludes a channel render on its row", async () => {
  const { repo, globalDir } = policyRepo(
    ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5"],
    [
      "  allow:",
      "    models: [fake:fake-1, fake:fake-2, fake:fake-3, fake:fake-4]",
      "  deny:",
      "    models: [fake:fake-4]",
      "    workers:",
      "      models: [r1, fake:r2, fake-3, fake:fake-4]",
    ],
    { "fake-1": "r1", "fake-2": "r2" },
  );
  const { out, frames } = await browse(repo, globalDir, KEYS.down.repeat(4) + KEYS.q);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  const workersOnly = "reach: out · workers only (judge/review/consult unaffected) — ";
  // the recorded identity, the bare model id and adapter:identity each exclude the worker seat
  expect(all).toContain(`${workersOnly}routing.deny.workers.models (r1)`);
  expect(all).toContain(`${workersOnly}routing.deny.workers.models (fake:r2)`);
  expect(all).toContain(`${workersOnly}routing.deny.workers.models (fake-3)`);
  // a channel two scopes exclude lists both, never only the first match
  expect(all).toContain("reach: out · all seats — routing.deny.models (fake:fake-4); routing.deny.workers.models (fake:fake-4)");
  // the allowlist is its own reach with its own config path
  expect(all).toContain("reach: out · all seats · allow — routing.allow (not admitted)");
  // every row carries a textual reach cell, not only the selected row's detail line
  expect(rowLine(frames, "fake/fake-1")).toContain("out workers");
  expect(rowLine(frames, "fake/fake-3")).toContain("out workers");
  expect(rowLine(frames, "fake/fake-4")).toContain("out all");
  expect(rowLine(frames, "fake/fake-5")).toContain("out allow");
  // both resolved identities are covered by a workers entry — no uncovered flag on either
  expect(all).toContain("resolved identity r1");
  expect(all).not.toContain("no deny entry covers it");
});

test("finding 3: Space edits only the selected channel's own entry — an adapter-wide workers scope and its sibling channel keep their reason, and an adapter-wide flat deny is never cleared from a channel row", async () => {
  // A) workers.adapters [fake] + workers.models [fake:fake-1]: Space on fake-1 moves ONLY its own key
  const a = policyRepo(["fake-1", "fake-2"], [
    "  deny:",
    "    workers:",
    "      adapters: [fake] # every fake channel stays off the worker seat",
    "      models: [fake:fake-1]",
  ]);
  const moved = await browse(a.repo, a.globalDir, KEYS.space + KEYS.down + "w" + "y");
  expect(moved.out).toMatch(/^fleet: wrote /);
  const cfg = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(cfg.routing.deny?.workers?.adapters).toEqual(["fake"]);
  expect(readFileSync(join(a.repo, ".tickmarkr", "config.yaml"), "utf8"))
    .toContain("adapters: [fake] # every fake channel stays off the worker seat");
  const fake2 = { adapter: "fake", model: "fake-2" };
  expect(exclusionCollector(fake2, cfg.routing, "judge")).toEqual([]);
  expect(exclusionCollector(fake2, cfg.routing, "worker").map((s) => s.configPath)).toEqual(["routing.deny.workers.adapters"]);
  expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfg.routing, "judge")).not.toEqual([]);
  expect(moved.frames.join("\n")).toContain(
    "reach: out · workers only (judge/review/consult unaffected) — routing.deny.workers.adapters (fake)",
  );

  // B) an adapter-wide flat deny: Space on fake-1 names the shared scope and changes nothing
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake]"]);
  const refused = await browse(b.repo, b.globalDir, KEYS.space + KEYS.down + KEYS.q + KEYS.q);
  expect(refused.out).toBe("fleet: quit without writing");
  const noticeAt = refused.frames.findIndex((f) => f.includes("Space edits only this channel's own entries"));
  expect(noticeAt).toBeGreaterThanOrEqual(0);
  expect(refused.frames[noticeAt]).toContain("routing.deny.adapters (fake)");
  expect(refused.frames.slice(noticeAt).join("\n")).toContain("reach: out · all seats — routing.deny.adapters (fake)");
  expect(readFileSync(join(b.repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(b.overlay);
});

test("judge c3: one Space press re-scopes or clears exactly ONE of a channel's own entries — its adapter:model key first — while its identity and bare-model entries keep their reasons, and the row names the one entry it edited", async () => {
  // A) out-workers by three own entries: one press moves only fake:fake-1 to the flat scope
  const a = policyRepo(["fake-1", "fake-2"], [
    "  deny:",
    "    workers:",
    "      models: [r1, fake-1, fake:fake-1]",
  ], { "fake-1": "r1" });
  const moved = await browse(a.repo, a.globalDir, KEYS.space + "w" + "y");
  expect(moved.out).toMatch(/^fleet: wrote /);
  expect(moved.frames.join("\n")).toContain("space: moved fake:fake-1 to routing.deny.models");
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(cfgA.routing.deny?.workers?.models).toEqual(["fake-1", "r1"]);
  expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfgA.routing, "judge")).not.toEqual([]);

  // B) out-all by two own flat entries: one press clears only the adapter:model key
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [r1, fake:fake-1]"], { "fake-1": "r1" });
  const cleared = await browse(b.repo, b.globalDir, KEYS.space + "w" + "y");
  expect(cleared.out).toMatch(/^fleet: wrote /);
  expect(cleared.frames.join("\n")).toContain("space: cleared fake:fake-1 from routing.deny.models");
  const cfgB = loadConfig(b.repo, { globalDir: b.globalDir });
  // the remaining deny reason is the authored r1 (the allow form may restate the same exclusion)
  expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfgB.routing, "judge")
    .filter((s) => s.by === "deny").map((s) => s.entry)).toEqual(["r1"]);
});

// ── Leg-2 T3 round 2 (LEG2-T3-ASTRA-2 findings 1–3, R111) ─────────────────────────────────────

const ROLES = ["worker", "judge", "review", "consult"] as const;

test("round 2 finding 1: promoting a bare-model workers deny widens that ban to every seat serving the model — on every adapter — and never removes it", async () => {
  const twinAdapter: WorkerAdapter = { ...tierAdapter, id: "twin", vendor: "twin", channels: (cfg) => channelsFromConfig("twin", cfg) };
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    "      fake-1: mid",
    "      fake-2: mid",
    "  twin:",
    "    vendor: twin",
    "    channel: sub",
    "    models:",
    "      fake-1: mid",
    "routing:",
    "  deny:",
    "    workers:",
    "      models: [fake-1]",
    "",
  ].join("\n"));
  const authed = { authed: true, probedAt: "2026-09-12T00:00:00.000Z" };
  registry.writeDoctor(repo, {
    fake: { installed: true, authed: true, version: "fake", models: ["fake-1", "fake-2"], modelAuth: { "fake-1": authed, "fake-2": authed } },
    twin: { installed: true, authed: true, version: "twin", models: ["fake-1"], modelAuth: { "fake-1": authed } },
  });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-g-"));
  const { out } = await browse(repo, globalDir, KEYS.space + "w" + "y", 200, [tierAdapter, twinAdapter]);
  expect(out).toMatch(/^fleet: wrote /);
  const cfg = loadConfig(repo, { globalDir });
  for (const role of ROLES) {
    expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfg.routing, role), `fake:fake-1 ${role}`).not.toEqual([]);
    expect(exclusionCollector({ adapter: "twin", model: "fake-1" }, cfg.routing, role), `twin:fake-1 ${role}`).not.toEqual([]);
    expect(exclusionCollector({ adapter: "fake", model: "fake-2" }, cfg.routing, role), `fake:fake-2 ${role}`).toEqual([]);
  }
});

test("round 2 finding 2: one Space press clears exactly ONE authored flat reason — an identical key in the other flat list, or a second spelling in the same list, keeps its reason through the write and on the browser row", async () => {
  // A) the same key authored in both flat lists
  const a = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake:fake-1] # keep this reason", "    models: [fake:fake-1]"]);
  const one = await browse(a.repo, a.globalDir, KEYS.space + "w" + "y");
  expect(one.out).toMatch(/^fleet: wrote /);
  expect(one.frames.join("\n")).toContain("reach: out · all seats — routing.deny.adapters (fake:fake-1)");
  expect(readFileSync(join(a.repo, ".tickmarkr", "config.yaml"), "utf8")).toContain("adapters: [fake:fake-1] # keep this reason");
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfgA.routing, "judge").map((s) => `${s.configPath} ${s.entry}`))
    .toContain("routing.deny.adapters fake:fake-1");

  // B) two covered spellings in one flat list: the press clears the adapter:model key, the bare id stays authored
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake-1, fake:fake-1]"]);
  const two = await browse(b.repo, b.globalDir, KEYS.space + "w" + "y");
  expect(two.out).toMatch(/^fleet: wrote /);
  expect(loadConfig(b.repo, { globalDir: b.globalDir }).routing.deny?.models).toEqual(["fake-1"]);
});

test("round 2 finding 3: an alias admitted by its resolved identity — bare or qualified — keeps its admission when a sibling channel is taken out of the fleet", async () => {
  for (const spelling of ["r1", "fake:r1"]) {
    const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  allow:", `    models: [${spelling}, fake:fake-2]`], { "fake-1": "r1" });
    const { out } = await browse(repo, globalDir, KEYS.down + KEYS.space + KEYS.space + "w" + "y");
    expect(out, spelling).toMatch(/^fleet: wrote /);
    const cfg = loadConfig(repo, { globalDir });
    for (const role of ROLES) {
      expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfg.routing, role), `${spelling} ${role}`).toEqual([]);
    }
    expect(exclusionCollector({ adapter: "fake", model: "fake-2" }, cfg.routing, "judge"), spelling).not.toEqual([]);
  }
});
