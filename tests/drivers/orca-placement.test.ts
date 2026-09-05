import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalWorktreePath, OrcaDriver, OrcaError, OrcaUnavailableError, PENDING_PROJECT_GRACE_MS } from "../../src/drivers/orca.js";
import { formatOwnedName, panesToClose, type ExecutorDriver } from "../../src/drivers/types.js";
import { createWorktree, worktreePath } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { FakeOrca, steppedTime, type FakeTerminalSpec } from "../helpers/fake-orca.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

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

function rig(opts: ConstructorParameters<typeof FakeOrca>[0] = {}): { fake: FakeOrca; driver: OrcaDriver } {
  const fake = new FakeOrca(opts);
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
    expect(fake.workspaceStatuses.get(canonicalWorktreePath(midDispatchWorktree))).toBe("in-progress");

    await driver.slot(neverWorktree, "legacy-never", {
      owned: { role: "worker", taskId: neverTaskId, attempt: 0, runId },
    });
    expect(fake.countOf("worktree-set")).toBe(1);
    expect(fake.workspaceStatuses.has(canonicalWorktreePath(neverWorktree))).toBe(false);
    await driver.reconcile(new Set(), runId);
    expect(Journal.open(repo, runId).read().filter((row) => row.event === "project-unplaced"))
      .toHaveLength(1);
  });

  test("test: the first run on a slot issues terminal create only after worktree current answers the slot's canonical path so a fixture that refuses selector_not_found or answers the enclosing checkout for the first three probes still binds on the fourth with a worktree-adoption-wait journal row carrying the milliseconds when the wait exceeded 2 s and a fixture that never answers within 60 s fails the dispatch loudly whereas a driver that creates before the path is answered fails", async () => {
    const repo = makeRepo({ "adoption.txt": "ready\n" });
    const runId = "run-orca-adoption";
    const branch = `tickmarkr/${runId}--TA`;
    const target = worktreePath(repo, branch);
    const journal = Journal.create(repo, runId);
    journal.append("task-dispatch", "TA", { attempt: 0 });

    const fake = new FakeOrca({
      worktreeCurrentAnswers: ["selector_not_found", repo, repo, target],
    });
    const driver = new OrcaDriver({ exec: fake.exec, time: steppedTime() });
    const worktree = await driver.worktree(repo, branch, "HEAD");
    const expected = canonicalWorktreePath(worktree);
    const slot = await driver.slot(worktree, "legacy", {
      owned: { role: "worker", taskId: "TA", attempt: 0, runId },
    });
    await driver.run(slot, "run-after-adoption");

    const currentIndexes = fake.calls.flatMap((call, index) =>
      call[0] === "worktree" && call[1] === "current" ? [index] : []);
    const createIndex = fake.calls.findIndex((call) => call[0] === "terminal" && call[1] === "create");
    expect(currentIndexes).toHaveLength(4);
    expect(createIndex).toBeGreaterThan(currentIndexes.at(-1)!);
    expect(currentIndexes.map((index) => fake.callCwds[index])).toEqual([expected, expected, expected, expected]);
    expect(fake.last()?.worktree).toBe(expected);
    const wait = Journal.open(repo, runId).read().filter((row) => row.event === "worktree-adoption-wait");
    expect(wait).toHaveLength(1);
    expect(wait[0]).toMatchObject({ taskId: "TA", data: { milliseconds: 3_000 } });

    const neverRunId = "run-orca-adoption-never";
    const neverBranch = `tickmarkr/${neverRunId}--TB`;
    const neverJournal = Journal.create(repo, neverRunId);
    neverJournal.append("task-dispatch", "TB", { attempt: 0 });
    const never = new FakeOrca({ worktreeCurrentAnswers: [repo] });
    const neverDriver = new OrcaDriver({ exec: never.exec, time: steppedTime() });
    const neverWorktree = await neverDriver.worktree(repo, neverBranch, "HEAD");
    const neverSlot = await neverDriver.slot(neverWorktree, "legacy", {
      owned: { role: "worker", taskId: "TB", attempt: 0, runId: neverRunId },
    });
    const error = await neverDriver.run(neverSlot, "must-not-run").then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(OrcaUnavailableError);
    expect((error as OrcaUnavailableError).family).toBe("worktree-current");
    expect((error as Error).message).toContain("within 60000ms");
    expect(never.countOf("create")).toBe(0);
    expect(never.countOf("worktree-current")).toBeGreaterThan(1);
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
      ["terminal", "create", "--worktree", `path:${WT_A}`, "--title", TITLE_A, "--command", "run-a", "--json"],
      ["terminal", "create", "--worktree", `path:${WT_B}`, "--title", TITLE_B, "--command", "run-b", "--json"],
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
    expect((uiErr as OrcaError).message).toContain(`create receipt bound to ${WT_A}, not the slot's ${WT_B}`);
    expect(uiFake.calls.filter((c) => c[1] === "create").map((c) => c[3])).toEqual(["active", "active"]); // both ASKED for A
    // …and refusing the receipt is not on its own fail-closed: `terminal create` had already
    // LAUNCHED run-b in A. The wrong-checkout terminal is closed and the slot latched, so nothing
    // is left mutating A and a retrying dispatch cannot open a second one beside it.
    expect(uiFake.calls.filter((c) => c[1] === "close").map((c) => c[3])).toEqual(["term_2"]);
    expect(uiFake.terminals.map((t) => [t.handle, t.worktree])).toEqual([["term_1", WT_A]]);
    const retry = await uiDriver.run(uiB, "run-b").then(() => undefined, (e: unknown) => e);
    expect(retry).toBeInstanceOf(OrcaUnavailableError);
    expect(uiFake.countOf("create")).toBe(2);

    // Control 2 — the daemon's cwd. Adoption itself now refuses this placement before create: a
    // current answer from the daemon checkout is never evidence that either slot checkout exists.
    const daemonFake = new FakeOrca();
    const daemonDriver = ambientSelector(daemonFake, "current", DAEMON_CWD);
    const dA = await daemonDriver.slot(WT_A, TITLE_A);
    const dB = await daemonDriver.slot(WT_B, TITLE_B);
    for (const [slot, wt] of [[dA, WT_A], [dB, WT_B]] as const) {
      const err = await daemonDriver.run(slot, "run").then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(OrcaError);
      expect((err as OrcaError).message).toContain(`Orca did not adopt ${wt}`);
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
      ["terminal", "create", "--worktree", `path:${WT_A}`, "--title", TITLE_A, "--command", "bash -lc 'first'", "--json"],
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
      { handle: "t_desired", title: DESIRED, worktree: WT_A },
      { handle: "t_undesired", title: UNDESIRED, worktree: WT_A },
      { handle: "t_old", title: OLD, worktree: WT_GONE },
      { handle: "t_foreign", title: FOREIGN, worktree: WT_A, paneTitle: "psql" },
      { handle: "t_lookalike", title: "vim src/index.ts", worktree: WT_A, paneTitle: UNDESIRED, tabId: "t_undesired-tab" },
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
    expect(fake.terminals.map((t) => t.handle).sort()).toEqual(["t_desired", "t_foreign", "t_lookalike", "t_old"].sort());

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
      const { fake, driver } = rig();
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
});
