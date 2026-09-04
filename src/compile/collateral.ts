import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { filesGlob } from "../graph/files-glob.js";
import {
  criticalPathHits, DEFAULT_CONFIG, DEFAULT_REVIEW_CRITICAL_PATHS, effectiveReviewPolicy, loadConfig,
  type TickmarkrConfig,
} from "../config/config.js";
import { renderAcceptanceItem, type Task } from "../graph/schema.js";

// Advisory scan (OBS-12/13/14/21, OBS-76). NEVER expands files[] or fails compile — a warning the
// author acts on. Plain-text (no AST), capped + sorted for DISPLAY only.
// OBS-547: the collateral prediction is no longer plan-time-only. The daemon computes one full
// (uncapped) map per run and hands each task's slice to its scope gate, which classifies a red
// against it — the prediction never causes a refusal, it only says whether a red the gate already
// found was foreseeable (authoring defect) or not (chargeable quality failure).

/** Max files walked per root (sorted walk; rest ignored). */
const MAX_WALK_FILES = 400;
/** Max collateral test paths listed per task. */
const MAX_HITS_PER_TASK = 20;
/** Skip giant fixtures / snapshots. */
const MAX_READ_BYTES = 512 * 1024;
const EXPORT_MANIFEST_TEST = "tests/repo/export-manifest.test.ts";

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
 * OBS-547: the FULL per-task collateral prediction, uncapped. ONE map is computed per run (daemon.ts,
 * at run start) and handed whole to the scope gate, so a hit the plan display hides is still there
 * when the gate asks about it. The lint lines below are a capped VIEW of this same map — never a
 * second scan. Tasks with no hits are absent.
 */
