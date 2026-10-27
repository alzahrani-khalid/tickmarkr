import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { protectedFolderFinding } from "../../src/drivers/host-env.js";
import { preflightHostDriver } from "../../src/drivers/index.js";
import { canonicalWorktreePath } from "../../src/drivers/orca.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const platform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...originalPlatform, value });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no catalog fetch in test"); }));
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("test: the run and resume preflight prints one protected-folder warning naming the folder and both remedies when the repository or its state directory lies under the home Desktop, Documents or Downloads folder on darwin, and nothing for a sibling folder, another home folder or another platform, so a warning keyed on a name prefix fails", async () => {
  const home = canonicalWorktreePath(makeTestTempDir("protected-home-"));
  // The explicit preflight environment, rather than process.env.HOME, defines this home.
  vi.stubEnv("HOME", join(home, "different-home"));
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const folder of ["Desktop", "Documents", "Downloads"]) {
    for (const stateOnly of [false, true]) {
      const root = join(home, stateOnly ? `code-${folder}` : `${folder}/repo`);
      mkdirSync(root, { recursive: true });
      if (stateOnly) {
        const target = join(home, folder, "state");
        mkdirSync(target, { recursive: true });
        symlinkSync(target, join(root, ".tickmarkr"), "dir");
      }
      platform("darwin");
      // run and resume both use this same production preflight, including before state exists.
      for (const entry of ["run", "resume"]) {
        stderr.mockClear();
        await preflightHostDriver(DEFAULT_CONFIG, "subprocess", "none", root, { HOME: home });
        expect(stderr, `${entry}: ${folder}, state=${stateOnly}`).toHaveBeenCalledTimes(1);
        const text = String(stderr.mock.calls[0]![0]);
        expect(text).toContain(join(home, folder));
        expect(text).toContain("move the repository");
        expect(text).toContain("grant the app running tickmarkr Full Disk Access");
        expect(text.split("\n")).toHaveLength(2);
      }
    }
  }
  for (const [os, root] of [
    ["darwin", join(home, "DesktopX", "repo")],
    ["darwin", join(home, "Documents-old", "repo")],
    ["darwin", join(home, "Downloads2", "repo")],
    ["darwin", join(home, "Code", "repo")],
    ["darwin", join(home, "another-home", "Desktop", "repo")],
    ["linux", join(home, "Desktop", "repo")],
  ] as const) {
    platform(os);
    stderr.mockClear();
    await preflightHostDriver(DEFAULT_CONFIG, "subprocess", "none", root, { HOME: home });
    expect(stderr, `${os}: ${root}`).not.toHaveBeenCalled();
  }
  platform("darwin");
  stderr.mockClear();
  await preflightHostDriver(DEFAULT_CONFIG, "subprocess", "none", join(home, "Desktop", "repo"), {});
  expect(stderr).not.toHaveBeenCalled();
  // The finding is pure, and path normalization respects the exact directory boundary.
  expect(protectedFolderFinding(join(home, "Desktop"), join(home, "code"), "darwin", home)?.folder).toBe(join(home, "Desktop"));
  expect(protectedFolderFinding(join(home, "Desktop", "..", "DesktopX"), join(home, "code"), "darwin", home)).toBeUndefined();
  expect(protectedFolderFinding(join(home, "code"), join(home, "Downloads", "state"), "darwin", home)?.folder).toBe(join(home, "Downloads"));
});

test("test: doctor prints a folders warning row for a repository under a protected home folder on darwin and no folders row elsewhere, naming the same folder the preflight names, so a doctor that misses the folder the run warns about fails", async () => {
  const home = canonicalWorktreePath(makeTestTempDir("doctor-protected-home-"));
  vi.stubEnv("HOME", home);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const [os, name, stateOnly, warned] of [
    ["darwin", "Desktop", false, true],
    ["darwin", "Documents", false, true],
    ["darwin", "Downloads", false, true],
    ["darwin", "Desktop", true, true],
    ["darwin", "DesktopX", false, false],
    ["darwin", "Code", false, false],
    ["linux", "Desktop", false, false],
  ] as const) {
    platform(os);
    const source = makeRepo({ "base.txt": "base\n" });
    const parent = join(home, stateOnly ? "outside" : name);
    mkdirSync(parent, { recursive: true });
    const root = join(parent, `repo-${os}-${stateOnly}`);
    renameSync(source, root);
    if (stateOnly) {
      const state = join(home, name, "state");
      mkdirSync(state, { recursive: true });
      symlinkSync(state, join(root, ".tickmarkr"), "dir");
    }
    const output = await doctor([], root, [], { banner: false, resolveOrcaBinary: () => undefined });
    const rows = output.split("\n").filter(line => /^  ! folders\s/u.test(line));
    stderr.mockClear();
    await preflightHostDriver(DEFAULT_CONFIG, "subprocess", "none", root, { HOME: home });
    if (warned) {
      expect(rows, root).toHaveLength(1);
      expect(stderr, root).toHaveBeenCalledTimes(1);
      const finding = protectedFolderFinding(resolve(root), canonicalWorktreePath(join(root, ".tickmarkr")), os, home)!;
      expect(rows[0]).toContain(finding.detail);
      expect(String(stderr.mock.calls[0]![0])).toContain(finding.detail);
      expect(rows[0]).toContain(join(home, name));
    } else {
      expect(output, root).not.toMatch(/\bfolders\s/u);
      expect(stderr, root).not.toHaveBeenCalled();
    }
  }
}, 60_000);
