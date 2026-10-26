// v2.5.6 Leg-2 (OBS-1052): the daemon threads `reviewNoVerdicts` into GateContext. Without it
// run-gates' two-strike retirement (OBS-1025 add.2) is inert in production: a flaking seat is
// re-asked on every task and the review-recovery spend is unbounded. Fake adapters, zero tokens.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../../src/adapters/types.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { journaledFailureBrief, Journal } from "../../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo as baseSetupRepo, T } from "../../helpers/tmprepo.js";

// Queue row 34(a) (D-2134 R5): an independent judge below these fixtures' review floor.
function setupRepo(...args: Parameters<typeof baseSetupRepo>) {
  const fixture = baseSetupRepo(...args);
  const config = join(fixture.repo, ".tickmarkr", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
  return fixture;
}

// A review-only seat with its own adapter id and vendor. `prose` seats never emit a trailer.
class ReviewSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string, public override id: string, public override vendor: string, private prose = false) {
    super(path);
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(promptFile: string): string {
    this.calls++;
    if (this.prose) return "printf 'Review completed, but no structured verdict was returned.'";
    const nonce = extractPromptNonce(readFileSync(promptFile, "utf8"));
    return `printf '%s\\n' ${shq(JSON.stringify({ nonce, approve: true, issues: [] }))}`;
  }
}

const pin = { routingHints: { pin: { via: "fake", model: "fake-1" } } };
const work = (id: string) => [{ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } }];

test("Leg-2 (OBS-1052): a seat with no verdict on rounds 1 and 2 is absent from round 3's eligible set — the run's review dispatches stay bounded", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", pin), T("T2", { deps: ["T1"], ...pin }), T("T3", { deps: ["T2"], ...pin })],
    { tasks: { T1: work("t1"), T2: work("t2"), T3: work("t3") } },
    "review: { required: true, prefer: [seat-a, seat-b] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b] } } }\n",
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "fake-b", channel: "api", tier: "cheap" }];
  const flaky = new ReviewSeat(scriptPath, "seat-a", "vendor-a", true);
  const steady = new ReviewSeat(scriptPath, "seat-b", "vendor-b");
  const runId = "run-leg2-two-strike";
  const result = await runDaemon(repo, { adapters: [fake, flaky, steady], runId, concurrency: 1 });
  expect(result.done).toEqual(["T1", "T2", "T3"]);
  // strike on T1, strike on T2, retired for T3: the flaky seat is asked exactly twice in the run
  expect([flaky.calls, steady.calls]).toEqual([2, 3]);
  const events = Journal.open(repo, runId).read();
  expect(events.filter((e) => e.event === "review-no-verdict").map((e) => [e.taskId, e.data.reviewer])).toEqual([["T1", "seat-a:seat-a"], ["T2", "seat-a:seat-a"]]);
  expect(events.filter((e) => e.event === "review-pool-demotion").map((e) => [e.taskId, e.data.reviewer, e.data.causes]))
    .toEqual([["T2", "seat-a:seat-a", ["no-verdict", "no-verdict"]]]);
  const t3Review = events.filter((e) => e.taskId === "T3" && e.event === "gate-result" && e.data.gate === "review");
  expect(t3Review.map((e) => [e.data.reviewer, e.data.reviewRetry])).toEqual([["seat-b:seat-b", undefined]]);
}, 90_000);

