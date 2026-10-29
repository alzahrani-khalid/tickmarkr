import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { npmDependencyInstallCommand, npmDependencyManifestChanged, resetSpawnForTests, setSpawnForTests } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// Run 3259 / D-2165 add.27/add.29: metadata edits re-resolved the shared dependency tree.
const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const installPrefix = "npm install --no-save --no-audit --no-fund --install-links";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const writeJson = (cwd: string, file: string, value: unknown) => writeFileSync(join(cwd, file), json(value));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

afterEach(resetSpawnForTests);

function recordInstalls(onInstall: (cwd: string, command: string) => void = () => {}) {
  const calls: Array<{ cwd: string; command: string }> = [];
  setSpawnForTests(((file: string, args: string[], options: SpawnOptions) => {
    if (args[1]?.startsWith("npm install ")) {
      const cwd = String(options.cwd);
      calls.push({ cwd, command: args[1] });
      onInstall(cwd, args[1]);
      // An absolute executable, through the production shell spawn seam; never npm's registry.
      return spawn(process.execPath, ["-e", "process.exit(0)"], options);
    }
    return spawn(file, args, options);
  }) as typeof spawn);
  return calls;
}

function attemptFixture(edit: string, baseline: Record<string, unknown> = { name: "fixture", version: "1.0.0" }, build = "test -f ok.txt") {
  const fixture = setupRepo([T("T1")], { tasks: { T1: [{
    shell: `node -e ${shq(`const fs=require('node:fs');${edit};fs.writeFileSync('ok.txt','ok')`)} && ${COMMIT} dependency`,
    result: { ok: true, summary: "dependency fixture" },
  }] } }, `gates:\n  build: ${build}\n`);
  writeJson(fixture.repo, "package.json", baseline);
  mkdirSync(join(fixture.repo, "node_modules"));
  git(fixture.repo, "add", "package.json");
  git(fixture.repo, "commit", "--no-gpg-sign", "-m", "fixture manifest");
  return fixture;
}

test("test: an attempt that edits its manifest's files list, scripts or version or only reorders a group's keys makes no npm call, while one adding a dependency in any of the four groups, changing either lockfile, adding an untracked manifest or lockfile, or carrying a manifest unparseable on either side makes one, so a whole-manifest or fail-open trigger fails", async () => {
  const manifest = { name: "fixture", version: "1.0.0", files: ["dist"], scripts: { build: "true" },
    ...Object.fromEntries(groups.map((group) => [group, { alpha: "^1.0.0", zeta: "^2.0.0" }])),
  };
  const repo = makeRepo({ "package.json": json(manifest), "base.txt": "base" });
  const baseline = git(repo, "rev-parse", "HEAD");
  const check = async (value: unknown, expected: boolean) => {
    writeJson(repo, "package.json", value);
    expect(await npmDependencyManifestChanged(repo, baseline), json(value)).toBe(expected);
  };
  await check(manifest, false);
  await check({ ...manifest, files: ["dist", "skills"] }, false);
  await check({ ...manifest, scripts: { build: "changed" } }, false);
  await check({ ...manifest, version: "2.0.0" }, false);
  for (const group of groups) {
    await check({ ...manifest, [group]: { zeta: "^2.0.0", alpha: "^1.0.0" } }, false);
    await check({ ...manifest, [group]: { alpha: "^1.0.0", zeta: "^2.0.0", added: "latest" } }, true);
    await check({ ...manifest, [group]: { alpha: "^3.0.0", zeta: "^2.0.0" } }, true);
    await check({ ...manifest, [group]: { alpha: "^1.0.0" } }, true);
  }
  // The comparison includes staged and already committed edits, not only worktree status.
  git(repo, "add", "package.json");
  expect(await npmDependencyManifestChanged(repo, baseline)).toBe(true);
  git(repo, "commit", "--no-gpg-sign", "-m", "committed dependency change");
  expect(await npmDependencyManifestChanged(repo, baseline)).toBe(true);
  writeFileSync(join(repo, "package.json"), "{broken");
  expect(await npmDependencyManifestChanged(repo, baseline)).toBe(true);
  const invalidBase = makeRepo({ "package.json": "{broken" });
  expect(await npmDependencyManifestChanged(invalidBase, "HEAD")).toBe(true);
  writeJson(invalidBase, "package.json", manifest);
  expect(await npmDependencyManifestChanged(invalidBase, "HEAD")).toBe(true);
  const untrackedManifest = makeRepo({ "base.txt": "base" });
  expect(await npmDependencyManifestChanged(untrackedManifest, "HEAD")).toBe(false);
  writeJson(untrackedManifest, "package.json", { name: "new" });
  expect(await npmDependencyManifestChanged(untrackedManifest, "HEAD")).toBe(true);
  for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lockRepo = makeRepo({ "package.json": json(manifest), [file]: json({ lockfileVersion: 3, packages: {} }) });
    expect(await npmDependencyManifestChanged(lockRepo, "HEAD")).toBe(false);
    writeJson(lockRepo, file, { lockfileVersion: 3, packages: { "node_modules/alpha": { version: "1.2.3" } } });
    expect(await npmDependencyManifestChanged(lockRepo, "HEAD")).toBe(true);
    rmSync(join(lockRepo, file));
    expect(await npmDependencyManifestChanged(lockRepo, "HEAD")).toBe(true);
    const untracked = makeRepo({ "package.json": json(manifest) });
    writeJson(untracked, file, {});
    expect(await npmDependencyManifestChanged(untracked, "HEAD")).toBe(true);
  }
  // Exercise the publishing-metadata bait through the actual daemon too.
  for (const edit of [
    "p.files=['dist','skills']", "p.scripts={publish:'true'}", "p.version='2.0.0'",
    "p.dependencies={zeta:'^2.0.0',alpha:'^1.0.0'}",
  ]) {
    const { repo: root, fake } = attemptFixture(`const p=JSON.parse(fs.readFileSync('package.json'));${edit};fs.writeFileSync('package.json',JSON.stringify(p))`, manifest);
    const calls = recordInstalls();
    const result = await runDaemon(root, { adapters: [fake], runId: "run-metadata" });
    expect(result.done).toEqual(["T1"]);
    expect(calls).toEqual([]);
    resetSpawnForTests();
  }
}, 90_000);

