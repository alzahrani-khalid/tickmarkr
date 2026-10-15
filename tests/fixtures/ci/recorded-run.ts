// v2.8.2 T3 (ANL-022 §7.2b) — a RECORDED public-CI run for grade-ci.sh: GitHub's structured run record
// (serial-run.json, the shape `gh run view <id> --json headSha,status,conclusion,jobs` returns for a green serial
// run of .github/workflows/ci.public.yml) with its head rebound to a scratch candidate commit, the proof group each
// job uploads (`proof-<job>`: the two Vitest records, the floors sidecar and the tee logs), and a gh stand-in on PATH
// that serves exactly that run — `run view --json`, `run download -n -D` and, for a grader that asks, `run view --job
// --log` — and appends every call it receives to a calls file, so a test can prove which reads were made.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedFailures, runOwned } from "../../helpers/owned-process.js";

export const ROOT = realpathSync(join(import.meta.dirname, "../../.."));
export const GRADER = join(ROOT, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
export const RUN_ID = "40000000000";
export const COVERAGE_RECORD = "tickmarkr-test-output.log.record.json";
export const SINGLE_FORK_RECORD = "tickmarkr-test-output-singlefork.log.record.json";
/** The exact RPC timeout shape Vitest 3.2.7 reports (D-1974): name Error, the whole message, type Unhandled Error. */
export const RPC_ERROR = { name: "Error", message: '[vitest-worker]: Timeout calling "onTaskUpdate"', type: "Unhandled Error" };

export type GhStep = { name: string; conclusion: string | null; status: string; number: number; startedAt?: string; completedAt?: string };
export type GhJob = { name: string; status: string; conclusion: string | null; databaseId: number; steps: GhStep[]; [key: string]: unknown };
export type GhRun = { headSha: string; status: string; conclusion: string | null; jobs: GhJob[] };
export type Entry = readonly [file: string, project: string, state?: string];
export type Unhandled = { name: string | null; message: string; type: string | null };
/** published path -> text, or null for an artifact the run never uploaded */
export type Artifacts = Record<string, Record<string, string> | null>;

/** The recorded green serial run with its head rebound to `head`; every call returns a fresh copy. */
export const recordedRun = (head: string): GhRun =>
  ({ ...(JSON.parse(readFileSync(join(import.meta.dirname, "serial-run.json"), "utf8")) as GhRun), headSha: head });
/** `run` with job `name` changed by `change` (a copy; the input is untouched). */
export const withJob = (run: GhRun, name: string, change: (job: GhJob) => GhJob): GhRun =>
  ({ ...run, jobs: run.jobs.map((job) => (job.name === name ? change(structuredClone(job)) : job)) });
/** `job` with step `name`'s conclusion set (a copy). */
export const withStep = (job: GhJob, name: string, conclusion: string | null): GhJob =>
  ({ ...job, steps: job.steps.map((step) => (step.name === name ? { ...step, conclusion } : step)) });

/** `run` with `step` concluding `conclusion` in each of `jobs`, those jobs and the run concluding `concluded`. */
export const stepped = (run: GhRun, jobs: readonly string[], step: string, conclusion: string | null, concluded = "failure"): GhRun => {
  let next = run;
  for (const name of jobs) next = withJob(next, name, (job) => ({ ...withStep(job, step, conclusion), conclusion: concluded }));
  return { ...next, conclusion: concluded };
};
export const SERIAL = ["test", "test-macos"] as const;
export const STEP = {
  lint: "Run npm run lint",
  coverage: "Run coverage proof (parallel suite project)",
  floors: "Recheck coverage floors",
  singleFork: "Run single-fork projects (independent of the step above)",
  set: "Assert collected test-file set",
  upload: "Upload proof group",
} as const;

/** No inherited Vitest, record, git-location or lease variables reach a grader or a git child. */
export const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GIT_")
    && !["TICKMARKR_CI_RECORD", "TICKMARKR_CI_LEAN_REPORTERS", "TICKMARKR_REPOSITORY_LEASE_TOKEN"].includes(key))),
  NO_COLOR: "1", FORCE_COLOR: "0", ...extra,
});
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: childEnv() }).trim();

