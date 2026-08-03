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
const CONSUMER_SKILLS = ["skills/tickmarkr-loop/SKILL.md", "skills/tickmarkr-auto/SKILL.md"];
const OVERSEER_SKILLS = ["skills/tickmarkr-overseer/SKILL.md", "skills/tickmarkr-overseer/scripts/watch-panes.sh"];

// npm 11 prints `[{ files }]`; npm 12 prints `{ "<pkg>": { files } }`. Both reduce to one path list.
const packFiles = (json: string): string[] => {
  const parsed = JSON.parse(json) as unknown;
  const [pack] = (Array.isArray(parsed) ? parsed : Object.values(parsed as object)) as { files: { path: string }[] }[];
  return pack.files.map((file) => file.path);
};

const packedPaths = (): string[] => packFiles(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" }));

const asArrayShape = (paths: string[]) => JSON.stringify([{ files: paths.map((path) => ({ path })) }]);
const asObjectShape = (paths: string[]) => JSON.stringify({ tickmarkr: { files: paths.map((path) => ({ path })) } });

describe("package bins", () => {
  test("declares only tickmarkr and tkr", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("tickmarkr");
    expect(pkg.description).toBe("Spec in, verified work out.");
    expect(pkg.bin).toEqual(Object.fromEntries(BINS.map((name) => [name, "dist/cli/index.js"])));
  });

  test("packs consumer skills", () => {
    expect(packedPaths()).toEqual(expect.arrayContaining(CONSUMER_SKILLS));
  });

  test("the packaged distribution includes the overseer skill and its pane watcher script alongside the existing driving skills", () => {
    expect(packedPaths()).toEqual(expect.arrayContaining([...OVERSEER_SKILLS, ...CONSUMER_SKILLS]));
  });

  test("the pack assertion parses an npm 11 array fixture and an npm 12 object fixture to the same file list", () => {
    const paths = [...OVERSEER_SKILLS, ...CONSUMER_SKILLS];
    expect(packFiles(asArrayShape(paths))).toEqual(paths);
    expect(packFiles(asObjectShape(paths))).toEqual(packFiles(asArrayShape(paths)));
  });

  test("both package-bin tests pass under whichever npm the host resolves, proven by running them against the normalizer with each fixture shape", () => {
    const paths = [...OVERSEER_SKILLS, ...CONSUMER_SKILLS];
    for (const fixture of [asArrayShape(paths), asObjectShape(paths)]) {
      expect(packFiles(fixture)).toEqual(expect.arrayContaining(CONSUMER_SKILLS));
      expect(packFiles(fixture)).toEqual(expect.arrayContaining([...OVERSEER_SKILLS, ...CONSUMER_SKILLS]));
    }
    expect(packedPaths()).toEqual(expect.arrayContaining([...OVERSEER_SKILLS, ...CONSUMER_SKILLS]));
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
