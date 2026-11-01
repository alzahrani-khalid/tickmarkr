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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      // v2.8.2 T6 (ANL-022 §7.5 Deleted): the retired count helper leaves the allowlist with its file
      "scripts/assert-test-file-count.sh",
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
// a WHOLE path through a scripts/ segment (v2.8.2 T6): the Release workflow's skills/tickmarkr-overseer/scripts/grade-ci.sh
// is that path, never read as scripts/grade-ci.sh; it ends on a word character so a path cited at the end of a comment
// sentence keeps no trailing dot
const extractScriptRefs = (text: string): string[] => text.match(/(?<![\w./-])(?:[\w.-]+\/)*scripts\/[\w./-]*\w/g) ?? [];
const NOREPLY_IDENTITY = "53393181+alzahrani-khalid@users.noreply.github.com";

// OBS-1184: every public-CI Vitest test step runs through the wrapper (since v2.8.2 T1 it decides from the run's own
// record, `<log>.record.json`, not the log). v2.8.2 T7 (ANL-022 §7.4) — the sharded form: every job uploads its
// $RUNNER_TEMP/proof/ as proof-<os>-<part> last, under always(), with no count step and no serial set step; the
// aggregate downloads its OS's groups (`proof-<os>-*`, merged) into $RUNNER_TEMP/group, replays the shards' blobs with
// its record under $RUNNER_TEMP/proof/merge/ — the one Vitest step outside the wrapper, a replay whose record must never
// sit among the group's — and its proof check reads exactly that group, that merge record and group/blobs. What the
// check reads is what bash expands its arguments to in a scratch runner temp after every job of one OS wrote, uploaded
// and the aggregate downloaded. Returns the violations plus each wrapped command as "<job>: <command>".
const CI_WRAPPER = "scripts/run-ci-vitest.sh";
type PublicStep = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, string | boolean> };
type PublicJob = { steps?: PublicStep[]; strategy?: { matrix?: Record<string, unknown[]> } };
function publicCiShape(workflow: string): { violations: string[]; wrapped: string[] } {
  const jobs = (parseYaml(workflow) as { jobs?: Record<string, PublicJob> }).jobs ?? {};
  const violations: string[] = [];
  const wrapped: string[] = [];
  const runnerTemp = realpathSync(mkdtempSync(join(tmpdir(), "tickmarkr-ci-shape-")));
  // bash's own expansion of shell words under RUNNER_TEMP=<runner>, one path per line
  const expand = (words: string, runner: string): string[] => {
    const run = spawnSync("bash", ["-c", `printf '%s\\n' ${words}`], { cwd: runner, encoding: "utf8", env: { ...process.env, RUNNER_TEMP: runner } });
    if (run.status !== 0) throw new Error(`bash could not expand ${words}: ${run.stderr}`);
    return run.stdout.split("\n").filter((line) => line !== "");
  };
  // one OS: every matrix row of every job with os ubuntu-latest, its expressions rendered
  const render = (text: string, vars: Record<string, string>, runner: string) => text
    .replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? `<matrix.${key}>`).replaceAll("${{ runner.temp }}", runner);
  const uploads: { artifact: string; dir: string }[] = [];
  let aggregate: { steps: PublicStep[]; vars: Record<string, string>; runner: string } | undefined;
  try {
    for (const [job, { steps = [], strategy }] of Object.entries(jobs)) {
      let rows: Record<string, string>[] = [{}];
      for (const [axis, values] of Object.entries(strategy?.matrix ?? {})) rows = rows.flatMap((row) => values.map((value) => ({ ...row, [axis]: String(value) })));
      for (const vars of rows.filter((row) => (row.os ?? "ubuntu-latest") === "ubuntu-latest")) {
        const runner = join(runnerTemp, `${job}-${Object.values(vars).join("-")}`);
        mkdirSync(runner, { recursive: true });
        for (const step of steps) {
          const run = (step.run ?? "").trim();
          if (/\bvitest\b|\bnpm (?:run )?test\b/.test(run)) {
            const m = /^bash scripts\/run-ci-vitest\.sh ("[^"]+") ([^\n]+)$/.exec(run);
            const replay = /^mkdir -p "\$RUNNER_TEMP\/proof\/merge" && TICKMARKR_CI_RECORD="(\$RUNNER_TEMP\/proof\/merge\/[^"/]+)" npx vitest run --merge-reports=\S+ --coverage [^\n]*$/.exec(run);
            if (m) {
              if (!wrapped.includes(`${job}: ${m[2]}`)) wrapped.push(`${job}: ${m[2]}`);
              for (const log of expand(render(m[1]!, vars, runner), runner)) {
                mkdirSync(join(log, ".."), { recursive: true });
                writeFileSync(log, "");
                writeFileSync(`${log}.record.json`, "");
              }
            } else if (!replay) violations.push(`${job}: Vitest step bypasses the record wrapper: ${run}`);
          }
          if (/assert-test-file-count|Assert collected test-file count/.test(run)) violations.push(`${job}: keeps the old count step: ${run}`);
          if (/\bcli\.ts assert\b/.test(run)) violations.push(`${job}: keeps the serial set step: ${run}`);
          for (const value of Object.values(step.env ?? {})) {
            if (/\bblob-/.test(value)) {
              const blob = render(value, vars, runner);
              mkdirSync(join(blob, ".."), { recursive: true });
              writeFileSync(blob, "");
            }
          }
        }
        const upload = steps.at(-1);
        const artifact = render(String(upload?.with?.name ?? ""), vars, runner);
        if (upload?.uses !== "actions/upload-artifact@v4" || upload.if !== "always()" || upload.with?.path !== "${{ runner.temp }}/proof/"
          || !/^proof-ubuntu-latest-[\w-]+$/.test(artifact) || uploads.some((other) => other.artifact === artifact)) {
          violations.push(`${job}: the last step must upload $RUNNER_TEMP/proof/ as proof-<os>-<part> under always(): ${JSON.stringify(upload)}`);
        }
        if (job === "aggregate") aggregate = { steps, vars, runner };
        else uploads.push({ artifact, dir: join(runner, "proof") });
      }
    }
    if (aggregate === undefined) violations.push("no aggregate job");
    else {
      const { steps, vars, runner } = aggregate;
      // the download: every group of this OS's other jobs, merged into one directory
      const download = steps.find((step) => step.uses === "actions/download-artifact@v4");
      const pattern = new RegExp(`^${render(String(download?.with?.pattern ?? ""), vars, runner).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
      const into = render(String(download?.with?.path ?? ""), vars, runner);
      if (download?.with?.["merge-multiple"] !== true || uploads.length === 0 || !uploads.every(({ artifact }) => pattern.test(artifact))) {
        violations.push(`aggregate: the download must merge every group of its OS: ${JSON.stringify(download)}`);
      }
      for (const { artifact, dir } of uploads) if (pattern.test(artifact)) cpSync(dir, into, { recursive: true });
      const replayed = steps.map((step) => /TICKMARKR_CI_RECORD="([^"]+)"/.exec(step.run ?? "")?.[1]).filter((path) => path !== undefined).flatMap((path) => expand(`"${path}"`, runner));
      for (const path of replayed) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "");
      }
      const checks = steps.map((step) => /\bcli\.ts proof (.+)$/.exec((step.run ?? "").trim())?.[1]).filter((args) => args !== undefined);
      if (checks.length !== 1) violations.push(`aggregate: ${checks.length} proof checks, expected exactly one`);
      else {
        const words = expand(checks[0]!.replace(/"\$GITHUB_SHA"/, "sha"), runner);
        const flag = (name: string) => words[words.indexOf(name) + 1];
        const dirs = words.filter((word, i) => i > 0 && !words[i - 1]!.startsWith("--") && !word.startsWith("--"));
        const read = dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : []).filter((name) => name.endsWith(".record.json")).map((name) => join(dir, name)));
        const written = uploads.flatMap(({ dir }) => readdirSync(dir).filter((name) => name.endsWith(".record.json")).map((name) => join(into, name)));
        if ([...read].sort().join("\n") !== [...written].sort().join("\n")) {
          violations.push(`aggregate: proof check reads [${read.join(", ")}] but the shard and single-fork jobs upload [${written.join(", ")}]`);
        }
        if (replayed.length !== 1 || flag("--merge-record") !== replayed[0]) violations.push(`aggregate: proof check's merge record ${flag("--merge-record")} is not the replay's [${replayed.join(", ")}]`);
        if (flag("--blobs") !== join(into, "blobs") || readdirSync(join(into, "blobs")).length === 0) violations.push(`aggregate: proof check's blobs ${flag("--blobs")} are not the downloaded blobs`);
      }
    }
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
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

  test("test: every script the exported workflows call exists in the exported tree, with the Release workflow calling the shipped grader at its full path and nothing calling the retired count helper, so a workflow left calling a script the export lacks fails (C-del)", { timeout: 180_000 }, () => {
    // extractor self-checks: it catches the trap class this criterion exists for, and reads a whole path whole
    expect(extractScriptRefs("      run: bash scripts/export-public.sh")).toEqual(["scripts/export-public.sh"]);
    expect(extractScriptRefs('bash skills/tickmarkr-overseer/scripts/grade-ci.sh "$run_id" "$GITHUB_SHA" .'))
      .toEqual(["skills/tickmarkr-overseer/scripts/grade-ci.sh"]);
    const c = getCandidate();
    const shipped = new Set(c.paths);
    const unshipped = (text: string) => extractScriptRefs(text).filter((ref) => !shipped.has(ref));
    for (const wf of workflowPaths(c)) {
      const text = readFileSync(join(c.root, wf), "utf8");
      expect(unshipped(text), `${wf} calls a script the export lacks`).toEqual([]);
      expect(text, wf).not.toMatch(/assert-test-file-count/);
    }
    // the Release workflow calls the shipped grader by its full path, and the export ships it
    const release = readFileSync(join(c.root, ".github/workflows/release.yml"), "utf8");
    expect(extractScriptRefs(release)).toContain("skills/tickmarkr-overseer/scripts/grade-ci.sh");
    expect(shipped.has("skills/tickmarkr-overseer/scripts/grade-ci.sh")).toBe(true);
    // the retired count helper is gone from the tree and from the export (ANL-022 §7.5 Deleted)
    expect(existsSync(join(ROOT, "scripts/assert-test-file-count.sh"))).toBe(false);
    expect(shipped.has("scripts/assert-test-file-count.sh")).toBe(false);
    // a workflow left calling a script the export lacks fails: the retired helper, or the grader by its scripts/ tail
    expect(unshipped(`${release}      - run: sh scripts/assert-test-file-count.sh "$RUNNER_TEMP/proof/a.log"\n`))
      .toEqual(["scripts/assert-test-file-count.sh"]);
    expect(unshipped(release.replace("bash skills/tickmarkr-overseer/scripts/grade-ci.sh ", "bash scripts/grade-ci.sh ")))
      .toEqual(["scripts/grade-ci.sh"]);
  });

  test("test: the exported public workflow's proof check reads exactly the records its shard and single-fork jobs upload, beside the replay record its aggregate writes outside that group, so a check reading another directory, a replay record counted into the group, a test step outside the wrapper or a workflow that keeps the old count step fails (W-F2)", { timeout: 180_000 }, () => {
    const c = getCandidate();
    const wf = ".github/workflows/ci.public.yml";
    for (const path of [wf, CI_WRAPPER, "scripts/ci/cli.ts"]) expect(c.paths, path).toContain(path);
    const workflow = readFileSync(join(c.root, wf), "utf8");
    const { violations, wrapped } = publicCiShape(workflow);
    expect(violations).toEqual([]);
    expect(wrapped.sort()).toEqual([
      "single-fork: npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper",
      "suite: npm run test:coverage -- --project suite --shard=${{ matrix.shard }}/4",
    ]);
    expect(workflow).not.toMatch(/assert-test-file-count/);

    // the guard reds each regression it exists for, each in the exported text
    const regress = (from: string, to: string): string => {
      const changed = workflow.replace(from, to);
      expect(changed, from).not.toBe(workflow);
      return publicCiShape(changed).violations.join("\n");
    };
    expect(regress(`bash ${CI_WRAPPER} "$RUNNER_TEMP/proof/suite-\${{ matrix.shard }}.log" `, "")).toMatch(/^suite: Vitest step bypasses the record wrapper/m);
    // the check reads another directory: the aggregate's own proof directory instead of the downloaded group
    expect(regress('--blobs "$RUNNER_TEMP/group/blobs" "$RUNNER_TEMP/group"', '--blobs "$RUNNER_TEMP/group/blobs" "$RUNNER_TEMP/proof"'))
      .toMatch(/^aggregate: proof check reads \[[^\]]*\] but the shard and single-fork jobs upload \[[^,\]]+(, [^,\]]+){4}\]$/m);
    // the replay record counted into the group: written at its top level, the check reads it beside the originals
    const counted = regress('mkdir -p "$RUNNER_TEMP/proof/merge" && TICKMARKR_CI_RECORD="$RUNNER_TEMP/proof/merge/merge.record.json"',
      'mkdir -p "$RUNNER_TEMP/proof/merge" && TICKMARKR_CI_RECORD="$RUNNER_TEMP/group/merge.record.json"');
    expect(counted).toMatch(/^aggregate: Vitest step bypasses the record wrapper/m);
    expect(counted).toMatch(/^aggregate: proof check reads \[[^\]]*merge\.record\.json[^\]]*\]/m);
    // the old count step kept beside the proof check, or the serial set step in its place
    const countStep = '      - name: Assert collected test-file count\n        if: always()\n'
      + '        run: sh scripts/assert-test-file-count.sh "$RUNNER_TEMP/proof/suite-1.log"\n';
    const checkStep = "      - name: Check the proof group of this OS\n";
    expect(regress(checkStep, countStep + checkStep)).toMatch(/^aggregate: keeps the old count step/m);
    expect(regress(checkStep, '      - name: Assert collected test-file set\n        run: npx tsx scripts/ci/cli.ts assert $RUNNER_TEMP/group/*.record.json\n' + checkStep))
      .toMatch(/^aggregate: keeps the serial set step/m);
    // a proof group never uploaded under its OS's name
    expect(regress("          name: proof-${{ matrix.os }}-single-fork\n", "          name: proof-${{ github.job }}\n")).toMatch(/^single-fork: the last step must upload/m);

    // v2.8.2 T1: the exported wrapper decides from the run's own record through the exported record tooling
    // (scripts/ci) — a complete RPC-only exit 1 becomes 0 — while the same wrapper without that tooling beside it
    // keeps the raw 1 (fail closed). A stand-in npx in a one-file candidate tree answers discovery and writes the
    // record the run would.
    for (const path of ["scripts/ci/cli.ts", "scripts/ci/reporter.ts"]) expect(c.paths, path).toContain(path);
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ci-wrapper-"));
    try {
      const tree = join(dir, "tree");
      mkdirSync(join(tree, "tests/suite"), { recursive: true });
      mkdirSync(join(tree, "bin"));
      writeFileSync(join(tree, "tests/suite/a.test.ts"), "");
      writeFileSync(join(dir, "rpc-only.log"), RPC_ONLY_LOG);
      writeFileSync(join(dir, "rpc-only.record.json"), `${JSON.stringify({
        schema: "tickmarkr-ci-record/2", head: "b".repeat(40), shard: null,
        files: [{ file: "tests/suite/a.test.ts", project: "suite", state: "passed", durationMs: 1 }], reason: "passed",
        unhandled: [{ name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" }],
        tests: [{ file: "tests/suite/a.test.ts", project: "suite", name: "a", state: "passed" }],
      })}\n`);
      writeFileSync(join(tree, "bin/npx"), `#!/usr/bin/env bash
case "$2" in
  list) for arg in "$@"; do case "$arg" in --json=*) printf '[{"file":"%s/tests/suite/a.test.ts","projectName":"suite"}]\\n' "$PWD" > "\${arg#--json=}" ;; esac; done ;;
  run) cp "$RECORD_SRC" "$TICKMARKR_CI_RECORD"; cat "$LOG_SRC"; exit 1 ;;
esac
`);
      chmodSync(join(tree, "bin/npx"), 0o755);
      // the exported wrapper and record tooling, with the dependency link and module type the checkout gives them
      const exportedCheckout = (root: string, withTooling: boolean) => {
        mkdirSync(join(root, "scripts"), { recursive: true });
        copyFileSync(join(c.root, CI_WRAPPER), join(root, CI_WRAPPER));
        if (withTooling) cpSync(join(c.root, "scripts/ci"), join(root, "scripts/ci"), { recursive: true });
        symlinkSync(realpathSync(join(ROOT, "node_modules")), join(root, "node_modules"), "dir");
        copyFileSync(join(c.root, "package.json"), join(root, "package.json"));
        return root;
      };
      const wrap = (root: string) =>
        spawnSync("bash", [join(root, CI_WRAPPER), join(dir, "ci.log"), "npx", "vitest", "run", "--project", "suite"], {
          cwd: tree, encoding: "utf8",
          env: { ...process.env, PATH: `${join(tree, "bin")}:${process.env.PATH}`, RECORD_SRC: join(dir, "rpc-only.record.json"), LOG_SRC: join(dir, "rpc-only.log") },
        });
      const exported = wrap(exportedCheckout(join(dir, "exported"), true));
      expect(exported.status, exported.stdout + exported.stderr).toBe(0);
      expect(exported.stdout).toContain("RECORD_VERDICT verdict=RPC_ONLY");
      expect(exported.stdout).toContain("SHARD_CONTRACT verdict=GREEN shard=none planned=1 recorded=1 defects=0");
      expect(wrap(exportedCheckout(join(dir, "bare"), false)).status).toBe(1);
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
