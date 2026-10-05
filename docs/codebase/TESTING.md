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
├── cli/            34 *.test.ts files (init, plan, status, fleet, approve-*, doctor, report-*, mode-*, etc.)
├── compile/        7 *.test.ts files (gsd, prd, speckit, native, collateral, scope-seam, task-unit-contract)
├── config/         4 *.test.ts files
├── docs-*.test.ts  export-guarded docs-truth suites (codebase, concerns, stack, testing)
├── drivers/        7 *.test.ts files (herdr, subprocess, env-seal, trailer-width, etc.)
├── e2e/            real-cli.test.ts          (gated, spends tokens — see below)
├── eval/           5 *.test.ts files         (fixture harness tests for the eval lab)
├── fixtures/       codex-mcp-spinner/capture.ts (non-*.test.ts capture helper), kimi-staged-queue/ (captured screen + provenance, OBS-552 addendum)
├── gates/          13 *.test.ts files
├── graph/          4 *.test.ts files
├── helpers/        tmprepo.ts                (shared repo/graph fixtures, not a *.test.ts file)
├── hygiene/        3 *.test.ts files (brand-sweep, live-fixture-guard, sync-heavy-timeouts)
├── pane-banner.test.ts
├── plan/           2 *.test.ts files (scope, scope-flow)
├── readme-steering.test.ts
├── repo/           9 *.test.ts files (export fixtures/manifest, readme + contact + community boundaries, build provisioning, release docs)
├── report/         4 *.test.ts files
├── route/          16 *.test.ts files (router, explore, failover, profile, etc.)
├── run/            29 *.test.ts files (daemon, journal, merge, consult, stall, interactive-seed, environment, etc.)
├── scripts/        probe-rig.test.ts
├── seat-send.test.ts  drives the SHIPPED skills/ delivery script against a fake `herdr` (OBS-552)
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

