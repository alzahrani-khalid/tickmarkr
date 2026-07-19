import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { TIERS, type RunGraph, validateGraph } from "../graph/schema.js";
import { CompileError, assertWriteScope, inferShape, sha256, type WriteDirective } from "./common.js";

// GSD artifact front-end (spec v1.3): one GSD *plan* is one tickmarkr *task* — a plan is
// worktree-sized; its inner <task> steps stay in the worker prompt via context[0] = the plan file.
// Artifact-level only: parses .planning/ markdown, never GSD repo/command internals.

const PLAN_SUFFIX = "-PLAN.md";

export function isGsdPhaseDir(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(PLAN_SUFFIX));
  } catch {
    return false;
  }
}

interface Frontmatter {
  depends_on?: unknown;
  files_modified?: unknown;
  autonomous?: unknown;
  must_haves?: { truths?: unknown };
  routing?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

const WRITE_DIRECTIVE = /\b(?:Create|Write|Add|Emit|Generate)\s+`([^`\s]+)`/gi;
const isPathish = (s: string) => /^[\w./*-]+$/.test(s) && /\.[a-z]{2,4}$/i.test(s);
const stripFences = (s: string) => s.replace(/^```[\s\S]*?^```/gm, "");

// ponytail: grammar matches GSD SUMMARY boilerplate only; if that boilerplate drifts the check
// goes vacuous — the v1.9-29 pin in tests/compile/scope-seam.test.ts fails loudly when it does.
function extractWriteDirectives(body: string, storedPath: string): WriteDirective[] {
  const phaseDir = dirname(storedPath);
  const writes: WriteDirective[] = [];
  for (const m of stripFences(body).matchAll(WRITE_DIRECTIVE)) {
    const raw = m[1];
    if (!isPathish(raw)) continue;
    // HARD-09: a bare name (no "/") joins against the plan's CURRENT on-disk dir, which goes stale
    // the moment the dir is archive-relocated. Carry the bare name through so assertWriteScope's
    // fallback can resolve it in a relocation-invariant way (basename suffix against files_modified).
    const bare = !raw.includes("/");
    const path = bare ? join(phaseDir, raw) : raw;
    writes.push({ path, directive: m[0], ...(bare ? { bare: raw } : {}) });
  }
  return writes;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// schema-legal, branch-safe id segment: dots etc. → dashes; no "--" runs (task-branch separator)
// or trailing dash — the id schema rejects both
const sanitize = (s: string): string =>
  s
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");

// filename is the canonical id source — frontmatter `plan: 06` YAML-parses to the number 6,
// losing the zero-padding that depends_on entries ("07-01") reference
const planKey = (file: string): string => sanitize(basename(file).replace(/-PLAN\.md$/, ""));

// "06" and 6 must resolve to the same plan: alias each key by its zero-stripped segments
const unpad = (key: string): string =>
  key
    .split("-")
    .map((seg) => (/^\d+$/.test(seg) ? String(Number(seg)) : seg))
    .join("-");

// numeric-aware order: 2-PLAN.md before 10-PLAN.md even without zero-padding
function byPlanOrder(a: string, b: string): number {
  const as = a.split("-");
  const bs = b.split("-");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i] ?? "";
    const y = bs[i] ?? "";
    if (/^\d+$/.test(x) && /^\d+$/.test(y) && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compileOne(file: string, storedPath: string) {
  const content = readFileSync(file, "utf8");
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  let fm: Frontmatter = {};
  if (fmMatch) {
    try {
      fm = (parseYaml(fmMatch[1]) ?? {}) as Frontmatter;
    } catch (e) {
      // fail closed: a swallowed parse error would silently drop autonomous:false (a human gate)
      throw new CompileError(`${file} has malformed YAML frontmatter: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  const body = content.slice(fmMatch ? fmMatch[0].length : 0);

  const key = planKey(file);
  const objective = /<objective>\s*([\s\S]*?)<\/objective>/.exec(body)?.[1].trim() ?? "";
  // sentence split that survives common abbreviations and version dots
  const firstSentence = objective
    .split(/(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\bvs\.)(?<!\betc\.)(?<=\.)\s/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  const title = firstSentence || key;

  const dones = [...body.matchAll(/<done>\s*([\s\S]*?)\s*<\/done>/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  const truths = strings(fm.must_haves?.truths);
  const acceptance = [...dones, ...truths].filter(Boolean);
  if (!acceptance.length) {
    throw new CompileError(
      `${file} has no acceptance criteria — every tickmarkr task needs them.\n` +
        `GSD source: add <done> lines to the plan's tasks, or must_haves.truths in its frontmatter.`,
    );
  }

  // @-refs from the <context> block only; keep repo-relative paths (no $VAR, ~, absolute, or ..-escape)
  const contextBlock = /<context>([\s\S]*?)<\/context>/.exec(body)?.[1] ?? "";
  const refs = [...contextBlock.matchAll(/^@(\S+)$/gm)]
    .map((m) => m[1])
    .filter((p) => !p.includes("$") && !p.startsWith("~") && !p.startsWith("/") && !p.split("/").includes(".."));

  const taskCount = [...body.matchAll(/<task[\s>]/g)].length;
  const humanGate = fm.autonomous === false || /<task type="checkpoint:/.test(body);
  const done = existsSync(join(dirname(file), `${basename(file).replace(/-PLAN\.md$/, "")}-SUMMARY.md`));

  const files = strings(fm.files_modified).map((f) => f.replace(/^\.\//, ""));
  assertWriteScope(file, `P${key}`, files, extractWriteDirectives(body, storedPath));

  // fail closed (D-03): a silently dropped floor/pin routes the task cheap instead of erroring
  let routingHints: { floor?: (typeof TIERS)[number]; pin?: { via: string; model: string }; source: string } | undefined;
  if (fm.routing !== undefined) {
    if (!isPlainObject(fm.routing)) {
      throw new CompileError(`${file} has a routing frontmatter key that must be an object with floor and/or pin`);
    }
    const hints: NonNullable<typeof routingHints> = { source: basename(file) };
    if (fm.routing.floor !== undefined) {
      if (!(TIERS as readonly unknown[]).includes(fm.routing.floor)) {
        throw new CompileError(`${file} has routing.floor "${fm.routing.floor}" — valid tiers are ${TIERS.join(", ")}`);
      }
      hints.floor = fm.routing.floor as (typeof TIERS)[number];
    }
    if (fm.routing.pin !== undefined) {
      const pin = fm.routing.pin;
      const via = isPlainObject(pin) ? pin.via : undefined;
      const model = isPlainObject(pin) ? pin.model : undefined;
      if (typeof via !== "string" || typeof model !== "string") {
        throw new CompileError(`${file} has a routing.pin missing a string "via" and/or "model"`);
      }
      hints.pin = { via, model };
    }
    if (hints.floor !== undefined || hints.pin !== undefined) routingHints = hints;
  }

  return {
    task: {
      id: `P${key}`,
      title,
      goal: title,
      // title only: files_modified nearly always lists test mirrors, which mis-shaped every plan as "tests"
      shape: inferShape(title),
      complexity: Math.max(1, Math.min(10, 2 * taskCount + truths.length)),
      deps: strings(fm.depends_on).map((d) => sanitize(d)),
      files,
      context: [storedPath, ...refs],
      acceptance,
      ...(humanGate ? { humanGate: true } : {}),
      ...(done ? { status: "done" as const } : {}),
      ...(routingHints ? { routingHints } : {}),
    },
    content,
  };
}

export function compileGsd(src: string, root?: string): RunGraph {
  if (!existsSync(src)) throw new CompileError(`${src} does not exist — point tickmarkr compile at a GSD phase directory or a *-PLAN.md`);
  const isDir = statSync(src).isDirectory();
  const files = isDir
    ? readdirSync(src)
        .filter((f) => f.endsWith(PLAN_SUFFIX))
        .sort(byPlanOrder)
        .map((f) => join(src, f))
    : [src];
  if (!files.length) {
    throw new CompileError(`no *-PLAN.md files in ${src} — point tickmarkr compile at a GSD phase directory`);
  }

  // context[0] must be readable from an isolated worktree: store repo-relative, never absolute
  const rel = (f: string): string => {
    if (root && isAbsolute(f)) {
      const r = relative(root, f);
      if (!r.startsWith("..")) return r;
    }
    return f;
  };

  const compiled = files.map((f) => compileOne(f, rel(f)));
  const tasks = compiled.map((c) => c.task);

  // deps reference plan keys; YAML may have stripped zero-padding ("06" → 6) — resolve via aliases.
  // Phase compile: an unresolvable dep is a lost edge → fail closed. Single-plan compile: deps
  // point at plans outside this graph (already executed by GSD) → drop them.
  const byAlias = new Map<string, string>();
  for (const t of tasks) {
    const key = t.id.slice(1);
    byAlias.set(key, t.id);
    byAlias.set(unpad(key), t.id);
  }
  if (isDir) {
    const bareAliases = new Map<string, string | undefined>();
    const claimBareAlias = (alias: string, id: string): void => {
      const existing = bareAliases.get(alias);
      if (existing === undefined && bareAliases.has(alias)) return;
      if (existing !== undefined && existing !== id) {
        bareAliases.set(alias, undefined);
        return;
      }
      bareAliases.set(alias, id);
    };
    for (const t of tasks) {
      const bare = t.id.slice(1).split("-").at(-1) ?? "";
      claimBareAlias(bare, t.id);
      claimBareAlias(unpad(bare), t.id);
    }
    for (const [alias, id] of bareAliases) {
      if (id !== undefined && !byAlias.has(alias)) byAlias.set(alias, id);
    }
  }
  for (const [i, t] of tasks.entries()) {
    t.deps = t.deps.flatMap((d) => {
      const id = byAlias.get(d) ?? byAlias.get(unpad(d));
      if (id) return [id];
      if (!isDir) return []; // external to this single-plan graph
      throw new CompileError(`${files[i]} depends on "${d}" but no such plan exists in ${src}`);
    });
  }

  return validateGraph({
    version: 1,
    spec: { source: "gsd", paths: files, hash: sha256(compiled.map((c) => c.content).join("\n")) },
    tasks,
  });
}
