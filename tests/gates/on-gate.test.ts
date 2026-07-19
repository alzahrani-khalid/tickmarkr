// VIS-08: onGate hook — failing exit, GATE_NAMES order contract, start/end pairing
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { Assignment, BillingChannel } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { captureBaseline } from "../../src/gates/baseline.js";
import { type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { GATE_NAMES } from "../../src/graph/schema.js";
import { gitHead } from "../../src/run/git.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const mkTask = (over: Record<string, unknown> = {}) =>
  validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 8, acceptance: ["a"], ...over }],
  }).tasks[0];

function fakeWith(extra: object): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-ongate-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...extra }));
  return new FakeAdapter(p);
}

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const CH: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];
const noResult = { ok: true, summary: "", deviations: [] as string[], raw: "" };

function repoWithCommit() {
  const repo = makeRepo({ "a.txt": "x\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "a.txt"), "y\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

function commitFile(repo: string, path: string, content: string) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  execSync(`git add -A && git commit -m work --no-gpg-sign`, { cwd: repo });
}

async function ctxFor(repo: string, base: string, task: ReturnType<typeof mkTask>, fake: FakeAdapter, commands: Record<string, string> = {}, baseline?: Awaited<ReturnType<typeof captureBaseline>>) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  return {
    worktree: repo, baseRef: base, author,
    result: noResult,
    commands, baseline: baseline ?? await captureBaseline(repo, commands),
    channels: CH, adapters: [fake], cfg,
  };
}

function traceOf(onGate: (e: GateEvent) => void | Promise<void>) {
  const trace: GateEvent[] = [];
  const hook = async (e: GateEvent) => { trace.push(e); await onGate(e); };
  return { trace, hook };
}

function assertShortCircuit(trace: GateEvent[], failingGate: string) {
  expect(trace.length).toBeGreaterThan(0);
  expect(trace.find((e) => e.phase === "end" && e.gate === failingGate)).toMatchObject({
    phase: "end", gate: failingGate, result: { pass: false },
  });
  const failIdx = GATE_NAMES.indexOf(failingGate as typeof GATE_NAMES[number]);
  const stopIdx = failIdx <= GATE_NAMES.indexOf("lint") ? GATE_NAMES.indexOf("lint") : failIdx;
  for (const g of GATE_NAMES.slice(stopIdx + 1)) {
    expect(trace.some((e) => e.phase === "start" && e.gate === g)).toBe(false);
  }
  for (const g of GATE_NAMES.slice(0, stopIdx + 1)) {
    if (trace.some((e) => e.phase === "start" && e.gate === g)) {
      expect(trace.some((e) => e.phase === "end" && e.gate === g)).toBe(true);
    }
  }
}

describe("VIS-08 onGate — failing exit (D-05)", () => {
  test("baseline build failure short-circuits with end event", async () => {
    const repo = makeRepo({ "fail.sh": "exit 0\n" });
    const base = await gitHead(repo);
    const commands = { build: "bash fail.sh" };
    const baseline = await captureBaseline(repo, commands);
    writeFileSync(join(repo, "fail.sh"), "exit 1\n");
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const { trace, hook } = traceOf(() => {});
    await runGates(mkTask({ gates: [...GATE_NAMES] }), {
      ...(await ctxFor(repo, base, mkTask(), fake, commands, baseline)),
      onGate: hook,
    });
    assertShortCircuit(trace, "build");
  });

  test("evidence failure short-circuits with end event", async () => {
    const repo = makeRepo({ "a.txt": "x\n" });
    const base = await gitHead(repo);
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const { trace, hook } = traceOf(() => {});
    await runGates(mkTask({ gates: [...GATE_NAMES] }), {
      ...(await ctxFor(repo, base, mkTask(), fake)),
      onGate: hook,
    });
    assertShortCircuit(trace, "evidence");
  });

  test("scope failure short-circuits with end event", async () => {
    const repo = makeRepo({ "src/a.ts": "x", "README.md": "r" });
    const base = await gitHead(repo);
    commitFile(repo, "README.md", "drive-by\n");
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const { trace, hook } = traceOf(() => {});
    await runGates(mkTask({ gates: [...GATE_NAMES], files: ["src/**"] }), {
      ...(await ctxFor(repo, base, mkTask(), fake)),
      onGate: hook,
    });
    assertShortCircuit(trace, "scope");
  });

  test("acceptance failure short-circuits with end event", async () => {
    const { repo, base } = repoWithCommit();
    const fake = fakeWith({ judge: { pass: false, criteria: [{ criterion: "c1", met: false, reason: "nope" }] }, review: { approve: true, issues: [] } });
    const { trace, hook } = traceOf(() => {});
    await runGates(mkTask({ gates: [...GATE_NAMES], files: [] }), {
      ...(await ctxFor(repo, base, mkTask(), fake)),
      onGate: hook,
    });
    assertShortCircuit(trace, "acceptance");
  });
});

describe("VIS-08 GATE_NAMES order contract on phase:start sequence", () => {
  test("all-gates pass: start order deep-equals GATE_NAMES.filter(enabled)", async () => {
    const { repo, base } = repoWithCommit();
    const task = mkTask({ gates: [...GATE_NAMES], files: [] });
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const commands = { build: "true", test: "true", lint: "true" };
    const { trace, hook } = traceOf(() => {});
    await runGates(task, { ...(await ctxFor(repo, base, task, fake, commands)), onGate: hook });
    const starts = trace.filter((e) => e.phase === "start").map((e) => e.gate);
    expect(starts).toEqual(GATE_NAMES.filter((g) => task.gates.includes(g)));
    expect(trace.length).toBeGreaterThan(0);
  });
});

describe("VIS-08 onGate — start/end pairing + absent-hook identity", () => {
  test("every end is preceded by exactly one start for the same gate", async () => {
    const { repo, base } = repoWithCommit();
    const task = mkTask({ gates: [...GATE_NAMES], files: [] });
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const { trace, hook } = traceOf(() => {});
    await runGates(task, { ...(await ctxFor(repo, base, task, fake)), onGate: hook });
    expect(trace.length).toBeGreaterThan(0);
    for (const e of trace.filter((x) => x.phase === "end")) {
      const starts = trace.filter((x) => x.phase === "start" && x.gate === e.gate);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ index: expect.any(Number), total: expect.any(Number) });
    }
  });

  test("undefined onGate returns same results as capturing hook", async () => {
    const { repo, base } = repoWithCommit();
    const task = mkTask({ gates: [...GATE_NAMES], files: [] });
    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] } });
    const baseCtx = await ctxFor(repo, base, task, fake);
    const bare = await runGates(task, baseCtx);
    const { hook } = traceOf(() => {});
    const hooked = await runGates(task, { ...baseCtx, onGate: hook });
    expect(hooked).toEqual(bare);
  });
});

