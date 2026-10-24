import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { renderMarkdownRecord } from "../../src/cli/commands/report.js";
import { verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { getVerdictStore } from "../../src/gates/cache.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { foldOwedChecks, Journal, owedSubject, type OwedCheck } from "../../src/run/journal.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const recordArgs = ["--base", "main", "--task", "T1", "--no-acceptance", "--record", "run-discharge", "--json"];

afterEach(() => {
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  vi.restoreAllMocks();
});

async function owedReview(integration = false) {
  const runId = "run-discharge";
  const repo = makeRepo({ "src.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["src.txt"] })] }));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), "judge: { adapter: fake, model: fake-1 }\n");
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  const script = join(makeTestTempDir("discharge-script-"), "script.json");
  const reviewVerdict = (green: boolean) => writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: green, issues: green ? [] : ["defect"] } }));
  reviewVerdict(true);
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});

  git(repo, "branch", `tickmarkr/${runId}`, "main");
  git(repo, "checkout", "-b", `tickmarkr/${runId}--T1`);
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  git(repo, "add", "src.txt");
  git(repo, "commit", "--no-gpg-sign", "-m", "feature");
  const head = git(repo, "rev-parse", "HEAD");
  const base = git(repo, "rev-parse", "main");
  git(repo, "checkout", "main");
  const journal = Journal.create(repo, runId);
  journal.append("run-start", undefined, { baseRef: "main" });
  journal.append("task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  journal.append("gate-result", "T1", { gate: "review", pass: false, details: "red", commit: owedSubject(repo, base, head) });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision" });
  await approve([runId, "T1", "--waive", "--by", "operator", "--reason", "D-2134"], repo);
  const obligation = journal.read().find((row) => row.event === "task-approved")!.data.obligation as OwedCheck;
  expect(obligation).toMatchObject({ known: true, gate: "review", authors: ["fake:fake-1"] });
  if (integration) {
    git(repo, "checkout", `tickmarkr/${runId}`);
    git(repo, "merge", "--no-ff", `tickmarkr/${runId}--T1`, "-m", "merge T1");
    journal.append("merge", "T1", { commit: git(repo, "rev-parse", "HEAD") });
  } else git(repo, "checkout", "--detach", head);
  journal.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });
  return { repo, journal, runId, obligation, reviewVerdict };
}

function runFiles(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).filter((file) => statSync(join(dir, file)).isFile())
    .map((file) => [file, readFileSync(join(dir, file)).toString("base64")]));
}

test("test: verify with record discharging an owed review check writes its proof under the run's own directory, records that proof relative to the run directory, and after the temporary verify state is deleted the run's owed checks still read known with no debt, so a proof kept only in the temporary directory fails", async () => {
  const { repo, journal, obligation } = await owedReview();
  const result = await verify(recordArgs, repo);
  expect(result.code, result.out).toBe(0);
  const report = JSON.parse(result.out);
  const row = journal.read().find((event) => event.event === "owed-check-discharged")!;
  const recorded = String(row.data.artifactPath);
  expect(isAbsolute(report.artifactPath)).toBe(true);
  expect(isAbsolute(recorded)).toBe(false);
  expect(recorded).toBe(join("discharges", `${report.artifactSha256}.json`));
  const bytes = readFileSync(join(journal.dir, recorded));
  expect(bytes).toEqual(readFileSync(report.artifactPath));
  expect(row.data.artifactSha256).toBe(digest(bytes));
  expect(console.error).toHaveBeenCalledWith(`verify: artifacts written to ${report.artifactPath}`);
  rmSync(verifyStateDir(repo), { recursive: true });
  expect(existsSync(report.artifactPath)).toBe(false);
  expect(foldOwedChecks(Journal.open(repo, journal.runId).read(), repo)).toMatchObject({ known: true, debt: 0, outstanding: [], discharged: [obligation.id] });
}, 60_000);

