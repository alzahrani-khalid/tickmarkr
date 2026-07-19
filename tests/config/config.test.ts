import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { ConfigError, DEFAULT_CONFIG, TickmarkrConfigSchema, configTemplate, fleetRepoOverlayFromDelta, globalConfigDir, loadConfig, ModelPricingSchema, repoOverlayYaml, serializeFleetOverlay, SubPricingSchema, TIER_RANK, type FleetEditable } from "../../src/config/config.js";

function repoWithOverlay(yaml: string, globalDir?: string) {
  const gDir = globalDir ?? mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return { repo, globalDir: gDir };
}

describe("config", () => {
  test("defaults: seed table sanity", () => {
    expect(DEFAULT_CONFIG.routing.floors.migration).toBe("frontier");
    expect(DEFAULT_CONFIG.routing.map.plan?.pin).toEqual({ via: "claude-code", model: "fable" });
    expect(DEFAULT_CONFIG.tiers["claude-code"].models.fable).toBe("frontier");
    expect(DEFAULT_CONFIG.review.complexityThreshold).toBe(7);
    expect(TIER_RANK.frontier).toBeGreaterThan(TIER_RANK.mid);
  });

  // v1.53 T2: review.prefer — optional ordered reviewer preference (adapter | adapter:model)
  test("review.prefer parses from an overlay and is absent by default", () => {
    expect(DEFAULT_CONFIG.review.prefer).toBeUndefined();
    const { repo, globalDir } = repoWithOverlay("review:\n  prefer: [codex:gpt-5.6-sol, kimi]\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.review.prefer).toEqual(["codex:gpt-5.6-sol", "kimi"]);
    // sibling keys survive the overlay merge
    expect(cfg.review.complexityThreshold).toBe(7);
    expect(cfg.review.required).toBe(true);
  });

  // v1.54 T1: consult.prefer — ranked seat failover; entries MUST be adapter:model (a consult seat
  // has no channel to inherit a model from, so a bare adapter is meaningless and fails fail-closed)
  test("a consult prefer entry without a colon separated model fails config validation", () => {
    expect(DEFAULT_CONFIG.consult.prefer).toBeUndefined();
    const bare = repoWithOverlay("consult:\n  prefer: [claude-code]\n");
    expect(() => loadConfig(bare.repo, { globalDir: bare.globalDir })).toThrow(/adapter:model/);
    // the valid grammar parses; pinned sibling keys survive the overlay merge
    const ok = repoWithOverlay('consult:\n  prefer: ["codex:gpt-5.6-sol", "kimi:kimi-code/k3"]\n');
    const cfg = loadConfig(ok.repo, { globalDir: ok.globalDir });
    expect(cfg.consult.prefer).toEqual(["codex:gpt-5.6-sol", "kimi:kimi-code/k3"]);
    expect(cfg.consult.adapter).toBe("claude-code");
    expect(cfg.consult.model).toBe("fable");
  });

  test("routing rejects unverified models unless an overlay opts into legacy behavior", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  allowUnverifiedModels: true\n");

    expect(DEFAULT_CONFIG.routing.allowUnverifiedModels).toBe(false);
    expect(loadConfig(repo, { globalDir }).routing.allowUnverifiedModels).toBe(true);
  });

  test("MODEL-10: cursor-agent grok xhigh seeds retired; composer-2.5 + native grok seeds survive", () => {
    const cursor = DEFAULT_CONFIG.tiers["cursor-agent"].models;
    expect("grok-4.5-xhigh" in cursor).toBe(false);
    expect("grok-4.5-fast-xhigh" in cursor).toBe(false);
    expect(cursor["composer-2.5"]).toBe("mid"); // sibling seed survives
    // native grok adapter is a DIFFERENT channel — seeds untouched (v1.25 T3 re-scope)
    const grok = DEFAULT_CONFIG.tiers.grok.models;
    expect(grok["grok-4.5"]).toBe("mid");
    expect(grok["grok-composer-2.5-fast"]).toBe("cheap");
  });

  // MODEL-10 overlay-dedup: re-adding grok- lines to .tickmarkr/config.yaml reddens this.
  test("MODEL-10: repo overlay must not duplicate grok seeds", () => {
    const overlay = join(process.cwd(), ".tickmarkr", "config.yaml");
    if (!existsSync(overlay)) return; // gitignored — absent on fresh clones/CI
    const yaml = readFileSync(overlay, "utf8");
    expect(yaml).not.toMatch(/^\s*grok-/m);
  });

  // HYG-06 (v1.12): this test MUST NOT pin operator-local overlay VALUES. It previously asserted
  // `taskTimeoutMinutes === 15` and an exact `setup` string read from the live `.tickmarkr/config.yaml` —
  // so an operator raising their own timeout reddened tickmarkr's suite, and it did: the v1.12
  // 15→35 raise failed the P42 run's test gate for a reason unrelated to the worker's code, burning
  // three attempts (the gate's fingerprint details never named this test, so the worker and the consult
  // both chased benign stdout instead). A test may assert what the SOURCE guarantees (DEFAULT_CONFIG
  // resolution surviving the overlay); it may never assert what the OPERATOR happens to have configured.
  test("MODEL-10: loadConfig keeps cursor xhigh retired + native grok seeds after overlay dedup", () => {
    const overlay = join(process.cwd(), ".tickmarkr", "config.yaml");
    if (!existsSync(overlay)) return;
    const cfg = loadConfig(process.cwd());
    const cursor = cfg.tiers["cursor-agent"].models;
    expect("grok-4.5-xhigh" in cursor).toBe(false);
    expect("grok-4.5-fast-xhigh" in cursor).toBe(false);
    expect(cursor["composer-2.5"]).toBe("mid");
    expect(cfg.tiers.grok.models["grok-4.5"]).toBe("mid");
    expect(cfg.tiers.grok.models["grok-composer-2.5-fast"]).toBe("cheap");
    // the overlay must still LOAD (a malformed one throws) and its keys must resolve to the right TYPES —
    // never to operator-chosen literals.
    expect(typeof cfg.taskTimeoutMinutes).toBe("number");
    expect(cfg.taskTimeoutMinutes).toBeGreaterThan(0);
  });

  test("repo overlay wins over global, global over defaults; deep merge", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    writeFileSync(join(globalDir, "config.yaml"), "concurrency: 5\nrouting:\n  floors:\n    docs: mid\n");
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "concurrency: 2\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.concurrency).toBe(2); // repo wins
    expect(cfg.routing.floors.docs).toBe("mid"); // global overlay applied
    expect(cfg.routing.floors.migration).toBe("frontier"); // defaults survive deep merge
  });

  test("missing files → pure defaults", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    expect(loadConfig(repo, { globalDir })).toEqual(DEFAULT_CONFIG);
  });

  test("loadConfig never reads legacy global config even when it exists and the tickmarkr dir is absent", () => {
    const xdg = mkdtempSync(join(tmpdir(), "tickmarkr-xdg-"));
    const legacyDir = join(xdg, ["dro","vr"].join(""));
    const tickmarkrDir = join(xdg, "tickmarkr");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.yaml"), "concurrency: 9\n");
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      expect(existsSync(tickmarkrDir)).toBe(false);
      expect(globalConfigDir()).toBe(tickmarkrDir);
      expect(loadConfig(repo).concurrency).toBe(DEFAULT_CONFIG.concurrency);
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("v1.1 visibility + overlay tombstones", () => {
  test("defaults: LLM calls run headless, kept until run end; workers interactive", () => {
    // VIS-09 item 2: workersPerTab:3 joins the visibility object (cap concurrent worker panes per tab).
    expect(DEFAULT_CONFIG.visibility).toEqual({ llm: "headless", keepPanes: "run", worker: "interactive", workersPerTab: 3 });
  });

  test("v1.2 overlay: worker print opt-out merges without touching siblings", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "visibility:\n  worker: print\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.visibility.worker).toBe("print");
    expect(cfg.visibility.llm).toBe("headless");
    expect(cfg.visibility.keepPanes).toBe("run");
  });

  test("overlay null tombstone removes a seed model id; siblings survive", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(
      join(repo, ".tickmarkr", "config.yaml"),
      "tiers:\n  codex:\n    models:\n      gpt-5.6-luna: null\n      gpt-5.5-turbo: frontier\n",
    );
    const cfg = loadConfig(repo, { globalDir });
    expect("gpt-5.6-luna" in cfg.tiers.codex.models).toBe(false);
    expect(cfg.tiers.codex.models["gpt-5.5-turbo"]).toBe("frontier");
    expect(cfg.tiers.codex.models["gpt-5.6-terra"]).toBe("mid"); // untouched sibling survives
  });

  test("an empty overlay file still yields pure defaults (top-level null is not a tombstone)", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "# nothing here\n");
    expect(loadConfig(repo, { globalDir })).toEqual(DEFAULT_CONFIG);
  });
});

