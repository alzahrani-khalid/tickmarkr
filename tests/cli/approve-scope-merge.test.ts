import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { loadConfig } from "../../src/config/config.js";
import { graphDefinitionHash, loadGraph } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { integrationBranch } from "../../src/run/merge.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Seed {
  repo: string;
  journal: Journal;
  /** The integration branch the run reads: config-derived for a legacy run, run-start's record for a marked one. */
  integration: string;
  base: string;
  /** The sibling's real merge commit on the integration branch. */
  merge: string;
  hash: string;
  graphPath: string;
  journalPath: string;
}

/**
 * A scratch run with a REAL merge commit: `sibling-work` carries needed.txt, merged --no-ff into the
 * integration branch. The requester's task branch (`<integration>--<taskId>`) is placed at the merge
 * (merged sibling) or the pre-merge base (branched before the merge), or left absent. A marked run
 * records an integration branch the configured prefix no longer names and can plant a decoy
 * config-derived task ref at the other position.
 */
function seedScopeRun(opts: {
  runId: string;
  tasks?: unknown[];
  marked?: boolean;
  requesterAt?: "merge" | "base" | "absent";
  configRefAt?: "merge" | "base" | "absent";
  taskBranches?: Array<{ taskId: string; at: "merge" | "base" }>;
}): Seed {
  const tasks = opts.tasks ?? [T("T1", { files: ["owned.txt"] }), T("T2", { files: ["needed.txt"] })];
  const { repo } = setupRepo(tasks, { tasks: {} });
  const hash = graphDefinitionHash(loadGraph(repo));
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "sibling-work");
  writeFileSync(join(repo, "needed.txt"), "sibling work\n");
  git(repo, "add", "needed.txt");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "sibling work");
  const integration = opts.marked ? "recorded/integration" : integrationBranch(loadConfig(repo), opts.runId);
  git(repo, "checkout", "-q", "-b", integration, base);
  git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge T2", "sibling-work");
  const merge = git(repo, "rev-parse", "HEAD");
  const at = (where: "merge" | "base") => (where === "merge" ? merge : base);
  if (opts.requesterAt !== undefined && opts.requesterAt !== "absent") {
    git(repo, "branch", `${integration}--T1`, at(opts.requesterAt));
  }
  if (opts.marked && opts.configRefAt !== undefined && opts.configRefAt !== "absent") {
    git(repo, "branch", `${integrationBranch(loadConfig(repo), opts.runId)}--T1`, at(opts.configRefAt));
  }
  for (const extra of opts.taskBranches ?? []) git(repo, "branch", `${integration}--${extra.taskId}`, at(extra.at));
  const journal = Journal.create(repo, opts.runId);
  journal.append("run-start", undefined, {
    graphDefinitionHash: hash,
    ...(opts.marked ? { integrationAnchor: "journal", branch: integration, baseRef: base } : {}),
  });
  return {
    repo, journal, integration, base, merge, hash,
    graphPath: join(repo, ".tickmarkr", "graph.json"),
    journalPath: join(journal.dir, "journal.jsonl"),
  };
}

/** The requester's scope-request park for needed.txt, exactly as the daemon journals it. */
function parkRequester(seed: Seed, taskId = "T1", path = "needed.txt", hash = seed.hash): void {
  seed.journal.append("task-human", taskId, { kind: "scope-request", paths: [path], graphDefinitionHash: hash });
}

/** The sibling done and merged: the daemon's task-done then merge row pair. */
function doneMerged(seed: Seed, taskId = "T2", commit = seed.merge): void {
  seed.journal.append("task-done", taskId, {});
  seed.journal.append("merge", taskId, { branch: `${seed.integration}--${taskId}`, commit, from: seed.base });
}

/** The refusal keeps the journal and the graph byte-identical. */
async function expectRefused(seed: Seed, text: string, argv: string[]): Promise<void> {
  const beforeGraph = readFileSync(seed.graphPath, "utf8");
  const beforeJournal = readFileSync(seed.journalPath, "utf8");
  await expect(approve(argv, seed.repo)).rejects.toThrow(text);
  expect(readFileSync(seed.journalPath, "utf8")).toBe(beforeJournal);
  expect(readFileSync(seed.graphPath, "utf8")).toBe(beforeGraph);
}

