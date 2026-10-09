// v1.51 T2 / gate hermeticity: TICKMARKR_QUALITY and TICKMARKR_NO_EXPLORE are legacy routing env
// vars that --quality no longer sets (v1.51 T2 made it a pure --mode partner-led alias with no floor
// raise of its own). An ambient value inherited from the operator's shell would still perturb
// unit-test routing, so seal both before any test collects — green in a clean pane shell, red at the
// gate otherwise. Constants are imported (not hardcoded) so a rename can't silently un-seal this.
// Runtime entrypoints also delete QUALITY_ENV; this setup guard keeps direct route() unit tests hermetic.
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, inject, vi } from "vitest";
import { NO_EXPLORE_ENV, QUALITY_ENV } from "../src/route/router.js";
import { relocateTestTmpDir, restoreTestTmpDir } from "./helpers/tmprepo.js";

for (const k of [QUALITY_ENV, NO_EXPLORE_ENV]) delete process.env[k];

// OBS-1005 (2026-09-12): the same leak class for HOST markers. A suite launched from an Orca terminal
// inherits TERM_PROGRAM=Orca + ORCA_TERMINAL_HANDLE, so every `auto` driver pick resolves to orca —
// seven byte-pinned plan/init/brand tests red, and the built CLI's resume dispatched on the REAL
// `orca` binary. vitest.config.ts seals HERDR_ENV/HERDR_SOCKET_PATH in the parent before workers
// fork; this per-worker scrub seals the Orca pair (and HERDR_ENV again, for a worker whose parent
// was not that config). Tests that need a host set it explicitly inside the test.
for (const k of ["TERM_PROGRAM", "ORCA_TERMINAL_HANDLE", "HERDR_ENV"]) delete process.env[k];

// D-1522 (2026-10-08): the same leak class for a CATALOG KEY. The operator's shell exports a real
// ARTIFICIAL_ANALYSIS_API_KEY, so every catalog refresh under test grew an Artificial Analysis leg — two fleet
// tests red at the gate, green in a shell without the key — and the real key reached test fetchers. Tests that
// need a key set one with vi.stubEnv.
delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;

// OBS-1155: every temporary this file or its child processes create lands in one recorded TMPDIR,
// reaped at teardown together with the inherited value's restoration.
relocateTestTmpDir();
afterAll(restoreTestTmpDir);

// OBS-634 add (v2.6.3 T1): a project's testTimeout is one value for all its files, so the pooled
// `suite` project provides per-file leaf ceilings (vitest.config.ts SYNC_HEAVY_LEAF_CEILINGS) and
// this file applies the current file's ceiling before its tests collect — a test binds its timeout
// at collection. Vitest resets vi.setConfig after every file, so the ceiling never leaks onward.
const leafCeiling = inject("leafCeilings")?.[
  relative(fileURLToPath(new URL("..", import.meta.url)), expect.getState().testPath ?? "").replaceAll("\\", "/")
];
if (leafCeiling) vi.setConfig({ testTimeout: leafCeiling });
