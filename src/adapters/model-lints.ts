import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type TickmarkrConfig, TIER_RANK, type Tier } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { buildTaskPrompt } from "./prompt.js";
import { MODEL_ID_RE, type AuthHealth, type WorkerAdapter } from "./types.js";
export const SEED_STAMPED = "2026-07-09";
// knowledge past this age gets a "rerun tickmarkr doctor" nudge (BLOCKED_POLL_MS-style named constant).
export const MODEL_STALE_DAYS = 30;
const DAY_MS = 86400000;
// cursor-agent 2026.07.08 reports 193 mostly-parameterized ids (e.g. gpt-5.3-codex-high-fast); filter the `auto`
// pseudo-model + effort/speed variant suffixes from the unconfigured-lint aggregation ONLY — doctor.json keeps the
// raw list (verified 2026-07-10). Data stays raw; lints stay signal.
const LINT_VARIANT_RE = /^auto$|-(fast|minimal|low|medium|high|xhigh)$/;
const LINT_CAP = 5;
const TTY_LINT_CAP = 3;
const DEFAULT_STATE_DIR = ".tickmarkr";
const doctorJsonRef = (stateDir: string) => ` — see ${stateDir}/doctor.json`;

export const ttyVisual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

// ponytail: chars/4 token heuristic — good enough for advisory plan lint; no tokenizer dep.
const CHARS_PER_TOKEN = 4;

/** True when any tier entry declares at least one model window. */
export function hasWindowsConfig(cfg: TickmarkrConfig): boolean {
  return Object.values(cfg.tiers).some((t) => t.windows && Object.keys(t.windows).length > 0);
}

export function declaredModelWindow(cfg: TickmarkrConfig, adapter: string, model: string): number | undefined {
  return cfg.tiers[adapter]?.windows?.[model];
}

