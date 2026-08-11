import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filesGlob } from "../graph/files-glob.js";
import { Document, parse } from "yaml";
import { z } from "zod";
import { CITED_MODEL_WINDOWS } from "../adapters/model-windows.js";
import { stateDirName } from "../graph/graph.js";
import { SHAPES, TIERS } from "../graph/schema.js";

const TierEnum = z.enum(TIERS, {
  error: (iss) => `Invalid option: expected one of "cheap"|"mid"|"frontier" (got ${JSON.stringify(iss.input)})`,
});
export type Tier = z.infer<typeof TierEnum>;
export const TIER_RANK: Record<Tier, number> = { cheap: 0, mid: 1, frontier: 2 };
export const DEFAULT_DIFF_CAP = 60_000;
// This is deliberately only a rejection guard. T20's cited table, not this floor, supplies each claim.
export const MODEL_WINDOW_PLAUSIBILITY_FLOOR = 1_024;

// v1.51 T1: routing.mode — a preset COMPILED INTO FLOORS at config load. The router never sees the
// mode; it receives resolved floors only (the structural defense against the quality-silently-loses
// class — no fourth runtime authority, no new precedence key).
export const ROUTING_MODES = ["partner-led", "risk-based", "staff-led"] as const;
const ModeEnum = z.enum(ROUTING_MODES, {
  error: (iss) => `Invalid option: expected one of "partner-led"|"risk-based"|"staff-led" (got ${JSON.stringify(iss.input)})`,
});
export type RoutingMode = z.infer<typeof ModeEnum>;
// Integrity set (weak-oracle shapes, OBS-68..70 class): no mode may resolve these below frontier.
// Only an explicit operator floor line can — and it draws a standing plan lint every load.
export const INTEGRITY_FLOOR_SHAPES = ["plan", "spec", "migration", "ui"] as const;

// v1.52 T5: tier is no longer a map-entry band authority — routing.floors is the only tier
// source left (v1.51 T3 deprecated this field with a promise to remove it here). Only the legacy
// `tier: null` tombstone still parses (and normalizes to absent); any real value fails config
// load fail-closed, naming routing.floors as the move target, so a band intent set here can never
// silently vanish. The field stays in the schema/type as an always-undefined marker (not deleted
// outright) so a map entry can never carry a real tier value again, structurally.
export const MapEntrySchema = z.object({
  pin: z.object({ via: z.string(), model: z.string() }).optional(),
  tier: z
    .null({
      error: (iss) =>
        `routing.map entry tier ${JSON.stringify(iss.input)} is no longer a band authority — move this value to routing.floors.<shape> (only "tier: null" tombstones still parse)`,
    })
    .optional()
    .transform(() => undefined)
    .optional(),
  prefer: z.array(z.string()).optional(),
  escalate: z.boolean().optional(),
});
export type MapEntry = z.infer<typeof MapEntrySchema>;

const DeclaredVendorSchema = z.string().trim().min(1, "vendor must be nonempty");
const ModelOverrideSchema = z
  .object({
    vendor: DeclaredVendorSchema.optional(),
    channel: z.enum(["sub", "api"]).optional(),
  })
  .refine((override) => override.vendor !== undefined || override.channel !== undefined, {
    message: "a model override must declare vendor, channel, or both",
  });

export const TierEntrySchema = z.object({
  vendor: DeclaredVendorSchema.nullable(),
  channel: z.enum(["sub", "api"]),
  models: z.record(z.string(), TierEnum),
  // T19: keep model values scalar for existing consumers. Optional sibling metadata resolves before
  // parent metadata in channelsFromConfig; neither provider prefixes nor adapter ids manufacture it.
  modelOverrides: z.record(z.string(), ModelOverrideSchema).optional(),
  // v1.47 T3: optional per-model context-window sizes (tokens). Absent block ⇒ no doctor column, no plan lint.
  windows: z.record(z.string(), z.number().int().positive()).optional(),
}).superRefine((entry, ctx) => {
  if (entry.vendor !== null) return;
  for (const model of Object.keys(entry.models)) {
    if (entry.modelOverrides?.[model]?.vendor) continue;
    ctx.addIssue({
      code: "custom",
      path: ["modelOverrides", model, "vendor"],
      message: "vendor: null requires every configured model to declare a nonempty vendor override",
    });
  }
});
export type TierEntry = z.infer<typeof TierEntrySchema>;

// v1.10 FLEET-06: optional routing.allow/deny fleet preference; absent blocks ⇒ byte-identical routing/discovery.
// deny wins on conflict; presence of allow (even {} / empty arrays) activates allowlist (fail-closed).
const PrefBlockSchema = z.object({
  adapters: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
});
const DenyBlockSchema = PrefBlockSchema.extend({
  workers: PrefBlockSchema.optional(),
});

