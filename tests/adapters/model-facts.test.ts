import { execFileSync, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as catalogs from "../../src/adapters/catalog-remote.js";
import type { CatalogReadResult } from "../../src/adapters/catalog-remote.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { artificialAnalysisFacts, recordModelFacts } from "../../src/adapters/model-facts.js";
import { discoverChannels, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { channelsFromConfig, type AuthHealth, type ModelFacts } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { verify } from "../../src/cli/commands/verify.js";
import { DEFAULT_CONFIG, loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { cleanHealth, newModels } from "../../src/fleet/load.js";
import { validateGraph } from "../../src/graph/schema.js";
import { climbChannel, nextChannel, route } from "../../src/route/router.js";
import { resetLaunchServicesProbeForTests, setLaunchServicesProbeForTests } from "../../src/run/launchservices-check.js";
import { recordReadmitVerdict } from "../../src/run/seat-readmit.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 502; D-2187 add.363 section 2: closed writer/reader rows and R1–R5, R7.
const at = "2026-11-15T00:00:00.000Z";
const healthOf = (models: string[]): AuthHealth => ({
  installed: true, authed: true, models,
  modelAuth: Object.fromEntries(models.map((model) => [model, { authed: true, probedAt: at }])),
});
const row = (slug: string, score?: number, prices?: { price_1m_input_tokens?: number; price_1m_output_tokens?: number }, speed?: number) => ({
  slug, name: slug + " (highest effort)", evaluations: { artificial_analysis_intelligence_index: score },
  ...(prices ? { pricing: prices } : {}), ...(speed !== undefined ? { median_output_tokens_per_second: speed } : {}),
});
const catalogOf = (rows: unknown[] = [], modelsDev: unknown = {}): CatalogReadResult => ({
  source: "cache", stale: false,
  catalog: { schemaVersion: 1, fetchedAt: at, modelsDev, artificialAnalysis: { data: rows } },
});
function fixture(models: Record<string, "cheap" | "mid" | "frontier"> = { configured: "frontier", peer: "mid" }, id = "fake", listed = Object.keys(models)) {
  const repo = makeRepo({ "src.txt": "base\n" });
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr/config.yaml"), JSON.stringify({
    tiers: {
      ...Object.fromEntries(Object.keys(DEFAULT_CONFIG.tiers).map((key) => [key, null])),
      [id]: { vendor: id === "claude-code" ? "anthropic" : "openai", channel: "sub", models: {
        ...Object.fromEntries(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}).map((key) => [key, null])), ...models,
      } },
    },
    routing: { learned: "off", map: { implement: { tier: null, pool: { mode: "complexity", channels: Object.keys(models).map((m) => id + ":" + m) } } } },
    judge: { adapter: id, model: Object.keys(models)[0] },
    consult: { adapter: id, model: Object.keys(models)[0], prefer: [] },
    review: { required: false, prefer: [] },
  }));
  const script = join(makeTestTempDir("facts-script-"), "fake.json");
  writeFileSync(script, '{"tasks":{}}');
  const adapter = new FakeAdapter(script);
  adapter.id = id;
  vi.spyOn(adapter, "probe").mockImplementation(async () => healthOf(listed));
  vi.spyOn(adapter, "headlessCommand").mockReturnValue("printf OK");
  vi.spyOn(adapter, "channels").mockImplementation((cfg) => channelsFromConfig(id, cfg));
  const listedAdapter = Object.assign(adapter, { listModels: async () => listed });
  return { repo, adapter: listedAdapter, cfg: loadConfig(repo), path: join(repo, ".tickmarkr/doctor.json") };
}
const probe = (f: ReturnType<typeof fixture>, catalog: CatalogReadResult, args = ["--all"], identity?: string) =>
  doctor(args, f.repo, [f.adapter], {
    catalog, banner: false, askedKey: { prompted: false, error: "fixture: no Artificial Analysis key" },
    gateway: { env: {} }, endpoint: { env: {} }, orcaEnv: {},
    resolveOrcaBinary: () => undefined, resolveHcBinary: () => undefined, resolveHerdrAppBinary: () => undefined,
    listTests: async () => ({ status: "listed", tests: [] }),
    resolveClaudeAliasIdentity: () => identity,
  });