function fileBytes(repoRoot: string, rel: string): number {
  if (rel.includes("*") || rel.includes("?") || rel.includes("{")) return 0; // glob — not measurable at plan time
  try {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) return 0;
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Best-effort plan-time payload estimate: prompt shell + context + files[] byte sizes. */
export function estimateTaskPayloadTokens(task: Task, repoRoot: string, feedback = ""): number {
  let bytes = buildTaskPrompt(task, feedback).length;
  for (const p of task.context) bytes += fileBytes(repoRoot, p);
  for (const p of task.files) bytes += fileBytes(repoRoot, p);
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

export type RoutedAssignment = { taskId: string; adapter: string; model: string };

/** Advisory only — absent windows config or undeclared model window ⇒ no lint. */
export function contextWindowLints(
  tasks: ReadonlyArray<Task>,
  assignments: ReadonlyArray<RoutedAssignment>,
  cfg: TickmarkrConfig,
  repoRoot: string,
): string[] {
  if (!hasWindowsConfig(cfg)) return [];
  const byId = new Map(assignments.map((a) => [a.taskId, a]));
  const lints: string[] = [];
  for (const t of tasks) {
    const a = byId.get(t.id);
    if (!a) continue;
    const window = declaredModelWindow(cfg, a.adapter, a.model);
    if (window === undefined) continue;
    const est = estimateTaskPayloadTokens(t, repoRoot);
    if (est > window) {
      lints.push(`${t.id}: payload ~${est} tokens exceeds ${a.adapter}:${a.model} window ${window}`);
    }
  }
  return lints;
}

const adapterHasAuthedChannel = (
  adapterId: string,
  shape: string,
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
): boolean => {
  // v1.52 T5: routing.floors is the only band authority — a map entry can no longer carry a tier.
  const minTier: Tier = cfg.routing.floors[shape] ?? "cheap";
  const a = adapters.find((x) => x.id === adapterId);
  const h = health[adapterId];
  if (!a || !h?.installed || typeof a.channels !== "function") return false;
  if (!h.modelAuth || !Object.keys(h.modelAuth).length) return true; // no per-model probe data — compat, not dead
  return a.channels(cfg).some((c) =>
    TIER_RANK[c.tier] >= TIER_RANK[minTier] && h.modelAuth?.[c.model]?.authed === true,
  );
};

// OBS-30 T2: warn when a built-in seed prefer names an adapter with zero authed channels this probe pass.
export function seedPreferLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  overlayPreferShapes: ReadonlySet<string> = new Set(),
): string[] {
  const lints: string[] = [];
  for (const shape of Object.keys(cfg.routing.map)) {
    if (overlayPreferShapes.has(shape)) continue;
    for (const p of DEFAULT_CONFIG.routing.map[shape]?.prefer ?? []) {
      const adapterId = p.includes(":") ? p.slice(0, p.indexOf(":")) : p;
      if (!cfg.tiers[adapterId]) continue;
      if (!adapterHasAuthedChannel(adapterId, shape, cfg, health, adapters)) {
        lints.push(`routing seed names dead adapter '${adapterId}' for shape '${shape}' — auto-prefer is routing around it`);
      }
    }
  }
  return lints;
}

// v1.54 T3: dead-steering sweep — operator prefer entries (routing.map overlay shapes, review.prefer,
// consult.prefer) that can never match an installed channel are named at plan time; v1.53 T2 pins the
// no-match case as a silent no-op, which makes a typo invisible. Advisory only: reads config + doctor
// health (no live probes), never touches routing. Seed map prefers stay seedPreferLints' turf (auto-prefer
// routes around dead seeds) — mapShapes limits this sweep to operator-authored entries so a bare default
// fleet isn't double-linted. Entry grammar mirrors preferIndex: adapter | adapter:model (first colon).
export function preferEntryLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  mapShapes: ReadonlySet<string> = new Set(),
): string[] {
  const lints: string[] = [];
  const sweep = (surface: string, entries?: readonly string[]) => {
    for (const entry of entries ?? []) {
      const i = entry.indexOf(":");
      const adapter = i < 0 ? entry : entry.slice(0, i);
      const model = i < 0 ? undefined : entry.slice(i + 1);
      if (!health[adapter]?.installed) {
        lints.push(`${surface} '${entry}' names uninstalled adapter '${adapter}' — dead steering (entry can never match)`);
      } else if (model !== undefined && !(model in (cfg.tiers[adapter]?.models ?? {}))) {
        lints.push(`${surface} '${entry}' names model '${model}' absent from ${adapter}'s configured channels — dead steering (entry can never match)`);
      }
    }
  };
  for (const shape of mapShapes) sweep(`routing.map.${shape}.prefer`, cfg.routing.map[shape]?.prefer);
  sweep("review.prefer", cfg.review.prefer);
  sweep("consult.prefer", cfg.consult.prefer);
  return lints;
}

// Diffs detected models (doctor.json) against configured tiers, both directions, per adapter id in cfg.tiers.
// No `  ! ` prefix here — the consumer (doctor rows / plan lints) owns that. Pre-v1.5 doctor.json (models:[], no
// modelsDetectedAt) is the compat baseline: `?.`/`?? []` everywhere, no zod (would reject old files).
export function modelLints(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  opts?: { tty?: boolean; stateDir?: string; overlayPreferShapes?: ReadonlySet<string> },
): string[] {
  const cap = opts?.tty ? TTY_LINT_CAP : LINT_CAP;
  const doctorRef = opts?.tty ? doctorJsonRef(opts.stateDir ?? DEFAULT_STATE_DIR) : "";
  const lints: string[] = [];
  for (const id of Object.keys(cfg.tiers)) {
    const adapter = adapters.find((a) => a.id === id);
    if (!adapter) continue; // fake/overlay-only tier entry with no adapter — nothing to diff against
    if (!adapter.listModels) {
      lints.push(`${id}: no model-list surface — seeds stamped ${SEED_STAMPED}; verify manually`);
      continue;
    }
    const h = health[id];
    const detected = h?.models ?? []; // MANDATORY default: pre-v1.5 files lack a populated models array
    if (detected.length === 0) {
      if (h?.installed) lints.push(`${id}: no detection data — run tickmarkr doctor`);
      continue; // no data to diff or age
    }
    const configured = Object.keys(cfg.tiers[id].models);
    for (const model of configured) {
      if (!detected.includes(model)) {
        lints.push(`${id}: tiers lists ${model} — CLI no longer reports it; tombstone it (${model}: null overlay) or verify the id`);
      }
    }
    const extra = detected.filter((m) => !configured.includes(m) && !LINT_VARIANT_RE.test(m));
    if (extra.length) {
      const shown = extra.slice(0, cap).join(", ");
      const tail = extra.length > cap ? `, +${extra.length - cap} more${doctorRef}` : "";
      lints.push(`${id}: reports ${extra.length} model(s) not in tiers (${shown}${tail}) — classify before routing (benchmark policy)`);
    }
    const at = h?.modelsDetectedAt;
    if (at) {
      const days = Math.floor((Date.now() - Date.parse(at)) / DAY_MS); // completed days — never overstate age
      if (days >= MODEL_STALE_DAYS) lints.push(`${id}: model knowledge is ${days} days old — rerun tickmarkr doctor`);
    }
  }
  lints.push(...seedPreferLints(cfg, health, adapters, opts?.overlayPreferShapes));
  return lints;
}