test("test: the run's durable proof deleted reads unknown with the artifact unavailable, the proof altered by one byte reads unknown with a hash mismatch, and a legacy discharge row naming an absolute temporary path is read exactly as before, so a fold that trusts a missing or edited proof or migrates old rows fails", async () => {
  const { repo, journal } = await owedReview();
  const result = await verify(recordArgs, repo);
  expect(result.code, result.out).toBe(0);
  const report = JSON.parse(result.out);
  const events = journal.read();
  const discharge = events.find((row) => row.event === "owed-check-discharged")!;
  const path = join(journal.dir, String(discharge.data.artifactPath));
  const bytes = readFileSync(path);
  const unknown = (reason: string) => expect(foldOwedChecks(events, repo)).toMatchObject({ known: false, debt: "unknown", unknown: [{ reason }] });
  rmSync(path);
  unknown("artifact unavailable");
  writeFileSync(path, bytes);
  expect(foldOwedChecks(events, repo)).toMatchObject({ known: true, debt: 0 });
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  writeFileSync(path, altered);
  unknown("artifact hash mismatch");

  const legacy = events.map((row) => row === discharge ? { ...row, data: { ...row.data, artifactPath: report.artifactPath } } : row);
  const original = JSON.stringify(legacy);
  expect(foldOwedChecks(legacy, repo)).toMatchObject({ known: true, debt: 0 });
  writeFileSync(path, bytes);
  rmSync(report.artifactPath);
  expect(foldOwedChecks(legacy, repo)).toMatchObject({ known: false, debt: "unknown", unknown: [{ reason: "artifact unavailable" }] });
  expect(JSON.stringify(legacy)).toBe(original);
  expect(foldOwedChecks(events, repo)).toMatchObject({ known: true, debt: 0 });
}, 60_000);

test("test: after the repository is moved to another directory, and from a linked checkout with no local state, the discharged check still reads known with no debt, so an absolute recorded path or a fold that resolves only this checkout's state fails", async () => {
  const { repo, journal, runId, obligation } = await owedReview(true);
  const linked = join(makeTestTempDir("discharge-linked-"), "checkout");
  git(repo, "worktree", "add", "--detach", linked, "HEAD");
  try {
    expect(existsSync(join(linked, ".tickmarkr"))).toBe(false);
    const result = await verify(recordArgs, linked);
    expect(result.code, result.out).toBe(0);
    expect(journal.read().find((row) => row.event === "owed-check-discharged")!.data.mapping).toBe("integration");
    rmSync(verifyStateDir(linked), { recursive: true });
    expect(foldOwedChecks(journal.read(), linked)).toMatchObject({ known: true, debt: 0, discharged: [obligation.id] });
  } finally {
    git(repo, "worktree", "remove", "--force", linked);
  }
  const moved = join(makeTestTempDir("discharge-moved-"), "repository");
  renameSync(repo, moved);
  const movedJournal = Journal.open(moved, runId);
  expect(foldOwedChecks(movedJournal.read(), moved)).toMatchObject({ known: true, debt: 0, discharged: [obligation.id] });
  git(moved, "worktree", "add", "--detach", linked, "HEAD");
  try {
    expect(existsSync(join(linked, ".tickmarkr"))).toBe(false);
    expect(foldOwedChecks(movedJournal.read(), linked)).toMatchObject({ known: true, debt: 0, discharged: [obligation.id] });
    const neighbour = Journal.create(linked, "run-neighbour");
    neighbour.append("run-start", undefined, {});
    expect(foldOwedChecks(movedJournal.read(), linked)).toMatchObject({ known: true, debt: 0 });
    const localRun = Journal.create(linked, runId);
    localRun.append("run-start", undefined, {});
    expect(foldOwedChecks(movedJournal.read(), linked)).toMatchObject({ known: false, debt: "unknown", unknown: [{ reason: "artifact unavailable" }] });
  } finally {
    git(moved, "worktree", "remove", "--force", linked);
  }
}, 60_000);

