import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { commandHelp } from "../../src/cli/help.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { filesGlob } from "../../src/graph/files-glob.js";
import { graphDefinitionHash, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { runDaemon } from "../../src/run/daemon.js";
import { applyScopeAmendments, effectiveEvents, Journal, recordedGraphDefinitionHash, replayScopeAmendments } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const hinted = "tests/pin.test.ts";
const sibling = "tests/sibling.test.ts";
const owned = "src/pin.ts";
const assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
const bytes = (j: Journal) => readFileSync(join(j.dir, "journal.jsonl"), "utf8");
const approvals = (j: Journal) => j.read().filter((e) => e.event === "task-approved");

function seed(hint: string[] | null = [hinted], kind = "gate-fail", files = [owned], acceptance = ["done"]) {
  const { repo } = setupRepo([T("T1", { files, acceptance })], { tasks: {} });
  const graph = loadGraph(repo);
  const journal = Journal.create(repo, "run-files-hint");
  journal.append("run-start", undefined, { graphDefinitionHash: graphDefinitionHash(graph) });
  journal.append("task-dispatch", "T1", { assignment, attempt: 0 });
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "blocking bug" });
  journal.append("task-human", "T1", {
    kind, reason: `review round cap — files[] repair hint: ${hinted}`,
    ...(hint === null ? {} : { repairHint: hint }),
  });
  return { repo, journal, graph };
}

async function daemonPark(runId: string) {
  const fixture = setupRepo([T("T1", {
    complexity: 8, files: [owned], acceptance: [{ oracle: "command", command: "true" }],
    routingHints: { pin: { via: "fake", model: "fake-1" } },
  })], {
    review: { approve: false, findings: [{ note: "blocking bug", severity: "material" }] },
    // This summary names a repair without claiming an out-of-scope refusal. The existing
    // repair-disposition route for an explicit scope refusal remains a scope-request.
    tasks: { T1: [{ shell: `echo v >> ${owned} && ${COMMIT} v`, result: { ok: false, summary: `Repair ${hinted}` } }] },
  });
  mkdirSync(join(fixture.repo, "src"));
  mkdirSync(join(fixture.repo, "tests"));
  writeFileSync(join(fixture.repo, owned), "initial\n");
  writeFileSync(join(fixture.repo, hinted), "initial pin\n");
  writeFileSync(join(fixture.repo, sibling), "sibling\n");
  git(fixture.repo, "add", "src", "tests");
  git(fixture.repo, "commit", "--no-gpg-sign", "-qm", "tracked repair inventory");
  const graph = loadGraph(fixture.repo);
  const result = await runDaemon(fixture.repo, { adapters: [fixture.fake], runId, approvalWindowMs: 1 });
  expect(result.human).toEqual(["T1"]);
  const journal = Journal.open(fixture.repo, runId);
  const park = journal.read().filter((e) => e.event === "task-human").at(-1)!;
  expect(park.data.kind).toBe("gate-fail");
  expect(park.data.reason).toContain("review round cap");
  expect(park.data.reason).toContain(`files[] repair hint: ${hinted}`);
  expect(park.data.repairHint).toEqual([hinted]);
  return { ...fixture, journal, graph };
}

test("test: the production daemon records a files repair hint as a structured field on its park, and an approve with uphold or recheck naming only grantable hinted paths appends that release carrying a scope amendment that extends files with exactly those paths, so a hint kept only as prose or a widened grant fails", async () => {
  const production = await daemonPark("run-daemon-files-hint");
  await approve([production.journal.runId, "T1", "--uphold", "--files", hinted, "--by", "operator"], production.repo);
  const release = approvals(production.journal);
  expect(release).toHaveLength(1);
  expect(release[0]!.data).toMatchObject({
    release: "review-upheld", gate: "review", by: "operator",
    amendment: { beforeFiles: [owned], files: [owned, hinted], from: graphDefinitionHash(production.graph) },
  });
  expect(loadGraph(production.repo).tasks[0]!.files).toEqual([owned, hinted]);
  expect(filesGlob(loadGraph(production.repo).tasks[0]!.files)(sibling)).toBe(false);

  const secondHint = "tests/second.test.ts";
  for (const kind of ["gate-fail", "infra"]) {
    const { repo, journal } = seed([hinted, secondHint, sibling], kind);
    await approve([journal.runId, "T1", "--recheck", "--files", `${hinted},${secondHint}`, "--review-rounds", "3"], repo);
    expect(approvals(journal)).toHaveLength(1);
    expect(approvals(journal)[0]!.data).toMatchObject({
      release: "recheck", reviewRoundCeiling: 3, amendment: { beforeFiles: [owned], files: [owned, hinted, secondHint] },
    });
    expect(loadGraph(repo).tasks[0]!.files).toEqual([owned, hinted, secondHint]);
    expect(filesGlob(loadGraph(repo).tasks[0]!.files)(sibling)).toBe(false);
    expect(journal.replaySatisfiedGates().size).toBe(0);
  }
}, 60_000);