export function collateralHits(
  tasks: ReadonlyArray<Pick<Task, "id" | "files">>,
  repoRoot: string,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const testFiles = walkCode(repoRoot, "tests");
  if (!testFiles.length) return map;

  const read = makeReader(repoRoot);
  for (const t of tasks) {
    // OBS-22: scopeGate accepts picomatch globs; advisory collateral warnings must agree.
    const files = t.files.map((f) => f.replace(/^\.\//, ""));
    const scoped = filesGlob(files);
    const srcFiles = files.filter(isSrcPath);
    const hits: string[] = [];

    // Exact-enumerated scripts are an export-set contract: a new path has no name or symbol for the
    // ordinary sweep to find, but the manifest test will reject it unless the task owns that oracle.
    if (
      testFiles.includes(EXPORT_MANIFEST_TEST)
      && !scoped(EXPORT_MANIFEST_TEST)
      && files.some((path) => path.startsWith("scripts/") && !/[?*{[]/.test(path) && !existsSync(join(repoRoot, path)))
    ) hits.push(EXPORT_MANIFEST_TEST);

    // needles unioned across all src files in this task
    const needles = [...new Set(srcFiles.flatMap(needlesFor))];
    for (const tf of testFiles) {
      if (scoped(tf) || hits.includes(tf)) continue;
      const text = read(tf);
      if (text === null) continue;
      if (mentions(text, needles)) hits.push(tf);
    }
    // deterministic: the special hit and walk are stable; sort their union for one canonical map.
    if (hits.length) map.set(t.id, hits.sort());
  }
  return map;
}

/** The verbatim repair an authoring defect owes: the files[] lines the spec is missing. */
export function filesRepair(taskId: string, paths: ReadonlyArray<string>): string {
  return paths.map((p) => `add ${p} to ${taskId}.files[]`).join("\n");
}

export interface ScopeCollateralVerdict {
  /** every hard offender was predicted ⇒ authoring defect, repair pre-written, no attempt charged */
  authoring: boolean;
  /** the offenders the map had already named */
  predicted: string[];
  /** the offenders it had not — the lint's blind spots, recorded as evidence rather than folklore */
  missed: string[];
  repair: string;
}

/**
 * OBS-547: cross-reference at the RED. The gate supplies specificity (the paths actually touched),
 * the prediction supplies classification — so there are no false positives to fear and no refusal to
 * author. Feed this the FULL map for the task: a classifier bounded by the display cap calls a
 * predicted 21st hit a quality failure.
 */
export function classifyScopeOffenders(
  taskId: string,
  hard: ReadonlyArray<string>,
  predicted: ReadonlyArray<string>,
): ScopeCollateralVerdict {
  const named = new Set(predicted);
  const hit = hard.filter((f) => named.has(f));
  const missed = hard.filter((f) => !named.has(f));
  return { authoring: hard.length > 0 && missed.length === 0, predicted: hit, missed, repair: filesRepair(taskId, hit) };
}

/**
 * Return human-readable scope-lint lines for plan output (no `!` prefix — plan owns that).
 * Each line names the task id and at least one missing collateral test path.
 */
export function collateralLints(tasks: ReadonlyArray<Pick<Task, "id" | "files">>, repoRoot: string): string[] {
  const lines: string[] = [];
  for (const [id, hits] of collateralHits(tasks, repoRoot)) {
    const listed = hits.slice(0, MAX_HITS_PER_TASK).join(", ");
    // OBS-547: the cap hides names, never predictions. Say so, and say where the hidden ones surface —
    // a count with no route is exactly what left one run's victim unreadable.
    const tail = hits.length > MAX_HITS_PER_TASK
      ? ` (${hits.length} total; ${MAX_HITS_PER_TASK} shown, ${hits.length - MAX_HITS_PER_TASK} capped out of view`
        + ` but RETAINED for the scope gate — a matching scope red prints the hidden path with its files[] repair)`
      : "";
    lines.push(`${id}: likely collateral tests not in files[]: ${listed}${tail}`);
  }
  return lines;
}

// v1.53 T4 (OBS-76): needles are code-shaped tokens only (camelCase / snake_case) — plain prose
// words never match, so prose-only criteria yield zero needles instead of alarm-fatigue noise.
// ponytail: token heuristic, not AST symbol resolution — promote after a version of precision data.
function criteriaSymbolTexts(acceptance: Task["acceptance"]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of acceptance) {
    const text = renderAcceptanceItem(item);
    for (const tok of text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
      if (!tok.includes("_") && !/[a-z][A-Z]/.test(tok)) continue;
      const texts = out.get(tok) ?? [];
      if (!texts.includes(text)) texts.push(text);
      out.set(tok, texts);
    }
  }
  return out;
}

function criteriaSymbols(acceptance: Task["acceptance"]): string[] {
  return [...criteriaSymbolTexts(acceptance).keys()].sort();
}

// These are affirmative READ relations, not a list of things that are not writes. The distinction
// is the fail-closed boundary: an unknown predicate never earns context[] authority. A target is
// readable when it is the object of an explicit observation (`reading ownedTable`) or the subject
// of an explicitly pre-existing state (`ownedTable already publishes`). An unqualified declarative
// predicate (`ownedTable returns two rows`) is deliberately absent because it can demand a change.
const DIRECT_READ_BEFORE = /\b(?:consult|consults|consulting|inspect|inspects|inspecting|read|reads|reading|reference|references|referencing)\s+(?:(?:the|an?)\s+)?(?:(?:current|existing|unchanged)\s+)?$/i;
const PREEXISTING_STATE_AFTER = /^\s*(?:(?:and|or)\s+\S+\s+)*(?:(?:,\s*)?which\s+)?(?:already|currently)\s+(?:carries|carry|contains?|declares?|defines?|exposes?|holds?|owns?|provides?|publish|publishes|returns?|supplies|supply|yields?)\b/i;
const PASSIVE_READ_AFTER = /^\s+(?:is|remains)\s+(?:read|referenced|unchanged|untouched|as[- ]is)\b/i;
// Once a target-local read has been established, a same-clause continuation can revoke it. These
// vetoes are structural rather than an attempted exhaustive list of write verbs: an action followed
// by `it` / `them` / `the same ...` is target-directed but ambiguous, and a coordinated passive
// participle inherits the target as its subject. Both therefore fail closed. The scan stops at an
// actual sentence/clause boundary; a dot inside a later path is not one.
const TARGET_ANAPHOR_AFTER_COORDINATOR = /\b(?:and|or|then|before|after|while)\b[^,;.!?\n]{0,80}\b(?:it|them|those|the\s+same(?:\s+[A-Za-z][A-Za-z0-9_-]*)?)\b/i;
const TARGET_PASSIVE_AFTER_SUBJECT_READ = /\b(?:and|or|then|before|after)\s+(?:then\s+)?(?:(?:is|gets?|becomes?|being)\s+)?[A-Za-z]+(?:ed|en)\b/i;

function sameClauseAfterTarget(after: string): string {
  const boundary = after.search(/[;!?\n]|\.(?=\s|$)/);
  return boundary === -1 ? after : after.slice(0, boundary);
}

function targetOccurrences(text: string, target: string): number[] {
  if (!target) return [];
  const out: number[] = [];
  const wordAtStart = /[A-Za-z0-9_]/.test(target[0]!);
  const wordAtEnd = /[A-Za-z0-9_]/.test(target[target.length - 1]!);
  for (let at = text.indexOf(target); at !== -1; at = text.indexOf(target, at + target.length)) {
    const before = text[at - 1];
    const after = text[at + target.length];
    if (wordAtStart && before !== undefined && /[A-Za-z0-9_]/.test(before)) continue;
    if (wordAtEnd && after !== undefined && /[A-Za-z0-9_]/.test(after)) continue;
    out.push(at);
  }
  return out;
}

/**
 * Does every mention of `target` have an explicit, target-local READ relation?
 *
 * A `context:` entry grants READ authority and nothing else, so both blocking paths have to ask this
 * before honouring one. Fail-closed by construction: every occurrence must match one of the narrow
 * read forms below. Absence from a write-verb list is never evidence. Thus `ownedTable returns two`
 * and the unlisted `ownedTable sorts the rows it already publishes` are refused, while an unrelated
 * write in `the consumer adds a cache while reading ownedTable` does not revoke ownedTable's read
 * authority. A target mentioned twice, once for reading and once ambiguously, is refused.
 *
 * This is intentionally a lexical representation rather than prose understanding. Keyed on NAMES:
 * only the literal target is classified, so a dependency described conceptually stays invisible and
 * an unfamiliar read phrasing stays refused. That closes the false-positive direction only; widen
 * the affirmative grammar only with a control that goes red first.
 */
export function criterionReadsOnly(text: string, target: string): boolean {
  const occurrences = targetOccurrences(text, target);
  return occurrences.length > 0 && occurrences.every((at) => {
    // Backticks quote the target, not the relation, so discard only the adjacent delimiters.
    const before = text.slice(Math.max(0, at - 96), at).replace(/`$/, "");
    const after = text.slice(at + target.length).replace(/^`/, "");
    const preexisting = PREEXISTING_STATE_AFTER.exec(after);
    const passive = PASSIVE_READ_AFTER.exec(after);
    if (!DIRECT_READ_BEFORE.test(before) && !preexisting && !passive) return false;

    const clause = sameClauseAfterTarget(after);
    if (TARGET_ANAPHOR_AFTER_COORDINATOR.test(clause)) return false;

    // A subject-position read (`target is read` / `target already publishes`) leaves the target as
    // the inherited subject of a coordinated passive: `... and then rewritten by the consumer` is
    // a change demand, not a read. Object-position reads need the anaphor veto above instead.
    const subjectRead = preexisting ?? passive;
    return !subjectRead
      || !TARGET_PASSIVE_AFTER_SUBJECT_READ.test(clause.slice(subjectRead[0].length));
  });
}

const ARCH_PAGES = ["docs/codebase/ARCHITECTURE.md", "docs/codebase/STRUCTURE.md"];

// files[] is deliberately small, but a brace range can still be broad. If a pattern exceeds
// this advisory budget, fail open instead of printing an unexpanded brace fragment as a directory.
const MAX_BRACE_EXPANSIONS = 256;
const RANGE_CHAR_START = 32;
const RANGE_CHAR_END = 126;

function isEscaped(input: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && input[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function unescapeGlobLiteral(input: string): string {
  return input.replace(/\\(.)/g, "$1");
}

function rangeParts(body: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let sawRange = false;

  for (let i = 0; i < body.length - 1; i++) {
    if (isEscaped(body, i)) continue;
    const ch = body[i];
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch !== "." || body[i + 1] !== "." || isEscaped(body, i + 1) || depth !== 0) continue;
    parts.push(body.slice(start, i));
    i++;
    start = i + 1;
    sawRange = true;
  }

  if (!sawRange) return undefined;
  parts.push(body.slice(start));
  return parts;
}

function rangeAlternatives(body: string): string[] | undefined {
  const parts = rangeParts(body);
  if (!parts) return undefined;

  const source = `[${parts.map(unescapeGlobLiteral).sort().join("-")}]`;
  let re: RegExp;
  try {
    re = new RegExp(`^${source}$`);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (let code = RANGE_CHAR_START; code <= RANGE_CHAR_END; code++) {
    const ch = String.fromCharCode(code);
    if (re.test(ch)) out.push(ch);
    if (out.length > MAX_BRACE_EXPANSIONS) return [];
  }
  return out;
}

function braceAlternatives(body: string): string[] | undefined {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  let hasComma = false;
  for (let i = 0; i < body.length; i++) {
    if (isEscaped(body, i)) continue;
    const ch = body[i];
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch !== "," || depth !== 0) continue;
    alternatives.push(body.slice(start, i));
    start = i + 1;
    hasComma = true;
  }
  if (hasComma) {
    alternatives.push(body.slice(start));
    return alternatives;
  }
  return rangeAlternatives(body);
}

function expandableBrace(pattern: string): { start: number; end: number; alternatives: string[] } | undefined {
  const opens: number[] = [];
  let unsupported: { start: number; end: number; alternatives: string[] } | undefined;
  for (let i = 0; i < pattern.length; i++) {
    if (isEscaped(pattern, i)) continue;
    if (pattern[i] === "{") {
      opens.push(i);
      continue;
    }
    if (pattern[i] !== "}" || !opens.length) continue;
    const start = opens.pop()!;
    const alternatives = braceAlternatives(pattern.slice(start + 1, i));
    if (alternatives === undefined) continue;
    if (alternatives.length === 0) {
      unsupported ??= { start, end: i, alternatives };
      continue;
    }
    return { start, end: i, alternatives };
  }
  return unsupported;
}

function expandFilesPattern(pattern: string): string[] {
  const pending = [pattern];
  const expanded = new Set<string>();
  let visited = 0;

  while (pending.length) {
    const candidate = pending.pop()!;
    if (++visited > MAX_BRACE_EXPANSIONS) return [];
    const brace = expandableBrace(candidate);
    if (!brace) {
      expanded.add(unescapeGlobLiteral(candidate));
      continue;
    }
    if (brace.alternatives.length === 0) continue;
    if (pending.length + brace.alternatives.length > MAX_BRACE_EXPANSIONS) return [];
    for (const alternative of brace.alternatives) {
      pending.push(candidate.slice(0, brace.start) + alternative + candidate.slice(brace.end + 1));
    }
  }

  const scoped = filesGlob(pattern);
  return [...expanded].filter((candidate) => scoped(candidate));
}

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
    const scoped = filesGlob(t.files.map((f) => f.replace(/^\.\//, "")));
    const newDirs = new Set<string>();
    for (const f of t.files) {
      const normalized = f.replace(/^\.\//, "");
      for (const expanded of expandFilesPattern(normalized)) {
        const dir = topLevelSrcDir(expanded);
        if (!dir || existing.has(dir)) continue;
        newDirs.add(`src/${dir}/`);
      }
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
    const scoped = filesGlob(t.files.map((f) => f.replace(/^\.\//, "")));
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

// ── Task Unit Contract (OBS-212 / OBS-214) ────────────────────────────────────────────────────
// These are ERRORS, not advisories. Everything above this line is a plan-time warning the author
// may ignore; a graph that violates the rules below is not a graph the harness can run honestly.

/** Max acceptance items per task. Consult-converged (copus/csol/cfable R2). */
export const MAX_ACCEPTANCE_ITEMS = 6;
/** Max files[] patterns per task. */
export const MAX_FILES_PATTERNS = 8;

/** Tasks reachable from `id` through deps (transitive). */
function reachable(id: string, byId: Map<string, ReadonlyArray<string>>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byId.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next) ?? []));
  }
  return seen;
}

// Conservative overlap: identical patterns, or a glob that matches the other's literal path. Two
// globs that merely COULD intersect are not flagged — false negatives are acceptable here, false
// positives would reject legitimate graphs.
function overlappingPatterns(a: ReadonlyArray<string>, b: ReadonlyArray<string>): string[] {
  const hits = new Set<string>();
  const isGlob = (p: string) => /[*?[\]{}]/.test(p);
  for (const pa of a) {
    for (const pb of b) {
      if (pa === pb) { hits.add(pa); continue; }
      if (isGlob(pa) && !isGlob(pb) && filesGlob(pa)(pb)) hits.add(`${pb} ⊂ ${pa}`);
      else if (isGlob(pb) && !isGlob(pa) && filesGlob(pb)(pa)) hits.add(`${pa} ⊂ ${pb}`);
    }
  }
  return [...hits].sort();
}

/**
 * OBS-212: two tasks with no dependency path between them may run concurrently and are recreated
 * onto a moving integration tip. If they write the same file, the graph's independence claim is
 * false — and it comes due in the carry plumbing, which resets the task branch to the advanced tip
 * and silently drops whatever will not cherry-pick. run-20260728-110135 lost 32 verified commits in
 * two events that way (T2 17/17, T1 15/15), each after a sibling that shared its files merged.
 */
export function separabilityErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "deps">>,
): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t.deps ?? []] as const));
  const errors: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!, b = tasks[j]!;
      if (reachable(a.id, byId).has(b.id) || reachable(b.id, byId).has(a.id)) continue; // ordered
      const shared = overlappingPatterns(a.files ?? [], b.files ?? []);
      if (shared.length > 0) {
        errors.push(
          `${a.id} and ${b.id} both write ${shared.join(", ")} but neither depends on the other — `
          + `add a dependency edge to order them, or split the shared path out. Concurrent tasks that `
          + `write the same file are not independent, and the loser's committed work is silently `
          + `dropped when the integration tip advances (OBS-212).`,
        );
      }
    }
  }
  return errors;
}

/**
 * OBS-214: a task too large to converge is not a task. T1 of v1.83 carried 8 acceptance items and a
 * diff at the 130k cap; it took 28 dispatches and never passed review, while T3 (4 items) took 5.
 */
export function taskBudgetErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "acceptance">>,
): string[] {
  const errors: string[] = [];
  for (const t of tasks) {
    const items = t.acceptance?.length ?? 0;
    if (items > MAX_ACCEPTANCE_ITEMS) {
      errors.push(`${t.id} declares ${items} acceptance items (max ${MAX_ACCEPTANCE_ITEMS}) — split it. `
        + `Every item is a thing one worker must satisfy at once and one reviewer must verify in one pass.`);
    }
    const files = t.files?.length ?? 0;
    if (files > MAX_FILES_PATTERNS) {
      errors.push(`${t.id} declares ${files} files[] patterns (max ${MAX_FILES_PATTERNS}) — split it. `
        + `A wide write surface is what makes tasks collide and diffs exceed the review cap.`);
    }
  }
  return errors;
}

