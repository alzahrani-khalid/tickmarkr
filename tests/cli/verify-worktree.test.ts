import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel } from "../../src/adapters/types.js";
import {
  baselineCachePath, excludeAuthorProvider, verify, verifyStateRoot,
} from "../../src/cli/commands/verify.js";
import { getVerdictStore } from "../../src/gates/cache.js";
import { pickReviewer } from "../../src/gates/review.js";
import { graphPath, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { approve } from "../../src/cli/commands/approve.js";
import { runDaemon } from "../../src/run/daemon.js";
import { foldOwedChecks, Journal, owedSubject, type JournalEvent, type OwedCheck } from "../../src/run/journal.js";
import { withRepositoryLease } from "../../src/run/lease.js";
import { COMMIT, T, authedModels, makeRepo, makeTestTempDir, setupRepo } from "../helpers/tmprepo.js";

const git = (repo: string, command: string) => execSync(`git ${command}`, { cwd: repo, encoding: "utf8" }).trim();

function branch(repo: string): void {
  git(repo, "checkout -b feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  execSync(`${COMMIT} feature`, { cwd: repo });
}

afterEach(() => {
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  vi.restoreAllMocks();
});

describe("verify worktree truth", () => {
  test("test: verify --task run from a linked worktree whose state dir lacks the three files reads graph doctor and config from the git common dir's root and prints that resolution as its first line and warns naming the task's own merge commit when the range also carries another task's merge whereas the shipped command that stops at no graph or grades the wider range silently fails", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    git(repo, "checkout -b task-one");
    writeFileSync(join(repo, "one.txt"), "one\n");
    execSync(`${COMMIT} one`, { cwd: repo });
    git(repo, "checkout main");
    git(repo, "checkout -b task-two");
    writeFileSync(join(repo, "two.txt"), "two\n");
    execSync(`${COMMIT} two`, { cwd: repo });
    git(repo, "checkout main");
    git(repo, "checkout -b integration");
    git(repo, "merge --no-ff task-one -m 'merge T1'");
    const ownMerge = git(repo, "rev-parse HEAD");
    git(repo, "merge --no-ff task-two -m 'merge T2'");
    const otherMerge = git(repo, "rev-parse HEAD");

    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1", { files: ["*.txt"] }), T("T2", { files: ["*.txt"] })],
    }));
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "review:\n  required: false\n");
    writeFileSync(join(repo, ".tickmarkr", "doctor.json"), "{}\n");
    Journal.create(repo, "run-worktree-warning-own").append("merge", "T1", { commit: ownMerge, branch: "task-one" });
    Journal.create(repo, "run-worktree-warning-other").append("merge", "T2", { commit: otherMerge, branch: "task-two" });

    const linked = join(makeTestTempDir("tickmarkr-linked-parent-"), "linked");
    git(repo, `worktree add --detach '${linked}' HEAD`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stateRoot = await verifyStateRoot(linked);
      expect(stateRoot).toBe(realpathSync(repo));
      const result = await verify(["--base", "main", "--task", "T1", "--no-review", "--no-acceptance"], linked);
      expect(result.code).toBe(0);
      const lines = errors.mock.calls.map((call) => String(call[0]));
      expect(lines[0]).toContain(`resolved read-only from ${join(realpathSync(repo), ".tickmarkr")}`);
      expect(lines.find((line) => line.includes("WARNING --task T1"))).toContain(ownMerge);
      expect(lines.find((line) => line.includes("WARNING --task T1"))).toContain("T2");
    } finally {
      git(repo, `worktree remove --force '${linked}'`);
    }
  }, 60_000);

  test("test: the baseline cache file is keyed by base sha lockfile hash and gate command hash so a second worktree of the same base reuses a healthy capture without re-running it while a capture that recorded no verdict is never written to the cache and the next invocation says so in its first line whereas a path-keyed cache or a cached verdictless entry fails", async () => {
    const counter = join(makeTestTempDir("tickmarkr-counter-"), "count");
    const repo = makeRepo({
      "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }),
      "check.sh": `printf x >> '${counter}'\n`,
      "src.txt": "base\n",
    });
    branch(repo);
    const base = git(repo, "merge-base main HEAD");
    const commands = { test: "npm run -s test" };
    const cache = baselineCachePath(repo, base, commands);
    const linked = join(makeTestTempDir("tickmarkr-cache-linked-"), "linked");
    git(repo, `worktree add --detach '${linked}' HEAD`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await verify(["--no-review"], repo);
      await verify(["--no-review"], linked);
      expect(readFileSync(counter, "utf8")).toBe("xxx"); // baseline once, two head batteries
      expect(errors.mock.calls.flat().join("\n")).toContain(`reusing cached baseline for ${base.slice(0, 12)}`);
      expect(baselineCachePath(linked, base, commands)).toBe(cache);
    } finally {
      git(repo, `worktree remove --force '${linked}'`);
    }

    const badRepo = makeRepo({
      "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }),
      "check.sh": "echo 'Error: spawn EAGAIN'\nexit 1\n",
      "src.txt": "base\n",
    });
    branch(badRepo);
    const badBase = git(badRepo, "merge-base main HEAD");
    const badCache = baselineCachePath(badRepo, badBase, commands);
    await verify(["--no-review"], badRepo);
    expect(existsSync(badCache)).toBe(false);
    errors.mockClear();
    await verify(["--no-review"], badRepo);
    expect(String(errors.mock.calls[0]?.[0])).toContain("prior baseline recorded no verdict and was not cached");
    expect(existsSync(badCache)).toBe(false);
  }, 60_000);

  test("test: verify persists its gate rows and review findings as JSON in the artifacts directory it names and prints the written file's path whereas a verify whose named directory stays empty fails", async () => {
    const repo = makeRepo({ "src.txt": "base\n" });
    branch(repo);
    writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
    const script = join(makeTestTempDir("tickmarkr-artifact-review-"), "script.json");
    writeFileSync(script, JSON.stringify({
      tasks: {},
      review: { findings: [{ note: "persist this finding", severity: "minor", defer: true, rationale: "follow-up" }] },
    }));
    process.env.TICKMARKR_FAKE_SCRIPT = script;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await verify(["--json"], repo);
    const report = JSON.parse(result.out) as { artifactPath: string };
    const artifact = JSON.parse(readFileSync(report.artifactPath, "utf8")) as {
      gateRows: unknown[];
      reviewFindings: Array<{ note: string }>;
    };
    expect(artifact.gateRows.length).toBeGreaterThan(0);
    expect(artifact.reviewFindings.map((finding) => finding.note)).toContain("persist this finding — rationale: follow-up");
    expect(errors.mock.calls.flat().join("\n")).toContain(`artifacts written to ${report.artifactPath}`);
  }, 60_000);

  test("test: verify --author naming a channel whose model resolves to provider openai refuses every failover seat of that provider even when its stamped vendor differs and answers unreadable when the non-excluded pool is exhausted and --record appends the resolved review as a review-leg2 row in the named run's journal whereas a failover into a same-provider seat or a verdict that lands nowhere fails", async () => {
    const author: BillingChannel = { adapter: "pi", vendor: "zhipu", model: "openai-codex/gpt-5.5", channel: "sub", tier: "frontier" };
    const sameProvider: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-5.6-sol", channel: "sub", tier: "frontier" };
    const crossProvider: BillingChannel = { adapter: "kimi", vendor: "moonshot", model: "kimi-code/k3", channel: "sub", tier: "frontier" };
    const eligible = excludeAuthorProvider([author, sameProvider, crossProvider], author);
    expect(eligible).toEqual([author, crossProvider]);
    const assignment = { adapter: author.adapter, model: author.model, channel: author.channel, tier: author.tier };
    expect(pickReviewer(assignment, eligible)).toEqual(crossProvider);
    expect(pickReviewer(assignment, eligible, ["kimi:kimi-code/k3"])).toBeNull();

    const repo = makeRepo({ "src.txt": "base\n" });
    branch(repo);
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1", { files: ["src.txt"] })],
    }));
    writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
    const script = join(makeTestTempDir("tickmarkr-review-script-"), "script.json");
    writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
    process.env.TICKMARKR_FAKE_SCRIPT = script;
    const journal = Journal.create(repo, "run-leg2-record");
    journal.append("run-start", undefined, {});

    const result = await verify(["--task", "T1", "--no-acceptance", "--record", "run-leg2-record"], repo);
    expect(result.code).toBe(0);
    const row = journal.read().find((event) => event.event === "review-leg2");
    expect(row).toMatchObject({ taskId: "T1", data: { gate: "review", pass: true } });
  }, 60_000);

  test("test: verify's results file carries the review raw path beside the artifacts it already names and the file at that path holds the reviewer's verdict bytes, so a results file naming a path that does not exist fails", async () => {
    const repo = makeRepo({ "src.txt": "base\n" });
    branch(repo);
    writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
    const script = join(makeTestTempDir("tickmarkr-artifact-review-raw-"), "script.json");
    writeFileSync(script, JSON.stringify({
      tasks: {},
      review: { approve: true, findings: [] },
    }));
    process.env.TICKMARKR_FAKE_SCRIPT = script;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await verify(["--json"], repo);
    const report = JSON.parse(result.out) as { artifactPath: string };
    const artifact = JSON.parse(readFileSync(report.artifactPath, "utf8")) as {
      gateRows: Array<{ gate: string; meta?: { rawPath?: string; briefPath?: string } }>;
      reviewFindings: Array<{ note: string }>;
    };
    const reviewRow = artifact.gateRows.find((row) => row.gate === "review");
    expect(reviewRow).toBeDefined();
    expect(reviewRow?.meta?.briefPath).toBeDefined();
    expect(reviewRow?.meta?.rawPath).toBeDefined();
    const rawPath = String(reviewRow?.meta?.rawPath);
    const briefPath = String(reviewRow?.meta?.briefPath);
    expect(existsSync(briefPath)).toBe(true);
    expect(existsSync(rawPath)).toBe(true);
    const rawBytes = readFileSync(rawPath, "utf8");
    expect(rawBytes).toContain('"approve": true');
  }, 60_000);
});

