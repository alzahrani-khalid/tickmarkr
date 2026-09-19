// v2.5.6 T5 (OBS-1006, OBS-1007 add.4/5, OBS-1013): pages that stop repeating, parks whose kind tells the truth.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import type { BillingChannel } from "../../../src/adapters/types.js";
import { approve, DECISION_VERBS, permittedDecisionVerbs } from "../../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../../src/drivers/types.js";
import { runDaemon, resetPageRepeatMsForTests, setPageRepeatMsForTests } from "../../../src/run/daemon.js";
import { Journal, PARK_KINDS, type JournalEvent } from "../../../src/run/journal.js";
import { deriveRunDecisions } from "../../../src/tui/cockpit/decision-actions.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");
const rows = (repo: string, runId: string) => Journal.open(repo, runId).read();

/** stall.test.ts's interactive driver: the pane never finishes and reads a fixed status. */
const idleDriver = (status: string, notifies: string[]): ExecutorDriver => {
  const inner = new SubprocessDriver();
  return {
    id: "t5-idle-fake", interactive: true,
    slot: inner.slot.bind(inner), run: inner.run.bind(inner),
    waitOutput: async () => { await new Promise((r) => setTimeout(r, 50)); return false; },
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: async () => "working-on-it",
    notify: async (msg: string) => { notifies.push(msg); },
    close: inner.close.bind(inner), worktree: inner.worktree.bind(inner),
    status: async () => status,
  } as ExecutorDriver;
};

/** review-infra.test.ts's silent seat: authors ten bytes and never a verdict. */
class Seat extends FakeAdapter {
  calls = 0;
  override harnessBannerRows = ["SEAT HARNESS"] as const;
  constructor(path: string, public override id: string) { super(path); this.vendor = id; }
  override async probe() { return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) }; }
  override channels(): BillingChannel[] { return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }]; }
  override headlessCommand(): string { this.calls++; return "printf 'SEAT HARNESS'; sleep 2"; }
}
class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return super.channels().slice(0, 1); }
}

