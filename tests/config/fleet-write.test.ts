import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, onTestFinished, test, vi } from "vitest";
import { parse, stringify } from "yaml";

import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor, fleet, writeFleetOverlay } from "../../src/cli/commands/fleet.js";
import {
  DEFAULT_CONFIG,
  fleetEditableFromConfig,
  fleetKeyLayer,
  globalConfigDir,
  fleetRepoOverlayFromDelta,
  loadConfig,
  loadConfigWithMode,
  lowerLayerModelOverrides,
  renderFleetOverlayWrite,
  type FleetEditable,
  type FleetOverlayWrite,
} from "../../src/config/config.js";
import { disallowedBy } from "../../src/route/preference.js";
import { route } from "../../src/route/router.js";
import { TaskSchema } from "../../src/graph/schema.js";
import { autoMapEntry, type FleetStagedMetadata } from "../../src/tui/ink/fleet-app.js";
import { makeRepo } from "../helpers/tmprepo.js";

const editable = (over: Partial<FleetEditable> = {}): FleetEditable => ({
  denyAdapters: [],
  denyModels: [],
  denyWorkersAdapters: [],
  denyWorkersModels: [],
  tiers: {},
  map: {},
  floors: {},
  ...over,
});

const occurrences = (text: string, fragment: string) => text.split(fragment).length - 1;

const lowerOf = (globalDir: string) => {
  const lower = lowerLayerModelOverrides({ globalDir });
  if (!lower.ok) throw new Error(lower.error);
  return lower.overrides;
};

test("test: a fleet write preserves every routing key and routing-side comment essay it did not author, proven member by member over the closed set of overlay content — a comment-essay fixture, an unknown-routing-key fixture, a prefer-list fixture and a null-tombstone fixture", () => {
  const prior = [
    "routing:",
    "  # operator incident essay, paragraph one",
    "  # paragraph two: keep until the provider incident is closed",
    "  future-policy: hold  # unknown routing key from a newer tickmarkr",
    "  deny:",
    "    adapters: null  # deliberate tombstone over the global deny",
    "  map:",
    "    implement:",
    "      prefer: [codex, cursor-agent]  # operator ordering",
    "",
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-write-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, prior);

  const state = editable();
  writeFleetOverlay(path, (bytes) => renderFleetOverlayWrite(
    bytes,
    { initial: state, edited: state, mode: "staff-led" },
  ));

  const written = readFileSync(path, "utf8");
  const parsed = parse(written);
  const closedSet = {
    "comment-essay": () => {
      expect(occurrences(written, "operator incident essay, paragraph one")).toBe(1);
      expect(occurrences(written, "paragraph two: keep until the provider incident is closed")).toBe(1);
    },
    "unknown-routing-key": () => expect(parsed.routing["future-policy"]).toBe("hold"),
    "prefer-list": () => expect(parsed.routing.map.implement.prefer).toEqual(["codex", "cursor-agent"]),
    "null-tombstone": () => expect(parsed.routing.deny.adapters).toBeNull(),
  };
  for (const proveMember of Object.values(closedSet)) proveMember();
  expect(parsed.routing.mode).toBe("staff-led");

  const tombstoneTransitions = [
    ["block sequence", "routing:\n  deny:\n    adapters:  # global mask\n      - grok\n"],
    ["flow sequence", "routing:\n  deny:\n    adapters: [grok]  # global mask\n"],
  ] as const;
  for (const [name, source] of tombstoneTransitions) {
    const cleared = renderFleetOverlayWrite(source, {
      initial: editable({ denyAdapters: ["grok"] }),
      edited: editable(),
    });
    expect(parse(cleared).routing.deny.adapters, name).toBeNull();
    expect(cleared, name).toMatch(/^    adapters: null  # global mask$/m);
    expect(occurrences(cleared, "global mask"), name).toBe(1);
  }
});

test("OBS-505: a one-key write onto the init scaffold preserves every block-comment line byte-for-byte — column-0 template lines and indented essays gain no leading space, while inline notes keep the two-space style", () => {
  const scaffold = [
    "# tickmarkr config overlay — merges over built-in defaults",
    "# concurrency: 3",
    "# routing:",
    "#   mode: risk-based      # a preset compiled into floors at",
    "",
  ].join("\n");
  const state = editable();
  const after = renderFleetOverlayWrite(scaffold, { initial: state, edited: state, mode: "staff-led" });
  // The whole scaffold survives contiguously and unmangled; the write is a pure append.
  expect(after).toContain(scaffold.trimEnd());
  expect(after).not.toMatch(/^ #/m);
  expect(parse(after).routing.mode).toBe("staff-led");

  // Indented block comments keep their exact indent (the old commentString emitted three spaces).
  const indented = "routing:\n  # essay line\n  future-policy: hold  # note\n";
  const rewritten = renderFleetOverlayWrite(indented, { initial: state, edited: state, mode: "staff-led" });
  expect(rewritten).toMatch(/^  # essay line$/m);
  expect(rewritten).toMatch(/^  future-policy: hold {2}# note$/m);
});

test("test: exactly one mechanism writes provenance notes after this task, proven over repeated write-and-reload cycles by every note surviving in exactly ONE copy, so a second mechanism re-attaching its own would be observable as duplication", () => {
  const tierNote = "SWE-bench Pro 62.1 — fleet 2026-07-18";
  const denyNote = "quota incident — retry in August";
  const freshNote = "Terminal-Bench 88.3 — fleet 2026-08-05";
  let bytes = [
    "routing:",
    "  deny:",
    "    models:",
    `      - fake:retired  # ${denyNote}`,
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    `      fake-1: mid  # ${tierNote}`,
    "",
  ].join("\n");
  const initial = editable({ tiers: { fake: { "fake-1": { tier: "mid" } } } });
  const classified = editable({
    tiers: {
      fake: {
        "fake-1": { tier: "mid" },
        "fake-2": { tier: "frontier", provenance: freshNote },
      },
    },
  });

  bytes = renderFleetOverlayWrite(bytes, { initial, edited: classified });
  bytes = renderFleetOverlayWrite(bytes, { initial: classified, edited: classified, mode: "staff-led" });
  bytes = renderFleetOverlayWrite(bytes, {
    initial: classified,
    edited: classified,
    steering: { initial: {}, edited: { review: ["fake"] } },
  });

  for (const note of [tierNote, denyNote, freshNote]) {
    expect(occurrences(bytes, note), note).toBe(1);
  }
  expect(parse(bytes).tiers.fake.models).toEqual({ "fake-1": "mid", "fake-2": "frontier" });
});

test("test: an interrupted write leaves the original overlay intact and no temporary file behind, proven over the closed set of failure points — a failure before rename, a failure during serialize and a failure while reading the prior bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-interrupt-"));
  const path = join(dir, "config.yaml");
  const tmp = `${path}.tmp`;
  const original = "routing:\n  future-policy: hold\n";
  const failurePoints: Array<[string, () => void]> = [
    ["before rename", () => writeFleetOverlay(path, (bytes) => `${bytes}# candidate\n`, { beforeRename: () => { throw new Error("before rename"); } })],
    ["during serialize", () => writeFleetOverlay(path, () => { throw new Error("during serialize"); })],
    ["while reading prior bytes", () => writeFleetOverlay(path, (bytes) => bytes, { readPrior: () => { throw new Error("while reading prior bytes"); } })],
  ];

  for (const [name, interrupt] of failurePoints) {
    writeFileSync(path, original);
    expect(interrupt, name).toThrow(name);
    expect(readFileSync(path, "utf8"), name).toBe(original);
    expect(existsSync(tmp), name).toBe(false);
  }
});

test("test: prefer distinguishes inherited from explicit-empty from a list, and an explicit-empty prefer survives a write-reload cycle without becoming inherited", () => {
  const inherited = fleetRepoOverlayFromDelta(editable(), editable());
  expect(inherited).toEqual({});

  const lowerLayerList = editable({ map: { implement: { prefer: ["codex"] } } });
  const explicitlyCleared = fleetRepoOverlayFromDelta(lowerLayerList, editable({ map: { implement: {} } }));
  expect((explicitlyCleared.routing as { map: { implement: { prefer: string[] } } }).map.implement.prefer)
    .toEqual([]);

  const listed = fleetRepoOverlayFromDelta(
    editable({ map: { implement: {} } }),
    editable({ map: { implement: { prefer: ["cursor-agent", "codex"] } } }),
  );
  expect((listed.routing as { map: { implement: { prefer: string[] } } }).map.implement.prefer)
    .toEqual(["cursor-agent", "codex"]);

  const prior = "routing:\n  map:\n    implement:\n      prefer: []\n";
  const explicitEmpty = editable({ map: { implement: { prefer: [] } } });
  const after = renderFleetOverlayWrite(prior, {
    initial: explicitEmpty,
    edited: { ...explicitEmpty, floors: { docs: "mid" } },
  });
  expect(parse(after).routing.map.implement).toHaveProperty("prefer", []);
});

test("test: fleet --print output parses as YAML and its parsed routing and tiers equal the resolved config, over the closed set of collection shapes — an empty deny fixture, a single-entry deny fixture and a multi-entry deny fixture", async () => {
  const fixtures = [
    ["empty deny", []],
    ["single-entry deny", ["fake:one"]],
    ["multi-entry deny", ["fake:one", "fake:two"]],
  ] as const;

  for (const [name, deniedModels] of fixtures) {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-print-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-print-g-"));
    mkdirSync(join(repo, ".tickmarkr"));
    writeFileSync(
      join(repo, ".tickmarkr", "config.yaml"),
      `routing:\n  deny:\n    models: ${JSON.stringify(deniedModels)}\n`,
    );
    const resolved = loadConfig(repo, { globalDir });
    const output = await fleet(["--print", "--global-dir", globalDir], repo, []);
    expect(output, name).toBeTypeOf("string");
    const parsed = parse(output as string);
    expect(parsed.routing, name).toEqual(resolved.routing);
    expect(parsed.tiers, name).toEqual(resolved.tiers);
  }
});

test("v1.92 membership write: changed exclusion sets emit the minimal routing.allow form — bare ids for fully-in adapters, adapter:model keys for partially-in — and an addition the allow form carries writes no deny tombstone (OBS-1046) while the untouched deny adapters scope and deny.workers survive byte-for-byte", () => {
  const prior = [
    "routing:",
    "  deny:",
    "    adapters:  # rail mask",
    "      - grok",
    "    workers:",
    "      adapters:",
    "        - pi  # reviewer-only mask, fleet never touches it",
    "",
  ].join("\n");
  const universe = [
    { adapter: "claude-code", models: ["fable", "haiku"] },
    { adapter: "codex", models: ["gpt-5.6-luna", "o5-mini"] },
    { adapter: "grok", models: ["grok-4"] },
  ];
  const written = renderFleetOverlayWrite(prior, {
    initial: editable({ denyAdapters: ["grok"] }),
    edited: editable({ denyAdapters: ["grok"], denyModels: ["codex:o5-mini"] }),
    universe,
  });
  const parsed = parse(written);
  // grok fully out ⇒ absent; claude-code fully in ⇒ bare id; codex partially in ⇒ adapter:model
  expect(parsed.routing.allow.adapters).toEqual(["claude-code"]);
  expect(parsed.routing.allow.models).toEqual(["codex:gpt-5.6-luna"]);
  // LEG2-T3 finding 4: the adapters scope is untouched (grok stays out, same set) — its raw bytes
  // and comment survive; only the changed models scope is tombstoned
  expect(parsed.routing.deny.adapters).toEqual(["grok"]);
  // OBS-1046: the added exclusion rides the allow form alone — the absent models scope stays absent
  expect(parsed.routing.deny.models).toBeUndefined();
  expect(written).not.toContain("models: null");
  expect(parsed.routing.deny.workers).toEqual({ adapters: ["pi"] });
  expect(written).toContain("    workers:\n      adapters:\n        - pi  # reviewer-only mask, fleet never touches it");
  expect(written).not.toContain("adapters: null");
  expect(occurrences(written, "rail mask")).toBe(1);
});

test("v1.92 membership write: clearing every exclusion removes the routing.allow block entirely and tombstones the authored deny scope it cleared (OBS-1046: never a scope that was absent)", () => {
  const prior = [
    "routing:",
    "  allow:",
    "    adapters: [claude-code]",
    "  deny:",
    "    models: [codex:o5-mini]",
    "",
  ].join("\n");
  const written = renderFleetOverlayWrite(prior, {
    initial: editable({ denyModels: ["codex:o5-mini"], allowOut: ["codex", "grok"] }),
    edited: editable({ allowOut: [] }),
    universe: [
      { adapter: "claude-code", models: ["fable"] },
      { adapter: "codex", models: ["gpt-5.6-luna"] },
      { adapter: "grok", models: ["grok-4"] },
    ],
  });
  const parsed = parse(written);
  expect(parsed.routing.allow).toBeUndefined();
  expect(written).not.toContain("allow");
  expect(parsed.routing.deny.adapters).toBeUndefined();
  expect(parsed.routing.deny.models).toBeNull();
});

test("v1.92 slot ownership: a pool replacing a seed-layer prefer writes NO prefer key beside it, and the written overlay loads clean over the seed", () => {
  // the field defect this pins: masking the removed prefer with [] re-declared prefer BESIDE the
  // pool in one document and the exclusivity refine bounced the write off the reload guard
  const initial = editable({ map: { implement: { prefer: ["cursor-agent", "codex"] } } });
  const edited = editable({
    map: { implement: { pool: { mode: "any", channels: ["cursor-agent:composer-2.5", "codex:gpt-5.6-terra"] } } },
  });
  const written = renderFleetOverlayWrite("", { initial, edited });
  expect(written).toContain("pool:");
  expect(written).not.toContain("prefer");
  // and the loader accepts it over the seed default map (implement carries a seed prefer)
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-slot-r-"));
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-slot-g-"));
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), written);
  const cfg = loadConfig(repo, { globalDir });
  expect(cfg.routing.map.implement.pool).toEqual({ mode: "any", channels: ["cursor-agent:composer-2.5", "codex:gpt-5.6-terra"] });
  expect(cfg.routing.map.implement.prefer).toBeUndefined();
  // a prefer cleared with NO replacing declaration keeps the [] mask (lower layer stays masked)
  const clearedOnly = renderFleetOverlayWrite("", {
    initial: editable({ map: { implement: { prefer: ["codex"] } } }),
    edited: editable({ map: { implement: {} } }),
  });
  expect(clearedOnly).toMatch(/prefer: \[\]|prefer:\s*\[\s*\]/);
});

