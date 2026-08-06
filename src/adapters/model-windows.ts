import { z } from "zod";

const ModelWindowClaimSchema = z
  .object({
    modelId: z.string().min(1),
    window: z.number().int().positive(),
    source: z.string().url(),
    readDate: z.iso.date(),
  })
  .strict();

export type ModelWindowClaim = Readonly<z.infer<typeof ModelWindowClaimSchema>>;

export type ModelWindowResolution =
  | { status: "declared"; claim: ModelWindowClaim }
  | { status: "unknown"; modelId: string };

/**
 * Validate cited model-window claims before production code can consume them.
 * These values are vendor-published claims, not measurements made by tickmarkr.
 */
export function loadModelWindowClaims(input: unknown): readonly ModelWindowClaim[] {
  const claims = z.array(ModelWindowClaimSchema).parse(input);
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.modelId)) throw new Error(`duplicate model id ${claim.modelId}`);
    seen.add(claim.modelId);
  }
  return Object.freeze(claims.map((claim) => Object.freeze(claim)));
}

const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/models/overview";
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/models";
const OPENAI_GPT_55_SOURCE = "https://developers.openai.com/api/docs/models/gpt-5.5";
const CURSOR_SOURCE = "https://cursor.com/help/ai-features/max-mode";
const ZAI_SOURCE = "https://z.ai/blog/glm-5.2";
const XAI_SOURCE = "https://docs.x.ai/developers/models/grok-4.5";
const KIMI_SOURCE = "https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html";
const READ_DATE = "2026-08-05";

const VENDORED_MODEL_WINDOW_CLAIMS = [
  { modelId: "fable", window: 1_000_000, source: ANTHROPIC_SOURCE, readDate: READ_DATE },
  { modelId: "opus", window: 1_000_000, source: ANTHROPIC_SOURCE, readDate: READ_DATE },
  { modelId: "sonnet", window: 1_000_000, source: ANTHROPIC_SOURCE, readDate: READ_DATE },
  { modelId: "haiku", window: 200_000, source: ANTHROPIC_SOURCE, readDate: READ_DATE },
  { modelId: "gpt-5.6-sol", window: 1_050_000, source: OPENAI_SOURCE, readDate: READ_DATE },
  { modelId: "gpt-5.5", window: 1_050_000, source: OPENAI_GPT_55_SOURCE, readDate: READ_DATE },
  { modelId: "gpt-5.6-terra", window: 1_050_000, source: OPENAI_SOURCE, readDate: READ_DATE },
  { modelId: "gpt-5.6-luna", window: 1_050_000, source: OPENAI_SOURCE, readDate: READ_DATE },
  { modelId: "composer-2.5", window: 200_000, source: CURSOR_SOURCE, readDate: READ_DATE },
  { modelId: "composer-2.5-fast", window: 200_000, source: CURSOR_SOURCE, readDate: READ_DATE },
  { modelId: "zai-coding-plan/glm-5.2", window: 1_000_000, source: ZAI_SOURCE, readDate: READ_DATE },
  { modelId: "zai/glm-5.2", window: 1_000_000, source: ZAI_SOURCE, readDate: READ_DATE },
  { modelId: "grok-4.5", window: 500_000, source: XAI_SOURCE, readDate: READ_DATE },
  { modelId: "grok-composer-2.5-fast", window: 200_000, source: CURSOR_SOURCE, readDate: READ_DATE },
  { modelId: "kimi-code/k3", window: 1_048_576, source: KIMI_SOURCE, readDate: READ_DATE },
  { modelId: "kimi-code/kimi-for-coding", window: 262_144, source: KIMI_SOURCE, readDate: READ_DATE },
  { modelId: "kimi-code/kimi-for-coding-highspeed", window: 262_144, source: KIMI_SOURCE, readDate: READ_DATE },
] as const;

/** The closed, production-readable catalog of cited context-window claims. */
export const CITED_MODEL_WINDOWS = loadModelWindowClaims(VENDORED_MODEL_WINDOW_CLAIMS);

export function resolveModelWindowClaim(
  modelId: string,
  input: unknown = CITED_MODEL_WINDOWS,
): ModelWindowResolution {
  const claim = loadModelWindowClaims(input).find((entry) => entry.modelId === modelId);
  return claim === undefined ? { status: "unknown", modelId } : { status: "declared", claim };
}

/** Fail when either side contains a model id absent from the other side. */
export function assertModelWindowClaimsMatchSeededModels(
  seededModelIds: readonly string[],
  input: unknown = CITED_MODEL_WINDOWS,
): void {
  const tableIds = new Set(loadModelWindowClaims(input).map((claim) => claim.modelId));
  const seedIds = new Set(seededModelIds);
  const tableOnly = [...tableIds].filter((id) => !seedIds.has(id)).sort();
  const seedOnly = [...seedIds].filter((id) => !tableIds.has(id)).sort();
  const differences = [
    tableOnly.length ? `table-only model ids: ${tableOnly.join(", ")}` : "",
    seedOnly.length ? `seed-only model ids: ${seedOnly.join(", ")}` : "",
  ].filter(Boolean);
  if (differences.length) throw new Error(differences.join("; "));
}
