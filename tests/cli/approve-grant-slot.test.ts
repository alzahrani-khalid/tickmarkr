// Queue row 411 (D-2187 add.65, add.70): approve's bound check counts the compiled files[] patterns plus
// ONE slot for every grant together, and --files splits on commas outside braces only — every cell of
// the contract's table executed through the production approve seam.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

const SIX = ["c1", "c2", "c3", "c4", "c5", "c6"];

/** A run whose T1 (six criteria, `files` compiled) parks a scope request. */
function seed(runId: string, files: string[], acceptance = SIX) {
  const { repo } = setupRepo([T("T1", { files, acceptance })], { tasks: {} });
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
  park(repo, journal);
  return { repo, journal };
}
const park = (repo: string, journal: Journal) =>
  journal.append("task-human", "T1", { kind: "scope-request", paths: ["x"], graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
const filesOf = (repo: string) => loadGraph(repo).tasks.find((t) => t.id === "T1")!.files;

describe("row 411 — a grant counts as one surface slot; --files keeps braces whole", () => {
  test("a six criterion task with three compiled patterns accepts a first and a second grant because all grants count as one slot", async () => {
    // Production seam: the daemon dispatches T1, its worker reports the path outside files[], the run parks a
    // scope request, and approve --files grants it — twice.
    const refuse = (path: string) => ({ shell: "true", result: { ok: false, summary: `Cannot edit ${path} outside files[] allowlist` } });
    const { repo, fake } = setupRepo([T("T1", { files: ["a.ts", "b.ts", "c.ts"], acceptance: SIX })], { tasks: { T1: [refuse("d.ts"), refuse("f.ts")] } });
    for (const path of ["d.ts", "e.ts", "f.ts"]) writeFileSync(join(repo, path), "needs repair\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", "seed requested paths"], { cwd: repo });
    const id = "run-slot-two";
    const parkAndGrant = async (resume: boolean, files: string) => {
      await runDaemon(repo, { adapters: [fake], runId: id, resume, approvalWindowMs: 1 });
      expect(Journal.open(repo, id).read().filter((e) => e.event === "task-human" && e.data.kind === "scope-request").at(-1)).toBeDefined();
      return approve([id, "T1", "--files", files], repo);
    };
    // run …2493's T14 shape: a two-file grant — six × (three + two paths) is 30, but six × four slots is 24.
    expect(await parkAndGrant(false, "d.ts,e.ts")).toContain("approved files[] for T1");
    expect(filesOf(repo)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    // a second grant later: still one slot for all grants (a slot per grant would be 6 × 5 = 30).
    expect(await parkAndGrant(true, "f.ts")).toContain("approved files[] for T1");
    expect(filesOf(repo)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
    expect(Journal.open(repo, id).read().filter((e) => e.event === "task-approved" && e.data.release === "scope-request")).toHaveLength(2);
  });

  test("a task whose compiled patterns alone exceed the bound still refuses any grant", async () => {
    const { repo, journal } = seed("run-slot-over", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    const journalPath = join(journal.dir, "journal.jsonl");
    const before = readFileSync(journalPath, "utf8");
    await expect(approve([journal.runId, "T1", "--files", "f.ts"], repo))
      .rejects.toThrow("acceptance×files surface of 36 (6 criteria × 6 files[] patterns), above the 24 bound");
    expect(readFileSync(journalPath, "utf8")).toBe(before);
    expect(filesOf(repo)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  test("a brace glob in the files flag stays one pattern plain commas still split and an unbalanced brace refuses", async () => {
    const brace = seed("run-flag-brace", ["owned.txt"], ["c1"]);
    await approve([brace.journal.runId, "T1", "--files", "tests/cli/{doctor,vendor-truth}.test.ts"], brace.repo);
    expect(filesOf(brace.repo)).toEqual(["owned.txt", "tests/cli/{doctor,vendor-truth}.test.ts"]);

    const plain = seed("run-flag-plain", ["owned.txt"], ["c1"]);
    await approve([plain.journal.runId, "T1", "--files", "a.ts,b.ts"], plain.repo);
    expect(filesOf(plain.repo)).toEqual(["owned.txt", "a.ts", "b.ts"]);

    // The contract's closed table (D-2187 add.148): every --files cell through production approve.
    const accepted: Array<[string, string[]]> = [
      ["app/[id]/a.ts,app/[slug]/b.ts", ["app/[id]/a.ts", "app/[slug]/b.ts"]],
      ["app/[id]/{a,b}.ts", ["app/[id]/{a,b}.ts"]],
      ["src/{a,{b,c}}.ts,d.ts", ["src/{a,{b,c}}.ts", "d.ts"]],
      ["f{1..3}.ts,a.ts", ["f{1..3}.ts", "a.ts"]],
    ];
    for (const [i, [flag, granted]] of accepted.entries()) {
      const ok = seed(`run-flag-ok-${i}`, ["owned.txt"], ["c1"]);
      await approve([ok.journal.runId, "T1", "--files", flag], ok.repo);
      expect(filesOf(ok.repo)).toEqual(["owned.txt", ...granted]);
    }
    const UNBALANCED = "has an unbalanced brace — remedy: write each path out, and put ? where a file's name holds a brace or a comma";
    const DISAGREE = "holds a brace or comma that is not one to the matcher (it sits in an escape, a quote or a character class) — remedy: write each path out, and put ? where a file's name holds a brace or a comma";
    const refused: Array<[string, string]> = [
      ...["src/{a,b.ts", "src/a}.ts", "src/b}.ts,c.ts", "src/\\{a.ts", "src/[{].ts", "src/[[:alpha:]{].ts", 'src/"{".ts', "src/[!]{].ts", "src/[!]}].ts"]
        .map((flag): [string, string] => [flag, UNBALANCED]),
      ...["src/[[:alpha:],].ts", "src/[a,b].ts", "src/a\\,b.ts", 'src/"a,b".ts', "src/\\{a.ts,src/b\\}.ts", 'src/"{a.ts",src/"b}.ts"',
        "src/{a,b\\}.ts", "src/\\{a,b}.ts", "src/{[[:alpha:]}].ts", "src/[[:alpha:]{].ts,src/b}.ts", "src/{a}.ts", "src/{a,{b}}.ts"]
        .map((flag): [string, string] => [flag, DISAGREE]),
    ];
    for (const [i, [flag, text]] of refused.entries()) {
      const bad = seed(`run-flag-bad-${i}`, ["owned.txt"], ["c1"]);
      const before = readFileSync(join(bad.journal.dir, "journal.jsonl"), "utf8");
      await expect(approve([bad.journal.runId, "T1", "--files", flag], bad.repo)).rejects.toThrow(`--files value ${flag} ${text}`);
      expect(filesOf(bad.repo)).toEqual(["owned.txt"]);
      expect(readFileSync(join(bad.journal.dir, "journal.jsonl"), "utf8")).toBe(before);
    }
  });
});
