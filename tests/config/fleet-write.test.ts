import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

import { fleet, writeFleetOverlay } from "../../src/cli/commands/fleet.js";
import {
  fleetEditableFromConfig,
  fleetRepoOverlayFromDelta,
  loadConfig,
  renderFleetOverlayWrite,
  type FleetEditable,
} from "../../src/config/config.js";

const editable = (over: Partial<FleetEditable> = {}): FleetEditable => ({
  denyAdapters: [],
  denyModels: [],
  tiers: {},
  map: {},
  floors: {},
  ...over,
});

const occurrences = (text: string, fragment: string) => text.split(fragment).length - 1;

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

test("v1.92 membership write: changed exclusion sets emit the minimal routing.allow form — bare ids for fully-in adapters, adapter:model keys for partially-in — and tombstone the deny adapters/models scopes while deny.workers survives byte-for-byte", () => {
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
  expect(parsed.routing.deny.adapters).toBeNull();
  expect(parsed.routing.deny.models).toBeNull();
  expect(parsed.routing.deny.workers).toEqual({ adapters: ["pi"] });
  expect(written).toContain("    workers:\n      adapters:\n        - pi  # reviewer-only mask, fleet never touches it");
  expect(written).toMatch(/^    adapters: null {2}# rail mask$/m);
  expect(occurrences(written, "rail mask")).toBe(1);
});

test("v1.92 membership write: clearing every exclusion removes the routing.allow block entirely and tombstones both deny scopes", () => {
  const prior = [
    "routing:",
    "  allow:",
    "    adapters: [claude-code]",
    "  deny:",
    "    models: [codex:o5-mini]",
    "",
  ].join("\n");
  const written = renderFleetOverlayWrite(prior, {
    initial: editable({ denyAdapters: ["codex", "grok"] }),
    edited: editable(),
    universe: [
      { adapter: "claude-code", models: ["fable"] },
      { adapter: "codex", models: ["gpt-5.6-luna"] },
      { adapter: "grok", models: ["grok-4"] },
    ],
  });
  const parsed = parse(written);
  expect(parsed.routing.allow).toBeUndefined();
  expect(written).not.toContain("allow");
  expect(parsed.routing.deny.adapters).toBeNull();
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
  expect(reloaded.denyAdapters).toEqual(["grok"]);
  expect(reloaded.denyModels).toEqual(["codex:o5-mini"]);
  // absent universe ⇒ deny arrays verbatim: the tombstoned scopes reload as empty
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

  // write leg: an unrelated membership change keeps the residual in routing.deny
  const edited = structuredClone(initial);
  edited.denyModels = [...new Set([...edited.denyModels, "codex:gpt-5.6-sol"])].sort();
  const written = renderFleetOverlayWrite(prior, { initial, edited, universe });
  const parsed = parse(written);
  expect(parsed.routing.deny.models).toEqual(["claude-code:fable"]);
  expect(parsed.routing.deny.adapters).toBeNull();
  expect(parsed.routing.allow).toEqual({ adapters: ["claude-code"] });
  expect(written).toContain("# operator-directed: replaced by claude-opus-5 at lower cost");
  expect(written).toContain("# restore by deleting this line on dated evidence");

  // round trip: reload the written overlay — fable is STILL denied (deny beats allow) and the
  // editable state reproduces every exclusion
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), written);
  const reloaded = fleetEditableFromConfig(loadConfig(repo, { globalDir }), universe);
  expect(reloaded.denyModels).toContain("claude-code:fable");
  // both codex universe models are now excluded — the derivation folds them into ONE
  // adapter-level exclusion (grok-round-trip precedent above)
  expect(reloaded.denyAdapters).toContain("codex");
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
