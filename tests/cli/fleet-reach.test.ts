import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";

import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { DENY_SCOPES, type DenyScope, denyEntriesAt, loadConfig } from "../../src/config/config.js";
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

// OBS-1099: Space opens the reach picker (cursor on in · out workers · out all seats); Enter sets it
const REACH_IN = KEYS.space + "\r";
const REACH_WORKERS = KEYS.space + KEYS.down + "\r";
const REACH_ALL = KEYS.space + KEYS.down + KEYS.down + "\r";

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
      + REACH_WORKERS // in → out(workers)
      + REACH_ALL // out(workers) → out(all seats)
      + REACH_IN // out(all seats) → in
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
  const fake1In = findFrom(fake2Before + 1, "reach: in — Space picks out · workers");
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
  const backToIn = findFrom(outAll + 1, "reach: in — Space picks out · workers");
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
  const moved = await browse(a.repo, a.globalDir, REACH_ALL + KEYS.down + "w" + "y");
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
  const refused = await browse(b.repo, b.globalDir, REACH_IN + KEYS.down + KEYS.q + KEYS.q);
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
  const moved = await browse(a.repo, a.globalDir, REACH_ALL + "w" + "y");
  expect(moved.out).toMatch(/^fleet: wrote /);
  expect(moved.frames.join("\n")).toContain("space: moved fake:fake-1 to routing.deny.models");
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(cfgA.routing.deny?.workers?.models).toEqual(["fake-1", "r1"]);
  expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfgA.routing, "judge")).not.toEqual([]);

  // B) out-all by two own flat entries: one press clears only the adapter:model key
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [r1, fake:fake-1]"], { "fake-1": "r1" });
  const cleared = await browse(b.repo, b.globalDir, REACH_IN + "w" + "y");
  expect(cleared.out).toMatch(/^fleet: wrote /);
  expect(cleared.frames.join("\n")).toContain("space: cleared fake:fake-1 from routing.deny.models");
  const cfgB = loadConfig(b.repo, { globalDir: b.globalDir });
  // the remaining deny reason is the authored r1 (the allow form may restate the same exclusion)
  expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfgB.routing, "judge")
    .filter((s) => s.by === "deny").map((s) => s.entry)).toEqual(["r1"]);
});

// ── Leg-2 T3 round 2 (LEG2-T3-ASTRA-2 findings 1–3, R111) ─────────────────────────────────────

const ROLES = ["worker", "judge", "review", "consult"] as const;

test("round 2 finding 1 (revised by OBS-1099): a bare-model workers deny shared with a sibling adapter is refused on promotion rather than widened to its sibling", async () => {
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
  // OBS-1099: the bare id covers twin:fake-1 too, so promoting it from the fake:fake-1 row is
  // refused by name — the shared entry is neither widened for its sibling nor doubled by a flat deny
  const before = readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");
  const { out, frames } = await browse(repo, globalDir, REACH_ALL + KEYS.q + KEYS.q, 200, [tierAdapter, twinAdapter]);
  expect(out).toBe("fleet: quit without writing");
  const notice = frames.find((f) => f.includes("Space edits only this channel's own entries"));
  expect(notice).toBeDefined();
  expect(notice).toContain("fake:fake-1 stays out · workers — routing.deny.workers.models (fake-1)");
  expect(frames.join("\n")).not.toContain("to routing.deny.models");
  expect(readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8")).toBe(before);
  const cfg = loadConfig(repo, { globalDir });
  for (const channel of [{ adapter: "fake", model: "fake-1" }, { adapter: "twin", model: "fake-1" }]) {
    expect(exclusionCollector(channel, cfg.routing, "worker"), `${channel.adapter}:fake-1 worker`).not.toEqual([]);
    expect(exclusionCollector(channel, cfg.routing, "judge"), `${channel.adapter}:fake-1 judge`).toEqual([]);
  }
});

test("round 2 finding 2: one Space press clears exactly ONE authored flat reason — an identical key in the other flat list, or a second spelling in the same list, keeps its reason through the write and on the browser row", async () => {
  // A) the same key authored in both flat lists
  const a = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake:fake-1] # keep this reason", "    models: [fake:fake-1]"]);
  const one = await browse(a.repo, a.globalDir, REACH_IN + "w" + "y");
  expect(one.out).toMatch(/^fleet: wrote /);
  expect(one.frames.join("\n")).toContain("reach: out · all seats — routing.deny.adapters (fake:fake-1)");
  expect(readFileSync(join(a.repo, ".tickmarkr", "config.yaml"), "utf8")).toContain("adapters: [fake:fake-1] # keep this reason");
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfgA.routing, "judge").map((s) => `${s.configPath} ${s.entry}`))
    .toContain("routing.deny.adapters fake:fake-1");

  // B) two covered spellings in one flat list: the press clears the adapter:model key, the bare id stays authored
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake-1, fake:fake-1]"]);
  const two = await browse(b.repo, b.globalDir, REACH_IN + "w" + "y");
  expect(two.out).toMatch(/^fleet: wrote /);
  expect(loadConfig(b.repo, { globalDir: b.globalDir }).routing.deny?.models).toEqual(["fake-1"]);
});

test("round 2 finding 3: an alias admitted by its resolved identity — bare or qualified — keeps its admission when a sibling channel is taken out of the fleet", async () => {
  for (const spelling of ["r1", "fake:r1"]) {
    const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  allow:", `    models: [${spelling}, fake:fake-2]`], { "fake-1": "r1" });
    const { out } = await browse(repo, globalDir, KEYS.down + REACH_ALL + "w" + "y");
    expect(out, spelling).toMatch(/^fleet: wrote /);
    const cfg = loadConfig(repo, { globalDir });
    for (const role of ROLES) {
      expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfg.routing, role), `${spelling} ${role}`).toEqual([]);
    }
    expect(exclusionCollector({ adapter: "fake", model: "fake-2" }, cfg.routing, "judge"), spelling).not.toEqual([]);
  }
});

// ── OBS-1046: one Space press edits one reason; an untouched scope keeps its bytes ────────────

const overlayOf = (repo: string) => readFileSync(join(repo, ".tickmarkr", "config.yaml"), "utf8");

test("test: over a universe of two channels with allow models naming the second and deny models naming the first the browser shows two reasons for the first, one Space press clears the deny reason alone, the written overlay keeps routing.allow, and the loaded policy still excludes the first channel by allow in every role, so a press that removes both reasons fails", async () => {
  const { repo, globalDir } = policyRepo(["one", "two"], ["  allow:", "    models: [fake:two]", "  deny:", "    models: [fake:one]"]);
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  // two reasons on the row before the press: the allow exclusion and the authored deny
  const line = rowLine(frames, "reach: out · all seats — ");
  expect(line).toContain("routing.allow");
  expect(line).toContain("routing.deny.models (fake:one)");
  // one press clears the deny reason alone; routing.allow survives the write
  expect(rowLine(frames, "space: cleared fake:one from routing.deny.models")).toBeDefined();
  const written = overlayOf(repo);
  expect(written).toContain("allow:");
  expect(written).toContain("models: [fake:two]");
  const cfg = loadConfig(repo, { globalDir });
  expect(cfg.routing.allow?.models).toEqual(["fake:two"]);
  expect(cfg.routing.deny?.models).toBeUndefined();
  for (const role of ROLES) {
    const scopes = exclusionCollector({ adapter: "fake", model: "one" }, cfg.routing, role);
    expect(scopes.map((s) => s.by), role).toEqual(["allow"]);
    expect(exclusionCollector({ adapter: "fake", model: "two" }, cfg.routing, role), role).toEqual([]);
  }
});

