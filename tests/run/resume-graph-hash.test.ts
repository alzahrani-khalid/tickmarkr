import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { status } from "../../src/cli/commands/status.js";
import { graphDefinitionHash, tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeRepo, T } from "../helpers/tmprepo.js";

// T3 (Sol #2 / Fable F2): the resume half of the engagement-identity guard. status already refuses the
// join (T2/OBS-52); resume is the higher-stakes consumer — it would replay foreign task-done/human/
// approval state onto a recompiled graph by bare task id. These oracles drive the REAL runDaemon on the
// FakeAdapter (zero tokens) and assert: refuse mismatch, refuse unbound, --graph-changed releases and
// journals both hashes, and status reaches the SAME not-comparable decision through the shared comparator.

const STALE_HASH = "deadbeefdeadbeef"; // never a real sha256 prefix — forces a mismatch vs the loaded graph

const setupResumeRepo = () => {
  const repo = makeRepo({ "base.txt": "base\n" });
  const g = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] });
  saveGraph(repo, g);
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
  const sdir = mkdtempSync(join(tmpdir(), "tickmarkr-rg-"));
  const scriptPath = join(sdir, "s.json");
  writeFileSync(scriptPath, JSON.stringify({
    judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] },
    review: { approve: true, issues: [] },
    consult: { action: "retry", notes: "retry" },
    tasks: { T1: [{ shell: `echo done > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1 done" } }] },
  }));
  return { repo, loadedHash: graphDefinitionHash(g), fake: new FakeAdapter(scriptPath) };
};

// Seed a resume journal: run-start carries baseRef (required by the resume path) plus the caller-chosen
// graphDefinitionHash (undefined ⇒ unbound, simulating a pre-v1.44 journal). baseline.json sits next to it.
const seedResumeJournal = async (repo: string, runId: string, graphDefHash: string | undefined) => {
  const j = Journal.create(repo, runId);
  const baseRef = await gitHead(repo);
  const data: Record<string, unknown> = { baseRef, commands: {} };
  if (graphDefHash !== undefined) data.graphDefinitionHash = graphDefHash;
  j.append("run-start", undefined, data);
  writeFileSync(join(j.dir, "baseline.json"), JSON.stringify({ commands: {} }));
};

describe("T3 resume engagement-identity guard (Sol #2 / Fable F2)", () => {
  test("resume refuses a journal whose recorded hash mismatches the loaded graph", async () => {
    const { repo, loadedHash, fake } = setupResumeRepo();
    await seedResumeJournal(repo, "run-mismatch", STALE_HASH);
    await expect(runDaemon(repo, { adapters: [fake], runId: "run-mismatch", resume: true }))
      .rejects.toThrow(/graph changed since this run.*--graph-changed/);
    // the loaded graph's real hash is named in the message — fail-closed with a precise reason
    await expect(runDaemon(repo, { adapters: [fake], runId: "run-mismatch", resume: true }))
      .rejects.toThrow(loadedHash);
  });

  test("resume refuses a journal with no recorded definition hash (pre-v1.44 journal)", async () => {
    const { repo, fake } = setupResumeRepo();
    await seedResumeJournal(repo, "run-unbound", undefined);
    await expect(runDaemon(repo, { adapters: [fake], runId: "run-unbound", resume: true }))
      .rejects.toThrow(/no recorded graph definition hash.*--graph-changed/);
  });

  test("resume with --graph-changed proceeds and writes a journaled release event naming both hashes", async () => {
    const { repo, loadedHash, fake } = setupResumeRepo();
    await seedResumeJournal(repo, "run-release", STALE_HASH);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-release", resume: true, graphChanged: true });
    expect(s.done).toEqual(["T1"]); // the run proceeded and completed

    const rehash = Journal.open(repo, "run-release").read().find((e) => e.event === "graph-rehash");
    expect(rehash).toBeTruthy();
    expect(rehash!.data).toEqual({ from: STALE_HASH, to: loadedHash }); // both hashes, audited
  });

  test("resume with --graph-changed also releases an unbound journal (from absent, to loaded)", async () => {
    const { repo, loadedHash, fake } = setupResumeRepo();
    await seedResumeJournal(repo, "run-release-unbound", undefined);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-release-unbound", resume: true, graphChanged: true });
    expect(s.done).toEqual(["T1"]);
    const rehash = Journal.open(repo, "run-release-unbound").read().find((e) => e.event === "graph-rehash");
    expect(rehash!.data).toEqual({ from: null, to: loadedHash });
  });

  test("a matching journal resumes without a graph-rehash event and without refusal", async () => {
    const { repo, loadedHash, fake } = setupResumeRepo();
    await seedResumeJournal(repo, "run-match", loadedHash);
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-match", resume: true });
    expect(s.done).toEqual(["T1"]);
    expect(Journal.open(repo, "run-match").read().some((e) => e.event === "graph-rehash")).toBe(false);
  });

  test("status renders the same mismatched journal not-comparable through the shared comparator", async () => {
    const { repo } = setupResumeRepo();
    await seedResumeJournal(repo, "run-mismatch-status", STALE_HASH);
    // status is the read-only twin of resume's decision: both call engagementComparable — status renders
    // the notice, resume refuses. Same journal, same graph, same not-comparable verdict.
    const out = await status([], repo);
    expect(out).toContain("not comparable");
  });
}, 120000);
