import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { pickReviewer } from "../../src/gates/review.js";
import { HUMAN_AUTHOR, HUMAN_CHANNEL, parseCriteria, verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { withRepositoryLease } from "../../src/run/lease.js";
import { approve } from "../../src/cli/commands/approve.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { foldOwedChecks, Journal, owedSubject, rangePatch, rangePatches, type OwedCheck } from "../../src/run/journal.js";
import { COMMIT, T, authedModels, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// A branch with one commit beside main, with a real (fast) test command so the baseline capture
// and the head battery both execute. No LLM seat: --no-review + no criteria = deterministic only.
function repoWithBranch(opts: { breakTests?: boolean; outOfScope?: boolean } = {}): string {
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "sh check.sh" } }),
    "check.sh": "grep -q GOOD src.txt\n",
    "src.txt": "GOOD\n",
  });
  const git = (c: string) => execSync(`git ${c}`, { cwd: repo, encoding: "utf8" });
  git("checkout -b feature");
  writeFileSync(join(repo, "src.txt"), opts.breakTests ? "BAD\n" : "GOOD\nmore\n");
  if (opts.outOfScope) writeFileSync(join(repo, "stray.txt"), "drive-by\n");
  execSync(`${COMMIT} change`, { cwd: repo });
  return repo;
}

// Doctor caches, so `readDoctor` short-circuits probeAll: no real CLI is touched and no token spent.
const NO_CHANNEL_DOCTOR = { fake: { installed: false, authed: false, models: [] } };
const FAKE_ONLY_DOCTOR = {
  fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) },
};

// The capture is the expensive step: it mints verify's state dir and caches a baseline there. Its
// absence is therefore the proof a refusal preceded it — an assertion on the message alone cannot
// tell a hoisted check from one that refused ten minutes late.
const captured = (repo: string) => existsSync(verifyStateDir(repo));