describe("TickmarkrConfigSchema validation", () => {
  test("DEFAULT_CONFIG parses and loadConfig round-trips defaults", () => {
    expect(TickmarkrConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    expect(() => loadConfig(repo, { globalDir })).not.toThrow();
    expect(loadConfig(repo, { globalDir })).toEqual(DEFAULT_CONFIG);
  });

  test("bad tier value throws ConfigError naming frontierr and tiers path", () => {
    const { repo, globalDir } = repoWithOverlay(
      "tiers:\n  codex:\n    models:\n      gpt-5.2: frontierr\n",
    );
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("frontierr");
      expect(msg).toMatch(/tiers\.codex\.models/);
    }
  });

  test("invalid driver throws ConfigError naming driver", () => {
    const { repo, globalDir } = repoWithOverlay("driver: podman\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      expect((e as ConfigError).message).toContain("driver");
    }
  });

  test("invalid channel throws ConfigError naming channel", () => {
    const { repo, globalDir } = repoWithOverlay("tiers:\n  codex:\n    channel: grpc\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      expect((e as ConfigError).message).toContain("channel");
    }
  });

  test("invalid visibility.llm throws ConfigError naming llm", () => {
    const { repo, globalDir } = repoWithOverlay("visibility:\n  llm: verbose\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      expect((e as ConfigError).message).toContain("llm");
    }
  });

  test.each([
    ["a b", "space"],
    ["../evil", ".."],
    ["/leading", "leading slash"],
    ["tickmarkr/'; rm -rf ~ #", "single quote"],
  ])("integrationBranchPrefix %s (%s) throws ConfigError", (prefix) => {
    const { repo, globalDir } = repoWithOverlay(`integrationBranchPrefix: "${prefix}"\n`);
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });

  test.each(["tickmarkr/", "feat/x/"])("integrationBranchPrefix %s is accepted", (prefix) => {
    const { repo, globalDir } = repoWithOverlay(`integrationBranchPrefix: "${prefix}"\n`);
    expect(loadConfig(repo, { globalDir }).integrationBranchPrefix).toBe(prefix);
  });

  // drill: removing zod validation or accepting non-numeric halfLifeRuns reddens oracle (c).
  test("ROUTE-15: non-numeric learnedTuning.halfLifeRuns throws ConfigError", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  learnedTuning:\n    halfLifeRuns: fast\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });

  test("ROUTE-15: halfLifeRuns ≤ 0 throws ConfigError", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  learnedTuning:\n    halfLifeRuns: 0\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });

  test("ROUTE-15: valid learnedTuning overlay merges without touching siblings", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  learnedTuning:\n    halfLifeRuns: 3\n    availWeight: 0.1\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.learnedTuning).toEqual({ halfLifeRuns: 3, availWeight: 0.1 });
    expect(cfg.routing.learned).toBe("on");
  });

  // v1.52 T5: map-entry tier removed as a band authority — routing.floors is the only tier source.
  test("a map entry carrying a tier value fails config load naming the floors key", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  map:\n    migration:\n      tier: frontier\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      expect((e as ConfigError).message).toContain("routing.floors");
    }
  });

  test("a tier null tombstone parses and is stripped without error", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  map:\n    implement:\n      tier: null\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.map.implement?.tier).toBeUndefined();
    expect(cfg.routing.map.implement?.prefer).toEqual(DEFAULT_CONFIG.routing.map.implement?.prefer);
  });
});

