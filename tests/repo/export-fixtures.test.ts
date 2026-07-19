import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Compiler tests read repo-root fixtures/; export-public must retain them. Run against a pristine
// temp clone so the script's dirty-tree guard never blocks npm test in a dirty dev checkout.
// Skipped inside the exported tree itself (export-public.sh is not part of the public snapshot).
const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");

const EXPORT_FIXTURES = [
  "fixtures/sample.prd.md",
  "fixtures/sample-pin.prd.md",
  "fixtures/sample.native.md",
  "fixtures/speckit-sample/tasks.md",
  "fixtures/gsd-sample/07-live-check/07-01-PLAN.md",
  "fixtures/gsd-sample/07-live-check/07-02-PLAN.md",
  "fixtures/gsd-sample/07-live-check/07-03-PLAN.md",
  "fixtures/gsd-sample/07-live-check/07-03-SUMMARY.md",
];

function exportFromCleanClone(): string {
  const cloneDir = mkdtempSync(join(tmpdir(), "tickmarkr-export-fixtures-"));
  try {
    execSync(`git clone --local "${ROOT}" "${cloneDir}"`, { stdio: "pipe" });
    const out = execSync("bash scripts/export-public.sh", { cwd: cloneDir, encoding: "utf8" });
    const match = out.match(/^export path: (.+)$/m);
    if (!match) throw new Error(`export path not found in:\n${out}`);
    return match[1].trim();
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

describe("export-public retains compiler fixtures", () => {
  test("export output contains the fixture files retained compiler tests read", { skip: !existsSync(EXPORT_SCRIPT) }, () => {
    const exportDir = exportFromCleanClone();
    try {
      for (const rel of EXPORT_FIXTURES) {
        expect(existsSync(join(exportDir, rel)), rel).toBe(true);
      }
    } finally {
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
