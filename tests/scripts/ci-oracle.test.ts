// v2.7.8 T3 acceptance — a shard is held to its plan as a set, and each OS to its manifest
// (specs/v2.7.8-sharded-ci.spec.md); v2.8.2 T1 (ANL-022 §7.1) — the record (FORMAT F3) a real run writes, and
// the wrapper's status-versus-record table. Every wrapper case runs THIS checkout's scripts/run-ci-vitest.sh in
// a candidate tree, as CI does. Real Vitest runs only where the criterion says real production-config (a
// scratch copy of the production configuration that copies the WHOLE scripts/ directory, committed so its
// record carries a head); the rest use PATH stubs of npx and npm (the seam tests/scripts/grade-ci.test.ts
// uses) and a scratch git repository.
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { readJson } from "../../scripts/ci/json.js";
import { parseRecord } from "../../scripts/ci/reporter.js";
import { DURATIONS_FILE, lptShards, renderDurations } from "../../scripts/ci/shard.js";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

// this file lives in tests/scripts/ — the repo root is two levels up
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WRAPPER = join(repoRoot, "scripts/run-ci-vitest.sh");
const TSX = join(repoRoot, "node_modules/.bin/tsx");
const CLI = join(repoRoot, "scripts/ci/cli.ts");
const execFileP = promisify(execFile);
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scratchDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
};

/** The child environment: no inherited Vitest, record, lean-reporter, git-location or lease variables. */
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GIT_")
    && key !== "TICKMARKR_CI_RECORD" && key !== "TICKMARKR_CI_LEAN_REPORTERS" && key !== "TICKMARKR_REPOSITORY_LEASE_TOKEN")),
  NO_COLOR: "1", FORCE_COLOR: "0", ...extra,
});

/** One owned child: its whole process tree is torn down before it answers. */
async function owned(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const run = await runOwned(cmd, args, { cwd, env, ms: 240_000 });
  const failures = ownedFailures(run, `${cmd} child`);
  if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
  return { status: run.exitCode, stdout: run.out, stderr: run.err };
}

const contractLines = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("SHARD_CONTRACT"));
const verdictLines = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("RECORD_VERDICT "));
const contractDefects = (stdout: string) => stdout.split("\n")
  .filter((line) => line.startsWith("SHARD_CONTRACT_DEFECT "))
  .map((line) => readJson(line.slice("SHARD_CONTRACT_DEFECT ".length)));

// ---- Vitest 3.2 log shapes (the lean dot reporter): a complete RPC-only run and a clean one
const BAR = "⎯⎯⎯⎯⎯⎯";
const summaryLines = (files: number, total: number, errors: boolean) => [
  ` Test Files  ${files} passed (${total})`, `      Tests  ${files} passed (${files})`, ...(errors ? ["     Errors  1 error"] : []), "   Duration  1.00s", "",
];
const rpcOnlyLog = (files: number, total = files) => [
  " RUN  v3.2.7 /x", "", "·".repeat(files), "", `${BAR} Unhandled Errors ${BAR}`, "", "Vitest caught 1 unhandled error during the test run.", "",
  `${BAR} Unhandled Error ${BAR}`, 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"', BAR, "", ...summaryLines(files, total, true),
].join("\n");
const cleanLog = (files: number) => [" RUN  v3.2.7 /x", "", "·".repeat(files), "", ...summaryLines(files, files, false)].join("\n");

