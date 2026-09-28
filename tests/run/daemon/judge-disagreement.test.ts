// T7 (OBS-1151 +add.1): every round judges fresh. A fresh ruling that reverses an earlier one while every
// cited file holds the identical blob is a judge disagreement: one DISTINCT eligible judge adjudicates,
// agreement stands (a sound FAIL included), and a split, a missing seat or an unreadable adjudication parks
// for the operator without charging the worker. The earlier judgment is seeded as the journal keeps it and
// the daemon RESUMES over it, so the comparison is the production one across a resume.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { tickmarkrDir, graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { judgmentSubjectKey } from "../../../src/gates/run-gates.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { gitHead } from "../../../src/run/git.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

type Ruling = { met: boolean; line?: number; duplicate?: boolean };
class Judge extends FakeAdapter {
  calls = 0;
  constructor(path: string, public override id: string, private rulings: Ruling[], private tier: BillingChannel["tier"] = "frontier") {
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
    const r = this.rulings[Math.min(this.calls++, this.rulings.length - 1)]!;
    const row = (met: boolean) => ({ criterion: "c1", met, reason: met ? "a.txt holds A" : "a.txt does not hold the behavior", evidence: { path: "a.txt", line: r.line ?? 1 } });
    // `duplicate`: an internally contradictory verdict — c1 ruled both ways in one reply.
    const verdict = { nonce, pass: r.met, criteria: r.duplicate ? [row(r.met), row(!r.met)] : [row(r.met)] };
    return `printf '%s' ${shq(JSON.stringify(verdict))}`;
  }
}
class CheapAuthor extends FakeAdapter {
  judges = 0;
  override channels(): BillingChannel[] { return [{ ...super.channels()[0]!, tier: "cheap" }]; }
  override headlessCommand(file: string, model: string): string {
    if (readFileSync(file, "utf8").startsWith("TICKMARKR-JUDGE")) this.judges++;
    return super.headlessCommand(file, model);
  }
}

const write = (files: Record<string, string>, msg: string) => ({
  shell: `${Object.entries(files).map(([p, c]) => `printf '%s\\n' ${shq(c)} > ${p}`).join(" && ")} && ${COMMIT} ${msg}`,
  result: { ok: true, summary: msg },
});

/** A commit (off HEAD, reachable by a test ref) holding `files` — the subject an earlier judgment saw. */
function priorCommit(repo: string, files: Record<string, string>): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(repo, ".git", "prior-index") };
  const git = (args: string, input?: string) => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env, input }).trim();
  git("read-tree HEAD");
  for (const [path, content] of Object.entries(files)) {
    git(`update-index --add --cacheinfo 100644,${git("hash-object -w --stdin", `${content}\n`)},${path}`);
  }
  const sha = git(`commit-tree ${git("write-tree")} -p HEAD -m prior`);
  git(`update-ref refs/tickmarkr/test-prior ${sha}`);
  return sha;
}

interface Rig { repo: string; runId: string; author: CheapAuthor; primary: Judge; second: Judge; rows: () => JournalEvent[] }

