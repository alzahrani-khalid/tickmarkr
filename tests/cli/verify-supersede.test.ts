// Queue row 339 / D-2181 D5: `tickmarkr verify --supersede` closes one owed check with a verified fix on a range
// containing the owed one. Disposable repositories, the fake adapter, zero tokens.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { status } from "../../src/cli/commands/status.js";
import { SUPERSEDE_RECOVERY, verify } from "../../src/cli/commands/verify.js";
import { getVerdictStore } from "../../src/gates/cache.js";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph, type RunGraph } from "../../src/graph/schema.js";
import { foldOwedChecks, Journal, owedSubject, type OwedCheck } from "../../src/run/journal.js";
import { withRepositoryLease } from "../../src/run/lease.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

// The durable-proof write seam: a test arms `durable` to model a conflicting existing proof or a failed persistence
// at the exact write verify performs; `append` sees every append (Journal.append's own write). Unarmed, every write
// passes straight through.
const fsHook = vi.hoisted(() => ({
  durable: undefined as undefined | ((path: string) => void),
  append: undefined as undefined | ((path: string, data: string) => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (fsHook.durable && typeof path === "string" && /\/discharges\/[0-9a-f]{64}\.json$/.test(path)) fsHook.durable(path);
    return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof actual.writeFileSync;
  const appendFileSync = ((path: unknown, data: unknown, ...rest: unknown[]) => {
    if (fsHook.append && typeof path === "string") fsHook.append(path, String(data));
    return (actual.appendFileSync as (...args: unknown[]) => void)(path, data, ...rest);
  }) as typeof actual.appendFileSync;
  return { ...actual, default: { ...actual, writeFileSync, appendFileSync }, writeFileSync, appendFileSync };
});

const RUN = "run-supersede";
// The captured obligation's allowlist shape (run …0576 line 355), in a disposable repository.
const FILES = ["src/board/summarize.ts", "tests/board/summarize.test.ts", "docs/codebase/{ARCHITECTURE,STRUCTURE}.md"];
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const graphOf = (files: string[], acceptance: unknown[] = ["done"], extra: unknown[] = []): RunGraph =>
  validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files, acceptance }), ...extra] });

afterEach(() => {
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  fsHook.durable = undefined;
  fsHook.append = undefined;
  vi.restoreAllMocks();
});

/** A real-shape owed review: the waived range, its run snapshot and run-end, built through approve --waive. */
async function owedReview(opts: { amendment?: boolean; gates?: string } = {}) {
  const repo = makeRepo({ "src/board/summarize.ts": "export const summarize = 1;\n", "src/other.ts": "other\n", "README.md": "readme\n" });
  const before = opts.amendment ? FILES.slice(0, 2) : FILES;
  const snapshot = graphOf(before);
  saveGraph(repo, snapshot);
  // A configured suite (`gates`) makes the battery take the repository's runner lease.
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `judge: { adapter: fake, model: fake-1 }\n${opts.gates ?? ""}`);
  writeDoctor(repo, { fake: { installed: true, authed: true, models: ["fake-3"], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  const script = join(makeTestTempDir("supersede-script-"), "script.json");
  // `"none"` serves a review with no verdict at all: an inconclusive battery.
  const reviewVerdict = (green: boolean | "none") =>
    writeFileSync(script, JSON.stringify({ tasks: {}, review: green === "none" ? {} : { approve: green, issues: green ? [] : ["defect"] } }));
  reviewVerdict(true);
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});

  git(repo, "branch", `tickmarkr/${RUN}`, "main");
  git(repo, "checkout", "-q", "-b", `tickmarkr/${RUN}--T1`);
  writeFileSync(join(repo, "src/board/summarize.ts"), "export const summarize = 2;\n");
  git(repo, "commit", "-q", "--no-gpg-sign", "-am", "feature");
  const head = git(repo, "rev-parse", "HEAD");
  const base = git(repo, "rev-parse", "main");
  git(repo, "checkout", "-q", "main");
  const journal = Journal.create(repo, RUN);
  // The daemon copies the compiled graph beside the journal at a fresh start only.
  copyFileSync(join(repo, ".tickmarkr", "graph.json"), join(journal.dir, "graph.json"));
  journal.append("run-start", undefined, { baseRef: "main" });
  const dispatch = { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } };
  journal.append("task-dispatch", "T1", { attempt: 0, ...dispatch });
  if (opts.amendment) {
    // An approved scope amendment widened files[] mid-run; the daemon materialized it into graph.json.
    journal.append("task-human", "T1", { kind: "scope-request", reason: "needs the docs" });
    const park = journal.read().at(-1)!;
    const amended = graphOf(FILES);
    journal.append("task-approved", "T1", { by: "operator", via: "cli", release: "scope-request", park: { line: journal.read().length, ts: park.ts },
      amendment: { from: graphDefinitionHash(snapshot), to: graphDefinitionHash({ ...snapshot, tasks: snapshot.tasks.map((t) => ({ ...t, files: FILES })) }),
        beforeFiles: before, files: FILES, parkLine: journal.read().length } });
    journal.append("task-dispatch", "T1", { attempt: 1, ...dispatch });
    saveGraph(repo, amended);
  }
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "red", commit: owedSubject(repo, base, head) });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision" });
  await approve([RUN, "T1", "--waive", "--by", "operator", "--reason", "D-2181"], repo);
  const obligation = journal.read().find((row) => row.event === "task-approved" && row.data.obligation)!.data.obligation as OwedCheck;
  expect(obligation).toMatchObject({ version: 1, known: true, gate: "review", disposition: "accepted-risk", authors: ["fake:fake-1"], files: FILES, base, head });
  journal.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });
  return { repo, journal, obligation, reviewVerdict };
}