// T2/T6: one lint per exclusion, naming the probe reason and date. TTY truncates reasons to 60 chars and
// points at doctor.json for the full text; non-TTY is byte-identical to the pre-T6 registry helper.
export function formatModelAuthLine(
  excluded: { key: string; reason: string; probedAt: string }[],
  tty?: boolean,
  stateDir: string = DEFAULT_STATE_DIR,
): string {
  const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  const parts = excluded.map(({ key, reason, probedAt }) => {
    const r = tty ? trunc(reason, 60) : reason;
    return `${key} (${r} — probed ${probedAt.split("T")[0]})`;
  });
  const base = `model auth: ${excluded.length} channel(s) unauthed — ${parts.join(", ")}`;
  return tty ? `${base}${doctorJsonRef(stateDir)}` : base;
}

// MODEL-05/06: render detected-vs-configured drift as a paste-ready config.yaml fragment. Locked v1.5
// decision: detection is strictly advisory — doctor prints, a human pastes; NO --write/--apply exists.
// Additions render WHOLE-LINE-COMMENTED with a `???` tier placeholder (a tier is a benchmark claim; the
// machine never fabricates one — auto-tiering reopens the NaN-routing class). Removals render as LIVE
// `<id>: null` tombstones (deepMerge deletes the key). Pure function: no fs, no routing contact.
// Returns "" when no adapter has a delta. Mirrors modelLints' per-adapter guards exactly.
export function suggestOverlay(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
  stateDir: string = DEFAULT_STATE_DIR,
): string {
  const blocks: string[] = [];
  for (const id of Object.keys(cfg.tiers)) {
    const adapter = adapters.find((a) => a.id === id);
    if (!adapter?.listModels) continue;      // no adapter / no list surface → nothing to diff (mirror modelLints)
    const h = health[id];
    const detected = h?.models ?? [];
    if (detected.length === 0) continue;     // no detection data → don't guess a delta
    const configured = Object.keys(cfg.tiers[id].models);
    const date = h?.modelsDetectedAt?.split("T")[0]; // best-effort day stamp
    const detNote = date ? ` (detected ${date})` : "";

    const lines: string[] = [];
    // Tombstones: configured ids the CLI no longer reports. Ids are operator-authored (from cfg) → MODEL_ID_RE only.
    for (const model of configured) {
      if (detected.includes(model) || !MODEL_ID_RE.test(model)) continue;
      lines.push(`      ${model}: null   # tombstone: ${id} no longer reports this id${detNote}${referenceWarning(cfg, id, model)}`);
    }
    // Additions: detected ids not in cfg. WHOLE line commented, no tier (MODEL-06). Ids come from an external
    // CLI → MODEL_ID_RE (defense-in-depth, T-21-01) + the variant filter (cursor's ~193 parameterized ids).
    // RELATIONAL gate (no capability judgment — "looks like an embedding model" is auto-tiering's cousin, the
    // NaN-routing class the v1.5 decision forbids): a detected id is suggested iff it shares a provider prefix
    // (clause a) OR a canonical segment (clause b, the RENAME case: opencode/glm-5.2 ⇒ zai-coding-plan/glm-5.2)
    // with some configured id. Everything else collapses into ONE counted summary — never dropped silently.
    // NB: the bare "" prefix is a real match key on purpose. codex's whole namespace is unprefixed
    // (gpt-5.6-sol, gpt-5.5), so "" is how a detected gpt-5.7-nova surfaces as an upgrade of a configured
    // gpt-5.6-sol — the MODEL-05 worked example. The cost is that an adapter with ONE bare configured id
    // (cursor's composer-2.5) admits every unprefixed detected id; those collapse into the counted summary,
    // not silently. ponytail: not worth a per-adapter heuristic to quiet cursor at the price of codex signal.
    const cfgPrefixes = new Set(configured.map(providerPrefix));
    const cfgCanon = new Set(configured.map(canonical));
    let omitted = 0;
    for (const model of detected) {
      if (configured.includes(model) || !MODEL_ID_RE.test(model) || LINT_VARIANT_RE.test(model)) continue;
      if (!cfgPrefixes.has(providerPrefix(model)) && !cfgCanon.has(canonical(model))) { omitted++; continue; }
      lines.push(`      # ${model}: ???   #${date ? ` detected ${date} —` : ""} classify per benchmark policy (AA Index + SWE-bench Pro, dated), then uncomment`);
    }
    if (omitted) lines.push(`      # (+${omitted} other detected id${omitted === 1 ? "" : "s"} not related to your configured models — see ${stateDir}/doctor.json)`);
    if (lines.length) blocks.push(`  ${id}:\n    models:\n${lines.join("\n")}`);
  }
  if (blocks.length === 0) return "";
  return `# paste into ${stateDir}/config.yaml — tickmarkr prints this, it never applies it\ntiers:\n${blocks.join("\n")}\n`;
}

