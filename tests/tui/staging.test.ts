import { describe, expect, test } from "vitest";
import { FleetStaging } from "../../src/tui/staging.js";
import type { FleetEditable } from "../../src/config/config.js";

function sampleEditable(): FleetEditable {
  return {
    denyAdapters: ["pi"],
    denyModels: ["pi:zai/glm-5.2"],
    tiers: {
      codex: {
        "gpt-5.6-sol": { tier: "frontier" },
        "gpt-5.6-terra": { tier: "mid" },
      },
    },
    map: {
      implement: { prefer: ["cursor-agent", "codex"] },
      migration: { pin: { via: "claude-code", model: "fable" } },
    },
    floors: {
      implement: "mid",
      migration: "frontier",
    },
  };
}

describe("FleetStaging", () => {
  test("an edit mutates the staging buffer while the loaded state and disk stay unchanged", () => {
    const loaded = sampleEditable();
    const staging = new FleetStaging(loaded);
    const loadedBefore = staging.loadedState;

    staging.apply((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });

    expect(staging.current.denyAdapters).toContain("grok");
    expect(staging.loadedState).toEqual(loadedBefore);
    // The staging module imports no fs functions and exposes no write path,
    // so the loaded state staying identical is the only disk-side invariant
    // the test surface can observe directly.
  });

  test("the staging model computes its delta against loaded state through the existing fleet editable comparison", () => {
    const loaded = sampleEditable();
    const staging = new FleetStaging(loaded);

    expect(staging.isDirty).toBe(false);
    expect(staging.changeCount).toBe(0);

    staging.apply((buffer) => {
      buffer.denyAdapters.push("grok");
      buffer.denyAdapters.sort();
    });
    expect(staging.isDirty).toBe(true);
    expect(staging.changeCount).toBe(1);

    staging.apply((buffer) => {
      buffer.floors.implement = "frontier";
    });
    expect(staging.changeCount).toBe(2);

    staging.apply((buffer) => {
      buffer.map.tests = { prefer: ["opencode"] };
    });
    expect(staging.changeCount).toBe(3);

    staging.revert();
    expect(staging.isDirty).toBe(false);
    expect(staging.changeCount).toBe(0);
    expect(staging.current).toEqual(loaded);
  });
});
