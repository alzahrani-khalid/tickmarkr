// Queue row 195 / D-2102: .tickmarkr/ is gitignored, so a fresh session worktree has no
// .tickmarkr/config.yaml of its own. ONE rule in repoOverlayPath: a linked worktree (a gitfile
// checkout whose trusted common dir lies outside it) with no overlay of its own reads
// dirname(common)/.tickmarkr/config.yaml when that file exists; every other case keeps its own
// path. Zero-token: scratch repos, an empty global layer, a cached fake doctor and an injected adapter.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import * as registry from "../../src/adapters/registry.js";
import { seedPreferLints } from "../../src/adapters/model-lints.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor } from "../../src/cli/commands/fleet.js";
import { compile } from "../../src/cli/commands/compile.js";
import {
  fleetKeyLayer,
  formatFleetPrint,
  loadConfig,
  loadConfigWithMode,
  overlayPreferShapes,
  repoOverlayPath,
  type TickmarkrConfig,
} from "../../src/config/config.js";
import { resolveRunMode } from "../../src/run/daemon.js";
import { assertGitTrust } from "../../src/run/git-trust.js";
import { createLiveStore } from "../../src/tui/cockpit/live-store.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A main checkout whose repo-layer overlay (untracked, as .tickmarkr/ is gitignored) is `yaml`. */
function mainWithConfig(yaml: string, files: Record<string, string> = {}): string {
  const repo = makeRepo({ ".gitignore": ".tickmarkr/\n.claude/\n", "src/owned.ts": "export const owned = true;\n", ...files });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return repo;
}

/** A session worktree nested at its main checkout's .claude/worktrees directory, detached at HEAD. */
function sessionWorktree(repo: string, name = "session"): string {
  const worktree = join(repo, ".claude", "worktrees", name);
  git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
  return worktree;
}

const emptyGlobal = (): string => makeTestTempDir("tickmarkr-global-");

const MAIN_OVERLAY = [
  "routing:",
  "  mode: staff-led",
  "  map:",
  "    tests: { prefer: [fake:fake-1] }",
  "tiers:",
  "  fake:",
  "    vendor: fake",
  "    channel: sub",
  "    models:",
  "      fake-1: frontier",
  "",
].join("\n");

const FLEET_OVERLAY = [
  "tiers:",
  "  fake:",
  "    vendor: fake",
  "    channel: sub",
  "    models:",
  "      fake-1: frontier",
  "      fake-2: frontier",
  "routing:",
  "  deny:",
  "    adapters: [fake]",
  "",
].join("\n");

const adapter: WorkerAdapter = {
  id: "fake",
  vendor: "fake",
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: (candidate: TickmarkrConfig) => channelsFromConfig("fake", candidate),
  headlessCommand: () => "fake",
  interactiveCommand: () => null,
  invoke: () => ({ command: "fake" }),
  parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  listModels: async () => [],
};

const freshHealth = () => ({
  fake: {
    installed: true,
    authed: true,
    version: "fake",
    models: ["fake-1", "fake-2"],
    modelAuth: {
      "fake-1": { authed: true, probedAt: new Date().toISOString() },
      "fake-2": { authed: true, probedAt: new Date().toISOString() },
    },
  },
});

