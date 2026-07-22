import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

function strangerInstallThenTest(): { status: number | null; stderr: string; stdout: string } {
  const cloneDir = mkdtempSync(join(tmpdir(), "tickmarkr-build-provision-"));
  try {
    execSync(`git clone --local "${ROOT}" "${cloneDir}"`, { stdio: "pipe" });
    expect(existsSync(join(cloneDir, "dist"))).toBe(false);
    execSync("npm ci", { cwd: cloneDir, stdio: "pipe" });
    return spawnSync(
      "npm",
      ["test", "--", "tests/cli/version.test.ts", "-t", "built CLI:"],
      {
        cwd: cloneDir,
        encoding: "utf8",
        env: { ...process.env, npm_config_ignore_scripts: "false" },
      },
    );
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

describe("standalone test build provisioning", () => {
  test(
    "the standalone test command provisions a fresh build first so a stranger's install then test passes without a separate build step",
    () => {
      const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
      expect(pkg.scripts.pretest).toBe("npm run build");
      expect(pkg.scripts.test).toBe("vitest run");

      const r = strangerInstallThenTest();
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    },
    240_000, // OBS-116 load-margin reasoning: 2x headroom absorbs concurrent npm ci/build contention.
  );
});

test(
  "test: the provisioning test's nested full-suite invocation carries a timeout budget with at least double its prior headroom",
  () => {
    const source = readFileSync(join(REPO, "tests/repo/build-provisioning.test.ts"), "utf8");
    const start = source.indexOf('test(\n    "the standalone test command provisions a fresh build first');
    const end = source.indexOf("\n  );", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, end)).toContain("240_000");
  },
);
