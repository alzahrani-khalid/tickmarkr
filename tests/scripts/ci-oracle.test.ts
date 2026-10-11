// v2.7.8 T3 acceptance — a shard is held to its plan as a set, and each OS to its manifest
// (specs/v2.7.8-sharded-ci.spec.md). Every wrapper case runs THIS checkout's scripts/run-ci-vitest.sh in a
// candidate tree, as CI does. Real Vitest runs only where the criterion says real production-config (a
// scratch copy of the production configuration that copies the WHOLE scripts/ directory); the rest use PATH
// stubs of npx and npm (the seam tests/scripts/grade-ci.test.ts uses) and a scratch git repository.
import { execFile } from "node:child_process";
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

/** The child environment: no inherited Vitest, record, lean-reporter or git-location variables. */
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("VITEST") && !key.startsWith("GIT_") && key !== "TICKMARKR_CI_RECORD" && key !== "TICKMARKR_CI_LEAN_REPORTERS")),
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

type Entry = readonly [file: string, project: string, state?: string];
const recordJson = (shard: readonly [number, number] | null, files: readonly Entry[], head: string | null = null): string =>
  `${JSON.stringify({
    schema: "tickmarkr-ci-record/1", head, shard: shard && { index: shard[0], count: shard[1] },
    files: files.map(([file, project, state = "passed"]) => ({ file, project, state, durationMs: 1 })),
  })}\n`;

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
        lines+=("[$p] $f")
        case "\${FAKE_LIST_DEFECT:-}" in
          no-project) entries+=("{\\"file\\":\\"$PWD/$f\\"}") ;;
          outside) entries+=("{\\"file\\":\\"$(dirname "$PWD")/$f\\",\\"projectName\\":\\"$p\\"}") ;;
          *) entries+=("{\\"file\\":\\"$PWD/$f\\",\\"projectName\\":\\"$p\\"}") ;;
        esac
      done
    done
    if [ -n "$json" ]; then (IFS=,; printf '[%s]\\n' "\${entries[*]}") > "$json"; else printf '%s\\n' "\${lines[@]}"; fi ;;
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

/** A scratch copy of the production configuration (whole scripts/, the real setup file) over `fixtures`. */
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
  return scratch;
}

