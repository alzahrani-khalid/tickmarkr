import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { boardTrampoline, HerdrAppDriver, OWNER_LABEL, REPO_LABEL, SPACE_LABEL, TAB_LABEL, type HerdrAppDriverOpts } from "../../src/drivers/herdr-app.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { observeNamedRun, readWatchBoard, reserveWatchBoard, supervisionPresencePath, WATCH_OWNER_ENV } from "../../src/run/supervision.js";
import { FakeHerdrApp, type FakeApp, type FakeRule, type FakeTerm } from "../helpers/fake-herdr-app.js";
import { makeRepo, makeTestTempDir, reapTestTempDirs } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract B: ONE owned run board split right of the anchor (ORCH) terminal's exact pane,
// through executable hc/herdr-app fakes resolved to explicit paths. The board really runs: its sealed trampoline waits
// on the private launch gate and starts the observer command with the published owner token; the observer side is the
// shipped observeNamedRun (claim, presence, acknowledgement), so ownership is proven by the product's own helpers.

const RUN = "run-20261104-093422-0000000000000814";
const ANCHOR = "t100";
const WATCH = formatOwnedName({ role: "watch", taskId: "run", attempt: 0, runId: RUN });
type Row = { event: string; data: Record<string, unknown> };
type Ui = ReturnType<typeof observeNamedRun> & { token: string };

const fakes: FakeHerdrApp[] = [];
const uis: Ui[] = [];
afterEach(() => {
  for (const u of uis.splice(0)) try { u.close(); } catch { /* already closed */ }
  for (const f of fakes.splice(0)) f.reap();
});
afterAll(() => reapTestTempDirs());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const deadPid = (): number => spawnSync("true").pid!;
const repoId = (repo: string): string => realpathSync(join(repo, ".git"));
const supDir = (repo: string): string => dirname(supervisionPresencePath(repo, "watch", "x"));
const stopFile = (repo: string, token: string): string => join(supDir(repo), `watch-board.${token}.stop`);
const editRecord = (repo: string, patch: Record<string, unknown>): void => {
  const p = join(supDir(repo), `watch-board.${RUN}.json`);
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }) + "\n");
};

/** The anchor's space lists an operator tab FIRST (the active, focused one) and the anchor's own ORCH tab after it. */
const windowApp = (): FakeApp => ({ window: true, nextTab: 0, spaces: [
  { id: "spA", name: "tickmarkr", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101"] }, { id: "tbORCH", name: "ORCH", terminals: [ANCHOR] }] },
] });
const term = (address: string, over: Partial<FakeTerm> = {}): FakeTerm => ({ address, argv: [], cwd: "/", labels: {}, state: "live", parent: null,
  die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: null, signal: null, reason: null, pid: 1, turn: 0,
  screen: { text: "", complete: true }, history: { text: "", complete: true }, ...over });
function fake(repo: string, app: FakeApp = windowApp(), anchorLabels: Record<string, string> = { [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" }): FakeHerdrApp {
  const f = new FakeHerdrApp(makeTestTempDir("hcboard-"), { app, execute: true });
  f.update((s) => { s.terminals[ANCHOR] = term(ANCHOR, { cwd: realpathSync(repo), labels: anchorLabels }); s.terminals.t101 = term("t101"); });
  fakes.push(f);
  return f;
}
/** Real time until `warp`: then each sleep advances the clock by its full request in ~1 ms (acknowledgement windows). */
function clock(): { warp: boolean; now: () => number; sleep: (ms: number) => Promise<void> } {
  let skew = 0;
  const c = { warp: false, now: () => Date.now() + skew, sleep: async (ms: number) => { if (c.warp) { skew += ms; ms = 1; } await sleep(ms); } };
  return c;
}
function driver(f: FakeHerdrApp, rows: Row[], over: HerdrAppDriverOpts = {}): { d: HerdrAppDriver; time: ReturnType<typeof clock> } {
  const time = clock();
  const d = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH, HC_TERMINAL_ID: ANCHOR, HC_TERMINAL_SOCKET: f.read().socket },
    pollMs: 25, placementMs: 15_000, runId: RUN, time, ...over });
  d.journalWith((event, _taskId, data) => { rows.push({ event, data: data ?? {} }); });
  return { d, time };
}
let n = 0;
/** The observer command a board runs: it records the owner token it was started with, then stays up until afterEach reaps it
 *  (a 30 s lifetime let a loaded full suite reach a retirement after the board had finished: no kill, a timing red). */
const observer = (dir: string): { tok: string; command: string } => {
  const tok = join(dir, `token-${++n}`);
  return { tok, command: `printf %s "$${WATCH_OWNER_ENV}" > ${shq(tok)}; exec sleep 600` };
};
/** The UI inside the board: once launched it claims the owner record through the shipped observeNamedRun. */
async function ui(tok: string, repo: string): Promise<Ui> {
  for (const until = Date.now() + 20_000; !(existsSync(tok) && readFileSync(tok, "utf8")); await sleep(20)) {
    if (Date.now() > until) throw new Error(`board never launched (${tok})`);
  }
  const token = readFileSync(tok, "utf8");
  const u = { token, ...observeNamedRun(repo, RUN, { [WATCH_OWNER_ENV]: token }) };
  uis.push(u);
  return u;
}
async function place(d: HerdrAppDriver, repo: string, dir: string): Promise<{ slot: Slot; u: Ui }> {
  const o = observer(dir);
  const [slot, u] = await Promise.all([d.narrator(repo, o.command, RUN), ui(o.tok, repo)]);
  return { slot, u };
}
/** The UI's stop handling: on a stop request, `before` runs, then (with `release`) the UI drops its presence and acks. */
async function ackOnStop(u: Ui, before: () => void = () => {}, release = true): Promise<void> {
  for (const until = Date.now() + 20_000; !u.stopRequested(); await sleep(10)) if (Date.now() > until) throw new Error("no stop requested");
  before();
  if (release) u.close();
}
const splits = (f: FakeHerdrApp): string[][] => f.calls().filter((c) => c.tool === "herdr-app" && c.argv[1] === "pane.split").map((c) => c.argv);
const destroyed = (f: FakeHerdrApp): string[][] => [...f.hcCalls("kill"), ...f.hcCalls("rm")];
const tabOf = (f: FakeHerdrApp, address: string) => f.read().app!.spaces.flatMap((s) => s.tabs).find((t) => t.terminals.includes(address));
const events = (rows: Row[], event: string): Row[] => rows.filter((r) => r.event === event);
/** The claim-wait race: once the owner record is reserved, `mutate` the board terminal; after a get has read the
 *  mutated state, an observer claims the reserved token — so a claim-loop read that ignored the change would succeed. */
async function raceClaim(f: FakeHerdrApp, repo: string, mutate: (s: ReturnType<FakeHerdrApp["read"]>, repo: string) => void, settled: () => boolean): Promise<void> {
  let rec = readWatchBoard(repo, RUN);
  for (; !rec && !settled(); rec = readWatchBoard(repo, RUN)) await sleep(10);
  if (!rec) return;
  f.update((s) => mutate(s, repo));
  const seen = f.hcCalls("get").length; // taken after the locked mutation: every later get reads the mutated state
  while (!settled() && f.hcCalls("get").length <= seen) await sleep(10);
  try { uis.push({ token: rec.token, ...observeNamedRun(repo, RUN, { [WATCH_OWNER_ENV]: rec.token }) }); } catch { /* the token was replaced: nothing to claim */ }
}
/** The final-verification race: once the owner record is reserved, the next window read — the final verification's,
 *  after the claim — is held open; an observer claims the reserved token and, once that read has started, releases its
 *  presence while the board terminal stays live. */
async function releaseDuringVerify(f: FakeHerdrApp, repo: string, settled: () => boolean): Promise<void> {
  let rec = readWatchBoard(repo, RUN);
  for (; !rec && !settled(); rec = readWatchBoard(repo, RUN)) await sleep(10);
  if (!rec) return;
  const reads = (): number => f.calls().filter((c) => c.tool === "herdr-app" && c.argv[0] === "ls").length;
  f.rule({ tool: "herdr-app", match: ["ls"], once: true, pass: true, sleepMs: 2_000 });
  const seen = reads();
  const u = { token: rec.token, ...observeNamedRun(repo, RUN, { [WATCH_OWNER_ENV]: rec.token }) };
  uis.push(u);
  while (!settled() && reads() <= seen) await sleep(10);
  u.close();
}
/** A UI that acknowledges any stop request until `settled`: a retire that asks would be answered. */
async function ackWhile(u: Ui, settled: () => boolean): Promise<void> {
  for (; !settled(); await sleep(10)) if (u.stopRequested()) return u.close();
}
const OTHER_TOKEN = "0f0e0d0c-0000-4000-8000-0000000000aa";
/** The board's labels with its space changed: owner, repo and checkout still ours. */
const otherSpace = (repo: string): Record<string, string> => ({ [OWNER_LABEL]: WATCH, [REPO_LABEL]: repoId(repo), [SPACE_LABEL]: "spZ", [TAB_LABEL]: "tbORCH" });
const SPACE_PROTECTED = /t1 space spZ is not the board's spA; board protected/;
const CLAIMANT_CHANGED = /tickmarkr:watch:\S+ acknowledgement no longer matches its current claimant; board protected/;
const UNREADABLE = (pane: string): string => `the window layout is unreadable \\(pane ${pane} has an empty terminal field, an uncaptured shape\\)`;
const protectFile = (repo: string): string => join(repo, ".tickmarkr", "runs", RUN, "board-protect.json");
const gates = (repo: string): string[] => { try { return readdirSync(join(repo, ".tickmarkr", "runs", RUN)).filter((x) => x.startsWith("board-gate")); } catch { return []; } };