// v1.20 REC-02: operator-maintained price table for the usage/cost report (src/report/cost.ts). Two
// channel economics, never conflated (spec cost model): API = tokens × per-Mtok rate; sub = flat plan
// amortized over a windows/month RANGE (+ an API-equivalent counterfactual when the model has a rate).
// ALL OPTIONAL: absent pricing ⇒ the estimator reports "not measurable" — never a crash or a fake $0.
// Rate source to copy from: LiteLLM's model_prices_and_context_window.json (github.com/BerriAI/litellm),
// the de-facto machine-readable price table ccusage/tokonomics both consume.
export const ModelPricingSchema = z.object({
  inPerMtok: z.number().nonnegative(),
  outPerMtok: z.number().nonnegative(),
  cacheReadPerMtok: z.number().nonnegative().optional(),
  rateDate: z.string().optional(), // ISO date the rate was verified; echoed in every estimate's basis
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const SubPricingSchema = z
  .object({
    planMonthly: z.number().positive(),
    windowsPerMonthLow: z.number().int().positive(),
    windowsPerMonthHigh: z.number().int().positive(),
  })
  .refine((s) => s.windowsPerMonthLow <= s.windowsPerMonthHigh, "windowsPerMonthLow must be ≤ windowsPerMonthHigh");
export type SubPricing = z.infer<typeof SubPricingSchema>;

// ── Review participation (R3 of OVERSEER-RULING-20260731-velocity; OBS-186) ────────────────────
// Participation is keyed on PATHS — what a task DECLARES at compile time and what its diff ACTUALLY
// touches at gate time — never on complexity. `complexityThreshold` capped participation at a number
// the authoring law forbade tasks from reaching, so cross-vendor review was unreachable by
// construction while `required: true` claimed the opposite. Paths cannot drift out from under the
// gate that way: the same predicate decides both ends.

export const REVIEW_POLICIES = ["full", "judge-only"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/**
 * The leaf class: work a judge alone can carry because there is no behaviour to review. It is CLOSED
 * and enumerated here — documentation pages, the changelog, the release runbook, and the version
 * mirrors a release bump rewrites. Everything else, including tests and scripts, is full-review work.
 */
export const REVIEW_LEAF_GLOBS = [
  "docs/**", "CHANGELOG.md", "RELEASING.md", "package.json", "package-lock.json",
] as const;

/**
 * Membership is a POSITIVE rule, not a blacklist. A blacklist of source extensions is a list of the
 * formats someone thought of, and everything nobody thought of — `docs/widget.vue`, `docs/site.svelte`,
 * `docs/Makefile`, `docs/package.json`, an extensionless script — falls into the leaf class and skips
 * its review. That direction of failure is the whole defect OBS-186 names, so the rule is inverted:
 * under `docs/` a path is leaf work only when its extension is a DOCUMENTATION format. An unknown
 * format is behaviour until proven otherwise, which is the fail-closed direction.
 */
const REVIEW_DOC_EXT_RE = /\.(?:md|mdx|markdown|txt|rst|adoc|asciidoc)$/i;

/**
 * The version mirrors a release bump rewrites — and ONLY at the repo root: `docs/package.json` is a
 * real manifest for something, not a mirror. Membership here is still a claim about paths, and a
 * manifest diff that moves more than the version field leaves the class; the gate re-tests that
 * against the actual diff content (src/gates/review.ts) because a path cannot say it by itself.
 */
export const REVIEW_VERSION_MIRRORS: ReadonlySet<string> = new Set(["package.json", "package-lock.json"]);

/** The changelog and the release runbook, at the repo root, by exact name. */
const REVIEW_LEAF_FILES: ReadonlySet<string> = new Set(["CHANGELOG.md", "RELEASING.md"]);

/**
 * Paths whose review may never be skipped (R3): the gate/run/driver/adapter surface — lifecycle,
 * demux, and everything that reaches a shell. Shipped as the default so the compile lint that
 * enforces them is live in a repo that never configures anything.
 */
export const DEFAULT_REVIEW_CRITICAL_PATHS = [
  "src/gates/**", "src/run/**", "src/drivers/**", "src/adapters/**",
] as const;

const GLOB_META_RE = /[*?[\]{}]/;
const normPath = (p: string) => p.replace(/^\.\//, "").trim();

/**
 * True when `path` — an ACTUAL path a diff touched — is provably leaf-class work. Enumerated, closed,
 * and positive: the two named root files, the two root version mirrors, and documentation formats
 * under `docs/`. Everything else, including a `.vue`/`.svelte`/`Makefile`/`package.json` parked under
 * `docs/`, is behaviour and draws a full review.
 */
export function isReviewLeafPath(path: string): boolean {
  const p = normPath(path);
  if (!p.length) return false;
  if (REVIEW_LEAF_FILES.has(p) || REVIEW_VERSION_MIRRORS.has(p)) return true;
  return p.startsWith("docs/") && REVIEW_DOC_EXT_RE.test(p);
}

/**
 * True when a DECLARED pattern may claim leaf work. A declaration is a claim about a directory, not
 * a file: `docs/**` is how a documentation task declares itself and has to stay claimable, so a glob
 * rooted at `docs/` reads leaf here while `docs/tool.ts` does not read leaf above. The claim is never
 * the last word — reviewGate re-tests it against what the diff actually touched and promotes when the
 * diff leaves the class. A glob rooted anywhere else can claim nothing.
 */
export function isReviewLeafDeclaration(pattern: string): boolean {
  const p = normPath(pattern);
  if (!p.length) return false;
  return isReviewLeafPath(p) || (GLOB_META_RE.test(p) && p.startsWith("docs/"));
}

/** full beats judge-only. The join is monotone by construction: nothing here can LOWER a policy. */
export function raiseReviewPolicy(...policies: ReadonlyArray<ReviewPolicy | undefined>): ReviewPolicy {
  return policies.includes("full") ? "full" : "judge-only";
}

/**
 * The compiler's assignment, from the task's DECLARED files[]. judge-only only when EVERY declared
 * path is provably leaf work — one non-leaf pattern (or an empty files[]) makes it full.
 */
export function declaredReviewPolicy(files: ReadonlyArray<string>): ReviewPolicy {
  const declared = files.map(normPath).filter((f) => f.length > 0);
  return declared.length > 0 && declared.every(isReviewLeafDeclaration) ? "judge-only" : "full";
}

/** The declared assignment after the operator's floor is applied — config may raise it, never lower it. */
export function effectiveReviewPolicy(
  files: ReadonlyArray<string>,
  review: { policy?: ReviewPolicy },
): ReviewPolicy {
  return raiseReviewPolicy(declaredReviewPolicy(files), review.policy);
}

/** The literal head of a pattern — everything before its first glob metacharacter. */
const literalPrefix = (p: string) => {
  const i = p.search(GLOB_META_RE);
  return i < 0 ? p : p.slice(0, i);
};
/** The literal tail of a pattern — everything after its last glob metacharacter. */
const literalSuffix = (p: string) => p.replace(/^.*[*?[\]{}]/s, "");
const eitherWay = (a: string, b: string, rel: (x: string, y: string) => boolean) => rel(a, b) || rel(b, a);

/**
 * Do two GLOBS have a path in common? Exact glob-vs-glob intersection is undecidable in general, so
 * this fails CLOSED: the pair is treated as intersecting unless their literal heads or their literal
 * tails prove they cannot meet. `docs/**\/README.md` vs `docs/security/*.md` share the head `docs/`
 * and the tail `.md` is a tail of `/README.md`, so `docs/security/README.md` is correctly flagged;
 * `src/**\/*.ts` vs `src/**\/*.md` share a head but neither tail contains the other, so they are not.
 */
const globsMayIntersect = (a: string, b: string) =>
  eitherWay(literalPrefix(a), literalPrefix(b), (x, y) => x.startsWith(y))
  && eitherWay(literalSuffix(a), literalSuffix(b), (x, y) => x.endsWith(y));

/**
 * Declared patterns that intersect a critical path. Directional containment is the certain half — a
 * critical `src/gates/**` contains a declared `src/gates/review.ts`, and a declared `docs/**` contains
 * a critical `docs/security/**`. It is NOT intersection: two globs can overlap without either matching
 * the other as a literal string, which is how a judge-only task declaring `docs/**\/README.md` slipped
 * past a critical `docs/security/*.md`. When BOTH sides are globs the conservative overlap test above
 * decides, and it decides toward flagging — an over-flagged task is narrowed by its author, an
 * under-flagged one skips the only gate that exists for it.
 */
export function criticalPathHits(
  files: ReadonlyArray<string>,
  criticalPaths: ReadonlyArray<string> = [],
): string[] {
  const hits = new Set<string>();
  for (const raw of files) {
    const f = normPath(raw);
    if (!f) continue;
    for (const rawCritical of criticalPaths) {
      const critical = normPath(rawCritical);
      if (!critical) continue;
      if (f === critical || filesGlob(critical)(f) || filesGlob(f)(critical) // Q120s shared matcher
          || (GLOB_META_RE.test(f) && GLOB_META_RE.test(critical) && globsMayIntersect(f, critical))) {
        hits.add(f);
      }
    }
  }
  return [...hits].sort();
}

// R3 (OBS-186): `review: false` here is a SECOND participation switch, and unlike review.policy it is
// not monotone — it can omit the review gate from a task the path rules assigned `full`. Participation
// is decided by paths, so the two are JOINED at the one seam that can still refuse the graph:
// reviewParticipationErrors (src/compile/collateral.ts) fails compile when a shape's `review: false`
// would demote a full-review task or silence a critical path. The key itself stays parseable (a run's
// own config, the setup cockpit and the shipped template all round-trip it); what it can no longer do
// is take effect behind the policy's back.
const ShapeGateParticipationSchema = z
  .object({ acceptance: z.boolean().optional(), review: z.boolean().optional() })
  .passthrough()
  .superRefine((entry, ctx) => {
    for (const gate of Object.keys(entry)) {
      if (gate === "acceptance" || gate === "review") continue;
      const invariant = gate === "build" || gate === "test" || gate === "lint" ? "baseline" : gate;
      const mandatory = invariant === "baseline" || invariant === "evidence" || invariant === "scope";
      ctx.addIssue({
        code: "custom",
        path: [gate],
        message: mandatory
          ? `${invariant} is a mandatory fail-closed gate invariant and cannot be configured per shape`
          : `gates.byShape may configure only acceptance and review (not ${gate})`,
      });
    }
  });

export const TickmarkrConfigSchema = z.object({
  concurrency: z.number().int().positive(),
  driver: z.enum(["auto", "herdr", "subprocess"]),
  integrationBranchPrefix: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be branch-safe (letters/digits/._/-, no spaces or shell metacharacters)")
    .refine((v) => !v.includes(".."), "may not contain '..'"),
  taskTimeoutMinutes: z.number().positive(),
  // v1.23 T2: warn the operator once per attempt when a live worker's context fill crosses this
  // token count (sampled at existing poll seams). Telemetry only — never blocks or kills a worker.
  // Default 170_000 matches the overseer's proven ctx-watch.sh threshold.
  contextWarnTokens: z.number().int().positive(),
  setup: z.string().optional(),
  routing: z.object({
    // v1.51 T1: preset expanded into floors by loadConfig — absent ⇒ risk-based ⇒ byte-identical routing.
    mode: ModeEnum.optional(),
    map: z.record(z.string(), MapEntrySchema),
    floors: z.record(z.string(), TierEnum),
    learned: z.enum(["on", "off"]), // v1.6 ROUTE-09 kill switch; a typo (offf) fails loud via safeParse
    // v1.9 ROUTE-15 — optional overrides for profile.ts HALF_LIFE_RUNS/AVAIL_WEIGHT; absent ⇒ byte-identical defaults.
    // SIBLING of learned (not nested): routing.learned is the on/off enum switch.
    learnedTuning: z.object({
      halfLifeRuns: z.number().positive().optional(),
      availWeight: z.number().nonnegative().optional(),
    }).optional(),
    // E3 (v1.45-T3): optional exploration fence — absent block ⇒ byte-identical to pre-v1.45 routing.
    explore: z.object({
      mode: z.enum(["on", "off"]).optional(),
      excludeShapes: z.array(z.string()).optional(),
      excludeComplexityAtOrAbove: z.number().int().min(1).max(10).nullable().optional(),
      cap: z.number().int().positive().optional(),
    }).optional(),
    // v1.47 T4: per-shape time SLA in minutes — advisory plan lint only; absent ⇒ byte-identical routing.
    sla: z.record(z.string(), z.number().positive()).optional(),
    // Pre-v1.21 doctor.json lacks per-model verdicts. Keep legacy unknown-is-routable behavior opt-in.
    allowUnverifiedModels: z.boolean(),
    allow: PrefBlockSchema.optional(),
    deny: DenyBlockSchema.optional(),
  }),
  tiers: z.record(z.string(), TierEntrySchema),
  pricing: z.record(z.string(), z.number()),
  // v1.20 REC-02: optional detailed price table for cost estimation. Distinct from `pricing` above
  // (the coarse per-task tier estimate `tickmarkr plan` shows) — this one drives the usage/cost report.
  // Absent ⇒ every channel reports "not measurable" (never $0). models keyed by model id (LiteLLM
  // convention); subs keyed by adapter id (subscription plans are per-account, not per-token).
  cost: z
    .object({
      models: z.record(z.string(), ModelPricingSchema).optional(),
      subs: z.record(z.string(), SubPricingSchema).optional(),
    })
    .optional(),
  gates: z.object({
    build: z.string(),
    test: z.string(),
    lint: z.string(),
    diffCap: z.number().int().positive(),
    byShape: z.partialRecord(z.enum(SHAPES), ShapeGateParticipationSchema).optional(),
  }).partial(),
  scope: z.object({
    // HARD-08: the ONLY authority that can excuse an out-of-scope edit. Globs, matched with the
    // same picomatch options as files[] ({ dot: true }). Default [] = no excuses (fail-closed).
    allowDeviations: z.array(z.string()),
  }).partial().optional(),
  judge: z.object({ adapter: z.string(), model: z.string() }),
  // v1.53 T2: prefer — ordered reviewer preference (entry grammar: adapter | adapter:model, same as
  // routing.map.prefer). Reorders diversity-eligible channels only; never widens or narrows eligibility.
  review: z.object({
    // RETIRED as a participation switch (R3 / OBS-186, v1.85): review participation is decided by the
    // paths a task declares and the paths its diff touches — never by complexity. The key survives
    // because routing hints and the setup cockpit still read it as a complexity landmark; NOTHING in
    // src/gates/review.ts reads it any more, and a value here can no longer disable a review.
    complexityThreshold: z.number(),
    required: z.boolean(),
    prefer: z.array(z.string()).optional(),
    // R3: the operator's participation floor. "full" forces a cross-vendor review on every task;
    // "judge-only" is the neutral floor (it leaves the compiler's per-task assignment standing).
    // Config may RAISE a task's policy and can never lower one — see raiseReviewPolicy.
    policy: z.enum(REVIEW_POLICIES).optional(),
    // R3: globs no task may skip review on (input/demux/lifecycle, gates/run/drivers/adapters, anything
    // reaching a shell). A judge-only task intersecting one of these fails COMPILE, never silently skips.
    criticalPaths: z.array(z.string()).optional(),
  }),
  // v1.54 T1: prefer — ranked consult seat failover. Entries MUST be adapter:model (unlike
  // review.prefer's adapter|adapter:model grammar): a consult seat has no channel to inherit a
  // model from, so a bare adapter is meaningless and fails config load fail-closed. The pinned
  // adapter/model pair below stays the final fallback seat; an absent list is byte-identical.
  consult: z.object({
    adapter: z.string(),
    model: z.string(),
    stallMinutes: z.number().positive(),
    prefer: z
      .array(z.string().regex(/^[^:]+:.+$/, "consult.prefer entries must be adapter:model — a bare adapter has no model to run the seat with"))
      .optional(),
  }),
  visibility: z.object({
    llm: z.enum(["pane", "headless"]),
    keepPanes: z.enum(["run", "attempt", "forever"]),
    worker: z.enum(["interactive", "print"]),
    // VIS-09 item 2 (43-CONTEXT D-03): cap concurrent worker panes per WORKERS tab; the cap+1'th member
    // overflows to a WORKERS-2 tab instead of further splitting tab 1 (bounded height, zero width risk).
    // Positive int: zero/negative reddens the schema. Overlays omitting it parse (deepMerge over the
    // default 3). Default 3: at a ~50-row terminal that's ~16 rows/pane (readable); the operator's
    // 5-pane incident was ~10 rows each.
    workersPerTab: z.number().int().positive(),
  }),
});
export type TickmarkrConfig = z.infer<typeof TickmarkrConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function assertSeededModelWindows(): void {
  const cited = new Map(CITED_MODEL_WINDOWS.map((claim) => [claim.modelId, claim.window]));
  for (const [adapter, entry] of Object.entries(DEFAULT_CONFIG.tiers)) {
    for (const [model, window] of Object.entries(entry.windows ?? {})) {
      const path = `tiers.${adapter}.windows.${model}`;
      if (window < MODEL_WINDOW_PLAUSIBILITY_FLOOR) {
        throw new ConfigError(`${path} declares window ${window}, below plausibility floor ${MODEL_WINDOW_PLAUSIBILITY_FLOOR} (non-authoritative rejection guard)`);
      }
      const citedWindow = cited.get(model);
      if (citedWindow === undefined) {
        throw new ConfigError(`${path} has no cited model-window entry in T20's vendored table`);
      }
      if (window !== citedWindow) {
        throw new ConfigError(`${path} declares ${window} but does not match cited window ${citedWindow} in T20's vendored table`);
      }
    }
  }
}

export const DEFAULT_CONFIG: TickmarkrConfig = {
  concurrency: 3,
  driver: "auto",
  integrationBranchPrefix: "tickmarkr/",
  taskTimeoutMinutes: 30,
  contextWarnTokens: 170_000, // v1.23 T2: overseer ctx-watch.sh proven threshold
  routing: {
    // v1.51 T3 (round-2 consult) / v1.52 T5: map entries carry preferences/pins only — band
    // policy lives in routing.floors, the single tier authority. A map entry can no longer carry
    // a real tier value at all: MapEntrySchema fails config load fail-closed on one, naming
    // routing.floors as the move target; only the legacy `tier: null` tombstone still parses.
    map: {
      plan: { pin: { via: "claude-code", model: "fable" } },
      spec: { pin: { via: "claude-code", model: "fable" } },
      implement: { prefer: ["cursor-agent", "codex"] },
      tests: { prefer: ["opencode"] },
    },
    floors: {
      plan: "frontier", spec: "frontier", migration: "frontier",
      implement: "mid", ui: "mid", refactor: "mid",
      tests: "cheap", docs: "cheap", chore: "cheap",
    },
    // ROUTE-14 (2026-07-11, operator-adopted): learned reordering ON by default. Shipped OFF through v1.6/v1.7
    // as a preview-then-adopt trust ramp (ROUTE-09); the operator adopts it here after v1.8 made learning
    // auditable (VIS-05 `tickmarkr report` learning section) and matured (decay ROUTE-11, scored utilization
    // ROUTE-12, escalation tiebreak ROUTE-13). SAFE BY CONSTRUCTION: an empty/cold profile ⇒ every
    // learnedScore returns exactly NEUTRAL ⇒ byte-identical v1.5 static routing, so ON only changes routing in
    // a workspace that has accumulated ≥MIN_SAMPLES warm telemetry per cell. Preview any workspace's effect
    // first with `tickmarkr plan` / `tickmarkr report`; flip to "off" to pin exact static routing (the kill switch stands).
    learned: "on",
    allowUnverifiedModels: false,
  },
  // Seed table (spec §13). New models = edit this (or your config.yaml), never code.
  // Windows are copied rather than derived from T20's table so config load can reject disagreement
  // between two independently owned artifacts instead of letting one side certify itself.
  tiers: {
    "claude-code": {
      vendor: "anthropic", channel: "sub",
      models: { fable: "frontier", opus: "frontier", sonnet: "mid", haiku: "cheap" },
      windows: { fable: 1_000_000, opus: 1_000_000, sonnet: 1_000_000, haiku: 200_000 },
    },
    // ids verified against installed CLI models_cache.json (codex 0.144.0, fetched 2026-07-09);
    // gpt-5.4 / gpt-5.4-mini removed — OpenAI retirement 2026-07-23; sol=frontier / terra=mid / luna=cheap per OpenAI tier framing.
    // MODEL-08 resolution (Phase 23, 23-LIVE-CHECK.md Finding 1): the v1.7 finding that codex refused
    // gpt-5.6-sol was a codex 0.143.0 CLIENT-VERSION gate ("requires a newer version of Codex"), NOT a
    // retired id. Installed codex 0.144.1 lists it (models_cache.json client_version 0.144.0, fetched
    // 2026-07-10) AND a live runtime probe (`codex exec --model gpt-5.6-sol` → "OK", 2026-07-10) confirmed
    // it runs. Reseeding away would be a regression — the CLI upgrade closed the gate. Seed stays.
    codex: {
      vendor: "openai", channel: "sub",
      models: { "gpt-5.6-sol": "frontier", "gpt-5.5": "frontier", "gpt-5.6-terra": "mid", "gpt-5.6-luna": "cheap" },
      windows: { "gpt-5.6-sol": 1_050_000, "gpt-5.5": 1_050_000, "gpt-5.6-terra": 1_050_000, "gpt-5.6-luna": 1_050_000 },
    },
    // grok-4.5 (xAI, released 2026-07-08) → mid: AA Intelligence 54 (#4), Terminal-Bench 2.1 83.3%
    // (≈ GPT-5.5 83.4, Fable 5 84.3), SWE-bench Pro 64.7%, ~4.2× more token-efficient than Opus 4.8
    // on SWE-b Pro (15,954 vs 67,020 output tokens). Near-frontier on terminal work at cheap price;
    // conservative mid per policy — learned routing / overlays may raise. Researched 2026-07-10,
    // promoted from overlay 2026-07-11 (MODEL-10).
    // grok-4.5-fast → cheap: speed-optimized variant, no independent benchmark scores yet → floor tier.
    // RETIRED 2026-07-13: cursor-agent seeds grok-4.5-xhigh / grok-4.5-fast-xhigh — CLI no longer reports
    // either id (tickmarkr plan lint, 2026-07-13). Tombstoned here; re-seed if cursor re-exposes them.
    // (Benchmark provenance above still informs the native grok adapter seeds below.)
    "cursor-agent": {
      vendor: "cursor", channel: "sub",
      models: {
        "composer-2.5": "mid",
        // composer-2.5-fast → cheap: speed-optimized variant, no independent benchmark scores yet → floor
        // tier (same policy call as grok-composer-2.5-fast below). Id live-verified in doctor.json probe
        // 2026-07-16 (cursor-agent 2026.07.09); gives cursor a cheap-tier channel so low-complexity shapes
        // stop burning its mid. Operator-approved 2026-07-16.
        "composer-2.5-fast": "cheap",
      },
      windows: { "composer-2.5": 200_000, "composer-2.5-fast": 200_000 },
    },
    // GLM-5.2 → mid per benchmark policy (2026-07): SWE-bench Pro 62.1 (> GPT-5.5 58.6), FrontierSWE 74.4 ≈ Opus 4.8;
    // no independent Terminal-Bench score → conservative mid, overlays may raise.
    // MODEL-09 reseed (Phase 23, 23-LIVE-CHECK.md Finding 2): opencode 1.17.15 renamed the provider prefix
    // opencode/ → zai-coding-plan/; the old id opencode/glm-5.2 is live-confirmed ABSENT and the new id
    // zai-coding-plan/glm-5.2 present (`opencode models`, 2026-07-10). Tier stays mid — same model, benchmark
    // unchanged (GLM-5.2 SWE-bench Pro 62.1).
    opencode: {
      vendor: "mixed", channel: "sub",
      models: { "zai-coding-plan/glm-5.2": "mid" },
      windows: { "zai-coding-plan/glm-5.2": 1_000_000 },
    },
    // GLM-5.2 via pi/ZAI Coding Plan (sub, flat-rate). mid per benchmark policy (2026-07):
    // SWE-bench Pro 62.1, FrontierSWE 74.4 — same rationale as the opencode glm-5.2 seed above.
    // id "zai/glm-5.2" verified via pi --list-models v0.80.3, 2026-07-10 (provider zai, model glm-5.2);
    // provider-qualified so the channel never depends on ~/.pi/agent/settings.json defaults.
    // Also exists as opencode:zai-coding-plan/glm-5.2 — two channels, one model, distinct channelKeys, intentional
    // (opencode zen vs ZAI Coding Plan billing paths); review-diversity hole (zhipu vs mixed = same model
    // cross-harness) is pre-existing, FLEET-05 owns it.
    pi: {
      vendor: "zhipu", channel: "sub",
      models: { "zai/glm-5.2": "mid" },
      windows: { "zai/glm-5.2": 1_000_000 },
    },
    // Native grok CLI (Phase 40). grok-4.5 → mid: same benchmark provenance as the retired cursor-agent
    // grok-4.5-xhigh seed above (AA 54, TB2.1 83.3%, SWE-b Pro 64.7% — researched 2026-07-10).
    // grok-composer-2.5-fast → cheap: fast variant, no independent benchmark scores yet → floor tier
    // (same policy call as grok-4.5-fast, above). Ids live-verified `grok models` 2026-07-11, grok 0.2.93.
    // Distinct channel from any former cursor-agent grok seed; channelKey() disambiguates (40-CONTEXT D-06).
    grok: {
      vendor: "xai", channel: "sub",
      models: { "grok-4.5": "mid", "grok-composer-2.5-fast": "cheap" },
      windows: { "grok-4.5": 500_000, "grok-composer-2.5-fast": 200_000 },
    },
    // Native kimi CLI (Phase 48). kimi-code/k3 → frontier: 81.2 FrontierSWE, 88.3 Terminal-Bench 2.1,
    // top-3 across six coding benchmarks (research 2026-07-17, K3 released 2026-07-16).
    // kimi-code/kimi-for-coding → mid (K2.7 Coding, 262k ctx). kimi-code/kimi-for-coding-highspeed →
    // cheap (fast K2.7 variant). Ids live-verified `kimi provider list --json` 2026-07-17, kimi 0.27.0.
    kimi: {
      vendor: "moonshot", channel: "sub",
      models: {
        "kimi-code/k3": "frontier",
        "kimi-code/kimi-for-coding": "mid",
        "kimi-code/kimi-for-coding-highspeed": "cheap",
      },
      windows: {
        "kimi-code/k3": 1_048_576,
        "kimi-code/kimi-for-coding": 262_144,
        "kimi-code/kimi-for-coding-highspeed": 262_144,
      },
    },
  },
  pricing: { cheap: 0.1, mid: 0.5, frontier: 2.5 },
  gates: { diffCap: DEFAULT_DIFF_CAP },
  judge: { adapter: "claude-code", model: "fable" },
  // R3: no `policy` floor — the neutral floor leaves the compiler's per-task assignment standing, so
  // the path-keyed rule is reachable out of the box rather than raised to full by construction.
  review: { complexityThreshold: 7, required: true, criticalPaths: [...DEFAULT_REVIEW_CRITICAL_PATHS] },
  consult: { adapter: "claude-code", model: "fable", stallMinutes: 15 },
  // v1.4: gate LLM calls (judge/review/consult) run headless by default; pane opts back into visible agents.
  // v1.2: workers are the real agent TUI in the pane; "print" restores the -p-rendered-in-pane path.
  visibility: { llm: "headless", keepPanes: "run", worker: "interactive", workersPerTab: 3 },
};

function deepMerge<T>(base: T, over: unknown, path: string[] = []): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || typeof over !== "object" || base === null) {
    return over as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === null) {
      // T19: null is a declared multi-vendor state only at tiers.<adapter>.vendor. Every other null
      // remains the v1.1 overlay tombstone (for example a stale tiers model id).
      if (path.length === 2 && path[0] === "tiers" && k === "vendor") out[k] = null;
      else delete out[k];
      continue;
    }
    // OBS-75 class: merge fresh-landing objects onto {} so nested tombstone nulls are pruned even when
    // no lower layer set the key (a fleet-cleared deny writes {adapters: null} — the schema rejects raw null)
    const childPath = [...path, k];
    out[k] = k in out ? deepMerge(out[k], v, childPath) : deepMerge({} as unknown, v, childPath);
  }
  return out as T;
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return parse(readFileSync(path, "utf8"));
}

export function globalConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "tickmarkr");
}

