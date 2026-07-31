/**
 * Dependency-declaration guard for production code.
 *
 * A bare import in `src` that package.json does not declare resolves to
 * whatever transitive copy the installer happens to hoist — a clean install
 * may resolve it differently and production code breaks on a machine whose
 * tree shaped up another way. These tests enumerate every bare import in
 * `src`, require each to be declared in `dependencies`, and require the
 * lockfile to resolve the declaration to the declared range at the top level
 * of the tree, so the suite — not a reviewer — catches the next undeclared
 * import.
 *
 * The range arithmetic below is the small piece of semver this repository's
 * manifests actually use (exact pins, caret/tilde ranges, comparators and
 * `||` unions); importing the `semver` package here would itself be an
 * undeclared dependency, which is the failure this file exists to catch.
 */

import { builtinModules, createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const SRC = join(REPO_ROOT, "src");

type Manifest = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

type Lockfile = {
  readonly packages: Readonly<Record<string, {
    readonly version?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
  }>>;
};

const manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as Manifest;
const lockfile = JSON.parse(
  readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
) as Lockfile;

const BUILTINS = new Set(builtinModules.map((name) =>
  name.replace(/^node:/, "")
));

const STATIC_SPECIFIER =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'();]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_SPECIFIER =
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** The package a bare specifier names: its scope and name, no subpath. */
function packageName(specifier: string): string | null {
  if (
    specifier.startsWith(".") || specifier.startsWith("/")
    || specifier.startsWith("node:")
  ) {
    return null;
  }
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  return BUILTINS.has(name) ? null : name;
}

/** Every bare package imported anywhere in one source text. */
function bareImportsInSource(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [STATIC_SPECIFIER, DYNAMIC_SPECIFIER]) {
    for (const match of source.matchAll(pattern)) {
      const name = packageName(match[1]!);
      if (name !== null) found.add(name);
    }
  }
  return [...found].sort();
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every bare package imported anywhere under `src`, sorted. */
function enumerateSrcBareImports(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const name of bareImportsInSource(readFileSync(file, "utf8"))) {
      found.add(name);
    }
  }
  return [...found].sort();
}

/* ------------------------------------------------------------------ */
/* Minimal semver: versions as [major, minor, patch], ranges as a     */
/* union of half-open [lo, hi) intervals (null bound = unbounded).    */
/* ------------------------------------------------------------------ */

type Version = readonly [number, number, number];
type Interval = { readonly lo: Version | null; readonly hi: Version | null };

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** 0 = major, 1 = minor, 2 = patch: how much of the version was written. */
function precisionOf(text: string): number {
  const match = /^v?\d+(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return 0;
  if (match[2] !== undefined) return 2;
  return match[1] !== undefined ? 1 : 0;
}

function bump(version: Version, level: number): Version {
  const next: [number, number, number] = [...version];
  next[level] += 1;
  for (let index = level + 1; index < 3; index += 1) next[index] = 0;
  return next;
}

function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** One comparator (`^1.2.3`, `>=2`, `1.2.3`, `*`) as a [lo, hi) interval. */
function comparatorInterval(comparator: string): Interval | null {
  const text = comparator.trim();
  if (text === "" || text === "*" || /^[xX]$/.test(text)) {
    return { lo: null, hi: null };
  }
  const operator = /^(>=|<=|>|<|\^|~|=)?/.exec(text)![0]!;
  const versionText = text.slice(operator.length);
  const version = parseVersion(versionText);
  if (version === null) return null;
  const precision = precisionOf(versionText);
  const upper = bump(version, precision === 0 ? 0 : precision - 1);
  switch (operator) {
    case "^": {
      if (precision === 0 || version[0] > 0) {
        return { lo: version, hi: [version[0] + 1, 0, 0] };
      }
      if (precision === 1) return { lo: version, hi: [1, 0, 0] };
      if (version[1] > 0) return { lo: version, hi: [0, version[1] + 1, 0] };
      return { lo: version, hi: [0, 0, version[2] + 1] };
    }
    case "~":
      return { lo: version, hi: precision <= 1 ? upper : [version[0], version[1] + 1, 0] };
    case ">=":
      return { lo: version, hi: null };
    case "<=":
      return { lo: null, hi: bump(version, precision) };
    case ">":
      return { lo: bump(version, precision), hi: null };
    case "<":
      return { lo: null, hi: version };
    default:
      return { lo: version, hi: bump(version, precision) };
  }
}

/** The intersection of two intervals; null when empty. */
function meet(a: Interval, b: Interval): Interval | null {
  const lo = a.lo === null
    ? b.lo
    : b.lo === null
    ? a.lo
    : compareVersions(a.lo, b.lo) >= 0
    ? a.lo
    : b.lo;
  const hi = a.hi === null
    ? b.hi
    : b.hi === null
    ? a.hi
    : compareVersions(a.hi, b.hi) <= 0
    ? a.hi
    : b.hi;
  if (lo !== null && hi !== null && compareVersions(lo, hi) >= 0) return null;
  return { lo, hi };
}

/** A range string as intervals, one per `||` branch. */
function rangeIntervals(range: string): Interval[] {
  return range.split("||").map((branch) => {
    let interval: Interval | null = { lo: null, hi: null };
    for (const comparator of branch.trim().split(/\s+/)) {
      if (interval === null) break;
      const next = comparatorInterval(comparator);
      interval = next === null ? null : meet(interval, next);
    }
    return interval ?? { lo: [Number.MAX_SAFE_INTEGER, 0, 0], hi: null };
  }).filter((interval) =>
    interval.lo === null || interval.hi === null
      || compareVersions(interval.lo, interval.hi) < 0
  );
}

function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  return rangeIntervals(range).some((interval) =>
    (interval.lo === null || compareVersions(parsed, interval.lo) >= 0)
    && (interval.hi === null || compareVersions(parsed, interval.hi) < 0)
  );
}

