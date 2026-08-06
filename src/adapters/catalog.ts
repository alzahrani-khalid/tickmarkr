import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursorAgent } from "./cursor-agent.js";
import { grok } from "./grok.js";
import { kimi } from "./kimi.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import type { WorkerAdapter } from "./types.js";

export const CLI_NAME_RE = /^[a-z0-9-]+$/;

const ListModelsSchema = z.object({
  argv: z.array(z.string()).min(1),
  parser: z.enum(["lines", "pi-table", "json"]),
  path: z.string().min(1).optional(),
}).strict();

export const CliDriveSchema = z.object({
  headless: z.string().min(1),
  interactive: z.string().min(1).nullable(),
  listModels: ListModelsSchema.optional(),
}).strict().superRefine((drive, ctx) => {
  for (const [field, template] of [["headless", drive.headless], ["interactive", drive.interactive]] as const) {
    if (template === null) continue;
    for (const placeholder of ["{promptFile}", "{model}"]) {
      if (!template.includes(placeholder)) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} must contain ${placeholder}` });
      }
    }
  }
});

const CliEntryBaseSchema = z.object({
  id: z.string().regex(CLI_NAME_RE, "id must match [a-z0-9-]+"),
  binary: z.string().regex(CLI_NAME_RE, "binary must match [a-z0-9-]+"),
  // A declarative drive may execute `--version`; its first line must identify the expected CLI.
  // Advisory entries carry the field too so shipped and operator data have one schema, but never use it.
  identity: z.string().min(1).refine((source) => {
    try {
      new RegExp(source);
      return true;
    } catch {
      return false;
    }
  }, "identity must be a valid regular expression"),
  vendor: z.string().min(1).nullable(),
}).strict();

export const CliEntrySchema = CliEntryBaseSchema.extend({
  drive: CliDriveSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.drive && entry.vendor === null) {
    ctx.addIssue({
      code: "custom",
      path: ["vendor"],
      message: "a drive contract requires a vendor until per-model vendor configuration lands",
    });
  }
});

export type DeclarativeCliDrive = z.infer<typeof CliDriveSchema>;
export type NativeCliDrive = { adapter: WorkerAdapter };
export type CliDrive = DeclarativeCliDrive | NativeCliDrive;
export type CliEntry = z.infer<typeof CliEntryBaseSchema> & { drive?: CliDrive };

export function isNativeCliDrive(drive: CliDrive | undefined): drive is NativeCliDrive {
  return !!drive && "adapter" in drive;
}

function validateCliEntry(entry: CliEntry): CliEntry {
  if (!isNativeCliDrive(entry.drive)) return CliEntrySchema.parse(entry);
  const { drive, ...fields } = entry;
  const base = CliEntryBaseSchema.parse(fields);
  if (drive.adapter.id !== base.id || drive.adapter.vendor !== base.vendor) {
    throw new Error(`native drive identity mismatch for ${base.id}`);
  }
  return { ...base, drive };
}

// Package-owned, deterministic order. This is the sole shipped definition array: candidate-name
// compatibility and advisory/routable projections below are all derived from it.
const native = (adapter: WorkerAdapter, binary: string): CliEntry => ({
  id: adapter.id,
  binary,
  identity: ".+",
  vendor: adapter.vendor,
  drive: { adapter },
});

export const CLI_CATALOG: readonly CliEntry[] = [
  // Preserve the historical tie-break order byte-for-byte: pi, grok and kimi stay last among the
  // native adapters, with kimi after grok. Catalog-driven adapters append after this sequence.
  native(claudeCode, "claude"),
  native(codex, "codex"),
  native(cursorAgent, "cursor-agent"),
  native(opencode, "opencode"),
  native(pi, "pi"),
  native(grok, "grok"),
  native(kimi, "kimi"),
  "gemini", "qwen", "aider", "goose", "amp", "droid", "auggie", "crush", "omp",
].flatMap((entry) => typeof entry === "string"
  ? [{ id: entry, binary: entry, identity: ".+", vendor: null } satisfies CliEntry]
  : [entry]);
export const SHIPPED_CLI_CATALOG = CLI_CATALOG;

const OperatorCatalogSchema = z.union([
  z.array(CliEntrySchema),
  z.object({ clis: z.array(CliEntrySchema) }).strict().transform(({ clis }) => clis),
]);

export function parseOperatorCliCatalog(text: string): CliEntry[] {
  return OperatorCatalogSchema.parse(parseYaml(text));
}

/** The one operator-owned definition file. Never relative to a repository and never enumerated. */
export function operatorCliCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configRoot = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(configRoot, "tickmarkr", "clis.yaml");
}

export function loadOperatorCliCatalog(path = operatorCliCatalogPath()): CliEntry[] {
  if (!isAbsolute(path)) throw new Error(`operator CLI catalog path must be absolute: ${path}`);
  try {
    return parseOperatorCliCatalog(readFileSync(path, "utf8"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
      || (error instanceof Error && error.message.includes("ENOENT"));
    if (missing) return [];
    throw error;
  }
}

export interface CatalogEntriesOptions {
  shipped?: readonly CliEntry[];
  operatorYaml?: string | null;
  operatorPath?: string | false;
  herdrNames?: readonly string[];
}

/**
 * Compose package data, the single operator YAML layer, and Herdr name nominations into one array.
 * Herdr cannot define or override a drive contract: valid tokens nominate only names not already
 * defined. Invalid tokens are discarded before any resolver can receive them.
 */
export function catalogEntries(opts: CatalogEntriesOptions = {}): CliEntry[] {
  const shipped = [...(opts.shipped ?? SHIPPED_CLI_CATALOG)].map(validateCliEntry);
  const operator = opts.operatorYaml !== undefined
    ? opts.operatorYaml === null ? [] : parseOperatorCliCatalog(opts.operatorYaml)
    : opts.operatorPath === false ? [] : loadOperatorCliCatalog(opts.operatorPath);
  const definitions = [...shipped, ...operator];
  const claimed = new Set(definitions.map((entry) => entry.binary));
  const nominated: CliEntry[] = [];
  for (const name of opts.herdrNames ?? []) {
    if (!CLI_NAME_RE.test(name) || claimed.has(name)) continue;
    claimed.add(name);
    nominated.push({ id: name, binary: name, identity: ".+", vendor: null });
  }
  return [...definitions, ...nominated];
}

export interface CliCatalogConflict {
  binary: string;
  ids: string[];
}

export function projectCliEntries(entries: readonly CliEntry[]): {
  routable: CliEntry[];
  advisory: CliEntry[];
  conflicts: CliCatalogConflict[];
} {
  const parsed = entries.map(validateCliEntry);
  const claims = new Map<string, CliEntry[]>();
  for (const entry of parsed) claims.set(entry.binary, [...(claims.get(entry.binary) ?? []), entry]);
  const conflicts = [...claims]
    .filter(([, owners]) => owners.length > 1)
    .map(([binary, owners]) => ({ binary, ids: owners.map((entry) => entry.id).sort() }))
    .sort((a, b) => a.binary.localeCompare(b.binary));
  const conflicted = new Set(conflicts.map((conflict) => conflict.binary));
  const eligible = parsed.filter((entry) => !conflicted.has(entry.binary));
  return {
    routable: eligible.filter((entry) => entry.drive !== undefined),
    advisory: eligible.filter((entry) => entry.drive === undefined),
    conflicts,
  };
}

export interface CliPresence {
  id: string;
  binary: string;
  path: string;
  routable: boolean;
}

export interface CliDiscoveryDeps {
  resolveBinary: (binary: string) => { resolved?: string; all: string[] };
  execute?: (entry: CliEntry, path: string) => unknown;
}

/** Resolve presence for both projections; only a declared drive contract licenses target execution. */
export function discoverCliEntries(
  entries: readonly CliEntry[],
  deps: CliDiscoveryDeps,
): { present: CliPresence[]; conflicts: CliCatalogConflict[] } {
  const projected = projectCliEntries(entries);
  const present: CliPresence[] = [];
  for (const entry of [...projected.routable, ...projected.advisory]) {
    const { resolved } = deps.resolveBinary(entry.binary);
    if (!resolved) continue;
    if (entry.drive) deps.execute?.(entry, resolved);
    present.push({ id: entry.id, binary: entry.binary, path: resolved, routable: entry.drive !== undefined });
  }
  return { present, conflicts: projected.conflicts };
}
