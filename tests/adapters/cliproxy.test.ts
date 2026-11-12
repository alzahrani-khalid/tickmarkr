// Queue row 392 R6 laws 1 to 3 (D-2187 add.11, add.12, add.21): gateway detection, the API root, the one
// listing request and its typed failures, and the closed vendor family table. Every request reaches only
// the fake proxy on 127.0.0.1.
import dns from "node:dns";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { apiRoot, detectGateway, GATEWAY_LISTING_TIMEOUT_MS, gatewayFamily, gatewayLine, type GatewayRequest, listGateway, recordGateway } from "../../src/adapters/cliproxy.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { failingLookup, type FakeCliproxy, modelList, refusedUrl, type ScriptedReply, startFakeCliproxy } from "../helpers/fake-cliproxy.js";
import { makeRepo } from "../helpers/tmprepo.js";

const proxies: FakeCliproxy[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const p of proxies.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fake = async (script: ScriptedReply | ScriptedReply[]) => {
  const p = await startFakeCliproxy(script);
  proxies.push(p);
  return p;
};
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cliproxy-"));
  dirs.push(d);
  return d;
};
const absent = () => join(tmp(), "absent-settings.json");
const stub = { id: "fixture", vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;

test("the gateway listing CASE table yields succeeded down timeout unauthorized and refused from the fake proxy", async () => {
  const listed = ["claude-opus-5-5", "gemini-3-pro", "gpt-6.1-sol", "grok-5", "opus", "bad id"];
  // unreachable and unresolved run through the production transport (node:http) with its resolver
  // scripted to fail as the OS does, so no packet leaves the host
  const named = "http://gateway.cliproxy.test:8317";
  const lookups = ["EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].map(failingLookup);
  const cells: { cell: string; reply?: ScriptedReply; url?: string; lookup?: (typeof lookups)[number]; host?: string; timeoutMs?: number; status: string; failure?: string; reason?: string | RegExp }[] = [
    { cell: "200 OpenAI-style list", reply: modelList(listed), status: "succeeded" },
    { cell: "connection refused", url: await refusedUrl(), status: "failed", failure: "down", reason: "ECONNREFUSED" },
    { cell: "connection reset", reply: { reset: true }, status: "failed", failure: "down", reason: "ECONNRESET" },
    { cell: "host unreachable", url: named, lookup: lookups[0], host: "gateway.cliproxy.test", status: "failed", failure: "down", reason: "EHOSTUNREACH" },
    { cell: "network unreachable", url: named, lookup: lookups[1], host: "gateway.cliproxy.test", status: "failed", failure: "down", reason: "ENETUNREACH" },
    { cell: "name unresolved", url: named, lookup: lookups[2], host: "gateway.cliproxy.test", status: "failed", failure: "down", reason: "ENOTFOUND" },
    { cell: "name resolution failed", url: named, lookup: lookups[3], host: "gateway.cliproxy.test", status: "failed", failure: "down", reason: "EAI_AGAIN" },
    { cell: "the timer fires", reply: { ...modelList(listed), delayMs: 2000 }, timeoutMs: 150, status: "failed", failure: "timeout", reason: "no reply within 150 ms" },
    { cell: "401", reply: { status: 401, body: { error: "no key" } }, status: "failed", failure: "unauthorized", reason: "HTTP 401" },
    { cell: "403", reply: { status: 403, body: "forbidden" }, status: "failed", failure: "unauthorized", reason: "HTTP 403" },
    { cell: "404", reply: { status: 404, body: "not found" }, status: "failed", failure: "refused", reason: "HTTP 404" },
    { cell: "500", reply: { status: 500, body: modelList(listed).body }, status: "failed", failure: "refused", reason: "HTTP 500" },
    { cell: "a 2xx that is not 200", reply: { status: 204 }, status: "failed", failure: "refused", reason: "HTTP 204" },
    { cell: "a redirect", reply: { status: 302, headers: { location: "/v1/elsewhere" } }, status: "failed", failure: "refused", reason: "HTTP 302 redirect (not followed)" },
    { cell: "a non-JSON body", reply: { status: 200, body: "<html>proxy</html>" }, status: "failed", failure: "refused", reason: "HTTP 200 body is not JSON" },
    { cell: "JSON with no data", reply: { status: 200, body: { models: listed } }, status: "failed", failure: "refused", reason: "HTTP 200 JSON carries no model id list" },
    { cell: "data entries without a string id", reply: { status: 200, body: { data: [{ id: "gpt-6" }, { name: "x" }] } }, status: "failed", failure: "refused", reason: "HTTP 200 JSON carries no model id list" },
    { cell: "a top-level array", reply: { status: 200, body: [{ id: "gpt-6" }] }, status: "failed", failure: "refused", reason: "HTTP 200 JSON carries no model id list" },
    { cell: "data that is not an array", reply: { status: 200, body: { data: "gpt-6" } }, status: "failed", failure: "refused", reason: "HTTP 200 JSON carries no model id list" },
  ];
  for (const c of cells) {
    const proxy = c.reply ? await fake(c.reply) : undefined;
    const url = c.url ?? proxy!.url;
    const record = await listGateway({}, { env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "tok" }, timeoutMs: c.timeoutMs, lookup: c.lookup });
    expect(record?.listing.status, c.cell).toBe(c.status);
    expect(record?.listing.failure, c.cell).toBe(c.failure);
    expect(record?.listing.reason, c.cell).toBe(c.reason);
    expect(record?.host, c.cell).toBe(c.host ?? "127.0.0.1");
    expect(record?.source, c.cell).toBe("env");
    if (proxy) {
      // exactly one GET to the API root's /models; a redirect is never followed
      expect(proxy.requests.map((r) => `${r.method} ${r.path}`), c.cell).toEqual(["GET /v1/models"]);
    }
    if (c.status === "succeeded") {
      // only ids matching MODEL_ID_RE are kept, each with its family or unclassified
      expect(record?.models).toEqual([
        { id: "claude-opus-5-5", vendor: "anthropic" }, { id: "gemini-3-pro", vendor: "google" },
        { id: "gpt-6.1-sol", vendor: "openai" }, { id: "grok-5", vendor: "xai" }, { id: "opus", vendor: null },
      ]);
    } else {
      expect(record?.models, c.cell).toEqual([]);
    }
  }
  // each scripted resolver was asked once, for the gateway's own name: the one request went through it
  expect(lookups.map((l) => l.calls)).toEqual(Array(4).fill(["gateway.cliproxy.test"]));
  // the production budget is 5000 ms, and the timeout class comes from the runner's own timer
  expect(GATEWAY_LISTING_TIMEOUT_MS).toBe(5000);
  const request = vi.fn<GatewayRequest>(async () => ({ kind: "timeout" }));
  const timedOut = await listGateway({}, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, request });
  expect(request).toHaveBeenCalledWith("http://127.0.0.1:8317/v1/models", { accept: "application/json" }, 5000);
  expect(timedOut?.listing).toMatchObject({ status: "failed", failure: "timeout", reason: "no reply within 5000 ms" });
  // an errno-shaped TEXT in a reply body is a reply, never a transport failure
  const texty = await listGateway({}, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, request: async () => ({ kind: "reply", status: 200, body: "ETIMEDOUT ECONNREFUSED" }) });
  expect(texty?.listing).toMatchObject({ failure: "refused" });
});

