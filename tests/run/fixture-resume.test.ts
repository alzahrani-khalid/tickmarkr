import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { graphDefinitionHash, loadGraph, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { gitHead } from "../../src/run/git.js";
import { COMMIT, makeRepo } from "../helpers/tmprepo.js";

const fixtureRaw = readFileSync(join(import.meta.dirname, "..", "fixtures", "graph-v1.3.json"), "utf8");

describe("graph-v1.3 fixture compat", () => {
  test("fixture passes validateGraph and carries no routingHints", () => {
    const g = validateGraph(JSON.parse(fixtureRaw));
    expect(g.version).toBe(1);
    expect(g.spec.source).toBe("gsd");
    expect(g.tasks).toHaveLength(2);
    expect(g.tasks[0].id).toBe("P01-01");
    expect(g.tasks[0].status).toBe("done");
    expect(g.tasks[0].routingHints).toBeUndefined();
    expect(g.tasks[1].id).toBe("P01-02");
    expect(g.tasks[1].status).toBe("pending");
    expect(g.tasks[1].routingHints).toBeUndefined();
    expect(g.tasks[1].deps).toEqual(["P01-01"]);
  });

  test("resume-replay: replayed done task P01-01 is not re-dispatched", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const g = validateGraph(JSON.parse(fixtureRaw));
    saveGraph(repo, g);
    const scriptDir = mkdtempSync(join(tmpdir(), "tickmarkr-fixture-script-"));
    const scriptPath = join(scriptDir, "s.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        judge: { pass: true, criteria: [
          { criterion: "c1", met: true, reason: "ok" },
          { criterion: "c2", met: true, reason: "ok" },
        ] },
        review: { approve: true, issues: [] },
        consult: { action: "retry", notes: "retry with fix" },
        tasks: {
          "P01-01": [{ shell: "echo SHOULD-NOT-RUN && exit 1", result: { ok: false, summary: "must not run" } }],
          "P01-02": [{ shell: `mkdir -p src/graph && echo done > src/graph/graph.ts && ${COMMIT} done`, result: { ok: true, summary: "p01-02 done" } }],
        },
      }),
    );
    writeFileSync(
      join(tickmarkrDir(repo), "config.yaml"),
      "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n",
    );
    const fake = new FakeAdapter(scriptPath);

    const j = Journal.create(repo, "run-fixture-resume");
    const baseRef = await gitHead(repo);
    j.append("run-start", undefined, { baseRef, commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    j.append("task-dispatch", "P01-01");
    j.append("task-done", "P01-01");
    writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-fixture-resume", resume: true });
    expect(s.done).toContain("P01-02");
    const dispatches = Journal.open(repo, "run-fixture-resume").read().filter((e) => e.event === "task-dispatch");
    expect(dispatches.filter((e) => e.taskId === "P01-01")).toHaveLength(1);
  });
});
