import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CURSOR_TRUST_DIALOG } from "../../src/adapters/cursor-agent.js";
import { matchesTrustDialog } from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

// v1.22 T5 / OBS-19: fingerprint-matched trust dialog gets one Enter; anything else pages.

describe("matchesTrustDialog helper", () => {
  test("cursor fingerprint matches Workspace Trust Required pane text", () => {
    expect(matchesTrustDialog("… Workspace Trust Required\n[a] Always", CURSOR_TRUST_DIALOG)).toBe(true);
    expect(matchesTrustDialog("Approve shell command?", CURSOR_TRUST_DIALOG)).toBe(false);
  });
});

describe("trust-dialog auto-answer (daemon, once per slot)", () => {
  test("scripted blocked pane matching the cursor trust fingerprint gets one Enter and unblocks", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: {
          T1: [{ shell: "true", result: { ok: true, summary: "done after trust" } }],
        },
        // after auto-answer the trailer is enough for worker-result; gates may still fail evidence —
        // consult parks human so the run ends cleanly without burning retries.
        consult: { action: "human", notes: "ok" },
      },
      "taskTimeoutMinutes: 0.2\n",
    );
    (fake as { trustDialog?: typeof CURSOR_TRUST_DIALOG }).trustDialog = CURSOR_TRUST_DIALOG;

    let phase: "dialog" | "working" = "dialog";
    let nonce = "";
    const keys: string[] = [];
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
        // true only after trust is accepted → daemon harvests the trailer from read()
        return phase === "working";
      },
      waitAgentStatus: async () => true,
      read: async () => {
        if (phase === "dialog") return "Workspace Trust Required\nTrust this folder?";
        return `working\nTICKMARKR_RESULT_${nonce} {"ok":true,"summary":"done after trust","deviations":[]}\n`;
      },
      status: async () => (phase === "dialog" ? "blocked" : "working"),
      sendKey: async (_s, key) => {
        keys.push(key);
        phase = "working";
      },
      notify: async (msg) => { notified.push(msg); },
      close: async () => {},
      worktree: inner.worktree.bind(inner),
    };

    await runDaemon(repo, { adapters: [fake], runId: "run-trust-match", driver });
    expect(keys).toEqual(["Enter"]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);
  }, 30_000);

  test("non-matching blocked dialog is never auto-answered and pages the operator", async () => {
    const { repo, fake } = setupRepo(
      [T("T1")],
      {
        tasks: { T1: [{ shell: "sleep 30" }] },
        consult: { action: "human", notes: "operator must unblock" },
      },
      "taskTimeoutMinutes: 0.05\n",
    );
    (fake as { trustDialog?: typeof CURSOR_TRUST_DIALOG }).trustDialog = CURSOR_TRUST_DIALOG;

    const keys: string[] = [];
    const notified: string[] = [];
    const inner = new SubprocessDriver();
    const driver: ExecutorDriver = {
      id: "trust-scripted",
      interactive: true,
      slot: async (cwd, name) => ({ id: "p1", name, cwd }),
      run: async () => {},
      waitOutput: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return false;
      },
      waitAgentStatus: async () => true,
      read: async () => "Approve running: rm -rf / ?\n[y/N]",
      status: async () => "blocked",
      sendKey: async (_s, key) => { keys.push(key); },
      notify: async (msg) => { notified.push(msg); },
      close: async () => {},
      worktree: inner.worktree.bind(inner),
    };

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-trust-nomatch", driver });
    expect(keys).toEqual([]);
    expect(notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
    expect(s.human).toEqual(["T1"]);
  }, 30_000);
});