test("test: an unhinted path, a park without a recorded hint, waive with files, files with no decision flag on a hinted gate-fail park and uphold with files on a hinted infrastructure park are each refused naming the task and appending nothing, so an amendment appended before its verb is admitted fails", async () => {
  for (const scenario of [
    { hint: [hinted], flags: ["--uphold"], path: sibling },
    { hint: null, flags: ["--uphold"], path: hinted },
    { hint: [], flags: ["--recheck"], path: hinted },
    { hint: [hinted], flags: ["--waive"], path: hinted },
    { hint: [hinted], flags: [], path: hinted },
    { hint: [hinted], kind: "infra", flags: ["--uphold"], path: hinted },
  ]) {
    const { repo, journal } = seed(scenario.hint, scenario.kind);
    const before = bytes(journal);
    const graphBefore = readFileSync(join(repo, ".tickmarkr/graph.json"), "utf8");
    await expect(approve([journal.runId, "T1", ...scenario.flags, "--files", scenario.path], repo))
      .rejects.toThrow(`refusing --files for T1: ${scenario.path}`);
    expect(bytes(journal)).toBe(before);
    expect(readFileSync(join(repo, ".tickmarkr/graph.json"), "utf8")).toBe(graphBefore);
  }
  // The newest park supplies the hint: an older hint grants nothing on its successor.
  const { repo, journal } = seed();
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "new park without a hint" });
  const before = bytes(journal);
  await expect(approve([journal.runId, "T1", "--uphold", "--files", hinted], repo))
    .rejects.toThrow(`refusing --files for T1: ${hinted}`);
  expect(bytes(journal)).toBe(before);
});

test("test: a hinted path with any character outside the grantable allowlist, a leading colon or a bad segment is refused by name appending nothing, so a pipe, quote or bracket never becomes a pattern granting the unhinted sibling it would match, while one path holding every allowlisted character is granted exactly, so a grant widened by pattern reading fails", async () => {
  const punctuation = " #$%&'()+-.:;<=>@]^_}~`";
  const all = `tests/Az09${punctuation}/pin.test.ts`;
  const invalid = [
    "tests/a*b/p9", "tests/a?b/p9", "tests/a|b/p9", 'tests/"b/p9', "tests/a\\b/p9", "tests/pin[ab]",
    "tests/{a,b}/pin", "!tests/pin.test.ts", ":(exclude)tests/pin.test.ts", "tests/a,b/pin",
    "tests/café/pin", "tests/😀/pin", "", ".", "..", "./pin", "tests/../pin", "tests/./pin",
    "tests//pin", "/tests/pin", "tests/pin/", " tests/pin", "tests/pin ",
    ...Array.from({ length: 33 }, (_, i) => String.fromCharCode(i === 32 ? 127 : i))
      .flatMap((control) => [`tests/a${control}b/pin`, `tests/pin${control}`]),
  ];
  const { repo, journal } = seed([...invalid, all]);
  const before = bytes(journal);
  for (const path of invalid) {
    const error = await approve([journal.runId, "T1", "--uphold", "--files", path], repo).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`refusing --files for T1: ${path}`);
    expect(bytes(journal)).toBe(before);
  }
  await approve([journal.runId, "T1", "--uphold", "--files", all], repo);
  const granted = loadGraph(repo).tasks[0]!.files;
  expect(granted).toEqual([owned, all]);
  expect(approvals(journal)[0]!.data.amendment).toMatchObject({ files: [owned, all] });
  const matches = filesGlob(granted);
  expect(matches(all)).toBe(true);
  for (let i = 0; i < punctuation.length; i++) {
    const at = all.indexOf(punctuation[i]!, "tests/Az09".length);
    for (const replacement of ["", "x", punctuation[i]!.repeat(2)]) {
      const bait = all.slice(0, at) + replacement + all.slice(at + 1);
      expect(matches(bait), JSON.stringify(bait)).toBe(false);
    }
  }
  expect(matches(all + "\n")).toBe(false);
  expect(matches(sibling)).toBe(false);
});