const tasks = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [9, 3].map((complexity, i) => ({ id: "T" + (i + 1), title: "t", goal: "g", shape: "implement", complexity, acceptance: ["done"] })),
}).tasks;
const routed = (cfg: TickmarkrConfig, health: Record<string, AuthHealth>, f: ReturnType<typeof fixture>) => {
  const channels = discoverChannels(cfg, [f.adapter], health, "worker", undefined);
  return tasks.map((task) => route(task, cfg, channels, undefined, undefined, undefined, undefined, tasks));
};

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", makeTestTempDir("facts-global-"));
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("fixture forbids network"); }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  resetLaunchServicesProbeForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("the probe records score; list price; speed; name: for a configured model and for a listed one", async () => {
  const f = fixture({ configured: "frontier", partial: "mid", unknown: "cheap" }, "fake", ["listed", "unknown"]);
  const catalog = catalogOf([
    // Source 1 joins the models.dev display name; source 2's exact slug disagrees deliberately.
    { ...row("bridge", 92), name: "Bridge" },
    row("configured", 10, { price_1m_input_tokens: 1, price_1m_output_tokens: 2 }, 81),
    row("listed", 56.9, { price_1m_input_tokens: 10, price_1m_output_tokens: 50 }, 120),
    row("partial", 48, { price_1m_input_tokens: 8, price_1m_output_tokens: 0 }, 0),
    { slug: "unknown" },
  ], { openai: { models: {
    configured: { id: "configured", name: "Bridge", cost: { input: 7, output: 11 } },
    partial: { cost: { input: 0 } },
  } } });
  await probe(f, catalog);
  const h = readDoctor(f.repo)!.fake;
  expect(h.modelAuth?.configured.authed).toBe(true);
  expect(h.modelFacts).toEqual({
    configured: { as: "configured", score: 92, priceIn: 7, priceOut: 11, speed: 81, name: "configured" },
    partial: { as: "partial", score: 48, priceIn: 0, priceOut: 0, speed: 0, name: "partial" },
    listed: { as: "listed", score: 56.9, priceIn: 10, priceOut: 50, speed: 120, name: "listed" },
  });
  expect(h.modelFacts).not.toHaveProperty("unknown");

  // Vendored fallback adds neither a fact nor an empty key; repeated probes keep the old shape's bytes.
  const empty = fixture({ unknown: "mid" });
  const vendored = { ...catalog, source: "vendored" as const };
  await probe(empty, vendored);
  expect(readDoctor(empty.repo)!.fake).not.toHaveProperty("modelFacts");
  const before = readFileSync(empty.path, "utf8");
  const report = readDoctor(empty.repo)!;
  recordModelFacts(empty.cfg, vendored, report);
  writeDoctor(empty.repo, report);
  expect(readFileSync(empty.path, "utf8")).toBe(before);
});

