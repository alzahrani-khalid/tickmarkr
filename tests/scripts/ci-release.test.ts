import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { makeTestTempDir } from "../helpers/tmprepo.js";
import { readJson } from "../../scripts/ci/json.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(root, "scripts/ci/cli.ts");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function put(repo: string, path: string, content: string): void {
  const file = join(repo, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function commit(repo: string, name: string): string {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Release Fixture", "-c", "user.email=release@example.test", "commit", "-qm", name);
  return git(repo, "rev-parse", "HEAD");
}

function fixture() {
  const base = makeTestTempDir("ci-release-");
  const privateRepo = join(base, "private");
  const origin = join(base, "origin.git");
  const mirror = join(base, "mirror");
  git(base, "init", "-q", "-b", "main", privateRepo);
  put(privateRepo, ".gitignore", "ignored.txt\n");
  for (const path of ["src/entry.ts", "skills/guide.md", "schema/run.json"]) put(privateRepo, path, `initial ${path}\n`);
  const initial = commit(privateRepo, "public source");
  git(base, "clone", "-q", "--bare", privateRepo, origin);
  git(base, "clone", "-q", origin, mirror);
  put(privateRepo, "private-notes.txt", "private only\n");
  const privateCommit = commit(privateRepo, "private release");
  git(privateRepo, "branch", "spec/v2.8.1", initial);
  git(privateRepo, "branch", "tickmarkr/run-fixture", initial);
  return { base, privateRepo, origin, mirror, initial, privateCommit };
}

function run(check: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "release", check, ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  const lines = result.stdout.trim().split("\n");
  const final = lines.filter((line) => line.startsWith("RELEASE_CHECK "));
  expect(final, result.stdout + result.stderr).toHaveLength(1);
  expect(lines.at(-1)).toBe(final[0]);
  return {
    code: result.status,
    final: final[0]!,
    defects: lines.filter((line) => line.startsWith("RELEASE_CHECK_DEFECT ")).map((line) => readJson(line.slice("RELEASE_CHECK_DEFECT ".length)) as { kind: string; branch?: string; path?: string }),
  };
}

function binary(base: string, version: string): string {
  const path = join(base, "installed-tickmarkr");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  chmodSync(path, 0o755);
  return path;
}

test("test: the subject check reads GREEN only for a clean mirror whose head and fetched origin main both equal the graded commit, and RED once the mirror moved past it or holds an uncommitted change", () => {
  const f = fixture();
  expect(run("subject", f.mirror, f.initial)).toMatchObject({ code: 0, final: expect.stringContaining("verdict=GREEN") });
  put(f.mirror, "untracked.txt", "dirty\n");
  const dirty = run("subject", f.mirror, f.initial);
  expect(dirty.code).toBe(1);
  expect(dirty.final).toContain("dirty=true");
  git(f.mirror, "clean", "-fdq");
  put(f.mirror, "ignored.txt", "ignored but still dirty\n");
  expect(run("subject", f.mirror, f.initial).final).toContain("dirty=true");
  git(f.mirror, "clean", "-fdxq");
  put(f.mirror, "moved.txt", "new commit\n");
  git(f.mirror, "add", "-A");
  const moved = commit(f.mirror, "moved past grade");
  const past = run("subject", f.mirror, f.initial);
  expect(past.code).toBe(1);
  expect(past.final).toContain(`head="${moved}"`);
  expect(past.final).toContain(`origin="${f.initial}"`);
  git(f.mirror, "push", "-q", "origin", "HEAD:main");
  const remoteMoved = run("subject", f.mirror, f.initial);
  expect(remoteMoved.code).toBe(1);
  expect(remoteMoved.final).toContain(`origin="${moved}"`);
});

test("test: the tag check reads GREEN only when neither the mirror nor its origin holds the tag, and RED when the tag exists locally or on the remote alone", () => {
  const f = fixture();
  expect(run("tag-absent", f.mirror, "v2.8.1").code).toBe(0);
  git(f.mirror, "-c", "user.name=Release Fixture", "-c", "user.email=release@example.test", "tag", "-a", "v2.8.1", "-m", "release");
  const local = run("tag-absent", f.mirror, "v2.8.1");
  expect(local.code).toBe(1);
  expect(local.final).toContain("local=true remote=false");
  git(f.mirror, "push", "-q", "origin", "v2.8.1");
  git(f.mirror, "tag", "-d", "v2.8.1");
  const remote = run("tag-absent", f.mirror, "v2.8.1");
  expect(remote.code).toBe(1);
  expect(remote.final).toContain("local=false remote=true");
});

test("test: the trees check reads GREEN when the private release commit's source, skills and schema trees equal the public tag's while other paths differ, and RED when any of the three differs", () => {
  const f = fixture();
  git(f.mirror, "-c", "user.name=Release Fixture", "-c", "user.email=release@example.test", "tag", "-a", "v2.8.1", "-m", "release");
  const green = run("trees-equal", f.privateRepo, f.privateCommit, f.mirror, "v2.8.1");
  expect(green.code).toBe(0);
  expect(green.final).toContain('src="equal" skills="equal" schema="equal"');
  for (const path of ["src/entry.ts", "skills/guide.md", "schema/run.json"]) {
    put(f.privateRepo, path, `changed ${path}\n`);
    const changed = commit(f.privateRepo, `change ${path}`);
    const red = run("trees-equal", f.privateRepo, changed, f.mirror, "v2.8.1");
    expect(red.code).toBe(1);
    expect(red.defects).toContainEqual({ kind: "tree", path: path.split("/")[0] });
  }
});

test("test: the prune check reads GREEN when every branch to delete is an ancestor of the release commit, and RED naming each branch that is not one or does not exist", () => {
  const f = fixture();
  const branches = ["spec/v2.8.1", "tickmarkr/run-fixture"];
  expect(run("prune-safe", f.privateRepo, f.privateCommit, ...branches).code).toBe(0);
  const divergent = git(f.privateRepo, "-c", "user.name=Release Fixture", "-c", "user.email=release@example.test", "commit-tree", `${f.initial}^{tree}`, "-p", f.initial, "-m", "unmerged");
  git(f.privateRepo, "update-ref", "refs/heads/tickmarkr/run-fixture", divergent);
  const red = run("prune-safe", f.privateRepo, f.privateCommit, ...branches, "missing-branch");
  expect(red.code).toBe(1);
  expect(red.final).toContain("branches=3 not-ancestor=1 missing=1");
  expect(red.defects).toContainEqual({ kind: "not-ancestor", branch: "tickmarkr/run-fixture" });
  expect(red.defects).toContainEqual({ kind: "missing", branch: "missing-branch" });
});

test("test: the install check reads GREEN when the installed binary reports exactly the released version and RED when it reports another, so an install probe that cannot bite fails", () => {
  const base = makeTestTempDir("ci-release-bin-");
  const bin = binary(base, "2.8.1");
  expect(run("installed-version", bin, "2.8.1").code).toBe(0);
  binary(base, "2.8.0");
  const red = run("installed-version", bin, "2.8.1");
  expect(red.code).toBe(1);
  expect(red.final).toContain('expected="2.8.1" actual="2.8.0"');
  expect(run("installed-version", join(base, "missing"), "2.8.1").code).toBe(2);
});

test("release checks fail closed on bad arguments and unreadable repositories", () => {
  const f = fixture();
  for (const result of [
    run("subject", f.mirror, "not-a-sha"),
    run("tag-absent", join(f.base, "missing"), "v2.8.1"),
    run("prune-safe", f.privateRepo, f.privateCommit),
    run("unknown", f.mirror),
  ]) {
    expect(result.code).toBe(2);
    expect(result.final).toContain("verdict=UNREADABLE");
  }
});

test("test: the runbook prints all five release checks at their named stages, subject and tag-absent before the tag, trees-equal before the private tag, prune-safe before any branch deletion and installed-version after the global install in post-publish step two, and each printed command run with its arguments filled reads GREEN over a positive fixture and RED over a rejecting one ahead of the act it guards, so a runbook missing a check, placing one after its act or calling one with wrong arguments fails", () => {
  const doc = readFileSync(join(root, "RELEASING.md"), "utf8");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const tag = `v${version}`;
  const perRelease = doc.split("Per release:\n")[1]!.split("\n## Post-publish local sync")[0]!;
  const post = doc.split("## Post-publish local sync (mandatory)")[1]!.split("\n## Public GitHub export")[0]!;
  const lines = [...perRelease.matchAll(/^\s*npx --no-install tsx scripts\/ci\/cli\.ts release (.+)$/gm)].map((m) => m[1]!);
  const postLines = [...post.matchAll(/^\s*npx --no-install tsx scripts\/ci\/cli\.ts release (.+)$/gm)].map((m) => m[1]!);
  expect(lines.map((line) => line.split(" ")[0])).toEqual(["subject", "tag-absent", "trees-equal", "prune-safe"]);
  expect(postLines.map((line) => line.split(" ")[0])).toEqual(["installed-version"]);
  const step4 = perRelease.split("\n4. ")[1]!.split("\n5. ")[0]!;
  const step7 = perRelease.split("\n### 7. ")[1]!.split("\n### 8. ")[0]!;
  const step8 = perRelease.split("\n### 8. ")[1]!;
  expect(perRelease.indexOf("\n### 7. ")).toBeGreaterThan(perRelease.indexOf("\n6. "));
  expect(perRelease.indexOf("\n### 8. ")).toBeGreaterThan(perRelease.indexOf("\n### 7. "));
  expect(step4.indexOf("release subject")).toBeLessThan(step4.search(/git tag -a v\d+\.\d+\.\d+\b/));
  expect(step4.indexOf("release tag-absent")).toBeLessThan(step4.search(/git tag -a v\d+\.\d+\.\d+\b/));
  expect(step7.indexOf("release trees-equal")).toBeLessThan(step7.search(/tag -a v\d+\.\d+\.\d+\b/));
  expect(step8.indexOf("release prune-safe")).toBeLessThan(step8.indexOf("branch -d"));
  expect(post.indexOf("npm i -g tickmarkr@latest")).toBeLessThan(post.indexOf("release installed-version"));
  expect(post.indexOf("release installed-version")).toBeLessThan(post.indexOf("\n3. "));
  expect(postLines[0]).toContain(`installed-version tickmarkr ${version}`);

  const f = fixture();
  const bin = binary(f.base, version);
  // The sandbox denies tsx CLI's IPC socket. Keep the printed npx command intact and
  // substitute only its launcher with node's equivalent tsx import in this fixture.
  const shim = join(f.base, "npx");
  writeFileSync(shim, '#!/bin/sh\n[ "$1" = "--no-install" ] && [ "$2" = "tsx" ] || exit 2\nshift 2\nexec node --import tsx "$@"\n');
  chmodSync(shim, 0o755);
  const filled = (line: string) => line.replaceAll("/path/to/tickmarkr-public-mirror", f.mirror)
    .replaceAll("/path/to/tickmarkr-private-main", f.privateRepo).replace(`tickmarkr ${version}`, `${bin} ${version}`);
  const printed = (line: string, privateCommit = f.privateCommit) => {
    const result = spawnSync("bash", ["-c", `BRANCHES_TO_DELETE=(spec/v2.8.1 tickmarkr/run-fixture)\nnpx --no-install tsx scripts/ci/cli.ts release ${filled(line)}`], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${f.base}:${process.env.PATH}`, MIRROR_COMMIT: f.initial, PRIVATE_RELEASE_COMMIT: privateCommit },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.stdout.trim().split("\n").at(-1), result.stderr).toMatch(/^RELEASE_CHECK check=\S+ verdict=(GREEN|RED) /);
    return result.status;
  };
  expect(printed(lines[0]!)).toBe(0);
  put(f.mirror, "dirty.txt", "dirty\n");
  expect(printed(lines[0]!)).toBe(1);
  git(f.mirror, "clean", "-fdq");

  expect(printed(lines[1]!)).toBe(0);
  git(f.mirror, "-c", "user.name=Release Fixture", "-c", "user.email=release@example.test", "tag", "-a", tag, "-m", "release");
  expect(printed(lines[1]!)).toBe(1);
  expect(printed(lines[2]!)).toBe(0);
  put(f.privateRepo, "src/entry.ts", "changed\n");
  const changed = commit(f.privateRepo, "changed source");
  expect(printed(lines[2]!, changed)).toBe(1);
  expect(printed(lines[3]!)).toBe(0);
  const divergent = git(f.privateRepo, "-c", "user.name=Release Fixture", "-c", "user.email=release@example.test", "commit-tree", `${f.initial}^{tree}`, "-p", f.initial, "-m", "unmerged");
  git(f.privateRepo, "update-ref", "refs/heads/tickmarkr/run-fixture", divergent);
  expect(printed(lines[3]!)).toBe(1);
  expect(printed(postLines[0]!)).toBe(0);
  binary(f.base, "wrong-version");
  expect(printed(postLines[0]!)).toBe(1);
});
