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
import { TRUST_DIALOG_VARIANTS, TrustDialogSchema, type WorkerAdapter } from "./types.js";

export const CLI_NAME_RE = /^[a-z0-9-]+$/;

// `field` names the ONE key projected out of an array of objects — a model id and nothing else.
// `{"models":[{…}]}` is the normal shape of a modern CLI's --json output, and without a selector the
// json parser only reads the rarer array-of-bare-strings. The allowlist is the rule, not a comment:
// `cost` (prices have one authority, catalog-remote.ts) and `provider` (vendor landing is a separate
// decision) are not id keys, so no config can name them and no parser call can be typed with them —
// a schema that took any string would let either be harvested as a second source of truth.
export const MODEL_ID_FIELDS = ["id", "selector", "model"] as const;
export type ModelIdField = (typeof MODEL_ID_FIELDS)[number];

const ListModelsSchema = z.object({
  argv: z.array(z.string()).min(1),
  parser: z.enum(["lines", "pi-table", "json"]),
  path: z.string().min(1).optional(),
  field: z.enum(MODEL_ID_FIELDS).optional(),
}).strict().superRefine((listModels, ctx) => {
  // A selector the parser would silently ignore is the same silence this contract exists to end.
  if (listModels.field !== undefined && listModels.parser !== "json") {
    ctx.addIssue({ code: "custom", path: ["field"], message: "field is only read by the json parser" });
  }
});

// v1.89 T1 / OBS-414: a drive contract declares its trust posture or it is not a drive contract.
// `declarativeAdapter()` builds every catalog-driven CLI, so a contract without this field would
// reintroduce the silent opt-out at the one construction site no adapter file covers. Absence gets
// its own operator sentence; a malformed declaration keeps the union's own diagnosis.
// Quote-free by construction: a zod issue reaches the operator as a JSON dump, where an embedded
// double quote is escaped and no longer reads back as the sentence that was written.
export const DRIVE_TRUST_DIALOG_MESSAGE =
  "drive contract must declare trustDialog — either the workspace-trust prompt this CLI renders, captured verbatim as {fingerprint, key}, or {kind: none, reason}";

