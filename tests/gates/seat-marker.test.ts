import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { herdrSealShellPrefix, SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runLlm } from "../../src/gates/llm.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { runDaemon } from "../../src/run/daemon.js";
import { sh } from "../../src/run/git.js";
import { COMMIT, T, makeTestTempDir, setupRepo } from "../helpers/tmprepo.js";
import { validateGraph } from "../../src/graph/schema.js";

afterEach(() => vi.unstubAllEnvs());

// The worker step and every seat read the marker in the agent process; a seat also reads it in a tool child it starts.
function markerFake(dir: string): FakeAdapter {
  const script = join(dir, "fake.json");
  const workerProbe = `node -e ${shq("console.log('WORKER_MARKER:' + (process.env.TICKMARKR_SEAT ?? 'absent'))")}`;
  writeFileSync(script, JSON.stringify({ tasks: { T1: [{ shell: workerProbe, result: { ok: true, summary: "done", deviations: [] } }] } }));
  const fake = new FakeAdapter(script);
  fake.headlessCommand = (promptFile) => `node -e ${shq(`
    const fs = require('fs');
    const prompt = fs.readFileSync(process.argv[1], 'utf8');
    const nonce = /VERDICT_NONCE: ([0-9a-f]+)/.exec(prompt)?.[1];
    const marker = process.env.TICKMARKR_SEAT ?? 'absent';
    const child = require('child_process').execFileSync(process.execPath, ['-e', "process.stdout.write(process.env.TICKMARKR_SEAT ?? 'absent')"], {encoding:'utf8'});
    console.log(JSON.stringify({nonce, action:'retry', notes:marker + ':' + child}));
  `)} ${shq(promptFile)}`;
  return fake;
}

// Runs the ordinary worker invocation on one transport and returns what its agent process saw.
async function workerMarker(fake: FakeAdapter, dir: string, driver: SubprocessDriver, transport: "headless" | "pane"): Promise<string> {
  const promptFile = join(dir, "T1-a0.md");
  writeFileSync(promptFile, "TICKMARKR_RESULT_abc12345");
  const task = validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1")] }).tasks[0]!;
  const { command } = fake.invoke(task, dir, { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" }, { promptFile });
  if (transport === "headless") return (await sh(command, dir)).stdout;
  const slot = await driver.slot(dir, "worker");
  try {
    await driver.run(slot, command);
    expect(await driver.waitOutput(slot, "TICKMARKR_RESULT_abc12345", 5_000)).toBe(true);
    return await driver.read(slot, 100);
  } finally { await driver.close(slot); }
}

// A herdr or Orca pane's shell takes its environment from its host, never from the daemon's spawn seal: here that host
// shell carries an inherited marker. Every dispatched script's text is kept.
function hostedPane(marker: string): { driver: ExecutorDriver; scripts: string[] } {
  const inner = new SubprocessDriver();
  const scripts: string[] = [];
  const driver: ExecutorDriver = {
    id: "hosted-pane", interactive: false,
    slot: inner.slot.bind(inner),
    run: async (slot, line) => {
      const path = /^bash '(.+)'$/.exec(line)?.[1];
      if (path) scripts.push(readFileSync(path, "utf8"));
      return inner.run(slot, `export TICKMARKR_SEAT=${marker}; ${line}`);
    },
    waitOutput: inner.waitOutput.bind(inner), waitAgentStatus: inner.waitAgentStatus.bind(inner),
    read: inner.read.bind(inner), notify: async () => {}, close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner), status: inner.status.bind(inner),
  };
  return { driver, scripts };
}

test("test: every judge, review and consult seat launched headless or in a pane runs with the seat marker naming its role, while a worker launch and the scope draft run without it, so a seat run that cannot be told from a worker's fails", async () => {
  vi.stubEnv("TICKMARKR_SEAT", undefined);
  const dir = makeTestTempDir("seat-marker-");
  // Read the environment in the actual agent subprocess, including a tool child it starts.
  const fake = markerFake(dir);
  const inherited = process.env.TICKMARKR_SEAT;
  expect(inherited).toBeUndefined();
  const driver = new SubprocessDriver();
  for (const transport of ["headless", "pane"] as const) {
    for (const [prefix, role] of [["TICKMARKR-JUDGE", "judge"], ["TICKMARKR-REVIEW", "review"], ["TICKMARKR-SCOPE", "absent"], ["ordinary draft mentioning TICKMARKR-JUDGE", "absent"]]) {
      const output = await runLlm(fake, "fake-1", `${prefix}\n## Task T1: marker\nVERDICT_NONCE: abc12345`, dir,
        transport === "pane" ? { driver, name: "judge · misleading-fallback" } : undefined, 5_000);
      expect(output, `${transport} ${prefix}`).toContain(`"notes":"${role}:${role}"`);
      expect(process.env.TICKMARKR_SEAT).toBe(inherited);
    }
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.visibility.llm = transport;
    cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 1 };
    const dossier: Dossier = { taskId: "T1", trigger: "gate-fail", journalTail: "", transcript: "", diff: "", gates: [] };
    const verdict = await consult(dossier, cfg, [fake], driver, dir, dir);
    expect(verdict).toMatchObject({ action: "retry", notes: "consult:consult" });
    expect(process.env.TICKMARKR_SEAT).toBe(inherited);

    // Use the ordinary worker adapter invocation after the seats, catching ambient marker leaks.
    expect(await workerMarker(fake, dir, driver, transport)).toContain("WORKER_MARKER:absent");
  }
  // The persisted pane script sets the marker before invoking the adapter.
  const paneScripts = readdirSync(join(dir, "consults")).filter(file => file.endsWith(".sh"));
  expect(paneScripts).toHaveLength(1);
  const consultScript = readFileSync(join(dir, "consults", paneScripts[0]!), "utf8");
  expect(consultScript).toContain("export TICKMARKR_SEAT=consult\n");
}, 60_000);