test("v1.92 pool write: a map-entry pool round-trips through write + parse in both modes with declaration order intact, while untouched pin/prefer bytes survive verbatim", () => {
  const prior = [
    "routing:",
    "  map:",
    "    plan:",
    "      pin:",
    "        via: claude-code  # operator pin",
    "        model: fable",
    "      prefer:",
    "        - codex",
    "        - cursor-agent",
    "",
  ].join("\n");
  for (const mode of ["any", "ordered"] as const) {
    const channels = ["kimi:kimi-code/k3", "codex:gpt-5.6-luna"];
    const written = renderFleetOverlayWrite(prior, {
      initial: editable(),
      edited: editable({ map: { implement: { pool: { mode, channels } } } }),
    });
    const parsed = parse(written);
    expect(parsed.routing.map.implement.pool, mode).toEqual({ mode, channels });
    // channel order is semantic (ordered walks it; any breaks ties by it) — never sorted
    expect(written.indexOf("kimi:kimi-code/k3"), mode).toBeLessThan(written.indexOf("codex:gpt-5.6-luna"));
    // the write is a pure append: every prior byte survives contiguously
    expect(written, mode).toContain(prior.trimEnd());
  }
});

test("v1.92 pool write: removing a staged pool writes the pool: null tombstone, hoisting its key-line comment and deleting the mode/channels body", () => {
  const prior = [
    "routing:",
    "  map:",
    "    implement:",
    "      pool:  # economy set",
    "        mode: any",
    "        channels:",
    "          - codex:gpt-5.6-luna",
    "",
  ].join("\n");
  const written = renderFleetOverlayWrite(prior, {
    initial: editable({ map: { implement: { pool: { mode: "any", channels: ["codex:gpt-5.6-luna"] } } } }),
    edited: editable({ map: { implement: {} } }),
  });
  const parsed = parse(written);
  expect(parsed.routing.map.implement.pool).toBeNull();
  expect(written).toMatch(/^      pool: null {2}# economy set$/m);
  expect(occurrences(written, "economy set")).toBe(1);
  expect(written).not.toContain("mode: any");
});

test("v1.92 membership round-trip: the written allow form reloads into the same exclusion sets via fleetEditableFromConfig(cfg, universe), while the absent-universe call keeps deny arrays verbatim", () => {
  const universe = [
    { adapter: "claude-code", models: ["fable", "haiku"] },
    { adapter: "codex", models: ["gpt-5.6-luna", "o5-mini"] },
    { adapter: "grok", models: ["grok-4"] },
  ];
  const edited = editable({ denyAdapters: ["grok"], denyModels: ["codex:o5-mini"] });
  const written = renderFleetOverlayWrite("", { initial: editable(), edited, universe });
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-membership-r-"));
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-membership-g-"));
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), written);
  const cfg = loadConfig(repo, { globalDir });
  const reloaded = fleetEditableFromConfig(cfg, universe);
  // OBS-1046: the allow complement reloads as its own reason, beside the (empty) authored lists
  expect(reloaded.allowOut).toEqual(["codex:o5-mini", "grok"]);
  expect(reloaded.denyAdapters).toEqual([]);
  expect(reloaded.denyModels).toEqual([]);
  // absent universe ⇒ deny arrays verbatim and no allowOut: the scopes reload as empty
  expect(fleetEditableFromConfig(cfg).allowOut).toBeUndefined();
  expect(fleetEditableFromConfig(cfg).denyAdapters).toEqual([]);
  expect(fleetEditableFromConfig(cfg).denyModels).toEqual([]);
});

