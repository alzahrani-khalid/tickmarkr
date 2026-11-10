// Queue row 367 Phase 1 R1 (D-2187 condition 1): the one seat resolver. The parity cell imports the
// committed base generator in-process and compares its output with the committed golden as bytes;
// neither file is ever edited or regenerated. Every other cell runs on stub adapters and an in-memory
// doctor cache through the resolver's own seam (resolveSeats / deadPreferences).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverChannels } from "../../src/adapters/registry.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelKey, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { deadPreferences, type JudgeStage, resolveSeats, type SeatSkip } from "../../src/route/seat-resolver.js";
import { seatGoldens } from "../fixtures/seat-resolver/generate-goldens.js";

const GOLDEN = join(import.meta.dirname, "../fixtures/seat-resolver/goldens.base.json");

test("the unedited base generator reproduces the base seat goldens byte for byte through fleet pick the reviewer pick the consult walk and the acceptance judge", async () => {
  const produced = Buffer.from(await seatGoldens(), "utf8");
  expect(produced.equals(readFileSync(GOLDEN))).toBe(true);
}, 120_000);

// ── stub fleet: three known vendors and one gateway channel with no declared vendor ──────────────
type Tier = BillingChannel["tier"];
const ch = (adapter: string, vendor: string, model: string, tier: Tier, channel: "sub" | "api" = "sub"): BillingChannel =>
  ({ adapter, vendor, model, channel, tier });
const FLEET: Record<string, BillingChannel[]> = {
  alpha: [ch("alpha", "va", "a-hi", "frontier"), ch("alpha", "va", "a-mid", "mid")],
  beta: [ch("beta", "vb", "b-hi", "frontier", "api"), ch("beta", "vb", "b-mid", "mid")],
  gamma: [ch("gamma", "vc", "c-hi", "frontier")],
  delta: [ch("delta", "unknown", "d-gw", "frontier")],
};

const stub = (fleet: Record<string, BillingChannel[]>): WorkerAdapter[] => Object.entries(fleet).map(([id, channels]) => ({
  id, vendor: channels[0]!.vendor, channels: () => channels,
  probe: async () => { throw new Error("never probed"); },
  headlessCommand: () => { throw new Error("never dispatched"); },
  interactiveCommand: () => null,
}) as unknown as WorkerAdapter);

const healthy = (fleet: Record<string, BillingChannel[]>): Record<string, AuthHealth> =>
  Object.fromEntries(Object.entries(fleet).map(([id, channels]) => [id, {
    installed: true, authed: true, models: channels.map((c) => c.model),
    modelAuth: Object.fromEntries(channels.map((c) => [c.model, { authed: true, probedAt: "2026-11-08T00:00:00.000Z" }])),
  }]));

function world(fleet = FLEET) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge = { adapter: "gamma", model: "c-hi" };
  cfg.consult = { ...cfg.consult, adapter: "gamma", model: "c-hi", prefer: [] };
  cfg.review = { ...cfg.review, prefer: [] };
  return { cfg, adapters: stub(fleet), health: healthy(fleet) };
}

const AUTHOR: Assignment = { adapter: "beta", model: "b-mid", channel: "sub", tier: "mid" };

interface SkipCase {
  name: string;
  role: "consult" | "review";
  entry: string;
  arrange?: (cfg: TickmarkrConfig, health: Record<string, AuthHealth>) => void;
  excludeVendors?: string[];
  exclude?: string[];
  floor?: Tier;
  skip: Omit<SeatSkip, "entry">;
}

