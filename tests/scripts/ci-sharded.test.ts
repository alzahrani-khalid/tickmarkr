// v2.7.8 T5 acceptance — public CI runs four shards, one single-fork job and one aggregate per OS
// (specs/v2.7.8-sharded-ci.spec.md). The workflow is read parsed; GitHub is a PATH stub of `gh` feeding the real
// grader; real Vitest runs only in a scratch copy of the production configuration (the WHOLE scripts/ directory,
// the real setup file) over fixture files, through THIS checkout's wrapper, as CI runs it.
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { readJson } from "../../scripts/ci/json.js";
import { parseRecord } from "../../scripts/ci/reporter.js";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

// this file lives in tests/scripts/ — the repo root is two levels up
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW = join(repoRoot, ".github/workflows/ci.public.yml");
const GRADER = join(repoRoot, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
const WRAPPER = join(repoRoot, "scripts/run-ci-vitest.sh");
const TSX = join(repoRoot, "node_modules/.bin/tsx");
const execFileP = promisify(execFile);
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratchDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratches.push(dir);
  return dir;
};

/** The child environment: no inherited Vitest, record, blob, lease, lean-reporter or git-location variables. */
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("VITEST") && !key.startsWith("GIT_") && !key.startsWith("TICKMARKR_CI_") && key !== "TICKMARKR_REPOSITORY_LEASE_TOKEN")),
  NO_COLOR: "1", FORCE_COLOR: "0", ...extra,
});
async function owned(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const run = await runOwned(cmd, args, { cwd, env, ms: 240_000 });
  const failures = ownedFailures(run, `${cmd} child`);
  if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
  return { status: run.exitCode, stdout: run.out, stderr: run.err, output: `${run.out}${run.err}` };
}

// ---- the parsed workflow, its matrices expanded and their expressions rendered
type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = {
  name?: string; needs?: string | string[]; if?: string; "runs-on"?: string; steps?: Step[];
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown[]> };
};
type Instance = { id: string; job: Job; vars: Record<string, string>; name: string };
const render = (text: string, vars: Record<string, string>) =>
  text.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? `<unknown matrix.${key}>`);
function expand(jobs: Record<string, Job>): Instance[] {
  return Object.entries(jobs).flatMap(([id, job]) => {
    let rows: Record<string, string>[] = [{}];
    for (const [axis, values] of Object.entries(job.strategy?.matrix ?? {})) {
      rows = rows.flatMap((row) => values.map((value) => ({ ...row, [axis]: String(value) })));
    }
    return rows.map((vars) => ({ id, job, vars, name: render(job.name ?? id, vars) }));
  });
}
const RUNNER = /\bnpx\s+(?:--\S+\s+)*vitest\b|\bnpm\s+(?:run\s+)?test[\w:-]*/;
const runnerSteps = (job: Job) => (job.steps ?? []).filter((step) => step.run && RUNNER.test(step.run));
const projectsOf = (command: string) => [...command.matchAll(/--project[= ](\S+)/g)].map((match) => match[1]!);
const SINGLE_FORK = ["built-cli", "keys-ledger", "signal-reaper", "sync-heavy"];
const OSES = ["ubuntu-latest", "macos-latest"];
const INVENTORY = OSES.flatMap((os) => [1, 2, 3, 4].map((k) => `suite ${os} ${k}/4`).concat(`single-fork ${os}`, `aggregate ${os}`));
const hasKey = (value: unknown, key: string): boolean =>
  Array.isArray(value) ? value.some((item) => hasKey(item, key))
    : value !== null && typeof value === "object" && Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));

// ---- gh job-log shapes: "<job>\t<step>\t<timestamp> <text>", and a complete clean Vitest summary
const step = (name: string, text: string) =>
  text.split("\n").map((line) => `job\t${name}\t2026-10-11T00:00:00.0000000Z ${line}`).join("\n") + "\n";
const summary = (files: number) =>
  ["", ` Test Files  ${files} passed (${files})`, `      Tests  ${files * 3} passed (${files * 3})`, "   Duration  1.00s", ""].join("\n");
const FLOORS_STEP = "Recheck coverage floors";
const SET_STEP = "Assert collected test-file set";
const MERGE_STEP = "Merge coverage (one threshold check per OS)";
const FLOORS_GREEN = "COVERAGE_FLOORS verdict=GREEN floors=6 failing=0";