test("test: through the production browser and writer, adding a channel to an initially empty deny models scope keeps the untouched empty adapters list and its trailing comment byte for byte, clearing the only entry of a populated deny adapters scope keeps the untouched empty models list and its comment byte for byte while the cleared scope becomes a null tombstone, the same two transitions hold with the scopes swapped, and the reloaded policy shows exactly the staged reach each time, so a writer that turns an untouched empty list into null or demands a tombstone for an addition fails", async () => {
  const outFor = (cfg: ReturnType<typeof loadConfig>, model: string) =>
    exclusionCollector({ adapter: "fake", model }, cfg.routing, "judge").length > 0;
  for (const [added, cleared] of [["models", "adapters"], ["adapters", "models"]] as const) {
    // addition: two presses take fake:one to out(all) — the exclusion rides the allow form and
    // BOTH explicit empty lists keep their bytes (no tombstone for an addition)
    const a = policyRepo(["one", "two"], ["  deny:", `    ${added}: []`, `    ${cleared}: [] # keep explicit empty list`]);
    const one = await browse(a.repo, a.globalDir, REACH_ALL + "w" + "y");
    expect(one.out, `add via ${added}`).toMatch(/^fleet: wrote /);
    const addedBytes = overlayOf(a.repo);
    expect(addedBytes).toContain(`    ${cleared}: [] # keep explicit empty list\n`);
    expect(addedBytes).toContain(`    ${added}: []\n`);
    expect(addedBytes).not.toContain("null");
    const addedCfg = loadConfig(a.repo, { globalDir: a.globalDir });
    expect([outFor(addedCfg, "one"), outFor(addedCfg, "two")], `add via ${added}`).toEqual([true, false]);

    // clear: the only entry of the populated scope goes, that scope tombstones, the sibling empty
    // list and its comment survive byte for byte
    const b = policyRepo(["one", "two"], ["  deny:", `    ${cleared}: [fake:one]`, `    ${added}: [] # keep explicit empty list`]);
    const two = await browse(b.repo, b.globalDir, REACH_IN + "w" + "y");
    expect(two.out, `clear ${cleared}`).toMatch(/^fleet: wrote /);
    const clearedBytes = overlayOf(b.repo);
    expect(clearedBytes).toContain(`    ${added}: [] # keep explicit empty list\n`);
    expect(clearedBytes).toContain(`    ${cleared}: null`);
    const clearedCfg = loadConfig(b.repo, { globalDir: b.globalDir });
    expect([outFor(clearedCfg, "one"), outFor(clearedCfg, "two")], `clear ${cleared}`).toEqual([false, false]);
  }
}, 90_000); // four production browser sessions

// ── OBS-1099 items 1 and 4: the reach picker — one selected reason per act, never a cycle ─────

const EMPTY_DENY = ["  deny:", "    models: []"];
const RAIL_FAKE = "\x1b[D" + KEYS.down + KEYS.down + KEYS.down; // rail: All models · Shapes · Steering · fake
const outFor = (cfg: ReturnType<typeof loadConfig>, model: string, role: (typeof ROLES)[number]) =>
  exclusionCollector({ adapter: "fake", model }, cfg.routing, role).length > 0;
const denyEntries = (cfg: ReturnType<typeof loadConfig>) => ({
  adapters: cfg.routing.deny?.adapters ?? [],
  models: cfg.routing.deny?.models ?? [],
  workersAdapters: cfg.routing.deny?.workers?.adapters ?? [],
  workersModels: cfg.routing.deny?.workers?.models ?? [],
});

test("test: choosing in on a worker denied model row holding one deny reason clears that routing.deny.workers.models entry in one act with no routing.deny.models entry staged at any point, so a picker that passes through a full deny fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-1]"]);
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  const all = frames.join("\n");
  expect(rowLine(frames, "space: cleared fake:fake-1 from routing.deny.workers.models")).toBeDefined();
  // no frame ever staged, named, or wrote a flat deny for the row — the act never passed through out · all seats
  expect(all).not.toContain("to routing.deny.models");
  expect(all).not.toContain("routing.deny.models (fake:fake-1)");
  expect(all).not.toContain("reach: out · all seats");
  expect(overlayOf(repo)).not.toContain("allow");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  for (const role of ROLES) expect(outFor(cfg, "fake-1", role), role).toBe(false);
});

test("test: choosing out for all seats on an in model row stages routing.deny.models alone whereas choosing out for workers stages routing.deny.workers.models alone, so a choice that writes both scopes fails", async () => {
  const a = policyRepo(["fake-1", "fake-2"], EMPTY_DENY);
  const all = await browse(a.repo, a.globalDir, REACH_ALL + "w" + "y");
  expect(all.out).toMatch(/^fleet: wrote /);
  expect(rowLine(all.frames, "space: added fake:fake-1 to routing.deny.models")).toBeDefined();
  expect(all.frames.join("\n")).not.toContain("routing.deny.workers.models");
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  // the writer spells an all-seats exclusion in the allow form; no workers scope rides along
  expect(denyEntries(cfgA).workersModels).toEqual([]);
  expect(denyEntries(cfgA).workersAdapters).toEqual([]);
  for (const role of ROLES) expect(outFor(cfgA, "fake-1", role), role).toBe(true);
  expect(outFor(cfgA, "fake-2", "worker")).toBe(false);

  const b = policyRepo(["fake-1", "fake-2"], EMPTY_DENY);
  const workers = await browse(b.repo, b.globalDir, REACH_WORKERS + "w" + "y");
  expect(workers.out).toMatch(/^fleet: wrote /);
  expect(rowLine(workers.frames, "space: added fake:fake-1 to routing.deny.workers.models")).toBeDefined();
  expect(workers.frames.join("\n")).not.toContain("to routing.deny.models");
  const cfgB = loadConfig(b.repo, { globalDir: b.globalDir });
  expect(denyEntries(cfgB)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: ["fake:fake-1"] });
  expect(cfgB.routing.allow).toBeUndefined();
  expect(outFor(cfgB, "fake-1", "worker")).toBe(true);
  for (const role of ["judge", "review", "consult"] as const) expect(outFor(cfgB, "fake-1", role), role).toBe(false);
});

test("test: choosing out for all seats on an out for workers row moves that one entry from routing.deny.workers.models to routing.deny.models whereas choosing out for workers on an out for all row moves it back, so a transition that adds a second entry fails", async () => {
  const a = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-1]"]);
  const promoted = await browse(a.repo, a.globalDir, REACH_ALL + "w" + "y");
  expect(promoted.out).toMatch(/^fleet: wrote /);
  expect(rowLine(promoted.frames, "space: moved fake:fake-1 to routing.deny.models")).toBeDefined();
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(denyEntries(cfgA).workersModels).toEqual([]);
  for (const role of ROLES) expect(outFor(cfgA, "fake-1", role), role).toBe(true);
  // exactly one exclusion reason remains on the row for the worker seat — never a second entry
  expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfgA.routing, "worker")).toHaveLength(1);

  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake:fake-1]"]);
  const demoted = await browse(b.repo, b.globalDir, REACH_WORKERS + "w" + "y");
  expect(demoted.out).toMatch(/^fleet: wrote /);
  expect(rowLine(demoted.frames, "space: moved fake:fake-1 to routing.deny.workers.models")).toBeDefined();
  const cfgB = loadConfig(b.repo, { globalDir: b.globalDir });
  expect(denyEntries(cfgB)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: ["fake:fake-1"] });
  expect(cfgB.routing.allow).toBeUndefined();
  expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfgB.routing, "worker")).toHaveLength(1);
  for (const role of ["judge", "review", "consult"] as const) expect(outFor(cfgB, "fake-1", role), role).toBe(false);
});

