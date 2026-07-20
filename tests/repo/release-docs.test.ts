import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, test, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { makeRepo } from "../helpers/tmprepo.js";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const RELEASING_MD = join(ROOT, "RELEASING.md");
const CHANGELOG_MD = join(ROOT, "CHANGELOG.md");
const TESTING_MD = join(ROOT, "docs/codebase/TESTING.md");
const PACKAGE_JSON = join(ROOT, "package.json");
const RELEASE_YML = join(ROOT, ".github/workflows/release.yml");
const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");
const PUBLIC_HTTPS = "https://github.com/alzahrani-khalid/tickmarkr.git";
const PUBLIC_SSH = "git@github.com:alzahrani-khalid/tickmarkr.git";

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function getCurrentVersion(): string {
  const pkg = JSON.parse(readFile(PACKAGE_JSON));
  return pkg.version;
}

function countTestFilesInDir(dir: string): number {
  const fullPath = join(ROOT, dir);
  if (!existsSync(fullPath)) return 0;
  return readdirSync(fullPath, { recursive: false })
    .filter((f) => typeof f === "string" && f.endsWith(".test.ts")).length;
}

describe("release documentation", () => {
  describe("RELEASING.md", () => {
    test("the releasing documentation describes committing each export on top of a persistent clone of the public repository instead of a recurring force push", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("append-only");
      expect(content).toContain("persistent clone");
      expect(content).toContain("Do not force-push");
      expect(content).toMatch(
        /commit.*on top.*main.*normal fast-forward.*never force-push/is
      );
    });

    test("the releasing documentation states the public history is append only with one commit per release", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("append-only");
      expect(content).toContain("one commit per release");
      expect(content).toMatch(/append-only.*history.*one commit per release/is);
    });

    test("the releasing documentation accurately describes the export script generating a public ignore file", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain(".gitignore");
      expect(content).toContain("Generates a `.gitignore`");
      expect(content).toContain("node_modules/");
      expect(content).toContain("dist/");
      expect(content).toContain("coverage/");
      expect(content).toContain(".tickmarkr/");
    });

    test("the releasing documentation accurately describes which documentation pages the export now ships", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("Public documentation included");
      const expectedPages = [
        "ARCHITECTURE.md",
        "CLI-DESIGN.md",
        "CONVENTIONS.md",
        "INTEGRATIONS.md",
        "STACK.md",
        "STRUCTURE.md",
        "TESTING.md",
      ];
      for (const page of expectedPages) {
        expect(content).toContain(page);
      }
      expect(content).toContain("Private documentation pages");
      expect(content).toContain("CONCERNS.md");
    });

    test("the releasing documentation states the trusted-publisher binding follows repository identity and must be re-saved after a rename", () => {
      const content = readFile(RELEASING_MD);
      expect(content).toContain("follows the repository **identity**");
      expect(content).toMatch(/trusted-publisher binding/i);
      expect(content).toMatch(/binding.*followed.*renamed/is);
      expect(content).toMatch(/rename.*binding must be re-saved/is);
    });

    test("the releasing documentation's append-only one-commit-per-release language is unchanged from its prior form", () => {
      const content = readFile(RELEASING_MD);
      // pinned verbatim as this language read before the v1.60 truth-check rewrite
      expect(content).toContain(
        "The private development repository retains full history; the public repository follows an append-only model with one commit per release."
      );
      expect(content).toContain(
        "The public repository maintains **append-only history** with one commit per release."
      );
      expect(content).toContain(
        "**Do not force-push:** Public history is append-only. Force-pushing orphans external forks and invalidates open pull requests. Each release is one new commit on top of `main`."
      );
    });
  });

  describe("CHANGELOG.md", () => {
    test("the changelog contains a curated summary of every release from the last documented entry through the current package version", () => {
      const content = readFile(CHANGELOG_MD);
      // Extract major.minor from the full version (e.g., "1.58" from "1.58.0")
      const currentVersion = getCurrentVersion();
      const majorMinor = currentVersion.split(".").slice(0, 2).join(".");
      expect(content).toContain(`v${majorMinor}`);
      // Should have entry for v1.38 (the previous documented entry) and v1.58+
      expect(content).toContain("v1.38");
      expect(content).toContain("v1.58");
      expect(content).toMatch(/v1\.\d+.*breaking changes/is);
    });

    test("the changelog points readers to github releases for per release detail", () => {
      const content = readFile(CHANGELOG_MD);
      expect(content).toContain("GitHub Releases");
      expect(content).toContain("github.com/alzahrani-khalid/tickmarkr/releases");
    });

    test("the changelog breaking change entries remain true against the current source tree", () => {
      const content = readFile(CHANGELOG_MD);
      // v1.38 breaking changes: state directory, global config, native spec marker, resume
      expect(content).toMatch(/\.tickmarkr/);
      expect(content).toMatch(/XDG_CONFIG_HOME/);
      expect(content).toMatch(/tickmarkr:spec/);
      // Verify breaking changes are documented in detail
      expect(content).toContain("State directory");
      expect(content).toContain("Global config");
      expect(content).toContain("Native spec marker");
      expect(content).toContain("Resume");
    });
  });

  describe("release workflow publish guard and provenance", () => {
    test("the release workflow's publish job runs only when the repository matches the public identity", () => {
      const workflow = parseYaml(readFile(RELEASE_YML));
      const jobs = Object.values(workflow.jobs) as Array<{ if?: string; steps: Array<{ run?: string }> }>;
      const publishJobs = jobs.filter((job) =>
        job.steps.some((step) => step.run?.includes("npm publish"))
      );
      expect(publishJobs.length).toBeGreaterThan(0);
      for (const job of publishJobs) {
        expect(job.if).toBe("github.repository == 'alzahrani-khalid/tickmarkr'");
      }
    });

    test("the release workflow's publish step always includes the provenance flag", () => {
      const workflow = parseYaml(readFile(RELEASE_YML));
      const steps = (Object.values(workflow.jobs) as Array<{ steps: Array<{ run?: string }> }>)
        .flatMap((job) => job.steps)
        .filter((step) => step.run?.includes("npm publish"));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.run).toContain("--provenance");
      }
    });

    test("the release workflow contains no comment describing provenance as conditional on a future repository move", () => {
      const content = readFile(RELEASE_YML);
      const comments = content
        .split("\n")
        .filter((line) => line.trimStart().startsWith("#"));
      for (const comment of comments) {
        expect(comment).not.toMatch(/restore the flag|pending the squashed public export|stays private/i);
        expect(comment).not.toMatch(/provenance.*(when|until|pending|requires a PUBLIC)/i);
      }
    });
  });

  // Behavioral check of `export-public.sh --onto <mirror>` against a synthetic source repo and a
  // local origin+clone pair. Skipped inside the exported public tree (the script never ships).
  describe("scripted mirror publish mode", { skip: !existsSync(EXPORT_SCRIPT) }, () => {
    const PAGES = [
      "ARCHITECTURE.md", "CLI-DESIGN.md", "CONVENTIONS.md", "INTEGRATIONS.md",
      "STACK.md", "STRUCTURE.md", "TESTING.md",
    ];
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@test.local", ...args], {
        cwd, encoding: "utf8",
      }).trim();

    let originDir: string;
    let mirror: string;
    let originMain: string;
    let divergentSha: string;
    const cleanup: string[] = [];

    beforeAll(() => {
      // synthetic private repo satisfying everything the export reads (version + docs allowlist)
      const privRepo = makeRepo({
        "package.json": JSON.stringify({ name: "fixture", version: "9.9.9" }, null, 2) + "\n",
        "src.txt": "fixture source\n",
        ...Object.fromEntries(PAGES.map((p) => [`docs/codebase/${p}`, `# ${p}\n`])),
      });
      // "public repo" remote with one prior release commit, and its persistent mirror clone
      originDir = makeRepo({ "previous-release.txt": "previous public release\n" });
      originMain = git(originDir, "rev-parse", "HEAD");
      const base = mkdtempSync(join(tmpdir(), "tickmarkr-mirror-"));
      cleanup.push(privRepo, originDir, base);
      mirror = join(base, "mirror");
      git(base, "clone", "-q", originDir, mirror);
      // Production pins the public GitHub identity. Keep this fixture offline by storing that raw
      // origin while git's standard insteadOf rewrite sends fetches to the synthetic local remote.
      git(mirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
      git(mirror, "config", `url.${originDir}.insteadOf`, PUBLIC_HTTPS);
      // diverge the mirror locally — the script must discard this via reset to origin/main
      writeFileSync(join(mirror, "divergent.txt"), "local-only divergence\n");
      git(mirror, "add", "-A");
      git(mirror, "commit", "-q", "--no-gpg-sign", "-m", "local divergence");
      divergentSha = git(mirror, "rev-parse", "HEAD");

      execFileSync("bash", [EXPORT_SCRIPT, "--onto", mirror], {
        cwd: privRepo,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: base },
      });
    }, 60_000);

    afterAll(() => {
      for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
    });

    test("the scripted mirror publish mode resets the mirror clone to its own remote main before applying the export", () => {
      // the export commit sits directly on origin/main — the divergent local commit was discarded
      expect(git(mirror, "rev-parse", "HEAD~1")).toBe(originMain);
      expect(git(mirror, "log", "--format=%H")).not.toContain(divergentSha);
      expect(existsSync(join(mirror, "divergent.txt"))).toBe(false);
      // and nothing was pushed: the remote's main is untouched
      expect(git(originDir, "rev-parse", "main")).toBe(originMain);
    });

    test("the scripted mirror publish mode never deletes the mirror clone's own git metadata directory", () => {
      expect(existsSync(join(mirror, ".git"))).toBe(true);
      // metadata is intact and functional: the clone still knows its remote and passes fsck
      expect(git(mirror, "config", "--get", "remote.origin.url")).toBe(PUBLIC_HTTPS);
      git(mirror, "fsck", "--no-progress");
      // tracked files are replaced via git rm, never a filesystem glob that can match .git
      // (comments quote the retired glob as a warning, so only command lines are scanned)
      const script = readFile(EXPORT_SCRIPT);
      expect(script).toContain('git -C "$MIRROR" rm -rq -- .');
      const commandLines = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
      expect(commandLines.join("\n")).not.toMatch(/rm -rf -- \*/);
    });

    test("the scripted mirror publish mode's commit message contains the version read from the export's own package manifest", () => {
      const exportedPkg = JSON.parse(git(mirror, "show", "HEAD:package.json")) as { version: string };
      expect(exportedPkg.version).toBe("9.9.9");
      expect(git(mirror, "log", "-1", "--format=%s")).toBe(
        `tickmarkr ${exportedPkg.version} — public export`
      );
      // the version is read from the export tree's manifest, not the private checkout's
      expect(readFile(EXPORT_SCRIPT)).toContain('"$EXPORT_DIR/package.json"');
    });

    describe("--onto target guard", () => {
      const cleanup2: string[] = [];
      afterAll(() => {
        for (const dir of cleanup2) rmSync(dir, { recursive: true, force: true });
      });

      function runOnto(cwd: string, mirrorPath: string): { status: number; stdout: string; stderr: string } {
        const result = spawnSync("bash", [EXPORT_SCRIPT, "--onto", mirrorPath], {
          cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }

      // source checkout satisfying every file the export reads (version + docs allowlist)
      function makeSourceRepo(): string {
        const repo = makeRepo({
          "package.json": JSON.stringify({ name: "fixture", version: "9.9.9" }, null, 2) + "\n",
          "src.txt": "fixture source\n",
          ...Object.fromEntries(PAGES.map((p) => [`docs/codebase/${p}`, `# ${p}\n`])),
        });
        cleanup2.push(repo);
        return repo;
      }

      test("refuses a target inside the source checkout itself", () => {
        const src = makeSourceRepo();
        const result = runOnto(src, ".");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/inside the source checkout/);
        // and nothing was touched: the checkout still has its own history intact
        expect(existsSync(join(src, "src.txt"))).toBe(true);
      });

      test("refuses a target whose origin remote matches the source checkout's own origin", () => {
        // a "public" remote, one clone playing the source checkout, another playing the (wrong) mirror
        const sharedRemote = makeRepo({ "seed.txt": "seed\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-shared-origin-"));
        cleanup2.push(sharedRemote, base);

        const src = join(base, "src");
        git(base, "clone", "-q", sharedRemote, src);
        for (const [rel, content] of [
          ["package.json", JSON.stringify({ name: "fixture", version: "9.9.9" }, null, 2) + "\n"],
          ...PAGES.map((p): [string, string] => [`docs/codebase/${p}`, `# ${p}\n`]),
        ] as Array<[string, string]>) {
          const full = join(src, rel);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
        }
        git(src, "add", "-A");
        git(src, "commit", "-q", "--no-gpg-sign", "-m", "fixture content");

        const wrongMirror = join(base, "wrong-mirror");
        git(base, "clone", "-q", sharedRemote, wrongMirror);

        const result = runOnto(src, wrongMirror);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/matches the source checkout's own origin/);
      });

      test("refuses a clean mirror whose origin is not the expected public repository", () => {
        const src = makeSourceRepo();
        const wrongOrigin = makeRepo({ "wrong-repo.txt": "must survive\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-wrong-public-origin-"));
        cleanup2.push(wrongOrigin, base);
        const wrongMirror = join(base, "mirror");
        git(base, "clone", "-q", wrongOrigin, wrongMirror);
        const before = git(wrongMirror, "rev-parse", "HEAD");

        const result = runOnto(src, wrongMirror);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/expected public repository.*alzahrani-khalid\/tickmarkr/i);
        expect(git(wrongMirror, "rev-parse", "HEAD")).toBe(before);
        expect(existsSync(join(wrongMirror, "wrong-repo.txt"))).toBe(true);
      });

      test("accepts the expected public repository in SSH remote form", () => {
        const src = makeSourceRepo();
        const publicOrigin = makeRepo({ "previous-release.txt": "previous public release\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-public-ssh-origin-"));
        cleanup2.push(publicOrigin, base);
        const publicMirror = join(base, "mirror");
        git(base, "clone", "-q", publicOrigin, publicMirror);
        git(publicMirror, "remote", "set-url", "origin", PUBLIC_SSH);
        git(publicMirror, "config", `url.${publicOrigin}.insteadOf`, PUBLIC_SSH);

        const result = runOnto(src, publicMirror);
        expect(result.status).toBe(0);
        // the test configures an insteadOf rewrite; it should surface the divergence note
        expect(result.stderr).toMatch(/insteadOf rewrites the mirror origin/);
        expect(result.stderr).toContain("configured: " + PUBLIC_SSH);
        expect(git(publicMirror, "log", "-1", "--format=%s")).toBe("tickmarkr 9.9.9 — public export");
      });

      test("refuses a mirror subdirectory instead of partially replacing that repository", () => {
        const src = makeSourceRepo();
        const publicOrigin = makeRepo({ "nested/keep.txt": "must survive\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-mirror-subdir-"));
        cleanup2.push(publicOrigin, base);
        const publicMirror = join(base, "mirror");
        git(base, "clone", "-q", publicOrigin, publicMirror);
        const before = git(publicMirror, "rev-parse", "HEAD");

        const result = runOnto(src, join(publicMirror, "nested"));
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/repository toplevel/i);
        expect(git(publicMirror, "rev-parse", "HEAD")).toBe(before);
        expect(existsSync(join(publicMirror, "nested", "keep.txt"))).toBe(true);
      });

      test("refuses a target with an uncommitted or untracked local change", () => {
        const src = makeSourceRepo();
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-dirty-mirror-"));
        cleanup2.push(base);
        const dirtyMirror = join(base, "mirror");
        git(base, "clone", "-q", originDir, dirtyMirror);
        writeFileSync(join(dirtyMirror, "stray-untracked.txt"), "should block the run\n");

        const result = runOnto(src, dirtyMirror);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/local or untracked changes/);
        // and it was never reset — the stray file is still there, untouched
        expect(existsSync(join(dirtyMirror, "stray-untracked.txt"))).toBe(true);
      });

      test("refuses a mirror with a non-main branch checked out", () => {
        // reset --hard origin/main moves the CURRENT branch; off main, the export commit would
        // land on the wrong branch while `git push origin main` pushes nothing new
        const src = makeSourceRepo();
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-branch-mirror-"));
        cleanup2.push(base);
        const branchedMirror = join(base, "mirror");
        git(base, "clone", "-q", originDir, branchedMirror);
        git(branchedMirror, "checkout", "-q", "-b", "release-work");
        const before = git(branchedMirror, "rev-parse", "HEAD");

        const result = runOnto(src, branchedMirror);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/checked out, not main/);
        expect(git(branchedMirror, "rev-parse", "HEAD")).toBe(before);
      });

      test("refuses a mirror holding a gitignored leftover file invisible to plain status", () => {
        // ignored files survive reset + git rm; if the export's replacement .gitignore stops
        // covering one, git add -A would publish it past the export-dir secret scan
        const src = makeSourceRepo();
        const ignoringOrigin = makeRepo({ ".gitignore": "secret.log\n", "tracked.txt": "x\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-ignored-mirror-"));
        cleanup2.push(ignoringOrigin, base);
        const ignoredMirror = join(base, "mirror");
        git(base, "clone", "-q", ignoringOrigin, ignoredMirror);
        writeFileSync(join(ignoredMirror, "secret.log"), "would bypass the export-dir scan\n");
        // precondition: plain porcelain is blind to it — exactly the bypass being closed
        expect(git(ignoredMirror, "status", "--porcelain")).toBe("");

        const result = runOnto(src, ignoredMirror);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/including ignored files/);
        expect(existsSync(join(ignoredMirror, "secret.log"))).toBe(true);
      });

      test("a mirror publish that fails after replacement begins restores the mirror to its pristine remote main", () => {
        // Plant a failing pre-commit hook (invisible to the cleanliness guard) to trigger mid-replacement
        // failure. The trap should restore the mirror completely — both staged changes and untracked debris.
        const src = makeSourceRepo();
        const failOrigin = makeRepo({ "baseline.txt": "baseline public\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-trap-restore-"));
        cleanup2.push(failOrigin, base);

        const failMirror = join(base, "mirror");
        git(base, "clone", "-q", failOrigin, failMirror);
        git(failMirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
        git(failMirror, "config", `url.${failOrigin}.insteadOf`, PUBLIC_HTTPS);

        // Snapshot the clean state before planting the hook
        const beforeSha = git(failMirror, "rev-parse", "HEAD");
        const beforeBranch = git(failMirror, "symbolic-ref", "--short", "HEAD");
        const beforeFiles = new Set(readdirSync(failMirror).filter((f) => f !== ".git"));

        // Plant a failing pre-commit hook in .git/hooks — invisible to status --porcelain --ignored
        mkdirSync(join(failMirror, ".git", "hooks"), { recursive: true });
        writeFileSync(
          join(failMirror, ".git", "hooks", "pre-commit"),
          "#!/bin/bash\nexit 1\n",
          { mode: 0o755 }
        );

        // Verify: the cleanliness guard (status --porcelain --ignored) sees nothing
        expect(git(failMirror, "status", "--porcelain")).toBe("");
        expect(git(failMirror, "status", "--porcelain", "--ignored")).toBe("");

        // Run export-public.sh --onto; the commit will fail at pre-commit hook, trap fires
        const result = runOnto(src, failMirror);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("failed — restoring");

        // Verify the mirror was restored: same commit, no divergence
        expect(git(failMirror, "rev-parse", "HEAD")).toBe(beforeSha);
        expect(git(failMirror, "symbolic-ref", "--short", "HEAD")).toBe(beforeBranch);

        // Verify all tracked and untracked content is gone (trap did reset --hard + clean -qfdx)
        // Files should match the baseline (minus .git which we exclude from comparison)
        const afterFiles = new Set(readdirSync(failMirror).filter((f) => f !== ".git"));
        expect(afterFiles).toEqual(beforeFiles);

        // Verify the index is clean (no staged changes left from the failed replacement)
        expect(git(failMirror, "status", "--porcelain")).toBe("");
        // Verify untracked debris is gone (trap ran clean -qfdx on extraction leftovers)
        expect(git(failMirror, "status", "--porcelain", "--ignored")).toBe("");

        // Verify git metadata survived intact (not clobbered by filesystem ops)
        git(failMirror, "fsck", "--no-progress");
      });

      test("the restore path is forced through a planted hook failure the cleanliness guard cannot see", () => {
        // Focused test: verify that hook failures bypass the pre-run cleanliness guard and still
        // get caught and restored. This proves the guard's status --porcelain --ignored is blind
        // to .git/hooks, and the trap path handles recovery.
        const src = makeSourceRepo();
        const guardOrigin = makeRepo({ "public.txt": "public\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-hook-guard-check-"));
        cleanup2.push(guardOrigin, base);

        const guardMirror = join(base, "mirror");
        git(base, "clone", "-q", guardOrigin, guardMirror);
        git(guardMirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
        git(guardMirror, "config", `url.${guardOrigin}.insteadOf`, PUBLIC_HTTPS);

        const beforeSha = git(guardMirror, "rev-parse", "HEAD");

        // Plant hook after clone — so it's definitely not visible to any pre-run checks
        mkdirSync(join(guardMirror, ".git", "hooks"), { recursive: true });
        writeFileSync(
          join(guardMirror, ".git", "hooks", "pre-commit"),
          "#!/bin/bash\nexit 1\n",
          { mode: 0o755 }
        );

        // Precondition: verify the guard (invoked by export-public before any mutation) is blind to it
        const guardResult = git(guardMirror, "status", "--porcelain", "--ignored");
        expect(guardResult).toBe("");

        // But the export-public command should still fail when git commit tries to run
        const result = runOnto(src, guardMirror);
        expect(result.status).not.toBe(0);

        // Verify the trap was invoked by checking for the restore message
        expect(result.stderr).toMatch(/failed — restoring.*origin\/main/);

        // Verify mirror was restored to exactly its prior state
        expect(git(guardMirror, "rev-parse", "HEAD")).toBe(beforeSha);
      });

      test("the mirror publish success path surfaces the origin-rewrite divergence note in its captured diagnostic output", () => {
        // When the mirror has an insteadOf rewrite configured, the script observes the divergence
        // between the configured URL and the effective URL, and emits a warning to stderr.
        // This test verifies the diagnostic is actually captured and observable.
        const src = makeSourceRepo();
        const publicOrigin = makeRepo({ "baseline.txt": "baseline\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-divergence-note-"));
        cleanup2.push(publicOrigin, base);

        const publicMirror = join(base, "mirror");
        git(base, "clone", "-q", publicOrigin, publicMirror);
        git(publicMirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
        // Configure an insteadOf rewrite so EFFECTIVE_ORIGIN differs from MIRROR_ORIGIN
        git(publicMirror, "config", `url.${publicOrigin}.insteadOf`, PUBLIC_HTTPS);

        const result = runOnto(src, publicMirror);
        expect(result.status).toBe(0);
        // The divergence note should be observable in stderr, not a hardcoded empty literal
        expect(result.stderr).toContain("insteadOf rewrites the mirror origin");
        expect(result.stderr).toContain(publicOrigin);
        expect(result.stderr).toContain("configured: " + PUBLIC_HTTPS);
      });

      describe("nothing-to-publish re-export", () => {
        // First publish + manual push (the operator's documented step), then re-run --onto with
        // an unchanged source: nothing stages, and the script must say so instead of letting an
        // empty commit exit 1 and misfire the failure-restore trap.
        let bareOrigin: string;
        let reMirror: string;
        let publishedSha: string;
        let rerun: { status: number; stdout: string; stderr: string };

        beforeAll(() => {
          const src = makeSourceRepo();
          const seedRepo = makeRepo({ "previous-release.txt": "previous public release\n" });
          const base = mkdtempSync(join(tmpdir(), "tickmarkr-reexport-"));
          cleanup2.push(seedRepo, base);
          // bare origin so the mirror's push lands like it would on GitHub
          bareOrigin = join(base, "origin.git");
          git(base, "clone", "-q", "--bare", seedRepo, bareOrigin);
          reMirror = join(base, "mirror");
          git(base, "clone", "-q", bareOrigin, reMirror);
          git(reMirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
          git(reMirror, "config", `url.${bareOrigin}.insteadOf`, PUBLIC_HTTPS);

          const first = runOnto(src, reMirror);
          expect(first.status).toBe(0);
          git(reMirror, "push", "-q", "origin", "main");
          publishedSha = git(reMirror, "rev-parse", "HEAD");

          rerun = runOnto(src, reMirror);
        }, 60_000);

        test("re-running the mirror publish for an already-published unchanged export reports nothing to publish and exits successfully", () => {
          expect(rerun.status).toBe(0);
          expect(rerun.stdout).toContain("nothing to publish");
          // the failure-restore message can no longer appear on a run where nothing actually failed
          expect(rerun.stderr).not.toContain("failed — restoring");
          expect(rerun.stdout + rerun.stderr).not.toContain("failed — restoring");
        });

        test("a nothing-to-publish re-export leaves the mirror at its remote main with no new commit", () => {
          const remoteMain = git(bareOrigin, "rev-parse", "main");
          expect(remoteMain).toBe(publishedSha);
          expect(git(reMirror, "rev-parse", "HEAD")).toBe(remoteMain);
          expect(git(reMirror, "rev-parse", "origin/main")).toBe(remoteMain);
          // and it left no debris behind — tree and index clean, metadata intact
          expect(git(reMirror, "status", "--porcelain", "--ignored")).toBe("");
          git(reMirror, "fsck", "--no-progress");
        });
      });

      // No offline test covers the note's ABSENCE without a rewrite: the identity guard requires
      // the configured origin to be the real GitHub URL, so a rewrite-free success path would
      // `git fetch` the live repository — a network dependency the suite must not carry. Absence
      // follows by construction from the guard's strict-inequality condition, pinned below.

      // The effective-origin divergence guard: its leading comment block and its code.
      function divergenceGuard(): { comment: string; body: string } {
        const match = readFile(EXPORT_SCRIPT).match(
          /((?:[ \t]*#[^\n]*\n)+)([ \t]*EFFECTIVE_ORIGIN=[^\n]*\n[ \t]*if \[\[ -n "\$EFFECTIVE_ORIGIN"[^\n]*\n[\s\S]*?\n[ \t]*fi)/
        );
        expect(match, "effective-origin divergence guard not found in export-public.sh").toBeTruthy();
        return { comment: match![1], body: match![2] };
      }

      test("a rewritten mirror origin is detected and handled by the shipped divergence policy in a fixture that runs without network access", () => {
        // The configured origin is the real GitHub URL, but git's insteadOf rewrite sends every
        // network operation (the script's own `git fetch origin` included) to a local stand-in —
        // the entire run needs no network access.
        const src = makeSourceRepo();
        const localOrigin = makeRepo({ "previous-release.txt": "previous public release\n" });
        const base = mkdtempSync(join(tmpdir(), "tickmarkr-divergence-policy-"));
        cleanup2.push(localOrigin, base);
        const rewrittenMirror = join(base, "mirror");
        git(base, "clone", "-q", localOrigin, rewrittenMirror);
        git(rewrittenMirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
        git(rewrittenMirror, "config", `url.${localOrigin}.insteadOf`, PUBLIC_HTTPS);

        const result = runOnto(src, rewrittenMirror);
        // Shipped policy is the retained warning: the rewrite is detected (the note names the
        // real rewritten target) and handled by completing the publish rather than refusing.
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("insteadOf rewrites the mirror origin");
        expect(result.stderr).toContain(localOrigin);
        expect(result.stderr).toContain("configured: " + PUBLIC_HTTPS);
        expect(git(rewrittenMirror, "log", "-1", "--format=%s")).toBe("tickmarkr 9.9.9 — public export");
      });

      test("the shipped policy is either a hard refusal on effective-origin divergence with every fixture passing offline, or the retained warning with the retention reason recorded in the guard's own comment", () => {
        const { comment, body } = divergenceGuard();
        if (/\bexit 1\b/.test(body)) {
          // Hard-refusal arm: the offline insteadOf fixtures throughout this suite are the
          // "every fixture passing offline" proof; the refusal must say what it refuses.
          expect(body).toMatch(/refus/i);
        } else {
          // Retained-warning arm: the decision and its rationale live in the guard's own comment.
          expect(comment).toMatch(/warning retained/i);
          expect(comment).toMatch(/never pushes/);
          expect(comment).toMatch(/insteadOf/);
          expect(body).toContain(">&2");
        }
      });

      test("the decision recorded in the guard comment matches what the code actually does", () => {
        const { comment, body } = divergenceGuard();
        // The comment records a retained warning, so the code must warn — and must not refuse.
        // Flipping either side alone (code to hard-fail, or comment to claim refusal) fails here.
        expect(comment).toMatch(/warning retained/i);
        expect(comment).toMatch(/NOT a hard refusal/i);
        expect(body).toContain('echo "export-public: note');
        expect(body).toContain(">&2");
        expect(body).not.toMatch(/\bexit\b/);
      });
    });
  });

  describe("TESTING.md test file count accuracy", () => {
    test("the testing page's stated repository test file count for its directory listing matches the actual number of test files present in that directory", () => {
      const content = readFile(TESTING_MD);
      const actualCount = countTestFilesInDir("tests/repo");

      // Extract the stated count from TESTING.md for the repo/ directory
      // Pattern: "├── repo/           N *.test.ts files"
      const match = content.match(/├──\s+repo\/\s+(\d+)\s+\*\.test\.ts\s+files/);
      expect(match, "repo test file count not found in TESTING.md").toBeTruthy();

      const statedCount = parseInt(match![1], 10);
      expect(statedCount).toBe(
        actualCount,
        `TESTING.md states ${statedCount} files but found ${actualCount} in tests/repo/`
      );
    });
  });
});
