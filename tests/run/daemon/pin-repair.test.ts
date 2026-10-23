// v2.5.6 T5 (OBS-1034): the pin hosts its own review-upheld repair, and a capped repair brief says what it cut.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { channelKey, shq } from "../../../src/adapters/types.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, normalizeGateFailure, repairsSinceApproval, type JournalEvent } from "../../../src/run/journal.js";
import { deriveRunDecisions } from "../../../src/tui/cockpit/decision-actions.js";
import { COMMIT, authedModels, setupRepo, T } from "../../helpers/tmprepo.js";

/** retry.test.ts's closing responder: every carried fingerprint is echoed back, so a later round is a verdict and never a closure mismatch. */
function closingReview(fake: FakeAdapter, scriptPath: string, disposition: "resolved" | "reraised"): FakeAdapter {
  const headless = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (promptFile, model) => {
    const prompt = readFileSync(promptFile, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return headless(promptFile, model);
    const prior = prompt.match(/## Prior materials this attempt must close\n([\s\S]*?)\n## Diff/)?.[1] ?? "";
    const fingerprints = [...prior.matchAll(/^Fingerprint: (.+)$/gm)].map((match) => match[1]);
    const { review } = JSON.parse(readFileSync(scriptPath, "utf8")) as { review: object };
    return `printf '%s\\n' ${shq(JSON.stringify({
      ...review, nonce: extractPromptNonce(prompt), resolved: [], reraised: [], [disposition]: fingerprints,
    }))}`;
  };
  return fake;
}

const BIG = "x".repeat(60).concat("\n").repeat(40); // 2 440 raw diff bytes when deleted; ~0 reviewable-logic bytes

/** A task whose worker deletes a big tracked file (raw diff far over the brief cap, logic diff tiny) and whose reviewer rejects with material findings. */
const upheldRun = async (runId: string, pin: boolean) => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { complexity: 8, files: ["big.txt", "t1.txt"], acceptance: [{ oracle: "command", command: "true" }],
      ...(pin ? { routingHints: { pin: { via: "fake", model: "fake-1" } } } : {}) })],
    {
      review: { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] },
      consult: { action: "human", notes: "must never fire" },
      tasks: { T1: [
        { shell: `git rm -q big.txt && echo one > t1.txt && ${COMMIT} v1`, result: { ok: true, summary: "v1" } },
        { shell: `echo one-again > t1.txt && ${COMMIT} v2`, result: { ok: true, summary: "v2" } },
        { shell: `echo two > t1.txt && ${COMMIT} v3`, result: { ok: true, summary: "v3" } },
      ] },
    },
    "gates: { diffCap: 1200 }\n",
  );
  writeFileSync(join(repo, "big.txt"), BIG);
  const { execSync } = await import("node:child_process");
  execSync("git add big.txt && git commit --no-gpg-sign -qm big", { cwd: repo });
  const first = await runDaemon(repo, { adapters: [closingReview(fake, scriptPath, "reraised")], runId });
  expect(first.human).toEqual(["T1"]);
  const parked = Journal.open(repo, runId).read();
  expect(parked.find((e) => e.event === "task-human")?.data.kind).toBe("gate-fail");
  const rounds = parked.filter((e) => e.event === "task-dispatch").length;
  await approve([runId, "T1", "--uphold", "--by", "operator"], repo);
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
  writeFileSync(scriptPath, JSON.stringify({ ...script, review: { approve: true, issues: [] } }));
  const resumed = await runDaemon(repo, { adapters: [closingReview(new FakeAdapter(scriptPath), scriptPath, "resolved")], runId, resume: true });
  const all = Journal.open(repo, runId).read();
  const idx = all.map((e) => e.event).lastIndexOf("run-resume");
  const post = all.slice(idx + 1);
  const dispatch = post.find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
  expect(dispatch).toBeDefined();
  const prompts = join(Journal.open(repo, runId).dir, "prompts");
  const prompt = readFileSync(join(prompts, `T1-a${dispatch.data.attempt}.md`), "utf8");
  return { repo, resumed, parked, post, rounds, dispatch, prompt, all };
};

const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");