test("test: an adapter rail row offers the same three reach choices and out for workers stages routing.deny.workers.adapters while in clears it, so an adapter row limited to the flat deny fails", async () => {
  const a = policyRepo(["fake-1", "fake-2"], EMPTY_DENY);
  const workers = await browse(a.repo, a.globalDir, RAIL_FAKE + REACH_WORKERS + "w" + "y");
  expect(workers.out).toMatch(/^fleet: wrote /);
  const picker = workers.frames.find((f) => f.includes("reach · fake\n") || f.includes("reach · fake "));
  expect(picker).toBeDefined();
  for (const choice of ["in", "out · workers", "out · all seats"]) expect(picker).toContain(choice);
  expect(workers.frames.join("\n")).toContain("space: added fake to routing.deny.workers.adapters");
  const cfgA = loadConfig(a.repo, { globalDir: a.globalDir });
  expect(denyEntries(cfgA)).toEqual({ adapters: [], models: [], workersAdapters: ["fake"], workersModels: [] });
  expect(cfgA.routing.allow).toBeUndefined();
  for (const model of ["fake-1", "fake-2"]) {
    expect(outFor(cfgA, model, "worker"), model).toBe(true);
    expect(outFor(cfgA, model, "judge"), model).toBe(false);
  }

  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake]"]);
  const back = await browse(b.repo, b.globalDir, RAIL_FAKE + REACH_IN + "w" + "y");
  expect(back.out).toMatch(/^fleet: wrote /);
  expect(back.frames.join("\n")).toContain("space: cleared fake from routing.deny.workers.adapters");
  const cfgB = loadConfig(b.repo, { globalDir: b.globalDir });
  expect(denyEntries(cfgB)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  for (const role of ROLES) expect(outFor(cfgB, "fake-1", role), role).toBe(false);
});

test("test: a choice on a row whose only reason is a shared entry covering a sibling channel is refused naming that entry whereas a row holding two reasons clears one then shows its recomputed reach naming the remaining reason, so a picker that edits a sibling or claims in early fails", async () => {
  // A) the only reason is the adapter-wide workers entry — shared with fake-2 — so in is refused by name
  const a = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake] # shared"]);
  const refused = await browse(a.repo, a.globalDir, REACH_IN + KEYS.q + KEYS.q);
  expect(refused.out).toBe("fleet: quit without writing");
  const notice = refused.frames.find((f) => f.includes("Space edits only this channel's own entries"));
  expect(notice).toBeDefined();
  expect(notice).toContain("fake:fake-1 stays out · workers — routing.deny.workers.adapters (fake)");
  expect(overlayOf(a.repo)).toBe(a.overlay);
  // the out · all seats choice is refused by the same name — no fresh routing.deny.models entry
  // rides beside the shared workers reason
  const refusedAll = await browse(a.repo, a.globalDir, REACH_ALL + KEYS.q + KEYS.q);
  expect(refusedAll.out).toBe("fleet: quit without writing");
  const noticeAll = refusedAll.frames.find((f) => f.includes("Space edits only this channel's own entries"));
  expect(noticeAll).toContain("fake:fake-1 stays out · workers — routing.deny.workers.adapters (fake)");
  expect(refusedAll.frames.join("\n")).not.toContain("to routing.deny.models");
  expect(overlayOf(a.repo)).toBe(a.overlay);

  // B) two reasons — its own workers entry AND the shared adapter-wide one: in clears the own entry
  // only, and the row's recomputed reach names the reason that remains
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake] # shared", "      models: [fake:fake-1]"]);
  const cleared = await browse(b.repo, b.globalDir, REACH_IN + "w" + "y");
  expect(cleared.out).toMatch(/^fleet: wrote /);
  const edited = rowLine(cleared.frames, "space: cleared fake:fake-1 from routing.deny.workers.models");
  expect(edited).toBeDefined();
  expect(edited).toContain("still out: routing.deny.workers.adapters (fake)");
  expect(edited).not.toContain("reach: in");
  expect(overlayOf(b.repo)).toContain("adapters: [fake] # shared");
  const cfg = loadConfig(b.repo, { globalDir: b.globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: ["fake"], workersModels: [] });
  for (const model of ["fake-1", "fake-2"]) expect(outFor(cfg, model, "worker"), model).toBe(true);
});

test("test: a staged reach choice reaches the review overlay and the written config as the one scope the picker named, so an edit that vanishes or widens before the writer fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], EMPTY_DENY);
  const { out, frames } = await browse(repo, globalDir, REACH_WORKERS + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  const review = frames.find((f) => f.includes("review ·"));
  expect(review).toBeDefined();
  // the diff carries exactly the picker's scope: the workers models entry, nothing flat, no allow
  expect(review).toContain("+    workers:");
  expect(review).toContain("+      models:");
  expect(review).toContain("+        - fake:fake-1");
  expect(review).not.toContain("allow");
  expect(review).not.toContain("adapters");
  const written = overlayOf(repo);
  expect(written).toContain("workers:");
  expect(written).toContain("- fake:fake-1");
  expect(written).not.toContain("allow");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: ["fake:fake-1"] });
  expect(cfg.routing.allow).toBeUndefined();
  expect(outFor(cfg, "fake-1", "worker")).toBe(true);
  expect(outFor(cfg, "fake-1", "judge")).toBe(false);
  expect(outFor(cfg, "fake-2", "worker")).toBe(false);
});

test("D-199: an adapter rail row holding two reasons — routing.deny.adapters and a bare adapter id in routing.deny.models — clears the adapter entry alone on in and its recomputed reach still names the model-scope reason, so a rail that claims in after one act fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake]", "    models: [fake] # covers every fake channel"]);
  const { out, frames } = await browse(repo, globalDir, RAIL_FAKE + REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  // the picker showed BOTH reasons before the act
  const picker = frames.find((f) => f.includes("reach · fake") && f.includes("now: out-all"));
  expect(picker).toBeDefined();
  expect(picker).toContain("routing.deny.adapters (fake)");
  expect(picker).toContain("routing.deny.models (fake)");
  const edited = rowLine(frames, "space: cleared fake from routing.deny.adapters");
  expect(edited).toBeDefined();
  expect(edited).toContain("still out: routing.deny.models (fake)");
  expect(overlayOf(repo)).toContain("models: [fake] # covers every fake channel");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: ["fake"], workersAdapters: [], workersModels: [] });
  for (const model of ["fake-1", "fake-2"]) for (const role of ROLES) expect(outFor(cfg, model, role), `${model} ${role}`).toBe(true);
});

test("OBS-1099 review: an adapter rail row out only through a bare adapter id in routing.deny.models refuses out for workers by name and reports out for all seats as already set, so a rail that stages a second reason while actual reach stays out-all fails", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake] # covers every fake channel"]);
  const refused = await browse(repo, globalDir, RAIL_FAKE + REACH_WORKERS + KEYS.q);
  expect(refused.out).toBe("fleet: quit without writing");
  const notice = refused.frames.find((f) => f.includes("the rail edits only fake's own adapter entries"));
  expect(notice).toBeDefined();
  expect(notice).toContain("fake stays out-all — routing.deny.models (fake)");
  expect(refused.frames.join("\n")).not.toContain("routing.deny.workers.adapters");
  expect(overlayOf(repo)).toBe(overlay);

  const already = await browse(repo, globalDir, RAIL_FAKE + REACH_ALL + KEYS.q);
  expect(already.out).toBe("fleet: quit without writing");
  expect(already.frames.join("\n")).toContain("fake is already out · all seats — routing.deny.models (fake)");
  expect(already.frames.join("\n")).not.toContain("to routing.deny.adapters");
  expect(overlayOf(repo)).toBe(overlay);
});

test("OBS-1099 review round 3: clearing an adapter rail deny while one channel keeps its own routing.deny.models entry names that channel's remaining reason and never reports the adapter in, so an aggregation that intersects channel reasons away fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake]", "    models: [fake:fake-1] # keep fake-1 out"]);
  const { out, frames } = await browse(repo, globalDir, RAIL_FAKE + REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  const picker = frames.find((f) => f.includes("reach · fake") && f.includes("now: out-all"));
  expect(picker).toContain("routing.deny.adapters (fake)");
  expect(picker).toContain("fake-1: routing.deny.models (fake:fake-1)");
  const edited = rowLine(frames, "space: cleared fake from routing.deny.adapters");
  expect(edited).toBeDefined();
  expect(edited).toContain("still out: fake-1: routing.deny.models (fake:fake-1)");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: ["fake:fake-1"], workersAdapters: [], workersModels: [] });
  expect(outFor(cfg, "fake-1", "worker")).toBe(true);
  expect(outFor(cfg, "fake-2", "worker")).toBe(false);
});

