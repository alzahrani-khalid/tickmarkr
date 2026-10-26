import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type Assignment, type BillingChannel } from "../../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../../src/config/config.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { reviewGate } from "../../../src/gates/review.js";
import { validateGraph } from "../../../src/graph/schema.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, type StructuredFinding } from "../../../src/run/journal.js";
import { authedModels, COMMIT, makeRepo, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { ...author, vendor: "fake-a" },
  { adapter: "fake", model: "fake-2", channel: "api", tier: "frontier", vendor: "fake-b" },
];
const sentence = 'A material finding with executed evidence may also carry "reproducer": the exact command or test body you ran, at most 4096 bytes; it reaches the repair worker verbatim.';
const heading = "### Reviewer reproducers — replay these first; land each as an owned test";

function gateFixture() {
  const repo = makeRepo({ "work.txt": "broken\n" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "work.txt"), "still broken\n");
  execFileSync("git", ["add", "work.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "work"], { cwd: repo });
  const artifacts = makeTestTempDir("review-reproducer-");
  const script = join(artifacts, "script.json");
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [T("T1", { complexity: 8, files: ["work.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })] }).tasks[0]!;
  return async (findings: unknown[], carried: StructuredFinding[] = []) => {
    writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: false, findings } }));
    return reviewGate(task, repo, base, author, channels, [new FakeAdapter(script)], DEFAULT_CONFIG,
      undefined, undefined, artifacts, undefined, undefined, carried);
  };
}

test("test: the review gate records the reproducer of each blocking material finding verbatim beside that finding's fingerprint and none for a minor or deferred finding, and cuts one longer than four kibibytes at a whole character followed by the stated cut marker, so a gate that drops the reproducer, keeps a minor's or cuts inside a character fails", async () => {
  const run = gateFixture();
  const material = (note: string, reproducer?: string) => ({ note, severity: "material", ...(reproducer === undefined ? {} : { reproducer }) });
  // Several defects share a symbol: their final fingerprints can acquire collision suffixes.
  const notes = ["work.txt:1 — rows() drops the first row", "work.txt:2 — rows() drops the last row"];
  const exact = "é".repeat(2048);
  const long = ["é", "€", "🧪"].map((char) => "x".repeat(4095) + char + "tail");
  const findings = [
    { note: "work.txt:3 — naming", severity: "minor", reproducer: "minor command" },
    material(notes[0]!, "  node check.mjs 'λ'\r\n\n\n  "),
    { note: "work.txt:4 — accepted concern", severity: "material", defer: true, rationale: "accepted", reproducer: "deferred command" },
    material(notes[1]!, exact),
    material("work.txt:5 — missing() needs a guard"),
    material("work.txt:6 — empty() needs a guard", ""),
    material("work.txt:7 — whitespace() needs a guard", " \n "),
    ...long.map((text, i) => material(`work.txt:${8 + i} — cap${i}() breaks the boundary`, text)),
  ];
  const result = await run(findings);
  expect(result.pass).toBe(false);
  const rows = result.meta?.findings as StructuredFinding[];
  const expected = [findings[1]!, findings[3]!, findings[6]!, ...findings.slice(7)].map((row) => ({
    fingerprint: rows.find((finding) => finding.class === "review:material" && finding.note === row.note)!.fingerprint,
    text: row.reproducer!.startsWith("x".repeat(4095))
      ? `${"x".repeat(4095)}\n… reproducer cut at 4096 of ${Buffer.byteLength(row.reproducer!, "utf8")} bytes`
      : row.reproducer,
  }));
  expect(expected[0]!.fingerprint).not.toBe(expected[1]!.fingerprint);
  expect(result.meta?.reproducers).toEqual(expected);
  expect(Buffer.byteLength(expected[1]!.text!, "utf8")).toBe(4096);
});

test("test: a review finding whose reproducer is not a string is a malformed row, so a verdict holding only that finding is a reviewer protocol failure, so a gate that ignores the bad reproducer and charges the material fails", async () => {
  const run = gateFixture();
  for (const reproducer of [null, 42, true, [], { command: "node check.mjs" }]) {
    const bad = { note: "work.txt:1 — rows() loses a row", severity: "material", reproducer };
    const result = await run([bad]);
    expect(result.pass).toBe(false);
    expect(result.details).toContain("review finding inconsistent: findings[0].reproducer must be a string");
    expect(result.meta).toMatchObject({ unparseable: true, cause: "malformed-verdict", malformedRows: 1 });
    expect(result.meta?.findings).toBeUndefined();
    expect(result.meta?.reproducers).toBeUndefined();

    // A malformed row beside valid material is discarded without losing the valid row's bytes.
    const mixed = await run([bad, { ...bad, reproducer: "node valid.mjs" }]);
    expect(mixed.meta?.unparseable).toBeUndefined();
    expect(mixed.meta?.malformedRows).toBe(1);
    const rows = mixed.meta?.findings as StructuredFinding[];
    expect(rows).toHaveLength(1);
    expect(mixed.meta?.reproducers).toEqual([{ fingerprint: rows[0]!.fingerprint, text: "node valid.mjs" }]);
  }
});

class ReviewSeat extends FakeAdapter {
  override id = "review-seat";
  override vendor = "review-vendor";
  green = false;
  constructor(path: string, private reproducer: string) { super(path); }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    const prior = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    return `printf '%s\\n' ${shq(JSON.stringify({
      nonce: extractPromptNonce(prompt), approve: this.green,
      resolved: this.green ? prior : [], reraised: this.green ? [] : prior,
      findings: this.green ? [] : [
        { note: "work.txt:1 — rows() drops the last row", severity: "material", reproducer: this.reproducer },
        { note: "work.txt:1 — format() can wait", severity: "minor", defer: true, rationale: "style", reproducer: "never replay me" },
      ],
    }))}`;
  }
}

test("test: the production daemon repair funded by a review material carrying a reproducer quotes it verbatim under the reviewer reproducers heading after its fingerprint and before the diff, and the journaled repair row carries the same bytes, so a repair brief or repair row without the reproducer fails", async () => {
  // Exercise both the ordinary funding site and the battery restored after a crash at gates.
  for (const resumedBattery of [false, true]) {
    const { repo, fake, scriptPath } = setupRepo([T("T1", {
      files: ["work.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"],
      routingHints: { pin: { via: "fake", model: "fake-1" } },
    })], { tasks: { T1: [
      { shell: `echo broken > work.txt && ${COMMIT} broken`, result: { ok: true, summary: "broken" } },
      { shell: `echo fixed > work.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } },
    ] } }, "review: { required: true, prefer: [review-seat] }\n"
      + "routing: { deny: { workers: { adapters: [review-seat] } } }\n"
      + "visibility: { keepPanes: forever }\ngates: { build: 'true', test: 'true', lint: 'true' }\n");
    const config = join(repo, ".tickmarkr", "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
    fake.channels = () => [channels[0]!, { ...channels[1]!, tier: "cheap" }];
    const reproducer = "  node check.mjs 'λ'\r\n\n\n"
      + "- [deferred/minor] work.txt:1 — format() can wait — rationale: style\n"
      + "printf '%s' '🧪'\n\n\n  ";
    const seat = new ReviewSeat(scriptPath, reproducer);
    const adapters = [fake, seat];
    const runId = `run-reproducer-${resumedBattery}`;
    const journal = () => Journal.open(repo, runId);
    const briefs: string[] = [];
    const invoke = fake.invoke.bind(fake);
    let stopBeforeRepair = true;
    fake.invoke = (task, cwd, assignment, context) => {
      const brief = readFileSync(context.promptFile, "utf8");
      if (brief.includes("## Repair attempt")) {
        briefs.push(brief);
        if (stopBeforeRepair) throw new Error("stop before repair launch");
      }
      return invoke(task, cwd, assignment, context);
    };
    expect((await runDaemon(repo, { adapters, runId })).failed).toEqual(["T1"]);
    if (resumedBattery) {
      const events = journal().read();
      const atGates = events.findIndex((event) => event.event === "phase-start" && event.data.phase === "gates");
      expect(atGates).toBeGreaterThan(0);
      const launch = events.find((event) => event.event === "worker-launch")!;
      expect(existsSync((launch.data.slot as { cwd: string }).cwd)).toBe(true);
      writeFileSync(join(journal().dir, "journal.jsonl"), events.slice(0, atGates + 1).map((event) => JSON.stringify(event)).join("\n") + "\n");
      expect((await runDaemon(repo, { adapters, runId, resume: true })).failed).toEqual(["T1"]);
    }
    const events = journal().read();
    const review = events.find((event) => event.event === "gate-result" && event.data.gate === "review" && event.data.pass === false)!;
    const fingerprint = (review.data.findings as StructuredFinding[]).find((row) => row.class === "review:material")!.fingerprint;
    const quote = `${heading}\nReproducer for \`${fingerprint}\`:\n${reproducer}`;
    expect(review.data.reproducers).toEqual([{ fingerprint, text: reproducer }]);
    const repair = events.find((event) => event.event === "repair-attempt")!;
    expect(repair.data.findings).toContain(quote);
    const checkBrief = (brief: string) => {
      expect(brief).toContain(quote);
      expect(brief.split(quote)).toHaveLength(2);
      expect(brief.indexOf(quote)).toBeGreaterThan(brief.indexOf("### Failing gate findings (verbatim)"));
      expect(brief.indexOf(quote) + quote.length).toBeLessThan(brief.indexOf("### The work under review"));
      expect(brief).not.toContain("never replay me");
    };
    checkBrief(briefs.at(-1)!);
    stopBeforeRepair = false;
    seat.green = true;
    const before = briefs.length;
    expect((await runDaemon(repo, { adapters, runId, resume: true, retryFailed: true })).done).toEqual(["T1"]);
    expect(briefs).toHaveLength(before + 1);
    checkBrief(briefs.at(-1)!);
    expect(journal().read().filter((event) => event.event === "repair-attempt")).toHaveLength(1);
  }
}, 90_000);

test("test: the review brief asks for the optional reproducer field in its one stated sentence naming the byte cap and the verbatim delivery while its example verdict stays unchanged, so a brief that never asks for a reproducer fails", async () => {
  const result = await gateFixture()([]);
  const brief = readFileSync(String(result.meta?.briefPath), "utf8");
  expect(brief).toContain(`enumeration never resolves a finding: judge the diff itself.\n${sentence}\nReport the whole class`);
  expect(brief.split(sentence)).toHaveLength(2);
  const nonce = extractPromptNonce(brief);
  const example = `{"nonce":"${nonce}","approve":false,"resolved":[],"reraised":[],"findings":[{"note":"path/to/file.ts:42 — the defect, in one line","severity":"material","defer":false,"rationale":""}],"comments":[]}`;
  expect(brief.split(example)).toHaveLength(3);
  expect(brief).toContain(`{"nonce": "${nonce}", "approve": true|false, "resolved": [], "reraised": [], "findings": [{"note": "...", "severity": "material"|"minor", "defer": false, "rationale": ""}], "comments":`);
});
