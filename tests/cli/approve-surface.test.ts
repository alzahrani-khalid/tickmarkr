import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { SURFACE_CONTRACT_EXCEPTIONS } from "../../src/compile/collateral.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

const criteria = (n: number) => Array.from({ length: n }, (_, i) => `criterion ${i + 1}`);
const patterns = (n: number) => Array.from({ length: n }, (_, i) => `src/owned-${i + 1}.ts`);

// A valid scope-request park: graph identity matches and the lone task is trivially separable, so
// only the bound check can refuse.
function parked(id: string, acceptance: string[], files: string[], request: string) {
  const { repo } = setupRepo([T(id, { acceptance, files })], { tasks: {} });
  const hash = graphDefinitionHash(loadGraph(repo));
  const journal = Journal.create(repo, `run-approve-surface-${id}`);
  journal.append("run-start", undefined, { graphDefinitionHash: hash });
  journal.append("task-human", id, { kind: "scope-request", paths: [request], graphDefinitionHash: hash });
  const journalPath = join(journal.dir, "journal.jsonl");
  return { repo, journal, before: readFileSync(journalPath, "utf8"), journalPath };
}

const approvals = (journal: Journal) => journal.read().filter((e) => e.event === "task-approved");

test("test: an approve files grant lifting a four criterion task from six files patterns to seven is refused naming the surface of twenty eight beside the split remedy before any approval row is journaled, so an over bound grant that appends authority first fails", async () => {
  const { repo, journal, before, journalPath } = parked("T1", criteria(4), patterns(6), "needed.txt");
  const graphBefore = readFileSync(join(repo, ".tickmarkr", "graph.json"), "utf8");

  const refusal = approve([journal.runId, "T1", "--files", "needed.txt"], repo);
  await expect(refusal).rejects.toThrow(/surface of 28 \(4 criteria × 7 files\[\] patterns\), above the 24 bound/);
  await expect(approve([journal.runId, "T1", "--files", "needed.txt"], repo))
    .rejects.toThrow(/close the run, split the task.*recompile.*resume run-approve-surface-T1 --graph-changed/s);

  expect(approvals(journal)).toHaveLength(0);
  expect(readFileSync(journalPath, "utf8")).toBe(before);
  expect(readFileSync(join(repo, ".tickmarkr", "graph.json"), "utf8")).toBe(graphBefore);
  expect(journal.replayStatuses().get("T1")).toBe("human");
});

test("test: a grant whose amended task equals the first recorded compile exception in id criteria count plus all seven paths is refused like any other over bound grant, so a live grant borrowing a historical compile exception fails", async () => {
  const ex = SURFACE_CONTRACT_EXCEPTIONS[0]!;
  expect(ex.files).toHaveLength(7);
  const { repo, journal, before, journalPath } = parked(ex.id, criteria(ex.acceptance), ex.files.slice(0, 6), ex.files[6]!);

  await expect(approve([journal.runId, ex.id, "--files", ex.files[6]!], repo))
    .rejects.toThrow(/surface of 28 .*above the 24 bound/);

  expect(approvals(journal)).toHaveLength(0);
  expect(readFileSync(journalPath, "utf8")).toBe(before);
});

test("test: a grant lifting a two criterion task from eight files patterns to nine is refused naming the pattern limit, so a surface only check that admits nine patterns fails", async () => {
  const { repo, journal, before, journalPath } = parked("T1", criteria(2), patterns(8), "needed.txt");

  await expect(approve([journal.runId, "T1", "--files", "needed.txt"], repo))
    .rejects.toThrow(/T1 declares 9 files\[\] patterns \(max 8\)/);

  expect(approvals(journal)).toHaveLength(0);
  expect(readFileSync(journalPath, "utf8")).toBe(before);
});

test("test: the same grant lifting a four criterion task from five files patterns to six is journaled as a scope request approval carrying the amended files, so a bound check that refuses a lawful amendment fails", async () => {
  const { repo, journal } = parked("T1", criteria(4), patterns(5), "needed.txt");

  await approve([journal.runId, "T1", "--files", "needed.txt", "--by", "operator"], repo);

  const rows = approvals(journal);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    taskId: "T1",
    data: { by: "operator", release: "scope-request", amendment: { beforeFiles: patterns(5), files: [...patterns(5), "needed.txt"] } },
  });
});
