import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { buildDossierPrompt, consult, augmentRetryBrief, renderRetryGuidance, type Dossier } from "../../src/run/consult.js";
import { extractPromptNonce, gateExitTrailer, gatePaneName } from "../../src/gates/llm.js";
import { bannerShell } from "../../src/brand.js";

const dossier: Dossier = {
  taskId: "T1",
  trigger: "gate-fail",
  journalTail: '[{"event":"gate-result"}]',
  transcript: "worker said things",
  diff: "scope: touched README.md",
  gates: [{ gate: "scope", pass: false, details: "undeclared out-of-scope edits" }],
};

function setup(consultVerdict: unknown): { cfg: TickmarkrConfig; fake: FakeAdapter; runDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-consult-"));
  const sp = join(dir, "s.json");
  writeFileSync(sp, JSON.stringify({ tasks: {}, consult: consultVerdict }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 15 };
  return { cfg, fake: new FakeAdapter(sp), runDir: mkdtempSync(join(tmpdir(), "tickmarkr-rundir-")) };
}

describe("consult", () => {
  test("dossier prompt carries trigger, gates, transcript and demands the verdict contract", () => {
    const p = buildDossierPrompt(dossier, "abc12345");
    expect(p.startsWith("TICKMARKR-CONSULT")).toBe(true);
    expect(p).toContain("VERDICT_NONCE: abc12345");
    expect(p).toContain('"nonce": "abc12345"');
    expect(p).toContain("gate-fail");
    expect(p).toContain("undeclared out-of-scope edits");
    expect(p).toContain('"action"');
    expect(p).toContain('"reason"');
    expect(p).toContain('"guidance"');
    // v1.24 T1 / OBS-20: prompt documents optional adapter-scoped exclusion on reroute
    expect(p).toContain("excludeAdapter");
    expect(p).toMatch(/environmental|CLI is blocked|trust dialog/i);
  });

  test("v1.39 OBS-37a: renderRetryGuidance uses structured fields, not raw notes prose", () => {
    const distinctive = "CONSULT VERDICT: herdr must never see this distinctive prose echoed in a worker prompt";
    const bullets = renderRetryGuidance({
      action: "retry",
      notes: distinctive,
      reason: "scope gate failed",
      guidance: "Commit real changes.\nTouch only declared paths.",
    });
    expect(bullets).toContain("- Action: retry");
    expect(bullets).toContain("- Reason: scope gate failed");
    expect(bullets).toContain("- Commit real changes.");
    expect(bullets).toContain("- Touch only declared paths.");
    expect(bullets).not.toContain(distinctive);
    expect(bullets).not.toContain("herdr must never");
  });

  test("v1.39 OBS-37a: legacy notes-only verdict still renders as bullets", () => {
    const bullets = renderRetryGuidance({ action: "retry", notes: "commit something real this time" });
    expect(bullets).toBe("- Action: retry\n- commit something real this time");
  });

  test("OBS-58: augmentRetryBrief names prior commits by hash and corrects false landed premises", () => {
    const hash = "abc1234deadbeef";
    const named = augmentRetryBrief("- The src implementation is already committed.", {
      attempted: [hash],
      carried: [],
      present: new Set(),
    });
    expect(named).toContain("## Prior attempt commits (by hash)");
    expect(named).toContain(hash);
    expect(named).toContain("could not be carried forward");
    expect(named).not.toMatch(/already committed/i);
  });

  test("OBS-58: augmentRetryBrief keeps landed premise when the commit is present", () => {
    const hash = "abc1234deadbeef";
    const named = augmentRetryBrief("- Implementation already committed — finish the trailer.", {
      attempted: [hash],
      carried: [hash],
      present: new Set([hash]),
    });
    expect(named).toContain(hash);
    expect(named).toContain("already committed");
    expect(named).toContain("present in this worktree");
  });

  test("v1.39: structured reason/guidance parsed from consult JSON", async () => {
    const { cfg, fake, runDir } = setup({
      action: "retry",
      reason: "evidence gate empty",
      guidance: "Write a real commit.",
      notes: "audit-only prose the worker must not see",
    });
    const v = await consult(dossier, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
    expect(v).toEqual({
      action: "retry",
      reason: "evidence gate empty",
      guidance: "Write a real commit.",
      notes: "audit-only prose the worker must not see",
    });
  });

  test("headless default: verdict via sh() with no driver interaction", async () => {
    const { cfg, fake, runDir } = setup({ action: "retry", notes: "headless path" });
    const throwing: ExecutorDriver = {
      id: "throw",
      interactive: false,
      slot: async () => { throw new Error("driver.slot should not be called"); },
      run: async () => { throw new Error("driver.run should not be called"); },
      waitOutput: async () => { throw new Error("driver.waitOutput should not be called"); },
      waitAgentStatus: async () => false,
      status: async () => "unknown",
      read: async () => { throw new Error("driver.read should not be called"); },
      notify: async () => {},
      close: async () => { throw new Error("driver.close should not be called"); },
      worktree: async () => "/tmp/wt",
    };
    const v = await consult(dossier, cfg, [fake], throwing, "/tmp", runDir);
    expect(v).toEqual({ action: "retry", notes: "headless path" });
  });

  test("returns structured verdict via driver; dossier saved as artifact", async () => {
    const { cfg, fake, runDir } = setup({ action: "reroute", notes: "cursor keeps ignoring scope" });
    cfg.visibility.llm = "pane";
    const v = await consult(dossier, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
    expect(v).toEqual({ action: "reroute", notes: "cursor keeps ignoring scope" });
    const files = readdirSync(join(runDir, "consults"));
    expect(files.some((f) => f.startsWith("T1-"))).toBe(true);
  });

  // T3 secret redaction: the dossier artifact is masked at the persist seam; the Dossier in memory is not.
  test("a consult dossier transcript carrying a secret assignment persists with the value masked", async () => {
    const { cfg, fake, runDir } = setup({ action: "retry", notes: "redaction path" });
    const leaky: Dossier = { ...dossier, transcript: 'worker ran: export DEPLOY_TOKEN="hunter2secretvalue99"' };
    const v = await consult(leaky, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
    expect(v).toEqual({ action: "retry", notes: "redaction path" });
    const md = readdirSync(join(runDir, "consults")).find((f) => f.endsWith(".md"))!;
    const persisted = readFileSync(join(runDir, "consults", md), "utf8");
    expect(persisted).not.toContain("hunter2secretvalue99");
    expect(persisted).toContain('DEPLOY_TOKEN="[REDACTED]"'); // key name survives, value does not
    expect(leaky.transcript).toContain("hunter2secretvalue99"); // in-memory original untouched
  });

  // v1.65 T2: the dossier's transcript is squashed by the LLM noise filter at prompt-build time,
  // so the persisted consults/ artifact (what the model reads) carries signal without spinner churn.
  test("consult dossier transcripts route through the filter before persistence", async () => {
    const { cfg, fake, runDir } = setup({ action: "retry", notes: "filter path" });
    const churn = Array.from({ length: 60 }, (_, i) => `⠋ Starting MCP servers (${i}s • esc to interrupt)`).join("\n");
    const noisy: Dossier = { ...dossier, transcript: `${churn}\nFAIL tests/x.test.ts > boom\nprocess exited with exit code 1` };
    const v = await consult(noisy, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
    expect(v).toEqual({ action: "retry", notes: "filter path" });
    const md = readdirSync(join(runDir, "consults")).find((f) => f.endsWith(".md"))!;
    const persisted = readFileSync(join(runDir, "consults", md), "utf8");
    expect(persisted.split("\n").filter((l) => l.includes("Starting MCP servers")).length).toBeLessThanOrEqual(1);
    expect(persisted).toContain("FAIL tests/x.test.ts > boom"); // failure signal survives into the artifact
    expect(persisted).toContain("process exited with exit code 1");
    expect(noisy.transcript.split("\n").filter((l) => l.includes("Starting MCP servers")).length).toBe(60); // in-memory untouched
  });

  test("v1.24: excludeAdapter on reroute is preserved when a non-empty string", async () => {
    const { cfg, fake, runDir } = setup({
      action: "reroute", notes: "trust dialog blocks the CLI", excludeAdapter: "cursor-agent",
    });
    const v = await consult(dossier, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
    expect(v).toEqual({
      action: "reroute",
      notes: "trust dialog blocks the CLI",
      excludeAdapter: "cursor-agent",
    });
  });

  test("v1.24: malformed excludeAdapter degrades to channel-level reroute (never crash, never human)", async () => {
    // number / array / empty string / object — drop the field, keep action=reroute
    for (const bad of [42, ["cursor-agent"], "", { id: "cursor-agent" }, null]) {
      const { cfg, fake, runDir } = setup({
        action: "reroute", notes: "try another channel", excludeAdapter: bad,
      });
      const v = await consult(dossier, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
      expect(v.action).toBe("reroute");
      expect(v.notes).toBe("try another channel");
      expect(v.excludeAdapter).toBeUndefined();
    }
  });

  test("unparseable / unknown action fails safe to human", async () => {
    const { cfg, fake, runDir } = setup("gibberish not a verdict");
    const v = await consult(dossier, cfg, [fake], new SubprocessDriver(), "/tmp", runDir);
    expect(v.action).toBe("human");
    const { cfg: c2, fake: f2, runDir: r2 } = setup({ action: "explode", notes: "" });
    expect((await consult(dossier, c2, [f2], new SubprocessDriver(), "/tmp", r2)).action).toBe("human");
  });

  test("OBS-50: visible consult pane dispatches a short bash script that includes the brand banner", async () => {
    const captured: string[] = [];
    const stubSlot: Slot = { id: "stub", name: gatePaneName("consult", "T1"), cwd: "/tmp" };
    const stub: ExecutorDriver = {
      id: "stub",
      interactive: false,
      slot: async () => stubSlot,
      run: async (_s, cmd) => { captured.push(cmd); },
      waitOutput: async () => true,
      waitAgentStatus: async () => false,
      status: async () => "unknown",
      read: async () => '{"action":"retry","notes":"pane path"}',
      notify: async () => {},
      close: async () => {},
      worktree: async () => "/tmp/wt",
    };
    const { cfg, fake, runDir } = setup({ action: "retry", notes: "pane path" });
    cfg.visibility.llm = "pane";
    const v = await consult(dossier, cfg, [fake], stub, "/tmp", runDir);
    expect(v).toEqual({ action: "retry", notes: "pane path" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/^bash ['"]/);
    expect(captured[0]!.length).toBeLessThan(120);
    const scriptPath = captured[0]!.slice(6, -1);
    const script = readFileSync(scriptPath, "utf8");
    const promptFile = join(runDir, "consults", readdirSync(join(runDir, "consults")).find((f) => f.endsWith(".md"))!);
    const nonce = extractPromptNonce(readFileSync(promptFile, "utf8"))!;
    expect(script).toContain(bannerShell());
    expect(script.trimEnd().endsWith(gateExitTrailer(nonce))).toBe(true);
    expect(script).toContain("export BASH_SILENCE_DEPRECATION_WARNING=1");
  });

  test("OBS-50: headless consult path stays byte-identical — sh() only, no banner or script", async () => {
    const { cfg, fake, runDir } = setup({ action: "retry", notes: "headless bytes" });
    const throwing: ExecutorDriver = {
      id: "throw",
      interactive: false,
      slot: async () => { throw new Error("driver.slot should not be called"); },
      run: async () => { throw new Error("driver.run should not be called"); },
      waitOutput: async () => { throw new Error("driver.waitOutput should not be called"); },
      waitAgentStatus: async () => false,
      status: async () => "unknown",
      read: async () => { throw new Error("driver.read should not be called"); },
      notify: async () => {},
      close: async () => { throw new Error("driver.close should not be called"); },
      worktree: async () => "/tmp/wt",
    };
    const v = await consult(dossier, cfg, [fake], throwing, "/tmp", runDir);
    expect(v).toEqual({ action: "retry", notes: "headless bytes" });
    expect(readdirSync(join(runDir, "consults")).some((f) => f.endsWith(".sh"))).toBe(false);
    const promptFile = join(runDir, "consults", readdirSync(join(runDir, "consults"))[0]!);
    const headlessCmd = fake.headlessCommand(promptFile, cfg.consult.model);
    expect(headlessCmd).not.toContain("printf '%b");
    expect(headlessCmd).not.toContain("TICKMARKR_EXIT");
  });

  test("waitOutput deadline tracks cfg.consult.stallMinutes", async () => {
    const stubSlot: Slot = { id: "stub", name: gatePaneName("consult", "T1"), cwd: "/tmp" };
    let capturedMs = 0;
    let capturedOpts: unknown;
    const stub: ExecutorDriver = {
      id: "stub",
      interactive: false,
      slot: async (_cwd, _name, opts) => { capturedOpts = opts; return stubSlot; },
      run: async () => {},
      waitOutput: async (_slot, _marker, ms) => {
        capturedMs = ms;
        return false;
      },
      waitAgentStatus: async () => false,
      status: async () => "unknown",
      read: async () => "",
      notify: async () => {},
      close: async () => {},
      worktree: async () => "/tmp/wt",
    };

    const { cfg, fake, runDir } = setup({ action: "retry", notes: "unused" });
    cfg.visibility.llm = "pane";
    cfg.consult.stallMinutes = 3;
    const v = await consult(dossier, cfg, [fake], stub, "/tmp", runDir);
    expect(capturedMs).toBe(180_000);
    expect(capturedMs).not.toBe(600_000);
    expect(v.action).toBe("human");
    // SUP-01: the consult slot gets a dedicated role tab labeled with its task id (opts forwarded, non-vacuous)
    expect(capturedOpts).toEqual({ label: "CONSULT T1" });

    cfg.consult.stallMinutes = 1;
    await consult(dossier, cfg, [fake], stub, "/tmp", runDir);
    expect(capturedMs).toBe(60_000);
  });
});

// v1.54 T1: minimal seat adapter — a real shell command that echoes a nonce-bound verdict (object)
// or junk (string). Invocation is counted at headlessCommand-build time; the model arg is recorded
// so tests can pin WHICH seat (adapter AND model) tickmarkr actually invoked.
function seatAdapter(id: string, verdict: unknown): { adapter: WorkerAdapter; calls: { count: number; models: string[] } } {
  const calls = { count: 0, models: [] as string[] };
  const adapter = {
    id,
    headlessCommand(promptFile: string, model: string): string {
      calls.count++;
      calls.models.push(model);
      if (typeof verdict !== "object" || verdict === null) return `echo ${shq(String(verdict))}`;
      const js = `const fs=require("fs");const n=/VERDICT_NONCE: ([0-9a-f]+)/.exec(fs.readFileSync(${JSON.stringify(promptFile)},"utf8"))[1];console.log(JSON.stringify({nonce:n,...${JSON.stringify(verdict)}}))`;
      return `node -e ${shq(js)}`;
    },
  } as unknown as WorkerAdapter;
  return { adapter, calls };
}

describe("consult.prefer seat failover", () => {
  test("an absent consult prefer list preserves the pinned consult seat", async () => {
    const { cfg, fake, runDir } = setup({ action: "retry", notes: "pinned seat" });
    const alpha = seatAdapter("alpha", { action: "reroute", notes: "wrong seat" });
    const v = await consult(dossier, cfg, [alpha.adapter, fake], new SubprocessDriver(), "/tmp", runDir, {
      channels: [{ adapter: "alpha" }, { adapter: "fake" }],
    });
    expect(v).toEqual({ action: "retry", notes: "pinned seat" });
    expect(alpha.calls.count).toBe(0);
  });

  test("the consult seat uses the first prefer entry whose adapter is live", async () => {
    const { cfg, fake, runDir } = setup({ action: "human", notes: "pin must not answer" });
    cfg.consult.prefer = ["alpha:a-1", "beta:b-1"];
    const alpha = seatAdapter("alpha", { action: "retry", notes: "seat alpha" });
    const beta = seatAdapter("beta", { action: "reroute", notes: "seat beta" });
    const v = await consult(dossier, cfg, [alpha.adapter, beta.adapter, fake], new SubprocessDriver(), "/tmp", runDir, {
      channels: [{ adapter: "alpha" }, { adapter: "beta" }],
    });
    expect(v).toEqual({ action: "retry", notes: "seat alpha" });
    expect(alpha.calls).toEqual({ count: 1, models: ["a-1"] });
    expect(beta.calls.count).toBe(0);
  });

  test("a prefer entry naming an adapter absent from the live channels is skipped without an invocation", async () => {
    const { cfg, fake, runDir } = setup({ action: "human", notes: "pin must not answer" });
    cfg.consult.prefer = ["ghost:g-1", "alpha:a-1"];
    const ghost = seatAdapter("ghost", { action: "reroute", notes: "dead seat" });
    const alpha = seatAdapter("alpha", { action: "retry", notes: "live seat" });
    const v = await consult(dossier, cfg, [ghost.adapter, alpha.adapter, fake], new SubprocessDriver(), "/tmp", runDir, {
      channels: [{ adapter: "alpha" }],
    });
    expect(v).toEqual({ action: "retry", notes: "live seat" });
    expect(ghost.calls.count).toBe(0);
    expect(alpha.calls.count).toBe(1);
  });

  test("an unparseable verdict from one seat invokes the next prefer entry", async () => {
    const { cfg, fake, runDir } = setup({ action: "human", notes: "pin must not answer" });
    cfg.consult.prefer = ["alpha:a-1", "beta:b-1"];
    const alpha = seatAdapter("alpha", "gibberish, not a verdict");
    const beta = seatAdapter("beta", { action: "retry", notes: "seat beta answered" });
    const v = await consult(dossier, cfg, [alpha.adapter, beta.adapter, fake], new SubprocessDriver(), "/tmp", runDir, {
      channels: [{ adapter: "alpha" }, { adapter: "beta" }],
    });
    expect(v).toEqual({ action: "retry", notes: "seat beta answered" });
    expect(alpha.calls.count).toBe(1);
    expect(beta.calls.count).toBe(1);
  });

  test("a failed seat on the visible pane path also invokes the next prefer entry", async () => {
    const { cfg, fake, runDir } = setup({ action: "human", notes: "pin must not answer" });
    cfg.visibility.llm = "pane";
    cfg.consult.prefer = ["alpha:a-1", "beta:b-1"];
    const alpha = seatAdapter("alpha", { action: "retry", notes: "never read" });
    const beta = seatAdapter("beta", { action: "retry", notes: "never executed either" });
    let runs = 0;
    let closes = 0;
    let nonce = "";
    const stubSlot: Slot = { id: "stub", name: gatePaneName("consult", "T1"), cwd: "/tmp" };
    const stub: ExecutorDriver = {
      id: "stub",
      interactive: false,
      slot: async () => stubSlot,
      run: async (_s, cmd) => {
        runs++;
        if (runs === 1) throw new Error("seat one pane died");
        // second seat: pull the nonce from the dispatched script's exit trailer (the TICKMARKR_
        // prefix is quote-split in the script by design — match the EXIT_<nonce>: fragment)
        nonce = /EXIT_([0-9a-f]+):/.exec(readFileSync(cmd.slice(6, -1), "utf8"))![1];
      },
      waitOutput: async () => true,
      waitAgentStatus: async () => false,
      status: async () => "unknown",
      read: async () => JSON.stringify({ nonce, action: "retry", notes: "seat two pane" }),
      notify: async () => {},
      close: async () => { closes++; },
      worktree: async () => "/tmp/wt",
    };
    const v = await consult(dossier, cfg, [alpha.adapter, beta.adapter, fake], stub, "/tmp", runDir, {
      channels: [{ adapter: "alpha" }, { adapter: "beta" }],
    });
    expect(v).toEqual({ action: "retry", notes: "seat two pane" });
    expect(runs).toBe(2); // seat one dispatched and died; seat two dispatched and answered
    expect(closes).toBe(2); // the failed seat's pane did not leak
    expect(alpha.calls.count).toBe(1);
    expect(beta.calls.count).toBe(1);
  });

  test("an exhausted prefer list falls back to the pinned consult adapter and model", async () => {
    const { cfg, fake, runDir } = setup({ action: "human", notes: "unused" });
    cfg.consult = { adapter: "omega", model: "om-1", stallMinutes: 15, prefer: ["alpha:a-1"] };
    const alpha = seatAdapter("alpha", "gibberish, not a verdict");
    const omega = seatAdapter("omega", { action: "decompose", notes: "pin seat answered" });
    // omega is NOT in the live channels — the pinned final seat needs no liveness entry
    const v = await consult(dossier, cfg, [alpha.adapter, omega.adapter, fake], new SubprocessDriver(), "/tmp", runDir, {
      channels: [{ adapter: "alpha" }],
    });
    expect(v).toEqual({ action: "decompose", notes: "pin seat answered" });
    expect(alpha.calls.count).toBe(1);
    expect(omega.calls).toEqual({ count: 1, models: ["om-1"] });
  });

  test("a verdict failure on every seat still returns the fail safe human action", async () => {
    const { cfg, fake, runDir } = setup("pin gibberish, not a verdict");
    cfg.consult.prefer = ["alpha:a-1"];
    const alpha = seatAdapter("alpha", "seat gibberish, not a verdict");
    const v = await consult(dossier, cfg, [alpha.adapter, fake], new SubprocessDriver(), "/tmp", runDir, {
      channels: [{ adapter: "alpha" }],
    });
    expect(v).toEqual({ action: "human", notes: "consult verdict unparseable — failing safe to human" });
    expect(alpha.calls.count).toBe(1);
  });
});
