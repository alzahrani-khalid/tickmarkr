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

// D-1196 (v2.6.7 close): the same leak class for a tickmarkr HARNESS. When tickmarkr >= 2.6.7 runs this
// suite as a gate, every child shell carries its verification-job token (descendant reaping) and T4's
// forced git config, so this suite's own nested jobs adopted the outer token and its hook tests never saw
// their hooks fire — red under the harness, green in a plain shell. Drop the token and remove exactly the
// forced fragment: the remedy docs/codebase/INTEGRATIONS.md gives any suite that needs real hooks.
// ponytail: literals, not imports — importing src/run/{verification-job,git-trust}.ts here would load
// lease.ts and node:child_process before test files vi.mock them. A drift fails loud: these suites red again
// under the harness (src/run/verification-job.ts VERIFICATION_JOB_TOKEN_ENV, src/run/git-trust.ts FORCED_GIT_CONFIG).
delete process.env.TICKMARKR_VERIFICATION_JOB_TOKEN;
// protectedGitEnv APPENDS `${prior.trim()} ${forced}` (or the bare pair): strip that one suffix — never a match
// inside a quoted value — so under a harness the prior parameters come back byte-for-byte, even a prior that itself
// ends with the pair. With no harness, a list ending in exactly the pair is byte-identical to that append and loses
// the one pair (harmless here: this suite wants real hooks). ponytail: one harness layer; a harness launched inside
// another harness's gate shell stacks a second copy that stays — loop this suffix strip if that setup runs this suite.
const FORCED_GIT_CONFIG = "'core.fsmonitor=false' 'core.hooksPath=/dev/null'";
// The suffix is the harness's only where its separating space is a bare separator: outside any quoted value and not
// escaped (git's sq rules: outside quotes `\` escapes the next character, so '\'' is a literal quote; inside quotes
// only ' is special). A scan that steps OVER `end` means a `\` escaped that space.
const outsideQuotes = (s: string, end: number): boolean => {
  let quoted = false;
  let i = 0;
  for (; i < end; i++) { if (!quoted && s[i] === "\\") i++; else if (s[i] === "'") quoted = !quoted; }
  return !quoted && i === end;
};
let gitParams = process.env.GIT_CONFIG_PARAMETERS;
const suffixAt = (gitParams?.length ?? 0) - FORCED_GIT_CONFIG.length - 1;
if (gitParams === FORCED_GIT_CONFIG || (gitParams?.endsWith(` ${FORCED_GIT_CONFIG}`) && outsideQuotes(gitParams, suffixAt))) gitParams = gitParams.slice(0, -FORCED_GIT_CONFIG.length - 1);
if (gitParams) process.env.GIT_CONFIG_PARAMETERS = gitParams; else delete process.env.GIT_CONFIG_PARAMETERS;

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
