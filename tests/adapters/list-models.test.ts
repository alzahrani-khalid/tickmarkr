import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codex, readCodexModelsCache } from "../../src/adapters/codex.js";
import { parseCursorModels } from "../../src/adapters/cursor-agent.js";
import { parseOpencodeModels } from "../../src/adapters/opencode.js";
import { parsePiModels } from "../../src/adapters/pi.js";

// Fixtures are verbatim (trimmed) live output captured 2026-07-10 — see 08-RESEARCH.md
// "Fixture strings for parser tests". A poisoned row (ANSI/shell metachars) is added to each
// to prove the MODEL_ID_RE charset gate drops it (research Pitfall 4). No real CLI is spawned:
// every parser is pure over these strings, keeping the suite zero-token.

describe("parsePiModels (pi 0.80.3, verified 2026-07-10)", () => {
  const fixture = [
    "provider  model                               context  max-out  thinking  images",
    "google    gemini-3.5-flash                    1.0M     65.5K    yes       yes",
    "zai       glm-5.2                             1M       131.1K   yes       no",
  ].join("\n");

  test("skips header, joins provider/model", () => {
    expect(parsePiModels(fixture)).toEqual(["google/gemini-3.5-flash", "zai/glm-5.2"]);
  });

  test("drops a poisoned row (charset gate)", () => {
    const poisoned = `${fixture}\nevil      $(rm -rf /)\x1b[31m                 1M    1K   no   no`;
    const out = parsePiModels(poisoned);
    expect(out).toEqual(["google/gemini-3.5-flash", "zai/glm-5.2"]);
    expect(out.some((id) => id.includes("rm -rf"))).toBe(false);
  });

  test("empty / garbage input returns [] (never throws)", () => {
    expect(parsePiModels("")).toEqual([]);
    expect(parsePiModels("only a header line and nothing else")).toEqual([]);
  });

  test("WR-02: leading update banner does not inject a bogus id (header anchored by content)", () => {
    const banner = "A new version of pi is available: 0.81.0 — run `pi upgrade`";
    const out = parsePiModels(`${banner}\n${fixture}`);
    expect(out).toEqual(["google/gemini-3.5-flash", "zai/glm-5.2"]);
    // the real header row must NOT be parsed as a model
    expect(out.some((id) => id.includes("provider"))).toBe(false);
  });

  test("WR-02: no header row → fail-open []", () => {
    expect(parsePiModels("banner one\nbanner two")).toEqual([]);
  });
});

describe("parseOpencodeModels (opencode 1.17.15, verified 2026-07-10)", () => {
  const fixture = "opencode/big-pickle\nzai-coding-plan/glm-5.2";

  test("lines are ids verbatim; blanks dropped", () => {
    expect(parseOpencodeModels(`${fixture}\n\n`)).toEqual(["opencode/big-pickle", "zai-coding-plan/glm-5.2"]);
  });

  test("drops a poisoned line (charset gate)", () => {
    const out = parseOpencodeModels(`${fixture}\nprovider/mo del; rm -rf ~`);
    expect(out).toEqual(["opencode/big-pickle", "zai-coding-plan/glm-5.2"]);
  });

  test("empty input returns []", () => {
    expect(parseOpencodeModels("")).toEqual([]);
  });
});

describe("parseCursorModels (cursor-agent 2026.07.08, verified 2026-07-10)", () => {
  const fixture = [
    "Available models",
    "",
    "auto - Auto (default)",
    "composer-2.5 - Composer 2.5 (current)",
    "gpt-5.3-codex - Codex 5.3",
  ].join("\n");

  test("skips header + blank, takes token before ' - ', keeps auto", () => {
    expect(parseCursorModels(fixture)).toEqual(["auto", "composer-2.5", "gpt-5.3-codex"]);
  });

  test("drops a poisoned id (charset gate)", () => {
    const out = parseCursorModels(`${fixture}\nbad;id\x1b[0m - Poisoned`);
    expect(out).toEqual(["auto", "composer-2.5", "gpt-5.3-codex"]);
  });

  test("empty input returns []", () => {
    expect(parseCursorModels("")).toEqual([]);
  });
});

describe("readCodexModelsCache (codex-cli 0.143.0 cache, verified 2026-07-10)", () => {
  const cache = {
    fetched_at: "2026-07-09T22:18:13Z",
    etag: "abc",
    client_version: "0.144.0",
    models: [
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
      { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" },
      { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide" },
      { slug: "poison;rm -rf\x1b[31m", display_name: "Poison", visibility: "list" },
    ],
  };

  function writeCache(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-codexcache-"));
    const p = join(dir, "models_cache.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  test("returns only visibility:list slugs + fetchedAt; drops hidden + poisoned", () => {
    const r = readCodexModelsCache(writeCache(cache));
    expect(r.models).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(r.fetchedAt).toBe("2026-07-09T22:18:13Z");
  });

  test("missing path returns { models: [] }", () => {
    expect(readCodexModelsCache(join(tmpdir(), "does-not-exist-tickmarkr", "models_cache.json"))).toEqual({ models: [] });
  });

  test("corrupt JSON returns { models: [] }", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-codexcache-"));
    const p = join(dir, "models_cache.json");
    writeFileSync(p, "{ not valid json");
    expect(readCodexModelsCache(p)).toEqual({ models: [] });
  });

  test("IN-01: list-visible entry with no slug is dropped (no literal 'undefined' id)", () => {
    const p = writeCache({ models: [{ visibility: "list" }, { slug: "gpt-5.5", visibility: "list" }] });
    expect(readCodexModelsCache(p).models).toEqual(["gpt-5.5"]);
  });

  test("WR-01/MODEL-05: adapter surfaces the cache's own fetched_at (via CODEX_HOME) for honest staleness", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-codexhome-"));
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify(cache));
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      expect(codex.listModelsFetchedAt?.()).toBe("2026-07-09T22:18:13Z");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});
