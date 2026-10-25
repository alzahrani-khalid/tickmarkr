// Queue row 244 (D-2141; D-2152). Regenerate: npx tsx scripts/ci/shipped-skill-files.ts
// Development only: ownership evidence is one complete path/content snapshot, never a marker.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type Snapshot = Record<string, string>;
type Tree = Record<string, Snapshot>;
type Index = Record<string, number>;
interface Provenance {
  SHIPPED_DIGESTS: string[];
  SHIPPED_SNAPSHOTS: Record<string, Index[]>;
  SHIPPED_RELEASES: Record<string, Index>;
  CURRENT_SNAPSHOT: Index;
}
export interface GenerationResult { status: 0 | 1 | 3; lines: string[]; certified: boolean }

const MODULE = "src/cli/shipped-skill-files.ts";
export const STALE = "shipped-skill-files: stale — run npx tsx scripts/ci/shipped-skill-files.ts";
const exec = promisify(execFile);
const git = async (root: string, args: string[]) =>
  (await exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 })).stdout;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ordered = <T>(value: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]!]));
const key = (snapshot: Snapshot | Index) => JSON.stringify(ordered<string | number>(snapshot));
const treeKey = (tree: Tree) => JSON.stringify(Object.entries(ordered(tree)).map(([skill, snapshot]) => [skill, key(snapshot)]));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function fail(cause: string): never { throw new Error(cause); }
const relativePath = (path: string) => path.length > 0 && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const shipsSkills = (bytes: Buffer) => {
  const manifest = JSON.parse(bytes.toString("utf8")) as { files?: unknown };
  return Array.isArray(manifest.files) && manifest.files.some((entry) => entry === "skills" || entry === "skills/");
};

function currentTree(root: string): Tree {
  if (!shipsSkills(readFileSync(join(root, "package.json")))) return {};
  const skills = join(root, "skills");
  if (!existsSync(skills) || !lstatSync(skills).isDirectory()) return {};
  const walk = (dir: string, prefix = ""): Snapshot => Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry): [string, string][] => {
      const path = prefix + entry.name;
      if (entry.isDirectory()) return Object.entries(walk(join(dir, entry.name), `${path}/`));
      return entry.isFile() ? [[path, digest(readFileSync(join(dir, entry.name)))]] : [];
    }),
  );
  return Object.fromEntries(readdirSync(skills, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const snapshot = ordered(walk(join(skills, entry.name)));
    return Object.keys(snapshot).length ? [[entry.name, snapshot]] : [];
  }));
}

async function releasedTrees(root: string): Promise<{ tags: Set<string>; releases: Record<string, Tree> }> {
  const tags = new Set((await git(root, ["tag", "--list", "v*"])).toString("utf8").trim().split("\n").filter(Boolean).sort());
  const blobs = new Map<string, Buffer>();
  const readBlob = async (oid: string) => {
    if (!blobs.has(oid)) blobs.set(oid, await git(root, ["cat-file", "blob", oid]));
    return blobs.get(oid)!;
  };
  const hashes = new Map<string, string>();
  const releases: Record<string, Tree> = Object.create(null);
  for (const version of tags) {
    const listing = await git(root, ["ls-tree", "-rz", `refs/tags/${version}`, "--", "package.json", "skills"]);
    const files = listing.toString("utf8").split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      return { mode, type, oid: oid!, path: entry.slice(tab + 1) };
    }).filter(({ mode, type }) => type === "blob" && (mode === "100644" || mode === "100755"));
    const manifest = files.find(({ path }) => path === "package.json");
    if (!manifest) continue;
    let ships: boolean;
    try { ships = shipsSkills(await readBlob(manifest.oid)); }
    catch { fail(`${version}: cannot read package.json`); }
    if (!ships) continue;
    const tree: Tree = Object.create(null);
    for (const { oid, path } of files) {
      const match = /^skills\/([^/]+)\/(.+)$/.exec(path);
      if (!match) continue;
      if (!hashes.has(oid)) hashes.set(oid, digest(await readBlob(oid)));
      const skill = match[1]!;
      const relative = match[2]!;
      (tree[skill] ??= Object.create(null))[relative] = hashes.get(oid)!;
    }
    releases[version] = tree;
  }
  return { tags, releases };
}

