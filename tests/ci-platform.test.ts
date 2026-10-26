import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
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
// v2.8.2 T2 (ANL-022 §7.2a): the logs and their records live in $RUNNER_TEMP/proof/, the set step replaces the
// count step, and the upload of that proof group is the last step
const publicGateCommands = [
  "npm run build",
  "npm run lint",
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/proof/tickmarkr-test-output.log" npm run test:coverage -- --project suite`,
  `npx tsx scripts/ci/cli.ts floors coverage/coverage-summary.json --out "$RUNNER_TEMP/proof/floors.out"`,
  `bash scripts/run-ci-vitest.sh "$RUNNER_TEMP/proof/tickmarkr-test-output-singlefork.log" npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper`,
  "npx tsx scripts/ci/cli.ts assert $RUNNER_TEMP/proof/*.record.json",
  "actions/upload-artifact@v4",
];
const gateCommandsFor = (path: string): string[] =>
  path.endsWith("ci.public.yml") ? publicGateCommands : splitGateCommands;

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

type WorkflowStep = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string | number>; env?: Record<string, string> };
type WorkflowJob = { "runs-on"?: string; steps?: WorkflowStep[] };

function jobsFor(path: string): Record<string, WorkflowJob> {
  return (parse(readFileSync(join(repoRoot, path), "utf8")) as Workflow).jobs ?? {};
}

// each step's command: its run line, or the action it uses (the public upload is an action)
function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : step.uses ? [step.uses] : []));
}

// Match runner entry points, not one known script or step: the workflows invoke the suite through
// npm's test scripts and through vitest directly — in the public workflow behind the shared-classifier
// wrapper (OBS-1184) — and the export context changes which definitions are present. Keeping the
// workflow/job/step coordinates makes failures identify the parsed source.
const invokesTestRunner = (run: string): boolean =>
  /(?:^|\n)\s*(?:bash\s+scripts\/run-ci-vitest\.sh\s+\S+\s+)?(?:npm(?:\s+run)?\s+test(?:[\w:-]*)\b|npx\s+(?:--[^\s]+\s+)*vitest\b)/m.test(run);

const testRunnerSteps = workflowPaths.flatMap((path) =>
  Object.entries(jobsFor(path)).flatMap(([jobName, job]) =>
    (job.steps ?? []).flatMap((step, stepIndex) =>
      step.run && invokesTestRunner(step.run) ? [{ path, jobName, stepIndex, step }] : [],
    ),
  ),
);

