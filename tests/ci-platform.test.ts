import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

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
// v2.7.8 T5: the public workflow is the sharded form — per OS four `suite` shards, one single-fork job and one
// aggregate, every job a matrix over both operating systems, so both lanes run the same steps by construction.
const publicGateCommands = [
  "npm run build",
  "npm run lint",
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/ci/suite-\${{ matrix.shard }}.log" npm run test:coverage -- --project suite --shard=\${{ matrix.shard }}/4`,
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/ci/single-fork.log" npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper`,
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/merge/merge.log" npx vitest run --merge-reports="$RUNNER_TEMP/ci/blobs" --coverage`,
  "npx tsx scripts/ci/cli.ts floors coverage/coverage-summary.json",
  `npx tsx scripts/ci/cli.ts assert --merge-record "$RUNNER_TEMP/merge/merge.log.record.json" --blobs "$RUNNER_TEMP/ci/blobs" "$RUNNER_TEMP"/ci/*.record.json`,
];
const gateCommandsFor = (path: string): string[] =>
  path.endsWith("ci.public.yml") ? publicGateCommands : splitGateCommands;

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

type WorkflowStep = { run?: string; env?: Record<string, string> };
type WorkflowJob = { "runs-on"?: string; strategy?: { matrix?: { os?: string[] } }; steps?: WorkflowStep[] };

function jobsFor(path: string): Record<string, WorkflowJob> {
  return (parse(readFileSync(join(repoRoot, path), "utf8")) as Workflow).jobs ?? {};
}

function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
}

// A job runs on `os` directly, or through its matrix's os axis.
const runsOn = (job: WorkflowJob, os: string): boolean =>
  job["runs-on"] === os || (job["runs-on"] === "${{ matrix.os }}" && (job.strategy?.matrix?.os ?? []).includes(os));
const laneCommands = (jobs: Record<string, WorkflowJob>, os: string): string[] =>
  Object.values(jobs).filter((job) => runsOn(job, os)).flatMap(runCommands);

// Match runner entry points, not one known script or step: the workflows invoke the suite through
// npm's test scripts and through vitest directly — in the public workflow behind the shared-classifier
// wrapper (OBS-1184), whose log path may hold a matrix expression with spaces (`${{ matrix.shard }}`) — and
// the export context changes which definitions are present. An entry point anywhere in the command counts,
// so no wrapper spelling can hide one. Keeping the workflow/job/step coordinates makes failures identify the
// parsed source.
const invokesTestRunner = (run: string): boolean =>
  /\bnpm(?:\s+run)?\s+test(?:[\w:-]*)\b|\bnpx\s+(?:--[^\s]+\s+)*vitest\b/.test(run);

type RunnerStep = { source: string; step: WorkflowStep };
const runnerStepsOf = (path: string, jobs: Record<string, WorkflowJob>): RunnerStep[] =>
  Object.entries(jobs).flatMap(([jobName, job]) =>
    (job.steps ?? []).flatMap((step, stepIndex) =>
      step.run && invokesTestRunner(step.run) ? [{ source: `${path} job ${jobName} step ${stepIndex + 1}`, step }] : [],
    ),
  );
const testRunnerSteps = workflowPaths.flatMap((path) => runnerStepsOf(path, jobsFor(path)));

