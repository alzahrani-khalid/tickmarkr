// 2.8.1 T4 (ANL-023 §7.4): the adjudicator's record names the commit it judged, under a validated subject witness.
// Each daemon row seeds an earlier PASS judgment and RESUMES over it (as tests/run/daemon/judge-disagreement.test.ts
// does), so a fresh FAIL over identical cited blobs is disputed and a distinct judge adjudicates; that judge's command
// runs in its cwd — the task checkout — where it commits, resets or retargets HEAD.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { verify } from "../../src/cli/commands/verify.js";
import { graphDefinitionHash, loadGraph, saveGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import * as gates from "../../src/gates/run-gates.js";
import { runDaemon } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const realWitness = git.reflogWitness;
const realRunGates = gates.runGates;
const realHeadless = FakeAdapter.prototype.headlessCommand;
const realShGit = git.shGit;
/** The task checkout's witness reads and the judge seats' launches, in order. */
let order: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TICKMARKR_FAKE_SCRIPT;
});

const sh = (cwd: string, command: string) => execSync(command, { cwd, encoding: "utf8" }).trim();

type Ruling = { met: boolean };
class Judge extends FakeAdapter {
  calls = 0;
  /** `act`: shell this seat runs in its cwd (the task checkout) before it replies. */
  constructor(path: string, public override id: string, private rulings: Ruling[], private act?: string, private tier: BillingChannel["tier"] = "frontier") {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: this.tier }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1] ?? "";
    if (prompt.startsWith("TICKMARKR-REVIEW")) {
      const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
      return `printf '%s' ${shq(JSON.stringify({ nonce, approve: true, resolved: carried, reraised: [], findings: [] }))}`;
    }
    if (!prompt.startsWith("TICKMARKR-JUDGE")) return "true";
    order.push(`seat:${this.id}`);
    const r = this.rulings[Math.min(this.calls++, this.rulings.length - 1)]!;
    const verdict = { nonce, pass: r.met, criteria: [{ criterion: "c1", met: r.met, reason: r.met ? "a.txt holds A" : "a.txt does not hold the behavior", evidence: { path: "a.txt", line: 1 } }] };
    const reply = `printf '%s' ${shq(JSON.stringify(verdict))}`;
    return this.act ? `( ${this.act} ) >/dev/null 2>&1; ${reply}` : reply;
  }
}
class CheapAuthor extends FakeAdapter {
  override channels(cfg: Parameters<FakeAdapter["channels"]>[0]): BillingChannel[] { return [{ ...super.channels(cfg)[0]!, tier: "cheap" }]; }
}

const write = (files: Record<string, string>, msg: string) => ({
  shell: `${Object.entries(files).map(([p, c]) => `printf '%s\\n' ${shq(c)} > ${p}`).join(" && ")} && ${COMMIT} ${msg}`,
  result: { ok: true, summary: msg },
});

/** A commit (off HEAD, reachable by a test ref) holding `files` — the subject an earlier judgment saw. */
function priorCommit(repo: string, files: Record<string, string>): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(repo, ".git", "prior-index") };
  const run = (args: string, input?: string) => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env, input }).trim();
  run("read-tree HEAD");
  for (const [path, content] of Object.entries(files)) {
    run(`update-index --add --cacheinfo 100644,${run("hash-object -w --stdin", `${content}\n`)},${path}`);
  }
  const sha = run(`commit-tree ${run("write-tree")} -p HEAD -m prior`);
  run(`update-ref refs/tickmarkr/test-prior ${sha}`);
  return sha;
}

interface Adjudicated {
  repo: string; primary: Judge; second: Judge; summary: Awaited<ReturnType<typeof runDaemon>>;
  rows: JournalEvent[]; witnessReads: Array<{ ref: string; code: number; lines: string[] }>;
}

/**
 * Seed one earlier PASS of c1 on a.txt = A and resume the run over it: the worker lands a.txt = A again (identical
 * blob), so the primary's fresh FAIL is disputed and judge-b adjudicates. A repair (a.txt = A2) follows an upheld FAIL.
 */
