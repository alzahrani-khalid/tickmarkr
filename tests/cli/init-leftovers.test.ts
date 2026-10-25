// Queue row 244 (D-2141; D-2152): complete snapshots, independent consumers, no model calls.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { version } from "../../src/cli/commands/version.js";
import { SHIPPED_DIGESTS, SHIPPED_RELEASES, SHIPPED_SNAPSHOTS } from "../../src/cli/shipped-skill-files.js";
import { gitSync } from "../../src/run/git.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const { question } = vi.hoisted(() => ({ question: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ question, close: vi.fn() }) }));
vi.mock("../../src/cli/shipped-skill-files.js", async (original) => {
  const real = await original<typeof import("../../src/cli/shipped-skill-files.js")>();
  return { ...real, SHIPPED_DIGESTS: [...real.SHIPPED_DIGESTS], SHIPPED_SNAPSHOTS: { ...real.SHIPPED_SNAPSHOTS } };
});
const ROOT = resolve(import.meta.dirname, "../..");
// The shipped-bytes rows read released files with `git show <tag>:…`. A tagless or shallow checkout (the public export,
// public CI) holds no release objects, so each such row runs where its release tags are present and is skipped by name
// elsewhere: the provenance check's own advisory rule for a tagless checkout (queue row 244; D-2155).
const RETIRED_SCRIPT_TAG = Object.keys(SHIPPED_RELEASES).find((tag) => {
  const index = SHIPPED_RELEASES[tag]!["tickmarkr-overseer"];
  return index !== undefined && SHIPPED_SNAPSHOTS["tickmarkr-overseer"]![index]!["scripts/classify-vitest-log.sh"] !== undefined;
})!;
const tagged = (...tags: string[]): boolean =>
  tags.every((tag) => gitSync(ROOT, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]).status === 0);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const put = (root: string, path: string, bytes: string | Buffer) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const marker = (name: string) => `---\nname: ${name}\nmetadata:\n  installed-by: tickmarkr\n---\n`;