test("the api root keeps exactly one version segment for every base url form on the wire", async () => {
  for (const base of ["http://h:8317", "http://h:8317/", "http://h:8317/v1", "http://h:8317/v1/", "http://h:8317/v1//"]) {
    expect(apiRoot(base), base).toBe("http://h:8317/v1");
  }
  expect(apiRoot("http://h:8317/proxy/")).toBe("http://h:8317/proxy/v1");
  const proxy = await fake(modelList(["gpt-6"]));
  for (const base of [proxy.url, `${proxy.url}/`, `${proxy.url}/v1`, `${proxy.url}/v1/`]) {
    expect((await listGateway({}, { env: { ANTHROPIC_BASE_URL: base } }))?.listing.status, base).toBe("succeeded");
  }
  // the config override replaces the detected URL through the same helper (source config)
  const viaConfig = await listGateway({ cliproxy: { baseUrl: `${proxy.url}/v1/` } }, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } });
  expect(viaConfig).toMatchObject({ source: "config", baseUrl: `${proxy.url}/v1/`, listing: { status: "succeeded" } });
  expect(proxy.requests.map((r) => r.path)).toEqual(Array(5).fill("/v1/models"));
});

test("with no gateway source a disabled detection or the anthropic url no request is made and no gateway is recorded", async () => {
  const proxy = await fake(modelList(["gpt-6"]));
  const request = vi.fn<GatewayRequest>(async () => ({ kind: "reply", status: 200, body: "{\"data\":[]}" }));
  const dir = tmp();
  const noUrlSettings = join(dir, "no-url.json");
  writeFileSync(noUrlSettings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "tok" } }));
  const anthropicSettings = join(dir, "anthropic.json");
  writeFileSync(anthropicSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com/" } }));
  const cells: { cell: string; cfg: Parameters<typeof listGateway>[0]; env?: NodeJS.ProcessEnv; settingsPath?: string }[] = [
    { cell: "no source: empty env and no settings file", cfg: {}, env: {}, settingsPath: absent() },
    { cell: "no source: settings env without a base URL", cfg: {}, env: { ANTHROPIC_API_KEY: "tok" }, settingsPath: noUrlSettings },
    { cell: "no source: OPENAI_BASE_URL is not a source", cfg: {}, env: { OPENAI_BASE_URL: proxy.url }, settingsPath: absent() },
    { cell: "no source: under VITEST the process environment never detects", cfg: {} },
    { cell: "under VITEST the process environment never detects, even with a config base URL", cfg: { cliproxy: { baseUrl: proxy.url } } },
    { cell: "under VITEST the explicit process environment never detects, even with a config base URL", cfg: { cliproxy: { baseUrl: proxy.url } }, env: process.env },
    { cell: "detect false over an env gateway", cfg: { cliproxy: { detect: false } }, env: { ANTHROPIC_BASE_URL: proxy.url } },
    { cell: "detect false over a config base URL", cfg: { cliproxy: { detect: false, baseUrl: proxy.url } }, env: {}, settingsPath: absent() },
    { cell: "the anthropic url in env", cfg: {}, env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
    { cell: "the anthropic url in the settings env", cfg: {}, env: {}, settingsPath: anthropicSettings },
    { cell: "the anthropic url as the config override", cfg: { cliproxy: { baseUrl: "https://api.anthropic.com/v1" } }, env: {}, settingsPath: absent() },
    { cell: "an unparseable base URL", cfg: {}, env: { ANTHROPIC_BASE_URL: "not a URL" } },
  ];
  for (const c of cells) {
    const seam = { ...(c.env ? { env: c.env } : {}), ...(c.settingsPath ? { settingsPath: c.settingsPath } : {}), request };
    expect(detectGateway(c.cfg, seam), c.cell).toBeUndefined();
    expect(await listGateway(c.cfg, seam), c.cell).toBeUndefined();
    // the production transport too: nothing reaches the proxy
    expect(await listGateway(c.cfg, { ...seam, request: undefined }), c.cell).toBeUndefined();
  }
  expect(request).not.toHaveBeenCalled();
  expect(proxy.requests).toEqual([]);

  // doctor: no gateway line, no gateway key, and a stale record from an earlier doctor is removed
  vi.stubEnv("XDG_CONFIG_HOME", tmp());
  const repo = makeRepo({ "keep.txt": "x" });
  const base = await doctor(["--"], repo, [stub], { banner: false });
  const path = join(repo, ".tickmarkr", "doctor.json");
  const baseBytes = readFileSync(path, "utf8");
  // Row 435; D-2187 add.130: doctor feeds the endpoint probe the gateway's inputs, so a cell with a Claude base URL
  // gains exactly the endpoint line; a name host resolves to nothing here, so no packet leaves the machine.
  const down = (url: string, reason: string) =>
    `  ✗ endpoint claude-code: ${url} down (${reason}) — every claude-code seat will fail as transport until it answers`;
  const endpointLines: Record<string, string> = {
    "detect false over an env gateway": `  ✓ endpoint claude-code: ${proxy.url} listening`,
    "the anthropic url in env": down("https://api.anthropic.com", "ENOTFOUND"),
    "the anthropic url in the settings env": down("https://api.anthropic.com", "ENOTFOUND"),
    "an unparseable base URL": down("<unparseable base_url>", "unparseable"),
  };
  const notFound = vi.spyOn(dns, "lookup").mockImplementation(((host: string, _o: unknown, cb: (...a: unknown[]) => void) =>
    process.nextTick(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })))) as never);
  for (const c of cells) {
    const seam = { ...(c.env ? { env: c.env } : {}), ...(c.settingsPath ? { settingsPath: c.settingsPath } : {}), request };
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), c.cfg.cliproxy ? JSON.stringify({ cliproxy: c.cfg.cliproxy }) : "{}\n");
    const out = await doctor(["--"], repo, [stub], { banner: false, gateway: seam });
    expect(out, c.cell).not.toContain("gateway:");
    const isEndpoint = (l: string) => l.includes("endpoint claude-code:");
    expect(out.split("\n").filter(isEndpoint), c.cell).toEqual(endpointLines[c.cell] ? [endpointLines[c.cell]] : []);
    expect(out.split("\n").filter((l) => !isEndpoint(l)).join("\n"), c.cell).toBe(base);
    expect(readFileSync(path, "utf8"), c.cell).toBe(baseBytes);
    expect(JSON.parse(readFileSync(path, "utf8")), c.cell).not.toHaveProperty("gateway");
  }
  notFound.mockRestore();
  writeFileSync(path, JSON.stringify({ ...JSON.parse(baseBytes), gateway: { host: "stale" } }, null, 2) + "\n");
  recordGateway(repo, undefined);
  expect(readFileSync(path, "utf8")).toBe(baseBytes);
  // with nothing on disk to remove, recordGateway writes nothing at all
  rmSync(path);
  recordGateway(repo, undefined);
  expect(existsSync(path)).toBe(false);
  // an adapter named "gateway" owns that doctor.json key: no gateway, or a gateway, leaves its verdict as is
  const adapterBytes = JSON.stringify({ gateway: { installed: true, authed: true, models: [] } }, null, 2) + "\n";
  writeFileSync(path, adapterBytes);
  recordGateway(repo, undefined);
  recordGateway(repo, { host: "127.0.0.1", baseUrl: proxy.url, source: "env", listing: { status: "succeeded", checkedAt: "2026-11-08T12:00:00.000Z" }, models: [] });
  expect(readFileSync(path, "utf8")).toBe(adapterBytes);
  expect(request).not.toHaveBeenCalled();
  expect(proxy.requests).toEqual([]);
}, 60_000); // a doctor run per cell

