# Codebase Structure

**Analysis Date:** 2026-07-19

## Directory Layout

```
tickmarkr/
├── src/                        # TypeScript source (tsc → dist/)
│   ├── adapters/                # one module per agent CLI + fake + shared types/registry
│   │   ├── types.ts               # WorkerAdapter contract, Assignment/BillingChannel, shq(), QUOTA_RE
│   │   ├── registry.ts            # allAdapters(), probeAll(), discoverChannels(), doctor.json persistence
│   │   ├── prompt.ts              # task prompt template, TRAILER_PATTERN, parseWorkerResult()
│   │   ├── claude-code.ts         # + codex.ts, cursor-agent.ts, opencode.ts — one real adapter each
│   │   └── fake.ts                # deterministic scripted adapter — zero-token test double
│   ├── cli/
│   │   ├── index.ts               # argv → command dispatch table + usage text
│   │   └── commands/              # one file per subcommand (init/doctor/fleet/compile/scope/plan/run/status/resume/report/profile/unlock/approve/version)
│   ├── compile/                  # spec front-ends → RunGraph
│   │   ├── index.ts               # compileSource(): type detection + dispatch
│   │   ├── common.ts              # CompileError, sha256(), inferShape()
│   │   ├── native.ts              # primary native tickmarkr spec front-end (tickmarkr:spec marker)
│   │   ├── collateral.ts          # advisory plan-time scope-lint scan (never fails compile)
│   │   ├── speckit.ts             # GitHub Spec Kit tasks.md front-end
│   │   ├── prd.ts                 # bare markdown PRD front-end
│   │   └── gsd.ts                 # GSD .planning/ phase-dir front-end (v1.3)
│   ├── config/
│   │   └── config.ts              # TickmarkrConfig type, DEFAULT_CONFIG seed table, loadConfig(), configTemplate()
│   ├── drivers/                  # ExecutorDriver interface + implementations
│   │   ├── types.ts               # ExecutorDriver, Slot, NotifyOpts
│   │   ├── index.ts               # pickDriver(): herdr | subprocess | auto
│   │   ├── herdr.ts               # visible-pane driver (shells out to the `herdr` CLI)
│   │   └── subprocess.ts          # plain child-process driver (fallback, no operator visibility)
│   ├── gates/                    # quality gates + shared LLM dispatch
│   │   ├── types.ts               # GateResult
│   │   ├── run-gates.ts           # runGates(): sequences all gates, short-circuits on failure
│   │   ├── baseline.ts            # build/test/lint vs pre-run baseline, fingerprinting
│   │   ├── evidence.ts            # commits/diff-not-empty check
│   │   ├── scope.ts               # picomatch file-scope check vs task.files
│   │   ├── acceptance.ts          # LLM judge vs task.acceptance[]
│   │   ├── review.ts              # cross-vendor LLM review + pickReviewer()
│   │   └── llm.ts                 # runHeadless/runViaDriver, extractJson() defensive JSON parse
│   ├── graph/                     # RunGraph data model
│   │   ├── schema.ts               # zod TaskSchema/RunGraphSchema, validateGraph(), cycle detection
│   │   └── graph.ts                 # load/save/query/mutate helpers (all immutable spread-updates)
│   ├── plan/                        # LLM scope/intent helpers (tickmarkr scope / plan gates)
│   │   ├── scope.ts                  # clarification gate + scope LLM dispatch
│   │   └── prompt.ts                 # scope prompt templates
│   ├── report/                      # post-run reporting helpers
│   │   └── cost.ts                   # pure telemetry → cost estimates
│   ├── route/
│   │   ├── router.ts                 # route(): pin > map > floors > auto; nextChannel() for escalation
│   │   ├── profile.ts                # telemetry-learned scores + exploration bonus
│   │   ├── preference.ts             # doctor-derived prefer/exclude ranks
│   │   └── candidates.ts             # rankCandidates() for plan picker output
│   ├── run/                         # orchestration runtime
│   │   ├── daemon.ts                 # runDaemon(): the main loop — largest file in src/
│   │   ├── journal.ts                # Journal class: event log + telemetry log, resume replay
│   │   ├── git.ts                    # sh()/shOk(), gitHead(), createWorktree()/removeWorktree()
│   │   ├── merge.ts                  # integration branch lifecycle, mergeTask()
│   │   ├── consult.ts                # frontier-model escalation, dossier prompt, verdict parsing
│   │   ├── lock.ts                   # advisory graph.json run lock (link idiom + heartbeat)
│   │   ├── reconcile.ts              # desired herdr pane set from journal (orphan cleanup)
│   │   └── stall.ts                  # spinner-safe stall-inactivity snapshot normalizer
│   └── index.ts                     # VERSION constant only
├── tests/                          # vitest — mirrors src/ 1:1, plus e2e/ and helpers/
│   ├── adapters/ · cli/ · compile/ · config/ · drivers/ · gates/ · graph/ · plan/ · report/ · route/ · run/
│   ├── e2e/
│   │   └── real-cli.test.ts          # opt-in, TICKMARKR_E2E=1, spends tokens, needs a real installed CLI
│   ├── helpers/
│   │   └── tmprepo.ts                 # makeRepo(), setupRepo(), T() — shared git-backed fixtures
│   └── smoke.test.ts                  # top-level sanity check, no mirrored src file
├── fixtures/                       # sample spec inputs consumed by compiler tests
│   ├── gsd-sample/07-live-check/      # *-PLAN.md + *-SUMMARY.md fixtures for compile/gsd.test.ts
│   ├── speckit-sample/tasks.md
│   └── sample.prd.md
├── schema/
│   └── rungraph.schema.json          # generated — `npm run schema`, do not hand-edit
├── scripts/
│   └── emit-schema.ts                 # zod RunGraphSchema → JSON Schema generator
├── docs/
│   └── codebase/                     # shipped codebase reference (this document's home)
├── specs/                              # native tickmarkr spec artifacts for this repo
├── CLAUDE.md                           # project invariants + architecture one-liners
├── package.json / package-lock.json
├── tsconfig.json
└── vitest.config.ts
```

