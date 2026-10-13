// 2.8.1 T2 (ANL-023 §7.2): a merge is published only by compare-and-swap from the stored tip E, and the run keeps no
// integration checkout. Every row runs through the production daemon (runDaemon + FakeAdapter + subprocess driver);
// mergeTask's test-only seam is wired in by spying the module export, so it is active under runDaemon.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus, tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon, type RunSummary } from "../../src/run/daemon.js";
import * as gateRunner from "../../src/gates/run-gates.js";
import * as git from "../../src/run/git.js";
import { integrationMapped, Journal, type JournalEvent, type OwedCheck, rangePatch, rangePatches } from "../../src/run/journal.js";
import * as merge from "../../src/run/merge.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";
import { conflictPair } from "../helpers/worker-barrier.js";

const realMerge = merge.mergeTask;
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

interface Fixture { repo: string; runId: string; branch: string; base: string; foreign: string; other: string; fake: FakeAdapter }

/** One repository with a foreign commit F (and a second one G) beside main; `steps` sees the branch, F and G. */
function fixture(runId: string, graph: unknown[], steps: (fx: { branch: string; foreign: string; other: string }) => Record<string, unknown[]>,
  { cfg = "", consult = "human" }: { cfg?: string; consult?: "human" | "retry" } = {}): Fixture {
  const branch = `tickmarkr/${runId}`;
  const made = (name: string, repo: string) => {
    const blob = execSync("git hash-object -w --stdin", { cwd: repo, input: `${name}\n`, encoding: "utf8" }).trim();
    const tree = execSync("git mktree", { cwd: repo, input: `100644 blob ${blob}\t${name}.txt\n`, encoding: "utf8" }).trim();
    return sh(`git commit-tree ${tree} -p HEAD -m ${name}`, repo);
  };
  const { repo, scriptPath } = setupRepo(graph, {}, cfg);
  const foreign = made("foreign", repo);
  const other = made("other", repo);
  sh(`git update-ref refs/heads/foreign ${foreign}`, repo);
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
  writeFileSync(scriptPath, JSON.stringify({ ...script, tasks: steps({ branch, foreign, other }),
    consult: consult === "human" ? { action: "human", notes: "parked" } : { action: "retry", notes: "again" } }));
  return { repo, runId, branch, base: sh("git rev-parse HEAD", repo), foreign, other, fake: new FakeAdapter(scriptPath) };
}

/** A lint command, so every close with a done task runs a battery whose verdicts would reach the store. */
const TIP_GATE = "gates: { lint: \"true\" }\n";
const work = (file: string, extra = "") => ({ shell: `echo ${file} > ${file}.txt && ${COMMIT} ${file}${extra ? ` && ${extra}` : ""}`, result: { ok: true, summary: file } });

async function run(fx: Fixture, resume = false): Promise<{ summary: RunSummary; events: JournalEvent[] }> {
  const driver = new SubprocessDriver();
  driver.notify = async () => {};
  const summary = await runDaemon(fx.repo, { adapters: [fx.fake], driver, runId: fx.runId, resume, approvalWindowMs: 0 });
  return { summary, events: Journal.open(fx.repo, fx.runId).read() };
}

/** The ref exactly as found: symbolic target, loose bytes, packed commit or absence. */
function refState(repo: string, ref: string): string {
  const sym = tryGit(["symbolic-ref", "-q", ref], repo);
  if (sym.status === 0) return `symbolic:${sym.stdout.trim()}`;
  const loose = join(repo, ".git", ...ref.split("/"));
  if (existsSync(loose) && statSync(loose).isFile()) return `loose:${readFileSync(loose, "utf8").trim()}`;
  const commit = tryGit(["rev-parse", "--verify", "-q", ref], repo);
  return commit.status === 0 ? `loose:${commit.stdout.trim()}` : "missing";
}
const mainState = (repo: string) => ({ head: sh("git rev-parse refs/heads/main", repo), log: sh("git reflog show --format=%H refs/heads/main", repo) });
const merges = (events: JournalEvent[]) => events.filter((e) => e.event === "merge");
const parkOf = (events: JournalEvent[], id: string) => events.findLast((e) => e.event === "task-human" && e.taskId === id)!;
const noDaemonCheckout = (fx: Fixture) => {
  expect(sh("git worktree list --porcelain", fx.repo)).not.toContain(`branch refs/heads/${fx.branch}\n`);
  expect(existsSync(git.worktreePath(fx.repo, fx.branch))).toBe(false);
};

/**
 * PARK's checkout and store legs: every verification checkout C is gone after the close (no `tip-verify-*` directory or
 * registration survives); returns the trees of the close's own verdict-store entries (scope `tip`).
 */
function closeTrail(repo: string): string[] {
  const parent = join(tickmarkrDir(repo), git.WORKTREES_DIR);
  expect(existsSync(parent) ? readdirSync(parent).filter((d) => d.startsWith("tip-verify-")) : []).toEqual([]);
  expect(sh("git worktree list --porcelain", repo)).not.toContain("tip-verify-");
  const store = join(tickmarkrDir(repo), "verdicts");
  return (existsSync(store) ? readdirSync(store) : []).filter((f) => /^verdict-.*\.json$/.test(f))
    .map((f) => (JSON.parse(readFileSync(join(store, f), "utf8")) as { identity: { scope?: string; tree: string } }).identity)
    .filter((id) => id.scope === "tip").map((id) => id.tree);
}

/** PARK infra for an integration move: no merge row for the task, the ref as found, no daemon checkout, terminal not green. */
function expectMovedPark(fx: Fixture, r: { summary: RunSummary; events: JournalEvent[] }, id: string, leg: string, found: string,
  { expected = fx.base, stage = "check" }: { expected?: string; stage?: string } = {}): string {
  const park = parkOf(r.events, id);
  expect(r.summary.human).toContain(id);
  expect(park.data.kind).toBe("infra");
  expect(park.data.integrationMoved).toMatchObject({ branch: fx.branch, expected, leg, stage });
  expect(park.data.reason).toContain(`integration branch ${fx.branch} moved (${leg}): expected ${expected.slice(0, 12)}`);
  expect(park.data.reason).toMatch(/, then approve a recheck$/);
  expect(merges(r.events).filter((e) => e.taskId === id)).toEqual([]);
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(found);
  // the close opens on E, so the unrepaired move fails the run end (§7.1 O) — never a terminal green — and that close
  // creates no verification checkout and writes no verdict-store entry
  expect(r.summary.tipVerify).toBe("failed");
  expect(closeTrail(fx.repo)).toEqual([]);
  noDaemonCheckout(fx);
  return park.data.reason as string;
}