test("OBS-1099 review round 3: an adapter rail row held in routing.deny.workers.adapters but out for all seats through routing.deny.models refuses out for workers naming the remaining all-seat reason instead of claiming it already set, so a guard that trusts the held entry fails", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake]", "    workers:", "      adapters: [fake]"]);
  const { out, frames } = await browse(repo, globalDir, RAIL_FAKE + REACH_WORKERS + KEYS.q);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  expect(all).not.toContain("fake is already out · workers");
  expect(all).toContain("fake stays out-all — routing.deny.models (fake) — fake is already in routing.deny.workers.adapters");
  expect(overlayOf(repo)).toBe(overlay);
});

test("D-205: an adapter rail row whose channels disagree — one out for all seats by its own routing.deny.models entry, one in — shows a partial out-all reach naming that channel, marks no choice selected, and refuses in by name, so a rail that reduces mixed channels to the least-excluded and claims in fails", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake:fake-1] # keep fake-1 out"]);
  const { out, frames } = await browse(repo, globalDir, RAIL_FAKE + REACH_IN + KEYS.q);
  expect(out).toBe("fleet: quit without writing");
  const picker = frames.find((f) => f.includes("reach · fake") && f.includes("now: "));
  expect(picker).toBeDefined();
  expect(picker).toContain("now: out-all (partial: not every channel) — fake-1: routing.deny.models (fake:fake-1)");
  expect(picker).not.toContain("now: in");
  const all = frames.join("\n");
  expect(all).not.toContain("fake is already");
  expect(all).toContain("fake stays out-all (partial: not every channel) — fake-1: routing.deny.models (fake:fake-1) — the rail edits only fake's own adapter entries");
  expect(overlayOf(repo)).toBe(overlay);

  // out for all seats on the partial rail is one act that widens every channel — never "already"
  const widened = await browse(repo, globalDir, RAIL_FAKE + REACH_ALL + "w" + "y");
  expect(widened.out).toMatch(/^fleet: wrote /);
  expect(widened.frames.join("\n")).toContain("space: added fake to routing.deny.adapters");
  expect(widened.frames.join("\n")).not.toContain("fake is already");
  const cfg = loadConfig(repo, { globalDir });
  // the writer spells an all-seats adapter exclusion in the allow form; no workers scope rides along
  expect(denyEntries(cfg).workersAdapters).toEqual([]);
  expect(denyEntries(cfg).workersModels).toEqual([]);
  for (const model of ["fake-1", "fake-2"]) for (const role of ROLES) expect(outFor(cfg, model, role), `${model} ${role}`).toBe(true);
});

test("D-205: choosing in on a model row out for all seats by a shared routing.deny.adapters entry while holding its own routing.deny.workers.models entry clears the owned workers entry alone and names the shared adapter reason that remains, so an in branch that stops at the uneditable flat reason fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake] # shared", "    workers:", "      models: [fake:fake-1]"]);
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  const edited = rowLine(frames, "space: cleared fake:fake-1 from routing.deny.workers.models");
  expect(edited).toBeDefined();
  expect(edited).toContain("still out: routing.deny.adapters (fake)");
  expect(frames.join("\n")).not.toContain("Space edits only this channel's own entries");
  expect(overlayOf(repo)).toContain("adapters: [fake] # shared");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: ["fake"], models: [], workersAdapters: [], workersModels: [] });
  for (const model of ["fake-1", "fake-2"]) for (const role of ROLES) expect(outFor(cfg, model, role), `${model} ${role}`).toBe(true);
});

test("OBS-1099 review round 5: an adapter rail row whose channels are all out for all seats by mixed provenance — one by routing.deny.models, one by routing.allow — shows a uniform out-all reach with out · all seats selected and reports that choice as already set, so an aggregation that treats out-allow and out-all as different reaches fails", async () => {
  // allow admits only fake-2 (so fake-1 is out by allow); deny.models takes fake-2 out for all seats
  const { repo, globalDir, overlay } = policyRepo(["fake-1", "fake-2"], ["  allow:", "    models: [fake:fake-2]", "  deny:", "    models: [fake:fake-2]"]);
  const { out, frames } = await browse(repo, globalDir, RAIL_FAKE + REACH_ALL + KEYS.q);
  expect(out).toBe("fleet: quit without writing");
  const picker = frames.find((f) => f.includes("reach · fake") && f.includes("now: "));
  expect(picker).toBeDefined();
  expect(picker).toContain("now: out-all — ");
  expect(picker).not.toContain("partial");
  const all = frames.join("\n");
  expect(all).toContain("fake is already out · all seats");
  expect(all).not.toContain("to routing.deny.adapters");
  expect(overlayOf(repo)).toBe(overlay);
});

// ── OBS-1099 items 2 and 3, OBS-1065: covered aliases name their entry; the picker greys and lifts ──

// rail → Shapes (its first entry raises the presets overlay; Esc lands on the list) → implement
// (floor mid, so every mid channel is eligible) → p opens the candidate picker
const OPEN_IMPLEMENT_PICKER = "\x1b[D" + KEYS.down + "\r" + "\x1b" + KEYS.down + KEYS.down + "p";
const QUIT_NOW = "\x03";
const detailOf = (frames: string[], needle: string) => frames.flatMap((f) => f.split("\n")).find((line) => line.includes(needle));

test("test: a covered alias row whose covering explicit entry covers no other displayed channel names that entry and its scope on its detail line and a reach choice on that row edits it, so a row that edits an entry it never names fails", async () => {
  // fake-1 resolves to r1; the explicit id fake:r1 covers it through that identity and nothing else
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:r1]"], { "fake-1": "r1" });
  const viewed = await browse(repo, globalDir, KEYS.q);
  expect(viewed.out).toBe("fleet: quit without writing");
  const detail = detailOf(viewed.frames, "covered by ");
  expect(detail).toBeDefined();
  expect(detail).toContain("covered by routing.deny.workers.models (fake:r1) — Space edits that entry");
  expect(detail).not.toContain("shared");
  expect(viewed.frames.join("\n")).not.toContain("no deny entry covers it");
  // the reach choice edits exactly the entry the detail line named
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  expect(detailOf(frames, "space: cleared fake:r1 from routing.deny.workers.models")).toBeDefined();
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  expect(exclusionCollector({ adapter: "fake", model: "fake-1", identity: "r1" }, cfg.routing, "worker")).toEqual([]);
});

test("test: the owning action on a covered entry lists every identity it covers then stages the lift of that one logical entry which reaches the review overlay plus the written config whereas a reach choice on the alias row still refuses naming that control, so a lift that skips the listing or an owner that only refuses fails", async () => {
  // a bare identity entry r1 covers BOTH alias rows — a shared entry no row may edit alone
  const { repo, globalDir, overlay } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [r1]"], { "fake-1": "r1", "fake-2": "r1" });
  const refused = await browse(repo, globalDir, REACH_IN + KEYS.q + KEYS.q, 200);
  expect(refused.out).toBe("fleet: quit without writing");
  const notice = detailOf(refused.frames, "stays out · workers — ");
  expect(notice).toBeDefined();
  expect(notice).toContain("fake:fake-1 stays out · workers — routing.deny.workers.models (r1) covers 2 channels — Space edits only this channel's own entries; l lists and lifts it");
  expect(overlayOf(repo)).toBe(overlay);

  // l lists every identity the entry covers; Enter lifts that ONE entry through review to the writer
  const lifted = await browse(repo, globalDir, "l" + "\r" + "w" + "y");
  expect(lifted.out).toMatch(/^fleet: wrote /);
  const listing = lifted.frames.find((f) => f.includes("lift · routing.deny.workers.models (r1)"));
  expect(listing).toBeDefined();
  expect(listing).toContain("fake:fake-1 (r1)");
  expect(listing).toContain("fake:fake-2 (r1)");
  expect(detailOf(lifted.frames, "lift: cleared r1 from routing.deny.workers.models")).toBeDefined();
  const review = lifted.frames.find((f) => f.includes("review ·"));
  expect(review).toBeDefined();
  expect(review).toContain("r1");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  for (const model of ["fake-1", "fake-2"]) {
    expect(exclusionCollector({ adapter: "fake", model, identity: "r1" }, cfg.routing, "worker"), model).toEqual([]);
  }
});