test("the install command pins a registry dependency or an alias to its locked version only when that version satisfies the manifest spec under every lockfile version and installs the manifest spec otherwise, so a stale pin fails", () => {
  const cwd = makeTestTempDir("dependency-specs-");
  // Queue row 290 / D-2173 add.2: literal npm 11 / loose semver 7.8.5 answers.
  const registryCases = [
    ["^2.0.0", "1.4.0", "^2.0.0"], ["~1.2.0", "1.3.0", "~1.2.0"],
    ["2.x", "1.9.0", "2.x"], [">=1.2.0 <2", "2.0.0", ">=1.2.0 <2"],
    ["^3 || ^4", "2.1.0", "^3 || ^4"], ["^1.0.0", "1.5.0-beta.1", "^1.0.0"],
    ["* || ^2.0.0-beta.0", "2.0.0-beta.1", "* || ^2.0.0-beta.0"],
    [">=1.0.0-1alpha", "1.0.0-9007199254740992", ">=1.0.0-1alpha"],
    ["^1.2.3.4", "1.4.0", "^1.2.3.4"],
    ["^1.0.0", "git+https://example.invalid/repo.git#main", "^1.0.0"],
    ["^1.0.0", "1.5.0", "1.5.0"], ["~1.2.0", "1.2.9", "1.2.9"],
    ["*", "1.5.0-beta.1", "1.5.0-beta.1"], ["latest", "1.2.9", "1.2.9"],
    ["1.2.3.4", "1.2.9", "1.2.9"], ["^2.0.0-beta.0", "2.0.0-beta.1", "2.0.0-beta.1"],
    ["v1.4.0", "1.4.0", "1.4.0"], [">= 1.2.0", "1.2.9", "1.2.9"],
    ["~>1.2", "1.2.9", "1.2.9"],
  ];
  const aliasCases = [
    ["npm:real@^2", "1.4.0", "npm:real@^2"],
    ["npm:@scope/real@~1.2", "1.3.0", "npm:@scope/real@~1.2"],
    ["npm:real@1.0.0", "1.4.0", "npm:real@1.0.0"],
    ["npm:real@* || ^2.0.0-beta.0", "2.0.0-beta.1", "npm:real@* || ^2.0.0-beta.0"],
    ["npm:real@>=1.0.0-1alpha", "1.0.0-9007199254740992", "npm:real@>=1.0.0-1alpha"],
    ["npm:@scope/real@^2", "2.3.4", "npm:@scope/real@2.3.4"],
    ["npm:real@latest", "1.4.0", "npm:real@1.4.0"],
    ["npm:real", "1.4.0-beta.1", "npm:real@1.4.0-beta.1"],
    ["npm:@scope/real", "1.4.0-beta.1", "npm:@scope/real@1.4.0-beta.1"],
    ["npm:real@", "1.4.0-beta.1", "npm:real@1.4.0-beta.1"],
    ["npm:real@^2.0.0-beta.0", "2.0.0-beta.1", "npm:real@2.0.0-beta.1"],
    ["npm:real@^1", "git+https://example.invalid/repo.git#main", "npm:real@^1"],
  ];
  writeJson(cwd, "package.json", {
    peerDependencies: { peer: "^1", duplicate: "peer-range" },
    devDependencies: { dev: "latest", duplicate: "dev-range" },
    dependencies: {
      range: "^4.0.0", exact: "1.0.0", "@scope/pkg": "next", alias: "npm:@scope/real@^2",
      folder: "file:./a folder", relative: "../relative", dot: "./dot", absolute: "/tmp/absolute",
      git: "git+https://example.invalid/repo.git#main", shorthand: "owner/repo#main",
      tarball: "https://example.invalid/pkg.tgz", link: "link:./linked", workspace: "workspace:*",
      missing: "~9.0.0", missingAlias: "npm:real@latest", duplicate: "regular-range",
      ...Object.fromEntries(registryCases.map(([spec], i) => [`registry-${i}`, spec])),
      ...Object.fromEntries(aliasCases.map(([spec], i) => [`alias-${i}`, spec])),
    },
    optionalDependencies: { optional: "*", duplicate: "optional-range" },
  });
  const locked = Object.fromEntries(["peer", "dev", "range", "exact", "@scope/pkg", "optional", "duplicate",
    "folder", "relative", "dot", "absolute", "git", "shorthand", "tarball", "link", "workspace",
  ].map((name) => [name, { version: "4.4.3" }]));
  Object.assign(locked, Object.fromEntries(registryCases.map(([, version], i) => [`registry-${i}`, { version }])));
  const expected = [
    "peer@^1", "duplicate@4.4.3", "dev@4.4.3", "range@4.4.3", "exact@1.0.0", "@scope/pkg@4.4.3",
    "alias@npm:@scope/real@2.3.4", `folder@file:${resolve(cwd, "a folder")}`, `relative@${resolve(cwd, "../relative")}`,
    `dot@${resolve(cwd, "dot")}`, "absolute@/tmp/absolute", "git@git+https://example.invalid/repo.git#main",
    "shorthand@owner/repo#main", "tarball@https://example.invalid/pkg.tgz", "link@link:./linked", "workspace@workspace:*",
    "missing@~9.0.0", "missingAlias@npm:real@latest",
    ...registryCases.map(([, , installed], i) => `registry-${i}@${installed}`),
    ...aliasCases.map(([, , installed], i) => `alias-${i}@${installed}`), "optional@4.4.3",
  ];
  for (const lockfileVersion of [1, 2, 3]) {
    const entries = { ...locked, alias: lockfileVersion === 1
      ? { version: "npm:@scope/real@2.3.4" } : { name: "@scope/real", version: "2.3.4" },
      ...Object.fromEntries(aliasCases.map(([spec, version], i) => {
        const alias = spec.slice(4), separator = alias.lastIndexOf("@");
        const target = separator > 0 ? alias.slice(0, separator) : alias;
        return [`alias-${i}`, lockfileVersion === 1 ? { version: `npm:${target}@${version}` } : { version }];
      })),
    };
    writeJson(cwd, "package-lock.json", lockfileVersion === 1
      ? { lockfileVersion, dependencies: entries }
      : { lockfileVersion, packages: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [`node_modules/${name}`, entry])),
        dependencies: { range: { version: "99.0.0" } } });
    expect(npmDependencyInstallCommand(cwd)).toBe([installPrefix, ...expected.map(shq)].join(" "));
  }
  // A shrinkwrap without an entry wins over a package-lock that has one.
  writeJson(cwd, "npm-shrinkwrap.json", { lockfileVersion: 3, packages: { "node_modules/range": { version: "4.5.0" } } });
  expect(npmDependencyInstallCommand(cwd)).toContain(shq("range@4.5.0"));
  expect(npmDependencyInstallCommand(cwd)).toContain(shq("dev@latest"));
  writeJson(cwd, "npm-shrinkwrap.json", { lockfileVersion: 1, dependencies: { alias: { version: "npm:other@8.0.0" } } });
  expect(npmDependencyInstallCommand(cwd)).toContain(shq("alias@npm:@scope/real@^2"));
  writeJson(cwd, "npm-shrinkwrap.json", { lockfileVersion: 1, dependencies: { alias: { version: "npm:other@2.5.0" } } });
  expect(npmDependencyInstallCommand(cwd)).toContain(shq("alias@npm:other@2.5.0"));
});

