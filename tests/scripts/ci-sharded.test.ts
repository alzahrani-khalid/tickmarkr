// v2.8.2 T7 (ANL-022 §7.4) — public CI runs four suite shards, one single-fork job and one aggregate per OS, graded
// from per-OS proof groups of ORIGINAL records (returned from eb615afd2, re-targeted to the proof groups). The
// workflow is read parsed. GitHub is the recorded-run gh stand-in (tests/fixtures/ci/recorded-run.ts) feeding the real
// grader. Real Vitest runs only in a scratch production tree — the WHOLE src/ and scripts/, the real config and setup
// file, fixture modules and tests — through THIS checkout's wrapper and the workflow's own declared steps, as CI
// runs them, with RUNNER_TEMP a scratch directory per job.
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { readJson } from "../../scripts/ci/json.js";
import { parseRecord } from "../../scripts/ci/reporter.js";
import {
  type Artifacts, type Candidate, candidateCheckout, childEnv, type Entry, FLOORS, type GhJob, type GhRun, GRADER, gradeOf,
  recordedRuns, recordText, ROOT, RUN_ID, scratch,
} from "../fixtures/ci/recorded-run.js";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";

const WORKFLOW = join(ROOT, ".github/workflows/ci.public.yml");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratchDir = (prefix: string): string => {
  const dir = scratch(prefix);
  scratches.push(dir);
  return dir;
};

// ---- the parsed workflow, its matrices expanded and their expressions rendered
type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { name?: string; needs?: string | string[]; if?: string; "runs-on"?: string; "timeout-minutes"?: number; steps?: Step[];
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown[]> } };
type Instance = { id: string; job: Job; vars: Record<string, string>; name: string };
const workflowJobs = () => (parseYaml(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> }).jobs;
const render = (text: string, vars: Record<string, string>) =>
  text.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? `<unknown matrix.${key}>`)
    .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, vars.RUNNER_TEMP ?? "<unknown runner.temp>");
function expand(jobs: Record<string, Job>): Instance[] {
  return Object.entries(jobs).flatMap(([id, job]) => {
    let rows: Record<string, string>[] = [{}];
    for (const [axis, values] of Object.entries(job.strategy?.matrix ?? {})) rows = rows.flatMap((row) => values.map((value) => ({ ...row, [axis]: String(value) })));
    return rows.map((vars) => ({ id, job, vars, name: render(job.name ?? id, vars) }));
  });
}
/** A step as GitHub names it: its name, else `Run <command>` (an action's `uses` included). */
const ghName = (step: Step) => step.name ?? `Run ${(step.run ?? step.uses ?? "").trim().split("\n")[0]}`;
/** The steps the grader declares are the workflow's own, the checkout and setup-node actions aside. */
const SETUP = /^Run actions\/(checkout|setup-node)@/;
const OSES = ["ubuntu-latest", "macos-latest"] as const;
const PARTS = ["suite-1", "suite-2", "suite-3", "suite-4", "single-fork", "aggregate"] as const;
const partOf = (name: string) => (name.startsWith("suite ") ? `suite-${name.split(" ")[2]!.split("/")[0]}` : name.split(" ")[0]!);

// ---- a recorded twelve-job run: every job's steps as the workflow names them, success, and each job's artifact
const shardRecord = (head: string, entries: readonly Entry[], index: number) =>
  `${JSON.stringify({ ...JSON.parse(recordText(head, entries)), shard: { index, count: 4 } })}\n`;
