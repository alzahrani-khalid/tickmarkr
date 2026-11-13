// Everything the fleet screen reads from disk, in one place: the two config layers, the doctor
// results, the models a probe saw for the first time, the last run's journal, and the answers of no.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { readCachedCatalog } from "../adapters/catalog-remote.js";
import { readDoctor, readModelsFirstSeen } from "../adapters/registry.js";
import type { AuthHealth, WorkerAdapter } from "../adapters/types.js";
import { globalConfigDir, loadConfigWithMode, ownRepoOverlayPath, repoOverlayPath, type TickmarkrConfig } from "../config/config.js";
import { stateDirName } from "../graph/graph.js";
import { SHAPES, type Shape } from "../graph/schema.js";
import { BENCHMARK_BANDS } from "../route/benchmark-tier.js";
import { modelProvider } from "../route/preference.js";
import { shortName } from "./model.js";
import { type Need, needSignature, type NewModel, type RunDeath } from "./needs.js";
import type { ScreenSource } from "./screen.js";

const text = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
const NEW_FOR_DAYS = 30;

/** A need's identity for "do not ask again": its id and its words, so it returns when either changes. */
export { needSignature };
const answersPath = (repoRoot: string): string => join(repoRoot, stateDirName(repoRoot), "fleet-answers.json");
export function readDismissed(repoRoot: string): Set<string> {
  try { return new Set((JSON.parse(text(answersPath(repoRoot)) || "{}") as { no?: string[] }).no ?? []); } catch { return new Set(); }
}
function writeDismissed(repoRoot: string, no: string[]): void {
  const path = answersPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ no }, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
}
export function dismissNeed(repoRoot: string, need: Pick<Need, "id" | "title" | "ask">): void {
  writeDismissed(repoRoot, [...new Set([...readDismissed(repoRoot), needSignature(need)])]);
}
/** `u` after a no: the item is asked again. */
export function restoreNeed(repoRoot: string, signature: string): void {
  writeDismissed(repoRoot, [...readDismissed(repoRoot)].filter((s) => s !== signature));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
/**
 * doctor.json as far as it is well formed. A person, an older version or a crash may have left the
 * file in any state, and the screen must not die on it or read it kindly: an entry or a field of the
 * wrong type is dropped, so it reads as not probed and never as working. Keys that are not probe
 * results (the gateway record, the key-prompt skip) pass through untouched.
 */
export function cleanHealth(raw: unknown): Record<string, AuthHealth> | null {
  const file = record(raw);
  if (!file) return null;
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(file)) {
    const e = record(value);
    if (!e) continue;
    if (!("installed" in e)) { out[id] = e; continue; }
    const auth: Record<string, unknown> = {};
    for (const [model, v] of Object.entries(record(e.modelAuth) ?? {})) {
      const m = record(v);
      if (!m || typeof m.authed !== "boolean") continue;
      const { reason, probedAt, identity, failure, ...rest } = m;
      auth[model] = { ...rest, ...(typeof reason === "string" ? { reason } : {}), ...(typeof probedAt === "string" && !Number.isNaN(Date.parse(probedAt)) ? { probedAt } : {}),
        ...(typeof identity === "string" ? { identity } : {}), ...(typeof failure === "string" ? { failure } : {}) };
    }
    const { servable, modelIdentities, ...rest } = e;
    const identities = record(modelIdentities);
    out[id] = { ...rest, installed: e.installed === true, authed: e.authed === true, models: strings(e.models), ...(record(e.modelAuth) ? { modelAuth: auth } : {}),
      ...(Array.isArray(servable) ? { servable: strings(servable) } : {}),
      ...(identities ? { modelIdentities: Object.fromEntries(Object.entries(identities).filter(([, x]) => typeof x === "string")) } : {}) };
  }
  return out as Record<string, AuthHealth>;
}

