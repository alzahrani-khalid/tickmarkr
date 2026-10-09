// v2.6.7 T1: the closed order, recovery and missing-proof tables through production runDaemon -> runGates
// (fake adapters). Observables are RECORDED state: the journal and the test command's argv log (an oracle
// passes `-t`, the full job nothing, a diagnostic its files).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel, type WorkerAdapter } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { Slot } from "../../src/drivers/types.js";
import { captureBaseline, type Baseline } from "../../src/gates/baseline.js";
import { graphDefinitionHash, loadGraph, saveGraph, setStatus } from "../../src/graph/graph.js";
import { decisiveReviewRounds, runDaemon } from "../../src/run/daemon.js";
import { gitHead } from "../../src/run/git.js";
import { Journal, reviewRoundsSinceApproval, type JournalEvent } from "../../src/run/journal.js";
import { authedModels, COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return super.channels().slice(0, 1); }
}

type Reply = "red" | "approve" | "silent" | "throw";
/** An ordering fixture's deadlock guard expired. The held seat or verdict is never released: the hold
 * REJECTS, and candidate() rethrows this so the test fails by name instead of asserting over whatever
 * different event sequence the round took. */
class BarrierExpired extends Error { override name = "BarrierExpired"; }
const BARRIER_GUARD_MS = 30_000;
/** Hold until an OBSERVED journal state holds; on guard expiry reject, never fall through. */
async function until(rows: () => JournalEvent[], ready: (events: JournalEvent[]) => boolean, label: string) {
  for (const deadline = Date.now() + BARRIER_GUARD_MS; !ready(rows());) {
    if (Date.now() > deadline) throw new BarrierExpired(`barrier: ${label} never observed within ${BARRIER_GUARD_MS} ms`);
    await new Promise((wake) => setTimeout(wake, 20));
  }
}

/** A review seat; `barrier` holds its verdict until that file exists. Its 4 s guard expires inside the 5 s
 * review timeout, so expiry is named: it prints NO verdict and leaves `<barrier>.expired`, which
 * candidate() turns into a BarrierExpired. */
class Reviewer extends FakeAdapter {
  private turn = 0;
  /** Extra `models` are channels only the daemon's review-only recovery may seat. */
  constructor(path: string, public override id: string, private replies: Reply[], private barrier?: string, private models: string[] = [id]) {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    return { installed: true, authed: true, version: "fake", models: this.models, modelAuth: authedModels(this.models) };
  }
  override channels(): BillingChannel[] {
    return this.models.map((model) => ({ adapter: this.id, model, vendor: this.vendor, channel: "api", tier: "frontier" }));
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return "true";
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1] ?? "";
    const reply = this.replies[Math.min(this.turn++, this.replies.length - 1)]!;
    if (reply === "throw") throw new Error("review adapter crashed while building its command");
    if (reply === "silent") return "true";
    const carried = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((m) => m[1]!);
    const verdict = reply === "red"
      ? { nonce, approve: false, resolved: [], reraised: [], findings: [{ note: "src/a.ts: the guard is missing", severity: "material" }] }
      : { nonce, approve: true, resolved: carried, reraised: [], findings: [] };
    const wait = this.barrier ? `for i in $(seq 1 80); do [ -f ${shq(this.barrier)} ] && break; sleep 0.05; done; `
      + `[ -f ${shq(this.barrier)} ] || { touch ${shq(`${this.barrier}.expired`)}; exit 97; }; ` : "";
    return `${wait}printf '%s' ${shq(JSON.stringify(verdict))}`;
  }
}

/** A real SubprocessDriver whose pane creation refuses the names `fails` picks; `hold` delays a launch. */
function seatDriver(fails: (name: string) => boolean, hold?: (name: string) => Promise<void>) {
  const inner = new SubprocessDriver();
  const expired: BarrierExpired[] = [];
  return {
    expired,
    id: "subprocess",
    interactive: false,
    status: inner.status.bind(inner),
    async slot(cwd: string, name: string) {
      if (fails(name)) throw new Error(`pane create refused for ${name}`);
      await hold?.(name).catch((error: unknown) => { if (error instanceof BarrierExpired) expired.push(error); throw error; });
      return inner.slot(cwd, name);
    },
    run: (slot: Slot, command: string) => inner.run(slot, command),
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: (slot: Slot) => inner.close(slot),
    worktree: inner.worktree.bind(inner),
  };
}
const role = (name: string, r: "judge" | "review") => name.startsWith(`tickmarkr:${r}:`);

