import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TickmarkrConfig } from "../config/config.js";
import { modelLints, suggestOverlay } from "./model-lints.js";
import { HerdrDriver } from "../drivers/herdr.js";
import { tickmarkrDir, stateDirName } from "../graph/graph.js";
import { disallowedBy, excludedChannels, exclusionLine, type PreferenceRole, preferRanks } from "../route/preference.js";
import { sh } from "../run/git.js";
import { FakeAdapter } from "./fake.js";
import { parseWorkerResult } from "./prompt.js";
import { sealHerdrEnv } from "../drivers/subprocess.js";
import {
  catalogEntries, isNativeCliDrive, projectCliEntries, SHIPPED_CLI_CATALOG,
  type CatalogEntriesOptions, type CliEntry, type DeclarativeCliDrive, type ModelIdField,
} from "./catalog.js";
import {
  type AuthHealth, type BillingChannel, channelKey, channelsFromConfig, type ModelAuth,
  modelAuthed, MODEL_ID_RE, MODEL_PROBE_ERRORS, type ModelProbeError, QUOTA_RE, shq, type WorkerAdapter,
} from "./types.js";

// Compatibility projection for callers/tests that only need shipped advisory names. The literal
// list is gone: both advisory and routable catalog views derive from SHIPPED_CLI_CATALOG. Native
// definitions (claudeCode, codex, cursorAgent, opencode, pi, grok, kimi) are owned by catalog.ts;
// this registry consumes their drive contracts instead of restating their registration order.
export const CANDIDATE_CLI_CATALOG: readonly string[] = SHIPPED_CLI_CATALOG
  .filter((entry) => entry.drive === undefined)
  .map((entry) => entry.binary);
const SHIPPED_NATIVE_ADAPTERS = new Set(
  SHIPPED_CLI_CATALOG.flatMap((entry) => isNativeCliDrive(entry.drive) ? [entry.drive.adapter] : []),
);

const declarativeBinaries = new WeakMap<WorkerAdapter, string>();

// OBS-304: this was a hand-maintained mirror of the registered binaries, and the guard test that
// forbids catalog overlap checked against IT rather than against the adapters — so when kimi gained
// an adapter and nobody updated the copy, the guard kept passing on a collision it existed to catch.
// Derive it. A list that restates another list is the defect, not the entry that fell out of sync.
export function registeredAdapterBinaries(adapters: WorkerAdapter[] = allAdapters()): string[] {
  return adapters.map((a) => a.hardcodedFlags?.binary ?? declarativeBinaries.get(a)).filter((b): b is string => !!b);
}

// OBS-117: worker panes run commands through `bash -lc` (SubprocessDriver + sh()), not bare spawnSync(bin).
// Doctor must resolve adapter binaries the same way so a shadow install on PATH cannot disagree with dispatch.
function shellSpawnSync(cmd: string, cwd: string, timeoutMs = 10000): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    cwd,
    timeout: timeoutMs,
    env: sealHerdrEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