/** The latest run's models that ran out of quota with nothing to fail over to. */
export function lastRunDeaths(repoRoot: string): RunDeath[] {
  const runs = join(repoRoot, stateDirName(repoRoot), "runs");
  if (!existsSync(runs)) return [];
  const runId = readdirSync(runs).filter((d) => d.startsWith("run-")).sort().at(-1);
  if (!runId) return [];
  // a line that is not an event (not JSON, or JSON that is not an object) is skipped, as a torn line is
  const events = text(join(runs, runId, "journal.jsonl")).split("\n").flatMap((l) => {
    let e: Record<string, unknown> | undefined;
    try { e = l ? record(JSON.parse(l)) : undefined; } catch { e = undefined; }
    return e ? [{ event: typeof e.event === "string" ? e.event : undefined, taskId: typeof e.taskId === "string" ? e.taskId : undefined, data: record(e.data) }] : [];
  });
  let shapeOf = new Map<string, Shape>();
  try {
    const graph = JSON.parse(text(join(runs, runId, "graph.json")) || "{}") as { tasks?: Array<{ id: string; shape: Shape }> };
    shapeOf = new Map((graph.tasks ?? []).map((t) => [t.id, t.shape]));
  } catch { /* a run without a readable graph still names its dead seat */ }
  const seatOf = (a: unknown): string | undefined => (a && typeof a === "object" && "adapter" in a && "model" in a ? `${String(a.adapter)}:${String(a.model)}` : undefined);
  const dispatched = new Map<string, Set<Shape>>();
  for (const e of events) {
    const seat = e.event === "task-dispatch" ? seatOf(e.data?.assignment) : undefined;
    const shape = e.taskId ? shapeOf.get(e.taskId) : undefined;
    if (seat && shape) dispatched.set(seat, new Set([...(dispatched.get(seat) ?? []), shape]));
  }
  const out = new Map<string, RunDeath>();
  for (const e of events) {
    if (e.event !== "quota-failover" || e.data?.to || typeof e.data?.from !== "string") continue;
    const seat = e.data.from;
    const cur = out.get(seat) ?? { runId, seat, shapes: [], tasks: [] };
    const own = e.taskId ? shapeOf.get(e.taskId) : undefined;
    const shapes = new Set<Shape>([...cur.shapes, ...(own ? [own] : dispatched.get(seat) ?? [])]);
    out.set(seat, { runId, seat, shapes: SHAPES.filter((s) => shapes.has(s)), tasks: e.taskId ? [...new Set([...cur.tasks, e.taskId])] : cur.tasks });
  }
  return [...out.values()].filter((d) => d.shapes.length);
}

