import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { filesGlob } from "../graph/files-glob.js";
import picomatch from "picomatch";
import {
  type AcceptanceItem, GATE_NAMES, GRAPH_ROUTING_MODES, ORACLES, renderAcceptanceItem, SHAPES, TIERS,
  type RunGraph, type Task, validateGraph,
} from "../graph/schema.js";
import { CompileError, inferShape, sha256 } from "./common.js";

// OBS-170/OBS-184: `context:` is a promise to the worker, and nothing ever checked it could be kept.
// Workers run in `git worktree add <baseRef>` (run/git.ts:169-176), which materialises the base
// TREE and copies nothing in — so the oracle is that tree, and NEVER two things that look like it:
//   · existsSync reads the AUTHOR's checkout. Measured on v1.85: 10 of 16 unreachable entries are
//     plainly present there (.overseer/ is 21 tracked files out of 480 on disk).
//   · `git ls-files` reads the INDEX. `git add -f` writes the index, so a staged-uncommitted file
//     reports present while still being invisible to every worker — the lint would then certify
//     exactly the failure it exists to catch (RULING 2026-08-03 rider; the absent-vs-empty shape
//     again, cf. fileBytes). Hence the opt-in is "add AND commit", and the resolver reads HEAD.
// `ls-tree -r HEAD` enumerates that tree once; per-path `cat-file -e HEAD:<path>` is the same oracle
// one path at a time, and one spawn beats N.
function trackedAtHead(dir: string): { root: string; tracked: Set<string> } | undefined {
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  const top = git("rev-parse", "--show-toplevel");
  // --full-tree is load-bearing: without it `ls-tree` scopes to the CWD's subtree and prints paths
  // relative to it, so a spec in specs/ would see only specs/-relative names and misjudge every
  // path outside it. Caught only by a fixture whose spec is NOT at the repo root.
  const r = git("ls-tree", "--full-tree", "-r", "--name-only", "HEAD");
  // not a repo, or no commits yet — fail open, so non-repo fixtures and fresh inits stay silent
  if (top.status !== 0 || r.status !== 0 || typeof r.stdout !== "string") return undefined;
  return { root: top.stdout.trim(), tracked: new Set(r.stdout.split("\n").filter(Boolean)) };
}

