import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { HerdrAppDriver, OWNER_LABEL, REPO_LABEL, SPACE_LABEL, TAB_LABEL } from "../../src/drivers/herdr-app.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, parseOwnedName, type ExecutorDriver, type Slot, type SlotOpts } from "../../src/drivers/types.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { FakeHerdrApp, type FakeTerm } from "../helpers/fake-herdr-app.js";
import { COMMIT, makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract P through the daemon's EXISTING resume-harvest seam (OBS-1109/OBS-1203): a fresh
// daemon binds the interrupted attempt's terminal through the real HerdrAppDriver's read-only adopt over an executable
// hc fake, and reads its retained trailer. The terminal shapes follow the captured R1 alt-exit probe (finished, history
// incomplete, complete screen holding the trailer). The recovery dispatch itself runs headless; gate and merge logic
// are the daemon's own, unchanged.

afterAll(() => reapTestTempDirs());

describe("HerdrAppDriver through the daemon's resume harvest (contract P)", () => {
  const fake2 = { adapter: "fake", model: "fake-2", channel: "api" as const, tier: "frontier" as const };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  test("daemon resume harvest accepts a retained finished owned trailer while an identical trailer in a foreign checkout cannot satisfy that worker", async () => {
    for (const mode of ["owned", "foreign-checkout"] as const) {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [
        { shell: `echo redo > redo.txt && ${COMMIT} redo`, result: { ok: true, summary: "redone" } },
      ] } });
      const runId = `run-herdr-app-harvest-${mode}`;
      const base = await gitHead(repo);
      const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
      writeFileSync(join(wt, "harvest.txt"), "finished before the daemon died\n");
      git(wt, "add", "-A");
      git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "finished work");
      const journal = Journal.create(repo, runId);
      journal.append("run-start", undefined, { baseRef: base, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
      writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
      const nonce = "5a5a5a5a";
      const dispatchScript = join(journal.dir, "T1-a0.sh");
      writeFileSync(dispatchScript, "sleep 30\n");
      // the dead daemon's journaled slot: its id belonged to THAT driver instance and is never trusted here
      const slot = { id: "hc-1", name: formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId }), cwd: wt };
      journal.append("task-dispatch", "T1", { assignment: fake2, attempt: 0, workerDispatchOrdinal: 0, retryMode: "fresh" });
      journal.append("worker-launch", "T1", { attempt: 0, retryMode: "fresh", nonce, dispatchScript, driver: "herdr-app", slot });

      // The core outlived the daemon: one finished terminal retains the worker's trailer. Owned: in the task checkout.
      // Foreign checkout: the identical owner label, repo and trailer, but the terminal sits in the main checkout.
      const trailer = `TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"t1 finished before the daemon died","deviations":[]}`;
      const f = new FakeHerdrApp(makeTestTempDir("hcapp-harvest-"));
      const term: FakeTerm = {
        address: "t1", argv: ["bash", "-lc", "worker"], cwd: realpathSync(mode === "owned" ? wt : repo),
        labels: { [OWNER_LABEL]: slot.name, [REPO_LABEL]: realpathSync(join(repo, ".git")) }, state: "finished", parent: null,
        die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: 0, signal: null, reason: "exited", pid: null, turn: 0,
        screen: { text: `ALT_FINISHED\n${trailer}`, complete: true }, history: { text: `working…\n${trailer}`, complete: false },
      };
      f.update((s) => { s.terminals.t1 = term; });

      // The interrupted attempt's terminal is bound through the REAL HerdrAppDriver; a recovery dispatch runs headless.
      const app = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH } });
      const inner = new SubprocessDriver();
      const adopted = new Set<Slot>();
      const driver: ExecutorDriver = {
        id: "herdr-app", interactive: false,
        slot: inner.slot.bind(inner),
        adopt: async (s: Slot) => { const a = await app.adopt(s); adopted.add(a); return a; },
        read: (s: Slot, lines: number) => adopted.has(s) ? app.read(s, lines) : inner.read(s, lines),
        close: (s: Slot) => adopted.has(s) ? app.close(s) : inner.close(s),
        run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
        status: inner.status.bind(inner), notify: inner.notify.bind(inner), worktree: inner.worktree.bind(inner),
      } as ExecutorDriver;
      const s = await runDaemon(repo, { adapters: [fake], runId, resume: true, driver });
      expect(s.done, mode).toEqual(["T1"]);
      const all = journal.read();
      const post = all.slice(all.findIndex((e) => e.event === "run-resume") + 1);
      // Adoption never creates, labels or types: no terminal is created, no window touched, nothing sent.
      expect(f.calls().filter((c) => c.tool === "herdr-app" || ["run", "label", "keep", "send", "keys"].includes(c.argv[0]!)), mode).toEqual([]);

      if (mode === "owned") {
        expect(f.hcCalls("read").length).toBeGreaterThan(0);
        expect(f.hcCalls("read").every((a) => a[1] === "t1")).toBe(true);
        const harvests = post.filter((e) => e.event === "worker-result-harvested");
        expect(harvests).toHaveLength(1);
        expect(harvests[0]!.data).toMatchObject({ attempt: 0, source: "resume", trailer: true, summary: "t1 finished before the daemon died" });
        expect(post.find((e) => e.event === "worker-result")!.data).toMatchObject({ finished: true, ok: true, attempt: 0, source: "resume" });
        expect(post.filter((e) => e.event === "task-dispatch" || e.event === "worker-launch" || e.event === "resume-harvest-declined")).toEqual([]);
        expect(post.find((e) => e.event === "task-done")!.data.assignment).toEqual(fake2);
        expect(git(repo, "show", `tickmarkr/${runId}:harvest.txt`)).toBe("finished before the daemon died");
        expect(() => git(repo, "show", `tickmarkr/${runId}:redo.txt`)).toThrow();
        continue;
      }
      // The identical trailer in a foreign checkout is never read as this worker: declined before any read, the
      // terminal untouched, and the task recovers through an ordinary fresh dispatch that redoes the work.
      const declined = post.findIndex((e) => e.event === "resume-harvest-declined");
      expect(post[declined]!.data).toEqual({ attempt: 0,
        reason: expect.stringMatching(/^pane unreadable: herdr-app adopt: t1 owned by \S+ sits in .*, not the task checkout .*; foreign$/) });
      expect(f.hcCalls("read")).toEqual([]);
      expect([...f.hcCalls("kill"), ...f.hcCalls("rm")]).toEqual([]);
      expect(f.read().terminals.t1).toBeDefined();
      expect(post.filter((e) => ["worker-result-harvested", "worker-process-reaped"].includes(e.event) && e.data.attempt === 0)).toEqual([]);
      expect(post.some((e) => e.event === "worker-result" && e.data.source === "resume")).toBe(false);
      const dispatches = post.filter((e) => e.event === "task-dispatch");
      expect(dispatches.map((e) => e.data.attempt)).toEqual([1]);
      expect(post.indexOf(dispatches[0]!)).toBeGreaterThan(declined);
      expect(git(repo, "show", `tickmarkr/${runId}:redo.txt`)).toBe("redo");
    }
  }, 180_000);

  test("daemon resume with a retained visible worker places that task's later roles in the adopted worker's tab", async () => {
    // Both recovery shapes: the retained worker carries the app's herdr.tab label, or only the exact layout row maps it.
    for (const mode of ["tab label", "layout row only"] as const) {
      // The REAL HerdrAppDriver is the whole resumed daemon's driver: it adopts the interrupted T1 worker, retained in
      // its own task tab, and then creates T1's judge and review — which must join that tab, never open a second one.
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo redo > redo.txt && ${COMMIT} redo`, result: { ok: true, summary: "redone" } }] } },
        "visibility: { llm: pane }\n");
      const runId = "run-herdr-app-resume-tab";
      const base = await gitHead(repo);
      const wt = await new SubprocessDriver().worktree(repo, `tickmarkr/${runId}--T1`, base);
      writeFileSync(join(wt, "harvest.txt"), "finished before the daemon died\n");
      git(wt, "add", "-A");
      git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--no-gpg-sign", "-qm", "finished work");
      const journal = Journal.create(repo, runId);
      journal.append("run-start", undefined, { baseRef: base, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
      writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
      const nonce = "6b6b6b6b";
      const dispatchScript = join(journal.dir, "T1-a0.sh");
      writeFileSync(dispatchScript, "sleep 30\n");
      const slot = { id: "hc-1", name: formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId }), cwd: wt };
      journal.append("task-dispatch", "T1", { assignment: fake2, attempt: 0, workerDispatchOrdinal: 0, retryMode: "fresh" });
      journal.append("worker-launch", "T1", { attempt: 0, retryMode: "fresh", nonce, dispatchScript, driver: "herdr-app", slot });
      const trailer = `TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"t1 finished before the daemon died","deviations":[]}`;
      const blank = { argv: [], parent: null, die_with_parent: false, notify: false, keep: false, reported: false, status: null, turn: 0 };
      const f = new FakeHerdrApp(makeTestTempDir("hcapp-resume-tab-"), { execute: true, app: { window: true, nextTab: 0, spaces: [
        { id: "spA", name: "tickmarkr", tabs: [{ id: "tbORCH", name: "ORCH", terminals: ["t100"] }, { id: "tbW", name: "T1", terminals: ["t50"] }] },
      ] } });
      f.update((s) => {
        s.terminals.t100 = { ...blank, address: "t100", cwd: "/", labels: { [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" }, state: "live", exit_code: null,
          signal: null, reason: null, pid: 1, screen: { text: "", complete: true }, history: { text: "", complete: true } };
        s.terminals.t50 = { ...blank, address: "t50", cwd: realpathSync(wt), state: "finished", exit_code: 0, signal: null, reason: "exited", pid: null,
          labels: { [OWNER_LABEL]: slot.name, [REPO_LABEL]: realpathSync(join(repo, ".git")), [SPACE_LABEL]: "spA", ...(mode === "tab label" ? { [TAB_LABEL]: "tbW" } : {}) },
          screen: { text: `ALT_FINISHED\n${trailer}`, complete: true }, history: { text: `working…\n${trailer}`, complete: false } };
      });
      const app = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, runId, pollMs: 30,
        env: { PATH: process.env.PATH, HC_TERMINAL_ID: "t100", HC_TERMINAL_SOCKET: f.read().socket } });
      const s = await runDaemon(repo, { adapters: [fake], runId, resume: true, driver: app, approvalWindowMs: 1 });
      expect(s.done, mode).toEqual(["T1"]);
      const post = journal.read().slice(journal.read().findIndex((e) => e.event === "run-resume") + 1);
      expect(post.filter((e) => e.event === "worker-result-harvested")).toHaveLength(1);
      expect(post.filter((e) => e.event === "task-dispatch")).toEqual([]); // harvested, never redone

      const label = (argv: string[], key: string): string | undefined => argv.find((a, i) => argv[i - 1] === "--label" && a.startsWith(`${key}=`))?.slice(key.length + 1);
      const created = f.hcCalls("run").map((argv) => ({ owner: parseOwnedName(label(argv, OWNER_LABEL) ?? "")!, space: label(argv, SPACE_LABEL), tab: label(argv, TAB_LABEL) }));
      const later = created.filter((c) => c.owner.taskId === "T1");
      expect(later.map((c) => c.owner.role).sort()).toEqual(["judge", "review"]);
      expect(later.map((c) => [c.space, c.tab]), mode).toEqual(later.map(() => ["spA", "tbW"]));
      expect(f.calls().filter((c) => c.tool === "herdr-app" && c.argv[1] === "tab.rename")).toEqual([]); // no second tab to name
    }
  }, 180_000);

  test("daemon-dispatched task roles are placed in their own task's tab while separate tasks sharing the workers group never combine", async () => {
    // The REAL HerdrAppDriver drives the whole daemon: every worker, judge and review terminal is created by the
    // executable hc fake (which runs it), shown by the fake window, and read back through the driver's own seams.
    const { repo, fake } = setupRepo([T("T1"), T("T2")], { tasks: {
      T1: [{ shell: `echo one > one.txt && ${COMMIT} one`, result: { ok: true, summary: "one" } }],
      T2: [{ shell: `echo two > two.txt && ${COMMIT} two`, result: { ok: true, summary: "two" } }],
    } }, "visibility: { llm: pane }\n");
    const runId = "run-herdr-app-placement";
    const f = new FakeHerdrApp(makeTestTempDir("hcapp-place-"), { execute: true, app: { window: true, nextTab: 0, spaces: [
      { id: "spA", name: "tickmarkr", tabs: [{ id: "tbORCH", name: "ORCH", terminals: ["t100"] }] },
    ] } });
    f.update((s) => {
      s.terminals.t100 = { address: "t100", argv: [], cwd: "/", labels: { [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" }, state: "live", parent: null,
        die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: null, signal: null, reason: null, pid: 1, turn: 0,
        screen: { text: "", complete: true }, history: { text: "", complete: true } };
    });
    const app = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, runId, pollMs: 30,
      env: { PATH: process.env.PATH, HC_TERMINAL_ID: "t100", HC_TERMINAL_SOCKET: f.read().socket } });
    const slots: { name: string; group?: string }[] = [];
    const slot = app.slot.bind(app);
    vi.spyOn(app, "slot").mockImplementation((cwd: string, name: string, opts?: SlotOpts) => {
      slots.push({ name, ...(opts?.group ? { group: opts.group } : {}) });
      return slot(cwd, name, opts);
    });
    const s = await runDaemon(repo, { adapters: [fake], runId, driver: app, approvalWindowMs: 1 });
    expect(s.done.sort()).toEqual(["T1", "T2"]);
    // The daemon gave both workers its ONE shared group: the group is never the task identity.
    expect(slots.filter((x) => x.group === "workers")).toHaveLength(2);

    const label = (argv: string[], key: string): string | undefined => argv.find((a, i) => argv[i - 1] === "--label" && a.startsWith(`${key}=`))?.slice(key.length + 1);
    const created = f.hcCalls("run").map((argv) => ({ owner: parseOwnedName(label(argv, OWNER_LABEL) ?? "")!, space: label(argv, SPACE_LABEL), tab: label(argv, TAB_LABEL) }));
    const renames = f.calls().filter((c) => c.tool === "herdr-app" && c.argv[1] === "tab.rename").map((c) => c.argv);
    const tabs: string[] = [];
    for (const task of ["T1", "T2"]) {
      const mine = created.filter((c) => c.owner.taskId === task);
      // Every task role the daemon dispatched for this task landed here: the worker first, then its judge and review.
      expect(mine.map((c) => c.owner.role).sort(), task).toEqual(["judge", "review", "worker"]);
      expect(mine[0]!.owner.role, task).toBe("worker");
      expect(mine.every((c) => c.space === "spA"), task).toBe(true);
      // The first slot carries the space only; every later role carries the tab recorded from that first slot.
      expect(mine[0]!.tab, task).toBeUndefined();
      const tab = mine[1]!.tab!;
      expect(tab, task).toMatch(/^tb\d+$/);
      expect(mine.slice(1).map((c) => c.tab), task).toEqual(mine.slice(1).map(() => tab));
      expect(renames, task).toContainEqual(["do", "tab.rename", "--id", tab, "--name", task]);
      tabs.push(tab);
    }
    expect(tabs[0]).not.toBe(tabs[1]); // separate tasks in the shared workers group never combine
    expect(created.every((c) => c.tab !== "tbORCH")).toBe(true); // never the anchor's own (active) tab
  }, 180_000);
});