/** Seed one earlier PASS judgment of c1 (keyed as the daemon keys it) and resume the run over it. */
async function judgedResume(opts: {
  runId: string; steps: Array<ReturnType<typeof write>>; primary: Ruling[]; second: Ruling[];
  priorFiles?: Record<string, string>; priorKey?: { criterion?: string; files?: string[]; operatorContext?: string };
  priorMet?: boolean; singleJudge?: boolean;
}): Promise<Rig & { summary: Awaited<ReturnType<typeof runDaemon>> }> {
  const task = T("T1", opts.singleJudge ? { gates: ["build", "test", "lint", "evidence", "scope", "acceptance"] } : {});
  const { repo, scriptPath } = setupRepo([task], {
    tasks: { T1: opts.steps }, consult: { action: "retry", notes: "fix it" },
    judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "a.txt does not hold the behavior", evidence: { path: "a.txt", line: 1 } }] },
  });
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), [
    "concurrency: 1",
    "routing:", "  escalateTier: \"off\"", "  floors: { implement: cheap }",
    opts.singleJudge ? "judge: { adapter: fake, model: fake-1 }" : "judge: { adapter: judge-a, model: judge-a }",
    "consult: { adapter: fake, model: fake-1 }",
    "review: { required: true, prefer: [seat-r], timeoutMs: 5000 }", "",
  ].join("\n"));
  const author = new CheapAuthor(scriptPath);
  const primary = new Judge(scriptPath, "judge-a", opts.primary);
  const second = new Judge(scriptPath, "judge-b", opts.second);
  const reviewer = new Judge(scriptPath, "seat-r", [{ met: true }], "mid");
  const loaded = loadGraph(repo).tasks[0]!;
  const key = judgmentSubjectKey({ ...loaded, ...(opts.priorKey?.files ? { files: opts.priorKey.files } : {}) },
    opts.priorKey?.criterion ?? "done", opts.priorKey?.operatorContext);
  const commit = priorCommit(repo, opts.priorFiles ?? { "a.txt": "A", "b.txt": "old" });
  const journal = Journal.create(repo, opts.runId);
  journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  journal.append("gate-result", "T1", { gate: "acceptance", pass: opts.priorMet ?? true, details: "✓ c1: a.txt holds A",
    judgment: { commit, judge: "judge-z:judge-z", criteria: [{ id: "c1", key, met: opts.priorMet ?? true, paths: ["a.txt"] }] } });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  const adapters = opts.singleJudge ? [author] : [author, primary, second, reviewer];
  const summary = await runDaemon(repo, { adapters, runId: opts.runId, resume: true });
  return { repo, runId: opts.runId, author, primary, second, summary, rows: () => Journal.open(repo, opts.runId).read() };
}

const t1 = (rows: JournalEvent[], event: string) => rows.filter((row) => row.taskId === "T1" && row.event === event);
const acceptanceRows = (rows: JournalEvent[]) => t1(rows, "gate-result").filter((row) => row.data.gate === "acceptance").slice(1); // after the seeded prior