export const CliDriveSchema = z.object({
  headless: z.string().min(1),
  interactive: z.string().min(1).nullable(),
  trustDialog: z.union(TRUST_DIALOG_VARIANTS, {
    error: (issue) => (issue.input === undefined ? DRIVE_TRUST_DIALOG_MESSAGE : undefined),
  }),
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
  // v1.89 T1 / OBS-414: native adapters carry their declaration in code, so the compiler enforces
  // PRESENCE — it cannot enforce that the bytes are a real capture. The same schema the drive
  // contract uses runs here, on the registry's own construction path, so a blank fingerprint or a
  // prompt that is not a workspace-trust gate is unbuildable from either side of the catalog.
  const trust = TrustDialogSchema.safeParse(drive.adapter.trustDialog);
  if (!trust.success) {
    throw new Error(`invalid trust declaration for ${base.id}: ${trust.error.issues.map((i) => i.message).join("; ")}`);
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
  "gemini", "qwen", "aider", "goose", "amp", "droid", "auggie", "crush",
  {
    id: "omp",
    binary: "omp",
    // PROBE-omp-v189.md, re-recorded by hand 2026-08-07: `omp --version` → `omp/17.2.10`.
    // A prefix match, so a patch bump does not re-open the identity gate.
    identity: "^omp/",
    // omp is a multi-provider gateway; a selected model carries its real vendor in its own prefix.
    vendor: "mixed",
    drive: {
      // The same probe recorded -p as the fail-closed print mode (exit 1 on an unknown model).
      // interactive deliberately omits it: `interactive` is nullable and `headless` is required, so
      // the invisible configuration is the easier one to write — this one is written visible.
      headless: "omp -p --model {model} @{promptFile}",
      interactive: "omp --model {model} @{promptFile}",
      trustDialog: {
        kind: "none",
        reason: "omp 17.2.10 showed no workspace-trust prompt during the recorded interactive probe (PROBE-omp-v189.md, 2026-08-07)",
      },
      // The recorded payload is an OBJECT keyed by models: 370 entries, selector prefixed 370/370
      // and the neighbouring bare `id` prefixed 0/370. Projecting `id` would return 370 plausible
      // ids that route to nothing, so the selector is the only id key this contract may name.
      listModels: { argv: ["models", "ls", "--json"], parser: "json", path: "models", field: "selector" },
    },
  } satisfies CliEntry,
  {
    id: "agy",
    binary: "agy",
    // PROBE-agy-v190.md, recorded by hand 2026-08-13: `agy --version` → `1.1.12`. A bare semver
    // banner, so the identity pins the shape, prefix-matched to survive patch bumps.
    identity: "^\\d+\\.\\d+\\.\\d+",
    // agy (Antigravity) is a multi-provider gateway: its model list spans google, anthropic and
    // openai ids, so a selected model carries its real vendor — same posture as omp.
    vendor: "mixed",
    drive: {
      // PROBE-agy-v190.md: three recorded traps shape every byte of this template. (1) `-p`
      // consumes the NEXT argv as the prompt, so every flag precedes it. (2) tool writes land in
      // cwd ONLY when cwd is workspace-added by ABSOLUTE path — without `--add-dir "$PWD"` (and
      // with a relative `.`) the write is silently redirected to ~/.gemini/antigravity-cli/scratch
      // while the model still claims DONE; dispatch runs through bash -lc, so the literal "$PWD"
      // expands to the worktree at runtime. (3) --print-timeout defaults to 5m0s, which would kill
      // any real worker task. --dangerously-skip-permissions: a permission prompt in print mode
      // has no answerer.
      headless: `agy --add-dir "$PWD" --dangerously-skip-permissions --print-timeout 240m --model {model} -p "$(cat {promptFile})"`,
      // No interactive probe is recorded (PROBE-agy-v190.md names the falsifier) — null keeps the
      // claim honest and the print fallback drives visible panes.
      interactive: null,
      trustDialog: {
        kind: "none",
        reason: "agy 1.1.12 rendered no workspace-trust prompt across five fresh-temp-repo print-mode probes (PROBE-agy-v190.md, 2026-08-13); interactive is null, so no dialog can reach a pane",
      },
      // `agy models` emits `id<TAB>label` rows behind a fetch banner — no parser projects that
      // shape without admitting label words, so the list surface stays undeclared and doctor
      // reports "no model-list surface" (claude-code posture).
    },
  } satisfies CliEntry,
  {
    id: "prime-agent",
    binary: "prime-agent",
    // PROBE-prime-agent-v190.md, recorded by hand 2026-08-13: `prime-agent --version` → `0.7.1`.
    // Bare semver banner — shape-pinned, prefix-matched (agy precedent).
    identity: "^\\d+\\.\\d+\\.\\d+",
    // Multi-provider gateway (anthropic, google, openai model list) — the joined provider/model
    // id carries the real vendor, same posture as omp and agy.
    vendor: "mixed",
    drive: {
      // PROBE-prime-agent-v190.md: print mode executes tools unattended in cwd with NO approval
      // flag needed (hello.txt probe: file in cwd, exit 0, 5.6s) and no trust prompt in fresh
      // repos. `--model` accepts the joined provider/model form the listModels contract emits
      // (verified: --model google/gemini-3.6-flash). Prompt rides "$(cat …)" — the `@file`
      // attach syntax exists but its semantics were not probed, so the contract does not use it.
      headless: `prime-agent -p --model {model} "$(cat {promptFile})"`,
      // No interactive probe is recorded (PROBE-prime-agent-v190.md names the falsifier) — null
      // keeps the claim honest and the print fallback drives visible panes.
      interactive: null,
      trustDialog: {
        kind: "none",
        reason: "prime-agent 0.7.1 rendered no workspace-trust or tool-approval prompt across three fresh-temp-repo print-mode probes (PROBE-prime-agent-v190.md, 2026-08-13); interactive is null, so no dialog can reach a pane",
      },
      // `prime-agent model list` is the pi-table shape: header `provider  model …`, first two
      // columns join to the id `--model` accepts (live-verified 2026-08-13).
      listModels: { argv: ["model", "list"], parser: "pi-table" },
    },
  } satisfies CliEntry,
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
