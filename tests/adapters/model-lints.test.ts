import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { allAdapters, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { MODEL_STALE_DAYS, SEED_STAMPED, contextWindowLints, estimateTaskPayloadTokens, hasWindowsConfig, modelLints, preferEntryLints, seedPreferLints, suggestOverlay } from "../../src/adapters/model-lints.js";
import { CITED_MODEL_WINDOWS } from "../../src/adapters/model-windows.js";
import { compileSource } from "../../src/compile/index.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import { readyTasks, setStatus } from "../../src/graph/graph.js";
import type { RunGraph } from "../../src/graph/schema.js";
import { validateGraph } from "../../src/graph/schema.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { makeRepo } from "../helpers/tmprepo.js";

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
    expect(lints).toContain(
      "routing seed names dead adapter 'codex' for shape 'implement' — no declared preference overrides it",
    );
    expect(lints.some((l) => l.includes("auto-prefer"))).toBe(false);
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
  const taskWithContext = (id: string, context: string) => validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id, title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"], context: [context] }],
  }).tasks[0];
  const task = taskWithContext("T1", "ctx.txt");

  test("absent windows config produces no lint", () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    for (const entry of Object.values(cfg.tiers)) delete entry.windows;
    const lints = contextWindowLints([task], [{ taskId: "T1", adapter: "claude-code", model: "fable" }], cfg, "/tmp");
    expect(lints).toEqual([]);
  });

  test("estimate above declared window produces a lint", () => {
    const repo = makeRepo({ "ctx.txt": "x".repeat(20_000) });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.tiers["claude-code"] = { ...cfg.tiers["claude-code"], windows: { fable: 100 } };
    const lints = contextWindowLints([task], [{ taskId: "T1", adapter: "claude-code", model: "fable" }], cfg, repo);
    expect(lints).toHaveLength(1);
    expect(lints[0]).toMatch(/T1: payload ~\d+ tokens exceeds claude-code:fable window 100/);
  });

  test("estimateTaskPayloadTokens counts prompt shell and context bytes", () => {
    const repo = makeRepo({ "ctx.txt": "abcd" });
    const est = estimateTaskPayloadTokens(task, repo);
    expect(est).toBeGreaterThan(100);
  });

  test("operator model windows remain configurable without being mistaken for seeded claims", () => {
    const { repo, globalDir } = emptyRepo();
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), [
      "tiers:",
      "  fake:",
      "    vendor: fake",
      "    channel: sub",
      "    models:",
      "      fake-1: mid",
      "    windows:",
      "      fake-1: 500",
      "",
    ].join("\n"));

    const loaded = loadConfig(repo, { globalDir });
    expect(loaded.tiers.fake.windows?.["fake-1"]).toBe(500);
    expect(hasWindowsConfig(loaded)).toBe(true);
  });

  test("fileBytes distinguishes absent from empty, proven over the closed set of path states — an absent fixture, a zero-byte tracked fixture, a non-empty tracked fixture, an untracked-but-present fixture, and a glob fixture that stays unmeasurable", () => {
    const repo = makeRepo({ "zero.txt": "", "full.txt": "x".repeat(400) });
    writeFileSync(join(repo, "live.txt"), "checkout only");

    const absent = estimateTaskPayloadTokens(taskWithContext("T1", "gone.txt"), repo);
    const empty = estimateTaskPayloadTokens(taskWithContext("T1", "zero.txt"), repo);
    const nonEmpty = estimateTaskPayloadTokens(taskWithContext("T1", "full.txt"), repo);
    const untracked = estimateTaskPayloadTokens(taskWithContext("T1", "live.txt"), repo);
    const glob = estimateTaskPayloadTokens(taskWithContext("T1", "*.md"), repo);

    expect(absent).toBeUndefined();
    expect(empty).toBeTypeOf("number");
    expect(nonEmpty).toBeTypeOf("number");
    expect(nonEmpty!).toBeGreaterThan(empty!);
    expect(untracked).toBeUndefined();
    expect(glob).toBeUndefined();
  });

  test("every model carrying a tier in the seed config also carries a declared window, proven member by member over the installed fleet — a claude-code fixture, a codex fixture, a cursor-agent fixture, an opencode fixture, a pi fixture, a grok fixture and a kimi fixture", () => {
    const installedFleet = {
      "claude-code": ["fable", "opus", "sonnet", "haiku"],
      codex: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"],
      "cursor-agent": ["composer-2.5", "composer-2.5-fast"],
      opencode: ["zai-coding-plan/glm-5.2"],
      pi: ["zai/glm-5.2"],
      grok: ["grok-4.5", "grok-composer-2.5-fast"],
      kimi: ["kimi-code/k3", "kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"],
    } as const;

    for (const [adapter, expectedModels] of Object.entries(installedFleet)) {
      const entry = DEFAULT_CONFIG.tiers[adapter];
      expect(Object.keys(entry.models).sort(), `${adapter} tiered models`).toEqual([...expectedModels].sort());
      expect(Object.keys(entry.windows ?? {}).sort(), `${adapter} declared windows`).toEqual([...expectedModels].sort());
      for (const model of expectedModels) expect(entry.windows?.[model], `${adapter}:${model}`).toBeTypeOf("number");
    }
  });

  test("the context-window lint fires on a task whose measured payload exceeds a declared window and stays silent when the payload fits, with the payload measured against the base tree so an untracked context file contributes zero visible bytes and is reported as unreadable rather than as empty", () => {
    const repo = makeRepo({
      "over.txt": "x".repeat(810_000),
      "fits.txt": "x",
    });
    writeFileSync(join(repo, "untracked.txt"), "x".repeat(810_000));
    const config = structuredClone(DEFAULT_CONFIG);
    const assignment = (taskId: string) => [{ taskId, adapter: "cursor-agent", model: "composer-2.5" }];

    const over = taskWithContext("T-over", "over.txt");
    expect(contextWindowLints([over], assignment(over.id), config, repo)).toEqual([
      expect.stringMatching(/^T-over: payload ~\d+ tokens exceeds cursor-agent:composer-2\.5 window 200000$/),
    ]);

    const fits = taskWithContext("T-fits", "fits.txt");
    expect(contextWindowLints([fits], assignment(fits.id), config, repo)).toEqual([]);

    const unreadable = taskWithContext("T-unreadable", "untracked.txt");
    const lints = contextWindowLints([unreadable], assignment(unreadable.id), config, repo);
    expect(lints).toHaveLength(1);
    expect(lints[0]).toContain("payload unreadable");
    expect(lints[0]).toContain('context "untracked.txt"');
    expect(lints[0]).toContain("not in the base tree");
    expect(lints[0]).toContain("context-window comparison skipped");
    expect(lints[0]).not.toContain("exceeds");
  });

  test("every seeded window is checked in PRODUCTION against T20's vendored table rather than merely being present, proven member by member over the closed set of rejection shapes — a seeded window with no entry in the table, one disagreeing with its table entry, and one below the plausibility floor — each rejected at config load, while a seeded window matching its table entry is accepted", () => {
    const loadSeed = () => {
      const { repo, globalDir } = emptyRepo();
      return loadConfig(repo, { globalDir });
    };
    const matching = CITED_MODEL_WINDOWS.find((claim) => claim.modelId === "fable");
    expect(matching).toBeDefined();

    const entry = DEFAULT_CONFIG.tiers["claude-code"];
    const original = structuredClone(entry.windows!);
    try {
      const rejectionShapes = [
        {
          name: "no table entry",
          mutate: () => { entry.windows!["uncited-fixture"] = 200_000; },
          error: /uncited-fixture.*no cited model-window entry/,
        },
        {
          name: "table disagreement",
          mutate: () => { entry.windows!.fable = 999_999; },
          error: /fable.*999999.*does not match cited window 1000000/,
        },
        {
          name: "below plausibility floor",
          mutate: () => { entry.windows!.fable = 1; },
          error: /fable.*1.*below plausibility floor/,
        },
      ] as const;
      for (const fixture of rejectionShapes) {
        entry.windows = structuredClone(original);
        fixture.mutate();
        expect(() => loadSeed(), fixture.name).toThrow(fixture.error);
      }
      entry.windows = structuredClone(original);
      const accepted = loadSeed();
      expect(accepted.tiers["claude-code"].windows?.fable).toBe(matching!.window);
    } finally {
      entry.windows = original;
    }
  });
});

