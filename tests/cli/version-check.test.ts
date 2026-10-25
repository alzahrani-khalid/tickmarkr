import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { version } from "../../src/cli/commands/version.js";
import { gitSync } from "../../src/run/git.js";
import { SHIPPED_DIGESTS, SHIPPED_RELEASES, SHIPPED_SNAPSHOTS } from "../../src/cli/shipped-skill-files.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const ENTRY = join(ROOT, "src/cli/index.ts");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
// The shipped-bytes rows read released files with `git show <tag>:…`. A tagless or shallow checkout (the public export,
// public CI) holds no release objects, so each such row runs where its release tags are present and is skipped by name
// elsewhere: the provenance check's own advisory rule for a tagless checkout (queue row 244; D-2155).
const RETIRED_SCRIPT_TAG = Object.keys(SHIPPED_RELEASES).find((tag) => {
  const index = SHIPPED_RELEASES[tag]!["tickmarkr-overseer"];
  return index !== undefined && SHIPPED_SNAPSHOTS["tickmarkr-overseer"]![index]!["scripts/classify-vitest-log.sh"] !== undefined;
})!;
const tagged = (...tags: string[]): boolean =>
  tags.every((tag) => gitSync(ROOT, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]).status === 0);

vi.mock("../../src/cli/shipped-skill-files.js", async (original) => {
  const real = await original<typeof import("../../src/cli/shipped-skill-files.js")>();
  return { ...real, SHIPPED_DIGESTS: [...real.SHIPPED_DIGESTS], SHIPPED_SNAPSHOTS: { ...real.SHIPPED_SNAPSHOTS } };
});

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

  // Queue row 244 (D-2141; D-2152): ownership is decided before reading private user content.
  test("unmarked user skills with unreadable files or directories stay untouched and unlisted through check, install, force refresh and complete removal", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    for (const shape of ["file", "directory"]) {
      const user = ".agents/skills/my-skill";
      const repo = makeRepo({
        [`${user}/SKILL.md`]: "user guidance\n",
        [`${user}/secret.key`]: "private file bytes\n",
        [`${user}/private/secret.key`]: "private directory bytes\n",
      });
      const before = snapshot(join(repo, user));
      const unreadable = join(repo, user, shape === "file" ? "secret.key" : "private");
      const mode = lstatSync(unreadable).mode & 0o777;
      const runInit = (...args: string[]) => init(["--yes", "--global-dir", makeTestTempDir("private-skill-global-"), ...args], repo);
      chmodSync(unreadable, 0);
      try {
        const own = check(repo);
        expect(own.code, own.out).toBe(0);
        expect(own.out).toContain("no installed agent guidance");
        expect(own.out).not.toContain(user);
        for (const args of [["--agent", "--docs"], ["--agent", "--force"], ["--remove"]]) {
          const out = await runInit(...args);
          expect(out).not.toContain(join(repo, user));
          expect(lstatSync(unreadable).mode & 0o777).toBe(0);
          const current = check(repo);
          expect(current.code, current.out).toBe(0);
          expect(current.out).not.toContain(user);
          expect(current.out).toContain(args.includes("--remove") ? "no installed agent guidance" : "installed guidance matches");
        }
        expect(existsSync(join(repo, ".tickmarkr"))).toBe(false);
        expect(existsSync(join(repo, ".agents/skills/tickmarkr-overseer"))).toBe(false);
        expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(false);
        expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).not.toContain("<!-- tickmarkr:agent-docs begin -->");
      } finally { chmodSync(unreadable, mode); }
      expect(snapshot(join(repo, user))).toEqual(before);
    }
  });

  // Queue row 244 (D-2141; D-2152): links do not make unrelated user skills installed guidance.
  test("user skills with nested, directory and dangling links stay untouched and unlisted with or without a clean install", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    for (const installed of [false, true]) {
      const userSkills = {
        "my-skill": "user guidance\n",
        partial: "---\ninstalled-by: tickmarkr\n---\n",
        foreign: "---\nmetadata:\n  installed-by: other\n---\n",
      };
      const repo = makeRepo(Object.fromEntries(Object.entries(userSkills)
        .map(([name, bytes]) => [`.agents/skills/${name}/SKILL.md`, bytes])));
      const target = makeTestTempDir("user-skill-target-");
      const targetBytes = "---\nmetadata:\n  installed-by: tickmarkr\n---\nstale linked guidance\n";
      writeFileSync(join(target, "SKILL.md"), targetBytes);
      const links = [...Object.keys(userSkills).map((name) => `.agents/skills/${name}/assets`),
        ".agents/skills/other", ".agents/skills/dangling"];
      for (const path of links) symlinkSync(path.endsWith("/dangling") ? join(target, "absent") : target, join(repo, path));
      const runInit = (...args: string[]) => init(["--yes", "--global-dir", makeTestTempDir("user-skill-global-"), ...args], repo);
      if (installed) await runInit("--agent", "--docs");
      const current = check(repo);
      expect(current.code).toBe(0);
      expect(current.out).toContain(installed ? "installed guidance matches" : "no installed agent guidance");
      const userNames = [...Object.keys(userSkills), "other", "dangling"];
      for (const name of userNames) expect(current.out).not.toContain(`.agents/skills/${name}`);
      for (const args of [[], ["--agent"], ["--agent", "--force"], ["--remove"]]) {
        const out = await runInit(...args);
        for (const name of userNames) expect(out).not.toContain(join(repo, ".agents/skills", name));
        for (const [name, bytes] of Object.entries(userSkills))
          expect(readFileSync(join(repo, ".agents/skills", name, "SKILL.md"), "utf8")).toBe(bytes);
        for (const path of links) {
          expect(lstatSync(join(repo, path)).isSymbolicLink()).toBe(true);
          expect(readlinkSync(join(repo, path))).toBe(path.endsWith("/dangling") ? join(target, "absent") : target);
        }
        expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(targetBytes);
      }
      expect(check(repo).code).toBe(0);
      expect(check(repo).out).toContain("no installed agent guidance");
    }
  });

  // Queue row 244 (D-2141; D-2152): leftovers alone are installed guidance, with path-specific remedies.
  test.skipIf(!tagged(RETIRED_SCRIPT_TAG))("test: version check lists each proven leftover and each unproven file or directory by path and exits non-zero with a remedy naming that path, telling the reader to move an added file out of the skill directory, also in a consumer whose only tickmarkr content is a leftover, while a clean install and an unmarked user skill read current, so a check that passes a leftover-only consumer or lists a user's own skill fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const userSkill = ".agents/skills/my-own-skill/SKILL.md";
    const repo = makeRepo({ "keep.txt": "consumer\n", [userSkill]: "user guidance\n", "CLAUDE.md": "consumer\n" });
    await init(["--agent", "--docs", "--yes", "--global-dir", makeTestTempDir("version-proof-")], repo);
    const clean = check(repo);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("installed guidance matches");
    expect(clean.out).not.toContain("my-own-skill");
    const dir = ".agents/skills/tickmarkr-overseer";
    const retired = `${dir}/scripts/classify-vitest-log.sh`;
    const release = Object.keys(SHIPPED_RELEASES).find((tag) => {
      const index = SHIPPED_RELEASES[tag]!["tickmarkr-overseer"];
      return index !== undefined && SHIPPED_SNAPSHOTS["tickmarkr-overseer"]![index]!["scripts/classify-vitest-log.sh"] !== undefined;
    })!;
    const released = gitSync(ROOT, ["show", `${release}:skills/tickmarkr-overseer/scripts/classify-vitest-log.sh`]);
    expect(released.status, released.stderr).toBe(0);
    const added = `${dir}/user.txt`;
    writeFileSync(join(repo, added), "user file\n");
    const addedOnly = check(repo);
    expect(addedOnly.code).toBe(1);
    expect(addedOnly.out).toContain(`move ${added} out of the skill directory`);
    expect(addedOnly.out).not.toContain("--force");
    writeFileSync(join(repo, retired), released.stdout);
    const extraDirectory = `${dir}/empty-user-directory`;
    mkdirSync(join(repo, extraDirectory));
    const modified = `${dir}/scripts/watch-panes.sh`;
    writeFileSync(join(repo, modified), "changed shipped file\n");
    const missing = `${dir}/scripts/watch-artifacts.sh`;
    rmSync(join(repo, missing));
    const forged = ".agents/skills/forged";
    mkdirSync(join(repo, forged));
    writeFileSync(join(repo, forged, "SKILL.md"), "---\nname: forged\nmetadata:\n  installed-by: tickmarkr\n---\nuser-created marker\n");
    const empty = ".claude/skills/tickmarkr-loop";
    rmSync(join(repo, empty), { recursive: true });
    mkdirSync(join(repo, empty));
    const before = snapshot(repo);
    const result = check(repo);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`leftover ${retired}; remove ${retired} with tickmarkr init --agent`);
    for (const path of [added, extraDirectory, modified, forged, `${forged}/SKILL.md`, empty]) {
      expect(result.out).toContain(`unproven ${path}`);
      expect(result.out.split("\n").find((line) => line.startsWith(`unproven ${path};`)), path).toContain(path);
    }
    expect(result.out).toContain(`move ${added} out of the skill directory`);
    expect(result.out.split("\n").find((line) => line.startsWith(`unproven ${added};`))).not.toContain("--force");
    expect(result.out).toContain(`modified ${modified}; refresh ${modified} with tickmarkr init --agent --force`);
    expect(result.out).toContain(`missing ${missing}; refresh ${missing} with tickmarkr init --agent --force`);
    expect(result.out).not.toContain("my-own-skill");
    expect(snapshot(repo)).toEqual(before);

    const only = makeRepo({ "keep.txt": "consumer only\n", [retired]: released.stdout });
    const onlyBefore = snapshot(only);
    const leftoverOnly = check(only);
    expect(leftoverOnly.code).toBe(1);
    expect(leftoverOnly.out).toContain(`leftover ${retired}`);
    expect(leftoverOnly.out).toContain(`remove ${retired} with tickmarkr init --agent`);
    expect(leftoverOnly.out).not.toContain("no installed agent guidance");
    expect(snapshot(only)).toEqual(onlyBefore);
    const own = makeRepo({ [userSkill]: "user guidance\n" });
    expect(check(own).code).toBe(0);
    expect(check(own).out).not.toContain("my-own-skill");

    // No live retired name exists yet. Supply one complete historical snapshot,
    // then check its leftover-only consumer through the same command handler.
    const retiredName = "tickmarkr-retired-version";
    const retiredSkillPath = `.agents/skills/${retiredName}`;
    const skillBytes = `---\nname: ${retiredName}\n---\nreleased guidance\n`;
    const digestCount = SHIPPED_DIGESTS.length;
    const index = (SHIPPED_DIGESTS as string[]).push(createHash("sha256").update(skillBytes).digest("hex")) - 1;
    (SHIPPED_SNAPSHOTS as Record<string, Record<string, number>[]>)[retiredName] = [{ "SKILL.md": index }];
    try {
      const retiredRepo = makeRepo({ [`${retiredSkillPath}/SKILL.md`]: skillBytes });
      const before = snapshot(retiredRepo);
      await expect(version(["--check"], undefined, retiredRepo)).rejects.toThrow(`leftover ${retiredSkillPath}; remove ${retiredSkillPath} with tickmarkr init --agent`);
      expect(snapshot(retiredRepo)).toEqual(before);
    } finally {
      delete (SHIPPED_SNAPSHOTS as Record<string, unknown>)[retiredName];
      (SHIPPED_DIGESTS as string[]).length = digestCount;
    }
  });

  test("test: a consumer block whose version check sentence was edited reads as a stale block in version check and in a plain init, naming the file and the agent force refresh, and the refresh restores the rendered block, so a drift check keyed on text the block no longer carries fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "CLAUDE.md": "Consumer instructions\n", "package.json": '{"name":"consumer-app","version":"99.0.0"}' });
    const runInit = (...args: string[]) => init(["--global-dir", makeTestTempDir("version-diet-"), ...args], repo);
    await runInit("--agent", "--docs");
    expect(check(repo).code).toBe(0);
    const sentence = "Before `tickmarkr compile` or `tickmarkr run`, run `tickmarkr version --check` and stop on a non-zero exit.";
    for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(repo, doc);
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain(sentence);
      const edited = rendered.replace(sentence, "Skip the version check.");
      expect(edited).not.toBe(rendered);
      writeFileSync(path, edited);
      const stale = check(repo);
      expect(stale.code).toBe(1);
      expect(stale.out).toContain(`stale agent-docs block in ${doc}`);
      expect(stale.out).toContain("tickmarkr init --agent --force");
      const plain = await runInit();
      expect(plain).toContain(path);
      expect(plain).toContain("does not match this version");
      expect(plain).toContain("tickmarkr init --agent --force");
      expect(readFileSync(path, "utf8")).toBe(edited);
      await runInit("--agent", "--force");
      expect(readFileSync(path, "utf8")).toBe(rendered);
      expect(check(repo).code).toBe(0);
      expect(await runInit()).not.toContain("does not match this version");
    }
  });

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
      writeFileSync(path, readFileSync(path, "utf8").replace("Before `tickmarkr compile` or `tickmarkr run`, run `tickmarkr version --check` and stop on a non-zero exit.", "Skip the version check."));
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
    writeFileSync(join(repo, "AGENTS.md"), readFileSync(join(repo, "AGENTS.md"), "utf8").replace("Before `tickmarkr compile` or `tickmarkr run`, run `tickmarkr version --check` and stop on a non-zero exit.", "Skip the version check."));
    expect(check(repo).code).toBe(1);
    const bare = makeRepo({ "keep.txt": "x" });
    const nothing = check(bare);
    expect(nothing.code).toBe(0);
    expect(nothing.out).toContain("no installed agent guidance");
  });
});