export function resolveShellBinary(bin: string, cwd = process.cwd(), pathEnv?: string): { resolved?: string; all: string[] } {
  // An explicit PATH is a deterministic fixture/operator boundary. The default remains the same
  // login-shell environment used by dispatched workers (OBS-117).
  const pathPrefix = pathEnv === undefined ? "" : `export PATH=${shq(pathEnv)}; `;
  const r = shellSpawnSync(`${pathPrefix}type -a ${shq(bin)} 2>/dev/null | sed -n 's/^.* is \\(.*\\)$/\\1/p'`, cwd);
  const hits = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  // OBS-304: a duplicated PATH entry makes `type -a` emit the SAME path twice, which doctor then
  // reported as "2 installs on PATH — …/claude, …/claude". Count distinct real files, so the real
  // shadows (codex: homebrew + nvm) stop being buried in noise. realpath resolves symlinked twins.
  const seen = new Set<string>();
  const all = hits.filter((p) => {
    let key = p;
    try {
      key = realpathSync(p);
    } catch { /* unreadable or dangling — fall back to the literal path */ }
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { resolved: all[0], all };
}

export function probeVersionShell(bin: string, cwd = process.cwd()): AuthHealth & { binaryPaths?: string[] } {
  const { resolved, all } = resolveShellBinary(bin, cwd);
  if (!resolved) return { installed: false, authed: false, models: [] };
  const r = shellSpawnSync(`${shq(resolved)} --version`, cwd);
  if (r.code !== 0) {
    // OBS-503: a resolved binary whose --version CRASHES under the worker shell is not "not
    // installed" — a stale node on the login-shell PATH (bash -lc re-derives PATH) crashes every
    // `#!/usr/bin/env node` CLI at dispatch while the operator's interactive shell runs it fine.
    // installed stays false (dispatch runs through this same shell and would crash identically —
    // fail closed), but the note names the real failure so doctor never prints a lie.
    const reason = `${r.stderr}\n${r.stdout}`.replace(/\s+/g, " ").trim();
    return {
      installed: false,
      authed: false,
      models: [],
      binaryPaths: all,
      note: `found at ${resolved} but \`--version\` exited ${r.code} under the worker shell (bash -lc)${reason ? ` — ${reasonTail(reason)}` : ""}`,
    };
  }
  return {
    installed: true,
    authed: true,
    version: (r.stdout || r.stderr).trim().split("\n")[0],
    models: [],
    note: "auth assumed; verified at dispatch (failover on auth/quota errors)",
    binaryPaths: all,
  };
}

export function binaryShadowWarnings(
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
  cwd = process.cwd(),
  resolve?: (bin: string, cwd: string) => { resolved?: string; all: string[] },
): string[] {
  const resolveFn = resolve ?? resolveShellBinary;
  const out: string[] = [];
  for (const a of adapters) {
    const bin = a.hardcodedFlags?.binary;
    if (!bin || !health[a.id]?.installed) continue;
    const { resolved, all } = resolveFn(bin, cwd);
    if (all.length <= 1) continue;
    out.push(`binary shadow: ${a.id} resolves to ${resolved ?? bin} but ${all.length} installs on PATH — ${all.join(", ")}`);
  }
  return out;
}

function modelListValidated(h: AuthHealth | undefined): boolean {
  return !!h?.modelsDetectedAt && Array.isArray(h.models);
}

export function invalidConfiguredModels(cfg: TickmarkrConfig, adapterId: string, h: AuthHealth | undefined): string[] {
  if (!modelListValidated(h)) return [];
  const listed = new Set(h!.models);
  const configured = Object.keys(cfg.tiers[adapterId]?.models ?? {});
  // Fail open until the CLI list intersects at least one configured model — proves the list is authoritative
  // for this adapter's tier namespace (MODEL-04: unrelated detected ids must not invalidate routing).
  if (!configured.some((m) => listed.has(m))) return [];
  return configured.filter((m) => !listed.has(m));
}

export function modelAliasExclusions(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
): { key: string; adapter: string; model: string }[] {
  const out: { key: string; adapter: string; model: string }[] = [];
  for (const a of adapters) {
    const h = health[a.id];
    if (!h?.installed || !h?.authed) continue;
    for (const model of invalidConfiguredModels(cfg, a.id, h)) {
      out.push({ key: channelKey({ adapter: a.id, model }), adapter: a.id, model });
    }
  }
  return out;
}

export function modelAliasLine(excluded: { key: string; adapter: string; model: string }[]): string {
  const parts = excluded.map(({ key, adapter }) => `${key} (not in ${adapter}'s reported model list)`);
  return `model alias: ${excluded.length} channel(s) invalid — ${parts.join(", ")}`;
}

export type CandidateCliDetection = { binary: string; path: string };

// Herdr's supported-kind help is nomination data only. Parse the closed token list and discard
// everything else before any name can reach a shell resolver.
export function parseHerdrCliNames(help: string): string[] {
  const body = /\[possible values:\s*([^\]]+)\]/m.exec(help)?.[1] ?? "";
  return [...new Set(body.split(",").map((name) => name.trim()).filter((name) => /^[a-z0-9-]+$/.test(name)))];
}

export function herdrNominatedCliNames(cwd = process.cwd(), pathEnv?: string): string[] {
  // This asks a known driver binary for static help. It is deliberately NOT gated on
  // HerdrDriver.available(), which reports HERDR_ENV rather than binary presence.
  const { resolved } = resolveShellBinary("herdr", cwd, pathEnv);
  if (!resolved) return [];
  const r = shellSpawnSync(`${shq(resolved)} agent start --help`, cwd);
  return r.code === 0 ? parseHerdrCliNames(`${r.stdout}\n${r.stderr}`) : [];
}

export interface DetectCandidateCliOptions extends CatalogEntriesOptions {
  cwd?: string;
  pathEnv?: string;
  entries?: readonly CliEntry[];
  adapters?: WorkerAdapter[];
  resolveBinary?: (binary: string) => { resolved?: string; all: string[] };
}

export function detectCandidateClis(opts: DetectCandidateCliOptions = {}): CandidateCliDetection[] {
  const cwd = opts.cwd ?? process.cwd();
  const entries = opts.entries ?? catalogEntries({
    shipped: opts.shipped,
    operatorYaml: opts.operatorYaml,
    operatorPath: opts.operatorPath,
    herdrNames: opts.herdrNames ?? herdrNominatedCliNames(cwd, opts.pathEnv),
  });
  const registered = new Set(registeredAdapterBinaries(opts.adapters ?? allAdapters({ cliEntries: entries })));
  const advisory = projectCliEntries(entries).advisory.filter((entry) => !registered.has(entry.binary));
  const resolveBinary = opts.resolveBinary
    ?? ((binary: string) => resolveShellBinary(binary, cwd, opts.pathEnv));
  const discovered = [] as CandidateCliDetection[];
  for (const entry of advisory) {
    const { resolved } = resolveBinary(entry.binary);
    if (resolved) discovered.push({ binary: entry.binary, path: resolved });
  }
  return discovered;
}

export function formatCandidateCliRow({ binary, path }: CandidateCliDetection): string {
  return `  ! ${binary.padEnd(14)} detected at ${path} (no drive contract — not routable)`;
}

// v1.65 T3: bounded, error/status-checked and fail-open. Unlike candidate detection above, this
// executes only registered adapter binaries with drive contracts. undefined = unavailable/broken,
// so no drift verdict piles onto the existing auth report.
export function probeHelpText(bin: string): string | undefined {
  try {
    const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 10000 });
    if (r.error || r.status !== 0) return undefined;
    return `${r.stdout || ""}\n${r.stderr || ""}`;
  } catch {
    return undefined;
  }
}

