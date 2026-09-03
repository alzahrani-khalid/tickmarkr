import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { AuthHealth, BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import type { TickmarkrConfig } from "../../src/config/config.js";
import { runDaemon } from "../../src/run/daemon.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { driverEvidence, pickDriver } from "../../src/drivers/index.js";
import { OrcaDriver } from "../../src/drivers/orca.js";
import { environmentComparable, recordedEnvironment } from "../../src/report/compare.js";
import { type RunEnvironment, UNKNOWN_ADAPTER_VERSION, runEnvironment } from "../../src/run/environment.js";
import { DEFAULT_FORK_CAP, deriveForkCap, FORK_CAP_ENV, runWithForkBudget } from "../../src/run/git.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { FakeOrca } from "../helpers/fake-orca.js";
import { COMMIT, makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// v1.70 T2: the run-start journal event stamps the run's environment identity — the running tickmarkr
// version, a deterministic hash of the loaded config, and the probed CLI version of every adapter
// holding an authed channel in the run — all gathered through the existing probe/config-load paths.

const oneTask = (id: string) => ({ tasks: { [id]: [{ shell: `echo ${id} > ${id.toLowerCase()}.txt && ${COMMIT} ${id.toLowerCase()}`, result: { ok: true, summary: "done" } }] } });

async function runAndReadEnvironment(repo: string, adapters: WorkerAdapter[], runId: string): Promise<RunEnvironment> {
  await runDaemon(repo, { adapters, runId });
  const start = Journal.open(repo, runId).read().find((e) => e.event === "run-start");
  expect(start, `journal for ${runId} has a run-start event`).toBeDefined();
  return start!.data.environment as RunEnvironment;
}

describe("run-start environment identity (fake adapter, zero tokens)", () => {
  test("test: the run-start event records the running tickmarkr version", async () => {
    const { repo, fake } = setupRepo([T("T1")], oneTask("T1"));
    const env = await runAndReadEnvironment(repo, [fake], "run-env-tickmarkr-version");
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as { version: string };
    expect(env.tickmarkrVersion).toBe(pkg.version);
  });

  test("test: the run-start event records a deterministic config hash that changes when a routing or gate setting changes", async () => {
    const a = setupRepo([T("T1")], oneTask("T1"));
    const b = setupRepo([T("T1")], oneTask("T1")); // identical overlay ⇒ identical loaded config
    const routingChanged = setupRepo([T("T1")], oneTask("T1"), "routing:\n  learned: off\n");
    const gateChanged = setupRepo([T("T1")], oneTask("T1"), "gates:\n  diffCap: 9999\n");
    const hashA = (await runAndReadEnvironment(a.repo, [a.fake], "run-env-cfg-a")).configHash;
    const hashB = (await runAndReadEnvironment(b.repo, [b.fake], "run-env-cfg-b")).configHash;
    const hashRouting = (await runAndReadEnvironment(routingChanged.repo, [routingChanged.fake], "run-env-cfg-routing")).configHash;
    const hashGate = (await runAndReadEnvironment(gateChanged.repo, [gateChanged.fake], "run-env-cfg-gate")).configHash;
    expect(hashA).toMatch(/^[0-9a-f]{16}$/);
    expect(hashB).toBe(hashA); // deterministic: same loaded config, same hash
    expect(hashRouting).not.toBe(hashA); // a routing setting change rehashes
    expect(hashGate).not.toBe(hashA); // a gate setting change rehashes
  });

  test("test: the run-start event records the installed CLI version for every adapter with an authed channel in the run, probed the same way doctor already probes adapter versions", async () => {
    const { repo, fake } = setupRepo([T("T1")], oneTask("T1"));
    const env = await runAndReadEnvironment(repo, [fake], "run-env-adapter-versions");
    const start = Journal.open(repo, "run-env-adapter-versions").read().find((e) => e.event === "run-start")!;
    const adaptersInRun = [...new Set((start.data.channels as string[]).map((k) => k.split(":")[0]))].sort();
    expect(adaptersInRun.length).toBeGreaterThan(0); // the run genuinely held authed channels
    expect(Object.keys(env.adapterVersions).sort()).toEqual(adaptersInRun);
    // the SAME probing surface doctor uses — the adapter's own probe() health record
    const probed = await fake.probe();
    expect(probed.version).toBeDefined();
    expect(env.adapterVersions.fake).toBe(probed.version);
  });

  test("test: an adapter whose version probe fails is recorded as unknown rather than omitted or fabricated", async () => {
    const { repo, fake, scriptPath } = setupRepo([T("T1")], oneTask("T1"));
    // A WorkerAdapter whose probe reports installed+authed but yields no version string — the
    // fail-open shape that reaches run-start is exactly "authed channel, version undefined"
    // (probeVersion's { installed: false } failure carries no channel and never gets here).
    class NoVersionAdapter extends FakeAdapter {
      override id = "noversion";
      override async probe(): Promise<AuthHealth> {
        const { version: _dropped, ...rest } = await super.probe();
        return rest;
      }
      override channels(cfg: TickmarkrConfig): BillingChannel[] {
        return super.channels(cfg).map((c) => ({ ...c, adapter: this.id }));
      }
    }
    const noversion = new NoVersionAdapter(scriptPath);
    expect((await noversion.probe()).version).toBeUndefined();
    const env = await runAndReadEnvironment(repo, [noversion, fake], "run-env-unknown-version");
    expect(Object.keys(env.adapterVersions)).toContain("noversion"); // recorded, not omitted
    expect(env.adapterVersions.noversion).toBe(UNKNOWN_ADAPTER_VERSION); // "unknown", not fabricated
    expect(env.adapterVersions.fake).toBe("fake");
  });

  test("test: the run-start journal row carries driver alongside driverEvidence alongside distFingerprint alongside channelsByRole listing the worker judge review and consult pools by channel key as well as a graph.json in the run directory byte-identical to the state graph the daemon loaded whereas a row carrying only one unqualified channels list or a re-serialised graph fails", async () => {
    const { repo, fake } = setupRepo([T("T1")], oneTask("T1"));
    const graphBytes = readFileSync(join(repo, ".tickmarkr", "graph.json"));
    const runId = "run-start-complete-record";
    await runDaemon(repo, { adapters: [fake], runId, driverOverride: "subprocess" });
    const journal = Journal.open(repo, runId);
    const start = journal.read().find((event) => event.event === "run-start")!;
    expect(start.data.driver).toBe("subprocess");
    expect(start.data.driverEvidence).toBe("subprocess (--driver)");
    expect(start.data.distFingerprint).toEqual(expect.any(String));
    expect(Object.keys(start.data.channelsByRole as object)).toEqual(["worker", "judge", "review", "consult"]);
    for (const role of ["worker", "judge", "review", "consult"]) {
      expect((start.data.channelsByRole as Record<string, string[]>)[role]).toEqual(expect.arrayContaining(["fake:fake-1"]));
    }
    expect(readFileSync(join(journal.dir, "graph.json"))).toEqual(graphBytes);
  });

  test("test: driverEvidence for an auto pick under the Orca marker pair returns auto → orca (TERM_PROGRAM+ORCA_TERMINAL_HANDLE) naming the variables and never their values and the run-start journal row carries that string whereas an evidence string that prints a handle value or reads auto → subprocess (HERDR_ENV unset) under the pair fails", async () => {
    const keys = ["HERDR_ENV", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE"] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    delete process.env.HERDR_ENV;
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_TERMINAL_HANDLE = "term-handle-must-stay-secret";
    try {
      const selected = pickDriver(DEFAULT_CONFIG);
      expect(selected).toBeInstanceOf(OrcaDriver);
      const evidence = driverEvidence(DEFAULT_CONFIG, selected);
      expect(evidence).toBe("auto → orca (TERM_PROGRAM+ORCA_TERMINAL_HANDLE)");
      expect(evidence).not.toContain("term-handle-must-stay-secret");
      expect(evidence).not.toBe("auto → subprocess (HERDR_ENV unset)");

      // A missing runtime proves the selected surface remains Orca: the run journals its choice,
      // then fails loudly instead of completing through a substituted subprocess driver.
      Object.defineProperty(selected, "exec", {
        value: new FakeOrca({ cliMissing: "orca: command not found" }).exec,
        configurable: true,
      });
      const { repo, fake } = setupRepo([T("T1")], oneTask("T1"));
      const runId = "run-auto-orca-evidence";
      const summary = await runDaemon(repo, { adapters: [fake], runId, driver: selected });
      const start = Journal.open(repo, runId).read().find((event) => event.event === "run-start")!;
      expect(start.data.driver).toBe("orca");
      expect(start.data.driverEvidence).toBe(evidence);
      expect(String(start.data.driverEvidence)).not.toContain("term-handle-must-stay-secret");
      expect(summary.done).toEqual([]);
      expect(summary.failed).toContain("T1");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}, 120000);

// v2.0 T2 (OBS-554): a load reading is uninterpretable without the capacity it was taken against, so
// the run-start environment records the host core count and the run-scoped vitest fork cap. Both come
// through providers, which is what lets a journal replayed on ANOTHER host reconstruct the parked
// scheduler's threshold from the record instead of from the machine doing the reading.
describe("run environment capacity (v2.0 T2)", () => {
  test("test: the run environment record carries the host core count & the effective fork cap from injected providers so a hardcoded or absent capacity fails", async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    // A host this process is not: 64 cores, a cap of 7. Neither number is derivable from the machine
    // running the suite, so a hardcoded constant or a re-read of THIS host cannot produce them.
    const injected = runEnvironment(cfg, [], {}, { cores: () => 64, forkCap: () => 7 });
    expect(injected.cores).toBe(64);
    expect(injected.forkCap).toBe(7);

    // A DIFFERENT injected host must move both numbers — a record that ignored its providers and
    // stamped one fixed capacity would return 64/7 again here.
    const other = runEnvironment(cfg, [], {}, { cores: () => 3, forkCap: () => 1 });
    expect({ cores: other.cores, forkCap: other.forkCap }).toEqual({ cores: 3, forkCap: 1 });

    // absent capacity fails: both keys are present on every minted record, and present as numbers.
    for (const env of [injected, other]) {
      expect(Object.keys(env)).toEqual(expect.arrayContaining(["cores", "forkCap"]));
      expect([typeof env.cores, typeof env.forkCap]).toEqual(["number", "number"]);
    }

    // The report comparator replays the journal rather than calling runEnvironment again. Capacity
    // must survive that parse, and either axis changing makes two otherwise-identical runs a mismatch.
    const asRunStart = (environment: RunEnvironment): JournalEvent[] => [{
      ts: "2026-08-22T00:00:00.000Z",
      event: "run-start",
      data: { environment },
    }];
    const replayed = recordedEnvironment(asRunStart(injected));
    expect(replayed).toEqual(injected);
    expect(environmentComparable(replayed, recordedEnvironment(asRunStart({ ...injected, cores: 63 }))))
      .toEqual({ comparable: false, reason: "mismatch", recorded: injected.configHash });
    expect(environmentComparable(replayed, recordedEnvironment(asRunStart({ ...injected, forkCap: 8 }))))
      .toEqual({ comparable: false, reason: "mismatch", recorded: injected.configHash });
    // A half-stamped capacity pair is malformed, not an old capacity-free journal.
    const { forkCap: _missing, ...halfStamped } = injected;
    expect(recordedEnvironment(asRunStart(halfStamped))).toBeUndefined();

    // and the DEFAULTS are the two surfaces production already uses — the same availableParallelism
    // deriveForkCap divides, and the cap a gate suite ACTUALLY runs under. That second one is not
    // simply the derived number: `sh` lets an operator export of VITEST_MAX_FORKS win (src/run/git.ts),
    // so the record has to follow the same precedence or it describes a host this run never used.
    const prior = process.env[FORK_CAP_ENV];
    const restore = () => { if (prior === undefined) delete process.env[FORK_CAP_ENV]; else process.env[FORK_CAP_ENV] = prior; };
    try {
      delete process.env[FORK_CAP_ENV];
      const production = runEnvironment(cfg, [], {});
      expect(production.cores).toBe(availableParallelism());
      expect(production.forkCap).toBe(Number(DEFAULT_FORK_CAP));
      const concurrency = 2;
      const inRun = await runWithForkBudget(concurrency, async () => runEnvironment(cfg, [], {}));
      expect(inRun.forkCap).toBe(deriveForkCap(concurrency));
      expect(inRun.forkCap).not.toBe(Number(DEFAULT_FORK_CAP)); // the run's cap, not the fallback

      // operator-wins: with an export in place, the run's derived cap is NOT what children get. The
      // override is derived from this host's own cap so it can never coincide with it — on any box,
      // a record that ignored the export reports a different number than the one children inherit.
      const override = deriveForkCap(concurrency) + 1;
      process.env[FORK_CAP_ENV] = String(override);
      const overridden = await runWithForkBudget(concurrency, async () => runEnvironment(cfg, [], {}));
      expect(overridden.forkCap).toBe(override);
      expect(overridden.forkCap).not.toBe(deriveForkCap(concurrency));
    } finally {
      restore();
    }
  });
});

describe("shared test temp-directory teardown", () => {
  test("test: a directory created through the helper during a test no longer exists after the suite teardown runs", () => {
    const dir = makeTestTempDir("tickmarkr-reaper-owned-");
    expect(existsSync(dir)).toBe(true);

    reapTestTempDirs();

    expect(existsSync(dir)).toBe(false);
  });

  test("test: teardown ignores a tracked directory a test already removed itself without erroring", () => {
    const dir = makeTestTempDir("tickmarkr-reaper-self-removed-");
    rmSync(dir, { recursive: true });

    expect(() => reapTestTempDirs()).not.toThrow();
  });

  test("test: directories outside the helper's tracking are untouched by teardown", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-reaper-untracked-"));
    try {
      reapTestTempDirs();
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
