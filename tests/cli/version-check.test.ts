import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const ENTRY = join(ROOT, "src/cli/index.ts");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;

describe("version --check (queue rows 210, 221; D-2118)", () => {
  afterEach(() => vi.restoreAllMocks());
  const check = (cwd: string) => {
    const result = spawnSync(process.execPath, ["--import", TSX_LOADER, ENTRY, "version", "--check"], { cwd, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { code: result.status, out: result.stdout + result.stderr };
  };
  const snapshot = (cwd: string) => Object.fromEntries(readdirSync(cwd, { recursive: true, encoding: "utf8" })
    .filter((file) => statSync(join(cwd, file)).isFile())
    .map((file) => [file, readFileSync(join(cwd, file))]));

  test("test: the version check where package.json is named tickmarkr exits zero when that version equals the binary's and non-zero naming both versions when it differs by one patch, while in a consumer whose app manifest names another version it never compares that manifest, so a check reading the app's package.json fails", () => {
    const repo = makeRepo({ "package.json": JSON.stringify({ name: "tickmarkr", version: PKG_VERSION }) });
    const equal = check(repo);
    expect(equal.code).toBe(0);
    expect(equal.out).toContain(`binary ${PKG_VERSION}`);
    expect(equal.out).toContain(`source repository package.json version ${PKG_VERSION}`);
    const [major, minor, patch] = PKG_VERSION.split(".");
    const next = `${major}.${minor}.${Number(patch) + 1}`;
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tickmarkr", version: next }));
    const different = check(repo);
    expect(different.code).toBe(1);
    expect(different.out).toContain(`binary ${PKG_VERSION}`);
    expect(different.out).toContain(`package.json version ${next}`);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "consumer-app", version: "99.88.77" }));
    const consumer = check(repo);
    expect(consumer.code).toBe(0);
    expect(consumer.out).not.toContain("99.88.77");
    expect(consumer.out).not.toContain("source repository");
    expect(consumer.out).toContain("no installed agent guidance");
  });

  test("test: the version check in a consumer after an agent init exits zero naming the guidance it compared, then non-zero naming the file once one installed skill byte changes and naming the refresh command once the block is edited, and notes no installed guidance in a bare repository, so a check that passes drifted guidance fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "package.json": JSON.stringify({ name: "consumer-app", version: "99.88.77" }), "CLAUDE.md": "App guidance\n" });
    await init(["--agent", "--docs", "--global-dir", makeTestTempDir("version-global-")], repo);
    const before = snapshot(repo);
    const current = check(repo);
    expect(current.code).toBe(0);
    expect(current.out).toContain("compared installed agent guidance with this binary's packaged block and skills");
    for (const host of [".agents", ".claude"]) {
      for (const skill of ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"]) {
        expect(current.out).toContain(`${host}/skills/${skill}/SKILL.md`);
      }
    }
    for (const doc of ["AGENTS.md", "CLAUDE.md"]) expect(current.out).toContain(doc);
    expect(current.out).not.toContain("99.88.77");
    expect(snapshot(repo)).toEqual(before);
    const skill = join(repo, ".claude/skills/tickmarkr-loop/SKILL.md");
    const freshSkill = readFileSync(skill);
    const changed = Buffer.from(freshSkill);
    changed[changed.length - 1] ^= 1;
    writeFileSync(skill, changed);
    const staleSkill = check(repo);
    expect(staleSkill.code).toBe(1);
    expect(staleSkill.out).toContain("modified .claude/skills/tickmarkr-loop/SKILL.md");
    writeFileSync(skill, freshSkill);
    const script = ".agents/skills/tickmarkr-overseer/scripts/watch-artifacts.sh";
    const freshScript = readFileSync(join(repo, script));
    rmSync(join(repo, script));
    const missing = check(repo);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`missing ${script}`);
    writeFileSync(join(repo, script), freshScript);
    for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(repo, doc);
      writeFileSync(path, readFileSync(path, "utf8").replace("### Version preflight", "### Stale preflight"));
    }
    const staleBlock = check(repo);
    expect(staleBlock.code).toBe(1);
    expect(staleBlock.out).toContain("stale agent-docs block in AGENTS.md");
    expect(staleBlock.out).toContain("stale agent-docs block in CLAUDE.md");
    expect(staleBlock.out).toContain("tickmarkr init --agent --force");
    await init(["--agent", "--force", "--global-dir", makeTestTempDir("version-refresh-")], repo);
    expect(check(repo).code).toBe(0);
    rmSync(join(repo, "package.json"));
    expect(check(repo).code).toBe(0);
    writeFileSync(join(repo, "AGENTS.md"), readFileSync(join(repo, "AGENTS.md"), "utf8").replace("### Version preflight", "### Stale preflight"));
    expect(check(repo).code).toBe(1);
    const bare = makeRepo({ "keep.txt": "x" });
    const nothing = check(bare);
    expect(nothing.code).toBe(0);
    expect(nothing.out).toContain("no installed agent guidance");
  });
});