test("test: an uncovered alias row still says no deny entry covers it whereas an alias covered by an adapter wide entry names that entry as shared and refuses the edit, so coverage claimed for an uncovered identity fails", async () => {
  const uncovered = policyRepo(["fake-1"], EMPTY_DENY, { "fake-1": "r1" });
  const plain = await browse(uncovered.repo, uncovered.globalDir, KEYS.q);
  expect(plain.out).toBe("fleet: quit without writing");
  expect(plain.frames.join("\n")).toContain("resolved identity r1 — no deny entry covers it");
  expect(plain.frames.join("\n")).not.toContain("covered by ");

  const wide = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake]"], { "fake-1": "r1" });
  const { out, frames } = await browse(wide.repo, wide.globalDir, REACH_IN + KEYS.q + KEYS.q, 200);
  expect(out).toBe("fleet: quit without writing");
  const detail = detailOf(frames, "covered by ");
  expect(detail).toContain("covered by routing.deny.workers.adapters (fake) — shared: covers fake:fake-1 (r1), fake:fake-2 — l lifts that one entry");
  const notice = detailOf(frames, "stays out · workers — ");
  expect(notice).toContain("fake:fake-1 stays out · workers — routing.deny.workers.adapters (fake) covers 2 channels — Space edits only this channel's own entries; l lists and lifts it");
  expect(frames.join("\n")).not.toContain("no deny entry covers it");
  expect(overlayOf(wide.repo)).toBe(wide.overlay);
});

test("test: the shape candidate picker lists a worker denied channel greyed below the offered rows with its reach and reason, so a picker that hides denied channels fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-2]"]);
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + QUIT_NOW);
  expect(out).toBe("fleet: quit without writing");
  const picker = frames.find((f) => f.includes("pin · implement") && f.includes("fake/fake-2 — "));
  expect(picker).toBeDefined();
  const greyed = "fake/fake-2 — reach: out workers — routing.deny.workers.models (fake:fake-2)";
  expect(picker).toContain(greyed);
  expect(picker).toContain("fake:fake-1  mid");
  expect(picker!.indexOf(greyed)).toBeGreaterThan(picker!.indexOf("fake:fake-1  mid"));
  expect(picker).not.toContain("fake:fake-2  mid"); // greyed, never offered
});

test("test: Enter on a greyed picker row whose covering entry is its only exclusion stages the lift so the reopened picker offers it whereas a row keeping a second deny reason or an allowlist exclusion stays greyed with its recomputed reach naming what remains, so a channel offered while still excluded fails", async () => {
  // A) one covering entry — the lift admits it and the same picker now offers it
  const a = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-2]"]);
  const one = await browse(a.repo, a.globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + QUIT_NOW);
  expect(one.out).toBe("fleet: quit without writing");
  const reopened = one.frames.filter((f) => f.includes("pin · implement")).at(-1)!;
  expect(reopened).toContain("lift: cleared fake:fake-2 from routing.deny.workers.models");
  expect(reopened).toContain("fake:fake-2  mid");
  expect(reopened).not.toContain("fake/fake-2 — ");

  // B) a second deny reason remains — lifted one entry, still greyed naming the other
  const b = policyRepo(["fake-1", "fake-2"], ["  deny:", "    models: [fake-2]", "    workers:", "      models: [fake:fake-2]"]);
  const two = await browse(b.repo, b.globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + QUIT_NOW);
  const stillB = two.frames.filter((f) => f.includes("pin · implement")).at(-1)!;
  expect(stillB).toContain("lift: cleared fake-2 from routing.deny.models — still out: routing.deny.workers.models (fake:fake-2)");
  expect(stillB).toContain("fake/fake-2 — reach: out workers — routing.deny.workers.models (fake:fake-2)");
  expect(stillB).not.toContain("fake:fake-2  mid");

  // C) an allowlist exclusion remains — never lifted, the recomputed reach names it
  const c = policyRepo(["fake-1", "fake-2"], ["  allow:", "    models: [fake:fake-1]", "  deny:", "    workers:", "      models: [fake:fake-2]"]);
  const three = await browse(c.repo, c.globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + QUIT_NOW);
  const stillC = three.frames.filter((f) => f.includes("pin · implement")).at(-1)!;
  expect(stillC).toContain("lift: cleared fake:fake-2 from routing.deny.workers.models — still out: routing.allow (not admitted)");
  expect(stillC).toContain("fake/fake-2 — reach: out allow — routing.allow (not admitted)");
  expect(stillC).not.toContain("fake:fake-2  mid");

  // D) an adapter-wide entry — refused by name, the row stays greyed
  const d = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake]"]);
  const four = await browse(d.repo, d.globalDir, OPEN_IMPLEMENT_PICKER + "\r" + QUIT_NOW);
  const stillD = four.frames.filter((f) => f.includes("pin · implement")).at(-1)!;
  expect(stillD).toContain("fake:fake-1 stays out — routing.deny.workers.adapters (fake) covers fake:fake-1, fake:fake-2");
  expect(stillD).toContain("fake/fake-1 — reach: out workers — routing.deny.workers.adapters (fake)");
  expect(overlayOf(d.repo)).toBe(d.overlay);
});

test("test: a lifted channel appears in the review overlay as a routing deny edit exactly like a reach choice, so a lift that bypasses the review funnel fails", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-2]"]);
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + "\x1b" + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  const review = frames.find((f) => f.includes("review ·"));
  expect(review).toBeDefined();
  expect(review).toContain("fake:fake-2"); // the lifted workers entry leaves through the same diff
  expect(review).not.toContain("allow");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  expect(outFor(cfg, "fake-2", "worker")).toBe(false);
});

// ── T2 review round 2: shared bare-model owner, adapter-wide picker refusal, eligibility ──────

test("review round 2 finding 1: a bare-model entry shared across two adapters names itself on both plain rows and l lists both identities then lifts that one entry", async () => {
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
    fake: { installed: true, authed: true, version: "fake", models: ["fake-1"], modelAuth: { "fake-1": authed } },
    twin: { installed: true, authed: true, version: "twin", models: ["fake-1"], modelAuth: { "fake-1": authed } },
  });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-g-"));
  const viewed = await browse(repo, globalDir, KEYS.q, 200, [tierAdapter, twinAdapter]);
  expect(detailOf(viewed.frames, "covered by ")).toContain("covered by routing.deny.workers.models (fake-1) — shared: covers fake:fake-1, twin:fake-1 — l lifts that one entry");
  const lifted = await browse(repo, globalDir, "l" + "\r" + "w" + "y", 200, [tierAdapter, twinAdapter]);
  expect(lifted.out).toMatch(/^fleet: wrote /);
  const listing = lifted.frames.find((f) => f.includes("lift · routing.deny.workers.models (fake-1)"));
  expect(listing).toContain("fake:fake-1");
  expect(listing).toContain("twin:fake-1");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
});

test("review round 2 finding 2: Enter on a greyed picker row of an adapter's only displayed channel never lifts the adapter-wide entry", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1"], ["  deny:", "    workers:", "      adapters: [fake]"]);
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + "\r" + QUIT_NOW);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  expect(all).toContain("fake:fake-1 stays out — routing.deny.workers.adapters (fake) covers fake:fake-1 — l on its models row lifts that one entry");
  expect(all).not.toContain("lift: cleared");
  expect(overlayOf(repo)).toBe(overlay);
});

