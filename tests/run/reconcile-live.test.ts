// OBS-17 T2: live reconciliation — the daemon sweeps tickmarkr-owned panes to the journal-derived
// desired set at every safe point, and the herdr driver closes owned-but-undesired panes plus the
// tabs those closes emptied. Foreign panes, operator tabs, and other workspaces are never touched.
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { formatOwnedName, parseOwnedName, type ExecutorDriver, type OwnedName, type Slot, type SlotOpts } from "../../src/drivers/types.js";
import { rolePaneNameFromPrompt } from "../../src/gates/llm.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const owned = (role: OwnedName["role"], taskId: string, attempt: number, runId: string) =>
  formatOwnedName({ role, taskId, attempt, runId });

// ---- herdr stub: agent list / pane list backed by files so pane close is observable ------------
interface StubAgent { name?: string; pane_id: string; tab_id: string; workspace_id: string }

function makeReconcileStub(agents: StubAgent[], opts: { listFails?: boolean; listGarbage?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-reconcile-"));
  const log = join(dir, "log.txt");
  // herdr 0.7.5: reconcile reads ownership off `pane list` labels (not `agent list`). The registry
  // carries "<pane_id>|<tab_id>|<label>|<workspace_id>" so a pane close is observable and reconcile
  // can decide ownership per pane. Nameless shells register an empty label (foreign → never closed).
  const panesFile = join(dir, "panes.txt");
  writeFileSync(panesFile, agents.map((a) => `${a.pane_id}|${a.tab_id}|${a.name ?? ""}|${a.workspace_id}`).join("\n") + "\n");
  const paneList = opts.listFails
    ? "exit 1"
    : opts.listGarbage
      ? "printf 'not json'"
      : `{ printf '{"result":{"panes":['; sep=""; while IFS='|' read -r pid tid label ws; do [ -n "$pid" ] || continue; printf '%s{"pane_id":"%s","tab_id":"%s","label":"%s","workspace_id":"%s"}' "$sep" "$pid" "$tid" "$label" "$ws"; sep=","; done < '${panesFile}'; printf ']}}\\n'; }`;
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "pane list") ${paneList} ;;
  "pane rename") printf '%s||%s|wT\\n' "$3" "$4" >> '${panesFile}'; echo '{}' ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"w1:p7"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:tN"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  "pane close") grep -v "^$3|" '${panesFile}' > '${panesFile}.tmp' 2>/dev/null || :; mv '${panesFile}.tmp' '${panesFile}' 2>/dev/null || :; echo '{}' ;;
  "pane wait-output") exit 0 ;;
  "agent wait") exit 0 ;;
  "pane read") printf 'line1\\nTICKMARKR_EXIT:0\\n' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log: () => readFileSync(log, "utf8") };
}

let _wsPrev: string | undefined;
let _panePrev: string | undefined;
beforeEach(() => {
  _wsPrev = process.env.HERDR_WORKSPACE_ID;
  _panePrev = process.env.HERDR_PANE_ID;
  process.env.HERDR_WORKSPACE_ID = "wT";
  process.env.HERDR_PANE_ID = "wT:pCALLER";
});
afterEach(() => {
  if (_wsPrev !== undefined) process.env.HERDR_WORKSPACE_ID = _wsPrev;
  else delete process.env.HERDR_WORKSPACE_ID;
  if (_panePrev !== undefined) process.env.HERDR_PANE_ID = _panePrev;
  else delete process.env.HERDR_PANE_ID;
});

const RUN = "run-now";
const fleet: StubAgent[] = [
  { name: owned("worker", "T2", 1, RUN), pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "wT" }, // desired — keep
  { name: owned("worker", "T2", 0, RUN), pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "wT" }, // superseded — close
  { name: owned("worker", "T9", 0, "run-old"), pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "wT" }, // older run — close + tab
  { name: "orchestrator", pane_id: "w1:p4", tab_id: "w1:t3", workspace_id: "wT" }, // foreign — never
  { pane_id: "w1:p4b", tab_id: "w1:t3", workspace_id: "wT" }, // nameless shell — never
  { name: owned("consult", "T5", 0, RUN), pane_id: "w1:p5", tab_id: "w1:t4", workspace_id: "wT" }, // same-run consult
  { name: owned("worker", "T1", 0, RUN), pane_id: "w2:p6", tab_id: "w2:t5", workspace_id: "wZ" }, // other workspace — never
];

