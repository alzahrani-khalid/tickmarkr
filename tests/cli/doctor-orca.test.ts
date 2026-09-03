import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { doctor } from "../../src/cli/commands/doctor.js";
import * as OrcaModule from "../../src/drivers/orca.js";
import { ORCA_FIXTURE_VERSION, OrcaDriver, resolveOrcaCliBinary } from "../../src/drivers/orca.js";
import { makeRepo } from "../helpers/tmprepo.js";

const status = (body: string, code = 0, stderr = "") => ({ code, stdout: body, stderr });
const reachable = JSON.stringify({ ok: true, result: { runtime: { reachable: true, appVersion: ORCA_FIXTURE_VERSION } }, _meta: { runtimeId: "rt-doctor" } });
// Installed-but-unreachable, the shape a live orca CLI emits with its runtime down (see
// tests/helpers/fake-orca.ts): a well-formed envelope whose runtime says reachable:false.
const unreachable = JSON.stringify({ ok: true, result: { runtime: { reachable: false } }, _meta: { runtimeId: "rt-doctor" } });
const unreachableStderr = "Electron 2026-08-22T19:59:01.123Z [45678:Main] runtime bridge idle";
const refused = JSON.stringify({ ok: false, error: { code: "runtime_unreachable", message: "runtime is not answering" }, _meta: { runtimeId: "rt-doctor" } });
const malformedSameMetadata = JSON.stringify({ ok: true, result: { runtime: {} }, _meta: { runtimeId: "none" } });
// The discriminating pair for an independent reader: reachable:false carried by metadata the shared
// parser REJECTS. Anything that re-reads these bytes itself calls them "runtime unreachable"; the
// shared parser's verdict is a failed probe.
const malformedUnreachableNoRuntimeId = JSON.stringify({ ok: true, result: { runtime: { reachable: false } }, _meta: {} });
const malformedUnreachableRuntimeIdNone = JSON.stringify({ ok: true, result: { runtime: { reachable: false } }, _meta: { runtimeId: "none" } });

