// T7 (OBS-1168(b)(c), OBS-1196): a judge or reviewer seat that cannot launch, or that delivers a malformed
// verdict, is a seat problem — recovered on another seat or parked infra, never charged to the worker —
// and the round's other semantic gate is settled before the engagement closes, with or without a policy.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { Slot } from "../../../src/drivers/types.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

const PANE = "visibility:\n  llm: pane\n  keepPanes: run\n";
const work = (id: string, file = "work.txt") => ({ shell: `echo ${id} > ${file} && ${COMMIT} ${id}`, result: { ok: true, summary: id } });

/** A real SubprocessDriver whose pane CREATION refuses the names `fails` picks — the seat never launches.
 * `hold` keeps a pane's creation pending until it resolves; `ran` lists every pane actually dispatched. */
function seatDriver(fails: (name: string) => boolean, onClose?: (slot: Slot) => void, hold?: (name: string) => Promise<void>) {
  const inner = new SubprocessDriver();
  const created: string[] = [];
  const ran: string[] = [];
  const driver = {
    id: "subprocess", // a delegating SubprocessDriver: executionPolicy admits only this transport
    interactive: false,
    status: inner.status.bind(inner),
    async slot(cwd: string, name: string) {
      created.push(name);
      if (fails(name)) throw new Error(`pane create refused for ${name}`);
      await hold?.(name);
      return inner.slot(cwd, name);
    },
    async run(slot: Slot, command: string) { ran.push(slot.name); return inner.run(slot, command); },
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    async close(slot: Slot) { onClose?.(slot); return inner.close(slot); },
    worktree: inner.worktree.bind(inner),
  };
  return { driver, created, ran };
}
const role = (name: string, r: "judge" | "review", attempt?: number) =>
  name.startsWith(`tickmarkr:${r}:`) && (attempt === undefined || name.split(":")[3] === String(attempt));

class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return super.channels().slice(0, 1); }
}

type Reply = "malformed" | "red" | "approve" | "slow";
class Reviewer extends FakeAdapter {
  nonces: string[] = [];
  private turn = 0;
  constructor(path: string, public override id: string, private replies: Reply[]) {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1] ?? "";
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return "true";
    this.nonces.push(nonce);
    const reply = this.replies[Math.min(this.turn++, this.replies.length - 1)]!;
    // One missing comma: the verdict a salvager could "repair" — and must never accept.
    if (reply === "malformed") return `printf '%s' ${shq(`{"nonce": "${nonce}", "approve": true, "findings": [] "resolved": []}`)}`;
    // A later round closes the fingerprints the brief carries, exactly as a real reviewer must.
    const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    const verdict = reply === "red"
      ? { nonce, approve: false, resolved: [], reraised: [], findings: [{ note: "work.txt: the guard is missing", severity: "material" }] }
      : { nonce, approve: true, resolved: carried, reraised: [], findings: [] };
    return `${reply === "slow" ? "sleep 1; " : ""}printf '%s' ${shq(JSON.stringify(verdict))}`;
  }
}

const rowsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
const taskRows = (rows: JournalEvent[], event: string) => rows.filter((row) => row.taskId === "T1" && row.event === event);