type Spawned = { status: number | null; stdout: string; stderr: string };
const bash = (args: string[], env: NodeJS.ProcessEnv) => new Promise<Spawned>((settle, fail) => {
  const child = execFile("bash", args, { cwd: repoRoot, env, maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
    settle({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr }));
  child.on("error", fail);
});

/** The real grader over a stand-in gh serving `jobs` (name -> job log) as one completed, successful run. */
async function grade(jobs: readonly (readonly [name: string, log: string])[], expected: number) {
  const root = scratchDir("ci-sharded-grade-");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "logs"));
  writeFileSync(join(root, "bin/gh"), `#!/bin/bash
if [[ " $* " == *" --json jobs "* ]]; then cat "$GH_JOBS_FILE"; exit 0; fi
if [[ " $* " == *" --log "* ]]; then
  for a in "$@"; do [ "\${prev:-}" = --job ] && id=$a; prev=$a; done
  [ -f "$GH_LOG_DIR/$id.log" ] && cat "$GH_LOG_DIR/$id.log"
  exit 0
fi
exit 1
`);
  chmodSync(join(root, "bin/gh"), 0o755);
  writeFileSync(join(root, "jobs.tsv"), jobs.map(([name, log], i) => {
    writeFileSync(join(root, "logs", `${100 + i}.log`), log);
    return `${100 + i}\t${name}\tcompleted\tsuccess\n`;
  }).join(""));
  return bash([GRADER, "777", String(expected), "t5"], {
    ...process.env, GH_JOBS_FILE: join(root, "jobs.tsv"), GH_LOG_DIR: join(root, "logs"),
    PATH: `${join(root, "bin")}:${process.env.PATH}`, TKR_GRADE_CI_DIR: join(root, "diag"),
  });
}
const verdictOf = (stdout: string, name: string) =>
  new RegExp(`^${name.replace(/[/]/g, "\\/")}: (GREEN|RED|UNREADABLE|INFRA_KILLED)$`, "m").exec(stdout)?.[1];

/** Green fixture logs for every expanded job, each printed under the step names the workflow itself declares. */
function greenLogs(instances: readonly Instance[], expected: number, setLines = [`SET_ORACLE verdict=GREEN expected=${expected} actual=${expected} defects=0`]) {
  return instances.map(({ id, job, name }): [string, string] => {
    if (id !== "aggregate") return [name, step(runnerSteps(job)[0]!.name!, summary(2))];
    const named = (title: string) => (job.steps ?? []).find((s) => s.name === title)?.name ?? `<no step ${title}>`;
    return [name, step(named(MERGE_STEP), summary(8)) + step(named(FLOORS_STEP), FLOORS_GREEN) + step(named(SET_STEP), setLines.join("\n"))];
  });
}