/** A behavioral full-suite red with full provenance on a recorded subject — repair selection's attribution. */
const ATTRIBUTED_RED = { gate: "test", pass: false, details: "FAIL tests/a.test.ts > known defect", disposition: "behavioral",
  commit: "a".repeat(40), failingFiles: ["tests/a.test.ts"], selectionDecision: { scope: "full" } };

interface CandidateOptions {
  runId: string;
  /** Per-attempt worker shell prefixes (`@DIR@` = flag dir). */
  works?: string[];
  seed?: Record<string, unknown>[];
  durations?: Record<string, number>;
  /** The capacity those durations claim; absent = none (synthetic timing measured under no capacity). */
  capacity?: unknown;
  flags?: string[];
  replies?: Reply[];
  seatB?: Reply[];
  /** seat-a's channels (default one). */
  seatAModels?: string[];
  barrier?: boolean;
  judge?: unknown;
  acceptance?: unknown[];
  pad?: { analyzable: number; planning: number };
  driver?: (rows: () => JournalEvent[]) => ReturnType<typeof seatDriver>;
  pane?: boolean;
  /** A prior complete run leaves an exact-subject full green in the verdict store. */
  prime?: boolean;
  /** The recorded baseline test verdict is red, so a red with no fresh failure line is forgivable. */
  redBaseline?: boolean;
}