test("test: the production wrapper holds a real production-config shard to its plan as a set exiting 0 when its record equals the plan while a status-0 run whose record holds the other equal-size shard's files exits 1 naming each missing and unexpected file", { timeout: 300_000 }, async () => {
  const probe = (name: string) => `tests/probe/${name}.test.ts`;
  const names = ["a", "b", "c", "d"];
  const scratch = productionScratch(Object.fromEntries(names.map((name) =>
    [probe(name), `import { test } from "vitest";\ntest(${JSON.stringify(name)}, () => {});\n`])));
  // the committed empty durations seed: every file weighs 1, so the plan is a c | b d
  expect(lptShards(names.map((name) => ({ file: probe(name), project: "suite" })), {}, 2).map((shard) => shard.map((item) => item.file)))
    .toEqual([[probe("a"), probe("c")], [probe("b"), probe("d")]]);
  // the scratch is no repository: git discovery stops at it, so the record's head is null and no lease is keyed
  const env = childEnv({ VITEST_MAX_FORKS: "1", GIT_CEILING_DIRECTORIES: dirname(scratch) });
  const command = ["npx", "vitest", "run", "--project", "suite", "--shard=1/2"];
  const shardOf = (logPath: string) => parseRecord(readJson(readFileSync(`${logPath}.record.json`, "utf8")), logPath);

  const planned = await owned("bash", [WRAPPER, join(scratch, "ci/planned.log"), ...command], scratch, env);
  expect(planned.status, `${planned.stdout}${planned.stderr}`).toBe(0);
  expect(contractLines(planned.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=2 recorded=2 defects=0"]);
  const plannedRecord = shardOf(join(scratch, "ci/planned.log"));
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
  expect(swapped.stdout).toContain("run-ci-vitest: exit 0 -> 1: the shard contract is not GREEN");
});

test("test: a sharded RPC-only exit 1 becomes 0 only when its record equals its plan with every file finished with or without a project filter and when a declared project contributes no file to that shard versus a missing unfinished or absent record keeping exit 1", { timeout: 240_000 }, async () => {
  const tree = candidateTree({ suite: 10, tiny: 1 });
  const filtered = ["npm", "run", "test:coverage", "--", "--project", "suite", "--shard=1/2"];

  const green = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: recordJson([1, 2], suite(SHARD_ONE)) });
  expect(green.status, green.output).toBe(0);
  expect(contractLines(green.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=5 recorded=5 defects=0"]);
  expect(green.stdout).toContain("run-ci-vitest: shard contract GREEN: 5 planned files");
  expect(green.stdout).toContain("run-ci-vitest: exit 1 -> 0, every unhandled error is a vitest-worker RPC timeout: VITEST_LOG verdict=RPC_ONLY");
  // presence, not pass: a failed or skipped file is finished
  const finished = recordJson([1, 2], [...suite(["f1", "f2", "f4"]), ...suite(["f6"], "failed"), ...suite(["f8"], "skipped")]);
  expect((await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: finished })).status).toBe(0);

  // no project filter: every project's files are planned — 11 over two shards puts tiny/f1 in shard one
  const unfiltered = ["npx", "vitest", "run", "--shard=1/2"];
  const everyProject = recordJson([1, 2], [...suite(SHARD_ONE), ["tests/tiny/f1.test.ts", "tiny"]]);
  const whole = await wrap(tree, unfiltered, { log: rpcOnlyLog(6), status: 1, record: everyProject });
  expect(whole.status, whole.output).toBe(0);
  expect(contractLines(whole.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=6 recorded=6 defects=0"]);
  // the same unfiltered shard without its record is never laundered by a short RPC-only log (F-r0-3)
  const laundered = await wrap(tree, unfiltered, { log: rpcOnlyLog(3), status: 1 });
  expect(laundered.status, laundered.output).toBe(1);
  expect(contractLines(laundered.stdout)).toEqual(["SHARD_CONTRACT verdict=UNREADABLE shard=1/2 planned=6 recorded=UNREADABLE defects=0"]);

  // tiny is declared but contributes no file to shard two: it owes none
  const empty = await wrap(tree, ["npx", "vitest", "run", "--project", "suite", "--project", "tiny", "--shard=2/2"],
    { log: rpcOnlyLog(5), status: 1, record: recordJson([2, 2], suite(SHARD_TWO)) });
  expect(empty.status, empty.output).toBe(0);
  expect(contractLines(empty.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=2/2 planned=5 recorded=5 defects=0"]);

  // versus: a record missing one planned file, one holding an unfinished file, and an absent record
  const missing = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: recordJson([1, 2], suite(["f1", "f2", "f4", "f6"])) });
  expect(missing.status, missing.output).toBe(1);
  expect(contractDefects(missing.stdout)).toEqual([{ kind: "missing", file: "tests/suite/f8.test.ts", project: "suite" }]);
  expect(missing.stdout).toContain("run-ci-vitest: exit 1 kept: the shard contract is not GREEN");
  for (const state of ["queued", "pending"]) {
    const unfinished = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 1, record: recordJson([1, 2], [...suite(["f1", "f2", "f4", "f6"]), ...suite(["f8"], state)]) });
    expect(unfinished.status, unfinished.output).toBe(1);
    expect(contractDefects(unfinished.stdout)).toEqual([{ kind: "unfinished", file: "tests/suite/f8.test.ts", project: "suite", state }]);
  }
  // a stale record equal to the plan is removed before the command runs, so a command that writes none is absent
  const stale = join(tree, "stale", "run.log");
  mkdirSync(dirname(stale));
  writeFileSync(`${stale}.record.json`, recordJson([1, 2], suite(SHARD_ONE)));
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
    writeFileSync(`${lockedLog}.record.json`, recordJson([1, 2], suite(SHARD_ONE)));
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
      }
    } finally {
      chmodSync(locked, 0o755);
    }
  }
  // a GREEN contract still needs the classifier to pass the log at the planned count: four of five collected
  const short = await wrap(tree, filtered, { log: rpcOnlyLog(4), status: 1, record: recordJson([1, 2], suite(SHARD_ONE)) });
  expect(short.status, short.output).toBe(1);
  expect(short.stdout).toContain("run-ci-vitest: exit 1 kept: VITEST_LOG verdict=RED reason=partial");
  // status 0 with the plan's record is 0; any other status stands without a contract
  expect((await wrap(tree, filtered, { log: cleanLog(5), status: 0, record: recordJson([1, 2], suite(SHARD_ONE)) })).status).toBe(0);
  const signalled = await wrap(tree, filtered, { log: rpcOnlyLog(5), status: 2, record: recordJson([1, 2], suite(SHARD_ONE)) });
  expect(signalled.status).toBe(2);
  expect(contractLines(signalled.stdout)).toEqual([]);
});