describe("tickmarkr verify — standalone gate battery", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; vi.restoreAllMocks(); });

  test("green diff verifies end-to-end without a daemon: battery + evidence pass, exit 0", async () => {
    const repo = repoWithBranch();
    const r = await verify(["--no-review"], repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS test");
    expect(r.out).toContain("PASS evidence");
    expect(r.out).toContain("verify GREEN");
  }, 60_000);

  test("a test regression vs the captured base baseline fails closed with exit 2", async () => {
    const repo = repoWithBranch({ breakTests: true });
    const r = await verify(["--no-review"], repo);
    expect(r.code).toBe(2);
    expect(r.out).toContain("FAIL test");
  }, 60_000);

  test("--files enforces scope: an out-of-scope edit is named and fails closed", async () => {
    const repo = repoWithBranch({ outOfScope: true });
    const r = await verify(["--no-review", "--files", "src.txt"], repo);
    expect(r.code).toBe(2);
    expect(r.out).toContain("FAIL scope");
    expect(r.out).toContain("stray.txt");
  }, 60_000);

  test("nothing to verify when HEAD is contained in --base", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    await expect(verify(["--no-review"], repo)).rejects.toThrow(/nothing to verify/);
  });

  test("parseCriteria: typed oracle prefixes and plain judge lines, comments skipped", () => {
    expect(parseCriteria("# heading\n- test: exact title\ncommand: npm run x\n- plain rubric\n\n")).toEqual([
      { oracle: "test", test: "exact title" },
      { oracle: "command", command: "npm run x" },
      "plain rubric",
    ]);
  });

  // The load-bearing novelty of verify's review wiring: pickReviewer fails CLOSED (null) for an
  // author it cannot resolve in the channel list, so a human-authored diff would never get a
  // reviewer. The sentinel makes the author resolvable as vendor "human", which excludes no real
  // channel — any live LLM seat stays eligible.

  test("human-author sentinel: reviewer eligible with the sentinel, fail-closed without it", () => {
    const llm: BillingChannel = { adapter: "codex", vendor: "openai", model: "gpt-x", channel: "sub", tier: "frontier" };
    expect(pickReviewer(HUMAN_AUTHOR, [llm])).toBeNull();
    expect(pickReviewer(HUMAN_AUTHOR, [llm, HUMAN_CHANNEL])).toEqual(llm);
  });
  // OBS-541: both refusals below are correct and were already fail-closed — the defect was that each
  // one cost a full baseline capture (602s, then 590s on the same candidate) to reach.
  test("verify on a dirty worktree refuses without capturing a baseline and names every offending path, so a refusal that follows a capture fails", async () => {
    const repo = repoWithBranch();
    // `status.showUntrackedFiles=no` is a normal git configuration under which a bare `git status
    // --porcelain` shows NO untracked file at all — the check must not be bypassable by it.
    execSync("git config status.showUntrackedFiles no", { cwd: repo });
    writeFileSync(join(repo, "src.txt"), "GOOD\nuncommitted\n");   // tracked, modified
    writeFileSync(join(repo, "stray.txt"), "untracked\n");          // untracked
    mkdirSync(join(repo, "nested", "deep"), { recursive: true });
    writeFileSync(join(repo, "nested", "deep", "buried.txt"), "untracked\n"); // nested: collapses to `?? nested/` by default
    writeFileSync(join(repo, ".tickmarkr-usage"), "harness litter\n"); // exempt: the harness's own

    const err = await verify(["--no-review"], repo).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("refusing to gate a dirty worktree");
    expect(err?.message).toContain("src.txt");     // every offending path, not just the first
    expect(err?.message).toContain("stray.txt");
    expect(err?.message).toContain("nested/deep/buried.txt"); // named individually, not as `nested/`
    expect(err?.message).not.toContain("tickmarkr-usage");
    expect(captured(repo)).toBe(false);
  }, 30_000);

  test("verify with no routable review channel refuses without capturing a baseline unless review is disabled, so a refusal that follows a capture fails", async () => {
    const repo = repoWithBranch();
    writeDoctor(repo, NO_CHANNEL_DOCTOR);

    await expect(verify([], repo)).rejects.toThrow(/review gate needs at least one authed LLM channel/);
    expect(captured(repo)).toBe(false);

    const r = await verify(["--no-review"], repo);  // the same tree, review disabled: nothing to refuse
    expect(r.code).toBe(0);
    expect(captured(repo)).toBe(true);
  }, 60_000);

  test("verify on a clean worktree with a routable channel captures and runs the battery unchanged, so a precondition phase that blocks a legitimate candidate fails", async () => {
    const repo = repoWithBranch();
    const scriptPath = join(makeTestTempDir("tickmarkr-script-"), "s.json");
    writeFileSync(scriptPath, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    process.env.TICKMARKR_FAKE_SCRIPT = scriptPath;

    const r = await verify([], repo);
    expect(r.code).toBe(0);
    expect(captured(repo)).toBe(true);
    expect(r.out).toContain("PASS test");
    expect(r.out).toContain("PASS review");
    expect(r.out).toContain("verify GREEN");
  }, 120_000);

  test("cite the precondition phase ordered ahead of the baseline capture call, so a check left below it fails", () => {
    const src = readFileSync(new URL("../../src/cli/commands/verify.ts", import.meta.url), "utf8");
    const capture = src.indexOf("await captureBaseline(");
    expect(capture).toBeGreaterThan(-1);
    for (const check of ["PRECONDITIONS (OBS-541)", "git status --porcelain", "review gate needs at least one authed LLM channel"]) {
      const at = src.indexOf(check);
      expect(at, `${check} is missing`).toBeGreaterThan(-1);
      expect(at, `${check} sits below the baseline capture`).toBeLessThan(capture);
    }
  });

  test("test: the standalone verify command prints one stderr line naming the gate the event name and the payload for every note event its gate run emits whereas a verify that drops the note phase prints nothing for it and fails", async () => {
    const repo = makeTestTempDir("tickmarkr-verify-note-");
    const baseline = join(repo, "baseline.json");
    writeFileSync(baseline, "{}");
    vi.resetModules();
    vi.doMock("../../src/run/git.js", () => ({
      shGitOk: vi.fn(async (cmd: string) => cmd.includes("merge-base") ? "aaaaaaaaaaaa\n" : cmd.includes("main") ? "bbbbbbbbbbbb\n" : "cccccccccccc\n"),
      shGit: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      linkNodeModules: vi.fn(),
      removeWorktree: vi.fn(),
    }));
    vi.doMock("../../src/gates/baseline.js", () => ({
      detectGateCommands: vi.fn(() => ({})),
      captureBaseline: vi.fn(async () => ({})),
    }));
    // The fixture is a bare temp dir, not a repository: the lease keys on the common git dir.
    vi.doMock("../../src/run/lease.js", () => ({ withRepositoryLease: vi.fn(async (_cwd: string, run: () => Promise<unknown>) => run()) }));
    vi.doMock("../../src/gates/run-gates.js", () => ({
      runGates: vi.fn(async (_task: unknown, ctx: { onGate?: (e: unknown) => void | Promise<void> }) => {
        await ctx.onGate?.({ phase: "note", gate: "review", name: "reviewer-empty-output", payload: { reviewer: "fake:m", bytes: 1 }, result: { gate: "review", pass: false, details: "note" } });
        return { results: [{ gate: "review", pass: true, details: "ok" }], commits: [] };
      }),
    }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mod = await import("../../src/cli/commands/verify.js");
      await mod.verify(["--no-review", "--baseline", baseline], repo);
      expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("reviewer-empty-output"))).toEqual([
        'verify: note review reviewer-empty-output {"reviewer":"fake:m","bytes":1}',
      ]);
    } finally {
      vi.doUnmock("../../src/run/git.js");
      vi.doUnmock("../../src/gates/baseline.js");
      vi.doUnmock("../../src/gates/run-gates.js");
      vi.doUnmock("../../src/run/lease.js");
      vi.resetModules();
    }
  });

  test("test: verify refuses changed HEAD or dirty candidate state between semantic completion and suite completion whereas an unchanged subject retains its final AND verdict plus exactly one note per gate", async () => {
    const scratch = makeTestTempDir("tickmarkr-verify-subject-");
    const suites = join(scratch, "suites.log");
    const flag = join(scratch, "move-head-during-suite");
    writeFileSync(suites, "");
    const repo = makeRepo({
      "package.json": JSON.stringify({ scripts: { build: "true", test: "sh test.sh" } }),
      "test.sh": `echo base >> '${suites}'\n`,
      "src.txt": "base\n",
    });
    const git = (c: string) => execSync(`git ${c}`, { cwd: repo, encoding: "utf8" }).trim();
    git("checkout -b feature");
    // The candidate's suite logs itself and, when flagged, moves HEAD mid-suite (base's never does).
    writeFileSync(join(repo, "test.sh"), `echo head >> '${suites}'\nif [ -f '${flag}' ]; then rm '${flag}'; git commit -q --allow-empty --no-gpg-sign -m moved; fi\n`);
    writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
    execSync(`${COMMIT} feature`, { cwd: repo });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lines = () => errors.mock.calls.map((c) => String(c[0]));
    const suiteRuns = () => readFileSync(suites, "utf8").split("\n").filter(Boolean);

    // Unchanged subject: one row, one stderr verdict line and one output line per gate; the AND is green.
    const green = await verify(["--no-review"], repo);
    expect(green.code, green.out).toBe(0);
    expect(green.out).toContain("verify GREEN");
    const outGates = green.out.split("\n").flatMap((l) => /^(?:PASS|FAIL) (\w+)$/.exec(l)?.[1] ?? []);
    expect(outGates).toEqual(["build", "test", "lint", "evidence"]);
    for (const gate of outGates) expect(lines().filter((l) => l.startsWith(`verify: ✓ ${gate} `))).toHaveLength(1);
    expect(suiteRuns()).toEqual(["base", "head"]);

    // A refused subject: HEAD moves, or the tree dirties, while the suite waits behind a held lease.
    const held = async (mutate: () => void): Promise<{ code: number; out: string }> => {
      let release!: () => void;
      const releasing = new Promise<void>((r) => { release = r; });
      let holding!: () => void;
      const holds = new Promise<void>((r) => { holding = r; });
      const holder = withRepositoryLease(repo, async () => { holding(); await releasing; }, { pollMs: 50 });
      await holds;
      errors.mockClear();
      const pending = verify(["--no-review", "--json"], repo);
      await vi.waitFor(() => expect(lines().some((l) => l.includes("waiting for the repository's runner lease"))).toBe(true), { timeout: 60_000, interval: 50 });
      mutate(); // semantic completion is behind us: the waiter only queues once the unleased phase ended
      release();
      await holder;
      return pending;
    };
    const runsBefore = suiteRuns().length;
    const moved = await held(() => { writeFileSync(join(repo, "src.txt"), "base\nfeature\nlater\n"); execSync(`${COMMIT} later`, { cwd: repo }); });
    expect(moved.code).toBe(2);
    const movedReport = JSON.parse(moved.out) as { green: boolean; results: Array<{ gate: string; pass: boolean; details: string }> };
    expect(movedReport.green).toBe(false);
    expect(movedReport.results.find((r) => r.gate === "test")).toMatchObject({ pass: false, details: expect.stringContaining("HEAD moved from") });
    expect(movedReport.results.filter((r) => r.gate === "test")).toHaveLength(1);
    const dirty = await held(() => writeFileSync(join(repo, "stray.txt"), "uncommitted\n"));
    rmSync(join(repo, "stray.txt"));
    expect(dirty.code).toBe(2);
    const dirtyTest = (JSON.parse(dirty.out) as typeof movedReport).results.find((r) => r.gate === "test");
    expect(dirtyTest).toMatchObject({ pass: false, details: expect.stringContaining("refusing the suite verdict") });
    expect(dirtyTest?.details).toContain("stray.txt");
    expect(suiteRuns()).toHaveLength(runsBefore); // neither refused subject bought a suite

    // HEAD moving DURING the suite: the suite's own green cannot stand for the subject the rest judged.
    writeFileSync(flag, "");
    const during = await verify(["--no-review", "--json"], repo);
    expect(during.code).toBe(2);
    const duringTest = (JSON.parse(during.out) as typeof movedReport).results.find((r) => r.gate === "test");
    expect(duringTest).toMatchObject({ pass: false, details: expect.stringContaining("HEAD moved from") });
    expect(existsSync(flag)).toBe(false);
  }, 180_000);
});