// ── R2 velocity lints (OVERSEER-RULING-20260731-velocity) ───────────────────────────────────
// v1.84's T1 cost nine review rounds enforcing law the compiler could have refused at authoring
// time. These three bounds are that refusal: a bounded task surface, goal prose forced down into
// judge/test criteria, and criteria that may not name symbols owned outside the task's files[].

/**
 * Max acceptance × files[] surface per task (OVERSEER-RULING-20260731-velocity, R2:
 * `surface = acceptance.length × files.length > 24` fails compile). EVERY criterion counts —
 * a judge item is still a thing one worker must satisfy and one reviewer must verify in the
 * same pass, and counting only test oracles let judge-heavy tasks bypass the bound (the first
 * T6 attempt was rejected for exactly that narrowing). The calibration corpus pins the bound:
 * v1.84's original T1 measures 6×5=30 and fails; v1.79's tasks pass — its widest, T5 at
 * 4×7=28, rides the recorded exception below rather than redefining the metric.
 */
export const MAX_TASK_SURFACE = 24;
/**
 * Max goal words per acceptance criterion (v1.84's T1 measured 75). Gameable only by adding
 * criteria — which is the point: every law migrated from goal prose to a criterion moves its
 * enforcement from the 40-minute review round to the 2-minute judge.
 */