/** The suite files split into four disjoint shards, two each. */
const shardsOf = (c: Candidate): Entry[][] => [0, 1, 2, 3].map((k) => c.suite.filter((_, i) => i % 4 === k));
function shardedRun(c: Candidate): GhRun {
  const jobs = expand(workflowJobs()).map(({ job, name }, i): GhJob => ({
    name, status: "completed", conclusion: "success", databaseId: 900 + i,
    steps: ["Set up job", ...(job.steps ?? []).map(ghName), "Complete job"].map((step, n) => ({ name: step, status: "completed", conclusion: "success", number: n + 1 })),
  }));
  return { headSha: c.head, status: "completed", conclusion: "success", jobs };
}
/** Every job's proof artifact for both OSes, green unless overridden; a path's directories are created on serving. */
function shardedArtifacts(c: Candidate, overrides: Artifacts = {}, merge?: string): Artifacts {
  const out: Artifacts = {};
  for (const os of OSES) {
    shardsOf(c).forEach((entries, i) => {
      out[`proof-${os}-suite-${i + 1}`] = {
        [`suite-${i + 1}.log`]: " Test Files  2 passed (2)\n", [`suite-${i + 1}.log.record.json`]: shardRecord(c.head, entries, i + 1),
        [`blobs/blob-${i + 1}.json`]: `blob ${i + 1}\n`,
      };
    });
    out[`proof-${os}-single-fork`] = { "single-fork.log": " Test Files  4 passed (4)\n", "single-fork.log.record.json": recordText(c.head, c.singleFork) };
    out[`proof-${os}-aggregate`] = { "merge/merge.record.json": merge ?? recordText(c.head, c.suite), "floors.out": FLOORS.GREEN };
  }
  return { ...out, ...overrides };
}
/** The real grader, from the candidate checkout, over a served recorded run (nested artifact paths created). */
async function gradeSharded(root: string, c: Candidate, run: GhRun, artifacts: Artifacts) {
  const dir = join(root, `served-${readdirSync(root).length}`);
  for (const [name, files] of Object.entries(artifacts)) {
    for (const [path, text] of Object.entries(files ?? {})) {
      mkdirSync(dirname(join(dir, "artifacts", name, path)), { recursive: true });
      writeFileSync(join(dir, "artifacts", name, path), text);
    }
  }
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(dir, "calls"), "");
  return recordedRuns(root).exec(dir, "bash", [GRADER, RUN_ID, c.head, c.dir, "t7"], c.dir);
}
const proofOf = (stdout: string, job: string) => new RegExp(`^${job.replace(/[/]/g, "\\/")}: steps=\\[([^\\]]*)\\] proof=\\[(.*)\\]$`, "m").exec(stdout);