// G1: every runner step pins one fork and the lean reporters.
const pinViolations = (steps: readonly RunnerStep[]): string[] => steps.flatMap(({ source, step }) => [
  ...(step.env?.TICKMARKR_CI_LEAN_REPORTERS === "1" ? [] : [`${source} needs the lean-reporter key`]),
  ...(step.env?.VITEST_MAX_FORKS === "1" ? [] : [`${source} needs the fork-cap key`]),
]);
// G2 (OBS-829): the parallel `suite` project never shares an invocation with a single-fork project.
const SINGLE_FORK_PROJECTS = ["sync-heavy", "keys-ledger", "built-cli", "signal-reaper"];
const sharedInvocations = (steps: readonly RunnerStep[]): string[] => steps.flatMap(({ source, step }) => {
  const projects = [...step.run!.matchAll(/--project[= ](\S+)/g)].map((match) => match[1]!);
  const shared = projects.includes("suite") ? projects.filter((project) => SINGLE_FORK_PROJECTS.includes(project)) : [];
  return shared.length ? [`${source} declares suite beside ${shared.join(", ")}`] : [];
});

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
      expect(laneCommands(jobs, "macos-latest"), `${path} needs a macOS lane`).toEqual(existing);
    }
  });

  test("test: every step of every workflow definition present in this checkout whose run command invokes the test runner carries both the lean-reporter key and the fork-cap key, enumerated from the parsed workflow rather than from a list of known steps; an enumerator keyed on the coverage invocation alone misses two steps and fails", () => {
    // The matcher must recognise plain runner forms as well as the coverage form — asserted on the
    // commands themselves, not by counting steps: the public export ships only ci.public.yml, whose
    // runner steps are all wrapped, so a step-count guard reds the exported tree alone.
    expect(invokesTestRunner("npx vitest run --project sync-heavy --project keys-ledger"), "plain vitest form").toBe(true);
    expect(invokesTestRunner(publicGateCommands[2]!), "coverage form").toBe(true);
    expect(invokesTestRunner("npm run build"), "non-runner command").toBe(false);
    expect(pinViolations(testRunnerSteps)).toEqual([]);
  });

  test("test: that enumeration returns a non-empty step set in this checkout so an enumerator matching nothing cannot pass vacuously; a matcher returning an empty set fails", () => {
    expect(testRunnerSteps, "at least one parsed workflow step must invoke the test runner").not.toHaveLength(0);
  });

  test("test: every runner step of every workflow pins one fork and the lean reporters, a wrapped step whose log path holds a matrix expression included, and no invocation declares the suite project beside a single-fork project versus a shard step without the fork pin escaping the enumeration", () => {
    // the shard step's wrapped log path holds `${{ matrix.shard }}`, whose spaces a `\S+` path matcher anchored at
    // the command's start never crosses: that matcher (the base's) lets the shard step escape, this one does not
    const shardStep = publicGateCommands[2]!;
    const startAnchored = /(?:^|\n)\s*(?:bash\s+scripts\/run-ci-vitest\.sh\s+\S+\s+)?(?:npm(?:\s+run)?\s+test(?:[\w:-]*)\b|npx\s+(?:--[^\s]+\s+)*vitest\b)/m;
    expect(startAnchored.test(shardStep), "the base matcher misses the wrapped shard step").toBe(false);
    expect(invokesTestRunner(shardStep), "a wrapped step whose log path holds a matrix expression").toBe(true);

    for (const path of workflowPaths) expect(pinViolations(runnerStepsOf(path, jobsFor(path))), path).toEqual([]);
    // G2 binds the public sharded form; the private ci.yml (unchanged by ruling, absent from the export) still
    // pairs suite with two single-fork projects in one coverage step
    const publicPath = ".github/workflows/ci.public.yml";
    const publicJobs = jobsFor(publicPath);
    const publicSteps = runnerStepsOf(publicPath, publicJobs);
    expect(publicSteps.map(({ step }) => step.run)).toEqual(expect.arrayContaining(publicGateCommands.filter(invokesTestRunner)));
    expect(sharedInvocations(publicSteps)).toEqual([]);

    // a shard step without the fork pin is enumerated and named, never skipped
    const unpinned = structuredClone(publicJobs);
    const shard = unpinned.suite!.steps!.find((step) => step.run === shardStep)!;
    delete shard.env!.VITEST_MAX_FORKS;
    expect(pinViolations(runnerStepsOf(publicPath, unpinned))).toEqual([`${publicPath} job suite step ${unpinned.suite!.steps!.indexOf(shard) + 1} needs the fork-cap key`]);
    // and a shard that declares a single-fork project beside suite is named
    shard.run = shardStep.replace("--project suite", "--project suite --project=built-cli");
    expect(sharedInvocations(runnerStepsOf(publicPath, unpinned))).toEqual([`${publicPath} job suite step ${unpinned.suite!.steps!.indexOf(shard) + 1} declares suite beside built-cli`]);
  });
});
