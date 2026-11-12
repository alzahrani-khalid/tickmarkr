// Row 417; D-2187 add.78: a transport death is a task-local strike and never retires the seat — live, or when a
// resume seeds the tally from the journal. Two malformed-verdict strikes still retire (control). Through the
// production runDaemon: each assertion reads which seat actually LAUNCHED for which task. Zero tokens: fake
// adapters and a delegating subprocess driver that observes every review launch.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { Slot } from "../../src/drivers/types.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo as baseSetupRepo, T } from "../helpers/tmprepo.js";

function setupRepo(...args: Parameters<typeof baseSetupRepo>) {
  const fixture = baseSetupRepo(...args);
  const config = join(fixture.repo, ".tickmarkr", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
  return fixture;
}

const reviewCfg = `visibility:\n  llm: pane\n  keepPanes: run\nreview: { required: true, prefer: [seat-a, seat-b], timeoutMs: 5000 }\n`;
const work = (id: string) => ({ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
const rowsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
const A = "seat-a:seat-a";
const reviewerOf = (rows: JournalEvent[], taskId: string) =>
  rows.filter((r) => r.taskId === taskId && r.event === "gate-result" && r.data.gate === "review").at(-1)?.data.reviewer;
const serial = (...ids: string[]) => ids.map((id, i) => T(id, i ? { deps: [ids[i - 1]!] } : {}));

type Reply = "approve" | "transport" | "malformed";
class Seat extends FakeAdapter {
  constructor(path: string, public override id: string, private replies: Record<string, Reply> = {}) {
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
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return "true";
    const nonce = extractPromptNonce(prompt);
    const reply = this.replies[/^## Task (\S+):/m.exec(prompt)?.[1] ?? ""] ?? "approve";
    // the …1173 shape: a reconnect line, then the process exits — cause transport (T5)
    if (reply === "transport") return `: SEAT=${this.id}; printf '%s\\n' 'ERROR: Reconnecting... 2/5'; exit 1`;
    const body = reply === "malformed" ? `{"nonce": "${nonce}", "approve": true, "findings": [] "resolved": []}`
      : JSON.stringify({ nonce, approve: true, resolved: [], reraised: [], findings: [] });
    return `: SEAT=${this.id}; printf '%s' ${shq(body)}`;
  }
}
class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return [super.channels()[0]!, { ...super.channels()[1]!, tier: "cheap" }]; }
}

/** A real SubprocessDriver recording `seat/task` for every review launch; `refuse(task)` fails a launch. */
function seatDriver(refuse: (task: string) => boolean = () => false) {
  const inner = new SubprocessDriver();
  const seated: string[] = [];
  const driver = {
    id: "subprocess", interactive: false,
    status: inner.status.bind(inner),
    slot: inner.slot.bind(inner),
    async run(slot: Slot, command: string) {
      const script = /([^'"\s]*dispatch\.sh)/.exec(command)?.[1];
      const seat = script ? /: SEAT=(seat-[a-z]);/.exec(readFileSync(script, "utf8"))?.[1] : undefined;
      if (seat) {
        const task = /^tickmarkr:review:([^:]+):/.exec(slot.name)?.[1] ?? "";
        seated.push(`${seat}/${task}`);
        if (refuse(task)) throw new Error("pane create refused");
      }
      return inner.run(slot, command);
    },
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: (slot: Slot) => inner.close(slot),
    worktree: inner.worktree.bind(inner),
  };
  return { driver, seated };
}
const of = (seated: string[], task: string) => seated.filter((s) => s.endsWith(`/${task}`));

describe("a transport death is task-local and never retires the seat (production, zero tokens)", { timeout: 240_000 }, () => {
  test("a transport death keeps that seat out of the rest of the task round and the seat is picked for the next task", async () => {
    const { repo, scriptPath } = setupRepo(serial("T1", "T2"), { tasks: { T1: [work("t1")], T2: [work("t2")] } }, reviewCfg);
    const { driver, seated } = seatDriver();
    const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a", { T1: "transport" }), new Seat(scriptPath, "seat-b")], runId: "run-one", driver });
    expect(s.done).toEqual(["T1", "T2"]);
    const rows = rowsOf(repo, "run-one");
    expect(rows.filter((r) => r.event === "review-no-verdict").map((r) => r.data)).toEqual([expect.objectContaining({ reviewer: A, cause: "transport" })]);
    expect(of(seated, "T1")).toEqual(["seat-a/T1", "seat-b/T1"]); // A sits out the rest of T1's round
    expect(of(seated, "T2")).toEqual(["seat-a/T2"]); // and is picked for the next task
    expect(reviewerOf(rows, "T2")).toBe(A);
    expect(rows.filter((r) => r.event === "review-pool-demotion")).toEqual([]);
  });

  test("two transport deaths of one seat never retire it live or after a resume seeded from those rows", async () => {
    const { repo, scriptPath } = setupRepo(serial("T1", "T2", "T3"), { tasks: { T1: [work("t1")], T2: [work("t2")], T3: [work("t3")] } }, reviewCfg);
    const replies: Record<string, Reply> = { T1: "transport", T2: "transport" };
    const adapters = () => [new Author(scriptPath), new Seat(scriptPath, "seat-a", replies), new Seat(scriptPath, "seat-b")];
    // live: two transport deaths, then the third task still picks A
    {
      const { driver, seated } = seatDriver();
      expect((await runDaemon(repo, { adapters: adapters(), runId: "run-live", driver })).done).toEqual(["T1", "T2", "T3"]);
      expect(of(seated, "T2")[0]).toBe("seat-a/T2");
      expect(of(seated, "T3")).toEqual(["seat-a/T3"]);
      expect(reviewerOf(rowsOf(repo, "run-live"), "T3")).toBe(A);
    }
    // resume: the journal holds two transport review-no-verdict rows for A and T3 parked on launch refusals;
    // the resumed daemon seeds its tally from those rows and A is eligible for T3
    {
      const { repo: r2, scriptPath: p2 } = setupRepo(serial("T1", "T2", "T3"), { tasks: { T1: [work("t1")], T2: [work("t2")], T3: [work("t3")] } }, reviewCfg);
      const seats = [new Author(p2), new Seat(p2, "seat-a", replies), new Seat(p2, "seat-b")];
      let refuseT3 = true;
      const { driver, seated } = seatDriver((task) => task === "T3" && refuseT3);
      const first = await runDaemon(r2, { adapters: seats, runId: "run-resume", driver });
      expect(first.done).toEqual(["T1", "T2"]);
      expect(first.human).toEqual(["T3"]);
      const transport = rowsOf(r2, "run-resume").filter((r) => r.event === "review-no-verdict" && r.data.cause === "transport");
      expect(transport.map((r) => r.data.reviewer)).toEqual([A, A]);
      refuseT3 = false;
      seated.length = 0;
      await approve(["run-resume", "T3", "--recheck", "--by", "op"], r2);
      expect((await runDaemon(r2, { adapters: seats, runId: "run-resume", resume: true, driver })).done).toContain("T3");
      expect(of(seated, "T3")).toEqual(["seat-a/T3"]);
      expect(reviewerOf(rowsOf(r2, "run-resume"), "T3")).toBe(A);
    }
  });

  test("two malformed verdict strikes still retire the seat as before", async () => {
    const { repo, scriptPath } = setupRepo(serial("T1", "T2"), { tasks: { T1: [work("t1")], T2: [work("t2")] } }, reviewCfg);
    const { driver, seated } = seatDriver();
    const s = await runDaemon(repo, { adapters: [new Author(scriptPath), new Seat(scriptPath, "seat-a", { T1: "malformed" }), new Seat(scriptPath, "seat-b")], runId: "run-malformed", driver });
    expect(s.done).toEqual(["T1", "T2"]);
    const rows = rowsOf(repo, "run-malformed");
    expect(rows.filter((r) => r.event === "review-pool-demotion").map((r) => r.data)).toEqual([
      expect.objectContaining({ reviewer: A, causes: ["malformed-verdict", "malformed-verdict"] }),
    ]);
    expect(of(seated, "T1")).toEqual(["seat-a/T1", "seat-a/T1", "seat-b/T1"]);
    expect(of(seated, "T2")).toEqual(["seat-b/T2"]); // retired for the run
  });
});
