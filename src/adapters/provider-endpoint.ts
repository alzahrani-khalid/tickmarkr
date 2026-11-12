// Queue row 417; D-2187 add.77: each adapter's CONFIGURED provider endpoint, probed by one bounded TCP connect.
// Closed sources: claude-code's base URL exactly as doctor reads it (claudeBaseUrl), and codex's top-level
// `model_provider` in $CODEX_HOME/config.toml with that provider table's `base_url`. Nothing else, and never a
// default host: no configured URL means no endpoint and no probe. The probe connects and sends nothing.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeBaseUrl } from "./claude-code.js";
import { containLines, gatewayCredential } from "./cliproxy.js";

export type ProviderEndpoint = { adapter: "claude-code" | "codex"; url: string };
export type EndpointProbe = { listening: true } | { listening: false; reason: string };
export type EndpointDown = ProviderEndpoint & { reason: string; line: string };
export type EndpointSeam = { env?: NodeJS.ProcessEnv; settingsPath?: string; codexConfigPath?: string };

export const ENDPOINT_PROBE_TIMEOUT_MS = 2_000;

/** The codex config path: $CODEX_HOME/config.toml, else ~/.codex/config.toml. Under vitest with no CODEX_HOME the
 *  operator's own config is never read (the same seal claudeBaseUrl applies to its implicit inputs). */
function codexConfigPath(): string | undefined {
  if (process.env.CODEX_HOME) return join(process.env.CODEX_HOME, "config.toml");
  return process.env.VITEST ? undefined : join(homedir(), ".codex", "config.toml");
}

// Reading config.toml (closed; D-2187 add.126). No TOML library and no validation: the file is lexed for strings and
// comments only, and outside them exactly three one-line statements are read — (a) top-level `model_provider = "<s>"`,
// (b) the header `[model_providers.<bare or quoted name>]`, (c) `base_url = "<s>"` inside that table. Every other
// statement is ignored unparsed, so no other value can make the file unreadable; a fact in any other form (quoted or
// dotted key, inline table, multi-line string value) is not read. A file that ends inside a string reads as nothing.
// Continuation rows of a multi-line array or inline table belong to their statement: never a header, never read.
const STR = "\u0000(\\d+)\u0001"; // a single-line string token in a logical line
const MODEL_PROVIDER = new RegExp(`^[ \\t]*model_provider[ \\t]*=[ \\t]*${STR}[ \\t]*$`);
const PROVIDER_HEADER = new RegExp(`^[ \\t]*\\[[ \\t]*model_providers[ \\t]*\\.[ \\t]*(?:([A-Za-z0-9_-]+)|${STR})[ \\t]*\\][ \\t]*$`);
const BASE_URL = new RegExp(`^[ \\t]*base_url[ \\t]*=[ \\t]*${STR}[ \\t]*$`);

type Lexed = { lines: string[]; strings: (string | undefined)[] }; // undefined = a multi-line string

function lexToml(text: string): Lexed | undefined {
  const lines: string[] = [];
  const strings: (string | undefined)[] = [];
  let line = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n") { lines.push(line); line = ""; i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") { i++; continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c !== '"' && c !== "'") { line += c; i++; continue; }
    const multi = text.startsWith(c.repeat(3), i);
    i += multi ? 3 : 1;
    let value = "";
    for (;;) {
      if (i >= text.length) return undefined; // the file ends inside a string
      const d = text[i]!;
      if (multi && text.startsWith(c.repeat(3), i)) {
        i += 3;
        for (let extra = 0; extra < 2 && text[i] === c; extra++) i++; // up to two content quotes precede the close
        break;
      }
      if (!multi && d === c) { i++; break; }
      if (!multi && (d === "\n" || d === "\r")) return undefined; // an unclosed single-line string never closes: nothing
      if (c === '"' && d === "\\") {
        const e = text[i + 1] ?? "";
        value += e === '"' || e === "\\" ? e : d + e;
        i += 2;
        continue;
      }
      value += d;
      i++;
    }
    strings.push(multi ? undefined : value);
    line += `\u0000${strings.length - 1}\u0001`;
  }
  lines.push(line);
  return { lines, strings };
}

const bracketDelta = (l: string): number => (l.match(/[[{]/g)?.length ?? 0) - (l.match(/[\]}]/g)?.length ?? 0);

/** Top-level `model_provider`, then `base_url` inside `[model_providers.<that name>]`. A built-in provider has no
 *  table, so it names no endpoint. */
