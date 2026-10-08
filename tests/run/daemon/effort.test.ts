// OBS-1182 launch: the daemon hands each worker transport the routed seat's effort. A recording seat
// wears a real adapter's id and renders the REAL adapter's command from exactly what the daemon passed,
// while the scripted fake shell does the work — so every assertion reads a real CLI's argv, zero tokens.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../../src/adapters/claude-code.js";
import { codex } from "../../../src/adapters/codex.js";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelsFromConfig, type Invocation, shq, type WorkerAdapter } from "../../../src/adapters/types.js";
import type { TickmarkrConfig } from "../../../src/config/config.js";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../../src/drivers/types.js";
import { tickmarkrDir } from "../../../src/graph/graph.js";
import type { Effort, Task } from "../../../src/graph/schema.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import { COMMIT, authedModels, setupRepo, T } from "../../helpers/tmprepo.js";

type Transport = "headless" | "interactive" | "resume";
interface Launch { task: string; transport: Transport; command: string }

const taskOf = (promptFile: string) => /([A-Za-z0-9_-]+)-a\d+\.md$/.exec(promptFile)?.[1] ?? "?";

class RecordingSeat extends FakeAdapter {
  readonly launches: Launch[] = [];
  constructor(scriptPath: string, private readonly real: WorkerAdapter, private readonly models: string[]) {
    super(scriptPath);
    this.id = real.id;
    this.vendor = real.vendor;
  }
  override async probe(): Promise<AuthHealth> {
    return { installed: true, authed: true, version: "recording", models: this.models, modelAuth: authedModels(this.models) };
  }
  override channels(cfg: TickmarkrConfig): BillingChannel[] {
    return channelsFromConfig(this.id, cfg);
  }
  override invoke(task: Task, cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    this.launches.push({ task: task.id, transport: "headless", command: this.real.invoke(task, cwd, a, ctx).command });
    return super.invoke(task, cwd, a, ctx);
  }
  override interactiveCommand(promptFile: string, model: string, effort?: Effort): string | null {
    this.launches.push({ task: taskOf(promptFile), transport: "interactive", command: this.real.interactiveCommand(promptFile, model, effort)! });
    return super.interactiveCommand(promptFile, model);
  }
  override resumeCommand(sessionId: string, promptFile: string, model: string, effort?: Effort): string {
    this.launches.push({ task: taskOf(promptFile), transport: "resume", command: this.real.resumeCommand!(sessionId, promptFile, model, effort) });
    return super.interactiveCommand(promptFile, model)!;
  }
}

const interactiveDriver = (): ExecutorDriver => {
  const inner = new SubprocessDriver();
  return {
    id: "interactive-test", interactive: true,
    status: inner.status.bind(inner), slot: inner.slot.bind(inner), run: inner.run.bind(inner),
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  } as ExecutorDriver;
};

const SEATS = {
  "claude-code": { real: claudeCode, high: "opus", plain: "sonnet", flag: "--effort 'high'", marker: "--effort" },
  codex: { real: codex, high: "gpt-5.6-sol", plain: "gpt-6-sol", flag: "-c 'model_reasoning_effort=high'", marker: "model_reasoning_effort" },
} as const;

// T1 rides the seat configured high, T2 the seat with no effort. A resumed run fails its first attempt
// (no commit → evidence red) so the same-channel retry resumes the session.
async function run(adapterId: keyof typeof SEATS, interactive: boolean, resume: boolean) {
  const seat = SEATS[adapterId];
  const done = (id: string) => ({ shell: `echo ${id} > ${id}.txt && ${COMMIT} ${id}`, result: { ok: true, summary: id } });
  const steps = (id: string) => resume ? [{ shell: "true", result: { ok: true, summary: "nothing yet" } }, done(id)] : [done(id)];
  const { repo, scriptPath } = setupRepo(
    [
      T("T1", { routingHints: { pin: { via: adapterId, model: seat.high } } }),
      T("T2", { routingHints: { pin: { via: adapterId, model: seat.plain } } }),
    ],
    { tasks: { T1: steps("T1"), T2: steps("T2") } },
    `contextWarnTokens: 1000\ntiers:\n  ${adapterId}:\n    modelOverrides:\n      ${seat.high}: { effort: high }\n`,
  );
  const recording = new RecordingSeat(scriptPath, seat.real, [seat.high, seat.plain]);
  if (resume) recording.contextUsage = () => ({ tokens: 500 });
  const runId = `run-effort-${adapterId}-${interactive ? "interactive" : "headless"}`;
  const summary = await runDaemon(repo, {
    adapters: [recording, new FakeAdapter(scriptPath)],
    runId,
    ...(interactive ? { driver: interactiveDriver() } : {}),
  });
  const dispatched = Journal.open(repo, runId).read().filter((e) => e.event === "task-dispatch");
  return { summary, launches: recording.launches, dispatched };
}

