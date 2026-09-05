import { describe, expect, test } from "vitest";
import {
  declaredInputBoxForWorkerName,
  declaredPromptGlyphForWorkerName,
} from "../../src/adapters/types.js";
import { CLAUDE_INPUT_BOX } from "../../src/adapters/claude-code.js";
import { CODEX_INPUT_BOX } from "../../src/adapters/codex.js";
import { KIMI_INPUT_BOX } from "../../src/adapters/kimi.js";

describe("worker prompt glyph lookup", () => {
  test("derives codex and claude glyphs from the adapter segment of a worker name", () => {
    expect(declaredPromptGlyphForWorkerName("T7-worker-codex-a0-run")).toBe("›");
    expect(declaredPromptGlyphForWorkerName("T7-worker-claude-code-a1-run")).toBe("❯");
    expect(declaredPromptGlyphForWorkerName("not-a-worker")).toBeUndefined();
  });

  test("input-box declarations carry the prompt glyph beside their state matchers", () => {
    expect(CLAUDE_INPUT_BOX.promptGlyph).toBe("❯");
    expect(CODEX_INPUT_BOX.promptGlyph).toBe("›");
    expect(KIMI_INPUT_BOX.promptGlyph).toBe(">");
    expect(declaredInputBoxForWorkerName("T7-worker-kimi-a0-run")?.promptGlyph).toBe(">");
  });
});
