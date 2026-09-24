import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalWorktreePath, casBoard, checkoutPrefix, checkoutProofLine, inCheckout, OrcaDriver, OrcaError, OrcaUnavailableError, PENDING_PROJECT_GRACE_MS, type OrcaExec } from "../../src/drivers/orca.js";
import { stateDirName } from "../../src/graph/graph.js";
import { herdrSealShellPrefix, SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, panesToClose, parseOwnedName, type ExecutorDriver, type Slot } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { createWorktree, worktreePath } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { readWatchBoard, observeNamedRun, supervisionBeatPath, SUPERVISION_STALE_MS, watchBoardAcknowledged, type WatchBoardOwner } from "../../src/run/supervision.js";
import { FakeOrca, steppedTime, type FakeTerminalSpec } from "../helpers/fake-orca.js";
import { COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

// v2.1 T2 — placement and ownership. Isolation is the product: a terminal in the wrong checkout has
// already lost it, and a sweep that judges by anything but the owned TAB title kills somebody else's
// window. Fixture paths go through canonicalWorktreePath so the assertions read the same spelling the
// driver does (/tmp vs /private/tmp, any symlinked parent) whether or not the path exists here.
const WT_A = canonicalWorktreePath("/tmp/orca-placement/A");
const WT_B = canonicalWorktreePath("/tmp/orca-placement/B");
const WT_GONE = canonicalWorktreePath("/tmp/orca-placement/removed-by-an-older-run");
const DAEMON_CWD = canonicalWorktreePath("/tmp/orca-placement/daemon-repo");

const RUN = "run-now";
const owned = (taskId: string, attempt: number, runId: string) =>
  formatOwnedName({ role: "worker", taskId, attempt, runId });
const TITLE_A = owned("TA", 0, RUN);
const TITLE_B = owned("TB", 0, RUN);

// OBS-1004: the fixture paths are declared as worktrees Orca TRACKS (as if Orca created them); the
// daemon-created checkout nested under a clone — answered by its ENCLOSING clone — is the subject of
// the two OBS-1004 tests below.
function rig(opts: ConstructorParameters<typeof FakeOrca>[0] = {}): { fake: FakeOrca; driver: OrcaDriver } {
  const fake = new FakeOrca({ trackedWorktrees: [WT_A, WT_B, WT_GONE, DAEMON_CWD], ...opts });
  return { fake, driver: new OrcaDriver({ exec: fake.exec, time: steppedTime() }) };
}

/** A driver that lets the APP pick the checkout: the `path:` selector is replaced by an ambient one. */
function ambientSelector(fake: FakeOrca, selector: "active" | "current", cliCwd?: string): OrcaDriver {
  return new OrcaDriver({
    time: steppedTime(),
    exec: (args, cwd, timeoutMs) => {
      const at = args.indexOf("--worktree");
      const blind = args[1] === "create" && at >= 0 ? args.map((a, i) => (i === at + 1 ? selector : a)) : args;
      return fake.exec(blind, cliCwd ?? cwd, timeoutMs);
    },
  });
}

const git = (cwd: string, cmd: string): string => execSync(`git ${cmd}`, { cwd, encoding: "utf8" }).trim();

test("test: an Orca worker terminal whose scrollback carries no complete proof frame for its checkout or a frame naming another checkout is closed and latched as infra before the worker counts as launched while a terminal proving its checkout proceeds, so a launch trusted on the create receipt alone fails", async () => {
  for (const mode of ["absent", "incomplete", "foreign", "valid"] as const) {
    const { repo, fake: adapter } = setupRepo([T("T1")], {
      tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] },
    });
    const fake = new FakeOrca({ executeCommands: mode === "valid" });
    let latched = false;
    class CapturedDriver extends OrcaDriver {
      override async run(slot: Slot, command: string): Promise<void> {
        try {
          await super.run(slot, command);
        } catch (error) {
          const creates = fake.countOf("create");
          await expect(super.run(slot, "must-not-run")).rejects.toBeInstanceOf(OrcaUnavailableError);
          expect(fake.countOf("create")).toBe(creates);
          expect(this.describe(slot)).toBeUndefined();
          latched = error instanceof OrcaUnavailableError;
          throw error;
        }
      }
    }
    const driver = new CapturedDriver({
      ...(mode === "valid" ? { pollMs: 50 } : { time: steppedTime() }),
      exec: async (args, cwd, timeout) => {
        const receipt = await fake.exec(args, cwd, timeout);
        if (args[1] === "create" && mode !== "valid") {
          fake.last()!.lines = mode === "absent" ? [] : [
            mode === "foreign" ? checkoutProofLine(repo) : checkoutProofLine(cwd).slice(0, -1),
          ];
        }
        return receipt;
      },
    });
    const runId = `run-proof-${mode}`;
    const summary = await runDaemon(repo, { adapters: [adapter], runId, driver });
    const events = Journal.open(repo, runId).read();
    if (mode === "valid") {
      expect(summary.done).toEqual(["T1"]);
      expect(events.some((event) => event.event === "worker-launch")).toBe(true);
    } else {
      expect(summary.done).toEqual([]);
      expect(events.some((event) => event.event === "worker-launch")).toBe(false);
      expect(events.some((event) => event.event === "task-failed" && event.data.kind === "dispatch")).toBe(true);
      expect(fake.countOf("close")).toBeGreaterThan(0);
      expect(latched).toBe(true);
    }
  }
}, 60_000);

/**
 * The checkout contract a tickmarkr worker is handed, as four named facts: the path the daemon
 * addresses, a real checkout there, the exact branch, at the exact base. Run against ANY driver,
 * so "tickmarkr's own createWorktree" and "delegated to orca" are judged by one battery.
 */
async function checkoutBattery(
  driver: ExecutorDriver, repo: string, branch: string, baseRef = "HEAD",
): Promise<{ dir: string; failures: string[] }> {
  const base = git(repo, `rev-parse ${baseRef}`);
  const dir = await driver.worktree(repo, branch, baseRef);
  const failures: string[] = [];
  if (dir !== worktreePath(repo, branch)) failures.push("path");
  if (realpathSync(git(dir, "rev-parse --show-toplevel")) !== realpathSync(dir)) failures.push("checkout");
  if (git(dir, "rev-parse --abbrev-ref HEAD") !== branch) failures.push("branch");
  if (git(dir, "rev-parse HEAD") !== base) failures.push("base");
  return { dir, failures };
}

/** The driver the criterion forbids: checkout creation handed to Orca's own `worktree create`.
 *  `--name` is Orca's unit (a worktree name, not a ref), and there is no path flag to pass. */
class DelegatingOrcaDriver extends OrcaDriver {
  constructor(private orca: FakeOrca) {
    super({ exec: orca.exec, time: steppedTime() });
  }

