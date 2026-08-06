import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

import { fleet, writeFleetOverlay } from "../../src/cli/commands/fleet.js";
import {
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
