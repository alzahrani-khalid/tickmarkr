import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// v2.7.8 T4: grade-ci.sh grades every job of ONE closed inventory — serial {test, test-macos} or the sharded
// twelve — and reads each verdict line only from its declared step, exactly once.
const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/grade-ci.sh");
const N = 10;
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OSES = ["ubuntu-latest", "macos-latest"] as const;
const SHARDED = OSES.flatMap((os) => [1, 2, 3, 4].map((k) => `suite ${os} ${k}/4`).concat(`single-fork ${os}`, `aggregate ${os}`));

// ---- gh job-log shapes: "<job>\t<step>\t<timestamp> <text>"
const COVERAGE = "Run coverage proof (parallel suite project)";
const SINGLE_FORK = "Run single-fork projects (independent of the step above)";
const SHARD_STEP = "Run coverage shard (parallel suite project)";
const COUNT_STEP = "Assert collected test-file count";
const FLOORS_STEP = "Recheck coverage floors";
const SET_STEP = "Assert collected test-file set";
const MERGE_STEP = "Merge coverage (one threshold check per OS)";
const step = (name: string, text: string) =>
  text.split("\n").map((line) => `job\t${name}\t2026-10-11T00:00:00.0000000Z ${line}`).join("\n") + "\n";
const summary = (files: number, errors = 0, failed = 0) => [
  "",
  ` Test Files  ${failed ? `${failed} failed | ` : ""}${files - failed} passed (${files})`,
  `      Tests  ${failed ? `${failed} failed | ` : ""}${files * 3 - failed} passed (${files * 3})`,
  ...(errors ? [`     Errors  ${errors} error`] : []),
  "   Duration  1.00s",
  "",
].join("\n");
const BAR = "⎯⎯⎯⎯⎯⎯";
const rpcOnly = (files: number) => [
  `${BAR} Unhandled Errors ${BAR}`, "", "Vitest caught 1 unhandled error during the test run.", "",
  `${BAR} Unhandled Error ${BAR}`, 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"', BAR, "",
].join("\n") + summary(files, 1);
const EXIT_1 = "##[error]Process completed with exit code 1.";
const CANCELED = "##[error]The operation was canceled.";
const COUNT_GREEN = `COUNT_ORACLE GREEN expected=${N} actual=${N}`;
const FLOORS_GREEN = "COVERAGE_FLOORS verdict=GREEN floors=6 failing=0";
const SET_GREEN = `SET_ORACLE verdict=GREEN expected=${N} actual=${N} defects=0`;

const serialLog = ({ count = [COUNT_GREEN], floors = [FLOORS_GREEN], coverage = summary(7), extra = "" } = {}) =>
  step(COVERAGE, coverage) + (floors.length ? step(FLOORS_STEP, floors.join("\n")) : "")
  + step(SINGLE_FORK, summary(3)) + (count.length ? step(COUNT_STEP, count.join("\n")) : "") + extra;
const aggregateLog = ({ merge = summary(8), floors = [FLOORS_GREEN], set = [SET_GREEN], extra = "" } = {}) =>
  step(MERGE_STEP, merge) + (floors.length ? step(FLOORS_STEP, floors.join("\n")) : "")
  + (set.length ? step(SET_STEP, set.join("\n")) : "") + extra;

type Job = { name: string; log?: string; conclusion?: string; status?: string };
const greenJob = (name: string): Job => ({
  name,
  log: name.startsWith("aggregate ") ? aggregateLog()
    : name.startsWith("single-fork ") ? step("Run single-fork projects", summary(2))
    : name.startsWith("suite ") ? step(SHARD_STEP, summary(2))
    : serialLog(),
});
const serial = (overrides: Record<string, Partial<Job>> = {}) =>
  ["test", "test-macos"].map((name) => ({ ...greenJob(name), ...overrides[name] }));
const sharded = (overrides: Record<string, Partial<Job>> = {}) =>
  SHARDED.map((name) => ({ ...greenJob(name), ...overrides[name] }));