// ---- FORMAT F3 records: a stand-in run's head, and the exact RPC timeout shape Vitest 3.2.7 reports (D-1974)
const RUN_HEAD = "e".repeat(40);
const RPC = { name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" };
type Entry = readonly [file: string, project: string, state?: string];
type Extra = { reason?: string; unhandled?: { name: string | null; message: string; type: string | null }[] };
const recordJson = (shard: readonly [number, number] | null, files: readonly Entry[], head: string | null = RUN_HEAD, extra: Extra = {}): string =>
  `${JSON.stringify({
    schema: "tickmarkr-ci-record/2", head, shard: shard && { index: shard[0], count: shard[1] },
    files: files.map(([file, project, state = "passed"]) => ({ file, project, state, durationMs: 1 })),
    reason: extra.reason ?? "passed", unhandled: extra.unhandled ?? [],
    tests: files.map(([file, project, state = "passed"]) => ({ file, project, name: `${file} > case`, state: state === "queued" ? "pending" : state })),
  })}\n`;
/** The record a complete run whose only unhandled error is the worker RPC timeout writes: its reason stays passed. */
const rpcRecordJson = (shard: readonly [number, number] | null, files: readonly Entry[]): string => recordJson(shard, files, RUN_HEAD, { unhandled: [RPC] });

// The stand-ins: `npx vitest list --filesOnly` answers from the tree as Vitest's discovery does — "[project] path"
// lines, or FORMAT F3 under --json=<file> — and fails if the record variable reached it; any other `npx vitest …`
// and `npm run <script> …` runs: it copies $FAKE_RECORD_SRC to the record path it was handed, notes that path,
// prints the scripted log and exits the scripted status.
const NPX_STUB = `#!/usr/bin/env bash
[ "$1" = vitest ] || exit 64
case "$2" in
  list)
    [ -z "\${TICKMARKR_CI_RECORD+set}" ] || { echo "discovery inherited TICKMARKR_CI_RECORD" >&2; exit 65; }
    shift 2; json=; projects=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --filesOnly) ;;
        --json=*) json=\${1#--json=} ;;
        --project) projects+=("$2"); shift ;;
        *) exit 64 ;;
      esac; shift
    done
    if [ "\${#projects[@]}" -eq 0 ]; then for d in tests/*/; do d=\${d#tests/}; projects+=("\${d%/}"); done; fi
    lines=(); entries=()
    for p in "\${projects[@]}"; do
      [ -d "tests/$p" ] || { echo "No projects matched the filter \\"$p\\"" >&2; exit 1; }
      for f in "tests/$p"/*.test.ts; do
        [ -e "$f" ] || continue
        lines+=("[$p] $f")
        case "\${FAKE_LIST_DEFECT:-}" in
          no-project) entries+=("{\\"file\\":\\"$PWD/$f\\"}") ;;
          outside) entries+=("{\\"file\\":\\"$(dirname "$PWD")/$f\\",\\"projectName\\":\\"$p\\"}") ;;
          *) entries+=("{\\"file\\":\\"$PWD/$f\\",\\"projectName\\":\\"$p\\"}") ;;
        esac
      done
    done
    if [ -n "$json" ]; then (IFS=,; printf '[%s]\\n' "\${entries[*]-}") > "$json"; else printf '%s\\n' "\${lines[@]-}"; fi ;;
  *)
    printf '%s' "\${TICKMARKR_CI_RECORD-}" > "$PWD/seen-record-path"
    [ -z "\${FAKE_RECORD_SRC:-}" ] || cp "$FAKE_RECORD_SRC" "$TICKMARKR_CI_RECORD"
    cat "$FAKE_RUN_LOG"; exit "$FAKE_RUN_STATUS" ;;
esac
`;
const NPM_STUB = `#!/usr/bin/env bash
[ "$1" = run ] || exit 64
shift 2
exec npx vitest run "$@"
`;

/** A candidate tree: tests/<project>/f<i>.test.ts, the durations table, and the stubs in .bin. */
function candidateTree(projects: Record<string, number>, durations: Record<string, number> = {}): string {
  const tree = scratchDir("ci-oracle-tree-");
  for (const [project, files] of Object.entries(projects)) {
    mkdirSync(join(tree, "tests", project), { recursive: true });
    for (let i = 1; i <= files; i++) writeFileSync(join(tree, "tests", project, `f${i}.test.ts`), "");
  }
  mkdirSync(join(tree, "scripts/ci"), { recursive: true });
  writeFileSync(join(tree, DURATIONS_FILE), renderDurations(durations));
  mkdirSync(join(tree, ".bin"));
  writeFileSync(join(tree, ".bin/npx"), NPX_STUB);
  writeFileSync(join(tree, ".bin/npm"), NPM_STUB);
  chmodSync(join(tree, ".bin/npx"), 0o755);
  chmodSync(join(tree, ".bin/npm"), 0o755);
  return tree;
}

let runs = 0;
/** The production wrapper over a stubbed command in `tree`; the log goes to a directory that does not exist yet. */
async function wrap(tree: string, command: readonly string[], o: { log: string; status: number; record?: string; logPath?: string; env?: NodeJS.ProcessEnv }) {
  const n = runs++;
  const runLog = join(tree, `scripted-${n}.log`);
  writeFileSync(runLog, o.log);
  const source = o.record === undefined ? "" : join(tree, `scripted-${n}.record.json`);
  if (o.record !== undefined) writeFileSync(source, o.record);
  const logPath = o.logPath ?? join(tree, `ci-${n}`, "run.log");
  const run = await owned("bash", [WRAPPER, logPath, ...command], tree, childEnv({
    PATH: `${join(tree, ".bin")}:${process.env.PATH}`, FAKE_RUN_LOG: runLog, FAKE_RUN_STATUS: String(o.status), FAKE_RECORD_SRC: source, ...o.env,
  }));
  return { ...run, logPath, output: `${run.stdout}${run.stderr}` };
}

const suite = (names: readonly string[], state?: string): Entry[] => names.map((name) => [`tests/suite/${name}.test.ts`, "suite", state]);
// LPT over f1..f10 at weight 1 each, two shards: path order f1 f10 f2 … f9, ties to the lowest index
const SHARD_ONE = ["f1", "f2", "f4", "f6", "f8"];
const SHARD_TWO = ["f10", "f3", "f5", "f7", "f9"];

/** A scratch copy of the production configuration (whole scripts/, the real setup file) over `fixtures`, its own
 * committed repository: the record's head is its HEAD and its runs take its own lease, never this checkout's. */
function productionScratch(fixtures: Record<string, string>): string {
  const scratch = scratchDir("ci-oracle-production-");
  for (const directory of ["src", "scripts"]) cpSync(join(repoRoot, directory), join(scratch, directory), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(scratch, file));
  }
  symlinkSync(realpathSync(join(repoRoot, "node_modules")), join(scratch, "node_modules"), "dir");
  for (const [file, source] of Object.entries(fixtures)) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    writeFileSync(join(scratch, file), source);
  }
  const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(scratch) });
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "scratch"]]) {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: scratch, env, stdio: "ignore" });
  }
  return scratch;
}
const scratchHead = (scratch: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: scratch, env: childEnv({ GIT_CEILING_DIRECTORIES: dirname(scratch) }), encoding: "utf8" }).trim();

