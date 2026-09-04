import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");
const THIS_FILE = "tests/repo/tests-read-exported-paths.test.ts";

interface PublicPathPolicy {
  exact: string[];
  prefixes: string[];
}

interface ExportBoundaryData {
  publicPaths: PublicPathPolicy;
  excludedPaths: string[];
}

interface ExcludedRead {
  file: string;
  excludedPath: string;
  variable: string;
}

type ReasonedAllowlist = Readonly<Record<string, string>>;

const EXPORT_EXCLUDE_RE = /^\s*'?:\(exclude(?:,[^)]+)?\)([^' \\\n]+)'?/gm;
const EXPORT_ALLOWLIST_RE = /^PUBLIC_EXPORT_ALLOWLIST_JSON='([^']+)'$/m;

function boundaryDataFromExporter(source: string): ExportBoundaryData {
  const allowlist = EXPORT_ALLOWLIST_RE.exec(source)?.[1];
  const excludedPaths = [...source.matchAll(EXPORT_EXCLUDE_RE)].map((match) => match[1]);
  if (!allowlist || excludedPaths.length === 0) throw new Error("exporter boundary data is missing");
  return { publicPaths: JSON.parse(allowlist) as PublicPathPolicy, excludedPaths };
}

function loadBoundaryData(): ExportBoundaryData {
  if (existsSync(EXPORT_SCRIPT)) return boundaryDataFromExporter(readFileSync(EXPORT_SCRIPT, "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    tickmarkrExport?: Partial<ExportBoundaryData>;
  };
  const data = pkg.tickmarkrExport;
  if (!data?.publicPaths || !Array.isArray(data.excludedPaths) || data.excludedPaths.length === 0) {
    throw new Error("exported package.json has no exporter boundary data");
  }
  return { publicPaths: data.publicPaths, excludedPaths: data.excludedPaths };
}

const BOUNDARY = loadBoundaryData();

function publicPath(path: string): boolean {
  return BOUNDARY.publicPaths.exact.includes(path)
    || BOUNDARY.publicPaths.prefixes.some((prefix) => path.startsWith(prefix));
}

// Root exclusions are the archive pathspecs with no slash or glob. Exact dev-tool exclusions are
// already covered by the manifest's dangling-reference checks; this scanner owns the class where a
// test reaches into an absent subtree.
const EXCLUDED_ROOTS = BOUNDARY.excludedPaths
  .filter((path) => !path.includes("/") && !path.includes("*"))
  .map((path) => path.replace(/\/$/, ""));

function excludedLiteral(literal: string): string | undefined {
  const normalized = literal.replace(/\\/g, "/").replace(/^(?:\.\.\/|\.\/)+/, "");
  for (const root of EXCLUDED_ROOTS) {
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    // A bare root segment is ambiguous when the exporter generates or admits a child beneath it
    // (`specs/export-selftest.spec.md`, for example). Full paths still have to be public.
    const hasPublicChild = BOUNDARY.publicPaths.exact.some((path) => path.startsWith(`${root}/`))
      || BOUNDARY.publicPaths.prefixes.some((prefix) => prefix.startsWith(`${root}/`));
    if ((normalized === root && hasPublicChild) || publicPath(normalized)) return undefined;
    if (publicPath(normalized)) return undefined;
    return normalized;
  }
  return undefined;
}

const literalValues = (source: string): string[] =>
  [...source.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((match) => match[1]);

function namedGuard(source: string, variables: string[]): boolean {
  for (const variable of variables) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const guards = [
      new RegExp(`(?:test|describe)\\.skipIf\\(\\s*!\\s*existsSync\\(\\s*${escaped}\\s*\\)`),
      new RegExp(`\\{\\s*skip:\\s*!\\s*existsSync\\(\\s*${escaped}\\s*\\)`),
      new RegExp(`if\\s*\\(\\s*existsSync\\(\\s*${escaped}\\s*\\)\\s*\\)`),
    ];
    for (const guard of guards) {
      const index = source.search(guard);
      if (index < 0) continue;
      const explanation = source.slice(Math.max(0, index - 500), index + 500);
      if (/skip|absent|exported[ -]tree|when present|if present/i.test(explanation)) return true;
    }
  }
  return false;
}

function namedLiteralGuard(source: string, excludedPath: string): boolean {
  const root = excludedPath.split("/")[0];
  for (const match of source.matchAll(/existsSync\([^\n]+/g)) {
    if (!match[0].includes(root)) continue;
    const index = match.index;
    const explanation = source.slice(Math.max(0, index - 500), index + 500);
    if (/skip|absent|exported[ -]tree|when present|if present/i.test(explanation)) return true;
  }
  return false;
}

function validateAllowlist(allowlist: ReasonedAllowlist): void {
  for (const [file, reason] of Object.entries(allowlist)) {
    if (reason.trim().length < 12) throw new Error(`${file}: export-read allowlist entry needs a reason`);
  }
}

function scanTestSource(file: string, source: string, allowlist: ReasonedAllowlist = {}): ExcludedRead[] {
  validateAllowlist(allowlist);
  if (allowlist[file]) return [];

  const tainted = new Map<string, string>();
  const assignments = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)(?:;|$)/gm)]
    .map((match) => ({ variable: match[1], expression: match[2] }));

  for (const { variable, expression } of assignments) {
    const anchored = /\b(?:ROOT|REPO|repoRoot)\b|import\.meta\.dirname/.test(expression)
      || /^\s*resolve\(\s*["'`]/.test(expression);
    if (!anchored) continue;
    const excludedPath = literalValues(expression).map(excludedLiteral).find(Boolean);
    if (excludedPath) tainted.set(variable, excludedPath);
  }

  // Follow repo-root path aliases such as installedRoot -> installed before looking for the read.
  for (let changed = true; changed;) {
    changed = false;
    for (const { variable, expression } of assignments) {
      if (tainted.has(variable)) continue;
      const parent = [...tainted].find(([candidate]) => new RegExp(`\\b${candidate}\\b`).test(expression));
      if (parent) {
        tainted.set(variable, parent[1]);
        changed = true;
      }
    }
  }

  const readVariables = new Set<string>();
  const directReads: ExcludedRead[] = [];
  for (const call of source.matchAll(
    /\b(?:readFileSync|readFile|readdirSync|statSync|lstatSync|realpathSync|readlinkSync|accessSync|openSync|execFileSync|spawnSync)\s*\(([^;\n]*)/g,
  )) {
    for (const variable of tainted.keys()) {
      if (new RegExp(`\\b${variable}\\b`).test(call[1])) readVariables.add(variable);
    }
    const anchored = /\b(?:ROOT|REPO|repoRoot)\b|import\.meta\.dirname|\bresolve\s*\(/.test(call[1])
      || /^\s*["'`]/.test(call[1]);
    if (anchored) {
      for (const excludedPath of literalValues(call[1]).map(excludedLiteral).filter((path): path is string => Boolean(path))) {
        if (!namedLiteralGuard(source, excludedPath)) {
          directReads.push({ file, excludedPath, variable: "<literal>" });
        }
      }
    }
  }

  const findings: ExcludedRead[] = [];
  for (const [variable, excludedPath] of tainted) {
    if (!readVariables.has(variable)) continue;
    const aliases = [...tainted].filter(([, path]) => path === excludedPath).map(([name]) => name);
    if (!namedGuard(source, aliases)) findings.push({ file, excludedPath, variable });
  }
  return [...findings, ...directReads];
}

function assertNoExcludedReads(file: string, source: string, allowlist: ReasonedAllowlist = {}): void {
  expect(scanTestSource(file, source, allowlist), `${file} reads an export-excluded root`).toEqual([]);
}

// These files have named, export-safe guards whose indirection is intentionally beyond this small
// static dataflow. Keeping the reason beside the path makes every exception reviewable.
const REPO_ALLOWLIST: ReasonedAllowlist = {
  "tests/repo/release-docs.test.ts": "the private mirror-installer reads live only in the suite skipped when the exporter is absent",
  "tests/repo/skills-single-source.test.ts": "skillsSingleSourceSkipReason names the exported-tree absence before the installed-copy suite",
  [THIS_FILE]: "contains the OBS-878 red and green source fixtures but never reads their literal paths",
};

const OBS_878_PRE_FIX = `
const installedRoot = resolve(".claude/skills/tickmarkr-overseer");
test("tracked copies", () => {
  const installed = resolve(installedRoot, "SKILL.md");
  expect(readFileSync(installed)).toEqual(readFileSync(canonical));
});`;

const OBS_878_FIXED = `
const installedRoot = resolve(".claude/skills/tickmarkr-overseer");
test.skipIf(!existsSync(installedRoot))("tracked copies (skipped on the exported tree: .claude/skills is absent)", () => {
  const installed = resolve(installedRoot, "SKILL.md");
  expect(readFileSync(installed)).toEqual(readFileSync(canonical));
});`;

function obs878Source(commit: string, fallback: string): string {
  if (!existsSync(EXPORT_SCRIPT)) return fallback;
  try {
    return execFileSync("git", ["show", `${commit}:tests/skills-single-source.test.ts`], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch {
    return fallback;
  }
}

test("test: the exported-paths scan fails on a tests file that reads an export-excluded root without a guard naming the skip and passes when the read is guarded or the file is allowlisted with a reason and the OBS-878 fixture pair reds at its pre-fix shape and greens at its fixed shape whereas a scan that never reds fails", () => {
  expect(EXCLUDED_ROOTS).toEqual(expect.arrayContaining([".claude", ".planning", ".tickmarkr", "docs", "specs"]));
  if (existsSync(EXPORT_SCRIPT)) {
    expect(BOUNDARY.excludedPaths).toEqual(boundaryDataFromExporter(readFileSync(EXPORT_SCRIPT, "utf8")).excludedPaths);
  } else {
    expect(BOUNDARY.excludedPaths.length).toBeGreaterThan(5);
  }

  const unguarded = OBS_878_PRE_FIX;
  const guarded = OBS_878_FIXED;
  expect(() => assertNoExcludedReads("tests/fixture.test.ts", unguarded)).toThrow(/export-excluded root/);
  expect(scanTestSource("tests/direct.test.ts", 'readFileSync(resolve(".planning/QUEUE.md"));')).toEqual([
    { file: "tests/direct.test.ts", excludedPath: ".planning/QUEUE.md", variable: "<literal>" },
  ]);
  expect(scanTestSource("tests/direct-guarded.test.ts", `
test.skipIf(!existsSync(resolve(".planning")))("skipped on the exported tree: .planning is absent", () => {
  readFileSync(resolve(".planning/QUEUE.md"));
});`)).toEqual([]);
  expect(scanTestSource("tests/fixture.test.ts", guarded)).toEqual([]);
  expect(scanTestSource("tests/fixture.test.ts", unguarded, {
    "tests/fixture.test.ts": "fixture intentionally exercises a private-tree-only reader",
  })).toEqual([]);
  expect(() => scanTestSource("tests/fixture.test.ts", unguarded, {
    "tests/fixture.test.ts": "",
  })).toThrow(/needs a reason/);

  const preFix = obs878Source("bdf6c910", OBS_878_PRE_FIX);
  const fixed = obs878Source("4d9f7736", OBS_878_FIXED);
  expect(scanTestSource("tests/skills-single-source.test.ts", preFix).length).toBeGreaterThan(0);
  expect(scanTestSource("tests/skills-single-source.test.ts", fixed)).toEqual([]);

  const requireRedControl = (scan: (source: string) => ExcludedRead[]) =>
    expect(scan(unguarded).length, "scanner must prove it can turn red").toBeGreaterThan(0);
  requireRedControl((source) => scanTestSource("tests/fixture.test.ts", source));
  expect(() => requireRedControl(() => [])).toThrow(/scanner must prove it can turn red/);

  const testFiles = execFileSync("git", ["ls-files", "tests"], { cwd: ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  expect(testFiles.length).toBeGreaterThan(250);
  const findings = testFiles.flatMap((file) =>
    scanTestSource(file, readFileSync(join(ROOT, file), "utf8"), REPO_ALLOWLIST),
  );
  expect(findings).toEqual([]);
});
