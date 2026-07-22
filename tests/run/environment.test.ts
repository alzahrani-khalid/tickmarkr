import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { AuthHealth, BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import type { TickmarkrConfig } from "../../src/config/config.js";
import { runDaemon } from "../../src/run/daemon.js";
import { type RunEnvironment, UNKNOWN_ADAPTER_VERSION } from "../../src/run/environment.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

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
}, 120000);
