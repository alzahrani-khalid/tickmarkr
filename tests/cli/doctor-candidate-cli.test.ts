import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { projectCliEntries, SHIPPED_CLI_CATALOG } from "../../src/adapters/catalog.js";
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

// OBS-503: admitting git's whole DIRECTORY leaked every sibling binary (homebrew: /opt/homebrew/bin)
// into the "hermetic" candidate PATH — any catalog candidate the operator installed via homebrew
// (prime-agent) rendered a machine-truth advisory row the member-by-member oracle rejects. Link git
// alone into a dedicated tool dir so the fixture PATH admits exactly the tools the tests name.
const GIT_TOOL_DIR = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-git-"));
symlinkSync(execSync("command -v git", { encoding: "utf8" }).trim(), join(GIT_TOOL_DIR, "git"));
const fixturePath = (...dirs: string[]) => [...new Set([...dirs, GIT_TOOL_DIR, "/bin", "/usr/bin"])].join(":");

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

// v1.89 T2: omp now ships a drive contract, so it is an ADAPTER here, not the advisory fixture.
// Every guard below re-points at gemini — still a bare string in catalog.ts — so the
// detected-not-routable class keeps a live instance rather than being retired by the change.
const ADVISORY_FIXTURE = "gemini";
// Native adapters declare their binary in hardcodedFlags; a catalog-driven one carries it in the
// entry. Derive from the shipped catalog so neither kind can fall out of this fixture silently.
const registryBinaries = (): Map<string, string> =>
  new Map(projectCliEntries(SHIPPED_CLI_CATALOG).routable.map((entry) => [entry.id, entry.binary]));

function contradictionIds(rows: CapabilityRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

let pathPrev: string | undefined;
let homePrev: string | undefined;
let binDir: string;
let adapters: WorkerAdapter[];

// Shared by the describe below and the top-level enrolment test: the acceptance oracle anchors its
// -t filter on the runner-visible FULL name (describe titles + test title), so a criterion-titled
// test cannot live under a describe — it enters and leaves this fixture environment itself.
const enterCandidateEnv = () => {
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
    // A catalog-driven adapter's probe IS the contract under test (identity regex over the real
    // banner), and probeAll cannot substitute a shell probe for it — leave it live so the fixture
    // binary's own bytes decide installed/authed rather than a mock.
    if (adapter.hardcodedFlags) vi.spyOn(adapter, "probe").mockResolvedValue({ installed: false, authed: false, models: [] });
    if (adapter.listModels) vi.spyOn(adapter, "listModels").mockResolvedValue([]);
    if (adapter.trust) vi.spyOn(adapter, "trust").mockReturnValue({ status: "trusted" });
  }
};

const leaveCandidateEnv = () => {
  vi.restoreAllMocks();
  if (pathPrev !== undefined) process.env.PATH = pathPrev;
  else delete process.env.PATH;
  if (homePrev !== undefined) process.env.HOME = homePrev;
  else delete process.env.HOME;
};

test("the production adapter enumeration over the shipped catalog yields qwen and omp as routable adapters, names omp exactly once in the doctor matrix, and keeps gemini as the detected-not-routable advisory fixture", async () => {
  enterCandidateEnv();
  try {
    // Enumeration first: allAdapters() over the SHIPPED catalog, not a fixture array.
    expect(allAdapters({ cliEntries: SHIPPED_CLI_CATALOG }).map((adapter) => adapter.id)).toEqual([
      "claude-code", "codex", "cursor-agent", "opencode", "pi", "grok", "kimi", "qwen", "omp", "agy", "prime-agent",
    ]);
    expect(CANDIDATE_CLI_CATALOG).toContain(ADVISORY_FIXTURE);
    expect(CANDIDATE_CLI_CATALOG).not.toContain("omp");

    // Then the rendered matrix, with both an omp and an advisory binary present on PATH.
    fakeBin(binDir, "omp", "#!/bin/sh\nprintf '%s\\n' 'omp/17.2.10'\n");
    const advisoryPath = fakeBin(binDir, ADVISORY_FIXTURE, "#!/bin/sh\nexit 97\n");
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, adapters, {
      banner: false,
      resolveClaudeAliasIdentity: () => undefined,
    });
    const rows = capabilityRows(out);

    expect(rows.filter((row) => row.id === "omp")).toEqual([
      { id: "omp", value: "omp/17.2.10 (auth assumed; verified at dispatch (failover on auth/quota errors))" },
    ]);
    expect(rows.filter((row) => row.id === "omp" && row.value.includes("not routable"))).toEqual([]);
    expect(rows.filter((row) => row.id === ADVISORY_FIXTURE)).toEqual([
      { id: ADVISORY_FIXTURE, value: `detected at ${advisoryPath} (no drive contract — not routable)` },
    ]);
  } finally {
    leaveCandidateEnv();
  }
});

