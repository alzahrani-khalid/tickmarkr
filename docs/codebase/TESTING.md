# Testing Patterns

**Analysis Date:** 2026-07-18

## Test Framework

**Runner:**
- Vitest `^3.0.0`
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest's built-in `expect` (Chai-compatible) — no separate assertion library

**Run Commands:**
```bash
npm test                # vitest run — full suite, 155+ tests, zero tokens spent
npm run test:coverage   # vitest run --coverage — v8 coverage, enforces thresholds below
npm run e2e             # TICKMARKR_E2E=1 vitest run tests/e2e --testTimeout 900000 — spends real tokens
```
There is no separate watch-mode script in `package.json`; run `npx vitest` directly for watch mode.

## Test File Organization

**Location:** `tests/` mirrors `src/` path-for-path: `src/gates/baseline.ts` → `tests/gates/baseline.test.ts`, `src/run/daemon.ts` → `tests/run/daemon.test.ts`. When adding a new source file, add its test at the matching path under `tests/`.

**Naming:** `<module>.test.ts`, always under `tests/**/*.test.ts` (the only pattern `vitest.config.ts` includes).

**Structure:**
```
tests/
├── adapters/       21 *.test.ts files (fake, registry, prompt, per-vendor auth/usage, kimi TUI seed, etc.)
├── brand.test.ts   byte-pinned brand exports
├── cli/            32 *.test.ts files (init, plan, status, fleet, approve, doctor, report-*, mode-*, etc.)
├── compile/        6 *.test.ts files (gsd, prd, speckit, native, collateral, scope-seam)
├── config/         4 *.test.ts files
├── docs-*.test.ts  export-guarded docs-truth suites (codebase, concerns, stack, testing)
├── drivers/        6 *.test.ts files (herdr, subprocess, env-seal, trailer-width, etc.)
├── e2e/            real-cli.test.ts          (gated, spends tokens — see below)
├── eval/           1 *.test.ts file          (fixture harness tests for the eval lab)
├── fixtures/       codex-mcp-spinner/capture.ts (non-*.test.ts capture helper)
├── gates/          12 *.test.ts files
├── graph/          4 *.test.ts files
├── helpers/        tmprepo.ts                (shared repo/graph fixtures, not a *.test.ts file)
├── hygiene/        2 *.test.ts files (brand-sweep, live-fixture-guard)
├── pane-banner.test.ts
├── plan/           2 *.test.ts files (scope, scope-flow)
├── readme-steering.test.ts
├── repo/           9 *.test.ts files (export fixtures/manifest, readme + contact + community boundaries, build provisioning, release docs)
├── report/         4 *.test.ts files
├── route/          16 *.test.ts files (router, explore, failover, profile, etc.)
├── run/            27 *.test.ts files (daemon, journal, merge, consult, stall, interactive-seed, environment, etc.)
├── scripts/        probe-rig.test.ts
├── tui/            app active; legacy suites retired
├── setup.ts        (setupFiles in vitest.config.ts — global env seal, not a *.test.ts file)
├── skills-pipeline-layout.test.ts
└── smoke.test.ts   (top-level canary: package exports a valid VERSION)
```
Extra test files beyond a 1:1 mirror are additive, not a different convention: `evidence-scope.test.ts` and `via-driver.test.ts` cover cross-module interactions that don't belong to one gate file; `daemon-interactive.test.ts` isolates the v1.2 interactive-worker path from the main `daemon.test.ts`; `interactive-seed.test.ts` isolates the v1.69 launch-then-seed adapter capability; `kimi-tui-seed.test.ts` covers the v1.69 T7 kimi banner model/session assertions; `reconcile-live.test.ts` covers the seed-mode pane-hygiene parity sweep.

## Test Structure

**Suite organization** — `describe` groups by scenario/narrative, not 1:1 with exported functions; test names are full sentences and reuse the source's own vocabulary for spec/decision/version references:
```ts
describe("route resolution order", () => {
  test("1: per-task pin wins over everything", () => { ... });
  test("1b: task pin beats a conflicting map pin", () => { ... });
  test("floor lint: pin below floor routes but lints loudly", () => { ... });
});

describe("daemon integration (fake adapter, zero tokens)", () => {
  test("v1.1: a reviewer that produced garbage is excluded on the task's next review", async () => { ... });
  test("v1.1: retried gates get attempt-unique pane names (herdr agent_name_taken regression)", async () => { ... });
});
```
(`tests/route/router.test.ts`, `tests/run/daemon.test.ts`)

