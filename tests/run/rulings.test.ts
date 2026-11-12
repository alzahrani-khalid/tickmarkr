// Row 419 (D-2187 add.89): `approve --ruling` records rulings apart from the reason; the run's review briefs for
// that task carry every ruling folded from the run's EFFECTIVE approve decisions, verbatim and in journal order.
// Production approve and the production daemon, fake adapters, zero tokens.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import { APPROVAL_REFUSED, Journal } from "../../src/run/journal.js";
import { foldRulings } from "../../src/run/rulings.js";
import { authedModels, COMMIT, setupRepo as baseSetupRepo, T } from "../helpers/tmprepo.js";

const HEADING = "## Rulings recorded during this run (binding)";
const GATES = ["build", "test", "lint", "evidence", "scope", "review"];
const pin = { routingHints: { pin: { via: "fake", model: "fake-1" } } };

function setupRepo(...args: Parameters<typeof baseSetupRepo>) {
  const fixture = baseSetupRepo(...args);
  const config = join(fixture.repo, ".tickmarkr", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
  fixture.fake.channels = () => [{ adapter: "fake", model: "fake-1", vendor: fixture.fake.vendor, channel: "sub", tier: "frontier" },
    { adapter: "fake", model: "fake-2", vendor: "fake-b", channel: "api", tier: "cheap" }];
  return fixture;
}

/** A review-only seat; `prose` seats never emit a verdict, so the round fails over to the next seat. */
class ReviewSeat extends FakeAdapter {
  constructor(path: string, public override id: string, public override vendor: string) {
    super(path);
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth: authedModels([this.id]) };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
}

interface Brief { seat: string; task: string; text: string }

/** Seats that record every review brief they are handed; `verdict()` decides each verdict-giving seat's answer. */
function seats(scriptPath: string, verdict: () => boolean, prose: string[] = []) {
  const briefs: Brief[] = [];
  const list = ["seat-a", "seat-b"].map((id, i) => {
    const seat = new ReviewSeat(scriptPath, id, `vendor-${i}`);
    seat.headlessCommand = (file) => {
      const text = readFileSync(file, "utf8");
      briefs.push({ seat: id, task: /^## Task (\S+):/m.exec(text)?.[1] ?? "?", text });
      if (prose.includes(id)) return "printf 'No structured verdict available.'";
      const approveRound = verdict();
      const prior = [...text.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]);
      return `printf '%s\\n' ${shq(JSON.stringify({
        nonce: extractPromptNonce(text), approve: approveRound,
        resolved: approveRound ? prior : [], reraised: approveRound ? [] : prior,
        findings: approveRound ? [] : [{ note: "t1.txt must read three", severity: "material", ...(prior[0] ? { reraised: prior[0] } : {}) }],
      }))}`;
    };
    return seat;
  });
  return { briefs, list };
}

const workerBriefs = (fake: FakeAdapter): string[] => {
  const briefs: string[] = [];
  const invoke = fake.invoke.bind(fake);
  fake.invoke = (task, cwd, a, ctx) => {
    briefs.push(readFileSync(ctx.promptFile, "utf8"));
    return invoke(task, cwd, a, ctx);
  };
  return briefs;
};

test("rulings recorded through approve on one decision and a later one appear verbatim in order in the task's initial recovery and recheck review briefs while the reason appears in none", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { ...pin, humanGate: true, files: ["t1.txt"], gates: GATES, outOfScope: ["Never touch base.txt."] }),
      T("T2", { ...pin, deps: ["T1"], files: ["t2.txt"], gates: GATES })],
    { tasks: {
      T1: [1, 2, 3].map((n) => ({ shell: `echo ${n} > t1.txt && ${COMMIT} t1-${n}`, result: { ok: true, summary: `t1-${n}` } })),
      T2: [{ shell: `echo t2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
    } },
    "review: { required: true, prefer: [seat-a, seat-b] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b] } } }\n",
  );
  let green = false;
  const { briefs, list } = seats(scriptPath, () => green, ["seat-a"]);
  const workers = workerBriefs(fake);
  const adapters = [fake, ...list];
  const runId = "run-rulings";
  const journal = () => Journal.open(repo, runId);
  const resume = () => runDaemon(repo, { adapters, runId, resume: true });
  const [R1, R2, R3] = ["Ruling one: t1.txt holds a single line.", "Ruling two:\n  keep the trailing newline.", "Ruling three: the recheck changes nothing."];
  const [reason, recheckReason] = ["Reason one never reaches a reviewer.", "Recheck reason never reaches a reviewer."];
  const rulingsBlock = (...rulings: string[]) => `## Out of scope\nThe task declares these items out of scope. A finding inside these declared bounds is not material and must not block approval.\n- Never touch base.txt.\n\n${HEADING}\n${rulings.map((r) => `- ${r}`).join("\n")}\n\n## Diff`;

  expect((await runDaemon(repo, { adapters, runId })).human).toEqual(["T1"]);
  // Two rulings on one decision (the repeatable flag), recorded apart from its reason.
  await approve([runId, "T1", "--ruling", R1, "--ruling", R2, "--reason", reason, "--review-rounds", "1"], repo);
  const first = journal().read().filter((e) => e.event === "task-approved").at(-1)!;
  expect(first.data).toMatchObject({ ruling: [R1, R2], reason });
  // The initial round: seat-a gives no verdict, so the same round recovers on seat-b; both briefs carry the rulings.
  expect((await resume()).human).toEqual(["T1"]);
  const initial = briefs.filter((b) => b.task === "T1");
  expect(initial.map((b) => b.seat)).toEqual(["seat-a", "seat-b"]);
  for (const brief of initial) expect(brief.text).toContain(rulingsBlock(R1, R2));

  // A third ruling on a later decision: the no-worker recheck's review brief carries all three, in journal order.
  const recheckStart = briefs.length;
  await approve([runId, "T1", "--recheck", "--ruling", R3, "--reason", recheckReason, "--review-rounds", "1"], repo);
  expect((await resume()).human).toEqual(["T1"]);
  const recheckRows = journal().read().filter((e) => e.event === "recheck-battery");
  expect(recheckRows).toHaveLength(1);
  const recheck = briefs.slice(recheckStart).filter((b) => b.task === "T1");
  expect(recheck.length).toBeGreaterThan(0);
  for (const brief of recheck) expect(brief.text).toContain(rulingsBlock(R1, R2, R3));

  // The upheld repair: its worker brief carries no ruling; its review rounds carry all three.
  green = true;
  const laterStart = briefs.length;
  await approve([runId, "T1", "--uphold", "--review-rounds", "1"], repo);
  expect((await resume()).done).toEqual(["T1", "T2"]);
  const later = briefs.slice(laterStart);
  expect(later.filter((b) => b.task === "T1").length).toBeGreaterThan(0);
  for (const brief of later.filter((b) => b.task === "T1")) expect(brief.text).toContain(rulingsBlock(R1, R2, R3));
  // The sibling's brief carries no ruling text.
  const sibling = later.filter((b) => b.task === "T2");
  expect(sibling.length).toBeGreaterThan(0);
  for (const brief of sibling) {
    expect(brief.text).not.toContain(HEADING);
    for (const ruling of [R1, R2, R3]) expect(brief.text).not.toContain(ruling);
  }
  // The reasons reach no review brief; no worker prompt or repair brief carries a ruling.
  for (const brief of briefs) for (const r of [reason, recheckReason]) expect(brief.text).not.toContain(r);
  expect(workers.length).toBeGreaterThanOrEqual(3);
  expect(workers.some((w) => w.includes("## Repair attempt"))).toBe(true);
  for (const worker of workers) for (const ruling of [R1, R2, R3]) expect(worker).not.toContain(ruling);
  expect(foldRulings(journal().read(), "T1")).toEqual([R1, R2, R3]);
  expect(foldRulings(journal().read(), "T2")).toEqual([]);
}, 120_000);

test("a refused decision a non approval row and another run with the same task id contribute no ruling and no sibling brief carries one", async () => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { ...pin, humanGate: true, files: ["t1.txt"], gates: GATES }),
      T("T2", { ...pin, files: ["t2.txt"], gates: GATES })],
    { tasks: {
      T1: [{ shell: `echo t1 > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }],
      T2: [{ shell: `echo t2 > t2.txt && ${COMMIT} t2`, result: { ok: true, summary: "t2" } }],
    } },
    "review: { required: true, prefer: [seat-a, seat-b] }\nrouting: { deny: { workers: { adapters: [seat-a, seat-b] } } }\n",
  );
  const { briefs, list } = seats(scriptPath, () => true);
  const adapters = [fake, ...list];
  const [refusedRuling, rowRuling, otherRuling] = ["Refused decision's ruling.", "Non-approval row's ruling.", "Another run's ruling."];

  // Another run reusing T1 records a ruling through production approve.
  const other = Journal.create(repo, "run-rulings-other");
  other.append("run-start", undefined, { baseRef: "main" });
  other.append("task-human", "T1", { kind: "human-gate", reason: "operator decision" });
  await approve(["run-rulings-other", "T1", "--ruling", otherRuling, "--by", "operator"], repo);
  expect(foldRulings(other.read(), "T1")).toEqual([otherRuling]);

  const runId = "run-rulings-refused";
  const journal = () => Journal.open(repo, runId);
  expect((await runDaemon(repo, { adapters, runId })).human).toEqual(["T1"]);
  expect(briefs.filter((b) => b.task === "T2").length).toBeGreaterThan(0);
  // A decision bound to the open park, then a newer park: the daemon refuses it before enactment.
  await approve([runId, "T1", "--ruling", refusedRuling], repo);
  const refusedLine = journal().read().length;
  journal().append("task-human", "T1", { kind: "human-gate", reason: "operator decision pending" });
  // Ruling-shaped data on rows that are not approvals: a worker result, a consult and a review.
  journal().append("worker-result", "T1", { ok: true, summary: "noise", ruling: [rowRuling] });
  journal().append("consult-verdict", "T1", { ruling: [rowRuling] });
  journal().append("review-leg2", "T1", { ruling: [rowRuling] });
  expect((await runDaemon(repo, { adapters, runId, resume: true })).human).toEqual(["T1"]);
  const refusal = journal().read().find((e) => e.event === APPROVAL_REFUSED && e.taskId === "T1");
  expect(refusal?.data.lines).toEqual([refusedLine]);
  expect(foldRulings(journal().read(), "T1")).toEqual([]);

  await approve([runId, "T1"], repo);
  const start = briefs.length;
  expect((await runDaemon(repo, { adapters, runId, resume: true })).done).toEqual(["T1", "T2"]);
  expect(briefs.slice(start).filter((b) => b.task === "T1").length).toBeGreaterThan(0);
  for (const brief of briefs) {
    expect(brief.text).not.toContain(HEADING);
    for (const ruling of [refusedRuling, rowRuling, otherRuling]) expect(brief.text).not.toContain(ruling);
  }
}, 120_000);
