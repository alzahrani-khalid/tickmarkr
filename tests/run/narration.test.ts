import { isolatedBuild } from "../fixtures/screen-soak/isolated-build.js";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { formatJournalNarration, Journal, type JournalEvent } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Narration regression: the `narrate` callback is an OBSERVATIONAL side-channel. Journal.append writes
// to disk FIRST, then calls narrate inside a try/catch (src/run/journal.ts), so on-disk content is
// independent of the sink by construction. These tests pin that contract so a future refactor cannot
// quietly invert the write/narrate order or drop the catch — either would let narration leak into the
// journal or let a broken sink kill a run.
describe("narration side-channel (fake adapter, zero tokens)", () => {
  test("emits narration lines for run-start, task-dispatch, and run-end", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const lines: string[] = [];
    await runDaemon(repo, { approvalWindowMs: 1, adapters: [fake], runId: "run-narr-events", narrate: (e) => lines.push(formatJournalNarration(e)) });
    // each load-bearing event is the leading token of at least one formatted narration line
    for (const required of ["run-start", "task-dispatch", "run-end"]) {
      expect(lines.some((l) => l.startsWith(required))).toBe(true);
    }
    // the stream is complete: narration saw exactly as many events as hit disk
    expect(lines.length).toBe(Journal.open(repo, "run-narr-events").read().length);
  });

  test("journal with narration enabled is byte-identical to one without it (modulo wall-clock ts)", async () => {
    // Narration is a pure side-channel: enabling it must not add, drop, reorder, or alter events.
    // The one field that genuinely cannot be held constant is `ts` — the daemon's worker-wait loop
    // polls on Date.now() (src/run/daemon.ts), so the clock can't be pinned without stalling the run.
    // Everything else is held deterministic: the SAME scripted run, the SAME runId (→ identical branch
    // refs recorded in the journal), and git author/committer dates pinned so commit SHAs (baseRef,
    // merge commit) are byte-exact too. Any remaining divergence would be narration perturbing the run,
    // not the clock.
    const prevAuthor = process.env.GIT_AUTHOR_DATE;
    const prevCommitter = process.env.GIT_COMMITTER_DATE;
    const restore = () => {
      // delete (not assign undefined) — `process.env.k = undefined` sets the literal string "undefined",
      // which git rejects as an invalid date and poisons later tests in this file.
      if (prevAuthor === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = prevAuthor;
      if (prevCommitter === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = prevCommitter;
    };
    process.env.GIT_AUTHOR_DATE = "2026-07-12T00:00:00Z";
    process.env.GIT_COMMITTER_DATE = "2026-07-12T00:00:00Z";
    try {
      const scripted = () => setupRepo(
        [T("T1")],
        { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
      );

      const narrated: JournalEvent[] = [];
      const on = scripted();
      await runDaemon(on.repo, { approvalWindowMs: 1, adapters: [on.fake], runId: "run-byte", narrate: (e) => narrated.push(e) });

      const off = scripted();
      await runDaemon(off.repo, { approvalWindowMs: 1, adapters: [off.fake], runId: "run-byte" });

      // The identity mask is allowed to erase a VALUE, never the field's existence. If production
      // omits durationMs from either run, this oracle fails before normalizing the two ledgers.
      for (const journal of [Journal.open(on.repo, "run-byte"), Journal.open(off.repo, "run-byte")]) {
        for (const row of journal.read().filter((e) => e.event === "gate-result")) {
          expect(Object.hasOwn(row.data, "durationMs")).toBe(true);
          expect(typeof row.data.durationMs).toBe("number");
        }
      }

      // v2.0 T2 (OBS-554): `ts` is no longer the only field the clock owns. A gate-result row now
      // carries its own measurement — a wall-clock durationMs (its own, and one per judge/review
      // invocation) and the host load samples bracketing it — which vary run to run for exactly the
      // reason the ts mask exists. Presence and shape of that measurement are pinned over all seven
      // gates in tests/run/gate-telemetry.test.ts; what THIS oracle asserts is that narration does
      // not add, drop, reorder, or alter events, and a number the host clock chose cannot answer that.
      const maskTs = (s: string) => s
        .replace(/"ts":"[^"]*"/g, '"ts":"X"')
        .replace(/"(durationMs|selectedDurationMs|fullDurationMs|load1Start|load1End|load1Max|load1Mean)":-?[\d.e+-]+/g, '"$1":"X"');
      const onFile = maskTs(readFileSync(join(tickmarkrDir(on.repo), "runs", "run-byte", "journal.jsonl"), "utf8").split(on.repo).join("<repo>"));
      const offFile = maskTs(readFileSync(join(tickmarkrDir(off.repo), "runs", "run-byte", "journal.jsonl"), "utf8").split(off.repo).join("<repo>"));
      expect(onFile).toBe(offFile); // byte-identical except the unavoidable clock
      // count parity: the narration stream saw exactly as many events as were written
      expect(narrated.length).toBe(Journal.open(on.repo, "run-byte").read().length);
    } finally {
      restore();
    }
  });

  test("a narration callback that throws does not fail the run; every event still lands in the journal", async () => {
    // reference run with NO narration captures the full, in-order event sequence for this scripted run
    const ref = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    await runDaemon(ref.repo, { approvalWindowMs: 1, adapters: [ref.fake], runId: "run-throw-ref" });
    const refEvents = Journal.open(ref.repo, "run-throw-ref").read().map((e) => e.event);

    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const s = await runDaemon(repo, { approvalWindowMs: 1,
      adapters: [fake], runId: "run-throw",
      narrate: () => { throw new Error("narration sink is broken"); },
    });
    expect(s.done).toEqual(["T1"]); // the run completed despite the throwing sink
    expect(s.failed).toEqual([]);
    // identical, in-order event sequence — nothing dropped or reordered to the throw
    expect(Journal.open(repo, "run-throw").read().map((e) => e.event)).toEqual(refEvents);
  });
}, 120000);


import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { type Slot } from "../../src/drivers/types.js";
import { readWatchBoard, watchBoardAcknowledged, supervisionStatus } from "../../src/run/supervision.js";
import { makeRepo } from "../helpers/tmprepo.js";
import { boardHost } from "../fixtures/screen-soak/board-host.js";
import { observer } from "../fixtures/screen-soak/test-support.js";
import { shq } from "../../src/adapters/types.js";
import { saveGraph } from "../../src/graph/graph.js";
import { graph, partial, rawOf } from "../fixtures/operator-state/fixture.js";

test("The actual daemon/driver narrator opens right with no focus, retains canonical workspace/run/repository ownership and gracefully closes its owned board at run-end only after its own presence acknowledgement. Manual ui remains a final receipt and later resume refreshes that run. Real SIGINT/SIGTERM fixtures for each unbounded named UI/plain/event observer leave an overlapping peer ARMED and the last orderly exit DISARMED. Two repos sharing a workspace and the same run ID exercise canonical-name collision without retiring the foreign board, with a matching-owned positive control proving usable placement. Foreign/unknown boards and failed cleanup acknowledgement produce protected ownership/visible diagnostics. Workspace-wide replacement, standing down another observer or claimed unacknowledged cleanup fails.", async () => {
  const host = boardHost();
  try {
    const { repo, fake } = setupRepo([T("T1", { humanGate: true })], {});
    const herdr = host.driver();
    class Narrated extends SubprocessDriver {
      narrator = herdr.narrator.bind(herdr);
      override close(slot: Slot) { return slot.name.includes(":watch:") ? herdr.close(slot) : super.close(slot); }
    }
    const { runDaemon: runBuiltDaemon } = await import(join(isolatedBuild(), "dist/run/daemon.js"));
    const summary = await runBuiltDaemon(repo, { approvalWindowMs: 1, adapters: [fake], driver: new Narrated(), runId: "run-owned" });
    expect(summary.human).toEqual(["T1"]);
    const owner = readWatchBoard(repo, "run-owned")!;
    expect(owner).toMatchObject({ runId: "run-owned", workspace: "wC6", name: "tickmarkr:watch:run:0:run-owned", driver: "herdr" });
    expect(watchBoardAcknowledged(owner)).toBe(true);
    expect(host.read().panes).toEqual([]);
    expect(supervisionStatus(repo, "watch").state).toBe("DISARMED");
    const split = host.calls().find(args => args[1] === "split")!;
    expect(split).toContain("--no-focus"); expect(split).toContain("right");
    expect(host.calls().filter(args => args[1] === "focus")).toEqual([]);
    expect(host.calls().some(args => args[1] === "run" && args.join(" ").includes(" ui 'run-owned' --view run"))).toBe(true);

    // The same canonical name in another repository is a deliberate collision.
    const other = makeRepo({ "base.txt": "foreign" });
    const dir = join(other, ".tickmarkr", "runs", "run-owned"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), rawOf(partial));
    const command = `${shq(process.execPath)} ${shq(join(isolatedBuild(), "dist/cli/index.js"))} ui run-owned --view run`;
    const own = await herdr.narrator(repo, command, "run-owned");
    await expect.poll(() => readWatchBoard(repo, "run-owned")?.pid, { timeout: 15000 }).toBeTruthy();
    const drawn = (id: string) => {
      try { return JSON.parse(readFileSync(host.read().panes.find(pane => pane.pane_id === id)!.frame!, "utf8")) as { frame: string; pid: number }; }
      catch { return { frame: "", pid: 0 }; }
    };
    await expect.poll(() => drawn(own.id).frame, { timeout: 5000 }).toContain("RUN / PARTIAL");
    expect(drawn(own.id).pid).toBe(readWatchBoard(repo, "run-owned")?.pid);
    await expect(host.driver().narrator(other, command, "run-owned")).rejects.toThrow(/foreign|unknown/);
    expect(host.read().panes.map(p => p.pane_id)).toContain(own.id);
    // Matching-owned positive control: resume retires only the acknowledged board
    // and launches the same run afresh through the actual supplied command.
    const replacementDriver = host.driver();
    const replacement = await replacementDriver.narrator(repo, command, "run-owned");
    expect(replacement.id).not.toBe(own.id);
    await expect.poll(() => readWatchBoard(repo, "run-owned")?.pid, { timeout: 15000 }).toBeTruthy();
    await expect.poll(() => drawn(replacement.id).frame, { timeout: 5000 }).toContain("RUN / PARTIAL");
    await replacementDriver.close(replacement);
    expect(host.read().panes).toEqual([]);
    // Induce a real observer cleanup failure after it has claimed its own
    // presence. The daemon must retain the pane and publish the unconfirmed
    // cleanup, even though the UI process itself exits from the stop request.
    const failed = setupRepo([T("T1", { humanGate: true })], {});
    class FailedCleanup extends SubprocessDriver {
      async narrator(cwd: string, command: string, id?: string) {
        const slot = await herdr.narrator(cwd, command, id);
        await expect.poll(() => readWatchBoard(cwd, id!)?.armId, { timeout: 5000 }).toBeTruthy();
        const presence = join(cwd, ".tickmarkr", "supervision", `watch.live.${readWatchBoard(cwd, id!)!.armId}`);
        rmSync(presence); mkdirSync(presence); writeFileSync(join(presence, "held"), "induced removal failure");
        return slot;
      }
      override close(slot: Slot) { return slot.name.includes(":watch:") ? herdr.close(slot) : super.close(slot); }
    }
    const diagnostics: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(message => { diagnostics.push(String(message)); });
    try {
      await runBuiltDaemon(failed.repo, { approvalWindowMs: 1, adapters: [failed.fake], driver: new FailedCleanup(), runId: "run-cleanup-refused" });
      expect(Journal.open(failed.repo, "run-cleanup-refused").read().find(row => row.event === "watch-cleanup-failed")?.data.error).toMatch(/unacknowledged/);
      expect(diagnostics.some(message => message.includes("cleanup unacknowledged"))).toBe(true);
      const refused = readWatchBoard(failed.repo, "run-cleanup-refused")!;
      expect(watchBoardAcknowledged(refused)).toBe(false);
      expect(host.read().panes.some(pane => pane.pane_id === refused.pane)).toBe(true);
    } finally { errors.mockRestore(); }
    // No UI claimed this reservation: a shell launch ack cannot stand in for
    // the presence acknowledgement. No destructive pane command is permitted.
    const unacknowledged = await herdr.narrator(repo, "true", "run-no-ack");
    await expect(herdr.close(unacknowledged)).rejects.toThrow(/unacknowledged/);
    expect(host.read().panes.map(p => p.pane_id)).toContain(unacknowledged.id);
    host.write({ ...host.read(), panes: [...host.read().panes, { pane_id: "wC6:unknown", label: "tickmarkr:watch:run:0:run-unknown", workspace_id: "wC6", cwd: other }] });
    await expect(host.driver().narrator(repo, command, "run-unknown")).rejects.toThrow(/protected/);
    expect(host.read().panes.map(p => p.pane_id)).toContain("wC6:unknown");
  } finally { host.dispose(); }

  // Real process signals, including every named unbounded public observer.
  const repo = makeRepo({ "base.txt": "signals" }); saveGraph(repo, graph);
  const runDir = join(repo, ".tickmarkr", "runs", "run-signals"); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "journal.jsonl"), rawOf(partial));
  const modes = [
    ["ui", ["run-signals", "--view", "run"], true],
    ["ui", ["--setup", "run-signals"], true],
    ["status", ["run-signals", "--watch"], true],
    ["status", ["run-signals", "--watch"], false],
    ...["--plain", "--events", "--jsonl", "--decision-events"].map(flag => ["status", ["run-signals", "--watch", flag], false]),
  ] as Array<[string, string[], boolean]>;
  for (const signal of ["SIGINT", "SIGTERM"] as const) for (const [command, args, tty] of modes) {
    const first = await observer(repo, command, args, tty);
    const peer = await observer(repo, command, args, tty);
    try {
      await expect.poll(() => peer.snapshot().presence, { timeout: 5000 }).toHaveLength(1);
      expect(supervisionStatus(repo, "watch").state).toBe("ARMED");
      first.child.kill(signal); await first.exited;
      expect(supervisionStatus(repo, "watch").state).toBe("ARMED");
      expect(peer.child.exitCode).toBeNull();
      const present = readdirSync(join(repo, ".tickmarkr", "supervision")).filter(name => name.startsWith("watch.live."));
      expect(present).toEqual(peer.snapshot().presence);
      peer.child.kill(signal); await peer.exited;
      expect(supervisionStatus(repo, "watch").state).toBe("DISARMED");
      expect(readdirSync(join(repo, ".tickmarkr", "supervision")).filter(name => name.startsWith("watch.live."))).toEqual([]);
    } finally { await first.close(); await peer.close(); }
  }
}, 120000);