// CLOSED: every skip reason, for each role it applies to. Each entry is ranked first; the pick must
// pass over it to the second entry, a healthy channel of another vendor.
const SKIP_CASES: SkipCase[] = [
  { name: "consult denied", role: "consult", entry: "alpha:a-hi", arrange: (c) => { c.routing.deny = { models: ["a-hi"] }; },
    skip: { channel: "alpha:a-hi", reason: "denied", detail: "routing.deny (a-hi)" } },
  { name: "consult not-configured", role: "consult", entry: "alpha:missing",
    skip: { reason: "not-configured", detail: "no configured channel matches alpha:missing" } },
  { name: "consult not-installed", role: "consult", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.installed = false; },
    skip: { channel: "alpha:a-hi", reason: "not-installed", detail: "alpha" } },
  { name: "consult adapter-unauthed", role: "consult", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.authed = false; },
    skip: { channel: "alpha:a-hi", reason: "adapter-unauthed", detail: "alpha" } },
  { name: "consult model-unavailable", role: "consult", entry: "alpha:a-hi",
    arrange: (_c, h) => { h.alpha!.modelAuth!["a-hi"] = { authed: false, reason: "401 Unauthorized", probedAt: "2026-11-08T00:00:00.000Z" }; },
    skip: { channel: "alpha:a-hi", reason: "model-unavailable", detail: "401 Unauthorized" } },
  { name: "consult excluded-vendor", role: "consult", entry: "alpha:a-hi", excludeVendors: ["va"],
    skip: { channel: "alpha:a-hi", reason: "excluded-vendor", detail: "va" } },
  { name: "review denied", role: "review", entry: "alpha:a-hi", arrange: (c) => { c.routing.deny = { adapters: ["alpha"] }; },
    skip: { channel: "alpha:a-hi", reason: "denied", detail: "routing.deny (alpha)" } },
  { name: "review not-configured", role: "review", entry: "omega",
    skip: { reason: "not-configured", detail: "no configured channel matches omega" } },
  { name: "review not-installed", role: "review", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.installed = false; },
    skip: { channel: "alpha:a-hi", reason: "not-installed", detail: "alpha" } },
  { name: "review adapter-unauthed", role: "review", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.authed = false; },
    skip: { channel: "alpha:a-hi", reason: "adapter-unauthed", detail: "alpha" } },
  { name: "review model-unavailable", role: "review", entry: "alpha:a-hi", arrange: (_c, h) => { delete h.alpha!.modelAuth!["a-hi"]; },
    skip: { channel: "alpha:a-hi", reason: "model-unavailable", detail: "no model auth verdict" } },
  { name: "review excluded-vendor", role: "review", entry: "alpha:a-hi", excludeVendors: ["va"],
    skip: { channel: "alpha:a-hi", reason: "excluded-vendor", detail: "va" } },
  { name: "review unknown-vendor", role: "review", entry: "delta:d-gw",
    skip: { channel: "delta:d-gw", reason: "unknown-vendor" } },
  { name: "review author", role: "review", entry: "beta:b-hi",
    skip: { channel: "beta:b-hi", reason: "author", detail: "shares vendor vb with author beta:b-mid" } },
  { name: "review below-floor", role: "review", entry: "alpha:a-mid", floor: "frontier",
    skip: { channel: "alpha:a-mid", reason: "below-floor", detail: "mid below the frontier floor" } },
  { name: "review excluded", role: "review", entry: "alpha:a-hi", exclude: ["alpha:a-hi"],
    skip: { channel: "alpha:a-hi", reason: "excluded" } },
];

function resolveCase(c: SkipCase, cfg: TickmarkrConfig, health: Record<string, AuthHealth>, adapters: WorkerAdapter[]) {
  const pool = discoverChannels(cfg, adapters, health, c.role);
  const excludeVendors = new Set(c.excludeVendors ?? []);
  return c.role === "consult"
    ? resolveSeats({ role: "consult", cfg, pool, health, adapters, excludeVendors })
    : resolveSeats({ role: "review", cfg, pool, health, adapters, prefer: cfg.review.prefer ?? [], author: AUTHOR,
      floor: c.floor, exclude: c.exclude, excludeVendors });
}