test("the record cells R1 to R5 and R7 read as the contract's closed case table says", async () => {
  const legacy = fixture();
  writeDoctor(legacy.repo, { fake: healthOf(["configured", "peer"]) });
  // R1: old records have no score; all three modes still route.
  for (const mode of ["complexity", "any", "ordered"] as const) {
    const cfg = structuredClone(legacy.cfg);
    cfg.routing.map.implement!.pool!.mode = mode;
    const result = routed(cfg, readDoctor(legacy.repo)!, legacy);
    if (mode === "complexity") {
      expect(result[0].provenance).toContain("grouped by level: fake:configured, fake:peer has no score");
      expect(result.map((r) => r.assignment.model)).toEqual(["configured", "peer"]);
    } else {
      expect(result.every((r) => r.provenance.startsWith("pool " + mode))).toBe(true);
      expect(result.map((r) => r.assignment.model)).toEqual(mode === "ordered" ? ["configured", "configured"] : ["peer", "peer"]);
    }
  }

  // R2: no key and no AA table. models.dev prices are evidence, never an invented score.
  const noKey = catalogOf([], { openai: { models: { configured: { cost: { input: 1, output: 40 } } } } });
  delete noKey.catalog.artificialAnalysis;
  await probe(legacy, noKey);
  const r2 = readDoctor(legacy.repo)!;
  expect(r2.fake.modelFacts).toEqual({ configured: { as: "configured", priceIn: 1, priceOut: 40 } });
  expect(routed(legacy.cfg, r2, legacy)[0].provenance).toContain("grouped by level:");

  // R3: the alias spelling has a conflicting row, and both identity sources are supported.
  const alias = fixture({ fable: "frontier", peer: "mid" }, "claude-code");
  const table = catalogOf([row("fable", 2), row("claude-fable-5-2", 64.6)]);
  await probe(alias, table, ["--all"], "claude-fable-5-2");
  expect(readDoctor(alias.repo)!["claude-code"].modelFacts?.fable).toEqual({
    as: "claude-fable-5-2", score: 64.6, name: "claude-fable-5-2",
  });
  const identityOnly = fixture({ alias: "frontier" });
  vi.mocked(identityOnly.adapter.probe).mockResolvedValue({ ...healthOf(["alias"]), modelIdentities: { alias: "claude-fable-5-2" } });
  await probe(identityOnly, table);
  expect(readDoctor(identityOnly.repo)!.fake.modelFacts?.alias.score).toBe(64.6);

  // R4 and R5: models.dev lacks these rows; zero prices survive, absent prices remain absent.
  const newModel = fixture({ new: "mid", unpriced: "cheap", freeOut: "cheap" });
  await probe(newModel, catalogOf([
    row("new", 50, { price_1m_input_tokens: 0, price_1m_output_tokens: 7 }, 110),
    row("unpriced", 40, undefined, 90),
    row("freeOut", 30, { price_1m_output_tokens: 0 }),
  ]));
  expect(readDoctor(newModel.repo)!.fake.modelFacts).toEqual({
    new: { as: "new", score: 50, priceIn: 0, priceOut: 7, speed: 110, name: "new" },
    unpriced: { as: "unpriced", score: 40, speed: 90, name: "unpriced" },
    freeOut: { as: "freeOut", score: 30, priceOut: 0, name: "freeOut" },
  });

  // R7: probe the same alias at Y without a source; X's 64.6 must not ride the alias to Y.
  await probe(alias, table, ["--all"], "claude-fable-Y");
  const r7 = readDoctor(alias.repo)!;
  expect(r7["claude-code"].modelFacts).toBeUndefined();
  expect(discoverChannels(alias.cfg, [alias.adapter], r7, "worker", undefined).find((c) => c.model === "fable"))
    .toMatchObject({ identity: "claude-fable-Y" });
  expect(discoverChannels(alias.cfg, [alias.adapter], r7, "worker", undefined).every((c) => c.score === undefined)).toBe(true);
  expect(routed(alias.cfg, r7, alias)[0].provenance).toContain("grouped by level: claude-code:fable, claude-code:peer has no score");
});

