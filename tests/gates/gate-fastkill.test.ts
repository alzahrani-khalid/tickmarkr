import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import {
  extractVerdictJson,
  resetGateCpuAccountantFactoryForTests,
  resetGateInactivityWindowMsForTests,
  runViaDriver,
  setGateCpuAccountantFactoryForTests,
  setGateInactivityWindowMsForTests,
  verdictNonceLine,
} from "../../src/gates/llm.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import {
  resetHarvestCpuFlatMsForTests,
  setHarvestCpuFlatMsForTests,
} from "../../src/run/stall.js";
import { makeRepo } from "../helpers/tmprepo.js";

type CpuMode = "flat" | "active" | "unmeasurable";

class ScriptedCpuAccountant {
  private reads = 0;

  constructor(private readonly mode: CpuMode) {}

  async start(): Promise<void> {}

  read(): { cpu: { ms: number; resolutionMs: number } | undefined; gaps: number } {
    this.reads++;
    if (this.mode === "unmeasurable") return { cpu: undefined, gaps: this.reads };
    return {
      cpu: { ms: this.mode === "active" ? this.reads : 0, resolutionMs: 1 },
      gaps: 0,
    };
  }

  async stop(): Promise<void> {}
}

interface DriverPlan {
  trailerAfterMs: number;
  verdict: (nonce: string) => Record<string, unknown>;
  snapshot?: (read: number) => string;
}

interface ProbeSlot extends Slot {
  plan: DriverPlan;
  startedAt: number;
  reads: number;
  nonce: string;
}

class ProbeDriver implements ExecutorDriver {
  id = "gate-probe";
  interactive = false;
  readonly slots: ProbeSlot[] = [];
  readonly waitDurations: number[] = [];

  constructor(private readonly plans: DriverPlan[]) {}

  async slot(cwd: string, name: string): Promise<ProbeSlot> {
    const plan = this.plans[this.slots.length];
    if (!plan) throw new Error(`no driver plan for slot ${this.slots.length}`);
    const slot: ProbeSlot = {
      id: `probe-${this.slots.length}`,
      name,
      cwd,
      plan,
      startedAt: Date.now(),
      reads: 0,
      nonce: "",
    };
    this.slots.push(slot);
    return slot;
  }

  async run(): Promise<void> {}

  async waitOutput(slot: ProbeSlot, pattern: string, timeoutMs: number): Promise<boolean> {
    slot.nonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)?.[1] ?? "";
    this.waitDurations.push(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return Date.now() - slot.startedAt >= slot.plan.trailerAfterMs;
  }

  async waitAgentStatus(): Promise<boolean> { return false; }
  async status(): Promise<string> { return "unknown"; }

  async read(slot: ProbeSlot): Promise<string> {
    slot.reads++;
    if (slot.nonce && Date.now() - slot.startedAt >= slot.plan.trailerAfterMs) {
      return `${JSON.stringify({ nonce: slot.nonce, ...slot.plan.verdict(slot.nonce) })}\nTICKMARKR_EXIT_${slot.nonce}:0`;
    }
    return slot.plan.snapshot?.(slot.reads) ?? "frozen gate snapshot";
  }

  async notify(): Promise<void> {}
  async close(): Promise<void> {}
  async worktree(): Promise<string> { return ""; }
}

function fakeScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-gate-fastkill-"));
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify({ tasks: {} }));
  return path;
}

class NamedFake extends FakeAdapter {
  constructor(script: string, readonly id: string, readonly vendor: string) {
    super(script);
  }
}

function useCpuModes(...modes: CpuMode[]): void {
  let index = 0;
  setGateCpuAccountantFactoryForTests(() => new ScriptedCpuAccountant(modes[index++] ?? modes.at(-1) ?? "flat"));
}

const judgeVerdict = () => ({
  pass: true,
  criteria: [{ criterion: "c1", met: true, reason: "changed line proves it", evidence: { path: "a.txt", line: 1 } }],
});
const reviewVerdict = () => ({ approve: true, findings: [] });

