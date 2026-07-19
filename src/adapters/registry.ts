import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TickmarkrConfig, overlayPreferShapes, TIER_RANK, type Tier } from "../config/config.js";
import { modelLints, suggestOverlay } from "./model-lints.js";
import { HerdrDriver } from "../drivers/herdr.js";
import { tickmarkrDir, stateDirName } from "../graph/graph.js";
import { disallowedBy, excludedChannels, exclusionLine, preferRanks } from "../route/preference.js";
import { learnedScore, type RoutingProfile } from "../route/profile.js";
import { marginalCostRank } from "../route/router.js";
import { sh } from "../run/git.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursorAgent } from "./cursor-agent.js";
import { FakeAdapter } from "./fake.js";
import { grok } from "./grok.js";
import { kimi } from "./kimi.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import { type AuthHealth, type BillingChannel, channelKey, type ModelAuth, modelAuthed, QUOTA_RE, type WorkerAdapter } from "./types.js";

// Agent-CLI binary names with no tickmarkr adapter — doctor sweeps these advisory-only (v1.48 T1).
export const CANDIDATE_CLI_CATALOG = ["kimi", "gemini", "qwen", "aider", "goose", "amp", "droid", "auggie", "crush"] as const;

// Binaries probed by registered adapters — kept beside the catalog so a test can forbid overlap.
export const REGISTERED_ADAPTER_BINARIES = ["claude", "codex", "cursor-agent", "opencode", "pi", "grok"] as const;

export type CandidateCliDetection = { binary: string; version: string | undefined };

function candidateOnPath(bin: string, pathEnv: string): boolean {
  const r = spawnSync("which", [bin], { encoding: "utf8", env: { ...process.env, PATH: pathEnv } });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// Fail open: a broken candidate binary never throws and never fails doctor.
export function probeCandidateVersion(bin: string): string | undefined {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 });
    if (r.error || r.status !== 0) return undefined;
    return (r.stdout || r.stderr).trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

export function detectCandidateClis(opts: { pathEnv?: string } = {}): CandidateCliDetection[] {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const out: CandidateCliDetection[] = [];
  for (const bin of CANDIDATE_CLI_CATALOG) {
    if (!candidateOnPath(bin, pathEnv)) continue;
    out.push({ binary: bin, version: probeCandidateVersion(bin) });
  }
  return out;
}

export function formatCandidateCliRow({ binary, version }: CandidateCliDetection): string {
  const ver = version ?? "version unknown";
  return `  ! ${binary.padEnd(14)} detected: ${ver} (no tickmarkr adapter — not routable)`;
}

export function allAdapters(opts: { fakeScriptPath?: string } = {}): WorkerAdapter[] {
  // pi + grok + kimi appended LAST: same-tier ties resolve by discovery order (Phase 6 D2), so
  // appending keeps the Phase 6 shape→channel matrix byte-identical; inserting anywhere else
  // silently reassigns shapes on same-tier ties. kimi is appended AFTER grok for the same reason.
  const real: WorkerAdapter[] = [claudeCode, codex, cursorAgent, opencode, pi, grok, kimi];
  const fakePath = opts.fakeScriptPath ?? process.env.TICKMARKR_FAKE_SCRIPT;
  return fakePath ? [new FakeAdapter(fakePath), ...real] : real;
}

export function getAdapter(id: string, adapters: WorkerAdapter[]): WorkerAdapter {
  const a = adapters.find((a) => a.id === id);
  if (!a) throw new Error(`unknown adapter ${id} (have: ${adapters.map((a) => a.id).join(", ")})`);
  return a;
}

export async function probeAll(adapters: WorkerAdapter[]): Promise<Record<string, AuthHealth>> {
  const out: Record<string, AuthHealth> = {};
  await Promise.all(adapters.map(async (a) => { out[a.id] = await a.probe(); }));
  return out;
}

const MODEL_PROBE_PROMPT = "Reply with exactly OK and nothing else.";
// 60s: a healthy MCP-free codex probe measured 29.9s round-trip (2026-07-15) — 30s had zero headroom.
const MODEL_PROBE_TIMEOUT_MS = 60000;
// Auth-words only match when tied to a failure word; bare "auth"/"OAuth"/"authored" never fail (v1.27 T2).
const AUTH_FAILURE_RE = /\b4\d\d\b|\bauth(?:entication|orization)?\s+(?:error|failed|failure|denied)|unauthori[sz]ed|forbidden|access denied|credit(?:s)?\s+(?:exhausted|error|denied)/i;

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

export type ProbeModelStatus = "ok" | "timeout" | "failed";
export type ProbeModelProgress = (adapter: string, model: string, status: ProbeModelStatus, durationMs: number) => void;

export interface AutoPreferDoc {
  derivedAt: string;
  [shape: string]: string[] | string;
}

export const pendingAutoPreferKey = Symbol.for("tickmarkr.pendingAutoPrefer");

type HealthWritePayload = Record<string, AuthHealth> & { [pendingAutoPreferKey]?: AutoPreferDoc };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ponytail: 24h TTL matches plan.ts staleness — promote to config when an operator asks.
export const DOCTOR_ROUTING_STALE_MS = 24 * 60 * 60 * 1000;

