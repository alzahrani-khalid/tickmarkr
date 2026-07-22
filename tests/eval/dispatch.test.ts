import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import type { Assignment, AuthHealth, BillingChannel, Invocation, WorkerAdapter, WorkerResult } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { dispatchFixture, type ChannelResult } from "../../src/eval/dispatch.js";
import type { Fixture } from "../../src/eval/fixtures.js";
import type { Task } from "../../src/graph/schema.js";

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
