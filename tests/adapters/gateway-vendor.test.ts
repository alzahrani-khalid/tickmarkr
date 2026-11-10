import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { realpathSync } from "node:fs";
import { claudeCode, claudeGatewayHost, readClaudeAliasIdentity } from "../../src/adapters/claude-code.js";
import { gatewayFamily, resolveProxiedClaudeIdentity } from "../../src/adapters/cliproxy.js";
import { codex } from "../../src/adapters/codex.js";
import { discoverChannels, PREFERENCE_ROLES } from "../../src/adapters/registry.js";
import { type AuthHealth, channelsFromConfig } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { authedModels, makeTestTempDir } from "../helpers/tmprepo.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(homedir).mockReset();
});

test("test: the gateway detector reads the environment's base URL first and the user settings file's env second, and returns no gateway for Anthropic's own host, a missing URL or an unreadable file, so a detector that skips the settings file or calls Anthropic a gateway fails", () => {
  const home = makeTestTempDir("gateway-home-");
  const configDir = makeTestTempDir("gateway-config-");
  vi.mocked(homedir).mockReturnValue(home);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://home.example/v1" } }));
  const settings = join(configDir, "settings.json");
  const save = (value: unknown) => writeFileSync(settings, JSON.stringify(value));
  save({ env: { ANTHROPIC_BASE_URL: "https://settings.example:8443/v1" } });

  expect(claudeGatewayHost({ ANTHROPIC_BASE_URL: "https://env.example/v1" }, settings)).toBe("env.example");
  expect(claudeGatewayHost({ ANTHROPIC_BASE_URL: "https://env.example/v1" }, join(configDir, "absent"))).toBe("env.example");
  expect(claudeGatewayHost({}, settings)).toBe("settings.example");
  expect(claudeGatewayHost({ CLAUDE_CONFIG_DIR: configDir })).toBe("settings.example");
  expect(claudeGatewayHost({})).toBe("home.example");
  expect(claudeGatewayHost({ ANTHROPIC_BASE_URL: "https://api.anthropic.com:443/v1" }, settings)).toBeUndefined();
  expect(claudeGatewayHost({ ANTHROPIC_BASE_URL: "not a URL" }, settings)).toBeUndefined();
  save({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1" } });
  expect(claudeGatewayHost({}, settings)).toBeUndefined();
  for (const value of [{}, { env: {} }, { env: { ANTHROPIC_BASE_URL: "" } }, { env: { ANTHROPIC_BASE_URL: 42 } }]) {
    save(value);
    expect(claudeGatewayHost({}, settings)).toBeUndefined();
  }
  writeFileSync(settings, "{");
  expect(claudeGatewayHost({}, settings)).toBeUndefined();
  expect(claudeGatewayHost({}, join(configDir, "absent"))).toBeUndefined();
  expect(claudeGatewayHost({}, configDir)).toBeUndefined();

  // Defaults stay hermetic even when the inherited environment or settings would name a gateway.
  save({ env: { ANTHROPIC_BASE_URL: "https://ambient-settings.example" } });
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient-env.example");
  expect(claudeGatewayHost()).toBeUndefined();
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  expect(claudeGatewayHost()).toBeUndefined();
});

test("test: behind a gateway a claude-code channel takes its declared vendor, keeps anthropic only for an observed anthropic identity, and is otherwise vendor unknown, while without a gateway every channel keeps its stamped vendor, so a vendor read from a claude-named model fails", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers["claude-code"] = {
    vendor: "stamped-vendor", channel: "sub",
    models: { "claude-declared": "frontier", sonnet: "mid", haiku: "cheap", "claude-unobserved": "frontier", "claude-other": "frontier", opaque: "mid" },
    modelOverrides: { "claude-declared": { vendor: "openai" } },
  };
  cfg.tiers.codex = { vendor: "openai", channel: "sub", models: { "gpt-worker": "frontier" } };
  const models = Object.keys(cfg.tiers["claude-code"].models);
  const health: Record<string, AuthHealth> = {
    "claude-code": {
      installed: true, authed: true, models,
      modelAuth: {
        ...authedModels(models),
        "claude-declared": { ...authedModels(["claude-declared"])["claude-declared"], identity: "claude-fable-5-1" },
        sonnet: { ...authedModels(["sonnet"]).sonnet, identity: "claude-sonnet-5-5" },
        "claude-other": { ...authedModels(["claude-other"])["claude-other"], identity: "gpt-worker" },
        opaque: { ...authedModels(["opaque"]).opaque, identity: "opaque-served-model" },
      },
      modelIdentities: { haiku: "claude-haiku-4-5-20251001" },
    },
    codex: { installed: true, authed: true, models: ["gpt-worker"], modelAuth: authedModels(["gpt-worker"]) },
  };
  const stamped = [claudeCode, codex].flatMap((a) => channelsFromConfig(a.id, cfg));
  for (const role of PREFERENCE_ROLES) {
    const channels = discoverChannels(cfg, [claudeCode, codex], health, role, "gateway.example");
    expect(Object.fromEntries(channels.map((c) => [c.model, c.vendor]))).toEqual({
      "claude-declared": "openai", sonnet: "anthropic", haiku: "anthropic",
      "claude-unobserved": "unknown", "claude-other": "unknown", opaque: "unknown", "gpt-worker": "openai",
    });
    expect(channels.find((c) => c.model === "sonnet")?.identity).toBe("claude-sonnet-5-5");
    const direct = discoverChannels(cfg, [claudeCode, codex], health, role, "");
    expect(direct.map((c) => c.vendor)).toEqual(stamped.map((c) => c.vendor));
  }
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.example");
  expect(discoverChannels(cfg, [claudeCode, codex], health).map((c) => c.vendor)).toEqual(stamped.map((c) => c.vendor));
  vi.stubEnv("VITEST", "");
  expect(discoverChannels(cfg, [claudeCode, codex], health).find((c) => c.model === "claude-unobserved")?.vendor).toBe("unknown");
  expect(claudeCode.channels(cfg)).toEqual(channelsFromConfig("claude-code", cfg));
});

test("without a confirmed proxy every claude-code vendor and identity reads as at the base", () => {
  // Queue row 392 R6 law 3 (D-2187 add.11): only a gateway record whose listing succeeded and which the Claude CLI
  // goes through changes a claude-code vendor. Every other doctor.json gateway key reads byte-for-byte as none.
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers["claude-code"] = {
    vendor: "anthropic", channel: "sub",
    models: { fable: "frontier", opus: "frontier", "claude-opus-5-5": "frontier", "claude-declared": "frontier", opaque: "mid" },
    modelOverrides: { fable: { vendor: "anthropic" }, "claude-declared": { vendor: "openai" } },
  };
  const models = Object.keys(cfg.tiers["claude-code"].models);
  const verdict = (identity?: string) => ({ ...authedModels(["m"]).m, ...(identity ? { identity } : {}) });
  const health: Record<string, AuthHealth> = {
    "claude-code": {
      installed: true, authed: true, models,
      modelAuth: {
        ...authedModels(models),
        fable: verdict("gemini-3-pro"), "claude-declared": verdict("claude-fable-5-1"), opaque: verdict("opaque-served-model"),
      },
    },
  };
  const at = (gateway: unknown, host: string) => discoverChannels(cfg, [claudeCode], gateway === undefined ? health : { ...health, gateway } as Record<string, AuthHealth>, "review", host);
  const listing = { status: "succeeded", checkedAt: "2026-11-08T12:00:00.000Z" };
  const record = { host: "127.0.0.1", baseUrl: "http://127.0.0.1:8317", source: "env", listing, models: [{ id: "gemini-3-pro", vendor: "google" }] };
  const unconfirmed: [string, unknown][] = [
    ["a failed listing", { ...record, listing: { status: "failed", failure: "down", reason: "ECONNREFUSED", checkedAt: listing.checkedAt }, models: [] }],
    ["a differing override", { ...record, source: "config", anthropicUnusable: { claudeHost: "api.anthropic.com" } }],
    ["a withheld outcome", { withheld: "listing", source: "env" }],
    ["an adapter verdict named gateway", { installed: true, authed: true, models: [] }],
    ["an unreadable record", "gateway"],
  ];
  for (const host of ["gateway.example", ""]) {
    const base = at(undefined, host);
    for (const [cell, gateway] of unconfirmed) expect(at(gateway, host), `${cell} (${host || "direct"})`).toEqual(base);
    // the identities discovery stamps are the recorded ones, unchanged
    expect(Object.fromEntries(base.map((c) => [c.model, c.identity]))).toEqual({
      fable: "gemini-3-pro", opus: undefined, "claude-opus-5-5": undefined, "claude-declared": "claude-fable-5-1", opaque: "opaque-served-model",
    });
  }
  // the base reading itself: override first behind a gateway, the stamped vendor directly
  expect(Object.fromEntries(at(undefined, "gateway.example").map((c) => [c.model, c.vendor]))).toEqual({
    fable: "anthropic", opus: "unknown", "claude-opus-5-5": "unknown", "claude-declared": "openai", opaque: "unknown",
  });
  expect(at(undefined, "").map((c) => c.vendor)).toEqual(channelsFromConfig("claude-code", cfg).map((c) => c.vendor));
  // control, an instance of what the guard catches: the same caches with a confirmed proxy do change
  expect(Object.fromEntries(at(record, "gateway.example").map((c) => [c.model, c.vendor]))).toEqual({
    fable: "google", opus: "unknown", "claude-opus-5-5": "anthropic", "claude-declared": "anthropic", opaque: "unknown",
  });

  // The store read without a confirmed proxy is alias-only and family-filtered: a record the CLI attributes to
  // fable by its requested model, served from another family, is never read as fable's identity.
  const home = makeTestTempDir("gateway-store-");
  vi.mocked(homedir).mockReturnValue(home);
  const cwd = realpathSync(makeTestTempDir("gateway-cwd-"));
  const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), JSON.stringify({ type: "assistant", cwd, timestamp: "2026-11-08T11:00:00.000Z", requestedModel: "fable", message: { model: "gemini-3-pro" } }));
  expect(readClaudeAliasIdentity(cwd, "fable")).toBeUndefined();
  // control: behind a confirmed proxy the classified identity is attributed by the requested model
  expect(readClaudeAliasIdentity(cwd, "fable", (id) => gatewayFamily(id) !== null)).toBe("gemini-3-pro");
});

