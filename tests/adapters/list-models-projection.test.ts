import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CliEntrySchema, MODEL_ID_FIELDS } from "../../src/adapters/catalog.js";
import { parseDeclaredModels } from "../../src/adapters/registry.js";
import { MODEL_ID_RE } from "../../src/adapters/types.js";

// The control is a VERBATIM capture of `omp models ls --json` (omp/17.2.9, 2026-08-06) committed at
// fixtures/gateway-models.json — fixtures ship, and no CLI is spawned here: the whole projection is
// pure over this file's bytes, so the suite stays zero-token and green on a machine with no gateway.
const CAPTURE = readFileSync(join(process.cwd(), "fixtures", "gateway-models.json"), "utf8");
const ENTRIES = JSON.parse(CAPTURE).models as Record<string, unknown>[];

describe("gateway --json projection (omp 17.2.9 capture, 2026-08-06)", () => {
  test("the committed gateway capture projects to a non-empty list of model ids, including a slash-bearing id the existing id-format filter already admits", () => {
    const { models, reason } = parseDeclaredModels(CAPTURE, "json", "models", "selector");
    expect(reason).toBeUndefined();
    expect(models.length).toBeGreaterThan(0);
    const slashed = models.filter((id) => id.includes("/"));
    expect(slashed.length).toBeGreaterThan(0);
    expect(slashed.every((id) => MODEL_ID_RE.test(id))).toBe(true);
    expect(models).toContain("anthropic/claude-3-5-sonnet-20240620");
  });

  test("every projected element equals an id string drawn from one of the capture's entries, and the count matches the capture's distinct ids", () => {
    const { models } = parseDeclaredModels(CAPTURE, "json", "models", "selector");
    const ids = new Set(ENTRIES.map((entry) => entry.selector as string));
    for (const model of models) {
      expect(typeof model).toBe("string");
      expect(ids.has(model)).toBe(true);
    }
    expect(models.length).toBe(ids.size);
  });

  test("malformed JSON, a wrong path, a wrong field and a regex-rejected value each report their own reason rather than one indistinguishable empty list, proven member by member over the closed set of four causes", () => {
    const causes = [
      { cause: "malformed JSON", got: parseDeclaredModels(CAPTURE.slice(0, 400), "json", "models", "selector"), names: /malformed json/i },
      { cause: "a wrong path", got: parseDeclaredModels(CAPTURE, "json", "modles", "selector"), names: /path "modles"/ },
      // "model" is an allowlisted id key that this gateway simply does not use — a wrong field the
      // schema can actually produce, unlike a typo, which the allowlist now rejects outright.
      { cause: "a wrong field", got: parseDeclaredModels(CAPTURE, "json", "models", "model"), names: /field "model"/ },
      { cause: "a regex-rejected value", got: parseDeclaredModels(JSON.stringify({ models: [{ selector: "$(rm -rf /)" }, { selector: "gpt 5; whoami" }] }), "json", "models", "selector"), names: /rejected by the model-id format/ },
    ];
    expect(causes.length).toBe(4);
    for (const { cause, got, names } of causes) {
      expect(got.models, cause).toEqual([]);
      expect(got.reason, cause).toBeDefined();
      expect(got.reason, cause).toMatch(names);
    }
    // Closed set: four causes, four reasons nobody can confuse for another.
    expect(new Set(causes.map(({ got }) => got.reason)).size).toBe(4);
  });

  test("the field selector is the id key only — a schema-accepted contract and a projection that reads no price or vendor field", () => {
    // v1.89 T1: every drive contract declares its trust posture; this fixture spawns no CLI.
    const drive = { headless: "omp run {promptFile} --model {model}", interactive: null, trustDialog: { kind: "none" as const, reason: "projection fixture — no CLI is launched, so no pane exists to capture" }, listModels: { argv: ["models", "ls", "--json"], parser: "json" as const, path: "models", field: "selector" } };
    expect(CliEntrySchema.parse({ id: "omp", binary: "omp", identity: ".+", vendor: "openai", drive }).drive).toEqual(drive);
    // A selector the parser would ignore is refused rather than silently dropped.
    expect(() => CliEntrySchema.parse({ id: "omp", binary: "omp", identity: ".+", vendor: "openai", drive: { ...drive, listModels: { ...drive.listModels, parser: "lines" as const } } })).toThrow(/field/);
    // Price and vendor are not id keys: no configuration can name them, so neither can reach the
    // parser. Every non-id key of the capture is refused, not just the two this milestone ruled out.
    const idKeys = new Set<string>(MODEL_ID_FIELDS);
    const nonIdKeys = [...new Set(ENTRIES.flatMap((entry) => Object.keys(entry)))].filter((key) => !idKeys.has(key));
    expect(nonIdKeys).toContain("provider");
    expect(nonIdKeys).toContain("cost");
    for (const key of nonIdKeys) {
      expect(() => CliEntrySchema.parse({ id: "omp", binary: "omp", identity: ".+", vendor: "openai", drive: { ...drive, listModels: { ...drive.listModels, field: key } } }), key).toThrow(/field/);
    }
    const { models } = parseDeclaredModels(CAPTURE, "json", "models", "selector");
    const priceAndVendor = new Set(ENTRIES.flatMap((entry) => [entry.provider as string, JSON.stringify(entry.cost)]));
    expect(models.some((model) => priceAndVendor.has(model))).toBe(false);
  });
});
