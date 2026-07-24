import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { cursorAgent, CURSOR_TRUST_DIALOG } from "../../src/adapters/cursor-agent.js";
import { matchesTrustDialog, type TrustDialog } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

// v1.22 T5 / OBS-19: fingerprint-matched trust dialog gets one Enter; anything else pages.

const CLAUDE_TRUST_PANE = [
  "Accessing workspace:",
  "/tmp/untrusted-project",
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).",
  "Yes, I trust this folder",
].join("\n");

const CODEX_TRUST_PANE = [
  "Do you trust the contents of this directory?",
  "Working with untrusted contents comes with higher risk of prompt injection.",
  "Trusting the directory allows project-local config, hooks, and exec policies to load.",
  "› 1. Yes, continue",
  "Press enter to continue",
].join("\n");

const CURSOR_TRUST_PANE = "Workspace Trust Required\nTrust this folder?";

async function runTrustPane(
  paneText: string,
  trustDialog: TrustDialog | undefined,
  opts: { unblockOnKey: boolean },
): Promise<{ keys: string[]; keyedSlots: string[]; notified: string[]; human: string[] }> {
  const { repo, fake } = setupRepo(
    [T("T1")],
    {
      tasks: {
        T1: [{ shell: opts.unblockOnKey ? "true" : "sleep 30", result: { ok: true, summary: "done after trust" } }],
      },
      // after auto-answer the trailer is enough for worker-result; gates may still fail evidence —
      // consult parks human so the run ends cleanly without burning retries.
      consult: { action: "human", notes: "operator must unblock" },
    },
    `taskTimeoutMinutes: ${opts.unblockOnKey ? 0.2 : 0.05}\n`,
  );
  if (trustDialog) (fake as { trustDialog?: TrustDialog }).trustDialog = trustDialog;

  let phase: "dialog" | "working" = "dialog";
  let nonce = "";
  const keys: string[] = [];
  const keyedSlots: string[] = [];
  const notified: string[] = [];
  const inner = new SubprocessDriver();

  const driver: ExecutorDriver = {
    id: "trust-scripted",
    interactive: true,
    slot: async (cwd, name) => ({ id: "p1", name, cwd }),
    run: async (_s, cmd) => {
      // v1.62 T1: the delivered line is a nonce-free script invocation — the trailer lives in the script
      const p = /^bash '(.+)'$/.exec(cmd)?.[1];
      const m = p ? /TICKMARKR_RESULT_([0-9a-z]+)/i.exec(readFileSync(p, "utf8")) : null;
      if (m) nonce = m[1];
    },
    waitOutput: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return phase === "working";
    },
    waitAgentStatus: async () => true,
    read: async () => {
      if (phase === "dialog") return paneText;
      return `working\nTICKMARKR_RESULT_${nonce} {"ok":true,"summary":"done after trust","deviations":[]}\n`;
    },
    status: async () => (phase === "dialog" ? "blocked" : "working"),
    sendKey: async (s, key) => {
      keys.push(key);
      keyedSlots.push(s.name);
      if (opts.unblockOnKey) phase = "working";
    },
    notify: async (msg) => { notified.push(msg); },
    close: async () => {},
    worktree: inner.worktree.bind(inner),
  };

  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-trust-pane", driver });
  return { keys, keyedSlots, notified, human: summary.human };
}

describe("trust-dialog declarations", () => {
  test("a pane showing the claude workspace-trust dialog matches its adapter's declared fingerprint and is answered with its declared key", async () => {
    const dialog = claudeCode.trustDialog;
    expect(dialog).toBeDefined();
    if (!dialog) return;
    expect(matchesTrustDialog(CLAUDE_TRUST_PANE, dialog)).toBe(true);

    const { keys, notified } = await runTrustPane(CLAUDE_TRUST_PANE, dialog, { unblockOnKey: true });
    expect(keys).toEqual([dialog.key]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);
  }, 30_000);

  test("a pane showing the codex trust dialog matches its adapter's declared fingerprint and is answered with its declared key", async () => {
    const dialog = codex.trustDialog;
    expect(dialog).toBeDefined();
    if (!dialog) return;
    expect(matchesTrustDialog(CODEX_TRUST_PANE, dialog)).toBe(true);

    const { keys, notified } = await runTrustPane(CODEX_TRUST_PANE, dialog, { unblockOnKey: true });
    expect(keys).toEqual([dialog.key]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);
  }, 30_000);

  test("a blocked pane matching no declared fingerprint is never auto-answered and still surfaces through the existing operator-paging path", async () => {
    const { keys, notified, human } = await runTrustPane(
      "Approve running: rm -rf / ?\n[y/N]",
      CURSOR_TRUST_DIALOG,
      { unblockOnKey: false },
    );
    expect(keys).toEqual([]);
    expect(notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
    expect(human).toEqual(["T1"]);
  }, 30_000);

  test("the existing cursor declaration and the once-per-slot answer semantics are unchanged", async () => {
    expect(cursorAgent.trustDialog).toBe(CURSOR_TRUST_DIALOG);
    expect(CURSOR_TRUST_DIALOG).toEqual({ fingerprint: "Workspace Trust Required", key: "Enter" });

    // Keep showing the same matched dialog after Enter. The daemon may page when it remains
    // blocked, but the per-slot latch must prevent a second automatic keypress.
    const { keys, keyedSlots } = await runTrustPane(CURSOR_TRUST_PANE, CURSOR_TRUST_DIALOG, { unblockOnKey: false });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key === "Enter")).toBe(true);
    expect(new Set(keyedSlots).size).toBe(keyedSlots.length);
  }, 30_000);

  test("each declared fingerprint is specific enough to match only its own trust dialog and never routine agent output", () => {
    const declared = [
      { name: "claude", dialog: claudeCode.trustDialog, pane: CLAUDE_TRUST_PANE },
      { name: "codex", dialog: codex.trustDialog, pane: CODEX_TRUST_PANE },
      { name: "cursor", dialog: cursorAgent.trustDialog, pane: CURSOR_TRUST_PANE },
    ];
    const routineOutput = [
      "I reviewed workspace trust handling and the tests pass.",
      "Do you trust this implementation? The agent is still working.",
      'TICKMARKR_RESULT_nonce {"ok":true,"summary":"trust dialog support","deviations":[]}',
    ];

    for (const entry of declared) {
      expect(entry.dialog, `${entry.name} declaration`).toBeDefined();
      if (!entry.dialog) continue;
      expect(matchesTrustDialog(entry.pane, entry.dialog), `${entry.name} own dialog`).toBe(true);
      for (const other of declared.filter((candidate) => candidate !== entry)) {
        expect(matchesTrustDialog(other.pane, entry.dialog), `${entry.name} must not match ${other.name}`).toBe(false);
      }
      for (const output of routineOutput) {
        expect(matchesTrustDialog(output, entry.dialog), `${entry.name} routine output`).toBe(false);
      }
    }
  });

  test("auto-answer remains declaration-gated so no dialog outside the declared set is ever answered", async () => {
    // This is byte-for-byte a real declared Claude pane, but the dispatched adapter declares
    // nothing. Runtime must consult only that adapter, never a process-global fingerprint set.
    const { keys, notified, human } = await runTrustPane(CLAUDE_TRUST_PANE, undefined, { unblockOnKey: false });
    expect(keys).toEqual([]);
    expect(notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
    expect(human).toEqual(["T1"]);
  }, 30_000);
});