describe("HerdrDriver.reconcile (stubbed binary)", () => {
  test("closes owned-but-undesired panes (superseded attempt + older run) and only the tabs those closes emptied", async () => {
    const { bin, log } = makeReconcileStub(fleet);
    const d = new HerdrDriver(bin);
    await d.reconcile(new Set([owned("worker", "T2", 1, RUN)]), RUN, { spareLiveLlm: true });
    const calls = log();
    expect(calls).toContain("pane close w1:p1"); // superseded attempt of the current run
    expect(calls).toContain("pane close w1:p3"); // leftover from an OLDER run of the same repo
    expect(calls).toContain("tab close w1:t2"); // p3's tab emptied by the close → reaped
    expect(calls).not.toContain("tab close w1:t1"); // desired sibling p2 keeps its tab alive
    expect(calls).not.toContain("pane close w1:p2"); // desired
    expect(calls).not.toContain("pane close w1:p4"); // foreign agent (operator's)
    expect(calls).not.toContain("pane close w1:p4b"); // nameless pane
    expect(calls).not.toContain("pane close w1:p5"); // same-run consult spared mid-run (journal-invisible while live)
    expect(calls).not.toContain("pane close w2:p6"); // another workspace — never left
    expect(calls).not.toContain("tab close w1:t3");
    expect(calls).not.toContain("tab close w1:t4");
  });

  test("boundary sweep (no spareLiveLlm) takes same-run consult/judge/review panes too", async () => {
    const { bin, log } = makeReconcileStub(fleet);
    const d = new HerdrDriver(bin);
    await d.reconcile(new Set([owned("worker", "T2", 1, RUN)]), RUN);
    expect(log()).toContain("pane close w1:p5");
    expect(log()).toContain("tab close w1:t4");
  });

  test("never throws: herdr gone (agent list fails) and garbage listings both resolve quietly", async () => {
    const dead = new HerdrDriver(makeReconcileStub(fleet, { listFails: true }).bin);
    await expect(dead.reconcile(new Set(), RUN)).resolves.toBeUndefined();
    const garbage = new HerdrDriver(makeReconcileStub(fleet, { listGarbage: true }).bin);
    await expect(garbage.reconcile(new Set(), RUN)).resolves.toBeUndefined();
  });

  test("narrator with a runId names the right-split watch pane canonically (T2 ownership contract)", async () => {
    const { bin, log } = makeReconcileStub([]);
    const d = new HerdrDriver(bin);
    await d.narrator("/tmp", "tickmarkr status --watch", RUN);
    expect(log()).toContain("pane split wT:pCALLER --direction right --no-focus");
    expect(log()).toContain(`pane rename w1:p7 ${owned("watch", "run", 0, RUN)}`);
  });
});

// llm.ts retry-suffix fold: a canonical fallback + run-gates' "-r1" stays contract-parseable
test("rolePaneNameFromPrompt folds -r1 on a canonical name into attempt+1", () => {
  const base = owned("judge", "T4", 0, RUN);
  expect(rolePaneNameFromPrompt("TICKMARKR-JUDGE\n## Task T4: x", `${base}-r1`)).toBe(owned("judge", "T4", 1, RUN));
  expect(rolePaneNameFromPrompt("TICKMARKR-JUDGE\n## Task T4: x", base)).toBe(base);
  expect(parseOwnedName(rolePaneNameFromPrompt("TICKMARKR-JUDGE\n## Task T4: x", `${base}-r1`))).not.toBeNull();
});

