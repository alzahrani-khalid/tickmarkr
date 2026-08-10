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
// v1.89 T1 / OBS-414: the fingerprint is a VERBATIM CAPTURE of the workspace-trust prompt that CLI
// actually renders. Fixtures must be verbatim captures is this project's law since v1.79; it was
// never applied to fingerprints, and both prior repairs of this contract died on that gap. `kind`
// is absent on a capture so the shipped declarations stay byte-identical.
export interface CapturedTrustDialog {
  kind?: "dialog";
  fingerprint: string;
  key: string; // herdr pane send-keys token, e.g. "Enter"
}

// v1.89 T1 / OBS-414: an adapter that renders NO workspace-trust prompt says so, with a reason a
// reviewer can falsify. Optionality let an adapter opt out of stall protection by silence; a bare
// required capture was worse — it demanded a value where reality had none, and two independent
// workers invented one (prose matching no pane, then a generic tool-permission prompt whose Enter
// approves arbitrary execution). See .planning/RULING-v189-T1-reauthor.md.
export interface NoTrustDialog {
  kind: "none";
  reason: string;
}

export type TrustDialog = CapturedTrustDialog | NoTrustDialog;

export const TRUST_DIALOG_BLANK_MESSAGE =
  "trust-dialog fingerprint must be verbatim bytes captured from a workspace-trust prompt — a blank or whitespace-only fingerprint matches every pane";
// v1.89 T1 / OBS-414 round 3 — THE EVIDENCE. The word "trust" is not evidence of a capture: codex's
// real recorded gate is "Do you trust the contents of this directory?" and the handwritten prose
// "Do you trust this command?" is one word away, so no regex separates them — only the record does.
// Round 2 accepted the prose, and the daemon presses Enter on a match, which is auto-approval of an
// arbitrary tool call. So a fingerprint must be an ENUMERATED capture (APPROVED_TRUST_FINGERPRINTS
// below), and every pane here is VERBATIM, quoted from the record named beside it — the panes are the
// evidence each approved entry is checked against, never the acceptance rule themselves.
//
// Cost of the posture, stated plainly: an operator adding a CLI through the YAML drive contract
// cannot declare a trust dialog whose capture is not enumerated here — they declare {kind:"none",
// reason} and page a human, or contribute the capture. That is deliberate. The alternative is a stall
// protection that any plausible sentence can turn into a permission auto-approver.

// v1.75 T2 / OBS-137, claude-code 2.1.218 startup gate.
export const CLAUDE_TRUST_PANE = [
  "Accessing workspace:",
  "/tmp/untrusted-project",
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).",
  "Yes, I trust this folder",
].join("\n");

// v1.75 T2 / OBS-137, codex 0.144.6 startup gate.
export const CODEX_TRUST_PANE = [
  "Do you trust the contents of this directory?",
  "Working with untrusted contents comes with higher risk of prompt injection.",
  "Trusting the directory allows project-local config, hooks, and exec policies to load.",
  "› 1. Yes, continue",
  "Press enter to continue",
].join("\n");

// v1.22 T5 / OBS-19, cursor-agent's per-worktree dialog.
export const CURSOR_TRUST_PANE = "Workspace Trust Required\nTrust this folder?";

// OBS-358, live pane wW:p2TB of run-20260805-121252 — the dialog that cost 30 minutes — quoted from
// the record holding all five lines, .overseer/REPAIR-v186/GATE-T28-1.md (OBSERVATIONS.md abridges
// it to the first three). "← highlighted" is the observer's annotation of the selected row, kept
// exactly as recorded rather than tidied away.
export const KIMI_TRUST_PANE = [
  "Trust this folder?",
  "  /Users/…/.tickmarkr/worktrees.noindex/tickmarkr-run-20260805-121252--T29",
  "❯ Trust this folder     ← highlighted",
  "    Enable project MCP servers. Remembered for this folder.",
  "  Don't trust",
].join("\n");

// OBS-406, live pane wW:p32A of run-20260806-121758-…214 T5 — the same gate in its MCP-trust
// wording, which is why kimi's fingerprint is the cursor+option row both headings share.
export const KIMI_MCP_TRUST_PANE = [
  "Kimi Code loads project-level MCP servers (.mcp.json, .kimi-code/mcp.json) only in trusted folders.",
  " ❯ Trust this folder      /      Don't trust",
].join("\n");