async function candidate(o: CandidateOptions) {
  const dir = makeTestTempDir("tickmarkr-candidate-");
  const log = join(dir, "argv.log");
  const works = o.works ?? [""];
  const { repo, scriptPath } = setupRepo(
    [T("T1", { files: ["**"], complexity: 8, ...(o.acceptance ? { acceptance: o.acceptance } : {}) })],
    { tasks: { T1: works.map((prefix, i) => ({ shell: `${prefix.replaceAll("@DIR@", shq(dir))}echo 'export const a = () => ${i + 2};' > src/a.ts && ${COMMIT} w${i + 1}`,
      result: { ok: true, summary: `w${i + 1}` } })) }, ...(o.judge ? { judge: o.judge } : {}) },
    `gates: { test: "sh run.sh" }\nreview: { required: true, prefer: [seat-a, seat-b], timeoutMs: 5000 }\n`
      + (o.pane ? "visibility:\n  llm: pane\n  keepPanes: run\n" : ""),
  );
  const files: Record<string, string> = {
    "src/a.ts": "export const a = () => 1;\n",
    "src/b.ts": "export const b = () => 1;\n",
    "tests/a.test.ts": 'import { a } from "../src/a.js";\na();\n',
    "tests/b.test.ts": 'import { b } from "../src/b.js";\nb();\n',
    "tests/hidden.test.ts": "// outside every import-based selection\n",
    // A named-test oracle passes -t; the full job passes nothing; a diagnostic passes its files.
    "run.sh": [
      `echo "$PWD|$*" >> ${shq(log)}`,
      `if [ "$1" = "-t" ]; then echo " Tests  1 passed (1)"; exit 0; fi`,
      `if [ "$#" -gt 0 ] && [ -f ${shq(join(dir, "diag-red"))} ]; then echo "FAIL tests/a.test.ts > still broken"; exit 1; fi`,
      `if [ "$#" -gt 0 ] && [ -f ${shq(join(dir, "diag-killed"))} ]; then echo "runner killed: SIGKILL"; exit 137; fi`,
      // an ACTUAL signal termination: no text names the kill, only the termination receipt records it
      `if [ "$#" -gt 0 ] && [ -f ${shq(join(dir, "diag-sigkill"))} ]; then kill -KILL $$; fi`,
      `if [ "$#" -eq 0 ] && [ -f ${shq(join(dir, "full-red"))} ]; then echo "FAIL tests/hidden.test.ts > omitted regression"; exit 1; fi`,
      "exit 0",
    ].join("\n") + "\n",
  };
  if (o.pad) {
    // Analyzable source paths (filtered BEFORE the cap) plus planning files the import scan never reads.
    for (let i = 0; i < o.pad.analyzable; i++) files[`pad/p${String(i).padStart(4, "0")}-ü.ts`] = "export {};\n"; // git C-quotes it: only -z keeps ".ts"
    for (let i = 0; i < o.pad.planning; i++) files[`.planning/n${String(i).padStart(4, "0")}.md`] = "# note\n";
  }
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  execSync(`git add -A && git commit -q --no-gpg-sign -m fixture`, { cwd: repo });
  const commands = { test: "sh run.sh" };
  const baseRef = await gitHead(repo);
  const captured = await captureBaseline(repo, commands);
  if (o.redBaseline) captured.commands.test!.exitCode = 1;
  const baseline: Baseline = o.durations ? { ...captured, commands: { ...captured.commands, test: { ...captured.commands.test!,
    capacity: o.capacity as Baseline["commands"]["test"]["capacity"],
    fileDurations: Object.entries(o.durations).map(([file, durationMs]) => ({ file, durationMs })), fileOutcomes: true } } } : captured;
  const start = (runId: string) => {
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, { baseRef, commands, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify(baseline));
    return journal;
  };
  let primed: JournalEvent[] = [];
  if (o.prime) {
    const script = join(dir, "prime.json");
    writeFileSync(script, JSON.stringify({ ...JSON.parse(readFileSync(scriptPath, "utf8")), judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } }));
    start(`${o.runId}-prime`);
    await runDaemon(repo, { adapters: [new Author(script), new Reviewer(script, "seat-a", ["approve"])], runId: `${o.runId}-prime`,
      resume: true, driver: seatDriver(() => false) });
    primed = Journal.open(repo, `${o.runId}-prime`).read();
    saveGraph(repo, setStatus(loadGraph(repo), "T1", "pending"));
  }
  const journal = start(o.runId);
  for (const row of o.seed ?? []) journal.append("gate-result", "T1", row);
  writeFileSync(log, ""); // forget the baseline capture's (and any priming run's) invocations
  for (const flag of o.flags ?? []) writeFileSync(join(dir, flag), "");
  const published = join(dir, "acceptance.published");
  const adapters: WorkerAdapter[] = [new Author(scriptPath), new Reviewer(scriptPath, "seat-a", o.replies ?? ["approve"], o.barrier ? published : undefined, o.seatAModels)];
  if (o.seatB) adapters.push(new Reviewer(scriptPath, "seat-b", o.seatB));
  const rows = () => Journal.open(repo, o.runId).read();
  // The held review is released only once acceptance's gate-result is OBSERVED in the journal (the oracle has
  // exited and the judge published), stamped with the release time; on guard expiry nothing is released.
  const release = o.barrier ? until(rows, (events) => events.some((e) => e.event === "gate-result" && e.data.gate === "acceptance"),
    "the published acceptance row").then(() => writeFileSync(published, String(Date.now()))) : undefined;
  release?.catch(() => {}); // awaited, and rethrown by name, after the run
  const driver = o.driver?.(rows);
  const summary = await runDaemon(repo, { adapters, runId: o.runId, resume: true, ...(driver ? { driver } : {}) });
  await release;
  if (driver?.expired.length) throw driver.expired[0];
  if (existsSync(`${published}.expired`)) throw new BarrierExpired("barrier: acceptance never published before the held review verdict");
  const events = rows();
  // The candidate's own task worktree is the gate's subject; integration-tip verification runs elsewhere.
  const lines = readFileSync(log, "utf8").split("\n").slice(0, -1).map((line) => ({ cwd: line.slice(0, line.indexOf("|")), args: line.slice(line.indexOf("|") + 1) }));
  return { summary, events, dir, repo, primed, rounds: rounds(events),
    log: lines.filter((line) => line.cwd.endsWith("--T1")).map((line) => line.args),
    tipLog: lines.filter((line) => !line.cwd.endsWith("--T1")).map((line) => line.args) };
}

