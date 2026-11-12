// Row 417; D-2187 add.78 G: an enacted recheck whose battery reviews re-probes each retired review seat once, in order
// (endpoint first where configured, the model probe only if it answered), readmits only on every answer, journals one
// review-seat-readmit row and clears that seat's earlier strikes live and when a later session seeds the tally.
// Every cell runs through the production runDaemon with stubbed probes (its seatProbes seam). Zero tokens: fake
// adapters, a delegating subprocess driver, synthetic review-no-verdict strike rows.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type BillingChannel } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { Slot } from "../../src/drivers/types.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { type SeatProbes } from "../../src/run/seat-readmit.js";
import { MODEL_PROBE_ERRORS } from "../../src/adapters/types.js";
import { probeAll } from "../../src/adapters/registry.js";
import { authedModels, COMMIT, setupRepo as baseSetupRepo, T } from "../helpers/tmprepo.js";

const key = (s: string) => `seat-${s}:seat-${s}`;
const work = (id: string) => ({ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
const rowsOf = (repo: string, runId: string) => Journal.open(repo, runId).read();
const readmitRows = (repo: string, runId: string) => rowsOf(repo, runId).filter((r) => r.event === "review-seat-readmit").map((r) => r.data);

function setupRepo(tasks: unknown[], seats: string[], extraCfg = "") {
  const ids = tasks.map((t) => (t as { id: string }).id);
  // tiers name each seat's model so the production doctor probe can scope it (probeScope refuses an unconfigured one)
  const tiers = `tiers:\n${seats.map((s) => `  seat-${s}:\n    vendor: seat-${s}\n    channel: api\n    models:\n      seat-${s}: frontier\n    windows:\n      seat-${s}: 128000\n`).join("")}`;
  const fixture = baseSetupRepo(tasks, { tasks: Object.fromEntries(ids.map((id) => [id, [work(id.toLowerCase())]])) },
    `${tiers}visibility:\n  llm: pane\n  keepPanes: run\nreview: { required: true, prefer: [${seats.map((s) => `seat-${s}`).join(", ")}], timeoutMs: 5000 }\n${extraCfg}`);
  const config = join(fixture.repo, ".tickmarkr", "config.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("judge: { adapter: fake, model: fake-1 }", "judge: { adapter: fake, model: fake-2 }"));
  return fixture;
}

class Seat extends FakeAdapter {
  /** The doctor model probe's shell (exit 0, no output = an answer). */
  probeShell = "true";
  /** probe() reports this seat's own model unauthed (a cached-failed verdict when no doctor.json exists). */
  failedProbe = false;
  /** Review prompts whose diff names one of these files get no answer at all (a real silent no-verdict). */
  silentOn: string[] = [];
  constructor(path: string, public override id: string) {
    super(path);
    this.vendor = id;
  }
  override async probe() {
    const modelAuth = this.failedProbe ? { [this.id]: { authed: false, reason: "probe failed", probedAt: "2026-07-16T00:00:00.000Z" } } : authedModels([this.id]);
    return { installed: true, authed: true, version: "fake", models: [this.id], modelAuth };
  }
  override channels(): BillingChannel[] {
    return [{ adapter: this.id, model: this.id, vendor: this.vendor, channel: "api", tier: "frontier" }];
  }
  override headlessCommand(file: string): string {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return prompt.startsWith("Reply with exactly OK") ? this.probeShell : "true";
    if (this.silentOn.some((f) => prompt.includes(f))) return "true";
    const body = JSON.stringify({ nonce: extractPromptNonce(prompt), approve: true, resolved: [], reraised: [], findings: [] });
    return `: SEAT=${this.id}; printf '%s' ${shq(body)}`;
  }
}
class Author extends FakeAdapter {
  override channels(): BillingChannel[] { return [super.channels()[0]!, { ...super.channels()[1]!, tier: "cheap" }]; }
}

/** A real SubprocessDriver recording `seat/task` per review launch; `refuse.on(slot name)` fails a launch. */
function seatDriver() {
  const inner = new SubprocessDriver();
  const seated: string[] = [];
  const refuse = { on: (_name: string, _seat?: string) => false };
  const before = { review: (_name: string, _seat?: string) => {} };
  const driver = {
    id: "subprocess", interactive: false,
    status: inner.status.bind(inner),
    slot: inner.slot.bind(inner),
    async run(slot: Slot, command: string) {
      const script = /([^'"\s]*dispatch\.sh)/.exec(command)?.[1];
      const seat = script ? /: SEAT=(seat-[a-z]);/.exec(readFileSync(script, "utf8"))?.[1] : undefined;
      if (seat) seated.push(`${seat}/${/^tickmarkr:review:([^:]+):/.exec(slot.name)?.[1] ?? ""}`);
      if (seat) before.review(slot.name, seat);
      if (refuse.on(slot.name, seat)) throw new Error("pane create refused");
      return inner.run(slot, command);
    },
    waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner),
    notify: inner.notify.bind(inner),
    close: (slot: Slot) => inner.close(slot),
    worktree: inner.worktree.bind(inner),
  };
  return { driver, seated, refuse, before };
}

type Answer = "up" | "down" | "throw" | "unreadable";
/** Stub probes: `endpoint` absent = no configured endpoint. Every call is logged in order. */
function stubProbes(spec: Record<string, { endpoint?: Answer; model: Answer }>) {
  const calls: string[] = [];
  const answer = (a: Answer | undefined) => {
    if (a === "throw") throw new Error("probe threw");
    return a === "unreadable" ? ("garbage" as never) : a;
  };
  const probes: SeatProbes = {
    endpoint: async (adapter) => {
      calls.push(`endpoint ${adapter}`);
      const a = answer(spec[adapter]?.endpoint);
      return a === undefined || a === "garbage" ? a : { listening: a === "up" };
    },
    model: async (adapter, model) => {
      calls.push(`model ${adapter}:${model}`);
      const a = answer(spec[adapter]?.model);
      return a === "garbage" ? a : a === "up";
    },
  };
  return { probes, calls };
}

/** Two real no-verdict strikes per seat (seat order = tally order), journaled as review-no-verdict rows. */
function strike(repo: string, runId: string, ...seats: string[]) {
  const j = Journal.open(repo, runId);
  for (const s of seats) j.append("review-no-verdict", undefined, { reviewer: key(s), noVerdict: true, cause: "silent", seatAuthoredBytes: 0 });
}

/** Session one parks T1 on refused review launches; the listed seats are retired; T1 is approved for a recheck. */
async function parkedRecheck(runId: string, seats: string[], retired: string[], tasks = [T("T1")], extraCfg = "") {
  const { repo, scriptPath } = setupRepo(tasks, seats, extraCfg);
  const adapters = [new Author(scriptPath), ...seats.map((s) => new Seat(scriptPath, `seat-${s}`))];
  const d = seatDriver();
  d.refuse.on = (name) => name.startsWith("tickmarkr:review:T1:");
  const first = await runDaemon(repo, { adapters, runId, driver: d.driver });
  expect(first.human).toEqual(["T1"]);
  strike(repo, runId, ...retired, ...retired);
  d.refuse.on = () => false;
  d.seated.length = 0;
  return { repo, adapters: adapters as (Author | Seat)[], ...d };
}

describe("a recheck re-probes each retired review seat (row 417, production runDaemon, zero tokens)", { timeout: 240_000 }, () => {
  test("a recheck readmits a retired seat only when its configured endpoint and its model probe both answer probing each seat once in order", async () => {
    const { repo, adapters, driver, seated } = await parkedRecheck("run-both", ["a", "c", "d", "z"], ["a", "c", "d"]);
    const { probes, calls } = stubProbes({
      "seat-a": { endpoint: "up", model: "up" }, // readmit
      "seat-c": { endpoint: "up", model: "down" }, // an endpoint-only check would readmit
      "seat-d": { model: "up" }, // no configured endpoint: the model probe alone answers
    });
    await approve(["run-both", "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId: "run-both", resume: true, driver, seatProbes: probes })).done).toEqual(["T1"]);
    expect(calls).toEqual([
      "endpoint seat-a", "model seat-a:seat-a",
      "endpoint seat-c", "model seat-c:seat-c",
      "endpoint seat-d", "model seat-d:seat-d",
    ]);
    expect(readmitRows(repo, "run-both")).toEqual([{ seat: key("a"), probe: "endpoint+model" }, { seat: key("d"), probe: "model" }]);
    expect(seated).toEqual(["seat-a/T1"]); // the readmitted seat is picked in that recheck
  });

  test("a dead endpoint skips the model probe and a failed or throwing probe leaves the seat retired", async () => {
    const { repo, adapters, driver, seated } = await parkedRecheck("run-dead", ["b", "c", "e", "f", "g", "h", "z"], ["b", "c", "e", "f", "g", "h"]);
    const { probes, calls } = stubProbes({
      "seat-b": { endpoint: "down", model: "up" }, // the model probe must not be called
      "seat-c": { endpoint: "up", model: "down" },
      "seat-e": { endpoint: "throw", model: "up" },
      "seat-f": { endpoint: "up", model: "throw" },
      "seat-g": { endpoint: "up", model: "unreadable" },
      "seat-h": { endpoint: "unreadable", model: "up" },
    });
    await approve(["run-dead", "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId: "run-dead", resume: true, driver, seatProbes: probes })).done).toEqual(["T1"]);
    expect(calls).toEqual([
      "endpoint seat-b",
      "endpoint seat-c", "model seat-c:seat-c",
      "endpoint seat-e",
      "endpoint seat-f", "model seat-f:seat-f",
      "endpoint seat-g", "model seat-g:seat-g",
      "endpoint seat-h",
    ]);
    expect(readmitRows(repo, "run-dead")).toEqual([]);
    expect(seated).toEqual(["seat-z/T1"]); // every probed seat stays retired; the recheck proceeds as at the base
  });

  test("two retired seats with different outcomes give one readmit row and a resume counts only later strikes for that seat", async () => {
    const tasks = [T("T1"), T("T2", { deps: ["T1"] })];
    const { repo, adapters, driver, seated, refuse } = await parkedRecheck("run-two", ["a", "b", "z"], ["a", "b"], tasks);
    const spec = { "seat-a": { endpoint: "up" as const, model: "up" as const }, "seat-b": { endpoint: "down" as const, model: "up" as const } };
    const two = stubProbes(spec);
    await approve(["run-two", "T1", "--recheck", "--by", "op"], repo);
    refuse.on = (name) => name.startsWith("tickmarkr:review:T2:");
    const second = await runDaemon(repo, { adapters, runId: "run-two", resume: true, driver, seatProbes: two.probes });
    expect(second.done).toEqual(["T1"]);
    expect(second.human).toEqual(["T2"]);
    expect(two.calls).toEqual(["endpoint seat-a", "model seat-a:seat-a", "endpoint seat-b"]); // once each, in order
    expect(readmitRows(repo, "run-two")).toEqual([{ seat: key("a"), probe: "endpoint+model" }]);
    expect(seated.filter((s) => s.endsWith("/T1"))).toEqual(["seat-a/T1"]); // live: A's strikes left the tally
    // one NEW strike after the readmit row; the next session seeds A at one strike (not retired), B at two (retired)
    strike(repo, "run-two", "a");
    refuse.on = () => false;
    seated.length = 0;
    const three = stubProbes(spec);
    await approve(["run-two", "T2", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId: "run-two", resume: true, driver, seatProbes: three.probes })).done).toContain("T2");
    expect(three.calls).toEqual(["endpoint seat-b"]); // only B is retired when seeded
    expect(seated).not.toContain("seat-b/T2"); // B, without a readmit row, stays retired (control)
    expect(readmitRows(repo, "run-two")).toHaveLength(1);
  });

  test("a plain resume and a recheck without a review gate probe nothing", async () => {
    // plain resume: retired seats, a parked task, no recheck
    {
      const { repo, adapters, driver } = await parkedRecheck("run-plain", ["a", "z"], ["a"]);
      const { probes, calls } = stubProbes({ "seat-a": { endpoint: "up", model: "up" } });
      await runDaemon(repo, { adapters, runId: "run-plain", resume: true, driver, seatProbes: probes });
      expect(calls).toEqual([]);
      expect(readmitRows(repo, "run-plain")).toEqual([]);
    }
    // a recheck whose battery has no review gate: T1 parks on a refused judge launch
    {
      const gates = ["build", "test", "lint", "evidence", "scope", "acceptance"];
      const { repo, scriptPath } = setupRepo([T("T1", { gates })], ["a", "z"]);
      const adapters = [new Author(scriptPath), new Seat(scriptPath, "seat-a"), new Seat(scriptPath, "seat-z")];
      const d = seatDriver();
      d.refuse.on = (name) => name.startsWith("tickmarkr:judge:T1:");
      const first = await runDaemon(repo, { adapters, runId: "run-noreview", driver: d.driver });
      expect(first.human).toEqual(["T1"]);
      strike(repo, "run-noreview", "a", "a");
      d.refuse.on = () => false;
      const { probes, calls } = stubProbes({ "seat-a": { endpoint: "up", model: "up" } });
      await approve(["run-noreview", "T1", "--recheck", "--by", "op"], repo);
      expect((await runDaemon(repo, { adapters, runId: "run-noreview", resume: true, driver: d.driver, seatProbes: probes })).done).toEqual(["T1"]);
      expect(calls).toEqual([]);
      expect(readmitRows(repo, "run-noreview")).toEqual([]);
    }
  });

  test("production probes readmit a cached-failed seat on a fresh answer and never on a cached answer beside a fresh resource error", async () => {
    const errored = ["b", "c", "e", "f", "g"]; // one seat per resource error
    const tasks = [T("T1"), T("T2", { deps: ["T1"] })];
    const { repo, adapters, driver, seated, refuse } = await parkedRecheck("run-prod", ["a", ...errored, "z"], ["a", ...errored], tasks);
    const seats = adapters.filter((a): a is Seat => a instanceof Seat);
    MODEL_PROBE_ERRORS.forEach((code, i) => { seats.find((s) => s.id === `seat-${errored[i]}`)!.probeShell = `echo ${code} >&2; exit 1`; });
    // the cache: A's model last failed (unroutable) with an observed identity, every errored seat last answered
    const cached = await probeAll(adapters);
    const stale = "2026-07-16T00:00:00.000Z";
    cached["seat-a"] = { ...cached["seat-a"]!, modelAuth: { "seat-a": { authed: false, reason: "probe failed", probedAt: stale, identity: "seat-a-pro" } } };
    const doctorFile = join(repo, ".tickmarkr", "doctor.json");
    writeFileSync(doctorFile, JSON.stringify(cached));
    await approve(["run-prod", "T1", "--recheck", "--by", "op"], repo);
    refuse.on = (name) => name.startsWith("tickmarkr:review:T2:"); // T2 parks so a later session can recheck it
    const second = await runDaemon(repo, { adapters, runId: "run-prod", resume: true, driver });
    expect(second.done).toEqual(["T1"]);
    expect(readmitRows(repo, "run-prod")).toEqual([{ seat: key("a"), probe: "model" }]); // no cached answer readmits
    expect(seated.filter((s) => s.endsWith("/T1"))).toEqual(["seat-a/T1"]); // the fresh answer makes A routable in that recheck
    // D-2187 add.132: the fresh verdict is merged into doctor.json for that model, its identity kept
    const verdict = JSON.parse(readFileSync(doctorFile, "utf8"))["seat-a"].modelAuth["seat-a"];
    expect(verdict).toMatchObject({ authed: true, identity: "seat-a-pro" });
    expect(verdict.probedAt).not.toBe(stale);
    expect(verdict.reason).toBeUndefined();
    // a later plain resume probes nothing and reads the same verdict; the next review still seats A
    refuse.on = () => false;
    seated.length = 0;
    await runDaemon(repo, { adapters, runId: "run-prod", resume: true, driver });
    expect(seated).toEqual([]);
    expect(JSON.parse(readFileSync(doctorFile, "utf8"))["seat-a"].modelAuth["seat-a"]).toEqual(verdict);
    await approve(["run-prod", "T2", "--recheck", "--by", "op"], repo);
    refuse.on = (_name, seat) => seat === "seat-z"; // only A can review T2 now
    expect((await runDaemon(repo, { adapters, runId: "run-prod", resume: true, driver })).done).toContain("T2");
    // health-only-in-memory would reload A's failed verdict: no seat would review T2
    expect(seated.filter((s) => s.startsWith("seat-a/"))).toEqual(["seat-a/T2"]);
    expect(readmitRows(repo, "run-prod")).toHaveLength(1);
  });

  test("an alias seat admitted through an identity allowlist stays in the review pool when it readmits", async () => {
    const allow = "routing:\n  map:\n    implement: { prefer: [fake] }\n  allow:\n    adapters: [fake, seat-z]\n    models: [\"seat-a:seat-a-pro\"]\n";
    const { repo, adapters, driver, seated } = await parkedRecheck("run-alias", ["a", "z"], ["a"], [T("T1")], allow);
    const cached = await probeAll(adapters);
    cached["seat-a"] = { ...cached["seat-a"]!, modelAuth: { "seat-a": { authed: true, probedAt: "2026-07-16T00:00:00.000Z", identity: "seat-a-pro" } } };
    const doctorFile = join(repo, ".tickmarkr", "doctor.json");
    writeFileSync(doctorFile, JSON.stringify(cached));
    await approve(["run-alias", "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId: "run-alias", resume: true, driver })).done).toEqual(["T1"]);
    expect(readmitRows(repo, "run-alias")).toEqual([{ seat: key("a"), probe: "model" }]);
    expect(seated).toEqual(["seat-a/T1"]); // a record without its identity falls out of the allowlist: Z would review
    expect(JSON.parse(readFileSync(doctorFile, "utf8"))["seat-a"].modelAuth["seat-a"].identity).toBe("seat-a-pro");
  });

  test("each readmit clears its seat's strikes before the next seat is probed, so a later strike keeps counting", async () => {
    // T0 (no review) parks on a refused judge; T1 parks on refused reviews; T2 and T3 wait on T0.
    const noReview = ["build", "test", "lint", "evidence", "scope", "acceptance"];
    const tasks = [T("T0", { gates: noReview }), T("T1"), T("T2", { deps: ["T0"] }), T("T3", { deps: ["T0"] })];
    const { repo, scriptPath } = setupRepo(tasks, ["a", "b", "z"]);
    const seats = ["a", "b", "z"].map((s) => new Seat(scriptPath, `seat-${s}`));
    const adapters = [new Author(scriptPath), ...seats];
    const d = seatDriver();
    d.refuse.on = (name) => name.startsWith("tickmarkr:review:T1:") || name.startsWith("tickmarkr:judge:T0:");
    const first = await runDaemon(repo, { adapters, runId: "run-race", driver: d.driver });
    expect(first.human.sort()).toEqual(["T0", "T1"]);
    strike(repo, "run-race", "a", "b", "a", "b");
    // session two: T1's sweep readmits A, then B's endpoint probe stays pending until T2's and T3's real reviews
    // (released by T0's recheck) have each struck A once — strikes appended AFTER A's readmit row
    seats[0]!.silentOn = ["t2.txt", "t3.txt"];
    d.refuse.on = (_name, seat) => seat === "seat-z"; // only A can review in this session
    d.seated.length = 0;
    const strikesAfterReadmit = () => {
      const rows = rowsOf(repo, "run-race");
      const at = rows.findIndex((r) => r.event === "review-seat-readmit" && r.data.seat === key("a"));
      return at < 0 ? 0 : rows.slice(at).filter((r) => r.event === "review-no-verdict" && r.data.reviewer === key("a")).length;
    };
    const calls: string[] = [];
    const probes: SeatProbes = {
      endpoint: async (adapter) => {
        calls.push(`endpoint ${adapter}`);
        if (adapter !== "seat-b") return { listening: true };
        for (let i = 0; i < 1200 && strikesAfterReadmit() < 2; i++) await new Promise((r) => setTimeout(r, 100));
        return { listening: false };
      },
      model: async (adapter, model) => { calls.push(`model ${adapter}:${model}`); return true; },
    };
    await approve(["run-race", "T1", "--recheck", "--by", "op"], repo);
    await approve(["run-race", "T0", "--recheck", "--by", "op"], repo);
    await runDaemon(repo, { adapters, runId: "run-race", resume: true, driver: d.driver, seatProbes: probes, concurrency: 4 });
    expect(calls).toEqual(["endpoint seat-a", "model seat-a:seat-a", "endpoint seat-b"]);
    expect(strikesAfterReadmit()).toBe(2);
    // live: the two strikes recorded while B's probe was pending retire A again; clearing after the sweep would
    // erase them and seat A on T1
    expect(d.seated.filter((s) => s.endsWith("/T1"))).not.toContain("seat-a/T1");
    // seeded: the next session seeds A at two post-readmit strikes (retired), so a recheck probes A again
    d.refuse.on = () => false;
    const next = stubProbes({ "seat-a": { endpoint: "down", model: "up" }, "seat-b": { endpoint: "down", model: "up" } });
    await approve(["run-race", "T1", "--recheck", "--by", "op"], repo);
    await runDaemon(repo, { adapters, runId: "run-race", resume: true, driver: d.driver, seatProbes: next.probes });
    expect(next.calls).toEqual(["endpoint seat-b", "endpoint seat-a"]); // tally order: A re-entered after its readmit row
  });

  test("with no doctor.json a readmitted seat's fresh verdict is written there and keeps it eligible on a later plain resume", async () => {
    const tasks = [T("T1"), T("T2", { deps: ["T1"] })];
    const { repo, adapters, driver, seated, refuse } = await parkedRecheck("run-nocache", ["a", "z"], ["a"], tasks);
    (adapters.find((a) => a.id === "seat-a") as Seat).failedProbe = true; // a fresh probeAll says A's model failed
    const doctorFile = join(repo, ".tickmarkr", "doctor.json");
    expect(existsSync(doctorFile)).toBe(false);
    const { probes } = stubProbes({ "seat-a": { model: "up" } });
    await approve(["run-nocache", "T1", "--recheck", "--by", "op"], repo);
    refuse.on = (name) => name.startsWith("tickmarkr:review:T2:");
    expect((await runDaemon(repo, { adapters, runId: "run-nocache", resume: true, driver, seatProbes: probes })).done).toEqual(["T1"]);
    expect(readmitRows(repo, "run-nocache")).toEqual([{ seat: key("a"), probe: "model" }]);
    expect(seated.filter((s) => s.endsWith("/T1"))).toEqual(["seat-a/T1"]);
    const doctor = JSON.parse(readFileSync(doctorFile, "utf8"));
    expect(doctor["seat-a"].modelAuth["seat-a"].authed).toBe(true);
    expect(doctor["seat-z"]).toBeDefined(); // the whole live fleet, not one adapter
    // a later plain resume reads A's fresh verdict from doctor.json (a re-probe from nothing would fail A again)
    refuse.on = () => false;
    seated.length = 0;
    await runDaemon(repo, { adapters, runId: "run-nocache", resume: true, driver });
    await approve(["run-nocache", "T2", "--recheck", "--by", "op"], repo);
    refuse.on = (_name, seat) => seat === "seat-z";
    expect((await runDaemon(repo, { adapters, runId: "run-nocache", resume: true, driver })).done).toContain("T2");
    expect(seated.filter((s) => s.startsWith("seat-a/"))).toEqual(["seat-a/T2"]);
  });

  test("a doctor.json write that fails journals no readmit row and leaves the seat retired", async () => {
    const { repo, adapters, driver, seated } = await parkedRecheck("run-wfail", ["a", "z"], ["a"]);
    mkdirSync(join(repo, ".tickmarkr", "doctor.json.tmp"), { recursive: true }); // the writer's temp file cannot be written
    const { probes, calls } = stubProbes({ "seat-a": { endpoint: "up", model: "up" } });
    await approve(["run-wfail", "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId: "run-wfail", resume: true, driver, seatProbes: probes })).done).toEqual(["T1"]);
    expect(calls).toEqual(["endpoint seat-a", "model seat-a:seat-a"]);
    expect(readmitRows(repo, "run-wfail")).toEqual([]);
    expect(seated).toEqual(["seat-z/T1"]);
  });

  test("a recheck whose merge regates after a moved task tip probes each retired seat once", async () => {
    const { repo, adapters, driver, seated, before } = await parkedRecheck("run-tip", ["a", "z"], ["a"]);
    let moved = false;
    before.review = (name) => {
      if (moved || !name.startsWith("tickmarkr:review:T1:")) return;
      moved = true;
      const wt = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })
        .split("\n\n").find((b) => /branch refs\/heads\/.*--T1$/m.test(b))?.match(/^worktree (.+)$/m)?.[1];
      execFileSync("git", ["-C", wt!, "commit", "--allow-empty", "-m", "tip moves"], { stdio: "pipe" });
    };
    const { probes, calls } = stubProbes({ "seat-a": { endpoint: "down", model: "up" } });
    await approve(["run-tip", "T1", "--recheck", "--by", "op"], repo);
    expect((await runDaemon(repo, { adapters, runId: "run-tip", resume: true, driver, seatProbes: probes })).done).toEqual(["T1"]);
    expect(rowsOf(repo, "run-tip").filter((r) => r.event === "tip-moved" && r.taskId === "T1")).toHaveLength(1);
    expect(calls).toEqual(["endpoint seat-a"]);
    expect(seated.every((s) => s.startsWith("seat-z/"))).toBe(true);
  });

  test("a strike journaled while a readmit's model probe is pending counts once, live as on replay", async () => {
    // T0's silent review strikes A while A's model probe is pending; its release resolves the probe inside that
    // strike's own journal append. A strike that joined the tally only after the note settled would reappear past
    // the readmit, so T4's one later strike would retire A live although replay counts only one post-readmit strike.
    const ids = ["T0", "T1", "T3", "T4"], runId = "run-before-readmit";
    const { repo, scriptPath } = setupRepo(ids.map((id) => T(id)), ["a", "z"]);
    const marker = (s: string) => join(repo, ".tickmarkr", s);
    const waitFile = (s: string) => `while [ ! -e ${shq(marker(s))} ]; do sleep 0.05; done; true`;
    class RaceSeat extends Seat {
      override headlessCommand(file: string) {
        const p = readFileSync(file, "utf8");
        if (p.startsWith("TICKMARKR-REVIEW")) {
          if (p.includes("t0.txt")) return `: SEAT=seat-a; ${waitFile("sweep")}`;
          if (p.includes("t1.txt")) return `: SEAT=seat-a; ${waitFile("launched")}`;
          if (p.includes("t4.txt")) return ": SEAT=seat-a; true";
        }
        return super.headlessCommand(file);
      }
    }
    const adapters = [new Author(scriptPath), new RaceSeat(scriptPath, "seat-a"), new Seat(scriptPath, "seat-z")];
    const d = seatDriver(), launched = new Set<string>();
    d.refuse.on = (name) => name.startsWith("tickmarkr:review:");
    expect((await runDaemon(repo, { adapters, runId, driver: d.driver, concurrency: 4 })).human).toHaveLength(4);
    strike(repo, runId, "a");
    for (const id of ids) await approve([runId, id, "--recheck", "--by", "op"], repo);
    d.before.review = (name, seat) => {
      if (seat !== "seat-a") return;
      launched.add(/^tickmarkr:review:([^:]+):/.exec(name)![1]!);
      if (launched.has("T0") && launched.has("T1")) writeFileSync(marker("launched"), "go");
    };
    d.refuse.on = (name, seat) => {
      const id = /^tickmarkr:review:([^:]+):/.exec(name)?.[1];
      return seat === "seat-z" && (id === "T4" || ((id === "T0" || id === "T1") && !launched.has(id)));
    };
    let t1 = false, admitted = false, t0Done = false, release: (() => void) | undefined;
    const wait = async (ready: () => boolean) => {
      const end = Date.now() + 30_000;
      while (!ready()) { expect(Date.now()).toBeLessThan(end); await new Promise((r) => setTimeout(r, 20)); }
      await new Promise((r) => setTimeout(r, 20));
    };
    const driver = { ...d.driver, project: async (id: string, state: string) => {
      if (state === "in-review" && id === "T3") await wait(() => t1);
      if (state === "in-review" && id === "T4") await wait(() => admitted && t0Done);
    } };
    await runDaemon(repo, { adapters, runId, resume: true, driver, concurrency: 4,
      seatProbes: { endpoint: async () => undefined, model: async () => {
        writeFileSync(marker("sweep"), "go");
        return new Promise<boolean>((resolve) => { release = () => resolve(true); });
      } },
      narrate: (e) => {
        if (e.event === "review-no-verdict" && e.data.reviewer === key("a")) {
          if (e.taskId === "T1") t1 = true;
          if (e.taskId === "T0") release?.();
        }
        if (e.event === "review-seat-readmit") admitted = true;
        if (e.event === "gate-result" && e.taskId === "T0" && e.data.gate === "review") t0Done = true;
      },
    });
    const rows = rowsOf(repo, runId), at = rows.findIndex((r) => r.event === "review-seat-readmit");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows.slice(at + 1).filter((r) => r.event === "review-no-verdict" && r.data.reviewer === key("a"))).toHaveLength(1);
    const last = rows.filter((r) => r.event === "gate-result" && r.taskId === "T4" && r.data.gate === "review").at(-1)!;
    expect(String(last.data.details)).not.toContain("two real no-verdicts"); // live tally matches replay: one strike
  });
});
