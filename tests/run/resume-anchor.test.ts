// 2.8.1 T3 (ANL-023 §7.3): resume and approve read the journaled identity, chosen ONLY by run-start's
// `integrationAnchor: "journal"` marker. Resume rows run through runDaemon(…, { resume: true }); approve rows through the
// approve command. Marked journals come from the production daemon or carry the marker by hand; unmarked ones are the
// hand-written pre-2.8.1 shape.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon, type RunSummary } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { Journal, type JournalEvent, type OwedCheck } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const realShGit = git.shGit;
afterEach(() => vi.restoreAllMocks());

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const tryGit = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8" });
const until = async (what: string, ok: () => boolean, ms = 60_000) => {
  for (const deadline = Date.now() + ms; !ok();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Fixture { repo: string; runId: string; branch: string; base: string; foreign: string; fake: FakeAdapter; scriptPath: string }

/** One repository with a foreign commit F beside main. */
function fixture(runId: string, graph: unknown[], tasks: Record<string, unknown[]> = {}, cfg = ""): Fixture {
  const { repo, scriptPath } = setupRepo(graph, {}, cfg);
  const blob = execSync("git hash-object -w --stdin", { cwd: repo, input: "foreign\n", encoding: "utf8" }).trim();
  const tree = execSync("git mktree", { cwd: repo, input: `100644 blob ${blob}\tforeign.txt\n`, encoding: "utf8" }).trim();
  const foreign = sh(`git commit-tree ${tree} -p HEAD -m foreign`, repo);
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
  writeFileSync(scriptPath, JSON.stringify({ ...script, tasks, consult: { action: "human", notes: "parked" } }));
  return { repo, runId, branch: `tickmarkr/${runId}`, base: sh("git rev-parse HEAD", repo), foreign, fake: new FakeAdapter(scriptPath), scriptPath };
}

const work = (file: string) => ({ shell: `echo ${file} > ${file}.txt && ${COMMIT} ${file}`, result: { ok: true, summary: file } });
const rows = (fx: Fixture) => Journal.open(fx.repo, fx.runId).read();
const merges = (events: JournalEvent[]) => events.filter((e) => e.event === "merge");

async function run(fx: Fixture, resume = false, driver: ExecutorDriver = new SubprocessDriver()): Promise<{ summary: RunSummary; events: JournalEvent[] }> {
  driver.notify = async () => {};
  const summary = await runDaemon(fx.repo, { adapters: [fx.fake], driver, runId: fx.runId, resume, approvalWindowMs: 0 });
  return { summary, events: rows(fx) };
}

/** An accepted resume: its run-resume row names the rule, and the close's opening check held E (no integration failure). */
async function resumes(fx: Fixture, anchor: "journal" | "legacy-ref"): Promise<JournalEvent[]> {
  const before = rows(fx).length;
  const r = await run(fx, true);
  const added = r.events.slice(before);
  expect(added.find((e) => e.event === "run-resume")!.data.integrationAnchor).toBe(anchor);
  expect(r.summary.tipVerify).not.toBe("failed");
  expect(added.filter((e) => e.event === "tip-verify-failed")).toEqual([]);
  return added;
}

/** The ref exactly as found: symbolic target, loose bytes, packed commit or absence. */
function refState(fx: Fixture): string {
  const ref = `refs/heads/${fx.branch}`;
  const sym = tryGit(["symbolic-ref", "-q", ref], fx.repo);
  if (sym.status === 0) return `symbolic:${sym.stdout.trim()}`;
  const loose = join(fx.repo, ".git", ...ref.split("/"));
  if (existsSync(loose) && statSync(loose).isFile()) return `loose:${readFileSync(loose, "utf8").trim()}`;
  const commit = tryGit(["rev-parse", "--verify", "-q", ref], fx.repo);
  return commit.status === 0 ? `loose:${commit.stdout.trim()}` : "missing";
}
const mainState = (repo: string) => ({ head: sh("git rev-parse refs/heads/main", repo), log: sh("git reflog show --format=%H refs/heads/main", repo) });
const garbage = (fx: Fixture) => {
  const loose = join(fx.repo, ".git", "refs", "heads", ...fx.branch.split("/"));
  mkdirSync(dirname(loose), { recursive: true });
  writeFileSync(loose, "garbage\n");
};

/** Bait: a dead owner's lock — an accepted resume journals lock-reclaimed first, so a refusal after it would not be silent. */
const deadLock = (fx: Fixture) => writeFileSync(join(tickmarkrDir(fx.repo), "graph.lock"),
  JSON.stringify({ pid: spawnSync("true").pid, runId: fx.runId, startedAt: Date.now() - 60_000 }));

/** A refused resume: it throws before run-resume, journals nothing and leaves the ref (and main) as found; returns the text. */
async function refuses(fx: Fixture, text: string): Promise<string> {
  deadLock(fx);
  const before = rows(fx);
  const found = refState(fx);
  const main = mainState(fx.repo);
  const error = await run(fx, true).then(() => undefined, (e: unknown) => e as Error);
  expect(error?.message).toContain(text);
  expect(rows(fx)).toEqual(before);
  expect(refState(fx)).toBe(found);
  expect(mainState(fx.repo)).toEqual(main);
  return error!.message;
}

/** The backticked commands of a printed repair, run verbatim with `sh -c` from the repository root, stopping at the first that fails. */
function runRepair(repo: string, text: string): { ran: number; status: number } {
  const commands = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  let ran = 0;
  for (const command of commands) {
    ran++;
    const r = spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) return { ran, status: r.status ?? -1 };
  }
  return { ran, status: 0 };
}

/** A hand-written journal: run-start (marked or not) and an optional merge row for the human-gated T1, plus the lock bait. */
function written(name: string, { marked, baseRef, merge, ref }:
{ marked: boolean; baseRef?: string; merge?: (fx: Fixture) => Record<string, unknown>; ref?: (fx: Fixture) => void }): Fixture {
  const fx = fixture(name, [T("T1", { humanGate: true })]);
  const journal = Journal.create(fx.repo, fx.runId);
  journal.append("run-start", undefined, { pid: 111_111, baseRef: baseRef ?? fx.base, commands: {}, branch: fx.branch,
    graphDefinitionHash: graphDefinitionHash(loadGraph(fx.repo)), ...(marked ? { integrationAnchor: "journal" } : {}) });
  if (merge) journal.append("merge", "T1", { branch: `${fx.branch}--T1`, ...merge(fx) });
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
  ref?.(fx);
  deadLock(fx);
  return fx;
}
const at = (commit: (fx: Fixture) => string) => (fx: Fixture) => sh(`git update-ref refs/heads/${fx.branch} ${commit(fx)}`, fx.repo);

test("test: through the production resume a marked resume whose ref moved or was made symbolic to main or deleted or reset to an older published tip refuses before run-resume with its leg and journals nothing and leaves the ref as found and the printed repair run verbatim restores the anchor regular with main untouched so the next resume proceeds versus a marked resume at its newest merge and one at its base with no merge and one after a delayed author fold resuming at that commit (R-F1 F2 F3 F4 R-P1 P2 P9)", async () => {
  // R-P9 (7.2 P-P4's journal): A's (T1's) author fold is delayed while B (T2) publishes M1; then A publishes M2 from M1.
  const fx = fixture("run-r-p9", [T("T1"), T("T2"), T("T3", { humanGate: true })],
    { T1: [work("one")], T2: [work("two")], T3: [work("three")] }, "concurrency: 2\n");
  let delayed = false;
  vi.spyOn(git, "shGit").mockImplementation(async (...a: Parameters<typeof git.shGit>) => {
    if (!delayed && a[0].startsWith("git show --format= --binary") && a[1].endsWith("--T1")) {
      delayed = true;
      await until("B's merge", () => merges(rows(fx)).some((e) => e.taskId === "T2"));
    }
    return realShGit(...a);
  });
  const first = await run(fx);
  vi.restoreAllMocks();
  expect(delayed).toBe(true);
  expect(first.summary).toMatchObject({ done: ["T1", "T2"], human: ["T3"] });
  expect(first.events.find((e) => e.event === "run-start")!.data.integrationAnchor).toBe("journal");
  const [b, a] = merges(first.events);
  expect([b!.taskId, a!.taskId]).toEqual(["T2", "T1"]);
  expect(a!.data.from).toBe(b!.data.commit);
  const [m1, m2] = [b!.data.commit as string, a!.data.commit as string];
  expect(refState(fx)).toBe(`loose:${m2}`);

  // R-P1 / R-P9: at its newest merge (M2 = the ref) the marked resume proceeds.
  await resumes(fx, "journal");
  expect(refState(fx)).toBe(`loose:${m2}`);

  // R-F1 / F2 / F3 / F4: each refuses with its leg, the repair restores M2 regular, and the next resume proceeds.
  const cases: Array<[string, () => void, string, string | undefined]> = [
    ["value", () => sh(`git update-ref refs/heads/${fx.branch} ${fx.foreign}`, fx.repo), `found ${fx.foreign.slice(0, 12)} — repair: `, fx.foreign],
    ["symbolic", () => sh(`git symbolic-ref refs/heads/${fx.branch} refs/heads/main`, fx.repo), `found ${fx.base.slice(0, 12)} (symbolic to refs/heads/main) — repair: `, fx.base],
    ["missing", () => sh(`git update-ref -d refs/heads/${fx.branch}`, fx.repo), "found none — repair: ", undefined],
    ["value", () => sh(`git update-ref refs/heads/${fx.branch} ${m1}`, fx.repo), `found ${m1.slice(0, 12)} — repair: `, m1],
  ];
  for (const [leg, spoil, found, preserved] of cases) {
    spoil();
    const main = mainState(fx.repo);
    const text = await refuses(fx, `refusing to resume ${fx.runId}: integration branch ${fx.branch} does not hold its last published tip (${leg}): expected ${m2.slice(0, 12)}, ${found}`);
    expect(text).toMatch(/, then resume$/);
    expect(runRepair(fx.repo, text)).toEqual({ ran: preserved ? 3 : 1, status: 0 });
    expect(refState(fx)).toBe(`loose:${m2}`);
    expect(mainState(fx.repo)).toEqual(main);
    if (preserved) expect(sh(`git rev-parse refs/tickmarkr/found/${fx.runId}/${preserved}`, fx.repo)).toBe(preserved);
    await resumes(fx, "journal");
  }

  // E = A: the released T3 publishes from M2, the newest merge row's commit.
  await approve([fx.runId, "T3", "--by", "op"], fx.repo);
  const last = await run(fx, true);
  expect(last.summary.done).toEqual(["T1", "T2", "T3"]);
  expect(merges(last.events).at(-1)!.data).toMatchObject({ from: m2 });

  // R-P2: a marked run with no merge resumes at its run-start base.
  const p2 = fixture("run-r-p2", [T("T1", { humanGate: true })]);
  expect((await run(p2)).summary.human).toEqual(["T1"]);
  expect(merges(rows(p2))).toEqual([]);
  await resumes(p2, "journal");
  expect(refState(p2)).toBe(`loose:${p2.base}`);
}, 600_000);

test("test: through the production resume a marked resume whose ref holds non-object-id bytes or whose newest merge row commit is not an object id or lacks from or whose run-start base is not an object id with no merge refuses naming the unreadable ref or anchor with no command versus the well-formed marked resume proceeding (R-F5 F6 F7 F14 R-P1)", async () => {
  const published = (fx: Fixture) => ({ commit: fx.foreign, from: fx.base });
  // R-P1: the well-formed marked journal (its newest merge row at the ref, with from) resumes; the lock bait is live.
  const p1 = written("run-r-p1-written", { marked: true, merge: published, ref: at((fx) => fx.foreign) });
  const added = await resumes(p1, "journal");
  expect(added.map((e) => e.event)).toContain("lock-reclaimed");
  expect(refState(p1)).toBe(`loose:${p1.foreign}`);

  // R-F5: the same journal; the ref's loose file holds non-object-id bytes.
  const f5 = written("run-r-f5", { marked: true, merge: published, ref: garbage });
  const unreadable = await refuses(f5, `integration branch ${f5.branch} does not hold its last published tip (unreadable): expected ${f5.foreign.slice(0, 12)}, found none`);
  expect(unreadable).toContain(`refs/heads/${f5.branch} is unreadable (`);
  expect(unreadable).not.toContain("`");
  expect(refState(f5)).toBe("loose:garbage");

  // R-F6 / F7 / F14: the anchor itself is unreadable — named, with no command (the ref held where a reading would put it).
  const anchors: Array<[string, Parameters<typeof written>[1], string]> = [
    ["run-r-f6", { marked: true, merge: (fx) => ({ commit: "not-an-object-id", from: fx.base }), ref: at((fx) => fx.foreign) },
      "the newest merge row's commit is \"not-an-object-id\", not an object id"],
    ["run-r-f7", { marked: true, merge: (fx) => ({ commit: fx.foreign }), ref: at((fx) => fx.foreign) }, "the newest merge row's from is absent, not an object id"],
    ["run-r-f14", { marked: true, baseRef: "HEAD", ref: at((fx) => fx.base) }, "run-start baseRef is \"HEAD\", not an object id"],
  ];
  for (const [name, shape, what] of anchors) {
    const fx = written(name, shape);
    const text = await refuses(fx, `refusing to resume ${fx.runId}: its journal names no readable published tip (${what})`);
    expect(text).not.toContain("`");
  }

  // The superseded check refuses first (§7.3: I(A) runs after it): a superseded marked run with a moved ref, and one
  // with no merge whose baseRef is no object id, both name the successor — never a repair, never the anchor.
  const superseded: Array<[string, Parameters<typeof written>[1]]> = [
    ["run-r-superseded-moved", { marked: true, merge: published, ref: at((fx) => fx.base) }],
    ["run-r-superseded-anchor", { marked: true, baseRef: "HEAD", ref: at((fx) => fx.base) }],
  ];
  for (const [name, shape] of superseded) {
    const fx = written(name, shape);
    Journal.open(fx.repo, fx.runId).append("superseded", undefined, { by: "run-next" });
    const text = await refuses(fx, `refusing to resume ${fx.runId}: superseded by run-next`);
    expect(text).not.toMatch(/repair|published tip|`/);
  }
}, 300_000);

test("test: through the production resume an unmarked journal resumes by its regular ref as legacy-ref even after adopting a pre-existing branch and recreates a never-created branch at its base when it holds no merge row and refuses a symbolic ref with a repair making it regular at its own value and a dangling symbolic or unreadable ref with no command and a missing ref when it holds a merge row versus a marked journal following the anchor (R-P3 P4 P10 R-F8 F9 F12 F13)", async () => {
  const other = (fx: Fixture) => sh(`git commit-tree ${fx.base}^{tree} -p ${fx.base} -m other`, fx.repo);
  // R-P3: merge rows (pre-2.8.1: no from) and the ref regular at a commit the rows never name — E = the ref.
  const p3 = written("run-r-p3", { marked: false, merge: (fx) => ({ commit: other(fx) }), ref: at((fx) => fx.foreign) });
  await resumes(p3, "legacy-ref");
  expect(refState(p3)).toBe(`loose:${p3.foreign}`);
  // …versus the marked journal, which follows its anchor and refuses the same ref.
  let m3m = "";
  const p3m = written("run-r-p3-marked", { marked: true, merge: (fx) => ({ commit: m3m = other(fx), from: fx.base }), ref: at((fx) => fx.foreign) });
  await refuses(p3m, `does not hold its last published tip (value): expected ${m3m.slice(0, 12)}, found ${p3m.foreign.slice(0, 12)}`);

  // R-P4: no merge row; the run adopted a pre-existing branch at F while run-start.baseRef was E — resumes with E = F.
  const p4 = written("run-r-p4", { marked: false, ref: at((fx) => fx.foreign) });
  await resumes(p4, "legacy-ref");
  expect(refState(p4)).toBe(`loose:${p4.foreign}`);
  const p4m = written("run-r-p4-marked", { marked: true, ref: at((fx) => fx.foreign) });
  await refuses(p4m, `does not hold its last published tip (value): expected ${p4m.base.slice(0, 12)}, found ${p4m.foreign.slice(0, 12)}`);

  // R-P10: no merge row and the branch never created — created create-only at the run-start base.
  const p10 = written("run-r-p10", { marked: false });
  await resumes(p10, "legacy-ref");
  expect(refState(p10)).toBe(`loose:${p10.base}`);
  expect(sh(`git reflog show --format=%gs refs/heads/${p10.branch}`, p10.repo)).toBe("tickmarkr: run start");
  const p10m = written("run-r-p10-marked", { marked: true });
  await refuses(p10m, `does not hold its last published tip (missing): expected ${p10m.base.slice(0, 12)}, found none — repair: \`git update-ref --no-deref refs/heads/${p10m.branch} ${p10m.base} ""\``);

  // R-F8: symbolic to main — the repair makes it regular at its own value; main untouched; then it resumes.
  const f8 = written("run-r-f8", { marked: false, ref: (fx) => sh(`git symbolic-ref refs/heads/${fx.branch} refs/heads/main`, fx.repo) });
  const main = mainState(f8.repo);
  const text = await refuses(f8, `refusing to resume ${f8.runId}: integration branch ${f8.branch} is symbolic to refs/heads/main at ${f8.base.slice(0, 12)} (symbolic) — repair: `);
  expect(runRepair(f8.repo, text)).toEqual({ ran: 3, status: 0 });
  expect(refState(f8)).toBe(`loose:${f8.base}`);
  expect(mainState(f8.repo)).toEqual(main);
  await resumes(f8, "legacy-ref");

  // R-F9 / F12 / F13: missing with a merge row, symbolic to a missing ref, unreadable — refused with no command.
  const noCommand: Array<[Fixture, string]> = [
    [written("run-r-f9", { marked: false, merge: (fx) => ({ commit: fx.foreign }) }), "is missing while the journal records merges (missing)"],
    [written("run-r-f12", { marked: false, ref: (fx) => sh(`git symbolic-ref refs/heads/${fx.branch} refs/heads/nope`, fx.repo) }),
      "is symbolic to refs/heads/nope, which names no commit (symbolic)"],
    [written("run-r-f13", { marked: false, ref: garbage }), "is unreadable: "],
  ];
  for (const [fx, what] of noCommand) {
    const refused = await refuses(fx, `refusing to resume ${fx.runId}: integration branch ${fx.branch} ${what}`);
    expect(refused).toContain("restore the branch to the tip you trust, then resume");
    expect(refused).not.toContain("`");
  }
}, 300_000);

/** A driver whose worker waits throw after each worker's shell finished: its commit landed and the task fails unharvested. */
const wedgedAfterWork = (): ExecutorDriver => {
  const inner = new SubprocessDriver();
  return {
    id: "wedged-after-work",
    slot: inner.slot.bind(inner),
    run: inner.run.bind(inner),
    async waitOutput(slot, pattern, timeoutMs, opts) {
      const seen = await inner.waitOutput(slot, pattern, timeoutMs, opts);
      if (slot.name.includes("-worker-")) throw new Error("pane wedged after the worker committed");
      return seen;
    },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
};

/** Strips run-start's marker, so the same journal reads as a pre-2.8.1 run. */
function unmark(fx: Fixture): void {
  const file = join(Journal.open(fx.repo, fx.runId).dir, "journal.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").map((line) => {
    if (!line.includes('"event":"run-start"')) return line;
    const row = JSON.parse(line) as JournalEvent;
    const { integrationAnchor, ...data } = row.data;
    expect(integrationAnchor).toBe("journal");
    return JSON.stringify({ ...row, data });
  }).join("\n"));
}

/** The config with integrationBranchPrefix changed (or restored); the run-start branch never changes. */
function prefix(fx: Fixture, value?: string): void {
  const path = join(tickmarkrDir(fx.repo), "config.yaml");
  const kept = readFileSync(path, "utf8").replace(/^integrationBranchPrefix: .*\n/m, "");
  writeFileSync(path, value ? `${kept}integrationBranchPrefix: ${value}\n` : kept);
}
/** A newest merge row whose commit is no object id: the marked run's anchor becomes unreadable. */
const spoilAnchor = (fx: Fixture) => Journal.open(fx.repo, fx.runId).append("merge", "T9", { branch: `${fx.branch}--T9`, commit: "garbage" });
const UNREADABLE = "its journal names no readable published tip (the newest merge row's commit is \"garbage\", not an object id)";

test("test: through the approve command a marked run's recheck and waive take the branch from run-start and the base from the anchor after a prefix change or a moved ref and an unreadable anchor refuses the recheck appending nothing and records the waive's obligation unknown versus an unmarked run keeping the by-name behaviour (R-P5 P6 P7 P8 R-F10 F11)", async () => {
  // ---- --recheck on failed tasks whose commits landed on their task branches (a recheck releases its failure) -------
  const rf = fixture("run-r-recheck", [T("T1"), T("T2"), T("T3"), T("T4")], { T1: [work("one")], T2: [work("two")], T3: [work("three")], T4: [work("four")] }, "visibility: { keepPanes: forever }\n");
  expect((await run(rf, false, wedgedAfterWork())).summary.failed).toEqual(["T1", "T2", "T3", "T4"]);
  const recheck = (id: string) => approve([rf.runId, id, "--recheck", "--by", "op"], rf.repo);
  const approvals = () => rows(rf).filter((e) => e.event === "task-approved");
  const admitted = (id: string) => `1 commit(s) on ${rf.branch}--${id} ahead of ${rf.branch}; no worker funded`;
  const moveOver = (fx: Fixture, id: string) => {
    const tip = sh(`git rev-parse ${fx.branch}--${id}`, fx.repo);
    sh(`git update-ref refs/heads/${fx.branch} ${tip}`, fx.repo);
    return tip;
  };
  // R-P5: integrationBranchPrefix changed — counted on the run-start branch against A.
  prefix(rf, "other/");
  expect(await recheck("T1")).toContain(admitted("T1"));
  // R-P6: the ref moved forward over the task's commit — counted against A, the commit is still ahead.
  prefix(rf);
  moveOver(rf, "T2");
  expect(await recheck("T2")).toContain(admitted("T2"));
  expect(approvals().map((e) => e.taskId)).toEqual(["T1", "T2"]);
  // R-F10: an unreadable anchor refuses the recheck and appends nothing.
  spoilAnchor(rf);
  const before = rows(rf);
  await expect(recheck("T3")).rejects.toThrow(`refusing to recheck T3 in ${rf.runId}: ${UNREADABLE}`);
  expect(rows(rf)).toEqual(before);
  // R-P8: the same journal unmarked keeps the by-name count — a ref moved over the commit holds it, and a changed
  // prefix names a branch the run never made.
  unmark(rf);
  moveOver(rf, "T4");
  await expect(recheck("T4")).rejects.toThrow(`${rf.branch}--T4 carries no commits ahead of ${rf.branch} — nothing to re-gate`);
  prefix(rf, "other/");
  await expect(recheck("T4")).rejects.toThrow(`carries no commits ahead of other/${rf.runId} — nothing to re-gate`);
  expect(approvals()).toHaveLength(2);
  // …while the unmarked recheck at a by-name branch holding A still counts the same.
  prefix(rf);
  sh(`git update-ref refs/heads/${rf.branch} ${rf.base}`, rf.repo);
  expect(await recheck("T3")).toContain(admitted("T3"));

  // ---- --waive on three lint-parked tasks ---------------------------------------------------------------------------
  const red = (file: string) => ({ shell: `echo ${file} > bad.txt && echo ${file} > ${file}.txt && ${COMMIT} ${file}`, result: { ok: true, summary: file } });
  const wf = fixture("run-r-waive", [T("T1"), T("T2"), T("T3")], { T1: [red("one")], T2: [red("two")], T3: [red("three")] },
    "gates: { lint: \"test ! -f bad.txt\" }\n");
  process.env.TICKMARKR_FAKE_SCRIPT = wf.scriptPath; // the declared seats a review discharge may resolve to
  try {
    expect((await run(wf)).summary.human).toEqual(["T1", "T2", "T3"]);
    const waive = (id: string) => approve([wf.runId, id, "--waive", "--by", "op"], wf.repo);
    const obligation = (id: string) => [...rows(wf)].reverse().find((e) => e.event === "task-approved" && e.taskId === id)!.data.obligation as OwedCheck;
    // R-P7 (and R-P5's prefix change): the ref moved forward over T1's commit — base = merge-base(A, task head); known.
    prefix(wf, "other/");
    const head1 = moveOver(wf, "T1");
    expect(await waive("T1")).not.toContain("debt unknown");
    expect(obligation("T1")).toMatchObject({ known: true, base: sh(`git merge-base ${wf.base} ${head1}`, wf.repo), head: head1 });
    expect(obligation("T1").base).toBe(wf.base);
    // R-F11: an unreadable anchor still appends the waive, its obligation recorded unknown.
    spoilAnchor(wf);
    moveOver(wf, "T2");
    expect(await waive("T2")).toContain("(debt unknown)");
    expect(obligation("T2")).toMatchObject({ known: false, unknownReason: UNREADABLE });
    // R-P8: the same conditions unmarked keep the by-name base — the changed prefix names no task branch: unknown.
    unmark(wf);
    moveOver(wf, "T3");
    expect(await waive("T3")).toContain("(debt unknown)");
    expect(obligation("T3")).toMatchObject({ known: false, base: "unknown" });
    expect(obligation("T3").unknownReason).toContain(`other/${wf.runId}--T3`);
  } finally {
    delete process.env.TICKMARKR_FAKE_SCRIPT;
  }
}, 600_000);