describe("public CI: four shards, one single-fork job and one aggregate per OS, graded from per-OS proof groups", () => {
  test("test: the grader grades a recorded twelve-job sharded run GREEN job by job with each OS group built from its four shard records and its single-fork record, expected equal to actual, and each merge record equal to its shards' union, and reads UNREADABLE when a shard job is absent (S-P1 S-F3)", { timeout: 600_000 }, async () => {
    const root = scratchDir("ci-sharded-grade-");
    const c = candidateCheckout(root, { suite: 8, "built-cli": 2, "sync-heavy": 2 });
    const run = shardedRun(c);
    expect(run.jobs).toHaveLength(12);
    // bait: the aggregate's artifact also holds its merge record at its top level, where a group built from every
    // downloaded record would count each suite file twice
    const baited = shardedArtifacts(c);
    baited[`proof-macos-latest-aggregate`] = { ...baited[`proof-macos-latest-aggregate`]!, "merge.record.json": recordText(c.head, c.suite) };

    const green = await gradeSharded(root, c, run, baited);
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=12");
    expect(green.stdout).not.toMatch(/INVENTORY_DEFECT|PROOF_DEFECT/);
    for (const { job, name } of expand(workflowJobs())) {
      expect(gradeOf(green.stdout, name), name).toBe("GREEN");
      const [, steps, proof] = proofOf(green.stdout, name) ?? [];
      // the grader's declared steps for this job's kind are exactly the workflow's own, each success
      expect(steps, name).toBe((job.steps ?? []).map(ghName).filter((step) => !SETUP.test(step)).map((step) => `${step}: success`).join(" | "));
      // each OS group: four shard records and the single-fork record, 12 tracked files once, the merge equal to the union
      expect(proof, name).toMatch(new RegExp(`^PROOF dir=\\S+ verdict=GREEN head=${c.head} expected=12 actual=12 records=5 record=CLEAN floors=GREEN merge=GREEN$`));
    }
    expect(green.calls.filter((call) => call.startsWith("run download ")).map((call) => /-n (\S+)/.exec(call)![1]).sort())
      .toEqual(OSES.flatMap((os) => PARTS.map((part) => `proof-${os}-${part}`)).sort());
    expect(green.stdout).toMatch(/^VERDICT rc=0 /m);

    // the merge record short of one shard's files: that OS's six jobs RED, the other OS GREEN
    const short = await gradeSharded(root, c, run, shardedArtifacts(c, {
      "proof-ubuntu-latest-aggregate": { "merge/merge.record.json": recordText(c.head, c.suite.filter((entry) => !shardsOf(c)[1]!.includes(entry))), "floors.out": FLOORS.GREEN },
    }));
    expect(short.status, short.stdout).toBe(1);
    expect(short.stdout).toMatch(new RegExp(`^proof-ubuntu-latest: PROOF_DEFECT \\{[^\\n]*"kind":"merge-missing","file":"${shardsOf(c)[1]![0]![0]}"`, "m"));
    for (const { name } of expand(workflowJobs())) expect(gradeOf(short.stdout, name), name).toBe(name.includes("ubuntu") ? "RED" : "GREEN");

    // S-F3: a shard job absent from the run — the inventory reads UNREADABLE, and that OS's group is never downloaded
    for (const absent of ["suite macos-latest 3/4", "suite ubuntu-latest 1/4"]) {
      const graded = await gradeSharded(root, c, { ...run, jobs: run.jobs.filter((job) => job.name !== absent) }, shardedArtifacts(c));
      expect(graded.status, `${absent}\n${graded.stdout}`).toBe(2);
      expect(graded.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=11");
      expect(graded.stdout.match(/^INVENTORY_DEFECT .*$/gm)).toEqual([`INVENTORY_DEFECT kind=missing job=${JSON.stringify(absent)}`]);
      const os = absent.split(" ")[1]!;
      for (const { name } of expand(workflowJobs()).filter(({ name }) => name !== absent)) {
        expect(gradeOf(graded.stdout, name), name).toBe(name.includes(os) ? "UNREADABLE" : "GREEN");
      }
      expect(graded.calls.some((call) => call.includes(`-n proof-${os}-`)), absent).toBe(false);
      expect(graded.stdout).toContain("VERDICT rc=2");
    }
    // one shard's artifact missing while its job ran: that OS's jobs UNREADABLE
    const noArtifact = await gradeSharded(root, c, run, shardedArtifacts(c, { "proof-macos-latest-suite-2": null }));
    expect(noArtifact.status, noArtifact.stdout).toBe(2);
    expect(proofOf(noArtifact.stdout, "aggregate macos-latest")?.[2]).toBe("MISSING: artifact proof-macos-latest-suite-2 not downloaded");
    expect(gradeOf(noArtifact.stdout, "suite ubuntu-latest 2/4")).toBe("GREEN");
  });

  test("test: an OS proof group holding a file excluded from every shard, a file in two shards, or the aggregate's merge-replay record counted into it reads RED, never GREEN (S-F1 S-F2 S-F5)", { timeout: 300_000 }, async () => {
    const root = scratchDir("ci-sharded-group-");
    const c = candidateCheckout(root, { suite: 8, "built-cli": 2, "sync-heavy": 2 });
    const shards = shardsOf(c);
    let n = 0;
    /** One OS group as the grader builds it, read by `cli.ts proof` with the merge record and the blob directory. */
    const proof = async (o: { shards?: Entry[][]; merge?: readonly Entry[]; counted?: boolean } = {}) => {
      const dir = join(root, `group-${n++}`);
      const blobs = `${dir}-blobs`;
      mkdirSync(dir);
      mkdirSync(blobs);
      (o.shards ?? shards).forEach((entries, i) => {
        writeFileSync(join(dir, `suite-${i + 1}--suite-${i + 1}.log.record.json`), shardRecord(c.head, entries, i + 1));
        writeFileSync(join(blobs, `blob-${i + 1}.json`), "blob\n");
      });
      writeFileSync(join(dir, "single-fork--single-fork.log.record.json"), recordText(c.head, c.singleFork));
      writeFileSync(join(dir, "floors.out"), FLOORS.GREEN);
      const merge = recordText(c.head, o.merge ?? c.suite);
      writeFileSync(`${dir}.merge.json`, merge);
      if (o.counted) writeFileSync(join(dir, "aggregate--merge.record.json"), merge);
      const run = await runOwned(TSX, [join(ROOT, "scripts/ci/cli.ts"), "proof", "--head", c.head, "--repo", c.dir, "--merge-record", `${dir}.merge.json`, "--blobs", blobs, dir], {
        cwd: c.dir, ms: 120_000, env: childEnv(),
      });
      const failures = ownedFailures(run, "proof reader");
      if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
      const lines = run.out.trimEnd().split("\n");
      return {
        status: run.exitCode, last: lines.at(-1), line: lines.find((line) => line.startsWith("PROOF ")) ?? "",
        defects: lines.filter((line) => line.startsWith("PROOF_DEFECT ")).map((line) => readJson(line.slice("PROOF_DEFECT ".length)) as Record<string, unknown>),
      };
    };

    // the control: four disjoint shards covering the suite once, the single-fork record, the merge equal to the union
    const green = await proof();
    expect(green.status, green.line).toBe(0);
    expect(green.line).toMatch(/ verdict=GREEN head=\S+ expected=12 actual=12 records=5 record=CLEAN floors=GREEN merge=GREEN$/);
    expect(green.last).toBe("PROOF_RUN verdict=GREEN");

    // S-F1: a file excluded from every shard (the merge, the union of what ran, lacks it too)
    const excluded = c.suite[5]!;
    const f1 = await proof({ shards: shards.map((entries) => entries.filter((entry) => entry !== excluded)), merge: c.suite.filter((entry) => entry !== excluded) });
    expect(f1.status, f1.line).toBe(1);
    expect(f1.line).toMatch(/ verdict=RED .* expected=12 actual=11 records=5 record=CLEAN floors=GREEN merge=GREEN$/);
    expect(f1.defects.map(({ kind, file }) => [kind, file])).toEqual([["missing", excluded[0]]]);
    expect(f1.last).toBe("PROOF_RUN verdict=RED");

    // S-F2: a file in two shards — shard 1's first file planned into shard 3 as well
    const twice = shards[0]![0]!;
    const f2 = await proof({ shards: shards.map((entries, i) => (i === 2 ? [...entries, twice] : entries)) });
    expect(f2.status, f2.line).toBe(1);
    expect(f2.line).toMatch(/ verdict=RED .* expected=12 actual=13 records=5 /);
    expect(f2.defects.map(({ kind, file, count }) => [kind, file, count])).toEqual([["duplicate", twice[0], 2]]);

    // S-F5: the aggregate's merge-replay record counted into the group: every suite file twice, never GREEN
    const f5 = await proof({ counted: true });
    expect(f5.status, f5.line).toBe(1);
    expect(f5.line).toMatch(/ verdict=RED .* expected=12 actual=20 records=6 record=CLEAN floors=GREEN merge=GREEN$/);
    expect(f5.defects.map(({ kind, file, count }) => [kind, file, count])).toEqual(c.suite.map(([file]) => ["duplicate", file, 2]));
    expect(f5.last).toBe("PROOF_RUN verdict=RED");
  });

  // ---- the production configuration, real Vitest: four modules, each covered by one probe test, sharded as CI does
  const MODULES = [1, 2, 3, 4].map((k) => `src/mods/m${k}.ts`);
  const PROBES = [1, 2, 3, 4].map((k) => `tests/probe/p${k}.test.ts`);
  // one file in each single-fork project the workflow's single-fork job names, sorted by file
  const SINGLE_FORK: [file: string, project: string][] = [
    ["tests/cli/bin.test.ts", "built-cli"], ["tests/cockpit/keys.test.ts", "keys-ledger"],
    ["tests/cockpit/sweep.test.ts", "sync-heavy"], ["tests/run/reconcile-live.test.ts", "signal-reaper"],
  ];
  const SINGLE_FORK_COMMAND = "npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper";
  type Production = Awaited<ReturnType<typeof runProduction>>;
  let production: Promise<Production> | undefined;
  const productionRuns = () => (production ??= runProduction());

  async function runProduction() {
    const tree = scratchDir("ci-sharded-production-");
    for (const directory of ["src", "scripts"]) cpSync(join(ROOT, directory), join(tree, directory), { recursive: true });
    for (const file of ["package.json", "tsconfig.json", "vitest.config.ts", "tests/setup.ts", "tests/helpers/tmprepo.ts"]) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      cpSync(join(ROOT, file), join(tree, file));
    }
    symlinkSync(realpathSync(join(ROOT, "node_modules")), join(tree, "node_modules"), "dir");
    // the production config with its coverage owned by the fixture modules: one floor per module, so a shard whose
    // coverage is lost reds its own module's floor
    const config = readFileSync(join(tree, "vitest.config.ts"), "utf8");
    const owned = config.replace(/include: \[\n\s*"src\/graph\/\*\*"[^\]]*\],/, 'include: ["src/mods/**"],')
      .replace(/thresholds: \{[\s\S]*?\n\s*\},\n/, `thresholds: { ${MODULES.map((m) => `${JSON.stringify(m)}: { lines: 90 }`).join(", ")} },\n`);
    expect(owned.match(/src\/mods/g), "the scratch config's coverage include and floors are rewritten").toHaveLength(5);
    writeFileSync(join(tree, "vitest.config.ts"), owned);
    MODULES.forEach((module, i) => {
      mkdirSync(dirname(join(tree, module)), { recursive: true });
      writeFileSync(join(tree, module), `export function m${i + 1}(n: number): number {\n  if (n > 0) return n + ${i + 1};\n  return -n;\n}\n`);
      mkdirSync(dirname(join(tree, PROBES[i]!)), { recursive: true });
      writeFileSync(join(tree, PROBES[i]!), `import { expect, test } from "vitest";\nimport { m${i + 1} } from "../../src/mods/m${i + 1}.js";\ntest("m${i + 1}", () => {\n  expect(m${i + 1}(1)).toBe(${i + 2});\n  expect(m${i + 1}(-1)).toBe(1);\n});\n`);
    });
    for (const [file, project] of SINGLE_FORK) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      writeFileSync(join(tree, file), `import { test } from "vitest";\ntest(${JSON.stringify(project)}, () => {});\n`);
    }
    // a repository whose manifest is exactly the eight fixture tests, so every record carries its HEAD
    const env = childEnv({ GIT_CEILING_DIRECTORIES: dirname(tree) });
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: tree, env, encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "--", ...PROBES, ...SINGLE_FORK.map(([file]) => file));
    git("commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD");

    const instances = expand(workflowJobs());
    const stepOf = (id: string, name: string) => {
      const found = instances.find((instance) => instance.id === id)!.job.steps!.find((step) => step.name === name);
      if (found?.run === undefined) throw new Error(`${id}: no declared step ${name}`);
      return found;
    };
    /** One declared step, verbatim through `bash -e -c` with its declared env, RUNNER_TEMP `runnerTemp`, in the tree. */
    const declared = async (step: Step, vars: Record<string, string>, extra: NodeJS.ProcessEnv = {}) => {
      const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, render(String(value), vars)]));
      const run = await runOwned("bash", ["-e", "-c", render(step.run!, vars)], {
        cwd: tree, ms: 300_000, env: { ...env, ...stepEnv, RUNNER_TEMP: vars.RUNNER_TEMP!, ...extra },
      });
      const failures = ownedFailures(run, step.name ?? "declared step");
      if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
      return { status: run.exitCode, stdout: run.out, output: `${run.out}${run.err}` };
    };
    const temp = (name: string) => {
      const dir = join(tree, ".runner", name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    // the sharded form: each shard job and the single-fork job on its own runner, as the workflow declares them
    const shardStep = stepOf("suite", "Run coverage shard (parallel suite project)");
    const shards = [];
    for (const k of [1, 2, 3, 4]) shards.push(await declared(shardStep, { shard: String(k), os: "ubuntu-latest", RUNNER_TEMP: temp(`suite-${k}`) }));
    const singleForkStep = stepOf("single-fork", "Run single-fork projects");
    const singleFork = await declared(singleForkStep, { os: "ubuntu-latest", RUNNER_TEMP: temp("single-fork") });
    const shardRecords = [1, 2, 3, 4].map((k) => join(tree, ".runner", `suite-${k}`, "proof", `suite-${k}.log.record.json`));
    const singleForkRecord = join(tree, ".runner", "single-fork", "proof", "single-fork.log.record.json");

    /** The aggregate on its own runner over `parts` of the shard and single-fork proof directories (the download, flattened
     * as merge-multiple does), less any blob in `dropBlobs`: its declared merge, floors and in-job proof steps. */
    const aggregate = async (name: string, dropBlobs: readonly number[] = []) => {
      const runnerTemp = temp(name);
      const group = join(runnerTemp, "group");
      for (const part of ["suite-1", "suite-2", "suite-3", "suite-4", "single-fork"]) cpSync(join(tree, ".runner", part, "proof"), group, { recursive: true });
      for (const k of dropBlobs) rmSync(join(group, "blobs", `blob-${k}.json`));
      rmSync(join(tree, "coverage"), { recursive: true, force: true });
      const vars = { os: "ubuntu-latest", RUNNER_TEMP: runnerTemp };
      const merge = await declared(stepOf("aggregate", "Merge coverage (one coverage map per OS)"), vars);
      const floors = await declared(stepOf("aggregate", "Recheck coverage floors"), vars);
      const check = await declared(stepOf("aggregate", "Check the proof group of this OS"), vars, { GITHUB_SHA: head });
      const summary = join(runnerTemp, "coverage-summary.json");
      cpSync(join(tree, "coverage", "coverage-summary.json"), summary);
      return {
        runnerTemp, group, merge, floors, check, summary, mergeRecord: join(runnerTemp, "proof", "merge", "merge.record.json"),
        floorsOut: readFileSync(join(runnerTemp, "proof", "floors.out"), "utf8"),
      };
    };
    const merged = await aggregate("aggregate");
    const lacking = await aggregate("aggregate-lacking", [2]);

    // the serial form at the same head: the coverage form and the single-fork form, each through the wrapper
    rmSync(join(tree, "coverage"), { recursive: true, force: true });
    const serialTemp = temp("serial");
    const serialEnv = { ...env, TICKMARKR_CI_LEAN_REPORTERS: "1", VITEST_MAX_FORKS: "1" };
    const wrapped = async (log: string, command: string) => {
      const run = await runOwned("bash", [join(tree, "scripts/run-ci-vitest.sh"), join(serialTemp, log), ...command.split(" ")], { cwd: tree, ms: 300_000, env: serialEnv });
      const failures = ownedFailures(run, log);
      if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
      return { status: run.exitCode, stdout: run.out };
    };
    const serial = [await wrapped("coverage.log", "npm run test:coverage -- --project suite"), await wrapped("single-fork.log", SINGLE_FORK_COMMAND)];
    const serialSummary = join(serialTemp, "coverage-summary.json");
    cpSync(join(tree, "coverage", "coverage-summary.json"), serialSummary);
    const serialRecords = ["coverage.log", "single-fork.log"].map((log) => join(serialTemp, `${log}.record.json`));
    const cli = async (args: readonly string[]) => {
      const run = await runOwned(TSX, [join(tree, "scripts/ci/cli.ts"), ...args], { cwd: tree, ms: 120_000, env });
      const failures = ownedFailures(run, args[0]!);
      if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
      const lines = run.out.trimEnd().split("\n");
      return { status: run.exitCode, lines, last: lines.at(-1) };
    };
    return { tree, head, shardStep, shards, singleFork, shardRecords, singleForkRecord, merged, lacking, serial, serialRecords, serialSummary, cli };
  }
  const recordOf = (path: string) => parseRecord(readJson(readFileSync(path, "utf8")), path);
  const floorsVerdict = (text: string) => text.trimEnd().split("\n").at(-1);

  test("test: the workflow's declared aggregate merge and floors commands, run over real shard blobs of a scratch production tree, read the floors GREEN when every shard covered its module and RED when one shard's coverage is lost, and a missing blob or one shard's files dropped from the merge record read RED through the proof reader's merge check (S-F4)", { timeout: 1_200_000 }, async () => {
    const { head, merged, lacking, shardRecords, cli } = await productionRuns();
    // every shard covered its module: the merged map clears every module's floor, and the in-job proof reads GREEN
    expect(merged.merge.status, merged.merge.output).toBe(0);
    expect(merged.floors.status, merged.floorsOut).toBe(0);
    expect(floorsVerdict(merged.floorsOut)).toBe("COVERAGE_FLOORS verdict=GREEN floors=4 failing=0");
    expect(merged.check.status, merged.check.output).toBe(0);
    expect(merged.check.stdout).toMatch(new RegExp(`^PROOF dir=\\S+ verdict=GREEN head=${head} expected=8 actual=8 records=5 record=CLEAN floors=GREEN merge=GREEN$`, "m"));
    const mergeRecord = recordOf(merged.mergeRecord);
    expect(mergeRecord.shard).toBeNull();
    expect(mergeRecord.files.map(({ file, project, state }) => [file, project, state])).toEqual(PROBES.map((file) => [file, "suite", "passed"]));

    // one shard's coverage lost (its blob never reached the merge): its module's floor reds, the producer's status reaches
    // the step, and the in-job proof reds through the merge check — the blob missing and that shard's files absent
    const shardTwo = recordOf(shardRecords[1]!).files.map(({ file }) => file);
    expect(shardTwo).toEqual([PROBES[1]]);
    expect(lacking.floors.status, lacking.floorsOut).toBe(1);
    expect(floorsVerdict(lacking.floorsOut)).toBe("COVERAGE_FLOORS verdict=RED floors=4 failing=1");
    const red = lacking.floorsOut.split("\n").filter((line) => line.startsWith("COVERAGE_FLOOR ")).map((line) => readJson(line.slice("COVERAGE_FLOOR ".length)) as { glob: string; defects: string[] });
    expect(red.filter(({ defects }) => defects.length > 0).map(({ glob, defects }) => [glob, defects])).toEqual([[MODULES[1], ["below-floor"]]]);
    expect(lacking.check.status, lacking.check.output).toBe(1);
    expect(lacking.check.stdout).toMatch(/^PROOF dir=\S+ verdict=RED .* floors=RED merge=RED$/m);
    expect(lacking.check.stdout).toContain('"kind":"blob-missing","blob":"blob-2.json"');
    expect(lacking.check.stdout).toContain(`"kind":"merge-missing","file":"${PROBES[1]}","project":"suite"`);

    // through the proof reader over the complete group with GREEN floors: a missing blob alone, and one shard's
    // files dropped from the complete merge record alone, each read RED
    const reader = (mergeRecord: string, blobs: string) =>
      cli(["proof", "--head", head, "--repo", ".", "--merge-record", mergeRecord, "--blobs", blobs, merged.group]);
    const control = await reader(merged.mergeRecord, join(merged.group, "blobs"));
    expect(control.status, control.lines.join("\n")).toBe(0);
    const oneBlob = join(merged.runnerTemp, "blobs-lacking");
    cpSync(join(merged.group, "blobs"), oneBlob, { recursive: true });
    rmSync(join(oneBlob, "blob-3.json"));
    const missingBlob = await reader(merged.mergeRecord, oneBlob);
    expect(missingBlob.status, missingBlob.lines.join("\n")).toBe(1);
    expect(missingBlob.lines.filter((line) => line.startsWith("PROOF_DEFECT ")).map((line) => (readJson(line.slice("PROOF_DEFECT ".length)) as { kind: string; blob?: string })))
      .toEqual([expect.objectContaining({ kind: "blob-missing", blob: "blob-3.json" })]);
    expect(missingBlob.last).toBe("PROOF_RUN verdict=RED");
    const shardFour = recordOf(shardRecords[3]!).files.map(({ file }) => file);
    const dropped = join(merged.runnerTemp, "merge-dropped.json");
    writeFileSync(dropped, `${JSON.stringify({ ...mergeRecord, files: mergeRecord.files.filter(({ file }) => !shardFour.includes(file)), tests: mergeRecord.tests.filter(({ file }) => !shardFour.includes(file)) })}\n`);
    const droppedRead = await reader(dropped, join(merged.group, "blobs"));
    expect(droppedRead.status, droppedRead.lines.join("\n")).toBe(1);
    expect(droppedRead.lines.filter((line) => line.startsWith("PROOF_DEFECT ")).map((line) => (readJson(line.slice("PROOF_DEFECT ".length)) as { kind: string; file?: string })))
      .toEqual(shardFour.map((file) => expect.objectContaining({ kind: "merge-missing", file })));
    expect(droppedRead.last).toBe("PROOF_RUN verdict=RED");
  });

  test("test: the parsed workflow expands to exactly the grader's twelve sharded jobs, and its shard commands run through the production wrapper on a scratch production tree split that tree into four disjoint shards covering it once, whose serial and sharded records at one head the parity command reads GREEN (S-P2 local half)", { timeout: 1_200_000 }, async () => {
    const jobs = workflowJobs();
    const instances = expand(jobs);
    // the form: every job a matrix over both OSes with fail-fast off and a timeout, no continue-on-error, the aggregate
    // needing both test jobs under always()
    expect(readFileSync(WORKFLOW, "utf8")).not.toMatch(/continue-on-error/);
    expect(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, [job.strategy?.["fail-fast"], job.strategy?.matrix?.os, job["runs-on"], job["timeout-minutes"]]]))).toEqual({
      suite: [false, [...OSES], "${{ matrix.os }}", 120], "single-fork": [false, [...OSES], "${{ matrix.os }}", 60], aggregate: [false, [...OSES], "${{ matrix.os }}", 30],
    });
    expect([jobs.aggregate!.needs].flat().sort()).toEqual(["single-fork", "suite"]);
    expect(jobs.aggregate!.if).toMatch(/^always\(\) && /);
    // every job uploads proof-<os>-<part> under always() as its last step
    for (const { name, job, vars } of instances) {
      const last = job.steps!.at(-1)!;
      expect([last.uses, last.if, render(String(last.with?.name), vars)], name).toEqual(["actions/upload-artifact@v4", "always()", `proof-${vars.os}-${partOf(name)}`]);
    }
    // the grader's inventory: a run of exactly the expanded names has no defect; one name fewer or one more is a defect
    const root = scratchDir("ci-sharded-inventory-");
    const c = candidateCheckout(root);
    const run: GhRun = { headSha: c.head, status: "completed", conclusion: "success", jobs: instances.map(({ name }, i) => ({ name, status: "completed", conclusion: "success", databaseId: 700 + i, steps: [] })) };
    const exact = await gradeSharded(root, c, run, {});
    expect(exact.stdout.split("\n")[0], exact.stdout).toBe("INVENTORY form=sharded declared=12 observed=12");
    expect(exact.stdout).not.toContain("INVENTORY_DEFECT");
    const extra = await gradeSharded(root, c, { ...run, jobs: [...run.jobs, { ...run.jobs[0]!, name: "suite ubuntu-latest 5/4", databaseId: 799 }] }, {});
    expect(extra.stdout.match(/^INVENTORY_DEFECT .*$/gm)).toEqual(['INVENTORY_DEFECT kind=unknown job="suite ubuntu-latest 5/4"']);

    // the shard commands through the production wrapper: four disjoint shards of the suite project covering it once
    const { tree, head, shardStep, shards, singleFork, shardRecords, singleForkRecord, merged, serial, serialRecords, serialSummary, cli } = await productionRuns();
    expect(shardStep.run).toMatch(/^bash scripts\/run-ci-vitest\.sh "\$RUNNER_TEMP\/proof\/suite-\$\{\{ matrix\.shard \}\}\.log" npm run test:coverage -- --project suite --shard=\$\{\{ matrix\.shard \}\}\/4$/);
    shards.forEach((run, i) => {
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`SHARD_CONTRACT verdict=GREEN shard=${i + 1}/4 planned=1 recorded=1 defects=0`);
      expect(run.stdout).toMatch(/^RECORD_VERDICT verdict=CLEAN /m);
    });
    const planned = shardRecords.map((path, i) => {
      const record = recordOf(path);
      expect(record.shard, path).toEqual({ index: i + 1, count: 4 });
      expect(record.head).toBe(head);
      return record.files.map(({ file, project }) => `${project} ${file}`);
    });
    expect(planned.flat().sort(), "the four shards cover the suite project once").toEqual(PROBES.map((file) => `suite ${file}`));
    expect(new Set(planned.flat()).size, "and are disjoint").toBe(planned.flat().length);
    expect(singleFork.status, singleFork.output).toBe(0);
    expect(singleFork.stdout).toContain("SHARD_CONTRACT verdict=GREEN shard=none planned=4 recorded=4 defects=0");
    expect(recordOf(singleForkRecord).files.map(({ file, project }) => [file, project])).toEqual(SINGLE_FORK);
    for (const run of serial) expect(run.status, run.stdout).toBe(0);
    expect(serialRecords.map((path) => recordOf(path).head)).toEqual([head, head]);

    // the parity command over the serial and sharded records at that head and each form's coverage: GREEN
    const parity = (sharded: readonly string[]) => cli(["parity", "--root", tree, "--serial", ...serialRecords, "--sharded", ...sharded, "--serial-coverage", serialSummary, "--sharded-coverage", merged.summary]);
    const green = await parity([...shardRecords, singleForkRecord]);
    expect(green.status, green.lines.join("\n")).toBe(0);
    expect(green.last).toBe("PARITY verdict=GREEN files=8 sources=4 globs=4 defects=0");
    // control: the sharded form without shard three's record is RED
    const short = await parity([shardRecords[0]!, shardRecords[1]!, shardRecords[3]!, singleForkRecord]);
    expect(short.status, short.lines.join("\n")).toBe(1);
    expect(short.lines).toContain(`PARITY_DEFECT {"form":"sharded","kind":"missing","file":"${PROBES[2]}"}`);
  });
});
