import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../skills/tickmarkr-overseer/scripts/watch-parks.sh");
const RUN_A = "run-20261002-000001-0000000000000001";
const RUN_B = "run-20261002-000002-0000000000000002";
// Cleanup bound only (D-829 slowest-runner rule): the injected sleep returns at once, so elapsed time
// never decides a verdict here.
const CEILING_MS = 60_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const row = (ts: string, event: string, taskId?: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, event, ...(taskId ? { taskId } : {}), data });
const park = (ts: string, taskId: string, reason: string) => row(ts, "task-human", taskId, { reason, kind: "gate-fail" });

/**
 * A runs dir plus an injected `sleep` on PATH. The fake never waits: it logs each call and, when a
 * barrier row is armed, appends that row to the journal on its FIRST call — the sleep append barrier.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-watch-parks-"));
  cleanup.push(root);
  const runs = join(root, "runs");
  const bin = join(root, "bin");
  const log = join(root, "sleep.log");
  mkdirSync(bin, { recursive: true });
  const journal = (run: string) => {
    mkdirSync(join(runs, run), { recursive: true });
    return join(runs, run, "journal.jsonl");
  };
  const barrier = (run: string, line: string) => {
    writeFileSync(join(root, "barrier.row"), `${line}\n`);
    writeFileSync(join(root, "barrier.journal"), journal(run));
  };
  writeFileSync(
    join(bin, "sleep"),
    [
      "#!/bin/sh",
      `echo "sleep $*" >> '${log}'`,
      `if [ -f '${root}/barrier.row' ]; then`,
      `  cat '${root}/barrier.row' >> "$(cat '${root}/barrier.journal')"`,
      `  rm -f '${root}/barrier.row'`,
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "sleep"), 0o755);
  const watch = (cap: number, receipt?: [string, number]) => {
    rmSync(log, { force: true });
    const args = [SCRIPT, runs, "1", String(cap), ...(receipt ? ["--since-run", receipt[0], "--since-line", String(receipt[1])] : [])];
    const r = spawnSync("bash", args, {
      encoding: "utf8",
      timeout: CEILING_MS,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const sleeps = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const lines = r.stdout.trim().split("\n");
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, sleeps, cursor: lines.at(-1) };
  };
  return { journal, barrier, watch };
}

test("test: watch-parks reports a park between invocations at START even after release then same-run acknowledgment suppresses it while a new run resets the receipt and a torn tail never advances", () => {
  const { journal, watch } = fixture();
  const a = journal(RUN_A);
  writeFileSync(a, [row("t1", "run-start"), row("t2", "task-dispatch", "T1")].join("\n") + "\n");
  // The seat acknowledged line 2; between invocations T1 parked (line 3) and was released (line 4).
  appendFileSync(a, [park("t3", "T1", "review round cap reached"), row("t4", "task-approved", "T1")].join("\n") + "\n");

  const gap = watch(5, [RUN_A, 2]);
  expect(gap.status).toBe(0);
  expect(gap.stdout).toContain(`PARK 1 new — ${RUN_A}`);
  expect(gap.stdout).toContain("T1: review round cap reached");
  expect(gap.stdout).toContain("park 3@t3");
  expect(gap.cursor).toBe(`CURSOR ${RUN_A} 4`);
  expect(gap.sleeps, "a gap park is reported by the START read, before any poll").toEqual([]);

  // Same-run acknowledgment of that receipt suppresses exactly the rows it covers.
  const acked = watch(2, [RUN_A, 4]);
  expect(acked.status).toBe(0);
  expect(acked.stdout).not.toContain("PARK");
  expect(acked.stdout).toContain("WATCH_CAP_REACHED");
  expect(acked.cursor).toBe(`CURSOR ${RUN_A} 4`);

  // A torn tail is not a row: never reported, and the cursor does not advance past it.
  appendFileSync(a, '{"ts":"t5","event":"task-human","taskId":"T2"');
  const torn = watch(2, [RUN_A, 4]);
  expect(torn.status).toBe(0);
  expect(torn.stdout).not.toContain("PARK");
  expect(torn.cursor).toBe(`CURSOR ${RUN_A} 4`);

  // Once its newline lands the same row is complete and is reported against the unchanged receipt.
  appendFileSync(a, ',"data":{"reason":"scope gate red","kind":"gate-fail"}}\n');
  const completed = watch(2, [RUN_A, 4]);
  expect(completed.stdout).toContain(`PARK 1 new — ${RUN_A}`);
  expect(completed.stdout).toContain("T2: scope gate red");
  expect(completed.stdout).toContain("park 5@t5");
  expect(completed.stdout).not.toContain("T1:");
  expect(completed.cursor).toBe(`CURSOR ${RUN_A} 5`);

  // A new run resets the receipt: its line-1 park sits below the old run's line 5 and is still reported.
  writeFileSync(journal(RUN_B), park("u1", "T3", "build gate red") + "\n");
  const fresh = watch(2, [RUN_A, 5]);
  expect(fresh.status).toBe(0);
  expect(fresh.stdout).toContain(`PARK 1 new — ${RUN_B}`);
  expect(fresh.stdout).toContain("T3: build gate red");
  expect(fresh.stdout).toContain("park 1@u1");
  expect(fresh.stdout).not.toContain("T2:");
  expect(fresh.cursor).toBe(`CURSOR ${RUN_B} 1`);

  // A receipt beyond its run's complete lines is not an acknowledgment of this journal: refused.
  const forged = watch(2, [RUN_B, 9]);
  expect(forged.status).toBe(65);
  expect(forged.stdout).not.toContain("CURSOR");
  expect(forged.sleeps).toEqual([]);
}, CEILING_MS);

test("test: watch-parks polls only after its START read and returns a park appended by the injected sleep barrier with its complete line receipt", () => {
  const { journal, barrier, watch } = fixture();
  const a = journal(RUN_A);
  writeFileSync(a, [row("t1", "run-start"), park("t2", "T1", "evidence gate red")].join("\n") + "\n");
  barrier(RUN_A, park("t3", "T2", "acceptance judge red"));

  // No receipt: nothing is acknowledged, so the START read reports T1 and the barrier never fires.
  const start = watch(5);
  expect(start.status).toBe(0);
  expect(start.stdout).toContain("T1: evidence gate red");
  expect(start.cursor).toBe(`CURSOR ${RUN_A} 2`);
  expect(start.sleeps, "START read precedes every poll").toEqual([]);
  expect(readFileSync(a, "utf8").trim().split("\n")).toHaveLength(2);

  // Re-armed with that receipt: START finds nothing new, the first poll's sleep appends T2, and the
  // poll returns it with the receipt of its complete line.
  const polled = watch(5, [RUN_A, 2]);
  expect(polled.status).toBe(0);
  expect(polled.sleeps).toEqual(["sleep 1"]);
  expect(polled.stdout).toContain(`PARK 1 new — ${RUN_A}`);
  expect(polled.stdout).toContain("T2: acceptance judge red");
  expect(polled.stdout).toContain("park 3@t3");
  expect(polled.stdout).not.toContain("T1:");
  expect(polled.cursor).toBe(`CURSOR ${RUN_A} 3`);
}, CEILING_MS);

test("a wake larger than the pipe buffer reports every park and ends with its receipt", () => {
  const { journal, watch } = fixture();
  const n = 1500;
  const nth = (i: number) => park(`t${i}`, `T${i}`, "r".repeat(80));
  writeFileSync(journal(RUN_A), Array.from({ length: n }, (_, i) => nth(i + 1)).join("\n") + "\n");
  const r = watch(5);
  expect(r.status).toBe(0);
  expect(Buffer.byteLength(r.stdout), "the wake must exceed a 64 KiB pipe buffer").toBeGreaterThan(65_536);
  expect(r.stdout).toContain(`PARK ${n} new — ${RUN_A}`);
  const reported = r.stdout.split("\n").filter((l) => l.startsWith("    park "));
  expect(reported).toEqual(Array.from({ length: n }, (_, i) => `    park ${i + 1}@t${i + 1}`));
  expect(r.cursor).toBe(`CURSOR ${RUN_A} ${n}`);
}, CEILING_MS);

test("an unreadable journal fails the watch with status 66 and no receipt instead of an empty scan", () => {
  const { journal, watch } = fixture();
  // A directory where the journal belongs: unreadable for every user, root included.
  mkdirSync(journal(RUN_A));
  const r = watch(5);
  expect(r.status).toBe(66);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("WATCH_ERROR");
  expect(r.stderr).not.toContain("WATCH_CAP_REACHED");
  expect(r.sleeps).toEqual([]);
}, CEILING_MS);

// The reviewer's executed case: the newest run directory is unsearchable while it holds a complete park.
// Root ignores mode bits, so the case after it repeats the failure with a self-looping run entry (ELOOP).
test.skipIf(process.getuid?.() === 0)("an unsearchable newest run directory fails discovery with status 66 and no receipt instead of falling back to an older run", () => {
  const { journal, watch } = fixture();
  writeFileSync(journal(RUN_A), row("t1", "run-start") + "\n");
  const b = journal(RUN_B);
  writeFileSync(b, park("u1", "T1", "build gate red") + "\n");
  chmodSync(dirname(b), 0o000);
  let r;
  try {
    r = watch(5, [RUN_A, 1]);
  } finally {
    chmodSync(dirname(b), 0o755);
  }
  expect(r.status).toBe(66);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("WATCH_ERROR");
  expect(r.sleeps).toEqual([]);

  const restored = watch(5, [RUN_A, 1]);
  expect(restored.stdout).toContain(`PARK 1 new — ${RUN_B}`);
  expect(restored.cursor).toBe(`CURSOR ${RUN_B} 1`);
}, CEILING_MS);

test("a newest run entry that cannot be traversed fails discovery with status 66 for every user, root included", () => {
  const { journal, watch } = fixture();
  const a = journal(RUN_A);
  writeFileSync(a, row("t1", "run-start") + "\n");
  symlinkSync(RUN_B, join(dirname(dirname(a)), RUN_B));
  const r = watch(5, [RUN_A, 1]);
  expect(r.status).toBe(66);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("ELOOP");
  expect(r.sleeps).toEqual([]);
}, CEILING_MS);

test("the empty-run receipt round-trips through re-arm and a subsequent run is read from line 0", () => {
  const { barrier, watch } = fixture();
  const empty = watch(0);
  expect(empty.status).toBe(0);
  expect(empty.stdout).toContain("WATCH_CAP_REACHED");
  expect(empty.cursor).toBe("CURSOR none 0");

  // Re-armed with exactly that receipt; the first poll's sleep creates the run's journal with a park.
  barrier(RUN_A, park("t1", "T1", "build gate red"));
  const [, run, line] = (empty.cursor ?? "").split(" ");
  const next = watch(5, [run, Number(line)]);
  expect(next.status).toBe(0);
  expect(next.sleeps).toEqual(["sleep 1"]);
  expect(next.stdout).toContain(`PARK 1 new — ${RUN_A}`);
  expect(next.stdout).toContain("park 1@t1");
  expect(next.cursor).toBe(`CURSOR ${RUN_A} 1`);
}, CEILING_MS);

test("a run id with an underscore (parseRunId grammar) reports its park at START and its receipt suppresses it on re-arm", () => {
  const { journal, watch } = fixture();
  const run = "run-20261002-000003_retry";
  writeFileSync(journal(run), [row("t1", "run-start"), park("t2", "T1", "build gate red")].join("\n") + "\n");

  const first = watch(5);
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(`PARK 1 new — ${run}`);
  expect(first.stdout).toContain("park 2@t2");
  expect(first.cursor).toBe(`CURSOR ${run} 2`);
  expect(first.sleeps).toEqual([]);

  const acked = watch(2, [run, 2]);
  expect(acked.status).toBe(0);
  expect(acked.stdout).not.toContain("PARK");
  expect(acked.stdout).toContain("WATCH_CAP_REACHED");
  expect(acked.cursor).toBe(`CURSOR ${run} 2`);
}, CEILING_MS);
