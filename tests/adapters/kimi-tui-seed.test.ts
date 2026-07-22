import { describe, expect, test } from "vitest";
import {
  confirmKimiSeedBanner,
  kimi,
  kimiBannerModel,
  kimiBannerSessionId,
  runKimiInteractiveSeed,
} from "../../src/adapters/kimi.js";
import type { Assignment } from "../../src/adapters/types.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";

const ASSIGNMENT: Assignment = { adapter: "kimi", model: "kimi-code/k3", channel: "sub", tier: "frontier" };

function makeKimiSeedDriver(banner: string, opts: { submit?: boolean } = {}) {
  let buf = banner;
  if (!buf.includes("Send /help for help information.")) {
    buf += "\nSend /help for help information.\n> ";
  }
  const runs: string[] = [];
  const seedText = `Read /tmp/prompt.md and do exactly what it says.`;
  const slot: Slot = { id: "p1", name: "kimi-worker", cwd: "/tmp" };

  const driver: ExecutorDriver = {
    id: "kimi-seed-stub",
    interactive: true,
    slot: async () => slot,
    run: async (_s: Slot, cmd: string) => {
      runs.push(cmd);
      if (cmd.includes("kimi -y -m")) {
        // launch: the TUI banner is already in the pane buffer
      } else if (cmd === seedText) {
        buf += `\n${cmd}\n`;
        if (opts.submit !== false) buf += "[submitted]\n";
      } else {
        throw new Error(`unexpected command: ${cmd}`);
      }
    },
    waitOutput: async (_s: Slot, pattern: string, _ms: number, o?: { regex?: boolean }) =>
      o?.regex ? new RegExp(pattern).test(buf) : buf.includes(pattern),
    waitAgentStatus: async () => true,
    status: async () => "unknown",
    read: async (_s: Slot, lines: number) => buf.split("\n").slice(-lines).join("\n"),
    notify: async () => {},
    close: async () => {},
    worktree: async (repo: string) => repo,
  };

  return { driver, slot, runs, seedText };
}

describe("kimi TUI seed banner checks", () => {
  test("the launch banner's named model line is checked against the assigned channel before the seed line is injected, failing closed on a mismatch rather than seeding blind", async () => {
    const banner = "Model: kimi-for-coding\nSession: session_11111111-aaaa-bbbb-cccc-111111111111\n";
    const { driver, slot, runs } = makeKimiSeedDriver(banner);
    const r = await runKimiInteractiveSeed({
      driver,
      slot,
      assignment: ASSIGNMENT,
      promptFile: "/tmp/prompt.md",
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(true);
    expect(r.seedError).toMatch(/model mismatch/);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("kimi -y -m");
    expect(r.output).toContain("Model: kimi-for-coding");
    // Pure confirm on the same banner text — no probe of its own.
    expect(confirmKimiSeedBanner(banner, ASSIGNMENT.model).ok).toBe(false);
    expect(kimiBannerModel(banner)).toBe("kimi-code/kimi-for-coding");
  });

  test("a session identifier is captured from the launch banner itself rather than waiting for the attempt's own completion text", async () => {
    const sessionId = "session_25e8efca-cc09-4dd6-9dee-1951aec28581";
    const banner = `Model: k3\nSession: ${sessionId}\n`;
    const { driver, slot, runs, seedText } = makeKimiSeedDriver(banner);
    const r = await runKimiInteractiveSeed({
      driver,
      slot,
      assignment: ASSIGNMENT,
      promptFile: "/tmp/prompt.md",
      taskTimeoutMinutes: 0.1,
    });
    expect(r.seedFailed).toBe(false);
    expect(r.sessionId).toBe(sessionId);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toBe(seedText);
    // Captured from the banner alone — no completion-time resume trailer present.
    expect(r.output).not.toMatch(/To resume this session/);
    expect(kimiBannerSessionId(banner)).toBe(sessionId);
    expect(kimi.sessionIdFrom!(banner)).toBe(sessionId);
    expect(confirmKimiSeedBanner(banner, ASSIGNMENT.model)).toEqual({ ok: true, sessionId });
  });
});