// C1: a parked review gate-fail on the task branch `tickmarkr/<runId>--T1`, waived through the
// production approve, so the obligation under test is the one the command itself wrote.
async function waivedReview(repo: string, runId: string, files: Record<string, string>[]): Promise<OwedCheck> {
  const git = (c: string) => execSync(`git ${c}`, { cwd: repo, encoding: "utf8" }).trim();
  git(`branch -f tickmarkr/${runId} main`);
  git(`checkout -q -B tickmarkr/${runId}--T1 tickmarkr/${runId}`);
  for (const commit of files) {
    for (const [path, body] of Object.entries(commit)) writeFileSync(join(repo, path), body);
    execSync(`${COMMIT} ${runId}`, { cwd: repo });
  }
  const head = git("rev-parse HEAD");
  git("checkout -q main");
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, {});
  journal.append("task-dispatch", "T1", { attempt: 1, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  journal.append("worker-launch", "T1", {});
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "red", commit: owedSubject(repo, git("rev-parse main"), head) });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision required" });
  await approve([runId, "T1", "--waive", "--by", "operator", "--reason", `accepted ${runId}`], repo);
  return journal.read().find((e) => e.event === "task-approved")!.data.obligation as OwedCheck;
}

describe("tickmarkr verify --record — owed-check discharge (C1)", () => {
  afterEach(() => { delete process.env.TICKMARKR_FAKE_SCRIPT; vi.restoreAllMocks(); });

  test("verify record exits 0 only for the exact obligation or validated integration mapping; wrong run task range gate changed criteria skipped gate or ambiguous mapping returns 2 retaining the outstanding check", async () => {
    // c.txt repeats one block, so an edit moved from the first copy to the second keeps its patch ids.
    const block = (x: number) => `  pad\n  pad\n  pad\n  x = ${x}\n  pad\n  pad\n  pad\n`;
    const repo = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": `first\n${block(0)}second\n${block(0)}` });
    const git = (c: string) => execSync(`git ${c}`, { cwd: repo, encoding: "utf8" }).trim();
    const graph = (acceptance: string[], files = ["*.txt"]) => saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [T("T1", { files, acceptance }), T("T2", { files: ["*.txt"] })] }));
    graph(["done"]);
    writeDoctor(repo, FAKE_ONLY_DOCTOR);
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n"); // zero-token seats only
    const script = join(makeTestTempDir("tickmarkr-owed-review-"), "script.json");
    writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
    process.env.TICKMARKR_FAKE_SCRIPT = script;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const a = await waivedReview(repo, "run-owed-a", [{ "a.txt": "a\none\n" }, { "a.txt": "a\none\ntwo\n" }]);
    const b = await waivedReview(repo, "run-owed-b", [{ "b.txt": "b\nother\n" }]);
    const c = await waivedReview(repo, "run-owed-c", [{ "c.txt": `first\n${block(1)}second\n${block(0)}` }]);
    expect(a).toMatchObject({ runId: "run-owed-a", taskId: "T1", gate: "review", known: true, authors: ["fake:fake-1"], base: git("rev-parse main"), files: ["*.txt"] });
    expect(a.patches).toHaveLength(2);
    const debt = (runId: string) => foldOwedChecks(Journal.open(repo, runId).read(), repo);
    const at = async (ref: string, argv: string[]) => { git(`checkout -q --detach ${ref}`); return verify(argv, repo); };
    const refused = async (ref: string, argv: string[], why: RegExp) => {
      const result = await at(ref, argv);
      expect(result.code, result.out).toBe(2);
      expect(result.out).toMatch(why);
      expect(debt("run-owed-a")).toMatchObject({ known: true, debt: 1, outstanding: [{ id: a.id }] });
      expect(debt("run-owed-b")).toMatchObject({ known: true, debt: 1, outstanding: [{ id: b.id }] });
      expect(debt("run-owed-c")).toMatchObject({ known: true, debt: 1, outstanding: [{ id: c.id }] });
    };

    await refused(a.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"], /neither an owed check's exact range/); // wrong run
    await refused(a.head, ["--task", "T2", "--no-acceptance", "--record", "run-owed-a"], /owes no check for task T2/); // wrong task
    git(`checkout -q -B longer ${a.head}`);
    writeFileSync(join(repo, "a.txt"), "a\none\ntwo\nthree\n");
    execSync(`${COMMIT} longer`, { cwd: repo });
    await refused("longer", ["--task", "T1", "--no-acceptance", "--record", "run-owed-a"], /neither an owed check's exact range/); // wrong range
    await refused(a.head, ["--task", "T1", "--no-acceptance", "--no-review", "--record", "run-owed-a"], /requires the review gate, which this invocation skips/); // skipped gate
    graph(["done", "and more"]);
    await refused(a.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-a"], /bound other acceptance criteria/); // changed criteria
    graph(["done"]);
    // Weakened evidence: a wider allowlist, whether passed as --files or edited into the task, is not the
    // scope the waive bound; nor is a caller-supplied baseline.
    await refused(a.head, ["--task", "T1", "--no-acceptance", "--files", "*", "--record", "run-owed-a"], /--files cannot replace it/);
    graph(["done"], ["*"]);
    await refused(a.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-a"], /bound another file scope/);
    graph(["done"]);
    await refused(a.head, ["--task", "T1", "--no-acceptance", "--baseline", join(repo, "absent.json"), "--record", "run-owed-a"], /--baseline cannot supply one/);
    // Ambiguous mapping: the task's recorded merge carries the same total change squashed into one commit.
    git("checkout -q -B squashed main");
    writeFileSync(join(repo, "a.txt"), "a\none\ntwo\n");
    execSync(`${COMMIT} squashed`, { cwd: repo });
    git("checkout -q -B tickmarkr/run-owed-a main");
    git("merge -q --no-ff squashed -m 'merge T1 squashed'");
    const squashMerge = git("rev-parse HEAD");
    Journal.open(repo, "run-owed-a").append("merge", "T1", { branch: "squashed", commit: squashMerge });
    await refused(squashMerge, ["--task", "T1", "--no-acceptance", "--record", "run-owed-a"], /neither an owed check's exact range nor a validated integration merge/);
    // Ambiguous mapping: the same commit series re-indented — whitespace-blind patch ids match, the programs do not.
    git("checkout -q -B reindented main");
    for (const body of ["a\n  one\n", "a\n  one\n  two\n"]) {
      writeFileSync(join(repo, "a.txt"), body);
      execSync(`${COMMIT} reindented`, { cwd: repo });
    }
    git("checkout -q -B tickmarkr/run-owed-a main");
    git("merge -q --no-ff reindented -m 'merge T1 reindented'");
    const reindentedMerge = git("rev-parse HEAD");
    Journal.open(repo, "run-owed-a").append("merge", "T1", { branch: "reindented", commit: reindentedMerge });
    await refused(reindentedMerge, ["--task", "T1", "--no-acceptance", "--record", "run-owed-a"], /neither an owed check's exact range nor a validated integration merge/);
    // Ambiguous mapping: the waived edit relocated into the identical second block. Patch ids ignore
    // hunk positions, so the series and the merge patch collide; the program does not ("1 0" vs "0 1").
    const relocated = `first\n${block(0)}second\n${block(1)}`;
    git("checkout -q -B relocated main");
    writeFileSync(join(repo, "c.txt"), relocated);
    execSync(`${COMMIT} relocated`, { cwd: repo });
    expect(rangePatches(repo, c.base, git("rev-parse HEAD"))).toEqual(c.patches);
    git("checkout -q -B tickmarkr/run-owed-c main");
    git("merge -q --no-ff relocated -m 'merge T1 relocated'");
    const relocatedMerge = git("rev-parse HEAD");
    expect(rangePatch(repo, c.base, relocatedMerge)).toBe(c.patch);
    Journal.open(repo, "run-owed-c").append("merge", "T1", { branch: "relocated", commit: relocatedMerge });
    await refused(relocatedMerge, ["--task", "T1", "--no-acceptance", "--record", "run-owed-c"], /neither an owed check's exact range nor a validated integration merge/);
    // ...and the same relocation amended into the task's own merge: the waived head is its second parent,
    // but the merge tree is not git's clean merge of it.
    git("checkout -q -B tickmarkr/run-owed-c main");
    git("merge -q --no-ff --no-commit tickmarkr/run-owed-c--T1");
    writeFileSync(join(repo, "c.txt"), relocated);
    execSync(`${COMMIT} 'merge T1 amended'`, { cwd: repo });
    const amendedMerge = git("rev-parse HEAD");
    expect(git(`rev-parse ${amendedMerge}^2`)).toBe(c.head);
    expect(rangePatch(repo, c.base, amendedMerge)).toBe(c.patch);
    Journal.open(repo, "run-owed-c").append("merge", "T1", { branch: "tickmarkr/run-owed-c--T1", commit: amendedMerge });
    await refused(amendedMerge, ["--task", "T1", "--no-acceptance", "--record", "run-owed-c"], /neither an owed check's exact range nor a validated integration merge/);

    // A gate command that commits (a build step landing a "fix") moved the subject: the rows measured
    // another commit than the one the artifact and a discharge would name, so nothing is discharged.
    const config = join(repo, ".tickmarkr", "config.yaml");
    const zeroTokenConfig = readFileSync(config, "utf8");
    writeFileSync(config, `${zeroTokenConfig}gates:\n  build: ${JSON.stringify("printf 'fixed\\n' >> b.txt && git commit -qam fix --no-gpg-sign")}\n`);
    await refused(b.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"], /HEAD moved from/);
    expect(git("rev-parse HEAD")).not.toBe(b.head);
    // ...and that refused build green is not cached under the unfixed tree: repeating verify on the
    // original commit runs the build again (it commits again) instead of reusing a verdict for b.head.
    await refused(b.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"], /HEAD moved from/);
    expect(git("rev-parse HEAD")).not.toBe(b.head);
    // ...nor does an invocation killed before it could withdraw anything: a verify process SIGKILLed by
    // its lint command right after its build committed the fix leaves no green a later verify --record
    // reuses for b.head — the build runs (and commits) again and the discharge is refused.
    const pidFile = join(makeTestTempDir("tickmarkr-owed-kill-"), "pid");
    const lint = `if [ "$(git rev-parse HEAD~1)" = ${b.head} ] && [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); rm -f ${pidFile}; kill -9 "$pid"; fi`;
    writeFileSync(config, `${zeroTokenConfig}gates:\n  build: ${JSON.stringify("printf 'fixed\\n' >> b.txt && git commit -qam fix --no-gpg-sign")}\n  lint: ${JSON.stringify(lint)}\n`);
    git(`checkout -q --detach ${b.head}`);
    const killed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      (await import("node:fs")).writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      const { verify } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../src/cli/commands/verify.ts")).href)});
      await verify(["--task", "T1", "--no-acceptance", "--no-review"], ${JSON.stringify(repo)});
    `], { encoding: "utf8" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(git("rev-parse HEAD~1")).toBe(b.head); // its build had committed the fix
    await refused(b.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"], /HEAD moved from/);
    expect(git("rev-parse HEAD~1")).toBe(b.head);
    // ...nor does a LATER gate restoring the original commit: the build commits the fix and lint resets
    // HEAD to b.head, so every phase end reads an unchanged, clean subject. The build's end boundary
    // latched the move, so the discharge is refused and the build green is never published — a repeat
    // runs the build on b.head again. Likewise a build that commits and resets inside its own command:
    // HEAD's reflog witnesses the move no boundary could see.
    const builds = join(makeTestTempDir("tickmarkr-owed-builds-"), "builds");
    const buildsAtHead = () => readFileSync(builds, "utf8").split("\n").filter((l) => l === b.head).length;
    const fix = `git rev-parse HEAD >> ${builds} && printf 'fixed\\n' >> b.txt && git commit -qam fix --no-gpg-sign`;
    const restore = `if [ "$(git rev-parse HEAD~1)" = ${b.head} ]; then git reset -q --hard ${b.head}; fi`;
    writeFileSync(config, `${zeroTokenConfig}gates:\n  build: ${JSON.stringify(fix)}\n  lint: ${JSON.stringify(restore)}\n`);
    for (const run of [1, 2]) {
      await refused(b.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"], /HEAD moved from/);
      expect(git("rev-parse HEAD")).toBe(b.head); // lint restored the original commit
      expect(git("status --porcelain")).toBe("");
      expect(buildsAtHead()).toBe(run);
    }
    writeFileSync(config, `${zeroTokenConfig}gates:\n  build: ${JSON.stringify(`${fix} && git reset -q --hard HEAD~1`)}\n`);
    for (const run of [3, 4]) {
      await refused(b.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"], /HEAD moved and was restored .*its reflog recorded the move/);
      expect(git("rev-parse HEAD")).toBe(b.head);
      expect(buildsAtHead()).toBe(run);
    }
    writeFileSync(config, zeroTokenConfig);

    // The validated integration mapping: the task's own recorded --no-ff merge of the waived series.
    git("checkout -q -B tickmarkr/run-owed-a main");
    git("merge -q --no-ff tickmarkr/run-owed-a--T1 -m 'merge T1'");
    const merge = git("rev-parse HEAD");
    Journal.open(repo, "run-owed-a").append("merge", "T1", { branch: "tickmarkr/run-owed-a--T1", commit: merge });
    const mapped = await at(merge, ["--task", "T1", "--no-acceptance", "--record", "run-owed-a"]);
    expect(mapped.code, mapped.out).toBe(0);
    expect(mapped.out).toContain("owed checks for run-owed-a: debt 0");
    expect(debt("run-owed-a")).toMatchObject({ known: true, debt: 0, outstanding: [], discharged: [a.id], acceptedRisk: [{ id: a.id }] });

    // The exact obligation on its own immutable range.
    const exact = await at(b.head, ["--task", "T1", "--no-acceptance", "--record", "run-owed-b"]);
    expect(exact.code, exact.out).toBe(0);
    expect(debt("run-owed-b")).toMatchObject({ known: true, debt: 0, discharged: [b.id] });
    expect(Journal.open(repo, "run-owed-b").read().filter((e) => e.event === "owed-check-discharged")).toHaveLength(1);
  }, 240_000);
});