export function overlayPreferShapes(repoRoot: string, opts: { globalDir?: string } = {}): ReadonlySet<string> {
  const shapes = new Set<string>();
  for (const layer of [readYaml(join(opts.globalDir ?? globalConfigDir(), "config.yaml")), readYaml(join(repoRoot, stateDirName(repoRoot), "config.yaml"))]) {
    const map = (layer as { routing?: { map?: Record<string, { prefer?: unknown }> } } | undefined)?.routing?.map;
    if (!map) continue;
    for (const [shape, entry] of Object.entries(map)) {
      if (entry && Object.prototype.hasOwnProperty.call(entry, "prefer") && entry.prefer !== null) shapes.add(shape);
    }
  }
  return shapes;
}

const lowerTier = (t: Tier): Tier => (t === "frontier" ? "mid" : "cheap");
const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);
const integrityMin = (shape: string): Tier =>
  (INTEGRITY_FLOOR_SHAPES as readonly string[]).includes(shape) ? "frontier" : "cheap";

// partner-led = frontier everywhere; staff-led = one band down, integrity-clamped (net effect on the
// defaults: implement/refactor → cheap, ui → frontier); risk-based = identity, so an absent mode key
// resolves byte-identically to pre-v1.51 routing.
function presetFloor(mode: RoutingMode, shape: string, dflt: Tier): Tier {
  if (mode === "partner-led") return "frontier";
  if (mode === "staff-led") return maxTier(lowerTier(dflt), integrityMin(shape));
  return dflt;
}