test("under an inherited review seat marker a worker on either transport, the scope draft, and a daemon's own worker and gate run without it, the daemon clearing it at start, while each judge, review and consult seat still carries its own role (D-2174)", async () => {
  vi.stubEnv("TICKMARKR_SEAT", "review");
  const dir = makeTestTempDir("seat-marker-inherited-");
  const fake = markerFake(dir);
  const driver = new SubprocessDriver();
  for (const transport of ["headless", "pane"] as const) {
    for (const [prefix, role] of [["TICKMARKR-JUDGE", "judge"], ["TICKMARKR-REVIEW", "review"], ["TICKMARKR-SCOPE", "absent"]]) {
      const output = await runLlm(fake, "fake-1", `${prefix}\n## Task T1: marker\nVERDICT_NONCE: abc12345`, dir,
        transport === "pane" ? { driver, name: "seat" } : undefined, 5_000);
      expect(output, `${transport} ${prefix}`).toContain(`"notes":"${role}:${role}"`);
    }
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.visibility.llm = transport;
    cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 1 };
    const dossier: Dossier = { taskId: "T1", trigger: "gate-fail", journalTail: "", transcript: "", diff: "", gates: [] };
    expect(await consult(dossier, cfg, [fake], driver, dir, dir)).toMatchObject({ notes: "consult:consult" });
    expect(await workerMarker(fake, dir, driver, transport), transport).toContain("WORKER_MARKER:absent");
  }
  // A daemon started under the marker is no seat: it clears the marker, and its worker and gate shells never see it.
  const out = makeTestTempDir("seat-marker-daemon-");
  const probe = (name: string) => `node -e ${shq(`require('fs').writeFileSync(${JSON.stringify(join(out, name))}, process.env.TICKMARKR_SEAT ?? 'absent')`)}`;
  const { repo, fake: worker } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: `${probe("worker")} && echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
  }, stringify({ gates: { build: probe("gate"), test: "true", lint: "true" } }));
  await runDaemon(repo, { adapters: [worker], runId: "run-seat-marker" });
  expect(process.env.TICKMARKR_SEAT).toBeUndefined();
  expect(readFileSync(join(out, "worker"), "utf8")).toBe("absent");
  expect(readFileSync(join(out, "gate"), "utf8")).toBe("absent");
}, 60_000);

test("under an inherited review seat marker the herdr pane seal unsets it, and in a pane whose host shell carries it the scope draft and the daemon's worker run without it while each judge, review and consult seat carries its own role, so a pane launch relying on the spawned environment's seal alone fails (D-2174)", async () => {
  vi.stubEnv("TICKMARKR_SEAT", "review");
  const sealed = execFileSync("bash", ["-c", `${herdrSealShellPrefix()}printf "%s" "\${TICKMARKR_SEAT-absent}"`],
    { env: { ...process.env, TICKMARKR_SEAT: "review" }, encoding: "utf8" });
  expect(sealed).toBe("absent");
  const dir = makeTestTempDir("seat-marker-hosted-");
  const fake = markerFake(dir);
  const seats = hostedPane("review");
  for (const [prefix, role] of [["TICKMARKR-JUDGE", "judge"], ["TICKMARKR-REVIEW", "review"], ["TICKMARKR-SCOPE", "absent"]]) {
    const output = await runLlm(fake, "fake-1", `${prefix}\n## Task T1: marker\nVERDICT_NONCE: abc12345`, dir, { driver: seats.driver, name: "seat" }, 5_000);
    expect(output, prefix).toContain(`"notes":"${role}:${role}"`);
  }
  // Each seat or draft script unsets the marker before it exports any role of its own.
  expect(seats.scripts).toHaveLength(3);
  for (const script of seats.scripts) {
    const unset = script.indexOf("unset TICKMARKR_SEAT\n");
    expect(unset, script).toBeGreaterThanOrEqual(0);
    if (script.includes("export TICKMARKR_SEAT=")) expect(script.indexOf("export TICKMARKR_SEAT=")).toBeGreaterThan(unset);
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.visibility.llm = "pane";
  cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 1 };
  const dossier: Dossier = { taskId: "T1", trigger: "gate-fail", journalTail: "", transcript: "", diff: "", gates: [] };
  expect(await consult(dossier, cfg, [fake], seats.driver, dir, dir)).toMatchObject({ notes: "consult:consult" });
  // The daemon's worker dispatch script clears it too.
  const out = makeTestTempDir("seat-marker-hosted-daemon-");
  const marker = join(out, "worker");
  const probe = `node -e ${shq(`require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.TICKMARKR_SEAT ?? 'absent')`)}`;
  const { repo, fake: worker } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: `${probe} && echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] },
  }, stringify({ gates: { build: "true", test: "true", lint: "true" } }));
  const workers = hostedPane("review");
  await runDaemon(repo, { adapters: [worker], runId: "run-seat-marker-hosted", driver: workers.driver });
  expect(readFileSync(marker, "utf8")).toBe("absent");
  expect(workers.scripts.find((script) => script.includes("TICKMARKR_RESULT"))).toContain("unset TICKMARKR_SEAT\n");
}, 60_000);