export const MAX_GOAL_WORDS_PER_CRITERION = 60;

/**
 * A recorded surface exception — an explicit contract amendment, never a silent bypass. Each
 * entry matches exactly ONE historical task shape: task id, acceptance count, and the full
 * files[] list must all be identical, so nothing an author writes later can ride one (matching
 * would require copying a recorded files[] verbatim — an audible spec edit any reviewer sees).
 */
export interface SurfaceException {
  /** Task id as authored in the spec the exception was recorded for. */
  id: string;
  /** Exact acceptance-criterion count of the excepted task. */
  acceptance: number;
  /** Exact files[] of the excepted task (order-insensitive; sorted at recording time). */
  files: string[];
  /** Where the amendment is recorded and why it exists. */
  reason: string;
}

export const SURFACE_CONTRACT_EXCEPTIONS: ReadonlyArray<SurfaceException> = [
  {
    id: "T5",
    acceptance: 4,
    files: [
      "src/adapters/prompt.ts", "src/gates/acceptance.ts", "src/gates/llm.ts", "src/gates/review.ts",
      "tests/gates/acceptance.test.ts", "tests/gates/judge-retry.test.ts", "tests/gates/review.test.ts",
    ],
    reason:
      "v1.79 T5 (4×7=28) — the velocity ruling's own fast baseline (7/7 in 89 min), shipped green "
      + "before R2 existed; the bound was calibrated FROM this corpus, not retroactively enforced on it.",
  },
  {
    id: "T4",
    acceptance: 5,
    files: [
      "src/gates/run-gates.ts", "src/run/daemon.ts",
      "tests/gates/pipeline.test.ts", "tests/gates/review-retry.test.ts", "tests/gates/run-gates.test.ts",
    ],
    reason:
      "v1.85 T4 (5×5=25) — recorded in specs/v1.85-speed-truth.spec.md's Not-in-scope block: the two "
      + "retry-seam test pins are non-negotiable collateral and splitting the pipeline task would "
      + "re-serialize it.",
  },
];

