import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { PLAIN_BANNER } from "../../src/brand.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { type GateVia, runLlmDetailed, REVIEW_FIRST_LIVENESS_MS, PROMPT_GLYPHS, reviewSeatOutput, setGateCpuAccountantFactoryForTests, resetGateCpuAccountantFactoryForTests, verdictNonceLine } from "../../src/gates/llm.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { runGates, type GateEvent } from "../../src/gates/run-gates.js";
import { reviewGate } from "../../src/gates/review.js";
import { classifyVerdictCause } from "../../src/gates/verdict-cause.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

class VerdictPane implements ExecutorDriver {
  id = "verdict-pane";
  interactive = false;
  private nonce = "";

  constructor(private readonly output: (nonce: string) => string) {}

  async slot(cwd: string, name: string): Promise<Slot> { return { id: name, name, cwd }; }
  async run(): Promise<void> {}
  async waitOutput(_slot: Slot, pattern: string): Promise<boolean> {
    this.nonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)?.[1] ?? "";
    return true;
  }
  async waitAgentStatus(): Promise<boolean> { return true; }
  async status(): Promise<"unknown"> { return "unknown"; }
  async read(): Promise<string> { return this.output(this.nonce); }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
  async worktree(): Promise<string> { return ""; }
}

const task = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{
    id: "T1", title: "review cause", goal: "separate silence from malformed participation",
    shape: "implement", complexity: 8, files: ["src/work.ts"], acceptance: ["works"],
  }],
}).tasks[0];

const author: Assignment = { adapter: "author", model: "author-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { ...author, vendor: "author-vendor" },
  { adapter: "fake", vendor: "review-vendor", model: "fake-2", channel: "api", tier: "frontier" },
];

function reviewer(): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-review-cause-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  return new FakeAdapter(script);
}