test("v1.92 plain-object delta: a universe writes the allow form with deny scopes nulled and workers preserved, and a removed pool masks the lower layer with pool: null", () => {
  const out = fleetRepoOverlayFromDelta(
    editable(),
    editable({ denyModels: ["codex:o5-mini"] }),
    { routing: { deny: { workers: { adapters: ["pi"] } } } },
    {},
    [
      { adapter: "claude-code", models: ["fable"] },
      { adapter: "codex", models: ["gpt-5.6-luna", "o5-mini"] },
      { adapter: "grok", models: ["grok-4"] },
    ],
  );
  const routing = out.routing as Record<string, unknown>;
  expect(routing.allow).toEqual({ adapters: ["claude-code", "grok"], models: ["codex:gpt-5.6-luna"] });
  expect(routing.deny).toEqual({ workers: { adapters: ["pi"] }, adapters: null, models: null });

  const cleared = fleetRepoOverlayFromDelta(
    editable({ map: { implement: { pool: { mode: "any", channels: ["codex:gpt-5.6-luna"] } } } }),
    editable({ map: { implement: {} } }),
  );
  expect((cleared.routing as { map: { implement: { pool: null } } }).map.implement.pool).toBeNull();
});

test("OBS-517 deny fail-open: a denied model the probe universe does not serve survives the read leg, both write legs, and a full write-reload round trip — with its operator rationale comment intact and deny still beating the adapter-level allow", () => {
  // claude-code:fable is denied on disk with a rationale essay, but its probe rate-limited so
  // discoverChannels never served it: the universe knows claude-opus-5 only. Before the fix the
  // next membership write deleted the deny and admitted fable through the whole-adapter allow.
  const prior = [
    "routing:",
    "  deny:",
    "    models:",
    "      # operator-directed: replaced by claude-opus-5 at lower cost",
    "      # restore by deleting this line on dated evidence",
    "      - claude-code:fable",
    "      - codex:gpt-5.5",
    "",
  ].join("\n");
  const universe = [
    { adapter: "claude-code", models: ["claude-opus-5"] },
    { adapter: "codex", models: ["gpt-5.5", "gpt-5.6-sol"] },
  ];
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-residual-"));
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-residual-g-"));
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), prior);

  // read leg: the out-of-universe entry rides the editable state verbatim
  const initial = fleetEditableFromConfig(loadConfig(repo, { globalDir }), universe);
  expect(initial.denyModels).toContain("claude-code:fable");
  expect(initial.denyModels).toContain("codex:gpt-5.5");

  // write leg: an unrelated membership change keeps the residual in routing.deny — and (LEG2-T3
  // round 2 finding 2) every entry the overlay authored that is still staged, so codex:gpt-5.5
  // stays its own reason instead of being re-expressed through the allow form
  const edited = structuredClone(initial);
  edited.denyModels = [...new Set([...edited.denyModels, "codex:gpt-5.6-sol"])].sort();
  const written = renderFleetOverlayWrite(prior, { initial, edited, universe });
  const parsed = parse(written);
  expect(parsed.routing.deny.models).toEqual(["claude-code:fable", "codex:gpt-5.5"]);
  expect(parsed.routing.deny.adapters).toBeUndefined();
  expect(parsed.routing.allow).toEqual({ adapters: ["claude-code"] });
  expect(written).toContain("# operator-directed: replaced by claude-opus-5 at lower cost");
  expect(written).toContain("# restore by deleting this line on dated evidence");

  // round trip: reload the written overlay — fable is STILL denied (deny beats allow) and the
  // editable state reproduces every exclusion
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), written);
  const reloaded = fleetEditableFromConfig(loadConfig(repo, { globalDir }), universe);
  expect(reloaded.denyModels).toContain("claude-code:fable");
  // both codex universe models are now excluded — the derivation folds them into ONE
  // adapter-level allow exclusion (grok-round-trip precedent above), beside the authored deny
  expect(reloaded.allowOut).toContain("codex");
  expect(reloaded.denyModels).toContain("codex:gpt-5.5");
});

test("OBS-517 plain-object delta: residual deny entries land in the overlay fragment instead of the null tombstone, alongside the universe-derived allow form", () => {
  const universe = [
    { adapter: "claude-code", models: ["claude-opus-5"] },
    { adapter: "codex", models: ["gpt-5.5"] },
  ];
  const initial = editable({ denyModels: ["claude-code:fable"] });
  const out = fleetRepoOverlayFromDelta(
    initial,
    editable({ denyModels: ["claude-code:fable", "codex:gpt-5.5"] }),
    {},
    {},
    universe,
  );
  const routing = out.routing as { allow: unknown; deny: Record<string, unknown> };
  expect(routing.deny.models).toEqual(["claude-code:fable"]);
  expect(routing.deny.adapters).toBeNull();
  expect(routing.allow).toEqual({ adapters: ["claude-code"] });
});

test("OBS-518 write churn: an untouched flow sequence keeps its unpadded [kimi] form through a membership write", () => {
  const prior = [
    "routing:",
    "  deny:",
    "    workers:",
    "      adapters: [kimi]",
    "",
  ].join("\n");
  const universe = [{ adapter: "codex", models: ["gpt-5.5", "gpt-5.6-sol"] }];
  const written = renderFleetOverlayWrite(prior, {
    initial: editable(),
    edited: editable({ denyModels: ["codex:gpt-5.5"] }),
    universe,
  });
  expect(written).toContain("adapters: [kimi]");
  expect(written).not.toContain("[ kimi ]");
});

test("OBS-533 tombstone crash: a fleet write stays total over legal scalar intermediates, proven over the closed set of crash sites — a pin delete under a `spec:` null tombstone no-ops and keeps the operator's mask, a pin set over the tombstone rebuilds the map entry, and an unpin against an empty overlay returns the bytes verbatim", () => {
  // `spec:` is the v1.1 null tombstone — deepMerge prunes it before schema validation, so the
  // overlay loads clean; yaml's setIn/deleteIn then threw "Expected YAML collection at spec.
  // Remaining path: pin" and killed the fleet TUI mid-write.
  const tombstoned = "routing:\n  map:\n    spec:  # operator mask over the default pin\n";
  const pinned = editable({ map: { spec: { pin: { via: "claude-code", model: "fable" } } } });
  const bare = editable();

  const cleared = renderFleetOverlayWrite(tombstoned, { initial: pinned, edited: bare });
  expect(parse(cleared).routing.map.spec).toBeNull();
  expect(cleared).toContain("operator mask over the default pin");

  const repinned = renderFleetOverlayWrite(tombstoned, { initial: bare, edited: pinned });
  expect(parse(repinned).routing.map.spec.pin).toEqual({ via: "claude-code", model: "fable" });

  expect(renderFleetOverlayWrite("", { initial: pinned, edited: bare })).toBe("");
});

