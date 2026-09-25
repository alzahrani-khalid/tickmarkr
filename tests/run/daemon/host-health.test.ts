import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { graphDefinitionHash, loadGraph } from "../../../src/graph/graph.js";
import { gitHead } from "../../../src/run/git.js";
import { Journal } from "../../../src/run/journal.js";
import { resetApprovalWindowForTests, resetLiveSuiteCountForTests, resetSuiteWaitCeilingForTests, runDaemon,
  setApprovalWindowForTests, setLiveSuiteCountForTests, setSuiteWaitCeilingForTests } from "../../../src/run/daemon.js";
import { HOST_PROBE_SAMPLE_MS, observeHost, resetHostLatencySampleForTests, resetHostProbeSpawnForTests,
  setHostLatencySampleForTests, setHostProbeSpawnForTests } from "../../../src/run/host-health.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../../helpers/tmprepo.js";

beforeEach(() => {
  vi.stubEnv("TICKMARKR_LEASE_TOKEN", undefined);
  setLiveSuiteCountForTests(async () => 0);
  setApprovalWindowForTests(1);
  setSuiteWaitCeilingForTests(4_000);
});
afterEach(() => {
  resetHostLatencySampleForTests(); resetHostProbeSpawnForTests();
  resetLiveSuiteCountForTests(); resetSuiteWaitCeilingForTests(); resetApprovalWindowForTests();
  vi.unstubAllEnvs();
});

function fixture() {
  const dir = makeTestTempDir("host-runner-");
  const marker = join(dir, "ran");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node test.cjs" } }));
  writeFileSync(join(dir, "test.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'suite\\n'); console.log('Tests  1 passed (1)');`);
  return { ...setupRepo([T("T1")], { tasks: { T1: [{ shell: `echo done > done.txt && ${COMMIT} done`,
    result: { ok: true, summary: "done" } }] } }, `gates: { test: 'cd ${dir} && npm run -s test' }\n`), marker };
}

test("host failure before a configured baseline is persisted closes the run as a fatal baseline failure", async () => {
  // OBS-1160 review: a normal infra park here advertised resume despite missing baseline.json.
  for (const mode of ["startup-unreadable", "baseline-degraded"] as const) {
    const { repo, fake, marker } = fixture();
    const runId = `run-missing-baseline-${mode}`;
    let samples = 0;
    setSuiteWaitCeilingForTests(0);
    setHostLatencySampleForTests(async () => mode === "startup-unreadable" ? null : samples++ < 3 ? 20 : 90);

    await expect(runDaemon(repo, { adapters: [fake], runId })).rejects.toThrow(
      "host latency remained degraded or unreadable through suite-wait deadline");

    const journal = Journal.open(repo, runId);
    expect(existsSync(join(journal.dir, "baseline.json"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const rows = journal.read();
    expect(rows.some(row => row.event === "host-degraded")).toBe(true);
    const ends = rows.filter(row => row.event === "run-end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data).toMatchObject({ fatal: true, phase: "baseline" });
    expect(rows.some(row => row.event === "suite-budget" || row.event === "suite-wait-ceiling")).toBe(false);
  }
});

test("cancellation during the startup probe preserves a command-free baseline for resume", async () => {
  const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{
    shell: `echo done > done.txt && ${COMMIT} done`, result: { ok: true, summary: "done" },
  }] } });
  const runId = "run-probe-before-baseline";
  const baselinePath = join(repo, ".tickmarkr", "runs", runId, "baseline.json");
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>(resolve => { exited = resolve; });
  setHostLatencySampleForTests(async signal => {
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual({ commands: {} });
    process.emit("SIGTERM", "SIGTERM");
    signal.throwIfAborted();
    return 20;
  });
  await expect(runDaemon(repo, { adapters: [fake], runId, exit: exited })).rejects.toThrow("terminated by SIGTERM");
  expect(await exitCode).toBe(143);

  let samples = 0;
  setHostLatencySampleForTests(async () => { samples++; return 20; });
  const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true });
  expect(summary.done).toEqual(["T1"]);
  expect(samples).toBeGreaterThanOrEqual(3);
});

test("test: the production daemon with zero competing suites stays in host-degraded wait at 3.0× plus the floor until recovery versus immediate admission at 2.9×, so suite count alone deciding admission fails", async () => {
  for (const [reference, measured, shouldWait] of [[20, 60, true], [20, 58, false], [1, 49, false], [1, 50, true]] as const) {
    const { repo, fake, marker } = fixture();
    let calls = 0, waits = 0, recovered = false;
    setHostLatencySampleForTests(async (_signal, bound) => {
      expect(bound).toBeGreaterThan(0); expect(bound).toBeLessThanOrEqual(HOST_PROBE_SAMPLE_MS);
      const median = calls < 3 || recovered ? reference : measured;
      // A nonconstant triple proves the daemon uses the median, not its max or final sample.
      return median * [2, 0.5, 1][calls++ % 3]!;
    });
    const runId = `run-host-${reference}-${measured}`;
    const summary = await runDaemon(repo, { adapters: [fake], runId, narrate: row => {
      if (row.event === "host-degraded") {
        expect(existsSync(marker)).toBe(false);
        expect(row.data.count).toBe(0);
        expect(row.data.medianMs).toBe(measured);
        if (++waits === 2) recovered = true;
      }
    } });
    expect(summary.done).toEqual(["T1"]);
    expect(existsSync(marker)).toBe(true);
    expect(waits).toBe(shouldWait ? 2 : 0);
    const rows = Journal.open(repo, runId).read();
    expect(rows.find(row => row.event === "host-reference")?.data).toMatchObject({ medianMs: reference,
      samplesMs: [reference * 2, reference * 0.5, reference] });
    expect(rows.some(row => row.event === "host-reference-reset" || row.event === "suite-budget")).toBe(false);
    expect(rows.filter(row => row.event === "host-observation").every(row => (row.data.samplesMs as unknown[]).length === 3)).toBe(true);
  }
}, 30_000);

