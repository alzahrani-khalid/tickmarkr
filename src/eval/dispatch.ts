import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, AuthHealth, BillingChannel, WorkerAdapter, WorkerResult } from "../adapters/types.js";
import { channelKey, modelAuthed } from "../adapters/types.js";
import { buildTaskPrompt } from "../adapters/prompt.js";
import { compileSource } from "../compile/index.js";
import type { TickmarkrConfig } from "../config/config.js";
import { detectGateCommands } from "../gates/baseline.js";
import { testFiltered } from "../gates/acceptance.js";
import { renderAcceptanceItem, type AcceptanceItem, type Task } from "../graph/schema.js";
import { sh } from "../run/git.js";
import { seedFixture, type Fixture, type SeededFixture } from "./fixtures.js";

export interface AcceptanceRunResult {
  pass: boolean;
  details: string;
}

export interface ChannelResult {
  channel: BillingChannel;
  channelKey: string;
  skipped: boolean;
  skipReason?: string;
  repo?: string;
  worker?: WorkerResult;
  acceptance?: AcceptanceRunResult;
}

export interface DispatchOptions {
  fixture: Fixture;
  channels: BillingChannel[];
  adapters: WorkerAdapter[];
  health: Record<string, AuthHealth>;
  cfg: TickmarkrConfig;
}

function isDeterministic(item: AcceptanceItem): item is
  | { oracle: "command"; command: string }
  | { oracle: "test"; test: string } {
  return typeof item === "object" && (item.oracle === "command" || item.oracle === "test");
}