test("the seat resolver skip CASE table names each closed skip reason with its detail for consult and review preferences", () => {
  for (const c of SKIP_CASES) {
    const { cfg, adapters, health } = world();
    cfg[c.role].prefer = [c.entry, "gamma:c-hi"];
    c.arrange?.(cfg, health);
    const r = resolveCase(c, cfg, health, adapters);
    expect(r.pick && channelKey(r.pick), c.name).toBe("gamma:c-hi");
    expect(r.skips, c.name).toEqual([{ entry: c.entry, ...c.skip }]);
  }
  // Every closed reason is exercised.
  expect(new Set(SKIP_CASES.map((c) => c.skip.reason)).size).toBe(10);

  // Entries ranked after the pick are not skips.
  {
    const { cfg, adapters, health } = world();
    cfg.consult.prefer = ["gamma:c-hi", "alpha:missing"];
    expect(resolveSeats({ role: "consult", cfg, pool: discoverChannels(cfg, adapters, health, "consult"), health, adapters }).skips).toEqual([]);
  }
  // A bare-adapter review.prefer entry matching two channels, one denied and one live: the denied channel
  // ranks first in the band, so passing over it to the live one writes one row …
  {
    const { cfg, adapters, health } = world();
    cfg.review.prefer = ["alpha", "gamma"];
    cfg.routing.deny = { models: ["a-hi"] };
    const r = resolveSeats({ role: "review", cfg, pool: discoverChannels(cfg, adapters, health, "review"), health, adapters,
      prefer: cfg.review.prefer, author: AUTHOR });
    expect(r.pick && channelKey(r.pick)).toBe("alpha:a-mid");
    expect(r.skips).toEqual([{ entry: "alpha", channel: "alpha:a-hi", reason: "denied", detail: "routing.deny (a-hi)" }]);
  }
  // … and none when the live one is the pick and the denied one ranks after it.
  {
    const { cfg, adapters, health } = world();
    cfg.review.prefer = ["alpha", "gamma"];
    cfg.routing.deny = { models: ["a-mid"] };
    const r = resolveSeats({ role: "review", cfg, pool: discoverChannels(cfg, adapters, health, "review"), health, adapters,
      prefer: cfg.review.prefer, author: AUTHOR });
    expect(r.pick && channelKey(r.pick)).toBe("alpha:a-hi");
    expect(r.skips).toEqual([]);
  }
  // No pick: every entry is passed over. The run's consult appends its pin; the pin is no skip row.
  {
    const { cfg, adapters, health } = world();
    cfg.consult.prefer = ["alpha:a-hi"];
    cfg.routing.deny = { models: ["a-hi"] };
    const pool = discoverChannels(cfg, adapters, health, "consult");
    const r = resolveSeats({ role: "consult", cfg, pool, health, adapters, pin: { adapter: "gamma", model: "c-hi" } });
    expect(r.ranked.map(channelKey)).toEqual(["gamma:c-hi"]);
    expect(r.skips).toEqual([{ entry: "alpha:a-hi", channel: "alpha:a-hi", reason: "denied", detail: "routing.deny (a-hi)" }]);
  }
});

// Row 362's captured shape: the user overlay prefers claude-code:opus first, the repository's tracked
// overlay denies it. The two overlays merge through the production config loader.
const ROW_362_FLEET: Record<string, BillingChannel[]> = {
  "claude-code": [ch("claude-code", "anthropic", "opus", "frontier")],
  codex: [ch("codex", "openai", "gpt-6.1-sol", "frontier")],
};