test("test: the production wrapper holds a real production-config shard to its plan as a set exiting 0 when its record equals the plan while a status-0 run whose record holds the other equal-size shard's files exits 1 naming each missing and unexpected file", { timeout: 300_000 }, async () => {
  const probe = (name: string) => `tests/probe/${name}.test.ts`;
  const names = ["a", "b", "c", "d"];
  const scratch = productionScratch(Object.fromEntries(names.map((name) =>
    [probe(name), `import { test } from "vitest";\ntest(${JSON.stringify(name)}, () => {});\n`])));
  // the committed empty durations seed: every file weighs 1, so the plan is a c | b d
  expect(lptShards(names.map((name) => ({ file: probe(name), project: "suite" })), {}, 2).map((shard) => shard.map((item) => item.file)))
    .toEqual([[probe("a"), probe("c")], [probe("b"), probe("d")]]);
  // the scratch is its own committed repository: the record's head is its HEAD, so the record verdict reads it
  const env = childEnv({ VITEST_MAX_FORKS: "1", GIT_CEILING_DIRECTORIES: dirname(scratch) });
  const command = ["npx", "vitest", "run", "--project", "suite", "--shard=1/2"];
  const shardOf = (logPath: string) => parseRecord(readJson(readFileSync(`${logPath}.record.json`, "utf8")), logPath);

  const planned = await owned("bash", [WRAPPER, join(scratch, "ci/planned.log"), ...command], scratch, env);
  expect(planned.status, `${planned.stdout}${planned.stderr}`).toBe(0);
  expect(contractLines(planned.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=2 recorded=2 defects=0"]);
  expect(verdictLines(planned.stdout)).toEqual(["RECORD_VERDICT verdict=CLEAN files=2 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed"]);
  const plannedRecord = shardOf(join(scratch, "ci/planned.log"));
  expect(plannedRecord.head).toBe(scratchHead(scratch));
  expect(plannedRecord.shard).toEqual({ index: 1, count: 2 });
  expect(plannedRecord.files.map(({ file, state }) => [file, state])).toEqual([[probe("a"), "passed"], [probe("c"), "passed"]]);

  // the planner not loaded (the D-1466 class): the same tree with Vitest's native sequencer, whose sha1 split
  // puts b d — the plan's OTHER equal-size shard — in shard 1. Vitest itself exits 0; the wrapper does not.
  const config = readFileSync(join(scratch, "vitest.config.ts"), "utf8");
  const native = config.replace("sequence: { sequencer: LptSequencer },", "");
  expect(native).not.toBe(config);
  writeFileSync(join(scratch, "vitest.config.ts"), native);
  const swapped = await owned("bash", [WRAPPER, join(scratch, "ci/native.log"), ...command], scratch, env);
  expect(swapped.status, `${swapped.stdout}${swapped.stderr}`).toBe(1);
  expect(readFileSync(join(scratch, "ci/native.log"), "utf8")).toMatch(/Test Files\s+2 passed \(2\)/);
  const swappedRecord = shardOf(join(scratch, "ci/native.log"));
  expect(swappedRecord.shard).toEqual({ index: 1, count: 2 });
  expect(swappedRecord.files.map(({ file, state }) => [file, state])).toEqual([[probe("b"), "passed"], [probe("d"), "passed"]]);
  expect(contractDefects(swapped.stdout)).toEqual([
    { kind: "missing", file: probe("a"), project: "suite" },
    { kind: "missing", file: probe("c"), project: "suite" },
    { kind: "unexpected", file: probe("b"), project: "suite" },
    { kind: "unexpected", file: probe("d"), project: "suite" },
  ]);
  expect(contractLines(swapped.stdout).at(-1)).toBe("SHARD_CONTRACT verdict=RED shard=1/2 planned=2 recorded=2 defects=4");
  // every file and test of the swapped shard passed: the record alone is CLEAN, the set is what reds it
  expect(verdictLines(swapped.stdout)).toEqual(["RECORD_VERDICT verdict=CLEAN files=2 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed"]);
  expect(swapped.stdout).toContain("run-ci-vitest: exit 0 -> 1: record CLEAN (status 0 needs CLEAN) and set contract RED (needs GREEN)");
});

test("test: a sharded RPC-only exit 1 becomes 0 only when its record equals its plan with every file finished with or without a project filter and when a declared project contributes no file to that shard versus a missing unfinished or absent record keeping exit 1", { timeout: 240_000 }, async () => {
  const tree = candidateTree({ suite: 10, tiny: 1 });
  const filtered = ["npm", "run", "test:coverage", "--", "--project", "suite", "--shard=1/2"];
  const RPC_ONLY = "RECORD_VERDICT verdict=RPC_ONLY files=5 tests=5 failed=0 unfinished=0 unhandled=1 rpc=1 reason=passed";

  const green = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([1, 2], suite(SHARD_ONE)) });
  expect(green.status, green.output).toBe(0);
  expect(contractLines(green.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=5 recorded=5 defects=0"]);
  expect(verdictLines(green.stdout)).toEqual([RPC_ONLY]);
  expect(green.stdout).toContain("run-ci-vitest: exit 1 -> 0: record RPC_ONLY and set contract GREEN");
  // the contract asks presence, the record verdict asks pass: a skipped file is forgiven, a failed one is not
  const skipped = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([1, 2], [...suite(["f1", "f2", "f4", "f6"]), ...suite(["f8"], "skipped")]) });
  expect(skipped.status, skipped.output).toBe(0);
  const failed = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([1, 2], [...suite(["f1", "f2", "f4", "f6"]), ...suite(["f8"], "failed")]) });
  expect(failed.status, failed.output).toBe(1);
  expect(contractLines(failed.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=5 recorded=5 defects=0"]);
  expect(verdictLines(failed.stdout)[0]).toMatch(/^RECORD_VERDICT verdict=RED /);

  // no project filter: every project's files are planned — 11 over two shards puts tiny/f1 in shard one
  const unfiltered = ["npx", "vitest", "run", "--shard=1/2"];
  const everyProject = rpcRecordJson([1, 2], [...suite(SHARD_ONE), ["tests/tiny/f1.test.ts", "tiny"]]);
  const whole = await wrap(tree, unfiltered, { log: rpcOnlyLog(6), status: 1, record: everyProject });
  expect(whole.status, whole.output).toBe(0);
  expect(contractLines(whole.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=6 recorded=6 defects=0"]);
  // the same unfiltered shard without its record is never laundered by an RPC-only log (F-r0-3)
  const laundered = await wrap(tree, unfiltered, { log: rpcOnlyLog(3), status: 1 });
  expect(laundered.status, laundered.output).toBe(1);
  expect(contractLines(laundered.stdout)).toEqual(["SHARD_CONTRACT verdict=UNREADABLE shard=1/2 planned=6 recorded=UNREADABLE defects=0"]);
  expect(verdictLines(laundered.stdout)[0]).toMatch(/^RECORD_VERDICT verdict=UNREADABLE /);

  // tiny is declared but contributes no file to shard two: it owes none
  const empty = await wrap(tree, ["npx", "vitest", "run", "--project", "suite", "--project", "tiny", "--shard=2/2"],
    { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([2, 2], suite(SHARD_TWO)) });
  expect(empty.status, empty.output).toBe(0);
  expect(contractLines(empty.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=2/2 planned=5 recorded=5 defects=0"]);

  // versus: a record missing one planned file (the module an RPC timeout stranded), one holding an unfinished
  // file, and an absent record
  const missing = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([1, 2], suite(["f1", "f2", "f4", "f6"])) });
  expect(missing.status, missing.output).toBe(1);
  expect(contractDefects(missing.stdout)).toEqual([{ kind: "missing", file: "tests/suite/f8.test.ts", project: "suite" }]);
  expect(verdictLines(missing.stdout)[0]).toMatch(/^RECORD_VERDICT verdict=RPC_ONLY /);
  expect(missing.stdout).toContain("run-ci-vitest: exit 1 -> 1: record RPC_ONLY (status 1 needs RPC_ONLY) and set contract RED (needs GREEN)");
  for (const state of ["queued", "pending"]) {
    const unfinished = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([1, 2], [...suite(["f1", "f2", "f4", "f6"]), ...suite(["f8"], state)]) });
    expect(unfinished.status, unfinished.output).toBe(1);
    expect(contractDefects(unfinished.stdout)).toEqual([{ kind: "unfinished", file: "tests/suite/f8.test.ts", project: "suite", state }]);
    expect(verdictLines(unfinished.stdout)[0]).toMatch(/^RECORD_VERDICT verdict=RED .* unfinished=2 /);
  }
  // a stale record equal to the plan is removed before the command runs, so a command that writes none is absent
  const stale = join(tree, "stale", "run.log");
  mkdirSync(dirname(stale));
  writeFileSync(`${stale}.record.json`, rpcRecordJson([1, 2], suite(SHARD_ONE)));
  const absent = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, logPath: stale });
  expect(absent.status, absent.output).toBe(1);
  expect(existsSync(`${stale}.record.json`)).toBe(false);
  expect(contractLines(absent.stdout)).toEqual(["SHARD_CONTRACT verdict=UNREADABLE shard=1/2 planned=5 recorded=UNREADABLE defects=0"]);
  // a stale record that cannot be removed stops the wrapper before the command runs, at status 0 and RPC-only 1
  if (process.getuid?.() !== 0) {
    const locked = join(tree, "locked");
    mkdirSync(locked);
    const lockedLog = join(locked, "run.log");
    writeFileSync(lockedLog, "stale log\n");
    writeFileSync(`${lockedLog}.record.json`, rpcRecordJson([1, 2], suite(SHARD_ONE)));
    chmodSync(locked, 0o555);
    try {
      for (const [status, log] of [[0, cleanLog(5)], [1, rpcOnlyLog(5)]] as const) {
        rmSync(join(tree, "seen-record-path"), { force: true });
        const kept = await wrap(tree, filtered, { log, status, logPath: lockedLog });
        expect(kept.status, kept.output).toBe(2);
        expect(kept.stderr).toContain(`run-ci-vitest: cannot remove the stale record ${lockedLog}.record.json; the command was not run`);
        expect(existsSync(join(tree, "seen-record-path"))).toBe(false);
        expect(readFileSync(lockedLog, "utf8")).toBe("stale log\n");
        expect(contractLines(kept.stdout)).toEqual([]);
        expect(verdictLines(kept.stdout)).toEqual([]);
      }
    } finally {
      chmodSync(locked, 0o755);
    }
  }
  // a GREEN contract still needs the record verdict: a CLEAN record at status 1 (no RPC timeout explains the exit)
  // and a record whose unhandled error is not the exact timeout keep 1
  for (const record of [recordJson([1, 2], suite(SHARD_ONE)), recordJson([1, 2], suite(SHARD_ONE), RUN_HEAD, { unhandled: [RPC, { ...RPC, type: "Unhandled Rejection" }] })]) {
    const short = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record });
    expect(short.status, short.output).toBe(1);
    expect(contractLines(short.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=5 recorded=5 defects=0"]);
  }
  // status 0 with the plan's CLEAN record is 0, with its RPC-only record 1; any other status stands without either line
  expect((await wrap(tree, filtered, { log: cleanLog(5), status: 0, record: recordJson([1, 2], suite(SHARD_ONE)) })).status).toBe(0);
  expect((await wrap(tree, filtered, { log: cleanLog(5), status: 0, record: rpcRecordJson([1, 2], suite(SHARD_ONE)) })).status).toBe(1);
  const signalled = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 2, record: rpcRecordJson([1, 2], suite(SHARD_ONE)) });
  expect(signalled.status).toBe(2);
  expect(contractLines(signalled.stdout)).toEqual([]);
  expect(verdictLines(signalled.stdout)).toEqual([]);
});