// Whole-token match only: "-p" must never count as present because "--print" contains it, and
// "--output" must not match a listed "--output-format". Splitting on non-flag chars keeps each
// help-listed flag intact as one token ("-p, --print <fmt>" → "-p", "--print", "fmt").
export function missingDeclaredFlags(helpText: string, flags: string[]): string[] {
  const tokens = new Set(helpText.split(/[^A-Za-z0-9_-]+/));
  return flags.filter((f) => !tokens.has(f));
}

// v1.65 T3: advisory hardcoded-flag drift check. Reads help, mutates nothing — health, doctor.json,
// discoverChannels, and routing never see these strings; they are doctor display rows only.
export function flagDriftWarnings(
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
  helpOf: (bin: string) => string | undefined = probeHelpText,
): string[] {
  const out: string[] = [];
  for (const a of adapters) {
    const decl = a.hardcodedFlags;
    if (!decl || !health[a.id]?.installed) continue;
    const help = helpOf(decl.binary);
    if (help === undefined) continue;
    for (const flag of missingDeclaredFlags(help, decl.flags)) {
      out.push(`flag drift: ${a.id} hardcodes ${flag} but ${decl.binary} --help no longer lists it (advisory — routing unchanged)`);
    }
  }
  return out;
}

function renderDriveTemplate(template: string, promptFile: string, model: string): string {
  return template.replaceAll("{promptFile}", shq(promptFile)).replaceAll("{model}", shq(model));
}

function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((cursor, part) => {
    if (!cursor || typeof cursor !== "object") return undefined;
    return (cursor as Record<string, unknown>)[part];
  }, value);
}

// v1.87 T4: the projection reports WHY it is empty. Malformed JSON, a wrong path, a wrong field and
// values the id-format filter rejects all used to return one indistinguishable [], so a misspelled
// selector read exactly like the CLI having no models — the operator cannot tell a typo from a defect.
export interface DeclaredModels {
  models: string[];
  reason?: string;
}

export function parseDeclaredModels(
  raw: string,
  parser: "lines" | "pi-table" | "json",
  path?: string,
  field?: ModelIdField,
): DeclaredModels {
  let values: unknown[];
  if (parser === "json") {
    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
      return { models: [], reason: "malformed JSON: the output did not parse" };
    }
    const selected = valueAtPath(root, path);
    if (!Array.isArray(selected)) {
      return { models: [], reason: `no array at ${path ? `path "${path}"` : "the JSON root"}` };
    }
    // One key per entry, and only the configured one — and `ModelIdField` is an id-key allowlist, so
    // `cost` and `provider` are not spellable here: no price, no vendor, no whole object.
    values = field === undefined
      ? selected
      : selected.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)[field]
        : undefined);
    if (selected.length > 0 && !values.some((value) => typeof value === "string")) {
      return {
        models: [],
        reason: field === undefined
          ? `${selected.length} entries are not id strings and no field is configured`
          : `no string field "${field}" on any of the ${selected.length} entries`,
      };
    }
  } else if (parser === "pi-table") {
    const lines = raw.trim().split("\n");
    const header = lines.findIndex((line) => /^provider\s+model\b/i.test(line.trim()));
    // OBS-506: a missing header previously fell through to a REASONLESS empty result, so the
    // "never silently" warning below the parser could not fire — prime-agent's stderr-routed
    // table produced a silent zero for a whole doctor run. An absent table names itself.
    if (header === -1) {
      return { models: [], reason: `no \`provider model …\` table header in ${raw.trim() ? `${lines.length} line(s) of output` : "empty output"}` };
    }
    values = lines.slice(header + 1).map((line) => {
      const [provider, model] = line.trim().split(/\s+/);
      return provider && model ? `${provider}/${model}` : "";
    });
  } else {
    values = raw.split("\n").map((line) => line.trim());
  }
  // Blanks are structural padding in every parser (trailing newline, headerless table row), never a
  // rejected id — counting them would make "all values rejected" fire on a healthy list.
  const candidates = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  const models = [...new Set(candidates.filter((value) => MODEL_ID_RE.test(value)))];
  if (models.length === 0 && candidates.length > 0) {
    return { models, reason: `all ${candidates.length} listed values were rejected by the model-id format` };
  }
  return { models };
}