// v2.6.8 T7 reverses T14's review half (OBS-1150): every reason stays a standing ruling for the repair
// worker, and none of them reaches a reviewer — the review grades the diff, never the operator's reason.
test("test: the daemon keeps every approval reason out of the released attempt's review rounds, reviewer failovers, its no worker recheck brief and a later engagement's rounds, so a reason reaching any review brief fails", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { ...pin, humanGate: true, files: ["t1.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })],
    { tasks: { T1: [
      { shell: `echo one > t1.txt && ${COMMIT} first`, result: { ok: true, summary: "first" } },
      { shell: `echo two > t1.txt && ${COMMIT} second`, result: { ok: true, summary: "second" } },
    ] } },
    "review: { required: true, prefer: [seat-a, seat-b, seat-c] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b, seat-c] } } }\n",
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "fake-b", channel: "api", tier: "cheap" }];
  const runId = "run-operator-review-context";
  const journal = () => Journal.open(repo, runId);
  const briefs: { seat: string; text: string; dispatches: number }[] = [];
  let green = false;
  let steadyRounds = 0;
  // Move the tip after the daemon captures its gated commit. A green first review then
  // forces another round of the SAME dispatch, which must still carry no reason.
  class MovingTipDriver extends SubprocessDriver {
    taskTree = "";
    moved = false;
    override async worktree(repo: string, branch: string, base: string) {
      const wt = await super.worktree(repo, branch, base);
      if (branch.endsWith("--T1")) this.taskTree = wt;
      return wt;
    }
    async project(_taskId: string, state: string) {
      if (state !== "in-review" || this.moved) return;
      this.moved = true;
      writeFileSync(join(this.taskTree, "t1.txt"), "one with concurrent tip movement\n");
      execSync("git add t1.txt && git commit --amend --no-edit --no-gpg-sign", { cwd: this.taskTree });
    }
  }
  const driver = new MovingTipDriver();
  const seats = ["seat-a", "seat-b", "seat-c"].map((id, i) => {
    const seat = new ReviewSeat(scriptPath, id, `vendor-${i}`);
    seat.headlessCommand = (file) => {
      const text = readFileSync(file, "utf8");
      briefs.push({ seat: id, text, dispatches: journal().read().filter((row) => row.event === "task-dispatch").length });
      // Exercise every in-gate reviewer failover.
      if (i < 2) return "printf 'No structured verdict available.'";
      const approveRound = green || ++steadyRounds === 1;
      const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
      return `printf '%s\\n' ${shq(JSON.stringify({
        nonce: extractPromptNonce(text), approve: approveRound,
        resolved: approveRound ? prior : [], reraised: approveRound ? [] : prior,
        findings: approveRound ? [] : [{ note: "t1.txt loses selection", severity: "material", ...(prior[0] ? { reraised: prior[0] } : {}) }],
      }))}`;
    };
    return seat;
  });
  const adapters = [fake, ...seats];
  expect((await runDaemon(repo, { adapters, runId })).human).toEqual(["T1"]);
  journal().append("task-approved", "T1", { reason: "Superseded operator reason" });
  journal().append("task-human", "T1", { kind: "human-gate", reason: "operator decision pending" });
  const reason = "Keep explicit selection; verify the prepend behavior.";
  await approve([runId, "T1", "--reason", reason, "--review-rounds", "1"], repo);
  expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
  expect(briefs.map((b) => b.seat)).toEqual(["seat-a", "seat-b", "seat-c", "seat-c"]);
  expect(journal().read().filter((e) => e.event === "tip-moved")).toHaveLength(1);
  for (const brief of briefs) {
    expect(brief.dispatches).toBe(1);
    expect(brief.text).not.toContain(`## Operator context`);
    expect(brief.text).not.toContain(reason);
    expect(brief.text).not.toContain("Superseded operator reason");
  }
  expect(journal().read().filter((e) => e.event === "review-no-verdict")).toHaveLength(2);
  const recheckStart = journal().read().length;
  const recheckBriefStart = briefs.length;
  const recheckReason = "Re-measure the same design against the selection criterion.";
  await approve([runId, "T1", "--recheck", "--reason", recheckReason, "--review-rounds", "1"], repo);
  expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).human).toEqual(["T1"]);
  const recheckRows = journal().read().slice(recheckStart);
  expect(recheckRows.some((e) => e.event === "recheck-battery")).toBe(true);
  expect(recheckRows.filter((e) => ["task-dispatch", "worker-launch"].includes(e.event))).toEqual([]);
  expect(briefs.length).toBeGreaterThan(recheckBriefStart);
  for (const brief of briefs.slice(recheckBriefStart)) {
    expect(brief.text).not.toContain(reason);
    expect(brief.text).not.toContain(recheckReason);
  }
  green = true;
  const laterStart = briefs.length;
  await approve([runId, "T1", "--uphold", "--review-rounds", "1"], repo);
  expect((await runDaemon(repo, { adapters, runId, resume: true, driver })).done).toEqual(["T1"]);
  expect(briefs.length).toBeGreaterThan(laterStart);
  for (const brief of briefs.slice(laterStart)) {
    expect(brief.dispatches).toBe(2);
    expect(brief.text).not.toContain(`## Operator context`);
    for (const ruling of [reason, recheckReason, "Superseded operator reason"]) expect(brief.text).not.toContain(ruling);
  }
  // Saved briefs must match the actual adapter delivery.
  const saved = journal().read().filter((e) => e.event === "gate-result" && e.data.gate === "review" && e.data.briefPath);
  expect(saved.length).toBeGreaterThanOrEqual(3);
  for (const row of saved) {
    const text = readFileSync(String(row.data.briefPath), "utf8");
    expect(briefs.some((brief) => brief.text === text)).toBe(true);
  }
}, 90_000);