test("review round 2 finding 3: Enter on a greyed picker row below the shape floor refuses naming the floor and leaves its deny entry staged", async () => {
  const { repo, globalDir } = policyRepo(["fake-1"], ["  floors:", "    implement: frontier", "  deny:", "    workers:", "      models: [fake:fake-1]"]);
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + "\r" + QUIT_NOW);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  expect(all).toContain("fake:fake-1 stays out — routing.deny.workers.models (fake:fake-1); below routing.floors.implement (frontier) — not manageable here — nothing here to lift");
  expect(all).not.toContain("lift: cleared");
});

test("review round 4: Enter on a greyed picker row whose model probe failed refuses naming the probe and leaves its row-owned deny staged", async () => {
  // fake-2 is configured (so it has a models row and a row-owned deny) but its probe failed, so
  // discovery dropped it — D-225: the ledger row still walks the reach + collector path, the
  // probe reason appended last, and Enter still refuses on structured eligibility
  const { repo, globalDir, overlay } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-2]"]);
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2"],
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-2": { authed: false, reason: "quota exceeded", probedAt: "2026-09-12T00:00:00.000Z" },
      },
    },
  });
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + QUIT_NOW);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  expect(all).toContain("fake/fake-2 — reach: out workers — routing.deny.workers.models (fake:fake-2); unauthed (quota exceeded) — re-probe with tickmarkr doctor");
  expect(all).toContain("fake:fake-2 stays out — routing.deny.workers.models (fake:fake-2); unauthed (quota exceeded) — re-probe with tickmarkr doctor — nothing here to lift");
  expect(all).not.toContain("lift: cleared");
  expect(overlayOf(repo)).toBe(overlay);
});

test("review round 3: a row whose folded alias is covered by the row's own explicit entry names that entry as shared on its detail line and l lists both identities then lifts that one entry through the overlay to the written config", async () => {
  // the rendered row IS the explicit id; a gateway alias folds into it (same catalog model) and
  // resolves to that id, so the row's own key covers the folded sibling — one shared entry
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: anthropic",
    "    channel: sub",
    "    models:",
    "      fake-1: mid",
    "routing:",
    "  deny:",
    "    workers:",
    "      models: [fake:same-model]",
    "",
  ].join("\n"));
  const ids = ["same-model", "gateway-a/same-model"];
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", ...ids],
      modelsDetectedAt: "2026-09-03T12:00:00.000Z",
      modelAuth: Object.fromEntries(["fake-1", ...ids].map((m) => [m, {
        authed: true,
        probedAt: "2026-09-12T00:00:00.000Z",
        ...(m === "fake-1" ? {} : { identity: "same-model" }),
      }])),
    },
  });
  writeFileSync(join(repo, ".tickmarkr", "catalog-cache.json"), JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026-09-03T00:00:00.000Z",
    modelsDev: {
      anthropic: {
        id: "anthropic",
        models: { "same-model": { id: "same-model", cost: { input: 1, output: 4 }, limit: { context: 200_000 } } },
      },
    },
  }));
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-g-"));
  // the folded row sits below the classified one; Space there classifies (unclassified rows are
  // never routed), so the shared entry's only edit path is the l control this row must expose
  const viewed = await browse(repo, globalDir, KEYS.down + KEYS.q, 260);
  expect(viewed.out).toBe("fleet: quit without writing");
  // the detail line clips at the browser width; the listing and the l control land before the clip
  expect(detailOf(viewed.frames, "covered by ")).toContain(
    "covered by routing.deny.workers.models (fake:same-model) — shared: covers fake:same-model (same-model), fake:gateway-a/same-model (same-model) — l lifts",
  );

  const lifted = await browse(repo, globalDir, KEYS.down + "l" + "\r" + "w" + "y", 260);
  expect(lifted.out).toMatch(/^fleet: wrote /);
  const listing = lifted.frames.find((f) => f.includes("lift · routing.deny.workers.models (fake:same-model)"));
  expect(listing).toBeDefined();
  expect(listing).toContain("fake:same-model (same-model)");
  expect(listing).toContain("fake:gateway-a/same-model (same-model)");
  expect(detailOf(lifted.frames, "lift: cleared fake:same-model from routing.deny.workers.models")).toBeDefined();
  const review = lifted.frames.find((f) => f.includes("review ·"));
  expect(review).toContain("fake:same-model");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  for (const model of ids) {
    expect(exclusionCollector({ adapter: "fake", model, identity: "same-model" }, cfg.routing, "worker"), model).toEqual([]);
  }
});

// ── T2 review round 6: unauthed-CLI channels still grey; adapter-wide entries are never row edits ──

test("review round 6 finding 1: a configured channel of an installed but unauthenticated CLI greys in the picker with its reach and covering deny entry, the CLI auth reason last", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      models: [fake:fake-2]"]);
  registry.writeDoctor(repo, {
    fake: { installed: true, authed: false, version: "fake", models: ["fake-1", "fake-2"] },
  });
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + QUIT_NOW);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  expect(all).toContain("fake/fake-2 — reach: out workers — routing.deny.workers.models (fake:fake-2); fake CLI unauthed — re-probe with tickmarkr doctor");
  expect(all).toContain("fake/fake-1 — reach: in — fake CLI unauthed — re-probe with tickmarkr doctor");
  expect(all).not.toContain("fake — CLI unauthed");
  // auth ineligibility holds: Enter on the greyed row lifts nothing
  expect(all).not.toContain("lift: cleared");
});

test("review round 6 finding 2: a lone displayed alias covered by a flat routing.deny.adapters entry refuses its reach edit by name and the entry stays written", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1"], ["  deny:", "    adapters: [fake]"], { "fake-1": "r1" });
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + KEYS.q + KEYS.q, 200);
  expect(out).toBe("fleet: quit without writing");
  const all = frames.join("\n");
  expect(detailOf(frames, "covered by ")).toContain("covered by routing.deny.adapters (fake) — shared: covers fake:fake-1 (r1) — l lifts that one entry");
  expect(all).toContain("fake:fake-1 stays out — routing.deny.adapters (fake) covers 1 channels — Space edits only this channel's own entries; l lists and lifts it");
  expect(all).not.toContain("cleared fake from routing.deny.adapters");
  expect(overlayOf(repo)).toBe(overlay);
  expect(denyEntries(loadConfig(repo, { globalDir }))).toEqual({ adapters: ["fake"], models: [], workersAdapters: [], workersModels: [] });
});

// ── D-233 (T2 review round 7): adapter-wideness is the ENTRY's grammar, never the config path ──

test("D-233 a: an explicit adapter:model entry filed under routing.deny.workers.adapters is row-owned — the greyed row names it, Enter stages the lift, and the review overlay plus written config carry it", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake:fake-2]"]);
  const { out, frames } = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + KEYS.down + "\r" + "\x1b" + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  const all = frames.join("\n");
  expect(all).toContain("fake/fake-2 — reach: out workers — routing.deny.workers.adapters (fake:fake-2)");
  const reopened = frames.filter((f) => f.includes("pin · implement")).at(-1)!;
  expect(reopened).toContain("lift: cleared fake:fake-2 from routing.deny.workers.adapters");
  expect(reopened).toContain("fake:fake-2  mid");
  expect(reopened).not.toContain("fake/fake-2 — ");
  const review = frames.find((f) => f.includes("review ·"));
  expect(review).toContain("fake:fake-2");
  const cfg = loadConfig(repo, { globalDir });
  expect(denyEntries(cfg)).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });
  expect(outFor(cfg, "fake-2", "worker")).toBe(false);
});

