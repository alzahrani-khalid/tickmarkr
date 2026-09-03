import { describe, expect, test } from "vitest";
import { allAdapters } from "../../src/adapters/registry.js";
import {
  ADAPTER_PROMPT_GLYPHS,
  declaredPromptGlyphForAdapter,
} from "../../src/adapters/types.js";

describe("adapter prompt declarations", () => {
  test("every shipped adapter id has a non-empty prompt glyph declaration", () => {
    const adapters = allAdapters({ operatorPath: false });
    expect(adapters.length).toBeGreaterThanOrEqual(10);
    for (const adapter of adapters) {
      expect(declaredPromptGlyphForAdapter(adapter.id), adapter.id).toMatch(/^.$/u);
    }
    expect(ADAPTER_PROMPT_GLYPHS.codex).toBe("›");
    expect(ADAPTER_PROMPT_GLYPHS["claude-code"]).toBe("❯");
  });
});