test("the vendor family table classifies each listed prefix and leaves every bait id unclassified", async () => {
  const classified: [string, string][] = [
    ["claude-opus-5-5", "anthropic"], ["Claude-Sonnet-5-5", "anthropic"], ["claude-fable-5-1", "anthropic"],
    ["gemini-3-pro", "google"], ["GEMINI-2.5-flash", "google"],
    ["gpt-6.1-sol", "openai"], ["codex-mini-latest", "openai"], ["GPT-5", "openai"],
    ["grok-5", "xai"], ["grok-code-fast-1", "xai"],
  ];
  const bait = ["claude", "opus", "sonnet", "o3", "xclaude-1", "anthropic/claude-opus-5-5", "openai/gpt-6", "google/gemini-3-pro",
    "x-ai/grok-5", "gemini", "grok", "gpt", "codex", "claudeopus", "gpt6", "kimi-k3", "glm-5.2", " claude-opus-5-5"];
  for (const [id, vendor] of classified) expect(gatewayFamily(id), id).toBe(vendor);
  for (const id of bait) expect(gatewayFamily(id), id).toBeNull();
  // through the listing: a recorded vendor is the family, never the carrying adapter's vendor
  const proxy = await fake(modelList([...classified.map(([id]) => id), ...bait]));
  const record = await listGateway({}, { env: { ANTHROPIC_BASE_URL: proxy.url } });
  expect(record?.models).toEqual([
    ...classified.map(([id, vendor]) => ({ id, vendor })),
    ...bait.filter((id) => id !== " claude-opus-5-5").map((id) => ({ id, vendor: null })),
  ]);
});