**Setup/teardown:** The default pattern is inline fixture builders — call `makeRepo`, `setupRepo`, `fakeWith`, or a local `mkTask` at the top of each `test(...)` rather than sharing mutable state across cases. Lifecycle hooks *are* used where a seam needs symmetric cleanup: `afterEach` restores TTY/`NO_COLOR` stubs (`tests/brand.test.ts`), deletes leaked env vars (`tests/cli/greenness-exit.test.ts`, `tests/route/explore-scoping.test.ts`), or calls `vi.restoreAllMocks()` after interactive CLI tests; `beforeEach`/`afterEach` pairs seal and restore herdr env (`tests/drivers/herdr.test.ts`, `tests/drivers/env-seal.test.ts`). Reach for a hook only when every test in a `describe` shares the same cleanup contract — don't use one just to avoid an inline builder.

**Assertion style:** Plain `expect(...).toBe/toEqual/toMatch/toContain/toThrow`. Object-shape checks favor `toMatchObject` over exhaustive `toEqual` when only a subset of fields matters (`expect(r).toMatchObject({ gate: "acceptance", pass: true })`, `tests/gates/via-driver.test.ts:78`).

## Mocking

**Default seam: substitute real implementations, don't monkey-patch.** Integration and daemon tests wire `FakeAdapter` and `SubprocessDriver` (or a hand-written delegate spy) at the two interface boundaries below — that path covers the majority of the suite and spends zero tokens. Vitest mocks (`vi.fn`, `vi.mock`, `vi.spyOn`) *do* appear in narrower seams where stubbing a Node built-in or capturing stdout is the smallest honest test: auth probes mock `node:child_process`/`node:fs` (`tests/adapters/kimi-auth.test.ts`, `tests/adapters/grok-auth.test.ts`, `tests/adapters/pi-auth.test.ts`), interactive CLI flows mock `node:readline/promises` (`tests/cli/init.test.ts`, `tests/cli/fleet.test.ts`), registry/doctor tests spy on adapter methods and `process.stdout.write` for byte-pinned output, and plan/acceptance tests spy on `console.warn` or `runLlm`. Prefer the substitution patterns below for new integration coverage; reach for `vi.*` only when the seam under test is a Node built-in, TTY, or a single method on an otherwise-real object.

**1. `WorkerAdapter` → `FakeAdapter`** (`src/adapters/fake.ts`)
A deterministic, scripted adapter that implements the exact same `WorkerAdapter` interface as `claudeCode`/`codex`/`cursorAgent`/`opencode`. A JSON script maps `taskId` → an ordered list of `{ shell, result }` steps (one per attempt); `result` becomes the `TICKMARKR_RESULT` trailer, and a step with no `result` scripts a stall/quota scenario. The same instance also serves scripted `judge`/`review`/`consult` JSON when its `headlessCommand` detects the corresponding prompt marker:
```ts
// tests/helpers/tmprepo.ts
export function setupRepo(tasks: unknown[], script: object, extraCfg = "") {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks }));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"),
    `judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n${extraCfg}`);
  const scriptPath = join(mkdtempSync(join(tmpdir(), "tickmarkr-script-")), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ judge: { pass: true, criteria: [] }, review: { approve: true, issues: [] }, ...script }));
  return { repo, fake: new FakeAdapter(scriptPath), scriptPath };
}
```

**2. `ExecutorDriver` → `SubprocessDriver`, or a hand-written spy wrapping it**
`SubprocessDriver` is a real driver (spawns real local bash subprocesses) — tests use it directly wherever "herdr" would otherwise be required, since `SubprocessDriver` needs no external binary. To assert *which slots got created/closed*, tests write a plain object literal that implements `ExecutorDriver`, delegates every method to a real `SubprocessDriver` via `.bind(inner)`, and intercepts only the 1-2 methods under test:
```ts
function spyDriver(): { driver: ExecutorDriver; names: string[]; closed: string[] } {
  const inner = new SubprocessDriver();
  const names: string[] = [];
  const closed: string[] = [];
  const driver: ExecutorDriver = {
    id: "spy", interactive: false,
    status: (s) => inner.status(s),
    async slot(cwd, name) { names.push(name); return inner.slot(cwd, name); },
    run: (s, c) => inner.run(s, c),
    waitOutput: (s, p, t, o) => inner.waitOutput(s, p, t, o),
    waitAgentStatus: (s, st, t) => inner.waitAgentStatus(s, st, t),
    read: (s, n) => inner.read(s, n),
    notify: (m, o) => inner.notify(m, o),
    async close(s) { closed.push(s.name); return inner.close(s); },
    worktree: (r, b, ref) => inner.worktree(r, b, ref),
  };
  return { driver, names, closed };
}
```
(`tests/gates/via-driver.test.ts:38-62`, repeated with task-specific tweaks in `tests/run/daemon.test.ts` and `tests/run/daemon-interactive.test.ts`'s `idriver()`). Reuse this exact shape — literal object, delegate-by-default, override only what you're asserting on — instead of adding a mocking library.

**3. External CLI binaries → a real stub executable on disk**
`tests/drivers/herdr.test.ts` writes an actual bash script to a temp file, `chmod +x`s it, and points `HerdrDriver` at that path so the driver's real subprocess-invocation code runs against a controlled fake `herdr` binary instead of the real one:
```ts
function makeStub(waitExit = 0) {
  const bin = join(mkdtempSync(join(tmpdir(), "tickmarkr-herdr-")), "herdr");
  writeFileSync(bin, `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "agent start") echo '{"result":{"agent":{"pane_id":"w1:p9"}}}' ;;
  "wait output") exit ${waitExit} ;;
  *) echo '{}' ;;