function repoWithCommit(): { repo: string; base: string } {
  const repo = makeRepo({ "src/work.ts": "export const value = 1;\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/work.ts"), "export const value = 2;\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

function via(driver: ExecutorDriver): GateVia {
  return {
    driver,
    nameFor: () => "review-cause",
    labelFor: () => "REVIEW T1",
  };
}

describe("review caller verdict cause", () => {
  test("test: a reviewer that runs past cfg.review.timeoutMs is killed at that value and its row names the configured milliseconds while the default is 900000 whereas a ceiling that ignores the key fails", async () => {
    class SlowReviewer extends FakeAdapter {
      override headlessCommand(): string { return "sleep 1"; }
    }
    const { repo, base } = repoWithCommit();
    const script = join(mkdtempSync(join(tmpdir(), "tickmarkr-review-timeout-")), "script.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const slow = new SlowReviewer(script);
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.review.timeoutMs = 25;
    const startedAt = Date.now();
    const row = await reviewGate(task, repo, base, author, channels, [slow], cfg);

    expect(DEFAULT_CONFIG.review.timeoutMs).toBe(900_000);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(row).toMatchObject({ pass: false, meta: { cause: "silent", timeoutMs: 25 } });
    expect(row.details).toContain("configured review timeout 25ms");
  });

  test("test: a reviewer killed at the ceiling carries cause timeout and a reviewer whose process exits nonzero with banner-only bytes carries cause startup-failure while a nonce-bearing but malformed verdict keeps cause malformed-verdict and an empty output keeps cause empty-output whereas a classifier that reads bytes alone fails", async () => {
    class ProcessReviewer extends FakeAdapter {
      constructor(scriptPath: string, private readonly command: string) { super(scriptPath); }
      headlessCommand(): string { return this.command; }
    }
    const nonce = "deadbeef";
    const script = join(mkdtempSync(join(tmpdir(), "tickmarkr-review-process-")), "script.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    const timed = await runLlmDetailed(new ProcessReviewer(script, "printf banner; sleep 1"), "fake-2", "review", process.cwd(), undefined, 20);
    const startup = await runLlmDetailed(new ProcessReviewer(script, "printf banner; exit 2"), "fake-2", "review", process.cwd(), undefined, 200);

    expect(timed.timedOut).toBe(true);
    expect(classifyVerdictCause(timed.output, nonce, "approve", timed)).toBe("timeout");
    expect(classifyVerdictCause(startup.output, nonce, "approve", startup)).toBe("startup-failure");
    expect(classifyVerdictCause(`{"nonce":"${nonce}","approve":true,broken`, nonce, "approve", { exitCode: 2 })).toBe("malformed-verdict");
    expect(classifyVerdictCause("", nonce, "approve", { exitCode: 0 })).toBe("empty-output");
  });

  test("the review caller branches on the cause, so a silent review is recorded as a dispatch failure rather than a rejection, while a structurally valid but malformed verdict still fails closed", async () => {
    const { repo, base } = repoWithCommit();
    const fake = reviewer();
    const silent = await reviewGate(
      task, repo, base, author, channels, [fake], DEFAULT_CONFIG,
      via(new VerdictPane((nonce) => `TICKMARKR_EXIT_${nonce}:0`)),
    );
    const malformed = await reviewGate(
      task, repo, base, author, channels, [fake], DEFAULT_CONFIG,
      via(new VerdictPane((nonce) => `{"nonce":"${nonce}","approve":true, definitely-not-json\nTICKMARKR_EXIT_${nonce}:0`)),
    );

    expect(silent.pass).toBe(false);
    expect(silent.meta?.cause).toBe("no-verdict");
    expect(silent.details).toMatch(/review dispatch failed/i);
    expect(silent.details).not.toMatch(/requested changes|approval rejected/i);

    expect(malformed.pass).toBe(false);
    expect(malformed.meta?.cause).toBe("malformed-verdict");
    expect(malformed.details).toMatch(/review output unparseable/i);
    expect(malformed.details).not.toMatch(/dispatch failed/i);
  });
});

const PREAMBLE = `export HERDR_WORKSPACE_ID='wZ'; export TICKMARKR_PANE_IDENTITY='review · T1 · attempt 0 · run-test'; bash /tmp/tickmarkr-llm-test/dispatch.sh
TICKMARKR_START_1234
${PLAIN_BANNER}
review · T1 · attempt 0 · run-test
`;

// Advance the transport's clock per requested wait; no actual 900-second processes or fake FS timers.
class ClockedPane extends VerdictPane {
  elapsed = 0;
  closed = 0;
  constructor(private text: string, private initialText = PREAMBLE.split("\n")[0]!) { super(() => text); }
  // The pre-wait read can catch the dispatch echo or a banner still being painted.
  initialRead = true;
  override async waitOutput(_slot: Slot, _pattern: string, timeoutMs = 0): Promise<boolean> {
    this.elapsed += timeoutMs;
    return false;
  }
  override async read(): Promise<string> {
    if (this.initialRead) {
      this.initialRead = false;
      return this.initialText;
    }
    return this.text;
  }
  override async close(): Promise<void> { this.closed++; }
}

// The beat is bytes-only: a moving or unmeasurable dispatch tree changes nothing.
const flatTree = () => ({ async start() {}, async stop() {}, read: () => ({ cpu: { ms: 40, resolutionMs: 10 }, gaps: 0 }) });
const busyTree = (pane: ClockedPane) => ({
  async start() {}, async stop() {}, read: () => ({ cpu: { ms: 40 + pane.elapsed, resolutionMs: 10 }, gaps: 0 }),
});

async function clockedReview(text: string, ceiling: number, artifacts?: string, initialText?: string, tree = flatTree) {
  const { repo, base } = repoWithCommit();
  const pane = new ClockedPane(text, initialText);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.review.timeoutMs = ceiling;
  const origin = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => origin + pane.elapsed);
  setGateCpuAccountantFactoryForTests(() => tree(pane));
  try {
    const row = await reviewGate(task, repo, base, author, channels, [reviewer()], cfg,
      { ...via(pane), keep: true }, [], artifacts);
    return { row, pane };
  } finally {
    clock.mockRestore();
    resetGateCpuAccountantFactoryForTests();
  }
}

// The initial read lands wherever the pane happens to be: on the dispatch echo, part-way through the
// banner rows, or on a complete banner whose identity line has not been painted yet. Every one of
// those is the harness writing, and the running byte count is a Math.max — a single capture counted
// wrong is retained for the whole call and buys a silent seat its full ceiling.
const MID_PAINT = [
  PREAMBLE.split("\n")[0]!,
  PLAIN_BANNER.split("\n").slice(0, 2).join("\n"),
  PLAIN_BANNER.split("\n").slice(0, 2).join("\n") + "\n\u2597\u2584 \u2584\u2588",
  // A pane read is line-terminated, so a row caught mid-word arrives with its own newline.
  PLAIN_BANNER.slice(0, PLAIN_BANNER.indexOf("verified wo") + "verified wo".length) + "\n",
  PLAIN_BANNER,
];

test("no read position inside the preamble measures a seat-authored byte", () => {
  // Hand-picked shapes only prove the positions someone thought of; the running Math.max means ONE
  // miscounted position is enough to hold a silent seat to its ceiling. Sweep every one of them, in
  // the three shapes a pane read returns: bare, after the dispatch echo, and newline-terminated.
  const echo = PREAMBLE.split("\n")[0]! + "\n";
  const counted: string[] = [];
  for (let n = 1; n <= PLAIN_BANNER.length; n++) {
    const partial = PLAIN_BANNER.slice(0, n);
    for (const capture of [partial, echo + partial, echo + partial + "\n"]) {
      if (reviewSeatOutput(capture, "test-nonce").length > 0) counted.push(JSON.stringify(capture));
    }
  }
  expect(counted).toEqual([]);
  // The boundary is the preamble's, not a ban on the banner's text: the seat's own first byte after
  // a COMPLETE preamble still counts, or the beat could never tell a working seat from a dead one.
  expect(reviewSeatOutput(PREAMBLE + "X", "test-nonce")).toBe("X");
});

// RULING-229-15: the FOURTH partial-capture edge in reviewSeatOutput. Hand-picked shapes prove only
// the positions someone thought of; this corpus sweeps EVERY read position of every preamble shape a
// pane can return — with and without the dispatch echo and START row, bare and line-terminated —
// and asserts zero seat bytes inside the preamble and the exact seat byte count once seat text follows.
test("test: every read position inside the harness preamble — dispatch echo, START row, banner, identity line — measures zero seat-authored bytes, and every position after it measures exactly the seat's own bytes up to the exit trailer, so a capture cut inside the identity line or the START row that counts the preamble fails", () => {
  const rawFixture = readFileSync(new URL("../fixtures/reviews/review-raw-T5-1788307566802.txt", import.meta.url), "utf8");
  const [exitRow, promptRow] = rawFixture.split("\n").slice(23, 25) as [string, string]; // lines 24–25 verbatim
  const nonce = /^TICKMARKR_EXIT_([0-9a-f]+):0$/.exec(exitRow)![1]!;
  expect(promptRow).toContain("➜");
  const echo = PREAMBLE.split("\n")[0]! + "\n";
  const start = "TICKMARKR_START_f1b35ee3-a90c-48be-bba5-11b041313ebd\n";
  const identity = "review · T2 · attempt 0 · run-x\n";
  const seat = `{"nonce": "${nonce}", "approve": true, "findings": [], "comments": []}\n`;
  const postlude = `${exitRow}\n${promptRow}\n`;
  const shapes: Record<string, { preamble: string; seat: string; postlude: string }> = {
    "banner + identity": { preamble: PLAIN_BANNER + "\n" + identity, seat: "", postlude: "" },
    "START + banner + identity": { preamble: start + PLAIN_BANNER + "\n" + identity, seat: "", postlude: "" },
    "echo + START + banner + identity": { preamble: echo + start + PLAIN_BANNER + "\n" + identity, seat: "", postlude: "" },
    "START + banner + identity + seat + trailer + prompt": { preamble: start + PLAIN_BANNER + "\n" + identity, seat, postlude },
    "headless, no banner": { preamble: "", seat, postlude: "" },
  };
  const swept: Record<string, number> = {};
  const wrong: string[] = [];
  for (const [name, { preamble, seat: seatText, postlude: post }] of Object.entries(shapes)) {
    const full = preamble + seatText + post;
    swept[name] = full.length;
    for (let n = 1; n <= full.length; n++) {
      const capture = full.slice(0, n);
      // A trailer row is complete once its exit code lands; until then it is the capture's last row and
      // counts as bytes (RULING-229-15 add.1: a last row "T" is the seat's byte, not the harness's).
      const trailerDone = preamble.length + seatText.length + exitRow.length;
      const expected = n <= preamble.length ? ""
        : n < trailerDone ? full.slice(preamble.length, n)
        : seatText.replace(/\n$/, ""); // the whole trailer row and the prompt after it
      // A pane read is line-terminated, so every position also arrives with its own newline.
      const terminated = capture.endsWith("\n") ? capture : capture + "\n";
      const expectedTerminated = expected === "" || n >= trailerDone ? expected
        : (capture.endsWith("\n") ? expected : expected + "\n");
      for (const [c, e] of [[capture, expected], [terminated, expectedTerminated]] as const) {
        const got = reviewSeatOutput(c, nonce);
        if (got !== e) wrong.push(`${name} @${n}: ${JSON.stringify(c.slice(-40))} → ${JSON.stringify(got)} expected ${JSON.stringify(e)}`);
      }
    }
  }
  expect(wrong).toEqual([]);
  // RULING-229-15 add.1: seat text that starts with a harness-looking byte, or that MENTIONS a marker
  // mid-prose, is seat text — every complete row counts unless it EQUALS a harness row. Exact bytes,
  // after each pane preamble and headless.
  // (A lone "T" as the capture's only row is the one ambiguous byte — a prefix of the START row — and
  // stays harness by the last-row rule; every longer "T…" row counts.)
  const seatTexts = [
    "The diff is sound.\n",
    "TICKMARKR is the harness name.\nSecond row.\n",
    "export default is unchanged.\n",
    "review the hunk at llm.ts:254.\n",
    "review\n",
    `{"nonce": "${nonce}", "approve": false}\n`,
    "▗▄ a glyph the seat quoted\n",
    "The marker TICKMARKR_START_deadbeef is printed by the harness, and TICKMARKR_PANE_IDENTITY= too.\n",
    "TICKMARKR_START_ alone mentioned mid-prose\nnext row\n",
  ];
  const seatWrong: string[] = [];
  for (const [name, { preamble }] of Object.entries(shapes)) {
    for (const text of seatTexts) {
      for (const capture of [preamble + text, preamble + text.replace(/\n$/, "") + "\n"]) {
        const got = reviewSeatOutput(capture, nonce);
        const want = capture.slice(preamble.length);
        if (got !== want) seatWrong.push(`${name} + ${JSON.stringify(text)} → ${JSON.stringify(got)}`);
      }
    }
  }
  expect(seatWrong).toEqual([]);
  // A headless/no-banner capture that is ONLY seat text starting with "T" counts in full.
  expect(reviewSeatOutput("The reviewer's first row\n", nonce)).toBe("The reviewer's first row\n");
  expect(Buffer.byteLength(reviewSeatOutput("The reviewer's first row\n", nonce))).toBe(25);
  // Every shape swept end to end: the corpus is the whole capture, never a hand-picked slice of it.
  for (const [name, { preamble, seat: seatText, postlude: post }] of Object.entries(shapes)) {
    expect(swept[name], name).toBe(preamble.length + seatText.length + post.length);
  }

  // RULING-229-15 add.2: stop modelling the preamble by hand — every REAL raw pane fixture is the
  // corpus. Each file verbatim, every read position from byte 1 through its identity row must
  // measure 0 (the prompt-prefixed dispatch re-echo rows included), and every position after it the
  // exact seat bytes up to the trailer; bare and line-terminated.
  const fixturesDir = new URL("../fixtures/reviews/", import.meta.url);
  const fixtures = readdirSync(fixturesDir).filter((f) => f.startsWith("review-raw-") && f.endsWith(".txt"));
  expect(fixtures.length).toBeGreaterThan(0);
  const fixtureWrong: string[] = [];
  const fixtureSwept: Record<string, number> = {};
  for (const file of fixtures) {
    const raw = readFileSync(new URL(file, fixturesDir), "utf8");
    const rows = raw.split("\n");
    const identityRow = rows.findIndex((r, i) => i > 0 && rows.slice(0, i).some((b) => b.includes("spec in, verified work out."))
      && /^(?:review\s*·|tickmarkr(?::|$))/.test(r.trim()));
    expect(identityRow, file).toBeGreaterThan(0);
    const preambleEnd = rows.slice(0, identityRow + 1).join("\n").length + 1;
    const exitIdx = rows.findIndex((r) => /^TICKMARKR_EXIT_[0-9a-f]+:\d+/.test(r));
    const fixtureNonce = /^TICKMARKR_EXIT_([0-9a-f]+):/.exec(rows[exitIdx]!)![1]!;
    const trailerStart = rows.slice(0, exitIdx).join("\n").length + 1;
    const trailerDone = trailerStart + `TICKMARKR_EXIT_${fixtureNonce}:0`.length;
    // Only the row shapes the sweep is about are asserted byte-exact here; the fixture's seat text is
    // sliced at every position too so a row of it that resembled a harness row would surface.
    for (let n = 1; n <= raw.length; n++) {
      const capture = raw.slice(0, n);
      const expected = n <= preambleEnd ? "" : n < trailerDone ? raw.slice(preambleEnd, n) : raw.slice(preambleEnd, trailerStart - 1);
      const terminated = capture.endsWith("\n") ? capture : capture + "\n";
      const expectedTerminated = expected === "" || n >= trailerDone ? expected : (capture.endsWith("\n") ? expected : expected + "\n");
      for (const [c, e] of [[capture, expected], [terminated, expectedTerminated]] as const) {
        const got = reviewSeatOutput(c, fixtureNonce);
        if (got !== e) fixtureWrong.push(`${file} @${n} (row ${c.slice(0, n).split("\n").length}): ${JSON.stringify(c.slice(-30))} → ${got.length} bytes, expected ${e.length}`);
      }
    }
    fixtureSwept[file] = raw.length;
  }
  expect(fixtureWrong.slice(0, 20)).toEqual([]);
  // The material's own cuts: the third row (prompt-prefixed identity re-echo) at 1, 5, 20 and 60 chars.
  const fixture = readFileSync(new URL("../fixtures/reviews/review-raw-T5-1788307566802.txt", import.meta.url), "utf8");
  const thirdRowStart = fixture.split("\n").slice(0, 2).join("\n").length + 1;
  expect(fixture.slice(thirdRowStart, thirdRowStart + 2)).toBe("➜ ");
  for (const cut of [1, 5, 20, 60]) {
    expect(reviewSeatOutput(fixture.slice(0, thirdRowStart + cut), nonce), `cut ${cut}`).toBe("");
    expect(reviewSeatOutput(fixture.slice(0, thirdRowStart + cut) + "\n", nonce), `cut ${cut} terminated`).toBe("");
  }
  // Seat prose that begins with the prompt glyph but is NOT followed by a harness opener still counts.
  expect(reviewSeatOutput("➜  the arrow the seat typed is prose\nmore\n", nonce)).toBe("➜  the arrow the seat typed is prose\nmore\n");
  // RULING-229-15 add.3: an opener MENTIONED mid-prose and a non-prompt glyph lead are the seat's bytes
  // in full, headless and after every pane preamble; a bare or prompt-prefixed PARTIAL opener stays 0.
  const seatOwn = [
    "The shell printed export HERDR_WORKSPACE_ID=value\n",
    "✅ approved\n",
    "✔ done\n",
    "— note\n",
    "see printf '%s%s\\n' 'TICKMARKR_START_' in the log\n",
  ];
  const ownWrong: string[] = [];
  for (const text of seatOwn) {
    for (const [name, { preamble }] of Object.entries(shapes)) {
      for (const capture of [preamble + text, preamble + text.replace(/\n$/, "")]) {
        const got = reviewSeatOutput(capture, nonce);
        if (got !== capture.slice(preamble.length)) ownWrong.push(`${name} + ${JSON.stringify(text)} → ${JSON.stringify(got)}`);
      }
    }
  }
  expect(ownWrong).toEqual([]);
  expect(Buffer.byteLength(reviewSeatOutput("✅ approved\n", nonce))).toBe(Buffer.byteLength("✅ approved\n"));
  for (const partial of ["➜  tkr export HERDR_WORK", "export HERDR_WORK", "➜  tkr git:(main) printf '%s%s\\n' 'TICKMARKR_ST"]) {
    expect(reviewSeatOutput(partial, nonce), partial).toBe("");
    expect(reviewSeatOutput(partial + "\n", nonce), `${partial} terminated`).toBe("");
  }
  expect(Object.values(fixtureSwept).every((n) => n > 1000)).toBe(true);

  // RULING-229-15 add.4: the prompted dispatch-echo row is ONE grammar. GENERATE its full first rows —
  // every prompt shape × both dispatch rows — and sweep EVERY prefix, bare and line-terminated: each is
  // a partial paint of a harness row and measures 0. A cut inside the git segment ("➜  repo g",
  // "➜  repo git:") is the class the sole real fixture could not show, its rows carrying no git segment.
  const identityExportRow = PREAMBLE.split("\n")[0]!;
  const startPrintfRow = "printf '%s%s\\n' 'TICKMARKR_START_' 'f1b35ee3-a90c-48be-bba5-11b041313ebd' > '/tmp/tickmarkr-dispatch-f1b35ee3.ack' || exit 1; printf '%s%s\\n' 'TICKMARKR_START_' 'f1b35ee3-a90c-48be-bba5-11b041313ebd'; bash '/tmp/tickmarkr-llm-x/dispatch.sh'";
  // Every glyph of the closed set, bare and with a git segment, plus the unprompted row.
  const prompts = ["", ...PROMPT_GLYPHS.flatMap((g) => [`${g}  repo `, `${g} repo git:(fix/x) `])];
  const promptedWrong: string[] = [];
  let promptedSwept = 0;
  for (const prompt of prompts) {
    for (const echoRow of [identityExportRow, startPrintfRow]) {
      const row = prompt + echoRow;
      for (let n = 1; n <= row.length; n++) {
        for (const capture of [row.slice(0, n), row.slice(0, n) + "\n"]) {
          promptedSwept++;
          const got = reviewSeatOutput(capture, nonce);
          if (got !== "") promptedWrong.push(`${JSON.stringify(capture)} → ${got.length} bytes`);
        }
      }
    }
  }
  expect(promptedWrong.slice(0, 20)).toEqual([]);
  expect(promptedSwept).toBe(prompts.reduce((sum, p) => sum + 2 * (2 * p.length + identityExportRow.length + startPrintfRow.length), 0));
  // Seat rows that begin like the git segment but sit outside the grammar count in full, headless.
  for (const own of ["git status shows clean\n", "g\n", "git:(main) is my branch\n", "gi\n", "git:\n"]) {
    expect(reviewSeatOutput(own, nonce), own).toBe(own);
  }
});

test("terminal output after the exit trailer is not counted as reviewer output", () => {
  const raw = readFileSync(new URL("../fixtures/reviews/review-raw-T5-1788307566802.txt", import.meta.url), "utf8");
  const nonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(raw)![1]!;
  const response = raw.indexOf("```json\n", raw.indexOf("spec in, verified work out."));
  const trailer = raw.indexOf(`TICKMARKR_EXIT_${nonce}:`, response);
  const silentCapture = raw.slice(0, response) + raw.slice(trailer);

  expect(silentCapture.slice(silentCapture.indexOf(`TICKMARKR_EXIT_${nonce}:`))).toContain("\n➜");
  expect(reviewSeatOutput(silentCapture, nonce)).toBe("");
  expect(Buffer.byteLength(reviewSeatOutput(silentCapture, nonce))).toBe(0);
});

test("a capture before the banner identity finishes cannot buy a silent review its full ceiling", async () => {
  for (const initial of MID_PAINT) {
    const { row, pane } = await clockedReview(PREAMBLE, 900_000, undefined, initial);
    expect(row.meta).toMatchObject({ cause: "launch-never-started", seatAuthoredBytes: 0 });
    expect(pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
  }
});

test("a seat with no bytes of its own is re-routed at the beat whatever the dispatch tree's CPU says", async () => {
  const busy = await clockedReview(PREAMBLE, 900_000, undefined, undefined, busyTree);
  expect(busy.row.meta).toMatchObject({ cause: "launch-never-started", seatAuthoredBytes: 0 });
  expect(busy.pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
  // Unmeasurable CPU evidence is not a hold-open signal either.
  const unmeasured = await clockedReview(PREAMBLE, 900_000, undefined, undefined,
    () => ({ async start() {}, async stop() {}, read: () => ({ cpu: undefined, gaps: 1 }) }));
  expect(unmeasured.row.meta?.cause).toBe("launch-never-started");
  expect(unmeasured.pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
});

test("a silent review whose ceiling coincides with first liveness is a silent ceiling kill", async () => {
  const { row, pane } = await clockedReview(PREAMBLE, REVIEW_FIRST_LIVENESS_MS);
  expect(row.meta).toMatchObject({ cause: "silent", seatAuthoredBytes: 0, timeoutMs: REVIEW_FIRST_LIVENESS_MS });
  expect(row.meta?.unparseable).toBeUndefined();
  expect(pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
  expect(pane.closed).toBe(1);
});

test("test: a pane review seat whose capture holds only the harness preamble through the pane-identity line is re-routed at the first-liveness beat with cause launch-never-started and seat-authored bytes 0 while a seat that has emitted one byte of its own by that beat runs on to its ceiling, so a seat whose preamble bytes are counted as output and runs 900 s before re-routing fails", async () => {
  const silent = await clockedReview(PREAMBLE, 900_000);
  expect(silent.row.meta).toMatchObject({ cause: "launch-never-started", seatAuthoredBytes: 0, infra: true });
  expect(silent.row.meta?.unparseable).toBeUndefined();
  expect(silent.pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
  expect(silent.pane.closed).toBe(1);
  const { repo, base } = repoWithCommit();
  class ReplacementPane extends ClockedPane {
    seats = 0;
    private replacementNonce = "";
    override async slot(cwd: string, name: string): Promise<Slot> {
      this.seats++;
      return super.slot(cwd, name);
    }
    override async waitOutput(slot: Slot, pattern: string, timeoutMs = 0): Promise<boolean> {
      if (this.seats === 1) return super.waitOutput(slot, pattern, timeoutMs);
      this.replacementNonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)![1]!;
      return true;
    }
    override async read(): Promise<string> {
      if (this.seats === 1) return super.read();
      return JSON.stringify({ nonce: this.replacementNonce, approve: true, findings: [] });
    }
  }
  const pane = new ReplacementPane(PREAMBLE);
  const clock = vi.spyOn(Date, "now").mockImplementation(() => 1_800_000_000_000 + pane.elapsed);
  const events: GateEvent[] = [];
  setGateCpuAccountantFactoryForTests(() => flatTree());
  try {
    const replacement = Object.assign(reviewer(), { id: "replacement", vendor: "replacement-vendor" });
    const round = await runGates({ ...task, gates: ["review"] }, {
      worktree: repo, baseRef: base, author, channels: [...channels,
        { adapter: "replacement", vendor: "replacement-vendor", model: "replacement-1", tier: "cheap", channel: "sub" }],
      adapters: [reviewer(), replacement], cfg: DEFAULT_CONFIG, commands: {},
      baseline: await captureBaseline(repo, {}), result: { ok: true, summary: "work", raw: "", deviations: [] },
      via: via(pane), onGate: (event) => { events.push(event); },
    });
    expect(pane.seats).toBe(2);
    expect(pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
    expect(round.results.find((row) => row.gate === "review")).toMatchObject({ pass: true,
      meta: { reviewRetry: { flaked: "fake:fake-2", retried: "replacement:replacement-1" } } });
    expect(events.find((event) => event.phase === "note" && event.name === "review-no-verdict"))
      .toMatchObject({ payload: { cause: "launch-never-started", seatAuthoredBytes: 0 } });
  } finally {
    clock.mockRestore();
    resetGateCpuAccountantFactoryForTests();
  }
  // Preamble bytes counted as output is the criterion's named failure, and the initial read is where
  // it enters: a banner still painting has no tagline and no identity line to strip against.
  for (const initial of MID_PAINT) {
    const partial = await clockedReview(PREAMBLE, 900_000, undefined, initial);
    expect(partial.row.meta).toMatchObject({ cause: "launch-never-started", seatAuthoredBytes: 0, infra: true });
    expect(partial.pane.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
  }
  for (const byte of ["x", " "]) {
    const producing = await clockedReview(PREAMBLE + byte, 900_000);
    expect(producing.row.meta).toMatchObject({ cause: "truncated", seatAuthoredBytes: 1 });
    expect(producing.pane.elapsed).toBe(900_000);
    expect(producing.pane.closed).toBe(1);
  }
  // A seat whose own first byte lands mid-paint still owns its ceiling: the boundary excludes the
  // preamble, it does not swallow the response that follows it.
  const early = await clockedReview(PREAMBLE + "I am inspecting the diff", 900_000, undefined, MID_PAINT[1]);
  expect(early.row.meta).toMatchObject({ cause: "truncated" });
  expect(early.pane.elapsed).toBe(900_000);
});

test("test: a reviewer killed at the ceiling after emitting prose is recorded cause truncated and one killed with no seat-authored bytes cause silent, each with its raw and the review brief persisted under the run dir and neither carrying unparseable, while a malformed nonce-bound verdict still carries unparseable, so a ceiling kill recorded as unparseable output fails", async () => {
  const artifacts = mkdtempSync(join(tmpdir(), "tickmarkr-review-artifacts-"));
  for (const [text, cause] of [[PREAMBLE + "I am inspecting the implementation", "truncated"], [PREAMBLE, "silent"]]) {
    // A ceiling shorter than the first beat covers the silent ceiling-kill path.
    const { row } = await clockedReview(text!, 10_000, artifacts);
    expect(row.meta?.cause).toBe(cause);
    expect(row.meta?.unparseable).toBeUndefined();
    expect(row.meta?.infra).toBe(true);
    expect(String(row.meta?.rawPath).startsWith(artifacts + "/")).toBe(true);
    expect(readFileSync(String(row.meta?.rawPath), "utf8")).toBe(text);
    expect(String(row.meta?.briefPath).startsWith(artifacts + "/")).toBe(true);
    expect(readFileSync(String(row.meta?.briefPath), "utf8")).toContain("## Acceptance criteria");
  }
  const { repo, base } = repoWithCommit();
  const malformed = await reviewGate(task, repo, base, author, channels, [reviewer()], DEFAULT_CONFIG,
    via(new VerdictPane((nonce) => `{"nonce":"${nonce}","approve":true, broken\nTICKMARKR_EXIT_${nonce}:0`)));
  expect(malformed.meta).toMatchObject({ cause: "malformed-verdict", unparseable: true });
  expect(malformed.meta?.infra).toBeUndefined();
});

test("test: a headless review seat whose only output is whitespace counts zero seat-authored bytes and is classified silent, while one non-whitespace byte counts one, so a lone newline that escapes demotion fails", async () => {
  class CommandReviewer extends FakeAdapter {
    constructor(scriptPath: string, private readonly cmd: string) { super(scriptPath); }
    override headlessCommand(): string { return this.cmd; }
  }
  const { repo, base } = repoWithCommit();
  const script = join(mkdtempSync(join(tmpdir(), "tickmarkr-headless-bytes-")), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));

  // The timeout below is a budget for the slowest runner (spawning bash -l on a loaded host
  // takes >25 ms; the process must overrun the ceiling after emitting its initial byte).
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.review.timeoutMs = 300;

  // 1. Whitespace only (newline):
  const whitespace = new CommandReviewer(script, "printf '\\n'; sleep 1");
  const demotedWhitespace = new Set<string>();
  const whitespaceRow = await reviewGate(task, repo, base, author, channels, [whitespace], cfg,
    undefined, undefined, undefined, undefined, demotedWhitespace);
  expect(whitespaceRow.meta).toMatchObject({ cause: "silent", seatAuthoredBytes: 0 });

  const events: GateEvent[] = [];
  const demotedSet = new Set<string>();
  await runGates({ ...task, gates: ["review"] }, {
    worktree: repo, baseRef: base, author, channels,
    adapters: [whitespace], cfg, commands: {},
    baseline: await captureBaseline(repo, {}),
    result: { ok: true, summary: "work", raw: "", deviations: [] },
    demotedReviewers: demotedSet,
    onGate: (e) => { events.push(e); },
  });
  expect(demotedSet.has("fake:fake-2")).toBe(true);
  expect(events.some((e) => e.phase === "note" && e.name === "review-pool-demotion")).toBe(true);

  // 2. One non-whitespace byte:
  const nonWhitespace = new CommandReviewer(script, "printf 'x'; sleep 1");
  const demotedNonWhitespace = new Set<string>();
  const nonWhitespaceRow = await reviewGate(task, repo, base, author, channels, [nonWhitespace], cfg,
    undefined, undefined, undefined, undefined, demotedNonWhitespace);
  expect(nonWhitespaceRow.meta).toMatchObject({ cause: "truncated", seatAuthoredBytes: 1 });

  const nonWhitespaceEvents: GateEvent[] = [];
  const nonWhitespaceDemotedSet = new Set<string>();
  await runGates({ ...task, gates: ["review"] }, {
    worktree: repo, baseRef: base, author, channels,
    adapters: [nonWhitespace], cfg, commands: {},
    baseline: await captureBaseline(repo, {}),
    result: { ok: true, summary: "work", raw: "", deviations: [] },
    demotedReviewers: nonWhitespaceDemotedSet,
    onGate: (e) => { nonWhitespaceEvents.push(e); },
  });
  expect(nonWhitespaceDemotedSet.has("fake:fake-2")).toBe(false);
  expect(nonWhitespaceEvents.some((e) => e.phase === "note" && e.name === "review-pool-demotion")).toBe(false);
});

test("test: a judge pane that times out under keep stays open while a review seat that times out is closed, so a timed-out judge pane closed under keep fails", async () => {
  const nonce = "12345678";
  const judgePrompt = `TICKMARKR-JUDGE\n${verdictNonceLine(nonce)}`;
  const reviewPrompt = `TICKMARKR-REVIEW\n${verdictNonceLine(nonce)}`;

  const judgePane = new ClockedPane(PREAMBLE);
  const judgeOrigin = Date.now();
  const judgeClock = vi.spyOn(Date, "now").mockImplementation(() => judgeOrigin + judgePane.elapsed);
  try {
    await runLlmDetailed(
      reviewer(), "fake-1", judgePrompt, process.cwd(),
      { driver: judgePane, name: "judge", label: "JUDGE", keep: true },
      100,
    );
  } finally {
    judgeClock.mockRestore();
  }
  expect(judgePane.elapsed).toBeGreaterThanOrEqual(100);
  expect(judgePane.closed).toBe(0);

  const reviewPane = new ClockedPane(PREAMBLE);
  const reviewOrigin = Date.now();
  const reviewClock = vi.spyOn(Date, "now").mockImplementation(() => reviewOrigin + reviewPane.elapsed);
  try {
    await runLlmDetailed(
      reviewer(), "fake-1", reviewPrompt, process.cwd(),
      { driver: reviewPane, name: "review", label: "REVIEW", keep: true },
      100,
    );
  } finally {
    reviewClock.mockRestore();
  }
  expect(reviewPane.elapsed).toBeGreaterThanOrEqual(100);
  expect(reviewPane.closed).toBe(1);
});
