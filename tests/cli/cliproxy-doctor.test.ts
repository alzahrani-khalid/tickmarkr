// Queue row 392 R6 (D-2187 add.11, add.12): doctor's gateway record, its line, and the credential's one
// route — request headers to the fake proxy on 127.0.0.1, nowhere else.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const spawned = vi.hoisted(() => [] as unknown[][]);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  type Fn = (...args: unknown[]) => unknown;
  const record = <F,>(fn: F): F => {
    const wrapped = (...args: unknown[]) => {
      spawned.push(args.slice(0, 2));
      return (fn as Fn)(...args);
    };
    // keep execFile's promisified { stdout, stderr } shape, recorded as well
    const custom = (fn as { [promisify.custom]?: Fn })[promisify.custom];
    if (custom) Object.defineProperty(wrapped, promisify.custom, { value: record(custom) });
    return wrapped as F;
  };
  return { ...real, spawn: record(real.spawn), spawnSync: record(real.spawnSync), execFile: record(real.execFile), execFileSync: record(real.execFileSync) };
});

import type { GatewayRecord } from "../../src/adapters/cliproxy.js";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { doctor, type DoctorOpts } from "../../src/cli/commands/doctor.js";
import { failingLookup, type FakeCliproxy, modelList, refusedUrl, type ScriptedReply, startFakeCliproxy } from "../helpers/fake-cliproxy.js";
import { makeRepo } from "../helpers/tmprepo.js";