/** A commit on top of `from` (detached), touching only `changes`. */
function commitOn(repo: string, from: string, changes: Record<string, string>, message = "fix"): string {
  git(repo, "checkout", "-q", "--detach", from);
  for (const [path, text] of Object.entries(changes)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "--", ...Object.keys(changes));
  git(repo, "commit", "-q", "--no-gpg-sign", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const supersede = (o: OwedCheck, author = "human", extra: string[] = [], base = "main") =>
  ["--record", RUN, "--task", "T1", "--base", base, "--supersede", o.id, "--author", author, "--no-acceptance", "--json", ...extra];
// An apostrophe is a legal ref character: --base reaches git as ONE shell-quoted argument (row 339, D-2181 D5).
const QUOTED = "main'quoted";
const journalBytes = (journal: Journal) => readFileSync(join(journal.dir, "journal.jsonl"));
const fresh = (repo: string) => getVerdictStore(join(repo, ".tickmarkr")).clear();
const gateStarts = () => vi.mocked(console.error).mock.calls.filter(([line]) => String(line).startsWith("verify: → ")).length;

/** With --json, a supersede exit is exactly ONE JSON document on stdout naming superseded and discharged — no plain text. */
const supersedeDoc = (out: string) => {
  const doc = JSON.parse(out) as { owed: { superseded: unknown; discharged: unknown } };
  expect(doc.owed.superseded, out).toBeInstanceOf(Array);
  expect(doc.owed.discharged, out).toBeInstanceOf(Array);
  return doc;
};

/** Runs verify and asserts the run journal is byte-for-byte unchanged, whatever verify returned or threw; every
 *  --supersede --json refusal (usage, parse, thrown, bound or battery) must also be one supersede JSON document. */
async function refused(journal: Journal, argv: string[], cwd: string): Promise<{ out: string; code: number }> {
  const before = journalBytes(journal);
  const result = await verify(argv, cwd).catch((error: Error) => ({ out: error.message, code: -1 }));
  expect(journalBytes(journal), result.out).toEqual(before);
  expect(result.code, result.out).not.toBe(0);
  if (argv.includes("--json") && argv.some((arg) => arg.startsWith("--supersede"))) supersedeDoc(result.out);
  return result;
}

/** Runs verify while another holder keeps the repository's runner lease, then `during` once verify waits for it. */
async function whileLeaseHeld(repo: string, argv: string[], during: () => void): Promise<{ out: string; code: number }> {
  const waits = () => vi.mocked(console.error).mock.calls.some(([line]) => String(line).includes("waiting for the repository's runner lease"));
  let release!: () => void;
  const releasing = new Promise<void>((r) => { release = r; });
  let holding!: () => void;
  const holds = new Promise<void>((r) => { holding = r; });
  const holder = withRepositoryLease(repo, async () => { holding(); await releasing; }, { pollMs: 50 });
  await holds;
  vi.mocked(console.error).mockClear();
  const pending = verify(argv, repo).catch((error: Error) => ({ out: error.message, code: -1 }));
  try {
    await vi.waitFor(() => expect(waits()).toBe(true), { timeout: 60_000, interval: 50 });
    during();
  } finally {
    release();
    await holder;
  }
  return pending;
}

const recipe = (o: OwedCheck) => [`owed base ${o.base}, owed head ${o.head}`, `git switch -c <branch> '${o.head}'; commit the in-scope fix there;`,
  `tickmarkr verify --record '${RUN}' --task 'T1' --base '${o.base}' --supersede '${o.id}'`, "then merge that branch into the integration branch"];

test("supersede verifies the containing fix under original plus fixing author exclusions and records one distinct durable closure with its fixing head while ordinary discharge remains distinct", async () => {
  const { repo, journal, obligation } = await owedReview();
  const fixHead = commitOn(repo, obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  git(repo, "branch", QUOTED, "main");
  const result = await verify(supersede(obligation, "human", [], QUOTED), repo);
  expect(result.code, result.out).toBe(0);
  const report = JSON.parse(result.out);
  const rows = journal.read();
  const closure = rows.filter((row) => row.event === "owed-check-superseded");
  expect(closure).toHaveLength(1);
  expect(rows.filter((row) => row.event === "owed-check-discharged")).toEqual([]);
  const recorded = String(closure[0]!.data.artifactPath);
  expect(recorded).toBe(join("discharges", `${report.artifactSha256}.json`));
  expect(closure[0]).toMatchObject({ taskId: "T1", data: {
    ids: [obligation.id], gates: ["review"], mapping: "supersede", mergeBase: obligation.base, head: fixHead, criteria: obligation.criteria,
    artifactSha256: report.artifactSha256, reviewer: { key: "fake:fake-2", vendor: "fake-b" },
    authorChannels: [{ key: "fake:fake-1", vendor: "fake-a" }], fixAuthors: [{ key: "human:human", vendor: "human" }],
  } });
  // The hash-bound durable proof carries the same fixing-author facts, files and criteria the row names.
  const bytes = readFileSync(join(journal.dir, recorded));
  expect(digest(bytes)).toBe(report.artifactSha256);
  expect(JSON.parse(bytes.toString())).toMatchObject({ head: fixHead, mergeBase: obligation.base, green: true, files: FILES, criteria: obligation.criteria,
    fixAuthors: [{ key: "human:human", vendor: "human" }] });
  expect(report.owed).toMatchObject({ debt: 0, discharged: [], superseded: [{ id: obligation.id, head: fixHead, artifactPath: recorded }] });
  // The audit review row follows the validated closure, never precedes it.
  expect(rows.findIndex((row) => row.event === "review-leg2")).toBeGreaterThan(rows.indexOf(closure[0]!));
  const fold = foldOwedChecks(rows, repo);
  expect(fold).toMatchObject({ known: true, debt: 0, outstanding: [], discharged: [], acceptedRisk: [{ id: obligation.id }],
    superseded: [{ id: obligation.id, head: fixHead, artifactPath: recorded, artifactSha256: report.artifactSha256 }] });

  // A resolved adapter:model fixer is recorded as itself; a fixer sharing the only reviewer's identity leaves no seat.
  const second = await owedReview();
  const secondFix = commitOn(second.repo, second.obligation.head, { "src/board/summarize.ts": "export const summarize = 4;\n" });
  const sameAsReviewer = await refused(second.journal, supersede(second.obligation, "fake:fake-2"), second.repo);
  expect(sameAsReviewer.code).toBe(2);
  expect(JSON.parse(sameAsReviewer.out)).toMatchObject({ green: false, owed: { superseded: [], refused: "the verdict is not green" } });
  fresh(second.repo);
  const resolved = await verify(supersede(second.obligation, "fake:fake-3"), second.repo);
  expect(resolved.code, resolved.out).toBe(0);
  expect(second.journal.read().find((row) => row.event === "owed-check-superseded")).toMatchObject({ data: {
    head: secondFix, reviewer: { key: "fake:fake-2" }, authorChannels: [{ key: "fake:fake-1", vendor: "fake-a" }], fixAuthors: [{ key: "fake:fake-3", vendor: "fake-a" }],
  } });

  // Ordinary exact discharge, no supersede: its legacy row and fold shape, with no superseded property.
  const third = await owedReview();
  git(third.repo, "checkout", "-q", "--detach", third.obligation.head);
  git(third.repo, "branch", QUOTED, "main");
  const discharged = await verify(["--base", QUOTED, "--task", "T1", "--no-acceptance", "--record", RUN, "--json"], third.repo);
  expect(discharged.code, discharged.out).toBe(0);
  expect(JSON.parse(discharged.out).owed).toEqual({ debt: 0, discharged: [third.obligation.id] });
  const legacy = third.journal.read();
  expect(legacy.filter((row) => row.event === "owed-check-superseded")).toEqual([]);
  expect(legacy.find((row) => row.event === "owed-check-discharged")!.data).not.toHaveProperty("fixAuthors");
  const legacyFold = foldOwedChecks(legacy, third.repo);
  expect(legacyFold).toMatchObject({ known: true, debt: 0, discharged: [third.obligation.id] });
  expect(legacyFold).not.toHaveProperty("superseded");
}, 120_000);

test("every supersede refusal leaves the run journal byte identical and a previously closed check returns its original closure without another battery or append while non containing or scope red refusals print owed base and head via the owed head branch fix verify merge recipe", async () => {
  const { repo, journal, obligation, reviewVerdict } = await owedReview();
  const fixHead = commitOn(repo, obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const argv = supersede(obligation);
  const without = (flag: string) => { const at = argv.indexOf(flag); return [...argv.slice(0, at), ...argv.slice(at + 2)]; };

  // Usage: a missing record, task or required author, a valueless option and an unknown option refuse before any battery.
  for (const flag of ["--record", "--task", "--author"]) {
    const result = await refused(journal, without(flag), repo);
    expect(result).toMatchObject({ code: 1, out: expect.stringContaining(`requires ${flag} <`) });
  }
  await refused(journal, [...without("--supersede"), "--supersede"], repo);
  await refused(journal, [...argv, "--no-such-option"], repo);
  // An unresolvable --base refuses; operator text in --base never runs as shell, whether git rejects it or rev-parse
  // echoes it as an unknown option into the merge-base call — supersede and ordinary verify alike, no marker, no append.
  const marker = join(makeTestTempDir("supersede-inject-"), "injected");
  const payloads = ["no-such-ref", `main'; printf injected > '${marker}'; #`, `--x'; printf injected > '${marker}'; '`,
    `$(printf injected > '${marker}')`, `\`printf injected > '${marker}'\``, `main"; printf injected > "${marker}"; "`];
  for (const payload of payloads) {
    // `--base=<text>`: the inline form is how parseArgs accepts a value starting with a dash.
    const at = argv.indexOf("--base");
    expect((await refused(journal, [...argv.slice(0, at), `--base=${payload}`, ...argv.slice(at + 2)], repo)).out).not.toMatch(/argument is ambiguous/);
    expect((await refused(journal, [`--base=${payload}`, "--task", "T1", "--no-acceptance", "--record", RUN, "--json"], repo)).out).not.toMatch(/argument is ambiguous/);
    expect(existsSync(marker), payload).toBe(false);
  }
  // Unknown check, wrong task, wrong run; scope or baseline override; disabled required gate; unresolved fixer.
  expect((await refused(journal, supersede({ ...obligation, id: "0000000000000000" }), repo)).out).toContain(`records no owed check 0000000000000000`);
  expect((await refused(journal, argv.map((a) => a === "T1" ? "T2" : a), repo)).out).toContain(`is owed by ${RUN} task T1, not ${RUN} task T2`);
  Journal.create(repo, "run-other").append("run-start", undefined, {});
  expect((await refused(journal, argv.map((a) => a === RUN ? "run-other" : a), repo)).out).toContain("run-other records no owed check");
  expect((await refused(journal, [...argv, "--files", "*"], repo)).out).toContain("--files cannot replace it");
  writeFileSync(join(repo, ".tickmarkr", "baseline.json"), "{\"commands\":{}}");
  expect((await refused(journal, [...argv, "--baseline", join(repo, ".tickmarkr", "baseline.json")], repo)).out).toContain("--baseline cannot supply one");
  expect((await refused(journal, [...argv, "--no-review"], repo)).out).toContain("requires the review gate, which this invocation skips");
  expect((await refused(journal, supersede(obligation, "nope:model"), repo)).out).toContain("unresolved fixing author");
  // A dirty candidate refuses; so does unknown debt beside the check.
  writeFileSync(join(repo, "src/board/summarize.ts"), "dirty\n");
  expect((await refused(journal, argv, repo)).out).toContain("refusing to gate a dirty worktree");
  git(repo, "checkout", "-q", "--", "src/board/summarize.ts");
  const path = join(journal.dir, "journal.jsonl");
  const original = readFileSync(path);
  journal.append("task-approved", "T2", { release: "gate-satisfied", gate: "review" });
  journal.append("task-dispatch", "T2", {});
  expect((await refused(journal, argv, repo)).out).toContain("debt is unknown");
  writeFileSync(path, original);

  // Non-containing: a sibling from the owed base that never descends from the owed head — refused with the recipe.
  commitOn(repo, obligation.base, { "src/board/summarize.ts": "export const summarize = 3;\n" }, "sibling fix");
  const sibling = await refused(journal, argv, repo);
  expect(sibling.code).toBe(2);
  expect(sibling.out).toContain(`the owed head ${obligation.head} is not an ancestor of`);
  for (const line of recipe(obligation)) expect(sibling.out).toContain(line);
  expect(sibling.out).toContain("--author 'human' on that branch");
  // HEAD at the owed base under --base main (the owed base): containment is decided before the empty-range exit, so
  // the refusal still names both owed endpoints and the recipe.
  git(repo, "checkout", "-q", "--detach", obligation.base);
  const atBase = await refused(journal, argv, repo);
  expect(atBase.code, atBase.out).toBe(2);
  expect(atBase.out).toContain(`the owed head ${obligation.head} is not an ancestor of ${obligation.base}`);
  for (const line of recipe(obligation)) expect(atBase.out).toContain(line);

  // Scope red, with the reviewer scripted green: a contained fix that also edits an out-of-scope file.
  commitOn(repo, obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n", "src/other.ts": "widened\n" });
  const scopeRed = await refused(journal, argv, repo);
  const scopeReport = JSON.parse(scopeRed.out);
  expect(scopeRed.code).toBe(2);
  expect(scopeReport.results).toEqual(expect.arrayContaining([expect.objectContaining({ gate: "scope", pass: false })]));
  expect(scopeReport.owed).toMatchObject({ debt: 1, superseded: [], refused: "the verdict is not green" });
  for (const line of recipe(obligation)) expect(scopeReport.owed.recover.join("\n")).toContain(line);
  const scopeText = await refused(journal, argv.filter((a) => a !== "--json"), repo);
  expect(scopeText.out).toContain("verify --record refused supersede: the verdict is not green");
  for (const line of recipe(obligation)) expect(scopeText.out).toContain(line);

  // The captured owed review range, re-review still red: exit 2, the check stays outstanding.
  git(repo, "checkout", "-q", "--detach", fixHead);
  fresh(repo);
  reviewVerdict(false);
  const red = await refused(journal, argv, repo);
  expect(red.code).toBe(2);
  expect(JSON.parse(red.out)).toMatchObject({ green: false, owed: { debt: 1, superseded: [], refused: "the verdict is not green" } });
  expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: true, debt: 1, outstanding: [{ id: obligation.id }] });
  // An inconclusive battery: the review returns no verdict.
  fresh(repo);
  reviewVerdict("none");
  expect(JSON.parse((await refused(journal, argv, repo)).out)).toMatchObject({ green: false, owed: { debt: 1, superseded: [], refused: "the verdict is not green" } });

  // A green battery whose durable proof cannot be published: unavailable, conflicting bytes, failed persistence.
  fresh(repo);
  reviewVerdict(true);
  const durableRefusal = { owed: { debt: 1, superseded: [], refused: "durable results artifact unavailable or has different bytes" } };
  const discharges = join(journal.dir, "discharges");
  writeFileSync(discharges, "not a directory\n");
  expect(JSON.parse((await refused(journal, argv, repo)).out)).toMatchObject({ green: true, ...durableRefusal });
  rmSync(discharges);
  let attempted = "";
  fsHook.durable = (path) => { fsHook.durable = undefined; attempted = path; writeFileSync(path, "{}\n"); };
  expect(JSON.parse((await refused(journal, argv, repo)).out)).toMatchObject({ green: true, ...durableRefusal });
  expect(readFileSync(attempted, "utf8")).toBe("{}\n"); // never overwritten
  rmSync(attempted);
  fsHook.durable = (path) => { fsHook.durable = undefined; attempted = path; throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); };
  expect(JSON.parse((await refused(journal, argv, repo)).out)).toMatchObject({ green: true, ...durableRefusal });
  expect(existsSync(attempted)).toBe(false);
  expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: true, debt: 1, outstanding: [{ id: obligation.id }] });

  // The green battery closes it once; a second invocation returns that original closure with no battery and no append.
  fresh(repo);
  reviewVerdict(true);
  const green = await verify(argv, repo);
  expect(green.code, green.out).toBe(0);
  const closure = journal.read().find((row) => row.event === "owed-check-superseded")!;
  const closed = journalBytes(journal);
  const starts = gateStarts();
  const again = await verify(argv, repo);
  expect(again.code, again.out).toBe(0);
  // --json: one document carrying the ORIGINAL closure as superseded, never as discharged.
  expect(supersedeDoc(again.out)).toEqual({ owed: { debt: 0, discharged: [], superseded: [{ id: obligation.id, head: fixHead,
    artifactPath: String(closure.data.artifactPath), artifactSha256: String(closure.data.artifactSha256) }] } });
  const againText = await verify(argv.filter((arg) => arg !== "--json"), repo);
  expect(againText.code, againText.out).toBe(0);
  expect(againText.out).toContain(`check ${obligation.id} is already closed — superseded from fixing head ${fixHead} (verify record ${String(closure.data.artifactPath)} sha256 ${String(closure.data.artifactSha256)}); nothing appended`);
  expect(gateStarts()).toBe(starts);
  expect(journalBytes(journal)).toEqual(closed);

  // A check already closed by an ordinary discharge answers the same way: exit 0, no battery, no append, no rewrite.
  const paid = await owedReview();
  git(paid.repo, "checkout", "-q", "--detach", paid.obligation.head);
  const beforeDischarge = journalBytes(paid.journal);
  expect((await verify(["--base", "main", "--task", "T1", "--no-acceptance", "--record", RUN, "--json"], paid.repo)).code).toBe(0);
  commitOn(paid.repo, paid.obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const paidBytes = journalBytes(paid.journal);
  const paidStarts = gateStarts();
  const paidAgain = await verify(supersede(paid.obligation), paid.repo);
  expect(paidAgain.code, paidAgain.out).toBe(0);
  expect(supersedeDoc(paidAgain.out)).toEqual({ owed: { debt: 0, discharged: [paid.obligation.id], superseded: [] } });
  const paidText = await verify(supersede(paid.obligation).filter((arg) => arg !== "--json"), paid.repo);
  expect(paidText.code, paidText.out).toBe(0);
  expect(paidText.out).toContain(`check ${paid.obligation.id} is already closed — discharged; nothing appended`);
  expect(gateStarts()).toBe(paidStarts);
  expect(journalBytes(paid.journal)).toEqual(paidBytes);
  // An ordinary discharge another invocation published while this green supersede ran: returned as discharged, never
  // as superseded, with nothing appended after it.
  const paidPath = join(paid.journal.dir, "journal.jsonl");
  const dischargeLine = `${paidBytes.toString().split("\n").find((line) => line.includes('"owed-check-discharged"'))!}\n`;
  writeFileSync(paidPath, beforeDischarge);
  fresh(paid.repo);
  fsHook.durable = () => { fsHook.durable = undefined; appendFileSync(paidPath, dischargeLine); };
  const racedDischarge = await verify(supersede(paid.obligation), paid.repo);
  expect(racedDischarge.code, racedDischarge.out).toBe(0);
  expect(supersedeDoc(racedDischarge.out).owed).toEqual({ debt: 0, discharged: [paid.obligation.id], superseded: [] });
  expect(journalBytes(paid.journal)).toEqual(Buffer.concat([beforeDischarge, Buffer.from(dischargeLine)]));

  // Lease waits, an interrupted suite and a stale final reread: each refusal leaves the journal untouched (no
  // suite-wait row), a success publishes its deferred suite-wait rows only after the closure, and a closure that
  // another invocation published meanwhile is returned instead of duplicated.
  const gates = `gates:\n  test: "true"\n`;
  const leased = await owedReview({ gates });
  const config = join(leased.repo, ".tickmarkr", "config.yaml");
  const leasedFix = commitOn(leased.repo, leased.obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const leasedArgv = supersede(leased.obligation);
  const held = (during: () => void) => whileLeaseHeld(leased.repo, leasedArgv, during);
  // The subject changes while the suite waits behind the lease.
  const before = journalBytes(leased.journal);
  const moved = await held(() => git(leased.repo, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "moved"));
  expect(moved.code, moved.out).toBe(2);
  expect(JSON.parse(moved.out).results).toEqual(expect.arrayContaining([expect.objectContaining({ gate: "test", pass: false, details: expect.stringContaining("HEAD moved from") })]));
  expect(journalBytes(leased.journal)).toEqual(before);
  // An interrupted suite: the candidate's test command is killed by a signal.
  git(leased.repo, "checkout", "-q", "--detach", leasedFix);
  fresh(leased.repo);
  writeFileSync(config, `judge: { adapter: fake, model: fake-1 }\ngates:\n  test: ${JSON.stringify(`if [ "$(git rev-parse HEAD)" = ${leasedFix} ]; then kill -9 $$; fi`)}\n`);
  expect(JSON.parse((await refused(leased.journal, leasedArgv, leased.repo)).out)).toMatchObject({ green: false, owed: { debt: 1, refused: "the verdict is not green" } });
  writeFileSync(config, `judge: { adapter: fake, model: fake-1 }\n${gates}`);
  // A stale final reread: another writer makes the run's debt unknown after the durable proof is written.
  fresh(leased.repo);
  const legacyWaiver = `${JSON.stringify({ ts: "2026-11-07T00:00:00.000Z", event: "task-approved", taskId: "T2", data: { release: "gate-satisfied", gate: "review" } })}\n`
    + `${JSON.stringify({ ts: "2026-11-07T00:00:01.000Z", event: "task-dispatch", taskId: "T2", data: {} })}\n`;
  const journalPath = join(leased.journal.dir, "journal.jsonl");
  fsHook.durable = () => { fsHook.durable = undefined; appendFileSync(journalPath, legacyWaiver); };
  const stale = await verify(leasedArgv, leased.repo);
  expect(stale.code, stale.out).toBe(2);
  expect(JSON.parse(stale.out).owed).toMatchObject({ debt: "unknown", superseded: [], refused: "stale final reread: the check is no longer known outstanding" });
  expect(journalBytes(leased.journal)).toEqual(Buffer.concat([before, Buffer.from(legacyWaiver)]));
  writeFileSync(journalPath, before);
  // A green battery after a lease wait: the closure first, its deferred suite-wait rows and review row after it.
  fresh(leased.repo);
  const success = await held(() => {});
  expect(success.code, success.out).toBe(0);
  const leasedRows = leased.journal.read();
  const closedAt = leasedRows.findIndex((row) => row.event === "owed-check-superseded");
  expect(leasedRows.slice(0, closedAt).filter((row) => ["suite-wait", "review-leg2"].includes(row.event))).toEqual([]);
  expect(leasedRows.slice(closedAt).map((row) => row.event)).toEqual(expect.arrayContaining(["suite-wait", "review-leg2"]));
  // Another invocation published that closure while this one ran: returned, never duplicated.
  const closureLine = `${journalBytes(leased.journal).toString().split("\n").find((line) => line.includes('"owed-check-superseded"'))!}\n`;
  writeFileSync(journalPath, before);
  fresh(leased.repo);
  fsHook.durable = () => { fsHook.durable = undefined; appendFileSync(journalPath, closureLine); };
  const raced = await verify(leasedArgv, leased.repo);
  expect(raced.code, raced.out).toBe(0);
  expect(JSON.parse(raced.out).owed).toMatchObject({ debt: 0, discharged: [], superseded: [{ id: leased.obligation.id, head: leasedFix }] });
  expect(journalBytes(leased.journal)).toEqual(Buffer.concat([before, Buffer.from(closureLine)]));
}, 240_000);

// Row 339 / D-2181 D5 (D-2184 add.54) publication boundary, AFTER the closure append: the closure is the one line that
// publishes, and an error raised after it — ENOSPC writing a deferred suite-wait or the review-leg2 audit row, or EIO
// after that row was completely written — is never a refusal and never a quiet exit 0. Plain and JSON alike exit
// nonzero saying the closure may already be recorded and that the same re-run returns the existing closure or a
// refusal; the persisted closure stays the journal's one closure, and that re-run returns it with no battery or append.
test("a supersede whose suite wait or review audit row append fails after the published closure exits nonzero saying the closure may already be recorded never refused and the same re-run returns the existing closure", async () => {
  const leased = await owedReview({ gates: `gates:\n  test: "true"\n` });
  const fixHead = commitOn(leased.repo, leased.obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const argv = supersede(leased.obligation);
  const journalPath = join(leased.journal.dir, "journal.jsonl");
  const before = journalBytes(leased.journal);
  const faults: Array<[string, (data: string) => never]> = [
    ["ENOSPC", () => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); }],
    ["EIO after a complete write", (data) => { appendFileSync(journalPath, data); throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }); }],
  ];
  for (const [fault, inject] of faults) {
    for (const audit of ["review-leg2", "suite-wait"] as const) {
      for (const json of [true, false]) {
        const label = `${fault} ${audit} json=${json}`;
        writeFileSync(journalPath, before);
        fresh(leased.repo);
        let injected = 0;
        fsHook.append = (path, data) => {
          if (path !== journalPath || !data.includes(`"event":"${audit}"`)) return;
          fsHook.append = undefined;
          injected += 1;
          inject(data);
        };
        const run = json ? argv : argv.filter((arg) => arg !== "--json");
        const result = audit === "suite-wait" ? await whileLeaseHeld(leased.repo, run, () => {})
          : await verify(run, leased.repo).catch((error: Error) => ({ out: `threw: ${error.message}`, code: -1 }));
        fsHook.append = undefined;
        expect(injected, label).toBe(1); // the control: the audit append really began after the closure and really failed
        const rows = leased.journal.read();
        const closures = rows.filter((row) => row.event === "owed-check-superseded");
        expect(closures, label).toHaveLength(1);
        if (fault !== "ENOSPC") expect(rows.findIndex((row) => row.event === audit), label).toBeGreaterThan(rows.indexOf(closures[0]!));
        expect(rows.filter((row) => row.event === audit), label).toHaveLength(fault === "ENOSPC" ? 0 : 1);
        expect(result.code, `${label}: ${result.out}`).toBe(1);
        expect(result.out, label).toContain(`the closure of check ${leased.obligation.id} may already be recorded`);
        expect(result.out, label).toContain("re-run the same verify --supersede: it returns the existing closure or a refusal");
        expect(result.out, label).not.toMatch(/refus(ed|al:)|threw/);
        if (json) {
          const doc = JSON.parse(result.out) as { owed: Record<string, unknown> };
          expect(doc.owed, label).toMatchObject({ superseded: "unknown", discharged: [], mayAlreadyBeRecorded: [leased.obligation.id] });
          expect(doc.owed, label).not.toHaveProperty("refused");
        } else {
          expect(result.out, label).toMatch(/^verify --supersede: the closure of check /);
        }
        const closed = { id: leased.obligation.id, head: fixHead, artifactPath: String(closures[0]!.data.artifactPath), artifactSha256: String(closures[0]!.data.artifactSha256) };
        expect(foldOwedChecks(rows, leased.repo), label).toMatchObject({ known: true, debt: 0, superseded: [closed] });
        // The same re-run, no fault: the existing closure, with no battery and nothing appended.
        const faulted = journalBytes(leased.journal);
        const starts = gateStarts();
        const again = await verify(argv, leased.repo);
        expect(again.code, again.out).toBe(0);
        expect(supersedeDoc(again.out).owed, label).toEqual({ debt: 0, discharged: [], superseded: [closed] });
        expect(gateStarts(), label).toBe(starts);
        expect(journalBytes(leased.journal), label).toEqual(faulted);
      }
    }
  }
}, 240_000);

