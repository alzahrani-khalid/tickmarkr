import { afterEach, describe, expect, test, vi } from "vitest";
import { report } from "../../src/cli/commands/report.js";
import { status } from "../../src/cli/commands/status.js";
import { blockedTasks, pendingTasks, saveGraph } from "../../src/graph/graph.js";
import { type RunGraph, validateGraph } from "../../src/graph/schema.js";
import { recordFatalRunEnd } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo, T } from "../helpers/tmprepo.js";

// A fatal run-end is the record a crash leaves. It names every task the graph does not hold as done,
// failed or human in the bucket resume will put it in, and no reader may read it as green — even when
// every bucket is empty, which is exactly the record a setup crash writes.
afterEach(() => vi.restoreAllMocks());

const graphOf = (tasks: Array<ReturnType<typeof T>>): RunGraph =>
  validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks });

/** A git repository holding the graph and a started run's journal (the owed fold re-proves from git). */
const startedRun = (runId: string, graph: RunGraph) => {
  const repo = makeRepo({ "README.md": "x\n" });
  saveGraph(repo, graph);
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { runId, branch: `tickmarkr/${runId}`, pid: 999_999 });
  return { repo, journal };
};

const lastRunEnd = (journal: Journal) => journal.read().filter((e) => e.event === "run-end").at(-1)!.data;

describe("a fatal run-end is never green and loses no task", () => {
  test("test: a fatal run-end names a running or gated task in the pending bucket or in blocked under a parked dependency versus a record leaving it in no bucket", () => {
    const graph = graphOf([
      T("T1", { status: "done" }),
      T("T2", { status: "running", deps: ["T1"] }),
      T("T3", { status: "human" }),
      T("T4", { status: "gated", deps: ["T3"] }),
      T("T5", { status: "failed" }),
      T("T6", { status: "pending", deps: ["T2"] }),
    ]);
    const { journal } = startedRun("run-fatal-buckets", graph);
    recordFatalRunEnd(journal, "run-fatal-buckets", "b", new Error("scheduler exploded"), graph, "scheduler");
    const record = lastRunEnd(journal);
    expect(record).toMatchObject({
      done: ["T1"], failed: ["T5"], human: ["T3"], blocked: ["T4"], pending: ["T2", "T6"],
      fatal: true, phase: "scheduler", error: "scheduler exploded",
    });
    // every task sits in exactly one of the five buckets — none in two, none in none
    const buckets = ["done", "failed", "human", "blocked", "pending"].flatMap((b) => record[b] as string[]);
    expect(buckets.sort()).toEqual(graph.tasks.map((t) => t.id).sort());
    // the control: the pending/blocked fold over the graph as held leaves the dispatched T2 and T4 in no bucket
    const asHeld = [...pendingTasks(graph), ...blockedTasks(graph)].map((t) => t.id);
    expect(asHeld).not.toContain("T2");
    expect(asHeld).not.toContain("T4");
  });

  test("test: tickmarkr status for a fatal run names the crash phase plus error and reads outstanding unknown versus outstanding 0 for a crash leaving every bucket empty", async () => {
    const graph = graphOf([T("T1"), T("T2")]);
    // control: the same repository's normal all-done run-end folds known debt and reads outstanding 0
    const normal = startedRun("run-normal-status", graph);
    normal.journal.append("run-end", undefined, { runId: "run-normal-status", done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" });
    const green = await status(["run-normal-status"], normal.repo);
    expect(green).toContain("outstanding 0");
    expect(green).not.toContain("run crashed");

    // a setup crash: no graph reached the record, so every bucket is empty
    const { repo, journal } = startedRun("run-fatal-status", graph);
    recordFatalRunEnd(journal, "run-fatal-status", "b", new Error("integration branch refused"));
    const record = lastRunEnd(journal);
    for (const b of ["done", "failed", "human", "blocked", "pending"]) expect(record[b], b).toEqual([]);
    // the record's own fold is unknown with the crash as its reason, never 0
    expect(record.owedChecks).toMatchObject({ known: false, debt: "unknown", unknown: [{ reason: "fatal run-end — setup failed: integration branch refused" }] });
    const out = await status(["run-fatal-status"], repo);
    const lead = out.split("\n").slice(0, 3);
    expect(lead[0]).toMatch(/^finished run crashed — setup failed: integration branch refused · /);
    expect(lead[2]).toContain("outstanding unknown");
    expect(lead[2]).toContain("unknown: fatal run-end — setup failed: integration branch refused");
    expect(out).not.toContain("outstanding 0");
  });

  test("test: the markdown record of a fatal run names the crash and never reads outstanding 0 versus a normal all-done run-end reading outstanding 0", async () => {
    const graph = graphOf([T("T1"), T("T2")]);
    const normal = startedRun("run-normal-md", graph);
    normal.journal.append("run-end", undefined, { runId: "run-normal-md", done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [], tipVerify: "passed" });
    const green = await report(["run-normal-md", "--md"], normal.repo);
    expect(green).toContain("outstanding 0");
    expect(green).not.toContain("run crashed");

    // a crash with one task done and one still running: still never outstanding 0
    const crashed = graphOf([T("T1", { status: "done" }), T("T2", { status: "running", deps: ["T1"] })]);
    const { repo, journal } = startedRun("run-fatal-md", crashed);
    recordFatalRunEnd(journal, "run-fatal-md", "b", new Error("merge lock lost"), crashed, "merge");
    expect(lastRunEnd(journal)).toMatchObject({ done: ["T1"], pending: ["T2"] });
    const md = await report(["run-fatal-md", "--md"], repo);
    expect(md.split("\n")[0]).toMatch(/^- finished run crashed — merge failed: merge lock lost · /);
    expect(md).toContain("outstanding unknown");
    expect(md).toContain("unknown: fatal run-end — merge failed: merge lock lost");
    expect(md).not.toContain("outstanding 0");

    // a resume supersedes the crash: the newest engagement is no longer fatal
    journal.append("run-resume", undefined, { runId: "run-fatal-md" });
    expect(await report(["run-fatal-md", "--md"], repo)).not.toContain("run crashed");
  });

  test.each([
    ["plain", "lock lost", "lock lost"],
    ["7-bit OSC/CSI", "\x1b]0;GREEN\x07\x1b[2J\x1b[Hlock lost", "\\x1b]0;GREEN\\x07\\x1b[2J\\x1b[Hlock lost"],
    ["8-bit OSC/ST/CSI", "\x9d0;GREEN\x9c\x9b2J\x9bHlock lost", "\\u009d0;GREEN\\u009c\\u009b2J\\u009bHlock lost"],
  ])("%s: a fatal error prints its terminal controls as visible escapes in the default and one-line status, while the journal keeps the raw error", async (_, raw, shown) => {
    const graph = graphOf([T("T1"), T("T2")]);
    const { repo, journal } = startedRun("run-fatal-controls", graph);
    recordFatalRunEnd(journal, "run-fatal-controls", "b", new Error(raw));
    expect(lastRunEnd(journal).error).toBe(raw);
    const cause = `setup failed: ${shown}`;
    for (const out of [await status(["run-fatal-controls"], repo), await status(["--oneline"], repo)]) {
      expect(out).toContain(`run crashed — ${cause}`);
      expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
    }
    expect(await status(["run-fatal-controls"], repo)).toContain(`unknown: fatal run-end — ${cause}`);
  });
});
