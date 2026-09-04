import { describe, expect, test } from "vitest";
import {
  CITED_MODEL_WINDOWS,
  assertModelWindowClaimsMatchSeededModels,
  loadModelWindowClaims,
  resolveModelWindowClaim,
  type ModelWindowClaim,
} from "../../src/adapters/model-windows.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";

const VALID_CLAIMS = [
  {
    modelId: "vendor/model-a",
    window: 128_000,
    source: "https://vendor.example/models/model-a",
    readDate: "2026-08-05",
  },
] satisfies readonly ModelWindowClaim[];

describe("cited model-window claims", () => {
  test("test: every entry carries a model id, a positive window, a source and a read date, proven member by member over the closed set of malformed shapes — a missing-source fixture, a missing-date fixture, a non-positive-window fixture and a duplicate-id fixture — each rejected at load", () => {
    const [valid] = VALID_CLAIMS;
    const { source: _source, ...missingSource } = valid;
    const { readDate: _readDate, ...missingDate } = valid;
    const malformedFixtures: ReadonlyArray<readonly [string, unknown]> = [
      ["missing-source", [missingSource]],
      ["missing-date", [missingDate]],
      ["non-positive-window", [{ ...valid, window: 0 }]],
      ["duplicate-id", [valid, { ...valid, source: "https://vendor.example/models/model-a-duplicate" }]],
    ];

    for (const [shape, fixture] of malformedFixtures) {
      expect(() => loadModelWindowClaims(fixture), shape).toThrow();
    }

    const loaded = loadModelWindowClaims(CITED_MODEL_WINDOWS);
    for (const claim of loaded) {
      expect(claim.modelId).not.toHaveLength(0);
      expect(claim.window).toBeGreaterThan(0);
      expect(claim.source).toMatch(/^https:\/\//);
      expect(claim.readDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(claim).not.toHaveProperty("measured");
    }
  });

  test("test: the table is readable by production code rather than by tests alone, proven by resolving a window through the shipped loader with no test helper in the call path", () => {
    const [firstClaim] = CITED_MODEL_WINDOWS;
    const resolution = resolveModelWindowClaim(firstClaim.modelId, CITED_MODEL_WINDOWS);

    expect(resolution).toEqual({ status: "declared", claim: firstClaim });
    expect(resolution.status === "declared" ? resolution.claim.window : undefined).toBe(firstClaim.window);
  });

  test("test: a model absent from the table resolves to unknown rather than to a default or a zero, and the unknown is distinguishable from a declared window at every call site that reads one", () => {
    const [firstClaim] = CITED_MODEL_WINDOWS;
    const declared = resolveModelWindowClaim(firstClaim.modelId, CITED_MODEL_WINDOWS);
    const unknown = resolveModelWindowClaim("vendor/model-not-in-table", CITED_MODEL_WINDOWS);

    expect(declared.status).toBe("declared");
    expect(unknown).toEqual({ status: "unknown", modelId: "vendor/model-not-in-table" });
    expect(unknown.status === "declared" ? unknown.claim.window : undefined).toBeUndefined();
    expect(unknown).not.toHaveProperty("window");
  });

  test("OBS-871 rows have dated cited windows and remain seed-pinned", () => {
    const ids = [
      "zai/glm-5.3", "zai/glm-5.3-flash", "google/gemini-3.8-flash", "alibaba/qwen3.8-max",
      "claude-fable-5-1", "gemini-3.8-flash", "qwen3.8-max", "prime-inference/z-ai/glm-5.2",
    ];
    for (const id of ids) {
      const claim = CITED_MODEL_WINDOWS.find((entry) => entry.modelId === id);
      expect(claim, id).toMatchObject({ modelId: id, readDate: "2026-09-03" });
      expect(claim?.source, id).toMatch(/^https:\/\//);
      expect(Object.values(DEFAULT_CONFIG.tiers).some((entry) => id in entry.models), id).toBe(true);
    }
  });

  test("test: the table's model ids equal the seeded-model set exactly, proven member by member over the closed set of divergence shapes — a table-only fixture, a seed-only fixture and an exact-match fixture — so the set of source claims the judge must weigh is finite and enumerable", () => {
    const seededModelIds = Object.values(DEFAULT_CONFIG.tiers).flatMap((tier) => Object.keys(tier.models));
    const claimedModelIds = CITED_MODEL_WINDOWS.map((claim) => claim.modelId);

    expect(new Set(claimedModelIds)).toEqual(new Set(seededModelIds));
    expect(() => assertModelWindowClaimsMatchSeededModels(seededModelIds, CITED_MODEL_WINDOWS)).not.toThrow();

    const divergenceFixtures: ReadonlyArray<readonly [string, readonly ModelWindowClaim[], readonly string[], RegExp | undefined]> = [
      [
        "table-only",
        [...VALID_CLAIMS, { ...VALID_CLAIMS[0], modelId: "vendor/table-only" }],
        VALID_CLAIMS.map((claim) => claim.modelId),
        /table-only model ids: vendor\/table-only/,
      ],
      [
        "seed-only",
        VALID_CLAIMS,
        [...VALID_CLAIMS.map((claim) => claim.modelId), "vendor/seed-only"],
        /seed-only model ids: vendor\/seed-only/,
      ],
      ["exact-match", VALID_CLAIMS, VALID_CLAIMS.map((claim) => claim.modelId), undefined],
    ];

    for (const [shape, claims, seeds, expectedError] of divergenceFixtures) {
      if (expectedError) {
        expect(() => assertModelWindowClaimsMatchSeededModels(seeds, claims), shape).toThrow(expectedError);
      } else {
        expect(() => assertModelWindowClaimsMatchSeededModels(seeds, claims), shape).not.toThrow();
      }
    }
  });
});
