import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { ConfigError, loadConfig, TickmarkrConfigSchema } from "../../src/config/config.js";
import { runDaemon, type RunOptions } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, makeTestTempDir, setupRepo, T } from "../helpers/tmprepo.js";

async function observeWindow(run: typeof runDaemon, seconds?: number, approvalWindowMs?: number) {
  const { repo, fake } = setupRepo([T("T1", { humanGate: true })], { tasks: {
    T1: [{ shell: `echo approved > approved.txt && ${COMMIT} approved`, result: { ok: true, summary: "approved" } }],
  } }, seconds === undefined ? "" : `approvalWindowSeconds: ${seconds}\n`);
  const runId = "run-config-window";
  const windows: unknown[] = [];
  const opts: RunOptions = { adapters: [fake], runId, keepAwake: { platform: "linux" },
    narrate: (row) => {
      if (row.event !== "approval-window-start") return;
      windows.push(row.data.windowMs);
      // Release at the actual window boundary, avoiding waits of up to one day.
      const journal = Journal.open(repo, runId);
      journal.append("task-approved", "T1", { by: "test", via: "test", park: journal.newestBinding("T1") });
    },
    ...(approvalWindowMs === undefined ? {} : { approvalWindowMs }),
  };
  const summary = await run(repo, opts);
  expect(summary.done).toEqual(["T1"]);
  expect(summary.failed).toEqual([]);
  const rows = Journal.open(repo, runId).read();
  expect(rows.filter(row => row.event === "approval-window-start").map(row => row.data.windowMs)).toEqual(windows);
  expect(windows).toHaveLength(1);
  expect(rows.some(row => row.event === "approval-window-expired")).toBe(false);
  return windows[0];
}

test("test: the approval window the production daemon opens is the configured seconds when set, today's default when absent and the run option above both, recorded on its window row, so a window fixed at two minutes fails", async () => {
  expect(await observeWindow(runDaemon)).toBe(1); // existing vitest default
  for (const seconds of [30, 600, 86400]) expect(await observeWindow(runDaemon, seconds)).toBe(seconds * 1_000);
  expect(await observeWindow(runDaemon, 600, 17)).toBe(17);
  expect(await observeWindow(runDaemon, undefined, 0)).toBe(0);

  // Evaluate the production module's default with the same environment as a real CLI launch.
  // Restore vitest before calling it; the platform seam also prevents any OS keep-awake child.
  let productionRun: typeof runDaemon;
  vi.resetModules();
  vi.stubEnv("VITEST", undefined);
  try {
    productionRun = (await import("../../src/run/daemon.js")).runDaemon;
  } finally {
    vi.unstubAllEnvs();
  }
  expect(await observeWindow(productionRun)).toBe(120_000);
  expect(await observeWindow(productionRun, 600)).toBe(600_000);
  expect(await observeWindow(productionRun, 600, 23)).toBe(23);
}, 120_000);

function configWith(value?: string) {
  const repo = makeTestTempDir("approval-config-");
  const globalDir = makeTestTempDir("approval-global-");
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), value === undefined ? "" : `approvalWindowSeconds: ${value}\n`);
  return () => loadConfig(repo, { globalDir });
}

test("test: a configured approval window below thirty seconds or above one day fails config load naming both bounds, while each bound itself loads, so a window accepting zero or a week fails", () => {
  expect(configWith()().approvalWindowSeconds).toBeUndefined();
  for (const seconds of [30, 600, 86400]) expect(configWith(String(seconds))().approvalWindowSeconds).toBe(seconds);
  for (const seconds of [29, 86401, 0, 604800]) {
    const load = configWith(String(seconds));
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/approvalWindowSeconds.*30.*86400/);
  }
  for (const value of ["30.5", '"600"']) expect(configWith(value)).toThrow(ConfigError);
});

test("test: the shipped config schema equals the schema the config module defines and declares the approval window seconds with its floor and ceiling, so a key the loader accepts but the shipped schema omits fails", () => {
  const shipped = JSON.parse(readFileSync("schema/config.schema.json", "utf8"));
  const { $comment: _comment, ...body } = shipped;
  expect(body).toEqual(z.toJSONSchema(TickmarkrConfigSchema, { io: "input", unrepresentable: "any" }));
  expect(body.properties.approvalWindowSeconds).toEqual({ type: "integer", minimum: 30, maximum: 86400 });
  expect(body.required).not.toContain("approvalWindowSeconds");
});
