import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { baselineCachePath } from "../../src/cli/commands/verify.js";
import { lockfileHash } from "../../src/gates/cache.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 122 (D-1692): a version-only bump rewrote the npm v2/v3 lockfile's two own version fields, and both caches
// keyed on raw lockfile bytes, so the standalone verify recaptured a full test baseline it already had. Those two fields
// now leave the key; every dependency byte, every other lockfile kind and every unparseable file still key raw. Each row
// reads BOTH keys: the gate verdict cache's lockfile hash and the standalone verify's baseline cache path.
const BASE = "4ee33c837f2a0000000000000000000000000000";
const COMMANDS = { test: "npm run -s test" };
interface Lock { file?: string; lockfileVersion?: number; name?: string; version?: string; dep?: { version: string; resolved: string; integrity: string } }
const npmLock = ({ lockfileVersion = 3, name = "app", version = "1.0.0", dep = { version: "2.0.0", resolved: "https://r/x-2.0.0.tgz", integrity: "sha512-AAA" } }: Lock) =>
  JSON.stringify({
    name, version, lockfileVersion, requires: true,
    ...(lockfileVersion === 1 ? { dependencies: { x: dep } } : { packages: { "": { name, version, dependencies: { x: "^2.0.0" } }, "node_modules/x": dep } }),
  }, null, 2) + "\n";
const keysOf = (file: string, bytes: string) => {
  const dir = makeTestTempDir("tickmarkr-lockkey-");
  writeFileSync(join(dir, file), bytes);
  return { verdict: lockfileHash(dir), baseline: baselineCachePath(dir, BASE, COMMANDS) };
};
const same = (file: string, a: string, b: string) => expect(keysOf(file, b)).toEqual(keysOf(file, a));
const moved = (file: string, a: string, b: string) => {
  const [x, y] = [keysOf(file, a), keysOf(file, b)];
  expect(y.verdict).not.toBe(x.verdict);
  expect(y.baseline).not.toBe(x.baseline);
};

test("test: a version-only bump of an npm lockfileVersion 3 package-lock (root version and packages[\"\"].version) keeps both cache keys (L1)", () => {
  same("package-lock.json", npmLock({ version: "2.7.2" }), npmLock({ version: "2.7.3" }));
});
test("test: a version-only bump of an npm lockfileVersion 2 package-lock or npm-shrinkwrap.json keeps both cache keys (L2)", () => {
  same("package-lock.json", npmLock({ lockfileVersion: 2, version: "1.0.0" }), npmLock({ lockfileVersion: 2, version: "1.0.1" }));
  same("npm-shrinkwrap.json", npmLock({ version: "1.0.0" }), npmLock({ version: "1.0.1" }));
});
test("test: a dependency's version, resolved URL or integrity change in an npm lockfile moves both cache keys (L3-L5)", () => {
  const dep = { version: "2.0.0", resolved: "https://r/x-2.0.0.tgz", integrity: "sha512-AAA" };
  moved("package-lock.json", npmLock({ dep }), npmLock({ dep: { ...dep, version: "2.0.1" } }));
  moved("package-lock.json", npmLock({ dep }), npmLock({ dep: { ...dep, resolved: "https://mirror/x-2.0.0.tgz" } }));
  moved("package-lock.json", npmLock({ dep }), npmLock({ dep: { ...dep, integrity: "sha512-BBB" } }));
});
test("test: a name change in an npm lockfile, the root's alone or packages[\"\"]'s alone, moves both cache keys — only the two own version fields leave the key (L6)", () => {
  const renamed = (where: "root" | "own") => { const lock = JSON.parse(npmLock({})); if (where === "root") lock.name = "app2"; else lock.packages[""].name = "app2"; return JSON.stringify(lock, null, 2) + "\n"; };
  moved("package-lock.json", npmLock({}), renamed("root"));
  moved("package-lock.json", npmLock({}), renamed("own"));
});
test("test: an unparseable package-lock keys on its raw bytes, so any byte change moves both cache keys (L7)", () => {
  moved("package-lock.json", '{ "version": "1.0.0", torn', '{ "version": "1.0.1", torn');
});
test("test: a lockfileVersion 1 or unversioned package-lock, and a yarn.lock, key raw: their version-only change moves both cache keys (L8)", () => {
  moved("package-lock.json", npmLock({ lockfileVersion: 1, version: "1.0.0" }), npmLock({ lockfileVersion: 1, version: "1.0.1" }));
  const unversioned = (version: string) => JSON.stringify({ name: "app", version, packages: { "": { name: "app", version } } }, null, 2) + "\n";
  moved("package-lock.json", unversioned("1.0.0"), unversioned("1.0.1"));
  moved("yarn.lock", "# yarn lockfile v1\napp@1.0.0:\n  version \"1.0.0\"\n", "# yarn lockfile v1\napp@1.0.1:\n  version \"1.0.1\"\n");
});
