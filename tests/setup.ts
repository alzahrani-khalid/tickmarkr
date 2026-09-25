// v1.51 T2 / gate hermeticity: TICKMARKR_QUALITY and TICKMARKR_NO_EXPLORE are legacy routing env
// vars that --quality no longer sets (v1.51 T2 made it a pure --mode partner-led alias with no floor
// raise of its own). An ambient value inherited from the operator's shell would still perturb
// unit-test routing, so seal both before any test collects — green in a clean pane shell, red at the
// gate otherwise. Constants are imported (not hardcoded) so a rename can't silently un-seal this.
// Runtime entrypoints also delete QUALITY_ENV; this setup guard keeps direct route() unit tests hermetic.
import { afterAll } from "vitest";
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

// OBS-1155: every temporary this file or its child processes create lands in one recorded TMPDIR,
// reaped at teardown together with the inherited value's restoration.
relocateTestTmpDir();
afterAll(restoreTestTmpDir);
