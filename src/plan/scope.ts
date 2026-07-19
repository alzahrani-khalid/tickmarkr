import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { discoverChannels, getAdapter, probeAll } from "../adapters/registry.js";
import type { WorkerAdapter } from "../adapters/types.js";
import { compileNative, LEGACY_PREFIX } from "../compile/native.js";
import type { TickmarkrConfig } from "../config/config.js";
import { pickDriver } from "../drivers/index.js";
import type { ExecutorDriver } from "../drivers/types.js";
import { extractJson, runLlm } from "../gates/llm.js";
import { TaskSchema } from "../graph/schema.js";
import { route } from "../route/router.js";
import { scopePrompt } from "./prompt.js";

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

export async function scopeIntent(intentFile: string, repoRoot: string, options: ScopeOptions): Promise<ScopeResult> {
  if (!existsSync(intentFile)) throw new Error(`no such intent file: ${intentFile}`);
  const intent = readFileSync(intentFile, "utf8");
  const unanswered = clarificationGate(intent);
  if (unanswered.length) {
    throw new Error(`unanswered blocking questions (${unanswered.length}):\n${unanswered.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }
  const specFile = specPathForIntent(intentFile);
  if (existsSync(specFile) && !options.force) throw new Error(`${specFile} already exists; pass --force to overwrite it`);

  const health = await probeAll(options.adapters);
  const channels = discoverChannels(options.cfg, options.adapters, health);
  const planningTask = TaskSchema.parse({
    id: "SCOPE", title: "Draft native spec", goal: "Draft a compiled native spec", shape: "spec", complexity: 7,
    acceptance: [{ oracle: "judge", text: "Every requirement maps to a task with typed acceptance oracles" }],
  });
  const assignment = route(planningTask, options.cfg, channels).assignment;
  const adapter = getAdapter(assignment.adapter, options.adapters);
  const driver = options.cfg.visibility.llm === "pane" ? options.driver ?? pickDriver(options.cfg) : undefined;
  const name = basename(specFile, ".spec.md");
  let prompt = scopePrompt(intent);
  for (let attempts = 1; attempts <= 3; attempts++) {
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
      if (attempts === 3) throw new Error(`scope draft failed after 2 repair retries:\n${message}`);
      prompt = scopePrompt(intent, { draft, error: message });
      continue;
    }
    writeFileSync(specFile, draft, options.force ? undefined : { flag: "wx" });
    return { specFile, tasks, attempts };
  }
  throw new Error("unreachable");
}