export function deriveAutoPrefer(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
  profile?: RoutingProfile,
): AutoPreferDoc {
  const derivedAt = new Date().toISOString();
  const out: AutoPreferDoc = { derivedAt };
  // v1.52 T5: routing.floors is the only band authority — a map entry can no longer carry a tier.
  for (const shape of Object.keys(cfg.routing.map)) {
    const minTier: Tier = cfg.routing.floors[shape] ?? "cheap";
    const ranked: { adapter: string; mc: number; dur: number; learned: number }[] = [];
    for (const a of adapters) {
      const h = health[a.id];
      if (!h?.installed || !h?.authed || typeof a.channels !== "function") continue;
      const qualifying = a.channels(cfg).filter((c) => TIER_RANK[c.tier] >= TIER_RANK[minTier] && h.modelAuth?.[c.model]?.authed === true);
      if (!qualifying.length) continue;
      const durations = qualifying
        .map((c) => (h.modelAuth?.[c.model] as { durationMs?: number } | undefined)?.durationMs)
        .filter((d): d is number => typeof d === "number");
      ranked.push({
        adapter: a.id,
        mc: Math.min(...qualifying.map(marginalCostRank)),
        dur: durations.length ? median(durations) : Number.POSITIVE_INFINITY,
        learned: profile ? Math.max(...qualifying.map((c) => learnedScore(profile, shape, channelKey(c), c.channel))) : 0,
      });
    }
    ranked.sort((a, b) => a.mc - b.mc || a.dur - b.dur || b.learned - a.learned);
    out[shape] = ranked.map((r) => r.adapter);
  }
  return out;
}

export function readAutoPrefer(repoRoot: string): AutoPreferDoc | null {
  const raw = readDoctorFile(repoRoot);
  if (!raw || typeof raw.autoPrefer !== "object" || raw.autoPrefer === null) return null;
  return raw.autoPrefer as AutoPreferDoc;
}

export function routingPreferContext(
  repoRoot: string,
  cfg: TickmarkrConfig,
  opts: { globalDir?: string } = {},
): { autoPrefer?: AutoPreferDoc; doctorFresh: boolean; overlayPreferShapes: ReadonlySet<string> } {
  const age = doctorAgeMs(repoRoot);
  const doctorFresh = age !== null && age <= DOCTOR_ROUTING_STALE_MS;
  return {
    autoPrefer: doctorFresh ? readAutoPrefer(repoRoot) ?? undefined : undefined,
    doctorFresh,
    overlayPreferShapes: overlayPreferShapes(repoRoot, opts),
  };
}

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
    if (process.env.VITEST && [claudeCode, codex, cursorAgent, opencode, pi, grok, kimi].includes(a)) return;
    const verdicts: Record<string, ProbedModelAuth> = {};
    const priorModelAuth = priorHealth?.[a.id]?.modelAuth;
    const probeRoot = a.probeCwd === "neutral" ? mkdtempSync(join(tmpdir(), "tickmarkr-probe-")) : repoRoot;
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
      const v = (authed: boolean, reason?: string): ProbedModelAuth =>
        ({ authed, ...(reason !== undefined ? { reason } : {}), probedAt, durationMs: Date.now() - t0 });
      try {
        if (typeof a.headlessCommand !== "function") return { verdict: v(false, "headless probe unavailable"), timedOut: false };
        const promptFile = join(mkdtempSync(join(tmpdir(), "tickmarkr-auth-")), "probe.md");
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
        return {
          verdict: r.timedOut && retry.firstTimedOut ? v(false, `probe timed out twice (${MODEL_PROBE_TIMEOUT_MS}ms)`) : v(false, reason),
          timedOut: r.timedOut === true,
        };
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
  }));
  (health as HealthWritePayload)[pendingAutoPreferKey] = deriveAutoPrefer(cfg, adapters, health);
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
  const pending = (health as HealthWritePayload)[pendingAutoPreferKey];
  const payload: Record<string, unknown> = { ...health };
  delete payload[pendingAutoPreferKey as unknown as string];
  if (pending) payload.autoPrefer = pending;
  const path = doctorPath(repoRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readDoctor(repoRoot: string): Record<string, AuthHealth> | null {
  const raw = readDoctorFile(repoRoot);
  if (!raw) return null;
  const { autoPrefer: _, ...health } = raw;
  return health as Record<string, AuthHealth>;
}

export function discoverChannels(
  cfg: TickmarkrConfig,
  adapters: WorkerAdapter[],
  health: Record<string, AuthHealth>,
): BillingChannel[] {
  const base = adapters
    .filter((a) => health[a.id]?.installed && health[a.id]?.authed)
    .flatMap((a) => {
      const h = health[a.id];
      const s = h?.servable;
      // T2 (2026-07-13): only a model doctor marked authed (modelAuth[model].authed===true) advertises a
      // channel — routing an unknown or 403 into dispatch is fail-closed. Operators with pre-v1.21 doctor.json
      // can opt into the prior unknown-is-routable behavior with routing.allowUnverifiedModels.
      return a.channels(cfg).filter((c) => modelAuthed(h, c.model, cfg.routing.allowUnverifiedModels) && (!s || s.includes(c.model)));
    });
  if (!cfg.routing.allow && !cfg.routing.deny) return base;
  return base.filter((c) => disallowedBy(c, cfg.routing) === null);
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
      if (v?.authed === false) out.push({ key: channelKey(c), adapter: a.id, reason: v.reason ?? "probe failed", probedAt: v.probedAt });
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
    const state = !h?.installed ? "not installed" : `${h.version ?? "installed"}${h.note ? ` (${h.note})` : ""}`;
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
