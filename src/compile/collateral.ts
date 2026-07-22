import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import picomatch from "picomatch";
import { renderAcceptanceItem, type Task } from "../graph/schema.js";

// Advisory plan-time scan only (OBS-12/13/14/21, OBS-76). NEVER expands files[], fails compile,
// or feeds the scope gate — a warning the author acts on. Plain-text (no AST), capped + sorted.

/** Max files walked per root (sorted walk; rest ignored). */
const MAX_WALK_FILES = 400;
/** Max collateral test paths listed per task. */
const MAX_HITS_PER_TASK = 20;
/** Skip giant fixtures / snapshots. */
const MAX_READ_BYTES = 512 * 1024;

const SRC_EXT = /\.(ts|tsx|js|jsx|mts|cts)$/;
const CODE_EXT = /\.(ts|tsx|js|jsx|mts|cts)$/;

function isSrcPath(p: string): boolean {
  const n = p.replace(/^\.\//, "");
  return n.startsWith("src/") && SRC_EXT.test(n) && !n.includes("node_modules/");
}

function needlesFor(srcPath: string): string[] {
  const n = srcPath.replace(/^\.\//, "");
  const noExt = n.slice(0, n.length - extname(n).length); // src/adapters/codex
  // path needles only (no bare basename — avoids prose/identifier false positives)
  // repo-relative import forms that appear in tests (ESM often uses .js)
  return [...new Set([noExt, `${noExt}.js`, `${noExt}.ts`, n])].filter((s) => s.length > 0);
}

function walkCode(repoRoot: string, subdir: string): string[] {
  const root = join(repoRoot, subdir);
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no such root or unreadable — zero lints
    }
    // deterministic order
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_WALK_FILES) return;
      if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || !CODE_EXT.test(e.name)) continue;
      const rel = relative(repoRoot, full).split("\\").join("/");
      out.push(rel);
    }
  };
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(root);
  return out;
}

function mentions(content: string, needles: string[]): boolean {
  for (const n of needles) {
    if (n.length >= 2 && content.includes(n)) return true;
  }
  return false;
}

// cache file bodies (one read per path)
function makeReader(repoRoot: string): (rel: string) => string | null {
  const body = new Map<string, string | null>();
  return (rel) => {
    if (body.has(rel)) return body.get(rel)!;
    try {
      const st = statSync(join(repoRoot, rel));
      if (st.size > MAX_READ_BYTES) {
        body.set(rel, null);
        return null;
      }
      const text = readFileSync(join(repoRoot, rel), "utf8");
      body.set(rel, text);
      return text;
    } catch {
      body.set(rel, null);
      return null;
    }
  };
}

/**
 * Return human-readable scope-lint lines for plan output (no `!` prefix — plan owns that).
 * Each line names the task id and at least one missing collateral test path.
 */
