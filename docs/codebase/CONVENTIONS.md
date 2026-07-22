# Coding Conventions

**Analysis Date:** 2026-07-18

## Naming Patterns

**Files:**
- kebab-case for all source and test files: `claude-code.ts`, `cursor-agent.ts`, `run-gates.ts`, `via-driver.test.ts`, `daemon-interactive.test.ts`
- One file per adapter/gate/driver — file name matches the primary export's domain concept, not the exported symbol's exact casing (`route/router.ts` exports `route`, `nextChannel`, `RoutingError`)
- Test files mirror `src/` 1:1 under `tests/`: `src/gates/baseline.ts` → `tests/gates/baseline.test.ts`. Exceptions are additive, not divergent: `tests/gates/via-driver.test.ts` and `tests/gates/evidence-scope.test.ts` add cross-cutting coverage beside the per-file tests; `tests/run/daemon-interactive.test.ts` sits beside `tests/run/daemon.test.ts` for the v1.2 interactive-worker path.

**Functions:**
- camelCase throughout: `loadGraph`, `getTask`, `setStatus`, `readyTasks`, `runDaemon`, `pickReviewer`, `extractJson`
- Verb-first for actions (`validateGraph`, `saveGraph`, `compareToBaseline`), noun-first only for predicates/getters used as short accessors (`graphPath`, `channelKey`)
- Small inline helpers are `const` arrow functions scoped tightly to where they're used, e.g. `const enabled = (g: string) => ...` and `const failed = () => ...` inside `runGates` (`src/gates/run-gates.ts:40-41`), `const sanitize = (branch: string) => ...` at module scope in `src/run/git.ts:72-74`

**Variables:**
- camelCase; booleans are short predicate words, not force-prefixed with `is`/`has` (`pass`, `ok`, `finished`, `interactive`, `humanGate`, `keepOpen`, `paged`, `quotaHit`) — match this style over adding `is`/`has` prefixes when touching these files
- Loop/local shorthand is common and accepted in tight scopes: `t` for task, `c` for channel, `g` for graph, `r` for result — always in a function short enough that the abbreviation stays unambiguous (see `src/graph/graph.ts`, `src/route/router.ts`)

**Types:**
- PascalCase for all types/interfaces: `RunGraph`, `Task`, `GateResult`, `WorkerAdapter`, `TickmarkrConfig`, `ConsultVerdict`
- String-literal union pattern: declare the values as a `const` array with `as const`, derive the type from it. Reuse this exact shape for any new closed string enum:
  ```ts
  export const SHAPES = ["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore"] as const;
  export type Shape = (typeof SHAPES)[number];
  ```
  (`src/graph/schema.ts:3-9`, mirrored by `STATUSES`/`TaskStatus`, `GATE_NAMES`/`GateName`, and `ACTIONS`/`ConsultVerdict["action"]` in `src/run/consult.ts:21`)
- Prefer `interface` for object shapes (`Task`, `GateResult`, `Slot`), `type` only when it's a union, a mapped/inferred type, or a `z.infer<...>` result

**Constants:**
- UPPER_SNAKE_CASE for true constants: `TIER_RANK`, `MAX_ATTEMPTS`, `DIFF_CAP`, `BLOCKED_POLL_MS`, `EXIT_MARKER_CMD`, `EXIT_RE`, `QUOTA_RE`, `DEFAULT_CONFIG`, `PLAN_SUFFIX`
- Regexes that encode a domain contract get a named constant even when used once, with a comment explaining the "why" (`src/adapters/types.ts:172`, `src/adapters/prompt.ts:37`)

## Code Style

**Formatting:**
- No ESLint or Prettier config in the repo (`.eslintrc*`, `.prettierrc*`, `eslint.config.*` all absent). There is no format-on-save or lint gate — match the surrounding file's style by eye: 2-space indent, double quotes, semicolons, trailing commas in multiline literals.
- Lines run long by design — dense single-line object literals, ternaries, and chained `.filter().sort()` are normal and not wrapped at 80/100 cols (e.g. `src/route/router.ts:63-65`, `src/run/daemon.ts:294`). Don't reflow existing dense lines just to shorten them.
- `npm run build` (`tsc -p tsconfig.json`) is the only enforced static check — TypeScript `strict: true`, target `ES2022`, module `NodeNext`.

**Linting:**
- oxlint 1.74.0 via `npm run lint` (`package.json:33`) — no config file in-repo; CI runs it in `.github/workflows/ci.yml`. TypeScript strict mode (`npm run build`) is the compile-time guardrail; oxlint is the style/safety pass.

**Module system:**
- ESM only (`"type": "module"` in `package.json`), `moduleResolution: NodeNext`. Every relative import must include the literal `.js` extension even though the source is `.ts`: `import { validateGraph } from "../graph/schema.js"`. This is required by NodeNext, not a style choice — omitting it breaks the build.

## Import Organization