test("test: a real vitest run of the production configuration writes a record of schema two whose files, reason, unhandled errors and one entry per test case with its full name and state match the run in sorted order, and a second real run whose test-local timer throws after its test ended records that unhandled error with the exact name, message and type the run reported, so a record without the reason, the test entries or that error fails (R-P0 record half)", { timeout: 300_000 }, async () => {
  const scratch = productionScratch({
    "tests/probe/nested.test.ts": `import { describe, test } from "vitest";
describe("outer", () => {
  test("one", () => {});
  describe("inner", () => { test("two", () => {}); });
  test.skip("skipped", () => {});
});
`,
    "tests/probe/fails.test.ts": 'import { test } from "vitest";\ntest("passes", () => {});\ntest("fails", () => { throw new Error("deliberate"); });\n',
    "tests/cli/bin.test.ts": 'import { test } from "vitest";\ntest("bin passes", () => {});\n', // a DIST_COUPLED path: project built-cli
    "tests/timer/late.test.ts": `import { test } from "vitest";
test("leaves a timer", () => { setTimeout(() => { throw new Error("late boom"); }, 20); });
test("waits", async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
`,
  });
  const head = scratchHead(scratch);
  const run = async (name: string, args: readonly string[]) => {
    const path = join(scratch, `${name}.record.json`);
    const result = await owned(process.execPath, [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...args], scratch,
      childEnv({ VITEST_MAX_FORKS: "1", GIT_CEILING_DIRECTORIES: dirname(scratch), TICKMARKR_CI_RECORD: path }));
    const text = readFileSync(path, "utf8");
    return { ...result, log: `${result.stdout}${result.stderr}`, path, text, record: parseRecord(readJson(text), path) };
  };

  const first = await run("first", ["tests/probe", "tests/cli"]);
  expect(first.status, first.log).toBe(1);
  // what the run itself printed: one failed file of three, one failed test, four passed and one skipped
  expect(first.log).toMatch(/Test Files\s+1 failed \| 2 passed \(3\)/);
  expect(first.log).toMatch(/Tests\s+1 failed \| 4 passed \| 1 skipped \(6\)/);
  expect(first.text.endsWith("\n") && !first.text.slice(0, -1).includes("\n")).toBe(true);
  expect(Object.keys(JSON.parse(first.text) as object)).toEqual(["schema", "head", "shard", "files", "reason", "unhandled", "tests"]);
  const { files, ...rest } = first.record;
  expect(rest).toEqual({
    schema: "tickmarkr-ci-record/2", head, shard: null, reason: "failed", unhandled: [],
    tests: [ // sorted by file, then project, then full name
      { file: "tests/cli/bin.test.ts", project: "built-cli", name: "bin passes", state: "passed" },
      { file: "tests/probe/fails.test.ts", project: "suite", name: "fails", state: "failed" },
      { file: "tests/probe/fails.test.ts", project: "suite", name: "passes", state: "passed" },
      { file: "tests/probe/nested.test.ts", project: "suite", name: "outer > inner > two", state: "passed" },
      { file: "tests/probe/nested.test.ts", project: "suite", name: "outer > one", state: "passed" },
      { file: "tests/probe/nested.test.ts", project: "suite", name: "outer > skipped", state: "skipped" },
    ],
  });
  expect(files.map(({ file, project, state }) => ({ file, project, state }))).toEqual([
    { file: "tests/cli/bin.test.ts", project: "built-cli", state: "passed" },
    { file: "tests/probe/fails.test.ts", project: "suite", state: "failed" },
    { file: "tests/probe/nested.test.ts", project: "suite", state: "passed" },
  ]);

  // the timer fires after "leaves a timer" ended, while its file still runs: Vitest reports it as an unhandled
  // error under its own banner, and the record holds that error's exact name, whole message and type
  const late = await run("late", ["tests/timer"]);
  expect(late.status, late.log).toBe(1);
  const reported = /Vitest caught 1 unhandled error during the test run\.[\s\S]*?\n⎯+ (.+?) ⎯+\n([^\n]+)\n/.exec(late.log);
  expect(reported, late.log).not.toBeNull();
  expect(late.record.unhandled).toEqual([{ name: "Error", message: "late boom", type: reported![1] }]);
  expect(`${late.record.unhandled[0]!.name}: ${late.record.unhandled[0]!.message}`).toBe(reported![2]);
  expect(late.record.reason).toBe("passed"); // an unhandled error alone never moves the reason
  expect(late.record.tests.map(({ name, state }) => [name, state])).toEqual([["leaves a timer", "passed"], ["waits", "passed"]]);

  // a record without its reason, its test entries or its unhandled errors is another document: unreadable
  const doc = JSON.parse(late.text) as Record<string, unknown>;
  for (const key of ["reason", "tests", "unhandled"]) {
    const { [key]: _dropped, ...without } = doc;
    expect(() => parseRecord(without, key), key).toThrow(expect.objectContaining({ name: "RecordError" }));
  }
  // and the error entry is what reds this run: the same record with it removed reads CLEAN
  const verdictOf = async (text: string, name: string) => {
    writeFileSync(join(scratch, name), text);
    return (await owned(TSX, [CLI, "verdict", join(scratch, name)], scratch, childEnv())).stdout.trimEnd().split("\n").at(-1);
  };
  expect(await verdictOf(late.text, "as-recorded.json")).toBe("RECORD_VERDICT verdict=RED files=1 tests=2 failed=0 unfinished=0 unhandled=1 rpc=0 reason=passed");
  expect(await verdictOf(`${JSON.stringify({ ...doc, unhandled: [] })}\n`, "erased.json")).toBe("RECORD_VERDICT verdict=CLEAN files=1 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed");
});