const ACCEPTANCE = "- acceptance:\n  - command: true\n";

function compileBody(repo: string, body: string): RunGraph {
  const spec = join(repo, "tickmarkr.spec.md");
  writeFileSync(spec, `<!-- tickmarkr:spec -->\n${body}`);
  return compileSource(spec, "native");
}

function oneTask(repo: string, id: string, field: string): RunGraph {
  return compileBody(repo, `## ${id}: Context fixture\n${field}\n${ACCEPTANCE}`);
}

function warningText(): string[] {
  return vi.mocked(console.warn).mock.calls.map(([message]) => String(message));
}

afterEach(() => vi.restoreAllMocks());

test("a context entry whose parenthetical annotation contains a comma survives as one entry and resolves to its path, proven over the closed set of annotation shapes — a one-comma fixture, a two-comma fixture, a nested-paren fixture, and a brace-glob fixture whose commas still split as OBS-97 requires", () => {
  const repo = makeRepo({
    "ctx/cited.md": "cited\n",
    "ctx/other.md": "other\n",
  });
  const fixtures = [
    {
      name: "one comma",
      value: "ctx/cited.md (OBS-1, OBS-2), ctx/other.md",
      expected: ["ctx/cited.md", "ctx/other.md"],
    },
    {
      name: "two commas",
      value: "ctx/cited.md (OBS-1, OBS-2, OBS-3), ctx/other.md",
      expected: ["ctx/cited.md", "ctx/other.md"],
    },
    {
      name: "nested parens",
      value: "ctx/cited.md (ruling (OBS-1, OBS-2), section 3), ctx/other.md",
      expected: ["ctx/cited.md", "ctx/other.md"],
    },
    {
      name: "brace glob",
      value: "src/{compile,adapters}/**/*.ts (OBS-1, OBS-2), ctx/other.md",
      expected: ["src/{compile,adapters}/**/*.ts", "ctx/other.md"],
    },
  ] as const;

  for (const fixture of fixtures) {
    const graph = oneTask(repo, "T1", `- context: ${fixture.value}`);
    expect(graph.tasks[0].context, fixture.name).toEqual(fixture.expected);
  }
});

