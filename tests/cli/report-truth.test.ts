import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import * as registry from "../../src/adapters/registry.js";
import { readCachedCatalog } from "../../src/adapters/catalog-remote.js";
import { channelKey, channelsFromConfig, type AuthHealth, type WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { fleet } from "../../src/cli/commands/fleet.js";
import { formatFleetPrint, loadConfigWithMode } from "../../src/config/config.js";
import { renderShapeWhy } from "../../src/config/fleet-why.js";
import { SHAPES, TaskSchema } from "../../src/graph/schema.js";
import { excludedChannels, exclusionLine, formatExcludedChannels } from "../../src/route/preference.js";
import { route } from "../../src/route/router.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

beforeEach(() => {
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
});
afterEach(() => vi.restoreAllMocks());

function fixture(overlay: Record<string, unknown>, listed: Record<string, string[]> = {}) {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = makeTestTempDir("report-global-");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), stringify(overlay));
  const { cfg } = loadConfigWithMode(repo, { globalDir });
  const ids = [...new Set([...Object.keys(overlay.tiers ?? {}), ...Object.keys(listed)])];
  const health: Record<string, AuthHealth> = Object.fromEntries(ids.map((id) => [id, {
    installed: true, authed: true, version: "fixture", models: listed[id] ?? Object.keys(cfg.tiers[id]?.models ?? {}),
    modelAuth: Object.fromEntries(Object.keys(cfg.tiers[id]?.models ?? {}).map((model) =>
      [model, { authed: true, probedAt: new Date().toISOString() }])),
  }]));
  const adapters: WorkerAdapter[] = ids.map((id) => ({
    id, vendor: "fixture", probe: async () => structuredClone(health[id]),
    channels: (config) => channelsFromConfig(id, config),
    headlessCommand: () => "printf OK", interactiveCommand: () => null,
    invoke: () => ({ command: "printf OK" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  }));
  registry.writeDoctor(repo, health);
  return { repo, globalDir, cfg, health, adapters };
}

const tiers = (models: Record<string, string>) => ({ vendor: "fixture", channel: "sub", models });
const exclusionBlock = (out: string) => out.slice(out.indexOf("routing preference active:"))
  .split("\n").filter((line, index) => index === 0 || /^  (?:denied |not in routing.allow|tickmarkr doctor --models)/.test(line)).join("\n");

test("test: an exclusion set of a denied adapter, allowlist misses and a denied model prints one grouped line per reason with each channel named once and the allowlist never repeated, and the full list appears under the models flag, so a per-channel allowlist dump fails", async () => {
  const models = (prefix: string, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`${prefix}-${String(i + 1).padStart(2, "0")}`, "mid"]));
  const banned = models("banned", 4);
  const { repo, globalDir, cfg, health, adapters } = fixture({
    tiers: {
      blocked: tiers(models("blocked", 12)),
      outside: tiers(models("miss", 17)),
      allowed: tiers({ "live-1": "mid", "live-2": "mid", ...banned }),
    },
    routing: { allow: { adapters: ["allowed", "also-allowed"] }, deny: { adapters: ["blocked"], models: Object.keys(banned).map((model) => `allowed:${model}`) } },
  });
  const excluded = excludedChannels(cfg, adapters, health);
  const summary = [
    "routing preference active: 33 channel(s) excluded",
    "  denied adapter blocked: 12",
    "  not in routing.allow: 17",
    "  denied model: 4",
    "  tickmarkr doctor --models lists each excluded channel",
  ].join("\n");
  expect(exclusionLine(excluded)).toBe(summary);
  // Repeated input cannot inflate either counts or the requested list.
  expect(formatExcludedChannels([...excluded, ...excluded])).toBe(summary);
  const details = formatExcludedChannels([...excluded, ...excluded], true);
  for (const { key } of excluded) {
    expect(summary).not.toContain(key);
    expect(details.split(key)).toHaveLength(2);
  }
  expect(details.split("\n")).toHaveLength(4);
  expect(details).toContain("not in routing.allow: 17 — outside:miss-01, outside:miss-02");
  expect(details).toContain("outside:miss-17");
  expect(details).not.toContain("allow: allowed");
  expect(details).not.toContain("allowed, also-allowed");
  expect(details).not.toContain("live-1");
  const opts = { banner: false, globalDir, catalog: readCachedCatalog(repo), resolveOrcaBinary: () => undefined };
  const normal = await doctor([], repo, adapters, opts);
  const listed = await doctor(["--models"], repo, adapters, opts);
  expect(exclusionBlock(normal)).toBe(summary);
  expect(exclusionBlock(listed)).toBe(details);
});

test("test: doctor models output labels every catalog row with its adapter id, so a row readable as the previous adapter's fails", async () => {
  const listed = { agy: ["catalog-shared", "agy-extra"], "prime-agent": ["catalog-shared", "prime-extra", "prime-other"] };
  const { repo, globalDir, adapters } = fixture({}, listed);
  const out = await doctor(["--models"], repo, adapters, {
    banner: false, globalDir, catalog: readCachedCatalog(repo), resolveOrcaBinary: () => undefined,
  });
  const rows = out.split("\n").filter((line) => line.trimStart().startsWith("catalog ·"));
  expect(rows).toHaveLength(5);
  for (const [id, models] of Object.entries(listed)) {
    for (const model of models) {
      expect(rows.filter((row) => row.includes(`catalog · ${model} —`) && row.endsWith(` · adapter: ${id}`))).toHaveLength(1);
    }
  }
  expect(rows.every((row) => / · adapter: (agy|prime-agent)$/.test(row))).toBe(true);
});