test("test: an attempt whose lockfile is present but unreadable fails before its gates with a dependency install failure naming that lockfile, while an attempt with no lockfile installs its manifest specs, so an unreadable lockfile read as an absent one fails", async () => {
  const cwd = makeTestTempDir("dependency-unreadable-");
  writeJson(cwd, "package.json", { dependencies: { added: "^1.0.0" } });
  expect(npmDependencyInstallCommand(cwd)).toBe(`${installPrefix} ${shq("added@^1.0.0")}`);
  for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
    for (const kind of ["malformed", "directory", "dangling link"]) {
      const path = join(cwd, file);
      if (kind === "malformed") writeFileSync(path, "{broken");
      else if (kind === "directory") mkdirSync(path);
      else symlinkSync(join(cwd, "missing-lock"), path);
      expect(() => npmDependencyInstallCommand(cwd)).toThrow(new RegExp(`dependency install failed: ${file.replaceAll(".", "\\.")} unreadable — .+`));
      rmSync(path, { recursive: true, force: true });
    }
    const { repo, fake } = attemptFixture(`fs.writeFileSync(${JSON.stringify(file)},'{broken')`);
    const calls = recordInstalls();
    const result = await runDaemon(repo, { adapters: [fake], runId: "run-unreadable-lock" });
    expect(result.done).toEqual([]);
    const events = Journal.open(repo, "run-unreadable-lock").read();
    expect(events.find((event) => event.event === "task-failed")?.data.error).toContain(`dependency install failed: ${file} unreadable —`);
    expect(events.filter((event) => event.event === "gate-result")).toEqual([]);
    expect(calls).toEqual([]);
    resetSpawnForTests();
  }
  writeFileSync(join(cwd, "package-lock.json"), "{broken");
  writeJson(cwd, "npm-shrinkwrap.json", { lockfileVersion: 3, packages: {} });
  expect(npmDependencyInstallCommand(cwd)).toBe(`${installPrefix} ${shq("added@^1.0.0")}`);
  writeFileSync(join(cwd, "npm-shrinkwrap.json"), "{broken");
  expect(() => npmDependencyInstallCommand(cwd)).toThrow("dependency install failed: npm-shrinkwrap.json unreadable —");

  const { repo, fake } = attemptFixture("const p=JSON.parse(fs.readFileSync('package.json'));p.dependencies={added:'^1.0.0'};fs.writeFileSync('package.json',JSON.stringify(p))");
  const calls = recordInstalls();
  expect((await runDaemon(repo, { adapters: [fake], runId: "run-no-lock" })).done).toEqual(["T1"]);
  expect(calls).toEqual([{ cwd: repo, command: `${installPrefix} ${shq("added@^1.0.0")}` }]);
});

