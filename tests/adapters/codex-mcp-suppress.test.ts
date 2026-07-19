import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { codex, codexConfigMcpServerNames, codexMcpSuppressionFlags } from "../../src/adapters/codex.js";
import { shq } from "../../src/adapters/types.js";

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
    expect(codex.interactiveCommand("/p", "gpt-5.2")).toContain("--disable plugins");
  });

  test("a missing codex config yields the base suppression flags without error", () => {
    codexHome(undefined); // CODEX_HOME exists, config.toml does not (fresh install)
    expect(codexConfigMcpServerNames()).toEqual([]);
    const flags = codexMcpSuppressionFlags();
    expect(flags).toBe(`--disable plugins -c 'mcp_servers={}'`);
    expect(codex.headlessCommand("/p", "gpt-5.2")).toContain(flags);
  });

  test("headless and interactive codex commands carry identical mcp suppression flags", () => {
    codexHome(FIXTURE);
    const flags = codexMcpSuppressionFlags();
    // the whole flag run appears contiguously in BOTH production worker modes
    expect(flags).toContain("--disable plugins");
    expect(codex.headlessCommand("/p", "gpt-5.2")).toContain(flags);
    expect(codex.interactiveCommand("/p", "gpt-5.2") as string).toContain(flags);
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
