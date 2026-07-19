import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { grok } from "../../src/adapters/grok.js";

// GROK-03: zero-token pin — grok has NO collectUsage; absence is BY DESIGN (documented won't-implement).
// Daemon fold `adapter.collectUsage?.(wt, attemptStart)` ⇒ undefined ⇒ honestly unmetered rows
// (rendered by report.ts's "unmetered (adapter reports no usage)" line). This suite pins the
// grok-side absence + the survival of the five-way diagnosis (esp. the secret-spill rationale that
// is the one thing standing between a future maintainer and credential-spilling metering) + the
// absence of any metering code path in non-comment source.

const ADAPTER_SRC = readFileSync(join(import.meta.dirname, "../../src/adapters/grok.ts"), "utf8");

describe("grok.collectUsage — GROK-03 absent-by-design", () => {
  test("collectUsage is undefined — grok channels report honestly unmetered, never fabricated numbers", () => {
    expect(grok.collectUsage).toBeUndefined();
  });

  test("documented GROK-03 won't-implement reason survives in adapter source (deletion reddens)", () => {
    expect(ADAPTER_SRC).toMatch(/GROK-03/);
    expect(ADAPTER_SRC).toMatch(/won.t-implement|wont-implement|WON'T-IMPLEMENT/i);
    // the missed-but-real source and why it is inadmissible:
    expect(ADAPTER_SRC).toMatch(/debug-file/);
    expect(ADAPTER_SRC).toMatch(/JWT/);
    // the decisive secret-spill reason — must survive verbatim (credential-spilling metering guard):
    expect(ADAPTER_SRC).toMatch(/SUPABASE_ACCESS_TOKEN/);
  });

  test("no metering code path in non-comment source — a smuggled trace parser reddens", () => {
    const codeLines = ADAPTER_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l));
    const code = codeLines.join("\n");
    expect(code).not.toMatch(/collectUsage/);
    expect(code).not.toMatch(/--debug-file/);
    expect(code).not.toMatch(/input_tokens/);
  });
});