test("test: verify run from a linked worktree whose state directory holds config.yaml but not graph.json or doctor.json reads config.yaml locally and only the two absent files from the common root and prints a caveat naming each file's origin, while a worktree lacking all three still reads all three from the common root, so a partial local state directory silently overridden by the common root fails", async () => {
  const repo = makeRepo({ ".gitignore": ".tickmarkr/\n", "src.txt": "base\n" });
  branch(repo);
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [T("T1", { files: ["src.txt"] })] }));
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  const scratch = makeTestTempDir("verify-file-origins-");
  const counter = join(scratch, "commands");
  const config = (origin: string) => `gates:\n  test: "printf ${origin} >> '${counter}'"\n`;
  writeFileSync(join(repo, ".tickmarkr/config.yaml"), config("common"));
  const script = join(scratch, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  const linked = join(scratch, "linked");
  git(repo, `worktree add --detach '${linked}' HEAD`);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mkdirSync(join(linked, ".tickmarkr"));
    writeFileSync(join(linked, ".tickmarkr/config.yaml"), config("local"));
    for (const local of [true, false]) {
      if (!local) rmSync(join(linked, ".tickmarkr/config.yaml"));
      errors.mockClear();
      const result = await verify(["--task", "T1", "--no-acceptance"], linked);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("PASS review"); // doctor was read from common root
      expect(result.out).toContain("PASS scope"); // task graph was read from common root
      const caveat = String(errors.mock.calls[0]?.[0]);
      for (const file of ["config.yaml", "graph.json", "doctor.json"]) {
        const isLocal = local && file === "config.yaml";
        expect(caveat).toContain(`${file}: ${join(isLocal ? linked : realpathSync(repo), ".tickmarkr", file)} (${isLocal ? "local" : "common root"})`);
      }
      expect(readFileSync(counter, "utf8")).toBe(local ? "locallocal" : "locallocalcommoncommon");
    }
  } finally {
    git(repo, `worktree remove --force '${linked}'`);
  }
}, 60_000);

