import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { verify } from "../../src/cli/commands/verify.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  captureOwedCheck, foldOwedChecks, GATE_SATISFIED_RELEASE, Journal, type JournalEvent,
  OWED_DISCHARGE_EVENT, owedSubject, supersedeContainment,
} from "../../src/run/journal.js";
import { makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

beforeEach(() => {
  // Exercise the helper's forced value even when the caller explicitly permits lazy fetching.
  vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});
afterEach(() => vi.unstubAllEnvs());

const rawEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.GIT_CONFIG_PARAMETERS;
  return env;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd, encoding: "utf8", env: rawEnv(), stdio: ["ignore", "pipe", "pipe"],
}).trim();
const read = (path: string): string => existsSync(path) ? readFileSync(path, "utf8") : "";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
// Listing only objects already on disk cannot fetch a missing promisor object.
const localObjects = (repo: string): string[] => git(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split("\n");
const baseText = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";

// Model the genuine integration proof in git-trust.test.ts: both parents edit distant lines of
// a.txt, so merge-tree must read its blobs, rather than proving a trivial tree-only merge.
const fixture = () => {
  const origin = makeRepo({ "a.txt": baseText });
  const scratch = makeTestTempDir("owed-lazy-fetch-");
  const commit = (message: string) => git(origin, "commit", "-q", "--no-gpg-sign", "-am", message);
  const base = git(origin, "rev-parse", "HEAD");
  const baseBlob = git(origin, "rev-parse", `${base}:a.txt`);
  git(origin, "checkout", "-q", "-b", "task");
  writeFileSync(join(origin, "a.txt"), "one\n2\n3\n4\n5\n6\n7\n8\n9\n");
  commit("task");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  writeFileSync(join(origin, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\nnine\n");
  commit("sibling");
  const mergeBase = git(origin, "rev-parse", "HEAD");
  git(origin, "merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge task", head);
  const merged = git(origin, "rev-parse", "HEAD");
  git(origin, "config", "uploadpack.allowFilter", "true");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");

  const events: JournalEvent[] = [
    { ts: "2026-10-27T00:00:00.000Z", event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "codex", model: "m" } } },
    { ts: "2026-10-27T00:00:01.000Z", event: "gate-result", taskId: "T1", data: { gate: "acceptance", pass: false, commit: owedSubject(origin, base, head) } },
  ];
  const capture = {
    cwd: origin, runId: "run-287", taskId: "T1", gate: "acceptance" as const, cause: "queue row 287",
    acceptance: ["a"], files: ["a.txt"], declared: [{ key: "codex:m", vendor: "openai" }],
    taskRef: head, integrationRef: base, events,
  };
  const obligation = captureOwedCheck(capture);
  expect(obligation.known).toBe(true);
  const artifactPath = join(scratch, "verify.json");
  writeFileSync(artifactPath, JSON.stringify({
    head: merged, mergeBase, green: true, criteria: obligation.criteria, files: obligation.files,
    gateRows: [{ gate: "acceptance", pass: true }],
  }));
  const folded: JournalEvent[] = [...events,
    { ts: "2026-10-27T00:00:02.000Z", event: "task-approved", taskId: "T1", data: { release: GATE_SATISFIED_RELEASE, gate: "acceptance", obligation } },
    { ts: "2026-10-27T00:00:03.000Z", event: "merge", taskId: "T1", data: { commit: merged } },
    { ts: "2026-10-27T00:00:03.500Z", event: "task-done", taskId: "T1", data: {} },
    { ts: "2026-10-27T00:00:04.000Z", event: OWED_DISCHARGE_EVENT, taskId: "T1", data: {
      ids: [obligation.id], mapping: "integration", mergeBase, head: merged, criteria: obligation.criteria,
      artifactPath, artifactSha256: createHash("sha256").update(readFileSync(artifactPath)).digest("hex"),
    } },
  ];

  const clone = (name: string, blobless = true, extra: string[] = []) => {
    const repo = join(scratch, name);
    git(scratch, "clone", "-q", "--no-checkout", ...(blobless ? ["--filter=blob:none"] : []), ...extra, pathToFileURL(origin).href, repo);
    const witness = join(scratch, `${name}.witness`);
    const uploadPack = join(scratch, `${name}-upload-pack`);
    writeFileSync(uploadPack, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(witness)}\nexec git upload-pack "$@"\n`, { mode: 0o755 });
    git(repo, "config", "remote.origin.uploadpack", quote(uploadPack));
    if (blobless) {
      expect(git(repo, "config", "remote.origin.promisor")).toBe("true");
      expect(git(repo, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
      expect(localObjects(repo)).not.toContain(baseBlob);
    }
    return { repo, witness };
  };
  return { origin, base, baseBlob, head, capture, obligation, folded, clone };
};

test("test: in a blobless clone whose integration re-proof needs a never-fetched blob, the owed fold runs no transport against the promisor remote and leaves the check undischarged, while an explicit lazy read in the same clone is recorded by the upload-pack witness, so a status read that fetches fails", () => {
  const f = fixture();
  const partial = f.clone("missing");
  const fold = foldOwedChecks(f.folded, partial.repo);
  expect(read(partial.witness)).toBe("");
  expect(fold).toMatchObject({
    known: false, debt: "unknown", outstanding: [f.obligation], discharged: [],
    unknown: [{ taskId: "T1", reason: "discharge range does not bind the obligation" }],
  });
  expect(localObjects(partial.repo)).not.toContain(f.baseBlob);

  // Positive transport control in this very clone: the remote is reachable and the witness works.
  expect(git(partial.repo, "cat-file", "blob", f.baseBlob)).toBe(baseText.trim());
  expect(read(partial.witness)).toContain(f.origin);
  expect(localObjects(partial.repo)).toContain(f.baseBlob);
});

test("test: the owed fold still proves a genuine integration discharge in a full clone and in an object-complete blobless clone of the same history, so a lazy-fetch switch that disables the proof fails", () => {
  const f = fixture();
  const full = f.clone("full", false);
  const partial = f.clone("complete");
  // Deliberately materialize every blob before the read under test; keep the clone's promisor/filter config.
  const blobs = git(f.origin, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")
    .split("\n").filter((row) => row.endsWith(" blob")).map((row) => row.split(" ")[0]!);
  for (const blob of blobs) git(partial.repo, "cat-file", "blob", blob);
  expect(read(partial.witness)).toContain(f.origin);
  rmSync(partial.witness);
  expect(localObjects(partial.repo)).toEqual(expect.arrayContaining(blobs));
  expect(git(partial.repo, "config", "remote.origin.promisor")).toBe("true");
  expect(git(partial.repo, "config", "remote.origin.partialclonefilter")).toBe("blob:none");

  const proved = foldOwedChecks(f.folded, full.repo);
  expect(proved).toMatchObject({ known: true, debt: 0, outstanding: [], discharged: [f.obligation.id], unknown: [] });
  expect(foldOwedChecks(f.folded, partial.repo)).toEqual(proved);
  expect(read(full.witness)).toBe("");
  expect(read(partial.witness)).toBe("");
});

test("test: the owed-check capture in a blobless clone needing a never-fetched blob runs no transport and records the obligation as unknown naming the failed git command, so a capture that fetches fails", () => {
  const f = fixture();
  const partial = f.clone("capture");
  const obligation = captureOwedCheck({ ...f.capture, cwd: partial.repo });
  expect(read(partial.witness)).toBe("");
  expect(localObjects(partial.repo)).not.toContain(f.baseBlob);
  expect(obligation).toMatchObject({ known: false, base: f.base, head: f.head, subject: f.obligation.subject });
  expect(obligation.unknownReason).toMatch(/^Command failed: git /);
  expect(obligation.unknownReason).toContain(`show --no-ext-diff --no-textconv --format= --binary ${f.head}`);
});

// Queue row 339 / D-2181 D5: a supersede's containment reads only commits, through the same no-lazy-fetch seam.
test("test: a supersede containment proof in a blobless clone missing the fixing commit runs no transport and reads unreadable history, while an explicit lazy read in the same clone fetches it and the proof then holds", () => {
  const f = fixture();
  const partial = f.clone("supersede");
  // The fixing commit lands on the origin after the clone, on top of the owed head.
  git(f.origin, "checkout", "-q", "--detach", f.head);
  writeFileSync(join(f.origin, "a.txt"), "one\n2\n3\n4\n5\n6\n7\n8\n9\nfix\n");
  git(f.origin, "commit", "-q", "--no-gpg-sign", "-am", "fix");
  const fixHead = git(f.origin, "rev-parse", "HEAD");
  git(f.origin, "checkout", "-q", "main");
  expect(supersedeContainment(partial.repo, f.obligation, f.base, fixHead)).toMatchObject({ ok: false, unreadable: true });
  expect(read(partial.witness)).toBe("");
  expect(localObjects(partial.repo)).not.toContain(fixHead);
  // Endpoint equality on objects the clone holds proves without any transport.
  expect(supersedeContainment(partial.repo, f.obligation, f.base, f.head)).toEqual({ ok: true });
  expect(read(partial.witness)).toBe("");

  // Positive transport control in this very clone: an explicit lazy read fetches the commit, then containment holds.
  expect(git(partial.repo, "cat-file", "-t", fixHead)).toBe("commit");
  expect(read(partial.witness)).toContain(f.origin);
  expect(supersedeContainment(partial.repo, f.obligation, f.base, fixHead)).toEqual({ ok: true });
});

type Fixture = ReturnType<typeof fixture>;
/** The run's journal (the outstanding obligation) and its compiled task, seeded into a clone; returns the journal path. */
const seedRun = (f: Fixture, repo: string): string => {
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["a.txt"], acceptance: ["a"] })] }));
  const journal = Journal.create(repo, f.obligation.runId);
  // The waive, enacted by its merge and done rows; the discharge row is left out.
  for (const e of f.folded.slice(0, 5)) journal.append(e.event, e.taskId, e.data);
  expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: true, debt: 1 });
  return join(journal.dir, "journal.jsonl");
};
const supersedeArgv = (f: Fixture, base: string) => ["--record", f.obligation.runId, "--task", "T1", "--base", base, "--supersede", f.obligation.id, "--author", "human"];
/** A commit the origin gains on top of `from`, left unreferenced so no clone ever fetches it. */
const originCommit = (f: Fixture, from: string, text: string): string => {
  git(f.origin, "checkout", "-q", "--detach", from);
  writeFileSync(join(f.origin, "a.txt"), text);
  git(f.origin, "commit", "-q", "--no-gpg-sign", "-am", text.trim());
  const id = git(f.origin, "rev-parse", "HEAD");
  git(f.origin, "checkout", "-q", "main");
  return id;
};

// Queue row 339 / D-2181 D5: the supersede COMMAND measures its range through the same no-lazy-fetch seam, before
// containment: an object the clone lacks is unreadable history, never a transport.
test("test: verify --supersede in a blobless clone given a never-fetched base commit, and in a shallow blobless clone missing the owed base, runs no transport, refuses naming unreadable history and leaves the run journal byte identical, while an explicit lazy read in the same clone fetches", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fixture();
  const refusedUnreadable = async (repo: string, base: string, journalPath: string) => {
    const before = readFileSync(journalPath);
    const result = await verify(supersedeArgv(f, base), repo);
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain("verify --supersede refused: unreadable history (git merge-base exit");
    expect(readFileSync(journalPath)).toEqual(before);
  };

  // A base commit the origin gained after the clone.
  const unfetched = originCommit(f, f.base, "unfetched\n");
  const partial = f.clone("command-unfetched");
  await refusedUnreadable(partial.repo, unfetched, seedRun(f, partial.repo));
  expect(read(partial.witness)).toBe("");
  expect(localObjects(partial.repo)).not.toContain(unfetched);

  // A shallow blobless clone holding only the integration tip: the owed base lies past its boundary.
  const shallow = f.clone("command-shallow", true, ["--depth", "1"]);
  expect(localObjects(shallow.repo)).not.toContain(f.base);
  await refusedUnreadable(shallow.repo, f.base, seedRun(f, shallow.repo));
  expect(read(shallow.witness)).toBe("");
  expect(localObjects(shallow.repo)).not.toContain(f.base);

  // Positive transport control in the first clone: an explicit lazy read fetches the never-fetched commit.
  expect(git(partial.repo, "cat-file", "-t", unfetched)).toBe("commit");
  expect(read(partial.witness)).toContain(f.origin);
  errors.mockRestore();
}, 60_000);

// Queue row 339 / D-2181 D5 (D-2184 add.51): EVERY git read a supersede makes — rev-parse, the HEAD reflog witness,
// merge-base, containment — runs through verify's one no-lazy-fetch seam, so a never-fetched commit that HEAD or its
// reflog names is unreadable history: never a transport, never a later dirty-worktree message.
test("test: verify --supersede in a blobless clone whose HEAD or HEAD reflog names a never-fetched commit runs no transport across the whole command and refuses naming unreadable history never a dirty worktree in plain and JSON output with the run journal byte identical", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fixture();
  const fixHead = originCommit(f, f.head, "one\n2\n3\n4\n5\n6\n7\n8\n9\nfix\n");
  const stray = originCommit(f, f.base, "stray\n");
  const unfetchedBase = originCommit(f, f.base, "unfetched base\n");
  const refusedUnreadable = async (repo: string, base: string, journalPath: string, read: RegExp) => {
    for (const json of [false, true]) {
      const before = readFileSync(journalPath);
      const result = await verify([...supersedeArgv(f, base), ...(json ? ["--json"] : [])], repo);
      expect(result.code, result.out).toBe(2);
      expect(result.out).not.toMatch(/dirty/);
      if (json) {
        expect(JSON.parse(result.out)).toMatchObject({ owed: { debt: 1, discharged: [], superseded: [], refused: expect.stringMatching(read) } });
      } else {
        expect(result.out.split("\n")[0]).toMatch(new RegExp(`^verify --supersede refused: ${read.source.slice(1)}`));
      }
      expect(readFileSync(journalPath)).toEqual(before);
    }
  };

  // HEAD names the never-fetched fixing commit, as a checkout of it records: a detached HEAD and its reflog entry.
  const headClone = f.clone("head-unfetched");
  const headJournal = seedRun(f, headClone.repo);
  const tip = git(headClone.repo, "rev-parse", "HEAD");
  writeFileSync(join(headClone.repo, ".git", "HEAD"), `${fixHead}\n`);
  appendFileSync(join(headClone.repo, ".git", "logs", "HEAD"), `${tip} ${fixHead} t <t@t> 1700000000 +0000\tcheckout: moving to ${fixHead}\n`);
  await refusedUnreadable(headClone.repo, f.base, headJournal, /^unreadable history \(git reflog exit [1-9]/);
  expect(read(headClone.witness)).toBe("");
  expect(localObjects(headClone.repo)).not.toContain(fixHead);

  // HEAD stays readable while an OLDER entry of its reflog names a never-fetched commit (moved there and back): the
  // witness reads it with no transport, and the command runs on to the never-fetched base's unreadable merge-base.
  const reflogClone = f.clone("reflog-unfetched");
  const reflogJournal = seedRun(f, reflogClone.repo);
  const main = git(reflogClone.repo, "rev-parse", "HEAD");
  appendFileSync(join(reflogClone.repo, ".git", "logs", "HEAD"), `${main} ${stray} t <t@t> 1700000001 +0000\tcheckout: moving to ${stray}\n`
    + `${stray} ${main} t <t@t> 1700000002 +0000\tcheckout: moving to main\n`);
  await refusedUnreadable(reflogClone.repo, unfetchedBase, reflogJournal, /^unreadable history \(git merge-base exit [1-9]/);
  expect(read(reflogClone.witness)).toBe("");
  expect(localObjects(reflogClone.repo)).not.toContain(stray);
  expect(localObjects(reflogClone.repo)).not.toContain(unfetchedBase);

  // Positive transport control in the first clone: an explicit lazy read fetches the never-fetched fixing commit.
  expect(git(headClone.repo, "cat-file", "-t", fixHead)).toBe("commit");
  expect(read(headClone.witness)).toContain(f.origin);
  errors.mockRestore();
}, 60_000);
