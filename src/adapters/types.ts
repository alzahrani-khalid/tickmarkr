import { z } from "zod";
import type { TickmarkrConfig, Tier } from "../config/config.js";
import type { Task } from "../graph/schema.js";

// SPEND-01/06: normalized token counts — the measurable fact. NO cost field, ever: CLIs report
// cost:0 on sub plans and notional list prices on others (LIVE-CHECK finding 3); money is Phase 18's
// derivation (operator price × tokens), never a CLI claim (SPEND-06).
export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
  reasoning: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// SPEND-02 accumulation across attempts. The inner ?? 0 is the ONE sanctioned coalesce for usage —
// safe ONLY behind the both-undefined guard (mirrors classify()'s consults ?? 0 precedent): it can
// merge two observed counts, it can never MATERIALIZE a count for an unobserved attempt. Absent+absent
// stays absent; the top-level fold in daemon.ts only calls this when attemptUsage is real.
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  const add = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: add(a.cacheRead, b.cacheRead), cacheWrite: add(a.cacheWrite, b.cacheWrite),
    reasoning: add(a.reasoning, b.reasoning),
  };
}

export interface Assignment { adapter: string; model: string; channel: "sub" | "api"; tier: Tier }
export interface BillingChannel { adapter: string; vendor: string; model: string; channel: "sub" | "api"; tier: Tier }
export interface ModelAuth { authed: boolean; reason?: string; probedAt: string }
export interface AuthHealth {
  installed: boolean; authed: boolean; version?: string; models: string[]; note?: string;
  // v1.5 MODEL-02: ISO timestamp — additive-optional, pre-v1.5 doctor.json lacks it, readers use ?.
  modelsDetectedAt?: string;
  // HYG-05: models this adapter can GENUINELY serve (pi-only in v1.11). Three-valued by channel:
  // model ∈ servable ⇒ authed; model ∉ servable (defined) ⇒ unauthed ⇒ not advertised, map pin ⇒ RoutingError;
  // servable === undefined ⇒ UNKNOWN ⇒ no filtering (fail closed on the CHANNEL, never on the run).
  // Per-provider granularity a tri-state boolean cannot express (D36-C); other four adapters never set it.
  servable?: string[];
  // v1.21: doctor probes only configured models. Missing from old doctor.json is unknown and fails closed
  // for routing unless cfg.routing.allowUnverifiedModels restores legacy compatibility.
  modelAuth?: Record<string, ModelAuth>;
}

export function modelAuthed(health: AuthHealth | undefined, model: string, allowUnverifiedModels = false): boolean {
  const authed = health?.modelAuth?.[model]?.authed;
  return authed === true || (authed === undefined && allowUnverifiedModels);
}
export interface Invocation { command: string }
export interface WorkerResult { ok: boolean; summary: string; deviations: string[]; raw: string }

// v1.69 T6: adapters whose real TUI has no argv-seeding surface can still be launched interactively by
// opening the TUI first, waiting for a deterministic readiness marker, and then injecting the task as a
// single submitted turn. `interactiveSeed` is ignored unless `interactiveCommand` is also in play.
export type SeedBannerConfirmResult =
  | { ok: true; sessionId?: string }
  | { ok: false; error: string };

export interface InteractiveSeed {
  launch(model: string): string;
  readinessMatch: string;
  seedLine(promptFile: string): string;
  // v1.71 T2: optional launch-banner model check — runs on the generic dispatch path before seed injection.
  confirmBanner?(banner: string, assignedModel: string): SeedBannerConfirmResult;
}

// v1.23 T1: live tokens-in-context from a CLI's on-disk session store. `tokens` is the LAST turn's
// input-side fill (never a sum over turns). `limit` only when the store states a real window size.
export interface ContextUsage {
  tokens: number;
  limit?: number;
}

// Enough identity to resolve the store without spawning the agent CLI or touching a pane.
// `id` is the CLI session id (claude: herdr agent_session.value = filename stem under projects/<slug>/;
// pi: session file stem under sessions/<slug>/). `cwd` derives the project/session slug.
export interface SessionRef {
  cwd: string;
  id: string;
}