test("test: an unsharded invocation keeps the count contract through the new wrapper so a ten-of-ten RPC-only run exits 0 while seven of ten keeps exit 1 whatever its record holds, and a log whose parent directory does not exist is created before tee", { timeout: 240_000 }, async () => {
  const tree = candidateTree({ suite: 10 });
  const command = ["npm", "run", "test:coverage", "--", "--project", "suite"];
  const all = recordJson(null, suite(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"]));

  const ten = await wrap(tree, command, { log: rpcOnlyLog(10), status: 1, record: all });
  expect(ten.status, ten.output).toBe(0);
  expect(ten.stdout).toContain("run-ci-vitest: declared contract: 10 files across suite");
  expect(ten.stdout).toContain("run-ci-vitest: exit 1 -> 0");
  expect(contractLines(ten.stdout)).toEqual([]);
  // the command — and only the command — was handed the record path as a prefix
  expect(readFileSync(join(tree, "seen-record-path"), "utf8")).toBe(`${ten.logPath}.record.json`);

  for (const record of [all, recordJson(null, suite(["f1", "f2", "f3", "f4", "f5", "f6", "f7"])), undefined]) {
    for (const total of [7, 10]) {
      const seven = await wrap(tree, command, { log: rpcOnlyLog(7, total), status: 1, record });
      expect(seven.status, seven.output).toBe(1);
      expect(seven.stdout).toContain("run-ci-vitest: exit 1 kept: VITEST_LOG verdict=RED reason=partial");
      expect(contractLines(seven.stdout)).toEqual([]);
    }
  }
  // outside exit 1 the command's own status stands, as at the base
  expect((await wrap(tree, command, { log: cleanLog(10), status: 0 })).status).toBe(0);
  expect((await wrap(tree, command, { log: rpcOnlyLog(7), status: 2 })).status).toBe(2);

  const deep = join(tree, "missing", "a", "b", "ci.log");
  expect(existsSync(dirname(deep))).toBe(false);
  const created = await wrap(tree, command, { log: cleanLog(10), status: 0, logPath: deep });
  expect(created.status, created.output).toBe(0);
  expect(readFileSync(deep, "utf8")).toBe(cleanLog(10));
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
    `${JSON.stringify({ schema: "tickmarkr-ci-record/1", head, shard: null, files: [{ file: separated, project: "built-cli", state: "skipped", durationMs: 4 }] })}\n`,
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
      expect(run.stdout).toContain("run-ci-vitest: exit 0 -> 1: the shard contract is not GREEN");
    }
  }
  // the same at an RPC-only exit 1, and a sharded command outside both forms
  const rpcFilter = await wrap(tree, ["npx", "vitest", "run", "--project", "suite", "--shard=1/2", "tests/suite"], { log: rpcOnlyLog(5), status: 1, record: planRecord });
  expect(rpcFilter.status, rpcFilter.output).toBe(1);
  expect(rpcFilter.stdout).toContain("run-ci-vitest: exit 1 kept: the shard contract is not GREEN");
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
    for (const [status, log] of [[0, cleanLog(5)], [1, rpcOnlyLog(5)]] as const) {
      const run = await wrap(tree, ["npm", "run", "test:coverage", "--", ...args], { log, status, record: planRecord });
      expect(run.status, `${args.join(" ")}\n${run.output}`).toBe(0);
      expect(contractLines(run.stdout)).toEqual(["SHARD_CONTRACT verdict=GREEN shard=1/2 planned=5 recorded=5 defects=0"]);
    }
  }
});
