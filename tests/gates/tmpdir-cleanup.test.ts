import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { probeAll, probeModels } from "../../src/adapters/registry.js";
import { shq, type WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { runHeadless, runViaDriver, verdictNonceLine } from "../../src/gates/llm.js";

function fakeAdapter(root: string): FakeAdapter {
  const script = join(root, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  return new FakeAdapter(script);
}

function captureDriver(onDispatch: (scriptPath: string, script: string) => void): ExecutorDriver {
  let output = "";
  return {
    id: "tmpdir-capture",
    interactive: false,
    async slot(cwd: string, name: string): Promise<Slot> {
      return { id: name, name, cwd };
    },
    async run(slot: Slot, command: string): Promise<void> {
      const scriptPath = /^bash '(.+)'$/.exec(command)?.[1];
      if (!scriptPath) throw new Error(`unexpected pane dispatch command: ${command}`);
      onDispatch(scriptPath, readFileSync(scriptPath, "utf8"));
      const result = spawnSync("bash", [scriptPath], { cwd: slot.cwd, encoding: "utf8" });
      if (result.error) throw result.error;
      output = `${result.stdout}${result.stderr}`;
    },
    async waitOutput(_slot: Slot, pattern: string, _timeoutMs: number, opts?: { regex?: boolean }): Promise<boolean> {
      return opts?.regex ? new RegExp(pattern).test(output) : output.includes(pattern);
    },
    async waitAgentStatus(): Promise<boolean> { return true; },
    async read(): Promise<string> { return output; },
    async notify(): Promise<void> {},
    async close(): Promise<void> {},
    async worktree(): Promise<string> { return ""; },
    async status(): Promise<string> { return "unknown"; },
  };
}

function probeHarness(root: string, command: string): {
  adapter: FakeAdapter;
  promptDirs: string[];
  promptBodies: string[];
} {
  const adapter = fakeAdapter(root);
  (adapter as WorkerAdapter & { probeCwd: "neutral" }).probeCwd = "neutral";
  const promptDirs: string[] = [];
  const promptBodies: string[] = [];
  adapter.headlessCommand = (promptFile: string) => {
    promptDirs.push(dirname(promptFile));
    promptBodies.push(readFileSync(promptFile, "utf8"));
    return command;
  };
  return { adapter, promptDirs, promptBodies };
}

async function runProbe(root: string, command: string) {
  const harness = probeHarness(root, command);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tiers.fake = { vendor: "fake", channel: "sub", models: { "fake-1": "mid" } };
  const health = await probeAll([harness.adapter]);
  await probeModels(cfg, root, [harness.adapter], health);
  return { ...harness, health };
}

describe("temporary directory ownership", () => {
  test("test: every directory the four sites create is absent when the creating call returns, proven member by member over the closed set runHeadless, runViaDriver, the neutral probe root and the auth probe dir, each call first proving it ran through its own returned value", async () => {
    const ownedRoot = mkdtempSync(join(tmpdir(), "tickmarkr-tmpdir-success-test-"));
    try {
      const headlessPromptDirs: string[] = [];
      const headlessPromptBodies: string[] = [];
      const headless = fakeAdapter(ownedRoot);
      headless.headlessCommand = (promptFile: string) => {
        headlessPromptDirs.push(dirname(promptFile));
        headlessPromptBodies.push(readFileSync(promptFile, "utf8"));
        return "printf headless-success";
      };
      const headlessResult = await runHeadless(headless, "fake-1", "headless-prompt", ownedRoot);
      expect(headlessResult).toContain("headless-success");
      expect(headlessPromptBodies).toEqual(["headless-prompt"]);
      expect(headlessPromptDirs).toHaveLength(1);
      expect(existsSync(headlessPromptDirs[0]!)).toBe(false);

      const viaScriptDirs: string[] = [];
      const viaScripts: string[] = [];
      const via = fakeAdapter(ownedRoot);
      via.headlessCommand = () => "printf via-success";
      const viaResult = await runViaDriver(
        via,
        "fake-1",
        `TICKMARKR-JUDGE\n${verdictNonceLine("11111111")}`,
        ownedRoot,
        {
          driver: captureDriver((scriptPath, script) => {
            viaScriptDirs.push(dirname(scriptPath));
            viaScripts.push(script);
          }),
          name: "tmpdir-success",
        },
      );
      expect(viaResult).toContain("via-success");
      expect(viaScripts[0]).toContain("printf via-success");
      expect(viaScriptDirs).toHaveLength(1);
      expect(existsSync(viaScriptDirs[0]!)).toBe(false);

      const neutralCwdRecord = join(ownedRoot, "neutral-cwd-success.txt");
      const probed = await runProbe(
        ownedRoot,
        `pwd > ${shq(neutralCwdRecord)}; printf probe-success`,
      );
      expect(probed.health.fake.modelAuth?.["fake-1"]?.authed).toBe(true);
      expect(probed.promptBodies).toEqual(["Reply with exactly OK and nothing else."]);
      const neutralProbeRoot = readFileSync(neutralCwdRecord, "utf8").trim();
      expect(neutralProbeRoot).not.toBe(ownedRoot);
      expect(existsSync(neutralProbeRoot)).toBe(false);
      expect(probed.promptDirs).toHaveLength(1);
      expect(existsSync(probed.promptDirs[0]!)).toBe(false);
    } finally {
      rmSync(ownedRoot, { recursive: true, force: true });
    }
  });

  test("test: each of the four calls still leaves no directory behind when its underlying command exits nonzero, and the caller still observes that failure", async () => {
    const ownedRoot = mkdtempSync(join(tmpdir(), "tickmarkr-tmpdir-failure-test-"));
    try {
      const headlessPromptDirs: string[] = [];
      const headless = fakeAdapter(ownedRoot);
      headless.headlessCommand = (promptFile: string) => {
        headlessPromptDirs.push(dirname(promptFile));
        return "printf headless-nonzero >&2; false";
      };
      const headlessResult = await runHeadless(headless, "fake-1", "headless-failure-prompt", ownedRoot);
      expect(headlessResult).toContain("headless-nonzero");
      expect(headlessPromptDirs).toHaveLength(1);
      expect(existsSync(headlessPromptDirs[0]!)).toBe(false);

      const viaScriptDirs: string[] = [];
      const via = fakeAdapter(ownedRoot);
      via.headlessCommand = () => "printf via-nonzero >&2; false";
      const viaResult = await runViaDriver(
        via,
        "fake-1",
        `TICKMARKR-JUDGE\n${verdictNonceLine("22222222")}`,
        ownedRoot,
        {
          driver: captureDriver((scriptPath) => viaScriptDirs.push(dirname(scriptPath))),
          name: "tmpdir-failure",
        },
      );
      expect(viaResult).toContain("via-nonzero");
      expect(viaResult).toContain("TICKMARKR_EXIT_22222222:1");
      expect(viaScriptDirs).toHaveLength(1);
      expect(existsSync(viaScriptDirs[0]!)).toBe(false);

      const neutralCwdRecord = join(ownedRoot, "neutral-cwd-failure.txt");
      const probed = await runProbe(
        ownedRoot,
        `pwd >> ${shq(neutralCwdRecord)}; printf probe-nonzero >&2; false`,
      );
      expect(probed.health.fake.modelAuth?.["fake-1"]).toMatchObject({
        authed: false,
        reason: "probe-nonzero",
      });
      const neutralProbeRoots = readFileSync(neutralCwdRecord, "utf8").trim().split("\n");
      expect(new Set(neutralProbeRoots).size).toBe(1);
      expect(existsSync(neutralProbeRoots[0]!)).toBe(false);
      expect(probed.promptDirs).toHaveLength(2);
      for (const authProbeDir of probed.promptDirs) expect(existsSync(authProbeDir)).toBe(false);
    } finally {
      rmSync(ownedRoot, { recursive: true, force: true });
    }
  });
});
