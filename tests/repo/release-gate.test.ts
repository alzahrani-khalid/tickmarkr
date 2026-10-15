// v2.8.2 T6 (ANL-022 §7.5 V03, D-1960, D-1975) — the Release workflow publishes only the graded commit.
// The job runs AS DECLARED: every step of the parsed .github/workflows/release.yml job, in order, with `bash -e -c`
// and its GitHub expressions substituted, from a scratch checkout of the tagged commit that carries the shipped
// grader and record tooling. The `uses:` steps stand for that checkout; npm is a stand-in that records its calls
// (`npm ci` links the dependencies); gh serves recorded files — the `gh run list` answer for the gate's one exact
// query, then the recorded run of tests/fixtures/ci/recorded-run.ts for the grader. A job reaches publish iff the npm
// stand-in records `publish`. Beside the run, the gate binds through the job's parsed step graph, not its commands.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";
import {
  type Artifacts, type Candidate, candidateCheckout, childEnv, type GhRun, GRADER, gradeOf, greenArtifacts, proofGroup,
  recordedRun, recordedRuns, recordText, ROOT, RUN_ID, scratch, STEP, stepped,
} from "../fixtures/ci/recorded-run.js";

const RELEASE_YML = join(ROOT, ".github/workflows/release.yml");
const PUBLIC_REPO = "alzahrani-khalid/tickmarkr";
const TAG = "v9.9.9";
const TOKEN = "recorded-token";

type Step = { name?: string; uses?: string; run?: string; if?: unknown; env?: Record<string, unknown>; "continue-on-error"?: unknown };
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, { if?: string; steps: Step[] }> };
const readWorkflow = (): Workflow => parseYaml(readFileSync(RELEASE_YML, "utf8")) as Workflow;
const isPublish = (step: Step) => /\bnpm publish\b/.test(step.run ?? "");
const isGate = (step: Step) => (step.run ?? "").includes("bash skills/tickmarkr-overseer/scripts/grade-ci.sh ");
const label = (step: Step) => step.name ?? step.uses ?? (step.run ?? "").split("\n")[0]!;

