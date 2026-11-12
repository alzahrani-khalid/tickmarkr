// Row 417; D-2187 add.77: the closed endpoint sources and the bounded connect, driven through the production module.
import dns from "node:dns";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { configuredEndpoints, downEndpoints, endpointLine, probeEndpoint, probeEndpoints, shownUrl, UNPARSEABLE_URL, WITHHELD_LINE, WITHHELD_URL } from "../../src/adapters/provider-endpoint.js";

const dirs: string[] = [];
const servers: Server[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "provider-endpoint-"));
  dirs.push(d);
  return d;
};
const codexConfig = (text: string) => {
  const p = join(tmp(), "config.toml");
  writeFileSync(p, text);
  return p;
};
const listening = async (): Promise<number> => {
  const server = createServer((s) => s.destroy());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
};
const closedPort = async (): Promise<number> => {
  const port = await listening();
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  return port;
};
const noClaude = { env: {}, settingsPath: join(tmpdir(), "no-such-settings-provider-endpoint.json") };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("row 417: configured provider endpoints", () => {
  test("the endpoint reader returns the codex provider base url and the claude base url and nothing for a built in provider or a missing config", () => {
    const named = codexConfig([
      'model = "gpt-6"',
      'model_provider = "cpa-gui" # routed',
      "",
      "[projects.\"/x\"]",
      'trust_level = "trusted"',
      "[model_providers.openai-alt]",
      'base_url = "http://127.0.0.1:1/v1"',
      "[model_providers.cpa-gui]",
      'name = "cpa"',
      'base_url = "http://127.0.0.1:8317/v1"',
      "[model_providers.cpa-gui.http_headers]",
      'base_url = "http://wrong.invalid"',
    ].join("\n"));
    const claudeEnv = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" };
    expect(configuredEndpoints({ env: claudeEnv, settingsPath: noClaude.settingsPath, codexConfigPath: named })).toEqual([
      { adapter: "claude-code", url: "http://127.0.0.1:9999" },
      { adapter: "codex", url: "http://127.0.0.1:8317/v1" },
    ]);
    // the Claude base URL from the settings file, exactly as doctor reads it
    const settings = join(tmp(), "settings.json");
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:7777" } }));
    expect(configuredEndpoints({ env: {}, settingsPath: settings, codexConfigPath: join(tmp(), "missing.toml") }))
      .toEqual([{ adapter: "claude-code", url: "http://127.0.0.1:7777" }]);
    // nothing: a built-in provider with no table, no model_provider, no base_url, a missing config
    for (const text of ['model_provider = "openai"\n', 'model = "gpt-6"\n[model_providers.x]\nbase_url = "http://a"\n', 'model_provider = "x"\n[model_providers.x]\nname = "x"\n']) {
      expect(configuredEndpoints({ ...noClaude, codexConfigPath: codexConfig(text) })).toEqual([]);
    }
    expect(configuredEndpoints({ ...noClaude, codexConfigPath: join(tmp(), "missing.toml") })).toEqual([]);
    // the production path: $CODEX_HOME/config.toml
    const home = tmp();
    writeFileSync(join(home, "config.toml"), 'model_provider = "p"\n[model_providers."p"]\nbase_url = \'http://127.0.0.1:2/\'\n');
    vi.stubEnv("CODEX_HOME", home);
    expect(configuredEndpoints(noClaude)).toEqual([{ adapter: "codex", url: "http://127.0.0.1:2/" }]);
    // under vitest with no CODEX_HOME the operator's ~/.codex is never read, and no default host is invented
    vi.stubEnv("CODEX_HOME", "");
    expect(configuredEndpoints(noClaude)).toEqual([]);
  });

  test("the probe connects without sending and names a closed port, an unparseable url and a listener", async () => {
    const received: number[] = [];
    const server = createServer((s) => {
      s.on("data", (b) => received.push(b.length));
      s.on("close", () => undefined);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await probeEndpoint(`http://user:pw@127.0.0.1:${port}/v1?k=1`)).toEqual({ listening: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
    const dead = await closedPort();
    expect(await probeEndpoint(`http://127.0.0.1:${dead}`)).toEqual({ listening: false, reason: "ECONNREFUSED" });
    for (const bad of ["not a url", "ftp://127.0.0.1/x", "http://"]) {
      expect(await probeEndpoint(bad), bad).toEqual({ listening: false, reason: "unparseable" });
    }
    const e = { adapter: "codex" as const, url: `http://user:pw@127.0.0.1:${dead}/v1?key=s#f` };
    expect(endpointLine(e, { listening: false, reason: "ECONNREFUSED" }))
      .toBe(`endpoint codex: http://127.0.0.1:${dead} down (ECONNREFUSED) — every codex seat will fail as transport until it answers`);
    expect(endpointLine(e, { listening: true })).toBe(`endpoint codex: http://127.0.0.1:${dead} listening`);
  });

  // Amendment B (D-2187 add.126): the closed reading of config.toml. Every cell goes through configuredEndpoints.
  test("the reader reads exactly the three closed statements and ignores every other statement unparsed", () => {
    const U = "http://127.0.0.1:8317/v1";
    const found: [string, string][] = [
      ["a datetime, numbers, an array and an inline table beside (a) to (c)", `model_provider="proxy"\nlast_updated=2026-11-11 01:02:03\nlist = [1, "x", { a = 2 }]\nother = { k = "v" }\n[model_providers.proxy]\nretries = 3.5e2\nwhen = 1979-05-27T07:32:00Z\nbase_url="${U}"\n`],
      ["spaced header", `model_provider = "proxy"\n[ model_providers . proxy ]\nbase_url = "${U}"\n`],
      ["quoted provider name", `model_provider = "my proxy"\n[model_providers."my proxy"]\nbase_url = "${U}"\n`],
      ["literal strings", `model_provider = 'proxy'\n[model_providers.'proxy']\nbase_url = '${U}' # c\n`],
      ["CRLF and a comment after the header", `model_provider = "proxy"\r\n[model_providers.proxy] # routed\r\nbase_url = "${U}"\r\n`],
      // review (row 417, add.126): a multi-line array's continuation rows `[1,2],` are not table headers
      ["a multi-line array before model_provider", `last_updated=2026-11-11 01:02:03\nlist=[\n [1,2],\n]\nother={k="v"}\nmodel_provider="proxy"\n[model_providers.proxy]\nbase_url="${U}"\n`],
      ["a multi-line array inside the provider table", `model_provider="proxy"\nlast_updated=2026-11-11 01:02:03\nother={k="v"}\n[model_providers.proxy]\nlist=[\n [1,2],\n]\nbase_url="${U}"\n`],
      ["a multi-line inline table and nested arrays with bracket strings", `model_provider="proxy"\n[model_providers.proxy]\nx = [\n  [\n    "]", { a = [1] },\n  ],\n  ["["],\n]\nbase_url="${U}"\n`],
      ["the named provider's table after another provider's", `model_provider = "proxy"\n[model_providers.other]\nbase_url = "http://127.0.0.1:1"\n[model_providers.proxy]\nbase_url = "${U}"\n`],
    ];
    for (const [name, text] of found) {
      expect(configuredEndpoints({ ...noClaude, codexConfigPath: codexConfig(text) }), name).toEqual([{ adapter: "codex", url: U }]);
    }
    const none: [string, string][] = [
      ["provider facts inside a multi-line basic string", `developer_instructions = """\nmodel_provider = "x"\n[model_providers.x]\nbase_url = "http://127.0.0.1:1"\n"""\n`],
      ["provider facts inside a multi-line literal string", `notes = '''\nmodel_provider = "x"\n[model_providers.x]\nbase_url = "http://127.0.0.1:1"\n'''\n`],
      ["model_provider inside a string", `notes = "model_provider = 'proxy'"\n[model_providers.proxy]\nbase_url = "${U}"\n`],
      ["quoted keys", `"model_provider" = "proxy"\n[model_providers.proxy]\n"base_url" = "${U}"\n`],
      ["dotted key", `model_provider = "proxy"\nmodel_providers.proxy.base_url = "${U}"\n`],
      ["inline table", `model_provider = "proxy"\nmodel_providers = { proxy = { base_url = "${U}" } }\n`],
      ["multi-line string as the base_url value", `model_provider = "proxy"\n[model_providers.proxy]\nbase_url = """${U}"""\n`],
      ["model_provider after the first header", `[model_providers.proxy]\nbase_url = "${U}"\n[x]\nmodel_provider = "proxy"\n`],
      ["array of tables", `model_provider = "proxy"\n[[model_providers.proxy]]\nbase_url = "${U}"\n`],
      ["subtable base_url", `model_provider = "proxy"\n[model_providers.proxy.http_headers]\nbase_url = "${U}"\n`],
      ["malformed header", `model_provider = "proxy"\n[model_providers.proxy\nbase_url = "${U}"\n`],
      ["base_url inside a multi-line array is not a statement", `model_provider = "proxy"\n[model_providers.proxy]\nx = [\nbase_url = "${U}"\n]\n`],
      ["file ends inside a string", `model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "${U}"\nnotes = """open\n`],
      // review (row 417): a single-line string whose quote never closes is a file ending inside a string, LF or CRLF
      ...["\n", "\r\n"].flatMap((eol): [string, string][] => [
        [`unclosed basic string ${JSON.stringify(eol)}`, `model_provider = "proxy"${eol}[model_providers.proxy]${eol}base_url = "${U}"${eol}notes = "unclosed${eol}`],
        [`unclosed literal string ${JSON.stringify(eol)}`, `model_provider = "proxy"${eol}[model_providers.proxy]${eol}base_url = "${U}"${eol}notes = 'unclosed${eol}`],
      ]),
    ];
    for (const [name, text] of none) {
      expect(configuredEndpoints({ ...noClaude, codexConfigPath: codexConfig(text) }), name).toEqual([]);
    }
  });

  // Amendment B: the shown URL is built only from parsed parts; anything else is the fixed placeholder.
  test("the shown url is scheme host and port only and an unparseable value shows a fixed placeholder", async () => {
    const dead = await closedPort();
    const withSecret = `http://user:s3cret@127.0.0.1:${dead}/v1?key=tok3n#frag`;
    const down = await downEndpoints({ ...noClaude, codexConfigPath: codexConfig(`model_provider = "p"\n[model_providers.p]\nbase_url = "${withSecret}"\n`) });
    expect(down).toEqual([{ adapter: "codex", url: `http://127.0.0.1:${dead}`, reason: "ECONNREFUSED", line: `endpoint codex: http://127.0.0.1:${dead} down (ECONNREFUSED) — every codex seat will fail as transport until it answers` }]);
    const line = `endpoint codex: ${UNPARSEABLE_URL} down (unparseable) — every codex seat will fail as transport until it answers`;
    for (const bad of ["user:s3cret@127.0.0.1:8317/v1?key=tok3n#frag", "http://user:s3cret@127.0.0.1:abc/v1?key=tok3n", "ftp://user:s3cret@127.0.0.1/", "not a url s3cret"]) {
      const d = await downEndpoints({ ...noClaude, codexConfigPath: codexConfig(`model_provider = "p"\n[model_providers.p]\nbase_url = '${bad}'\n`) });
      expect(d, bad).toEqual([{ adapter: "codex", url: UNPARSEABLE_URL, reason: "unparseable", line }]);
      for (const leak of ["s3cret", "tok3n", "user", "frag"]) expect(JSON.stringify(d), leak).not.toContain(leak);
    }
    expect(shownUrl("https://h.example:8443/x")).toBe("https://h.example:8443");
    expect(shownUrl("https://h.example/x")).toBe("https://h.example");
  });

  // Amendment B: ONE 2 000 ms deadline covering resolution and connect. Injected: a 1 500 ms resolver and a connect
  // that never answers; a socket timeout restarted after resolution would end at about 3 500 ms.
  test("a slow resolution followed by a pending connect times out at the one deadline", async () => {
    const tcp = (process as unknown as { binding(n: string): { TCP: { prototype: { connect(): number } } } }).binding("tcp_wrap").TCP;
    const nativeConnect = tcp.prototype.connect;
    const lookup = dns.lookup;
    try {
      (dns as { lookup: unknown }).lookup = (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        setTimeout(() => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)), 1_500);
      tcp.prototype.connect = () => 0;
      const started = performance.now();
      expect(await probeEndpoint("http://endpoint.test:8317")).toEqual({ listening: false, reason: "timeout" });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(2_500);
    } finally {
      (dns as { lookup: unknown }).lookup = lookup;
      tcp.prototype.connect = nativeConnect;
    }
  }, 10_000);
});

// Amendment C (D-2187 add.128): the remaining rows of the table, through the production seam.
describe("row 417 amendment C", () => {
  test("a host resolving to a refusing address and then a listening one is reported listening", async () => {
    const port = await listening(); // 127.0.0.1 only: ::1 on the same port refuses (or is unreachable)
    const lookup = dns.lookup;
    try {
      (dns as { lookup: unknown }).lookup = (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        queueMicrotask(() => (o.all
          ? cb(null, [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }])
          : cb(null, "::1", 6)));
      // bait: one attempt on the first address (address selection disabled) reports this listener as down
      expect(await probeEndpoint(`http://endpoint.test:${port}`)).toEqual({ listening: true });
    } finally {
      (dns as { lookup: unknown }).lookup = lookup;
    }
  });

  test("the two default port urls show no port beside a url with another port", async () => {
    const shown = async (url: string) =>
      (await downEndpoints({ ...noClaude, codexConfigPath: codexConfig(`model_provider = "p"\n[model_providers.p]\nbase_url = "${url}"\n`) }))[0]?.url;
    // bait: a port read from the raw text would show :80 and :443
    expect(shownUrl("http://example.test:80/v1")).toBe("http://example.test");
    expect(shownUrl("https://example.test:443/v1")).toBe("https://example.test");
    expect(shownUrl("http://example.test:8080/v1")).toBe("http://example.test:8080");
    const dead = await closedPort();
    expect(await shown(`http://127.0.0.1:${dead}/v1`)).toBe(`http://127.0.0.1:${dead}`);
    expect(endpointLine({ adapter: "codex", url: "https://example.test:443/v1" }, { listening: false, reason: "ECONNREFUSED" }))
      .toBe("endpoint codex: https://example.test down (ECONNREFUSED) — every codex seat will fail as transport until it answers");
  });
});

// Row 435; D-2187 add.130: the Claude endpoint's shown text passes the gateway's own sink predicate before it is probed
// or shown. A resolver that answers 127.0.0.1 for every name stands in for DNS: a leak would resolve and connect.
describe("row 435: the endpoint line and the gateway credential", () => {
  const credential = "sk-tkr-SECRET-0435";
  const resolveAll = (calls: string[]) => vi.spyOn(dns, "lookup").mockImplementation(((h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    calls.push(h);
    queueMicrotask(() => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)));
  }) as never);
  const counted = async (): Promise<{ port: number; connections: () => number }> => {
    let n = 0;
    const server = createServer((s) => { n++; s.destroy(); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as { port: number }).port, connections: () => n };
  };
  const forms = (t: string) => [t, t.toLowerCase(), decodeURIComponent(t).normalize("NFKC").toLowerCase()];

  test("a base url whose host carries the gateway credential prints the withheld endpoint line and is never connected", async () => {
    const { port, connections } = await counted();
    const calls: string[] = [];
    resolveAll(calls);
    const settings = join(tmp(), "settings.json");
    const hosts = [credential, credential.toUpperCase(), `%73${credential.slice(1)}`]; // as is, upper-cased, percent-encoded
    const seams = hosts.map((h) => ({ env: { ANTHROPIC_BASE_URL: `http://${h}.invalid:${port}/v1`, ANTHROPIC_AUTH_TOKEN: credential }, settingsPath: noClaude.settingsPath }));
    // the settings source: the credential read from the same place the URL came from
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://${credential}.invalid:${port}`, ANTHROPIC_API_KEY: credential } }));
    seams.push({ env: {} as never, settingsPath: settings });
    for (const seam of seams) {
      const probed = await probeEndpoints(seam);
      expect(probed.map((p) => [p.probe, p.line])).toEqual([[{ listening: false, reason: "withheld" }, WITHHELD_LINE]]);
      const down = await downEndpoints(seam);
      expect(down).toEqual([{ adapter: "claude-code", url: WITHHELD_URL, reason: "withheld", line: WITHHELD_LINE }]);
      expect(WITHHELD_LINE).toBe("endpoint claude-code: withheld — the base URL carries the gateway credential: not probed");
      expect(WITHHELD_URL).toBe("<withheld base url>");
      const shown = JSON.stringify([probed.map((p) => [p.line, p.shown]), down]);
      for (const f of forms(credential)) expect(shown.toLowerCase()).not.toContain(f.toLowerCase());
    }
    // no name resolution and no connect were made
    expect(calls).toEqual([]);
    expect(connections()).toBe(0);
  });

  test("a credential in userinfo path query or fragment and a clean base url keep the endpoint line unchanged", async () => {
    const { port } = await counted();
    const calls: string[] = [];
    resolveAll(calls);
    const live = `http://127.0.0.1:${port}`;
    const listeningLine = `endpoint claude-code: ${live} listening`;
    const cells: { cell: string; env: NodeJS.ProcessEnv; codex?: string; lines: string[] }[] = [
      { cell: "userinfo", env: { ANTHROPIC_BASE_URL: `http://user:${credential}@127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: credential }, lines: [listeningLine] },
      { cell: "path", env: { ANTHROPIC_BASE_URL: `${live}/${credential}/v1`, ANTHROPIC_AUTH_TOKEN: credential }, lines: [listeningLine] },
      { cell: "query", env: { ANTHROPIC_BASE_URL: `${live}/v1?key=${credential}`, ANTHROPIC_AUTH_TOKEN: credential }, lines: [listeningLine] },
      { cell: "fragment", env: { ANTHROPIC_BASE_URL: `${live}/#${credential}`, ANTHROPIC_AUTH_TOKEN: credential }, lines: [listeningLine] },
      { cell: "a clean base url with a credential known", env: { ANTHROPIC_BASE_URL: `${live}/v1`, ANTHROPIC_API_KEY: credential }, lines: [listeningLine] },
      // no credential known: a host that looks like a key is shown, resolved and connected as at the endpoint task
      { cell: "no credential known", env: { ANTHROPIC_BASE_URL: `http://${credential}.invalid:${port}` },
        lines: [`endpoint claude-code: http://${credential.toLowerCase()}.invalid:${port} listening`] },
      // codex endpoints carry no credential tickmarkr knows: unchanged even when the Claude credential is in its host
      { cell: "codex", env: { ANTHROPIC_AUTH_TOKEN: credential }, codex: `http://${credential}.invalid:${port}/v1`,
        lines: [`endpoint codex: http://${credential.toLowerCase()}.invalid:${port} listening`] },
    ];
    for (const c of cells) {
      const codexConfigPath = c.codex ? codexConfig(`model_provider = "p"\n[model_providers.p]\nbase_url = "${c.codex}"\n`) : join(tmp(), "none.toml");
      const probed = await probeEndpoints({ env: c.env, settingsPath: noClaude.settingsPath, codexConfigPath });
      expect(probed.map((p) => p.line), c.cell).toEqual(c.lines);
      expect(probed.map((p) => p.line).join("\n"), c.cell).not.toContain("withheld");
    }
    expect(calls.length).toBe(2); // the two name hosts, each resolved once
    // a down endpoint keeps its shown url and reason
    const dead = await closedPort();
    expect(await downEndpoints({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${dead}/${credential}`, ANTHROPIC_AUTH_TOKEN: credential }, settingsPath: noClaude.settingsPath }))
      .toEqual([{ adapter: "claude-code", url: `http://127.0.0.1:${dead}`, reason: "ECONNREFUSED", line: endpointLine({ adapter: "claude-code", url: `http://127.0.0.1:${dead}` }, { listening: false, reason: "ECONNREFUSED" }) }]);
  });
});