export function collateralLints(tasks: ReadonlyArray<Pick<Task, "id" | "files">>, repoRoot: string): string[] {
  const testFiles = walkCode(repoRoot, "tests");
  if (!testFiles.length) return [];

  const read = makeReader(repoRoot);
  const lines: string[] = [];
  for (const t of tasks) {
    // OBS-22: scopeGate accepts picomatch globs; advisory collateral warnings must agree.
    const scoped = picomatch(t.files.map((f) => f.replace(/^\.\//, "")), { dot: true });
    const srcFiles = t.files.map((f) => f.replace(/^\.\//, "")).filter(isSrcPath);
    if (!srcFiles.length) continue;

    // needles unioned across all src files in this task
    const needles = [...new Set(srcFiles.flatMap(needlesFor))];
    const hits: string[] = [];
    for (const tf of testFiles) {
      if (scoped(tf)) continue;
      const text = read(tf);
      if (text === null) continue;
      if (mentions(text, needles)) hits.push(tf);
      if (hits.length >= MAX_HITS_PER_TASK) break;
    }
    if (!hits.length) continue;
    // deterministic: walk already sorted; stable list
    const listed = hits.join(", ");
    const tail = hits.length >= MAX_HITS_PER_TASK ? " (capped)" : "";
    lines.push(`${t.id}: likely collateral tests not in files[]: ${listed}${tail}`);
  }
  return lines;
}

// v1.53 T4 (OBS-76): needles are code-shaped tokens only (camelCase / snake_case) — plain prose
// words never match, so prose-only criteria yield zero needles instead of alarm-fatigue noise.
// ponytail: token heuristic, not AST symbol resolution — promote after a version of precision data.
function criteriaSymbols(acceptance: Task["acceptance"]): string[] {
  const out = new Set<string>();
  for (const item of acceptance) {
    for (const tok of renderAcceptanceItem(item).match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
      if (tok.includes("_") || /[a-z][A-Z]/.test(tok)) out.add(tok);
    }
  }
  return [...out].sort();
}

const ARCH_PAGES = ["docs/codebase/ARCHITECTURE.md", "docs/codebase/STRUCTURE.md"];

function topLevelSrcDir(file: string): string | undefined {
  const parts = file.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  if (parts[0] !== "src" || parts.length < 2 || !parts[1]) return undefined;
  return parts[1];
}

function existingSrcTopLevels(repoRoot: string): Set<string> {
  const out = new Set<string>();
  let entries;
  try {
    entries = readdirSync(join(repoRoot, "src"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) out.add(e.name);
  }
  return out;
}

// OBS-108 (v1.67 T5): a task whose files[] creates a new top-level src/ directory must also
// include the architecture pages the docs-truth suite pins. Advisory only — never blocks compile.
export function newDirectoryLints(
  tasks: ReadonlyArray<Pick<Task, "id" | "files">>,
  repoRoot: string,
): string[] {
  const existing = existingSrcTopLevels(repoRoot);
  const lines: string[] = [];
  for (const t of tasks) {
    // OBS-22: scopeGate accepts picomatch globs; advisory warnings must agree.
    const scoped = picomatch(t.files.map((f) => f.replace(/^\.\//, "")), { dot: true });
    const newDirs = new Set<string>();
    for (const f of t.files) {
      const dir = topLevelSrcDir(f);
      if (!dir || existing.has(dir)) continue;
      newDirs.add(`src/${dir}/`);
    }
    if (!newDirs.size) continue;
    const missing = ARCH_PAGES.filter((p) => !scoped(p));
    if (!missing.length) continue;
    const dirList = [...newDirs].sort().join(", ");
    const dirLabel = newDirs.size > 1 ? "directories" : "directory";
    lines.push(`${t.id}: new top-level source ${dirLabel} ${dirList} must include ${missing.join(" and ")} in files[]`);
  }
  return lines;
}

/**
 * OBS-76 class: sweep src/ for out-of-scope source files that reference a symbol the acceptance
 * criteria name — the v1.52 router.ts omission, named at plan time instead of one judge round in.
 * Advisory plan output only, same contract as collateralLints.
 */
export function sourceScopeLints(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "acceptance">>,
  repoRoot: string,
): string[] {
  const newDirLints = newDirectoryLints(tasks, repoRoot);
  const perTask = tasks
    .map((t) => ({ t, needles: criteriaSymbols(t.acceptance) }))
    .filter((x) => x.needles.length);
  if (!perTask.length) return newDirLints;
  const srcFiles = walkCode(repoRoot, "src");
  if (!srcFiles.length) return newDirLints;

  const read = makeReader(repoRoot);
  const lines: string[] = [];
  for (const { t, needles } of perTask) {
    // OBS-22: scopeGate accepts picomatch globs; advisory warnings must agree.
    const scoped = picomatch(t.files.map((f) => f.replace(/^\.\//, "")), { dot: true });
    // needles are word-chars by construction — no regex escaping needed; whole-word match only
    const res = needles.map((n) => new RegExp(`\\b${n}\\b`));
    const hits: string[] = [];
    for (const sf of srcFiles) {
      if (scoped(sf)) continue;
      const text = read(sf);
      if (text === null) continue;
      if (res.some((re) => re.test(text))) hits.push(sf);
    }
    if (!hits.length) continue;
    hits.sort();
    const listed = hits.slice(0, MAX_HITS_PER_TASK).join(", ");
    const tail = hits.length > MAX_HITS_PER_TASK ? " (capped)" : "";
    lines.push(`${t.id}: criteria implicate out-of-scope source not in files[]: ${listed}${tail}`);
  }
  return [...newDirLints, ...lines];
}
