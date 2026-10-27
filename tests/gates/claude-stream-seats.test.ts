import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { shq, type Assignment, type BillingChannel, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { extractVerdictJson, REVIEW_FIRST_LIVENESS_MS, resetGateCpuAccountantFactoryForTests, runLlmDetailed, setGateCpuAccountantFactoryForTests, verdictNonceLine } from "../../src/gates/llm.js";
import { runGates, type GateContext, type GateEvent } from "../../src/gates/run-gates.js";
import { validateGraph, type Effort } from "../../src/graph/schema.js";
import { sh } from "../../src/run/git.js";
import { consult } from "../../src/run/consult.js";
import { hooks, init, own, recordedPath, turn, working } from "../fixtures/claude-stream/fixture.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const task = { ...validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" },
  tasks: [{ id: "T1", title: "stream seats", goal: "review the change", shape: "implement", complexity: 8,
    files: ["src/work.ts"], acceptance: ["works"] }] }).tasks[0]!, gates: ["review" as const] };
const author: Assignment = { adapter: "author", model: "author", tier: "frontier", channel: "sub" };
const seat: BillingChannel = { adapter: "claude-code", model: "sonnet", vendor: "anthropic", tier: "frontier", channel: "sub", effort: "high" };
const spare: BillingChannel = { ...seat, model: "spare" };

beforeEach(() => setGateCpuAccountantFactoryForTests(() => ({ async start() {}, async stop() {},
  read: () => ({ cpu: { ms: 0, resolutionMs: 1 }, gaps: 0 }) })));
afterEach(() => { vi.restoreAllMocks(); resetGateCpuAccountantFactoryForTests(); });

function adapter() {
  const calls: Array<{ prompt: string; output?: "stream"; command: string; model: string; effort?: Effort }> = [];
  const shim = fileURLToPath(new URL("../fixtures/claude-stream/cli.cjs", import.meta.url));
  const value: WorkerAdapter = { ...claudeCode,
    headlessCommand(pf, model, effort, output) {
      const command = claudeCode.headlessCommand(pf, model, effort, output);
      calls.push({ prompt: readFileSync(pf, "utf8"), model, effort, output, command });
      // Execute the production command with a fixture CLI, never the installed claude binary.
      return command.replace(/^claude\b/, `${shq(process.execPath)} ${shq(shim)} ${shq(fileURLToPath(recordedPath))}`);
    },
  };
  return { value, calls };
}

async function context(adapter: WorkerAdapter): Promise<GateContext> {
  const repo = makeRepo({ "src/work.ts": "export const work = 1;\n" });
  const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/work.ts"), "export const work = 2;\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "work"], { cwd: repo });
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge = { ...cfg.judge, adapter: seat.adapter, model: seat.model };
  cfg.tiers[seat.adapter] = { vendor: "anthropic", channel: "sub", models: { sonnet: "frontier", spare: "frontier" },
    modelOverrides: { sonnet: { effort: "high" } } };
  cfg.review.prefer = ["claude-code:sonnet"];
  return { worktree: repo, baseRef, author, result: { ok: true, summary: "work", deviations: [], raw: "" },
    cfg, commands: {}, baseline: await captureBaseline(repo, {}),
    adapters: [adapter], channels: [{ ...author, vendor: "other" }, seat, spare],
    judgeChannels: [seat], artifactDir: makeTestTempDir("stream-artifacts-"),
    reviewNoVerdicts: new Map(), demotedReviewers: new Set() };
}

function via(driver: ExecutorDriver) {
  return { driver, keep: true, nameFor: (role: string) => `${role}-stream`, labelFor: (role: string) => role };
}

// A real shell executes the pane script, including pipefail, tee, instrumentation and the trailer.
class ShellPane extends SubprocessDriver {
  override interactive = true;
  scripts: string[] = [];
  override async run(slot: Slot, command: string): Promise<void> {
    const path = /^bash '(.+)'$/.exec(command)![1]!;
    this.scripts.push(readFileSync(path, "utf8"));
    return super.run(slot, command);
  }
}

