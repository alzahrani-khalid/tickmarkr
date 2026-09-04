import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { allAdapters } from "../../src/adapters/registry.js";
import { kimi, kimiAuthed, parseKimiModels, parseKimiResult, probeKimiDoctorTurn } from "../../src/adapters/kimi.js";
import { validateGraph } from "../../src/graph/schema.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:os", () => ({ homedir: () => "/fake-home" }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("../../src/run/git.js", () => ({ sh: vi.fn() }));

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sh } from "../../src/run/git.js";
import { invalidConfiguredModels, modelAliasExclusions } from "../../src/adapters/registry.js";

const nowMs = Date.parse("2026-07-17T12:00:00Z");

// FIXTURE F-4 — verbatim `kimi -p …` stdout, kimi 0.26.0, 2026-07-17 [LIVE-RES, research F-4].
const F4_CAPTURE = [
  "• The user wants me to reply with exactly \"OK\" and nothing else.",
  "",
  "• OK",
  "",
  "• TICKMARKR_RESULT_bullet88 {\"ok\":true,\"summary\":\"bulleted live probe\",\"deviations\":[]}",
  "",
  "To resume this session: kimi -r session_25e8efca-cc09-4dd6-9dee-1951aec28581",
].join("\n");

const PROVIDER_JSON = JSON.stringify({
  models: {
    "kimi-code/k3": {},
    "kimi-code/kimi-for-coding": {},
    "kimi-code/kimi-for-coding-highspeed": {},
  },
});

describe("OBS-141 kimi doctor turn", () => {
  const mockedSh = vi.mocked(sh);

  beforeEach(() => mockedSh.mockReset());
  afterEach(() => vi.clearAllMocks());

  test("the real doctor turn command uses the full model contract and accepts kimi's exact OK answer line", async () => {
    mockedSh.mockResolvedValue({
      code: 0,
      stdout: "• Thinking briefly\n\n• OK\n\nTo resume this session: kimi -r session_1234\n",
      stderr: "",
    });

    await expect(probeKimiDoctorTurn("/repo")).resolves.toEqual({
      ok: true,
      evidence: "model turn returned OK with kimi-code/k3",
    });
    expect(mockedSh).toHaveBeenCalledOnce();
    expect(mockedSh.mock.calls[0][0]).toContain("--model 'kimi-code/k3'");
    expect(mockedSh.mock.calls[0][0]).toContain("Reply with exactly OK and nothing else.");
  });

  test("the real doctor turn command preserves a named model failure", async () => {
    mockedSh.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "[config.invalid] Model \"kimi-code/k3\" is not configured in config.toml",
    });

    await expect(probeKimiDoctorTurn("/repo")).resolves.toEqual({
      ok: false,
      evidence: "[config.invalid] Model \"kimi-code/k3\" is not configured in config.toml",
    });
  });
});

describe("KIMI-01 kimiAuthed — refresh_token dominates epoch-seconds expiry", () => {
  test("a credentials file with a non-empty refresh token and an expired expiry reads as authed", () => {
    const creds = JSON.stringify({ refresh_token: "PTlive", expires_at: 1_000_000_000 });
    expect(kimiAuthed(creds, nowMs)).toBe(true);
  });

  test("a credentials file with an empty refresh token and an unexpired epoch-seconds expiry reads as authed", () => {
    const creds = JSON.stringify({ refresh_token: "", expires_at: 4_000_000_000 });
    expect(kimiAuthed(creds, nowMs)).toBe(true);
  });

  test("a missing credentials file reads as unauthed", async () => {
    const mockedSpawn = vi.mocked(spawnSync);
    const mockedReadFile = vi.mocked(readFileSync);
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: "0.27.0\n", stderr: "" })) as typeof spawnSync);
    mockedReadFile.mockImplementation((() => { throw new Error("ENOENT"); }));
    const h = await kimi.probe();
    expect(h.installed).toBe(true);
    expect(h.authed).toBe(false);
  });

  test("a garbage credentials file reads as unauthed", async () => {
    expect(kimiAuthed("garbage", nowMs)).toBe(false);
    const mockedSpawn = vi.mocked(spawnSync);
    const mockedReadFile = vi.mocked(readFileSync);
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: "0.27.0\n", stderr: "" })) as typeof spawnSync);
    mockedReadFile.mockImplementation((p) => (String(p).endsWith("kimi-code.json") ? "not-json{{" : (() => { throw new Error("ENOENT"); })()));
    const h = await kimi.probe();
    expect(h.installed).toBe(true);
    expect(h.authed).toBe(false);
  });
});