test("test: the production daemon running an attempt that adds a registry dependency with a lock entry issues one npm install at the repository root naming the locked version and reading the repository lockfile, and the attempt's gates then run, so a daemon still passing ranges fails", async () => {
  const { repo, fake } = attemptFixture(`
    const p=JSON.parse(fs.readFileSync('package.json'));p.dependencies={added:'^4.0.0'};
    fs.writeFileSync('package.json',JSON.stringify(p));
    fs.writeFileSync('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/added':{version:'4.4.3'}}}))`,
  undefined, "test -f node_modules/provisioned");
  writeJson(repo, "package-lock.json", { lockfileVersion: 3, packages: {} });
  git(repo, "add", "package-lock.json");
  git(repo, "commit", "--no-gpg-sign", "-m", "root lock");
  const rootManifest = readFileSync(join(repo, "package.json"));
  const rootLock = readFileSync(join(repo, "package-lock.json"));
  const calls = recordInstalls((cwd) => writeFileSync(join(cwd, "node_modules", "provisioned"), "installed"));
  const result = await runDaemon(repo, { adapters: [fake], runId: "run-locked-dependency" });
  expect(result.done).toEqual(["T1"]);
  expect(calls).toEqual([{ cwd: repo, command: `${installPrefix} ${shq("added@4.4.3")}` }]);
  const events = Journal.open(repo, "run-locked-dependency").read();
  expect(events.filter((event) => event.event === "gate-result").map((event) => event.data)).toContainEqual(expect.objectContaining({ gate: "build", pass: true }));
  expect(readFileSync(join(repo, "package.json"))).toEqual(rootManifest);
  expect(readFileSync(join(repo, "package-lock.json"))).toEqual(rootLock);
});

