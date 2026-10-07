// v2.6.8 T6: the owned diagnostic table. Each scenario runs in an owned child that calls production
// runDaemon. The watchdog prints state before it expires. The product wait is not claimed fixed.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Journal } from "../../../src/run/journal.js";
import { alive, diagnosticLedgers, type OwnedRun, ownedFailures, runOwned } from "../../helpers/owned-process.js";
import { TEST_BASE_TMPDIR_ENV } from "../../helpers/tmprepo.js";
import {
  diagnosticDeadlineMs, DIAGNOSTIC_DEADLINE_MS, type FixtureChildSpec, ORDERING_MEMBERS,
  orderingOracle, type OrderingProof,
} from "../../helpers/worker-barrier.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx");
const HELPER = new URL("../../helpers/worker-barrier.ts", import.meta.url).href;

function ownedChild(spec: FixtureChildSpec, o: { ms?: number; armOn?: RegExp; armCeilingMs?: number; settleOn?: RegExp } = {}): Promise<OwnedRun> {
  const script = [
    `const { fixtureChild } = await import(${JSON.stringify(HELPER)});`,
    `await fixtureChild(${JSON.stringify(spec)});`,
  ].join("\n");
  return runOwned(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
    cwd: ROOT, ms: o.ms, armOn: o.armOn, armCeilingMs: o.armCeilingMs, settleOn: o.settleOn,
    env: { ...process.env, [TEST_BASE_TMPDIR_ENV]: process.env.TMPDIR },
  });
}

function loadProof(out: string): { proof: OrderingProof; repo: string } {
  const line = /^OUTCOME (.*)$/m.exec(out);
  if (!line) throw new Error(`fixture child returned no outcome: ${out.slice(-2_000)}`);
  const parsed = JSON.parse(line[1]!) as { repo?: string; proofPath?: string; error?: string };
  if (!parsed.proofPath || !parsed.repo) throw new Error(parsed.error ?? `outcome missing the retained proof: ${line[1]}`);
  return { repo: parsed.repo, proof: JSON.parse(readFileSync(parsed.proofPath, "utf8")) as OrderingProof };
}

/** State printed before the expiry line. Alarm text with none of that state does not pass. */
function namesLaunchAndBarriers(text: string): boolean {
  const at = text.indexOf("DIAGNOSTIC_EXPIRED");
  if (at < 0) return false;
  const before = text.slice(0, at);
  const held = before.match(/^barrier \S+ held$/gm) ?? [];
  const diag = /^DIAGNOSTIC run=\S+ scenario=\S+ deadline=1000$/m.exec(before);
  return diag !== null && before.includes("worker-launch T1") && !before.includes("worker-launch T1 absent") && held.length >= 2;
}

test("production fixture child prints the first task worker-launch and both barrier states at the injected 1000 ms watchdog versus healthy ordered completion", async () => {
  expect(diagnosticDeadlineMs()).toBe(DIAGNOSTIC_DEADLINE_MS);
  expect(DIAGNOSTIC_DEADLINE_MS).toBe(60_000);
  expect(diagnosticDeadlineMs(1000)).toBe(1000);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(() => diagnosticDeadlineMs(bad)).toThrow(/refuses/);
  }
  const stalled = await ownedChild(
    { kind: "never-released", diagnosticMs: 1000 },
    { ms: 90_000, settleOn: /^DIAGNOSTIC_EXPIRED /m },
  );
  const stalledRepo = /^REPO (\S+)$/m.exec(stalled.out)?.[1];
  try {
    expect(namesLaunchAndBarriers(stalled.out), stalled.out.slice(-3_000)).toBe(true);
    expect(namesLaunchAndBarriers("DIAGNOSTIC_EXPIRED alarm only\n")).toBe(false);
    expect(stalled.survivors, stalled.err.slice(-1_000)).toEqual([]);
    expect(stalled.unresolved).toBeUndefined();
    expect(stalled.pid).not.toBe(process.pid);
    expect(alive(stalled.pid!)).toBe(false);
    for (const proc of stalled.tree) expect(alive(proc.pid)).toBe(false);
  } finally {
    if (stalledRepo) rmSync(stalledRepo, { recursive: true, force: true });
  }
  expect(stalledRepo && existsSync(stalledRepo)).toBe(false);
  expect(namesLaunchAndBarriers(stalled.out)).toBe(true);

  const healthy = await ownedChild({ kind: "healthy" }, { ms: 120_000, settleOn: /^OUTCOME /m });
  const loaded = loadProof(healthy.out);
  try {
    expect(ownedFailures(healthy, "healthy"), `${healthy.err}\n${healthy.out.slice(-2_000)}`).toEqual([]);
    expect(healthy.out).toContain("WATCHDOG_CANCELLED run=run-owned-healthy-ordered scenario=healthy-ordered");
    expect(healthy.out).not.toContain("DIAGNOSTIC_EXPIRED");
    expect(loaded.proof.deadlineMs).toBe(60_000);
    const rows = Journal.open(loaded.repo, loaded.proof.runId).read();
    expect(rows.some((e) => e.event === "worker-launch" && e.taskId === "T1")).toBe(true);
    expect(orderingOracle(loaded.proof, rows), loaded.proof.violations.join("\n")).toEqual([]);
  } finally {
    rmSync(loaded.repo, { recursive: true, force: true });
  }
}, 180_000);

