import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { type BillingChannel } from "../../src/adapters/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

class Fleet extends FakeAdapter {
  judges: string[] = [];
  constructor(path: string, private shortage: boolean) { super(path); }
  override channels(): BillingChannel[] {
    return super.channels().map((c) => this.shortage ? { ...c, vendor: "fake-a" } : c);
  }
  override headlessCommand(file: string, model: string): string {
    if (readFileSync(file, "utf8").startsWith("TICKMARKR-JUDGE")) this.judges.push(model);
    return super.headlessCommand(file, model);
  }
}

test("a daemon run whose worker channel is the configured judge journals its acceptance verdict from a seat of another vendor, and a run whose fleet holds no such seat journals the not-independent key on its acceptance gate row, so independence kept only in memory fails", async () => {
  for (const shortage of [false, true]) {
    const { repo, scriptPath } = setupRepo([T("T1", {
      gates: ["build", "test", "lint", "evidence", "scope", "acceptance"],
    })], { tasks: { T1: [{ shell: `echo done > a.txt && ${COMMIT} done`, result: { ok: true, summary: "done" } }] } });
    const fake = new Fleet(scriptPath, shortage);
    const runId = `run-judge-independent-${shortage}`;
    expect((await runDaemon(repo, { adapters: [fake], runId })).done).toEqual(["T1"]);
    const rows = Journal.open(repo, runId).read();
    const dispatch = rows.find((r) => r.event === "task-dispatch")!;
    expect(dispatch.data.assignment).toMatchObject({ adapter: "fake", model: "fake-1" });
    const acceptance = rows.filter((r) => r.event === "gate-result" && r.data.gate === "acceptance");
    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]!.data).toMatchObject({ pass: true, judgment: { judge: shortage ? "fake:fake-1" : "fake:fake-2" } });
    expect(fake.judges).toEqual([shortage ? "fake-1" : "fake-2"]);
    if (shortage) expect(acceptance[0]!.data.judgeIndependent).toBe(false);
    else expect(acceptance[0]!.data).not.toHaveProperty("judgeIndependent");
  }
});