type Behavior = "working" | "silent" | "never" | "late";
// Deterministic transport clock for 30s/900s policy. It writes the same file tee owns in a live pane;
// the terminal deliberately carries a contradictory verdict, proving it is not the stream reader.
class ClockPane implements ExecutorDriver {
  id = "clock-stream";
  interactive = true;
  elapsed = 0;
  closed = 0;
  launches: Array<{ model: string; script: string; prompt: string }> = [];
  private active = new Map<string, { capture: string; prompt: string; model: string; waited: number }>();
  constructor(private behavior: Behavior) {}
  async slot(cwd: string, name: string): Promise<Slot> { return { id: `${name}-${this.launches.length}`, name, cwd }; }
  async run(slot: Slot, command: string): Promise<void> {
    const scriptPath = /^bash '(.+)'$/.exec(command)![1]!;
    const script = readFileSync(scriptPath, "utf8");
    const capture = /\| tee '([^']+)'/.exec(script)?.[1];
    if (!capture) throw new Error("gate seat did not request a stream capture");
    const prompt = readFileSync(join(dirname(scriptPath), "prompt.md"), "utf8");
    const model = /--model '([^']+)'/.exec(script)![1]!;
    this.launches.push({ model, script, prompt });
    this.active.set(slot.id, { capture, prompt, model, waited: 0 });
    writeFileSync(capture, model === "spare" ? turn(prompt)
      : this.behavior === "working" ? working : hooks + (this.behavior === "silent" ? init : ""));
  }
  async waitOutput(slot: Slot, _pattern: string, ms = 0): Promise<boolean> {
    const state = this.active.get(slot.id)!;
    if (state.model === "spare") return true;
    this.elapsed += ms;
    state.waited += ms;
    if (this.behavior === "late") {
      writeFileSync(state.capture, state.waited <= REVIEW_FIRST_LIVENESS_MS ? hooks + init : turn(state.prompt));
      return state.waited > REVIEW_FIRST_LIVENESS_MS;
    }
    return false;
  }
  async read(slot: Slot): Promise<string> {
    const state = this.active.get(slot.id)!;
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(state.prompt)![1];
    return `{"nonce":"${nonce}","approve":false,"findings":["terminal must not be parsed"]}` +
      (state.model === "spare" || this.behavior === "late" && state.waited > REVIEW_FIRST_LIVENESS_MS ? `\nTICKMARKR_EXIT_${nonce}:0` : "");
  }
  async waitAgentStatus(): Promise<boolean> { return false; }
  async status(): Promise<"working"> { return "working"; }
  async notify(): Promise<void> {}
  async close(): Promise<void> { this.closed++; }
  async worktree(): Promise<string> { return ""; }
}

async function clocked(ctx: GateContext, pane: ClockPane) {
  const origin = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => origin + pane.elapsed);
  const events: GateEvent[] = [];
  try {
    const round = await runGates(task, { ...ctx, via: via(pane), onGate: (event) => { events.push(event); } });
    return { round, events };
  } finally { clock.mockRestore(); }
}

test("text LLM calls preserve three adapter arguments directly and through both gate proxies", async () => {
  for (const streaming of [false, true]) {
    const a = adapter();
    if (!streaming) a.value.streamTurn = undefined;
    const cwd = makeTestTempDir("text-arguments-");
    const command = vi.spyOn(a.value, "headlessCommand");
    for (const paneMode of [false, true]) {
      for (const effort of [undefined, "medium"] as const) {
        command.mockClear();
        const result = await runLlmDetailed(a.value, "sonnet", `TICKMARKR-CONSULT\n${verdictNonceLine("deadbeef")}`, cwd,
          paneMode ? { driver: new ShellPane(), name: "consult" } : undefined, 300_000, effort);
        expect(extractVerdictJson<{ action: string }>(result.output, "deadbeef")?.action).toBe("retry");
        expect(command).toHaveBeenCalledExactlyOnceWith(expect.any(String), "sonnet", effort);
      }
    }
  }
  const a = adapter();
  a.value.streamTurn = undefined;
  const command = vi.spyOn(a.value, "headlessCommand");
  const ctx = await context(a.value);
  for (const paneMode of [false, true]) {
    for (const gate of ["acceptance", "review"] as const) {
      command.mockClear();
      const round = await runGates({ ...task, gates: [gate] }, { ...ctx,
        ...(paneMode ? { via: { ...via(new ShellPane()), keep: false } } : {}) });
      expect(round.results.find((r) => r.gate === gate)).toMatchObject({ pass: true });
      expect(command).toHaveBeenCalledExactlyOnceWith(expect.any(String), "sonnet", "high");
    }
  }
});