test("production owned fixture children retain all eight release-close-merge ordering oracles versus early hand release", async () => {
  const repos: string[] = [];
  try {
    const proofs: OrderingProof[] = [];
    for (const member of ORDERING_MEMBERS) {
      const run = await ownedChild({ kind: "ordering", ...member }, { ms: 120_000, settleOn: /^OUTCOME /m });
      const loaded = loadProof(run.out);
      repos.push(loaded.repo);
      expect(ownedFailures(run, `${member.fixture}-${member.first}`), run.out.slice(-2_000)).toEqual([]);
      expect(run.out).not.toContain("DIAGNOSTIC_EXPIRED");
      const rows = Journal.open(loaded.repo, loaded.proof.runId).read();
      expect(orderingOracle(loaded.proof, rows), loaded.proof.violations.join("\n")).toEqual([]);
      expect(loaded.proof.deadlineMs).toBe(60_000);
      expect(loaded.proof.hand).toBe(false);
      expect(loaded.proof.fixture).toBe(member.fixture);
      expect(loaded.proof.first).toBe(member.first);
      proofs.push(loaded.proof);
    }
    expect(proofs).toHaveLength(8);
    expect(proofs.map((p) => `${p.fixture}-${p.first}`).sort()).toEqual(
      ORDERING_MEMBERS.map((m) => `${m.fixture}-${m.first}`).sort(),
    );

    const hand = await ownedChild(
      { kind: "ordering", fixture: "hyg09", first: "T1", hand: true },
      { ms: 120_000, settleOn: /^OUTCOME /m },
    );
    const handed = loadProof(hand.out);
    repos.push(handed.repo);
    const rows = Journal.open(handed.repo, handed.proof.runId).read();
    const violations = orderingOracle(handed.proof, rows);
    expect(rows.some((e) => e.event === "worker-launch")).toBe(true);
    expect(violations.join("\n")).toContain("released by hand");
    expect(handed.proof.hand).toBe(true);
  } finally {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  }
}, 600_000);

