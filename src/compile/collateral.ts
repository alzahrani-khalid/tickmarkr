import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import picomatch from "picomatch";
import {
  criticalPathHits, DEFAULT_CONFIG, DEFAULT_REVIEW_CRITICAL_PATHS, effectiveReviewPolicy, loadConfig,
  type TickmarkrConfig,
} from "../config/config.js";
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
      if (isGlob(pa) && !isGlob(pb) && picomatch(pa)(pb)) hits.add(`${pb} ⊂ ${pa}`);
      else if (isGlob(pb) && !isGlob(pa) && picomatch(pb)(pa)) hits.add(`${pa} ⊂ ${pb}`);
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
  tasks: ReadonlyArray<Pick<Task, "id" | "files" | "acceptance">>,
  repoRoot: string,
): string[] {
  const perTask = tasks
    .map((t) => ({ t, symbols: criteriaSymbols(t.acceptance ?? []) }))
    .filter((x) => x.symbols.length);
  if (!perTask.length) return [];
  const { files: codeFiles, unreadable } = walkAllCode(repoRoot);

  const errors: string[] = [];
  const incomplete = (path: string) =>
    `cannot prove the symbol-ownership rule for ${perTask.map((x) => x.t.id).join(", ")}: ${path} `
    + `is unreadable, so the code index is incomplete — restore read access (or remove the path) and `
    + `recompile; the ownership lint fails closed rather than trust a partial scan (OBS-248).`;
  for (const u of unreadable) errors.push(incomplete(u));

  // resolve each symbol to its definition site(s) once, shared across tasks
  const allSymbols = [...new Set(perTask.flatMap((x) => x.symbols))];
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

  for (const { t, symbols } of perTask) {
    // OBS-22: scopeGate accepts picomatch globs; ownership must agree.
    const scoped = picomatch(t.files.map((f) => f.replace(/^\.\//, "")), { dot: true });
    for (const sym of symbols) {
      const defs = sites.get(sym) ?? [];
      if (defs.length !== 1) continue; // unknown or ambiguous — silent by ruling
      const site = defs[0]!;
      if (scoped(site)) continue; // defined inside the task's own write surface
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
 * KNOWN GAP (R2 review, T6/T7 scope): the compile seam in src/compile/index.ts
 * (`enforceTaskUnitContract`) does not thread `compileSource`'s `root` argument into this call, so a
 * PROGRAMMATIC compile whose target repo differs from process.cwd() resolves the wrong root and can
 * miss that repo's own `review.criticalPaths`. Threading it is one line in src/compile/index.ts,
 * outside this task's file scope. Two things bound the exposure meanwhile, both live: the critical
 * set here is the UNION with the shipped defaults, so a wrong root can never lower enforcement below
 * the shipped floor; and the review GATE — which is handed the run's real config — refuses to skip a
 * critical path itself (src/gates/review.ts), so a lint this seam misses costs a late verdict rather
 * than an unreviewed one. The compile lint is the early warning; the gate is the fail-closed backstop.
 */
export function taskUnitContractErrors(
  tasks: ReadonlyArray<Pick<Task, "id" | "goal" | "files" | "deps" | "acceptance" | "shape">>,
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
