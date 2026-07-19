import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, DEFAULT_DIFF_CAP } from "../../src/config/config.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import {
  checkDiffCap,
  diffCapParkReason,
  fetchTaskDiff,
  isDiffCapPark,
  reviewGate,
} from "../../src/gates/review.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

function scatteredSweepRepo(fileCount: number, lineLen: number): { repo: string; base: string } {
  const ctx = `${"c".repeat(lineLen)}\n`;
  const files: Record<string, string> = {};
  for (let i = 0; i < fileCount; i++) {
    // multi-line docs: one changed line per file; default diff carries ~3 lines of context per hunk.
    files[`docs/f${i}.md`] = `${ctx}${ctx}${"x".repeat(lineLen)}\n${ctx}${ctx}`;
  }
  const repo = makeRepo(files);
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  for (let i = 0; i < fileCount; i++) {
    const content = `${ctx}${ctx}${"y".repeat(lineLen)}\n${ctx}${ctx}`;
    writeFileSync(join(repo, `docs/f${i}.md`), content);
  }
  execSync("git add -A && git commit --no-gpg-sign -m sweep", { cwd: repo });
  return { repo, base };
}

function fakeWith(script: Record<string, unknown>): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-diffcap-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...script }));
  const fake = new FakeAdapter(p);
  return fake;
}

const CAP = DEFAULT_DIFF_CAP;

const judgeTask = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "sweep", goal: "g", shape: "docs", complexity: 3, acceptance: ["token sweep ok"] }],
}).tasks[0];

const reviewTask = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "sweep", goal: "g", shape: "implement", complexity: 9, acceptance: ["ok"] }],
}).tasks[0];

describe("diff cap — OBS-48 zero-context metric", () => {
  test("scattered one-line hunks: full diff over cap, -U0 under cap, gate passes to judge", async () => {
    const { repo, base } = scatteredSweepRepo(95, 200);
    const { full, forCap } = await fetchTaskDiff(repo, base);
    expect(full.length).toBeGreaterThan(CAP);
    expect(forCap.length).toBeLessThanOrEqual(CAP);

    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } });
    fake.headlessCommand = () => `printf %s ${shq(JSON.stringify({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }))}`;
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await acceptanceGate(judgeTask, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(true);
    expect(calls).toBe(1);
  });

  test("oversized -U0 diff fails closed before any judge call", async () => {
    const { repo, base } = scatteredSweepRepo(400, 280);
    const { forCap } = await fetchTaskDiff(repo, base);
    expect(forCap.length).toBeGreaterThan(CAP);

    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } });
    fake.headlessCommand = () => `printf %s ${shq(JSON.stringify({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }))}`;
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await acceptanceGate(judgeTask, repo, base, { adapter: fake, model: "fake-1" }, undefined, { diffCap: CAP });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/diff exceeds verifiable cap/i);
    expect(calls).toBe(0);
    expect(isDiffCapPark(r)).toBe(true);
  });
});

describe("diff cap — shared implementation", () => {
  test("acceptance and review import the same checkDiffCap", () => {
    const fail = checkDiffCap("acceptance", 70_000, CAP);
    expect(fail?.meta).toEqual({ park: "human" });
    expect(checkDiffCap("review", CAP, CAP)).toBeNull();
  });

  test("review gate uses the same cap path as acceptance", async () => {
    const { repo, base } = scatteredSweepRepo(400, 280);
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    cfg.gates.diffCap = CAP;
    const channels = [
      { adapter: "fake", vendor: "a", model: "fake-1", channel: "sub" as const, tier: "frontier" as const },
      { adapter: "fake", vendor: "b", model: "fake-2", channel: "api" as const, tier: "frontier" as const },
    ];
    const author = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await reviewGate(reviewTask, repo, base, author, channels, [fake], cfg);
    expect(r.pass).toBe(false);
    expect(isDiffCapPark(r)).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("diff cap — park('human') policy", () => {
  test("cap trip carries park meta and the remedy message", () => {
    const fail = checkDiffCap("acceptance", 80_728, 60_000)!;
    expect(fail.meta).toEqual({ park: "human" });
    expect(fail.details).toMatch(/split the task/i);
    expect(fail.details).toMatch(/raise gates\.diffCap/i);
  });

  test("diffCapParkReason short-circuits escalation — no ladder steps consumed", () => {
    const capFail = checkDiffCap("acceptance", 80_728, CAP)!;
    const results = [
      { gate: "scope", pass: true, details: "ok" },
      capFail,
    ];
    const reason = diffCapParkReason(results);
    expect(reason).toMatch(/diff exceeds verifiable cap/i);
    const ladder = ["retry", "escalate", "consult"];
    const stepsTaken = isDiffCapPark(capFail) ? [] : ladder;
    expect(stepsTaken).toEqual([]);
  });
});
