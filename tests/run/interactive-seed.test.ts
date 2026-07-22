import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { InteractiveSeed } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const SEED: InteractiveSeed = {
  launch: (model: string) => `launch-tui --model ${model}`,
  readinessMatch: "TUI ready",
  seedLine: (promptFile: string) => `read ${promptFile}`,
};

class SeedFakeAdapter extends FakeAdapter {
  interactiveCommand(): string | null {
    return null;
  }
  interactiveSeed = SEED;
}

interface SeedDriver {
  driver: ExecutorDriver;
  runs: string[];
  waits: { pattern: string; regex?: boolean }[];
  buf: string;
}

function makeSeedDriver(promptFile: string, opts: { ready?: boolean; stick?: boolean } = {}): SeedDriver {
  const runs: string[] = [];
  const waits: { pattern: string; regex?: boolean }[] = [];
  let buf = "";
  const launchCmd = SEED.launch("fake-1");
  const seedCmd = SEED.seedLine(promptFile);

  const driver: ExecutorDriver = {
    id: "seed-spy",
    interactive: true,
    slot: async (cwd: string, name: string) => ({ id: "p1", name, cwd } as Slot),
    run: async (s: Slot, cmd: string) => {
      runs.push(cmd);
      if (cmd === launchCmd) {
        buf += "banner\nTUI ready\n> ";
      } else if (cmd === seedCmd) {
        buf += `\n${cmd}\n`;
        if (!opts.stick) {
          // Simulate the TUI doing the work and emitting a real trailer.
          execSync(`echo done > done.txt && ${COMMIT} done`, { cwd: s.cwd });
          const promptText = readFileSync(promptFile, "utf8");
          const nonce = /TICKMARKR_RESULT_([0-9a-z]+)/.exec(promptText)?.[1] ?? "";
          if (nonce) {
            buf += `TICKMARKR_RESULT_${nonce} {"ok":true,"summary":"seeded","deviations":[]}\n`;
          }
        }
      } else {
        // Execute gate/consult scripts the same way the real subprocess driver would.
        const m = /^bash '(.+)'$/.exec(cmd);
        if (m) {
          try {
            const out = execSync(`bash -lc ${JSON.stringify(m[1])}`, { cwd: s.cwd, encoding: "utf8" });
            buf += out;
          } catch {
            /* gate failures are reflected in the empty buffer */
          }
        }
      }
    },
    waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) => {
      waits.push({ pattern, regex: o?.regex });
      if (pattern === SEED.readinessMatch && opts.ready === false) return false;
      return o?.regex ? new RegExp(pattern).test(buf) : buf.includes(pattern);
    },
    waitAgentStatus: async () => true,
    read: async (_s: Slot, lines: number) => buf.split("\n").slice(-lines).join("\n"),
    status: async () => "unknown",
    notify: async () => {},
    close: async () => {},
    worktree: async (repo: string, branch: string, baseRef: string) => new SubprocessDriver().worktree(repo, branch, baseRef),
  };

  return { driver, runs, waits, buf };
}

describe("daemon interactive seed path (fake adapter, zero tokens)", () => {
  test("an adapter declaring the seed capability launches through a launch-then-seed sequence instead of the existing single-command interactive path", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "ok" } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.2\n",
    );
    const promptFile = `${repo}/.tickmarkr/runs/run-seed/prompts/T1-a0.md`;
    const { driver, runs, waits } = makeSeedDriver(promptFile);

    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-seed", driver });
    expect(s.done).toEqual(["T1"]);
    expect(runs[0]).toBe(SEED.launch("fake-1"));
    expect(runs[1]).toBe(SEED.seedLine(promptFile));
    expect(runs.some((r) => r.startsWith("bash "))).toBe(false);
    expect(waits[0]?.pattern).toBe(SEED.readinessMatch);
  }, 30_000);

  test("the seed line is only injected after the launch output matches the adapter's declared readiness pattern", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "ok" } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
    );
    const promptFile = `${repo}/.tickmarkr/runs/run-ready/prompts/T1-a0.md`;
    const { driver, runs, waits } = makeSeedDriver(promptFile, { ready: false });

    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-ready", driver });
    expect(s.done).toEqual([]);
    expect(s.human).toEqual(["T1"]);
    expect(runs).toEqual([SEED.launch("fake-1")]);
    expect(runs).not.toContain(SEED.seedLine(promptFile));
    expect(waits.some((w) => w.pattern === SEED.readinessMatch)).toBe(true);
    const wr = Journal.open(repo, "run-ready").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(false);
  }, 30_000);

  test("after injecting the seed line the daemon reads the pane back and treats a submission that never left the input box as a failure rather than a false start", async () => {
    const { repo, scriptPath } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "seeded" } }] }, consult: { action: "human", notes: "ok" } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
    );
    const promptFile = `${repo}/.tickmarkr/runs/run-stuck/prompts/T1-a0.md`;
    const { driver, runs } = makeSeedDriver(promptFile, { stick: true });

    const s = await runDaemon(repo, { adapters: [new SeedFakeAdapter(scriptPath)], runId: "run-stuck", driver });
    expect(s.done).toEqual([]);
    expect(s.human).toEqual(["T1"]);
    expect(runs).toContain(SEED.launch("fake-1"));
    expect(runs).toContain(SEED.seedLine(promptFile));
    const wr = Journal.open(repo, "run-stuck").read().find((e) => e.event === "worker-result");
    expect(wr?.data.finished).toBe(false);
    expect(wr?.data.summary).not.toBe("seeded");
  }, 30_000);

  test("an adapter without the seed capability dispatches exactly as it does today, unchanged", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "unchanged" } }] } },
      "visibility:\n  worker: interactive\ntaskTimeoutMinutes: 0.02\n",
    );
    const runs: string[] = [];
    const inner = {
      id: "unchanged-spy",
      interactive: true,
      slot: async (cwd: string, name: string) => ({ id: "p1", name, cwd } as Slot),
      run: async (_s: Slot, cmd: string) => { runs.push(cmd); },
      waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) => {
        if (pattern.includes("TICKMARKR_EXIT")) return true;
        return o?.regex ? new RegExp(pattern).test("") : false;
      },
      waitAgentStatus: async () => true,
      read: async () => "",
      status: async () => "unknown",
      notify: async () => {},
      close: async () => {},
      worktree: async (repo: string, branch: string, baseRef: string) => new SubprocessDriver().worktree(repo, branch, baseRef),
    } as ExecutorDriver;

    await runDaemon(repo, { adapters: [fake], runId: "run-unchanged", driver: inner });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^bash '/);
    expect(runs[0]).not.toContain(SEED.launch("fake-1"));
    expect(runs[0]).not.toContain(SEED.seedLine(`${repo}/.tickmarkr/runs/run-unchanged/prompts/T1-a0.md`));
  }, 30_000);
});
