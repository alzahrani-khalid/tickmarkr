import { expect, test } from "vitest";
import { pi } from "../../src/adapters/pi.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { pickReviewer } from "../../src/gates/review.js";

test("test: every channel pi advertises carries the vendor named by its model provider prefix so an openai-codex model carries openai and a zai model carries zhipu whereas a declared modelOverrides vendor still wins and an unknown prefix keeps the configured vendor so the shipped adapter stamping the tier vendor on every model fails", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers.pi = {
    vendor: "configured",
    channel: "sub",
    models: {
      "openai-codex/gpt-5.5": "frontier",
      "zai/glm-5.2": "mid",
      "openai-codex/overridden": "mid",
      "private/model": "cheap",
    },
    modelOverrides: { "openai-codex/overridden": { vendor: "declared" } },
  };

  expect(Object.fromEntries(pi.channels!(cfg).map((channel) => [channel.model, channel.vendor]))).toEqual({
    "openai-codex/gpt-5.5": "openai",
    "zai/glm-5.2": "zhipu",
    "openai-codex/overridden": "declared",
    "private/model": "configured",
  });
});

test("test: the review gate's reviewer choice with pi openai-codex gpt-5.5 among the channels excludes it as reviewer for a codex author yet still admits pi zai glm-5.2 for that author whereas a fleet whose pi channels all read zhipu admits the same-vendor seat and fails", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers.pi = {
    vendor: "zhipu",
    channel: "sub",
    models: { "openai-codex/gpt-5.5": "frontier", "zai/glm-5.2": "mid" },
  };
  const author: Assignment = { adapter: "codex", model: "gpt-5.6-sol", channel: "sub", tier: "frontier" };
  const authorChannel: BillingChannel = { ...author, vendor: "openai" };
  const channels = pi.channels!(cfg);
  const openaiPi = channels.find((channel) => channel.model === "openai-codex/gpt-5.5")!;
  const zaiPi = channels.find((channel) => channel.model === "zai/glm-5.2")!;

  expect(pickReviewer(author, [authorChannel, openaiPi])).toBeNull();
  expect(pickReviewer(author, [authorChannel, openaiPi, zaiPi])).toBe(zaiPi);

  const staleFleet = [authorChannel, ...channels.map((channel) => ({ ...channel, vendor: "zhipu" }))];
  expect(pickReviewer(author, staleFleet)).toMatchObject({ adapter: "pi", model: "openai-codex/gpt-5.5" });
});