test("test: print with why lists for each shape its pool members admitted or skipped with reasons, the routed pick and the rule from route provenance, while print alone stays byte-identical, so a why that adds nothing fails", async () => {
  const pool = { mode: "ordered", channels: ["report:denied", "report:outside", "report:unauthed", "report:missing", "report:cheap", "report:frontier"] };
  const { repo, globalDir, adapters, health } = fixture({
    tiers: { report: tiers({ denied: "frontier", outside: "frontier", unauthed: "frontier", cheap: "cheap", frontier: "frontier" }) },
    routing: {
      learned: "off", explore: { mode: "off" }, deny: { models: ["report:denied"] },
      allow: { models: pool.channels.filter((id) => id !== "report:outside") },
      map: Object.fromEntries(SHAPES.map((shape) => [shape, { pool }])),
    },
  });
  health.report.modelAuth!.unauthed = { authed: false, reason: "quota exhausted", probedAt: new Date().toISOString() };
  registry.writeDoctor(repo, health);
  const argv = ["--print", "--global-dir", globalDir];
  const printed = await fleet(argv, repo, adapters);
  const expectedBody = formatFleetPrint(repo, { globalDir });
  const nl = expectedBody.indexOf("\n");
  expect(printed).toBe(`${expectedBody.slice(0, nl)}\n# mode: risk-based (default)${expectedBody.slice(nl)}`);
  const explained = await fleet([...argv, "--why"], repo, adapters);
  expect(typeof explained).toBe("string");
  expect(String(explained).startsWith(`${printed}\n`)).toBe(true);
  expect(explained).not.toBe(printed);
  const { cfg } = loadConfigWithMode(repo, { globalDir });
  const channels = registry.discoverChannels(cfg, adapters, health);
  for (const shape of SHAPES) {
    const block = String(explained).split("\n").slice(String(explained).split("\n").findIndex((line) => line.startsWith(`${shape} `)));
    const end = block.findIndex((line, i) => i > 0 && SHAPES.some((other) => line.startsWith(`${other} `)));
    const text = (end < 0 ? block : block.slice(0, end)).join("\n");
    const routed = route(TaskSchema.parse({ id: "fleet-preview", title: "fleet preview", goal: "preview", shape, complexity: 3, acceptance: ["done"] }), cfg, channels, undefined, undefined, undefined, { noExplore: true });
    expect(text).toContain(`pool: routing.map.${shape}.pool (ordered) · source: repo-overlay`);
    expect(text).toContain("report:denied: skipped — routing.deny.models (report:denied)");
    expect(text).toContain("report:outside: skipped — routing.allow (not admitted)");
    expect(text).toContain("report:unauthed: skipped — unauthed (quota exhausted)");
    expect(text).toContain("report:missing: skipped — not available in doctor-discovered channels");
    expect(text).toContain("report:cheap: admitted — live pool member");
    expect(text).toContain("report:frontier: admitted — live pool member");
    expect(text).toContain(`pick: ${channelKey(routed.assignment)}`);
    expect(text).toContain(`rule: ${routed.provenance}`);
    expect(text).toContain(`ladder: ${routed.ladder.join(" → ")}`);
    for (const lint of routed.lints) expect(text).toContain(`lint: ${lint}`);
  }
  // A prefer declaration must report its own layer and the production prefer rule too.
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), stringify({
    tiers: { report: tiers({ cheap: "cheap", frontier: "frontier" }) },
    routing: { learned: "off", map: Object.fromEntries(SHAPES.map((shape) => [shape, { prefer: ["report:frontier"] }])) },
  }));
  const preferred = await fleet([...argv, "--why"], repo, adapters);
  expect(preferred).toContain("prefer: routing.map.implement.prefer (report:frontier); open fleet · source: repo-overlay");
  expect(preferred).toContain("report:frontier: admitted — live channel; prefer rank 1; meets floor mid");
  expect(preferred).toContain("rule: floor mid (config floors), marginal-cost auto (via prefer)");
  // A repo declaration of another field in the shape must not claim the inherited prefer's source.
  writeFileSync(join(globalDir, "config.yaml"), stringify({ routing: { map: { implement: { prefer: ["report:frontier"] } } } }));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), stringify({
    tiers: { report: tiers({ cheap: "cheap", frontier: "frontier" }) },
    routing: { learned: "off", map: { implement: { escalate: false } } },
  }));
  const inherited = await fleet([...argv, "--why"], repo, adapters);
  expect(inherited).toContain("prefer: routing.map.implement.prefer (report:frontier); open fleet · source: global-config");
  expect(inherited).toContain("ladder: retry → consult → human");
  // The rendering seam prints the supplied provenance, rather than inferring a rule from the pick.
  const routed = route(TaskSchema.parse({ id: "fleet-preview", title: "preview", goal: "preview", shape: "implement", complexity: 3, acceptance: ["done"] }), cfg, channels);
  expect(renderShapeWhy({ declaration: "pool", members: [], routed: { ...routed, provenance: "router-supplied rule" } })).toContain("rule: router-supplied rule");
});
