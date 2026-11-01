import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import {
  candidateCheckout, FLOORS, type GhJob, type GhRun, gradeOf, greenArtifacts, proofGroup, recordedRun, recordedRuns, recordText,
  scratch, SERIAL, STEP, stepped, withJob,
} from "../fixtures/ci/recorded-run.js";

// v2.7.8 T4: grade-ci.sh grades every job of ONE closed inventory — serial {test, test-macos} or the sharded
// twelve. v2.8.2 T3 (ANL-022 §7.2b): it grades a RECORDED run — GitHub's structured run record and each job's
// downloaded proof group — and reads no log; v2.8.2 T7 (ANL-022 §7.4) grades the sharded twelve job by job from each
// OS's six proof groups.
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
  test("test: grade-ci grades a run against the one closed inventory its job names match and reads UNREADABLE naming each missing duplicated or unknown job, an OS-only shard name and an extra failing job included, versus the complete serial inventory and the complete sharded inventory with green records each grading GREEN job by job", { timeout: 600_000 }, async () => {
    const { green, job, jobsRun, grade } = fixture();
    const sharded = () => SHARDED.map((name) => job(name));

    const serialGreen = await grade(green);
    expect(serialGreen.status, serialGreen.stdout).toBe(0);
    expect(serialGreen.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=2");
    expect(serialGreen.stdout).not.toContain("INVENTORY_DEFECT");
    for (const name of SERIAL) expect(gradeOf(serialGreen.stdout, name), name).toBe("GREEN");

    // the complete sharded twelve, every job green (v2.8.2 T7 shipped ANL-022 §7.4's selection, S-P1): each job lists
    // its own kind's declared steps and each OS uploads its six artifacts — four shard records with their blobs, the
    // single-fork record, the aggregate's merge record and floors sidecar — so no defect, and GREEN job by job
    const kindSteps: Record<string, string[]> = {
      suite: ["Run npm ci", "Run npm run build", "Run npm run lint", "Run coverage shard (parallel suite project)", "Upload proof group"],
      "single-fork": ["Run npm ci", "Run npm run build", "Run npm run lint", "Run single-fork projects", "Upload proof group"],
      aggregate: ["Run npm ci", "Download the shard and single-fork proof groups of this OS", "Merge coverage (one coverage map per OS)",
        "Recheck coverage floors", "Check the proof group of this OS", "Upload proof group"],
    };
    const shardedJob = (name: string) => job(name, {
      steps: ["Set up job", "Run actions/checkout@v4", "Run actions/setup-node@v4", ...kindSteps[name.split(" ")[0]!]!, "Complete job"]
        .map((step, i) => ({ name: step, status: "completed", conclusion: "success", number: i + 1 })),
    });
    // fixture()'s candidate tree from its own constructor (the same tracked paths), its records at the run's head;
    // a nested artifact path is its own key, since the gh stand-in serves each key as one directory
    const tree = scratch("tickmarkr-grade-ci-tree-");
    cleanup.push(tree);
    const { suite, singleFork } = candidateCheckout(tree);
    const head = green.headSha;
    const shardedArtifacts: Record<string, Record<string, string>> = {};
    for (const os of OSES) {
      for (const k of [1, 2, 3, 4]) {
        const shard = JSON.parse(recordText(head, suite.filter((_, i) => i % 4 === k - 1))) as Record<string, unknown>;
        shardedArtifacts[`proof-${os}-suite-${k}`] = { [`suite-${k}.log.record.json`]: `${JSON.stringify({ ...shard, shard: { index: k, count: 4 } })}\n` };
        shardedArtifacts[`proof-${os}-suite-${k}/blobs`] = { [`blob-${k}.json`]: `blob ${k}\n` };
      }
      shardedArtifacts[`proof-${os}-single-fork`] = { "single-fork.log.record.json": recordText(head, singleFork) };
      shardedArtifacts[`proof-${os}-aggregate`] = { "floors.out": FLOORS.GREEN };
      shardedArtifacts[`proof-${os}-aggregate/merge`] = { "merge.record.json": recordText(head, suite) };
    }
    const shardedGreen = await grade(jobsRun(SHARDED.map((name) => shardedJob(name))), shardedArtifacts);
    expect(shardedGreen.status, shardedGreen.stdout).toBe(0);
    expect(shardedGreen.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=12");
    expect(shardedGreen.stdout).not.toMatch(/INVENTORY_DEFECT|PROOF_DEFECT/);
    for (const name of SHARDED) {
      expect(gradeOf(shardedGreen.stdout, name), name).toBe("GREEN");
      // its OS's group: four shard records and the single-fork record, ten tracked files once, the merge their union
      expect(shardedGreen.stdout, name).toMatch(new RegExp(`^${name}: steps=\\[[^\\]]*\\] proof=\\[PROOF dir=\\S+ verdict=GREEN head=${head} expected=10 actual=10 records=5 record=CLEAN floors=GREEN merge=GREEN\\]$`, "m"));
    }
    expect(downloads(shardedGreen.calls).map((call) => /-n (\S+)/.exec(call)?.[1]).sort())
      .toEqual(OSES.flatMap((os) => ["suite-1", "suite-2", "suite-3", "suite-4", "single-fork", "aggregate"].map((part) => `proof-${os}-${part}`)).sort());
    expect(shardedGreen.stdout).toContain("VERDICT rc=0");

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

  test("test: a sharded run grades every job under the serial lattice — every job green, a failing shard RED, a cancelled shard INFRA_KILLED, an aggregate still in progress or an absent shard job UNREADABLE, UNREADABLE over RED over INFRA_KILLED — and downloads an OS's six proof groups only when every job of that OS completed readable and uncancelled", { timeout: 600_000 }, async () => {
    const { job, jobsRun, grade } = fixture();
    const cases: [label: string, change: Record<string, Partial<GhJob>>][] = [
      ["every job green", {}],
      ["a failing shard", { "suite ubuntu-latest 2/4": { conclusion: "failure" } }],
      ["a cancelled shard", { "suite macos-latest 4/4": { conclusion: "cancelled" } }],
      ["an aggregate in progress", { "aggregate macos-latest": { status: "in_progress", conclusion: null } }],
      ["a failing single-fork job beside a cancelled shard", { "single-fork ubuntu-latest": { conclusion: "failure" }, "suite ubuntu-latest 1/4": { conclusion: "cancelled" } }],
    ];
    // v2.8.2 T7 shipped ANL-022 §7.4's selection (S-P1 S-F3): each case now grades every job under the serial lattice
    // — a cancelled job with no failed declared step INFRA_KILLED, a failing job RED, a job short of run-end or a shard
    // job absent UNREADABLE, UNREADABLE over RED over INFRA_KILLED — and an OS's group is downloaded, all six of its
    // artifacts, only when every job of that OS completed with its steps readable and none was cancelled
    const kindSteps: Record<string, string[]> = {
      suite: ["Run npm ci", "Run npm run build", "Run npm run lint", "Run coverage shard (parallel suite project)", "Upload proof group"],
      "single-fork": ["Run npm ci", "Run npm run build", "Run npm run lint", "Run single-fork projects", "Upload proof group"],
      aggregate: ["Run npm ci", "Download the shard and single-fork proof groups of this OS", "Merge coverage (one coverage map per OS)",
        "Recheck coverage floors", "Check the proof group of this OS", "Upload proof group"],
    };
    const shardedJob = (name: string, change: Partial<GhJob> = {}) => job(name, {
      steps: ["Set up job", "Run actions/checkout@v4", "Run actions/setup-node@v4", ...kindSteps[name.split(" ")[0]!]!, "Complete job"]
        .map((step, i) => ({ name: step, status: "completed", conclusion: "success", number: i + 1 })),
      ...change,
    });
    // fixture()'s candidate tree from its own constructor (the same tracked paths), its records at the run's head;
    // a nested artifact path is its own key, since the gh stand-in serves each key as one directory
    const tree = scratch("tickmarkr-grade-ci-tree-");
    cleanup.push(tree);
    const { suite, singleFork } = candidateCheckout(tree);
    const head = jobsRun([]).headSha;
    const shardedArtifacts: Record<string, Record<string, string>> = {};
    for (const os of OSES) {
      for (const k of [1, 2, 3, 4]) {
        const shard = JSON.parse(recordText(head, suite.filter((_, i) => i % 4 === k - 1))) as Record<string, unknown>;
        shardedArtifacts[`proof-${os}-suite-${k}`] = { [`suite-${k}.log.record.json`]: `${JSON.stringify({ ...shard, shard: { index: k, count: 4 } })}\n` };
        shardedArtifacts[`proof-${os}-suite-${k}/blobs`] = { [`blob-${k}.json`]: `blob ${k}\n` };
      }
      shardedArtifacts[`proof-${os}-single-fork`] = { "single-fork.log.record.json": recordText(head, singleFork) };
      shardedArtifacts[`proof-${os}-aggregate`] = { "floors.out": FLOORS.GREEN };
      shardedArtifacts[`proof-${os}-aggregate/merge`] = { "merge.record.json": recordText(head, suite) };
    }
    /** a job's grade line; a job short of run-end prints its reason after the grade */
    const verdictOf = (stdout: string, name: string) =>
      new RegExp(`^${name}: (GREEN|RED|UNREADABLE|INFRA_KILLED)(?: \\(job has not reached run-end\\))?$`, "m").exec(stdout)?.[1];
    type Lattice = { rc: number; os?: Partial<Record<(typeof OSES)[number], string>>; jobs?: Record<string, string> };
    // per case: the exit, each OS's grade where it is not GREEN (its group then never downloaded), each job's own
    const lattice: Record<string, Lattice> = {
      "every job green": { rc: 0 },
      "a failing shard": { rc: 1, jobs: { "suite ubuntu-latest 2/4": "RED" } },
      "a cancelled shard": { rc: 3, os: { "macos-latest": "INFRA_KILLED" } },
      "an aggregate in progress": { rc: 2, os: { "macos-latest": "UNREADABLE" } },
      "a failing single-fork job beside a cancelled shard": { rc: 1, os: { "ubuntu-latest": "INFRA_KILLED" }, jobs: { "single-fork ubuntu-latest": "RED" } },
    };
    const absent = "suite macos-latest 3/4";
    const present = SHARDED.filter((name) => name !== absent);
    const runs: [label: string, change: Record<string, Partial<GhJob>>, names: readonly string[], want: Lattice][] = [
      ...cases.map(([label, change]): [string, Record<string, Partial<GhJob>>, readonly string[], Lattice] => [label, change, SHARDED, lattice[label]!]),
      // an absent shard job is UNREADABLE over a RED and over a kill on the other OS
      ["a shard job absent beside a failing shard", { "suite ubuntu-latest 2/4": { conclusion: "failure" } }, present,
        { rc: 2, os: { "macos-latest": "UNREADABLE" }, jobs: { "suite ubuntu-latest 2/4": "RED" } }],
      ["a shard job absent beside a cancelled shard", { "suite ubuntu-latest 1/4": { conclusion: "cancelled" } }, present,
        { rc: 2, os: { "macos-latest": "UNREADABLE", "ubuntu-latest": "INFRA_KILLED" } }],
    ];
    for (const [label, change, names, want] of runs) {
      const graded = await grade(jobsRun(names.map((name) => shardedJob(name, change[name]))), shardedArtifacts);
      expect(graded.status, `${label}\n${graded.stdout}`).toBe(want.rc);
      expect(graded.stdout.split("\n")[0], label).toBe(`INVENTORY form=sharded declared=12 observed=${names.length}`);
      expect(graded.stdout.match(/^INVENTORY_DEFECT .*$/gm) ?? [], label)
        .toEqual(SHARDED.filter((name) => !names.includes(name)).map((name) => `INVENTORY_DEFECT kind=missing job=${JSON.stringify(name)}`));
      for (const name of names) {
        const os = name.split(" ")[1] as (typeof OSES)[number];
        expect(verdictOf(graded.stdout, name), `${label}: ${name}`).toBe(want.jobs?.[name] ?? want.os?.[os] ?? "GREEN");
      }
      expect(downloads(graded.calls).map((call) => /-n (\S+)/.exec(call)?.[1]).sort(), label)
        .toEqual(OSES.filter((os) => want.os?.[os] === undefined)
          .flatMap((os) => ["suite-1", "suite-2", "suite-3", "suite-4", "single-fork", "aggregate"].map((part) => `proof-${os}-${part}`)).sort());
      expect(graded.stdout, label).toContain(`VERDICT rc=${want.rc}`);
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
