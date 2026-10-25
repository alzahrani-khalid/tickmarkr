// Queue row 244 (D-2141; D-2152): provenance fixtures use only local, scratch release histories.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import * as registry from "../../src/adapters/registry.js";
import { init, skillDrift } from "../../src/cli/commands/init.js";
import { generateShippedSkillFiles, STALE } from "../../scripts/ci/shipped-skill-files.js";

const ROOT = join(import.meta.dirname, "../..");
const MODULE = "src/cli/shipped-skill-files.ts";
const SCRIPT = join(ROOT, "scripts/ci/shipped-skill-files.ts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const scratch: string[] = [];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const put = (root: string, path: string, bytes: string | Buffer) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const git = (root: string, ...args: string[]) => execFileSync("git", [
  "-c", "user.name=provenance-test", "-c", "user.email=provenance@example.invalid",
  "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args,
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-provenance-"));
  scratch.push(root);
  git(root, "init", "-q");
  put(root, "package.json", JSON.stringify({ name: "provenance-fixture", files: ["skills"] }));
  return root;
};
const commit = (root: string) => {
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture", "--allow-empty");
  return git(root, "rev-parse", "HEAD");
};
const tag = (root: string, version: string) => git(root, "tag", version, commit(root));
const bytes = (root: string) => readFileSync(join(root, MODULE), "utf8");
type Data = {
  SHIPPED_DIGESTS: string[];
  SHIPPED_SNAPSHOTS: Record<string, Record<string, number>[]>;
  SHIPPED_RELEASES: Record<string, Record<string, number>>;
  CURRENT_SNAPSHOT: Record<string, number>;
};
const data = (root: string): Data => Object.fromEntries(
  ["SHIPPED_DIGESTS", "SHIPPED_SNAPSHOTS", "SHIPPED_RELEASES", "CURRENT_SNAPSHOT"].map((name) => {
    const json = new RegExp(`^export const ${name}[^=\\n]*= ([\\s\\S]*?);$`, "m").exec(bytes(root))![1]!;
    return [name, JSON.parse(json)];
  }),
) as Data;
const snapshot = (value: Data, refs: Record<string, number>, skill: string) => Object.fromEntries(
  Object.entries(value.SHIPPED_SNAPSHOTS[skill]![refs[skill]!]!).map(([path, i]) => [path, value.SHIPPED_DIGESTS[i]]),
);
const run = (root: string, check = true): Promise<{ status: number | null; output: string }> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", TSX, SCRIPT, ...(check ? ["--check"] : [])], {
    cwd: root, env: { ...process.env, TSX_DISABLE_CACHE: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  child.on("error", reject);
  child.on("close", (status) => resolve({ status, output }));
});
const regularFiles = (dir: string, prefix = ""): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? regularFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
    : entry.isFile() ? [`${prefix}${entry.name}`] : [],
).sort();

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("test: every skill file the package ships carries the tickmarkr ownership marker in its frontmatter beside its name, and an agent init writes it byte for byte so a current install still reads current, so a marker added only at install time fails", async () => {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  const root = repo();
  commit(root);
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(manifest.files).toContain("skills");
  const skills = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  expect(skills).toEqual(["tickmarkr-auto", "tickmarkr-loop", "tickmarkr-overseer"]);
  for (const skill of skills) {
    const source = readFileSync(join(ROOT, "skills", skill, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(source)![1]!;
    const fields = parseYaml(frontmatter);
    expect(Object.keys(fields).slice(0, 2)).toEqual(["name", "description"]);
    expect(fields.name).toBe(skill);
    expect(fields.metadata).toEqual({ "installed-by": "tickmarkr" });
    expect(frontmatter).toContain("metadata:\n  installed-by: tickmarkr");
  }
  const args = ["--global-dir", join(root, ".global"), "--agent", "--docs"];
  await init(args, root);
  for (const skill of skills) {
    for (const file of regularFiles(join(ROOT, "skills", skill))) {
      expect(readFileSync(join(root, ".agents/skills", skill, file))).toEqual(readFileSync(join(ROOT, "skills", skill, file)));
    }
  }
  expect(skillDrift(root)).toEqual([]);
  const output = await init(args, root);
  for (const skill of skills) expect(output).toMatch(new RegExp(`kept current .*${skill}/SKILL\\.md`));
});

test("test: the generator's check over a scratch repository reads current after generation and after tagging the unchanged tree, stale with its specified line after a skill edit, and refuses with exit three naming the cause when a present tag's skills differ from the snapshot recorded for that version or the module carries a digest no recorded release or current tree references, while a public-mirror clone tagging the same versions on other commits with identical skills validates, so a check blind to an edit, a changed tag or an injected digest, or one pinned to commit ids or staled by a redundant tag, fails", async () => {
  const root = repo();
  const path = "skills/probe/SKILL.md";
  put(root, path, "original\n");
  tag(root, "v1");
  const originalCommit = git(root, "rev-parse", "v1");
  expect((await run(root, false)).status).toBe(0);
  const generated = bytes(root);
  expect(await run(root)).toMatchObject({ status: 0, output: expect.stringContaining("current") });
  tag(root, "v2");
  expect(await run(root)).toMatchObject({ status: 0, output: expect.stringContaining("current") });
  expect(bytes(root)).toBe(generated);

  // A release can introduce unseen bytes while the working tree is still byte-current.
  put(root, path, "tag-only snapshot\n");
  tag(root, "v3");
  put(root, path, "original\n");
  expect(await run(root)).toEqual({ status: 1, output: `${STALE}\n` });
  git(root, "tag", "-d", "v3");
  expect((await run(root)).status).toBe(0);

  const mirror = repo();
  put(mirror, path, "original\n");
  put(mirror, MODULE, generated);
  put(mirror, "public-mirror.txt", "different commit contents and ancestry\n");
  tag(mirror, "v1");
  put(mirror, "public-mirror.txt", "another public commit\n");
  tag(mirror, "v2");
  expect(git(mirror, "rev-parse", "v1")).not.toBe(originalCommit);
  expect(await run(mirror)).toMatchObject({ status: 0, output: expect.stringContaining("certified") });

  put(root, path, "edited\n");
  expect(await run(root)).toEqual({ status: 1, output: `${STALE}\n` });
  const changed = commit(root);
  git(root, "tag", "-f", "v1", changed);
  for (const check of [true, false]) {
    expect(await run(root, check)).toMatchObject({ status: 3, output: expect.stringContaining("v1: skills differ") });
    expect(bytes(root)).toBe(generated);
  }
  git(root, "tag", "-f", "v1", originalCommit);
  put(root, path, "original\n");
  expect((await run(root)).status).toBe(0);

  const extra = "f".repeat(64);
  const injected = generated.replace(/(export const SHIPPED_DIGESTS[\s\S]*?)(\n\];)/,
    `$1,\n  "${extra}"$2`);
  put(root, MODULE, injected);
  for (const check of [true, false]) {
    expect(await run(root, check)).toMatchObject({ status: 3, output: expect.stringContaining(`unreferenced digest entry ${extra}`) });
    expect(bytes(root)).toBe(injected);
  }
});

test("test: generator write mode in a scratch repository missing a recorded tag refuses and leaves the module byte for byte, keeping the digest only that release shipped, while the check there prints the absent tag as advisory and exits zero, so a regeneration that silently drops single-release history fails", async () => {
  const root = repo();
  put(root, "skills/probe/SKILL.md", "only v1 ever shipped this\n");
  tag(root, "v1");
  put(root, "skills/probe/SKILL.md", "current v2\n");
  tag(root, "v2");
  expect((await run(root, false)).status).toBe(0);
  const generated = bytes(root);
  expect(data(root).SHIPPED_DIGESTS).toContain(hash("only v1 ever shipped this\n"));
  git(root, "tag", "-d", "v1");
  const checked = await run(root);
  expect(checked.status).toBe(0);
  expect(checked.output).toContain("advisory — recorded versions absent: v1");
  expect(checked.output).toContain("history is not certified");
  expect(await run(root, false)).toMatchObject({ status: 3, output: expect.stringContaining("write refused: recorded versions absent: v1") });
  expect(bytes(root)).toBe(generated);
  expect(snapshot(data(root), data(root).SHIPPED_RELEASES.v1!, "probe")).toEqual({ "SKILL.md": hash("only v1 ever shipped this\n") });
});

test("test: the generator over a scratch repository with two release tags shipping different trees of one skill, a tag whose package did not list skills, identical bytes shipped under two paths and a symbolic link under skills records each release's complete snapshot under its release version, both paths for the shared bytes and no link, so a digest union without release membership or a snapshot merging two releases fails", async () => {
  const root = repo();
  put(root, "skills/probe/SKILL.md", "first\n");
  put(root, "skills/probe/old.txt", "old release only\n");
  put(root, "skills/probe/one.txt", "shared bytes\n");
  put(root, "skills/probe/nested/two.txt", "shared bytes\n");
  symlinkSync("one.txt", join(root, "skills/probe/link.txt"));
  symlinkSync("nested", join(root, "skills/probe/link-dir"));
  symlinkSync("probe", join(root, "skills/link-skill"));
  tag(root, "v1");
  put(root, "skills/probe/SKILL.md", "second\n");
  rmSync(join(root, "skills/probe/old.txt"));
  put(root, "skills/probe/new.txt", "new release only\n");
  tag(root, "v2");
  put(root, "package.json", JSON.stringify({ files: ["dist"] }));
  put(root, "skills/probe/never-shipped.txt", "not packaged\n");
  tag(root, "v3-no-skills");
  rmSync(join(root, "skills/probe/never-shipped.txt"));
  put(root, "package.json", JSON.stringify({ files: ["skills"] }));
  expect((await run(root, false)).status).toBe(0);
  const generated = bytes(root);
  const value = data(root);
  expect(Object.keys(value.SHIPPED_RELEASES)).toEqual(["v1", "v2"]);
  expect(Object.keys(value.SHIPPED_SNAPSHOTS)).toEqual(["probe"]);
  expect(value.SHIPPED_SNAPSHOTS.probe).toHaveLength(2);
  expect(value.SHIPPED_DIGESTS).toEqual([...value.SHIPPED_DIGESTS].sort());
  expect(value.SHIPPED_DIGESTS).toHaveLength(5);
  const common = { "one.txt": hash("shared bytes\n"), "nested/two.txt": hash("shared bytes\n") };
  expect(snapshot(value, value.SHIPPED_RELEASES.v1!, "probe")).toEqual({
    ...common, "SKILL.md": hash("first\n"), "old.txt": hash("old release only\n"),
  });
  expect(snapshot(value, value.SHIPPED_RELEASES.v2!, "probe")).toEqual({
    ...common, "SKILL.md": hash("second\n"), "new.txt": hash("new release only\n"),
  });
  expect(value.CURRENT_SNAPSHOT).toEqual(value.SHIPPED_RELEASES.v2);
  expect(generated).not.toContain("link");
  expect(generated).not.toContain(hash("not packaged\n"));
  expect((await run(root)).status).toBe(0);
  expect((await run(root, false)).status).toBe(0);
  expect(bytes(root)).toBe(generated);
});

test("test: the committed provenance module passes the generator's check in this repository, exact for every version tag present and certified only when every recorded version is present, and in a tagless shallow clone it reports the history as advisory and passes, so a skill edit committed without regeneration fails while a public checkout without tags never reds", async () => {
  const result = await generateShippedSkillFiles(ROOT, true);
  expect(result.status, result.lines.join("\n")).toBe(0);
  const tags = new Set(git(ROOT, "tag", "--list", "v*").split("\n"));
  const absent = Object.keys(data(ROOT).SHIPPED_RELEASES).filter((version) => !tags.has(version));
  expect(result.certified).toBe(absent.length === 0);
  expect(result.lines.join("\n")).toContain(absent.length ? "history is not certified" : "certified; all recorded versions present");
  for (const version of absent) expect(result.lines.join("\n")).toContain(version);
  expect(bytes(ROOT).split("\n")[0]).toBe("// Generated by: npx tsx scripts/ci/shipped-skill-files.ts");

  // Clone the current public skill payload, without the rest of this repository's private tree.
  const source = repo();
  cpSync(join(ROOT, "skills"), join(source, "skills"), { recursive: true });
  put(source, MODULE, bytes(ROOT));
  commit(source);
  const clone = mkdtempSync(join(tmpdir(), "tickmarkr-provenance-shallow-"));
  scratch.push(clone);
  git(source, "clone", "--quiet", "--no-tags", "--depth", "1", pathToFileURL(source).href, clone);
  expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(git(clone, "tag", "--list")).toBe("");
  const advisory = await generateShippedSkillFiles(clone, true);
  expect(advisory.status, advisory.lines.join("\n")).toBe(0);
  expect(advisory.certified).toBe(false);
  expect(advisory.lines.join("\n")).toContain("advisory — recorded versions absent:");
  const generated = bytes(clone);
  expect((await generateShippedSkillFiles(clone)).status).toBe(3);
  expect(bytes(clone)).toBe(generated);
  const path = join(clone, "skills/tickmarkr-loop/SKILL.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\ncommitted edit without regeneration\n`);
  commit(clone);
  const stale = await generateShippedSkillFiles(clone, true);
  expect(stale.status).toBe(1);
  expect(stale.lines).toContain(STALE);
});
