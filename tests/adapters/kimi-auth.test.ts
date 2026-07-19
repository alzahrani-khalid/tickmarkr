import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { allAdapters } from "../../src/adapters/registry.js";
import { kimi, kimiAuthed, parseKimiModels, parseKimiResult } from "../../src/adapters/kimi.js";
import { validateGraph } from "../../src/graph/schema.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:os", () => ({ homedir: () => "/fake-home" }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

  beforeEach(() => mockedSpawn.mockReset());
  afterEach(() => vi.clearAllMocks());

  test("provider list output that fails to parse yields an empty model list", async () => {
    expect(parseKimiModels("not json")).toEqual([]);
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: "not json", stderr: "" })) as typeof spawnSync);
    expect(await kimi.listModels!()).toEqual([]);
    mockedSpawn.mockImplementation((() => ({ status: 1, stdout: "", stderr: "err" })) as typeof spawnSync);
    expect(await kimi.listModels!()).toEqual([]);
  });

  test("valid provider list JSON yields model ids", async () => {
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: PROVIDER_JSON, stderr: "" })) as typeof spawnSync);
    expect(await kimi.listModels!()).toEqual([
      "kimi-code/k3",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);
  });
});

describe("KIMI-02 command shapes + trailer parse", () => {
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
  test("kimi is the last adapter in the registry order", () => {
    expect(allAdapters().map((a) => a.id)).toEqual([
      "claude-code", "codex", "cursor-agent", "opencode", "pi", "grok", "kimi",
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