const GLOB_CHARS = /[*?{[]/;

/**
 * Classify one `context:` entry against the tree a worker's worktree is built from.
 *   ok        — reachable
 *   untracked — in the author's checkout, invisible to every worker. WARNS, permanently: per-file
 *               force-add is the deliberate opt-in, so this is a standing prompt, not a migration.
 *   missing   — absent from both. FAILS compile; carries a repair when exactly one tracked file
 *               shares the basename (ambiguous matches suggest nothing rather than guess).
 * RULING 2026-08-03 (.overseer/OVERSEER-RULING-20260803-context-visibility.md): OBS-170's
 * fail-closed-on-untracked is retired — oracle upheld, policy overruled (it blocked 11 of 13).
 */
export function classifyContextPath(entry: string, tracked: Set<string>, repoDir: string): { kind: "ok" | "untracked" | "missing"; suggestion?: string } {
  if (GLOB_CHARS.test(entry)) return { kind: "ok" }; // a glob is not a promise about one file
  const q = entry.replace(/\/+$/, "");
  if (tracked.has(q)) return { kind: "ok" };
  for (const t of tracked) if (t.startsWith(`${q}/`)) return { kind: "ok" }; // directory with tracked children
  if (existsSync(`${repoDir}/${q}`)) return { kind: "untracked" };
  // Measured: 5 of v1.85's 6 absent entries are a tracked file written without its directory
  // (`V185-SEEDS.md` for `.overseer/V185-SEEDS.md`) — the opt-in had worked, only the check was
  // missing. Suggest ONLY on an unambiguous basename: two candidates is a guess, not a repair.
  const base = basename(q);
  const hits = [...tracked].filter((t) => basename(t) === base);
  return hits.length === 1 ? { kind: "missing", suggestion: hits[0] } : { kind: "missing" };
}

// OBS-97: mirror of the vitest.config.ts suite include — the only path class vitest collects.
export const COLLECTABLE_TESTS = "tests/**/*.test.ts";

export const LEGACY_PREFIX = ["dro", "vr"].join("");
export const TICKMARKR_NATIVE_MARKER = /^<!--\s*tickmarkr:spec(?:\s+v1)?\s*-->\s*$/m;
export const NATIVE_MARKER = new RegExp(`^<!--\\s*(?:tickmarkr|${LEGACY_PREFIX}):spec(?:\\s+v1)?\\s*-->\\s*$`, "m");

const HEAD_RE = /^## (T\d+):\s*(.+)$/;
const FIELD_RE = /^- (\w+):\s*(.*)$/;
const NESTED_RE = /^\s+- (.+)$/;
// v1.19: a typed acceptance oracle line — "command: ...", "test: ...", or "judge: ...". Anything
// without one of these prefixes is a plain-string judge criterion (compat path, emits a warning).
const ORACLE_RE = new RegExp(`^(${ORACLES.join("|")}):\\s*(.*)$`);
const FIELDS = new Set(["goal", "shape", "deps", "files", "context", "complexity", "humangate", "pin", "floor", "gates", "acceptance", "timeout"]);

interface Draft {
  id: string;
  title: string;
  fields: Record<string, string>;
  // OBS-488: list items accumulate as raw text so wrapped continuation lines join BEFORE the
  // typed-oracle prefix parses — the oracle must see the complete logical criterion, not line 1.
  acceptanceRaw: string[];
  acceptance: AcceptanceItem[];
  gates: string[];
  hasGates: boolean;
  list: "acceptance" | "gates" | null;
  // true while the last item of `list` may still absorb wrapped continuation lines; cleared by
  // any field bullet or blank line, so a dangling indented line elsewhere fails closed below.
  itemOpen: boolean;
  continuationField: "goal" | "deps" | "files" | "context" | null;
}

function invalid(task: string, field: string, detail: string): never {
  throw new CompileError(`Task ${task} field "${field}" ${detail}`);
}

export const AUTHORING_LINT_CODES = [
  "criterion-scope",
  "dependency-closure",
  "dependency-coupling",
  "proxy-metric",
  "external-referent",
  "closed-enumeration",
  "one-behavior",
  "concern-bundle",
  "seam-exists",
] as const;

export type AuthoringLintCode = (typeof AUTHORING_LINT_CODES)[number];

export interface AuthoringLintFinding {
  code: AuthoringLintCode;
  fixtureId: string;
  taskId: string;
  criterion?: number;
  detail: string;
}

type HeadTest = { path: string; text: string };

// The authoring frame's observable oracle is the branch-tip test corpus, never the mutable index or
// an author's untracked checkout. Load it once per repository: one bounded git read replaces a grep
// subprocess per token and preserves the base-only native compile's zero-Git property (the index is
// requested only when a criterion actually carries a rendered observable or a test basename).
const headTestCache = new Map<string, HeadTest[]>();

function repositoryRoot(file: string): string | undefined {
  let current = resolve(dirname(file));
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function testsAtHead(root: string): HeadTest[] {
  const cached = headTestCache.get(root);
  if (cached) return cached;
  const grep = spawnSync(
    "git",
    ["-C", root, "grep", "-I", "-n", "-e", "", "HEAD", "--", "tests/*.test.ts", "tests/**/*.test.ts"],
    { encoding: "utf8", maxBuffer: 1 << 25 },
  );
  if (grep.status !== 0 || typeof grep.stdout !== "string") {
    headTestCache.set(root, []);
    return [];
  }
  const bodies = new Map<string, string[]>();
  for (const line of grep.stdout.split("\n")) {
    const match = line.match(/^HEAD:(tests\/.*\.test\.ts):\d+:(.*)$/);
    if (!match) continue;
    const lines = bodies.get(match[1]) ?? [];
    lines.push(match[2]);
    bodies.set(match[1], lines);
  }
  const tests = [...bodies].map(([path, lines]) => ({ path, text: lines.join("\n") }));
  headTestCache.set(root, tests);
  return tests;
}

function criterionTexts(task: Pick<Task, "acceptance">): string[] {
  return task.acceptance.map(renderAcceptanceItem);
}

function fixtureId(file: string): string {
  return basename(file).replace(/(?:\.spec)?\.md$/, "");
}

function strictNegativeCount(text: string): number {
  return (text.match(/\b(?:never|neither|cannot)\b|\bno\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}\s+(?:may|can|supplies|becomes)\b/gi) ?? []).length;
}

function namedCriterionPaths(text: string, tests: HeadTest[]): string[] {
  const paths = new Set<string>();
  // Longest extension first, plus a not-a-name-character tail: regex alternation is first-match-wins,
  // so `js|json` extracted `src/i18n/ar/common.json` as `src/i18n/ar/common.js` and `ts|tsx` turned
  // `Card.tsx` into `Card.ts`. criterion-scope is a THROWING lint, so a criterion naming a .json,
  // .tsx or .jsx file that sits squarely inside its own files[] refused to compile, and the refusal
  // named a path its author never wrote. Order and boundary both: either alone would fix it, and the
  // pair makes a future extension added in the wrong place harmless (OBS-545).
  const ext = "tsx|ts|jsx|json|js|mjs|cjs|md|txt";
  const re = new RegExp(`(?:^|[\\s("'\`])((?:src|tests|fixtures|scripts)/[A-Za-z0-9_@{}*?.,/+-]+\\.(?:${ext}))(?![A-Za-z0-9])`, "g");
  for (const match of text.matchAll(re)) {
    paths.add(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9_.-]+\.test\.ts)\b/g)) {
    for (const test of tests) if (basename(test.path) === match[1]) paths.add(test.path);
  }
  return [...paths];
}

