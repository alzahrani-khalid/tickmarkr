import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel } from "../../src/adapters/types.js";
import {
  baselineCachePath, excludeAuthorProvider, verify, verifyStateRoot,
} from "../../src/cli/commands/verify.js";
import { getVerdictStore } from "../../src/gates/cache.js";
import { pickReviewer } from "../../src/gates/review.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, T, authedModels, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

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