const proxies: FakeCliproxy[] = [];
const dirs: string[] = [];
const streams: string[] = [];
const CHECKED = "2026-11-08T12:00:00.000Z";
const now = () => new Date(CHECKED);
const stub = { id: "fixture", vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cliproxy-doctor-"));
  dirs.push(d);
  return d;
};
const fake = async (script: ScriptedReply | ScriptedReply[]) => {
  const p = await startFakeCliproxy(script);
  proxies.push(p);
  return p;
};
const cache = (repo: string) => readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8");
const gatewayOf = (repo: string) => (JSON.parse(cache(repo)) as { gateway?: GatewayRecord }).gateway;

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", tmp());
  spawned.length = 0;
  streams.length = 0;
  const keep = (...args: unknown[]) => { streams.push(args.map(String).join(" ")); };
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "log").mockImplementation(keep);
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => { keep(String(chunk)); return true; });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const p of proxies.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the gateway credential travels only in request headers and never appears in argv output or the doctor cache", async () => {
  const token = "sk-cliproxy-SECRET-token-0001";
  const settingsKey = "sk-cliproxy-SECRET-settings-0002";
  const userinfo = "SECRET-userinfo-0003";
  const secrets = [token, settingsKey, userinfo];
  // the proxy echoes the credential back in its 401 body: that body never reaches a reason
  const proxy = await fake([modelList(["claude-opus-5-5", "gemini-3-pro"]), modelList(["gpt-6"]), { status: 401, body: { error: `bad key ${token}` } }, modelList(["grok-5"])]);
  const outputs: string[] = [];
  const caches: string[] = [];
  const repo = makeRepo({ "keep.txt": "x" });
  const run = async (gateway: DoctorOpts["gateway"]) => {
    outputs.push(await doctor(["--"], repo, [stub], { banner: false, gateway: { now, ...gateway } }));
    caches.push(cache(repo));
  };

  // environment source: ANTHROPIC_AUTH_TOKEN wins over ANTHROPIC_API_KEY
  await run({ env: { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: "sk-SECRET-unused-0004" } });
  // settings source: the key is read from the same place the URL came from
  const settings = join(tmp(), "settings.json");
  writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${proxy.url}/v1/`, ANTHROPIC_API_KEY: settingsKey } }));
  await run({ env: {}, settingsPath: settings });
  expect(gatewayOf(repo)).toMatchObject({ source: "claude-settings", listing: { status: "succeeded" } });
  // a failed listing whose body carries the credential
  await run({ env: { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: token } });
  expect(gatewayOf(repo)?.listing).toMatchObject({ status: "failed", failure: "unauthorized", reason: "HTTP 401" });
  // userinfo in the base URL is stripped from the record and never sent
  await run({ env: { ANTHROPIC_BASE_URL: proxy.url.replace("http://", `http://user:${userinfo}@`), ANTHROPIC_AUTH_TOKEN: token } });
  expect(gatewayOf(repo)?.baseUrl).toBe(`${proxy.url}/`);

  expect(proxy.requests.map((r) => [r.path, r.headers.authorization, r.headers["x-api-key"]])).toEqual([
    ["/v1/models", `Bearer ${token}`, token],
    ["/v1/models", `Bearer ${settingsKey}`, settingsKey],
    ["/v1/models", `Bearer ${token}`, token],
    ["/v1/models", `Bearer ${token}`, token],
  ]);
  // the only header carrying a secret byte is the credential pair
  for (const r of proxy.requests) {
    const { authorization: _a, "x-api-key": _k, ...rest } = r.headers;
    expect(JSON.stringify(rest) + r.path).not.toMatch(/SECRET/);
  }

  // Every place a credential could ride outside the headers, through doctor. The check sits at the SINK:
  // the parsed request target (normalized host and serialized URL) before the request, and every field
  // doctor.json or the printed line would carry before the record, each against the credential as is,
  // percent-decoded, NFKC-normalized and case-folded. A hit means no request (or no record) and one typed
  // line naming no value. A query, fragment or userinfo is never part of the API root.
  const odd = "sk/SECRET odd+0005";
  const review = "sk-review-secret-1024";
  secrets.push(odd, review);
  const leaky = await fake([
    modelList([token, `gpt-${token}`, `claude-${token.toUpperCase()}`, "gpt-6"]),
    modelList(["gemini-3-pro"]),
  ]);
  const noRequest = "  ! gateway: withheld (env) — the request target carries the gateway credential: no request sent";
  const noRecord = "  ! gateway: withheld (env) — the listing carries the gateway credential: nothing recorded";
  const placements: { cell: string; url: string; credential?: string; request?: true; models?: string[]; baseUrl?: string; line?: string }[] = [
    // round 1
    { cell: "listed ids carrying the credential", url: leaky.url, request: true, line: noRecord },
    { cell: "a query carrying the credential", url: `${leaky.url}/v1?api_key=${token}`, request: true, models: ["gemini-3-pro"], baseUrl: `${leaky.url}/v1` },
    { cell: "a fragment carrying the credential", url: `${leaky.url}/#${token}`, request: true, models: ["gemini-3-pro"], baseUrl: `${leaky.url}/` },
    { cell: "a path segment carrying the credential", url: `${leaky.url}/${token}/`, line: noRequest },
    { cell: "a path segment carrying it case-folded", url: `${leaky.url}/${token.toLowerCase()}/v1`, line: noRequest },
    { cell: "a path carrying a percent-encoded credential", url: `${leaky.url}/${encodeURIComponent(odd)}`, credential: odd, line: noRequest },
    { cell: "a path carrying a credential the URL parser encodes", url: `${leaky.url}/${odd}`, credential: odd, line: noRequest },
    { cell: "a host label carrying the credential (lower-cased by the URL parser)", url: leaky.url.replace("127.0.0.1", `${token}.localhost`), line: noRequest },
    // round 2: the URL parser decodes and normalizes a host the raw URL does not spell as the credential
    { cell: "a host with one percent-encoded character", url: leaky.url.replace("127.0.0.1", "%73k-review-secret-1024.localhost"), credential: review, line: noRequest },
    { cell: "a host in fullwidth characters", url: leaky.url.replace("127.0.0.1", "ｓｋ－ｒｅｖｉｅｗ－ｓｅｃｒｅｔ－１０２４.localhost"), credential: review, line: noRequest },
  ];
  for (const c of placements) {
    const sent = leaky.requests.length;
    // a name host resolves only through this scripted resolver, so even a leak would send no packet
    const lookup = failingLookup("ENOTFOUND");
    await run({ env: { ANTHROPIC_BASE_URL: c.url, ANTHROPIC_AUTH_TOKEN: c.credential ?? token }, lookup });
    expect(leaky.requests.length - sent, c.cell).toBe(c.request ? 1 : 0);
    expect(lookup.calls, c.cell).toEqual([]);
    if (c.request) expect(leaky.requests.at(-1)?.path, c.cell).toBe("/v1/models");
    if (c.models) {
      expect(gatewayOf(repo), c.cell).toMatchObject({ baseUrl: c.baseUrl, listing: { status: "succeeded" } });
      expect(gatewayOf(repo)?.models.map((m) => m.id), c.cell).toEqual(c.models);
    } else {
      // no gateway is recorded (an earlier record is removed) and the one line names no value
      expect(gatewayOf(repo), c.cell).toBeUndefined();
      expect(outputs.at(-1)?.split("\n").filter((l) => l.includes("gateway:")), c.cell).toEqual([c.line]);
    }
  }
  // a transport error code carrying the credential is a field like any other: no record
  await run({ env: { ANTHROPIC_BASE_URL: leaky.url, ANTHROPIC_AUTH_TOKEN: token }, request: async () => ({ kind: "error", code: token }) });
  expect(gatewayOf(repo)).toBeUndefined();
  expect(outputs.at(-1)?.split("\n").filter((l) => l.includes("gateway:"))).toEqual([noRecord]);
  // every request a placement sent kept the credential in its two headers only
  for (const r of leaky.requests) {
    const { authorization: _a, "x-api-key": _k, ...rest } = r.headers;
    expect(JSON.stringify(rest) + r.path).not.toMatch(/secret/i);
  }

  expect(spawned.length).toBeGreaterThan(0); // the recorder saw doctor's own child processes
  const argv = JSON.stringify([spawned, process.argv]);
  const printed = [...outputs, ...streams].join("\n");
  // as is, and in every form a parser or printer could turn it into
  const decoded = (t: string) => t.replace(/(?:%[0-9a-f]{2})+/gi, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
  const folded = (t: string) => decoded(t).normalize("NFKC").toLowerCase();
  for (const secret of secrets) {
    expect(argv).not.toContain(secret);
    expect(printed).not.toContain(secret);
    expect(folded(printed)).not.toContain(folded(secret));
    for (const bytes of caches) {
      expect(bytes).not.toContain(secret);
      expect(folded(bytes)).not.toContain(folded(secret));
    }
  }
  expect(printed).toContain("gateway: 127.0.0.1 (env) — unauthorized: HTTP 401");
}, 60_000); // a doctor run per cell