test("test: for each of the four deny scopes loading the overlay written from the staged edit yields exactly the staged reach, an untouched scope keeps its raw bytes and comments and an entry outside the probe universe survives byte for byte, a cleared scope is absent from the loaded policy, an empty map, an empty list, null and absence written unchanged read back as the same raw form, and the preview equals the loader over the candidate bytes under a global layer the repo overlay tombstones, so a writer that drops the workers scope, merges two raw forms, or previews through a second merge fails", () => {
  const freshRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-"));
    mkdirSync(join(dir, ".tickmarkr"), { recursive: true });
    return dir;
  };
  const freshGlobal = () => mkdtempSync(join(tmpdir(), "tickmarkr-fleet-reach-g-"));
  const load = (written: string) => {
    const repo = freshRepo();
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), written);
    return loadConfig(repo, { globalDir: freshGlobal() });
  };

  // 1) each of the four deny scopes: the overlay written from a staged edit yields exactly the
  //    staged reach when reloaded — proven per scope rather than generically over a path table
  const staged = ["fake:one", "fake:two"];
  const adapters = load(renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyAdapters: staged }) }));
  expect(adapters.routing.deny?.adapters).toEqual(staged);
  const models = load(renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyModels: staged }) }));
  expect(models.routing.deny?.models).toEqual(staged);
  const workersAdapters = load(renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyWorkersAdapters: staged }) }));
  expect(workersAdapters.routing.deny?.workers?.adapters).toEqual(staged);
  const workersModels = load(renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyWorkersModels: staged }) }));
  expect(workersModels.routing.deny?.workers?.models).toEqual(staged);

  // 2) an untouched scope keeps its raw bytes and comments, and an entry outside the probe
  //    universe survives byte for byte — editing the flat scope leaves a workers entry the
  //    universe never served completely alone
  const prior = [
    "routing:",
    "  deny:",
    "    workers:",
    "      models:",
    "        - fake:outside-universe  # operator note, untouched scope",
    "",
  ].join("\n");
  const universe = [{ adapter: "fake", models: ["one"] }];
  const untouched = renderFleetOverlayWrite(prior, {
    initial: editable(),
    edited: editable({ denyModels: ["fake:one"] }),
    universe,
  });
  expect(untouched).toContain("        - fake:outside-universe  # operator note, untouched scope");
  expect(occurrences(untouched, "operator note, untouched scope")).toBe(1);
  expect(load(untouched).routing.deny?.workers?.models).toEqual(["fake:outside-universe"]);

  // 3) a cleared scope is absent from the loaded policy — every deny scope tombstones to nothing
  const clearAdapters = load(renderFleetOverlayWrite(
    renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyAdapters: staged }) }),
    { initial: editable({ denyAdapters: staged }), edited: editable() },
  ));
  expect(clearAdapters.routing.deny?.adapters).toBeUndefined();
  const clearModels = load(renderFleetOverlayWrite(
    renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyModels: staged }) }),
    { initial: editable({ denyModels: staged }), edited: editable() },
  ));
  expect(clearModels.routing.deny?.models).toBeUndefined();
  const clearWorkersAdapters = load(renderFleetOverlayWrite(
    renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyWorkersAdapters: staged }) }),
    { initial: editable({ denyWorkersAdapters: staged }), edited: editable() },
  ));
  expect(clearWorkersAdapters.routing.deny?.workers?.adapters).toBeUndefined();
  const clearWorkersModels = load(renderFleetOverlayWrite(
    renderFleetOverlayWrite("", { initial: editable(), edited: editable({ denyWorkersModels: staged }) }),
    { initial: editable({ denyWorkersModels: staged }), edited: editable() },
  ));
  expect(clearWorkersModels.routing.deny?.workers?.models).toBeUndefined();

  // 4) an empty map, an empty list, null and absence written UNCHANGED read back as the same raw
  //    form — a no-op write over any of the four states must not normalize it into another
  const rawForms: Array<[string, string]> = [
    ["empty map", "routing:\n  deny:\n    workers: {}\n"],
    ["empty list", "routing:\n  deny:\n    workers:\n      adapters: []\n"],
    ["null", "routing:\n  deny:\n    workers: null\n"],
    ["absence", "routing:\n  concurrency: 3\n"],
  ];
  for (const [name, raw] of rawForms) {
    const state = editable();
    expect(renderFleetOverlayWrite(raw, { initial: state, edited: state }), name).toBe(raw);
  }

  // 5) the preview resolves the candidate bytes through the config loader's overlay seam — a
  //    global layer's workers deny, tombstoned by a staged repo edit, previews (loadConfigWithMode
  //    over the candidate bytes) EXACTLY what a real write of those same bytes then loads, never a
  //    second merge on top of the already-merged initial state
  const previewRepo = freshRepo();
  const previewGlobal = freshGlobal();
  writeFileSync(join(previewGlobal, "config.yaml"), "routing:\n  deny:\n    workers:\n      models: [global:banned]\n");
  const inherited = fleetEditableFromConfig(loadConfig(previewRepo, { globalDir: previewGlobal }));
  expect(inherited.denyWorkersModels).toEqual(["global:banned"]);
  const candidate = renderFleetOverlayWrite("", {
    initial: inherited,
    edited: { ...inherited, denyWorkersModels: [] },
  });
  const preview = loadConfigWithMode(previewRepo, { globalDir: previewGlobal, repoOverlayText: candidate }).cfg;
  writeFileSync(join(previewRepo, ".tickmarkr", "config.yaml"), candidate);
  const real = loadConfig(previewRepo, { globalDir: previewGlobal });
  expect(preview.routing.deny?.workers?.models).toBeUndefined();
  expect(preview.routing).toEqual(real.routing);
});

// ── Leg-2 T3 fix leg (LEG2-T3-ASTRA findings 2 and 4) ──────────────────────────────────────────

test("finding 4: the universe-bearing membership write keeps an untouched flat deny scope's raw bytes and comments, and rewrites a scope only when its set changed or one of its entries still covers a channel the edit admits", () => {
  const universe = [
    { adapter: "fake", models: ["one", "two"] },
    { adapter: "other", models: ["x", "y"] },
  ];
  const load = (written: string) => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-untouched-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), written);
    return loadConfig(repo, { globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-fleet-untouched-g-")) });
  };
  const out = (cfg: ReturnType<typeof loadConfig>, adapter: string, model: string) =>
    disallowedBy({ adapter, model }, cfg.routing, "judge") !== null;

  // changing ONLY the models exclusion leaves the adapters scope byte-for-byte, comment included
  const prior = "routing:\n  deny:\n    adapters: [fake] # keep this adapter policy\n";
  const written = renderFleetOverlayWrite(prior, {
    initial: editable({ denyAdapters: ["fake"] }),
    edited: editable({ denyAdapters: ["fake"], denyModels: ["other:x"] }),
    universe,
  });
  expect(written).toContain("    adapters: [fake] # keep this adapter policy\n");
  const cfg = load(written);
  expect(cfg.routing.deny?.adapters).toEqual(["fake"]);
  expect([out(cfg, "fake", "one"), out(cfg, "fake", "two"), out(cfg, "other", "x"), out(cfg, "other", "y")])
    .toEqual([true, true, true, false]);

  // an unchanged set whose entry covers a channel the edit admits is NOT untouched: it must go,
  // or the admitted channel would stay excluded behind the preserved bytes
  const crossList = "routing:\n  deny:\n    adapters: [other:x]  # a model key in the adapters list\n";
  const admitted = renderFleetOverlayWrite(crossList, {
    initial: editable({ denyModels: ["other:x"] }),
    edited: editable(),
    universe,
  });
  expect(out(load(admitted), "other", "x")).toBe(false);
});

