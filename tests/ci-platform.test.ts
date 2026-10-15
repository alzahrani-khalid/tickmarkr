import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { FLOORS } from "./fixtures/ci/recorded-run.js";
import { ownedFailures, runOwned } from "./helpers/owned-process.js";

const repoRoot = join(import.meta.dirname, "..");
// The public export ships ci.public.yml but not the private ci.yml — assert on the workflows
// present in THIS checkout, and require at least one so the export context can't go vacuous.
const workflowPaths = [".github/workflows/ci.yml", ".github/workflows/ci.public.yml"].filter((p) =>
  existsSync(join(repoRoot, p)),
);
if (workflowPaths.length === 0) throw new Error("no CI workflow definitions found to assert on");
const splitGateCommands = [
  "npm run build",
  "npm run lint",
  "npm run test:coverage -- --project suite --project built-cli --project signal-reaper",
  "npx vitest run --project sync-heavy --project keys-ledger",
];
// v2.8.2 T2 (ANL-022 §7.2a): the logs and their records live in $RUNNER_TEMP/proof/ and every job uploads that proof
// group as its last step. v2.8.2 T7 (§7.4): the public workflow is the sharded form — per OS four `suite` shards, one
// single-fork job and one aggregate, every job a matrix over both operating systems, so both lanes run the same steps
// by construction; the aggregate merges the shards' blobs, rechecks the floors and checks the OS's proof group.
const publicGateCommands = [
  "npm run build",
  "npm run lint",
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/proof/suite-\${{ matrix.shard }}.log" npm run test:coverage -- --project suite --shard=\${{ matrix.shard }}/4`,
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/proof/single-fork.log" npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper`,
  `mkdir -p "$RUNNER_TEMP/proof/merge" && TICKMARKR_CI_RECORD="$RUNNER_TEMP/proof/merge/merge.record.json" npx vitest run --merge-reports="$RUNNER_TEMP/group/blobs" --coverage --dangerouslyIgnoreUnhandledErrors`,
  `npx tsx scripts/ci/cli.ts floors coverage/coverage-summary.json --out "$RUNNER_TEMP/proof/floors.out"`,
  `cp "$RUNNER_TEMP/proof/floors.out" "$RUNNER_TEMP/group/floors.out" && npx tsx scripts/ci/cli.ts proof --head "$GITHUB_SHA" --repo . --merge-record "$RUNNER_TEMP/proof/merge/merge.record.json" --blobs "$RUNNER_TEMP/group/blobs" "$RUNNER_TEMP/group"`,
  "actions/download-artifact@v4",
  "actions/upload-artifact@v4",
];
const gateCommandsFor = (path: string): string[] =>
  path.endsWith("ci.public.yml") ? publicGateCommands : splitGateCommands;

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

type WorkflowStep = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> };
type WorkflowJob = { "runs-on"?: string; strategy?: { matrix?: { os?: string[] } }; steps?: WorkflowStep[] };

function jobsFor(path: string): Record<string, WorkflowJob> {
  return (parse(readFileSync(join(repoRoot, path), "utf8")) as Workflow).jobs ?? {};
}

// each step's command: its run line, or the action it uses (the public upload is an action)
function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : step.uses ? [step.uses] : []));
}

// A job runs on `os` directly, or through its matrix's os axis.
const runsOn = (job: WorkflowJob, os: string): boolean =>
  job["runs-on"] === os || (job["runs-on"] === "${{ matrix.os }}" && (job.strategy?.matrix?.os ?? []).includes(os));
const laneCommands = (jobs: Record<string, WorkflowJob>, os: string): string[] =>
  Object.values(jobs).filter((job) => runsOn(job, os)).flatMap(runCommands);