// Purely relational id split for the addition gate (see suggestOverlay). Local, not exported: this is NOT a
// global identity concept — src/gates/review.ts has its own local modelId(), deliberately not shared.
// providerPrefix("zai/glm-5.2") === "zai"; providerPrefix("gpt-5.5") === "" (bare ids share the "" prefix).
const providerPrefix = (id: string): string => { const i = id.lastIndexOf("/"); return i < 0 ? "" : id.slice(0, i); };
// canonical("zai-coding-plan/glm-5.2") === "glm-5.2" — the rename-detecting segment.
const canonical = (id: string): string => { const i = id.lastIndexOf("/"); return i < 0 ? id : id.slice(i + 1); };

// A tombstoned id that a routing.map pin / judge / consult still names (on the same adapter) would leave a
// dangling reference — surface it inline so the operator remaps before deleting the seed.
function referenceWarning(cfg: TickmarkrConfig, adapterId: string, model: string): string {
  const refs: string[] = [];
  for (const [shape, entry] of Object.entries(cfg.routing.map)) {
    if (entry.pin?.via === adapterId && entry.pin.model === model) refs.push(`routing.map.${shape}.pin`);
  }
  if (cfg.judge.adapter === adapterId && cfg.judge.model === model) refs.push("judge");
  if (cfg.consult.adapter === adapterId && cfg.consult.model === model) refs.push("consult");
  return refs.length ? `  # WARNING: still referenced by ${refs.join(", ")} — remap before removing` : "";
}

/** Unclassified models surfaced for fleet screen 2 (doctor matrix math, no tier fabrication). */
export function fleetUnclassifiedModels(
  cfg: TickmarkrConfig,
  health: Record<string, AuthHealth>,
  adapters: WorkerAdapter[],
): { adapter: string; model: string; detectedAt?: string }[] {
  const out: { adapter: string; model: string; detectedAt?: string }[] = [];
  for (const id of Object.keys(cfg.tiers)) {
    if (!adapters.some((a) => a.id === id)) continue;
    const h = health[id];
    const detected = h?.models ?? [];
    if (!detected.length) continue;
    const configured = new Set(Object.keys(cfg.tiers[id].models));
    const date = h?.modelsDetectedAt?.split("T")[0];
    for (const model of detected) {
      if (configured.has(model) || LINT_VARIANT_RE.test(model)) continue;
      out.push({ adapter: id, model, detectedAt: date });
    }
  }
  return out;
}