// C-14: each case drives whole production daemon runs (~6 s on a fast host); the 20 s unit default
// timed out two of them on public CI's 2-core runner, so they carry a daemon-test budget like their siblings.
describe("semantic seat delivery (production daemon, fake adapters, zero tokens)", { timeout: 120_000 }, () => {
  test("the production daemon spends one same-subject same-channel fresh-nonce retry on malformed reviewer delivery before an infrastructure park versus preserving a valid material red, so JSON salvage or an author debit fails", async () => {
    const reviewCfg = "review: { required: true, prefer: [seat-a], timeoutMs: 5000 }\n";
    // Malformed twice from the ONLY eligible reviewer: one re-emission on that seat, then an infra park.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("a0"), work("a1")] } }, reviewCfg);
      const seat = new Reviewer(scriptPath, "seat-a", ["malformed"]);
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), seat], runId: "run-malformed" });
      expect(s.human).toEqual(["T1"]);
      expect(seat.nonces).toHaveLength(2);
      expect(new Set(seat.nonces).size).toBe(2);
      const rows = rowsOf(repo, "run-malformed");
      expect(taskRows(rows, "review-reemission").map((row) => row.data)).toEqual([{ reviewer: "seat-a:seat-a", cause: "malformed-verdict", delivered: false }]);
      expect(taskRows(rows, "task-dispatch")).toHaveLength(1);
      expect(rows.filter((row) => ["escalation", "consult", "repair-attempt", "task-done"].includes(row.event))).toEqual([]);
      expect(taskRows(rows, "task-human").at(-1)?.data.kind).toBe("infra");
      const reviews = taskRows(rows, "gate-result").filter((row) => row.data.gate === "review");
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.data).toMatchObject({ infra: true, skipped: true, reviewer: "seat-a:seat-a", cause: "malformed-verdict" });
      expect(reviews[0]!.data.pass).toBeUndefined();
      expect(reviews[0]!.data.findings).toBeUndefined();
    }
    // Malformed, then a VALID material red on the re-emission: the red stands and funds the repair.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("b0"), work("b1")] } }, reviewCfg);
      const seat = new Reviewer(scriptPath, "seat-a", ["malformed", "red", "approve"]);
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), seat], runId: "run-malformed-red" });
      const rows = rowsOf(repo, "run-malformed-red");
      expect(s.done).toEqual(["T1"]);
      const reviews = taskRows(rows, "gate-result").filter((row) => row.data.gate === "review");
      expect(reviews[0]!.data).toMatchObject({ pass: false, reviewer: "seat-a:seat-a" });
      expect(reviews[0]!.data.infra).toBeUndefined();
      expect(JSON.stringify(reviews[0]!.data.findings)).toContain("the guard is missing");
      expect(taskRows(rows, "task-dispatch")).toHaveLength(2);
      expect(seat.nonces).toHaveLength(3);
    }
  });

  test("production semantic seat-create failure settles its cancelled sibling before engagement close for absent or present policy versus normal completion of a healthy pair, so a failed engagement callback appearing after resume fails", async () => {
    const reviewCfg = "review: { required: true, prefer: [seat-a], timeoutMs: 5000 }\n";
    const policies = ["", "executionPolicy: { taskExecutionLimitMs: 600000 }\n"];
    // `pending`: the reviewer's pane is still being CREATED when the judge's failure cancels the round —
    // it must be closed before dispatch, never launched into the cancelled round.
    for (const [policy, pending] of policies.flatMap((p) => [[p, false], [p, true]] as const)) {
      const runId = `run-sibling${policy ? "-policy" : ""}${pending ? "-pending" : ""}`;
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("c0")] } }, PANE + reviewCfg + policy);
      const seat = new Reviewer(scriptPath, "seat-a", ["slow"]);
      const closedBeforePark: boolean[] = [];
      const judged = () => rowsOf(repo, runId).some((row) => row.event === "gate-result" && row.data.gate === "acceptance");
      const { driver, ran } = seatDriver((name) => role(name, "judge"), (slot) => {
        if (role(slot.name, "review")) closedBeforePark.push(!rowsOf(repo, runId).some((row) => row.event === "task-human"));
      }, async (name) => {
        if (!pending || !role(name, "review")) return;
        for (let waited = 0; !judged() && waited < 10_000; waited += 20) await new Promise((wake) => setTimeout(wake, 20));
        await new Promise((wake) => setTimeout(wake, 100)); // the seatless judge's cancel lands right after its row
      });
      const adapters = [new Author(scriptPath), seat];
      const s = await runDaemon(repo, { adapters, runId, driver });
      expect(s.human).toEqual(["T1"]);
      expect(seat.nonces).toHaveLength(1); // the sibling reviewer was dispatched (or, pending, requested) …
      expect(closedBeforePark.length).toBeGreaterThan(0); // … and cancelled before the park closed the engagement
      expect(closedBeforePark.every(Boolean)).toBe(true);
      expect(ran.filter((name) => role(name, "review"))).toHaveLength(pending ? 0 : 1);
      const parked = rowsOf(repo, runId);
      expect(parked.filter((row) => row.event === "task-failed")).toEqual([]);
      expect(taskRows(parked, "task-human").at(-1)?.data.kind).toBe("infra");
      const parkAt = parked.findIndex((row) => row.event === "task-human");
      const late = (rows: JournalEvent[]) => rows.filter((row) => row.taskId === "T1" && /^(gate-result|review-|judge-)/.test(row.event));
      expect(late(parked.slice(parkAt + 1))).toEqual([]);
      // Resume at once, then outlast the reviewer: nothing of the closed engagement lands afterwards.
      await runDaemon(repo, { adapters, runId, resume: true, driver });
      await new Promise((wake) => setTimeout(wake, 1500));
      const after = rowsOf(repo, runId);
      const resumedAt = after.findLastIndex((row) => row.event === "run-resume");
      expect(resumedAt).toBeGreaterThan(parkAt);
      expect(late(after.slice(resumedAt))).toEqual([]);
    }
    // The healthy pair completes normally: both verdicts land before the task is done.
    const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("d0")] } }, PANE + reviewCfg);
    const { driver } = seatDriver(() => false);
    const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Reviewer(scriptPath, "seat-a", ["slow"])], runId: "run-healthy", driver });
    expect(s.done).toEqual(["T1"]);
    const rows = rowsOf(repo, "run-healthy");
    const doneAt = rows.findIndex((row) => row.event === "task-done");
    const verdicts = rows.flatMap((row, i) => row.event === "gate-result" && ["acceptance", "review"].includes(String(row.data.gate)) ? [i] : []);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((i) => i < doneAt)).toBe(true);
  });

  test("the production daemon reroutes a judge or reviewer after seat-launch failure over green deterministic gates or parks infra when no seat is available versus recording a material semantic failure normally, so task-failed for seat launch over green gates fails", async () => {
    // Judge: the configured seat cannot launch; the failover seat judges and the task merges.
    {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [work("e0")] } }, PANE);
      const { driver } = seatDriver((name) => role(name, "judge", 0));
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-judge-reroute", driver });
      expect(s.done).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-judge-reroute");
      expect(taskRows(rows, "judge-retry").map((row) => row.data)).toEqual([expect.objectContaining({ flaked: "fake:fake-1", retried: "fake:fake-2" })]);
      expect(taskRows(rows, "task-dispatch")).toHaveLength(1);
      expect(rows.filter((row) => row.event === "task-failed")).toEqual([]);
    }
    // Reviewer: the first seat cannot launch, nor on its one same-seat relaunch (v2.6.8 T1); the next seat
    // reviews and the task merges.
    {
      const { repo, scriptPath } = setupRepo([T("T1")], { tasks: { T1: [work("f0")] } },
        PANE + "review: { required: true, prefer: [seat-a, seat-b], timeoutMs: 5000 }\n");
      const { driver } = seatDriver((name) => role(name, "review", 0) || role(name, "review", 1));
      const seats = [new Reviewer(scriptPath, "seat-a", ["approve"]), new Reviewer(scriptPath, "seat-b", ["approve"])];
      const s = await runDaemon(repo, { adapters: [new Author(scriptPath), ...seats], runId: "run-review-reroute", driver });
      expect(s.done).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-review-reroute");
      expect(taskRows(rows, "review-no-verdict").map((row) => row.data)).toEqual([
        expect.objectContaining({ reviewer: "seat-a:seat-a", cause: "seat-launch-failed" }), expect.objectContaining({ reviewer: "seat-a:seat-a", cause: "seat-launch-failed" })]);
      expect(taskRows(rows, "review-infra-retry").map((row) => row.data)).toEqual([expect.objectContaining({ reviewer: "seat-a:seat-a", sameSeat: true })]);
      expect(taskRows(rows, "gate-result").filter((row) => row.data.gate === "review").at(-1)?.data).toMatchObject({ pass: true, reviewer: "seat-b:seat-b" });
      expect(taskRows(rows, "task-dispatch")).toHaveLength(1);
      expect(rows.filter((row) => row.event === "task-failed")).toEqual([]);
    }
    // No judge seat can launch at all: an infra park over the green battery, never task-failed or a worker charge.
    {
      const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [work("g0"), work("g1")] } }, PANE);
      const { driver } = seatDriver((name) => role(name, "judge"));
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-judge-seatless", driver });
      expect(s.human).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-judge-seatless");
      expect(rows.filter((row) => row.event === "task-failed")).toEqual([]);
      expect(taskRows(rows, "task-human").at(-1)?.data.kind).toBe("infra");
      expect(taskRows(rows, "task-dispatch")).toHaveLength(1);
      expect(rows.filter((row) => ["escalation", "consult", "repair-attempt"].includes(row.event))).toEqual([]);
      const results = taskRows(rows, "gate-result");
      const acceptance = results.filter((row) => row.data.gate === "acceptance");
      expect(acceptance).toHaveLength(1);
      expect(acceptance[0]!.data).toMatchObject({ infra: true, classification: "infra" });
      expect(String(acceptance[0]!.data.details)).toContain("failed to launch");
      expect(results.filter((row) => !["acceptance", "review"].includes(String(row.data.gate))).every((row) => row.data.pass !== false)).toBe(true);
    }
    // A material judge FAIL with healthy seats is recorded normally and funds the worker.
    {
      const fail = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "work.txt lacks the behavior" }] };
      const pass = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] };
      const { repo, fake } = setupRepo([T("T1")], { judge: [fail, pass], consult: { action: "retry", notes: "fix it" }, tasks: { T1: [work("h0"), work("h1", "fix.txt")] } }, PANE);
      const { driver } = seatDriver(() => false);
      const s = await runDaemon(repo, { adapters: [fake], runId: "run-judge-material", driver });
      expect(s.done).toEqual(["T1"]);
      const rows = rowsOf(repo, "run-judge-material");
      const acceptance = taskRows(rows, "gate-result").filter((row) => row.data.gate === "acceptance");
      expect(acceptance.map((row) => row.data.pass)).toEqual([false, true]);
      expect(acceptance[0]!.data.infra).toBeUndefined();
      expect(taskRows(rows, "task-dispatch")).toHaveLength(2);
      expect(rows.filter((row) => row.event === "task-failed")).toEqual([]);
    }
  });
});
