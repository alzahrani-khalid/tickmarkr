import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { claudeCode, claudeGatewayHost } from "../../src/adapters/claude-code.js";
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