describe("judge disagreement over identical cited blobs (production daemon, zero tokens)", () => {
  test("the production daemon accepts a fresh FAIL contradicting a prior PASS on identical cited blobs only after a distinct judge confirms it and parks a split without worker debit, so blind PASS reuse or first-FAIL repair fails", async () => {
    // Confirmed: the fresh FAIL stands and funds the worker; the repaired cited file then passes fresh.
    const confirmed = await judgedResume({ runId: "run-jd-confirm",
      steps: [write({ "a.txt": "A", "b.txt": "new" }, "a0"), write({ "a.txt": "A2" }, "a1")],
      primary: [{ met: false }, { met: true }], second: [{ met: false }] });
    expect(confirmed.summary.done).toEqual(["T1"]);
    const rows = confirmed.rows();
    expect(t1(rows, "judge-disagreement")).toHaveLength(1);
    expect(t1(rows, "judge-disagreement")[0]!.data).toMatchObject({ primary: "judge-a:judge-a", disputed: [expect.objectContaining({ id: "c1", met: false, priorMet: true, paths: ["a.txt"] })] });
    const verdicts = acceptanceRows(rows);
    expect(verdicts.map((row) => row.data.pass)).toEqual([false, true]);
    expect(verdicts[0]!.data.infra).toBeUndefined();
    expect(verdicts[0]!.data.adjudication).toMatchObject({ primary: "judge-a:judge-a", adjudicator: "judge-b:judge-b", agreed: true });
    expect(confirmed.second.calls).toBe(1);
    expect(t1(rows, "task-dispatch")).toHaveLength(2);
    // Split: the distinct judge sides with the earlier PASS — parked, the worker never funded.
    const split = await judgedResume({ runId: "run-jd-split",
      steps: [write({ "a.txt": "A", "b.txt": "new" }, "s0"), write({ "a.txt": "A2" }, "s1")],
      primary: [{ met: false }], second: [{ met: true }] });
    expect(split.summary.human).toEqual(["T1"]);
    const splitRows = split.rows();
    expect(t1(splitRows, "task-dispatch")).toHaveLength(1);
    expect(splitRows.filter((row) => ["escalation", "consult", "repair-attempt", "task-done"].includes(row.event))).toEqual([]);
    expect(t1(splitRows, "task-human").at(-1)?.data.kind).toBe("infra");
    const parked = acceptanceRows(splitRows);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.data).toMatchObject({ infra: true, judgeDisagreement: { primary: "judge-a:judge-a", adjudicator: "judge-b:judge-b" } });
    expect(String((parked[0]!.data.judgeDisagreement as Record<string, unknown>).outcome)).toContain("split");
    expect(parked[0]!.data.judgment).toBeUndefined();
  });

  test("the production daemon parks an identical-subject contradiction when a distinct eligible judge or verifiable citation is unavailable versus recording agreeing judgments with both identities, so recycling the primary channel or invented evidence fails", async () => {
    // No distinct eligible judge: the primary seat is the whole judge pool, and it is never re-asked.
    const alone = await judgedResume({ runId: "run-jd-alone", singleJudge: true,
      steps: [write({ "a.txt": "A", "b.txt": "new" }, "n0"), write({ "a.txt": "A2" }, "n1")], primary: [], second: [] });
    expect(alone.summary.human).toEqual(["T1"]);
    expect(alone.author.judges).toBe(1);
    const aloneRows = alone.rows();
    expect(t1(aloneRows, "task-dispatch")).toHaveLength(1);
    expect(t1(aloneRows, "judge-disagreement")).toHaveLength(1);
    expect(String((acceptanceRows(aloneRows)[0]!.data.judgeDisagreement as Record<string, unknown>).outcome)).toContain("no distinct eligible judge");
    // Invented evidence: the adjudicator cites a line outside every changed hunk — it confirms nothing.
    const invented = await judgedResume({ runId: "run-jd-invented",
      steps: [write({ "a.txt": "A", "b.txt": "new" }, "i0"), write({ "a.txt": "A2" }, "i1")],
      primary: [{ met: false }], second: [{ met: false, line: 99 }] });
    expect(invented.summary.human).toEqual(["T1"]);
    expect([invented.primary.calls, invented.second.calls]).toEqual([1, 1]);
    const inventedRows = invented.rows();
    expect(t1(inventedRows, "task-dispatch")).toHaveLength(1);
    expect(acceptanceRows(inventedRows)[0]!.data).toMatchObject({ infra: true, judgeDisagreement: { adjudicator: "judge-b:judge-b" } });
    expect(String((acceptanceRows(inventedRows)[0]!.data.judgeDisagreement as Record<string, unknown>).outcome)).toContain("no readable verdict");
    // Inconsistent adjudication: c1 ruled FAIL and PASS in one verdict confirms nothing — parked, never charged.
    const torn = await judgedResume({ runId: "run-jd-torn",
      steps: [write({ "a.txt": "A", "b.txt": "new" }, "t0"), write({ "a.txt": "A2" }, "t1")],
      primary: [{ met: false }], second: [{ met: false, duplicate: true }] });
    expect(torn.summary.human).toEqual(["T1"]);
    expect(torn.second.calls).toBe(1);
    const tornRows = torn.rows();
    expect(t1(tornRows, "task-dispatch")).toHaveLength(1);
    expect(tornRows.filter((row) => ["escalation", "consult", "repair-attempt", "task-done"].includes(row.event))).toEqual([]);
    expect(acceptanceRows(tornRows)[0]!.data).toMatchObject({ infra: true, judgeDisagreement: { adjudicator: "judge-b:judge-b" } });
    expect(String((acceptanceRows(tornRows)[0]!.data.judgeDisagreement as Record<string, unknown>).outcome)).toContain("no readable verdict");
    // Agreement: both identities are on the record beside the judgment that stands.
    const agreed = await judgedResume({ runId: "run-jd-agreed",
      steps: [write({ "a.txt": "A", "b.txt": "new" }, "g0"), write({ "a.txt": "A2" }, "g1")],
      primary: [{ met: false }, { met: true }], second: [{ met: false }] });
    const first = acceptanceRows(agreed.rows())[0]!.data;
    expect(first.adjudication).toMatchObject({ primary: "judge-a:judge-a", adjudicator: "judge-b:judge-b", criteria: ["c1"], agreed: true });
    expect(first.judgment).toMatchObject({ judge: "judge-a:judge-a", criteria: [expect.objectContaining({ id: "c1", met: false, paths: ["a.txt"] })] });
    expect(agreed.primary.calls).toBe(2);
    expect(agreed.second.calls).toBe(1);
  });
});
