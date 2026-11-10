// Queue row 392 R6 laws 1 to 3 (D-2187 add.11, add.12, add.21): a model proxy (CLIProxyAPI or any
// OpenAI-style gateway) behind the Claude CLI's base URL. Detection reads only the closed sources the
// Claude CLI itself reads (claudeBaseUrl, shared with claudeGatewayHost) or the cliproxy config override:
// no port scan, no guessed port, never OPENAI_BASE_URL. Doctor makes ONE header-only GET to
// <API root>/models when, and only when, a gateway is detected. The credential leaves this module only
// as request headers: never argv, a printed line, doctor.json, a journal, a log or an error text. It is
// checked at the SINK, after the URL parser has decoded and normalized the host: the parsed request
// target before the request, and every recorded or printed field before the record.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { stateDirName } from "../graph/graph.js";
import type { TickmarkrConfig } from "../config/config.js";
import { observedIdentity } from "../route/preference.js";
import { belongsToAliasFamily, claudeBaseUrl, gatewayHostOf, readClaudeAliasIdentity, statedClaudeIdentity, vitestProcessInputs } from "./claude-code.js";
import { MODEL_ID_RE } from "./types.js";

export const GATEWAY_LISTING_TIMEOUT_MS = 5000;
const MAX_LISTING_BYTES = 4_000_000; // a runaway body cannot make the one request unbounded

export type GatewayVendor = "anthropic" | "google" | "openai" | "xai";
export type GatewaySource = "env" | "claude-settings" | "config";
export type GatewayFailure = "down" | "timeout" | "unauthorized" | "refused";
/** A detected gateway given no request ("request target") or no record ("listing") because a value bound
 *  for outside the headers carries the credential. It names no value: only the source. */
export type GatewayWithheld = { withheld: "request target" | "listing"; source: GatewaySource };
/** `claudeHost` is set only when a config override is not the Claude CLI's own endpoint (D-2187 add.21 (3)). */
export type GatewayTarget = { baseUrl: string; modelsUrl: string; host: string; source: GatewaySource; credential?: string; claudeHost?: string };
export type GatewayRecord = {
  host: string;
  baseUrl: string;
  source: GatewaySource;
  listing: { status: "succeeded" | "failed"; failure?: GatewayFailure; reason?: string; checkedAt: string };
  models: { id: string; vendor: GatewayVendor | null }[];
  /** D-2187 add.21 (3), cross-read M6: present only on a confirmed listing through a config override that
   *  differs from the Claude CLI's endpoint (at `claudeHost`). The claude launch never goes through it, so
   *  its anthropic-family ids are never used. */
  anthropicUnusable?: { claudeHost: string };
};
/** The stated-identity turn: the trimmed reply of `claude -p … --model <model>`, unfiltered. */
export type ClaudeIdentityTurn = (cwd: string, model: string) => string | undefined;
/** The one request's outcome as the transport saw it; `timeout` is only ever this module's own timer. */
export type GatewayReply = { kind: "reply"; status: number; body: string; oversize?: true } | { kind: "timeout" } | { kind: "error"; code: string };
export type GatewayRequest = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<GatewayReply>;
/** Test seams: the environment and settings file detection reads, the request transport, and the
 *  resolver the production transport hands node:http (dns.lookup when absent). */
export type GatewaySeam = { env?: NodeJS.ProcessEnv; settingsPath?: string; request?: GatewayRequest; lookup?: LookupFunction; timeoutMs?: number; now?: () => Date; identityTurn?: ClaudeIdentityTurn };
type CliproxyConfig = { cliproxy?: { detect?: boolean; baseUrl?: string } };

/** The closed vendor family table, matched at the start of the lower-cased id. Anything else is unclassified. */
const FAMILIES: readonly (readonly [string, GatewayVendor])[] = [
  ["claude-", "anthropic"], ["gemini-", "google"], ["gpt-", "openai"], ["codex-", "openai"], ["grok-", "xai"],
];
export function gatewayFamily(id: string): GatewayVendor | null {
  const lower = id.toLowerCase();
  return FAMILIES.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? null;
}

/** Cross-read M5: trailing slashes dropped, a final /v1 kept exactly once. The listing and the pi
 *  provider registration both use this, so the two never reach different endpoints. */
