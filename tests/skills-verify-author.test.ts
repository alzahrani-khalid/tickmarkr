import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BULLET = "   - `tickmarkr verify --base <ref>` — run the gate battery standalone against merge-base(base, HEAD)..HEAD: no daemon, no retries, one fail-closed verdict (`--criteria <file>` or `--task <id>` adds the semantic gates; `--no-review` for deterministic-only)";
const AUTHOR_ADVICE = "; pass `--author <adapter:model of the agent that wrote it>` whenever an agent wrote the diff";
const LANE_COMMAND = "   `tickmarkr verify --base <ref> --criteria <file> --author <adapter:model of the agent that wrote it>` is the standalone form of the engine's own gates —";

test("test: the loop and auto skills' verify bullets and the overseer's lane-gating command each tell the reader to pass the author flag naming the agent that wrote the diff, read through the installed skill copies too, so a shipped verify line without the author fails", () => {
  const installedRoot = join(ROOT, ".claude/skills");
  for (const name of ["loop", "auto", "overseer"]) {
    const canonical = join(ROOT, "skills", `tickmarkr-${name}`, "SKILL.md");
    const paths = [canonical];
    // Installed copies are absent from the exported tree; skip their checks when absent.
    if (existsSync(installedRoot)) {
      const installed = join(installedRoot, `tickmarkr-${name}`, "SKILL.md");
      expect(lstatSync(installed).isSymbolicLink(), installed).toBe(true);
      expect(realpathSync(installed)).toBe(realpathSync(canonical));
      expect(readFileSync(installed)).toEqual(readFileSync(canonical));
      paths.push(installed);
    }
    for (const path of paths) {
      const lines = readFileSync(path, "utf8").split("\n");
      if (name === "overseer") {
        const item = lines.findIndex((line) => line.startsWith("4. **Gate every exec lane"));
        expect(item, path).toBeGreaterThan(-1);
        expect(lines[item + 1], path).toBe(LANE_COMMAND);
      } else {
        expect(lines.filter((line) => line.startsWith("   - `tickmarkr verify --base <ref>`")), path)
          .toEqual([BULLET + AUTHOR_ADVICE]);
      }
    }
  }
});