function declarativeAdapter(entry: CliEntry & { drive: DeclarativeCliDrive }): WorkerAdapter {
  const drive = entry.drive;
  const adapter: WorkerAdapter = {
    id: entry.id,
    vendor: entry.vendor!,
    probe: async () => {
      const health = probeVersionShell(entry.binary);
      if (!health.installed) return health;
      const version = health.version ?? "";
      if (!new RegExp(entry.identity).test(version)) {
        return {
          installed: true,
          authed: false,
          version,
          models: [],
          note: `identity mismatch for ${entry.binary}`,
          binaryPaths: health.binaryPaths,
        };
      }
      return health;
    },
    channels: (cfg) => channelsFromConfig(entry.id, cfg),
    // v1.89 T1 / OBS-414: straight from the validated drive contract — no default and no fallback,
    // which is the only way this factory cannot reintroduce the optionality the type just removed.
    trustDialog: drive.trustDialog,
    headlessCommand: (promptFile, model) => renderDriveTemplate(drive.headless, promptFile, model),
    interactiveCommand: (promptFile, model) => drive.interactive === null
      ? null
      : renderDriveTemplate(drive.interactive, promptFile, model),
    invoke(_task, _cwd, assignment, ctx) {
      return { command: this.headlessCommand(ctx.promptFile, assignment.model) };
    },
    parse: parseWorkerResult,
    ...(drive.listModels ? {
      listModels: async () => {
        const { resolved } = resolveShellBinary(entry.binary);
        if (!resolved) return [];
        const cmd = [shq(resolved), ...drive.listModels!.argv.map(shq)].join(" ");
        const result = shellSpawnSync(cmd, process.cwd(), 15000);
        if (result.code !== 0) return [];
        const { models, reason } = parseDeclaredModels(
          // OBS-506: prime-agent prints its model table to STDERR (stdout 0 bytes, live-verified
          // 2026-08-13) — the same stream convention probeVersionShell already tolerates for
          // version banners. Fall back only when stdout is EMPTY, never merge the streams.
          result.stdout.trim() ? result.stdout : result.stderr,
          drive.listModels!.parser,
          drive.listModels!.path,
          drive.listModels!.field,
        );
        // Listing stays advisory (fail-open to []), but never silently: an empty projection names why.
        if (models.length === 0 && reason) console.warn(`tickmarkr: ${entry.id} listed no models — ${reason}`);
        return models;
      },
    } : {}),
  };
  declarativeBinaries.set(adapter, entry.binary);
  return adapter;
}

export function adaptersFromCliEntries(entries: readonly CliEntry[]): WorkerAdapter[] {
  return projectCliEntries(entries).routable.map((entry) => {
    if (isNativeCliDrive(entry.drive)) return entry.drive.adapter;
    return declarativeAdapter(entry as CliEntry & { drive: DeclarativeCliDrive });
  });
}

export interface AllAdaptersOptions {
  fakeScriptPath?: string;
  cliEntries?: readonly CliEntry[];
  operatorYaml?: string | null;
  operatorPath?: string | false;
}

export function allAdapters(opts: AllAdaptersOptions = {}): WorkerAdapter[] {
  const entries = opts.cliEntries ?? catalogEntries({
    operatorYaml: opts.operatorYaml,
    operatorPath: opts.operatorPath,
    herdrNames: [],
  });
  const real = adaptersFromCliEntries(entries);
  const fakePath = opts.fakeScriptPath ?? process.env.TICKMARKR_FAKE_SCRIPT;
  return fakePath ? [new FakeAdapter(fakePath), ...real] : real;
}

export function getAdapter(id: string, adapters: WorkerAdapter[]): WorkerAdapter {
  const a = adapters.find((a) => a.id === id);
  if (!a) throw new Error(`unknown adapter ${id} (have: ${adapters.map((a) => a.id).join(", ")})`);
  return a;
}

export async function probeAll(adapters: WorkerAdapter[], opts: { cwd?: string } = {}): Promise<Record<string, AuthHealth>> {
  const cwd = opts.cwd ?? process.cwd();
  const out: Record<string, AuthHealth> = {};
  await Promise.all(adapters.map(async (a) => {
    let h = await a.probe();
    const bin = a.hardcodedFlags?.binary;
    if (bin) {
      const shell = probeVersionShell(bin, cwd);
      h = { ...h, installed: shell.installed, version: shell.version ?? h.version };
      // OBS-503: the shell probe's note replaces the adapter probe's own — keeping a bare-spawn
      // success note ("auth verified via …") next to installed:false stores a self-contradiction.
      if (!shell.installed) h = { ...h, installed: false, authed: false, note: shell.note };
    }
    out[a.id] = h;
  }));
  return out;
}

const MODEL_PROBE_PROMPT = "Reply with exactly OK and nothing else.";
// 60s: a healthy MCP-free codex probe measured 29.9s round-trip (2026-07-15) — 30s had zero headroom.
const MODEL_PROBE_TIMEOUT_MS = 60000;
// Auth-words only match when tied to a failure word; bare "auth"/"OAuth"/"authored" never fail (v1.27 T2).
// OBS-150: the 4xx alternative must refuse digit-group context. Bare `\b4\d\d\b` matched "485" inside the
// token footer "tokens used 26,485" and failed a HEALTHY probe closed — a ~1-in-10 dice roll on EVERY model
// probe of any adapter that prints a comma-grouped token count. Lookarounds reject a group that is part of a
// larger number (26,485 · 1.400 · 400.5) while keeping real bare codes (401 · "error 429" · "403 Forbidden."
// — trailing sentence punctuation still matches, only a following DIGIT means "decimal, not status code").
const AUTH_FAILURE_RE = /\b(?<![\d.,])4\d\d\b(?![.,]\d)|\bauth(?:entication|orization)?\s+(?:error|failed|failure|denied)|unauthori[sz]ed|forbidden|access denied|credit(?:s)?\s+(?:exhausted|error|denied)/i;

