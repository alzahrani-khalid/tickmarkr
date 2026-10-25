// Queue row 243 (D-2141; D-2152): both reports explain repository-root timeouts without probing a real model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { loadConfig } from "../../src/config/config.js";
import { makeRepo } from "../helpers/tmprepo.js";

// Intercept the probe layer's hang sentinel; every fixture command completes immediately.
vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: vi.fn((cmd: string, cwd: string, timeoutMs?: number) => {
      if (cmd.startsWith("__PROBE_TIMEOUT__:")) {
        const status = cmd.slice("__PROBE_TIMEOUT__:".length);
        return Promise.resolve(status === "ok"
          ? { code: 0, stdout: "OK", stderr: "" }
          : status === "timeout"
            ? { code: 1, stdout: "", stderr: "", timedOut: true }
            : { code: 1, stdout: "", stderr: status });
      }
      return actual.sh(cmd, cwd, timeoutMs);
    }),
  };
});

const NOTE = "      note: probed from this repository's root — a timeout here may be a false negative on a large repository (OBS-31); re-run tickmarkr doctor";
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
  else delete (process.stderr as { isTTY?: boolean }).isTTY;
});

test("a doctor report and the report init prints from a reused doctor record each print the false-negative timeout note once, directly under the first timed-out model row of an adapter that probes from the repository root, and none for an adapter that probes from a neutral directory, an unauthed row that did not time out or an authed row, so a note on every unauthed row or in one renderer only fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  vi.stubEnv("NO_COLOR", undefined);
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });

  const reasons = {
    after: "probe timed out after 60000ms",
    twice: "probe timed out twice (60000ms)",
    repeat: "probe timed out (repeat — retry skipped) (60000ms)",
  };
  for (const [kind, reason] of Object.entries(reasons)) {
    const repo = makeRepo({ "keep.txt": "x\n" });
    const models = { healthy: "mid", denied: "mid", "mentions-timeout": "mid", "first-timeout": "mid", "second-timeout": "mid" };
    const fixtures = [
      { id: "root-default", models },
      { id: "root-explicit", models, probeCwd: "repo" as const },
      { id: "neutral", models, probeCwd: "neutral" as const },
      { id: "denied-only", models: { denied: "mid", "mentions-timeout": "mid" }, probeCwd: "repo" as const },
      { id: "healthy-only", models: { healthy: "mid" }, probeCwd: "repo" as const },
    ];
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), stringify({
      tiers: Object.fromEntries(fixtures.map(({ id, models }) => [id, { vendor: "fake", channel: "sub", models }])),
    }));
    const adapters: WorkerAdapter[] = fixtures.map(({ id, probeCwd }) => {
      const attempts = new Map<string, number>();
      return {
        id, vendor: "fake", probeCwd,
        probe: vi.fn(async () => ({ installed: true, authed: true, models: [] })),
        channels: (cfg) => channelsFromConfig(id, cfg),
        headlessCommand: (_prompt, model) => {
          const n = (attempts.get(model) ?? 0) + 1;
          attempts.set(model, n);
          const status = model === "healthy" ? "ok"
            : model === "denied" ? "HTTP 403: forbidden"
              : model === "mentions-timeout" ? `HTTP 403: ${"x".repeat(50)} probe timed out`
                : kind === "after" && n === 1 ? "HTTP 403: first attempt failed" : "timeout";
          return `__PROBE_TIMEOUT__:${status}`;
        },
        interactiveCommand: () => null,
        trustDialog: { kind: "none", reason: "fixture has no trust dialog" },
        invoke: () => ({ command: "unused" }),
        parse: () => ({ ok: true, summary: "OK", deviations: [], raw: "OK" }),
      };
    });
    if (kind === "repeat") {
      registry.writeDoctor(repo, Object.fromEntries(fixtures.map(({ id }) => [id, {
        installed: true, authed: true, models: [],
        modelAuth: Object.fromEntries(["first-timeout", "second-timeout"].map((model) => [model, {
          authed: false, reason: reasons.twice, probedAt: "2026-10-24T00:00:00.000Z",
        }])),
      }])));
    }
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: kind === "repeat" });
    const fresh = await doctor([], repo, adapters, { banner: false });
    const reused = registry.initDoctorReuse(repo, false);
    expect(reused.reuse).toBe(true);
    expect(reused.health).not.toBeNull();
    const health = reused.health!;
    for (const id of ["root-default", "root-explicit", "neutral"]) {
      expect(health[id].modelAuth?.["first-timeout"].reason).toBe(reason);
      expect(health[id].modelAuth?.["second-timeout"].reason).toBe(reason);
    }
    const cacheBefore = readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8");
    // A stale reason on an authed record must also stay silent.
    health["healthy-only"].modelAuth!.healthy.reason = reason;
    const cached = registry.formatDoctorReport(repo, loadConfig(repo), health, adapters, { wrote: false });
    expect(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")).toBe(cacheBefore);
    expect(cacheBefore).not.toContain("OBS-31");
    for (const report of [fresh, cached]) {
      const lines = report.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      expect(lines.filter((line) => line === NOTE)).toHaveLength(2);
      for (const { id } of fixtures) {
        const start = lines.indexOf(`  ${id}`);
        expect(start).toBeGreaterThan(-1);
        const end = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
        const section = lines.slice(start + 1, end === -1 ? lines.length : end);
        if (id.startsWith("root-")) {
          expect(section.filter((line) => line === NOTE)).toHaveLength(1);
          const firstTimeout = section.findIndex((line) => /^    first-timeout\s/.test(line));
          expect(firstTimeout).toBeGreaterThan(0);
          expect(section[firstTimeout]).toContain("unauthed: probe timed out");
          expect(section[firstTimeout + 1]).toBe(NOTE);
        } else {
          expect(section).not.toContain(NOTE);
        }
      }
    }
    for (const adapter of adapters) expect(adapter.probe).toHaveBeenCalledTimes(1);
  }
});