export const RECORDED_TRUST_PANES: readonly string[] = [
  CLAUDE_TRUST_PANE, CODEX_TRUST_PANE, CURSOR_TRUST_PANE, KIMI_TRUST_PANE, KIMI_MCP_TRUST_PANE,
];

// v1.89 T1 / OBS-414 round 4 — EXACT, not "leading bytes of a recorded line". Round 3 accepted any
// prefix of a captured line, and every prefix of a trust prompt is also a substring of unrelated
// panes: `{fingerprint: "Trust"}` passed, then matched a tool-permission pane reading
// "Trust this command?" and handed the daemon an Enter to press on it — the auto-approval defect,
// reopened by the check meant to close it. `"Trust this folder"` (kimi's row minus its cursor glyph)
// passed the same way, and that exact string is the one OBS-406 measured producing 258 false wakes
// in 25 minutes on supervisor panes with the words on screen as prose.
//
// So the approved fingerprints are ENUMERATED, one per shipped capture, each the distinctive bytes
// of its own pane and nothing shorter. Kimi's carries the selection cursor because a live modal
// renders one and prose never does. Membership is exact; the corpus check below it keeps a list
// entry from drifting away from the pane it claims to quote.
export const APPROVED_TRUST_FINGERPRINTS: readonly string[] = [
  "Quick safety check: Is this a project you created or one you trust?", // claude-code 2.1.218, OBS-137
  "Do you trust the contents of this directory?", // codex 0.144.6, OBS-137
  "Workspace Trust Required", // cursor-agent, OBS-19
  "❯ Trust this folder", // kimi 0.29.0, OBS-358 + OBS-406 — the cursor glyph is load-bearing
];

const isApprovedFingerprint = (fingerprint: string): boolean =>
  APPROVED_TRUST_FINGERPRINTS.includes(fingerprint)
  && RECORDED_TRUST_PANES.some((pane) => pane.includes(fingerprint));

export const TRUST_DIALOG_UNRECORDED_MESSAGE =
  "trust-dialog fingerprint is not one of the approved workspace-trust captures — it must be exactly an entry of APPROVED_TRUST_FINGERPRINTS in src/adapters/types.ts (each the distinctive bytes of a recorded pane), not a prefix of one, a substring of one, or a sentence describing the prompt; declare {kind: none, reason} if the CLI renders none";

// The two variants, exported as one tuple so every schema that embeds a trust declaration (the
// drive contract in catalog.ts) is built from these bytes rather than restating them.
export const TRUST_DIALOG_VARIANTS = [
  z.object({
    kind: z.literal("dialog").optional(),
    // superRefine, not chained refine(): one failure yields ONE diagnosis, so the operator reads the
    // reason their declaration was refused instead of every rule it happened to trip.
    fingerprint: z.string().superRefine((fingerprint, ctx) => {
      const message = fingerprint.trim().length === 0 ? TRUST_DIALOG_BLANK_MESSAGE
        : isApprovedFingerprint(fingerprint) ? undefined
        : TRUST_DIALOG_UNRECORDED_MESSAGE;
      if (message) ctx.addIssue({ code: "custom", message });
    }),
    key: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("none"),
    reason: z.string().refine((r) => r.trim().length > 0, "a no-dialog declaration must state a falsifiable reason"),
  }).strict(),
] as const;

export const TrustDialogSchema = z.union(TRUST_DIALOG_VARIANTS);

// The discrimination lives HERE, at the keypress boundary every caller crosses: a no-dialog
// declaration never matches, so sendKey is unreachable for it without editing this function. The
// blank guard is the same fail-closed posture one layer below the schema.
export function matchesTrustDialog(paneText: string, dialog: TrustDialog): dialog is CapturedTrustDialog {
  if (dialog.kind === "none") return false;
  return dialog.fingerprint.trim().length > 0 && paneText.includes(dialog.fingerprint);
}