function matchesSurfaceException(
  t: Pick<Task, "id" | "files" | "acceptance">,
  exceptions: ReadonlyArray<SurfaceException>,
): SurfaceException | undefined {
  const files = (t.files ?? []).map((f) => f.replace(/^\.\//, "")).sort();
  const items = t.acceptance?.length ?? 0;
  for (const ex of exceptions) {
    if (ex.id !== t.id || ex.acceptance !== items) continue;
    const exFiles = [...ex.files].sort();
    if (exFiles.length === files.length && exFiles.every((f, i) => f === files[i])) return ex;
  }
  return undefined;
}

/**
 * R2 surface bound: acceptance criteria × files[] patterns, one error per offending task.
 * `exceptions` defaults to the recorded contract amendments; tests pass [] to prove an
 * exception is load-bearing.
 */
export function surfaceErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "acceptance">>,
  exceptions: ReadonlyArray<SurfaceException> = SURFACE_CONTRACT_EXCEPTIONS,
): string[] {
  const errors: string[] = [];
  for (const t of tasks) {
    const items = t.acceptance?.length ?? 0;
    const files = t.files?.length ?? 0;
    const surface = items * files;
    if (surface <= MAX_TASK_SURFACE) continue;
    if (matchesSurfaceException(t, exceptions)) continue; // recorded contract amendment
    errors.push(
      `${t.id} has an acceptance×files surface of ${surface} (${items} criteria × ${files} files[] `
      + `patterns), above the ${MAX_TASK_SURFACE} bound — split the task so one worker builds and one `
      + `reviewer verifies a smaller unit in a single pass (R2).`,
    );
  }
  return errors;
}

/** Words carrying at least one letter or digit in ANY script — bare dashes and bullets are not words. */
function goalWordCount(goal: string): number {
  return goal.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** R2 goal-density bound: goal words per acceptance criterion, one error per offending task. */
export function goalDensityErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "goal" | "acceptance">>,
): string[] {
  const errors: string[] = [];
  for (const t of tasks) {
    const items = t.acceptance?.length ?? 0;
    if (!items || !t.goal) continue;
    const words = goalWordCount(t.goal);
    const ratio = Math.round((words / items) * 10) / 10;
    if (ratio > MAX_GOAL_WORDS_PER_CRITERION) {
      errors.push(
        `${t.id} carries a goal of ${ratio} words per acceptance criterion (${words} words ÷ ${items} `
        + `criteria), above the ${MAX_GOAL_WORDS_PER_CRITERION} bound — move goal prose into judge/test `
        + `criteria; law that lives only in prose is enforced by a 40-minute review round instead of the `
        + `2-minute judge (R2).`,
      );
    }
  }
  return errors;
}

// planFrame class (OBS-248): `export function NAME`, `export const NAME =`, `class NAME` etc.
// Token heuristic like criteriaSymbols — definition keywords only, no AST, no method/property forms.
function definitionRe(symbol: string): RegExp {
  return new RegExp(
    `(?:^|\\n)[ \\t]*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?`
    + `(?:function\\*?\\s+|const\\s+|let\\s+|var\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+)${symbol}\\b`,
  );
}

/**
 * The blocking ownership lint gets its own index, NOT walkCode: walkCode is a capped, fail-open
 * ADVISORY scan (400 files, src/ only, skips giant and unreadable files) — the right shape for
 * plan-time warnings, wrong for a compile error. A unique definition hiding in the 401st file,
 * another code root (tests/, scripts/, a root-level config), or a skipped file would silently
 * pass. This walk is complete: every code file under the repo root, no count cap, no size cap,
 * and anything unreadable is reported so the lint can fail closed instead of trusting a
 * partial scan. Generated mirrors are not definition sites: dist/ is tsc's copy of src/
 * (rebuilt by the test gate's pretest), so indexing it would double every definition and read
 * every unique site as ambiguous — the ownership rule indexes SOURCE only.
 */
function walkAllCode(repoRoot: string): { files: string[]; unreadable: string[] } {
  const files: string[] = [];
  const unreadable: string[] = [];
  const rel = (full: string) => relative(repoRoot, full).split("\\").join("/") || ".";
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(rel(dir));
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || !CODE_EXT.test(e.name)) continue;
      files.push(rel(full));
    }
  };
  try {
    if (!statSync(repoRoot).isDirectory()) return { files, unreadable }; // no root: empty index
  } catch {
    return { files, unreadable };
  }
  walk(repoRoot);
  return { files, unreadable };
}

