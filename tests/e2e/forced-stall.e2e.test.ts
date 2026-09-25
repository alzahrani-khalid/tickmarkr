import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readTestReport } from "../../src/gates/test-manifest.js";
import { TEST_REPORTER_SOURCE } from "../../src/gates/test-reporter.js";
import { verifyIntegrationTip, type TipVerifyResult } from "../../src/run/merge.js";
import { makeRepo, makeTestTempDir, TEST_BASE_TMPDIR_ENV } from "../helpers/tmprepo.js";

const parallel = "tests/parallel.test.ts";
const serial = "tests/serial.test.ts";
// The fixture config is plain ESM; native loading avoids writes into shared node_modules.
const command = "vitest run --configLoader native";

function fixture(mode: "stall" | "healthy" | "assertion" | "skipped") {
  // Release evidence intentionally survives test cleanup, including both original certificates:
  // under the suite, tmpdir() is the per-file TMPDIR that tests/setup.ts reaps at teardown (D-477),
  // so the proof lives under the inherited base recorded before that relocation.
  const artifacts = mode === "stall"
    ? mkdtempSync(join(process.env[TEST_BASE_TMPDIR_ENV] ?? tmpdir(), "tickmarkr-forced-stall-proof-"))
    : makeTestTempDir("forced-stall-control-");
  const executions = join(artifacts, "executions.jsonl");
  const drops = join(artifacts, "dropped-ack.jsonl");
  const body = (file: string) => `
import { test, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
${mode === "skipped" ? "test.skip" : "test"}('owned assertion', () => {
  appendFileSync(${JSON.stringify(executions)}, JSON.stringify({ file: ${JSON.stringify(file)}, nonce: process.env.TICKMARKR_TEST_NONCE }) + '\\n');
  expect(1).toBe(${mode === "assertion" && file === parallel ? 2 : 1});
});
`;
  const repo = realpathSync(makeRepo({
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ type: "module" }),
    [parallel]: body(parallel),
    [serial]: body(serial),
    "vitest.config.mjs": `
import { ChildProcess } from 'node:child_process';
import { deserialize } from 'node:v8';
import { appendFileSync, readFileSync } from 'node:fs';
// Owned transport fault only: no reporter writes, runner replacement, timer tuning or busy loop.
// Observe requests unchanged; suppress precisely one successful response AFTER the production
// reporter has persisted the parallel module's completion. Every other IPC message passes through.
if (${mode === "stall"}) {
  const emit = ChildProcess.prototype.emit;
  const requests = new WeakMap();
  let dropped = false;
  const decode = value => {
    try { return deserialize(Buffer.from(value)); } catch { return undefined; }
  };
  ChildProcess.prototype.emit = function(event, ...args) {
    const message = event === 'message' ? decode(args[0]) : undefined;
    if (message?.t === 'q' && message.m === 'onTaskUpdate' && message.i) {
      let ids = requests.get(this);
      if (!ids) requests.set(this, ids = new Map());
      ids.set(message.i, Date.now());
    }
    // Node installs send as an own property while opening IPC, so wrap this child only.
    if (event === 'spawn') {
      const send = this.send;
      this.send = function(value, ...args) {
        const message = decode(value);
        const ids = requests.get(this);
        const requestedAt = ids?.get(message?.i);
        if (message?.t === 's' && requestedAt !== undefined) {
          ids.delete(message.i);
          const report = JSON.parse(readFileSync(process.env.TICKMARKR_TEST_REPORT, 'utf8'));
          if (!dropped && !message.e && report.completed[${JSON.stringify(parallel)}]?.status === 'passed') {
            dropped = true;
            appendFileSync(${JSON.stringify(drops)}, JSON.stringify({ nonce: report.nonce, id: message.i,
              method: 'onTaskUpdate', requestedAt, droppedAt: Date.now(), report }) + '\\n');
            return true;
          }
        }
        return send.call(this, value, ...args);
      };
    }
    return emit.call(this, event, ...args);
  };
}
export default { test: { pool: 'forks', maxWorkers: 1, minWorkers: 1, projects: [
  { test: { name: 'parallel', include: [${JSON.stringify(parallel)}], pool: 'forks', poolOptions: { forks: { minForks: 1, maxForks: 1 } } } },
  { test: { name: 'serial', include: [${JSON.stringify(serial)}], pool: 'forks', poolOptions: { forks: { singleFork: true } } } }
] } };
`,
  }));
  symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"), "dir");
  return { repo, artifacts, executions, drops };
}