describe("per-shape gate participation", () => {
  test("acceptance/review participation is optional per known shape", () => {
    const { repo, globalDir } = repoWithOverlay("gates:\n  byShape:\n    docs:\n      acceptance: false\n      review: false\n");
    expect(loadConfig(repo, { globalDir }).gates).toMatchObject({ byShape: { docs: { acceptance: false, review: false } } });
  });

  test.each([["baseline", "baseline"], ["build", "baseline"], ["evidence", "evidence"], ["scope", "scope"]])("%s is rejected as a %s invariant", (gate, invariant) => {
    const { repo, globalDir } = repoWithOverlay(`gates:\n  byShape:\n    docs:\n      ${gate}: false\n`);
    expect(() => loadConfig(repo, { globalDir })).toThrow(new RegExp(invariant));
  });

  test("no byShape keeps the default gates object byte-identical", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    expect(loadConfig(repo, { globalDir }).gates).toEqual(DEFAULT_CONFIG.gates);
  });
});

describe("LLM gate diff cap", () => {
  test("defaults to 60000 and is documented in the config template", () => {
    expect(DEFAULT_CONFIG.gates.diffCap).toBe(60_000);
    expect(configTemplate()).toContain("diffCap: 60000");
  });

  test("a positive integer overlay replaces the default", () => {
    const { repo, globalDir } = repoWithOverlay("gates:\n  diffCap: 12345\n");
    expect(loadConfig(repo, { globalDir }).gates.diffCap).toBe(12_345);
  });

  test.each(["0", "-1", "1.5"])("diffCap %s is rejected", (diffCap) => {
    const { repo, globalDir } = repoWithOverlay(`gates:\n  diffCap: ${diffCap}\n`);
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });
});

