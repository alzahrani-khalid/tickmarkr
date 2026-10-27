import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  captureOwedCheck, foldOwedChecks, GATE_SATISFIED_RELEASE, type JournalEvent,
  OWED_DISCHARGE_EVENT, owedSubject,
} from "../../src/run/journal.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

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

  const clone = (name: string, blobless = true) => {
    const repo = join(scratch, name);
    git(scratch, "clone", "-q", "--no-checkout", ...(blobless ? ["--filter=blob:none"] : []), pathToFileURL(origin).href, repo);
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