type Fixture = ReturnType<typeof fixture>;
function json(path: string) { return JSON.parse(readFileSync(path, "utf8")); }
function lines(path: string): Array<{ file: string; nonce: string }> {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}
async function verify(f: Fixture) {
  const rows = await verifyIntegrationTip(f.repo, { test: command }, f.artifacts);
  expect(rows).toHaveLength(1);
  writeFileSync(join(f.artifacts, "tip-result.json"), JSON.stringify(rows[0], null, 2));
  return rows[0]!;
}
function invocations(f: Fixture, row: TipVerifyResult) {
  const receipts = row.evidenceReceipts!;
  expect(receipts).toBeDefined();
  // Discovery also has receipts; only report-bearing nonces represent suite executions.
  const runs = receipts.filter(r => existsSync(join(f.artifacts, `test-manifest-report-${r.nonce}.json`)));
  expect(receipts).toHaveLength(runs.length * 2);
  expect(new Set(receipts.map(r => r.invocationId)).size).toBe(receipts.length);
  for (const receipt of receipts) {
    expect(receipt.availability).toBe("available");
    expect(receipt.termination.kind).toBe("exit");
    for (const ref of [receipt.stdout, receipt.stderr]) {
      const bytes = readFileSync(join(f.artifacts, ref.path));
      expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(ref.retainedBytes).toBe(bytes.length);
    }
  }
  for (const run of runs) {
    expect(run.invocationId).toBe(run.nonce);
    expect(readTestReport(join(f.artifacts, `test-manifest-report-${run.nonce}.json`))?.nonce).toBe(run.nonce);
    expect(json(join(f.artifacts, `test-manifest-expected-${run.nonce}.json`)).nonce).toBe(run.nonce);
  }
  expect(row.evidenceReceipt).toEqual(runs.at(-1));
  expect(row.nonce).toBe(runs.at(-1)?.nonce);
  return runs;
}

test("test: the enabled forced-stall release proof returns one-invocation green for healthy tests versus one-invocation regression for expect-one-to-equal-two, so treating a skip as execution or retrying an assertion red fails", async () => {
  for (const mode of ["healthy", "assertion", "skipped"] as const) {
    const f = fixture(mode);
    const row = await verify(f);
    expect(row.pass, row.details).toBe(mode === "healthy");
    const runs = invocations(f, row);
    expect(runs).toHaveLength(1);
    const report = readTestReport(row.reportPath!)!;
    expect(report.requested.sort()).toEqual([parallel, serial]);
    expect(Object.keys(report.completed).sort()).toEqual([parallel, serial]);
    expect(report.certificate?.exitCode).toBe(mode === "assertion" ? 1 : 0);
    expect(runs[0]!.termination.exitCode).toBe(mode === "assertion" ? 1 : 0);
    expect(existsSync(f.drops)).toBe(false);
    if (mode === "skipped") {
      expect(lines(f.executions)).toEqual([]);
      expect(Object.values(report.completed).map(c => c.status)).toEqual(["skipped", "skipped"]);
    } else {
      expect(lines(f.executions)).toEqual([{ file: parallel, nonce: row.nonce }, { file: serial, nonce: row.nonce }]);
      expect(report.completed[parallel]!.tests).toMatchObject({ passed: mode === "healthy" ? 1 : 0, failed: mode === "assertion" ? 1 : 0 });
    }
    if (mode === "assertion") {
      expect(row.cause).toBe("regression");
      expect(row.fingerprints.join("\n")).toContain("expected 1 to be 2");
    }
  }
}, 60_000);

