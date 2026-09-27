import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelsFromConfig, type Invocation, type WorkerAdapter, type WorkerResult } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import { dispatchFixture, type ChannelResult } from "../../src/eval/dispatch.js";
import type { Fixture } from "../../src/eval/fixtures.js";
import { type Effort, type Task, validateGraph } from "../../src/graph/schema.js";
import { scopeIntent } from "../../src/plan/scope.js";

const PROBED_AT = "1970-01-01T00:00:00.000Z";

function tempFixture(acceptanceCommand: string): { fixture: Fixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-dispatch-"));
  const dir = join(root, "fx");
  mkdirSync(join(dir, "start"), { recursive: true });
  mkdirSync(join(dir, "solution"), { recursive: true });
  writeFileSync(join(dir, "start", "a.txt"), "start");
  writeFileSync(join(dir, "solution", "a.txt"), "expected");

  const spec = `<!-- tickmarkr:spec -->
# Fixture

## T1: fix a.txt
- goal: a.txt contains expected
- shape: implement
- acceptance:
  - command: ${acceptanceCommand}
`;
  writeFileSync(join(dir, "spec.md"), spec);

  return {
    fixture: { id: "fx", path: dir, startDir: join(dir, "start"), solutionDir: join(dir, "solution") },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function nonceFromPrompt(promptFile: string): string {
  try {
    return /TICKMARKR_RESULT_([0-9a-z]+)/.exec(readFileSync(promptFile, "utf8"))?.[1] ?? "";
  } catch {
    return "";
  }
}

class PromptProbeAdapter implements WorkerAdapter {
  id = "prompt-probe";
  vendor = "prompt-probe";
  invokes: Array<{ assignment: Assignment; promptFile: string; promptContent: string; cwd: string; hasGit: boolean; hasStartFile: boolean }> = [];

  async probe(): Promise<AuthHealth> {
    return {
      installed: true,
      authed: true,
      models: ["m1", "m2"],
      modelAuth: {
        m1: { authed: true, probedAt: PROBED_AT },
        m2: { authed: true, probedAt: PROBED_AT },
      },
    };
  }

  channels(): BillingChannel[] {
    return [
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m1", channel: "sub", tier: "frontier" },
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m2", channel: "api", tier: "frontier" },
    ];
  }

  headlessCommand(): string {
    return "true";
  }

  interactiveCommand(): string | null {
    return null;
  }

  invoke(task: Task, cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    const promptContent = readFileSync(ctx.promptFile, "utf8");
    this.invokes.push({
      assignment: a,
      promptFile: ctx.promptFile,
      promptContent,
      cwd,
      hasGit: existsSync(join(cwd, ".git", "HEAD")),
      hasStartFile: existsSync(join(cwd, "a.txt")),
    });
    const nonce = nonceFromPrompt(ctx.promptFile);
    return { command: `echo 'TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"ok","deviations":[]}'` };
  }

  parse(output: string, nonce: string): WorkerResult {
    return parseWorkerResult(output, nonce);
  }
}

describe("identical cross-channel dispatch", () => {
  test("every channel under test for a fixture receives byte-identical prompt content", async () => {
    const { fixture, cleanup } = tempFixture('[ "$(cat a.txt)" = "expected" ]');
    const adapter = new PromptProbeAdapter();
    const channels: BillingChannel[] = [
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m1", channel: "sub", tier: "frontier" },
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m2", channel: "api", tier: "frontier" },
    ];

    const results = await dispatchFixture({
      fixture,
      channels,
      adapters: [adapter],
      health: { "prompt-probe": await adapter.probe() },
      cfg: DEFAULT_CONFIG,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.skipped)).toBe(true);
    expect(adapter.invokes).toHaveLength(2);
    const [first, second] = adapter.invokes;
    expect(first.promptFile).toBe(second.promptFile);
    expect(first.promptContent).toBe(second.promptContent);
    expect(first.promptContent).toContain("TICKMARKR_RESULT_");
    expect(first.promptContent).toContain("fix a.txt");

    cleanup();
  });

  test("a channel's dispatch runs inside that fixture's own isolated seeded repository, never a shared or reused one", async () => {
    const { fixture, cleanup } = tempFixture('[ "$(cat a.txt)" = "expected" ]');
    const adapter = new PromptProbeAdapter();
    const channels: BillingChannel[] = [
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m1", channel: "sub", tier: "frontier" },
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m2", channel: "api", tier: "frontier" },
    ];

    await dispatchFixture({
      fixture,
      channels,
      adapters: [adapter],
      health: { "prompt-probe": await adapter.probe() },
      cfg: DEFAULT_CONFIG,
    });

    expect(adapter.invokes).toHaveLength(2);
    const [a, b] = adapter.invokes;
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.hasStartFile).toBe(true);
    expect(b.hasStartFile).toBe(true);
    expect(a.hasGit).toBe(true);
    expect(b.hasGit).toBe(true);

    cleanup();
  });

  test("a channel that fails to install or authenticate is skipped with a recorded reason rather than dispatched", async () => {
    const { fixture, cleanup } = tempFixture('[ "$(cat a.txt)" = "expected" ]');
    const adapter = new PromptProbeAdapter();
    const channels: BillingChannel[] = [
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m1", channel: "sub", tier: "frontier" },
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m2", channel: "api", tier: "frontier" },
    ];

    const health: Record<string, AuthHealth> = {
      "prompt-probe": {
        installed: true,
        authed: true,
        models: ["m1", "m2"],
        modelAuth: {
          m1: { authed: true, probedAt: PROBED_AT },
          m2: { authed: false, reason: "probe refused", probedAt: PROBED_AT },
        },
      },
    };

    const results = await dispatchFixture({ fixture, channels, adapters: [adapter], health, cfg: DEFAULT_CONFIG });

    expect(results).toHaveLength(2);
    const dispatched = results.find((r) => r.channel.model === "m1")!;
    const skipped = results.find((r) => r.channel.model === "m2")!;
    expect(dispatched.skipped).toBe(false);
    expect(skipped.skipped).toBe(true);
    expect(skipped.skipReason).toContain("m2");
    expect(skipped.skipReason).toContain("probe refused");
    expect(adapter.invokes).toHaveLength(1);
    expect(adapter.invokes[0].assignment.model).toBe("m1");

    cleanup();
  });

  test("the fixture's own acceptance check runs against each channel's resulting diff independently of every other channel's result", async () => {
    const { fixture, cleanup } = tempFixture('[ "$(cat a.txt)" = "expected" ]');
    const channels: BillingChannel[] = [
      { adapter: "splitter", vendor: "splitter", model: "good", channel: "sub", tier: "frontier" },
      { adapter: "splitter", vendor: "splitter", model: "bad", channel: "api", tier: "frontier" },
    ];

    const splitter: WorkerAdapter = {
      id: "splitter",
      vendor: "splitter",
      async probe() {
        return {
          installed: true,
          authed: true,
          models: ["good", "bad"],
          modelAuth: {
            good: { authed: true, probedAt: PROBED_AT },
            bad: { authed: true, probedAt: PROBED_AT },
          },
        };
      },
      channels: () => channels,
      headlessCommand: () => "true",
      interactiveCommand: () => null,
      invoke: (_task, cwd, a, ctx) => {
        const nonce = nonceFromPrompt(ctx.promptFile);
        const value = a.model === "good" ? "expected" : "wrong";
        return { command: `printf '${value}' > a.txt && echo 'TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"done","deviations":[]}'` };
      },
      parse: (output, nonce) => parseWorkerResult(output, nonce),
    };

    const results = await dispatchFixture({
      fixture,
      channels,
      adapters: [splitter],
      health: { splitter: await splitter.probe() },
      cfg: DEFAULT_CONFIG,
    });

    expect(results).toHaveLength(2);
    const good = results.find((r) => r.channel.model === "good") as ChannelResult & { acceptance: NonNullable<ChannelResult["acceptance"]> };
    const bad = results.find((r) => r.channel.model === "bad") as ChannelResult & { acceptance: NonNullable<ChannelResult["acceptance"]> };
    expect(good.acceptance.pass).toBe(true);
    expect(bad.acceptance.pass).toBe(false);
    expect(bad.acceptance.details).toContain("oracle failed");

    cleanup();
  });

  test("the dispatch path reuses the existing adapter invoke and parse contract rather than a parallel worker-invocation mechanism", async () => {
    const { fixture, cleanup } = tempFixture('[ "$(cat a.txt)" = "expected" ]');
    const adapter = new PromptProbeAdapter();
    const channels: BillingChannel[] = [
      { adapter: "prompt-probe", vendor: "prompt-probe", model: "m1", channel: "sub", tier: "frontier" },
    ];

    const results = await dispatchFixture({
      fixture,
      channels,
      adapters: [adapter],
      health: { "prompt-probe": await adapter.probe() },
      cfg: DEFAULT_CONFIG,
    });

    expect(adapter.invokes).toHaveLength(1);
    expect(results[0]?.worker?.ok).toBe(true);
    cleanup();
  });
});

// OBS-1182: every caller outside the daemon hands the adapter the routed seat's effort too.
class ScopeEffortFake extends FakeAdapter {
  readonly efforts: Array<Effort | undefined> = [];
  override channels(cfg: TickmarkrConfig): BillingChannel[] {
    return channelsFromConfig("fake", cfg);
  }
  override headlessCommand(promptFile: string, model: string, effort?: Effort): string {
    this.efforts.push(effort);
    return super.headlessCommand(promptFile, model);
  }
}

const SCOPE_DRAFT = `<!-- tickmarkr:spec -->
# Export reports

## Requirements
- REQ-01: Export reports as JSON

## Assumptions
- Existing authorization rules apply

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | T1 |

## T1: Export reports [REQ-01]
- goal: Export reports as JSON
- shape: implement
- files: src/reports.ts
- acceptance:
  - command: npm test
`;

async function scopeEfforts(model: "fake-1" | "fake-2", bound: boolean): Promise<Array<Effort | undefined>> {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-scope-effort-"));
  const intentFile = join(repo, "reports.intent.md");
  writeFileSync(intentFile, "# Export reports\n\n## Blocking questions\n1. Which format?\n\n## Answers\n1. JSON\n");
  const scriptFile = join(repo, "fake.json");
  writeFileSync(scriptFile, JSON.stringify({ tasks: {}, judge: { spec: SCOPE_DRAFT } }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers.fake = {
    vendor: "fake-a", channel: "sub",
    models: { "fake-1": "frontier", "fake-2": "frontier" },
    modelOverrides: { "fake-1": { effort: "high" } },
  };
  cfg.routing.map.spec = { pin: { via: "fake", model } };
  const fake = new ScopeEffortFake(scriptFile);
  try {
    await scopeIntent(intentFile, repo, { cfg, adapters: [fake], ...(bound ? { candidate: { adapter: "fake", model } } : {}) });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  return fake.efforts;
}

describe("OBS-1182 non-daemon effort", () => {
  test("direct adapter invoke eval dispatch and planning preserve configured effort versus omitted defaults, so one non-daemon caller losing high effort fails", async () => {
    // direct adapter invoke: the real CLIs' argv carries the level, and omission renders nothing
    const task = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] }],
    }).tasks[0]!;
    const seat = (adapter: string, model: string, effort?: Effort): Assignment =>
      ({ adapter, model, channel: "sub", tier: "frontier", ...(effort ? { effort } : {}) });
    const ctx = { promptFile: "/tmp/prompt.md" };
    expect(claudeCode.invoke(task, "/w", seat("claude-code", "opus", "high"), ctx).command).toContain(" --effort 'high' ");
    expect(claudeCode.invoke(task, "/w", seat("claude-code", "opus"), ctx).command).not.toContain("--effort");
    expect(codex.invoke(task, "/w", seat("codex", "gpt-5.6-sol", "high"), ctx).command).toContain(" -c 'model_reasoning_effort=high' ");
    expect(codex.invoke(task, "/w", seat("codex", "gpt-5.6-sol"), ctx).command).not.toContain("model_reasoning_effort");

    // eval dispatch: each channel is invoked at its own effort, an unset channel with no effort key
    const { fixture, cleanup } = tempFixture('[ "$(cat a.txt)" = "start" ]');
    const adapter = new PromptProbeAdapter();
    try {
      await dispatchFixture({
        fixture,
        channels: [
          { adapter: "prompt-probe", vendor: "prompt-probe", model: "m1", channel: "sub", tier: "frontier", effort: "high" },
          { adapter: "prompt-probe", vendor: "prompt-probe", model: "m2", channel: "api", tier: "frontier" },
        ],
        adapters: [adapter],
        health: { "prompt-probe": await adapter.probe() },
        cfg: DEFAULT_CONFIG,
      });
    } finally {
      cleanup();
    }
    expect(adapter.invokes.map((i) => i.assignment.model)).toEqual(["m1", "m2"]);
    expect(adapter.invokes[0]!.assignment.effort).toBe("high");
    expect("effort" in adapter.invokes[1]!.assignment).toBe(false);

    // planning: a routed and an operator-bound scope seat both draft at the seat's effort
    for (const bound of [false, true]) {
      expect(await scopeEfforts("fake-1", bound), `bound=${bound}`).toEqual(["high"]);
      expect(await scopeEfforts("fake-2", bound), `bound=${bound}`).toEqual([undefined]);
    }
  }, 60_000);
});
