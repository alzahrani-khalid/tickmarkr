import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = join(ROOT, "dist/cli/index.js");
const BINS = ["tickmarkr", "tkr"];
const retiredBanner = `${["dro", "vr"].join("")} —`;

describe("package bins", () => {
  test("declares only tickmarkr and tkr", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("tickmarkr");
    expect(pkg.description).toBe("Spec in, verified work out.");
    expect(pkg.bin).toEqual(Object.fromEntries(BINS.map((name) => [name, "dist/cli/index.js"])));
  });

  test("packs consumer skills", () => {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" })) as [{ files: { path: string }[] }];
    expect(pack.files.map((file) => file.path)).toEqual(expect.arrayContaining(["skills/tickmarkr-loop/SKILL.md", "skills/tickmarkr-auto/SKILL.md"]));
  });

  test("the packaged distribution includes the overseer skill and its pane watcher script alongside the existing driving skills", () => {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" })) as [{ files: { path: string }[] }];
    expect(pack.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "skills/tickmarkr-overseer/SKILL.md",
      "skills/tickmarkr-overseer/scripts/watch-panes.sh",
      "skills/tickmarkr-loop/SKILL.md",
      "skills/tickmarkr-auto/SKILL.md",
    ]));
  });

  test("the built CLI responds identically through every bin symlink", () => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe" });
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-bin-"));
    try {
      const outputs = BINS.map((name) => {
        const bin = join(dir, name);
        symlinkSync(ENTRY, bin);
        const result = spawnSync(process.execPath, [bin], { cwd: dir, encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        return result.stdout;
      });
      expect(outputs).toEqual([outputs[0], outputs[0]]);
      expect(outputs[0]).toContain("usage: tickmarkr");
      expect(outputs[0]).not.toContain(retiredBanner);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
