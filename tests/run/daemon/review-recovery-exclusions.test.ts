import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

class ReviewSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string, public override id: string, private tier: BillingChannel["tier"]) {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: this.tier }];
  }
  override headlessCommand(promptFile: string): string {
    this.calls++;
    // A second invocation approves so a regression fails promptly instead of looping forever.
    if (this.id === "seat-a" && this.calls === 1) return "printf 'Review completed, but no structured verdict was returned.'";
    const nonce = extractPromptNonce(readFileSync(promptFile, "utf8"));
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce, approve: true, issues: [] }))}`;
  }
}

test("review recovery retains live exclusions when only a below-floor alternative remains", async () => {
  const { repo, fake, scriptPath } = setupRepo([T("T1", {
    routingHints: { pin: { via: "fake", model: "fake-1" } },
  })], {
    tasks: { T1: [{ shell: `echo work > t1.txt && ${COMMIT} work`, result: { ok: true, summary: "work" } }] },
  }, "review: { required: true, floor: frontier, prefer: [seat-a, seat-c] }\n");
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "cheap" }];
  const frontier = new ReviewSeat(scriptPath, "seat-a", "frontier");
  const cheap = new ReviewSeat(scriptPath, "seat-c", "cheap");
  const runId = "run-live-review-exclusions";
  const result = await runDaemon(repo, { adapters: [fake, frontier, cheap], runId });
  expect(frontier.calls).toBe(1);
  expect(cheap.calls).toBe(0);
  expect(result.human).toEqual(["T1"]);
  const events = Journal.open(repo, runId).read().filter((event) => event.taskId === "T1");
  expect(events.filter((event) => event.event === "task-human").at(-1)?.data.kind).toBe("infra");
  expect(events.filter((event) => event.event === "review-no-verdict").map((event) => event.data.reviewer)).toEqual(["seat-a:seat-a"]);
}, 60_000);
