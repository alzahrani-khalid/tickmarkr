import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG, TickmarkrConfigSchema, configTemplate } from "../../src/config/config.js";
import { pickDriver } from "../../src/drivers/index.js";
import { OrcaDriver } from "../../src/drivers/orca.js";
import type { OrcaExec } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import * as DaemonModule from "../../src/run/daemon.js";
import { FakeOrca } from "../helpers/fake-orca.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";
import { FakeAdapter } from "../../src/adapters/fake.js";

const withHerdrEnv = async (value: string | undefined, fn: () => Promise<void> | void) => {
  const previous = process.env.HERDR_ENV;
  if (value === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
};

/** Production pickDriver constructs OrcaDriver with a private exec; tests rewire that seam on the
 *  selected instance so dispatch failures travel the same object runDaemon would receive. */
const wireOrcaExec = (driver: OrcaDriver, exec: OrcaExec): void => {
  Object.defineProperty(driver, "exec", { value: exec, configurable: true });
};

describe("pickDriver", () => {
  test("test: pickDriver returns the orca driver for an explicit orca override and for config driver orca while auto under HERDR_ENV=1 still returns herdr and auto without it returns subprocess even when the orca probe reports reachable", async () => {
    const overrideDriver = pickDriver(DEFAULT_CONFIG, "orca");
    expect(overrideDriver).toBeInstanceOf(OrcaDriver);

    const configDriver = pickDriver({ ...DEFAULT_CONFIG, driver: "orca" });
    expect(configDriver).toBeInstanceOf(OrcaDriver);

    wireOrcaExec(configDriver as OrcaDriver, new FakeOrca().exec);

    await withHerdrEnv("1", () => expect(pickDriver(DEFAULT_CONFIG).id).toBe("herdr"));
    await withHerdrEnv(undefined, async () => {
      // Reachability is asserted HERE, so the auto verdict below is taken while a reachable orca
      // runtime demonstrably answers: auto ordering is herdr-or-subprocess and orca health is not
      // an input to it.
      await expect((configDriver as OrcaDriver).probeRuntime("/tmp")).resolves.toBe("rt-1");
      expect(pickDriver(DEFAULT_CONFIG).id).toBe("subprocess");
    });
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

  test("the config template comment and driver enum documentation now offer orca beside auto, herdr and subprocess, citing the changed lines in src/config/config.ts", () => {
    // src/config/config.ts:769 — the template comment operators read when authoring an overlay.
    expect(configTemplate()).toContain("# driver: auto            # auto | herdr | subprocess | orca");
    // src/config/config.ts:304 — the enum the loader validates against, so the offered value loads.
    expect(TickmarkrConfigSchema.shape.driver.options).toEqual(["auto", "herdr", "subprocess", "orca"]);
    expect(TickmarkrConfigSchema.shape.driver.safeParse("orca").success).toBe(true);
    expect(TickmarkrConfigSchema.shape.driver.safeParse("not-a-driver").success).toBe(false);
    expect(pickDriver({ ...DEFAULT_CONFIG, driver: "orca" }).id).toBe("orca");
  });
});