// Match runner entry points, not one known script or step: the workflows invoke the suite through
// npm's test scripts and through vitest directly — in the public workflow behind the record wrapper
// (OBS-1184), whose log path may hold a matrix expression with spaces (`${{ matrix.shard }}`), or after a
// variable prefix (the aggregate's merge) — and the export context changes which definitions are present.
// An entry point anywhere in the command counts, so no wrapper spelling or prefix can hide one. Keeping the
// workflow/job/step coordinates makes failures identify the parsed source.
const invokesTestRunner = (run: string): boolean =>
  /\bnpm(?:\s+run)?\s+test(?:[\w:-]*)\b|\bnpx\s+(?:--[^\s]+\s+)*vitest\b/.test(run);

const testRunnerSteps = workflowPaths.flatMap((path) =>
  Object.entries(jobsFor(path)).flatMap(([jobName, job]) =>
    (job.steps ?? []).flatMap((step, stepIndex) =>
      step.run && invokesTestRunner(step.run) ? [{ path, jobName, stepIndex, step }] : [],
    ),
  ),
);

describe("CI platform lanes", () => {
  test("test: both workflow definitions carry a lane for the second supported operating system running build and the full suite", () => {
    for (const path of workflowPaths) {
      const macLane = laneCommands(jobsFor(path), "macos-latest");
      expect(macLane, `${path} needs a macOS lane`).not.toHaveLength(0);
      expect(macLane).toEqual(expect.arrayContaining(gateCommandsFor(path)));
    }
  });

  test("the added lane runs the same gate commands as the existing lane rather than a reduced subset", () => {
    for (const path of workflowPaths) {
      const jobs = jobsFor(path);
      // the private ci.yml pairs `test` with `test-macos`; the public matrix jobs run both systems with one step list
      const existing = path.endsWith("ci.public.yml") ? laneCommands(jobs, "ubuntu-latest") : runCommands(jobs.test ?? {});
      expect(existing, `${path} needs its existing test lane`).not.toHaveLength(0);
      const macLane = path.endsWith("ci.public.yml") ? laneCommands(jobs, "macos-latest") : runCommands(Object.values(jobs).find((job) => job["runs-on"] === "macos-latest") ?? {});
      expect(macLane, `${path} needs a macOS lane`).toEqual(existing);
    }
  });

  test("test: every step of every workflow definition present in this checkout whose run command invokes the test runner carries both the lean-reporter key and the fork-cap key, enumerated from the parsed workflow rather than from a list of known steps; an enumerator keyed on the coverage invocation alone misses two steps and fails", () => {
    // The matcher must recognise plain runner forms as well as the coverage form — asserted on the
    // commands themselves, not by counting steps: the public export ships only ci.public.yml, whose
    // every runner step IS a coverage invocation, so a step-count guard reds the exported tree alone.
    expect(invokesTestRunner("npx vitest run --project sync-heavy --project keys-ledger"), "plain vitest form").toBe(true);
    expect(invokesTestRunner(publicGateCommands[2]!), "coverage form").toBe(true);
    expect(invokesTestRunner("npm run build"), "non-runner command").toBe(false);

    for (const { path, jobName, stepIndex, step } of testRunnerSteps) {
      const source = `${path} job ${jobName} step ${stepIndex + 1}`;
      expect(step.env?.TICKMARKR_CI_LEAN_REPORTERS, `${source} needs the lean-reporter key`).toBe("1");
      expect(step.env?.VITEST_MAX_FORKS, `${source} needs the fork-cap key`).toBe("1");
    }
  });

  test("test: that enumeration returns a non-empty step set in this checkout so an enumerator matching nothing cannot pass vacuously; a matcher returning an empty set fails", () => {
    expect(testRunnerSteps, "at least one parsed workflow step must invoke the test runner").not.toHaveLength(0);
  });

  test("test: every public CI job uploads its proof group last under always, the shard and single-fork jobs after their wrapped Vitest step and the aggregate after its download, merge, floors recheck and proof check with the last three under always, every runner step keeping the lean and fork-cap keys, and the aggregate's declared proof check run from a scratch tree exits zero over a group covering its manifest and one with a file missing (W-P1)", { timeout: 120_000 }, async () => {
    const PUBLIC = ".github/workflows/ci.public.yml";
    const jobs = jobsFor(PUBLIC);
    expect(Object.keys(jobs).sort()).toEqual(["aggregate", "single-fork", "suite"]);
    const at = (job: string, found: number, what: string): number => {
      expect(found, `${job}: ${what}`).toBeGreaterThan(-1);
      return found;
    };
    // [job, the steps in order before the upload, the wrapped Vitest step's name or null, the artifact name]
    const forms: [job: string, steps: string[], wrapped: string | null, artifact: string][] = [
      ["suite", ["Run coverage shard (parallel suite project)"], "Run coverage shard (parallel suite project)", "proof-${{ matrix.os }}-suite-${{ matrix.shard }}"],
      ["single-fork", ["Run single-fork projects"], "Run single-fork projects", "proof-${{ matrix.os }}-single-fork"],
      ["aggregate", ["Download the shard and single-fork proof groups of this OS", "Merge coverage (one coverage map per OS)", "Recheck coverage floors", "Check the proof group of this OS"], null, "proof-${{ matrix.os }}-aggregate"],
    ];
    for (const [job, names, wrapped, artifact] of forms) {
      const steps = jobs[job]!.steps ?? [];
      const order = [...names.map((name) => at(job, steps.findIndex((step) => step.name === name), name)), at(job, steps.findIndex((step) => step.uses === "actions/upload-artifact@v4"), "proof upload step")];
      expect(order, `${job}: its steps in that order`).toEqual([...order].sort((a, b) => a - b));
      expect(order.at(-1), `${job}: the upload is the last step`).toBe(steps.length - 1);
      const upload = steps.at(-1)!;
      expect([upload.if, upload.with], `${job}: the proof group uploads as ${artifact} under always()`).toEqual(["always()", { name: artifact, path: "${{ runner.temp }}/proof/" }]);
      if (job === "aggregate") for (const index of order.slice(-3)) expect(steps[index]!.if, `${job} step ${index + 1} runs under always()`).toBe("always()");
      expect(steps.some((step) => /assert-test-file-count|cli\.ts assert/.test(step.run ?? "")), `${job}: no count step and no serial set step`).toBe(false);

      // the runner steps: the shard's and the single-fork job's wrapped step with its log in $RUNNER_TEMP/proof/, the
      // aggregate's merge; each keeping both keys
      const runners = steps.flatMap((step, index) => (step.run && invokesTestRunner(step.run) ? [index] : []));
      expect(runners, `${job}: the runner steps`).toEqual([steps.findIndex((step) => step.name === (wrapped ?? "Merge coverage (one coverage map per OS)"))]);
      for (const index of runners) {
        expect(steps[index]!.env?.TICKMARKR_CI_LEAN_REPORTERS, `${job} step ${index + 1} lean key`).toBe("1");
        expect(steps[index]!.env?.VITEST_MAX_FORKS, `${job} step ${index + 1} fork-cap key`).toBe("1");
        if (wrapped === null) continue;
        const log = /^bash scripts\/run-ci-vitest\.sh "([^"]+)" /.exec(steps[index]!.run!.trim())?.[1];
        expect(log, `${job} step ${index + 1} log argument`).toMatch(/^\$RUNNER_TEMP\/proof\/[^/]+$/);
      }
    }
    const checkCommand = jobs.aggregate!.steps!.find((step) => step.name === "Check the proof group of this OS")!.run!.trim();

    // that exact command, from a scratch tree whose tracked tests are its manifest, over the group the aggregate
    // downloads ($RUNNER_TEMP/group: two shard records, the single-fork record, blobs/) and its own floors sidecar and
    // merge record ($RUNNER_TEMP/proof/), the logs beside them never read as records
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ci-platform-set-")));
    try {
      const tree = join(scratch, "tree");
      const runnerTemp = join(scratch, "runner-temp");
      cpSync(join(repoRoot, "scripts"), join(tree, "scripts"), { recursive: true });
      cpSync(join(repoRoot, "package.json"), join(tree, "package.json"));
      symlinkSync(realpathSync(join(repoRoot, "node_modules")), join(tree, "node_modules"), "dir");
      const manifest = ["tests/a/one.test.ts", "tests/b/two.test.ts", "tests/b/deep/three.test.ts"];
      for (const file of manifest) {
        mkdirSync(dirname(join(tree, file)), { recursive: true });
        writeFileSync(join(tree, file), "");
      }
      // no inherited git location: the scratch tree's own repository answers the manifest and HEAD
      const childEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CEILING_DIRECTORIES: scratch };
      const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: tree, env: childEnv, encoding: "utf8" }).trim();
      git("init", "-q");
      git("add", "tests");
      git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "scratch");
      const head = git("rev-parse", "HEAD");

      const group = join(runnerTemp, "group");
      mkdirSync(join(group, "blobs"), { recursive: true });
      mkdirSync(join(runnerTemp, "proof", "merge"), { recursive: true });
      const record = (files: readonly [file: string, project: string][], shard: { index: number; count: number } | null) => `${JSON.stringify({
        schema: "tickmarkr-ci-record/2", head, shard,
        files: files.map(([file, project]) => ({ file, project, state: "passed", durationMs: 1 })),
        reason: "passed", unhandled: [],
        tests: files.map(([file, project]) => ({ file, project, name: "t", state: "passed" })),
      })}\n`;
      const writeGroup = (singleFork: readonly [string, string][]) => {
        writeFileSync(join(group, "suite-1.log.record.json"), record([[manifest[0]!, "suite"]], { index: 1, count: 2 }));
        writeFileSync(join(group, "suite-2.log.record.json"), record([[manifest[1]!, "suite"]], { index: 2, count: 2 }));
        writeFileSync(join(group, "single-fork.log.record.json"), record(singleFork, null));
        writeFileSync(join(runnerTemp, "proof", "merge", "merge.record.json"), record([[manifest[0]!, "suite"], [manifest[1]!, "suite"]], null));
      };
      for (const path of ["suite-1.log", "suite-2.log", "single-fork.log"]) writeFileSync(join(group, path), "not a record\n");
      for (const k of [1, 2]) writeFileSync(join(group, "blobs", `blob-${k}.json`), "blob\n");
      writeFileSync(join(runnerTemp, "proof", "floors.out"), FLOORS.GREEN);
      const runDeclared = async () => {
        const run = await runOwned("bash", ["-e", "-c", checkCommand], {
          cwd: tree, ms: 90_000, env: { ...childEnv, RUNNER_TEMP: runnerTemp, GITHUB_SHA: head, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        const failures = ownedFailures(run, "declared proof check step");
        if (failures.length > 0) throw new Error(failures.join("; "));
        return { status: run.exitCode, lines: run.out.trimEnd().split("\n") };
      };

      writeGroup([[manifest[2]!, "built-cli"]]);
      const covered = await runDeclared();
      expect(covered.status, covered.lines.join("\n")).toBe(0);
      expect(covered.lines).toEqual([`PROOF dir=${group} verdict=GREEN head=${head} expected=3 actual=3 records=3 record=CLEAN floors=GREEN merge=GREEN`, "PROOF_RUN verdict=GREEN"]);

      writeGroup([]);
      const missing = await runDeclared();
      expect(missing.status, missing.lines.join("\n")).toBe(1);
      expect(missing.lines).toEqual([
        `PROOF_DEFECT {"dir":"${group}","kind":"missing","file":"${manifest[2]}"}`,
        `PROOF dir=${group} verdict=RED head=${head} expected=3 actual=2 records=3 record=CLEAN floors=GREEN merge=GREEN`,
        "PROOF_RUN verdict=RED",
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
