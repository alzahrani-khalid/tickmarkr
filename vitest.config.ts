import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

// v1.22 T3 / OBS-17: seal herdr control-plane vars before workers fork so the suite never inherits
// HERDR_ENV=1 (or a live socket) from the operator's shell. Tests may re-set these explicitly
// (e.g. pickDriver HERDR_ENV oracle); the leak class is ambient inheritance, not deliberate fixtures.
// Daemon process under a real run keeps its env — only the vitest process tree is sealed here.
for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH"] as const) delete process.env[k];

// Ink detects CI via `is-in-ci` (memoized at import time) and suppresses interactive re-renders when it's
// set, so the fleet interaction tests read EMPTY frames under CI (release.yml) though they render real
// frames locally — mid-session lastFrame assertions saw '\n'. is-in-ci checks ONLY these two vars
// (node_modules/is-in-ci/index.js: check('CI') || check('CONTINUOUS_INTEGRATION')), so seal them here —
// before workers fork — so is-in-ci memoizes non-CI in every worker and Ink renders identically in CI and
// local. Real CI runs (release.yml) thus exercise the same interactive frames the local suite does.
for (const k of ["CI", "CONTINUOUS_INTEGRATION"] as const) delete process.env[k];

// Same leak class for the GLOBAL config overlay: the operator's ~/.config/tickmarkr/config.yaml
// (e.g. extra pi tier models) must never reach unit-test fixtures — byte-pinned doctor/plan output
// broke on the dev machine while green in CI (2026-07-15). Point XDG at a committed empty dir.
process.env.XDG_CONFIG_HOME = new URL("./tests/.xdg-empty", import.meta.url).pathname;

// OBS-96 fix (v1.60 T9): the repro rig's captured crash telemetry (scripts/repro-obs96.mjs
// REPRO_RECORD.sampleCrashStderr) identifies the contended resource as the ROOT dist tree:
// tests/cli/bin.test.ts:37 runs a full `npm run build` MID-SUITE (tsc emits truncate-then-write)
// while parallel forks in cli.test.ts/version.test.ts spawn `node dist/cli/index.js` — a reader
// that imports a module inside the rewrite window loads an empty/partial file (captured:
// dist/route/router.js) and exits 1 with no stdout, the exact fresh-clone first-run signature.
// These three files are the suite's ONLY mid-suite dist writer + readers (closure is red-pinned by
// the OBS-96 guard test in cli.test.ts), so they run in one single fork, sequentially, after the
// parallel fan-out (vitest per-project poolOptions.forks.singleFork) — dist access is mutually
// exclusive by construction. Everything else keeps full parallelism: NOT a fork cap (the v1.60
// scope consult forbids caps chosen without evidence — this serializes exactly the evidenced set).
export const DIST_COUPLED_TESTS = [
  "tests/cli/bin.test.ts", // writer: rebuilds + packs ROOT dist mid-suite
  "tests/cli/cli.test.ts", // reader: spawns node dist/cli/index.js
  "tests/cli/version.test.ts", // reader: spawns node dist/cli/index.js
];

export const SIGNAL_REAPER_TESTS = ["tests/run/reconcile-live.test.ts"];

// OBS-618: the fork budget tickmarkr already sets, that nothing on this side ever read.
// `src/run/git.ts` writes VITEST_MAX_FORKS (FORK_CAP_ENV, DEFAULT_FORK_CAP "6") into EVERY child it
// spawns — gate batteries, baseline capture, tip verify — and derives it from the run's concurrency so
// one run's suites divide the machine by that run's number. But **vitest has no VITEST_MAX_FORKS**, and
// this config never read it, so the cap was a NO-OP: gate suites ran at vitest's default (~cores-1; an
// 18-core machine measured 19-23 concurrent forks) while the daemon believed it had capped them at 6.
//
// Each fork spawns daemons that themselves spawn `git`, so the counts MULTIPLY and exhaust the fork
// table. `spawn EAGAIN` then surfaces inside a test as `expected [] to have a length of N` — a resource
// failure wearing an assertion failure's clothes. Six gates died that way in one run, across two tasks
// with no shared file (T1, T3) and two vendors (claude, codex), at load1 as low as 2.21.
//
// Read ONLY when the variable is present and sane, so a developer's plain `npm test` keeps full
// parallelism and only tickmarkr's own children are capped — which is exactly what the daemon intended
// to be true all along. This is not the "cap chosen without evidence" the v1.60 scope consult forbade;
// the evidence is above, and the number is the daemon's own.
const FORK_CAP = Number.parseInt(process.env.VITEST_MAX_FORKS ?? "", 10);
const FORK_CAP_POOL = Number.isFinite(FORK_CAP) && FORK_CAP > 0
  ? { poolOptions: { forks: { maxForks: FORK_CAP } } }
  : {};