/** The backticked commands of a printed repair, run verbatim with `sh -c` from the repository root, stopping at the first that fails. */
function runRepair(repo: string, reason: string): { ran: number; status: number } {
  const commands = [...reason.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  let ran = 0;
  for (const command of commands) {
    ran++;
    const r = spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) return { ran, status: r.status ?? -1 };
  }
  return { ran, status: 0 };
}

test("test: through the production daemon a worker that moves the ref to a foreign commit or makes it symbolic to main or to a missing ref or deletes it or writes non-object-id bytes before the merge or moves it after the first publish parks infra with the matching leg and no merge row and the ref as found and each printed repair run verbatim restores it regular at the published tip preserving the found value with main and its reflog untouched and refuses a stale or symbolic found ref and repeats cleanly versus two dependent unmoved tasks publishing each merge row with its own commit and from (P-F1 F2 F3 F5 F8 F14 F18 F19 F20 F21 P-P1)", async () => {
  // P-P1: two dependent tasks, no move — each merge row names its own commit (the ref right after it) and the E it left.
  const p1 = fixture("run-p-p1", [T("T1"), T("T2", { deps: ["T1"] })], () => ({ T1: [work("one")], T2: [work("two")] }));
  const r1 = await run(p1);
  expect(r1.summary.done).toEqual(["T1", "T2"]);
  const [m1, m2] = merges(r1.events);
  expect(m1!.data).toMatchObject({ branch: `${p1.branch}--T1`, from: p1.base });
  expect(m2!.data).toMatchObject({ branch: `${p1.branch}--T2`, from: m1!.data.commit });
  expect(sh(`git reflog show --format=%H refs/heads/${p1.branch}`, p1.repo).split("\n")).toEqual([m2!.data.commit, m1!.data.commit, p1.base]);
  expect(sh(`git rev-parse ${m2!.data.commit}^2^`, p1.repo)).toBe(m1!.data.commit); // the second task's base is the first's M
  expect(r1.events.find((e) => e.event === "run-start")!.data.integrationAnchor).toBe("journal");
  noDaemonCheckout(p1);

  // P-F1 / F5 / F18 / F19 / F20 / F21: T1's worker moves the ref to F; T2 (after T1) moves it to F again after the first publish.
  // A tip command is configured, so a close holding its identity with a done task would write tip verdicts (store bait).
  const fx = fixture("run-p-f1", [T("T1"), T("T2", { deps: ["T1"] })], ({ branch, foreign }) => ({
    T1: [work("one", `git update-ref refs/heads/${branch} ${foreign}`)],
    T2: [work("two", `git update-ref refs/heads/${branch} ${foreign}`)],
  }), { cfg: TIP_GATE });
  const main = mainState(fx.repo);
  const found = `refs/tickmarkr/found/${fx.runId}/${fx.foreign}`;
  const first = await run(fx);
  const reason = expectMovedPark(fx, first, "T1", "value", `loose:${fx.foreign}`);
  expect(first.summary.blocked).toEqual(["T2"]);
  expect(reason).toContain(`found ${fx.foreign.slice(0, 12)} — repair: `);
  // P-F20: a found ref already holding another commit stops the sequence before the restore.
  sh(`git update-ref ${found} ${fx.other}`, fx.repo);
  expect(runRepair(fx.repo, reason)).toEqual({ ran: 2, status: 128 }); // the create-only preservation refuses
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${fx.foreign}`);
  expect(sh(`git rev-parse ${found}`, fx.repo)).toBe(fx.other);
  sh(`git update-ref -d ${found}`, fx.repo);
  // P-F21: a SYMBOLIC found ref (aimed at the integration branch, resolving to F) is refused by the first command.
  sh(`git symbolic-ref ${found} refs/heads/${fx.branch}`, fx.repo);
  expect(runRepair(fx.repo, reason)).toEqual({ ran: 1, status: 1 });
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${fx.foreign}`);
  expect(refState(fx.repo, found)).toBe(`symbolic:refs/heads/${fx.branch}`);
  sh(`git symbolic-ref --delete ${found}`, fx.repo);
  // P-F18: the ref moves again before the repair runs — the restore exits 128 and writes nothing.
  sh(`git update-ref refs/heads/${fx.branch} ${fx.other}`, fx.repo);
  expect(runRepair(fx.repo, reason)).toEqual({ ran: 3, status: 128 });
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${fx.other}`);
  sh(`git update-ref refs/heads/${fx.branch} ${fx.foreign}`, fx.repo);
  // P-F1: the printed repair, run verbatim (again: it repeats cleanly over its own preserved found ref).
  expect(runRepair(fx.repo, reason)).toEqual({ ran: 3, status: 0 });
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${fx.base}`);
  expect(sh(`git rev-parse ${found}`, fx.repo)).toBe(fx.foreign);
  expect(mainState(fx.repo)).toEqual(main);
  // after approve --recheck the merge publishes from E; T2 then moves the ref after that first publish (P-F5)
  await approve([fx.runId, "T1", "--recheck", "--by", "op"], fx.repo);
  const second = await run(fx, true);
  const published = merges(second.events).filter((e) => e.taskId === "T1");
  expect(published).toHaveLength(1);
  expect(published[0]!.data.from).toBe(fx.base);
  const m = published[0]!.data.commit as string;
  const reason2 = expectMovedPark(fx, second, "T2", "value", `loose:${fx.foreign}`, { expected: m });
  expect(second.summary.done).toEqual(["T1"]); // the first merge stands
  // P-F19: the same F again — the preservation accepts the existing found ref (it equals F) and the restore completes.
  expect(runRepair(fx.repo, reason2)).toEqual({ ran: 3, status: 0 });
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${m}`);
  expect(sh(`git rev-parse ${found}`, fx.repo)).toBe(fx.foreign);
  expect(mainState(fx.repo)).toEqual(main);

  // P-F2: symbolic to main — the repair makes the ref regular at E, preserving main's commit, main and its reflog untouched.
  const f2 = fixture("run-p-f2", [T("T1")], ({ branch }) => ({ T1: [work("one", `git symbolic-ref refs/heads/${branch} refs/heads/main`)] }));
  const main2 = mainState(f2.repo);
  const r2 = await run(f2);
  const reasonF2 = expectMovedPark(f2, r2, "T1", "symbolic", "symbolic:refs/heads/main");
  expect(parkOf(r2.events, "T1").data.integrationMoved).toMatchObject({ target: "refs/heads/main", found: main2.head });
  expect(runRepair(f2.repo, reasonF2)).toEqual({ ran: 3, status: 0 });
  expect(refState(f2.repo, `refs/heads/${f2.branch}`)).toBe(`loose:${f2.base}`);
  expect(sh(`git rev-parse refs/tickmarkr/found/${f2.runId}/${main2.head}`, f2.repo)).toBe(main2.head);
  expect(mainState(f2.repo)).toEqual(main2);

  // P-F3: symbolic to a missing ref — found none; the reason names the target and prints NO command, so a stale run of it
  // after the ref is retargeted to a branch at F runs nothing.
  const f3 = fixture("run-p-f3", [T("T1")], ({ branch }) => ({ T1: [work("one", `git symbolic-ref refs/heads/${branch} refs/heads/nope`)] }));
  const main3 = mainState(f3.repo);
  const r3 = await run(f3);
  const reasonF3 = expectMovedPark(f3, r3, "T1", "symbolic", "symbolic:refs/heads/nope");
  expect(parkOf(r3.events, "T1").data.integrationMoved).toMatchObject({ found: null, target: "refs/heads/nope" });
  expect(reasonF3).toContain("symbolic to refs/heads/nope, which names no commit");
  sh(`git symbolic-ref refs/heads/${f3.branch} refs/heads/foreign`, f3.repo);
  expect(runRepair(f3.repo, reasonF3)).toEqual({ ran: 0, status: 0 });
  expect(refState(f3.repo, `refs/heads/${f3.branch}`)).toBe("symbolic:refs/heads/foreign");
  expect(sh("git rev-parse refs/heads/foreign", f3.repo)).toBe(f3.foreign);
  expect(sh(`git for-each-ref refs/tickmarkr/found/`, f3.repo)).toBe("");
  expect(mainState(f3.repo)).toEqual(main3);

  // P-F8: deleted — PARK missing; the create-only repair restores the ref regular at E.
  const f8 = fixture("run-p-f8", [T("T1")], ({ branch }) => ({ T1: [work("one", `git update-ref -d refs/heads/${branch}`)] }));
  const r8 = await run(f8);
  const reasonF8 = expectMovedPark(f8, r8, "T1", "missing", "missing");
  expect(reasonF8).toContain(`\`git update-ref --no-deref refs/heads/${f8.branch} ${f8.base} ""\``);
  expect(runRepair(f8.repo, reasonF8)).toEqual({ ran: 1, status: 0 });
  expect(refState(f8.repo, `refs/heads/${f8.branch}`)).toBe(`loose:${f8.base}`);

  // P-F14: the loose file holds non-object-id bytes — PARK unreadable; the reason prints no repair command.
  const f14 = fixture("run-p-f14", [T("T1")], ({ branch }) => ({
    T1: [work("one", `printf 'garbage\\n' > "$(git rev-parse --git-common-dir)/refs/heads/${branch}"`)],
  }));
  const r14 = await run(f14);
  const reasonF14 = expectMovedPark(f14, r14, "T1", "unreadable", "loose:garbage");
  expect([...reasonF14.matchAll(/`/g)]).toEqual([]);
  expect(reasonF14).toContain(`restore it to ${f14.base} by hand`);
}, 300_000);

/** mergeTask's test-only seam, active under runDaemon: the daemon's own call passes through with `hook` for `task`. */
function seam(task: string, hook: merge.MergeSeam): void {
  vi.spyOn(merge, "mergeTask").mockImplementation((...a: Parameters<typeof merge.mergeTask>) =>
    realMerge(a[0], a[1], a[2], a[3], a[4], a[5], a[2].endsWith(`--${task}`) ? hook : undefined));
}
const integrationFailures = (events: JournalEvent[]) => events.filter((e) => e.event === "tip-verify-failed" && e.data.gate === "integration");

/**
 * PARK infra by step: T0 publishes first (E = its merge), then T1's step fails — nothing published, no merge row for T1,
 * the ref still regular at E, so the close holds its identity: the only verdict-store entries are its own for E's tree.
 */
async function infraPark(runId: string, hook: (fx: Fixture) => merge.MergeSeam, step: string): Promise<{ fx: Fixture; reason: string }> {
  const fx = fixture(runId, [T("T0"), T("T1", { deps: ["T0"] })], () => ({ T0: [work("zero")], T1: [work("one")] }), { cfg: TIP_GATE });
  seam("T1", hook(fx));
  const r = await run(fx);
  const park = parkOf(r.events, "T1");
  expect(r.summary).toMatchObject({ done: ["T0"], human: ["T1"] });
  expect(park.data.kind).toBe("infra");
  expect(park.data.reason).toMatch(new RegExp(`^merge publication failed \\(${step}\\): \\S`));
  const published = merges(r.events);
  expect(published.map((e) => e.taskId)).toEqual(["T0"]);
  const e = published[0]!.data.commit as string;
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${e}`);
  expect(integrationFailures(r.events)).toEqual([]);
  const trees = closeTrail(fx.repo);
  expect(trees.length).toBeGreaterThan(0);
  expect(new Set(trees)).toEqual(new Set([sh(`git rev-parse ${e}^{tree}`, fx.repo)]));
  noDaemonCheckout(fx);
  return { fx, reason: park.data.reason as string };
}

test("test: through the production daemon with the merge seam active a ref moved after construction parks the task in the human bucket with its publish-stage park journaled, the merge unreferenced and the ref and stored tip unchanged, and a ref made symbolic to main there becomes a regular ref at the merge with main untouched, while merge-tree, commit-tree, the ancestry check and a held ref lock each park infra by step writing nothing versus the unmoved publication whose callback advances the stored tip only after it lands (P-F4 F11 F12 F13 F17 P-P5 P2)", async () => {
  // P-F4: the ref moves to F between commit-tree and the compare-and-swap.
  const f4 = fixture("run-p-f4", [T("T1")], () => ({ T1: [work("one")] }));
  seam("T1", (step) => { if (step === "publish") sh(`git update-ref refs/heads/${f4.branch} ${f4.foreign}`, f4.repo); });
  const r4 = await run(f4);
  expectMovedPark(f4, r4, "T1", "value", `loose:${f4.foreign}`, { stage: "publish" });
  expect(sh("git log --all --merges --format=%H", f4.repo)).toBe(""); // M was built and no ref names it
  // the stored tip did not move: run end still expects E
  expect(integrationFailures(r4.events).at(-1)!.data.integration).toMatchObject({ expected: f4.base, found: f4.foreign, leg: "value" });
  vi.restoreAllMocks();

  // P-F11, F12, F17: a step's git fails — PARK infra by step, nothing published.
  await infraPark("run-p-f11", () => (step) => step === "merge-tree" ? { code: 128, stdout: "", stderr: "fatal: merge-tree failed" } : undefined, "merge-tree");
  vi.restoreAllMocks();
  await infraPark("run-p-f12", () => (step) => step === "commit-tree" ? { code: 1, stdout: "", stderr: "error: commit-tree refused" } : undefined, "commit-tree");
  vi.restoreAllMocks();
  await infraPark("run-p-f17", () => (step) => step === "ancestry" ? { code: 128, stdout: "", stderr: "fatal: bad object" } : undefined, "ancestry");
  vi.restoreAllMocks();
  // P-F13: a held ref lock (files backend) — the compare-and-swap fails while the ref still holds E: PARK infra publish,
  // the lock left as found.
  let lock = "";
  const f13 = await infraPark("run-p-f13", (fx) => (step) => {
    if (step !== "publish") return;
    lock = join(fx.repo, ".git", "refs", "heads", "tickmarkr", "run-p-f13.lock");
    writeFileSync(lock, "held\n");
  }, "publish");
  expect(f13.reason).toContain(".lock");
  expect(readFileSync(lock, "utf8")).toBe("held\n");
  vi.restoreAllMocks();

  // P-P5: the ref is made symbolic to main at E after the identity check — the no-deref publication rewrites it regular at M.
  const p5 = fixture("run-p-p5", [T("T1")], () => ({ T1: [work("one")] }));
  const main5 = mainState(p5.repo);
  seam("T1", (step) => { if (step === "ancestry") sh(`git symbolic-ref refs/heads/${p5.branch} refs/heads/main`, p5.repo); });
  const r5 = await run(p5);
  expect(r5.summary.done).toEqual(["T1"]);
  const m5 = merges(r5.events)[0]!.data;
  expect(m5).toMatchObject({ from: p5.base });
  expect(refState(p5.repo, `refs/heads/${p5.branch}`)).toBe(`loose:${m5.commit}`);
  expect(mainState(p5.repo)).toEqual(main5);
  vi.restoreAllMocks();

  // P-P2: the publication pauses between commit-tree and the compare-and-swap; a sibling dispatched during the pause gets
  // base E, never M, and the stored tip advances only once the publication lands.
  const p2 = fixture("run-p-p2", [T("T1"), T("T2", { humanGate: true })], () => ({ T1: [work("one")], T2: [work("two")] }), { cfg: "concurrency: 2\n" });
  const rows = () => Journal.open(p2.repo, p2.runId).read();
  seam("T1", async (step) => {
    if (step !== "publish") return;
    await approve([p2.runId, "T2", "--by", "op"], p2.repo);
    await until("T2's dispatch", () => rows().some((e) => e.event === "task-dispatch" && e.taskId === "T2"));
    expect(merges(rows())).toEqual([]); // nothing published yet: no merge row and the ref still at E
    expect(refState(p2.repo, `refs/heads/${p2.branch}`)).toBe(`loose:${p2.base}`);
  });
  const r2 = await run(p2);
  expect(r2.summary.done).toEqual(["T1", "T2"]);
  const [a, b] = merges(r2.events);
  expect(a!.data).toMatchObject({ branch: `${p2.branch}--T1`, from: p2.base });
  expect(b!.data).toMatchObject({ branch: `${p2.branch}--T2`, from: a!.data.commit });
  expect(sh(`git rev-parse ${b!.data.commit}^2^`, p2.repo)).toBe(p2.base); // the sibling's base was E, never M
  expect(refState(p2.repo, `refs/heads/${p2.branch}`)).toBe(`loose:${b!.data.commit}`);
}, 300_000);

test("test: through the production daemon at concurrency two each merge row names its own published commit in publication order with each task-done immediately before its merge and a delayed author fold cannot reorder them and a sibling dispatched during a paused merge or after a foreign move takes the published tip as its base and a worker's ungated commit pushed onto the ref is carried and gated never counted present versus the same tasks at concurrency one (P-P3 P4 F6 F7)", async () => {
  const doneBeforeMerge = (events: JournalEvent[]) => {
    for (const m of merges(events)) expect(events[events.indexOf(m) - 1]).toMatchObject({ event: "task-done", taskId: m.taskId });
  };
  const ordered = (fx: Fixture, events: JournalEvent[]) => {
    const rows = merges(events);
    expect(rows.map((m) => m.data.from)).toEqual([fx.base, ...rows.slice(0, -1).map((m) => m.data.commit)]);
    expect(sh(`git reflog show --format=%H refs/heads/${fx.branch}`, fx.repo).split("\n").reverse().slice(1))
      .toEqual(rows.map((m) => m.data.commit));
    doneBeforeMerge(events);
  };
  // P-P3 versus the same tasks at concurrency one.
  for (const concurrency of [2, 1]) {
    const fx = fixture(`run-p-p3-c${concurrency}`, [T("T1"), T("T2")], () => ({ T1: [work("one")], T2: [work("two")] }), { cfg: `concurrency: ${concurrency}\n` });
    const r = await run(fx);
    expect(r.summary.done).toEqual(["T1", "T2"]);
    expect(merges(r.events)).toHaveLength(2);
    ordered(fx, r.events);
  }

  // P-P4: A's author fold is delayed (before A enters the serializer) while B publishes and journals; then A publishes.
  const p4 = fixture("run-p-p4", [T("T1"), T("T2")], () => ({ T1: [work("one")], T2: [work("two")] }), { cfg: "concurrency: 2\n" });
  let delayed = false;
  vi.spyOn(git, "shGit").mockImplementation(async (...a: Parameters<typeof git.shGit>) => {
    if (!delayed && a[0].startsWith("git show --format= --binary") && a[1].endsWith("--T1")) {
      delayed = true;
      await until("B's merge", () => merges(Journal.open(p4.repo, p4.runId).read()).some((e) => e.taskId === "T2"));
    }
    return realShGit(...a);
  });
  const r4 = await run(p4);
  vi.restoreAllMocks();
  expect(delayed).toBe(true);
  const [b4, a4] = merges(r4.events);
  expect(b4!.taskId).toBe("T2");
  expect(a4!.taskId).toBe("T1");
  ordered(p4, r4.events);
  // the run stops and resumes: its anchor is the newest merge row, the ref, and it resumes
  const again = await run(p4, true);
  expect(again.events.at(-1)!.event).toBe("run-end");
  expect(merges(again.events)).toEqual(merges(r4.events));
  expect(refState(p4.repo, `refs/heads/${p4.branch}`)).toBe(`loose:${a4!.data.commit}`);

  // P-F6: A pauses at the seam; a foreign move to F; B dispatches during the pause; both park until A's repair; then both publish.
  const f6 = fixture("run-p-f6", [T("T1"), T("T2", { humanGate: true })], () => ({ T1: [work("one")], T2: [work("two")] }), { cfg: "concurrency: 2\n" });
  const rows6 = () => Journal.open(f6.repo, f6.runId).read();
  let paused = false;
  seam("T1", async (step) => {
    if (step !== "publish" || paused) return;
    paused = true;
    sh(`git update-ref refs/heads/${f6.branch} ${f6.foreign}`, f6.repo);
    await approve([f6.runId, "T2", "--by", "op"], f6.repo);
    await until("T2's dispatch", () => rows6().some((e) => e.event === "task-dispatch" && e.taskId === "T2"));
  });
  const r6 = await run(f6);
  const reasonA = expectMovedPark(f6, r6, "T1", "value", `loose:${f6.foreign}`, { stage: "publish" });
  expectMovedPark(f6, r6, "T2", "value", `loose:${f6.foreign}`);
  const gatedB = sh(`git rev-parse refs/heads/${f6.branch}--T2`, f6.repo);
  expect(sh(`git rev-parse ${gatedB}^`, f6.repo)).toBe(f6.base); // B's base is E, never F
  expect(runRepair(f6.repo, reasonA)).toEqual({ ran: 3, status: 0 });
  await approve([f6.runId, "T1", "--recheck", "--by", "op"], f6.repo);
  await approve([f6.runId, "T2", "--recheck", "--by", "op"], f6.repo);
  const r6b = await run(f6, true);
  expect(r6b.summary.done).toEqual(["T1", "T2"]);
  expect(merges(r6b.events).map((m) => m.data.from)).toEqual([f6.base, merges(r6b.events)[0]!.data.commit]);
  expect(tryGit(["merge-base", "--is-ancestor", f6.foreign, `refs/heads/${f6.branch}`], f6.repo).status).toBe(1);
  vi.restoreAllMocks();

  // P-F7: a worker pushes its own ungated commit onto the ref (and its lint is red, so a repair is funded in-run); the
  // repair's base is E, the commit is carried (never counted present) and gated, and the merge parks value until repaired.
  const f7 = fixture("run-p-f7", [T("T1")], ({ branch }) => ({ T1: [
    { shell: `echo bad > bad.txt && ${COMMIT} one && git update-ref refs/heads/${branch} HEAD`, result: { ok: true, summary: "one" } },
    { shell: `git rm -q bad.txt && echo two > two.txt && ${COMMIT} two`, result: { ok: true, summary: "two" } },
  ] }), { cfg: "gates: { lint: \"test ! -f bad.txt\" }\n", consult: "retry" });
  const r7 = await run(f7);
  const pushed = sh(`git rev-parse refs/heads/${f7.branch}`, f7.repo);
  const reason7 = expectMovedPark(f7, r7, "T1", "value", `loose:${pushed}`);
  const recreation = r7.events.find((e) => e.event === "worktree-recreation" && e.taskId === "T1")!;
  // The repair's base is E: measured from the moved ref the pushed commit would already be in the base and nothing would
  // be attempted. It is carried and never counted present — by classification, not by object id, since a cherry-pick
  // whose parent and metadata match keeps the commit's id.
  expect(recreation.data).toMatchObject({ attempted: [pushed], carried: [pushed] });
  expect(recreation.data.accounted ?? []).toEqual([]);
  const tip7 = sh(`git rev-parse refs/heads/${f7.branch}--T1`, f7.repo);
  // the gated range runs from E through the carried commit and the repair: one gated subject holds both
  expect(sh(`git log --format=%s ${f7.base}..${tip7}`, f7.repo).split("\n")).toEqual(["two", "one"]);
  const lint7 = r7.events.filter((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "lint");
  expect(lint7.map((e) => e.data.pass)).toEqual([false, true]); // the pushed content was gated red, the repair green
  expect(runRepair(f7.repo, reason7)).toEqual({ ran: 3, status: 0 });
  await approve([f7.runId, "T1", "--recheck", "--by", "op"], f7.repo);
  const r7b = await run(f7, true);
  expect(r7b.summary.done).toEqual(["T1"]);
  const m7 = merges(r7b.events)[0]!.data;
  expect(m7).toMatchObject({ from: f7.base });
  // published only a gated tip that carries it (the recheck re-carries both commits onto E)
  expect(sh(`git log --format=%s ${f7.base}..${m7.commit}^2`, f7.repo).split("\n")).toEqual(["two", "one"]);
}, 600_000);

test("test: through the production daemon no checkout of the integration branch is created and a 2.8.0-style checkout detached at the tip or retargeted to main neither takes the merge nor is removed by a green close with main and its reflog untouched and a fresh run whose branch exists ends fatally leaving it untouched and an in-run move before run end fails the close value and an unmarked journal with no merge row whose branch was never created resumes with it created at its base versus the same journal holding a merge row with the branch missing refusing (P-P6 P7 P11 F9 F10)", async () => {
  // P-P6 / P7 / P11: a resumed 2.8.0 run with a legacy checkout detached at E and another whose HEAD is symbolic to main.
  const fx = fixture("run-p-p6", [T("T1"), T("T2", { humanGate: true })], () => ({ T1: [work("one")], T2: [work("two")] }));
  const first = await run(fx);
  expect(first.summary.done).toEqual(["T1"]);
  noDaemonCheckout(fx);
  const e1 = sh(`git rev-parse refs/heads/${fx.branch}`, fx.repo);
  const legacy = git.worktreePath(fx.repo, fx.branch);
  const retargeted = join(makeTestTempDir("tickmarkr-legacy-main-"), "view");
  sh(`git worktree add -q --detach ${legacy} ${e1}`, fx.repo);
  sh(`git worktree add -q --detach ${retargeted} ${e1}`, fx.repo);
  sh("git symbolic-ref HEAD refs/heads/main", retargeted);
  const main = mainState(fx.repo);
  await approve([fx.runId, "T2", "--by", "op"], fx.repo);
  const second = await run(fx, true);
  expect(second.summary).toMatchObject({ done: ["T1", "T2"], human: [], failed: [], blocked: [], pending: [] });
  expect(second.summary.tipVerify).not.toBe("failed");
  const m2 = merges(second.events).at(-1)!.data;
  expect(m2).toMatchObject({ from: e1 });
  expect(refState(fx.repo, `refs/heads/${fx.branch}`)).toBe(`loose:${m2.commit}`);
  expect(sh("git rev-parse HEAD", legacy)).toBe(e1); // neither read, written nor removed
  expect(tryGit(["symbolic-ref", "-q", "HEAD"], legacy).status).toBe(1);
  expect(sh("git symbolic-ref HEAD", retargeted)).toBe("refs/heads/main");
  expect(existsSync(legacy) && existsSync(retargeted)).toBe(true); // a green close removes no legacy checkout
  expect(mainState(fx.repo)).toEqual(main);

  // P-F9: a fresh run whose integration branch already exists ends fatally, leaving it untouched.
  const f9 = fixture("run-p-f9", [T("T1")], () => ({ T1: [work("one")] }));
  sh(`git branch ${f9.branch} ${f9.other}`, f9.repo);
  const driver = new SubprocessDriver();
  driver.notify = async () => {};
  await expect(runDaemon(f9.repo, { adapters: [f9.fake], driver, runId: f9.runId, approvalWindowMs: 0 }))
    .rejects.toThrow(`integration branch ${f9.branch} already exists or cannot be created: `);
  const rows9 = Journal.open(f9.repo, f9.runId).read();
  expect(rows9.at(-1)).toMatchObject({ event: "run-end", data: { fatal: true } });
  expect(String(rows9.at(-1)!.data.error)).toContain(f9.branch);
  expect(merges(rows9)).toEqual([]);
  expect(refState(f9.repo, `refs/heads/${f9.branch}`)).toBe(`loose:${f9.other}`);

  // P-F10: an in-run move before run end, by a worker that merges nothing — §7.1 FAIL value at E.
  const f10 = fixture("run-p-f10", [T("T1"), T("T2", { deps: ["T1"] })], ({ branch, foreign }) => ({
    T1: [work("one")], T2: [{ shell: `git update-ref refs/heads/${branch} ${foreign}`, result: { ok: false, summary: "spoiled" } }],
  }));
  const r10 = await run(f10);
  expect(r10.summary.done).toEqual(["T1"]);
  expect(r10.summary.tipVerify).toBe("failed");
  expect(integrationFailures(r10.events).at(-1)!.data.integration)
    .toMatchObject({ leg: "value", expected: merges(r10.events)[0]!.data.commit, found: f10.foreign });

  // An unmarked journal with no merge row whose branch was never created resumes with it created at its base; the same
  // journal holding a merge row, or with the ref symbolic to main, refuses and journals nothing — not even the rows a
  // dead owner's lock (exit-cause, lock-reclaimed) or an unbound approval (approval-refused) would otherwise add first.
  for (const shape of ["created", "merged-missing", "symbolic"] as const) {
    const s = fixture(`run-unmarked-${shape}`, [T("T1", { humanGate: true })], () => ({}));
    const journal = Journal.create(s.repo, s.runId);
    journal.append("run-start", undefined, { pid: 111_111, baseRef: s.base, commands: {}, branch: s.branch, graphDefinitionHash: graphDefinitionHash(loadGraph(s.repo)) });
    if (shape === "merged-missing") journal.append("merge", "T1", { branch: `${s.branch}--T1`, commit: s.base });
    if (shape === "symbolic") sh(`git symbolic-ref refs/heads/${s.branch} refs/heads/main`, s.repo);
    journal.append("task-approved", "T1", { by: "op", via: "cli" }); // binds no park
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    const dead = spawnSync("true").pid;
    writeFileSync(join(tickmarkrDir(s.repo), "graph.lock"), JSON.stringify({ pid: dead, runId: s.runId, startedAt: Date.now() - 60_000 }));
    const before = journal.read();
    const main = mainState(s.repo);
    if (shape === "created") {
      await run(s, true);
      expect(refState(s.repo, `refs/heads/${s.branch}`)).toBe(`loose:${s.base}`);
      expect(sh(`git reflog show --format=%gs refs/heads/${s.branch}`, s.repo)).toBe("tickmarkr: run start");
      // the bait is live: an accepted resume journals the reclaimed lock and the refused approval
      const added = Journal.open(s.repo, s.runId).read().slice(before.length).map((e) => e.event);
      expect(added).toEqual(expect.arrayContaining(["exit-cause", "lock-reclaimed", "approval-refused"]));
    } else {
      await expect(runDaemon(s.repo, { adapters: [s.fake], runId: s.runId, resume: true, approvalWindowMs: 0 }))
        .rejects.toThrow(`refusing to resume ${s.runId}: integration branch ${s.branch} is ${shape === "symbolic"
          ? "symbolic to refs/heads/main" : "missing while the journal records merges"}`);
      expect(Journal.open(s.repo, s.runId).read()).toEqual(before);
      expect(refState(s.repo, `refs/heads/${s.branch}`)).toBe(shape === "symbolic" ? "symbolic:refs/heads/main" : "missing");
    }
    expect(mainState(s.repo)).toEqual(main);
  }
}, 300_000);

/**
 * P-P10's state, every row written by the production daemon: T1 publishes M1 (second parent its gated commit G) and then
 * fails — its done-telemetry write throws, so the daemon's own catch journals task-failed AFTER T1's task-done and merge
 * rows — and the independent T2 publishes M2 from M1. The daemon is killed right after T2's merge row (the journal keeps
 * that prefix: an open lifecycle). The operator then resets T1 to pending in graph.json, the release that beats a replayed
 * failed park (locked decision 12): the resume replays T1's recorded gates to the merge, its completion evidence intact.
 */
async function mergedThenReset(runId: string): Promise<{ fx: Fixture; m1: string; m2: string; gated: string }> {
  const fx = fixture(runId, [T("T1"), T("T2")], () => ({ T1: [work("one")], T2: [work("two")] }),
    { cfg: `${TIP_GATE}concurrency: 1\nvisibility:\n  keepPanes: forever\n` });
  const realTelemetry = Journal.prototype.telemetry;
  let thrown = false;
  vi.spyOn(Journal.prototype, "telemetry").mockImplementation(function (this: Journal, row) {
    if (!thrown && row.taskId === "T1" && row.outcome === "done" && row.kind !== "judge") { // the task's own done row
      thrown = true;
      throw new Error("EIO: telemetry write failed");
    }
    return realTelemetry.call(this, row);
  });
  const completed = await run(fx);
  vi.restoreAllMocks();
  expect(thrown).toBe(true);
  expect(completed.summary).toMatchObject({ done: ["T2"], failed: ["T1"] });
  const at = (event: string, id: string) => completed.events.findIndex((e) => e.event === event && e.taskId === id);
  expect(at("task-done", "T1")).toBeLessThan(at("merge", "T1"));
  expect(at("merge", "T1")).toBeLessThan(at("task-failed", "T1"));
  expect(at("task-failed", "T1")).toBeLessThan(at("merge", "T2"));
  const [m1, m2] = merges(completed.events).map((e) => e.data.commit as string);
  expect(merges(completed.events).map((e) => e.taskId)).toEqual(["T1", "T2"]);
  expect(sh(`git rev-parse ${m2}^1`, fx.repo)).toBe(m1); // the sibling published after T1's recorded merge
  const file = join(Journal.open(fx.repo, runId).dir, "journal.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  writeFileSync(file, `${lines.slice(0, at("merge", "T2") + 1).join("\n")}\n`);
  expect(Journal.open(fx.repo, runId).read()).toEqual(completed.events.slice(0, at("merge", "T2") + 1));
  saveGraph(fx.repo, setStatus(loadGraph(fx.repo), "T1", "pending"));
  return { fx, m1: m1!, m2: m2!, gated: sh(`git rev-parse ${m1}^2`, fx.repo) };
}

const SEEDED_GATES = ["build", "test", "lint", "evidence", "scope"] as const;

/**
 * A run killed after T1's gates passed on its commit G (an open lifecycle: no run-end), its status not done — no
 * task-done row stands for it and graph.json holds it pending. Its resume replays those gates (no worker: the
 * script's step would fail) and reaches the merge, where the DAEMON reads E from the ref and the task's recorded merges
 * from the journal. `land` runs after G is committed and before the resume, with the integration ref at E0 = base.
 */
async function gatedResume(runId: string, land: (fx: Fixture, journal: Journal, gated: string) => Promise<void> | void) {
  // Deterministic gates only: against E the replayed range is empty, so no semantic gate is asked to judge it.
  const fx = fixture(runId, [T("T1", { gates: [...SEEDED_GATES] })], () => ({ T1: [{ shell: "exit 99", result: { ok: false, summary: "worker must not be re-dispatched" } }] }),
    { cfg: "gates: { build: \"true\", test: \"true\", lint: \"true\" }\n" });
  const commands = { build: "true", test: "true", lint: "true" };
  expect(await merge.ensureIntegration(fx.repo, fx.branch, fx.base)).toBe(fx.base);
  const wt = await new SubprocessDriver().worktree(fx.repo, `${fx.branch}--T1`, fx.base);
  writeFileSync(join(wt, "one.txt"), "one\n");
  sh(`git add one.txt && git commit -q --no-gpg-sign -m one`, wt);
  const gated = sh("git rev-parse HEAD", wt);
  const journal = Journal.create(fx.repo, runId);
  // A 2.8.0 run's journal (P-F16's crash shape): no run-start integration anchor marker, so the resume is legacy-ref
  // (ANL-023 §7.3 R8) and reads E from the ref.
  journal.append("run-start", undefined, { pid: 111_111, baseRef: fx.base, commands, branch: fx.branch,
    graphDefinitionHash: graphDefinitionHash(loadGraph(fx.repo)) });
  journal.append("task-dispatch", "T1", { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, attempt: 0, retryMode: "fresh" });
  journal.append("worker-result", "T1", { ok: true, summary: "landed", deviations: [], finished: true, exitCode: 0 });
  journal.phaseStart("T1", "gates");
  for (const gate of SEEDED_GATES) {
    journal.append("gate-result", "T1", { gate, pass: true, details: "exit 0", verification: git.verificationProtocol(), commit: gated, attempt: 0,
      ...(gate === "test" ? { fullSuite: true } : {}) });
  }
  writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({
    commands: Object.fromEntries(Object.keys(commands).map((gate) => [gate, { exitCode: 0, fingerprints: [] }])),
  }));
  await land(fx, journal, gated);
  const reflog = sh(`git reflog show --format=%H refs/heads/${fx.branch}`, fx.repo);
  // Observation only: the daemon's own mergeTask call, its arguments and its outcome, passed through untouched.
  const spy = vi.spyOn(merge, "mergeTask");
  const r = await run(fx, true);
  expect(spy).toHaveBeenCalledTimes(1);
  const outcome = await (spy.mock.results[0]!.value as Promise<merge.MergeOutcome>);
  const after = r.events.slice(r.events.map((e) => e.event).lastIndexOf("run-resume"));
  expect(after.filter((e) => e.event === "task-dispatch")).toEqual([]); // the gates were replayed, no worker re-dispatched
  return { ...r, fx, gated, reflog, call: spy.mock.calls[0]!, outcome, after };
}

test("test: through the production daemon a replayed merged task whose recorded merge stands is done with no publication and no new merge row and its owed-check proof still maps while an equal-tip gated commit or an ancestor without a recorded merge parks already-integrated publishing nothing versus a content conflict keeping today's merge-conflict outcome and a moved task tip keeping today's regate (P-P10 F15 F16 P-P8 P9)", async () => {
  // P-P10: T1 merged (M1) and failed after it; the sibling T2 published M2 from M1; the kill; the operator's reset.
  const { fx: p10, m1, m2, gated: gated10 } = await mergedThenReset("run-p-p10");
  const reflog10 = sh(`git reflog show --format=%H refs/heads/${p10.branch}`, p10.repo);
  // Observation only: the daemon's own mergeTask call, its arguments and its outcome, passed through untouched.
  const spy10 = vi.spyOn(merge, "mergeTask");
  const r10 = await run(p10, true);
  expect(spy10).toHaveBeenCalledTimes(1);
  // no gates ran, so the daemon hands mergeTask the proven ancestor with ancestorOnly: it can never publish from here
  expect(spy10.mock.calls[0]![1]).toEqual({ branch: p10.branch, expected: m2, merged: [m1], ancestorOnly: true });
  expect(spy10.mock.calls[0]![4]).toBe(gated10); // the task's own gated commit, never a tip recreated on E
  expect(await (spy10.mock.results[0]!.value as Promise<merge.MergeOutcome>)).toEqual({ ok: true, alreadyMerged: m1 });
  vi.restoreAllMocks();
  const after10 = r10.events.slice(r10.events.map((e) => e.event).lastIndexOf("run-resume"));
  expect(after10.filter((e) => e.event === "task-dispatch" || e.event === "worktree-recreation" || e.event === "gate-result")).toEqual([]);
  expect([...r10.summary.done].sort()).toEqual(["T1", "T2"]);
  expect(r10.summary.failed).toEqual([]);
  expect(after10.filter((e) => e.event === "task-done").map((e) => e.taskId)).toEqual(["T1"]);
  expect(merges(r10.events).map((e) => e.data.commit)).toEqual([m1, m2]); // no new merge row
  // no publication: the ref and its reflog are as the resume found them, and the close held E = M2
  expect(refState(p10.repo, `refs/heads/${p10.branch}`)).toBe(`loose:${m2}`);
  expect(sh(`git reflog show --format=%H refs/heads/${p10.branch}`, p10.repo)).toBe(reflog10);
  expect(r10.summary.tipVerify).not.toBe("failed");
  expect(integrationFailures(r10.events)).toEqual([]);
  expect(new Set(closeTrail(p10.repo))).toEqual(new Set([sh(`git rev-parse ${m2}^{tree}`, p10.repo)]));
  // the owed-check proof still maps on the recorded merge (an obligation over T1's gated range E0..G)
  const owed = { id: "owed-T1-review", taskId: "T1", base: p10.base, head: gated10,
    patch: rangePatch(p10.repo, p10.base, gated10), patches: rangePatches(p10.repo, p10.base, gated10) } as OwedCheck;
  expect(integrationMapped(p10.repo, r10.events, owed, p10.base, m1)).toBe(true);

  // The bypass needs a SUCCESSFUL ancestry proof: the same reset with a newer task commit N (not in E) and the replay's
  // history read failing (it answers no commits) never skips the gates — nothing is published and N never reaches the ref.
  const { fx: n10, m1: n1, m2: e10 } = await mergedThenReset("run-p-p10-read");
  const taskWt = git.worktreePath(n10.repo, `${n10.branch}--T1`);
  sh(`echo newer > newer.txt && ${COMMIT} newer`, taskWt);
  const newer = sh("git rev-parse HEAD", taskWt);
  const reflogN = sh(`git reflog show --format=%H refs/heads/${n10.branch}`, n10.repo);
  let failedRead = false;
  vi.spyOn(git, "shGit").mockImplementation(async (...a: Parameters<typeof git.shGit>) => {
    if (!failedRead && a[0].startsWith("git log --reverse --format=%H ") && a[0].includes(e10) && a[0].includes(newer)) {
      failedRead = true;
      return { code: 128, stdout: "", stderr: "fatal: injected history read failure" };
    }
    return realShGit(...a);
  });
  const spyN = vi.spyOn(merge, "mergeTask"); // observation only
  const rN = await run(n10, true);
  const handed = spyN.mock.calls.map((c) => [c[1].ancestorOnly, c[4]]);
  vi.restoreAllMocks();
  expect(failedRead).toBe(true);
  expect(handed.filter(([, gated]) => gated === newer)).toEqual([]);
  expect(handed.filter(([ancestorOnly]) => ancestorOnly)).toEqual([]);
  expect(rN.summary.done).toEqual(["T2"]);
  expect(merges(rN.events).map((e) => e.data.commit)).toEqual([n1, e10]);
  expect(refState(n10.repo, `refs/heads/${n10.branch}`)).toBe(`loose:${e10}`);
  expect(sh(`git reflog show --format=%H refs/heads/${n10.branch}`, n10.repo)).toBe(reflogN);
  expect(tryGit(["merge-base", "--is-ancestor", newer, `refs/heads/${n10.branch}`], n10.repo).status).toBe(1);

  // P-F15: equal tip — the worker resets its own task branch onto the published tip E and its gates pass (the gate seam
  // answers every declared gate green): the daemon hands mergeTask E itself as the gated commit — already integrated.
  const f15 = fixture("run-p-f15", [T("T1")], () => ({ T1: [work("one", "git reset -q --hard HEAD~1")] }));
  vi.spyOn(gateRunner, "runGates").mockImplementation(async (task) =>
    ({ results: task.gates.map((gate) => ({ gate, pass: true, details: "seam" })), commits: [] }));
  const spy15 = vi.spyOn(merge, "mergeTask"); // observation only: the daemon's arguments pass through untouched
  const r15 = await run(f15);
  expect(spy15.mock.calls.map((c) => [c[1], c[4]])).toEqual([[{ branch: f15.branch, expected: f15.base, merged: [] }, f15.base]]);
  vi.restoreAllMocks();
  const park15 = parkOf(r15.events, "T1");
  expect(park15.data.kind).toBe("infra");
  expect(park15.data.reason).toBe(`gated commit ${f15.base.slice(0, 12)} is already in the integration history at ${f15.base.slice(0, 12)}`
    + " without this task's recorded merge — nothing was published; inspect the task branch, then approve a recheck");
  expect(merges(r15.events)).toEqual([]);
  expect(refState(f15.repo, `refs/heads/${f15.branch}`)).toBe(`loose:${f15.base}`);
  expect(closeTrail(f15.repo)).toEqual([]);
  noDaemonCheckout(f15);

  // P-F16: an ancestor without a recorded merge — a 2.8.0 crash shape: the gated commit's merge was published with
  // update-ref and no merge row was journaled; the resumed daemon reads E = that merge from the ref and finds no
  // recorded merge for T1, so it parks already-integrated and publishes nothing.
  let crashed = "";
  const f16 = await gatedResume("run-p-f16", (fx, _journal, gated) => {
    const tree = sh(`git merge-tree --write-tree ${fx.base} ${gated}`, fx.repo).split("\n")[0]!;
    crashed = sh(`git commit-tree ${tree} -p ${fx.base} -p ${gated} -m crashed`, fx.repo);
    sh(`git update-ref --no-deref refs/heads/${fx.branch} ${crashed} ${fx.base}`, fx.repo);
  });
  expect(f16.call[1]).toEqual({ branch: f16.fx.branch, expected: crashed, merged: [] });
  expect(f16.call[4]).toBe(crashed); // recreated on E carrying nothing: G is already in it
  expect(f16.outcome).toEqual({ ok: false, alreadyIntegrated: { gated: crashed, tip: crashed } });
  const park16 = parkOf(f16.events, "T1");
  expect(f16.summary.human).toEqual(["T1"]);
  expect(park16.data.kind).toBe("infra");
  expect(park16.data.reason).toBe(`gated commit ${crashed.slice(0, 12)} is already in the integration history at ${crashed.slice(0, 12)}`
    + " without this task's recorded merge — nothing was published; inspect the task branch, then approve a recheck");
  expect(merges(f16.events)).toEqual([]);
  expect(refState(f16.fx.repo, `refs/heads/${f16.fx.branch}`)).toBe(`loose:${crashed}`);
  expect(sh(`git reflog show --format=%H refs/heads/${f16.fx.branch}`, f16.fx.repo)).toBe(f16.reflog);
  expect(closeTrail(f16.fx.repo)).toEqual([]); // nothing done: the close runs no battery
  noDaemonCheckout(f16.fx);
  vi.restoreAllMocks();

  // P-P8: a content conflict keeps today's merge-conflict outcome with no ref write.
  const pair = conflictPair("run-p-p8", "T1", "T2");
  expect(await pair.violations()).toEqual([]);
  const rows8 = Journal.open(pair.repo, "run-p-p8").read();
  expect(String(rows8.find((e) => e.event === "merge-conflict")!.data.conflict)).toContain("shared.txt");
  expect(sh("git rev-parse refs/heads/tickmarkr/run-p-p8", pair.repo)).toBe(merges(rows8)[0]!.data.commit);

  // P-P9: a commit on the task's own branch after gating keeps today's tip-moved regate, first.
  const p9 = fixture("run-p-p9", [T("T1")], () => ({ T1: [work("one")] }));
  let late = "";
  vi.spyOn(merge, "mergeTask").mockImplementation((...a: Parameters<typeof merge.mergeTask>) => {
    if (!late) {
      const wt = git.worktreePath(p9.repo, a[2]);
      sh(`git commit -q --allow-empty --no-gpg-sign -m late`, wt);
      late = sh("git rev-parse HEAD", wt);
    }
    return realMerge(...a);
  });
  const r9 = await run(p9);
  expect(r9.events.find((e) => e.event === "tip-moved")!.data).toMatchObject({ branchTip: late });
  expect(r9.summary.done).toEqual(["T1"]);
  expect(sh(`git rev-parse ${merges(r9.events)[0]!.data.commit}^2`, p9.repo)).toBe(late);
}, 300_000);
