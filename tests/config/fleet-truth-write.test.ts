import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor } from "../../src/cli/commands/fleet.js";
import { loadConfig, type FleetEditable } from "../../src/config/config.js";
import { renderFleetOverlayWrite, unifiedYamlDiff } from "../../src/config/fleet-overlay.js";
import { TaskSchema } from "../../src/graph/schema.js";
import { disallowedBy } from "../../src/route/preference.js";
import { route } from "../../src/route/router.js";
import type { FleetEditorState } from "../../src/tui/ink/fleet-app.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const editable = (over: Partial<FleetEditable> = {}): FleetEditable => ({
  denyAdapters: [], denyModels: [], tiers: {}, map: {}, floors: {}, ...over,
});

async function editor(routing: Record<string, unknown>) {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = makeTestTempDir("fleet-truth-");
  const path = join(globalDir, "config.yaml");
  writeFileSync(path, stringify({
    tiers: {
      fake: { vendor: "fake", channel: "sub", models: { A: "mid", B: "mid", U: "mid" } },
      other: { vendor: "fake", channel: "sub", models: { X: "mid", Y: "mid" } },
    },
    routing,
  }));
  const script = join(globalDir, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const adapters = ["fake", "other"].map((id) => Object.assign(Object.create(new FakeAdapter(script)) as WorkerAdapter, {
    id,
    channels: (cfg: Parameters<typeof channelsFromConfig>[1]) => channelsFromConfig(id, cfg),
    probe: async () => { throw new Error("this test uses cached doctor evidence only"); },
  }));
  // U is deliberately authored but unprobed, so membership regeneration must retain its allow entry.
  const probedAt = new Date().toISOString();
  writeDoctor(repo, Object.fromEntries(["fake", "other"].map((id) => {
    const models = id === "fake" ? ["A", "B"] : ["X", "Y"];
    return [id, { installed: true, authed: true, models, modelAuth: Object.fromEntries(models.map((model) => [model, { authed: true, probedAt }])) }];
  })));
  const assembled = await assembleFleetEditor(repo, adapters, {}, { globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const { props } = assembled;
  const state: FleetEditorState = {
    denyAdapters: props.initialDenyAdapters,
    denyModels: props.initialDenyModels,
    denyWorkersAdapters: props.initialDenyWorkersAdapters ?? [],
    denyWorkersModels: props.initialDenyWorkersModels ?? [],
    allowOut: props.initialAllowOut,
    selectedMode: props.initialMode,
    map: props.initialMap,
    steering: props.initialSteering,
    classifications: [],
  };
  const review = (over: Partial<FleetEditorState>) => {
    const result = props.reviewOverlay({ ...state, ...over });
    if (result.kind !== "diff") throw new Error(`expected a review diff: ${JSON.stringify(result)}`);
    return result;
  };
  const save = (result: ReturnType<typeof review>) => {
    expect(assembled.commit({ kind: "write", review: result })).toMatch(/^fleet: wrote /);
    expect(readFileSync(path, "utf8")).toBe(result.after);
    return loadConfig(repo, { globalDir });
  };
  return { repo, globalDir, path, state, props, review, save };
}

test("test: a review diff of a one-entry deny edit shows a hunk header with old and new line ranges, up to three unchanged context lines on each side and the YAML path routing.deny.adapters, so a bare at-sign hunk fails", () => {
  const before = [
    "# operator policy", "routing:", "  concurrency: 2", "  allow:", "    adapters: [fake]",
    "  deny:", "    adapters:", "      - old", "  map:", "    docs:", "      prefer: [fake]",
    "tiers:", "  fake:", "    models:", "      A: mid", "",
  ].join("\n");
  const after = renderFleetOverlayWrite(before, {
    initial: editable({ denyAdapters: ["old"] }), edited: editable({ denyAdapters: ["old", "agy"] }),
  });
  const diff = unifiedYamlDiff(before, after, "config.yaml");
  expect(diff).toBe([
    "--- config.yaml (current)", "+++ config.yaml (proposed)",
    "@@ -5,6 +5,7 @@ routing.deny.adapters",
    "     adapters: [fake]", "   deny:", "     adapters:", "+      - agy",
    "       - old", "   map:", "     docs:", "",
  ].join("\n"));
  expect(diff.split("\n")).not.toContain("@@");
});

test("test: a write that disallows every member of a pool keeps that pool's last member and the review names the shape as exhausted and unroutable, so a write that empties a pool or silently reverts the shape to auto fails", async () => {
  const fx = await editor({ map: {
    implement: { pool: { mode: "ordered", channels: ["fake:A", "fake:B"] } },
    docs: { pool: { mode: "any", channels: ["fake:B"] } },
  } });
  const review = fx.review({ denyAdapters: ["fake"] });
  for (const shape of ["implement", "docs"]) {
    expect(review.notes).toContain(`routing.map.${shape}.pool keeps last member fake:B, disallowed by routing.deny.adapters (fake) — the pool is exhausted and the shape is unroutable`);
  }
  const cfg = fx.save(review);
  for (const [shape, mode] of [["implement", "ordered"], ["docs", "any"]] as const) {
    expect(cfg.routing.map[shape]).toMatchObject({ pool: { mode, channels: ["fake:B"] } });
    const task = TaskSchema.parse({ id: "T1", title: "x", goal: "x", shape, complexity: 1, acceptance: ["x"] });
    expect(() => route(task, cfg, [...channelsFromConfig("fake", cfg), ...channelsFromConfig("other", cfg)]))
      .toThrow(`routing.map.${shape}.pool is exhausted`);
  }
});

test("test: a write that denies an adapter removes that adapter's channels from every pool, lists each removal in the review, and leaves members disallowed by an earlier authored deny in place with today's skipped note, so a dead entry left behind by the same edit fails", async () => {
  const fx = await editor({
    deny: { models: ["other:X"] },
    map: {
      implement: { pool: { mode: "ordered", channels: ["fake:A", "other:X", "fake:B", "other:Y"] } },
      docs: { pool: { mode: "any", channels: ["other:Y", "fake:B", "other:X", "fake:A"] } },
    },
  });
  const review = fx.review({ denyAdapters: ["fake"] });
  for (const shape of ["implement", "docs"]) {
    for (const member of ["fake:A", "fake:B"]) {
      expect(review.notes).toContain(`routing.map.${shape}.pool removed ${member} — disallowed by this edit's routing.deny.adapters (fake)`);
    }
    expect(review.notes).toContain(`routing.map.${shape}.pool entry other:X is disallowed by routing.deny (other:X) — skipped — routes the admitted remainder other:Y`);
  }
  const cfg = fx.save(review);
  expect(cfg.routing.map.implement.pool?.channels).toEqual(["other:X", "other:Y"]);
  expect(cfg.routing.map.docs.pool?.channels).toEqual(["other:Y", "other:X"]);
  expect(fx.props.stagedRouting?.({ adapters: ["fake"], models: ["other:X"], workersAdapters: [], workersModels: [], allowOut: fx.state.allowOut })).toEqual({ ok: true, routing: cfg.routing });
  expect(cfg.routing.deny?.models).toEqual(["other:X"]);
});

test("test: an entry that stays in routing.allow.models beside a staged deny of it is named in the review as allowed and denied with deny winning, so a silent both-lists state fails", async () => {
  const kept = ["fake:U", "fake:V", "U"];
  const fx = await editor({ allow: { adapters: ["other"], models: ["fake:A", ...kept] } });
  const review = fx.review({ denyAdapters: ["fake"] });
  for (const entry of kept) {
    expect(review.notes).toContain(`routing.allow.models entry ${entry} is allowed and denied by routing.deny.adapters (fake) — deny wins; keeping the authored allow entry`);
  }
  const cfg = fx.save(review);
  expect(parse(review.after).routing.allow.models).toEqual(expect.arrayContaining(kept));
  expect(cfg.routing.deny?.adapters).toEqual(["fake"]);
  expect(disallowedBy({ adapter: "fake", model: "U" }, cfg.routing)).toEqual({ by: "deny", entry: "fake" });
});

test("separated YAML edits keep their own paths and line ranges after an earlier insertion", () => {
  const before = [
    "routing:", "  deny:", "    adapters:", "      - old", "  map:", "    docs:",
    "      prefer: [fake]", "    implement:", "      prefer: [other]", "    tests:",
    "      prefer: [fake]", "tiers:", "  fake:", "    vendor: fake", "    channel: sub",
    "    models:", "      A: mid", "",
  ].join("\n");
  const after = before.replace("      - old", "      - new\n      - old").replace("A: mid", "A: frontier");
  const headers = unifiedYamlDiff(before, after).split("\n").filter((line) => line.startsWith("@@"));
  expect(headers).toEqual([
    "@@ -1,6 +1,7 @@ routing.deny.adapters",
    "@@ -14,4 +15,4 @@ tiers.fake.models.A",
  ]);
  const fresh = "routing:\n  deny:\n    adapters: [fake]\n";
  expect(unifiedYamlDiff("", fresh)).toContain("@@ -0,0 +1,3 @@");
  expect(unifiedYamlDiff(fresh, "")).toContain("@@ -1,3 +0,0 @@");
  expect(unifiedYamlDiff(fresh, fresh)).toBe("");
});

test("pool pruning handles worker scopes, allow membership and recorded identities without changing the staged map", () => {
  for (const change of [
    { denyModels: ["fake:A"] },
    { denyWorkersAdapters: ["fake"] },
    { denyWorkersModels: ["fake:A"] },
    { allowOut: ["fake:A"] },
    { denyModels: ["fake:recorded-A"] },
  ]) {
    const initial = editable({ map: { docs: { pool: { mode: "ordered", channels: ["fake:A", "other:Y"] } } } });
    const edited = { ...structuredClone(initial), ...change };
    const before = "# operator policy\nrouting:\n  map:\n    docs:\n      pool:\n        mode: ordered  # preserve mode\n        channels:\n          - fake:A\n          - other:Y  # keep this member\n";
    const after = renderFleetOverlayWrite(before, {
      initial, edited,
      universe: [{ adapter: "fake", models: ["A"], identities: { A: "recorded-A" } }, { adapter: "other", models: ["Y"] }],
    });
    expect(parse(after).routing.map.docs.pool.channels, JSON.stringify(change)).toEqual(["other:Y"]);
    expect(after).toContain("# operator policy\n");
    expect(after).toContain("        mode: ordered  # preserve mode\n");
    expect(after).toContain("          - other:Y  # keep this member\n");
    expect(edited.map.docs.pool?.channels).toEqual(["fake:A", "other:Y"]);
  }
});