// ponytail: a slug match on the Artificial Analysis table in the catalog cache. The catalog's own
// resolver joins through models.dev, which lags a new model by days; switch when the classifier is wired.
function intelligence(catalog: unknown): (id: string) => { score: number; name: string } | undefined {
  // optional evidence read defensively: a malformed table, row or field is skipped, never thrown on
  const data = record(record(catalog)?.artificialAnalysis)?.data;
  const rows: unknown[] = Array.isArray(data) ? data : [];
  const bySlug = new Map(rows.flatMap((raw) => {
    const r = record(raw), s = record(r?.evaluations)?.artificial_analysis_intelligence_index;
    if (!r || typeof r.slug !== "string" || !r.slug || typeof s !== "number" || !Number.isFinite(s)) return [];
    return [[r.slug, { score: s, name: (typeof r.name === "string" ? r.name : r.slug).replace(/\s*\(.*$/, "") }] as const];
  }));
  const slug = (id: string): string => id.slice(id.lastIndexOf("/") + 1).replace(/\./g, "-");
  // rowOf, the one way a model meets its row: (1) the row of the identity exactly, effort suffix
  // included; else (2) with no suffix or a "high" one, the row of the base identity; else (3) none
  return (id) => {
    const exact = bySlug.get(slug(id));
    if (exact) return exact;
    const eff = EFFORT.exec(slug(id));
    return eff && eff[1] === "high" ? bySlug.get(slug(id).slice(0, eff.index)) : undefined;
  };
}
const EFFORT = /-(low|medium|high|xhigh|max)(-fast)?$/;

/** Models a CLI began to list within the last 30 days that hold no tier, with the tier one benchmark gives them. */
export function newModels(repoRoot: string, cfg: TickmarkrConfig, health: Record<string, AuthHealth> | null, now: number): NewModel[] {
  if (!health) return [];
  // the record is read as defensively as the results: only a model with a date string counts
  const seen = Object.entries(record(readModelsFirstSeen(repoRoot)) ?? {}).flatMap(([adapter, models]) =>
    Object.entries(record(models) ?? {}).flatMap(([model, at]) => (typeof at === "string" && !Number.isNaN(Date.parse(at)) ? [[adapter, model, at] as const] : [])));
  const score = intelligence(readCachedCatalog(repoRoot).catalog);
  let best = { score: 0, model: "" };
  for (const [adapter, t] of Object.entries(cfg.tiers)) for (const model of Object.keys(t.models)) {
    const id = health[adapter]?.modelAuth?.[model]?.identity ?? model;
    const s = score(id)?.score;
    if (s !== undefined && s > best.score) best = { score: s, model: shortName(id) };
  }
  if (!best.score) return [];
  const groups = new Map<string, NewModel>();
  for (const [adapter, model, at] of seen) {
    if (!at || now - Date.parse(at) > NEW_FOR_DAYS * 86_400_000) continue;
    if (cfg.tiers[adapter]?.models[model] || !health[adapter]?.models.includes(model)) continue;
    const bare = model.slice(model.lastIndexOf("/") + 1);
    const eff = EFFORT.exec(bare);
    const id = eff ? bare.slice(0, eff.index) : bare;
    const s = score(model)?.score;
    const g = groups.get(id) ?? { id, name: score(id)?.name ?? score(model)?.name ?? id, provider: modelProvider(model, "unknown"), paths: [], score: 0, best, tier: "cheap" as const, needs: 0, firstSeen: at.slice(0, 10) };
    g.paths.push({ adapter, model, ...(s !== undefined ? { score: s } : {}) });
    g.score = Math.max(g.score, s ?? 0);
    groups.set(id, g);
  }
  return [...groups.values()].filter((g) => g.score > 0).map((g) => {
    const ratio = g.score / best.score;
    const tier = ratio >= BENCHMARK_BANDS.frontier.aa ? "frontier" as const : ratio >= BENCHMARK_BANDS.mid.aa ? "mid" as const : "cheap" as const;
    const needs = tier === "cheap" ? 0 : BENCHMARK_BANDS[tier].aa;
    // each path is offered on its own effort's score: a variant without one, or below the tier, is not
    return { ...g, tier, needs, paths: g.paths.filter((p) => p.score !== undefined && p.score / best.score >= needs) };
  }).filter((g) => g.tier !== "cheap" && g.paths.length).sort((a, b) => b.score - a.score);
}

export interface FleetSourceOptions { globalDir?: string; adapters: WorkerAdapter[]; now?: number }
export function loadFleetSource(repoRoot: string, opts: FleetSourceOptions): ScreenSource {
  const globalDir = opts.globalDir ?? globalConfigDir();
  const now = opts.now ?? Date.now();
  const userPath = join(globalDir, "config.yaml");
  const own = ownRepoOverlayPath(repoRoot), read = repoOverlayPath(repoRoot);
  const userText = text(userPath), repoText = text(read);
  const health = cleanHealth(readDoctor(repoRoot));
  let cfg: TickmarkrConfig | undefined;
  try { cfg = loadConfigWithMode(repoRoot, { userOverlayText: userText, repoOverlayText: repoText }).cfg; } catch { cfg = undefined; }
  return {
    inputs: { userText, repoText, health, adapters: opts.adapters, now },
    ctx: { dismissed: readDismissed(repoRoot), lastRun: lastRunDeaths(repoRoot), newModels: cfg ? newModels(repoRoot, cfg, health, now) : [] },
    paths: { user: userPath, repo: own },
    labels: { user: userPath.startsWith(homedir()) ? `~${userPath.slice(homedir().length)}` : userPath, repo: relative(repoRoot, own) },
    ...(read !== own ? { inherited: read } : {}),
  };
}