describe("doctor candidate-CLI truth (v1.86 T12)", () => {
  beforeEach(enterCandidateEnv);
  afterEach(leaveCandidateEnv);

  test("test: no candidate-catalog name is also a registered adapter binary, proven over the binaries derived from allAdapters() rather than a hand-maintained list, and adding an adapter whose binary is in the catalog fails the guard", () => {
    const assertNoCatalogCollision = (registry: WorkerAdapter[]) => {
      const binaries = registeredAdapterBinaries(registry);
      const collisions = CANDIDATE_CLI_CATALOG.filter((binary) => binaries.includes(binary));
      if (collisions.length) throw new Error(`candidate catalog collides with adapter binaries: ${collisions.join(", ")}`);
    };

    expect(registeredAdapterBinaries()).toEqual(adapters.map((adapter) => registryBinaries().get(adapter.id)));
    expect(() => assertNoCatalogCollision(adapters)).not.toThrow();

    const conflictingAdapter = stub(`${ADVISORY_FIXTURE}-adapter-fixture`, ADVISORY_FIXTURE);
    expect(() => assertNoCatalogCollision([...adapters, conflictingAdapter])).toThrow(new RegExp(`\\b${ADVISORY_FIXTURE}\\b`));
  });

  test("test: doctor's matrix names each installed binary exactly once with no id appearing as both an adapter row and a detected-not-routable row, proven member by member over the full registry — a claude-code fixture, a codex fixture, a cursor-agent fixture, an opencode fixture, a pi fixture, a grok fixture, a kimi fixture, a qwen fixture, an omp fixture, an agy fixture and a prime-agent fixture", async () => {
    for (const adapter of adapters) {
      const binary = registryBinaries().get(adapter.id);
      expect(binary, `${adapter.id} must declare its registry binary`).toBeTruthy();
      // Recorded banners for the identity-gated probes: `^omp/` and the bare-semver
      // `^\d+\.\d+\.\d+` gates (qwen, agy, prime-agent). An "<id> fixture 1.0.0" line would land
      // those rows as identity mismatches instead of installed.
      const banner = adapter.id === "omp" ? "omp/17.2.10"
        : adapter.id === "qwen" ? "0.21.15"
        : adapter.id === "agy" ? "1.1.12"
        : adapter.id === "prime-agent" ? "0.7.1"
        : `${adapter.id} fixture 1.0.0`;
      fakeBin(binDir, binary!, `#!/bin/sh\nprintf '%s\\n' '${banner}'\n`);
    }
    const advisoryPath = fakeBin(binDir, ADVISORY_FIXTURE, "#!/bin/sh\nexit 97\n");

    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, adapters, {
      banner: false,
      kimiTurnProbe: async () => ({ ok: true, evidence: "fixture" }),
      resolveClaudeAliasIdentity: () => undefined,
    });
    const health = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")) as Record<string, AuthHealth>;
    // herdr and tickmarkr-binary are ENVIRONMENT rows (driver presence, Q142s self-shadow of the
    // operator's live PATH) — real truths of the machine, not candidate-CLI matrix content. The
    // self-shadow row fires on any dev tree versioned ahead of the global install, which is every
    // pre-publish tree by construction.
    const rows = capabilityRows(out).filter((row) => row.id !== "herdr" && row.id !== "tickmarkr-binary");
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
      "qwen",
      "omp",
      "agy",
      "prime-agent",
    ]);
    expect(adapterRows.map((row) => row.id).sort()).toEqual(adapters.map((adapter) => adapter.id).sort());
    expect(advisoryRows).toEqual([{ id: ADVISORY_FIXTURE, value: `detected at ${advisoryPath} (no drive contract — not routable)` }]);
    const binaryClaims = [
      ...adapters.map((adapter) => ({ id: registryBinaries().get(adapter.id)!, value: `adapter:${adapter.id}` })),
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

  test("test: a gemini fixture on PATH renders one advisory detected row carrying no version string and appears in no discovered channel and no doctor.json health key", async () => {
    const executionMarker = join(binDir, `${ADVISORY_FIXTURE}-executed`);
    const advisoryPath = fakeBin(
      binDir,
      ADVISORY_FIXTURE,
      `#!/bin/sh\nprintf executed > '${executionMarker}'\nprintf '%s\\n' 'ADVISORY_VERSION_SENTINEL'\n`,
    );
    const repo = makeRepo({ "keep.txt": "x" });

    const out = await doctor(["--"], repo, adapters, {
      banner: false,
      resolveClaudeAliasIdentity: () => undefined,
    });
    const health = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")) as Record<string, AuthHealth>;
    const rows = capabilityRows(out).filter((row) => row.id === ADVISORY_FIXTURE);

    expect(rows).toEqual([{ id: ADVISORY_FIXTURE, value: `detected at ${advisoryPath} (no drive contract — not routable)` }]);
    expect(out).not.toContain("ADVISORY_VERSION_SENTINEL");
    expect(existsSync(executionMarker)).toBe(false);
    expect(health[ADVISORY_FIXTURE]).toBeUndefined();
    expect(discoverChannels(DEFAULT_CONFIG, adapters, health).map((channel) => channel.adapter)).not.toContain(ADVISORY_FIXTURE);
  });

  test("test: no advisory-only target is executed, proven over the closed set of resolution paths — a catalog entry without a drive block, a shadowed binary and a symlinked binary — each resolved for presence only", () => {
    const detectAdvisory = (pathEnv: string) => {
      process.env.PATH = pathEnv;
      const detected = detectCandidateClis({
        cwd: binDir,
        pathEnv,
      });
      return detected.filter((entry) => entry.binary === ADVISORY_FIXTURE);
    };
    const body = (marker: string) => `#!/bin/sh\nprintf executed >> '${marker}'\nprintf '%s\\n' 'MUST_NOT_BE_RENDERED'\n`;

    const catalogDir = mkdtempSync(join(tmpdir(), "tickmarkr-catalog-only-"));
    const catalogMarker = join(catalogDir, "executed");
    const catalogPath = fakeBin(catalogDir, ADVISORY_FIXTURE, body(catalogMarker));
    expect(detectAdvisory(fixturePath(catalogDir))).toEqual([{ binary: ADVISORY_FIXTURE, path: catalogPath }]);
    expect(existsSync(catalogMarker)).toBe(false);

    const shadowA = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-shadow-a-"));
    const shadowB = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-shadow-b-"));
    const shadowMarkerA = join(shadowA, "executed");
    const shadowMarkerB = join(shadowB, "executed");
    const shadowPathA = fakeBin(shadowA, ADVISORY_FIXTURE, body(shadowMarkerA));
    fakeBin(shadowB, ADVISORY_FIXTURE, body(shadowMarkerB));
    expect(detectAdvisory(fixturePath(shadowA, shadowB))).toEqual([{ binary: ADVISORY_FIXTURE, path: shadowPathA }]);
    expect(existsSync(shadowMarkerA)).toBe(false);
    expect(existsSync(shadowMarkerB)).toBe(false);

    const targetDir = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-target-"));
    const linkDir = mkdtempSync(join(tmpdir(), "tickmarkr-candidate-link-"));
    const symlinkMarker = join(targetDir, "executed");
    const target = fakeBin(targetDir, `${ADVISORY_FIXTURE}-target`, body(symlinkMarker));
    const link = join(linkDir, ADVISORY_FIXTURE);
    symlinkSync(target, link);
    expect(detectAdvisory(fixturePath(linkDir))).toEqual([{ binary: ADVISORY_FIXTURE, path: link }]);
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
    expect(warningsFor([repeatedDir, repeatedDir, GIT_TOOL_DIR, "/bin", "/usr/bin"].join(":"))).toEqual([]);

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