test("test: standalone verify persists each executed tool gate's receipt in verify results and when review recording is enabled its review leg2 row references that exact results artifact by hash, so dropping tool receipts or fabricating a review row fails", async () => {
  const repo = makeRepo({
    "src.txt": "base\n",
    "package.json": JSON.stringify({ scripts: { build: "printf build", test: "printf test", lint: "printf lint" } }),
  });
  branch(repo);
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  const script = join(makeTestTempDir("receipt-review-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const review of [true, false]) {
    getVerdictStore(join(repo, ".tickmarkr")).clear(); // this oracle covers fresh writers, not reuse
    const journal = Journal.create(repo, `run-receipt-review-${review}`);
    journal.append("run-start", undefined, {});
    const result = await verify(["--json", "--record", `run-receipt-review-${review}`, ...(!review ? ["--no-review"] : [])], repo);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    const bytes = readFileSync(report.artifactPath);
    const artifact = JSON.parse(bytes.toString());
    for (const gate of ["build", "test", "lint"]) {
      const row = artifact.gateRows.find((row: { gate: string }) => row.gate === gate);
      expect(row.evidenceReceipt).toEqual(report.results.find((row: { gate: string }) => row.gate === gate).evidenceReceipt);
      expect(row.evidenceReceipt).toMatchObject({ invocationId: expect.any(String), availability: "available" });
      for (const stream of ["stdout", "stderr"]) {
        const ref = row.evidenceReceipt[stream];
        expect(createHash("sha256").update(readFileSync(join(report.artifactPath, "..", ref.path))).digest("hex")).toBe(ref.sha256);
      }
    }
    const rows = journal.read().filter(row => row.event === "review-leg2");
    expect(rows).toHaveLength(review ? 1 : 0);
    if (review) expect(rows[0]!.data).toMatchObject({
      artifactPath: report.artifactPath, artifactAvailability: "available",
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}, 60_000);

test("test: one successful plus one failed executed command under healthy or injected failing evidence persistence on the tip verify path or the standalone path keep pass classification plus recovery decision unchanged under capture-failed evidence, so an evidence failure that alters recovery authority fails", async () => {
  const { verifyIntegrationTip } = await import("../../src/run/merge.js");
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const code of [0, 1]) {
    const command = `printf 'FAIL new assertion'; printf diagnostic >&2; exit ${code}`;
    const repo = makeRepo({ "src.txt": "base\n", "package.json": JSON.stringify({ scripts: { build: command } }) });
    branch(repo);
    const baseline = join(makeTestTempDir("receipt-baseline-"), "baseline.json");
    writeFileSync(baseline, JSON.stringify({ commands: { build: { exitCode: 0, fingerprints: [] } } }));
    const verdicts = [];
    for (const fail of [false, true]) {
      getVerdictStore(join(repo, ".tickmarkr")).clear();
      const evidence = fail ? { write: (path: string) => {
        // Block both the raw stream persistence and the standalone summary write.
        mkdirSync(join(dirname(dirname(path)), "verify-results.json"), { recursive: true });
        throw new Error("injected disk failure");
      } } : {};
      const tipDir = makeTestTempDir("tip-capture-");
      if (fail) mkdirSync(join(tipDir, "tip-verify-build.log"));
      const [tip] = await verifyIntegrationTip(repo, { build: command }, tipDir, undefined, evidence);
      const standalone = await verify(["--json", "--no-review", "--baseline", baseline], repo, { evidence });
      const report = JSON.parse(standalone.out);
      expect(report.artifactAvailability).toBe(fail ? "capture-failed" : "available");
      expect(report.artifactSha256 === null).toBe(fail);
      const build = report.results.find((row: { gate: string }) => row.gate === "build");
      for (const row of [tip, build]) {
        expect(row.evidenceReceipt.availability).toBe(fail ? "capture-failed" : "available");
        expect(row.pass).toBe(code === 0);
        expect(row.evidenceReceipts).toHaveLength(1);
      }
      verdicts.push({
        tip: { pass: tip!.pass, cause: tip!.cause, details: tip!.details },
        standalone: { code: standalone.code, pass: build.pass, classification: build.meta?.classification,
          recoveryBlocked: build.meta?.recoveryBlocked, disposition: build.meta?.disposition, details: build.details },
      });
    }
    expect(verdicts[1]).toEqual(verdicts[0]);
  }
}, 60_000);

test("test: verify semantic red exits 2 before a separate repository-lease holder releases whereas green reaches baseline/candidate tests after release; the ordered trace places cheap gates then concurrent semantics before leased tests", async () => {
  const scratch = makeTestTempDir("tickmarkr-verify-trace-");
  const trace = join(scratch, "trace.log");
  writeFileSync(trace, "");
  const repo = makeRepo({
    "src.txt": "base\n",
    "package.json": JSON.stringify({ scripts: Object.fromEntries(["build", "lint", "test"].map((g) => [g, `echo ${g} >> '${trace}'`])) }),
  });
  branch(repo);
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n");
  const criteria = join(scratch, "criteria.md");
  writeFileSync(criteria, "- the feature line is appended to src.txt\n");
  const script = join(scratch, "script.json");
  const scripted = (approve: boolean) => writeFileSync(script, JSON.stringify({
    tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "appended" }] }, review: { approve, issues: approve ? [] : ["real defect"] },
  }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  // verify's stderr lands in the same file its commands append to, so one file is the real order.
  vi.spyOn(console, "error").mockImplementation((line: unknown) => appendFileSync(trace, `${String(line)}\n`));
  const tokens = () => readFileSync(trace, "utf8").split("\n").flatMap((line) => {
    if (["build", "lint", "test", "released"].includes(line)) return [line];
    const event = /^verify: (→|✓|✗) (\w+)/.exec(line);
    if (event) return [`${event[1] === "→" ? "start" : "end"}:${event[2]}`];
    return line.includes("waiting for the repository's runner lease") ? ["lease-wait"] : [];
  });

  let release!: () => void;
  const releasing = new Promise<void>((r) => { release = r; });
  let holding!: () => void;
  const holds = new Promise<void>((r) => { holding = r; });
  let released = false;
  const holder = withRepositoryLease(repo, async () => { holding(); await releasing; }, { pollMs: 50 }).then(() => { released = true; });
  await holds;

  scripted(false);
  const red = await verify(["--criteria", criteria, "--files", "src.txt"], repo);
  expect(red.code, red.out).toBe(2);
  expect(red.out).toContain("FAIL review");
  expect(red.out).not.toMatch(/^(?:PASS|FAIL) test$/m);
  expect(released).toBe(false); // the red answered while the holder still held the lease
  expect(tokens()).not.toContain("lease-wait");
  expect(tokens()).not.toContain("test");

  // Fresh verdicts so the green's own trace shows every cheap command it ran.
  getVerdictStore(join(repo, ".tickmarkr")).clear();
  writeFileSync(trace, "");
  scripted(true);
  const pending = verify(["--criteria", criteria, "--files", "src.txt"], repo);
  // A verify that settles before queueing on the lease fails here with its own output.
  await Promise.race([
    vi.waitFor(() => expect(tokens()).toContain("lease-wait"), { timeout: 60_000, interval: 50 }),
    pending.then((r) => { throw new Error(`verify settled before queueing on the held lease:\n${r.out}`); }),
  ]);
  expect(tokens()).not.toContain("test");
  appendFileSync(trace, "released\n");
  release();
  await holder;
  const green = await pending;
  expect(green.code, green.out).toBe(0);
  const seen = tokens();
  expect(seen.slice(0, 10)).toEqual(["start:build", "build", "end:build", "start:lint", "lint", "end:lint",
    "start:evidence", "end:evidence", "start:scope", "end:scope"]);
  expect(seen.slice(10, 12)).toEqual(["start:acceptance", "start:review"]); // both in flight before either answers
  expect(seen.slice(12, 14).sort()).toEqual(["end:acceptance", "end:review"]);
  expect(seen.slice(14)).toEqual(["lease-wait", "released", "build", "test", "start:test", "test", "end:test"]); // base rebuild + suite, then candidate
}, 120_000);

// ── C1: owed checks ─────────────────────────────────────────────────────────────────────────────
const FAKE_DOCTOR = { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } };
const dispatchRow = (model: string) => ({ attempt: 1, assignment: { adapter: "fake", model, channel: "sub", tier: "frontier" } });

/** A zero-token owed-check repository: fake seats only (fake-1 is vendor fake-a, fake-2 is fake-b). */
function owedRepo(): { repo: string; git: (c: string) => string } {
  const repo = makeRepo({ "a.txt": "a\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["*.txt"] })] }));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n");
  writeDoctor(repo, FAKE_DOCTOR);
  const script = join(makeTestTempDir("tickmarkr-owed-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { repo, git: (c: string) => git(repo, c) };
}

/** Park a review gate-fail on the task branch's current tip, then waive it through production approve. */
async function parkAndWaive(repo: string, runId: string, journal: Journal): Promise<OwedCheck> {
  const head = git(repo, `rev-parse tickmarkr/${runId}--T1`);
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "red", commit: owedSubject(repo, git(repo, `merge-base tickmarkr/${runId} ${head}`), head) });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision required" });
  await approve([runId, "T1", "--waive", "--by", "operator", "--reason", `accepted ${runId}`], repo);
  return [...journal.read()].reverse().find((e) => e.event === "task-approved")!.data.obligation as OwedCheck;
}

const commitFile = (repo: string, body: string, message: string) => {
  writeFileSync(join(repo, "a.txt"), body);
  execSync(`${COMMIT} ${message}`, { cwd: repo });
};

test("verify record excludes both contributing authors by stable patch ownership across changed commit objects and ignores a restored gate-only seat as an author while same-vendor review or author human cannot erase those exclusions", async () => {
  const { repo, git: g } = owedRepo();
  const later = { ...process.env, GIT_COMMITTER_DATE: "2026-09-30T12:00:00Z" }; // a carry mints NEW commit objects

  // Two contributing authors: fake-1 lands c1; fake-2's attempt carries c1 (as a new object) and lands c2.
  g("branch -f tickmarkr/run-two main");
  g("checkout -q -B tickmarkr/run-two--T1 main");
  commitFile(repo, "a\none\n", "one");
  const c1 = g("rev-parse HEAD");
  const two = Journal.create(repo, "run-two");
  two.append("run-start", undefined, {});
  two.append("task-dispatch", "T1", dispatchRow("fake-1"));
  two.append("worker-launch", "T1", {});
  two.append("task-dispatch", "T1", { ...dispatchRow("fake-2"), attempt: 2 });
  g("reset -q --hard main");
  execSync(`git cherry-pick ${c1}`, { cwd: repo, env: later, stdio: "ignore" });
  expect(g("rev-parse HEAD")).not.toBe(c1);
  two.append("worktree-recreation", "T1", { attempted: [c1], carried: [c1] });
  two.append("worker-launch", "T1", {});
  commitFile(repo, "a\none\ntwo\n", "two");
  g("checkout -q main");
  const both = await parkAndWaive(repo, "run-two", two);
  expect(both).toMatchObject({ known: true, authors: ["fake:fake-1", "fake:fake-2"] });

  // Neither `--author human` nor a same-vendor --author claim narrows the recorded exclusions: with
  // both vendors excluded no reviewer can be seated, so the check stays owed.
  g(`checkout -q --detach ${both.head}`);
  for (const claim of ["human", "fake:fake-2"]) {
    const result = await verify(["--task", "T1", "--no-acceptance", "--author", claim, "--record", "run-two"], repo);
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain("no cross-vendor reviewer available");
    expect(result.out).toContain("owed checks for run-two: debt 1");
  }
  expect(foldOwedChecks(two.read(), repo)).toMatchObject({ known: true, debt: 1, outstanding: [{ id: both.id }] });

  // A restored gate-only seat: fake-2 is restored to re-gate fake-1's carried patch and lands nothing.
  g("checkout -q main");
  g("branch -f tickmarkr/run-restored main");
  g("checkout -q -B tickmarkr/run-restored--T1 main");
  commitFile(repo, "a\nsolo\n", "solo");
  const solo = g("rev-parse HEAD");
  const restored = Journal.create(repo, "run-restored");
  restored.append("run-start", undefined, {});
  restored.append("task-dispatch", "T1", dispatchRow("fake-1"));
  restored.append("worker-launch", "T1", {});
  restored.append("gate-result", "T1", { gate: "acceptance", pass: false, details: "red" });
  restored.append("task-human", "T1", { kind: "gate-fail", reason: "first park" });
  restored.append("resume-restore", "T1", { attempts: 1, tried: ["fake:fake-1"], assignment: dispatchRow("fake-2").assignment });
  g("reset -q --hard main");
  execSync(`git cherry-pick ${solo}`, { cwd: repo, env: later, stdio: "ignore" });
  restored.append("worktree-recreation", "T1", { attempted: [solo], carried: [solo] });
  g("checkout -q main");
  const one = await parkAndWaive(repo, "run-restored", restored);
  expect(one).toMatchObject({ known: true, authors: ["fake:fake-1"] });
  g(`checkout -q --detach ${one.head}`);
  const ok = await verify(["--task", "T1", "--no-acceptance", "--author", "human", "--record", "run-restored"], repo);
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toContain("owed checks for run-restored: debt 0");
  const discharge = restored.read().find((e) => e.event === "owed-check-discharged")!;
  expect(discharge.data).toMatchObject({ reviewer: { key: "fake:fake-2", vendor: "fake-b" }, authorChannels: [{ key: "fake:fake-1", vendor: "fake-a" }] });
}, 240_000);

test("approve waive followed by runDaemon restart persists exactly one accepted-risk obligation in the run-end row across carried replay or findings resets; verify record returns exit 0 debt 0 for validated proof versus exit 2 unknown debt for legacy missing or malformed evidence; accepted-risk history survives discharge", async () => {
  const { repo, fake } = setupRepo([T("T1", { files: ["*.txt"] })], {
    judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "operator override required" }] },
    review: { approve: true, issues: [] },
    consult: { action: "human", notes: "operator must decide" },
    tasks: { T1: [{ shell: `echo approved > approved.txt && ${COMMIT} approved`, result: { ok: true, summary: "implemented" } }] },
  });
  writeDoctor(repo, FAKE_DOCTOR);
  const runId = "run-owed-restart";
  expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
  await approve([runId, "T1", "--waive", "--by", "operator", "--reason", "D-2 restart"], repo);
  const journal = Journal.open(repo, runId);
  const obligation = journal.read().find((e) => e.event === "task-approved")!.data.obligation as OwedCheck;
  expect(obligation).toMatchObject({ known: true, gate: "acceptance" });
  expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).done).toEqual(["T1"]);
  // A second restart of the finished run replays the waiver's history; it never mints a second check.
  await runDaemon(repo, { adapters: [fake], runId, resume: true });
  const runEnds = journal.read().filter((e) => e.event === "run-end");
  expect(runEnds.length).toBeGreaterThanOrEqual(2);
  for (const end of runEnds.slice(1)) {
    expect(end.data.owedChecks).toMatchObject({ known: true, debt: 1, acceptedRisk: [{ id: obligation.id }], outstanding: [{ id: obligation.id }] });
    expect((end.data.owedChecks as { acceptedRisk: unknown[] }).acceptedRisk).toHaveLength(1);
  }

  // Validated proof: the task's own integration merge, after run-end.
  const merge = journal.read().find((e) => e.event === "merge" && e.taskId === "T1")!.data.commit as string;
  const firstParent = git(repo, `rev-parse ${merge}^1`);
  git(repo, `checkout -q --detach ${merge}`);
  const script = join(makeTestTempDir("tickmarkr-owed-proof-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});

  // Legacy and malformed evidence first: the same waiver row without (or with a broken) obligation.
  const path = join(journal.dir, "journal.jsonl");
  const original = readFileSync(path, "utf8");
  const rewriteWaiver = (obligationValue: unknown) => writeFileSync(path, original.split("\n").map((line) => {
    if (!line.includes('"task-approved"')) return line;
    const row = JSON.parse(line) as JournalEvent;
    const data = { ...row.data };
    if (obligationValue === undefined) delete data.obligation; else data.obligation = obligationValue;
    return JSON.stringify({ ...row, data });
  }).join("\n"));
  for (const broken of [undefined, null, { version: 1, id: obligation.id }, { ...obligation, runId: undefined }, { ...obligation, authors: [42] }]) {
    rewriteWaiver(broken);
    const legacy = await verify(["--base", firstParent, "--task", "T1", "--no-review", "--record", runId], repo);
    expect(legacy.code, legacy.out).toBe(2);
    expect(legacy.out).toContain(`owed checks for ${runId}: debt unknown`);
    expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: false, debt: "unknown" });
  }
  writeFileSync(path, original);

  const proof = await verify(["--base", firstParent, "--task", "T1", "--no-review", "--record", runId], repo);
  expect(proof.code, proof.out).toBe(0);
  expect(proof.out).toContain(`owed checks for ${runId}: debt 0`);
  expect(foldOwedChecks(journal.read(), repo)).toMatchObject({
    known: true, debt: 0, outstanding: [], discharged: [obligation.id], acceptedRisk: [obligation],
  });
}, 240_000);

