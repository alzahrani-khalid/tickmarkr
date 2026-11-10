// Queue rows 362 and 367 R2 (D-2187): doctor and `fleet --print --why` print the contract's DEAD line from the
// merged seat resolver's dead-preference check, on row 362's captured overlay shape.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import type { BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { fleet } from "../../src/cli/commands/fleet.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

afterEach(() => { vi.restoreAllMocks(); });

const DEAD = "DEAD: consult.prefer entry claude-code:opus is disallowed for the consult seat by routing.deny (claude-code:opus) — it is never chosen; remove it or the deny entry";

const channel = (adapter: string, vendor: string, model: string): BillingChannel => ({ adapter, vendor, model, channel: "sub", tier: "frontier" });
// Probe-free stubs: no headless command, so doctor records "headless probe unavailable" and spends nothing.
const adapters: WorkerAdapter[] = [
  channel("claude-code", "anthropic", "opus"),
  channel("codex", "openai", "gpt-6.1-sol"),
].map((c) => ({
  id: c.adapter, vendor: c.vendor, channels: () => [c],
  probe: async () => ({ installed: true, authed: true, models: [c.model] }),
  interactiveCommand: () => null,
  trustDialog: { kind: "none", reason: "fixture has no trust dialog" },
  invoke: () => ({ command: "unused" }),
  parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
}) as unknown as WorkerAdapter);

async function row362(deny: boolean) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  const repo = makeRepo({ "keep.txt": "x\n" });
  const globalDir = makeTestTempDir("dead-prefer-");
  // The user overlay prefers claude-code:opus first; the repository's tracked overlay denies it.
  writeFileSync(join(globalDir, "config.yaml"), "consult:\n  prefer: [claude-code:opus, codex:gpt-6.1-sol]\n");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), deny ? "routing:\n  deny:\n    models: [claude-code:opus]\n" : "{}\n");
  const doctorOut = await doctor([], repo, adapters, { banner: false, globalDir, resolveClaudeAliasIdentity: () => undefined });
  const why = await fleet(["--print", "--why", "--global-dir", globalDir], repo, adapters);
  expect(typeof why, JSON.stringify(why)).toBe("string");
  return { doctorOut, whyOut: why as string };
}

test("doctor and fleet print with why flag a consult preference the merged routing denies as dead and print no dead line once the deny is removed", async () => {
  const denied = await row362(true);
  for (const out of [denied.doctorOut, denied.whyOut]) {
    const lines = out.split("\n").filter((line) => line.includes("DEAD:"));
    expect(lines, out).toHaveLength(1);
    expect(lines[0]).toContain(DEAD);
  }
  // The live second entry is never flagged.
  expect(denied.whyOut).not.toContain("entry codex:gpt-6.1-sol is disallowed");

  // Control: the deny removed — the same preference is no longer dead, so no DEAD line anywhere.
  const control = await row362(false);
  for (const out of [control.doctorOut, control.whyOut]) expect(out).not.toContain("DEAD:");
});
