// 2.8.1 T1 (ANL-023 §7.1): run end verifies a fresh, witnessed checkout of its tip and closes on an identity check
// after the last await. Every row runs through the production daemon (runDaemon + FakeAdapter + subprocess driver).
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { getVerdictStore, type VerificationIdentity } from "../../src/gates/cache.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import * as git from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import * as locks from "../../src/run/lock.js";
import * as merge from "../../src/run/merge.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

const realAdd = git.addDetachedWorktree;
const realLink = git.linkNodeModules;
const realAcquire = locks.acquireApprovalSerialization;
const realRead = merge.readIntegrationRef;
const realCheck = merge.checkIntegrationIdentity;
const storeProto = Object.getPrototypeOf(getVerdictStore(makeTestTempDir("tickmarkr-store-proto-"))) as { set: (...a: unknown[]) => boolean };
const realSet = storeProto.set;
const realAppend = Journal.prototype.append;

/** The order of the identity reads, checkout adds, tip verdict-store writes and run-end rows of the current test. */
let order: string[] = [];
let tipAdds: string[][] = [];

beforeEach(() => {
  order = [];
  tipAdds = [];
  vi.spyOn(git, "addDetachedWorktree").mockImplementation(async (...a) => {
    if (basename(a[1]).startsWith("tip-verify-")) { tipAdds.push([a[1], a[2]]); order.push("add"); }
    return realAdd(...a);
  });
  vi.spyOn(merge, "readIntegrationRef").mockImplementation(async (...a) => { order.push("read"); return realRead(...a); });
  vi.spyOn(merge, "checkIntegrationIdentity").mockImplementation(async (...a) => { order.push("check"); return realCheck(...a); });
  vi.spyOn(storeProto, "set").mockImplementation(function (this: unknown, ...a: unknown[]) {
    const id = a[0] as VerificationIdentity | undefined;
    if (id?.scope === "tip") order.push(`set:${id.gate}`);
    return realSet.apply(this, a);
  });
  vi.spyOn(Journal.prototype, "append").mockImplementation(function (this: Journal, event, taskId, data) {
    if (event === "run-end") order.push("run-end");
    return realAppend.call(this, event, taskId, data);
  });
});
afterEach(() => vi.restoreAllMocks());

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const tryGit = (args: string[], cwd: string) => spawnSync("git", args, { cwd, encoding: "utf8" });

interface Fixture { repo: string; runId: string; branch: string; foreign: string; blob: string; mark: string; fake: ReturnType<typeof setupRepo>["fake"] }

type Tasks = "merged" | "partial" | "idle" | "spoil" | "hold-merge";
/**
 * One repository: T1 merges (except `idle`); `partial` and `hold-merge` add a human-gated T2 (which fails or merges
 * once approved); `spoil` adds T2 after T1 whose worker runs `spoil` and never merges. `tip` is the tip command body,
 * run only in a verification checkout (`tip-verify-*`) after it records that the battery ran.
 */