## Directory Purposes

**`src/adapters/`:**
- Purpose: everything specific to one agent CLI, isolated behind the `WorkerAdapter` contract
- Contains: the contract + shared types (`types.ts`), discovery/doctor persistence (`registry.ts`), the shared task-prompt template and trailer parser used by every real adapter (`prompt.ts`), one file per real CLI, and `fake.ts` (the scripted test double)
- Key files: `src/adapters/types.ts`, `src/adapters/registry.ts`, `src/adapters/prompt.ts`

**`src/cli/`:**
- Purpose: thin argv-parsing shell around the engine
- Contains: the dispatch table (`index.ts`) and one function-per-file in `commands/`, each `async (argv, cwd?) => Promise<string>`
- Key files: `src/cli/index.ts`, `src/cli/commands/run.ts`

**`src/compile/`:**
- Purpose: adapt heterogeneous spec formats (native tickmarkr spec, Spec Kit, bare PRD, GSD `.planning/`) into the one RunGraph shape
- Contains: type-detection front door (`index.ts`), primary native front-end (`native.ts`), advisory scope-lint scan (`collateral.ts`), one parser per legacy/alternate format, shared error type + helpers (`common.ts`)
- Key files: `src/compile/index.ts`, `src/compile/native.ts`, `src/compile/gsd.ts`

**`src/config/`:**
- Purpose: single seed table + layered override resolution
- Contains: the `TickmarkrConfig` type, `DEFAULT_CONFIG`, `deepMerge()` (null = tombstone), `loadConfig()`, and the commented YAML template written by `tickmarkr init`
- Key files: `src/config/config.ts`

**`src/drivers/`:**
- Purpose: abstract "where a command runs and how it's observed" behind one interface
- Contains: the `ExecutorDriver`/`Slot` contract, the herdr (visible pane) implementation, the subprocess (child process) fallback, and `pickDriver()` auto-selection
- Key files: `src/drivers/types.ts`, `src/drivers/herdr.ts`, `src/drivers/subprocess.ts`

**`src/gates/`:**
- Purpose: independently re-verify every worker claim before a task can merge
- Contains: the uniform `GateResult` type, the sequencer (`run-gates.ts`), five gate implementations, and the shared LLM-dispatch helper (`llm.ts`) used by both the acceptance judge and cross-vendor review
- Key files: `src/gates/run-gates.ts`, `src/gates/llm.ts`

**`src/graph/`:**
- Purpose: own the RunGraph/Task data model, on disk at `.tickmarkr/graph.json`
- Contains: the zod schema (source of truth for the `Task`/`RunGraph` TypeScript types) and pure, immutable load/save/query/mutate helpers
- Key files: `src/graph/schema.ts`, `src/graph/graph.ts`

**`src/route/`:**
- Purpose: pure routing-resolution logic, no I/O
- Contains: `route()` and escalation in `router.ts`, telemetry-learned scores in `profile.ts`, doctor prefer/exclude in `preference.ts`, ranked picker in `candidates.ts`
- Key files: `src/route/router.ts`, `src/route/profile.ts`, `src/route/candidates.ts`

**`src/plan/`:**
- Purpose: LLM-backed scope/intent helpers for `tickmarkr scope` and plan-time human gates
- Contains: clarification gate + scope dispatch (`scope.ts`), prompt templates (`prompt.ts`)
- Key files: `src/plan/scope.ts`, `src/plan/prompt.ts`