test("a scoped doctor write keeps every other model's facts; so do verify's evidence write and a seat re-admission", async () => {
  const f = fixture();
  const own: Record<string, ModelFacts> = {
    configured: { as: "identity-X", score: 64.6, priceIn: 0, speed: 90, name: "X" },
    peer: { as: "peer", score: 54.6, priceOut: 7 },
  };
  const original = { ...healthOf(["configured", "peer"]), modelIdentities: { configured: "identity-X" }, modelFacts: own };
  const other = { ...healthOf(["other-model"]), modelFacts: { "other-model": { as: "other-model", score: 20 } } };
  writeDoctor(f.repo, { fake: original, other });
  vi.mocked(f.adapter.probe).mockResolvedValue({ ...healthOf(["configured", "peer"]), modelIdentities: { configured: "identity-X" } });
  await probe(f, catalogOf(), ["--model", "fake:configured"]);
  expect(readDoctor(f.repo)!.fake.modelFacts).toEqual(own);
  expect(readDoctor(f.repo)!.other).toEqual(other);
  writeDoctor(f.repo, { fake: { ...healthOf(["configured"]), modelIdentities: { configured: "identity-X" } } }, [{ adapter: "fake", model: "configured" }]);
  expect(readDoctor(f.repo)!.fake.modelFacts).toEqual(own);
  expect(readDoctor(f.repo)!.other).toEqual(other);
  // Fresh facts replace that model's whole fact, not individual cells borrowed from yesterday.
  const updated = { ...own, configured: { as: "identity-X", score: 65 } };
  writeDoctor(f.repo, { fake: { ...original, modelFacts: { configured: updated.configured } } }, [{ adapter: "fake", model: "configured" }]);
  expect(readDoctor(f.repo)!.fake.modelFacts).toEqual(updated);

  // Exercise verify's actual evidence write (a zero-token deterministic battery in this temporary repo).
  execFileSync("git", ["checkout", "-b", "facts-verification"], { cwd: f.repo });
  writeFileSync(join(f.repo, "src.txt"), "changed\n");
  execFileSync("git", ["add", "src.txt"], { cwd: f.repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "fixture change"], { cwd: f.repo });
  const ps = (() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    child.stdout.on("end", () => child.emit("close", 0, null));
    setImmediate(() => child.stdout.end("  412 Thu Oct  1 09:12:05 2026     /System/Library/CoreServices/launchservicesd\n"));
    return child;
  }) as unknown as typeof spawn;
  setLaunchServicesProbeForTests({ platform: "darwin", spawn: ps });
  const verified = await verify(["--no-review", "--no-acceptance"], f.repo);
  expect(verified.code).toBe(0);
  expect(readDoctor(f.repo)!.fake.launchServices?.pid).toBe(412);
  expect(readDoctor(f.repo)!.fake.modelFacts).toEqual(updated);
  expect(readDoctor(f.repo)!.other).toEqual(other);
  resetLaunchServicesProbeForTests();

  const admitted = recordReadmitVerdict(f.repo, {}, "fake:configured", { authed: true, probedAt: at, identity: "identity-X" });
  expect(admitted.modelFacts).toEqual(updated);
  expect(readDoctor(f.repo)!.other).toEqual(other);
  const moved = recordReadmitVerdict(f.repo, {}, "fake:configured", { authed: true, probedAt: at, identity: "identity-Y" });
  expect(moved.modelFacts).toEqual({ peer: own.peer });
  // Full writes keep facts for present adapters but never resurrect one absent from the report.
  writeDoctor(f.repo, { fake: { ...healthOf(["configured", "peer"]), modelAuth: {
    ...healthOf(["peer"]).modelAuth, configured: { authed: true, probedAt: at, identity: "identity-Y" },
  } } });
  expect(readDoctor(f.repo)!.other).toBeUndefined();
  expect(readDoctor(f.repo)!.fake.modelFacts).toEqual({ peer: own.peer });
});

test("a channel carries its recorded score; a record that has none gives no score and no failure", () => {
  const f = fixture();
  // The record alone supplies scores, even if an adapter offers an unsupported score of its own.
  vi.mocked(f.adapter.channels).mockImplementation((cfg) => channelsFromConfig("fake", cfg).map((c) => ({ ...c, score: 99 })));
  const readCatalog = vi.spyOn(catalogs, "readCachedCatalog").mockImplementation(() => { throw new Error("routing cannot read a catalog"); });
  const h = healthOf(["configured", "peer"]);
  h.modelAuth!.configured.identity = "identity-X";
  for (const score of [64.6, 0]) {
    h.modelFacts = { configured: { as: "identity-X", score }, peer: { as: "peer", score: 40 } };
    const channels = discoverChannels(f.cfg, [f.adapter], { fake: h }, "worker", undefined);
    expect(channels.map((c) => c.score)).toEqual([score, 40]);
    for (const task of tasks) {
      const r = route(task, f.cfg, channels, undefined, undefined, undefined, undefined, tasks);
      expect(r.provenance).not.toContain("grouped by level");
      nextChannel(r.assignment, task, f.cfg, channels, []);
      climbChannel(r.assignment, task, f.cfg, channels, []);
    }
  }
  for (const facts of [undefined, { configured: { as: "old-identity", score: 99 } },
    ...[NaN, Infinity, -Infinity, "64.6"].map((score) => ({ configured: { as: "identity-X", score } }))]) {
    h.modelFacts = facts as AuthHealth["modelFacts"];
    const channels = discoverChannels(f.cfg, [f.adapter], { fake: h }, "worker", undefined);
    expect(channels.every((c) => c.score === undefined)).toBe(true);
    expect(routed(f.cfg, { fake: h }, f)[0].provenance).toContain("grouped by level:");
  }
  h.modelAuth!.configured = { authed: false, probedAt: at };
  expect(discoverChannels(f.cfg, [f.adapter], { fake: h }, "worker", undefined).map((c) => c.model)).toEqual(["peer"]);
  expect(readCatalog).not.toHaveBeenCalled();
});

