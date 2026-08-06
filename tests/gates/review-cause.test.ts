import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import type { GateVia } from "../../src/gates/llm.js";
import { reviewGate } from "../../src/gates/review.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

class VerdictPane implements ExecutorDriver {
  id = "verdict-pane";
  interactive = false;
  private nonce = "";

  constructor(private readonly output: (nonce: string) => string) {}

  async slot(cwd: string, name: string): Promise<Slot> { return { id: name, name, cwd }; }
  async run(): Promise<void> {}
  async waitOutput(_slot: Slot, pattern: string): Promise<boolean> {
    this.nonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)?.[1] ?? "";
    return true;
  }
  async waitAgentStatus(): Promise<boolean> { return true; }
  async status(): Promise<"unknown"> { return "unknown"; }
  async read(): Promise<string> { return this.output(this.nonce); }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
  async worktree(): Promise<string> { return ""; }
}

const task = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{
    id: "T1", title: "review cause", goal: "separate silence from malformed participation",
    shape: "implement", complexity: 8, files: ["src/work.ts"], acceptance: ["works"],
  }],
}).tasks[0];

const author: Assignment = { adapter: "author", model: "author-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { ...author, vendor: "author-vendor" },
  { adapter: "fake", vendor: "review-vendor", model: "fake-2", channel: "api", tier: "frontier" },
];

function reviewer(): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-review-cause-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  return new FakeAdapter(script);
}

function repoWithCommit(): { repo: string; base: string } {
  const repo = makeRepo({ "src/work.ts": "export const value = 1;\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/work.ts"), "export const value = 2;\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

function via(driver: ExecutorDriver): GateVia {
  return {
    driver,
    nameFor: () => "review-cause",
    labelFor: () => "REVIEW T1",
  };
}

describe("review caller verdict cause", () => {
  test("the review caller branches on the cause, so a silent review is recorded as a dispatch failure rather than a rejection, while a structurally valid but malformed verdict still fails closed", async () => {
    const { repo, base } = repoWithCommit();
    const fake = reviewer();
    const silent = await reviewGate(
      task, repo, base, author, channels, [fake], DEFAULT_CONFIG,
      via(new VerdictPane((nonce) => `TICKMARKR_EXIT_${nonce}:0`)),
    );
    const malformed = await reviewGate(
      task, repo, base, author, channels, [fake], DEFAULT_CONFIG,
      via(new VerdictPane((nonce) => `{"nonce":"${nonce}","approve":true, definitely-not-json\nTICKMARKR_EXIT_${nonce}:0`)),
    );

    expect(silent.pass).toBe(false);
    expect(silent.meta?.cause).toBe("no-verdict");
    expect(silent.details).toMatch(/review dispatch failed/i);
    expect(silent.details).not.toMatch(/requested changes|approval rejected/i);

    expect(malformed.pass).toBe(false);
    expect(malformed.meta?.cause).toBe("malformed-verdict");
    expect(malformed.details).toMatch(/review output unparseable/i);
    expect(malformed.details).not.toMatch(/dispatch failed/i);
  });
});