export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** A base URL's API root after URL normalisation (case, default port), or undefined when unparseable. */
function endpointRoot(baseUrl: string): string | undefined {
  try {
    return apiRoot(new URL(withoutSecretParts(baseUrl)).href);
  } catch {
    return undefined;
  }
}

/** Userinfo, query and fragment are never part of an API root: they are dropped before the URL is sent
 *  or recorded, so none of them can carry a secret there. */
function withoutSecretParts(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!url.username && !url.password && !url.search && !url.hash) return baseUrl;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return baseUrl;
  }
}

/** Runs of %XX decoded where they form UTF-8; a run that does not is kept as written. */
const percentDecoded = (s: string) => s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
});

/** A text as is, percent-decoded, NFKC-normalized and case-folded, in every combination. */
function forms(s: string): string[] {
  const out = new Set<string>();
  for (const a of [s, percentDecoded(s)]) {
    for (const b of [a, a.normalize("NFKC")]) {
      const folded = b.toLowerCase();
      out.add(b).add(folded).add(folded.normalize("NFKC"));
    }
  }
  return [...out];
}

/** Whether a value bound for outside the headers carries the credential: each form of the value is searched
 *  for each form of the credential and of its URI encodings (as a URL parser writes it). Callers pass the
 *  value as it reaches its sink — the parsed target, the recorded field, the printed line. */
function carries(text: string, credential: string | undefined): boolean {
  if (!credential) return false;
  const needles = new Set(forms(credential));
  for (const encode of [encodeURI, encodeURIComponent]) {
    try {
      for (const f of forms(encode(credential))) needles.add(f);
    } catch {
      // a lone surrogate has no URI form; its other forms are still searched
    }
  }
  const hay = forms(text);
  return [...needles].some((needle) => needle !== "" && hay.some((h) => h.includes(needle)));
}

/** ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY — what the claude CLI itself sends to its base URL. */
function credentialOf(vars: Readonly<Record<string, unknown>>): string | undefined {
  return [vars.ANTHROPIC_AUTH_TOKEN, vars.ANTHROPIC_API_KEY].find((v): v is string => typeof v === "string" && v !== "");
}

/** The gateway target, or undefined (no source, detect:false, an api.anthropic.com or unparseable URL,
 *  or, under VITEST, the process environment with no injected settings path — the override included).
 *  The credential is the one the Claude CLI sends to ITS gateway, read from the place its URL came from;
 *  with no Claude gateway there is none, so an Anthropic API key never travels to an override host. A
 *  target whose parsed host or serialized URL carries the credential is withheld: no request. */
export function detectGateway(cfg: CliproxyConfig, seam: GatewaySeam = {}): GatewayTarget | GatewayWithheld | undefined {
  if (cfg.cliproxy?.detect === false || vitestProcessInputs(seam.env, seam.settingsPath)) return undefined;
  const claude = claudeBaseUrl(seam.env, seam.settingsPath);
  const claudeHost = claude && gatewayHostOf(claude.baseUrl);
  const credential = claude && claudeHost ? credentialOf(claude.vars) : undefined;
  const override = cfg.cliproxy?.baseUrl;
  const picked = override !== undefined ? { baseUrl: override, source: "config" as const }
    : claude && claudeHost ? { baseUrl: claude.baseUrl, source: claude.source } : undefined;
  const baseUrl = picked && withoutSecretParts(picked.baseUrl);
  const host = baseUrl && gatewayHostOf(baseUrl);
  if (!picked || !baseUrl || !host) return undefined;
  const modelsUrl = `${apiRoot(baseUrl)}/models`;
  // D-2187 add.21 (3), cross-read M6: the claude launch is unchanged, so it goes to the gateway the closed
  // sources name, or to api.anthropic.com when they name none. An override that is not that endpoint after
  // API-root normalisation never carries anthropic-family ids.
  const overrideDiffers = picked.source === "config" && (!claude || !claudeHost || endpointRoot(baseUrl) !== endpointRoot(claude.baseUrl));
  let parsed: URL;
  try {
    parsed = new URL(modelsUrl);
  } catch {
    return undefined;
  }
  // At the sink (queue row 392 R6, D-2187): what node:http is handed — the hostname the URL parser
  // decoded and normalized, and the whole serialized URL — not only the text the source spelled.
  if ([parsed.hostname, parsed.href, host, baseUrl, modelsUrl].some((v) => carries(v, credential))) {
    return { withheld: "request target", source: picked.source };
  }
  return { baseUrl, modelsUrl, host, source: picked.source, ...(credential ? { credential } : {}), ...(overrideDiffers ? { claudeHost: claudeHost || "api.anthropic.com" } : {}) };
}

