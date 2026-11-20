import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as catalogs from "../../src/adapters/catalog-remote.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelsFromConfig, type AuthHealth } from "../../src/adapters/types.js";
import { plan } from "../../src/cli/commands/plan.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("plan prints by complexity; the range words; the group: for a very complex task and for one of the rest", async () => {
  // Queue row 502; D-2187 add.363 R6: real plan command, real temporary doctor record, no catalog or key.
  vi.stubEnv("XDG_CONFIG_HOME", makeTestTempDir("plan-facts-global-"));
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  vi.stubEnv("ARTIFICIAL_ANALYSIS_API_KEY", "");
  vi.stubEnv("NO_COLOR", "1");
  const network = vi.fn(() => { throw new Error("plan cannot fetch model facts"); });
  vi.stubGlobal("fetch", network);
  const catalog = vi.spyOn(catalogs, "readCachedCatalog").mockImplementation(() => { throw new Error("plan cannot read model facts from a catalog"); });
  const repo = makeRepo({ "src.txt": "base\n" });
  mkdirSync(join(repo, ".tickmarkr"));
  const models = ["fable", "opus", "astra", "sol"];
  writeFileSync(join(repo, ".tickmarkr/config.yaml"), JSON.stringify({
    tiers: { ...Object.fromEntries(Object.keys(DEFAULT_CONFIG.tiers).map((id) => [id, null])),
      fake: { vendor: "openai", channel: "sub", models: Object.fromEntries(models.map((m) => [m, "frontier"])) } },
    routing: { learned: "off", map: { implement: { tier: null, pool: { mode: "complexity", channels: models.map((m) => "fake:" + m) } } } },
    review: { required: false, prefer: [] },
    judge: { adapter: "fake", model: "fable" },
    consult: { adapter: "fake", model: "opus", prefer: [] },
  }));
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [9, 3, 3, 3].map((complexity, i) => ({
      id: "T" + (i + 1), title: "t", goal: "implement task", shape: "implement", complexity,
      files: ["src.txt"], acceptance: [{ oracle: "command", command: "true" }],
    })),
  }));
  const script = join(repo, "fake.json");
  writeFileSync(script, '{"tasks":{}}');
  const adapter = new FakeAdapter(script);
  vi.spyOn(adapter, "probe").mockRejectedValue(new Error("plan must read the doctor record"));
  vi.spyOn(adapter, "channels").mockImplementation((cfg) => channelsFromConfig("fake", cfg));
  const health: AuthHealth = {
    installed: true, authed: true, models,
    modelAuth: Object.fromEntries(models.map((m) => [m, { authed: true, probedAt: "2026-11-15T00:00:00.000Z" }])),
    modelFacts: Object.fromEntries(models.map((m, i) => [m, { as: m, score: [64.6, 59.1, 56.9, 54.6][i] }])),
  };
  const path = join(repo, ".tickmarkr/doctor.json");
  const bytes = JSON.stringify({ fake: health });
  writeFileSync(path, bytes);
  const output = await plan([], repo, [adapter], undefined, {}, undefined);
  const rows = output.split("\n").filter((line) => /T\d+\s+implement.*→/.test(line));
  expect(rows).toHaveLength(4);
  expect(rows[0]).toContain("c9  → fake:fable [sub/frontier] — by complexity: very complex 8-10, group 1 of 2 (config routing.map)");
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]).toContain("c3  → fake:" + models[i] + " [sub/frontier] — by complexity: the rest 1-7, group 2 of 2, one of 3 that take turns (config routing.map)");
  }
  expect(rows.join("\n")).not.toContain("grouped by level");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(adapter.probe).not.toHaveBeenCalled();
  expect(catalog).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
