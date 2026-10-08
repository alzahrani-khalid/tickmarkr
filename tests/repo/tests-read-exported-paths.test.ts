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
const EXPECTED_EXCLUDED_PATHS = [
  ".planning",
  "specs",
  ".tickmarkr",
  ".overseer",
  ".claude",
  "docs",
  "ASSESSMENT-*.md",
  ".gitignore",
  "scripts/measure-trailer-width.mjs",
  "scripts/scan-scope-corpus.mjs",
  "scripts/repro-obs96.mjs",
  "CLAUDE.md",
  "scripts/export-public.sh",
  "scripts/verify-export.sh",
  "tests/scripts/verify-export.test.ts",
  "scripts/check-analysis.mjs",
  "scripts/atlas.mjs",
  "tests/docs/analysis-library.test.ts",
  ".github/workflows/ci.yml",
  "**/*.local.*",
];

function publicPath(path: string): boolean {
  return BOUNDARY.publicPaths.exact.includes(path)
    // A joined directory carries no trailing slash: `docs/codebase` IS the exported `docs/codebase/`.
    || BOUNDARY.publicPaths.prefixes.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix);
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
    return normalized;
  }
  return undefined;
}

const literalValues = (source: string): string[] =>
  [...source.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((match) => match[1]);

const STRING_LITERAL_RE = /^\s*["'`]([^"'`\n]+)["'`]\s*$/;

// A path assembled by join()/resolve() never appears as one literal: `join(ROOT, "specs", "x.spec.md")`
// reads an excluded child through two segments that are each harmless alone. Rebuild every run of
// adjacent known segments (literals, or names bound to one string literal) as the path it denotes.
// ponytail: flat argument lists only; a nested call inside join() is scanned on its own.
function joinedPaths(expression: string, constants: ReadonlyMap<string, string>): string[] {
  const paths: string[] = [];
  for (const call of expression.matchAll(/\b(?:join|resolve)\s*\(([^()]*)\)/g)) {
    let run: string[] = [];
    const flush = () => { if (run.length > 1) paths.push(run.join("/")); run = []; };
    for (const arg of call[1].split(",")) {
      const segment = STRING_LITERAL_RE.exec(arg)?.[1] ?? constants.get(arg.trim());
      if (segment === undefined) flush(); else run.push(segment);
    }
    flush();
  }
  return paths;
}

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
  const constants = new Map<string, string>();
  for (const { variable, expression } of assignments) {
    const literal = STRING_LITERAL_RE.exec(expression)?.[1];
    if (literal !== undefined) constants.set(variable, literal);
  }
  const pathValues = (expression: string): string[] => [...literalValues(expression), ...joinedPaths(expression, constants)];

  for (const { variable, expression } of assignments) {
    const anchored = /\b(?:ROOT|REPO|repoRoot)\b|import\.meta\.dirname/.test(expression)
      || /^\s*resolve\(\s*["'`]/.test(expression);
    if (!anchored) continue;
    const excludedPath = pathValues(expression).map(excludedLiteral).find(Boolean);
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
      for (const excludedPath of pathValues(call[1]).map(excludedLiteral).filter((path): path is string => Boolean(path))) {
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

const OBS_878_SHAS = ["bdf6c910", "4d9f7736"] as const;
const hasObs878Source = (commit: string): boolean => {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:tests/skills-single-source.test.ts`], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};
const OBS_878_PINS_PRESENT = OBS_878_SHAS.every(hasObs878Source);
const obs878Source = (commit: string): string => execFileSync(
  "git", ["show", `${commit}:tests/skills-single-source.test.ts`], { cwd: ROOT, encoding: "utf8" },
);

test.skipIf(!OBS_878_PINS_PRESENT)(
  "OBS-878 pinned red/green pair (skipped: one or both named SHAs are absent from this checkout)",
  () => {
    expect(scanTestSource("tests/skills-single-source.test.ts", obs878Source(OBS_878_SHAS[0])).length).toBeGreaterThan(0);
    expect(scanTestSource("tests/skills-single-source.test.ts", obs878Source(OBS_878_SHAS[1]))).toEqual([]);
  },
);

test("the exported-paths test skips with a named reason when a pinned SHA is absent instead of falling back silently and asserts its boundary list against a literal expected list with the dead public-path branch removed and the verify-export test removes every temp dir it creates and the interior-peak telemetry test uses fake timers or a margin of at least twice its sampler tick with its field comment naming all five fields as the diff shows in the three test files", () => {
  expect(EXCLUDED_ROOTS).toEqual(expect.arrayContaining([".claude", ".planning", ".tickmarkr", "docs", "specs"]));
  expect(BOUNDARY.excludedPaths).toEqual(EXPECTED_EXCLUDED_PATHS);

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

test("the repository export-read scanner rejects both literal-segment and variable-bound joined private specs paths from the goal's closed table while accepting the public stub and an explicit export guard", () => {
  const scan = (source: string) => scanTestSource("tests/joined.test.ts", source);
  const privateSpec = { file: "tests/joined.test.ts", excludedPath: "specs/private.spec.md", variable: "<literal>" };

  expect(scan('readFileSync(join(ROOT,"specs","private.spec.md"), "utf8");')).toEqual([privateSpec]);
  expect(scan('const name="private.spec.md";\nreadFileSync(join(ROOT,"specs",name), "utf8");')).toEqual([privateSpec]);
  // The same two shapes bound to a variable before the read are tainted by the joined path too.
  expect(scan('const name="private.spec.md";\nconst spec = join(ROOT,"specs",name);\nreadFileSync(spec, "utf8");'))
    .toEqual([{ ...privateSpec, variable: "spec" }]);

  expect(scan('readFileSync(join(ROOT,"specs","export-selftest.spec.md"), "utf8");')).toEqual([]);
  expect(scan(`
const spec = join(ROOT,"specs","private.spec.md");
test.skipIf(!existsSync(spec))("private spec (skipped on the exported tree: specs/private.spec.md is absent)", () => {
  readFileSync(spec, "utf8");
});`)).toEqual([]);

  // docs/codebase joined without a trailing slash is the exported directory; its children stay public
  // while a sibling under the excluded docs root does not.
  expect(scan('readdirSync(join(ROOT,"docs","codebase"));')).toEqual([]);
  expect(scan('const dir = join(ROOT,"docs","codebase");\nreaddirSync(dir);')).toEqual([]);
  expect(scan('readFileSync(join(ROOT,"docs","codebase","ARCHITECTURE.md"), "utf8");')).toEqual([]);
  expect(scan('readFileSync(join(ROOT,"docs","operator-progress.md"), "utf8");'))
    .toEqual([{ file: "tests/joined.test.ts", excludedPath: "docs/operator-progress.md", variable: "<literal>" }]);
});