**Order (observed, not enforced by tooling):**
1. Node builtins, always `node:`-prefixed: `node:fs`, `node:path`, `node:child_process`, `node:os`, `node:crypto`, `node:util`
2. Third-party packages: `zod`, `yaml`, `picomatch`
3. Local relative imports, deepest dependency first — types/schema modules imported before the modules that consume them

**Type-only imports:**
- Inlined with the `type` keyword on individual named imports rather than a separate `import type { ... }` statement:
  ```ts
  import { type RunGraph, type Task, type TaskStatus, validateGraph } from "./schema.js";
  ```
  (`src/graph/graph.ts:3`) — follow this inline form, not a split `import type` line.

**Path Aliases:**
- None. All imports are relative and use explicit `.js` extensions under NodeNext. Do not introduce `@/`-style aliases.

## Error Handling

**Two distinct channels — pick the right one:**
1. **Exceptions** for programmer/environment errors that should stop execution: bad config, invalid graph, unknown adapter, missing files. Each domain gets its own `Error` subclass with `.name` set and an actionable message (often naming the exact fix):
   ```ts
   export class GraphValidationError extends Error {
     constructor(public issues: string[]) {
       super(`invalid RunGraph:\n  - ${issues.join("\n  - ")}`);
       this.name = "GraphValidationError";
     }
   }
   ```
   (`src/graph/schema.ts:72-77`; siblings: `RoutingError` in `src/route/router.ts:8`, `CompileError` in `src/compile/common.ts:4`). Thrown errors always explain *what to do*, not just what broke — e.g. `` `no graph at ${p} — run \`tickmarkr compile <src>\` first` `` (`src/graph/graph.ts:19`).
2. **Return values** for expected domain outcomes that are not exceptional: gate pass/fail is a `GateResult { gate, pass, details }`, routing produces `lints: string[]` alongside a valid assignment, `sh()` never throws and instead resolves `{ code, stdout, stderr }`. Only `shOk()` (the "assert exit 0" wrapper around `sh()`) throws, and only when a non-zero exit is genuinely unexpected (`src/run/git.ts:19-23`).

**Fail-closed is the house invariant** (stated in `CLAUDE.md`, enforced throughout):
- Unparseable LLM/judge/review JSON → `{ pass: false, details: "...unparseable — failing closed" }`, never assumed-pass (`src/gates/acceptance.ts:42-44`, `src/gates/review.ts:72-79`)
- A baseline command that flips from green to red with no recognizable failure lines still fails the gate (`src/gates/baseline.ts:58-65`)
- Malformed YAML frontmatter during GSD compile throws rather than silently dropping `autonomous:false` (a human-gate signal) — see the comment at `src/compile/gsd.ts:70`: `// fail closed: a swallowed parse error would silently drop autonomous:false (a human gate)`
- An unresolvable consult verdict defaults to `{ action: "human", ... }`, never to a silent retry (`src/run/consult.ts:77-79`)

**`try/catch` is rare and always commented when used** — every catch that swallows an error explains in-line why it's safe to swallow, and the scope of what's being ignored:
```ts
try {
  out.push(JSON.parse(line));
} catch {
  // torn trailing write after a crash — ignore; everything before it is intact
}
```
(`src/run/journal.ts:68-72`, mirrored in `readTelemetry`). Don't add a bare `catch {}` without this kind of justification comment.

**No `Result<T, E>` wrapper type** — the codebase uses plain return objects per domain (`GateResult`, `WorkerResult`, `ConsultVerdict`) instead of a generic result/either abstraction. Follow the existing per-domain shape rather than introducing a generic wrapper.

## Logging

**No logging framework.** `console.log`/`console.error` appear only at process boundaries:
- `src/cli/index.ts` prints the resolved command's return value once, and prints errors to `console.error` before `process.exit(1)`
- `SubprocessDriver.notify()` is a plain `console.log` fallback for operator notifications when not running under herdr (`src/drivers/subprocess.ts:66-68`)

Domain code never logs directly. It communicates through:
- Function return values (commands return `Promise<string>` — a human-readable report the CLI prints once)
- The journal (`Journal.append(event, taskId?, data)` — an append-only JSONL audit trail, `src/run/journal.ts`)

When adding a new code path that needs visibility, append a journal event or return a string — do not add a `console.log` inside `src/graph`, `src/route`, `src/gates`, or `src/run` business logic.

## Comments

