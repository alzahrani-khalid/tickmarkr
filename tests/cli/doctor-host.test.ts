import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Queue rows 196 and 197 (D-2102 add.1): doctor names the host seats run under and the locale every
// gate inherits. Every variable either row reads is stubbed per case, so no case reads the ambient
// environment of the shell (or agent session) that launched the suite.
const ENV_KEYS = [
  "HERDR_ENV", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE",
  "LC_ALL", "LC_CTYPE", "LANG",
] as const;
type Env = Partial<Record<(typeof ENV_KEYS)[number], string>>;

const DESKTOP: Env = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDECODE: "1" };
const HERDR: Env = { HERDR_ENV: "1" };
const ORCA: Env = { TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term-1" };
const UTF8: Env = { LANG: "en_US.UTF-8" };

const stub = (id: string) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) }) as unknown as WorkerAdapter;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("catalog fetch unavailable in test"); }));
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function doctorUnder(env: Env, llm?: "pane" | "headless"): Promise<string> {
  for (const key of ENV_KEYS) vi.stubEnv(key, env[key]);
  const repo = makeRepo({ "keep.txt": "x" });
  if (llm) {
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `visibility:\n  llm: ${llm}\n`);
  }
  return doctor(["--"], repo, [stub("fixture")], { banner: false, resolveOrcaBinary: () => undefined });
}

const rowsOf = (out: string, key: string): string[] =>
  out.split("\n").filter((line) => new RegExp(`^  [✓✗!] ${key}\\s`).test(line));

const HEADLESS = "seats run headless on the subprocess driver with no daemon board";
const PANES = "panes cannot be honored on this host";

test("doctor run from a parent environment holding the Claude Desktop entry point and neither herdr nor Orca markers names Claude Desktop in its host row and says seats run headless on the subprocess driver with no daemon board, a cli entry point or none gets that consequence without naming Claude Desktop, and herdr or Orca markers name that host instead, so a host row keyed on any Claude variable alone or blind to the host markers fails", async () => {
  const desktop = rowsOf(await doctorUnder({ ...DESKTOP, ...UTF8 }), "host");
  expect(desktop).toHaveLength(1);
  expect(desktop[0]).toContain("Claude Desktop");
  expect(desktop[0]).toContain(HEADLESS);

  // Claude variables without the exact Desktop entry point: the consequence, never the Desktop name.
  for (const env of [{ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1" }, { CLAUDECODE: "1" }, {}] as Env[]) {
    const host = rowsOf(await doctorUnder({ ...env, ...UTF8 }), "host");
    expect(host, JSON.stringify(env)).toHaveLength(1);
    expect(host[0], JSON.stringify(env)).toContain(HEADLESS);
    expect(host[0], JSON.stringify(env)).not.toContain("Claude Desktop");
  }

  // The host markers win over the Desktop entry point: that host is named, not the headless fallback.
  for (const [env, name] of [[HERDR, "herdr"], [ORCA, "Orca"]] as const) {
    const host = rowsOf(await doctorUnder({ ...DESKTOP, ...env, ...UTF8 }), "host");
    expect(host, name).toHaveLength(1);
    expect(host[0], name).toMatch(new RegExp(`^  ✓ host\\s+${name} — auto selects the ${name.toLowerCase()} driver$`));
    expect(host[0], name).not.toContain("Claude Desktop");
    expect(host[0], name).not.toContain(HEADLESS);
  }
});

test("with visibility llm set to pane, doctor warns that panes cannot be honored on this host for the Desktop and the bare rows and raises no such warning under herdr or Orca, and headless visibility raises it on no host, so a warning tied to the Desktop entry point alone or to the configured value alone fails", async () => {
  const hosts: [string, Env, boolean][] = [["Desktop", DESKTOP, true], ["bare", {}, true], ["herdr", HERDR, false], ["Orca", ORCA, false]];
  for (const [name, env, unhonored] of hosts) {
    const pane = await doctorUnder({ ...env, ...UTF8 }, "pane");
    const warned = pane.split("\n").filter((line) => line.includes(PANES));
    if (unhonored) {
      expect(warned, name).toHaveLength(1);
      expect(warned[0], name).toMatch(/^  ! visibility\s+visibility\.llm is pane, but panes cannot be honored on this host/);
    } else {
      expect(warned, name).toEqual([]);
    }
    const headless = await doctorUnder({ ...env, ...UTF8 }, "headless");
    expect(headless, `${name} headless`).not.toContain(PANES);
  }
});

test("doctor's locale row warns for no locale variable, for an empty one, for C, for POSIX and for the all-categories override set to C over a UTF-8 LANG, naming the C-locale fallback and the set-LANG fix, and passes naming the value for en_US.UTF-8, for ar_SA.UTF-8, for C.UTF-8 and for the character-type variable set over an unset LANG, so a row that reads LANG alone or ignores precedence fails", async () => {
  const warns: Env[] = [{}, { LANG: "" }, { LANG: "C" }, { LANG: "POSIX" }, { LC_ALL: "C", LANG: "en_US.UTF-8" }];
  for (const env of warns) {
    const locale = rowsOf(await doctorUnder(env), "locale");
    expect(locale, JSON.stringify(env)).toHaveLength(1);
    expect(locale[0], JSON.stringify(env)).toMatch(/^  ! locale\s/);
    expect(locale[0], JSON.stringify(env)).toContain("gates inherit the C-locale fallback (Node formats as en-US)");
    expect(locale[0], JSON.stringify(env)).toContain("set LANG in your shell profile");
  }
  const passes: [Env, string][] = [
    [{ LANG: "en_US.UTF-8" }, "LANG=en_US.UTF-8"],
    [{ LANG: "ar_SA.UTF-8" }, "LANG=ar_SA.UTF-8"],
    [{ LANG: "C.UTF-8" }, "LANG=C.UTF-8"],
    [{ LC_CTYPE: "ar_SA.UTF-8" }, "LC_CTYPE=ar_SA.UTF-8"],
  ];
  for (const [env, named] of passes) {
    const locale = rowsOf(await doctorUnder(env), "locale");
    expect(locale, named).toHaveLength(1);
    expect(locale[0], named).toMatch(new RegExp(`^  ✓ locale\\s+${named.replace(/\./g, "\\.")}$`));
  }
});