/** D-1975: every way a publish step could run without the gate having passed before it in its own job. */
function gateDefects(workflow: Workflow): string[] {
  const defects: string[] = [];
  const jobs = Object.entries(workflow.jobs ?? {}).filter(([, job]) => (job.steps ?? []).some(isPublish));
  if (jobs.length === 0) defects.push("no job publishes");
  for (const [name, { steps }] of jobs) {
    const gates = steps.flatMap((step, i) => (isGate(step) ? [i] : []));
    if (gates.length !== 1) {
      defects.push(`${name}: ${gates.length} gate steps, expected exactly one`);
      continue;
    }
    const gate = steps[gates[0]!]!;
    if (gate.if !== undefined) defects.push(`${name}: the gate has if: ${String(gate.if)}, so it can be skipped`);
    if (gate["continue-on-error"] !== undefined) defects.push(`${name}: the gate has continue-on-error, so its failure can be tolerated`);
    steps.forEach((step, i) => {
      if (!isPublish(step)) return;
      if (i < gates[0]!) defects.push(`${name}: publish step ${i} runs before the gate`);
      // success() is the only status a publish may run under: always(), failure() and (!)cancelled() each let it
      // run after a failed or killed prerequisite
      if (step.if !== undefined && /\b(?:always|failure|cancelled)\s*\(/.test(String(step.if))) {
        defects.push(`${name}: publish step ${i} has if: ${String(step.if)}, so it can run after a failed prerequisite`);
      }
    });
  }
  return defects;
}

type ListEntry = { databaseId: number; headSha: string; status: string; conclusion: string };
type JobRun = { ran: string[]; failed: string | null; published: boolean; npm: string[]; gh: string[]; out: string };

// The gate's one gh query, answered from a recorded file only when asked exactly; every other gh call goes to the
// recorded run's stand-in. Both refuse a call without the step's token.
const GATE_GH = `#!/bin/bash
[ "$GH_TOKEN" = "$EXPECT_TOKEN" ] || { echo "gh stand-in: no token" >&2; exit 4; }
if [ "$1 $2" = "run list" ]; then
  printf '%s\\n' "$*" >> "$GH_CALLS"
  [ "$*" = "$GH_LIST_QUERY" ] || { echo "gh stand-in: unexpected query: $*" >&2; exit 1; }
  cat "$GH_LIST"
  exit
fi
exec "$GH_RECORDED" "$@"
`;
const NPM = `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_CALLS"
if [ "$1" = ci ]; then ln -s "$NODE_MODULES_FIXTURE" node_modules; fi
exit 0
`;

/** A scratch checkout of the tagged commit (the recorded run's candidate) holding the shipped grader and record
 * tooling, and a runner for the declared job against one recorded `gh run list` answer and one recorded run. */
function releaseRunner(root: string) {
  const c: Candidate = candidateCheckout(root);
  mkdirSync(join(c.dir, "skills/tickmarkr-overseer/scripts"), { recursive: true });
  copyFileSync(GRADER, join(c.dir, "skills/tickmarkr-overseer/scripts/grade-ci.sh"));
  cpSync(join(ROOT, "scripts/ci"), join(c.dir, "scripts/ci"), { recursive: true });
  writeFileSync(join(c.dir, "package.json"), '{"type":"module"}\n');
  const { serve } = recordedRuns(root);
  const bin = join(root, "gate-bin");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  for (const [name, text] of [["gh", GATE_GH], ["npm", NPM]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const expressions: Record<string, string> = {
    "github.token": TOKEN, "github.sha": c.head, "github.repository": PUBLIC_REPO, "github.ref_name": TAG, "runner.temp": runnerTemp,
  };
  const substitute = (text: string) => text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => {
    if (!(expression in expressions)) throw new Error(`the runner stand-in has no value for \${{ ${expression} }}`);
    return expressions[expression]!;
  });
  const listed = (o: Partial<ListEntry> = {}): ListEntry =>
    ({ databaseId: Number(RUN_ID), headSha: c.head, status: "completed", conclusion: "success", ...o });

  const run = async (list: readonly ListEntry[], ghRun: GhRun, artifacts: Artifacts): Promise<JobRun> => {
    const dir = serve(ghRun, artifacts);
    writeFileSync(join(dir, "list.json"), `${JSON.stringify(list)}\n`);
    writeFileSync(join(dir, "npm"), "");
    rmSync(join(c.dir, "node_modules"), { force: true });
    const steps = Object.values(readWorkflow().jobs).find((job) => job.steps.some(isPublish))!.steps;
    const result: JobRun = { ran: [], failed: null, published: false, npm: [], gh: [], out: "" };
    for (const step of steps) {
      if (step.if !== undefined) throw new Error(`${label(step)}: the runner stand-in evaluates no step if:`);
      result.ran.push(label(step));
      if (step.run === undefined) continue; // checkout and setup-node: the scratch checkout stands for them
      const env = childEnv({
        PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: PUBLIC_REPO, GITHUB_SHA: c.head, GITHUB_REF_NAME: TAG,
        GITHUB_WORKSPACE: c.dir, RUNNER_TEMP: runnerTemp,
        GH_RUN_DIR: dir, GH_RUN_ID: RUN_ID, GH_CALLS: join(dir, "calls"), GH_RECORDED: join(root, "bin/gh"), GH_LIST: join(dir, "list.json"),
        GH_LIST_QUERY: `run list --repo ${PUBLIC_REPO} --workflow ci.public.yml --commit ${c.head} --event push --json databaseId,headSha,status,conclusion`,
        EXPECT_TOKEN: TOKEN, NPM_CALLS: join(dir, "npm"), NODE_MODULES_FIXTURE: realpathSync(join(ROOT, "node_modules")),
        ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, substitute(String(value))])),
      });
      const owned = await runOwned("bash", ["-e", "-c", substitute(step.run)], { cwd: c.dir, env, ms: 300_000 });
      const failures = ownedFailures(owned, label(step));
      if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${owned.out}\n${owned.err}`);
      result.out += `${owned.out}${owned.err}`;
      if (owned.exitCode !== 0) {
        result.failed = label(step);
        break;
      }
    }
    result.npm = readFileSync(join(dir, "npm"), "utf8").split("\n").filter((line) => line !== "");
    result.gh = readFileSync(join(dir, "calls"), "utf8").split("\n").filter((line) => line !== "");
    result.published = result.npm.includes("publish --provenance --access public");
    return result;
  };
  return { c, run, listed };
}

const GATE = "Grade the CI (public) run of this commit";

describe("the Release workflow publishes only the graded commit", () => {
  test("test: the Release workflow's pre-publish gate run as declared with gh replaced by recorded files reaches publish for exactly one completed successful CI run of the tagged commit, and fails before publish for no run, two runs, a run in progress or a run concluded failure, while over the job's parsed steps the gate runs on every publish path with no if condition and no continue on error and no publish condition can run after a failed prerequisite, so a skipped gate, a tolerated gate failure and an always-run publish each read RED (C-P2 C-F3 C-F4)", { timeout: 900_000 }, async () => {
    // the parsed step graph: one gate in the publishing job, unconditional, intolerant, before every publish step
    const workflow = readWorkflow();
    expect(gateDefects(workflow)).toEqual([]);
    expect(workflow.permissions?.actions).toBe("read");
    const steps = workflow.jobs.release!.steps;
    const publishIndex = steps.findIndex(isPublish);
    expect(steps.map(label).indexOf("npm ci")).toBeLessThan(steps.map(label).indexOf(GATE));
    expect(steps.some((step) => /\bvitest\b/.test(step.run ?? "")), "the built-cli/signal-reaper subset is gone").toBe(false);
    // each way around the gate reads RED over the same graph
    const mutated = (change: (steps: Step[]) => void): string[] => {
      const copy = structuredClone(workflow);
      change(copy.jobs.release!.steps);
      return gateDefects(copy);
    };
    const gateOf = (s: Step[]) => s.find(isGate)!;
    const publishOf = (s: Step[]) => s.find(isPublish)!;
    expect(mutated((s) => { gateOf(s).if = "github.event_name == 'workflow_dispatch'"; })).toEqual(["release: the gate has if: github.event_name == 'workflow_dispatch', so it can be skipped"]);
    expect(mutated((s) => { gateOf(s).if = false; })).toEqual(["release: the gate has if: false, so it can be skipped"]);
    expect(mutated((s) => { gateOf(s)["continue-on-error"] = true; })).toEqual(["release: the gate has continue-on-error, so its failure can be tolerated"]);
    for (const condition of ["always()", "failure()", "${{ !cancelled() }}", "success() || failure()"]) {
      expect(mutated((s) => { publishOf(s).if = condition; }), condition).toEqual([`release: publish step ${publishIndex} has if: ${condition}, so it can run after a failed prerequisite`]);
    }
    expect(mutated((s) => { publishOf(s).if = "success() && startsWith(github.ref, 'refs/tags/v')"; })).toEqual([]);
    expect(mutated((s) => { s.unshift(s.splice(s.findIndex(isPublish), 1)[0]!); })).toEqual(["release: publish step 0 runs before the gate"]);
    expect(mutated((s) => { s.splice(s.findIndex(isGate), 1); })).toEqual(["release: 0 gate steps, expected exactly one"]);

    const root = scratch("tickmarkr-release-gate-");
    try {
      const { c, run, listed } = releaseRunner(root);
      const green = recordedRun(c.head);
      // C-P2: exactly one completed successful push run of the tagged commit, graded GREEN: publish is reached,
      // after install, build, lint and the gate, in that order
      const passed = await run([listed()], green, greenArtifacts(c));
      expect(passed.failed, passed.out).toBeNull();
      expect(passed.published, passed.out).toBe(true);
      expect(passed.npm).toEqual(["install -g npm@11", "ci", "run build", "run lint", "publish --provenance --access public"]);
      expect(passed.out).toContain(`release gate: grading CI (public) run ${RUN_ID} of ${c.head}`);
      for (const job of ["test", "test-macos"]) expect(gradeOf(passed.out, job), job).toBe("GREEN");
      expect(passed.out).toMatch(/^VERDICT rc=0 /m);
      expect(passed.gh[0]).toBe(`run list --repo ${PUBLIC_REPO} --workflow ci.public.yml --commit ${c.head} --event push --json databaseId,headSha,status,conclusion`);
      expect(passed.gh).toContain(`run view ${RUN_ID} --repo ${PUBLIC_REPO} --json headSha,status,conclusion,jobs`);

      const failsAtGate = (job: JobRun, why: string) => {
        expect(job.failed, `${why}\n${job.out}`).toBe(GATE);
        expect(job.published, why).toBe(false);
        expect(job.npm, why).not.toContain("publish --provenance --access public");
      };
      // C-F3: no run, or two runs — each of them green, so picking either would have graded GREEN
      const none = await run([], green, greenArtifacts(c));
      failsAtGate(none, "no run");
      expect(none.gh, "nothing graded without a run").toEqual([passed.gh[0]]);
      const two = await run([listed(), listed({ databaseId: Number(RUN_ID) + 1 })], green, greenArtifacts(c));
      failsAtGate(two, "two runs");
      expect(two.out).toContain("release gate: need exactly one completed successful ci.public.yml push run");
      // C-F4: the run still in progress (the gate fails, it does not wait), or concluded failure
      failsAtGate(await run([listed({ status: "in_progress", conclusion: "" })], { ...green, status: "in_progress", conclusion: "" }, greenArtifacts(c)), "in progress");
      failsAtGate(await run([listed({ conclusion: "failure" })], stepped(green, ["test"], STEP.coverage, "failure"), greenArtifacts(c)), "concluded failure");
      // and a listed run of another commit is no run of this one
      failsAtGate(await run([listed({ headSha: c.parent })], { ...green, headSha: c.parent }, greenArtifacts(c)), "another head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("test: the same gate fails before publish when one OS proof group is missing, a job is missing, duplicated or unknown, a declared step failed, a record names another commit or misses a manifest file, or a failing undeclared post-step concluded the job failure, each while the rest stays green (C-F5 C-F6 C-F7 C-F8 C-F10)", { timeout: 900_000 }, async () => {
    const root = scratch("tickmarkr-release-gate-grade-");
    try {
      const { c, run, listed } = releaseRunner(root);
      const green = recordedRun(c.head);
      // the run list reads one completed successful run each time: only the grader's read of that run differs
      const cases: Array<[label: string, run: GhRun, artifacts: Artifacts, rc: number, grades: Record<string, string>]> = [
        ["C-F5 one OS proof group missing", green, greenArtifacts(c, { "proof-test-macos": null }), 2, { test: "GREEN", "test-macos": "UNREADABLE" }],
        ["C-F6 a job missing", { ...green, jobs: green.jobs.filter((job) => job.name !== "test-macos") }, greenArtifacts(c), 2, { test: "GREEN" }],
        ["C-F6 a job duplicated", { ...green, jobs: [...green.jobs, structuredClone(green.jobs.find((job) => job.name === "test")!)] }, greenArtifacts(c), 2, { "test-macos": "GREEN" }],
        ["C-F6 an unknown job", { ...green, jobs: [...green.jobs, { ...structuredClone(green.jobs[0]!), name: "extra" }] }, greenArtifacts(c), 2, { test: "GREEN", "test-macos": "GREEN" }],
        ["C-F7 a declared step failed", stepped(green, ["test"], STEP.coverage, "failure"), greenArtifacts(c), 1, { test: "RED", "test-macos": "GREEN" }],
        ["C-F8 a record of another commit", green, greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: recordText(c.parent, c.suite) }) }), 2, { test: "UNREADABLE", "test-macos": "GREEN" }],
        ["C-F8 a record missing a manifest file", green, greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: recordText(c.head, c.suite.slice(1)) }) }), 1, { test: "RED", "test-macos": "GREEN" }],
        ["C-F10 a failing undeclared post-step", stepped(green, ["test-macos"], "Post Run actions/checkout@v4", "failure"), greenArtifacts(c), 1, { test: "GREEN", "test-macos": "RED" }],
      ];
      for (const [why, ghRun, artifacts, rc, grades] of cases) {
        const job = await run([listed()], ghRun, artifacts);
        expect(job.failed, `${why}\n${job.out}`).toBe(GATE);
        expect(job.published, why).toBe(false);
        expect(job.npm, why).toEqual(["install -g npm@11", "ci", "run build", "run lint"]);
        expect(job.out, why).toMatch(new RegExp(`^VERDICT rc=${rc} `, "m"));
        for (const [name, grade] of Object.entries(grades)) expect(gradeOf(job.out, name), `${why}: ${name}`).toBe(grade);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
