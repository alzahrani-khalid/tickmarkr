import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { version } from "../../src/cli/commands/version.js";
import { dispatch, USAGE } from "../../src/cli/index.js";
import { spawnCli, assertCliSuccess } from "../helpers/built-cli.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = join(ROOT, "dist/cli/index.js");
const PKG_PATH = join(ROOT, "package.json");
const LOCK_PATH = join(ROOT, "package-lock.json");
const PKG_VERSION = JSON.parse(readFileSync(PKG_PATH, "utf8")).version as string;
const PRIOR_RELEASE_VERSION = "1.73.0";
const RELEASING_PATH = join(ROOT, "RELEASING.md");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");

// A fresh worktree has no dist/, and `ignore-scripts=true` npm config skips the pretest build,
// so build on demand when this file runs outside the full suite (where bin.test.ts rebuilds).
// OBS-96-safe: this file is inside the serialized dist-coupled fork, so nothing races the emit.
// execFileSync, not spawnSync: the shared-helper hygiene guard pins raw spawnSync in this file,
// and this is a build step, not a built-CLI assertion.
beforeAll(() => {
  if (existsSync(ENTRY)) return;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
}, 180_000);

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
    for (const path of [PKG_PATH, LOCK_PATH] as const) {
      expect(readFileSync(path, "utf8")).not.toContain(`"version": "${PRIOR_RELEASE_VERSION}"`);
    }
    // the release guide's tag example must track the CURRENT version — a stale example walks an
    // operator into tagging the previous release (self-enforcing: every bump must refresh it)
    const releasing = readFileSync(RELEASING_PATH, "utf8");
    expect(releasing).toContain(`v${PKG_VERSION}`);
    expect(releasing).not.toContain(`v${PRIOR_RELEASE_VERSION}`);
  });

  test("the changelog entry names the harness-truth theme rather than generic filler", () => {
    const entry = readFileSync(CHANGELOG_PATH, "utf8").match(/## v1\.74[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
    expect(entry).toMatch(/harness[- ]truth/i);
    for (const change of ["graph-rehash", "resume --graph-changed", "not comparable", "prior-graph", "channel attribution", "empty circles", "second run", "live engagement", "fail closed", "diff cap", "file-level facts", "anti-flooding", "clear-guard", "consecutive-stable", "settle-retry", "adapter fingerprints", "fixed sleeps", "already-stable", "redacted", "redaction seam", "journal weight", "telemetry", "judge rows"]) {
      expect(entry.toLowerCase()).toContain(change.toLowerCase());
    }
  });

  test("the prior-release constant in the version parity test moved forward to the release before this one", () => {
    expect(PRIOR_RELEASE_VERSION).toBe("1.73.0");
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
