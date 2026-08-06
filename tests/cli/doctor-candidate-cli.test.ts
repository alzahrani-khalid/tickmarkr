import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  allAdapters,
  binaryShadowWarnings,
  CANDIDATE_CLI_CATALOG,
  detectCandidateClis,
  discoverChannels,
  registeredAdapterBinaries,
  resolveShellBinary,
} from "../../src/adapters/registry.js";
import { channelsFromConfig, type AuthHealth, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { makeRepo } from "../helpers/tmprepo.js";

const stub = (id: string, binary?: string) =>
  ({
    id,
    vendor: "fixture",
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg: Parameters<typeof channelsFromConfig>[1]) => channelsFromConfig(id, cfg),
    ...(binary ? { hardcodedFlags: { binary, flags: [] } } : {}),
  }) as unknown as WorkerAdapter;

const GIT_BIN_DIR = dirname(execSync("command -v git", { encoding: "utf8" }).trim());
const fixturePath = (...dirs: string[]) => [...new Set([...dirs, GIT_BIN_DIR, "/bin", "/usr/bin"])].join(":");

const fakeBin = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

type CapabilityRow = { id: string; value: string };

function capabilityRows(out: string): CapabilityRow[] {
  const lines = out.split("\n");
  const end = lines.indexOf("workspace trust:");
  return lines.slice(1, end === -1 ? lines.length : end).flatMap((line) => {
    const match = /^  [✓✗!] ([a-z0-9-]+)\s+(.+)$/.exec(line);
    return match ? [{ id: match[1], value: match[2] }] : [];
  });
}