test("test: the public CI wrapper follows the status-versus-record table, exiting zero at status zero only for a CLEAN record with a green set and at status one only for an RPC only record with a green set whose files all passed or skipped, even when tests printed timeout or summary text, and exiting one for a complete RED, unfinished or interrupted record at status zero, a CLEAN record at status one, an absent record, a declared project that collected no file and an RPC timeout's missing stranded module, printing the record verdict line and the set contract's verdict line each time, where the declared projects are the projects Vitest itself selects for the invocation's --project values, a wildcard, a negation or another letter case included, so a complete passing run selected that way reads its set GREEN, while any other status returns as it came (R-P1 R-P2 R-P3 R-P4 R-F5 R-F6 R-F7 R-F15)", { timeout: 300_000 }, async () => {
  const tree = candidateTree({ suite: 10, tiny: 2, empty: 0 });
  const command = ["npm", "run", "test:coverage", "--", "--project", "suite"];
  const names = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"];
  const all = suite(names);
  // what tests may print: Vitest's own timeout and summary wording, which no rule reads any more
  const printed = "stdout | tests/suite/f1.test.ts > prints\nError: Test timed out in 5000ms.\n Test Files  3 passed (3)\n      Tests  1 failed (1)\n";
  const table = async (o: { status: number; record?: string; log?: string; args?: readonly string[] }, exit: number, verdict: string, contract: string) => {
    const run = await wrap(tree, o.args ?? command, { log: o.log ?? (o.status === 1 ? rpcOnlyLog(10) : cleanLog(10)) + printed, status: o.status, record: o.record });
    expect(run.status, run.output).toBe(exit);
    expect(verdictLines(run.stdout), run.output).toHaveLength(1);
    expect(contractLines(run.stdout).filter((line) => line.startsWith("SHARD_CONTRACT verdict=")), run.output).toHaveLength(1);
    expect(verdictLines(run.stdout)[0]).toMatch(new RegExp(`^RECORD_VERDICT verdict=${verdict} `));
    expect(contractLines(run.stdout).at(-1)).toMatch(new RegExp(`^SHARD_CONTRACT verdict=${contract} shard=`));
    return run;
  };

  // R-P1: status 0, a CLEAN record, the set GREEN — and the command alone was handed the record path as a prefix
  const clean = await table({ status: 0, record: recordJson(null, all) }, 0, "CLEAN", "GREEN");
  expect(contractLines(clean.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=none planned=10 recorded=10 defects=0"]);
  expect(readFileSync(join(tree, "seen-record-path"), "utf8")).toBe(`${clean.logPath}.record.json`);
  expect(clean.stdout).toContain("run-ci-vitest: exit 0 -> 0: record CLEAN and set contract GREEN");
  // R-P2: status 1, only exact RPC timeouts, the set GREEN and every file passed or skipped
  const rpc = await table({ status: 1, record: rpcRecordJson(null, [...suite(names.slice(0, 9)), ...suite(["f10"], "skipped")]) }, 0, "RPC_ONLY", "GREEN");
  expect(rpc.stdout).toContain("run-ci-vitest: exit 1 -> 0: record RPC_ONLY and set contract GREEN");
  // both forms, the single-fork form's every declared project owning files
  await table({ status: 1, record: rpcRecordJson(null, [...all, ["tests/tiny/f1.test.ts", "tiny"], ["tests/tiny/f2.test.ts", "tiny"]]), args: ["npx", "vitest", "run", "--project", "suite", "--project=tiny"] }, 0, "RPC_ONLY", "GREEN");

  // status 0 takes CLEAN only: a failed, unfinished or interrupted record, and an RPC-only one
  await table({ status: 0, record: recordJson(null, [...suite(names.slice(0, 9)), ...suite(["f10"], "failed")]) }, 1, "RED", "GREEN");
  for (const state of ["queued", "pending"]) await table({ status: 0, record: recordJson(null, [...suite(names.slice(0, 9)), ...suite(["f10"], state)]) }, 1, "RED", "RED");
  await table({ status: 0, record: recordJson(null, all, RUN_HEAD, { reason: "interrupted" }) }, 1, "RED", "GREEN");
  await table({ status: 0, record: rpcRecordJson(null, all) }, 1, "RPC_ONLY", "GREEN");
  // status 1 takes RPC_ONLY only: a CLEAN record, a failed file beside the timeout, another unhandled error
  const unexplained = await table({ status: 1, record: recordJson(null, all) }, 1, "CLEAN", "GREEN");
  expect(unexplained.stdout).toContain("run-ci-vitest: exit 1 -> 1: record CLEAN (status 1 needs RPC_ONLY) and set contract GREEN (needs GREEN)");
  await table({ status: 1, record: rpcRecordJson(null, [...suite(names.slice(0, 9)), ...suite(["f10"], "failed")]) }, 1, "RED", "GREEN");
  await table({ status: 1, record: recordJson(null, all, RUN_HEAD, { unhandled: [RPC, { name: "TypeError", message: "boom", type: "Unhandled Error" }] }) }, 1, "RED", "GREEN");
  // R-F5: no record — Vitest killed before onTestRunEnd at status 1, and status 0 with the record gone
  for (const status of [0, 1]) await table({ status }, 1, "UNREADABLE", "UNREADABLE");
  // R-F6: a declared project that collected no file — the record lacks tiny's files, or discovery finds none for empty
  const tinyLess = await table({ status: 0, record: recordJson(null, all), args: ["npx", "vitest", "run", "--project", "suite", "--project", "tiny"] }, 1, "CLEAN", "RED");
  expect(contractDefects(tinyLess.stdout)).toEqual([
    { kind: "missing", file: "tests/tiny/f1.test.ts", project: "tiny" }, { kind: "missing", file: "tests/tiny/f2.test.ts", project: "tiny" },
  ]);
  const emptyProject = await table({ status: 0, record: recordJson(null, all), args: ["npx", "vitest", "run", "--project", "suite", "--project", "empty"] }, 1, "CLEAN", "RED");
  expect(contractDefects(emptyProject.stdout)).toEqual([{ kind: "empty-project", project: "empty" }]);
  // R-F15: an RPC timeout's stranded module is absent from the record, so the record alone reads RPC_ONLY
  for (const kept of [names.filter((name) => name !== "f7"), names.slice(0, 7)]) {
    const stranded = await table({ status: 1, record: rpcRecordJson(null, suite(kept)) }, 1, "RPC_ONLY", "RED");
    expect(contractDefects(stranded.stdout).map((defect) => (defect as { kind: string }).kind)).toEqual(Array(10 - kept.length).fill("missing"));
  }
  // a command outside the closed grammar (here a positional filter) has no set contract it could meet
  await table({ status: 0, record: recordJson(null, all), args: [...command, "tests/suite/f1.test.ts"] }, 1, "CLEAN", "UNREADABLE");

  // R-F7: any other status returns as it came, with neither line
  for (const status of [2, 137]) {
    const other = await wrap(tree, command, { log: cleanLog(10), status, record: recordJson(null, all) });
    expect(other.status, other.output).toBe(status);
    expect([verdictLines(other.stdout), contractLines(other.stdout)]).toEqual([[], []]);
  }
  // a log whose parent directory does not exist is created before tee
  const deep = join(tree, "missing", "a", "b", "ci.log");
  expect(existsSync(dirname(deep))).toBe(false);
  const created = await wrap(tree, command, { log: cleanLog(10), status: 0, logPath: deep, record: recordJson(null, all) });
  expect(created.status, created.output).toBe(0);
  expect(readFileSync(deep, "utf8")).toBe(cleanLog(10));

  // R-P3 and R-P4 through real Vitest and real discovery: a passing test prints Vitest's timeout wording to stdout
  // and to an inherited fd, and a file summary; the production config carries no console filter (queue row 148, deleted v2.8.2 T2)
  const scratch = productionScratch({
    "tests/probe/prints.test.ts": `import { spawnSync } from "node:child_process";
import { test } from "vitest";
test("prints Vitest's own wording", () => {
  console.log("Error: Test timed out in 5000ms.");
  console.log(" Test Files  1 passed (1)");
  spawnSync("sh", ["-c", "echo 'Error: Test timed out in 5000ms.'; echo ' Test Files  1 passed (1)' >&2"], { stdio: "inherit" });
});
`,
    "tests/probe/plain.test.ts": 'import { test } from "vitest";\ntest("plain", () => {});\n',
  });
  const real = await owned("bash", [WRAPPER, join(scratch, "ci/real.log"), "npx", "vitest", "run", "--project", "suite"], scratch,
    childEnv({ VITEST_MAX_FORKS: "1", GIT_CEILING_DIRECTORIES: dirname(scratch) }));
  expect(real.status, `${real.stdout}${real.stderr}`).toBe(0);
  expect(readFileSync(join(scratch, "ci/real.log"), "utf8")).toContain("Error: Test timed out in 5000ms.");
  expect(verdictLines(real.stdout)).toEqual(["RECORD_VERDICT verdict=CLEAN files=2 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed"]);
  expect(contractLines(real.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=none planned=2 recorded=2 defects=0"]);

  // a --project selector owns what Vitest selects (a wildcard, every project, a negation, any case), so through
  // real discovery each complete CLEAN status-0 and RPC-only status-1 run passes, while a wildcard that selects no
  // discovered file beside one that does is an empty project; a stand-in npm writes the record and exits the status
  const bin = join(scratch, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), '#!/usr/bin/env bash\ncp "$FAKE_RECORD_SRC" "$TICKMARKR_CI_RECORD"; exit "$FAKE_RUN_STATUS"\n');
  chmodSync(join(bin, "npm"), 0o755);
  const probes: Entry[] = [["tests/probe/plain.test.ts", "suite"], ["tests/probe/prints.test.ts", "suite"]];
  let selected = 0;
  const select = async (projects: readonly string[], status: number, record: string) => {
    const source = join(scratch, `selected-${selected}.record.json`);
    writeFileSync(source, record);
    const run = await owned("bash", [WRAPPER, join(scratch, `ci/selected-${selected++}.log`), "npm", "run", "test:coverage", "--", ...projects.flatMap((p) => ["--project", p])], scratch,
      childEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_RECORD_SRC: source, FAKE_RUN_STATUS: String(status), GIT_CEILING_DIRECTORIES: dirname(scratch) }));
    return { ...run, output: `${run.stdout}${run.stderr}` };
  };
  for (const selector of ["suite*", "*", "!other", "SUITE"]) {
    for (const [status, record, verdict] of [[0, recordJson(null, probes), "CLEAN"], [1, rpcRecordJson(null, probes), "RPC_ONLY"]] as const) {
      const run = await select([selector], status, record);
      expect(run.status, `${selector} at ${status}\n${run.output}`).toBe(0);
      expect(verdictLines(run.stdout)[0]).toMatch(new RegExp(`^RECORD_VERDICT verdict=${verdict} `));
      expect(contractLines(run.stdout), selector).toEqual(["SHARD_CONTRACT verdict=GREEN shard=none planned=2 recorded=2 defects=0"]);
    }
  }
  const unselected = await select(["suite", "other*"], 0, recordJson(null, probes));
  expect(unselected.status, unselected.output).toBe(1);
  expect(contractDefects(unselected.stdout)).toEqual([{ kind: "empty-project", project: "other*" }]);
});

test("test: the set oracle reads GREEN only when every tracked test file appears once finished on this HEAD and names a duplicate beside a missing file at an equal total, an unknown, an unfinished, a wrong head and an unreadable record, keeping a tracked path holding U+2028 as one entry, versus a count-only comparison", { timeout: 240_000 }, async () => {
  const repo = scratchDir("ci-oracle-repo-");
  const records = scratchDir("ci-oracle-records-");
  const separated = "tests/line separated.test.ts";
  for (const file of ["tests/a.test.ts", "tests/sub/b.test.ts", separated, "tests/helper.ts", "src/x.test.ts"]) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "");
  }
  const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(repo) });
  const git = (...args: string[]) => execFileP("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env });
  await git("init", "-q");
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();

  let n = 0;
  const assert = async (texts: readonly string[], cwd = repo) => {
    const paths = texts.map((text) => {
      const path = join(records, `r${n++}.record.json`);
      writeFileSync(path, text);
      return path;
    });
    const run = await owned(TSX, [CLI, "assert", ...paths], cwd, env);
    const lines = run.stdout.split("\n").slice(0, -1);
    return { status: run.status, lines, last: lines.at(-1), paths, stderr: run.stderr,
      defects: lines.filter((line) => line.startsWith("SET_ORACLE_DEFECT ")).map((line) => readJson(line.slice("SET_ORACLE_DEFECT ".length))) };
  };

  // the manifest is the three tracked tests/**/*.test.ts files: presence, not pass, across any number of records
  const green = await assert([
    recordJson([1, 2], [["tests/a.test.ts", "suite", "passed"], ["tests/sub/b.test.ts", "suite", "failed"]], head),
    `${JSON.stringify({ schema: "tickmarkr-ci-record/2", head, shard: null, files: [{ file: separated, project: "built-cli", state: "skipped", durationMs: 4 }], reason: "passed", unhandled: [], tests: [] })}\n`,
  ]);
  expect(green.status, green.stderr).toBe(0);
  expect(green.lines).toEqual(["SET_ORACLE verdict=GREEN expected=3 actual=3 defects=0"]);

  // a duplicate beside a missing file at an equal total: a count-only comparison reads 3 = 3 and passes
  const swapped = await assert([recordJson([1, 2], [["tests/a.test.ts", "suite"], ["tests/sub/b.test.ts", "suite"]], head), recordJson([2, 2], [["tests/a.test.ts", "suite"]], head)]);
  expect(swapped.status).toBe(1);
  expect(swapped.last).toBe("SET_ORACLE verdict=RED expected=3 actual=3 defects=2");
  expect(swapped.defects).toEqual([{ kind: "duplicate", file: "tests/a.test.ts", count: 2 }, { kind: "missing", file: separated }]);
  // the U+2028 path is one manifest entry and one escaped output line
  expect(swapped.lines).toHaveLength(3);
  expect(swapped.lines.join("\n")).not.toContain(" ");
  expect(swapped.lines.join("\n")).toContain("\\u2028");

  const complete = (state = "passed"): Entry[] => [["tests/a.test.ts", "suite"], ["tests/sub/b.test.ts", "suite", state], [separated, "suite"]];
  const unknown = await assert([recordJson(null, [...complete(), ["tests/zzz.test.ts", "suite"]], head)]);
  expect([unknown.status, unknown.last]).toEqual([1, "SET_ORACLE verdict=RED expected=3 actual=4 defects=1"]);
  expect(unknown.defects).toEqual([{ kind: "unknown", source: unknown.paths[0], file: "tests/zzz.test.ts", project: "suite" }]);

  const unfinished = await assert([recordJson(null, complete("pending"), head)]);
  expect([unfinished.status, unfinished.last]).toEqual([1, "SET_ORACLE verdict=RED expected=3 actual=3 defects=1"]);
  expect(unfinished.defects).toEqual([{ kind: "unfinished", source: unfinished.paths[0], file: "tests/sub/b.test.ts", project: "suite", state: "pending" }]);

  for (const wrong of ["0".repeat(40), null]) {
    const stale = await assert([recordJson(null, complete(), wrong)]);
    expect([stale.status, stale.last]).toEqual([1, "SET_ORACLE verdict=RED expected=3 actual=3 defects=1"]);
    expect(stale.defects).toEqual([{ kind: "wrong-head", source: stale.paths[0], head: wrong, expected: head }]);
  }

  // an unreadable record (malformed, a repeated key, absent) leaves the actual set unknowable
  const unreadable = await assert([recordJson(null, complete(), head), "{", recordJson(null, complete(), head).replace('"head"', '"head":null,"head"')]);
  const absentPath = join(records, "absent.record.json");
  const absent = await owned(TSX, [CLI, "assert", absentPath], repo, env);
  expect(unreadable.status).toBe(2);
  expect(unreadable.last).toBe("SET_ORACLE verdict=UNREADABLE expected=3 actual=UNREADABLE defects=2");
  expect(unreadable.defects.map((defect) => `${(defect as { kind: string }).kind} ${(defect as { source: string }).source}`).sort())
    .toEqual([`unreadable ${unreadable.paths[1]}`, `unreadable ${unreadable.paths[2]}`].sort());
  expect(absent.status).toBe(2);
  expect(absent.stdout).toMatch(/^SET_ORACLE_DEFECT \{"kind":"unreadable","source":".*absent\.record\.json".*\nSET_ORACLE verdict=UNREADABLE expected=3 actual=UNREADABLE defects=1\n$/);
  // outside a repository the manifest itself is unknowable
  const outside = await assert([recordJson(null, complete(), head)], records);
  expect([outside.status, outside.last]).toEqual([2, "SET_ORACLE verdict=UNREADABLE expected=UNREADABLE actual=UNREADABLE defects=0"]);
});