describe("v2.5.6 T5 — the pin hosts its own repair", () => {
  test("test: a pinned task upheld after its own attempt re-dispatches the review-fix repair on the pinned seat, a capped repair brief journals the dropped files on the repair-dispatch row and the worker prompt states that the diff is partial naming the cut, and an unpinned task keeps excluding its tried seats, so a pin excluded from its own repair or a capped brief that hides its cut from the row or the worker fails", async () => {
    // ---- pinned: every prior attempt sat on the pin, and the funded fix lands on it too ------------
    const pinned = await upheldRun("run-pin-repair", true);
    for (const d of of(pinned.parked, "task-dispatch")) expect(channelKey(d.data.assignment as { adapter: string; model: string })).toBe("fake:fake-1");
    expect(channelKey(pinned.dispatch.data.assignment as { adapter: string; model: string })).toBe("fake:fake-1");
    expect(pinned.dispatch.data.retryMode).toBe("repair");
    expect(pinned.prompt).toMatch(/UPHELD/);
    // the brief was capped: the row names the files the cap dropped, and the worker is told the diff is partial
    const repair = of(pinned.post, "repair-dispatch")[0]!;
    expect(repair).toBeDefined();
    expect(repair.data.capped).toBe(true);
    expect(repair.data.droppedFiles).toEqual(expect.arrayContaining(["big.txt"]));
    expect(pinned.prompt).toMatch(/PARTIAL DIFF: the diff above is incomplete; files cut by the cap: .*big\.txt/);
    expect(pinned.resumed.done).toEqual(["T1"]);
    // ---- unpinned: the tried seat stays excluded and the fix goes to the next seat ------------------
    const free = await upheldRun("run-free-repair", false);
    expect(channelKey(free.dispatch.data.assignment as { adapter: string; model: string })).toBe("fake:fake-2");
    expect(free.dispatch.data.excludedChannels).toContain("fake:fake-1");
    expect(free.resumed.done).toEqual(["T1"]);
  }, 300_000);
});

const site = "tests/unowned.test.ts";

// Queue row 224(b) (D-2118): real approval, worker commits and gate commands exercise the closed case table.
async function repairRun(runId: string, options: { unpinned?: boolean; repeat?: boolean; spent?: boolean; refuse?: boolean; buildAfterRepairs?: boolean } = {}) {
  const build = options.buildAfterRepairs
    ? 'if test -f owned.txt; then case "$(cat owned.txt)" in amber|blue) ;; *) echo "build failed: $(cat owned.txt) in owned.txt"; exit 1;; esac; fi'
    : "true";
  const { repo, fake } = setupRepo([T("T1", {
    humanGate: true, files: ["owned.txt"], acceptance: [{ oracle: "command", command: "true" }],
    ...(options.unpinned ? {} : { routingHints: { pin: { via: "fake", model: "fake-1" } } }),
  })], {
    consult: { action: "human", notes: "operator required" },
    tasks: { T1: ["amber", "blue", "cyan", "denim", "emerald", "fuchsia", "gold"].map((value, i) => ({
      shell: options.refuse && i === 2 ? "true" : `echo ${value} > owned.txt && ${COMMIT} change`,
      result: options.refuse && i === 2
        ? { ok: false, summary: `Cannot edit ${site}(12,3) outside files[] allowlist` }
        : { ok: true, summary: "implemented" },
    })) },
  }, `approvalWindowMs: 1\nrouting: { escalateTier: on }\ngates: { build: '${build}', lint: 'true', test: 'if test -f owned.txt; then echo "FAIL ${site} > ${options.repeat ? "same" : "$(cat owned.txt)"}"; exit 1; fi' }\n`);
  fake.channels = () => [
    { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "mid" },
    { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "sub", tier: "mid" },
    { adapter: "fake", vendor: "fake-c", model: "fake-3", channel: "api", tier: "frontier" },
    { adapter: "fake", vendor: "fake-d", model: "fake-4", channel: "api", tier: "frontier" },
  ];
  fake.probe = async () => ({ installed: true, authed: true, version: "fake", models: ["fake-1", "fake-2", "fake-3", "fake-4"],
    modelAuth: authedModels(["fake-1", "fake-2", "fake-3", "fake-4"]) });
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, site), "export {};\n");
  execFileSync("git", ["add", site], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-qm", "detection-site"], { cwd: repo });
  expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
  const journal = Journal.open(repo, runId);
  expect(of(journal.read(), "task-dispatch")).toHaveLength(0);
  await approve([runId, "T1", "--by", "operator"], repo);
  if (options.spent) {
    for (let repair = 1; repair <= 2; repair++) {
      journal.append("repair-attempt", "T1", { repair, gates: ["test"] });
      journal.append("worker-launch", "T1", {});
      journal.append("gate-result", "T1", { gate: "test", pass: false, details: `prior repair ${repair}` });
    }
  }
  const start = journal.read().length;
  const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
  expect(summary.human).toEqual(["T1"]);
  return { repo, runId, journal, rows: journal.read().slice(start) };
}

