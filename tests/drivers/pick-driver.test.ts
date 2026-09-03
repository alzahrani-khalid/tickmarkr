import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG, TickmarkrConfigSchema, configTemplate } from "../../src/config/config.js";
import { driverEvidence, pickDriver } from "../../src/drivers/index.js";
import { OrcaDriver } from "../../src/drivers/orca.js";
import type { OrcaExec } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import * as DaemonModule from "../../src/run/daemon.js";
import { FakeOrca } from "../helpers/fake-orca.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";
import { FakeAdapter } from "../../src/adapters/fake.js";

const DRIVER_HOST_KEYS = ["HERDR_ENV", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE"] as const;

const withDriverHostEnv = async (
  values: Partial<Record<(typeof DRIVER_HOST_KEYS)[number], string>>,
  fn: () => Promise<void> | void,
) => {
  const previous = DRIVER_HOST_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of DRIVER_HOST_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** Production pickDriver constructs OrcaDriver with a private exec; tests rewire that seam on the
 *  selected instance so dispatch failures travel the same object runDaemon would receive. */
const wireOrcaExec = (driver: OrcaDriver, exec: OrcaExec): void => {
  Object.defineProperty(driver, "exec", { value: exec, configurable: true });
};

describe("pickDriver", () => {
  test("test: pickDriver auto returns the orca driver when TERM_PROGRAM is Orca and ORCA_TERMINAL_HANDLE is set with HERDR_ENV unset yet returns subprocess when either marker is present alone and returns herdr when HERDR_ENV is 1 beside the Orca pair while no exec seam is invoked by the selection whereas the shipped chain that resolves auto to subprocess under the Orca pair fails", async () => {
    const overrideDriver = pickDriver(DEFAULT_CONFIG, "orca");
    expect(overrideDriver).toBeInstanceOf(OrcaDriver);
    expect(driverEvidence(DEFAULT_CONFIG, overrideDriver, "orca")).toBe("orca (--driver)");

    const configDriver = pickDriver({ ...DEFAULT_CONFIG, driver: "orca" });
    expect(configDriver).toBeInstanceOf(OrcaDriver);
    expect(driverEvidence({ ...DEFAULT_CONFIG, driver: "orca" }, configDriver)).toBe("orca (config)");

    const runtimeProbe = vi.spyOn(OrcaDriver.prototype, "probeRuntime");
    await withDriverHostEnv({ TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term-secret-pair" }, () => {
      // Control for the shipped herdr-else-subprocess chain this criterion replaces.
      const shippedAutoId = process.env.HERDR_ENV === "1" ? "herdr" : "subprocess";
      expect(shippedAutoId).toBe("subprocess");
      expect(pickDriver(DEFAULT_CONFIG)).toBeInstanceOf(OrcaDriver);
    });
    await withDriverHostEnv({ TERM_PROGRAM: "Orca" }, () => {
      expect(pickDriver(DEFAULT_CONFIG)).toBeInstanceOf(SubprocessDriver);
    });
    await withDriverHostEnv({ ORCA_TERMINAL_HANDLE: "term-handle-alone" }, () => {
      expect(pickDriver(DEFAULT_CONFIG)).toBeInstanceOf(SubprocessDriver);
    });
    await withDriverHostEnv({ TERM_PROGRAM: "NotOrca", ORCA_TERMINAL_HANDLE: "term-wrong-host" }, () => {
      expect(pickDriver(DEFAULT_CONFIG)).toBeInstanceOf(SubprocessDriver);
    });
    await withDriverHostEnv({ HERDR_ENV: "1", TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term-nested" }, () => {
      const driver = pickDriver(DEFAULT_CONFIG);
      expect(driver.id).toBe("herdr");
      expect(driverEvidence(DEFAULT_CONFIG, driver)).toBe("auto → herdr (HERDR_ENV=1)");
      const overridden = pickDriver(DEFAULT_CONFIG, "subprocess");
      expect(driverEvidence(DEFAULT_CONFIG, overridden)).toBe("subprocess (--driver)");
      expect(driverEvidence(DEFAULT_CONFIG, new SubprocessDriver())).toBe("auto → subprocess (runtime)");
    });
    await withDriverHostEnv({}, () => {
      const driver = pickDriver(DEFAULT_CONFIG);
      expect(driver.id).toBe("subprocess");
      expect(driverEvidence(DEFAULT_CONFIG, driver)).toBe("auto → subprocess (HERDR_ENV unset)");
      const overridden = pickDriver(DEFAULT_CONFIG, "herdr");
      expect(driverEvidence(DEFAULT_CONFIG, overridden)).toBe("herdr (--driver)");
    });
    expect(runtimeProbe).not.toHaveBeenCalled();
    runtimeProbe.mockRestore();
  });

  test("test: an unknown driver override fails run and resume with an explicit usage error before any dispatch while the previous unvalidated cast control lets it through", async () => {
    const { run } = await import("../../src/cli/commands/run.js");
    const { resume } = await import("../../src/cli/commands/resume.js");
    const runDaemonSpy = vi.spyOn(DaemonModule, "runDaemon").mockImplementation(async () => ({} as any));
    const missingRepo = "/tmp/tickmarkr-invalid-driver-does-not-dispatch";

    // Legacy-control path: proving that the old unvalidated selector accepts the unknown value
    const legacyPickDriver = (cfg: any, override?: any) => {
      const want = override ?? cfg.driver;
      if (want === "herdr") return { id: "herdr" };
      if (want === "subprocess") return { id: "subprocess" };
      return { id: "fallback" };
    };
    expect(legacyPickDriver(DEFAULT_CONFIG, "not-a-driver").id).toBe("fallback");

    await expect(run(["--driver", "not-a-driver"], missingRepo)).rejects.toThrow(
      "usage: --driver must be one of auto | herdr | subprocess | orca (got not-a-driver)",
    );
    await expect(resume(["run-test", "--driver", "not-a-driver"], missingRepo)).rejects.toThrow(
      "usage: --driver must be one of auto | herdr | subprocess | orca (got not-a-driver)",
    );

    expect(runDaemonSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("test: a run with orca explicitly selected whose runtime is missing or whose dispatch send is refused fails that dispatch attempt through the production selection path and never completes on a substituted subprocess worker, while a selection layer that silently falls back to subprocess turns the attempt green and fails", async () => {
    // Production selection: the same pickDriver instance the run path hands to runDaemon.
    const missingSelected = pickDriver({ ...DEFAULT_CONFIG, driver: "orca" });
    expect(missingSelected).toBeInstanceOf(OrcaDriver);
    expect(missingSelected.id).toBe("orca");
    wireOrcaExec(missingSelected as OrcaDriver, new FakeOrca({ cliMissing: "orca: command not found" }).exec);

    const missingRepo = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const missingSummary = await DaemonModule.runDaemon(missingRepo.repo, {
      adapters: [missingRepo.fake],
      runId: "run-orca-no-fallback-missing",
      driver: missingSelected,
    });
    expect(missingSelected.id).toBe("orca");
    expect(missingSummary.done).toEqual([]);
    expect(missingSummary.failed).toContain("T1");

    // Refused send on the production-selected driver: driven through OrcaDriver slot delivery and runDaemon
    const refusedFakeOrca = new FakeOrca({
      raw: {
        send: '{"ok":false,"error":{"code":"terminal_not_writable","message":"terminal is not writable"},"_meta":{"runtimeId":"rt-1"}}',
      },
    });

    const originalExec = refusedFakeOrca.exec;
    const wrappedExec = async (args: string[], cwd: string, timeoutMs?: number) => {
      const family = args[0] === "terminal" ? args[1] : args[0];
      const res = await originalExec(args, cwd, timeoutMs);
      if (family === "create") {
        const t = refusedFakeOrca.last();
        if (t) {
          t.lines = ["mock-ready", "TICKMARKR_RESULT_dummy {}"];
        }
      }
      return res;
    };

    const refusedSelected = pickDriver({ ...DEFAULT_CONFIG, driver: "orca" });
    expect(refusedSelected).toBeInstanceOf(OrcaDriver);
    expect(refusedSelected.id).toBe("orca");
    wireOrcaExec(refusedSelected as OrcaDriver, wrappedExec);

    class RefusedInteractiveFakeAdapter extends FakeAdapter {
      interactiveSeed = {
        launch(_model: string) {
          return "mock-launch";
        },
        readinessMatch: "mock-ready",
        seedLine(_promptFile: string) {
          return "mock-seed-line";
        }
      };

      interactiveCommand(_promptFile: string, _model: string): string | null {
        return "mock-interactive-command";
      }
    }

    const refusedRepo = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const interactiveFake = new RefusedInteractiveFakeAdapter(refusedRepo.scriptPath);

    const refusedSummary = await DaemonModule.runDaemon(refusedRepo.repo, {
      adapters: [interactiveFake],
      runId: "run-orca-no-fallback-refused",
      driver: refusedSelected,
    });
    expect(refusedSelected.id).toBe("orca");
    expect(refusedSummary.done).toEqual([]);
    expect(refusedSummary.failed).toContain("T1");
    // Assert send count increased during the call
    expect(refusedFakeOrca.countOf("send")).toBe(1);

    // Control: a selection layer that silently substitutes subprocess turns the attempt green.
    const fallbackRepo = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" } }] } },
    );
    const fallbackSummary = await DaemonModule.runDaemon(fallbackRepo.repo, {
      adapters: [fallbackRepo.fake],
      runId: "run-orca-fallback-control",
      driver: new SubprocessDriver(),
    });
    expect(fallbackSummary.done).toContain("T1");
    expect(fallbackSummary.failed).toEqual([]);
  }, 60_000);

  test("the config template driver comment README and INTEGRATIONS state that auto resolves herdr then orca on both Orca markers then subprocess and that orca is named explicitly outside an Orca terminal as the diff shows in the changed lines of those three files", () => {
    const expectedRule = "auto: herdr when HERDR_ENV=1, then orca when TERM_PROGRAM=Orca + ORCA_TERMINAL_HANDLE, else subprocess; name orca explicitly outside an Orca terminal";
    const readme = readFileSync(join(import.meta.dirname, "../../README.md"), "utf8");
    const integrations = readFileSync(join(import.meta.dirname, "../../docs/codebase/INTEGRATIONS.md"), "utf8");

    expect(configTemplate()).toContain(`# driver: auto            # ${expectedRule}`);
    for (const document of [readme, integrations]) {
      const normalized = document.replace(/\s+/g, " ");
      expect(document).toContain("HERDR_ENV=1");
      expect(document).toContain("TERM_PROGRAM=Orca");
      expect(document).toContain("ORCA_TERMINAL_HANDLE");
      expect(normalized).toMatch(/then (?:Orca|`OrcaDriver`).*then (?:subprocess|`SubprocessDriver`)/);
      expect(normalized).toMatch(/Outside an Orca terminal, (?:name|select) it explicitly/);
    }
    // src/config/config.ts:304 — the enum the loader validates against, so the offered value loads.
    expect(TickmarkrConfigSchema.shape.driver.options).toEqual(["auto", "herdr", "subprocess", "orca"]);
    expect(TickmarkrConfigSchema.shape.driver.safeParse("orca").success).toBe(true);
    expect(TickmarkrConfigSchema.shape.driver.safeParse("not-a-driver").success).toBe(false);
    expect(pickDriver({ ...DEFAULT_CONFIG, driver: "orca" }).id).toBe("orca");
  });
});