// v1.22 T5: workspace-trust pre-flight. doctor calls trust(repoRoot) when present; absent ⇒ n/a.
// trusted = already present in the CLI's store; seeded = tickmarkr just wrote it; action-required = the
// operator must run `command` once (exact shell line, or a named dialog when no store is seedable).
export type TrustVerdict =
  | { status: "trusted" }
  | { status: "seeded" }
  | { status: "action-required"; command: string };

// v1.22 T5 / OBS-19: for CLIs whose trust cannot be pre-seeded (cursor-agent: per-directory,
// non-persistent from headless --trust), the adapter declares a pane-text fingerprint + keystroke.
// The daemon matches a blocked/idle pane once per slot and auto-answers via driver.sendKey — tickmarkr
// created the worktree from the operator's own repo, so trusting is safe by construction. Any other
// blocked dialog still pages the operator.
export interface TrustDialog {
  fingerprint: string;
  key: string; // herdr pane send-keys token, e.g. "Enter"
}

export function matchesTrustDialog(paneText: string, dialog: TrustDialog): boolean {
  return paneText.includes(dialog.fingerprint);
}

export interface WorkerAdapter {
  id: string;
  vendor: string;
  // OBS-31: probe-only cwd — "neutral" runs model probes from a fresh empty temp dir (scan-heavy
  // CLIs whose auth is global); absent or "repo" keeps today's repo-root behavior.
  probeCwd?: "repo" | "neutral";
  // v1.52 T4 / OBS-72: per-adapter model-probe concurrency cap; absent = registry default.
  // codex declares 1 — concurrent codex exec in one repo self-contends and fails healthy models.
  probeConcurrency?: number;
  probe(): Promise<AuthHealth>;
  channels(cfg: TickmarkrConfig): BillingChannel[];
  headlessCommand(promptFile: string, model: string): string;
  // v1.2: launch the CLI's real interactive TUI with the prompt injected; null = adapter can't → print fallback
  interactiveCommand(promptFile: string, model: string): string | null;
  // v1.69 T6: launch the real TUI without a prompt, wait for readiness, then inject one seed turn.
  // When present, the daemon uses this instead of the single-command interactiveCommand path.
  interactiveSeed?: InteractiveSeed;
  // v1.29 T1: same-session retry capability; absent means the CLI has no solid resume semantics.
  resumeCommand?(sessionId: string, promptFile: string, model: string): string;
  // v1.53 T3: capture the CLI's own session id from a completed attempt's output (kimi ends every
  // -p run with `To resume this session: kimi -r session_<uuid>`, live probe 2026-07-18). Pure
  // string scan, last valid line wins; undefined = no capture → the daemon keeps its slot-name id.
  sessionIdFrom?(output: string): string | undefined;
  // v1.53 T3: opt-in to resume when the prior attempt's context fill is UNKNOWN — only for adapters
  // with no readable context surface (kimi: no token counter in its session store, KIMI-03). Loosens
  // ONLY the contextTokens-known requirement at the daemon retry seam: a KNOWN over-threshold
  // context still dispatches fresh, and the escalation ladder bounds the resume chain.
  resumeUnknownContext?: boolean;
  invoke(task: Task, cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation;
  parse(output: string, nonce: string): WorkerResult;
  // v1.5 MODEL-01: non-interactive model-list surface; absent = adapter can't list (claude-code#12612).
  // Called ONLY by `tickmarkr doctor` — never probe/plan/run/daemon (zero-token tests, no dispatch blocking).
  // Fails OPEN to [] — deliberate inversion of the gates' fail-closed posture: detection is advisory,
  // a broken list surface must never fail an otherwise-healthy doctor.
  listModels?(): Promise<string[]>;
  // v1.5 MODEL-05: cache-backed adapters (codex) know when the knowledge was actually FETCHED, not
  // when doctor last ran. Returning that lets doctor stamp modelsDetectedAt with the real cache age so
  // the 30-day staleness lint can fire on an ancient cache. undefined = no honest source → doctor uses now.
  listModelsFetchedAt?(): string | undefined;
  // SPEND-01: harness-emitted structured usage ONLY, read POST-HOC from the CLI's own cwd-keyed store
  // (session JSONL / structured artifact the harness wrote). NEVER the pane transcript (driver.read —
  // v1.4 self-reference class) and NEVER the parsed trailer (TEL-01 best-liar class).
  // `sinceMs` is this attempt's dispatch wall-clock: return ONLY usage recorded at/after it, filtered
  // PER RECORD by the record's own timestamp (never file mtime). This attempt-scoped cursor makes a
  // per-attempt fold correct even for a store that ACCUMULATES across attempts (claude keeps every
  // session under a stable cwd-slug); a cursor-less cumulative reader folded per attempt double-counts
  // (3A+2B+C). Valid for BOTH worker modes — an interactive TUI writes the same store. Fails OPEN to
  // undefined ⇒ unmetered, never 0 ("?? 0" is the recorded poisoning bug as economics). Real adapters
  // gain this in 17-03 (claude only); the other four ship without it ⇒ honestly unmetered.
  collectUsage?(cwd: string, sinceMs: number): TokenUsage | undefined;
  // v1.23 T1: tokens currently in context for a live session, read ONLY from the CLI's on-disk session
  // store (fs only — no agent-CLI spawn, no pane scrape, no network). Returns null when unknowable —
  // missing/unreadable store, no usage lines, or adapter has no knowable store (codex/cursor/opencode/
  // fake). Callers MUST treat null as unknown: never as 0, never as over-threshold (telemetry
  // fail-open — opposite of gates). claude/pi implement; others omit or return null.
  contextUsage?(session: SessionRef): ContextUsage | null;
  // v1.22 T5: optional trust check-and-seed. doctor only. Absent = n/a (adapter has no trust concept,
  // or already bypasses via a CLI flag like pi --approve). Side-effecting when it seeds a writable store.
  trust?(repoRoot: string): TrustVerdict;
  // v1.22 T5 / OBS-19: optional trust-dialog fingerprint for runtime auto-answer (see TrustDialog).
  trustDialog?: TrustDialog;
  // v1.65 T3: the CLI flags this adapter's command strings hardcode, checked by doctor against
  // `<binary> --help` (flagDriftWarnings). Advisory only — a drift warning never changes channel
  // availability, routing, or dispatch; only doctor reads this.
  hardcodedFlags?: { binary: string; flags: string[] };
}

export function channelsFromConfig(adapterId: string, cfg: TickmarkrConfig): BillingChannel[] {
  const e = cfg.tiers[adapterId];
  if (!e) return [];
  return Object.entries(e.models).map(([model, tier]) => ({
    adapter: adapterId, vendor: e.vendor, model, channel: e.channel, tier,
  }));
}

export function channelKey(c: { adapter: string; model: string }): string {
  return `${c.adapter}:${c.model}`;
}

export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Quota exhaustion is detected from CLI errors, never predicted (spec §4).
// ZAI coding-plan exhaustion text: "Insufficient balance or no resource package. Please recharge."
// Anchor the distinctive full phrase, not the two-word "insufficient balance" fragment — that fires
// on ordinary billing/wallet task output the harness edits (research Pitfall 3, 2026-07-10).
export const QUOTA_RE = /rate.?limit|quota|usage limit|out of credits|insufficient credit|insufficient balance or no resource|\b429\b/i;

// v1.5 MODEL-01: charset gate for detected model ids (research Pitfall 4, verified 2026-07-10).
// Ids come from CLI stdout / another program's JSON (models_cache.json) and are echoed into
// operator-facing lint text and persisted to doctor.json — defense-in-depth for MODEL-05 (config
// suggestions that could reach a shell). Covers observed ids incl. zai-coding-plan/glm-5.2,
// gpt-5.6-sol, composer-2.5, gpt-5.3-codex; non-conforming (ANSI/control/shell-metachar) ids dropped.
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/:[\]=,-]*$/;