// OBS-1150: an approval reason is a standing ruling on the task. Ruling A is spent by no launch, and a
// waive's gate-satisfied boilerplate neither joins the rulings nor retires one. v2.6.8 T7: the rulings
// are the worker's; no review brief carries them.
test("test: every production repair brief states the operator's standing rulings in their own block directly under the repair heading, oldest first, each exactly once and before the findings and the diff, for a review repair and for a test repair alike, so a ruling left after the diff or stated twice fails", async () => {
  const red = "test ! -f red.txt || { echo 'AssertionError: expected red.txt to be absent'; exit 1; }";
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { ...pin, humanGate: true, files: ["t1.txt", "red.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })],
    { tasks: { T1: [
      { shell: `echo one > t1.txt && ${COMMIT} one`, result: { ok: true, summary: "one" } },
      { shell: `echo two > t1.txt && touch red.txt && ${COMMIT} two`, result: { ok: true, summary: "two" } },
      { shell: `echo three > t1.txt && ${COMMIT} three`, result: { ok: true, summary: "three" } },
    ] } },
    `review: { required: true, prefer: [seat-a] }\nrouting: { deny: { workers: { adapters: [seat-a] } } }\ngates: { test: ${JSON.stringify(red)} }\n`,
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "fake-b", channel: "api", tier: "cheap" }];
  const workerBriefs: string[] = [];
  const invoke = fake.invoke.bind(fake);
  fake.invoke = (task, cwd, a, ctx) => {
    workerBriefs.push(readFileSync(ctx.promptFile, "utf8"));
    return invoke(task, cwd, a, ctx);
  };
  const reviewBriefs: string[] = [];
  let approveReview = false;
  const seat = new ReviewSeat(scriptPath, "seat-a", "vendor-a");
  seat.headlessCommand = (file) => {
    const text = readFileSync(file, "utf8");
    reviewBriefs.push(text);
    const nonce = extractPromptNonce(text);
    const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
    return `printf '%s\\n' ${shq(JSON.stringify(approveReview ? { nonce, approve: true, resolved: prior, reraised: [], findings: [] }
      : { nonce, approve: false, resolved: [], reraised: prior, findings: [{ note: "t1.txt must read three", severity: "material" }] }))}`;
  };
  const adapters = [fake, seat];
  const runId = "run-standing-rulings";
  const journal = () => Journal.open(repo, runId);
  const resume = () => runDaemon(repo, { adapters, runId, resume: true });
  const [A, B, W] = ["Ruling A: keep the explicit selection.", "Ruling B: t1.txt must read three.", "Gate satisfied: operator accepts the red test."];
  const inOrder = (brief: string, ...rows: string[]) => rows.map((row) => brief.indexOf(row)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!));

  expect((await runDaemon(repo, { adapters, runId })).human).toEqual(["T1"]);
  await approve([runId, "T1", "--reason", A, "--review-rounds", "1"], repo);
  expect((await resume()).human).toEqual(["T1"]); // launch 1 under A; the review upholds a material
  expect(workerBriefs).toHaveLength(1);
  expect(workerBriefs[0]).toContain(`approval: ${A}`);
  await approve([runId, "T1", "--uphold", "--reason", B, "--review-rounds", "1"], repo);
  // v2.6.7 T1 (closed order table): every candidate's review runs BEFORE its test payload — launch 2
  // (a review-material repair) is approved and its full job reds; launch 3 is an unattributed test-red
  // repair, so no diagnostic is admitted: its review approves first and its full job reds again.
  approveReview = true;
  expect((await resume()).human).toEqual(["T1"]); // launches 2 and 3 under A then B; test red twice
  expect(journal().read().filter((e) => e.event === "worker-launch")).toHaveLength(3);
  expect(workerBriefs).toHaveLength(3);
  expect(workerBriefs[1]).toContain("## Repair attempt — make the rule these findings name hold");
  expect(workerBriefs[2]).toContain("## Repair attempt — fix ONLY what these findings name");
  for (const brief of workerBriefs.slice(1)) {
    expect(brief.slice(brief.indexOf("## Repair attempt")).split("\n").slice(1, 4))
      .toEqual(["### Standing rulings", `approval: ${A}`, `approval: ${B}`]);
    expect(inOrder(brief, `approval: ${A}`, `approval: ${B}`, "### Failing gate findings (verbatim)", "### The work under review"), brief).toBe(true);
    for (const ruling of [A, B]) expect(brief.split(`approval: ${ruling}`)).toHaveLength(2);
  }
  await approve([runId, "T1", "--waive", "--reason", W], repo);
  expect((await resume()).done).toEqual(["T1"]);

  expect(journal().read().filter((e) => e.event === "task-approved").map((e) => e.data.release))
    .toEqual([undefined, "review-upheld", "gate-satisfied"]);
  // one under A alone, one each reviewing launches 2 and 3 before their full jobs, one after the waive released the red test
  expect(reviewBriefs).toHaveLength(4);
  for (const brief of reviewBriefs) {
    expect(brief).not.toContain("## Operator context");
    for (const ruling of [A, B]) expect(brief).not.toContain(ruling);
  }
  // The next worker would read the same standing rulings; the waive's reason is in no brief.
  expect(journaledFailureBrief(journal().read(), "T1")).toEqual([`approval: ${A}`, `approval: ${B}`]);
  for (const brief of [...workerBriefs, ...reviewBriefs]) expect(brief).not.toContain(W);
}, 180_000);