// ---- daemon-level: a reconciling fake driver over the subprocess driver -------------------------
// capWaitMs: bound every waitOutput so a post-termination zombie wait (e.g. the judge's 900s
// window polling a closed slot's stale buffer) dies within seconds of the test ending.
function paneWorld(seed: string[] = [], opts: { missClose?: boolean; capWaitMs?: number } = {}) {
  const inner = new SubprocessDriver();
  const live = new Set<string>(seed); // pane names — canonical when the call site passed `owned`
  const byId = new Map<string, string>();
  const ops: { kind: "slot" | "close"; name: string }[] = [];
  const sweeps: { desired: string[]; closed: string[] }[] = [];
  const driver: ExecutorDriver = {
    id: "pane-world",
    interactive: false,
    async slot(cwd: string, name: string, o?: SlotOpts) {
      const s = await inner.slot(cwd, name);
      const paneName = o?.owned ? formatOwnedName(o.owned) : name;
      live.add(paneName);
      byId.set(s.id, paneName);
      ops.push({ kind: "slot", name: paneName });
      return s;
    },
    run: inner.run.bind(inner),
    waitOutput: (s, p, t, o) => inner.waitOutput(s, p, opts.capWaitMs ? Math.min(t, opts.capWaitMs) : t, o),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    status: inner.status.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    async close(s: Slot) {
      const n = byId.get(s.id) ?? s.name;
      ops.push({ kind: "close", name: n });
      if (!opts.missClose) live.delete(n); // missClose: the daemon's close silently fails to reap the pane
      return inner.close(s);
    },
    worktree: inner.worktree.bind(inner),
    async reconcile(desired: Set<string>) {
      const closed: string[] = [];
      for (const name of live) {
        if (parseOwnedName(name) && !desired.has(name)) {
          live.delete(name);
          closed.push(name);
        }
      }
      sweeps.push({ desired: [...desired], closed });
    },
  };
  return { driver, live, ops, sweeps };
}

describe("daemon reconciliation at safe points (fake adapter, zero tokens)", () => {
  test("resume after a simulated daemon kill closes the orphaned worker pane of the superseded attempt (2026-07-13 scenario)", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    // hand-craft the killed daemon's journal: T1 dispatched, no terminal event, process gone
    const j = Journal.create(repo, "run-kill");
    j.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "T1", { attempt: 0 });
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    // the orphan: the killed process's worker pane, still live, canonically named
    const orphan = owned("worker", "T1", 0, "run-kill");
    const { driver, live, sweeps } = paneWorld([orphan]);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-kill", resume: true, driver });
    expect(s.done).toEqual(["T1"]); // the resume itself succeeds
    expect(live.has(orphan)).toBe(false); // orphan reaped with zero operator action
    expect(sweeps[0].closed).toContain(orphan); // by the run-resume boundary sweep, before re-dispatch
    expect(sweeps[0].desired).not.toContain(orphan); // run-resume superseded the killed attempt in the fold
  });

  test("quota-failover closes the superseded slot's pane at reroute time", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'; exit 1" }, // no trailer + quota text → failover
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const { driver, ops } = paneWorld();
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-q", driver });
    expect(s.done).toEqual(["T1"]);
    const a0 = owned("worker", "T1", 0, "run-q");
    const a1 = owned("worker", "T1", 1, "run-q");
    const closeA0 = ops.findIndex((o) => o.kind === "close" && o.name === a0);
    const slotA1 = ops.findIndex((o) => o.kind === "slot" && o.name === a1);
    expect(closeA0).toBeGreaterThanOrEqual(0);
    expect(slotA1).toBeGreaterThanOrEqual(0);
    expect(closeA0).toBeLessThan(slotA1); // closed AT REROUTE TIME, before the failover attempt dispatches
  });

  test("reconciliation catches the superseded quota slot even when its close was missed", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [
        { shell: "echo 'usage limit reached for this model'; exit 1" },
        { shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } },
      ] } },
    );
    const { driver, live, sweeps } = paneWorld([], { missClose: true }); // every daemon close silently fails to reap
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-qmiss", driver });
    expect(s.done).toEqual(["T1"]);
    const a0 = owned("worker", "T1", 0, "run-qmiss");
    expect(live.has(a0)).toBe(false); // a safe-point sweep reaped it anyway
    expect(sweeps.some((sw) => sw.closed.includes(a0))).toBe(true);
    expect(sweeps.at(-1)!.desired).toEqual([owned("watch", "run", 0, "run-qmiss")]); // run-end retains the operator's watch
  });

  test("a reconcile failure (herdr gone mid-run) never fails the run — visibility is cosmetic", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const { driver } = paneWorld();
    driver.reconcile = async () => { throw new Error("herdr gone"); };
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-recfail", driver });
    expect(s.done).toEqual(["T1"]);
    expect(s.failed).toEqual([]);
  });

  test("subprocess driver has no reconcile — the daemon's sweep is a no-op there by construction", () => {
    expect((new SubprocessDriver() as ExecutorDriver).reconcile).toBeUndefined();
  });
});