describe("public CI: four shards, one single-fork job and one aggregate per OS", () => {
  test("test: the parsed public workflow expands per OS to four suite shards with --shard=k/4, one single-fork job running exactly the four single-fork projects and an aggregate needing both under always() that uploads merge-<os> under always(), with fail-fast off and no continue-on-error anywhere, and its expanded names graded by the real grader on green fixture logs read GREEN while dropping any one reads UNREADABLE", { timeout: 240_000 }, async () => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> };
    const instances = expand(workflow.jobs);
    expect(instances.map((instance) => instance.name).sort()).toEqual([...INVENTORY].sort());
    expect(hasKey(workflow, "continue-on-error"), "no continue-on-error anywhere").toBe(false);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.strategy?.["fail-fast"], `${id} matrix`).toBe(false);
      expect(job["runs-on"], id).toBe("${{ matrix.os }}");
    }

    for (const os of OSES) {
      const of = (id: string) => instances.filter((instance) => instance.id === id && instance.vars.os === os);
      const shards = of("suite").map(({ job, vars }) => runnerSteps(job).map((s) => render(s.run!, vars)));
      expect(shards.map((commands) => commands.length), os).toEqual([1, 1, 1, 1]);
      expect(shards.map(([command]) => /--shard=(\d)\/4(?:\s|$)/.exec(command!)?.[1]).sort(), os).toEqual(["1", "2", "3", "4"]);
      for (const [command] of shards) expect(projectsOf(command!), command).toEqual(["suite"]);
      const singleFork = of("single-fork").flatMap(({ job, vars }) => runnerSteps(job).map((s) => render(s.run!, vars)));
      expect(singleFork, os).toHaveLength(1);
      expect(projectsOf(singleFork[0]!).sort()).toEqual(SINGLE_FORK);
      expect(singleFork[0]).not.toMatch(/--shard|--coverage|test:coverage/);
      const [aggregate] = of("aggregate");
      expect([aggregate!.job.needs].flat().sort()).toEqual(["single-fork", "suite"]);
      expect(aggregate!.job.if).toMatch(/\balways\(\)/);
      const uploads = (aggregate!.job.steps ?? []).filter((s) => String(s.uses ?? "").startsWith("actions/upload-artifact")
        && render(String(s.with?.name ?? ""), aggregate!.vars) === `merge-${os}`);
      expect(uploads, `aggregate ${os} uploads merge-${os}`).toHaveLength(1);
      expect(uploads[0]!.if).toMatch(/\balways\(\)/);
      expect(String(uploads[0]!.with?.path)).toContain("coverage/coverage-summary.json");
    }

    const green = await grade(greenLogs(instances, 10), 10);
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).toContain("INVENTORY form=sharded declared=12 observed=12");
    for (const name of INVENTORY) expect(verdictOf(green.stdout, name), name).toBe("GREEN");

    // one grader at a time: twelve concurrent graders starve the suite's other forks (a sibling file's poll lost its race)
    for (const name of INVENTORY) {
      const graded = await grade(greenLogs(instances, 10).filter(([job]) => job !== name), 10);
      expect(graded.status, `${name}\n${graded.stdout}`).toBe(2);
      expect(graded.stdout).toContain(`INVENTORY_DEFECT kind=missing job=${JSON.stringify(name)}`);
      expect(graded.stdout).toContain("INVENTORY form=sharded declared=12 observed=11");
    }
  });

  // ---- the production configuration, real Vitest: two shards of `suite`, the single-fork job and the merge
  const PROBES = ["a", "b", "c", "d"].map((name) => `tests/probe/${name}.test.ts`);
  const SIGNAL_REAPER = "tests/run/reconcile-live.test.ts";
  type Runs = Awaited<ReturnType<typeof runProduction>>;
  let production: Promise<Runs> | undefined;
  const productionRuns = () => (production ??= runProduction());

  async function runProduction() {
    const scratch = scratchDir("ci-sharded-production-");
    for (const directory of ["src", "scripts"]) cpSync(join(repoRoot, directory), join(scratch, directory), { recursive: true });
    for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      cpSync(join(repoRoot, file), join(scratch, file));
    }
    symlinkSync(realpathSync(join(repoRoot, "node_modules")), join(scratch, "node_modules"), "dir");
    for (const file of [...PROBES, SIGNAL_REAPER]) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), `import { test } from "vitest";\ntest(${JSON.stringify(file)}, () => {});\n`);
    }
    // a repository whose manifest is exactly the five fixture files, so records carry its HEAD
    const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(scratch), TICKMARKR_CI_LEAN_REPORTERS: "1", VITEST_MAX_FORKS: "1" });
    const git = (...args: string[]) => execFileP("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: scratch, env });
    await git("init", "-q");
    await git("add", "--", ...PROBES, SIGNAL_REAPER);
    await git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");

    const wrap = (log: string, command: readonly string[], extra: NodeJS.ProcessEnv = {}) =>
      owned("bash", [WRAPPER, join(scratch, log), ...command], scratch, { ...env, ...extra });
    const shard = (k: number) => ["npm", "run", "test:coverage", "--", "--project", "suite", `--shard=${k}/2`];
    const blob = (k: number) => ({ TICKMARKR_CI_COVERAGE_BLOB: join(scratch, `ci/blobs/blob-${k}.json`) });
    const shards = [await wrap("ci/suite-1.log", shard(1), blob(1)), await wrap("ci/suite-2.log", shard(2), blob(2))];
    const unmarked = await wrap("unmarked/suite-1.log", shard(1));
    const singleFork = await wrap("ci/single-fork.log", ["npx", "vitest", "run", "--project", "sync-heavy", "--project", "keys-ledger", "--project", "built-cli", "--project", "signal-reaper"]);
    const merge = (blobs: string, log: string, extra: NodeJS.ProcessEnv = {}) =>
      wrap(log, ["npx", "vitest", "run", `--merge-reports=${join(scratch, blobs)}`, "--coverage"], extra);
    const merged = await merge("ci/blobs", "merge/merge.log");
    const ciRecords = readdirSync(join(scratch, "ci")).filter((name) => name.endsWith(".record.json")).sort().map((name) => join(scratch, "ci", name));
    const assert = async (mergeRecord: string, blobs: string, records = ciRecords) => {
      const run = await owned(TSX, [join(scratch, "scripts/ci/cli.ts"), "assert", "--merge-record", join(scratch, mergeRecord), "--blobs", join(scratch, blobs), ...records], scratch, env);
      const lines = run.stdout.split("\n").filter((line) => line !== "");
      return { ...run, lines, last: lines.at(-1), defects: lines.filter((line) => line.startsWith("SET_ORACLE_DEFECT ")).map((line) => readJson(line.slice("SET_ORACLE_DEFECT ".length))) };
    };
    return { scratch, env, shards, unmarked, singleFork, merged, merge, ciRecords, assert };
  }

  const floorMisses = (output: string) => output.split("\n").filter((line) => /^ERROR: Coverage for \w+ \([^)]*\) does not meet /.test(line))
    .map((line) => line.replace(/\([\d.]+%\)/, "(…)"));
  const recordOf = (path: string) => parseRecord(readJson(readFileSync(path, "utf8")), path);

  test("test: on the production config a shard run under the blob variable checks no floor where the same run unmarked misses it and the wrapped merge of every blob checks floors once and records every shard file once versus the variable leaked into the merge failing and a merge whose blob two is a byte copy of blob one or that lacks a blob failing the aggregate's assert", { timeout: 480_000 }, async () => {
    const { scratch, shards, unmarked, singleFork, merged, merge, assert } = await productionRuns();
    // the marked shards: the shard contract GREEN, a blob each, and no floor checked on the partial map
    for (const [i, run] of shards.entries()) {
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`SHARD_CONTRACT verdict=GREEN shard=${i + 1}/2 planned=2 recorded=2 defects=0`);
      expect(floorMisses(run.output), `shard ${i + 1}`).toEqual([]);
      expect(existsSync(join(scratch, `ci/blobs/blob-${i + 1}.json`))).toBe(true);
    }
    // the same shard unmarked checks the production floors on its partial map and misses them
    expect(unmarked.status, unmarked.output).toBe(1);
    const partialMisses = floorMisses(unmarked.output);
    expect(partialMisses.length).toBeGreaterThan(0);
    expect(unmarked.stdout).toMatch(/VITEST_LOG verdict=RED reason=coverage-threshold/);
    expect(singleFork.status, singleFork.output).toBe(0);

    // the wrapped merge of every blob: each floor checked exactly once on the merged map, every shard file recorded once
    const mergedMisses = floorMisses(merged.output);
    expect(mergedMisses.length).toBeGreaterThan(0);
    expect(new Set(mergedMisses).size, "each floor is checked once").toBe(mergedMisses.length);
    expect([...mergedMisses].sort()).toEqual([...partialMisses].sort());
    const mergeRecord = recordOf(join(scratch, "merge/merge.log.record.json"));
    expect(mergeRecord.shard).toBeNull();
    expect(mergeRecord.files.map(({ file, project, state }) => [file, project, state])).toEqual(PROBES.map((file) => [file, "suite", "passed"]));
    const green = await assert("merge/merge.log.record.json", "ci/blobs");
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.lines).toEqual(["SET_ORACLE verdict=GREEN expected=5 actual=5 defects=0"]);

    // the blob variable leaked into the merge: Vitest refuses to merge with a blob reporter configured
    const leaked = await merge("ci/blobs", "leaked/merge.log", { TICKMARKR_CI_COVERAGE_BLOB: join(scratch, "leaked/blob.json") });
    expect(leaked.status, leaked.output).not.toBe(0);
    expect(leaked.output).toContain("Cannot merge reports when `--reporter=blob` is used");
    expect(floorMisses(leaked.output)).toEqual([]);

    // blob two a byte copy of blob one: the merge replays shard one's files twice, and shard two's go missing
    mkdirSync(join(scratch, "copied"));
    copyFileSync(join(scratch, "ci/blobs/blob-1.json"), join(scratch, "copied/blob-1.json"));
    copyFileSync(join(scratch, "ci/blobs/blob-1.json"), join(scratch, "copied/blob-2.json"));
    await merge("copied", "copied-merge/merge.log");
    const copied = await assert("copied-merge/merge.log.record.json", "copied");
    const shardFiles = (k: number) => recordOf(join(scratch, `ci/suite-${k}.log.record.json`)).files.map(({ file }) => file);
    const [shardOne, shardTwo] = [shardFiles(1), shardFiles(2)];
    expect([shardOne, shardTwo].map((files) => files.length)).toEqual([2, 2]);
    expect(copied.status, copied.stdout).toBe(1);
    expect(copied.defects).toEqual([
      ...shardOne.map((file) => ({ kind: "merge-duplicate", file, project: "suite" })),
      ...shardTwo.map((file) => ({ kind: "merge-missing", file, project: "suite" })),
    ]);
    expect(copied.last).toBe("SET_ORACLE verdict=RED expected=5 actual=5 defects=4");

    // a lacking blob: the merge of blob one alone, and the directory holding only it
    mkdirSync(join(scratch, "lacking"));
    copyFileSync(join(scratch, "ci/blobs/blob-1.json"), join(scratch, "lacking/blob-1.json"));
    await merge("lacking", "lacking-merge/merge.log");
    const lacking = await assert("lacking-merge/merge.log.record.json", "lacking");
    expect(lacking.status, lacking.stdout).toBe(1);
    expect(lacking.defects).toEqual([
      { kind: "blob-missing", blob: "blob-2.json" },
      ...shardTwo.map((file) => ({ kind: "merge-missing", file, project: "suite" })),
    ]);
    // the blob check alone catches it too: the complete merge record over the lacking directory
    const blobOnly = await assert("merge/merge.log.record.json", "lacking");
    expect(blobOnly.defects).toEqual([{ kind: "blob-missing", blob: "blob-2.json" }]);
    // one flag alone is unreadable
    const half = await owned(TSX, [join(scratch, "scripts/ci/cli.ts"), "assert", "--blobs", join(scratch, "ci/blobs"), join(scratch, "ci/suite-1.log.record.json")], scratch, childEnv());
    expect(half.status).toBe(2);
    expect(half.stdout).toBe("SET_ORACLE verdict=UNREADABLE expected=UNREADABLE actual=UNREADABLE defects=0\n");
  });

  test("test: the aggregate's assert over real fixture records, a merge record and a blob directory, framed as its declared step in a gh job log, grades GREEN through the real grader at the expected count while a record set missing one file grades RED", { timeout: 480_000 }, async () => {
    const { ciRecords, assert } = await productionRuns();
    const instances = expand((parseYaml(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> }).jobs);
    const real = await assert("merge/merge.log.record.json", "ci/blobs");
    expect(real.last).toBe("SET_ORACLE verdict=GREEN expected=5 actual=5 defects=0");
    const green = await grade(greenLogs(instances, 5, real.lines), 5);
    expect(green.status, green.stdout + green.stderr).toBe(0);
    for (const os of OSES) {
      expect(verdictOf(green.stdout, `aggregate ${os}`)).toBe("GREEN");
      expect(green.stdout).toMatch(new RegExp(`^aggregate ${os}: .*set=\\[SET_ORACLE verdict=GREEN expected=5 actual=5 defects=0\\]`, "m"));
    }

    // the single-fork record dropped: the record set misses tests/run/reconcile-live.test.ts
    const withoutSingleFork = ciRecords.filter((path) => !path.endsWith("single-fork.log.record.json"));
    expect(withoutSingleFork).toHaveLength(ciRecords.length - 1);
    const short = await assert("merge/merge.log.record.json", "ci/blobs", withoutSingleFork);
    expect(short.status).toBe(1);
    expect(short.defects).toEqual([{ kind: "missing", file: SIGNAL_REAPER }]);
    expect(short.last).toBe("SET_ORACLE verdict=RED expected=5 actual=4 defects=1");
    const red = await grade(greenLogs(instances, 5, short.lines), 5);
    expect(red.status, red.stdout).toBe(1);
    for (const os of OSES) expect(verdictOf(red.stdout, `aggregate ${os}`)).toBe("RED");
  });
});