export type Candidate = { dir: string; head: string; parent: string; suite: Entry[]; singleFork: Entry[] };
/** A scratch candidate checkout (a mirror clone stand-in): tracked test files of the coverage step's `suite`
 * project and of two single-fork projects, plus a tracked helper the manifest must skip; two commits, so a run at
 * the parent is a run of another head that the repository still holds. */
export function candidateCheckout(root: string, files = { suite: 6, "built-cli": 2, "sync-heavy": 2 }): Candidate {
  const dir = join(root, "mirror");
  mkdirSync(join(dir, "tests/helpers"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "candidate\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "parent");
  const parent = git(dir, "rev-parse", "HEAD");
  const suite: Entry[] = [];
  const singleFork: Entry[] = [];
  for (const [project, n] of Object.entries(files)) {
    mkdirSync(join(dir, "tests", project), { recursive: true });
    for (let i = 1; i <= n; i++) {
      const file = `tests/${project}/f${i}.test.ts`;
      writeFileSync(join(dir, file), "");
      (project === "suite" ? suite : singleFork).push([file, project]);
    }
  }
  writeFileSync(join(dir, "tests/helpers/h.ts"), "");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "candidate");
  return { dir, head: git(dir, "rev-parse", "HEAD"), parent, suite, singleFork };
}

/** One FORMAT F3 record: every listed file, one test per file in its file's state (queued reads pending). */
export const recordText = (head: string, entries: readonly Entry[], o: { unhandled?: Unhandled[]; reason?: string } = {}): string => `${JSON.stringify({
  schema: "tickmarkr-ci-record/2", head, shard: null,
  files: entries.map(([file, project, state = "passed"]) => ({ file, project, state, durationMs: 1 })),
  reason: o.reason ?? "passed", unhandled: o.unhandled ?? [],
  tests: entries.map(([file, project, state = "passed"]) => ({ file, project, name: `${file} > case`, state: state === "queued" ? "pending" : state })),
})}\n`;

const floorLine = (glob: string, pct: number) =>
  `COVERAGE_FLOOR ${JSON.stringify({ glob, files: 2, statements: 10, metrics: { lines: { pct, floor: 80, ok: pct >= 80 } }, defects: pct >= 80 ? [] : ["below-floor"] })}`;
/** The floors producer's own sidecar (`cli.ts floors --out`), each form under the floors grammar. */
export const FLOORS = {
  GREEN: `${floorLine("src/gates/**", 91)}\n${floorLine("src/run/**", 88)}\nCOVERAGE_FLOORS verdict=GREEN floors=2 failing=0\n`,
  RED: `${floorLine("src/gates/**", 91)}\n${floorLine("src/run/**", 61)}\nCOVERAGE_FLOORS verdict=RED floors=2 failing=1\n`,
  UNREADABLE: "COVERAGE_FLOORS verdict=UNREADABLE floors=UNREADABLE failing=UNREADABLE\n",
} as const;

/** The proof group one serial job uploads: both Vitest records (a null record was never written), the floors
 * sidecar and the two tee logs, whose text the grader never reads. */
export function proofGroup(c: Candidate, o: { coverage?: string | null; singleFork?: string | null; floors?: string | null; log?: string } = {}): Record<string, string> {
  const group: Record<string, string> = {
    "tickmarkr-test-output.log": o.log ?? " Test Files  6 passed (6)\n",
    "tickmarkr-test-output-singlefork.log": " Test Files  4 passed (4)\n",
  };
  const coverage = o.coverage === undefined ? recordText(c.head, c.suite) : o.coverage;
  const singleFork = o.singleFork === undefined ? recordText(c.head, c.singleFork) : o.singleFork;
  const floors = o.floors === undefined ? FLOORS.GREEN : o.floors;
  if (coverage !== null) group[COVERAGE_RECORD] = coverage;
  if (singleFork !== null) group[SINGLE_FORK_RECORD] = singleFork;
  if (floors !== null) group["floors.out"] = floors;
  return group;
}
/** Both serial jobs' groups, green unless overridden. */
export const greenArtifacts = (c: Candidate, overrides: Artifacts = {}): Artifacts =>
  ({ "proof-test": proofGroup(c), "proof-test-macos": proofGroup(c), ...overrides });

const STAND_IN_GH = `#!/bin/bash
# the recorded run's gh: every call is appended to $GH_CALLS before it is answered
printf '%s\\n' "$*" >> "$GH_CALLS"
[ "$1" = run ] || exit 1
verb=$2; shift 2
id=; json=; name=; dest=; job=; log=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) shift ;;
    --json) json=$2; shift ;;
    -n) name=$2; shift ;;
    -D) dest=$2; shift ;;
    --job) job=$2; shift ;;
    --log) log=1 ;;
    -*) exit 1 ;;
    *) id=$1 ;;
  esac
  shift
done
case $verb in
  view)
    if [ -n "$log" ]; then cat "$GH_RUN_DIR/logs/$job.log"; exit; fi
    [ "$id" = "$GH_RUN_ID" ] && [ "$json" = headSha,status,conclusion,jobs ] || { echo "run $id not found" >&2; exit 1; }
    cat "$GH_RUN_DIR/run.json" ;;
  download)
    [ "$id" = "$GH_RUN_ID" ] && [ -n "$name" ] && [ -n "$dest" ] || exit 1
    [ -d "$GH_RUN_DIR/artifacts/$name" ] || { echo "no valid artifacts found to download" >&2; exit 1; }
    mkdir -p "$dest" && cp -R "$GH_RUN_DIR/artifacts/$name/." "$dest/" ;;
  *) exit 1 ;;
esac
`;

export type Graded = { status: number | null; stdout: string; stderr: string; calls: string[] };
/** A gh stand-in serving one recorded run per `serve` call. `logs` maps a job's databaseId to the job log gh would
 * return for `run view --job <id> --log`. */
export function recordedRuns(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), STAND_IN_GH);
  chmodSync(join(bin, "gh"), 0o755);
  let n = 0;
  const serve = (run: GhRun, artifacts: Artifacts, logs: Record<number, string> = {}): string => {
    const dir = join(root, `run-${n++}`);
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    for (const [name, files] of Object.entries(artifacts)) {
      if (files === null) continue;
      mkdirSync(join(dir, "artifacts", name), { recursive: true });
      for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, "artifacts", name, path), text);
    }
    for (const [id, text] of Object.entries(logs)) writeFileSync(join(dir, "logs", `${id}.log`), text);
    writeFileSync(join(dir, "calls"), "");
    return dir;
  };
  /** Run `command` (a grade-ci.sh argv, or `bash -c <line>`) against the run served from `dir`. */
  const exec = async (dir: string, cmd: string, args: readonly string[], cwd: string): Promise<Graded> => {
    const run = await runOwned(cmd, args, {
      cwd, ms: 240_000,
      env: childEnv({ PATH: `${bin}:${process.env.PATH}`, GH_RUN_DIR: dir, GH_RUN_ID: RUN_ID, GH_CALLS: join(dir, "calls"), TKR_GRADE_CI_DIR: join(dir, "diag") }),
    });
    const failures = ownedFailures(run, "grader");
    if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
    const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter((line) => line !== "") : [];
    return { status: run.exitCode, stdout: run.out, stderr: run.err, calls };
  };
  /** The production entry: `bash grade-ci.sh <run-id> <expected-sha> <repo-dir> [tag]`, from the candidate checkout. */
  const grade = (c: Candidate, run: GhRun, artifacts: Artifacts, o: { sha?: string; repo?: string; logs?: Record<number, string>; script?: string } = {}) => {
    const dir = serve(run, artifacts, o.logs);
    return exec(dir, "bash", [o.script ?? GRADER, RUN_ID, o.sha ?? c.head, o.repo ?? c.dir, `case-${n}`], c.dir);
  };
  return { serve, exec, grade };
}

export const scratch = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
/** The grade a job line reports, e.g. `test: GREEN`. */
export const gradeOf = (stdout: string, job: string): string | undefined =>
  new RegExp(`^${job.replace(/[/]/g, "\\/")}: (GREEN|RED|UNREADABLE|INFRA_KILLED)$`, "m").exec(stdout)?.[1];