test("finding 2: the production preview loads the candidate bytes through the config loader's overlay seam — clearing an on-disk and a global workers deny returns both channels to the picker, and the staged routing equals the loader over the reviewed bytes", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-preview-g-"));
  // B2: Fleet writes the USER overlay, so the on-disk ban lives there and the lower-layer ban is a
  // scoped defaults injection — the one layer under the user overlay
  const seededRouting = DEFAULT_CONFIG.routing;
  DEFAULT_CONFIG.routing = { ...structuredClone(seededRouting), deny: { workers: { adapters: ["fake"] } } };
  onTestFinished(() => { DEFAULT_CONFIG.routing = seededRouting; });
  writeFileSync(join(globalDir, "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    "      fake-1: frontier",
    "      fake-2: frontier",
    "routing:",
    "  deny:",
    "    workers:",
    "      models: [fake:fake-1]  # on-disk worker ban",
    "",
  ].join("\n"));
  const adapter: WorkerAdapter = {
    id: "fake",
    vendor: "fake",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (c) => channelsFromConfig("fake", c),
    headlessCommand: () => "fake",
    interactiveCommand: () => null,
    invoke: () => ({ command: "fake" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
    listModels: async () => [],
  };
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2"],
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
      },
    },
  });
  const assembled = await assembleFleetEditor(repo, [adapter], {}, { globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const { props } = assembled;
  expect(props.initialDenyWorkersModels).toEqual(["fake:fake-1"]);
  expect(props.initialDenyWorkersAdapters).toEqual(["fake"]);

  const cleared = { adapters: [], models: [], workersAdapters: [], workersModels: [] };
  const ids = props.candidatesForShape("implement", props.initialMode, props.initialMap, cleared).rows.map((r) => r.id);
  expect(ids).toEqual(expect.arrayContaining(["fake:fake-1", "fake:fake-2"]));

  const review = props.reviewOverlay({
    denyAdapters: [],
    denyModels: [],
    denyWorkersAdapters: [],
    denyWorkersModels: [],
    classifications: [],
    selectedMode: props.initialMode,
    map: props.initialMap,
    steering: props.initialSteering,
  });
  if (review.kind !== "diff") throw new Error("clearing both worker bans must stage a diff");
  expect(review.path).toBe(join(globalDir, "config.yaml"));
  const loaded = loadConfigWithMode(repo, { globalDir, userOverlayText: review.after }).cfg;
  expect(loaded.routing.deny?.workers?.models).toBeUndefined();
  expect(loaded.routing.deny?.workers?.adapters).toBeUndefined();
  expect(props.stagedRouting?.(cleared)).toEqual({ ok: true, routing: loaded.routing });
});

test("judge c2: a staged edit whose candidate bytes the loader refuses renders an explicit preview-unavailable state naming the refusal on every preview surface, never the mode's resolved config in its place", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-refused-g-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), [
    "tiers:",
    "  fake:",
    "    vendor: fake",
    "    channel: sub",
    "    models:",
    "      fake-1: frontier",
    "      fake-2: frontier",
    "",
  ].join("\n"));
  const adapter: WorkerAdapter = {
    id: "fake",
    vendor: "fake",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (c) => channelsFromConfig("fake", c),
    headlessCommand: () => "fake",
    interactiveCommand: () => null,
    invoke: () => ({ command: "fake" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
    listModels: async () => [],
  };
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2"],
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-09-12T00:00:00.000Z" },
      },
    },
  });
  const assembled = await assembleFleetEditor(repo, [adapter], {}, { globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const { props } = assembled;
  const deny = { adapters: [], models: [], workersAdapters: [], workersModels: [] };
  // pin AND pool on one shape: the writer emits both, the loader's exclusivity refine refuses them
  const refused = {
    ...props.initialMap,
    docs: { pin: { via: "fake", model: "fake-1" }, pool: { mode: "any" as const, channels: ["fake:fake-2"] } },
  };

  const picked = props.candidatesForShape("docs", props.initialMode, refused, deny);
  expect(picked.rows).toEqual([]);
  expect(picked.excludedNote).toContain("preview unavailable");
  expect(picked.excludedNote).toContain("pin and pool are one declaration");
  expect(props.modePreview(props.initialMode, refused, deny).join("\n")).toContain("preview unavailable");
  expect(props.shapeRows(props.initialMode, refused, deny).every((row) => row.label.includes("preview unavailable"))).toBe(true);
  // the loadable staged state still previews normally
  expect(props.candidatesForShape("docs", props.initialMode, props.initialMap, deny).rows.length).toBeGreaterThan(0);
  expect(props.stagedRouting?.(deny)).toMatchObject({ ok: true });
});

test("test: an untouched entry's inline comment keeps the exact whitespace before its hash sign, and the key-line comment above the deny block and the blank line after it survive a write that clears a sibling entry, so a writer that renormalises comment spacing or drops a comment fails", () => {
  const prior = [
    "routing:",
    "  # key-line comment above the deny block",
    "  deny:",
    "    models:",
    "      - fake:one    # four spaces before the hash",
    "      - fake:two # one space before the hash",
    "      - fake:three",
    "",
    "  concurrency: 3",
    "",
  ].join("\n");
  const universe = [{ adapter: "fake", models: ["one", "two", "three"] }];
  for (const write of [
    { initial: editable({ denyModels: ["fake:one", "fake:three", "fake:two"] }), edited: editable({ denyModels: ["fake:one", "fake:two"] }), universe },
    { initial: editable({ denyModels: ["fake:one", "fake:three", "fake:two"] }), edited: editable({ denyModels: ["fake:one", "fake:two"] }) },
  ]) {
    const written = renderFleetOverlayWrite(prior, write);
    expect(written).toContain("      - fake:one    # four spaces before the hash\n");
    expect(written).toContain("      - fake:two # one space before the hash\n");
    expect(parse(written).routing.deny.models).toEqual(["fake:one", "fake:two"]);
    expect(written).toContain("routing:\n  # key-line comment above the deny block\n  deny:\n");
    expect(written).toContain("      - fake:two # one space before the hash\n\n  concurrency: 3\n");
  }
  // a note fleet itself authors still lands in the two-space style
  const fresh = renderFleetOverlayWrite("", {
    initial: editable(),
    edited: editable({ tiers: { fake: { one: { tier: "mid", provenance: "note" } } } }),
  });
  expect(fresh).toContain("one: mid  # note");
});

const effortOverlayCases = ["absent", "value", "field tombstone", "whole-model tombstone"].flatMap((lower) =>
  ["absent", "value", "tombstone"].flatMap((repo) =>
    ["set effort", "clear effort", "set-then-clear"].map((op) => ({ lower, repo, op }))));

