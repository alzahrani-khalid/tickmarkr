import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import {
  candidateCheckout, FLOORS, type GhJob, type GhRun, gradeOf, greenArtifacts, proofGroup, recordedRun, recordedRuns, recordText,
  scratch, SERIAL, STEP, stepped, withJob,
} from "../fixtures/ci/recorded-run.js";

// v2.7.8 T4: grade-ci.sh grades every job of ONE closed inventory — serial {test, test-macos} or the sharded
// twelve. v2.8.2 T3 (ANL-022 §7.2b): it grades a RECORDED run — GitHub's structured run record and each job's
// downloaded proof group — and reads no log; until ANL-022 §7.4 ships the sharded proof-group selection, a run
// holding the sharded inventory reads UNREADABLE after its INVENTORY line.
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OSES = ["ubuntu-latest", "macos-latest"] as const;
const SHARDED = OSES.flatMap((os) => [1, 2, 3, 4].map((k) => `suite ${os} ${k}/4`).concat(`single-fork ${os}`, `aggregate ${os}`));

function fixture() {
  const root = scratch("tickmarkr-grade-ci-inventory-");
  cleanup.push(root);
  const c = candidateCheckout(root);
  const runs = recordedRuns(root);
  const green = recordedRun(c.head);
  const template = green.jobs.find((job) => job.name === "test")!;
  let id = 500;
  /** a green job of the recorded run under another name */
  const job = (name: string, change: Partial<GhJob> = {}): GhJob => ({ ...structuredClone(template), name, databaseId: id++, ...change });
  const jobsRun = (jobs: GhJob[]): GhRun => ({ ...green, jobs });
  const grade = (run: GhRun, artifacts = greenArtifacts(c)) => runs.grade(c, run, artifacts);
  return { c, green, job, jobsRun, grade };
}
const downloads = (calls: readonly string[]) => calls.filter((call) => call.startsWith("run download "));