test("test: the command the install helper builds, run offline by the real npm at an install root whose lockfile locks a transitive version, keeps that version, retains a package absent from the root manifest that the attempt names, installs the attempt's dependencies and leaves both root files byte-identical, so a command that re-resolves, prunes or writes them fails", () => {
  const dir = makeTestTempDir("dependency-offline-");
  // Resolve npm once to an absolute executable; all packages and all cache data are test-owned.
  const npm = execFileSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  const cache = join(dir, "empty-cache");
  const env = { ...process.env, npm_config_offline: "true", npm_config_cache: cache,
    npm_config_userconfig: join(dir, "npmrc"), npm_config_audit: "false", npm_config_fund: "false" };
  writeFileSync(env.npm_config_userconfig, "");
  const runNpm = (cwd: string, args: string[]) => execFileSync(npm, args, { cwd, env, encoding: "utf8", stdio: "pipe", timeout: 15_000 });
  const pack = (name: string, version: string, dependencies?: Record<string, string>) => {
    const cwd = join(dir, `${name}-${version}`);
    mkdirSync(cwd);
    writeJson(cwd, "package.json", { name, version, dependencies });
    writeFileSync(join(cwd, "marker.txt"), `${name}@${version}`);
    const result = JSON.parse(runNpm(cwd, ["pack", "--json", "--ignore-scripts"])) as Array<{ filename: string }>;
    return join(cwd, result[0]!.filename);
  };
  const lockedChild = pack("locked-child", "1.0.0");
  const newerChild = pack("locked-child", "1.1.0");
  const parent = pack("parent", "1.0.0", { "locked-child": `file:${newerChild}` });
  const retained = pack("retained", "1.0.0");
  const added = pack("added", "1.0.0");
  const root = join(dir, "root");
  const attempt = join(dir, "attempt");
  mkdirSync(root); mkdirSync(attempt);
  writeJson(root, "package.json", { name: "root", version: "1.0.0", dependencies: { parent: `file:${parent}` } });
  runNpm(root, ["install", "--ignore-scripts"]);
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  // The recorded dependency graph selects 1.0.0. Re-reading the packed parent's manifest instead
  // selects 1.1.0, so --package-lock=false is observable without any registry access or cache hit.
  lock.packages["node_modules/parent"].dependencies["locked-child"] = `file:${lockedChild}`;
  lock.packages["node_modules/locked-child"] = { version: "1.0.0", resolved: `file:${lockedChild}` };
  writeJson(root, "package-lock.json", lock);
  rmSync(join(root, "node_modules"), { recursive: true });
  rmSync(cache, { recursive: true, force: true });
  runNpm(root, ["install", "--no-save", "--install-links", `retained@file:${retained}`]);
  expect(existsSync(join(root, "node_modules/retained/marker.txt"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies.retained).toBeUndefined();
  // Force npm to use the root lock on a cold cache instead of an on-disk or hidden-lock answer.
  rmSync(join(root, "node_modules/locked-child"), { recursive: true });
  rmSync(join(root, "node_modules/.package-lock.json"), { force: true });
  rmSync(cache, { recursive: true, force: true });
  // The attempt removed parent; it remains declared by the install root, as specified. Its locked
  // transitive graph must survive provisioning the attempt's new and previously unsaved packages.
  writeJson(attempt, "package.json", { dependencies: { added: `file:${added}`, retained: `file:${retained}` } });
  const before = ["package.json", "package-lock.json"].map((file) => readFileSync(join(root, file)));
  const command = npmDependencyInstallCommand(attempt);
  expect(command).not.toContain("--package-lock=false");
  execFileSync("bash", ["-c", `${shq(npm)}${command.slice("npm".length)}`], { cwd: root, env, stdio: "pipe", timeout: 15_000 });
  expect(JSON.parse(readFileSync(join(root, "node_modules/locked-child/package.json"), "utf8")).version).toBe("1.0.0");
  for (const name of ["parent", "added", "retained"]) {
    expect(readFileSync(join(root, `node_modules/${name}/marker.txt`), "utf8")).toBe(`${name}@1.0.0`);
  }
  expect(["package.json", "package-lock.json"].map((file) => readFileSync(join(root, file)))).toEqual(before);
}, 30_000);