  override async worktree(repo: string, branch: string, baseRef: string): Promise<string> {
    const r = await this.orca.exec([
      "worktree", "create", "--repo", `path:${repo}`, "--name", branch.replace(/\//g, "-"), "--base-branch", baseRef, "--json",
    ], repo);
    if (r.code !== 0) throw new OrcaError("create", `orca worktree create failed (rc ${r.code})`, r.stderr || r.stdout);
    return String((JSON.parse(r.stdout) as { result: { worktree: { path: string } } }).result.worktree.path);
  }
}

describe("OrcaDriver placement, laziness and owned-title reconcile", () => {
  test("test: a project call for a task whose slot never appears is dropped after the pending grace and journaled project-unplaced at the next reconcile so a later slot for that task applies no stale status whereas a driver that parks the projection forever fails", async () => {
    const repo = makeRepo({ "pending.txt": "pending\n" });
    const runId = "run-project-unplaced";
    const midDispatchTaskId = "T-mid-dispatch";
    const neverTaskId = "T-never";
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, {});
    const fake = new FakeOrca();
    const time = steppedTime();
    const driver = new OrcaDriver({ exec: fake.exec, time });

    await driver.project(midDispatchTaskId, "in-progress");
    await driver.project(neverTaskId, "in-progress");
    const midDispatchWorktree = await driver.worktree(
      repo, `tickmarkr/${runId}--${midDispatchTaskId}`, "HEAD",
    );
    const neverWorktree = await driver.worktree(repo, `tickmarkr/${runId}--${neverTaskId}`, "HEAD");
    const desired = new Set([
      formatOwnedName({ role: "worker", taskId: midDispatchTaskId, attempt: 0, runId }),
    ]);
    await driver.reconcile(desired, runId);
    expect(Journal.open(repo, runId).read().filter((row) => row.event === "project-unplaced"))
      .toHaveLength(0);

    time.advance(PENDING_PROJECT_GRACE_MS + 1);
    await driver.reconcile(desired, runId);
    const dropped = Journal.open(repo, runId).read().filter((row) => row.event === "project-unplaced");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      taskId: neverTaskId,
      data: {
        state: "in-progress",
        pendingMs: PENDING_PROJECT_GRACE_MS + 1,
        graceMs: PENDING_PROJECT_GRACE_MS,
      },
    });

    await driver.slot(midDispatchWorktree, "legacy-mid-dispatch", {
      owned: { role: "worker", taskId: midDispatchTaskId, attempt: 0, runId },
    });
    // OBS-1004: the projection lands on the tracked CLONE enclosing the checkout, never the checkout.
    expect(fake.workspaceStatuses.get(canonicalWorktreePath(repo))).toBe("in-progress");
    expect(fake.workspaceStatuses.has(canonicalWorktreePath(midDispatchWorktree))).toBe(false);

    await driver.slot(neverWorktree, "legacy-never", {
      owned: { role: "worker", taskId: neverTaskId, attempt: 0, runId },
    });
    expect(fake.countOf("worktree-set")).toBe(1);
    expect(fake.workspaceStatuses.has(canonicalWorktreePath(neverWorktree))).toBe(false);
    await driver.reconcile(new Set(), runId);
    expect(Journal.open(repo, runId).read().filter((row) => row.event === "project-unplaced"))
      .toHaveLength(1);
  });

  // OBS-1004 (run 0004, 2026-09-12): Orca 1.4.200 tracks only the worktrees it created or the operator
  // opened; a git worktree the daemon adds under the clone is never adopted (no adopt verb), and
  // `worktree current` from inside it answers the ENCLOSING clone. The shipped 2.5.4 driver waited
  // 60 s per worker for that adoption and starved every task. The fake below reproduces the real
  // answer; the fixture that answered the task path as its own tracked worktree is gone.
  test("the Orca driver creates a worker terminal for a daemon-owned task checkout when the fake Orca answers worktree current from that checkout with the ENCLOSING tracked worktree path, issuing no worktree-set against the task checkout path and never waiting on adoption, and the created terminal's command runs in the task checkout directory; a driver that polls worktree current until the task path is reported, or that targets worktree set at the task path, fails", async () => {
    const repo = makeRepo({ "base.txt": "ready\n" }); // a clone: `.git` is a DIRECTORY, so the fake tracks it
    const clone = canonicalWorktreePath(repo);
    const runId = "run-orca-tracked";
    const branch = `tickmarkr/${runId}--TA`;
    const fake = new FakeOrca({ executeCommands: true });
    const driver = new OrcaDriver({ exec: fake.exec });
    const worktree = await driver.worktree(repo, branch, "HEAD");
    const checkout = canonicalWorktreePath(worktree);
    expect(checkout.startsWith(`${clone}/`)).toBe(true); // nested under the clone, `.git` a FILE

    await driver.project("TA", "in-progress"); // pending until the slot names its checkout
    const slot = await driver.slot(worktree, "legacy", { owned: { role: "worker", taskId: "TA", attempt: 0, runId } });
    await driver.run(slot, "pwd");

    // `worktree current` was asked FROM the checkout and answered the enclosing clone — once, and
    // the driver went straight on without polling for adoption.
    const currents = fake.calls.flatMap((call, index) => call[0] === "worktree" && call[1] === "current" ? [index] : []);
    expect(currents).toHaveLength(1);
    expect(fake.callCwds[currents[0]!]).toBe(checkout);
    // The terminal is created ON the tracked clone with the command cd'ed into the checkout, and the
    // receipt binds it to the clone; identity is the handle plus the owned tab title.
    expect(fake.calls.find((call) => call[1] === "create")).toEqual([
      "terminal", "create", "--worktree", `path:${clone}`, "--title", slot.name, "--command", inCheckout(checkout, `${herdrSealShellPrefix().split(";")[0]}; pwd`), "--json",
    ]);
    expect(fake.last()).toMatchObject({ worktree: clone, title: slot.name });
    // …and the command really ran INSIDE the checkout: the wrapper shell printed the checkout path.
    await expect.poll(() => fake.last()!.lines.at(-1), { timeout: 5_000 }).toBe(checkout);
    // The projection landed on the tracked clone; the checkout path was never a `worktree set` target.
    expect(fake.calls.filter((call) => call[0] === "worktree" && call[1] === "set")).toEqual([
      ["worktree", "set", "--worktree", `path:${clone}`, "--workspace-status", "in-progress", "--json"],
    ]);
    expect(fake.calls.some((call) => call.includes(`path:${checkout}`))).toBe(false);

    // Controls, on the fake's own contract (the real 1.4.200 answers): polling `worktree current`
    // from the checkout never reports the checkout — the adoption the shipped driver waited for cannot
    // happen — and a `worktree set` aimed at the checkout path is refused selector_not_found, exactly
    // as run 0004's T5 was.
    for (let probe = 0; probe < 3; probe++) {
      const answer = JSON.parse((await fake.exec(["worktree", "current", "--json"], checkout)).stdout) as { result: { worktree: { path: string } } };
      expect(answer.result.worktree.path).toBe(clone);
    }
    const refused = await fake.exec(["worktree", "set", "--worktree", `path:${checkout}`, "--workspace-status", "in-progress", "--json"], checkout);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "selector_not_found" } });
    // An untracked cwd — nothing Orca tracks encloses it — is an explicit driver failure, not a wait.
    const stranded = new FakeOrca({ trackedWorktrees: [WT_A] });
    const strandedDriver = new OrcaDriver({ exec: stranded.exec, time: steppedTime() });
    const strandedSlot = await strandedDriver.slot(WT_B, TITLE_B);
    const error = await strandedDriver.run(strandedSlot, "must-not-run").then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(OrcaError);
    expect((error as OrcaError).code).toBe("selector_not_found");
    expect(stranded.countOf("create")).toBe(0);
    expect(stranded.countOf("worktree-current")).toBe(1);
  });

  test("a run whose driver is orca dispatches its first worker and journals worker-launch under the fake Orca that tracks only the enclosing repository, with zero task-failed rows of kind dispatch; the fixture that answers the task checkout path as a tracked worktree is removed or marked as the non-Orca shape, so a fake that hides OBS-1004 fails", async () => {
    const runId = "run-orca-dispatch";
    const { repo, fake: adapter } = setupRepo(
      [T("T1", { files: ["ok.txt"] })],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const clone = canonicalWorktreePath(repo);
    // The fake tracks the clone only (its `.git` is a directory); the daemon's task checkout beneath
    // it is answered by the clone, and the wrapper shell really runs the worker command.
    const orca = new FakeOrca({ executeCommands: true });
    const driver = new OrcaDriver({ exec: orca.exec, pollMs: 50 });

    const summary = await runDaemon(repo, { adapters: [adapter], runId, driver });

    const rows = Journal.open(repo, runId).read();
    expect(rows.some((row) => row.event === "worker-launch" && row.taskId === "T1")).toBe(true);
    expect(rows.filter((row) => row.event === "task-failed" && row.data.kind === "dispatch")).toEqual([]);
    expect(summary.done).toContain("T1");
    // The worker terminal was created ON the tracked clone, with its command cd'ed into the checkout
    // the daemon handed the slot (the worker-launch row names it), and the command really ran there.
    const launch = rows.find((row) => row.event === "worker-launch" && row.taskId === "T1")!;
    const checkout = (launch.data.slot as { cwd: string }).cwd;
    expect(checkout.startsWith(`${clone}/`)).toBe(true);
    expect(orca.executed.map((entry) => entry.cwd)).toEqual([clone]);
    expect(orca.executed[0]!.command.startsWith(checkoutPrefix(checkout))).toBe(true);
    expect(orca.executed[0]!.exitCode).toBe(0);
    expect(orca.calls.filter((call) => call[0] === "worktree" && call[1] === "set").every((call) => call[3] === `path:${clone}`)).toBe(true);
    // The non-Orca fixture is gone: asked from the task checkout, the fake answers the clone — the
    // 1.4.200 shape — never the checkout itself, so a driver waiting for the checkout can only fail.
    const asked = JSON.parse((await orca.exec(["worktree", "current", "--json"], checkout)).stdout) as { result: { worktree: { path: string } } };
    expect(asked.result.worktree.path).toBe(clone);
  }, 60_000);

  // FX-N01 (ASTRA-v255-FIX-ORCA): under the enclosing tracked worktree every task checkout's terminal
  // lists with the SAME worktreePath, so the tracked path + owned title no longer discriminate two
  // slots the way the task-checkout selector once did. The runtime's own proof is the terminal's
  // scrollback: the create command prints `TICKMARKR_CHECKOUT <checkout>` before the payload, and a
  // nested slot's recovery re-binds only to a candidate whose earliest page names ITS checkout.
  test("recovery of a nested-checkout slot re-binds only to a terminal whose earliest scrollback names that slot's checkout, so after a restart under one shared enclosing worktree a same-titled sibling terminal that names another checkout is never addressed and the slot fails closed, while the slot's own surviving terminal is recovered and read; a recovery that adopts the sole same-titled tab on the enclosing path alone fails", async () => {
    const parent = realpathSync(makeTestTempDir("orca-shared-parent-"));
    const A = join(parent, "A");
    const B = join(parent, "B");
    mkdirSync(A); mkdirSync(B);
    const TITLE = owned("T1", 0, RUN); // the SAME full owned title on both — the adversarial case astra reproduced
    const fake = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [parent], executeCommands: true });
    const driver = new OrcaDriver({ exec: fake.exec, pollMs: 1 });
    const a = await driver.slot(A, TITLE);
    const b = await driver.slot(B, TITLE);
    await driver.run(a, "printf 'a-ready\\n'");
    await driver.run(b, "printf 'b-ready\\n'");
    const [termA, termB] = fake.terminals.map((t) => t.handle);
    await expect.poll(() => fake.of(termA)!.lines.some((l) => l === "a-ready"), { timeout: 5_000 }).toBe(true);
    await expect.poll(() => fake.of(termB)!.lines.some((l) => l === "b-ready"), { timeout: 5_000 }).toBe(true);
    const linesA = [...fake.of(termA)!.lines];
    const linesB = [...fake.of(termB)!.lines];
    expect(linesA[0]).toBe(proofLine(A)); // the wrapper's framed proof line, first in the scrollback
    expect(linesB[0]).toBe(proofLine(B));

    // Restart: A's terminal is gone; B's survives under a NEW handle, same title, same enclosing path.
    fake.restart("rt-2", [{ handle: "term_b_after", title: TITLE, worktree: parent, lines: linesB }]);
    const mark = fake.calls.length;
    const err = await driver.close(a).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrcaUnavailableError);
    expect((err as Error).message).toContain(B);
    // Zero MUTATIONS against B: the proof reads are read-only; no close, no send, and B is still there.
    expect(fake.calls.slice(mark).filter((c) => c[1] === "close" || c[1] === "send")).toEqual([]);
    expect(fake.terminals.map((t) => t.handle)).toEqual(["term_b_after"]);
    await expect(driver.read(a, 5)).rejects.toBeInstanceOf(OrcaUnavailableError); // latched, never re-tried

    // Legitimate recovery: the slot's OWN terminal survives the restart under a new handle — its
    // earliest page names this checkout, so the read recovers to it exactly as before.
    const own = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [parent], executeCommands: true });
    const ownDriver = new OrcaDriver({ exec: own.exec, pollMs: 1 });
    const ownSlot = await ownDriver.slot(A, TITLE);
    await ownDriver.run(ownSlot, "printf 'own-ready\\n'");
    await expect.poll(() => own.last()!.lines.some((l) => l === "own-ready"), { timeout: 5_000 }).toBe(true);
    own.restart("rt-2", [{ handle: "term_a_after", title: TITLE, worktree: parent, lines: [...own.terminals[0]!.lines, "AFTER RESTART"] }]);
    expect(await ownDriver.read(ownSlot, 1)).toBe("AFTER RESTART");
    expect(own.countOf("list")).toBe(1);
    // A surviving same-titled terminal with NO proof line (truncated scrollback, foreign origin) is not
    // adopted either: fail closed rather than guess.
    const bare = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [parent] });
    const bareDriver = new OrcaDriver({ exec: bare.exec, time: steppedTime() });
    const bareSlot = await bareDriver.slot(A, TITLE);
    await bareDriver.run(bareSlot, "work");
    bare.restart("rt-2", [{ handle: "term_unproven", title: TITLE, worktree: parent, lines: ["no proof here"] }]);
    await expect(bareDriver.read(bareSlot, 5)).rejects.toBeInstanceOf(OrcaUnavailableError);
    expect(bare.calls.some((c) => c[1] === "close")).toBe(false);
  });

  /** The wire format of the proof line (FX-N05): byte length, then the path's UTF-8 bytes as hex, then a
   *  terminator — no whitespace, no quotes, and a frame that is complete or nothing. Pinned here as
   *  the contract the driver's parser must honour; `checkoutProofLine` in the driver is its producer. */
  const proofLine = (checkout: string): string => {
    const bytes = Buffer.from(checkout, "utf8");
    return `TICKMARKR_CHECKOUT ${bytes.length}:${bytes.toString("hex")};`;
  };
  /** A renderer wrap: one long row split into `parts` rows, each dressed in the margin chrome the joiner strips. */
  const wrapped = (line: string, parts: number): string[] => {
    const size = Math.ceil(line.length / parts);
    return Array.from({ length: parts }, (_, i) => `│ ${line.slice(i * size, (i + 1) * size)}`);
  };

  // FX-N05 (ASTRA-v255-FIX-ORCA-R1): the R1 parser stopped at whitespace, so `A B`'s proof line read as
  // `A` and a wrapped `…--T10` row read as `…--T1` — a PREFIX authorised a close of the wrong terminal.
  // The proof is now a framed value decoded only when complete, compared by canonical full-path equality.
  test("recovery proves the exact recorded checkout by full-path equality of a complete framed proof line, so a same-titled sibling whose checkout is A B is never adopted for A, a sibling whose wrapped proof decodes to a longer path T10 is never adopted for T1, an incomplete frame is not proof, and the slot's own wrapped proof line still recovers, while a parser that accepts a whitespace-terminated or wrapped prefix as the checkout fails", async () => {
    // (1) executed wrapper, `A` beside `A B`: real proof lines, B's names a path with a space.
    const parent = realpathSync(makeTestTempDir("orca-prefix-"));
    const A = join(parent, "A");
    const AB = join(parent, "A B");
    mkdirSync(A); mkdirSync(AB);
    const TITLE = owned("T1", 0, RUN);
    const fake = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [parent], executeCommands: true });
    const driver = new OrcaDriver({ exec: fake.exec, pollMs: 1 });
    const a = await driver.slot(A, TITLE);
    const b = await driver.slot(AB, TITLE);
    await driver.run(a, "pwd");
    await driver.run(b, "pwd");
    await expect.poll(() => fake.executed.every((e) => e.exitCode === 0), { timeout: 5_000 }).toBe(true);
    const linesB = [...fake.terminals[1]!.lines];
    expect(linesB[0]).toBe(proofLine(AB));
    expect(linesB.at(-1)).toBe(AB); // the payload really ran in `A B`
    fake.restart("rt-2", [{ handle: "term_b_after_restart", title: TITLE, worktree: parent, lines: linesB }]);
    let mark = fake.calls.length;
    await expect(driver.close(a)).rejects.toBeInstanceOf(OrcaUnavailableError);
    expect(fake.calls.slice(mark).filter((c) => c[1] === "close" || c[1] === "send")).toEqual([]);
    expect(fake.terminals.map((t) => t.handle)).toEqual(["term_b_after_restart"]);

    // (2) wrapped rows: B's checkout `…--T10` beside A's `…--T1`, B's proof line split across rows.
    const wrapParent = canonicalWorktreePath("/tmp/orca-wrap-parent");
    const T1 = `${wrapParent}/run-review--T1`;
    const T10 = `${wrapParent}/run-review--T10`;
    const wrapFake = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [wrapParent] });
    const wrapDriver = new OrcaDriver({ exec: wrapFake.exec, time: steppedTime() });
    const t1 = await wrapDriver.slot(T1, TITLE);
    await wrapDriver.run(t1, "work");
    wrapFake.restart("rt-2", [{ handle: "term_t10", title: TITLE, worktree: wrapParent, lines: [...wrapped(proofLine(T10), 3), "b-ready"] }]);
    mark = wrapFake.calls.length;
    await expect(wrapDriver.close(t1)).rejects.toBeInstanceOf(OrcaUnavailableError);
    expect(wrapFake.calls.slice(mark).filter((c) => c[1] === "close" || c[1] === "send")).toEqual([]);
    expect(wrapFake.terminals.map((t) => t.handle)).toEqual(["term_t10"]);

    // (3) an INCOMPLETE frame (the row carrying the terminator was lost) is not proof — even for the
    // slot's own checkout: latch, mutate nothing.
    const partialFake = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [wrapParent] });
    const partialDriver = new OrcaDriver({ exec: partialFake.exec, time: steppedTime() });
    const partialSlot = await partialDriver.slot(T1, TITLE);
    await partialDriver.run(partialSlot, "work");
    partialFake.restart("rt-2", [{ handle: "term_partial", title: TITLE, worktree: wrapParent, lines: [wrapped(proofLine(T1), 3)[0]!, "ready"] }]);
    mark = partialFake.calls.length;
    await expect(partialDriver.read(partialSlot, 5)).rejects.toBeInstanceOf(OrcaUnavailableError);
    expect(partialFake.calls.slice(mark).filter((c) => c[1] === "close" || c[1] === "send")).toEqual([]);

    // (4) positive: the slot's OWN proof line, wrapped across rows, reassembles to the exact path and
    // the read recovers to the surviving terminal with one relist.
    const ownFake = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [wrapParent] });
    const ownDriver = new OrcaDriver({ exec: ownFake.exec, time: steppedTime() });
    const ownSlot = await ownDriver.slot(T1, TITLE);
    await ownDriver.run(ownSlot, "work");
    ownFake.restart("rt-2", [{ handle: "term_t1_after", title: TITLE, worktree: wrapParent, lines: [...wrapped(proofLine(T1), 4), "AFTER RESTART"] }]);
    expect(await ownDriver.read(ownSlot, 1)).toBe("AFTER RESTART");
    expect(ownFake.countOf("list")).toBe(1);
  });

  // FX-N06: a proof page is evidence only when the response's own identity is the candidate's — the
  // terminal record must name the candidate handle and `_meta.runtimeId` must be the runtime that
  // supplied the ownership listing. Anything else is another terminal's or another runtime's bytes.
  test("a checkout proof read whose terminal record names another handle or whose runtime identity differs from the listing's runtime is not proof, so recovery latches the slot and mutates nothing, while the same candidate with unaltered proof responses is recovered, so a proof path that discards response identity fails", async () => {
    const parent = canonicalWorktreePath("/tmp/orca-proof-identity");
    const A = `${parent}/A`;
    const TITLE = owned("T1", 0, RUN);
    for (const fault of ["handle", "runtime", "none"] as const) {
      const fake = new FakeOrca({ runtimeId: "rt-1", trackedWorktrees: [parent] });
      const driver = new OrcaDriver({
        time: steppedTime(),
        exec: async (args, cwd, timeoutMs) => {
          const res = await fake.exec(args, cwd, timeoutMs);
          if (fault !== "none" && fake.runtimeId === "rt-2" && args[1] === "read" && res.code === 0) {
            const body = JSON.parse(res.stdout) as { result: { terminal: Record<string, unknown> }; _meta: Record<string, unknown> };
            if (fault === "handle") body.result.terminal.handle = "term_unrelated";
            else body._meta.runtimeId = "rt-3";
            return { ...res, stdout: JSON.stringify(body) };
          }
          return res;
        },
      });
      const slot = await driver.slot(A, TITLE);
      await driver.run(slot, "work");
      fake.restart("rt-2", [{ handle: "term_candidate", title: TITLE, worktree: parent, lines: [proofLine(A), "ready"] }]);
      const mark = fake.calls.length;
      if (fault === "none") {
        await driver.close(slot); // the unaltered proof recovers the candidate, and the close addresses it
        expect(fake.calls.slice(mark).filter((c) => c[1] === "close").map((c) => c[3])).toEqual(["term_candidate"]);
        expect(fake.terminals).toEqual([]);
        continue;
      }
      await expect(driver.close(slot), fault).rejects.toBeInstanceOf(OrcaUnavailableError);
      expect(fake.calls.slice(mark).filter((c) => c[1] === "close" || c[1] === "send"), fault).toEqual([]);
      expect(fake.terminals.map((t) => t.handle), fault).toEqual(["term_candidate"]);
      await expect(driver.read(slot, 5), fault).rejects.toBeInstanceOf(OrcaUnavailableError); // latched
    }
  });

  // FX-N02: the checkout wrapper must enclose the WHOLE payload — a background list, a `;` list — and
  // a missing checkout must stop the payload entirely, never fall through into the enclosing path.
  test("the checkout wrapper runs the whole payload inside the checkout so a background list and a semicolon list both report the checkout as their working directory, and a missing checkout runs nothing of the payload and exits nonzero, so a wrapper whose cd guards only the first list member fails", async () => {
    const parent = realpathSync(makeTestTempDir("orca-wrapper-"));
    const A = join(parent, "A");
    mkdirSync(A);
    const fake = new FakeOrca({ trackedWorktrees: [parent], executeCommands: true });
    const driver = new OrcaDriver({ exec: fake.exec });
    const slot = await driver.slot(A, owned("TW", 0, RUN));
    await driver.run(slot, "pwd & wait; pwd; (cd / && pwd) ; pwd");
    await expect.poll(() => fake.executed[0]?.exitCode, { timeout: 5_000 }).toBe(0);
    const printed = fake.last()!.lines.filter((l) => !l.startsWith("TICKMARKR_CHECKOUT "));
    expect(printed).toEqual([A, A, "/", A]); // every list member ran in A; the subshell's cd did not leak

    const missing = join(parent, "missing");
    const gone = new FakeOrca({ trackedWorktrees: [parent], executeCommands: true });
    let goneLines: string[] = [];
    const goneDriver = new OrcaDriver({ exec: async (args, cwd, timeout) => {
      if (args[1] === "close") goneLines = [...gone.last()!.lines];
      return gone.exec(args, cwd, timeout);
    } });
    const goneSlot = await goneDriver.slot(missing, owned("TX", 0, RUN));
    await expect(goneDriver.run(goneSlot, "printf 'first\\n'; pwd")).rejects.toBeInstanceOf(OrcaUnavailableError);
    await expect.poll(() => gone.executed[0]?.exitCode, { timeout: 5_000 }).not.toBeUndefined();
    expect(gone.executed[0]!.exitCode).not.toBe(0);
    expect(gone.countOf("close")).toBe(1);
    expect(goneLines.some((l) => l === "first" || l === parent)).toBe(false); // nothing of the payload ran
    expect(goneLines.some((l) => l.startsWith("TICKMARKR_CHECKOUT "))).toBe(false); // and no proof line was minted
  });

  test("test: a create receipt whose surface is not visible raises one attention notify naming the surface whereas a receipt whose surface is visible or absent raises none so a driver that accepts a background surface silently fails", async () => {
    const notifications: { message: string; tier?: string }[] = [];
    const withNotify = (driver: OrcaDriver) => {
      driver.notify = async (message, opts) => {
        notifications.push({ message, tier: opts?.tier });
      };
      return driver;
    };

    const visible = rig({ createSurface: "visible" });
    await withNotify(visible.driver).run(await visible.driver.slot(WT_A, TITLE_A), "run-visible");
    expect(notifications).toEqual([]);

    const absent = rig({ createSurface: null });
    await withNotify(absent.driver).run(await absent.driver.slot(WT_A, TITLE_A), "run-absent");
    expect(notifications).toEqual([]);

    const background = rig({ createSurface: "background" });
    await withNotify(background.driver).run(await background.driver.slot(WT_A, TITLE_A), "run-background");
    expect(notifications).toEqual([
      { message: "tickmarkr orca terminal created on background surface", tier: "attention" },
    ]);
  });

  test("test: two logical slots with different worktree paths produce create commands whose path selectors and create receipts each bind to their own slot's cwd while a driver that resolves the UI-active worktree or the daemon's cwd for either slot fails the pair", async () => {
    const { fake, driver } = rig();
    const a = await driver.slot(WT_A, TITLE_A);
    const b = await driver.slot(WT_B, TITLE_B);
    expect([a.cwd, b.cwd]).toEqual([WT_A, WT_B]);

    await driver.run(a, "run-a");
    await driver.run(b, "run-b");

    // Each create NAMES its own checkout outright — `path:<abs>`, never an ambient selector.
    const creates = fake.calls.filter((c) => c[1] === "create");
    expect(creates).toEqual([
      ["terminal", "create", "--worktree", `path:${WT_A}`, "--title", TITLE_A, "--command", inCheckout(WT_A, `${herdrSealShellPrefix().split(";")[0]}; run-a`), "--json"],
      ["terminal", "create", "--worktree", `path:${WT_B}`, "--title", TITLE_B, "--command", inCheckout(WT_B, `${herdrSealShellPrefix().split(";")[0]}; run-b`), "--json"],
    ]);
    // …and asking is not getting: the RECEIPTS bind to those same two distinct checkouts, which is
    // what the driver checked before it kept either handle.
    expect(fake.terminals.map((t) => [t.title, t.worktree])).toEqual([[TITLE_A, WT_A], [TITLE_B, WT_B]]);

    // Control 1 — the UI-active worktree. It resolves to whatever the operator last focused; here
    // that happens to BE slot A's checkout, so slot A passes by luck and the pair still fails: both
    // terminals land in A, which is precisely the isolation loss the receipt check exists to catch.
    const uiFake = new FakeOrca({ activeWorktree: WT_A });
    const uiDriver = ambientSelector(uiFake, "active");
    const uiA = await uiDriver.slot(WT_A, TITLE_A);
    const uiB = await uiDriver.slot(WT_B, TITLE_B);
    await uiDriver.run(uiA, "run-a");
    const uiErr = await uiDriver.run(uiB, "run-b").then(() => undefined, (e: unknown) => e);
    expect(uiErr).toBeInstanceOf(OrcaError);
    expect((uiErr as OrcaError).message).toContain(`create receipt bound to ${WT_A}, not the tracked ${WT_B} enclosing ${WT_B}`);
    expect(uiFake.calls.filter((c) => c[1] === "create").map((c) => c[3])).toEqual(["active", "active"]); // both ASKED for A
    // …and refusing the receipt is not on its own fail-closed: `terminal create` had already
    // LAUNCHED run-b in A. The wrong-checkout terminal is closed and the slot latched, so nothing
    // is left mutating A and a retrying dispatch cannot open a second one beside it.
    expect(uiFake.calls.filter((c) => c[1] === "close").map((c) => c[3])).toEqual(["term_2"]);
    expect(uiFake.terminals.map((t) => [t.handle, t.worktree])).toEqual([["term_1", WT_A]]);
    const retry = await uiDriver.run(uiB, "run-b").then(() => undefined, (e: unknown) => e);
    expect(retry).toBeInstanceOf(OrcaUnavailableError);
    expect(uiFake.countOf("create")).toBe(2);

    // Control 2 — the daemon's cwd. A CLI child bound to the daemon checkout asks `worktree current`
    // from THERE, and the tracked worktree that answers encloses neither slot checkout: the driver
    // refuses before any create (OBS-1004 — the answer must enclose the checkout the command will run in).
    const daemonFake = new FakeOrca({ trackedWorktrees: [WT_A, WT_B, DAEMON_CWD] });
    const daemonDriver = ambientSelector(daemonFake, "current", DAEMON_CWD);
    const dA = await daemonDriver.slot(WT_A, TITLE_A);
    const dB = await daemonDriver.slot(WT_B, TITLE_B);
    for (const [slot, wt] of [[dA, WT_A], [dB, WT_B]] as const) {
      const err = await daemonDriver.run(slot, "run").then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(OrcaError);
      expect((err as OrcaError).message).toContain(`Orca answered ${DAEMON_CWD}, which does not enclose ${wt}`);
    }
    // No command was launched in the daemon checkout at all.
    expect(daemonFake.countOf("create")).toBe(0);
    expect(daemonFake.countOf("close")).toBe(0);
    expect(daemonFake.terminals).toEqual([]);
  });

  test("test: slot() creates no terminal, the first run() issues exactly one terminal create carrying the command, and a second run() on the same slot sends into the existing terminal without creating another, while worktree() returns the checkout tickmarkr's own createWorktree produced and a driver that delegates checkout creation to an orca worktree verb fails", async () => {
    const { fake, driver } = rig();

    // slot() is lazy by contract: no terminal, and not a single byte on the CLI seam.
    const slot = await driver.slot(WT_A, TITLE_A);
    expect(fake.calls).toEqual([]);
    expect(fake.terminals).toEqual([]);

    // First run(): exactly one create, and the command rides IT — not a follow-up send.
    await driver.run(slot, "bash -lc 'first'");
    expect(fake.countOf("create")).toBe(1);
    expect(fake.calls.find((c) => c[1] === "create")).toEqual(
      ["terminal", "create", "--worktree", `path:${WT_A}`, "--title", TITLE_A, "--command", inCheckout(WT_A, `${herdrSealShellPrefix().split(";")[0]}; bash -lc 'first'`), "--json"],
    );
    expect(fake.countOf("send")).toBe(0);
    const handle = fake.last()!.handle;

    // Second run(): into the terminal this slot already owns. Never a second create.
    await driver.run(slot, "second");
    expect(fake.countOf("create")).toBe(1);
    expect(fake.countOf("send")).toBe(1);
    expect(fake.sent.get(handle)).toEqual(["second"]);
    expect(fake.terminals.map((t) => t.handle)).toEqual([handle]);

    // worktree(): tickmarkr's own createWorktree stays the sole checkout authority. The battery
    // is the checkout contract the daemon depends on, and it runs VERBATIM against both drivers.
    const repo = makeRepo({ "a.txt": "a\n" });
    const branch = "tickmarkr/run-placement--T2";
    const before = fake.calls.length;
    const mine = await checkoutBattery(driver, repo, branch);
    expect(fake.calls).toHaveLength(before); // the orca CLI was never consulted about a checkout
    expect(mine.failures).toEqual([]);
    expect(await createWorktree(repo, branch, "HEAD")).toBe(mine.dir); // same checkout, same authority

    // Control — a driver that delegates the checkout to Orca's REAL verb, on its real contract:
    // `orca worktree create --name <name> [--repo <selector>] [--base-branch <ref>]` (1.4.186).
    // The verb WORKS here — a genuine checkout comes back, at the base that was asked for — and
    // delegation still fails the same battery, structurally: `worktree create` offers no path
    // selector at all, so the checkout lands in Orca's root and never at the `worktreePath()` every
    // tickmarkr surface (dispatch, cleanup, merge) addresses; and Orca's unit is a worktree NAME,
    // from which it derives the branch, so the exact `tickmarkr/<runId>--<task>` ref is not the
    // delegating driver's to ask for either.
    const delegatedBranch = "tickmarkr/run-placement--T2-delegated";
    const orca = new FakeOrca({ worktreeRoot: makeTestTempDir("orca-worktrees-") });
    const theirs = await checkoutBattery(new DelegatingOrcaDriver(orca), repo, delegatedBranch);
    expect(orca.countOf("worktree")).toBe(1);
    expect(theirs.failures).toEqual(["path", "branch"]); // a REAL checkout, at the right base — in Orca's place, on Orca's branch
    expect(existsSync(worktreePath(repo, delegatedBranch))).toBe(false); // nothing where the daemon looks
  });

  // OBS-772 CHANGED THIS TEST'S SUBJECT, and the change is a real loss, not a cleanup. It used to
  // assert that an owned leftover from an OLDER run is reclaimed — the argument FOR the unscoped
  // listing, made right below in the scoped-listing control. `owned.runId !== runId` now spares it,
  // because a dead run's orphan and a LIVE run's worker are the same bytes to this process: on Orca
  // every checkout shares one ORCA_SPACE, so the sweep that reclaimed `t_old` is the same sweep that
  // closed a stranger's live worker (OBS-769/772). Cross-run reclamation is given up deliberately;
  // stranded leftovers are the operator's to close. The foreign controls are unchanged.
  test("test: reconcile closes an undesired owned-titled terminal OF THIS RUN, while an owned-titled leftover from an OLDER run, a pre-existing foreign-titled terminal and a live foreign lookalike all survive; closing the old-run terminal or either foreign control fails", async () => {
    const DESIRED = owned("T1", 0, RUN);
    const UNDESIRED = owned("T9", 0, RUN);
    const OLD = owned("T4", 1, "run-older");
    const FOREIGN = "psql — production";
    // The lookalike is foreign three ways over: its TAB title is a plain editor command, while its
    // shell-controlled PANE title spells a perfectly-formed owned name and it carries the SAME tabId
    // as the owned terminal beside it. Only the tab title decides, so none of that makes it ours.
    const seed = (): FakeTerminalSpec[] => [
      { handle: "t_desired", title: DESIRED, worktree: WT_A, lines: [checkoutProofLine(WT_A)] },
      { handle: "t_undesired", title: UNDESIRED, worktree: WT_A, lines: [checkoutProofLine(WT_A)] },
      { handle: "t_old", title: OLD, worktree: WT_GONE },
      { handle: "t_foreign", title: FOREIGN, worktree: WT_A, paneTitle: "psql" },
      { handle: "t_lookalike", title: "vim src/index.ts", worktree: WT_A, paneTitle: UNDESIRED, tabId: "t_undesired-tab" },
      // Operator moved the worker out and left a foreign shell alone under the owned title.
      // Tab title is not ownership of that leaf — without the checkout proof it must survive.
      { handle: "t_abandoned", title: owned("T2", 0, RUN), worktree: WT_A, paneTitle: "psql" },
    ];
    const { fake, driver } = rig({ terminals: seed() });
    const desired = new Set([DESIRED]);

    await driver.reconcile(desired, RUN);

    // The sweep is UNSCOPED and layout-bearing — one listing of the whole terminal table.
    expect(fake.calls.filter((c) => c[1] === "list")).toEqual([
      ["terminal", "list", "--include-visual-layouts", "--limit", "10000", "--json"],
    ]);
    // Owned-and-undesired closes ONLY when this run created it (OBS-772); everything else survives,
    // `t_old` now included. The second assertion is the leg that keeps this from becoming a mute:
    // `t_undesired` must still close, or the sweep has stopped doing its job rather than been scoped.
    expect(fake.calls.filter((c) => c[1] === "close").map((c) => c[3]).sort()).toEqual(["t_undesired"]);
    expect(fake.terminals.map((t) => t.handle).sort()).toEqual(["t_abandoned", "t_desired", "t_foreign", "t_lookalike", "t_old"].sort());

    // Control — the scoped listing, kept because it still shows something true: a worktree-scoped
    // sweep cannot even SEE the old-run leftover. Post-OBS-772 the unscoped sweep spares it too, so
    // the two now agree on `t_old` and differ only in what they can observe. Instance, not assertion.
    const scoped = new FakeOrca({ terminals: seed() });
    const scopedList = await scoped.exec(
      ["terminal", "list", "--worktree", `path:${WT_A}`, "--include-visual-layouts", "--limit", "10000", "--json"],
      process.cwd(),
    );
    const scopedTitles = (JSON.parse(scopedList.stdout) as {
      result: { visualLayouts: { root: { tabs: { title: string }[] } }[] };
    }).result.visualLayouts.flatMap((l) => l.root.tabs.map((t) => t.title));
    expect(scopedTitles).toContain(UNDESIRED);
    expect(scopedTitles).not.toContain(OLD); // …and that is how a leftover survives forever

    // Control — closing a foreign terminal. A fold keyed on the shell-controlled PANE title instead
    // of the owned TAB title marks the lookalike garbage; the real sweep never put it on the wire.
    const paneKeyed = panesToClose(
      [{ name: UNDESIRED, paneId: "t_lookalike", workspaceId: "orca" }],
      desired,
      "orca",
      RUN,
    );
    expect(paneKeyed.map((p) => p.paneId)).toEqual(["t_lookalike"]);
    for (const survivor of ["t_foreign", "t_lookalike"]) {
      expect(fake.calls.some((c) => c.includes(survivor))).toBe(false);
    }
  });

  // The two standing review findings against this work, as instances. Both live at the same seam:
  // a handle is runtime-scoped and a checkout has one filesystem identity under many spellings, so
  // identity is re-proven at the destructive call and re-derived by owned TAB title — never carried
  // over from an earlier validation, never trusted because a tabId or a path string looks familiar.
  test("a runtime restart between show and close re-derives the handle from the owned tab title, so a foreign terminal holding the reissued handle value and the old tabId is never the one closed", async () => {
    const TITLE = owned("T7", 0, RUN);
    const { fake, driver } = rig();
    const slot = await driver.slot(WT_A, TITLE);
    await driver.run(slot, "work");
    const validated = fake.last()!.handle;
    expect(await driver.status(slot)).toBe("unknown"); // show validated THIS handle, under rt-1

    // …and then R1 restarts. R2 reissues that exact handle value — and that exact tabId — to
    // somebody else's terminal, whose shell has drawn a perfectly-formed owned name onto its PANE
    // title. The owned TAB title is the only ownership evidence, and ours now answers elsewhere.
    fake.restart("rt-2", [
      { handle: validated, title: "vim src/index.ts", worktree: WT_A, tabId: `${validated}-tab`, paneTitle: TITLE },
      { handle: "term_reissued", title: TITLE, worktree: WT_A },
    ]);

    await driver.close(slot);

    // The destructive call went to the terminal the owned tab resolves to NOW, not to the value
    // show vouched for one runtime ago.
    expect(fake.calls.filter((c) => c[1] === "close").map((c) => c[3])).toEqual(["term_reissued"]);
    // Control — closing on the show-validated handle. Instance, not assertion: that value is still
    // addressable, and what it addresses under R2 is the foreign terminal, which is still alive.
    const survivor = fake.of(validated);
    expect(survivor?.title).toBe("vim src/index.ts");
    expect(fake.terminals.map((t) => t.handle)).toEqual([validated]);
  });

  test("a checkout handed over under a symlinked spelling still rebinds after a restart, where the resolve()-only comparison a driver is tempted to write reports two different checkouts", async () => {
    const real = mkdtempSync(join(tmpdir(), "orca-canon-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      const canonical = realpathSync(real);
      // The premise, proven against the filesystem before anything is asserted about the driver:
      // one checkout, two spellings, and resolve() collapses `..` but never a symlink.
      expect(resolve(link)).not.toBe(canonical);
      expect(realpathSync(link)).toBe(canonical);

      const TITLE = owned("T8", 0, RUN);
      const { fake, driver } = rig({ trackedWorktrees: [link] }); // tracked under its symlinked spelling
      // git hands tickmarkr the symlinked spelling; the slot's identity is the canonical one.
      const slot = await driver.slot(link, TITLE);
      expect(slot.cwd).toBe(canonical);
      await driver.run(slot, "work");
      expect(fake.last()!.worktree).toBe(canonical);

      // After the restart the runtime answers with the OTHER spelling of the same checkout — which
      // is exactly what a slot re-acquired across a restart has to survive.
      fake.restart("rt-2", [{ handle: "term_after", title: TITLE, worktree: link }]);
      await driver.run(slot, "again");
      expect(fake.sent.get("term_after")).toEqual(["again"]);

      // …and the control is the resolve()-only comparison asserted above: it reports two different
      // checkouts, so the relist finds no row in "the slot's worktree" and this valid slot is
      // unavailable forever. Only filesystem identity puts both spellings back on one checkout.
      expect(canonicalWorktreePath(link)).toBe(canonicalWorktreePath(canonical));
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
  test("test: the Orca narrator for a run identity with the terminal-handle marker set reserves the board owner record naming the driver, the owned watch name and a fresh token before any command can read that token, issues exactly one terminal split of the launching handle in the horizontal direction whose command carries the token and the watch command, creates no tab and never renames the launching tab, binds the record to the child handle the recorded split receipt returns, and resolves only once a fixture observer started at command start has claimed that record with its pid and arm id within injected fixture time, while an observer that never claims rejects naming the unclaimed board, a second narrator call while the claimed record still matches answers the same slot with no second split, the lost-watch retire seam under a dead observer followed by a narrator call yields a new claimed handle with the lost one never answered again, close under a live observer requests the stop and waits for the acknowledgement on injected time before the handle-bound close receipt, reconcile leaves the launching pane, a foreign pane and the recorded watch handle open even when the enclosing tab carries an owned title, and a split whose receipt is unknown, malformed or handle-less after the verb was issued rejects naming placement and indeterminate cleanup without a second split or a close aimed at a guessed handle, so a narrator that reserves after the command started, counts an unclaimed board, answers a lost pane, retitles the tab, or invents a handle fails", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const runId = "run-20260912-215149-0000000000000007";
    const launchingHandle = "term_launching_1";
    const launchingTabTitle = "launching-tab-original";

    interface ActiveObserver { stopRequested: () => boolean; close: () => void }
    let reservedBeforeCommand: WatchBoardOwner | undefined = undefined;
    let splitCommandSeen: string | null = null;
    let simulateClaim = true;
    let simulateAckOnStop = true;
    let malformedSplitReceipt: { code: number; stdout: string } | null = null;
    let activeObserver: ActiveObserver | null = null;
    let refuseClose = false;
    let closingOwner: WatchBoardOwner | undefined;
    const closeOrder: string[] = [];
    let stopSleeps = 0;
    // A late observer: claims on the Nth injected sleep, not at command start, and records what it read.
    let lateClaim: { runId: string; afterSleeps: number; saw?: WatchBoardOwner } | null = null;

    const fake = new FakeOrca({
      terminals: [
        { handle: launchingHandle, title: launchingTabTitle, worktree: repo, tabId: "launch_tab" },
      ],
      trackedWorktrees: [repo],
    });

    const clock = steppedTime();
    const origSleep = clock.sleep;
    clock.sleep = async (ms: number) => {
      clock.advance(ms);
      if (simulateAckOnStop && activeObserver && activeObserver.stopRequested()) {
        if (closingOwner) {
          if (++stopSleeps === 1) closeOrder.push("stop");
          expect(watchBoardAcknowledged(closingOwner)).toBe(false);
          // Hold acknowledgement for three injected sleeps to distinguish waiting from request-only.
          if (stopSleeps >= 3) {
            activeObserver.close();
            expect(watchBoardAcknowledged(closingOwner)).toBe(true);
            closeOrder.push("ack");
          }
        } else activeObserver.close();
      }
      if (lateClaim && !lateClaim.saw && --lateClaim.afterSleeps <= 0) {
        lateClaim.saw = readWatchBoard(repo, lateClaim.runId);
        activeObserver = observeNamedRun(repo, lateClaim.runId, { TICKMARKR_WATCH_OWNER: lateClaim.saw!.token });
      }
      return origSleep(ms);
    };

    const originalExec = fake.exec.bind(fake);
    const customExec = async (args: string[], cwd?: string, timeoutMs?: number) => {
      if (closingOwner && args[0] === "terminal" && args[1] === "close") {
        expect(args[3]).toBe(closingOwner.pane);
        expect(watchBoardAcknowledged(closingOwner)).toBe(true);
        expect(closeOrder).toEqual(["stop", "ack"]);
        closeOrder.push("close");
      }
      if (refuseClose && args[0] === "terminal" && args[1] === "close") {
        fake.calls.push(args);
        return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "close_refused", message: "close refused" }, _meta: { runtimeId: fake.runtimeId } }), stderr: "" };
      }
      if (args[0] === "terminal" && args[1] === "split") {
        if (malformedSplitReceipt) {
          fake.calls.push(args);
          return malformedSplitReceipt;
        }
        const cmdIdx = args.indexOf("--command");
        splitCommandSeen = cmdIdx >= 0 ? args[cmdIdx + 1] : null;
        const claimedRun = /--run-id\s+(\S+)/.exec(splitCommandSeen ?? "")?.[1] ?? runId;
        reservedBeforeCommand = readWatchBoard(repo, claimedRun);
        const res = await originalExec(args, cwd, timeoutMs);
        if (simulateClaim && reservedBeforeCommand) {
          activeObserver = observeNamedRun(repo, claimedRun, {
            TICKMARKR_WATCH_OWNER: reservedBeforeCommand.token,
          });
        }
        return res;
      }
      return originalExec(args, cwd, timeoutMs);
    };

    const driver = new OrcaDriver({
      exec: customExec,
      time: clock,
      launchingHandle,
    });

    // --- Part 1: First narrator call: reserve, split, bind, claim ---
    const slot = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);

    expect(reservedBeforeCommand).toBeDefined();
    expect(reservedBeforeCommand.driver).toBe("orca");
    expect(reservedBeforeCommand.name).toBe(formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }));
    expect(reservedBeforeCommand.runId).toBe(runId);
    expect(reservedBeforeCommand.token).toMatch(/^[a-f0-9-]{36}$/);

    const splitCalls = fake.calls.filter((c) => c[1] === "split");
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0][splitCalls[0].indexOf("--terminal") + 1]).toBe(launchingHandle);
    expect(splitCalls[0]).toContain("--direction");
    expect(splitCalls[0][splitCalls[0].indexOf("--direction") + 1]).toBe("horizontal");
    expect(splitCommandSeen).toContain("TICKMARKR_WATCH_OWNER=");
    expect(splitCommandSeen).toContain(reservedBeforeCommand.token);
    expect(splitCommandSeen).toContain(`tickmarkr run --view run-board --run-id ${runId}`);

    const createCalls = fake.calls.filter((c) => c[1] === "create");
    expect(createCalls).toHaveLength(0);
    const launchingTerm = fake.terminals.find((t) => t.handle === launchingHandle);
    expect(launchingTerm?.title).toBe(launchingTabTitle);

    const recordAfterSplit = readWatchBoard(repo, runId);
    expect(recordAfterSplit?.pane).toBe(slot.id);
    expect(slot.id).not.toBe(launchingHandle);
    expect(recordAfterSplit?.pid).toBe(process.pid);
    expect(recordAfterSplit?.armId).toBeDefined();

    // --- Part 2: Observer that never claims rejects naming the unclaimed board ---
    const unclaimedRunId = "run-unclaimed-123";
    simulateClaim = false;
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${unclaimedRunId}`, unclaimedRunId)
    ).rejects.toThrow(/unclaimed board/i);
    // A refused placement never deletes its record: the reservation is tombstoned, still readable.
    expect(readWatchBoard(repo, unclaimedRunId)).toMatchObject({ driver: "orca" });
    expect(JSON.parse(readFileSync(join(repo, stateDirName(repo), "supervision", `watch-board.${unclaimedRunId}.json`), "utf8"))).toMatchObject({ retired: true });

    // --- Part 2b: an unclaimed board whose close is refused tombstones its reservation naming the
    // surviving pane; the next call closes exactly THAT recorded handle (never a guess) before it
    // splits afresh — the tombstone is what lets a later narrator recover instead of refusing forever.
    const refusedRunId = "run-unclaimed-refused-124";
    refuseClose = true;
    const splitsBeforeRefused = fake.calls.filter((c) => c[1] === "split").length;
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${refusedRunId}`, refusedRunId)
    ).rejects.toThrow(/unclaimed board.*indeterminate cleanup/i);
    refuseClose = false;
    const keptReservation = readWatchBoard(repo, refusedRunId);
    const survivingPane = fake.calls.filter((c) => c[1] === "split").length === splitsBeforeRefused + 1 ? fake.last()!.handle : "";
    expect(keptReservation).toMatchObject({ driver: "orca", pane: survivingPane });
    expect(fake.of(survivingPane)).toBeDefined();
    simulateClaim = true;
    const observerBeforeRecovery = activeObserver;
    const closesBeforeRecovery = fake.calls.filter((c) => c[1] === "close").length;
    const recovered = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${refusedRunId}`, refusedRunId);
    activeObserver = observerBeforeRecovery; // the recovered board's observer is not this test's subject
    expect(fake.calls.filter((c) => c[1] === "close").slice(closesBeforeRecovery).map((c) => c[3])).toEqual([survivingPane]);
    expect(fake.of(survivingPane)).toBeUndefined();
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitsBeforeRefused + 2);
    expect(readWatchBoard(repo, refusedRunId)).toMatchObject({ pane: recovered.id, pid: process.pid });
    expect(readWatchBoard(repo, refusedRunId)?.token).not.toBe(keptReservation?.token);
    simulateClaim = false;

    // --- Part 2c: a claim that lands AFTER the split returns. The narrator writes nothing before the
    // claim (the observer reads the untouched reservation), so the final record carries both the
    // observer's claim and the receipt's child handle — neither write erases the other.
    const lateRunId = "run-late-claim-125";
    const firstObserver = activeObserver;
    lateClaim = { runId: lateRunId, afterSleeps: 3 };
    const lateSlot = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${lateRunId}`, lateRunId);
    expect(lateClaim.saw).toMatchObject({ pane: "" });
    expect(lateClaim.saw?.pid).toBeUndefined();
    expect(readWatchBoard(repo, lateRunId)).toMatchObject({ pane: lateSlot.id, pid: process.pid, token: lateClaim.saw?.token });
    expect(readWatchBoard(repo, lateRunId)?.armId).toBeDefined();
    lateClaim = null;
    activeObserver = firstObserver;

    // 3. second narrator on a claimed record answers the same slot, no second split
    const splitCountBefore = fake.calls.filter((c) => c[1] === "split").length;
    const slotSame = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);
    expect(slotSame.id).toBe(slot.id);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBefore);

    // --- Part 3b: A fresh OrcaDriver (a restarted daemon) sees the claimed durable record and answers
    // the same child handle with zero additional splits — the record, not this instance's cache, is
    // the truth of placement.
    const restarted = new OrcaDriver({ exec: customExec, time: clock, launchingHandle });
    const slotAfterRestart = await restarted.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);
    expect(slotAfterRestart.id).toBe(slot.id);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBefore);

    // 4. lost-watch retire then narrator: new handle; lost one never answered
    simulateClaim = true;
    activeObserver?.close();
    activeObserver = null;
    await driver.retireLostWatch(slot);
    expect(fake.of(slot.id)).toBeUndefined();

    // The restarted instance adopted the lost handle BEFORE retirement and holds it in its own cache;
    // retirement is durable against the token, so it too places a new board rather than answering it.
    const afterRetire = await restarted.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);
    expect(afterRetire.id).not.toBe(slot.id);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBefore + 1);

    const slotNew = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);
    expect(slotNew.id).toBe(afterRetire.id);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBefore + 1);

    const slotAgain = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);
    expect(slotAgain.id).toBe(slotNew.id);
    expect(slotAgain.id).not.toBe(slot.id);

    // 5. live-observer close: stop file, ack, then handle-bound close
    const closeCountBefore = fake.calls.filter((c) => c[1] === "close").length;
    closingOwner = readWatchBoard(repo, runId)!;
    expect(closingOwner.pid).toBe(process.pid);
    expect(watchBoardAcknowledged(closingOwner)).toBe(false);
    await driver.close(slotNew);
    expect(stopSleeps).toBe(3);
    expect(closeOrder).toEqual(["stop", "ack", "close"]);
    closingOwner = undefined;
    const closeCalls = fake.calls.filter((c) => c[1] === "close");
    expect(closeCalls.length).toBe(closeCountBefore + 1);
    expect(closeCalls[closeCalls.length - 1][3]).toBe(slotNew.id);

    // 6. reconcile keeps launching, foreign, and watch panes under an owned tab title
    const slotReconcile = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${runId}`, runId);
    const ownedTabTitle = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId });
    const foreignPaneHandle = "term_b81c4e90-2d34-45a1-9440-1a73e4450001";
    const undesiredPaneHandle = "term_f09a12c4-5e67-48b2-8551-2b84e5560002";
    const abandonedPaneHandle = "term_c03d5f01-3e45-46b2-9662-3c95f6670003";
    fake.terminals.push(
      { handle: foreignPaneHandle, title: ownedTabTitle, worktree: repo, tabId: "owned_tab", paneTitle: "psql", parentHandle: undesiredPaneHandle },
      // The durable create proof, rather than a driver-instance test seam, is what makes this
      // leaf an owned worker after a fresh OrcaDriver has been constructed.
      { handle: undesiredPaneHandle, title: formatOwnedName({ role: "worker", taskId: "T9", attempt: 0, runId }), worktree: repo, tabId: "owned_tab", lines: [checkoutProofLine(repo)] },
      // Single-leaf owned title, no checkout proof: the worker was moved out and a foreign
      // shell remains. Title alone must not make this a close candidate.
      { handle: abandonedPaneHandle, title: formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId }), worktree: repo, tabId: "abandoned_tab", paneTitle: "psql" },
    );
    const undesiredTitle = formatOwnedName({ role: "worker", taskId: "T9", attempt: 0, runId });
    // A Tickmarkr-created launching terminal has durable checkout proof. Both guards must matter
    // even when its tab title is owned and undesired.
    fake.of(launchingHandle)!.title = undesiredTitle;
    fake.of(launchingHandle)!.lines = [checkoutProofLine(repo)];
    fake.moveToTab(slotReconcile.id, "moved_watch_tab", undesiredTitle);
    // Proof on the watch makes the recorded-watch exemption load-bearing: without it this
    // single-leaf owned-title pane would be a close candidate.
    fake.of(slotReconcile.id)!.lines = [checkoutProofLine(repo)];
    expect(fake.of(slotReconcile.id)!.parentHandle).toBeUndefined();
    const layoutReceipt = await fake.exec(["terminal", "list", "--json"]);
    expect(layoutReceipt.stdout).toContain("moved_watch_tab");

    const reconcileCallStart = fake.calls.length;
    const desired = new Set([ownedTabTitle]);
    await driver.reconcile(desired, runId);

    const reconcileClosedHandles = fake.calls
      .slice(reconcileCallStart)
      .filter((c) => c[1] === "close")
      .map((c) => c[3]);
    expect(reconcileClosedHandles).toContain(undesiredPaneHandle);
    expect(reconcileClosedHandles).not.toContain(launchingHandle);
    expect(reconcileClosedHandles).not.toContain(foreignPaneHandle);
    expect(reconcileClosedHandles).not.toContain(abandonedPaneHandle);
    expect(reconcileClosedHandles).not.toContain(slotReconcile.id);
    // 7. unknown/malformed/handle-less split receipt refuses; no guessed close
    const splitCountBeforeMalformed = fake.calls.filter((c) => c[1] === "split").length;
    const closeCountBeforeMalformed = fake.calls.filter((c) => c[1] === "close").length;
    malformedSplitReceipt = {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { split: { handle: "term_forged_no_parent_tab" } },
        _meta: { runtimeId: fake.runtimeId },
      }),
    };
    const malformedRunId = "run-malformed-999";
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${malformedRunId}`, malformedRunId)
    ).rejects.toThrow(/placement.*indeterminate cleanup/i);

    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBeforeMalformed + 1);
    expect(fake.calls.filter((c) => c[1] === "close").length).toBe(closeCountBeforeMalformed);
    expect(fake.calls.filter((c) => c[1] === "close").map((c) => c[3])).not.toContain("term_forged_no_parent_tab");
    // The reservation can never be bound, so it is tombstoned (still present, still readable): a
    // later call splits afresh instead of refusing forever — and never closes the forged handle.
    expect(JSON.parse(readFileSync(join(repo, stateDirName(repo), "supervision", `watch-board.${malformedRunId}.json`), "utf8"))).toMatchObject({ pane: "", retired: true });
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${malformedRunId}`, malformedRunId)
    ).rejects.toThrow(/placement.*malformed or handle-less.*indeterminate cleanup/i);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBeforeMalformed + 2);
    expect(fake.calls.filter((c) => c[1] === "close").length).toBe(closeCountBeforeMalformed);

    // Unknown receipt: the verb was issued but its output is unparseable — same refusal, same tombstone.
    malformedSplitReceipt = { code: 0, stdout: "split: connection reset" };
    const unknownRunId = "run-unknown-998";
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${unknownRunId}`, unknownRunId)
    ).rejects.toThrow(/placement failed .*receipt is unknown.*indeterminate cleanup/is);
    expect(readWatchBoard(repo, unknownRunId)?.pane).toBe("");
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${unknownRunId}`, unknownRunId)
    ).rejects.toThrow(/placement failed .*receipt is unknown.*indeterminate cleanup/is);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitCountBeforeMalformed + 4);
    expect(fake.calls.filter((c) => c[1] === "close").length).toBe(closeCountBeforeMalformed);

    // Handle present but parent tabId is not the launching terminal's — still malformed, no close.
    malformedSplitReceipt = {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { split: { handle: "term_forged_wrong_tab", tabId: "not-the-launching-tab" } },
        _meta: { runtimeId: fake.runtimeId },
      }),
    };
    const wrongTabRunId = "run-malformed-tab-997";
    const splitsBeforeWrongTab = fake.calls.filter((c) => c[1] === "split").length;
    await expect(
      driver.narrator(repo, `tickmarkr run --view run-board --run-id ${wrongTabRunId}`, wrongTabRunId)
    ).rejects.toThrow(/placement.*indeterminate cleanup/i);
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitsBeforeWrongTab + 1);
    expect(fake.calls.filter((c) => c[1] === "close").map((c) => c[3])).not.toContain("term_forged_wrong_tab");

    // --- Part 8: a handle listed after an Orca restart is not the recorded pane ---
    malformedSplitReceipt = null;
    simulateClaim = true;
    const runtimeRunId = "run-runtime-reuse-996";
    const runtimeSlot = await driver.narrator(repo, `tickmarkr run --view run-board --run-id ${runtimeRunId}`, runtimeRunId);
    const placedRuntimeId = fake.runtimeId;
    expect(JSON.parse(readFileSync(join(repo, stateDirName(repo), "supervision", `watch-board.${runtimeRunId}.json`), "utf8")).runtimeId).toBe(placedRuntimeId);
    const reusedHandle = runtimeSlot.id;
    fake.restart("rt-after-restart", [
      { handle: launchingHandle, title: launchingTabTitle, worktree: repo, tabId: "launch_tab" },
      { handle: reusedHandle, title: "vim src/index.ts", worktree: repo, tabId: "reused_after_restart" },
    ]);
    const splitsBeforeReuse = fake.calls.filter((c) => c[1] === "split").length;
    const freshRuntime = new OrcaDriver({ exec: customExec, time: clock, launchingHandle });
    const placedAfterRestart = await freshRuntime.narrator(repo, `tickmarkr run --view run-board --run-id ${runtimeRunId}`, runtimeRunId);
    expect(placedAfterRestart.id).not.toBe(reusedHandle);
    expect(fake.of(reusedHandle)?.title).toBe("vim src/index.ts");
    expect(fake.calls.filter((c) => c[1] === "split").length).toBe(splitsBeforeReuse + 1);
    expect(fake.calls.filter((c) => c[1] === "close").map((c) => c[3])).not.toContain(reusedHandle);
  });
});

// R59: the board owner record is the ONE lifecycle — reserve → claim → bind → retire → cleanup. Each
// transition is judged by a SECOND OrcaDriver instance, which can know nothing the file does not say.
function boardRig(runId: string) {
  const repo = makeRepo({ "base.txt": "base\n" });
  const launching = "term_launching";
  const fake = new FakeOrca({ terminals: [{ handle: launching, title: "launching-tab", worktree: repo }], trackedWorktrees: [repo] });
  const clock = steppedTime();
  const boardFile = (id: string) => join(repo, stateDirName(repo), "supervision", `watch-board.${id}.json`);
  const rig = {
    repo,
    fake,
    claim: "at-command-start" as "at-command-start" | "never" | "on-sleep",
    refuseClose: false,
    observer: undefined as ReturnType<typeof observeNamedRun> | undefined,
    ackStop: true,
    atSplit: undefined as WatchBoardOwner | undefined,
    onSleep: undefined as (() => Promise<void>) | undefined,
    onClose: undefined as (() => void) | undefined,
    command: `tickmarkr run --view run-board --run-id ${runId}`,
    boardFile,
    bytes: (id = runId) => readFileSync(boardFile(id), "utf8"),
    splits: () => fake.countOf("split"),
    claimNow: () => {
      rig.observer = observeNamedRun(repo, runId, { TICKMARKR_WATCH_OWNER: readWatchBoard(repo, runId)!.token });
    },
    driver: () => new OrcaDriver({ exec, time: clock, launchingHandle: launching }),
  };
  const exec: OrcaExec = async (args, cwd, timeoutMs) => {
    if (args[1] === "close") rig.onClose?.();
    if (rig.refuseClose && args[1] === "close") {
      fake.calls.push([...args]);
      return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "close_refused", message: "close refused" }, _meta: { runtimeId: fake.runtimeId } }), stderr: "" };
    }
    if (args[1] === "split") rig.atSplit = readWatchBoard(repo, runId);
    const res = await fake.exec(args, cwd, timeoutMs);
    if (args[1] === "split" && rig.claim === "at-command-start") rig.claimNow();
    return res;
  };
  const sleep = clock.sleep;
  clock.sleep = async (ms: number) => {
    if (rig.ackStop && rig.observer?.stopRequested()) rig.observer.close(); // a live observer acknowledges a stop
    const hook = rig.onSleep;
    rig.onSleep = undefined;
    if (hook) await hook();
    return sleep(ms);
  };
  return rig;
}

describe("Orca board owner record lifecycle, judged by a second OrcaDriver", () => {
  test("reserve: the reservation exists before the split can read its token, an unclaimed reservation is tombstoned so a second OrcaDriver splits afresh, and a record another driver holds under a live observer is never overwritten", async () => {
    const runId = "run-board-reserve";
    const rig = boardRig(runId);
    rig.claim = "never";
    await expect(rig.driver().narrator(rig.repo, rig.command, runId)).rejects.toThrow(/unclaimed board.*indeterminate cleanup refused/);
    expect(rig.atSplit).toMatchObject({ driver: "orca", pane: "", name: formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId }) });
    expect(rig.atSplit?.pid).toBeUndefined();
    const tombstoned = JSON.parse(rig.bytes()) as WatchBoardOwner & { retired?: true };
    expect(tombstoned).toMatchObject({ token: rig.atSplit?.token, retired: true });
    expect(tombstoned.pid).toBeUndefined();

    rig.claim = "at-command-start";
    const fresh = await rig.driver().narrator(rig.repo, rig.command, runId);
    expect(rig.splits()).toBe(2);
    expect(JSON.parse(rig.bytes())).toMatchObject({ pane: fresh.id, pid: process.pid, token: expect.not.stringMatching(tombstoned.token) });

    const foreignRun = "run-board-foreign";
    const foreign = JSON.stringify({
      repo: realpathSync(rig.repo), runId: foreignRun, driver: "herdr", workspace: "ws-1", pane: "p_1",
      name: formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId: foreignRun }), token: randomUUID(), pid: process.pid, armId: "arm-1",
    }) + "\n";
    writeFileSync(rig.boardFile(foreignRun), foreign);
    await expect(rig.driver().narrator(rig.repo, rig.command, foreignRun)).rejects.toThrow(/held by driver herdr/);
    expect(rig.bytes(foreignRun)).toBe(foreign);
    expect(rig.splits()).toBe(2);
  });

  test("claim: the observer's single claim lands on the untouched reservation after the split returns, and a second OrcaDriver reads the claimed record and answers the same pane with no split", async () => {
    const runId = "run-board-claim";
    const rig = boardRig(runId);
    rig.claim = "on-sleep";
    let atClaim: WatchBoardOwner | undefined;
    rig.onSleep = async () => {
      atClaim = JSON.parse(rig.bytes()) as WatchBoardOwner;
      rig.claimNow();
    };
    const slot = await rig.driver().narrator(rig.repo, rig.command, runId);
    expect(atClaim).toMatchObject({ pane: "", token: rig.atSplit?.token });
    expect(atClaim?.pid).toBeUndefined(); // the narrator wrote nothing between reserve and claim
    expect(readWatchBoard(rig.repo, runId)).toMatchObject({ pid: process.pid, pane: slot.id, token: atClaim?.token });

    const again = await rig.driver().narrator(rig.repo, rig.command, runId);
    expect(again.id).toBe(slot.id);
    expect(rig.splits()).toBe(1);
  });

  test("bind: while the first OrcaDriver waits for the claim a second OrcaDriver refuses the unresolved reservation without writing, and the bind changes exactly the pane of the claimed record", async () => {
    const runId = "run-board-bind";
    const rig = boardRig(runId);
    rig.claim = "on-sleep";
    let reserved = "";
    let secondError: unknown;
    let afterSecond = "";
    rig.onSleep = async () => {
      reserved = rig.bytes();
      secondError = await rig.driver().narrator(rig.repo, rig.command, runId).then(() => undefined, (error: unknown) => error);
      afterSecond = rig.bytes();
      rig.claimNow();
    };
    const slot = await rig.driver().narrator(rig.repo, rig.command, runId);
    expect((secondError as Error).message).toMatch(/placement remains unresolved .*\(reserved, no bound pane\)/);
    expect(afterSecond).toBe(reserved);
    const bound = JSON.parse(rig.bytes()) as WatchBoardOwner & { runtimeId?: string };
    expect(typeof bound.armId).toBe("string");
    expect(bound).toEqual({ ...JSON.parse(reserved), pid: process.pid, armId: bound.armId, pane: slot.id, runtimeId: rig.fake.runtimeId });
    expect(rig.splits()).toBe(1);
  });

  test("runtime: a bound handle listed under a different runtime is not the recorded pane — a second OrcaDriver does not answer or close it and places one new claimed board", async () => {
    const runId = "run-board-runtime";
    const rig = boardRig(runId);
    const slot = await rig.driver().narrator(rig.repo, rig.command, runId);
    expect(JSON.parse(rig.bytes()).runtimeId).toBe(rig.fake.runtimeId);
    const launching = rig.fake.of("term_launching")!;
    rig.fake.restart("rt-2", [
      { handle: launching.handle, title: launching.title, worktree: rig.repo, tabId: launching.tabId },
      { handle: slot.id, title: "vim src/index.ts", worktree: rig.repo, tabId: "reused" },
    ]);
    const next = await rig.driver().narrator(rig.repo, rig.command, runId);
    expect(next.id).not.toBe(slot.id);
    expect(rig.fake.of(slot.id)?.title).toBe("vim src/index.ts");
    expect(rig.splits()).toBe(2);
  });

  test("retire: a lost board retired through a second OrcaDriver keeps its token and pane under a tombstone and its pane is closed, and the placing OrcaDriver never answers the lost handle again but splits one new claimed board", async () => {
    const runId = "run-board-retire";
    const rig = boardRig(runId);
    const first = rig.driver();
    const slot = await first.narrator(rig.repo, rig.command, runId);
    const bound = JSON.parse(rig.bytes()) as WatchBoardOwner;
    rig.observer?.close(); // the observer is gone
    rig.observer = undefined;

    await rig.driver().retireLostWatch(slot);
    expect(JSON.parse(rig.bytes())).toEqual({ ...bound, retired: true });
    expect(rig.fake.of(slot.id)).toBeUndefined();

    const fresh = await first.narrator(rig.repo, rig.command, runId);
    expect(fresh.id).not.toBe(slot.id);
    expect(rig.splits()).toBe(2);
    const replaced = JSON.parse(rig.bytes()) as WatchBoardOwner & { retired?: boolean };
    expect(replaced).toMatchObject({ pane: fresh.id, pid: process.pid });
    expect(replaced.token).not.toBe(bound.token);
    expect(replaced.retired).toBeUndefined();
  });

  test("cleanup: a retire or close whose handle-bound close is refused keeps the tombstone, a second OrcaDriver refuses to replace it or split while the pane survives, and once the pane can be closed the second OrcaDriver proves it gone and swaps the tombstone for a new board with exactly one split", async () => {
    const runId = "run-board-cleanup";
    const rig = boardRig(runId);
    const first = rig.driver();
    const slot = await first.narrator(rig.repo, rig.command, runId);
    rig.observer?.close();
    rig.observer = undefined;

    rig.refuseClose = true;
    await expect(first.retireLostWatch(slot)).rejects.toThrow(/close_refused/);
    const tomb = rig.bytes();
    expect(JSON.parse(tomb)).toMatchObject({ retired: true, pane: slot.id });
    const second = rig.driver();
    await expect(second.narrator(rig.repo, rig.command, runId)).rejects.toThrow(/retired board pane .* not proven closed; indeterminate cleanup refused/);
    expect(rig.bytes()).toBe(tomb);
    expect(rig.splits()).toBe(1);
    expect(rig.fake.of(slot.id)).toBeDefined();

    rig.refuseClose = false;
    const next = await second.narrator(rig.repo, rig.command, runId);
    expect(next.id).not.toBe(slot.id);
    expect(rig.fake.of(slot.id)).toBeUndefined();
    expect(rig.splits()).toBe(2);
    expect(JSON.parse(rig.bytes()).token).not.toBe(JSON.parse(tomb).token);

    // close(): the tombstone lands before the stop is acknowledged, so a refused close leaves it too.
    rig.refuseClose = true;
    await expect(rig.driver().close(next)).rejects.toThrow(/close_refused/);
    const closedTomb = rig.bytes();
    expect(JSON.parse(closedTomb)).toMatchObject({ retired: true, pane: next.id });
    await expect(rig.driver().narrator(rig.repo, rig.command, runId)).rejects.toThrow(/not proven closed; indeterminate cleanup refused/);
    expect(rig.bytes()).toBe(closedTomb);
    expect(rig.splits()).toBe(2);
  });

  test("retire: a board the daemon reports lost by a stale beat while its observer pid is still live is asked to stop and, unacknowledged, keeps the tombstone and its pane with no close on the wire; once the observer acknowledges, retirement closes the pane only after the acknowledgement", async () => {
    const runId = "run-board-retire-live";
    const rig = boardRig(runId);
    const slot = await rig.driver().narrator(rig.repo, rig.command, runId);
    const owner = readWatchBoard(rig.repo, runId)!;
    expect(owner.pid).toBe(process.pid); // live pid: the loss came from a stale beat, not a dead owner
    expect(watchBoardAcknowledged(owner)).toBe(false);

    rig.ackStop = false; // a paused observer: stop requested, never acknowledged in the window
    await expect(rig.driver().retireLostWatch(slot)).rejects.toThrow(/unacknowledged/);
    const tomb = rig.bytes();
    expect(JSON.parse(tomb)).toMatchObject({ retired: true, pane: slot.id, token: owner.token });
    expect(rig.fake.countOf("close")).toBe(0);
    expect(rig.fake.of(slot.id)).toBeDefined();
    await expect(rig.driver().narrator(rig.repo, rig.command, runId)).rejects.toThrow(/retired board observer unacknowledged; indeterminate cleanup refused/);
    expect(rig.bytes()).toBe(tomb);

    rig.ackStop = true; // the observer resumes and acknowledges the stop
    const ackedAtClose: boolean[] = [];
    rig.onClose = () => { ackedAtClose.push(watchBoardAcknowledged(owner)); };
    await rig.driver().retireLostWatch(slot);
    expect(ackedAtClose).toEqual([true]);
    expect(rig.fake.of(slot.id)).toBeUndefined();
  });

  test("retire: a run whose Orca board beat goes stale while its owner pid stays live journals watch-board-lost, and the daemon's reopen retires the board through the real OrcaDriver seam without a close on the wire — the tombstone and the pane stay while the stop is unacknowledged and no reopened row appears", async () => {
    const runId = "run-board-stale-live";
    const { repo, fake: adapter } = setupRepo(
      [T("T1", { files: ["ok.txt"] })],
      { tasks: { T1: [{ shell: `sleep 2; echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const launching = "term_launching";
    const orca = new FakeOrca({ terminals: [{ handle: launching, title: "launching-tab", worktree: repo }], trackedWorktrees: [repo] });
    const armId = "arm-paused";
    // The observer claims at command start with THIS process's pid (live), arms presence, then pauses:
    // its beat ages past the stale bound and it never acknowledges a stop.
    const exec: OrcaExec = async (args, cwd, timeoutMs) => {
      const res = await orca.exec(args, cwd, timeoutMs);
      if (args[1] === "split") {
        const dir = join(repo, stateDirName(repo), "supervision");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `watch-board.${runId}.json`), JSON.stringify({ ...readWatchBoard(repo, runId)!, pid: process.pid, armId }) + "\n");
        writeFileSync(join(dir, `watch.live.${armId}`), JSON.stringify({ tier: "watch", id: armId }) + "\n");
        const beat = supervisionBeatPath(repo, "watch");
        writeFileSync(beat, JSON.stringify({ tier: "watch", armId }) + "\n");
        const aged = (Date.now() - SUPERVISION_STALE_MS - 5_000) / 1000;
        utimesSync(beat, aged, aged);
      }
      return res;
    };
    const board = new OrcaDriver({ exec, time: steppedTime(), launchingHandle: launching });
    const inner = new SubprocessDriver();
    const isWatch = (s: Slot) => parseOwnedName(s.name)?.role === "watch";
    const driver = {
      id: "orca",
      interactive: true,
      status: inner.status.bind(inner),
      slot: inner.slot.bind(inner),
      run: inner.run.bind(inner),
      waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner),
      read: inner.read.bind(inner),
      notify: inner.notify.bind(inner),
      worktree: inner.worktree.bind(inner),
      close: (s: Slot) => (isWatch(s) ? board.close(s) : inner.close(s)),
      narrator: board.narrator.bind(board),
      retireLostWatch: board.retireLostWatch.bind(board),
    };

    const summary = await runDaemon(repo, { adapters: [adapter], runId, driver, concurrency: 1 });
    expect(summary.done).toEqual(["T1"]);
    const rows = Journal.open(repo, runId).read();
    const lost = rows.filter((e) => e.event === "watch-board-lost");
    const failed = rows.filter((e) => e.event === "watch-board-reopen-failed");
    const tomb = JSON.parse(readFileSync(join(repo, stateDirName(repo), "supervision", `watch-board.${runId}.json`), "utf8")) as WatchBoardOwner & { retired?: boolean };
    const pane = tomb.pane;
    expect(lost.length).toBeGreaterThan(0);
    expect(lost[0]!.data).toMatchObject({ pane, pid: process.pid });
    expect(lost[0]!.data.beatAgeMs as number).toBeGreaterThan(SUPERVISION_STALE_MS);
    expect(rows.filter((e) => e.event === "watch-board-reopened")).toEqual([]);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.data.error).toMatch(/unacknowledged/);
    expect(tomb).toMatchObject({ retired: true, pid: process.pid, armId });
    expect(watchBoardAcknowledged(tomb)).toBe(false);
    expect(orca.calls.filter((c) => c[1] === "close")).toEqual([]);
    expect(orca.of(pane)).toBeDefined();
  }, 60_000);

  test("cleanup: close that times out waiting for a live observer keeps the tombstone, and a second OrcaDriver refuses to close or replace it while acknowledgement remains false", async () => {
    const runId = "run-board-unacked";
    const rig = boardRig(runId);
    const slot = await rig.driver().narrator(rig.repo, rig.command, runId);
    const owner = readWatchBoard(rig.repo, runId)!;
    expect(owner.pid).toBe(process.pid);
    expect(watchBoardAcknowledged(owner)).toBe(false);
    rig.ackStop = false;
    await expect(rig.driver().close(slot)).rejects.toThrow(/unacknowledged/);
    const tomb = rig.bytes();
    expect(JSON.parse(tomb)).toMatchObject({ retired: true, pane: slot.id, token: owner.token });
    expect(watchBoardAcknowledged({ ...owner, ...JSON.parse(tomb) })).toBe(false);
    expect(rig.fake.of(slot.id)).toBeDefined();
    const splits = rig.splits();
    await expect(rig.driver().narrator(rig.repo, rig.command, runId)).rejects.toThrow(/retired board observer unacknowledged; indeterminate cleanup refused/);
    expect(rig.bytes()).toBe(tomb);
    expect(rig.splits()).toBe(splits);
    expect(rig.fake.of(slot.id)).toBeDefined();
    expect(watchBoardAcknowledged({ ...owner, ...JSON.parse(tomb) })).toBe(false);
  });
});

