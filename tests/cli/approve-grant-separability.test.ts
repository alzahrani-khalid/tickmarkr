// Queue row 414 (D-2187 add.71): approve's scope grant folds the same overlap compile does, so a
// brace grant sharing a member with an unordered sibling is refused through the production seam.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

/** A run whose T1 parks a scope request for `requested`, its unordered sibling T2 writing src/{a,b}.ts. */
function seed(runId: string, requested: string) {
  const { repo } = setupRepo([T("T1", { files: ["owned.txt"] }), T("T2", { files: ["src/{a,b}.ts"] })], { tasks: {} });
  const hash = graphDefinitionHash(loadGraph(repo));
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { graphDefinitionHash: hash });
  journal.append("task-human", "T1", { kind: "scope-request", paths: [requested], graphDefinitionHash: hash });
  return { repo, journal, graphPath: join(repo, ".tickmarkr", "graph.json"), journalPath: join(journal.dir, "journal.jsonl") };
}

test("test: a scope grant whose brace pattern shares a member with an unordered sibling is refused naming the shared member", async () => {
  // The contract's exact cell: the comma brace grant stays one glob (row 414) and is refused naming src/b.ts.
  for (const pattern of ["src/{b,c}.ts", "src/{b..c}.ts"]) {
    const refused = seed(`run-grant-sep-${pattern.includes("..") ? "range" : "comma"}`, pattern);
    const beforeGraph = readFileSync(refused.graphPath, "utf8");
    const beforeJournal = readFileSync(refused.journalPath, "utf8");
    await expect(approve([refused.journal.runId, "T1", "--files", pattern], refused.repo))
      .rejects.toThrow("refusing scope-request approval for T1: T1 and T2 both write src/b.ts but neither depends on the other");
    expect(readFileSync(refused.graphPath, "utf8")).toBe(beforeGraph);
    expect(readFileSync(refused.journalPath, "utf8")).toBe(beforeJournal);
  }

  // control: a disjoint comma brace grant is approved whole, beside a plain comma-separated path
  const granted = seed("run-grant-sep-disjoint", "src/{c,d}.ts");
  expect(await approve([granted.journal.runId, "T1", "--files", "src/{c,d}.ts,lib/x.ts"], granted.repo)).toContain("approved files[] for T1");
  expect(loadGraph(granted.repo).tasks.find((t) => t.id === "T1")!.files).toEqual(expect.arrayContaining(["src/{c,d}.ts", "lib/x.ts"]));
});
