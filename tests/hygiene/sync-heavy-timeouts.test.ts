import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SYNC_HEAVY_TESTS } from "../../vitest.config.js";

/**
 * The sync-heavy project carries a 1,200 s testTimeout by ruling (d54d1231, 2026-08-11): its
 * members starve their own RPC under the parallel suite's load. An inline per-test timeout
 * (`}, 240_000)` or `{ timeout: … }`) silently overrides that ceiling — the 2.5.0 export proof
 * went red exactly this way (docs-truth-testing's 240 s override, written six days BEFORE the
 * ruling, fired under the 2.5.0-heavier suite while the file ran in 27 s at calm). The project
 * owns the ceiling; a member never overrides it.
 */

const ROOT = join(__dirname, "..", "..");

// ponytail: two syntactic forms cover every inline timeout vitest accepts on test()/it().
const TRAILING_TIMEOUT = /\}\s*,\s*[0-9][0-9_]*\s*\)\s*;?\s*$/m;
const OPTIONS_TIMEOUT = /\btimeout\s*:\s*[0-9][0-9_]*/;

function inlineTimeouts(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => TRAILING_TIMEOUT.test(line) || OPTIONS_TIMEOUT.test(line))
    .map((line) => line.trim());
}

describe("sync-heavy members defer to the project's timeout ceiling", () => {
  test("SYNC_HEAVY_TESTS is non-empty and every member exists", () => {
    expect(SYNC_HEAVY_TESTS.length).toBeGreaterThan(0);
    for (const member of SYNC_HEAVY_TESTS) expect(() => readFileSync(join(ROOT, member), "utf8")).not.toThrow();
  });

  test.each(SYNC_HEAVY_TESTS)("%s carries no inline per-test timeout", (member) => {
    const hits = inlineTimeouts(readFileSync(join(ROOT, member), "utf8"));
    expect(hits, `inline timeout(s) override the sync-heavy project ceiling:\n${hits.join("\n")}`).toEqual([]);
  });

  test("red-capable: a trailing numeric timeout and an options timeout are both flagged", () => {
    const trailing = "  }, 240_000);";
    const options = "  test(\"x\", { timeout: 5000 }, () => {});";
    expect(inlineTimeouts(`${trailing}\n${options}\n  });\n`)).toEqual([trailing.trim(), options.trim()]);
    expect(inlineTimeouts("  });\n  test(\"y\", () => {});\n")).toEqual([]);
  });
});