**Sparse, and always "why" not "what."** A one-line comment on a non-obvious decision is common; comments narrating obvious code are absent. Recurring comment shapes to match:
- **Spec citations:** `// judge sees diff + criteria only, and not unboundedly (spec §12)` (`src/gates/acceptance.ts:12`), `// Quota exhaustion is detected from CLI errors, never predicted (spec §4)` (`src/adapters/types.ts:171`)
- **Locked-decision citations:** `// "--": a ref can't nest under the existing integration branch (locked decision 10)` (`src/run/daemon.ts:155`), `// operator release: ... (locked decision 12)` (`src/run/daemon.ts:57`)
- **Version provenance:** `// v1.1 failover: never re-ask a reviewer channel that produced garbage for this task` (`src/run/daemon.ts:270`), `// v1.2 interactive: the TUI doesn't exit on completion...` (`src/run/daemon.ts:182`)
- **Regression provenance** (names the concrete failure that forced the fix): `// v1.2 live check regression: cursor's renderer HARD-wraps the trailer JSON...` (`tests/adapters/prompt.test.ts:79-80`), `// (herdr agent_name_taken regression)` (`tests/run/daemon.test.ts:254`)
- **`ponytail:` comments** mark a deliberate simplification and name its ceiling — there are exactly 3 in `src/`, and the pattern is worth reusing verbatim for future shortcuts:
  - `src/run/daemon.ts:31` — `const MAX_ATTEMPTS = 10; // ponytail: hard cap so a pathological ladder can never loop forever`
  - `src/drivers/subprocess.ts:42` — `await new Promise((r) => setTimeout(r, 200)); // ponytail: 200ms poll; herdr driver has real event waits`
  - `src/adapters/fake.ts:23` — `// ponytail: deterministic scripted adapter — the whole integration suite runs on it, zero tokens.`

**No JSDoc/TSDoc anywhere in `src/`.** Do not add `/** ... */` doc blocks — the codebase relies on precise types plus targeted inline comments instead.

**Routing quirk provenance:** every routing exclusion (`routing.deny`, `routing.allow`) or pin (`routing.map.*.pin`) that exists because of a live incident must carry an inline `#` comment on the entry naming its **observation id** (the `OBS-NN` key in `.planning/OBSERVATIONS.md`), **root cause** (what failed in production), and **removal condition** (the specific shipped fix or gate that makes the workaround safe to delete). Prefer the block-list form for deny entries so the comment rides the list item — the shipped `configTemplate()` demonstrates the convention on `pi:zai/glm-5.2` / OBS-57. Do not add incident-born quirks without all three fields; a bare deny with no provenance is for fleet-wide policy, not a workaround nobody dares remove.

## Function Design

**Size:** Most functions are short and single-purpose (gates, adapters, compile front-ends average well under 30 lines). The one deliberate exception is `runDaemon`/`execTask` in `src/run/daemon.ts` — a ~280-line closure-based state machine covering dispatch, retries, escalation, quota failover, and merge. This is accepted as inherent complexity of a single sequential state machine, not sprawl to copy elsewhere; keep new orchestration logic inside its existing closures rather than splitting the state machine across files.

**Parameters:** Functions taking more than 2-3 conceptual inputs take a single options/context object rather than a long positional list — see `GateContext` (`src/gates/run-gates.ts:13-25`) and `RunOptions` (`src/run/daemon.ts:20-27`). Positional params are fine for 2-4 required, tightly-related values (`mergeTask(intWt, taskBranch, message)`).

**Return Values:** Async I/O helpers return plain data, never throw for expected failure paths (see Error Handling above). Functions that produce a decision alongside diagnostics return both together in one object (`{ assignment, ladder, lints }` from `route()`, `{ results, commits }` from `runGates()`) instead of out-parameters or side channels.

## Module Design

**Exports:** Named exports only — no default exports anywhere in `src/`. Adapters that are plain data + behavior with no internal state are exported as a `const` object literal implementing the interface (`export const claudeCode: WorkerAdapter = {...}` in `src/adapters/claude-code.ts`); a `class` is reserved for modules that own real mutable state or a resource lifecycle (`FakeAdapter` tracks per-task attempt counts; `Journal` wraps a directory + private constructor with `static create`/`static open`; `SubprocessDriver`/`HerdrDriver` own a slot map). There are exactly 7 classes in `src/` — reach for a plain object/function first, and only promote to a class when you need instance state.

**Barrel files:** Used only at true dispatch/aggregation points, not as blanket re-export convenience:
- `src/compile/index.ts` — detects spec type and dispatches to `compileGsd`/`compilePrd`/`compileSpecKit`
- `src/drivers/index.ts` — `pickDriver()` chooses `HerdrDriver` vs `SubprocessDriver`
- `src/adapters/registry.ts` — adapter lookup/health/channel discovery

`src/index.ts` is a minimal package entry (`export const VERSION = "0.1.0"`), not a re-export barrel — import from the concrete module path, not from a top-level barrel.

**One concern per file:** each gate (`baseline`, `evidence`, `scope`, `acceptance`, `review`) is its own file under `src/gates/`; each real-CLI adapter (`claude-code`, `codex`, `cursor-agent`, `opencode`, `pi`, `grok`, `kimi`) is its own file under `src/adapters/`. When adding a new gate or adapter, add a new file rather than extending an existing one.

---

*Convention analysis: 2026-07-18*