describe("v2.5.6 T5 — honest pages and typed parks", () => {
  test("test: a worker idle for sixty fixture seconds yields the first operator-page row and then at most one per status change or page interval carrying a suppressed count, a review whose diff exceeds the cap parks the task kind diff-cap whose permitted verbs are exactly recheck in the production Actions oracle over the closed park-kind set, a review rejection whose prose names tokens absent from the tree and the diff parks as the review gate-fail and never as authoring, and a review round exhausted with no verdict parks the task kind infra with no task-dispatch row after the originating one and no attempt charged with the execution policy absent and present, so a page per slice, a silent notifier, a cap filed as authoring, a prose token read as a path, or a no-verdict round that buys a worker fails", async () => {
    // ---- (a) an idle worker: one page row per delivery, never per slice ----------------------------
    setPageRepeatMsForTests(60_000); // fixture page interval: longer than the window, so the status alone decides
    try {
      const notifies: string[] = [];
      const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], { consult: { action: "human", notes: "stalled" }, tasks: { T1: [{ shell: "echo working-on-it" }] } });
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-idle-pages", driver: idleDriver("idle", notifies) });
      expect(s.human).toEqual(["T1"]);
      const pages = of(rows(repo, "run-idle-pages"), "operator-page");
      expect(pages).toHaveLength(1); // the first page; the same status inside one interval is suppressed, not journaled
      expect(pages[0]!.data).toMatchObject({ status: "idle", suppressed: 0 });
      expect(notifies.filter((m) => /looks idle without finishing/.test(m))).toHaveLength(1);
    } finally {
      resetPageRepeatMsForTests();
    }
    {
      // a page interval shorter than the window: a second row lands ONLY when the interval elapses, and it
      // carries the count of pageable slices the cadence swallowed in between
      setPageRepeatMsForTests(1_500);
      try {
        const notifies: string[] = [];
        const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.1 })], { consult: { action: "human", notes: "stalled" }, tasks: { T1: [{ shell: "echo working-on-it" }] } });
        await runDaemon(repo, { adapters: [fake], runId: "run-idle-repeat", driver: idleDriver("idle", notifies) });
        const pages = of(rows(repo, "run-idle-repeat"), "operator-page");
        expect(pages.length).toBeGreaterThanOrEqual(2);
        // the cadence itself: inside one worker window (a run of rows on the same slot) a second row lands only
        // once the 1.5 s interval elapsed or the status changed — never one per ~50 ms slice, whatever number of
        // windows the retries opened
        for (let i = 1; i < pages.length; i++) {
          const prev = pages[i - 1]!, cur = pages[i]!;
          if (prev.data.slot !== cur.data.slot) continue;
          const gapMs = Date.parse(cur.ts) - Date.parse(prev.ts);
          expect(cur.data.status !== prev.data.status || gapMs >= 1_400).toBe(true);
        }
        expect(pages.length).toBe(notifies.filter((m) => /looks idle without finishing/.test(m)).length); // a row ⇔ a delivery
        for (const p of pages.slice(1)) expect(p.data.suppressed as number).toBeGreaterThanOrEqual(1);
      } finally {
        resetPageRepeatMsForTests();
      }
    }
    // ---- (b) a cap trip parks kind diff-cap; recheck is its only verb in the closed set --------------
    {
      const { repo, fake } = setupRepo(
        [T("T1", { files: ["t1.txt"] })],
        { tasks: { T1: [{ shell: `head -c 3000 /dev/zero | tr '\\0' 'x' > t1.txt && ${COMMIT} big`, result: { ok: true, summary: "big" } }] } },
        "gates: { diffCap: 500 }\n",
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-cap-park" });
      expect(s.human).toEqual(["T1"]);
      const evs = rows(repo, "run-cap-park");
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data.kind).toBe("diff-cap");
      expect(String(park.data.reason)).toMatch(/diff exceeds verifiable cap/);
      expect(of(evs, "scope-authoring")).toEqual([]);
      expect(of(evs, "task-dispatch")).toHaveLength(1);
      const [decision] = deriveRunDecisions(Journal.open(repo, "run-cap-park"));
      expect(decision!.verbs).toEqual(["recheck"]);
      await expect(approve(["run-cap-park", "T1"], repo)).rejects.toThrow(/parked on a diff cap; plain approve would fund another worker/);
      expect(of(rows(repo, "run-cap-park"), "task-approved")).toEqual([]);
      expect(PARK_KINDS).toContain("diff-cap");
      for (const kind of PARK_KINDS) {
        const verbs = permittedDecisionVerbs({ kind, failedGate: kind === "gate-fail" ? "review" : undefined, tombstone: false });
        for (const v of verbs) expect(DECISION_VERBS).toContain(v);
        if (kind === "diff-cap") expect(verbs).toEqual(["recheck"]);
      }
    }
    // ---- (c) review prose naming non-paths parks as the review gate-fail, never authoring -----------
    {
      const { repo, fake } = setupRepo(
        [T("T1", { files: ["t1.txt"] })],
        {
          review: { approve: false, findings: [{ note: "report.certificate.exitCode is read from f.filepath and scripted.sh never checks it", severity: "material" }] },
          consult: { action: "human", notes: "operator decides" },
          tasks: { T1: [
            { shell: `echo one > t1.txt && ${COMMIT} one`, result: { ok: true, summary: "one" } },
            { shell: `echo two > t1.txt && ${COMMIT} two`, result: { ok: true, summary: "two" } },
            { shell: `echo three > t1.txt && ${COMMIT} three`, result: { ok: true, summary: "three" } },
          ] },
        },
      );
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-prose-park" });
      expect(s.human).toEqual(["T1"]);
      const evs = rows(repo, "run-prose-park");
      expect(of(evs, "scope-authoring")).toEqual([]);
      const park = of(evs, "task-human").at(-1)!;
      expect(park.data.kind).toBe("gate-fail");
      expect(String(park.data.reason)).not.toMatch(/files\[\] repair hint/);
      const [decision] = deriveRunDecisions(Journal.open(repo, "run-prose-park"));
      expect(decision!.park.failedGate).toBe("review");
      expect(decision!.verbs).toEqual(["waive", "uphold", "recheck"]);
    }
    // ---- (d) a review round exhausted with no verdict parks infra and buys no worker ----------------
    for (const policy of ["", "executionPolicy: { boundedInfrastructure: true, taskExecutionLimitMs: 600000 }\n"]) {
      const runId = policy ? "run-no-verdict-policy" : "run-no-verdict";
      const { repo, scriptPath } = setupRepo([T("T1")], {
        tasks: { T1: [{ shell: `echo work > t1.txt && ${COMMIT} work`, result: { ok: true, summary: "work" } }] },
      }, `concurrency: 1\nreview: { required: true, prefer: [seat-a, seat-b], timeoutMs: 1000 }\n${policy}`);
      const seats = ["seat-a", "seat-b"].map((id) => new Seat(scriptPath, id));
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), ...seats], runId });
      expect(s.human).toEqual(["T1"]);
      const evs = rows(repo, runId);
      expect(seats.map((seat) => seat.calls)).toEqual([1, 1]);
      expect(of(evs, "review-no-verdict").map((e) => e.data.reviewer)).toEqual(["seat-a:seat-a", "seat-b:seat-b"]);
      expect(of(evs, "task-human").at(-1)?.data.kind).toBe("infra");
      const dispatches = of(evs, "task-dispatch");
      expect(dispatches).toHaveLength(1);
      expect(evs.indexOf(dispatches[0]!)).toBeLessThan(evs.indexOf(of(evs, "review-no-verdict")[0]!));
      expect(evs.filter((e) => ["escalation", "consult-verdict", "repair-attempt", "worker-launch"].includes(e.event) && e.taskId === "T1" && evs.indexOf(e) > evs.indexOf(dispatches[0]!) && e.event !== "worker-launch")).toEqual([]);
      expect(of(evs, "worker-launch")).toHaveLength(1);
      expect(Journal.open(repo, runId).replayResumeState().get("T1")?.attempts).toBe(1); // only the originating attempt is on the ladder
      const telemetry = readFileSync(`${Journal.open(repo, runId).dir}/telemetry.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { outcome?: string; gateFails?: number });
      expect(telemetry.find((r) => r.outcome === "human")?.gateFails).toBe(0); // a no-verdict is not a quality failure charged to the attempt
    }
  }, 300_000);
});