test("every context entry is classified against the base tree rather than the orchestrator checkout, proven member by member over the closed set — an untracked-but-present fixture, a staged-uncommitted fixture, a tracked fixture, and an absent fixture — with the untracked and staged cases both reported invisible", () => {
  const repo = makeRepo({ "tracked.md": "in HEAD\n" });
  writeFileSync(join(repo, "untracked.md"), "checkout only\n");
  writeFileSync(join(repo, "staged.md"), "index only\n");
  execFileSync("git", ["-C", repo, "add", "-f", "staged.md"]);

  const tree = execFileSync("git", ["-C", repo, "ls-tree", "--full-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" })
    .trim().split("\n");
  expect(tree).toContain("tracked.md");
  expect(tree).not.toContain("untracked.md");
  expect(tree).not.toContain("staged.md");

  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(oneTask(repo, "T1", "- context: untracked.md").tasks[0].context).toEqual(["untracked.md"]);
  expect(oneTask(repo, "T2", "- context: staged.md").tasks[0].context).toEqual(["staged.md"]);
  expect(oneTask(repo, "T3", "- context: tracked.md").tasks[0].context).toEqual(["tracked.md"]);
  expect(() => oneTask(repo, "T4", "- context: absent.md")).toThrow(/T4[\s\S]*absent\.md/);

  const invisible = warningText().filter((line) => line.includes("NOT in a worker's worktree"));
  expect(invisible).toHaveLength(2);
  expect(invisible.some((line) => line.includes('context "untracked.md"'))).toBe(true);
  expect(invisible.some((line) => line.includes('context "staged.md"'))).toBe(true);
  expect(invisible.some((line) => line.includes('context "tracked.md"'))).toBe(false);
});

