// v1.59 export boundary — fail-closed dual-context allowlist manifest (operator ruling
// .planning/rulings/2026-07-19-oss-launch.md; Sol's choke-point mitigation).
//
// Dual-context contract, NO skip escape hatch in either direction:
//   private tree (export script present) → generate the exact export candidate from a pristine
//     local clone and validate the candidate's committed git index;
//   exported/public tree (script deliberately absent) → validate the current git index directly,
//     never invoking the script.
// A path ships ONLY if enumerated below (exact or prefix) AND in no private class; private classes
// reject at any depth. Secret findings disclose pattern id, path, and occurrence count only —
// never the matched text.
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");

// ---- the allowlist: data owned by the exporter ------------------------------------------------
// The private tree reads the declaration directly. The exporter stamps the same parsed object into
// the candidate package before it excludes itself, so the public-tree run never needs a fallback
// list in this file. An entry for a not-yet-present path admits nothing until the path exists.
interface PublicPathPolicy {
  exact: string[];
  prefixes: string[];
}

function validatePublicPathPolicy(value: unknown, source: string): PublicPathPolicy {
  const policy = value as Partial<PublicPathPolicy> | undefined;
  if (!policy || !Array.isArray(policy.exact) || !Array.isArray(policy.prefixes)) {
    throw new Error(`public export allowlist is missing or malformed in ${source}`);
  }
  if (![...policy.exact, ...policy.prefixes].every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`public export allowlist has a non-string or empty entry in ${source}`);
  }
  return { exact: policy.exact, prefixes: policy.prefixes };
}

function policyFromExporter(source: string): PublicPathPolicy {
  const encoded = /^PUBLIC_EXPORT_ALLOWLIST_JSON='([^']+)'$/m.exec(source)?.[1];
  if (!encoded) throw new Error("PUBLIC_EXPORT_ALLOWLIST_JSON declaration not found in scripts/export-public.sh");
  return validatePublicPathPolicy(JSON.parse(encoded), "scripts/export-public.sh");
}

function loadPublicPathPolicy(): PublicPathPolicy {
  if (existsSync(EXPORT_SCRIPT)) return policyFromExporter(readFileSync(EXPORT_SCRIPT, "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    tickmarkrExport?: { publicPaths?: unknown };
  };
  return validatePublicPathPolicy(pkg.tickmarkrExport?.publicPaths, "the exported package.json");
}

const PUBLIC_PATH_POLICY = loadPublicPathPolicy();
const PUBLIC_EXACT = new Set(PUBLIC_PATH_POLICY.exact);
const PUBLIC_PREFIXES = PUBLIC_PATH_POLICY.prefixes;

// ---- the private path classes: rejected at ANY depth -----------------------------------------
const PRIVATE_SEGMENTS: Record<string, string> = {
  ".planning": "operator planning tree",
  ".tickmarkr": "tickmarkr run state",
  ".claude": "claude state",
  ".overseer": "overseer state",
  ".git": "git internals",
  "node_modules": "dependencies",
};

function privateClass(path: string, publicExact: ReadonlySet<string> = PUBLIC_EXACT): string | undefined {
  for (const seg of path.split("/")) {
    if (PRIVATE_SEGMENTS[seg]) return PRIVATE_SEGMENTS[seg];
    if (seg === "CLAUDE.md") return "operator instructions";
    if (/^ASSESSMENT-.+\.md$/.test(seg)) return "internal assessment";
    if (/\.local\./.test(seg)) return "local-machine file";
  }
  if (path.startsWith("specs/") && !publicExact.has(path)) return "private spec corpus";
  // a dev-only exclusion takes its tests with it: this file's whole subject is
  // scripts/verify-export.sh, which the export excludes, so shipping it is an ENOENT (OBS-862).
  if (path === "tests/scripts/verify-export.test.ts") return "test for an excluded dev-only script";
  // the private analysis library (docs/analysis) takes its check script and test with it
  if (path === "tests/docs/analysis-library.test.ts") return "test for the private analysis library";
  if (path === "docs/codebase/CONCERNS.md") return "private concerns page";
  if (path.startsWith("docs/analysis/") || path.startsWith("docs/superpowers/")) return "operational diary docs";
  return undefined;
}

// fail closed: unclassified is rejected exactly like private — only the enumerated set ships
const acceptsWithPolicy = (path: string, policy: PublicPathPolicy): boolean => {
  const exact = new Set(policy.exact);
  return privateClass(path, exact) === undefined && (exact.has(path) || policy.prefixes.some((pre) => path.startsWith(pre)));
};
const accepts = (path: string): boolean => acceptsWithPolicy(path, PUBLIC_PATH_POLICY);

// a referenced path must resolve to a FILE — existsSync alone lets a directory stand in for one
const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

// ---- secret sweep: findings carry pattern id, path, count — never the matched text -----------
// Pattern set mirrors scripts/export-public.sh secret_sweep (case-insensitive there too).
const SECRET_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/gi },
  { id: "github-token", re: /ghp_[a-zA-Z0-9]{36,}/gi },
  { id: "github-fine-grained-pat", re: /github_pat_[a-zA-Z0-9_]{20,}/gi },
  { id: "generic-sk-key", re: /sk-[a-zA-Z0-9]{20,}/gi },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi },
  { id: "slack-token", re: /xox[baprs]-[0-9a-zA-Z-]{10,}/gi },
];