function repoWithCommit(): { repo: string; base: string } {
  const repo = makeRepo({ "a.txt": "before\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "after\n");
  execSync("git add -A && git commit --no-gpg-sign -m work", { cwd: repo });
  return { repo, base };
}

const author: Assignment = {
  adapter: "fake",
  model: "fake-1",
  channel: "sub",
  tier: "frontier",
};

function gateVia(driver: ExecutorDriver) {
  return {
    driver,
    nameFor: (role: "judge" | "review", adapter: string) => `T1-${role}-${adapter}`,
    labelFor: (role: "judge" | "review") => `${role.toUpperCase()} T1`,
  };
}

afterEach(() => {
  resetGateCpuAccountantFactoryForTests();
  resetGateInactivityWindowMsForTests();
  resetHarvestCpuFlatMsForTests();
});

describe("v2.0 calibrated gate inactivity policy", () => {
  test("test: a runViaDriver gate wait with a frozen snapshot and a cpu-flat dispatched tree and no trailer concludes at the inactivity window not the full timeout", async () => {
    setGateInactivityWindowMsForTests(24);
    setHarvestCpuFlatMsForTests(0);
    useCpuModes("flat");
    const driver = new ProbeDriver([{ trailerAfterMs: Number.POSITIVE_INFINITY, verdict: judgeVerdict }]);
    const adapter = new FakeAdapter(fakeScript());
    const nonce = "11111111";
    const startedAt = Date.now();
    const output = await runViaDriver(
      adapter,
      "fake-1",
      `TICKMARKR-JUDGE\n${verdictNonceLine(nonce)}`,
      process.cwd(),
      { driver, name: "T1-judge-fake" },
      250,
    );
    const elapsed = Date.now() - startedAt;

    expect(output).toBe("frozen gate snapshot");
    expect(elapsed).toBeGreaterThanOrEqual(24);
    expect(elapsed).toBeLessThan(180);
    expect(driver.waitDurations.length).toBeGreaterThan(1);
    expect(Math.max(...driver.waitDurations)).toBeLessThan(250);
  });

  test("test: snapshot growth or cpu activity or an unmeasurable cpu sample each hold the runViaDriver wait open until the trailer arrives", async () => {
    setGateInactivityWindowMsForTests(20);
    setHarvestCpuFlatMsForTests(0);
    const cases: { mode: CpuMode; snapshot?: (read: number) => string }[] = [
      { mode: "flat", snapshot: (read) => Array.from({ length: read }, (_, i) => `row ${i}`).join("\n") },
      { mode: "active" },
      { mode: "unmeasurable" },
    ];

    for (let i = 0; i < cases.length; i++) {
      useCpuModes(cases[i]!.mode);
      const driver = new ProbeDriver([{
        trailerAfterMs: 55,
        verdict: judgeVerdict,
        snapshot: cases[i]!.snapshot,
      }]);
      const nonce = `2222222${i}`;
      const output = await runViaDriver(
        new FakeAdapter(fakeScript()),
        "fake-1",
        `TICKMARKR-JUDGE\n${verdictNonceLine(nonce)}`,
        process.cwd(),
        { driver, name: `T1-judge-${i}` },
        180,
      );
      expect(extractVerdictJson(output, nonce)).toMatchObject({ pass: true });
      expect(Date.now() - driver.slots[0]!.startedAt).toBeGreaterThanOrEqual(50);
    }
  });

  test("test: a live channel quiet past the window that later prints a valid trailer is concluded at the window and its late verdict never decides the gate", async () => {
    setGateInactivityWindowMsForTests(20);
    setHarvestCpuFlatMsForTests(0);
    useCpuModes("flat", "flat");
    const late = new ProbeDriver([{ trailerAfterMs: 70, verdict: judgeVerdict }]);
    const firstNonce = "33333333";
    const concluded = await runViaDriver(
      new FakeAdapter(fakeScript()),
      "fake-1",
      `TICKMARKR-JUDGE\n${verdictNonceLine(firstNonce)}`,
      process.cwd(),
      { driver: late, name: "T1-judge-late", keep: true },
      180,
    );
    expect(extractVerdictJson(concluded, firstNonce)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 60));
    const lateBytes = await late.read(late.slots[0]!);
    expect(extractVerdictJson(lateBytes, firstNonce)).toMatchObject({ pass: true });

    const retry = new ProbeDriver([{ trailerAfterMs: 0, verdict: () => ({ pass: false, criteria: [] }) }]);
    const retryNonce = "44444444";
    const retryBytes = await runViaDriver(
      new FakeAdapter(fakeScript()),
      "fake-2",
      `TICKMARKR-JUDGE\n${verdictNonceLine(retryNonce)}`,
      process.cwd(),
      { driver: retry, name: "T1-judge-retry" },
      180,
    );
    expect(extractVerdictJson(retryBytes, retryNonce)).toMatchObject({ pass: false });
    expect(extractVerdictJson(retryBytes, firstNonce)).toBeNull();
  });

  test("test: through runGates reviewGate reaches the changed runViaDriver wait whose fast conclusion returns unparseable so runGates performs exactly one cross-channel review retry whose verdict decides the review gate", async () => {
    setGateInactivityWindowMsForTests(20);
    setHarvestCpuFlatMsForTests(0);
    useCpuModes("flat", "flat");
    const driver = new ProbeDriver([
      { trailerAfterMs: Number.POSITIVE_INFINITY, verdict: reviewVerdict },
      { trailerAfterMs: 0, verdict: reviewVerdict },
    ]);
    const script = fakeScript();
    const worker = new NamedFake(script, "fake", "fake-a");
    const primary = new NamedFake(script, "fake-b", "fake-b");
    const retry = new NamedFake(script, "fake-c", "fake-c");
    const channels: BillingChannel[] = [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake-b", vendor: "fake-b", model: "fake-b-1", channel: "sub", tier: "frontier" },
      { adapter: "fake-c", vendor: "fake-c", model: "fake-c-1", channel: "api", tier: "mid" },
    ];
    const { repo, base } = repoWithCommit();
    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "h" },
      tasks: [{
        id: "T1", title: "review retry", goal: "gate it", shape: "implement", complexity: 8,
        files: ["a.txt"], gates: ["build", "test", "lint", "evidence", "scope", "review"],
        acceptance: [{ oracle: "command", command: "true" }],
      }],
    }).tasks[0]!;
    const cfg = structuredClone(DEFAULT_CONFIG);
    const events: GateEvent[] = [];
    const { results } = await runGates(task, {
      worktree: repo,
      baseRef: base,
      result: { ok: true, summary: "done", deviations: [], raw: "" },
      author,
      commands: {},
      baseline: await captureBaseline(repo, {}),
      channels,
      adapters: [worker, primary, retry],
      cfg,
      via: gateVia(driver),
      pipeline: "v185",
      onGate: (event) => { events.push(event); },
    });

    expect(driver.slots).toHaveLength(2);
    const review = results.find((result) => result.gate === "review");
    expect(review).toMatchObject({ gate: "review", pass: true });
    expect(review!.meta?.reviewRetry).toEqual({
      flaked: "fake-b:fake-b-1",
      retried: "fake-c:fake-c-1",
    });
    expect(events.filter((event) => event.phase === "end" && event.gate === "review")).toHaveLength(1);
  });

  test("test: through runGates acceptanceGate reaches the changed runViaDriver wait whose fast conclusion returns unparseable so runGates performs exactly one cross-channel judge retry whose verdict decides acceptance", async () => {
    setGateInactivityWindowMsForTests(20);
    setHarvestCpuFlatMsForTests(0);
    useCpuModes("flat", "flat");
    const driver = new ProbeDriver([
      { trailerAfterMs: Number.POSITIVE_INFINITY, verdict: judgeVerdict },
      { trailerAfterMs: 0, verdict: judgeVerdict },
    ]);
    const script = fakeScript();
    const primary = new NamedFake(script, "fake", "fake-a");
    const retry = new NamedFake(script, "fake-b", "fake-b");
    const channels: BillingChannel[] = [
      { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
      { adapter: "fake-b", vendor: "fake-b", model: "fake-2", channel: "api", tier: "mid" },
    ];
    const { repo, base } = repoWithCommit();
    const task = validateGraph({
      version: 1,
      spec: { source: "native", paths: ["spec.md"], hash: "h" },
      tasks: [{
        id: "T1", title: "judge retry", goal: "gate it", shape: "implement", complexity: 8,
        files: ["a.txt"],
        gates: ["build", "test", "lint", "evidence", "scope", "acceptance"],
        acceptance: ["the change is correct"],
      }],
    }).tasks[0]!;
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    cfg.judge.model = "fake-1";
    const events: GateEvent[] = [];
    const { results } = await runGates(task, {
      worktree: repo,
      baseRef: base,
      result: { ok: true, summary: "done", deviations: [], raw: "" },
      author,
      commands: {},
      baseline: await captureBaseline(repo, {}),
      channels,
      adapters: [primary, retry],
      cfg,
      via: gateVia(driver),
      pipeline: "v185",
      onGate: (event) => { events.push(event); },
    });

    expect(driver.slots).toHaveLength(2);
    const acceptance = results.find((result) => result.gate === "acceptance");
    expect(acceptance).toMatchObject({ gate: "acceptance", pass: true });
    expect(acceptance!.meta?.judgeRetry).toEqual({
      flaked: "fake:fake-1",
      retried: "fake-b:fake-2",
    });
    expect(events.filter((event) => event.phase === "end" && event.gate === "acceptance")).toHaveLength(1);
  });
});