describe("FLEET-06 config schema (V-9)", () => {
  test("V-9a: malformed deny.adapters (string not array) throws ConfigError", () => {
    const { repo, globalDir } = repoWithOverlay("routing:\n  deny:\n    adapters: codex\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
    try {
      loadConfig(repo, { globalDir });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
    }
  });

  test("V-9b: repo deny: null tombstone removes global deny", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    writeFileSync(join(globalDir, "config.yaml"), "routing:\n  deny:\n    adapters: [codex]\n");
    const { repo } = repoWithOverlay("routing:\n  deny: null\n", globalDir);
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.deny).toBeUndefined();
  });

  test("well-formed allow/deny blocks parse and land on cfg.routing", () => {
    const { repo, globalDir } = repoWithOverlay(
      "routing:\n  allow:\n    adapters: [claude-code]\n  deny:\n    models: [codex:gpt-5.5]\n",
    );
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.allow).toEqual({ adapters: ["claude-code"] });
    expect(cfg.routing.deny).toEqual({ models: ["codex:gpt-5.5"] });
  });

  test("pure defaults: routing.allow and routing.deny are undefined", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.routing.allow).toBeUndefined();
    expect(cfg.routing.deny).toBeUndefined();
    expect(DEFAULT_CONFIG.routing.allow).toBeUndefined();
    expect(DEFAULT_CONFIG.routing.deny).toBeUndefined();
  });

  test("configTemplate documents allow/deny grammar", () => {
    const t = configTemplate();
    expect(t).toContain("allow");
    expect(t).toContain("deny");
    expect(t).toContain("adapter:model");
  });
});