describe("Queue row 224(b) (D-2118) and row 230", () => {
  test("a pinned task whose second deterministic red since approval funds a repair dispatches that repair on the pinned channel with no park in that round, and parks pin held for repair exhaustion only once the budget is spent, so a round that journals a funded repair and then parks pin held for the gate failure fails", async () => {
    const { journal, rows } = await repairRun("run-pin-funded");
    const funded = of(rows, "repair-attempt");
    expect(funded).toHaveLength(2);
    expect(funded.map((row) => row.data.charge)).toEqual([1, 2]);
    const dispatches = of(rows, "task-dispatch");
    expect(dispatches.map((row) => row.data.retryMode)).toEqual(["fresh", "repair", "repair"]);
    for (const row of dispatches) expect(channelKey(row.data.assignment as { adapter: string; model: string })).toBe("fake:fake-1");
    expect(of(rows, "repair-dispatch")).toHaveLength(2);
    const secondRed = of(rows, "gate-result").filter((row) => row.data.gate === "test" && row.data.pass === false)[1]!;
    expect(rows.indexOf(secondRed)).toBeLessThan(rows.indexOf(funded[1]!));
    const thirdLaunch = of(rows, "worker-launch")[2]!;
    const fundedRound = rows.slice(rows.indexOf(funded[1]!), rows.indexOf(thirdLaunch) + 1);
    expect(of(fundedRound, "task-human")).toHaveLength(0);
    expect(of(fundedRound, "task-dispatch")).toEqual([dispatches[2]]);
    const prompt = readFileSync(join(journal.dir, "prompts", `T1-a${dispatches[2]!.data.attempt}.md`), "utf8");
    expect(prompt).toContain("## Repair attempt");
    expect(prompt).toContain(String(funded[1]!.data.findings));
    const park = of(rows, "task-human");
    expect(park).toHaveLength(1);
    expect(park[0]!.data).toMatchObject({ kind: "gate-fail", reason: "pin fake:fake-1 held: repair-exhausted" });
    expect(of(rows, "repair-exhausted")[0]!.data.repairs).toBe(2);
    expect(repairsSinceApproval(journal.read(), "T1")).toBe(2);
    expect(rows.indexOf(park[0]!)).toBeGreaterThan(rows.indexOf(thirdLaunch));
    expect(of(rows, "tier-escalated")).toHaveLength(0);
    expect(of(rows, "gate-fingerprint-cap")).toHaveLength(0);
  }, 120_000);

  test("a pinned task with two funded repairs parks pin held on the first unfunded build red and never escalates to another channel", async () => {
    const { rows } = await repairRun("run-pin-funded-build", { buildAfterRepairs: true });
    const funded = of(rows, "repair-attempt");
    expect(funded).toHaveLength(2);
    expect(funded.map((row) => row.data.charge)).toEqual([1, 2]);
    const buildRed = of(rows, "gate-result").find((row) => row.data.gate === "build" && row.data.pass === false)!;
    expect(buildRed).toBeDefined();
    expect(rows.indexOf(buildRed)).toBeGreaterThan(rows.indexOf(funded[1]!));
    const parks = of(rows, "task-human");
    expect(parks).toHaveLength(1);
    expect(parks[0]!.data).toMatchObject({ kind: "gate-fail", reason: "pin fake:fake-1 held: gate-fail" });
    expect(rows.indexOf(parks[0]!)).toBeGreaterThan(rows.indexOf(buildRed));
    expect(of(rows, "gate-result").filter((row) => row.data.pass === false).map((row) => row.data.gate))
      .toEqual(["test", "test", "build"]);
    const dispatches = of(rows, "task-dispatch");
    expect(dispatches.map((row) => row.data.retryMode)).toEqual(["fresh", "repair", "repair"]);
    for (const row of dispatches) expect(channelKey(row.data.assignment as { adapter: string; model: string })).toBe("fake:fake-1");
    expect(of(rows, "escalation").some((row) => row.data.step === "escalate")).toBe(false);
    expect(of(rows, "tier-escalated")).toHaveLength(0);
    expect(of(rows, "gate-fingerprint-cap")).toHaveLength(0);
    expect(of(rows, "repair-exhausted")).toHaveLength(0);
  }, 120_000);

  test("an identical deterministic red twice still parks a pinned task pin held at the fingerprint cap, an unpinned task's second owned red with a funded repair still climbs a tier, and a pre-spent repair budget still parks pin held for exhaustion, so a fix that also moves unpinned climbs, the cap or exhaustion fails", async () => {
    const capped = await repairRun("run-pin-funded-cap", { repeat: true });
    const reds = of(capped.rows, "gate-result").filter((row) => row.data.gate === "test" && row.data.pass === false);
    expect(reds).toHaveLength(2);
    expect(new Set(reds.map((row) => normalizeGateFailure(String(row.data.details)))).size).toBe(1);
    expect(of(capped.rows, "task-dispatch")).toHaveLength(2);
    expect(of(capped.rows, "repair-attempt")).toHaveLength(1);
    expect(of(capped.rows, "gate-fingerprint-cap")).toHaveLength(1);
    expect(of(capped.rows, "task-human")[0]!.data.reason).toBe("pin fake:fake-1 held: gate-fingerprint-cap");
    const free = await repairRun("run-pin-funded-free", { unpinned: true });
    const climb = of(free.rows, "tier-escalated");
    expect(climb).toHaveLength(1);
    expect(climb[0]!.data).toMatchObject({ cause: "gate-fail", attempt: 2, from: "fake:fake-1", to: "fake:fake-3" });
    const secondFunding = of(free.rows, "repair-attempt")[1]!;
    expect(free.rows.indexOf(secondFunding)).toBeLessThan(free.rows.indexOf(climb[0]!));
    expect(of(free.rows, "task-dispatch")[2]!.data).toMatchObject({ retryMode: "repair", assignment: { model: "fake-3" } });
    const spent = await repairRun("run-pin-funded-spent", { spent: true });
    expect(of(spent.rows, "task-dispatch")).toHaveLength(1);
    expect(of(spent.rows, "repair-attempt")).toHaveLength(0);
    expect(of(spent.rows, "repair-exhausted")[0]!.data.repairs).toBe(2);
    expect(of(spent.rows, "task-human")[0]!.data.reason).toBe("pin fake:fake-1 held: repair-exhausted");
  }, 180_000);

  test("a pinned task whose funded repair worker refuses an edit to an out-of-scope test parks as a scope request whose approve command names that file, so a pinned repair that never runs, or a park offering only waive and recheck, fails", async () => {
    const { rows, journal, runId } = await repairRun("run-pin-funded-refusal", { refuse: true });
    expect(of(rows, "repair-attempt")).toHaveLength(2);
    expect(of(rows, "repair-dispatch")).toHaveLength(2);
    expect(of(rows, "task-dispatch")[2]!.data).toMatchObject({ retryMode: "repair", assignment: { model: "fake-1" } });
    expect(of(rows, "worker-result")[2]!.data).toMatchObject({ ok: false, summary: expect.stringContaining(`${site}(12,3)`) });
    expect(of(rows, "scope-request")[0]!.data.paths).toEqual([site]);
    const command = `tickmarkr approve ${runId} T1 --files ${site}`;
    const parks = of(rows, "task-human");
    expect(parks).toHaveLength(1);
    expect(parks[0]!.data).toMatchObject({ kind: "scope-request", paths: [site], approveCommand: command });
    expect(parks[0]!.data.reason).toContain(command);
    expect(deriveRunDecisions(journal).find((decision) => decision.taskId === "T1")).toMatchObject({ verbs: [], diagnostic: command });
    expect(of(rows, "scope-hint-unresolved")).toHaveLength(0);
  }, 120_000);
});