test("behind a confirmed proxy a store record naming another requested model never answers for this one, and the base read stays family-only", () => {
  // Queue row 392 R6 law 3 (D-2187 add.11): the closed record table, one record per cell, alias fable. The
  // proxied column is resolveProxiedClaudeIdentity (store first, then the turn); the base column is the base read.
  const home = makeTestTempDir("attribution-home-");
  vi.mocked(homedir).mockReturnValue(home);
  const cwd = realpathSync(makeTestTempDir("attribution-cwd-"));
  const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const plant = (records: object[]) =>
    writeFileSync(join(dir, "s.jsonl"), records.map((r) => JSON.stringify({ type: "assistant", cwd, ...r })).join("\n"));
  const at = (hour: number) => `2026-11-08T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const cells: { cell: string; requestedModel?: unknown; identity: string; proxied?: string; base?: string }[] = [
    // unattributed behind a proxy: never evidence, so the turn answers (the base read keeps its family match)
    { cell: "no requested model, family id", identity: "claude-fable-5-1", base: "claude-fable-5-1" },
    { cell: "no requested model, other family", identity: "gemini-3-pro" },
    { cell: "requested this model, other family", requestedModel: "fable", identity: "gemini-3-pro", proxied: "gemini-3-pro" },
    { cell: "requested this model, family id", requestedModel: "fable", identity: "claude-fable-5-1", proxied: "claude-fable-5-1", base: "claude-fable-5-1" },
    { cell: "requested this model, unclassified", requestedModel: "fable", identity: "mystery-model-1" },
    { cell: "requested another model, family id", requestedModel: "opus", identity: "claude-fable-5-1", base: "claude-fable-5-1" },
    { cell: "requested another model, other family", requestedModel: "opus", identity: "gemini-3-pro" },
    { cell: "requested model not a string", requestedModel: 42, identity: "claude-fable-5-1", base: "claude-fable-5-1" },
  ];
  for (const c of cells) {
    plant([{ timestamp: at(11), message: { model: c.identity }, ...(c.requestedModel === undefined ? {} : { requestedModel: c.requestedModel }) }]);
    const asked: string[] = [];
    const proxied = resolveProxiedClaudeIdentity(cwd, "fable", (_cwd, model) => (asked.push(model), undefined));
    expect(proxied, c.cell).toBe(c.proxied);
    expect(asked, c.cell).toEqual(c.proxied === undefined ? ["fable"] : []); // the turn is the fallback, only on store silence
    expect(readClaudeAliasIdentity(cwd, "fable"), c.cell).toBe(c.base);
  }
  // The reviewer's case: a newer record attributed to fable never masks an older one attributed to gemini-3-pro.
  plant([
    { timestamp: at(10), requestedModel: "gemini-3-pro", message: { model: "gpt-6.1-sol" } },
    { timestamp: at(11), requestedModel: "fable", message: { model: "gemini-3-pro" } },
  ]);
  const turn = (_cwd: string, model: string) => `gemini-3-pro-turn-${model}`;
  expect(resolveProxiedClaudeIdentity(cwd, "gemini-3-pro", turn)).toBe("gpt-6.1-sol");
  expect(resolveProxiedClaudeIdentity(cwd, "fable", turn)).toBe("gemini-3-pro");
});

test("behind a confirmed proxy an unattributed store record never supersedes one attributed to the requested model, and with none attributed the stated-identity turn answers", () => {
  // Queue row 392 R6 law 3 (D-2187 add.11): every ordered pair (older, newer) of the closed record kinds, for a
  // configured claude-code model named gemini-3-pro, through the resolver doctor uses behind a confirmed proxy.
  // Oracle: the newest record whose requestedModel names the model (with a classified or own-family identity);
  // with none, the turn. A proxy may serve any family under any name, so a family match alone attributes nothing.
  // The base read (no proxy) stays the newest family match.
  const home = makeTestTempDir("pairs-home-");
  vi.mocked(homedir).mockReturnValue(home);
  const cwd = realpathSync(makeTestTempDir("pairs-cwd-"));
  const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const MODEL = "gemini-3-pro";
  const TURN = "gpt-6.1-terra";
  // [record fields, proxied answer, base answer]
  const kinds: Record<string, [object, string | undefined, string | undefined]> = {
    "attributed, other family": [{ requestedModel: MODEL, message: { model: "gpt-6.1-sol" } }, "gpt-6.1-sol", undefined],
    "attributed, own id": [{ requestedModel: MODEL, message: { model: MODEL } }, MODEL, MODEL],
    "attributed, unclassified": [{ requestedModel: MODEL, message: { model: "mystery-model-1" } }, undefined, undefined],
    "unattributed, own id": [{ message: { model: MODEL } }, undefined, MODEL],
    "unattributed, non-string requestedModel": [{ requestedModel: 42, message: { model: MODEL } }, undefined, MODEL],
    "another model's, own id": [{ requestedModel: "claude-fable-5-1", message: { model: MODEL } }, undefined, MODEL],
  };
  for (const [olderKind, [older, olderProxied, olderBase]] of Object.entries(kinds)) {
    for (const [newerKind, [newer, newerProxied, newerBase]] of Object.entries(kinds)) {
      const cell = `${olderKind} then ${newerKind}`;
      writeFileSync(join(dir, "s.jsonl"), [
        { type: "assistant", cwd, timestamp: "2026-11-08T10:00:00.000Z", ...older },
        { type: "assistant", cwd, timestamp: "2026-11-08T11:00:00.000Z", ...newer },
      ].map((r) => JSON.stringify(r)).join("\n"));
      const asked: string[] = [];
      const proxied = resolveProxiedClaudeIdentity(cwd, MODEL, (_cwd, model) => (asked.push(model), TURN));
      const attributed = newerProxied ?? olderProxied;
      expect(proxied, cell).toBe(attributed ?? TURN);
      expect(asked, cell).toEqual(attributed === undefined ? [MODEL] : []);
      expect(readClaudeAliasIdentity(cwd, MODEL), cell).toBe(newerBase ?? olderBase);
    }
  }
});

test("behind a confirmed proxy an unclassified recorded identity keeps the base vendor and the id family applies only with no identity", () => {
  // Queue row 392 R6 law 3 (D-2187 add.11): model × recorded identity × override, the closed table through discovery.
  const listing = { status: "succeeded", checkedAt: "2026-11-08T12:00:00.000Z" };
  const record = { host: "127.0.0.1", baseUrl: "http://127.0.0.1:8317", source: "env", listing, models: [] };
  const identities = [undefined, "claude-fable-5-1", "gemini-3-pro", "mystery-model-1"] as const;
  // [behind the proxy, at the base] per identity above, for each model and override
  const table: Record<string, Record<string, [string, string][]>> = {
    "claude-opus-5-5": {
      none: [["anthropic", "unknown"], ["anthropic", "anthropic"], ["google", "unknown"], ["unknown", "unknown"]],
      openai: [["anthropic", "openai"], ["anthropic", "openai"], ["google", "openai"], ["openai", "openai"]],
    },
    fable: {
      none: [["unknown", "unknown"], ["anthropic", "anthropic"], ["google", "unknown"], ["unknown", "unknown"]],
      openai: [["openai", "openai"], ["anthropic", "openai"], ["google", "openai"], ["openai", "openai"]],
    },
  };
  for (const [model, byOverride] of Object.entries(table)) {
    for (const [override, rows] of Object.entries(byOverride)) {
      identities.forEach((identity, i) => {
        const cfg = structuredClone(DEFAULT_CONFIG);
        cfg.tiers["claude-code"] = {
          vendor: "anthropic", channel: "sub", models: { [model]: "frontier" },
          ...(override === "none" ? {} : { modelOverrides: { [model]: { vendor: override } } }),
        };
        const health: Record<string, AuthHealth> = {
          "claude-code": { installed: true, authed: true, models: [model], modelAuth: { [model]: { ...authedModels([model])[model], ...(identity ? { identity } : {}) } } },
        };
        const vendor = (h: Record<string, unknown>) => discoverChannels(cfg, [claudeCode], h as Record<string, AuthHealth>, "review", "127.0.0.1")[0]?.vendor;
        const cell = `${model} / ${identity ?? "no identity"} / override ${override}`;
        expect([vendor({ ...health, gateway: record }), vendor(health)], cell).toEqual(rows[i]);
      });
    }
  }
});
