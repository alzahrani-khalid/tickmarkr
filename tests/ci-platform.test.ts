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
  "npx vitest run --project sync-heavy",
];
const publicGateCommands = [
  "npm run build",
  "npm run lint",
  `set -o pipefail
npm run test:coverage 2>&1 | tee "$RUNNER_TEMP/tickmarkr-test-output.log"
`,
  `sh scripts/assert-test-file-count.sh "$RUNNER_TEMP/tickmarkr-test-output.log"`,
];
const gateCommandsFor = (path: string): string[] =>
  path.endsWith("ci.public.yml") ? publicGateCommands : splitGateCommands;

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

type WorkflowStep = { run?: string; env?: Record<string, string> };
type WorkflowJob = { "runs-on"?: string; steps?: WorkflowStep[] };

function jobsFor(path: string): Record<string, WorkflowJob> {
  return (parse(readFileSync(join(repoRoot, path), "utf8")) as Workflow).jobs ?? {};
}

function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
}

// Match runner entry points, not one known script or step: the workflows invoke the suite through
// npm's test scripts and through vitest directly, and the export context changes which definitions
// are present. Keeping the workflow/job/step coordinates makes failures identify the parsed source.
const invokesTestRunner = (run: string): boolean =>
  /(?:^|\n)\s*(?:npm(?:\s+run)?\s+test(?:[\w:-]*)\b|npx\s+(?:--[^\s]+\s+)*vitest\b)/m.test(run);

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
      const jobs = jobsFor(path);
      const macLane = Object.values(jobs).find((job) => job["runs-on"] === "macos-latest");
      expect(macLane, `${path} needs a macOS lane`).toBeDefined();
      expect(runCommands(macLane!)).toEqual(expect.arrayContaining(gateCommandsFor(path)));
    }
  });

  test("the added lane runs the same gate commands as the existing lane rather than a reduced subset", () => {
    for (const path of workflowPaths) {
      const jobs = jobsFor(path);
      const existing = jobs.test;
      const macLane = Object.values(jobs).find((job) => job["runs-on"] === "macos-latest");
      expect(existing, `${path} needs its existing test lane`).toBeDefined();
      expect(macLane, `${path} needs a macOS lane`).toBeDefined();
      expect(runCommands(macLane!)).toEqual(runCommands(existing!));
    }
  });

  test("test: every step of every workflow definition present in this checkout whose run command invokes the test runner carries both the lean-reporter key and the fork-cap key, enumerated from the parsed workflow rather than from a list of known steps; an enumerator keyed on the coverage invocation alone misses two steps and fails", () => {
    const coverageSteps = testRunnerSteps.filter(({ step }) => step.run!.includes("test:coverage"));
    expect(testRunnerSteps.length, "coverage invocations must not be the whole runner-step enumeration")
      .toBeGreaterThan(coverageSteps.length);

    for (const { path, jobName, stepIndex, step } of testRunnerSteps) {
      const source = `${path} job ${jobName} step ${stepIndex + 1}`;
      expect(step.env?.TICKMARKR_CI_LEAN_REPORTERS, `${source} needs the lean-reporter key`).toBe("1");
      expect(step.env?.VITEST_MAX_FORKS, `${source} needs the fork-cap key`).toBe("1");
    }
  });

  test("test: that enumeration returns a non-empty step set in this checkout so an enumerator matching nothing cannot pass vacuously; a matcher returning an empty set fails", () => {
    expect(testRunnerSteps, "at least one parsed workflow step must invoke the test runner").not.toHaveLength(0);
  });
});