test("test: verify without record, and a record whose verdict is red or whose discharge is refused, write nothing under the run directory and append no discharge row, while the review leg row a discharge appends names the same recorded proof so the report still shows it superseding the daemon review, so a fix that writes a run directory for every verify fails", async () => {
  const { repo, journal, obligation, reviewVerdict } = await owedReview();
  const before = runFiles(journal.dir);
  const noRecord = await verify(["--task", "T1", "--no-acceptance", "--json"], repo);
  expect(noRecord.code, noRecord.out).toBe(0);
  expect(runFiles(journal.dir)).toEqual(before);
  const refused = await verify([...recordArgs, "--no-review"], repo);
  expect(refused.code).toBe(2);
  expect(refused.out).toContain("requires the review gate");
  expect(runFiles(journal.dir)).toEqual(before);
  getVerdictStore(join(repo, ".tickmarkr")).clear();
  reviewVerdict(false);
  const red = await verify(recordArgs, repo);
  expect(red.code, red.out).toBe(2);
  expect(JSON.parse(red.out).green).toBe(false);
  expect(existsSync(join(journal.dir, "discharges"))).toBe(false);
  expect(journal.read().filter((row) => row.event === "owed-check-discharged")).toEqual([]);
  expect(Object.keys(runFiles(journal.dir))).toEqual(Object.keys(before));

  getVerdictStore(join(repo, ".tickmarkr")).clear();
  reviewVerdict(true);
  const journalPath = join(journal.dir, "journal.jsonl");
  const original = readFileSync(journalPath);
  const unresolved = journal.read().map((row) => row.event === "task-approved"
    ? { ...row, data: { ...row.data, obligation: { ...obligation, declared: obligation.declared.filter((seat) => seat.key !== "fake:fake-2") } } } : row);
  writeFileSync(journalPath, unresolved.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const greenRefused = await verify(recordArgs, repo);
  expect(greenRefused.code, greenRefused.out).toBe(2);
  expect(JSON.parse(greenRefused.out)).toMatchObject({ green: true, owed: { refused: expect.stringContaining("unresolved reviewer") } });
  expect(existsSync(join(journal.dir, "discharges"))).toBe(false);
  expect(journal.read().filter((row) => row.event === "owed-check-discharged")).toEqual([]);
  writeFileSync(journalPath, original);

  const green = await verify(recordArgs, repo);
  expect(green.code, green.out).toBe(0);
  const events = journal.read();
  const discharge = events.find((row) => row.event === "owed-check-discharged")!;
  const leg2 = events.filter((row) => row.event === "review-leg2").at(-1)!;
  expect(leg2.data).toMatchObject({ artifactPath: discharge.data.artifactPath, artifactSha256: discharge.data.artifactSha256, artifactAvailability: "available" });
  rmSync(verifyStateDir(repo), { recursive: true });
  expect(renderMarkdownRecord(journal.runId, events, [], [], undefined, repo)).toContain(`review-leg2: pass (supersedes daemon review — validated discharge ${obligation.id})`);
}, 120_000);

test("D-2134 queue row 31 exclusively creates durable proofs, accepting identical existing bytes and refusing different existing bytes", async () => {
  const { repo, journal } = await owedReview();
  const errors = vi.mocked(console.error);
  for (const identical of [false, true]) {
    let durablePath = "";
    let existing = Buffer.alloc(0);
    let inode = 0;
    errors.mockImplementation((line: unknown) => {
      const prefix = "verify: artifacts written to ";
      if (!String(line).startsWith(prefix)) return;
      const bytes = readFileSync(String(line).slice(prefix.length));
      durablePath = join(journal.dir, "discharges", `${digest(bytes)}.json`);
      existing = identical ? bytes : Buffer.from("different bytes\n");
      mkdirSync(dirname(durablePath), { recursive: true });
      writeFileSync(durablePath, existing, { flag: "wx" });
      inode = statSync(durablePath).ino;
    });
    const result = await verify(recordArgs, repo);
    expect(result.code, result.out).toBe(identical ? 0 : 2);
    expect(readFileSync(durablePath)).toEqual(existing);
    expect(statSync(durablePath).ino).toBe(inode);
    expect(journal.read().filter((row) => row.event === "owed-check-discharged")).toHaveLength(identical ? 1 : 0);
    expect(foldOwedChecks(journal.read(), repo)).toMatchObject({ known: true, debt: identical ? 0 : 1 });
  }
}, 60_000);