// Row 339 / D-2181 D5 (D-2184 add.54) publication boundary: an error raised during or after the closure append — ENOSPC
// partway through the line, EIO after a complete write, a torn line another writer left under it — is never a refusal.
// Plain and JSON alike exit nonzero saying the closure may already be recorded and that the same re-run returns the
// existing closure or a refusal; never `refused`, never an empty superseded list. The re-run then answers truthfully.
test("a supersede whose closure append fails partway, after a complete write or lands torn exits nonzero saying the closure may already be recorded never refused or an empty superseded list and the same re-run returns the existing closure or a refusal", async () => {
  const { repo, journal, obligation } = await owedReview();
  const fixHead = commitOn(repo, obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const argv = supersede(obligation);
  const journalPath = join(journal.dir, "journal.jsonl");
  const before = journalBytes(journal);
  const isClosure = (path: string, data: string) => path === journalPath && data.includes('"event":"owed-check-superseded"');
  const faults: Array<[string, (data: string) => void]> = [
    ["ENOSPC partway", (data) => { appendFileSync(journalPath, data.slice(0, 80)); throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); }],
    ["EIO after a complete write", (data) => { appendFileSync(journalPath, data); throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }); }],
    // Another writer's incomplete line lands first; the closure append itself succeeds but its line reads torn.
    ["torn line", () => appendFileSync(journalPath, '{"ts":"2026-11-07T00:00:00.000Z","event":"torn')],
  ];
  for (const [fault, inject] of faults) {
    for (const json of [true, false]) {
      writeFileSync(journalPath, before);
      fresh(repo);
      let injected = 0;
      fsHook.append = (path, data) => {
        if (!isClosure(path, data)) return;
        fsHook.append = undefined;
        injected += 1;
        inject(data);
      };
      const run = json ? argv : argv.filter((arg) => arg !== "--json");
      const result = await verify(run, repo).catch((error: Error) => ({ out: `threw: ${error.message}`, code: -1 }));
      fsHook.append = undefined;
      const label = `${fault} json=${json}`;
      expect(injected, label).toBe(1); // the control: the closure append really began and the fault really fired
      expect(journalBytes(journal), label).not.toEqual(before); // the journal changed: no refusal may claim otherwise
      expect(result.code, `${label}: ${result.out}`).toBe(1);
      expect(result.out, label).toContain(`the closure of check ${obligation.id} may already be recorded`);
      expect(result.out, label).toContain("re-run the same verify --supersede: it returns the existing closure or a refusal");
      expect(result.out, label).not.toMatch(/refus(ed|al:)|threw/);
      if (json) {
        const doc = JSON.parse(result.out) as { owed: Record<string, unknown> };
        expect(doc.owed, label).toMatchObject({ superseded: "unknown", discharged: [], mayAlreadyBeRecorded: [obligation.id] });
        expect(doc.owed, label).not.toHaveProperty("refused");
      } else {
        expect(result.out, label).toMatch(/^verify --supersede: the closure of check /);
      }
    }
    // The same re-run, no fault: the existing closure, or a refusal that leaves the journal byte identical.
    const faulted = journalBytes(journal);
    fresh(repo);
    const again = await verify(argv, repo);
    const doc = JSON.parse(again.out) as { owed: Record<string, unknown> };
    const closures = () => foldOwedChecks(journal.read(), repo).superseded ?? [];
    if (fault === "EIO after a complete write") {
      expect(again.code, again.out).toBe(0);
      expect(doc.owed).toMatchObject({ debt: 0, discharged: [], superseded: [{ id: obligation.id, head: fixHead }] });
      expect(journalBytes(journal)).toEqual(faulted);
    } else if (fault === "ENOSPC partway") {
      expect(again.code, again.out).toBe(2);
      expect(doc.owed).toMatchObject({ debt: 1, superseded: [], refused: expect.stringContaining("ends in an incomplete line left by an interrupted append") });
      expect(journalBytes(journal)).toEqual(faulted);
      expect(closures()).toEqual([]);
    } else {
      // The torn closure was never recorded: the re-run publishes it, once.
      expect(again.code, again.out).toBe(0);
      expect(doc.owed).toMatchObject({ debt: 0, superseded: [{ id: obligation.id, head: fixHead }] });
    }
    if (fault !== "ENOSPC partway") expect(closures()).toEqual([expect.objectContaining({ id: obligation.id, head: fixHead })]);
  }
}, 240_000);

