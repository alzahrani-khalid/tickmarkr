import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HcUnavailableError, HerdrAppDriver, OWNER_LABEL, REPO_LABEL, SPACE_LABEL, TAB_LABEL, type HerdrAppDriverOpts } from "../../src/drivers/herdr-app.js";
import { formatOwnedName, type OwnedName, type OwnedRole, type Slot } from "../../src/drivers/types.js";
import { beatSupervision, SUPERVISION_TIERS, supervisionBeatPath, supervisionStandDownPath, type SupervisionTier } from "../../src/run/supervision.js";
import { FakeHerdrApp, type FakeApp, type FakeRule, type FakeState, type FakeTerm, hcAddress } from "../helpers/fake-herdr-app.js";
import { makeRepo, makeTestTempDir, reapTestTempDirs } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract P over executable fakes resolved to explicit paths: task tabs placed from the
// launcher's own anchor space, hidden/unavailable fallbacks, keep disabled before a terminal is controlled, read-only
// adoption and the repo-scoped reconcile. The app window is the fake's layout model; every hc body follows the captured
// shapes (specs/v2.20.0-herdr-app-captures.json, Q4-split-get: a shown terminal carries herdr.space/herdr.tab and keep).

afterAll(() => reapTestTempDirs());
afterEach(() => { vi.restoreAllMocks(); });

const RUN = "run-20261104-093422-0000000000000814";
const ANCHOR = "t100";
const own = (role: OwnedRole, taskId: string, attempt = 0, runId = RUN): OwnedName => ({ role, taskId, attempt, runId });
const repoId = (repo: string): string => realpathSync(join(repo, ".git"));
type Row = { event: string; taskId?: string; data: Record<string, unknown> };

/** A window with the anchor (ORCH) in space spA's active tab and an operator's space spB, both foreign to tickmarkr. */
function windowApp(over: Partial<FakeApp> = {}): FakeApp {
  return {
    window: true, nextTab: 0, ...over,
    spaces: over.spaces ?? [
      { id: "spA", name: "tickmarkr", tabs: [{ id: "tbORCH", name: "ORCH", terminals: [ANCHOR] }] },
      { id: "spB", name: "~", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101"] }] },
    ],
  };
}
const anchorTerm = (labels: Record<string, string>): Partial<FakeTerm> => ({ address: ANCHOR, cwd: "/", labels, state: "live" });
function fake(init: Partial<FakeState> & { anchorLabels?: Record<string, string> } = {}): FakeHerdrApp {
  const { anchorLabels = { [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" }, ...rest } = init;
  const f = new FakeHerdrApp(makeTestTempDir("hcplace-"), { app: windowApp(), ...rest });
  f.update((s) => {
    const blank = { argv: [], parent: null, die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: null,
      signal: null, reason: null, pid: 1, turn: 0, screen: { text: "", complete: true }, history: { text: "", complete: true } };
    s.terminals[ANCHOR] = { ...blank, ...anchorTerm(anchorLabels) } as FakeTerm;
    s.terminals.t101 = { ...blank, address: "t101", cwd: "/", labels: {}, state: "live" } as FakeTerm;
  });
  return f;
}
function driver(f: FakeHerdrApp, rows: Row[], over: HerdrAppDriverOpts = {}): HerdrAppDriver {
  const d = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH, HC_TERMINAL_ID: ANCHOR, HC_TERMINAL_SOCKET: f.read().socket },
    pollMs: 30, readinessMs: 600, confirmMs: 500, placementMs: 5_000, runId: RUN, ...over });
  d.journalWith((event, taskId, data) => { rows.push({ event, ...(taskId ? { taskId } : {}), data: data ?? {} }); });
  return d;
}
/** Create one owned slot's terminal through the real path and return its address. */
async function create(f: FakeHerdrApp, d: HerdrAppDriver, cwd: string, o: OwnedName, group?: string): Promise<{ slot: Slot; address: string }> {
  const slot = await d.slot(cwd, formatOwnedName(o), { owned: o, ...(group ? { group } : {}) });
  await d.run(slot, "true");
  return { slot, address: hcAddress(f.read().next) };
}
const runArgv = (f: FakeHerdrApp, address: string): string[] => f.hcCalls("run")[Number(address.slice(1)) - 1]!;
const labelArgs = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === "--label" && /^herdr\./.test(a) ? [a] : []));
const tabOf = (f: FakeHerdrApp, address: string): string | undefined =>
  f.read().app!.spaces.flatMap((s) => s.tabs).find((t) => t.terminals.includes(address))?.id;
const appCalls = (f: FakeHerdrApp): string[][] => f.calls().filter((c) => c.tool === "herdr-app").map((c) => c.argv);
const renames = (f: FakeHerdrApp): string[][] => appCalls(f).filter((a) => a[1] === "tab.rename");