const PROBE_REASON_CAP = 240;

// v1.55 T3: the tail must open at a word boundary — a mid-word slice ("odel 'grok-…'") reads as
// corruption in operator-facing diagnostics. Input is already space-normalized, so " " is the only
// boundary. A tail that is one unbroken token keeps its mid-word cut rather than storing nothing.
function reasonTail(output: string): string {
  if (output.length <= PROBE_REASON_CAP) return output;
  const tail = output.slice(-PROBE_REASON_CAP);
  if (output[output.length - PROBE_REASON_CAP - 1] === " ") return tail;
  const sp = tail.indexOf(" ");
  return sp === -1 ? tail : tail.slice(sp + 1);
}

function probeFailure(
  code: number,
  stdout: string,
  stderr: string,
  timedOut?: boolean,
  timeoutMs = MODEL_PROBE_TIMEOUT_MS,
): string | undefined {
  // SIGKILL-timeout is not exit-1: report the budget, never the masked kill code (v1.27 T1).
  if (timedOut) return `probe timed out after ${timeoutMs}ms`;
  const output = `${stderr}\n${stdout}`.trim().replace(/\s+/g, " ");
  // OBS-72: TAIL, not head — the error lands at the END of CLI output; a head slice stores only the
  // startup banner and hid the real "Not inside a trusted directory" failure for a day.
  return code !== 0 || QUOTA_RE.test(output) || AUTH_FAILURE_RE.test(output)
    ? reasonTail(output) || `probe exited ${code}`
    : undefined;
}

const PROBE_ERROR_RE = new RegExp(`\\b(${MODEL_PROBE_ERRORS.join("|")})\\b`);
function probeError(code: number, stdout: string, stderr: string, timedOut?: boolean): ModelProbeError | undefined {
  if (timedOut || code === 0) return undefined;
  return PROBE_ERROR_RE.exec(`${stderr}\n${stdout}`)?.[1] as ModelProbeError | undefined;
}

export type ProbeModelStatus = "ok" | "timeout" | "failed";
export type ProbeModelProgress = (adapter: string, model: string, status: ProbeModelStatus, durationMs: number) => void;

type ProbedModelAuth = ModelAuth & { durationMs: number };

const probeModelStatus = (v: ProbedModelAuth): ProbeModelStatus =>
  v.authed ? "ok" : v.reason?.includes("timed out") ? "timeout" : "failed";