test("supersede resolves criteria and scope from the owed run definition and its containment accepts endpoint equality and refuses unreadable sibling rewritten or non containing history and the captured hand fix without weakening task scope", async () => {
  const { repo, journal, obligation } = await owedReview({ amendment: true });
  const snapshotPath = join(journal.dir, "graph.json");
  const snapshot = readFileSync(snapshotPath);
  expect(JSON.parse(snapshot.toString()).tasks[0].files).not.toEqual(obligation.files);
  const fixHead = commitOn(repo, obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const argv = supersede(obligation);

  // Neither source binds BOTH fields: each source's failure is named, then the recovery sentence.
  saveGraph(repo, graphOf(FILES, ["changed"]));
  const cases: Array<[() => void, string]> = [
    [() => rmSync(snapshotPath), "(approved scope amendments replayed): missing"],
    [() => writeFileSync(snapshotPath, "{ not json"), "(approved scope amendments replayed): unreadable or invalid"],
    [() => writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(snapshot.toString()), spec: { source: "prd", paths: ["p"], hash: "other" } })), "refusing scope amendment replay"],
    // A snapshot without the amended task refuses the replay of that task's approved amendment.
    [() => writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(snapshot.toString()), tasks: [T("T9")] })), "refusing scope amendment replay: T1 files[] changed beyond the approved amendment"],
  ];
  for (const [arrange, named] of cases) {
    arrange();
    const result = await refused(journal, argv, repo);
    expect(result.code).toBe(2);
    expect(result.out).toContain(named);
    expect(result.out).toContain("current compiled graph: criteria digest differs");
    expect(result.out).toContain(SUPERSEDE_RECOVERY);
  }
  // Matching only one bound field is insufficient; an absent task is named. The replay stays refused here.
  saveGraph(repo, graphOf(FILES.slice(0, 1)));
  expect((await refused(journal, argv, repo)).out).toContain("current compiled graph: files differ");
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T9")] }));
  expect((await refused(journal, argv, repo)).out).toContain("current compiled graph: no task T1");
  writeFileSync(snapshotPath, snapshot);

  // Containment reads measured ancestry: an unreadable owed head, a sibling with the same patch, a rewritten owed head,
  // a measured base above the owed base, and the captured hand fix — all refused before any battery.
  const path = join(journal.dir, "journal.jsonl");
  const original = readFileSync(path);
  writeFileSync(path, original.toString().replace(new RegExp(`"head":"${obligation.head}"`, "g"), `"head":"${"0".repeat(40)}"`));
  const unreadable = await refused(journal, argv, repo);
  expect(unreadable.out).toContain("unreadable history");
  expect(unreadable.out).not.toContain("git switch -c");
  writeFileSync(path, original);
  const starts = gateStarts();
  // Same parent, tree and patch as the owed head; another message, so it is never the owed commit by a same-second clock.
  const sameShape = commitOn(repo, obligation.base, { "src/board/summarize.ts": "export const summarize = 2;\n" }, "feature (sibling)");
  expect(sameShape).not.toBe(obligation.head);
  commitOn(repo, sameShape, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  expect((await refused(journal, argv, repo)).out).toContain(`the owed head ${obligation.head} is not an ancestor of`);
  git(repo, "checkout", "-q", "--detach", obligation.head);
  git(repo, "commit", "-q", "--amend", "--no-gpg-sign", "-m", "feature (rewritten)");
  commitOn(repo, "HEAD", { "src/board/summarize.ts": "export const summarize = 3;\n" });
  expect((await refused(journal, argv, repo)).out).toContain(`the owed head ${obligation.head} is not an ancestor of`);
  // Ancestry overlays (D-2184 add.51): a replace ref or the legacy graft file grafting the owed head under a sibling fix
  // makes git's overlaid ancestry answer yes. Containment reads the commit objects alone, so each refuses with the recipe.
  const sib = commitOn(repo, obligation.base, { "src/board/summarize.ts": "export const summarize = 3;\n" }, "sibling fix (overlaid)");
  const graftFile = join(repo, ".git", "info", "grafts");
  const overlays: Array<[string, () => void, () => void]> = [
    ["replace ref", () => git(repo, "replace", "--graft", sib, obligation.head), () => git(repo, "replace", "-d", sib)],
    ["graft file", () => writeFileSync(graftFile, `${sib} ${obligation.head}\n`), () => rmSync(graftFile)],
  ];
  const overlaidAncestry = () => spawnSync("git", ["merge-base", "--is-ancestor", obligation.head, sib], { cwd: repo }).status;
  for (const [name, add, remove] of overlays) {
    add();
    try {
      expect(overlaidAncestry(), name).toBe(0); // the control: the overlay is live and git's own ancestry says yes
      const overlaid = await refused(journal, argv, repo);
      expect(overlaid.code, name).toBe(2);
      expect(overlaid.out).toContain(`the owed head ${obligation.head} is not an ancestor of ${sib}`);
      for (const line of recipe(obligation)) expect(overlaid.out).toContain(line);
    } finally {
      remove();
    }
    expect(overlaidAncestry(), name).toBe(1);
  }
  // A fix above another task's integration merge measures a base past the owed base.
  const other = commitOn(repo, obligation.base, { "src/other.ts": "another task\n" }, "another task");
  git(repo, "checkout", "-q", "--detach", fixHead);
  git(repo, "merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "integrate", other);
  expect((await refused(journal, ["--record", RUN, "--task", "T1", "--base", other, "--supersede", obligation.id, "--author", "human", "--no-acceptance"], repo)).out)
    .toContain(`does not precede the owed base ${obligation.base}`);
  // The historical hand fix: outside the owed ancestry and outside the recorded allowlist. The refusal stands, and
  // the same range is independently scope-red on the original allowlist.
  const handFix = commitOn(repo, obligation.base, { "src/board/summarize.ts": "export const summarize = 9;\n", "src/other.ts": "hand\n", "README.md": "hand\n" }, "hand fix");
  const hand = await refused(journal, argv, repo);
  expect(hand.out).toContain(`the owed head ${obligation.head} is not an ancestor of ${handFix}`);
  for (const line of recipe(obligation)) expect(hand.out).toContain(line);
  expect(gateStarts()).toBe(starts);
  saveGraph(repo, graphOf(FILES));
  const scope = await verify(["--base", "main", "--task", "T1", "--no-review", "--no-acceptance", "--json"], repo);
  expect(JSON.parse(scope.out).results).toEqual(expect.arrayContaining([expect.objectContaining({ gate: "scope", pass: false })]));

  // The replayed run snapshot binds both fields even though the current graph holds another spec.
  saveGraph(repo, graphOf(["src/**"], ["changed"]));
  git(repo, "checkout", "-q", "--detach", fixHead);
  fresh(repo);
  const chosen = await verify(argv, repo);
  expect(chosen.code, chosen.out).toBe(0);
  const proof = journal.read().find((row) => row.event === "owed-check-superseded")!;
  expect(JSON.parse(readFileSync(join(journal.dir, String(proof.data.artifactPath)), "utf8"))).toMatchObject({ files: FILES, criteria: obligation.criteria });

  // After a graph-changed engagement the snapshot no longer binds, but the current compiled graph binds both fields;
  // containment equality at both endpoints (HEAD is the owed head) is accepted under the same proof.
  const graphChanged = await owedReview();
  writeFileSync(join(graphChanged.journal.dir, "graph.json"), JSON.stringify(graphOf(["src/**"])));
  git(graphChanged.repo, "checkout", "-q", "--detach", graphChanged.obligation.head);
  const equal = await verify(supersede(graphChanged.obligation), graphChanged.repo);
  expect(equal.code, equal.out).toBe(0);
  expect(graphChanged.journal.read().find((row) => row.event === "owed-check-superseded")).toMatchObject({
    data: { mergeBase: graphChanged.obligation.base, head: graphChanged.obligation.head } });
}, 180_000);