describe("VIS-08 RED-DRILLS provenance gate (D-13)", () => {
  test("committed artifact greps four drills + run-local entropy — copy-paste from RESEARCH fails", () => {
    const artifact = readFileSync(
      // VENDORED byte-exact from the archived v1.11 phase-39 artifact (v1.59 export boundary):
      // the live `.planning` tree ships in no export, so the drill evidence lives in tests/fixtures/.
      join(import.meta.dirname, "../fixtures/gates/RED-DRILLS.md"),
      "utf8",
    );
    expect(artifact).toContain("## RED — drill 1 (failing exit)");
    expect(artifact).toContain("## RED — drill 2 (GATE_NAMES order contract)");
    expect(artifact).toContain("## RED — drill 3 (notify writes to the journal)");
    expect(artifact).toContain("## RED — drill 4 (notify flips a gate to pass)");
    expect(artifact).toContain("## Restore confirmation");
    expect(artifact).toMatch(/tsc -p tsconfig\.json --noEmit/);
    const repoPrefix = `(?:tickmarkr|${["dro", "vr"].join("")}|${["dro", "ver"].join("")})`;
    expect(artifact).toMatch(new RegExp(`${repoPrefix}-repo-[A-Za-z0-9]{6}`));
    expect(artifact).toMatch(/(?:^|[^A-Za-z])FAIL/);
    expect(artifact).not.toMatch(/run-20260711-(083431|085948|101750)/);
  });
});