test("verify record after run-end discharges a matching integration-range review obligation; terminal Journal append after reopen retains debt 0 for that eligible proof but restores unknown outstanding debt for artifact deletion hash mismatch wrong binding or a hash-valid matching-range proof with a same-vendor or unresolved reviewer", async () => {
  const { repo, git: g } = owedRepo();
  const runId = "run-owed-terminal";
  g(`branch -f tickmarkr/${runId} main`);
  g(`checkout -q -B tickmarkr/${runId}--T1 main`);
  commitFile(repo, "a\nterminal\n", "terminal");
  g("checkout -q main");
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {});
  journal.append("task-dispatch", "T1", dispatchRow("fake-1"));
  journal.append("worker-launch", "T1", {});
  const obligation = await parkAndWaive(repo, runId, journal);
  g(`checkout -q tickmarkr/${runId}`);
  g(`merge -q --no-ff tickmarkr/${runId}--T1 -m 'merge T1'`);
  const merge = g("rev-parse HEAD");
  journal.append("merge", "T1", { branch: `tickmarkr/${runId}--T1`, commit: merge });
  const summary = { runId, branch: `tickmarkr/${runId}`, done: ["T1"], failed: [], human: [], blocked: [], pending: [] };
  journal.append("run-end", undefined, summary);
  expect(journal.read().at(-1)!.data.owedChecks).toMatchObject({ known: true, debt: 1 });

  g(`checkout -q --detach ${merge}`);
  const proof = await verify(["--base", "main", "--task", "T1", "--no-acceptance", "--record", runId], repo);
  expect(proof.code, proof.out).toBe(0);
  const discharge = journal.read().find((e) => e.event === "owed-check-discharged")!;
  expect(discharge.data).toMatchObject({ ids: [obligation.id], mapping: "integration", head: merge, reviewer: { key: "fake:fake-2", vendor: "fake-b" } });

  const reopened = () => Journal.open(repo, runId);
  const terminal = () => { reopened().append("run-end", undefined, summary); return reopened().read().at(-1)!.data.owedChecks as { known: boolean; debt: unknown; outstanding: OwedCheck[] }; };
  const eligible = () => expect(terminal()).toMatchObject({ known: true, debt: 0, outstanding: [] });
  const restored = (reason: string) => {
    const fold = terminal();
    expect(fold).toMatchObject({ known: false, debt: "unknown", outstanding: [{ id: obligation.id }] });
    expect(JSON.stringify(fold)).toContain(reason);
  };
  eligible();
  // The seats resolve from the obligation's recorded declaration, so the fold answers the same in a
  // fresh process that imports journal.ts alone (no CLI module, no fake adapter) and in a linked
  // checkout with no local state.
  expect(obligation.declared).toEqual(expect.arrayContaining([{ key: "fake:fake-1", vendor: "fake-a" }, { key: "fake:fake-2", vendor: "fake-b" }]));
  const childEnv = { ...process.env };
  delete childEnv.TICKMARKR_FAKE_SCRIPT;
  const fresh = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { Journal } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../src/run/journal.ts")).href)});
    Journal.open(${JSON.stringify(repo)}, ${JSON.stringify(runId)}).append("run-end", undefined, ${JSON.stringify(summary)});
    console.log(JSON.stringify(Journal.open(${JSON.stringify(repo)}, ${JSON.stringify(runId)}).read().at(-1).data.owedChecks));
  `], { encoding: "utf8", env: childEnv });
  expect(JSON.parse(fresh)).toMatchObject({ known: true, debt: 0, outstanding: [] });
  const linked = join(makeTestTempDir("tickmarkr-owed-linked-"), "checkout");
  g(`worktree add -q --detach ${linked} ${merge}`);
  expect(foldOwedChecks(reopened().read(), linked)).toMatchObject({ known: true, debt: 0, discharged: [obligation.id] });

  const artifactPath = String(discharge.data.artifactPath);
  const artifactBytes = readFileSync(artifactPath);
  const path = join(journal.dir, "journal.jsonl");
  const original = readFileSync(path, "utf8");
  const rewriteDischarge = (edit: (data: Record<string, unknown>) => Record<string, unknown>) => writeFileSync(path, original.split("\n").map((line) => {
    if (!line.includes('"owed-check-discharged"')) return line;
    const row = JSON.parse(line) as JournalEvent;
    return JSON.stringify({ ...row, data: edit({ ...row.data }) });
  }).join("\n"));
  // A forged artifact whose hash the forged row carries: range and binding match, only the reviewer differs.
  // By default the forged review row agrees with the row's claim (vendor, and provider = vendor for fake seats).
  const forge = (reviewerKey: string | undefined, reviewer: { key: string; vendor: string } | undefined,
    seat: Record<string, unknown> = reviewer ? { vendor: reviewer.vendor, provider: reviewer.vendor } : {}) => {
    const artifact = JSON.parse(artifactBytes.toString("utf8")) as { gateRows: Array<{ gate: string; meta?: Record<string, unknown> }> };
    const reviewRow = artifact.gateRows.find((r) => r.gate === "review")!;
    reviewRow.meta = { ...reviewRow.meta, reviewer: reviewerKey, ...seat };
    const bytes = Buffer.from(JSON.stringify(artifact, null, 2) + "\n");
    const forged = join(dirname(artifactPath), `forged-${reviewerKey || "none"}.json`);
    writeFileSync(forged, bytes);
    rewriteDischarge((data) => ({ ...data, artifactPath: forged, artifactSha256: createHash("sha256").update(bytes).digest("hex"), reviewer }));
  };

  rmSync(artifactPath);
  restored("artifact unavailable");
  writeFileSync(artifactPath, artifactBytes);
  eligible();

  writeFileSync(artifactPath, Buffer.concat([artifactBytes, Buffer.from(" ")]));
  restored("artifact hash mismatch");
  writeFileSync(artifactPath, artifactBytes);
  eligible();

  // A genuine artifact of the same range and scope that measured other criteria: the row's criteria
  // claim still matches the obligation, but the hash-bound evidence does not.
  const graphBytes = readFileSync(graphPath(repo));
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["*.txt"], acceptance: ["something else"] })] }));
  const other = JSON.parse((await verify(["--base", "main", "--task", "T1", "--no-acceptance", "--json"], repo)).out) as { green: boolean; artifactPath: string; artifactSha256: string };
  writeFileSync(graphPath(repo), graphBytes);
  expect(other.green).toBe(true);
  rewriteDischarge((data) => ({ ...data, artifactPath: other.artifactPath, artifactSha256: other.artifactSha256 }));
  restored("artifact measured other criteria");

  rewriteDischarge((data) => ({ ...data, head: obligation.head })); // an integration row naming no recorded merge
  restored("discharge range does not bind the obligation");
  // A hash-valid artifact claiming the empty merge..merge range: the merge row exists and the patch is
  // copied, but that range is not the merge of the waived series — the fold re-proves it from git.
  const emptyBytes = Buffer.from(JSON.stringify({ ...JSON.parse(artifactBytes.toString("utf8")), mergeBase: merge }, null, 2) + "\n");
  const emptyPath = join(dirname(artifactPath), "forged-empty-range.json");
  writeFileSync(emptyPath, emptyBytes);
  rewriteDischarge((data) => ({ ...data, mergeBase: merge, artifactPath: emptyPath, artifactSha256: createHash("sha256").update(emptyBytes).digest("hex") }));
  restored("discharge range does not bind the obligation");
  forge("fake:fake-1", { key: "fake:fake-1", vendor: "fake-a" });
  restored("same-vendor reviewer");
  // The author's own key stays excluded whatever vendor the forged row and review row claim for it.
  forge("fake:fake-1", { key: "fake:fake-1", vendor: "fake-b" });
  restored("the reviewer is a recorded patch author");
  forge(undefined, undefined);
  restored("unresolved reviewer");
  forge("", { key: "", vendor: "" }); // string-typed but empty: not a resolved identity
  restored("unresolved reviewer");
  // The row's vendor claim must be the vendor the hash-bound review row recorded for that seat.
  forge("fake:fake-2", { key: "fake:fake-2", vendor: "fake-z" }, { vendor: "fake-b", provider: "fake-b" });
  restored("unresolved reviewer");
  // Hash-valid, well-formed and self-consistent row and artifact naming a seat no adapter here declares,
  // or a declared seat under a vendor it is not declared with: agreement is not resolution.
  for (const [key, vendor] of [["not-installed:nonexistent-model", "nobody"], ["fake:fake-404", "fake-z"], ["fake:fake-2", "fake-z"]] as const) {
    forge(key, { key, vendor });
    restored("unresolved reviewer (no declared channel with that identity and vendor)");
  }
  // An author channel claimed under a vendor its adapter does not declare cannot move the exclusion.
  rewriteDischarge((data) => ({ ...data, authorChannels: [{ key: "fake:fake-1", vendor: "fake-z" }] }));
  restored("unresolved author channel (no declared channel with that identity and vendor)");
  writeFileSync(path, original);
  eligible();
  expect(foldOwedChecks(reopened().read(), repo).acceptedRisk).toEqual([obligation]);
}, 240_000);