function row362(deny: boolean) {
  const root = mkdtempSync(join(tmpdir(), "tkr-seat-resolver-362-"));
  try {
    const globalDir = join(root, "global");
    const repo = join(root, "repo");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(globalDir, "config.yaml"), "consult:\n  prefer: [claude-code:opus, codex:gpt-6.1-sol]\n");
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), deny ? "routing:\n  deny:\n    models: [claude-code:opus]\n" : "{}\n");
    const cfg = loadConfig(repo, { globalDir });
    expect(cfg.consult.prefer).toEqual(["claude-code:opus", "codex:gpt-6.1-sol"]);
    const adapters = stub(ROW_362_FLEET);
    const health = healthy(ROW_362_FLEET);
    const pool = discoverChannels(cfg, adapters, health, "consult");
    return { resolved: resolveSeats({ role: "consult", cfg, pool, health, adapters }), dead: deadPreferences(cfg, adapters, health) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a review or consult preference whose every configured channel the merged routing disallows for that role is dead while an unhealthy or unconfigured entry is not", () => {
  // Row 362 shape: the pick is the second entry, one denied skip names the deny entry, the entry is DEAD.
  const denied = row362(true);
  expect(denied.resolved.pick && channelKey(denied.resolved.pick)).toBe("codex:gpt-6.1-sol");
  expect(denied.resolved.skips).toEqual([
    { entry: "claude-code:opus", channel: "claude-code:opus", reason: "denied", detail: "routing.deny (claude-code:opus)" },
  ]);
  expect(denied.dead).toEqual([{ role: "consult", entry: "claude-code:opus", disallowed: { by: "deny", entry: "claude-code:opus" } }]);
  // Control: the deny removed — the entry is picked, no skip, not DEAD.
  const control = row362(false);
  expect(control.resolved.pick && channelKey(control.resolved.pick)).toBe("claude-code:opus");
  expect(control.resolved.skips).toEqual([]);
  expect(control.dead).toEqual([]);

  // CLOSED dead CASE table on the stub fleet: [arrange, review.prefer entry, expected dead verdict].
  const cases: Array<{ name: string; entry: string; arrange?: (cfg: TickmarkrConfig, h: Record<string, AuthHealth>) => void; dead: boolean }> = [
    { name: "every channel of a bare adapter denied", entry: "alpha", arrange: (c) => { c.routing.deny = { adapters: ["alpha"] }; }, dead: true },
    { name: "one channel of a bare adapter denied, one live", entry: "alpha", arrange: (c) => { c.routing.deny = { models: ["a-hi"] }; }, dead: false },
    { name: "outside routing.allow", entry: "beta:b-hi", arrange: (c) => { c.routing.allow = { adapters: ["alpha", "gamma"] }; }, dead: true },
    { name: "worker-only deny does not reach the seat", entry: "alpha:a-hi", arrange: (c) => { c.routing.deny = { workers: { adapters: ["alpha"] } }; }, dead: false },
    { name: "denied under the observed identity", entry: "alpha:a-hi",
      arrange: (c, h) => { c.routing.deny = { models: ["zeta-9"] }; h.alpha!.modelAuth!["a-hi"]!.identity = "zeta-9"; }, dead: true },
    { name: "unauthenticated model", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.modelAuth!["a-hi"]!.authed = false; }, dead: false },
    { name: "adapter not installed", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.installed = false; }, dead: false },
    { name: "adapter signed out", entry: "alpha:a-hi", arrange: (_c, h) => { h.alpha!.authed = false; }, dead: false },
    { name: "unconfigured entry", entry: "omega", dead: false },
    { name: "unhealthy AND denied: health never revives a dead entry", entry: "alpha:a-hi",
      arrange: (c, h) => { c.routing.deny = { models: ["a-hi"] }; h.alpha!.installed = false; }, dead: true },
  ];
  for (const role of ["review", "consult"] as const) {
    for (const c of cases) {
      if (role === "consult" && !c.entry.includes(":")) continue; // consult.prefer entries are adapter:model
      const { cfg, adapters, health } = world();
      cfg[role].prefer = [c.entry];
      c.arrange?.(cfg, health);
      const dead = deadPreferences(cfg, adapters, health);
      expect(dead.map((d) => `${d.role}:${d.entry}`), `${role} ${c.name}`).toEqual(c.dead ? [`${role}:${c.entry}`] : []);
    }
  }
  // An unhealthy, unauthenticated or unconfigured entry is not DEAD, and its skip names that reason.
  for (const [entry, arrange, reason] of [
    ["alpha:a-hi", (h: Record<string, AuthHealth>) => { h.alpha!.modelAuth!["a-hi"]!.authed = false; }, "model-unavailable"],
    ["alpha:a-hi", (h: Record<string, AuthHealth>) => { h.alpha!.installed = false; }, "not-installed"],
    ["alpha:missing", () => {}, "not-configured"],
  ] as const) {
    const { cfg, adapters, health } = world();
    cfg.consult.prefer = [entry, "gamma:c-hi"];
    arrange(health);
    expect(deadPreferences(cfg, adapters, health)).toEqual([]);
    const r = resolveSeats({ role: "consult", cfg, pool: discoverChannels(cfg, adapters, health, "consult"), health, adapters });
    expect(r.skips.map((s) => s.reason)).toEqual([reason]);
  }
});

