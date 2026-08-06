import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { channelsFromConfig, type BillingChannel } from "../../src/adapters/types.js";
import {
  ConfigError,
  DEFAULT_CONFIG,
  loadConfig,
  TickmarkrConfigSchema,
  type TickmarkrConfig,
} from "../../src/config/config.js";
import { pickReviewer } from "../../src/gates/review.js";

function configWithTiers(tiers: Record<string, unknown>): TickmarkrConfig {
  return TickmarkrConfigSchema.parse({ ...structuredClone(DEFAULT_CONFIG), tiers });
}

function repoWithOverlay(yaml: string) {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-vendor-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-vendor-r-"));
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir };
}

function assignment(channel: BillingChannel) {
  const { adapter, model, channel: billing, tier } = channel;
  return { adapter, model, channel: billing, tier };
}

test("test: a per-model override supplies that model's vendor and channel while a model with no override inherits the parent entry's, proven member by member over the closed set of override shapes — a no-override fixture, a vendor-only fixture, a channel-only fixture and a both fixture", () => {
  const cfg = configWithTiers({
    fixture: {
      vendor: "parent-vendor",
      channel: "sub",
      models: {
        inherited: "cheap",
        "vendor-only": "mid",
        "channel-only": "frontier",
        both: "mid",
      },
      modelOverrides: {
        "vendor-only": { vendor: "model-vendor" },
        "channel-only": { channel: "api" },
        both: { vendor: "both-vendor", channel: "api" },
      },
    },
  });

  expect(channelsFromConfig("fixture", cfg)).toEqual([
    { adapter: "fixture", vendor: "parent-vendor", model: "inherited", channel: "sub", tier: "cheap" },
    { adapter: "fixture", vendor: "model-vendor", model: "vendor-only", channel: "sub", tier: "mid" },
    { adapter: "fixture", vendor: "parent-vendor", model: "channel-only", channel: "api", tier: "frontier" },
    { adapter: "fixture", vendor: "both-vendor", model: "both", channel: "api", tier: "mid" },
  ]);
});

test("test: an entry declaring vendor null is rejected at config load while any model under it lacks an override carrying a NONEMPTY vendor, and a channel-only override is rejected under vendor null rather than counting toward acceptance", () => {
  const invalidOverrides = [
    "",
    "    model-a: { channel: api }\n",
    "    model-a: { vendor: '   ' }\n",
    "    model-a: { vendor: declared-vendor }\n",
  ];

  for (const [index, modelOverrides] of invalidOverrides.entries()) {
    const secondModel = index === 3 ? "      model-b: mid\n" : "";
    const { repo, globalDir } = repoWithOverlay([
      "tiers:",
      "  fixture:",
      "    vendor: null",
      "    channel: sub",
      "    models:",
      "      model-a: cheap",
      secondModel.trimEnd(),
      "    modelOverrides:",
      modelOverrides.trimEnd(),
      "",
    ].filter((line) => line !== "").join("\n"));
    expect(() => loadConfig(repo, { globalDir }), `invalid fixture ${index}`).toThrow(ConfigError);
  }

  const valid = repoWithOverlay(`tiers:
  fixture:
    vendor: null
    channel: sub
    models:
      model-a: cheap
      model-b: mid
    modelOverrides:
      model-a: { vendor: declared-a }
      model-b: { vendor: declared-b, channel: api }
`);
  expect(channelsFromConfig("fixture", loadConfig(valid.repo, { globalDir: valid.globalDir }))).toEqual([
    { adapter: "fixture", vendor: "declared-a", model: "model-a", channel: "sub", tier: "cheap" },
    { adapter: "fixture", vendor: "declared-b", model: "model-b", channel: "api", tier: "mid" },
  ]);

  const bypassedLoader = {
    ...structuredClone(DEFAULT_CONFIG),
    tiers: { fixture: { vendor: null, channel: "sub", models: { "provider/model": "mid" } } },
  } as unknown as TickmarkrConfig;
  expect(channelsFromConfig("fixture", bypassedLoader)).toEqual([]);
});

test("test: every pre-change config compiles to a byte-identical channel list, proven over the closed set of shipped seed entries — a single-model entry, a multi-model entry and an entry carrying a windows block", () => {
  const fixtures = [
    ["single-model", "opencode"],
    ["multi-model", "kimi"],
    ["windows-block", "claude-code"],
  ] as const;

  for (const [name, adapter] of fixtures) {
    const entry = DEFAULT_CONFIG.tiers[adapter];
    const legacy = Object.entries(entry.models).map(([model, tier]) => ({
      adapter,
      vendor: entry.vendor,
      model,
      channel: entry.channel,
      tier,
    }));
    expect(JSON.stringify(channelsFromConfig(adapter, DEFAULT_CONFIG)), name).toBe(JSON.stringify(legacy));
  }
});

test("test: two channels resolving to the same vendor are refused as a review pair even when their model ids differ, proven over the closed set of vendor sources — a parent-inherited pair, a per-model-override pair and a mixed pair", () => {
  const fixtures = [
    [
      "parent-inherited",
      { vendor: "shared", channel: "sub", models: { "provider-a/author": "mid" } },
      { vendor: "shared", channel: "sub", models: { "provider-b/reviewer": "frontier" } },
    ],
    [
      "per-model-override",
      {
        vendor: "parent-a", channel: "sub", models: { "provider-a/author": "mid" },
        modelOverrides: { "provider-a/author": { vendor: "shared" } },
      },
      {
        vendor: "parent-b", channel: "sub", models: { "provider-b/reviewer": "frontier" },
        modelOverrides: { "provider-b/reviewer": { vendor: "shared" } },
      },
    ],
    [
      "mixed",
      { vendor: "shared", channel: "sub", models: { "provider-a/author": "mid" } },
      {
        vendor: "other-parent", channel: "sub", models: { "provider-b/reviewer": "frontier" },
        modelOverrides: { "provider-b/reviewer": { vendor: "shared" } },
      },
    ],
  ] as const;

  for (const [name, authorEntry, reviewerEntry] of fixtures) {
    const cfg = configWithTiers({ author: authorEntry, reviewer: reviewerEntry });
    const channels = [...channelsFromConfig("author", cfg), ...channelsFromConfig("reviewer", cfg)];
    expect(pickReviewer(assignment(channels[0]), channels), name).toBeNull();
  }

  const declaredNotDerived = configWithTiers({
    author: { vendor: "operator-a", channel: "sub", models: { "same-prefix/author": "mid" } },
    reviewer: { vendor: "operator-b", channel: "sub", models: { "same-prefix/reviewer": "frontier" } },
  });
  const declaredChannels = [
    ...channelsFromConfig("author", declaredNotDerived),
    ...channelsFromConfig("reviewer", declaredNotDerived),
  ];
  expect(pickReviewer(assignment(declaredChannels[0]), declaredChannels)).toEqual(declaredChannels[1]);
});