describe("OBS-1182 daemon effort delivery", () => {
  test("the production daemon delivers configured high effort across both Claude and Codex headless interactive transports plus Claude resume versus omitted effort retaining defaults, so a transport dropping the setting fails", async () => {
    const cases: Array<[keyof typeof SEATS, boolean, boolean, Transport[]]> = [
      ["claude-code", false, false, ["headless"]],
      ["claude-code", true, true, ["interactive", "resume"]],
      ["codex", false, false, ["headless"]],
      ["codex", true, false, ["interactive"]],
    ];
    for (const [adapterId, interactive, resume, transports] of cases) {
      const seat = SEATS[adapterId];
      const { summary, launches, dispatched } = await run(adapterId, interactive, resume);
      expect(summary.done.sort(), `${adapterId} ${transports.join("+")}`).toEqual(["T1", "T2"]);
      const high = launches.filter((l) => l.task === "T1");
      const plain = launches.filter((l) => l.task === "T2");
      expect(high.map((l) => l.transport)).toEqual(transports);
      expect(plain.map((l) => l.transport)).toEqual(transports);
      for (const l of high) expect(l.command, `${adapterId} ${l.transport}`).toContain(` ${seat.flag} `);
      for (const l of plain) expect(l.command, `${adapterId} ${l.transport}`).not.toContain(seat.marker);
      // the dispatch record names the effort launched, and omission stays omission — never a level
      for (const e of dispatched) {
        const assignment = e.data.assignment as Assignment;
        expect(assignment.model).toBe(e.taskId === "T1" ? seat.high : seat.plain);
        if (e.taskId === "T1") expect(assignment.effort).toBe("high");
        else expect("effort" in assignment).toBe(false);
      }
    }
  }, 180_000);
});

// A consult seat wearing claude-code: opus answers with prose, never a verdict, so the walk falls
// through to the sonnet pin, which answers a nonce-bound human verdict.
class ProseConsultSeat extends RecordingSeat {
  override headlessCommand(promptFile: string, model: string): string {
    if (model === "opus") return "echo 'no verdict here'";
    const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(readFileSync(promptFile, "utf8"))?.[1];
    return `echo ${shq(JSON.stringify({ nonce, action: "human", notes: "operator must look" }))}`;
  }
}

describe("OBS-1182 consult invocation journal", () => {
  test("the consult-verdict row journals every launched consult seat with its effort, a failed preferred seat included", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1", { routingHints: { pin: { via: "fake", model: "fake-1" } } })],
      // no trailer: the worker exits without a completion marker, so the stall consult runs
      { tasks: { T1: [{ shell: "true" }] } },
    );
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), [
      "judge: { adapter: fake, model: fake-1 }",
      "taskTimeoutMinutes: 0.02",
      "consult: { adapter: claude-code, model: sonnet, prefer: [\"claude-code:opus\"] }",
      "tiers:\n  claude-code:\n    modelOverrides:\n      opus: { effort: high }",
    ].join("\n") + "\n");
    const runId = "run-effort-consult-journal";
    const seat = new ProseConsultSeat(scriptPath, claudeCode, ["opus", "sonnet"]);
    const summary = await runDaemon(repo, { adapters: [seat, new FakeAdapter(scriptPath)], runId });
    expect(summary.human).toEqual(["T1"]);
    const verdicts = Journal.open(repo, runId).read().filter((e) => e.event === "consult-verdict");
    expect(verdicts).toHaveLength(1);
    const invocations = verdicts[0]!.data.invocations as Array<Record<string, unknown>>;
    expect(invocations.map(({ reason: _reason, vendor: _vendor, ...rest }) => rest)).toEqual([
      { adapter: "claude-code", model: "opus", effort: "high", outcome: "failed" },
      { adapter: "claude-code", model: "sonnet", outcome: "completed" },
    ]);
    for (const inv of invocations) expect(inv.vendor).not.toBe("unknown");
    expect(verdicts[0]!.data).toMatchObject({ action: "human", model: "sonnet" });
    expect("effort" in verdicts[0]!.data).toBe(false);
  }, 60_000);
});