/** Which floor shapes the operator wrote in an overlay layer (explicit beats mode; null tombstones stay removed). */
function overlayFloorEdits(layers: unknown[]): { explicit: Set<string>; tombstoned: Set<string> } {
  const explicit = new Set<string>();
  const tombstoned = new Set<string>();
  for (const layer of layers) {
    const floors = (layer as { routing?: { floors?: Record<string, unknown> } } | undefined)?.routing?.floors;
    if (!floors || typeof floors !== "object" || Array.isArray(floors)) continue;
    for (const [shape, v] of Object.entries(floors)) {
      if (v === null) {
        explicit.delete(shape);
        tombstoned.add(shape);
      } else {
        tombstoned.delete(shape);
        explicit.add(shape);
      }
    }
  }
  return { explicit, tombstoned };
}

export type ModeResolution = {
  mode: RoutingMode;
  /** floor shape → "mode <name>" | "config floors" */
  provenance: Record<string, string>;
  /** plan lints: shadowed mode deltas + operator floors below the integrity minimum (standing) */
  lints: string[];
};

// Mutates cfg.routing.floors (and explore under partner-led) to the mode-resolved values.
function resolveRoutingMode(cfg: TickmarkrConfig, layers: unknown[]): ModeResolution {
  const mode = cfg.routing.mode ?? "risk-based";
  const { explicit, tombstoned } = overlayFloorEdits(layers);
  const provenance: Record<string, string> = {};
  const lints: string[] = [];
  for (const shape of SHAPES) {
    if (tombstoned.has(shape)) continue; // operator removed the floor — a mode never resurrects it
    const dflt = DEFAULT_CONFIG.routing.floors[shape];
    const moded = presetFloor(mode, shape, dflt);
    if (explicit.has(shape)) {
      const val = cfg.routing.floors[shape];
      provenance[shape] = "config floors";
      if (moded !== val && moded !== dflt) {
        lints.push(`floors.${shape}: ${val} (config floors) overrides mode ${mode} — shadowed delta: ${shape} ${dflt}→${moded}`);
      }
      if (TIER_RANK[val] < TIER_RANK[integrityMin(shape)]) {
        lints.push(`floors.${shape}: ${val} is below integrity minimum frontier — integrity class ${INTEGRITY_FLOOR_SHAPES.join("/")} is advisory to explicit floors and map pins; map pins are supreme`);
      }
      continue;
    }
    cfg.routing.floors[shape] = moded;
    provenance[shape] = `mode ${mode}`;
  }
  for (const shape of Object.keys(cfg.routing.floors)) {
    if (!(shape in provenance)) provenance[shape] = "config floors"; // overlay floors on non-shape keys
  }
  // partner-led resolves exploration off (probes are the wrong spend under a premium declaration);
  // staff-led and risk-based leave explore untouched — the round-2 fence rides through as configured.
  if (mode === "partner-led") cfg.routing.explore = { ...cfg.routing.explore, mode: "off" };
  return { mode, provenance, lints };
}