async function adjudicated(opts: {
  runId: string; primary: Ruling[]; second: Ruling[];
  primaryAct?: (repo: string) => string; secondAct?: (repo: string) => string;
  before?: (repo: string) => void; witness?: (ref: string) => { code: number; lines: string[] } | undefined;
  symbolicRef?: { code: number };
}): Promise<Adjudicated> {
  const { repo, scriptPath } = setupRepo([T("T1")], {
    tasks: { T1: [write({ "a.txt": "A", "b.txt": "new" }, "a0"), write({ "a.txt": "A2" }, "a1")] }, consult: { action: "retry", notes: "fix it" },
  });
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), [
    "concurrency: 1",
    "routing:", "  escalateTier: \"off\"", "  floors: { implement: cheap }",
    "judge: { adapter: judge-a, model: judge-a }",
    "consult: { adapter: fake, model: fake-1 }",
    "review: { required: true, prefer: [seat-r], timeoutMs: 5000 }", "",
  ].join("\n"));
  const primary = new Judge(scriptPath, "judge-a", opts.primary, opts.primaryAct?.(repo));
  const second = new Judge(scriptPath, "judge-b", opts.second, opts.secondAct?.(repo));
  const reviewer = new Judge(scriptPath, "seat-r", [{ met: true }], undefined, "mid");
  const key = gates.judgmentSubjectKey(loadGraph(repo).tasks[0]!, "done");
  const commit = priorCommit(repo, { "a.txt": "A", "b.txt": "old" });
  const journal = Journal.create(repo, opts.runId);
  journal.append("run-start", undefined, { baseRef: await git.gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  journal.append("gate-result", "T1", { gate: "acceptance", pass: true, details: "✓ c1: a.txt holds A",
    judgment: { commit, judge: "judge-z:judge-z", criteria: [{ id: "c1", key, met: true, paths: ["a.txt"] }] } });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  opts.before?.(repo);
  const task = (dir: string) => dir.endsWith(`${opts.runId}--T1`);
  const witnessReads: Adjudicated["witnessReads"] = [];
  order = [];
  vi.spyOn(git, "reflogWitness").mockImplementation(async (dir, ref) => {
    if (!task(dir)) return realWitness(dir, ref);
    order.push(`witness:${ref}`);
    const read = opts.witness?.(ref) ?? await realWitness(dir, ref);
    witnessReads.push({ ref, ...read });
    return read;
  });
  if (opts.symbolicRef) {
    const forced = opts.symbolicRef.code;
    vi.spyOn(git, "shGit").mockImplementation(async (cmd, cwd, ...rest) => cmd === "git symbolic-ref -q HEAD" && task(cwd)
      ? { code: forced, stdout: "", stderr: "fatal: unreadable HEAD reference", durationMs: 0 }
      : realShGit(cmd, cwd, ...rest));
  }
  const summary = await runDaemon(repo, { adapters: [new CheapAuthor(scriptPath), primary, second, reviewer], runId: opts.runId, resume: true });
  return { repo, primary, second, summary, rows: Journal.open(repo, opts.runId).read(), witnessReads };
}

const t1 = (rows: JournalEvent[], event: string) => rows.filter((row) => row.taskId === "T1" && row.event === event);
const acceptanceRows = (rows: JournalEvent[]) => t1(rows, "gate-result").filter((row) => row.data.gate === "acceptance").slice(1); // after the seeded prior
const sampled = (rows: JournalEvent[]) => String(t1(rows, "judge-disagreement")[0]!.data.commit);

/** An infra park on the adjudication subject: nothing stamped, the worker never charged or re-dispatched. */
function expectSubjectPark(run: Adjudicated, leg: string, phrase: string, found: (a: string) => string, ran: boolean): void {
  expect(run.summary.human).toEqual(["T1"]);
  expect(t1(run.rows, "task-human").at(-1)?.data.kind).toBe("infra");
  expect(t1(run.rows, "task-dispatch")).toHaveLength(1);
  expect(run.rows.filter((row) => ["escalation", "consult", "repair-attempt", "task-done"].includes(row.event))).toEqual([]);
  expect(run.second.calls).toBe(ran ? 1 : 0);
  const a = sampled(run.rows);
  const parked = acceptanceRows(run.rows);
  expect(parked).toHaveLength(1);
  expect(parked[0]!.data).toMatchObject({ pass: false, infra: true, retryable: false });
  expect(parked[0]!.data.judgment).toBeUndefined();
  expect(parked[0]!.data.adjudication).toEqual({ primary: "judge-a:judge-a", ...(ran ? { adjudicator: "judge-b:judge-b" } : {}), sampled: a, found: found(a), leg });
  expect(String(parked[0]!.data.details)).toContain(
    `the adjudication subject ${phrase}: sampled ${a.slice(0, 12)}, found ${found(a).slice(0, 12)} (${leg}); parked for an operator ruling, no worker charge`);
}

/** The agreeing adjudication: the stamped record names the sampled commit, both identities on the row. */
function expectStamped(run: Adjudicated): void {
  expect(run.summary.done).toEqual(["T1"]);
  const first = acceptanceRows(run.rows)[0]!.data;
  expect(first).toMatchObject({ pass: false, adjudication: { primary: "judge-a:judge-a", adjudicator: "judge-b:judge-b", criteria: ["c1"], agreed: true } });
  expect(first.infra).toBeUndefined();
  expect(first.judgment).toMatchObject({ commit: sampled(run.rows), judge: "judge-a:judge-a" });
  expect(run.second.calls).toBe(1);
}

const branchOf = "$(git symbolic-ref -q HEAD)";

describe("ANL-023 §7.4 — the adjudication subject witness (production daemon, zero tokens)", () => {
  test("through the production daemon an adjudicating seat that commits and leaves it or commits and resets back or moves the task branch from another worktree and restores it or retargets HEAD to another branch at the same commit or leaves HEAD unreadable parks infra after that seat ran with leg moved, restored or unreadable and stamps no record versus an agreeing adjudicator with nothing moved stamping the record and a splitting one keeping today's park (J-F1 F2 F3 F4 F6 J-P1 P3)", async () => {
    // J-F1: A→B left in place.
    const left = await adjudicated({ runId: "run-adj-left", primary: [{ met: false }], second: [{ met: false }],
      secondAct: () => "git commit -q --allow-empty --no-gpg-sign -m adjudicator" });
    const b = String((acceptanceRows(left.rows)[0]!.data.adjudication as Record<string, unknown>).found);
    expectSubjectPark(left, "moved", "moved", () => b, true);
    expect(sh(left.repo, `git rev-parse ${b}^`)).toBe(sampled(left.rows)); // B is the seat's commit on A

    // J-F2: A→B→A inside the checkout.
    const reset = await adjudicated({ runId: "run-adj-reset", primary: [{ met: false }], second: [{ met: false }],
      secondAct: () => "A=$(git rev-parse HEAD) && git commit -q --allow-empty --no-gpg-sign -m adjudicator && git reset -q --hard \"$A\"" });
    expectSubjectPark(reset, "restored", "moved and restored", (a) => a, true);

    // J-F3: the task branch moved A→B→A from the repository's main worktree: only the branch's log records it.
    const foreign = await adjudicated({ runId: "run-adj-foreign", primary: [{ met: false }], second: [{ met: false }],
      secondAct: (repo) => `b=${branchOf} && A=$(git rev-parse HEAD) && B=$(git commit-tree "$A^{tree}" -p "$A" -m foreign) && `
        + `git -C ${shq(repo)} update-ref "$b" "$B" && git -C ${shq(repo)} update-ref "$b" "$A"` });
    expectSubjectPark(foreign, "restored", "moved and restored", (a) => a, true);
    const [headAfter, branchAfter] = [foreign.witnessReads.at(-2)!, foreign.witnessReads.at(-1)!];
    expect([headAfter.ref, branchAfter.ref]).toEqual(["HEAD", `refs/heads/tickmarkr/run-adj-foreign--T1`]);
    expect(headAfter.lines).toEqual(foreign.witnessReads[0]!.lines); // HEAD's own log never saw the move
    expect(branchAfter.lines.length).toBe(foreign.witnessReads[1]!.lines.length + 2);

    // J-F4: HEAD retargeted to another branch at the same commit.
    const retarget = await adjudicated({ runId: "run-adj-retarget", primary: [{ met: false }], second: [{ met: false }],
      secondAct: () => "git checkout -q -b adjudicator-other" });
    expectSubjectPark(retarget, "moved", "moved", (a) => a, true);

    // J-F6: HEAD unreadable after the seat returns (attached to an unborn branch).
    const unborn = await adjudicated({ runId: "run-adj-unborn", primary: [{ met: false }], second: [{ met: false }],
      secondAct: () => "git symbolic-ref HEAD refs/heads/adjudicator-unborn" });
    expectSubjectPark(unborn, "unreadable", "is unreadable", () => "unreadable", true);

    // J-P1: the adjudicator agrees and nothing moved — the record names A; the upheld FAIL funds a repair.
    const agreed = await adjudicated({ runId: "run-adj-agreed", primary: [{ met: false }, { met: true }], second: [{ met: false }] });
    expectStamped(agreed);
    expect(acceptanceRows(agreed.rows).map((row) => row.data.pass)).toEqual([false, true]);

    // J-P3: the adjudicator splits with nothing moved — today's split park, untouched.
    const split = await adjudicated({ runId: "run-adj-split", primary: [{ met: false }], second: [{ met: true }] });
    expect(split.summary.human).toEqual(["T1"]);
    const parked = acceptanceRows(split.rows)[0]!.data;
    expect(parked).toMatchObject({ infra: true, judgeDisagreement: { primary: "judge-a:judge-a", adjudicator: "judge-b:judge-b" } });
    expect(String((parked.judgeDisagreement as Record<string, unknown>).outcome)).toContain("split from the fresh ruling");
    expect(parked.adjudication).toBeUndefined();
    expect(parked.judgment).toBeUndefined();
  }, 300_000);

  test("through the production daemon a task checkout with no HEAD reflog or an unreadable opening witness or HEAD reference or a newest entry other than the sampled commit parks infra with leg witness or unreadable without invoking the second seat versus witnesses established before reflog logging was turned off agreeing normally (J-F5 F7 J-P6)", async () => {
    // J-F5: the task checkout is created while reflog logging is off — neither HEAD nor its branch has a log.
    const nolog = await adjudicated({ runId: "run-adj-nolog", primary: [{ met: false }], second: [{ met: false }],
      before: (repo) => sh(repo, "git config core.logAllRefUpdates false") });
    expectSubjectPark(nolog, "witness", "could not be witnessed", (a) => a, false);
    expect(nolog.witnessReads).toEqual([{ ref: "HEAD", code: 0, lines: [] }]);

    // J-F7: the witness read itself exits non-zero (T1's witness seam).
    const failed = await adjudicated({ runId: "run-adj-failed", primary: [{ met: false }], second: [{ met: false }],
      witness: () => ({ code: 128, lines: [] }) });
    expectSubjectPark(failed, "witness", "could not be witnessed", (a) => a, false);

    // J-F7: `symbolic-ref -q HEAD` exits other than 0 or 1.
    const unreadable = await adjudicated({ runId: "run-adj-symref", primary: [{ met: false }], second: [{ met: false }],
      symbolicRef: { code: 128 } });
    expectSubjectPark(unreadable, "unreadable", "is unreadable", () => "unreadable", false);
    expect(unreadable.witnessReads).toEqual([]);

    // The newest entry is not the sampled commit: the primary seat moved the branch by writing its ref file, unlogged.
    const unlogged = await adjudicated({ runId: "run-adj-unlogged", primary: [{ met: false }], second: [{ met: false }],
      primaryAct: () => `A=$(git rev-parse HEAD) && B=$(git commit-tree "$A^{tree}" -p "$A" -m unlogged) && `
        + `printf '%s\\n' "$B" > "$(git rev-parse --git-path "${branchOf}")"` });
    expectSubjectPark(unlogged, "witness", "could not be witnessed", (a) => a, false);
    expect(unlogged.witnessReads[0]!.lines[0]).not.toBe(sampled(unlogged.rows));

    // J-P6: logs established while logging was on, then the setting turned off before adjudication — still valid.
    const established = await adjudicated({ runId: "run-adj-established", primary: [{ met: false }, { met: true }], second: [{ met: false }],
      primaryAct: () => "git config core.logAllRefUpdates false" });
    expect(sh(established.repo, "git config --get core.logAllRefUpdates")).toBe("false");
    expectStamped(established);
    const a = sampled(established.rows);
    expect(established.witnessReads.slice(0, 2).map((w) => [w.ref, w.code, w.lines[0]]))
      .toEqual([["HEAD", 0, a], ["refs/heads/tickmarkr/run-adj-established--T1", 0, a]]);
  }, 300_000);

  test("through the production daemon a fresh judgment with no disputed criterion reads no witness and invokes no second seat and standalone verify adjudicating keeps its subject latch holding because the witness wrote nothing versus a disputed criterion reading the witness before the second seat runs (J-P2 P4)", async () => {
    // J-P2: the fresh PASS agrees with the earlier PASS — nothing disputed, no witness, no second seat.
    const fresh = await adjudicated({ runId: "run-adj-fresh", primary: [{ met: true }], second: [{ met: false }] });
    expect(fresh.summary.done).toEqual(["T1"]);
    expect(t1(fresh.rows, "judge-disagreement")).toEqual([]);
    expect(fresh.witnessReads).toEqual([]);
    expect(fresh.second.calls).toBe(0);
    expect(order).toEqual(["seat:judge-a"]);
    expect(acceptanceRows(fresh.rows)[0]!.data).toMatchObject({ pass: true, judgment: { judge: "judge-a:judge-a" } });

    // Versus a disputed criterion: S0 (HEAD's log, then its branch's) is read before the second seat launches, and
    // re-read after it returns.
    const disputed = await adjudicated({ runId: "run-adj-disputed", primary: [{ met: false }, { met: true }], second: [{ met: false }] });
    expectStamped(disputed);
    const branch = "refs/heads/tickmarkr/run-adj-disputed--T1";
    expect(order.slice(0, 6)).toEqual(["seat:judge-a", `witness:HEAD`, `witness:${branch}`, "seat:judge-b", `witness:HEAD`, `witness:${branch}`]);

    // J-P4: standalone verify --task adjudicates. Its own runGates call carries an earlier FAIL of c1 over the identical
    // src.txt blob, so the fresh PASS is disputed and the distinct fake-2 seat adjudicates (and agrees) — today's green
    // verdict, its own HEAD-reflog latch holding, and HEAD's log byte for byte as before.
    const repo = makeRepo({ "src.txt": "base\n" });
    sh(repo, "git checkout -q -b feature");
    writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
    sh(repo, `${COMMIT} feature`);
    saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["src.txt"] })] }));
    writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n");
    const script = join(makeTestTempDir("tickmarkr-adj-verify-"), "script.json");
    writeFileSync(script, JSON.stringify({ tasks: {}, judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "feature appended" }] } }));
    process.env.TICKMARKR_FAKE_SCRIPT = script;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prior = priorCommit(repo, { "src.txt": "base\nfeature" });
    const headLog = join(sh(repo, "git rev-parse --absolute-git-dir"), "logs", "HEAD");
    const logBefore = readFileSync(headLog, "utf8");
    order = [];
    vi.spyOn(git, "reflogWitness").mockImplementation(async (dir, ref) => {
      order.push(`witness:${ref}`);
      return realWitness(dir, ref);
    });
    vi.spyOn(FakeAdapter.prototype, "headlessCommand").mockImplementation(function (this: FakeAdapter, file: string, model: string) {
      if (readFileSync(file, "utf8").startsWith("TICKMARKR-JUDGE")) order.push(`seat:${model}`);
      return realHeadless.call(this, file, model);
    });
    const judged: Awaited<ReturnType<typeof gates.runGates>>[] = [];
    vi.spyOn(gates, "runGates").mockImplementation(async (task, ctx) => {
      const criteria = [{ id: "c1", key: gates.judgmentSubjectKey(task, "done", ctx.operatorContext), met: false, paths: ["src.txt"] }];
      const out = await realRunGates(task, { ...ctx, priorJudgments: [{ commit: prior, judge: "judge-z:judge-z", criteria }] });
      judged.push(out);
      return out;
    });
    const result = await verify(["--task", "T1", "--no-review"], repo);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("verify GREEN");
    expect(result.out).toMatch(/^PASS acceptance/m);
    expect(result.out).not.toContain("the candidate changed");
    const head = sh(repo, "git rev-parse HEAD");
    const adjudicatedRow = judged.flatMap((r) => r.results).find((r) => r.gate === "acceptance")!;
    expect(adjudicatedRow.meta).toMatchObject({
      adjudication: { primary: "fake:fake-1", adjudicator: "fake:fake-2", criteria: ["c1"], agreed: true },
      judgment: { commit: head, judge: "fake:fake-1" },
    });
    const from = order.indexOf("seat:fake-1");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(order.slice(from, from + 6)).toEqual(["seat:fake-1", "witness:HEAD", "witness:refs/heads/feature", "seat:fake-2", "witness:HEAD", "witness:refs/heads/feature"]);
    expect(readFileSync(headLog, "utf8")).toBe(logBefore);
  }, 300_000);
});