describe("doctor Orca capability", () => {
  afterEach(() => vi.restoreAllMocks());

  test("test: doctor renders one orca row through the shared envelope parser distinguishing reachable runtime from installed-but-unreachable from absent CLI, and a malformed or ok-false status envelope renders the row as a failed probe rather than reachable, while a doctor that throws on the absent case or parses the envelope with its own reader fails", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const parseSpy = vi.spyOn(OrcaModule, "parseEnvelope");

    const rendered = async (body: string, code = 0, stderr = "") => doctor(["--"], repo, [], {
      resolveOrcaBinary: () => "/fixture/orca",
      orcaStatusProbe: async () => status(body, code, stderr),
    });

    parseSpy.mockClear();
    const reachableOut = await rendered(reachable);
    expect(parseSpy).toHaveBeenCalled();
    expect(reachableOut).toContain(`✓ orca           runtime reachable (rt-doctor, appVersion ${ORCA_FIXTURE_VERSION}; fixture pin ${ORCA_FIXTURE_VERSION})`);
    expect(reachableOut.split("\n").filter((l) => l.includes("orca")).length).toBe(1);

    parseSpy.mockClear();
    const unreachableOut = await rendered(unreachable, 0, unreachableStderr);
    expect(parseSpy).toHaveBeenCalled();
    expect(unreachableOut).toContain("✗ orca           CLI installed but runtime unreachable");
    expect(unreachableOut).not.toContain(unreachableStderr);
    expect(unreachableOut).not.toContain("Electron");
    expect(unreachableOut.split("\n").filter((l) => l.includes("orca")).length).toBe(1);

    parseSpy.mockClear();
    const absentOut = await doctor(["--"], repo, [], { resolveOrcaBinary: () => undefined });
    expect(absentOut).toContain("✗ orca           CLI not installed");
    expect(absentOut.split("\n").filter((l) => l.includes("orca")).length).toBe(1);

    parseSpy.mockClear();
    const malformed = await rendered("orca: runtime bridge closed");
    expect(parseSpy).toHaveBeenCalled();
    expect(malformed).toContain("✗ orca           CLI installed but runtime probe failed");
    expect(malformed).not.toContain("✓ orca           runtime reachable");
    expect(malformed).not.toContain("runtime bridge closed");
    expect(malformed.split("\n").filter((l) => l.includes("orca")).length).toBe(1);

    parseSpy.mockClear();
    const malformedMeta = await rendered(malformedSameMetadata);
    expect(parseSpy).toHaveBeenCalled();
    expect(malformedMeta).toContain("✗ orca           CLI installed but runtime probe failed");
    expect(malformedMeta).not.toContain("runtime unreachable");
    expect(malformedMeta).not.toContain("runtime reachable");
    expect(malformedMeta.split("\n").filter((l) => l.includes("orca")).length).toBe(1);

    for (const body of [malformedUnreachableNoRuntimeId, malformedUnreachableRuntimeIdNone]) {
      parseSpy.mockClear();
      const malformedUnreachable = await rendered(body);
      expect(parseSpy).toHaveBeenCalled();
      expect(malformedUnreachable).toContain("✗ orca           CLI installed but runtime probe failed");
      expect(malformedUnreachable).not.toContain("runtime unreachable");
      expect(malformedUnreachable).not.toContain("runtime reachable");
      expect(malformedUnreachable.split("\n").filter((l) => l.includes("orca")).length).toBe(1);
    }

    parseSpy.mockClear();
    const rejected = await rendered(refused, 1);
    expect(parseSpy).toHaveBeenCalled();
    expect(rejected).toContain("✗ orca           CLI installed but runtime probe failed");
    expect(rejected).not.toContain("✓ orca           runtime reachable");
    expect(rejected).not.toContain("runtime_unreachable");
    expect(rejected.split("\n").filter((l) => l.includes("orca")).length).toBe(1);
  });

  test("test: the doctor orca row reports the live runtime appVersion beside the fixture pin as attention when they differ or as the plain reachable row when they agree whereas a doctor that reports reachable without the comparison or reads the version from anything but status json fails", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const rendered = async (appVersion: string) => doctor(["--"], repo, [], {
      resolveOrcaBinary: () => "/fixture/orca",
      orcaStatusProbe: async () => status(JSON.stringify({
        ok: true,
        result: { runtime: { reachable: true, appVersion } },
        _meta: { runtimeId: "rt-doctor" },
      })),
    });

    const agree = await rendered(ORCA_FIXTURE_VERSION);
    expect(agree).toContain(`✓ orca           runtime reachable (rt-doctor, appVersion ${ORCA_FIXTURE_VERSION}; fixture pin ${ORCA_FIXTURE_VERSION})`);
    expect(agree).not.toContain("! orca");

    const drift = await rendered("1.4.196");
    expect(drift).toContain(`! orca           runtime reachable (rt-doctor, appVersion 1.4.196; fixture pin ${ORCA_FIXTURE_VERSION})`);
    expect(drift).not.toContain("✓ orca           runtime reachable (rt-doctor)");

    const absentVersion = await doctor(["--"], repo, [], {
      resolveOrcaBinary: () => "/fixture/orca",
      orcaStatusProbe: async () => status(JSON.stringify({
        ok: true,
        result: { runtime: { reachable: true } },
        _meta: { runtimeId: "rt-doctor" },
      })),
    });
    expect(absentVersion).toContain(`! orca           runtime reachable (rt-doctor, appVersion absent; fixture pin ${ORCA_FIXTURE_VERSION})`);
  });

  test("test: the shared orca binary resolver returns ORCA_CLI_COMMAND when set or orca-ide on linux outside an Orca terminal or orca otherwise so doctor as well as the driver run bare orca on linux only inside an Orca terminal whereas a resolver that ignores the variable or runs bare orca there fails", async () => {
    expect(resolveOrcaCliBinary("/repo", { platform: "linux", env: {} })).toBe("orca-ide");
    expect(resolveOrcaCliBinary("/repo", { platform: "linux", env: { TERM_PROGRAM: "Orca" } })).toBe("orca");
    expect(resolveOrcaCliBinary("/repo", { platform: "darwin", env: {} })).toBe("orca");
    expect(resolveOrcaCliBinary("/repo", { platform: "linux", env: { ORCA_CLI_COMMAND: "/opt/orca-cli", TERM_PROGRAM: "x" } })).toBe("/opt/orca-cli");
    expect(resolveOrcaCliBinary("/repo", {
      platform: "linux",
      env: {},
      resolve: (bin) => ({ resolved: `/resolved/${bin}` }),
    })).toBe("/resolved/orca-ide");

    expect((new OrcaDriver({ platform: "linux", env: {} }) as unknown as { bin: string }).bin).toBe("orca-ide");
    expect((new OrcaDriver({ platform: "linux", env: { TERM_PROGRAM: "Orca" } }) as unknown as { bin: string }).bin).toBe("orca");
    expect((new OrcaDriver({ platform: "linux", env: { ORCA_CLI_COMMAND: "/custom/orca" } }) as unknown as { bin: string }).bin).toBe("/custom/orca");

    const repo = makeRepo({ "keep.txt": "x" });
    const previous = process.env.ORCA_CLI_COMMAND;
    const seen: string[] = [];
    process.env.ORCA_CLI_COMMAND = "/env/orca";
    try {
      await doctor(["--"], repo, [], {
        orcaStatusProbe: async (_cwd, binary) => {
          seen.push(binary);
          return status(reachable);
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ORCA_CLI_COMMAND;
      else process.env.ORCA_CLI_COMMAND = previous;
    }
    expect(seen).toEqual(["/env/orca"]);
  });
});