// v1.75 T1 / OBS-136: an adapter whose steady-state TUI presents a bordered input box declares
// one distinctive pane-text fingerprint. The herdr driver associates declarations with worker
// slots by the existing adapter-bearing dispatch name before that name is canonicalized.
// v1.77 / OBS-142: launchCommand identifies the adapter-owned bootstrap command that necessarily
// precedes the box; that command settles on a clean shell line, while every other delivery waits
// for the declared box itself. readinessTimeoutMs bounds that evidence loop per adapter.
// v1.85 T5 / OBS-140: typed delivery is licensed by DECLARED states, never by transcript shape.
// `match` is the box painted, `emptyMatch` the box carrying nothing, `occupiedMatch` the box still
// holding a prompt. An adapter may pin `occupiedMatch` directly, or leave it derived from the other
// two — but an adapter that declares neither cannot acknowledge a submission and is refused.
export interface InputBox {
  fingerprint: string;
  match?(paneText: string): boolean;
  emptyMatch?(paneText: string): boolean;
  occupiedMatch?(paneText: string): boolean;
  launchCommand?(command: string): boolean;
  readinessTimeoutMs?: number;
}

const inputBoxes = new Map<string, InputBox>();

export function declareInputBox(adapterId: string, inputBox: InputBox): InputBox {
  inputBoxes.set(adapterId, inputBox);
  return inputBox;
}

export function declaredInputBoxForWorkerName(workerName: string): InputBox | undefined {
  const adapterId = /^.+-worker-(.+)-a\d+-.+$/.exec(workerName)?.[1];
  return adapterId === undefined ? undefined : inputBoxes.get(adapterId);
}

export function matchesInputBox(paneText: string, inputBox: InputBox): boolean {
  return inputBox.match?.(paneText) ?? paneText.includes(inputBox.fingerprint);
}

export function matchesEmptyInputBox(paneText: string, inputBox: InputBox): boolean {
  return inputBox.emptyMatch?.(paneText) === true;
}

// The OCCUPIED state: the adapter's own pin when it has one, else painted-and-not-empty, which two
// adapter declarations decide between them. Either way the answer comes from the adapter, never from
// where the prompt happens to sit in the transcript.
export function matchesOccupiedInputBox(paneText: string, inputBox: InputBox): boolean {
  if (inputBox.occupiedMatch) return inputBox.occupiedMatch(paneText) === true;
  return matchesInputBox(paneText, inputBox) && !matchesEmptyInputBox(paneText, inputBox);
}

// v1.85 T5: which input-state declarations a typed delivery needs and this adapter has not made.
// Empty is always required (it is the only positive submission evidence); occupied needs either its
// own matcher or the `match` that derives it. A non-empty result is a fail-closed refusal, named.
export function missingInputStateDeclarations(inputBox: InputBox | undefined): string[] {
  if (!inputBox) return ["inputBox"];
  const missing: string[] = [];
  if (!inputBox.emptyMatch) missing.push("emptyMatch");
  if (!inputBox.occupiedMatch && !inputBox.match) missing.push("occupiedMatch");
  return missing;
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
  // v1.22 T5 / OBS-19 → v1.89 T1 / OBS-414: REQUIRED trust-dialog declaration for runtime
  // auto-answer (see TrustDialog). Required-but-honest: a captured dialog, or {kind:"none", reason}.
  // The `?` here was the silent opt-out that cost run …215 thirty minutes on kimi's folder-trust
  // prompt — an omission has no line to object to at review.
  trustDialog: TrustDialog;
  // v1.75 T1 / OBS-136: optional steady-state TUI input-box declaration. The herdr delivery
  // readiness/clear guards consult only this adapter-owned contract, never a driver fingerprint.
  inputBox?: InputBox;
  // v1.65 T3: the CLI flags this adapter's command strings hardcode, checked by doctor against
  // `<binary> --help` (flagDriftWarnings). Advisory only — a drift warning never changes channel
  // availability, routing, or dispatch; only doctor reads this.
  hardcodedFlags?: { binary: string; flags: string[] };
}

export function channelsFromConfig(adapterId: string, cfg: TickmarkrConfig): BillingChannel[] {
  const e = cfg.tiers[adapterId];
  if (!e) return [];
  return Object.entries(e.models).flatMap(([model, tier]) => {
    const override = e.modelOverrides?.[model];
    const vendor = override?.vendor ?? e.vendor;
    // Parsed configs guarantee this only occurs for invalid data, but direct callers must fail closed
    // too: an undeclared vendor is not review diversity and provider prefixes are never provenance.
    if (!vendor?.trim()) return [];
    return [{
      adapter: adapterId,
      vendor,
      model,
      channel: override?.channel ?? e.channel,
      tier,
    }];
  });
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