/** loadConfig plus the mode-resolution record (floor provenance + plan lints). The resolved floors are
 *  already applied to cfg.routing.floors — route() consumes floors only and never sees the mode. */
export function loadConfigWithMode(
  repoRoot: string,
  opts: { globalDir?: string; repoOverlayText?: string } = {},
): { cfg: TickmarkrConfig; mode: ModeResolution } {
  const globalCfg = readYaml(join(opts.globalDir ?? globalConfigDir(), "config.yaml"));
  // v1.52 T2: repoOverlayText substitutes candidate bytes for the on-disk repo layer — the fleet
  // write guard validates EXACTLY what it is about to write through this one loader path.
  const repoCfg = opts.repoOverlayText === undefined
    ? readYaml(join(repoRoot, stateDirName(repoRoot), "config.yaml"))
    : parse(opts.repoOverlayText);
  const merged = deepMerge(deepMerge(structuredClone(DEFAULT_CONFIG), globalCfg), repoCfg);
  const r = TickmarkrConfigSchema.safeParse(merged);
  if (!r.success) throw new ConfigError(z.prettifyError(r.error));
  // The vendored table attests Tickmarkr's built-in seed artifact. Operator overlays remain free to
  // declare private/future models and deliberately smaller test windows without pretending T20 cited them.
  assertSeededModelWindows();
  return { cfg: r.data, mode: resolveRoutingMode(r.data, [globalCfg, repoCfg]) };
}