// ---- v1.54 T2 (OBS-71): daemon signal reaper — a killed daemon closes its own panes -------------
// The daemon registers SIGINT/SIGTERM handlers that close every live slot the run opened, reconcile
// owned panes against an EMPTY desired set, and release the run lock before exiting — journal-silent
// (no run-end), so stop-amend-resume keeps resuming. Tests fire the daemon's own registered handler
// (never process.emit — vitest's listeners must not see a synthetic signal) with an injected exit.
describe("daemon signal reaper (fake adapter, zero tokens)", () => {
  interface FiredState { code: number; liveAtExit: string[]; lockHeldAtExit: boolean }

  // Runs a daemon on paneWorld, waits until `fireWhen` holds, fires the daemon's SIGTERM handler,
  // and returns the world + the state snapshotted inside the injected exit (the "daemon exits" instant).
  async function terminate(cfg: {
    runId: string;
    tasks: unknown[];
    script: object;
    extraCfg?: string;
    seed?: string[];
    patchFake?: (fake: ReturnType<typeof setupRepo>["fake"]) => void;
    fireWhen: (w: { live: Set<string>; ops: { kind: "slot" | "close"; name: string }[] }) => boolean;
  }) {
    const { repo, fake } = setupRepo(cfg.tasks, cfg.script, cfg.extraCfg);
    cfg.patchFake?.(fake);
    const world = paneWorld(cfg.seed ?? [], { capWaitMs: 3_000 });
    const lockPath = join(tickmarkrDir(repo), "graph.lock");
    const before = process.listeners("SIGTERM");
    let fired: FiredState | undefined;
    const run = runDaemon(repo, {
      adapters: [fake], runId: cfg.runId, driver: world.driver,
      exit: (code) => { fired ??= { code, liveAtExit: [...world.live], lockHeldAtExit: existsSync(lockPath) }; },
    });
    run.catch(() => { /* consumed again by the rejects assertion below */ });
    const deadline = Date.now() + 15_000;
    while (!cfg.fireWhen(world)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting to fire; live: ${[...world.live].join(", ")}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const lockHeldBeforeSignal = existsSync(lockPath);
    const handler = process.listeners("SIGTERM").find((l) => !before.includes(l)) as ((sig: string) => void) | undefined;
    expect(handler, "daemon registered its SIGTERM handler").toBeDefined();
    handler!("SIGTERM");
    await expect(run).rejects.toThrow(/terminated by SIGTERM/);
    expect(fired, "the reaper called exit").toBeDefined();
    return { repo, ...world, fired: fired!, lockHeldBeforeSignal };
  }

  const HANG = { shell: "sleep 30" }; // no result → no trailer: the worker slot stays open

  test("a termination signal closes every open worker slot before the daemon exits", async () => {
    const runId = "run-sig-workers";
    const w1 = owned("worker", "T1", 0, runId);
    const w2 = owned("worker", "T2", 0, runId);
    const foreign = "orchestrator"; // judge scope: reap only what this run itself opened
    const { fired } = await terminate({
      runId,
      tasks: [T("T1"), T("T2")],
      script: { tasks: { T1: [HANG], T2: [HANG] } },
      seed: [foreign],
      fireWhen: ({ live }) => live.has(w1) && live.has(w2),
    });
    expect(fired.liveAtExit).not.toContain(w1); // closed BEFORE the exit snapshot
    expect(fired.liveAtExit).not.toContain(w2);
    expect(fired.liveAtExit).toContain(foreign); // foreign pane untouched
    expect(fired.code).toBe(143); // 128 + SIGTERM
  });

  test("a termination signal closes kept gate slots", async () => {
    const runId = "run-sig-gates";
    const workerPane = owned("worker", "T1", 0, runId);
    const judgePane = owned("judge", "T1", 0, runId);
    const { fired, ops } = await terminate({
      runId,
      tasks: [T("T1")],
      script: { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      extraCfg: "visibility:\n  llm: pane\n",
      // the judge hangs mid-verdict so its gate slot is open (and the harvested worker slot kept) at signal time
      patchFake: (fake) => {
        const orig = fake.headlessCommand.bind(fake);
        fake.headlessCommand = (pf: string, model: string) =>
          /TICKMARKR-JUDGE/.test(readFileSync(pf, "utf8")) ? "sleep 30" : orig(pf, model);
      },
      fireWhen: ({ live }) => live.has(judgePane),
    });
    expect(fired.liveAtExit).not.toContain(judgePane); // the live gate slot closed
    expect(fired.liveAtExit).not.toContain(workerPane); // the kept worker slot closed too
    expect(ops.some((o) => o.kind === "close" && o.name === judgePane)).toBe(true);
  });

  test("the signal handler reconciles panes against an empty desired set", async () => {
    const runId = "run-sig-sweep";
    const { fired, sweeps } = await terminate({
      runId,
      tasks: [T("T1")],
      script: { tasks: { T1: [HANG] } },
      fireWhen: ({ live }) => live.has(owned("worker", "T1", 0, runId)),
    });
    // the run-start boundary sweep desires the watch pane (length 1) — only the reaper sweeps to empty
    expect(sweeps.some((sw) => sw.desired.length === 0)).toBe(true);
    expect(fired.liveAtExit).not.toContain(owned("worker", "T1", 0, runId));
  });

  test("a termination signal releases the run lock", async () => {
    const runId = "run-sig-lock";
    const { fired, lockHeldBeforeSignal } = await terminate({
      runId,
      tasks: [T("T1")],
      script: { tasks: { T1: [HANG] } },
      fireWhen: ({ live }) => live.has(owned("worker", "T1", 0, runId)),
    });
    expect(lockHeldBeforeSignal).toBe(true); // held while running
    expect(fired.lockHeldAtExit).toBe(false); // released by the handler itself, before exit
  });

  test("a termination signal writes no run end event", async () => {
    const runId = "run-sig-noend";
    const { repo } = await terminate({
      runId,
      tasks: [T("T1")],
      script: { tasks: { T1: [HANG] } },
      fireWhen: ({ live }) => live.has(owned("worker", "T1", 0, runId)),
    });
    const events = Journal.open(repo, runId).read().map((e) => e.event);
    expect(events).toContain("run-start");
    expect(events).not.toContain("run-end"); // journal-silent: stop-amend-resume must keep resuming
  });

  test("keep panes forever preserves owned panes on termination", async () => {
    const runId = "run-sig-forever";
    const workerPane = owned("worker", "T1", 0, runId);
    const { fired, ops, sweeps } = await terminate({
      runId,
      tasks: [T("T1")],
      script: { tasks: { T1: [HANG] } },
      extraCfg: "visibility:\n  keepPanes: forever\n",
      fireWhen: ({ live }) => live.has(workerPane),
    });
    expect(fired.liveAtExit).toContain(workerPane); // the debug override wins — nothing closed
    expect(ops.some((o) => o.kind === "close" && o.name === workerPane)).toBe(false);
    expect(sweeps.some((sw) => sw.desired.length === 0)).toBe(false); // no empty-set sweep either
    expect(fired.lockHeldAtExit).toBe(false); // the lock is still released
  });

  test("an already closed slot is not closed twice", async () => {
    const runId = "run-sig-once";
    const donePane = owned("worker", "T1", 0, runId);
    const hungPane = owned("worker", "T2", 0, runId);
    const { fired, ops } = await terminate({
      runId,
      tasks: [T("T1"), T("T2")],
      script: { tasks: {
        T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }],
        T2: [HANG],
      } },
      // fire after T1's done-path close already happened, while T2 still hangs
      fireWhen: ({ live, ops }) => ops.some((o) => o.kind === "close" && o.name === donePane) && live.has(hungPane),
    });
    expect(ops.filter((o) => o.kind === "close" && o.name === donePane)).toHaveLength(1); // reap skipped it
    expect(ops.filter((o) => o.kind === "close" && o.name === hungPane)).toHaveLength(1);
    expect(fired.liveAtExit).not.toContain(hungPane);
  });
});