test("a credential spelled through percent-encoding case width or an ignored character never reaches a request target a record or a printed line", async () => {
  // Bounded: every single-character respelling of one credential, in the host and in the path, and as a
  // listed id. The oracle is independent of the module: a value exposes the credential when, percent-
  // decoded, NFKC-normalized and lower-cased, it contains it.
  const credential = "sk-review-secret-1024";
  const decoded = (t: string) => t.replace(/(?:%[0-9a-f]{2})+/gi, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
  const exposes = (t: string) => decoded(t).normalize("NFKC").toLowerCase().includes(credential);
  const respell: ((ch: string) => string)[] = [
    (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`, // percent-encoded
    (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0), // fullwidth
    (ch) => ch.toUpperCase(), // case
    (ch) => `­${ch}`, // a soft hyphen: the host normalizer drops it, NFKC alone does not
  ];
  const spellings = [...new Set([...credential].flatMap((_, i) => respell.map((f) => credential.slice(0, i) + f(credential[i]) + credential.slice(i + 1))))];
  expect(spellings.length).toBeGreaterThan(60);
  let withheldHosts = 0;
  for (const spelled of spellings) {
    for (const url of [`http://${spelled}.localhost:8317`, `http://127.0.0.1:8317/${spelled}`]) {
      const sent: string[] = [];
      const request: GatewayRequest = async (target) => { sent.push(target); return { kind: "reply", status: 200, body: JSON.stringify({ data: [{ id: "gpt-6" }] }) }; };
      const outcome = await listGateway({}, { env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: credential }, request });
      expect(outcome, url).toBeDefined();
      for (const target of sent) {
        expect(exposes(target), url).toBe(false);
        expect(exposes(new URL(target).hostname), url).toBe(false);
      }
      expect(exposes(gatewayLine(outcome!)), url).toBe(false);
      if (outcome && "listing" in outcome) {
        for (const field of [outcome.host, outcome.baseUrl, ...outcome.models.map((m) => m.id)]) expect(exposes(field), url).toBe(false);
      } else {
        expect(outcome, url).toEqual({ withheld: "request target", source: "env" });
        expect(sent, url).toEqual([]);
      }
      // every host spelling parses back to the credential, so none of them is ever a request target
      if (url.endsWith(".localhost:8317") && outcome && "withheld" in outcome) withheldHosts += 1;
    }
    // the same respelling as a listed id: kept only when it cannot expose the credential
    const listed = await listGateway({}, {
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: credential },
      request: async () => ({ kind: "reply", status: 200, body: JSON.stringify({ data: [{ id: `gpt-${spelled}` }, { id: "gpt-6" }] }) }),
    });
    if (listed && "listing" in listed) {
      for (const m of listed.models) expect(exposes(m.id), spelled).toBe(false);
    } else {
      expect(listed, spelled).toEqual({ withheld: "listing", source: "env" });
    }
    expect(exposes(gatewayLine(listed!)), spelled).toBe(false);
  }
  expect(withheldHosts).toBe(spellings.length);
});
