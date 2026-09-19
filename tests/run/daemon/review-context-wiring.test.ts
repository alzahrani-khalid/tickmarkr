// v2.5.6 Leg-2 (OBS-1052): the daemon threads `reviewNoVerdicts` into GateContext. Without it
// run-gates' two-strike retirement (OBS-1025 add.2) is inert in production: a flaking seat is
// re-asked on every task and the review-recovery spend is unbounded. Fake adapters, zero tokens.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

// A review-only seat with its own adapter id and vendor. `prose` seats never emit a trailer.
class ReviewSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string, public override id: string, public override vendor: string, private prose = false) {
    super(path);
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(promptFile: string): string {
    this.calls++;
    if (this.prose) return "printf 'Review completed, but no structured verdict was returned.'";
    const nonce = extractPromptNonce(readFileSync(promptFile, "utf8"));
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce, approve: true, issues: [] }))}`;
  }
}

const pin = { routingHints: { pin: { via: "fake", model: "fake-1" } } };
const work = (id: string) => [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }];

test("Leg-2 (OBS-1052): a seat with no verdict on rounds 1 and 2 is absent from round 3's eligible set — the run's review dispatches stay bounded", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", pin), T("T2", { deps: ["T1"], ...pin }), T("T3", { deps: ["T2"], ...pin })],
    { tasks: { T1: work("t1"), T2: work("t2"), T3: work("t3") } },
    "review: { required: true, prefer: [seat-a, seat-b] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b] } } }\n",
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" }];
  const flaky = new ReviewSeat(scriptPath, "seat-a", "vendor-a", true);
  const steady = new ReviewSeat(scriptPath, "seat-b", "vendor-b");
  const runId = "run-leg2-two-strike";
  const result = await runDaemon(repo, { adapters: [fake, flaky, steady], runId, concurrency: 1 });
  expect(result.done).toEqual(["T1", "T2", "T3"]);
  // strike on T1, strike on T2, retired for T3: the flaky seat is asked exactly twice in the run
  expect([flaky.calls, steady.calls]).toEqual([2, 3]);
  const events = Journal.open(repo, runId).read();
  expect(events.filter((e) => e.event === "review-no-verdict").map((e) => [e.taskId, e.data.reviewer])).toEqual([["T1", "seat-a:seat-a"], ["T2", "seat-a:seat-a"]]);
  expect(events.filter((e) => e.event === "review-pool-demotion").map((e) => [e.taskId, e.data.reviewer, e.data.causes]))
    .toEqual([["T2", "seat-a:seat-a", ["no-verdict", "no-verdict"]]]);
  const t3Review = events.filter((e) => e.taskId === "T3" && e.event === "gate-result" && e.data.gate === "review");
  expect(t3Review.map((e) => [e.data.reviewer, e.data.reviewRetry])).toEqual([["seat-b:seat-b", undefined]]);
}, 90_000);