function fixture(runId: string, { tasks = "merged", tip = "", commands = true, spoil = "", oracle, prepare }: {
  tasks?: Tasks; tip?: string; commands?: boolean; spoil?: string; oracle?: string; prepare?: (repo: string) => void;
} = {}): Fixture {
  const branch = `tickmarkr/${runId}`;
  const mark = join(makeTestTempDir("tickmarkr-tip-mark-"), "ran");
  const script = join(makeTestTempDir("tickmarkr-tip-cmd-"), "tip.sh");
  const t1 = { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] };
  const graph = {
    merged: [T("T1")], idle: [T("T1", { humanGate: true })],
    partial: [T("T1"), T("T2", { humanGate: true })], "hold-merge": [T("T1"), T("T2", { humanGate: true })],
    spoil: [T("T1"), T("T2", { deps: ["T1"] })],
  }[tasks];
  const t2 = tasks === "hold-merge" ? [{ shell: `echo two > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }]
    : tasks === "spoil" ? [{ shell: spoil, result: { ok: false, summary: "spoiled" } }]
      : [{ shell: "true", result: { ok: false, summary: "nothing to merge" } }];
  const { repo, fake } = setupRepo(graph, {
    tasks: tasks === "idle" ? {} : { ...t1, T2: t2 }, consult: { action: "human", notes: "parked" },
  }, commands ? `gates: { lint: ${JSON.stringify(`sh ${script}`)} }\n` : "");
  const blobSha = execSync("git hash-object -w --stdin", { cwd: repo, input: "foreign\n", encoding: "utf8" }).trim();
  const tree = execSync("git mktree", { cwd: repo, input: `100644 blob ${blobSha}\tforeign.txt\n`, encoding: "utf8" }).trim();
  const foreign = sh(`git commit-tree ${tree} -p HEAD -m foreign`, repo);
  sh(`git update-ref refs/heads/foreign ${foreign}`, repo);
  writeFileSync(script, [
    `case "$(basename "$PWD")" in tip-verify-*) ;; *) exit 0 ;; esac`,
    `B=${branch}; F=${foreign}; BLOB=${blobSha}`,
    `echo ran >> ${mark}`,
    ...(oracle ? [`test "$(cat ${oracle})" = pass || exit 1`] : []),
    tip,
  ].join("\n") + "\n");
  prepare?.(repo);
  return { repo, runId, branch, foreign, blob: blobSha, mark, fake };
}

async function close(fx: Fixture, { resume = false, narrate }: { resume?: boolean; narrate?: (e: JournalEvent) => void } = {}) {
  const driver = new SubprocessDriver();
  driver.notify = async () => {};
  const [orderFrom, addsFrom] = [order.length, tipAdds.length]; // this close's own records only
  const summary = await runDaemon(fx.repo, { adapters: [fx.fake], driver, runId: fx.runId, resume, approvalWindowMs: 0, narrate });
  const events = Journal.open(fx.repo, fx.runId).read();
  return { ...fx, summary, events, order: order.slice(orderFrom), tipAdds: tipAdds.slice(addsFrom) };
}
type Close = Awaited<ReturnType<typeof close>>;

/** The test takes the run-end boundary itself while the daemon waits on it, runs `during`, then releases it. */
function holdBoundary(during: () => void | Promise<void>): void {
  vi.spyOn(locks, "acquireApprovalSerialization").mockImplementationOnce(async (root, id) => {
    const held = await realAcquire(root, id);
    const waiting = realAcquire(root, id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await during();
    held.release();
    return waiting;
  });
}

/** The ref exactly as found: symbolic target, loose bytes, packed commit or absence. */
function refState(repo: string, branch: string): string {
  const sym = tryGit(["symbolic-ref", "-q", `refs/heads/${branch}`], repo);
  if (sym.status === 0) return `symbolic:${sym.stdout.trim()}`;
  const loose = join(repo, ".git", "refs", "heads", ...branch.split("/"));
  if (existsSync(loose) && statSync(loose).isFile()) return `loose:${readFileSync(loose, "utf8").trim()}`;
  const commit = tryGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], repo);
  return commit.status === 0 ? `loose:${commit.stdout.trim()}` : "missing";
}

const lastCycle = (events: JournalEvent[]) => events.slice(events.map((e) => e.event).lastIndexOf("tip-verify-start"));
const integrationRows = (events: JournalEvent[]) => events.filter((e) => e.event === "tip-verify-failed" && e.data.gate === "integration");

function expectNoCheckoutLeft(c: Close): void {
  const parent = join(tickmarkrDir(c.repo), git.WORKTREES_DIR);
  expect(existsSync(parent) ? readdirSync(parent).filter((d) => d.startsWith("tip-verify-")) : []).toEqual([]);
  expect(sh("git worktree list --porcelain", c.repo)).not.toContain("tip-verify-");
}

/** FAIL: exactly one integration failure row with the leg after the newest start, a failed proof, no store write, no checkout. */
function expectIdentityFailure(c: Close, leg: string, found: string): JournalEvent {
  const cycle = lastCycle(c.events);
  const rows = integrationRows(cycle);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.data).toMatchObject({ cmd: "", exitCode: 1, fingerprints: [], integration: { branch: c.branch, leg } });
  expect(cycle.filter((e) => e.event === "tip-verify-failed").at(-1)).toBe(rows[0]);
  expect(c.summary.tipVerify).toBe("failed");
  expect(c.summary.tipProof).toMatchObject({ kind: "failed" });
  expect(c.events.findLast((e) => e.event === "run-end")!.data).toMatchObject({ tipVerify: "failed", tipProof: { kind: "failed" } });
  expect(c.order.filter((o) => o.startsWith("set:"))).toEqual([]);
  expect(refState(c.repo, c.branch)).toBe(found);
  expectNoCheckoutLeft(c);
  return rows[0]!;
}

function expectGreen(c: Close, { tipRows = true } = {}): void {
  expect(integrationRows(c.events)).toEqual([]);
  expect(c.summary.tipVerify).toBe(tipRows ? "passed" : undefined);
  expect(c.events.findLast((e) => e.event === "run-end")!.data.tipVerify).toBe(tipRows ? "passed" : undefined);
  // O and Z both ran on this close and Z is the last identity read before the run-end row.
  const end = c.order.lastIndexOf("run-end");
  expect(c.order.slice(0, end).filter((o) => o === "read" || o === "check").slice(-2)).toEqual(["read", "check"]);
  expectNoCheckoutLeft(c);
}

const memo = new Map<string, Promise<Close>>();
const once = (name: string, make: () => Promise<Close>): Promise<Close> => {
  if (!memo.has(name)) memo.set(name, make());
  return memo.get(name)!;
};

const tipHead = (c: Close) => sh(`git rev-parse refs/heads/${c.branch}`, c.repo);
const freshGreen = () => once("E-P1", () => close(fixture("run-e-p1")));
const valueAtZ = () => once("E-F1", () => close(fixture("run-e-f1", { tip: `git update-ref refs/heads/$B $F` })));
const symbolicAtZ = () => once("E-F6", async () => {
  const fx = fixture("run-e-f6", { tip: "git symbolic-ref refs/heads/$B refs/heads/main" });
  const main = { head: sh("git rev-parse main", fx.repo), log: sh("git reflog show --format=%H main", fx.repo) };
  const c = await close(fx);
  return { ...c, main };
});
const heldValue = () => once("E-F2", async () => {
  const fx = fixture("run-e-f2");
  holdBoundary(() => { sh(`git update-ref refs/heads/${fx.branch} ${fx.foreign}`, fx.repo); });
  return close(fx);
});
const spoiled = (name: string, spoil: (b: string) => string) => once(name, () => close(fixture(`run-${name.toLowerCase()}`, {
  tasks: "spoil", spoil: spoil(`tickmarkr/run-${name.toLowerCase()}`),
})));
const unreadableAtO = () => spoiled("E-F15", (b) => `printf 'garbage\\n' > "$(git rev-parse --git-common-dir)/refs/heads/${b}"`);
const danglingAtO = () => spoiled("E-DANGLING", (b) => `git symbolic-ref refs/heads/${b} refs/heads/nope`);

test("test: through the production daemon a ref a tip command moves or makes symbolic to main or deletes, a ref moved at the held run-end boundary after a fresh or cached cycle or with no commands and nothing merged, and a ref symbolic, missing, unreadable, naming a blob or shadowed by a descendant before the close each end with one integration failure row naming its leg, a failed tip proof, no verdict-store write and the ref as found versus unmoved fresh, cached, command-free and held-then-released closes staying green (E-F1 F2 F6 F7 F8 F10 F13 F14 F15 F20 F23 E-P1 P2 P3 P7)", async () => {
  // E-P1: unmoved, fresh cycle — rows name the expected value, the checkout is created at it and removed.
  const p1 = await freshGreen();
  expectGreen(p1);
  expect(p1.tipAdds.map(([, at]) => at)).toEqual([tipHead(p1)]);
  expect(lastCycle(p1.events)[0]!.data).toMatchObject({ tip: tipHead(p1), cached: false });

  // E-F1: a tip command moves the ref and leaves it — FAIL value at Z.
  const f1 = await valueAtZ();
  const f1Row = expectIdentityFailure(f1, "value", `loose:${f1.foreign}`);
  expect(f1Row.data.integration).toMatchObject({ found: f1.foreign, expected: lastCycle(f1.events)[0]!.data.tip });

  // E-F6: symbolic to main at Z; main and its reflog untouched.
  const f6 = await symbolicAtZ();
  expect(expectIdentityFailure(f6, "symbolic", "symbolic:refs/heads/main").data.integration).toMatchObject({ target: "refs/heads/main" });
  expect({ head: sh("git rev-parse main", f6.repo), log: sh("git reflog show --format=%H main", f6.repo) }).toEqual(f6.main);

  // E-F10: the ref deleted during the battery — FAIL missing at Z.
  const f10 = await close(fixture("run-e-f10", { tip: "git update-ref -d refs/heads/$B" }));
  expectIdentityFailure(f10, "missing", "missing");

  // E-P7 / E-F2: the test holds the boundary after a fresh cycle; nothing moves (green) or the ref moves (FAIL value).
  const p7fx = fixture("run-e-p7");
  holdBoundary(() => {});
  expectGreen(await close(p7fx));
  const f2 = await heldValue();
  expectIdentityFailure(f2, "value", `loose:${f2.foreign}`);
  expect(integrationRows(f2.events)[0]!.data.details).toContain("integration identity moved (value)");

  // E-P2 / E-F7: a cached cycle hit stays green with no checkout; a move at the held boundary after it fails value
  // with the cached rows standing before the failure row.
  const partial = fixture("run-e-p2", { tasks: "partial" });
  await close(partial);
  const p2 = await close(partial, { resume: true });
  expectGreen(p2);
  expect(p2.tipAdds).toEqual([]);
  expect(lastCycle(p2.events).map((e) => e.event)).toContain("tip-verify-cached");
  holdBoundary(() => { sh(`git update-ref refs/heads/${partial.branch} ${partial.foreign}`, partial.repo); });
  const f7 = await close(partial, { resume: true });
  expectIdentityFailure(f7, "value", `loose:${partial.foreign}`);
  expect(f7.tipAdds).toEqual([]);
  const f7Cycle = lastCycle(f7.events).map((e) => e.event);
  expect(f7Cycle.slice(0, 3)).toEqual(["tip-verify-start", "tip-verify-cached", "tip-verify"]);
  expect(f7Cycle.indexOf("tip-verify-failed")).toBeGreaterThan(f7Cycle.lastIndexOf("tip-verify"));

  // E-P3: no commands, one task done — green as today: incomplete proof, no tip rows, O and Z hold.
  const p3 = await close(fixture("run-e-p3", { commands: false }));
  expectGreen(p3, { tipRows: false });
  expect(p3.summary.tipProof).toEqual({ kind: "incomplete" });
  expect(p3.events.some((e) => e.event.startsWith("tip-verify"))).toBe(false);

  // E-F8: no commands and nothing merged; the ref moves at the held boundary — a start row with no gates, then the failure.
  const f8fx = fixture("run-e-f8", { tasks: "idle", commands: false });
  holdBoundary(() => { sh(`git update-ref refs/heads/${f8fx.branch} ${f8fx.foreign}`, f8fx.repo); });
  const f8 = await close(f8fx);
  expectIdentityFailure(f8, "value", `loose:${f8fx.foreign}`);
  expect(lastCycle(f8.events).filter((e) => e.event.startsWith("tip-verify")).map((e) => [e.event, e.data.gates ?? e.data.gate])).toEqual([["tip-verify-start", []], ["tip-verify-failed", "integration"]]);

  // E-F20: the ref names a blob at Z (its loose file written at the held boundary) — unreadable, no repair command.
  const f20fx = fixture("run-e-f20");
  holdBoundary(() => { writeFileSync(join(f20fx.repo, ".git", "refs", "heads", "tickmarkr", "run-e-f20"), `${f20fx.blob}\n`); });
  const f20 = await close(f20fx);
  expect(expectIdentityFailure(f20, "unreadable", `loose:${f20fx.blob}`).data.details).not.toContain("`");

  // E-F13 / E-F14 / E-F15 / E-F23: the ref is symbolic, missing, unreadable or shadowed by a descendant before the
  // close (a task that never merges spoils it) — FAIL at O, with no checkout and no battery command.
  const atOpen = [
    [await spoiled("E-F13", (b) => `git symbolic-ref refs/heads/${b} refs/heads/main`), "symbolic", "symbolic:refs/heads/main"],
    [await spoiled("E-F14", (b) => `git update-ref -d refs/heads/${b}`), "missing", "missing"],
    [await unreadableAtO(), "unreadable", "loose:garbage"],
    [await spoiled("E-F23", (b) => `git update-ref -d refs/heads/${b} && git update-ref refs/heads/${b}/x HEAD`), "missing", "missing"],
  ] as const;
  for (const [c, leg, found] of atOpen) {
    expect(c.summary.done).toEqual(["T1"]);
    const row = expectIdentityFailure(c, leg, found);
    expect(c.tipAdds).toEqual([]);
    expect(existsSync(c.mark)).toBe(false);
    expect(lastCycle(c.events).map((e) => e.event)).toEqual(["tip-verify-start", "tip-verify-failed", "run-end"]);
    if (leg === "unreadable") expect(row.data.details).not.toContain("`");
  }
  // E-F23: the printed create-only repair exits 128 and writes nothing; the descendant is untouched.
  const f23 = atOpen[3][0];
  const descendant = sh(`git rev-parse refs/heads/${f23.branch}/x`, f23.repo);
  const create = /`(git update-ref --no-deref [^`]+)`/.exec(String(integrationRows(f23.events)[0]!.data.details))![1]!;
  expect(spawnSync("sh", ["-c", create], { cwd: f23.repo }).status).toBe(128);
  expect(refState(f23.repo, f23.branch)).toBe("missing");
  expect(sh(`git rev-parse refs/heads/${f23.branch}/x`, f23.repo)).toBe(descendant);
}, 600_000);

test("test: through the production daemon a tip command that checks out an older commit and restores it or commits inside the verification checkout or leaves a tracked edit or stages a restored path or makes that checkout's HEAD log unreadable fails the close with leg checkout on the files backend and with reflog logging disabled versus an untracked or ignored build output and a move-and-restore of the integration ref itself and an unmoved close with reflog logging disabled or over a legacy branch with no reflog each closing green (E-F3 F4 F9 F11 F12 F22 E-P4 P5 P6 P8 P10)", async () => {
  const noLog = (repo: string) => sh("git config core.logAllRefUpdates false", repo);
  const restoreOlder = `p=$(git rev-parse HEAD); git checkout -q --detach HEAD~1 && git checkout -q --detach "$p"`;
  const checkoutDetails = (c: Close) => {
    const row = expectIdentityFailure(c, "checkout", `loose:${lastCycle(c.events)[0]!.data.tip}`);
    expect(row.data.integration).toMatchObject({ expected: lastCycle(c.events)[0]!.data.tip });
    expect(existsSync(c.mark)).toBe(true); // the battery ran; K caught what it left
    return String(row.data.details);
  };
  // E-F3 / E-F4: an older commit checked out and restored — the established HEAD log was appended, with logging on or off.
  expect(checkoutDetails(await close(fixture("run-e-f3", { tip: restoreOlder })))).toContain("HEAD reflog changed");
  expect(checkoutDetails(await close(fixture("run-e-f4", { tip: restoreOlder, prepare: noLog })))).toContain("HEAD reflog changed");
  // E-F9: a commit inside the checkout moves its HEAD (never the integration branch).
  const f9 = await close(fixture("run-e-f9", { tip: "git -c user.name=t -c user.email=t@t.local commit -q --allow-empty --no-gpg-sign -m inside" }));
  expect(checkoutDetails(f9)).toContain("HEAD moved to");
  // E-F11: a tracked edit left behind.
  expect(checkoutDetails(await close(fixture("run-e-f11", { tip: "echo changed >> base.txt" })))).toContain("tracked content:  M base.txt");
  // E-F12: the verifier's restore shape stages a path; HEAD and its reflog are unchanged.
  const f12 = checkoutDetails(await close(fixture("run-e-f12", { tip: "git restore --source $F --worktree --staged foreign.txt" })));
  expect(f12).toContain("tracked content: A  foreign.txt");
  // E-F22: the checkout's HEAD log made unreadable now reads empty with exit 0, which differs from H0.
  expect(checkoutDetails(await close(fixture("run-e-f22", { tip: `chmod 000 "$(git rev-parse --git-dir)/logs/HEAD"` })))).toContain("HEAD reflog changed");

  // E-P4: an untracked build output is allowed; that battery's store write is suppressed (the tree changed), as today.
  const p4 = await close(fixture("run-e-p4", { tip: "echo out > build-output.txt" }));
  expectGreen(p4);
  expect(p4.order.filter((o) => o.startsWith("set:"))).toEqual([]);
  // E-P5: an ignored build output.
  expectGreen(await close(fixture("run-e-p5", {
    tip: "mkdir -p ignored-out && echo out > ignored-out/a",
    prepare: (repo) => { writeFileSync(join(repo, ".gitignore"), "ignored-out/\n"); sh("git add .gitignore && git commit -q --no-gpg-sign -m ignore", repo); },
  })));
  // E-P6: a move-and-restore of the integration ref itself during the battery (declared, §8).
  expectGreen(await close(fixture("run-e-p6", { tip: `o=$(git rev-parse refs/heads/$B); git update-ref refs/heads/$B $F && git update-ref refs/heads/$B "$o"` })));
  // E-P8: unmoved with logging disabled — the `always` creation still establishes H0.
  const p8 = await close(fixture("run-e-p8", { prepare: noLog }));
  expectGreen(p8);
  expect(p8.tipAdds).toHaveLength(1);
  // E-P10: a resumed close over a legacy branch with no reflog (logging disabled): no ref reflog is read, and the
  // checkout's witness is established fresh (the first close was red at an oracle, so the resume runs a battery).
  const oracle = join(makeTestTempDir("tickmarkr-tip-oracle-"), "verdict");
  writeFileSync(oracle, "fail");
  const legacy = fixture("run-e-p10", { tasks: "partial", oracle, prepare: noLog });
  expect((await close(legacy)).summary.tipVerify).toBe("failed");
  expect(tryGit(["reflog", "show", `refs/heads/${legacy.branch}`], legacy.repo).stdout.trim()).toBe("");
  writeFileSync(oracle, "pass");
  const p10 = await close(legacy, { resume: true });
  expectGreen(p10);
  expect(p10.tipAdds).toHaveLength(1);
}, 600_000);

test("test: through the production daemon a witness read returning no line or a newest entry other than the expected commit or a nonzero exit and a failed checkout add and a dependency link that returns false each fail the close with leg witness or setup before any battery command runs and leave no verification checkout behind versus a green close that also leaves none (E-F17 F18 F19 F21 E-P1)", async () => {
  // E-P1: a green close leaves no verification checkout either.
  const p1 = await freshGreen();
  expectGreen(p1);
  expect(existsSync(p1.mark)).toBe(true);
  const before = async (name: string, seam: () => void) => {
    const fx = fixture(name);
    seam();
    const c = await close(fx);
    expect(existsSync(c.mark)).toBe(false); // no battery command ran
    expect(c.tipAdds).toHaveLength(name.startsWith("run-e-f18") ? 0 : 1);
    return c;
  };
  const witness = (lines: string[], code = 0) => () => { vi.spyOn(git, "reflogWitness").mockResolvedValueOnce({ code, lines }); };
  const f17a = await before("run-e-f17a", witness([]));
  expect(expectIdentityFailure(f17a, "witness", `loose:${tipHead(f17a)}`).data.details).toBe("verification checkout witness unavailable: no reflog");
  const f17b = await before("run-e-f17b", witness(["0".repeat(40)]));
  expect(expectIdentityFailure(f17b, "witness", `loose:${tipHead(f17b)}`).data.details).toBe(`verification checkout witness unavailable: newest is ${"0".repeat(12)}`);
  const f21 = await before("run-e-f21", witness([], 128));
  expect(expectIdentityFailure(f21, "witness", `loose:${tipHead(f21)}`).data.details).toBe("verification checkout witness unavailable: exit 128");
  // E-F18: the checkout add fails — setup (infra), whatever was created removed.
  const f18 = await before("run-e-f18", () => {
    vi.spyOn(git, "addDetachedWorktree").mockImplementationOnce(async () => ({ code: 128, stdout: "", stderr: "fatal: add refused" }));
  });
  const f18Row = expectIdentityFailure(f18, "setup", `loose:${tipHead(f18)}`);
  expect(f18Row.data).toMatchObject({ infra: true, details: "verification checkout setup failed (add: fatal: add refused)" });
  // E-F19: the dependency link returns false (its failure mode) — setup, checkout removed.
  const f19 = await before("run-e-f19", () => {
    vi.spyOn(git, "linkNodeModules").mockImplementation((repo, dir, o) => basename(dir).startsWith("tip-verify-") ? false : realLink(repo, dir, o));
  });
  expect(expectIdentityFailure(f19, "setup", `loose:${tipHead(f19)}`).data).toMatchObject({ infra: true, details: "verification checkout setup failed (node_modules link returned false)" });
}, 600_000);

test("test: through the production daemon a close held by an approval landing after the battery and a battery cancelled by an approval and a held close whose approved task then merges write no verdict-store entry from that close and remove its checkout so the next close reuses the unchanged cycle without a checkout or runs a fresh battery at the new tip versus a green close writing its deferred verdicts only after the closing check (E-P11 P12 P13)", async () => {
  // The green control: its deferred verdicts are written after the closing check and before the run-end row.
  const p1 = await freshGreen();
  const firstSet = p1.order.findIndex((o) => o.startsWith("set:"));
  expect(firstSet).toBeGreaterThan(p1.order.lastIndexOf("check"));
  expect(firstSet).toBeLessThan(p1.order.lastIndexOf("run-end"));
  expect(p1.order.lastIndexOf("check")).toBeGreaterThan(p1.order.lastIndexOf("add"));

  // Each tip verdict-store write records how many start rows were journaled when it happened (its close).
  const approveAtBoundary = (fx: Fixture, seen: { starts: number[] }) => {
    vi.spyOn(locks, "acquireApprovalSerialization").mockImplementationOnce(async (root, id) => {
      await approve([fx.runId, "T2", "--by", "test"], fx.repo);
      return realAcquire(root, id);
    });
    vi.spyOn(storeProto, "set").mockImplementation(function (this: unknown, ...a: unknown[]) {
      if ((a[0] as VerificationIdentity | undefined)?.scope === "tip") {
        seen.starts.push(Journal.open(fx.repo, fx.runId).read().filter((e) => e.event === "tip-verify-start").length);
      }
      return realSet.apply(this, a);
    });
  };

  // E-P11: held by an approval after the battery; the approved task merges nothing, so the next close reuses the cycle.
  const p11fx = fixture("run-e-p11", { tasks: "partial" });
  const p11Seen = { starts: [] as number[] };
  approveAtBoundary(p11fx, p11Seen);
  const p11 = await close(p11fx);
  expect(p11.events.filter((e) => e.event === "end-condition-held")).toHaveLength(1);
  const p11Starts = p11.events.filter((e) => e.event === "tip-verify-start");
  expect(p11Starts.map((e) => e.data.cached)).toEqual([false, true]);
  expect(p11.tipAdds).toHaveLength(1);
  expect(p11Seen.starts).toEqual([]);
  expectGreen(p11);

  // E-P12: an approval during the battery cancels it; that close writes nothing and removes its checkout; the next
  // close decides again and runs a fresh battery.
  const gate = join(makeTestTempDir("tickmarkr-tip-wait-"), "running");
  const p12fx = fixture("run-e-p12", { tasks: "partial", tip: `if ! test -e ${gate}; then echo running > ${gate}; sleep 30; fi` });
  const p12Seen = { starts: [] as number[] };
  vi.spyOn(storeProto, "set").mockImplementation(function (this: unknown, ...a: unknown[]) {
    if ((a[0] as VerificationIdentity | undefined)?.scope === "tip") {
      p12Seen.starts.push(Journal.open(p12fx.repo, p12fx.runId).read().filter((e) => e.event === "tip-verify-start").length);
    }
    return realSet.apply(this, a);
  });
  let approval: Promise<string> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    const p12 = await close(p12fx, {
      narrate: (e) => {
        if (e.event !== "tip-verify-start" || poll) return;
        poll = setInterval(() => {
          if (existsSync(gate) && !approval) approval = approve([p12fx.runId, "T2", "--by", "test"], p12fx.repo);
        }, 20);
      },
    });
    await approval;
    expect(p12.events.filter((e) => e.event === "tip-verify-cancelled")).toHaveLength(1);
    expect(p12.events.filter((e) => e.event === "tip-verify-start").map((e) => e.data.cached)).toEqual([false, false]);
    expect(p12.tipAdds).toHaveLength(2);
    expect(p12Seen.starts.length).toBeGreaterThan(0);
    expect(new Set(p12Seen.starts)).toEqual(new Set([2]));
    expectGreen(p12);
  } finally {
    if (poll) clearInterval(poll);
  }

  // E-P13: held, then the approved task merges — the held close wrote nothing and removed its checkout; the next
  // close misses the cycle, creates a fresh checkout at the new tip and closes on Z for it.
  const p13fx = fixture("run-e-p13", { tasks: "hold-merge" });
  const p13Seen = { starts: [] as number[] };
  approveAtBoundary(p13fx, p13Seen);
  const p13 = await close(p13fx);
  expect(p13.summary.done.sort()).toEqual(["T1", "T2"]);
  const starts = p13.events.filter((e) => e.event === "tip-verify-start");
  expect(starts.map((e) => e.data.cached)).toEqual([false, false]);
  expect(starts[1]!.data.tip).not.toBe(starts[0]!.data.tip);
  expect(starts[1]!.data.tip).toBe(tipHead(p13));
  expect(p13.tipAdds.map(([, at]) => at)).toEqual([starts[0]!.data.tip, starts[1]!.data.tip]);
  expect(p13Seen.starts.length).toBeGreaterThan(0);
  expect(new Set(p13Seen.starts)).toEqual(new Set([2]));
  expectGreen(p13);
}, 600_000);

test("test: through the production daemon the value leg's printed repair parsed from the failure row and run verbatim from the repository root makes a ref found regular at a foreign commit or symbolic to main regular at the expected commit and preserves the found commit and leaves main and its reflog untouched while a found ref already holding another commit or symbolic to the integration branch stops the sequence before the restore versus the unreadable and dangling legs printing no command (the §7.1 repair text; ANL-023 X12 X16 X20)", async () => {
  const repairOf = (c: Close) => {
    const row = integrationRows(c.events)[0]!;
    const details = String(row.data.details);
    return { commands: [...details.split(" — repair: ")[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!), row, details };
  };
  /** Runs the printed commands in order from the repository root, stopping at the first that fails. */
  const runRepair = (repo: string, commands: string[]) => {
    for (const [i, cmd] of commands.entries()) {
      if (spawnSync("sh", ["-c", cmd], { cwd: repo }).status !== 0) return i;
    }
    return commands.length;
  };
  const mainOf = (repo: string) => ({ head: sh("git rev-parse main", repo), log: sh("git reflog show --format=%H main", repo) });
  const keepRef = (c: Close, found: string) => `refs/tickmarkr/found/${c.runId}/${found}`;

  // A ref found regular at a foreign commit: restored regular at the expected commit, the found commit preserved.
  const f1 = await valueAtZ();
  const v = repairOf(f1);
  expect(v.commands).toHaveLength(3);
  const expected = String((v.row.data.integration as { expected: string }).expected);
  const main = mainOf(f1.repo);
  expect(runRepair(f1.repo, v.commands)).toBe(3);
  expect(refState(f1.repo, f1.branch)).toBe(`loose:${expected}`);
  expect(sh(`git rev-parse ${keepRef(f1, f1.foreign)}`, f1.repo)).toBe(f1.foreign);
  expect(mainOf(f1.repo)).toEqual(main);

  // A ref found symbolic to main: restored regular at the expected commit; main and its reflog untouched.
  const f6 = await symbolicAtZ();
  const s = repairOf(f6);
  const mainCommit = f6.main.head;
  expect(runRepair(f6.repo, s.commands)).toBe(3);
  expect(tryGit(["symbolic-ref", "-q", `refs/heads/${f6.branch}`], f6.repo).status).toBe(1);
  expect(refState(f6.repo, f6.branch)).toBe(`loose:${(s.row.data.integration as { expected: string }).expected}`);
  expect(sh(`git rev-parse ${keepRef(f6, mainCommit)}`, f6.repo)).toBe(mainCommit);
  expect(mainOf(f6.repo)).toEqual(f6.main);

  // A found ref already holding another commit stops the sequence before the restore; so does one symbolic to the
  // integration branch (it would resolve to the restored commit and preserve nothing).
  const f2 = await heldValue();
  const h = repairOf(f2);
  sh(`git update-ref ${keepRef(f2, f2.foreign)} ${mainCommitOf(f2.repo)}`, f2.repo);
  expect(runRepair(f2.repo, h.commands)).toBe(1);
  expect(refState(f2.repo, f2.branch)).toBe(`loose:${f2.foreign}`);
  sh(`git update-ref -d ${keepRef(f2, f2.foreign)}`, f2.repo);
  sh(`git symbolic-ref ${keepRef(f2, f2.foreign)} refs/heads/${f2.branch}`, f2.repo);
  expect(runRepair(f2.repo, h.commands)).toBe(0);
  expect(refState(f2.repo, f2.branch)).toBe(`loose:${f2.foreign}`);

  // The unreadable and dangling legs print no command: they name the state and say to restore by hand.
  for (const [c, state] of [[await unreadableAtO(), "is unreadable"], [await danglingAtO(), "symbolic to refs/heads/nope, which names no commit"]] as const) {
    const r = repairOf(c);
    expect(r.commands).toEqual([]);
    expect(r.details).toContain(state);
    expect(r.details).toContain(`inspect refs/heads/${c.branch} and restore it to `);
  }
  expect(integrationRows((await danglingAtO()).events)[0]!.data.integration).toMatchObject({ leg: "symbolic", found: null, target: "refs/heads/nope" });
}, 600_000);

const mainCommitOf = (repo: string) => sh("git rev-parse main", repo);