test("D-233 b: a bare adapter id in routing.deny.adapters with one displayed fake channel is adapter-wide — Space and picker Enter refuse by name and l lists it as shared", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1"], ["  deny:", "    adapters: [fake]"]);
  const space = await browse(repo, globalDir, REACH_IN + KEYS.q + KEYS.q, 200);
  expect(space.out).toBe("fleet: quit without writing");
  expect(space.frames.join("\n")).toContain("fake:fake-1 stays out — routing.deny.adapters (fake) covers 1 channels — Space edits only this channel's own entries; l lists and lifts it");
  const picker = await browse(repo, globalDir, OPEN_IMPLEMENT_PICKER + "\r" + QUIT_NOW);
  expect(picker.out).toBe("fleet: quit without writing");
  expect(picker.frames.join("\n")).toContain("fake:fake-1 stays out — routing.deny.adapters (fake) covers fake:fake-1 — l on its models row lifts that one entry");
  expect(picker.frames.join("\n")).not.toContain("lift: cleared");
  expect(overlayOf(repo)).toBe(overlay);
});

test("D-233 b (listing): l on the lone alias covered by a bare routing.deny.adapters id lists it as shared and Esc leaves the entry written", async () => {
  const { repo, globalDir, overlay } = policyRepo(["fake-1"], ["  deny:", "    adapters: [fake]"]);
  const listed = await browse(repo, globalDir, "l" + "\x1b" + KEYS.q, 200);
  expect(listed.out).toBe("fleet: quit without writing");
  expect(listed.frames.find((f) => f.includes("lift · routing.deny.adapters (fake)"))).toContain("fake:fake-1");
  expect(detailOf(listed.frames, "covered by ")).toContain("covered by routing.deny.adapters (fake) — shared: covers fake:fake-1 — l lifts that one entry");
  expect(overlayOf(repo)).toBe(overlay);
  expect(denyEntries(loadConfig(repo, { globalDir }))).toEqual({ adapters: ["fake"], models: [], workersAdapters: [], workersModels: [] });
});

// ── T2 review round 8: grammar-based adapter-wide refusal on every scope; workers.adapters row edits ──

test("review round 8 finding 1: a bare adapter id filed under routing.deny.models or workers.models with one displayed alias is adapter-wide — Space refuses by name and the entry stays written", async () => {
  for (const [lines, expected] of [
    [["  deny:", "    models: [fake]"], { adapters: [], models: ["fake"], workersAdapters: [], workersModels: [] }],
    [["  deny:", "    workers:", "      models: [fake]"], { adapters: [], models: [], workersAdapters: [], workersModels: ["fake"] }],
  ] as const) {
    const { repo, globalDir, overlay } = policyRepo(["fake-1"], [...lines], { "fake-1": "r1" });
    const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + KEYS.q + KEYS.q, 200);
    expect(out).toBe("fleet: quit without writing");
    const all = frames.join("\n");
    expect(all, lines.join(" ")).toContain("(fake) covers 1 channels — Space edits only this channel's own entries; l lists and lifts it");
    expect(all).not.toContain("cleared fake from");
    expect(overlayOf(repo)).toBe(overlay);
    expect(denyEntries(loadConfig(repo, { globalDir }))).toEqual(expected);
  }
});

test("review round 8 finding 2: a non-shared alias covered by an explicit id under routing.deny.workers.adapters clears and promotes that entry from its own scope", async () => {
  const cleared = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake:r1]"], { "fake-1": "r1" });
  const viewed = await browse(cleared.repo, cleared.globalDir, REACH_IN + "w" + "y");
  expect(viewed.out).toMatch(/^fleet: wrote /);
  expect(detailOf(viewed.frames, "covered by ")).toContain("covered by routing.deny.workers.adapters (fake:r1) — Space edits that entry");
  expect(detailOf(viewed.frames, "space: cleared fake:r1 from routing.deny.workers.adapters")).toBeDefined();
  expect(denyEntries(loadConfig(cleared.repo, { globalDir: cleared.globalDir }))).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: [] });

  const promoted = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake:r1]"], { "fake-1": "r1" });
  const moved = await browse(promoted.repo, promoted.globalDir, REACH_ALL + "w" + "y");
  expect(moved.out).toMatch(/^fleet: wrote /);
  expect(detailOf(moved.frames, "space: moved fake:r1 to routing.deny.models")).toBeDefined();
  expect(denyEntries(loadConfig(promoted.repo, { globalDir: promoted.globalDir }))).toEqual({ adapters: [], models: ["fake:r1"], workersAdapters: [], workersModels: [] });
});

// ── D-235 (T2 review round 9): the detail line and the reach edit share ONE selector ──────────

test("D-235: an alias covered by two non-shared entries names one on its detail line and in clears exactly that entry from its scope, the other surviving as the remaining reason", async () => {
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake:r1]", "    models: [r1]"], { "fake-1": "r1" });
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  // one order everywhere: models before adapters, so the models entry is named and cleared
  expect(detailOf(frames, "covered by ")).toContain("covered by routing.deny.models (r1) — Space edits that entry");
  expect(detailOf(frames, "space: cleared r1 from routing.deny.models — still out: routing.deny.adapters (fake:r1)")).toBeDefined();
  expect(frames.join("\n")).not.toContain("cleared fake:r1 from routing.deny.adapters");
  expect(denyEntries(loadConfig(repo, { globalDir }))).toEqual({ adapters: ["fake:r1"], models: [], workersAdapters: [], workersModels: [] });
});

test("review round 10: an alias whose own key is staged beside a covering entry in another scope names the own key with its scope and in clears exactly it first, the covering entry surviving", async () => {
  // the collector lists adapters before models, so a scope-first lookup would clear r1 — the
  // detail line and the edit must both lead with the own key from ITS scope
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    adapters: [fake:fake-1]", "    models: [r1]"], { "fake-1": "r1" });
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  expect(detailOf(frames, "covered by ")).toContain("covered by routing.deny.models (r1) — Space: in clears fake:fake-1 (routing.deny.adapters); out · workers demotes fake:fake-1 (routing.deny.adapters)");
  expect(detailOf(frames, "space: cleared fake:fake-1 from routing.deny.adapters — still out: routing.deny.models (r1)")).toBeDefined();
  expect(frames.join("\n")).not.toContain("cleared r1 from routing.deny.models");
  expect(denyEntries(loadConfig(repo, { globalDir }))).toEqual({ adapters: [], models: ["r1"], workersAdapters: [], workersModels: [] });
});

test("D-245 (review round 11): the same explicit entry staged in two scopes names the scope ownedDenies leads with and in clears exactly that scope's copy, the other surviving as the remaining reason", async () => {
  // fake:r1 sits in BOTH workers scopes; the collector lists workers.adapters first, ownedDenies
  // leads with workers.models — the detail line and the edit must agree on the latter
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", "    workers:", "      adapters: [fake:r1]", "      models: [fake:r1]"], { "fake-1": "r1" });
  const { out, frames } = await browse(repo, globalDir, REACH_IN + "w" + "y");
  expect(out).toMatch(/^fleet: wrote /);
  expect(detailOf(frames, "covered by ")).toContain("covered by routing.deny.workers.models (fake:r1) — Space edits that entry");
  expect(detailOf(frames, "space: cleared fake:r1 from routing.deny.workers.models — still out: routing.deny.workers.adapters (fake:r1)")).toBeDefined();
  expect(frames.join("\n")).not.toContain("cleared fake:r1 from routing.deny.workers.adapters");
  expect(denyEntries(loadConfig(repo, { globalDir }))).toEqual({ adapters: [], models: [], workersAdapters: ["fake:r1"], workersModels: [] });
});