describe("KIMI-04 parseKimiModels + listModels", () => {
  const mockedSpawn = vi.mocked(spawnSync);
  const mockedSh = vi.mocked(sh);

  beforeEach(() => {
    mockedSpawn.mockReset();
    mockedSh.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  test("provider list output that fails to parse yields an empty model list", async () => {
    expect(parseKimiModels("not json")).toEqual([]);
    mockedSh.mockResolvedValue({ code: 0, stdout: "not json", stderr: "" });
    expect(await kimi.listModels!()).toEqual([]);
    mockedSh.mockResolvedValue({ code: 1, stdout: "", stderr: "err" });
    expect(await kimi.listModels!()).toEqual([]);
  });

  test("valid provider list JSON yields model ids", async () => {
    mockedSh.mockResolvedValue({ code: 0, stdout: PROVIDER_JSON, stderr: "" });
    expect(await kimi.listModels!()).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);
  });

  test("the alias validation reuses the adapter's existing model-list parser rather than a second parsing path", async () => {
    mockedSh.mockResolvedValue({ code: 0, stdout: PROVIDER_JSON, stderr: "" });
    const models = await kimi.listModels!();
    expect(models).toEqual(parseKimiModels(PROVIDER_JSON));
    const health = { installed: true, authed: true, models, modelsDetectedAt: "2026-07-22T12:00:00.000Z" };
    const cfg = {
      tiers: {
        kimi: {
          vendor: "moonshot",
          channel: "sub",
          models: { "kimi-code/k3": "frontier", "kimi-code/missing": "mid" },
        },
      },
      routing: { map: {}, floors: {} },
    } as any;
    expect(invalidConfiguredModels(cfg, "kimi", health)).toEqual(["kimi-code/missing"]);
    expect(modelAliasExclusions(cfg, [kimi], { kimi: health })).toEqual([
      { key: "kimi:kimi-code/missing", adapter: "kimi", model: "kimi-code/missing" },
    ]);
    const { readFileSync: readFs } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const registrySrc = readFs(join(import.meta.dirname, "../../src/adapters/registry.ts"), "utf8");
    expect(registrySrc).not.toContain("parseKimiModels");
    expect(registrySrc).not.toContain("provider list");
  });
});

describe("KIMI-02 command shapes + trailer parse", () => {
  test("test: the headless command carries a model identifier consistent with the interactive contract", () => {
    const model = "kimi-code/kimi-for-coding";
    const modelArg = `'${model}'`;
    expect(kimi.headlessCommand("/tmp/p.md", model)).toContain(`--model ${modelArg}`);
    expect(kimi.interactiveSeed?.launch(model)).toContain(`-m ${modelArg}`);
  });

  test("no retired alias form survives anywhere in the adapter's launch or resume command construction", () => {
    const model = "kimi-code/kimi-for-coding";
    const retiredAliasArg = "'kimi-for-coding'";
    const commands = [
      kimi.interactiveSeed!.launch(model),
      kimi.headlessCommand("/tmp/p.md", model),
      kimi.resumeCommand!("session_11111111-aaaa-bbbb-cccc-111111111111", "/tmp/p.md", model),
    ];

    for (const command of commands) {
      expect(command).toContain(`'${model}'`);
      expect(command).not.toMatch(new RegExp(`(?:-m|--model) ${retiredAliasArg}(?: |$)`));
    }
  });

  test("the headless command contains the prompt flag and the model id and NO permission flag", () => {
    const c = kimi.headlessCommand("/tmp/p.md", "kimi-code/k3");
    expect(c).toContain("-p");
    expect(c).toContain("kimi-code/k3");
    // OBS-67: kimi 0.26.0 rejects -p combined with -y/--auto at parse time; prompt mode
    // is already non-interactive with tool actions auto-approved (live-verified 2026-07-17).
    expect(c).not.toMatch(/\s-y\b|--yolo|--auto/);
  });

  test("interactiveCommand is null — kimi has no TUI argv-seeding surface (print fallback)", () => {
    expect(kimi.interactiveCommand("/tmp/p.md", "kimi-code/k3")).toBeNull();
  });

  test("a worker output fixture with bulleted lines and a trailing resume line still yields the trailer verdict", () => {
    const r = parseKimiResult(F4_CAPTURE, "bullet88");
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("bulleted live probe");
    expect(r.deviations).toEqual([]);
  });

  test("invoke delegates to headlessCommand", () => {
    const task = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] }],
    }).tasks[0];
    const inv = kimi.invoke(task, "/cwd", { adapter: "kimi", model: "kimi-code/k3", channel: "sub", tier: "frontier" }, { promptFile: "/tmp/p.md" });
    expect(inv.command).toBe(kimi.headlessCommand("/tmp/p.md", "kimi-code/k3"));
  });
});

describe("registry + tiers", () => {
  // v1.89 T2: catalog-driven adapters append after the natives, so omp took the terminal slot from
  // kimi — kimi stays last among the natives, which is what the historical tie-break order pins.
  test("prime-agent is the last adapter in the registry order", () => {
    expect(allAdapters().map((a) => a.id)).toEqual([
      "claude-code", "codex", "cursor-agent", "opencode", "pi", "grok", "kimi", "qwen", "omp", "agy", "prime-agent",
    ]);
  });

  test("the kimi tier seed classifies three models under vendor moonshot", () => {
    const entry = DEFAULT_CONFIG.tiers.kimi;
    expect(entry.vendor).toBe("moonshot");
    expect(entry.channel).toBe("sub");
    expect(Object.keys(entry.models).sort()).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);
    expect(entry.models["kimi-code/k3"]).toBe("frontier");
    expect(entry.models["kimi-code/kimi-for-coding"]).toBe("mid");
    expect(entry.models["kimi-code/kimi-for-coding-highspeed"]).toBe("cheap");
    expect(kimi.vendor).toBe("moonshot");
  });
});

describe("KIMI-01 probe — credentials file ONLY, never network", () => {
  const mockedSpawn = vi.mocked(spawnSync);
  const mockedReadFile = vi.mocked(readFileSync);

  beforeEach(() => {
    mockedSpawn.mockReset();
    mockedReadFile.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  test("the auth verdict never shells out to a network call", async () => {
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: "0.27.0\n", stderr: "" })) as typeof spawnSync);
    mockedReadFile.mockImplementation((p) => (
      String(p).endsWith("kimi-code.json")
        ? JSON.stringify({ refresh_token: "PTlive", expires_at: 4_000_000_000 })
        : (() => { throw new Error("ENOENT"); })()
    ));
    const h = await kimi.probe();
    expect(h.authed).toBe(true);
    const calls = mockedSpawn.mock.calls.map((c) => c[1]);
    expect(calls).toContainEqual(["--version"]);
    expect(calls).not.toContainEqual(["provider", "list", "--json"]);
    expect(calls).not.toContainEqual(["login"]);
  });
});