test("test: a scope-request grant whose requested path is shared with a sibling done in this run, whose recorded merge commit is an ancestor of the requester's task branch, is approved with one scope-request approval carrying the amended files, while the same grant whose requester branched before that merge is refused with the overlap text and the journal and graph unchanged, both in a legacy run and in a marked run whose run-start records an integration branch the configured prefix no longer names, its task branch read from that record and a config-derived task ref at the other position ignored, so a guard that reads the sibling's status alone or derives the branch from config fails", async () => {
  for (const mode of ["legacy", "marked"] as const) {
    const marked = mode === "marked";
    // G1: the sibling's merge is an ancestor of the requester's task branch — granted. The marked
    // run plants the config-derived task ref BEFORE the merge: a guard deriving the branch from
    // config reads the wrong ref and refuses this grant.
    const granted = seedScopeRun({ runId: `run-scope-merge-g1-${mode}`, marked, requesterAt: "merge", configRefAt: "base" });
    doneMerged(granted);
    parkRequester(granted);

    const out = await approve([granted.journal.runId, "T1", "--files", "needed.txt"], granted.repo);

    expect(out).toContain("approved files[] for T1");
    const approvals = granted.journal.read().filter((e) => e.event === "task-approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.data).toMatchObject({
      release: "scope-request",
      amendment: { beforeFiles: ["owned.txt"], files: ["owned.txt", "needed.txt"] },
    });
    expect(loadGraph(granted.repo).tasks.find((t) => t.id === "T1")!.files).toEqual(["owned.txt", "needed.txt"]);

    // R5: the requester branched before that merge — refused. The marked run plants the
    // config-derived task ref AFTER the merge: a config-deriving guard wrongly grants here.
    const refused = seedScopeRun({ runId: `run-scope-merge-r5-${mode}`, marked, requesterAt: "base", configRefAt: "merge" });
    doneMerged(refused);
    parkRequester(refused);

    await expectRefused(refused, "T1 and T2 both write needed.txt", [refused.journal.runId, "T1", "--files", "needed.txt"]);
    expect(refused.journal.replayStatuses().get("T1")).toBe("human");
  }
});

test("test: the same shared-path grant is refused with the journal and graph unchanged when the sibling is running, was never dispatched, is parked or has failed, or was done and merged into the requester's branch and since then redispatched, parked, failed or released pending by an approval, so a guard that exempts a sibling whose current replayed status is not done fails", async () => {
  const variants: Array<{ name: string; rows: (seed: Seed) => void }> = [
    { name: "running", rows: (s) => { s.journal.append("task-dispatch", "T2", { attempt: 1, files: ["needed.txt"] }); } },
    { name: "never-dispatched", rows: () => undefined },
    { name: "parked", rows: (s) => { s.journal.append("task-human", "T2", { kind: "human-gate", reason: "waits" }); } },
    { name: "failed", rows: (s) => { s.journal.append("task-failed", "T2", { reason: "gates" }); } },
    { name: "done-then-redispatched", rows: (s) => { doneMerged(s); s.journal.append("task-dispatch", "T2", { attempt: 2, files: ["needed.txt"] }); } },
    { name: "done-then-parked", rows: (s) => { doneMerged(s); s.journal.append("task-human", "T2", { kind: "human-gate", reason: "waits" }); } },
    { name: "done-then-failed", rows: (s) => { doneMerged(s); s.journal.append("task-failed", "T2", { reason: "gates" }); } },
    {
      name: "done-then-released-pending",
      rows: (s) => {
        doneMerged(s);
        s.journal.append("task-human", "T2", { kind: "human-gate", reason: "waits" });
        s.journal.append("task-approved", "T2", { by: "operator", via: "cli", park: s.journal.newestBinding("T2") });
      },
    },
  ];
  for (const variant of variants) {
    // The merge and the requester branch always line up: the sibling's current replayed status is
    // the ONLY failing condition in every variant.
    const seed = seedScopeRun({ runId: `run-scope-merge-status-${variant.name}`, requesterAt: "merge" });
    variant.rows(seed);
    parkRequester(seed);
    if (variant.name === "done-then-released-pending") {
      expect(seed.journal.replayStatuses().get("T2")).toBe("pending");
    }
    await expectRefused(seed, "T1 and T2 both write needed.txt", [seed.journal.runId, "T1", "--files", "needed.txt"]);
  }
});

