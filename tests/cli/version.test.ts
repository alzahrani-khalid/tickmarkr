import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { distFingerprint, version } from "../../src/cli/commands/version.js";
import { dispatch, USAGE } from "../../src/cli/index.js";
import { spawnCli, assertCliSuccess, prepareBuiltCli, ENTRY } from "../helpers/built-cli.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG_PATH = join(ROOT, "package.json");
const LOCK_PATH = join(ROOT, "package-lock.json");
const PKG_VERSION = JSON.parse(readFileSync(PKG_PATH, "utf8")).version as string;
const PRIOR_RELEASE_VERSION = "1.78.0";
const RELEASING_PATH = join(ROOT, "RELEASING.md");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");

// A fresh worktree has no dist/, and `ignore-scripts=true` npm config skips the pretest build, so
// build on demand when this file runs outside the full suite. The decision — missing OR stale, not
// merely missing — lives in the shared helper, so it cannot be repaired here while the other
// spawning file keeps grading against yesterday's binary.
// OBS-96-safe: this file is inside the serialized dist-coupled fork, so nothing races the emit.
beforeAll(() => {
  prepareBuiltCli();
}, 300_000);

describe("tickmarkr version", () => {
  beforeEach(() => {
    process.env.TICKMARKR_BUILT_CLI_ENTRY = ENTRY;
  });
  test("version() returns exactly the package.json version string", async () => {
    expect(await version()).toBe(PKG_VERSION);
    expect(await version([])).toBe(PKG_VERSION);
  });

  test.each(["version", "--version", "-v"] as const)("dispatch(%s) prints the package version", async (cmd) => {
    const r = await dispatch(cmd, []);
    expect(r.out).toBe(PKG_VERSION);
    expect(r.code).toBe(0);
  });

  test("version output is one line with no banner or usage chrome", async () => {
    const r = await dispatch("version", []);
    expect(r.out).not.toContain("usage:");
    expect(r.out).not.toContain("\n");
  });

  test("test: tickmarkr version prints the package version alone on one line whereas version --dist appends a dist fingerprint on that same line which changes when one byte of one dist file changes so a fingerprint over file names alone or a second output line fails", async () => {
    const dist = mkdtempSync(join(tmpdir(), "tickmarkr-dist-fingerprint-"));
    const file = join(dist, "cli.js");
    writeFileSync(file, "a");
    const first = distFingerprint(dist);
    expect(await version([], dist)).toBe(PKG_VERSION);
    expect(await version(["--dist"], dist)).toBe(`${PKG_VERSION} dist:${first}`);
    expect((await version(["--dist"], dist)).includes("\n")).toBe(false);
    const dispatched = await dispatch("version", ["--dist"]);
    expect(dispatched.out).toMatch(new RegExp(`^${PKG_VERSION.replaceAll(".", "\\.")} dist:[0-9a-f]{64}$`));
    expect(dispatched.code).toBe(0);
    writeFileSync(file, "b");
    expect(distFingerprint(dist)).not.toBe(first);
  });

  test("non-TTY help output is byte-identical to USAGE (unchanged by version wiring)", async () => {
    for (const cmd of [undefined, "help", "-h", "--help", "nonexistent"] as const) {
      const r = await dispatch(cmd, []);
      expect(r.out).toBe(USAGE);
    }
  });

  test("the built CLI's version command reports the same version string as the package manifest", () => {
    const r = spawnCli(["version"]);
    assertCliSuccess(r, "version command");
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${PKG_VERSION}\n`);
  });

  test("the package manifest, lockfile, and release guide all carry the current version — no stale prior-version declaration survives a bump", () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { version: string; packages: Record<string, { version?: string }> };
    expect(PKG_VERSION).not.toBe(PRIOR_RELEASE_VERSION);
    expect(lock.version).toBe(PKG_VERSION);
    expect(lock.packages[""]?.version).toBe(PKG_VERSION);
    // package.json's only "version": key is the package's own, so a stale prior string there is a
    // genuine half-bump.
    expect(readFileSync(PKG_PATH, "utf8")).not.toContain(`"version": "${PRIOR_RELEASE_VERSION}"`);
    // The lockfile's own declarations are its root and root-package version; a pinned devDependency
    // may legitimately carry the prior release's version string (oxlint tracks it), so assert the
    // OWN fields moved rather than scanning the whole file.
    expect(lock.version).not.toBe(PRIOR_RELEASE_VERSION);
    expect(lock.packages[""]?.version).not.toBe(PRIOR_RELEASE_VERSION);
    // the release guide's tag example must track the CURRENT version — a stale example walks an
    // operator into tagging the previous release (self-enforcing: every bump must refresh it)
    const releasing = readFileSync(RELEASING_PATH, "utf8");
    expect(releasing).toContain(`v${PKG_VERSION}`);
    expect(releasing).not.toContain(`v${PRIOR_RELEASE_VERSION}`);
  });

  test("the changelog entry names the signal-truth theme rather than generic filler", () => {
    const entry = readFileSync(CHANGELOG_PATH, "utf8").match(/## v1\.79[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
    expect(entry).toMatch(/signal[- ]truth/i);
    for (const change of ["tip-verify", "resolved-identity drift", "controlled time", "decision-event", "exact approve command", "line-anchored review feedback"]) {
      expect(entry.toLowerCase()).toContain(change.toLowerCase());
    }
  });

  test("the prior-release constant in the version parity test moved forward to the release before this one", () => {
    expect(PRIOR_RELEASE_VERSION).toBe("1.78.0");
    expect(PRIOR_RELEASE_VERSION).not.toBe(PKG_VERSION);
  });

  test.each(["version", "--version", "-v"] as const)("built CLI: %s prints version on stdout, exit 0", (cmd) => {
    const r = spawnCli([cmd]);
    assertCliSuccess(r, `version: ${cmd}`);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${PKG_VERSION}\n`);
  });
});

describe("skills harden — version preflight + verified handoffs", () => {
  for (const name of ["tickmarkr-loop", "tickmarkr-auto"] as const) {
    test(`${name}/SKILL.md mentions version preflight and send-text prohibition`, () => {
      const text = readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
      expect(text).toMatch(/version/i);
      expect(text).toMatch(/send-text/i);
      expect(text).toMatch(/stop immediately/i);
      expect(text).toMatch(/never proceed-and-hope/i);
      expect(text).toMatch(/herdr pane run/i);
      expect(text).toMatch(/herdr notification show/i);
    });
  }
});