interface SecretFinding {
  id: string;
  path: string;
  count: number;
}

function secretFindings(root: string, paths: string[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rel of paths) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const { id, re } of SECRET_PATTERNS) {
      const count = [...text.matchAll(re)].length;
      if (count > 0) findings.push({ id, path: rel, count });
    }
  }
  return findings;
}

// ---- dual-context tree enumeration ------------------------------------------------------------
interface Candidate {
  root: string;
  paths: string[];
  cleanup: () => void;
}

function loadCandidate(): Candidate {
  if (existsSync(EXPORT_SCRIPT)) {
    // private tree: run the exporter from a pristine local clone (its dirty-tree guard must never
    // see the dev checkout) and validate the exact candidate the script committed.
    const cloneDir = mkdtempSync(join(tmpdir(), "tickmarkr-export-manifest-"));
    let exportDir: string | undefined;
    try {
      execSync(`git clone --local --quiet "${ROOT}" "${cloneDir}"`, { stdio: "pipe" });
      const out = execSync("bash scripts/export-public.sh", { cwd: cloneDir, encoding: "utf8" });
      exportDir = /^export path: (.+)$/m.exec(out)?.[1].trim();
      if (!exportDir) throw new Error(`export path not found in:\n${out}`);
      const paths = execSync("git ls-files", { cwd: exportDir, encoding: "utf8" }).trim().split("\n");
      const dir = exportDir;
      return {
        root: dir,
        paths,
        cleanup: () => {
          rmSync(dir, { recursive: true, force: true });
          rmSync(cloneDir, { recursive: true, force: true });
        },
      };
    } catch (e) {
      if (exportDir) rmSync(exportDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
      throw e;
    }
  }
  // exported/public tree: the script is deliberately not shipped — validate the current git index
  // directly, without invoking anything.
  const paths = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  return { root: ROOT, paths, cleanup: () => {} };
}

// one candidate shared by every test in this file — the export runs at most once per suite run
let sharedCandidate: Candidate | undefined;
const getCandidate = (): Candidate => (sharedCandidate ??= loadCandidate());
afterAll(() => sharedCandidate?.cleanup());

describe("export boundary — fail-closed dual-context allowlist manifest", () => {
  test("test: the manifest test reads the allowlist export-public.sh declares as data so a script added to that one list is admitted without a second edit whereas a manifest that keeps its own list fails", () => {
    const exporter = existsSync(EXPORT_SCRIPT)
      ? readFileSync(EXPORT_SCRIPT, "utf8")
      : `PUBLIC_EXPORT_ALLOWLIST_JSON='${JSON.stringify(PUBLIC_PATH_POLICY)}'`;
    const addedScript = "scripts/new-release-instrument.sh";
    const changedPolicy = {
      ...PUBLIC_PATH_POLICY,
      exact: [...PUBLIC_PATH_POLICY.exact, addedScript],
    };
    const changedExporter = exporter.replace(
      /^PUBLIC_EXPORT_ALLOWLIST_JSON='[^']+'$/m,
      `PUBLIC_EXPORT_ALLOWLIST_JSON='${JSON.stringify(changedPolicy)}'`,
    );
    expect(changedExporter).not.toBe(exporter);

    const policyReadFromChangedExporter = policyFromExporter(changedExporter);
    expect(acceptsWithPolicy(addedScript, policyReadFromChangedExporter)).toBe(true);

    // The old design copied the policy into this test. That copy is stale after the one exporter
    // edit above, and the same admission assertion must therefore turn red.
    const manifestOwnedCopy = {
      exact: [...PUBLIC_PATH_POLICY.exact],
      prefixes: [...PUBLIC_PATH_POLICY.prefixes],
    };
    expect(() => expect(acceptsWithPolicy(addedScript, manifestOwnedCopy)).toBe(true)).toThrow();
  });

  test("the checked-in fixture directory is included in the package manifest's published file set, not only present in the source tree", { timeout: 120_000 }, () => {
    const candidate = getCandidate();
    // package.json `files` is the published npm set; fixtures must be enumerated there, not merely present in the source tree.
    const manifest = JSON.parse(readFileSync(join(candidate.root, "package.json"), "utf8")) as { files?: string[] };
    expect(manifest.files).toContain("fixtures");
    // dual check: the export allowlist also enumerates fixtures/ (PUBLIC_PREFIXES), so eval + compiler fixtures ship.
    expect(PUBLIC_PREFIXES).toContain("fixtures/");
    expect(accepts("fixtures/eval/sample/start/a.txt")).toBe(true);
    expect(candidate.paths.some((p) => p.startsWith("fixtures/"))).toBe(true);
  });

  test(
    "the manifest test validates the exact export candidate tree when the export script is present and validates the current git index without invoking the script when it is absent, and it never skips in either context",
    { timeout: 120_000 },
    () => {
      const candidate = getCandidate();
      expect(candidate.paths.length).toBeGreaterThan(100);
      expect(candidate.paths).not.toContain("scripts/verify-export.sh");
      expect(candidate.paths).not.toContain("tests/scripts/verify-export.test.ts");
      const rejected = candidate.paths.filter((p) => !accepts(p)).map((p) => `${p} (${privateClass(p) ?? "not allowlisted"})`);
      expect(rejected).toEqual([]);
      expect(secretFindings(candidate.root, candidate.paths)).toEqual([]);
    },
  );

  test(
    "the shipped package.json advertises no npm script whose scripts/ target the export omits — the dangling verify:export entry specifically, and the class generally",
    { timeout: 120_000 },
    () => {
      const c = getCandidate();
      const scripts = (JSON.parse(readFileSync(join(c.root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

      // the specific hole that halted v2.2.1 (OBS-862): the entry survived an exclusion of its target
      expect(scripts["verify:export"]).toBeUndefined();

      // the class: every scripts/<file> a shipped npm script names must exist in the candidate.
      // Fail-closed — this catches the NEXT dev-only exclusion that forgets its npm entry, not just this one.
      const dangling = Object.entries(scripts).flatMap(([name, value]) =>
        // `[^\s"']+` so a NESTED target (scripts/release/check.ts) is matched whole: the earlier
        // `[A-Za-z0-9._-]+` stopped at the first slash and matched only `scripts/release`, whereupon an
        // existing DIRECTORY satisfied the check and hid a missing file. isFile() closes that for flat
        // targets too, not only nested ones.
        (value.match(/scripts\/[^\s"']+/g) ?? [])
          .filter((target) => !isFile(join(c.root, target)))
          .map((target) => `${name} -> ${target}`),
      );
      expect(dangling).toEqual([]);

      // positive control: the assertion above is only meaningful if a resolvable reference exists to find
      expect(scripts.schema).toContain("scripts/emit-schema.ts");
      expect(existsSync(join(c.root, "scripts/emit-schema.ts"))).toBe(true);
    },
  );

  test(
    "no shipped markdown mandates an `npm run` script the candidate's package.json does not define",
    { timeout: 120_000 },
    () => {
      const c = getCandidate();
      const defined = new Set(
        Object.keys((JSON.parse(readFileSync(join(c.root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts),
      );
      const docs = c.paths.filter((p) => p.endsWith(".md"));
      const referenced = docs.flatMap((rel) =>
        [...readFileSync(join(c.root, rel), "utf8").matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => ({ rel, name: m[1] })),
      );

      // twice in this release the fault was the same shape: the export removed something and an artifact
      // one step further out still advertised it (CHANGELOG.md, then skills/tickmarkr-overseer/SKILL.md).
      // This asserts the class instead of chasing the next instance.
      expect(referenced.filter((r) => !defined.has(r.name)).map((r) => `${r.rel} -> npm run ${r.name}`)).toEqual([]);

      // positive control: an empty or non-matching sweep would satisfy the assertion vacuously
      expect(referenced.map((r) => r.name)).toContain("build");
    },
  );

  test("the advanced reference is reachable from the shipped package", { timeout: 120_000 }, () => {
    const c = getCandidate();
    const readme = readFileSync(join(c.root, "README.md"), "utf8");
    const repo = (
      JSON.parse(readFileSync(join(c.root, "package.json"), "utf8")) as { repository: { url: string } }
    ).repository.url
      .replace(/^git\+/, "")
      .replace(/\.git$/, "");
    expect(readme).toContain(`${repo}/blob/main/FLEET.md`);
    expect(c.paths).toContain("FLEET.md");
    expect(existsSync(join(c.root, "FLEET.md"))).toBe(true);
  });

  test("the manifest accepts only the enumerated public path set and the minimal vendored fixture inputs and rejects every path in the private path classes at any depth", () => {
    const accepted = [
      "package.json",
      "LICENSE",
      "README.md",
      ".oxlintrc.json",
      ".gitignore",
      "tickmarkr.spec.md",
      "src/compile/gsd.ts",
      "schema/rungraph.schema.json",
      "assets/mark.svg",
      "scripts/assert-test-file-count.sh",
      "scripts/emit-schema.ts",
      "scripts/probe-rig.mjs",
      "scripts/run-ci-vitest.sh",
      "scripts/vitest-lease.ts", // vitest.config.ts globalSetup (OBS-880 suite lease)
      "skills/tickmarkr-loop/SKILL.md",
      "skills/tickmarkr-auto/SKILL.md",
      "skills/tickmarkr-overseer/SKILL.md",
      "skills/tickmarkr-overseer/scripts/watch-panes.sh",
      ".github/workflows/ci.public.yml",
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/pull_request_template.md",
      "docs/codebase/ARCHITECTURE.md",
      "specs/export-selftest.spec.md",
      "tests/repo/export-manifest.test.ts",
      // the minimal vendored fixture inputs
      "fixtures/gsd-sample/07-live-check/07-01-PLAN.md",
      "tests/fixtures/gates/RED-DRILLS.md",
      "tests/fixtures/gates/49-DECISION.md",
      "tests/fixtures/scope-seam/29-fleet-metering/29-01-PLAN.md",
      "tests/fixtures/scope-seam/29-fleet-metering/29-01-SUMMARY.md",
      "tests/fixtures/journal-corpus/run-20260711-185020.jsonl",
    ];
    for (const p of accepted) expect(accepts(p), `should accept ${p}`).toBe(true);

    const rejected = [
      // planning tree — at any depth
      ".planning/OBSERVATIONS.md",
      ".planning/milestones/v1.9-phases/29-fleet-metering/29-01-PLAN.md",
      "tests/.planning/deep/leak.md",
      // spec corpus beyond the generated stub — including nested
      "specs/v1.59-oss-launch.spec.md",
      "specs/nested/deeper/private.spec.md",
      // tickmarkr state / claude / overseer — at any depth
      ".tickmarkr/journal.jsonl",
      "src/.tickmarkr/state.json",
      ".claude/settings.json",
      "skills/.claude/skills/x.md",
      ".overseer/notes.md",
      "tests/.overseer/notes.md",
      // internal assessments and operator instructions — at any depth
      "ASSESSMENT-Fable.md",
      "docs/ASSESSMENT-anything.md",
      "CLAUDE.md",
      "src/deep/CLAUDE.md",
      // private docs classes
      "docs/codebase/CONCERNS.md",
      "docs/analysis/scout-stage-evidence.md",
      "docs/superpowers/specs/2026-07-07-design.md",
      // local-machine files, dependencies, git internals
      "config.local.json",
      "src/tuning.local.ts",
      "node_modules/zod/index.js",
      ".git/config",
      // fail closed: unclassified paths are rejected, not tolerated
      "docs/finisher-enforcement.md",
      "scripts/export-public.sh",
      "scripts/verify-export.sh",
      "tests/scripts/verify-export.test.ts",
      "scripts/check-analysis.mjs",
      "scripts/atlas.mjs",
      "tests/docs/analysis-library.test.ts",
      "scripts/measure-trailer-width.mjs",
      "unclassified-new-top-level.md",
    ];
    for (const p of rejected) expect(accepts(p), `should reject ${p}`).toBe(false);
  });

  test("the manifest reports a secret shaped match by pattern identifier path and occurrence count only and never discloses the matched text", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-secret-report-"));
    try {
      // assembled from pieces so this source file itself never contains a secret-shaped string
      const planted = ["AKIA", "IOSF", "ODNN", "7EXA", "MPLE"].join("");
      writeFileSync(join(dir, "leaky.txt"), `first ${planted}\nsecond ${planted}\n`);
      const findings = secretFindings(dir, ["leaky.txt"]);
      expect(findings).toEqual([{ id: "aws-access-key-id", path: "leaky.txt", count: 2 }]);
      expect(JSON.stringify(findings)).not.toContain(planted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- T2 export workflow correctness -----------------------------------------------------------
// The exported tree ships ci.public.yml (self-contained CI) in place of the private ci.yml, whose
// selftest job invokes the export script the export itself excludes — the red-X launch trap class.
const workflowPaths = (c: Candidate): string[] => c.paths.filter((p) => p.startsWith(".github/workflows/"));
// ends on a word character so a path cited at the end of a comment sentence keeps no trailing dot
const extractScriptRefs = (text: string): string[] => text.match(/\bscripts\/[\w./-]*\w/g) ?? [];
const NOREPLY_IDENTITY = "53393181+alzahrani-khalid@users.noreply.github.com";

// OBS-1184 + v2.7.8 T5: every public-CI Vitest step runs through the wrapper that consults the overseer skill's
// shared log classifier (the one grade-ci.sh uses). The sharded form is EXPANDED — every matrix row a job on its
// own empty runner temp directory — and executed as data: each wrapped step writes its log, `<log>.record.json`
// and its step's TICKMARKR_CI_COVERAGE_BLOB, each tagged with the job that wrote it; uploads store their
// directory as an artifact; each aggregate's merge-multiple download flattens the artifacts its pattern selects
// into one directory, and its merge and assert must read exactly its own OS's blobs and records. Returns the
// violations plus each wrapped command as "<job>: <command>".
const CI_WRAPPER = "scripts/run-ci-vitest.sh";
const CI_CLASSIFIER = "skills/tickmarkr-overseer/scripts/classify-vitest-log.sh";
type CiStep = { run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type CiJob = { name?: string; strategy?: { matrix?: Record<string, unknown[]> }; steps?: CiStep[] };
const filesUnder = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
// shell words of an expanded command: whitespace outside double quotes splits, the quotes go
const words = (command: string): string[] => [...command.matchAll(/(?:"[^"]*"|[^\s"])+/g)].map((match) => match[0].replace(/"/g, ""));
function publicCiShape(workflow: string): { violations: string[]; wrapped: string[] } {
  const jobs = (parseYaml(workflow) as { jobs?: Record<string, CiJob> }).jobs ?? {};
  const violations: string[] = [];
  const wrapped: string[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-ci-shape-"));
  try {
    const instances = Object.entries(jobs).flatMap(([id, job]) => {
      let rows: Record<string, string>[] = [{}];
      for (const [axis, values] of Object.entries(job.strategy?.matrix ?? {})) rows = rows.flatMap((row) => values.map((value) => ({ ...row, [axis]: String(value) })));
      return rows.map((vars) => ({ id, job, vars }));
    });
    // test jobs first: an aggregate needs them, so it runs after every one of them
    const downloads = (job: CiJob) => (job.steps ?? []).some((step) => String(step.uses ?? "").startsWith("actions/download-artifact"));
    instances.sort((a, b) => Number(downloads(a.job)) - Number(downloads(b.job)));
    const artifacts = new Map<string, { os: string; dir: string }>();
    const written = new Map<string, Set<string>>(); // os -> every "<job>|<kind>" tag its test jobs wrote
    for (const [n, { id, job, vars }] of instances.entries()) {
      const temp = join(scratch, `runner-${n}`);
      mkdirSync(temp); // an empty runner temp directory
      const expand = (text: string) => text
        .replace(/\$\{\{\s*runner\.temp\s*\}\}|\$RUNNER_TEMP/g, temp)
        .replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? `<unknown matrix.${key}>`);
      const name = expand(job.name ?? id);
      const os = vars.os ?? "<no os>";
      const tags = written.get(os) ?? new Set<string>();
      written.set(os, tags);
      const write = (path: string, kind: string) => {
        if (existsSync(path)) violations.push(`${name}: ${kind} ${path.slice(temp.length + 1)} collides with ${readFileSync(path, "utf8")}`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${name}|${kind}`);
        if (!downloads(job)) tags.add(`${name}|${kind}`);
      };
      const read = (dir: string) => (existsSync(dir) ? filesUnder(dir).map((file) => readFileSync(join(dir, file), "utf8")).sort() : []);
      const own = (kind: string) => [...tags].filter((tag) => tag.endsWith(`|${kind}`)).sort();
      let merged: { dir: string; record: string } | undefined;
      for (const step of job.steps ?? []) {
        const run = (step.run ?? "").trim();
        const uses = String(step.uses ?? "");
        if (/\bvitest\b|\bnpm (?:run )?test\b/.test(run)) {
          const m = /^bash scripts\/run-ci-vitest\.sh ("[^"]+") ([^\n]+)$/.exec(run);
          if (!m) {
            violations.push(`${name}: Vitest step bypasses the shared wrapper: ${run}`);
            continue;
          }
          wrapped.push(`${name}: ${expand(m[2]!)}`);
          const [log] = words(expand(m[1]!));
          const mergeDir = /--merge-reports=(\S+)/.exec(words(expand(m[2]!)).join(" "))?.[1];
          if (mergeDir !== undefined) {
            const blobs = read(mergeDir);
            if (blobs.join("\n") !== own("blob").join("\n")) violations.push(`${name}: the merge reads [${blobs.join(", ")}], not this OS's blobs [${own("blob").join(", ")}]`);
            merged = { dir: mergeDir, record: `${log}.record.json` };
          }
          write(log!, "log");
          write(`${log}.record.json`, "record");
          const blob = step.env?.TICKMARKR_CI_COVERAGE_BLOB;
          if (blob !== undefined) write(expand(blob), "blob");
        } else if (/\bscripts\/ci\/cli\.ts assert\b/.test(run)) {
          const argv = words(expand(run));
          const flag = (key: string) => argv[argv.indexOf(key) + 1];
          const records = argv.slice(argv.indexOf("assert") + 1).filter((arg, i, all) => !arg.startsWith("--") && !all[i - 1]?.startsWith("--"))
            .flatMap((arg) => (arg.includes("*")
              ? (existsSync(dirname(arg)) ? readdirSync(dirname(arg)).filter((file) => new RegExp(`^${basename(arg).replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`).test(file)).map((file) => join(dirname(arg), file)) : [])
              : [arg]));
          const seen = records.map((path) => (existsSync(path) ? readFileSync(path, "utf8") : `<absent ${path}>`)).sort();
          if (seen.join("\n") !== own("record").join("\n")) violations.push(`${name}: the assert reads [${seen.join(", ")}], not this OS's records [${own("record").join(", ")}]`);
          if (!merged || flag("--merge-record") !== merged.record || flag("--blobs") !== merged.dir) violations.push(`${name}: the assert does not read the merge's own record and blob directory`);
        } else if (uses.startsWith("actions/upload-artifact")) {
          const artifact = expand(String(step.with?.name ?? ""));
          const path = expand(String(step.with?.path ?? "")).trim();
          if (artifacts.has(artifact)) violations.push(`${name}: artifact ${artifact} collides`);
          if (!path.includes("\n") && existsSync(path)) {
            const dir = join(scratch, "artifacts", artifact);
            cpSync(path, dir, { recursive: true });
            artifacts.set(artifact, { os, dir });
          }
        } else if (uses.startsWith("actions/download-artifact")) {
          const pattern = new RegExp(`^${expand(String(step.with?.pattern ?? "")).replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
          const dest = expand(String(step.with?.path ?? ""));
          if (step.with?.["merge-multiple"] !== true) violations.push(`${name}: the download does not merge its artifacts into one directory`);
          const from = new Map<string, string>();
          for (const [artifact, stored] of artifacts) {
            if (!pattern.test(artifact)) continue;
            if (stored.os !== os) violations.push(`${name}: downloads ${artifact} from another OS`);
            for (const file of filesUnder(stored.dir)) {
              if (from.has(file)) violations.push(`${name}: ${file} collides between ${from.get(file)} and ${artifact}`);
              from.set(file, artifact);
              mkdirSync(dirname(join(dest, file)), { recursive: true });
              cpSync(join(stored.dir, file), join(dest, file));
            }
          }
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (wrapped.length === 0) violations.push("no wrapped Vitest step found");
  return { violations, wrapped };
}
// a complete Vitest 3.2 log whose one unhandled error is the runner's RPC timeout (OBS-1058)
const RPC_ONLY_LOG = [
  "⎯⎯⎯ Unhandled Errors ⎯⎯⎯", "", "Vitest caught 1 unhandled error during the test run.", "",
  "⎯⎯⎯ Unhandled Error ⎯⎯⎯", 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"', "⎯⎯⎯⎯⎯⎯", "",
  " Test Files  1 passed (1)", "      Tests  1 passed (1)", "     Errors  1 error", "   Duration  1.00s", "",
].join("\n");

describe("export workflow correctness — the exported CI stands alone", () => {
  test("the exported workflow file contains no job that invokes the excluded export script", { timeout: 180_000 }, () => {
    const c = getCandidate();
    const wfs = workflowPaths(c);
    expect(wfs.length).toBeGreaterThan(0);
    for (const wf of wfs) {
      expect(readFileSync(join(c.root, wf), "utf8"), wf).not.toMatch(/export-public\.sh/);
    }
  });

  test("every script referenced by an exported workflow file exists in the exported tree", { timeout: 180_000 }, () => {
    // extractor self-check: it must catch the trap class this criterion exists for
    expect(extractScriptRefs("      run: bash scripts/export-public.sh")).toEqual(["scripts/export-public.sh"]);
    const c = getCandidate();
    const shipped = new Set(c.paths);
    for (const wf of workflowPaths(c)) {
      for (const ref of extractScriptRefs(readFileSync(join(c.root, wf), "utf8"))) {
        expect(shipped.has(ref), `${wf} references ${ref}`).toBe(true);
      }
    }
  });

  test("test: the exported sharded workflow runs every Vitest step through the shared wrapper and, expanded from an empty runner temp directory, writes per-shard log record and blob paths that never collide and that each same-OS aggregate's merge-multiple download, merge and assert read, so a bare Vitest step, a cross-OS pattern or a colliding filename fails", { timeout: 180_000 }, () => {
    const c = getCandidate();
    const wf = ".github/workflows/ci.public.yml";
    for (const path of [wf, CI_WRAPPER, CI_CLASSIFIER, "scripts/ci/cli.ts"]) expect(c.paths, path).toContain(path);
    const workflow = readFileSync(join(c.root, wf), "utf8");
    const { violations, wrapped } = publicCiShape(workflow);
    expect(violations).toEqual([]);
    // per OS: four shards, the single-fork job and the aggregate's merge, every one wrapped
    for (const os of ["ubuntu-latest", "macos-latest"]) {
      const ofOs = wrapped.filter((w) => w.includes(` ${os}`));
      expect(ofOs.filter((w) => /^suite .*--project suite --shard=[1-4]\/4$/.test(w)), os).toHaveLength(4);
      expect(ofOs.filter((w) => w.startsWith(`single-fork ${os}: npx vitest run `)), os).toHaveLength(1);
      expect(ofOs.filter((w) => w.startsWith(`aggregate ${os}: npx vitest run --merge-reports=`)), os).toHaveLength(1);
    }

    // the guard reds the three regressions it exists for
    const bare = workflow.replace(`bash ${CI_WRAPPER} "$RUNNER_TEMP/ci/single-fork.log" `, "");
    expect(bare).not.toBe(workflow);
    expect(publicCiShape(bare).violations.join("\n")).toMatch(/single-fork ubuntu-latest: Vitest step bypasses the shared wrapper/);
    const crossOs = workflow.replace("pattern: ci-${{ matrix.os }}-*", "pattern: ci-*");
    expect(crossOs).not.toBe(workflow);
    expect(publicCiShape(crossOs).violations.join("\n")).toMatch(/aggregate ubuntu-latest: downloads ci-macos-latest-suite-1 from another OS/);
    for (const [from, to] of [["suite-${{ matrix.shard }}.log", "suite.log"], ["blob-${{ matrix.shard }}.json", "blob.json"]]) {
      const colliding = workflow.replace(from, to);
      expect(colliding, from).not.toBe(workflow);
      expect(publicCiShape(colliding).violations.join("\n"), from).toMatch(new RegExp(`aggregate ubuntu-latest: \\S*${to.replace(".", "\\.")}\\S* collides between ci-ubuntu-latest-suite-1 and ci-ubuntu-latest-suite-2`));
    }

    // the exported wrapper reaches the exported classifier: a complete RPC-only exit 1 becomes 0, while
    // the same wrapper without the classifier beside it keeps the raw 1 (fail closed)
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ci-wrapper-"));
    try {
      writeFileSync(join(dir, "rpc-only.log"), RPC_ONLY_LOG);
      const wrap = (root: string) =>
        spawnSync("bash", [join(root, CI_WRAPPER), join(dir, "ci.log"), "bash", "-c", 'cat "$1"; exit 1', "fake-vitest", join(dir, "rpc-only.log")], {
          encoding: "utf8",
        });
      const exported = wrap(c.root);
      expect(exported.status, exported.stdout + exported.stderr).toBe(0);
      expect(exported.stdout).toContain("VITEST_LOG verdict=RPC_ONLY");
      mkdirSync(join(dir, "scripts"));
      copyFileSync(join(c.root, CI_WRAPPER), join(dir, CI_WRAPPER));
      expect(wrap(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the exported tree contains a generated ignore file covering node_modules dist coverage and the tickmarkr state directory", { timeout: 180_000 }, () => {
    const c = getCandidate();
    expect(c.paths).toContain(".gitignore");
    const lines = readFileSync(join(c.root, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    // .vitest-cache/: the per-worktree Vitest cache (OBS-1159) must not dirty a gated worktree in the public tree.
    for (const entry of ["node_modules/", "dist/", "coverage/", ".vitest-cache/", ".tickmarkr/"]) {
      expect(lines, entry).toContain(entry);
    }
  });

  test("the export commit author email is the noreply identity rather than the personal address", { timeout: 180_000 }, () => {
    const c = getCandidate();
    // The export commit is HEAD in both contexts: the candidate tree (sole commit) and the public repo
    // (newest export). It is NOT the root commit — that premise held only for the very first export and
    // has been false since v1.60, so `--max-parents=0` pinned this guard to v1.59's commit and it would
    // have passed for any identity used since. It fired on 2.1.2 only because CI's shallow checkout makes
    // the grafted HEAD look parentless. Assert HEAD: correct in both contexts, and actually live.
    const exportCommit = execSync("git rev-parse HEAD", { cwd: c.root, encoding: "utf8" }).trim();
    const email = execSync(`git log -1 --format=%ae ${exportCommit}`, { cwd: c.root, encoding: "utf8" }).trim();
    expect(email).toBe(NOREPLY_IDENTITY);
    expect(email).not.toMatch(/gmail\.com$/);
  });

  test("the exported workflow's test run reports the manifest test suite as executed and not skipped", { timeout: 600_000 }, // OBS-116 load-margin reasoning: 2x headroom absorbs concurrent cold Vitest bootstrap contention.
  () => {
    const c = getCandidate();
    // both contexts: every workflow test step runs the unfiltered full suite, and the vitest include
    // glob collects this file — a path filter or exclude here is exactly how a silent skip happens
    const testCmds: string[] = [];
    for (const wf of workflowPaths(c)) {
      const text = readFileSync(join(c.root, wf), "utf8");
      for (const m of text.matchAll(/npm (?:run )?(test(?::[\w-]+)?)\b/g)) testCmds.push(m[1]);
    }
    expect(testCmds.length).toBeGreaterThan(0);
    const scripts = JSON.parse(readFileSync(join(c.root, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const cmd of testCmds) expect(scripts[cmd], cmd).toMatch(/^vitest run(?: --coverage)?$/);
    expect(readFileSync(join(c.root, "vitest.config.ts"), "utf8")).toContain("tests/**/*.test.ts");

    if (!existsSync(EXPORT_SCRIPT)) {
      // exported/public tree: this very run IS the tree's test run, and this test is executing
      expect((expect.getState().testPath ?? "").replace(/\\/g, "/")).toMatch(/tests\/repo\/export-manifest\.test\.ts$/);
      return;
    }
    // private tree: run the suite inside the candidate exactly as the exported workflow's test step
    // would, and require vitest's own report to show every manifest test executed and passed
    const nmLink = join(c.root, "node_modules");
    const reportDir = mkdtempSync(join(tmpdir(), "tickmarkr-inner-report-"));
    const reportPath = join(reportDir, "report.json");
    try {
      symlinkSync(join(ROOT, "node_modules"), nmLink);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "VITEST" && !k.startsWith("VITEST_")));
      try {
        execSync(
          `node node_modules/vitest/vitest.mjs run tests/repo/export-manifest.test.ts --reporter=json --outputFile="${reportPath}"`,
          { cwd: c.root, stdio: "pipe", env },
        );
      } catch (e) {
        const err = e as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(`manifest suite failed inside the export candidate:\n${err.stdout}\n${err.stderr}`);
      }
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        testResults: { name: string; assertionResults: { title: string; status: string }[] }[];
      };
      const fileResults = report.testResults.filter((r) => r.name.replace(/\\/g, "/").endsWith("tests/repo/export-manifest.test.ts"));
      expect(fileResults).toHaveLength(1);
      expect(fileResults[0].assertionResults.length).toBeGreaterThan(0);
      for (const r of fileResults[0].assertionResults) expect(r.status, r.title).toBe("passed");
    } finally {
      try {
        unlinkSync(nmLink);
      } catch {
        /* symlink was never created */
      }
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});

// ---- vendored scope-seam corpus: capped to exactly what compileGsd reads ----------------------
// 15 plan files (reduced to the compiler-consumed fields, compile-equivalence verified against the
// archived originals) + 10 summary markers (presence-only — compileGsd never reads summary content)
// across the six archived directories; no research/context/diagnosis/validation artifact.
const VENDORED_SCOPE_SEAM: Record<string, string[]> = {
  "29-fleet-metering": [
    "29-01-PLAN.md", "29-01-SUMMARY.md", "29-02-PLAN.md", "29-02-SUMMARY.md",
    "29-03-PLAN.md", "29-03-SUMMARY.md", "29-04-PLAN.md", "29-04-SUMMARY.md",
  ],
  "30-config-report-currency": [
    "30-01-PLAN.md", "30-01-SUMMARY.md", "30-02-PLAN.md", "30-02-SUMMARY.md", "30-03-PLAN.md", "30-03-SUMMARY.md",
  ],
  "33-fleet-preference": ["33-01-PLAN.md", "33-02-PLAN.md", "33-03-PLAN.md"],
  "34-exploration-within-prefer": ["34-01-PLAN.md", "34-02-PLAN.md"],
  "35-subprocess-driver-stdin-hang-hard-05": ["35-01-PLAN.md", "35-01-SUMMARY.md"],
  "36-adapter-honesty-headless-metering-pi-channel-truth-spend-11-": [
    "36-01-PLAN.md", "36-01-SUMMARY.md", "36-02-PLAN.md", "36-02-SUMMARY.md",
  ],
};

describe("export boundary — vendored scope-seam corpus stays at the compiler-consumed minimum", () => {
  test("each vendored scope seam fixture directory contains only the compiler plan and summary marker files the original archived phase compiled from and no companion research context diagnosis or validation artifact", () => {
    for (const [dir, expected] of Object.entries(VENDORED_SCOPE_SEAM)) {
      const actual = readdirSync(join(ROOT, "tests/fixtures/scope-seam", dir)).sort();
      expect(actual, dir).toEqual([...expected].sort());
      for (const f of actual) expect(f, `${dir}/${f}`).toMatch(/-(PLAN|SUMMARY)\.md$/);
    }
    const all = Object.values(VENDORED_SCOPE_SEAM).flat();
    expect(all.filter((f) => f.endsWith("-PLAN.md"))).toHaveLength(15);
    expect(all.filter((f) => f.endsWith("-SUMMARY.md"))).toHaveLength(10);
  });
});

test(
  "test: the export-manifest test's nested single-file vitest invocation carries a timeout budget with at least double its prior headroom",
  () => {
    const source = readFileSync(join(ROOT, "tests/repo/export-manifest.test.ts"), "utf8");
    const start = source.indexOf('test("the exported workflow\'s test run reports the manifest test suite as executed and not skipped"');
    const end = source.indexOf("\n  });", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, end)).toContain("600_000");
  },
);

test(
  "the widened budget carries an inline comment naming the load-margin reasoning rather than a bare number change",
  () => {
    const buildSource = readFileSync(join(ROOT, "tests/repo/build-provisioning.test.ts"), "utf8");
    const buildStart = buildSource.indexOf('test(\n    "the standalone test command provisions a fresh build first');
    const buildEnd = buildSource.indexOf("\n  );", buildStart);
    const exportSource = readFileSync(join(ROOT, "tests/repo/export-manifest.test.ts"), "utf8");
    const exportStart = exportSource.indexOf('test("the exported workflow\'s test run reports the manifest test suite as executed and not skipped"');
    const exportEnd = exportSource.indexOf("\n  });", exportStart);
    expect(buildSource.slice(buildStart, buildEnd)).toContain("load-margin reasoning");
    expect(exportSource.slice(exportStart, exportEnd)).toContain("load-margin reasoning");
  },
);
