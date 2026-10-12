import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { acceptanceGate, type EvidenceCitation } from "../../src/gates/acceptance.js";
import { operationFactsAtHead, readOperationFacts, type OperationFact } from "../../src/gates/operation-facts.js";
import * as review from "../../src/gates/review.js";
import type { GateResult } from "../../src/gates/types.js";
import { validateGraph } from "../../src/graph/schema.js";
import * as gitModule from "../../src/run/git.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Queue row 142: typed operation facts, measured from `git diff --raw -z` and folded into the acceptance judge's
// changed map as line 0 — exercised through the production acceptanceGate with a FakeAdapter judge scripted with
// structured citations, and through the reader itself for the exact fact list.

afterEach(() => { vi.restoreAllMocks(); });

// each production gate call spawns git several times and the fake judge once; a test makes up to ~25 of them
const GATE_HEAVY_MS = 180_000;

const git = (repo: string, ...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const head = (repo: string): string => git(repo, "rev-parse", "HEAD").trim();

/** A repository at `base`, then one commit applying `change` (null deletes, a string writes), `after` on the files and
 * `index` on the staged index. */
function changed(base: Record<string, string>, change: Record<string, string | null>, after?: (repo: string) => void, index?: (repo: string) => void): { repo: string; base: string } {
  const repo = makeRepo(base);
  const baseRef = head(repo);
  for (const [path, content] of Object.entries(change)) {
    if (content === null) rmSync(join(repo, path));
    else { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  }
  after?.(repo);
  git(repo, "add", "-A");
  index?.(repo);
  git(repo, "commit", "-qm", "change", "--no-gpg-sign");
  return { repo, base: baseRef };
}

const move = (repo: string, from: string, to: string): void => {
  mkdirSync(dirname(join(repo, to)), { recursive: true });
  renameSync(join(repo, from), join(repo, to));
};

/** The production gate, judged by a FakeAdapter whose verdict cites exactly `citations` (one criterion each). */
async function judged(repo: string, base: string, citations: EvidenceCitation[]): Promise<GateResult> {
  const task = validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: citations.map((_, i) => `criterion ${i + 1}`) }],
  }).tasks[0]!;
  const scriptPath = join(makeTestTempDir("tickmarkr-facts-judge-"), "s.json");
  writeFileSync(scriptPath, JSON.stringify({ tasks: {}, judge: {
    pass: true,
    criteria: citations.map((evidence, i) => ({ criterion: `c${i + 1}`, met: true, reason: "cited", evidence })),
  } }));
  return acceptanceGate(task, repo, base, { adapter: new FakeAdapter(scriptPath), model: "fake-1" });
}

const line0 = (path: string): EvidenceCitation => ({ path, line: 0 });

async function expectCitable(repo: string, base: string, citation: EvidenceCitation): Promise<void> {
  const r = await judged(repo, base, [citation]);
  expect(r.pass, `${JSON.stringify(citation)}: ${r.details}`).toBe(true);
  expect(r.meta?.unparseable).toBeUndefined();
}

async function expectUnparseable(repo: string, base: string, citation: EvidenceCitation): Promise<void> {
  const r = await judged(repo, base, [citation]);
  expect(r.pass, JSON.stringify(citation)).toBe(false);
  expect(r.details, JSON.stringify(citation)).toMatch(/evidence absent from the judged diff/);
  expect(r.meta, JSON.stringify(citation)).toMatchObject({ unparseable: true });
}

async function factsOf(repo: string, base: string): Promise<OperationFact[]> {
  const read = await readOperationFacts(repo, base);
  if (!read.ok) throw new Error(`typed read failed: ${read.error}`);
  return [...read.facts].sort((a, b) => a.path.localeCompare(b.path));
}