test("test: a funded lint repair and a funded oracle acceptance repair each record the instance contract and render fix only with no contract clause, while a review repair records the class contract, and a resumed run renders each from its journaled row, so a deterministic repair handed the class contract or a contract a resume loses fails", async () => {
  // The closed funding table crosses both daemon funding sites: an ordinary completed battery,
  // and a crash at gates followed by the resumed suffix. Each then stops before the repair launches.
  const cases = [
    { gate: "lint", contract: "instance" },
    { gate: "acceptance", contract: "instance" },
    { gate: "review", contract: "class" },
  ] as const;
  for (const { gate, contract } of cases) for (const resumedBattery of [false, true]) {
    const { repo, fake, scriptPath } = setupRepo(
      [T("T1", {
        ...pin, files: ["t1.txt"], gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
        acceptance: [{ oracle: "command", command: gate === "acceptance" ? "grep -q fixed t1.txt" : "true" }],
      })],
      { tasks: { T1: [
        { shell: `echo broken > t1.txt && ${COMMIT} broken`, result: { ok: true, summary: "broken" } },
        { shell: `echo fixed > t1.txt && ${COMMIT} fixed`, result: { ok: true, summary: "fixed" } },
      ] } },
      "review: { required: true, prefer: [seat-a] }\nrouting: { deny: { workers: { adapters: [seat-a] } } }\n"
        // Retain the interrupted attempt's checkout: a journal rewind cannot undo run-end cleanup.
        + (resumedBattery ? "visibility: { keepPanes: forever }\n" : "")
        + (gate === "lint" ? "gates: { lint: 'test ! -f t1.txt || grep -q fixed t1.txt' }\n" : ""),
    );
    fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" },
      { adapter: "fake", model: "fake-2", vendor: "fake-b", channel: "api", tier: "cheap" }];
    let green = gate !== "review";
    const seat = new ReviewSeat(scriptPath, "seat-a", "vendor-a");
    seat.headlessCommand = (file) => {
      const text = readFileSync(file, "utf8");
      const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
      return `printf '%s\\n' ${shq(JSON.stringify({
        nonce: extractPromptNonce(text), approve: green,
        resolved: green ? prior : [], reraised: green ? [] : prior,
        findings: green ? [] : [{ note: "t1.txt:1 — value() must preserve every row", severity: "material" }],
      }))}`;
    };
    const workerBriefs: string[] = [];
    let stopBeforeRepair = true;
    const invoke = fake.invoke.bind(fake);
    fake.invoke = (task, cwd, a, ctx) => {
      const brief = readFileSync(ctx.promptFile, "utf8");
      workerBriefs.push(brief);
      if (stopBeforeRepair && brief.includes("## Repair attempt")) throw new Error("stop before repair launch");
      return invoke(task, cwd, a, ctx);
    };
    const runId = `run-contract-${gate}-${resumedBattery}`;
    const adapters = [fake, seat];
    const journal = () => Journal.open(repo, runId);
    const assertBrief = (brief: string, expected: "class" | "instance") => {
      expect(brief).toContain(expected === "class"
        ? "## Repair attempt — make the rule these findings name hold"
        : "## Repair attempt — fix ONLY what these findings name");
      expect(brief.includes("### Repair contract — the whole input class")).toBe(expected === "class");
      expect(brief.includes("make the smallest change that resolves every finding, then commit.")).toBe(expected === "instance");
      expect(brief.includes("6. `infeasible inside files[]: <path>` is a lawful report")).toBe(expected === "class");
    };
    expect((await runDaemon(repo, { adapters, runId })).failed).toEqual(["T1"]);
    expect(journal().read().filter((e) => e.event === "repair-attempt").map((e) => [e.data.gates, e.data.contract]))
      .toEqual([[[gate], contract]]);
    assertBrief(workerBriefs.at(-1)!, contract);

    if (resumedBattery) {
      // Rewind the fixture to a crash immediately before gates. The landed commit and baseline
      // remain real; runDaemon must measure the resumed battery and fund its own repair row.
      const events = journal().read();
      const atGates = events.findIndex((e) => e.event === "phase-start" && e.data.phase === "gates");
      expect(atGates).toBeGreaterThan(0);
      const launch = events.find((e) => e.event === "worker-launch")!;
      expect(existsSync((launch.data.slot as { cwd: string }).cwd)).toBe(true);
      writeFileSync(join(journal().dir, "journal.jsonl"), events.slice(0, atGates + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
      expect((await runDaemon(repo, { adapters, runId, resume: true })).failed).toEqual(["T1"]);
      const resumed = journal().read().slice(atGates + 1);
      expect(resumed.filter((e) => e.event === "resume-harvest-declined" || e.event === "worker-launch")).toEqual([]);
      expect(resumed.some((e) => e.event === "gate-result" && e.data.gate === gate && e.data.pass === false)).toBe(true);
      expect(journal().read().filter((e) => e.event === "repair-attempt").map((e) => [e.data.gates, e.data.contract]))
        .toEqual([[[gate], contract]]);
      assertBrief(workerBriefs.at(-1)!, contract);
    }

    // An old funded review row has no contract. Its live review history must not upgrade it.
    const legacy = gate === "review" && resumedBattery;
    if (legacy) {
      const events = journal().read().map((e) => {
        if (e.event === "repair-attempt") delete e.data.contract;
        return e;
      });
      writeFileSync(join(journal().dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    const before = workerBriefs.length;
    stopBeforeRepair = false;
    green = true;
    expect((await runDaemon(repo, { adapters, runId, resume: true, retryFailed: true })).done).toEqual(["T1"]);
    expect(workerBriefs).toHaveLength(before + 1);
    assertBrief(workerBriefs.at(-1)!, legacy ? "instance" : contract);
    expect(journal().read().filter((e) => e.event === "repair-attempt")).toHaveLength(1);
  }
}, 180_000);

// D-1355, ratified D-1366: the first material finding already funds the whole input class.
test("test: the production daemon repair funded by a first material review finding opens with the class heading and the six contract clauses verbatim and not the fix-only order, and a chain re-raised once is listed with its count beneath the contract, so a first-finding repair that still orders the smallest edit fails", async () => {
  const attempt = (n: number) => ({ shell: `echo ${n} > t1.txt && ${COMMIT} a${n}`, result: { ok: true, summary: `a${n}` } });
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { ...pin, files: ["t1.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"] })],
    { tasks: { T1: [1, 2, 3, 4].map(attempt) } },
    "review: { required: true, prefer: [seat-a] }\nrouting: { deny: { workers: { adapters: [seat-a] } } }\n",
  );
  fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fake.vendor, channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "fake-b", channel: "api", tier: "cheap" }];
  const workerBriefs: string[] = [];
  const invoke = fake.invoke.bind(fake);
  fake.invoke = (task, cwd, a, ctx) => {
    workerBriefs.push(readFileSync(ctx.promptFile, "utf8"));
    return invoke(task, cwd, a, ctx);
  };
  const NOTE = "src/rows.ts:1 — rows() drops the last row of every page";
  // Ratified D-1366 bytes, authored independently of the production renderer.
  const CONTRACT = [
    "### Repair contract — the whole input class",
    "1. rule over the input class",
    "2. land every `found:` item as an owned test whose assertion is the finding's CONSEQUENCE through the production entry under `searched:`",
    "3. one bounded generalised test",
    "4. prove the oracle fails pre-fix",
    "5. redesign inside files[] allowed",
    "6. `infeasible inside files[]: <path>` is a lawful report",
    "The repair stays inside the task's declared write scope (files[]) and never narrows its goal or an acceptance criterion; the reviewer judges the accumulated diff.",
  ].join("\n");
  let rounds = 0;
  const seat = new ReviewSeat(scriptPath, "seat-a", "vendor-a");
  seat.headlessCommand = (file) => {
    const text = readFileSync(file, "utf8");
    const nonce = extractPromptNonce(text);
    const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    // Rounds 1-3 hold the same material (restated with its carried id); round 4 resolves it.
    return `printf '%s\\n' ${shq(JSON.stringify(++rounds < 4
      ? { nonce, approve: false, resolved: [], reraised: prior, findings: [{ note: NOTE, severity: "material", ...(prior[0] ? { reraised: prior[0] } : {}) }] }
      : { nonce, approve: true, resolved: prior, reraised: [], findings: [] }))}`;
  };
  const adapters = [fake, seat];
  const runId = "run-repair-class-table";
  const journal = () => Journal.open(repo, runId);

  // Round 1 (first isolated finding) funds repair 1; round 2 (first reraise) funds repair 2 and parks at the round cap.
  expect((await runDaemon(repo, { adapters, runId })).human).toEqual(["T1"]);
  await approve([runId, "T1", "--uphold", "--review-rounds", "3"], repo);
  // Attempt 3 resumes the pending class repair after ONE reraise; round 4 passes.
  expect((await runDaemon(repo, { adapters, runId, resume: true })).done).toEqual(["T1"]);
  const reviews = journal().read().filter((e) => e.event === "gate-result" && e.data.gate === "review");
  expect(reviews.map((e) => [e.data.pass, (e.data.reraised as unknown[] | undefined)?.length ?? 0])).toEqual([[false, 0], [false, 1], [false, 1], [true, 0]]);
  expect(journal().read().filter((e) => e.event === "repair-dispatch")).toHaveLength(3);
  expect(workerBriefs).toHaveLength(4);
  const [, afterFirstFinding, afterFirstReraise, afterSecondReraise] = workerBriefs as [string, string, string, string];

  const bounded = "make the smallest change that resolves every finding, then commit.";
  for (const brief of [afterFirstFinding, afterFirstReraise, afterSecondReraise]) {
    expect(brief).toContain("## Repair attempt — make the rule these findings name hold\n### Standing rulings");
    expect(brief).toContain("make the rule these findings name hold under the contract below, then commit.");
    expect(brief).toContain(CONTRACT);
    expect(brief).toContain(NOTE);
    expect(brief).not.toContain("## Repair attempt — fix ONLY");
    expect(brief).not.toContain(bounded);
  }
  expect(afterFirstFinding).not.toContain("### Repeated review chains");
  expect(afterFirstReraise.indexOf("- `review:material|src/rows.ts|rows` re-raised 1 times")).toBeGreaterThan(afterFirstReraise.indexOf(CONTRACT));
  expect(afterSecondReraise).toContain("- `review:material|src/rows.ts|rows` re-raised 2 times");
  expect(afterSecondReraise.split(NOTE)).toHaveLength(2); // the chain's prose is quoted once, not again in the table
  expect(journal().read().filter((e) => e.event === "repair-attempt").map((e) => e.data.contract)).toEqual(["class", "class", "class"]);
}, 180_000);