esac`);
  chmodSync(bin, 0o755);
  return { bin, log, cwd };
}
```

**What to mock:** Prefer substitution at `WorkerAdapter` / `ExecutorDriver` boundaries using the real implementations above. Use `vi.mock`/`vi.spyOn`/`vi.fn` only for Node built-ins, readline, stdout capture, or a single method on an otherwise-real adapter — not as a blanket substitute for git/filesystem/daemon integration.

**What NOT to mock:** `node:fs`, `node:child_process`, and git itself are never mocked. Tests run real `git init`/`commit`/`worktree`/`merge` against real temp directories and assert on real `git log`/`git status --porcelain` output (see `tests/helpers/tmprepo.ts`'s `makeRepo`, and `tests/run/daemon.test.ts`'s happy-path test checking `git log --oneline main` has exactly one commit after a run). This is deliberate: the gates and daemon logic *are* git plumbing, so faking git would test nothing real.

## Fixtures and Factories

**Task/graph builders** — every test file that needs a `Task` defines a small local factory with the same shape: spread a default object, let `over` win:
```ts
// tests/graph/schema.test.ts
const task = (over: Record<string, unknown> = {}) => ({
  id: "T1", title: "do a thing", goal: "the thing is done", shape: "implement",
  complexity: 5, deps: [], files: ["src/**"], context: [], acceptance: ["thing observable"],
  ...over,
});
```
Files exercising `route()`/gates redefine their own `mkTask` with tailored defaults (e.g. `tests/gates/review.test.ts` defaults `complexity: 8` so review isn't skipped by the threshold) rather than sharing one generic builder — match this per-file-local-factory convention instead of centralizing task construction.

**Shared repo/graph helpers** live in `tests/helpers/tmprepo.ts`. Other non-`*.test.ts` TypeScript under `tests/` is supporting infrastructure, not discoverable test cases: `tests/setup.ts` (vitest `setupFiles` — seals leaked routing env before collection), and `tests/fixtures/codex-mcp-spinner/capture.ts` (one-off capture helper). Vitest's `include` pattern is `tests/**/*.test.ts` only — those three files are excluded from collection by design.
- `makeRepo(files: Record<string,string>): string` — real temp dir, `git init -b main`, writes files, one commit
- `setupRepo(tasks, script, extraCfg?)` — `makeRepo` + a validated graph + `.tickmarkr/config.yaml` wired to a scripted `FakeAdapter` for judge/consult
- `T(id, over?)` — minimal single-task factory for daemon-level tests
- `COMMIT` — the shared `git add -A && git commit --no-gpg-sign -m` string, spliced into `FakeAdapter` scripts' `shell` steps

**Static file fixtures** (not graphs — those are always built in-code via `validateGraph`) live under `fixtures/` at the repo root: `fixtures/sample.prd.md`, `fixtures/speckit-sample/tasks.md`, `fixtures/gsd-sample/07-live-check/*-PLAN.md`. Used by compiler tests (`tests/compile/*.test.ts`) and `tests/cli/cli.test.ts` to exercise the real markdown/YAML parsing paths end to end.

## Coverage

**Requirements:** enforced via `vitest.config.ts` with per-directory thresholds. `src/` contains eleven directories; `coverage.include` gates nine of them (graph, route, gates, run, config, compile, adapters, drivers, cli). `src/plan/` and `src/report/` exist in the tree but are not in the coverage include — regressions there do not fail `test:coverage`.
```ts
coverage: {
  provider: "v8",
  include: [
    "src/graph/**", "src/route/**", "src/gates/**", "src/run/**",
    "src/config/**", "src/compile/**", "src/adapters/**", "src/drivers/**", "src/cli/**",
  ],
  thresholds: {
    "src/{graph,route,gates,run}/**": { lines: 80, functions: 80, branches: 70 },
    "src/config/**": { lines: 90, branches: 90 },
    "src/compile/**": { lines: 90, branches: 80 },
    "src/adapters/**": { lines: 90, branches: 80 },
    "src/drivers/**": { lines: 82, branches: 80 },
    "src/cli/**": { lines: 85, branches: 75 },
  },
}
```
Each included directory is coverage-gated independently — a regression in any gated directory fails `test:coverage`; `src/plan/` and `src/report/` are the exceptions. The four core orchestration modules enforce 80% lines, 80% functions, 70% branches (the CLAUDE.md invariant); other gated directories have module-specific thresholds calibrated to their measured coverage.

**View Coverage:**
```bash
npm run test:coverage   # writes HTML + JSON to coverage/ (gitignored)
open coverage/index.html
```

## Test Types

**Unit tests:** Pure-function suites with no filesystem/git involvement — `tests/graph/schema.test.ts` (zod validation), `tests/route/router.test.ts`'s `marginalCostRank`, `tests/gates/baseline.test.ts`'s `fingerprint()`, `tests/adapters/prompt.test.ts`'s `parseWorkerResult`/`TRAILER_PATTERN` regex hardening tests.

**Integration tests:** The majority of the suite. Real git + real temp filesystem + `FakeAdapter`/`SubprocessDriver` as the only substituted seams, exercising multiple modules together: `tests/run/daemon.test.ts` runs the full daemon loop (routing → dispatch → gates → merge → journal) against a real worktree-backed repo; `tests/gates/via-driver.test.ts` and `tests/cli/cli.test.ts` similarly wire several real modules together per test.

**E2E tests:** `tests/e2e/real-cli.test.ts` only, gated behind `describe.skipIf(process.env.TICKMARKR_E2E !== "1")` so it never runs under plain `npm test`. It probes installed agent CLIs, picks the cheapest available channel, compiles a real one-task PRD, and runs the full daemon against a real (non-fake) `WorkerAdapter` and `SubprocessDriver` — the only test in the repo that spends tokens. It skips gracefully (returns early with a `console.warn`) rather than failing when no agent CLI is installed/authenticated. Run explicitly with `npm run e2e` (sets `TICKMARKR_E2E=1`, raises `--testTimeout` to 900000ms).

## Common Patterns

**Async Testing:**
```ts
const s = await runDaemon(repo, { adapters: [fake], runId: "run-happy" });
expect(s.done).toEqual(["T1", "T2"]);
```
Async/await throughout; no `.then()` chains in test bodies.

**Error Testing:**
```ts
// sync throw, class-checked
expect(() => validateGraph(graph([task({ acceptance: [] })]))).toThrow(GraphValidationError);

// sync throw, message-checked via regex
expect(() => validateGraph(graph([task(), task()]))).toThrow(/duplicate/i);

// inspect structured error fields after catching explicitly
try {
  validateGraph(graph([task({ acceptance: [] })]));
} catch (e) {
  expect((e as GraphValidationError).issues.join()).toMatch(/acceptance/);
}

// async rejection
await expect(compile(["bad.md"], repo)).rejects.toThrow(/acceptance/);
```
(`tests/graph/schema.test.ts`, `tests/cli/cli.test.ts:30`)

**Timeouts:** Default is 20000ms (`vitest.config.ts`). Long-running integration suites override explicitly — pass a third argument to `describe`/`test` rather than changing the global default:
```ts
describe("daemon integration (fake adapter, zero tokens)", () => { ... }, 120000);   // tests/run/daemon.test.ts
test("interactive harvest: ...", async () => { ... }, 30_000);                       // tests/run/daemon-interactive.test.ts
test("compile → run → merged integration branch with evidence", async () => { ... }, 900000); // tests/e2e/real-cli.test.ts
```

**Regression tests carry their provenance in the test name/comment** — when a bug was found via a live/manual check, the fix's test cites exactly what broke (e.g. "cursor's trust dialog scraped as idle", "herdr agent_name_taken regression") so a future reader knows why the assertion exists, not just what it checks.

---

*Testing analysis: 2026-07-18*