describe("HerdrAppDriver — task tabs from the anchor space (contract P)", () => {
  it("per-task slot placement satisfies the closed task-tab table while shared worker grouping cannot combine separate tasks", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake();
    const rows: Row[] = [];
    const d = driver(f, rows);

    // Base case: the first task slot carries the anchor's space ONLY (never its tab), lands in a new tab of that space,
    // which is recorded from the terminal's own mapping and renamed with the short-title policy; keep is disabled.
    const w1 = await create(f, d, repo, own("worker", "T1"), "workers");
    expect(labelArgs(runArgv(f, w1.address))).toEqual([`${SPACE_LABEL}=spA`]);
    expect(tabOf(f, w1.address)).toBe("tb1");
    expect(renames(f)).toEqual([["do", "tab.rename", "--id", "tb1", "--name", "T1"]]);
    expect(f.read().app!.spaces[0]!.tabs.find((t) => t.id === "tb1")!.name).toBe("T1");
    expect(f.hcCalls("keep")).toEqual([["keep", w1.address, "--off", "--json"]]);
    expect(f.term(w1.address).keep).toBe(false);
    expect(f.term(ANCHOR).labels).toEqual({ [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" }); // anchor metadata is only read

    // The same task's judge, review, consult and retried worker carry the verified task tab and space: one tab, no rename.
    const same: string[] = [];
    for (const o of [own("judge", "T1"), own("review", "T1"), own("consult", "T1"), own("worker", "T1", 1)]) {
      const s = await create(f, d, repo, o);
      expect(labelArgs(runArgv(f, s.address)), o.role).toEqual([`${SPACE_LABEL}=spA`, `${TAB_LABEL}=tb1`]);
      expect(tabOf(f, s.address)).toBe("tb1");
      expect(f.term(s.address).keep).toBe(false);
      same.push(s.address);
    }
    expect(renames(f)).toHaveLength(1);

    // Adjacent: the daemon's SHARED `workers` group never combines tasks — a different task starts its own tab.
    const w2 = await create(f, d, repo, own("worker", "T2"), "workers");
    expect(labelArgs(runArgv(f, w2.address))).toEqual([`${SPACE_LABEL}=spA`]);
    expect(tabOf(f, w2.address)).toBe("tb2");
    expect(renames(f).at(-1)).toEqual(["do", "tab.rename", "--id", "tb2", "--name", "T2"]);
    // A role other than the task roles (a scope draft) never joins a task tab: its own tab, its own short name.
    const draft = await d.slot(repo, "scope · draft");
    await d.run(draft, "true");
    expect(labelArgs(runArgv(f, hcAddress(f.read().next)))).toEqual([`${SPACE_LABEL}=spA`]);
    expect(renames(f).at(-1)).toEqual(["do", "tab.rename", "--id", "tb3", "--name", "scope · draft"]);

    // Concurrent first slots of one task are serialized: exactly one new tab, both members in it.
    const [a, b] = await Promise.all([own("worker", "T3"), own("judge", "T3")].map(async (o) => d.slot(repo, formatOwnedName(o), { owned: o, group: "workers" })));
    await Promise.all([d.run(a!, "true"), d.run(b!, "true")]);
    const t3 = f.read().app!.spaces[0]!.tabs.filter((t) => t.name === "T3" || t.name === "JUDGE T3");
    expect(t3).toHaveLength(1);
    expect(t3[0]!.terminals).toHaveLength(2);

    // A recorded member still carrying its owner and repo labels but now reporting another checkout is no longer a
    // verified member: T4's tab is never joined through it, the next T4 slot starts a new generation.
    const other = makeRepo({ "o.txt": "o" });
    const w4 = await create(f, d, repo, own("worker", "T4"), "workers");
    const tb4 = tabOf(f, w4.address)!;
    f.setTerm(w4.address, { cwd: realpathSync(other) });
    const j4 = await create(f, d, repo, own("judge", "T4"));
    expect(labelArgs(runArgv(f, j4.address))).toEqual([`${SPACE_LABEL}=spA`]);
    expect(tabOf(f, j4.address)).not.toBe(tb4);

    // A recorded tab that no longer maps to a verified owned member is forgotten: T1's members are all closed (the
    // tab empties), so the next T1 slot starts a new generation instead of re-joining tb1.
    await d.close(w1.slot);
    f.update((st) => {
      for (const address of same) delete st.terminals[address];
      for (const sp of st.app!.spaces) for (const t of sp.tabs) t.terminals = t.terminals.filter((x) => !same.includes(x));
    });
    const w1b = await create(f, d, repo, own("worker", "T1", 2));
    expect(labelArgs(runArgv(f, w1b.address))).toEqual([`${SPACE_LABEL}=spA`]);
    expect(tabOf(f, w1b.address)).not.toBe("tb1");
    // ...and a recorded tab now holding only a FOREIGN terminal (T2's member removed, an operator shell moved in) is
    // never joined: the next T2 slot opens its own new tab.
    f.update((st) => {
      const tb2 = st.app!.spaces[0]!.tabs.find((t) => t.id === "tb2")!;
      tb2.terminals = ["t101"];
      delete st.terminals[w2.address];
    });
    const w2b = await create(f, d, repo, own("judge", "T2"));
    expect(labelArgs(runArgv(f, w2b.address))).toEqual([`${SPACE_LABEL}=spA`]);
    expect(tabOf(f, w2b.address)).not.toBe("tb2");

    // No placement ever targeted the anchor's (active) tab or the operator's space, and nothing but app ls and renames
    // of tabs this driver's own terminals opened reached the window.
    for (const argv of f.hcCalls("run")) expect(argv.join(" ")).not.toMatch(/tbORCH|tbOPER|spB/);
    for (const argv of appCalls(f)) expect(argv[0] === "ls" || (argv[1] === "tab.rename" && /^tb\d+$/.test(argv[3]!))).toBe(true);
    expect(rows).toEqual([]);
  }, 120_000);

  it("placement degradation satisfies the closed unavailable-window table while a guessed focused or foreign tab is never used", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const unavailable = (rows: Row[]): string[] => rows.filter((r) => r.event === "herdr-app-placement-unavailable").map((r) => String(r.data.reason));

    // Base case: an anchor outside any window (no herdr.space) runs with ownership labels only — hidden, no placement
    // commands and nothing to journal.
    {
      const f = fake({ anchorLabels: {} });
      const rows: Row[] = [];
      const d = driver(f, rows);
      const s = await create(f, d, repo, own("worker", "T1"));
      expect(labelArgs(runArgv(f, s.address))).toEqual([]);
      expect(appCalls(f)).toEqual([]);
      expect(f.hcCalls("keep")).toEqual([]);
      expect(rows).toEqual([]);
      expect(await d.status(s.slot)).toBe("unknown"); // execution is available
    }

    // Anchor unset, missing, or its metadata malformed: journal unavailable and run without window labels.
    const anchorRows: [string, HerdrAppDriverOpts, FakeRule | undefined][] = [
      ["anchor unset", { env: { PATH: process.env.PATH } }, undefined],
      ["anchor missing", { env: { PATH: process.env.PATH, HC_TERMINAL_ID: "t404" } }, undefined],
      ["anchor metadata malformed", {}, { match: ["get", ANCHOR], output: "{\"address\":" }],
    ];
    for (const [row, over, rule] of anchorRows) {
      const f = fake();
      if (rule) f.rule(rule);
      const rows: Row[] = [];
      const d = driver(f, rows, over);
      const s = await create(f, d, repo, own("worker", "T1"));
      expect(labelArgs(runArgv(f, s.address)), row).toEqual([]);
      expect(appCalls(f), row).toEqual([]);
      expect(unavailable(rows), row).toEqual([expect.stringMatching(row === "anchor unset" ? /no anchor terminal/ : /anchor t\d+ metadata unreadable/)]);
      expect(await d.read(s.slot, 10), row).toBe("");
    }

    // Window gone (core reachable) while the anchor still carries its herdr.space label: detected BEFORE creation, so
    // every slot runs without window labels (the stale space is never carried into a gone window) and journals why.
    // A window present but no longer listing the anchor's space is the same: never a guessed space.
    for (const [row, app, why] of [
      ["window gone", windowApp({ window: false }), /window unavailable .*app-ls response family failed.*window_unavailable/],
      ["anchor space absent", windowApp({ spaces: [{ id: "spB", name: "~", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101"] }] }] }), /anchor space spA is not in the window layout/],
    ] as const) {
      const f = fake({ app });
      const rows: Row[] = [];
      const d = driver(f, rows);
      const w = await create(f, d, repo, own("worker", "T1"));
      expect(labelArgs(runArgv(f, w.address)), row).toEqual([]);
      expect(unavailable(rows), row).toEqual([expect.stringMatching(why)]);
      expect(await d.read(w.slot, 10), row).toBe("");
      const j = await create(f, d, repo, own("judge", "T1"));
      expect(labelArgs(runArgv(f, j.address)), row).toEqual([]);
      expect(unavailable(rows), row).toEqual([expect.stringMatching(why), expect.stringMatching(why)]);
      expect(renames(f), row).toEqual([]);
      expect(f.hcCalls("keep"), row).toEqual([]);
      expect(f.hcCalls("run"), row).toHaveLength(2); // never a replacement creation
    }

    // Mapping never arrives (window up, terminal never shown): bounded wait, unavailable, no rename, no replacement; a
    // different task still tries its own placement.
    {
      const f = fake({ app: windowApp({ maps: false }) });
      const rows: Row[] = [];
      const d = driver(f, rows, { placementMs: 1_500 });
      const w = await create(f, d, repo, own("worker", "T1"));
      expect(unavailable(rows)).toEqual([expect.stringMatching(/tab mapping never arrived/)]);
      const j = await create(f, d, repo, own("review", "T1"));
      expect(labelArgs(runArgv(f, j.address))).toEqual([]);
      const other = await create(f, d, repo, own("worker", "T2"));
      expect(labelArgs(runArgv(f, other.address))).toEqual([`${SPACE_LABEL}=spA`]);
      expect(renames(f)).toEqual([]);
      expect(f.hcCalls("run")).toHaveLength(3);
      expect(await d.status(w.slot)).toBe("unknown");
    }

    // The exact app mapping alone suffices (no herdr.tab label on the terminal): the layout row in the anchor space.
    {
      const f = fake({ app: windowApp({ tabLabel: false }) });
      const rows: Row[] = [];
      const d = driver(f, rows);
      const w = await create(f, d, repo, own("worker", "T1"));
      expect(renames(f)).toEqual([["do", "tab.rename", "--id", "tb1", "--name", "T1"]]);
      const j = await create(f, d, repo, own("judge", "T1"));
      expect(labelArgs(runArgv(f, j.address))).toEqual([`${SPACE_LABEL}=spA`, `${TAB_LABEL}=tb1`]);
      expect(tabOf(f, w.address)).toBe("tb1");
      expect(unavailable(rows)).toEqual([]);
    }

    // A terminal the layout shows in ANOTHER space (or the focused/active tab) is never a mapping: the active anchor
    // tab and the operator's space are never recorded, joined or renamed.
    {
      const f = fake({ app: windowApp({ maps: false }) });
      const rows: Row[] = [];
      const d = driver(f, rows, { placementMs: 1_500 });
      f.rule({ tool: "herdr-app", match: ["ls"], output: JSON.stringify({ spaces: [
        { id: "spA", tabs: [{ id: "tbORCH", name: "ORCH", active: true, terminals: [{ terminal: ANCHOR, pane: "pA" }] }] },
        { id: "spB", active: true, tabs: [{ id: "tbOPER", name: "1", active: true, terminals: [{ terminal: "t101", pane: "pB" }, { terminal: "t1", pane: "p1" }] }] },
      ] }) });
      await create(f, d, repo, own("worker", "T1"));
      expect(unavailable(rows)).toEqual([expect.stringMatching(/tab mapping never arrived/)]);
      const later = await create(f, d, repo, own("judge", "T1"));
      expect(labelArgs(runArgv(f, later.address))).toEqual([]);
      for (const argv of f.hcCalls("run")) expect(argv.join(" ")).not.toMatch(/tbORCH|tbOPER|spB/);
      expect(renames(f)).toEqual([]);
    }

    // The terminal is re-owned between its confirmation and the placement read, already shown in a tab: that tab is
    // a foreign one — never recorded, renamed or joined, and keep is never mutated on it; the run fails explicitly.
    {
      const f = fake();
      const rows: Row[] = [];
      const d = driver(f, rows);
      const o = own("worker", "T1");
      const slot = await d.slot(repo, formatOwnedName(o), { owned: o });
      const labels = { [OWNER_LABEL]: formatOwnedName(o), [REPO_LABEL]: repoId(repo), [SPACE_LABEL]: "spA" };
      const confirmed = JSON.stringify({ cols: 200, rows: 120, rm: false, title: "", address: "t1", argv: [], cwd: realpathSync(repo), state: "live",
        parent: null, die_with_parent: false, notify: false, keep: true, reported: false, status: null, exit_code: null, signal: null, reason: null,
        pid: 9, turn: 0, labels }) + "\n";
      f.rule({ match: ["get", "t1"], once: true, output: confirmed,
        mutate: { t1: { labels: { ...labels, [OWNER_LABEL]: "tickmarkr:worker:T9:0:run-other", [TAB_LABEL]: "tb1" } } } });
      await expect(d.run(slot, "true")).rejects.toThrow(/t1 rejected: ownership changed during placement \(owner label differs\)/);
      expect(renames(f)).toEqual([]);
      expect(f.hcCalls("keep")).toEqual([]);
      expect(f.term("t1").keep).toBe(true);
      const next = await create(f, d, repo, own("judge", "T1"));
      expect(labelArgs(runArgv(f, next.address))).toEqual([`${SPACE_LABEL}=spA`]);
      expect(tabOf(f, next.address)).not.toBe("tb1");
    }

    // Rename refusal or malformed rename response: a cosmetic diagnostic, never a retried creation; the tab still
    // records and the same task's next slot joins it.
    for (const output of [JSON.stringify({ error: "no such tab" }), JSON.stringify({ ok: "true" })]) {
      const f = fake();
      f.rule({ tool: "herdr-app", match: ["do", "tab.rename"], output, exit: output.includes("error") ? 1 : 0 });
      const rows: Row[] = [];
      const d = driver(f, rows);
      await create(f, d, repo, own("worker", "T1"));
      expect(rows.filter((r) => r.event === "herdr-app-tab-rename-failed")).toEqual([
        { event: "herdr-app-tab-rename-failed", taskId: "T1", data: expect.objectContaining({ tab: "tb1", reason: expect.stringMatching(/tab-rename response family failed/) }) },
      ]);
      const j = await create(f, d, repo, own("judge", "T1"));
      expect(labelArgs(runArgv(f, j.address))).toEqual([`${SPACE_LABEL}=spA`, `${TAB_LABEL}=tb1`]);
      expect(f.hcCalls("run")).toHaveLength(2);
      expect(renames(f)).toHaveLength(1);
    }
  }, 120_000);

  it("visible-terminal recovery satisfies the closed keep table while a recovered live shell never proves drained worker transport", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const finished = { state: "finished" as const, exit_code: 0, screen: { text: "TRAILER", complete: true }, history: { text: "TRAILER", complete: true } };

    // Base case: the app turned keep on for the shown terminal; keep --off follows placement (after the rename) and reads
    // false before the transport is controlled; a finished worker's complete screen then proves closure.
    {
      const f = fake();
      const d = driver(f, []);
      const w = await create(f, d, repo, own("worker", "T1"));
      const order = f.calls().map((c) => `${c.tool} ${c.argv[0]} ${c.argv[1] ?? ""}`);
      expect(order.findIndex((c) => c.startsWith("hc keep"))).toBeGreaterThan(order.findIndex((c) => c.includes("tab.rename")));
      expect(f.term(w.address).keep).toBe(false);
      f.setTerm(w.address, finished);
      expect(await d.transportState(w.slot)).toEqual({ closed: true, exitCode: 0, signal: null });
    }

    // keep --off refused, answered keep still true, or answered for a re-owned terminal: an explicit run failure, the
    // terminal is never treated as controlled (no read, status or transport), and close removes the receipt-bound one.
    const o = own("worker", "T1");
    const at = "t1";
    /** A keep answer for the pinned t1 (all consumed terminal fields), patched. */
    const body = (patch: Record<string, unknown>): string => JSON.stringify({ cols: 200, rows: 120, rm: false, title: "", address: at, argv: [],
      cwd: realpathSync(repo), state: "live", parent: null, die_with_parent: false, notify: false, keep: true, reported: false, status: null,
      exit_code: null, signal: null, reason: null, pid: 9, turn: 0,
      labels: { [OWNER_LABEL]: formatOwnedName(o), [REPO_LABEL]: repoId(repo), [SPACE_LABEL]: "spA", [TAB_LABEL]: "tb1" }, ...patch }) + "\n";
    const keepRows: [string, FakeRule][] = [
      ["refused", { match: ["keep"], stderr: JSON.stringify({ error: { kind: "refused", message: "no" } }) + "\n", exit: 1 }],
      ["still kept", { match: ["keep"], output: body({}) }],
      ["re-owned", { match: ["keep"], output: body({ labels: { [OWNER_LABEL]: "tickmarkr:worker:T9:0:run-other", [REPO_LABEL]: repoId(repo) }, keep: false }) }],
    ];
    for (const [row, rule] of keepRows) {
      const f = fake();
      const d = driver(f, []);
      const slot = await d.slot(repo, formatOwnedName(o), { owned: o });
      f.rule(rule);
      await expect(d.run(slot, "true"), row).rejects.toThrow(/keep could not be disabled.*never this worker's transport/);
      await expect(d.read(slot, 10), row).rejects.toThrow(HcUnavailableError);
      await expect(d.transportState(slot), row).rejects.toThrow(HcUnavailableError);
      expect(await d.status(slot), row).toBe("unknown");
      expect(f.hcCalls("read"), row).toEqual([]);
      f.clearRules();
      f.setTerm(at, { keep: false });
      await d.close(slot);
      expect(f.read().terminals[at], row).toBeUndefined();
    }

    // A hidden terminal that hc created with keep already on is disabled too; one created without keep issues no keep call.
    {
      const f = fake({ anchorLabels: {} });
      const d = driver(f, []);
      await create(f, d, repo, own("worker", "T1"));
      expect(f.hcCalls("keep")).toEqual([]);
      f.update((s) => { s.spawn = { keep: true }; });
      const kept = await create(f, d, repo, own("worker", "T2"));
      expect(f.hcCalls("keep")).toEqual([["keep", kept.address, "--off", "--json"]]);
      expect(f.term(kept.address).keep).toBe(false);
    }

    // Adjacent: keep re-enabled later and the worker's command recovered into a live shell — it is live, never closed,
    // and no trailer wait concludes drain; a finished terminal still carrying keep never proves drain either.
    {
      const f = fake();
      const d = driver(f, []);
      const w = await create(f, d, repo, own("worker", "T1"));
      f.setTerm(w.address, { state: "live", keep: true, exit_code: 0, screen: { text: "$ ", complete: true }, history: { text: "worker exited\n$ ", complete: true } });
      expect(await d.transportState(w.slot)).toEqual({ closed: false, exitCode: null, signal: null });
      expect(await d.waitOutput(w.slot, "TICKMARKR_RESULT_", 250)).toBe(false);
      f.setTerm(w.address, { ...finished, keep: true });
      await expect(d.transportState(w.slot)).rejects.toThrow(/keep on.*drain unproven/);
    }
  }, 120_000);
});

describe("HerdrAppDriver — read-only adoption (contract P)", () => {
  it("read-only adoption satisfies the closed binding table while ambiguous or foreign checkout candidates are never read as the worker", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const wt = join(makeTestTempDir("hcadopt-wt-"), "T1");
    execFileSync("git", ["worktree", "add", "-q", "-b", "tickmarkr/adopt--T1", wt], { cwd: repo, stdio: "ignore" });
    const checkout = realpathSync(wt);
    mkdirSync(join(wt, "sub"));
    const foreign = makeRepo({ "f.txt": "f" });
    const o = own("worker", "T1");
    const owner = formatOwnedName(o);
    const trailer = 'TICKMARKR_RESULT_RONE {"ok":true}';
    const term = (address: string, patch: Partial<FakeTerm>): FakeTerm => ({
      address, argv: [], cwd: checkout, labels: { [OWNER_LABEL]: owner, [REPO_LABEL]: repoId(repo) }, state: "finished", parent: null,
      die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: 0, signal: null, reason: "exited", pid: null, turn: 0,
      // captured R1 alt-exit shape: history incomplete, the complete screen still holds the trailer
      screen: { text: `ALT_FINISHED\n${trailer}`, complete: true }, history: { text: `ALT_FINISHED\n${trailer}`, complete: false }, ...patch,
    });
    const MUTATING = new Set(["run", "label", "keep", "kill", "rm", "send", "keys"]);
    const setup = (terms: FakeTerm[]): { f: FakeHerdrApp; d: HerdrAppDriver } => {
      const f = new FakeHerdrApp(makeTestTempDir("hcadopt-"), { app: windowApp() });
      f.update((s) => { for (const t of terms) s.terminals[t.address] = t; });
      return { f, d: driver(f, []) };
    };
    const readOnly = (f: FakeHerdrApp): void => {
      expect(f.calls().filter((c) => c.tool === "herdr-app" || MUTATING.has(c.argv[0]!))).toEqual([]);
    };

    // Base case: exactly one owner+repo+checkout match binds a fresh instance READ-ONLY, finished and retained: the
    // trailer reads back, the screen proves drain, and the journaled slot id is never trusted.
    {
      const { f, d } = setup([term("t1", {}), term("t2", { labels: { [OWNER_LABEL]: formatOwnedName(own("worker", "T2")), [REPO_LABEL]: repoId(repo) } })]);
      const slot = await d.adopt({ id: "hc-7", name: owner, cwd: wt, group: "workers" });
      expect(slot).toMatchObject({ name: owner, cwd: wt, group: "workers" });
      expect(slot.id).not.toBe("hc-7");
      expect(await d.read(slot, 200)).toContain(trailer);
      expect(await slot.readScreen!()).toContain(trailer);
      expect(await d.waitOutput(slot, "TICKMARKR_RESULT_RONE \\{", 500, { regex: true })).toBe(true);
      expect(await d.transportState(slot)).toEqual({ closed: true, exitCode: 0, signal: null });
      expect(f.hcCalls("read").every((a) => a[1] === "t1")).toBe(true);
      readOnly(f);
    }

    // Every decline throws BEFORE any read: no candidate is read as the worker, nothing is created or mutated.
    const lookalike = term("t1", { labels: { "probe.name": owner, where: owner } }); // same title, no owner label
    const declines: [string, FakeTerm[], RegExp, ((f: FakeHerdrApp) => void)?, string?][] = [
      ["zero (a same-title lookalike only)", [lookalike], /no terminal carries the owner label/],
      ["duplicates", [term("t1", {}), term("t2", {})], /2 terminals carry the owner label/],
      ["foreign checkout cwd", [term("t1", { cwd: realpathSync(repo) })], /sits in .*, not the task checkout .*; foreign/],
      ["foreign repo", [term("t1", { labels: { [OWNER_LABEL]: owner, [REPO_LABEL]: repoId(foreign) } })], /belongs to repo .*; foreign/],
      ["checkout is not its own top level", [term("t1", { cwd: join(checkout, "sub") })], /is not its own git checkout/, undefined, join(wt, "sub")],
      ["malformed listing", [term("t1", {})], /ls response family failed/, (f) => f.rule({ match: ["ls"], output: "{\"terminals\":" })],
      ["partial listing", [term("t1", {})], /hides 1 finished terminal/, (f) => f.rule({ match: ["ls"], output: JSON.stringify({ hidden_finished: 1, terminals: [{ address: "t1", cwd: checkout, state: "finished" }] }) })],
      ["core changed", [term("t1", {})], /core identity changed/, (f) => f.rule({ match: ["ls"], once: true, coreId: "core-after", output: JSON.stringify({ hidden_finished: 0, terminals: [{ address: "t1", cwd: checkout, state: "finished" }] }) })],
    ];
    for (const [row, terms, why, arrange, cwd] of declines) {
      const { f, d } = setup(terms);
      arrange?.(f);
      await expect(d.adopt({ id: "hc-1", name: owner, cwd: cwd ?? wt }), row).rejects.toThrow(why);
      expect(f.hcCalls("read"), row).toEqual([]);
      readOnly(f);
    }
    // Resume restores the task-tab binding over the closed recovery table. Every adopted T1 member created SHOWN (it
    // carries herdr.space) joins T1's generation — not only the first — and the generation's tab is the exact window
    // row listing a member whose owner+repo+checkout still verify: a herdr.tab label is neither needed nor trusted. A
    // later T1 role joins that tab; a different task still opens its own. A tab no verified member is listed in, or
    // two tabs each listing one (no unique task tab), is never joined or guessed: the later role opens a new tab.
    const judgeOwner = formatOwnedName(own("judge", "T1"));
    type Adoptee = { address: string; owner: string; space?: string; tab?: string };
    const W = (p: Partial<Adoptee> = {}): Adoptee => ({ address: "t50", owner, space: "spA", tab: "tbW", ...p });
    const J = (p: Partial<Adoptee> = {}): Adoptee => ({ address: "t51", owner: judgeOwner, space: "spA", tab: "tbW", ...p });
    // [row, adopted members, tabs added to spA (id → listed terminals), close the first adopted member, tab joined | new]
    const recovery: [string, Adoptee[], Record<string, string[]>, boolean, string | undefined][] = [
      ["tab label and layout row", [W()], { tbW: ["t50"] }, false, "tbW"],
      ["layout row only (no herdr.tab label)", [W({ tab: undefined })], { tbW: ["t50"] }, false, "tbW"],
      ["stale herdr.tab claim, layout row in its task tab", [W({ space: "spB", tab: "tbOPER" })], { tbW: ["t50"] }, false, "tbW"],
      ["two adopted members, the first closed", [W(), J()], { tbW: ["t50", "t51"] }, true, "tbW"],
      ["two adopted members by layout row only, the first closed", [W({ tab: undefined }), J({ tab: undefined })], { tbW: ["t50", "t51"] }, true, "tbW"],
      ["claims a foreign tab that does not list it", [W({ space: "spB", tab: "tbOPER" })], {}, false, undefined],
      ["two adopted members verified in two tabs", [W(), J({ tab: "tbJ" })], { tbW: ["t50"], tbJ: ["t51"] }, false, undefined],
    ];
    for (const [row, members, tabs, closeFirst, joined] of recovery) {
      const f = fake();
      f.update((s) => {
        for (const m of members) {
          const labels: Record<string, string> = { [OWNER_LABEL]: m.owner, [REPO_LABEL]: repoId(repo) };
          if (m.space) labels[SPACE_LABEL] = m.space;
          if (m.tab) labels[TAB_LABEL] = m.tab;
          s.terminals[m.address] = term(m.address, { labels });
        }
        s.app!.spaces[0]!.tabs.push(...Object.entries(tabs).map(([id, terminals]) => ({ id, name: id, terminals: [...terminals] })));
      });
      const d = driver(f, []);
      const adopted: Slot[] = [];
      for (const m of members) adopted.push(await d.adopt({ id: "hc-1", name: m.owner, cwd: wt, group: "workers" }));
      expect(appCalls(f), row).toEqual([]); // recording the binding reads nothing from the window
      if (closeFirst) {
        await d.close(adopted.shift()!);
        expect(f.read().terminals.t50, row).toBeUndefined();
      }
      const r = await create(f, d, wt, own("review", "T1"));
      const w2 = await create(f, d, wt, own("worker", "T2"), "workers");
      if (joined) {
        expect(labelArgs(runArgv(f, r.address)), row).toEqual([`${SPACE_LABEL}=spA`, `${TAB_LABEL}=${joined}`]);
        expect(tabOf(f, r.address), row).toBe(joined);
        expect(renames(f).map((a) => a[3]), row).toEqual([tabOf(f, w2.address)]); // only T2's new tab is renamed
      } else {
        expect(labelArgs(runArgv(f, r.address)), row).toEqual([`${SPACE_LABEL}=spA`]);
        expect([...Object.keys(tabs), "tbOPER", "tbORCH"], row).not.toContain(tabOf(f, r.address));
        expect(renames(f).map((a) => a[3]), row).toEqual([tabOf(f, r.address), tabOf(f, w2.address)]);
      }
      expect(labelArgs(runArgv(f, w2.address)), row).toEqual([`${SPACE_LABEL}=spA`]);
      expect(tabOf(f, w2.address), row).not.toBe(tabOf(f, r.address));
      expect(await d.read(adopted.at(-1)!, 200), row).toContain(trailer); // a remaining adopted member is still bound evidence
    }

    // A member created HIDDEN (no herdr.space) under an anchor outside any window was never shown: resume records no
    // generation, and the task's later role runs hidden with no window read at all.
    {
      const f = fake({ anchorLabels: {} });
      f.update((s) => { s.terminals.t50 = term("t50", {}); });
      const d = driver(f, []);
      await d.adopt({ id: "hc-1", name: owner, cwd: wt, group: "workers" });
      const r = await create(f, d, wt, own("review", "T1"));
      expect(labelArgs(runArgv(f, r.address))).toEqual([]);
      expect(appCalls(f)).toEqual([]);
    }

    // An unparseable slot name is nothing to adopt: no call at all.
    const { f, d } = setup([term("t1", {})]);
    await expect(d.adopt({ id: "hc-1", name: "T1-worker", cwd: wt })).rejects.toThrow(/carries no owned name/);
    expect(f.calls()).toEqual([]);
  }, 120_000);
});

describe("HerdrAppDriver — repo-scoped reconcile (contract P)", () => {
  it("reconcile satisfies the closed repo-and-ended-run sweep table while desired protected and foreign terminals survive", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const cwd = realpathSync(repo);
    const foreign = makeRepo({ "f.txt": "f" });
    // The daemon's cwd sits in ANOTHER repository: it adds nothing to the boundary (t9, labelled with that repo, survives).
    vi.spyOn(process, "cwd").mockReturnValue(realpathSync(foreign));
    // The run checkout is a LINKED worktree of the repo: its own state dir holds the live supervision, never the main one.
    const linked = join(makeTestTempDir("hcsweep-linked-"), "run");
    execFileSync("git", ["worktree", "add", "-q", "-b", "tickmarkr/linked-run", linked], { cwd: repo, stdio: "ignore" });
    const name = (o: OwnedName): string => formatOwnedName(o);
    const t = (address: string, owner: string | undefined, patch: Partial<FakeTerm> = {}): FakeTerm => ({
      address, argv: [], cwd, labels: owner === undefined ? {} : { [OWNER_LABEL]: owner, [REPO_LABEL]: repoId(repo) }, state: "live", parent: null,
      die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: null, signal: null, reason: null, pid: 1, turn: 0,
      screen: { text: "", complete: true }, history: { text: "", complete: true }, ...patch,
    });
    const seat = "tickmarkr:other:orch:0:" + RUN;
    const armedSeat = "tickmarkr:other:overseer:0:" + RUN;
    beatSupervision(linked, "overseer", armedSeat);
    const terms: Record<string, FakeTerm> = {
      // swept: the current run's undesired (live and finished) and an older run the caller proved ended
      t1: t("t1", name(own("worker", "T1"))),
      t2: t("t2", name(own("worker", "T3")), { state: "finished", exit_code: 0 }),
      t3: t("t3", name(own("worker", "T4", 0, "run-old"))),
      // survive: desired, unknown/live other run, watch, live seat, spared same-run LLM, foreign repo, unlabelled
      t4: t("t4", name(own("worker", "T2"))),
      t5: t("t5", name(own("worker", "T5", 0, "run-live"))),
      t6: t("t6", name(own("watch", "run"))),
      t7: t("t7", seat),
      t8: t("t8", name(own("review", "T6"))),
      t9: t("t9", name(own("worker", "T7")), { labels: { [OWNER_LABEL]: name(own("worker", "T7")), [REPO_LABEL]: repoId(foreign) } }),
      t10: t("t10", undefined, { labels: { "probe.name": name(own("worker", "T1")) } }),
      // ambiguous: one owner label on two terminals — both protected
      t11: t("t11", name(own("worker", "T8"))),
      t12: t("t12", name(own("worker", "T8"))),
      // read/close failures: rm refused, identity changed between listing and the pinned re-verification
      t13: t("t13", name(own("worker", "T9")), { state: "finished" }),
      t14: t("t14", name(own("worker", "T10"))),
      // survive: an ARMED same-run seat recorded only under the linked run checkout (no caller liveSeats names it)
      t15: t("t15", armedSeat),
    };
    const f = new FakeHerdrApp(makeTestTempDir("hcsweep-"), { app: windowApp() });
    f.update((s) => { s.terminals = { ...s.terminals, ...terms }; });
    const record = (address: string): string => {
      const r: Record<string, unknown> = { cols: 200, rows: 120, rm: false, title: "", ...f.term(address) };
      for (const k of ["screen", "history", "onSend", "echo"]) delete r[k];
      return JSON.stringify(r) + "\n";
    };
    f.rule(
      { match: ["rm", "t13"], stderr: JSON.stringify({ error: { kind: "refused", message: "busy" } }) + "\n", exit: 1 },
      { match: ["get", "t14"], once: true, output: record("t14"), mutate: { t14: { labels: { [OWNER_LABEL]: name(own("worker", "T10", 0, "run-live")), [REPO_LABEL]: repoId(repo) } } } },
    );
    const rows: Row[] = [];
    const d = driver(f, rows);
    await d.slot(repo, name(own("worker", "T2")), { owned: own("worker", "T2") }); // this driver serves the repo

    // Unknown supervision directory: no run checkout established yet, so live seats are unknown and NOTHING is swept.
    await d.reconcile(new Set([name(own("worker", "T2"))]), RUN, { spareLiveLlm: true, endedRunIds: new Set(["run-old"]), liveSeats: new Set([seat]) });
    for (const kept of Object.keys(terms)) expect(f.read().terminals[kept], `unknown supervision: ${kept}`).toBeDefined();
    expect([...f.hcCalls("kill"), ...f.hcCalls("rm")], "unknown supervision").toEqual([]);
    expect(rows, "unknown supervision").toEqual([{ event: "herdr-app-cleanup-unconfirmed",
      data: { runId: RUN, reason: expect.stringMatching(/no run checkout established.*live supervision seats unknown, nothing swept/) } }]);
    rows.length = 0;
    await d.worktree(linked, "tickmarkr/linked-run--T0", "HEAD"); // the daemon hands its run checkout to worktree()

    await d.reconcile(new Set([name(own("worker", "T2"))]), RUN, { spareLiveLlm: true, endedRunIds: new Set(["run-old"]), liveSeats: new Set([seat]) });

    const left = f.read().terminals;
    for (const gone of ["t1", "t2", "t3"]) expect(left[gone], gone).toBeUndefined();
    for (const kept of ["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13", "t14", "t15"]) expect(left[kept], kept).toBeDefined();
    // Every kill/rm targeted a candidate re-verified at its pinned address; the finished one was removed without a kill.
    expect(f.hcCalls("kill").map((a) => a[1])).toEqual(["t1", "t3"]);
    expect(f.hcCalls("rm").map((a) => a[1]).sort()).toEqual(["t1", "t13", "t2", "t3"]);
    expect(rows.filter((r) => r.event === "herdr-app-reconcile-close").map((r) => r.data.address).sort()).toEqual(["t1", "t2", "t3"]);
    const unconfirmed = rows.filter((r) => r.event === "herdr-app-cleanup-unconfirmed");
    expect(unconfirmed.map((r) => [r.data.address, r.data.reason])).toEqual(expect.arrayContaining([
      ["t11", expect.stringMatching(/ambiguous, protected/)],
      ["t12", expect.stringMatching(/ambiguous, protected/)],
      ["t13", expect.stringMatching(/rm response family failed/)],
      ["t14", expect.stringMatching(/not this slot's terminal \(owner label differs\)/)],
    ]));
    expect(unconfirmed).toHaveLength(4);
    expect(appCalls(f)).toEqual([]); // a sweep never closes a tab or space

    // Without spareLiveLlm the same run's undesired review is swept; never a live other run.
    await d.reconcile(new Set([name(own("worker", "T2"))]), RUN, { endedRunIds: new Set() });
    expect(f.read().terminals.t8).toBeUndefined();
    expect(f.read().terminals.t5).toBeDefined();

    // Read failures journal cleanup-unconfirmed and never throw or kill anything.
    f.clearCalls();
    f.rule({ match: ["ls"], output: "{bad" });
    const before = rows.length;
    await expect(d.reconcile(new Set(), RUN, { endedRunIds: new Set(["run-live"]) })).resolves.toBeUndefined();
    expect(rows.slice(before)).toEqual([{ event: "herdr-app-cleanup-unconfirmed", data: { runId: RUN, reason: expect.stringMatching(/ls response family failed/) } }]);
    expect([...f.hcCalls("kill"), ...f.hcCalls("rm")]).toEqual([]);
    expect(readFileSync(f.logPath, "utf8")).not.toMatch(/"kill"|"rm"/);

    // Discovery must be EXHAUSTIVE before anything is destroyed: a duplicate owner hidden behind a partial listing, or
    // behind one unreadable label, leaves the visible holder ambiguous — both survive and nothing is swept.
    const dup = name(own("worker", "T11"));
    const listing = (addresses: string[], hidden: number): string => JSON.stringify({ hidden_finished: hidden,
      terminals: addresses.map((address) => ({ address, cwd, state: "live" })) }) + "\n";
    for (const [row, rule] of [
      ["partial listing hides the duplicate", { match: ["ls"], output: listing(["d1"], 1) }],
      ["the duplicate's labels are unreadable", { match: ["get", "d2"], stderr: JSON.stringify({ error: { kind: "io", message: "busy" } }) + "\n", exit: 1 }],
    ] as [string, FakeRule][]) {
      const g = new FakeHerdrApp(makeTestTempDir("hcsweep-dup-"), { app: windowApp() });
      g.update((s) => { s.terminals = { d1: t("d1", dup), d2: t("d2", dup, { state: "finished" }), d3: t("d3", name(own("worker", "T12"))) }; });
      g.rule(rule);
      const out: Row[] = [];
      const e = driver(g, out);
      await e.slot(repo, name(own("worker", "T2")), { owned: own("worker", "T2") });
      await e.worktree(linked, `tickmarkr/linked-run--dup${row.length}`, "HEAD");
      await expect(e.reconcile(new Set(), RUN, { endedRunIds: new Set() })).resolves.toBeUndefined();
      for (const kept of ["d1", "d2", "d3"]) expect(g.read().terminals[kept], `${row}: ${kept}`).toBeDefined();
      expect([...g.hcCalls("kill"), ...g.hcCalls("rm")], row).toEqual([]);
      expect(out.filter((r) => r.event === "herdr-app-reconcile-close"), row).toEqual([]);
      expect(out.at(-1), row).toEqual({ event: "herdr-app-cleanup-unconfirmed", data: { runId: RUN, reason: expect.stringMatching(/ownership uniqueness unproven, nothing swept/) } });
    }

    // D-2180 add.14 — uncertainty never authorizes destruction: EVERY supervision tier under the run checkout must read
    // definite. One UNREADABLE tier — a heartbeat that cannot be read (a directory at its path), a malformed seat-tier
    // heartbeat naming no seat, or a malformed stand-down beside a fresh valid heartbeat — could hide a live seat, so
    // nothing is killed or removed, no success is journaled, and exactly one cleanup-unconfirmed names the tier. The
    // table is closed over every known tier × every unreadable shape (a malformed heartbeat on the seatless watch tier is
    // still a definite legacy beat, so it is no row). Control: all tiers definite (overseer ARMED with its seat, the rest
    // ABSENT) still sweeps the current run's undesired terminal and the ended run's, while the armed seat survives.
    const supDir = join(linked, ".tickmarkr", "supervision");
    const sweepTerms = (): Record<string, FakeTerm> => ({
      s1: t("s1", armedSeat), // the live same-run overseer seat terminal
      w1: t("w1", name(own("worker", "T1"))),
      w2: t("w2", name(own("worker", "T4", 0, "run-old"))),
    });
    const g = new FakeHerdrApp(makeTestTempDir("hcsweep-sup-"), { app: windowApp() });
    const out: Row[] = [];
    const e = driver(g, out);
    await e.slot(repo, name(own("worker", "T2")), { owned: own("worker", "T2") });
    await e.worktree(linked, "tickmarkr/linked-run--sup", "HEAD");
    const sweep = async (row: string, spoil?: () => void): Promise<Row[]> => {
      rmSync(supDir, { recursive: true, force: true });
      expect(beatSupervision(linked, "overseer", armedSeat), row).toBe(true); // a fresh valid heartbeat
      spoil?.();
      g.update((s) => { s.terminals = sweepTerms(); });
      g.clearCalls();
      const before = out.length;
      await expect(e.reconcile(new Set(), RUN, { endedRunIds: new Set(["run-old"]) }), row).resolves.toBeUndefined();
      return out.slice(before);
    };
    const asDir = (p: string): void => { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }); };
    const shapes: [string, (tier: SupervisionTier) => void, (tier: SupervisionTier) => boolean][] = [
      ["unreadable heartbeat", (tier) => asDir(supervisionBeatPath(linked, tier)), () => true],
      ["malformed heartbeat", (tier) => writeFileSync(supervisionBeatPath(linked, tier), "{bad"), (tier) => tier !== "watch"],
      ["malformed stand-down", (tier) => writeFileSync(supervisionStandDownPath(linked, tier), "{bad"), () => true],
    ];
    let spoiled = 0;
    for (const tier of SUPERVISION_TIERS) {
      for (const [shape, spoil] of shapes.filter(([, , applies]) => applies(tier))) {
        const row = `${shape} on ${tier}`;
        const got = await sweep(row, () => spoil(tier));
        expect([...g.hcCalls("kill"), ...g.hcCalls("rm")], row).toEqual([]);
        for (const kept of ["s1", "w1", "w2"]) expect(g.read().terminals[kept], `${row}: ${kept}`).toBeDefined();
        expect(got, row).toEqual([{ event: "herdr-app-cleanup-unconfirmed", data: { runId: RUN, tier, checkout: linked,
          reason: expect.stringMatching(new RegExp(`^supervision tier ${tier} unreadable under .*; live supervision seats unknown, nothing swept$`)) } }]);
        spoiled++;
      }
    }
    expect(spoiled).toBe(SUPERVISION_TIERS.length * 3 - 1);
    // Control: every tier definite — the undesired owned terminals are swept, the ARMED seat's terminal survives.
    const got = await sweep("all tiers definite");
    expect(g.read().terminals.s1).toBeDefined();
    for (const gone of ["w1", "w2"]) expect(g.read().terminals[gone], gone).toBeUndefined();
    expect(got.filter((r) => r.event === "herdr-app-cleanup-unconfirmed")).toEqual([]);
    expect(got.filter((r) => r.event === "herdr-app-reconcile-close").map((r) => r.data.address).sort()).toEqual(["w1", "w2"]);
  }, 120_000);
});