// VIS-09 item 2 (43-CONTEXT D-03): visibility.workersPerTab — cap concurrent worker panes per WORKERS
// tab; the cap+1'th member overflows to WORKERS-2. Positive int, default 3, overlay-omittable.
describe("VIS-09 workersPerTab config key", () => {
  test("default is 3 and round-trips through the schema", () => {
    expect(DEFAULT_CONFIG.visibility.workersPerTab).toBe(3);
    expect(TickmarkrConfigSchema.parse(DEFAULT_CONFIG).visibility.workersPerTab).toBe(3);
  });

  test("overlay overriding it parses and lands on cfg.visibility", () => {
    const { repo, globalDir } = repoWithOverlay("visibility:\n  workersPerTab: 2\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.visibility.workersPerTab).toBe(2);
    expect(cfg.visibility.llm).toBe("headless"); // sibling keys survive the merge
  });

  test("overlay OMITTING it still parses (deepMerge over DEFAULT_CONFIG → 3)", () => {
    const { repo, globalDir } = repoWithOverlay("visibility:\n  worker: print\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.visibility.workersPerTab).toBe(3); // old overlay files keep working
    expect(cfg.visibility.worker).toBe("print");
  });

  test("zero is rejected by the schema (positive int)", () => {
    const { repo, globalDir } = repoWithOverlay("visibility:\n  workersPerTab: 0\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });

  test("negative is rejected by the schema (positive int)", () => {
    const { repo, globalDir } = repoWithOverlay("visibility:\n  workersPerTab: -1\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });

  test("configTemplate carries a commented workersPerTab example", () => {
    expect(configTemplate()).toContain("workersPerTab");
  });
});

// v1.20 REC-02: optional detailed price table for the usage/cost report. Absent pricing ⇒ the estimator
// reports "not measurable" — never a crash or a fake $0. Distinct from the legacy `pricing` tier map.
describe("REC-02 cost pricing config", () => {
  test("DEFAULT_CONFIG ships WITHOUT cost (absent ⇒ not measurable)", () => {
    expect("cost" in DEFAULT_CONFIG).toBe(false);
    expect(TickmarkrConfigSchema.parse(DEFAULT_CONFIG).cost).toBeUndefined();
  });

  test("pure defaults round-trip with cost absent (no regression to equal(DEFAULT_CONFIG))", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
    const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
    expect(loadConfig(repo, { globalDir })).toEqual(DEFAULT_CONFIG);
  });

  test("ModelPricing accepts in/out + optional cacheRead + optional rateDate", () => {
    expect(ModelPricingSchema.parse({ inPerMtok: 5, outPerMtok: 25 })).toEqual({ inPerMtok: 5, outPerMtok: 25 });
    expect(ModelPricingSchema.parse({ inPerMtok: 5, outPerMtok: 25, cacheReadPerMtok: 0.5, rateDate: "2026-07-13" })).toEqual(
      { inPerMtok: 5, outPerMtok: 25, cacheReadPerMtok: 0.5, rateDate: "2026-07-13" },
    );
    // negative rate is invalid (money never negative)
    expect(() => ModelPricingSchema.parse({ inPerMtok: -1, outPerMtok: 25 })).toThrow();
  });

  test("SubPricing requires positive ints and low ≤ high", () => {
    expect(SubPricingSchema.parse({ planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 })).toEqual(
      { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 },
    );
    // inverted range is rejected (loud, never a silent negative amortized range)
    expect(() =>
      SubPricingSchema.parse({ planMonthly: 200, windowsPerMonthLow: 1200, windowsPerMonthHigh: 400 }),
    ).toThrow();
    expect(() => SubPricingSchema.parse({ planMonthly: 0, windowsPerMonthLow: 1, windowsPerMonthHigh: 1 })).toThrow();
  });

  test("cost overlay merges and lands on cfg.cost", () => {
    const { repo, globalDir } = repoWithOverlay(
      "cost:\n  models:\n    opus: { inPerMtok: 5.0, outPerMtok: 25.0, rateDate: 2026-07-13 }\n  subs:\n    claude-code: { planMonthly: 200, windowsPerMonthLow: 400, windowsPerMonthHigh: 1200 }\n",
    );
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.cost?.models?.opus).toEqual({ inPerMtok: 5, outPerMtok: 25, rateDate: "2026-07-13" });
    expect(cfg.cost?.subs?.["claude-code"]?.planMonthly).toBe(200);
  });

  test("a partial cost overlay (models only) parses with subs undefined", () => {
    const { repo, globalDir } = repoWithOverlay("cost:\n  models:\n    opus: { inPerMtok: 5, outPerMtok: 25 }\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.cost?.models?.opus?.outPerMtok).toBe(25);
    expect(cfg.cost?.subs).toBeUndefined();
  });

  test("malformed cost entry throws ConfigError (fail loud, not silent not-measurable)", () => {
    const { repo, globalDir } = repoWithOverlay("cost:\n  models:\n    opus: { inPerMtok: free }\n");
    expect(() => loadConfig(repo, { globalDir })).toThrow(ConfigError);
  });

  test("configTemplate seeds a commented pricing block with dated rates + LiteLLM source", () => {
    const t = configTemplate();
    expect(t).toContain("cost:");
    expect(t).toContain("inPerMtok");
    expect(t).toContain("outPerMtok");
    expect(t).toContain("cacheReadPerMtok");
    expect(t).toContain("windowsPerMonthLow");
    expect(t).toContain("planMonthly");
    // dated example rate
    expect(t).toContain("2026-07-13");
    // names the LiteLLM price JSON as the copy-from source
    expect(t).toContain("model_prices_and_context_window.json");
    expect(t).toContain("litellm");
    // states the not-measurable rule
    expect(t).toMatch(/not measurable/i);
  });
});

// v1.47 ship: src/config branch coverage fell to 86% < 90% CI threshold (OBS-66) — the fleet
// delta/serialize helpers and the byShape refine messages shipped with untested branches.
describe("byShape refine messages (both branches)", () => {
  const withByShape = (entry: Record<string, unknown>) =>
    TickmarkrConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      gates: { ...DEFAULT_CONFIG.gates, byShape: { implement: entry } },
    });

  test("a mandatory invariant gate in byShape names the invariant", () => {
    const r = withByShape({ baseline: false });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("mandatory fail-closed gate invariant");
  });

  test("a non-invariant extra gate in byShape names the allowed pair", () => {
    const r = withByShape({ frobnicate: false });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("may configure only acceptance and review");
  });
});

describe("fleetRepoOverlayFromDelta branches", () => {
  const fe = (over: Partial<FleetEditable> = {}): FleetEditable => ({
    denyAdapters: [], denyModels: [], tiers: {}, map: {}, floors: {}, ...over,
  });

  test("equal editables produce an empty fragment", () => {
    expect(fleetRepoOverlayFromDelta(fe(), fe())).toEqual({});
  });

  // v1.52 T5: map entries can no longer carry a tier (routing.floors is the only band authority),
  // so this generic delta-merge check uses `escalate` as its stand-in field instead.
  test("map delta merges over an existing repo routing map", () => {
    const out = fleetRepoOverlayFromDelta(
      fe(),
      fe({ map: { implement: { escalate: false } } }),
      { routing: { map: { migration: { escalate: true } } } },
    );
    const map = (out.routing as { map: Record<string, unknown> }).map;
    expect(map.migration).toEqual({ escalate: true });
    expect(map.implement).toEqual({ escalate: false });
  });

  test("floors delta merges over existing repo floors", () => {
    const out = fleetRepoOverlayFromDelta(
      fe(),
      fe({ floors: { implement: "mid" } }),
      { routing: { floors: { migration: "frontier" } } },
    );
    const floors = (out.routing as { floors: Record<string, string> }).floors;
    expect(floors).toEqual({ migration: "frontier", implement: "mid" });
  });

  test("adding a deny writes the list and clearing writes a null tombstone", () => {
    const added = fleetRepoOverlayFromDelta(fe(), fe({ denyModels: ["pi:zai/glm-5.2"] }));
    expect((added.routing as { deny: { models: string[] } }).deny.models).toEqual(["pi:zai/glm-5.2"]);
    const cleared = fleetRepoOverlayFromDelta(fe({ denyModels: ["pi:zai/glm-5.2"] }), fe());
    expect((cleared.routing as { deny: { models: null } }).deny.models).toBeNull();
  });

  test("tier change and removal merge over an existing repo tiers entry", () => {
    const out = fleetRepoOverlayFromDelta(
      fe({ tiers: { pi: { "m-old": { tier: "mid" }, "m-gone": { tier: "cheap" } } } }),
      fe({ tiers: { pi: { "m-old": { tier: "frontier" } } } }),
      { tiers: { pi: { models: { "m-keep": "mid" } } } },
    );
    const models = (out.tiers as Record<string, { models: Record<string, unknown> }>).pi.models;
    expect(models["m-keep"]).toBe("mid");
    expect(models["m-old"]).toBe("frontier");
    expect(models["m-gone"]).toBeNull();
  });
});

describe("repoOverlayYaml combinations", () => {
  test("an empty overlay serializes to an empty string", () => {
    expect(repoOverlayYaml({})).toBe("");
  });

  test("a fleet-only overlay serializes the fleet body alone", () => {
    const y = repoOverlayYaml({ routing: { deny: { models: ["x:y"] } } });
    expect(y).toContain("routing:");
    expect(y).not.toContain("concurrency");
  });

  test("a rest-only overlay serializes the head alone", () => {
    const y = repoOverlayYaml({ concurrency: 2 });
    expect(y).toContain("concurrency: 2");
    expect(y).not.toContain("routing:");
  });

  test("a mixed overlay serializes head then fleet body", () => {
    const y = repoOverlayYaml({ concurrency: 2, routing: { floors: { implement: "mid" } } });
    expect(y.indexOf("concurrency: 2")).toBeLessThan(y.indexOf("routing:"));
  });

  // v1.54 T4: review/consult prefer lists ride the non-fleet passthrough of the fleet write path
  test("a written overlay carrying prefer lists round trips through serialize and parse to deep equality", () => {
    const overlay = {
      routing: { floors: { plan: "frontier" } },
      review: { complexityThreshold: 9, prefer: ["codex:gpt-5.6-sol", "kimi"] },
      consult: { prefer: ["kimi:kimi-code/k3", "codex:gpt-5.6-sol"] },
    };
    expect(parse(repoOverlayYaml(overlay))).toEqual(overlay);
  });
});

// OBS-75: a fleet write re-serializes the ENTIRE overlay, so the serializer must emit YAML its
// own loader accepts — proven here by round-tripping every fleet-editable field, not by
// enumerating the three catalogued byte-level defects.
describe("OBS-75 fleet serializer round-trip", () => {
  test("a deny models list round-trips through serialize then parse", () => {
    const overlay = { routing: { deny: { adapters: ["grok"], models: ["pi:zai/glm-5.2", "codex:gpt-5.5"] } } };
    expect(parse(serializeFleetOverlay(overlay))).toEqual(overlay);
  });

  test("floors round-trip through serialize then parse as a block map", () => {
    const overlay = { routing: { floors: { ui: "frontier", implement: "mid" } } };
    const y = serializeFleetOverlay(overlay);
    expect(y).toMatch(/^ {2}floors:$/m); // key line carries no glued compact map
    expect(y).toMatch(/^ {4}ui: frontier$/m);
    expect(parse(y)).toEqual(overlay);
  });

  test("an adapter entry with no model changes writes no empty models header", () => {
    const overlay = { tiers: { kimi: { vendor: "moonshot", channel: "sub" } } };
    const y = serializeFleetOverlay(overlay);
    expect(y).not.toContain("models:");
    expect(parse(y)).toEqual(overlay);
  });

  test("every fleet-editable field round-trips serialize then parse then deep-equal", () => {
    // built through the real edit machinery: every FleetEditable field changed, including
    // removals (deny cleared elsewhere → null tombstones; a tier assignment dropped → model null)
    const initial: FleetEditable = {
      denyAdapters: [], denyModels: [],
      tiers: { kimi: { "kimi-code/old": { tier: "mid" } } },
      map: {}, floors: { implement: "mid" },
    };
    const edited: FleetEditable = {
      denyAdapters: ["grok"], denyModels: ["pi:zai/glm-5.2"],
      tiers: { kimi: { "kimi-code/k3": { tier: "frontier" } } },
      map: { implement: { prefer: ["cursor-agent", "codex"] }, plan: { pin: { via: "claude-code", model: "fable" } } },
      floors: { implement: "frontier", tests: "cheap" },
    };
    const overlay = fleetRepoOverlayFromDelta(initial, edited);
    const y = serializeFleetOverlay(overlay, { kimi: { "kimi-code/k3": "probed frontier" } });
    expect(parse(y)).toEqual(overlay);

    // clearing both deny lists writes null tombstones that survive the round-trip
    const cleared = fleetRepoOverlayFromDelta(edited, { ...edited, denyAdapters: [], denyModels: [] });
    expect(parse(serializeFleetOverlay(cleared))).toEqual(cleared);
  });

  test("the serializer output for any fleet-editable overlay is accepted by the config loader", () => {
    // one overlay carrying all three OBS-75 defect classes at once: deny lists + floors + a
    // model-less adapter entry — plus tombstones and provenance comments
    const overlay = {
      routing: {
        deny: { adapters: null, models: ["pi:zai/glm-5.2"] },
        map: { implement: { prefer: ["cursor-agent"] } },
        floors: { ui: "frontier", tests: "cheap" },
      },
      tiers: {
        kimi: { vendor: "moonshot", channel: "sub" },
        codex: { models: { "gpt-5.5": "frontier", "gpt-5.6-luna": null } },
      },
    };
    const y = serializeFleetOverlay(overlay, { codex: { "gpt-5.5": "probed frontier" } });
    const { repo, globalDir } = repoWithOverlay(y);
    const cfg = loadConfig(repo, { globalDir }); // a rejected overlay throws ConfigError here
    expect(cfg.routing.deny?.models).toEqual(["pi:zai/glm-5.2"]);
    expect(cfg.routing.floors.ui).toBe("frontier");
    expect(cfg.routing.map.implement).toEqual({ prefer: ["cursor-agent"] });
    expect("gpt-5.6-luna" in cfg.tiers.codex.models).toBe(false); // null tombstone applied
    expect(cfg.tiers.codex.models["gpt-5.5"]).toBe("frontier");
    expect(cfg.tiers.kimi.models["kimi-code/k3"]).toBe("frontier"); // default seeds survive the model-less entry
  });
});
