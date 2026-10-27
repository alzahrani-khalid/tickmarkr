import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const WAIT_COMMAND = "tickmarkr wait --timeout 23h 2>&1; c=$?; case $c in 0|3|4|5) exit 2;; esac; exit 0";
const PLUGIN_FILES = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "hooks/hooks.json",
  ...["register.tsx", "board.tsx", "model.ts", "state.d.ts", "register.test.tsx"].map(name => `hooks/board/${name}`)];
const SKILL_FILES = ["tickmarkr-auto", "tickmarkr-loop", "tickmarkr-overseer"].map((name) => `skills/${name}/SKILL.md`);
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const command = (): string => readJson("hooks/hooks.json").hooks.SessionStart[0].hooks[0].command;

function withWaitStub(check: (run: (code?: number) => ReturnType<typeof spawnSync>, calls: () => string[]) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-plugin-hook-"));
  const binary = join(dir, "tickmarkr");
  const log = join(dir, "calls");
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TICKMARKR_CALLS"\nexit "$TICKMARKR_WAIT_EXIT"\n', { mode: 0o755 });
  try {
    check((code) => {
      rmSync(log, { force: true });
      if (code === undefined) unlinkSync(binary);
      return spawnSync("/bin/sh", ["-c", command()], {
        cwd: dir,
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, PATH: dir, TICKMARKR_CALLS: log, TICKMARKR_WAIT_EXIT: String(code) },
      });
    }, () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packedPaths(): string[] {
  const cache = mkdtempSync(join(tmpdir(), "tickmarkr-plugin-npm-"));
  try {
    const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
    }));
    // npm 11 returns an array; npm 12 keys the same records by package name.
    const [pack] = (Array.isArray(result) ? result : Object.values(result)) as { files: { path: string }[] }[];
    return pack.files.map((file) => file.path);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function withExportCandidate(check: (root: string, paths: string[]) => void): void {
  if (!existsSync(join(ROOT, "scripts/export-public.sh"))) {
    check(ROOT, execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0"));
    return;
  }
  const clone = mkdtempSync(join(tmpdir(), "tickmarkr-plugin-export-"));
  let candidate: string | undefined;
  try {
    execFileSync("git", ["clone", "--local", "--quiet", ROOT, clone], { timeout: 30_000 });
    const output = execFileSync("bash", ["scripts/export-public.sh"], { cwd: clone, encoding: "utf8", timeout: 60_000 });
    candidate = /^export path: (.+)$/m.exec(output)?.[1].trim();
    if (!candidate) throw new Error(`export path missing from exporter output: ${output}`);
    check(candidate, execFileSync("git", ["ls-files", "-z"], { cwd: candidate, encoding: "utf8" }).split("\0"));
  } finally {
    if (candidate) rmSync(candidate, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
}

describe("Claude Code plugin package", () => {
  test("test: the plugin manifest names the tickmarkr plugin at the package's own version and declares no skill path, and the plugin's skill folder is the canonical skills directory with no second copy anywhere in the plugin, so a manifest version drifting from the package or a duplicated skill fails", () => {
    const pkg = readJson("package.json");
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest).toEqual({
      name: "tickmarkr",
      version: pkg.version,
      description: pkg.description,
      types: "./hooks/board/state.d.ts",
      author: { name: "Khalid Alzahrani", url: pkg.homepage },
      homepage: pkg.homepage,
      repository: pkg.repository.url,
      license: pkg.license,
      keywords: pkg.keywords,
    });
    expect(manifest).not.toHaveProperty("skills");
    expect(readdirSync(join(ROOT, ".claude-plugin")).sort()).toEqual(["marketplace.json", "plugin.json"]);
    const pluginRoot = resolve(ROOT, ".claude-plugin", "..");
    expect(realpathSync(join(pluginRoot, "skills"))).toBe(realpathSync(join(ROOT, "skills")));
    for (const path of SKILL_FILES) expect(existsSync(join(pluginRoot, path)), path).toBe(true);

    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: pluginRoot, encoding: "utf8",
    }).split("\0");
    // An init-installed .claude/skills tree is an accepted separate installation for this release.
    const skills = paths.filter((path) => path.endsWith("/SKILL.md") && !path.startsWith(".claude/"));
    expect([...new Set(skills)].sort()).toEqual([...SKILL_FILES].sort());
  });

  test("test: the marketplace file lists exactly one tickmarkr entry whose source is the published npm package of that name, so an entry installing from a relative path or another package fails", () => {
    const pkg = readJson("package.json");
    expect(readJson(".claude-plugin/marketplace.json")).toEqual({
      name: "tickmarkr",
      owner: { name: "Khalid Alzahrani", url: pkg.homepage },
      description: pkg.description,
      plugins: [{ name: "tickmarkr", source: { source: "npm", package: "tickmarkr" } }],
    });
  });

  test("test: the hooks file holds exactly one hook, the session-start command equal byte for byte to the prescribed wait command, and every tickmarkr invocation that command makes when run is that wait, so a hook that also runs approve or any other command fails", () => {
    expect(readJson("hooks/hooks.json")).toEqual({
      modules: ["./board/register.tsx"],
      hooks: {
        SessionStart: [{
          matcher: "startup|resume",
          hooks: [{ type: "command", command: WAIT_COMMAND, asyncRewake: true, timeout: 86400 }],
        }],
      },
    });
    withWaitStub((run, calls) => {
      const result = run(0);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(calls()).toEqual(["wait --timeout 23h"]);
    });
  });

  test("test: the session-start hook, run through the system shell against a stand-in tickmarkr exiting with each code of the closed wait table, exits two exactly for the run end, park, failed task and daemon death codes and zero for timeout, no live run, error and a missing binary, so a hook waking on a timeout fails", () => {
    const table = [
      { code: 0, cause: "run end", exit: 2 },
      { code: 1, cause: "error", exit: 0 },
      { code: 3, cause: "park", exit: 2 },
      { code: 4, cause: "failed task", exit: 2 },
      { code: 5, cause: "daemon death", exit: 2 },
      { code: 6, cause: "timeout", exit: 0 },
      { code: 7, cause: "no live run", exit: 0 },
      { code: 127, cause: "command not found", exit: 0 },
    ];
    withWaitStub((run, calls) => {
      for (const row of table) {
        const result = run(row.code);
        expect(result.error, row.cause).toBeUndefined();
        expect(result.signal, row.cause).toBeNull();
        expect(result.status, `${row.cause} (wait exit ${row.code})`).toBe(row.exit);
        expect(calls(), row.cause).toEqual(["wait --timeout 23h"]);
      }
      // Remove the binary with PATH confined to the fixture: this also exercises a real shell 127.
      const missing = run();
      expect(missing.error).toBeUndefined();
      expect(missing.status).toBe(0);
      expect(calls()).toEqual([]);
      expect(missing.stdout).toMatch(/tickmarkr.*not found/);
    });
  });

  test("test: the package's published file list and the public export candidate each carry the plugin manifest, the marketplace file and the hooks file beside the skills, so a plugin shipped in neither fails", { timeout: 120_000 }, () => {
    expect(readJson("package.json").files).toEqual(expect.arrayContaining([".claude-plugin", "hooks", "skills"]));
    const shipped = [...PLUGIN_FILES, ...SKILL_FILES];
    expect(packedPaths()).toEqual(expect.arrayContaining(shipped));
    withExportCandidate((root, paths) => {
      expect(paths).toEqual(expect.arrayContaining(shipped));
      for (const path of shipped) {
        expect(readFileSync(join(root, path)), path).toEqual(readFileSync(join(ROOT, path)));
      }
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(pkg.files).toEqual(expect.arrayContaining([".claude-plugin", "hooks", "skills"]));
      expect(pkg.tickmarkrExport.publicPaths.prefixes).toEqual(expect.arrayContaining([".claude-plugin/", "hooks/"]));
    });
  });
});
