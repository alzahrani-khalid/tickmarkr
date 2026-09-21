import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { quietGitInit } from "../helpers/tmprepo.js";
import {
  type Assignment,
  type AuthHealth,
  type BillingChannel,
  channelKey,
  channelsFromConfig,
  type WorkerAdapter,
} from "../../src/adapters/types.js";
import { discoverChannels, readDoctor } from "../../src/adapters/registry.js";
import { disallowedBy, exclusionCollector, modelProvider } from "../../src/route/preference.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { pickReviewer } from "../../src/gates/review.js";
import { loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";

function repoWithOverlay(yaml: string): { repo: string; globalDir: string } {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-id-repo-"));
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-id-global-"));
  quietGitInit(repo);
  execSync("git config user.name test", { cwd: repo, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "keep.txt"), "x\n");
  execSync("git add . && git commit -qm init", { cwd: repo, stdio: "ignore" });

  const dotTkr = join(repo, ".tickmarkr");
  mkdirSync(dotTkr, { recursive: true });
  writeFileSync(join(dotTkr, "config.yaml"), yaml.trimStart());
  return { repo, globalDir };
}

describe("Task T2: model identity, floating aliases, and exclusion provenance", () => {
  test("test: with doctor health recording the opus alias as claude-opus-5 and a workers deny naming claude-code:claude-opus-5 the worker pool discovery omits claude-code:opus while the judge and review pools keep it, with no recorded identity the same deny still omits the alias by family while a deny naming claude-sonnet-5 leaves it in, an allow entry naming an explicit id never admits an alias by family, and a flat deny naming the resolved identity omits the alias from every role, so a deny matched by literal string alone or an allow widened by family fails", () => {
    const { repo, globalDir } = repoWithOverlay(`
tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      opus: frontier
routing:
  deny:
    workers:
      models: [claude-code:claude-opus-5]
`);
    const cfg = loadConfig(repo, { globalDir });
    const claudeAdapter = {
      id: "claude-code",
      vendor: "anthropic",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      channels: (c: TickmarkrConfig) => channelsFromConfig("claude-code", c),
    } as unknown as WorkerAdapter;

    const healthWithRecordedIdentity: Record<string, AuthHealth> = {
      "claude-code": {
        installed: true,
        authed: true,
        models: [],
        modelAuth: {
          opus: {
            authed: true,
            probedAt: "2026-09-12T00:00:00.000Z",
            identity: "claude-opus-5",
          },
        },
      },
    };

    // 1. Worker pool discovery omits claude-code:opus while judge and review keep it
    const workerChannels = discoverChannels(cfg, [claudeAdapter], healthWithRecordedIdentity, "worker");
    expect(workerChannels.map((c) => channelKey(c))).not.toContain("claude-code:opus");

    const judgeChannels = discoverChannels(cfg, [claudeAdapter], healthWithRecordedIdentity, "judge");
    expect(judgeChannels.map((c) => channelKey(c))).toContain("claude-code:opus");

    const reviewChannels = discoverChannels(cfg, [claudeAdapter], healthWithRecordedIdentity, "review");
    expect(reviewChannels.map((c) => channelKey(c))).toContain("claude-code:opus");

    // 2. With no recorded identity the same deny still omits the alias by family
    const healthNoRecordedIdentity: Record<string, AuthHealth> = {
      "claude-code": {
        installed: true,
        authed: true,
        models: [],
        modelAuth: {
          opus: {
            authed: true,
            probedAt: "2026-09-12T00:00:00.000Z",
          },
        },
      },
    };
    const workerChannelsNoIdentity = discoverChannels(cfg, [claudeAdapter], healthNoRecordedIdentity, "worker");
    expect(workerChannelsNoIdentity.map((c) => channelKey(c))).not.toContain("claude-code:opus");

    // 3. While a deny naming claude-sonnet-5 leaves it in
    const { repo: repoSonnet, globalDir: gSonnet } = repoWithOverlay(`
tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      opus: frontier
routing:
  deny:
    workers:
      models: [claude-code:claude-sonnet-5]
`);
    const cfgSonnet = loadConfig(repoSonnet, { globalDir: gSonnet });
    const workerChannelsSonnet = discoverChannels(cfgSonnet, [claudeAdapter], healthNoRecordedIdentity, "worker");
    expect(workerChannelsSonnet.map((c) => channelKey(c))).toContain("claude-code:opus");

    // 4. An allow entry naming an explicit id never admits an alias by family
    const { repo: repoAllow, globalDir: gAllow } = repoWithOverlay(`
tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      opus: frontier
routing:
  allow:
    models: [claude-code:claude-opus-5]
`);
    const cfgAllow = loadConfig(repoAllow, { globalDir: gAllow });
    const workerChannelsAllow = discoverChannels(cfgAllow, [claudeAdapter], healthNoRecordedIdentity, "worker");
    expect(workerChannelsAllow.map((c) => channelKey(c))).not.toContain("claude-code:opus");

    // 5. Flat deny naming the resolved identity omits the alias from every role
    const { repo: repoFlat, globalDir: gFlat } = repoWithOverlay(`
tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      opus: frontier
routing:
  deny:
    models: [claude-opus-5]
`);
    const cfgFlat = loadConfig(repoFlat, { globalDir: gFlat });
    for (const role of ["worker", "judge", "review", "consult"] as const) {
      const roleChannels = discoverChannels(cfgFlat, [claudeAdapter], healthWithRecordedIdentity, role);
      expect(roleChannels.map((c) => channelKey(c))).not.toContain("claude-code:opus");
    }
  });

  test("test: a doctor run against a claude-code health whose resolver answers claude-opus-5 writes that identity beside the alias in doctor.json and discovery stamps it on the advertised channel, while a doctor run whose resolver throws or whose adapter is absent writes no identity field and, on a config with no deny or allow entry naming a member of an alias family, produces channels byte-identical to the base, so a resolver result that stays display-only fails", async () => {
    const onlyOpusYaml = `
tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      opus: frontier
`;
    const adapter = {
      id: "claude-code",
      vendor: "anthropic",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      channels: (c: TickmarkrConfig) => channelsFromConfig("claude-code", c),
      headlessCommand: () => "printf OK",
    } as unknown as WorkerAdapter;

    // Case 1: Resolver answers claude-opus-5
    const { repo: repo1, globalDir: g1 } = repoWithOverlay(onlyOpusYaml);
    await doctor(["--"], repo1, [adapter], {
      banner: false,
      resolveClaudeAliasIdentity: () => "claude-opus-5",
    });
    const doctorJson1 = JSON.parse(readFileSync(join(tickmarkrDir(repo1), "doctor.json"), "utf8"));
    expect(doctorJson1["claude-code"]?.modelAuth?.opus?.identity).toBe("claude-opus-5");

    const cfg1 = loadConfig(repo1, { globalDir: g1 });
    const docHealth1 = readDoctor(repo1)!;
    const discovered1 = discoverChannels(cfg1, [adapter], docHealth1);
    const opusChannel = discovered1.find((c) => c.adapter === "claude-code" && c.model === "opus");
    expect(opusChannel).toBeDefined();
    expect(opusChannel?.identity).toBe("claude-opus-5");

    // Case 2: Resolver throws
    const { repo: repo2, globalDir: g2 } = repoWithOverlay(onlyOpusYaml);
    await doctor(["--"], repo2, [adapter], {
      banner: false,
      resolveClaudeAliasIdentity: () => {
        throw new Error("CLI resolution exploded");
      },
    });
    const doctorJson2 = JSON.parse(readFileSync(join(tickmarkrDir(repo2), "doctor.json"), "utf8"));
    expect(doctorJson2["claude-code"]?.modelAuth?.opus?.identity).toBeUndefined();
    expect(JSON.stringify(doctorJson2)).not.toContain('"identity"');

    const cfg2 = loadConfig(repo2, { globalDir: g2 });
    const docHealth2 = readDoctor(repo2)!;
    const discovered2 = discoverChannels(cfg2, [adapter], docHealth2);
    const baseChannels = adapter.channels(cfg2);
    expect(discovered2).toEqual(baseChannels);

    // Case 3: Adapter is absent
    const otherAdapter = {
      id: "other-cli",
      vendor: "other",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      channels: () => [],
      headlessCommand: () => "printf OK",
    } as unknown as WorkerAdapter;
    const { repo: repo3 } = repoWithOverlay(onlyOpusYaml);
    await doctor(["--"], repo3, [otherAdapter], { banner: false });
    const doctorJson3 = JSON.parse(readFileSync(join(tickmarkrDir(repo3), "doctor.json"), "utf8"));
    expect(doctorJson3["claude-code"]).toBeUndefined();
    expect(JSON.stringify(doctorJson3)).not.toContain('"identity"');
  });

  test("a resolver that succeeds on every call still cannot backfill catalog display for an alias the pre-write pass never attempted", async () => {
    // "sonnet"/"haiku"/"fable" are tombstoned out of tiers (only "opus" stays configured), but the
    // adapter's own model listing still reports "sonnet" as available — the exact shape that sends a
    // stamped alias name through the UNCLASSIFIED catalog-rendering path instead of the identity loop.
    // The pre-write loop (which only visits `configured` aliases) never calls the resolver for
    // "sonnet", so no snapshot entry exists for it. The old code's `resolvedCatalogModel` filled that
    // gap by calling the resolver again, live, during rendering — a call whose result could never
    // reach doctor.json or discovery because the write already happened. A resolver that ALWAYS
    // succeeds is enough to prove the point: if catalog rendering still consulted it, "sonnet" would
    // pick up an identity nothing else in the system ever recorded.
    const tombstoneYaml = `
tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      opus: frontier
      sonnet: null
      haiku: null
      fable: null
`;
    const adapter = {
      id: "claude-code",
      vendor: "anthropic",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      listModels: async () => ["sonnet"],
      channels: (c: TickmarkrConfig) => channelsFromConfig("claude-code", c),
      headlessCommand: () => "printf OK",
    } as unknown as WorkerAdapter;

    const { repo, globalDir } = repoWithOverlay(tombstoneYaml);
    const cfgCheck = loadConfig(repo, { globalDir });
    expect(Object.keys(cfgCheck.tiers["claude-code"]?.models ?? {})).toEqual(["opus"]);

    const callsByAlias = new Map<string, number>();
    await doctor(["--"], repo, [adapter], {
      banner: false,
      resolveClaudeAliasIdentity: (_cwd, alias) => {
        callsByAlias.set(alias, (callsByAlias.get(alias) ?? 0) + 1);
        return "claude-opus-5";
      },
    });

    expect(callsByAlias.get("opus")).toBe(1); // the pre-write loop's one legitimate call
    expect(callsByAlias.get("sonnet")).toBeUndefined(); // never attempted, so never resolved

    const doctorJson = JSON.parse(readFileSync(join(tickmarkrDir(repo), "doctor.json"), "utf8"));
    expect(doctorJson["claude-code"]?.modelAuth?.sonnet).toBeUndefined();
  });

  test("test: the exclusion collector for a channel denied under both the flat models scope and the workers models scope lists both scopes with their config paths while the first-match reader still names the flat entry, and the provider of xai-oauth grok-4.6 equals the provider of grok grok-4.6 so that the reviewer picker excludes the gateway Grok for a Grok author while a cross-provider candidate stays seated, so a collector that stops at the first scope or a provider that reads the gateway's stamped vendor fails", () => {
    const target = { adapter: "codex", model: "gpt-5.5" };
    const routing = {
      deny: {
        models: ["gpt-5.5"],
        workers: {
          models: ["codex:gpt-5.5"],
        },
      },
    };

    // 1. Exclusion collector lists both scopes with their config paths
    const exclusions = exclusionCollector(target, routing, "worker");
    expect(exclusions).toHaveLength(2);
    expect(exclusions.map((e) => e.configPath)).toEqual(["routing.deny.models", "routing.deny.workers.models"]);
    expect(exclusions.map((e) => e.scope)).toEqual(["routing.deny.models", "routing.deny.workers.models"]);

    // 2. First-match reader still names the flat entry
    const firstMatch = disallowedBy(target, routing, "worker");
    expect(firstMatch).toEqual({ by: "deny", entry: "gpt-5.5" });

    // 3. Provider of xai-oauth grok-4.6 equals provider of grok grok-4.6
    const p1 = modelProvider("xai-oauth/grok-4.6");
    const p2 = modelProvider("grok-4.6");
    expect(p1).toBe("xai");
    expect(p2).toBe("xai");
    expect(p1).toBe(p2);
    expect(modelProvider("xai-oauth grok-4.6")).toBe(modelProvider("grok grok-4.6"));

    // 4. Reviewer picker excludes the gateway Grok for a Grok author while a cross-provider candidate stays seated
    const author: Assignment = { adapter: "grok", model: "grok-4.6", channel: "sub", tier: "mid" };
    const authorChannel: BillingChannel = { adapter: "grok", vendor: "xai", model: "grok-4.6", channel: "sub", tier: "mid" };
    const gatewayGrok: BillingChannel = { adapter: "omp", vendor: "omp-gateway", model: "xai-oauth/grok-4.6", channel: "sub", tier: "mid" };
    const crossProvider: BillingChannel = { adapter: "cursor-agent", vendor: "anthropic", model: "claude-fable-5-1", channel: "sub", tier: "frontier" };

    const picked = pickReviewer(author, [authorChannel, gatewayGrok, crossProvider]);
    expect(picked).not.toBeNull();
    expect(picked?.adapter).toBe("cursor-agent");
    expect(picked?.model).toBe("claude-fable-5-1");
  });
});