describe("HerdrAppDriver — one board beside the anchor (contract B)", () => {
  it("board creation satisfies the closed split-and-token table while neither tokenless launch nor focused-target substitution succeeds", async () => {
    // Base: exactly one right split of the anchor's EXACT pane row (its own ORCH tab, never the focused operator tab),
    // a sealed bash trampoline carrying the checkout and a run-local gate but never the token, labels and keep verified,
    // and an observer that claims the very token the record was reserved with.
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake(repo);
    const rows: Row[] = [];
    const { d } = driver(f, rows);
    const { slot, u } = await place(d, repo, f.dir);
    const sp = splits(f);
    expect(sp).toHaveLength(1);
    expect(sp[0]!.slice(0, 7)).toEqual(["do", "pane.split", "--direction", "right", "--pane", `p${ANCHOR}`, "--argv"]);
    const argv = JSON.parse(sp[0]![7]!) as string[];
    expect(argv.slice(0, 2)).toEqual(["bash", "-lc"]);
    expect(argv[2]).toContain(`cd ${shq(realpathSync(repo))}`);
    expect(argv[2]).toContain(join(realpathSync(repo), ".tickmarkr", "runs", RUN, "board-gate."));
    expect(argv[2]).not.toContain(u.token); // the token reaches the board only through its released gate
    expect(slot).toMatchObject({ id: "t1", name: WATCH });
    const rec = readWatchBoard(repo, RUN)!;
    expect(rec).toMatchObject({ driver: "herdr-app", workspace: "spA", pane: "t1", name: WATCH, token: u.token, pid: process.pid });
    expect(existsSync(supervisionPresencePath(repo, "watch", rec.armId!))).toBe(true);
    expect(f.hcCalls("label")).toEqual([["label", "t1", `${OWNER_LABEL}=${WATCH}`, `${REPO_LABEL}=${repoId(repo)}`, "--json"]]);
    expect(f.hcCalls("keep")).toEqual([["keep", "t1", "--off", "--json"]]);
    expect(f.term("t1")).toMatchObject({ keep: false, labels: { [OWNER_LABEL]: WATCH, [REPO_LABEL]: repoId(repo), [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" } });
    expect(tabOf(f, "t1")!.terminals).toEqual([ANCHOR, "t1"]);
    expect(f.calls().filter((c) => c.tool === "herdr-app" && c.argv[0] !== "ls" && c.argv[1] !== "pane.split")).toEqual([]); // no rename, no focus
    expect(gates(repo)).toEqual([]); // the launch gate is cleaned after use
    expect(JSON.parse(readFileSync(protectFile(repo), "utf8"))).toEqual({ version: 1, unresolved: [], indeterminate: false }); // the split's intent, discharged
    expect(rows).toEqual([]);

    // Refusals: no window, no space, a missing/ambiguous/misplaced anchor row or no anchor at all — a named reason, a
    // boardless journal row, and no split anywhere: the focused operator pane is never substituted for the anchor.
    const refusals: [string, FakeApp, Record<string, string> | undefined, HerdrAppDriverOpts, RegExp][] = [
      ["no window", { ...windowApp(), window: false }, undefined, {}, /board unavailable: no window/],
      ["absent space", windowApp(), {}, {}, /board unavailable: anchor t100 is in no window space/],
      ["missing anchor pane", { window: true, nextTab: 0, spaces: [{ id: "spA", name: "t", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101"] }] }] }, undefined, {},
        /anchor t100 has 0 pane row\(s\), not exactly one in space spA/],
      ["ambiguous anchor pane", { window: true, nextTab: 0, spaces: [{ id: "spA", name: "t", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101", ANCHOR] }, { id: "tbORCH", name: "ORCH", terminals: [ANCHOR] }] }] },
        undefined, {}, /anchor t100 has 2 pane row\(s\)/],
      ["anchor row outside its space", { window: true, nextTab: 0, spaces: [{ id: "spA", name: "t", tabs: [] }, { id: "spB", name: "b", tabs: [{ id: "tbB", name: "B", terminals: [ANCHOR] }] }] },
        undefined, {}, /anchor t100 has 1 pane row\(s\), not exactly one in space spA/],
      ["no anchor terminal", windowApp(), undefined, { env: { PATH: process.env.PATH } }, /board unavailable: no anchor terminal \(HC_TERMINAL_ID unset\)/],
      // A pane row with an empty terminal field is an uncaptured layout shape: unreadable, never placed beside.
      ["window row with an empty terminal field", { ...windowApp(), cleared: ["t101"] }, undefined, {}, new RegExp(`board unavailable: ${UNREADABLE("pt101")}`)],
    ];
    const bare = makeRepo({ "a.txt": "a" });
    for (const [mode, app, labels, over, refusal] of refusals) {
      const g = fake(bare, app, labels);
      const r: Row[] = [];
      await expect(driver(g, r, over).d.narrator(bare, "true", RUN), mode).rejects.toThrow(refusal);
      expect(splits(g), mode).toEqual([]);
      expect([...g.hcCalls("label"), ...destroyed(g)], mode).toEqual([]);
      expect(r.map((x) => x.event), mode).toEqual(["herdr-app-boardless"]);
      expect(r[0]!.data.reason as string, mode).toMatch(refusal);
      expect(readWatchBoard(bare, RUN), mode).toBeUndefined();
    }
    await expect(driver(fake(bare), []).d.narrator(bare, "true")).rejects.toThrow(/requires a run identity/);

    // The newest layout read before the split is THE layout for every pre-split decision (D-2180 add.22): a change landing
    // after the first read (here at retirePrior's hc listing) is what the anchor is re-resolved from and the split aims at.
    {
      // Unique at first, duplicated in the newest read: ambiguous, so refused boardless with no split.
      const r0 = makeRepo({ "a.txt": "a" });
      const g = fake(r0);
      g.rule({ match: ["ls"], once: true, pass: true, app: { spaces: [{ id: "spA", name: "tickmarkr", tabs: [
        { id: "tbOPER", name: "1", terminals: ["t101", ANCHOR] }, { id: "tbORCH", name: "ORCH", terminals: [ANCHOR] }] }] } });
      const r: Row[] = [];
      await expect(driver(g, r).d.narrator(r0, "true", RUN)).rejects.toThrow(/board unavailable: anchor t100 has 2 pane row\(s\), not exactly one in space spA/);
      expect(g.read().rules).toEqual([]); // the change landed between the first layout read and the newest
      expect(splits(g)).toEqual([]);
      expect([...g.hcCalls("label"), ...destroyed(g)]).toEqual([]);
      expect(r.map((x) => x.event)).toEqual(["herdr-app-boardless"]);
    }
    {
      // The newest read re-maps the anchor to another pane of its tab and hands its former pane to another terminal: the
      // split aims at the anchor's NEWER pane — never beside that other terminal — and the board is bound right of it.
      const r0 = makeRepo({ "a.txt": "a" });
      const g = fake(r0);
      g.update((s) => { s.terminals.t102 = term("t102"); s.app!.spaces[0]!.tabs[1]!.terminals.push("t102"); });
      g.rule({ match: ["ls"], once: true, pass: true, app: { panes: { [ANCHOR]: "pq7", t102: `p${ANCHOR}` } } });
      const { slot } = await place(driver(g, []).d, r0, g.dir);
      expect(splits(g).map((a) => a.slice(0, 6))).toEqual([["do", "pane.split", "--direction", "right", "--pane", "pq7"]]);
      expect(slot.id).toBe("t1");
      expect(tabOf(g, "t1")).toMatchObject({ id: "tbORCH", terminals: [ANCHOR, "t1", "t102"] });
      expect(readWatchBoard(r0, RUN)).toMatchObject({ pane: "t1", workspace: "spA", pid: process.pid });
    }

    // The trampoline never launches tokenless: a dead creator, an unreleased gate and an empty gate all exit without
    // running the observer; only a released gate starts it, carrying exactly the published token, and is consumed.
    const dir = makeTestTempDir("hcgate-");
    const marker = join(dir, "launched");
    const launch = `printf %s "$${WATCH_OWNER_ENV}" > ${shq(marker)}`;
    const gateRun = (gate: string, creator: number, waitMs: number): number | null =>
      spawnSync("bash", ["-c", boardTrampoline(dir, gate, launch, creator, waitMs)], { encoding: "utf8" }).status;
    expect(gateRun(join(dir, "g1"), deadPid(), 5_000)).toBe(1);
    expect(gateRun(join(dir, "g2"), process.pid, 300)).toBe(1);
    writeFileSync(join(dir, "g3"), "");
    expect(gateRun(join(dir, "g3"), process.pid, 300)).toBe(1);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(dir, "g4"), "0f0e0d0c-0000-4000-8000-000000000001");
    expect(gateRun(join(dir, "g4"), process.pid, 300)).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("0f0e0d0c-0000-4000-8000-000000000001");
    expect(existsSync(join(dir, "g4"))).toBe(false);
  }, 120_000);

  it("cached reuse and uncached prior-board retirement satisfy the closed placement table while unproved retirement stays protected and boardless", async () => {
    // Cached: the same live binding answers again with no split.
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake(repo);
    const { d } = driver(f, []);
    const first = await place(d, repo, f.dir);
    expect(await d.narrator(repo, "never-run", RUN)).toBe(first.slot);
    expect(splits(f)).toHaveLength(1);

    // Cached, but no longer claimed (its presence gone, or its claimant dead) while the terminal lives and the token is
    // unchanged: never answered again — rediscovered by its owner label and, its UI not live and claimed, protected.
    const unclaimed: [string, (repo: string, u: Ui) => void][] = [
      ["claimed presence removed", (r) => rmSync(supervisionPresencePath(r, "watch", readWatchBoard(r, RUN)!.armId!))],
      ["claimant dead", (r) => editRecord(r, { pid: deadPid() })],
    ];
    for (const [mode, lose] of unclaimed) {
      const r = makeRepo({ "a.txt": "a" });
      const g = fake(r);
      const rr: Row[] = [];
      const x = driver(g, rr);
      const p = await place(x.d, r, g.dir);
      lose(r, p.u);
      g.clearCalls();
      await expect(x.d.narrator(r, "never-run", RUN), mode).rejects
        .toThrow(/prior board t1 \(pane pt1\) is not proven gone \(still listed in hc\); its cached binding failed verification \(no live claimed UI\); protected, none stacked/);
      expect(splits(g), mode).toEqual([]);
      expect(destroyed(g), mode).toEqual([]);
      expect(g.read().terminals.t1?.state, mode).toBe("live");
      expect(rr.map((e) => e.event), mode).toEqual(["herdr-app-boardless"]);
      // The binding stayed cached under its original identity, so the daemon's lost-board path still retires it exactly
      // and the next narrator places one fresh claimed board.
      await x.d.retireLostWatch(p.slot);
      expect(destroyed(g).map((a) => [a[0], a[1]]), mode).toEqual([["kill", "t1"], ["rm", "t1"]]);
      expect((await place(x.d, r, g.dir)).slot.id, mode).toBe("t2");
      expect(splits(g), mode).toHaveLength(1);
    }

    // Cached, but its identity changed under it — a moved checkout, a replacement token whose own UI claims it, or hc
    // forgetting it while its pane survives with a cleared terminal field. The binding keeps its ORIGINAL cwd, token and
    // pane: nothing is re-derived from the changed terminal or record, so — even with UIs ready to acknowledge any stop —
    // no stop is asked, nothing is destroyed and nothing is split, on the first narrator and on a retry.
    const changed: [string, (r: string, g: FakeHerdrApp) => Ui | undefined, RegExp][] = [
      ["checkout moved", (_r, g) => { g.update((s) => { s.terminals.t1!.cwd = "/elsewhere"; }); return undefined; },
        /prior board t1 \(pane pt1\) is not proven gone \(still listed in hc\); its cached binding failed verification \(t1 is not this slot's terminal \(checkout differs\)\); protected, none stacked/],
      ["replacement token claimed", (r) => {
        const o = reserveWatchBoard({ repo: r, runId: RUN, driver: "herdr-app", workspace: "spA", pane: "t1", name: WATCH });
        const nu = { token: o.token, ...observeNamedRun(r, RUN, { [WATCH_OWNER_ENV]: o.token }) };
        uis.push(nu);
        return nu;
      }, /prior board t1 \(pane pt1\) is not proven gone \(still listed in hc\); its cached binding failed verification \(owner record changed \(token or identity\)\); protected, none stacked/],
      ["hc forgets it while its cleared pane survives", (_r, g) => { g.update((s) => { delete s.terminals.t1; s.app!.cleared = ["t1"]; }); return undefined; },
        new RegExp(`prior board t1 \\(pane pt1\\) is not proven gone \\(${UNREADABLE("pt1")}\\); its cached binding failed verification \\(t1 is gone\\); protected, none stacked`)],
    ];
    for (const [mode, change, refusal] of changed) {
      const r = makeRepo({ "a.txt": "a" });
      const g = fake(r);
      const rr: Row[] = [];
      const x = driver(g, rr);
      const p = await place(x.d, r, g.dir);
      const nu = change(r, g);
      g.clearCalls();
      for (let attempt = 1; attempt <= 2; attempt++) {
        let settled = false;
        const acks = [p.u, nu].filter((u): u is Ui => !!u).map((u) => ackWhile(u, () => settled));
        await expect(x.d.narrator(r, "never-run", RUN).finally(() => { settled = true; }), mode).rejects.toThrow(refusal);
        await Promise.all(acks);
        expect(splits(g), mode).toEqual([]);
        expect(destroyed(g), mode).toEqual([]);
        for (const u of [p.u, nu]) if (u) expect(existsSync(stopFile(r, u.token)), mode).toBe(false);
        expect(events(rr, "herdr-app-boardless"), mode).toHaveLength(attempt);
      }
    }

    // Uncached (a fresh driver, as a resumed daemon): exactly one prior board with matching record, labels and a live
    // claimed UI is retired gracefully — stop, matching ack, presence gone, kill/rm/absence — and only then split once.
    const rows: Row[] = [];
    const { d: fresh } = driver(f, rows);
    const o = observer(f.dir);
    f.clearCalls();
    const [slot, , u] = await Promise.all([fresh.narrator(repo, o.command, RUN), ackOnStop(first.u), ui(o.tok, repo)]);
    expect(existsSync(stopFile(repo, first.u.token))).toBe(true);
    expect(destroyed(f).map((a) => [a[0], a[1]])).toEqual([["kill", "t1"], ["rm", "t1"]]);
    const order = f.calls().map((c) => c.argv.slice(0, 2).join(" "));
    expect(order.indexOf("rm t1")).toBeLessThan(order.indexOf("do pane.split")); // retired before the one fresh split
    expect(f.read().terminals.t1).toBeUndefined();
    expect(tabOf(f, "t1")).toBeUndefined();
    expect(splits(f)).toHaveLength(1);
    expect(slot.id).toBe("t2");
    expect(readWatchBoard(repo, RUN)).toMatchObject({ pane: "t2", token: u.token, pid: process.pid });
    expect(rows).toEqual([]);

    // Space is identity on prior retirement's destructive steps: an acknowledged prior board whose kill receipt names
    // another space is never removed, and neither that narrator nor its retry splits.
    {
      const r = makeRepo({ "a.txt": "a" });
      const g = fake(r);
      const p = await place(driver(g, []).d, r, g.dir);
      const { d: y } = driver(g, []);
      g.rule({ match: ["kill"], pass: true, mutate: { t1: { labels: otherSpace(r) } } });
      g.clearCalls();
      await expect(Promise.all([y.narrator(r, "never-run", RUN), ackOnStop(p.u)])).rejects.toThrow(SPACE_PROTECTED);
      await expect(y.narrator(r, "never-run", RUN)).rejects.toThrow(/prior board t1 \(pane pt1\) is not proven gone \(still listed in hc\); protected, none stacked/);
      expect(destroyed(g).map((a) => [a[0], a[1]])).toEqual([["kill", "t1"]]);
      expect(splits(g)).toEqual([]);
    }

    // The newest reads before the split are THE prior-board evidence: t50 lands only after retirePrior's scan (at its last
    // read). Listed in hc carrying the watch owner, or named by the owner record and listed in hc or in the window — a
    // window row not required — it is a surviving prior: protected, its record kept, zero split. Controls: an unrecorded
    // unlabelled t50 is no prior, and a record whose terminal is gone everywhere is a retired one — one split each.
    for (const recorded of [true, false]) for (const t50 of ["absent", "unlabelled", "same-name"] as const) for (const shown of [true, false]) {
      const mode = `late t50: ${recorded ? "recorded" : "unrecorded"}, ${t50} in hc, ${shown ? "shown" : "no window row"}`;
      const r = makeRepo({ "a.txt": "a" });
      const g = fake(r);
      if (recorded) reserveWatchBoard({ repo: r, runId: RUN, driver: "herdr-app", workspace: "spA", pane: "t50", name: WATCH });
      const labels = t50 === "same-name" ? { [OWNER_LABEL]: WATCH, [REPO_LABEL]: repoId(r), [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" } : {};
      g.rule({ match: ["get", "t101"], once: true, pass: true, ...(t50 === "absent" ? {} : { mutate: { t50: { cwd: realpathSync(r), labels } } }),
        ...(shown ? { app: { spaces: [{ id: "spA", name: "tickmarkr", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101"] }, { id: "tbORCH", name: "ORCH", terminals: [ANCHOR, "t50"] }] }] } } : {}) });
      const rr: Row[] = [];
      const x = driver(g, rr, { placementMs: 1_500 });
      const refusal = t50 === "same-name" || (recorded && t50 !== "absent") ? /prior board t50 survives in hc/ : recorded && shown ? /prior board t50 survives in the window/ : undefined;
      if (refusal) {
        await expect(x.d.narrator(r, "never-run", RUN), mode).rejects.toThrow(refusal);
        expect(splits(g), mode).toEqual([]);
        expect(destroyed(g), mode).toEqual([]);
        if (recorded) expect(readWatchBoard(r, RUN)?.pane, mode).toBe("t50"); // the prior owner record is never replaced
        expect(rr.map((e) => e.event), mode).toEqual(["herdr-app-boardless"]);
      } else {
        expect((await place(x.d, r, g.dir)).slot.id, mode).toBe("t1");
        expect(splits(g), mode).toHaveLength(1);
      }
      expect(g.read().rules, mode).toEqual([]); // it landed after retirePrior's hc listing
    }

    // Unproved: a same-name prior board lacking any piece of evidence — or whose live UI never acknowledges — is
    // protected: no kill, no rm, no second board, and a boardless row.
    const unproved: [string, (repo: string, f: FakeHerdrApp, u: Ui) => void, RegExp][] = [
      ["no owner record", (r) => rmSync(join(supDir(r), `watch-board.${RUN}.json`)), /lacks matching/],
      ["record names another terminal", (r) => editRecord(r, { pane: "t77" }), /lacks matching/],
      ["record in another space", (r) => editRecord(r, { workspace: "spZ" }), /lacks matching/],
      ["foreign repo label", (_r, g) => g.update((s) => { s.terminals.t50!.labels[REPO_LABEL] = "/elsewhere/.git"; }), /lacks matching/],
      ["two same-name boards", (_r, g) => g.update((s) => { s.terminals.t51 = { ...s.terminals.t50!, address: "t51" }; }), /lacks matching/],
      ["dead UI", (r, _g, pu) => { pu.close(); editRecord(r, { pid: deadPid() }); }, /lacks matching/],
      ["live UI never acknowledges", () => {}, /watch cleanup unacknowledged/],
    ];
    for (const [mode, mutate, refusal] of unproved) {
      const r = makeRepo({ "a.txt": "a" });
      const g = fake(r);
      g.update((s) => {
        s.terminals.t50 = term("t50", { cwd: realpathSync(r), labels: { [OWNER_LABEL]: WATCH, [REPO_LABEL]: repoId(r), [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" } });
        s.app!.spaces[0]!.tabs[1]!.terminals.push("t50");
      });
      const owner = reserveWatchBoard({ repo: r, runId: RUN, driver: "herdr-app", workspace: "spA", pane: "t50", name: WATCH });
      const pu = { token: owner.token, ...observeNamedRun(r, RUN, { [WATCH_OWNER_ENV]: owner.token }) };
      uis.push(pu);
      mutate(r, g, pu);
      const rr: Row[] = [];
      const x = driver(g, rr);
      x.time.warp = true;
      await expect(x.d.narrator(r, "never-run", RUN), mode).rejects.toThrow(refusal);
      expect(splits(g), mode).toEqual([]);
      expect(destroyed(g), mode).toEqual([]);
      expect(g.read().terminals.t50, mode).toBeDefined();
      expect(rr.map((e) => e.event), mode).toEqual(["herdr-app-boardless"]);
    }
  }, 180_000);

  it("failed board setup satisfies the closed receipt-bound cleanup table while unknown receipts never authorize unrelated cleanup", async () => {
    const hcRefusal = '{"error":{"kind":"refused","message":"refused"}}\n';
    type Case = { rules?: FakeRule[]; command?: string; setup?: (repo: string) => void; over?: HerdrAppDriverOpts; refusal: RegExp;
      outcome: "untouched" | "taken back" | "unconfirmed"; unlabelled?: true; kept?: true; race?: (s: ReturnType<FakeHerdrApp["read"]>, repo: string) => void;
      release?: true };
    const cases: Record<string, Case> = {
      // Unknown receipts: nothing to take back, and the unrelated terminal the bad receipt's pane names survives.
      "split refused": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], output: '{"error":"no such pane"}\n', exit: 1 }],
        refusal: /board placement indeterminate .*no guessed cleanup and no second split/, outcome: "untouched" },
      "receipt without a terminal": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], output: '{"pane":"pt9"}\n' }],
        refusal: /board placement indeterminate/, outcome: "untouched" },
      "receipt naming a remote terminal": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], output: '{"pane":"pt9","terminal":"m1/t9"}\n' }],
        refusal: /board placement indeterminate .*not a local address/, outcome: "untouched" },
      // The split really created its terminal but the receipt is lost: nobody can name it, so it is left alone.
      "creation succeeds but its receipt is lost": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], pass: true, output: '{"pane":"pt1",\n' }],
        over: { placementMs: 1_500 }, refusal: /board placement indeterminate .*no guessed cleanup and no second split/, outcome: "untouched" },
      // The split created t1 but its receipt names something that existed before it — the unlabelled anchor, a listed
      // terminal or a window pane: it binds nothing new, so no terminal is labelled, kept off, killed or removed.
      "receipt names the existing anchor terminal": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], pass: true, output: '{"pane":"pt1","terminal":"t100"}\n' }],
        over: { placementMs: 1_500 }, refusal: /board placement indeterminate .*names an existing terminal or pane, not the split's.*no guessed cleanup and no second split/, outcome: "untouched" },
      "receipt names the anchor terminal and its pane": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], pass: true, output: '{"pane":"pt100","terminal":"t100"}\n' }],
        over: { placementMs: 1_500 }, refusal: /board placement indeterminate .*names an existing terminal or pane, not the split's.*no guessed cleanup and no second split/, outcome: "untouched" },
      "receipt names a listed unrelated terminal": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], pass: true, output: '{"pane":"pt1","terminal":"t9"}\n' }],
        over: { placementMs: 1_500 }, refusal: /board placement indeterminate .*names an existing terminal or pane, not the split's.*no guessed cleanup and no second split/, outcome: "untouched" },
      "receipt names a pre-existing pane": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], pass: true, output: '{"pane":"pt9","terminal":"t1"}\n' }],
        over: { placementMs: 1_500 }, refusal: /board placement indeterminate .*names an existing terminal or pane, not the split's.*no guessed cleanup and no second split/, outcome: "untouched" },
      // Known receipt: only that terminal is taken back, and nothing ever ran tokenless.
      "label refused": { rules: [{ match: ["label"], stderr: hcRefusal, exit: 1 }], refusal: /board setup failed .*split t1 taken back/, outcome: "taken back" },
      "keep refused": { rules: [{ match: ["keep"], stderr: hcRefusal, exit: 1 }], refusal: /board setup failed .*split t1 taken back/, outcome: "taken back" },
      "reservation refused": { setup: (r) => { mkdirSync(join(r, ".tickmarkr"), { recursive: true }); writeFileSync(join(r, ".tickmarkr", "supervision"), "not a directory\n"); },
        refusal: /board setup failed .*split t1 taken back/, outcome: "taken back" },
      "observer never claims": { command: "exec sleep 30", over: { placementMs: 1_500 }, refusal: /no observer claimed the board.*split t1 taken back/, outcome: "taken back" },
      "observer exits unclaimed": { command: "exit 0", refusal: /t1 finished before its observer claimed the board.*split t1 taken back/, outcome: "taken back" },
      // Claimed presence is re-proven after the final asynchronous verification: an observer releasing it during that
      // verification, its terminal still live, leaves an unclaimed board — taken back, never cached or returned.
      "observer releases its presence during the final verification": { command: "exec sleep 30", release: true,
        refusal: /board setup failed \(the observer's claim did not hold through the final verification \(matching pid, arm and presence\)\); split t1 taken back/, outcome: "taken back" },
      // Cleanup that cannot be proven, or a receipt terminal that now carries a foreign owner: never claimed success.
      "removal refused": { rules: [{ match: ["label"], stderr: hcRefusal, exit: 1 }, { match: ["rm"], stderr: hcRefusal, exit: 1 }],
        refusal: /board setup failed .*cleanup unconfirmed for t1/, outcome: "unconfirmed" },
      "foreign owner on the receipt": { rules: [{ match: ["label"], stderr: hcRefusal, exit: 1, mutate: { t1: { labels: { [OWNER_LABEL]: "tickmarkr:worker:T9:0:run-other" } } } }],
        refusal: /board setup failed .*cleanup unconfirmed for t1 \(t1 carries a foreign owner; protected\)/, outcome: "unconfirmed" },
      // The receipt address on a restarted core is someone else's terminal: neither labelled, kept off nor destroyed.
      "core restarted after the receipt": { rules: [{ tool: "herdr-app", match: ["do", "pane.split"], pass: true, coreId: "core-restarted" }],
        refusal: /board setup failed \(core identity changed; t1 protected\); cleanup unconfirmed for t1 \(core identity changed\)/, outcome: "unconfirmed", unlabelled: true },
      // Our labels remain but the checkout moved: setup refuses it and so does rollback — never killed or removed.
      "checkout changed under our labels": { rules: [{ match: ["keep"], stderr: hcRefusal, exit: 1, mutate: { t1: { cwd: "/elsewhere" } } }],
        refusal: /board setup failed .*cleanup unconfirmed for t1 \(t1 checkout differs; protected\)/, outcome: "unconfirmed", kept: true },
      // The kill receipt is ownership evidence: one naming another owner stops the rollback before rm.
      "kill receipt names another owner": { rules: [{ match: ["label"], stderr: hcRefusal, exit: 1 },
        { match: ["kill"], pass: true, mutate: { t1: { labels: { [OWNER_LABEL]: "tickmarkr:worker:T9:0:run-other", [SPACE_LABEL]: "spA" } } } }],
        refusal: /board setup failed .*cleanup unconfirmed for t1 \(ownership lost during kill \(t1 carries a foreign owner; protected\); not removed\)/, outcome: "unconfirmed" },
      // hc removal alone is not absence: a window pane that survives it is unconfirmed cleanup, never success.
      "hc removal leaves the window pane": { rules: [{ match: ["label"], stderr: hcRefusal, exit: 1 }, { match: ["rm"], remove: ["t1"], output: '{"removed":"t1"}\n' }],
        refusal: /board setup failed .*cleanup unconfirmed for t1 \(.*t1 \(pane pt1\) is still in the window after close\)/, outcome: "unconfirmed" },
      // The claim wait reads the board only through the receipt-bound proof: a foreign owner or moved checkout seen
      // there fails setup even though an observer then claims the token — never a cached, returned board.
      "claim-loop read shows a foreign owner": { command: "exec sleep 30", race: (s) => { s.terminals.t1!.labels[OWNER_LABEL] = "tickmarkr:worker:T9:0:run-other"; },
        refusal: /board setup failed \(t1 carries a foreign owner; protected\); cleanup unconfirmed for t1 \(t1 carries a foreign owner; protected\)/, outcome: "unconfirmed", kept: true },
      "claim-loop read shows a changed checkout under our labels": { command: "exec sleep 30", race: (s) => { s.terminals.t1!.cwd = "/elsewhere"; },
        refusal: /board setup failed \(t1 checkout differs; protected\); cleanup unconfirmed for t1 \(t1 checkout differs; protected\)/, outcome: "unconfirmed", kept: true },
      // Once our labels were verified on it, a terminal that loses them is a lost owner — never an unlabelled fresh split
      // — and rollback protects it too.
      "ownership labels removed after verification": { command: "exec sleep 30",
        race: (s) => { delete s.terminals.t1!.labels[OWNER_LABEL]; delete s.terminals.t1!.labels[REPO_LABEL]; },
        refusal: /board setup failed \(t1 lost its ownership labels; protected\); cleanup unconfirmed for t1 \(t1 lost its ownership labels; protected\)/, outcome: "unconfirmed", kept: true },
      // After reservation the owner record is ownership evidence: a replaced token fails setup and protects rollback,
      // with the terminal's labels and checkout unchanged.
      "owner token replaced during the claim wait": { command: "exec sleep 30", race: (_s, r) => editRecord(r, { token: OTHER_TOKEN }),
        refusal: /board setup failed \(the owner record changed before its observer claimed it\); cleanup unconfirmed for t1 \(tickmarkr:watch:.* owner record changed \(token or identity\); protected\)/,
        outcome: "unconfirmed", kept: true },
    };
    for (const [mode, c] of Object.entries(cases)) {
      const repo = makeRepo({ "a.txt": "a" });
      c.setup?.(repo);
      const f = fake(repo);
      f.update((s) => { s.terminals.t9 = term("t9"); s.app!.spaces[0]!.tabs[1]!.terminals.push("t9"); }); // unrelated, unlabelled
      if (c.rules) f.rule(...c.rules);
      const rows: Row[] = [];
      const o = observer(f.dir);
      const { d } = driver(f, rows, c.over);
      let settled = false;
      const placed = d.narrator(repo, c.command ?? o.command, RUN).finally(() => { settled = true; });
      const race = c.race ? raceClaim(f, repo, c.race, () => settled) : c.release ? releaseDuringVerify(f, repo, () => settled) : undefined;
      await expect(placed, mode).rejects.toThrow(c.refusal);
      await race;
      expect(splits(f), mode).toHaveLength(1); // never a second split
      expect(existsSync(o.tok), mode).toBe(false); // no observer started tokenless
      expect(f.read().terminals.t9, mode).toBeDefined();
      expect(destroyed(f).every((a) => a[1] === "t1"), mode).toBe(true);
      expect(gates(repo), mode).toEqual([]);
      const unconfirmed = events(rows, "herdr-app-cleanup-unconfirmed");
      if (c.outcome === "untouched") {
        expect(destroyed(f), mode).toEqual([]);
        expect(unconfirmed, mode).toEqual([]);
        if (mode === "creation succeeds but its receipt is lost" || mode.startsWith("receipt names")) expect(tabOf(f, "t1"), mode).toBeDefined();
        expect([...f.hcCalls("label"), ...f.hcCalls("keep")], mode).toEqual([]); // no setup mutation on any terminal
        expect(f.term(ANCHOR), mode).toMatchObject({ state: "live", labels: { [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" } });
        expect(f.term(ANCHOR).labels[OWNER_LABEL], mode).toBeUndefined();
        // An indeterminate placement is never retried: the daemon's next narrator refuses, naming it, with no split.
        await expect(d.narrator(repo, "never-run", RUN), mode).rejects
          .toThrow(new RegExp(`an earlier board placement for ${RUN} was indeterminate \\(.+\\); its terminal is left to its own bounded gate wait, no second split`));
        expect(splits(f), mode).toHaveLength(1);
        expect(events(rows, "herdr-app-boardless"), mode).toHaveLength(2);
        // ...nor by any later driver for that run (a resumed daemon): board-protect.json carries the indeterminate
        // placement, written before the failure was reported, so the total split count stays one.
        expect(JSON.parse(readFileSync(protectFile(repo), "utf8")), mode).toEqual({ version: 1, unresolved: [], indeterminate: true });
        const fr: Row[] = [];
        await expect(driver(f, fr).d.narrator(repo, "never-run", RUN), mode).rejects
          .toThrow(new RegExp(`an earlier board placement for ${RUN} was indeterminate \\(recorded in board-protect.json\\); its terminal is left to its own bounded gate wait, no second split`));
        expect(splits(f), mode).toHaveLength(1);
        expect(events(fr, "herdr-app-boardless"), mode).toHaveLength(1);
        continue;
      } else if (c.outcome === "taken back") {
        expect(f.read().terminals.t1, mode).toBeUndefined();
        expect(tabOf(f, "t1"), mode).toBeUndefined();
        expect(unconfirmed, mode).toEqual([]);
      } else {
        expect(tabOf(f, "t1"), mode).toBeDefined();
        expect(unconfirmed.map((e) => e.data.address), mode).toEqual(["t1"]);
      }
      if (c.unlabelled) expect([...f.hcCalls("label"), ...f.hcCalls("keep"), ...destroyed(f)], mode).toEqual([]);
      if (c.kept) expect(destroyed(f), mode).toEqual([]);
      if (mode === "kill receipt names another owner") expect(f.hcCalls("rm"), mode).toEqual([]);
      expect(events(rows, "herdr-app-boardless"), mode).toHaveLength(1);
      if (c.outcome === "unconfirmed") {
        // Generalised: ANY cleanup not proven absent from hc and the window — reserved or not — keeps its receipt binding
        // (terminal and pane), and the next narrator re-proves it gone before any split: here it is not, so no split.
        await expect(d.narrator(repo, "never-run", RUN), mode).rejects.toThrow(/prior board t1 \(pane pt1\) is not proven gone \(still (listed in hc|in the window)\); protected, none stacked/);
        expect(splits(f), mode).toHaveLength(1);
        expect(events(rows, "herdr-app-boardless"), mode).toHaveLength(2);
        // The binding is persisted in the run's board-protect.json before the failure is reported, so a FRESH driver for
        // the same run (a resumed daemon) — which finds neither a cached board nor, for an unlabelled one, a same-name
        // terminal — still refuses boardless with zero splits.
        expect(JSON.parse(readFileSync(protectFile(repo), "utf8")), mode).toEqual({ version: 1, unresolved: [{ address: "t1", pane: "pt1" }], indeterminate: false });
        const fr: Row[] = [];
        await expect(driver(f, fr).d.narrator(repo, "never-run", RUN), mode).rejects.toThrow(/prior board t1 \(pane pt1\) is not proven gone \(still (listed in hc|in the window)\); protected, none stacked/);
        expect(splits(f), mode).toHaveLength(1);
        expect(events(fr, "herdr-app-boardless"), mode).toHaveLength(1);
      } else expect(JSON.parse(readFileSync(protectFile(repo), "utf8")), mode).toEqual({ version: 1, unresolved: [], indeterminate: false }); // its binding, discharged by proven absence
    }

    // Daemon death mid-setup: the split's intent is recorded before it is issued and becomes its receipt binding before
    // any setup mutation, so a FRESH driver (a resumed daemon) meeting the surviving unlabelled pane — no owner record,
    // no same-name terminal, no cached board — never splits again; the dying daemon's call is only abandoned, and once
    // it proves its take-back the binding is discharged and the next driver splits exactly once.
    const deaths: [string, FakeRule, RegExp, unknown][] = [
      ["split created its terminal, receipt not yet received", { tool: "herdr-app", match: ["do", "pane.split"], pass: true, sleepMs: 6_000, once: true },
        new RegExp(`an earlier board placement for ${RUN} was indeterminate \\(recorded in board-protect.json\\); its terminal is left to its own bounded gate wait, no second split`),
        { version: 1, unresolved: [], indeterminate: true }],
      ["receipt bound, labelling not yet answered", { match: ["label"], stderr: hcRefusal, exit: 1, sleepMs: 6_000, once: true },
        /prior board t1 \(pane pt1\) is not proven gone \(still listed in hc\); protected, none stacked/,
        { version: 1, unresolved: [{ address: "t1", pane: "pt1" }], indeterminate: false }],
    ];
    for (const [mode, rule, refusal, owed] of deaths) {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      f.rule(rule);
      const o = observer(f.dir);
      const dying = driver(f, [], { placementMs: 1_500 }).d.narrator(repo, o.command, RUN).then(() => undefined, (e: unknown) => e);
      const at = (): boolean => !!f.read().terminals.t1 && (rule.tool === "herdr-app" || f.hcCalls("label").length > 0);
      for (const until = Date.now() + 10_000; !at(); await sleep(10)) if (Date.now() > until) throw new Error(`${mode}: never reached`);
      expect(JSON.parse(readFileSync(protectFile(repo), "utf8")), mode).toEqual(owed);
      expect(f.term("t1").labels[OWNER_LABEL], mode).toBeUndefined(); // the surviving pane is unlabelled
      expect(readWatchBoard(repo, RUN), mode).toBeUndefined();
      const fr: Row[] = [];
      await expect(driver(f, fr, { placementMs: 1_500 }).d.narrator(repo, "never-run", RUN), mode).rejects.toThrow(refusal);
      expect(splits(f), mode).toHaveLength(1);
      expect(events(fr, "herdr-app-boardless"), mode).toHaveLength(1);
      expect(String(await dying), mode).toMatch(/board setup failed .*split t1 taken back/);
      expect(JSON.parse(readFileSync(protectFile(repo), "utf8")), mode).toEqual({ version: 1, unresolved: [], indeterminate: false });
      expect((await place(driver(f, []).d, repo, f.dir)).slot.id, mode).toBe("t2");
      expect(splits(f), mode).toHaveLength(2);
    }

    // The run's protection file is read before any retirement or split: unreadable, malformed or of an unknown version
    // refuses boardless with zero splits — never read as nothing owed.
    const corrupt: Record<string, string> = {
      "not JSON": "{ version: 1,\n",
      "unknown version": JSON.stringify({ version: 2, unresolved: [], indeterminate: false }),
      "malformed entry": JSON.stringify({ version: 1, unresolved: [{ pane: "pt1" }], indeterminate: false }),
      "missing indeterminate": JSON.stringify({ version: 1, unresolved: [] }),
    };
    for (const [mode, body] of Object.entries(corrupt)) {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      mkdirSync(dirname(protectFile(repo)), { recursive: true });
      writeFileSync(protectFile(repo), body);
      const rows: Row[] = [];
      await expect(driver(f, rows).d.narrator(repo, "never-run", RUN), mode).rejects
        .toThrow(new RegExp(`board protection for ${RUN} is unreadable \\(.*board-protect\\.json (is malformed|has an unknown version)\\); none stacked, no split`));
      expect(splits(f), mode).toEqual([]);
      expect(readFileSync(protectFile(repo), "utf8"), mode).toBe(body); // left as it is: it keeps refusing
      expect(events(rows, "herdr-app-boardless"), mode).toHaveLength(1);
    }

    // Generalised over the newest reads: an owed entry proven absent at the start of placement but back in the window by
    // the newest layout read before the split is re-proven there — never discharged, never split over.
    {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      mkdirSync(dirname(protectFile(repo)), { recursive: true });
      writeFileSync(protectFile(repo), JSON.stringify({ version: 1, unresolved: [{ address: "t7", pane: "pt7" }], indeterminate: false }));
      f.rule({ match: ["get", ANCHOR], once: true, pass: true, app: { spaces: [{ id: "spA", name: "tickmarkr", tabs: [
        { id: "tbOPER", name: "1", terminals: ["t101"] }, { id: "tbORCH", name: "ORCH", terminals: [ANCHOR, "t7"] }] }] } });
      const rows: Row[] = [];
      await expect(driver(f, rows, { placementMs: 1_500 }).d.narrator(repo, "never-run", RUN)).rejects
        .toThrow(/prior board t7 \(pane pt7\) is not proven gone \(still in the window\); protected, none stacked/);
      expect(f.read().rules).toEqual([]);
      expect(splits(f)).toEqual([]);
      expect(JSON.parse(readFileSync(protectFile(repo), "utf8"))).toEqual({ version: 1, unresolved: [{ address: "t7", pane: "pt7" }], indeterminate: false });
      expect(events(rows, "herdr-app-boardless")).toHaveLength(1);
    }

    // The control: an entry proven absent (no hc listing of its address, no window row with its terminal or pane) is
    // removed by an atomic rewrite, and that fresh driver then splits exactly once.
    {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      mkdirSync(dirname(protectFile(repo)), { recursive: true });
      writeFileSync(protectFile(repo), JSON.stringify({ version: 1, unresolved: [{ address: "t7", pane: "pt7" }], indeterminate: false }));
      const { d } = driver(f, []);
      expect((await place(d, repo, f.dir)).slot.id).toBe("t1");
      expect(splits(f)).toHaveLength(1);
      expect(JSON.parse(readFileSync(protectFile(repo), "utf8"))).toEqual({ version: 1, unresolved: [], indeterminate: false });
      expect(readdirSync(dirname(protectFile(repo))).filter((x) => x.includes(".tmp"))).toEqual([]);
    }
  }, 180_000);

  it("normal board close satisfies the closed acknowledgement table while changed tokens or remaining presence protect the board", async () => {
    const modes = ["acknowledged", "no acknowledgement", "presence remains", "token changed", "identity changed after acknowledgement",
      "record repointed during acknowledgement", "token replaced after acknowledgement", "space changed at the final read", "kill receipt in another space",
      "claimant replaced after acknowledgement", "claimant replaced at the kill receipt"] as const;
    const refusals: Record<Exclude<(typeof modes)[number], "acknowledged">, RegExp> = {
      "no acknowledgement": /watch cleanup unacknowledged/,
      "presence remains": /watch cleanup unacknowledged/,
      "token changed": /owner record changed \(token or identity\); board protected/,
      "identity changed after acknowledgement": /t1 is not this slot's terminal \(owner label differs\)/,
      "record repointed during acknowledgement": /owner record changed \(token or identity\); board protected/,
      "token replaced after acknowledgement": /owner record changed \(token or identity\); board protected/,
      "space changed at the final read": SPACE_PROTECTED,
      "kill receipt in another space": SPACE_PROTECTED,
      "claimant replaced after acknowledgement": CLAIMANT_CHANGED,
      "claimant replaced at the kill receipt": CLAIMANT_CHANGED,
    };
    for (const mode of modes) {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      const rows: Row[] = [];
      const { d, time } = driver(f, rows);
      const { slot, u } = await place(d, repo, f.dir);
      const armId = readWatchBoard(repo, RUN)!.armId!;
      f.clearCalls();
      if (mode === "acknowledged") {
        // Stop requested, the matching acknowledgement and the UI's own presence removal awaited, identity re-verified,
        // then kill/rm and the terminal and its pane proven absent.
        await Promise.all([d.close(slot), ackOnStop(u)]);
        expect(existsSync(stopFile(repo, u.token))).toBe(true);
        expect(existsSync(supervisionPresencePath(repo, "watch", armId))).toBe(false);
        expect(destroyed(f).map((a) => [a[0], a[1]])).toEqual([["kill", "t1"], ["rm", "t1"]]);
        expect(f.read().terminals.t1).toBeUndefined();
        expect(tabOf(f, "t1")).toBeUndefined();
        expect(rows).toEqual([]);
        continue;
      }
      time.warp = mode === "no acknowledgement" || mode === "presence remains";
      const ack = mode === "presence remains" // an acknowledgement written while the UI's own presence is still there
        ? ackOnStop(u, () => writeFileSync(join(supDir(repo), `watch-board.${u.token}.ack`), JSON.stringify({ token: u.token, armId, pid: process.pid }) + "\n"), false)
        : mode === "identity changed after acknowledgement"
          ? ackOnStop(u, () => f.update((s) => { s.terminals.t1!.labels[OWNER_LABEL] = "tickmarkr:worker:T9:0:run-other"; }))
          : mode === "record repointed during acknowledgement" // same token, another terminal: the ack answers the token only
            ? ackOnStop(u, () => editRecord(repo, { pane: "t77" }))
            : mode === "token replaced after acknowledgement" // replaced at the first post-acknowledgement read of the board
              ? ackOnStop(u, () => {
                const p = join(supDir(repo), `watch-board.${RUN}.json`);
                const next = JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), token: "0f0e0d0c-0000-4000-8000-0000000000aa" }) + "\n";
                f.rule({ match: ["get", "t1"], once: true, pass: true, write: { [p]: next } });
              })
              : undefined;
      if (mode === "token changed") reserveWatchBoard({ repo, runId: RUN, driver: "herdr-app", workspace: "spA", pane: "t1", name: WATCH });
      // Space is identity on every destructive step: the close's own final read (its first hc listing comes right before
      // it, after every earlier verification) or the kill receipt names another space, owner/repo/checkout unchanged.
      const spaced = mode === "space changed at the final read" || mode === "kill receipt in another space";
      if (spaced) f.rule({ match: [mode === "kill receipt in another space" ? "kill" : "ls"], once: true, pass: true, mutate: { t1: { labels: otherSpace(repo) } } });
      // The acknowledgement answers its claimant: a post-acknowledgement call (the first board read, or the kill) that
      // swaps the record's pid/arm and installs that arm's presence — token, terminal, space and name kept — protects.
      // Armed when the stop is requested, so the acknowledgement itself answers the claimant that really claimed.
      const swapped = mode.startsWith("claimant replaced");
      const swap = (): void => {
        const p = join(supDir(repo), `watch-board.${RUN}.json`);
        const next = JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), pid: process.ppid, armId: "replacement-arm" }) + "\n";
        f.rule({ match: mode === "claimant replaced at the kill receipt" ? ["kill", "t1"] : ["get", "t1"], once: true, pass: true,
          write: { [p]: next, [supervisionPresencePath(repo, "watch", "replacement-arm")]: "{}\n" } });
      };
      const killed = mode === "kill receipt in another space" || mode === "claimant replaced at the kill receipt";
      await expect(Promise.all([d.close(slot), spaced ? ackOnStop(u) : swapped ? ackOnStop(u, swap) : ack]), mode).rejects.toThrow(refusals[mode]);
      expect(destroyed(f).map((a) => [a[0], a[1]]), mode).toEqual(killed ? [["kill", "t1"]] : []);
      expect(f.read().terminals.t1, mode).toBeDefined();
      expect(tabOf(f, "t1")?.id, mode).toBe("tbORCH");
      expect(events(rows, "herdr-app-cleanup-unconfirmed").map((e) => e.data.address), mode).toEqual(["t1"]);
      if (mode === "token changed") expect(existsSync(stopFile(repo, u.token)), mode).toBe(false); // never even asked
    }
  }, 180_000);

  it("a board whose UI exited by itself closes from its finished terminal once the window dropped its pane while a live board a foreign owner or a surviving pane stays protected", async () => {
    // The live run's run end: the narrator exits with its run (hc: finished, exit 0) and the Herdr app drops a finished
    // terminal's pane from the window before the daemon closes the board. A dead UI can never acknowledge.
    const modes = ["exited", "live without its row", "exited with a foreign owner", "exited while its pane survives under another terminal",
      "live again at the final read", "pane reappears at the final read", "owner replaced during the final window read"] as const;
    const refusals: Record<Exclude<(typeof modes)[number], "exited">, RegExp> = {
      "live without its row": /t1 has no unique exact pane row \(0 row\(s\)\)/,
      "exited with a foreign owner": /t1 is not this slot's terminal \(owner label differs\)/,
      "exited while its pane survives under another terminal": /t1 has no unique exact pane row \(0 row\(s\)\)/,
      "live again at the final read": /t1 is live again after its UI exited; board protected/,
      "pane reappears at the final read": /t1 \(pane pt1\) reappeared in the window; board protected/,
      "owner replaced during the final window read": /owner record changed \(token or identity\); board protected/,
    };
    for (const mode of modes) {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      const rows: Row[] = [];
      const { d } = driver(f, rows);
      const { slot, u } = await place(d, repo, f.dir);
      u.close(); // the UI releases its own presence as it exits
      f.update((s) => {
        for (const tb of s.app!.spaces.flatMap((x) => x.tabs)) tb.terminals = tb.terminals.filter((a) => a !== "t1");
        if (mode !== "live without its row") Object.assign(s.terminals.t1!, { state: "finished", exit_code: 0, reason: "exited" });
        if (mode === "exited with a foreign owner") s.terminals.t1!.labels[OWNER_LABEL] = "tickmarkr:worker:T9:0:run-other";
        // The board's own pane is still in the window, now showing another terminal: absence is unproven.
        if (mode === "exited while its pane survives under another terminal") {
          s.app!.panes = { ...s.app!.panes, t101: "pt1" }; // t101 is shown in the operator's tab
        }
      });
      // The final-read races: the close's first hc listing comes right before its final terminal read, after every
      // earlier verification; the window's second read is the guard's re-read just before the rm.
      if (mode === "live again at the final read") f.rule({ match: ["ls"], once: true, pass: true, mutate: { t1: { state: "live" } } });
      if (mode === "pane reappears at the final read") {
        const tab = (st: ReturnType<FakeHerdrApp["read"]>) => st.app!.spaces.flatMap((x) => x.tabs).find((tb) => tb.id === "tbORCH")!;
        f.update((st) => { st.app!.panes = { ...st.app!.panes, t102: "pt1" }; tab(st).terminals.push("t102"); });
        const shown = spawnSync(f.app, ["ls"], { encoding: "utf8" }).stdout; // the window as the fake app renders it
        f.update((st) => { tab(st).terminals = tab(st).terminals.filter((a) => a !== "t102"); });
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, pass: true }); // the close's first window read: unchanged
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, output: shown });
      }
      if (mode === "owner replaced during the final window read") { // the guard's window re-read swaps the owner token
        const p = join(supDir(repo), `watch-board.${RUN}.json`);
        const next = JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), token: OTHER_TOKEN }) + "\n";
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, pass: true }); // the close's first window read: unchanged
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, pass: true, write: { [p]: next } });
      }
      f.clearCalls();
      if (mode === "exited") {
        await d.close(slot);
        expect(destroyed(f).map((a) => [a[0], a[1]])).toEqual([["rm", "t1"]]); // finished: no kill, removed, absence proven
        expect(f.read().terminals.t1).toBeUndefined();
        expect(rows).toEqual([]);
        continue;
      }
      await expect(d.close(slot), mode).rejects.toThrow(refusals[mode]);
      expect(destroyed(f), mode).toEqual([]);
      expect(f.read().terminals.t1, mode).toBeDefined();
      expect(events(rows, "herdr-app-cleanup-unconfirmed").map((e) => e.data.address), mode).toEqual(["t1"]);
    }

    // The UI acknowledges the stop and then exits before the close's second verification (finished, its pane dropped):
    // the guards come from that second verification, so a terminal turning live again or the known pane reappearing
    // under another terminal is still protected before destruction.
    for (const mode of ["acknowledged then exited", "acknowledged then exited and live again at the final read",
      "acknowledged then exited and its pane reappears at the final read"] as const) {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      const rows: Row[] = [];
      const { d } = driver(f, rows);
      const { slot, u } = await place(d, repo, f.dir);
      const exit = (): void => f.update((st) => {
        for (const tb of st.app!.spaces.flatMap((x) => x.tabs)) tb.terminals = tb.terminals.filter((a) => a !== "t1");
        Object.assign(st.terminals.t1!, { state: "finished", exit_code: 0, reason: "exited" });
      });
      if (mode.endsWith("live again at the final read")) f.rule({ match: ["ls"], once: true, pass: true, mutate: { t1: { state: "live" } } });
      if (mode.endsWith("pane reappears at the final read")) {
        // The window as the fake renders it now, with the board's pane pt1 shown under another terminal instead of t1.
        const shown = spawnSync(f.app, ["ls"], { encoding: "utf8" }).stdout.replace('"terminal":"t1"', '"terminal":"t102"');
        expect(shown).toContain('"terminal":"t102"');
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, pass: true }); // first verification: unchanged
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, pass: true }); // second verification: unchanged
        f.rule({ tool: "herdr-app", match: ["ls"], once: true, output: shown }); // the guard's re-read
      }
      f.clearCalls();
      if (mode === "acknowledged then exited") {
        await Promise.all([d.close(slot), ackOnStop(u, exit)]);
        expect(destroyed(f).map((a) => [a[0], a[1]])).toEqual([["rm", "t1"]]);
        expect(f.read().terminals.t1).toBeUndefined();
        expect(rows).toEqual([]);
        continue;
      }
      await expect(Promise.all([d.close(slot), ackOnStop(u, exit)]), mode).rejects.toThrow(mode.endsWith("live again at the final read")
        ? /t1 is live again after its UI exited; board protected/ : /t1 \(pane pt1\) reappeared in the window; board protected/);
      expect(destroyed(f), mode).toEqual([]);
      expect(f.read().terminals.t1, mode).toBeDefined();
    }
  }, 180_000);

  it("lost-board retirement satisfies the closed recovery table while an ambiguous or surviving ghost is never returned as a fresh board", async () => {
    const modes = ["recovered", "ambiguous mapping", "surviving ghost", "window pane survives", "window pane survives with its terminal field cleared",
      "changed token", "not this driver's board", "kill receipt in another space"] as const;
    const refusals: Record<Exclude<(typeof modes)[number], "recovered">, RegExp> = {
      "ambiguous mapping": /t1 has no unique exact pane row \(2 row\(s\)\)/,
      "surviving ghost": /rm response family failed/,
      "window pane survives": /t1 \(pane pt1\) is still in the window after close/,
      // A cleared terminal field is an uncaptured layout shape: unreadable, so absence is never proven from it.
      "window pane survives with its terminal field cleared": new RegExp(UNREADABLE("pt1")),
      "changed token": /owner record changed/,
      "not this driver's board": /is not a board this driver placed; ownership unproven, protected/,
      "kill receipt in another space": SPACE_PROTECTED,
    };
    for (const mode of modes) {
      const repo = makeRepo({ "a.txt": "a" });
      const f = fake(repo);
      const rows: Row[] = [];
      const { d } = driver(f, rows);
      const { slot, u } = await place(d, repo, f.dir);
      // The daemon proved the board lost: its UI is gone (presence released, owner pid dead) and can never acknowledge.
      u.close();
      editRecord(repo, { pid: deadPid() });
      rmSync(join(supDir(repo), `watch-board.${u.token}.ack`), { force: true });
      f.clearCalls();
      if (mode === "recovered") {
        // The cache is forgotten, the exact board is asked to stop (never awaited) and closed, and the next narrator
        // places a fresh claimed board — never the ghost.
        await d.retireLostWatch(slot);
        expect(existsSync(stopFile(repo, u.token))).toBe(true);
        expect(destroyed(f).map((a) => [a[0], a[1]])).toEqual([["kill", "t1"], ["rm", "t1"]]);
        expect(f.read().terminals.t1).toBeUndefined();
        expect(tabOf(f, "t1")).toBeUndefined();
        const next = await place(d, repo, f.dir);
        expect(next.slot).not.toBe(slot);
        expect(next.slot.id).toBe("t2");
        expect(splits(f)).toHaveLength(1);
        expect(readWatchBoard(repo, RUN)).toMatchObject({ pane: "t2", token: next.u.token, pid: process.pid });
        expect(rows).toEqual([]);
        continue;
      }
      if (mode === "ambiguous mapping") f.update((s) => { s.app!.spaces[0]!.tabs[0]!.terminals.push("t1"); });
      if (mode === "surviving ghost") f.rule({ match: ["rm"], stderr: '{"error":{"kind":"refused","message":"refused"}}\n', exit: 1 });
      if (mode === "window pane survives") f.rule({ match: ["rm"], remove: ["t1"], output: '{"removed":"t1"}\n' }); // hc forgets it, the window does not
      // hc forgets it and the window keeps its pane with an EMPTY terminal field: only the pane id still names it.
      if (mode === "window pane survives with its terminal field cleared") f.rule({ match: ["rm"], remove: ["t1"], clear: ["t1"], output: '{"removed":"t1"}\n' });
      if (mode === "changed token") reserveWatchBoard({ repo, runId: RUN, driver: "herdr-app", workspace: "spA", pane: "t1", name: WATCH });
      if (mode === "kill receipt in another space") f.rule({ match: ["kill"], pass: true, mutate: { t1: { labels: otherSpace(repo) } } });
      // A different instance (a resumed daemon) holds no record of the board: ownership unproven, nothing touched.
      const foreign = mode === "not this driver's board";
      const otherRows: Row[] = [];
      const other = foreign ? driver(f, otherRows).d : d;
      await expect(other.retireLostWatch(slot), mode).rejects.toThrow(refusals[mode]);
      const closed = mode === "surviving ghost" || mode.startsWith("window pane survives");
      expect(destroyed(f).map((a) => [a[0], a[1]]), mode).toEqual(closed ? [["kill", "t1"], ["rm", "t1"]] : mode === "kill receipt in another space" ? [["kill", "t1"]] : []);
      if (!mode.startsWith("window pane survives")) expect(f.read().terminals.t1, mode).toBeDefined(); // the ghost survives, protected
      expect(tabOf(f, "t1"), mode).toBeDefined();
      // The cache was forgotten first and the unproved retirement kept its binding (terminal and, once known, pane):
      // the next narrator re-proves it gone before any split, never answers with the ghost and never stacks on it.
      await expect(other.narrator(repo, "never-run", RUN), mode).rejects.toThrow(foreign
        ? /prior board t1 is not proven gone \(still listed in hc\); protected, none stacked/
        : new RegExp(`prior board t1 \\(pane pt1\\) is not proven gone \\((still (listed in hc|in the window)|${UNREADABLE("pt1")})\\); protected, none stacked`));
      expect(splits(f), mode).toEqual([]);
      expect(events(foreign ? otherRows : rows, "herdr-app-boardless"), mode).toHaveLength(1);
      if (mode === "window pane survives with its terminal field cleared") {
        // A fresh driver (a resumed daemon) holds no cached binding and hc lists no same-name board, yet the surviving
        // pane is never stacked over: the run's board-protect.json carries the unproved binding (terminal and pane), which
        // the unreadable layout never discharges; a lost retirement the fresh driver cannot prove adds an address-only one.
        expect(JSON.parse(readFileSync(protectFile(repo), "utf8")), mode).toEqual({ version: 1, unresolved: [{ address: "t1", pane: "pt1" }], indeterminate: false });
        const fr: Row[] = [];
        const { d: fresh } = driver(f, fr);
        await expect(fresh.narrator(repo, "never-run", RUN), mode).rejects.toThrow(new RegExp(`prior board t1 \\(pane pt1\\) is not proven gone \\(${UNREADABLE("pt1")}\\)`));
        await expect(fresh.retireLostWatch(slot), mode).rejects.toThrow(/is not a board this driver placed/);
        expect(JSON.parse(readFileSync(protectFile(repo), "utf8")).unresolved, mode).toEqual([{ address: "t1", pane: "pt1" }, { address: "t1" }]);
        await expect(fresh.narrator(repo, "never-run", RUN), mode).rejects.toThrow(new RegExp(`prior board t1 \\(pane pt1\\) is not proven gone \\(${UNREADABLE("pt1")}\\)`));
        expect(splits(f), mode).toEqual([]);
        expect(events(fr, "herdr-app-boardless"), mode).toHaveLength(2);
      }
    }
  }, 180_000);
});