test("the absent-versus-untracked disposition is complete over the closed set of base-tree outcomes — an entry absent everywhere fails compile naming the task and the entry, an entry whose basename matches exactly one tracked path fails compile naming that path as the suggested repair, an untracked-but-present entry warns and never fails compile, and a spec whose only defect is an untracked entry still compiles to a graph", () => {
  const repo = makeRepo({ "notes/UNIQUE.md": "tracked repair target\n" });
  writeFileSync(join(repo, "scratch.md"), "present outside HEAD\n");
  vi.spyOn(console, "warn").mockImplementation(() => {});

  expect(() => oneTask(repo, "T1", "- context: nowhere.md"))
    .toThrow(/T1[\s\S]*nowhere\.md/);
  expect(() => oneTask(repo, "T2", "- context: UNIQUE.md"))
    .toThrow(/T2[\s\S]*UNIQUE\.md[\s\S]*did you mean notes\/UNIQUE\.md/);

  let graph: RunGraph | undefined;
  expect(() => { graph = oneTask(repo, "T3", "- context: scratch.md"); }).not.toThrow();
  expect(graph?.tasks.map((task) => task.id)).toEqual(["T3"]);
  const untracked = warningText().filter((line) => line.includes('context "scratch.md"'));
  expect(untracked).toHaveLength(1);
  expect(untracked[0]).toContain("git add -f scratch.md && git commit");
});

test("a wrapped list is read whole rather than truncated to its first physical line, proven over the closed set of continuation-carrying fields CROSSED WITH wrap depth — files, context and deps, each as a single-line fixture, a two-line-wrapped fixture and a three-line-wrapped fixture — with an absent context entry on a continuation line still failing compile and a continuation-only dependency whose loss would change graph reachability still ordering its task", () => {
  const repo = makeRepo({
    "src/a.ts": "export {};\n",
    "tests/a.test.ts": "export {};\n",
    "docs/a.md": "docs\n",
    "ctx/a.md": "a\n",
    "ctx/b.md": "b\n",
    "ctx/c.md": "c\n",
  });
  const values = {
    files: ["src/a.ts", "tests/a.test.ts", "docs/a.md"],
    context: ["ctx/a.md", "ctx/b.md", "ctx/c.md"],
    deps: ["T1", "T2", "T3"],
  } as const;
  const wrapped = (field: keyof typeof values, depth: 1 | 2 | 3): string => {
    const entries = values[field];
    if (depth === 1) return `- ${field}: ${entries.join(", ")}`;
    if (depth === 2) return `- ${field}: ${entries[0]}, ${entries[1]},\n  ${entries[2]}`;
    return `- ${field}: ${entries[0]},\n  ${entries[1]},\n  ${entries[2]}`;
  };
  const dependencyPreamble = ["T1", "T2", "T3"]
    .map((id) => `## ${id}: Dependency ${id}\n${ACCEPTANCE}`)
    .join("\n");

  for (const field of ["files", "context", "deps"] as const) {
    for (const depth of [1, 2, 3] as const) {
      const prefix = field === "deps" ? dependencyPreamble : "";
      const graph = compileBody(repo, `${prefix}## T4: ${field} depth ${depth}\n${wrapped(field, depth)}\n${ACCEPTANCE}`);
      expect(graph.tasks.find((task) => task.id === "T4")?.[field], `${field} depth ${depth}`)
        .toEqual(values[field]);
    }
  }

  expect(() => oneTask(repo, "T5", "- context: ctx/a.md,\n  absent-on-continuation.md"))
    .toThrow(/T5[\s\S]*absent-on-continuation\.md/);

  const ordered = compileBody(repo, [
    `## T1: Root\n${ACCEPTANCE}`,
    `## T2: Middle\n- deps: T1\n${ACCEPTANCE}`,
    `## T3: Ordered consumer\n- deps: T1,\n  T2\n${ACCEPTANCE}`,
  ].join("\n"));
  const afterRoot = setStatus(ordered, "T1", "done");
  expect(ordered.tasks.find((task) => task.id === "T3")?.deps).toEqual(["T1", "T2"]);
  expect(readyTasks(afterRoot).map((task) => task.id)).toEqual(["T2"]);
});