test("the shared table reader keeps exact effort rows and the fleet's high fallback without borrowing another effort", () => {
  const rows = [null, {}, row("model-1-0", 60), row("model-1-0-low", 30), row("model-1-0-xhigh", 70),
    row("invalid", NaN), { ...row("only-price"), pricing: { price_1m_input_tokens: 0 } }];
  const catalog = catalogOf(rows);
  const facts = artificialAnalysisFacts(catalog.catalog);
  expect(facts("vendor/model.1.0")?.score).toBe(60);
  expect(facts("vendor/model.1.0-high-fast")?.score).toBe(60);
  expect(facts("model.1.0-low")?.score).toBe(30);
  expect(facts("model.1.0-xhigh")?.score).toBe(70);
  expect(facts("model.1.0-medium")).toBeUndefined();
  expect(facts("model.1.0-max")).toBeUndefined();
  expect(facts("only-price")?.priceIn).toBe(0);
  expect(artificialAnalysisFacts(catalog.catalog, true)("only-price")).toBeUndefined();
  expect(artificialAnalysisFacts(catalogOf([{ slug: "priced", pricing: { price_1m_input_tokens: 0 } }]).catalog)("priced")).toEqual({ priceIn: 0 });
  expect(artificialAnalysisFacts(null)("model")).toBeUndefined();

  const f = fixture({ anchor: "frontier" }, "fake", ["anchor", "model.1.0-high", "model.1.0-low"]);
  vi.spyOn(catalogs, "readCachedCatalog").mockReturnValue(catalogOf([row("anchor", 65), ...rows]));
  writeDoctor(f.repo, { fake: healthOf(["anchor"]) });
  writeDoctor(f.repo, { fake: healthOf(["anchor", "model.1.0-high", "model.1.0-low"]) });
  const items = newModels(f.repo, f.cfg, readDoctor(f.repo), Date.now());
  expect(items).toMatchObject([{ id: "model.1.0", name: "model-1-0", score: 60, tier: "frontier", paths: [{ adapter: "fake", model: "model.1.0-high", score: 60 }] }]);
});

test("cleanHealth keeps well-formed model facts and drops malformed shapes and non-finite cells", () => {
  const valid = { as: "identity", score: 0, priceIn: 0, priceOut: 7, speed: 80, name: "Model" };
  const malformed = [null, [], 42, "score", {}, { as: 42 }, { as: "m", score: "64" }, { as: "m", score: NaN },
    { as: "m", priceIn: Infinity }, { as: "m", priceOut: null }, { as: "m", speed: -Infinity }, { as: "m", name: 1 }];
  for (const bad of malformed) {
    expect(cleanHealth({ fake: { ...healthOf(["ok"]), modelFacts: { ok: valid, bad } } })!.fake.modelFacts).toEqual({ ok: valid });
    expect(cleanHealth({ fake: { ...healthOf([]), modelFacts: bad } })!.fake).not.toHaveProperty("modelFacts");
  }
  expect(cleanHealth({ fake: { ...healthOf([]), modelFacts: { priced: { as: "priced", priceOut: 0 }, scored: { as: "scored", score: 64.6 } } } })!.fake.modelFacts)
    .toEqual({ priced: { as: "priced", priceOut: 0 }, scored: { as: "scored", score: 64.6 } });
});
