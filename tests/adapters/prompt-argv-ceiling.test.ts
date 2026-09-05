import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { PROMPT_ARGV_CEILING_DEFAULT, PROMPT_ARGV_CEILING_LINUX, promptArgvCeiling, promptFitsArgv } from "../../src/adapters/types.js";

// OBS-930 (Linux) / OBS-931: the TUI launches inline the prompt as ONE argv string; Linux caps one at
// MAX_ARG_STRLEN = 131072 bytes (CI run 33979013874: `codex: Argument list too long` on 140 KB),
// darwin only the 1 MB total. The size rule at its boundary, with the platform stubbed both ways and
// nothing exec'd — E2BIG itself is not reproducible on this macOS, and never needs to be.

const REAL_PLATFORM = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  vi.unstubAllEnvs();
});

function fileOf(bytes: number): string {
  const p = join(mkdtempSync(join(tmpdir(), "tickmarkr-argv-ceiling-")), "prompt.md");
  writeFileSync(p, "x".repeat(bytes));
  return p;
}

describe("prompt argv ceiling (OBS-930 linux MAX_ARG_STRLEN)", () => {
  test("the ceiling is named by platform, never probed: linux 120000, every other platform 900000", () => {
    expect(PROMPT_ARGV_CEILING_LINUX).toBe(120_000);
    expect(PROMPT_ARGV_CEILING_DEFAULT).toBe(900_000);
    expect(promptArgvCeiling("linux")).toBe(120_000);
    for (const p of ["darwin", "freebsd", "win32", "openbsd"]) expect(promptArgvCeiling(p)).toBe(900_000);
    expect(promptArgvCeiling()).toBe(promptArgvCeiling(process.platform));
  });

  test("at the boundary exactly the ceiling fits and one byte over does not, on both platforms; 140 KB fits darwin not linux; an unreadable path is not proven oversized", () => {
    for (const platform of ["linux", "darwin"]) {
      const c = promptArgvCeiling(platform);
      expect(promptFitsArgv(fileOf(c), platform)).toBe(true);
      expect(promptFitsArgv(fileOf(c + 1), platform)).toBe(false);
    }
    const big = fileOf(140_000);
    expect(promptFitsArgv(big, "darwin")).toBe(true);
    expect(promptFitsArgv(big, "linux")).toBe(false);
    expect(promptFitsArgv(join(tmpdir(), "tickmarkr-argv-ceiling-missing", "prompt.md"), "linux")).toBe(true);
  });

  test("the codex and claude TUI launches read process.platform: a 140 KB prompt launches on darwin and returns null on linux while a 100 KB prompt launches on both", () => {
    vi.stubEnv("CODEX_HOME", "/var/empty/tickmarkr-hermetic-codex-home");
    const big = fileOf(140_000);
    const mid = fileOf(100_000);
    for (const ad of [codex, claudeCode]) {
      setPlatform("darwin");
      expect(ad.interactiveCommand(big, "m")).toContain(`"$(cat '${big}')"`);
      expect(ad.interactiveCommand(mid, "m")).toContain(`"$(cat '${mid}')"`);
      setPlatform("linux");
      expect(ad.interactiveCommand(big, "m")).toBeNull();
      expect(ad.interactiveCommand(mid, "m")).toContain(`"$(cat '${mid}')"`);
      // the headless form never inlines the prompt, so it is size-blind on every platform
      expect(ad.headlessCommand(big, "m")).toContain(`'${big}'`);
    }
  });
});