test("test: a claude judge or review seat launched through the gates' instrumented and retirement-guarded adapters runs the verbose stream json output headless and in a pane and answers with the final successful result text, while a claude worker and a claude consult keep text output, so a gate seat reading text or a worker reading the stream fails", async () => {
  for (const paneMode of [false, true]) {
    const a = adapter();
    const ctx = await context(a.value);
    const driver = new ShellPane();
    for (const gate of ["acceptance", "review"] as const) {
      const round = await runGates({ ...task, gates: [gate] }, { ...ctx, ...(paneMode ? { via: { ...via(driver), keep: false } } : {}) });
      expect(round.results.find((r) => r.gate === gate), `${paneMode} ${gate}`).toMatchObject({ pass: true });
    }
    expect(a.calls).toHaveLength(2);
    for (const call of a.calls) {
      expect(call.output).toBe("stream");
      expect(call.command).toContain("--output-format stream-json --verbose");
      expect(call.effort).toBe("high");
    }
    if (paneMode) {
      expect(driver.scripts).toHaveLength(2);
      for (const script of driver.scripts) {
        expect(script).toContain("set -o pipefail");
        expect(script).toMatch(/\| tee '[^']+\/turn.jsonl'/);
        expect(script).toMatch(/TICKMARKR_''EXIT_[a-f0-9]+/);
      }
    }
    const promptFile = join(makeTestTempDir("worker-text-"), "prompt.md");
    writeFileSync(promptFile, "TICKMARKR worker");
    const worker = a.value.invoke(task, ctx.worktree, seat, { promptFile });
    expect(worker.command).toContain("--output-format text");
    expect(worker.command).not.toContain("--verbose");
    expect((await sh(worker.command, ctx.worktree)).stdout).not.toContain('"type":"result"');
    ctx.cfg.consult = { ...ctx.cfg.consult, adapter: seat.adapter, model: seat.model };
    ctx.cfg.visibility.llm = paneMode ? "pane" : "headless";
    const consulted = await consult({ taskId: "T1", trigger: "gate-fail", journalTail: "[]", transcript: "", diff: "", gates: [] },
      ctx.cfg, [a.value], driver, ctx.worktree, ctx.artifactDir!, { channels: [seat] });
    expect(consulted.action).toBe("retry");
    const consultCall = a.calls.find((call) => call.prompt.startsWith("TICKMARKR-CONSULT"));
    expect(consultCall).toBeDefined();
    expect(consultCall!.output).toBeUndefined();
    expect(consultCall!.command).toContain("--output-format text");
  }
});

test("test: through the gates' production adapter proxies, a working claude review seat killed at the review ceiling is recorded truncated with its stream bytes after init, counts one strike, is not demoted and is retired at its second such no-verdict, while one silent after init is demoted at once, so a working seat recorded silent fails", async () => {
  const a = adapter();
  const ctx = await context(a.value);
  for (let strike = 1; strike <= 2; strike++) {
    const pane = new ClockPane("working");
    const { round, events } = await clocked(ctx, pane);
    expect(round.results.find((r) => r.gate === "review")).toMatchObject({ pass: true });
    expect(events.find((e) => e.name === "review-no-verdict")?.payload).toMatchObject({ cause: "truncated",
      seatAuthoredBytes: Buffer.byteLength(own), noVerdict: true });
    expect(ctx.reviewNoVerdicts!.get("claude-code:sonnet")).toEqual(Array(strike).fill("truncated"));
    expect(ctx.demotedReviewers!.has("claude-code:sonnet")).toBe(strike === 2);
    expect(pane.elapsed).toBe(900_000);
    expect(pane.closed).toBe(1); // killed even though keep was requested
    expect(pane.launches.map((l) => l.model)).toEqual(["sonnet", "spare"]);
  }
  const after = new ClockPane("working");
  await clocked(ctx, after);
  expect(after.launches.map((l) => l.model)).toEqual(["spare"]);
  const silentCtx = await context(adapter().value);
  const silent = new ClockPane("silent");
  const { events } = await clocked(silentCtx, silent);
  expect(events.find((e) => e.name === "review-no-verdict")?.payload).toMatchObject({ cause: "silent", seatAuthoredBytes: 0 });
  expect(silentCtx.demotedReviewers!.has("claude-code:sonnet")).toBe(true);
  expect(silentCtx.reviewNoVerdicts!.get("claude-code:sonnet")).toEqual(["silent"]);
  expect(silent.elapsed).toBe(900_000); // init buys thinking time, not immunity from the ceiling
});