// Read data, never execute the generated module. A malformed or unreferenced entry is corruption,
// not permission to rewrite history. CURRENT_SNAPSHOT keeps its references while an edit is stale.
function readProvenance(source: string): Provenance {
  const data: Record<string, unknown> = {};
  for (const name of ["SHIPPED_DIGESTS", "SHIPPED_SNAPSHOTS", "SHIPPED_RELEASES", "CURRENT_SNAPSHOT"]) {
    const match = new RegExp(`^export const ${name}[^=\\n]*= ([\\s\\S]*?);$`, "m").exec(source);
    if (!match) fail(`missing entry ${name}`);
    try { data[name] = JSON.parse(match![1]!); }
    catch { fail(`malformed entry ${name}`); }
  }
  const { SHIPPED_DIGESTS: digests, SHIPPED_SNAPSHOTS: snapshots, SHIPPED_RELEASES: releases, CURRENT_SNAPSHOT: current } = data;
  if (!Array.isArray(digests)) fail("invalid entry SHIPPED_DIGESTS");
  for (const [i, hash] of digests.entries()) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || (i > 0 && digests[i - 1] >= hash))
      fail(`invalid or unsorted digest entry ${String(hash)}`);
  }
  if (!record(snapshots) || !record(releases) || !record(current)) fail("invalid snapshot or release entries");
  for (const [skill, list] of Object.entries(snapshots)) {
    if (!relativePath(skill) || skill.includes("/") || !Array.isArray(list) || list.length === 0) fail(`invalid skill entry ${skill}`);
    const distinct = new Set<string>();
    for (const [i, snapshot] of list.entries()) {
      if (!record(snapshot)) fail(`invalid snapshot entry ${skill}[${i}]`);
      for (const [path, index] of Object.entries(snapshot)) {
        if (!relativePath(path) || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= digests.length)
          fail(`invalid file entry ${skill}/${path}`);
      }
      const identity = key(snapshot as Index);
      if (distinct.has(identity)) fail(`duplicate snapshot entry ${skill}[${i}]`);
      distinct.add(identity);
    }
  }
  const usedSnapshots = new Set<string>();
  const usedDigests = new Set<number>();
  const visit = (refs: unknown, label: string) => {
    if (!record(refs)) fail(`invalid entry ${label}`);
    for (const [skill, index] of Object.entries(refs)) {
      const list = snapshots[skill];
      if (!Array.isArray(list) || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= list.length)
        fail(`invalid entry ${label}/${skill}`);
      usedSnapshots.add(`${skill}/${index}`);
      for (const i of Object.values(list[Number(index)] as Index)) usedDigests.add(i);
    }
  };
  for (const [version, refs] of Object.entries(releases)) {
    if (!version.startsWith("v")) fail(`invalid version entry ${version}`);
    visit(refs, version);
  }
  visit(current, "CURRENT_SNAPSHOT");
  for (const [skill, list] of Object.entries(snapshots)) {
    for (let i = 0; i < (list as Index[]).length; i++)
      if (!usedSnapshots.has(`${skill}/${i}`)) fail(`unreferenced snapshot entry ${skill}[${i}]`);
  }
  for (const [i, hash] of digests.entries()) if (!usedDigests.has(i)) fail(`unreferenced digest entry ${hash}`);
  return data as unknown as Provenance;
}

function decode(data: Provenance, refs: Index): Tree {
  return Object.fromEntries(Object.entries(refs).map(([skill, index]) => [skill,
    Object.fromEntries(Object.entries(data.SHIPPED_SNAPSHOTS[skill]![index]!).map(([path, i]) => [path, data.SHIPPED_DIGESTS[i]!])),
  ]));
}

function encode(current: Tree, releases: Record<string, Tree>): Provenance {
  const trees = [...Object.values(releases), current];
  const digests = [...new Set(trees.flatMap((tree) => Object.values(tree).flatMap(Object.values)))].sort();
  const digestIndex = new Map(digests.map((hash, i) => [hash, i]));
  const snapshots: Record<string, Index[]> = {};
  const skills = [...new Set(trees.flatMap(Object.keys))].sort();
  for (const skill of skills) {
    const distinct = new Map(trees.filter((tree) => Object.hasOwn(tree, skill)).map((tree) => [key(tree[skill]!), tree[skill]!]));
    snapshots[skill] = [...distinct.keys()].sort().map((identity) =>
      Object.fromEntries(Object.entries(ordered(distinct.get(identity)!)).map(([path, hash]) => [path, digestIndex.get(hash)!])));
  }
  const refs = (tree: Tree): Index => Object.fromEntries(Object.keys(tree).sort().map((skill) => {
    const indexed = Object.fromEntries(Object.entries(ordered(tree[skill]!)).map(([path, hash]) => [path, digestIndex.get(hash)!]));
    return [skill, snapshots[skill]!.findIndex((snapshot) => key(snapshot) === key(indexed))];
  }));
  return {
    SHIPPED_DIGESTS: digests,
    SHIPPED_SNAPSHOTS: snapshots,
    SHIPPED_RELEASES: Object.fromEntries(Object.keys(releases).sort().map((version) => [version, refs(releases[version]!)])),
    CURRENT_SNAPSHOT: refs(current),
  };
}