type Spawned = { status: number | null; stdout: string; stderr: string };
const bash = (args: string[], env: NodeJS.ProcessEnv) => new Promise<Spawned>((settle, fail) => {
  const child = spawn("bash", args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", fail).on("close", (status) => settle({ status, stdout, stderr }));
});

// a stand-in gh: the job list as gh's @tsv prints it, and each job's log by id
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-grade-ci-inventory-"));
  cleanup.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/gh"), `#!/bin/bash
if [[ " $* " == *" --json jobs "* ]]; then cat "$GH_JOBS_FILE"; exit 0; fi
if [[ " $* " == *" --log "* ]]; then
  for a in "$@"; do [ "\${prev:-}" = --job ] && id=$a; prev=$a; done
  [ -f "$GH_LOG_DIR/$id.log" ] && cat "$GH_LOG_DIR/$id.log"
  exit 0
fi
exit 1
`);
  chmodSync(join(root, "bin/gh"), 0o755);
  let n = 0;
  return async (jobs: Job[], expected = N) => {
    const dir = join(root, `case-${n++}`);
    mkdirSync(join(dir, "logs"), { recursive: true });
    const rows = jobs.map((job, i) => {
      if (job.log !== undefined) writeFileSync(join(dir, "logs", `${100 + i}.log`), job.log);
      return `${100 + i}\t${job.name}\t${job.status ?? "completed"}\t${job.conclusion ?? "success"}\n`;
    });
    writeFileSync(join(dir, "jobs.tsv"), rows.join(""));
    const graded = await bash([SCRIPT, "12345", String(expected), `case-${n}`], {
      ...process.env,
      GH_JOBS_FILE: join(dir, "jobs.tsv"),
      GH_LOG_DIR: join(dir, "logs"),
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      TKR_GRADE_CI_DIR: join(dir, "diag"),
    });
    return { ...graded, out: `${graded.stdout}${graded.stderr}` };
  };
}
const verdictOf = (stdout: string, name: string) =>
  new RegExp(`^${name.replace(/[/]/g, "\\/")}: (GREEN|RED|UNREADABLE|INFRA_KILLED)$`, "m").exec(stdout)?.[1];

describe("grade-ci.sh closed inventory", () => {
  test("test: grade-ci grades a run against the one closed inventory its job names match and reads UNREADABLE naming each missing duplicated or unknown job, an OS-only shard name and an extra failing job included, versus the complete serial or sharded inventory with green logs grading GREEN", { timeout: 240_000 }, async () => {
    const grade = fixture();

    const serialGreen = await grade(serial());
    expect(serialGreen.status, serialGreen.out).toBe(0);
    expect(serialGreen.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=2");
    expect(serialGreen.stdout).not.toContain("INVENTORY_DEFECT");
    for (const name of ["test", "test-macos"]) expect(verdictOf(serialGreen.stdout, name), name).toBe("GREEN");

    const shardedGreen = await grade(sharded());
    expect(shardedGreen.status, shardedGreen.out).toBe(0);
    expect(shardedGreen.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=12");
    expect(shardedGreen.stdout).not.toContain("INVENTORY_DEFECT");
    for (const name of SHARDED) expect(verdictOf(shardedGreen.stdout, name), name).toBe("GREEN");
    expect(shardedGreen.stdout).toContain("VERDICT rc=0");

    // a missing shard: every other job green, the run still unreadable
    const missing = await grade(sharded().filter((job) => job.name !== "suite macos-latest 3/4"));
    expect(missing.status, missing.out).toBe(2);
    expect(missing.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=11");
    expect(missing.stdout).toContain('INVENTORY_DEFECT kind=missing job="suite macos-latest 3/4"');

    // a duplicated aggregate, both copies green
    const duplicate = await grade([...sharded(), greenJob("aggregate ubuntu-latest")]);
    expect(duplicate.status, duplicate.out).toBe(2);
    expect(duplicate.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=13");
    expect(duplicate.stdout).toContain('INVENTORY_DEFECT kind=duplicate job="aggregate ubuntu-latest"');

    // an OS-only shard name (a matrix that dropped the shard index) is unknown, and the shard it replaced is missing
    const osOnly = await grade(sharded().map((job) => job.name === "suite ubuntu-latest 1/4" ? { ...job, name: "suite ubuntu-latest" } : job));
    expect(osOnly.status, osOnly.out).toBe(2);
    expect(osOnly.stdout).toContain('INVENTORY_DEFECT kind=unknown job="suite ubuntu-latest"');
    expect(osOnly.stdout).toContain('INVENTORY_DEFECT kind=missing job="suite ubuntu-latest 1/4"');

    // an extra failing job beside the green serial pair is never skipped
    const extra = await grade([...serial(), { name: "lint", conclusion: "failure", log: step("Run npm run lint", `npm error lint failed\n${EXIT_1}`) }]);
    expect(extra.status, extra.out).toBe(2);
    expect(extra.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=3");
    expect(extra.stdout).toContain('INVENTORY_DEFECT kind=unknown job="lint"');
    expect(extra.stdout).not.toMatch(/^lint: GREEN$/m);

    // the serial pair missing a job; a serial pair beside one sharded name is graded as the sharded inventory
    // a successful gh response holding zero jobs is the serial inventory with every job missing, no unknown name
    const empty = await grade([]);
    expect(empty.status, empty.out).toBe(2);
    expect(empty.stdout.split("\n")[0]).toBe("INVENTORY form=serial declared=2 observed=0");
    expect(empty.stdout.match(/^INVENTORY_DEFECT .*$/gm)).toEqual([
      'INVENTORY_DEFECT kind=missing job="test"',
      'INVENTORY_DEFECT kind=missing job="test-macos"',
    ]);
    expect(empty.stdout).toContain("VERDICT rc=2");
    const lone = await grade(serial().slice(0, 1));
    expect(lone.status, lone.out).toBe(2);
    expect(lone.stdout).toContain('INVENTORY_DEFECT kind=missing job="test-macos"');
    const mixed = await grade([...serial(), greenJob("aggregate ubuntu-latest")]);
    expect(mixed.status, mixed.out).toBe(2);
    expect(mixed.stdout.split("\n")[0]).toBe("INVENTORY form=sharded declared=12 observed=3");
    expect(mixed.stdout).toContain('INVENTORY_DEFECT kind=unknown job="test"');
    expect(mixed.stdout).toContain('INVENTORY_DEFECT kind=missing job="single-fork macos-latest"');

    // the job name is JSON-quoted: gh's @tsv escapes are decoded, then quotes and backslashes re-encoded
    const quoted = await grade([...serial(), { name: 'lint "strict" a\\\\b', log: step("lint", "ok") }]);
    expect(quoted.status, quoted.out).toBe(2);
    expect(quoted.stdout).toContain('INVENTORY_DEFECT kind=unknown job="lint \\"strict\\" a\\\\b"');
  });

  test("test: grade-ci reads each verdict line only from its declared step and exactly once so an oracle line another step prints before or after the real one never decides and zero or two lines there or a serial job without its floors step read UNREADABLE versus one green line grading GREEN", { timeout: 240_000 }, async () => {
    const grade = fixture();
    const RED_COUNT = `COUNT_ORACLE RED expected=${N} actual=9`;
    const both = (log: string, conclusion = "success") => serial({ test: { log, conclusion }, "test-macos": { log, conclusion } });

    const green = await grade(both(serialLog()));
    expect(green.status, green.out).toBe(0);
    expect(green.stdout).toMatch(new RegExp(`^test: oracle=\\[${COUNT_GREEN}\\] floors=\\[${FLOORS_GREEN}\\] `, "m"));

    // a GREEN oracle line another step prints after, or a test prints before, the count step's RED never decides
    const after = await grade(both(serialLog({ count: [RED_COUNT], extra: step("Post Run actions/checkout@v4", COUNT_GREEN) })));
    expect(after.status, after.out).toBe(1);
    expect(after.stdout).toMatch(new RegExp(`^test: oracle=\\[${RED_COUNT}\\] `, "m"));
    expect(verdictOf(after.stdout, "test")).toBe("RED");
    const before = await grade(both(serialLog({ count: [RED_COUNT], coverage: `stdout | tests/x.test.ts > prints\n${COUNT_GREEN}\n` + summary(7) })));
    expect(before.status, before.out).toBe(1);
    expect(verdictOf(before.stdout, "test")).toBe("RED");

    // zero lines in the count step (the only one printed by a test step), two there, or a malformed one
    const elsewhere = await grade(both(serialLog({ count: [], coverage: summary(7) + COUNT_GREEN })));
    expect(elsewhere.status, elsewhere.out).toBe(2);
    expect(elsewhere.stdout).toMatch(/^test: oracle=\[MISSING\] /m);
    expect(verdictOf(elsewhere.stdout, "test")).toBe("UNREADABLE");
    const twice = await grade(both(serialLog({ count: [COUNT_GREEN, COUNT_GREEN] })));
    expect(twice.status, twice.out).toBe(2);
    expect(twice.stdout).toMatch(/^test: oracle=\[MULTIPLE\(2\)\] /m);
    const malformed = await grade(both(serialLog({ count: [`COUNT_ORACLE GREEN expected=${N}`] })));
    expect(malformed.status, malformed.out).toBe(2);
    expect(malformed.stdout).toMatch(/^test: oracle=\[MALFORMED\] /m);

    // a serial job without its floors step, with its floors line in another step, or with two there
    const noFloors = await grade(both(serialLog({ floors: [] })));
    expect(noFloors.status, noFloors.out).toBe(2);
    expect(noFloors.stdout).toMatch(/^test: oracle=\[COUNT_ORACLE GREEN [^\]]*\] floors=\[MISSING\] /m);
    expect(verdictOf(noFloors.stdout, "test")).toBe("UNREADABLE");
    const floorsElsewhere = await grade(both(serialLog({ floors: [], extra: step(SINGLE_FORK, FLOORS_GREEN) })));
    expect(floorsElsewhere.status, floorsElsewhere.out).toBe(2);
    const floorsTwice = await grade(both(serialLog({ floors: [FLOORS_GREEN, FLOORS_GREEN] })));
    expect(floorsTwice.status, floorsTwice.out).toBe(2);
    expect(floorsTwice.stdout).toMatch(/floors=\[MULTIPLE\(2\)\]/);
    // per-entry COVERAGE_FLOOR lines in the floors step are not the final line
    const entries = await grade(both(serialLog({ floors: ['COVERAGE_FLOOR {"glob":"src/gates/**"}', FLOORS_GREEN] })));
    expect(entries.status, entries.out).toBe(0);

    // the aggregate's set oracle: a GREEN line the merge step prints never stands in for the set step's
    const agg = (log: string) => sharded({ "aggregate macos-latest": { log } });
    const forgedSet = await grade(agg(aggregateLog({ merge: summary(8) + SET_GREEN, set: [`SET_ORACLE verdict=RED expected=${N} actual=9 defects=1`] })));
    expect(forgedSet.status, forgedSet.out).toBe(1);
    expect(verdictOf(forgedSet.stdout, "aggregate macos-latest")).toBe("RED");
    const setElsewhere = await grade(agg(aggregateLog({ merge: summary(8) + SET_GREEN, set: [] })));
    expect(setElsewhere.status, setElsewhere.out).toBe(2);
    expect(setElsewhere.stdout).toMatch(/^aggregate macos-latest: floors=\[[^\]]*\] set=\[MISSING\] /m);
    const setTwice = await grade(agg(aggregateLog({ set: [SET_GREEN, SET_GREEN] })));
    expect(setTwice.status, setTwice.out).toBe(2);
    // SET_ORACLE_DEFECT lines in the set step are not the verdict line
    const setDefects = await grade(agg(aggregateLog({ set: ['SET_ORACLE_DEFECT {"kind":"missing"}', SET_GREEN] })));
    expect(setDefects.status, setDefects.out).toBe(0);
  });

  test("test: a shard or single-fork job grades GREEN only on a success conclusion whose log the shared classifier passes so a failure whose only exit-1 step is RPC-only and a summary-free success log both grade RED versus a serial job keeping that exception under its count", { timeout: 240_000 }, async () => {
    const grade = fixture();
    for (const name of ["suite ubuntu-latest 2/4", "single-fork macos-latest"]) {
      // a success the classifier reads CLEAN or RPC_ONLY (the wrapper already turned a complete RPC-only 1 into 0)
      for (const log of [step(SHARD_STEP, summary(2)), step(SHARD_STEP, rpcOnly(2))]) {
        const green = await grade(sharded({ [name]: { log } }));
        expect(green.status, green.out).toBe(0);
        expect(verdictOf(green.stdout, name)).toBe("GREEN");
      }
      // a failure whose only exit-1 step reads RPC_ONLY: no excuse, the wrapper kept that 1 in-job
      const kept = await grade(sharded({ [name]: { conclusion: "failure", log: step(SHARD_STEP, `${rpcOnly(2)}\n${EXIT_1}`) } }));
      expect(kept.status, kept.out).toBe(1);
      expect(kept.stdout).toMatch(new RegExp(`outcome=\\[exit-1\\]`));
      expect(verdictOf(kept.stdout, name)).toBe("RED");
      // a success with no Vitest summary at all
      const summaryFree = await grade(sharded({ [name]: { log: step(SHARD_STEP, "npm ci\nadded 412 packages") } }));
      expect(summaryFree.status, summaryFree.out).toBe(1);
      expect(summaryFree.stdout).toContain("log=[no-summary]");
      expect(verdictOf(summaryFree.stdout, name)).toBe("RED");
      // a failed test, and a failure no exit annotation explains
      expect((await grade(sharded({ [name]: { log: step(SHARD_STEP, summary(2, 0, 1)) } }))).status).toBe(1);
      expect((await grade(sharded({ [name]: { conclusion: "failure", log: step(SHARD_STEP, summary(2)) } }))).status).toBe(1);
    }

    // the serial job keeps the base exception: its coverage step exited exactly 1 on an RPC-only log of its own,
    // beside GREEN count and floors lines — and only under its count
    const excused = serialLog({ coverage: `${rpcOnly(7)}\n${EXIT_1}` });
    const serialGreen = await grade(serial({ test: { conclusion: "failure", log: excused } }));
    expect(serialGreen.status, serialGreen.out).toBe(0);
    expect(serialGreen.stdout).toMatch(/^test: .* runner_rpc_timeouts=1 .* outcome=\[ok\] /m);
    expect(verdictOf(serialGreen.stdout, "test")).toBe("GREEN");
    const otherCount = await grade(serial({ test: { conclusion: "failure", log: excused } }), N + 1);
    expect(otherCount.status, otherCount.out).toBe(1);
    expect(verdictOf(otherCount.stdout, "test")).toBe("RED");
    // any other failing annotation on a serial job is never GREEN
    const exit2 = await grade(serial({ test: { conclusion: "failure", log: serialLog({ coverage: `${rpcOnly(7)}\n##[error]Process completed with exit code 2.` }) } }));
    expect(exit2.status, exit2.out).toBe(1);
  });

  test("test: an aggregate job grades GREEN only on a success conclusion with one floors line and one set-oracle line both GREEN at the expected count and a merge step the classifier passes versus a GREEN set beside RED floors, a failing step exit annotation, a RED set verdict or another expected count grading RED", { timeout: 240_000 }, async () => {
    const grade = fixture();
    const name = "aggregate ubuntu-latest";
    const agg = (log: string, conclusion = "success") => sharded({ [name]: { log, conclusion } });

    const green = await grade(agg(aggregateLog()));
    expect(green.status, green.out).toBe(0);
    expect(green.stdout).toContain(`${name}: floors=[${FLOORS_GREEN}] set=[${SET_GREEN}] merge=[CLEAN none] `);
    expect(verdictOf(green.stdout, name)).toBe("GREEN");
    const rpcMerge = await grade(agg(aggregateLog({ merge: rpcOnly(8) })));
    expect(rpcMerge.status, rpcMerge.out).toBe(0);

    const reds: [string, string, string?][] = [
      ["GREEN set beside RED floors", aggregateLog({ floors: ["COVERAGE_FLOORS verdict=RED floors=6 failing=1"] })],
      ["UNREADABLE floors verdict", aggregateLog({ floors: ["COVERAGE_FLOORS verdict=UNREADABLE floors=UNREADABLE failing=UNREADABLE"] })],
      ["failing exit annotation on the merge step", aggregateLog({ merge: `${rpcOnly(8)}\n${EXIT_1}` }), "failure"],
      ["failing exit annotation on the floors step", aggregateLog({ floors: [FLOORS_GREEN, EXIT_1] }), "failure"],
      ["exit annotation under a success conclusion", aggregateLog({ extra: step(SET_STEP, EXIT_1) })],
      ["RED set verdict", aggregateLog({ set: [`SET_ORACLE verdict=RED expected=${N} actual=${N} defects=1`] })],
      ["another expected count", aggregateLog({ set: [`SET_ORACLE verdict=GREEN expected=${N + 1} actual=${N + 1} defects=0`] })],
      ["actual short of expected", aggregateLog({ set: [`SET_ORACLE verdict=GREEN expected=${N} actual=${N - 1} defects=0`] })],
      ["merge step with a failed test", aggregateLog({ merge: summary(8, 0, 1) })],
      ["merge step without a summary", aggregateLog({ merge: "merging 4 blobs" })],
      ["failure conclusion no annotation explains", aggregateLog(), "failure"],
    ];
    for (const [label, log, conclusion] of reds) {
      const graded = await grade(agg(log, conclusion));
      expect(graded.status, `${label}\n${graded.out}`).toBe(1);
      expect(verdictOf(graded.stdout, name), label).toBe("RED");
    }
  });

  test("test: across the whole inventory the exit stays 0 GREEN 1 RED 2 UNREADABLE 3 INFRA_KILLED with UNREADABLE over RED over INFRA_KILLED and a cancelled shard with the runner annotation and no failure reading INFRA_KILLED versus one RED shard beside it reading RED", { timeout: 240_000 }, async () => {
    const grade = fixture();
    const killed: Partial<Job> = { conclusion: "cancelled", log: step(SHARD_STEP, `···\n${CANCELED}`) };
    const red: Partial<Job> = { log: step(SHARD_STEP, summary(2, 0, 1)) };
    const unreadable: Partial<Job> = { log: aggregateLog({ set: [] }) };

    const green = await grade(sharded());
    expect(green.status, green.out).toBe(0);

    const kill = await grade(sharded({ "suite macos-latest 4/4": killed }));
    expect(kill.status, kill.out).toBe(3);
    expect(verdictOf(kill.stdout, "suite macos-latest 4/4")).toBe("INFRA_KILLED");
    expect(kill.stdout).toContain("VERDICT rc=3");

    const redBeside = await grade(sharded({ "suite macos-latest 4/4": killed, "suite ubuntu-latest 1/4": red }));
    expect(redBeside.status, redBeside.out).toBe(1);
    expect(verdictOf(redBeside.stdout, "suite macos-latest 4/4")).toBe("INFRA_KILLED");
    expect(verdictOf(redBeside.stdout, "suite ubuntu-latest 1/4")).toBe("RED");
    expect(redBeside.stdout).toContain("VERDICT rc=1");

    const all = await grade(sharded({ "suite macos-latest 4/4": killed, "suite ubuntu-latest 1/4": red, "aggregate macos-latest": unreadable }));
    expect(all.status, all.out).toBe(2);
    expect(verdictOf(all.stdout, "aggregate macos-latest")).toBe("UNREADABLE");
    expect(all.stdout).toContain("VERDICT rc=2");
    expect((await grade(sharded({ "single-fork ubuntu-latest": killed, "aggregate macos-latest": unreadable }))).status).toBe(2);
    expect((await grade(sharded({ "single-fork ubuntu-latest": red, "aggregate macos-latest": unreadable }))).status).toBe(2);

    // a kill beside the job's own failing exit is RED: no role but serial has an exit excuse
    const exitThenKill = await grade(sharded({ "suite ubuntu-latest 3/4": { conclusion: "cancelled", log: step(SHARD_STEP, `${rpcOnly(2)}\n${EXIT_1}\n${CANCELED}`) } }));
    expect(exitThenKill.status, exitThenKill.out).toBe(1);
    // a killed aggregate (its oracle steps never ran) and a killed single-fork job are INFRA_KILLED too
    const aggKilled = await grade(sharded({
      "aggregate ubuntu-latest": { conclusion: "cancelled", log: step(MERGE_STEP, `···\n${CANCELED}`) },
      "single-fork macos-latest": killed,
    }));
    expect(aggKilled.status, aggKilled.out).toBe(3);
    expect(verdictOf(aggKilled.stdout, "aggregate ubuntu-latest")).toBe("INFRA_KILLED");
    // an in-progress job and an empty log are UNREADABLE, never green
    expect((await grade(sharded({ "suite ubuntu-latest 2/4": { status: "in_progress", conclusion: "" } }))).status).toBe(2);
    expect((await grade(sharded({ "suite ubuntu-latest 2/4": { log: "" } }))).status).toBe(2);
    // the serial inventory keeps the same lattice
    const serialKilled: Partial<Job> = { conclusion: "cancelled", log: step(COVERAGE, `···\n${CANCELED}`) };
    expect((await grade(serial({ test: serialKilled }))).status).toBe(3);
    expect((await grade(serial({ test: serialKilled, "test-macos": { log: serialLog({ coverage: summary(7, 0, 1) }) } }))).status).toBe(1);
    expect((await grade(serial({ test: serialKilled, "test-macos": { log: serialLog({ floors: [] }) } }))).status).toBe(2);
  });
});