export function loadConfig(repoRoot: string, opts: { globalDir?: string } = {}): TickmarkrConfig {
  return loadConfigWithMode(repoRoot, opts).cfg;
}

/** v1.52 T2 write-time reload guard: run candidate repo-overlay bytes through the SAME production
 *  loader path every later command uses (parse → merge → schema → mode resolution). Returns null
 *  when the bytes load, else the loader's failure message — the caller must refuse the write. */
export function overlayBytesLoadError(repoRoot: string, bytes: string, opts: { globalDir?: string } = {}): string | null {
  try {
    loadConfigWithMode(repoRoot, { ...opts, repoOverlayText: bytes });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export type InitConfigOverlay = {
  concurrency?: number;
  driver?: TickmarkrConfig["driver"];
  visibility?: { llm?: TickmarkrConfig["visibility"]["llm"] };
};

export function configTemplate(overlay?: InitConfigOverlay): string {
  const base = `# tickmarkr config overlay — merges over built-in defaults (repo beats global beats defaults)
# concurrency: 3
# driver: auto            # auto | herdr | subprocess
# taskTimeoutMinutes: 30
# contextWarnTokens: 170000   # v1.23: journal+notify once per attempt when live worker context crosses this (status shows the sample)
# setup: npm ci --prefer-offline   # run in each fresh task worktree before dispatch
# routing:
#   mode: risk-based      # v1.51: partner-led | risk-based | staff-led — a preset compiled into floors at
#                         # load (partner-led: every shape frontier + explore off; staff-led: implement/refactor
#                         # cheap; integrity set plan/spec/migration/ui never resolves below frontier under any
#                         # mode). Absent = risk-based = byte-identical routing. Explicit floors below beat mode deltas (linted).
#   map:                  # per-shape preferences/pins; band policy lives in routing.floors
#     implement: { prefer: [cursor-agent, codex] }
#     migration: { pin: { via: claude-code, model: fable } }
#     tests: { tier: null }   # tombstone: null removes a legacy map tier (a real tier value now fails config load — move the band to routing.floors.tests)
#   floors:               # tier authority — advisory minimum bands; 'tickmarkr plan' lints violations
#     migration: frontier
#   learned: on            # default ON (ROUTE-14); cold profile = exact v1.5 static routing, warms per workspace. Set 'off' to pin static routing; preview with 'tickmarkr plan'
#   learnedTuning: { halfLifeRuns: 5, availWeight: 0.05 }  # optional; defaults byte-identical
#   explore: { mode: on, excludeShapes: [], excludeComplexityAtOrAbove: null, cap: 5 }  # optional; absent ⇒ byte-identical
#   sla: { implement: 15 }  # optional per-shape minutes — advisory plan lint only; absent ⇒ no lint
#   allow: { adapters: [claude-code, codex] }   # optional fleet allowlist; presence activates even if empty (fail-closed)
#   deny:                                      # optional fleet denylist; deny beats allow on conflict
#     models:
#       - pi:zai/glm-5.2  # OBS-57: pi passes run-start probe but hangs at finish without TICKMARKR_RESULT — remove after no-trailer demotion ships (v1.46 provider-outage taxonomy)
#     workers:                                  # optional worker-only deny; flat adapters/models still deny every role
#       models: [kimi:kimi-code/k3]
#   # incident-born deny/pin entries MUST name OBS id + root cause + removal condition (see docs/codebase/CONVENTIONS.md)
#   # entry grammar: adapter id | model id | adapter:model (entries in either list accept all three forms)
#   # a hint pinning a denied channel FAILS at plan time (RoutingError) — never silent reroute
#   # tombstone: deny: null in a repo overlay removes a global deny (arrays replace wholesale, never merge)
# tiers:                  # model → capability band; extend when new models ship
#   claude-code: { vendor: anthropic, channel: sub, models: { fable: frontier } }
#   codex: { models: { gpt-5.2-codex: null } }   # null = tombstone: removes a stale seed id
# visibility:
#   llm: headless         # headless (default): judge/review/consult run silently | pane: visible agents
#   keepPanes: run        # run (default): ephemeral judge/review/consult panes close when read; a merged task's worker pane closes on done; other worker panes persist until run end | attempt | forever (keep everything for debugging)
#   worker: interactive   # interactive (default): workers run the real agent TUI | print
#   workersPerTab: 3      # cap worker panes sharing one tab; gate panes ride with their task and never count. Default 3
# scope:
#   allowDeviations: []    # globs an operator permits out-of-scope edits into, e.g. ["package-lock.json"]
# gates:                  # override auto-detected commands; per-shape participation may only skip LLM gates
#   diffCap: 60000         # fail closed before an LLM gate; split the task or raise this positive integer
#   test: npm test
#   byShape:
#     docs: { acceptance: false, review: false }  # baseline, evidence, and scope are mandatory
# review: { complexityThreshold: 7, required: true, prefer: [codex:gpt-5.6-sol, kimi] }
#                         # prefer: ordered reviewer seat preference (adapter | adapter:model); ranks
#                         # diversity-eligible channels only — never admits a same-vendor/same-model reviewer
# consult: { adapter: claude-code, model: fable, stallMinutes: 15, prefer: [codex:gpt-5.6-sol, kimi:kimi-code/k3] }
#                         # prefer: ranked consult seat failover — entries are adapter:model ONLY (a
#                         # consult seat has no channel to inherit a model from). The seat walks the
#                         # list to the first live adapter; a failed seat or unparseable verdict falls
#                         # to the next entry; the pinned adapter/model above is always the final seat
# cost:                   # v1.20 REC-02 — OPTIONAL price table for the usage/cost report. Absent ⇒ every
#                         # channel reports "not measurable" (never a crash or a fake $0). Two economics,
#                         # never conflated: API = tokens × per-Mtok rate; sub = flat plan amortized over a
#                         # windows/month range, plus an API-equivalent counterfactual when the model has a rate.
#   models:               # per-Mtok API rates by model id. Copy from LiteLLM's
#                         # model_prices_and_context_window.json (github.com/BerriAI/litellm) — the de-facto
#                         # price table ccusage/tokonomics consume. Stamp rateDate; refresh on vendor changes.
#     opus:   { inPerMtok: 5.0,  outPerMtok: 25.0, cacheReadPerMtok: 0.5, rateDate: 2026-07-13 }
#     sonnet: { inPerMtok: 3.0,  outPerMtok: 15.0, rateDate: 2026-07-13 }
#   subs:                 # subscription plans by adapter id (plans are per-account, not per-token).
#                         # windowsPerMonthLow/High is a RANGE (time-varying quotas, e.g. GLM peak 3×).
#     claude-code: { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 }
# NOTE: claude workers/judges run with --strict-mcp-config --mcp-config '{"mcpServers":{}}' — project
# .mcp.json servers (e.g. supabase) are UNAVAILABLE in worktrees. Deliberate: prevents the MCP-enable
# dialog stalling unattended HEADLESS runs (live-verified on claude 2.1.205). Interactive TUIs still
# show a first-entry dialog — but it is the workspace TRUST dialog, not MCP config loading (live-drilled
# claude 2.1.206, 2026-07-10). There is NO CLI flag to pre-accept trust; the only store is claude's global
# ~/.claude.json keyed on the EXACT worktree path. tickmarkr does NOT write it (HYG-03 won't-fix, decision B:
# claude's own last-writer-wins persistence races any seed). Cost is ~one dismissal per worktree path,
# ever — tickmarkr reuses stable worktree paths so the accept persists across runs; blocked-pane paging
# surfaces each first-time dialog.
`;
  if (!overlay) return base;
  const lines: string[] = [];
  if (overlay.concurrency !== undefined) lines.push(`concurrency: ${overlay.concurrency}`);
  if (overlay.driver !== undefined) lines.push(`driver: ${overlay.driver}`);
  if (overlay.visibility?.llm !== undefined) {
    lines.push("visibility:");
    lines.push(`  llm: ${overlay.visibility.llm}`);
  }
  if (!lines.length) return base;
  const nl = base.indexOf("\n");
  return `${base.slice(0, nl + 1)}${lines.join("\n")}\n${base.slice(nl + 1)}`;
}

// Fleet overlay mutation, legacy serialization, and diff rendering live together in fleet-overlay.ts.
export {
  FLEET_OVERLAY_KEYS,
  fleetEditableEquals,
  fleetRepoOverlayFromDelta,
  renderFleetOverlayWrite,
  repoOverlayYaml,
  serializeFleetOverlay,
  unifiedYamlDiff,
} from "./fleet-overlay.js";
export type { FleetOverlayWrite } from "./fleet-overlay.js";

export type FleetTierAssignment = { tier: Tier; provenance?: string };

export type FleetEditable = {
  denyAdapters: string[];
  denyModels: string[];
  tiers: Record<string, Record<string, FleetTierAssignment | null>>;
  map: Record<string, MapEntry>;
  floors: Record<string, Tier>;
};

export function repoOverlayPath(repoRoot: string): string {
  return join(repoRoot, stateDirName(repoRoot), "config.yaml");
}

export function readOverlayFile(path: string): Record<string, unknown> {
  const raw = readYaml(path);
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`invalid overlay at ${path}`);
  return raw as Record<string, unknown>;
}

export function fleetEditableFromConfig(cfg: TickmarkrConfig): FleetEditable {
  const tiers: FleetEditable["tiers"] = {};
  for (const [adapter, entry] of Object.entries(cfg.tiers)) {
    tiers[adapter] = {};
    for (const [model, tier] of Object.entries(entry.models)) {
      tiers[adapter][model] = { tier };
    }
  }
  return {
    denyAdapters: [...(cfg.routing.deny?.adapters ?? [])].sort(),
    denyModels: [...(cfg.routing.deny?.models ?? [])].sort(),
    tiers,
    map: structuredClone(cfg.routing.map),
    floors: { ...cfg.routing.floors },
  };
}

/** Resolve which layer last set a dotted fleet path (defaults < global < repo). */
export function fleetKeyLayer(
  repoRoot: string,
  dotted: string,
  opts: { globalDir?: string } = {},
): "defaults" | "global" | "repo" {
  const gdir = opts.globalDir ?? globalConfigDir();
  const globalRaw = readOverlayFile(join(gdir, "config.yaml"));
  const repoRaw = readOverlayFile(repoOverlayPath(repoRoot));
  const parts = dotted.split(".");
  const at = (layer: Record<string, unknown>) => {
    let cur: unknown = layer;
    for (const p of parts) {
      if (cur === undefined || cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  };
  if (at(repoRaw) !== undefined) return "repo";
  if (at(globalRaw) !== undefined) return "global";
  return "defaults";
}

/** Non-interactive fleet state for CI drift checks (`tickmarkr fleet --print`). */
export function formatFleetPrint(repoRoot: string, opts: { globalDir?: string } = {}): string {
  const gdir = opts.globalDir ?? globalConfigDir();
  const effective = loadConfig(repoRoot, { globalDir: gdir });
  const doc = new Document({ routing: effective.routing, tiers: effective.tiers });
  doc.commentBefore = " tickmarkr fleet — effective state (repo > global > defaults)";
  const annotate = (path: string[], dotted = path.join(".")) => {
    const node = doc.getIn(path, true);
    if (node && typeof node === "object" && "comment" in node) {
      node.comment = ` ${fleetKeyLayer(repoRoot, dotted, opts)}`;
    }
  };
  if (effective.routing.deny?.adapters !== undefined) annotate(["routing", "deny", "adapters"]);
  if (effective.routing.deny?.models !== undefined) annotate(["routing", "deny", "models"]);
  for (const shape of Object.keys(effective.routing.map)) annotate(["routing", "map", shape]);
  annotate(["routing", "floors"]);
  for (const [adapter, entry] of Object.entries(effective.tiers)) {
    for (const model of Object.keys(entry.models)) annotate(["tiers", adapter, "models", model]);
  }
  return String(doc);
}