/** The production transport: one GET through node:http or node:https, no redirect followed, its own timer. */
export const httpGet = (url: string, headers: Record<string, string>, timeoutMs: number, lookup?: LookupFunction): Promise<GatewayReply> => new Promise((resolve) => {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (reply: GatewayReply) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(reply);
  };
  try {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).get({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      headers,
      agent: false,
      ...(lookup ? { lookup } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_LISTING_BYTES) {
          finish({ kind: "reply", status: res.statusCode ?? 0, body: "", oversize: true });
          req.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => finish({ kind: "reply", status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e: NodeJS.ErrnoException) => finish({ kind: "error", code: e.code ?? "response error" }));
    });
    timer = setTimeout(() => {
      finish({ kind: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => finish({ kind: "error", code: e.code ?? "request error" }));
  } catch (e) {
    finish({ kind: "error", code: (e as NodeJS.ErrnoException).code ?? "request error" });
  }
});

type Listing = { status: "succeeded"; models: GatewayRecord["models"] } | { status: "failed"; failure: GatewayFailure; reason: string };

/** The closed listing table. Reasons are fixed text plus a status or errno code — never a body byte. */
function classifyReply(reply: GatewayReply, timeoutMs: number): Listing {
  const failed = (failure: GatewayFailure, reason: string): Listing => ({ status: "failed", failure, reason });
  if (reply.kind === "timeout") return failed("timeout", `no reply within ${timeoutMs} ms`);
  if (reply.kind === "error") return failed("down", reply.code);
  const { status, body } = reply;
  if (status === 401 || status === 403) return failed("unauthorized", `HTTP ${status}`);
  if (status >= 300 && status < 400) return failed("refused", `HTTP ${status} redirect (not followed)`);
  if (status !== 200) return failed("refused", `HTTP ${status}`);
  if (reply.oversize) return failed("refused", `HTTP 200 body exceeds ${MAX_LISTING_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return failed("refused", "HTTP 200 body is not JSON");
  }
  const data = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || !data.every((m) => m !== null && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")) {
    return failed("refused", "HTTP 200 JSON carries no model id list");
  }
  const ids = [...new Set(data.map((m) => (m as { id: string }).id))].filter((id) => MODEL_ID_RE.test(id));
  return { status: "succeeded", models: ids.map((id) => ({ id, vendor: gatewayFamily(id) })) };
}

/** Doctor's gateway record: undefined, with NO request, when no gateway is detected. A failed listing is a
 *  record, never a throw. A target or record carrying the credential is withheld. */
export async function listGateway(cfg: CliproxyConfig, seam: GatewaySeam = {}): Promise<GatewayRecord | GatewayWithheld | undefined> {
  const target = detectGateway(cfg, seam);
  if (!target || "withheld" in target) return target;
  const headers: Record<string, string> = { accept: "application/json" };
  if (target.credential) {
    headers.authorization = `Bearer ${target.credential}`;
    headers["x-api-key"] = target.credential;
  }
  const timeoutMs = seam.timeoutMs ?? GATEWAY_LISTING_TIMEOUT_MS;
  let reply: GatewayReply;
  try {
    reply = await (seam.request ? seam.request(target.modelsUrl, headers, timeoutMs) : httpGet(target.modelsUrl, headers, timeoutMs, seam.lookup));
  } catch {
    reply = { kind: "error", code: "request error" };
  }
  const listing = classifyReply(reply, timeoutMs);
  const checkedAt = (seam.now?.() ?? new Date()).toISOString();
  const record: GatewayRecord = {
    host: target.host,
    baseUrl: target.baseUrl,
    source: target.source,
    listing: listing.status === "succeeded"
      ? { status: "succeeded", checkedAt }
      : { status: "failed", failure: listing.failure, reason: listing.reason, checkedAt },
    models: listing.status === "succeeded" ? listing.models : [],
    // Only a confirmed listing carries the rule: without a confirmed proxy every byte stays as at the base.
    ...(listing.status === "succeeded" && target.claudeHost ? { anthropicUnusable: { claudeHost: target.claudeHost } } : {}),
  };
  // At the sink: every field doctor.json and the printed line would carry. One hit and nothing is recorded.
  const fields = [record.host, record.baseUrl, record.listing.reason ?? "", ...record.models.map((m) => m.id), gatewayLine(record), ...overrideLine(record)];
  return fields.some((f) => carries(f, target.credential)) ? { withheld: "listing", source: target.source } : record;
}

const FAILURE_LABEL: Readonly<Record<GatewayFailure, string>> = { down: "down", timeout: "timed out", unauthorized: "unauthorized", refused: "refused" };

const WITHHELD_LABEL: Readonly<Record<GatewayWithheld["withheld"], string>> = {
  "request target": "the request target carries the gateway credential: no request sent",
  listing: "the listing carries the gateway credential: nothing recorded",
};

/** Doctor's one gateway line. A withheld gateway's line names no host, URL or id. */
export function gatewayLine(g: GatewayRecord | GatewayWithheld): string {
  if ("withheld" in g) return `gateway: withheld (${g.source}) — ${WITHHELD_LABEL[g.withheld]}`;
  const head = `gateway: ${g.host} (${g.source}) — `;
  if (g.listing.status === "failed") return `${head}${FAILURE_LABEL[g.listing.failure ?? "refused"]}: ${g.listing.reason ?? "unknown"}`;
  const count = (vendor: GatewayVendor | null) => g.models.filter((m) => m.vendor === vendor).length;
  return `${head}proxy, ${g.models.length} models: anthropic ${count("anthropic")} · google ${count("google")} · openai ${count("openai")} · xai ${count("xai")} · unclassified ${count(null)}`;
}

/** Writes `gateway` into doctor.json (last key), or removes a stale one (no gateway, or a withheld one).
 *  With no record and none on disk nothing is written, so doctor.json stays byte-identical to the base. */
export function recordGateway(repoRoot: string, outcome: GatewayRecord | GatewayWithheld | undefined): void {
  const record = outcome && "listing" in outcome ? outcome : undefined;
  const path = join(repoRoot, stateDirName(repoRoot), "doctor.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // writeDoctor just wrote this file; an unreadable one is re-probed by every reader anyway
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  // doctor.json's other keys are adapter ids, so an adapter may itself be named "gateway": its verdict
  // (it carries `installed`) is never removed or overwritten.
  // ponytail: such a host keeps no gateway record; a namespaced key if a real adapter ever takes the name
  const held = (raw as Record<string, unknown>).gateway;
  if (held !== null && typeof held === "object" && "installed" in held) return;
  if (!record && !("gateway" in raw)) return;
  const { gateway: _, ...rest } = raw as Record<string, unknown>;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record ? { ...rest, gateway: record } : rest, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── Vendor truth behind a confirmed proxy — queue row 392 R6 laws 3 and 6 (D-2187 add.11, add.17 (4), add.21 (3)) ──

/** Whether a gateway record serves a family: every family, except anthropic through an override the Claude CLI
 *  does not use. */
export const servesFamily = (record: GatewayRecord, family: GatewayVendor): boolean =>
  family !== "anthropic" || record.anthropicUnusable === undefined;

/** The confirmed proxy claude-code's models are served behind: the latest doctor's gateway record (doctor's
 *  outcome, or doctor.json's `gateway` key) whose listing succeeded and which serves the anthropic family —
 *  the Claude CLI goes through it. Anything else (no record, a withheld or failed one, an adapter verdict that
 *  happens to be named gateway, a differing override) confirms nothing, and every reading stays at the base. */
export function confirmedClaudeProxy(record: unknown): GatewayRecord | undefined {
  if (record === null || typeof record !== "object" || "installed" in record) return undefined;
  const r = record as Partial<GatewayRecord>;
  if (typeof r.host !== "string" || r.listing?.status !== "succeeded" || !Array.isArray(r.models)) return undefined;
  return servesFamily(r as GatewayRecord, "anthropic") ? r as GatewayRecord : undefined;
}

/** A claude-code channel's recorded vendor behind a confirmed proxy: the family of its recorded identity
 *  when the table classifies it — that beats a modelOverrides vendor. With NO recorded identity, a classified
 *  model id's own family (claude-opus-5-5 stays anthropic, so a configured claude seat keeps its vendor, tier
 *  and routability: the MUST-PASS control). undefined keeps the base reading: a recorded identity the table
 *  does not classify (never overridden by the id's family), or an unclassified id with no identity. */
export function proxiedClaudeVendor(model: string, identity: string | undefined): GatewayVendor | undefined {
  return gatewayFamily(identity ?? model) ?? undefined;
}

/** Behind a confirmed proxy doctor resolves EVERY configured claude-code model's identity: the store record
 *  record attributed to it by requestedModel first (an unattributed record is never evidence), then the
 *  stated-identity turn, accepting the model's own family or any family the table
 *  classifies (an alias the proxy maps to gemini- is seen). Anything else is unknown, never a throw. */
export function resolveProxiedClaudeIdentity(cwd: string, model: string, turn: ClaudeIdentityTurn = statedClaudeIdentity): string | undefined {
  const classified = (id: string) => gatewayFamily(id) !== null;
  const stored = readClaudeAliasIdentity(cwd, model, classified);
  if (stored) return stored;
  const stated = turn(cwd, model)?.trim();
  return stated && MODEL_ID_RE.test(stated) && (classified(stated) || belongsToAliasFamily(stated, model)) ? stated : undefined;
}

/** The credential the Claude CLI sends to its gateway (as detectGateway reads it), read again for sink checks
 *  only: never recorded. A withheld target still has one; detect:false, VITEST process inputs and a direct
 *  endpoint have none, so without a gateway every byte stays as at the base. */
export function gatewayCredential(cfg: CliproxyConfig = {}, seam: GatewaySeam = {}): string | undefined {
  if (cfg.cliproxy?.detect === false || vitestProcessInputs(seam.env, seam.settingsPath)) return undefined;
  const claude = claudeBaseUrl(seam.env, seam.settingsPath);
  return claude && gatewayHostOf(claude.baseUrl) ? credentialOf(claude.vars) : undefined;
}

/** Doctor's identity resolver behind a confirmed proxy. A resolved identity (store record or stated reply)
 *  that carries the gateway credential is unknown at the sink: never written to doctor.json, never printed. */
export function proxiedIdentityResolver(cfg: CliproxyConfig, seam: GatewaySeam = {}): (cwd: string, model: string) => string | undefined {
  const credential = gatewayCredential(cfg, seam);
  return (cwd, model) => {
    const identity = resolveProxiedClaudeIdentity(cwd, model, seam.identityTurn);
    return identity !== undefined && !carries(identity, credential) ? identity : undefined;
  };
}

/** The claude-code models doctor resolves an identity for behind a confirmed proxy: every configured one. */
export const proxiedIdentityModels = (cfg: Pick<TickmarkrConfig, "tiers">): string[] =>
  Object.keys(cfg.tiers["claude-code"]?.models ?? {});

function overrideLine(g: GatewayRecord): string[] {
  return g.anthropicUnusable
    ? [`gateway override ${g.host} differs from the Claude CLI endpoint ${g.anthropicUnusable.claudeHost} — anthropic models are not used through it`]
    : [];
}

/** Doctor's lines under the gateway line: the override transport line, then one ALIAS line per configured
 *  claude-code model whose recorded identity the table classifies outside the anthropic family behind the
 *  confirmed proxy. A record that is not confirmed adds nothing. */
export function gatewayNotes(
  outcome: GatewayRecord | GatewayWithheld | undefined,
  cfg: Pick<TickmarkrConfig, "tiers"> & CliproxyConfig,
  health: Readonly<Record<string, unknown>> | null | undefined,
  seam: GatewaySeam = {},
): string[] {
  if (!outcome || "withheld" in outcome || outcome.listing.status !== "succeeded") return [];
  const proxy = confirmedClaudeProxy(outcome);
  if (!proxy) return overrideLine(outcome);
  const overrides = cfg.tiers["claude-code"]?.modelOverrides ?? {};
  // At the sink: an ALIAS line carrying the gateway credential (an identity merged from an earlier report) is not printed.
  const credential = gatewayCredential(cfg, seam);
  return proxiedIdentityModels(cfg).flatMap((model) => {
    const identity = observedIdentity(health as Parameters<typeof observedIdentity>[0], "claude-code", model);
    const vendor = identity === undefined ? null : gatewayFamily(identity);
    if (identity === undefined || vendor === null || vendor === "anthropic") return [];
    const override = overrides[model]?.vendor;
    const line = `ALIAS: claude-code:${model} is served as ${identity} (${vendor}) by gateway ${proxy.host} — recorded vendor ${vendor}${override !== undefined && override !== vendor ? `, not the configured ${override}` : ""}`;
    return carries(line, credential) ? [] : [line];
  });
}

// ── Credential containment at the sinks — queue row 392 R6 (D-2187 add.11): the gateway credential never
//    appears in doctor.json or a printed line ──

/** A doctor.json entry dropped at the sink for carrying the gateway credential, named by its key path and never
 *  by its value. `identity` is a recorded identity: modelAuth's, or the modelIdentities fallback. */
export type CredentialWithheld = { withheld: "identity"; adapter: string; model: string } | { withheld: "entry"; path: string };

/** A value with every entry whose key or string value carries the credential dropped, and those entries' paths. */
function contained(value: unknown, credential: string, path: string[]): { value?: unknown; dropped: string[][] } {
  if (typeof value === "string") return carries(value, credential) ? { dropped: [path] } : { value, dropped: [] };
  if (value === null || typeof value !== "object") return { value, dropped: [] };
  const parts = Object.entries(value).map(([key, v]) =>
    [key, carries(key, credential) ? { dropped: [[...path, key]] } : contained(v, credential, [...path, key])] as const);
  const kept = parts.filter(([, c]) => "value" in c).map(([key, c]) => [key, c.value] as const);
  return { value: Array.isArray(value) ? kept.map(([, v]) => v) : Object.fromEntries(kept), dropped: parts.flatMap(([, c]) => c.dropped) };
}

function withheldOf(path: string[], credential: string): CredentialWithheld {
  const [adapter, field, model, leaf] = path;
  const identity = (field === "modelAuth" && leaf === "identity" && path.length === 4) || (field === "modelIdentities" && path.length === 3);
  return identity && !path.some((s) => carries(s, credential))
    ? { withheld: "identity", adapter, model }
    : { withheld: "entry", path: path.map((s) => (carries(s, credential) ? "<withheld key>" : s)).join(".") };
}

/** At the doctor.json sink: the FINAL report — after any scoped merge, so retained modelAuth identities and
 *  modelIdentities fallbacks included — with every entry whose key or string value carries the gateway
 *  credential (raw, percent-decoded, NFKC-normalized or case-folded) dropped. A dropped identity reads as
 *  unrecorded, so the base vendor reading applies. No credential or no hit: the same report, byte-identical. */
export function containReport<T extends object>(report: T, credential: string | undefined): { report: T; withheld: CredentialWithheld[] } {
  if (!credential) return { report, withheld: [] };
  const { value, dropped } = contained(report, credential, []);
  return dropped.length ? { report: value as T, withheld: dropped.map((p) => withheldOf(p, credential)) } : { report, withheld: [] };
}

/** writeDoctor's default sink: the process's own gateway credential (none under VITEST without seams), only when
 *  the report's own gateway record is a confirmed proxy. Without one every byte stays as at the base. */
export const containDoctorReport = <T extends object>(report: T, seam: GatewaySeam = {}): T =>
  confirmedClaudeProxy((report as Record<string, unknown>).gateway) ? containReport(report, gatewayCredential({}, seam)).report : report;

/** Doctor's typed note for a dropped entry: it names the entry, never the value. */
export function credentialWithheldLine(w: CredentialWithheld): string {
  return w.withheld === "identity"
    ? `credential withheld: the recorded identity of ${w.adapter}:${w.model} carries the gateway credential — not written to doctor.json, it reads as unrecorded`
    : `credential withheld: doctor.json entry ${w.path} carries the gateway credential — not written`;
}

/** At the printed sink: every line carrying the gateway credential is dropped, and one typed note counts them. */
export function containLines(text: string, credential: string | undefined): string {
  if (!credential) return text;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !carries(line, credential));
  return kept.length === lines.length ? text
    : [...kept, `credential withheld: ${lines.length - kept.length} doctor line(s) carrying the gateway credential not printed`].join("\n");
}