test("test: an uphold granted with hinted files funds the next attempt under the amended files, whose scope gate passes the hinted file it edits, and the journal replays that amendment and audits its graph rehash exactly as a scope-request grant's, so an amendment the daemon never applies fails", async () => {
  const { repo, journal, graph, scriptPath } = await daemonPark("run-hint-resume");
  await approve([journal.runId, "T1", "--uphold", "--files", hinted], repo);
  const approval = approvals(journal)[0]!;
  const amended = loadGraph(repo);
  const to = graphDefinitionHash(amended);
  const audit = journal.read().filter((e) => e.event === "graph-rehash");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.data).toMatchObject({ from: graphDefinitionHash(graph), to, approval: approval.ts, source: "approval" });
  expect(recordedGraphDefinitionHash(journal.read())).toBe(to);
  expect(replayScopeAmendments(graph, journal.read()).tasks[0]!.files).toEqual([owned, hinted]);
  // A stale open approval cannot move either the graph or its audited engagement identity.
  const stale = [...journal.read(), { ts: "newer", event: "task-human", taskId: "T1", data: { kind: "gate-fail" } }];
  expect(effectiveEvents(stale).filter((e) => e.event === "task-approved")).toHaveLength(0);
  expect(replayScopeAmendments(graph, stale)).toEqual(graph);
  expect(recordedGraphDefinitionHash(stale)).toBe(graphDefinitionHash(graph));

  // Simulate an old/crashed writer that persisted the approval but lost its graph audit.
  writeFileSync(join(journal.dir, "journal.jsonl"), journal.read().filter((e) => e.event !== "graph-rehash").map((e) => JSON.stringify(e)).join("\n") + "\n");
  const recovered = applyScopeAmendments(graph, journal, true);
  expect(recovered.tasks[0]!.files).toEqual([owned, hinted]);
  expect(journal.read().filter((e) => e.event === "graph-rehash")).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ from: graphDefinitionHash(graph), to, approval: approval.ts, source: "approval" }) }),
    expect.objectContaining({ data: expect.objectContaining({ to, approval: approval.ts, source: "approval", replay: true, loaded: graphDefinitionHash(graph) }) }),
  ]);
  const audited = bytes(journal);
  applyScopeAmendments(recovered, journal, true);
  expect(bytes(journal)).toBe(audited);

  // Recompile/materialize the old files[] to force the daemon itself to replay the grant.
  saveGraph(repo, graph);
  writeFileSync(scriptPath, JSON.stringify({
    review: { approve: true, issues: [] },
    tasks: { T1: [{ shell: `echo repaired >> ${hinted} && ${COMMIT} repair`, result: { ok: true, summary: "fixed pin" } }] },
  }));
  const fake = new FakeAdapter(scriptPath);
  const headless = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (file, model) => {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return headless(file, model);
    const resolved = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    return `printf '%s\\n' ${shq(JSON.stringify({ approve: true, issues: [], nonce: extractPromptNonce(prompt), resolved, reraised: [] }))}`;
  };
  const beforeResume = journal.read().length;
  const summary = await runDaemon(repo, { adapters: [fake], runId: journal.runId, resume: true, approvalWindowMs: 1 });
  expect(summary.done).toEqual(["T1"]);
  const after = journal.read().slice(beforeResume);
  expect(after.filter((e) => e.event === "task-dispatch")).toHaveLength(1);
  expect(after.find((e) => e.event === "gate-result" && e.data.gate === "scope")?.data.pass).toBe(true);
  expect(loadGraph(repo).tasks[0]!.files).toEqual([owned, hinted]);
  expect(git(repo, "show", `${summary.branch}:${hinted}`)).toContain("repaired");
  expect(git(repo, "show", `${summary.branch}:${sibling}`)).toBe("sibling");
  expect(recordedGraphDefinitionHash(journal.read())).toBe(to);
}, 60_000);

test("test: the approve help line for the files option states that it widens a scope-request park and grants the hinted paths of a park released with uphold or recheck, so help naming only the scope-request park fails", () => {
  const line = commandHelp("approve").split("\n").find((line) => line.startsWith("  --files "))!;
  expect(line).toMatch(/Widen a scope-request park/);
  expect(line).toMatch(/grant exact recorded repair hint paths/);
  expect(line).toContain("--uphold or --recheck");
});

test("hinted grants retain scope-request surface, task budget and sibling conflict checks", async () => {
  for (const flags of [["--uphold"], ["--recheck"]]) {
    for (const [files, acceptance, refusal] of [
      [Array.from({ length: 6 }, (_, i) => `src/owned${i}.ts`), ["a", "b", "c", "d"], /surface of 28/],
      [Array.from({ length: 8 }, (_, i) => `src/owned${i}.ts`), ["a"], /9 files\[\] patterns/],
    ] as const) {
      const { repo, journal } = seed([hinted], "gate-fail", [...files], [...acceptance]);
      const before = bytes(journal);
      await expect(approve([journal.runId, "T1", ...flags, "--files", hinted], repo)).rejects.toThrow(refusal);
      expect(bytes(journal)).toBe(before);
    }
    const { repo, journal } = seed();
    // Bind the journal to a graph with an unmerged sibling that owns the requested file.
    const siblingFixture = setupRepo([T("T1", { files: [owned] }), T("T2", { files: [hinted] })], { tasks: {} });
    const conflictGraph = loadGraph(siblingFixture.repo);
    saveGraph(repo, conflictGraph);
    const rows = journal.read();
    rows[0]!.data.graphDefinitionHash = graphDefinitionHash(conflictGraph);
    writeFileSync(join(journal.dir, "journal.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const before = bytes(journal);
    await expect(approve([journal.runId, "T1", ...flags, "--files", hinted], repo)).rejects.toThrow(/overlap|share|conflict/i);
    expect(bytes(journal)).toBe(before);
    expect(loadGraph(repo).tasks[0]!.files).toEqual([owned]);
  }
});