describe("typed operation facts (queue row 142)", () => {
  test("through production acceptanceGate a diff made only of a pure rename or an empty new file or a 100644 to 100755 mode change passes a judge citing line 0 of the new or changed path versus line 0 of the rename source or a modified text file or an untouched path returning an unparseable verdict", async () => {
    const files = { "old.txt": "kept content\n", "run.sh": "echo hi\n", "bystander.txt": "untouched\n" };

    const renamed = changed(files, {}, (repo) => move(repo, "old.txt", "new.txt"));
    expect(await factsOf(renamed.repo, renamed.base)).toEqual([{ kind: "pure rename", path: "new.txt" }]);
    await expectCitable(renamed.repo, renamed.base, line0("new.txt"));
    await expectUnparseable(renamed.repo, renamed.base, line0("old.txt"));
    await expectUnparseable(renamed.repo, renamed.base, line0("bystander.txt"));

    const empty = changed(files, { "empty.txt": "" });
    expect(await factsOf(empty.repo, empty.base)).toEqual([{ kind: "empty add", path: "empty.txt" }]);
    await expectCitable(empty.repo, empty.base, line0("empty.txt"));
    await expectUnparseable(empty.repo, empty.base, line0("bystander.txt"));

    const mode = changed(files, {}, (repo) => chmodSync(join(repo, "run.sh"), 0o755));
    expect(git(mode.repo, "diff", "--raw", "--no-abbrev", `${mode.base}..HEAD`)).toMatch(/^:100644 100755 /);
    expect(await factsOf(mode.repo, mode.base)).toEqual([{ kind: "mode-only change", path: "run.sh" }]);
    await expectCitable(mode.repo, mode.base, line0("run.sh"));
    await expectUnparseable(mode.repo, mode.base, line0("bystander.txt"));

    const text = changed(files, { "bystander.txt": "untouched\nnow touched\n" });
    expect(await factsOf(text.repo, text.base)).toEqual([]);
    await expectCitable(text.repo, text.base, { path: "bystander.txt", line: 2 });
    await expectUnparseable(text.repo, text.base, line0("bystander.txt"));
  }, GATE_HEAVY_MS);

  test("a rename at 99 percent similarity and a pure rename that also changes mode and a deleted empty file and a binary modification and a binary add record no typed fact so line 0 of each returns an unparseable verdict versus a changed hunk line of the same 99 percent rename staying citable", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line number ${i + 1} of the long file`).join("\n") + "\n";
    const { repo, base } = changed(
      { "big.txt": big, "tool.sh": "echo tool\n", "gone-empty.txt": "", "blob.bin": "\0\u0001old" },
      { "gone-empty.txt": null, "blob.bin": "\0\u0002new", "new.bin": "\0\u0003added" },
      (r) => {
        move(r, "big.txt", "moved.txt");
        writeFileSync(join(r, "moved.txt"), big.replace("line number 100 of", "line number 100 OF"));
        move(r, "tool.sh", "tool2.sh");
        chmodSync(join(r, "tool2.sh"), 0o755);
      },
    );
    const raw = git(repo, "diff", "--raw", "--no-abbrev", "-M", `${base}..HEAD`);
    expect(raw).toMatch(/ R099\tbig\.txt\tmoved\.txt$/m);
    expect(raw).toMatch(/^:100644 100755 ([0-9a-f]{40}) \1 R100\ttool\.sh\ttool2\.sh$/m);
    expect(raw).toMatch(/ D\tgone-empty\.txt$/m);
    expect(await factsOf(repo, base)).toEqual([]);
    for (const path of ["moved.txt", "big.txt", "tool2.sh", "gone-empty.txt", "blob.bin", "new.bin"]) {
      await expectUnparseable(repo, base, line0(path));
    }
    await expectCitable(repo, base, { path: "moved.txt", line: 100 });
  }, GATE_HEAVY_MS);

  test("renamed and empty new files named with LF CR U+2028 U+2029 a space a colon a leading a/ or the words rename to keep their exact path as the fact under core.quotePath true and false while a rename to a name that is not valid UTF-8 made with git plumbing is no fact and never authorizes line 0 of a valid U+FFFD-named file beside it versus a valid rename in the same diff keeping its fact", async () => {
    const marks = ["\n", "\r", " ", " ", " ", ":"];
    const renamedTo = [...marks.map((m, i) => `r${m}${i}.txt`), "a/renamed.txt", "rename to r.txt"];
    const emptyAdds = [...marks.map((m, i) => `e${m}${i}.txt`), "a/empty.txt", "rename to e.txt"];
    const sources = Object.fromEntries(renamedTo.map((_, i) => [`src-${i}.txt`, `source ${i}\n`]));
    const replacement = "bad�.txt";
    for (const quotePath of ["true", "false"]) {
      const { repo, base } = changed(
        { ...sources, "c.txt": "valid rename\n", "src-bad.txt": "invalid destination\n", [replacement]: "one\n" },
        { ...Object.fromEntries(emptyAdds.map((path) => [path, ""])), [replacement]: "one\ntwo\n" },
        (r) => {
          renamedTo.forEach((to, i) => move(r, `src-${i}.txt`, to));
          move(r, "c.txt", "d.txt");
          rmSync(join(r, "src-bad.txt"));
        },
        (r) => {
          // a destination name that is not valid UTF-8 (byte 0xff) cannot exist on the file system: write it into the
          // index with plumbing, at the source's blob, so the raw diff records an exact R100 to it
          const blob = git(r, "rev-parse", "HEAD:src-bad.txt").trim();
          execFileSync("git", ["update-index", "--add", "-z", "--index-info"], {
            cwd: r, input: Buffer.concat([Buffer.from(`100644 ${blob}\tbad`), Buffer.from([0xff]), Buffer.from(".txt\0")]),
          });
        },
      );
      git(repo, "config", "core.quotePath", quotePath);
      const raw = execFileSync("git", ["diff", "--raw", "-z", "--no-abbrev", "-M", `${base}..HEAD`], { cwd: repo });
      expect(raw.includes(Buffer.concat([Buffer.from(" R100\0src-bad.txt\0bad"), Buffer.from([0xff]), Buffer.from(".txt\0")])), quotePath).toBe(true);
      const expected = [
        ...renamedTo.map((path) => ({ kind: "pure rename", path })),
        ...emptyAdds.map((path) => ({ kind: "empty add", path })),
        { kind: "pure rename", path: "d.txt" },
      ].sort((a, b) => a.path.localeCompare(b.path));
      expect(await factsOf(repo, base), quotePath).toEqual(expected);
      const r = await judged(repo, base, expected.map((fact) => line0(fact.path)));
      expect(r.pass, `quotePath ${quotePath}: ${r.details}`).toBe(true);
      await expectUnparseable(repo, base, line0(replacement));
      await expectCitable(repo, base, { path: replacement, line: 2 });
      await expectCitable(repo, base, line0("d.txt"));
    }
  }, GATE_HEAVY_MS);

  test("lines spelling rename from rename to new file mode old mode or new mode headers inside a modified or deleted file create no fact while a pure rename keeps its fact under a repository diff.renames false or diff.noprefix true and under an inherited environment override of diff.renames versus the same facts under the default configuration", async () => {
    const headers = [
      "diff --git a/victim-a.txt b/victim-b.txt", "similarity index 100%", "rename from victim-a.txt", "rename to victim-b.txt",
      "new file mode 100644", "old mode 100644", "new mode 100755", "",
    ].join("\n");
    const fixture = () => changed(
      { "notes.md": "intro\n", "doomed.md": headers, "victim-a.txt": "victim\n", "orig.txt": "pure rename\n" },
      { "notes.md": `intro\n${headers}`, "doomed.md": null },
      (r) => move(r, "orig.txt", "renamed.txt"),
    );
    const want = [{ kind: "pure rename", path: "renamed.txt" }];
    const forged = ["victim-a.txt", "victim-b.txt", "notes.md", "doomed.md", "orig.txt"];
    const check = async (repo: string, base: string, label: string) => {
      expect(await factsOf(repo, base), label).toEqual(want);
      await expectCitable(repo, base, line0("renamed.txt"));
      for (const path of forged) await expectUnparseable(repo, base, line0(path));
    };

    const plain = fixture();
    await check(plain.repo, plain.base, "default configuration");

    const renamesOff = fixture();
    git(renamesOff.repo, "config", "diff.renames", "false");
    expect(git(renamesOff.repo, "diff", "--raw", `${renamesOff.base}..HEAD`), "repository diff.renames false is in force").not.toMatch(/ R\d{3}\t/);
    await check(renamesOff.repo, renamesOff.base, "repository diff.renames false");

    const noPrefix = fixture();
    git(noPrefix.repo, "config", "diff.noprefix", "true");
    expect(git(noPrefix.repo, "diff", `${noPrefix.base}..HEAD`), "repository diff.noprefix true is in force").toContain("diff --git notes.md notes.md");
    await check(noPrefix.repo, noPrefix.base, "repository diff.noprefix true");

    const inherited = fixture();
    const override = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.renames", GIT_CONFIG_VALUE_0: "false" };
    expect(execFileSync("git", ["diff", "--raw", `${inherited.base}..HEAD`], { cwd: inherited.repo, encoding: "utf8", env: { ...process.env, ...override } }),
      "the inherited override is in force").not.toMatch(/ R\d{3}\t/);
    const saved = Object.fromEntries(Object.keys(override).map((key) => [key, process.env[key]]));
    Object.assign(process.env, override);
    try {
      await check(inherited.repo, inherited.base, "inherited GIT_CONFIG diff.renames false");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, GATE_HEAVY_MS);

  test("a git diff raw read that exits nonzero and a HEAD moved to another commit while the judged diff is read yield no typed fact without throwing versus the same diff read at a stable HEAD yielding its facts", async () => {
    const { repo, base } = changed({ "old.txt": "kept content\n", "other.txt": "x\n" }, {}, (r) => move(r, "old.txt", "new.txt"));
    const want = [{ kind: "pure rename", path: "new.txt" }];

    // stable HEAD: the read yields its fact, the recheck keeps it, and the gate accepts line 0
    const stable = await readOperationFacts(repo, base);
    expect(stable).toEqual({ ok: true, commit: head(repo), facts: want });
    expect(await operationFactsAtHead(repo, stable)).toEqual(want);
    await expectCitable(repo, base, line0("new.txt"));

    // a real nonzero read (an unresolvable base) is a result, never a throw
    await expect(readOperationFacts(repo, "no-such-base-ref")).resolves.toMatchObject({ ok: false });

    // the raw read exits nonzero, or is killed, inside the production gate: no fact, so line 0 is fabricated
    const realShGit = gitModule.shGit;
    for (const failed of [{ code: 128, stdout: "", stderr: "fatal: forced", stdoutBytes: Buffer.alloc(0) },
      { code: 1, signalExit: true, stdout: "", stderr: "", stdoutBytes: Buffer.from(":100644 100644") }]) {
      const spy = vi.spyOn(gitModule, "shGit").mockImplementation((cmd, ...rest) =>
        cmd.startsWith("git diff --raw") ? Promise.resolve(failed) : realShGit(cmd, ...rest));
      await expect(readOperationFacts(repo, base)).resolves.toMatchObject({ ok: false });
      await expectUnparseable(repo, base, line0("new.txt"));
      expect(spy.mock.calls.some(([cmd]) => cmd.startsWith("git diff --raw -z --no-abbrev -M "))).toBe(true);
      spy.mockRestore();
    }

    // HEAD moves to another commit after the judged diff is read: the facts no longer bind it
    const moved = await readOperationFacts(repo, base);
    git(repo, "commit", "-q", "--allow-empty", "-m", "moved", "--no-gpg-sign");
    expect(await operationFactsAtHead(repo, moved)).toEqual([]);
    git(repo, "reset", "-q", "--hard", "HEAD~1");

    const realFetch = review.fetchTaskDiff;
    vi.spyOn(review, "fetchTaskDiff").mockImplementation(async (...args) => {
      const measured = await realFetch(...args);
      git(repo, "commit", "-q", "--allow-empty", "-m", "moved while judged", "--no-gpg-sign");
      return measured;
    });
    await expectUnparseable(repo, base, line0("new.txt"));
    vi.restoreAllMocks();
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    await expectCitable(repo, base, line0("new.txt"));
  }, GATE_HEAVY_MS);
});