**`src/report/`:**
- Purpose: pure post-run cost estimation from telemetry
- Contains: `estimateCosts()` in `cost.ts`
- Key files: `src/report/cost.ts`

**`src/run/`:**
- Purpose: the orchestration runtime — the daemon loop and everything it directly needs (ledger, git, merge, escalation, locking, pane hygiene, stall detection)
- Contains: `daemon.ts` (main loop), `journal.ts` (event/telemetry log), `git.ts` (shell + worktree primitives), `merge.ts` (integration branch), `consult.ts` (frontier-model escalation), `lock.ts` (run lock), `reconcile.ts` (pane reconcile), `stall.ts` (stall normalizer)
- Key files: `src/run/daemon.ts` (351 lines — the largest file in `src/`), `src/run/journal.ts`

**`tests/`:**
- Purpose: vitest unit + integration tests, zero tokens spent (fake adapter only) except `tests/e2e/`
- Contains: one directory per `src/` subdirectory (mirrored 1:1), plus `e2e/` (opt-in, real CLI) and `helpers/` (shared fixtures)
- Key files: `tests/helpers/tmprepo.ts`

**`fixtures/`:**
- Purpose: realistic sample spec inputs so compiler tests parse real-shaped markdown/YAML instead of inline strings
- Contains: a GSD phase dir, a Spec Kit `tasks.md`, and a bare PRD
- Generated: No — hand-authored, committed

**`schema/`:**
- Purpose: publish the RunGraph shape as a standalone JSON Schema (consumers outside this repo can validate against it)
- Contains: `rungraph.schema.json`, generated from `RunGraphSchema` by `npm run schema`
- Generated: Yes (`scripts/emit-schema.ts`) — committed anyway since it ships in `package.json` `files`

**`docs/codebase/`:**
- Purpose: the shipped codebase reference map — architecture, structure, stack, integrations, conventions, testing, CLI design, concerns
- Contains: hand-maintained markdown refreshed against the current tree (this document lives here)
- Generated: No — hand-authored, committed

**`specs/`:**
- Purpose: native tickmarkr spec artifacts scoped to this repository's own development
- Generated: No — hand-authored, committed

**Runtime state (`.tickmarkr/`, not present until first command):**
- Purpose: runtime state for compiled graphs and runs, created the first time any command touches a repo
- Contains: `graph.json`, `doctor.json`, `config.yaml` (repo overlay), `runs/<runId>/{journal.jsonl, telemetry.jsonl, baseline.json, prompts/, consults/}`, `worktrees.noindex/<branch>/` (OBS-49: `.noindex` suffix keeps macOS Spotlight off worktree churn)
- Generated: Yes, entirely at runtime
- Committed: No — gitignored at the repo level and additionally self-writes its own `.tickmarkr/.gitignore` containing `*` (`tickmarkrDir()`, `src/graph/graph.ts:9-15`)

## Key File Locations

**Entry Points:**
- `src/cli/index.ts`: `argv[2]` → command dispatch; the `tickmarkr` binary (`package.json` `bin`) points at its compiled `dist/cli/index.js`
- `src/run/daemon.ts` (`runDaemon`): the actual orchestration engine entry point; called by both `run` and `resume` CLI commands and by integration tests directly

**Configuration:**
- `src/config/config.ts`: `DEFAULT_CONFIG` (routing map/floors, adapter tier tables, gate/judge/review/consult/visibility settings) + `loadConfig()` (defaults < `~/.config/tickmarkr/config.yaml` < `.tickmarkr/config.yaml`)
- `.tickmarkr/config.yaml` / `~/.config/tickmarkr/config.yaml`: the actual files a user edits, seeded by `tickmarkr init` from `configTemplate()`
- `tsconfig.json`, `vitest.config.ts`, `package.json`: build/test/package config

**Core Logic:**
- `src/run/daemon.ts`: task lifecycle, concurrency, escalation ladder
- `src/route/router.ts`: routing resolution
- `src/gates/run-gates.ts`: gate sequencing
- `src/graph/schema.ts`: the RunGraph/Task data model

**Testing:**
- `tests/<dir>/<name>.test.ts` mirrors `src/<dir>/<name>.ts`
- `tests/helpers/tmprepo.ts`: `makeRepo()` (bare git repo fixture), `setupRepo()` (graph + config + scripted `FakeAdapter` in one call), `T()` (minimal task builder)
- `src/adapters/fake.ts` (`FakeAdapter`): not test-only code, but the adapter nearly every non-e2e test dispatches through — scripts worker/judge/review/consult output from a JSON file, zero tokens