test("test: the production daemon journals host-reference-reset with both medians before adopting a persistently slower resume reference after the whole deadline with no live suite versus parking infra for an unreadable probe, so silently adopting a slower reference or falling through the occupancy fallback fails", async () => {
  for (const mode of ["slow", "unreadable", "occupied", "interrupted"] as const) {
    const { repo, fake, marker } = fixture();
    const runId = `run-resume-host-${mode}`;
    const journal = Journal.create(repo, runId);
    journal.append("run-start", undefined, { baseRef: await gitHead(repo), commands: {}, graphDefinitionHash: graphDefinitionHash(loadGraph(repo)) });
    journal.append("host-reference", undefined, { medianMs: 20, samplesMs: [20, 20, 20] });
    writeFileSync(join(journal.dir, "baseline.json"), JSON.stringify({ commands: {} }));
    let calls = 0;
    setHostLatencySampleForTests(async () => mode === "unreadable" || (mode === "interrupted" && calls++ < 3) ? null : 90);
    setLiveSuiteCountForTests(async () => mode === "occupied" ? 1 : 0);
    const summary = await runDaemon(repo, { adapters: [fake], runId, resume: true, narrate: row => {
      if (["host-degraded", "host-reference-reset"].includes(row.event)) expect(existsSync(marker)).toBe(false);
    } });
    const rows = journal.read();
    const resets = rows.filter(row => row.event === "host-reference-reset");
    if (mode === "slow") {
      expect(summary.done).toEqual(["T1"]);
      expect(resets).toHaveLength(1);
      expect(resets[0]!.data).toMatchObject({ referenceMs: 20, medianMs: 90 });
      expect(resets[0]!.data.waitedMs).toBeGreaterThanOrEqual(4_000);
      const resetIndex = rows.indexOf(resets[0]!);
      expect(rows.slice(resetIndex + 1).some(row => row.event === "host-observation" && row.data.referenceMs === 90)).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } else {
      expect(summary.human).toEqual(["T1"]);
      expect(resets).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
      expect(rows.find(row => row.event === "task-human")?.data).toMatchObject({ kind: "infra", disposition: "host-degraded" });
    }
    expect(rows.some(row => row.event === "suite-budget" || row.event === "suite-wait-ceiling")).toBe(false);
  }
}, 30_000);

test("test: the production daemon cancellation retires its owned latency-probe child versus healthy preflight retaining the existing bounded occupancy fallback, so cancellation leaking the probe or health gating disabling ordinary fallback fails", async () => {
  const { repo, fake, marker } = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>(resolve => { exited = resolve; });
  setHostProbeSpawnForTests(((_binary, _args, options) => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    child.once("spawn", () => process.emit("SIGTERM", "SIGTERM"));
    return child;
  }) as typeof spawn);
  try {
    await expect(runDaemon(repo, { adapters: [fake], runId: "run-cancel-probe", exit: exited })).rejects.toThrow("terminated by SIGTERM");
    expect(await exitCode).toBe(143);
    expect(child?.pid).toBeGreaterThan(0);
    expect(() => process.kill(child!.pid!, 0)).toThrow();
    expect(existsSync(marker)).toBe(false);
  } finally { child?.kill("SIGKILL"); resetHostProbeSpawnForTests(); }

  const healthy = fixture();
  setHostLatencySampleForTests(async () => 20);
  setLiveSuiteCountForTests(async () => 1);
  setSuiteWaitCeilingForTests(0);
  const summary = await runDaemon(healthy.repo, { adapters: [healthy.fake], runId: "run-healthy-occupied" });
  expect(summary.done).toEqual(["T1"]);
  const rows = Journal.open(healthy.repo, "run-healthy-occupied").read();
  expect(rows.filter(row => row.event === "suite-wait-ceiling").length).toBeGreaterThan(0);
  expect(rows.filter(row => row.event === "suite-budget").length).toBeGreaterThan(0);
  expect(rows.some(row => row.event === "host-degraded")).toBe(false);
});

test("latency probe timeout reaps its child and marks the whole three-sample observation unreadable", async () => {
  const children: ReturnType<typeof spawn>[] = [];
  setHostProbeSpawnForTests(((_binary, _args, options) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    children.push(child);
    return child;
  }) as typeof spawn);
  try {
    const observation = await observeHost(new AbortController().signal, 60);
    expect(observation.medianMs).toBeNull();
    expect(observation.samplesMs).toEqual([null, null, null]);
    for (const child of children) expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally { for (const child of children) child.kill("SIGKILL"); }
});

test("a host that degrades after baseline parks the task infra without starting its gate suite", async () => {
  const { repo, fake, marker } = fixture();
  let median = 20;
  setHostLatencySampleForTests(async () => median);
  setSuiteWaitCeilingForTests(0);
  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-task-host-failure", narrate: row => {
    if (row.event === "phase-start" && row.data.phase === "gates") median = 90;
  } });
  expect(summary.human).toEqual(["T1"]);
  const rows = Journal.open(repo, "run-task-host-failure").read();
  expect(rows.find(row => row.event === "host-degraded")?.taskId).toBe("T1");
  expect(rows.find(row => row.event === "task-human")?.data).toMatchObject({ kind: "infra", disposition: "host-degraded" });
  expect(readFileSync(marker, "utf8")).toBe("suite\n"); // baseline only
  expect(rows.some(row => row.event === "suite-budget" || row.event === "merge")).toBe(false);
});