function render(data: Provenance): string {
  const json = JSON.stringify;
  return [
    "// Generated by: npx tsx scripts/ci/shipped-skill-files.ts",
    "// Queue row 244 (D-2141; D-2152). Do not edit; paths are relative to each skill directory.",
    "// Each snapshot is a COMPLETE tree; indices address SHIPPED_DIGESTS, not a union of files.",
    "export const SHIPPED_DIGESTS: readonly string[] = [",
    data.SHIPPED_DIGESTS.map((hash) => `  ${json(hash)}`).join(",\n"),
    "];",
    "export const SHIPPED_SNAPSHOTS: Readonly<Record<string, readonly Readonly<Record<string, number>>[]>> = {",
    Object.entries(data.SHIPPED_SNAPSHOTS).map(([skill, snapshots]) =>
      `  ${json(skill)}: [\n${snapshots.map((snapshot) => `    ${json(snapshot)}`).join(",\n")}\n  ]`).join(",\n"),
    "};",
    "export const SHIPPED_RELEASES: Readonly<Record<string, Readonly<Record<string, number>>>> = {",
    Object.entries(data.SHIPPED_RELEASES).map(([version, refs]) => `  ${json(version)}: ${json(refs)}`).join(",\n"),
    "};",
    `export const CURRENT_SNAPSHOT: Readonly<Record<string, number>> = ${json(data.CURRENT_SNAPSHOT)};`,
    "",
  ].join("\n");
}

/** Checks content, not serialized bytes or commit ids. A redundant new tag needs no regeneration. */
export async function generateShippedSkillFiles(root: string, check = false): Promise<GenerationResult> {
  const lines: string[] = [];
  try {
    const path = join(root, MODULE);
    const source = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const previous = source === undefined ? undefined : readProvenance(source);
    const { tags, releases } = await releasedTrees(root);
    const current = currentTree(root);
    const absent: string[] = [];
    if (previous) {
      for (const [version, refs] of Object.entries(previous.SHIPPED_RELEASES)) {
        if (!tags.has(version)) { absent.push(version); continue; }
        if (!Object.hasOwn(releases, version) || treeKey(decode(previous, refs)) !== treeKey(releases[version]!))
          fail(`${version}: skills differ from the recorded release snapshot`);
      }
    }
    if (absent.length) lines.push(`shipped-skill-files: advisory — recorded versions absent: ${absent.join(", ")}; history is not certified`);
    const certified = absent.length === 0;
    if (check) {
      const known = previous && Object.fromEntries(Object.entries(previous.SHIPPED_SNAPSHOTS).map(([skill, list]) =>
        [skill, new Set(list.map((_, index) => key(decode(previous, { [skill]: index })[skill]!)))]));
      const stale = !previous || treeKey(decode(previous, previous.CURRENT_SNAPSHOT)) !== treeKey(current)
        || Object.values(releases).some((tree) => Object.entries(tree).some(([skill, snapshot]) => !known?.[skill]?.has(key(snapshot))));
      if (stale) return { status: 1, lines: [...lines, STALE], certified: false };
      return { status: 0, lines: [...lines, `shipped-skill-files: current — ${certified ? "certified; all recorded versions present" : "history advisory"}`], certified };
    }
    if (absent.length) fail(`write refused: recorded versions absent: ${absent.join(", ")}`);
    const generated = render(encode(current, releases));
    if (source !== generated) {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, generated);
      renameSync(temp, path);
    }
    return { status: 0, lines: ["shipped-skill-files: generated"], certified };
  } catch (error) {
    return { status: 3, lines: [...lines, `shipped-skill-files: ${error instanceof Error ? error.message : String(error)}`], certified: false };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) {
    console.error("shipped-skill-files: usage: npx tsx scripts/ci/shipped-skill-files.ts [--check]");
    process.exitCode = 3;
  } else {
    const result = await generateShippedSkillFiles(process.cwd(), process.argv.includes("--check"));
    for (const line of result.lines) console.log(line);
    process.exitCode = result.status;
  }
}
