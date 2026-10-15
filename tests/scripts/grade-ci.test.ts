// v2.8.2 T3 (ANL-022 §7.2b): grade-ci.sh grades a RECORDED run — GitHub's structured run record and each job's
// downloaded proof group (tests/fixtures/ci/recorded-run.ts) — bound to the expected head and recomputed by
// `cli.ts proof`; no job log is read. The public CI wrapper's tests stay here beside it, because the badge (the
// wrapper's exit) and the grade read the same record.
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  candidateCheckout, FLOORS, type GhRun, gradeOf, greenArtifacts, proofGroup, recordedRun, recordedRuns, recordText, RUN_ID,
  scratch, SERIAL, STEP, stepped, withJob, withStep,
} from "../fixtures/ci/recorded-run.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
const WRAPPER = join(ROOT, "scripts/run-ci-vitest.sh");
const TWIN_DIR = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts");
const cleanup: string[] = [];

// Q72s birpc-starver class (vitest.config.ts): async spawn, never spawnSync — these tests run dozens of
// children, and a synchronous child blocks this worker's event loop until vitest's RPC times out under load.
type Spawned = { status: number | null; stdout: string; stderr: string };
const bash = (args: string[], options: SpawnOptions = {}) => new Promise<Spawned>((settle, fail) => {
  const child = spawn("bash", args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", fail).on("close", (status) => settle({ status, stdout, stderr }));
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---- Vitest 3.2 log shapes the wrapper stand-ins print: the unhandled block prints BEFORE the file summary,
// whose Errors line counts the same list the block's tally does; the summary ends at its Duration line. Neither
// the wrapper nor the grader reads them — they are the text a run prints beside its record.
const BAR = "⎯⎯⎯⎯⎯⎯";
const banner = (title: string) => `${BAR} ${title} ${BAR}`;
const RPC = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
const summary = (errors = 0, files = "8 passed | 2 skipped (10)", tests = "40 passed | 3 skipped (43)") =>
  [
    "",
    ` Test Files  ${files}`,
    `      Tests  ${tests}`,
    ...(errors ? [`     Errors  ${errors} error${errors > 1 ? "s" : ""}`] : []),
    "   Start at  10:00:00",
    "   Duration  12.00s (transform 1.00s, setup 0ms, collect 2.00s, tests 9.00s)",
    "",
  ].join("\n");
const block = (...payloads: string[]) =>
  [
    banner("Unhandled Errors"),
    "",
    `Vitest caught ${payloads.length} unhandled error${payloads.length > 1 ? "s" : ""} during the test run.`,
    "This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.",
    ...payloads.flatMap((payload) => ["", banner("Unhandled Error"), payload, " ❯ node_modules/vitest/dist/chunks/rpc.js:49:13"]),
    BAR,
    "",
  ].join("\n");

// ---- v2.8.2 T1: the wrapper decides from the run's own record (FORMAT F3), so every wrapper stand-in writes the
// record the run it imitates would write; a stand-in npx answers `vitest list --filesOnly` in its text and
// `--json=<file>` forms from the candidate tree, as Vitest's discovery does
const RPC_ERROR = { name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" };
type RecordEntry = readonly [file: string, project: string, state?: string];
type UnhandledEntry = { name: string | null; message: string; type: string | null };
const ciRecord = (files: readonly RecordEntry[], unhandled: UnhandledEntry[] = [], reason = "passed") => JSON.stringify({
  schema: "tickmarkr-ci-record/2", head: "a".repeat(40), shard: null,
  files: files.map(([file, project, state = "passed"]) => ({ file, project, state, durationMs: 1 })), reason, unhandled,
  tests: files.map(([file, project, state = "passed"]) => ({ file, project, name: "case", state: state === "queued" ? "pending" : state })),
});
/** The same record as the candidate commit's run writes it: the head is the commit's own. */
const rebind = (record: string, head: string) => `${JSON.stringify({ ...JSON.parse(record), head })}\n`;
const STANDIN_NPX = `#!/usr/bin/env bash
[ "$1" = vitest ] || exit 64
case "$2" in
  list)
    [ "$3" = --filesOnly ] || exit 64
    shift 3; json=; projects=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --json=*) json=\${1#--json=} ;;
        --project) projects+=("$2"); shift ;;
        *) exit 64 ;;
      esac; shift
    done
    lines=(); entries=()
    for p in "\${projects[@]}"; do
      [ -d "tests/$p" ] || { echo "No projects matched the filter \\"$p\\"" >&2; exit 1; }
      for f in "tests/$p"/*.test.ts; do lines+=("[$p] $f"); entries+=("{\\"file\\":\\"$PWD/$f\\",\\"projectName\\":\\"$p\\"}"); done
    done
    if [ -n "$json" ]; then (IFS=,; printf '[%s]\\n' "\${entries[*]-}") > "$json"; else printf '%s\\n' "\${lines[@]-}"; fi ;;
  run)
    [ -z "\${FAKE_RECORD_SRC:-}" ] || cp "$FAKE_RECORD_SRC" "$TICKMARKR_CI_RECORD"
    cat "$FAKE_RUN_LOG"; exit "$FAKE_RUN_STATUS" ;;
  *) exit 64 ;;
esac
`;
const STANDIN_NPM = `#!/usr/bin/env bash
[ "$1 $2" = "run test:coverage" ] || exit 64
[ -z "\${FAKE_RECORD_SRC:-}" ] || cp "$FAKE_RECORD_SRC" "$TICKMARKR_CI_RECORD"
cat "$FAKE_RUN_LOG"; exit "$FAKE_RUN_STATUS"
`;
/** A candidate tree owning `projects` (tests/<project>/f<i>.test.ts) with the stand-ins in its .bin. */
function candidateTree(root: string, projects: Record<string, number>): { tree: string; bin: string } {
  const tree = join(root, "tree");
  for (const [project, files] of Object.entries(projects)) {
    mkdirSync(join(tree, "tests", project), { recursive: true });
    for (let i = 1; i <= files; i++) writeFileSync(join(tree, "tests", project, `f${i}.test.ts`), "");
  }
  const bin = join(tree, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npx"), STANDIN_NPX);
  writeFileSync(join(bin, "npm"), STANDIN_NPM);
  chmodSync(join(bin, "npx"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  return { tree, bin };
}
const SUITE_FILES: RecordEntry[] = Array.from({ length: 10 }, (_, i) => [`tests/suite/f${i + 1}.test.ts`, "suite"]);

/** A scratch root holding a candidate checkout (the mirror clone stand-in) and the recorded runs' gh. */
function recorded(files?: Parameters<typeof candidateCheckout>[1]) {
  const root = scratch("tickmarkr-grade-ci-");
  cleanup.push(root);
  const c = candidateCheckout(root, files);
  return { root, c, ...recordedRuns(root) };
}
const downloads = (calls: readonly string[]) => calls.filter((call) => call.startsWith("run download "));
const logReads = (calls: readonly string[]) => calls.filter((call) => / --log( |$)| --job /.test(` ${call} `));

/** The fixture run's declared steps, read from the parsed public workflow as GitHub names them. */
function workflowSteps(job: string): string[] {
  const workflow = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.public.yml"), "utf8")) as {
    jobs: Record<string, { steps: { name?: string; run?: string; uses?: string }[] }>;
  };
  return workflow.jobs[job]!.steps.map((step) => step.name ?? `Run ${(step.run ?? step.uses ?? "").trim().split("\n")[0]}`);
}
const PLATFORM_STEP = /^(Set up job|Complete job|Post .+)$/;

/** The public CI wrapper over the coverage form's stand-in in a candidate tree whose suite project owns the ten
 * files the summaries count: the run writes `record` (none when null), prints the raw log and exits `status`. */
function wrapperFixture(root: string) {
  const { tree, bin } = candidateTree(root, { suite: 10 });
  let n = 0;
  const write = (text: string) => {
    const path = join(root, `in-${n++}.txt`);
    writeFileSync(path, text);
    return path;
  };
  return (log: string, status: number, record: string | null) => bash(
    [WRAPPER, join(root, `ci-${n++}.log`), "npm", "run", "test:coverage", "--", "--project", "suite"],
    {
      cwd: tree,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RUN_LOG: write(log), FAKE_RUN_STATUS: String(status),
        FAKE_RECORD_SRC: record === null ? "" : write(record),
      },
    },
  );
}

describe("grade-ci.sh recorded-run controls", () => {
  test("test: the grader refuses a head that is not forty lowercase hex or is absent from the repository directory with exit two before any gh call, and reads UNREADABLE for a run at another head before any download, a run in progress, and a job missing, duplicated or unknown (G-F1 G-F2 G-F3 G-F11)", { timeout: 600_000 }, async () => {
    const { root, c, grade } = recorded();
    const green = recordedRun(c.head);

    // the control: the run at the expected head, every job green, grades GREEN after one read and two downloads
    const control = await grade(c, green, greenArtifacts(c));
    expect(control.status, control.stdout).toBe(0);
    expect(control.calls[0]).toBe(`run view ${RUN_ID} --repo alzahrani-khalid/tickmarkr --json headSha,status,conclusion,jobs`);
    expect(downloads(control.calls)).toHaveLength(2);

    // G-F2: a head that is not forty lowercase hex, or names no commit in the repository directory, or a directory
    // that is no repository: exit 2 and gh is never called
    const tree = execFileSync("git", ["-C", c.dir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const notGit = join(root, "not-a-repository");
    mkdirSync(notGit);
    const refusals: [label: string, sha: string, repo: string][] = [
      ["short", c.head.slice(0, 39), c.dir],
      ["long", `${c.head}0`, c.dir],
      ["uppercase", c.head.toUpperCase(), c.dir],
      ["not hex", "g".repeat(40), c.dir],
      ["empty", "", c.dir],
      ["a trailing newline", `${c.head}\n`, c.dir],
      ["absent from the repository", "1".repeat(40), c.dir],
      ["a tree, not a commit", tree, c.dir],
      ["a directory that is no repository", c.head, notGit],
      ["a directory that does not exist", c.head, join(root, "absent")],
    ];
    for (const [label, sha, repo] of refusals) {
      const refused = await grade(c, green, greenArtifacts(c), { sha, repo });
      expect(refused.status, `${label}\n${refused.stdout}`).toBe(2);
      expect(refused.calls, label).toEqual([]);
      expect(refused.stdout, label).not.toMatch(/GREEN|^VERDICT/m);
    }

    // G-F1: a run of another head — a commit the repository holds, with green steps and green records of the
    // expected head — reads UNREADABLE after the one read, before any download
    const otherHead = await grade(c, { ...green, headSha: c.parent }, greenArtifacts(c));
    expect(otherHead.status, otherHead.stdout).toBe(2);
    expect(otherHead.stdout).toContain(`RUN head=${c.parent} expected=${c.head} status=completed conclusion=success`);
    expect(otherHead.stdout).toMatch(/^RUN: UNREADABLE \(the run's head is not the expected head; nothing downloaded\)$/m);
    expect(otherHead.stdout).not.toMatch(/^test(-macos)?: GREEN$/m);
    expect(otherHead.calls).toHaveLength(1);
    expect(downloads(otherHead.calls)).toEqual([]);
    // and the expected head graded against that run's records of the parent reads UNREADABLE too (wrong-head)
    const staleRecords = await grade(c, green, greenArtifacts(c, {
      "proof-test": proofGroup(c, { coverage: recordText(c.parent, c.suite), singleFork: recordText(c.parent, c.singleFork) }),
    }));
    expect(staleRecords.status, staleRecords.stdout).toBe(2);
    expect(gradeOf(staleRecords.stdout, "test")).toBe("UNREADABLE");

    // G-F3: a run in progress — its own status, whatever its jobs say — reads UNREADABLE before any download
    const inProgress = withJob({ ...green, status: "in_progress", conclusion: null }, "test", (job) => ({ ...job, status: "in_progress", conclusion: null }));
    for (const run of [inProgress, { ...green, status: "queued", conclusion: null }]) {
      const graded = await grade(c, run, greenArtifacts(c));
      expect(graded.status, graded.stdout).toBe(2);
      expect(graded.stdout).toMatch(/^RUN: UNREADABLE \(the run has not reached run-end; nothing downloaded\)$/m);
      expect(downloads(graded.calls)).toEqual([]);
    }
    // a completed run holding a job still in progress: that job is UNREADABLE and its group is never downloaded
    const jobInProgress = await grade(c, withJob(green, "test-macos", (job) => ({ ...job, status: "in_progress", conclusion: null })), greenArtifacts(c));
    expect(jobInProgress.status, jobInProgress.stdout).toBe(2);
    expect(jobInProgress.stdout).toMatch(/^test-macos: UNREADABLE \(job has not reached run-end\)$/m);
    expect(downloads(jobInProgress.calls).some((call) => call.includes("proof-test-macos"))).toBe(false);

    // G-F11: a job missing, duplicated or unknown — every other job green — reads UNREADABLE by the inventory
    const [macos, linux] = [green.jobs.find((job) => job.name === "test-macos")!, green.jobs.find((job) => job.name === "test")!];
    const inventories: [label: string, run: GhRun, defects: string[], first: string][] = [
      ["missing", { ...green, jobs: [linux] }, ['INVENTORY_DEFECT kind=missing job="test-macos"'], "INVENTORY form=serial declared=2 observed=1"],
      ["duplicated", { ...green, jobs: [linux, macos, { ...linux, databaseId: 7 }] }, ['INVENTORY_DEFECT kind=duplicate job="test"'], "INVENTORY form=serial declared=2 observed=3"],
      ["unknown", { ...green, jobs: [linux, macos, { ...linux, name: "lint", databaseId: 8 }] }, ['INVENTORY_DEFECT kind=unknown job="lint"'], "INVENTORY form=serial declared=2 observed=3"],
      ["empty", { ...green, jobs: [] }, ['INVENTORY_DEFECT kind=missing job="test"', 'INVENTORY_DEFECT kind=missing job="test-macos"'], "INVENTORY form=serial declared=2 observed=0"],
    ];
    for (const [label, run, defects, first] of inventories) {
      const graded = await grade(c, run, greenArtifacts(c));
      expect(graded.status, `${label}\n${graded.stdout}`).toBe(2);
      expect(graded.stdout.split("\n")[0], label).toBe(first);
      expect(graded.stdout.match(/^INVENTORY_DEFECT .*$/gm), label).toEqual(defects);
      expect(graded.stdout, label).toContain("VERDICT rc=2");
      expect(graded.stdout, label).not.toMatch(/^lint: GREEN$/m);
    }
  });

  test("test: the grader grades a completed run at the expected head GREEN only when the run and every job concluded success, every declared step is present once and succeeded and each OS proof group recomputes GREEN, an RPC-only group included only while its set is complete, and otherwise RED, UNREADABLE or INFRA KILLED by the closed table (G-P1 G-P3 G-P5 G-F4 G-F5 G-F6 G-F7 G-F8 G-F9 G-F10 G-F13 G-F14)", { timeout: 900_000 }, async () => {
    const { c, grade } = recorded();
    const green = recordedRun(c.head);
    const proofLine = (stdout: string, job: string) => new RegExp(`^${job}: steps=\\[[^\\]]*\\] proof=\\[(.*)\\]$`, "m").exec(stdout)?.[1] ?? "";

    // G-P1: the recorded run is the public workflow's serial run — its declared steps are the workflow's own, as
    // GitHub names them — and with every step success and both groups green it grades GREEN, job by job
    for (const job of SERIAL) {
      const listed = green.jobs.find((entry) => entry.name === job)!.steps.map((step) => step.name).filter((name) => !PLATFORM_STEP.test(name));
      expect(listed, job).toEqual(workflowSteps(job));
    }
    const p1 = await grade(c, green, greenArtifacts(c));
    expect(p1.status, p1.stdout).toBe(0);
    expect(p1.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=2");
    for (const job of SERIAL) {
      expect(gradeOf(p1.stdout, job), job).toBe("GREEN");
      expect(proofLine(p1.stdout, job), job).toMatch(new RegExp(`^PROOF dir=\\S+ verdict=GREEN head=${c.head} expected=10 actual=10 records=2 record=CLEAN floors=GREEN$`));
      expect(p1.stdout, job).toContain(`${job}: steps=[Run npm ci: success | Run npm run build: success | Run npm run lint: success | ${STEP.coverage}: success | ${STEP.floors}: success | ${STEP.singleFork}: success | ${STEP.set}: success | ${STEP.upload}: success]`);
    }
    expect(p1.stdout).toMatch(/^VERDICT rc=0 /m);

    // G-P3: the coverage record's only unhandled error carries the observed RPC shape (D-1974: name Error, the
    // exact message, type Unhandled Error, reason passed) over a complete set: GREEN
    const rpcOnly = recordText(c.head, c.suite, { unhandled: [{ name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" }] });
    const p3 = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: rpcOnly }) }));
    expect(p3.status, p3.stdout).toBe(0);
    expect(proofLine(p3.stdout, "test")).toMatch(/ verdict=GREEN .* expected=10 actual=10 records=2 record=RPC_ONLY floors=GREEN$/);
    // G-F14: the same group missing the module the RPC timeout stranded reads RED through the set recompute
    const stranded = recordText(c.head, c.suite.slice(1), { unhandled: [{ name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" }] });
    const f14 = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: stranded }) }));
    expect(f14.status, f14.stdout).toBe(1);
    expect(gradeOf(f14.stdout, "test")).toBe("RED");
    expect(proofLine(f14.stdout, "test")).toMatch(/ verdict=RED .* expected=10 actual=9 records=2 record=RPC_ONLY floors=GREEN$/);
    expect(f14.stdout).toMatch(new RegExp(`^test: PROOF_DEFECT \\{"dir":"[^"]+","kind":"missing","file":"${c.suite[0]![0]}"\\}$`, "m"));
    expect(gradeOf(f14.stdout, "test-macos")).toBe("GREEN");
    // the RPC shape near-misses and a real unhandled error beside the timeout never pass as RPC-only
    for (const unhandled of [
      [{ name: "TypeError", message: "boom", type: "Unhandled Error" }],
      [{ name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" }, { name: "TypeError", message: "boom", type: "Unhandled Error" }],
      [{ name: "TypeError", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" }],
    ]) {
      const graded = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: recordText(c.head, c.suite, { unhandled }), log: block(RPC) + summary(1) }) }));
      expect(graded.status, graded.stdout).toBe(1);
      expect(proofLine(graded.stdout, "test")).toMatch(/ verdict=RED .* record=RED floors=GREEN$/);
    }

    // G-P5: a test red — the coverage step's wrapper exited 1 — while the floors sidecar stays GREEN: RED, the
    // floors verdict shown on the job's proof line
    const failed = recordText(c.head, [[c.suite[0]![0], "suite", "failed"], ...c.suite.slice(1)], { reason: "failed" });
    const p5 = await grade(c, stepped(green, ["test"], STEP.coverage, "failure"), greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: failed }) }));
    expect(p5.status, p5.stdout).toBe(1);
    expect(gradeOf(p5.stdout, "test")).toBe("RED");
    expect(proofLine(p5.stdout, "test")).toMatch(/ verdict=RED .* record=RED floors=GREEN$/);
    expect(p5.stdout).toContain(`${STEP.coverage}: failure`);
    // G-F5: the same failed record under steps that all report success (a laundered badge): RED from the record
    const f5 = await grade(c, green, greenArtifacts(c, { "proof-test-macos": proofGroup(c, { coverage: failed }) }));
    expect(f5.status, f5.stdout).toBe(1);
    expect(gradeOf(f5.stdout, "test-macos")).toBe("RED");
    // G-F6: records missing a tracked file while the job's in-job set step succeeded: RED, the reader's recompute
    const short = recordText(c.head, c.singleFork.slice(0, -1));
    const f6 = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { singleFork: short }) }));
    expect(f6.status, f6.stdout).toBe(1);
    expect(f6.stdout).toContain(`${STEP.set}: success`);
    expect(proofLine(f6.stdout, "test")).toMatch(/ verdict=RED .* expected=10 actual=9 records=2 record=CLEAN floors=GREEN$/);
    // a RED floors sidecar beside a successful floors step is RED too: the sidecar, not the step, is read
    const redFloors = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { floors: FLOORS.RED }) }));
    expect(redFloors.status, redFloors.stdout).toBe(1);
    expect(proofLine(redFloors.stdout, "test")).toMatch(/ verdict=RED .* record=CLEAN floors=RED$/);

    // G-F4: one job's proof artifact missing (never uploaded, or expired): UNREADABLE
    const f4 = await grade(c, green, greenArtifacts(c, { "proof-test-macos": null }));
    expect(f4.status, f4.stdout).toBe(2);
    expect(gradeOf(f4.stdout, "test-macos")).toBe("UNREADABLE");
    expect(proofLine(f4.stdout, "test-macos")).toBe("MISSING: artifact proof-test-macos not downloaded");
    expect(gradeOf(f4.stdout, "test")).toBe("GREEN");
    // a group without its floors sidecar, or without any record, is UNREADABLE as well
    for (const group of [proofGroup(c, { floors: null }), proofGroup(c, { coverage: null, singleFork: null })]) {
      const graded = await grade(c, green, greenArtifacts(c, { "proof-test": group }));
      expect(graded.status, graded.stdout).toBe(2);
      expect(gradeOf(graded.stdout, "test")).toBe("UNREADABLE");
    }

    // G-F7: a declared step failure while both proof groups are GREEN: RED
    for (const step of [STEP.lint, STEP.coverage, STEP.floors, STEP.singleFork, STEP.set, STEP.upload]) {
      const graded = await grade(c, stepped(green, ["test"], step, "failure"), greenArtifacts(c));
      expect(graded.status, `${step}\n${graded.stdout}`).toBe(1);
      expect(gradeOf(graded.stdout, "test"), step).toBe("RED");
      expect(proofLine(graded.stdout, "test"), step).toMatch(/ verdict=GREEN /);
    }
    // a declared step skipped (never run) is not success either
    expect((await grade(c, stepped(green, ["test"], STEP.floors, "skipped"), greenArtifacts(c))).status).toBe(1);

    // G-F8: a job concluded cancelled: INFRA_KILLED, rc 3 — never GREEN, never mistaken for UNREADABLE
    const cancelledRun = withJob({ ...green, conclusion: "cancelled" }, "test", (job) => ({ ...withStep(withStep(job, STEP.singleFork, "cancelled"), STEP.set, "skipped"), conclusion: "cancelled" }));
    const f8 = await grade(c, cancelledRun, greenArtifacts(c));
    expect(f8.status, f8.stdout).toBe(3);
    expect(gradeOf(f8.stdout, "test")).toBe("INFRA_KILLED");
    expect(gradeOf(f8.stdout, "test-macos")).toBe("GREEN");
    expect(f8.stdout).toMatch(/^VERDICT rc=3 /m);

    // G-F9: a record whose head is another commit: UNREADABLE
    const f9 = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { singleFork: recordText(c.parent, c.singleFork) }) }));
    expect(f9.status, f9.stdout).toBe(2);
    expect(gradeOf(f9.stdout, "test")).toBe("UNREADABLE");
    expect(f9.stdout).toMatch(/^test: PROOF_DEFECT \{[^\n]*"kind":"wrong-head"/m);

    // G-F10: a declared step missing from the job's step list, or listed twice: UNREADABLE, and nothing downloaded
    // for that job — an undeclared step that succeeded never stands in for it
    const renamed = withJob(green, "test", (job) => ({ ...job, steps: job.steps.map((step) => (step.name === STEP.floors ? { ...step, name: `${STEP.floors} (copy)` } : step)) }));
    const twice = withJob(green, "test", (job) => ({ ...job, steps: [...job.steps, job.steps.find((step) => step.name === STEP.set)!] }));
    for (const [label, run, shown] of [[`renamed`, renamed, `${STEP.floors}: MISSING`], ["twice", twice, `${STEP.set}: MULTIPLE(2)`]] as const) {
      const graded = await grade(c, run, greenArtifacts(c));
      expect(graded.status, `${label}\n${graded.stdout}`).toBe(2);
      expect(gradeOf(graded.stdout, "test"), label).toBe("UNREADABLE");
      expect(graded.stdout, label).toContain(shown);
      expect(downloads(graded.calls).some((call) => call.includes("-n proof-test ")), label).toBe(false);
    }

    // G-F13: a failing undeclared post-step concludes the job and the run failure while every declared step and
    // proof group is GREEN: RED from the conclusions
    const f13 = await grade(c, stepped(green, ["test-macos"], "Post Run actions/checkout@v4", "failure"), greenArtifacts(c));
    expect(f13.status, f13.stdout).toBe(1);
    expect(gradeOf(f13.stdout, "test-macos")).toBe("RED");
    expect(proofLine(f13.stdout, "test-macos")).toMatch(/ verdict=GREEN /);
    // a run whose own conclusion is not success while every job reads GREEN is RED; a cancelled run is INFRA_KILLED
    const runFailed = await grade(c, { ...green, conclusion: "failure" }, greenArtifacts(c));
    expect(runFailed.status, runFailed.stdout).toBe(1);
    expect(runFailed.stdout).toMatch(/^RUN: RED \(run conclusion failure with every job GREEN\)$/m);
    expect((await grade(c, { ...green, conclusion: "cancelled" }, greenArtifacts(c))).status).toBe(3);
  });

  test("test: a job log whose every line is labelled UNKNOWN STEP and a job whose tests printed timeout text and tsc-shaped error annotations both grade GREEN from their records, and the grader makes no log request at all (G-P2 G-P4)", { timeout: 600_000 }, async () => {
    const { c, serve, exec, grade } = recorded();
    const green = recordedRun(c.head);
    const ids = Object.fromEntries(green.jobs.map((job) => [job.name, job.databaseId]));
    const ts = "2026-10-14T17:31:05.0000000Z";
    // G-P2: the job log gh returns for the Linux job of 38440067387 labels every line UNKNOWN STEP — the green
    // verdict lines included — while the run's step list is correct (ANL-022 X3, X4)
    const unknownStep = [
      "##[group]Run npm run test:coverage -- --project suite", " Test Files  6 passed (6)", "##[endgroup]",
      "COVERAGE_FLOORS verdict=GREEN floors=2 failing=0", 'SET_ORACLE verdict=GREEN expected=10 actual=10 defects=0',
      "##[group]Run actions/upload-artifact@v4", "Artifact proof-test has been successfully uploaded!", "##[endgroup]",
    ].map((line) => `test\tUNKNOWN STEP\t${ts} ${line}`).join("\n") + "\n";
    // the bait is real: asked for the job log, the stand-in serves exactly that text
    const dir = serve(green, greenArtifacts(c), { [ids.test!]: unknownStep });
    const asked = await exec(dir, "gh", ["run", "view", "--repo", "alzahrani-khalid/tickmarkr", "--job", String(ids.test), "--log"], c.dir);
    expect(asked.stdout).toBe(unknownStep);
    expect(asked.stdout.trim().split("\n").every((line) => line.split("\t")[1] === "UNKNOWN STEP")).toBe(true);

    const p2 = await grade(c, green, greenArtifacts(c), { logs: { [ids.test!]: unknownStep, [ids["test-macos"]!]: unknownStep.replaceAll("test\t", "test-macos\t") } });
    expect(p2.status, p2.stdout).toBe(0);
    for (const job of SERIAL) expect(gradeOf(p2.stdout, job), job).toBe("GREEN");
    expect(logReads(p2.calls)).toEqual([]);
    expect(p2.calls.every((call) => call.startsWith(`run view ${RUN_ID} `) || call.startsWith(`run download ${RUN_ID} `)), p2.calls.join("\n")).toBe(true);

    // G-P4: a test printed Vitest's timeout text and a tsc-shaped line, and the job log carries the error
    // annotations GitHub minted from them — the records are CLEAN and every step succeeded: GREEN
    const printed = [
      "stdout | tests/suite/f1.test.ts > prints", "Error: Test timed out in 5000ms.", "src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      " FAIL  tests/slow.test.ts > waits", " Test Files  1 failed | 5 passed (6)",
    ].join("\n");
    const annotated = [
      "Run coverage proof (parallel suite project)", printed, "##[error]src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "##[error]Process completed with exit code 1.", "COUNT_ORACLE RED expected=10 actual=9", "COVERAGE_FLOORS verdict=RED floors=6 failing=1",
    ].map((line) => `test\t${STEP.coverage}\t${ts} ${line}`).join("\n") + "\n";
    const p4 = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { log: `${printed}\n${summary()}` }) }), {
      logs: { [ids.test!]: annotated, [ids["test-macos"]!]: annotated },
    });
    expect(p4.status, p4.stdout).toBe(0);
    for (const job of SERIAL) expect(gradeOf(p4.stdout, job), job).toBe("GREEN");
    expect(p4.stdout).toMatch(/^test: steps=\[[^\]]*\] proof=\[PROOF dir=\S+ verdict=GREEN .* record=CLEAN floors=GREEN\]$/m);
    expect(logReads(p4.calls)).toEqual([]);
  });

  test("test: the public CI wrapper and grader agree on complete RPC-only green versus mixed unhandled errors coverage threshold misses failed or timed-out tests and truncated logs, so one red fixture classified green fails", { timeout: 900_000 }, async () => {
    const { root, c, grade } = recorded({ suite: 10 });
    const wrap = wrapperFixture(root);
    const rpcOnly = block(RPC) + summary(1);
    // Vitest prints an exception thrown after the summary (here a coverage reporter's) under a lone
    // banner, then exits 1
    const reportCrash = `\n${banner("Unhandled Error")}\nError: ENOENT: no such file or directory, open 'coverage/.tmp/coverage-0.json'\n ❯ node_modules/@vitest/coverage-v8/dist/provider.js:9:9\n\n\n`;
    // the record the run behind each log writes: Vitest writes it at onTestRunEnd, BEFORE it reports coverage, so
    // a threshold miss or a crashed coverage reporter leaves the run's own record; coverage is the floors step's
    // verdict (ANL-022 §8), and the job's badge is the wrapper's exit AND that step's
    const rpcRecord = ciRecord(SUITE_FILES, [RPC_ERROR]);
    const failedRecord = ciRecord([...SUITE_FILES.slice(1), ["tests/suite/f1.test.ts", "suite", "failed"]], [RPC_ERROR], "failed");
    // [name, raw Vitest log, the command's own exit status, green, the run's record (null: none), the floors sidecar]
    const cases: [name: string, log: string, status: number, green: boolean, record: string | null, floors?: string][] = [
      ["complete RPC-only", rpcOnly, 1, true, rpcRecord],
      ["complete clean run", summary(), 0, true, ciRecord(SUITE_FILES)],
      ["mixed unhandled errors", block(RPC, "TypeError: boom") + summary(2), 1, false, ciRecord(SUITE_FILES, [RPC_ERROR, { name: "TypeError", message: "boom", type: "Unhandled Error" }])],
      ["coverage threshold miss", rpcOnly + "ERROR: Coverage for lines (79.21%) does not meet global threshold (80%)\n", 1, false, rpcRecord, FLOORS.RED],
      ["coverage reporting exception after a complete RPC-only summary", rpcOnly + reportCrash, 1, false, rpcRecord, FLOORS.UNREADABLE],
      ["failed test", block(RPC) + summary(1, "1 failed | 7 passed | 2 skipped (10)", "1 failed | 39 passed | 3 skipped (43)"), 1, false, failedRecord],
      [
        "timed-out test",
        " FAIL  tests/slow.test.ts > waits\nError: Test timed out in 5000ms.\n" +
          block(RPC) + summary(1, "1 failed | 7 passed | 2 skipped (10)", "1 failed | 39 passed | 3 skipped (43)"),
        1,
        false,
        failedRecord,
      ],
      // a log cut short is a run that died before its reporter's last call: no record
      ["log truncated inside the summary", rpcOnly.slice(0, rpcOnly.indexOf("   Start at")), 1, false, null],
      ["log truncated inside the unhandled block", rpcOnly.slice(0, rpcOnly.indexOf(RPC)), 1, false, null],
      ["whole block forged on stdout", `stdout | tests/x.test.ts > case\n${block(RPC)}` + summary(), 1, false, ciRecord(SUITE_FILES)],
      // outside the proven exception the command's own status stands: any other code, a signal, exit 1 unexplained
      ["complete passing summary then exit 2", summary(), 2, false, ciRecord(SUITE_FILES)],
      ["complete RPC-only then exit 2", rpcOnly, 2, false, rpcRecord],
      ["complete RPC-only then killed (137) without an npm signal line", rpcOnly, 137, false, rpcRecord],
      ["complete clean summary then exit 1", summary(), 1, false, ciRecord(SUITE_FILES)],
    ];
    for (const [name, log, status, green, record, floors = FLOORS.GREEN] of cases) {
      const ci = await wrap(log, status, record);
      // the recorded run CI produces for that raw outcome: the coverage step concludes as the wrapper exited, the
      // floors step as its producer did (exit 0 only on a GREEN sidecar), and the job uploads that run's record
      // and that sidecar; the job and the run conclude failure when either step failed
      const floorsOk = floors === FLOORS.GREEN;
      let run = recordedRun(c.head);
      if (ci.status !== 0) run = stepped(run, SERIAL, STEP.coverage, "failure");
      if (!floorsOk) run = stepped(run, SERIAL, STEP.floors, "failure");
      const group = proofGroup(c, { coverage: record === null ? null : rebind(record, c.head), floors, log });
      const graded = await grade(c, run, { "proof-test": group, "proof-test-macos": group });
      const badge = ci.status === 0 && floorsOk;
      expect(badge, `${name}: wrapper exit ${ci.status}, floors ${floors}\n${ci.stdout}`).toBe(green);
      if (!green && status !== 1) expect(ci.status, name).toBe(status);
      // the wrapper never reads coverage text: where the floors step owns the red, the run's own record is green
      if (!floorsOk) expect(ci.status, name).toBe(0);
      if (status === 0 || status === 1) expect(ci.stdout, name).toMatch(/^RECORD_VERDICT verdict=\S+ [^\n]*\nSHARD_CONTRACT verdict=\S+ shard=none /m);
      expect(graded.status === 0, `${name}: grader exit ${graded.status}\n${graded.stdout}`).toBe(green);
      expect(graded.stdout, name).toMatch(green ? /^test: GREEN$/m : /^test: (RED|UNREADABLE)$/m);
      if (!green) expect(graded.stdout, name).not.toContain("test: GREEN");
    }

    // a cancelled job never grades GREEN (INFRA_KILLED), nor does a failure no declared step explains (RED)
    const cancelled = await grade(c, stepped(recordedRun(c.head), SERIAL, STEP.singleFork, "cancelled", "cancelled"), greenArtifacts(c));
    expect(cancelled.status, cancelled.stdout).toBe(3);
    expect(cancelled.stdout).not.toMatch(/: GREEN$/m);
    const unexplained = await grade(c, withJob({ ...recordedRun(c.head), conclusion: "failure" }, "test", (job) => ({ ...job, conclusion: "failure" })), greenArtifacts(c));
    expect(unexplained.status, unexplained.stdout).toBe(1);
    expect(unexplained.stdout).toContain("test: RED");
    const accepted = await wrap(rpcOnly, 1, rpcRecord);
    expect(accepted.stdout).toContain("RECORD_VERDICT verdict=RPC_ONLY files=10 tests=10 failed=0 unfinished=0 unhandled=1 rpc=1 reason=passed");
    expect(accepted.stdout).toContain("SHARD_CONTRACT verdict=GREEN shard=none planned=10 recorded=10 defects=0");
  });

  test("test: a complete RPC-only run whose test prints the daemon's normalized timeout fingerprint on stdout is forgiven by the wrapper and graded GREEN, while Vitest's own timed-out message with its millisecond count stays RED, so a classifier that counts a test's printed output as a timed-out test fails", { timeout: 600_000 }, async () => {
    const { root, c, grade } = recorded({ suite: 10 });
    const wrap = wrapperFixture(root);
    // OBS-1106's daemon tests print fingerprints normalized to '#ms'; Vitest's own message always carries digits.
    const printed = "stdout | tests/run/daemon/x.test.ts > case\nfailing tests:\nFAIL tests/slow.test.ts > slow\n\nnew failure fingerprints vs baseline (secondary):\nError: Test timed out in #ms.\n\n";
    const rpcOnly = printed + block(RPC) + summary(1);
    const rpcRecord = ciRecord(SUITE_FILES, [RPC_ERROR]);
    const ci = await wrap(rpcOnly, 1, rpcRecord);
    expect(ci.status, ci.stdout).toBe(0);
    expect(ci.stdout).toContain("RECORD_VERDICT verdict=RPC_ONLY");
    const group = proofGroup(c, { coverage: rebind(rpcRecord, c.head), log: rpcOnly });
    const graded = await grade(c, recordedRun(c.head), { "proof-test": group, "proof-test-macos": group });
    expect(graded.status, graded.stdout).toBe(0);
    expect(graded.stdout).toMatch(/^test: steps=\[[^\]]*\] proof=\[PROOF dir=\S+ verdict=GREEN .* record=RPC_ONLY floors=GREEN\]$/m);
    expect(graded.stdout).toContain("test: GREEN");
    const real = " FAIL  tests/slow.test.ts > waits\nError: Test timed out in 5000ms.\n" + block(RPC)
      + summary(1, "1 failed | 7 passed | 2 skipped (10)", "1 failed | 39 passed | 3 skipped (43)");
    const realRecord = ciRecord([...SUITE_FILES.slice(1), ["tests/suite/f1.test.ts", "suite", "failed"]], [RPC_ERROR], "failed");
    expect((await wrap(real, 1, realRecord)).status).toBe(1);
    const realGroup = proofGroup(c, { coverage: rebind(realRecord, c.head), log: real });
    const realGrade = await grade(c, stepped(recordedRun(c.head), SERIAL, STEP.coverage, "failure"), { "proof-test": realGroup, "proof-test-macos": realGroup });
    expect(realGrade.stdout).toMatch(/^test: steps=\[[^\]]*\] proof=\[PROOF dir=\S+ verdict=RED .* record=RED floors=GREEN\]\ntest: RED$/m);
  });

  test("test: the CI grader returns INFRA_KILLED exit 3 for a cancelled job or step with no failed declared step but RED for a cancel beside a failed declared step, for partial expected files and for a never-started declared project, all read from the recorded run and its records", { timeout: 900_000 }, async () => {
    const { c, grade } = recorded();
    const green = recordedRun(c.head);
    // D-897: the runner died inside the single-fork step — that step cancelled, the set step and the upload never
    // ran — and GitHub concludes the job failure or cancelled
    const killed = (run: GhRun, jobs: readonly string[], concluded: string) =>
      [STEP.set, STEP.upload].reduce((next, step) => stepped(next, jobs, step, "skipped", concluded), stepped(run, jobs, STEP.singleFork, "cancelled", concluded));
    for (const concluded of ["failure", "cancelled"]) {
      const graded = await grade(c, killed(green, SERIAL, concluded), greenArtifacts(c));
      expect(graded.status, `${concluded}\n${graded.stdout}`).toBe(3);
      expect(graded.stdout).toMatch(/^test: INFRA_KILLED$/m);
      expect(graded.stdout).toMatch(/^test-macos: INFRA_KILLED$/m);
      expect(graded.stdout).toContain(`${STEP.singleFork}: cancelled`);
      expect(graded.stdout).not.toMatch(/: (GREEN|UNREADABLE)$/m);
      expect(graded.stdout).toContain("VERDICT rc=3");
      expect(downloads(graded.calls)).toEqual([]);
    }
    // a step's own failing exit dominates the kill: RED, not INFRA_KILLED or UNREADABLE
    for (const step of [STEP.coverage, STEP.lint]) {
      const graded = await grade(c, stepped(killed(green, SERIAL, "failure"), ["test"], step, "failure"), greenArtifacts(c));
      expect(graded.status, `${step}\n${graded.stdout}`).toBe(1);
      expect(graded.stdout, step).toMatch(/^test: RED$/m);
      expect(graded.stdout, step).toMatch(/^test-macos: INFRA_KILLED$/m);
    }
    // partial expected files: the coverage record holds 3 of the suite's 6, every step succeeded — the set
    // recomputed from the commit reds it
    const partial = await grade(c, green, greenArtifacts(c, { "proof-test": proofGroup(c, { coverage: recordText(c.head, c.suite.slice(0, 3)) }) }));
    expect(partial.status, partial.stdout).toBe(1);
    expect(partial.stdout).toMatch(/^test: steps=\[[^\]]*\] proof=\[PROOF dir=\S+ verdict=RED .* expected=10 actual=7 /m);
    // a never-started declared project: the single-fork record holds none of built-cli's files
    const noBuiltCli = recordText(c.head, c.singleFork.filter(([, project]) => project !== "built-cli"));
    const neverStarted = await grade(c, green, greenArtifacts(c, { "proof-test-macos": proofGroup(c, { singleFork: noBuiltCli }) }));
    expect(neverStarted.status, neverStarted.stdout).toBe(1);
    expect(neverStarted.stdout).toMatch(/^test-macos: PROOF_DEFECT \{[^\n]*"kind":"missing","file":"tests\/built-cli\/f1\.test\.ts"\}$/m);
    expect(neverStarted.stdout).toMatch(/^test-macos: RED$/m);
    // mixed jobs: a red job dominates a killed one, an unreadable one stays unknown, a green one leaves the kill
    const killedLinux = killed(green, ["test"], "failure");
    expect((await grade(c, stepped(killedLinux, ["test-macos"], STEP.coverage, "failure"), greenArtifacts(c))).status).toBe(1);
    expect((await grade(c, killedLinux, greenArtifacts(c, { "proof-test-macos": null }))).status).toBe(2);
    const mixedGreen = await grade(c, killedLinux, greenArtifacts(c));
    expect(mixedGreen.stdout).toMatch(/^test-macos: GREEN$/m);
    expect(mixedGreen.status).toBe(3);
  });

  test("unchanged public CI invocation forms derive candidate-tree file and project contracts through the production wrapper so seven of ten files or a never-started built-cli project stays RED while complete RPC-only exit one keeps its narrow exception", async () => {
    // the forms are read from the public workflow itself: the same two wrapped commands in both jobs,
    // passing nothing but a log and the command
    const workflow = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.public.yml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    const forms = new Set<string>();
    for (const job of ["test", "test-macos"]) {
      const wrapped = workflow.jobs[job].steps
        .map((step) => /^bash scripts\/run-ci-vitest\.sh "[^"]+" (.+)$/.exec((step.run ?? "").trim())?.[1])
        .filter((command): command is string => command !== undefined);
      expect(wrapped, job).toHaveLength(2);
      for (const command of wrapped) forms.add(command);
    }
    const [coverageForm, singleForkForm] = [...forms].sort();
    expect([coverageForm, singleForkForm]).toEqual([
      "npm run test:coverage -- --project suite",
      "npx vitest run --project sync-heavy --project keys-ledger --project built-cli --project signal-reaper",
    ]);

    // the candidate tree: each project owns tests/<project>/*.test.ts, 10 per form; the stand-ins answer
    // `npx vitest list --filesOnly --project …` (text and --json=<file>) from it and fail on an unknown project, and
    // `npx vitest run …` / `npm run test:coverage …` write the scripted record, print the scripted log and exit the
    // scripted status
    const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-ci-candidate-"));
    cleanup.push(scratch);
    const owned: Record<string, number> = { suite: 10, "sync-heavy": 2, "keys-ledger": 2, "built-cli": 4, "signal-reaper": 2 };
    const { tree, bin } = candidateTree(scratch, owned);
    const filesOf = (form: string): RecordEntry[] => [...form.matchAll(/--project (\S+)/g)].flatMap(([, project]) =>
      Array.from({ length: owned[project!]! }, (_, i): RecordEntry => [`tests/${project}/f${i + 1}.test.ts`, project!]));
    let k = 0;
    const ci = (form: string, recorded: readonly RecordEntry[], status: number, wrapper = WRAPPER, printed = "", unhandled = [RPC_ERROR]) => {
      // the lean CI dot reporter: no per-file or per-project line, only the summary (and any test output)
      const log = join(tree, `run-${k}.log`);
      writeFileSync(log, ` RUN  v3.2.7 ${tree}\n\n${"·".repeat(recorded.length * 3)}${printed}\n\n` + block(RPC)
        + summary(1, `${recorded.length} passed (${recorded.length})`, `${recorded.length * 3} passed (${recorded.length * 3})`));
      const record = join(tree, `run-${k}.record.json`);
      writeFileSync(record, ciRecord(recorded, unhandled));
      return bash([wrapper, join(tree, `ci-${k++}.log`), ...form.split(" ")], {
        cwd: tree,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RUN_LOG: log, FAKE_RUN_STATUS: String(status), FAKE_RECORD_SRC: record },
      });
    };

    for (const form of [coverageForm, singleForkForm]) {
      const every = filesOf(form);
      expect(every, form).toHaveLength(10);
      const complete = await ci(form, every, 1);
      expect(complete.status, `${form}\n${complete.stdout}${complete.stderr}`).toBe(0);
      expect(complete.stdout).toContain("SHARD_CONTRACT verdict=GREEN shard=none planned=10 recorded=10 defects=0");
      expect(complete.stdout).toContain("RECORD_VERDICT verdict=RPC_ONLY");
      expect(complete.stdout).toContain("run-ci-vitest: exit 1 -> 0");
      // seven of ten: the record verdict alone reads RPC_ONLY, the set reds it
      const seven = await ci(form, every.slice(0, 7), 1);
      expect(seven.status, `${form}\n${seven.stdout}`).toBe(1);
      expect(seven.stdout).toContain("SHARD_CONTRACT verdict=RED shard=none planned=10 recorded=7 defects=3");
      // Vitest's "(10)" also counts the queued and running files an abort left unfinished: a total that matches
      // discovery is not completion when only seven of the ten finished
      const unfinished = await ci(form, every.map(([file, project], i): RecordEntry => [file, project, i < 7 ? "passed" : "queued"]), 1);
      expect(unfinished.status, `${form}\n${unfinished.stdout}`).toBe(1);
      expect(unfinished.stdout).toContain("SHARD_CONTRACT verdict=RED shard=none planned=10 recorded=10 defects=3");
      expect(unfinished.stdout).toMatch(/^RECORD_VERDICT verdict=RED .* unfinished=6 /m);
      // outside 0 and 1 the command's own status stands, as before; status 0 takes a CLEAN record
      expect((await ci(form, every, 0, WRAPPER, "", [])).status).toBe(0);
      expect((await ci(form, every.slice(0, 7), 2)).status).toBe(2);
    }
    // a complete RPC-only proof whose test printed project-looking stdout keeps the narrow exception: printed text
    // is test output, never a record of built-cli starting without its peers
    const printedLabel = "stdout | tests/built-cli/f1.test.ts > prints\nexample: ✓ |built-cli| tests/cli/bin.test.ts\n\n"
      + " ✓ |built-cli| tests/cli/bin.test.ts (1 test) 3ms\n\n······";
    const printed = await ci(singleForkForm, filesOf(singleForkForm), 1, WRAPPER, printedLabel);
    expect(printed.status, printed.stdout).toBe(0);
    expect(printed.stdout).toContain("run-ci-vitest: exit 1 -> 0");
    expect(printed.stdout).toContain("RECORD_VERDICT verdict=RPC_ONLY files=10 tests=10 failed=0 unfinished=0 unhandled=1 rpc=1 reason=passed");
    // built-cli's 4 files never started: the other three single-fork projects recorded their 6, and the same
    // printed label does not start it
    const withoutBuiltCli = filesOf(singleForkForm).filter(([, project]) => project !== "built-cli");
    for (const output of ["", printedLabel]) {
      const noBuiltCli = await ci(singleForkForm, withoutBuiltCli, 1, WRAPPER, output);
      expect(noBuiltCli.status, noBuiltCli.stdout).toBe(1);
      expect(noBuiltCli.stdout).toContain("SHARD_CONTRACT verdict=RED shard=none planned=10 recorded=6 defects=4");
      expect(noBuiltCli.stdout).toContain('SHARD_CONTRACT_DEFECT {"kind":"missing","file":"tests/built-cli/f1.test.ts","project":"built-cli"}');
    }

    // the derived set contract is what holds the line: the same wrapper without it launders seven of ten
    const blind = join(scratch, ".blind");
    mkdirSync(join(blind, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts/ci"), join(blind, "scripts/ci"), { recursive: true });
    symlinkSync(realpathSync(join(ROOT, "node_modules")), join(blind, "node_modules"), "dir");
    writeFileSync(join(blind, "package.json"), '{"type":"module"}\n'); // the checkout's tooling is ESM, as the repository's is
    const source = readFileSync(WRAPPER, "utf8");
    const contractBlind = source.replace(' && [ "$contract" = GREEN ]', "");
    expect(contractBlind).not.toBe(source);
    writeFileSync(join(blind, "scripts/run-ci-vitest.sh"), contractBlind);
    expect((await ci(singleForkForm, filesOf(singleForkForm).slice(0, 7), 1, join(blind, "scripts/run-ci-vitest.sh"))).status).toBe(0);

    // a declared project the candidate tree's discovery cannot find keeps the raw 1 (fail closed)
    rmSync(join(tree, "tests/built-cli"), { recursive: true });
    const undiscovered = await ci(singleForkForm, filesOf(singleForkForm), 1);
    expect(undiscovered.status).toBe(1);
    expect(undiscovered.stdout).toContain("SHARD_CONTRACT verdict=UNREADABLE shard=none planned=UNREADABLE recorded=UNREADABLE defects=0");
  });

  test.skipIf(!existsSync(TWIN_DIR))("the canonical and installed graders are byte-identical executable files (skipped on the exported tree: .claude/skills is absent)", async () => {
    const fs = await import("node:fs");
    const twin = join(TWIN_DIR, "grade-ci.sh");
    expect(fs.readFileSync(twin), twin).toEqual(fs.readFileSync(SCRIPT));
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect(fs.statSync(twin).mode & 0o111).not.toBe(0);
  });
});