test.each(effortOverlayCases)("effort overlay validates and preserves vendor/channel: lower=$lower repo=$repo op=$op", ({ lower, repo, op }) => {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-effort-matrix-"));
  const globalDir = join(root, "global");
  const fixtureRepo = join(root, "repo");
  mkdirSync(globalDir);
  mkdirSync(join(fixtureRepo, ".tickmarkr"), { recursive: true });
  const path = join(fixtureRepo, ".tickmarkr", "config.yaml");
  try {
    for (const [adapter, model] of [["claude-code", "fable"], ["codex", "gpt-5.6-sol"]]) {
      for (const inheritedEffort of [false, true]) {
        const effort = inheritedEffort ? { effort: "high" } : {};
        const lowerValue = lower === "absent" ? undefined
          : lower === "whole-model tombstone" ? null
          : { vendor: lower === "field tombstone" ? null : "azure", channel: "api", ...effort };
        const repoValue = repo === "absent" ? undefined : repo === "tombstone" ? null
          : { vendor: "openai", channel: "sub", effort: "medium" };
        const overlay = (value: unknown) => stringify({ tiers: { [adapter]: {
          modelOverrides: value === undefined ? {} : { [model]: value },
        } } });
        writeFileSync(join(globalDir, "config.yaml"), overlay(lowerValue));
        writeFileSync(path, overlay(repoValue));
        const load = () => loadConfig(fixtureRepo, { globalDir });
        const channel = () => channelsFromConfig(adapter, load()).find((c) => c.model === model)!;
        const { effort: _initialEffort, ...before } = channel();
        const save = (next: "low" | undefined) => {
          const initial = fleetEditableFromConfig(load());
          const edited = structuredClone(initial);
          edited.efforts ??= {};
          edited.efforts[adapter] ??= {};
          if (next === undefined) delete edited.efforts[adapter][model];
          else edited.efforts[adapter][model] = next;
          writeFleetOverlay(path, (bytes) => renderFleetOverlayWrite(bytes, {
            initial, edited, lowerOverrides: lowerOf(globalDir),
          }));
          // loadConfig validates every merged model override, including the nonempty refinement.
          const { effort: actual, ...after } = channel();
          expect(actual).toBe(next);
          expect(after).toEqual(before);
        };
        if (op !== "clear effort") save("low");
        if (op !== "set effort") save(undefined);
        if (op === "set-then-clear" && repo === "tombstone" && lowerValue != null) {
          expect(parse(readFileSync(path, "utf8")).tiers[adapter].modelOverrides[model]).toBeNull();
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// B2: Fleet saves effort to the USER overlay, whose only lower layer is the defaults — so the
// lower-layer fixture is a scoped DEFAULT_CONFIG injection (the loader clones the defaults per call).
test("Fleet saving effort through a user modelOverrides tombstone remasks both lower sibling vendor and channel fields while preserving an unrelated model mask and rejecting a user or repo edit made after preview", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-lower-g-"));
  const globalPath = join(globalDir, "config.yaml");
  const overlayPath = join(repo, ".tickmarkr", "config.yaml");
  const models = ["codex-a", "codex-b", "codex-c", "codex-d"];
  // the defaults declare vendor/channel metadata for two siblings; the user's null masks all of it
  const seededCodex = DEFAULT_CONFIG.tiers.codex;
  const lower = Object.fromEntries(["codex-a", "codex-b"].map((m) => [m, { vendor: "azure", channel: "api" }]));
  DEFAULT_CONFIG.tiers.codex = { ...structuredClone(seededCodex), modelOverrides: lower };
  onTestFinished(() => { DEFAULT_CONFIG.tiers.codex = seededCodex; });
  const userBytes = `# my machine choices\n${stringify({ tiers: { codex: {
    models: Object.fromEntries(models.map((m) => [m, "frontier"])),
    modelOverrides: null,
  } } })}`;
  writeFileSync(globalPath, userBytes);
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  const repoBytes = "concurrency: 2  # project execution preference\n";
  writeFileSync(overlayPath, repoBytes);
  const adapter: WorkerAdapter = {
    id: "codex",
    vendor: "openai",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (c) => channelsFromConfig("codex", c),
    headlessCommand: () => "codex",
    interactiveCommand: () => null,
    invoke: () => ({ command: "codex" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
    listModels: async () => [],
  };
  registry.writeDoctor(repo, {
    codex: {
      installed: true,
      authed: true,
      version: "fake",
      models,
      modelAuth: Object.fromEntries(models.map((m) => [m, { authed: true, probedAt: "2026-09-27T00:00:00.000Z" }])),
    },
  });
  const assembled = await assembleFleetEditor(repo, [adapter], {}, { globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const { props, commit } = assembled;
  const state = {
    denyAdapters: props.initialDenyAdapters,
    denyModels: props.initialDenyModels,
    denyWorkersAdapters: props.initialDenyWorkersAdapters,
    denyWorkersModels: props.initialDenyWorkersModels,
    classifications: [],
    efforts: { codex: { "codex-a": "low" as const } },
    selectedMode: props.initialMode,
    map: props.initialMap,
    steering: props.initialSteering,
  };
  const review = () => {
    const staged = props.reviewOverlay(state);
    if (staged.kind !== "diff") throw new Error("an effort edit must stage a diff");
    return staged;
  };
  const masked = (bytes: string) => parse(bytes).tiers.codex.modelOverrides;

  // the preview names the USER destination; lifting the tombstone remasks codex-a's vendor AND channel
  // and keeps codex-b's mask
  const first = review();
  expect(first.path).toBe(globalPath);
  expect(masked(first.after)).toEqual({ "codex-a": { effort: "low", vendor: null, channel: null }, "codex-b": null });
  expect(props.reloadGuard(first.after)).toBeNull();

  // a same-key USER edit after the preview (another process sets codex-a's effort): re-rendering the
  // staged effort over it reproduces the reviewed bytes, so only the moved user bytes can refuse it
  const racing = first.after.replace("effort: low", "effort: medium");
  expect(racing).not.toBe(first.after);
  writeFileSync(globalPath, racing);
  expect(props.reloadGuard(first.after)).toMatch(/^stale preview — the user overlay/);
  expect(commit({ kind: "write", review: first })).toMatch(/^fleet: nothing written — stale preview — the user overlay/);
  expect(readFileSync(globalPath, "utf8")).toBe(racing);
  const edited = `${userBytes}# edited after the preview\n`;
  writeFileSync(globalPath, edited);

  // a REPO edit after the preview: refused the same way, although the user bytes are current
  const second = review();
  writeFileSync(overlayPath, `${repoBytes}# edited after the preview\n`);
  expect(props.reloadGuard(second.after)).toMatch(/^stale preview — the repository overlay/);
  expect(commit({ kind: "write", review: second })).toMatch(/^fleet: nothing written — stale preview — the repository overlay/);
  expect(readFileSync(globalPath, "utf8")).toBe(edited);

  // re-reviewed against the current layers the save lands: only the user file changes, untouched
  // comments survive, and only codex-a's effort changes in the merged seats
  const masking = channelsFromConfig("codex", loadConfig(repo, { globalDir }));
  const repoNow = readFileSync(overlayPath, "utf8");
  const fresh = review();
  expect(props.reloadGuard(fresh.after)).toBeNull();
  expect(commit({ kind: "write", review: fresh })).toBe(`fleet: wrote ${globalPath}`);
  expect(readFileSync(globalPath, "utf8")).toBe(fresh.after);
  expect(fresh.after).toContain("# my machine choices");
  expect(fresh.after).toContain("# edited after the preview");
  expect(readFileSync(overlayPath, "utf8")).toBe(repoNow);
  const saved = channelsFromConfig("codex", loadConfig(repo, { globalDir }));
  for (const model of models) {
    const expected = masking.find((c) => c.model === model);
    expect(expected).toMatchObject({ vendor: "openai", channel: "sub" }); // the user's null masked the default azure/api metadata
    expect(saved.find((c) => c.model === model)).toEqual(model === "codex-a" ? { ...expected, effort: "low" } : expected);
  }
});

test("test: Fleet persists an effort write only with complete lower-layer input while a non-effort edit retains its existing contract, so an effort call omitting lower state compiling or reaching disk fails", () => {
  // compile time: the writer's own type, checked by the compiler the build uses
  const probe = join(import.meta.dirname, "__fleet_effort_contract__.ts");
  const source = [
    'import { renderFleetOverlayWrite } from "../../src/config/fleet-overlay.js";',
    'import type { FleetEditable, LowerLayerModelOverrides } from "../../src/config/config.js";',
    "declare const staged: FleetEditable;",
    "declare const lower: LowerLayerModelOverrides;",
    "const plain = { denyAdapters: [], denyModels: [], tiers: {}, map: {}, floors: {} };",
    'renderFleetOverlayWrite("", { initial: staged, edited: staged, lowerOverrides: lower });',
    'renderFleetOverlayWrite("", { initial: plain, edited: { ...plain, floors: { spec: "frontier" } } });',
    'renderFleetOverlayWrite("", { initial: staged, edited: staged });',
  ].join("\n");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, language, ...rest) =>
    name === probe ? ts.createSourceFile(name, source, language) : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = (name) => name === probe || fileExists.call(host, name);
  host.readFile = (name) => (name === probe ? source : readFile.call(host, name));
  const program = ts.createProgram([probe], options, host);
  const file = program.getSourceFile(probe)!;
  const errorLines = program.getSemanticDiagnostics(file)
    .map((d) => file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1);
  expect(errorLines).toEqual([8]); // only the effort-capable call without lower state

  // runtime: a cast/JS caller omitting lower state is refused before the temp file exists
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-effort-lower-"));
  const globalDir = join(root, "global");
  mkdirSync(globalDir);
  writeFileSync(join(globalDir, "config.yaml"), stringify({
    tiers: { codex: { modelOverrides: { m1: { vendor: "azure", channel: "api" }, m2: { vendor: "azure" } } } },
  }));
  const path = join(root, "config.yaml");
  const prior = stringify({ tiers: { codex: { modelOverrides: null } } });
  writeFileSync(path, prior);
  const initial = editable();
  const withEffort = editable({ efforts: { codex: { m1: "low" } } });
  const blind = { initial, edited: withEffort } as unknown as FleetOverlayWrite;
  expect(() => writeFleetOverlay(path, (bytes) => renderFleetOverlayWrite(bytes, blind)))
    .toThrow("the effort edit on codex:m1 needs the lower config layers' model overrides");
  expect(readFileSync(path, "utf8")).toBe(prior);
  expect(existsSync(`${path}.tmp`)).toBe(false);

  // an unreadable lower layer yields no input to write with
  const brokenDir = join(root, "broken");
  mkdirSync(brokenDir);
  writeFileSync(join(brokenDir, "config.yaml"), "tiers: [unclosed\n");
  expect(lowerLayerModelOverrides({ globalDir: brokenDir })).toMatchObject({ ok: false });

  // the same edit with the complete lower read persists, re-masking what lifting the tombstone exposed
  writeFleetOverlay(path, (bytes) => renderFleetOverlayWrite(bytes, { initial, edited: withEffort, lowerOverrides: lowerOf(globalDir) }));
  const overrides = parse(readFileSync(path, "utf8")).tiers.codex.modelOverrides;
  expect(overrides.m1).toEqual({ effort: "low", vendor: null, channel: null });
  expect(overrides.m2).toBeNull();

  // a non-effort edit keeps its contract: no lower state, the same bytes as ever
  const floorsOnly = { initial, edited: editable({ floors: { spec: "frontier" } }) } as FleetOverlayWrite;
  expect(renderFleetOverlayWrite(prior, floorsOnly)).toBe(`${prior}routing:\n  floors:\n    spec: frontier\n`);
  const unchangedEffort = editable({ efforts: { codex: { m1: "high" } } });
  expect(renderFleetOverlayWrite(prior, { initial: unchangedEffort, edited: { ...unchangedEffort, floors: { spec: "frontier" } } } as FleetOverlayWrite))
    .toBe(renderFleetOverlayWrite(prior, floorsOnly));
});

// T8: a fleet session over an isolated HOME and an isolated user-overlay directory. The real user's
// files (resolved before HOME is stubbed) are snapshotted so a test can prove nothing touched them.
const t8Seat = (id: string): WorkerAdapter => ({
  id,
  vendor: id,
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: (c) => channelsFromConfig(id, c),
  headlessCommand: () => id,
  interactiveCommand: () => null,
  invoke: () => ({ command: id }),
  parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  listModels: async () => [],
});
const T8_SEATS = [t8Seat("fake"), t8Seat("codex")];
const t8Doctor = (repo: string) => registry.writeDoctor(repo, Object.fromEntries(
  [["fake", "fake-1"], ["codex", "gpt-5.6-terra"]].map(([id, model]) => [id, {
    installed: true, authed: true, version: "fake", models: [model],
    modelAuth: { [model]: { authed: true, probedAt: "2026-09-30T00:00:00.000Z" } },
  }]),
));
const t8Session = async (fake1: "cheap" | "frontier", overlayTail = "") => {
  const realUserFiles = [join(homedir(), ".config", "tickmarkr", "config.yaml"), join(globalConfigDir(), "config.yaml")];
  const snapshot = () => realUserFiles.map((path) => (existsSync(path) ? readFileSync(path, "utf8") : null));
  const real = snapshot();
  const home = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-home-"));
  vi.stubEnv("HOME", home);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-user-"));
  const userPath = join(globalDir, "config.yaml");
  const userBytes = `# operator machine choices\ntiers:\n  fake:\n    vendor: fake\n    channel: sub\n    models:\n      fake-1: ${fake1}\n${overlayTail}`;
  writeFileSync(userPath, userBytes);
  const editorIn = async (repo: string) => {
    t8Doctor(repo);
    const assembled = await assembleFleetEditor(repo, T8_SEATS, {}, { globalDir });
    if ("unavailable" in assembled) throw new Error(assembled.unavailable);
    return assembled;
  };
  const repo = makeRepo({ "keep.txt": "x" });
  const realUntouched = () => {
    expect(snapshot()).toEqual(real);
    expect(readdirSync(home)).toEqual([]);
  };
  return { repo, globalDir, userPath, userBytes, editor: await editorIn(repo), editorIn, realUntouched };
};
const t8Deny = { adapters: [], models: [], workersAdapters: [], workersModels: [] };
type T8Props = Extract<Awaited<ReturnType<typeof assembleFleetEditor>>, { props: unknown }>["props"];
const t8State = (props: T8Props) => ({
  denyAdapters: props.initialDenyAdapters ?? [],
  denyModels: props.initialDenyModels ?? [],
  denyWorkersAdapters: props.initialDenyWorkersAdapters ?? [],
  denyWorkersModels: props.initialDenyWorkersModels ?? [],
  classifications: [],
  selectedMode: props.initialMode,
  map: props.initialMap,
  steering: props.initialSteering,
});
const whyRowOf = (why: string, shape: string) => why.split("\n").find((line) => line.startsWith(`${shape}  →`));
const DEFAULT_PIN = { pin: { via: "claude-code", model: "fable" } };
const labelsOf = (rows: Array<{ label: string }>) => rows.map((row) => row.label).join("\n");

test("FleetEditor Auto over the inherited spec fable pin saves a null tombstone and reloads unpinned in a second isolated repository while an untouched pin keeps its original provenance", async () => {
  const { globalDir, userPath, userBytes, editor, editorIn, realUntouched } = await t8Session("frontier");
  const { props, commit, renderWhy } = editor;
  // spec and plan both inherit the defaults' fable pin — the user overlay declares neither
  expect(props.initialMap.spec).toEqual(DEFAULT_PIN);
  expect(props.initialMap.plan).toEqual(DEFAULT_PIN);
  const planRow = whyRowOf(renderWhy(), "plan");
  expect(planRow).toContain("source: seed-default");

  // the editor's a on spec: Auto clears the inherited pin
  const map = { ...props.initialMap, spec: autoMapEntry(props.initialMap.spec) };
  const review = props.reviewOverlay({ ...t8State(props), map });
  if (review.kind !== "diff") throw new Error("Auto over an inherited pin must stage a diff");
  expect(review.after).toBe(`${userBytes}routing:\n  map:\n    spec:\n      pin: null\n`);
  expect(parse(review.after).routing.map).toEqual({ spec: { pin: null } }); // a raw tombstone, never a prefer
  expect(commit({ kind: "write", review })).toBe(`fleet: wrote ${userPath}`);
  expect(readFileSync(userPath, "utf8")).toBe(review.after);

  // a second isolated repository inherits only the user overlay: spec is unpinned and routes automatically
  const second = makeRepo({ "keep.txt": "x" });
  const cfg = loadConfig(second, { globalDir });
  expect(cfg.routing.map.spec).toEqual({});
  const task = TaskSchema.parse({ id: "T1", title: "t", goal: "g", shape: "spec", complexity: 3, acceptance: ["a"] });
  expect(route(task, cfg, channelsFromConfig("fake", cfg)).assignment).toMatchObject({ adapter: "fake", model: "fake-1" });
  expect(fleetKeyLayer(second, "routing.map.spec.pin", { globalDir })).toBe("global");
  // the untouched plan pin is still the defaults' own, with the same provenance on a fresh editor
  expect(cfg.routing.map.plan).toEqual(DEFAULT_PIN);
  expect(fleetKeyLayer(second, "routing.map.plan.pin", { globalDir })).toBe("defaults");
  expect(whyRowOf((await editorIn(second)).renderWhy(), "plan")).toBe(planRow);
  realUntouched();
});

test("FleetEditor saving reviewed staged classification effort and Auto produces previews equal to a fresh isolated load while a rejected review preserves the lower layer and real user files untouched", async () => {
  const { repo, globalDir, userPath, userBytes, editor, editorIn, realUntouched } = await t8Session("cheap");
  const { props, commit, previewConfig } = editor;
  const lowerBefore = lowerLayerModelOverrides({ globalDir, below: "user" });
  // the staged session: fake-1 reclassified frontier, codex terra at high effort, Auto on spec
  const stage: FleetStagedMetadata = {
    classifications: [{ adapter: "fake", model: "fake-1", tier: "frontier", note: "AA Index 60" }],
    efforts: { codex: { "gpt-5.6-terra": "high" } },
  };
  const map = { ...props.initialMap, spec: autoMapEntry(props.initialMap.spec) };
  const state = { ...t8State(props), ...stage, map };
  const previewsOf = (p: T8Props, m: T8Props["initialMap"], s?: FleetStagedMetadata) => ({
    mode: p.modePreview(p.initialMode, m, t8Deny, s),
    shapes: p.shapeRows(p.initialMode, m, t8Deny, s),
    pickers: (["spec", "migration", "implement"] as const).map((shape) => p.candidatesForShape(shape, p.initialMode, m, t8Deny, s)),
  });
  const staged = previewsOf(props, map, stage);
  const candidate = previewConfig(props.initialMode, map, t8Deny, stage);

  // rejected review: nothing lands — the user bytes, the defaults under them and the inherited pin all hold
  const rejected = props.reviewOverlay(state);
  if (rejected.kind !== "diff") throw new Error("the staged session must stage a diff");
  expect(commit({ kind: "discard" })).toBe("fleet: discarded overlay changes");
  expect(readFileSync(userPath, "utf8")).toBe(userBytes);
  expect(lowerLayerModelOverrides({ globalDir, below: "user" })).toEqual(lowerBefore);
  const kept = loadConfig(repo, { globalDir });
  expect(kept.routing.map.spec).toEqual(DEFAULT_PIN);
  expect(kept.tiers.fake.models["fake-1"]).toBe("cheap");
  expect(kept.tiers.codex.modelOverrides?.["gpt-5.6-terra"]?.effort).toBeUndefined();
  realUntouched();

  // reviewed and saved: a fresh editor in a second isolated repository previews exactly what the stage previewed
  const review = props.reviewOverlay(state);
  if (review.kind !== "diff") throw new Error("the staged session must stage a diff");
  expect(rejected.after).toBe(review.after);
  expect(commit({ kind: "write", review })).toBe(`fleet: wrote ${userPath}`);
  const second = makeRepo({ "keep.txt": "x" });
  const fresh = await editorIn(second);
  expect(fresh.props.initialMap.spec).toEqual({});
  expect(previewsOf(fresh.props, fresh.props.initialMap)).toEqual(staged);
  expect(labelsOf(staged.shapes)).toContain("migration  →  fake:fake-1 (sub, frontier)");
  expect(labelsOf(staged.shapes)).toContain("implement  →  codex:gpt-5.6-terra (sub, mid, effort high)");
  if (!candidate.ok) throw new Error(candidate.error);
  expect(candidate.cfg).toEqual(loadConfigWithMode(second, { globalDir }).cfg);
  realUntouched();
});

test("FleetEditor Auto over an aliased empty spec entry writes the pin null tombstone and reloads unpinned", async () => {
  // `spec: *empty` is an alias to a mapping, not a scalar tombstone: spec still inherits the defaults' pin
  const tail = "shared: &empty {}\nrouting:\n  map:\n    spec: *empty\n";
  const { globalDir, userPath, editor, realUntouched } = await t8Session("frontier", tail);
  const { props, commit } = editor;
  expect(props.initialMap.spec).toEqual(DEFAULT_PIN);
  const map = { ...props.initialMap, spec: autoMapEntry(props.initialMap.spec) };
  const review = props.reviewOverlay({ ...t8State(props), map });
  if (review.kind !== "diff") throw new Error("Auto over an aliased inherited pin must stage a diff");
  const after = parse(review.after);
  expect(after.routing.map.spec).toEqual({ pin: null });
  expect(after.shared).toEqual({}); // the anchored node every other alias shares is never edited
  expect(commit({ kind: "write", review })).toBe(`fleet: wrote ${userPath}`);
  const second = makeRepo({ "keep.txt": "x" });
  expect(loadConfig(second, { globalDir }).routing.map.spec).toEqual({});
  realUntouched();
});

test("Auto over an aliased user pin deletes the pin from an un-anchored copy while the anchored node and its other alias keep the pin", () => {
  const prior = "shared: &pinned\n  pin:\n    via: codex\n    model: gpt-5.6-terra\nrouting:\n  map:\n    docs: *pinned\n    chore: *pinned\n";
  const pinned = { pin: { via: "codex", model: "gpt-5.6-terra" } };
  const written = parse(renderFleetOverlayWrite(prior, {
    initial: editable({ map: { docs: pinned, chore: pinned } }),
    edited: editable({ map: { docs: autoMapEntry(pinned), chore: pinned } }),
    lowerMap: DEFAULT_CONFIG.routing.map,
  }));
  expect(written.routing.map.docs).toEqual({});
  expect(written.routing.map.chore).toEqual(pinned);
  expect(written.shared).toEqual(pinned);
});

test("FleetEditor Auto on spec under a nested-anchor alias map clears only spec while the sibling plan alias keeps its inherited pin and provenance", async () => {
  // D-821: the copy of *entries must not carry &empty, or plan: *empty rebinds to the edited spec
  const tail = "shared: &entries\n  spec: &empty {}\n  plan: *empty\nrouting:\n  map: *entries\n";
  const { globalDir, userPath, userBytes, editor, editorIn, realUntouched } = await t8Session("frontier", tail);
  const { props, commit } = editor;
  expect(props.initialMap.spec).toEqual(DEFAULT_PIN);
  expect(props.initialMap.plan).toEqual(DEFAULT_PIN);
  const planRow = whyRowOf(editor.renderWhy(), "plan");
  expect(planRow).toBeDefined();
  const map = { ...props.initialMap, spec: autoMapEntry(props.initialMap.spec) };
  const review = props.reviewOverlay({ ...t8State(props), map });
  if (review.kind !== "diff") throw new Error("Auto over a nested-anchor aliased pin must stage a diff");
  const after = parse(review.after);
  expect(after.routing.map).toEqual({ spec: { pin: null }, plan: {} });
  expect(review.after.startsWith(userBytes.replace(/routing:\n {2}map: \*entries\n$/, ""))).toBe(true); // shared bytes untouched
  expect(after.shared).toEqual({ spec: {}, plan: {} });
  expect(props.reloadGuard(review.after)).toBeNull();
  expect(commit({ kind: "write", review })).toBe(`fleet: wrote ${userPath}`);
  const second = makeRepo({ "keep.txt": "x" });
  const cfg = loadConfig(second, { globalDir });
  expect(cfg.routing.map.spec).toEqual({});
  expect(cfg.routing.map.plan).toEqual(DEFAULT_PIN);
  expect(fleetKeyLayer(second, "routing.map.plan.pin", { globalDir })).toBe("defaults");
  expect(whyRowOf((await editorIn(second)).renderWhy(), "plan")).toBe(planRow);
  realUntouched();
});

test("setting and deleting through nested aliases edit only the reached entry: sibling and later aliases keep resolving to the original anchors", () => {
  const pinned = { pin: { via: "codex", model: "gpt-5.6-terra" } };
  const write = (prior: string, initialMap: FleetEditable["map"], editedMap: FleetEditable["map"]) =>
    parse(renderFleetOverlayWrite(prior, { initial: editable({ map: initialMap }), edited: editable({ map: editedMap }), lowerMap: DEFAULT_CONFIG.routing.map }));

  // set: the pin:null tombstone lands on spec only; a later *empty still names the shared {}
  const setPrior = "shared: &entries\n  spec: &empty {}\n  plan: *empty\nrouting:\n  map: *entries\nlater: *empty\n";
  const inherited = { spec: DEFAULT_PIN, plan: DEFAULT_PIN };
  const set = write(setPrior, inherited, { spec: autoMapEntry(DEFAULT_PIN), plan: DEFAULT_PIN });
  expect(set.routing.map).toEqual({ spec: { pin: null }, plan: {} });
  expect(set.shared).toEqual({ spec: {}, plan: {} });
  expect(set.later).toEqual({});

  // delete: Auto on docs deletes its own pin; the sibling chore and a later alias keep it
  const delPrior = "shared: &entries\n  docs: &pinned\n    pin: {via: codex, model: gpt-5.6-terra}\n  chore: *pinned\nrouting:\n  map: *entries\nlater: *pinned\n";
  const del = write(delPrior, { docs: pinned, chore: pinned }, { docs: autoMapEntry(pinned), chore: pinned });
  expect(del.routing.map).toEqual({ docs: {}, chore: pinned });
  expect(del.shared).toEqual({ docs: pinned, chore: pinned });
  expect(del.later).toEqual(pinned);

  // a sibling whose anchor is redefined before the copy is expanded, never rebound to the redefinition
  const shadowPrior = "shared: &entries\n  spec: &empty {}\n  plan: *empty\nredefined: &empty\n  pin: {via: codex, model: gpt-5.6-terra}\nrouting:\n  map: *entries\n";
  const shadow = write(shadowPrior, inherited, { spec: autoMapEntry(DEFAULT_PIN), plan: DEFAULT_PIN });
  expect(shadow.routing.map).toEqual({ spec: { pin: null }, plan: {} });
  expect(shadow.redefined).toEqual(pinned);
});
