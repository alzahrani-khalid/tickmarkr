import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { codex, codexConfigMcpServerNames, codexMcpSuppressionFlags } from "../../src/adapters/codex.js";
import { promptArgvCeiling, shq } from "../../src/adapters/types.js";

// v1.57 T1 / OBS-82: codex ≥0.144 merges -c 'mcp_servers={}' with config instead of replacing it,
// so the OBS-24 override became a no-op and a down operator-global MCP server wedges startup.
// These tests pin the repaired flag set hermetically: fixture config.toml under CODEX_HOME,
// no real CLI spawned (zero-token law).

let ORIG_CODEX_HOME: string | undefined;

beforeEach(() => {
  ORIG_CODEX_HOME = process.env.CODEX_HOME;
});

afterEach(() => {
  if (ORIG_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIG_CODEX_HOME;
});

// Mirrors the real operator config shape: bare keys, dashed keys, sub-tables ([x.env]), and a
// quoted key. Values are irrelevant to the header scan.
const FIXTURE = `
[projects."/x"]
trust_level = "trusted"

[mcp_servers.context7]
command = "npx"

[mcp_servers.context7.env]
KEY = "v"

[mcp_servers.codebase-retrieval]
command = "auggie"

[mcp_servers.node_repl]
command = "node_repl"

[mcp_servers."weird name"]
command = "w"
`;

function codexHome(configText?: string): string {
  const home = mkdtempSync(join(tmpdir(), "tickmarkr-codex-home-"));
  mkdirSync(home, { recursive: true });
  if (configText !== undefined) writeFileSync(join(home, "config.toml"), configText);
  process.env.CODEX_HOME = home;
  return home;
}

describe("codex mcp suppression (OBS-82)", () => {
  test("every mcp server named in a fixture codex config is disabled in the built worker command", () => {
    codexHome(FIXTURE);
    const cmd = codex.headlessCommand("/p", "gpt-5.2");
    expect(cmd).toContain(`-c 'mcp_servers.context7.enabled=false'`);
    expect(cmd).toContain(`-c 'mcp_servers.codebase-retrieval.enabled=false'`);
    expect(cmd).toContain(`-c 'mcp_servers.node_repl.enabled=false'`);
    // quoted TOML keys re-serialize as quoted keys in the override path
    expect(cmd).toContain(`-c 'mcp_servers."weird name".enabled=false'`);
    // sub-tables dedupe to their server: [mcp_servers.context7.env] is NOT a server named env
    expect(cmd).not.toContain("env.enabled=false");
    expect(codexConfigMcpServerNames()).toEqual(["context7", "codebase-retrieval", "node_repl", "weird name"]);
  });

  test("the built worker command disables plugin loading", () => {
    // plugin-bundled servers (codex-security, sites-design-picker — the OBS-82 spinner) live in
    // ~/.codex/plugins/cache, never under [mcp_servers.*]; only --disable plugins reaches them
    codexHome(FIXTURE);
    expect(codex.headlessCommand("/p", "gpt-5.2")).toContain("--disable plugins");
  });

  test("a missing codex config yields the base suppression flags without error", () => {
    codexHome(undefined); // CODEX_HOME exists, config.toml does not (fresh install)
    expect(codexConfigMcpServerNames()).toEqual([]);
    const flags = codexMcpSuppressionFlags();
    expect(flags).toBe(`--disable plugins -c 'mcp_servers={}'`);
    expect(codex.headlessCommand("/p", "gpt-5.2")).toContain(flags);
  });

  // OBS-930: the visible pane runs the real TUI. Codex's TUI takes the prompt only as the [PROMPT]
  // positional, so the launch inlines the file like the claude adapter — LAST, after every flag.
  test("test: the codex interactive command launches the TUI with the same sandbox hook-trust and mcp suppression as the headless form and the prompt file's content as the last positional whereas its first four argv tokens carry no suite word", () => {
    codexHome(FIXTURE);
    const flags = codexMcpSuppressionFlags();
    expect(flags).toContain("--disable plugins");
    expect(codex.headlessCommand("/p", "gpt-5.2")).toContain(flags);
    const cmd = codex.interactiveCommand("/p", "gpt-5.2");
    expect(cmd).not.toBeNull();
    expect(cmd!.startsWith("codex -a never -s workspace-write --dangerously-bypass-hook-trust ")).toBe(true);
    expect(cmd).toContain(flags);
    expect(cmd).not.toContain(" exec ");
    expect(cmd!.endsWith(` --model 'gpt-5.2' "$(cat '/p')"`)).toBe(true);
    // OBS-889: the census reads the first four tokens only — and those must never name a runner
    expect(cmd!.split(/\s+/, 4).join(" ")).toBe("codex -a never -s");
  });

  test("test: the codex headless command run against a stub codex on PATH carries no prompt bytes in argv so the result nonce appears in no argument while the prompt reaches the process and the interactive form passes the prompt as the last argument with the model value followed by it and a 140 KB prompt fits on darwin whereas on linux the builder returns null for it and a 100 KB prompt fits whereas a form that inlines the prompt file's content into the headless check fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-codex-argv-"));
    const promptFile = join(dir, "prompt.md");
    const argvLog = join(dir, "argv.log");
    const stdinLog = join(dir, "stdin.log");
    const nonce = "RESULT_NONCE_codex_argv_secret";
    const prompt = `worker prompt\n${nonce}\n`;
    writeFileSync(promptFile, prompt);
    writeFileSync(join(dir, "codex"), `#!/bin/sh
printf '%s\\n' "$@" > "$CODEX_ARGV_LOG"
cat > "$CODEX_STDIN_LOG"
`);
    chmodSync(join(dir, "codex"), 0o755);
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CODEX_ARGV_LOG: argvLog,
      CODEX_STDIN_LOG: stdinLog,
    };
    const assertPromptOffArgv = (command: string) => {
      execSync(command, { env });
      expect(readFileSync(argvLog, "utf8")).not.toContain(nonce);
      expect(readFileSync(stdinLog, "utf8")).toBe(prompt);
    };

    assertPromptOffArgv(codex.headlessCommand(promptFile, "gpt-5.2"));
    expect(() => assertPromptOffArgv(`codex ${shq(prompt)}`)).toThrow();

    // OBS-930: the TUI form carries the prompt BY DESIGN — as the last positional, never as a flag
    // value ("$(cat …)" strips the trailing newline; codex sees the same text a paste would give it).
    const argvOf = (command: string) => {
      execSync(command, { env });
      return readFileSync(argvLog, "utf8").split("\n");
    };
    const argv = argvOf(codex.interactiveCommand(promptFile, "gpt-5.2")!);
    const promptLines = prompt.replace(/\n$/, "").split("\n");
    expect(argv.slice(-(promptLines.length + 3))).toEqual(["--model", "gpt-5.2", ...promptLines, ""]);
    expect(argv.slice(0, 4)).toEqual(["-a", "never", "-s", "workspace-write"]);
    expect(argv.indexOf("exec")).toBe(-1);
    // a real worker prompt is ~140 KB (OBS-889 measured 149,417 bytes of argv). darwin enforces only
    // the 1 MB total ARG_MAX, so the 140 KB positional execs there and proves the size; linux caps
    // ONE argv string at 131072 bytes (CI run 33979013874: `codex: Argument list too long`), so there
    // the builder refuses the TUI launch (null → headless fallback) and a ~100 KB prompt still execs.
    const big = `${"lorem ipsum vitest npm test ".repeat(5000)}${nonce}\n`;
    writeFileSync(promptFile, big);
    expect(big.length).toBeGreaterThan(140_000);
    if (process.platform === "linux") {
      expect(big.length).toBeGreaterThan(promptArgvCeiling("linux"));
      expect(codex.interactiveCommand(promptFile, "gpt-5.2")).toBeNull();
      const mid = `${"lorem ipsum vitest npm test ".repeat(3570)}${nonce}\n`;
      writeFileSync(promptFile, mid);
      expect(mid.length).toBeGreaterThan(99_000);
      expect(mid.length).toBeLessThan(promptArgvCeiling("linux"));
      const midArgv = argvOf(codex.interactiveCommand(promptFile, "gpt-5.2")!);
      expect(midArgv[midArgv.length - 2]).toBe(mid.replace(/\n$/, ""));
      expect(midArgv[midArgv.length - 2]!.endsWith(nonce)).toBe(true);
    } else {
      const bigArgv = argvOf(codex.interactiveCommand(promptFile, "gpt-5.2")!);
      expect(bigArgv[bigArgv.length - 2]).toBe(big.replace(/\n$/, ""));
    }
  });

  test("config-scanned server names reach the shell line only through shq", () => {
    // adversarial name: single quote + shell metachars — shq must neutralize it
    codexHome(`[mcp_servers."o'brien; rm -rf"]\ncommand = "x"\n`);
    const flags = codexMcpSuppressionFlags();
    expect(flags).toContain(`-c ${shq(`mcp_servers."o'brien; rm -rf".enabled=false`)}`);
    // the raw unquoted name never appears outside the shq-wrapped argument
    expect(flags.split(`-c ${shq(`mcp_servers."o'brien; rm -rf".enabled=false`)}`).join("")).not.toContain("o'brien");
  });
});
