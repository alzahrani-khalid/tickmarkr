import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { claudeCode } from "../../src/adapters/claude-code.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { runViaDriver, gatePaneName, gateExitTrailer, generateVerdictNonce, verdictNonceLine } from "../../src/gates/llm.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import { reviewGate } from "../../src/gates/review.js";
import { GATE_NAMES, validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], gates: [...GATE_NAMES], ...over }],
  }).tasks[0];

function fakeWith(extra: object): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-via-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...extra }));
  return new FakeAdapter(p);
}

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

// records slot names + closes while delegating to a real SubprocessDriver
function spyDriver(): { driver: ExecutorDriver; names: string[]; closed: string[]; waits: { pattern: string; opts?: { regex?: boolean } }[]; slotOpts: { name: string; opts?: unknown }[] } {
  const inner = new SubprocessDriver();
  const names: string[] = [];
  const closed: string[] = [];
  const waits: { pattern: string; opts?: { regex?: boolean } }[] = [];
  const slotOpts: { name: string; opts?: unknown }[] = [];
  const driver: ExecutorDriver = {
    id: "spy",
    interactive: false,
    status: (s) => inner.status(s),
    async slot(cwd, name, opts) {
      names.push(name);
      slotOpts.push({ name, opts });
      return inner.slot(cwd, name);
    },
    run: (s, c) => inner.run(s, c),
    waitOutput: (s, p, t, o) => {
      waits.push({ pattern: p, opts: o });
      return inner.waitOutput(s, p, t, o);
    },
    waitAgentStatus: (s, st, t) => inner.waitAgentStatus(s, st, t),
    read: (s, n) => inner.read(s, n),
    notify: (m, o) => inner.notify(m, o),
    async close(s) {
      closed.push(s.name);
      return inner.close(s);
    },
    worktree: (r, b, ref) => inner.worktree(r, b, ref),
  };
  return { driver, names, closed, waits, slotOpts };
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const CH: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];

