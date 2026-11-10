import { expect, test } from "vitest";
import { pi, piModelVendor } from "../../src/adapters/pi.js";
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
  const author: Assignment = { adapter: "codex", model: "gpt-5.6-sol", channel: "sub", tier: "mid" }; // RF-1: at the zai seat's tier
  const authorChannel: BillingChannel = { ...author, vendor: "openai" };
  const channels = pi.channels!(cfg);
  const openaiPi = channels.find((channel) => channel.model === "openai-codex/gpt-5.5")!;
  const zaiPi = channels.find((channel) => channel.model === "zai/glm-5.2")!;

  expect(pickReviewer(author, [authorChannel, openaiPi])).toBeNull();
  expect(pickReviewer(author, [authorChannel, openaiPi, zaiPi])).toBe(zaiPi);

  const staleFleet = [authorChannel, ...channels.map((channel) => ({ ...channel, vendor: "zhipu" }))];
  expect(pickReviewer(author, staleFleet)).toMatchObject({ adapter: "pi", model: "zai/glm-5.2" });
});

// Queue row 392 R6 law 4 (D-2187 add.13, add.21): a `cliproxy/` id is a proxy id, so its vendor is the closed family
// table's reading of the bare id, never pi's own vendor and never a provider-prefix guess.
test("pi's vendor seam reads a proxied cliproxy id through the family table and refuses an unclassified one while every other pi model keeps its base reading", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers.pi = {
    vendor: "zhipu",
    channel: "sub",
    models: {
      "cliproxy/gemini-2.5-pro": "frontier",
      "cliproxy/gpt-5.5": "frontier",
      "cliproxy/codex-mini-latest": "mid",
      "cliproxy/grok-4": "frontier",
      "cliproxy/claude-opus-5-5": "frontier",
      // every unclassified cell of the contract's closed family table: refused, never pi's own vendor
      "cliproxy/claude": "frontier",
      "cliproxy/opus": "frontier",
      "cliproxy/o3": "frontier",
      "cliproxy/xclaude-1": "frontier",
      "cliproxy/openai/gpt-5.5": "frontier",
      "zai/glm-5.2": "mid",
      "private/model": "cheap",
    },
  };
  expect(Object.fromEntries(pi.channels!(cfg).map((channel) => [channel.model, channel.vendor]))).toEqual({
    "cliproxy/gemini-2.5-pro": "google",
    "cliproxy/gpt-5.5": "openai",
    "cliproxy/codex-mini-latest": "openai",
    "cliproxy/grok-4": "xai",
    "cliproxy/claude-opus-5-5": "anthropic",
    "zai/glm-5.2": "zhipu",
    "private/model": "zhipu",
  });
  expect(piModelVendor("cliproxy/GEMINI-2.5-pro")).toBe("google");
  for (const unclassified of ["cliproxy/claude", "cliproxy/opus", "cliproxy/o3", "cliproxy/xclaude-1", "cliproxy/openai/gpt-5.5", "cliproxy/"]) expect(piModelVendor(unclassified)).toBeUndefined();
  expect(piModelVendor("openai-codex/gpt-5.5")).toBe("openai");
});