test("status renders a superseded check as closed from its fixing head plus verify record after run end", async () => {
  const { repo, journal, obligation } = await owedReview();
  const fixHead = commitOn(repo, obligation.head, { "src/board/summarize.ts": "export const summarize = 3;\n" });
  const result = await verify(supersede(obligation), repo);
  expect(result.code, result.out).toBe(0);
  const events = journal.read();
  const closure = events.find((row) => row.event === "owed-check-superseded")!;
  // The historical run-end row keeps its own debt; current status reads the current fold.
  expect(events.find((row) => row.event === "run-end")!.data.owedChecks).toMatchObject({ debt: 1 });
  const closed = `closed — T1 review ${obligation.id} superseded from fixing head ${fixHead} — verify record ${String(closure.data.artifactPath)} sha256 ${String(closure.data.artifactSha256)}`;
  git(repo, "checkout", "-q", "main");
  const plain = await status([RUN], repo);
  expect(plain).toContain(closed);
  expect(plain).toContain("needs you: outstanding 0");
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const watched = await status([RUN, "--watch"], repo, { iterations: 1, sleep: async () => {} });
  write.mockRestore();
  expect(watched).toContain(closed);
  expect(watched).toContain("outstanding 0");
  // The one-line and strict JSON formats are unchanged and read the corrected current debt.
  const oneline = await status([RUN, "--oneline"], repo);
  expect(oneline).toContain("outstanding 0");
  expect(oneline).not.toContain("superseded from");
  expect(JSON.parse(await status([RUN, "--json"], repo)).verdict.outstanding).toEqual({ known: true, debt: 0, checks: [] });
}, 60_000);