test("doctor records the gateway with its typed listing result and prints its line while a failed listing leaves the exit code unchanged", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const ids = ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3-pro", "gpt-6.1-sol", "codex-mini-latest", "grok-5", "opus"];
  const proxy = await fake(modelList(ids));
  const exitBefore = process.exitCode;
  const ok = await doctor(["--"], repo, [stub], { banner: false, gateway: { env: { ANTHROPIC_BASE_URL: proxy.url }, now } });
  const line = "gateway: 127.0.0.1 (env) — proxy, 7 models: anthropic 2 · google 1 · openai 2 · xai 1 · unclassified 1";
  expect(ok.split("\n").filter((l) => l.includes("gateway:"))).toEqual([`  ✓ ${line}`]);
  expect(gatewayOf(repo)).toEqual({
    host: "127.0.0.1",
    baseUrl: proxy.url,
    source: "env",
    listing: { status: "succeeded", checkedAt: CHECKED },
    models: [
      { id: "claude-opus-5-5", vendor: "anthropic" }, { id: "claude-sonnet-5-5", vendor: "anthropic" },
      { id: "gemini-3-pro", vendor: "google" }, { id: "gpt-6.1-sol", vendor: "openai" },
      { id: "codex-mini-latest", vendor: "openai" }, { id: "grok-5", vendor: "xai" }, { id: "opus", vendor: null },
    ],
  });
  // the adapter verdicts are untouched: the gateway is one extra key, written last
  const keys = Object.keys(JSON.parse(cache(repo)));
  expect(keys.at(-1)).toBe("gateway");
  expect(keys).toContain("fixture");
  const okWithoutLine = ok.split("\n").filter((l) => !l.includes("gateway:")).join("\n");

  const down = await refusedUrl();
  const slow = await fake({ ...modelList(ids), delayMs: 2000 });
  const denied = await fake({ status: 403, body: "nope" });
  const missing = await fake({ status: 404, body: "no such route" });
  const failures: [string, string, Record<string, unknown>, number?][] = [
    [down, "down: ECONNREFUSED", { failure: "down", reason: "ECONNREFUSED" }],
    [slow.url, "timed out: no reply within 150 ms", { failure: "timeout", reason: "no reply within 150 ms" }, 150],
    [denied.url, "unauthorized: HTTP 403", { failure: "unauthorized", reason: "HTTP 403" }],
    [missing.url, "refused: HTTP 404", { failure: "refused", reason: "HTTP 404" }],
  ];
  for (const [url, shown, typed, timeoutMs] of failures) {
    const out = await doctor(["--"], repo, [stub], { banner: false, gateway: { env: { ANTHROPIC_BASE_URL: url }, now, ...(timeoutMs ? { timeoutMs } : {}) } });
    expect(out.split("\n").filter((l) => l.includes("gateway:")), shown).toEqual([`  ! gateway: 127.0.0.1 (env) — ${shown}`]);
    expect(gatewayOf(repo), shown).toEqual({
      host: "127.0.0.1", baseUrl: url, source: "env", listing: { status: "failed", ...typed, checkedAt: CHECKED }, models: [],
    });
    // never fatal: doctor resolves, sets no exit code, and every other line is as with a working proxy
    expect(process.exitCode, shown).toBe(exitBefore);
    expect(out.split("\n").filter((l) => !l.includes("gateway:")).join("\n"), shown).toBe(okWithoutLine);
  }
  expect([slow, denied, missing].map((p) => p.requests.length)).toEqual([1, 1, 1]);

  // the config override is the third source
  const config = await fake(modelList(["gpt-6"]));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), JSON.stringify({ cliproxy: { baseUrl: `${config.url}/v1` } }));
  const viaConfig = await doctor(["--"], repo, [stub], { banner: false, gateway: { env: { ANTHROPIC_BASE_URL: missing.url }, now } });
  expect(viaConfig).toContain("gateway: 127.0.0.1 (config) — proxy, 1 models: anthropic 0 · google 0 · openai 1 · xai 0 · unclassified 0");
  expect(gatewayOf(repo)).toMatchObject({ source: "config", baseUrl: `${config.url}/v1` });
  expect(config.requests.map((r) => r.path)).toEqual(["/v1/models"]);
  expect(missing.requests.length).toBe(1);
});
