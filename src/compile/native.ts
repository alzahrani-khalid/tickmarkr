import { existsSync, readFileSync } from "node:fs";
import picomatch from "picomatch";
import { type AcceptanceItem, GATE_NAMES, GRAPH_ROUTING_MODES, ORACLES, SHAPES, TIERS, type RunGraph, validateGraph } from "../graph/schema.js";
import { CompileError, inferShape, sha256 } from "./common.js";

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
  acceptance: AcceptanceItem[];
  gates: string[];
  hasGates: boolean;
  list: "acceptance" | "gates" | null;
  goalContinuation: boolean;
}

function invalid(task: string, field: string, detail: string): never {
  throw new CompileError(`Task ${task} field "${field}" ${detail}`);
}

export function compileNative(file: string): RunGraph {
  if (!existsSync(file)) throw new CompileError(`no such native spec file: ${file}`);
  const content = readFileSync(file, "utf8");
  const drafts: Draft[] = [];
  let plainCount = 0; // v1.19: plain-string acceptance items compiled as judge oracles (compat) — warn once
  let specMode: (typeof GRAPH_ROUTING_MODES)[number] | undefined;

  for (const line of content.split("\n")) {
    const heading = line.match(HEAD_RE);
    if (heading) {
      drafts.push({ id: heading[1], title: heading[2].trim(), fields: {}, acceptance: [], gates: [], hasGates: false, list: null, goalContinuation: false });
      continue;
    }
    const draft = drafts.at(-1);
    if (!draft) {
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
      if (name === "acceptance" || name === "gates") {
        if (value) invalid(draft.id, field[1], "must be a nested list");
        draft.list = name;
        if (name === "gates") draft.hasGates = true;
        draft.goalContinuation = false;
      } else {
        if (name === "goal" && !value) invalid(draft.id, field[1], "must not be empty");
        draft.fields[name] = value;
        // OBS-60: carry every indented continuation line after `- goal:` into the compiled goal.
        draft.goalContinuation = name === "goal";
        draft.list = null;
      }
      continue;
    }

    // OBS-60: multiline goals — indented prose after `- goal:` is appended until the next field.
    if (draft.goalContinuation) {
      if ((line.startsWith(" ") || line.startsWith("\t")) && !NESTED_RE.test(line)) {
        draft.fields.goal += `\n${line.trim()}`;
        continue;
      }
      if (!line.trim()) {
        draft.fields.goal += "\n";
        continue;
      }
      draft.goalContinuation = false;
    }

    const nested = line.match(NESTED_RE);
    if (nested && draft.list) {
      const value = nested[1].trim();
      if (!value) invalid(draft.id, draft.list, "must not contain empty entries");
      // v1.19: only the acceptance list parses typed oracle prefixes; gates stay plain names.
      if (draft.list === "acceptance") {
        const typed = value.match(ORACLE_RE);
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
          draft.acceptance.push(value);
        }
      } else {
        draft[draft.list].push(value);
      }
      continue;
    }
    if (line.startsWith("- ")) invalid(draft.id, "field", `bullet is malformed: ${JSON.stringify(line)}`);
    if (line.trim() && !line.startsWith(" ")) draft.list = null;
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
  const splitTop = (value: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of value) {
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}" && depth > 0) depth--;
      current += ch;
    }
    return [...parts, current];
  };
  const csv = (value?: string) => (value && value.toLowerCase() !== "none" ? splitTop(value).map((item) => item.trim()).filter(Boolean) : []);

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
    const self = picomatch(entry, { dot: true });
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
    spec: { source: "native", paths: [file], hash: sha256(content) },
    tasks,
  });
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
