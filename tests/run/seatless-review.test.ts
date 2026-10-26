import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { shq, type AuthHealth, type BillingChannel } from "../../src/adapters/types.js";
import { approve, newestPark, permittedDecisionVerbs as approveVerbs, releaseForDecision } from "../../src/cli/commands/approve.js";
import { verify } from "../../src/cli/commands/verify.js";
import type { Tier } from "../../src/config/config.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import { DECISION_VERBS, permittedDecisionVerbs, type DecisionVerb } from "../../src/run/decision-verbs.js";
import { shOk } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// Keep the independent judge below the worker's review floor, leaving exactly the named review seat.
class Author extends FakeAdapter {
  override channels(): BillingChannel[] {
    return [super.channels()[0]!, { ...super.channels()[1]!, tier: "cheap" }];
  }
}
class ReviewSeat extends FakeAdapter {
  calls = 0;
  constructor(path: string, private verdict = true, private tier: Tier = "frontier", vendor = "independent") {
    super(path);
    this.id = "review-seat";
    this.vendor = vendor;
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: "review-model", vendor: this.vendor, channel: "api", tier: this.tier }];
  }
  override headlessCommand(file: string): string {
    this.calls++;
    const nonce = extractPromptNonce(readFileSync(file, "utf8"));
    const body = this.verdict ? { nonce, approve: true, findings: [], resolved: [], reraised: [] }
      : { approve: true, findings: [] }; // a real no-verdict, not a failed launch or a review rejection
    return `printf '%s' ${shq(JSON.stringify(body))}`;
  }
}
const fixture = (taskId: string, extraCfg = "") => {
  const f = setupRepo([T(taskId, { files: ["work.txt"], acceptance: [{ oracle: "command", command: "true" }] })], {
    tasks: { [taskId]: [{ shell: `echo work > work.txt && ${COMMIT} work`, result: { ok: true, summary: "work" } }] },
  }, `routing:\n  deny:\n    workers:\n      adapters: [review-seat]\n${extraCfg}`);
  const cfg = join(f.repo, ".tickmarkr", "config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
  return { ...f, author: new Author(f.scriptPath) };
};
function doctor(repo: string, probed: boolean, extra: Partial<AuthHealth> = {}) {
  writeDoctor(repo, {
    fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: authedModels(["fake-1", "fake-2"]) },
    "review-seat": { installed: true, authed: true, models: ["review-model"],
      ...(probed ? { modelAuth: authedModels(["review-model"]) } : {}), ...extra },
  });
}
interface ParkSnapshot {
  repo: string;
  runId: string;
  taskId: string;
  name: string;
  rows: JournalEvent[];
  journalBytes: string;
  graphBytes: string;
}
const parks: ParkSnapshot[] = [];
function capture(repo: string, runId: string, taskId: string, name: string) {
  const j = Journal.open(repo, runId);
  const snapshot = { repo, runId, taskId, name, rows: j.read(),
    journalBytes: readFileSync(join(j.dir, "journal.jsonl"), "utf8"), graphBytes: readFileSync(join(repo, ".tickmarkr", "graph.json"), "utf8") };
  parks.push(snapshot);
  return snapshot;
}
function restore(p: ParkSnapshot) {
  writeFileSync(join(Journal.open(p.repo, p.runId).dir, "journal.jsonl"), p.journalBytes);
  writeFileSync(join(p.repo, ".tickmarkr", "graph.json"), p.graphBytes);
}
const commands = (p: ParkSnapshot) => [...String(newestPark(p.rows, p.taskId)?.reason).matchAll(/`(tickmarkr approve [^`]+)`/g)].map((m) => m[1]!);
const commandVerb = (command: string): DecisionVerb => (command.match(/ --(waive|uphold|recheck)\b/)?.[1] ?? "approve") as DecisionVerb;

beforeAll(async () => {
  const taskId = "T17";
  const empty = fixture(taskId);
  doctor(empty.repo, true);
  const runId = "run-seatless-gate";
  expect((await runDaemon(empty.repo, { runId, adapters: [empty.author] })).human).toEqual([taskId]);
  capture(empty.repo, runId, taskId, "gate-time seatless");
  await approve([runId, taskId, "--recheck"], empty.repo);
  expect((await runDaemon(empty.repo, { runId, adapters: [empty.author], resume: true })).human).toEqual([taskId]);
  capture(empty.repo, runId, taskId, "rechecked seatless");

  const noVerdict = fixture("T23");
  doctor(noVerdict.repo, true);
  const seat = new ReviewSeat(noVerdict.scriptPath, false);
  const options = { runId: "run-seatless-infra", adapters: [noVerdict.author, seat] };
  expect((await runDaemon(noVerdict.repo, options)).human).toEqual(["T23"]);
  capture(noVerdict.repo, options.runId, "T23", "no-verdict pool");
  expect(seat.calls).toBe(1);
  for (const name of ["retired-only recovery", "replayed retired-only recovery"]) {
    await approve([options.runId, "T23", "--recheck"], noVerdict.repo);
    expect((await runDaemon(noVerdict.repo, { ...options, resume: true })).human).toEqual(["T23"]);
    capture(noVerdict.repo, options.runId, "T23", name);
  }
  expect(seat.calls).toBe(2); // the third round cannot dispatch the retired seat
}, 120_000);

test("test: every park a review seat outcome causes in the production daemon prints release commands for exactly the verbs the approve command admits there, approve and recheck on an infrastructure park, waive, recheck and uphold on a review gate-fail park, so a reason telling the operator to waive an infrastructure park fails", async () => {
  expect(parks.map((p) => p.name)).toEqual(["gate-time seatless", "rechecked seatless", "no-verdict pool", "retired-only recovery", "replayed retired-only recovery"]);
  for (const p of parks) {
    const park = newestPark(p.rows, p.taskId)!;
    const expected: DecisionVerb[] = p.name.includes("seatless") ? ["waive", "uphold", "recheck"] : ["approve", "recheck"];
    expect(park.kind, p.name).toBe(p.name.includes("seatless") ? "gate-fail" : "infra");
    expect(permittedDecisionVerbs(park), p.name).toEqual(expected);
    expect(commands(p).map(commandVerb).sort(), p.name).toEqual([...expected].sort());
    if (park.kind === "infra") expect(park.reason, p.name).not.toMatch(/--waive|--uphold/);
    if (p.name.includes("retired-only")) expect(park.reason).toContain("retired it — it is out for the run");
    for (const verb of DECISION_VERBS.filter((verb) => !expected.includes(verb))) {
      restore(p);
      const before = Journal.open(p.repo, p.runId).read().length;
      await expect(approve([p.runId, p.taskId, ...(verb === "approve" ? [] : [`--${verb}`])], p.repo), `${p.name}/${verb}`).rejects.toThrow();
      expect(Journal.open(p.repo, p.runId).read()).toHaveLength(before);
    }
    restore(p);
  }
});

test("test: every release command a review seat park prints names that park's own run and task and appends its matching release when invoked exactly as printed, and the approve command, the daemon's park reasons and the status surfaces read one verb table module, so a command naming another run or task fails", async () => {
  expect(approveVerbs).toBe(permittedDecisionVerbs);
  const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
  expect(source("run/daemon.ts")).toMatch(/import \{ permittedDecisionVerbs,.*from "\.\/decision-verbs\.js"/);
  expect(source("run/daemon.ts")).toContain("permittedDecisionVerbs(park).map");
  expect(source("cli/commands/approve.ts")).toContain('from "../../run/decision-verbs.js"');
  for (const file of ["cli/commands/status.ts", "tui/cockpit/derive.ts", "tui/cockpit/decision-actions.ts"]) {
    expect(source(file), file).toMatch(/import \{[^}]*permittedDecisionVerbs[^}]*\} from "[^"]*approve\.js"/s);
  }
  for (const p of parks) {
    const park = newestPark(p.rows, p.taskId)!;
    for (const command of commands(p)) {
      const [bin, subcommand, ...argv] = command.split(" ");
      expect([bin, subcommand, ...argv.slice(0, 2)], p.name).toEqual(["tickmarkr", "approve", p.runId, p.taskId]);
      restore(p);
      try {
        const before = Journal.open(p.repo, p.runId).read().length;
        await approve(argv, p.repo);
        const appended = Journal.open(p.repo, p.runId).read().slice(before);
        expect(appended).toHaveLength(1);
        expect(appended[0]).toMatchObject({ event: "task-approved", taskId: p.taskId, data: { park: { line: park.line, ts: park.ts } } });
        expect(appended[0]!.data.release).toBe(releaseForDecision(commandVerb(command), park));
      } finally { restore(p); }
    }
  }
});

const inheritedFakeScript = process.env.TICKMARKR_FAKE_SCRIPT;
afterEach(() => {
  if (inheritedFakeScript === undefined) delete process.env.TICKMARKR_FAKE_SCRIPT;
  else process.env.TICKMARKR_FAKE_SCRIPT = inheritedFakeScript;
});

test("test: the production daemon whose only otherwise-eligible cross-vendor review seat has no recorded model-auth verdict records a review result naming that seat and the doctor command as the cause and no waive, while that seat with a recorded verdict reviews the task, so missing probe data blamed on the diversity rule fails", async () => {
  for (const probed of [false, true]) {
    const f = fixture("T31");
    doctor(f.repo, probed);
    const seat = new ReviewSeat(f.scriptPath);
    const runId = `run-probe-${probed}`;
    const result = await runDaemon(f.repo, { runId, adapters: [f.author, seat] });
    const row = Journal.open(f.repo, runId).read().find((r) => r.event === "gate-result" && r.data.gate === "review")!;
    if (probed) {
      expect(result.done).toEqual(["T31"]);
      expect(seat.calls).toBe(1);
      expect(row.data).toMatchObject({ pass: true, reviewer: "review-seat:review-model" });
    } else {
      expect(result.human).toEqual(["T31"]);
      expect(seat.calls).toBe(0);
      expect(row.data.details).toContain("review-seat:review-model: no model auth verdict — run tickmarkr doctor");
      expect(row.data.details).toContain("no cross-vendor reviewer available");
      expect(row.data.details).not.toMatch(/diversity rule|--waive/);
    }
  }
  // Exercise verify's own registry → context → review wiring with the registered two-vendor fake.
  const f = setupRepo([T("T41", { files: ["work.txt"], acceptance: [{ oracle: "command", command: "true" }] })], { tasks: {} });
  process.env.TICKMARKR_FAKE_SCRIPT = f.scriptPath;
  writeFileSync(join(f.repo, "work.txt"), "feature\n");
  await shOk(`${COMMIT} feature`, f.repo);
  for (const probed of [false, true]) {
    writeDoctor(f.repo, { fake: { installed: true, authed: true, models: ["fake-1", "fake-2"],
      modelAuth: authedModels(probed ? ["fake-1", "fake-2"] : ["fake-1"]) } });
    const result = await verify(["--task", "T41", "--base", "HEAD~1", "--author", "fake:fake-1", "--json"], f.repo);
    const row = JSON.parse(result.out).results.find((r: { gate: string }) => r.gate === "review");
    expect(result.code, result.out).toBe(probed ? 0 : 2);
    if (probed) expect(row.meta.reviewer).toBe("fake:fake-2");
    else expect(row.details).toContain("fake:fake-2: no model auth verdict — run tickmarkr doctor");
  }
}, 120_000);

test("test: an unprobed review seat that shares the author's vendor or sits below the review floor leaves the seatless result's own cause, the diversity rule or the floor, and never names the doctor command, so a doctor remedy for a seat that could never review fails", async () => {
  for (const [name, tier, vendor, policy] of [
    ["same-vendor", "frontier", "fake-a", ""],
    ["below-floor", "mid", "independent", ""],
    ["role-denied", "frontier", "independent", "    adapters: [review-seat]\n"],
  ] as const) {
    const f = fixture("T53", policy);
    doctor(f.repo, false);
    const seat = new ReviewSeat(f.scriptPath, true, tier, vendor);
    const runId = `run-unprobed-${name}`;
    expect((await runDaemon(f.repo, { runId, adapters: [f.author, seat] })).human).toEqual(["T53"]);
    const row = Journal.open(f.repo, runId).read().find((r) => r.event === "gate-result" && r.data.gate === "review")!;
    expect(row.data.details, name).toContain("no cross-vendor reviewer available at or above frontier floor");
    expect(row.data.details, name).toContain("diversity rule");
    expect(row.data.details, name).not.toMatch(/tickmarkr doctor|--waive/);
    expect(seat.calls, name).toBe(0);
  }
}, 120_000);