## Naming Conventions

**Files:**
- Lowercase, kebab-case for multi-word names: `cursor-agent.ts`, `run-gates.ts`, `real-adapters.test.ts`
- Single-word files for single-concept modules: `daemon.ts`, `router.ts`, `journal.ts`, `merge.ts`
- Test files: `<mirrored-name>.test.ts` under `tests/<same-dir-as-src>/`

**Directories:**
- Plural for "one-of-many implementations" collections: `adapters/`, `gates/`, `drivers/`, `commands/`
- Singular/domain-name for a cohesive concept area: `graph/`, `route/`, `config/`, `run/`, `compile/`

**Functions/variables:** `camelCase` (`loadConfig`, `runDaemon`, `compileSource`, `readyTasks`)

**Types/interfaces:** `PascalCase` (`RunGraph`, `Task`, `WorkerAdapter`, `ExecutorDriver`, `GateResult`, `TickmarkrConfig`)

**Constants:** `UPPER_SNAKE_CASE` (`DEFAULT_CONFIG`, `MAX_ATTEMPTS`, `TIER_RANK`, `GATE_NAMES`, `SHAPES`, `STATUSES`, `QUOTA_RE`, `TRAILER_PATTERN`, `EXIT_RE`)

**Task ids:** two accepted shapes, enforced by regex in `src/graph/schema.ts:15-19` — `T<n>` style from prd/speckit compilers, `P<phase>-<plan>` style from the gsd compiler (e.g. `P07-01`); ids must start with a letter, contain only letters/digits/`-`/`_`, and may never contain `--` or end with `-` (both are reserved — `--` separates a task branch from the integration branch name)

## Where to Add New Code

**New agent CLI adapter:**
- Implementation: `src/adapters/<name>.ts` implementing `WorkerAdapter` (`src/adapters/types.ts`) — model it on `src/adapters/opencode.ts` (shortest real example)
- Register: add to the `real` array in `allAdapters()`, `src/adapters/registry.ts:13`
- Seed its tier table: add an entry under `tiers` in `DEFAULT_CONFIG`, `src/config/config.ts:57-75`
- Tests: `tests/adapters/real-adapters.test.ts` (probe/channel shape) — no live-CLI test needed for the adapter file itself

**New spec front-end / compiler:**
- Implementation: `src/compile/<name>.ts` exporting `compile<Name>(src: string): RunGraph`, ending with `validateGraph({...})` — model it on `src/compile/prd.ts` (simplest)
- Wire in: extend `detect()` and the dispatch in `compileSource()`, `src/compile/index.ts:9-28`
- Enforce the non-negotiable invariant: throw `CompileError` if any task would have an empty `acceptance[]` (every existing front-end does this — see `src/compile/gsd.ts:88-93` for the pattern)
- Tests: `tests/compile/<name>.test.ts`, with a fixture under `fixtures/`

**New gate:**
- Implementation: `src/gates/<name>.ts` returning `Promise<GateResult>` (or `GateResult[]` for baseline-style multi-check gates)
- Register: add the name to `GATE_NAMES` in `src/graph/schema.ts:5`, then call it from `runGates()` in `src/gates/run-gates.ts` in the position where it should short-circuit
- Tests: `tests/gates/<name>.test.ts`

**New driver (execution substrate):**
- Implementation: `src/drivers/<name>.ts` implementing `ExecutorDriver` (`src/drivers/types.ts`)
- Register: extend `pickDriver()`, `src/drivers/index.ts:6-11`
- Tests: `tests/drivers/<name>.test.ts`

**New CLI command:**
- Implementation: `src/cli/commands/<name>.ts` exporting `async function <name>(argv: string[], cwd?: string): Promise<string>`
- Register: add to the `COMMANDS` map and the `USAGE` string in `src/cli/index.ts`
- Tests: `tests/cli/cli.test.ts`

**Utilities:**
- Cross-cutting shell/git helpers live in `src/run/git.ts` (`sh`, `shOk`, `gitHead`, `createWorktree`) — reuse these rather than spawning processes directly in a new module
- Cross-cutting adapter helpers (shell-quoting, channel key, quota regex) live in `src/adapters/types.ts`
- Defensive JSON extraction from LLM output lives in `src/gates/llm.ts` (`extractJson`) — reuse it for any new LLM-verdict parsing rather than writing a new regex

## Special Directories

**Runtime-only (`.tickmarkr/`, `dist/` — not in a fresh checkout):**
- Purpose: `.tickmarkr/` holds compiled graphs, runs, doctor cache, and worktrees; `dist/` holds tsc output after `npm run build`
- Generated: Yes — both are gitignored and appear only after first use
- Committed: No

---

*Structure analysis: 2026-07-19*