interface Round { starts: string[]; rows: Array<Record<string, unknown>> }
/** Each `gates` phase-start opens a round: its gate starts and gate rows. */
function rounds(events: JournalEvent[]): Round[] {
  const out: Round[] = [];
  for (const e of events) {
    if (e.taskId !== "T1") continue;
    if (e.event === "phase-start" && e.data.phase === "gates") out.push({ starts: [], rows: [] });
    else if (e.event === "phase-start" && typeof e.data.gate === "string") out.at(-1)?.starts.push(e.data.gate);
    else if (e.event === "gate-result") out.at(-1)?.rows.push(e.data);
  }
  return out;
}
const CHEAP = ["build", "lint", "evidence", "scope"];
const SEMANTICS = ["acceptance", "review"]; // both starts are emitted before either seat launches, in this order
const testRows = (r: Round) => r.rows.filter((row) => row.gate === "test");
const isOracle = (line: string) => line.startsWith("-t ");
const merged = (events: JournalEvent[]) => events.some((e) => e.event === "merge" && e.taskId === "T1");
/** The journal before the candidate's second gate round opened (all of it when there is none). */
const beforeSecondRound = (events: JournalEvent[]) => {
  const opens = events.flatMap((e, i) => e.event === "phase-start" && e.data.phase === "gates" && e.taskId === "T1" ? [i] : []);
  return events.slice(0, opens[1] ?? events.length);
};