test("review round 12 finding 1: the detail line names the entry each reach choice edits — out · workers demotes exactly the flat entry it names while in clears the own workers key it names", async () => {
  // fake:fake-1 (own key) in workers.models, r1 (identity) in flat models: the head is the own
  // key but a demotion can only move a FLAT entry, so the detail line names r1 for that choice
  const lines = ["  deny:", "    models: [r1]", "    workers:", "      models: [fake:fake-1]"];
  const demoted = policyRepo(["fake-1", "fake-2"], lines, { "fake-1": "r1" });
  const moved = await browse(demoted.repo, demoted.globalDir, REACH_WORKERS + "w" + "y");
  expect(moved.out).toMatch(/^fleet: wrote /);
  expect(detailOf(moved.frames, "covered by ")).toContain(
    "covered by routing.deny.models (r1) — Space: in clears fake:fake-1 (routing.deny.workers.models); out · workers demotes r1 (routing.deny.models)",
  );
  expect(detailOf(moved.frames, "space: moved r1 to routing.deny.workers.models")).toBeDefined();
  expect(moved.frames.join("\n")).not.toContain("moved fake:fake-1");
  expect(denyEntries(loadConfig(demoted.repo, { globalDir: demoted.globalDir }))).toEqual({ adapters: [], models: [], workersAdapters: [], workersModels: ["fake:fake-1", "r1"] });

  const cleared = policyRepo(["fake-1", "fake-2"], lines, { "fake-1": "r1" });
  const inn = await browse(cleared.repo, cleared.globalDir, REACH_IN + "w" + "y");
  expect(inn.out).toMatch(/^fleet: wrote /);
  expect(detailOf(inn.frames, "space: cleared fake:fake-1 from routing.deny.workers.models — still out: routing.deny.models (r1)")).toBeDefined();
  expect(denyEntries(loadConfig(cleared.repo, { globalDir: cleared.globalDir }))).toEqual({ adapters: [], models: ["r1"], workersAdapters: [], workersModels: [] });
});

test("review round 12 finding 2: an own key in routing.deny.adapters beside a covering routing.deny.models entry — the named first edit is the one staged for in AND for out · workers", async () => {
  const lines = ["  deny:", "    adapters: [fake:fake-1]", "    models: [r1]"];
  const demoted = policyRepo(["fake-1", "fake-2"], lines, { "fake-1": "r1" });
  const moved = await browse(demoted.repo, demoted.globalDir, REACH_WORKERS + "w" + "y");
  expect(moved.out).toMatch(/^fleet: wrote /);
  expect(detailOf(moved.frames, "covered by ")).toContain("out · workers demotes fake:fake-1 (routing.deny.adapters)");
  expect(detailOf(moved.frames, "space: moved fake:fake-1 to routing.deny.workers.models — still out: routing.deny.models (r1)")).toBeDefined();
  expect(moved.frames.join("\n")).not.toContain("moved r1");
  expect(denyEntries(loadConfig(demoted.repo, { globalDir: demoted.globalDir }))).toEqual({ adapters: [], models: ["r1"], workersAdapters: [], workersModels: ["fake:fake-1"] });
});

// ── OBS-1099 add.1 / OBS-1065: every schema-enumerated deny scope has a Fleet edit path ─────────

// the overlay lines that deny `entry` through exactly one scope (path routing.deny[.workers].x)
const denyLines = (scope: DenyScope, entry: string): string[] => {
  const segments = scope.path.slice(1);
  return segments.map((segment, depth) =>
    `${"  ".repeat(depth + 1)}${segment}:${depth === segments.length - 1 ? ` [${entry}]` : ""}`);
};
// model scopes are owned by the model row, adapter scopes by the adapter rail (the leaf names the row)
const isAdapterScope = (scope: DenyScope) => scope.path[scope.path.length - 1] === "adapters";
const ownEntry = (scope: DenyScope) => isAdapterScope(scope) ? "fake" : "fake:fake-1";
const lines = (frames: string[]) => frames.flatMap((f) => f.split("\n")).map((line) => line.trim());

test("test: for every enumerated deny scope a config denying one channel through that scope alone renders the channel out with that scope named on its detail line whereas an allowlist exclusion is named as allow with no lift offered, so a scope rendered as in or an allow exclusion offered as liftable fails", async () => {
  expect(DENY_SCOPES.length).toBeGreaterThan(0);
  for (const scope of DENY_SCOPES) {
    const entry = ownEntry(scope);
    const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], denyLines(scope, entry));
    const { out, frames } = await browse(repo, globalDir, KEYS.q);
    expect(out, scope.dotted).toBe("fleet: quit without writing");
    const detail = lines(frames).find((line) => line.includes("reach: out") && line.includes(`${scope.dotted} (${entry})`));
    expect(detail, `${scope.dotted} named on the detail line`).toBeDefined();
    expect(detail, scope.dotted).not.toContain("routing.allow");
    expect(lines(frames).find((line) => line.includes("reach: in")), `${scope.dotted} rendered as in`).toBeUndefined();
  }
  // an allowlist exclusion is a different class: named as allow, no covering entry, nothing to lift
  const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  allow:", "    models: [fake:fake-2]"]);
  const { out, frames } = await browse(repo, globalDir, "l" + KEYS.q);
  expect(out).toBe("fleet: quit without writing");
  const detail = lines(frames).find((line) => line.includes("reach: out"));
  expect(detail).toContain("allow");
  expect(detail).not.toContain("routing.deny");
  const all = frames.join("\n");
  expect(all).toContain("fake:fake-1 — no covering entry to lift");
  expect(all).not.toContain("lift · routing.allow");
}, 90_000); // one production browser session per scope

test("test: for every enumerated deny scope the reach picker on the owning row lifts that channel back to in and the writer removes exactly that scope's entry from the file, so a scope with no edit path or a writer that clears a sibling scope fails", async () => {
  for (const scope of DENY_SCOPES) {
    const entry = ownEntry(scope);
    // a sibling scope keeps its own entry for the other channel — the writer must leave it alone
    const sibling = DENY_SCOPES.find((other) => other !== scope && !isAdapterScope(other))!;
    const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], ["  deny:", ...denyLines(scope, entry).slice(1), ...denyLines(sibling, "fake:fake-2").slice(1)]);
    const keys = (isAdapterScope(scope) ? RAIL_FAKE : "") + REACH_IN + "w" + "y";
    const { out, frames } = await browse(repo, globalDir, keys);
    expect(out, scope.dotted).toMatch(/^fleet: wrote /);
    expect(rowLine(frames, `space: cleared ${entry} from ${scope.dotted}`), scope.dotted).toBeDefined();
    const cfg = loadConfig(repo, { globalDir });
    expect(denyEntriesAt(cfg.routing, scope) ?? [], `${scope.dotted} cleared`).toEqual([]);
    expect(denyEntriesAt(cfg.routing, sibling), `${sibling.dotted} kept beside ${scope.dotted}`).toEqual(["fake:fake-2"]);
    expect(exclusionCollector({ adapter: "fake", model: "fake-1" }, cfg.routing, "worker"), `${scope.dotted}: fake-1 back in`).toEqual([]);
    // fake-2 stays out through its sibling entry (a flat sibling also rides the writer's allow form)
    const fake2 = exclusionCollector({ adapter: "fake", model: "fake-2" }, cfg.routing, "worker").map((s) => s.configPath);
    expect(fake2, `${scope.dotted}: fake-2 still out`).toContain(sibling.dotted);
    expect(fake2.filter((path) => path !== "routing.allow"), `${scope.dotted}: fake-2 out by the sibling alone`).toEqual([sibling.dotted]);
  }
}, 120_000); // one production browser session per scope

test("test: a channel excluded by an adapter wide entry in any enumerated deny scope is reported under that scope with the entry, so a per model rendering that misses adapter entries fails", async () => {
  for (const scope of DENY_SCOPES) {
    const { repo, globalDir } = policyRepo(["fake-1", "fake-2"], denyLines(scope, "fake"));
    const { out, frames } = await browse(repo, globalDir, KEYS.q);
    expect(out, scope.dotted).toBe("fleet: quit without writing");
    // the model row's detail line (the cursor sits on fake-1) names the scope and the bare adapter entry
    const detail = lines(frames).find((line) => line.includes("reach: out"));
    expect(detail, scope.dotted).toContain(`${scope.dotted} (fake)`);
    expect(lines(frames).find((line) => line.includes("reach: in")), `${scope.dotted} rendered as in`).toBeUndefined();
  }
}, 90_000); // one production browser session per scope