**Shared repo/graph helpers** live in `tests/helpers/tmprepo.ts`. Other non-`*.test.ts` TypeScript under `tests/` is supporting infrastructure, not discoverable test cases: `tests/setup.ts` (vitest `setupFiles` — seals leaked routing env before collection and applies the pooled project's per-file leaf ceilings), and `tests/fixtures/codex-mcp-spinner/capture.ts` (one-off capture helper). Vitest's `include` pattern is `tests/**/*.test.ts` only — those three files are excluded from collection by design.
- `makeRepo(files: Record<string,string>): string` — real temp dir, `git init -b main`, writes files, one commit
- `setupRepo(tasks, script, extraCfg?)` — `makeRepo` + a validated graph + `.tickmarkr/config.yaml` wired to a scripted `FakeAdapter` for judge/consult
- `T(id, over?)` — minimal single-task factory for daemon-level tests
- `COMMIT` — the shared `git add -A && git commit --no-gpg-sign -m` string, spliced into `FakeAdapter` scripts' `shell` steps

**AUTHORING LAW — a fixture standing in for an external surface must be a verbatim capture, never hand-typed; and a fixture standing in for the product's *own* rendered surface must additionally be captured through the production render path, with equivalence to that path asserted, not assumed.** TUI frames, CLI stdout, adapter transcripts, banner text: commit the bytes that surface actually produced, as data, and derive any variant from that capture by slicing it. A hand-drawn fixture encodes the author's *mental model* of the surface, so it agrees with the matcher that was written from the same mental model — the test passes and the live path stays broken, with no failing test anywhere to say so.

**Provenance and stability together are insufficient.** "It is the renderer's own emitted output" and "regenerating it reproduces it byte for byte" are both true of a second renderer built for capture: a regeneration check compares a capture against itself and therefore proves nothing about which tree produced those bytes. Identity is the missing property, and identity has to be asserted positively:

- **Equivalence is the primary oracle.** The capture path's bytes must be identical to the production path's bytes for the same data at the same dimensions. An assertion that the capture path merely *imports* the product's components is structural and passes happily while two render trees coexist side by side; an equivalence assertion cannot pass while a second renderer exists.
- **State positively what only the production tree can produce**, rather than only forbidding hand-authoring. Name the structure: a bordered panel enclosing its own content across more than one row; a stat tile whose value and whose series both sit inside the tile's own border; journal rows inside a border rather than as bare lines. A flat-line renderer cannot counterfeit those, so asserting one is a test of identity rather than of intent.

This is not hypothetical. `KIMI_INPUT_BOX`'s recognizer was written against a hand-typed flush-left box (`"╭────╮\n│ >    │\n╰────╯"`), but kimi indents its whole TUI one column. The `^`-anchored row regexes could never match reality. The synthetic fixture passed for four versions while every live readiness check scored a fully-painted, interactive editor box as absent (OBS-152); the sibling banner matchers failed the same way and, worse, failed *open* (OBS-153). It was diagnosable only because the driver journalled the real frame. `tests/fixtures/kimi-editor-readiness/frame-0*.txt` are those captures — one per kimi version, indentation asserted explicitly so a future un-indent fails loudly instead of silently re-blinding the matcher.

The identity clause has its own incident, and it is why the earlier wording was replaced rather than merely extended. v1.80's golden corpus — 20 cockpit frames across four heights, three widths and the colourless, non-interactive and CI variants — was captured by a module that built its *own* frame out of local line helpers: the panel, the stat tile, the sparkline, the journal row panel and both cockpit frames were used zero times, and only the progress meter, the keybar and the status strip were real. It was a partial shadow, which is why it read as plausible. The whole three-column bordered-panel design arrived in the corpus as one flat line carrying three panel names in decorative stubs, with a collapsed one-line summary standing where three bordered stat tiles with sparklines belong (OBS-164). Every gate passed honestly: each criterion constrained provenance ("the renderer's own emitted output", "a verbatim capture rather than authored text") or stability ("regenerating every frame reproduces it byte for byte"), and every one of those is satisfied by a shadow. Note what the earlier wording did *not* do — it was never violated. Its phrase *"captured verbatim from the real surface"* put the whole burden on the word **real**, which no test can enforce, so the criteria written from it dropped the word and kept the enforceable remainder. That is why the replacement names a comparison (equivalence) and a structure (an enclosing border) instead of an adjective.

Practical rules: capture through the **production read path** (`tests/fixtures/codex-mcp-spinner/capture.ts` reads via `HerdrDriver.read`, the exact call the daemon consumes) so the bytes carry the rendered form, not a raw-pty transcript; assert a distinguishing property of the capture (the leading indent, a version line) so a later "tidy-up" of the file fails the test; and when a needed state is not capturable, slice it from a real frame and say so in a comment rather than inventing it. A fixture pair whose positive case is real and whose negative case is imagined is only half-fixed.

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
The two sync-heavy members (`tests/cockpit/sweep.test.ts`, `tests/docs-truth-testing.test.ts`) never carry an inline timeout; their ceiling is 1,200,000 ms by ruling (`SYNC_HEAVY_TIMEOUT_MS`), applied as described below.

**Project layout — sync-heavy pooled locally, isolated under the CI guard (OBS-634 add):** `vitest.config.ts` defines one parallel project, `suite`, and single-fork projects that run one file at a time after the parallel fan-out. `keys-ledger`, `built-cli` and `signal-reaper` stay single-fork in every environment. `sync-heavy` exists only under the CI guard (`TICKMARKR_CI_LEAN_REPORTERS=1`): there its two members keep their own single-fork project and their own step in `.github/workflows/ci.public.yml`, unchanged, because their isolation remedies the 2-core hosted runner's birpc starvation. Without the guard — every local and daemon-gate run — the members pool into `suite`. A project has one `testTimeout` for all its files, so `suite` provides per-file ceilings (`leafCeilings`) and `tests/setup.ts` applies the current file's ceiling before its tests collect: the two members keep 1,200,000 ms inside the pool while every other pooled file keeps the 20,000 ms default. The fork cap sits on the root config, because vitest 3.2.7 sizes its single forks pool from the root (or `VITEST_MAX_FORKS`) and never reads a project-level `maxForks`. Before this change a bare local `npm test` therefore fanned out to about cores − 1 forks; daemon gates were capped all along, because the daemon always exports `VITEST_MAX_FORKS`. `tests/config/vitest-serial.test.ts` proves the layout by running the production configuration over fixture members in both modes.

**Pooling qualification and savings — measured versus estimated.** T1's own merge-candidate full suite (v2.6.3, the task that introduced the pooling) is the first full-suite qualification under the pooled configuration: its complete-manifest test gate (run `run-20260927-122129-0000000000000171`, attempt 1, commit `2be907a7`, invocation `2130cc9544b9949a14563b7ab9de7026`, journaled 2026-09-27T13:28:56Z) executed all 380 manifest files — 378 run, the two e2e files skipped whole as always — with sweep and docs-truth inside the capped pool beside every other member. Set against the v2.6.2 tip verify (run `run-20260925-234935-0000000000000149`, same 380-file manifest, isolated layout, same host), the per-file `started`/`completed` stamps in the two invocation-bound manifest reports measure:

| Complete-manifest run | Wall clock | Parallel phase ends | Single-fork tail | sweep / docs-truth |
|---|---|---|---|---|
| v2.6.2 tip verify (isolated) | 1,014 s | 541 s | 472 s (541 → 1,014 s; keys 176 s, docs-truth 164 s, sweep 76 s, others) | 240 s of the tail, one fork |
| T1 full-suite gate (pooled) | 761 s (journal `durationMs` 762,839) | 535 s | 225 s (536 → 761 s; keys 170 s, then the other single-fork projects) | inside the pool: sweep 96 s, docs-truth 184 s, both finished by 446 s |

**Measured saving: 253 s of wall clock per local full suite (1,014 → 761 s), all of it from the serial tail (472 → 225 s), at no cost to the parallel phase (541 → 535 s).** That measured figure supersedes the model below for the local layout; it is one host and one pair of runs, so later gates will move it. Everything else here is an estimate: the members cost about 221 s as a one-fork tail in v2.6.2 (sweep 75 s + docs-truth 146 s in that release's earlier gates; 240 s in the tip verify above), and pooling was modeled to save 122–221 s per local full suite — the measurement landed above the model because the isolated tail also serialised the members behind keys. Under the unchanged CI guard there is no measured saving at all, because CI still isolates the members in their own step; any CI figure is an estimate only. The serial tail is not promised to fall under 60 s: `keys-ledger` (about 170 s) and the other single-fork projects stay isolated, and they are the whole of the 225 s tail measured above.

**Host-health admission (OBS-1160):** Before baseline commands, the production daemon records an exec-latency reference in the run journal. `src/run/host-health.ts` measures three sequential `process.execPath -e ""` children with ignored stdio and `NODE_OPTIONS` removed. Each sample measures monotonic elapsed time from spawn through close and has a 1,000 ms timeout; one observation has a 3,000 ms budget. A spawn error, nonzero exit, timeout, or missing/nonpositive/nonfinite sample makes the entire observation unreadable (`medianMs: null`). Timeout and cancellation kill only the owned probe child with SIGKILL and await close before returning.

Before every leased suite command, admission measures another three-sample median, including when the live-suite census is zero. A median **at or above `max(50 ms, 3.0 × reference median)`** is degraded; 3.0 is `FILE_HANG_SLACK`. Thus 2.9× is admitted, and the absolute 50 ms floor prevents tiny references from flagging ordinary jitter. `host-reference` persists the reference and samples; `host-observation` persists subsequent samples, medians, the reference used and the observation's `state` (`healthy`, `degraded` or `unreadable`). `host-degraded` records the observation, reference, live-suite count, and elapsed wait. **Every admission poll still probes** — the probe decides admission — but `host-observation` is journaled only for the first observation and for each change of state or reference, including recovery, the way `suite-wait` is journaled only when its count changes (OBS-1190: a five-minute wait had appended one row per 250 ms poll). A steady healthy wait therefore writes at most two rows (the startup observation and the first admission observation against the recorded reference); `host-degraded` still names every degraded or unreadable poll.

Health and occupancy share `SUITE_WAIT_CEILING_MS` (600,000 ms) per admission. Waits poll at `SUITE_POLL_MS` (250 ms), capped by the remaining deadline; the first observation is capped by that remaining time as well as its 3,000 ms budget. Subsequent batches start only when at least 3,000 ms remains, so a truncated final batch cannot manufacture a host failure. At expiry, the latest complete observation decides admission. A degraded or unreadable host parks the task as infrastructure before launching a suite. If startup or baseline-command admission fails before `baseline.json` is persisted, the run instead closes with a fatal baseline failure; it cannot offer a resumable park without that baseline. Only a healthy host with competing suites retains the existing `suite-wait-ceiling` / `suite-budget` conservative-cap fallback. The wait does not inflate suite execution budgets.

Every resume with runnable work or configured commands re-probes before allowing task gates, loading the most recent persisted reference. After the initial bounded startup measurement, a slower resume must remain readable and degraded, with zero live suites at every poll, for the entire admission deadline before the daemon journals `host-reference-reset` with **both `referenceMs` (old median) and `medianMs` (new median)** and then adopts the new reference. Recovery admits against the original reference; any unreadable observation or live suite vetoes that reset for the session's startup wait. An unreadable host parks infra at expiry, never through occupancy fallback. Legacy journals without a reference establish one from the first readable observation. `tests/run/daemon/host-health.test.ts` exercises these rules through `runDaemon`, plus real probe-child cancellation and timeout cleanup.

**Per-file hang budgets count active time; a detected clock discontinuity is subtracted, an ambiguous gap is not (OBS-953):** `runManifestedTest` (`src/gates/test-manifest.ts`) polls the runner's report every 20 ms and, at each poll, compares how far the **wall clock** (`Date.now()`, the clock the reporter stamps `started` with) and the **monotonic clock** (`performance.now()`) advanced since the previous poll. The comparison classifies only three cases:

- **Detected discontinuity (`host-suspend`):** wall advanced more than monotonic by over `CLOCK_JUMP_SLACK_MS` (1,000 ms). That wall-over-monotonic offset is subtracted from the active elapsed time of every file started before the gap ended, so a lid-close during a file does not spend its budget.
- **Unknown gap (`unknown`):** the poll arrived more than 1,000 ms overdue while both clocks advanced together. It is recorded, and **nothing is subtracted**.
- **On time:** nothing is recorded.

A file whose **active** elapsed time (wall elapsed minus detected offsets) reaches its budget is still killed as an `infra hang`, exactly as before. Its budget is derived from the baseline (`fileHangBudgetMs`: the larger of three times the file's own green time and the longest file; three times the longest for a new or baseline-red file) and enforced as the larger of that and `MIN_FILE_HANG_BUDGET_MS` (10,000 ms), capped by the battery ceiling — a ceiling below 10,000 ms still wins. A fast suite's millisecond timings therefore no longer yield a millisecond budget; a new or baseline-red file that runs longer than both 10,000 ms and three times the longest file is still killed by the derived rule. The hang's details name its active time and its raw wall time separately (`31020ms active of 31020ms wall`), and every interruption is listed beside the verdict (`host interruptions: …`, gate meta `interruptions`) — it is never folded into the verdict or into the raw wall service. The daemon journals each detected discontinuity as `host-suspend` and each unknown gap as `host-poll-overdue`, attributed to the task whose gate observed it, or unattributed for tip verify. The limits are deliberate. A `host-suspend` row is an **observed clock jump, not a proof that the operating system slept**: a manually set wall clock or an NTP step jumps the same way. Whether the host slept is proven only independently, for example by `pmset -g log` on macOS. The monotonic clock's behaviour across suspend is platform-specific: libuv's clock excludes suspend on the hosts measured so far, and no universal claim is made. A host whose clocks both advanced through a suspend shows only an unknown gap, which cannot excuse an active hang. The per-invocation command ceiling remains a libuv timer and is unchanged. `tests/gates/test-manifest.test.ts` injects both clocks through the production task gate and tip verify: a 156-second wall-only jump is an interruption, while thirty-one seconds on both clocks is a hang against a thirty-second budget, recorded as an unknown gap.

**Suite lease across worker, reviewer and gate suites (OBS-880 suite (2), OBS-1071):** `vitest.config.ts` registers `scripts/vitest-lease.ts` as `globalSetup`, so every `vitest run` of this repository — a worker's or a reviewer's own suite, a gate suite, in any linked worktree — takes or reenters one file lease, `tickmarkr-runner.lease` in the repository's trusted common git dir (`withRepositoryLease`, `src/run/lease.ts`); an unrelated repository has its own lease and runs alongside. A waiter prints `tickmarkr: vitest waits for this repository's runner lease held by pid … in …` once per holder and starts when that reservation is released or reclaimed. `vitest list` (manifest discovery) and a cwd with no trusted common git dir take no lease; the listing command is read with Vitest's own CLI parser, so options may precede it (`vitest --configLoader runner list`) while `vitest run list` stays a filtered run. Vitest runs global setup in its main process before it builds the fork environment, so the entry exports its token as `TICKMARKR_REPOSITORY_LEASE_TOKEN` before the first fork. A gate's manifested test is instead **one verification job** (`src/run/verification-job.ts`, around `evaluateManifestedTest`): command admission first, then one isolated repository reservation held through discovery, the first pass and at most one stranded continuation. Its token never enters the daemon's `process.env`: the shell sets it only on the children it spawns and records each spawned root and its process birth on the reservation; under `tickmarkr verify` the job reuses verify's reservation through its private async capability. A nested runner (the gate's own `vitest run`, a mutation child) **reenters** only when its inherited token names the record currently at this repository's lease path, that holder is alive — pid live, not `ownerReleased`, and no different process birth than the one it recorded — and the holder is a strict ancestor process. Everything else waits: a forged, stale, released, foreign-repository or command-lease (`TICKMARKR_LEASE_TOKEN`, which the daemon clears and rewrites per child) token, a second job in the same process, and an unrelated infrastructure retry, which is a new FIFO job behind any older queued one. Release is bounded and proven: the Vitest entry no longer releases from its global-setup teardown but from Vitest's public `onClose` hook, after waiting up to 10 s for its descendants to drain; every reservation then SIGKILLs its remaining token-bound descendants and waits up to 15 s for a `ps` census to show its protected tree gone before it removes the record. A reap deadline or an unreadable census instead rewrites the record as `ownerReleased` and fails the release (a verification job then returns an infra, non-retryable test row). Such a record, like a dead holder's (pid gone, or alive under a different birth), is reclaimed by the next waiter only once a successful census finds none of its token-bearing processes or recorded root groups alive; an unreadable census refuses admission. On SIGINT/SIGTERM Vitest exits without global teardown and without closing its pool, so the hook's exit listener (prepended ahead of Vitest's own) freezes, kills and awaits every process below the holder and removes its record only once that tree is gone; otherwise the dead-holder rule applies. This is cooperation between configured entries: it does not enforce anything on arbitrary shell programs or on foreign runner configurations. `tests/config/vitest-lease.test.ts` proves the entry rules with real Vitest processes over fixture repositories; `tests/run/lease.test.ts` pins the `ownerReleased` hand-off and dead-holder reclamation, and `tests/run/verification-job.test.ts` the job's single reservation, capability, cancellation and FIFO tables.

**Semantics, then one full verification job (OBS-1176/1070):** Once the cheap checks pass (`build`, `lint`, `evidence`, `scope`; the first red ends the round), `src/gates/run-gates.ts` starts `acceptance` and `review` together, in parallel, before any test payload for a fresh or semantic-repair candidate. A decisive semantic red ends the round with zero diagnostic or full test-gate runs (a required acceptance oracle still executes); otherwise the round runs ONE full verification job, with no selected screen. A review that returned no verdict, or a declined gate, is not such a red: the full job still runs in-round and the review stays unsatisfied until review-only recovery answers. If the semantic gates left the worktree dirty, the round records a dirty-tree refusal on `test` and starts no full job. Only an attributed behavioral test-red repair may buy one diagnostic before semantics (next paragraph). Its behavioral red is the round's test verdict and neither semantic gate starts; an infrastructure diagnostic, or one killed by a signal (or exit 137/143) that names no failing test, is published unverdicted (`skipped`), is never green, and the round goes on to semantics and the full job — a killed diagnostic that names a failing test keeps its red (`classifySignalOnlyTest`); a green is journaled as its own `gate-result` row (`selectedTests`, no `fullSuite`) before the judge and review phase-starts. The full job after semantics is then journaled as a second `test` row (`fullSuite: true`, carrying the diagnostic's `selectedTests`) under its own evidence-receipt invocation and its own interval, and replaces the diagnostic in the round's returned results; without a diagnostic the full job is the round's single `test` row. Test-only verification (no semantic gate) and an explicit full recheck run their full job with no diagnostic. A diagnostic green is never full proof: a round that ends on recoverable non-verdicts records every enabled gate it left unrun — a test gate holding only a diagnostic green included — as owed (`gateOwed`, `testOwed`), and nothing merges on it. `tests/run/gate-telemetry.test.ts` pins the journal order through `runDaemon`; `tests/gates/candidate-policy.test.ts` and `tests/gates/run-gates.test.ts` pin the closed order, recovery and missing-proof tables.

**Repair selection and the diagnostic's admission (OBS-1199/635):** Repair selection is **on by default**, independently of the optional `executionPolicy` (which keeps its subprocess-only budget): with no policy at all the daemon still consults `repairSelectionDecision` (`src/run/repair-selection.ts`) on every driver — subprocess, Orca and Herdr — and only an explicit `gates.repairSelection: false` (or `executionPolicy.repairSelection: false`) turns it off, after which no round buys a diagnostic. A resume keeps the policy its run recorded. A test red is attributed only with **full provenance**: a behavioral row on a recorded commit that names its `failingFiles` and positively states which suite spoke — a diagnostic whose `selectedTests` contain every failing file, the replacement full job (`fullSuite: true`), or an ordinary full run whose `selectionDecision.scope` is `full`. A recorded infrastructure red that names no failing files (and is not classified a regression) is ignored; any other red missing provenance distrusts selection for the task, and neither that distrust nor known failing files are cleared by later greens, approvals or resume. With selection trusted and failing files known, the diagnostic is the union of every attributed failing file — each must be a tracked test file present in the worktree, even one no changed import reaches — and the tests reaching the diff through relative imports. It is skipped, and semantics precede the one full job, when a required file is unavailable, when the diff holds a rename or delete or a changed source no test reaches (`unsupported-attribution`) or reaches no test at all, when more than 3000 analyzable JS/TS paths are tracked (`analyzable-path-cap`), for test-only verification and an explicit full recheck, and when a qualified full green on the exact identity already answers (`full-green-cache`). Otherwise `diagnosticAdmission` reads the per-file durations the harness measured at baseline capture: the current capacity must be valid and the timing must not have been recorded under a different or malformed one, every measurement must be a finite number > 0 ms, every selected file must be measured, and the serial estimate of the selected files must be ≤ `DIAGNOSTIC_MAX_RATIO` (0.15) of the baseline total AND ≤ `DIAGNOSTIC_MAX_ESTIMATE_MS` (60000 ms). Unknown, mismatched or over-bound timing skips the diagnostic; it never puts a full suite before semantics. The deciding reason, with any ratio and estimate, is journaled in the test row's `selectionDecision`. **Nothing merges without a complete green on the exact tree:** every full job — in-battery, after a diagnostic, or test-only — lists the runner's complete manifest after its own command, then re-checks cleanliness and the verification identity (tree, command, baseline, environment — runtime, lockfile, runner inputs such as `PATH` and `NODE_OPTIONS`, dependency resolution, capacity, protocol and lifecycle; the in-battery job also treats an unmeasurable lifecycle as changed) before it is cached or published green. A stale green is published unverdicted and buys one fresh job, whose own stale green fails closed. Every cached full-green reuse, the pre-diagnostic one included, must re-pass the same listing, cleanliness and identity checks; a Vitest green that certified no manifest is never reused, and a non-Vitest runner, which has no listing, is bound by its identity alone. `tests/run/repair-selection.test.ts`, `tests/gates/repair-selection.test.ts`, `tests/gates/candidate-policy.test.ts` and `tests/gates/run-gates.test.ts` pin these rules.

**Regression tests carry their provenance in the test name/comment** — when a bug was found via a live/manual check, the fix's test cites exactly what broke (e.g. "cursor's trust dialog scraped as idle", "herdr agent_name_taken regression") so a future reader knows why the assertion exists, not just what it checks.

---

*Testing analysis: 2026-07-18*
