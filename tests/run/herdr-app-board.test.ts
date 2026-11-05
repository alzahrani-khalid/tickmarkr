import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { HerdrAppDriver, SPACE_LABEL, TAB_LABEL } from "../../src/drivers/herdr-app.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { observeNamedRun, readWatchBoard, supervisionPresencePath, WATCH_OWNER_ENV } from "../../src/run/supervision.js";
import { FakeHerdrApp, type FakeTerm } from "../helpers/fake-herdr-app.js";
import { COMMIT, makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract B through the daemon's EXISTING board lifecycle (placeBoard at start, watch-board
// health, run-end close; keepPanes forever suppresses that close): the board is the REAL HerdrAppDriver's narrator,
// close and retireLostWatch over executable hc/herdr-app fakes; tasks run headless. The observer inside the board is the
// shipped observeNamedRun, started from the token the board's launch gate delivered.

afterAll(() => reapTestTempDirs());
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const term = (address: string, over: Partial<FakeTerm> = {}): FakeTerm => ({ address, argv: [], cwd: "/", labels: {}, state: "live", parent: null,
  die_with_parent: false, notify: false, keep: false, reported: false, status: null, exit_code: null, signal: null, reason: null, pid: 1, turn: 0,
  screen: { text: "", complete: true }, history: { text: "", complete: true }, ...over });

describe("HerdrAppDriver run board through the daemon (contract B)", () => {
  test("daemon board lifecycle satisfies the closed boardless-and-retention table while manual observers and foreign presence remain untouched", async () => {
    const modes = ["board", "no window", "anchor without space", "keepPanes forever"] as const;
    for (const mode of modes) {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo one > one.txt && ${COMMIT} one`, result: { ok: true, summary: "one" } }] } },
        mode === "keepPanes forever" ? "visibility: { keepPanes: forever }\n" : "");
      const runId = `run-herdr-app-board-${modes.indexOf(mode)}`;
      const f = new FakeHerdrApp(makeTestTempDir("hcapp-board-"), { execute: true, app: { window: mode !== "no window", nextTab: 0, spaces: [
        { id: "spA", name: "tickmarkr", tabs: [{ id: "tbOPER", name: "1", terminals: ["t101"] }, { id: "tbORCH", name: "ORCH", terminals: ["t100"] }] },
      ] } });
      f.update((s) => {
        s.terminals.t100 = term("t100", { cwd: realpathSync(repo), labels: mode === "anchor without space" ? {} : { [SPACE_LABEL]: "spA", [TAB_LABEL]: "tbORCH" } });
        s.terminals.t101 = term("t101");
      });
      // A manual observer (no owner token: it never claims the board) and a foreign presence, both present before the run.
      const manual = observeNamedRun(repo, runId, {});
      const foreign = supervisionPresencePath(repo, "watch", "foreign-arm");
      mkdirSync(dirname(foreign), { recursive: true });
      writeFileSync(foreign, "{}\n");
      const presences = (): string[] => readdirSync(dirname(foreign)).filter((x) => x.startsWith("watch.live.")).sort();
      const before = presences();
      expect(before, mode).toHaveLength(2);

      // The daemon's own board command needs the built CLI; the board here runs a stand-in observer that records the
      // token its launch gate delivered. Everything else on the board path is the real driver.
      const app = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, runId, pollMs: 30,
        env: { PATH: process.env.PATH, HC_TERMINAL_ID: "t100", HC_TERMINAL_SOCKET: f.read().socket } });
      const tok = join(f.dir, "token");
      const inner = new SubprocessDriver();
      const boards = new Set<Slot>();
      const commands: string[] = [];
      const driver = {
        id: "herdr-app", interactive: false,
        slot: inner.slot.bind(inner), run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
        status: inner.status.bind(inner), read: inner.read.bind(inner), notify: inner.notify.bind(inner), worktree: inner.worktree.bind(inner),
        journalWith: (append: Parameters<HerdrAppDriver["journalWith"]>[0]) => app.journalWith(append),
        narrator: async (cwd: string, command: string, id?: string) => {
          commands.push(command);
          const s = await app.narrator(cwd, `printf %s "$${WATCH_OWNER_ENV}" > ${shq(tok)}; exec sleep 60`, id);
          boards.add(s);
          return s;
        },
        retireLostWatch: (s: Slot) => app.retireLostWatch(s),
        close: (s: Slot) => (boards.has(s) ? app.close(s) : inner.close(s)),
      } as ExecutorDriver;

      // The UI: claims once its board launches, and acknowledges a stop by releasing its own presence.
      let over = false;
      let stopped = false;
      const ui = (async () => {
        while (!over && !(existsSync(tok) && readFileSync(tok, "utf8"))) await sleep(20);
        if (over) return undefined;
        const h = observeNamedRun(repo, runId, { [WATCH_OWNER_ENV]: readFileSync(tok, "utf8") });
        while (!over && !h.stopRequested()) await sleep(20);
        if (h.stopRequested()) { stopped = true; h.close(); }
        return h;
      })();
      try {
        const s = await runDaemon(repo, { adapters: [fake], runId, driver, approvalWindowMs: 1 });
        over = true;
        const handle = await ui;
        expect(s.done, mode).toEqual(["T1"]); // boardless or not, the run's execution is unaffected
        const rows = Journal.open(repo, runId).read();
        const named = (event: string) => rows.filter((e) => e.event === event);
        const splits = f.calls().filter((c) => c.tool === "herdr-app" && c.argv[1] === "pane.split");
        const destroyed = [...f.hcCalls("kill"), ...f.hcCalls("rm")].map((a) => a[1]);
        expect(commands, mode).toEqual([expect.stringMatching(new RegExp(` ui '?${runId}'? --view run$`))]); // the daemon's own narrator command
        expect(named("watch-board-lost"), mode).toEqual([]);

        if (mode === "no window" || mode === "anchor without space") {
          // Boardless: the named refusal is journaled by both the driver and the daemon, and nothing is split or closed.
          const reason = mode === "no window" ? /board unavailable: no window/ : /board unavailable: anchor t100 is in no window space/;
          expect(named("herdr-app-boardless").map((e) => e.data.reason), mode).toEqual([expect.stringMatching(reason)]);
          expect(named("watch-placement-failed").map((e) => e.data.error), mode).toEqual([expect.stringMatching(reason)]);
          expect(splits, mode).toEqual([]);
          expect(destroyed, mode).toEqual([]);
          expect(handle, mode).toBeUndefined();
          expect(readWatchBoard(repo, runId), mode).toBeUndefined();
        } else {
          expect(splits.map((c) => c.argv.slice(0, 6)), mode).toEqual([["do", "pane.split", "--direction", "right", "--pane", "pt100"]]);
          expect(named("herdr-app-boardless").concat(named("watch-placement-failed"), named("watch-cleanup-failed")), mode).toEqual([]);
          const owner = readWatchBoard(repo, runId)!;
          expect(owner, mode).toMatchObject({ driver: "herdr-app", pane: "t1", workspace: "spA", pid: process.pid });
          if (mode === "board") {
            // Run end closes the board: stop requested, acknowledged with the UI's own presence released, then the board
            // terminal (only it) killed, removed and gone from the window.
            expect(stopped, mode).toBe(true);
            expect(existsSync(supervisionPresencePath(repo, "watch", owner.armId!)), mode).toBe(false);
            expect(destroyed, mode).toEqual(["t1", "t1"]);
            expect(f.read().terminals.t1, mode).toBeUndefined();
            expect(f.read().app!.spaces[0]!.tabs.find((t) => t.id === "tbORCH")!.terminals, mode).toEqual(["t100"]);
          } else {
            // keepPanes forever: the daemon's suppression stays authoritative — never asked to stop, never closed.
            expect(stopped, mode).toBe(false);
            expect(existsSync(join(dirname(foreign), `watch-board.${owner.token}.stop`)), mode).toBe(false);
            expect(destroyed, mode).toEqual([]);
            expect(f.read().terminals.t1?.state, mode).toBe("live");
            handle!.close();
          }
        }
        // Manual observers and foreign presence are never touched; neither are the anchor or the operator's terminal.
        expect(presences().filter((x) => before.includes(x)), mode).toEqual(before);
        expect(f.read().terminals.t100?.state, mode).toBe("live");
        expect(f.read().terminals.t101?.state, mode).toBe("live");
      } finally {
        over = true;
        await ui;
        manual.close();
        f.reap();
      }
    }
  }, 300_000);
});
