import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { discoverChannels, getAdapter, probeAll, readDoctor } from "../adapters/registry.js";
import type { Assignment, AuthHealth, BillingChannel, WorkerAdapter } from "../adapters/types.js";
import { compileNative, LEGACY_PREFIX } from "../compile/native.js";
import type { TickmarkrConfig } from "../config/config.js";
import { pickDriver } from "../drivers/index.js";
import type { ExecutorDriver } from "../drivers/types.js";
import { extractJson, runLlm } from "../gates/llm.js";
import { type Task, TaskSchema } from "../graph/schema.js";
import { route } from "../route/router.js";
import { scopePrompt } from "./prompt.js";

// R11/R45 (C10): the drafting loop's hard ceiling — shared by the loop itself and the preview
// disclosure so the two can never state different budgets.
export const MAX_SCOPE_ATTEMPTS = 3;

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;
const ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(?:[QA]\d*:\s*)?(.+?)\s*$/;

function sectionItems(source: string, heading: RegExp): string[] {
  const items: string[] = [];
  let active = false;
  for (const line of source.split("\n")) {
    const h = line.match(HEADING_RE);
    if (h) {
      active = heading.test(h[1]);
      continue;
    }
    if (!active) continue;
    const item = line.match(ITEM_RE)?.[1].trim();
    if (item) items.push(item);
  }
  return items;
}

export function clarificationGate(intent: string): string[] {
  const questions = sectionItems(intent, /^blocking questions?$/i);
  if (questions.length > 3) throw new Error(`intent has ${questions.length} blocking questions; at most 3 blocking questions are allowed`);
  const answers = sectionItems(intent, /^(?:blocking )?answers?$/i);
  return questions.filter((_, i) => !answers[i] || /^(?:tbd|todo|unanswered|\?)$/i.test(answers[i]));
}

export interface ScopeOptions {
  cfg: TickmarkrConfig;
  adapters: WorkerAdapter[];
  driver?: ExecutorDriver;
  force?: boolean;
  // R11/R45 (C10 repair): the candidate disclosed by previewScope and confirmed by the operator.
  // When set, dispatch is BOUND to this exact adapter:model — a fresh probe/reroute picking a
  // different channel fails loud instead of silently authoring against an unconfirmed candidate.
  candidate?: ScopeCandidate;
}

export interface ScopeResult {
  specFile: string;
  tasks: number;
  attempts: number;
}

export function specPathForIntent(intentFile: string): string {
  const ext = extname(intentFile);
  const stem = basename(intentFile, ext).replace(/\.intent$/i, "");
  return join(dirname(intentFile), `${stem}.spec.md`);
}

function section(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, "i").test(line));
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && HEADING_RE.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function extractDraft(raw: string): string {
  const clean = raw.replace(/\nTICKMARKR_EXIT:\d[\s\S]*$/, "").trim();
  try {
    const value = JSON.parse(clean);
    if (typeof value === "string") return value;
  } catch {
    // normal adapters return Markdown, not JSON strings
  }
  const json = extractJson<{ spec?: unknown; draft?: unknown }>(clean);
  const value = json?.spec ?? json?.draft;
  if (typeof value === "string") return value;
  const fenced = [...clean.matchAll(/```(?:markdown|md)?\s*\n([\s\S]*?)```/gi)].at(-1)?.[1];
  if (fenced) return fenced;
  const marker = clean.search(new RegExp(`<!--\\s*(?:tickmarkr|${LEGACY_PREFIX}):spec`));
  return (marker === -1 ? clean : clean.slice(marker)).trimEnd() + "\n";
}