const historyNames: string[] = [];
const originalDigestCount = SHIPPED_DIGESTS.length;
function history(name: string, releases: Record<string, string>[]) {
  historyNames.push(name);
  (SHIPPED_SNAPSHOTS as Record<string, Record<string, number>[]>)[name] = releases.map((files) => Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, (SHIPPED_DIGESTS as string[]).push(hash(bytes)) - 1]),
  ));
}
const snapshot = (root: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const walk = (path: string, rel: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) result[rel] = `link:${readlinkSync(path)}`;
    else if (stat.isDirectory()) {
      result[rel] = "directory";
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`);
    } else result[rel] = readFileSync(path).toString("base64");
  };
  walk(root, "");
  return result;
};
const runInit = (repo: string, ...args: string[]) => init(["--global-dir", makeTestTempDir("leftover-global-"), "--yes", ...args], repo);
function releasedFile(skill: string, path: string, tag = Object.keys(SHIPPED_RELEASES).find((release) => {
  const index = SHIPPED_RELEASES[release]![skill];
  return index !== undefined && SHIPPED_SNAPSHOTS[skill]![index]![path] !== undefined;
})!): string {
  const snapshot = SHIPPED_SNAPSHOTS[skill]![SHIPPED_RELEASES[tag]![skill]!]!;
  const result = gitSync(ROOT, ["show", `${tag}:skills/${skill}/${path}`]);
  expect(result.status, result.stderr).toBe(0);
  expect(hash(result.stdout)).toBe(SHIPPED_DIGESTS[snapshot[path]!]);
  return result.stdout;
}

afterEach(() => {
  vi.restoreAllMocks();
  question.mockReset();
  for (const name of historyNames.splice(0)) delete (SHIPPED_SNAPSHOTS as Record<string, unknown>)[name];
  (SHIPPED_DIGESTS as string[]).length = originalDigestCount;
});

test("links preserve their targets while unlinked modified and missing shipped files retain force remedies and refresh with consent", async () => {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  for (const shape of ["nested", "dangling", "scripts", "script-file", "skill-file", "dangling-skill-file"]) {
    const repo = makeRepo({ "keep.txt": "consumer\n" });
    const dir = join(repo, ".agents/skills/tickmarkr-overseer");
    cpSync(join(ROOT, "skills/tickmarkr-overseer"), dir, { recursive: true });
    const external = makeTestTempDir("stale-linked-guidance-");
    put(external, "watch-panes.sh", "stale external watcher\n");
    put(external, "SKILL.md", marker("tickmarkr-overseer") + "stale external guidance\n");
    const skillLinked = shape.endsWith("skill-file");
    const linkPath = join(dir, skillLinked ? "SKILL.md" : shape === "scripts" ? "scripts" : shape === "script-file" ? "scripts/grade-ci.sh" : "user/nested");
    rmSync(linkPath, { recursive: true, force: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    const target = shape.startsWith("dangling") ? join(external, "absent") : skillLinked ? join(external, "SKILL.md") : shape === "script-file" ? join(external, "watch-panes.sh") : external;
    symlinkSync(target, linkPath);
    const externalBefore = snapshot(external);
    const modifiedRel = skillLinked ? "scripts/grade-ci.sh" : "SKILL.md";
    const modified = join(dir, modifiedRel);
    const missing = join(dir, "scripts/watch-panes.sh");
    const edited = readFileSync(modified, "utf8") + "consumer edit\n";
    writeFileSync(modified, edited);
    if (shape !== "scripts") rmSync(missing);
    registry.writeDoctor(repo, {});
    const relativeSkill = ".agents/skills/tickmarkr-overseer";
    const check = await version(["--check"], undefined, repo).catch((error: Error) => error.message);
    expect(check).toContain(`unproven ${relativeSkill}/${modifiedRel}; refresh ${relativeSkill}/${modifiedRel} with tickmarkr init --agent --force`);
    expect(check).toContain(`modified ${relativeSkill}/${modifiedRel}; refresh ${relativeSkill}/${modifiedRel} with tickmarkr init --agent --force`);
    if (shape !== "scripts") expect(check).toContain(`missing ${relativeSkill}/scripts/watch-panes.sh; refresh ${relativeSkill}/scripts/watch-panes.sh with tickmarkr init --agent --force`);
    else expect(check).not.toContain(`missing ${relativeSkill}/scripts/`);
    expect(check).not.toContain(`move ${relativeSkill}/${modifiedRel} out of the skill directory`);
    const skipped = await runInit(repo, "--agent");
    expect(skipped).toContain(`skipped existing ${join(dir, "SKILL.md")}`);
    expect(skipped).toContain(`kept ${linkPath} (symbolic link)`);
    expect(readFileSync(modified, "utf8")).toBe(edited);
    if (shape !== "scripts") expect(existsSync(missing)).toBe(false);
    const refreshed = await runInit(repo, "--agent", "--force");
    expect(refreshed).toContain(`overwrote ${modified}`);
    expect(refreshed).toContain(`kept ${linkPath} (symbolic link)`);
    expect(refreshed).not.toContain(`overwrote ${linkPath}`);
    expect(refreshed).not.toContain(`wrote ${linkPath}`);
    expect(readFileSync(modified)).toEqual(readFileSync(join(ROOT, "skills/tickmarkr-overseer", modifiedRel)));
    if (shape !== "scripts") expect(readFileSync(missing)).toEqual(readFileSync(join(ROOT, "skills/tickmarkr-overseer/scripts/watch-panes.sh")));
    const current = await version(["--check"], undefined, repo).catch((error: Error) => error.message);
    expect(current).not.toMatch(/(?:missing|modified) \.agents\/skills\/tickmarkr-overseer\//);
    const removed = await runInit(repo, "--remove");
    expect(removed).toContain(`kept ${linkPath} (symbolic link)`);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(target);
    expect(snapshot(external)).toEqual(externalBefore);
  }
});

test.skipIf(!tagged("v2.8.1"))("pristine earlier installs keep their complete ownership proof when refresh is skipped and sweep retired files only after a forced or consented refresh", async () => {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, "ref").mockReturnValue(process.stdin);
  const name = "tickmarkr-overseer";
  const retired = "scripts/classify-vitest-log.sh";
  const old = SHIPPED_SNAPSHOTS[name]![SHIPPED_RELEASES["v2.8.1"]![name]!]!;
  const files = Object.fromEntries(Object.keys(old).map((path) => [path, releasedFile(name, path, "v2.8.1")]));
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    for (const mode of ["non-interactive", "declined", "forced", "consented"]) {
      const interactive = mode === "declined" || mode === "consented";
      const refreshed = mode === "forced" || mode === "consented";
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: interactive });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: interactive });
      question.mockReset().mockResolvedValue(mode === "consented" ? "yes" : "no");
      const repo = makeRepo({ "keep.txt": "consumer\n", "CLAUDE.md": "consumer guidance\n" });
      const dirs = [".agents", ".claude"].map((host) => join(repo, host, "skills", name));
      for (const dir of dirs) for (const [path, bytes] of Object.entries(files)) put(dir, path, bytes);
      const before = dirs.map(snapshot);
      registry.writeDoctor(repo, {});
      const out = await runInit(repo, "--agent", "--docs", ...(mode === "forced" ? ["--force"] : []));
      expect(question).toHaveBeenCalledTimes(interactive ? dirs.length : 0);
      for (const [i, dir] of dirs.entries()) {
        if (refreshed) {
          expect(snapshot(dir), mode).toEqual(snapshot(join(ROOT, "skills", name)));
          expect(out).toContain(`removed leftover ${join(dir, retired)}`);
          expect(out).toContain(`overwrote ${join(dir, "SKILL.md")}`);
        } else {
          expect(snapshot(dir), mode).toEqual(before[i]);
          expect(out).not.toContain(`removed leftover ${join(dir, retired)}`);
          expect(out).toContain(`skipped existing ${join(dir, "SKILL.md")}`);
          const path = `${[".agents", ".claude"][i]}/skills/${name}`;
          await expect(version(["--check"], undefined, repo)).rejects.toThrow(
            `leftover ${path}/${retired}; refresh ${path} with tickmarkr init --agent --force to remove ${path}/${retired}`,
          );
        }
      }
      // A skipped refresh must leave the same complete snapshot removable later.
      const removed = await runInit(repo, "--remove");
      for (const dir of dirs) {
        expect(existsSync(dir), mode).toBe(false);
        expect(removed).toContain(`removed leftover ${dir}`);
      }
    }
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test.skipIf(!tagged(RETIRED_SCRIPT_TAG, "v2.8.8"))("test: an agent init in a consumer whose marked installed overseer holds a retired script byte-equal to a released copy beside a user file deletes the script naming it and keeps the user file reporting it, and the force refresh of an unmarked older install does the same in its own run, so a sweep that deletes an unproven file or keeps a proven retired one fails", async () => {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  const retired = "scripts/classify-vitest-log.sh";
  const released = releasedFile("tickmarkr-overseer", retired);
  for (const older of [false, true]) {
    const repo = makeRepo({ "keep.txt": "consumer\n" });
    const dir = join(repo, ".agents/skills/tickmarkr-overseer");
    if (older) {
      const old = SHIPPED_SNAPSHOTS["tickmarkr-overseer"]![SHIPPED_RELEASES["v2.8.8"]!["tickmarkr-overseer"]!]!;
      for (const path of Object.keys(old)) put(dir, path, releasedFile("tickmarkr-overseer", path, "v2.8.8"));
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).not.toContain("installed-by: tickmarkr");
    } else cpSync(join(ROOT, "skills/tickmarkr-overseer"), dir, { recursive: true });
    put(dir, retired, released);
    put(dir, "user.txt", "user bytes\u0000\n");
    // The same released bytes at another path, or modified at the released path, prove nothing.
    put(dir, "scripts/user-copy.sh", released);
    const modifiedShipped = "scripts/grade-ci.sh";
    const userEdit = "user changed shipped script\n";
    put(dir, modifiedShipped, userEdit);
    const autoDir = join(repo, ".agents/skills/tickmarkr-auto");
    cpSync(join(ROOT, "skills/tickmarkr-auto"), autoDir, { recursive: true });
    put(autoDir, retired, released);
    const out = await runInit(repo, "--agent", ...(older ? ["--force"] : []));
    expect(existsSync(join(dir, retired))).toBe(false);
    expect(out).toContain(`removed leftover ${join(dir, retired)}`);
    for (const path of ["user.txt", "scripts/user-copy.sh"]) {
      expect(out).toContain(`kept ${join(dir, path)} (unproven)`);
    }
    expect(readFileSync(join(dir, "user.txt"), "utf8")).toBe("user bytes\u0000\n");
    expect(readFileSync(join(dir, "scripts/user-copy.sh"), "utf8")).toBe(released);
    expect(readFileSync(join(autoDir, retired), "utf8")).toBe(released);
    expect(out).toContain(`kept ${join(autoDir, retired)} (unproven)`);
    // Consent changes the shipped file and its completion note together.
    expect(readFileSync(join(dir, modifiedShipped))).toEqual(older
      ? readFileSync(join(ROOT, "skills/tickmarkr-overseer", modifiedShipped)) : Buffer.from(userEdit));
    if (older) {
      expect(out).toContain(`overwrote ${join(dir, modifiedShipped)}`);
      expect(out).not.toContain(`kept ${join(dir, modifiedShipped)} (unproven)`);
    } else expect(out).toContain(`kept ${join(dir, modifiedShipped)} (unproven)`);
    if (older) expect(readFileSync(join(dir, "SKILL.md"))).toEqual(readFileSync(join(ROOT, "skills/tickmarkr-overseer/SKILL.md")));
    put(dir, retired, "modified retired script\n");
    const modifiedOut = await runInit(repo, "--agent", "--force");
    expect(readFileSync(join(dir, retired), "utf8")).toBe("modified retired script\n");
    expect(modifiedOut).toContain(`kept ${join(dir, retired)} (unproven)`);
    expect(readFileSync(join(dir, modifiedShipped))).toEqual(readFileSync(join(ROOT, "skills/tickmarkr-overseer", modifiedShipped)));
    if (!older) {
      expect(modifiedOut).toContain(`overwrote ${join(dir, modifiedShipped)}`);
      expect(modifiedOut).not.toContain(`kept ${join(dir, modifiedShipped)} (unproven)`);
    }
  }
});

test("test: an agent init deletes a retired skill directory whose tree equals one release's complete snapshot of that skill, marked or not, and keeps byte for byte an empty directory, one holding only empty subdirectories, one holding a single historical file, one mixing files of two releases, one without its skill file, a matching-name renamed copy, a forged marker, a partial marker, a foreign installer's skill and an unmarked user skill, so deletion by marker, by name or by any proven subset fails", async () => {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  const name = "tickmarkr-retired";
  const first = { "SKILL.md": marker(name) + "release one\n", "scripts/old.sh": "one\n" };
  const second = { "SKILL.md": `---\nname: ${name}\n---\nrelease two\n`, "scripts/old.sh": "two\n" };
  history(name, [first, second]);
  const cases: { label: string; files: Record<string, string>; empty?: string; name?: string; remove?: boolean; unlisted?: boolean }[] = [
    { label: "marked complete", files: first, remove: true },
    { label: "unmarked complete", files: second, remove: true },
    { label: "empty", files: {} },
    { label: "empty directories", files: {}, empty: "empty/nested" },
    { label: "single historical file", files: { "scripts/old.sh": first["scripts/old.sh"] } },
    { label: "mixed releases", files: { ...first, "scripts/old.sh": second["scripts/old.sh"] } },
    { label: "missing skill file", files: { "scripts/old.sh": second["scripts/old.sh"] } },
    { label: "extra directory", files: first, empty: "extra-empty" },
    { label: "matching-name renamed copy", name: "tickmarkr-renamed", files: { ...first, "SKILL.md": first["SKILL.md"].replace(name, "tickmarkr-renamed") } },
    { label: "byte-identical renamed copy", name: "tickmarkr-copy", files: first },
    { label: "forged marker", files: { "SKILL.md": marker(name), "user.txt": "keep\n" } },
    { label: "partial marker", name: "partial", files: { "SKILL.md": "---\nname: partial\ninstalled-by: tickmarkr\n---\n" }, unlisted: true },
    { label: "metadata without owner", name: "partial-metadata", files: { "SKILL.md": "---\nmetadata: {}\n---\n" }, unlisted: true },
    { label: "foreign installer", name: "foreign", files: { "SKILL.md": "---\nmetadata:\n  installed-by: other\n---\n" }, unlisted: true },
    { label: "unmarked user skill", name: "user", files: { "SKILL.md": "user's own guidance\n" }, unlisted: true },
    { label: "unmarked user skill with an object property name", name: "constructor", files: { "SKILL.md": "user's own guidance\n" }, unlisted: true },
  ];
  for (const item of cases) {
    const repo = makeRepo({ "keep.txt": item.label });
    const dir = join(repo, ".agents/skills", item.name ?? name);
    mkdirSync(dir, { recursive: true });
    for (const [path, bytes] of Object.entries(item.files)) put(dir, path, bytes);
    if (item.empty) mkdirSync(join(dir, item.empty), { recursive: true });
    const before = snapshot(dir);
    // Queue row 244 (D-2141; D-2152): fixture-only repair; reuse empty discovery
    // instead of repeating unrelated host probes for every ownership case.
    registry.writeDoctor(repo, {});
    const out = await runInit(repo, "--agent", "--force");
    if (item.remove) {
      expect(existsSync(dir), item.label).toBe(false);
      expect(out).toContain(`removed leftover ${dir}`);
    } else {
      expect(snapshot(dir), item.label).toEqual(before);
      if (item.unlisted) expect(out).not.toContain(dir);
      else expect(out).toContain(`kept ${dir} (unproven)`);
    }
  }
});

test("test: with a linked host-root ancestor, a linked skills root, a linked reserved skill directory, a linked shipped skill file and a linked shipped scripts directory whose targets hold stale copies, a nested link and dangling links, an agent init, a force refresh and an init remove, each run in its own child process, exit normally, write and delete nothing through any link, keep every link and its target and every external tree byte for byte, and note each link, so a copy, sweep or removal that follows, replaces or aborts on a link fails", () => {
  const loader = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
  for (const action of [["--agent"], ["--agent", "--force"], ["--remove"]]) {
    for (const shape of ["ancestor", "skills", "skill", "file", "scripts", "nested", "dangling-root", "dangling-skill", "dangling-file", "dangling-scripts"]) {
      const repo = makeRepo({ "keep.txt": "consumer\n" });
      const external = makeTestTempDir("external-skill-");
      put(external, "skills/tickmarkr-overseer/SKILL.md", marker("tickmarkr-overseer") + "stale external\n");
      put(external, "skills/tickmarkr-overseer/scripts/watch-panes.sh", "stale watcher\n");
      put(external, "user.txt", "external user\n");
      const dir = join(repo, ".agents/skills/tickmarkr-overseer");
      const targetSkill = join(external, "skills/tickmarkr-overseer");
      const linkPath = shape === "ancestor" || shape === "dangling-root" ? join(repo, ".agents")
        : shape === "skills" ? join(repo, ".agents/skills")
        : shape === "skill" || shape === "dangling-skill" ? dir
        : shape === "file" || shape === "dangling-file" ? join(dir, "SKILL.md")
        : shape === "scripts" || shape === "dangling-scripts" ? join(dir, "scripts") : join(dir, "user/nested");
      if (!["ancestor", "skills", "skill", "dangling-root", "dangling-skill"].includes(shape)) {
        cpSync(join(ROOT, "skills/tickmarkr-overseer"), dir, { recursive: true });
        if (existsSync(linkPath)) rmSync(linkPath, { recursive: true });
      }
      const target = shape.startsWith("dangling") ? join(external, "absent")
        : shape === "ancestor" ? external : shape === "skills" ? join(external, "skills")
        : shape === "skill" ? targetSkill : shape === "file" ? join(targetSkill, "SKILL.md")
        : shape === "scripts" ? join(targetSkill, "scripts") : external;
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(target, linkPath);
      // Stub discovery with an empty, fresh cache; no adapter process or token request runs.
      registry.writeDoctor(repo, {});
      const before = snapshot(external);
      const linkBefore = readlinkSync(linkPath);
      const skillBefore = existsSync(dir) && !["ancestor", "skills", "skill"].includes(shape) ? snapshot(dir) : undefined;
      const script = join(makeTestTempDir("init-child-"), "run.mjs");
      writeFileSync(script, `import { init } from ${JSON.stringify(pathToFileURL(join(ROOT, "src/cli/commands/init.ts")).href)};\nprocess.stdout.write(await init(JSON.parse(process.argv[3]), process.argv[2]));\n`);
      const result = spawnSync(process.execPath, ["--import", loader, script, repo, JSON.stringify([
        "--global-dir", makeTestTempDir("child-global-"), "--yes", ...action,
      ])], { encoding: "utf8", timeout: 15_000 });
      expect(result.error, `${action} ${shape}`).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`kept ${linkPath} (symbolic link)`);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(linkBefore);
      expect(snapshot(external)).toEqual(before);
      if (skillBefore) expect(snapshot(dir)).toEqual(skillBefore);
    }
  }
}, 120_000);