// Report-26 birpc-starver class (Q72s): on the 2-core hosted runner the single vitest worker
// starves its own birpc channel under long SYNCHRONOUS work — first 4/4 deterministic
// end-of-suite kills (docs-truth member sweep, remedied by async spawn), then run 31452816678
// still lost sweep.test.ts at 601s + post-suite onTaskUpdate timeouts. The starver is a CLASS;
// this list is ONLY its members with a produced CI red (RULING-1890-CI-DESIGN option c: own
// serial CI step, no rpc tuning, no class-wide absorption — an unknown red does not belong
// here). ci.public.yml runs this project as a separate step so the main suite's worker channel
// never carries their sync work; locally they simply serialize in one fork.
export const SYNC_HEAVY_TESTS = ["tests/cockpit/sweep.test.ts", "tests/docs-truth-testing.test.ts"];

export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"], // v1.51 T2: scrub leaked TICKMARKR_QUALITY/NO_EXPLORE (gate hermeticity)
    testTimeout: 20000,
    // GO-10 cycle-2 final candidate (threads reverted: 45 isolation-semantics fails at local
    // proof): the 2-core CI host answers worker birpc BETWEEN reporter/coverage rendering work,
    // and the fixed 60s worker->host timeout fires at the suite tail with every test green.
    // Trim host-side rendering under an env guard so CI's host answers inside the window;
    // local runs keep full reporters. Env-only delta: run commands and the ci-platform pin
    // stay byte-stable.
    ...(process.env.TICKMARKR_CI_LEAN_REPORTERS === "1" ? { reporters: ["dot" as const] } : {}),
    projects: [
      {
        extends: true,
        test: {
          name: "suite",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...DIST_COUPLED_TESTS, ...SIGNAL_REAPER_TESTS, ...SYNC_HEAVY_TESTS],
          // the only PARALLEL project — the other three already pin singleFork, so this is the one
          // that was running at ~cores-1 while the daemon believed it had said 6.
          ...FORK_CAP_POOL,
        },
      },
      {
        extends: true,
        test: {
          name: "sync-heavy",
          include: SYNC_HEAVY_TESTS,
          exclude: [...configDefaults.exclude, ...DIST_COUPLED_TESTS],
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 1_200_000, // generous by ruling: these members starve their own RPC under load
        },
      },
      {
        extends: true,
        test: {
          name: "built-cli",
          include: DIST_COUPLED_TESTS,
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        extends: true,
        test: {
          name: "signal-reaper",
          include: SIGNAL_REAPER_TESTS,
          exclude: [...configDefaults.exclude, ...DIST_COUPLED_TESTS],
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
    coverage: {
      provider: "v8",
      // GO-10: json-summary alone under the CI guard — thresholds enforce off the coverage map
      // regardless of reporter; text/html rendering is pure host-side crunch the 2-core runner
      // pays while the worker's last onTaskUpdate waits.
      ...(process.env.TICKMARKR_CI_LEAN_REPORTERS === "1" ? { reporter: ["json-summary" as const] } : {}),
      include: [
        "src/graph/**", "src/route/**", "src/gates/**", "src/run/**",
        "src/config/**", "src/compile/**", "src/adapters/**", "src/drivers/**", "src/cli/**",
      ],
      // src/drivers/types.ts: pure ExecutorDriver/Slot interfaces, zero executable statements — a
      // coverage threshold on a type-only file is meaningless and would force a fake test to satisfy it.
      exclude: [...coverageConfigDefaults.exclude, "src/drivers/types.ts"],
      // Per-glob floors — each glob is enforced INDEPENDENTLY (a drop in one dir fails on that dir's key,
      // never averaged against another). Every floor sits below its measured value: a regression alarm,
      // not a brag. Core-4 stays ONE brace glob at the exact 80/80/70 CLAUDE.md invariant.
      thresholds: {
        "src/{graph,route,gates,run}/**": { lines: 80, functions: 80, branches: 70 }, // CLAUDE.md invariant — verbatim
        "src/config/**": { lines: 90, branches: 90 },   // measured 99.27 / 96.96 on 2026-07-10
        "src/compile/**": { lines: 90, branches: 80 },  // measured 97.07 / 88.26 on 2026-07-10
        "src/adapters/**": { lines: 90, branches: 80 }, // measured 98.18 / 89.78 on 2026-07-10
        "src/drivers/**": { lines: 82, branches: 80 },  // measured 93.33 / 88.88 on 2026-07-10 (types.ts excluded)
        "src/cli/**": { lines: 85, branches: 75 },      // measured 94.82 / 81.52 on 2026-07-10 (post-backfill)
      },
    },
  },
});