// v1.21: one bounded, headless call per configured model; detected-but-unclassified models never enter this loop.
export async function probeModels(
  cfg: TickmarkrConfig,
  repoRoot: string,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
  onProgress?: ProbeModelProgress,
): Promise<void> {
  // T2: a prior doctor.json timeout verdict for this model skips the retry — a persistently dead
  // model (e.g. opencode glm-5.2) costs one 30s attempt instead of two every run.
  const priorHealth = readDoctor(repoRoot);
  await Promise.all(adapters.map(async (a) => {
    const h = health[a.id];
    if (!h?.installed) return;
    // Tests inject FakeAdapter; never let an incidental default adapter spend a real token in the suite.
    if (process.env.VITEST && SHIPPED_NATIVE_ADAPTERS.has(a)) return;
    const priorModelAuth = priorHealth?.[a.id]?.modelAuth;
    const runProbes = async (probeRoot: string) => {
      const verdicts: Record<string, ProbedModelAuth> = {};
      const store = (model: string, verdict: ProbedModelAuth) => {
        verdicts[model] = verdict;
        onProgress?.(a.id, model, probeModelStatus(verdict), verdict.durationMs);
      };
      // One bounded probe call. verdict:null = a first-pass failure that earns the one serial retry
      // (OBS-72: a failure inside the concurrent batch is indistinguishable from adapter self-contention
      // until re-probed alone); a retry attempt always returns a final verdict.
      const attempt = async (model: string, retry?: { firstTimedOut: boolean }): Promise<{ verdict: ProbedModelAuth | null; timedOut: boolean }> => {
        const t0 = Date.now();
        const probedAt = new Date().toISOString();
        const v = (authed: boolean, reason?: string, error?: ModelProbeError): ProbedModelAuth =>
          ({ authed, ...(reason !== undefined ? { reason } : {}), ...(error ? { probeError: error } : {}), probedAt, durationMs: Date.now() - t0 });
        try {
          if (typeof a.headlessCommand !== "function") return { verdict: v(false, "headless probe unavailable"), timedOut: false };
          const promptDir = mkdtempSync(join(tmpdir(), "tickmarkr-auth-"));
          try {
            const promptFile = join(promptDir, "probe.md");
            writeFileSync(promptFile, MODEL_PROBE_PROMPT);
            const r = await sh(a.headlessCommand(promptFile, model), probeRoot, MODEL_PROBE_TIMEOUT_MS);
            // T2 rule unchanged: a prior doctor.json timeout skips the retry — a persistently dead
            // model (e.g. opencode glm-5.2) costs one attempt instead of two every run.
            if (r.timedOut && !retry && priorModelAuth?.[model]?.reason?.includes("timed out") === true) {
              return { verdict: v(false, `probe timed out (repeat — retry skipped) (${MODEL_PROBE_TIMEOUT_MS}ms)`), timedOut: true };
            }
            const reason = probeFailure(r.code, r.stdout, r.stderr, r.timedOut, MODEL_PROBE_TIMEOUT_MS);
            if (!reason) return { verdict: v(true), timedOut: false };
            if (!retry) return { verdict: null, timedOut: r.timedOut === true };
            const error = probeError(r.code, r.stdout, r.stderr, r.timedOut);
            return {
              verdict: error
                ? v(priorModelAuth?.[model]?.authed === true, undefined, error)
                : r.timedOut && retry.firstTimedOut ? v(false, `probe timed out twice (${MODEL_PROBE_TIMEOUT_MS}ms)`) : v(false, reason),
              timedOut: r.timedOut === true,
            };
          } finally {
            rmSync(promptDir, { recursive: true, force: true });
          }
        } catch (e) {
          return { verdict: retry ? v(false, String(e)) : null, timedOut: false };
        }
      };
      // models probe concurrently too (v1.33.5) — sequential chains made init wall time Σ(models×60s)
      // on the slowest adapter (measured 96s); each probe is one tiny prompt, safe to overlap.
      // Capped at MODEL_PROBE_CONCURRENCY per adapter unless the adapter declares its own cap
      // (codex: 1 — OBS-72, its concurrent probes self-contend in one repo).
      const retries: { model: string; firstTimedOut: boolean }[] = [];
      await mapLimit(Object.keys(cfg.tiers[a.id]?.models ?? {}), a.probeConcurrency ?? MODEL_PROBE_CONCURRENCY, async (model) => {
        const first = await attempt(model);
        if (first.verdict) store(model, first.verdict);
        else retries.push({ model, firstTimedOut: first.timedOut });
      });
      // OBS-72: re-probe each first-pass failure once with ONE probe in flight, only after the
      // concurrent batch drained — an in-slot retry still races its concurrency partner. Success here
      // was contention; a second failure is the real verdict. Successful first-pass probes stored
      // above and never wait; cost is one extra call per genuinely dead model only.
      for (const { model, firstTimedOut } of retries) {
        const second = await attempt(model, { firstTimedOut });
        if (second.verdict) store(model, second.verdict);
      }
      h.modelAuth = verdicts;
    };
    if (a.probeCwd !== "neutral") return runProbes(repoRoot);
    const probeRoot = mkdtempSync(join(tmpdir(), "tickmarkr-probe-"));
    try {
      await runProbes(probeRoot);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }));
}

// T2: caps concurrent probes per adapter at 2 — v1.33.5 regression, 4 concurrent codex exec in one
// repo made ALL 4 time out where sequential passed 2/4 (suspected CLI self-contention).
// v1.52 T4: default only — an adapter's own probeConcurrency declaration wins (codex: 1).
const MODEL_PROBE_CONCURRENCY = 2;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const doctorPath = (repoRoot: string) => join(repoRoot, stateDirName(repoRoot), "doctor.json");

function readDoctorFile(repoRoot: string): Record<string, unknown> | null {
  try {
    return existsSync(doctorPath(repoRoot)) ? JSON.parse(readFileSync(doctorPath(repoRoot), "utf8")) : null;
  } catch {
    // A torn cache is disposable: callers already re-probe when this returns null.
    return null;
  }
}

export function writeDoctor(repoRoot: string, health: Record<string, AuthHealth>): void {
  tickmarkrDir(repoRoot);
  const path = doctorPath(repoRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(health, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readDoctor(repoRoot: string): Record<string, AuthHealth> | null {
  const raw = readDoctorFile(repoRoot);
  if (!raw) return null;
  // pre-v1.86 caches may still carry an `autoPrefer` key — strip it; the mechanism is deleted and
  // the key is never read back into health.
  const { autoPrefer: _, ...health } = raw;
  return health as Record<string, AuthHealth>;
}

// v1.87 T2: `role` is optional and defaults to "worker", so every pre-existing two/three-argument
// call keeps its exact present behaviour — the worker pool. A non-worker role reads the SAME fleet
// through its own deny scope: a worker-only deny (routing.deny.workers) benches a channel for
// dispatch while leaving it eligible to judge, review or consult the work.
export function discoverChannels(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
  role: PreferenceRole = "worker",
): BillingChannel[] {
  const base = adapters
    .filter((a) => health[a.id]?.installed && health[a.id]?.authed)
    .flatMap((a) => {
      const h = health[a.id];
      const s = h?.servable;
      const invalid = new Set(invalidConfiguredModels(cfg, a.id, h));
      // T2 (2026-07-13): only a model doctor marked authed (modelAuth[model].authed===true) advertises a
      // channel — routing an unknown or 403 into dispatch is fail-closed. Operators with pre-v1.21 doctor.json
      // can opt into the prior unknown-is-routable behavior with routing.allowUnverifiedModels.
      // OBS-117: configured aliases absent from the adapter CLI's own model list are not dispatchable.
      return a.channels(cfg).filter((c) => !invalid.has(c.model) && modelAuthed(h, c.model, cfg.routing.allowUnverifiedModels) && (!s || s.includes(c.model)));
    });
  if (!cfg.routing.allow && !cfg.routing.deny) return base;
  return base.filter((c) => disallowedBy(c, cfg.routing, role) === null);
}

// v1.87 T2: the role-scoped pool builder. One doctor probe, one discovery pass per role — so the
// daemon hands each seat the pool its own policy allows instead of handing everyone the worker list.
export const PREFERENCE_ROLES = ["worker", "judge", "review", "consult"] as const;

export function rolePools(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
): Record<PreferenceRole, BillingChannel[]> {
  return Object.fromEntries(
    PREFERENCE_ROLES.map((role) => [role, discoverChannels(cfg, adapters, health, role)]),
  ) as Record<PreferenceRole, BillingChannel[]>;
}

// HYG-07(a): the channels discoverChannels silently dropped because their model isn't in the adapter's
// served list (the HYG-05 filter above). Computed from the SAME inputs as the drop (a.channels(cfg), not
// channelsFromConfig — FakeAdapter overrides channels()), so attribution can never drift from behavior.
// installed+authed+servable-defined mirrors the filter's three gates exactly.
export function servableExclusions(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
): { key: string; adapter: string }[] {
  const out: { key: string; adapter: string }[] = [];
  for (const a of adapters) {
    const h = health[a.id];
    if (!h?.installed || !h?.authed || !h.servable) continue;
    for (const c of a.channels(cfg)) {
      if (!h.servable.includes(c.model)) out.push({ key: channelKey(c), adapter: a.id });
    }
  }
  return out;
}

// HYG-07(a): exclusionLine() voice — the operator already parses this vocabulary in plan+doctor.
export function servabilityLine(excluded: { key: string; adapter: string }[]): string {
  const parts = excluded.map(({ key, adapter }) => `${key} (not in ${adapter}'s served model list)`);
  return `servability: ${excluded.length} channel(s) unservable — ${parts.join(", ")}`;
}

// T2 (2026-07-13): channels discoverChannels dropped because doctor marked their model unauthed or left it
// unverified. Computed from the SAME inputs as the drop (a.channels(cfg)) so attribution can never drift from
// behavior. installed+authed mirrors the discoverChannels adapter gate.
export function modelAuthExclusions(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
): { key: string; adapter: string; reason: string; probedAt: string }[] {
  const out: { key: string; adapter: string; reason: string; probedAt: string }[] = [];
  for (const a of adapters) {
    const h = health[a.id];
    if (!h?.installed || !h?.authed) continue;
    for (const c of a.channels(cfg)) {
      const v = h.modelAuth?.[c.model];
      if (modelAuthed(h, c.model, cfg.routing.allowUnverifiedModels)) continue;
      if (v?.authed === false) out.push({ key: channelKey(c), adapter: a.id, reason: v.probeError ? `probe-error (${v.probeError})` : v.reason ?? "probe failed", probedAt: v.probedAt });
      else out.push({ key: channelKey(c), adapter: a.id, reason: "no model auth verdict — run tickmarkr doctor", probedAt: "not recorded" });
    }
  }
  return out;
}

// T2: one lint per exclusion, naming the probe reason and date (acceptance criterion). Mirrors servabilityLine voice.
export function modelAuthLine(excluded: { key: string; reason: string; probedAt: string }[]): string {
  const parts = excluded.map(({ key, reason, probedAt }) => `${key} (${reason} — probed ${probedAt.split("T")[0]})`);
  return `model auth: ${excluded.length} channel(s) unauthed — ${parts.join(", ")}`;
}

// HYG-07(b): file mtime is the zero-schema-change staleness signal — doctor.json carries no probe timestamp,
// so a schema field would break the existing-files compat invariant. null when the file is absent (probeAll
// fallback path is fresh by construction). statSync is free vs the readDoctor that already happened.
export function doctorAgeMs(repoRoot: string): number | null {
  const p = doctorPath(repoRoot);
  if (!existsSync(p)) return null;
  // Math.max: mtimeMs is sub-ms float, Date.now() is int ms — clamp so a clock-skew fraction never
  // renders a nonsensical negative age ("doctor.json is -0h old").
  return Math.max(0, Date.now() - statSync(p).mtimeMs);
}

// ponytail: hardcoded 60m TTL for init reuse only — promote to config when an operator asks.
export const INIT_DOCTOR_REUSE_MS = 60 * 60 * 1000;

export function formatDoctorAgeForInit(ageMs: number): string {
  return `${Math.floor(ageMs / 60_000)}m`;
}

export function initDoctorReuse(repoRoot: string, fresh: boolean): { reuse: boolean; ageMs: number | null; health: Record<string, AuthHealth> | null } {
  const health = readDoctor(repoRoot);
  const ageMs = doctorAgeMs(repoRoot);
  const reuse = !fresh && health !== null && ageMs !== null && ageMs < INIT_DOCTOR_REUSE_MS;
  return { reuse, ageMs, health: reuse ? health : null };
}

// Report body shared by init's cached-doctor path — mirrors doctor.ts formatting without probing.
export function formatDoctorReport(cwd: string, cfg: TickmarkrConfig, health: Record<string, AuthHealth>, adapters: WorkerAdapter[], opts: { wrote?: boolean } = {}): string {
  const rows = adapters.map((a) => {
    const h = health[a.id];
    // OBS-503: a crash-on-version verdict carries its reason in note — print it instead of the lie.
    const state = !h?.installed ? (h?.note ?? "not installed") : `${h.version ?? "installed"}${h.note ? ` (${h.note})` : ""}`;
    return `  ${h?.installed ? "✓" : "✗"} ${a.id.padEnd(14)} ${state}`;
  });
  rows.push(`  ${HerdrDriver.available() ? "✓" : "✗"} herdr          ${HerdrDriver.available() ? "driver available (HERDR_ENV=1)" : "not detected — subprocess driver will be used"}`);
  rows.push("workspace trust:");
  for (const a of adapters) {
    if (!health[a.id]?.installed) continue;
    if (!a.trust) {
      rows.push(`  = ${a.id.padEnd(14)} trust: n/a`);
      continue;
    }
    try {
      const v = a.trust(cwd);
      if (v.status === "trusted") rows.push(`  ✓ ${a.id.padEnd(14)} trust: trusted`);
      else if (v.status === "seeded") rows.push(`  ✓ ${a.id.padEnd(14)} trust: seeded`);
      else rows.push(`  ! ${a.id.padEnd(14)} trust: action-required — run ONCE: ${v.command}`);
    } catch (e) {
      rows.push(`  ! ${a.id.padEnd(14)} trust: action-required — run ONCE: (trust check failed: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  for (const [role, sel] of [["judge", cfg.judge], ["consult", cfg.consult]] as const) {
    if (!health[sel.adapter]?.installed) {
      rows.push(`  ! ${role} runs on ${sel.adapter}:${sel.model} — NOT installed; that gate will fail closed until you install it or remap cfg.${role}`);
    }
  }
  rows.push(...modelLints(cfg, health, adapters, { stateDir: stateDirName(cwd) }).map((l) => `  ! ${l}`));
  const excluded = excludedChannels(cfg, adapters, health);
  if (excluded.length) rows.push(`  ! ${exclusionLine(excluded)}`);
  const servable = servableExclusions(cfg, adapters, health);
  if (servable.length) rows.push(`  ! ${servabilityLine(servable)}`);
  const visual = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  const frag = suggestOverlay(cfg, health, adapters, stateDirName(cwd));
  let drift = "";
  if (frag) {
    if (visual) {
      const overlayPath = join(tickmarkrDir(cwd), "doctor-overlay.yaml");
      writeFileSync(overlayPath, frag);
      drift = `\nmodel drift: unclassified models detected — paste-ready overlay written to ${overlayPath} (advisory; tickmarkr never applies it)`;
    } else {
      drift = `\nmodel drift — paste-ready overlay (advisory; tickmarkr never applies):\n${frag}`;
    }
  }
  const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  const dateOf = (iso: string) => iso.slice(0, 10);
  const modelStatus = adapters.flatMap((a) => {
    const h = health[a.id];
    if (!h?.installed) return [];
    const classified = cfg.tiers[a.id]?.models ?? {};
    const models = Object.keys(classified);
    const unclassified = (h.models ?? []).filter((m) => !(m in classified));
    if (!models.length && !unclassified.length) return [];
    const w = Math.max(8, ...models.map((m) => m.length));
    const statusRows: string[] = [`  ${a.id}`];
    for (const m of models) {
      const v = h.modelAuth?.[m];
      const auth = !v ? "unknown" : v.authed ? "authed" : `unauthed: ${trunc(v.reason ?? "probe failed", 40)} (${dateOf(v.probedAt)})`;
      const d = disallowedBy({ adapter: a.id, model: m }, cfg.routing);
      const denied = d?.by === "deny" ? d.entry : "—";
      const pref = preferRanks({ adapter: a.id, model: m }, cfg).map((p) => `${p.shape}#${p.rank}`).join(",") || "—";
      statusRows.push(`    ${m.padEnd(w)} ${classified[m].padEnd(8)} ${auth}  denied=${denied}  prefer=${pref}`);
    }
    if (unclassified.length) statusRows.push(`    (${unclassified.length} more listed, unclassified)`);
    return statusRows;
  });
  const modelSummary = modelStatus.length ? `\nmodel status:\n${modelStatus.join("\n")}` : "";
  const wrote = opts.wrote === false ? "" : `\nwrote ${stateDirName(cwd)}/doctor.json`;
  return `tickmarkr doctor — capability matrix:\n${rows.join("\n")}${modelSummary}${drift}${wrote}`;
}