test("test: a done sibling earns no exemption when the run journals no merge for it, when its newest merge names a value that is not a full object id or a commit the repository lacks, when an older merge inside the requester's branch is followed by a newer merge outside it or not a full object id, or when the requester's task branch is absent, each refused with the journal and graph unchanged, so an exemption that trusts a done status or an older merge fails", async () => {
  // R6: done, but the run journals no merge for the sibling.
  const noMerge = seedScopeRun({ runId: "run-scope-merge-no-row", requesterAt: "merge" });
  noMerge.journal.append("task-done", "T2", {});
  parkRequester(noMerge);
  await expectRefused(noMerge, "T1 and T2 both write needed.txt", [noMerge.journal.runId, "T1", "--files", "needed.txt"]);

  // R7: the newest merge row names a value that is not a full lowercase object id…
  for (const [name, value] of [["short-id", "abc123"], ["uppercase", "A".repeat(40)], ["ref-name", "refs/heads/sibling-work"]] as const) {
    const seed = seedScopeRun({ runId: `run-scope-merge-bad-id-${name}`, requesterAt: "merge" });
    doneMerged(seed, "T2", value);
    parkRequester(seed);
    await expectRefused(seed, "T1 and T2 both write needed.txt", [seed.journal.runId, "T1", "--files", "needed.txt"]);
  }
  // …or a full object id the repository lacks.
  const missing = seedScopeRun({ runId: "run-scope-merge-missing-commit", requesterAt: "merge" });
  doneMerged(missing, "T2", "1".repeat(40));
  parkRequester(missing);
  await expectRefused(missing, "T1 and T2 both write needed.txt", [missing.journal.runId, "T1", "--files", "needed.txt"]);

  // R7: an older merge inside the requester's branch followed by a newer merge outside it.
  const newerOutside = seedScopeRun({ runId: "run-scope-merge-newer-outside", requesterAt: "merge" });
  const firstMerge = newerOutside.merge;
  git(newerOutside.repo, "checkout", "-q", "-b", "sibling-work-2", firstMerge);
  writeFileSync(join(newerOutside.repo, "more.txt"), "more\n");
  git(newerOutside.repo, "add", "more.txt");
  git(newerOutside.repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "more sibling work");
  git(newerOutside.repo, "checkout", "-q", newerOutside.integration);
  git(newerOutside.repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge T2 again", "sibling-work-2");
  const secondMerge = git(newerOutside.repo, "rev-parse", "HEAD");
  newerOutside.journal.append("task-done", "T2", {});
  newerOutside.journal.append("merge", "T2", { branch: `${newerOutside.integration}--T2`, commit: firstMerge, from: newerOutside.base });
  newerOutside.journal.append("merge", "T2", { branch: `${newerOutside.integration}--T2`, commit: secondMerge, from: firstMerge });
  parkRequester(newerOutside);
  await expectRefused(newerOutside, "T1 and T2 both write needed.txt", [newerOutside.journal.runId, "T1", "--files", "needed.txt"]);

  // R7: an older merge inside the requester's branch followed by a newer merge row that is not a full object id.
  const newerBadId = seedScopeRun({ runId: "run-scope-merge-newer-bad-id", requesterAt: "merge" });
  newerBadId.journal.append("task-done", "T2", {});
  newerBadId.journal.append("merge", "T2", { branch: `${newerBadId.integration}--T2`, commit: newerBadId.merge, from: newerBadId.base });
  newerBadId.journal.append("merge", "T2", { branch: `${newerBadId.integration}--T2`, commit: "not-an-object-id", from: newerBadId.merge });
  parkRequester(newerBadId);
  await expectRefused(newerBadId, "T1 and T2 both write needed.txt", [newerBadId.journal.runId, "T1", "--files", "needed.txt"]);

  // R8: done and merged, but the requester's task branch is absent.
  const noBranch = seedScopeRun({ runId: "run-scope-merge-no-branch", requesterAt: "absent" });
  doneMerged(noBranch);
  parkRequester(noBranch);
  await expectRefused(noBranch, "T1 and T2 both write needed.txt", [noBranch.journal.runId, "T1", "--files", "needed.txt"]);
});

test("test: with two siblings sharing the requested path the grant is refused naming only the running one when the other is done and merged into the requester's branch, and after an approved grant that leaves the requester sharing a path with its done and merged sibling, a later grant to a third task whose branch predates that merge and that shares no path is approved with the earlier overlap still in its files, so a guard that re-judges the earlier exempt pair or filters exempt siblings against the later requester fails", async () => {
  // M1: T2 is done and merged into T1's branch (exempt); T3 is running. Only the T1–T3 pair is named.
  const mixed = seedScopeRun({
    runId: "run-scope-merge-two-siblings",
    tasks: [T("T1", { files: ["owned.txt"] }), T("T2", { files: ["needed.txt"] }), T("T3", { files: ["needed.txt"] })],
    requesterAt: "merge",
  });
  doneMerged(mixed);
  mixed.journal.append("task-dispatch", "T3", { attempt: 1, files: ["needed.txt"] });
  parkRequester(mixed);
  const beforeGraph = readFileSync(mixed.graphPath, "utf8");
  const beforeJournal = readFileSync(mixed.journalPath, "utf8");
  const refusal = await approve([mixed.journal.runId, "T1", "--files", "needed.txt"], mixed.repo).then(
    () => { throw new Error("expected a refusal"); },
    (error: unknown) => String(error),
  );
  expect(refusal).toContain("T1 and T3 both write needed.txt");
  expect(refusal).not.toContain("T1 and T2");
  expect(refusal).not.toContain("T2 and T3");
  expect(readFileSync(mixed.journalPath, "utf8")).toBe(beforeJournal);
  expect(readFileSync(mixed.graphPath, "utf8")).toBe(beforeGraph);

  // G2: after T1's grant leaves it sharing needed.txt with its done and merged sibling, T3's grant
  // — its branch predating the merge, its requested path shared with nobody — is approved with the
  // earlier overlap still in T1's files.
  const later = seedScopeRun({
    runId: "run-scope-merge-third-task",
    tasks: [T("T1", { files: ["owned.txt"] }), T("T2", { files: ["needed.txt"] }), T("T3", { files: ["third.txt"] })],
    requesterAt: "merge",
    taskBranches: [{ taskId: "T3", at: "base" }],
  });
  doneMerged(later);
  parkRequester(later);
  await approve([later.journal.runId, "T1", "--files", "needed.txt"], later.repo);
  expect(loadGraph(later.repo).tasks.find((t) => t.id === "T1")!.files).toEqual(["owned.txt", "needed.txt"]);

  const amendedHash = graphDefinitionHash(loadGraph(later.repo));
  parkRequester(later, "T3", "extra.txt", amendedHash);
  await approve([later.journal.runId, "T3", "--files", "extra.txt"], later.repo);

  const approvals = later.journal.read().filter((e) => e.event === "task-approved");
  expect(approvals.map((e) => e.taskId)).toEqual(["T1", "T3"]);
  expect(approvals[1]!.data).toMatchObject({ release: "scope-request", amendment: { files: ["third.txt", "extra.txt"] } });
  const graph = loadGraph(later.repo);
  expect(graph.tasks.find((t) => t.id === "T1")!.files).toEqual(["owned.txt", "needed.txt"]);
  expect(graph.tasks.find((t) => t.id === "T2")!.files).toEqual(["needed.txt"]);
  expect(graph.tasks.find((t) => t.id === "T3")!.files).toEqual(["third.txt", "extra.txt"]);
});