/**
 * R2 symbol ownership: a code identifier named in a judge or test criterion that resolves uniquely
 * to a definition OUTSIDE the task's files[] is unsatisfiable by construction — the v1.84 T1
 * planFrame defect, which burned two review rounds because the enabling symbol lived in another
 * task's file. Zero definition sites (plain-language false positive, external symbol, or a file
 * the task itself creates) and ambiguous tokens (multiple definition sites) stay silent. The index
 * must be COMPLETE: any code path that cannot be read is its own error — the rule fails closed
 * rather than trust a partial scan.
 */
export function symbolOwnershipErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "acceptance"> & Partial<Pick<Task, "context">>>,
  repoRoot: string,
): string[] {
  const perTask = tasks
    .map((t) => ({ t, bySymbol: criteriaSymbolTexts(t.acceptance ?? []) }))
    .filter((x) => x.bySymbol.size);
  if (!perTask.length) return [];
  const { files: codeFiles, unreadable } = walkAllCode(repoRoot);

  const errors: string[] = [];
  const incomplete = (path: string) =>
    `cannot prove the symbol-ownership rule for ${perTask.map((x) => x.t.id).join(", ")}: ${path} `
    + `is unreadable, so the code index is incomplete — restore read access (or remove the path) and `
    + `recompile; the ownership lint fails closed rather than trust a partial scan (OBS-248).`;
  for (const u of unreadable) errors.push(incomplete(u));

  // resolve each symbol to its definition site(s) once, shared across tasks
  const allSymbols = [...new Set(perTask.flatMap((x) => [...x.bySymbol.keys()]))];
  const res = new Map(allSymbols.map((s) => [s, definitionRe(s)]));
  const sites = new Map<string, string[]>(allSymbols.map((s) => [s, []]));
  for (const cf of codeFiles) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, cf), "utf8"); // no size cap — a skipped file is a blind spot
    } catch {
      errors.push(incomplete(cf));
      continue;
    }
    for (const sym of allSymbols) {
      if (text.includes(sym) && res.get(sym)!.test(text)) sites.get(sym)!.push(cf);
    }
  }

  for (const { t, bySymbol } of perTask) {
    // OBS-22: scopeGate accepts picomatch globs; ownership must agree.
    const scoped = filesGlob(t.files.map((f) => f.replace(/^\.\//, "")));
    // THE RULE AT THIS SITE: a `context:`
    // entry declares a path the worker may READ, so it answers "can the worker satisfy a criterion
    // that only reads this symbol" (yes) and never "may the worker change it" (no — that authority
    // comes from files[] alone). Hence the exemption is conditional on the criteria that actually
    // name the symbol, and it is asked of the SYMBOL, not of the sentence: `criterionReadsOnly` fails
    // closed, so a criterion demanding the symbol CHANGE — and any phrasing that does not prove it
    // reads the symbol — is still refused, and still told to widen files[] where the change is what
    // it asks for. An unrelated in-scope write does not change that per-symbol answer. Keyed on NAMES:
    // only a path literally written in context[] is seen here, so a
    // read dependency an author described in prose remains invisible to this lint. That closes the
    // false-positive direction only — nothing here narrows what the rule refuses.
    const declaredContext = (t.context ?? []).map((f) => f.replace(/^\.\//, ""));
    const readable = declaredContext.length ? filesGlob(declaredContext) : () => false;
    for (const [sym, texts] of bySymbol) {
      const defs = sites.get(sym) ?? [];
      if (defs.length !== 1) continue; // unknown or ambiguous — silent by ruling
      const site = defs[0]!;
      if (scoped(site)) continue; // defined inside the task's own write surface
      const writes = !texts.every((text) => criterionReadsOnly(text, sym));
      if (readable(site) && !writes) continue; // read authority is declared and read authority is all it needs
      if (readable(site)) {
        errors.push(
          `${t.id}: criterion identifier "${sym}" is defined only in ${site}, which is declared in `
          + `context[] but not in files[] — a context: entry grants READ authority only, and this `
          + `criterion requires changing "${sym}"; add ${site} to files[] or reword the criterion to `
          + `require only reading it (OBS-248).`,
        );
        continue;
      }
      if (!writes) {
        errors.push(
          `${t.id}: criterion identifier "${sym}" is defined only in ${site}, which is in neither `
          + `files[] nor context[] — the criterion only reads "${sym}", so declare ${site} in `
          + `context[]; widening files[] would grant write authority this criterion never asks for `
          + `(OBS-248).`,
        );
        continue;
      }
      errors.push(
        `${t.id}: criterion identifier "${sym}" is defined only in ${site}, which is not in files[] — `
        + `add ${site} to files[] or reword the criterion; a worker scoped to files[] cannot satisfy a `
        + `criterion whose enabling symbol lives outside it (OBS-248).`,
      );
    }
  }
  return errors;
}

/**
 * The participation half of the config — everything the review-policy rules read. `byShape` rides
 * along because `gates.byShape.<shape>.review: false` is a second, NON-monotone participation switch:
 * review.policy can only raise a task's policy, but a shape override can omit the review gate outright
 * (src/gates/run-gates.ts `enabled`). Path-keyed participation is only true if both are read together.
 */
export type ReviewParticipation = TickmarkrConfig["review"] & { byShape?: TickmarkrConfig["gates"]["byShape"] };

/**
 * R3 review participation (OVERSEER-RULING-20260731-velocity; OBS-186). The compiler assigns
 * `reviewPolicy` from the DECLARED files[] — `judge-only` only when every declared path is provably
 * docs/CHANGELOG/RELEASING/version-mirror leaf work — and the operator's floor may raise it. A task
 * that would SKIP review while touching `review.criticalPaths` is the exact shape OBS-186 caught in
 * the field: the riskiest task in the bundle silently declining the one gate that exists for it. That
 * cannot be a warning, because nothing downstream would stop it — the gate would honour the policy.
 */
export function reviewParticipationErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "shape">>,
  review: ReviewParticipation,
): string[] {
  // The shipped critical paths are a FLOOR, not a default that a config replaces: this lint resolves
  // its config from a repo root the compile seam cannot always name (see taskUnitContractErrors), and
  // the one direction that must never happen is a wrong root lowering enforcement below what tickmarkr
  // ships. Union is monotone — a repo-local list can only add.
  const critical = [...new Set([...DEFAULT_REVIEW_CRITICAL_PATHS, ...(review.criticalPaths ?? [])])];
  const errors: string[] = [];
  for (const t of tasks) {
    const files = t.files ?? [];
    const policy = effectiveReviewPolicy(files, review);
    // The non-monotone switch, caught at the only seam that can still refuse the graph. A shape
    // override cannot demote a task the paths assigned `full` — that is precisely the demotion
    // review.policy is structurally incapable of, arriving through a second door.
    const shapeOff = t.shape !== undefined && review.byShape?.[t.shape]?.review === false;
    if (policy === "full" && shapeOff) {
      errors.push(
        `${t.id} declares full-review work (reviewPolicy full — at least one declared path is not `
        + `leaf-class) while gates.byShape.${t.shape}.review: false would omit the review gate — `
        + `remove that override, or narrow files[] to docs/CHANGELOG/RELEASING/version-mirror leaf `
        + `work; participation is decided by paths, and config may raise a policy, never lower one (R3).`,
      );
      continue;
    }
    if (policy !== "judge-only" && !shapeOff) continue; // full review actually runs — nothing skips
    const hits = criticalPathHits(files, critical);
    if (!hits.length) continue;
    const why = policy === "judge-only"
      ? "reviewPolicy judge-only — every declared path is leaf-class work"
      : `gates.byShape.${t.shape}.review: false`;
    errors.push(
      `${t.id} would skip cross-vendor review (${why}) `
      + `while touching review.criticalPaths ${hits.join(", ")} — narrow files[] out `
      + `of the critical path, or set review.policy: full so the task is reviewed; participation is `
      + `decided by paths, and a critical path may never be reviewed by the judge alone (R3).`,
    );
  }
  return errors;
}

/**
 * The ACTIVE participation config for a compile rooted at `repoRoot`. Same default-argument contract
 * as `repoRoot` itself: the CLI and daemon compile from inside the target repo, so the repo's own
 * config (plus the global overlay) is the config the run will gate under. A config the loader cannot
 * read degrades to the shipped defaults rather than crashing the compile — every command that reaches
 * this seam loads the same config itself and reports a malformed one loudly.
 */
function activeReviewParticipation(repoRoot: string): ReviewParticipation {
  try {
    const cfg = loadConfig(repoRoot);
    return { ...cfg.review, byShape: cfg.gates.byShape };
  } catch {
    return { ...DEFAULT_CONFIG.review, byShape: DEFAULT_CONFIG.gates.byShape };
  }
}

/**
 * Every Task Unit Contract violation in one pass, ready to throw. `repoRoot` backs the
 * symbol-ownership lint and the participation config, and defaults to the invocation directory —
 * correct for the CLI/daemon, which compile from inside the target repo.
 *
 * The read declaration (`context:`) rides on this parameter, on the task objects themselves — the
 * aggregator never infers it from the repo, the config, or a sibling task. It is OPTIONAL: a caller
 * whose task objects carry no `context` gets byte-identical verdicts to the ones it got before the
 * field existed, because an absent declaration grants no authority at all.
 *
 * The compile seam in src/compile/index.ts threads `compileSource`'s repo root here, so CLI tests
 * and programmatic compiles check the same repository overlay the later run will use.
 */
export function taskUnitContractErrors(
  tasks: ReadonlyArray<
    Pick<Task, "id" | "goal" | "files" | "deps" | "acceptance" | "shape"> & Partial<Pick<Task, "context">>
  >,
  repoRoot: string = process.cwd(),
  review: ReviewParticipation = activeReviewParticipation(repoRoot),
): string[] {
  return [
    ...separabilityErrors(tasks),
    ...taskBudgetErrors(tasks),
    ...surfaceErrors(tasks),
    ...goalDensityErrors(tasks),
    ...symbolOwnershipErrors(tasks, repoRoot),
    ...reviewParticipationErrors(tasks, review),
  ];
}