function validateDraft(draft: string): number {
  if (!/^<!--\s*tickmarkr:spec/.test(draft)) throw new Error("draft is missing the tickmarkr native marker");
  if (!section(draft, "Assumptions").trim()) throw new Error("draft is missing explicit assumptions");
  const requirements = [...new Set(section(draft, "Requirements").match(/\bREQ-\d{2}\b/g) ?? [])];
  if (!requirements.length) throw new Error("draft has no REQ-nn requirements");

  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-scope-compile-"));
  const file = join(dir, "draft.spec.md");
  try {
    writeFileSync(file, draft);
    const graph = compileNative(file);
    const trace = section(draft, "Traceability");
    for (const req of requirements) {
      const mapped = trace.split("\n").some((line) => line.includes(req) && graph.tasks.some((task) => new RegExp(`\\b${task.id}\\b`).test(line)));
      if (!mapped) throw new Error(`${req} is not mapped to a task in Traceability`);
    }
    const plain = graph.tasks.flatMap((task) => task.acceptance).filter((item) => typeof item === "string");
    if (plain.length) throw new Error(`draft has ${plain.length} untyped acceptance item${plain.length === 1 ? "" : "s"}`);
    return graph.tasks.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scopePlanningTask(): Task {
  return TaskSchema.parse({
    id: "SCOPE", title: "Draft native spec", goal: "Draft a compiled native spec", shape: "spec", complexity: 7,
    acceptance: [{ oracle: "judge", text: "Every requirement maps to a task with typed acceptance oracles" }],
  });
}

function localValidate(intentFile: string): { intent: string; specFile: string } {
  if (!existsSync(intentFile)) throw new Error(`no such intent file: ${intentFile}`);
  const intent = readFileSync(intentFile, "utf8");
  const unanswered = clarificationGate(intent);
  if (unanswered.length) {
    throw new Error(`unanswered blocking questions (${unanswered.length}):\n${unanswered.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }
  return { intent, specFile: specPathForIntent(intentFile) };
}

export interface ScopeCandidate { adapter: string; model: string }

export interface ScopePreview {
  intentFile: string;
  specFile: string;
  specExists: boolean;
  cached: boolean;
  candidate?: ScopeCandidate;
  authoringBudget: number;
  probeCalls: number;
}

/**
 * R11/R45 (C10): local-only disclosure — intent/clarification checks and a candidate read off the
 * doctor cache, never a fresh probe or a model turn. `readDoctor` and `discoverChannels`/`route` are
 * pure reads over that cache, so this never touches an adapter.
 */
export function previewScope(intentFile: string, repoRoot: string, options: { cfg: TickmarkrConfig; adapters: WorkerAdapter[] }): ScopePreview {
  const { specFile } = localValidate(intentFile);
  const cachedHealth = readDoctor(repoRoot);
  let candidate: ScopeCandidate | undefined;
  if (cachedHealth) {
    const channels = discoverChannels(options.cfg, options.adapters, cachedHealth);
    if (channels.length) {
      try {
        const assignment = route(scopePlanningTask(), options.cfg, channels).assignment;
        // Review fix (finding 1): routing.allowUnverifiedModels lets discoverChannels/route pick a
        // channel whose modelAuth is simply absent (unknown) — that is routing PERMISSION, not proof
        // of health. Only disclose a candidate when the doctor cache actually marked this exact model
        // authed; otherwise this stays the "unknown" case below, never "installed/authed".
        if (cachedHealth[assignment.adapter]?.modelAuth?.[assignment.model]?.authed === true) {
          candidate = { adapter: assignment.adapter, model: assignment.model };
        }
      } catch {
        // no eligible candidate in the cached snapshot — stays unknown, never "unreachable"
      }
    }
  }
  return {
    intentFile, specFile, specExists: existsSync(specFile), cached: cachedHealth !== null,
    candidate, authoringBudget: MAX_SCOPE_ATTEMPTS, probeCalls: options.adapters.length,
  };
}

export function formatScopePreview(preview: ScopePreview): string {
  const candidateLine = preview.candidate
    ? `cached candidate: ${preview.candidate.adapter}:${preview.candidate.model} (installed/authed at last doctor run)`
    : `cached candidate: unknown (${preview.cached ? "no eligible channel in the doctor cache" : "no doctor cache — run tickmarkr doctor"})`;
  return [
    `tickmarkr scope --preview ${preview.intentFile}:`,
    candidateLine,
    `output destination: ${preview.specFile}${preview.specExists ? " (exists — active scope needs --force)" : ""}`,
    `authoring-call budget: up to ${preview.authoringBudget} call${preview.authoringBudget === 1 ? "" : "s"} if confirmed`,
    `probe calls: ${preview.probeCalls} (disclosed separately — one per configured adapter, only on confirmed active scope)`,
    "cache policy: read-only; no adapter was probed and no model was called",
  ].join("\n");
}

// R11/R45 (C10 repair): a confirmed candidate is a promise made to the operator — find that exact
// adapter:model in the freshly probed channels, or fail loud. Never let a stale-cache candidate
// silently fall through to a fresh route() that could reroute to a different channel unconfirmed.
function bindCandidate(candidate: ScopeCandidate, channels: BillingChannel[]): Assignment {
  const c = channels.find((ch) => ch.adapter === candidate.adapter && ch.model === candidate.model);
  if (!c) {
    throw new Error(
      `confirmed candidate ${candidate.adapter}:${candidate.model} is no longer available after a fresh probe ` +
      `(doctor found: ${channels.map((ch) => `${ch.adapter}:${ch.model}`).join(", ") || "(nothing)"}) — ` +
      "re-run scope --preview and confirm again",
    );
  }
  return { adapter: c.adapter, model: c.model, channel: c.channel, tier: c.tier };
}

// Adapter-level probes establish the current installation/auth state, but shipped adapters do not
// return per-model verdicts from probe(). Preserve cached verdicts only where that fresh snapshot is
// silent; an explicit fresh per-model verdict still wins, as do fresh adapter-level failures.
function mergeCachedModelAuth(
  freshHealth: Record<string, AuthHealth>,
  cachedHealth: Record<string, AuthHealth> | null,
): Record<string, AuthHealth> {
  if (!cachedHealth) return freshHealth;
  return Object.fromEntries(Object.entries(freshHealth).map(([adapter, fresh]) => {
    const cachedModelAuth = cachedHealth[adapter]?.modelAuth;
    if (!cachedModelAuth) return [adapter, fresh];
    return [adapter, { ...fresh, modelAuth: { ...cachedModelAuth, ...fresh.modelAuth } }];
  }));
}

export async function scopeIntent(intentFile: string, repoRoot: string, options: ScopeOptions): Promise<ScopeResult> {
  const { intent, specFile } = localValidate(intentFile);
  if (existsSync(specFile) && !options.force) throw new Error(`${specFile} already exists; pass --force to overwrite it`);

  const health = mergeCachedModelAuth(await probeAll(options.adapters), readDoctor(repoRoot));
  const channels = discoverChannels(options.cfg, options.adapters, health);
  const assignment = options.candidate
    ? bindCandidate(options.candidate, channels)
    : route(scopePlanningTask(), options.cfg, channels).assignment;
  const adapter = getAdapter(assignment.adapter, options.adapters);
  const driver = options.cfg.visibility.llm === "pane" ? options.driver ?? pickDriver(options.cfg) : undefined;
  const name = basename(specFile, ".spec.md");
  let prompt = scopePrompt(intent);
  for (let attempts = 1; attempts <= MAX_SCOPE_ATTEMPTS; attempts++) {
    const via = driver ? {
      driver, name: `scope-${name}-${attempts}-${adapter.id}`, label: "SCOPE",
      keep: options.cfg.visibility.keepPanes === "forever",
    } : undefined;
    const draft = extractDraft(await runLlm(adapter, assignment.model, prompt, repoRoot, via));
    let tasks: number;
    try {
      tasks = validateDraft(draft);
    } catch (error) {
      const message = (error as Error).message;
      if (attempts === MAX_SCOPE_ATTEMPTS) throw new Error(`scope draft failed after ${MAX_SCOPE_ATTEMPTS - 1} repair retries:\n${message}`);
      prompt = scopePrompt(intent, { draft, error: message });
      continue;
    }
    writeFileSync(specFile, draft, options.force ? undefined : { flag: "wx" });
    return { specFile, tasks, attempts };
  }
  throw new Error("unreachable");
}