describe("Orca board CAS keeps the canonical record readable", () => {
  const sample = (pane: string, token: string) => ({
    repo: "/tmp/cas-board", runId: "run-cas", driver: "orca" as const, workspace: "orca",
    pane, name: "watch:run:0:run-cas", token,
  });

  test("a competing reader never observes absence or empty bytes while swaps commit, a leftover tmp does not drop the record, and a lock holder excludes a second writer until release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-board-cas-"));
    const path = join(dir, "watch-board.json");
    try {
      let expected = JSON.stringify(sample("p0", "t0")) + "\n";
      writeFileSync(path, expected);

      const reader = spawn(process.execPath, ["-e", `
        const { existsSync, readFileSync } = require("node:fs");
        const path = ${JSON.stringify(path)};
        const end = Date.now() + 1500;
        while (Date.now() < end) {
          if (!existsSync(path)) { process.stdout.write("ABSENT"); process.exit(2); }
          const raw = readFileSync(path, "utf8");
          if (!raw.trim()) { process.stdout.write("EMPTY"); process.exit(3); }
          JSON.parse(raw);
        }
        process.stdout.write("OK");
      `], { stdio: ["ignore", "pipe", "pipe"] });
      const readerDone = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        let out = "";
        let err = "";
        reader.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        reader.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
        reader.on("close", (code) => resolve({ code, out, err }));
      });

      for (let i = 1; i <= 80; i++) {
        const next = sample(`p${i}`, `t${i}`);
        expected = await casBoard("split", path, expected, next);
      }
      writeFileSync(`${path}.${randomUUID()}.tmp`, JSON.stringify(sample("orphan", "tmp")) + "\n");
      expected = await casBoard("split", path, expected, sample("after-tmp", "t-after"));
      expect(JSON.parse(readFileSync(path, "utf8")).pane).toBe("after-tmp");

      const lock = `${path}.lock`;
      mkdirSync(lock);
      symlinkSync(`${process.pid}:fixture-live-holder`, join(lock, "owner.0"));
      const blocked = spawn(process.execPath, ["-e", `
        const { existsSync } = require("node:fs");
        const path = ${JSON.stringify(path)};
        const lock = path + ".lock";
        const end = Date.now() + 800;
        while (Date.now() < end) {
          if (!existsSync(path)) { process.stdout.write("ABSENT"); process.exit(2); }
        }
        process.stdout.write(existsSync(lock) ? "HELD" : "GONE");
      `], { stdio: ["ignore", "pipe", "pipe"] });
      const blockedDone = new Promise<{ code: number | null; out: string }>((resolve) => {
        let out = "";
        blocked.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        blocked.on("close", (code) => resolve({ code, out }));
      });
      const started = Date.now();
      await expect(casBoard("split", path, expected, sample("locked", "t-lock"))).rejects.toThrow(/lock not acquired; current record kept/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
      expect(JSON.parse(readFileSync(path, "utf8")).pane).toBe("after-tmp");
      rmSync(lock, { recursive: true, force: true });
      await casBoard("split", path, expected, sample("unlocked", "t-unlock"));
      expect(JSON.parse(readFileSync(path, "utf8")).pane).toBe("unlocked");

      const readResult = await readerDone;
      expect(readResult.out, readResult.err).toBe("OK");
      expect(readResult.code).toBe(0);
      const held = await blockedDone;
      expect(held.out).toBe("HELD");
      expect(held.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("competing-narrator: two OrcaDriver narrator calls for the same run produce exactly one split and one claimed board, the loser refuses, and the canonical record never vanishes", async () => {
    const runId = "run-board-compete";
    const rig = boardRig(runId);
    const results = await Promise.allSettled([
      rig.driver().narrator(rig.repo, rig.command, runId),
      rig.driver().narrator(rig.repo, rig.command, runId),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<OrcaDriver["narrator"]>>> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0].reason as Error).message).toMatch(/placement remains unresolved|changed underneath|lock not acquired|held by driver/);
    expect(rig.splits()).toBe(1);
    expect(existsSync(rig.boardFile(runId))).toBe(true);
    expect(JSON.parse(rig.bytes())).toMatchObject({ pane: won[0].value.id, pid: process.pid });
  });

  test("interrupted-transition: a leftover tmp and lock beside the canonical record leave it readable, and after the lock is cleared a later swap recovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tkr-board-interrupt-"));
    const path = join(dir, "watch-board.json");
    try {
      const previous = JSON.stringify(sample("still-here", "t-prev")) + "\n";
      writeFileSync(path, previous);
      writeFileSync(`${path}.${randomUUID()}.tmp`, JSON.stringify(sample("uncommitted", "t-tmp")) + "\n");
      mkdirSync(`${path}.lock`);
      symlinkSync(`${process.pid}:fixture-live-holder`, join(`${path}.lock`, "owner.0"));
      await expect(casBoard("split", path, previous, sample("stolen", "t-steal"))).rejects.toThrow(/lock not acquired; current record kept/);
      expect(readFileSync(path, "utf8")).toBe(previous);
      rmSync(`${path}.lock`, { recursive: true, force: true });
      await casBoard("split", path, previous, sample("recovered", "t-rec"));
      expect(JSON.parse(readFileSync(path, "utf8")).pane).toBe("recovered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
