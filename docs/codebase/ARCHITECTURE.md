<!-- refreshed: 2026-07-19 -->
# Architecture

**Analysis Date:** 2026-07-19

## System Overview

```text
┌───────────────────────────────────────────────────────────────────┐
│                    CLI  —  `src/cli/index.ts`                      │
│   init · doctor · compile · plan · run · status · resume · report  │
└──────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│              COMPILE — spec front-end → RunGraph                    │
├──────────────┬──────────────┬──────────────┬───────────────────────┤
│ native (primary)│  Spec Kit    │  bare PRD    │  GSD .planning/       │
│ `native.ts`   │ `speckit.ts` │  `prd.ts`    │  `gsd.ts`             │
│ + `collateral.ts` (advisory plan-time scope-lint scan only)       │
└──────────────┴──────────────┴──────────────┴───────────────────────┘
                                │  validated RunGraph (acceptance[] required)
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│      GRAPH STORE — `.tickmarkr/graph.json`  (zod schema + CRUD)      │
│      `src/graph/schema.ts`, `src/graph/graph.ts`                    │
└──────────────────────────────┬──────────────────────────────────────┘
                                │  readyTasks(graph)
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│   ROUTER — pin > map > floors > marginal-cost auto + learned scores │
│   `src/route/router.ts` · `profile.ts` · `preference.ts` ·        │
│   `candidates.ts` (ranked picker reuses production `route()`)       │
└──────────────────────────────┬──────────────────────────────────────┘
                                │  Assignment {adapter, model, channel, tier} + ladder
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│         DAEMON LOOP (the brain) — `src/run/daemon.ts`                │
│   dispatch → wait → gate → merge  |  escalate(ladder) → consult      │
├───────────────────────────────┬───────────────────────────────────────┤
│   DRIVERS (execution surface) │   ADAPTERS (per-CLI contract)         │
│   herdr (visible panes)       │   claude-code · codex · cursor-agent ·│
│   subprocess (child proc)     │   opencode · fake — `src/adapters/`   │
│   `src/drivers/`              │                                        │
└───────────────────────────────┴───────────────────────────────────────┘
                                │  TICKMARKR_RESULT trailer + git commits
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  GATES (never trust the worker) — `src/gates/`                       │
│  baseline(build/test/lint) → evidence → scope → acceptance(judge)    │
│  → cross-vendor review                                               │
└──────────────────────────────┬──────────────────────────────────────┘
                                │  every gate passes
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  MERGE → integration branch `tickmarkr/<runId>` (never main)         │
│  `src/run/merge.ts` · ledger: `.tickmarkr/runs/<id>/journal.jsonl`   │
└───────────────────────────────────────────────────────────────────┘

Side modules (CLI-facing, not in the dispatch loop):
  PLAN — `src/plan/` (scope/intent LLM helpers for `tickmarkr scope` / `plan`)
  REPORT — `src/report/cost.ts` (pure telemetry → cost estimates for `tickmarkr report`)
  EVAL — `src/eval/` (checked-in fixture harness for `tickmarkr eval`)
  TUI — `src/tui/` (dependency-free alternate-screen line engine for Fleet Studio)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI dispatcher | Maps `argv[2]` to command handlers (init, doctor, fleet, compile, scope, plan, eval, run, status, resume, report, profile, unlock, approve, version) | `src/cli/index.ts` |
| Compile front-ends | Turn a spec artifact into a validated RunGraph; fail loudly if `acceptance[]` would be empty | `src/compile/index.ts`, `src/compile/native.ts` (primary), `src/compile/speckit.ts`, `src/compile/prd.ts`, `src/compile/gsd.ts`, `src/compile/collateral.ts` (advisory scope-lint only) |
| RunGraph schema + ops | Single source-of-truth data model: zod validation, duplicate-id/unknown-dep/cycle checks, pure CRUD | `src/graph/schema.ts`, `src/graph/graph.ts` |
| Config loader | Layered YAML config (built-in defaults < global < repo overlay) with null-tombstone deep merge | `src/config/config.ts` |
| Router | Resolves a task to `{adapter, model, channel, tier}` + an escalation ladder; learned scores from telemetry live in `profile.ts` | `src/route/router.ts`, `src/route/profile.ts`, `src/route/preference.ts`, `src/route/candidates.ts` |
| Plan helpers | LLM-backed scope/intent clarification for `tickmarkr scope` and human-in-the-loop plan gates | `src/plan/scope.ts`, `src/plan/prompt.ts` |
| Report cost | Pure telemetry → per-channel cost estimates (no network) | `src/report/cost.ts` |
| Eval fixture harness | Discovers checked-in fixtures, validates their required parts, and seeds each into an isolated temporary git repository before any check or dispatch runs | `src/eval/fixtures.ts` |
| Terminal engine | Renders a diffed line model in the alternate screen, routes named keys, tracks resize, and restores terminal state | `src/tui/engine.ts`, `src/tui/frame.ts`, `src/tui/input.ts` |
| Adapter registry | Discovers installed/authed CLIs (`probe()`), builds the available `BillingChannel[]` | `src/adapters/registry.ts` |
| Worker adapters | One per agent CLI: headless/interactive command strings + output parsing | `src/adapters/claude-code.ts`, `src/adapters/codex.ts`, `src/adapters/cursor-agent.ts`, `src/adapters/opencode.ts`, `src/adapters/fake.ts` |
| Executor drivers | Slot lifecycle (pane or subprocess), wait/read/notify primitives, worktree creation | `src/drivers/herdr.ts`, `src/drivers/subprocess.ts`, `src/drivers/types.ts` |
| Daemon | Main dispatch loop: ready-task selection, concurrency cap, escalation, journaling | `src/run/daemon.ts` |
| Journal / ledger | Append-only event log + telemetry log; resumable status replay | `src/run/journal.ts` |
| Git worktree ops | `git worktree add/remove`, HEAD lookup, shell helper | `src/run/git.ts` |
| Merge | Integration-branch lifecycle, serialized task-branch merges | `src/run/merge.ts` |
| Consult | Frontier-model escalation on stall/gate-fail/merge-conflict, structured verdict | `src/run/consult.ts` |
| Run lock | Advisory per-run lock over `.tickmarkr/graph.json` (link idiom + heartbeat) | `src/run/lock.ts` |
| Pane reconcile | Pure fold over journal rows → desired herdr pane set for orphan cleanup | `src/run/reconcile.ts` |
| Stall normalize | Presentation-token stripper for stall-inactivity compare (spinner-safe) | `src/run/stall.ts` |
| Gate sequencer | Runs baseline → evidence → scope → acceptance → review in order, short-circuits on first failure | `src/gates/run-gates.ts` |
| LLM dispatch | Shared headless-vs-pane execution for judge/review/consult prompts + defensive JSON extraction | `src/gates/llm.ts` |

## Pattern Overview

**Overall:** Pipeline orchestrator with a stateful daemon event loop at its center — closer to a CI/CD orchestrator or workflow engine than a layered web app. There is no request/response server; the "requests" are tasks flowing through compile → route → dispatch → gate → merge.

**Key Characteristics:**
- Files + git are the only state store — no database, no long-running services (tickmarkr invariant, `CLAUDE.md`)
- Every subsystem revolves around one JSON artifact: the RunGraph (`.tickmarkr/graph.json`)
- An append-only event log (`journal.jsonl`) is the resumable source of truth, not the graph file itself
- Two swappable-implementation interfaces carry all the polymorphism: `WorkerAdapter` (one per agent CLI) and `ExecutorDriver` (herdr vs subprocess) — both are plain object/class contracts, no DI framework
- Fail-closed by default: gates never trust worker claims; unparseable LLM output becomes a failure or a "human" verdict, never a silent pass
- Routing is priority-ordered config resolution (pin > map > floor > auto) with telemetry-learned scores from `src/route/profile.ts` as the final tie-breaker within a tier — not a separate ML service, but not config-only either

## Layers

**CLI (`src/cli/`):**
- Purpose: thin argv-parsing shell around the engine; each command is a one-function module
- Location: `src/cli/index.ts` (dispatch table + usage text), `src/cli/commands/*.ts` (one file per subcommand)
- Contains: `parseArgs`-based option handling, calls into config/graph/route/daemon, formats human-readable stdout
- Depends on: config, graph, route, adapters/registry, drivers, run/daemon, run/journal
- Used by: the `tickmarkr` binary only (`package.json` `bin` → `dist/cli/index.js`)

**Compile (`src/compile/`):**
- Purpose: adapt heterogeneous spec formats into the one RunGraph shape; native tickmarkr specs (`<!-- tickmarkr:spec -->`) are the primary front-end
- Location: `src/compile/index.ts` (detection + dispatch), `native.ts` (primary), `speckit.ts`, `prd.ts`, `gsd.ts`, `common.ts` (shared `CompileError`, `sha256`, `inferShape`), `collateral.ts` (advisory plan-time scope-lint scan — never fails compile)
- Contains: markdown/YAML-frontmatter parsers, no I/O beyond reading the spec source and repo-relative path resolution
- Depends on: `graph/schema.ts` (`validateGraph`)
- Used by: `src/cli/commands/compile.ts`, `src/plan/scope.ts` (native compile for scope flow)

**Graph (`src/graph/`):**
- Purpose: own the RunGraph/Task data model and its on-disk lifecycle
- Location: `src/graph/schema.ts` (zod schema, types, `validateGraph`), `src/graph/graph.ts` (load/save/query/mutate helpers)
- Contains: `TaskSchema`, `RunGraphSchema`, cycle detection, `readyTasks()`, `isComplete()`, `isStalled()`; all mutators (`setStatus`, `addEvidence`) return new objects via spread, never mutate in place
- Depends on: zod only
- Used by: compile, route (via `Task` type), daemon, CLI status/plan/compile commands

**Config (`src/config/config.ts`):**
- Purpose: single seed table + layered override resolution for routing, tiers, gates, judge/review/consult, visibility
- Location: `src/config/config.ts`
- Contains: `DEFAULT_CONFIG`, `deepMerge()` (supports `null`-as-tombstone), `loadConfig()`, `configTemplate()` (the commented YAML written by `tickmarkr init`)
- Depends on: `yaml` package, `graph/schema.ts` (`Shape` type)
- Used by: nearly every other layer (router, adapters/registry, daemon, gates, CLI commands)

**Route (`src/route/`):**
- Purpose: pure routing-resolution logic — resolve a task to an `Assignment` plus its escalation ladder, rank alternatives for the plan picker, and fold telemetry into learned scores
- Location: `src/route/router.ts` (`route()`, `nextChannel()`, `marginalCostRank()`), `profile.ts` (telemetry-learned scores + exploration), `preference.ts` (doctor-derived prefer/exclude ranks), `candidates.ts` (`rankCandidates()` for plan output — each rank is a production `route()` call)
- Contains: pin > map-tier > floor > auto by marginal cost, then learned-score tie-break within tier; escalation/failover via growing exclusion sets
- Depends on: `adapters/types.ts` (`BillingChannel`, `Assignment`), `config/config.ts` (`TIER_RANK`), `run/journal.ts` (`TelemetryRow` type for profile ingest)
- Used by: `run/daemon.ts`, `src/cli/commands/plan.ts`, `src/cli/commands/run.ts` (`--route-strict`), `src/cli/commands/profile.ts`, `src/plan/scope.ts`, `src/gates/review.ts` (`pickReviewer` reuses `marginalCostRank`), `src/adapters/registry.ts` (doctor prefer hints)

**Adapters (`src/adapters/`):**
- Purpose: encapsulate everything CLI-specific — command strings, output parsing, channel/tier declaration
- Location: `src/adapters/types.ts` (the `WorkerAdapter` contract + shared types), `claude-code.ts`, `codex.ts`, `cursor-agent.ts`, `opencode.ts` (real adapters), `fake.ts` (deterministic scripted adapter for tests), `registry.ts` (discovery/doctor persistence), `prompt.ts` (task-prompt template + trailer parsing shared by every real adapter)
- Depends on: `config/config.ts` (channel/tier lookups), `graph/schema.ts` (`Task`)
- Used by: router (channel discovery), daemon (dispatch), gates (judge/review LLM calls)

**Drivers (`src/drivers/`):**
- Purpose: abstract "where does a command actually run and how do we watch it" behind one interface
- Location: `src/drivers/types.ts` (`ExecutorDriver`, `Slot`), `herdr.ts` (visible-pane implementation), `subprocess.ts` (child-process implementation), `index.ts` (`pickDriver()` auto-selection)
- Contains: slot lifecycle (`slot`/`run`/`waitOutput`/`waitAgentStatus`/`status`/`read`/`notify`/`close`), worktree creation delegated to `run/git.ts`
- Depends on: `run/git.ts` (`createWorktree`), `adapters/types.ts` (`shq` shell-quoting)
- Used by: `run/daemon.ts`, `run/consult.ts`, `gates/llm.ts` (judge/review pane dispatch)

**Plan (`src/plan/`):**
- Purpose: LLM-backed scope/intent helpers for `tickmarkr scope` and plan-time human gates — not part of the run dispatch loop
- Location: `src/plan/scope.ts` (clarification gate + scope LLM dispatch), `src/plan/prompt.ts` (prompt templates)
- Depends on: compile/native, adapters/registry, drivers, gates/llm, route, graph/schema
- Used by: `src/cli/commands/scope.ts`, `src/cli/commands/plan.ts`

**Report (`src/report/`):**
- Purpose: pure post-run cost estimation from telemetry rows + operator price table
- Location: `src/report/cost.ts` (`estimateCosts()`)
- Depends on: adapters/types (TokenUsage), config (pricing tables), run/journal (TelemetryRow)
- Used by: `src/cli/commands/report.ts`

**Eval (`src/eval/`):**
- Purpose: checked-in fixture harness for the `tickmarkr eval` qualification lab
- Location: `src/eval/fixtures.ts` (`discoverFixtures()`, `seedFixture()`)
- Depends on: `src/run/git.ts` (`shGitOk`) for temp-repo git plumbing
- Used by: `src/cli/commands/eval.ts`

**TUI (`src/tui/`):**
- Purpose: dependency-free terminal presentation engine for Fleet Studio
- Location: `engine.ts` (lifecycle and resize), `frame.ts` (alternate-screen line-diff renderer), `input.ts` (keypress decoder and named-key router)
- Depends on: Node streams and ANSI CSI only; input/output streams are injected for non-TTY tests
- Used by: Fleet Studio command and its views

**Run (`src/run/`):**
- Purpose: the orchestration runtime — daemon loop, ledger, git integration, merge, escalation, locking, pane hygiene, stall detection
- Location: `daemon.ts` (main loop + `execTask`), `journal.ts` (event/telemetry log), `git.ts` (shell + worktree primitives), `merge.ts` (integration branch), `consult.ts` (frontier-model escalation), `lock.ts` (graph.json advisory lock), `reconcile.ts` (desired pane set from journal), `stall.ts` (spinner-safe inactivity compare)
- Depends on: graph, route, adapters, drivers, gates, config
- Used by: `src/cli/commands/run.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/unlock.ts`

**Gates (`src/gates/`):**
- Purpose: independently re-verify every worker claim before merge
- Location: `types.ts` (`GateResult`), `run-gates.ts` (sequencer), `baseline.ts` (build/test/lint vs pre-run baseline), `evidence.ts` (commits/diff exist), `scope.ts` (`picomatch` file-scope check), `acceptance.ts` (LLM judge vs `acceptance[]`), `review.ts` (cross-vendor LLM review + `pickReviewer`), `llm.ts` (shared headless-vs-pane LLM dispatch + `extractJson`)
- Depends on: adapters (judge/review run through a `WorkerAdapter`), drivers (pane-visible LLM calls), config (thresholds, judge/review/consult selection)
- Used by: `run/daemon.ts` (post-dispatch, pre-merge)

## Data Flow

### Primary Request Path (a `tickmarkr run`)

1. `tickmarkr run` parses flags and calls `runDaemon(cwd, opts)` (`src/cli/commands/run.ts:26`, `src/run/daemon.ts:37`)
2. Daemon loads config, discovers adapters/health/channels, picks a driver, loads the RunGraph, opens/creates the journal, captures (or replays) the pre-run baseline (`src/run/daemon.ts:38-67`)
3. Daemon ensures the integration worktree exists at `baseRef` (`ensureIntegration`, `src/run/merge.ts:12-22`)
4. Loop: `readyTasks(graph)` selects tasks whose deps are `done` and are not already in flight, up to `concurrency` (`src/graph/graph.ts:62-65`, `src/run/daemon.ts:319-336`)
5. Per task, `execTask()` resolves routing via `route(task, cfg, channels)` (`src/route/router.ts:44-70`) and records any floor lints
6. A per-task worktree + branch is created off the current integration HEAD (dependencies are already merged in) (`src/run/daemon.ts:154-156`, `src/run/git.ts:31-36`)
7. The task prompt is written to disk (`writePrompt`, `src/adapters/prompt.ts:27-32`) and dispatched into a named slot via `driver.slot()` + `driver.run()` — interactive TUI by default, print-mode fallback otherwise (`src/run/daemon.ts:168-218`)
8. Daemon waits for the `TICKMARKR_RESULT` trailer (regex-anchored to avoid matching the prompt's own template text) or the `TICKMARKR_EXIT:` fast-fail marker, paging the operator once if the pane goes `blocked`/`idle` (`src/run/daemon.ts:181-211`, `src/adapters/prompt.ts:37`)
9. Output is parsed by the adapter (`adapter.parse()` → `parseWorkerResult`, `src/adapters/prompt.ts:39-73`); a quota-exhaustion signal triggers channel failover without consuming the escalation ladder (`src/run/daemon.ts:224-238`)
10. `runGates()` runs baseline → evidence → scope → acceptance → review, short-circuiting on the first failing gate (`src/gates/run-gates.ts:27-72`)
11. All gates pass → `mergeTask()` merges the task branch into the integration branch through a serialized merge queue (`mergeSerial`, `src/run/daemon.ts:80-84`, `src/run/merge.ts:28-41`); task status becomes `done`
12. Any gate fails → escalation ladder step (`retry` → `escalate` channel → `consult` → `human`); a `consult()` call can also fire directly on stall or merge conflict (`src/run/daemon.ts:294-315`, `src/run/consult.ts:52-81`)
13. Every state transition is appended to `journal.jsonl` (`src/run/journal.ts:58-61`); on run end, kept panes close, an operator notification fires, and a `RunSummary` is returned (`src/run/daemon.ts:338-350`)

### Compile Flow

1. `tickmarkr compile <src>` calls `compileSource()`, which auto-detects the spec type from the path shape (directory with `tasks.md` → speckit; GSD phase dir or `*-PLAN.md` → gsd; `.md` with `<!-- tickmarkr:spec -->` → native; other `.md` → prd) unless `--type` is passed (`src/compile/index.ts:12-36`)
2. The matched front-end parses the artifact and builds task drafts; every front-end throws a typed `CompileError` if any task would compile with an empty `acceptance[]` (invariant enforced independently in `native.ts`, `speckit.ts`, `prd.ts`, `gsd.ts`)
3. The assembled graph is passed through `validateGraph()` (schema + duplicate-id + unknown-dep + cycle checks) before being returned
4. `saveGraph()` writes `.tickmarkr/graph.json` (`src/graph/graph.ts:23-26`)

### Consult Flow (frontier-model escalation)

1. Triggered by: worker stall (no trailer within timeout), a failing gate at the `escalate`/`consult` ladder step, or a merge conflict (`src/run/daemon.ts:239-249, 299-311, 280-285`)
2. `consult()` builds a dossier (journal tail, transcript tail, diff/feedback, gate results) into a prompt (`buildDossierPrompt`, `src/run/consult.ts:23-48`)
3. Dispatched to the configured consult adapter through the driver as a named, visible pane (`<taskId>-consult-<n>`) (`src/run/consult.ts:61-71`)
4. Output is parsed defensively (`extractJson`); any unparseable or unrecognized-action verdict fails closed to `{action: "human"}` (`src/run/consult.ts:76-79`)
5. The daemon's `applyVerdict()` turns `retry`/`reroute`/`decompose`/`human` into a continue-attempting or park-the-task decision (`src/run/daemon.ts:125-143`)

**State Management:**
- RunGraph (`.tickmarkr/graph.json`) is the current-state snapshot — read-modify-write, no in-memory-only state survives a process restart
- `journal.jsonl` is the append-only event log; `Journal.replayStatuses()` reconstructs task statuses from it on `--resume` (a `running` status at crash time replays back to `pending`) (`src/run/journal.ts:77-88`)
- `telemetry.jsonl` is a side log of per-(shape × route) outcomes for `tickmarkr report`; not consulted by routing in the current version (the spec calls out telemetry-learned routing as a later increment)

## Key Abstractions

**RunGraph / Task (`src/graph/schema.ts`):**
- Purpose: the one data model every compiler emits and the daemon consumes; zod-validated, immutably updated
- Examples: `TaskSchema`, `RunGraphSchema`
- Pattern: schema-as-source-of-truth — `Task`/`RunGraph` TypeScript types are `z.infer<>` from the schema, not hand-written interfaces

**WorkerAdapter (`src/adapters/types.ts`):**
- Purpose: isolate everything specific to one agent CLI behind `probe/channels/headlessCommand/interactiveCommand/invoke/parse`
- Examples: `src/adapters/claude-code.ts`, `src/adapters/codex.ts`, `src/adapters/cursor-agent.ts`, `src/adapters/opencode.ts`, `src/adapters/fake.ts`
- Pattern: adapter pattern — new CLI support is a new file implementing the interface, registered once in `src/adapters/registry.ts`

**ExecutorDriver (`src/drivers/types.ts`):**
- Purpose: isolate "where/how a command runs and is observed" from the daemon's control flow
- Examples: `src/drivers/herdr.ts` (visible pane via the `herdr` CLI), `src/drivers/subprocess.ts` (plain child process)
- Pattern: strategy pattern selected once per run by `pickDriver()` (`src/drivers/index.ts:6-11`); `Slot` is the addressable execution unit both implementations return

**BillingChannel / Assignment (`src/adapters/types.ts`):**
- Purpose: the routing currency — `{adapter, vendor, model, channel: sub|api, tier: cheap|mid|frontier}`
- Examples: built from `TickmarkrConfig.tiers` via `channelsFromConfig()`
- Pattern: value objects with a stable string key (`channelKey()`) used for dedup, exclusion lists, and lookups throughout routing/gates

**GateResult (`src/gates/types.ts`):**
- Purpose: uniform shape every gate returns, so `run-gates.ts` can sequence heterogeneous checks (shell commands, git introspection, LLM judges) identically
- Examples: every file in `src/gates/`
- Pattern: `{gate, pass, details, meta?}` — `meta` (added v1.1) carries machine-readable extras like the reviewer channel for failover, keeping `details` human-readable-only

**Journal (`src/run/journal.ts`):**
- Purpose: append-only, crash-tolerant event sourcing for run state, replayable on resume
- Examples: `.tickmarkr/runs/<runId>/journal.jsonl`, `.tickmarkr/runs/<runId>/telemetry.jsonl`
- Pattern: event log — never rewritten, only appended; torn trailing lines from a crash are dropped, not fatal

## Entry Points

**CLI binary:**
- Location: `src/cli/index.ts`
- Triggers: `tickmarkr <command>` (package.json `bin.tickmarkr` → `dist/cli/index.js` after `npm run build`)
- Responsibilities: parse `argv[2]` against the `COMMANDS` table, print usage on no/unknown command, print the resolved promise or a `tickmarkr <cmd>: <message>` error and exit 1

**`runDaemon()` (`src/run/daemon.ts:37`):**
- Location: `src/run/daemon.ts`
- Triggers: `src/cli/commands/run.ts` (fresh run) and `src/cli/commands/resume.ts` (`resume: true`)
- Responsibilities: the actual reusable orchestration engine — everything downstream of "I have a graph and a driver" lives here; also the seam used by integration tests (`tests/run/daemon.test.ts`, `tests/run/daemon-interactive.test.ts`) with the fake adapter and a fake/subprocess driver

**npm scripts (`package.json`):**
- `npm test` / `npm run test:coverage`: vitest against `tests/**/*.test.ts`, fake-adapter only, zero tokens
- `npm run schema`: runs `scripts/emit-schema.ts`, regenerating `schema/rungraph.schema.json` from `RunGraphSchema`
- `npm run e2e`: `TICKMARKR_E2E=1 vitest run tests/e2e` — opt-in, spends tokens, requires a real installed agent CLI

## Architectural Constraints

- **Threading:** single-threaded Node event loop throughout; task concurrency is cooperative async dispatch (an `inflight` `Map<taskId, Promise<void>>` raced with `Promise.race`), not worker threads or child-process parallelism at the daemon level (`src/run/daemon.ts:318-336`)
- **Global state:** one module-level mutable counter, `consultSeq` in `src/run/consult.ts:50`, used only to keep consult pane names unique within a process; no other module-level singletons detected
- **Merge serialization:** concurrent tasks can finish gating at the same time, but merges into the shared integration worktree are forced through one promise chain (`mergeSerial`, `src/run/daemon.ts:79-84`) because two simultaneous `git merge` invocations in the same worktree are not safe
- **herdr availability is env-gated, not feature-detected per call:** `HerdrDriver.available()` is a single `process.env.HERDR_ENV === "1"` check (`src/drivers/herdr.ts:11-13`); `pickDriver()` uses it once at startup to choose herdr vs subprocess for the whole run, never mid-run
- **Circular imports:** none — dependency direction is a clean DAG: `cli → run/compile/plan/report/route → gates/adapters/drivers → graph/config`; `graph/`, `config/`, and `adapters/types.ts` have no dependencies back into higher layers

## Anti-Patterns

### Trusting process exit code as the completion signal

**What happens:** code assumes a dispatched CLI process exiting (or a captured exit code) means the task finished.
**Why it's wrong:** interactive workers (`visibility.worker: interactive`, the current default) run the CLI's real TUI, which never exits on its own — it sits waiting for the next prompt. Exit-code-based completion detection would hang forever or misfire on the wrong condition.
**Do this instead:** detect completion from the `TICKMARKR_RESULT {"ok":...}` trailer appearing in the pane transcript, regex-anchored so it cannot match the unfilled template text embedded in the prompt itself (`TRAILER_PATTERN`, `src/adapters/prompt.ts:37`; consumed via `driver.waitOutput(slot, ..., {regex: true})` in `src/run/daemon.ts:190`). The `TICKMARKR_EXIT:` marker is kept only as a fast-fail path for a TUI that crashes or quits (`EXIT_RE`, `src/run/daemon.ts:35, 210-211`).

### Caching a herdr pane id across calls

**What happens:** storing the pane id returned by `slot()` once, then reusing it for every later `run`/`read`/`close` call on that slot.
**Why it's wrong:** herdr pane ids compact/renumber as other panes in the workspace open and close, so a cached id can silently start addressing a different pane than intended.
**Do this instead:** re-resolve the pane id fresh from the durable agent name on every operation — see `HerdrDriver.paneId()` (`src/drivers/herdr.ts:20-29`), called at the top of `run`, `waitOutput`, `waitAgentStatus`, `read`, and `close`.

### Taking the first (or most recent) regex match of a trailer as the result

**What happens:** matching `TICKMARKR_RESULT {...}` once in captured output and parsing that match as the worker's verdict.
**Why it's wrong:** the task prompt itself contains the literal trailer template (so CLIs that echo their input reproduce it verbatim), and interactive TUIs redraw/duplicate lines on refresh — a naive single match can parse the unfilled template placeholder or a torn duplicate instead of the real result.
**Do this instead:** scan `TICKMARKR_RESULT` occurrences backward from the end of the output and return the last candidate that actually `JSON.parse()`s cleanly, after rejoining hard-wrapped lines and stripping box-drawing margin characters — `parseWorkerResult()` (`src/adapters/prompt.ts:39-73`).

### Letting concurrent tasks merge into the integration worktree directly

**What happens:** each task, on passing its gates, calls `mergeTask()` against the shared integration worktree as soon as it finishes.
**Why it's wrong:** with `concurrency > 1`, two tasks can pass gates around the same time; two simultaneous `git merge` invocations in one worktree race on the index/HEAD and can corrupt the integration branch.
**Do this instead:** funnel every merge through a single promise chain so merges execute strictly one at a time regardless of how many tasks finish concurrently — `mergeSerial()` (`src/run/daemon.ts:79-84`).

## Error Handling

**Strategy:** fail-closed everywhere a claim must be trusted — an unparseable or missing result is treated as a failure (or routed to a human), never silently accepted as success.

**Patterns:**
- Typed, named error classes per concern: `CompileError` (`src/compile/common.ts:4-9`), `RoutingError` (`src/route/router.ts:8-13`), `GraphValidationError` (`src/graph/schema.ts:72-77`) — each carries a domain-specific message, no generic `Error` thrown across module boundaries for expected failure modes
- LLM verdict parsing (`extractJson`, `src/gates/llm.ts:69-104`) never throws; it returns `null` on failure, and every caller (`acceptance.ts:42-44`, `review.ts:72-79`, `consult.ts:76-79`) turns a `null`/malformed verdict into an explicit failing `GateResult` or a `human` `ConsultVerdict` rather than propagating an exception
- Per-task execution errors are caught at the dispatch loop boundary (`src/run/daemon.ts:324-331`), converted into a `task-failed` journal event and `status: failed` — one bad task never crashes the whole run
- The journal tolerates a torn trailing line from a crash mid-`appendFileSync`: `Journal.read()` catches the per-line `JSON.parse` and drops only the unparseable line, keeping everything before it intact (`src/run/journal.ts:63-75`)
- Gate baseline comparison fails closed on ambiguity: if a command was green at baseline but now exits non-zero with no recognizable failure-line fingerprint, that's still a fail, not a pass-by-default (`src/gates/baseline.ts:58-64`)

## Cross-Cutting Concerns

**Logging:** no logging framework. `console.log`/`console.error` appear only at the CLI boundary (`src/cli/index.ts:32-37`) and in `SubprocessDriver.notify()` (`src/drivers/subprocess.ts:67`, the no-herdr notification fallback). All durable operational history goes to the structured `journal.jsonl` event log (`src/run/journal.ts`), not to stdout.

**Validation:** one boundary — `RunGraphSchema`/`TaskSchema` (zod) in `src/graph/schema.ts`. Enforced at every compile (`validateGraph()` call at the end of each `compile*.ts` front-end) and at every graph load (`loadGraph()`, `src/graph/graph.ts:17-21`). No other schema-validation boundary exists in the codebase (config is loaded as plain YAML with no schema check beyond TypeScript's structural typing).

**Authentication:** none in-app. Delegated entirely to each installed CLI's own auth/session state, discovered via `probe()` (`AuthHealth`, `src/adapters/types.ts:6`) and cached to `.tickmarkr/doctor.json` (`src/adapters/registry.ts:32-39`) so a run doesn't re-probe every adapter on every task.

---

*Architecture analysis: 2026-07-22*