function contradictionIds(rows: CapabilityRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

describe("doctor candidate-CLI truth (v1.86 T12)", () => {
  let pathPrev: string | undefined;
  let homePrev: string | undefined;
  let binDir: string;
  let adapters: WorkerAdapter[];

  beforeEach(() => {
    pathPrev = process.env.PATH;
    homePrev = process.env.HOME;
    binDir = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-bin-"));
    process.env.PATH = fixturePath(binDir);
    process.env.HOME = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-home-"));
    // registry resolution intentionally uses `bash -lc`; make its isolated login PATH deterministic.
    writeFileSync(join(process.env.HOME, ".bash_profile"), `export PATH='${process.env.PATH}'\n`);

    // The fixture IS the registry. Only external probe/trust effects are replaced; membership,
    // ids and hardcoded binary declarations remain the production allAdapters() values.
    adapters = allAdapters();
    for (const adapter of adapters) {
      vi.spyOn(adapter, "probe").mockResolvedValue({ installed: false, authed: false, models: [] });
      if (adapter.listModels) vi.spyOn(adapter, "listModels").mockResolvedValue([]);
      if (adapter.trust) vi.spyOn(adapter, "trust").mockReturnValue({ status: "trusted" });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (pathPrev !== undefined) process.env.PATH = pathPrev;
    else delete process.env.PATH;
    if (homePrev !== undefined) process.env.HOME = homePrev;
    else delete process.env.HOME;
  });

  test("test: no candidate-catalog name is also a registered adapter binary, proven over the binaries derived from allAdapters() rather than a hand-maintained list, and adding an adapter whose binary is in the catalog fails the guard", () => {
    const assertNoCatalogCollision = (registry: WorkerAdapter[]) => {
      const binaries = registeredAdapterBinaries(registry);
      const collisions = CANDIDATE_CLI_CATALOG.filter((binary) => binaries.includes(binary));
      if (collisions.length) throw new Error(`candidate catalog collides with adapter binaries: ${collisions.join(", ")}`);
    };

    expect(registeredAdapterBinaries()).toEqual(adapters.map((adapter) => adapter.hardcodedFlags?.binary).filter(Boolean));
    expect(() => assertNoCatalogCollision(adapters)).not.toThrow();

    const conflictingAdapter = stub("omp-adapter-fixture", "omp");
    expect(() => assertNoCatalogCollision([...adapters, conflictingAdapter])).toThrow(/\bomp\b/);
  });

  test("test: doctor's matrix names each installed binary exactly once with no id appearing as both an adapter row and a detected-not-routable row, proven member by member over the full registry — a claude-code fixture, a codex fixture, a cursor-agent fixture, an opencode fixture, a pi fixture, a grok fixture and a kimi fixture", async () => {
    for (const adapter of adapters) {
      const binary = adapter.hardcodedFlags?.binary;
      expect(binary, `${adapter.id} must declare its registry binary`).toBeTruthy();
      fakeBin(binDir, binary!, `#!/bin/sh\nprintf '%s\\n' '${adapter.id} fixture 1.0.0'\n`);
    }
    const ompPath = fakeBin(binDir, "omp", "#!/bin/sh\nexit 97\n");

    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, adapters, {
      banner: false,
      kimiTurnProbe: async () => ({ ok: true, evidence: "fixture" }),
      resolveClaudeAliasIdentity: () => undefined,
    });
    const health = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")) as Record<string, AuthHealth>;
    const rows = capabilityRows(out).filter((row) => row.id !== "herdr");
    const adapterIds = new Set(adapters.map((adapter) => adapter.id));
    const adapterRows = rows.filter((row) => adapterIds.has(row.id));
    const advisoryRows = rows.filter((row) => !adapterIds.has(row.id));

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "claude-code",
      "codex",
      "cursor-agent",
      "opencode",
      "pi",
      "grok",
      "kimi",
    ]);
    expect(adapterRows.map((row) => row.id).sort()).toEqual(adapters.map((adapter) => adapter.id).sort());
    expect(advisoryRows).toEqual([{ id: "omp", value: `detected at ${ompPath} (no drive contract — not routable)` }]);
    const binaryClaims = [
      ...adapters.map((adapter) => ({ id: adapter.hardcodedFlags!.binary, value: `adapter:${adapter.id}` })),
      ...advisoryRows.map((row) => ({ id: row.id, value: `advisory:${row.value}` })),
    ];
    expect(contradictionIds(binaryClaims)).toEqual([]);
    for (const adapter of adapters) {
      expect(rows.filter((row) => row.id === adapter.id), adapter.id).toHaveLength(1);
      expect(rows.find((row) => row.id === adapter.id)?.value).not.toContain("not routable");
      expect(health[adapter.id]?.installed, adapter.id).toBe(true);
    }

    // The oracle rejects every same-binary contradiction shape, not one favored wording pair.
    const installed = { id: "same-binary", value: "installed" };
    const alternateAdapterVerdict = { id: "same-binary", value: "not installed" };
    const advisory = { id: "same-binary", value: "detected at /fixture/bin (no drive contract — not routable)" };
    const alternateAdvisory = { id: "same-binary", value: "detected at /other/bin (no drive contract — not routable)" };
    for (const contradiction of [
      [installed, alternateAdapterVerdict],
      [installed, advisory],
      [advisory, alternateAdvisory],
    ]) {
      expect(contradictionIds(contradiction)).toEqual(["same-binary"]);
    }
  });

  test("test: an omp fixture on PATH renders one advisory detected row carrying no version string and appears in no discovered channel and no doctor.json health key", async () => {
    const executionMarker = join(binDir, "omp-executed");
    const ompPath = fakeBin(
      binDir,
      "omp",
      `#!/bin/sh\nprintf executed > '${executionMarker}'\nprintf '%s\\n' 'OMP_VERSION_SENTINEL'\n`,
    );
    const repo = makeRepo({ "keep.txt": "x" });

    const out = await doctor(["--"], repo, adapters, {
      banner: false,
      resolveClaudeAliasIdentity: () => undefined,
    });
    const health = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")) as Record<string, AuthHealth>;
    const rows = capabilityRows(out).filter((row) => row.id === "omp");

    expect(rows).toEqual([{ id: "omp", value: `detected at ${ompPath} (no drive contract — not routable)` }]);
    expect(out).not.toContain("OMP_VERSION_SENTINEL");
    expect(existsSync(executionMarker)).toBe(false);
    expect(health.omp).toBeUndefined();
    expect(discoverChannels(DEFAULT_CONFIG, adapters, health).map((channel) => channel.adapter)).not.toContain("omp");
  });

  test("test: no advisory-only target is executed, proven over the closed set of resolution paths — a catalog entry without a drive block, a shadowed binary and a symlinked binary — each resolved for presence only", () => {
    const detectOmp = (pathEnv: string) => {
      process.env.PATH = pathEnv;
      const detected = detectCandidateClis({
        cwd: binDir,
        pathEnv,
      });
      return detected.filter((entry) => entry.binary === "omp");
    };
    const body = (marker: string) => `#!/bin/sh\nprintf executed >> '${marker}'\nprintf '%s\\n' 'MUST_NOT_BE_RENDERED'\n`;

    const catalogDir = mkdtempSync(join(tmpdir(), "tickmarkr-catalog-only-"));
    const catalogMarker = join(catalogDir, "executed");
    const catalogPath = fakeBin(catalogDir, "omp", body(catalogMarker));
    expect(detectOmp(fixturePath(catalogDir))).toEqual([{ binary: "omp", path: catalogPath }]);
    expect(existsSync(catalogMarker)).toBe(false);

    const shadowA = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-shadow-a-"));
    const shadowB = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-shadow-b-"));
    const shadowMarkerA = join(shadowA, "executed");
    const shadowMarkerB = join(shadowB, "executed");
    const shadowPathA = fakeBin(shadowA, "omp", body(shadowMarkerA));
    fakeBin(shadowB, "omp", body(shadowMarkerB));
    expect(detectOmp(fixturePath(shadowA, shadowB))).toEqual([{ binary: "omp", path: shadowPathA }]);
    expect(existsSync(shadowMarkerA)).toBe(false);
    expect(existsSync(shadowMarkerB)).toBe(false);

    const targetDir = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-target-"));
    const linkDir = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-link-"));
    const symlinkMarker = join(targetDir, "executed");
    const target = fakeBin(targetDir, "omp-target", body(symlinkMarker));
    const link = join(linkDir, "omp");
    symlinkSync(target, link);
    expect(detectOmp(fixturePath(linkDir))).toEqual([{ binary: "omp", path: link }]);
    expect(existsSync(symlinkMarker)).toBe(false);
  });

  test("test: shadow warnings count distinct realpaths, proven over the closed set of PATH shapes — a repeated-directory fixture emits none, a two-distinct-install fixture emits one naming both, and a symlink-to-listed-target fixture emits none", () => {
    const adapter = stub("shadow-fixture", "shadow-fixture");
    const health = { "shadow-fixture": { installed: true, authed: true, models: [] } };
    const warningsFor = (pathEnv: string) => binaryShadowWarnings(
      [adapter],
      health,
      binDir,
      (binary, cwd) => resolveShellBinary(binary, cwd, pathEnv),
    );

    const repeatedDir = mkdtempSync(join(tmpdir(), "tickmarkr-shadow-repeat-"));
    fakeBin(repeatedDir, "shadow-fixture", "#!/bin/sh\nexit 0\n");
    expect(warningsFor([repeatedDir, repeatedDir, GIT_BIN_DIR, "/bin", "/usr/bin"].join(":"))).toEqual([]);

    const distinctA = mkdtempSync(join(tmpdir(), "tickmarkr-shadow-distinct-a-"));
    const distinctB = mkdtempSync(join(tmpdir(), "tickmarkr-shadow-distinct-b-"));
    const distinctPathA = fakeBin(distinctA, "shadow-fixture", "#!/bin/sh\nexit 0\n");
    const distinctPathB = fakeBin(distinctB, "shadow-fixture", "#!/bin/sh\nexit 0\n");
    const distinctWarnings = warningsFor(fixturePath(distinctA, distinctB));
    expect(distinctWarnings).toHaveLength(1);
    expect(distinctWarnings[0]).toContain(distinctPathA);
    expect(distinctWarnings[0]).toContain(distinctPathB);

    const targetDir = mkdtempSync(join(tmpdir(), "tickmarkr-shadow-target-"));
    const linkDir = mkdtempSync(join(tmpdir(), "tickmarkr-shadow-link-"));
    const target = fakeBin(targetDir, "shadow-fixture", "#!/bin/sh\nexit 0\n");
    symlinkSync(target, join(linkDir, "shadow-fixture"));
    expect(warningsFor(fixturePath(linkDir, targetDir))).toEqual([]);
  });
});