test("test: in a pane a claude review seat with no init event at the first liveness beat is re-routed as never started, while a live seat emitting its init event and then nothing past the beat survives and passes on its later verdict, so a beat exemption kept for claude or a byte floor killing a thinking seat fails", async () => {
  const ctx = await context(adapter().value);
  const never = new ClockPane("never");
  const { round, events } = await clocked(ctx, never);
  expect(events.find((e) => e.name === "review-no-verdict")?.payload).toMatchObject({ cause: "launch-never-started", seatAuthoredBytes: 0 });
  expect(round.results.find((r) => r.gate === "review")).toMatchObject({ pass: true });
  expect(never.elapsed).toBe(REVIEW_FIRST_LIVENESS_MS);
  expect(never.launches.map((l) => l.model)).toEqual(["sonnet", "spare"]);
  const late = new ClockPane("late");
  const live = await clocked(await context(adapter().value), late);
  expect(live.events.filter((e) => e.name === "review-no-verdict")).toEqual([]);
  expect(live.round.results.find((r) => r.gate === "review")).toMatchObject({ pass: true });
  expect(late.elapsed).toBe(2 * REVIEW_FIRST_LIVENESS_MS);
  expect(late.launches.map((l) => l.model)).toEqual(["sonnet"]);
  // Judge seats use the same stream liveness contract, including forced closure at their ceiling.
  for (const behavior of ["never", "late", "working"] as const) {
    const pane = new ClockPane(behavior);
    const origin = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => origin + pane.elapsed);
    try {
      const r = await runLlmDetailed(adapter().value, "sonnet", `TICKMARKR-JUDGE\n${verdictNonceLine("deadbeef")}`,
        ctx.worktree, { driver: pane, name: "judge", keep: true }, 900_000);
      expect(r.launchNeverStarted).toBe(behavior === "never");
      expect(r.timedOut).toBe(behavior === "working");
      if (behavior === "late") expect(extractVerdictJson<{ pass: boolean }>(r.output, "deadbeef")?.pass).toBe(true);
      else expect(pane.closed).toBe(1);
    } finally { clock.mockRestore(); }
  }
});

test("test: the persisted raw capture of a claude review seat holds its stream from the init event on and none of the hook event bytes before it, so a raw file carrying the user's hook output fails", async () => {
  const a = adapter();
  const ctx = await context(a.value);
  const { events } = await clocked(ctx, new ClockPane("working"));
  const failure = events.find((e) => e.name === "review-no-verdict")!.payload!;
  expect(readFileSync(String(failure.rawPath), "utf8")).toBe(init + own);
  // Completed streams are persisted too, on both transports, while the verdict stays decoded text.
  for (const paneMode of [false, true]) {
    const fresh = await context(a.value);
    const round = await runGates(task, { ...fresh, ...(paneMode ? { via: { ...via(new ShellPane()), keep: false } } : {}) });
    const review = round.results.find((r) => r.gate === "review")!;
    expect(review.pass).toBe(true);
    const raw = readFileSync(String(review.meta!.rawPath), "utf8");
    const prompt = a.calls.at(-1)!.prompt;
    expect(raw).toBe(turn(prompt).slice(hooks.length));
    expect(raw).toContain('"type":"result"');
    expect(raw).not.toContain("fixture-hook-output");
    expect(raw).not.toContain("hook_started");
    expect(raw).not.toContain("hook_response");
  }
});
