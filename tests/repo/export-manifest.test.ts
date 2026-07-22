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
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");

// ---- the allowlist: the enumerated public path set -------------------------------------------
// Entries for paths later v1.59 tasks generate (public .gitignore, ci.public.yml, issue/PR
// templates, docs/codebase pages, the canonical overseer skill) are enumerated now — an allowlist
// entry for a not-yet-present path admits nothing until the path exists.
const PUBLIC_EXACT = new Set([
  ".gitignore",
  ".oxlintrc.json",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "FLEET.md",
  "LICENSE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
  "tickmarkr.spec.md",
  "tsconfig.json",
  "vitest.config.ts",
  ".github/pull_request_template.md",
  "scripts/emit-schema.ts",
  "scripts/probe-rig.mjs",
  "specs/export-selftest.spec.md", // the generated stub — the ONLY specs/ path that ships
]);
const PUBLIC_PREFIXES = [
  ".github/ISSUE_TEMPLATE/",
  ".github/workflows/",
  "assets/",
  "docs/codebase/", // docs allowlist lands in T3; CONCERNS.md stays denied below
  // fixtures/ is enumerated here (compiler samples + eval-lab trees under fixtures/eval/) —
  // fail-closed: a new top-level fixtures path only ships because this prefix admits it.
  "fixtures/",
  "schema/",
  "skills/tickmarkr-auto/",
  "skills/tickmarkr-loop/",
  "skills/tickmarkr-overseer/",
  "src/",
  "tests/",
];

// ---- the private path classes: rejected at ANY depth -----------------------------------------
const PRIVATE_SEGMENTS: Record<string, string> = {
  ".planning": "operator planning tree",
  ".tickmarkr": "tickmarkr run state",
  ".claude": "claude state",
  ".overseer": "overseer state",
  ".git": "git internals",
  "node_modules": "dependencies",
};

function privateClass(path: string): string | undefined {
  for (const seg of path.split("/")) {
    if (PRIVATE_SEGMENTS[seg]) return PRIVATE_SEGMENTS[seg];
    if (seg === "CLAUDE.md") return "operator instructions";
    if (/^ASSESSMENT-.+\.md$/.test(seg)) return "internal assessment";
    if (/\.local\./.test(seg)) return "local-machine file";
  }
  if (path.startsWith("specs/") && !PUBLIC_EXACT.has(path)) return "private spec corpus";
  if (path === "docs/codebase/CONCERNS.md") return "private concerns page";
  if (path.startsWith("docs/analysis/") || path.startsWith("docs/superpowers/")) return "operational diary docs";
  return undefined;
}

// fail closed: unclassified is rejected exactly like private — only the enumerated set ships
const accepts = (path: string): boolean =>
  privateClass(path) === undefined && (PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((pre) => path.startsWith(pre)));

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
      const rejected = candidate.paths.filter((p) => !accepts(p)).map((p) => `${p} (${privateClass(p) ?? "not allowlisted"})`);
      expect(rejected).toEqual([]);
      expect(secretFindings(candidate.root, candidate.paths)).toEqual([]);
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

  test("the exported tree contains a generated ignore file covering node_modules dist coverage and the tickmarkr state directory", { timeout: 180_000 }, () => {
    const c = getCandidate();
    expect(c.paths).toContain(".gitignore");
    const lines = readFileSync(join(c.root, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    for (const entry of ["node_modules/", "dist/", "coverage/", ".tickmarkr/"]) {
      expect(lines, entry).toContain(entry);
    }
  });

  test("the export commit author email is the noreply identity rather than the personal address", { timeout: 180_000 }, () => {
    const c = getCandidate();
    // the export commit is the root commit in both contexts: candidate (sole commit) and public repo
    const rootCommit = execSync("git rev-list --max-parents=0 HEAD", { cwd: c.root, encoding: "utf8" }).trim().split("\n")[0];
    const email = execSync(`git log -1 --format=%ae ${rootCommit}`, { cwd: c.root, encoding: "utf8" }).trim();
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