function renderedObservables(text: string): { exact: string[]; denominators: string[] } {
  const exact = new Set<string>();
  const denominators = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]{2,120})`/g)) {
    const token = match[1].trim();
    // Plain vocabulary in backticks is documentation, not a concrete rendered value. Digit-bearing,
    // path/punctuation-shaped, snake/camel-case tokens are the branch-tip grep substrate from C1.
    if (/\d|[_./:%-]|[a-z][A-Z]/.test(token)) exact.add(token);
  }
  for (const match of text.matchAll(/\b(\d+)\s*(?:\/|of)\s*(\d+)\b/gi)) {
    exact.add(`${match[1]}/${match[2]}`);
    denominators.add(match[2]);
  }
  return { exact: [...exact], denominators: [...denominators] };
}

function criterionScopeFinding(
  task: Pick<Task, "id" | "files" | "acceptance">,
  text: string,
  criterion: number,
  id: string,
  tests: HeadTest[],
): AuthoringLintFinding | undefined {
  if (task.files.length === 0) return undefined; // empty files[] is deliberately unrestricted
  const inScope = filesGlob(task.files.map((entry) => entry.replace(/^\.\//, ""))); // Q120s shared matcher
  const named = namedCriterionPaths(text, tests);
  const { exact, denominators } = renderedObservables(text);
  const asserting = tests.filter((test) =>
    exact.some((token) => test.text.includes(token))
      || denominators.some((denominator) => new RegExp(`(?:^|\\D)\\d+/${denominator}(?:\\D|$)`).test(test.text)),
  ).map((test) => test.path);
  const missing = [...new Set([...named, ...asserting])].filter((path) => !inScope(path));
  if (missing.length === 0) return undefined;
  return {
    code: "criterion-scope",
    fixtureId: id,
    taskId: task.id,
    criterion,
    detail: `criterion names asserting file${missing.length === 1 ? "" : "s"} outside expanded files[]: ${missing.join(", ")}`,
  };
}

function exportedIdentifier(root: string, files: readonly string[], identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\bexport\\s+(?:(?:declare|default|async)\\s+)*(?:function|class|const|let|var|interface|type)\\s+${escaped}\\b|\\bexport\\s*\\{[^}]*\\b${escaped}\\b`);
  return files.some((file) => {
    if (/[*?{[]/.test(file)) return false;
    try {
      return declaration.test(readFileSync(join(root, file), "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * Frame-v2 authoring checks over the compiled native task shape. Criterion-scope is blocking at the
 * compile boundary; the remaining checks are review findings, emitted by compileNative below.
 */
export function authoringLintFindings(tasks: readonly Task[], file: string): AuthoringLintFinding[] {
  const id = fixtureId(file);
  const root = repositoryRoot(file);
  let indexedTests: HeadTest[] | undefined;
  const testIndex = () => indexedTests ??= root ? testsAtHead(root) : [];
  const findings: AuthoringLintFinding[] = [];

  for (const task of tasks) {
    const criteria = criterionTexts(task);
    for (const [index, text] of criteria.entries()) {
      const needsTestIndex = /`[^`\n]{2,120}`|\b\d+\s*(?:\/|of)\s*\d+\b|\b[A-Za-z0-9_.-]+\.test\.ts\b/.test(text);
      const scope = criterionScopeFinding(task, text, index + 1, id, needsTestIndex ? testIndex() : []);
      if (scope) findings.push(scope);

      if (/line[- ]count|physical line|not greater than (?:the|\d)|no larger than|at most \d+ (?:lines|bytes)/i.test(text)) {
        findings.push({ code: "proxy-metric", fixtureId: id, taskId: task.id, criterion: index + 1, detail: "criterion uses a proxy size metric; state the structural intent instead" });
      }
      if (/\bthe (?:audit|ruling|sweep|standby|decision|analysis|handoff)\b|\bper the\b|\bat \.planning\//i.test(text)) {
        findings.push({ code: "external-referent", fixtureId: id, taskId: task.id, criterion: index + 1, detail: "criterion depends on an external governance referent; inline the deciding fact" });
      }
      const separators = text.match(/\band\b|\bwhile\b|\bthen\b|\bplus\b|\bwith\b|,|—/gi) ?? [];
      if (separators.length >= 4) {
        findings.push({ code: "one-behavior", fixtureId: id, taskId: task.id, criterion: index + 1, detail: `${separators.length} independently-failable separators; split unless one leg alone reds this title` });
      }
    }

    const prose = [task.goal, ...criteria].join("\n");
    const dependencyText = prose
      .replace(/`[^`]*`/g, "")
      .split("\n")
      .filter((line) => !/\b(?:accepts?|rejects?)\b/i.test(line))
      .join("\n");
    const referenced = [...new Set(dependencyText.match(/\bT\d+\b/g) ?? [])]
      .filter((dep) => dep !== task.id && !task.deps.includes(dep));
    if (referenced.length > 0) {
      findings.push({ code: "dependency-closure", fixtureId: id, taskId: task.id, detail: `references ${referenced.join(", ")} outside deps[]` });
    }
    if (/\bwhose independent [^.\n]{0,80}(?:classification|result|decision|output|evidence)\b|\b(?:from|through|provided by|owned by) (?:a |the )?(?:successor|downstream|later|sibling)\b/i.test(dependencyText)) {
      findings.push({ code: "dependency-coupling", fixtureId: id, taskId: task.id, detail: "de-numbered cross-task coupling needs a dependency or a declared consumes contract" });
    }

    const negatives = strictNegativeCount(prose);
    if (negatives >= 2 && !/enumerat|closed (?:input )?list|closed \w* table|STANDBY/i.test(prose)) {
      findings.push({ code: "closed-enumeration", fixtureId: id, taskId: task.id, detail: `${negatives} strict prohibitions have no closed enumeration pointer` });
    }

    const concerns = [...new Set(task.goal.match(/\bQ\d+\b/g) ?? [])];
    if (concerns.length > 1) {
      findings.push({ code: "concern-bundle", fixtureId: id, taskId: task.id, detail: `goal bundles ${concerns.join(", ")}` });
    }

    if (root && negatives > 0) {
      const monoliths = task.files.filter((entry) => {
        if (!entry.startsWith("src/") || /[*?{[]/.test(entry)) return false;
        try {
          return readFileSync(join(root, entry), "utf8").split("\n").length > 1500;
        } catch {
          return false;
        }
      });
      if (monoliths.length > 0) {
        const identifiers = [...prose.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)].map((match) => match[1]);
        const seamExists = identifiers.some((identifier) => exportedIdentifier(root, task.files, identifier));
        const firstCreatesSeam = /\b(?:add|create|extract|introduce|ship)\b[^.\n]{0,100}\b(?:injectable|seam|clock|snapshot|evidence)\b/i.test(criteria[0] ?? "");
        if (!seamExists && !firstCreatesSeam) {
          findings.push({ code: "seam-exists", fixtureId: id, taskId: task.id, detail: `law-shaped task touches ${monoliths.join(", ")} but names no exported seam and does not create one first` });
        }
      }
    }
  }
  return findings;
}

function renderAuthoringFinding(finding: AuthoringLintFinding): string {
  const criterion = finding.criterion === undefined ? "" : ` criterion ${finding.criterion}`;
  return `tickmarkr: authoring-lint[${finding.code}] fixture ${finding.fixtureId} task ${finding.taskId}${criterion}: ${finding.detail}`;
}

export function compileNative(file: string): RunGraph {
  if (!existsSync(file)) throw new CompileError(`no such native spec file: ${file}`);
  const content = readFileSync(file, "utf8");
  // Exact shared-template check: init writes specTemplate(), and any edit changes the body.
  if (content === specTemplate()) {
    throw new CompileError(`${file} is the unedited tickmarkr init scaffold. Edit ${file} before compiling.`);
  }
  const drafts: Draft[] = [];
  let plainCount = 0; // v1.19: plain-string acceptance items compiled as judge oracles (compat) — warn once
  let specMode: (typeof GRAPH_ROUTING_MODES)[number] | undefined;
  let specBase: string | undefined;

  for (const [index, line] of content.split("\n").entries()) {
    const heading = line.match(HEAD_RE);
    if (heading) {
      drafts.push({ id: heading[1], title: heading[2].trim(), fields: {}, acceptanceRaw: [], acceptance: [], gates: [], hasGates: false, list: null, itemOpen: false, continuationField: null });
      continue;
    }
    const draft = drafts.at(-1);
    if (!draft) {
      const base = line.match(/^base:\s*(.*)$/);
      if (base) {
        const value = base[1].trim();
        if (!value) {
          throw new CompileError("spec front-matter base must not be empty — repair: write lower-case base: <commit-or-ref> at column zero");
        }
        specBase = value;
        continue;
      }
      if (/^Base:\s*/.test(line)) {
        throw new CompileError("native task unit contract rejects column-zero Base: as untyped prose — repair: write lower-case base: <commit-or-ref>");
      }
      // v1.51 T2: spec front-matter — a top-level `mode: <name>` line before the first task heading
      // declares the engagement's routing mode (loses only to an explicit run flag).
      const fm = line.match(/^mode:\s*(\S+)\s*$/);
      if (fm) {
        if (!(GRAPH_ROUTING_MODES as readonly string[]).includes(fm[1])) {
          throw new CompileError(`spec front-matter mode must be one of ${GRAPH_ROUTING_MODES.join(", ")} (got ${JSON.stringify(fm[1])})`);
        }
        specMode = fm[1] as (typeof GRAPH_ROUTING_MODES)[number];
      }
      continue;
    }

    const field = line.match(FIELD_RE);
    if (field) {
      const name = field[1].toLowerCase();
      if (!FIELDS.has(name)) invalid(draft.id, field[1], "is unknown");
      const value = field[2].trim();
      draft.itemOpen = false;
      if (name === "acceptance" || name === "gates") {
        if (value) invalid(draft.id, field[1], "must be a nested list");
        draft.list = name;
        if (name === "gates") draft.hasGates = true;
        draft.continuationField = null;
      } else {
        if (name === "goal" && !value) invalid(draft.id, field[1], "must not be empty");
        draft.fields[name] = value;
        // OBS-60/OBS-308: carry wrapped physical lines for prose and comma-separated fields. A
        // worker must receive the whole logical field, regardless of the author's editor width.
        draft.continuationField = name === "goal" || name === "deps" || name === "files" || name === "context"
          ? name
          : null;
        draft.list = null;
      }
      continue;
    }

    // OBS-60/OBS-308: indented physical lines continue the preceding logical field until the next
    // field/list/heading. List continuations join with a space so the existing comma parser sees the
    // exact same value it would have received on one line.
    if (draft.continuationField) {
      const continuation = draft.continuationField;
      if ((line.startsWith(" ") || line.startsWith("\t")) && !NESTED_RE.test(line)) {
        const value = line.trim();
        if (continuation === "goal") {
          draft.fields.goal += `\n${value}`;
          continue;
        }
        if (value) {
          draft.fields[continuation] += ` ${value}`;
          continue;
        }
      }
      if (continuation === "goal" && !line.trim()) {
        draft.fields.goal += "\n";
        continue;
      }
      draft.continuationField = null;
    }

    const nested = line.match(NESTED_RE);
    if (nested && draft.list) {
      const value = nested[1].trim();
      if (!value) invalid(draft.id, draft.list, "must not contain empty entries");
      (draft.list === "acceptance" ? draft.acceptanceRaw : draft.gates).push(value);
      draft.itemOpen = true;
      continue;
    }
    // OBS-488: a deeper-indented non-item line under a list item is that item's wrapped
    // continuation — join with a single space, exactly as OBS-60/OBS-308 guarantee for fields.
    // 1.87.0 dropped these lines silently: 53/78 of run-551's criteria compiled to first-line
    // stubs and every falsifier tail was invisible to the judge.
    if (draft.list && draft.itemOpen && (line.startsWith(" ") || line.startsWith("\t")) && line.trim()) {
      const items = draft.list === "acceptance" ? draft.acceptanceRaw : draft.gates;
      items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (line.startsWith("- ")) invalid(draft.id, "field", `bullet is malformed: ${JSON.stringify(line)}`);
    if (!line.trim()) {
      draft.itemOpen = false;
      continue;
    }
    // OBS-488 fail-closed invariant: a non-blank line inside a task block that no rule consumes
    // is an error, never a silent drop — dropping author bytes is the meta-defect that hid the
    // criterion truncation for months.
    throw new CompileError(
      `Task ${draft.id} line ${index + 1}: no parse rule consumes this line: ${JSON.stringify(line)}.\n` +
        `A non-blank line in a task block must be a "- field:" bullet, a "  - " list item, or an\n` +
        `indented continuation of the preceding field or list item. tickmarkr refuses to silently\n` +
        `drop spec bytes (OBS-488) — move prose above the first task heading or into a field.`,
    );
  }

  // OBS-488: typed-oracle prefixes parse on the COMPLETE joined item text, never its first
  // physical line — a wrapped `command:` body or falsifier tail is part of the criterion.
  for (const draft of drafts) {
    for (const raw of draft.acceptanceRaw) {
      const typed = raw.match(ORACLE_RE);
      if (typed) {
        const [, kind, body] = typed;
        if (!body.trim()) invalid(draft.id, "acceptance", `${kind} oracle must carry a value`);
        draft.acceptance.push(
          kind === "command" ? { oracle: "command", command: body.trim() }
            : kind === "test" ? { oracle: "test", test: body.trim() }
            : { oracle: "judge", text: body.trim() },
        );
      } else {
        plainCount++;
        draft.acceptance.push(raw);
      }
    }
  }

  if (!drafts.length) {
    throw new CompileError(`${file} has no task sections. Expected "## T1: Title" headings with field bullets.`);
  }
  const missing = drafts.filter((draft) => !draft.acceptance.length).map((draft) => draft.id);
  if (missing.length) {
    throw new CompileError(
      `acceptance criteria are required on every task. Missing on: ${missing.join(", ")}.\n` +
        `Add to each section in ${file}:\n- acceptance:\n  - <observable outcome>`,
    );
  }

  // v1.62 (OBS-97): commas inside {a,b} alternatives are part of one glob entry, not separators —
  // split only at brace depth 0 so a brace glob reaches the lint (and the scope gate) intact.
  // OBS-170/OBS-184: the same is true of a citation annotation. `.planning/OBSERVATIONS.md (OBS-262,
  // OBS-263)` split at the inner comma into two bullets, and workers were dispatched a context line
  // reading `OBS-263)`. Track paren depth alongside brace depth for exactly the OBS-97 reason.
  const splitTop = (value: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let paren = 0;
    let current = "";
    for (const ch of value) {
      if (ch === "," && depth === 0 && paren === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}" && depth > 0) depth--;
      else if (ch === "(") paren++;
      else if (ch === ")" && paren > 0) paren--;
      current += ch;
    }
    return [...parts, current];
  };
  // Keeping the comma is only half of it: the merged entry still carries the annotation, so it
  // resolves no better than the fragments did (measured: 24 → 19 unresolvable, zero rescued).
  // Strip one trailing parenthetical so the entry is the path its author meant.
  const stripAnnotation = (item: string) => {
    const trimmed = item.trim();
    if (!trimmed.endsWith(")")) return trimmed;
    let paren = 0;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i] === ")") paren++;
      else if (trimmed[i] === "(") {
        paren--;
        if (paren === 0) return trimmed.slice(0, i).trim();
      }
    }
    return trimmed;
  };
  const csv = (value?: string) =>
    value && value.toLowerCase() !== "none" ? splitTop(value).map((item) => stripAnnotation(item.trim())).filter(Boolean) : [];

  // OBS-97: a typed test: oracle needs a collectable home. vitest only collects COLLECTABLE_TESTS
  // paths, so a task whose non-empty files[] cannot host one makes scope-green and acceptance-green
  // mutually exclusive by construction — run-20260719-210434 burned two dispatch attempts before a
  // consult diagnosed exactly this. Empty files[] stays exempt: no file scope means unrestricted
  // (src/gates/scope.ts). An entry hosts a collectable path iff its glob can produce one — probed by
  // substituting each wildcard run with a test-shaped segment (also covers literal test-file paths);
  // v1.62 extends the probe to {a,b} brace alternatives and ? single-character wildcards.
  const collectable = picomatch(COLLECTABLE_TESTS, { dot: true });
  // Single-token substitution is not a true glob-overlap test (tests/**/*.ts needs "probe.test",
  // a bare ** needs the whole collectable path) — probe with several test-shaped tokens and accept
  // if ANY candidate satisfies both globs. Scopes that truly cannot host one still fail every probe.
  const PROBE_TOKENS = ["probe.test.ts", "probe.test", "tests/probe.test.ts"];
  // v1.62: {a,b} alternatives expand to concrete branches before probing (innermost group first, so
  // nesting resolves); an unbalanced brace is literal to picomatch and stays unexpanded. Expansion is
  // BOUNDED: past BRANCH_CAP branches, further alternatives are dropped — dropping candidates can only
  // reject, never accept (every accept needs a concrete witness), so the cap stays fail-closed while a
  // pathological {a,b}{a,b}… entry can no longer balloon compile time.
  const BRANCH_CAP = 64;
  const expandBraces = (glob: string): string[] => {
    let branches = [glob];
    for (;;) {
      let changed = false;
      const next: string[] = [];
      for (const branch of branches) {
        const inner = branch.match(/\{([^{}]*)\}/);
        if (!inner) {
          next.push(branch);
          continue;
        }
        changed = true;
        for (const alt of inner[1].split(",")) next.push(branch.replace(inner[0], alt));
      }
      branches = next.slice(0, BRANCH_CAP);
      if (!changed) return branches;
    }
  };
  // v1.62: a ? never blocks self-match (it matches any one char), so hosting hinges on the probe
  // clearing the collectable literals — search ? positions over that alphabet PER POSITION (a mixed
  // scope like test?/unit.tes?.ts needs different chars at each ?). Every accepted probe is a concrete
  // path satisfying BOTH globs (a witness), so expansion and substitution can only lift false
  // rejections — a scope with no witness still fails every probe. Bounded: entries with more than
  // QMARK_CAP ?s stay fail-closed (4^4 = 256 candidates is the ceiling per probe).
  const QMARK_CHARS = ["t", "e", "s", "."];
  const QMARK_CAP = 4;
  const qmarkVariants = (probe: string): string[] => {
    const qCount = (probe.match(/\?/g) ?? []).length;
    if (qCount === 0 || qCount > QMARK_CAP) return [probe];
    let variants = [probe];
    for (let i = 0; i < qCount; i++) {
      variants = variants.flatMap((v) => QMARK_CHARS.map((ch) => v.replace("?", ch)));
    }
    return [probe, ...variants];
  };
  const canHostTest = (entry: string) => {
    const self = filesGlob(entry); // Q120s shared matcher — paren dirs stay literal in the self-probe
    return expandBraces(entry)
      .flatMap((branch) => PROBE_TOKENS.map((token) => branch.replace(/\*+/g, token)))
      .flatMap(qmarkVariants)
      .some((probe) => self(probe) && collectable(probe));
  };
  const homeless = drafts
    .filter((draft) => {
      const files = csv(draft.fields.files);
      return files.length > 0 && !files.some(canHostTest)
        && draft.acceptance.some((item) => typeof item !== "string" && item.oracle === "test");
    })
    .map((draft) => draft.id);
  if (homeless.length) {
    throw new CompileError(
      `OBS-97: task${homeless.length === 1 ? "" : "s"} ${homeless.join(", ")} carr${homeless.length === 1 ? "ies" : "y"} a test: acceptance oracle but files[] cannot host a vitest-collectable test path (${COLLECTABLE_TESTS}).\n` +
        `Add a ${COLLECTABLE_TESTS} entry to files[] in ${file}, or replace the test: oracle with command:/judge:.`,
    );
  }

  const tasks = drafts.map((draft) => {
    const { fields } = draft;
    const shape = fields.shape ?? inferShape(draft.title);
    if (!(SHAPES as readonly string[]).includes(shape)) invalid(draft.id, "shape", `must be one of ${SHAPES.join(", ")}`);

    const complexity = fields.complexity === undefined ? 5 : Number(fields.complexity);
    if (!Number.isInteger(complexity) || complexity < 1 || complexity > 10) invalid(draft.id, "complexity", "must be an integer from 1 to 10");

    if (fields.humangate !== undefined && fields.humangate !== "true" && fields.humangate !== "false") {
      invalid(draft.id, "humanGate", "must be literally true or false");
    }

    const pin = fields.pin?.split(/\s+/);
    if (pin && (pin.length !== 2 || pin.some((part) => !part))) invalid(draft.id, "pin", "must be exactly 'via model'");
    if (fields.floor !== undefined && !(TIERS as readonly string[]).includes(fields.floor)) {
      invalid(draft.id, "floor", `must be one of ${TIERS.join(", ")}`);
    }
    const badGate = draft.gates.find((gate) => !(GATE_NAMES as readonly string[]).includes(gate));
    if (badGate) invalid(draft.id, "gates", `contains invalid gate "${badGate}"`);

    const timeoutMinutes = fields.timeout === undefined ? undefined : Number(fields.timeout);
    if (fields.timeout !== undefined && (!Number.isFinite(timeoutMinutes) || timeoutMinutes! <= 0)) {
      invalid(draft.id, "timeout", "must be a positive number");
    }

    const routingHints = pin || fields.floor ? {
      ...(pin ? { pin: { via: pin[0], model: pin[1] } } : {}),
      ...(fields.floor ? { floor: fields.floor } : {}),
    } : undefined;

    return {
      id: draft.id,
      title: draft.title,
      goal: fields.goal ?? draft.title,
      shape,
      complexity,
      deps: csv(fields.deps),
      files: csv(fields.files),
      context: csv(fields.context),
      acceptance: draft.acceptance,
      ...(fields.humangate === "true" ? { humanGate: true } : {}),
      ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
      ...(routingHints ? { routingHints } : {}),
      ...(draft.hasGates ? { gates: draft.gates } : {}),
    };
  });

  const result = validateGraph({
    version: 1,
    ...(specMode ? { mode: specMode } : {}),
    spec: {
      source: "native",
      paths: [file],
      hash: sha256(content),
      ...(specBase !== undefined ? { base: specBase } : {}),
    },
    tasks,
  });
  const authoringFindings = authoringLintFindings(result.tasks, file);
  for (const finding of authoringFindings.filter(({ code }) => code !== "criterion-scope")) {
    console.warn(renderAuthoringFinding(finding));
  }
  const scopeErrors = authoringFindings.filter(({ code }) => code === "criterion-scope");
  if (scopeErrors.length > 0) {
    throw new CompileError(
      `${file} violates the criterion-scope authoring lint (${scopeErrors.length} error${scopeErrors.length === 1 ? "" : "s"}):\n`
        + scopeErrors.map((finding) => `  - ${renderAuthoringFinding(finding)}`).join("\n"),
    );
  }
  // v1.19 read-old/write-new: a plain-string acceptance item compiles as a judge oracle. This is the
  // one-time nudge toward typed oracles (command/test/judge); PRD/Spec Kit/GSD stay silent (untouched).
  if (plainCount > 0) {
    console.warn(
      `tickmarkr: ${plainCount} acceptance item${plainCount === 1 ? "" : "s"} in ${file} ${plainCount === 1 ? "is a plain string" : "are plain strings"} — compiled as judge oracle${plainCount === 1 ? "" : "s"}. Prefix with command:/test:/judge: to make the oracle explicit.`,
    );
  }
  // OBS-51: semicolon-joined judge criteria invite intermittent clause-split verdicts — warn per item.
  for (const draft of drafts) {
    for (const item of draft.acceptance) {
      const text = typeof item === "string" ? item : item.oracle === "judge" ? item.text : null;
      if (text?.includes(";")) {
        console.warn(
          `tickmarkr: OBS-51: task ${draft.id} judge criterion contains semicolon-joined clauses — split into separate acceptance items: ${JSON.stringify(text)}`,
        );
      }
    }
  }
  // OBS-170/OBS-184: warn per unreachable context: entry, classified by the action its author must
  // take. Warn-only by operator ruling (2026-08-03) — fail-closed would have refused to compile the
  // spec that shipped green. Fails open when git cannot answer, so non-repo fixtures stay silent.
  const repo = tasks.some((task) => task.context.length > 0) ? trackedAtHead(dirname(file)) : undefined;
  if (repo) {
    const unreachable: string[] = [];
    for (const t of tasks) {
      for (const entry of t.context) {
        const { kind, suggestion } = classifyContextPath(entry, repo.tracked, repo.root);
        if (kind === "untracked") {
          // Permanent, by ruling: the per-file force-add IS the opt-in, so this stays a standing
          // prompt. "and commit" is load-bearing — staging alone leaves it out of the base tree.
          console.warn(
            `tickmarkr: OBS-170: task ${t.id} context ${JSON.stringify(entry)} exists in your checkout but is NOT in a worker's worktree. To make it worker context: git add -f ${entry} && git commit. Staging alone is not enough.`,
          );
        } else if (kind === "missing") {
          unreachable.push(
            `  ${t.id}: ${JSON.stringify(entry)}${suggestion ? `\n      → did you mean ${suggestion} ?` : "\n      → not found in the repository, and not a path."}`,
          );
        }
      }
    }
    if (unreachable.length) {
      throw new CompileError(
        `context: paths that do not exist in ${file}:\n${unreachable.join("\n")}\n\n` +
          `A context: entry is a promise the worker can read it. These resolve to nothing in the repository,\n` +
          `so the worker would be told to read a file that is not there. Fix the paths and recompile.`,
      );
    }
  }
  return result;
}

// Commented native spec written to tickmarkr.spec.md by `tickmarkr init`. Documented via HTML comments (which the
// parser ignores) so the template itself round-trips through compileSource() unchanged. Every field is
// documented; the two example tasks illustrate plain vs deps+routing-hint, each with acceptance[].
export function specTemplate(): string {
  return `<!-- tickmarkr:spec -->
# tickmarkr native spec

Your starting point for a tickmarkr native spec. Edit this file, then run:
  tickmarkr compile tickmarkr.spec.md && tickmarkr plan && tickmarkr run

Each task is a "## Tn: Title" heading with "- field: value" bullets.
acceptance is required on every task (a nested list of observable outcomes).

<!--
  Spec front-matter (top-level, before the first task heading):
    mode: partner-led | risk-based | staff-led — this engagement's routing mode
          (loses only to an explicit \`run --mode\` flag)
    base: commit-or-ref — optional declared source base; the declaration must begin at column zero
                          (runtime enforcement happens before a run)

  Fields available per task:
    goal:        outcome the task must achieve (defaults to the title if omitted)
    shape:       plan | spec | implement | tests | docs | migration | ui | refactor | chore
                 (auto-inferred from the title if omitted)
    deps:        comma-separated task ids this depends on, or "none"
    files:       comma-separated repo paths this task may touch
    context:     comma-separated paths the task should read for background
    complexity:  integer 1 to 10 (default 5)
    humanGate:   true | false — pauses for a human review before merging this task
    pin:         "via model" — pin an exact channel, e.g. "claude-code opus"
    floor:       cheap | mid | frontier — minimum capability tier for routing
    gates:       nested list; build | test | lint | evidence | scope are mandatory;
                 acceptance | review may be omitted
    acceptance:  nested list (REQUIRED, non-empty). Each item is either a typed oracle or plain text:
                 - command: <shell>   (oracle: command — exit code)
                 - test: <name>       (oracle: test — named test)
                 - judge: <rubric>    (oracle: judge — LLM-judged, free text)
                 - <plain text>       (compat: compiles as judge oracle, warns)

  HARD BOUNDS — these FAIL the compile, they do not warn:
    - at most 6 acceptance items per task (no exception path)
    - at most 8 files[] patterns; a {a,b} brace group counts as ONE pattern
    - acceptance items x files[] patterns must be <= 24 ("surface")
    - at most 60 goal words per acceptance criterion ("density")
    Density is goal words DIVIDED BY items, so REMOVING a criterion RAISES it. Compress the goal in the
    same edit, or a task that was comfortably inside the bound breaches it while you are tidying up.

  WHAT MAKES A CRITERION REAL:
    - "test:" must name a real test asserting on recorded state, journal lines, or drawn frames, and its
      title must match the criterion string verbatim. It also needs a collectable test path in files[].
    - A "test:" oracle's criterion must be the test's OWN title — the leaf — verbatim. Nesting under
      describe() is allowed (OBS-511: the gate matches the criterion as the trailing segment of the
      runner-visible full name), but the leaf title itself must equal the criterion: a shortened,
      decorated, or paraphrased leaf selects ZERO tests and the gate parks even though the suite is green.
      Measured before the widening: two parks across two runs, one full attempt lost in each.
    - NO criterion may be satisfiable by an absence, a rename, a source-text grep, or an empty collection.
      "no file references X" is not a criterion — it passes in a repo where the feature was never built.
    - "goal:" is NEVER verification. Prose in the goal enforces nothing: every obligation needs an
      acceptance item, or a NAMED independent gate that actually applies. A gate is not independent of a
      task that owns both the thing it checks and the fixture it checks against.
    - A source-only obligation (a comment or doc that a change makes false) has no lawful "test:" — verify
      it with "judge:", which reads the DIFF and must cite a changed line in a file the task owns.
    - A criterion that pins the SHAPE of a fix must also pin the CONDITIONS under which it runs, or a
      correctly-shaped fix that runs SOMETIMES satisfies it. "cleanup is try/finally at all four sites"
      is satisfied by \`finally { if (cond) cleanup() }\` — the shape is present and the fix is inert in
      production. Say UNCONDITIONAL, or name the branch that may not exist.
    - Ask of every criterion: COULD THIS BE SATISFIED BY CODE THAT NOTHING OUTSIDE THE TEST SUITE CALLS?
      A criterion naming a CAPABILITY is satisfiable by a stub whose only caller is its own test, and the
      judge cannot catch it — it reads the DIFF, and a stub's hunks are real. Name the PRODUCTION CALLER
      that must exercise the capability, and the path it runs on; "X is supported" ships as dead code.
    - Enumerating one axis exhaustively is what hides the others. A spec that guards PARTIAL coverage
      site-by-site, member-by-member, can be defeated wholesale by CONDITIONAL coverage, which leaves
      every enumeration satisfied. After you enumerate, ask what a single flag would do to the whole set.
    - EVERY CRITERION NAMES THE PAIR IT DISCRIMINATES: the correct case that MUST PASS, and the
      neighbouring plausible-wrong or false-clean case that MUST FAIL. Two easy examples that both pass are
      not discrimination — they are two ways of being green, and the wrong half is the whole point: it is
      what a reader would mistake for the mechanism, its VOCABULARY without its behaviour. Measured three
      times in three days, each a criterion that pinned vocabulary instead of the discriminating case: a
      suite that pinned an alarm's text while the alarm itself went unpinned; an export asserted SOMEWHERE,
      which says nothing about the environment a process actually receives; and a gate green on "infra is
      what execution says" while a signalled oracle still charged an attempt. Each was satisfied exactly as
      written and each shipped the defect. If you cannot name the case that must FAIL, you have named a
      topic, not a criterion — and the "so X fails" clause that ends a good criterion is where it goes.
    - A criterion that names a behaviour must name the VALUE AT WHICH IT WOULD BREAK. Every criterion is a
      claim about a variable — a status, a width, a count, an arrival time — and if it does not say which
      value of that variable is the hard one, THE TEST WILL CHOOSE THE EASY ONE AND BE GREEN. Measured: a
      grace-window criterion whose tests pinned pane status to "working" when the defect needed "blocked";
      a width criterion tested at 2-cell task ids when the schema permits 64; a fork-budget criterion
      tested only where concurrency <= cores when config accepts every positive integer. Each was
      satisfied exactly as written, and each shipped the defect. State six things per criterion:
        1. the PRODUCTION ENTRY POINT and the FINAL OBSERVABLE — what a caller invokes, what a reader sees;
        2. the AUTHORITATIVE SOURCE of each value, never a nearby re-derivation that can disagree with it;
        3. the QUANTIFIER, or the closed subject set the claim ranges over;
        4. the VARIABLE whose change could falsify the claim;
        5. TWO DISCRIMINATING CASES that vary that variable — or the invariance relation, if the claim is
           that varying it changes nothing — drawn from the FULL domain the system accepts, never a
           convenient subrange, because the domain is chosen by whoever must satisfy the criterion;
        6. the concrete FALSE-CLEAN case: what a passing test would look like if the mechanism were absent.
      A criterion that cannot name (4) is a claim about nothing and its test cannot fail. If (5) has no
      hard value anywhere in the domain, the criterion asserts a universal that may be FALSE ABOUT THE
      WORLD — bound it or say where it stops holding, rather than demanding a value that does not exist.

  WHICH SIDE OF A RUN INHERITS ENVIRONMENT — AND IT DEPENDS ON THE DRIVER (OBS-542):
    - Gate commands and "command:"/"test:" oracles INHERIT THE DAEMON'S ENVIRONMENT. They are children of
      the daemon, so launching it as \`bash -c 'set -a; . .env.test; set +a; exec tickmarkr run'\` reaches
      every one of them.
    - Under the HERDR driver, a WORKER PANE runs with a FRESH AMBIENT ENVIRONMENT: none of the daemon's
      exports reach it. It carries only what tickmarkr seeds explicitly — the run's workspace id, the
      pane's identity, and VITEST_MAX_FORKS (the one daemon value that crosses, so a worker's suites and
      the gate shells divide the machine the same way). A herdr worker cannot see a secret, a token, or
      an exported PATH edit, by deliberate design.
    - Under the SUBPROCESS driver, a worker inherits the daemon's environment wholesale (minus tickmarkr's
      own control vars).
    - The driver is resolved at RUN START, never at compile time, so a spec cannot know which one it gets.
    CONSEQUENCE FOR CRITERIA: anything needing credentials, a bound port, or the network belongs in a
    "command:"/"test:" oracle — NEVER in a worker's prose report. As prose it is satisfiable under the
    subprocess driver and impossible under herdr, while the byte-identical command inside an oracle passes
    under both. Measured: two burned attempts and three gate reds on one task, to learn one sentence.

  ORDERING AND OWNERSHIP:
    - Every path has exactly ONE owning task. Two tasks writing one file must be ORDERED by deps, or the
      loser's work is silently dropped when the integration tip advances.
    - A file one task CREATES cannot be "context:" for another — only deps: carries it, and that extends to
      the task that PRODUCES a value, not just the file's existence.
    - Deleting or renaming a symbol is a cross-task contract. Sweep for consumers by symbol AND by what the
      mechanism DOES for them; the most dangerous consumer is a file no task owns, because nothing fixes it
      and no edge can order it.

  EVIDENCE DISCIPLINE THE REVIEWERS ENFORCE (write criteria assuming these; violations are material):
    - A result row whose shape is unknown, mixed, or internally contradictory is MALFORMED and must fail
      closed. Recognizing one discriminator never licenses ignoring the rest of the row; malformed input
      may never normalize to passed or any other gate-satisfying outcome.
    - Preserve machine evidence according to the producer's protocol: never trim, discard, or change
      delimiters before validation. Git path evidence MUST use -z and NUL parsing with bytes preserved;
      inspect timeout, signal, and exit status before interpreting output, because a failed or timed-out
      producer may never normalize to an empty successful result.

  "timeout:" IS A KILL CEILING, NOT AN ESTIMATE. Never read a sum of timeouts as a predicted duration.
-->

## T1: Scaffold the feature
- goal: Lay the groundwork for the feature
- shape: implement
- files: src/feature.ts
- context: docs/design.md
- complexity: 4
- acceptance:
  - feature module exists and exports its entry point
  - npm test stays green

## T2: Cover it with tests
- goal: Add tests for the feature
- shape: tests
- deps: T1
- files: tests/feature.test.ts
- complexity: 3
- floor: cheap
- acceptance:
  - new tests pass
  - coverage floor holds
`;
}
