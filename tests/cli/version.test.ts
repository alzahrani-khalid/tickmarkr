import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { version } from "../../src/cli/commands/version.js";
import { dispatch, USAGE } from "../../src/cli/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = join(ROOT, "dist/cli/index.js");
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

describe("tickmarkr version", () => {
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

  test.each(["version", "--version", "-v"] as const)("built CLI: %s prints version on stdout, exit 0", (cmd) => {
    const r = spawnSync(process.execPath, [ENTRY, cmd], { encoding: "utf8" });
    expect(r.status).toBe(0);
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
