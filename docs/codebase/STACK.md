# Technology Stack

**Analysis Date:** 2026-07-18

## Languages

**Primary:**
- TypeScript 5.9.3 (strict mode) - entire `src/` tree (`tsconfig.json`), compiled with `tsc` to `dist/`

**Secondary:**
- Bash - tickmarkr never calls agent CLIs via a Node SDK; it builds shell one-liners and runs them with `spawn("bash", ["-lc", cmd])` (`src/run/git.ts:14-48`, invoked from adapter modules under `src/adapters/`, `src/drivers/subprocess.ts:60-65`)
- JSON / JSON Lines - all on-disk state: `.tickmarkr/graph.json`, `.tickmarkr/runs/<runId>/journal.jsonl`, `.tickmarkr/runs/<runId>/telemetry.jsonl`, `.tickmarkr/doctor.json`
- YAML - config overlay format only (`.tickmarkr/config.yaml`, `~/.config/tickmarkr/config.yaml`)

## Runtime

**Environment:**
- Node.js >=20 (`package.json:19` `engines.node`)
- Pure ESM (`package.json:5` `"type": "module"`); `tsconfig.json` uses `module`/`moduleResolution: NodeNext`, so every internal import is a relative path with an explicit `.js` extension even though the source is `.ts`

**Package Manager:**
- npm
- Lockfile: present and committed (`package-lock.json`, `lockfileVersion: 3`)

## Frameworks

**Core:**
- None. Tickmarkr is a dependency-light Node CLI binary, not a web/app framework consumer. `package.json:22-25` exposes `bin: { tickmarkr: "dist/cli/index.js", tkr: "dist/cli/index.js" }` (both names invoke the same entrypoint); `src/cli/index.ts` is a hand-rolled command dispatcher (`COMMANDS` map, no CLI framework like commander/yargs).

**Testing:**
- Vitest 3.2.7 - unit + integration runner (`vitest.config.ts`)
- @vitest/coverage-v8 3.2.7 - coverage provider; thresholds enforced only on `src/{graph,route,gates,run}/**` at lines 80% / functions 80% / branches 70% (`vitest.config.ts:32`)

**Build/Dev:**
- TypeScript compiler (`npm run build` → `tsc -p tsconfig.json`), emits declarations to `dist/` (`tsconfig.json:6-7`)
- tsx 4.23.0 - executes `scripts/emit-schema.ts` directly for `npm run schema`; not part of the runtime or build path, dev-only

## Key Dependencies

**Critical:**
- zod 4.4.3 - single source of truth for the `RunGraph`/`Task` shape and all runtime validation (`src/graph/schema.ts`); also emits the public JSON Schema artifact via `z.toJSONSchema(RunGraphSchema, ...)` (`scripts/emit-schema.ts` → `schema/rungraph.schema.json`)
- yaml 2.9.0 - parses the config overlay files (`src/config/config.ts:4,346-349`) and GSD phase-plan frontmatter (`src/compile/gsd.ts:3`)
- picomatch 4.0.5 - glob matcher backing the scope gate, which checks whether a worker only touched paths matching `task.files` (`src/gates/scope.ts:1,17`)

**Infrastructure:**
- None. No HTTP client, no ORM/DB driver, no queue/cache client, no logging framework — this is intentional (see Architectural Constraints below), not an omission.

## Configuration

**Environment:**
- `HERDR_ENV=1` - when set, `driver: auto` (the default) picks `HerdrDriver` (visible terminal panes) instead of `SubprocessDriver` (`src/drivers/herdr.ts:50-51`, `src/drivers/index.ts:6-13`)
- `TICKMARKR_FAKE_SCRIPT` - path to a JSON fixture script; when set, prepends a `FakeAdapter` to the adapter list so the entire test suite can run deterministically with zero LLM tokens (`src/adapters/registry.ts:62-68`, `src/adapters/fake.ts`)
- `TICKMARKR_E2E=1` - unskips `tests/e2e/real-cli.test.ts`, which spends real tokens against whatever real agent CLI is installed and authenticated (`npm run e2e` sets this automatically, `package.json:37`)
- `XDG_CONFIG_HOME` - relocates the global config directory; defaults to `~/.config/tickmarkr` (`src/config/config.ts:351-353`)
- No `.env` file exists in this repo and no secret-loading mechanism is implemented. Tickmarkr never handles agent-vendor API keys itself — each underlying CLI (`claude`, `codex`, `cursor-agent`, `opencode`) manages its own authentication out-of-band.

**Key configs required:**
- None are required to run `tickmarkr doctor`/`compile`/`plan`. `.tickmarkr/config.yaml` (repo-local, gitignored via `src/graph/graph.ts:26-31`) and `~/.config/tickmarkr/config.yaml` (global) are optional YAML overlays deep-merged over `DEFAULT_CONFIG` — precedence is repo > global > built-in defaults, with explicit `null` values acting as tombstones that delete a default key (`src/config/config.ts:328-344,449-459`)
- `tickmarkr init` scaffolds both overlay files from a commented template (`src/cli/commands/init.ts`, `configTemplate()` in `src/config/config.ts:483`)

**Build:**
- `tsconfig.json` - `target: ES2022`, `module`/`moduleResolution: NodeNext`, `strict: true`, `declaration: true`, `outDir: dist`, `rootDir: src`, `skipLibCheck: true`
- `vitest.config.ts` - test glob `tests/**/*.test.ts`, `testTimeout: 20000`, v8 coverage with the thresholds above

## Platform Requirements

**Development:**
- Node.js >=20
- git - required, not optional: task isolation (worktrees), integration branches, and diff-based gates all shell out to `git` directly (`src/run/git.ts`)
- Optional, only for real (non-fake) runs: one or more agent CLIs on `PATH` — `claude`, `codex`, `cursor-agent`, `opencode`, `pi`, `grok`, `kimi` — verified with `tickmarkr doctor` (`src/cli/commands/doctor.ts`)
- Optional: `herdr` CLI on `PATH` plus `HERDR_ENV=1` for the visible-pane driver; silently falls back to the invisible `SubprocessDriver` when absent

**Production:**
- No server/deployment target — tickmarkr has no production runtime distinct from development. It ships as the npm package `tickmarkr` (`package.json:2`, `files: ["dist", "schema", "skills", "fixtures"]`) and is invoked locally or from an unattended shell/CI job as the `tickmarkr` or `tkr` binary (`package.json:22-25`).

---

*Stack analysis: 2026-07-18*