describe("CI platform lanes", () => {
  test("test: every checkout step of the public continuous integration workflow fetches the whole history with its tags, read from the parsed workflow, so a public job whose checkout keeps the default one-commit depth fails", () => {
    const path = ".github/workflows/ci.public.yml";
    const checkouts = Object.entries(jobsFor(path)).flatMap(([jobName, job]) =>
      (job.steps ?? []).flatMap((step, stepIndex) =>
        step.uses?.startsWith("actions/checkout@") ? [{ jobName, stepIndex, step }] : [],
      ),
    );
    expect(checkouts, `${path} must contain checkout steps`).not.toHaveLength(0);
    for (const { jobName, stepIndex, step } of checkouts) {
      expect(step.with?.["fetch-depth"], `${path} job ${jobName} step ${stepIndex + 1} needs full history and tags`).toBe(0);
    }
  });

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

  test("test: both public CI jobs run the coverage proof, the floors recheck, the single-fork projects, the set assertion and the proof upload in that order with the last four under always and every runner step keeping the lean and fork-cap keys, and the declared set command run from a scratch tree exits zero over records covering its manifest and one with a file missing (W-P1)", { timeout: 120_000 }, async () => {
    const PUBLIC = ".github/workflows/ci.public.yml";
    const jobs = jobsFor(PUBLIC);
    const setCommands = new Set<string>();
    const logArgs = new Set<string>();
    for (const jobName of ["test", "test-macos"]) {
      const steps = jobs[jobName]?.steps ?? [];
      const at = (found: number, what: string): number => {
        expect(found, `${jobName}: ${what}`).toBeGreaterThan(-1);
        return found;
      };
      const order = [
        at(steps.findIndex((step) => step.name === "Run coverage proof (parallel suite project)"), "coverage proof step"),
        at(steps.findIndex((step) => step.name === "Recheck coverage floors"), "floors recheck step"),
        at(steps.findIndex((step) => step.name === "Run single-fork projects (independent of the step above)"), "single-fork step"),
        at(steps.findIndex((step) => step.name === "Assert collected test-file set"), "set assertion step"),
        at(steps.findIndex((step) => step.uses === "actions/upload-artifact@v4"), "proof upload step"),
      ];
      expect(order, `${jobName}: coverage, floors, single-fork, set, upload in that order`).toEqual([...order].sort((a, b) => a - b));
      expect(order.at(-1), `${jobName}: the upload is the last step`).toBe(steps.length - 1);
      for (const index of order.slice(1)) expect(steps[index]!.if, `${jobName} step ${index + 1} runs under always()`).toBe("always()");
      const upload = steps[order[4]!]!;
      expect(upload.with, `${jobName}: the proof group uploads as proof-<job>`).toEqual({ name: "proof-${{ github.job }}", path: "${{ runner.temp }}/proof/" });
      expect(steps.some((step) => /assert-test-file-count/.test(step.run ?? "")), `${jobName}: the count step is gone`).toBe(false);

      // the runner steps are exactly the two Vitest invocations, each keeping both keys
      const runners = steps.flatMap((step, index) => (step.run && invokesTestRunner(step.run) ? [index] : []));
      expect(runners, `${jobName}: the runner steps`).toEqual([order[0], order[2]]);
      for (const index of runners) {
        expect(steps[index]!.env?.TICKMARKR_CI_LEAN_REPORTERS, `${jobName} step ${index + 1} lean key`).toBe("1");
        expect(steps[index]!.env?.VITEST_MAX_FORKS, `${jobName} step ${index + 1} fork-cap key`).toBe("1");
        const log = /^bash scripts\/run-ci-vitest\.sh "([^"]+)" /.exec(steps[index]!.run!.trim())?.[1];
        expect(log, `${jobName} step ${index + 1} log argument`).toMatch(/^\$RUNNER_TEMP\/proof\/[^/]+$/);
        logArgs.add(log!);
      }
      setCommands.add(steps[order[3]!]!.run!.trim());
    }
    expect(setCommands.size, "both jobs declare the same set command").toBe(1);
    expect(logArgs.size, "two distinct logs, the same in both jobs").toBe(2);
    const setCommand = [...setCommands][0]!;

    // that exact command, from a scratch tree whose tracked tests are its manifest, over the records the two wrapped
    // steps write (<log>.record.json in $RUNNER_TEMP/proof/) beside the group's other files
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

      const [coverageLog, singleForkLog] = [...logArgs].map((arg) => arg.replace("$RUNNER_TEMP", runnerTemp));
      mkdirSync(join(runnerTemp, "proof"), { recursive: true });
      const record = (files: readonly [file: string, project: string][]) => `${JSON.stringify({
        schema: "tickmarkr-ci-record/2", head, shard: null,
        files: files.map(([file, project]) => ({ file, project, state: "passed", durationMs: 1 })),
        reason: "passed", unhandled: [],
        tests: files.map(([file, project]) => ({ file, project, name: "t", state: "passed" })),
      })}\n`;
      const writeRecords = (singleFork: readonly [string, string][]) => {
        writeFileSync(`${coverageLog}.record.json`, record([[manifest[0]!, "suite"]]));
        writeFileSync(`${singleForkLog}.record.json`, record(singleFork));
      };
      // the group's other files: neither log nor the floors sidecar is a record the set step may read
      for (const path of [coverageLog!, singleForkLog!, join(runnerTemp, "proof", "floors.out")]) writeFileSync(path, "not a record\n");
      const runDeclared = async () => {
        const run = await runOwned("bash", ["-e", "-c", setCommand], {
          cwd: tree, ms: 90_000, env: { ...childEnv, RUNNER_TEMP: runnerTemp, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        const failures = ownedFailures(run, "declared set step");
        if (failures.length > 0) throw new Error(failures.join("; "));
        return { status: run.exitCode, lines: run.out.trimEnd().split("\n") };
      };

      writeRecords([[manifest[1]!, "sync-heavy"], [manifest[2]!, "built-cli"]]);
      const covered = await runDeclared();
      expect(covered.status, covered.lines.join("\n")).toBe(0);
      expect(covered.lines.at(-1)).toBe("SET_ORACLE verdict=GREEN expected=3 actual=3 defects=0");

      writeRecords([[manifest[1]!, "sync-heavy"]]);
      const missing = await runDeclared();
      expect(missing.status, missing.lines.join("\n")).toBe(1);
      expect(missing.lines).toEqual([
        `SET_ORACLE_DEFECT {"kind":"missing","file":"${manifest[2]}"}`,
        "SET_ORACLE verdict=RED expected=3 actual=2 defects=1",
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
