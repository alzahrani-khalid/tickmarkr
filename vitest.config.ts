import { coverageConfigDefaults, defineConfig } from "vitest/config";

// v1.22 T3 / OBS-17: seal herdr control-plane vars before workers fork so the suite never inherits
// HERDR_ENV=1 (or a live socket) from the operator's shell. Tests may re-set these explicitly
// (e.g. pickDriver HERDR_ENV oracle); the leak class is ambient inheritance, not deliberate fixtures.
// Daemon process under a real run keeps its env — only the vitest process tree is sealed here.
for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH"] as const) delete process.env[k];

// Same leak class for the GLOBAL config overlay: the operator's ~/.config/tickmarkr/config.yaml
// (e.g. extra pi tier models) must never reach unit-test fixtures — byte-pinned doctor/plan output
// broke on the dev machine while green in CI (2026-07-15). Point XDG at a committed empty dir.
process.env.XDG_CONFIG_HOME = new URL("./tests/.xdg-empty", import.meta.url).pathname;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"], // v1.51 T2: scrub leaked TICKMARKR_QUALITY/NO_EXPLORE (gate hermeticity)
    testTimeout: 20000,
    coverage: {
      provider: "v8",
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