describe("grade-ci.sh closed inventory", () => {
  test("test: grade-ci grades a run against the one closed inventory its job names match and reads UNREADABLE naming each missing duplicated or unknown job, an OS-only shard name and an extra failing job included, versus the complete serial inventory with green records grading GREEN and the complete sharded inventory reading UNREADABLE after its INVENTORY line until its proof-group selection ships", { timeout: 600_000 }, async () => {
    const { green, job, jobsRun, grade } = fixture();
    const sharded = () => SHARDED.map((name) => job(name));

    const serialGreen = await grade(green);
    expect(serialGreen.status, serialGreen.stdout).toBe(0);
    expect(serialGreen.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=2");
    expect(serialGreen.stdout).not.toContain("INVENTORY_DEFECT");
    for (const name of SERIAL) expect(gradeOf(serialGreen.stdout, name), name).toBe("GREEN");

    // the complete sharded twelve, every job green: no defect, and UNREADABLE straight after the INVENTORY line
    const shardedGreen = await grade(jobsRun(sharded()));
    expect(shardedGreen.status, shardedGreen.stdout).toBe(2);
    expect(shardedGreen.stdout.split("\n").slice(0, 3)).toEqual([
      "INVENTORY form=sharded declared=12 observed=12",
      "SHARDED: UNREADABLE (the sharded proof-group selection is ANL-022 §7.4's and has not shipped)",
      "VERDICT rc=2 (0=all GREEN 1=RED 2=UNREADABLE 3=INFRA_KILLED)",
    ]);
    for (const name of SHARDED) expect(gradeOf(shardedGreen.stdout, name), name).toBeUndefined();
    expect(downloads(shardedGreen.calls)).toEqual([]);

    // a missing shard: every other job green, the run still unreadable
    const missing = await grade(jobsRun(sharded().filter((entry) => entry.name !== "suite macos-latest 3/4")));
    expect(missing.status, missing.stdout).toBe(2);
    expect(missing.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=11");
    expect(missing.stdout).toContain('INVENTORY_DEFECT kind=missing job="suite macos-latest 3/4"');

    // a duplicated aggregate, both copies green
    const duplicate = await grade(jobsRun([...sharded(), job("aggregate ubuntu-latest")]));
    expect(duplicate.status, duplicate.stdout).toBe(2);
    expect(duplicate.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=13");
    expect(duplicate.stdout).toContain('INVENTORY_DEFECT kind=duplicate job="aggregate ubuntu-latest"');

    // an OS-only shard name (a matrix that dropped the shard index) is unknown, and the shard it replaced is missing
    const osOnly = await grade(jobsRun(sharded().map((entry) => (entry.name === "suite ubuntu-latest 1/4" ? { ...entry, name: "suite ubuntu-latest" } : entry))));
    expect(osOnly.status, osOnly.stdout).toBe(2);
    expect(osOnly.stdout).toContain('INVENTORY_DEFECT kind=unknown job="suite ubuntu-latest"');
    expect(osOnly.stdout).toContain('INVENTORY_DEFECT kind=missing job="suite ubuntu-latest 1/4"');

    // an extra failing job beside the green serial pair is never skipped
    const extra = await grade(jobsRun([...green.jobs, job("lint", { conclusion: "failure" })]));
    expect(extra.status, extra.stdout).toBe(2);
    expect(extra.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=3");
    expect(extra.stdout).toContain('INVENTORY_DEFECT kind=unknown job="lint"');
    expect(extra.stdout).not.toMatch(/^lint: GREEN$/m);

    // the serial pair missing a job; a serial pair beside one sharded name is graded as the sharded inventory
    // a successful gh response holding zero jobs is the serial inventory with every job missing, no unknown name
    const empty = await grade(jobsRun([]));
    expect(empty.status, empty.stdout).toBe(2);
    expect(empty.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=0");
    expect(empty.stdout.match(/^INVENTORY_DEFECT .*$/gm)).toEqual([
      'INVENTORY_DEFECT kind=missing job="test"',
      'INVENTORY_DEFECT kind=missing job="test-macos"',
    ]);
    expect(empty.stdout).toContain("VERDICT rc=2");
    const lone = await grade(jobsRun(green.jobs.filter((entry) => entry.name === "test")));
    expect(lone.status, lone.stdout).toBe(2);
    expect(lone.stdout).toContain('INVENTORY_DEFECT kind=missing job="test-macos"');
    const mixed = await grade(jobsRun([...green.jobs, job("aggregate ubuntu-latest")]));
    expect(mixed.status, mixed.stdout).toBe(2);
    expect(mixed.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=3");
    expect(mixed.stdout).toContain('INVENTORY_DEFECT kind=unknown job="test"');
    expect(mixed.stdout).toContain('INVENTORY_DEFECT kind=missing job="single-fork macos-latest"');

    // the job name is JSON-quoted: the @tsv escapes are decoded, then quotes, backslashes and controls re-encoded
    const quoted = await grade(jobsRun([...green.jobs, job('lint "strict" a\\b\tc')]));
    expect(quoted.status, quoted.stdout).toBe(2);
    expect(quoted.stdout).toContain('INVENTORY_DEFECT kind=unknown job="lint \\"strict\\" a\\\\b\\u0009c"');
  });

  test("test: grade-ci reads each declared step's outcome exactly once from the run's structured step list and each verdict from the job's own proof group, so a GREEN verdict line any step printed never decides over a RED record or sidecar, a declared step missing or listed twice reads UNREADABLE, and an undeclared step that succeeded never stands in for a missing one", { timeout: 600_000 }, async () => {
    const { c, green, grade } = fixture();
    // every verdict line the old job-log grader read, printed GREEN by a test into the tee log the group carries
    const printedGreen = "COUNT_ORACLE GREEN expected=10 actual=10\nCOVERAGE_FLOORS verdict=GREEN floors=6 failing=0\nSET_ORACLE verdict=GREEN expected=10 actual=10 defects=0\n";

    const control = await grade(green, greenArtifacts(c, { "proof-test": proofGroup(c, { log: printedGreen }) }));
    expect(control.status, control.stdout).toBe(0);

    // the printed GREEN lines never decide: a record missing a tracked file, and a RED floors sidecar, read RED
    const missingFile = await grade(green, greenArtifacts(c, { "proof-test": proofGroup(c, { log: printedGreen, coverage: recordText(c.head, c.suite.slice(1)) }) }));
    expect(missingFile.status, missingFile.stdout).toBe(1);
    expect(gradeOf(missingFile.stdout, "test")).toBe("RED");
    const redSidecar = await grade(green, greenArtifacts(c, { "proof-test": proofGroup(c, { log: printedGreen, floors: FLOORS.RED }) }));
    expect(redSidecar.status, redSidecar.stdout).toBe(1);
    expect(redSidecar.stdout).toMatch(/^test: steps=\[[^\]]*\] proof=\[PROOF dir=\S+ verdict=RED .* floors=RED\]$/m);

    // a declared step missing, or listed twice, reads UNREADABLE; a step of another name — the retired count
    // step, or the floors step under a suffix — never stands in for it
    const without = (run: GhRun, step: string) => withJob(run, "test", (entry) => ({ ...entry, steps: entry.steps.filter((s) => s.name !== step) }));
    const withExtra = (run: GhRun, name: string) => withJob(run, "test", (entry) => ({
      ...entry, steps: [...entry.steps, { name, conclusion: "success", status: "completed", number: entry.steps.length + 1 }],
    }));
    for (const step of [STEP.coverage, STEP.floors, STEP.singleFork, STEP.set, STEP.upload]) {
      for (const [label, run] of [
        ["missing", without(green, step)],
        ["replaced by the retired count step", withExtra(without(green, step), "Assert collected test-file count")],
        ["replaced under a suffix", withExtra(without(green, step), `${step} (retry)`)],
      ] as const) {
        const graded = await grade(run);
        expect(graded.status, `${step} ${label}\n${graded.stdout}`).toBe(2);
        expect(graded.stdout, `${step} ${label}`).toContain(`${step}: MISSING`);
        expect(gradeOf(graded.stdout, "test"), `${step} ${label}`).toBe("UNREADABLE");
      }
      const twice = await grade(withJob(green, "test", (entry) => ({ ...entry, steps: [...entry.steps, entry.steps.find((s) => s.name === step)!] })));
      expect(twice.status, `${step} twice\n${twice.stdout}`).toBe(2);
      expect(twice.stdout).toContain(`${step}: MULTIPLE(2)`);
    }
    // an undeclared step beside the declared ones changes nothing while it succeeds
    const beside = await grade(withExtra(green, "Assert collected test-file count"));
    expect(beside.status, beside.stdout).toBe(0);
  });

  test("test: a sharded run reads UNREADABLE after its INVENTORY line whatever its jobs report — every job green, a failing shard, a cancelled shard or an aggregate still in progress — and downloads nothing, until ANL-022 section 7.4 ships the sharded proof-group selection", { timeout: 600_000 }, async () => {
    const { job, jobsRun, grade } = fixture();
    const cases: [label: string, change: Record<string, Partial<GhJob>>][] = [
      ["every job green", {}],
      ["a failing shard", { "suite ubuntu-latest 2/4": { conclusion: "failure" } }],
      ["a cancelled shard", { "suite macos-latest 4/4": { conclusion: "cancelled" } }],
      ["an aggregate in progress", { "aggregate macos-latest": { status: "in_progress", conclusion: null } }],
      ["a failing single-fork job beside a cancelled shard", { "single-fork ubuntu-latest": { conclusion: "failure" }, "suite ubuntu-latest 1/4": { conclusion: "cancelled" } }],
    ];
    for (const [label, change] of cases) {
      const graded = await grade(jobsRun(SHARDED.map((name) => job(name, change[name]))));
      expect(graded.status, `${label}\n${graded.stdout}`).toBe(2);
      expect(graded.stdout.split("\n").slice(0, 2), label).toEqual([
        "INVENTORY form=sharded declared=12 observed=12",
        "SHARDED: UNREADABLE (the sharded proof-group selection is ANL-022 §7.4's and has not shipped)",
      ]);
      expect(graded.stdout, label).not.toMatch(/: (GREEN|RED|INFRA_KILLED)$/m);
      expect(downloads(graded.calls), label).toEqual([]);
    }
  });

  test("test: across the serial inventory the exit stays 0 GREEN 1 RED 2 UNREADABLE 3 INFRA_KILLED with UNREADABLE over RED over INFRA_KILLED, a cancelled job with no failed declared step reading INFRA_KILLED versus a RED job beside it reading RED", { timeout: 600_000 }, async () => {
    const { c, green, grade } = fixture();
    const killed = (run: GhRun, job: string) => stepped(stepped(run, [job], STEP.singleFork, "cancelled", "cancelled"), [job], STEP.set, "skipped", "cancelled");
    const redArtifacts = (job: string) => greenArtifacts(c, { [`proof-${job}`]: proofGroup(c, { coverage: recordText(c.head, [[c.suite[0]![0], "suite", "failed"], ...c.suite.slice(1)], { reason: "failed" }) }) });
    const unreadableArtifacts = (job: string) => greenArtifacts(c, { [`proof-${job}`]: null });

    expect((await grade(green)).status).toBe(0);

    const kill = await grade(killed(green, "test"));
    expect(kill.status, kill.stdout).toBe(3);
    expect(gradeOf(kill.stdout, "test")).toBe("INFRA_KILLED");
    expect(gradeOf(kill.stdout, "test-macos")).toBe("GREEN");
    expect(kill.stdout).toContain("VERDICT rc=3");

    const redBeside = await grade(killed(green, "test"), redArtifacts("test-macos"));
    expect(redBeside.status, redBeside.stdout).toBe(1);
    expect(gradeOf(redBeside.stdout, "test")).toBe("INFRA_KILLED");
    expect(gradeOf(redBeside.stdout, "test-macos")).toBe("RED");
    expect(redBeside.stdout).toContain("VERDICT rc=1");

    const unreadableBeside = await grade(killed(green, "test"), unreadableArtifacts("test-macos"));
    expect(unreadableBeside.status, unreadableBeside.stdout).toBe(2);
    expect(gradeOf(unreadableBeside.stdout, "test-macos")).toBe("UNREADABLE");
    expect(unreadableBeside.stdout).toContain("VERDICT rc=2");
    // UNREADABLE over RED, in either order of the jobs
    expect((await grade(green, greenArtifacts(c, { ...redArtifacts("test"), "proof-test-macos": null }))).status).toBe(2);
    expect((await grade(green, greenArtifacts(c, { ...redArtifacts("test-macos"), "proof-test": null }))).status).toBe(2);
    // both killed is INFRA_KILLED; a kill beside the job's own failing step is RED
    expect((await grade(killed(killed(green, "test"), "test-macos"))).status).toBe(3);
    const exitThenKill = await grade(stepped(killed(green, "test"), ["test"], STEP.coverage, "failure", "cancelled"));
    expect(exitThenKill.status, exitThenKill.stdout).toBe(1);
    expect(gradeOf(exitThenKill.stdout, "test")).toBe("RED");
    // an in-progress job is UNREADABLE, never green, even beside a kill
    const inProgress = withJob(killed(green, "test-macos"), "test", (entry) => ({ ...entry, status: "in_progress", conclusion: null }));
    expect((await grade(inProgress)).status).toBe(2);
  });
});