describe("v1.1 driver-routed gates", () => {
  test("acceptanceGate via driver: named slot created, verdict parsed, slot closed when keep is off", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] } });
    const { driver, names, closed, slotOpts } = spyDriver();
    const r = await acceptanceGate(mkTask(), repo, base, { adapter: fake, model: "fake-1" }, {
      driver, name: "T1-judge-fake", label: "JUDGE T1",
    });
    expect(r).toMatchObject({ gate: "acceptance", pass: true });
    expect(names).toContain(gatePaneName("judge", "T1"));
    expect(closed).toContain(gatePaneName("judge", "T1"));
    // SUP-01: the judge slot got a dedicated role-first label (opts forwarded, non-vacuous)
    const jo = slotOpts.find((o) => o.name === gatePaneName("judge", "T1"))?.opts as { label?: string } | undefined;
    expect(jo?.label).toMatch(/^JUDGE T1$/);
  });

  test("keep: true leaves the slot open and reports it via onSlot", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] } });
    const { driver, names, closed } = spyDriver();
    const kept: Slot[] = [];
    const r = await acceptanceGate(mkTask(), repo, base, { adapter: fake, model: "fake-1" }, {
      driver, name: "T1-judge-fake", keep: true, onSlot: (s) => kept.push(s),
    });
    expect(r.pass).toBe(true);
    expect(names).toContain(gatePaneName("judge", "T1"));
    expect(closed).not.toContain(gatePaneName("judge", "T1"));
    expect(kept.map((s) => s.name)).toContain(gatePaneName("judge", "T1"));
  });

  test("reviewGate via driver: reviewer resolved first, then slot named for it", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const { driver, names, slotOpts } = spyDriver();
    const r = await reviewGate(mkTask(), repo, base, author, CH, [fake], DEFAULT_CONFIG, {
      driver,
      nameFor: (role, adapter) => `T1-${role}-${adapter}`,
      labelFor: (role) => `${role.toUpperCase()} T1`,
    });
    expect(r.pass).toBe(true);
    expect(names).toContain(gatePaneName("review", "T1"));
    // SUP-01: the review slot carries a role-first label with the task id (opts forwarded, non-vacuous)
    const ro = slotOpts.find((o) => o.name === gatePaneName("review", "T1"))?.opts as { label?: string } | undefined;
    expect(ro?.label).toMatch(/^REVIEW T1$/);
  });

  // v1.4 self-reference-trap regression: P02-03 (router+tests carrying tickmarkr's own "TICKMARKR_EXIT:"
  // literal) parked because the review/judge pane completed on the DISPLAYED marker, not the real one.
  // The gate must wait for a digit-suffixed exit code, which source-under-review can't forge.
  // v1.16 (REN-02): marker renamed TICKMARKR_EXIT -> TICKMARKR_EXIT outright (no dual-parse needed).
  test("gates wait for the digit-suffixed exit marker, never a bare TICKMARKR_EXIT: a diff may display", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] } });
    const { driver, waits } = spyDriver();
    const r = await acceptanceGate(mkTask(), repo, base, { adapter: fake, model: "fake-1" }, {
      driver, name: "T1-judge-fake",
    });
    expect(r.pass).toBe(true);
    const w = waits.find((w) => w.pattern.includes("TICKMARKR_EXIT"));
    expect(w).toBeDefined();
    expect(w!.opts?.regex).toBe(true);
    expect(w!.pattern).toMatch(/TICKMARKR_EXIT_[0-9a-f]+:\\d/);
  });

  // v1.4 MCP-dialog stall (HYG-02): gate LLM calls must carry the adapter's MCP pinning — audited, not assumed.
  // All four headless claude call sites (gates/llm.ts:31,49; run/consult.ts:71,77) route through
  // adapter.headlessCommand(); this pins the runViaDriver path (acceptance.test.ts:42 pins judge routing).
  test("runViaDriver emits the claude adapter's MCP pinning on the gate dispatch command (HYG-02)", async () => {
    const captured: string[] = [];
    // fully-stubbed driver: run() captures the command, waitOutput resolves immediately,
    // read returns "{}" — nothing is ever executed, zero-token.
    const stub = {
      id: "capture",
      interactive: false,
      async slot(cwd: string, name: string): Promise<Slot> { return { id: name, name, cwd }; },
      async run(_s: Slot, cmd: string) { captured.push(cmd); },
      async waitOutput() { return true; },
      async waitAgentStatus() { return true; },
      async status() { return "unknown"; },
      async read() { return "{}"; },
      async notify() {},
      async close() {},
      async worktree() { return ""; },
    } as unknown as ExecutorDriver;
    const callNonce = generateVerdictNonce();
    await runViaDriver(claudeCode, "fable", `TICKMARKR-JUDGE\n${verdictNonceLine(callNonce)}`, "/w", { driver: stub, name: "t" });
    expect(captured[0]).toMatch(/^bash ['"]/);
    expect(captured[0]!.length).toBeLessThan(120);
    const script = readFileSync(captured[0]!.slice(6, -1), "utf8");
    expect(script).toContain("--strict-mcp-config");
    expect(script).toContain(`--mcp-config '{"mcpServers":{}}'`);
    expect(script.trimEnd().endsWith(gateExitTrailer(callNonce))).toBe(true);
    expect(script).toContain("export BASH_SILENCE_DEPRECATION_WARNING=1");
  });

  test("without via, gates stay headless (no slots created)", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "r" }] } });
    const { names } = spyDriver();
    const r = await acceptanceGate(mkTask(), repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(true);
    expect(names).toHaveLength(0);
  });

  // v1.19 (T2): a deterministic-only task spends zero LLM — no judge slot is created even when a via
  // (visible-pane) driver is configured. The judge pane is created lazily, only when judge items exist.
  test("deterministic-only task: no judge slot created even with via (zero LLM)", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: true, criteria: [] } });
    const { driver, names, closed } = spyDriver();
    const r = await acceptanceGate(
      mkTask({ acceptance: [{ oracle: "command", command: "true" }] }),
      repo, base, { adapter: fake, model: "fake-1" }, { driver, name: "T1-judge-fake" },
    );
    expect(r.pass).toBe(true);
    expect(names).toHaveLength(0);
    expect(closed).toHaveLength(0);
  });
});
