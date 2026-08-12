import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// GATE-FIX-4 defect 4: a fresh run on a graph with nothing dispatchable used to journal
// {run-start, run-end} with zero dispatches — downstream consumers (greenness exit, status,
// notify) read that run-end as completion, so a run that did NOTHING satisfied the green
// rule's first half. The daemon now refuses to start such a run BEFORE the journal/run dir
// exists; resume keeps its current replay-then-quiesce behavior (it already owns a run-end).
describe("GATE-FIX-4: no-op fresh run refusal (fake adapter, zero tokens)", () => {
  test("fresh run on an all-terminal (human/done) graph refuses with counts and remedies, and creates no journal", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true, status: "human" }), T("T2", { status: "done" })],
      { tasks: {} },
    );
    const err = await runDaemon(repo, { adapters: [fake], runId: "run-noop-fresh" })
      .then(() => { throw new Error("resolved — the no-op run was not refused"); }, (e: unknown) => e as Error);
    // per-status counts, both remedies — the operator can act without opening the graph
    expect(err.message).toContain("nothing to dispatch");
    expect(err.message).toContain("human 1");
    expect(err.message).toContain("done 1");
    expect(err.message).toContain("tickmarkr approve <runId> <taskId>");
    expect(err.message).toContain("tickmarkr compile");
    // no run-start row, no run dir — the refusal precedes Journal.create
    expect(existsSync(join(tickmarkrDir(repo), "runs", "run-noop-fresh"))).toBe(false);
  });

  test("a pending task blocked on a terminal park cannot become ready — still refused, counted truthfully", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { humanGate: true, status: "human" }), T("T2", { deps: ["T1"], status: "pending" })],
      { tasks: {} },
    );
    const err = await runDaemon(repo, { adapters: [fake], runId: "run-noop-blocked" })
      .then(() => { throw new Error("resolved — the blocked-on-terminal run was not refused"); }, (e: unknown) => e as Error);
    expect(err.message).toContain("nothing to dispatch");
    expect(err.message).toContain("human 1");
    expect(err.message).toContain("blocked-on-terminal 1"); // pending, but its closure reaches the park
    expect(existsSync(join(tickmarkrDir(repo), "runs", "run-noop-blocked"))).toBe(false);
  });

  // Mirror of daemon.test.ts's "narration receives each event" harness: complete a run, then
  // resume the SAME (now all-terminal) graph — current behavior is run-resume then run-end with
  // no dispatch, and the guard must not turn that into a refusal (the resume already owns its
  // lifecycle; its run-end is truthful).
  test("resume on the same all-terminal graph retains existing behavior: run-resume then run-end, no refusal", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const first = await runDaemon(repo, { adapters: [fake], runId: "run-noop-resume" });
    expect(first.done).toEqual(["T1"]); // the graph is all-terminal from here on
    const before = Journal.open(repo, "run-noop-resume").read().length;

    const resumed = await runDaemon(repo, { adapters: [fake], runId: "run-noop-resume", resume: true });
    expect(resumed.done).toEqual(["T1"]);
    const appended = Journal.open(repo, "run-noop-resume").read().slice(before);
    expect(appended.map((e) => e.event)).toEqual(["run-resume", "run-end"]);
  });
}, 120_000);
