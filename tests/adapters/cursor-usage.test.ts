import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cursorAgent } from "../../src/adapters/cursor-agent.js";

// SPEND-08: zero-token pin — cursor-agent has NO collectUsage; absence is BY DESIGN.
// Daemon fold `adapter.collectUsage?.(wt, attemptStart)` ⇒ undefined ⇒ honestly unmetered rows
// (wired by tests/run/telemetry.test.ts). This suite pins the cursor-side absence + documented reason.

const ADAPTER_SRC = readFileSync(join(import.meta.dirname, "../../src/adapters/cursor-agent.ts"), "utf8");

describe("cursorAgent.collectUsage — SPEND-08 absent-by-design", () => {
  test("collectUsage is undefined — cursor channels report honestly unmetered, never fabricated numbers", () => {
    expect(cursorAgent.collectUsage).toBeUndefined();
  });

  test("documented won't-implement reason lives in adapter source (deletion reddens)", () => {
    expect(ADAPTER_SRC).toMatch(/SPEND-08/);
    expect(ADAPTER_SRC).toMatch(/won.t-implement|wont-implement|WON'T-IMPLEMENT/i);
    expect(ADAPTER_SRC).toMatch(/protobuf/);
  });

  test("no metering code path in non-comment source — stdout tee / pane scrape / guessed parser reddens", () => {
    const codeLines = ADAPTER_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l));
    const code = codeLines.join("\n");
    expect(code).not.toMatch(/collectUsage/);
    expect(code).not.toMatch(/result\.usage/);
    expect(code).not.toMatch(/--trust.*--print.*usage/);
  });
});