test("production conflict fixture expires after task-human with one joined red ledger versus post-teardown journal writes or another scenario", async () => {
  const run = await ownedChild({ kind: "hold-after-human" }, { ms: 0, armOn: /^TASK-HUMAN /m, armCeilingMs: 120_000 });
  const repo = /^REPO (\S+)$/m.exec(run.out)?.[1];
  try {
    expect(run.out, run.err.slice(-2_000)).toMatch(/^TASK-HUMAN \S+$/m);
    expect(run.out.match(/^TASK-HUMAN /gm)).toHaveLength(1);
    expect(run.out).not.toContain("DIAGNOSTIC_EXPIRED");
    expect(run.out).not.toContain("OUTCOME");
    expect(run.out.match(/^REPO /gm)).toHaveLength(1);
    expect(run.pid).not.toBe(process.pid);
    expect(alive(run.pid!)).toBe(false);
    expect(run.tree.every((proc) => !alive(proc.pid))).toBe(true);
    expect(run.survivors).toEqual([]);
    const journalPath = /^JOURNAL (\S+)$/m.exec(run.out)![1]!;
    const runId = journalPath.split("/").at(-2)!;
    const rows = Journal.open(repo!, runId).read();
    expect(rows.some((e) => e.event === "task-human")).toBe(true);
    const before = readFileSync(journalPath);
    const barriers = [...run.out.matchAll(/^BARRIER (\S+)$/gm)].map((match) => match[1]!);
    expect(barriers.length).toBeGreaterThanOrEqual(2);
    for (const barrier of barriers) writeFileSync(barrier, "manual");
    expect(readFileSync(journalPath)).toEqual(before);
    const reds = [
      ...(run.why === "expired" ? [`${runId}: wall-time bound 0 ms exhausted`] : []),
      ...(run.unresolved ? [`${runId}: ownership unresolved — ${run.unresolved}`] : []),
      ...(run.survivors.length ? [`${runId}: survivors ${run.survivors.join(",")}`] : []),
    ];
    expect(reds).toEqual([`${runId}: wall-time bound 0 ms exhausted`]);
    rmSync(repo!, { recursive: true, force: true });
    expect(existsSync(repo!)).toBe(false);
    expect(reds).toEqual([`${runId}: wall-time bound 0 ms exhausted`]);
  } finally {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
}, 180_000);

test("production owned fixture parent returns joined success versus a named survivor or unresolved-census red in the closed diagnostic table", async () => {
  const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  const survivorPid = sleeper.pid!;
  const script = (tail: string) => ["-e", `process.stdout.write(${JSON.stringify(`${tail}\n`)})`];
  try {
    const ledgers = await diagnosticLedgers([
      { name: "joined-success", run: () => runOwned(process.execPath, script("TAIL joined-success"), { ms: 30_000 }) },
      {
        name: "injected-survivor",
        run: () => runOwned(process.execPath, script("TAIL injected-survivor"), { ms: 30_000, injectSurvivors: [survivorPid] }),
      },
      {
        name: "unresolved-census",
        run: () => runOwned(process.execPath, script("TAIL unresolved-census"), {
          ms: 30_000,
          ps: async () => { throw new Error("injected census failure"); },
        }),
      },
      { name: "rejected-parent", run: async () => { throw new Error("injected parent rejection"); } },
    ]);
    expect(ledgers.map((ledger) => ledger.name)).toEqual([
      "joined-success", "injected-survivor", "unresolved-census", "rejected-parent",
    ]);
    expect(ledgers[0]).toMatchObject({ ok: true, cause: "", survivors: [] });
    expect(ledgers[0]!.pid).toBeGreaterThan(0);
    expect(ledgers[0]!.tail).toContain("TAIL joined-success");
    expect(ledgers[1]).toMatchObject({ ok: false });
    expect(ledgers[1]!.pid).toBeGreaterThan(0);
    expect(ledgers[1]!.cause).toContain(String(survivorPid));
    expect(ledgers[1]!.tail).toContain("TAIL injected-survivor");
    expect(ledgers[1]!.survivors).toContain(survivorPid);
    expect(ledgers[2]).toMatchObject({ ok: false });
    expect(ledgers[2]!.pid).toBeGreaterThan(0);
    expect(ledgers[2]!.cause).toMatch(/unresolved/);
    expect(ledgers[2]!.cause).toContain("injected census failure");
    expect(ledgers[2]!.tail).toContain("TAIL unresolved-census");
    expect(ledgers[3]).toMatchObject({ ok: false });
    expect(ledgers[3]!.cause).toContain("injected parent rejection");
    expect(ledgers[3]!.tail).toContain("injected parent rejection");
    expect(ledgers.filter((ledger) => ledger.ok).map((ledger) => ledger.name)).toEqual(["joined-success"]);
  } finally {
    try { process.kill(survivorPid, "SIGKILL"); } catch { /* already gone */ }
  }
}, 60_000);
