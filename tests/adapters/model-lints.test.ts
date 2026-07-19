import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { allAdapters, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { MODEL_STALE_DAYS, SEED_STAMPED, contextWindowLints, estimateTaskPayloadTokens, modelLints, preferEntryLints, seedPreferLints, suggestOverlay } from "../../src/adapters/model-lints.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { AuthHealth } from "../../src/adapters/types.js";

const emptyRepo = () => ({ repo: mkdtempSync(join(tmpdir(), "tickmarkr-ml-r-")), globalDir: mkdtempSync(join(tmpdir(), "tickmarkr-ml-g-")) });
const cfg = () => {
  const { repo, globalDir } = emptyRepo();
  return loadConfig(repo, { globalDir }); // pure DEFAULT_CONFIG
};
// Phase 23: the opencode DEFAULT seed was reseeded opencode/glm-5.2 → zai-coding-plan/glm-5.2 (MODEL-09).
// The rename-scenario tests below need the PRE-rename configured state, so reconstruct it via a repo overlay:
// null-tombstone the new default and restore the old id. Mirrors repoWithOverlay in tests/route/matrix.test.ts.
const preRenameCfg = () => {
  const { globalDir } = emptyRepo();
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ml-stale-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  const overlay = [
    "tiers:",
    "  opencode:",
    "    models:",
    "      zai-coding-plan/glm-5.2: null",
    "      opencode/glm-5.2: mid",
    "",
  ].join("\n");
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), overlay);
  return loadConfig(repo, { globalDir });
};
const adapters = allAdapters(); // method-presence only; modelLints never calls listModels()
const installed = (models: string[], modelsDetectedAt?: string): AuthHealth => ({
  installed: true, authed: true, models, ...(modelsDetectedAt ? { modelsDetectedAt } : {}),
});
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe("modelLints — both-direction staleness lints", () => {
  test("tombstone direction: configured id CLI no longer reports (live glm-5.2 proof)", () => {
    // Phase 23: stale seed reconstructed via overlay (DEFAULT was reseeded to zai-coding-plan/glm-5.2 in MODEL-09).
    const health = { opencode: installed(["zai-coding-plan/glm-5.2", "opencode/big-pickle"]) };
    const lints = modelLints(preRenameCfg(), health, adapters);
    expect(lints).toContain(
      "opencode: tiers lists opencode/glm-5.2 — CLI no longer reports it; tombstone it (opencode/glm-5.2: null overlay) or verify the id",
    );
  });

  test("unconfigured direction: reports N models not in tiers, per-id diff (gpt-5.5 configured+detected → no lint)", () => {
    const health = {
      codex: installed(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]),
    };
    const lints = modelLints(cfg(), health, adapters);
    expect(lints).toContain(
      "codex: reports 3 model(s) not in tiers (gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark) — classify before routing (benchmark policy)",
    );
    // gpt-5.5 is configured AND detected — the diff is per-id, so no tombstone/unconfigured lint mentions it
    expect(lints.some((l) => l.includes("gpt-5.5"))).toBe(false);
  });

  test("capping: 193 unconfigured ids → exactly one lint, 5 ids then +N more", () => {
    const many = Array.from({ length: 193 }, (_, i) => `cmodel-${i}`);
    const health = { "cursor-agent": installed(many) };
    const lints = modelLints(cfg(), health, adapters);
    const unconfigured = lints.filter((l) => l.startsWith("cursor-agent: reports"));
    expect(unconfigured).toHaveLength(1);
    expect(unconfigured[0]).toBe(
      "cursor-agent: reports 193 model(s) not in tiers (cmodel-0, cmodel-1, cmodel-2, cmodel-3, cmodel-4, +188 more) — classify before routing (benchmark policy)",
    );
  });

  test("TTY cap: 37 unconfigured ids ? 3 names + +34 more — see .tickmarkr/doctor.json", () => {
    const many = Array.from({ length: 37 }, (_, i) => `cmodel-${i}`);
    const health = { "cursor-agent": installed(many) };
    const lints = modelLints(cfg(), health, adapters, { tty: true });
    const unconfigured = lints.filter((l) => l.startsWith("cursor-agent: reports"));
    expect(unconfigured).toHaveLength(1);
    expect(unconfigured[0]).toContain("cmodel-0, cmodel-1, cmodel-2, +34 more");
    expect(unconfigured[0]).toContain("see .tickmarkr/doctor.json");
    expect(unconfigured[0]).not.toContain("cmodel-3");
  });

  test("cursor noise filter: auto + effort/speed variants excluded from aggregation", () => {
    const health = { "cursor-agent": installed(["auto", "gpt-x-high", "gpt-x-fast", "gpt-x-minimal", "gpt-x-low", "gpt-x-medium", "gpt-x-xhigh", "newmodel-1"]) };
    const lints = modelLints(cfg(), health, adapters);
    // composer-2.5 configured, missing from detection → tombstone; only newmodel-1 survives the variant filter
    expect(lints).toContain("cursor-agent: reports 1 model(s) not in tiers (newmodel-1) — classify before routing (benchmark policy)");
  });

  test("age: >30d stale → lint; <30d → none", () => {
    const stale = modelLints(cfg(), { codex: installed(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"], daysAgo(40)) }, adapters);
    expect(stale).toContain("codex: model knowledge is 40 days old — rerun tickmarkr doctor");
    const fresh = modelLints(cfg(), { codex: installed(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"], daysAgo(5)) }, adapters);
    expect(fresh.some((l) => l.includes("days old"))).toBe(false);
    expect(MODEL_STALE_DAYS).toBe(30);
  });

  test("no detection data: installed adapter with listModels but empty models → run tickmarkr doctor, no diff", () => {
    const lints = modelLints(cfg(), { opencode: installed([]) }, adapters);
    expect(lints).toContain("opencode: no detection data — run tickmarkr doctor");
    expect(lints.some((l) => l.startsWith("opencode: tiers lists"))).toBe(false);
  });

  test("no list surface: claude-code has no listModels → seed-stamp note, never tombstone/unconfigured", () => {
    const lints = modelLints(cfg(), { "claude-code": installed([]) }, adapters);
    expect(lints).toContain(`claude-code: no model-list surface — seeds stamped ${SEED_STAMPED}; verify manually`);
    expect(SEED_STAMPED).toBe("2026-07-09");
    expect(lints.some((l) => l.startsWith("claude-code: tiers lists") || l.startsWith("claude-code: reports"))).toBe(false);
  });

  test("pre-v1.5 compat: doctor.json with models:[] and no modelsDetectedAt loads clean, no NaN/throw", () => {
    const { repo } = emptyRepo();
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    const legacy = {
      "claude-code": { installed: true, authed: true, models: [] },
      codex: { installed: true, authed: true, models: [] },
      opencode: { installed: true, authed: true, models: [] },
    };
    writeFileSync(join(repo, ".tickmarkr", "doctor.json"), JSON.stringify(legacy, null, 2) + "\n");
    const health = readDoctor(repo)!;
    let lints: string[] = [];
    expect(() => { lints = modelLints(cfg(), health, adapters); }).not.toThrow();
    expect(lints.every((l) => !l.includes("NaN"))).toBe(true);
  });

  test("MODEL-02 round-trip: populated models + modelsDetectedAt survive writeDoctor→readDoctor", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-ml-rt-"));
    const health = { codex: installed(["gpt-5.6-sol", "gpt-5.5"], "2026-07-10T09:00:00.000Z") };
    writeDoctor(repo, health);
    expect(readDoctor(repo)).toEqual(health);
  });
});

// MODEL-05/06: paste-ready overlay fragment. Additions render whole-line-commented with a ??? tier
// placeholder (a tier is a benchmark claim — the machine never fabricates one); removals render as
// live `null` tombstones. Print-only: pure function, no fs/process. The codex gpt-5.6-sol seed vs the
// installed CLI's refusal (Phase 17 LIVE-CHECK finding 5) is the worked example.
describe("suggestOverlay — paste-ready drift fragment", () => {
  const AT = "2026-07-10T09:00:00.000Z";

  test("worked example: gpt-5.6-sol → live tombstone; gpt-5.7-nova → comment-inert addition", () => {
    const health = { codex: installed(["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.7-nova"], AT) };
    const frag = suggestOverlay(cfg(), health, adapters);
    expect(frag).toContain("gpt-5.6-sol: null");
    expect(frag).toMatch(/# gpt-5\.7-nova: \?\?\?/);
    // the fragment is valid YAML: tombstone applies as null, the commented addition is ABSENT (paste-inert)
    const parsed = parse(frag) as { tiers: { codex: { models: Record<string, unknown> } } };
    expect(parsed.tiers.codex.models["gpt-5.6-sol"]).toBeNull();
    expect("gpt-5.7-nova" in parsed.tiers.codex.models).toBe(false);
  });

  test("MODEL-06: no uncommented tier value anywhere; every addition cites the benchmark policy", () => {
    const health = { codex: installed(["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.7-nova"], AT) };
    const frag = suggestOverlay(cfg(), health, adapters);
    // drill 2026-07-10: emitting an uncommented tier (`gpt-5.7-nova: mid`) turns BOTH this regex and Test 1's
    // parsed-YAML absence assertion red (MODEL-06) — verified by falsification drill, see 21-01-SUMMARY.md
    expect(frag).not.toMatch(/^[^#]*:\s*(cheap|mid|frontier)\s*($|#)/m);
    expect(frag).toMatch(/# gpt-5\.7-nova: \?\?\?.*classify per benchmark policy/);
  });

  test("reference WARNING: a tombstone still named by routing.map/judge fires; an unreferenced one stays clean", () => {
    const health = { codex: installed(["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"], AT) }; // gpt-5.6-sol gone

    const pinned = cfg();
    pinned.routing.map.implement = { pin: { via: "codex", model: "gpt-5.6-sol" } };
    const pinTomb = suggestOverlay(pinned, health, adapters).split("\n").find((l) => l.includes("gpt-5.6-sol: null"))!;
    expect(pinTomb).toMatch(/# WARNING:.*routing\.map\.implement\.pin/);

    const judged = cfg();
    judged.judge = { adapter: "codex", model: "gpt-5.6-sol" };
    const jTomb = suggestOverlay(judged, health, adapters).split("\n").find((l) => l.includes("gpt-5.6-sol: null"))!;
    expect(jTomb).toMatch(/# WARNING:.*judge/);

    const plainTomb = suggestOverlay(cfg(), health, adapters).split("\n").find((l) => l.includes("gpt-5.6-sol: null"))!;
    expect(plainTomb).not.toContain("WARNING");
  });

  test("filters: MODEL_ID_RE-failing ids (ANSI) and lint variants never become additions", () => {
    const health = {
      codex: installed(
        ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "\x1b[31mgpt-evil", "gpt-5.3-codex-high"],
        AT,
      ),
    };
    const frag = suggestOverlay(cfg(), health, adapters);
    expect(frag).not.toContain("gpt-evil");
    expect(frag).not.toContain("gpt-5.3-codex-high");
    // all configured present + both extras filtered ⇒ zero delta ⇒ empty fragment
    expect(frag).toBe("");
  });

  // Follow-up correction (2026-07-10): additions are gated by a purely RELATIONAL rule (no capability
  // judgment — that would be auto-tiering's cousin, forbidden by the v1.5 locked decision). A detected id d
  // is suggested iff providerPrefix(d) matches some configured prefix (clause a) OR canonical(d) equals some
  // configured canonical (clause b, the rename case). Everything else collapses into ONE counted summary line.
  test("rename case (clause b): configured opencode/glm-5.2, detected zai-coding-plan/glm-5.2 → suggested addition", () => {
    // DRILL 2026-07-10: deleting clause (b) from the relational gate turns THIS red (rename would fall to summary)
    // Phase 23: stale seed reconstructed via overlay (DEFAULT was reseeded to zai-coding-plan/glm-5.2 in MODEL-09).
    const health = { opencode: installed(["zai-coding-plan/glm-5.2"], AT) };
    const frag = suggestOverlay(preRenameCfg(), health, adapters);
    expect(frag).toContain("opencode/glm-5.2: null");        // old id gone → live tombstone
    expect(frag).toMatch(/# zai-coding-plan\/glm-5\.2: \?\?\?/); // same canonical glm-5.2 → surfaced as the rename
  });

  test("unrelated id (neither clause): pi zai/glm-5.2 vs google/gemini-embedding-001 → counted summary, not an addition", () => {
    const health = { pi: installed(["zai/glm-5.2", "google/gemini-embedding-001"], AT) };
    const frag = suggestOverlay(cfg(), health, adapters);
    expect(frag).not.toMatch(/# google\/gemini-embedding-001: \?\?\?/); // NOT an addition
    expect(frag).toMatch(/# \(\+1 other detected id not related to your configured models — see \.tickmarkr\/doctor\.json\)/);
  });

  test("same provider prefix (clause a): pi zai/glm-5.2 vs zai/glm-5.1 → suggested addition", () => {
    const health = { pi: installed(["zai/glm-5.2", "zai/glm-5.1"], AT) };
    const frag = suggestOverlay(cfg(), health, adapters);
    expect(frag).toMatch(/# zai\/glm-5\.1: \?\?\?/);
  });

  test("counted summary reports the exact omitted count (no silent truncation)", () => {
    const health = { opencode: installed(["zai-coding-plan/glm-5.2", "google/gemini-embedding-001", "openai/preview-tts", "hume/vision-1"], AT) };
    const frag = suggestOverlay(cfg(), health, adapters);
    // zai-coding-plan/glm-5.2 present (no tombstone); the 3 provider-foreign, canonical-foreign ids collapse into one line
    expect(frag).toMatch(/# \(\+3 other detected ids not related to your configured models — see \.tickmarkr\/doctor\.json\)/);
    expect(frag).not.toContain("gemini-embedding-001: ???");
  });

  test("quiet when clean: detected === configured → \"\"; no-list-surface & empty detection contribute nothing", () => {
    const clean = { codex: installed(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"], AT) };
    expect(suggestOverlay(cfg(), clean, adapters)).toBe("");
    // claude-code has no listModels; opencode installed but empty detection → both skipped, mirroring modelLints guards
    expect(suggestOverlay(cfg(), { "claude-code": installed([]), opencode: installed([]) }, adapters)).toBe("");
  });
});

describe("OBS-30 T2 seed prefer dead-adapter lint", () => {
  const adapters = allAdapters().filter((a) => ["cursor-agent", "codex", "grok"].includes(a.id));

  test("fires when a seed prefer names an all-unauthed adapter", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    const health: Record<string, AuthHealth> = {
      "cursor-agent": {
        installed: true, authed: true, models: ["composer-2.5"],
        modelAuth: { "composer-2.5": { authed: true, probedAt: "2026-07-15T00:00:00.000Z" } },
      },
      codex: {
        installed: true, authed: true, models: ["gpt-5.6-terra"],
        modelAuth: { "gpt-5.6-terra": { authed: false, reason: "HTTP 403", probedAt: "2026-07-15T00:00:00.000Z" } },
      },
      grok: {
        installed: true, authed: true, models: ["grok-4.5"],
        modelAuth: { "grok-4.5": { authed: true, probedAt: "2026-07-15T00:00:00.000Z" } },
      },
    };
    const lints = seedPreferLints(cfg, health, adapters);
    expect(lints.some((l) => l.includes("routing seed names dead adapter 'codex' for shape 'implement'"))).toBe(true);
    expect(lints.some((l) => l.includes("cursor-agent"))).toBe(false);
  });

  test("silent when every seed adapter has an authed channel in band", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    const health: Record<string, AuthHealth> = {
      "cursor-agent": {
        installed: true, authed: true, models: ["composer-2.5"],
        modelAuth: { "composer-2.5": { authed: true, probedAt: "2026-07-15T00:00:00.000Z" } },
      },
      codex: {
        installed: true, authed: true, models: ["gpt-5.6-terra"],
        modelAuth: { "gpt-5.6-terra": { authed: true, probedAt: "2026-07-15T00:00:00.000Z" } },
      },
      opencode: {
        installed: true, authed: true, models: ["zai-coding-plan/glm-5.2"],
        modelAuth: { "zai-coding-plan/glm-5.2": { authed: true, probedAt: "2026-07-15T00:00:00.000Z" } },
      },
    };
    expect(seedPreferLints(cfg, health, allAdapters().filter((a) => ["cursor-agent", "codex", "opencode"].includes(a.id)))).toEqual([]);
    expect(modelLints(cfg, health, allAdapters()).some((l) => l.includes("routing seed names dead adapter"))).toBe(false);
  });
});

// v1.54 T3: dead-steering sweep — operator prefer entries that can never match an installed channel.
// Advisory: pure function over config + doctor health; routing behavior is pinned in tests/cli/plan.test.ts.
describe("v1.54 T3 prefer-entry dead-steering sweep", () => {
  // claude-code + codex installed; grok/kimi absent from health = uninstalled
  const health = (): Record<string, AuthHealth> => ({ "claude-code": installed([]), codex: installed([]) });

  test("a review prefer entry naming an uninstalled adapter yields a lint naming the entry", () => {
    const c = cfg();
    c.review.prefer = ["grok:grok-4.5"];
    expect(preferEntryLints(c, health())).toEqual([
      "review.prefer 'grok:grok-4.5' names uninstalled adapter 'grok' — dead steering (entry can never match)",
    ]);
  });

  test("a consult prefer entry naming an uninstalled adapter yields a lint naming the entry", () => {
    const c = cfg();
    c.consult.prefer = ["kimi:kimi-code/k3"];
    expect(preferEntryLints(c, health())).toEqual([
      "consult.prefer 'kimi:kimi-code/k3' names uninstalled adapter 'kimi' — dead steering (entry can never match)",
    ]);
  });

  test("a routing map prefer entry naming an uninstalled adapter yields a lint naming the entry", () => {
    const c = cfg();
    c.routing.map.implement = { prefer: ["grok"] };
    expect(preferEntryLints(c, health(), new Set(["implement"]))).toEqual([
      "routing.map.implement.prefer 'grok' names uninstalled adapter 'grok' — dead steering (entry can never match)",
    ]);
  });

  test("a prefer entry with a model absent from the adapter channels yields a lint naming the entry", () => {
    const c = cfg();
    c.review.prefer = ["codex:gpt-9-nova"];
    expect(preferEntryLints(c, health())).toEqual([
      "review.prefer 'codex:gpt-9-nova' names model 'gpt-9-nova' absent from codex's configured channels — dead steering (entry can never match)",
    ]);
  });

  test("prefer entries matching installed channels yield no lint", () => {
    const c = cfg();
    c.routing.map.implement = { prefer: ["codex:gpt-5.5"] };
    c.review.prefer = ["codex", "claude-code:sonnet"];
    c.consult.prefer = ["claude-code:fable"];
    expect(preferEntryLints(c, health(), new Set(["implement"]))).toEqual([]);
  });

  test("seed map prefers outside the overlay shape set are not swept (seedPreferLints' turf)", () => {
    // default map seeds name cursor-agent/codex/opencode; none installed here — sweep stays silent
    expect(preferEntryLints(cfg(), { "claude-code": installed([]) })).toEqual([]);
  });
});

describe("contextWindowLints — v1.47 T3", () => {
  const task = validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"], context: ["ctx.txt"] }],
  }).tasks[0];

  test("absent windows config produces no lint", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    const lints = contextWindowLints([task], [{ taskId: "T1", adapter: "claude-code", model: "fable" }], cfg, "/tmp");
    expect(lints).toEqual([]);
  });

  test("estimate above declared window produces a lint", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cw-"));
    writeFileSync(join(repo, "ctx.txt"), "x".repeat(20_000));
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers["claude-code"] = { ...cfg.tiers["claude-code"], windows: { fable: 100 } };
    const lints = contextWindowLints([task], [{ taskId: "T1", adapter: "claude-code", model: "fable" }], cfg, repo);
    expect(lints).toHaveLength(1);
    expect(lints[0]).toMatch(/T1: payload ~\d+ tokens exceeds claude-code:fable window 100/);
  });

  test("estimateTaskPayloadTokens counts prompt shell and context bytes", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-est-"));
    writeFileSync(join(repo, "ctx.txt"), "abcd");
    const est = estimateTaskPayloadTokens(task, repo);
    expect(est).toBeGreaterThan(100);
  });
});
