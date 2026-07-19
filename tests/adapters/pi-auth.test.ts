import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { allAdapters, discoverChannels } from "../../src/adapters/registry.js";
import { parsePiModels, pi } from "../../src/adapters/pi.js";
import { type AuthHealth } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";
import { validateGraph } from "../../src/graph/schema.js";
import { route } from "../../src/route/router.js";
import { authedModels } from "../helpers/tmprepo.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";

const CLAUDE_CODE_SRC = readFileSync(join(import.meta.dirname, "../../src/adapters/claude-code.ts"), "utf8");

// Committed capture from 36-PI-PROBE.md (2026-07-11, pi 0.80.6)
const LIST_MODELS_CAPTURE = [
  "provider      model                               context  max-out  thinking  images",
  "anthropic     claude-opus-4-5                     200K     64K      yes       yes",
  "anthropic     claude-sonnet-4-5                   200K     64K      yes       yes",
  "google        gemini-2.5-flash                    1.0M     65.5K    yes       yes",
  "google        gemini-2.5-pro                      1.0M     65.5K    yes       yes",
  "openai-codex  gpt-5.3-codex                       200K     64K      yes       no",
  "xai           grok-3                              131K     32K      yes       no",
  "zai           glm-5.2                             200K     64K      yes       yes",
].join("\n");

const mkTask = (shape: string) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 5, acceptance: ["a"] }],
  }).tasks[0];

function repoWithPiSeed() {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-g-"));
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-cfg-r-"));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`);
  return loadConfig(repo, { globalDir });
}

describe("HYG-05 pi auth — unknown vs unauthed", () => {
  const adapters = allAdapters().filter((a) => a.id !== "fake");

  test("HYG-05: servable undefined advertises every seeded pi channel (regression pin — passes on HEAD)", () => {
    const cfg = repoWithPiSeed();
    const health: Record<string, AuthHealth> = Object.fromEntries(
      adapters.map((a) => [a.id, { installed: true, authed: true, models: [], modelAuth: authedModels(a.channels(cfg).map((c) => c.model)) }]),
    );
    const channels = discoverChannels(cfg, adapters, health);
    const piChannels = channels.filter((c) => c.adapter === "pi");
    expect(piChannels).toHaveLength(2);
    expect(() => route(mkTask("chore"), cfg, channels)).not.toThrow();
  });

  test("HYG-05: DEFAULT_CONFIG pi seed survives servable filter", () => {
    const servable = parsePiModels(LIST_MODELS_CAPTURE);
    const health: Record<string, AuthHealth> = Object.fromEntries(
      adapters.map((a) => [
        a.id,
        a.id === "pi"
          ? { installed: true, authed: true, models: [], servable, modelAuth: authedModels(a.channels(DEFAULT_CONFIG).map((c) => c.model)) }
          : { installed: true, authed: true, models: [], modelAuth: authedModels(a.channels(DEFAULT_CONFIG).map((c) => c.model)) },
      ]),
    );
    const channels = discoverChannels(DEFAULT_CONFIG, adapters, health);
    expect(channels.some((c) => c.adapter === "pi" && c.model === "zai/glm-5.2")).toBe(true);
  });

  test("HYG-05: parsePiModels id format matches DEFAULT_CONFIG seed key", () => {
    const ids = parsePiModels(LIST_MODELS_CAPTURE);
    const seedKey = Object.keys(DEFAULT_CONFIG.tiers.pi!.models)[0];
    expect(ids).toContain(seedKey);
    expect(seedKey).toBe("zai/glm-5.2");
  });

  test("HYG-05: probeVersion untouched in claude-code.ts (D-17 fence)", () => {
    expect(CLAUDE_CODE_SRC).toMatch(/authed:\s*true/);
    expect(CLAUDE_CODE_SRC).toContain("probeVersion");
  });
});

describe("HYG-05 pi.probe() — servable undefined on failure, never []", () => {
  const mockedSpawn = vi.mocked(spawnSync);

  beforeEach(() => {
    mockedSpawn.mockReset();
    mockedSpawn.mockImplementation(((cmd: string, args?: string[]) => {
      if (args?.[0] === "--version") return { status: 0, stdout: "0.80.6\n", stderr: "" };
      return { status: 0, stdout: LIST_MODELS_CAPTURE, stderr: "" };
    }) as typeof spawnSync);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("HYG-05: happy branch — servable includes zai/glm-5.2", async () => {
    const h = await pi.probe();
    expect(h.installed).toBe(true);
    expect(h.servable).toContain("zai/glm-5.2");
  });

  test("HYG-05: --list-models status !== 0 ⇒ servable undefined, installed true, no throw", async () => {
    mockedSpawn.mockImplementation(((cmd: string, args?: string[]) => {
      if (args?.[0] === "--version") return { status: 0, stdout: "0.80.6\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "error" };
    }) as typeof spawnSync);
    const h = await pi.probe();
    expect(h.installed).toBe(true);
    expect(h.servable).toBeUndefined();
    expect(h).not.toHaveProperty("servable");
  });

  test("HYG-05: --list-models spawn error ⇒ servable undefined, installed true, no throw", async () => {
    mockedSpawn.mockImplementation(((cmd: string, args?: string[]) => {
      if (args?.[0] === "--version") return { status: 0, stdout: "0.80.6\n", stderr: "" };
      return { error: new Error("ENOENT"), status: null, stdout: "", stderr: "" };
    }) as typeof spawnSync);
    const h = await pi.probe();
    expect(h.installed).toBe(true);
    expect(h.servable).toBeUndefined();
    expect(h).not.toHaveProperty("servable");
  });
});