test.skipIf(process.env.TICKMARKR_TEST_FORCE_STALL !== "1")("the enabled forced-stall release proof makes the integration tip verifier recover a real RPC-stranded serial file as parallel exit1 then serial-only exit0 under distinct nonces, so a helper-only green or a full-suite retry fails", async () => {
  const f = fixture("stall");
  console.log(`Forced-stall release proof artifacts: ${f.artifacts}`);
  const row = await verify(f);
  expect(row.pass, row.details).toBe(true);
  expect(row.exitCode).toBe(0);
  expect(row.reused).toBeUndefined();
  const runs = invocations(f, row);
  expect(runs).toHaveLength(2);
  const [first, retry] = runs;
  expect(first!.nonce).not.toBe(retry!.nonce);
  expect(runs.map(r => r.termination.exitCode)).toEqual([1, 0]);
  const firstReport = readTestReport(join(f.artifacts, `test-manifest-report-${first!.nonce}.json`))!;
  const retryReport = readTestReport(row.reportPath!)!;
  expect(firstReport.requested.sort()).toEqual([parallel, serial]);
  expect(firstReport.scheduling).toEqual({ [parallel]: { pool: "forks", singleFork: false }, [serial]: { pool: "forks", singleFork: true } });
  expect(Object.keys(firstReport.started)).toEqual([parallel]);
  expect(Object.keys(firstReport.completed)).toEqual([parallel]);
  expect(firstReport.completed[parallel]).toMatchObject({ status: "passed", tests: { passed: 1, failed: 0, skipped: 0 } });
  expect(firstReport.certificate).toMatchObject({ exitCode: 1, errors: 1 });
  expect(firstReport.certificate!.diagnostics).toHaveLength(1);
  expect(firstReport.certificate!.diagnostics![0]).toContain('Error: [vitest-worker]: Timeout calling "onTaskUpdate"');
  expect(retryReport.requested).toEqual([serial]);
  expect(Object.keys(retryReport.started)).toEqual([serial]);
  expect(Object.keys(retryReport.completed)).toEqual([serial]);
  expect(retryReport.completed[serial]).toMatchObject({ status: "passed", tests: { passed: 1, failed: 0, skipped: 0 } });
  expect(retryReport.certificate).toMatchObject({ exitCode: 0, errors: 0, diagnostics: [] });
  const expected = (nonce: string) => json(join(f.artifacts, `test-manifest-expected-${nonce}.json`));
  expect(expected(first!.nonce!).files).toEqual([parallel, serial]);
  expect(expected(retry!.nonce!)).toMatchObject({ files: [serial], firstNonce: first!.nonce });
  expect(expected(retry!.nonce!).listingCommand).toContain("--exclude=");
  expect(row.spawnedCommand).toContain(serial);
  expect(row.spawnedCommand).toContain("--exclude=");
  expect(lines(f.executions)).toEqual([{ file: parallel, nonce: first!.nonce }, { file: serial, nonce: retry!.nonce }]);
  const drops = readFileSync(f.drops, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(drops).toHaveLength(1);
  const drop = drops[0];
  expect(drop).toMatchObject({ nonce: first!.nonce, method: "onTaskUpdate" });
  expect(drop.report.certificate).toBeUndefined();
  expect(drop.report.completed).toEqual(firstReport.completed);
  expect(drop.report.started).toEqual(firstReport.started);
  expect(drop.droppedAt).toBeGreaterThanOrEqual(firstReport.completed[parallel]!.at);
  // Measure against request creation: the installed birpc default, never a shortened fake timer.
  expect(firstReport.certificate!.at - drop.requestedAt).toBeGreaterThanOrEqual(59_000);
  expect(readFileSync(join(f.artifacts, `test-reporter-${first!.nonce}.mjs`), "utf8")).toBe(TEST_REPORTER_SOURCE);
  for (const run of runs) expect(row.details).toContain(run.nonce!);
  appendFileSync(join(f.artifacts, "proof.txt"), `PASS: ${first!.nonce} parallel exit1 -> ${retry!.nonce} serial-only exit0\n`);
}, 180_000);