describe("queue row 195 / D-2102: the linked worktree reads its main checkout's repo layer", () => {
  test("test: in a session worktree nested at its main checkout's .claude/worktrees directory with no config of its own, the loaded configuration, the run-mode resolver under a spec mode that differs from the main file's mode, the fleet print surface and doctor's seed-preference warnings each follow the main checkout's repository layer, a shape the main file prefers raising no default-seed warning there while a worktree config of its own takes precedence and brings that warning back, so a fallback applied in the loader alone, one the mode override drops or a preference lint that still reads only the worktree fails", () => {
    const repo = mainWithConfig(MAIN_OVERLAY);
    const worktree = sessionWorktree(repo);
    const globalDir = emptyGlobal();
    expect(existsSync(join(worktree, ".tickmarkr", "config.yaml"))).toBe(false);

    // The loaded configuration follows the main checkout's repository layer.
    const loaded = loadConfigWithMode(worktree, { globalDir });
    expect(loaded.cfg.routing.mode).toBe("staff-led");
    expect(loaded.cfg.routing.map.tests?.prefer).toEqual(["fake:fake-1"]);
    expect(loaded.cfg.tiers.fake?.models).toEqual({ "fake-1": "frontier" });
    expect(loaded.cfg).toEqual(loadConfig(repo, { globalDir }));

    // The run-mode resolver reads the main file, and a spec mode that differs from the main
    // file's mode re-resolves THROUGH that same overlay (the override drops none of it).
    const fromRepo = resolveRunMode(worktree, { globalDir });
    expect(fromRepo.source).toBe("repo config");
    expect(fromRepo.mode.mode).toBe("staff-led");
    const underSpec = resolveRunMode(worktree, { spec: "partner-led", globalDir });
    expect(underSpec.source).toBe("spec");
    expect(underSpec.mode.mode).toBe("partner-led");
    expect(underSpec.cfg.routing.map.tests?.prefer).toEqual(["fake:fake-1"]);
    expect(underSpec.cfg.tiers.fake?.models).toEqual({ "fake-1": "frontier" });

    // The fleet print surface follows the main file, with its keys attributed to the repo layer
    // (fleetKeyLayer is the annotation authority formatFleetPrint prints).
    const print = formatFleetPrint(worktree, { globalDir });
    expect(print).toContain("fake:fake-1");
    expect(print).toContain("mode: staff-led");
    expect(fleetKeyLayer(worktree, "routing.map.tests.prefer", { globalDir })).toBe("repo");
    expect(fleetKeyLayer(worktree, "routing.mode", { globalDir })).toBe("repo");
    expect(print).toBe(formatFleetPrint(repo, { globalDir }));

    // Doctor's seed-preference warnings: the main file prefers the tests shape, so the default
    // seed (opencode) raises no dead-adapter warning there.
    const shapes = overlayPreferShapes(worktree, { globalDir });
    expect(shapes.has("tests")).toBe(true);
    const lints = seedPreferLints(loaded.cfg, {}, [], shapes);
    expect(lints.some((lint) => lint.includes("'tests'"))).toBe(false);

    // A worktree config of its own takes precedence and brings that warning back.
    mkdirSync(join(worktree, ".tickmarkr"), { recursive: true });
    writeFileSync(join(worktree, ".tickmarkr", "config.yaml"), "routing:\n  mode: risk-based\n");
    const own = loadConfigWithMode(worktree, { globalDir });
    expect(own.cfg.routing.mode).toBe("risk-based");
    expect(own.cfg.tiers.fake).toBeUndefined();
    expect(overlayPreferShapes(worktree, { globalDir }).has("tests")).toBe(false);
    const ownLints = seedPreferLints(own.cfg, {}, [], overlayPreferShapes(worktree, { globalDir }));
    expect(ownLints).toContain("routing seed names dead adapter 'opencode' for shape 'tests' — no declared preference overrides it");
  });

  test("test: across linked worktree or main checkout, own config present or absent and main config present or absent, only the linked worktree with no config of its own over a present main file reads that file, a worktree's own file wins over the main one, and a main checkout, a main checkout's subdirectory, a directory enclosed by no checkout and a checkout that git trust refuses each read exactly the path they read before, so a fallback that fires outside a linked worktree or overrides a local file fails", () => {
    const ownOf = (root: string) => join(root, ".tickmarkr", "config.yaml");

    // linked worktree, own absent, main present → the main file
    const repo = mainWithConfig(MAIN_OVERLAY);
    const worktree = sessionWorktree(repo);
    expect(repoOverlayPath(worktree)).toBe(join(realpathSync(repo), ".tickmarkr", "config.yaml"));
    expect(loadConfig(worktree, { globalDir: emptyGlobal() }).routing.mode).toBe("staff-led");

    // linked worktree, own present → the worktree's own file wins over the main one
    mkdirSync(join(worktree, ".tickmarkr"), { recursive: true });
    writeFileSync(ownOf(worktree), "routing:\n  mode: risk-based\n");
    expect(repoOverlayPath(worktree)).toBe(ownOf(worktree));
    expect(loadConfig(worktree, { globalDir: emptyGlobal() }).routing.mode).toBe("risk-based");
    rmSync(ownOf(worktree));

    // linked worktree, own absent, main absent → the worktree's own (absent) path, as today
    const bare = makeRepo({ "keep.txt": "x\n" });
    const bareWorktree = sessionWorktree(bare);
    expect(repoOverlayPath(bareWorktree)).toBe(ownOf(bareWorktree));

    // main checkout, own present or absent → its own path
    expect(repoOverlayPath(repo)).toBe(ownOf(repo));
    expect(repoOverlayPath(bare)).toBe(ownOf(bare));

    // a main checkout's subdirectory → its own path (never the enclosing checkout's file)
    expect(repoOverlayPath(join(repo, "src"))).toBe(ownOf(join(repo, "src")));

    // a directory enclosed by no checkout → its own path
    const outside = makeTestTempDir("tickmarkr-plain-");
    expect(repoOverlayPath(outside)).toBe(ownOf(outside));

    // a checkout that git trust refuses (a gitfile naming a missing gitdir) → its own path
    const refused = makeTestTempDir("tickmarkr-refused-");
    writeFileSync(join(refused, ".git"), "gitdir: /nonexistent/tickmarkr-dead-gitdir\n");
    expect(repoOverlayPath(refused)).toBe(ownOf(refused));

    // Queue row 195 / D-2102: authorityOf still identifies these four linked layouts, but
    // assertGitTrust refuses their metadata. None may select the main checkout's overlay.
    for (const layout of ["missing commondir", "redirected commondir", "symlinked commondir", "worktree config"]) {
      const main = mainWithConfig(MAIN_OVERLAY);
      const linked = sessionWorktree(main);
      const gitdir = git(linked, ["rev-parse", "--absolute-git-dir"]);
      const commondir = join(gitdir, "commondir");
      if (layout === "missing commondir") {
        rmSync(commondir);
      } else if (layout === "redirected commondir") {
        writeFileSync(commondir, "../missing-common-directory\n");
      } else if (layout === "symlinked commondir") {
        const target = join(gitdir, "commondir-target");
        writeFileSync(target, readFileSync(commondir));
        rmSync(commondir);
        symlinkSync(target, commondir);
      } else {
        git(main, ["config", "extensions.worktreeConfig", "true"]);
        writeFileSync(join(gitdir, "config.worktree"), "[core]\n\tbare = false\n");
      }
      expect(() => assertGitTrust(linked), layout).toThrow();
      expect(repoOverlayPath(linked), layout).toBe(ownOf(linked));
      expect(loadConfigWithMode(linked, { globalDir: emptyGlobal() }).mode.mode, layout).toBe("risk-based");
    }
  });

  test("test: a native spec whose front-matter mode disagrees with the main checkout's repository routing mode and declares no override refuses to compile in a session worktree with no config of its own, naming both modes, so a compile that still proves only the worktree's own overlay fails", async () => {
    const spec = `<!-- tickmarkr:spec -->\nmode: staff-led\n## T1: Native task\n- goal: Compile one native task.\n- shape: implement\n- complexity: 2\n- files: src/owned.ts\n- acceptance:\n  - judge: Native task holds\n`;
    const repo = mainWithConfig("routing:\n  mode: partner-led\n", { "feature.spec.md": spec });
    const worktree = sessionWorktree(repo);
    expect(existsSync(join(worktree, ".tickmarkr", "config.yaml"))).toBe(false);

    await expect(compile(["feature.spec.md"], worktree)).rejects.toThrow(/staff-led[\s\S]*partner-led[\s\S]*mode-override: true/);

    // The disagreement is with the MAIN checkout's mode: the same spec carries no refusal where
    // the repository overlay declares the spec's own mode.
    const agreeing = mainWithConfig("routing:\n  mode: staff-led\n", { "feature.spec.md": spec });
    await expect(compile(["feature.spec.md", "--dry-run"], sessionWorktree(agreeing))).resolves.toContain("validated feature.spec.md");
  });

  test("test: a fleet save made from a session worktree with no config of its own writes that worktree's own overlay and leaves the main checkout's file byte-unchanged, so a save that follows the read fallback into the main checkout fails", async () => {
    const repo = makeRepo({ ".gitignore": ".tickmarkr/\n.claude/\n", "keep.txt": "x\n" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), FLEET_OVERLAY);
    const mainConfig = join(repo, ".tickmarkr", "config.yaml");
    const worktree = join(repo, ".claude", "worktrees", "session");
    git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
    // the doctor cache is per-checkout state (only the config overlay falls back), so the worktree
    // carries its own cached probe — but still no config.yaml of its own
    registry.writeDoctor(worktree, freshHealth());
    const ownPath = join(worktree, ".tickmarkr", "config.yaml");
    expect(existsSync(ownPath)).toBe(false);
    const globalDir = makeTestTempDir("tickmarkr-fleet-wt-g-");

    const assembled = await assembleFleetEditor(worktree, [adapter], {}, { globalDir });
    if ("unavailable" in assembled) throw new Error(assembled.unavailable);
    const { props } = assembled;
    // the edit session reads the main checkout's repository layer through the fallback…
    expect(props.initialDenyAdapters).toEqual(["fake"]);

    // …but clearing that repo-held deny stages a diff against the worktree's OWN overlay path
    const review = props.reviewOverlay({
      denyAdapters: [],
      denyModels: [],
      denyWorkersAdapters: [],
      denyWorkersModels: [],
      classifications: [],
      selectedMode: props.initialMode,
      map: props.initialMap,
      steering: props.initialSteering,
    });
    if (review.kind !== "diff") throw new Error(`clearing the repo-held deny must stage a diff, got ${review.kind}`);
    expect(review.path).toBe(ownPath);

    const before = readFileSync(mainConfig, "utf8");
    const outcome = assembled.commit({ kind: "write", review });
    expect(outcome).toContain(`fleet: wrote ${ownPath}`);

    // the worktree's own overlay landed; the main checkout's file is byte-unchanged
    expect(existsSync(ownPath)).toBe(true);
    expect(readFileSync(mainConfig, "utf8")).toBe(before);
    // the writer clears the repo-held deny with an explicit null tombstone (the overlay convention),
    // so the worktree's own loads no longer deny fake while the main checkout's still do
    const written = parse(readFileSync(ownPath, "utf8")) as { routing?: { deny?: { adapters?: unknown } } };
    expect(written.routing?.deny?.adapters).toBeNull();
    expect(loadConfigWithMode(worktree, { globalDir }).cfg.routing.deny?.adapters).toBeUndefined();
    expect(loadConfigWithMode(repo, { globalDir }).cfg.routing.deny?.adapters).toEqual(["fake"]);
  }, 120_000);

  test("the cockpit's live config source re-resolves the repo-layer path on every observation", () => {
    const RUN = "run-20261017-000000-0000000000000195";
    const realOverlay = (dir: string): string => join(realpathSync(dir), ".tickmarkr", "config.yaml");
    const reading = (store: ReturnType<typeof createLiveStore>) => { store.refresh(); return store.snapshot().config; };

    // Main fallback at construction, then an own overlay appears: the next observation reads it.
    const repo = mainWithConfig(MAIN_OVERLAY);
    const worktree = sessionWorktree(repo);
    const store = createLiveStore({ cwd: worktree, runId: RUN });
    expect(reading(store)).toMatchObject({ status: "readable", source: realOverlay(repo), value: MAIN_OVERLAY });
    mkdirSync(join(worktree, ".tickmarkr"), { recursive: true });
    writeFileSync(join(worktree, ".tickmarkr", "config.yaml"), FLEET_OVERLAY);
    expect(reading(store)).toMatchObject({ status: "readable", value: FLEET_OVERLAY });
    expect(reading(store).source).toBe(join(worktree, ".tickmarkr", "config.yaml"));

    // Own overlay at construction, then removed while the main file exists: the main file is read again.
    const ownFirst = createLiveStore({ cwd: worktree, runId: RUN });
    expect(reading(ownFirst)).toMatchObject({ status: "readable", value: FLEET_OVERLAY });
    rmSync(join(worktree, ".tickmarkr", "config.yaml"));
    expect(reading(ownFirst)).toMatchObject({ status: "readable", source: realOverlay(repo), value: MAIN_OVERLAY });

    // Both absent at construction, then the main file appears: the next observation reads it.
    const bare = makeRepo({ ".gitignore": ".tickmarkr/\n.claude/\n", "src/owned.ts": "export const owned = true;\n" });
    const bareWorktree = sessionWorktree(bare);
    const absentFirst = createLiveStore({ cwd: bareWorktree, runId: RUN });
    expect(reading(absentFirst).status).toBe("absent");
    mkdirSync(join(bare, ".tickmarkr"), { recursive: true });
    writeFileSync(join(bare, ".tickmarkr", "config.yaml"), MAIN_OVERLAY);
    expect(reading(absentFirst)).toMatchObject({ status: "readable", source: realOverlay(bare), value: MAIN_OVERLAY });

    // An explicit configPath stays fixed whatever appears beside it.
    const pinned = join(makeTestTempDir("tickmarkr-pinned-"), "config.yaml");
    const explicit = createLiveStore({ cwd: bareWorktree, runId: RUN, configPath: pinned });
    expect(reading(explicit)).toMatchObject({ status: "absent", source: pinned });
    mkdirSync(join(bareWorktree, ".tickmarkr"), { recursive: true });
    writeFileSync(join(bareWorktree, ".tickmarkr", "config.yaml"), FLEET_OVERLAY);
    expect(reading(explicit)).toMatchObject({ status: "absent", source: pinned });
  }, 60_000);
});