// v1.69 T7: seed-mode pane hygiene parity — a completed seed-mode worker pane is reaped by the
// same reconcile sweep that reaps any other completed worker pane.
describe("seed-mode reconciliation parity (fake adapter, zero tokens)", () => {
  class SeedFakeAdapter extends FakeAdapter {
    id = "seedfake";
    interactiveCommand(): string | null {
      return null;
    }
    interactiveSeed = {
      launch: (model: string) => `launch-tui --model ${model}`,
      readinessMatch: "TUI ready",
      seedLine: (promptFile: string) => `read ${promptFile}`,
    };
    channels() {
      return [{ adapter: "seedfake", vendor: "seed", model: "fake-1", channel: "sub", tier: "frontier" }];
    }
  }

  function makeSeedDriver() {
    const inner = new SubprocessDriver();
    const live = new Set<string>();
    const byId = new Map<string, string>();
    const sweeps: { desired: string[]; closed: string[] }[] = [];
    const closedNames: string[] = [];
    let buf = "banner\nTUI ready\n> ";

    const driver: ExecutorDriver = {
      id: "seed-reconcile",
      interactive: true,
      slot: async (cwd: string, name: string, o?: SlotOpts) => {
        const s = await inner.slot(cwd, name);
        const paneName = o?.owned ? formatOwnedName(o.owned) : name;
        live.add(paneName);
        byId.set(s.id, paneName);
        return { ...s, name: paneName, cwd };
      },
      run: async (s: Slot, cmd: string) => {
        if (cmd.startsWith("launch-tui ")) {
          // launch: banner already in buf
          return;
        }
        if (cmd.startsWith("read ")) {
          const promptFile = cmd.slice(5);
          buf += `\n${cmd}\n`;
          execSync(`echo done > done.txt && ${COMMIT} done`, { cwd: s.cwd });
          const nonce = /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(promptFile, "utf8"))?.[1] ?? "";
          if (nonce) {
            buf += `TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"seeded","deviations":[]}\n`;
          }
          return;
        }
        // gate/consult scripts and regular interactive dispatch scripts
        const m = /^bash '(.+)'$/.exec(cmd);
        if (m) {
          try {
            buf += execSync(`bash ${JSON.stringify(m[1])}`, { cwd: s.cwd, encoding: "utf8" });
          } catch {
            /* gate failures are reflected in the empty buffer */
          }
        }
      },
      waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) =>
        o?.regex ? new RegExp(pattern).test(buf) : buf.includes(pattern),
      waitAgentStatus: async () => true,
      status: async () => "unknown",
      read: async (_s: Slot, lines: number) => buf.split("\n").slice(-lines).join("\n"),
      notify: async () => {},
      close: async (s: Slot) => {
        const n = byId.get(s.id) ?? s.name;
        closedNames.push(n);
        live.delete(n);
        return inner.close(s);
      },
      worktree: inner.worktree.bind(inner),
      async reconcile(desired: Set<string>) {
        const closed: string[] = [];
        for (const name of live) {
          if (parseOwnedName(name) && !desired.has(name)) {
            live.delete(name);
            closed.push(name);
          }
        }
        sweeps.push({ desired: [...desired], closed });
      },
    };

    return { driver, live, sweeps, closedNames };
  }

  test("a completed seed-mode attempt's worker pane is closed by the same post-run sweep that closes any other completed worker pane", async () => {
    const { repo, fake, scriptPath } = setupRepo(
      [T("T1"), T("T2", { shape: "chore" }) ],
      {
        tasks: {
          T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }],
          T2: [{ shell: "true", result: { ok: true, summary: "other" } }],
        },
      },
      "visibility:\n  worker: interactive\n  keepPanes: run\ntaskTimeoutMinutes: 0.2\n" +
      "routing:\n  map:\n    implement:\n      pin: { via: seedfake, model: fake-1 }\n    chore:\n      pin: { via: fake, model: fake-1 }\n",
    );
    const { driver, live, sweeps, closedNames } = makeSeedDriver();
    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath), fake], runId: "run-seed-sweep", driver });
    expect(s.done).toEqual(["T1", "T2"]);
    const w1 = owned("worker", "T1", 0, "run-seed-sweep");
    const w2 = owned("worker", "T2", 0, "run-seed-sweep");
    expect(live.has(w1)).toBe(false);
    expect(live.has(w2)).toBe(false);
    expect(closedNames).toContain(w1);
    expect(closedNames).toContain(w2);
    // run-end sweep sees no worker panes left — they were already reaped by the same post-attempt
    // close path every other completed worker pane uses.
    expect(sweeps.at(-1)!.closed).not.toContain(w1);
    expect(sweeps.at(-1)!.closed).not.toContain(w2);
  }, 30_000);
});
