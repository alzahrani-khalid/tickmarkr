import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CANDIDATE_CLI_CATALOG,
  REGISTERED_ADAPTER_BINARIES,
  detectCandidateClis,
  discoverChannels,
} from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { makeRepo } from "../helpers/tmprepo.js";

const stub = (id: string) =>
  ({
    id,
    vendor: "x",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg: Parameters<typeof channelsFromConfig>[1]) => channelsFromConfig(id, cfg),
  }) as unknown as WorkerAdapter;

const ADAPTERS5 = ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map(stub);

const pathWithGit = (binDir: string) => {
  try {
    const git = execSync("which git", { encoding: "utf8" }).trim();
    return `${binDir}:${dirname(git)}`;
  } catch {
    return binDir;
  }
};

const fakeBin = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

describe("doctor candidate-CLI sweep (v1.48 T1)", () => {
  let pathPrev: string | undefined;
  let binDir: string;

  beforeEach(() => {
    pathPrev = process.env.PATH;
    binDir = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-bin-"));
    process.env.PATH = `${binDir}:${pathPrev ?? ""}`;
  });

  afterEach(() => {
    if (pathPrev !== undefined) process.env.PATH = pathPrev;
    else delete process.env.PATH;
  });

  test("a catalog binary present on the path renders one advisory detected row with its version", async () => {
    fakeBin(
      binDir,
      "kimi",
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "kimi 2.5.0"; exit 0; fi
exit 0
`,
    );
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).toMatch(/! kimi\s+detected: kimi 2\.5\.0 \(no tickmarkr adapter — not routable\)/);
  });

  test("a catalog binary absent from the path renders no row", async () => {
    process.env.PATH = pathWithGit(binDir);
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    for (const bin of CANDIDATE_CLI_CATALOG) {
      expect(out).not.toMatch(new RegExp(`! ${bin}\\s+detected:`));
    }
  });

  test("a detected candidate appears in no discovered channel", async () => {
    fakeBin(
      binDir,
      "gemini",
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gemini 1.0.0"; exit 0; fi
exit 0
`,
    );
    const repo = makeRepo({ "keep.txt": "x" });
    await doctor(["--"], repo, ADAPTERS5);
    const health = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));
    const channels = discoverChannels(DEFAULT_CONFIG, ADAPTERS5, health);
    expect(channels.every((c) => !c.adapter.includes("gemini"))).toBe(true);
    expect(channels.map((c) => c.adapter)).not.toContain("gemini");
  });

  test("a candidate binary that errors on version probe never fails doctor", async () => {
    fakeBin(
      binDir,
      "qwen",
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then exit 1; fi
exit 0
`,
    );
    const repo = makeRepo({ "keep.txt": "x" });
    await expect(doctor(["--"], repo, ADAPTERS5)).resolves.toMatch(/^tickmarkr doctor — capability matrix:/);
    const detections = detectCandidateClis({ pathEnv: process.env.PATH });
    expect(detections.some((d) => d.binary === "qwen")).toBe(true);
  });

  test("no catalog name collides with a registered adapter binary", () => {
    const overlap = CANDIDATE_CLI_CATALOG.filter((b) => (REGISTERED_ADAPTER_BINARIES as readonly string[]).includes(b));
    expect(overlap).toEqual([]);
  });

  test("the sweep is advisory only and detected candidates are never routable", async () => {
    fakeBin(
      binDir,
      "aider",
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "aider 0.82.0"; exit 0; fi
exit 0
`,
    );
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    const health = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));
    for (const bin of CANDIDATE_CLI_CATALOG) {
      expect(health[bin]).toBeUndefined();
    }
    const channels = discoverChannels(DEFAULT_CONFIG, ADAPTERS5, health);
    for (const bin of CANDIDATE_CLI_CATALOG) {
      expect(channels.map((c) => c.adapter)).not.toContain(bin);
    }
    expect(out).toMatch(/! aider\s+detected: aider 0\.82\.0/);
  });
});