test("test: a positional filter, a second shard argument, a shard value with a leading zero or a third slash component or an index above its count, and any other flag make a sharded contract UNREADABLE with an argv defect and keep exit 1, as do a record whose shard differs from the argument and a discovery entry without a project, versus the space and equals spellings of the project and shard arguments being planned", { timeout: 240_000 }, async () => {
  const tree = candidateTree({ suite: 10 });
  const planRecord = recordJson([1, 2], suite(SHARD_ONE));
  // status 0 and a record equal to the plan of --project suite --shard=1/2: only the argv decides
  for (const [args, token] of [
    [["--project", "suite", "--shard=1/2", "tests/suite/f1.test.ts"], "tests/suite/f1.test.ts"],
    [["--project", "suite", "--shard=1/2", "--shard=2/2"], "--shard=2/2"],
    [["--project", "suite", "--shard=01/2"], "--shard=01/2"],
    [["--project", "suite", "--shard", "1/2/3"], "--shard 1/2/3"],
    [["--project", "suite", "--shard=3/2"], "--shard=3/2"],
    [["--project", "suite", "--shard=1/2", "--bail=1"], "--bail=1"],
  ] as const) {
    for (const prefix of [["npm", "run", "test:coverage", "--"], ["npx", "vitest", "run"]]) {
      const run = await wrap(tree, [...prefix, ...args], { log: cleanLog(5), status: 0, record: planRecord });
      expect(run.status, `${args.join(" ")}\n${run.output}`).toBe(1);
      expect(contractDefects(run.stdout), args.join(" ")).toEqual([expect.objectContaining({ kind: "argv", token })]);
      expect(contractLines(run.stdout).at(-1)).toBe("SHARD_CONTRACT verdict=UNREADABLE shard=UNREADABLE planned=UNREADABLE recorded=UNREADABLE defects=1");
      expect(run.stdout).toContain("run-ci-vitest: exit 0 -> 1: record CLEAN (status 0 needs CLEAN) and set contract UNREADABLE (needs GREEN)");
    }
  }
  // the same at an RPC-only exit 1, and a sharded command outside both forms
  const rpcFilter = await wrap(tree, ["npx", "vitest", "run", "--project", "suite", "--shard=1/2", "tests/suite"], { log: rpcOnlyLog(5), status: 1, record: rpcRecordJson([1, 2], suite(SHARD_ONE)) });
  expect(rpcFilter.status, rpcFilter.output).toBe(1);
  expect(rpcFilter.stdout).toContain("run-ci-vitest: exit 1 -> 1: record RPC_ONLY (status 1 needs RPC_ONLY) and set contract UNREADABLE (needs GREEN)");
  for (const [command, token] of [
    [["npx", "vitest", "--project", "suite", "--shard=1/2"], "--project"],
    [["npm", "run", "test", "--", "--project", "suite", "--shard=1/2"], "test"],
    // the npm form without its `--` delimiter never borrows the npx form's length
    [["npm", "run", "test:coverage", "--shard=1/2"], "--shard=1/2"],
    [["npm", "run", "test:coverage", "--project", "suite", "--shard", "1/2"], "--project"],
  ] as const) {
    const otherForm = await wrap(tree, command, { log: cleanLog(5), status: 0, record: planRecord });
    expect(otherForm.status, otherForm.output).toBe(1);
    expect(contractDefects(otherForm.stdout)).toEqual([expect.objectContaining({ kind: "argv", token })]);
    expect(contractLines(otherForm.stdout).at(-1)).toBe("SHARD_CONTRACT verdict=UNREADABLE shard=UNREADABLE planned=UNREADABLE recorded=UNREADABLE defects=1");
  }

  // a record whose shard differs from the argument (or is no shard at all)
  for (const shard of [[2, 2], [1, 3], null] as const) {
    const run = await wrap(tree, ["npm", "run", "test:coverage", "--", "--project", "suite", "--shard=1/2"], { log: cleanLog(5), status: 0, record: recordJson(shard, suite(SHARD_ONE)) });
    expect(run.status, run.output).toBe(1);
    expect(contractDefects(run.stdout)).toEqual([{ kind: "shard-mismatch", expected: "1/2", recorded: shard && `${shard[0]}/${shard[1]}` }]);
    expect(contractLines(run.stdout).at(-1)).toBe("SHARD_CONTRACT verdict=UNREADABLE shard=1/2 planned=5 recorded=5 defects=1");
  }
  // a discovery entry without a project, or outside the root, leaves the plan unknowable
  for (const defect of ["no-project", "outside"]) {
    const run = await wrap(tree, ["npm", "run", "test:coverage", "--", "--project", "suite", "--shard=1/2"], { log: cleanLog(5), status: 0, record: planRecord, env: { FAKE_LIST_DEFECT: defect } });
    expect(run.status, run.output).toBe(1);
    expect(contractLines(run.stdout)).toEqual(["SHARD_CONTRACT verdict=UNREADABLE shard=1/2 planned=UNREADABLE recorded=UNREADABLE defects=0"]);
    expect(run.stderr).toMatch(defect === "no-project" ? /has no projectName/ : /lies outside/);
  }

  // versus every spelling of the project and shard arguments: planned and GREEN, at status 0 and RPC-only 1
  for (const args of [
    ["--project", "suite", "--shard", "1/2"], ["--project=suite", "--shard=1/2"], ["--shard", "1/2", "--project=suite"], ["--shard=1/2", "--project", "suite"],
  ]) {
    for (const [status, log, record] of [[0, cleanLog(5), planRecord], [1, rpcOnlyLog(5), rpcRecordJson([1, 2], suite(SHARD_ONE))]] as const) {
      const run = await wrap(tree, ["npm", "run", "test:coverage", "--", ...args], { log, status, record });
      expect(run.status, `${args.join(" ")}\n${run.output}`).toBe(0);
      expect(contractLines(run.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=5 recorded=5 defects=0"]);
    }
  }
});