test("the judge resolution keeps the base refusal for a disallowed configured judge, pin then auto, and the same-vendor fallback, with no skip rows", () => {
  const judge = (arrange: (cfg: TickmarkrConfig) => void, authors = ["beta:b-hi"], stage?: JudgeStage) => {
    const { cfg, adapters, health } = world();
    arrange(cfg);
    const pools = (role: "judge" | "review") => discoverChannels(cfg, adapters, health, role);
    return resolveSeats({ role: "judge", cfg, pool: pools("judge"), authorPool: pools("review"), health, authors, stage });
  };
  // A disallowed configured judge: the refusal, no pick, nothing ranked (golden s04).
  const denied = judge((c) => { c.judge = { adapter: "alpha", model: "a-hi" }; c.routing.deny = { models: ["a-hi"] }; });
  expect(denied).toEqual({ pick: null, ranked: [], skips: [], disallowed: { by: "deny", entry: "a-hi" } });
  // An independent pin is the primary; its failover avoids it (golden s01).
  expect(judge(() => {}).ranked.slice(0, 2).map(channelKey)).toEqual(["gamma:c-hi", "alpha:a-hi"]);
  // A pin sharing the author's vendor yields to an independent automatic pick (golden s03).
  expect(channelKey(judge((c) => { c.judge = { adapter: "beta", model: "b-mid" }; }).pick!)).toBe("alpha:a-hi");
  // No independent judge left: the configured same-vendor judge is the fallback (golden s06).
  const fallback = judge((c) => { c.judge = { adapter: "beta", model: "b-mid" }; c.routing.deny = { adapters: ["alpha", "gamma", "delta"] }; });
  expect(fallback.ranked.map(channelKey)).toEqual(["beta:b-mid", "beta:b-hi"]);
  expect(fallback.skips).toEqual([]);
  // The adjudicator never repeats the primary; with no other known-vendor seat there is none.
  expect(judge((c) => { c.routing.deny = { adapters: ["alpha", "beta", "delta"] }; }, ["beta:b-hi"], { kind: "adjudicate", avoid: "gamma:c-hi" }).pick).toBeNull();
});

test("each of the four seams ranks through the seat resolver with no second ranking left in it", () => {
  const src = (rel: string) => readFileSync(join(import.meta.dirname, "../../src", rel), "utf8");
  for (const seam of ["gates/review.ts", "gates/run-gates.ts", "run/consult.ts", "route/role-pick.ts"]) {
    const text = src(seam);
    expect(text, seam).toMatch(/resolveSeats\(/);
    for (const ranking of ["rankPreferredChannels", "reviewPreferenceTieBreak", "marginalCostRank", "preferIndex"]) {
      expect(text, `${seam} ${ranking}`).not.toContain(ranking);
    }
  }
  const resolver = src("route/seat-resolver.ts");
  expect(resolver).not.toMatch(/from "\.\.\/(?:gates|run|cli)\//);
});
