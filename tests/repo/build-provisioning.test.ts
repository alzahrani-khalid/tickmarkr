import { isolatedBuild } from "../fixtures/screen-soak/isolated-build.js";
import { archiveRecord, readArtifact } from "../fixtures/screen-soak/archive.mjs";
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const artifactText = (path: string): string => readArtifact(path).toString("utf8");

const REPO = join(import.meta.dirname, "../..");
const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

function strangerInstallThenTest(): { status: number | null; stderr: string; stdout: string } {
  const cloneDir = mkdtempSync(join(tmpdir(), "tickmarkr-build-provision-"));
  try {
    execSync(`git clone --local "${ROOT}" "${cloneDir}"`, { stdio: "pipe" });
    expect(existsSync(join(cloneDir, "dist"))).toBe(false);
    execSync("npm ci", { cwd: cloneDir, stdio: "pipe" });
    return spawnSync(
      "npm",
      ["test", "--", "tests/cli/version.test.ts", "-t", "built CLI:"],
      {
        cwd: cloneDir,
        encoding: "utf8",
        env: { ...process.env, npm_config_ignore_scripts: "false" },
      },
    );
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

describe("standalone test build provisioning", () => {
  test(
    "the standalone test command provisions a fresh build first so a stranger's install then test passes without a separate build step",
    () => {
      const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
      expect(pkg.scripts.pretest).toBe("npm run build");
      expect(pkg.scripts.test).toBe("vitest run");

      const r = strangerInstallThenTest();
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    },
    // OBS-143 load-margin reasoning: a load-proof 5x original budget absorbs install/build contention;
    // child exit status remains the provisioning oracle, so this timeout is only a runaway guard.
    600_000,
  );
});

test(
  "test: the provisioning test's nested full-suite invocation carries a timeout budget with at least double its prior headroom",
  () => {
    const source = readFileSync(join(REPO, "tests/repo/build-provisioning.test.ts"), "utf8");
    const start = source.indexOf('test(\n    "the standalone test command provisions a fresh build first');
    const end = source.indexOf("\n  );", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, end)).toContain("600_000");
  },
);

test(
  "test: no timing oracle in the touched suites sleeps against an uncontrolled real-time bound",
  () => {
    const driverSuite = readFileSync(join(REPO, "tests/drivers/herdr.test.ts"), "utf8");
    const reconcileSuite = readFileSync(join(REPO, "tests/run/reconcile-live.test.ts"), "utf8");
    const provisioningSuite = readFileSync(join(REPO, "tests/repo/build-provisioning.test.ts"), "utf8");

    expect(driverSuite).not.toMatch(/await new Promise\(\(resolve\) => setTimeout\(resolve,/);
    expect(driverSuite).not.toContain("Date.now()");
    expect(reconcileSuite).not.toMatch(/await new Promise\(\(r\) => setTimeout\(r,/);
    expect(reconcileSuite).not.toContain("Date.now() + 15_000");
    expect(provisioningSuite).toContain("600_000");
  },
);


// The duration gate's normal tests never read private validation documents.
import { validateSoak } from "../fixtures/screen-soak/validate.mjs";
test("lossless soak archives preserve every original sample and verdict and reject ambiguous or corrupt storage", () => {
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  for (const attempt of ["static", "growth", "cutover-static", "cutover-growth", "final-static", "final-growth", "retry-static", "retry-growth"]) {
    const directory = join(REPO, "tests/fixtures/screen-soak/records", attempt);
    const receipt = JSON.parse(readFileSync(join(directory, "archive.json"), "utf8"));
    expect(receipt).toMatchObject({ version: 1, encoding: "gzip" });
    expect(receipt.files.map((file: { path: string }) => file.path)).toEqual(["result.json", "journal.jsonl"]);
    for (const entry of receipt.files) {
      const path = join(directory, entry.path);
      expect(existsSync(path)).toBe(false);
      const raw = readArtifact(path), archived = readFileSync(`${path}.gz`);
      expect([raw.length, hash(raw)], path).toEqual([entry.rawBytes, entry.rawSha256]);
      expect([archived.length, hash(archived)], path).toEqual([entry.archiveBytes, entry.archiveSha256]);
    }
    const result = JSON.parse(artifactText(join(directory, "result.json")));
    const samples = readFileSync(join(directory, "samples.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(result.samples).toEqual(samples);
    expect(result.validation.ok).toBe(attempt.startsWith("retry-"));
    expect(validateSoak(result).ok).toBe(result.validation.ok);
  }
  const directory = mkdtempSync(join(tmpdir(), "c6-archive-"));
  try {
    const path = join(directory, "result.json");
    const original = Buffer.from(' { "failure": "interrupted — 保留", "samples": [] }\n');
    writeFileSync(path, original);
    writeFileSync(join(directory, "journal.jsonl"), "one\ntwo\n");
    archiveRecord(directory);
    expect(readArtifact(path)).toEqual(original);
    expect(() => archiveRecord(directory)).toThrow("archive already exists");
    writeFileSync(path, "different");
    expect(() => readArtifact(path)).toThrow("ambiguous artifact");
    rmSync(path);
    writeFileSync(`${path}.gz`, "truncated gzip");
    expect(() => readArtifact(path)).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("duration rechecks preserve failed measurements and refuse raw-series or build-identity drift", () => {
  const destination = mkdtempSync(join(tmpdir(), "c6-recheck-integrity-"));
  const original = join(REPO, "tests/fixtures/screen-soak/records/final-static");
  cpSync(original, destination, { recursive: true });
  const recheck = () => spawnSync(process.execPath, [join(REPO, "tests/fixtures/screen-soak/recheck.mjs"), destination], { encoding: "utf8" });
  try {
    const before = artifactText(join(destination, "result.json"));
    const checked = recheck();
    expect(checked.status, checked.stderr).toBe(1);
    const receipt = JSON.parse(checked.stdout);
    expect(receipt.validatorSourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.validatorSha256).toBe(createHash("sha256").update(readFileSync(join(REPO, "tests/fixtures/screen-soak/validate.mjs"))).digest("hex"));
    expect(receipt.records[0].originalValidation).toEqual(JSON.parse(before).validation);
    expect(receipt.records[0].validation.ok).toBe(false);
    expect(receipt.records[0].validation.errors).toContain("missing or late minute sample");
    expect(receipt.records[0].hashes["result.json"]).toBe(createHash("sha256").update(before).digest("hex"));
    expect(artifactText(join(destination, "result.json"))).toBe(before);
    const samples = readFileSync(join(destination, "samples.jsonl"), "utf8");
    writeFileSync(join(destination, "samples.jsonl"), samples.split("\n").slice(1).join("\n"));
    expect(recheck().stderr).toContain("result differs from raw sample series");
    writeFileSync(join(destination, "samples.jsonl"), samples);
    const build = JSON.parse(readFileSync(join(destination, "build.json"), "utf8"));
    writeFileSync(join(destination, "build.json"), JSON.stringify({ ...build, sourceCommit: "0".repeat(40) }));
    expect(recheck().stderr).toContain("build identity differs");
  } finally { rmSync(destination, { recursive: true, force: true }); }
});
test("Before default narrator cutover, changed docs/validation/screen-soak.md and its reproducible isolated fixture/harness record exact built source commit, production UI PID, bounded sink, monotonic sample series and successful four-hour static plus four-hour growing-journal runs with resize/input. The protocol in the spec preamble applies its retained-heap and late-growth ceilings, preserving raw RSS/heap/artifact paths. A missing sample, early-dead process, demo-only render, fabricated duration or enabling cutover before the complete records fails.", () => {
  // Synthetic records test rejection boundaries only; they are not soak evidence.
  const ticks = [...new Set([...Array.from({ length: 241 }, (_, i) => i * 60), 1000, 12400])].sort((a, b) => a - b);
  const specimen = {
    protocol: "C6-four-hour-production-v1", sourceCommit: "a".repeat(40), environment: { NODE_ENV: null },
    pid: 123, durationSeconds: 14400, elapsedMs: 14400001, sinkLimit: 20000, writes: 14401, bytes: 1440000,
    startedAt: new Date(1700000000000).toISOString(), endedAt: new Date(1700014400001).toISOString(),
    orderlyExit: true, failure: null, resizeCount: 144, inputCount: 144,
    samples: ticks.map(tick => ({ tick, pid: 123, timestamp: new Date(1700000000000 + tick * 1000).toISOString(), monotonicMs: tick * 1000,
      heap: 32 * 1048576, rss: 180 * 1048576, pendingOutputBytes: 0, view: "RUN" })),
  };
  expect(validateSoak(specimen).ok).toBe(true);
  // A real wall clock can slew behind monotonic time. Do not reject four hours
  // of measured observations for that drift, or let slow teardown substitute
  // for a missing fraction of the measured duration.
  const wallSlew = {
    ...specimen, endedAt: new Date(Date.parse(specimen.endedAt) - 250).toISOString(),
    samples: specimen.samples.map(row => ({ ...row,
      timestamp: new Date(Date.parse(row.timestamp) - row.tick / 14400 * 250).toISOString(),
    })),
  };
  expect(validateSoak(wallSlew).ok).toBe(true);
  for (const broken of [
    { ...specimen, durationSeconds: Infinity }, { ...specimen, elapsedMs: NaN },
    { ...specimen, samples: specimen.samples.map(row => row.tick === 120 ? { ...row, monotonicMs: NaN } : row) },
    { ...specimen, durationSeconds: 14399 }, { ...specimen, orderlyExit: false },
    { ...specimen, samples: specimen.samples.map(row => row.tick === 14400 ? { ...row, monotonicMs: 14399999 } : row) },
    { ...specimen, endedAt: new Date(1700000000001).toISOString() },
    { ...specimen, sourceCommit: "unknown" }, { ...specimen, sinkLimit: Infinity },
    { ...specimen, environment: { NODE_ENV: "production" } }, { ...specimen, writes: 0 },
    { ...specimen, samples: specimen.samples.filter(row => row.tick !== 120) },
    { ...specimen, samples: specimen.samples.filter(row => row.tick !== 12400) },
    { ...specimen, samples: specimen.samples.map(row => row.tick === 14400 ? { ...row, view: "EVIDENCE" } : row) },
    { ...specimen, samples: specimen.samples.map(row => row.tick === 14400 ? { ...row, heap: 65 * 1048576 } : row) },
    { ...specimen, samples: specimen.samples.map(row => row.tick === 14400 ? { ...row, heap: 49 * 1048576 } : row) },
    { ...specimen, samples: specimen.samples.map(row => row.tick === 120 ? { ...row, monotonicMs: 240001 } : row) },
    { ...specimen, samples: specimen.samples.map(row => row.tick >= 120 ? { ...row, timestamp: new Date(Date.parse(row.timestamp) + 975000).toISOString() } : row) },
  ]) expect(validateSoak(broken).ok).toBe(false);
  // Actual interrupted production measurements remain negative evidence. Their
  // scheduled tick numbers cannot conceal the wall/monotonic sampling gaps.
  for (const shape of ["final-static", "final-growth"]) {
    const artifacts = join(REPO, "tests/fixtures/screen-soak/records", shape);
    const recorded = JSON.parse(artifactText(join(artifacts, "result.json")));
    const raw = readFileSync(join(artifacts, "samples.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(recorded.samples).toEqual(raw);
    expect(recorded.validation.ok).toBe(false);
    expect(validateSoak(recorded).errors).toContain("missing or late minute sample");
    expect(recorded.orderlyExit).toBe(true);
  }
  // Complete production evidence is required before default cutover. This uses
  // exported raw artifacts, never private docs or a future-duration promise.
  const receipt = JSON.parse(readFileSync(join(REPO, "tests/fixtures/screen-soak/records/retry-validation.json"), "utf8"));
  expect(receipt.validatorSourceCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(receipt.validatorSha256).toBe(createHash("sha256").update(readFileSync(join(REPO, "tests/fixtures/screen-soak/validate.mjs"))).digest("hex"));
  expect(receipt.records).toHaveLength(2);
  const pids = new Set(), repositories = new Set(), sourceCommits = new Set();
  for (const shape of ["static", "growth"]) {
    const path = `tests/fixtures/screen-soak/records/retry-${shape}`;
    const artifacts = join(REPO, path);
    const recorded = JSON.parse(artifactText(join(artifacts, "result.json")));
    const build = JSON.parse(readFileSync(join(artifacts, "build.json"), "utf8"));
    const raw = readFileSync(join(artifacts, "samples.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const checked = receipt.records.find((row: { path: string }) => row.path === path);
    expect(checked).toBeDefined();
    expect(recorded.samples).toEqual(raw);
    expect(raw).toHaveLength(243);
    expect(new Set(raw.map(row => row.view))).toEqual(new Set(["HOME", "RUN", "EVIDENCE"]));
    expect(validateSoak(recorded)).toEqual(checked.validation);
    expect(checked.validation.ok).toBe(true);
    expect(checked.originalValidation).toEqual(recorded.validation);
    expect(recorded.validation.ok).toBe(true);
    expect(recorded).toMatchObject({ shape, pid: checked.pid, sourceCommit: checked.sourceCommit, orderlyExit: true, failure: null, resizeCount: 144, inputCount: 144 });
    expect(recorded.writes).toBeGreaterThan(14400);
    expect(recorded.sourceCommit).toBe(build.sourceCommit);
    expect(build.hashes["dist/tui/cockpit/live-runtime.js"]).toMatch(/^[a-f0-9]{64}$/);
    for (const file of ["build.json", "metadata.json", "samples.jsonl", "result.json", "journal.jsonl", "last-frame.ansi"]) {
      expect(createHash("sha256").update(readArtifact(join(artifacts, file))).digest("hex")).toBe(checked.hashes[file]);
    }
    const journal = artifactText(join(artifacts, "journal.jsonl")).trim().split("\n").map(line => JSON.parse(line));
    expect(journal.slice(0, 2).map(row => row.event)).toEqual(["run-start", "task-dispatch"]);
    expect(journal).toHaveLength(shape === "static" ? 2 : 1442);
    expect(journal.slice(2).every(row => row.event === "worker-nudge" && row.taskId === "T1")).toBe(true);
    expect(readFileSync(join(artifacts, "last-frame.ansi"), "utf8")).toContain("run-screen-soak");
    pids.add(recorded.pid); repositories.add(recorded.fixture); sourceCommits.add(recorded.sourceCommit);
  }
  expect(pids.size).toBe(2); expect(repositories.size).toBe(2); expect(sourceCommits.size).toBe(1);
  const destination = mkdtempSync(join(tmpdir(), "c6-duration-negative-"));
  const env = { ...process.env, C6_BUILD_ROOT: isolatedBuild() }; delete env.NODE_ENV;
  try {
    const child = spawnSync(process.execPath, ["--expose-gc", join(REPO, "tests/fixtures/screen-soak/soak.mjs"), "static", destination, "1"], { cwd: REPO, encoding: "utf8", env });
    expect(child.status, child.stderr).toBe(1);
    const actual = JSON.parse(readFileSync(join(destination, "result.json"), "utf8"));
    expect(actual.writes).toBeGreaterThan(0); expect(actual.pid).toBeGreaterThan(0);
    expect(actual.validation.errors).toContain("less than four hours");
    expect(actual.samples.length).toBeGreaterThan(1);
    expect(readFileSync(join(destination, "last-frame.ansi"), "utf8")).toContain("tickmarkr");
    const preserved = readFileSync(join(destination, "samples.jsonl"), "utf8");
    const repeated = spawnSync(process.execPath, ["--expose-gc", join(REPO, "tests/fixtures/screen-soak/soak.mjs"), "static", destination, "1"], { cwd: REPO, encoding: "utf8", env });
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain("artifact directory is not empty");
    expect(readFileSync(join(destination, "samples.jsonl"), "utf8")).toBe(preserved);
  } finally { rmSync(destination, { recursive: true, force: true }); }
}, 30000);