// Mirrors the vitest/jest summary parser in src/gates/acceptance.ts so the selfcheck uses the same
// fail-closed rule for named-test oracles: exit 0 is vacuous if the name filter matched zero tests.
function testsRan(output: string): number | null {
  const lines = output.replace(/\x1b\[[\d;#]*[A-Za-z]/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    const m = line.match(/^Tests\s+(.+?)\s*\(\d+\)\s*$/);
    if (!m) continue;
    let ran = 0;
    for (const chunk of m[1].split("|").map((s) => s.trim())) {
      const n = chunk.match(/^(\d+)\s+(passed|failed)\b/);
      if (n) ran += Number(n[1]);
    }
    return ran;
  }
  return null;
}

function tail(out: string, n = 8): string {
  const t = out.trim();
  if (!t) return "";
  return "\n" + t.split("\n").slice(-n).join("\n");
}

async function runDeterministicAcceptance(task: Task, cwd: string, cfg: TickmarkrConfig): Promise<AcceptanceRunResult> {
  const testCmd = detectGateCommands(cwd, cfg).test;
  const passed: string[] = [];

  for (const item of task.acceptance) {
    if (!isDeterministic(item)) continue;

    if (item.oracle === "command") {
      const r = await sh(item.command, cwd);
      if (r.code !== 0) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} (exit ${r.code})${tail(r.stderr || r.stdout)}`,
        };
      }
      passed.push(`✓ ${renderAcceptanceItem(item)} (exit 0)`);
    } else {
      if (!testCmd) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} — no test command detected (failing closed)`,
        };
      }
      const r = await sh(testFiltered(testCmd, item.test), cwd);
      const out = (r.stderr || "") + "\n" + (r.stdout || "");
      if (r.code !== 0) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} (exit ${r.code})${tail(r.stderr || r.stdout)}`,
        };
      }
      const ran = testsRan(out);
      if (ran === null || ran < 1) {
        return {
          pass: false,
          details: `oracle failed: ${renderAcceptanceItem(item)} — name filter matched zero tests (filter: ${item.test})${tail(out)}`,
        };
      }
      passed.push(`✓ ${renderAcceptanceItem(item)} (exit 0)`);
    }
  }

  return {
    pass: true,
    details: passed.length ? passed.join("\n") : "no deterministic acceptance oracles",
  };
}

function findSpec(fixtureDir: string): string | undefined {
  const direct = join(fixtureDir, "spec.md");
  if (existsSync(direct)) return direct;
  for (const ent of readdirSyncSafe(fixtureDir)) {
    if (!ent.isFile()) continue;
    const { name } = ent;
    if (
      name.endsWith(".native.md") ||
      name.endsWith(".prd.md") ||
      name.endsWith(".spec.md") ||
      name === "tasks.md"
    ) {
      return join(fixtureDir, name);
    }
  }
  return undefined;
}

function readdirSyncSafe(dir: string): { name: string; isFile(): boolean; isDirectory(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compileFixtureTask(fixture: Fixture): { task: Task; error?: string } {
  const specPath = findSpec(fixture.path);
  if (!specPath) return { task: undefined as unknown as Task, error: "fixture has no spec" };

  try {
    const graph = compileSource(specPath);
    if (graph.tasks.length !== 1) {
      return {
        task: undefined as unknown as Task,
        error: `fixture spec must contain exactly one task (found ${graph.tasks.length})`,
      };
    }
    const task = graph.tasks[0]!;
    const runnable = task.acceptance.some(isDeterministic);
    if (!runnable) {
      return { task: undefined as unknown as Task, error: "fixture has no deterministic acceptance oracle" };
    }
    return { task };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { task: undefined as unknown as Task, error: `fixture spec failed to compile: ${message}` };
  }
}

function skipReason(channel: BillingChannel, adapters: WorkerAdapter[], health: Record<string, AuthHealth>): string | undefined {
  const adapter = adapters.find((a) => a.id === channel.adapter);
  if (!adapter) return `unknown adapter ${channel.adapter}`;
  const h = health[channel.adapter];
  if (!h?.installed) return `adapter ${channel.adapter} is not installed`;
  if (!h?.authed) return `adapter ${channel.adapter} is not authenticated`;
  if (!modelAuthed(h, channel.model)) {
    const v = h.modelAuth?.[channel.model];
    if (v?.authed === false) return `${channel.adapter}:${channel.model} is not authenticated (${v.reason ?? "probe failed"})`;
    return `${channel.adapter}:${channel.model} has no auth verdict — run tickmarkr doctor`;
  }
  return undefined;
}

async function dispatchChannel(
  task: Task,
  channel: BillingChannel,
  adapter: WorkerAdapter,
  promptFile: string,
  nonce: string,
  fixture: Fixture,
  cfg: TickmarkrConfig,
): Promise<Omit<ChannelResult, "channel" | "channelKey" | "skipped" | "skipReason"> & { seeded: SeededFixture }> {
  const seeded = await seedFixture(fixture);
  const assignment: Assignment = {
    adapter: channel.adapter,
    model: channel.model,
    channel: channel.channel,
    tier: channel.tier,
  };

  const invocation = adapter.invoke(task, seeded.repo, assignment, { promptFile });
  const run = await sh(invocation.command, seeded.repo, cfg.taskTimeoutMinutes * 60_000);
  const output = `${run.stdout}\n${run.stderr}`.trim();
  const worker = adapter.parse(output, nonce);

  const acceptance = await runDeterministicAcceptance(task, seeded.repo, cfg);

  return { repo: seeded.repo, worker, acceptance, seeded };
}

/**
 * Render one prompt for a fixture and dispatch that identical, unmodified prompt to every channel
 * under test. Each channel runs inside its own isolated seeded repository, and the fixture's own
 * deterministic acceptance oracles are evaluated against each channel's resulting diff independently.
 * Channels that fail install or model authentication are skipped with a recorded reason rather than
 * dispatched. The dispatch path reuses the existing adapter `invoke` and `parse` contract.
 */
export async function dispatchFixture(opts: DispatchOptions): Promise<ChannelResult[]> {
  const { task, error } = compileFixtureTask(opts.fixture);
  if (error || !task) {
    throw new Error(error ?? "fixture task could not be compiled");
  }

  const nonce = randomBytes(8).toString("hex");
  const promptDir = mkdtempSync(join(tmpdir(), "tickmarkr-eval-prompt-"));
  const promptFile = join(promptDir, "prompt.md");
  writeFileSync(promptFile, buildTaskPrompt(task, "", nonce));

  const results: ChannelResult[] = [];

  try {
    for (const channel of opts.channels) {
      const key = channelKey(channel);
      const reason = skipReason(channel, opts.adapters, opts.health);
      if (reason) {
        results.push({ channel, channelKey: key, skipped: true, skipReason: reason });
        continue;
      }

      const adapter = opts.adapters.find((a) => a.id === channel.adapter)!;
      const { seeded, ...rest } = await dispatchChannel(task, channel, adapter, promptFile, nonce, opts.fixture, opts.cfg);
      try {
        results.push({ channel, channelKey: key, skipped: false, repo: rest.repo, worker: rest.worker, acceptance: rest.acceptance });
      } finally {
        await seeded.cleanup();
      }
    }
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }

  return results;
}