export function codexProviderBaseUrl(text: string): string | undefined {
  const lexed = lexToml(text);
  if (!lexed) return undefined;
  const str = (n: string | undefined) => (n === undefined ? undefined : lexed.strings[Number(n)]);
  let provider: string | undefined;
  let table: string | undefined; // the provider name of the current [model_providers.<name>] table
  let sawHeader = false;
  const urls = new Map<string, string>();
  let depth = 0; // open brackets and braces of a value continuing onto later lines (strings are already tokens)
  for (const l of lexed.lines) {
    if (depth > 0) { // a continuation row of a multi-line array or inline table: never a header or a statement
      depth = Math.max(0, depth + bracketDelta(l));
      continue;
    }
    if (/^[ \t]*\[/.test(l)) {
      sawHeader = true;
      const m = PROVIDER_HEADER.exec(l);
      table = m ? m[1] ?? str(m[2]) : undefined;
      continue;
    }
    depth = Math.max(0, bracketDelta(l));
    if (!sawHeader) {
      const m = MODEL_PROVIDER.exec(l);
      if (m && str(m[1]) !== undefined) provider = str(m[1]);
      continue;
    }
    const m = table === undefined ? null : BASE_URL.exec(l);
    if (m && str(m[1]) !== undefined) urls.set(table!, str(m[1])!);
  }
  return provider === undefined ? undefined : urls.get(provider);
}

export function configuredEndpoints(seam: EndpointSeam = {}): ProviderEndpoint[] {
  const out: ProviderEndpoint[] = [];
  const claude = claudeBaseUrl(seam.env, seam.settingsPath);
  if (claude) out.push({ adapter: "claude-code", url: claude.baseUrl });
  const path = seam.codexConfigPath ?? codexConfigPath();
  let text: string | undefined;
  try {
    text = path === undefined ? undefined : readFileSync(path, "utf8");
  } catch {
    text = undefined; // a missing config names no endpoint
  }
  const codexUrl = text === undefined ? undefined : codexProviderBaseUrl(text);
  if (codexUrl !== undefined) out.push({ adapter: "codex", url: codexUrl });
  return out;
}

/** The only reading of a base URL (Shown URL, closed; D-2187 add.126): an http or https URL with a non-empty
 *  hostname, else nothing. Userinfo, path, query and fragment are never carried out of here. */
function parseEndpoint(url: string): { scheme: string; host: string; port: number; shown: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return undefined;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { scheme: u.protocol, host: u.hostname, port, shown: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}` };
}

export const UNPARSEABLE_URL = "<unparseable base_url>";
/** The one formatter for the URL on every doctor, run and resume line and every endpoint-down row. */
export const shownUrl = (url: string): string => parseEndpoint(url)?.shown ?? UNPARSEABLE_URL;

/** One TCP connect to the URL's host and port, nothing sent, never throws. `timeoutMs` is ONE deadline from the start
 *  of the probe — name resolution and the connect together — on a timer socket activity never restarts. */
export function probeEndpoint(url: string, timeoutMs = ENDPOINT_PROBE_TIMEOUT_MS): Promise<EndpointProbe> {
  const parsed = parseEndpoint(url);
  if (!parsed) return Promise.resolve({ listening: false, reason: "unparseable" });
  return new Promise((resolve) => {
    const socket = connect({ host: parsed.host.replace(/^\[(.*)\]$/, "$1"), port: parsed.port });
    const settle = (probe: EndpointProbe) => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(probe);
    };
    const deadline = setTimeout(() => settle({ listening: false, reason: "timeout" }), timeoutMs);
    socket.once("connect", () => settle({ listening: true }));
    socket.once("error", (e: NodeJS.ErrnoException) => settle({ listening: false, reason: e.code ?? "error" }));
  });
}

export const endpointLine = (e: ProviderEndpoint, probe: EndpointProbe): string => probe.listening
  ? `endpoint ${e.adapter}: ${shownUrl(e.url)} listening`
  : `endpoint ${e.adapter}: ${shownUrl(e.url)} down (${probe.reason}) — every ${e.adapter} seat will fail as transport until it answers`;

// Row 435; D-2187 add.130: before the Claude endpoint is probed or shown, its shown text passes the gateway's own sink
// predicate (containLines, the one doctor applies to its printed lines) for the credential gatewayCredential reads from
// the same source. A hit is never resolved, connected, printed or stored; userinfo, path, query and fragment are not in
// the shown text, so a credential there is no hit. Codex endpoints carry no credential tickmarkr knows.
export const WITHHELD_URL = "<withheld base url>";
export const WITHHELD_LINE = "endpoint claude-code: withheld — the base URL carries the gateway credential: not probed";

export async function probeEndpoints(seam: EndpointSeam = {}): Promise<{ endpoint: ProviderEndpoint; probe: EndpointProbe; line: string; shown: string }[]> {
  const credential = gatewayCredential({}, { env: seam.env, settingsPath: seam.settingsPath });
  return Promise.all(configuredEndpoints(seam).map(async (endpoint) => {
    const shown = shownUrl(endpoint.url);
    if (endpoint.adapter === "claude-code" && containLines(shown, credential) !== shown) {
      return { endpoint, probe: { listening: false, reason: "withheld" } as const, line: WITHHELD_LINE, shown: WITHHELD_URL };
    }
    const probe = await probeEndpoint(endpoint.url);
    return { endpoint, probe, line: endpointLine(endpoint, probe), shown };
  }));
}

/** Run and resume: the down endpoints only, with the URL as printed. */
export async function downEndpoints(seam: EndpointSeam = {}): Promise<EndpointDown[]> {
  return (await probeEndpoints(seam)).flatMap(({ endpoint, probe, line, shown }) =>
    probe.listening ? [] : [{ adapter: endpoint.adapter, url: shown, reason: probe.reason, line }]);
}