describe("v2.6.7 T1 candidate policy (production daemon, fake adapters, zero tokens)", { timeout: 300_000 }, () => {
  test("production runDaemon records the closed order table across fresh semantic-repair test-red unknown-cost and named-test acceptance candidates including the 0.15 ratio and 60000 ms admission boundaries", async () => {
    // Fresh named-test candidate: its oracle records before the held material review rejection; zero test-GATE
    // payloads start. Its semantic repair runs acceptance ‖ review, then one full job, no selected screen.
    {
      const c = await candidate({ runId: "run-order-semantic", works: ["", ""], replies: ["red", "approve"], barrier: true,
        acceptance: [{ oracle: "test", test: "alpha works" }] });
      expect(c.summary.done).toEqual(["T1"]);
      const [fresh, repair] = c.rounds;
      expect(fresh!.starts).toEqual([...CHEAP, ...SEMANTICS]);
      expect(testRows(fresh!)).toEqual([]);
      expect(fresh!.rows.find((row) => row.gate === "acceptance")).toMatchObject({ pass: true });
      expect(String(fresh!.rows.find((row) => row.gate === "acceptance")!.details)).toContain("test: alpha works");
      expect(fresh!.rows.find((row) => row.gate === "review")).toMatchObject({ pass: false });
      // acceptance's published row precedes the release, which precedes the material review rejection
      const released = Number(readFileSync(join(c.dir, "acceptance.published"), "utf8"));
      const first = (gate: string) => Date.parse(c.events.find((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === gate)!.ts);
      expect([first("acceptance") <= released, released <= first("review")]).toEqual([true, true]);
      expect(repair!.starts).toEqual([...CHEAP, ...SEMANTICS, "test"]);
      expect(testRows(repair!)).toEqual([expect.objectContaining({ pass: true, selectionDecision: expect.objectContaining({ scope: "full", reason: "no-required-repair-tests" }) })]);
      expect(testRows(repair!)[0]!.selectedTests).toBeUndefined();
      // command roles: one oracle per round, and exactly ONE full job — the repair's
      expect(c.log.filter(isOracle)).toHaveLength(2);
      expect(c.log.filter((line) => !isOracle(line))).toEqual([""]);
    }

    // Attributed behavioral test-red repair at each admission boundary: the diagnostic (required failing
    // file plus the tests reaching the diff) precedes semantics, then the one full job.
    for (const [runId, durations, costRatio, estimatedMs] of [
      ["run-order-admit-ratio", { "tests/a.test.ts": 15, "tests/b.test.ts": 5, "tests/hidden.test.ts": 80 }, 0.15, 15],
      ["run-order-admit-estimate", { "tests/a.test.ts": 60_000, "tests/b.test.ts": 40_000, "tests/hidden.test.ts": 300_000 }, 0.15, 60_000],
    ] as const) {
      const c = await candidate({ runId, seed: [ATTRIBUTED_RED], durations });
      expect(c.summary.done).toEqual(["T1"]);
      expect(c.rounds).toHaveLength(1);
      expect(c.rounds[0]!.starts).toEqual([...CHEAP, "test", ...SEMANTICS, "test"]);
      expect(c.log).toEqual(["tests/a.test.ts", ""]);
      expect(testRows(c.rounds[0]!)).toEqual([
        expect.objectContaining({ pass: true, selectedTests: ["tests/a.test.ts"],
          selectionDecision: expect.objectContaining({ scope: "selected", reason: "diagnostic-admitted", costRatio, estimatedMs }) }),
        expect.objectContaining({ pass: true, fullSuite: true }),
      ]);
    }

    // Above either bound, unknown timing, or admissible timing measured under a different capacity: the
    // diagnostic is skipped — semantics precede the one full job. Queue row 102 (D-1626): the daemon keeps the
    // above-bound half of each boundary pair, one unknown-cost candidate whose NaN reaches the gate as null
    // through baseline.json, and the capacity plumbing. 0 ms, negative and absent timing and a malformed
    // capacity are pinned on diagnosticAdmission and through runGates in tests/gates/repair-selection.test.ts.
    const admissible = { "tests/a.test.ts": 10, "tests/b.test.ts": 5, "tests/hidden.test.ts": 85 };
    for (const [runId, durations, reason, capacity] of [
      ["run-order-ratio", { "tests/a.test.ts": 16, "tests/b.test.ts": 4, "tests/hidden.test.ts": 80 }, "diagnostic-cost-ratio"],
      ["run-order-estimate", { "tests/a.test.ts": 60_001, "tests/b.test.ts": 40_000, "tests/hidden.test.ts": 400_000 }, "diagnostic-cost-estimate"],
      // NaN (journaled as null) timing on the selected file is unknown cost, not a free screen
      ["run-order-nan", { "tests/a.test.ts": NaN, "tests/b.test.ts": 5, "tests/hidden.test.ts": 95 }, "diagnostic-unknown-cost"],
      ["run-order-capacity", admissible, "diagnostic-capacity-mismatch", { forkCap: 997, cores: 1 }],
    ] as const) {
      const c = await candidate({ runId, seed: [ATTRIBUTED_RED], ...(durations ? { durations } : {}), ...(capacity ? { capacity } : {}) });
      expect(c.summary.done).toEqual(["T1"]);
      expect(c.rounds[0]!.starts).toEqual([...CHEAP, ...SEMANTICS, "test"]);
      expect(c.log).toEqual([""]);
      expect(testRows(c.rounds[0]!)).toEqual([expect.objectContaining({ pass: true, selectionDecision: expect.objectContaining({ scope: "full", reason }) })]);
    }

    // A diagnostic behavioral red ends the round before semantics; the repaired candidate then proceeds.
    {
      const c = await candidate({ runId: "run-order-diag-red", seed: [ATTRIBUTED_RED], flags: ["diag-red"],
        durations: { "tests/a.test.ts": 10, "tests/b.test.ts": 10, "tests/hidden.test.ts": 80 }, works: ["", "rm -f @DIR@/diag-red && "] });
      expect(c.rounds[0]!.starts).toEqual([...CHEAP, "test"]);
      expect(testRows(c.rounds[0]!)).toEqual([expect.objectContaining({ pass: false, selectedTests: ["tests/a.test.ts"] })]);
      expect(c.rounds[0]!.rows.some((row) => row.gate === "acceptance" || row.gate === "review")).toBe(false);
      expect(c.log[0]).toBe("tests/a.test.ts");
    }
  });

  test("production runDaemon records the closed recovery table merge or infra outcome for complete rejected missing and genuinely cancelled candidate proof", async () => {
    // The first review seat fails to launch while acceptance is pending; acceptance APPROVES, the full proof
    // passes and the same seat's one bounded relaunch (v2.6.8 T1) approves: the merge lands only after all three proofs.
    {
      let failed = 0;
      const c = await candidate({ runId: "run-recover-complete", pane: true, replies: ["approve"], seatB: ["approve"],
        driver: () => seatDriver((name) => role(name, "review") && failed++ === 0) });
      expect(c.summary.done).toEqual(["T1"]);
      const at = (match: (e: JournalEvent) => boolean) => c.events.findIndex(match);
      const mergeAt = at((e) => e.event === "merge" && e.taskId === "T1");
      const proofs = [
        at((e) => e.event === "gate-result" && e.data.gate === "acceptance" && e.data.pass === true),
        at((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === true),
        at((e) => e.event === "gate-result" && e.data.gate === "review" && e.data.pass === true),
      ];
      expect(proofs.every((i) => i >= 0 && i < mergeAt)).toBe(true);
      expect(c.events.filter((e) => e.event === "review-no-verdict").map((e) => e.data.reviewer)).toEqual(["seat-a:seat-a"]);
      expect(c.events.find((e) => e.event === "gate-result" && e.data.gate === "review" && e.data.pass === true)?.data.reviewer).toBe("seat-a:seat-a");
      expect(c.events.filter((e) => e.event === "review-infra-retry").map((e) => e.data)).toEqual([expect.objectContaining({ reviewer: "seat-a:seat-a", sameSeat: true })]);
    }

    // An ordinary no-verdict review beside a green full suite, with recovery absent: no merge.
    {
      const c = await candidate({ runId: "run-recover-absent", replies: ["silent"] });
      expect(merged(c.events)).toBe(false);
      expect(c.summary.human).toEqual(["T1"]);
      expect(testRows(c.rounds[0]!)).toEqual([expect.objectContaining({ pass: true })]);
      expect(c.rounds[0]!.rows.find((row) => row.gate === "review")).toMatchObject({ skipped: true, infra: true });
    }

    // Seatless ACCEPTANCE with the review pending: a genuinely cancelled round — the owed test and the owed
    // (unrecorded) review are journaled as unverdicted infra rows, never behavioral reds; no merge, infra park.
    {
      const c = await candidate({ runId: "run-recover-seatless", pane: true, replies: ["approve"],
        driver: (rows) => seatDriver((name) => role(name, "judge"), async (name) => {
          if (role(name, "review")) await until(rows, (events) => events.some((e) => e.event === "gate-result" && e.data.gate === "acceptance"), "the acceptance row");
        }) });
      expect(merged(c.events)).toBe(false);
      expect(c.events.filter((e) => e.event === "task-human" && e.taskId === "T1").at(-1)?.data.kind).toBe("infra");
      const first = c.rounds[0]!;
      expect(first.starts.includes("test")).toBe(false);
      expect(c.log.filter((line) => !isOracle(line))).toEqual([]);
      expect(first.rows.find((row) => row.gate === "acceptance")).toMatchObject({ infra: true });
      for (const gate of ["test", "review"]) {
        const owed = first.rows.find((row) => row.gate === gate);
        expect({ gate, owed }).toEqual({ gate, owed: expect.objectContaining({ skipped: true, infra: true, retryable: false }) });
        expect(owed!.pass).toBeUndefined();
      }
      expect(c.events.some((e) => e.event === "task-failed")).toBe(false);
    }

    // runReviewRecovery on a subject a primed run proved full-green: both review seats fail to launch, each on
    // its one same-seat relaunch too (v2.6.8 T1), while the judge is held, then seat-a's second channel APPROVES
    // review-only. Neither discharges a sibling's debt:
    const launchFails = (refuseJudge: boolean) => (rows: () => JournalEvent[]) => {
      let reviewLaunches = 0;
      return seatDriver((name) => role(name, "review") && reviewLaunches++ < 4, async (name) => {
        if (!role(name, "judge")) return;
        await until(rows, (events) => events.filter((e) => e.event === "review-no-verdict").length >= 4, "every review launch failure");
        if (refuseJudge) throw new Error(`pane create refused for ${name}`);
      });
    };
    const recovered = (c: Awaited<ReturnType<typeof candidate>>, events: JournalEvent[], gate: string) => {
      expect(events.filter((e) => e.event === "review-no-verdict" && e.taskId === "T1").map((e) => e.data.cause))
        .toEqual(["seat-launch-failed", "seat-launch-failed", "seat-launch-failed", "seat-launch-failed"]);
      expect(events.filter((e) => e.event === "review-infra-retry" && e.taskId === "T1").map((e) => e.data.reviewer))
        .toEqual(["seat-a:seat-a", "seat-b:seat-b", "seat-a:seat-a-2"]);
      const replacement = events.findIndex((e) => e.event === "gate-result" && e.taskId === "T1" && e.data.gate === "review"
        && e.data.pass === true && e.data.reviewer === "seat-a:seat-a-2");
      expect(replacement).toBeGreaterThan(events.findLastIndex((e) => e.event === "review-infra-retry"));
      // the controlled sibling: a full green the primed run merged on, measured on this exact subject
      const green = c.primed.find((e) => e.event === "gate-result" && e.data.gate === "test" && e.data.pass === true);
      expect(merged(c.primed)).toBe(true);
      expect(events.find((e) => e.event === "gate-result" && e.data.gate === gate)?.data.commit).toBe(green?.data.commit);
      return replacement;
    };
    // (1) acceptance REJECTS: the row stands, no merge, no full job on that subject.
    {
      const fail = { pass: false, criteria: [{ criterion: "c1", met: false, reason: "src/a.ts lacks the behavior" }] };
      const pass = { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] };
      const c = await candidate({ runId: "run-recover-replaced-rejected", prime: true, pane: true, judge: [fail, pass], works: ["", ""],
        replies: ["approve"], seatB: ["approve"], seatAModels: ["seat-a", "seat-a-2"], driver: launchFails(false) });
      const first = beforeSecondRound(c.events);
      recovered(c, first, "acceptance");
      expect(first.filter((e) => e.event === "gate-result" && e.data.gate === "acceptance").map((e) => e.data.pass)).toEqual([false]);
      expect(first.some((e) => e.event === "gate-result" && e.data.gate === "test")).toBe(false);
      expect(merged(first)).toBe(false);
      expect(c.log.filter((line) => line === "")).toHaveLength(1); // the repaired candidate's own full job only
    }
    // (2) acceptance MISSING (D-974): its seat fails only after the review settled, so nothing is cancelled —
    // the full job is green on the exact subject, recovery approves, and the owed acceptance row alone parks infra.
    {
      const c = await candidate({ runId: "run-recover-replaced-owed", prime: true, pane: true, replies: ["approve"], seatB: ["approve"],
        seatAModels: ["seat-a", "seat-a-2"], driver: launchFails(true) });
      const replacement = recovered(c, c.events, "test");
      const rows = c.events.filter((e) => e.event === "gate-result" && e.taskId === "T1");
      const owed = rows.filter((e) => e.data.gate === "acceptance");
      expect(owed.map((e) => e.data)).toEqual([expect.objectContaining({ skipped: true, infra: true, retryable: false })]);
      expect(owed[0]!.data.pass).toBeUndefined();
      expect(c.events.indexOf(owed[0]!)).toBeLessThan(replacement);
      expect(rows.filter((e) => e.data.gate === "test").map((e) => e.data.pass)).toEqual([true]);
      // the recorded round proof after the approving replacement
      const proof = loadGraph(c.repo).tasks[0]!.evidence.gateResults as Record<string, unknown>[];
      const last = (gate: string) => proof.filter((g) => g.gate === gate).at(-1);
      expect(last("review")).toMatchObject({ pass: true, meta: { reviewer: "seat-a:seat-a-2" } });
      expect(last("acceptance")).toMatchObject({ pass: false, meta: { skipped: true, infra: true, gateOwed: "acceptance" } });
      expect(merged(c.events)).toBe(false);
      expect(c.events.filter((e) => e.event === "task-human" && e.taskId === "T1").at(-1)?.data.kind).toBe("infra");
    }

    // An actual throw while the semantic sibling is pending: no merge and no recoverable partial set.
    {
      const c = await candidate({ runId: "run-recover-throw", replies: ["throw"] });
      expect(merged(c.events)).toBe(false);
      expect(c.log).toEqual([]);
      expect(c.rounds[0]!.starts.includes("test")).toBe(false);
    }
  });

  test("production runDaemon draws exactly one review round for review red with unrun test and no owed row versus zero for green review with red test", async () => {
    // A material review red: the test is never measured and owes nothing — exactly one decisive review round.
    {
      const c = await candidate({ runId: "run-rounds-review-red", works: ["", ""], replies: ["red", "approve"] });
      expect(c.summary.done).toEqual(["T1"]);
      expect(testRows(c.rounds[0]!)).toEqual([]);
      // no owed row (journaled skipped + infra) of any gate
      expect(c.rounds[0]!.rows.some((row) => row.skipped === true && row.infra === true)).toBe(false);
      expect(reviewRoundsSinceApproval(c.events, "T1", decisiveReviewRounds)).toBe(1);
    }
    // A killed (exit 137) diagnostic is inconclusive: journaled unverdicted, so the material review red that
    // decides the round still draws exactly one review round, and the full job never runs in that round.
    // Beside a RED baseline the kill is forgivable as "only pre-existing failures": it is still never green.
    // `diag-sigkill` is a real SIGKILL whose verdict text names no signal: the termination receipt decides.
    for (const [flag, redBaseline] of [["diag-killed", false], ["diag-killed", true], ["diag-sigkill", false], ["diag-sigkill", true]] as const) {
      const c = await candidate({ runId: `run-rounds-${flag}-${redBaseline}`, redBaseline, seed: [ATTRIBUTED_RED], flags: [flag], works: ["", ""],
        durations: { "tests/a.test.ts": 10, "tests/b.test.ts": 10, "tests/hidden.test.ts": 80 }, replies: ["red", "approve"] });
      const first = c.rounds[0]!;
      expect(first.starts).toEqual([...CHEAP, "test", ...SEMANTICS]);
      expect(testRows(first)).toEqual([expect.objectContaining({ skipped: true, infra: true, selectedTests: ["tests/a.test.ts"] })]);
      expect(testRows(first)[0]!.pass).toBeUndefined();
      // the killed diagnostic keeps its receipts, the authoritative one naming the signal
      if (flag === "diag-sigkill") expect(testRows(first)[0]!.evidenceReceipt).toMatchObject({ termination: { kind: "signal", signal: "SIGKILL" } });
      expect(first.rows.find((row) => row.gate === "review")).toMatchObject({ pass: false });
      expect(c.log[0]).toBe("tests/a.test.ts");
      expect(reviewRoundsSinceApproval(c.events, "T1", decisiveReviewRounds)).toBe(1);
    }
    // A green review beside a red full job: zero review rounds drawn.
    {
      const c = await candidate({ runId: "run-rounds-test-red", works: ["", "rm -f @DIR@/full-red && "], flags: ["full-red"] });
      expect(c.rounds[0]!.rows.find((row) => row.gate === "review")).toMatchObject({ pass: true });
      expect(testRows(c.rounds[0]!)).toEqual([expect.objectContaining({ pass: false })]);
      expect(c.events.some((e) => e.event === "gate-result" && e.data.gate === "review" && e.data.pass === false)).toBe(false);
      expect(reviewRoundsSinceApproval(c.events, "T1", decisiveReviewRounds)).toBe(0);
    }
  });

  test("production runDaemon records the true selection reason after filtering 3000 analyzable paths from extra planning files versus a 3001 path fallback and selected green never replaces exact full proof", async () => {
    const durations = { "tests/a.test.ts": 1, "tests/b.test.ts": 1, "tests/hidden.test.ts": 98 };
    // 3000 analyzable paths beside 40 planning files still select; the full job after the green diagnostic
    // reds on a regression the selection misses: nothing merges on the selected green.
    {
      const c = await candidate({ runId: "run-select-3000", seed: [ATTRIBUTED_RED], durations, flags: ["full-red"],
        pad: { analyzable: 2995, planning: 40 }, works: ["", "rm -f @DIR@/full-red && "] });
      const first = c.rounds[0]!;
      expect(testRows(first)).toEqual([
        expect.objectContaining({ pass: true, selectedTests: ["tests/a.test.ts"],
          selectionDecision: expect.objectContaining({ scope: "selected", reason: "diagnostic-admitted" }) }),
        expect.objectContaining({ pass: false, fullSuite: true }),
      ]);
      expect(merged(beforeSecondRound(c.events))).toBe(false);
    }
    // A covered src/a.ts beside a changed source no test reaches: the WHOLE attribution is unsupported, so no
    // diagnostic screens around it; semantics precede the one full job.
    {
      const c = await candidate({ runId: "run-select-unreachable", seed: [ATTRIBUTED_RED], durations,
        works: ["echo 'export const c = 1;' > src/c.ts && "] });
      expect(c.summary.done).toEqual(["T1"]);
      expect(c.rounds[0]!.starts).toEqual([...CHEAP, ...SEMANTICS, "test"]);
      expect(c.log).toEqual([""]);
      expect(testRows(c.rounds[0]!)).toEqual([expect.objectContaining({ pass: true,
        selectionDecision: expect.objectContaining({ scope: "full", reason: "unsupported-attribution" }) })]);
      expect(testRows(c.rounds[0]!)[0]!.selectedTests).toBeUndefined();
    }
    // 3001 analyzable paths: the selector falls back, and the record names the cap — not the caller's reason.
    {
      const c = await candidate({ runId: "run-select-3001", seed: [ATTRIBUTED_RED], durations, pad: { analyzable: 2996, planning: 0 } });
      expect(c.summary.done).toEqual(["T1"]);
      expect(c.log).toEqual([""]);
      expect(testRows(c.rounds[0]!)).toEqual([expect.objectContaining({ pass: true,
        selectionDecision: expect.objectContaining({ scope: "full", reason: "analyzable-path-cap" }) })]);
      expect(testRows(c.rounds[0]!)[0]!.selectedTests).toBeUndefined();
    }
  });
});