/** Some version satisfies both ranges — one copy can serve both consumers. */
function intersects(a: string, b: string): boolean {
  return rangeIntervals(a).some((left) =>
    rangeIntervals(b).some((right) => meet(left, right) !== null)
  );
}

/* ------------------------------------------------------------------ */
/* Lockfile reading                                                   */
/* ------------------------------------------------------------------ */

const TOP_LEVEL = (name: string): string => `node_modules/${name}`;

/**
 * The lockfile entry a package at `fromPath` resolves `name` to: the nearest
 * `node_modules/<name>` at or above its own directory — exactly the walk the
 * installer and Node both perform.
 */
function resolutionPath(fromPath: string, name: string): string | null {
  let directory = fromPath;
  for (;;) {
    const candidate = directory === ""
      ? TOP_LEVEL(name)
      : `${directory}/node_modules/${name}`;
    if (lockfile.packages[candidate] !== undefined) return candidate;
    if (directory === "") return null;
    const parent = directory.lastIndexOf("/node_modules/");
    directory = parent < 0 ? "" : directory.slice(0, parent);
  }
}

/** Every range any installed package requires of `name`, with the requirer. */
function treeRequirements(
  name: string,
): { readonly requirer: string; readonly range: string }[] {
  const requirements: { requirer: string; range: string }[] = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === "") continue; // the root's own declaration is not "the tree"
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const range = entry[field]?.[name];
      if (range !== undefined) requirements.push({ requirer: path, range });
    }
  }
  return requirements;
}

describe("src dependency declarations", () => {
  test("test: the enumeration of bare imports in src is non-empty and contains string-width, chalk, ink, react, picomatch, yaml and zod, and every member is declared in package.json at a version satisfying what the rest of the tree already requires", () => {
    const imports = enumerateSrcBareImports();

    expect(imports.length).toBeGreaterThan(0);
    for (const expected of [
      "string-width",
      "chalk",
      "ink",
      "react",
      "picomatch",
      "yaml",
      "zod",
    ]) {
      expect(imports, expected).toContain(expected);
    }

    const declared = manifest.dependencies ?? {};
    for (const name of imports) {
      const range = declared[name];
      expect(range, `${name} is not declared in package.json dependencies`)
        .toBeTypeOf("string");

      // Wherever the tree rides the same top-level copy the declaration pins,
      // the declaration's range must cover what that rider requires — a
      // declaration narrower than a top-level rider forces a split resolution.
      const topLevel = lockfile.packages[TOP_LEVEL(name)];
      expect(topLevel?.version, `${name} has no top-level lockfile entry`)
        .toBeTypeOf("string");
      for (const { requirer, range: required } of treeRequirements(name)) {
        if (resolutionPath(requirer, name) !== TOP_LEVEL(name)) continue;
        expect(
          intersects(range!, required),
          `${name}: declared ${range} cannot serve ${requirer} requiring ${required}`,
        ).toBe(true);
      }
    }
  });

  test("test: the lockfile resolves each declared import to the declared range at the top level, so a declaration that leaves src resolving to a different transitive copy fails", () => {
    const declared = manifest.dependencies ?? {};
    const imports = enumerateSrcBareImports();
    const require = createRequire(join(SRC, "index.js"));

    for (const name of imports) {
      const range = declared[name];
      expect(range, `${name} is not declared in package.json dependencies`)
        .toBeTypeOf("string");

      const topLevel = lockfile.packages[TOP_LEVEL(name)];
      expect(
        topLevel?.version,
        `${name} has no top-level entry in package-lock.json`,
      ).toBeTypeOf("string");
      expect(
        satisfies(topLevel!.version!, range!),
        `${name}@${topLevel!.version} does not satisfy declared ${range}`,
      ).toBe(true);

      // What src actually loads must be that same top-level copy: a path with
      // a second node_modules segment is a nested transitive copy instead.
      const resolved = require.resolve(name);
      expect(
        resolved.split(sep).filter((part) => part === "node_modules"),
        `${name} resolves to a nested copy: ${resolved}`,
      ).toHaveLength(1);
      expect(resolved.split(sep), name).toContain(name);
    }
  });

  test("test: a guard enumerates every bare import in src and fails on any that is undeclared, so a new undeclared import is caught by the suite rather than by a reviewer", () => {
    const declared = manifest.dependencies ?? {};

    // The guard itself: every bare import in src is declared.
    const imports = enumerateSrcBareImports();
    expect(
      imports.filter((name) => declared[name] === undefined),
    ).toEqual([]);

    // The guard is load-bearing: handed a source text carrying an import
    // nothing declares, it names that import rather than passing it.
    const synthetic = [
      `import leftPad from "left-pad";`,
      `export { ok } from "./relative.js";`,
      `const fs = require("fs");`,
    ].join("\n");
    expect(
      bareImportsInSource(synthetic).filter((name) =>
        declared[name] === undefined
      ),
    ).toEqual(["left-pad"]);
  });
});
